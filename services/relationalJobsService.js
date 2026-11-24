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
import {
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
      for (const c of [37, 38, 39]) {
        if (isNonEmptyCell_(vRow[c]) || isFormulaStr_(fRow[c])) return true;
      }
    }
  }

  return false;
}

/**
 * Determines if an active contiguous row directly below an existing job is an invoice/expense overflow child row.
 */
function isOverflowChildRow_(vRow, fRow, parentJob, { tabName, isJobCosting }) {
  if (!parentJob) return false;
  if (vRow[30] && parseVariableRetainerTag(vRow[30])) return false;

  const rClient = normalizeTextKey_(vRow[0]);
  const rJob = normalizeTextKey_(vRow[1]);
  const pClient = normalizeTextKey_(parentJob.customer_name);
  const pJob = normalizeTextKey_(parentJob.job_name);

  const identityMatchesParent =
    (rClient === "" && rJob === "") || (rClient === pClient && rJob === pJob);
  if (!identityMatchesParent) return false;

  const revCalcStart = tabName === "Confirmed" ? 62 : 60;
  const hasInvoicesOrExpenses =
    hasAnyPopulatedInRange_(vRow, fRow, null, 41, revCalcStart) ||
    hasAnyPopulatedInRange_(vRow, fRow, null, 75, 96);

  if (isJobCosting) {
    const revEmpty =
      (!isNonEmptyCell_(vRow[8]) || parseNumericOrDefault_(vRow[8], 0) === 0) &&
      !isFormulaStr_(fRow[8]);
    const jcDatesEmpty = !isNonEmptyCell_(vRow[5]) && !isNonEmptyCell_(vRow[6]);
    const rechEmpty = !isNonEmptyCell_(vRow[17]) || parseNumericOrDefault_(vRow[17], 0) === 0;
    const revFormulaSafe = !isNonEmptyCell_(vRow[32]);
    return revEmpty && jcDatesEmpty && rechEmpty && revFormulaSafe && (hasInvoicesOrExpenses || rClient === "");
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

function captureNonSlotRowIntoJob_(vRow, fRow, rowNotes, job, { tabName, rowOffset }) {
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
}) {
  const tabType = tabName === "Pipeline" ? "pipeline" : "confirmed";
  const headerRow = Array.isArray(valuesGrid[0]) ? valuesGrid[0] : [];
  const isJobCosting = isJobCostingStyle({ headers: headerRow });
  const notesByRow = parseNotesByRowCol_(notesGrid);

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
      isOverflowChildRow_(vRow, fRow, currentJob, { tabName, isJobCosting })
    ) {
      const childOffset = r + 1 - currentJob.sheet_row_num;
      currentJob.sheet_child_row_count = Math.max(currentJob.sheet_child_row_count, childOffset);
      captureNonSlotRowIntoJob_(vRow, fRow, rowNotes, currentJob, { tabName, rowOffset: childOffset });

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

    captureNonSlotRowIntoJob_(vRow, fRow, rowNotes, jobObj, { tabName, rowOffset: 0 });
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
  for (const c of clientsData || []) {
    if (c?.metadata?.relational_jobs_state?.lastBackfilledAt) backfilledClientsCount++;
    if ((c?.jobs_mode || c?.metadata?.jobs_mode) === "relational") relationalModeClientsCount++;
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
  };
}

function makeJobIdentityKey_(job) {
  if (job.project_code) return `pc:${normalizeTextKey_(job.project_code)}`;
  return `row:${job.sheet_row_num}|${normalizeTextKey_(job.customer_name)}|${normalizeTextKey_(job.job_name)}`;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _inFlightReconcileByClient = new Map();
const _pendingReconcileTabsByClient = new Map();

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
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from(tableName)
      .select(selectCols)
      .eq("client_id", clientId)
      .range(from, from + 999);
    if (tabType) q = q.eq("tab_type", tabType);
    const { data, error } = await q;
    if (error) throw new Error(`${tableName} read failed: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function fetchChildRowsForJobIds_(supabase, tableName, clientId, jobIds, selectCols = "*") {
  if (!Array.isArray(jobIds) || jobIds.length === 0) return [];
  const out = [];
  for (let i = 0; i < jobIds.length; i += 200) {
    const chunk = jobIds.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from(tableName)
        .select(selectCols)
        .eq("client_id", clientId)
        .in("job_id", chunk)
        .range(from, from + 999);
      if (error) throw new Error(`${tableName} read failed: ${error.message}`);
      if (!Array.isArray(data) || data.length === 0) break;
      out.push(...data);
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
  if (rowHit && !usedExistingJobIds.has(rowHit.id)) return rowHit;

  return null;
}

async function syncPulseNotesJobIdsForClient_(supabase, clientId) {
  const [{ data: notes }, { data: jobs }] = await Promise.all([
    supabase
      .from("pulse_notes")
      .select("id, entity_type, entity_key, parent_entity_key, job_id")
      .eq("client_id", clientId)
      .is("deleted_at", null)
      .in("entity_type", ["job", "invoice", "job_expense"])
      .limit(1000),
    supabase
      .from("pulse_jobs")
      .select("id, tab_type, sheet_row_num, customer_name, job_name, project_code")
      .eq("client_id", clientId)
      .limit(2000),
  ]);
  if (!Array.isArray(notes) || notes.length === 0 || !Array.isArray(jobs) || jobs.length === 0) return;

  const jobIdByNoteKey = new Map();
  // Sort so pipeline writes first and confirmed overrides on matching keys
  const orderedJobs = [...jobs].sort((a, b) => {
    if (a.tab_type === b.tab_type) return (a.sheet_row_num || 0) - (b.sheet_row_num || 0);
    return a.tab_type === "pipeline" ? -1 : 1;
  });
  for (const j of orderedJobs) {
    const key = buildJobNoteKey({
      client: j.customer_name,
      jobName: j.job_name,
      projectCode: j.project_code,
      rowNumber: j.sheet_row_num,
    });
    if (key) jobIdByNoteKey.set(key, j.id);
    if (!j.project_code && j.customer_name && j.job_name) {
      const altKey = buildJobNoteKey({ client: j.customer_name, jobName: j.job_name });
      if (altKey) jobIdByNoteKey.set(altKey, j.id);
    }
  }

  const updates = [];
  for (const n of notes) {
    const lookupKey = n.entity_type === "job" ? n.entity_key : n.parent_entity_key;
    if (!lookupKey) continue;
    const matchedJobId = jobIdByNoteKey.get(lookupKey) || null;
    if (matchedJobId && n.job_id !== matchedJobId) {
      updates.push(supabase.from("pulse_notes").update({ job_id: matchedJobId }).eq("id", n.id));
    }
  }
  if (updates.length > 0) {
    await Promise.all(updates.map((p) => p.catch(() => { })));
  }
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

  const [gridsList, existingSeries, existingJobs, clMetaResp] = await Promise.all([
    Promise.all(gridPromises),
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
    const [accInvsResp, accDirectResp] = await Promise.all([
      missingInvLookup && neededInvRefs.size > 0
        ? supabase.from("accounting_invoices").select("id, invoice_number").eq("client_id", ctx.clientId)
        : Promise.resolve({ data: [] }),
      missingExpLookup && neededExpAppIds.size > 0
        ? supabase.from("accounting_direct_costs").select("id, external_id").eq("client_id", ctx.clientId)
        : Promise.resolve({ data: [] }),
    ]);
    for (const r of accInvsResp.data || []) {
      const refK = normalizeTextKey_(r.invoice_number);
      if (refK) accInvFkByRef.set(refK, r.id);
    }
    for (const r of accDirectResp.data || []) {
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
  if (obsoleteSeriesIds.length > 0) {
    await supabase.from("pulse_retainer_series").delete().in("id", obsoleteSeriesIds);
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
          updateJobPayloads.push(rowPayload);
        }
      } else {
        insertJobPayloads.push(rowPayload);
      }
      plannedJobsMeta.push({ sourceJob: j, matchedId: matched?.id || null });
    }
  }

  const obsoleteJobIds = existingJobs.filter((ej) => !usedExistingJobIds.has(ej.id)).map((ej) => ej.id);
  for (let i = 0; i < obsoleteJobIds.length; i += 200) {
    await supabase.from("pulse_jobs").delete().in("id", obsoleteJobIds.slice(i, i + 200));
  }

  for (let i = 0; i < updateJobPayloads.length; i += 200) {
    const { error: upErr } = await supabase
      .from("pulse_jobs")
      .upsert(updateJobPayloads.slice(i, i + 200), { onConflict: "id" });
    if (upErr) throw new Error(`Failed updating pulse_jobs: ${upErr.message}`);
  }

  for (let i = 0; i < insertJobPayloads.length; i += 200) {
    const { data: insData, error: insErr } = await supabase
      .from("pulse_jobs")
      .insert(insertJobPayloads.slice(i, i + 200))
      .select("id, tab_type, sheet_row_num");
    if (insErr) throw new Error(`Failed inserting pulse_jobs: ${insErr.message}`);
    for (const r of insData || []) {
      jobIdByTabAndRow.set(`${r.tab_type}:${r.sheet_row_num}`, r.id);
    }
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
    await supabase.from("pulse_job_invoices").delete().in("id", obsoleteInvIds.slice(i, i + 200));
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
    await supabase.from("pulse_job_expenses").delete().in("id", obsoleteExpIds.slice(i, i + 200));
  }
  for (let i = 0; i < expUpserts.length; i += 200) {
    const { error: e } = await supabase.from("pulse_job_expenses").upsert(expUpserts.slice(i, i + 200), { onConflict: "id" });
    if (e) throw new Error(`Failed updating pulse_job_expenses: ${e.message}`);
  }
  for (let i = 0; i < expInserts.length; i += 200) {
    const { error: e } = await supabase.from("pulse_job_expenses").insert(expInserts.slice(i, i + 200));
    if (e) throw new Error(`Failed inserting pulse_job_expenses: ${e.message}`);
  }

  // Keep pulse_notes.job_id synchronized with live pulse_jobs UUIDs
  await syncPulseNotesJobIdsForClient_(supabase, ctx.clientId).catch(() => { });

  const prevMeta = clMetaResp?.data?.metadata && typeof clMetaResp.data.metadata === "object" ? clMetaResp.data.metadata : {};
  const prevState = prevMeta.relational_jobs_state && typeof prevMeta.relational_jobs_state === "object" ? prevMeta.relational_jobs_state : {};
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
    deltaStats: {
      jobsUpdated: updateJobPayloads.length,
      jobsInserted: insertJobPayloads.length,
      jobsDeleted: obsoleteJobIds.length,
      invoicesMutated: invUpserts.length + invInserts.length + obsoleteInvIds.length,
      expensesMutated: expUpserts.length + expInserts.length + obsoleteExpIds.length,
    },
  };

  await supabase
    .from("clients")
    .update({
      metadata: {
        ...prevMeta,
        relational_jobs_state: summary,
      },
    })
    .eq("id", ctx.clientId);

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
  pendingEntry.opts = { ...pendingEntry.opts, ...options };
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
  const cols = schema.schemaReady ? "id, client_name, jobs_mode, metadata" : "id, client_name, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  const { data: clients, error } = await query;
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    try {
      const ctx = { clientId: cl.id, clientName: cl.client_name };
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
    .select("id, client_name, metadata, client_sheet_id")
    .eq("client_name", clientName)
    .maybeSingle();
  if (clErr || !cl) throw new Error(`Client "${clientName}" not found.`);

  let backfillSummary = null;
  if (jobsMode === "relational") {
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
