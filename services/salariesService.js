/**
 * ============================================================================
 * SALARIES SERVICE
 * ============================================================================
 * Provides data reading and editing capabilities for:
 * 1. Master Sheet "Salaries" tab:
 *    - Employee metadata (A4:I53)
 *    - Monthly 7-column figures (Column L onwards: Salary, Ee NICs, Er NICs,
 *      Student loan payments, Ee pension, Er pension, PAYE)
 *    - Actuals (rows 304:353) vs Forecast (rows 154:203) detection
 *    - Column totals (rows 55, 57, 58)
 *    - Monthly summary calculations (rows 60 to 77)
 * 2. Client Sheet "Outgoings" tab:
 *    - "Dividends in lieu of salary" (rows 118 to 121)
 *    - Delivery % (Col E)
 *    - 3 Financial Years (FY1, FY2, FY3) with 12 months each + FY totals
 *    - Totals for delivery (row 120) and non-delivery (row 121)
 * ============================================================================
 */

import { getSheetsClient, withRetry, getSheetGid, extractSheetIdFromUrl } from "./sheetsClient.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeFormulaInput, unwrapSheetId } from "./userPermissions.js";
import { memoryCache, resolvePortalCache, invalidatePmaClientCache } from "./cacheService.js";
import { redisClient } from "./redisClient.js";
import { parseSheetDate, toInputDateFormat, toSheetDateFormat } from "../utils/helpers.js";

export function colIdxToLetter(colIdx) {
  let temp = colIdx + 1;
  let letter = "";
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter;
}

