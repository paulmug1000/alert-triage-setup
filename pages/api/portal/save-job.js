import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, sanitizeFormulaInput, sanitizeJobSlice, isReadOnlySession } from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache, invalidatePmaClientCache } from "../../../services/cacheService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";
import {
  provisionRetainerChildRows_,
  createVariableRetainerSeries_,
  handleUpdateVariableRetainerBase,
  handleUpdateVariableRetainerMonth,
  handleSaveVariableRetainerSeries_,
} from "../../../services/retainers.js";
import { getToleranceValues } from "../../../services/sharedHelpers.js";
import {
  resolveMasterSheetIdForClient_,
  calculateRevenueSplit,
  generateAutoPlaceholderRef_,
  isAutoInvoicePlaceholderRef_,
  isAutoExpensePlaceholderId_,
} from "../../../services/workspaces.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes } from "../../../services/masterEngineService.js";
import { resolveAuthoritativeJobAnchor, getClientRelationalJobsLookup } from "../../../services/relationalJobsService.js";
import { relinkNotesForJobChange } from "../../../services/pulseNotesService.js";
import { buildJobNoteKey, buildJobNoteLabel } from "../../../utils/pulseNotesKeys.js";
import {
  canonicalizeInvoiceStatus,
  canonicalizeExpenseStatus,
  formatInvoiceRefForSheet,
  toSheetDateFormat,
  parseSheetDate,
  hasActiveCrmIntegration,
  isCrmDrivenTab,
  getCrmDisplayName,
  assertTrustedOrigin,
  sanitizeSpreadsheetTerms,
  NO_END_DATE_SHEET_VALUE,
  isNoEndDateSentinel,
  isJobCostingStyle,
  isJobCostingColJLikelihoodFormula,
  getJobCostingRowFormulasMap,
  buildJobRowClearAndRestorePlan,
  normalizeLikelihoodInput,
  isPlaceholderInvoice,
  isPlaceholderExpense,
  parseVariableRetainerTag,
  formatVariableRetainerTag,
  isValidDateInputValue,
  validateDateRange,
  resolveEditableJobSheetMeta,
  isContiguousJobChildRow,
} from "../../../utils/helpers.js";

// Helper to convert 0-indexed column number to letters (e.g. 0 -> A, 27 -> AB)
function colToLetter(colIndex) {
  let temp, letter = "";
  let c = colIndex + 1;
  while (c > 0) {
    temp = (c - 1) % 26;
    letter = String.fromCharCode(65 + temp) + letter;
    c = Math.floor((c - temp - 1) / 26);
  }
  return letter;
}

const parseMoney = (val) => {
  if (val === undefined || val === null || val === "") return "";
  const num = parseFloat(String(val).replace(/[£$€,\s]/g, ""));
  return isNaN(num) ? sanitizeFormulaInput(String(val)) : num;
};

const formatDate = (val) => {
  if (!val) return "";
  const formatted = toSheetDateFormat(val);
  if (formatted) return formatted;
  const str = String(val).trim();
  if (!str) return "";
  return sanitizeFormulaInput(str);
};

const parseNumber = (val, defaultVal = "") => {
  if (val === undefined || val === null || val === "") return defaultVal;
  const num = parseFloat(String(val).replace(/[£$€,\s%]/g, ""));
  return isNaN(num) ? sanitizeFormulaInput(String(val)) : num;
};

const parseText = (val) => {
  if (val === undefined || val === null) return "";
  return sanitizeFormulaInput(String(val).trim());
};

const parseInvoiceStatus = (val) => {
  if (val === undefined || val === null) return "";
  const s = canonicalizeInvoiceStatus(val);
  if (s.toLowerCase() === "pending") return "";
  return sanitizeFormulaInput(s);
};

const parseExpenseStatus = (val) => {
  if (val === undefined || val === null) return "";
  const s = canonicalizeExpenseStatus(val);
  if (s.toLowerCase() === "pending") return "";
  return sanitizeFormulaInput(s);
};

/**
 * Finds the last row containing actual job data in cols 1-39 or invoice columns.
 */
async function findLastJobRow(sheets, spreadsheetId, sheetName, minRow = 1, cachedRowsRef = null) {
  const isConfirmed = sheetName === "Confirmed" || sheetName === "ConfCalcs";
  const invEndCol = isConfirmed ? "BJ" : "BH";
  const invSliceEnd = isConfirmed ? 62 : 60;
  let allRows = cachedRowsRef?.rows || null;
  if (!allRows) {
    const dataResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:${invEndCol}`,
        valueRenderOption: "FORMATTED_VALUE",
      })
    );
    allRows = dataResp.data?.values || [];
    if (cachedRowsRef) cachedRowsRef.rows = allRows;
  }
  let lastJobRow = minRow;
  for (let r = allRows.length - 1; r >= 0; r--) {
    const rowData = allRows[r] || [];
    const hasDataA = rowData.slice(0, 39).some((v) => v !== undefined && String(v).trim() !== "");
    const hasDataB = rowData.slice(41, invSliceEnd).some((v) => v !== undefined && String(v).trim() !== "");
    if (hasDataA || hasDataB) {
      lastJobRow = Math.max(lastJobRow, r + 1);
      break;
    }
  }
  return lastJobRow;
}

/**
 * Finds the second blank row after all job data and moves it directly after insertAfterRow.
 * Matches the original GAS findAndMoveBlankRow logic 1:1.
 */
async function findAndMoveBlankRow(sheets, spreadsheetId, sheetId, sheetName, insertAfterRow, cachedRowsRef = null) {
  const isConfirmed = sheetName === "Confirmed" || sheetName === "ConfCalcs";
  const invEndCol = isConfirmed ? "BJ" : "BH";
  const invSliceEnd = isConfirmed ? 62 : 60;
  let allRows = cachedRowsRef?.rows || null;
  if (!allRows) {
    const dataResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:${invEndCol}`,
        valueRenderOption: "FORMATTED_VALUE",
      })
    );
    allRows = dataResp.data?.values || [];
    if (cachedRowsRef) cachedRowsRef.rows = allRows;
  }
  let lastJobRow = insertAfterRow;
  for (let r = allRows.length - 1; r >= 0; r--) {
    const rowData = allRows[r] || [];
    const hasDataA = rowData.slice(0, 39).some((v) => v !== undefined && String(v).trim() !== "");
    const hasDataB = rowData.slice(41, invSliceEnd).some((v) => v !== undefined && String(v).trim() !== "");
    if (hasDataA || hasDataB) {
      lastJobRow = Math.max(lastJobRow, r + 1);
      break;
    }
  }

  // Find at least 2 blank rows after lastJobRow
  const blankRows = [];
  for (let r = lastJobRow + 1; r <= allRows.length + 50; r++) {
    const rowData = r <= allRows.length ? allRows[r - 1] || [] : [];
    const isBlankA = !rowData.slice(0, 39).some((v) => v !== undefined && String(v).trim() !== "");
    const isBlankB = !rowData.slice(41, invSliceEnd).some((v) => v !== undefined && String(v).trim() !== "");
    if (isBlankA && isBlankB) {
      blankRows.push(r);
      if (blankRows.length >= 2) break;
    }
  }

  if (blankRows.length < 2) {
    throw new Error(`Need at least 2 blank rows after job data. Found ${blankRows.length}`);
  }

  // Use the SECOND blank row (original GAS Step 4)
  const blankRowToMove = blankRows[1];
  const targetRow = insertAfterRow + 1;

  if (blankRowToMove === targetRow) {
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateDimensionProperties: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: targetRow - 1,
                  endIndex: targetRow,
                },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            },
          ],
        },
      })
    );
    return targetRow;
  }

  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateDimensionProperties: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: blankRowToMove - 1,
                endIndex: blankRowToMove,
              },
              properties: { hiddenByUser: false },
              fields: "hiddenByUser",
            },
          },
          {
            moveDimension: {
              source: {
                sheetId,
                dimension: "ROWS",
                startIndex: blankRowToMove - 1,
                endIndex: blankRowToMove,
              },
              destinationIndex: targetRow - 1,
            },
          },
        ],
      },
      _skipFormulaRecompute: true,
    })
  );

  // Update cachedRowsRef in memory to reflect moved row
  if (cachedRowsRef?.rows && Array.isArray(cachedRowsRef.rows)) {
    const movedRow = cachedRowsRef.rows.splice(blankRowToMove - 1, 1)[0] || [];
    cachedRowsRef.rows.splice(targetRow - 1, 0, movedRow);
  }

  return targetRow;
}

/**
 * Writes parent row values into rowArray preserving formulas in unmapped columns.
 */
