/**
 * ============================================================================
 * PULSE PHASE 2 — RELATIONAL JOBS, RETAINERS, INVOICES & DIRECT EXPENSES
 * ============================================================================
 * Provides lossless two-way conversion, UUID-preserving reconciliation, backfill,
 * and parity verification between legacy `master_sheet_grids` (`Confirmed` /
 * `Pipeline`) and normalized SQL tables:
 *   - `public.pulse_retainer_series`
 *   - `public.pulse_jobs`
 *   - `public.pulse_job_invoices`
 *   - `public.pulse_job_expenses`
 * ============================================================================
 */

import fs from "fs";
import path from "path";
import { waitUntil } from "@vercel/functions";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import {
  getOrLoadVirtualTabGrid_,
  resolveSupabaseSheetContext,
  invalidateSheetContextCache,
  isVirtualSupabaseSheetId,
} from "./masterEngineService.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import { redisClient } from "./redisClient.js";
import { buildJobNoteKey } from "../utils/pulseNotesKeys.js";
import { formatCellForDisplay } from "./gasRuntime/sheetValueUtils.js";
import {
  canonicalizeInvoiceStatus,
  canonicalizeExpenseStatus,
  formatLikelihood,
  isJobCostingStyle,
  isNoEndDateSentinel,
  isPlaceholderInvoice,
  isPlaceholderExpense,
  parseVariableRetainerTag,
  toSheetDateFormat,
} from "../utils/helpers.js";

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const JC_AUTO_FORMULA_COLS = new Set([10, 12, 13, 14, 20, 24, 32, 33, 37, 38]);

export const PHASE2_JOB_TABLES = [
  { name: "pulse_retainer_series", label: "Retainer series (Fixed & Variable)" },
  { name: "pulse_jobs", label: "Confirmed & Pipeline jobs" },
  { name: "pulse_job_invoices", label: "Normalized job invoices" },
  { name: "pulse_job_expenses", label: "Normalized job direct expenses" },
];

let _verifiedPhase2SchemaReady = false;
let _cachedMigration0012Sql = null;

/**
 * Reads migration 0012 SQL from disk once so PMA > DB can offer 1-click copy.
 */
export function readMigration0012Sql() {
  if (_cachedMigration0012Sql !== null) return _cachedMigration0012Sql;
  try {
    const p = path.join(process.cwd(), "supabase", "migrations", "0012_phase2_relational_jobs.sql");
    _cachedMigration0012Sql = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  } catch {
    _cachedMigration0012Sql = "";
  }
  return _cachedMigration0012Sql;
}

function isNonEmptyCell_(v) {
  return v !== undefined && v !== null && v !== "";
}

function isFormulaStr_(v) {
  return typeof v === "string" && v.trim().startsWith("=");
}

function normalizeTextKey_(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseNumericOrDefault_(val, fallback = 0) {
  if (val === undefined || val === null || val === "") return fallback;
  if (typeof val === "number") return Number.isFinite(val) ? val : fallback;
  const s = String(val).trim();
  if (!s) return fallback;
  const pct = s.endsWith("%");
  const cleaned = s.replace(/[£$€,\s%]/g, "");
  if (!cleaned) return fallback;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return fallback;
  return pct ? num / 100 : num;
}

function parseNullableNumeric_(val) {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  const s = String(val).trim();
  if (!s) return null;
  const pct = s.endsWith("%");
  const cleaned = s.replace(/[£$€,\s%]/g, "");
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return pct ? num / 100 : num;
}

function parseNullableLikelihood_(val) {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return null;
    return val > 1 && val <= 100 ? val / 100 : val;
  }
  const s = String(val).trim();
  if (!s) return null;
  const hasPct = s.includes("%");
  const n = Number(s.replace(/[%\s,]/g, ""));
  if (!Number.isFinite(n)) return null;
  if (hasPct || (n > 1 && n <= 100)) return n / 100;
  return n;
}

