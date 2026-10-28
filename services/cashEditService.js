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

import { getSheetsClient, withRetry, getSheetGid, colLetterToNum } from "./sheetsClient.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeCashAdjustmentInput } from "./cashflowReconService.js";
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
 * Strict whitelist determining whether a cell is editable in the Cash tab.
 * @param {number} rowNum 1-based sheet row number (e.g. 4, 7, 36)
 * @param {number} colIdx 0-based column index (0 = A, 1 = B, 9 = J, etc.)
 */
export function isCashCellEditable(rowNum, colIdx) {
  // Column A (index 0) is line item labels - never editable
  if (colIdx < 1) return false;

  // 1. Whitelisted Single Override Cells
  // B4 (Month 1 Opening balance)
  if (rowNum === 4 && colIdx === 1) return true;
  // B8 (Month 1 Salaries)
  if (rowNum === 8 && colIdx === 1) return true;
  // B12 (Month 1 Contractors)
  if (rowNum === 12 && colIdx === 1) return true;
  // B16 (Month 1 Other expenses)
  if (rowNum === 16 && colIdx === 1) return true;
  // B19 (Month 1 Corporation tax)
  if (rowNum === 19 && colIdx === 1) return true;
  // B21 (Month 1 VAT)
  if (rowNum === 21 && colIdx === 1) return true;
  // J19 (Month 9 Corporation tax)
  if (rowNum === 19 && colIdx === 9) return true;

  // Table 2 Pipeline Overrides
  // B61 (Table 2 Month 1 Corporation tax)
  if (rowNum === 61 && colIdx === 1) return true;
  // B63 (Table 2 Month 1 VAT)
  if (rowNum === 63 && colIdx === 1) return true;
  // J61 (Table 2 Month 9 Corporation tax)
  if (rowNum === 61 && colIdx === 9) return true;

  // 2. Table 1 Adjustment Rows (All months, Col B onwards)
  // Rows: 7, 9, 11, 13, 15, 17, 20, 22, 25, 27, 29, 30
  const adjustmentRows = [7, 9, 11, 13, 15, 17, 20, 22, 25, 27, 29, 30];
  if (adjustmentRows.includes(rowNum)) return true;

  // 3. Actual Closing Balance Row (Row 36, all months)
  if (rowNum === 36) return true;

  return false;
}

/**
 * Fetch 36 months of data from Cash!A1:AK76
 */