export function colLetterToIdx(colLetter) {
  let idx = 0;
  const s = String(colLetter || "").toUpperCase().trim();
  for (let i = 0; i < s.length; i++) {
    idx = idx * 26 + (s.charCodeAt(i) - 64);
  }
  return idx - 1;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseMonthYearHeader(label) {
  if (!label || typeof label !== "string") return null;
  const match = label.trim().match(/^([A-Za-z]{3})\s*'?(\d{2,4})$/i);
  if (!match) return null;
  const mStr = match[1].toLowerCase();
  const monthIdx = MONTH_NAMES.indexOf(mStr);
  if (monthIdx === -1) return null;
  let year = parseInt(match[2], 10);
  if (year < 100) year += 2000;
  return { monthIdx, year, label: `${match[1]} ${String(year).slice(-2)}` };
}

export function parseHeaderMonthMeta_(rawVal) {
  if (rawVal === null || rawVal === undefined || rawVal === "") return null;
  if (typeof rawVal === "string") {
    const parsed = parseMonthYearHeader(rawVal);
    if (parsed) return parsed;
  }
  const d = parseSheetDate(rawVal);
  if (!d) return null;
  const mNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return {
    monthIdx: d.getMonth(),
    year: d.getFullYear(),
    label: `${mNames[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`,
  };
}

export function getPreviousCalendarMonthLabel() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const mStr = MONTH_NAMES[d.getMonth()];
  const capitalized = mStr.charAt(0).toUpperCase() + mStr.slice(1);
  const yStr = String(d.getFullYear()).slice(-2);
  return `${capitalized} ${yStr}`;
}

export async function getSalariesData({ clientName, masterSheetId, clientSheetId, bypassCache = false }) {
  if (!clientSheetId && !masterSheetId) {
    throw new Error("clientSheetId is required.");
  }

  const cleanClientId = unwrapSheetId(
    extractSheetIdFromUrl(clientSheetId || masterSheetId) || clientSheetId || masterSheetId
  );
  const cacheKey = `salaries_data:${cleanClientId}`;

  const cachedResult = await resolvePortalCache({
    cacheKey,
    bypassCache: Boolean(bypassCache),
    l1TtlSecs: 120,
    redisTtlSecs: 86400,
    isValidPayload: (p) => Boolean(p && p.success && Array.isArray(p.employees)),
    fetchFreshFn: async () => {
      const sheets = await getSheetsClient();

      // 1. Fetch Salaries & Dividends directly from Client Sheet
      const [clientBatchResp, employeesGetResp] = await Promise.all([
        withRetry(() =>
          sheets.spreadsheets.values.batchGet({
            spreadsheetId: cleanClientId,
            ranges: [
              "Outgoings!A1:BA1",
              "Outgoings!A118:BA121",
              "Salaries!A1:JC3",      // Headers
              "Salaries!A4:I53",      // Employees metadata
              "Salaries!L4:JC53",     // Client Sheet: Manual overrides / Actuals
              "Salaries!L60:JC77",    // Client Sheet: Summary, EA, HMRC, Bank outflows
              "Salaries!L154:JC203",  // Client Sheet: Forecast amounts
              "Salaries!L304:JC353",  // Client Sheet: Effective amounts (override if present, else forecast)
              "Salaries!L354:JC358",  // Client Sheet: Effective totals (row 355 all, 357 delivery, 358 non-delivery)
            ],
            valueRenderOption: "FORMATTED_VALUE",
          })
        ),
        withRetry(() =>
          sheets.spreadsheets.get({
            spreadsheetId: cleanClientId,
            ranges: ["Salaries!A4:I53"],
            fields: "sheets.data.rowData.values(formattedValue,note)",
          })
        ),
      ]);

      const clientRanges = clientBatchResp.data.valueRanges || [];
      const outgoingsHeaders = clientRanges[0]?.values?.[0] || [];
      const outgoingsDividendsRaw = clientRanges[1]?.values || [];
      const clientHeaders = clientRanges[2]?.values || [];
      const clientEmployeesRaw = clientRanges[3]?.values || [];
      const clientActualAmountsRaw = clientRanges[4]?.values || [];
      const clientSummaryRaw = clientRanges[5]?.values || [];
      const clientForecastAmountsRaw = clientRanges[6]?.values || [];
      const clientEffectiveAmountsRaw = clientRanges[7]?.values || [];
      const clientEffectiveTotalsRaw = clientRanges[8]?.values || [];

      const masterHeaders = clientHeaders;
      const masterEmployeesRaw = clientEmployeesRaw;
      const effectiveAmountsRaw = clientEffectiveAmountsRaw;
      const totalsRaw = clientEffectiveTotalsRaw;
      const summaryRaw = clientSummaryRaw;
      const forecastAmountsRaw = clientForecastAmountsRaw;
      const masterActualAmountsRaw = clientActualAmountsRaw;

      const employeeRowData = employeesGetResp.data?.sheets?.[0]?.data?.[0]?.rowData || [];

      const employeesRaw = clientEmployeesRaw.length > 0 ? clientEmployeesRaw : masterEmployeesRaw;
      const actualAmountsRaw = clientActualAmountsRaw.length > 0 ? clientActualAmountsRaw : masterActualAmountsRaw;

      // =========================================================================
      // PARSE SALARIES: EMPLOYEES (A4:I53)
      // =========================================================================
      const employees = [];
      for (let i = 0; i < 50; i++) {
        const row = employeesRaw[i] || masterEmployeesRaw[i] || [];
        const rowCells = employeeRowData[i]?.values || [];
        const sheetRow = 4 + i;
        const name = String(row[0] || "").trim();
        const role = String(row[1] || "").trim();
        const fteSalary = String(row[2] || "").trim();
        const fte = String(row[3] || "").trim();
        const startDate = String(row[4] || "").trim();
        const endDate = String(row[5] || "").trim();
        const deliveryPct = String(row[6] || "").trim();
        const studentLoan = String(row[7] || "").trim();
        const pension = String(row[8] || "").trim();

        // Consolidate onto a single employee note attached to the Name cell (index 0),
        // falling back to any legacy field notes if Name note is empty.
        const rawNameNote = rowCells[0]?.note || "";
        const legacyNotes = [1, 2, 3, 4, 5, 6, 7, 8]
          .map((idx) => String(rowCells[idx]?.note || "").trim())
          .filter(Boolean);
        const combinedNameNote = rawNameNote || legacyNotes.join(" | ");

        const notes = {
          name: combinedNameNote,
          role: "",
          fteSalary: "",
          fte: "",
          startDate: "",
          endDate: "",
          deliveryPct: "",
          studentLoan: "",
          pension: "",
        };

        employees.push({
          sheetRow,
          index: i,
          name,
          role,
          fteSalary,
          fte,
          startDate,
          endDate,
          deliveryPct,
          studentLoan,
          pension,
          notes,
          isPopulated: !!name,
        });
      }

      // =========================================================================
      // PARSE MASTER SHEET: MONTHS & AMOUNTS (Column L onwards)
      // =========================================================================
      const row1 = masterHeaders[0] || [];
      const months = [];
      const prevMonthTarget = getPreviousCalendarMonthLabel().toLowerCase();
      let defaultMonthIndex = 0;

      for (let c = 11; c < row1.length; c += 7) {
        const rawMonthHeader = String(row1[c] || "").trim();
        if (!rawMonthHeader) continue;

        const startColLetter = colIdxToLetter(c);
        const endColLetter = colIdxToLetter(c + 6);
        const parsedM = parseMonthYearHeader(rawMonthHeader);
        const monthLabel = parsedM ? parsedM.label : rawMonthHeader;

        // Check if this month matches the previous calendar month
        if (parsedM && monthLabel.toLowerCase() === prevMonthTarget) {
          defaultMonthIndex = months.length;
        }

        // Offset in effectiveAmountsRaw / forecastAmountsRaw / actualAmountsRaw is (c - 11)
        const colOffset = c - 11;

        // Totals from row 55, 57, 58:
        // totalsRaw index 0 = row 54, 1 = row 55, 2 = row 56, 3 = row 57, 4 = row 58
        const row55 = totalsRaw[1] || [];
        const row57 = totalsRaw[3] || [];
        const row58 = totalsRaw[4] || [];

        const colTotals = {
          all: [
            row55[colOffset + 0] || "£0.00",
            row55[colOffset + 1] || "£0.00",
            row55[colOffset + 2] || "£0.00",
            row55[colOffset + 3] || "£0.00",
            row55[colOffset + 4] || "£0.00",
            row55[colOffset + 5] || "£0.00",
            row55[colOffset + 6] || "£0.00",
          ],
          delivery: [
            row57[colOffset + 0] || "£0.00",
            row57[colOffset + 1] || "£0.00",
            row57[colOffset + 2] || "£0.00",
            row57[colOffset + 3] || "£0.00",
            row57[colOffset + 4] || "£0.00",
            row57[colOffset + 5] || "£0.00",
            row57[colOffset + 6] || "£0.00",
          ],
          nonDelivery: [
            row58[colOffset + 0] || "£0.00",
            row58[colOffset + 1] || "£0.00",
            row58[colOffset + 2] || "£0.00",
            row58[colOffset + 3] || "£0.00",
            row58[colOffset + 4] || "£0.00",
            row58[colOffset + 5] || "£0.00",
            row58[colOffset + 6] || "£0.00",
          ],
        };

        // Summary calculations (rows 60 to 77)
        // summaryRaw index = (sheetRowNum - 60)
        // Row 60: Total cost for the month (before employment allowance) -> idx 0
        // Row 62: Total delivery staff cost for month (post-EA) -> idx 2
        // Row 63: Total non-delivery staff cost for month (post-EA) -> idx 3
        // Row 66: Employment allowance b/f -> idx 6
        // Row 67: Employment allowance usage this month -> idx 7
        // Row 68: Adjusted Er NICs for this month -> idx 8
        // Row 71: Total due to HMRC related to this month -> idx 11
        // Row 73: Total leaving bank account for payroll -> idx 13
        // Row 74: Total leaving bank account to HMRC (prev month/quarter) -> idx 14
        // Row 75: Total leaving bank account for pension -> idx 15
        // Row 77: Total leaving bank account in this month -> idx 17
        const getSummVal = (rowNum) => {
          const r = summaryRaw[rowNum - 60];
          return r ? (r[colOffset] || "£0.00") : "£0.00";
        };

        const summary = {
          totalCostBeforeEA: getSummVal(60),
          employmentAllowanceBf: getSummVal(66),
          employmentAllowanceUsage: getSummVal(67),
          adjustedErNic: getSummVal(68),
          totalDeliveryStaffCostPostEA: getSummVal(62),
          totalNonDeliveryStaffCostPostEA: getSummVal(63),
          totalDueHmrc: getSummVal(71),
          totalLeavingBankPayroll: getSummVal(73),
          totalLeavingBankHmrc: getSummVal(74),
          totalLeavingBankPension: getSummVal(75),
          totalLeavingBankMonth: getSummVal(77),
        };

        // Employee amounts for this month
        let monthHasActuals = false;
        const employeeAmounts = [];

        for (let i = 0; i < 50; i++) {
          const emp = employees[i];
          const effRow = effectiveAmountsRaw[i] || [];
          const actRow = actualAmountsRaw[i] || [];
          const fcRow = forecastAmountsRaw[i] || [];

          // Check whether this employee row has actuals in row 304:353
          const actSalary = actRow[colOffset + 0];
          const actEeNic = actRow[colOffset + 1];
          const actErNic = actRow[colOffset + 2];
          const actStudLoan = actRow[colOffset + 3];
          const actEePen = actRow[colOffset + 4];
          const actErPen = actRow[colOffset + 5];
          const actPaye = actRow[colOffset + 6];

          const hasAct = [actSalary, actEeNic, actErNic, actStudLoan, actEePen, actErPen, actPaye].some(
            (v) => v !== undefined && v !== null && String(v).trim() !== ""
          );

          if (hasAct) monthHasActuals = true;

          const salary = effRow[colOffset + 0] ?? (hasAct ? actSalary : fcRow[colOffset + 0]) ?? "";
          const eeNic = effRow[colOffset + 1] ?? (hasAct ? actEeNic : fcRow[colOffset + 1]) ?? "";
          const erNic = effRow[colOffset + 2] ?? (hasAct ? actErNic : fcRow[colOffset + 2]) ?? "";
          const studentLoan = effRow[colOffset + 3] ?? (hasAct ? actStudLoan : fcRow[colOffset + 3]) ?? "";
          const eePension = effRow[colOffset + 4] ?? (hasAct ? actEePen : fcRow[colOffset + 4]) ?? "";
          const erPension = effRow[colOffset + 5] ?? (hasAct ? actErPen : fcRow[colOffset + 5]) ?? "";
          const paye = effRow[colOffset + 6] ?? (hasAct ? actPaye : fcRow[colOffset + 6]) ?? "";

          employeeAmounts.push({
            employeeIndex: i,
            sheetRow: emp.sheetRow,
            name: emp.name,
            isActual: hasAct,
            type: hasAct ? "actual" : "forecast",
            salary,
            eeNic,
            erNic,
            studentLoan,
            eePension,
            erPension,
            paye,
          });
        }

        months.push({
          monthIndex: months.length,
          label: monthLabel,
          rawHeader: rawMonthHeader,
          colStartIdx: c,
          colStartLetter: startColLetter,
          colEndLetter: endColLetter,
          isActualMonth: monthHasActuals,
          colTotals,
          summary,
          employeeAmounts,
        });
      }

      // =========================================================================
      // PARSE CLIENT SHEET: "DIVIDENDS IN LIEU OF SALARY" (Outgoings Rows 118:121)
      // =========================================================================
      // Outgoings FY1: cols 6..17 (G..R), Total col 19 (T)
      // Outgoings FY2: cols 21..32 (V..AG), Total col 34 (AI)
      // Outgoings FY3: cols 36..47 (AK..AV), Total col 49 (AX)
      const fyConfigs = [
        {
          fyIndex: 0,
          label: String(outgoingsHeaders[19] || "FY1").replace(/total/i, "").trim() || "FY1",
          totalColIdx: 19,
          totalColLetter: "T",
          monthCols: Array.from({ length: 12 }, (_, i) => ({
            colIdx: 6 + i,
            colLetter: colIdxToLetter(6 + i),
            label: String(outgoingsHeaders[6 + i] || `M${i + 1}`).trim(),
          })),
        },
        {
          fyIndex: 1,
          label: String(outgoingsHeaders[34] || "FY2").replace(/total/i, "").trim() || "FY2",
          totalColIdx: 34,
          totalColLetter: "AI",
          monthCols: Array.from({ length: 12 }, (_, i) => ({
            colIdx: 21 + i,
            colLetter: colIdxToLetter(21 + i),
            label: String(outgoingsHeaders[21 + i] || `M${i + 1}`).trim(),
          })),
        },
        {
          fyIndex: 2,
          label: String(outgoingsHeaders[49] || "FY3").replace(/total/i, "").trim() || "FY3",
          totalColIdx: 49,
          totalColLetter: "AX",
          monthCols: Array.from({ length: 12 }, (_, i) => ({
            colIdx: 36 + i,
            colLetter: colIdxToLetter(36 + i),
            label: String(outgoingsHeaders[36 + i] || `M${i + 1}`).trim(),
          })),
        },
      ];

      // Find default FY matching current date
      const now = new Date();
      const curMonthIdx = now.getMonth();
      const curYear = now.getFullYear();
      let defaultFyIndex = 0;

      fyConfigs.forEach((fy, fIdx) => {
        const hasCur = fy.monthCols.some((m) => {
          const parsed = parseMonthYearHeader(m.label);
          return parsed && parsed.monthIdx === curMonthIdx && parsed.year === curYear;
        });
        if (hasCur) defaultFyIndex = fIdx;
      });

      // Outgoings Rows:
      // outgoingsDividendsRaw[0] = Row 118 (Dividends in lieu of salary)
      // outgoingsDividendsRaw[1] = Row 119 (Second row / slot)
      // outgoingsDividendsRaw[2] = Row 120 (Total div in lieu of salary - delivery)
      // outgoingsDividendsRaw[3] = Row 121 (Total div in lieu of salary - non-delivery)
      const row118 = outgoingsDividendsRaw[0] || [];
      const row119 = outgoingsDividendsRaw[1] || [];
      const row120 = outgoingsDividendsRaw[2] || [];
      const row121 = outgoingsDividendsRaw[3] || [];

      const dividendsSection = {
        defaultFyIndex,
        fyConfigs: fyConfigs.map((fy) => {
          const getMonthVals = (rowArr) =>
            fy.monthCols.map((m) => ({
              colLetter: m.colLetter,
              label: m.label,
              value: rowArr[m.colIdx] || "£0",
            }));

          return {
            ...fy,
            row118: {
              sheetRow: 118,
              description: row118[0] || "Dividends in lieu of salary",
              deliveryPct: row118[4] || "0%", // Col E (idx 4)
              months: getMonthVals(row118),
              total: row118[fy.totalColIdx] || "£0",
            },
            row119: {
              sheetRow: 119,
              description: row119[0] || "",
              deliveryPct: row119[4] || "",
              months: getMonthVals(row119),
              total: row119[fy.totalColIdx] || "",
              hasData: Boolean(row119[0] || row119[fy.totalColIdx]),
            },
            totalsDelivery: {
              sheetRow: 120,
              label: row120[0] || "Total div in lieu of salary - delivery",
              months: getMonthVals(row120),
              total: row120[fy.totalColIdx] || "£0",
            },
            totalsNonDelivery: {
              sheetRow: 121,
              label: row121[0] || "Total div in lieu of salary - non-delivery",
              months: getMonthVals(row121),
              total: row121[fy.totalColIdx] || "£0",
            },
          };
        }),
      };

      const result = {
        success: true,
        clientName,
        masterSheetId,
        clientSheetId,
        defaultMonthIndex,
        employees,
        months,
        dividends: dividendsSection,
      };

      return result;
    },
  });

  return cachedResult.data;
}

export async function invalidateSalariesCache(masterSheetId, clientSheetId) {
  const cleanClientId = unwrapSheetId(
    extractSheetIdFromUrl(clientSheetId || masterSheetId) || clientSheetId || masterSheetId || ""
  );
  const cacheKey = `salaries_data:${cleanClientId}`;
  try {
    memoryCache.del(cacheKey);
    if (redisClient && redisClient.isOpen) {
      await redisClient.del(cacheKey);
    }
    await invalidatePmaClientCache(clientSheetId || cleanClientId, masterSheetId, ["outgoings", "views", "cash"]);
  } catch (e) {
    console.warn("Failed to invalidate salaries cache:", e?.message);
  }
}

export async function saveEmployeeData({
  masterSheetId,
  clientSheetId,
  clientName,
  sheetRow,
  employeeData,
  sessionUser,
}) {
  if ((!masterSheetId && !clientSheetId) || !sheetRow || !employeeData) {
    throw new Error("masterSheetId or clientSheetId, sheetRow, and employeeData are required.");
  }
  if (sheetRow < 4 || sheetRow > 53) {
    throw new Error("sheetRow must be between 4 and 53.");
  }

  const sheets = await getSheetsClient();
  const targetSheetId = clientSheetId || masterSheetId;

  const vals = [
    sanitizeFormulaInput(employeeData.name || ""),
    sanitizeFormulaInput(employeeData.role || ""),
    sanitizeFormulaInput(employeeData.fteSalary || ""),
    sanitizeFormulaInput(employeeData.fte || ""),
    sanitizeFormulaInput(employeeData.startDate || ""),
    sanitizeFormulaInput(employeeData.endDate || ""),
    sanitizeFormulaInput(employeeData.deliveryPct || ""),
    sanitizeFormulaInput(employeeData.studentLoan || ""),
    sanitizeFormulaInput(employeeData.pension || ""),
  ];

  // Update single employee note attached to the Name cell (column A) and clear legacy field notes (columns B-I)
  if (employeeData.notes && typeof employeeData.notes === "object" && employeeData.notes.name !== undefined) {
    const gid = await getSheetGid(sheets, targetSheetId, "Salaries");
    const nameNote = String(employeeData.notes.name ?? "");
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: targetSheetId,
        requestBody: {
          requests: [
            {
              updateCells: {
                range: {
                  sheetId: gid,
                  startRowIndex: sheetRow - 1,
                  endRowIndex: sheetRow,
                  startColumnIndex: 0,
                  endColumnIndex: 9,
                },
                rows: [
                  {
                    values: [
                      { note: nameNote },
                      { note: "" },
                      { note: "" },
                      { note: "" },
                      { note: "" },
                      { note: "" },
                      { note: "" },
                      { note: "" },
                      { note: "" },
                    ],
                  },
                ],
                fields: "note",
              },
            },
          ],
        },
        _skipFormulaRecompute: true,
      })
    );
  }

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: targetSheetId,
      range: `Salaries!A${sheetRow}:I${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [vals] },
    })
  );

  await invalidateSalariesCache(masterSheetId, clientSheetId);

  await logPmaActivity({
    userEmail: sessionUser?.email || "unknown",
    action: "UPDATE_EMPLOYEE",
    details: `Updated employee row ${sheetRow} (${employeeData.name || "Unnamed"}) for client ${clientName}`,
  }).catch(() => { });

  return { success: true, message: `Employee row ${sheetRow} updated successfully.` };
}

export async function saveSalaryAmountOverride({
  masterSheetId,
  clientSheetId,
  clientName,
  sheetRow,
  colLetterStart,
  amounts,
  sessionUser,
}) {
  if ((!masterSheetId && !clientSheetId) || !sheetRow || !colLetterStart || !Array.isArray(amounts)) {
    throw new Error("masterSheetId or clientSheetId, sheetRow, colLetterStart, and amounts array are required.");
  }
  if (sheetRow < 4 || sheetRow > 53) {
    throw new Error("sheetRow must be between 4 and 53.");
  }

  const targetSheetId = clientSheetId || masterSheetId;
  const targetRow = clientSheetId ? sheetRow : 300 + sheetRow; // Client Sheet uses rows 4..53 (imported to Master 304..353)
  const startColIdx = colLetterToIdx(String(colLetterStart || "").trim().toUpperCase());
  if (isNaN(startColIdx) || startColIdx < 11 || (startColIdx - 11) % 7 !== 0 || amounts.length < 1 || amounts.length > 7 || startColIdx + amounts.length - 1 > 263) {
    throw new Error("Invalid salary override column range.");
  }
  const cleanStartLetter = colIdxToLetter(startColIdx);
  const endColLetter = colIdxToLetter(startColIdx + amounts.length - 1);

  const sheets = await getSheetsClient();
  const sanitized = amounts.map((v) => sanitizeFormulaInput(v === null || v === undefined ? "" : v));

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: targetSheetId,
      range: `Salaries!${cleanStartLetter}${targetRow}:${endColLetter}${targetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [sanitized] },
    })
  );

  await invalidateSalariesCache(masterSheetId, clientSheetId);

  await logPmaActivity({
    userEmail: sessionUser?.email || "unknown",
    action: "UPDATE_SALARY_OVERRIDE",
    details: `Updated salary override row ${targetRow} col ${colLetterStart} for client ${clientName}`,
  }).catch(() => { });

  return { success: true, message: "Salary amount override saved." };
}

