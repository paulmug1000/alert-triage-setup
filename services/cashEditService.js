/**
 * ============================================================================
 * CASH EDIT SERVICE
 * ============================================================================
 * Manages the interactive 36-month Cash edit screen from Client Sheet "Cash" tab:
 * - Table 1: Excluding pipeline (Rows 2–38)
 * - Table 2: Including pipeline (Rows 43–76)
 * - Strict whitelist for editable cells (Adjustments, Actual closing balance, B4, B8, B12, B16, B19, B21, J19, B61, B63, J61)
 * - Notes read/write for all cells from Column B onwards
 * ============================================================================
 */

import { getSheetsClient, withRetry, getSheetGid, colLetterToNum, extractSheetIdFromUrl } from "./sheetsClient.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeCashAdjustmentInput } from "./cashflowReconService.js";
import { memoryCache, resolvePortalCache, invalidatePmaClientCache } from "./cacheService.js";
import { sanitizeFormulaInput, unwrapSheetId, resolveClientNameBySheetId } from "./userPermissions.js";
import { redisClient } from "./redisClient.js";
import { scheduleWaitUntil_ } from "./alertState.js";
import { evaluateSafeArithmetic, isCashCellEditable } from "../utils/helpers.js";
export { isCashCellEditable };
import { resolveSupabaseSheetContext } from "./masterEngineService.js";
import { preloadClientRelationalInputsBundle } from "./relationalInputsService.js";
import { formatCellForDisplay } from "./gasRuntime/sheetValueUtils.js";
import { formatMoney as universalFormatMoney } from "./deepDiveHelper.js";
import {
  getClientCashBankBreakdowns,
  saveClientCashBankBreakdownMonth,
  deleteClientCashBankBreakdownMonth,
  resolveMonthlyBankBreakdown,
  sanitizeBreakdownAccounts,
  buildRow36FormulaFromAccounts,
} from "./cashBankBreakdownService.js";

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

