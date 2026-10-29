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

import { getSheetsClient, withRetry, getSheetGid } from "./sheetsClient.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeFormulaInput } from "./userPermissions.js";
import { memoryCache } from "./cacheService.js";
import { redisClient } from "./redisClient.js";

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
  if (!masterSheetId || !clientSheetId) {
    throw new Error("Both masterSheetId and clientSheetId are required.");
  }

  const cacheKey = `salaries_data:${masterSheetId}:${clientSheetId}`;
  if (!bypassCache) {
    try {
      if (redisClient && redisClient.isOpen) {
        const cached = await redisClient.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } else {
        const cached = memoryCache.get(cacheKey);
        if (cached) return cached;
      }
    } catch (e) {
      console.warn("Failed to read from cache in getSalariesData:", e?.message);
    }
  }

  const sheets = await getSheetsClient();

  // 1. Batch get from Master Sheet and fetch metadata notes:
  // - Salaries!A1:JC3 (Headers)
  // - Salaries!A4:I53 (Employees metadata)
  // - Salaries!L4:JC53 (Effective amounts)
  // - Salaries!L54:JC58 (Totals: row 55 all, 57 delivery, 58 non-delivery)
  // - Salaries!L60:JC77 (Summary rows 60 to 77)
  // - Salaries!L154:JC203 (Forecast amounts)
  // - Salaries!L304:JC353 (Actuals / Hardcoded adjustments)
  const [masterBatchResp, employeesGetResp, clientBatchResp] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: masterSheetId,
        ranges: [
          "Salaries!A1:JC3",
          "Salaries!A4:I53",
          "Salaries!L4:JC53",
          "Salaries!L54:JC58",
          "Salaries!L60:JC77",
          "Salaries!L154:JC203",
          "Salaries!L304:JC353",
        ],
        valueRenderOption: "FORMATTED_VALUE",
      })
    ),
    withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: masterSheetId,
        ranges: ["Salaries!A4:I53"],
        fields: "sheets.data.rowData.values(formattedValue,note)",
      })
    ),
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: clientSheetId,
        ranges: [
          "Outgoings!A1:BA1",
          "Outgoings!A118:BA121",
        ],
        valueRenderOption: "FORMATTED_VALUE",
      })
    ),
  ]);

  const masterRanges = masterBatchResp.data.valueRanges || [];
  const masterHeaders = masterRanges[0]?.values || [];
  const employeesRaw = masterRanges[1]?.values || [];
  const effectiveAmountsRaw = masterRanges[2]?.values || [];
  const totalsRaw = masterRanges[3]?.values || [];
  const summaryRaw = masterRanges[4]?.values || [];
  const forecastAmountsRaw = masterRanges[5]?.values || [];
  const actualAmountsRaw = masterRanges[6]?.values || [];

  const employeeRowData = employeesGetResp.data?.sheets?.[0]?.data?.[0]?.rowData || [];

  const clientRanges = clientBatchResp.data.valueRanges || [];
  const outgoingsHeaders = clientRanges[0]?.values?.[0] || [];
  const outgoingsDividendsRaw = clientRanges[1]?.values || [];

  // =========================================================================
  // PARSE MASTER SHEET: EMPLOYEES (A4:I53)
  // =========================================================================
  const employees = [];
  for (let i = 0; i < 50; i++) {
    const row = employeesRaw[i] || [];
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

    const notes = {
      name: rowCells[0]?.note || "",
      role: rowCells[1]?.note || "",
      fteSalary: rowCells[2]?.note || "",
      fte: rowCells[3]?.note || "",
      startDate: rowCells[4]?.note || "",
      endDate: rowCells[5]?.note || "",
      deliveryPct: rowCells[6]?.note || "",
      studentLoan: rowCells[7]?.note || "",
      pension: rowCells[8]?.note || "",
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

  // Cache for 60 seconds
  try {
    if (redisClient && redisClient.isOpen) {
      await redisClient.set(cacheKey, JSON.stringify(result), "EX", 60);
    } else {
      memoryCache.set(cacheKey, result, 60);
    }
  } catch (e) {
    console.warn("Failed to write to cache in getSalariesData:", e?.message);
  }

  return result;
}

export async function invalidateSalariesCache(masterSheetId, clientSheetId) {
  const cacheKey = `salaries_data:${masterSheetId}:${clientSheetId}`;
  try {
    if (redisClient && redisClient.isOpen) {
      await redisClient.del(cacheKey);
    } else {
      memoryCache.delete(cacheKey);
    }
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
  if (!masterSheetId || !sheetRow || !employeeData) {
    throw new Error("masterSheetId, sheetRow, and employeeData are required.");
  }
  if (sheetRow < 4 || sheetRow > 53) {
    throw new Error("sheetRow must be between 4 and 53.");
  }

  const sheets = await getSheetsClient();

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

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: masterSheetId,
      range: `Salaries!A${sheetRow}:I${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [vals] },
    })
  );

  // Update cell notes if provided
  if (employeeData.notes && typeof employeeData.notes === "object") {
    const gid = await getSheetGid(sheets, masterSheetId, "Salaries");
    const colKeys = ["name", "role", "fteSalary", "fte", "startDate", "endDate", "deliveryPct", "studentLoan", "pension"];
    const noteRequests = [];
    colKeys.forEach((key, colIdx) => {
      if (employeeData.notes[key] !== undefined) {
        noteRequests.push({
          updateCells: {
            range: {
              sheetId: gid,
              startRowIndex: sheetRow - 1,
              endRowIndex: sheetRow,
              startColumnIndex: colIdx,
              endColumnIndex: colIdx + 1,
            },
            rows: [{ values: [{ note: String(employeeData.notes[key] ?? "") }] }],
            fields: "note",
          },
        });
      }
    });

    if (noteRequests.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: masterSheetId,
          requestBody: { requests: noteRequests },
        })
      );
    }
  }

  await invalidateSalariesCache(masterSheetId, clientSheetId);

  await logPmaActivity({
    userEmail: sessionUser?.email || "unknown",
    action: "UPDATE_EMPLOYEE",
    details: `Updated employee row ${sheetRow} (${employeeData.name || "Unnamed"}) for client ${clientName}`,
  }).catch(() => {});

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
  if (!masterSheetId || !sheetRow || !colLetterStart || !Array.isArray(amounts)) {
    throw new Error("masterSheetId, sheetRow, colLetterStart, and amounts array are required.");
  }
  if (sheetRow < 4 || sheetRow > 53) {
    throw new Error("sheetRow must be between 4 and 53.");
  }

  const actualsRow = 300 + sheetRow; // Rows 304 to 353
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
      spreadsheetId: masterSheetId,
      range: `Salaries!${cleanStartLetter}${actualsRow}:${endColLetter}${actualsRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [sanitized] },
    })
  );

  await invalidateSalariesCache(masterSheetId, clientSheetId);

  await logPmaActivity({
    userEmail: sessionUser?.email || "unknown",
    action: "UPDATE_SALARY_OVERRIDE",
    details: `Updated salary override row ${actualsRow} col ${colLetterStart} for client ${clientName}`,
  }).catch(() => {});

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
  }).catch(() => {});

  return { success: true, message: "Dividends updated successfully." };
}