function parseDateYearMonth_(val) {
  if (val === undefined || val === null || val === "") return "";
  if (typeof val === "number" && Number.isFinite(val) && val > 25000 && val < 90000) {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!Number.isNaN(d.getTime())) {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    }
  }
  const s = String(val).trim();
  if (!s) return "";
  if (/^\d{4,5}(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 25000 && n < 90000) {
      const d = new Date(Math.round((n - 25569) * 86400 * 1000));
      if (!Number.isNaN(d.getTime())) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      }
    }
  }
  const iso = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}`;
  const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const dmy = s.match(/^(?:\d{1,2}[\s-/]+)?([A-Za-z]{3})[a-z]*[\s-/]+(\d{2,4})$/);
  if (dmy) {
    const m = months[dmy[1].toLowerCase()];
    let yr = parseInt(dmy[2], 10);
    if (yr < 100) yr += yr <= 69 ? 2000 : 1900;
    if (m && Number.isFinite(yr)) return `${yr}-${m}`;
  }
  return "";
}

function parseCellDateText_(val) {
  if (val === undefined || val === null || val === "") return "";
  if (typeof val === "number" && Number.isFinite(val) && val > 25000 && val < 90000) {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!Number.isNaN(d.getTime())) {
      return toSheetDateFormat(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
  }
  return String(val).trim();
}

function getInvoiceSlotDefs_(tabName) {
  if (tabName === "Confirmed") {
    return [
      { slotIndex: 0, startCol: 41, colCount: 7 },
      { slotIndex: 1, startCol: 48, colCount: 7 },
      { slotIndex: 2, startCol: 55, colCount: 7 },
    ];
  }
  return [
    { slotIndex: 0, startCol: 41, colCount: 7 },
    { slotIndex: 1, startCol: 48, colCount: 7 },
    { slotIndex: 2, startCol: 55, colCount: 5 },
  ];
}

function getExpenseSlotDefs_() {
  return [
    { slotIndex: 0, startCol: 75, colCount: 7 },
    { slotIndex: 1, startCol: 82, colCount: 7 },
    { slotIndex: 2, startCol: 89, colCount: 7 },
  ];
}

function parseNotesByRowCol_(notesGrid) {
  const byRow = new Map();
  if (!notesGrid || typeof notesGrid !== "object") return byRow;
  for (const [k, v] of Object.entries(notesGrid)) {
    if (!k || k.startsWith("__") || PROTOTYPE_KEYS.has(k) || !v) continue;
    const colonIdx = k.indexOf(":");
    if (colonIdx <= 0) continue;
    const r0 = parseInt(k.slice(0, colonIdx), 10);
    const c0 = parseInt(k.slice(colonIdx + 1), 10);
    if (!Number.isInteger(r0) || !Number.isInteger(c0) || r0 < 0 || c0 < 0) continue;
    if (!byRow.has(r0)) byRow.set(r0, new Map());
    byRow.get(r0).set(c0, String(v));
  }
  return byRow;
}

function getInputColsForTab_(tabName) {
  const revCalcStart = tabName === "Confirmed" ? 62 : 60;
  const cols = [];
  for (let c = 0; c <= 39; c++) cols.push(c);
  for (let c = 41; c < revCalcStart; c++) cols.push(c);
  for (let c = 75; c <= 95; c++) cols.push(c);
  cols.push(107);
  return cols;
}

function isInputBandCol_(tabName, c) {
  const revCalcStart = tabName === "Confirmed" ? 62 : 60;
  return (
    (c >= 0 && c <= 39) ||
    (c >= 41 && c < revCalcStart) ||
    (c >= 75 && c <= 95) ||
    c === 107
  );
}

function hasAnyPopulatedInRange_(vRow, fRow, rowNotes, startCol, endExclusive) {
  for (let c = startCol; c < endExclusive; c++) {
    if (isNonEmptyCell_(vRow[c]) || isFormulaStr_(fRow[c]) || (rowNotes && rowNotes.has(c))) {
      return true;
    }
  }
  return false;
}

/**
 * Distinguishes active Confirmed/Pipeline job/child rows from pre-filled empty template rows.
 */
function isActiveJobOrChildRow_(r0, vRow, fRow, rowNotes, { tabName, isJobCosting }) {
  if (r0 < 1) return false;
  const revCalcStart = tabName === "Confirmed" ? 62 : 60;

  if (
    isNonEmptyCell_(vRow[0]) ||
    isNonEmptyCell_(vRow[1]) ||
    isNonEmptyCell_(vRow[2]) ||
    isFormulaStr_(fRow[0]) ||
    isFormulaStr_(fRow[1]) ||
    isFormulaStr_(fRow[2])
  ) {
    return true;
  }

  if (hasAnyPopulatedInRange_(vRow, fRow, rowNotes, 41, revCalcStart)) return true;
  if (hasAnyPopulatedInRange_(vRow, fRow, rowNotes, 75, 96)) return true;
  if (isNonEmptyCell_(vRow[107]) || isFormulaStr_(fRow[107])) return true;

  if (rowNotes) {
    for (const c0 of rowNotes.keys()) {
      if (isInputBandCol_(tabName, c0)) return true;
    }
  }

  const hasNonZeroRevOrDc = isJobCosting
    ? (isNonEmptyCell_(vRow[8]) && parseNumericOrDefault_(vRow[8], 0) !== 0) ||
    isNonEmptyCell_(vRow[5]) ||
    isNonEmptyCell_(vRow[6]) ||
    (isNonEmptyCell_(vRow[17]) && parseNumericOrDefault_(vRow[17], 0) !== 0) ||
    isFormulaStr_(fRow[8]) ||
    isFormulaStr_(fRow[5]) ||
    isFormulaStr_(fRow[6]) ||
    isFormulaStr_(fRow[17])
    : isNonEmptyCell_(vRow[32]) ||
    isNonEmptyCell_(vRow[33]) ||
    (isNonEmptyCell_(vRow[17]) && parseNumericOrDefault_(vRow[17], 0) !== 0) ||
    isFormulaStr_(fRow[32]) ||
    isFormulaStr_(fRow[33]) ||
    isFormulaStr_(fRow[17]);

  if (hasNonZeroRevOrDc) {
    if (r0 === 1 && !isJobCosting) return true;
    if (r0 >= 2) return true;
  }

  if (r0 >= 2) {
    const checkCols = [3, 4, 30, 34, 36];
    for (const c of checkCols) {
      if (isNonEmptyCell_(vRow[c]) || isFormulaStr_(fRow[c])) return true;
    }
    if (!isJobCosting) {
      for (const c of [37, 38]) {
        if (isNonEmptyCell_(vRow[c]) || isFormulaStr_(fRow[c])) return true;
      }
    }
  }

  return false;
}

/**
 * Determines if an active contiguous row directly below an existing job is an invoice/expense overflow child row.
 */
function isOverflowChildRow_(vRow, fRow, rowNotes, parentJob, { tabName, isJobCosting }) {
  if (!parentJob) return false;
  if (vRow[30] && parseVariableRetainerTag(vRow[30])) return false;

  const rClient = normalizeTextKey_(vRow[0]);
  const rJob = normalizeTextKey_(vRow[1]);
  const pClient = normalizeTextKey_(parentJob.customer_name);
  const pJob = normalizeTextKey_(parentJob.job_name);

  const isExplicitSameJobChild = pClient !== "" && rClient === pClient && rJob === pJob;
  const identityMatchesParent = (rClient === "" && rJob === "") || isExplicitSameJobChild;
  if (!identityMatchesParent) return false;

  const revCalcStart = tabName === "Confirmed" ? 62 : 60;
  const hasInvoicesOrExpenses =
    hasAnyPopulatedInRange_(vRow, fRow, rowNotes, 41, revCalcStart) ||
    hasAnyPopulatedInRange_(vRow, fRow, rowNotes, 75, 96);

  if (!isExplicitSameJobChild && !hasInvoicesOrExpenses) {
    return false;
  }

  if (isJobCosting) {
    const revEmpty =
      (!isNonEmptyCell_(vRow[8]) || parseNumericOrDefault_(vRow[8], 0) === 0) &&
      !isFormulaStr_(fRow[8]);
    const jcDatesEmpty = !isNonEmptyCell_(vRow[5]) && !isNonEmptyCell_(vRow[6]);
    const rechEmpty = !isNonEmptyCell_(vRow[17]) || parseNumericOrDefault_(vRow[17], 0) === 0;
    const revFormulaSafe = !isNonEmptyCell_(vRow[32]);
    return revEmpty && jcDatesEmpty && rechEmpty && revFormulaSafe;
  }

  const revEmpty = !isNonEmptyCell_(vRow[32]) && !isFormulaStr_(fRow[32]);
  const dcEmpty = !isNonEmptyCell_(vRow[33]) && !isFormulaStr_(fRow[33]);
  const rechEmpty =
    (!isNonEmptyCell_(vRow[17]) || parseNumericOrDefault_(vRow[17], 0) === 0) &&
    !isFormulaStr_(fRow[17]);

  return revEmpty && dcEmpty && rechEmpty;
}

function captureCellMeta_(vRow, fRow, rowNotes, colIdx) {
  const v = vRow[colIdx] !== undefined && vRow[colIdx] !== null ? vRow[colIdx] : "";
  const f = fRow[colIdx];
  const hasFormula = isFormulaStr_(f);
  const hasFormulaGridDiff = !hasFormula && f !== undefined && f !== null && f !== v;
  const note = rowNotes && rowNotes.has(colIdx) ? rowNotes.get(colIdx) : "";
  return { v, f: hasFormula ? f : undefined, fg: hasFormulaGridDiff ? f : undefined, hasFormula, note };
}

function serializeSlotRawCells_(vRow, fRow, rowNotes, slotDef) {
  const rawCells = [];
  const customFormulas = {};
  const cellNotes = {};
  let hasAny = false;

  for (let rel = 0; rel < slotDef.colCount; rel++) {
    const c = slotDef.startCol + rel;
    const meta = captureCellMeta_(vRow, fRow, rowNotes, c);
    rawCells.push(meta.v);
    if (meta.hasFormula) {
      customFormulas[String(rel)] = meta.f;
      hasAny = true;
    } else if (meta.fg !== undefined) {
      customFormulas[`fg:${rel}`] = meta.fg;
    }
    if (meta.note) {
      cellNotes[String(rel)] = meta.note;
      hasAny = true;
    }
    if (isNonEmptyCell_(meta.v)) hasAny = true;
  }

  return { rawCells, customFormulas, cellNotes, hasAny };
}

function extractSlotsFromRow_(vRow, fRow, rowNotes, { tabName, rowOffset }) {
  const invDefs = getInvoiceSlotDefs_(tabName);
  const expDefs = getExpenseSlotDefs_();
  const invoices = [];
  const expenses = [];

  for (const def of invDefs) {
    const { rawCells, customFormulas, cellNotes, hasAny } = serializeSlotRawCells_(vRow, fRow, rowNotes, def);
    if (!hasAny) continue;
    const amtVal = vRow[def.startCol];
    const refVal = vRow[def.startCol + 1];
    const sdVal = vRow[def.startCol + 2];
    const daysVal = vRow[def.startCol + 3];
    const statusVal = vRow[def.startCol + 4];
    const rechVal = def.colCount > 5 ? vRow[def.startCol + 5] : "";
    const cmVal = def.colCount > 6 ? vRow[def.startCol + 6] : "";
    const refStr = String(refVal ?? "").trim();
    const statusStr = String(statusVal ?? "").trim();
    invoices.push({
      row_offset: rowOffset,
      slot_index: def.slotIndex,
      amount: parseNumericOrDefault_(amtVal, 0),
      invoice_ref: refStr,
      send_date: parseCellDateText_(sdVal),
      days_to_pay: parseNullableNumeric_(daysVal),
      status: statusStr,
      of_which_recharged: parseNumericOrDefault_(rechVal, 0),
      cost_month: String(cmVal ?? "").trim(),
      description: "",
      is_placeholder: isPlaceholderInvoice(refStr, statusStr),
      raw_cells: rawCells,
      custom_formulas: customFormulas,
      cell_notes: cellNotes,
    });
  }

  for (const def of expDefs) {
    const { rawCells, customFormulas, cellNotes, hasAny } = serializeSlotRawCells_(vRow, fRow, rowNotes, def);
    if (!hasAny) continue;
    const descVal = vRow[def.startCol];
    const amtVal = vRow[def.startCol + 1];
    const vatVal = vRow[def.startCol + 2];
    const rdVal = vRow[def.startCol + 3];
    const daysVal = vRow[def.startCol + 4];
    const statusVal = vRow[def.startCol + 5];
    const appIdVal = vRow[def.startCol + 6];
    const descStr = String(descVal ?? "").trim();
    const statusStr = String(statusVal ?? "").trim();
    const appIdStr = String(appIdVal ?? "").trim();
    expenses.push({
      row_offset: rowOffset,
      slot_index: def.slotIndex,
      description: descStr,
      amount: parseNumericOrDefault_(amtVal, 0),
      vat_applicable: String(vatVal ?? "").trim(),
      received_date: parseCellDateText_(rdVal),
      days_to_pay: parseNullableNumeric_(daysVal),
      status: statusStr,
      external_app_id: appIdStr,
      is_placeholder: isPlaceholderExpense(appIdStr, descStr, statusStr),
      raw_cells: rawCells,
      custom_formulas: customFormulas,
      cell_notes: cellNotes,
    });
  }

  return { invoices, expenses };
}

const ROLLUP_CALCS_COLS = [74, 106, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 155, 156, 157, 158, 159, 160, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262];
const ROLLUP_CALCS_COL_SET = new Set(ROLLUP_CALCS_COLS);

function captureNonSlotRowIntoJob_(vRow, fRow, rowNotes, job, { tabName, rowOffset, calcsRow = null, dateCellsMap = null, r0 = 0 }) {
  const revCalcStart = tabName === "Confirmed" ? 62 : 60;
  const captureCols = [];
  for (let c = 0; c <= 39; c++) captureCols.push(c);
  captureCols.push(107);

  for (const c of captureCols) {
    if (c >= 41 && c < revCalcStart) continue;
    if (c >= 75 && c <= 95) continue;
    const meta = captureCellMeta_(vRow, fRow, rowNotes, c);
    if (meta.hasFormula) {
      job.custom_formulas[`${rowOffset}:${c}`] = meta.f;
    } else if (meta.fg !== undefined) {
      job.custom_formulas[`fg:${rowOffset}:${c}`] = meta.fg;
    }
    if (meta.note) {
      job.cell_notes[`${rowOffset}:${c}`] = meta.note;
    }
    if (isNonEmptyCell_(meta.v)) {
      if (rowOffset === 0) {
        job.raw_scalars[String(c)] = meta.v;
      } else {
        job.extra_fields[`${rowOffset}:${c}`] = meta.v;
      }
    }
  }

  // Capture Phase 2C rollup cells (`74`, `106`) from tab grid + `ConfCalcs`/`PipeCalcs` overrides
  const tabRollupCols = [74, 106];
  for (const c of tabRollupCols) {
    const tv = vRow[c];
    if (isNonEmptyCell_(tv)) {
      if (!job.extra_fields._calcs) job.extra_fields._calcs = {};
      if (!job.extra_fields._calcs.tab) job.extra_fields._calcs.tab = {};
      if (!job.extra_fields._calcs.tab[String(rowOffset)]) job.extra_fields._calcs.tab[String(rowOffset)] = {};
      job.extra_fields._calcs.tab[String(rowOffset)][String(c)] = tv;
    }
  }

  if (
    Array.isArray(calcsRow) &&
    calcsRow.length > 0 &&
    normalizeTextKey_(calcsRow[0]) === normalizeTextKey_(vRow[0]) &&
    normalizeTextKey_(calcsRow[1]) === normalizeTextKey_(vRow[1])
  ) {
    for (const c of ROLLUP_CALCS_COLS) {
      const cv = calcsRow[c];
      if (isNonEmptyCell_(cv)) {
        if (!job.extra_fields._calcs) job.extra_fields._calcs = {};
        if (!job.extra_fields._calcs.calcs) job.extra_fields._calcs.calcs = {};
        if (!job.extra_fields._calcs.calcs[String(rowOffset)]) job.extra_fields._calcs.calcs[String(rowOffset)] = {};
        job.extra_fields._calcs.calcs[String(rowOffset)][String(c)] = cv;
      }
    }
  }

  if (dateCellsMap && typeof dateCellsMap === "object") {
    const prefix = `${r0}:`;
    for (const k of Object.keys(dateCellsMap)) {
      if (!k.startsWith(prefix) || !dateCellsMap[k]) continue;
      const c = parseInt(k.slice(prefix.length), 10);
      if (Number.isInteger(c) && (isInputBandCol_(tabName, c) || c === 74 || c === 106 || (c >= 144 && c <= 160))) {
        if (!job.extra_fields._dateCells) job.extra_fields._dateCells = {};
        job.extra_fields._dateCells[`${rowOffset}:${c}`] = 1;
      }
    }
  }
}

/**
 * Parses a client's `Confirmed` or `Pipeline` tab grid into normalized
 * retainer series, jobs, invoices, and direct expenses with zero data loss.
 */
export function parseTabGridToRelationalModel({
  clientId = null,
  clientName = "",
  tabName = "Confirmed",
  valuesGrid = [],
  formulasGrid = [],
  notesGrid = {},
  calcsValuesGrid = null,
  calcsNotesGrid = null,
}) {
  const tabType = tabName === "Pipeline" ? "pipeline" : "confirmed";
  const headerRow = Array.isArray(valuesGrid[0]) ? valuesGrid[0] : [];
  const isJobCosting = isJobCostingStyle({ headers: headerRow });
  const notesByRow = parseNotesByRowCol_(notesGrid);
  const dateCellsMap = notesGrid?.__dateCells || null;
  const calcsDateCellsMap = calcsNotesGrid?.__dateCells || null;

  const jobs = [];
  const retainerSeriesByKey = new Map();
  let currentJob = null;
  let lastActiveRow0 = -1;

  for (let r = 1; r < valuesGrid.length; r++) {
    const vRow = Array.isArray(valuesGrid[r]) ? valuesGrid[r] : [];
    const fRow = Array.isArray(formulasGrid[r]) ? formulasGrid[r] : [];
    const rowNotes = notesByRow.get(r) || null;

    if (!isActiveJobOrChildRow_(r, vRow, fRow, rowNotes, { tabName, isJobCosting })) {
      continue;
    }

    const isContiguous = lastActiveRow0 === r - 1;
    if (
      currentJob &&
      isContiguous &&
      isOverflowChildRow_(vRow, fRow, rowNotes, currentJob, { tabName, isJobCosting })
    ) {
      const childOffset = r + 1 - currentJob.sheet_row_num;
      currentJob.sheet_child_row_count = Math.max(currentJob.sheet_child_row_count, childOffset);
      captureNonSlotRowIntoJob_(vRow, fRow, rowNotes, currentJob, {
        tabName,
        rowOffset: childOffset,
        calcsRow: Array.isArray(calcsValuesGrid?.[r]) ? calcsValuesGrid[r] : null,
        dateCellsMap: calcsDateCellsMap || dateCellsMap,
        r0: r,
      });

      const { invoices, expenses } = extractSlotsFromRow_(vRow, fRow, rowNotes, {
        tabName,
        rowOffset: childOffset,
      });
      for (const inv of invoices) {
        inv.slot_order = currentJob.invoices.length;
        currentJob.invoices.push(inv);
      }
      for (const exp of expenses) {
        exp.slot_order = currentJob.expenses.length;
        currentJob.expenses.push(exp);
      }
      lastActiveRow0 = r;
      continue;
    }

    const customerName = String(vRow[0] ?? "").trim();
    const jobName = String(vRow[1] ?? "").trim();
    const projectCode = String(vRow[2] ?? "").trim();
    const dateConf = parseCellDateText_(vRow[3]);
    const leadSrc = String(vRow[4] ?? "").trim();
    const unevenSplit = String(vRow[30] ?? "").trim();
    const startRaw = isJobCosting ? vRow[5] || vRow[37] : vRow[37];
    const endRaw = isJobCosting ? vRow[6] || vRow[38] : vRow[38];
    const startDate = parseCellDateText_(startRaw);
    const endDate = parseCellDateText_(endRaw);
    const noEndDate = isNoEndDateSentinel(endRaw) || isNoEndDateSentinel(vRow[38]);
    const jobType = String(vRow[35] ?? "").trim();
    const productLine = String(vRow[36] ?? "").trim();
    const vatVal = String(vRow[34] ?? "").trim();

    let seriesKey = "";
    const vrMeta = parseVariableRetainerTag(unevenSplit);
    const isRetainerType = jobType.toLowerCase().includes("retainer");
    if (vrMeta) {
      seriesKey = `vr::${normalizeTextKey_(customerName)}::${normalizeTextKey_(vrMeta.seriesName || jobName)}`;
      if (!retainerSeriesByKey.has(seriesKey)) {
        retainerSeriesByKey.set(seriesKey, {
          client_id: clientId,
          client_name: clientName,
          tab_type: tabType,
          series_type: "variable",
          series_key: seriesKey,
          customer_name: customerName,
          series_name: vrMeta.seriesName || jobName,
          project_code: projectCode,
          lead_source: leadSrc,
          product_line: productLine,
          vat_applicable: vatVal || "Yes",
          base_revenue: Number(vrMeta.baseRev) || 0,
          base_direct_costs: Number(vrMeta.baseDC) || 0,
          billing_interval_months: 1,
          invoice_send_day: Number(vrMeta.sendDay) || 28,
          start_date: startDate,
          end_date: vrMeta.endDate || endDate,
          no_end_date: Boolean(vrMeta.noEndDate || noEndDate),
          metadata: { source: "variable_retainer_tag" },
        });
      }
    } else if (isRetainerType) {
      seriesKey = `fr::r${r + 1}::${normalizeTextKey_(customerName)}::${normalizeTextKey_(jobName)}`;
      if (!retainerSeriesByKey.has(seriesKey)) {
        retainerSeriesByKey.set(seriesKey, {
          client_id: clientId,
          client_name: clientName,
          tab_type: tabType,
          series_type: "fixed",
          series_key: seriesKey,
          customer_name: customerName,
          series_name: jobName,
          project_code: projectCode,
          lead_source: leadSrc,
          product_line: productLine,
          vat_applicable: vatVal || "Yes",
          base_revenue: parseNumericOrDefault_(vRow[32], 0),
          base_direct_costs: parseNumericOrDefault_(vRow[33], 0),
          billing_interval_months: 1,
          invoice_send_day: 28,
          start_date: startDate,
          end_date: endDate,
          no_end_date: noEndDate,
          metadata: { source: "fixed_retainer_row", sheetRowNum: r + 1 },
        });
      }
    }

    const jobObj = {
      client_id: clientId,
      client_name: clientName,
      tab_type: tabType,
      series_key: seriesKey,
      retainer_period_ym: seriesKey ? parseDateYearMonth_(startRaw) : "",
      sort_order: jobs.length,
      sheet_row_num: r + 1,
      sheet_child_row_count: 0,
      customer_name: customerName,
      job_name: jobName,
      project_code: projectCode,
      lead_owner: "",
      date_confirmed: dateConf,
      lead_source: leadSrc,
      uneven_split: unevenSplit,
      revenue: parseNumericOrDefault_(vRow[32], 0),
      direct_costs: parseNumericOrDefault_(vRow[33], 0),
      recharged_expenses: parseNumericOrDefault_(vRow[17], 0),
      vat_applicable: vatVal,
      job_type: jobType,
      product_line: productLine,
      start_date: startDate,
      end_date: endDate,
      no_end_date: noEndDate,
      likelihood_pct: parseNullableLikelihood_(vRow[39]),
      copied_to_confirmed: String(vRow[107] ?? "").trim(),
      is_job_costing: isJobCosting,
      jc_start_date: isJobCosting ? parseCellDateText_(vRow[5]) : "",
      jc_end_date: isJobCosting ? parseCellDateText_(vRow[6]) : "",
      jc_fixed_variable: isJobCosting ? String(vRow[7] ?? "").trim() : "",
      jc_job_revenue: isJobCosting ? parseNullableNumeric_(vRow[8]) : null,
      jc_likelihood_input: isJobCosting ? parseNullableLikelihood_(vRow[9]) : null,
      jc_contractor_costs: isJobCosting ? parseNullableNumeric_(vRow[10]) : null,
      jc_external_costs: isJobCosting ? parseNullableNumeric_(vRow[16]) : null,
      jc_prop_succ_fee_pct: isJobCosting ? parseNullableLikelihood_(vRow[19]) : null,
      jc_prop_succ_fee_rec: isJobCosting ? String(vRow[21] ?? "").trim() : "",
      jc_inv_no: isJobCosting ? String(vRow[27] ?? "").trim() : "",
      raw_scalars: {},
      custom_formulas: {},
      extra_fields: {},
      cell_notes: {},
      invoices: [],
      expenses: [],
    };

    captureNonSlotRowIntoJob_(vRow, fRow, rowNotes, jobObj, {
      tabName,
      rowOffset: 0,
      calcsRow: Array.isArray(calcsValuesGrid?.[r]) ? calcsValuesGrid[r] : null,
      dateCellsMap: calcsDateCellsMap || dateCellsMap,
      r0: r,
    });
    const { invoices, expenses } = extractSlotsFromRow_(vRow, fRow, rowNotes, {
      tabName,
      rowOffset: 0,
    });
    invoices.forEach((inv, idx) => {
      inv.slot_order = idx;
      jobObj.invoices.push(inv);
    });
    expenses.forEach((exp, idx) => {
      exp.slot_order = idx;
      jobObj.expenses.push(exp);
    });

    jobs.push(jobObj);
    currentJob = jobObj;
    lastActiveRow0 = r;
  }

  return {
    tabName,
    tabType,
    isJobCosting,
    retainerSeries: [...retainerSeriesByKey.values()],
    jobs,
  };
}

function trimTrailingEmptyGridCells_(row) {
  let end = row.length;
  while (end > 0 && (row[end - 1] === "" || row[end - 1] === null || row[end - 1] === undefined)) {
    end--;
  }
  return row.slice(0, end);
}

function ensureGridRow_(grid, r0, minColIdx) {
  while (grid.length <= r0) grid.push([]);
  if (!Array.isArray(grid[r0])) grid[r0] = [];
  while (grid[r0].length <= minColIdx) grid[r0].push("");
}

function writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c0, scalarVal, formulaStr, fgOverride, noteStr) {
  ensureGridRow_(valuesGrid, r0, c0);
  ensureGridRow_(formulasGrid, r0, c0);
  const valOut = scalarVal !== undefined && scalarVal !== null ? scalarVal : "";
  valuesGrid[r0][c0] = valOut;
  if (isFormulaStr_(formulaStr)) {
    formulasGrid[r0][c0] = formulaStr;
  } else if (fgOverride !== undefined) {
    formulasGrid[r0][c0] = fgOverride;
  } else {
    formulasGrid[r0][c0] = valOut;
  }
  if (noteStr) {
    notesGrid[`${r0}:${c0}`] = noteStr;
  }
}

function applySlotToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, slotDef, slotRec) {
  const rawCells = Array.isArray(slotRec.raw_cells) ? slotRec.raw_cells : [];
  const customFormulas = slotRec.custom_formulas && typeof slotRec.custom_formulas === "object" ? slotRec.custom_formulas : {};
  const cellNotes = slotRec.cell_notes && typeof slotRec.cell_notes === "object" ? slotRec.cell_notes : {};

  let fallbackArr = null;
  if (rawCells.length === 0) {
    fallbackArr = slotDef.startCol >= 75
      ? [
        slotRec.description || "",
        slotRec.amount ?? "",
        slotRec.vat_applicable || "",
        slotRec.received_date || "",
        slotRec.days_to_pay ?? "",
        slotRec.status || "",
        slotRec.external_app_id || "",
      ]
      : [
        slotRec.amount ?? "",
        slotRec.invoice_ref || "",
        slotRec.send_date || "",
        slotRec.days_to_pay ?? "",
        slotRec.status || "",
        slotRec.of_which_recharged ?? "",
        slotRec.cost_month || "",
      ];
  }

  for (let rel = 0; rel < slotDef.colCount; rel++) {
    const c = slotDef.startCol + rel;
    const relKey = String(rel);
    const val = rawCells.length > 0 ? (rawCells[rel] ?? "") : (fallbackArr[rel] ?? "");
    const formulaStr = Object.prototype.hasOwnProperty.call(customFormulas, relKey) ? customFormulas[relKey] : undefined;
    const fgKey = `fg:${rel}`;
    const fgOverride = Object.prototype.hasOwnProperty.call(customFormulas, fgKey) ? customFormulas[fgKey] : undefined;
    const noteStr = Object.prototype.hasOwnProperty.call(cellNotes, relKey) ? cellNotes[relKey] : "";
    if (isNonEmptyCell_(val) || isFormulaStr_(formulaStr) || fgOverride !== undefined || noteStr) {
      writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c, val, formulaStr, fgOverride, noteStr);
    }
  }
}

/**
 * Projects relational jobs, invoices, and direct expenses back onto `Confirmed`
 * or `Pipeline` grids while preserving headers, calculation columns, and template rows.
 */
export function projectRelationalModelToTabGrid({
  tabName = "Confirmed",
  jobs = [],
  invoicesByJobId = null,
  expensesByJobId = null,
  baseValuesGrid = [],
  baseFormulasGrid = [],
  baseNotesGrid = {},
  occupiedRowRangesToClear = [],
}) {
  const valuesGrid = (Array.isArray(baseValuesGrid) ? baseValuesGrid : []).map((r) =>
    Array.isArray(r) ? [...r] : []
  );
  const formulasGrid = (Array.isArray(baseFormulasGrid) && baseFormulasGrid.length
    ? baseFormulasGrid
    : valuesGrid
  ).map((r) => (Array.isArray(r) ? [...r] : []));
  const notesGrid = {};
  if (baseNotesGrid && typeof baseNotesGrid === "object") {
    for (const [k, v] of Object.entries(baseNotesGrid)) {
      if (!PROTOTYPE_KEYS.has(k) && v !== undefined && v !== null && v !== "") {
        notesGrid[k] = v;
      }
    }
  }

  const inputCols = getInputColsForTab_(tabName);
  const rowsToClear = new Set();

  for (const span of occupiedRowRangesToClear || []) {
    const start1 = Number(span?.startRowNum ?? span?.sheet_row_num ?? span);
    const end1 = Number(
      span?.endRowNum ?? (span?.sheet_child_row_count !== undefined ? start1 + Number(span.sheet_child_row_count || 0) : start1)
    );
    if (Number.isInteger(start1) && start1 >= 2 && Number.isInteger(end1) && end1 >= start1) {
      for (let r1 = start1; r1 <= end1; r1++) rowsToClear.add(r1 - 1);
    }
  }

  for (const job of jobs || []) {
    const start1 = Number(job.sheet_row_num);
    if (!Number.isInteger(start1) || start1 < 2) continue;
    const childCnt = Math.max(0, Number(job.sheet_child_row_count) || 0);
    for (let off = 0; off <= childCnt; off++) {
      rowsToClear.add(start1 - 1 + off);
    }
  }

  for (const r0 of rowsToClear) {
    if (Array.isArray(valuesGrid[r0])) {
      for (const c of inputCols) {
        if (c < valuesGrid[r0].length) valuesGrid[r0][c] = "";
      }
    }
    if (Array.isArray(formulasGrid[r0])) {
      for (const c of inputCols) {
        if (c < formulasGrid[r0].length) formulasGrid[r0][c] = "";
      }
    }
    const rowPrefix = `${r0}:`;
    for (const nk of Object.keys(notesGrid)) {
      if (nk.startsWith(rowPrefix)) {
        const c0 = parseInt(nk.slice(rowPrefix.length), 10);
        if (Number.isInteger(c0) && isInputBandCol_(tabName, c0)) {
          delete notesGrid[nk];
        }
      }
    }
  }

  const invDefs = getInvoiceSlotDefs_(tabName);
  const expDefs = getExpenseSlotDefs_();

  for (const job of jobs || []) {
    const baseRow0 = Number(job.sheet_row_num) - 1;
    if (!Number.isInteger(baseRow0) || baseRow0 < 1) continue;

    const customFormulas = job.custom_formulas && typeof job.custom_formulas === "object" ? job.custom_formulas : {};
    const cellNotes = job.cell_notes && typeof job.cell_notes === "object" ? job.cell_notes : {};
    const rawScalars = job.raw_scalars && typeof job.raw_scalars === "object" ? job.raw_scalars : {};
    const extraFields = job.extra_fields && typeof job.extra_fields === "object" ? job.extra_fields : {};

    const scalarFallback = {
      0: job.customer_name || "",
      1: job.job_name || "",
      2: job.project_code || "",
      3: job.date_confirmed || "",
      4: job.lead_source || "",
      30: job.uneven_split || "",
      32: job.revenue ?? "",
      33: job.direct_costs ?? "",
      34: job.vat_applicable || "",
      35: job.job_type || "",
      36: job.product_line || "",
      37: job.start_date || "",
      38: job.end_date || "",
      39: job.likelihood_pct ?? "",
      107: job.copied_to_confirmed || "",
    };
    if (job.is_job_costing) {
      scalarFallback[5] = job.jc_start_date || "";
      scalarFallback[6] = job.jc_end_date || "";
      scalarFallback[7] = job.jc_fixed_variable || "";
      scalarFallback[8] = job.jc_job_revenue ?? "";
      scalarFallback[9] = job.jc_likelihood_input ?? "";
      scalarFallback[10] = job.jc_contractor_costs ?? "";
      scalarFallback[16] = job.jc_external_costs ?? "";
      scalarFallback[17] = job.recharged_expenses ?? "";
      scalarFallback[19] = job.jc_prop_succ_fee_pct ?? "";
      scalarFallback[21] = job.jc_prop_succ_fee_rec || "";
      scalarFallback[27] = job.jc_inv_no || "";
    } else if (tabName === "Confirmed") {
      scalarFallback[17] = job.recharged_expenses ?? "";
    }

    const rowOffsets = new Set([0]);
    for (let off = 1; off <= (Number(job.sheet_child_row_count) || 0); off++) rowOffsets.add(off);
    const invList =
      invoicesByJobId && job.id && invoicesByJobId.has(job.id)
        ? invoicesByJobId.get(job.id)
        : Array.isArray(job.invoices)
          ? job.invoices
          : [];
    const expList =
      expensesByJobId && job.id && expensesByJobId.has(job.id)
        ? expensesByJobId.get(job.id)
        : Array.isArray(job.expenses)
          ? job.expenses
          : [];

    for (const off of rowOffsets) {
      const r0 = baseRow0 + off;
      const nonSlotCols = [];
      for (let c = 0; c <= 39; c++) nonSlotCols.push(c);
      nonSlotCols.push(107);

      for (const c of nonSlotCols) {
        const key = `${off}:${c}`;
        const fStr = Object.prototype.hasOwnProperty.call(customFormulas, key) ? customFormulas[key] : undefined;
        const fgOverride = Object.prototype.hasOwnProperty.call(customFormulas, `fg:${key}`) ? customFormulas[`fg:${key}`] : undefined;
        const noteStr = Object.prototype.hasOwnProperty.call(cellNotes, key) ? cellNotes[key] : "";
        let scalarVal = "";
        if (off === 0) {
          if (Object.prototype.hasOwnProperty.call(rawScalars, String(c))) {
            scalarVal = rawScalars[String(c)];
          } else if (
            Object.prototype.hasOwnProperty.call(scalarFallback, c) &&
            isNonEmptyCell_(scalarFallback[c]) &&
            !((c === 17 || c === 32 || c === 33) && Number(scalarFallback[c]) === 0)
          ) {
            scalarVal = scalarFallback[c];
          }
        } else if (Object.prototype.hasOwnProperty.call(extraFields, key)) {
          scalarVal = extraFields[key];
        }

        if (isNonEmptyCell_(scalarVal) || isFormulaStr_(fStr) || fgOverride !== undefined || noteStr) {
          writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c, scalarVal, fStr, fgOverride, noteStr);
        }
      }
    }

    for (const inv of invList) {
      const r0 = baseRow0 + (Number(inv.row_offset) || 0);
      const def = invDefs[Number(inv.slot_index) || 0];
      if (def) applySlotToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, def, inv);
    }

    for (const exp of expList) {
      const r0 = baseRow0 + (Number(exp.row_offset) || 0);
      const def = expDefs[Number(exp.slot_index) || 0];
      if (def) applySlotToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, def, exp);
    }
  }

  for (let r = 0; r < valuesGrid.length; r++) {
    valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
  }
  for (let r = 0; r < formulasGrid.length; r++) {
    formulasGrid[r] = trimTrailingEmptyGridCells_(formulasGrid[r]);
  }

  return { valuesGrid, formulasGrid, notesGrid };
}

function compareGridsStrict_(tabName, actualVals = [], actualForms = [], actualNotes = {}, projVals = [], projForms = [], projNotes = {}) {
  const diffs = [];
  const maxR = Math.max(actualVals.length, projVals.length);

  for (let r = 0; r < maxR; r++) {
    const aRow = Array.isArray(actualVals[r]) ? actualVals[r] : [];
    const pRow = Array.isArray(projVals[r]) ? projVals[r] : [];
    const afRow = Array.isArray(actualForms[r]) ? actualForms[r] : [];
    const pfRow = Array.isArray(projForms[r]) ? projForms[r] : [];
    const maxC = Math.max(aRow.length, pRow.length, afRow.length, pfRow.length);

    for (let c = 0; c < maxC; c++) {
      const av = aRow[c] !== undefined && aRow[c] !== null ? aRow[c] : "";
      const pv = pRow[c] !== undefined && pRow[c] !== null ? pRow[c] : "";
      const valuesMatch =
        av === pv ||
        (typeof av === "number" && typeof pv === "number" && Number.isNaN(av) && Number.isNaN(pv));

      if (!valuesMatch) {
        diffs.push({ tabName, kind: "value", rowNum: r + 1, colIdx0: c, expected: av, actual: pv });
        if (diffs.length >= 25) return diffs;
      }

      const afRaw = afRow[c];
      const pfRaw = pfRow[c];
      const af = isFormulaStr_(afRaw) ? afRaw : (afRaw !== undefined && afRaw !== null ? afRaw : "");
      const pf = isFormulaStr_(pfRaw) ? pfRaw : (pfRaw !== undefined && pfRaw !== null ? pfRaw : "");
      if (isFormulaStr_(af) || isFormulaStr_(pf)) {
        if (af !== pf) {
          diffs.push({ tabName, kind: "formula", rowNum: r + 1, colIdx0: c, expected: af, actual: pf });
          if (diffs.length >= 25) return diffs;
        }
      }
    }
  }

  const allNoteKeys = new Set([
    ...Object.keys(actualNotes || {}).filter((k) => !k.startsWith("__") && actualNotes[k]),
    ...Object.keys(projNotes || {}).filter((k) => !k.startsWith("__") && projNotes[k]),
  ]);
  for (const k of allNoteKeys) {
    const an = String(actualNotes?.[k] || "");
    const pn = String(projNotes?.[k] || "");
    if (an !== pn) {
      diffs.push({ tabName, kind: "note", cellKey: k, expected: an, actual: pn });
      if (diffs.length >= 25) return diffs;
    }
  }

  return diffs;
}

/**
 * Checks whether Phase 2 relational job tables (and `clients.jobs_mode`) are installed in Supabase.
 */
export async function checkPhase2RelationalSchemaStatus() {
  const migrationSql = readMigration0012Sql();
  if (!isSupabaseConfigured()) {
    return { configured: false, schemaReady: false, tables: [], migrationSql };
  }
  const supabase = getSupabaseAdmin();
  const [tableResults, clientsColProbe] = await Promise.all([
    Promise.all(
      PHASE2_JOB_TABLES.map(async (t) => {
        try {
          const probe = await supabase.from(t.name).select("id").limit(1);
          if (probe.error) return { ...t, exists: false, count: 0, error: probe.error.message };
          const { count, error } = await supabase.from(t.name).select("id", { count: "exact", head: true });
          if (error) return { ...t, exists: false, count: 0, error: error.message };
          return { ...t, exists: true, count: count ?? 0 };
        } catch (err) {
          return { ...t, exists: false, count: 0, error: err.message };
        }
      })
    ),
    supabase.from("clients").select("jobs_mode").limit(1).then((r) => !r.error).catch(() => false),
  ]);
  const schemaReady = Boolean(clientsColProbe) && tableResults.every((t) => t.exists);
  _verifiedPhase2SchemaReady = schemaReady;
  return { configured: true, schemaReady, tables: tableResults, migrationSql };
}

/**
 * Fetches Phase 2 fleet overview stats for `getStage2Status` without failing if migration 0012 isn't applied yet.
 */
export async function getPhase2RelationalOverviewStats(clientsData = []) {
  const migrationSql = readMigration0012Sql();
  if (!isSupabaseConfigured()) {
    return { schemaReady: false, migrationSql, totalJobs: 0, totalSeries: 0, totalInvoices: 0, totalExpenses: 0, backfilledClientsCount: 0, relationalModeClientsCount: 0 };
  }
  const supabase = getSupabaseAdmin();

  let schemaReady = false;
  let seriesCount = 0;
  let jobsCount = 0;
  let invoicesCount = 0;
  let expensesCount = 0;

  try {
    const [p0, p1, p2, p3, pCol] = await Promise.all([
      supabase.from("pulse_retainer_series").select("id").limit(1),
      supabase.from("pulse_jobs").select("id").limit(1),
      supabase.from("pulse_job_invoices").select("id").limit(1),
      supabase.from("pulse_job_expenses").select("id").limit(1),
      supabase.from("clients").select("jobs_mode").limit(1),
    ]);
    if (!p0.error && !p1.error && !p2.error && !p3.error && !pCol.error) {
      const [c0, c1, c2, c3] = await Promise.all([
        supabase.from("pulse_retainer_series").select("id", { count: "exact", head: true }),
        supabase.from("pulse_jobs").select("id", { count: "exact", head: true }),
        supabase.from("pulse_job_invoices").select("id", { count: "exact", head: true }),
        supabase.from("pulse_job_expenses").select("id", { count: "exact", head: true }),
      ]);
      schemaReady = true;
      _verifiedPhase2SchemaReady = true;
      seriesCount = c0.count || 0;
      jobsCount = c1.count || 0;
      invoicesCount = c2.count || 0;
      expensesCount = c3.count || 0;
    } else {
      schemaReady = false;
    }
  } catch {
    schemaReady = false;
  }

  let backfilledClientsCount = 0;
  let relationalModeClientsCount = 0;
  let relationalReadModeClientsCount = 0;
  for (const c of clientsData || []) {
    if (c?.metadata?.relational_jobs_state?.lastBackfilledAt) backfilledClientsCount++;
    if ((c?.jobs_mode || c?.metadata?.jobs_mode) === "relational") relationalModeClientsCount++;
    if (c?.metadata?.jobs_read_mode === "relational") relationalReadModeClientsCount++;
  }

  return {
    schemaReady,
    migrationSql,
    totalSeries: seriesCount,
    totalJobs: jobsCount,
    totalInvoices: invoicesCount,
    totalExpenses: expensesCount,
    backfilledClientsCount,
    relationalModeClientsCount,
    relationalReadModeClientsCount,
  };
}

function makeJobIdentityKey_(job) {
  if (job.project_code) return `pc:${normalizeTextKey_(job.project_code)}`;
  return `row:${job.sheet_row_num}|${normalizeTextKey_(job.customer_name)}|${normalizeTextKey_(job.job_name)}`;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _inFlightReconcileByClient = new Map();
const _pendingReconcileTabsByClient = new Map();
const _recentReconciledJobIdsByClient = new Map();

export function getRecentReconciledJobUuid(clientName, tabName, rowNum) {
  const key = String(clientName || "").trim().toLowerCase();
  const rNum = Number(rowNum);
  if (!key || !Number.isInteger(rNum) || rNum < 2) return null;
  const entry = _recentReconciledJobIdsByClient.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) _recentReconciledJobIdsByClient.delete(key);
    return null;
  }
  const tabType = String(tabName || "").trim().toLowerCase().startsWith("pipe") ? "pipeline" : "confirmed";
  return entry.map.get(`${tabType}:${rNum}`) || null;
}

function numbersEqualLoose_(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  if (b === null || b === undefined || b === "") return false;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return String(a) === String(b);
  return Math.abs(na - nb) < 0.0001;
}

function stableJson_(val) {
  if (val === null || val === undefined) return "null";
  if (Array.isArray(val)) return `[${val.map(stableJson_).join(",")}]`;
  if (typeof val === "object") {
    const keys = Object.keys(val).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson_(val[k])}`).join(",")}}`;
  }
  return JSON.stringify(val);
}

function hasRecordChanged_(existing, desired, numericCols = [], jsonCols = []) {
  if (!existing) return true;
  const numSet = new Set(numericCols);
  const jsonSet = new Set(jsonCols);
  for (const [k, v] of Object.entries(desired)) {
    if (k === "id" || k === "client_id") continue;
    const prev = existing[k];
    if (numSet.has(k)) {
      if (!numbersEqualLoose_(prev, v)) return true;
    } else if (jsonSet.has(k)) {
      if (stableJson_(prev ?? null) !== stableJson_(v ?? null)) return true;
    } else if (typeof v === "boolean") {
      if (Boolean(prev) !== v) return true;
    } else {
      if (String(prev ?? "") !== String(v ?? "")) return true;
    }
  }
  return false;
}

async function fetchAllRowsForClient_(supabase, tableName, clientId, { tabType = null, selectCols = "*" } = {}) {
  const out = [];
  const seenIds = new Set();
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from(tableName)
      .select(selectCols)
      .eq("client_id", clientId);
    if (tabType) q = q.eq("tab_type", tabType);
    const { data, error } = await q.order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${tableName} read failed: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const row of data) {
      if (row?.id) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
      }
      out.push(row);
    }
    if (data.length < 1000) break;
  }
  return out;
}

async function fetchChildRowsForJobIds_(supabase, tableName, clientId, jobIds, selectCols = "*") {
  if (!Array.isArray(jobIds) || jobIds.length === 0) return [];
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < jobIds.length; i += 200) {
    const chunk = jobIds.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from(tableName)
        .select(selectCols)
        .eq("client_id", clientId)
        .in("job_id", chunk)
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`${tableName} read failed: ${error.message}`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const row of data) {
        if (row?.id) {
          if (seenIds.has(row.id)) continue;
          seenIds.add(row.id);
        }
        out.push(row);
      }
      if (data.length < 1000) break;
    }
  }
  return out;
}

function findMatchingExistingJob_(sourceJob, existingPool, indexes, usedExistingJobIds) {
  const { byProjectCode, byExactRowIdentity, byName, byRowNum } = indexes;

  const pcK = normalizeTextKey_(sourceJob.project_code);
  if (pcK) {
    const candidates = byProjectCode.get(pcK) || [];
    const hit = candidates.find((ej) => !usedExistingJobIds.has(ej.id));
    if (hit) return hit;
  }

  const exactK = `${sourceJob.sheet_row_num}|${normalizeTextKey_(sourceJob.customer_name)}|${normalizeTextKey_(sourceJob.job_name)}`;
  const exactHit = (byExactRowIdentity.get(exactK) || []).find((ej) => !usedExistingJobIds.has(ej.id));
  if (exactHit) return exactHit;

  const nameK = `${normalizeTextKey_(sourceJob.customer_name)}|${normalizeTextKey_(sourceJob.job_name)}`;
  if (nameK !== "|") {
    const nameCandidates = (byName.get(nameK) || []).filter((ej) => !usedExistingJobIds.has(ej.id));
    if (nameCandidates.length > 0) {
      const ymMatch = sourceJob.retainer_period_ym
        ? nameCandidates.find((ej) => ej.retainer_period_ym === sourceJob.retainer_period_ym)
        : null;
      if (ymMatch) return ymMatch;

      const sdMatch = sourceJob.start_date
        ? nameCandidates.find((ej) => ej.start_date === sourceJob.start_date)
        : null;
      if (sdMatch) return sdMatch;

      nameCandidates.sort(
        (a, b) => Math.abs((a.sheet_row_num || 0) - sourceJob.sheet_row_num) - Math.abs((b.sheet_row_num || 0) - sourceJob.sheet_row_num)
      );
      return nameCandidates[0];
    }
  }

  const rowHit = byRowNum.get(sourceJob.sheet_row_num);
  if (rowHit && !usedExistingJobIds.has(rowHit.id)) {
    const sameCode =
      normalizeTextKey_(sourceJob.project_code) &&
      normalizeTextKey_(sourceJob.project_code) === normalizeTextKey_(rowHit.project_code);
    const sameJob =
      normalizeTextKey_(sourceJob.job_name) &&
      normalizeTextKey_(sourceJob.job_name) === normalizeTextKey_(rowHit.job_name);
    const sameCust =
      normalizeTextKey_(sourceJob.customer_name) &&
      normalizeTextKey_(sourceJob.customer_name) === normalizeTextKey_(rowHit.customer_name);
    if (sameCode || sameJob || sameCust) {
      return rowHit;
    }
  }

  return null;
}

async function fetchPaginatedTableForClient_(supabase, tableName, selectCols, clientId, extraFilters = null) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from(tableName)
      .select(selectCols)
      .eq("client_id", clientId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (typeof extraFilters === "function") q = extraFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`Failed loading ${tableName}: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function syncPulseNotesJobIdsForClient_(supabase, clientId) {
  const [notes, jobs] = await Promise.all([
    fetchPaginatedTableForClient_(
      supabase,
      "pulse_notes",
      "id, entity_type, entity_key, parent_entity_key, job_id",
      clientId,
      (q) => q.is("deleted_at", null).in("entity_type", ["job", "invoice", "job_expense"])
    ),
    fetchPaginatedTableForClient_(
      supabase,
      "pulse_jobs",
      "id, tab_type, sheet_row_num, customer_name, job_name, project_code",
      clientId
    ),
  ]);
  if (!Array.isArray(notes) || notes.length === 0 || !Array.isArray(jobs) || jobs.length === 0) return;

  const liveJobById = new Map(jobs.map((j) => [j.id, j]));
  const jobsByKey = new Map();
  const addKey = (k, j) => {
    if (!k) return;
    if (!jobsByKey.has(k)) jobsByKey.set(k, []);
    jobsByKey.get(k).push(j);
  };

  // Sort so confirmed comes first when picking canonical link, preserving sheet order
  const orderedJobs = [...jobs].sort((a, b) => {
    if (a.tab_type === b.tab_type) return (a.sheet_row_num || 0) - (b.sheet_row_num || 0);
    return a.tab_type === "confirmed" ? -1 : 1;
  });
  for (const j of orderedJobs) {
    const key = buildJobNoteKey({
      client: j.customer_name,
      jobName: j.job_name,
      projectCode: j.project_code,
      rowNumber: j.sheet_row_num,
    });
    addKey(key, j);
    if (!j.project_code && j.customer_name && j.job_name) {
      const altKey = buildJobNoteKey({ client: j.customer_name, jobName: j.job_name });
      addKey(altKey, j);
    }
  }

  const updates = [];
  for (const n of notes) {
    const lookupKey = n.entity_type === "job" ? n.entity_key : n.parent_entity_key;
    if (!lookupKey) continue;
    const candidates = jobsByKey.get(lookupKey) || [];
    if (candidates.length === 0) continue;

    const existingLive = n.job_id ? liveJobById.get(n.job_id) : null;
    // Never overwrite an already-valid live confirmed job_id due to variable-retainer M1..M11 -> M12 key collisions
    if (
      existingLive &&
      existingLive.tab_type === "confirmed" &&
      candidates.length > 1 &&
      candidates.some((c) => c.id === existingLive.id)
    ) {
      continue;
    }

    const matchedJobId = candidates[0]?.id || null;
    if (matchedJobId && n.job_id !== matchedJobId) {
      updates.push(supabase.from("pulse_notes").update({ job_id: matchedJobId }).eq("id", n.id));
    }
  }
  if (updates.length > 0) {
    await Promise.all(updates.map((p) => Promise.resolve(p).catch(() => { })));
  }
}