export function colorToCss(rgbColor) {
  if (!rgbColor) return null;
  const r = Math.round((rgbColor.red ?? 0) * 255);
  const g = Math.round((rgbColor.green ?? 0) * 255);
  const b = Math.round((rgbColor.blue ?? 0) * 255);
  if (r === 255 && g === 255 && b === 255) return null;
  const a = rgbColor.alpha !== undefined ? rgbColor.alpha : 1;
  return a < 1 ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseMonthHeader(label) {
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

/**
 * Re-exported from utils/helpers.js to avoid circular imports with relationalInputsService.js.
 */

/**
 * Fetch 36 months of data from Cash!A1:AK76
 */
export async function fetchCashData(clientName, clientSheetId, bypassCache = false, options = {}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");

  const cleanId = unwrapSheetId(extractSheetIdFromUrl(clientSheetId) || String(clientSheetId).trim());
  const cacheKey = `pma_cash_${cleanId}`;
  const forceMode =
    options?._forceInputsReadMode === "grid" || options?._forceInputsReadMode === "relational"
      ? options._forceInputsReadMode
      : null;

  const fetchFreshFn = async () => {
    const sheets = await getSheetsClient();

    let resolvedClientName = String(clientName || "").trim();
    const sbCtx = await resolveSupabaseSheetContext({
      spreadsheetId: cleanId,
      clientName: resolvedClientName && resolvedClientName !== "Client" ? resolvedClientName : "",
    }).catch(() => null);
    if (sbCtx?.clientName) {
      resolvedClientName = sbCtx.clientName;
    } else if (!resolvedClientName || resolvedClientName === "Client") {
      const lookedUp = await resolveClientNameBySheetId(sheets, cleanId).catch(() => "");
      if (lookedUp) resolvedClientName = lookedUp;
    }

    const useRelReads = forceMode
      ? forceMode === "relational"
      : Boolean(sbCtx?.inputsMode === "relational" && sbCtx?.inputsReadMode === "relational" && sbCtx?.clientId);

    // Fetch Cash!A1:AK76 and KeyInfo!A1:I21 with values, formulas, notes, and effective formats (shading)
    const [res, storedBreakdowns, relInputsBundle] = await Promise.all([
      withRetry(async () => {
        return await sheets.spreadsheets.get({
          spreadsheetId: cleanId,
          ranges: ["Cash!A1:AK76", "KeyInfo!A1:I21"],
          fields: "sheets(properties(title,sheetId),data.rowData.values(formattedValue,effectiveValue,userEnteredValue,note,effectiveFormat(backgroundColor,textFormat)))",
        });
      }),
      getClientCashBankBreakdowns(resolvedClientName, forceMode ? { _forceInputsReadMode: forceMode } : {}),
      useRelReads && sbCtx?.clientId
        ? preloadClientRelationalInputsBundle(sbCtx, { includeCash: true }).catch(() => null)
        : Promise.resolve(null),
    ]);

    const usedRelReads = Boolean(useRelReads && relInputsBundle);
    const cashAdjByCoord = new Map();
    if (usedRelReads) {
      for (const adj of relInputsBundle.cashAdjustments || []) {
        cashAdjByCoord.set(`${adj.sheet_row_num}:${adj.sheet_col_idx}`, adj);
      }
    }

      const cashSheet = res.data?.sheets?.find((s) => s.properties?.title === "Cash") || res.data?.sheets?.[0];
      const rowData = cashSheet?.data?.[0]?.rowData || [];

      if (!rowData.length) {
        throw new Error("Cash sheet is empty or not found in client spreadsheet.");
      }

      const keyInfoSheet = res.data?.sheets?.find((s) => s.properties?.title === "KeyInfo");
      const kiRows = keyInfoSheet?.data?.[0]?.rowData || [];
      const currencyRaw = String(kiRows?.[16]?.values?.[1]?.formattedValue || "GBP").trim() || "GBP";
      const currencyUpper = currencyRaw.toUpperCase();
      const currencySymbol = currencyUpper === "USD" ? "$" : currencyUpper === "EUR" ? "€" : "£";

      const bankAccounts = [];
      for (let rIdx = 11; rIdx <= 20; rIdx++) {
        const vals = kiRows?.[rIdx]?.values || [];
        const acctName = String(vals?.[7]?.formattedValue || "").trim();
        const acctId = String(vals?.[8]?.formattedValue || "").trim();
        if (!acctName || acctName.endsWith(":") || acctName.toLowerCase().includes("non-cash")) continue;
        bankAccounts.push({ name: acctName, accountId: acctId });
      }

      const row0 = (rowData[0]?.values || []).map((c) => String(c?.formattedValue || "").trim());

      // Determine current and previous month
      const now = new Date();
      const curMonth = now.getMonth();
      const curYear = now.getFullYear();
      let prevMonth = curMonth - 1;
      let prevYear = curYear;
      if (prevMonth < 0) {
        prevMonth = 11;
        prevYear -= 1;
      }

      // Parse up to 36 month columns (Col B [1] to Col AK [36])
      const monthCols = [];
      let previousMonthColIdx = 1;
      let currentMonthColIdx = 1;

      for (let c = 1; c <= 36 && c < row0.length; c++) {
        const rawLabel = row0[c] || `Month ${c}`;
        const parsed = parseMonthHeader(rawLabel);
        const colLetter = colIdxToLetter(c);
        const monthKey = parsed ? `${parsed.year}-${String(parsed.monthIdx + 1).padStart(2, "0")}` : null;

        let isPrevious = false;
        let isCurrent = false;

        if (parsed) {
          if (parsed.year === prevYear && parsed.monthIdx === prevMonth) {
            isPrevious = true;
            previousMonthColIdx = c;
          }
          if (parsed.year === curYear && parsed.monthIdx === curMonth) {
            isCurrent = true;
            currentMonthColIdx = c;
          }
        }

        monthCols.push({
          colIdx: c,
          colLetter,
          label: rawLabel,
          parsed,
          monthKey,
          isPreviousMonth: isPrevious,
          isCurrentMonth: isCurrent,
        });
      }

      // Parse row definitions
      const parseRowsForRange = (startRow, endRow) => {
        const list = [];
        for (let r = startRow; r <= endRow && r <= rowData.length; r++) {
          const rowCells = rowData[r - 1]?.values || [];
          const label = String(rowCells[0]?.formattedValue || "").trim();
          const labelBg = colorToCss(rowCells[0]?.effectiveFormat?.backgroundColor);
          const isBold = Boolean(rowCells[0]?.effectiveFormat?.textFormat?.bold);

          const cells = monthCols.map((m) => {
            const cellData = rowCells[m.colIdx];
            let formattedValue = cellData?.formattedValue !== undefined && cellData?.formattedValue !== null
              ? String(cellData.formattedValue).trim()
              : "";
            let formula = cellData?.userEnteredValue?.formulaValue || "";
            let numericValue =
              typeof cellData?.effectiveValue?.numberValue === "number"
                ? cellData.effectiveValue.numberValue
                : (typeof cellData?.userEnteredValue?.numberValue === "number" ? cellData.userEnteredValue.numberValue : null);
            let note = cellData?.note || "";
            const isEditable = isCashCellEditable(r, m.colIdx);
            const bgColor = colorToCss(cellData?.effectiveFormat?.backgroundColor);
            const cellBold = Boolean(cellData?.effectiveFormat?.textFormat?.bold);

            if (usedRelReads) {
              const adj = cashAdjByCoord.get(`${r}:${m.colIdx}`) || null;
              if (isEditable) {
                formula = adj?.formula || "";
                const rawVal = adj && adj.raw_value !== undefined && adj.raw_value !== null ? adj.raw_value : "";
                const strVal = rawVal === "" ? "" : String(rawVal);
                formattedValue = strVal !== "" ? String(formatCellForDisplay("client", "Cash", r - 1, m.colIdx, rawVal) || "").trim() : "";
                const numClean = typeof rawVal === "number" ? rawVal : parseFloat(strVal.replace(/[£$€,\s]/g, ""));
                const isNum =
                  typeof rawVal === "number" ||
                  (strVal !== "" && !isNaN(numClean) && /^[-+]?[£$€]?\s*[\d,]+(\.\d+)?%?$/.test(strVal.trim()));
                numericValue = isNum ? numClean : null;
              }
              note = adj?.cell_note || "";
            }

            const cellOut = {
              sheetRow: r,
              colIdx: m.colIdx,
              colLetter: m.colLetter,
              cellRef: `${m.colLetter}${r}`,
              formattedValue,
              numericValue,
              formula,
              note,
              isEditable,
              bgColor,
              isBold: cellBold,
            };

            if (r === 36) {
              const hasCellValue = Boolean(formattedValue !== "" || formula !== "" || numericValue !== null);
              cellOut.bankBreakdown = resolveMonthlyBankBreakdown({
                monthKey: m.monthKey,
                cellNumericValue: numericValue,
                hasCellValue,
                formula,
                storedEntry: m.monthKey ? storedBreakdowns.months?.[m.monthKey] || null : null,
                configuredBankAccounts: bankAccounts,
              });
            }

            return cellOut;
          });

          // Special check: is this an empty spacer row?
          const isSpacer = !label && cells.every((c) => !c.formattedValue && !c.formula);

          list.push({
            sheetRow: r,
            label,
            labelBg,
            isBold,
            isSpacer,
            cells,
          });
        }
        return list;
      };

      const table1Rows = parseRowsForRange(2, 38);
      const table2Rows = parseRowsForRange(43, 76);

      const result = {
        success: true,
        clientName: resolvedClientName || clientName,
        clientSheetId: cleanId,
        currency: currencyRaw,
        currencySymbol,
        bankAccounts,
        monthCols,
        previousMonthColIdx,
        currentMonthColIdx,
        table1Rows,
        table2Rows,
        inputsReadMode: usedRelReads ? "relational" : "grid",
        lastUpdated: new Date().toISOString(),
      };

      return result;
  };

  if (forceMode) {
    return await fetchFreshFn();
  }

  const cachedResult = await resolvePortalCache({
    cacheKey,
    bypassCache: Boolean(bypassCache),
    minBypassAgeMs: options?.minBypassAgeMs || 0,
    l1TtlSecs: 120,
    redisTtlSecs: 86400,
    isValidPayload: (p) => Boolean(p && p.success && Array.isArray(p.table1Rows) && Array.isArray(p.bankAccounts)),
    fetchFreshFn,
  });

  return cachedResult.data;
}

/**
 * Batch update cell values and notes with strict whitelist enforcement.
 */
export async function saveCashBatch({
  clientName,
  clientSheetId,
  updates = [], // [{ sheetRow, colIdx, colLetter, value }]
  cellNotes = [], // [{ sheetRow, colIdx, colLetter, note }]
  userEmail,
  automationCommanderSheetId,
  isAdmin = true,
}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");
  const cleanId = unwrapSheetId(extractSheetIdFromUrl(clientSheetId) || String(clientSheetId).trim());
  const sheets = await getSheetsClient();

  let resolvedClientName = String(clientName || "").trim();
  const sbCtx = await resolveSupabaseSheetContext({
    spreadsheetId: cleanId,
    clientName: resolvedClientName && resolvedClientName !== "Client" ? resolvedClientName : "",
  }).catch(() => null);
  if (sbCtx?.clientName) {
    resolvedClientName = sbCtx.clientName;
  } else if (!resolvedClientName || resolvedClientName === "Client") {
    const lookedUp = await resolveClientNameBySheetId(sheets, cleanId).catch(() => "");
    if (lookedUp) resolvedClientName = lookedUp;
  }

  const validValueUpdates = [];
  for (const up of updates) {
    const rowNum = parseInt(up.sheetRow, 10);
    const colIdx = up.colIdx !== undefined ? parseInt(up.colIdx, 10) : colLetterToNum(up.colLetter) - 1;
    if (!Number.isInteger(rowNum) || rowNum < 1 || rowNum > 500 || !Number.isInteger(colIdx) || colIdx < 0 || colIdx > 100) {
      continue;
    }
    const colLetter = colIdxToLetter(colIdx);

    if (!isCashCellEditable(rowNum, colIdx)) {
      console.warn(`[Cash Save] Skipped protected cell Cash!${colLetter}${rowNum}`);
      continue;
    }

    let cleanVal = sanitizeCashAdjustmentInput(String(up.value ?? "").trim());
    if (!isAdmin && typeof cleanVal === "string" && cleanVal.startsWith("=")) {
      const evaluated = evaluateSafeArithmetic(cleanVal);
      const resolved =
        typeof evaluated === "number" && isFinite(evaluated)
          ? Math.round(evaluated * 100) / 100
          : null;
      cleanVal = resolved !== null ? resolved : sanitizeFormulaInput(cleanVal.replace(/^=+/, ""));
    }
    validValueUpdates.push({
      range: `Cash!${colLetter}${rowNum}`,
      values: [[cleanVal]],
      rowNum,
      colIdx,
      colLetter,
      value: cleanVal,
    });
  }

  // Update notes if provided (allowed for any cell Col B onwards)
  // Execute structural/metadata spreadsheets.batchUpdate FIRST while the sheet is idle,
  // then write cell values SECOND so note updates never block behind Cash formula recalculation.
  const validNoteRequests = [];
  if (cellNotes && Array.isArray(cellNotes) && cellNotes.length > 0) {
    const gid = await getSheetGid(sheets, cleanId, "Cash");
    for (const cn of cellNotes) {
      const rowNum = parseInt(cn.sheetRow, 10);
      const colIdx = cn.colIdx !== undefined ? parseInt(cn.colIdx, 10) : colLetterToNum(cn.colLetter) - 1;
      if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > 500 || !Number.isInteger(colIdx) || colIdx < 1 || colIdx > 36) continue; // Skip out-of-bounds or column A

      validNoteRequests.push({
        updateCells: {
          range: {
            sheetId: gid,
            startRowIndex: rowNum - 1,
            endRowIndex: rowNum,
            startColumnIndex: colIdx,
            endColumnIndex: colIdx + 1,
          },
          rows: [{ values: [{ note: String(cn.note ?? "") }] }],
          fields: "note",
        },
      });
    }

    if (validNoteRequests.length > 0) {
      await withRetry(async () => {
        return await sheets.spreadsheets.batchUpdate({
          spreadsheetId: cleanId,
          _skipFormulaRecompute: validValueUpdates.length > 0,
          requestBody: {
            requests: validNoteRequests,
          },
        });
      });
    }
  }

  // Execute value batch update SECOND (defer downstream tab recomputes so response flushes promptly)
  if (validValueUpdates.length > 0) {
    await withRetry(async () => {
      return await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: cleanId,
        _deferBackgroundRecompute: true,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: validValueUpdates.map((v) => ({
            range: v.range,
            values: v.values,
          })),
        },
      });
    });

    // Clear stale stored bank breakdown if Row 36 was overwritten/cleared via raw batch save
    const row36Updates = validValueUpdates.filter((v) => v.rowNum === 36);
    if (row36Updates.length > 0 && resolvedClientName) {
      try {
        const hdrResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: cleanId,
            range: "Cash!A1:AK1",
            valueRenderOption: "FORMATTED_VALUE",
          })
        );
        const hdrRow = hdrResp.data?.values?.[0] || [];
        for (const u of row36Updates) {
          const parsedHdr = parseMonthHeader(String(hdrRow[u.colIdx] || "").trim());
          if (!parsedHdr) continue;
          const mKey = `${parsedHdr.year}-${String(parsedHdr.monthIdx + 1).padStart(2, "0")}`;
          await deleteClientCashBankBreakdownMonth({
            clientName: resolvedClientName,
            monthKey: mKey,
            updatedBy: userEmail || "System",
          }).catch(() => {});
        }
      } catch { }
    }
  }

  // Invalidate caches
  try {
    await invalidatePmaClientCache(cleanId, resolvedClientName || clientName, ["cash"]);
  } catch { }

  // Log activity in background
  if (validValueUpdates.length > 0 || validNoteRequests.length > 0) {
    const changeSummary = [];
    if (validValueUpdates.length > 0) {
      changeSummary.push(`${validValueUpdates.length} cell${validValueUpdates.length > 1 ? "s" : ""}`);
    }
    if (validNoteRequests.length > 0) {
      changeSummary.push(`${validNoteRequests.length} note${validNoteRequests.length > 1 ? "s" : ""}`);
    }

    scheduleWaitUntil_(() =>
      logPmaActivity({
        userEmail: userEmail || "system",
        action: "UPDATE_CASH_CELLS",
        clientName: resolvedClientName || clientName || "Client",
        details: `Updated ${changeSummary.join(" and ")} on Cash tab`,
        automationCommanderSheetId,
      })
      , 25);
  }

  return {
    success: true,
    savedValuesCount: validValueUpdates.length,
    savedNotesCount: validNoteRequests.length,
  };
}