export async function fetchCashData(clientName, clientSheetId, bypassCache = false) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");

  const cleanId = String(clientSheetId).trim();
  const cacheKey = `pma_cash_${cleanId}`;

  if (!bypassCache) {
    try {
      if (redisClient?.isOpen) {
        const cached = await redisClient.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } else {
        const mem = memoryCache.get(cacheKey);
        if (mem) return mem;
      }
    } catch (e) {
      console.warn("Cash cache read error:", e?.message);
    }
  }

  const sheets = await getSheetsClient();

  // Fetch Cash!A1:AK76 with values, formulas, notes, and effective formats (shading)
  const res = await withRetry(async () => {
    return await sheets.spreadsheets.get({
      spreadsheetId: cleanId,
      ranges: ["Cash!A1:AK76"],
      fields: "sheets(properties(title,sheetId),data.rowData.values(formattedValue,userEnteredValue,note,effectiveFormat(backgroundColor,textFormat)))",
    });
  });

  const cashSheet = res.data?.sheets?.find((s) => s.properties?.title === "Cash") || res.data?.sheets?.[0];
  const rowData = cashSheet?.data?.[0]?.rowData || [];

  if (!rowData.length) {
    throw new Error("Cash sheet is empty or not found in client spreadsheet.");
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
        const formattedValue = cellData?.formattedValue !== undefined && cellData?.formattedValue !== null
          ? String(cellData.formattedValue).trim()
          : "";
        const formula = cellData?.userEnteredValue?.formulaValue || "";
        const note = cellData?.note || "";
        const isEditable = isCashCellEditable(r, m.colIdx);
        const bgColor = colorToCss(cellData?.effectiveFormat?.backgroundColor);
        const cellBold = Boolean(cellData?.effectiveFormat?.textFormat?.bold);

        return {
          sheetRow: r,
          colIdx: m.colIdx,
          colLetter: m.colLetter,
          cellRef: `${m.colLetter}${r}`,
          formattedValue,
          formula,
          note,
          isEditable,
          bgColor,
          isBold: cellBold,
        };
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
    clientName,
    clientSheetId: cleanId,
    monthCols,
    previousMonthColIdx,
    currentMonthColIdx,
    table1Rows,
    table2Rows,
    lastUpdated: new Date().toISOString(),
  };

  try {
    const payload = JSON.stringify(result);
    if (redisClient?.isOpen) {
      await redisClient.setEx(cacheKey, 60, payload);
    } else {
      memoryCache.set(cacheKey, result, 60);
    }
  } catch (e) {
    console.warn("Cash cache write error:", e?.message);
  }

  return result;
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
}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");
  const cleanId = String(clientSheetId).trim();
  const sheets = await getSheetsClient();

  const validValueUpdates = [];
  for (const up of updates) {
    const rowNum = parseInt(up.sheetRow, 10);
    const colIdx = up.colIdx !== undefined ? parseInt(up.colIdx, 10) : colLetterToNum(up.colLetter) - 1;
    const colLetter = up.colLetter || colIdxToLetter(colIdx);

    if (!isCashCellEditable(rowNum, colIdx)) {
      console.warn(`[Cash Save] Skipped protected cell Cash!${colLetter}${rowNum}`);
      continue;
    }

    const cleanVal = sanitizeCashAdjustmentInput(String(up.value ?? "").trim());
    validValueUpdates.push({
      range: `Cash!${colLetter}${rowNum}`,
      values: [[cleanVal]],
      rowNum,
      colLetter,
      value: cleanVal,
    });
  }

  // Execute value batch update
  if (validValueUpdates.length > 0) {
    await withRetry(async () => {
      return await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: cleanId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: validValueUpdates.map((v) => ({
            range: v.range,
            values: v.values,
          })),
        },
      });
    });
  }

  // Update notes if provided (allowed for any cell Col B onwards)
  const validNoteRequests = [];
  if (cellNotes && Array.isArray(cellNotes) && cellNotes.length > 0) {
    const gid = await getSheetGid(sheets, cleanId, "Cash");
    for (const cn of cellNotes) {
      const rowNum = parseInt(cn.sheetRow, 10);
      const colIdx = cn.colIdx !== undefined ? parseInt(cn.colIdx, 10) : colLetterToNum(cn.colLetter) - 1;
      if (colIdx < 1) continue; // Skip column A

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
          requestBody: {
            requests: validNoteRequests,
          },
        });
      });
    }
  }

  // Invalidate caches
  try {
    const cacheKey = `pma_cash_${cleanId}`;
    const portalKey = `pulse:portal:cash:${cleanId}`;
    if (redisClient?.isOpen) {
      await Promise.all([redisClient.del(cacheKey), redisClient.del(portalKey)]);
    } else {
      memoryCache.delete(cacheKey);
      memoryCache.delete(portalKey);
    }
  } catch {}

  // Log activity
  if (validValueUpdates.length > 0 || validNoteRequests.length > 0) {
    const changeSummary = [];
    if (validValueUpdates.length > 0) {
      changeSummary.push(`${validValueUpdates.length} cell${validValueUpdates.length > 1 ? "s" : ""}`);
    }
    if (validNoteRequests.length > 0) {
      changeSummary.push(`${validNoteRequests.length} note${validNoteRequests.length > 1 ? "s" : ""}`);
    }

    await logPmaActivity({
      userEmail: userEmail || "system",
      action: "UPDATE_CASH_CELLS",
      clientName: clientName || "Client",
      details: `Updated ${changeSummary.join(" and ")} on Cash tab`,
      automationCommanderSheetId,
    });
  }

  return {
    success: true,
    savedValuesCount: validValueUpdates.length,
    savedNotesCount: validNoteRequests.length,
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
  const cleanId = String(clientSheetId).trim();
  const rowNum = parseInt(sheetRow, 10);
  const finalColIdx = colIdx !== undefined ? parseInt(colIdx, 10) : colLetterToNum(colLetter) - 1;
  const finalColLetter = colLetter || colIdxToLetter(finalColIdx);

  if (finalColIdx < 1) {
    throw new Error("Notes can only be added from Column B onwards.");
  }

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
    const cacheKey = `pma_cash_${cleanId}`;
    const portalKey = `pulse:portal:cash:${cleanId}`;
    if (redisClient?.isOpen) {
      await Promise.all([redisClient.del(cacheKey), redisClient.del(portalKey)]);
    } else {
      memoryCache.delete(cacheKey);
      memoryCache.delete(portalKey);
    }
  } catch {}

  await logPmaActivity({
    userEmail: userEmail || "system",
    action: "UPDATE_CASH_NOTE",
    clientName: clientName || "Client",
    details: `${cleanNote ? "Updated" : "Cleared"} note on Cash!${finalColLetter}${rowNum}`,
    automationCommanderSheetId,
  });

  return {
    success: true,
    cellRef: `${finalColLetter}${rowNum}`,
    sheetRow: rowNum,
    colIdx: finalColIdx,
    note: cleanNote,
  };
}
