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
  isVirtualSupabaseSheetId,
} from "./masterEngineService.js";
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

async function fetchAllRowsForClient_(supabase, tableName, clientId) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(tableName)
      .select("*")
      .eq("client_id", clientId)
      .range(from, from + 999);
    if (error) throw new Error(`${tableName} read failed: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
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

  const supabase = getSupabaseAdmin();
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) {
    throw new Error(`Client "${clientName}" was not found in Supabase.`);
  }

  const [confGrid, pipeGrid, existingSeries, existingJobs, existingInvs, existingExps, accInvsResp, accDirectResp] =
    await Promise.all([
      getOrLoadVirtualTabGrid_(ctx, "client", "Confirmed", null, { includeNotes: true }),
      getOrLoadVirtualTabGrid_(ctx, "client", "Pipeline", null, { includeNotes: true }),
      fetchAllRowsForClient_(supabase, "pulse_retainer_series", ctx.clientId),
      fetchAllRowsForClient_(supabase, "pulse_jobs", ctx.clientId),
      fetchAllRowsForClient_(supabase, "pulse_job_invoices", ctx.clientId),
      fetchAllRowsForClient_(supabase, "pulse_job_expenses", ctx.clientId),
      supabase.from("accounting_invoices").select("id, invoice_number, external_id").eq("client_id", ctx.clientId),
      supabase.from("accounting_direct_costs").select("id, external_id").eq("client_id", ctx.clientId),
    ]);

  const accInvByRef = new Map();
  for (const r of accInvsResp.data || []) {
    const refK = normalizeTextKey_(r.invoice_number);
    if (refK && !accInvByRef.has(refK)) accInvByRef.set(refK, r.id);
  }
  const accCostByExtId = new Map();
  for (const r of accDirectResp.data || []) {
    const extK = normalizeTextKey_(r.external_id);
    if (extK && !accCostByExtId.has(extK)) accCostByExtId.set(extK, r.id);
  }

  const models = [
    parseTabGridToRelationalModel({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      tabName: "Confirmed",
      valuesGrid: confGrid?.values_grid || [],
      formulasGrid: confGrid?.formulas_grid || [],
      notesGrid: confGrid?.notes_grid || {},
    }),
    parseTabGridToRelationalModel({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      tabName: "Pipeline",
      valuesGrid: pipeGrid?.values_grid || [],
      formulasGrid: pipeGrid?.formulas_grid || [],
      notesGrid: pipeGrid?.notes_grid || {},
    }),
  ];

  // Reconcile Retainer Series (preserving existing UUIDs by tab_type + series_key)
  const existingSeriesMap = new Map(existingSeries.map((s) => [`${s.tab_type}::${s.series_key}`, s]));
  const desiredSeriesKeys = new Set();
  const seriesIdByTabAndKey = new Map();
  const seriesUpserts = [];

  for (const mod of models) {
    for (const s of mod.retainerSeries) {
      const k = `${s.tab_type}::${s.series_key}`;
      desiredSeriesKeys.add(k);
      const prev = existingSeriesMap.get(k);
      if (prev) seriesIdByTabAndKey.set(k, prev.id);
      seriesUpserts.push({
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
      });
    }
  }

  if (seriesUpserts.length > 0) {
    const { data: upsertedSeries, error: serErr } = await supabase
      .from("pulse_retainer_series")
      .upsert(seriesUpserts, { onConflict: "client_id,tab_type,series_key" })
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

  // Reconcile Jobs (matching by project_code first, then exact row+customer+job, then row_num)
  const existingJobsByTab = {
    confirmed: existingJobs.filter((j) => j.tab_type === "confirmed"),
    pipeline: existingJobs.filter((j) => j.tab_type === "pipeline"),
  };
  const usedExistingJobIds = new Set();
  const jobPayloads = [];
  const plannedJobsMeta = [];

  for (const mod of models) {
    const pool = existingJobsByTab[mod.tabType] || [];
    const byProjectCode = new Map();
    const byIdentityKey = new Map();
    const byRowNum = new Map();
    for (const ej of pool) {
      if (ej.project_code && !byProjectCode.has(normalizeTextKey_(ej.project_code))) {
        byProjectCode.set(normalizeTextKey_(ej.project_code), ej);
      }
      const ik = makeJobIdentityKey_(ej);
      if (!byIdentityKey.has(ik)) byIdentityKey.set(ik, ej);
      if (!byRowNum.has(ej.sheet_row_num)) byRowNum.set(ej.sheet_row_num, ej);
    }

    for (const j of mod.jobs) {
      let matched = null;
      const pcK = normalizeTextKey_(j.project_code);
      if (pcK && byProjectCode.has(pcK) && !usedExistingJobIds.has(byProjectCode.get(pcK).id)) {
        matched = byProjectCode.get(pcK);
      }
      if (!matched) {
        const ik = makeJobIdentityKey_(j);
        if (byIdentityKey.has(ik) && !usedExistingJobIds.has(byIdentityKey.get(ik).id)) {
          matched = byIdentityKey.get(ik);
        }
      }
      if (!matched && byRowNum.has(j.sheet_row_num) && !usedExistingJobIds.has(byRowNum.get(j.sheet_row_num).id)) {
        matched = byRowNum.get(j.sheet_row_num);
      }

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
      jobPayloads.push(rowPayload);
      plannedJobsMeta.push({ sourceJob: j, matchedId: matched?.id || null });
    }
  }

  const obsoleteJobIds = existingJobs.filter((ej) => !usedExistingJobIds.has(ej.id)).map((ej) => ej.id);
  for (let i = 0; i < obsoleteJobIds.length; i += 200) {
    await supabase.from("pulse_jobs").delete().in("id", obsoleteJobIds.slice(i, i + 200));
  }

  const updateJobPayloads = jobPayloads.filter((p) => p.id);
  const insertJobPayloads = jobPayloads.filter((p) => !p.id);

  for (let i = 0; i < updateJobPayloads.length; i += 200) {
    const chunk = updateJobPayloads.slice(i, i + 200);
    const { error: upErr } = await supabase.from("pulse_jobs").upsert(chunk, { onConflict: "id" });
    if (upErr) throw new Error(`Failed updating pulse_jobs: ${upErr.message}`);
  }

  let insertedJobs = [];
  for (let i = 0; i < insertJobPayloads.length; i += 200) {
    const chunk = insertJobPayloads.slice(i, i + 200);
    const { data: insData, error: insErr } = await supabase
      .from("pulse_jobs")
      .insert(chunk)
      .select("id, tab_type, sheet_row_num");
    if (insErr) throw new Error(`Failed inserting pulse_jobs: ${insErr.message}`);
    insertedJobs = insertedJobs.concat(insData || []);
  }

  const jobIdByTabAndRow = new Map();
  for (const p of updateJobPayloads) jobIdByTabAndRow.set(`${p.tab_type}:${p.sheet_row_num}`, p.id);
  for (const p of insertedJobs) jobIdByTabAndRow.set(`${p.tab_type}:${p.sheet_row_num}`, p.id);

  // Reconcile Invoices & Expenses for all jobs (preserving IDs per job + row_offset + slot_index)
  const existingInvByJobSlot = new Map(
    existingInvs.map((inv) => [`${inv.job_id}:${inv.row_offset}:${inv.slot_index}`, inv.id])
  );
  const existingExpByJobSlot = new Map(
    existingExps.map((exp) => [`${exp.job_id}:${exp.row_offset}:${exp.slot_index}`, exp.id])
  );

  const desiredInvIds = new Set();
  const invUpserts = [];
  const invInserts = [];
  const desiredExpIds = new Set();
  const expUpserts = [];
  const expInserts = [];

  for (const { sourceJob } of plannedJobsMeta) {
    const jobId = jobIdByTabAndRow.get(`${sourceJob.tab_type}:${sourceJob.sheet_row_num}`);
    if (!jobId) continue;

    for (const inv of sourceJob.invoices) {
      const existingId = existingInvByJobSlot.get(`${jobId}:${inv.row_offset}:${inv.slot_index}`) || null;
      if (existingId) desiredInvIds.add(existingId);
      const refK = normalizeTextKey_(inv.invoice_ref);
      const rec = {
        ...(existingId ? { id: existingId } : {}),
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        job_id: jobId,
        accounting_invoice_id: refK ? accInvByRef.get(refK) || null : null,
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
      if (existingId) invUpserts.push(rec);
      else invInserts.push(rec);
    }

    for (const exp of sourceJob.expenses) {
      const existingId = existingExpByJobSlot.get(`${jobId}:${exp.row_offset}:${exp.slot_index}`) || null;
      if (existingId) desiredExpIds.add(existingId);
      const extK = normalizeTextKey_(exp.external_app_id);
      const rec = {
        ...(existingId ? { id: existingId } : {}),
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        job_id: jobId,
        accounting_direct_cost_id: extK ? accCostByExtId.get(extK) || null : null,
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
      if (existingId) expUpserts.push(rec);
      else expInserts.push(rec);
    }
  }

  const obsoleteInvIds = existingInvs.filter((r) => !desiredInvIds.has(r.id)).map((r) => r.id);
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

  const obsoleteExpIds = existingExps.filter((r) => !desiredExpIds.has(r.id)).map((r) => r.id);
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

  const summary = {
    clientName: ctx.clientName,
    lastBackfilledAt: new Date().toISOString(),
    confirmedJobsCount: models[0].jobs.length,
    pipelineJobsCount: models[1].jobs.length,
    retainerSeriesCount: seriesUpserts.length,
    invoicesCount: invUpserts.length + invInserts.length,
    expensesCount: expUpserts.length + expInserts.length,
  };

  const { data: clRow } = await supabase.from("clients").select("metadata").eq("id", ctx.clientId).maybeSingle();
  const nextMeta = {
    ...(clRow?.metadata && typeof clRow.metadata === "object" ? clRow.metadata : {}),
    relational_jobs_state: summary,
  };
  await supabase.from("clients").update({ metadata: nextMeta }).eq("id", ctx.clientId);

  return summary;
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

  return {
    success: true,
    clientName: cl.client_name,
    jobsMode,
    backfillSummary,
    hasRealClientSheet: Boolean(cl.client_sheet_id && !isVirtualSupabaseSheetId(cl.client_sheet_id)),
  };
}