/**
 * Save or clear a per-bank-account breakdown and update Cash Row 36 for a month.
 */
export async function saveCashBankBreakdown({
  clientName,
  clientSheetId,
  monthKey,
  accounts = [],
  clear = false,
  userEmail,
  automationCommanderSheetId,
}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");
  const cleanMonth = String(monthKey || "").trim();
  if (!/^\d{4}-\d{2}$/.test(cleanMonth)) {
    throw new Error("Invalid monthKey: expected YYYY-MM format.");
  }

  const cleanId = unwrapSheetId(extractSheetIdFromUrl(clientSheetId) || String(clientSheetId).trim());
  const sheets = await getSheetsClient();

  let resolvedClientName = String(clientName || "").trim();
  const sbCtx = await resolveSupabaseSheetContext({
    spreadsheetId: cleanId,
    clientName: resolvedClientName && resolvedClientName !== "Client" ? resolvedClientName : "",
  }).catch(() => null);
  if (sbCtx?.clientName) {
    resolvedClientName = sbCtx.clientName;
  } else if (!resolvedClientName || resolvedClientName === "Client") {
    const lookedUp = await resolveClientNameBySheetId(sheets, cleanId).catch(() => "");
    if (lookedUp) resolvedClientName = lookedUp;
  }

  // Server-side column resolution from Cash!A1:AK1 + currency from KeyInfo!B17
  const hdrResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanId,
      ranges: ["Cash!A1:AK1", "KeyInfo!B17"],
      valueRenderOption: "FORMATTED_VALUE",
    })
  );
  const hdrRow = hdrResp.data?.valueRanges?.[0]?.values?.[0] || [];
  const currencyRaw = String(hdrResp.data?.valueRanges?.[1]?.values?.[0]?.[0] || "GBP").trim().toUpperCase();
  const currencySymbol = currencyRaw === "USD" ? "$" : currencyRaw === "EUR" ? "€" : "£";

  let targetColIdx = -1;
  for (let c = 1; c <= 36 && c < hdrRow.length; c++) {
    const parsed = parseMonthHeader(String(hdrRow[c] || "").trim());
    if (!parsed) continue;
    const key = `${parsed.year}-${String(parsed.monthIdx + 1).padStart(2, "0")}`;
    if (key === cleanMonth) {
      targetColIdx = c;
      break;
    }
  }
  if (targetColIdx === -1) {
    throw new Error(`Could not locate month ${cleanMonth} in Cash headers.`);
  }
  const colLetter = colIdxToLetter(targetColIdx);
  const cellRange = `Cash!${colLetter}36`;

  const cleanAccounts = clear ? [] : sanitizeBreakdownAccounts(accounts);
  if (clear || cleanAccounts.length === 0) {
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: cleanId,
        range: cellRange,
        valueInputOption: "USER_ENTERED",
        _deferBackgroundRecompute: true,
        requestBody: { values: [[""]] },
      })
    );

    if (resolvedClientName) {
      await deleteClientCashBankBreakdownMonth({
        clientName: resolvedClientName,
        monthKey: cleanMonth,
        updatedBy: userEmail || "System",
      });
    }

    try {
      await invalidatePmaClientCache(cleanId, resolvedClientName || clientName, ["cash", "dashboard", "views"]);
    } catch { }

    scheduleWaitUntil_(() =>
      logPmaActivity({
        userEmail: userEmail || "system",
        action: "UPDATE_CASH_BANK_BREAKDOWN",
        clientName: resolvedClientName || clientName || "Client",
        details: `Cleared actual closing balance and bank breakdown for ${cleanMonth} (${cellRange})`,
        automationCommanderSheetId,
      }),
      25
    );

    return {
      success: true,
      cleared: true,
      monthKey: cleanMonth,
      colIdx: targetColIdx,
      total: null,
      numericValue: null,
      formattedValue: "",
      bankBreakdown: null,
    };
  }

  const total = Math.round(cleanAccounts.reduce((s, a) => s + a.amount, 0) * 100) / 100;
  const sheetCellValue = buildRow36FormulaFromAccounts(cleanAccounts);

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: cleanId,
      range: cellRange,
      valueInputOption: "USER_ENTERED",
      _deferBackgroundRecompute: true,
      requestBody: { values: [[sheetCellValue]] },
    })
  );

  const savedEntry = await saveClientCashBankBreakdownMonth({
    clientName: resolvedClientName || clientName || "Client",
    monthKey: cleanMonth,
    accounts: cleanAccounts,
    total,
    source: "pma_cash_edit",
    basis: "manual",
    updatedBy: userEmail || "System",
  });

  try {
    await invalidatePmaClientCache(cleanId, resolvedClientName || clientName, ["cash", "dashboard", "views"]);
  } catch { }

  scheduleWaitUntil_(() =>
    logPmaActivity({
      userEmail: userEmail || "system",
      action: "UPDATE_CASH_BANK_BREAKDOWN",
      clientName: resolvedClientName || clientName || "Client",
      details: `Updated actual closing balance (${total}) with ${cleanAccounts.length} bank account(s) for ${cleanMonth}`,
      automationCommanderSheetId,
    }),
    25
  );

  return {
    success: true,
    cleared: false,
    monthKey: cleanMonth,
    colIdx: targetColIdx,
    total,
    numericValue: total,
    formattedValue: universalFormatMoney(total, 0, currencySymbol, ","),
    bankBreakdown: {
      monthKey: cleanMonth,
      source: savedEntry.source,
      basis: savedEntry.basis,
      accounts: cleanAccounts,
      total,
      matchesCell: true,
      cellTotal: total,
      labelsInferred: false,
      updatedAt: savedEntry.updatedAt,
    },
  };
}

