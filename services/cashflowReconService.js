import { getSheetsClient, withRetry, colLetterToNum, extractSheetIdFromUrl } from "./sheetsClient";
import { resolveClientNameBySheetId } from "./workspaces";
import { logPmaActivity } from "./pmaLogger";
import { parseMonthHeader, FULL_MONTH_NAMES } from "./viewsService";
import { sanitizeFormulaInput } from "./userPermissions";


// Google Sheets light green 3 (used on Incredibble Cash tab)
const RESOLVED_GREEN_RGB = { red: 0.8509804, green: 0.91764706, blue: 0.827451 };
const WHITE_RGB = { red: 1, green: 1, blue: 1 };

function isGreenShaded(rgb) {
  if (!rgb) return false;
  const r = rgb.red ?? 0;
  const g = rgb.green ?? 0;
  const b = rgb.blue ?? 0;
  return g > 0.85 && r < 0.92 && b < 0.92 && g > r && g > b;
}

function parseNumeric(val) {
  if (typeof val === "number") return val;
  if (!val) return 0;
  const clean = String(val).replace(/[£,\s]/g, "");
  const num = parseFloat(clean);
  return isNaN(num) ? 0 : num;
}

function colorToCss(rgbColor) {
  if (!rgbColor) return null;
  const r = Math.round((rgbColor.red ?? 0) * 255);
  const g = Math.round((rgbColor.green ?? 0) * 255);
  const b = Math.round((rgbColor.blue ?? 0) * 255);
  if (r === 255 && g === 255 && b === 255) return null;
  const a = rgbColor.alpha !== undefined ? rgbColor.alpha : 1;
  return a < 1 ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`;
}

function borderToCss(border) {
  if (!border || !border.style || border.style === "NONE") return null;
  const col = colorToCss(border.color) || "#d0d0d0";
  switch (border.style) {
    case "DOUBLE": return `3px double ${col}`;
    case "SOLID_THICK": return `2px solid ${col}`;
    case "SOLID_MEDIUM": return `2px solid ${col}`;
    case "DASHED": return `1px dashed ${col}`;
    case "SOLID":
    default: return `1px solid ${col}`;
  }
}

export function colIndexToLetter(colNum) {
  let letter = "";
  let n = colNum;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/**
 * Get Cashflow Recon Data
 * Fetches the 3 months around the target month from Cash tab (Row 1 down to Difference row)
 * and retrieves actuals from Recon sheet U3:X16.
 */
export async function getCashflowReconData({
  clientSheetId,
  reconSheetUrl,
  reconSheetId,
  eomMonthKey // e.g. "2026-09" (Work month in Sept -> target month is Aug 2026)
}) {
  if (!clientSheetId) throw new Error("Missing clientSheetId");

  const sheets = await getSheetsClient();
  const cleanClientSheetId = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const cleanReconSheetId = reconSheetId || extractSheetIdFromUrl(reconSheetUrl);

  // 1. Calculate Target Month, Month Before, and Month After
  let targetYear, targetMonth; // 0-indexed month
  if (eomMonthKey && /^\d{4}-\d{2}$/.test(eomMonthKey)) {
    const [y, m] = eomMonthKey.split("-").map(Number);
    // Work month (e.g. Sept 2026) targets previous month (August 2026)
    const targetDate = new Date(y, m - 2, 1);
    targetYear = targetDate.getFullYear();
    targetMonth = targetDate.getMonth();
  } else {
    const now = new Date();
    const targetDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    targetYear = targetDate.getFullYear();
    targetMonth = targetDate.getMonth();
  }

  const prevDate = new Date(targetYear, targetMonth - 1, 1);
  const nextDate = new Date(targetYear, targetMonth + 1, 1);

  const prevMonthInfo = { year: prevDate.getFullYear(), month: prevDate.getMonth() };
  const targetMonthInfo = { year: targetYear, month: targetMonth };
  const nextMonthInfo = { year: nextDate.getFullYear(), month: nextDate.getMonth() };

  // Recon tab name format: YYMM e.g. "2608"
  const reconTabName = `${String(targetYear).slice(-2)}${String(targetMonth + 1).padStart(2, "0")}`;

  // 2. Fetch Cash tab from Client Sheet
  const FIELDS = "sheets(properties(sheetId,title),data.rowData.values(formattedValue,note,userEnteredValue,effectiveFormat(backgroundColor,textFormat(bold,italic,foregroundColor),horizontalAlignment,borders)))";
  const res = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: cleanClientSheetId,
    ranges: ["Cash!A1:AK45"],
    fields: FIELDS,
  }));

  const cashSheet = res.data.sheets.find(s => s.properties.title === "Cash") || res.data.sheets[0];
  const cashTabSheetId = cashSheet?.properties?.sheetId ?? 0;
  const rowData = cashSheet?.data?.[0]?.rowData || [];

  if (rowData.length === 0) {
    throw new Error("Cash tab is empty or not found in client spreadsheet");
  }

  // Row 0: Headers
  const row0 = (rowData[0]?.values || []).map(c => c?.formattedValue || "");

  // Find column indices for prev, target, next months
  let prevColIdx = -1;
  let targetColIdx = -1;
  let nextColIdx = -1;

  for (let c = 1; c < row0.length; c++) {
    const parsed = parseMonthHeader(row0[c]);
    if (parsed) {
      if (parsed.year === prevMonthInfo.year && parsed.month === prevMonthInfo.month) {
        prevColIdx = c;
      }
      if (parsed.year === targetMonthInfo.year && parsed.month === targetMonthInfo.month) {
        targetColIdx = c;
      }
      if (parsed.year === nextMonthInfo.year && parsed.month === nextMonthInfo.month) {
        nextColIdx = c;
      }
    }
  }

  // Fallback if exact columns not found: default to rolling first 3 data columns
  if (targetColIdx === -1 && row0.length > 2) {
    targetColIdx = 2;
    prevColIdx = 1;
    nextColIdx = 3 < row0.length ? 3 : -1;
  }

  const selectedCols = [
    { colIdx: prevColIdx, colLetter: prevColIdx >= 0 ? colIndexToLetter(prevColIdx + 1) : "", label: row0[prevColIdx] || "Prev Month", type: "prev" },
    { colIdx: targetColIdx, colLetter: targetColIdx >= 0 ? colIndexToLetter(targetColIdx + 1) : "", label: row0[targetColIdx] || "Target Month", type: "target" },
    { colIdx: nextColIdx, colLetter: nextColIdx >= 0 ? colIndexToLetter(nextColIdx + 1) : "", label: row0[nextColIdx] || "Next Month", type: "next" },
  ].filter(c => c.colIdx >= 0);

  // 3. Find Difference row boundary (Row 1 down to Difference row)
  let differenceRowIndex = -1;
  for (let r = 1; r < rowData.length; r++) {
    const label = String(rowData[r]?.values?.[0]?.formattedValue || "").trim().toLowerCase();
    if (label === "difference") {
      differenceRowIndex = r;
      break;
    }
  }

  // If difference row not explicitly found, default to row 36 (row 37 1-indexed)
  if (differenceRowIndex === -1) {
    differenceRowIndex = Math.min(36, rowData.length - 1);
  }

  // Build top section matrix (Row 1 "Excluding pipeline" down to differenceRowIndex)
  const rows = [];
  for (let rIdx = 1; rIdx <= differenceRowIndex; rIdx++) {
    const rowValues = rowData[rIdx]?.values || [];
    const labelCell = rowValues[0];
    const labelText = String(labelCell?.formattedValue || "").trim();

    // Check if adjustment row
    const lowerLabel = labelText.toLowerCase();
    const isAdjustmentRow = lowerLabel.includes("adjustment") || lowerLabel === "other cash movements";
    
    // Check if non-adjustment mapped row
    const isConfirmedCash = lowerLabel.includes("confirmed cash incoming");
    const isSalaries = lowerLabel === "salaries outgoing" || lowerLabel.includes("salaries outgoing");
    const isDividends = lowerLabel.includes("dividends as salary");
    const isContractors = lowerLabel.includes("contractors outgoing");
    const isDirectCosts = lowerLabel.includes("direct costs outgoing");
    const isOtherExpenses = lowerLabel.includes("other expenses outgoing");

    let mappedItemType = null;
    let targetAdjustmentRow = null;
    if (isConfirmedCash) {
      mappedItemType = "confirmed_cash";
      targetAdjustmentRow = 29; // Other cash movements
    } else if (isSalaries) {
      mappedItemType = "salaries";
      targetAdjustmentRow = 9; // Salaries adjustment
    } else if (isDividends) {
      mappedItemType = "dividends";
      targetAdjustmentRow = 11; // Dividends as salary adjustment
    } else if (isContractors) {
      mappedItemType = "contractors";
      targetAdjustmentRow = 13; // Contractors adjustment
    } else if (isDirectCosts) {
      mappedItemType = "direct_costs";
      targetAdjustmentRow = 15; // Direct costs adjustment
    } else if (isOtherExpenses) {
      mappedItemType = "other_expenses";
      targetAdjustmentRow = 17; // Other expenses adjustment
    }

    const parsedCells = selectedCols.map(col => {
      const cell = rowValues[col.colIdx];
      if (!cell) {
        return {
          v: "",
          sheetRow: rIdx + 1,
          colLetter: col.colLetter,
          colIdx: col.colIdx,
          isResolved: false
        };
      }

      const fmt = cell.effectiveFormat || {};
      const bg = colorToCss(fmt.backgroundColor);
      const isResolved = isGreenShaded(fmt.backgroundColor);
      const tf = fmt.textFormat || {};
      const align = fmt.horizontalAlignment ? fmt.horizontalAlignment.toLowerCase() : null;

      const rawVal = cell.userEnteredValue?.formulaValue ??
                     cell.userEnteredValue?.numberValue ??
                     cell.userEnteredValue?.stringValue ??
                     null;

      return {
        v: cell.formattedValue ?? "",
        rawVal,
        note: cell.note || "",
        bg,
        isResolved,
        b: tf.bold || false,
        i: tf.italic || false,
        c: colorToCss(tf.foregroundColor),
        a: align,
        bt: borderToCss(fmt.borders?.top),
        bb: borderToCss(fmt.borders?.bottom),
        sheetRow: rIdx + 1,
        colLetter: col.colLetter,
        colIdx: col.colIdx,
      };
    });

    const isHeaderRow = rIdx === 0;
    const isDifferenceRow = rIdx === differenceRowIndex;

    rows.push({
      sheetRow: rIdx + 1,
      rIdx,
      label: labelText,
      isHeaderRow,
      isDifferenceRow,
      isAdjustmentRow,
      mappedItemType,
      targetAdjustmentRow,
      cells: parsedCells
    });
  }

  // 4. Fetch Recon Sheet Actuals (U3:X16)
  let reconActuals = null;
  let reconError = null;
  let availableReconTabs = [];

  if (cleanReconSheetId) {
    try {
      // Check tabs in Recon sheet
      const reconMeta = await withRetry(() => sheets.spreadsheets.get({
        spreadsheetId: cleanReconSheetId,
        fields: "sheets.properties.title"
      }));
      availableReconTabs = (reconMeta.data.sheets || []).map(s => s.properties.title);

      const hasTargetTab = availableReconTabs.includes(reconTabName);
      if (!hasTargetTab) {
        reconError = `Recon tab '${reconTabName}' not found in Recon Sheet (available tabs: ${availableReconTabs.filter(t => /^\d{4}$/.test(t)).join(", ") || "none"})`;
      } else {
        const reconData = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: cleanReconSheetId,
          range: `'${reconTabName}'!U3:X16`,
          valueRenderOption: "UNFORMATTED_VALUE"
        }));

        const rawReconRows = reconData.data.values || [];
        let revenue = 0;
        let salaries = 0;
        let dividends = 0;
        let contractors = 0;
        let directCosts = 0;
        let outgoings = 0;

        rawReconRows.forEach(r => {
          const label = String(r[0] || "").trim().toLowerCase();
          const val = parseNumeric(r[3]); // Column X (Total)
          if (label.includes("revenue")) {
            revenue += val;
          } else if (label.includes("salaries") || label.includes("salary") || label.includes("paye") || label.includes("pension")) {
            salaries += val;
          } else if (label.includes("dividend")) {
            dividends += val;
          } else if (label.includes("contractor")) {
            contractors += val;
          } else if (label.includes("direct cost")) {
            directCosts += val;
          } else if (label.includes("outgoing")) {
            outgoings += val;
          }
        });

        reconActuals = {
          revenue,
          salaries,
          dividends,
          contractors,
          directCosts,
          outgoings,
          tabName: reconTabName
        };
      }
    } catch (err) {
      console.warn(`⚠️ Recon sheet fetch failed for ${cleanReconSheetId}:`, err.message);
      if (err.message && err.message.includes("does not have permission")) {
        reconError = "Recon sheet permission required: please grant Viewer access to alert-triage-backend@automation-commander.iam.gserviceaccount.com";
      } else {
        reconError = err.message;
      }
    }
  } else {
    reconError = "No Recon Sheet configured in AutoUpdates for this client";
  }

  return {
    success: true,
    clientSheetId: cleanClientSheetId,
    cashTabSheetId,
    reconSheetId: cleanReconSheetId,
    targetMonthLabel: `${FULL_MONTH_NAMES[targetMonthInfo.month]} ${targetMonthInfo.year}`,
    targetMonthKey: `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}`,
    reconTabName,
    selectedCols,
    rows,
    reconActuals,
    reconError,
    availableReconTabs
  };
}

/**
 * Update an adjustment cell in the Client Sheet Cash tab
 */
export async function updateCashAdjustment({
  clientSheetId,
  colLetter,
  sheetRow,
  value,
  clientName,
  automationCommanderSheetId
}) {
  if (!clientSheetId || !colLetter || !sheetRow) {
    throw new Error("Missing clientSheetId, colLetter, or sheetRow");
  }

  const sheets = await getSheetsClient();
  const cleanClientSheetId = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const rowNum = parseInt(sheetRow, 10);
  const cellRange = `Cash!${colLetter}${rowNum}`;

  const safeValue = sanitizeFormulaInput(value ?? "");

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: cleanClientSheetId,
    range: cellRange,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[safeValue]] }
  }));

  // Fetch updated formatted value
  let formattedValue = value ?? "";
  try {
    const getRes = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanClientSheetId,
      range: cellRange,
      valueRenderOption: "FORMATTED_VALUE"
    }));
    formattedValue = getRes.data.values?.[0]?.[0] ?? formattedValue;
  } catch (e) {
    console.warn("Could not fetch formatted cell value:", e);
  }

  let resolvedClient = clientName || "";
  if (!resolvedClient) {
    resolvedClient = await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId);
  }

  logPmaActivity(sheets, {
    automationCommanderSheetId,
    clientName: resolvedClient,
    category: "CASH_RECON",
    action: "Cash Adjustment Updated",
    summary: `Updated Cash adjustment cell ${cellRange} to ${formattedValue}`,
    details: {
      tab: "Cash",
      cellRef: `${colLetter}${rowNum}`,
      sheetRow: rowNum,
      colLetter,
      newValue: formattedValue,
      clientName: resolvedClient
    }
  }).catch(e => console.error("PMA log failed:", e));

  return { success: true, cellRef: `${colLetter}${rowNum}`, formattedValue };
}

/**
 * Toggle "Mark Resolved" on a Cash cell (light green background #d9ead3)
 */
export async function toggleCashCellResolved({
  clientSheetId,
  cashTabSheetId,
  sheetRow,
  colIdx,
  resolved, // boolean: true to resolve (green), false to un-resolve (white)
  clientName,
  automationCommanderSheetId
}) {
  if (!clientSheetId || !sheetRow || colIdx === undefined) {
    throw new Error("Missing clientSheetId, sheetRow, or colIdx");
  }

  const sheets = await getSheetsClient();
  const cleanClientSheetId = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const rowNum = parseInt(sheetRow, 10);
  const colIndex = parseInt(colIdx, 10);
  const targetBg = resolved ? RESOLVED_GREEN_RGB : WHITE_RGB;

  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cleanClientSheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: cashTabSheetId,
            startRowIndex: rowNum - 1,
            endRowIndex: rowNum,
            startColumnIndex: colIndex,
            endColumnIndex: colIndex + 1,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: targetBg
            }
          },
          fields: "userEnteredFormat.backgroundColor"
        }
      }]
    }
  }));

  const colLetter = colIndexToLetter(colIndex + 1);
  let resolvedClient = clientName || "";
  if (!resolvedClient) {
    resolvedClient = await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId);
  }

  logPmaActivity(sheets, {
    automationCommanderSheetId,
    clientName: resolvedClient,
    category: "CASH_RECON",
    action: resolved ? "Cash Cell Marked Resolved" : "Cash Cell Unmarked Resolved",
    summary: `${resolved ? "Marked resolved" : "Unmarked resolved"} on Cash!${colLetter}${rowNum}`,
    details: {
      tab: "Cash",
      cellRef: `${colLetter}${rowNum}`,
      sheetRow: rowNum,
      colIndex,
      resolved,
      clientName: resolvedClient
    }
  }).catch(e => console.error("PMA log failed:", e));

  return { success: true, cellRef: `${colLetter}${rowNum}`, resolved };
}

/**
 * View, Add, or Edit a cell note in the Client Sheet Cash tab
 */
export async function updateCashCellNote({
  clientSheetId,
  cashTabSheetId,
  sheetRow,
  colIdx,
  note,
  clientName,
  automationCommanderSheetId
}) {
  if (!clientSheetId || !sheetRow || colIdx === undefined) {
    throw new Error("Missing clientSheetId, sheetRow, or colIdx");
  }

  const sheets = await getSheetsClient();
  const cleanClientSheetId = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const rowNum = parseInt(sheetRow, 10);
  const colIndex = parseInt(colIdx, 10);

  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cleanClientSheetId,
    requestBody: {
      requests: [{
        updateCells: {
          range: {
            sheetId: cashTabSheetId,
            startRowIndex: rowNum - 1,
            endRowIndex: rowNum,
            startColumnIndex: colIndex,
            endColumnIndex: colIndex + 1,
          },
          rows: [{
            values: [{
              note: note || ""
            }]
          }],
          fields: "note"
        }
      }]
    }
  }));

  const colLetter = colIndexToLetter(colIndex + 1);
  let resolvedClient = clientName || "";
  if (!resolvedClient) {
    resolvedClient = await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId);
  }

  logPmaActivity(sheets, {
    automationCommanderSheetId,
    clientName: resolvedClient,
    category: "CASH_RECON",
    action: "Cash Cell Note Updated",
    summary: `Updated note on Cash!${colLetter}${rowNum}: "${note || ""}"`,
    details: {
      tab: "Cash",
      cellRef: `${colLetter}${rowNum}`,
      sheetRow: rowNum,
      colIndex,
      note,
      clientName: resolvedClient
    }
  }).catch(e => console.error("PMA log failed:", e));

  return { success: true, cellRef: `${colLetter}${rowNum}`, note };
}
