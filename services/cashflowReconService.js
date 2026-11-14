import { getSheetsClient, withRetry, colLetterToNum, extractSheetIdFromUrl, getSheetGid } from "./sheetsClient.js";
import { resolveClientNameBySheetId } from "./workspaces.js";
import { logPmaActivity } from "./pmaLogger.js";
import { parseMonthHeader, FULL_MONTH_NAMES } from "./viewsService.js";
import { sanitizeFormulaInput } from "./userPermissions.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import { matchesClientName } from "./userPermissions.js";


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

function formatGBP(num) {
  if (num == null || isNaN(num)) return "£0.00";
  const sign = num < 0 ? "-" : "";
  return `${sign}£${Math.abs(num).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
 * Securely sanitizes cash adjustment inputs before updating Google Sheets.
 * If the input is an arithmetic expression or formula (=1234-E19, =E19+100, =SUM(...)),
 * it validates that it does NOT contain dangerous functions (IMPORT*, HYPERLINK, WEBSERVICE, etc.)
 * or DDE / shell injection commands.
 * If safe, returns the formula as-is so Google Sheets calculates it.
 * If it contains dangerous or unrecognized tokens, it neutralizes it with a leading quote '.
 */
export function sanitizeCashAdjustmentInput(val) {
  if (val === null || val === undefined) return "";
  let str = String(val).trim();
  if (!str) return "";

  // If input has an accidental leading apostrophe before a formula, strip it for evaluation
  if (/^['’]=/.test(str)) {
    str = str.replace(/^['’]=/, "=").trim();
  }

  // 1. Valid finite numbers are always safe
  if (!isNaN(Number(str))) return str;

  // 2. If it begins with '=', validate if it's a safe spreadsheet formula
  if (str.startsWith("=")) {
    // Length safety check
    if (str.length > 500) {
      return `'${str}`;
    }

    // Sanctioned Recon IMPORTRANGE formula for Other Expenses adjustment (e.g. =IMPORTRANGE(KeyInfo!$G$1, "'2610'!X4")-H16)
    if (/^=IMPORTRANGE\(\s*KeyInfo!\$G\$1\s*,\s*"'[0-9]{4}'!X[0-9]+"\s*\)\s*-\s*\$?[A-Z]{1,2}\$?[0-9]+$/i.test(str)) {
      return str;
    }

    // Strictly forbid dangerous exfiltration / external execution keywords
    const dangerousPattern = /(importxml|importhtml|importdata|importfeed|importrange|hyperlink|image|webservice|encodeurl|cmd|powershell|exec|script|shell|http:|https:|ftp:|file:)/i;
    if (dangerousPattern.test(str)) {
      return `'${str}`;
    }

    // Strictly forbid cross-sheet references (!) or shell pipe, semicolons, backticks
    if (/[!|;`]/.test(str)) {
      return `'${str}`;
    }

    // Validate that the formula only contains safe arithmetic, same-sheet cell coordinates, and safe math functions
    let stripped = str.slice(1);
    // Strip allowed function names
    stripped = stripped.replace(/\b(SUM|ROUND|ABS|MIN|MAX|AVERAGE|SUBTOTAL|IF|INT)\s*\(/gi, "(");
    // Validate that any cell coordinate only references valid Cash tab columns (B..AK) and rows (1..76)
    const cellTokens = stripped.match(/\$?[A-Z]+\$?[0-9]+/gi) || [];
    for (const tok of cellTokens) {
      if (!/^\$?(?:[B-Z]|A[A-K])\$?(?:[1-9]|[1-6][0-9]|7[0-6])$/i.test(tok)) {
        return `'${str}`;
      }
    }
    // Strip same-sheet cell coordinates (e.g. E6, $E$6, G6:G10)
    stripped = stripped.replace(/\$?[A-Z]+\$?[0-9]+(:?\$?[A-Z]+\$?[0-9]+)?/gi, "");
    // Strip numbers (integer and decimal)
    stripped = stripped.replace(/[0-9]+(\.[0-9]+)?/g, "");
    // Strip operators, parentheses, commas, whitespace
    stripped = stripped.replace(/[\+\-\*\/\^\%\(\)\,\s]/g, "");

    // If anything remains after stripping allowed components, it is unrecognized -> neutralize it
    if (stripped.length > 0) {
      return `'${str}`;
    }

    // Safe formula! Return as genuine formula for USER_ENTERED
    return str;
  }

  // 3. If starts with +, -, @ but isn't a number or formula, neutralize with leading quote
  if (/^[+\-@]/.test(str)) {
    return `'${str}`;
  }

  return str;
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
  eomMonthKey, // e.g. "2026-10" (Work month in Oct -> target month is Sept 2026)
  targetMonthKey // e.g. "2026-10" (if provided, directly targets this month)
}) {
  if (!clientSheetId) throw new Error("Missing clientSheetId");

  const sheets = await getSheetsClient();
  const cleanClientSheetId = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const cleanReconSheetId = reconSheetId || extractSheetIdFromUrl(reconSheetUrl);

  // 1. Calculate Target Month, Month Before, and Month After
  let targetYear, targetMonth; // 0-indexed month
  if (targetMonthKey && /^\d{4}-\d{2}$/.test(targetMonthKey)) {
    const [y, m] = targetMonthKey.split("-").map(Number);
    const targetDate = new Date(y, m - 1, 1);
    targetYear = targetDate.getFullYear();
    targetMonth = targetDate.getMonth();
  } else if (eomMonthKey && /^\d{4}-\d{2}$/.test(eomMonthKey)) {
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

  // 2. Fetch Cash tab and KeyInfo!B10 (Tax payment method) from Client Sheet
  const FIELDS = "sheets(properties(sheetId,title),data.rowData.values(formattedValue,effectiveValue,note,userEnteredValue,effectiveFormat(backgroundColor,textFormat(bold,italic,foregroundColor),horizontalAlignment,borders)))";
  const res = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: cleanClientSheetId,
    ranges: ["Cash!A1:AK45", "KeyInfo!B10"],
    fields: FIELDS,
  }));

  const cashSheet = res.data.sheets.find(s => s.properties.title === "Cash") || res.data.sheets[0];
  const cashTabSheetId = cashSheet?.properties?.sheetId ?? 0;
  const rowData = cashSheet?.data?.[0]?.rowData || [];

  const keyInfoSheet = res.data.sheets.find(s => s.properties.title === "KeyInfo");
  const taxPaymentMethodRaw = String(keyInfoSheet?.data?.[0]?.rowData?.[0]?.values?.[0]?.formattedValue || "").trim();
  const isTransfersMode = taxPaymentMethodRaw.toLowerCase().startsWith("transfer");

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

  // Pre-scan row labels to locate adjustment rows dynamically across different client layouts
  let incomingCashAdjRow = 7;
  let otherAdjustmentsRow = 30;
  let salariesAdjRow = 9;
  let dividendsAdjRow = 11;
  let contractorsAdjRow = 13;
  let directCostsAdjRow = 15;
  let otherExpensesAdjRow = 17;
  let corpTaxAdjRow = 20;
  let vatAdjRow = 22;
  let nonOpIncomeAdjRow = 25;
  let nonOpExpensesAdjRow = 27;

  for (let r = 0; r < rowData.length; r++) {
    const lbl = String(rowData[r]?.values?.[0]?.formattedValue || "").toLowerCase().trim();
    const sheetNum = r + 1;
    if (lbl.includes("other adjustment")) otherAdjustmentsRow = sheetNum;
    else if ((lbl.includes("cash incoming") || lbl.includes("incoming cash")) && lbl.includes("adjustment")) incomingCashAdjRow = sheetNum;
    else if (lbl.includes("salaries adjustment")) salariesAdjRow = sheetNum;
    else if (lbl.includes("dividends as salary adjustment")) dividendsAdjRow = sheetNum;
    else if (lbl.includes("contractors adjustment")) contractorsAdjRow = sheetNum;
    else if (lbl.includes("direct costs adjustment")) directCostsAdjRow = sheetNum;
    else if (lbl.includes("other expenses adjustment")) otherExpensesAdjRow = sheetNum;
    else if (lbl.includes("corporation tax adjustment")) corpTaxAdjRow = sheetNum;
    else if (lbl.includes("vat adjustment")) vatAdjRow = sheetNum;
    else if (lbl.includes("non-operating income adjustment")) nonOpIncomeAdjRow = sheetNum;
    else if (lbl.includes("non-operating expense") && lbl.includes("adjustment")) nonOpExpensesAdjRow = sheetNum;
  }

  // Build top section matrix (down to differenceRowIndex, excluding pipeline row)
  const rows = [];
  for (let rIdx = 1; rIdx <= differenceRowIndex; rIdx++) {
    const rowValues = rowData[rIdx]?.values || [];
    const labelCell = rowValues[0];
    const labelText = String(labelCell?.formattedValue || "").trim();

    // Check if adjustment row
    const lowerLabel = labelText.toLowerCase();

    // Exclude "Excluding pipeline" row entirely
    if (lowerLabel.includes("excluding pipeline")) {
      continue;
    }

    const isAdjustmentRow = lowerLabel.includes("adjustment");

    // Check if non-adjustment mapped row
    const isConfirmedCash = lowerLabel.includes("confirmed cash incoming");
    const isSalaries = lowerLabel === "salaries outgoing" || lowerLabel.includes("salaries outgoing");
    const isDividends = lowerLabel.includes("dividends as salary");
    const isContractors = lowerLabel.includes("contractors outgoing");
    const isDirectCosts = lowerLabel.includes("direct costs outgoing");
    const isOtherExpenses = lowerLabel.includes("other expenses outgoing");
    const isCorpTax = lowerLabel.includes("corporation tax") && !lowerLabel.includes("adjustment");
    const isVat = (lowerLabel === "vat" || lowerLabel.startsWith("vat ") || lowerLabel.includes(" vat")) && !lowerLabel.includes("adjustment");
    const isNonOpIncome = lowerLabel.includes("non-operating income") && !lowerLabel.includes("adjustment");
    const isNonOpExpenses = lowerLabel.includes("non-operating expense") && !lowerLabel.includes("adjustment");
    const isOtherCashMovements = lowerLabel.includes("other cash movement") && !lowerLabel.includes("adjustment");

    let mappedItemType = null;
    let targetAdjustmentRow = null;
    if (isConfirmedCash) {
      mappedItemType = "confirmed_cash";
      targetAdjustmentRow = incomingCashAdjRow; // Incoming cash adjustment row (row 7)
    } else if (isSalaries) {
      mappedItemType = "salaries";
      targetAdjustmentRow = salariesAdjRow; // Salaries adjustment
    } else if (isDividends) {
      mappedItemType = "dividends";
      targetAdjustmentRow = dividendsAdjRow; // Dividends as salary adjustment
    } else if (isContractors) {
      mappedItemType = "contractors";
      targetAdjustmentRow = contractorsAdjRow; // Contractors adjustment
    } else if (isDirectCosts) {
      mappedItemType = "direct_costs";
      targetAdjustmentRow = directCostsAdjRow; // Direct costs adjustment
    } else if (isOtherExpenses) {
      mappedItemType = "other_expenses";
      targetAdjustmentRow = otherExpensesAdjRow; // Other expenses adjustment
    } else if (isCorpTax) {
      mappedItemType = "corporation_tax";
      targetAdjustmentRow = corpTaxAdjRow; // Corporation tax adjustment
    } else if (isVat) {
      mappedItemType = "vat";
      targetAdjustmentRow = vatAdjRow; // VAT adjustment
    } else if (isNonOpIncome) {
      mappedItemType = "non_operating_income";
      targetAdjustmentRow = nonOpIncomeAdjRow; // Non-operating income adjustment
    } else if (isNonOpExpenses) {
      mappedItemType = "non_operating_expenses";
      targetAdjustmentRow = nonOpExpensesAdjRow; // Non-operating expenses adjustment
    } else if (isOtherCashMovements) {
      mappedItemType = "other_cash_movements";
      targetAdjustmentRow = otherAdjustmentsRow; // Other adjustments (row 30)
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

      const numVal = (typeof cell.effectiveValue?.numberValue === "number")
        ? cell.effectiveValue.numberValue
        : (typeof cell.userEnteredValue?.numberValue === "number" ? cell.userEnteredValue.numberValue : null);

      return {
        v: numVal !== null ? formatGBP(numVal) : (cell.formattedValue ?? ""),
        numVal,
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

  // 4. Fetch Recon Sheet Actuals, Full Transactions, Comparisons & Breakdowns
  let reconActuals = null;
  let reconError = null;
  let availableReconTabs = [];
  let bankTransactions = [];
  let cashflowComparisons = [];
  let revenueBreakdown = { bankItems: [], pulseInvoices: [] };
  let contractorsBreakdown = { bankItems: [], pulseContractors: [] };
  let directCostsBreakdown = { bankItems: [], pulseDirectCosts: [] };
  let unreconciledItems = [];
  let plAdds = [];
  let plAccountOptions = [];
  let trackedBankAccounts = [];
  let trackedNonCashBankAccounts = [];
  let hasTargetTab = false;
  let canAutoCreateTab = false;
  let da1Platform = "Xero";
  let isReconciledComplete = false;

  if (cleanReconSheetId) {
    try {
      // Check tabs in Recon sheet
      const reconMeta = await withRetry(() => sheets.spreadsheets.get({
        spreadsheetId: cleanReconSheetId,
        fields: "sheets.properties.title"
      }));
      availableReconTabs = (reconMeta.data.sheets || []).map(s => s.properties.title);
      hasTargetTab = availableReconTabs.includes(reconTabName);
      canAutoCreateTab = availableReconTabs.includes("Template");

      if (!hasTargetTab) {
        reconError = `Reconciliation period '${reconTabName}' not found (available periods: ${availableReconTabs.filter(t => /^\d{4}$/.test(t)).join(", ") || "none"}). Click 'Create period' to auto-provision.`;
      } else {
        // Fetch all sections in a single batchGet
        const rangesToFetch = [
          `'${reconTabName}'!U3:X16`,    // [0] Totals (categories U3:X16, excludes U17 Total)
          `'${reconTabName}'!A3:Q200`,   // [1] Bank transactions
          `'${reconTabName}'!U20:X65`,   // [2] Comparisons (includes U59 Non-operating income, U62 Non-operating expenses)
          `'${reconTabName}'!Z4:AR60`,   // [3] Revenue breakdown
          `'${reconTabName}'!AT4:BL40`,  // [4] Contractors breakdown
          `'${reconTabName}'!AT48:BK75`, // [5] Direct costs breakdown
          `'${reconTabName}'!CD4:CN60`,  // [6] Unreconciled items
          `'${reconTabName}'!CZ3:DA60`,  // [7] P&L Adds by account & categories
          `'KeyInfo'!H12:H21`,           // [8] Tracked bank accounts (cash, max 10 rows 12-21)
          `'KeyInfo'!H23:I28`,           // [9] Tracked non-cash bank accounts (P&L additions, max 6 rows 23-28)
          `'${reconTabName}'!DA1`,       // [10] Accounting platform toggle (Xero / Quickbooks)
          `'${reconTabName}'!CR1:CR2`    // [11] Month ready & checkbox gate
        ];

        const reconBatchRes = await withRetry(() => sheets.spreadsheets.values.batchGet({
          spreadsheetId: cleanReconSheetId,
          ranges: rangesToFetch,
          valueRenderOption: "FORMATTED_VALUE"
        }));

        const vRanges = reconBatchRes.data.valueRanges || [];

        // Parse [11] CR1:CR2 Month ready & complete gate
        const cr2Raw = vRanges[11]?.values?.[1]?.[0];
        isReconciledComplete = Boolean(cr2Raw === true || String(cr2Raw || "").trim().toUpperCase() === "TRUE");

        // Parse [10] DA1 Accounting platform toggle (Xero / Quickbooks)
        const da1PlatformRaw = String(vRanges[10]?.values?.[0]?.[0] || "").trim();
        da1Platform = da1PlatformRaw.toLowerCase().includes("quick") ? "Quickbooks" : "Xero";

        // Parse [8] Tracked Bank Accounts from KeyInfo!H12:H21 early
        const rawAccounts = vRanges[8]?.values || [];
        trackedBankAccounts = rawAccounts
          .map(r => String(r[0] || "").trim())
          .filter(acc => acc && !acc.toLowerCase().includes("non-cash") && !acc.endsWith(":"));

        // Parse [9] Tracked Non-Cash Bank Accounts from KeyInfo!H23:I28
        const rawNonCashAccounts = vRanges[9]?.values || [];
        trackedNonCashBankAccounts = rawNonCashAccounts
          .map(r => ({
            name: String(r[0] || "").trim(),
            id: String(r[1] || "").trim()
          }))
          .filter(a => a.name && !a.name.toLowerCase().includes("non-cash bank accounts") && !a.name.endsWith(":"));

        // Parse [0] U3:X16 Totals
        const rawReconRows = vRanges[0]?.values || [];
        let revenue = 0, salaries = 0, dividends = 0, contractors = 0, directCosts = 0, outgoings = 0, vat = 0, corpTax = 0, transfer = 0, nonOperatingIncome = 0, nonOperatingExpenses = 0, other = 0;

        rawReconRows.forEach(r => {
          const label = String(r[0] || "").trim().toLowerCase();
          if (!label || label === "total") return;
          const val = parseNumeric(r[3]); // Column X (Total)
          if (label.includes("non-operating income")) nonOperatingIncome += val;
          else if (label.includes("non-operating expense")) nonOperatingExpenses += val;
          else if (label.includes("revenue")) revenue += val;
          else if (label.includes("salaries") || label.includes("salary") || label.includes("paye") || label.includes("pension")) salaries += val;
          else if (label.includes("dividend")) dividends += val;
          else if (label.includes("contractor")) contractors += val;
          else if (label.includes("direct cost")) directCosts += val;
          else if (label.includes("outgoing")) outgoings += val;
          else if (label.includes("transfer")) transfer += val;
          else if (label.includes("vat")) vat += val;
          else if (label.includes("corp") || label.includes("corporation tax") || (label.includes("tax") && !label.includes("vat"))) corpTax += val;
          else if (label === "other" || (label.includes("other") && !label.includes("outgoing") && !label.includes("expense"))) other += val;
        });

        reconActuals = {
          revenue,
          salaries,
          dividends,
          contractors,
          directCosts,
          outgoings,
          vat,
          corpTax,
          transfer,
          nonOperatingIncome,
          nonOperatingExpenses,
          other,
          tabName: reconTabName
        };

        // Fetch row background colors for B3:B200 to detect newly imported transactions
        let txColorData = [];
        try {
          const colorResp = await withRetry(() => sheets.spreadsheets.get({
            spreadsheetId: cleanReconSheetId,
            ranges: [`'${reconTabName}'!B3:B200`],
            fields: "sheets.data.rowData.values.effectiveFormat.backgroundColor"
          }));
          txColorData = colorResp.data.sheets?.[0]?.data?.[0]?.rowData || [];
        } catch (colorErr) {
          console.warn("Could not fetch bank transaction row colors:", colorErr.message);
        }

        // Parse [1] Bank Transactions A3:Q200
        const rawTxRows = vRanges[1]?.values || [];
        bankTransactions = rawTxRows.map((r, i) => {
          const date = r[1] || r[0] || "";
          let accountName = String(r[2] || "").trim(); // Column C
          const payee = r[3] || r[4] || "";
          const particulars = r[4] || "";
          const ref = r[6] || r[5] || "";
          const outAmt = r[8] || "";
          const inAmt = r[9] || "";
          const category = r[16] || "";

          // Check if row has light green fill indicating a newly imported item
          const bgRgb = txColorData[i]?.values?.[0]?.effectiveFormat?.backgroundColor;
          const isNew = isGreenShaded(bgRgb);

          // Fallback heuristic: If accountName is empty in Column C, infer from trackedBankAccounts
          if (!accountName && trackedBankAccounts.length > 0) {
            const combined = `${payee} ${particulars} ${ref}`.toLowerCase();
            const matched = trackedBankAccounts.find(acc => combined.includes(acc.toLowerCase()));
            if (matched) {
              accountName = matched;
            } else if (trackedBankAccounts.length === 1) {
              accountName = trackedBankAccounts[0];
            } else {
              const primary = trackedBankAccounts.find(acc => acc.toLowerCase().includes("primary"));
              accountName = primary || trackedBankAccounts[0];
            }
          }

          // Safe exclusion of internal pot transfers within the same bank account:
          // The transfers setting works with EXTERNAL bank accounts. ALL pot transfers within the same bank account are excluded.
          const isSubPot = accountName && (
            payee.toLowerCase().startsWith(accountName.toLowerCase() + ":") ||
            particulars.toLowerCase().startsWith(accountName.toLowerCase() + ":") ||
            (accountName.includes(" ") && (payee.toLowerCase().startsWith(accountName.toLowerCase() + " - ") || particulars.toLowerCase().startsWith(accountName.toLowerCase() + " - ")))
          );
          if (isSubPot) {
            return null;
          }

          return {
            rowNum: i + 3,
            date,
            accountName,
            payee,
            particulars,
            reference: ref,
            outAmount: outAmt,
            inAmount: inAmt,
            category: category.trim(),
            isReconciled: true,
            isNew,
            source: "recon_sheet"
          };
        }).filter(t => t && (t.date || t.payee || t.outAmount || t.inAmount));

        // Parse [2] Comparisons from U3:X16 (Categories) + U20:X50 (Forecasts)
        const rawCompRows = vRanges[2]?.values || [];

        const isFormulaError = (val) => {
          if (val == null) return false;
          const s = String(val).trim();
          return s.startsWith("#") || s === "—";
        };

        const mapCategoryToForecast = (catName, compRows) => {
          const norm = catName.toLowerCase().trim();
          const hasPayrollRow = (compRows || []).some(cr => String(cr[0] || "").toLowerCase().includes("payroll") || String(cr[1] || "").toLowerCase().includes("payroll"));

          for (let i = 0; i < compRows.length; i++) {
            const row = compRows[i];
            const rLabel = String(row[0] || "").trim().toLowerCase();
            const rSub = String(row[1] || "").trim().toLowerCase();
            let matches = false;
            if (norm === "revenue" && rLabel.includes("revenue")) matches = true;
            else if (norm === "contractors" && rLabel.includes("contractor")) matches = true;
            else if (norm === "direct costs" && rLabel.includes("direct cost")) matches = true;
            else if (norm === "dividends" && rLabel.includes("dividend")) matches = true;
            else if (norm === "salaries") {
              if (rSub.includes("payroll") || rLabel.includes("payroll")) matches = true;
              else if (!hasPayrollRow && rLabel.includes("salar") && !rSub) matches = true;
            }
            else if (norm === "paye" && (rSub.includes("paye") || rLabel.includes("paye"))) matches = true;
            else if (norm === "pension" && (rSub.includes("pension") || rLabel.includes("pension"))) matches = true;
            else if (norm === "outgoings" && (rLabel.includes("other exp") || rLabel.includes("outgoing") || rLabel.includes("overhead"))) matches = true;
            else if (norm === "corp tax" && (rLabel.includes("corp") || rLabel.includes("tax"))) matches = true;
            else if (norm === "vat" && rLabel.includes("vat")) matches = true;
            else if (norm.includes("non-operating income") && rLabel.includes("non-operating income")) matches = true;
            else if (norm.includes("non-operating expense") && rLabel.includes("non-operating expense")) matches = true;
            else if (norm === "other" && (rLabel === "other" || rSub === "other" || (rLabel.includes("other") && !rLabel.includes("other exp")))) matches = true;

            if (matches && row[2]) {
              const forecastVal = String(row[2]).trim();
              const diffVal = (i + 1 < compRows.length && !compRows[i + 1][0] && !compRows[i + 1][1]) ? String(compRows[i + 1][3] || "").trim() : "";
              return { cashflow: forecastVal, diff: diffVal };
            }
          }
          return { cashflow: "£0.00", diff: "£0.00" };
        };

        const canonicalCategories = [
          "Revenue", "Outgoings", "Contractors", "Direct costs", "Dividends",
          "Salaries", "PAYE", "Pension", "Transfer", "Corp tax", "VAT",
          "Non-operating income", "Non-operating expenses", "Other"
        ];

        // Map categories from rawReconRows (U3:X16), falling back to canonical list if sheet range empty
        const sourceRows = (rawReconRows && rawReconRows.length > 0)
          ? rawReconRows
          : canonicalCategories.map(c => [c, "£0.00", "£0.00", "£0.00"]);

        cashflowComparisons = sourceRows.map(r => {
          const catLabel = String(r[0] || "").trim();
          if (!catLabel || isFormulaError(catLabel) || catLabel.toLowerCase() === "total") return null;
          const outVal = String(r[1] || "").trim();
          const inVal = String(r[2] || "").trim();
          const netVal = String(r[3] || "").trim();
          const forecast = mapCategoryToForecast(catLabel, rawCompRows);
          return {
            label: catLabel,
            outAmount: outVal,
            inAmount: inVal,
            bankRecon: netVal || "£0.00",
            cashflow: forecast.cashflow,
            diff: forecast.diff
          };
        }).filter(Boolean);

        // Parse [3] Revenue Breakdown Z4:AR60
        const rawRevRows = vRanges[3]?.values || [];
        const revBank = [];
        const revPulse = [];
        rawRevRows.slice(1).forEach((r, i) => {
          // Left: Bank side Z:AG
          const hasBankData = (r[0] || r[4] || r[5]) && !isFormulaError(r[0]) && !isFormulaError(r[1]) && !isFormulaError(r[4]) && !isFormulaError(r[5]);
          if (hasBankData) {
            revBank.push({
              rowNum: i + 5,
              date: r[0] || "",
              payee: r[1] || "",
              particulars: r[2] || "",
              ref: r[3] || "",
              outAmt: r[4] || "",
              inAmt: r[5] || "",
              matched: r[6] || "",
              manual: r[7] || ""
            });
          }
          // Right: Pulse side AI:AR
          const hasPulseData = (r[9] || r[10] || r[13]) && !isFormulaError(r[9]) && !isFormulaError(r[10]) && !isFormulaError(r[13]);
          if (hasPulseData) {
            revPulse.push({
              rowNum: i + 5,
              client: r[9] || "",
              job: r[10] || "",
              type: r[11] || "",
              ref: r[12] || "",
              amount: r[13] || "",
              expDate: r[14] || "",
              status: r[15] || "",
              matchedRow: r[16] || "",
              pulseId: String(r[16] || "").trim(),
              matched: r[17] || "",
              manual: r[18] || ""
            });
          }
        });
        revenueBreakdown = { bankItems: revBank, pulseInvoices: revPulse };

        // Parse [4] Contractors Breakdown AT4:BL40
        const rawContrRows = vRanges[4]?.values || [];
        const contrBank = [];
        const contrPulse = [];
        rawContrRows.slice(1).forEach((r, i) => {
          const hasBankData = (r[0] || r[4] || r[5]) && !isFormulaError(r[0]) && !isFormulaError(r[1]) && !isFormulaError(r[4]) && !isFormulaError(r[5]);
          if (hasBankData) {
            contrBank.push({
              rowNum: i + 5,
              date: r[0] || "",
              payee: r[1] || "",
              particulars: r[2] || "",
              ref: r[3] || "",
              outAmt: r[4] || "",
              inAmt: r[5] || "",
              matched: r[6] || "",
              manual: r[7] || ""
            });
          }
          const hasPulseData = (r[9] || r[10] || r[13]) && !isFormulaError(r[9]) && !isFormulaError(r[10]) && !isFormulaError(r[13]);
          if (hasPulseData) {
            contrPulse.push({
              rowNum: i + 5,
              client: r[9] || "",
              job: r[10] || "",
              description: r[11] || "",
              ref: r[12] || "",
              amount: r[13] || "",
              payDate: r[14] || "",
              status: r[15] || "",
              matchedRow: r[16] || "",
              pulseId: String(r[16] || "").trim(),
              matched: r[17] || "",
              manual: r[18] || ""
            });
          }
        });
        contractorsBreakdown = { bankItems: contrBank, pulseContractors: contrPulse };

        // Parse [5] Direct Costs Breakdown AT48:BK75
        const rawDcRows = vRanges[5]?.values || [];
        const dcBank = [];
        const dcPulse = [];
        rawDcRows.slice(1).forEach((r, i) => {
          const hasBankData = (r[0] || r[4] || r[5]) && !isFormulaError(r[0]) && !isFormulaError(r[1]) && !isFormulaError(r[4]) && !isFormulaError(r[5]);
          if (hasBankData) {
            dcBank.push({
              rowNum: i + 49,
              date: r[0] || "",
              payee: r[1] || "",
              particulars: r[2] || "",
              ref: r[3] || "",
              outAmt: r[4] || "",
              inAmt: r[5] || "",
              matched: r[6] || "",
              manual: r[7] || ""
            });
          }
          const hasPulseData = (r[9] || r[10] || r[13]) && !isFormulaError(r[9]) && !isFormulaError(r[10]) && !isFormulaError(r[13]);
          if (hasPulseData) {
            dcPulse.push({
              rowNum: i + 49,
              client: r[9] || "",
              job: r[10] || "",
              type: r[11] || "",
              ref: r[12] || "",
              amount: r[13] || "",
              expDate: r[14] || "",
              status: r[15] || "",
              matchedRow: r[16] || "",
              pulseId: String(r[16] || "").trim(),
              matched: r[17] || "",
              manual: r[18] || ""
            });
          }
        });
        directCostsBreakdown = { bankItems: dcBank, pulseDirectCosts: dcPulse };

        // Parse [6] Unreconciled Items CD4:CN60
        const rawUnreconRows = vRanges[6]?.values || [];
        const isQbDa1 = da1Platform.toLowerCase().includes("quick");
        unreconciledItems = rawUnreconRows.map((r, i) => {
          const date = r[2] || "";
          const payee = r[3] || "";
          const particulars = r[4] || "";
          const amount = r[5] || "";
          const category = r[9] || "";
          const vat = r[10] || "";
          const numAmt = parseNumeric(amount);
          const absAmt = Math.abs(numAmt);
          // In Xero mode (DA1="Xero"), outflows in CI are negative (< 0).
          // In QuickBooks mode (DA1="Quickbooks"), outflows in CI are positive (> 0).
          const isNegative = isQbDa1 ? numAmt > 0 : numAmt < 0;
          return {
            rowNum: i + 4,
            date,
            payee,
            particulars,
            amount: absAmt || amount,
            outAmount: isNegative ? absAmt : 0,
            inAmount: !isNegative ? absAmt : 0,
            isNegative,
            category: category.trim(),
            vatApplies: vat.trim() || "No"
          };
        }).filter(u => u.date || u.payee || u.amount);

        // Parse [7] P&L Adds by Account & All Available Categories CZ3:DA60
        const rawPlRows = vRanges[7]?.values || [];
        plAdds = rawPlRows.map(r => ({
          accountName: String(r[0] || "").trim(),
          amount: String(r[1] || "").trim()
        })).filter(p => p.accountName && p.amount && p.amount !== "£0.00" && p.amount !== "0.00");

        plAccountOptions = rawPlRows
          .map(r => String(r[0] || "").trim())
          .filter(Boolean);

        if (!trackedBankAccounts || trackedBankAccounts.length === 0) {
          trackedBankAccounts = (vRanges[8]?.values || [])
            .map(r => String(r[0] || "").trim())
            .filter(acc => acc && !acc.toLowerCase().includes("non-cash") && !acc.endsWith(":"));
        }
      }
    } catch (err) {
      console.warn(`⚠️ Recon sheet fetch failed for ${cleanReconSheetId}:`, err.message);
      if (err.message && err.message.includes("does not have permission")) {
        reconError = "Recon sheet permission required: please grant Viewer/Editor access to alert-triage-backend@automation-commander.iam.gserviceaccount.com";
      } else {
        reconError = err.message;
      }
    }
  } else {
    reconError = "No Recon Sheet configured in AutoUpdates for this client";
  }

  // 9. Build detailed person-by-person payroll breakdown and intelligent variance explanation note
  let staffPayrollBreakdown = [];
  let generatedSalariesNote = "";
  try {
    const payrollResult = await buildStaffPayrollBreakdown_({
      sheets,
      clientSheetId: cleanClientSheetId,
      targetMonthInfo,
      bankTransactions,
      cashflowComparisons
    });
    staffPayrollBreakdown = payrollResult.staff || [];
    generatedSalariesNote = payrollResult.generatedNote || "";
  } catch (payErr) {
    console.warn("Could not build staff payroll breakdown:", payErr.message);
  }

  return {
    success: true,
    clientSheetId: cleanClientSheetId,
    cashTabSheetId,
    reconSheetId: cleanReconSheetId,
    taxPaymentMethod: taxPaymentMethodRaw || "Actual",
    isTransfersMode: Boolean(isTransfersMode),
    targetMonthLabel: `${FULL_MONTH_NAMES[targetMonthInfo.month]} ${targetMonthInfo.year}`,
    targetMonthKey: `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}`,
    reconTabName,
    hasTargetTab,
    canAutoCreateTab,
    isReconciledComplete: Boolean(isReconciledComplete),
    selectedCols,
    rows,
    reconActuals,
    reconError,
    availableReconTabs,
    bankTransactions,
    cashflowComparisons,
    revenueBreakdown,
    contractorsBreakdown,
    directCostsBreakdown,
    unreconciledItems,
    staffPayrollBreakdown,
    generatedSalariesNote,
    plAdds,
    plAccountOptions: plAccountOptions || [],
    trackedBankAccounts: trackedBankAccounts || [],
    trackedNonCashBankAccounts: trackedNonCashBankAccounts || [],
    da1Platform,
    accountingPlatform: da1Platform
  };
}

/**
 * Ensures that KeyInfo!G1 in the Client Sheet is populated with the Recon Sheet URL
 * so that dynamic IMPORTRANGE formulas can resolve immediately.
 */
async function ensureClientReconSheetUrl_(sheets, cleanClientSheetId, automationCommanderSheetId, clientName) {
  try {
    const res = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanClientSheetId,
      range: "KeyInfo!G1"
    }));
    const curVal = res.data?.values?.[0]?.[0];
    if (curVal && String(curVal).trim().startsWith("http")) return curVal;

    let reconUrl = "";
    if (automationCommanderSheetId) {
      const acRes = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: automationCommanderSheetId,
        range: "AutoUpdates!A2:O100"
      }));
      const rows = acRes.data?.values || [];
      const match = rows.find(r => matchesClientName(r[0], clientName) || (r[11] && r[11].includes(cleanClientSheetId)));
      if (match && match[9]) {
        const rawRecon = String(match[9]).trim();
        reconUrl = rawRecon.startsWith("http")
          ? rawRecon
          : `https://docs.google.com/spreadsheets/d/${rawRecon}/edit`;
      }
    }

    if (reconUrl) {
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: cleanClientSheetId,
        range: "KeyInfo!G1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[reconUrl]] }
      }));
    }
    return reconUrl;
  } catch (err) {
    console.warn("Could not ensure KeyInfo!G1 in Client Sheet:", err.message);
  }
}