export async function saveDividendsData({
  clientSheetId,
  masterSheetId,
  clientName,
  sheetRow = 118,
  deliveryPct,
  monthlyAmounts, // { colLetter: value }
  description,
  sessionUser,
}) {
  if (!clientSheetId) {
    throw new Error("clientSheetId is required.");
  }
  const rowNum = parseInt(sheetRow, 10);
  if (rowNum !== 118 && rowNum !== 119) {
    throw new Error("Invalid dividends row: must be 118 or 119.");
  }
  sheetRow = rowNum;

  const sheets = await getSheetsClient();
  const data = [];

  if (deliveryPct !== undefined && deliveryPct !== null) {
    data.push({
      range: `Outgoings!E${sheetRow}`,
      values: [[sanitizeFormulaInput(deliveryPct)]],
    });
  }

  if (description !== undefined && description !== null) {
    data.push({
      range: `Outgoings!A${sheetRow}`,
      values: [[sanitizeFormulaInput(description)]],
    });
  }

  if (monthlyAmounts && typeof monthlyAmounts === "object") {
    Object.entries(monthlyAmounts).forEach(([colLetter, val]) => {
      const cleanCol = String(colLetter || "").trim().toUpperCase();
      if (/^[A-Z]{1,2}$/.test(cleanCol) && val !== undefined) {
        const colIdx = colLetterToIdx(cleanCol);
        const isMonthlyCol = (colIdx >= 6 && colIdx <= 17) || (colIdx >= 21 && colIdx <= 32) || (colIdx >= 36 && colIdx <= 47);
        if (!isMonthlyCol) return;
        data.push({
          range: `Outgoings!${cleanCol}${sheetRow}`,
          values: [[sanitizeFormulaInput(val)]],
        });
      }
    });
  }

  if (data.length > 0) {
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data,
        },
      })
    );
  }

  await invalidateSalariesCache(masterSheetId, clientSheetId);

  await logPmaActivity({
    userEmail: sessionUser?.email || "unknown",
    action: "UPDATE_DIVIDENDS",
    details: `Updated dividends row ${sheetRow} for client ${clientName}`,
  }).catch(() => { });

  return { success: true, message: "Dividends updated successfully." };
}