/**
 * Save or clear a single cell note
 */
export async function saveCashCellNote({
  clientName,
  clientSheetId,
  sheetRow,
  colIdx,
  colLetter,
  note = "",
  userEmail,
  automationCommanderSheetId,
}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");
  const cleanId = unwrapSheetId(extractSheetIdFromUrl(clientSheetId) || String(clientSheetId).trim());
  const rowNum = parseInt(sheetRow, 10);
  const finalColIdx = colIdx !== undefined ? parseInt(colIdx, 10) : colLetterToNum(colLetter) - 1;

  if (!Number.isInteger(rowNum) || rowNum < 1 || rowNum > 100) {
    throw new Error("Invalid Cash row index: must be an integer between 1 and 100.");
  }
  if (!Number.isInteger(finalColIdx) || finalColIdx < 1 || finalColIdx > 40) {
    throw new Error("Notes can only be added between Column B and Column AO (column index 1 to 40).");
  }
  const finalColLetter = colIdxToLetter(finalColIdx);

  const sheets = await getSheetsClient();
  const gid = await getSheetGid(sheets, cleanId, "Cash");
  const cleanNote = String(note ?? "");

  await withRetry(async () => {
    return await sheets.spreadsheets.batchUpdate({
      spreadsheetId: cleanId,
      requestBody: {
        requests: [
          {
            updateCells: {
              range: {
                sheetId: gid,
                startRowIndex: rowNum - 1,
                endRowIndex: rowNum,
                startColumnIndex: finalColIdx,
                endColumnIndex: finalColIdx + 1,
              },
              rows: [{ values: [{ note: cleanNote }] }],
              fields: "note",
            },
          },
        ],
      },
    });
  });

  // Invalidate caches
  try {
    await invalidatePmaClientCache(cleanId, null, ["cash"]);
  } catch { }

  scheduleWaitUntil_(() =>
    logPmaActivity({
      userEmail: userEmail || "system",
      action: "UPDATE_CASH_NOTE",
      clientName: clientName || "Client",
      details: `${cleanNote ? "Updated" : "Cleared"} note on Cash!${finalColLetter}${rowNum}`,
      automationCommanderSheetId,
    }).catch(() => { })
    , 25);

  return {
    success: true,
    cellRef: `${finalColLetter}${rowNum}`,
    sheetRow: rowNum,
    colIdx: finalColIdx,
    note: cleanNote,
  };
}