/**
 * Build Person-by-Person Payroll Breakdown & Intelligent Explanation Note
 * Matches imported payroll actuals from the Salaries sheet against bank transactions.
 */
async function buildStaffPayrollBreakdown_({
  sheets,
  clientSheetId,
  targetMonthInfo,
  bankTransactions,
  cashflowComparisons
}) {
  try {
    const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const targetLabel = `${SHORT_MONTHS[targetMonthInfo.month]} ${String(targetMonthInfo.year).slice(-2)}`;

    const salRes = await withRetry(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: clientSheetId,
      ranges: [
        "Salaries!A1:JC3",
        "Salaries!A304:JC353",
        "Salaries!A4:JC53",
      ],
      valueRenderOption: "FORMATTED_VALUE"
    }));

    const salRanges = salRes.data?.valueRanges || [];
    const headerRows = salRanges[0]?.values || [];
    const effectiveRows = salRanges[1]?.values || [];
    const overrideRows = salRanges[2]?.values || [];
    const hasEffective = effectiveRows.some(r => Array.isArray(r) && r.slice(11).some(c => String(c || "").trim() !== ""));
    const employeeRows = hasEffective ? effectiveRows : overrideRows;
    if (headerRows.length < 1 || employeeRows.length === 0) return { staff: [], unmatchedBank: [], generatedNote: "" };

    const header = headerRows[0] || [];
    let octCol = -1;
    for (let c = 0; c < header.length; c++) {
      if (String(header[c] || "").trim().toLowerCase() === targetLabel.toLowerCase()) {
        octCol = c;
        break;
      }
    }
    if (octCol === -1) return { staff: [], unmatchedBank: [], generatedNote: "" };

    const cleanNum = (v) => {
      if (!v) return 0;
      const n = parseFloat(String(v).replace(/[£,\s]/g, ""));
      return isNaN(n) ? 0 : n;
    };

    const staff = [];
    for (let r = 0; r < employeeRows.length; r++) {
      const row = employeeRows[r] || [];
      const fallbackRow = overrideRows[r] || [];
      const name = String(row[0] || fallbackRow[0] || "").trim();
      if (!name || name.toLowerCase().includes("total") || name.toLowerCase().includes("likel") || name.toLowerCase().includes("allowance")) continue;
      const gross = cleanNum(row[octCol]);
      const eeNics = cleanNum(row[octCol + 1]);
      const erNics = cleanNum(row[octCol + 2]);
      const studLoan = cleanNum(row[octCol + 3]);
      const eePension = cleanNum(row[octCol + 4]);
      const erPension = cleanNum(row[octCol + 5]);
      const paye = cleanNum(row[octCol + 6]);
      // Net wage = Gross Salary - PAYE - Employee NICs - Student Loan - Employee Pension
      const expectedNet = Math.round((gross - paye - eeNics - studLoan - eePension) * 100) / 100;
      if (gross > 0 || expectedNet > 0) {
        staff.push({
          name,
          gross,
          paye,
          eeNics,
          erNics,
          studLoan,
          eePension,
          erPension,
          expectedNet,
          bankPaid: 0,
          diff: 0,
          status: "unpaid",
          matchReason: "",
          matchedTxId: null,
          bankDesc: "",
          bankItems: []
        });
      }
    }

    // Filter bank transactions for Salaries category
    const bankSalTxs = (bankTransactions || [])
      .filter(tx => {
        const cat = String(tx.category || "").trim().toLowerCase();
        return cat === "salaries" || cat.includes("salar") || cat.includes("wages") || cat.includes("payroll");
      })
      .map(tx => ({
        id: `tx_${tx.rowNum}`,
        rowNum: tx.rowNum,
        date: tx.date,
        payee: tx.payee || "",
        desc: tx.particulars || "",
        outAmt: Math.abs(cleanNum(tx.outAmount || tx.amount || 0)),
        matched: false,
        matchedStaff: null,
        matchType: null
      }));

    const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

    // PASS 1: Direct Name Matching
    bankSalTxs.forEach(tx => {
      if (tx.matched) return;
      const txText = `${tx.payee} ${tx.desc}`.toLowerCase();
      staff.forEach(s => {
        if (s.matched) return;
        const parts = s.name.split(",").map(p => p.trim());
        const surname = parts[0] || "";
        const firstname = parts[1] || "";
        const fullName = `${firstname} ${surname}`.trim();

        const normFull = normName(fullName);
        const normSur = normName(surname);
        const normFirst = normName(firstname);
        const textClean = normName(txText);

        if (normFull && textClean.includes(normFull)) {
          tx.matched = true;
          tx.matchedStaff = s.name;
          tx.matchType = "exact_name";
          s.matched = true;
          s.bankItems.push(tx);
        } else if (normSur.length >= 4 && normFirst.length >= 3 && textClean.includes(normSur) && textClean.includes(normFirst)) {
          tx.matched = true;
          tx.matchedStaff = s.name;
          tx.matchType = "name_parts";
          s.matched = true;
          s.bankItems.push(tx);
        }
      });
    });

    // PASS 2: Exact Net Amount Match with First Initial Check (e.g. Cross, Jennifer vs J. Mulholland)
    bankSalTxs.forEach(tx => {
      if (tx.matched) return;
      const txText = `${tx.payee} ${tx.desc}`.toLowerCase();
      staff.forEach(s => {
        if (s.matched) return;
        if (Math.abs(s.expectedNet - tx.outAmt) <= 0.01) {
          const parts = s.name.split(",").map(p => p.trim());
          const firstname = parts[1] || parts[0];
          const firstInitial = (firstname[0] || "").toLowerCase();
          const hasInitial = new RegExp(`\\b${firstInitial}[.\\s]`, "i").test(txText);
          if (hasInitial) {
            tx.matched = true;
            tx.matchedStaff = s.name;
            tx.matchType = "amount_and_initial";
            s.matched = true;
            s.bankItems.push(tx);
          }
        }
      });
    });

    // PASS 3: Proximity Amount Match for Generic Bank Lines (e.g. "Reconcile Net Pay Summary")
    bankSalTxs.forEach(tx => {
      if (tx.matched) return;
      const txText = `${tx.payee} ${tx.desc}`.toLowerCase();
      const isGeneric = txText.includes("reconcile") || txText.includes("net pay") || txText.includes("summary") || txText.includes("payroll");
      if (isGeneric) {
        staff.forEach(s => {
          if (s.matched) return;
          if (Math.abs(s.expectedNet - tx.outAmt) <= 1.00) {
            tx.matched = true;
            tx.matchedStaff = s.name;
            tx.matchType = "amount_generic_line";
            s.matched = true;
            s.bankItems.push(tx);
          }
        });
      }
    });

    // PASS 4: EoR / Contractor (e.g. Rhys Krohn vs Leap29)
    bankSalTxs.forEach(tx => {
      if (tx.matched) return;
      const txText = `${tx.payee} ${tx.desc}`.toLowerCase();
      staff.forEach(s => {
        if (s.name.toLowerCase().includes("eor") || s.name.toLowerCase().includes("rhys")) {
          if (txText.includes("rhys") || txText.includes("leap29")) {
            tx.matched = true;
            tx.matchedStaff = s.name;
            tx.matchType = "eor_partner";
            s.matched = true;
            s.bankItems.push(tx);
          }
        }
      });
    });

    // Finalize staff item metrics
    staff.forEach(s => {
      const bankTotal = s.bankItems.reduce((acc, t) => acc + t.outAmt, 0);
      s.bankPaid = Math.round(bankTotal * 100) / 100;
      s.diff = Math.round((s.bankPaid - s.expectedNet) * 100) / 100;
      if (s.bankItems.length > 0) {
        const primaryTx = s.bankItems[0];
        s.bankDesc = [primaryTx.payee, primaryTx.desc].filter(Boolean).join(" - ");
        if (s.bankItems.length > 1) s.bankDesc += ` (+${s.bankItems.length - 1} more)`;
        s.matchReason = primaryTx.matchType;
        if (Math.abs(s.diff) <= 0.01) {
          s.status = "matched";
        } else if (s.name.toLowerCase().includes("eor")) {
          s.status = "eor";
        } else {
          s.status = "variance";
        }
      } else {
        s.status = "unpaid";
        s.bankDesc = "No bank payment detected";
      }
    });

    const unmatchedBank = bankSalTxs.filter(t => !t.matched);

    // Build intelligent financial explanation note
    const matchedCount = staff.filter(s => s.status === "matched").length;
    const varianceItems = staff.filter(s => s.status === "variance");
    const eorItems = staff.filter(s => s.status === "eor");
    const unpaidItems = staff.filter(s => s.status === "unpaid" && s.expectedNet > 0);

    const wagesComp = (cashflowComparisons || []).find(c => {
      const l = (c.label || "").toLowerCase();
      return l.includes("payroll") || (l.includes("salar") && !l.includes("total"));
    });
    const payeComp = (cashflowComparisons || []).find(c => (c.label || "").toLowerCase().includes("paye"));
    const pensionComp = (cashflowComparisons || []).find(c => (c.label || "").toLowerCase().includes("pension"));

    const noteParts = [];

    // Net payroll part
    const wagesDiffNum = parseFloat(String(wagesComp?.diff || "0").replace(/[£,\s]/g, "")) || 0;
    const wagesSign = wagesDiffNum > 0 ? "+" : "-";
    const wagesDiffStr = `${wagesSign}£${Math.abs(wagesDiffNum).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    let wageNote = `Net payroll (${wagesDiffStr}): ${matchedCount} staff matched to the penny`;
    if (varianceItems.length > 0) {
      const vDetails = varianceItems.map(v => `${v.name.split(",")[0]} (${v.diff > 0 ? "+" : "-"}£${Math.abs(v.diff).toFixed(2)})`).join(", ");
      wageNote += `; variances on ${vDetails}`;
    }
    if (eorItems.length > 0) {
      const eorDetails = eorItems.map(e => `${e.name.replace(/\s*\(via EoR\)/i, "")} via EoR partner (£${e.bankPaid.toFixed(2)})`).join(", ");
      wageNote += `; ${eorDetails}`;
    }
    if (unpaidItems.length > 0) {
      const uDetails = unpaidItems.map(u => `${u.name.split(",")[0]} (£${u.expectedNet.toFixed(2)} expected)`).join(", ");
      wageNote += `; no salary payment detected for ${uDetails}`;
    }
    if (unmatchedBank.length > 0) {
      const unrecSum = unmatchedBank.reduce((sum, u) => sum + u.outAmt, 0);
      wageNote += `; £${unrecSum.toFixed(2)} unmatched bank payments (${unmatchedBank.map(u => u.payee || u.desc).join(", ")})`;
    }
    noteParts.push(wageNote + ".");

    // PAYE part
    if (payeComp) {
      const payeDiffNum = parseFloat(String(payeComp.diff || "0").replace(/[£,\s]/g, "")) || 0;
      if (Math.abs(payeDiffNum) <= 0.01) {
        noteParts.push("PAYE: exact match.");
      } else {
        const payeSign = payeDiffNum > 0 ? "+" : "-";
        const actualStr = payeComp.bankRecon || payeComp.outAmount || "£0.00";
        const forecastStr = payeComp.cashflow || "£0.00";
        noteParts.push(`PAYE: HMRC payment ${payeSign}£${Math.abs(payeDiffNum).toFixed(2)} vs forecast (${actualStr} actual vs ${forecastStr} forecast).`);
      }
    }

    // Pension part
    if (pensionComp) {
      const pensionDiffNum = parseFloat(String(pensionComp.diff || "0").replace(/[£,\s]/g, "")) || 0;
      if (Math.abs(pensionDiffNum) <= 0.01) {
        noteParts.push("Pension: exact match.");
      } else {
        const penSign = pensionDiffNum > 0 ? "+" : "-";
        noteParts.push(`Pension: ${penSign}£${Math.abs(pensionDiffNum).toFixed(2)} variance against forecast.`);
      }
    }

    const generatedNote = noteParts.join(" ");

    return {
      staff,
      unmatchedBank,
      matchedCount,
      totalExpectedNet: Math.round(staff.reduce((acc, s) => acc + s.expectedNet, 0) * 100) / 100,
      totalBankPaid: Math.round(staff.reduce((acc, s) => acc + s.bankPaid, 0) * 100) / 100,
      generatedNote
    };
  } catch (err) {
    console.warn("Could not build staff payroll breakdown:", err.message);
    return { staff: [], unmatchedBank: [], generatedNote: "" };
  }
}

/**
 * Updates a single bank transaction's category cell in column Q of the Recon Sheet
 */
export async function updateReconTransactionCategory({
  reconSheetId,
  tabName,
  rowNum,
  category,
  clientName,
  automationCommanderSheetId
}) {
  if (!reconSheetId || !tabName || !rowNum) {
    throw new Error("Missing reconSheetId, tabName, or rowNum");
  }

  const sheets = await getSheetsClient();
  const cleanId = extractSheetIdFromUrl(reconSheetId) || reconSheetId;
  const cleanTab = String(tabName || "").trim();
  if (!/^\d{4}$/.test(cleanTab)) {
    throw new Error("Invalid recon tabName: must be 4 digits (MMYY).");
  }
  const cleanRow = parseInt(rowNum, 10);
  if (isNaN(cleanRow) || cleanRow < 3 || cleanRow > 500) {
    throw new Error("Invalid rowNum.");
  }
  const targetRange = `'${cleanTab}'!Q${cleanRow}`;

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: cleanId,
    range: targetRange,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[sanitizeFormulaInput(category || "")]] }
  }));

  return { success: true, tabName: cleanTab, rowNum: cleanRow, category };
}

/**
 * Writes a full list of bank transactions to columns A3:J and Q3:Q in the Recon Sheet
 */
export async function syncReconBankTransactions({
  reconSheetId,
  tabName,
  transactions = [],
  allowEmpty = false
}) {
  if (!reconSheetId || !tabName) {
    throw new Error("Missing reconSheetId or tabName");
  }
  const cleanTab = String(tabName || "").trim();
  if (!/^\d{4}$/.test(cleanTab)) {
    throw new Error("Invalid recon tabName: must be 4 digits (MMYY).");
  }
  tabName = cleanTab;

  // Safety guard: Never wipe out transactions with an empty array unless allowEmpty is explicitly specified
  if (transactions.length === 0 && !allowEmpty) {
    return { success: true, count: 0, skipped: true };
  }

  const sheets = await getSheetsClient();
  const cleanId = extractSheetIdFromUrl(reconSheetId) || reconSheetId;

  // 1. Manage background formatting FIRST while the Recon sheet is idle (<1s):
  // reset regular rows to white, and highlight newly reconciled rows green (#dcfce7)
  if (transactions.length > 0) {
    try {
      const tabGid = await getSheetGid(sheets, cleanId, tabName);
      const WHITE_RGB = { red: 1, green: 1, blue: 1 };
      const NEW_GREEN_RGB = { red: 0.862745, green: 0.988235, blue: 0.905882 }; // #dcfce7

      // Reset all active bank feed rows (and clear any past highlights up to row 150) to white
      const maxRowToClear = Math.max(2 + transactions.length, 120);
      const colorRequests = [
        {
          repeatCell: {
            range: {
              sheetId: tabGid,
              startRowIndex: 2, // Row 3 (0-indexed)
              endRowIndex: maxRowToClear,
              startColumnIndex: 1, // Col B
              endColumnIndex: 16   // Col P
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: WHITE_RGB
              }
            },
            fields: "userEnteredFormat.backgroundColor"
          }
        }
      ];

      // Highlight only genuinely newly reconciled transactions in light green
      transactions.forEach((tx, idx) => {
        if (tx.isNew) {
          colorRequests.push({
            repeatCell: {
              range: {
                sheetId: tabGid,
                startRowIndex: idx + 2,
                endRowIndex: idx + 3,
                startColumnIndex: 1, // Col B
                endColumnIndex: 16   // Col P
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: NEW_GREEN_RGB
                }
              },
              fields: "userEnteredFormat.backgroundColor"
            }
          });
        }
      });

      await withRetry(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId: cleanId,
        requestBody: { requests: colorRequests }
      }));
    } catch (colorErr) {
      console.warn("Could not update bank transaction background formatting:", colorErr.message);
    }
  }

  // 2. Clear existing A3:J200 and Q3:Q200, then write transaction values SECOND
  const bankOnlyTxns = (transactions || []).filter(tx => tx.isReconciled !== false && !tx.unreconRowNum && tx.source !== "unreconciled_pasted");

  await withRetry(() => sheets.spreadsheets.values.batchClear({
    spreadsheetId: cleanId,
    requestBody: {
      ranges: [`'${tabName}'!A3:J200`, `'${tabName}'!Q3:Q200`]
    },
    _skipFormulaRecompute: bankOnlyTxns.length > 0,
  }));

  if (bankOnlyTxns.length === 0) {
    return { success: true, count: 0 };
  }

  const rowsAJ = [];
  const rowsQ = [];

  bankOnlyTxns.forEach(tx => {
    const date = tx.date || "";
    const payee = tx.payee || "";
    const particulars = tx.particulars || "";
    const ref = tx.reference || "";
    const outAmt = tx.outAmount ? String(tx.outAmount) : "";
    const inAmt = tx.inAmount ? String(tx.inAmount) : "";
    const inNum = parseFloat(String(inAmt).replace(/[£,\s]/g, "")) || 0;
    const cat = tx.category || tx.suggestedCategory || (inNum > 0 ? "Revenue" : "Outgoings");
    const accountName = tx.accountName || "";

    // Columns: [A: Date, B: Date, C: Account Name, D: Payee, E: Particulars, F: Ref, G: '', H: '', I: Out, J: In]
    rowsAJ.push([sanitizeFormulaInput(date), sanitizeFormulaInput(date), sanitizeFormulaInput(accountName), sanitizeFormulaInput(payee), sanitizeFormulaInput(particulars), sanitizeFormulaInput(ref), "", "", sanitizeFormulaInput(outAmt), sanitizeFormulaInput(inAmt)]);
    rowsQ.push([sanitizeFormulaInput(cat)]);
  });

  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: cleanId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `'${tabName}'!A3:J${2 + rowsAJ.length}`,
          values: rowsAJ
        },
        {
          range: `'${tabName}'!Q3:Q${2 + rowsQ.length}`,
          values: rowsQ
        }
      ]
    }
  }));

  return { success: true, count: transactions.length };
}

/**
 * Syncs unreconciled statement lines and manual P&L categories to CD4:CN in the Recon Sheet
 */
export async function syncReconUnreconciledItems({
  reconSheetId,
  tabName,
  unreconciledItems = []
}) {
  if (!reconSheetId || !tabName) {
    throw new Error("Missing reconSheetId or tabName");
  }
  const cleanTab = String(tabName || "").trim();
  if (!/^\d{4}$/.test(cleanTab)) {
    throw new Error("Invalid recon tabName: must be 4 digits (MMYY).");
  }
  tabName = cleanTab;

  const sheets = await getSheetsClient();
  const cleanId = extractSheetIdFromUrl(reconSheetId) || reconSheetId;

  // Read DA1 platform setting on this tab so CI sign matches the sheet's DA3:DA formula:
  // CP4 is =-if(CN4="Yes",CI4/1.2,CI4) and DA3 is =sumif($CM$3:$CM$350,CZ3,$CP$3:$CP$350)*if(DA$1="Xero",1,-1)
  // Therefore, DA1="Xero" expects outflows in CI to be negative, while DA1="Quickbooks" expects outflows in CI to be positive.
  let isQbDa1 = false;
  try {
    const da1Resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanId,
      range: `'${tabName}'!DA1`
    }));
    const da1Val = String(da1Resp.data.values?.[0]?.[0] || "").trim().toLowerCase();
    isQbDa1 = da1Val.includes("quick");
  } catch (e) {
    isQbDa1 = false;
  }

  // Clear existing CD4:CI100 and CM4:CN100
  await withRetry(() => sheets.spreadsheets.values.batchClear({
    spreadsheetId: cleanId,
    requestBody: {
      ranges: [`'${tabName}'!CD4:CI100`, `'${tabName}'!CM4:CN100`]
    },
    _skipFormulaRecompute: unreconciledItems.length > 0,
  }));

  if (unreconciledItems.length === 0) {
    return { success: true, count: 0 };
  }

  const rowsCD = [];
  const rowsCM = [];

  unreconciledItems.forEach(u => {
    const date = u.date || "";
    const payee = u.payee || "";
    const particulars = u.particulars || "";
    const rawNum = Math.abs(parseNumeric(u.amount || u.outAmount || u.inAmount));
    const isOutflow = u.isNegative !== undefined
      ? Boolean(u.isNegative)
      : (parseNumeric(u.outAmount) > 0 || parseNumeric(u.amount) < 0);
    let amt = "";
    if (rawNum > 0) {
      if (isQbDa1) {
        amt = isOutflow ? String(rawNum) : `-${rawNum}`;
      } else {
        amt = isOutflow ? `-${rawNum}` : String(rawNum);
      }
    }
    // Sourced category: prefer plCategory if set and non-empty, otherwise category / cashflowCategory
    const rawPl = String(u.plCategory || "").trim();
    const rawCat = String(u.category || u.cashflowCategory || "").trim();
    let cat = rawPl || rawCat || "";
    if (cat === "Outgoings" || cat === "Revenue") {
      cat = rawPl && rawPl !== "Outgoings" && rawPl !== "Revenue" ? rawPl : "";
    }
    const vat = u.vatApplies || "No";

    // CD:CI: [CD: '', CE: '', CF: Date, CG: Payee, CH: Particulars, CI: Amount]
    rowsCD.push(["", "", sanitizeFormulaInput(date), sanitizeFormulaInput(payee), sanitizeFormulaInput(particulars), sanitizeFormulaInput(amt)]);
    // CM:CN: [CM: Category, CN: VAT?]
    rowsCM.push([sanitizeFormulaInput(cat), sanitizeFormulaInput(vat)]);
  });

  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: cleanId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `'${tabName}'!CD4:CI${3 + rowsCD.length}`,
          values: rowsCD
        },
        {
          range: `'${tabName}'!CM4:CN${3 + rowsCM.length}`,
          values: rowsCM
        }
      ]
    }
  }));

  return { success: true, count: unreconciledItems.length };
}


/**
 * Update an adjustment cell in the Client Sheet Cash tab
 */
export async function updateCashAdjustment({
  clientSheetId,
  colLetter,
  sheetRow,
  value,
  note,
  cashTabSheetId,
  colIdx,
  clientName,
  automationCommanderSheetId,
  isAdmin = true
}) {
  if (!clientSheetId || !colLetter || !sheetRow) {
    throw new Error("Missing clientSheetId, colLetter, or sheetRow");
  }

  const sheets = await getSheetsClient();
  const cleanClientSheetId = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const rowNum = parseInt(sheetRow, 10);
  const ALLOWED_ADJUSTMENT_ROWS = new Set([7, 9, 11, 13, 14, 15, 17, 19, 20, 21, 22, 25, 27, 29, 30]);
  const cleanCol = String(colLetter).trim().toUpperCase();
  if (!ALLOWED_ADJUSTMENT_ROWS.has(rowNum) || !/^[B-Z]$|^A[A-K]$/.test(cleanCol)) {
    throw new Error("Invalid adjustment row or column");
  }
  const cellRange = `Cash!${cleanCol}${rowNum}`;

  const cleanValue = typeof value === "string" ? value.trim().replace(/^['’]=/, "=") : value;
  let safeValue = sanitizeCashAdjustmentInput(cleanValue ?? "");
  if (!isAdmin && typeof safeValue === "string" && safeValue.startsWith("=") && /^=[0-9+\-*/().\s]+$/.test(safeValue)) {
    try {
      const evaluated = Function(`"use strict"; return (${safeValue.slice(1)});`)();
      if (typeof evaluated === "number" && isFinite(evaluated)) {
        safeValue = Math.round(evaluated * 100) / 100;
      }
    } catch (_) { }
  }

  // Ensure KeyInfo!G1 in Client Sheet has the Recon Sheet URL if dynamic IMPORTRANGE is used
  if (typeof safeValue === "string" && safeValue.includes("KeyInfo!$G$1")) {
    await ensureClientReconSheetUrl_(sheets, cleanClientSheetId, automationCommanderSheetId, clientName);
  }

  // Update cell note first (if provided) so formatting/notes do not wait on formula recalculation
  if (note !== undefined && cashTabSheetId !== undefined && cashTabSheetId !== null && colIdx !== undefined) {
    const tColIdx = parseInt(colIdx, 10);
    if (!isNaN(tColIdx) && tColIdx >= 1 && tColIdx <= 50) {
      await withRetry(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId: cleanClientSheetId,
        requestBody: {
          requests: [{
            updateCells: {
              range: {
                sheetId: cashTabSheetId,
                startRowIndex: rowNum - 1,
                endRowIndex: rowNum,
                startColumnIndex: tColIdx,
                endColumnIndex: tColIdx + 1
              },
              rows: [{ values: [{ note: String(note || "") }] }],
              fields: "note"
            }
          }]
        },
        _skipFormulaRecompute: true
      }));
    }
  }

  const updateRes = await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: cleanClientSheetId,
    range: cellRange,
    valueInputOption: "USER_ENTERED",
    includeValuesInResponse: true,
    responseValueRenderOption: "FORMATTED_VALUE",
    requestBody: { values: [[safeValue]] }
  }));

  const formattedValue = updateRes.data?.updatedData?.values?.[0]?.[0] ?? (value ?? "");

  await invalidatePmaClientCache(cleanClientSheetId, null, ["cash"]).catch(() => { });

  (async () => {
    let resolvedClient = clientName || "";
    if (!resolvedClient) {
      resolvedClient = await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId);
    }
    await logPmaActivity(sheets, {
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
    });
  })().catch(e => console.error("PMA log failed:", e));

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
  if (isNaN(rowNum) || rowNum < 3 || rowNum > 80 || isNaN(colIndex) || colIndex < 1 || colIndex > 50) {
    throw new Error("Invalid Cash row or column index");
  }
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

  await invalidatePmaClientCache(cleanClientSheetId, null, ["cash"]).catch(() => { });

  const colLetter = colIndexToLetter(colIndex + 1);
  (async () => {
    let resolvedClient = clientName || "";
    if (!resolvedClient) {
      resolvedClient = await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId);
    }
    await logPmaActivity(sheets, {
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
    });
  })().catch(e => console.error("PMA log failed:", e));

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
  if (isNaN(rowNum) || rowNum < 3 || rowNum > 80 || isNaN(colIndex) || colIndex < 1 || colIndex > 50) {
    throw new Error("Invalid Cash row or column index");
  }

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

  await invalidatePmaClientCache(cleanClientSheetId, null, ["cash"]).catch(() => { });

  const colLetter = colIndexToLetter(colIndex + 1);
  (async () => {
    let resolvedClient = clientName || "";
    if (!resolvedClient) {
      resolvedClient = await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId);
    }
    await logPmaActivity(sheets, {
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
    });
  })().catch(e => console.error("PMA log failed:", e));

  return { success: true, cellRef: `${colLetter}${rowNum}`, note };
}

/**
 * Applies a future-month offset (linked formula e.g. =-G7 or custom carry-over amount)
 * and optionally updates both the Target Month and Next Month adjustment cell notes in one call.
 */
export async function applyCashFutureOffset({
  clientSheetId,
  cashTabSheetId,
  sheetRow,
  targetColIdx,
  targetColLetter,
  nextColIdx,
  nextColLetter,
  targetValue, // optional: if also updating target month adjustment
  nextValue,   // required: value or formula for next month adjustment (e.g. "=-G7" or "-4000")
  targetNote,  // optional string (if !== undefined, updates target month note)
  nextNote,    // optional string (if !== undefined, updates next month note)
  clientName,
  automationCommanderSheetId,
  isAdmin = true
}) {
  if (!clientSheetId || !sheetRow || !nextColLetter) {
    throw new Error("Missing clientSheetId, sheetRow, or nextColLetter");
  }

  const sheets = await getSheetsClient();
  const cleanClientSheetId = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const rowNum = parseInt(sheetRow, 10);
  const ALLOWED_ADJUSTMENT_ROWS = new Set([7, 9, 11, 13, 14, 15, 17, 19, 20, 21, 22, 25, 27, 29, 30]);
  const cleanNextCol = String(nextColLetter).trim().toUpperCase();
  const cleanTargetCol = targetColLetter ? String(targetColLetter).trim().toUpperCase() : "";

  if (!ALLOWED_ADJUSTMENT_ROWS.has(rowNum) || !/^[B-Z]$|^A[A-K]$/.test(cleanNextCol)) {
    throw new Error("Invalid adjustment row or column");
  }

  // 1. Update cell notes first (if provided) via spreadsheets.batchUpdate
  const noteRequests = [];
  if (targetNote !== undefined && targetColIdx !== undefined && cashTabSheetId !== undefined) {
    const tColIdx = parseInt(targetColIdx, 10);
    if (!isNaN(tColIdx) && tColIdx >= 1 && tColIdx <= 50) {
      noteRequests.push({
        updateCells: {
          range: {
            sheetId: cashTabSheetId,
            startRowIndex: rowNum - 1,
            endRowIndex: rowNum,
            startColumnIndex: tColIdx,
            endColumnIndex: tColIdx + 1
          },
          rows: [{ values: [{ note: targetNote || "" }] }],
          fields: "note"
        }
      });
    }
  }

  if (nextNote !== undefined && nextColIdx !== undefined && cashTabSheetId !== undefined) {
    const nColIdx = parseInt(nextColIdx, 10);
    if (!isNaN(nColIdx) && nColIdx >= 1 && nColIdx <= 50) {
      noteRequests.push({
        updateCells: {
          range: {
            sheetId: cashTabSheetId,
            startRowIndex: rowNum - 1,
            endRowIndex: rowNum,
            startColumnIndex: nColIdx,
            endColumnIndex: nColIdx + 1
          },
          rows: [{ values: [{ note: nextNote || "" }] }],
          fields: "note"
        }
      });
    }
  }

  if (noteRequests.length > 0) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: cleanClientSheetId,
      requestBody: { requests: noteRequests },
      _skipFormulaRecompute: true,
    }));
  }

  // 2. Update value(s) / formula(s)
  const valueData = [];
  if (targetValue !== undefined && cleanTargetCol && /^[B-Z]$|^A[A-K]$/.test(cleanTargetCol)) {
    const cleanTargetVal = typeof targetValue === "string" ? targetValue.trim().replace(/^['’]=/, "=") : targetValue;
    valueData.push({
      range: `Cash!${cleanTargetCol}${rowNum}`,
      values: [[sanitizeCashAdjustmentInput(cleanTargetVal ?? "")]]
    });
  }

  const cleanNextVal = typeof nextValue === "string" ? nextValue.trim().replace(/^['’]=/, "=") : nextValue;
  let safeNextVal = sanitizeCashAdjustmentInput(cleanNextVal ?? "");
  if (!isAdmin && typeof safeNextVal === "string" && safeNextVal.startsWith("=") && /^=[0-9+\-*/().\s]+$/.test(safeNextVal)) {
    try {
      const evaluated = Function(`"use strict"; return (${safeNextVal.slice(1)});`)();
      if (typeof evaluated === "number" && isFinite(evaluated)) {
        safeNextVal = Math.round(evaluated * 100) / 100;
      }
    } catch (_) { }
  }

  valueData.push({
    range: `Cash!${cleanNextCol}${rowNum}`,
    values: [[safeNextVal]]
  });

  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: cleanClientSheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: valueData
    }
  }));

  await invalidatePmaClientCache(cleanClientSheetId, null, ["cash"]).catch(() => { });

  (async () => {
    let resolvedClient = clientName || "";
    if (!resolvedClient) {
      resolvedClient = await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId);
    }
    await logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: resolvedClient,
      category: "CASH_RECON",
      action: "Cash Future Offset Applied",
      summary: `Applied future-month cash offset on row ${rowNum} (${cleanNextCol}${rowNum}: ${safeNextVal})`,
      details: {
        tab: "Cash",
        sheetRow: rowNum,
        targetColLetter: cleanTargetCol,
        nextColLetter: cleanNextCol,
        nextValue: safeNextVal,
        clientName: resolvedClient
      }
    });
  })().catch(e => console.error("PMA log failed:", e));

  return {
    success: true,
    sheetRow: rowNum,
    nextValue: safeNextVal,
    targetNote,
    nextNote
  };
}

/**
 * Batch match actuals: applies recon adjustment formulas and marks cells resolved in a single batch
 */
export async function batchMatchCashflowActuals({
  clientSheetId,
  cashTabSheetId,
  colIdx,
  colLetter,
  adjustments = [], // array of { sheetRow, formula }
  resolvedRows = [], // array of sheetRow numbers to mark resolved
  clientName,
  automationCommanderSheetId
}) {
  if (!clientSheetId || !colLetter || colIdx === undefined) {
    throw new Error("Missing clientSheetId, colLetter, or colIdx");
  }

  const sheets = await getSheetsClient();
  const cleanClientSheetId = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const colIndex = parseInt(colIdx, 10);
  const cleanCol = String(colLetter).trim().toUpperCase();
  const ALLOWED_ADJUSTMENT_ROWS = new Set([7, 9, 11, 13, 14, 15, 17, 19, 20, 21, 22, 25, 27, 29, 30]);
  if (!/^[B-Z]$|^A[A-K]$/.test(cleanCol) || isNaN(colIndex) || colIndex < 1 || colIndex > 36 || colIndexToLetter(colIndex + 1) !== cleanCol) {
    throw new Error("Invalid Cash column");
  }

  // 1. Batch update resolved background colors and optional cell notes FIRST while the sheet is idle (<1s)
  const validResolvedRows = (resolvedRows || []).map(r => parseInt(r, 10)).filter(r => !isNaN(r) && r >= 3 && r <= 80);
  const formatRequests = validResolvedRows.map(rowNum => ({
    repeatCell: {
      range: {
        sheetId: cashTabSheetId,
        startRowIndex: rowNum - 1,
        endRowIndex: rowNum,
        startColumnIndex: colIndex,
        endColumnIndex: colIndex + 1
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: RESOLVED_GREEN_RGB
        }
      },
      fields: "userEnteredFormat.backgroundColor"
    }
  }));

  const noteRequests = (adjustments || [])
    .filter(adj => adj?.note !== undefined && ALLOWED_ADJUSTMENT_ROWS.has(parseInt(adj?.sheetRow, 10)))
    .map(adj => {
      const rowNum = parseInt(adj.sheetRow, 10);
      return {
        updateCells: {
          range: {
            sheetId: cashTabSheetId,
            startRowIndex: rowNum - 1,
            endRowIndex: rowNum,
            startColumnIndex: colIndex,
            endColumnIndex: colIndex + 1
          },
          rows: [{ values: [{ note: String(adj.note || "") }] }],
          fields: "note"
        }
      };
    });

  const cellRequests = [...formatRequests, ...noteRequests];
  if (cellRequests.length > 0 && cashTabSheetId !== undefined && cashTabSheetId !== null) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: cleanClientSheetId,
      requestBody: {
        requests: cellRequests
      }
    }));
  }

  // 2. Batch update adjustment formulas SECOND so formatting never waits on formula recalculation
  if (adjustments.length > 0) {
    const hasG1 = adjustments.some(a => typeof a?.formula === "string" && a.formula.includes("KeyInfo!$G$1"));
    if (hasG1) {
      await ensureClientReconSheetUrl_(sheets, cleanClientSheetId, automationCommanderSheetId, clientName);
    }

    const dataUpdates = adjustments
      .filter(adj => ALLOWED_ADJUSTMENT_ROWS.has(parseInt(adj?.sheetRow, 10)))
      .map(adj => {
        const cleanFormula = typeof adj.formula === "string" ? adj.formula.trim().replace(/^['’]=/, "=") : adj.formula;
        return {
          range: `Cash!${cleanCol}${parseInt(adj.sheetRow, 10)}`,
          values: [[sanitizeCashAdjustmentInput(cleanFormula)]]
        };
      });

    if (dataUpdates.length > 0) {
      await withRetry(() => sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: cleanClientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: dataUpdates
        }
      }));
    }
  }

  await invalidatePmaClientCache(cleanClientSheetId, null, ["cash"]).catch(() => { });

  (async () => {
    let resolvedClient = clientName || "";
    if (!resolvedClient) {
      resolvedClient = await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId);
    }
    await logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: resolvedClient,
      category: "CASH_RECON",
      action: "Matched Actuals Applied",
      summary: `Applied actuals matching and resolved ${resolvedRows.length} items in target month ${colLetter}`,
      details: {
        tab: "Cash",
        colLetter,
        adjustmentsCount: adjustments.length,
        resolvedCount: resolvedRows.length,
        clientName: resolvedClient
      }
    });
  })().catch(e => console.error("PMA log failed:", e));

  return { success: true, count: adjustments.length };
}

/**
 * Updates cell DA1 (Accounting platform: Xero or Quickbooks) on the Recon Sheet
 */
export async function setReconDa1Platform({
  reconSheetId,
  tabName,
  platform
}) {
  if (!reconSheetId || !tabName || !platform) {
    throw new Error("Missing parameters for setReconDa1Platform");
  }
  const cleanTab = String(tabName || "").trim();
  if (!/^\d{4}$/.test(cleanTab)) {
    throw new Error("Invalid recon tabName: must be 4 digits (MMYY).");
  }
  tabName = cleanTab;
  const cleanPlatform = platform.toLowerCase().includes("quick") ? "Quickbooks" : "Xero";
  const sheets = await getSheetsClient();
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: reconSheetId,
    range: `'${tabName}'!DA1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[cleanPlatform]]
    }
  }));
  return { success: true, platform: cleanPlatform };
}

