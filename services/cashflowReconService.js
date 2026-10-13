import { getSheetsClient, withRetry, colLetterToNum, extractSheetIdFromUrl } from "./sheetsClient.js";
import { resolveClientNameBySheetId } from "./workspaces.js";
import { logPmaActivity } from "./pmaLogger.js";
import { parseMonthHeader, FULL_MONTH_NAMES } from "./viewsService.js";
import { sanitizeFormulaInput } from "./userPermissions.js";


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
 * Securely sanitizes cash adjustment inputs before updating Google Sheets.
 * If the input is an arithmetic expression or formula (=1234-E19, =E19+100, =SUM(...)),
 * it validates that it does NOT contain dangerous functions (IMPORT*, HYPERLINK, WEBSERVICE, etc.)
 * or DDE / shell injection commands.
 * If safe, returns the formula as-is so Google Sheets calculates it.
 * If it contains dangerous or unrecognized tokens, it neutralizes it with a leading quote '.
 */
export function sanitizeCashAdjustmentInput(val) {
  if (val === null || val === undefined) return "";
  const str = String(val).trim();
  if (!str) return "";

  // 1. Valid finite numbers are always safe
  if (!isNaN(Number(str))) return str;

  // 2. If it begins with '=', validate if it's a safe spreadsheet formula
  if (str.startsWith("=")) {
    // Length safety check
    if (str.length > 500) {
      return `'${str}`;
    }

    // Strictly forbid dangerous exfiltration / external execution keywords
    const dangerousPattern = /(importxml|importhtml|importdata|importfeed|importrange|hyperlink|image|webservice|encodeurl|cmd|powershell|exec|script|shell|http:|https:|ftp:|file:)/i;
    if (dangerousPattern.test(str)) {
      return `'${str}`;
    }

    // Strictly forbid shell pipe, semicolons, backticks
    if (/[|;`]/.test(str)) {
      return `'${str}`;
    }

    // Validate that the formula only contains safe arithmetic, cell coordinates, and safe math functions
    let stripped = str.slice(1);
    // Strip allowed function names
    stripped = stripped.replace(/\b(SUM|ROUND|ABS|MIN|MAX|AVERAGE|SUBTOTAL|IF|INT)\s*\(/gi, "(");
    // Strip sheet references e.g. Cash! or 'Cash'!
    stripped = stripped.replace(/('?[A-Za-z0-9_ ]+'?!)?[A-Z]+[0-9]+(:[A-Z]+[0-9]+)?/gi, "1");
    // Strip numbers
    stripped = stripped.replace(/[0-9]+(\.[0-9]+)?/g, "1");
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
    const isCorpTax = lowerLabel.includes("corporation tax") && !lowerLabel.includes("adjustment");
    const isVat = (lowerLabel === "vat" || lowerLabel.startsWith("vat ") || lowerLabel.includes(" vat")) && !lowerLabel.includes("adjustment");

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
    } else if (isCorpTax) {
      mappedItemType = "corporation_tax";
      targetAdjustmentRow = 20; // Corporation tax adjustment
    } else if (isVat) {
      mappedItemType = "vat";
      targetAdjustmentRow = 22; // VAT adjustment
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
  let hasTargetTab = false;
  let canAutoCreateTab = false;

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
        reconError = `Recon tab '${reconTabName}' not found in Recon Sheet (available tabs: ${availableReconTabs.filter(t => /^\d{4}$/.test(t)).join(", ") || "none"}). Click 'Create Tab' to auto-provision from Template.`;
      } else {
        // Fetch all sections in a single batchGet
        const rangesToFetch = [
          `'${reconTabName}'!U3:X16`,    // [0] Totals
          `'${reconTabName}'!A3:Q200`,   // [1] Bank transactions
          `'${reconTabName}'!U20:X50`,   // [2] Comparisons
          `'${reconTabName}'!Z4:AR60`,   // [3] Revenue breakdown
          `'${reconTabName}'!AT4:BL40`,  // [4] Contractors breakdown
          `'${reconTabName}'!AT48:BK75`, // [5] Direct costs breakdown
          `'${reconTabName}'!CD4:CN60`,  // [6] Unreconciled items
          `'${reconTabName}'!CZ3:DA60`,  // [7] P&L Adds by account & categories
          `'KeyInfo'!H12:H22`            // [8] Tracked bank accounts
        ];

        const reconBatchRes = await withRetry(() => sheets.spreadsheets.values.batchGet({
          spreadsheetId: cleanReconSheetId,
          ranges: rangesToFetch,
          valueRenderOption: "FORMATTED_VALUE"
        }));

        const vRanges = reconBatchRes.data.valueRanges || [];

        // Parse [8] Tracked Bank Accounts from KeyInfo!H12:H22 early
        const rawAccounts = vRanges[8]?.values || [];
        trackedBankAccounts = rawAccounts
          .map(r => String(r[0] || "").trim())
          .filter(Boolean);

        // Parse [0] U3:X16 Totals
        const rawReconRows = vRanges[0]?.values || [];
        let revenue = 0, salaries = 0, dividends = 0, contractors = 0, directCosts = 0, outgoings = 0, vat = 0, corpTax = 0;

        rawReconRows.forEach(r => {
          const label = String(r[0] || "").trim().toLowerCase();
          const val = parseNumeric(r[3]); // Column X (Total)
          if (label.includes("revenue")) revenue += val;
          else if (label.includes("salaries") || label.includes("salary") || label.includes("paye") || label.includes("pension")) salaries += val;
          else if (label.includes("dividend")) dividends += val;
          else if (label.includes("contractor")) contractors += val;
          else if (label.includes("direct cost")) directCosts += val;
          else if (label.includes("outgoing")) outgoings += val;
          else if (label.includes("vat")) vat += val;
          else if (label.includes("corp") || label.includes("corporation tax") || (label.includes("tax") && !label.includes("vat"))) corpTax += val;
        });

        reconActuals = { revenue, salaries, dividends, contractors, directCosts, outgoings, vat, corpTax, tabName: reconTabName };

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
            source: "recon_sheet"
          };
        }).filter(t => t.date || t.payee || t.outAmount || t.inAmount);

        // Parse [2] Comparisons from U3:X16 (Categories) + U20:X50 (Forecasts)
        const rawCompRows = vRanges[2]?.values || [];

        const isFormulaError = (val) => {
          if (val == null) return false;
          const s = String(val).trim();
          return s.startsWith("#") || s === "—";
        };

        const mapCategoryToForecast = (catName, compRows) => {
          const norm = catName.toLowerCase().trim();
          for (let i = 0; i < compRows.length; i++) {
            const row = compRows[i];
            const rLabel = String(row[0] || "").trim().toLowerCase();
            const rSub = String(row[1] || "").trim().toLowerCase();
            let matches = false;
            if (norm === "revenue" && rLabel.includes("revenue")) matches = true;
            else if (norm === "contractors" && rLabel.includes("contractor")) matches = true;
            else if (norm === "direct costs" && rLabel.includes("direct cost")) matches = true;
            else if (norm === "dividends" && rLabel.includes("dividend")) matches = true;
            else if (norm === "salaries" && (rSub.includes("payroll") || (rLabel.includes("salar") && !rSub))) matches = true;
            else if (norm === "paye" && (rSub.includes("paye") || rLabel.includes("paye"))) matches = true;
            else if (norm === "pension" && (rSub.includes("pension") || rLabel.includes("pension"))) matches = true;
            else if (norm === "outgoings" && (rLabel.includes("other exp") || rLabel.includes("outgoing"))) matches = true;
            else if (norm === "corp tax" && (rLabel.includes("corp") || rLabel.includes("tax"))) matches = true;
            else if (norm === "vat" && rLabel.includes("vat")) matches = true;
            else if (norm === "other" && rLabel.includes("other")) matches = true;

            if (matches && row[2]) {
              const forecastVal = String(row[2]).trim();
              const diffVal = (i + 1 < compRows.length && !compRows[i + 1][0]) ? String(compRows[i + 1][3] || "").trim() : "";
              return { cashflow: forecastVal, diff: diffVal };
            }
          }
          return { cashflow: "—", diff: "" };
        };

        const canonicalCategories = [
          "Revenue", "Outgoings", "Contractors", "Direct costs", "Dividends",
          "Salaries", "PAYE", "Pension", "Transfer", "Corp tax", "VAT", "Other"
        ];

        // Map categories from rawReconRows (U3:X16), falling back to canonical list if sheet range empty
        const sourceRows = (rawReconRows && rawReconRows.length > 0)
          ? rawReconRows
          : canonicalCategories.map(c => [c, "£0.00", "£0.00", "£0.00"]);

        cashflowComparisons = sourceRows.map(r => {
          const catLabel = String(r[0] || "").trim();
          if (!catLabel || isFormulaError(catLabel)) return null;
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
              matched: r[17] || "",
              manual: r[18] || ""
            });
          }
        });
        directCostsBreakdown = { bankItems: dcBank, pulseDirectCosts: dcPulse };

        // Parse [6] Unreconciled Items CD4:CN60
        const rawUnreconRows = vRanges[6]?.values || [];
        unreconciledItems = rawUnreconRows.map((r, i) => {
          const date = r[2] || "";
          const payee = r[3] || "";
          const particulars = r[4] || "";
          const amount = r[5] || "";
          const category = r[9] || "";
          const vat = r[10] || "";
          return {
            rowNum: i + 4,
            date,
            payee,
            particulars,
            amount,
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
            .filter(Boolean);
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

  return {
    success: true,
    clientSheetId: cleanClientSheetId,
    cashTabSheetId,
    reconSheetId: cleanReconSheetId,
    targetMonthLabel: `${FULL_MONTH_NAMES[targetMonthInfo.month]} ${targetMonthInfo.year}`,
    targetMonthKey: `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}`,
    reconTabName,
    hasTargetTab,
    canAutoCreateTab,
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
    plAdds,
    plAccountOptions: plAccountOptions || [],
    trackedBankAccounts: trackedBankAccounts || []
  };
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
  const targetRange = `'${tabName}'!Q${rowNum}`;

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: cleanId,
    range: targetRange,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[category || ""]] }
  }));

  return { success: true, tabName, rowNum, category };
}