function extractSparseHeaderMap_(headerRow = []) {
  if (!Array.isArray(headerRow) || headerRow.length === 0) return {};
  const map = {};
  for (let c = 0; c < headerRow.length; c++) {
    const val = headerRow[c];
    if (val === undefined || val === null || val === "") continue;
    const isRelevant =
      c <= 61 ||
      (c >= 74 && c <= 95) ||
      (c >= 106 && c <= 107) ||
      (c >= 144 && c <= 160) ||
      (c >= 253 && c <= 262);
    if (isRelevant) {
      map[String(c)] = String(val);
    }
  }
  return map;
}

async function runSingleReconcilePass_(ctx, targetTabs, options = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return null;

  const isBothTabs = targetTabs.includes("Confirmed") && targetTabs.includes("Pipeline");
  const singleTabType = !isBothTabs ? (targetTabs[0] === "Pipeline" ? "pipeline" : "confirmed") : null;
  const forceFullUpsert = Boolean(options.forceFullUpsert);

  const preloaded = options.preloadedGrids || {};
  const gridPromises = targetTabs.map((tabName) =>
    preloaded[tabName]
      ? Promise.resolve({
        values_grid: preloaded[tabName].values || preloaded[tabName].values_grid || [],
        formulas_grid: preloaded[tabName].formulas || preloaded[tabName].formulas_grid || [],
        notes_grid: preloaded[tabName].notes || preloaded[tabName].notes_grid || {},
      })
      : getOrLoadVirtualTabGrid_(ctx, "client", tabName, null, { includeNotes: true })
  );
  const calcsGridPromises = targetTabs.map((tabName) => {
    const calcsTab = tabName === "Pipeline" ? "PipeCalcs" : "ConfCalcs";
    return preloaded[calcsTab]
      ? Promise.resolve({
        values_grid: preloaded[calcsTab].values || preloaded[calcsTab].values_grid || [],
        notes_grid: preloaded[calcsTab].notes || preloaded[calcsTab].notes_grid || {},
      })
      : getOrLoadVirtualTabGrid_(ctx, "client", calcsTab, null, { valuesOnly: true }).catch(() => null);
  });

  const [gridsList, calcsGridsList, existingSeries, existingJobs, clMetaResp] = await Promise.all([
    Promise.all(gridPromises),
    Promise.all(calcsGridPromises),
    fetchAllRowsForClient_(supabase, "pulse_retainer_series", ctx.clientId, { tabType: singleTabType }),
    fetchAllRowsForClient_(supabase, "pulse_jobs", ctx.clientId, { tabType: singleTabType }),
    supabase.from("clients").select("metadata").eq("id", ctx.clientId).maybeSingle(),
  ]);

  const existingJobIds = existingJobs.map((j) => j.id);
  const [existingInvs, existingExps] = await Promise.all([
    isBothTabs
      ? fetchAllRowsForClient_(supabase, "pulse_job_invoices", ctx.clientId)
      : fetchChildRowsForJobIds_(supabase, "pulse_job_invoices", ctx.clientId, existingJobIds),
    isBothTabs
      ? fetchAllRowsForClient_(supabase, "pulse_job_expenses", ctx.clientId)
      : fetchChildRowsForJobIds_(supabase, "pulse_job_expenses", ctx.clientId, existingJobIds),
  ]);

  const models = targetTabs.map((tabName, idx) =>
    parseTabGridToRelationalModel({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      tabName,
      valuesGrid: gridsList[idx]?.values_grid || [],
      formulasGrid: gridsList[idx]?.formulas_grid || [],
      notesGrid: gridsList[idx]?.notes_grid || {},
      calcsValuesGrid: calcsGridsList[idx]?.values_grid || null,
      calcsNotesGrid: calcsGridsList[idx]?.notes_grid || null,
    })
  );

  // Determine whether accounting FK lookup is actually needed
  const neededInvRefs = new Set();
  const neededExpAppIds = new Set();
  const existingInvById = new Map(existingInvs.map((r) => [r.id, r]));
  const existingExpById = new Map(existingExps.map((r) => [r.id, r]));
  const accInvFkByRef = new Map();
  const accCostFkByExtId = new Map();

  for (const mod of models) {
    for (const j of mod.jobs) {
      for (const inv of j.invoices) {
        const rk = normalizeTextKey_(inv.invoice_ref);
        if (rk && !inv.is_placeholder) neededInvRefs.add(rk);
      }
      for (const exp of j.expenses) {
        const ek = normalizeTextKey_(exp.external_app_id);
        if (ek && !exp.is_placeholder) neededExpAppIds.add(ek);
      }
    }
  }

  for (const r of existingInvs) {
    const rk = normalizeTextKey_(r.invoice_ref);
    if (rk && r.accounting_invoice_id) accInvFkByRef.set(rk, r.accounting_invoice_id);
  }
  for (const r of existingExps) {
    const ek = normalizeTextKey_(r.external_app_id);
    if (ek && r.accounting_direct_cost_id) accCostFkByExtId.set(ek, r.accounting_direct_cost_id);
  }

  const missingInvLookup = forceFullUpsert || [...neededInvRefs].some((rk) => !accInvFkByRef.has(rk));
  const missingExpLookup = forceFullUpsert || [...neededExpAppIds].some((ek) => !accCostFkByExtId.has(ek));
  if (missingInvLookup || missingExpLookup) {
    const [accInvsRows, accDirectRows] = await Promise.all([
      missingInvLookup && neededInvRefs.size > 0
        ? fetchPaginatedTableForClient_(
          supabase,
          "accounting_invoices",
          "id, invoice_number",
          ctx.clientId,
          (q) => q.eq("record_kind", "invoice")
        )
        : Promise.resolve([]),
      missingExpLookup && neededExpAppIds.size > 0
        ? fetchPaginatedTableForClient_(supabase, "accounting_direct_costs", "id, external_id", ctx.clientId)
        : Promise.resolve([]),
    ]);
    for (const r of accInvsRows || []) {
      const refK = normalizeTextKey_(r.invoice_number);
      if (refK) accInvFkByRef.set(refK, r.id);
    }
    for (const r of accDirectRows || []) {
      const extK = normalizeTextKey_(r.external_id);
      if (extK) accCostFkByExtId.set(extK, r.id);
    }
  }

  // 1. Reconcile Retainer Series
  const existingSeriesMap = new Map(existingSeries.map((s) => [`${s.tab_type}::${s.series_key}`, s]));
  const desiredSeriesKeys = new Set();
  const seriesIdByTabAndKey = new Map();
  const seriesToUpsert = [];
  let totalSeriesDesired = 0;

  for (const mod of models) {
    for (const s of mod.retainerSeries) {
      totalSeriesDesired++;
      const k = `${s.tab_type}::${s.series_key}`;
      desiredSeriesKeys.add(k);
      const prev = existingSeriesMap.get(k);
      if (prev) seriesIdByTabAndKey.set(k, prev.id);
      const payload = {
        ...(prev?.id ? { id: prev.id } : {}),
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        tab_type: s.tab_type,
        series_type: s.series_type,
        series_key: s.series_key,
        customer_name: s.customer_name,
        series_name: s.series_name,
        project_code: s.project_code,
        lead_source: s.lead_source,
        product_line: s.product_line,
        vat_applicable: s.vat_applicable,
        base_revenue: s.base_revenue,
        base_direct_costs: s.base_direct_costs,
        billing_interval_months: s.billing_interval_months,
        invoice_send_day: s.invoice_send_day,
        start_date: s.start_date,
        end_date: s.end_date,
        no_end_date: s.no_end_date,
        metadata: s.metadata,
      };
      if (
        forceFullUpsert ||
        !prev ||
        hasRecordChanged_(prev, payload, ["base_revenue", "base_direct_costs", "billing_interval_months", "invoice_send_day"], ["metadata"])
      ) {
        seriesToUpsert.push(payload);
      }
    }
  }

  if (seriesToUpsert.length > 0) {
    const { data: upsertedSeries, error: serErr } = await supabase
      .from("pulse_retainer_series")
      .upsert(seriesToUpsert, { onConflict: "client_id,tab_type,series_key" })
      .select("id, tab_type, series_key");
    if (serErr) throw new Error(`Failed upserting pulse_retainer_series: ${serErr.message}`);
    for (const r of upsertedSeries || []) {
      seriesIdByTabAndKey.set(`${r.tab_type}::${r.series_key}`, r.id);
    }
  }

  const obsoleteSeriesIds = existingSeries
    .filter((s) => !desiredSeriesKeys.has(`${s.tab_type}::${s.series_key}`))
    .map((s) => s.id);
  for (let i = 0; i < obsoleteSeriesIds.length; i += 200) {
    const { error: delSerErr } = await supabase
      .from("pulse_retainer_series")
      .delete()
      .in("id", obsoleteSeriesIds.slice(i, i + 200));
    if (delSerErr) throw new Error(`Failed deleting pulse_retainer_series: ${delSerErr.message}`);
  }

  // 2. Reconcile Jobs (multi-tier UUID preservation)
  const existingJobsByTab = {
    confirmed: existingJobs.filter((j) => j.tab_type === "confirmed"),
    pipeline: existingJobs.filter((j) => j.tab_type === "pipeline"),
  };
  const usedExistingJobIds = new Set();
  const updateJobPayloads = [];
  const insertJobPayloads = [];
  const plannedJobsMeta = [];
  const jobIdByTabAndRow = new Map();

  let didJobIdentityOrRowChange = false;
  for (const mod of models) {
    const pool = existingJobsByTab[mod.tabType] || [];
    const byProjectCode = new Map();
    const byExactRowIdentity = new Map();
    const byName = new Map();
    const byRowNum = new Map();
    for (const ej of pool) {
      const pcK = normalizeTextKey_(ej.project_code);
      if (pcK) {
        if (!byProjectCode.has(pcK)) byProjectCode.set(pcK, []);
        byProjectCode.get(pcK).push(ej);
      }
      const exactK = `${ej.sheet_row_num}|${normalizeTextKey_(ej.customer_name)}|${normalizeTextKey_(ej.job_name)}`;
      if (!byExactRowIdentity.has(exactK)) byExactRowIdentity.set(exactK, []);
      byExactRowIdentity.get(exactK).push(ej);

      const nameK = `${normalizeTextKey_(ej.customer_name)}|${normalizeTextKey_(ej.job_name)}`;
      if (!byName.has(nameK)) byName.set(nameK, []);
      byName.get(nameK).push(ej);

      if (!byRowNum.has(ej.sheet_row_num)) byRowNum.set(ej.sheet_row_num, ej);
    }

    const indexes = { byProjectCode, byExactRowIdentity, byName, byRowNum };

    for (const j of mod.jobs) {
      const matched = findMatchingExistingJob_(j, pool, indexes, usedExistingJobIds);
      if (matched) usedExistingJobIds.add(matched.id);

      const resolvedSeriesId = j.series_key
        ? seriesIdByTabAndKey.get(`${mod.tabType}::${j.series_key}`) || null
        : null;

      const rowPayload = {
        ...(matched?.id ? { id: matched.id } : {}),
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        tab_type: j.tab_type,
        retainer_series_id: resolvedSeriesId,
        retainer_period_ym: j.retainer_period_ym,
        sort_order: j.sort_order,
        sheet_row_num: j.sheet_row_num,
        sheet_child_row_count: j.sheet_child_row_count,
        customer_name: j.customer_name,
        job_name: j.job_name,
        project_code: j.project_code,
        lead_owner: j.lead_owner,
        date_confirmed: j.date_confirmed,
        lead_source: j.lead_source,
        uneven_split: j.uneven_split,
        revenue: j.revenue,
        direct_costs: j.direct_costs,
        recharged_expenses: j.recharged_expenses,
        vat_applicable: j.vat_applicable,
        job_type: j.job_type,
        product_line: j.product_line,
        start_date: j.start_date,
        end_date: j.end_date,
        no_end_date: j.no_end_date,
        likelihood_pct: j.likelihood_pct,
        copied_to_confirmed: j.copied_to_confirmed,
        is_job_costing: j.is_job_costing,
        jc_start_date: j.jc_start_date,
        jc_end_date: j.jc_end_date,
        jc_fixed_variable: j.jc_fixed_variable,
        jc_job_revenue: j.jc_job_revenue,
        jc_likelihood_input: j.jc_likelihood_input,
        jc_contractor_costs: j.jc_contractor_costs,
        jc_external_costs: j.jc_external_costs,
        jc_prop_succ_fee_pct: j.jc_prop_succ_fee_pct,
        jc_prop_succ_fee_rec: j.jc_prop_succ_fee_rec,
        jc_inv_no: j.jc_inv_no,
        raw_scalars: j.raw_scalars,
        custom_formulas: j.custom_formulas,
        extra_fields: j.extra_fields,
        cell_notes: j.cell_notes,
      };

      if (matched?.id) {
        jobIdByTabAndRow.set(`${j.tab_type}:${j.sheet_row_num}`, matched.id);
        if (
          forceFullUpsert ||
          hasRecordChanged_(
            matched,
            rowPayload,
            [
              "sort_order",
              "sheet_row_num",
              "sheet_child_row_count",
              "revenue",
              "direct_costs",
              "recharged_expenses",
              "likelihood_pct",
              "jc_job_revenue",
              "jc_likelihood_input",
              "jc_contractor_costs",
              "jc_external_costs",
              "jc_prop_succ_fee_pct",
            ],
            ["raw_scalars", "custom_formulas", "extra_fields", "cell_notes"]
          )
        ) {
          if (
            Number(matched.sheet_row_num) !== Number(rowPayload.sheet_row_num) ||
            String(matched.customer_name || "") !== String(rowPayload.customer_name || "") ||
            String(matched.job_name || "") !== String(rowPayload.job_name || "") ||
            String(matched.project_code || "") !== String(rowPayload.project_code || "")
          ) {
            didJobIdentityOrRowChange = true;
          }
          updateJobPayloads.push(rowPayload);
        }
      } else {
        didJobIdentityOrRowChange = true;
        insertJobPayloads.push(rowPayload);
      }
      plannedJobsMeta.push({ sourceJob: j, matchedId: matched?.id || null });
    }
  }

  for (let i = 0; i < updateJobPayloads.length; i += 200) {
    const { error: upErr } = await supabase
      .from("pulse_jobs")
      .upsert(updateJobPayloads.slice(i, i + 200), { onConflict: "id" });
    if (upErr) throw new Error(`Failed updating pulse_jobs: ${upErr.message}`);
  }

  const insertedJobsList = [];
  for (let i = 0; i < insertJobPayloads.length; i += 200) {
    const { data: insData, error: insErr } = await supabase
      .from("pulse_jobs")
      .insert(insertJobPayloads.slice(i, i + 200))
      .select("id, tab_type, sheet_row_num, project_code, customer_name, job_name");
    if (insErr) throw new Error(`Failed inserting pulse_jobs: ${insErr.message}`);
    for (const r of insData || []) {
      jobIdByTabAndRow.set(`${r.tab_type}:${r.sheet_row_num}`, r.id);
      insertedJobsList.push(r);
    }
  }

  const obsoleteJobIds = existingJobs.filter((ej) => !usedExistingJobIds.has(ej.id)).map((ej) => ej.id);
  if (obsoleteJobIds.length > 0) didJobIdentityOrRowChange = true;

  // Re-point pulse_notes.job_id before obsolete Pipeline jobs are deleted on same-pass Pipeline -> Confirmed promotion
  if (obsoleteJobIds.length > 0 && insertedJobsList.length > 0) {
    const confirmedInserted = insertedJobsList.filter((r) => r.tab_type === "confirmed");
    if (confirmedInserted.length > 0) {
      const obsoleteSet = new Set(obsoleteJobIds);
      const obsoletePipelineJobs = existingJobs.filter(
        (ej) => obsoleteSet.has(ej.id) && ej.tab_type === "pipeline"
      );
      if (obsoletePipelineJobs.length > 0) {
        const promoRemap = [];
        for (const oldPipe of obsoletePipelineJobs) {
          const pcK = normalizeTextKey_(oldPipe.project_code);
          const nmK = `${normalizeTextKey_(oldPipe.customer_name)}|${normalizeTextKey_(oldPipe.job_name)}`;
          const newConf =
            (pcK && confirmedInserted.find((c) => normalizeTextKey_(c.project_code) === pcK)) ||
            (nmK !== "|" &&
              confirmedInserted.find(
                (c) => `${normalizeTextKey_(c.customer_name)}|${normalizeTextKey_(c.job_name)}` === nmK
              ));
          if (newConf?.id && newConf.id !== oldPipe.id) {
            promoRemap.push({ oldId: oldPipe.id, newId: newConf.id });
          }
        }
        await Promise.all(
          promoRemap.map(({ oldId, newId }) =>
            supabase
              .from("pulse_notes")
              .update({ job_id: newId })
              .eq("client_id", ctx.clientId)
              .eq("job_id", oldId)
          )
        ).catch(() => { });
      }
    }
  }

  for (let i = 0; i < obsoleteJobIds.length; i += 200) {
    const { error: delJobErr } = await supabase
      .from("pulse_jobs")
      .delete()
      .in("id", obsoleteJobIds.slice(i, i + 200));
    if (delJobErr) throw new Error(`Failed deleting obsolete pulse_jobs: ${delJobErr.message}`);
  }

  // 3. Reconcile Invoices & Expenses for affected tabs (preserving UUIDs by real ref/appId first, then slot)
  const existingInvsByJobId = new Map();
  for (const inv of existingInvs) {
    if (!existingInvsByJobId.has(inv.job_id)) existingInvsByJobId.set(inv.job_id, []);
    existingInvsByJobId.get(inv.job_id).push(inv);
  }
  const existingExpsByJobId = new Map();
  for (const exp of existingExps) {
    if (!existingExpsByJobId.has(exp.job_id)) existingExpsByJobId.set(exp.job_id, []);
    existingExpsByJobId.get(exp.job_id).push(exp);
  }

  const usedInvIds = new Set();
  const invUpserts = [];
  const invInserts = [];
  const usedExpIds = new Set();
  const expUpserts = [];
  const expInserts = [];
  let totalInvsDesired = 0;
  let totalExpsDesired = 0;

  for (const { sourceJob } of plannedJobsMeta) {
    const jobId = jobIdByTabAndRow.get(`${sourceJob.tab_type}:${sourceJob.sheet_row_num}`);
    if (!jobId) continue;

    const jobExistingInvs = existingInvsByJobId.get(jobId) || [];
    for (const inv of sourceJob.invoices) {
      totalInvsDesired++;
      const refK = normalizeTextKey_(inv.invoice_ref);
      let existingRec = null;
      if (refK && !inv.is_placeholder) {
        existingRec =
          jobExistingInvs.find(
            (e) => !usedInvIds.has(e.id) && normalizeTextKey_(e.invoice_ref) === refK
          ) || null;
      }
      if (!existingRec) {
        existingRec =
          jobExistingInvs.find(
            (e) =>
              !usedInvIds.has(e.id) &&
              e.row_offset === inv.row_offset &&
              e.slot_index === inv.slot_index
          ) || null;
      }
      if (existingRec) usedInvIds.add(existingRec.id);

      const rec = {
        ...(existingRec ? { id: existingRec.id } : {}),
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        job_id: jobId,
        accounting_invoice_id: refK ? accInvFkByRef.get(refK) || null : null,
        slot_order: inv.slot_order,
        row_offset: inv.row_offset,
        slot_index: inv.slot_index,
        amount: inv.amount,
        invoice_ref: inv.invoice_ref,
        send_date: inv.send_date,
        days_to_pay: inv.days_to_pay,
        status: inv.status,
        of_which_recharged: inv.of_which_recharged,
        cost_month: inv.cost_month,
        description: inv.description,
        is_placeholder: inv.is_placeholder,
        raw_cells: inv.raw_cells,
        custom_formulas: inv.custom_formulas,
        cell_notes: inv.cell_notes,
      };
      if (existingRec) {
        if (
          forceFullUpsert ||
          hasRecordChanged_(
            existingRec,
            rec,
            ["slot_order", "row_offset", "slot_index", "amount", "days_to_pay", "of_which_recharged"],
            ["raw_cells", "custom_formulas", "cell_notes"]
          )
        ) {
          invUpserts.push(rec);
        }
      } else {
        invInserts.push(rec);
      }
    }

    const jobExistingExps = existingExpsByJobId.get(jobId) || [];
    for (const exp of sourceJob.expenses) {
      totalExpsDesired++;
      const extK = normalizeTextKey_(exp.external_app_id);
      let existingRec = null;
      if (extK && !exp.is_placeholder) {
        existingRec =
          jobExistingExps.find(
            (e) => !usedExpIds.has(e.id) && normalizeTextKey_(e.external_app_id) === extK
          ) || null;
      }
      if (!existingRec) {
        existingRec =
          jobExistingExps.find(
            (e) =>
              !usedExpIds.has(e.id) &&
              e.row_offset === exp.row_offset &&
              e.slot_index === exp.slot_index
          ) || null;
      }
      if (existingRec) usedExpIds.add(existingRec.id);

      const rec = {
        ...(existingRec ? { id: existingRec.id } : {}),
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        job_id: jobId,
        accounting_direct_cost_id: extK ? accCostFkByExtId.get(extK) || null : null,
        slot_order: exp.slot_order,
        row_offset: exp.row_offset,
        slot_index: exp.slot_index,
        description: exp.description,
        amount: exp.amount,
        vat_applicable: exp.vat_applicable,
        received_date: exp.received_date,
        days_to_pay: exp.days_to_pay,
        status: exp.status,
        external_app_id: exp.external_app_id,
        is_placeholder: exp.is_placeholder,
        raw_cells: exp.raw_cells,
        custom_formulas: exp.custom_formulas,
        cell_notes: exp.cell_notes,
      };
      if (existingRec) {
        if (
          forceFullUpsert ||
          hasRecordChanged_(
            existingRec,
            rec,
            ["slot_order", "row_offset", "slot_index", "amount", "days_to_pay"],
            ["raw_cells", "custom_formulas", "cell_notes"]
          )
        ) {
          expUpserts.push(rec);
        }
      } else {
        expInserts.push(rec);
      }
    }
  }

  const obsoleteInvIds = existingInvs.filter((r) => !usedInvIds.has(r.id)).map((r) => r.id);
  for (let i = 0; i < obsoleteInvIds.length; i += 200) {
    const { error: delInvErr } = await supabase
      .from("pulse_job_invoices")
      .delete()
      .in("id", obsoleteInvIds.slice(i, i + 200));
    if (delInvErr) throw new Error(`Failed deleting obsolete pulse_job_invoices: ${delInvErr.message}`);
  }
  for (let i = 0; i < invUpserts.length; i += 200) {
    const { error: e } = await supabase.from("pulse_job_invoices").upsert(invUpserts.slice(i, i + 200), { onConflict: "id" });
    if (e) throw new Error(`Failed updating pulse_job_invoices: ${e.message}`);
  }
  for (let i = 0; i < invInserts.length; i += 200) {
    const { error: e } = await supabase.from("pulse_job_invoices").insert(invInserts.slice(i, i + 200));
    if (e) throw new Error(`Failed inserting pulse_job_invoices: ${e.message}`);
  }

  const obsoleteExpIds = existingExps.filter((r) => !usedExpIds.has(r.id)).map((r) => r.id);
  for (let i = 0; i < obsoleteExpIds.length; i += 200) {
    const { error: delExpErr } = await supabase
      .from("pulse_job_expenses")
      .delete()
      .in("id", obsoleteExpIds.slice(i, i + 200));
    if (delExpErr) throw new Error(`Failed deleting obsolete pulse_job_expenses: ${delExpErr.message}`);
  }
  for (let i = 0; i < expUpserts.length; i += 200) {
    const { error: e } = await supabase.from("pulse_job_expenses").upsert(expUpserts.slice(i, i + 200), { onConflict: "id" });
    if (e) throw new Error(`Failed updating pulse_job_expenses: ${e.message}`);
  }
  for (let i = 0; i < expInserts.length; i += 200) {
    const { error: e } = await supabase.from("pulse_job_expenses").insert(expInserts.slice(i, i + 200));
    if (e) throw new Error(`Failed inserting pulse_job_expenses: ${e.message}`);
  }

  // Record reconciled UUIDs in short-lived memory cache for immediate post-save lookups
  const clientRecKey = String(ctx.clientName || "").trim().toLowerCase();
  if (clientRecKey) {
    const mergedUuidMap = new Map();
    const prevEntry = _recentReconciledJobIdsByClient.get(clientRecKey);
    if (prevEntry && prevEntry.expiresAt > Date.now() && !isBothTabs) {
      for (const [mk, mv] of prevEntry.map.entries()) {
        if (singleTabType && !mk.startsWith(`${singleTabType}:`)) {
          mergedUuidMap.set(mk, mv);
        }
      }
    }
    for (const [mk, mv] of jobIdByTabAndRow.entries()) {
      mergedUuidMap.set(mk, mv);
    }
    _recentReconciledJobIdsByClient.set(clientRecKey, {
      expiresAt: Date.now() + 30000,
      map: mergedUuidMap,
    });
  }

  // Keep pulse_notes.job_id synchronized with live pulse_jobs UUIDs when job identities or row numbers changed
  if (didJobIdentityOrRowChange || forceFullUpsert) {
    await syncPulseNotesJobIdsForClient_(supabase, ctx.clientId).catch(() => { });
  }

  const prevMeta =
    !clMetaResp?.error && clMetaResp?.data?.metadata && typeof clMetaResp.data.metadata === "object"
      ? clMetaResp.data.metadata
      : {};
  const prevState = prevMeta.relational_jobs_state && typeof prevMeta.relational_jobs_state === "object" ? prevMeta.relational_jobs_state : {};
  const prevHeaders = prevState.tabHeaders && typeof prevState.tabHeaders === "object" ? prevState.tabHeaders : {};
  const nextHeaders = { ...prevHeaders };
  targetTabs.forEach((tabName, idx) => {
    nextHeaders[tabName] = extractSparseHeaderMap_(gridsList[idx]?.values_grid?.[0] || []);
    const calcsTab = tabName === "Pipeline" ? "PipeCalcs" : "ConfCalcs";
    const hasCalcs = Boolean(calcsGridsList[idx]?.values_grid?.length);
    nextHeaders[`has${calcsTab}`] = hasCalcs;
    if (hasCalcs) {
      nextHeaders[calcsTab] = extractSparseHeaderMap_(calcsGridsList[idx].values_grid[0] || []);
    }
  });
  const confMod = models.find((m) => m.tabName === "Confirmed");
  const pipeMod = models.find((m) => m.tabName === "Pipeline");
  const nowIso = new Date().toISOString();

  const summary = {
    clientName: ctx.clientName,
    lastBackfilledAt: options.updateBackfillTimestamp ? nowIso : prevState.lastBackfilledAt || nowIso,
    lastReconciledAt: nowIso,
    confirmedJobsCount: confMod ? confMod.jobs.length : Number(prevState.confirmedJobsCount || 0),
    pipelineJobsCount: pipeMod ? pipeMod.jobs.length : Number(prevState.pipelineJobsCount || 0),
    retainerSeriesCount: isBothTabs ? totalSeriesDesired : Number(prevState.retainerSeriesCount || totalSeriesDesired),
    invoicesCount: isBothTabs ? totalInvsDesired : Number(prevState.invoicesCount || totalInvsDesired),
    expensesCount: isBothTabs ? totalExpsDesired : Number(prevState.expensesCount || totalExpsDesired),
    tabHeaders: nextHeaders,
    deltaStats: {
      jobsUpdated: updateJobPayloads.length,
      jobsInserted: insertJobPayloads.length,
      jobsDeleted: obsoleteJobIds.length,
      invoicesMutated: invUpserts.length + invInserts.length + obsoleteInvIds.length,
      expensesMutated: expUpserts.length + expInserts.length + obsoleteExpIds.length,
    },
  };

  if (!clMetaResp?.error && clMetaResp?.data) {
    const metaUpdatePromise = supabase
      .from("clients")
      .update({
        metadata: {
          ...prevMeta,
          relational_jobs_state: summary,
        },
      })
      .eq("id", ctx.clientId)
      .then(() => { })
      .catch(() => { });
    if (options.updateBackfillTimestamp) {
      await metaUpdatePromise;
    } else {
      try {
        waitUntil(metaUpdatePromise);
      } catch { }
    }
  }

  return summary;
}