/**
 * Sets the "Reconciled & complete for P&L" status in cell CR2 (and CR1 header) of the Recon Sheet
 */
export async function setReconMonthReadyStatus({
  reconSheetId,
  tabName,
  isComplete,
  clientName,
  automationCommanderSheetId
}) {
  if (!reconSheetId || !tabName) {
    throw new Error("Missing reconSheetId or tabName");
  }
  const cleanTab = String(tabName || "").trim();
  if (!/^\d{4}$/.test(cleanTab)) {
    throw new Error("Invalid recon tabName: must be 4 digits (MMYY).");
  }
  tabName = cleanTab;
  const boolVal = Boolean(isComplete);
  const sheets = await getSheetsClient();
  const cleanId = extractSheetIdFromUrl(reconSheetId) || reconSheetId;

  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: cleanId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `'${tabName}'!CR1`,
          values: [["Month ready:"]]
        },
        {
          range: `'${tabName}'!CR2`,
          values: [[boolVal]]
        }
      ]
    }
  }));

  let resolvedClient = clientName || "";
  if (!resolvedClient && automationCommanderSheetId) {
    resolvedClient = await resolveClientNameBySheetId(sheets, cleanId, automationCommanderSheetId);
  }

  logPmaActivity(sheets, {
    automationCommanderSheetId,
    clientName: resolvedClient,
    category: "CASH_RECON",
    action: boolVal ? "Month marked complete for P&L" : "Month marked in-progress",
    summary: `${boolVal ? "Marked complete for P&L" : "Marked in-progress"} on ${tabName}!CR2`,
    details: {
      tab: tabName,
      cellRef: "CR2",
      isComplete: boolVal,
      clientName: resolvedClient
    }
  }).catch(e => console.error("PMA log failed:", e));

  return { success: true, isComplete: boolVal };
}