function applyParentRowValues(rowArray, job, cols, invoiceSlots, expenseSlots, options = {}) {
  const { isJobCosting = false, sheetName = "Confirmed", rowNum = 2, canEnterFormulas = false } = options;

  // Basic Info
  if (cols.client !== -1 && job.client !== undefined) rowArray[cols.client] = parseText(job.client);
  if (cols.jobName !== -1 && job.jobName !== undefined) rowArray[cols.jobName] = parseText(job.jobName);
  if (cols.projectCode !== -1 && job.projectCode !== undefined) rowArray[cols.projectCode] = parseText(job.projectCode);
  if (cols.lead !== -1 && job.lead !== undefined) rowArray[cols.lead] = parseText(job.lead);
  if (cols.dateConfirmed !== -1 && job.dateConfirmed !== undefined) rowArray[cols.dateConfirmed] = formatDate(job.dateConfirmed);
  if (cols.leadSource !== -1 && job.leadSource !== undefined) rowArray[cols.leadSource] = parseText(job.leadSource);
  if (cols.splitStr !== -1 && job.splitStr !== undefined) rowArray[cols.splitStr] = parseText(job.splitStr);
  if (cols.vat !== -1 && job.vat !== undefined) rowArray[cols.vat] = parseText(job.vat);
  if (cols.projectRetainer !== -1 && job.projectRetainer !== undefined) rowArray[cols.projectRetainer] = parseText(job.projectRetainer);
  if (cols.productLine !== -1 && job.productLine !== undefined) rowArray[cols.productLine] = parseText(job.productLine);

  const isRet = String(job.projectRetainer || "").trim().toLowerCase() === "retainer";
  const resolvedEndDate =
    job.noEndDate || isNoEndDateSentinel(job.endDate) || (isRet && !String(job.endDate || "").trim())
      ? NO_END_DATE_SHEET_VALUE
      : job.endDate !== undefined
        ? formatDate(job.endDate)
        : undefined;

  if (isJobCosting) {
    // Check if this is an older legacy static row (has static values in AG/AL and empty F/G/I and no formula in AG/AL)
    const hasExistingFGI =
      (rowArray[5] !== "" && rowArray[5] !== undefined) ||
      (rowArray[6] !== "" && rowArray[6] !== undefined) ||
      (rowArray[8] !== "" && rowArray[8] !== undefined);
    const hasFormulasInAgAl =
      (typeof rowArray[32] === "string" && rowArray[32].startsWith("=")) ||
      (typeof rowArray[37] === "string" && rowArray[37].startsWith("="));
    const isLegacyStaticRow =
      !hasExistingFGI &&
      !hasFormulasInAgAl &&
      ((rowArray[32] !== "" && rowArray[32] !== undefined) || (rowArray[37] !== "" && rowArray[37] !== undefined)) &&
      job.jobRevenue === undefined &&
      job.contractorCosts === undefined &&
      job.rechargedExpenses === undefined;

    if (isLegacyStaticRow) {
      if (cols.revenue !== -1 && job.revenue !== undefined) rowArray[cols.revenue] = parseMoney(job.revenue);
      if (cols.directCosts !== -1 && job.directCosts !== undefined) rowArray[cols.directCosts] = parseMoney(job.directCosts);
      if (cols.startDate !== -1 && job.startDate !== undefined) rowArray[cols.startDate] = formatDate(job.startDate);
      if (cols.endDate !== -1 && resolvedEndDate !== undefined) rowArray[cols.endDate] = resolvedEndDate;
    } else {
      // Standard JobCosting row: write inputs to Cols F..AB and preserve/populate formulas in M, N, O, U, AG, AH, AL, AM
      if (cols.jobStartDate !== -1 && job.startDate !== undefined) {
        rowArray[cols.jobStartDate] = formatDate(job.startDate);
      }
      if (cols.jobEndDate !== -1 && resolvedEndDate !== undefined) {
        rowArray[cols.jobEndDate] = resolvedEndDate;
      }
      if (cols.fixedVariable !== -1 && job.fixedVariable !== undefined) {
        rowArray[cols.fixedVariable] = parseText(job.fixedVariable);
      }
      const baseJobRev = job.jobRevenue !== undefined ? job.jobRevenue : job.revenue;
      if (cols.jobRevenue !== -1 && baseJobRev !== undefined) {
        rowArray[cols.jobRevenue] = parseMoney(baseJobRev);
      }
      if (cols.contractorCosts !== -1 && job.contractorCosts !== undefined) {
        const rawCc = String(job.contractorCosts ?? "").trim();
        if (rawCc === "") {
          rowArray[cols.contractorCosts] = sheetName === "Confirmed" ? `=M${rowNum}*KeyInfo!$D$13` : "";
        } else if (rawCc.startsWith("=")) {
          rowArray[cols.contractorCosts] = canEnterFormulas ? rawCc : sanitizeFormulaInput(rawCc);
        } else {
          rowArray[cols.contractorCosts] = parseMoney(rawCc);
        }
      }
      if (cols.externalCosts !== -1 && job.externalCosts !== undefined) {
        rowArray[cols.externalCosts] = parseMoney(job.externalCosts);
      }
      if (cols.propSuccFeePct !== -1 && job.propSuccFeePct !== undefined) {
        const rawPct = String(job.propSuccFeePct ?? "").replace(/[%\s]/g, "");
        if (rawPct === "") {
          rowArray[cols.propSuccFeePct] = "";
        } else {
          const n = parseFloat(rawPct);
          rowArray[cols.propSuccFeePct] = isNaN(n) ? "" : n > 1 ? n / 100 : n;
        }
      }
      if (cols.propSuccFeeRec !== -1 && job.propSuccFeeRec !== undefined) {
        rowArray[cols.propSuccFeeRec] = parseText(job.propSuccFeeRec);
      }
      if (cols.invNo !== -1 && job.invNo !== undefined) {
        rowArray[cols.invNo] = parseText(job.invNo);
      }

      const fMap = getJobCostingRowFormulasMap(sheetName, rowNum);
      for (const [colStr, formula] of Object.entries(fMap)) {
        const c = Number(colStr);
        // Preserve custom contractorCosts value or formula in K (col 10) if one was set
        if (c === 10 && rowArray[10] !== "" && rowArray[10] !== undefined) continue;
        rowArray[c] = formula;
      }
      if (
        sheetName === "Pipeline" &&
        typeof rowArray[24] === "string" &&
        /^=\s*\$?I\$?\d+\s*\*\s*\$?X\$?\d+\s*$/i.test(rowArray[24].trim())
      ) {
        rowArray[24] = `=I${rowNum}*X${rowNum}`;
      }
    }
  } else {
    if (cols.revenue !== -1 && job.revenue !== undefined) rowArray[cols.revenue] = parseMoney(job.revenue);
    if (cols.directCosts !== -1 && job.directCosts !== undefined) rowArray[cols.directCosts] = parseMoney(job.directCosts);
    if (cols.startDate !== -1 && job.startDate !== undefined) rowArray[cols.startDate] = formatDate(job.startDate);
    if (cols.endDate !== -1 && resolvedEndDate !== undefined) rowArray[cols.endDate] = resolvedEndDate;
  }

  // Recharged expenses (Confirmed only — Standard and JobCosting share Col R / idx 17)
  if (cols.rechargedExpenses !== -1 && job.rechargedExpenses !== undefined) {
    const rechVal = parseMoney(job.rechargedExpenses);
    rowArray[cols.rechargedExpenses] = rechVal === 0 ? "" : rechVal;
  }

  if (cols.likelihood !== -1 && job.likelihood !== undefined) {
    const normalizedLikel = normalizeLikelihoodInput(parseText(job.likelihood));
    if (isJobCosting && sheetName === "Pipeline" && isJobCostingColJLikelihoodFormula(rowArray[cols.likelihood])) {
      rowArray[9] = normalizedLikel;
      rowArray[cols.likelihood] = `=J${rowNum}`;
    } else if (!(typeof rowArray[cols.likelihood] === "string" && rowArray[cols.likelihood].startsWith("="))) {
      rowArray[cols.likelihood] = normalizedLikel;
    }
  }
  if (cols.prodTime !== -1 && job.prodTime !== undefined) rowArray[cols.prodTime] = parseNumber(job.prodTime);

  // Invoices (slots 1-3)
  for (let s = 1; s <= 3; s++) {
    const invMap = cols.inv[s - 1];
    const inv = invoiceSlots?.[s];
    if (inv) {
      if (invMap.amount !== -1) rowArray[invMap.amount] = parseMoney(inv.amount);
      if (invMap.ref !== -1) rowArray[invMap.ref] = formatInvoiceRefForSheet(inv.ref);
      if (invMap.sendDate !== -1) rowArray[invMap.sendDate] = formatDate(inv.sendDate);
      if (invMap.days !== -1) rowArray[invMap.days] = parseNumber(inv.days, 30);
      if (invMap.status !== -1) rowArray[invMap.status] = parseInvoiceStatus(inv.status);
      if (invMap.rechgd !== -1 && inv.ofWhichRechgd !== undefined) {
        const rv = parseMoney(inv.ofWhichRechgd);
        rowArray[invMap.rechgd] = rv === 0 ? "" : rv;
      }
      if (invMap.costMonth !== -1 && inv.costMonth !== undefined) {
        rowArray[invMap.costMonth] = parseText(inv.costMonth);
      }
      if (invMap.desc !== -1 && inv.desc !== undefined) rowArray[invMap.desc] = parseText(inv.desc);
    } else {
      if (invMap.amount !== -1) rowArray[invMap.amount] = "";
      if (invMap.ref !== -1) rowArray[invMap.ref] = "";
      if (invMap.sendDate !== -1) rowArray[invMap.sendDate] = "";
      if (invMap.days !== -1) rowArray[invMap.days] = "";
      if (invMap.status !== -1) rowArray[invMap.status] = "";
      if (invMap.rechgd !== -1) rowArray[invMap.rechgd] = "";
      if (invMap.costMonth !== -1) rowArray[invMap.costMonth] = "";
      if (invMap.desc !== -1) rowArray[invMap.desc] = "";
    }
  }

  // Direct Expenses (slots 1-3)
  for (let s = 1; s <= 3; s++) {
    const dirMap = cols.dir[s - 1];
    const exp = expenseSlots?.[s];
    if (exp) {
      if (dirMap.desc !== -1) rowArray[dirMap.desc] = parseText(exp.desc);
      if (dirMap.amount !== -1) rowArray[dirMap.amount] = parseMoney(exp.amount);
      if (dirMap.vat !== -1) rowArray[dirMap.vat] = parseText(exp.vat || "Yes");
      if (dirMap.recDate !== -1) rowArray[dirMap.recDate] = formatDate(exp.recDate);
      if (dirMap.days !== -1) rowArray[dirMap.days] = parseNumber(exp.days, 30);
      if (dirMap.status !== -1) rowArray[dirMap.status] = parseExpenseStatus(exp.status);
      if (dirMap.appId !== -1 && exp.appId !== undefined) rowArray[dirMap.appId] = parseText(exp.appId);
    } else {
      if (dirMap.desc !== -1) rowArray[dirMap.desc] = "";
      if (dirMap.amount !== -1) rowArray[dirMap.amount] = "";
      if (dirMap.vat !== -1) rowArray[dirMap.vat] = "";
      if (dirMap.recDate !== -1) rowArray[dirMap.recDate] = "";
      if (dirMap.days !== -1) rowArray[dirMap.days] = "";
      if (dirMap.status !== -1) rowArray[dirMap.status] = "";
      if (dirMap.appId !== -1) rowArray[dirMap.appId] = "";
    }
  }
}

/**
 * Writes child row values into rowArray.
 * Child rows inherit Client, Job Name, and VAT? from parent.
 * Revenue, Direct Costs, Dates, etc. are cleared.
 */