/**
 * Serialized, incremental two-way reconciliation from `Confirmed` and/or `Pipeline` grids
 * into `pulse_retainer_series`, `pulse_jobs`, `pulse_job_invoices`, `pulse_job_expenses`,
 * and `pulse_notes.job_id`, applying delta-only DB writes and preserving UUIDs.
 */
export async function reconcileClientRelationalJobsFromGrids(
  ctxOrClientName,
  tabNames = ["Confirmed", "Pipeline"],
  options = {}
) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const targetTabs = [...new Set((Array.isArray(tabNames) ? tabNames : []).filter((t) => t === "Confirmed" || t === "Pipeline"))];
  if (targetTabs.length === 0) return null;

  const key = String(ctx.clientName || ctx.clientId).trim().toLowerCase();
  const pendingEntry = _pendingReconcileTabsByClient.get(key) || { tabs: new Set(), opts: {} };
  for (const t of targetTabs) pendingEntry.tabs.add(t);
  const prevOpts = pendingEntry.opts || {};
  const mergedPreloaded =
    prevOpts.preloadedGrids || options?.preloadedGrids
      ? { ...(prevOpts.preloadedGrids || {}), ...(options?.preloadedGrids || {}) }
      : undefined;
  pendingEntry.opts = {
    ...prevOpts,
    ...options,
    forceFullUpsert: Boolean(prevOpts.forceFullUpsert || options?.forceFullUpsert),
    updateBackfillTimestamp: Boolean(prevOpts.updateBackfillTimestamp || options?.updateBackfillTimestamp),
    ...(mergedPreloaded ? { preloadedGrids: mergedPreloaded } : {}),
  };
  _pendingReconcileTabsByClient.set(key, pendingEntry);

  if (_inFlightReconcileByClient.has(key)) {
    return _inFlightReconcileByClient.get(key);
  }

  const runner = (async () => {
    let lastSummary = null;
    while (_pendingReconcileTabsByClient.has(key)) {
      const next = _pendingReconcileTabsByClient.get(key);
      _pendingReconcileTabsByClient.delete(key);
      const tabsToRun = [...next.tabs];
      if (tabsToRun.length === 0) break;
      lastSummary = await runSingleReconcilePass_(ctx, tabsToRun, next.opts);
    }
    return lastSummary;
  })();

  _inFlightReconcileByClient.set(key, runner);
  try {
    return await runner;
  } finally {
    if (_inFlightReconcileByClient.get(key) === runner) {
      _inFlightReconcileByClient.delete(key);
    }
  }
}