/**
 * Writes a full list of bank transactions to columns A3:J and Q3:Q in the Recon Sheet
 */
export async function syncReconBankTransactions({
  reconSheetId,
  tabName,
  transactions = []
}) {
  if (!reconSheetId || !tabName) {
    throw new Error("Missing reconSheetId or tabName");
  }

  const sheets = await getSheetsClient();
  const cleanId = extractSheetIdFromUrl(reconSheetId) || reconSheetId;

  // Clear existing A3:J150 and Q3:Q150
  await withRetry(() => sheets.spreadsheets.values.batchClear({
    spreadsheetId: cleanId,
    requestBody: {
      ranges: [`'${tabName}'!A3:J200`, `'${tabName}'!Q3:Q200`]
    }
  }));

  if (transactions.length === 0) {
    return { success: true, count: 0 };
  }

  const rowsAJ = [];
  const rowsQ = [];

  transactions.forEach(tx => {
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
    rowsAJ.push([date, date, accountName, payee, particulars, ref, "", "", outAmt, inAmt]);
    rowsQ.push([cat]);
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

  const sheets = await getSheetsClient();
  const cleanId = extractSheetIdFromUrl(reconSheetId) || reconSheetId;

  // Clear existing CD4:CI100 and CM4:CN100
  await withRetry(() => sheets.spreadsheets.values.batchClear({
    spreadsheetId: cleanId,
    requestBody: {
      ranges: [`'${tabName}'!CD4:CI100`, `'${tabName}'!CM4:CN100`]
    }
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
    const amt = u.amount ? (u.isNegative ? `-${Math.abs(u.amount)}` : String(u.amount)) : "";
    const cat = u.category || "";
    const vat = u.vatApplies || "No";

    // CD:CI: [CD: '', CE: '', CF: Date, CG: Payee, CH: Particulars, CI: Amount]
    rowsCD.push(["", "", date, payee, particulars, amt]);
    // CM:CN: [CM: Category, CN: VAT?]
    rowsCM.push([cat, vat]);
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

  const safeValue = sanitizeCashAdjustmentInput(value ?? "");

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