function applyChildRowValues(rowArray, job, cols, invoiceSlots, expenseSlots, options = {}) {
  const { isJobCosting = false, sheetName = "Confirmed", rowNum = 3 } = options;

  // Inherit Client, Job name, and VAT status from parent (critical for VAT & calculation formulas)
  if (cols.client !== -1 && job.client !== undefined) rowArray[cols.client] = parseText(job.client);
  if (cols.jobName !== -1 && job.jobName !== undefined) rowArray[cols.jobName] = parseText(job.jobName);
  if (cols.vat !== -1 && job.vat !== undefined) rowArray[cols.vat] = parseText(job.vat);

  // Clear non-inherited fields so child rows never have duplicate revenue, costs, dates, etc.
  if (cols.dateConfirmed !== -1) rowArray[cols.dateConfirmed] = "";
  if (cols.projectCode !== -1) rowArray[cols.projectCode] = "";
  if (cols.productLine !== -1) rowArray[cols.productLine] = "";
  if (cols.leadSource !== -1) rowArray[cols.leadSource] = "";
  if (cols.splitStr !== -1) rowArray[cols.splitStr] = "";
  if (cols.likelihood !== -1) rowArray[cols.likelihood] = "";

  if (cols.rechargedExpenses !== -1) rowArray[cols.rechargedExpenses] = "";

  if (isJobCosting) {
    for (const c of [5, 6, 7, 8, 9, 11, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 28, 29, 31]) {
      rowArray[c] = "";
    }
    const fMap = getJobCostingRowFormulasMap(sheetName, rowNum);
    for (const [colStr, formula] of Object.entries(fMap)) {
      rowArray[Number(colStr)] = formula;
    }
  } else {
    if (cols.revenue !== -1) rowArray[cols.revenue] = "";
    if (cols.directCosts !== -1) rowArray[cols.directCosts] = "";
    if (cols.startDate !== -1) rowArray[cols.startDate] = "";
    if (cols.endDate !== -1) rowArray[cols.endDate] = "";
  }

  // Invoices (slots 1-3)
  for (let s = 1; s <= 3; s++) {
    const invMap = cols.inv[s - 1];
    const inv = invoiceSlots?.[s];
    if (inv) {
      if (invMap.amount !== -1) rowArray[invMap.amount] = parseMoney(inv.amount);
      if (invMap.ref !== -1) rowArray[invMap.ref] = formatInvoiceRefForSheet(inv.ref);
      if (invMap.sendDate !== -1) rowArray[invMap.sendDate] = formatDate(inv.sendDate);
      if (invMap.days !== -1) rowArray[invMap.days] = parseNumber(inv.days, 30);
      if (invMap.status !== -1) rowArray[invMap.status] = parseInvoiceStatus(inv.status);
      if (invMap.rechgd !== -1 && inv.ofWhichRechgd !== undefined) {
        const rv = parseMoney(inv.ofWhichRechgd);
        rowArray[invMap.rechgd] = rv === 0 ? "" : rv;
      }
      if (invMap.costMonth !== -1 && inv.costMonth !== undefined) {
        rowArray[invMap.costMonth] = parseText(inv.costMonth);
      }
      if (invMap.desc !== -1 && inv.desc !== undefined) rowArray[invMap.desc] = parseText(inv.desc);
    } else {
      if (invMap.amount !== -1) rowArray[invMap.amount] = "";
      if (invMap.ref !== -1) rowArray[invMap.ref] = "";
      if (invMap.sendDate !== -1) rowArray[invMap.sendDate] = "";
      if (invMap.days !== -1) rowArray[invMap.days] = "";
      if (invMap.status !== -1) rowArray[invMap.status] = "";
      if (invMap.rechgd !== -1) rowArray[invMap.rechgd] = "";
      if (invMap.costMonth !== -1) rowArray[invMap.costMonth] = "";
      if (invMap.desc !== -1) rowArray[invMap.desc] = "";
    }
  }

  // Direct Expenses (slots 1-3)
  for (let s = 1; s <= 3; s++) {
    const dirMap = cols.dir[s - 1];
    const exp = expenseSlots?.[s];
    if (exp) {
      if (dirMap.desc !== -1) rowArray[dirMap.desc] = parseText(exp.desc);
      if (dirMap.amount !== -1) rowArray[dirMap.amount] = parseMoney(exp.amount);
      if (dirMap.vat !== -1) rowArray[dirMap.vat] = parseText(exp.vat || "Yes");
      if (dirMap.recDate !== -1) rowArray[dirMap.recDate] = formatDate(exp.recDate);
      if (dirMap.days !== -1) rowArray[dirMap.days] = parseNumber(exp.days, 30);
      if (dirMap.status !== -1) rowArray[dirMap.status] = parseExpenseStatus(exp.status);
      if (dirMap.appId !== -1 && exp.appId !== undefined) rowArray[dirMap.appId] = parseText(exp.appId);
    } else {
      if (dirMap.desc !== -1) rowArray[dirMap.desc] = "";
      if (dirMap.amount !== -1) rowArray[dirMap.amount] = "";
      if (dirMap.vat !== -1) rowArray[dirMap.vat] = "";
      if (dirMap.recDate !== -1) rowArray[dirMap.recDate] = "";
      if (dirMap.days !== -1) rowArray[dirMap.days] = "";
      if (dirMap.status !== -1) rowArray[dirMap.status] = "";
      if (dirMap.appId !== -1) rowArray[dirMap.appId] = "";
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({
      success: false,
      error: "Pulse is read-only when logged in with a one-time password.",
    });
  }

  const rl = await checkRateLimit("portal-save-job", sessionUser.email || getTrustedClientIp(req), 40, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  const { action: bodyAction, clientSheetId, clientName, job } = req.body || {};

  const isVarRetainerAction =
    bodyAction === "update_variable_retainer_base" ||
    bodyAction === "update_variable_retainer_month";

  if (!clientSheetId || (!job && !isVarRetainerAction)) {
    return res.status(400).json({ success: false, error: "clientSheetId and job object are required" });
  }

  try {
    const sheets = await getSheetsClient();

    // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
    const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error });
    }
    const verifiedClientName = auth.clientName;
    const liveGate = await assertClientPortalLive(sessionUser, verifiedClientName, res);
    if (!liveGate.allowed) return;

    const makeSafeVarRes_ = () =>
      sessionUser?.isAdmin
        ? res
        : {
          ...res,
          status(code) {
            res.status(code);
            return this;
          },
          json(payload) {
            if (payload && typeof payload === "object" && typeof payload.error === "string") {
              return res.json({ ...payload, error: sanitizeSpreadsheetTerms(payload.error) });
            }
            return res.json(payload);
          },
        };

    if (isVarRetainerAction) {
      const delegatedReq = {
        ...req,
        body: {
          ...(req.body || {}),
          clientSheetId,
          clientName: verifiedClientName || clientName || "",
        },
      };
      const safeRes = makeSafeVarRes_();
      if (bodyAction === "update_variable_retainer_base") {
        return await handleUpdateVariableRetainerBase(delegatedReq, safeRes, sheets);
      }
      return await handleUpdateVariableRetainerMonth(delegatedReq, safeRes, sheets);
    }

    // Server-side date validation across job dates, invoice sent dates, and expense received dates
    const isRetainerPayload = String(job?.projectRetainer || "").trim().toLowerCase() === "retainer";
    const allowNoEnd = Boolean(isRetainerPayload && (job?.noEndDate || isNoEndDateSentinel(job?.endDate)));
    if (job?.dateConfirmed !== undefined && String(job.dateConfirmed).trim() !== "" && !isValidDateInputValue(job.dateConfirmed, { allowEmpty: false })) {
      return res.status(400).json({ success: false, error: "Please enter a valid confirmation date." });
    }
    const rangeCheck = validateDateRange(job?.startDate, job?.endDate, {
      allowNoEndDate: allowNoEnd,
      requireStart: false,
      requireEnd: false,
    });
    if (!rangeCheck.valid) {
      return res.status(400).json({ success: false, error: rangeCheck.error || "Please enter valid start and end dates." });
    }
    if (Array.isArray(job?.invoices)) {
      for (let i = 0; i < job.invoices.length; i++) {
        const sd = job.invoices[i]?.sendDate;
        if (sd !== undefined && String(sd).trim() !== "" && !isValidDateInputValue(sd, { allowEmpty: false })) {
          return res.status(400).json({ success: false, error: `Please enter a valid sent date for invoice ${i + 1}.` });
        }
      }
    }
    if (Array.isArray(job?.directExpenses)) {
      for (let i = 0; i < job.directExpenses.length; i++) {
        const rd = job.directExpenses[i]?.recDate;
        if (rd !== undefined && String(rd).trim() !== "" && !isValidDateInputValue(rd, { allowEmpty: false })) {
          return res.status(400).json({ success: false, error: `Please enter a valid received date for direct expense ${i + 1}.` });
        }
      }
    }

    if (Boolean(job?.isVariableRetainerSeries)) {
      return await handleSaveVariableRetainerSeries_(req, makeSafeVarRes_(), sheets, {
        verifiedClientName,
        sessionUser,
      });
    }

    const incomingSplitStr = String(job.splitStr ?? job.unevenSplit ?? "").trim();
    if (incomingSplitStr.toLowerCase().startsWith("[split]")) {
      let splitAllowed = false;
      try {
        const kiSplitResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: clientSheetId,
            range: "KeyInfo!D16",
            valueRenderOption: "FORMATTED_VALUE",
          })
        );
        splitAllowed = String(kiSplitResp.data?.values?.[0]?.[0] || "").trim().toLowerCase() === "yes";
      } catch {
        splitAllowed = false;
      }
      if (!splitAllowed) {
        return res.status(400).json({
          success: false,
          error: "Uneven revenue splits are not enabled for this client.",
        });
      }
    }

    // 1. Determine target sheet name and sheet metadata (including rowGroups to avoid a second metadata fetch later)
    const rawLikelihoodStr = String(job.likelihood || "").trim();
    const parsedLikelihoodNum = parseFloat(rawLikelihoodStr.replace(/[%,\s]/g, ""));
    const isLikelihood100 = !isNaN(parsedLikelihoodNum) && (parsedLikelihoodNum >= 100 || (!rawLikelihoodStr.includes("%") && rawLikelihoodStr === "1"));
    const isTargetConfirmed = String(job.type || "").toLowerCase() === "confirmed" || isLikelihood100;
    const metaResp = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: clientSheetId,
        fields: "sheets(properties.sheetId,properties.title,rowGroups)",
      })
    );
    const sheetMetaList = metaResp.data?.sheets || [];
    const requestedStatus = isTargetConfirmed ? "confirmed" : "pipeline";
    const fallbackSheetName = isTargetConfirmed ? "Confirmed" : "Pipeline";
    const targetSheetObj = resolveEditableJobSheetMeta(sheetMetaList, requestedStatus);
    if (!targetSheetObj) {
      throw new Error(`Sheet "${fallbackSheetName}" not found in spreadsheet.`);
    }
    const sheetName = targetSheetObj.properties.title;
    const sheetId = targetSheetObj.properties.sheetId;

    // 2. Read headers of target sheet
    const headerResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${sheetName}!1:1`,
        valueRenderOption: "FORMATTED_VALUE",
      })
    );

    const headers = (headerResp.data?.values?.[0] || []).map((h) =>
      String(h || "").toLowerCase().trim().replace(/\s+/g, " ")
    );

    const colMap = {};
    const cleanStr = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const cleanColMap = {};
    headers.forEach((h, idx) => {
      if (h) {
        colMap[h] = idx;
        const c = cleanStr(h);
        if (c && cleanColMap[c] === undefined) cleanColMap[c] = idx;
      }
    });

    const getColIdx = (aliases, fallbackIdx = -1) => {
      const list = Array.isArray(aliases) ? aliases : [aliases];
      for (const alias of list) {
        const norm = alias.toLowerCase().trim().replace(/\s+/g, " ");
        if (colMap[norm] !== undefined) return colMap[norm];
        const cl = cleanStr(alias);
        if (cleanColMap[cl] !== undefined) return cleanColMap[cl];
      }
      return fallbackIdx;
    };

    // Exact dictionary column mapping with standard schema fallback offsets
    const cols = {
      client: getColIdx(["client"], 0),
      jobName: getColIdx(["job name"], 1),
      projectCode: getColIdx(["project code"], 2),
      lead: getColIdx(["lead"], -1),
      dateConfirmed: getColIdx(["date conf", "date originally added to pipeline", "date confirmed", "date added"], 3),
      leadSource: getColIdx(["lead src", "lead source"], 4),
      jobStartDate: getColIdx(["date job will start"], -1),
      jobEndDate: getColIdx(["date job will end"], -1),
      fixedVariable: getColIdx(["fixed / variable"], -1),
      jobRevenue: getColIdx(["job revenue"], -1),
      contractorCosts: getColIdx(["contractor costs"], -1),
      externalCosts: getColIdx(["external costs"], -1),
      rechargedExpenses: isTargetConfirmed ? getColIdx(["recharged expenses (excl vat)", "rechgd exp", "recharged expenses"], 17) : -1,
      propSuccFeePct: getColIdx(["% prop succ fee"], -1),
      propSuccFeeRec: getColIdx(["prop succ. fee rec", "prop succ fee rec"], -1),
      invNo: getColIdx(["inv no"], -1),
      splitStr: getColIdx(["revunevensplit", "rev uneven split", "rev_uneven_split", "uneven split"], 30),
      revenue: getColIdx(["revenue (proj total / ongoing pm) - excl vat", "revenue"], 32),
      directCosts: getColIdx(["direct costs (proj total / ongoing pm) - excl vat", "direct costs"], 33),
      vat: getColIdx(["vat?"], 34),
      projectRetainer: getColIdx(["project / retainer", "project/retainer"], 35),
      productLine: getColIdx(["prod. line", "product line"], 36),
      startDate: getColIdx(["start date"], 37),
      endDate: getColIdx(["end date"], 38),
      likelihood: getColIdx(["% likel.", "% likelihood", "% likely", "likelihood"], 39),
      prodTime: getColIdx(["prod. time", "production time"], -1),

      inv: [
        {
          amount: getColIdx(["project invoice 1 / monthly retainer (excl vat)", "project invoice 1 / monthly retainer (excl. vat)", "project invoice 1", "inv 1 amount"], 41),
          ref: getColIdx(["inv 1 ref"], 42),
          sendDate: getColIdx(["inv 1 send date", "inv 1 date"], 43),
          days: getColIdx(["inv 1 days to pay", "inv 1 days"], 44),
          status: getColIdx(["inv 1 status"], 45),
          rechgd: isTargetConfirmed ? getColIdx(["inv 1 of which rechgd", "inv. 1 of which rechgd", "inv 1 recharged", "inv 1 rechgd"], 46) : -1,
          costMonth: isTargetConfirmed ? getColIdx(["inv 1 cost month", "inv. 1 cost month"], 47) : -1,
          desc: !isTargetConfirmed ? getColIdx(["inv 1 descr.", "inv 1 desc"], -1) : -1,
        },
        {
          amount: getColIdx(["project invoice 2 (excl vat)", "project invoice 2 (excl. vat)", "project invoice 2", "inv 2 amount"], 48),
          ref: getColIdx(["inv 2 ref"], 49),
          sendDate: getColIdx(["inv 2 send date", "inv 2 date"], 50),
          days: getColIdx(["inv 2 days to pay", "inv 2 days"], 51),
          status: getColIdx(["inv 2 status"], 52),
          rechgd: isTargetConfirmed ? getColIdx(["inv 2 of which rechgd", "inv. 2 of which rechgd", "inv 2 recharged", "inv 2 rechgd"], 53) : -1,
          costMonth: isTargetConfirmed ? getColIdx(["inv 2 cost month", "inv. 2 cost month"], 54) : -1,
          desc: !isTargetConfirmed ? getColIdx(["inv 2 descr.", "inv 2 desc"], -1) : -1,
        },
        {
          amount: getColIdx(["project invoice 3 (excl vat)", "project invoice 3 (excl. vat)", "project invoice 3", "inv 3 amount"], 55),
          ref: getColIdx(["inv 3 ref"], 56),
          sendDate: getColIdx(["inv 3 send date", "inv 3 date"], 57),
          days: getColIdx(["inv 3 days to pay", "inv 3 days"], 58),
          status: getColIdx(["inv 3 status"], 59),
          rechgd: isTargetConfirmed ? getColIdx(["inv 3 of which rechgd", "inv. 3 of which rechgd", "inv 3 recharged", "inv 3 rechgd"], 60) : -1,
          costMonth: isTargetConfirmed ? getColIdx(["inv 3 cost month", "inv. 3 cost month"], 61) : -1,
          desc: !isTargetConfirmed ? getColIdx(["inv 3 descr.", "inv 3 desc"], -1) : -1,
        },
      ],

      dir: [
        {
          desc: getColIdx(["direct inv 1 descr.", "direct inv 1 desc"], 75),
          amount: getColIdx(["direct inv 1 amt", "direct inv 1 amount"], 76),
          vat: getColIdx(["dir inv. 1 vat?", "dir inv 1 vat?", "direct inv 1 vat?"], 77),
          recDate: getColIdx(["direct inv 1 rec date", "dir inv. 1 rec date", "dir inv 1 rec date"], 78),
          days: getColIdx(["dir inv 1 days to pay", "dir inv. 1 days to pay", "dir inv 1 days"], 79),
          status: getColIdx(["dir inv 1 status"], 80),
          appId: getColIdx(["dir inv 1 app id", "dir inv. 1 app id"], 81),
        },
        {
          desc: getColIdx(["direct inv 2 descr.", "direct inv 2 desc"], 83),
          amount: getColIdx(["direct inv 2 amt", "direct inv 2 amount"], 84),
          vat: getColIdx(["dir inv. 2 vat?", "dir inv 2 vat?", "direct inv 2 vat?"], 85),
          recDate: getColIdx(["direct inv 2 rec date", "dir inv. 2 rec date", "dir inv 2 rec date"], 86),
          days: getColIdx(["dir inv 2 days to pay", "dir inv. 2 days to pay", "dir inv 2 days"], 87),
          status: getColIdx(["dir inv 2 status"], 88),
          appId: getColIdx(["dir inv 2 app id", "dir inv. 2 app id"], 89),
        },
        {
          desc: getColIdx(["direct inv 3 descr.", "direct inv 3 desc"], 91),
          amount: getColIdx(["direct inv 3 amt", "direct inv 3 amount"], 92),
          vat: getColIdx(["dir inv. 3 vat?", "dir inv 3 vat?", "direct inv 3 vat?"], 93),
          recDate: getColIdx(["direct inv 3 rec date", "dir inv. 3 rec date", "dir inv 3 rec date"], 94),
          days: getColIdx(["dir inv 3 days to pay", "dir inv. 3 days to pay", "dir inv 3 days"], 95),
          status: getColIdx(["dir inv 3 status"], 96),
          appId: getColIdx(["dir inv 3 app id", "dir inv. 3 app id"], 97),
        },
      ],
    };

    // 3. Determine if moving between sheets or if new job
    let origId = String(job.id || "");
    const wasPipeline = origId.startsWith("pipeline");
    const wasConfirmed = origId.startsWith("confirmed");
    const isSheetChange = (wasPipeline && isTargetConfirmed) || (wasConfirmed && !isTargetConfirmed);

    let relationalAnchor = null;
    if (job.jobUuid && origId !== "new") {
      const expectedSourceTab = isSheetChange ? (wasPipeline ? "Pipeline" : "Confirmed") : sheetName;
      relationalAnchor = await resolveAuthoritativeJobAnchor({
        spreadsheetId: clientSheetId,
        clientName: verifiedClientName,
        jobUuid: job.jobUuid,
        expectedTabName: expectedSourceTab,
        fallbackRowNum: job.rowNumber,
      });
      if (relationalAnchor?.resolved && relationalAnchor.rowNum) {
        job.rowNumber = relationalAnchor.rowNum;
        job.childRowNumbers = relationalAnchor.rowNums?.slice(1) || job.childRowNumbers;
        origId = `${expectedSourceTab.toLowerCase()}-${relationalAnchor.rowNum}`;
      }
    }

    const isNewJob = origId === "new" || !job.rowNumber || isSheetChange;

    if (wasPipeline && isTargetConfirmed) {
      let code = String(job.projectCode || "").trim();
      const oldRow = parseInt(job.rowNumber, 10);
      if (!code && !isNaN(oldRow) && oldRow >= 2) {
        try {
          const pRowResp = await withRetry(() =>
            sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetId,
              range: `Pipeline!C${oldRow}`,
              valueRenderOption: "FORMATTED_VALUE",
            })
          );
          code = (pRowResp.data?.values?.[0]?.[0] || "").trim();
        } catch (e) { }
      }

      if (code) {
        let crmTool = "None";
        let crmDrives = "NA";
        try {
          const kiResp = await withRetry(() =>
            sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetId,
              range: "KeyInfo!Q8:Q9",
              valueRenderOption: "FORMATTED_VALUE",
            })
          );
          const kiRows = kiResp.data?.values || [];
          if (kiRows[0]?.[0]) crmTool = String(kiRows[0][0]).trim();
          if (kiRows[1]?.[0]) crmDrives = String(kiRows[1][0]).trim();
        } catch (kiErr) {
          if (redisClient?.isOpen && verifiedClientName) {
            try {
              const normKey = String(verifiedClientName).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
              const rawCfg = await redisClient.get(`pulse:setup:${normKey}`);
              if (rawCfg) {
                const parsed = JSON.parse(rawCfg);
                if (parsed.crmTool) crmTool = parsed.crmTool;
                if (parsed.crmDrives) crmDrives = parsed.crmDrives;
              }
            } catch (e) { }
          }
        }

        if (hasActiveCrmIntegration(crmTool) && isCrmDrivenTab("pipeline", crmDrives)) {
          return res.status(400).json({
            success: false,
            error: `Cannot manually promote a CRM pipeline deal. Please update the deal status directly in ${getCrmDisplayName(crmTool)}.`,
          });
        }
      }
    }

    let parentRow = parseInt(job.rowNumber, 10);
    const sanitizeContiguousChildren = (baseRow, rawChildren) => {
      if (isNaN(baseRow) || !Array.isArray(rawChildren)) return [];
      const sorted = rawChildren
        .map((n) => parseInt(n, 10))
        .filter((n) => !isNaN(n) && n > baseRow && n <= baseRow + 120)
        .sort((a, b) => a - b);
      const valid = [];
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i] === baseRow + 1 + i) valid.push(sorted[i]);
        else break;
      }
      return valid;
    };
    let existingChildRows = sanitizeContiguousChildren(parentRow, job.childRowNumbers);

    const isJobCosting = isJobCostingStyle({ headers });
    const deferredClearRanges = [];
    const deferredRestoreData = [];
    if (isSheetChange) {
      // Defer clearing old rows on the previous sheet until after all structural operations complete
      const oldSheetName = wasPipeline ? "Pipeline" : "Confirmed";
      const minOldRow = 2;
      const oldRow = parseInt(job.rowNumber, 10);
      if (!isNaN(oldRow) && oldRow >= minOldRow) {
        const verifiedOldChildren = [];
        if (existingChildRows.length > 0) {
          try {
            const oldEndCol = oldSheetName === "Confirmed" ? "BJ" : "BH";
            const oldInspectResp = await withRetry(() =>
              sheets.spreadsheets.values.get({
                spreadsheetId: clientSheetId,
                range: `${oldSheetName}!A${oldRow + 1}:${oldEndCol}${oldRow + existingChildRows.length}`,
                valueRenderOption: "FORMATTED_VALUE",
              })
            );
            const oldNextRows = oldInspectResp.data?.values || [];
            for (let i = 0; i < existingChildRows.length; i++) {
              const r = oldNextRows[i] || [];
              const rRev = (r[cols.revenue] || "").trim();
              const rDc = (r[cols.directCosts] || "").trim();
              const rRechRaw = oldSheetName === "Confirmed" ? String(r[17] || "").trim() : "";
              const rRech = (rRechRaw && Math.abs(parseFloat(rRechRaw.replace(/[£$€,\s]/g, "")) || 0) > 0.001) ? rRechRaw : "";
              if (rRev === "" && rDc === "" && rRech === "") verifiedOldChildren.push(oldRow + 1 + i);
              else break;
            }
          } catch (_) { }
        }
        const rowsToClear = [oldRow, ...verifiedOldChildren].filter((r) => r >= minOldRow);
        const clearPlan = buildJobRowClearAndRestorePlan({
          sheetName: oldSheetName,
          rowNums: rowsToClear,
          isJobCosting,
          includeCopiedCol: true,
        });
        deferredClearRanges.push(...clearPlan.clearRanges);
        deferredRestoreData.push(...clearPlan.restoreData);
      }
      // Target sheet will place this as a new job at first blank row
      existingChildRows = [];
    }

    const minTargetRow = 2;
    const cachedRowsRef = { rows: null };
    const preloadedFormulaRowsByRowNum = new Map();
    const maxCols = 96;
    let existingParentRow = [];

    if (isNewJob || isNaN(parentRow) || parentRow < minTargetRow) {
      const lastJobRow = await findLastJobRow(sheets, clientSheetId, sheetName, 1, cachedRowsRef);
      parentRow = Math.max(minTargetRow, lastJobRow + 1);
      existingChildRows = [];
      const parentRowResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${sheetName}!A${parentRow}:CR${parentRow}`,
          valueRenderOption: "FORMULA",
        })
      );
      existingParentRow = parentRowResp.data?.values?.[0] || [];
    } else {
      // Single combined read for existing parent row (FORMULA) + child row inspection window directly below parentRow
      try {
        const checkCount = Math.max(30, existingChildRows.length);
        const inspectResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: clientSheetId,
            range: `${sheetName}!A${parentRow}:CR${parentRow + checkCount}`,
            valueRenderOption: "FORMULA",
          })
        );
        const windowRows = inspectResp.data?.values || [];
        existingParentRow = windowRows[0] || [];
        for (let idx = 0; idx < windowRows.length; idx++) {
          preloadedFormulaRowsByRowNum.set(parentRow + idx, windowRows[idx] || []);
        }
        const nextRows = windowRows.slice(1);
        const explicitChildSet = new Set(existingChildRows);
        const verifiedChildren = [];
        for (let i = 0; i < nextRows.length; i++) {
          const r = nextRows[i] || [];
          const candidateRowNum = parentRow + 1 + i;
          const rRev = String(r[cols.revenue] ?? "").trim();
          const rDc = String(r[cols.directCosts] ?? "").trim();
          const isChildEmptyRevDc =
            isJobCosting && rRev.startsWith("=")
              ? String(r[cols.jobRevenue] ?? "").trim() === "" &&
                String(r[cols.jobStartDate] ?? "").trim() === ""
              : rRev === "" && rDc === "";
          const isMatched =
            (explicitChildSet.has(candidateRowNum) && isChildEmptyRevDc) ||
            isContiguousJobChildRow({
              row: r,
              candidateRowNum,
              parentClient: existingParentRow?.[cols.client] ?? job.client ?? "",
              parentJobName: existingParentRow?.[cols.jobName] ?? job.jobName ?? "",
              altParentClient: job.client ?? "",
              altParentJobName: job.jobName ?? "",
              isConfirmedTab: isTargetConfirmed,
              isJobCosting,
              anchorRowSet: explicitChildSet,
              cols,
            });
          if (isMatched) {
            verifiedChildren.push(candidateRowNum);
          } else {
            break;
          }
        }
        existingChildRows = verifiedChildren;
      } catch (e) {
        console.warn("Child row auto-detection warning:", e.message);
      }
    }

    // 4. INVOICE AND EXPENSE PACKING LOGIC (1:1 with Original App)
    const parseMoneyVal = (val) => parseFloat(String(val ?? "").replace(/[£$€,\s]/g, "")) || 0;
    const validInvoices = (job.invoices || []).filter(
      (inv) =>
        (inv.amount !== undefined && String(inv.amount).trim() !== "") ||
        (inv.ref !== undefined && String(inv.ref).trim() !== "") ||
        (inv.sendDate !== undefined && String(inv.sendDate).trim() !== "") ||
        (isTargetConfirmed && inv.ofWhichRechgd !== undefined && parseMoneyVal(inv.ofWhichRechgd) > 0)
    );

    const validExpenses = (job.directExpenses || []).filter(
      (exp) =>
        (exp.amount !== undefined && String(exp.amount).trim() !== "") ||
        (exp.desc !== undefined && String(exp.desc).trim() !== "") ||
        (exp.recDate !== undefined && String(exp.recDate).trim() !== "")
    );

    const isRetainer = String(job.projectRetainer || "").toLowerCase() === "retainer";
    const existingAeTag = !isNewJob && cols.splitStr !== -1 ? parseVariableRetainerTag(existingParentRow?.[cols.splitStr]) : null;
    const incomingAeTag = parseVariableRetainerTag(job.splitStr ?? job.unevenSplit);
    const isVarRetainer = Boolean(
      isRetainer &&
      (job.isVariableRetainer || String(job.retainerMode || "").toLowerCase() === "variable" || incomingAeTag || existingAeTag)
    );
    const isFixedRetainer = isRetainer && !isVarRetainer;

    // Creating a new Confirmed Variable Retainer (or promoting Pipeline -> Confirmed) provisions monthly series rows
    if (isTargetConfirmed && isVarRetainer && isNewJob) {
      const seriesTag = incomingAeTag || existingAeTag;
      const baseRevVal = seriesTag?.baseRev ?? (parseMoneyVal(job.revenue) || 0);
      const baseDcVal = seriesTag?.baseDC ?? (parseMoneyVal(job.directCosts) || 0);
      const varRes = await createVariableRetainerSeries_(sheets, {
        clientSheetId,
        clientName: verifiedClientName || clientName || "",
        client: job.client || "",
        jobName: seriesTag?.seriesName || job.jobName || "",
        projectCode: job.projectCode || "",
        leadSource: job.leadSource || "",
        productLine: job.productLine || "",
        baseRevenue: baseRevVal,
        baseDirectCosts: baseDcVal,
        vat: job.vat || "Yes",
        startDate: formatDate(job.startDate),
        endDate: job.noEndDate ? NO_END_DATE_SHEET_VALUE : formatDate(job.endDate),
        noEndDate: Boolean(job.noEndDate || isNoEndDateSentinel(job.endDate)),
        invoiceSendDay: job.invoiceSendDay ?? seriesTag?.sendDay ?? null,
        initialInvoices: validInvoices,
        initialExpenses: validExpenses,
        setDateConf: true,
      });
      if (!varRes.success) {
        return res.status(400).json({ success: false, error: varRes.error || "Failed to create variable retainer" });
      }
      if (deferredClearRanges.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchClear({ spreadsheetId: clientSheetId, requestBody: { ranges: deferredClearRanges } })
        );
        if (deferredRestoreData.length > 0) {
          await withRetry(() =>
            sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: clientSheetId,
              requestBody: { valueInputOption: "USER_ENTERED", data: deferredRestoreData },
            })
          );
        }
      }
      await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, verifiedClientName || clientName || "").catch(() => { });
      await invalidatePmaClientCache(clientSheetId, null, ["jobs", "invoices", "outgoings", "retainers", "cash", "views"]).catch(() => { });
      return res.status(200).json({
        success: true,
        rowNumber: varRes.firstRowNum,
        sheetName,
        isVariableRetainer: true,
        childRowNumbers: [],
        createdRowNums: varRes.createdRowNums,
        backgroundProvisioning: false,
      });
    }

    // Pipeline Variable Retainer: ensure [VarRetainer] tag is written to Col AE
    if (!isTargetConfirmed && isVarRetainer && !incomingAeTag) {
      job.splitStr = formatVariableRetainerTag({
        seriesName: job.jobName || "",
        baseRev: parseMoneyVal(job.revenue) || 0,
        baseDC: parseMoneyVal(job.directCosts) || 0,
        endDate: formatDate(job.endDate) || NO_END_DATE_SHEET_VALUE,
        noEndDate: Boolean(job.noEndDate || isNoEndDateSentinel(job.endDate)),
        sendDay: job.invoiceSendDay || 28,
      });
    } else if (isTargetConfirmed && isVarRetainer && existingAeTag) {
      // Preserve tag & update override flags if user edited revenue or directCosts on this month
      const editedRev = parseMoneyVal(job.revenue);
      const editedDc = parseMoneyVal(job.directCosts);
      job.splitStr = formatVariableRetainerTag({
        ...existingAeTag,
        overrideRev: existingAeTag.overrideRev || Math.abs(editedRev - existingAeTag.baseRev) > 0.005,
        overrideDc: existingAeTag.overrideDc || Math.abs(editedDc - existingAeTag.baseDC) > 0.005,
      });
    }

    // Automatic placeholder generation & adjustment (100% verbatim with services/workspaces.js)
    const isAutoInvItem = (inv) => isAutoInvoicePlaceholderRef_(inv?.ref);
    const isAutoExpItem = (exp) => {
      const id = String(exp?.appId || exp?.transactionId || "").trim();
      const desc = String(exp?.desc || "").trim();
      const st = String(exp?.status || "").trim().toLowerCase();
      const isPaid = ["paid", "complete", "part-paid (paid)"].includes(st);
      return !isPaid && (isAutoExpensePlaceholderId_(id) || (!id && /^placeholder/i.test(desc)));
    };
    let cachedTols = null;
    const loadJobTolerances_ = async () => {
      if (cachedTols) return cachedTols;
      const masterId = await resolveMasterSheetIdForClient_(sheets, clientSheetId, verifiedClientName || clientName || "");
      cachedTols = masterId
        ? await getToleranceValues(sheets, masterId)
        : {
          invoiceLogicMode: "50-50",
          expenseLogicMode: "100 at start",
          retainerInvoiceDay: 28,
          retainerExpenseDay: 28,
          defaultDaysToPay: 30,
        };
      return cachedTols;
    };

    if (!isRetainer) {
      const nonAutoInvoices = validInvoices.filter((inv) => !isAutoInvItem(inv));
      const existingAutoInvoices = validInvoices.filter((inv) => isAutoInvItem(inv));
      const nonAutoInvoicesTotal = nonAutoInvoices.reduce((sum, inv) => sum + Math.max(0, parseMoneyVal(inv.amount)), 0);
      const allocatedRechgdOnNonAuto = isTargetConfirmed
        ? nonAutoInvoices.reduce((sum, inv) => sum + Math.max(0, parseMoneyVal(inv.ofWhichRechgd)), 0)
        : 0;
      const jobRevNum = Math.max(0, parseMoneyVal(job.revenue ?? job.jobRevenue));
      const jobRechNum = isTargetConfirmed ? Math.max(0, parseMoneyVal(job.rechargedExpenses)) : 0;
      const effectiveBillable = Math.round((jobRevNum + jobRechNum) * 100) / 100;
      const remainingToInvoice = Math.max(0, Math.round((effectiveBillable - nonAutoInvoicesTotal) * 100) / 100);

      if (remainingToInvoice > 0.01) {
        const tols = await loadJobTolerances_();
        const startDate = (job.startDate && parseSheetDate(job.startDate)) || new Date();
        const endDate = (job.endDate && !isNoEndDateSentinel(job.endDate) && parseSheetDate(job.endDate)) || startDate;
        const remainingRechgdToAllocate = isTargetConfirmed
          ? Math.max(0, Math.min(remainingToInvoice, Math.round((jobRechNum - allocatedRechgdOnNonAuto) * 100) / 100))
          : 0;
        const remainingNonRechgd = Math.max(0, Math.round((remainingToInvoice - remainingRechgdToAllocate) * 100) / 100);
        const allocations = remainingNonRechgd > 0
          ? calculateRevenueSplit(
            remainingNonRechgd,
            tols?.invoiceLogicMode || "50-50",
            startDate,
            endDate,
            tols?.retainerInvoiceDay || 28,
            nonAutoInvoices.length
          )
          : [{ date: endDate || startDate, amt: 0 }];

        if (remainingRechgdToAllocate > 0 && allocations.length > 0) {
          allocations[allocations.length - 1].amt =
            Math.round(((allocations[allocations.length - 1].amt || 0) + remainingRechgdToAllocate) * 100) / 100;
        }

        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const targetFifth = new Date(now.getFullYear(), now.getMonth(), 5);
        allocations.forEach((alloc) => {
          if (alloc.date instanceof Date && !isNaN(alloc.date.getTime()) && alloc.date < currentMonthStart) {
            alloc.date = targetFifth;
          }
        });

        const generatedAutoInvoices = allocations.map((alloc, k) => {
          const prevAuto = existingAutoInvoices[k] || null;
          const autoRef = prevAuto?.ref ? String(prevAuto.ref).trim() : generateAutoPlaceholderRef_("PLACE-INV");
          const parsedDays = parseInt(String(prevAuto?.days || "").replace(/[^\d-]/g, ""), 10);
          const effectiveDays = !isNaN(parsedDays) && parsedDays > 0 && parsedDays <= 365
            ? parsedDays
            : (tols?.defaultDaysToPay || 30);
          const isFinal = k === allocations.length - 1;
          const rechVal = isTargetConfirmed && isFinal && remainingRechgdToAllocate > 0
            ? String(remainingRechgdToAllocate)
            : "";
          const cmVal = isTargetConfirmed && isFinal && remainingRechgdToAllocate > 0 && prevAuto?.costMonth
            ? String(prevAuto.costMonth)
            : "";
          return {
            amount: String(alloc.amt),
            ref: autoRef,
            sendDate: toSheetDateFormat(alloc.date),
            days: String(effectiveDays),
            status: "",
            ...(isTargetConfirmed ? { ofWhichRechgd: rechVal, costMonth: cmVal } : {}),
          };
        });
        validInvoices.splice(0, validInvoices.length, ...nonAutoInvoices, ...generatedAutoInvoices);
      } else {
        validInvoices.splice(0, validInvoices.length, ...nonAutoInvoices);
      }

      const nonAutoExpenses = validExpenses.filter((exp) => !isAutoExpItem(exp));
      const existingAutoExpenses = validExpenses.filter((exp) => isAutoExpItem(exp));
      const nonAutoExpensesTotal = nonAutoExpenses.reduce((sum, exp) => sum + Math.max(0, parseMoneyVal(exp.amount)), 0);
      const effectiveBudget = Math.max(0, parseMoneyVal(job.directCosts));
      const remainingDC = Math.max(0, Math.round((effectiveBudget - nonAutoExpensesTotal) * 100) / 100);

      if (remainingDC > 0.01) {
        const tols = await loadJobTolerances_();
        const startDate = (job.startDate && parseSheetDate(job.startDate)) || new Date();
        const endDate = (job.endDate && !isNoEndDateSentinel(job.endDate) && parseSheetDate(job.endDate)) || startDate;
        const allocations = calculateRevenueSplit(
          remainingDC,
          tols?.expenseLogicMode || "100 at start",
          startDate,
          endDate,
          tols?.retainerExpenseDay || 28,
          nonAutoExpenses.length
        );

        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const targetFifth = new Date(now.getFullYear(), now.getMonth(), 5);
        allocations.forEach((alloc) => {
          if (alloc.date instanceof Date && !isNaN(alloc.date.getTime()) && alloc.date < currentMonthStart) {
            alloc.date = targetFifth;
          }
        });

        const generatedAutoExpenses = allocations.map((alloc, k) => {
          const prevAuto = existingAutoExpenses[k] || null;
          const prevAutoId = String(prevAuto?.appId || prevAuto?.transactionId || "").trim();
          const autoId = prevAutoId && isAutoExpensePlaceholderId_(prevAutoId)
            ? prevAutoId
            : generateAutoPlaceholderRef_("PLACE-EXP");
          const parsedDays = parseInt(String(prevAuto?.days || "").replace(/[^\d-]/g, ""), 10);
          const effectiveDays = !isNaN(parsedDays) && parsedDays > 0 && parsedDays <= 365
            ? parsedDays
            : (tols?.defaultDaysToPay || 30);
          const effectiveVat = prevAuto?.vat === "Yes" || prevAuto?.vat === "No" ? prevAuto.vat : (job.vat || "Yes");
          return {
            desc: prevAuto?.desc || "Placeholder Entry - Project Direct Cost",
            amount: String(alloc.amt),
            vat: effectiveVat,
            recDate: toSheetDateFormat(alloc.date),
            days: String(effectiveDays),
            status: "",
            appId: autoId,
          };
        });
        validExpenses.splice(0, validExpenses.length, ...nonAutoExpenses, ...generatedAutoExpenses);
      } else {
        validExpenses.splice(0, validExpenses.length, ...nonAutoExpenses);
      }
    } else if (!isTargetConfirmed) {
      // Pipeline Retainer: keep single monthly fee placeholder on parent slot 1 when no non-auto invoices exist
      const nonAutoInvoices = validInvoices.filter((inv) => !isAutoInvItem(inv));
      const existingAutoInvoices = validInvoices.filter((inv) => isAutoInvItem(inv));
      const nonAutoInvoicesTotal = nonAutoInvoices.reduce((sum, inv) => sum + Math.max(0, parseMoneyVal(inv.amount)), 0);
      const remainingToInvoice = Math.max(0, Math.round((Math.max(0, parseMoneyVal(job.revenue)) - nonAutoInvoicesTotal) * 100) / 100);

      if (nonAutoInvoices.length === 0 && remainingToInvoice > 0.01) {
        const tols = await loadJobTolerances_();
        const startDate = (job.startDate && parseSheetDate(job.startDate)) || new Date();
        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const propDate = startDate < currentMonthStart ? new Date(now.getFullYear(), now.getMonth(), 5) : startDate;
        const prevAuto = existingAutoInvoices[0] || null;
        const autoRef = prevAuto?.ref ? String(prevAuto.ref).trim() : generateAutoPlaceholderRef_("PLACE-INV");
        const parsedDays = parseInt(String(prevAuto?.days || "").replace(/[^\d-]/g, ""), 10);
        const effectiveDays = !isNaN(parsedDays) && parsedDays > 0 && parsedDays <= 365
          ? parsedDays
          : (tols?.defaultDaysToPay || 30);
        validInvoices.splice(0, validInvoices.length, {
          amount: String(remainingToInvoice),
          ref: autoRef,
          sendDate: toSheetDateFormat(propDate),
          days: String(effectiveDays),
          status: "",
        });
      } else if (remainingToInvoice <= 0.01 && existingAutoInvoices.length > 0) {
        validInvoices.splice(0, validInvoices.length, ...nonAutoInvoices);
      }
    }

    // Canonical slot ordering for non-fixed-retainer jobs: [Real -> Manual placeholder -> Auto placeholder]
    if (!isFixedRetainer) {
      const invTier = (inv) => {
        const ref = String(inv?.ref || "").trim();
        const isAuto = ref !== "" && /^(PLACE|MANUAL-INV|UNRECON-GAP)/i.test(ref);
        if (ref && !isAuto && !isPlaceholderInvoice(ref, inv?.status)) return 0;
        if (!isAuto) return 1;
        return 2;
      };
      const expTier = (exp) => {
        const id = String(exp?.appId || exp?.transactionId || "").trim();
        const st = String(exp?.status || "").trim().toLowerCase();
        const isPaid = ["paid", "complete", "part-paid (paid)"].includes(st);
        const isAuto = !isPaid && (/^(PLACE-EXP|PLACE-GAP|MANUAL-ENTRY|MANUAL-GAP|UNRECON-GAP)/i.test(id) || (!id && /^placeholder/i.test(String(exp?.desc || "").trim())));
        if ((id && !isAuto && !isPlaceholderExpense(id, exp?.desc, exp?.status)) || isPaid) return 0;
        if (!isAuto) return 1;
        return 2;
      };
      validInvoices.sort((a, b) => invTier(a) - invTier(b));
      validExpenses.sort((a, b) => expTier(a) - expTier(b));
    }
    const wasPreviouslyFixedRetainer =
      !isNewJob &&
      cols.projectRetainer !== -1 &&
      String(existingParentRow[cols.projectRetainer] || "")
        .trim()
        .toLowerCase()
        .includes("retainer") &&
      !existingAeTag;
    const shouldProvisionRetainerSchedule =
      isTargetConfirmed &&
      isFixedRetainer &&
      (isNewJob || !wasPreviouslyFixedRetainer || existingChildRows.length === 0);

    if (isTargetConfirmed && !shouldProvisionRetainerSchedule && validInvoices.length > 0) {
      const totalJobRechgd = parseMoneyVal(job.rechargedExpenses);
      const sumInvRechgd = validInvoices.reduce((sum, inv) => sum + parseMoneyVal(inv.ofWhichRechgd), 0);
      if ((totalJobRechgd > 0.005 || sumInvRechgd > 0.005) && Math.abs(sumInvRechgd - totalJobRechgd) > 0.01) {
        return res.status(400).json({
          success: false,
          error: `Recharged expenses attached to invoices (£${sumInvRechgd.toFixed(2)}) must equal the job's recharged expenses total (£${totalJobRechgd.toFixed(2)}).`,
        });
      }
    }

    const parentInvoices = {};
    const childInvoices = [];

    if (shouldProvisionRetainerSchedule) {
      // Confirmed Retainers being created, promoted, or converted from Project have their
      // child rows and scheduled monthly invoices provisioned in the background.
      // Parent row invoice slots remain empty.
    } else if (isFixedRetainer) {
      if (validInvoices.length === 1) {
        // Retainer with 1 invoice (e.g. Pipeline retainer): sits on parent row slot 1; slots 2 & 3 empty
        parentInvoices[1] = validInvoices[0];
      } else if (validInvoices.length > 1) {
        // Retainer with 2+ invoices: parent row slots 1, 2, 3 cleared; each invoice on its own child row slot 1
        validInvoices.forEach((inv, i) => {
          childInvoices[i] = { 1: inv };
        });
      }
    } else {
      // Project invoices: 1-3 on parent row, 4+ on child rows cycling slots 1-3
      validInvoices.forEach((inv, i) => {
        if (i < 3) {
          parentInvoices[i + 1] = inv;
        } else {
          const childIdx = Math.floor((i - 3) / 3);
          const slot = ((i - 3) % 3) + 1;
          if (!childInvoices[childIdx]) childInvoices[childIdx] = {};
          childInvoices[childIdx][slot] = inv;
        }
      });
    }

    // Direct Expenses (same rules for Project and Retainer):
    // 1-3 on parent row, 4+ on child rows cycling slots 1-3
    const parentExpenses = {};
    const childExpenses = [];

    validExpenses.forEach((exp, i) => {
      if (i < 3) {
        parentExpenses[i + 1] = exp;
      } else {
        const childIdx = Math.floor((i - 3) / 3);
        const slot = ((i - 3) % 3) + 1;
        if (!childExpenses[childIdx]) childExpenses[childIdx] = {};
        childExpenses[childIdx][slot] = exp;
      }
    });

    const childRowsForInvoices = childInvoices.length;
    const childRowsForExpenses = childExpenses.length;
    const totalChildRowsNeeded = Math.max(childRowsForInvoices, childRowsForExpenses);

    // 5. MANAGE CHILD ROWS (reuse existing, create new via moveDimension, or clear unused)
    const actualChildRows = [];
    let didMoveRows = false;

    for (let idx = 0; idx < totalChildRowsNeeded; idx++) {
      if (existingChildRows[idx]) {
        actualChildRows.push(existingChildRows[idx]);
      } else {
        const insertAfterRow =
          actualChildRows.length > 0 ? actualChildRows[actualChildRows.length - 1] : parentRow;
        const newChildRow = await findAndMoveBlankRow(
          sheets,
          clientSheetId,
          sheetId,
          sheetName,
          insertAfterRow,
          cachedRowsRef
        );
        didMoveRows = true;
        actualChildRows.push(newChildRow);
      }
    }

    // Helper to slice and pad row array to exact column width
    const slicePad = (arr, start, end) => {
      const s = arr.slice(start, end);
      while (s.length < end - start) s.push("");
      return s;
    };

    // Defer clearing any excess child rows that are no longer needed until after all structural operations complete
    if (existingChildRows.length > totalChildRowsNeeded) {
      const excessChildRowNums = existingChildRows.slice(totalChildRowsNeeded);
      const excessPlan = buildJobRowClearAndRestorePlan({
        sheetName,
        rowNums: excessChildRowNums,
        isJobCosting,
        includeCopiedCol: false,
      });
      deferredClearRanges.push(...excessPlan.clearRanges);
      deferredRestoreData.push(...excessPlan.restoreData);
    }

    const invBandEndCol = isTargetConfirmed ? "BJ" : "BH";
    const invBandEndIdx = isTargetConfirmed ? 62 : 60;

    // 6. PREPARE PARENT ROW (segmented into safe bands: A:AM, AN, AP:BJ/BH, BX:CR)
    // Preserves column AO (col 41) and calculation formulas in BK/BI:BW, CS:DC, and DD
    const updatedParentRow = new Array(maxCols).fill("");
    for (let c = 0; c < maxCols; c++) {
      if (existingParentRow[c] !== undefined) {
        updatedParentRow[c] = existingParentRow[c];
      }
    }

    const canEnterFormulas = Boolean(
      !sessionUser?.isReadOnly && (sessionUser?.isAdmin || sessionUser?.role === "Admin")
    );
    applyParentRowValues(updatedParentRow, job, cols, parentInvoices, parentExpenses, {
      isJobCosting,
      sheetName,
      rowNum: parentRow,
      canEnterFormulas,
    });

    const isDangerousFormulaStr_ = (val) =>
      typeof val === "string" &&
      /=\s*[\s\S]*\b(IMPORT(?:XML|DATA|HTML|FEED|RANGE)|IMAGE|HYPERLINK|QUERY|WEBSERVICE|GOOGLEFINANCE|FILTERXML)\s*\(/i.test(val);

    const batchUpdateData = [
      {
        range: `${sheetName}!A${parentRow}:AM${parentRow}`,
        values: [sanitizeJobSlice(slicePad(updatedParentRow, 0, 39), { isJobCosting, isPrimaryRange: true, canEnterFormulas })],
      },
      {
        range: `${sheetName}!AN${parentRow}`,
        values: [[
          ((canEnterFormulas || (isJobCosting && sheetName === "Pipeline" && isJobCostingColJLikelihoodFormula(updatedParentRow[39]))) &&
            typeof updatedParentRow[39] === "string" &&
            /^\s*=/.test(updatedParentRow[39]) &&
            !isDangerousFormulaStr_(updatedParentRow[39]))
            ? updatedParentRow[39]
            : sanitizeFormulaInput(updatedParentRow[39] !== undefined ? updatedParentRow[39] : ""),
        ]],
      },
      {
        range: `${sheetName}!AP${parentRow}:${invBandEndCol}${parentRow}`,
        values: [sanitizeJobSlice(slicePad(updatedParentRow, 41, invBandEndIdx), { canEnterFormulas, rangeKind: "invoices" })],
      },
      {
        range: `${sheetName}!BX${parentRow}:CR${parentRow}`,
        values: [sanitizeJobSlice(slicePad(updatedParentRow, 75, 96), { canEnterFormulas, rangeKind: "expenses" })],
      },
    ];

    // 7. PREPARE CHILD ROWS (segmented into identical safe bands)
    const missingChildRows = [];
    for (let k = 0; k < totalChildRowsNeeded; k++) {
      const childRowNum = actualChildRows[k];
      if (didMoveRows || !preloadedFormulaRowsByRowNum.has(childRowNum)) {
        missingChildRows.push(childRowNum);
      }
    }
    if (missingChildRows.length > 0) {
      const childBatchResp = await withRetry(() =>
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: clientSheetId,
          ranges: missingChildRows.map((rNum) => `${sheetName}!A${rNum}:CR${rNum}`),
          valueRenderOption: "FORMULA",
        })
      );
      const valueRanges = childBatchResp.data?.valueRanges || [];
      missingChildRows.forEach((rNum, idx) => {
        preloadedFormulaRowsByRowNum.set(rNum, valueRanges[idx]?.values?.[0] || []);
      });
    }

    for (let k = 0; k < totalChildRowsNeeded; k++) {
      const childRowNum = actualChildRows[k];
      const existingChildRow = preloadedFormulaRowsByRowNum.get(childRowNum) || [];
      const updatedChildRow = new Array(maxCols).fill("");
      for (let c = 0; c < maxCols; c++) {
        if (existingChildRow[c] !== undefined) {
          updatedChildRow[c] = existingChildRow[c];
        }
      }

      applyChildRowValues(
        updatedChildRow,
        job,
        cols,
        childInvoices[k] || {},
        childExpenses[k] || {},
        {
          isJobCosting,
          sheetName,
          rowNum: childRowNum,
          canEnterFormulas,
        }
      );

      batchUpdateData.push(
        {
          range: `${sheetName}!A${childRowNum}:AM${childRowNum}`,
          values: [sanitizeJobSlice(slicePad(updatedChildRow, 0, 39), { isJobCosting, isPrimaryRange: true, canEnterFormulas })],
        },
        {
          range: `${sheetName}!AN${childRowNum}`,
          values: [[""]],
        },
        {
          range: `${sheetName}!AP${childRowNum}:${invBandEndCol}${childRowNum}`,
          values: [sanitizeJobSlice(slicePad(updatedChildRow, 41, invBandEndIdx), { canEnterFormulas, rangeKind: "invoices" })],
        },
        {
          range: `${sheetName}!BX${childRowNum}:CR${childRowNum}`,
          values: [sanitizeJobSlice(slicePad(updatedChildRow, 75, 96), { canEnterFormulas, rangeKind: "expenses" })],
        }
      );
    }

    // 7.1. GROUP CHILD ROWS FIRST (while sheet is idle so structural batchUpdate completes in <1s)
    try {
      let currentSheetObj = targetSheetObj;
      if (didMoveRows) {
        const metaWithGroups = await withRetry(() =>
          sheets.spreadsheets.get({
            spreadsheetId: clientSheetId,
            fields: "sheets(properties.sheetId,properties.title,rowGroups)",
          })
        );
        currentSheetObj = (metaWithGroups.data?.sheets || []).find(
          (s) => s.properties?.sheetId === sheetId
        );
      }
      const existingRowGroups = currentSheetObj?.rowGroups || [];
      const groupRequests = [];

      // Ensure parent row and any cleared excess child rows are unhidden
      if (parentRow >= 3) {
        groupRequests.push({
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: parentRow - 1,
              endIndex: parentRow,
            },
            properties: { hiddenByUser: false },
            fields: "hiddenByUser",
          },
        });
      }
      if (existingChildRows.length > totalChildRowsNeeded) {
        for (let i = totalChildRowsNeeded; i < existingChildRows.length; i++) {
          const clearedRowNum = existingChildRows[i];
          groupRequests.push({
            updateDimensionProperties: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: clearedRowNum - 1,
                endIndex: clearedRowNum,
              },
              properties: { hiddenByUser: false },
              fields: "hiddenByUser",
            },
          });
        }
      }

      if (actualChildRows.length > 0) {
        const childStartIndex = actualChildRows[0] - 1; // 0-based inclusive
        const childEndIndex = actualChildRows[actualChildRows.length - 1]; // 0-based exclusive

        const overlappingGroups = existingRowGroups.filter(
          (g) => g.range && g.range.startIndex < childEndIndex && g.range.endIndex > childStartIndex
        );

        const exactMatch = overlappingGroups.find(
          (g) => g.range.startIndex === childStartIndex && g.range.endIndex === childEndIndex
        );

        if (!exactMatch) {
          const wasCollapsed = overlappingGroups.some((g) => g.collapsed);
          for (const g of overlappingGroups) {
            groupRequests.push({
              deleteDimensionGroup: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: g.range.startIndex,
                  endIndex: g.range.endIndex,
                },
              },
            });
          }

          groupRequests.push({
            addDimensionGroup: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: childStartIndex,
                endIndex: childEndIndex,
              },
            },
          });

          if (wasCollapsed) {
            groupRequests.push(
              {
                updateDimensionGroup: {
                  dimensionGroup: {
                    range: {
                      sheetId,
                      dimension: "ROWS",
                      startIndex: childStartIndex,
                      endIndex: childEndIndex,
                    },
                    depth: 1,
                    collapsed: true,
                  },
                  fields: "collapsed",
                },
              },
              {
                updateDimensionProperties: {
                  range: {
                    sheetId,
                    dimension: "ROWS",
                    startIndex: childStartIndex,
                    endIndex: childEndIndex,
                  },
                  properties: { hiddenByUser: true },
                  fields: "hiddenByUser",
                },
              }
            );
          } else {
            groupRequests.push({
              updateDimensionProperties: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: childStartIndex,
                  endIndex: childEndIndex,
                },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            });
          }
        }
      } else {
        // If 0 child rows, remove any old dimension group covering rows immediately below parentRow
        const parentIndex0 = parentRow; // 0-based index of row right below parent
        const coveringGroup = existingRowGroups.find(
          (g) => g.range?.startIndex === parentIndex0
        );
        if (coveringGroup) {
          groupRequests.push(
            {
              deleteDimensionGroup: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: coveringGroup.range.startIndex,
                  endIndex: coveringGroup.range.endIndex,
                },
              },
            },
            {
              updateDimensionProperties: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: coveringGroup.range.startIndex,
                  endIndex: coveringGroup.range.endIndex,
                },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            }
          );
        }
      }

      if (groupRequests.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.batchUpdate({
            spreadsheetId: clientSheetId,
            requestBody: {
              requests: groupRequests,
            },
          })
        );
      }
    } catch (groupErr) {
      console.warn("⚠️ Row grouping warning (non-fatal):", groupErr.message);
    }

    // 7.5. EXECUTE VALUE WRITES & DEFERRED CLEARS SECOND (atomic, preserves Column AO and BI:BW untouched)
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        _skipFormulaRecompute: deferredClearRanges.length > 0 || shouldProvisionRetainerSchedule,
        _deferBackgroundRecompute: !(deferredClearRanges.length > 0 || shouldProvisionRetainerSchedule),
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: batchUpdateData,
        },
      })
    );

    if (deferredClearRanges.length > 0) {
      try {
        await withRetry(() =>
          sheets.spreadsheets.values.batchClear({
            spreadsheetId: clientSheetId,
            _skipFormulaRecompute: deferredRestoreData.length > 0 || shouldProvisionRetainerSchedule,
            _deferBackgroundRecompute: !(deferredRestoreData.length > 0 || shouldProvisionRetainerSchedule),
            requestBody: { ranges: deferredClearRanges },
          })
        );
        if (deferredRestoreData.length > 0) {
          await withRetry(() =>
            sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: clientSheetId,
              _skipFormulaRecompute: shouldProvisionRetainerSchedule,
              _deferBackgroundRecompute: !shouldProvisionRetainerSchedule,
              requestBody: {
                valueInputOption: "USER_ENTERED",
                data: deferredRestoreData,
              },
            })
          );
        }
      } catch (clearErr) {
        console.warn("Warning clearing unused/old rows:", clearErr.message);
      }
    }

    // 8. LOG ACTIVITY (NON-BLOCKING)
    const jobName = job.jobName || "Untitled Job";
    const action = isNewJob ? "JOB_CREATED" : "JOB_MODIFIED";
    const summary = isNewJob
      ? `Created new job: "${jobName}" (${sheetName})`
      : `Updated job: "${jobName}" (${sheetName})`;

    logPulseActivity(sheets, {
      clientName: verifiedClientName || clientName || "Client",
      category: "JOB",
      action,
      summary,
      details: {
        jobName,
        client: job.client,
        sheetName,
        revenue: job.revenue,
        isNewJob,
        rowNumber: parentRow,
        childRows: actualChildRows.length
      },
      user: sessionUser.name || sessionUser.email
    }).catch((logErr) => console.warn("⚠️ Failed to log job activity:", logErr.message));

    if (shouldProvisionRetainerSchedule) {
      await provisionRetainerChildRows_(sheets, {
        clientSheetId,
        clientName: verifiedClientName || clientName || "",
        parentRowNum: parentRow,
        client: job.client || "",
        jobName: job.jobName || "",
        monthlyRevenue: parseMoney(job.revenue) || 0,
        vat: job.vat || "Yes",
        startDate: formatDate(job.startDate),
        endDate: (cols.endDate !== -1 ? updatedParentRow[cols.endDate] : formatDate(job.endDate)) || NO_END_DATE_SHEET_VALUE,
        initialInvoices: validInvoices,
      });
    }

    // 9. FLUSH RELATIONAL / FORMULA RECOMPUTES FIRST, THEN INVALIDATE CACHES
    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, verifiedClientName || clientName || "").catch(() => { });

    try {
      await invalidatePmaClientCache(clientSheetId, null, ["jobs", "invoices", "outgoings", "retainers", "cash", "views"]);
    } catch (cacheErr) {
      console.warn("⚠️ Cache invalidation warning:", cacheErr.message);
    }

    // 10. Relink any existing Pulse notes if job name/code changed or manual invoice/expense slots shifted
    const oldJobKey = !isNewJob && existingParentRow.length > 0
      ? buildJobNoteKey({
        client: existingParentRow[cols.client] || job.client,
        jobName: existingParentRow[cols.jobName] || job.jobName,
        projectCode: existingParentRow[cols.projectCode] || "",
        rowNumber: parentRow,
      })
      : "";
    const newJobKey = buildJobNoteKey({
      client: job.client,
      jobName: job.jobName,
      projectCode: job.projectCode,
      rowNumber: parentRow,
    });
    relinkNotesForJobChange({
      clientName: verifiedClientName || clientName || job.client || "",
      oldJobKey,
      newJobKey,
      newJobLabel: buildJobNoteLabel(job),
      invoices: validInvoices,
      directExpenses: validExpenses,
    }).catch(() => { });

    let savedJobUuid = relationalAnchor?.resolved && !isSheetChange ? relationalAnchor.jobUuid : null;
    try {
      const relLookup = await getClientRelationalJobsLookup(verifiedClientName || clientName || "");
      const matched = relLookup?.jobsByTabAndRow?.get(`${sheetName.toLowerCase()}:${parentRow}`);
      if (matched?.id) savedJobUuid = matched.id;
    } catch (_) { }

    return res.status(200).json({
      success: true,
      rowNumber: parentRow,
      ...(savedJobUuid ? { jobUuid: savedJobUuid } : {}),
      sheetName,
      childRowNumbers: actualChildRows,
      ...(shouldProvisionRetainerSchedule ? {} : { invoices: validInvoices }),
      directExpenses: validExpenses,
      backgroundProvisioning: false,
    });
  } catch (err) {
    console.error("❌ /api/portal/save-job error:", err);
    const status = err?.statusCode || 500;
    return res.status(status).json({ success: false, error: sessionUser?.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
  } finally {
    await flushImmediateAndScheduleBackgroundClientRecomputes().catch(() => { });
  }
}