/**
 * Fast relational identity lookup map for hydrating PMA & Portal job payloads with canonical UUIDs.
 */
export async function getClientRelationalJobsLookup(ctxOrClientName) {
  if (!isSupabaseConfigured()) return null;
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const [jobs, invoices, expenses, series] = await Promise.all([
    fetchAllRowsForClient_(supabase, "pulse_jobs", ctx.clientId, {
      selectCols: "id, tab_type, sheet_row_num, sheet_child_row_count, retainer_series_id, retainer_period_ym, customer_name, job_name, project_code",
    }),
    fetchAllRowsForClient_(supabase, "pulse_job_invoices", ctx.clientId, {
      selectCols: "id, job_id, row_offset, slot_index, slot_order, accounting_invoice_id",
    }),
    fetchAllRowsForClient_(supabase, "pulse_job_expenses", ctx.clientId, {
      selectCols: "id, job_id, row_offset, slot_index, slot_order, accounting_direct_cost_id",
    }),
    fetchAllRowsForClient_(supabase, "pulse_retainer_series", ctx.clientId, {
      selectCols: "id, tab_type, series_type, series_key, series_name",
    }),
  ]);

  const jobsByTabAndRow = new Map();
  const jobsByUuid = new Map();
  for (const j of jobs) {
    jobsByTabAndRow.set(`${j.tab_type}:${j.sheet_row_num}`, j);
    jobsByUuid.set(j.id, j);
  }

  const invoicesByJobRowSlot = new Map();
  for (const inv of invoices) {
    invoicesByJobRowSlot.set(`${inv.job_id}:${inv.row_offset}:${inv.slot_index}`, inv);
  }

  const expensesByJobRowSlot = new Map();
  for (const exp of expenses) {
    expensesByJobRowSlot.set(`${exp.job_id}:${exp.row_offset}:${exp.slot_index}`, exp);
  }

  const seriesById = new Map();
  for (const s of series) seriesById.set(s.id, s);

  return {
    clientId: ctx.clientId,
    jobsByTabAndRow,
    jobsByUuid,
    invoicesByJobRowSlot,
    expensesByJobRowSlot,
    seriesById,
  };
}

/**
 * Resolves a caller-supplied `jobUuid` against `pulse_jobs` (strictly scoped to `client_id`),
 * automatically healing stale row numbers when rows have shifted, or raising a clean 409 if
 * the job was deleted or moved to another status tab.
 */