function parseSalaryCellNum_(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const cleaned = String(val).replace(/[£$€,\s]/g, "").trim();
  if (!cleaned || cleaned === "-") return 0;
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function normalizePersonName_(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDeliveryFraction_(rawVal) {
  if (rawVal === null || rawVal === undefined || rawVal === "") return 1;
  if (typeof rawVal === "number") {
    return rawVal > 1 ? rawVal / 100 : Math.max(0, rawVal);
  }
  const s = String(rawVal).trim();
  const n = parseSalaryCellNum_(s.replace("%", ""));
  if (s.includes("%") || n > 1) return Math.max(0, n / 100);
  return Math.max(0, n);
}

/**
 * Finds populated employees in a Salaries month block whose actual cells (rows 4..53)
 * are completely blank while their forecast cells (rows 154..203) produce a non-zero cost.
 */
export function findForecastOnlyEmployeesInMonth_({
  employeesRows = [],
  actualsRows = [],
  forecastRows = [],
  colOffset = 0,
  monthMeta = null,
  contractorsRows = [],
  outgoingsMonthColIdx = -1,
  excludeEmployeeNames = null,
}) {
  const results = [];
  let actualEmployeeCount = 0;

  let suggestedNextStartIso = "";
  if (monthMeta && typeof monthMeta.year === "number" && typeof monthMeta.monthIdx === "number") {
    const nextMonth = new Date(monthMeta.year, monthMeta.monthIdx + 1, 1);
    suggestedNextStartIso = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
  }

  for (let i = 0; i < 50; i++) {
    const empRow = employeesRows[i] || [];
    const name = String(empRow[0] || "").trim();
    if (!name) continue;

    const actRow = actualsRows[i] || [];
    const hasAnyActual = [0, 1, 2, 3, 4, 5, 6].some((k) => {
      const v = actRow[colOffset + k];
      return v !== undefined && v !== null && String(v).trim() !== "";
    });

    if (hasAnyActual) {
      actualEmployeeCount++;
      continue;
    }

    if (excludeEmployeeNames && excludeEmployeeNames.has(name)) {
      continue;
    }

    const fcRow = forecastRows[i] || [];
    const likelRaw = empRow[9];
    const likel = (likelRaw === undefined || likelRaw === null || String(likelRaw).trim() === "")
      ? 1
      : parseSalaryCellNum_(likelRaw);
    if (likel <= 0) continue;

    const fcSalary = parseSalaryCellNum_(fcRow[colOffset + 0]) * likel;
    const fcEeNic = parseSalaryCellNum_(fcRow[colOffset + 1]) * likel;
    const fcErNic = parseSalaryCellNum_(fcRow[colOffset + 2]) * likel;
    const fcErPen = parseSalaryCellNum_(fcRow[colOffset + 5]) * likel;
    const fcPaye = parseSalaryCellNum_(fcRow[colOffset + 6]) * likel;
    const forecastEmployerCost = Math.round((fcSalary + fcErNic + fcErPen) * 100) / 100;

    if (Math.abs(forecastEmployerCost) <= 0.01 && Math.abs(fcEeNic) <= 0.01 && Math.abs(fcPaye) <= 0.01) {
      continue;
    }

    // Check whether this employee also appears under Contractors in Outgoings for the same month
    let contractorAmount = 0;
    if (outgoingsMonthColIdx >= 0 && Array.isArray(contractorsRows) && contractorsRows.length > 0) {
      const normEmp = normalizePersonName_(name);
      for (const cRow of contractorsRows) {
        const cName = normalizePersonName_(cRow?.[0]);
        if (!cName) continue;
        if (cName === normEmp) {
          contractorAmount += parseSalaryCellNum_(cRow[outgoingsMonthColIdx]);
        }
      }
      contractorAmount = Math.round(contractorAmount * 100) / 100;
    }

    const parsedStart = parseSheetDate(empRow[4]);
    const parsedEnd = parseSheetDate(empRow[5]);

    results.push({
      sheetRow: 4 + i,
      name,
      role: String(empRow[1] || "").trim(),
      startDate: parsedStart ? toSheetDateFormat(parsedStart) : String(empRow[4] || "").trim(),
      isoStartDate: parsedStart ? toInputDateFormat(parsedStart) : "",
      endDate: parsedEnd ? toSheetDateFormat(parsedEnd) : String(empRow[5] || "").trim(),
      isoEndDate: parsedEnd ? toInputDateFormat(parsedEnd) : "",
      deliveryPct: Math.round(parseDeliveryFraction_(empRow[6]) * 100),
      likelihood: likel,
      forecastSalary: Math.round(fcSalary * 100) / 100,
      forecastErNic: Math.round(fcErNic * 100) / 100,
      forecastErPen: Math.round(fcErPen * 100) / 100,
      forecastEmployerCost,
      contractorAmount,
      suggestedNextStartIso,
    });
  }

  return { actualEmployeeCount, forecastOnlyEmployees: results };
}

/**
 * Applies a resolution for a forecast-only employee in an actuals month:
 * - "zero_out": writes [0, 0, 0, 0, 0, 0, 0] to the month's actual cells (suppressing forecast)
 * - "update_start_date": updates the employee's Start date (Col E) to move them out of that month's forecast
 * - "keep_forecast": records explicit confirmation without modifying the sheet
 */
export async function applySalaryForecastResolution_({
  sheets,
  clientSheetId,
  masterSheetId,
  clientName,
  sheetRow,
  colStartLetter,
  monthLabel,
  resolutionAction,
  newStartDate,
  sessionUser,
}) {
  if (!clientSheetId && !masterSheetId) {
    throw new Error("clientSheetId or masterSheetId is required.");
  }
  const rowNum = parseInt(sheetRow, 10);
  if (isNaN(rowNum) || rowNum < 4 || rowNum > 53) {
    throw new Error("Invalid employee sheetRow.");
  }

  const targetSheetId = clientSheetId || masterSheetId;
  const effectiveSheets = sheets || (await getSheetsClient());

  if (resolutionAction === "zero_out") {
    if (!colStartLetter) throw new Error("colStartLetter is required to zero out monthly actuals.");
    await saveSalaryAmountOverride({
      masterSheetId: masterSheetId || clientSheetId,
      clientSheetId,
      clientName: clientName || "Client",
      sheetRow: rowNum,
      colLetterStart: colStartLetter,
      amounts: [0, 0, 0, 0, 0, 0, 0],
      sessionUser,
    });
    return {
      success: true,
      resolutionAction,
      message: `Zeroed out ${monthLabel || "month"} actuals for row ${rowNum}.`,
    };
  }

  if (resolutionAction === "update_start_date") {
    if (!newStartDate) throw new Error("newStartDate is required to update employee start date.");
    const parsed = parseSheetDate(newStartDate);
    if (!parsed) throw new Error("Invalid start date provided.");
    const formattedDate = toSheetDateFormat(parsed);

    const rowResp = await withRetry(() =>
      effectiveSheets.spreadsheets.values.get({
        spreadsheetId: targetSheetId,
        range: `Salaries!A${rowNum}:I${rowNum}`,
        valueRenderOption: "FORMATTED_VALUE",
      })
    );
    const existing = rowResp.data?.values?.[0] || [];
    await saveEmployeeData({
      masterSheetId: masterSheetId || clientSheetId,
      clientSheetId,
      clientName: clientName || "Client",
      sheetRow: rowNum,
      employeeData: {
        name: existing[0] || "",
        role: existing[1] || "",
        fteSalary: existing[2] || "",
        fte: existing[3] || "",
        startDate: formattedDate,
        endDate: existing[5] || "",
        deliveryPct: existing[6] || "",
        studentLoan: existing[7] || "",
        pension: existing[8] || "",
      },
      sessionUser,
    });
    return {
      success: true,
      resolutionAction,
      formattedStartDate: formattedDate,
      isoStartDate: toInputDateFormat(parsed),
      message: `Updated start date to ${formattedDate}.`,
    };
  }

  if (resolutionAction === "keep_forecast") {
    await logPmaActivity({
      userEmail: sessionUser?.email || "unknown",
      action: "CONFIRM_SALARY_FORECAST",
      details: `Confirmed employee row ${rowNum} should remain on forecast for ${monthLabel || "month"} (${clientName || "Client"})`,
    }).catch(() => {});
    return {
      success: true,
      resolutionAction,
      message: `Confirmed employee stays on forecast for ${monthLabel || "month"}.`,
    };
  }

  throw new Error(`Unsupported resolutionAction: ${resolutionAction}`);
}