/**
 * Dismisses "new" badges on bank transactions by resetting background color of columns B:P to white
 */
export async function dismissNewBankTransactions({
  reconSheetId,
  tabName,
  clientName,
  automationCommanderSheetId
}) {
  if (!reconSheetId || !tabName) {
    throw new Error("Missing reconSheetId or tabName");
  }
  const cleanTab = String(tabName || "").trim();
  if (!/^\d{4}$/.test(cleanTab)) {
    throw new Error("Invalid recon tabName: must be 4 digits (MMYY).");
  }
  tabName = cleanTab;

  const sheets = await getSheetsClient();
  const cleanId = extractSheetIdFromUrl(reconSheetId) || reconSheetId;
  const tabGid = await getSheetGid(sheets, cleanId, tabName);

  // Reset background color of B3:P200 to white
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cleanId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: tabGid,
            startRowIndex: 2, // Row 3
            endRowIndex: 200,
            startColumnIndex: 1, // Col B
            endColumnIndex: 16   // Col P
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: WHITE_RGB
            }
          },
          fields: "userEnteredFormat.backgroundColor"
        }
      }]
    }
  }));

  let resolvedClient = clientName || "";
  if (!resolvedClient && automationCommanderSheetId) {
    resolvedClient = await resolveClientNameBySheetId(sheets, cleanId, automationCommanderSheetId);
  }

  logPmaActivity(sheets, {
    automationCommanderSheetId,
    clientName: resolvedClient,
    category: "CASH_RECON",
    action: "New transactions dismissed",
    summary: `Dismissed new bank transaction highlights on ${tabName}`,
    details: {
      tab: tabName,
      clientName: resolvedClient
    }
  }).catch(e => console.error("PMA log failed:", e));

  return { success: true };
}