export async function resolveAuthoritativeJobAnchor({
  spreadsheetId = "",
  clientName = "",
  jobUuid = "",
  expectedTabName = "",
  fallbackRowNum = null,
} = {}) {
  const ctx = await resolveSupabaseSheetContext({ spreadsheetId, clientName });
  const isRelational = ctx?.jobsMode === "relational";
  const cleanUuid = String(jobUuid || "").trim();

  if (!isRelational || !cleanUuid) {
    return {
      isRelational,
      resolved: false,
      jobUuid: cleanUuid || null,
      retainerSeriesId: null,
      rowNum: fallbackRowNum !== null && fallbackRowNum !== undefined ? Number(fallbackRowNum) : null,
      rowNums: null,
      tabName: expectedTabName || "",
      jobRecord: null,
    };
  }

  if (!UUID_REGEX.test(cleanUuid)) {
    const err = new Error("Invalid job identifier.");
    err.statusCode = 400;
    throw err;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) {
    return {
      isRelational,
      resolved: false,
      jobUuid: cleanUuid,
      retainerSeriesId: null,
      rowNum: fallbackRowNum !== null && fallbackRowNum !== undefined ? Number(fallbackRowNum) : null,
      rowNums: null,
      tabName: expectedTabName || "",
      jobRecord: null,
    };
  }

  // Strictly scoped to this tenant's client_id to enforce multi-tenant isolation
  const { data: dbJob, error } = await supabase
    .from("pulse_jobs")
    .select("id, client_id, tab_type, sheet_row_num, sheet_child_row_count, retainer_series_id, customer_name, job_name, project_code")
    .eq("client_id", ctx.clientId)
    .eq("id", cleanUuid)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed verifying job identity: ${error.message}`);
  }
  if (!dbJob) {
    const err = new Error("This job was modified or removed in another session. Please refresh and try again.");
    err.statusCode = 409;
    throw err;
  }

  const actualTabName = dbJob.tab_type === "pipeline" ? "Pipeline" : "Confirmed";
  if (expectedTabName && actualTabName !== expectedTabName) {
    const targetLabel = actualTabName === "Confirmed" ? "confirmed" : "pipeline";
    const err = new Error(`This job has already been moved to ${targetLabel}. Please refresh and try again.`);
    err.statusCode = 409;
    throw err;
  }

  const childCount = Math.max(0, Number(dbJob.sheet_child_row_count) || 0);
  const rowNums = [];
  for (let off = 0; off <= childCount; off++) {
    rowNums.push(dbJob.sheet_row_num + off);
  }

  return {
    isRelational: true,
    resolved: true,
    jobUuid: dbJob.id,
    retainerSeriesId: dbJob.retainer_series_id || null,
    rowNum: dbJob.sheet_row_num,
    childRowCount: childCount,
    rowNums,
    tabName: actualTabName,
    jobRecord: dbJob,
  };
}

/**
 * Idempotently backfills/reconciles a client's `Confirmed` & `Pipeline` tabs from `master_sheet_grids`
 * into `pulse_retainer_series`, `pulse_jobs`, `pulse_job_invoices`, and `pulse_job_expenses`
 * while preserving existing UUIDs wherever jobs/series/slots match.
 */
export async function backfillClientRelationalJobs(clientName) {
  const schema = await checkPhase2RelationalSchemaStatus();
  if (!schema.schemaReady) {
    throw new Error("Migration 0012 must be applied in Supabase SQL Editor before backfilling relational jobs.");
  }

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) {
    throw new Error(`Client "${clientName}" was not found in Supabase.`);
  }
  if (ctx.gridStorageRetired) {
    return {
      clientName: ctx.clientName,
      skippedRetired: true,
      confirmedJobsCount: 0,
      pipelineJobsCount: 0,
      retainerSeriesCount: 0,
      invoicesCount: 0,
      expensesCount: 0,
    };
  }

  return reconcileClientRelationalJobsFromGrids(ctx, ["Confirmed", "Pipeline"], {
    forceFullUpsert: true,
    updateBackfillTimestamp: true,
  });
}

/**
 * Backfills all clients present in `public.clients` into Phase 2 relational job tables.
 */
export async function backfillAllClientsRelationalJobs() {
  const schema = await checkPhase2RelationalSchemaStatus();
  if (!schema.schemaReady) {
    throw new Error("Migration 0012 must be applied in Supabase SQL Editor before backfilling relational jobs.");
  }
  const supabase = getSupabaseAdmin();
  const { data: clients, error } = await supabase.from("clients").select("client_name").order("client_name");
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    try {
      const s = await backfillClientRelationalJobs(cl.client_name);
      results.push({ ...s, error: null });
    } catch (err) {
      results.push({ clientName: cl.client_name, error: err.message });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    totalClients: results.length,
    succeededCount: results.filter((r) => !r.error).length,
    errorCount: results.filter((r) => Boolean(r.error)).length,
    results,
  };
}

/**
 * Verifies 100% lossless cell, formula, and note parity between `Confirmed`/`Pipeline`
 * virtual grids and the Phase 2 relational model (from Supabase DB when backfilled,
 * or via lossless in-memory Grid -> Relational -> Grid round-trip otherwise).
 */
export async function verifyRelationalJobsParity({ clientName = null, source = "auto" } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase2RelationalSchemaStatus();
  const cols = schema.schemaReady ? "id, client_name, jobs_mode, client_compute_mode, metadata" : "id, client_name, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  let { data: clients, error } = await query;
  if (error && String(error.message || "").includes("client_compute_mode")) {
    let fbQuery = supabase
      .from("clients")
      .select(schema.schemaReady ? "id, client_name, jobs_mode, metadata" : "id, client_name, metadata")
      .order("client_name");
    if (clientName) fbQuery = fbQuery.eq("client_name", clientName);
    ({ data: clients, error } = await fbQuery);
  }
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    try {
      const ctx = {
        clientId: cl.id,
        clientName: cl.client_name,
        clientComputeMode: String(cl.client_compute_mode || cl.metadata?.client_compute_mode || "grid_gas").trim().toLowerCase(),
      };
      const [confGrid, pipeGrid] = await Promise.all([
        getOrLoadVirtualTabGrid_(ctx, "client", "Confirmed", null, { includeNotes: true }),
        getOrLoadVirtualTabGrid_(ctx, "client", "Pipeline", null, { includeNotes: true }),
      ]);

      const canUseDb =
        schema.schemaReady &&
        (source === "db" || (source === "auto" && Boolean(cl.metadata?.relational_jobs_state?.lastBackfilledAt)));

      let usedSource = "in_memory";
      let confJobs = [];
      let pipeJobs = [];
      let invMap = new Map();
      let expMap = new Map();

      if (canUseDb) {
        usedSource = "db";
        const [dbJobs, dbInvs, dbExps] = await Promise.all([
          fetchAllRowsForClient_(supabase, "pulse_jobs", cl.id),
          fetchAllRowsForClient_(supabase, "pulse_job_invoices", cl.id),
          fetchAllRowsForClient_(supabase, "pulse_job_expenses", cl.id),
        ]);
        for (const inv of dbInvs) {
          if (!invMap.has(inv.job_id)) invMap.set(inv.job_id, []);
          invMap.get(inv.job_id).push(inv);
        }
        for (const exp of dbExps) {
          if (!expMap.has(exp.job_id)) expMap.set(exp.job_id, []);
          expMap.get(exp.job_id).push(exp);
        }
        confJobs = dbJobs.filter((j) => j.tab_type === "confirmed").sort((a, b) => a.sort_order - b.sort_order);
        pipeJobs = dbJobs.filter((j) => j.tab_type === "pipeline").sort((a, b) => a.sort_order - b.sort_order);
      } else {
        const confMod = parseTabGridToRelationalModel({
          clientId: cl.id,
          clientName: cl.client_name,
          tabName: "Confirmed",
          valuesGrid: confGrid?.values_grid || [],
          formulasGrid: confGrid?.formulas_grid || [],
          notesGrid: confGrid?.notes_grid || {},
        });
        const pipeMod = parseTabGridToRelationalModel({
          clientId: cl.id,
          clientName: cl.client_name,
          tabName: "Pipeline",
          valuesGrid: pipeGrid?.values_grid || [],
          formulasGrid: pipeGrid?.formulas_grid || [],
          notesGrid: pipeGrid?.notes_grid || {},
        });
        confJobs = confMod.jobs;
        pipeJobs = pipeMod.jobs;
      }

      const confProj = projectRelationalModelToTabGrid({
        tabName: "Confirmed",
        jobs: confJobs,
        baseValuesGrid: confGrid?.values_grid || [],
        baseFormulasGrid: confGrid?.formulas_grid || [],
        baseNotesGrid: confGrid?.notes_grid || {},
        invoicesByJobId: canUseDb ? invMap : null,
        expensesByJobId: canUseDb ? expMap : null,
      });
      const pipeProj = projectRelationalModelToTabGrid({
        tabName: "Pipeline",
        jobs: pipeJobs,
        baseValuesGrid: pipeGrid?.values_grid || [],
        baseFormulasGrid: pipeGrid?.formulas_grid || [],
        baseNotesGrid: pipeGrid?.notes_grid || {},
        invoicesByJobId: canUseDb ? invMap : null,
        expensesByJobId: canUseDb ? expMap : null,
      });

      const confDiffs = compareGridsStrict_(
        "Confirmed",
        confGrid?.values_grid || [],
        confGrid?.formulas_grid || [],
        confGrid?.notes_grid || {},
        confProj.valuesGrid,
        confProj.formulasGrid,
        confProj.notesGrid
      );
      const pipeDiffs = compareGridsStrict_(
        "Pipeline",
        pipeGrid?.values_grid || [],
        pipeGrid?.formulas_grid || [],
        pipeGrid?.notes_grid || {},
        pipeProj.valuesGrid,
        pipeProj.formulasGrid,
        pipeProj.notesGrid
      );

      const totalMismatchCount = confDiffs.length + pipeDiffs.length;
      results.push({
        clientName: cl.client_name,
        source: usedSource,
        jobsMode: cl.jobs_mode || cl.metadata?.jobs_mode || "grid",
        confirmedJobsCount: confJobs.length,
        pipelineJobsCount: pipeJobs.length,
        confirmedMismatchCount: confDiffs.length,
        pipelineMismatchCount: pipeDiffs.length,
        totalMismatchCount,
        matched: totalMismatchCount === 0,
        sampleMismatches: [...confDiffs, ...pipeDiffs].slice(0, 6),
        error: null,
      });
    } catch (err) {
      results.push({
        clientName: cl.client_name,
        source: "error",
        matched: false,
        totalMismatchCount: 0,
        sampleMismatches: [],
        error: err.message,
      });
    }
  }

  return {
    success: true,
    checkedAt: new Date().toISOString(),
    schemaReady: schema.schemaReady,
    clientsChecked: results.length,
    matchedClientsCount: results.filter((r) => r.matched && !r.error).length,
    mismatchClientsCount: results.filter((r) => !r.matched && !r.error).length,
    errorClientsCount: results.filter((r) => Boolean(r.error)).length,
    results,
  };
}

/**
 * Toggles `clients.jobs_mode` between `'grid'` and `'relational'`.
 * Switching to `'relational'` enforces schema readiness, auto-backfills if needed,
 * and verifies 0 DB parity diffs before cutting over.
 */
export async function setClientJobsMode(clientName, jobsMode) {
  if (jobsMode !== "grid" && jobsMode !== "relational") {
    throw new Error("Invalid jobsMode. Expected 'grid' or 'relational'.");
  }
  const schema = await checkPhase2RelationalSchemaStatus();
  if (!schema.schemaReady) {
    throw new Error("Migration 0012 must be applied in Supabase SQL Editor before enabling relational jobs mode.");
  }

  const supabase = getSupabaseAdmin();
  const { data: cl, error: clErr } = await supabase
    .from("clients")
    .select("id, client_name, grid_storage_retired, metadata, client_sheet_id")
    .eq("client_name", clientName)
    .maybeSingle();
  if (clErr || !cl) throw new Error(`Client "${clientName}" not found.`);
  if (cl.grid_storage_retired && jobsMode !== "relational") {
    throw new Error(
      `Client "${clientName}" has retired grid storage and cannot be downgraded from 'relational' jobs_mode.`
    );
  }

  let backfillSummary = null;
  if (jobsMode === "relational" && !cl.grid_storage_retired) {
    backfillSummary = await backfillClientRelationalJobs(cl.client_name);
    const parity = await verifyRelationalJobsParity({ clientName: cl.client_name, source: "db" });
    const rec = parity.results?.[0];
    if (!rec || rec.error || rec.totalMismatchCount > 0) {
      throw new Error(
        `Parity check failed for ${cl.client_name} (${rec?.error || `${rec?.totalMismatchCount} diffs`}). Mode unchanged.`
      );
    }
  }

  const nextMeta = {
    ...(cl.metadata && typeof cl.metadata === "object" ? cl.metadata : {}),
    ...(backfillSummary ? { relational_jobs_state: backfillSummary } : {}),
    jobs_mode: jobsMode,
  };
  const { error: updErr } = await supabase
    .from("clients")
    .update({ jobs_mode: jobsMode, metadata: nextMeta })
    .eq("id", cl.id);
  if (updErr) throw new Error(`Failed updating jobs_mode: ${updErr.message}`);

  invalidateSheetContextCache();
  if (cl.client_sheet_id) {
    await invalidatePmaClientCache(cl.client_sheet_id, null, ["jobs", "retainers", "views"]).catch(() => { });
    if (redisClient?.isOpen) {
      await redisClient
        .del([
          `pulse:portal:payload:${cl.client_sheet_id}`,
          `pulse:portal:keydata:${cl.client_sheet_id}:all`,
          `pulse:portal:keydata:${cl.client_sheet_id}:jobs`,
        ])
        .catch(() => { });
    }
  }

  return {
    success: true,
    clientName: cl.client_name,
    jobsMode,
    backfillSummary,
    hasRealClientSheet: Boolean(cl.client_sheet_id && !isVirtualSupabaseSheetId(cl.client_sheet_id)),
  };
}

// ============================================================================
// PHASE 2C: PURE RELATIONAL JOBS READS & READ PARITY VERIFICATION
// ============================================================================

const NOTE_COL_INDICES_2C = [0, 41, 48, 55, 75, 82, 89];

function reconstructHeaderArrayFromSparse_(sparseObj = {}) {
  if (!sparseObj || typeof sparseObj !== "object") return [];
  let maxC = -1;
  for (const k of Object.keys(sparseObj)) {
    const idx = parseInt(k, 10);
    if (Number.isInteger(idx) && idx > maxC) maxC = idx;
  }
  if (maxC < 0) return [];
  const arr = new Array(maxC + 1).fill("");
  for (const [k, v] of Object.entries(sparseObj)) {
    const idx = parseInt(k, 10);
    if (Number.isInteger(idx) && idx >= 0) arr[idx] = v;
  }
  return arr;
}

/**
 * Preloads a client's normalized job tables (`pulse_jobs`, `pulse_job_invoices`,
 * `pulse_job_expenses`, `pulse_retainer_series`) plus stored header metadata
 * cleanly in a single parallel batch for Phase 2C pure-relational reads.
 */
export async function preloadClientRelationalJobsBundle(
  ctxOrClientName,
  { includeConfirmed = true, includePipeline = true } = {}
) {
  if (!isSupabaseConfigured()) return null;
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const tabFilter =
    includeConfirmed && !includePipeline
      ? "confirmed"
      : !includeConfirmed && includePipeline
        ? "pipeline"
        : null;

  let clMetaResp, jobs, invoices, expenses, series;
  if (tabFilter) {
    [clMetaResp, jobs, series] = await Promise.all([
      supabase.from("clients").select("metadata").eq("id", ctx.clientId).maybeSingle(),
      fetchAllRowsForClient_(supabase, "pulse_jobs", ctx.clientId, { tabType: tabFilter }),
      fetchAllRowsForClient_(supabase, "pulse_retainer_series", ctx.clientId, { tabType: tabFilter }),
    ]);
    const jobIds = jobs.map((j) => j.id);
    if (jobIds.length > 0) {
      [invoices, expenses] = await Promise.all([
        fetchChildRowsForJobIds_(supabase, "pulse_job_invoices", ctx.clientId, jobIds),
        fetchChildRowsForJobIds_(supabase, "pulse_job_expenses", ctx.clientId, jobIds),
      ]);
    } else {
      invoices = [];
      expenses = [];
    }
  } else {
    [clMetaResp, jobs, invoices, expenses, series] = await Promise.all([
      supabase.from("clients").select("metadata").eq("id", ctx.clientId).maybeSingle(),
      fetchAllRowsForClient_(supabase, "pulse_jobs", ctx.clientId),
      fetchAllRowsForClient_(supabase, "pulse_job_invoices", ctx.clientId),
      fetchAllRowsForClient_(supabase, "pulse_job_expenses", ctx.clientId),
      fetchAllRowsForClient_(supabase, "pulse_retainer_series", ctx.clientId),
    ]);
  }

  const jobsByTabAndRow = new Map();
  const jobsByUuid = new Map();
  const confirmedJobs = [];
  const pipelineJobs = [];

  for (const j of jobs) {
    jobsByTabAndRow.set(`${j.tab_type}:${j.sheet_row_num}`, j);
    jobsByUuid.set(j.id, j);
    if (j.tab_type === "pipeline") pipelineJobs.push(j);
    else confirmedJobs.push(j);
  }
  confirmedJobs.sort((a, b) => (a.sheet_row_num || 0) - (b.sheet_row_num || 0));
  pipelineJobs.sort((a, b) => (a.sheet_row_num || 0) - (b.sheet_row_num || 0));

  const invoicesByJobRowSlot = new Map();
  const invoicesByJobId = new Map();
  for (const inv of invoices) {
    invoicesByJobRowSlot.set(`${inv.job_id}:${inv.row_offset}:${inv.slot_index}`, inv);
    if (!invoicesByJobId.has(inv.job_id)) invoicesByJobId.set(inv.job_id, []);
    invoicesByJobId.get(inv.job_id).push(inv);
  }

  const expensesByJobRowSlot = new Map();
  const expensesByJobId = new Map();
  for (const exp of expenses) {
    expensesByJobRowSlot.set(`${exp.job_id}:${exp.row_offset}:${exp.slot_index}`, exp);
    if (!expensesByJobId.has(exp.job_id)) expensesByJobId.set(exp.job_id, []);
    expensesByJobId.get(exp.job_id).push(exp);
  }

  const seriesById = new Map();
  for (const s of series) seriesById.set(s.id, s);

  const tabHeaders = clMetaResp?.data?.metadata?.relational_jobs_state?.tabHeaders || {};

  return {
    ctx,
    clientId: ctx.clientId,
    tabHeaders,
    jobsByTab: { Confirmed: confirmedJobs, Pipeline: pipelineJobs },
    invoicesByJobId,
    expensesByJobId,
    relLookup: {
      clientId: ctx.clientId,
      jobsByTabAndRow,
      jobsByUuid,
      invoicesByJobRowSlot,
      expensesByJobRowSlot,
      seriesById,
    },
  };
}

/**
 * Reconstructs formatted 2D display rows and cell notes for `Confirmed`, `Pipeline`,
 * `ConfCalcs`, or `PipeCalcs` strictly from relational SQL tables (`pulse_jobs`,
 * `pulse_job_invoices`, `pulse_job_expenses`, and stored `tabHeaders`) without
 * reading `master_sheet_grids` or Google Sheets.
 */
export function buildRelationalFormattedTabRowsFromBundle(
  bundle,
  tabName = "Confirmed",
  { useCalcsTab = false, maxColLimit = null } = {}
) {
  if (!bundle) return { rows: [], notesByRowCol: {} };
  const isPipeline = tabName === "Pipeline";
  const calcsTabName = isPipeline ? "PipeCalcs" : "ConfCalcs";
  const hasCalcs = Boolean(bundle.tabHeaders?.[`has${calcsTabName}`]);
  const useCalcs = Boolean(useCalcsTab && hasCalcs);
  const displayTabName = useCalcs ? calcsTabName : tabName;

  const rawHeaderSparse =
    (useCalcs && bundle.tabHeaders?.[calcsTabName]) ||
    bundle.tabHeaders?.[tabName] ||
    {};
  let headerRow = reconstructHeaderArrayFromSparse_(rawHeaderSparse);
  if (Number.isInteger(maxColLimit) && maxColLimit >= 0 && headerRow.length > maxColLimit + 1) {
    headerRow = headerRow.slice(0, maxColLimit + 1);
  }
  const trimmedHeader = trimTrailingEmptyGridCells_(headerRow);
  const headerStubGrid = [headerRow];

  const jobsList = isPipeline ? (bundle.jobsByTab?.Pipeline || []) : (bundle.jobsByTab?.Confirmed || []);
  const invDefs = getInvoiceSlotDefs_(tabName);
  const expDefs = getExpenseSlotDefs_();

  const rows = [trimmedHeader];
  const notesByRowCol = {};

  for (const job of jobsList) {
    const baseRow0 = Number(job.sheet_row_num) - 1;
    if (!Number.isInteger(baseRow0) || baseRow0 < 1) continue;

    const invList = bundle.invoicesByJobId?.get(job.id) || [];
    const expList = bundle.expensesByJobId?.get(job.id) || [];
    const maxOff = Math.max(
      0,
      Number(job.sheet_child_row_count) || 0,
      ...invList.map((i) => Number(i.row_offset) || 0),
      ...expList.map((e) => Number(e.row_offset) || 0)
    );

    const rawScalars = job.raw_scalars && typeof job.raw_scalars === "object" ? job.raw_scalars : {};
    const extraFields = job.extra_fields && typeof job.extra_fields === "object" ? job.extra_fields : {};
    const cellNotes = job.cell_notes && typeof job.cell_notes === "object" ? job.cell_notes : {};
    const calcsObj = extraFields._calcs && typeof extraFields._calcs === "object" ? extraFields._calcs : {};
    const dateCellsRaw = extraFields._dateCells && typeof extraFields._dateCells === "object" ? extraFields._dateCells : {};

    const scalarFallback = {
      0: job.customer_name || "",
      1: job.job_name || "",
      2: job.project_code || "",
      3: job.date_confirmed || "",
      4: job.lead_source || "",
      30: job.uneven_split || "",
      32: job.revenue ?? "",
      33: job.direct_costs ?? "",
      34: job.vat_applicable || "",
      35: job.job_type || "",
      36: job.product_line || "",
      37: job.start_date || "",
      38: job.end_date || "",
      39: job.likelihood_pct ?? "",
      107: job.copied_to_confirmed || "",
    };
    if (job.is_job_costing) {
      scalarFallback[5] = job.jc_start_date || "";
      scalarFallback[6] = job.jc_end_date || "";
      scalarFallback[7] = job.jc_fixed_variable || "";
      scalarFallback[8] = job.jc_job_revenue ?? "";
      scalarFallback[9] = job.jc_likelihood_input ?? "";
      scalarFallback[10] = job.jc_contractor_costs ?? "";
      scalarFallback[16] = job.jc_external_costs ?? "";
      scalarFallback[17] = job.recharged_expenses ?? "";
      scalarFallback[19] = job.jc_prop_succ_fee_pct ?? "";
      scalarFallback[21] = job.jc_prop_succ_fee_rec || "";
      scalarFallback[27] = job.jc_inv_no || "";
    } else if (tabName === "Confirmed") {
      scalarFallback[17] = job.recharged_expenses ?? "";
    }

    const __dateCells = Object.create(null);
    for (const [dk, dv] of Object.entries(dateCellsRaw)) {
      if (!dv) continue;
      const colon = dk.indexOf(":");
      if (colon <= 0) continue;
      const offNum = parseInt(dk.slice(0, colon), 10);
      const colNum = parseInt(dk.slice(colon + 1), 10);
      if (Number.isInteger(offNum) && Number.isInteger(colNum)) {
        __dateCells[`${baseRow0 + offNum}:${colNum}`] = true;
      }
    }
    const dateCellsStub = { __dateCells };

    for (let off = 0; off <= maxOff; off++) {
      const r0 = baseRow0 + off;
      const rowNum = r0 + 1;
      const rawRow = [];

      // 1. Non-slot parent/child scalars
      const nonSlotCols = [];
      for (let c = 0; c <= 39; c++) nonSlotCols.push(c);
      nonSlotCols.push(107);
      for (const c of nonSlotCols) {
        if (Number.isInteger(maxColLimit) && c > maxColLimit) continue;
        const k = `${off}:${c}`;
        let val = "";
        if (off === 0) {
          if (Object.prototype.hasOwnProperty.call(rawScalars, String(c))) {
            val = rawScalars[String(c)];
          } else if (
            Object.prototype.hasOwnProperty.call(scalarFallback, c) &&
            isNonEmptyCell_(scalarFallback[c]) &&
            !((c === 17 || c === 32 || c === 33) && Number(scalarFallback[c]) === 0)
          ) {
            val = scalarFallback[c];
          }
        } else if (Object.prototype.hasOwnProperty.call(extraFields, k)) {
          val = extraFields[k];
        }
        if (val !== "" && val !== undefined && val !== null) {
          rawRow[c] = val;
        }
      }

      if (NOTE_COL_INDICES_2C.includes(0) && cellNotes[`${off}:0`]) {
        notesByRowCol[`${rowNum}:0`] = cellNotes[`${off}:0`];
      }

      // 2. Invoice slots for this row offset
      for (const inv of invList) {
        if ((Number(inv.row_offset) || 0) !== off) continue;
        const def = invDefs[Number(inv.slot_index) || 0];
        if (!def) continue;
        const rawCells = Array.isArray(inv.raw_cells) ? inv.raw_cells : [];
        const fallback = [
          inv.amount ?? "",
          inv.invoice_ref || "",
          inv.send_date || "",
          inv.days_to_pay ?? "",
          inv.status || "",
          inv.of_which_recharged ?? "",
          inv.cost_month || "",
        ];
        for (let rel = 0; rel < def.colCount; rel++) {
          const c = def.startCol + rel;
          if (Number.isInteger(maxColLimit) && c > maxColLimit) continue;
          const v = rawCells.length > 0 ? (rawCells[rel] ?? "") : (fallback[rel] ?? "");
          if (v !== "" && v !== undefined && v !== null) rawRow[c] = v;
        }
        if (inv.cell_notes?.["0"]) {
          notesByRowCol[`${rowNum}:${def.startCol}`] = inv.cell_notes["0"];
        }
      }

      // 3. Expense slots for this row offset
      for (const exp of expList) {
        if ((Number(exp.row_offset) || 0) !== off) continue;
        const def = expDefs[Number(exp.slot_index) || 0];
        if (!def) continue;
        const rawCells = Array.isArray(exp.raw_cells) ? exp.raw_cells : [];
        const fallback = [
          exp.description || "",
          exp.amount ?? "",
          exp.vat_applicable || "",
          exp.received_date || "",
          exp.days_to_pay ?? "",
          exp.status || "",
          exp.external_app_id || "",
        ];
        for (let rel = 0; rel < def.colCount; rel++) {
          const c = def.startCol + rel;
          if (Number.isInteger(maxColLimit) && c > maxColLimit) continue;
          const v = rawCells.length > 0 ? (rawCells[rel] ?? "") : (fallback[rel] ?? "");
          if (v !== "" && v !== undefined && v !== null) rawRow[c] = v;
        }
        if (exp.cell_notes?.["0"]) {
          notesByRowCol[`${rowNum}:${def.startCol}`] = exp.cell_notes["0"];
        }
      }

      // 4. Reconciled rollup columns (Cols 74, 106 from tab + ConfCalcs/PipeCalcs cols)
      const tabRollups = calcsObj.tab?.[String(off)];
      if (tabRollups && typeof tabRollups === "object") {
        for (const [ck, cv] of Object.entries(tabRollups)) {
          const c = parseInt(ck, 10);
          if (!Number.isInteger(c)) continue;
          if (Number.isInteger(maxColLimit) && c > maxColLimit) continue;
          rawRow[c] = cv;
        }
      }
      if (useCalcs) {
        const calcsRollups = calcsObj.calcs?.[String(off)];
        if (calcsRollups && typeof calcsRollups === "object") {
          for (const [ck, cv] of Object.entries(calcsRollups)) {
            const c = parseInt(ck, 10);
            if (!Number.isInteger(c) || !ROLLUP_CALCS_COL_SET.has(c)) continue;
            if (Number.isInteger(maxColLimit) && c > maxColLimit) continue;
            rawRow[c] = cv;
          }
        }
      }

      // 5. Format row identically to sheets.spreadsheets.values.batchGet(FORMATTED_VALUE)
      while (rows.length <= r0) rows.push([]);
      const formatted = [];
      for (let c = 0; c < rawRow.length; c++) {
        const rv = rawRow[c];
        if (rv === undefined || rv === null || rv === "") {
          formatted[c] = "";
        } else {
          formatted[c] = formatCellForDisplay("client", displayTabName, r0, c, rv, headerStubGrid, dateCellsStub);
        }
      }
      rows[r0] = trimTrailingEmptyGridCells_(formatted);
    }
  }

  return { rows, notesByRowCol };
}

/**
 * Convenience single-tab relational formatted row loader (strictly Postgres-only).
 */
export async function buildRelationalFormattedTabRows(
  ctxOrClientName,
  tabName = "Confirmed",
  options = {}
) {
  const isPipeline = tabName === "Pipeline";
  const bundle = await preloadClientRelationalJobsBundle(ctxOrClientName, {
    includeConfirmed: !isPipeline,
    includePipeline: isPipeline,
  });
  if (!bundle) return { rows: [], notesByRowCol: {}, relLookup: null };
  const built = buildRelationalFormattedTabRowsFromBundle(bundle, tabName, options);
  return { ...built, relLookup: bundle.relLookup };
}

/**
 * Pure Portal job parser extracted identically from `/api/portal/key-data` so both
 * live Portal requests and the 16/16 read-parity verifier run identical code.
 */
export function parsePortalJobsFromFormattedRows({
  rows = [],
  jobType = "Confirmed",
  isJobCosting = false,
  relLookup = null,
}) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const maxRow = rows.length;
  let realLastRow = 1;
  for (let i = maxRow - 1; i >= 1; i--) {
    const r = rows[i] || [];
    if ((r[0] && String(r[0]).trim() !== "") || (r[1] && String(r[1]).trim() !== "")) {
      realLastRow = i + 1;
      break;
    }
  }
  if (realLastRow < 2) return [];

  const parseMoneyLocal = (val) => {
    if (typeof val === "number") return Number.isFinite(val) ? val : 0;
    if (!val) return 0;
    const s = String(val).trim();
    const neg = (s.startsWith("(") && s.endsWith(")")) || s.startsWith("-");
    const n = parseFloat(s.replace(/[£$€,\s()]/g, ""));
    if (!Number.isFinite(n)) return 0;
    return neg ? -Math.abs(n) : n;
  };

  const formatDateVal = (val) => {
    if (!val && val !== 0) return "";
    if (typeof val === "number" || (!isNaN(Number(val)) && !String(val).includes("-") && !String(val).includes("/"))) {
      const num = Number(val);
      if (num > 30000 && num < 100000) {
        const d = new Date((num - 25569) * 86400 * 1000);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      }
    }
    const str = String(val).trim();
    const ukMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (ukMatch) {
      return `${ukMatch[3]}-${String(ukMatch[2]).padStart(2, "0")}-${String(ukMatch[1]).padStart(2, "0")}`;
    }
    const shortUk = str.match(/^(\d{1,2})[\-\/\s]([a-zA-Z]{3})[\-\/\s](\d{2,4})/);
    if (shortUk) {
      const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
      const mi = months[shortUk[2].toLowerCase()];
      let yr = parseInt(shortUk[3], 10);
      if (yr < 100) yr += 2000;
      if (mi !== undefined) return `${yr}-${mi}-${String(shortUk[1]).padStart(2, "0")}`;
    }
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    return str;
  };

  const parseDateToYMD = (val, isEnd = false) => {
    if (!val && val !== 0) return "";
    const str = String(val).trim();
    const myMatch = str.match(/^(?:(\d{1,2})[\/\-\s])?([a-zA-Z]{3,})[\/\-\s](\d{2,4})$/);
    if (myMatch) {
      const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
      const mi = months[myMatch[2].toLowerCase().substring(0, 3)];
      let yr = parseInt(myMatch[3], 10);
      if (yr < 100) yr += 2000;
      if (mi !== undefined) {
        let day = myMatch[1] ? String(myMatch[1]).padStart(2, "0") : (isEnd ? "28" : "01");
        if (isEnd && !myMatch[1]) {
          day = String(new Date(yr, parseInt(mi, 10), 0).getDate()).padStart(2, "0");
        }
        return `${yr}-${mi}-${day}`;
      }
    }
    return formatDateVal(val);
  };

  const headers = rows[0] || [];
  const colMap = {};
  headers.forEach((h, idx) => {
    if (h) colMap[String(h).toLowerCase().trim().replace(/\s+/g, " ")] = idx;
  });

  const getValueByHeader = (row, headerNames) => {
    const names = Array.isArray(headerNames) ? headerNames : [headerNames];
    for (const name of names) {
      const normalized = name.toLowerCase().trim().replace(/\s+/g, " ");
      if (Object.prototype.hasOwnProperty.call(colMap, normalized)) {
        const val = row[colMap[normalized]];
        if (val !== undefined && val !== null) return String(val).trim();
      }
    }
    return "";
  };

  const parsed = [];
  let i = 1;
  while (i < realLastRow) {
    const row = rows[i] || [];
    const rowNum = i + 1;
    const client = getValueByHeader(row, "client");
    const jobName = getValueByHeader(row, ["job name", "job"]);
    const revenue = getValueByHeader(row, ["revenue (proj total / ongoing pm) - excl vat", "revenue"]);
    const directCosts = getValueByHeader(row, ["direct costs (proj total / ongoing pm) - excl vat", "direct costs"]);
    const rechargedExpenses = jobType === "Confirmed"
      ? (getValueByHeader(row, ["recharged expenses (excl vat)", "recharged expenses", "rechgd exp"]) ||
        (row[17] !== undefined ? String(row[17]).trim() : ""))
      : "";

    if (!client && !jobName) { i++; continue; }

    if (jobType === "Pipeline") {
      const copied =
        getValueByHeader(row, ["copied to confirmed tab?", "copied to confirmed?", "copied to confirmed"]) ||
        (row[107] !== undefined ? String(row[107]).trim() : "");
      if (["yes", "y", "true"].includes(String(copied).toLowerCase().trim())) { i++; continue; }
    }

    const isParent = (revenue && String(revenue).trim() !== "" && Math.abs(parseMoneyLocal(revenue)) > 0.001) ||
      (directCosts && String(directCosts).trim() !== "" && Math.abs(parseMoneyLocal(directCosts)) > 0.001) ||
      (rechargedExpenses && String(rechargedExpenses).trim() !== "" && Math.abs(parseMoneyLocal(rechargedExpenses)) > 0.001);

    if (isParent) {
      const projectRetainer = getValueByHeader(row, ["project / retainer", "proj / ret"]) || "Project";
      const isRetainer = projectRetainer.toLowerCase().includes("retainer");
      const rawSplitAe = getValueByHeader(row, ["revunevensplit"]) || (row[30] !== undefined ? String(row[30]) : "");
      const varRetainerMeta = isRetainer ? parseVariableRetainerTag(rawSplitAe) : null;
      const isVariableRetainer = Boolean(isRetainer && varRetainerMeta);
      const isFixedRetainer = isRetainer && !isVariableRetainer;

      let j = i + 1;
      const childRows = [];
      while (j < realLastRow) {
        const nextRow = rows[j] || [];
        const nextClient = getValueByHeader(nextRow, "client");
        const nextJobName = getValueByHeader(nextRow, ["job name", "job"]);
        const nextRev = getValueByHeader(nextRow, ["revenue (proj total / ongoing pm) - excl vat", "revenue"]);
        const nextDC = getValueByHeader(nextRow, ["direct costs (proj total / ongoing pm) - excl vat", "direct costs"]);
        const nextRech = jobType === "Confirmed"
          ? (getValueByHeader(nextRow, ["recharged expenses (excl vat)", "recharged expenses", "rechgd exp"]) ||
            (nextRow[17] !== undefined ? String(nextRow[17]).trim() : ""))
          : "";
        if (
          nextClient === client &&
          nextJobName === jobName &&
          (!nextRev || String(nextRev).trim() === "" || Math.abs(parseMoneyLocal(nextRev)) < 0.001) &&
          (!nextDC || String(nextDC).trim() === "" || Math.abs(parseMoneyLocal(nextDC)) < 0.001) &&
          (!nextRech || String(nextRech).trim() === "" || Math.abs(parseMoneyLocal(nextRech)) < 0.001)
        ) {
          childRows.push({ row: nextRow, rowNum: j + 1 });
          j++;
        } else {
          break;
        }
      }

      const invoices = [];
      let currentInvNum = 1;
      const extractInv = (r, slot) => {
        const amtH = slot === 1
          ? ["project invoice 1 / monthly retainer (excl vat)", "project invoice 1", "inv 1 amount"]
          : [`project invoice ${slot} (excl vat)`, `project invoice ${slot}`, `inv ${slot} amount`];
        const refH = [`inv ${slot} ref`, `inv. ${slot} ref`, `invoice ${slot} ref`, `inv ${slot} reference`, `inv ${slot} no`, `inv ${slot} no.`];
        const dateH = [`inv ${slot} send date`, `inv. ${slot} send date`, `inv ${slot} date`, `inv ${slot} sent date`];
        const daysH = [`inv ${slot} days to pay`, `inv. ${slot} days to pay`, `inv ${slot} days`];
        const statusH = [`inv ${slot} status`, `inv. ${slot} status`, `invoice ${slot} status`, `inv ${slot} status?`, `inv ${slot} state`];
        const rechgdH = [`inv ${slot} of which rechgd`, `inv. ${slot} of which rechgd`, `inv ${slot} recharged`, `inv ${slot} rechgd`];
        const costMonthH = [`inv ${slot} cost month`, `inv. ${slot} cost month`];
        const defaultBase = slot === 1 ? 41 : slot === 2 ? 48 : 55;
        const amt = getValueByHeader(r, amtH) || (r[defaultBase] !== undefined ? String(r[defaultBase]).trim() : "");
        const ref = getValueByHeader(r, refH) || (r[defaultBase + 1] !== undefined ? String(r[defaultBase + 1]).trim() : "");
        const sendDateRaw = getValueByHeader(r, dateH) || (r[defaultBase + 2] !== undefined ? String(r[defaultBase + 2]).trim() : "");
        const days = getValueByHeader(r, daysH) || (r[defaultBase + 3] !== undefined ? String(r[defaultBase + 3]).trim() : "") || "30";
        const status = getValueByHeader(r, statusH) || (r[defaultBase + 4] !== undefined ? String(r[defaultBase + 4]).trim() : "");
        const ofWhichRechgd = jobType === "Confirmed"
          ? (getValueByHeader(r, rechgdH) || (r[defaultBase + 5] !== undefined ? String(r[defaultBase + 5]).trim() : ""))
          : "";
        const costMonth = jobType === "Confirmed"
          ? (getValueByHeader(r, costMonthH) || (r[defaultBase + 6] !== undefined ? String(r[defaultBase + 6]).trim() : ""))
          : "";
        if (amt || ref || sendDateRaw || ofWhichRechgd) {
          return {
            num: currentInvNum++,
            ref,
            amount: amt,
            status: canonicalizeInvoiceStatus(status),
            sendDate: formatDateVal(sendDateRaw),
            days,
            ...(jobType === "Confirmed" ? { ofWhichRechgd, costMonth } : {}),
          };
        }
        return null;
      };

      const relJob = relLookup?.jobsByTabAndRow?.get(`${jobType.toLowerCase()}:${rowNum}`) || null;
      let parentHasInvoice = false;
      for (let s = 1; s <= 3; s++) {
        const inv = extractInv(row, s);
        if (inv) {
          const relInv = relJob ? relLookup.invoicesByJobRowSlot?.get(`${relJob.id}:0:${s - 1}`) : null;
          invoices.push({
            ...inv,
            isChild: false,
            isParent: true,
            ...(relInv ? { invoiceUuid: relInv.id, accountingInvoiceId: relInv.accounting_invoice_id || null } : {}),
          });
          parentHasInvoice = true;
        }
      }

      const childRetainers = [];
      childRows.forEach((cr) => {
        const childOffset = cr.rowNum - rowNum;
        if (isFixedRetainer) {
          let childInvSum = 0;
          let childRechgdSum = 0;
          for (let s = 1; s <= 3; s++) {
            const inv = extractInv(cr.row, s);
            if (inv) {
              const relInv = relJob ? relLookup.invoicesByJobRowSlot?.get(`${relJob.id}:${childOffset}:${s - 1}`) : null;
              invoices.push({
                ...inv,
                isChild: true,
                childRowNum: cr.rowNum,
                ...(relInv ? { invoiceUuid: relInv.id, accountingInvoiceId: relInv.accounting_invoice_id || null } : {}),
              });
              childInvSum += parseMoneyLocal(inv.amount);
              childRechgdSum += parseMoneyLocal(inv.ofWhichRechgd);
            }
          }
          const invAmtRaw = getValueByHeader(cr.row, ["project invoice 1 / monthly retainer (excl vat)", "project invoice 1", "inv 1 amount"]) || cr.row[41];
          const invAmt = childInvSum > 0 ? childInvSum : parseMoneyLocal(invAmtRaw);
          const startRaw = cr.row[146] !== undefined && String(cr.row[146]).trim() !== "" ? cr.row[146] : getValueByHeader(cr.row, ["start month"]);
          const endRaw = cr.row[147] !== undefined && String(cr.row[147]).trim() !== "" ? cr.row[147] : getValueByHeader(cr.row, ["end month"]);
          const monthsRaw = cr.row[148] !== undefined && String(cr.row[148]).trim() !== "" ? cr.row[148] : getValueByHeader(cr.row, ["months"]);
          const revPmRaw = cr.row[149] !== undefined && String(cr.row[149]).trim() !== "" ? cr.row[149] : getValueByHeader(cr.row, ["revenue pm"]);
          const incPmRaw = cr.row[150] !== undefined && String(cr.row[150]).trim() !== "" ? cr.row[150] : getValueByHeader(cr.row, ["income pm"]);
          const dcPmRaw = cr.row[152] !== undefined && String(cr.row[152]).trim() !== "" ? cr.row[152] : getValueByHeader(cr.row, ["3p costs pm"]);
          const startMonth = parseDateToYMD(startRaw, false);
          const endMonth = parseDateToYMD(endRaw, true);
          const months = parseInt(monthsRaw, 10) || 1;
          const childPureInvAmt = Math.max(0, invAmt - childRechgdSum);
          const revPm = parseMoneyLocal(revPmRaw) || (months > 0 ? childPureInvAmt / months : childPureInvAmt);
          const incPm = parseMoneyLocal(incPmRaw) || revPm;
          const dcPm = parseMoneyLocal(dcPmRaw) || 0;
          if (invAmt > 0 && startMonth && endMonth) {
            childRetainers.push({ amount: invAmt, startMonth, endMonth, months, revPm, incPm, dcPm });
          }
        } else {
          for (let s = 1; s <= 3; s++) {
            const inv = extractInv(cr.row, s);
            if (inv) {
              const relInv = relJob ? relLookup.invoicesByJobRowSlot?.get(`${relJob.id}:${childOffset}:${s - 1}`) : null;
              invoices.push({
                ...inv,
                isChild: true,
                childRowNum: cr.rowNum,
                ...(relInv ? { invoiceUuid: relInv.id, accountingInvoiceId: relInv.accounting_invoice_id || null } : {}),
              });
            }
          }
        }
      });

      const directExpenses = [];
      let currentExpNum = 1;
      const extractExp = (r, slot) => {
        const amt = getValueByHeader(r, [`direct inv ${slot} amt`, `direct inv ${slot} amount`]);
        const desc = getValueByHeader(r, [`direct inv ${slot} descr.`, `direct inv ${slot} desc`]);
        const vat = getValueByHeader(r, [`dir inv. ${slot} vat?`, `dir inv ${slot} vat?`, `direct inv ${slot} vat?`]) || "Yes";
        const recDateRaw = getValueByHeader(r, [`dir inv. ${slot} rec date`, `direct inv ${slot} rec date`]);
        const days = getValueByHeader(r, [`dir inv ${slot} days to pay`, `dir inv. ${slot} days to pay`]) || "30";
        const status = getValueByHeader(r, [`dir inv ${slot} status`]) || "";
        const appId = getValueByHeader(r, [`dir inv ${slot} app id`, `dir inv. ${slot} app id`, `direct inv ${slot} app id`]) || "";
        if (amt || desc || recDateRaw || appId) {
          return {
            num: currentExpNum++,
            desc,
            amount: amt,
            vat,
            recDate: formatDateVal(recDateRaw),
            days,
            status: canonicalizeExpenseStatus(status),
            appId,
          };
        }
        return null;
      };

      for (let s = 1; s <= 3; s++) {
        const exp = extractExp(row, s);
        if (exp) {
          const relExp = relJob ? relLookup.expensesByJobRowSlot?.get(`${relJob.id}:0:${s - 1}`) : null;
          directExpenses.push({
            ...exp,
            isChild: false,
            isParent: true,
            ...(relExp ? { expenseUuid: relExp.id, accountingDirectCostId: relExp.accounting_direct_cost_id || null } : {}),
          });
        }
      }
      childRows.forEach((cr) => {
        const childOffset = cr.rowNum - rowNum;
        for (let s = 1; s <= 3; s++) {
          const exp = extractExp(cr.row, s);
          if (exp) {
            const relExp = relJob ? relLookup.expensesByJobRowSlot?.get(`${relJob.id}:${childOffset}:${s - 1}`) : null;
            directExpenses.push({
              ...exp,
              isChild: true,
              childRowNum: cr.rowNum,
              ...(relExp ? { expenseUuid: relExp.id, accountingDirectCostId: relExp.accounting_direct_cost_id || null } : {}),
            });
          }
        }
      });

      const startDateRaw = getValueByHeader(row, ["start date", "start month"]);
      const endDateRaw = getValueByHeader(row, ["end date", "end month"]);
      const likelihoodRaw = getValueByHeader(row, ["% likel.", "% likelihood", "% likely", "likelihood"]);
      const likelihood = likelihoodRaw ? formatLikelihood(likelihoodRaw) : (jobType === "Confirmed" ? "100%" : "50%");
      const revNum = parseMoneyLocal(revenue);
      const dcNum = parseMoneyLocal(directCosts);
      const parsedLikel = parseFloat(String(likelihood).replace("%", ""));
      const likelihoodNum = !isNaN(parsedLikel)
        ? (String(likelihood).includes("%") || parsedLikel > 1 ? parsedLikel / 100 : parsedLikel)
        : (jobType === "Confirmed" ? 1 : 0.5);

      const startDate = formatDateVal(startDateRaw);
      const endDate = formatDateVal(endDateRaw);
      const rawEqStart = row[146] !== undefined && String(row[146]).trim() !== "" ? row[146] : (getValueByHeader(row, ["start month"]) || startDateRaw);
      const rawErEnd = row[147] !== undefined && String(row[147]).trim() !== "" ? row[147] : (getValueByHeader(row, ["end month"]) || endDateRaw);

      const jobObj = {
        id: `${jobType.toLowerCase()}-${rowNum}`,
        jobUuid: relJob?.id || null,
        retainerSeriesId: relJob?.retainer_series_id || null,
        rowNumber: rowNum,
        type: jobType,
        isJobCosting,
        client: client || "General",
        jobName: jobName || `Job #${rowNum}`,
        revenue,
        revNum,
        directCosts,
        dcNum,
        rechargedExpenses,
        ...(isJobCosting ? {
          fixedVariable: row[7] !== undefined ? String(row[7]).trim() : "",
          jobRevenue: row[8] !== undefined ? String(row[8]).trim() : "",
          contractorCosts: row[10] !== undefined ? String(row[10]).trim() : "",
          equivDays: row[12] !== undefined ? String(row[12]).trim() : "",
          equivContractorCosts: row[13] !== undefined ? String(row[13]).trim() : "",
          contractorCostsCheck: row[14] !== undefined ? String(row[14]).trim() : "",
          externalCosts: row[16] !== undefined ? String(row[16]).trim() : "",
          propSuccFeePct: row[19] !== undefined ? String(row[19]).trim() : "",
          propSuccFeeAmt: row[20] !== undefined ? String(row[20]).trim() : "",
          propSuccFeeRec: row[21] !== undefined ? String(row[21]).trim() : "",
          invNo: row[27] !== undefined ? String(row[27]).trim() : "",
        } : {}),
        leftToInvoice: row[74] !== undefined ? String(row[74]).trim() : "",
        grossProfit: getValueByHeader(row, ["gross profit"]),
        grossMargin: getValueByHeader(row, ["margin", "gross profit margin"]),
        productLine: getValueByHeader(row, ["prod. line", "product line"]),
        leadSource: getValueByHeader(row, ["lead src", "lead source"]),
        projectRetainer,
        isVariableRetainer,
        ...(varRetainerMeta ? { varRetainerMeta } : {}),
        startDate,
        endDate,
        likelihood,
        likelihoodNum,
        weightedRevenue: Math.round(revNum * likelihoodNum),
        vat: getValueByHeader(row, ["vat?", "vat"]),
        projectCode: getValueByHeader(row, ["project code"]),
        dateConfirmed: formatDateVal(getValueByHeader(row, ["date conf", "date originally added to pipeline", "date added", "date confirmed"])),
        invoices,
        directExpenses,
        childRowNumbers: childRows.map((cr) => cr.rowNum),
        hasChildRows: childRows.length > 0,
        parentHasInvoice,
        parentId: rowNum - 2,
        isParent: true,
        totalAmount: revNum,
        totalRev: revenue,
        totalDC: directCosts,
        eqStartDate: parseDateToYMD(rawEqStart, false),
        erEndDate: parseDateToYMD(rawErEnd, true),
        splitStr: getValueByHeader(row, ["revunevensplit"]) || (row[30] !== undefined ? String(row[30]) : ""),
        hasSplit: getValueByHeader(row, ["has split"]) || (row[253] !== undefined ? String(row[253]) : ""),
        origBaseRev: getValueByHeader(row, ["orig base rev"]) || (row[258] !== undefined ? String(row[258]) : ""),
        origBaseIncome: getValueByHeader(row, ["orig base income"]) || (row[259] !== undefined ? String(row[259]) : ""),
        childRetainers: childRetainers.length > 0 ? childRetainers : undefined,
      };

      invoices.forEach((inv, idx) => {
        const slot = idx + 1;
        jobObj[`inv${slot}Amount`] = inv.amount;
        jobObj[`inv${slot}Ref`] = inv.ref;
        jobObj[`inv${slot}SendDate`] = inv.sendDate;
        jobObj[`inv${slot}Days`] = inv.days;
        jobObj[`inv${slot}Status`] = inv.status;
        jobObj[`inv${slot}IsChild`] = !!inv.isChild;
        if (jobType === "Confirmed") {
          jobObj[`inv${slot}OfWhichRechgd`] = inv.ofWhichRechgd || "";
          jobObj[`inv${slot}CostMonth`] = inv.costMonth || "";
        }
      });
      directExpenses.forEach((exp, idx) => {
        const slot = idx + 1;
        jobObj[`dirInv${slot}Amount`] = exp.amount;
        jobObj[`dirInv${slot}Desc`] = exp.desc;
        jobObj[`dirInv${slot}Vat`] = exp.vat;
        jobObj[`dirInv${slot}RecDate`] = exp.recDate;
        jobObj[`dirInv${slot}SendDate`] = exp.recDate;
        jobObj[`dirInv${slot}Days`] = exp.days;
        jobObj[`dirInv${slot}Status`] = exp.status;
      });

      parsed.push(jobObj);
      i = j;
    } else {
      i++;
    }
  }

  parsed.sort((a, b) => {
    const dA = a.startDate ? new Date(a.startDate).getTime() : 0;
    const dB = b.startDate ? new Date(b.startDate).getTime() : 0;
    return (isNaN(dB) ? 0 : dB) - (isNaN(dA) ? 0 : dA);
  });

  return parsed;
}

function findFirstJsonDiff_(a, b, pathStr = "$") {
  if (a === b) return null;
  if (Number.isNaN(a) && Number.isNaN(b)) return null;
  if (typeof a !== typeof b || a === null || b === null) {
    return { path: pathStr, expected: a, actual: b };
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { path: pathStr, expected: a, actual: b };
    if (a.length !== b.length) return { path: `${pathStr}.length`, expected: a.length, actual: b.length };
    for (let i = 0; i < a.length; i++) {
      const diff = findFirstJsonDiff_(a[i], b[i], `${pathStr}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (typeof a === "object") {
    const aKeys = Object.keys(a).filter((k) => k !== "fetchedAt" && k !== "_cachedAt" && k !== "jobsReadMode").sort();
    const bKeys = Object.keys(b).filter((k) => k !== "fetchedAt" && k !== "_cachedAt" && k !== "jobsReadMode").sort();
    const allKeys = [...new Set([...aKeys, ...bKeys])];
    for (const k of allKeys) {
      if (a[k] === undefined && b[k] === undefined) continue;
      const diff = findFirstJsonDiff_(a[k], b[k], `${pathStr}.${k}`);
      if (diff) return diff;
    }
    return null;
  }
  return { path: pathStr, expected: a, actual: b };
}

/**
 * Verifies byte-for-byte JSON parity between legacy grid-parsed job payloads and
 * Phase 2C pure-relational job payloads across both PMA (`handleGetAllClientJobs`,
 * `handleGetInvoiceJobs`, `handleGetDirectCostsJobs`) and Portal (`key-data` jobs).
 */
export async function verifyRelationalJobsReadParity({ clientName = null } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase not configured.");

  let query = supabase
    .from("clients")
    .select("id, client_name, jobs_mode, client_sheet_id, master_sheet_id, metadata")
    .order("client_name", { ascending: true });
  if (clientName) query = query.eq("client_name", clientName);

  const { data: clients, error } = await query;
  if (error) throw new Error(`Failed listing clients: ${error.message}`);

  const { getSheetsClient } = await import("./sheetsClient.js");
  const {
    handleGetAllClientJobs,
    handleGetInvoiceJobs,
    handleGetDirectCostsJobs,
  } = await import("./workspaces.js");
  const { handleGetRetainerJobs } = await import("./retainers.js");
  const sheets = await getSheetsClient();

  const callHandler = async (fn, body) => {
    const resObj = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    await fn({ body }, resObj, sheets);
    return resObj.body;
  };

  const results = [];
  for (const cl of clients || []) {
    try {
      const ctx = await resolveSupabaseSheetContext({ clientName: cl.client_name });
      if (!ctx?.clientId) throw new Error("Missing Supabase client context");

      // Ensure _calcs & tabHeaders exist if not populated yet
      const bundle = await preloadClientRelationalJobsBundle(ctx, { includeConfirmed: true, includePipeline: true });
      const hasHeaders = Boolean(bundle?.tabHeaders?.Confirmed && bundle?.tabHeaders?.Pipeline);
      if (!hasHeaders) {
        await reconcileClientRelationalJobsFromGrids(ctx, ["Confirmed", "Pipeline"], { forceFullUpsert: true });
      }
      const relBundle = hasHeaders
        ? bundle
        : await preloadClientRelationalJobsBundle(ctx, { includeConfirmed: true, includePipeline: true });

      const mismatches = [];

      // 1. PMA handleGetAllClientJobs (All, Confirmed, Pipeline)
      for (const tabName of ["All", "Confirmed", "Pipeline"]) {
        const [gridBody, relBody] = await Promise.all([
          callHandler(handleGetAllClientJobs, { clientSheetId: ctx.clientSheetId, tabName, bypassCache: true, _forceJobsReadMode: "grid" }),
          callHandler(handleGetAllClientJobs, { clientSheetId: ctx.clientSheetId, tabName, bypassCache: true, _forceJobsReadMode: "relational" }),
        ]);
        const d = findFirstJsonDiff_(gridBody, relBody, `pma.allJobs(${tabName})`);
        if (d) mismatches.push(d);
      }

      // 2. PMA Invoice & Direct Costs jobs
      for (const showAll of [true, false]) {
        const [invGrid, invRel, dcGrid, dcRel] = await Promise.all([
          callHandler(handleGetInvoiceJobs, { clientSheetId: ctx.clientSheetId, showAll, bypassCache: true, _forceJobsReadMode: "grid" }),
          callHandler(handleGetInvoiceJobs, { clientSheetId: ctx.clientSheetId, showAll, bypassCache: true, _forceJobsReadMode: "relational" }),
          callHandler(handleGetDirectCostsJobs, { clientSheetId: ctx.clientSheetId, showAll, bypassCache: true, _forceJobsReadMode: "grid" }),
          callHandler(handleGetDirectCostsJobs, { clientSheetId: ctx.clientSheetId, showAll, bypassCache: true, _forceJobsReadMode: "relational" }),
        ]);
        const di = findFirstJsonDiff_(invGrid, invRel, `pma.invoiceJobs(all=${showAll})`);
        if (di) mismatches.push(di);
        const dd = findFirstJsonDiff_(dcGrid, dcRel, `pma.directCostJobs(all=${showAll})`);
        if (dd) mismatches.push(dd);
      }

      // 2b. PMA Retainer jobs
      const [retGrid, retRel] = await Promise.all([
        callHandler(handleGetRetainerJobs, { clientSheetId: ctx.clientSheetId, bypassCache: true, _forceJobsReadMode: "grid" }),
        callHandler(handleGetRetainerJobs, { clientSheetId: ctx.clientSheetId, bypassCache: true, _forceJobsReadMode: "relational" }),
      ]);
      const dr = findFirstJsonDiff_(retGrid, retRel, "pma.retainerJobs");
      if (dr) mismatches.push(dr);

      // 3. Portal key-data Confirmed & Pipeline parsed job payloads (ConfCalcs / PipeCalcs)
      const [confGridRec, pipeGridRec] = await Promise.all([
        getOrLoadVirtualTabGrid_(ctx, "client", "ConfCalcs", sheets, { valuesOnly: true }).catch(() => null),
        getOrLoadVirtualTabGrid_(ctx, "client", "PipeCalcs", sheets, { valuesOnly: true }).catch(() => null),
      ]);
      const confFallback = confGridRec?.values_grid?.length
        ? confGridRec
        : await getOrLoadVirtualTabGrid_(ctx, "client", "Confirmed", sheets, { valuesOnly: true });
      const pipeFallback = pipeGridRec?.values_grid?.length
        ? pipeGridRec
        : await getOrLoadVirtualTabGrid_(ctx, "client", "Pipeline", sheets, { valuesOnly: true });

      const [gridConfDisp, gridPipeDisp] = await Promise.all([
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: ctx.clientSheetId,
          ranges: [
            confGridRec?.values_grid?.length ? "ConfCalcs!A1:JF2500" : "Confirmed!A1:JF2500",
            pipeGridRec?.values_grid?.length ? "PipeCalcs!A1:JF1000" : "Pipeline!A1:JF1000",
          ],
          valueRenderOption: "FORMATTED_VALUE",
        }),
      ]).then(([resp]) => [resp.data?.valueRanges?.[0]?.values || [], resp.data?.valueRanges?.[1]?.values || []]);

      const relConfBuilt = buildRelationalFormattedTabRowsFromBundle(relBundle, "Confirmed", { useCalcsTab: true, maxColLimit: 265 });
      const relPipeBuilt = buildRelationalFormattedTabRowsFromBundle(relBundle, "Pipeline", { useCalcsTab: true, maxColLimit: 265 });

      const isJC = isJobCostingStyle({ headers: (confFallback?.values_grid?.[0] || pipeFallback?.values_grid?.[0] || []) });
      const portalGridConf = parsePortalJobsFromFormattedRows({ rows: gridConfDisp, jobType: "Confirmed", isJobCosting: isJC, relLookup: relBundle.relLookup });
      const portalRelConf = parsePortalJobsFromFormattedRows({ rows: relConfBuilt.rows, jobType: "Confirmed", isJobCosting: isJC, relLookup: relBundle.relLookup });
      const portalGridPipe = parsePortalJobsFromFormattedRows({ rows: gridPipeDisp, jobType: "Pipeline", isJobCosting: isJC, relLookup: relBundle.relLookup });
      const portalRelPipe = parsePortalJobsFromFormattedRows({ rows: relPipeBuilt.rows, jobType: "Pipeline", isJobCosting: isJC, relLookup: relBundle.relLookup });

      const dc = findFirstJsonDiff_(portalGridConf, portalRelConf, "portal.confirmed");
      if (dc) mismatches.push(dc);
      const dp = findFirstJsonDiff_(portalGridPipe, portalRelPipe, "portal.pipeline");
      if (dp) mismatches.push(dp);

      results.push({
        clientName: cl.client_name,
        jobsMode: cl.jobs_mode || "grid",
        jobsReadMode: cl.metadata?.jobs_read_mode || "grid",
        matched: mismatches.length === 0,
        mismatchCount: mismatches.length,
        sampleMismatches: mismatches.slice(0, 5),
        error: null,
      });
    } catch (err) {
      results.push({
        clientName: cl.client_name,
        matched: false,
        mismatchCount: 0,
        sampleMismatches: [],
        error: err.message,
      });
    }
  }

  return {
    success: true,
    checkedAt: new Date().toISOString(),
    clientsChecked: results.length,
    matchedClientsCount: results.filter((r) => r.matched && !r.error).length,
    mismatchClientsCount: results.filter((r) => !r.matched && !r.error).length,
    errorClientsCount: results.filter((r) => Boolean(r.error)).length,
    results,
  };
}

/**
 * Toggles `clients.metadata.jobs_read_mode` between `'grid'` and `'relational'`.
 * Switching to `'relational'` requires `jobs_mode = 'relational'` and verifies
 * 0 JSON payload diffs across both PMA & Portal job readers before cutting over.
 */
export async function setClientJobsReadMode(clientName, jobsReadMode) {
  if (jobsReadMode !== "grid" && jobsReadMode !== "relational") {
    throw new Error("Invalid jobsReadMode. Expected 'grid' or 'relational'.");
  }
  const supabase = getSupabaseAdmin();
  const { data: cl, error: clErr } = await supabase
    .from("clients")
    .select("id, client_name, jobs_mode, grid_storage_retired, metadata, client_sheet_id, master_sheet_id")
    .eq("client_name", clientName)
    .maybeSingle();
  if (clErr || !cl) throw new Error(`Client "${clientName}" not found.`);
  if (cl.grid_storage_retired && jobsReadMode !== "relational") {
    throw new Error(
      `Client "${clientName}" has retired grid storage and cannot be downgraded from 'relational' jobs_read_mode.`
    );
  }

  if (jobsReadMode === "relational" && !cl.grid_storage_retired) {
    if (String(cl.jobs_mode || cl.metadata?.jobs_mode || "grid").toLowerCase() !== "relational") {
      throw new Error(`Client "${cl.client_name}" must be in relational jobs_mode before enabling direct relational reads.`);
    }
    const ctx = await resolveSupabaseSheetContext({ clientName: cl.client_name });
    await reconcileClientRelationalJobsFromGrids(ctx, ["Confirmed", "Pipeline"], { forceFullUpsert: true });
    const parity = await verifyRelationalJobsReadParity({ clientName: cl.client_name });
    const rec = parity.results?.[0];
    if (!rec || rec.error || !rec.matched) {
      throw new Error(
        `Read parity check failed for ${cl.client_name}: ${rec?.error || JSON.stringify(rec?.sampleMismatches || [])}`
      );
    }
  }

  const nextMeta = {
    ...(cl.metadata && typeof cl.metadata === "object" ? cl.metadata : {}),
    jobs_read_mode: jobsReadMode,
  };
  let { error: updErr } = await supabase
    .from("clients")
    .update({ jobs_read_mode: jobsReadMode, metadata: nextMeta })
    .eq("id", cl.id);
  if (updErr && String(updErr.message || "").includes("jobs_read_mode")) {
    ({ error: updErr } = await supabase
      .from("clients")
      .update({ metadata: nextMeta })
      .eq("id", cl.id));
  }
  if (updErr) throw new Error(`Failed updating jobs_read_mode: ${updErr.message}`);

  invalidateSheetContextCache();
  if (cl.client_sheet_id) {
    await invalidatePmaClientCache(cl.client_sheet_id, cl.master_sheet_id || null, ["jobs", "invoices", "retainers", "views"]).catch(() => { });
    if (redisClient?.isOpen) {
      await redisClient
        .del([
          `pulse:portal:payload:${cl.client_sheet_id}`,
          `pulse:portal:keydata:${cl.client_sheet_id}:all`,
          `pulse:portal:keydata:${cl.client_sheet_id}:jobs`,
          `pulse:pma:jobs:${cl.client_sheet_id}:All`,
          `pulse:pma:jobs:${cl.client_sheet_id}:Confirmed`,
          `pulse:pma:jobs:${cl.client_sheet_id}:Pipeline`,
          `pulse:pma:invoice_jobs:${cl.client_sheet_id}:all`,
          `pulse:pma:invoice_jobs:${cl.client_sheet_id}:active`,
          `pulse:pma:direct_costs_jobs:${cl.client_sheet_id}:all`,
          `pulse:pma:direct_costs_jobs:${cl.client_sheet_id}:active`,
          `pulse:pma:retainer_jobs:${cl.client_sheet_id}`,
        ])
        .catch(() => { });
    }
  }

  return {
    success: true,
    clientName: cl.client_name,
    jobsReadMode,
  };
}
