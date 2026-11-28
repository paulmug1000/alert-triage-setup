/**
 * ============================================================================
 * PULSE PHASE 3 — RELATIONAL OPERATING INPUTS ENGINE
 * ============================================================================
 * Lossless two-way conversion, UUID-preserving reconciliation, backfill,
 * and parity verification between legacy Client Sheet virtual grids
 * (`Salaries`, `Outgoings`, `OutgNotes`, `NBtoFind`, `Budget`, `Cash`) +
 * `system_config` (`cash_bank_breakdowns:*`) and normalized SQL tables:
 *   - `public.pulse_employees`
 *   - `public.pulse_outgoing_items`
 *   - `public.pulse_contractor_entries`
 *   - `public.pulse_nb_to_find`
 *   - `public.pulse_budget_items`
 *   - `public.pulse_cash_adjustments`
 *   - `public.pulse_cash_bank_balances`
 * ============================================================================
 */

import fs from "fs";
import path from "path";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import {
  getOrLoadVirtualTabGrid_,
  resolveSupabaseSheetContext,
  invalidateSheetContextCache,
} from "./masterEngineService.js";
import { getClientCashBankBreakdowns } from "./cashBankBreakdownService.js";
import { formatCellForDisplay } from "./gasRuntime/sheetValueUtils.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import { redisClient } from "./redisClient.js";
import { isCashCellEditable, isPlaceholderExpense, toSheetDateFormat } from "../utils/helpers.js";
import {
  buildContractorBillNoteKey,
  buildContractorRowNoteKey,
  buildDividendRowNoteKey,
  buildEmployeeNoteKey,
  buildOutgoingRowNoteKey,
} from "../utils/pulseNotesKeys.js";

if (typeof window !== "undefined") {
  throw new Error("SECURITY VIOLATION: services/relationalInputsService.js must never run in browser code.");
}

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_NAMES_3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export const PHASE3_INPUT_TABLES = [
  { name: "pulse_employees", label: "Employees (Salaries)" },
  { name: "pulse_outgoing_items", label: "Outgoing items (Contractors, Dividends, Expenses)" },
  { name: "pulse_contractor_entries", label: "Contractor bill & placeholder blocks (OutgNotes)" },
  { name: "pulse_nb_to_find", label: "NB to find targets & rollups" },
  { name: "pulse_budget_items", label: "Budget forecast lines" },
  { name: "pulse_cash_adjustments", label: "Cashflow manual overrides & notes" },
  { name: "pulse_cash_bank_balances", label: "Monthly per-bank closing balances" },
];

const YEAR_MONTH_BANDS = [
  { fyIndex: 1, startCol: 6, count: 12, totalCol: 19 },
  { fyIndex: 2, startCol: 21, count: 12, totalCol: 34 },
  { fyIndex: 3, startCol: 36, count: 12, totalCol: 49 },
];

const MONTHLY_48_COLS = [];
for (const b of YEAR_MONTH_BANDS) {
  for (let i = 0; i < b.count; i++) MONTHLY_48_COLS.push(b.startCol + i);
}
const MONTHLY_48_COL_SET = new Set(MONTHLY_48_COLS);
const OUTGOINGS_TOTAL_COLS = [19, 34, 49];

const NBTF_SETTING_ROWS0 = [8, 11, 20]; // A9, A12, A21
const NBTF_EDITABLE_ROWS0 = new Set([2, 4, 9, 11, 19, 24]); // Rows 3, 5, 10, 12, 20, 25
const NBTF_ROLLUP_ROWS0 = [0, 2, 4, 8, 9, 11, 13, 17, 19, 20, 22, 24];

const BUDGET_ROW_SECTIONS = [];
for (let r = 5; r <= 9; r++) BUDGET_ROW_SECTIONS.push({ rowNum: r, section: "revenue" });
for (let r = 21; r <= 25; r++) BUDGET_ROW_SECTIONS.push({ rowNum: r, section: "revenue" });
for (let r = 13; r <= 17; r++) BUDGET_ROW_SECTIONS.push({ rowNum: r, section: "direct_cost" });
for (let r = 58; r <= 112; r++) BUDGET_ROW_SECTIONS.push({ rowNum: r, section: "salary" });
for (let r = 118; r <= 120; r++) BUDGET_ROW_SECTIONS.push({ rowNum: r, section: "dividend" });
for (let r = 126; r <= 141; r++) BUDGET_ROW_SECTIONS.push({ rowNum: r, section: "contractor" });
BUDGET_ROW_SECTIONS.push({ rowNum: 142, section: "making_up_cos" });
BUDGET_ROW_SECTIONS.push({ rowNum: 143, section: "contractor" });
for (let r = 149; r <= 251; r++) BUDGET_ROW_SECTIONS.push({ rowNum: r, section: "expense" });
const BUDGET_SECTION_BY_ROW = new Map(BUDGET_ROW_SECTIONS.map((x) => [x.rowNum, x.section]));

const _inFlightInputReconcileByClient = new Map();
const _pendingInputReconcileByClient = new Map();
let _cachedMigration0013Sql = null;

/**
 * Reads migration 0013 SQL from disk once so PMA > DB can offer 1-click copy.
 */
export function readMigration0013Sql() {
  if (_cachedMigration0013Sql !== null) return _cachedMigration0013Sql;
  try {
    const p = path.join(process.cwd(), "supabase", "migrations", "0013_phase3_operating_inputs.sql");
    _cachedMigration0013Sql = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  } catch {
    _cachedMigration0013Sql = "";
  }
  return _cachedMigration0013Sql;
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
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return fallback;
  return pct ? n / 100 : n;
}

function parseNullableNumeric_(val) {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  const s = String(val).trim();
  if (!s) return null;
  const pct = s.endsWith("%");
  const cleaned = s.replace(/[£$€,\s%]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

function parseDeliveryFraction_(val, defaultVal = 0) {
  if (val === undefined || val === null || val === "") return defaultVal;
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return defaultVal;
    return val > 1 && val <= 100 ? val / 100 : val;
  }
  const s = String(val).trim();
  if (!s) return defaultVal;
  const hasPct = s.includes("%");
  const n = Number(s.replace(/[£$€,\s%]/g, ""));
  if (!Number.isFinite(n)) return defaultVal;
  return hasPct || (n > 1 && n <= 100) ? n / 100 : n;
}

function parseDateText_(val) {
  if (val === undefined || val === null || val === "") return "";
  if (typeof val === "number" && Number.isFinite(val) && val > 25000 && val < 90000) {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!Number.isNaN(d.getTime())) {
      return toSheetDateFormat(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
  }
  return String(val).trim();
}

function parseHeaderYearMonth_(val) {
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
  const iso = s.match(/^(\d{4})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}`;
  const m = s.match(/([A-Za-z]{3})[a-z]*[\s\-']*(\d{2,4})$/);
  if (m) {
    const mi = MONTH_NAMES_3.indexOf(m[1].toLowerCase());
    if (mi >= 0) {
      let yr = parseInt(m[2], 10);
      if (yr < 100) yr += yr <= 69 ? 2000 : 1900;
      return `${yr}-${String(mi + 1).padStart(2, "0")}`;
    }
  }
  return "";
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

function trimTrailingEmptyGridCells_(row) {
  if (!Array.isArray(row)) return [];
  let last = row.length - 1;
  while (last >= 0 && (row[last] === "" || row[last] === undefined || row[last] === null)) {
    last--;
  }
  return last < 0 ? [] : row.slice(0, last + 1);
}

function writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c0, val, formulaStr, fgOverride, noteStr) {
  while (valuesGrid.length <= r0) valuesGrid.push([]);
  while (formulasGrid.length <= r0) formulasGrid.push([]);
  while (valuesGrid[r0].length <= c0) valuesGrid[r0].push("");
  while (formulasGrid[r0].length <= c0) formulasGrid[r0].push("");

  valuesGrid[r0][c0] = val !== undefined && val !== null ? val : "";
  if (isFormulaStr_(formulaStr)) {
    formulasGrid[r0][c0] = formulaStr;
  } else if (fgOverride !== undefined) {
    formulasGrid[r0][c0] = fgOverride;
  } else {
    formulasGrid[r0][c0] = val !== undefined && val !== null ? val : "";
  }

  if (noteStr) {
    notesGrid[`${r0}:${c0}`] = noteStr;
  }
}

function resolveOutgoingsFyInfo_(colIdx) {
  for (const b of YEAR_MONTH_BANDS) {
    if (colIdx >= b.startCol && colIdx < b.startCol + b.count) {
      return { fyIndex: b.fyIndex, monthIndex: colIdx - b.startCol };
    }
  }
  return { fyIndex: 1, monthIndex: 0 };
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

function numbersEqualLoose_(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  if (b === null || b === undefined || b === "") return false;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return String(a) === String(b);
  return Math.abs(na - nb) < 0.0001;
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

async function fetchAllRowsForClient_(supabase, tableName, clientId, { selectCols = "*" } = {}) {
  const out = [];
  const seenIds = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(tableName)
      .select(selectCols)
      .eq("client_id", clientId)
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
  return out;
}

// ============================================================================
// 1. SALARIES (`pulse_employees`) PARSER & PROJECTOR
// ============================================================================

export function parseSalariesTabToEmployees({
  clientId,
  clientName,
  valuesGrid = [],
  formulasGrid = [],
  notesGrid = {},
}) {
  const notesByRow = parseNotesByRowCol_(notesGrid);
  const employees = [];
  const headerLen = Array.isArray(valuesGrid[0]) ? valuesGrid[0].length : 0;

  for (let r0 = 3; r0 <= 52; r0++) {
    const vRow = Array.isArray(valuesGrid[r0]) ? valuesGrid[r0] : [];
    const fRow = Array.isArray(formulasGrid[r0]) ? formulasGrid[r0] : [];
    const rowNotes = notesByRow.get(r0) || new Map();
    const maxC = Math.max(8, vRow.length - 1, fRow.length - 1, headerLen - 1);

    let populated = rowNotes.size > 0;
    if (!populated) {
      for (let c = 0; c <= 8; c++) {
        if (isNonEmptyCell_(vRow[c]) || isFormulaStr_(fRow[c])) {
          populated = true;
          break;
        }
      }
    }
    if (!populated) {
      for (let c = 11; c <= maxC; c++) {
        if (isNonEmptyCell_(vRow[c]) || isFormulaStr_(fRow[c])) {
          populated = true;
          break;
        }
      }
    }
    if (!populated) continue;

    const rawScalars = {};
    const monthlyOverrides = {};
    const customFormulas = {};
    const cellNotes = {};

    for (let c = 0; c <= maxC; c++) {
      if (c === 9 || c === 10) continue; // J..K are template formula/spacer columns
      const val = vRow[c];
      const f = fRow[c];
      if (isFormulaStr_(f)) {
        customFormulas[String(c)] = f;
      }
      if (isNonEmptyCell_(val) || isFormulaStr_(f)) {
        if (c <= 8) {
          rawScalars[String(c)] = val !== undefined && val !== null ? val : "";
        } else if (c >= 11) {
          monthlyOverrides[String(c)] = val !== undefined && val !== null ? val : "";
        }
      }
    }

    for (const [cIdx, nStr] of rowNotes.entries()) {
      cellNotes[String(cIdx)] = nStr;
    }

    // Reconciled calculated forecast (rows 154..203) & effective (rows 304..353)
    // Note: monthly_effective captures c >= 0 so Salaries!A304:JC368 is 100% preserved.
    const monthlyForecasts = {};
    const monthlyEffective = {};
    const fcRow = Array.isArray(valuesGrid[r0 + 150]) ? valuesGrid[r0 + 150] : [];
    const effRow = Array.isArray(valuesGrid[r0 + 300]) ? valuesGrid[r0 + 300] : [];
    for (let c = 0; c < Math.max(fcRow.length, effRow.length); c++) {
      if (c >= 11 && isNonEmptyCell_(fcRow[c])) monthlyForecasts[String(c)] = fcRow[c];
      if (isNonEmptyCell_(effRow[c])) monthlyEffective[String(c)] = effRow[c];
    }

    employees.push({
      client_id: clientId,
      client_name: clientName,
      sort_order: employees.length,
      sheet_row_num: r0 + 1,
      employee_name: String(vRow[0] ?? "").trim(),
      role_title: String(vRow[1] ?? "").trim(),
      fte_salary: parseNumericOrDefault_(vRow[2], 0),
      fte: parseNumericOrDefault_(vRow[3], 1),
      start_date: parseDateText_(vRow[4]),
      end_date: parseDateText_(vRow[5]),
      delivery_pct: parseDeliveryFraction_(vRow[6], 0),
      student_loan_plan: String(vRow[7] ?? "").trim(),
      pension_pct: String(vRow[8] ?? "").trim(),
      monthly_overrides: monthlyOverrides,
      monthly_forecasts: monthlyForecasts,
      monthly_effective: monthlyEffective,
      raw_scalars: rawScalars,
      custom_formulas: customFormulas,
      cell_notes: cellNotes,
    });
  }

  return employees;
}

export function projectEmployeesToSalariesGrid({
  employees = [],
  baseValuesGrid = [],
  baseFormulasGrid = [],
  baseNotesGrid = {},
}) {
  const valuesGrid = (Array.isArray(baseValuesGrid) ? baseValuesGrid : []).map((r) => (Array.isArray(r) ? [...r] : []));
  const formulasGrid = (Array.isArray(baseFormulasGrid) && baseFormulasGrid.length ? baseFormulasGrid : valuesGrid).map((r) =>
    Array.isArray(r) ? [...r] : []
  );
  const notesGrid = {};
  if (baseNotesGrid && typeof baseNotesGrid === "object") {
    for (const [k, v] of Object.entries(baseNotesGrid)) {
      if (!PROTOTYPE_KEYS.has(k) && v !== undefined && v !== null && v !== "") notesGrid[k] = v;
    }
  }

  // Clear editable Salaries bands (rows 4..53 cols A..I and L..end) & notes in rows 4..53
  for (let r0 = 3; r0 <= 52; r0++) {
    if (Array.isArray(valuesGrid[r0])) {
      for (let c = 0; c < valuesGrid[r0].length; c++) {
        if (c === 9 || c === 10) continue;
        valuesGrid[r0][c] = "";
      }
    }
    if (Array.isArray(formulasGrid[r0])) {
      for (let c = 0; c < formulasGrid[r0].length; c++) {
        if (c === 9 || c === 10) continue;
        formulasGrid[r0][c] = "";
      }
    }
    const prefix = `${r0}:`;
    for (const nk of Object.keys(notesGrid)) {
      if (nk.startsWith(prefix)) delete notesGrid[nk];
    }
  }

  for (const emp of employees || []) {
    const r0 = Number(emp.sheet_row_num) - 1;
    if (!Number.isInteger(r0) || r0 < 3 || r0 > 52) continue;

    const rawScalars = emp.raw_scalars && typeof emp.raw_scalars === "object" ? emp.raw_scalars : {};
    const monthlyOverrides = emp.monthly_overrides && typeof emp.monthly_overrides === "object" ? emp.monthly_overrides : {};
    const customFormulas = emp.custom_formulas && typeof emp.custom_formulas === "object" ? emp.custom_formulas : {};
    const cellNotes = emp.cell_notes && typeof emp.cell_notes === "object" ? emp.cell_notes : {};

    const useScalarFallback =
      Object.keys(rawScalars).length === 0 &&
      Object.keys(monthlyOverrides).length === 0 &&
      Object.keys(customFormulas).length === 0 &&
      Object.keys(cellNotes).length === 0;

    const scalarFallback = {
      0: emp.employee_name || "",
      1: emp.role_title || "",
      2: emp.fte_salary ?? "",
      3: emp.fte ?? "",
      4: emp.start_date || "",
      5: emp.end_date || "",
      6: emp.delivery_pct ?? "",
      7: emp.student_loan_plan || "",
      8: emp.pension_pct || "",
    };

    for (let c = 0; c <= 8; c++) {
      const k = String(c);
      const val = Object.prototype.hasOwnProperty.call(rawScalars, k)
        ? rawScalars[k]
        : useScalarFallback
          ? scalarFallback[c]
          : "";
      const fStr = Object.prototype.hasOwnProperty.call(customFormulas, k) ? customFormulas[k] : undefined;
      const fgOverride = Object.prototype.hasOwnProperty.call(customFormulas, `fg:${k}`) ? customFormulas[`fg:${k}`] : undefined;
      const nStr = Object.prototype.hasOwnProperty.call(cellNotes, k) ? cellNotes[k] : "";
      if (isNonEmptyCell_(val) || isFormulaStr_(fStr) || fgOverride !== undefined || nStr) {
        writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c, val, fStr, fgOverride, nStr);
      }
    }

    const overrideCols = new Set([
      ...Object.keys(monthlyOverrides),
      ...Object.keys(customFormulas).filter((k) => !k.startsWith("fg:") && Number(k) >= 11),
      ...Object.keys(cellNotes).filter((k) => Number(k) >= 11),
    ]);
    for (const k of overrideCols) {
      const c = parseInt(k, 10);
      if (!Number.isInteger(c) || c < 11) continue;
      const val = Object.prototype.hasOwnProperty.call(monthlyOverrides, k) ? monthlyOverrides[k] : "";
      const fStr = Object.prototype.hasOwnProperty.call(customFormulas, k) ? customFormulas[k] : undefined;
      const fgOverride = Object.prototype.hasOwnProperty.call(customFormulas, `fg:${k}`) ? customFormulas[`fg:${k}`] : undefined;
      const nStr = Object.prototype.hasOwnProperty.call(cellNotes, k) ? cellNotes[k] : "";
      if (isNonEmptyCell_(val) || isFormulaStr_(fStr) || fgOverride !== undefined || nStr) {
        writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c, val, fStr, fgOverride, nStr);
      }
    }

    // Any remaining notes on columns 9..10 if any existed
    for (const [k, nStr] of Object.entries(cellNotes)) {
      const c = parseInt(k, 10);
      if (Number.isInteger(c) && (c === 9 || c === 10) && nStr) {
        notesGrid[`${r0}:${c}`] = nStr;
      }
    }
  }

  for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
  for (let r = 0; r < formulasGrid.length; r++) formulasGrid[r] = trimTrailingEmptyGridCells_(formulasGrid[r]);
  return { valuesGrid, formulasGrid, notesGrid };
}

// ============================================================================
// 2. OUTGOINGS (`pulse_outgoing_items`) PARSER & PROJECTOR
// ============================================================================

function resolveOutgoingsSection_(rowNum) {
  if (rowNum >= 13 && rowNum <= 110) return "contractor";
  if (rowNum === 111 || rowNum === 112) return "making_up_cos";
  if (rowNum === 118 || rowNum === 119) return "dividend";
  if (rowNum >= 126 && rowNum <= 224) return "expense";
  if (rowNum === 225 || rowNum === 226) return "system";
  return null;
}

function getOutgoingsDefaultDelColVal_(section) {
  if (section === "contractor") return 1;
  if (section === "expense") return 0;
  return "";
}

export function parseOutgoingsTabToItems({
  clientId,
  clientName,
  valuesGrid = [],
  formulasGrid = [],
  notesGrid = {},
}) {
  const notesByRow = parseNotesByRowCol_(notesGrid);
  const items = [];

  for (let r0 = 12; r0 <= 225; r0++) {
    const rowNum = r0 + 1;
    const section = resolveOutgoingsSection_(rowNum);
    if (!section) continue;

    const vRow = Array.isArray(valuesGrid[r0]) ? valuesGrid[r0] : [];
    const fRow = Array.isArray(formulasGrid[r0]) ? formulasGrid[r0] : [];
    const rowNotes = notesByRow.get(r0) || new Map();
    const defaultCol4 = getOutgoingsDefaultDelColVal_(section);

    let populated = rowNotes.size > 0;
    if (!populated) {
      for (const c of [0, 1, 2, 3, 5]) {
        if (isNonEmptyCell_(vRow[c]) || isFormulaStr_(fRow[c])) {
          populated = true;
          break;
        }
      }
    }
    if (!populated) {
      const v4 = vRow[4];
      const f4 = fRow[4];
      if (isFormulaStr_(f4)) populated = true;
      else if (defaultCol4 === "" && isNonEmptyCell_(v4)) populated = true;
      else if (defaultCol4 !== "" && isNonEmptyCell_(v4) && v4 !== defaultCol4) populated = true;
      else if (defaultCol4 !== "" && !isNonEmptyCell_(v4) && section !== "dividend") {
        // Explicit blanking of template default col E (rare edge case)
        // Check if row itself has empty vRow altogether before marking occupied
        if (vRow.length > 4 && vRow[4] === "") populated = true;
      }
    }
    if (!populated) {
      for (const c of MONTHLY_48_COLS) {
        if (isNonEmptyCell_(vRow[c]) || isFormulaStr_(fRow[c])) {
          populated = true;
          break;
        }
      }
    }
    if (!populated) continue;

    const rawScalars = {};
    const monthlyAmounts = {};
    const fyTotals = {};
    const customFormulas = {};
    const cellNotes = {};

    for (let c = 0; c <= 5; c++) {
      const val = vRow[c];
      const f = fRow[c];
      if (isFormulaStr_(f)) customFormulas[String(c)] = f;
      if (Object.prototype.hasOwnProperty.call(vRow, c) && (isNonEmptyCell_(val) || isFormulaStr_(f) || c === 4)) {
        if (val !== undefined && val !== null) rawScalars[String(c)] = val;
      }
    }

    for (const c of MONTHLY_48_COLS) {
      const val = vRow[c];
      const f = fRow[c];
      if (isFormulaStr_(f)) customFormulas[String(c)] = f;
      if (isNonEmptyCell_(val) || isFormulaStr_(f)) {
        monthlyAmounts[String(c)] = val !== undefined && val !== null ? val : "";
      }
    }

    for (const b of YEAR_MONTH_BANDS) {
      const tVal = vRow[b.totalCol];
      if (isNonEmptyCell_(tVal)) fyTotals[String(b.fyIndex)] = tVal;
    }

    for (const [cIdx, nStr] of rowNotes.entries()) {
      cellNotes[String(cIdx)] = nStr;
    }

    const name = String(vRow[0] ?? "").trim();
    items.push({
      client_id: clientId,
      client_name: clientName,
      section,
      sort_order: items.length,
      sheet_row_num: rowNum,
      name,
      vat_applicable: String(vRow[1] ?? "").trim() || "No",
      invoice_timing: String(vRow[2] ?? "").trim() || "Curr",
      payment_timing: String(vRow[3] ?? "").trim() || "Curr",
      delivery_pct: parseDeliveryFraction_(vRow[4], section === "contractor" ? 1 : 0),
      is_hidden: name.toLowerCase() === "hide",
      is_system_row: rowNum === 111 || rowNum === 225 || rowNum === 226,
      monthly_amounts: monthlyAmounts,
      fy_totals: fyTotals,
      raw_scalars: rawScalars,
      custom_formulas: customFormulas,
      cell_notes: cellNotes,
    });
  }

  return items;
}

export function projectOutgoingItemsToGrid({
  items = [],
  baseValuesGrid = [],
  baseFormulasGrid = [],
  baseNotesGrid = {},
}) {
  const valuesGrid = (Array.isArray(baseValuesGrid) ? baseValuesGrid : []).map((r) => (Array.isArray(r) ? [...r] : []));
  const formulasGrid = (Array.isArray(baseFormulasGrid) && baseFormulasGrid.length ? baseFormulasGrid : valuesGrid).map((r) =>
    Array.isArray(r) ? [...r] : []
  );
  const notesGrid = {};
  if (baseNotesGrid && typeof baseNotesGrid === "object") {
    for (const [k, v] of Object.entries(baseNotesGrid)) {
      if (!PROTOTYPE_KEYS.has(k) && v !== undefined && v !== null && v !== "") notesGrid[k] = v;
    }
  }

  const occupiedRows = new Set(items.map((it) => Number(it.sheet_row_num)).filter(Number.isInteger));

  // Clear editable bands on all managed Outgoings rows, restoring blank template Col E defaults for empty rows
  for (let r0 = 12; r0 <= 225; r0++) {
    const rowNum = r0 + 1;
    const section = resolveOutgoingsSection_(rowNum);
    if (!section) continue;

    const isOccupied = occupiedRows.has(rowNum);
    const defaultCol4 = getOutgoingsDefaultDelColVal_(section);

    if (Array.isArray(valuesGrid[r0])) {
      for (let c = 0; c <= 5; c++) valuesGrid[r0][c] = !isOccupied && c === 4 && defaultCol4 !== "" ? defaultCol4 : "";
      for (const c of MONTHLY_48_COLS) {
        if (c < valuesGrid[r0].length) valuesGrid[r0][c] = "";
      }
    }
    if (Array.isArray(formulasGrid[r0])) {
      for (let c = 0; c <= 5; c++) formulasGrid[r0][c] = "";
      for (const c of MONTHLY_48_COLS) {
        if (c < formulasGrid[r0].length) formulasGrid[r0][c] = "";
      }
    }
    const prefix = `${r0}:`;
    for (const nk of Object.keys(notesGrid)) {
      if (nk.startsWith(prefix)) delete notesGrid[nk];
    }
  }

  for (const it of items || []) {
    const rowNum = Number(it.sheet_row_num);
    const r0 = rowNum - 1;
    if (!resolveOutgoingsSection_(rowNum)) continue;

    const rawScalars = it.raw_scalars && typeof it.raw_scalars === "object" ? it.raw_scalars : {};
    const monthlyAmounts = it.monthly_amounts && typeof it.monthly_amounts === "object" ? it.monthly_amounts : {};
    const customFormulas = it.custom_formulas && typeof it.custom_formulas === "object" ? it.custom_formulas : {};
    const cellNotes = it.cell_notes && typeof it.cell_notes === "object" ? it.cell_notes : {};

    const useScalarFallback =
      Object.keys(rawScalars).length === 0 &&
      Object.keys(monthlyAmounts).length === 0 &&
      Object.keys(customFormulas).length === 0 &&
      Object.keys(cellNotes).length === 0;

    const scalarFallback = {
      0: it.name || "",
      1: it.vat_applicable || "",
      2: it.invoice_timing || "",
      3: it.payment_timing || "",
      4: it.delivery_pct ?? "",
    };

    for (let c = 0; c <= 5; c++) {
      const k = String(c);
      const hasRaw = Object.prototype.hasOwnProperty.call(rawScalars, k);
      const val = hasRaw ? rawScalars[k] : useScalarFallback && c <= 4 ? scalarFallback[c] : "";
      const fStr = Object.prototype.hasOwnProperty.call(customFormulas, k) ? customFormulas[k] : undefined;
      const fgOverride = Object.prototype.hasOwnProperty.call(customFormulas, `fg:${k}`) ? customFormulas[`fg:${k}`] : undefined;
      const nStr = Object.prototype.hasOwnProperty.call(cellNotes, k) ? cellNotes[k] : "";
      if (isNonEmptyCell_(val) || isFormulaStr_(fStr) || fgOverride !== undefined || nStr) {
        writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c, val, fStr, fgOverride, nStr);
      }
    }

    for (const c of MONTHLY_48_COLS) {
      const k = String(c);
      const val = Object.prototype.hasOwnProperty.call(monthlyAmounts, k) ? monthlyAmounts[k] : "";
      const fStr = Object.prototype.hasOwnProperty.call(customFormulas, k) ? customFormulas[k] : undefined;
      const fgOverride = Object.prototype.hasOwnProperty.call(customFormulas, `fg:${k}`) ? customFormulas[`fg:${k}`] : undefined;
      const nStr = Object.prototype.hasOwnProperty.call(cellNotes, k) ? cellNotes[k] : "";
      if (isNonEmptyCell_(val) || isFormulaStr_(fStr) || fgOverride !== undefined || nStr) {
        writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c, val, fStr, fgOverride, nStr);
      }
    }

    for (const [k, nStr] of Object.entries(cellNotes)) {
      const c = parseInt(k, 10);
      if (Number.isInteger(c) && !MONTHLY_48_COL_SET.has(c) && c > 5 && nStr) {
        notesGrid[`${r0}:${c}`] = nStr;
      }
    }
  }

  for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
  for (let r = 0; r < formulasGrid.length; r++) formulasGrid[r] = trimTrailingEmptyGridCells_(formulasGrid[r]);
  return { valuesGrid, formulasGrid, notesGrid };
}

// ============================================================================
// 3. OUTGNOTES (`pulse_contractor_entries`) PARSER & PROJECTOR
// ============================================================================

function extractAppTagLocal_(rawBlock, key) {
  const m = rawBlock.match(new RegExp(`\\{${key}:\\s*([^}]*)\\}`, "i"));
  return m ? m[1].trim() : "";
}

export function parseOutgNotesTabToContractorEntries({
  clientId,
  clientName,
  valuesGrid = [],
  formulasGrid = [],
  outgoingItemByRow = new Map(),
  accCostFkByExtId = new Map(),
}) {
  const headerRow = Array.isArray(valuesGrid[0]) ? valuesGrid[0] : [];
  const entries = [];

  for (let r0 = 12; r0 <= 110 && r0 < Math.max(valuesGrid.length, formulasGrid.length); r0++) {
    const vRow = Array.isArray(valuesGrid[r0]) ? valuesGrid[r0] : [];
    const fRow = Array.isArray(formulasGrid[r0]) ? formulasGrid[r0] : [];
    const rowNum = r0 + 1;
    const item = outgoingItemByRow.get(rowNum) || null;

    for (const c of MONTHLY_48_COLS) {
      const rawVal = vRow[c];
      const fStr = fRow[c];
      const hasF = isFormulaStr_(fStr);
      if (!isNonEmptyCell_(rawVal) && !hasF) continue;

      const { fyIndex, monthIndex } = resolveOutgoingsFyInfo_(c);
      const periodYm = parseHeaderYearMonth_(headerRow[c]);
      const isNum = typeof rawVal === "number";
      const cellStr = isNonEmptyCell_(rawVal) ? String(rawVal) : "";

      if (isNum || !cellStr.includes("{App ID:")) {
        entries.push({
          client_id: clientId,
          client_name: clientName,
          outgoing_item_id: item?.id || null,
          accounting_direct_cost_id: null,
          entry_type: "note",
          sheet_row_num: rowNum,
          sheet_col_idx: c,
          fy_index: fyIndex,
          month_index: monthIndex,
          period_ym: periodYm,
          block_order: 0,
          external_app_id: "",
          amount: isNum ? rawVal : 0,
          status: "",
          received_date: "",
          payment_date: "",
          description: cellStr.trim(),
          is_placeholder: false,
          raw_block: cellStr,
          custom_formula: hasF ? fStr : isNum ? "__number__" : "",
        });
        continue;
      }

      const chunks = cellStr.split(/(?=\{App ID:)/);
      let blockOrder = 0;
      for (const chunk of chunks) {
        if (!chunk) continue;
        if (!chunk.startsWith("{App ID:")) {
          entries.push({
            client_id: clientId,
            client_name: clientName,
            outgoing_item_id: item?.id || null,
            accounting_direct_cost_id: null,
            entry_type: "note",
            sheet_row_num: rowNum,
            sheet_col_idx: c,
            fy_index: fyIndex,
            month_index: monthIndex,
            period_ym: periodYm,
            block_order: blockOrder,
            external_app_id: "",
            amount: 0,
            status: "",
            received_date: "",
            payment_date: "",
            description: chunk.trim(),
            is_placeholder: false,
            raw_block: chunk,
            custom_formula: blockOrder === 0 && hasF ? fStr : "",
          });
          blockOrder++;
          continue;
        }

        const appId = extractAppTagLocal_(chunk, "App ID");
        const amt = parseNumericOrDefault_(extractAppTagLocal_(chunk, "Amt"), 0);
        const status = extractAppTagLocal_(chunk, "Status");
        const recDate = extractAppTagLocal_(chunk, "Rec date");
        const payDate = extractAppTagLocal_(chunk, "Pay date");
        const desc = extractAppTagLocal_(chunk, "Description");
        const isPh = isPlaceholderExpense(appId, desc, status);
        const extKey = normalizeTextKey_(appId);

        entries.push({
          client_id: clientId,
          client_name: clientName,
          outgoing_item_id: item?.id || null,
          accounting_direct_cost_id: extKey && !isPh ? accCostFkByExtId.get(extKey) || null : null,
          entry_type: isPh ? "placeholder" : "bill",
          sheet_row_num: rowNum,
          sheet_col_idx: c,
          fy_index: fyIndex,
          month_index: monthIndex,
          period_ym: periodYm,
          block_order: blockOrder,
          external_app_id: appId,
          amount: amt,
          status,
          received_date: recDate,
          payment_date: payDate,
          description: desc,
          is_placeholder: isPh,
          raw_block: chunk,
          custom_formula: blockOrder === 0 && hasF ? fStr : "",
        });
        blockOrder++;
      }
    }
  }

  return entries;
}

export function projectContractorEntriesToOutgNotesGrid({
  entries = [],
  baseValuesGrid = [],
  baseFormulasGrid = [],
  baseNotesGrid = {},
}) {
  const valuesGrid = (Array.isArray(baseValuesGrid) ? baseValuesGrid : []).map((r) => (Array.isArray(r) ? [...r] : []));
  const formulasGrid = (Array.isArray(baseFormulasGrid) && baseFormulasGrid.length ? baseFormulasGrid : valuesGrid).map((r) =>
    Array.isArray(r) ? [...r] : []
  );
  const notesGrid = {};
  if (baseNotesGrid && typeof baseNotesGrid === "object") {
    for (const [k, v] of Object.entries(baseNotesGrid)) {
      if (!PROTOTYPE_KEYS.has(k) && v !== undefined && v !== null && v !== "") notesGrid[k] = v;
    }
  }

  // Clear monthly cells in rows 13..111
  for (let r0 = 12; r0 <= 110; r0++) {
    if (Array.isArray(valuesGrid[r0])) {
      for (const c of MONTHLY_48_COLS) {
        if (c < valuesGrid[r0].length) valuesGrid[r0][c] = "";
      }
    }
    if (Array.isArray(formulasGrid[r0])) {
      for (const c of MONTHLY_48_COLS) {
        if (c < formulasGrid[r0].length) formulasGrid[r0][c] = "";
      }
    }
  }

  // Group entries by (sheet_row_num, sheet_col_idx) ordered by block_order
  const byCell = new Map();
  for (const e of entries || []) {
    const k = `${e.sheet_row_num}:${e.sheet_col_idx}`;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(e);
  }

  for (const list of byCell.values()) {
    list.sort((a, b) => (Number(a.block_order) || 0) - (Number(b.block_order) || 0));
    const first = list[0];
    const r0 = Number(first.sheet_row_num) - 1;
    const c0 = Number(first.sheet_col_idx);
    if (r0 < 12 || r0 > 110 || !MONTHLY_48_COL_SET.has(c0)) continue;

    const formulaMeta = String(first.custom_formula || "");
    const fStr = isFormulaStr_(formulaMeta) ? formulaMeta : undefined;
    let combined = list.map((b) => String(b.raw_block ?? "")).join("");
    if (formulaMeta === "__number__" && combined !== "" && !Number.isNaN(Number(combined))) {
      combined = Number(combined);
    }

    writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c0, combined, fStr, undefined, "");
  }

  for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
  for (let r = 0; r < formulasGrid.length; r++) formulasGrid[r] = trimTrailingEmptyGridCells_(formulasGrid[r]);
  return { valuesGrid, formulasGrid, notesGrid };
}

// ============================================================================
// 4. NB TO FIND (`pulse_nb_to_find`) PARSER & PROJECTOR
// ============================================================================

function extractNbMonthlyMap_(row = []) {
  const out = {};
  for (const c of MONTHLY_48_COLS) {
    if (isNonEmptyCell_(row[c])) out[String(c)] = row[c];
  }
  return out;
}

export function parseNbToFindTabToRecord({
  clientId,
  clientName,
  valuesGrid = [],
  formulasGrid = [],
  notesGrid = {},
}) {
  const notesByRow = parseNotesByRowCol_(notesGrid);
  const rawCells = {};
  const customFormulas = {};
  const cellNotes = {};

  for (const r0 of NBTF_SETTING_ROWS0) {
    const val = valuesGrid[r0]?.[0];
    const f = formulasGrid[r0]?.[0];
    const key = `${r0}:0`;
    if (isFormulaStr_(f)) customFormulas[key] = f;
    if (isNonEmptyCell_(val) || isFormulaStr_(f)) {
      rawCells[key] = val !== undefined && val !== null ? val : "";
    }
  }

  for (const r0 of NBTF_EDITABLE_ROWS0) {
    const vRow = Array.isArray(valuesGrid[r0]) ? valuesGrid[r0] : [];
    const fRow = Array.isArray(formulasGrid[r0]) ? formulasGrid[r0] : [];
    for (const c of MONTHLY_48_COLS) {
      const val = vRow[c];
      const f = fRow[c];
      const key = `${r0}:${c}`;
      if (isFormulaStr_(f)) customFormulas[key] = f;
      if (isNonEmptyCell_(val) || isFormulaStr_(f)) {
        rawCells[key] = val !== undefined && val !== null ? val : "";
      }
    }
  }

  for (const [r0, colMap] of notesByRow.entries()) {
    for (const [c0, nStr] of colMap.entries()) {
      cellNotes[`${r0}:${c0}`] = nStr;
    }
  }

  const reconciledRollups = {};
  for (const r0 of NBTF_ROLLUP_ROWS0) {
    const vRow = Array.isArray(valuesGrid[r0]) ? valuesGrid[r0] : [];
    const rowObj = {};
    for (const c of [0, ...MONTHLY_48_COLS, ...OUTGOINGS_TOTAL_COLS]) {
      if (isNonEmptyCell_(vRow[c])) rowObj[String(c)] = vRow[c];
    }
    if (Object.keys(rowObj).length > 0) reconciledRollups[String(r0)] = rowObj;
  }
  reconciledRollups._nbMeta = {
    rowCount: valuesGrid.length,
    ...(notesGrid?.__dateCells && Object.keys(notesGrid.__dateCells).length > 0 ? { dateCells: notesGrid.__dateCells } : {}),
  };

  return {
    client_id: clientId,
    client_name: clientName,
    use_targets: String(valuesGrid[8]?.[0] ?? "No").trim().toLowerCase() === "yes" ? "Yes" : "No",
    use_budget_for_targets: String(valuesGrid[11]?.[0] ?? "No").trim().toLowerCase() === "yes" ? "Yes" : "No",
    direct_costs_pct: String(valuesGrid[20]?.[0] ?? "0%").trim() || "0%",
    manual_revenue_targets: extractNbMonthlyMap_(valuesGrid[2]),
    manual_direct_costs: extractNbMonthlyMap_(valuesGrid[4]),
    total_income_targets: extractNbMonthlyMap_(valuesGrid[9]),
    budget_targets: extractNbMonthlyMap_(valuesGrid[11]),
    dc_calc_row: extractNbMonthlyMap_(valuesGrid[19]),
    use_nb_flags: extractNbMonthlyMap_(valuesGrid[24]),
    reconciled_rollups: reconciledRollups,
    raw_cells: rawCells,
    custom_formulas: customFormulas,
    cell_notes: cellNotes,
  };
}

export function projectNbToFindRecordToGrid({
  record = null,
  baseValuesGrid = [],
  baseFormulasGrid = [],
  baseNotesGrid = {},
}) {
  const valuesGrid = (Array.isArray(baseValuesGrid) ? baseValuesGrid : []).map((r) => (Array.isArray(r) ? [...r] : []));
  const formulasGrid = (Array.isArray(baseFormulasGrid) && baseFormulasGrid.length ? baseFormulasGrid : valuesGrid).map((r) =>
    Array.isArray(r) ? [...r] : []
  );
  const notesGrid = {};

  for (const r0 of NBTF_SETTING_ROWS0) {
    if (Array.isArray(valuesGrid[r0]) && valuesGrid[r0].length > 0) valuesGrid[r0][0] = "";
    if (Array.isArray(formulasGrid[r0]) && formulasGrid[r0].length > 0) formulasGrid[r0][0] = "";
  }
  for (const r0 of NBTF_EDITABLE_ROWS0) {
    for (const c of MONTHLY_48_COLS) {
      if (Array.isArray(valuesGrid[r0]) && c < valuesGrid[r0].length) valuesGrid[r0][c] = "";
      if (Array.isArray(formulasGrid[r0]) && c < formulasGrid[r0].length) formulasGrid[r0][c] = "";
    }
  }

  if (record) {
    const rawCells = record.raw_cells && typeof record.raw_cells === "object" ? record.raw_cells : {};
    const customFormulas = record.custom_formulas && typeof record.custom_formulas === "object" ? record.custom_formulas : {};
    const cellNotes = record.cell_notes && typeof record.cell_notes === "object" ? record.cell_notes : {};

    const keys = new Set([
      ...Object.keys(rawCells),
      ...Object.keys(customFormulas).filter((k) => !k.startsWith("fg:")),
    ]);
    for (const k of keys) {
      const colon = k.indexOf(":");
      if (colon <= 0) continue;
      const r0 = parseInt(k.slice(0, colon), 10);
      const c0 = parseInt(k.slice(colon + 1), 10);
      if (!Number.isInteger(r0) || !Number.isInteger(c0)) continue;
      const val = Object.prototype.hasOwnProperty.call(rawCells, k) ? rawCells[k] : "";
      const fStr = Object.prototype.hasOwnProperty.call(customFormulas, k) ? customFormulas[k] : undefined;
      const fgOverride = Object.prototype.hasOwnProperty.call(customFormulas, `fg:${k}`) ? customFormulas[`fg:${k}`] : undefined;
      writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c0, val, fStr, fgOverride, "");
    }

    for (const [k, nStr] of Object.entries(cellNotes)) {
      if (!PROTOTYPE_KEYS.has(k) && nStr) notesGrid[k] = nStr;
    }
  }

  if (!record && baseNotesGrid && typeof baseNotesGrid === "object") {
    for (const [k, v] of Object.entries(baseNotesGrid)) {
      if (!PROTOTYPE_KEYS.has(k) && v) notesGrid[k] = v;
    }
  }

  for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
  for (let r = 0; r < formulasGrid.length; r++) formulasGrid[r] = trimTrailingEmptyGridCells_(formulasGrid[r]);
  return { valuesGrid, formulasGrid, notesGrid };
}

// ============================================================================
// 5. BUDGET (`pulse_budget_items`) PARSER & PROJECTOR
// ============================================================================

function getBudgetTemplateDefaults_(section) {
  if (section === "salary") return { col1: 0, col4: 1 };
  if (section === "contractor") return { col1: undefined, col4: 1 };
  if (section === "expense") return { col1: undefined, col4: 0 };
  return { col1: undefined, col4: undefined };
}

export function parseBudgetTabToItems({
  clientId,
  clientName,
  valuesGrid = [],
  formulasGrid = [],
  notesGrid = {},
}) {
  const notesByRow = parseNotesByRowCol_(notesGrid);
  const items = [];

  for (const { rowNum, section } of BUDGET_ROW_SECTIONS) {
    const r0 = rowNum - 1;
    const vRow = Array.isArray(valuesGrid[r0]) ? valuesGrid[r0] : [];
    const fRow = Array.isArray(formulasGrid[r0]) ? formulasGrid[r0] : [];
    const rowNotes = notesByRow.get(r0) || new Map();
    const defs = getBudgetTemplateDefaults_(section);
    const isDynamicList = section === "salary" || section === "contractor" || section === "expense";

    let populated = rowNotes.size > 0;
    if (!populated) {
      if (!isDynamicList) {
        if (isNonEmptyCell_(vRow[0]) || isFormulaStr_(fRow[0]) || isNonEmptyCell_(vRow[4]) || isFormulaStr_(fRow[4])) {
          populated = true;
        }
      } else {
        if (isNonEmptyCell_(vRow[0]) || isFormulaStr_(fRow[0]) || isNonEmptyCell_(vRow[2]) || isFormulaStr_(fRow[2]) || isNonEmptyCell_(vRow[3]) || isFormulaStr_(fRow[3])) {
          populated = true;
        }
        if (!populated) {
          if (isFormulaStr_(fRow[1])) populated = true;
          else if (defs.col1 === undefined && isNonEmptyCell_(vRow[1])) populated = true;
          else if (defs.col1 !== undefined && isNonEmptyCell_(vRow[1]) && vRow[1] !== defs.col1) populated = true;
        }
        if (!populated) {
          if (isFormulaStr_(fRow[4])) populated = true;
          else if (defs.col4 === undefined && isNonEmptyCell_(vRow[4])) populated = true;
          else if (defs.col4 !== undefined && isNonEmptyCell_(vRow[4]) && vRow[4] !== defs.col4) populated = true;
        }
      }
    }
    if (!populated) {
      for (const c of MONTHLY_48_COLS) {
        const val = vRow[c];
        const f = fRow[c];
        // On salary rows, col G..AV blank template has auto-formula =if($B59=0,"",...) resolving to ""
        if (section === "salary" && isFormulaStr_(f) && !isNonEmptyCell_(val)) continue;
        if (isNonEmptyCell_(val) || (section !== "salary" && isFormulaStr_(f))) {
          populated = true;
          break;
        }
      }
    }
    if (!populated) continue;

    const rawScalars = {};
    const monthlyValues = {};
    const fyTotals = {};
    const customFormulas = {};
    const cellNotes = {};

    for (let c = 0; c <= 4; c++) {
      const val = vRow[c];
      const f = fRow[c];
      if (isFormulaStr_(f)) customFormulas[String(c)] = f;
      if (isNonEmptyCell_(val) || isFormulaStr_(f)) {
        rawScalars[String(c)] = val !== undefined && val !== null ? val : "";
      } else if (Object.prototype.hasOwnProperty.call(vRow, c) && vRow[c] === "") {
        // Explicit empty string (e.g. Budget salary row col 2/3)
        rawScalars[String(c)] = "";
      }
    }

    for (const c of MONTHLY_48_COLS) {
      const val = vRow[c];
      const f = fRow[c];
      if (isFormulaStr_(f)) customFormulas[String(c)] = f;
      else if (section === "salary") customFormulas[`fg:${c}`] = ""; // Overrode template formula with static value/blank
      if (isNonEmptyCell_(val) || isFormulaStr_(f)) {
        monthlyValues[String(c)] = val !== undefined && val !== null ? val : "";
      }
    }

    for (const b of YEAR_MONTH_BANDS) {
      const tVal = vRow[b.totalCol];
      if (isNonEmptyCell_(tVal)) fyTotals[String(b.fyIndex)] = tVal;
    }

    for (const [cIdx, nStr] of rowNotes.entries()) {
      cellNotes[String(cIdx)] = nStr;
    }

    items.push({
      client_id: clientId,
      client_name: clientName,
      section,
      sort_order: items.length,
      sheet_row_num: rowNum,
      name: String(vRow[0] ?? "").trim(),
      equiv_salary: section === "salary" ? parseNumericOrDefault_(vRow[1], 0) : 0,
      start_date: section === "salary" ? parseDateText_(vRow[2]) : "",
      end_date: section === "salary" ? parseDateText_(vRow[3]) : "",
      delivery_pct: parseDeliveryFraction_(vRow[4], section === "contractor" ? 1 : 0),
      making_up_cos_pct: section === "making_up_cos" ? parseDeliveryFraction_(vRow[1], 0) : 0,
      monthly_values: monthlyValues,
      fy_totals: fyTotals,
      raw_scalars: rawScalars,
      custom_formulas: customFormulas,
      cell_notes: cellNotes,
    });
  }

  return items;
}

export function projectBudgetItemsToGrid({
  items = [],
  baseValuesGrid = [],
  baseFormulasGrid = [],
  baseNotesGrid = {},
}) {
  const valuesGrid = (Array.isArray(baseValuesGrid) ? baseValuesGrid : []).map((r) => (Array.isArray(r) ? [...r] : []));
  const formulasGrid = (Array.isArray(baseFormulasGrid) && baseFormulasGrid.length ? baseFormulasGrid : valuesGrid).map((r) =>
    Array.isArray(r) ? [...r] : []
  );
  const notesGrid = {};
  if (baseNotesGrid && typeof baseNotesGrid === "object") {
    for (const [k, v] of Object.entries(baseNotesGrid)) {
      if (!PROTOTYPE_KEYS.has(k) && v !== undefined && v !== null && v !== "") notesGrid[k] = v;
    }
  }

  const occupiedRows = new Set(items.map((it) => Number(it.sheet_row_num)).filter(Number.isInteger));
  for (const rowNum of occupiedRows) {
    const r0 = rowNum - 1;
    if (!BUDGET_SECTION_BY_ROW.has(rowNum)) continue;
    if (Array.isArray(valuesGrid[r0])) {
      for (let c = 0; c <= 4; c++) valuesGrid[r0][c] = "";
      for (const c of MONTHLY_48_COLS) {
        if (c < valuesGrid[r0].length) valuesGrid[r0][c] = "";
      }
    }
    if (Array.isArray(formulasGrid[r0])) {
      for (let c = 0; c <= 4; c++) formulasGrid[r0][c] = "";
      for (const c of MONTHLY_48_COLS) {
        if (c < formulasGrid[r0].length) formulasGrid[r0][c] = "";
      }
    }
    const prefix = `${r0}:`;
    for (const nk of Object.keys(notesGrid)) {
      if (nk.startsWith(prefix)) delete notesGrid[nk];
    }
  }

  for (const it of items || []) {
    const rowNum = Number(it.sheet_row_num);
    const r0 = rowNum - 1;
    if (!BUDGET_SECTION_BY_ROW.has(rowNum)) continue;

    const rawScalars = it.raw_scalars && typeof it.raw_scalars === "object" ? it.raw_scalars : {};
    const monthlyValues = it.monthly_values && typeof it.monthly_values === "object" ? it.monthly_values : {};
    const customFormulas = it.custom_formulas && typeof it.custom_formulas === "object" ? it.custom_formulas : {};
    const cellNotes = it.cell_notes && typeof it.cell_notes === "object" ? it.cell_notes : {};

    const useScalarFallback =
      Object.keys(rawScalars).length === 0 &&
      Object.keys(monthlyValues).length === 0 &&
      Object.keys(customFormulas).length === 0 &&
      Object.keys(cellNotes).length === 0;

    const scalarFallback = {
      0: it.name || "",
      1: it.section === "salary" ? (it.equiv_salary ?? "") : (it.section === "making_up_cos" ? (it.making_up_cos_pct ?? "") : ""),
      2: it.start_date || "",
      3: it.end_date || "",
      4: it.delivery_pct ?? "",
    };

    for (let c = 0; c <= 4; c++) {
      const k = String(c);
      const hasRaw = Object.prototype.hasOwnProperty.call(rawScalars, k);
      const val = hasRaw ? rawScalars[k] : useScalarFallback ? scalarFallback[c] : "";
      const fStr = Object.prototype.hasOwnProperty.call(customFormulas, k) ? customFormulas[k] : undefined;
      const fgOverride = Object.prototype.hasOwnProperty.call(customFormulas, `fg:${k}`) ? customFormulas[`fg:${k}`] : undefined;
      const nStr = Object.prototype.hasOwnProperty.call(cellNotes, k) ? cellNotes[k] : "";
      if (hasRaw || isNonEmptyCell_(val) || isFormulaStr_(fStr) || fgOverride !== undefined || nStr) {
        writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c, val, fStr, fgOverride, nStr);
      }
    }

    for (const c of MONTHLY_48_COLS) {
      const k = String(c);
      const val = Object.prototype.hasOwnProperty.call(monthlyValues, k) ? monthlyValues[k] : "";
      const fStr = Object.prototype.hasOwnProperty.call(customFormulas, k) ? customFormulas[k] : undefined;
      const fgOverride = Object.prototype.hasOwnProperty.call(customFormulas, `fg:${k}`) ? customFormulas[`fg:${k}`] : undefined;
      const nStr = Object.prototype.hasOwnProperty.call(cellNotes, k) ? cellNotes[k] : "";
      if (isNonEmptyCell_(val) || isFormulaStr_(fStr) || fgOverride !== undefined || nStr) {
        writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c, val, fStr, fgOverride, nStr);
      }
    }

    for (const [k, nStr] of Object.entries(cellNotes)) {
      const c = parseInt(k, 10);
      if (Number.isInteger(c) && !MONTHLY_48_COL_SET.has(c) && c > 4 && nStr) {
        notesGrid[`${r0}:${c}`] = nStr;
      }
    }
  }

  for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
  for (let r = 0; r < formulasGrid.length; r++) formulasGrid[r] = trimTrailingEmptyGridCells_(formulasGrid[r]);
  return { valuesGrid, formulasGrid, notesGrid };
}

// ============================================================================
// 6. CASH OVERRIDES (`pulse_cash_adjustments`) & BANK BALANCES
// ============================================================================

export function parseCashTabToAdjustments({
  clientId,
  clientName,
  valuesGrid = [],
  formulasGrid = [],
  notesGrid = {},
}) {
  const notesByRow = parseNotesByRowCol_(notesGrid);
  const headerRow = Array.isArray(valuesGrid[0]) ? valuesGrid[0] : [];
  const rows = [];
  const maxR = Math.min(76, Math.max(valuesGrid.length, formulasGrid.length, 76));

  for (let r0 = 0; r0 < maxR; r0++) {
    const rowNum = r0 + 1;
    const vRow = Array.isArray(valuesGrid[r0]) ? valuesGrid[r0] : [];
    const fRow = Array.isArray(formulasGrid[r0]) ? formulasGrid[r0] : [];
    const rowNotes = notesByRow.get(r0) || new Map();
    const lineKey = String(vRow[0] ?? "").trim();

    for (let c = 1; c <= 36; c++) {
      const editable = isCashCellEditable(rowNum, c);
      const val = vRow[c];
      const f = fRow[c];
      const noteStr = rowNotes.get(c) || "";
      const hasValOrForm = editable && (isNonEmptyCell_(val) || isFormulaStr_(f));
      if (!hasValOrForm && !noteStr) continue;

      rows.push({
        client_id: clientId,
        client_name: clientName,
        sheet_row_num: rowNum,
        sheet_col_idx: c,
        period_ym: parseHeaderYearMonth_(headerRow[c]),
        line_key: lineKey,
        numeric_value: hasValOrForm ? parseNullableNumeric_(val) : null,
        raw_value: hasValOrForm ? (val !== undefined ? val : null) : null,
        formula: hasValOrForm && isFormulaStr_(f) ? f : "",
        cell_note: noteStr,
      });
    }
  }

  return rows;
}

export function projectCashAdjustmentsToGrid({
  adjustments = [],
  baseValuesGrid = [],
  baseFormulasGrid = [],
  baseNotesGrid = {},
}) {
  const valuesGrid = (Array.isArray(baseValuesGrid) ? baseValuesGrid : []).map((r) => (Array.isArray(r) ? [...r] : []));
  const formulasGrid = (Array.isArray(baseFormulasGrid) && baseFormulasGrid.length ? baseFormulasGrid : valuesGrid).map((r) =>
    Array.isArray(r) ? [...r] : []
  );
  const notesGrid = {};
  if (baseNotesGrid && typeof baseNotesGrid === "object") {
    for (const [k, v] of Object.entries(baseNotesGrid)) {
      if (!PROTOTYPE_KEYS.has(k) && v !== undefined && v !== null && v !== "") notesGrid[k] = v;
    }
  }

  for (let r0 = 0; r0 < 76; r0++) {
    const rowNum = r0 + 1;
    for (let c = 1; c <= 36; c++) {
      if (isCashCellEditable(rowNum, c)) {
        if (Array.isArray(valuesGrid[r0]) && c < valuesGrid[r0].length) valuesGrid[r0][c] = "";
        if (Array.isArray(formulasGrid[r0]) && c < formulasGrid[r0].length) formulasGrid[r0][c] = "";
      }
      delete notesGrid[`${r0}:${c}`];
    }
  }

  for (const adj of adjustments || []) {
    const rowNum = Number(adj.sheet_row_num);
    const r0 = rowNum - 1;
    const c = Number(adj.sheet_col_idx);
    if (!Number.isInteger(r0) || r0 < 0 || r0 >= 76 || !Number.isInteger(c) || c < 1 || c > 36) continue;

    if (isCashCellEditable(rowNum, c)) {
      const fStr = isFormulaStr_(adj.formula) ? adj.formula : undefined;
      const rawVal = adj.raw_value !== undefined && adj.raw_value !== null ? adj.raw_value : "";
      if (isNonEmptyCell_(rawVal) || fStr) {
        writeCellToProjectedGrid_(valuesGrid, formulasGrid, notesGrid, r0, c, rawVal, fStr, undefined, adj.cell_note || "");
      } else if (adj.cell_note) {
        notesGrid[`${r0}:${c}`] = adj.cell_note;
      }
    } else if (adj.cell_note) {
      notesGrid[`${r0}:${c}`] = adj.cell_note;
    }
  }

  for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
  for (let r = 0; r < formulasGrid.length; r++) formulasGrid[r] = trimTrailingEmptyGridCells_(formulasGrid[r]);
  return { valuesGrid, formulasGrid, notesGrid };
}

export function parseBankBreakdownsToRelational({ clientId, clientName, breakdownData = null }) {
  const months = breakdownData?.months && typeof breakdownData.months === "object" ? breakdownData.months : {};
  const records = [];
  for (const [mKey, entry] of Object.entries(months)) {
    if (PROTOTYPE_KEYS.has(mKey) || !entry || typeof entry !== "object") continue;
    records.push({
      client_id: clientId,
      client_name: clientName,
      period_ym: mKey,
      source: String(entry.source || "manual"),
      basis: String(entry.basis || "manual"),
      total_balance: parseNumericOrDefault_(entry.total, 0),
      accounts: Array.isArray(entry.accounts) ? entry.accounts : [],
      updated_by: String(entry.updatedBy || ""),
    });
  }
  records.sort((a, b) => a.period_ym.localeCompare(b.period_ym));
  return records;
}

// ============================================================================
// 6B. COMPACT ROLLUP EXTRACTORS (FOR PURE-RELATIONAL PHASE 3B READS)
// ============================================================================

const MANAGED_OUTGOINGS_COLS = new Set([0, 1, 2, 3, 4, 5, ...MONTHLY_48_COLS, ...OUTGOINGS_TOTAL_COLS]);
const MANAGED_BUDGET_COLS = new Set([0, 1, 2, 3, 4, ...MONTHLY_48_COLS, ...OUTGOINGS_TOTAL_COLS]);

function extractSparseRowCells_(row = [], maxCol = 65, excludeSet = null) {
  const out = {};
  const limit = Math.min(Array.isArray(row) ? row.length - 1 : -1, maxCol);
  for (let c = 0; c <= limit; c++) {
    if (excludeSet && excludeSet.has(c)) continue;
    const v = row[c];
    if (isNonEmptyCell_(v)) out[String(c)] = v;
  }
  return out;
}

function extractSalariesRollups_(valuesGrid = [], notesGrid = {}, occupiedRow0Set = new Set()) {
  const rows = {};
  const notes = {};
  const rowCount = Array.isArray(valuesGrid) ? valuesGrid.length : 0;

  for (let r0 = 0; r0 < Math.min(rowCount, 368); r0++) {
    const row = Array.isArray(valuesGrid[r0]) ? valuesGrid[r0] : [];
    const isHeader = r0 <= 2;
    const isEmpBand = r0 >= 3 && r0 <= 52;
    const isSummaryBand = r0 >= 53 && r0 <= 99;
    const isForecastBand = r0 >= 153 && r0 <= 202;
    const isEffectiveBand = r0 >= 303 && r0 <= 352;
    const isEffectiveTotalsBand = r0 >= 353 && r0 <= 367;

    if (!isHeader && !isEmpBand && !isSummaryBand && !isForecastBand && !isEffectiveBand && !isEffectiveTotalsBand) {
      continue;
    }

    let obj = {};
    if (isHeader || isSummaryBand || isEffectiveTotalsBand) {
      obj = extractSparseRowCells_(row, 280);
    } else if (isEmpBand) {
      if (!occupiedRow0Set.has(r0)) {
        obj = extractSparseRowCells_(row, 280);
      } else {
        for (const c of [9, 10]) {
          if (isNonEmptyCell_(row[c])) obj[String(c)] = row[c];
        }
      }
    } else if (isForecastBand && !occupiedRow0Set.has(r0 - 150)) {
      obj = extractSparseRowCells_(row, 280);
    } else if (isEffectiveBand && !occupiedRow0Set.has(r0 - 300)) {
      obj = extractSparseRowCells_(row, 280);
    }

    if (Object.keys(obj).length > 0) rows[String(r0)] = obj;
  }

  if (notesGrid && typeof notesGrid === "object") {
    for (const [k, v] of Object.entries(notesGrid)) {
      if (!k || k.startsWith("__") || PROTOTYPE_KEYS.has(k) || !v) continue;
      const r0 = parseInt(k.slice(0, k.indexOf(":")), 10);
      if (Number.isInteger(r0) && (r0 < 3 || r0 > 52 || !occupiedRow0Set.has(r0))) {
        notes[k] = String(v);
      }
    }
  }

  return {
    rowCount,
    rows,
    ...(Object.keys(notes).length > 0 ? { notes } : {}),
    ...(notesGrid?.__dateCells && Object.keys(notesGrid.__dateCells).length > 0 ? { dateCells: notesGrid.__dateCells } : {}),
  };
}

function extractOutgoingsRollups_(valuesGrid = [], notesGrid = {}, occupiedRowNumSet = new Set(), formulasGrid = []) {
  const rows = {};
  const notes = {};
  const formulaColCounts = {};
  const rowCount = Array.isArray(valuesGrid) ? valuesGrid.length : 0;
  const formulaRowCount = Array.isArray(formulasGrid) ? formulasGrid.length : 0;

  for (let r0 = 0; r0 < Math.min(Math.max(rowCount, formulaRowCount), 310); r0++) {
    if (r0 < rowCount) {
      const row = Array.isArray(valuesGrid[r0]) ? valuesGrid[r0] : [];
      const isOcc = occupiedRowNumSet.has(r0 + 1);
      const obj = isOcc
        ? extractSparseRowCells_(row, 65, MANAGED_OUTGOINGS_COLS)
        : extractSparseRowCells_(row, 65);
      if (Object.keys(obj).length > 0) rows[String(r0)] = obj;
    }
    const vTrimLen = r0 < rowCount && Array.isArray(valuesGrid[r0]) ? trimTrailingEmptyGridCells_(valuesGrid[r0]).length : 0;
    const fTrimLen = r0 < formulaRowCount && Array.isArray(formulasGrid[r0]) ? trimTrailingEmptyGridCells_(formulasGrid[r0]).length : 0;
    if (fTrimLen > vTrimLen) {
      formulaColCounts[String(r0)] = fTrimLen;
    }
  }

  if (notesGrid && typeof notesGrid === "object") {
    for (const [k, v] of Object.entries(notesGrid)) {
      if (!k || k.startsWith("__") || PROTOTYPE_KEYS.has(k) || !v) continue;
      const r0 = parseInt(k.slice(0, k.indexOf(":")), 10);
      if (Number.isInteger(r0) && !occupiedRowNumSet.has(r0 + 1)) {
        notes[k] = String(v);
      }
    }
  }

  return {
    rowCount,
    formulaRowCount,
    formulaColCounts,
    rows,
    ...(Object.keys(notes).length > 0 ? { notes } : {}),
    ...(notesGrid?.__dateCells && Object.keys(notesGrid.__dateCells).length > 0 ? { dateCells: notesGrid.__dateCells } : {}),
    ...(notesGrid?.__bg_colors && Object.keys(notesGrid.__bg_colors).length > 0 ? { bgColors: notesGrid.__bg_colors } : {}),
  };
}

function extractBudgetRollups_(valuesGrid = [], notesGrid = {}, occupiedRowNumSet = new Set(), formulasGrid = []) {
  const rows = {};
  const notes = {};
  const formulaColCounts = {};
  const rowCount = Array.isArray(valuesGrid) ? valuesGrid.length : 0;
  const formulaRowCount = Array.isArray(formulasGrid) ? formulasGrid.length : 0;

  for (let r0 = 0; r0 < Math.min(Math.max(rowCount, formulaRowCount), 260); r0++) {
    if (r0 < rowCount) {
      const row = Array.isArray(valuesGrid[r0]) ? valuesGrid[r0] : [];
      const isOcc = occupiedRowNumSet.has(r0 + 1);
      const obj = isOcc
        ? extractSparseRowCells_(row, 66, MANAGED_BUDGET_COLS)
        : extractSparseRowCells_(row, 66);
      if (Object.keys(obj).length > 0) rows[String(r0)] = obj;
    }
    const vTrimLen = r0 < rowCount && Array.isArray(valuesGrid[r0]) ? trimTrailingEmptyGridCells_(valuesGrid[r0]).length : 0;
    const fTrimLen = r0 < formulaRowCount && Array.isArray(formulasGrid[r0]) ? trimTrailingEmptyGridCells_(formulasGrid[r0]).length : 0;
    if (fTrimLen > vTrimLen) {
      formulaColCounts[String(r0)] = fTrimLen;
    }
  }

  if (notesGrid && typeof notesGrid === "object") {
    for (const [k, v] of Object.entries(notesGrid)) {
      if (!k || k.startsWith("__") || PROTOTYPE_KEYS.has(k) || !v) continue;
      const r0 = parseInt(k.slice(0, k.indexOf(":")), 10);
      if (Number.isInteger(r0) && !occupiedRowNumSet.has(r0 + 1)) {
        notes[k] = String(v);
      }
    }
  }

  return {
    rowCount,
    formulaRowCount,
    formulaColCounts,
    rows,
    ...(Object.keys(notes).length > 0 ? { notes } : {}),
    ...(notesGrid?.__dateCells && Object.keys(notesGrid.__dateCells).length > 0 ? { dateCells: notesGrid.__dateCells } : {}),
    ...(notesGrid?.__bg_colors && Object.keys(notesGrid.__bg_colors).length > 0 ? { bgColors: notesGrid.__bg_colors } : {}),
  };
}

// ============================================================================
// 7. STRICT GRID COMPARATOR (100% VALUE, FORMULA, NOTE PARITY)
// ============================================================================

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

// ============================================================================
// 8. SCHEMA STATUS & OVERVIEW STATS
// ============================================================================

export async function checkPhase3RelationalSchemaStatus() {
  const migrationSql = readMigration0013Sql();
  if (!isSupabaseConfigured()) {
    return { configured: false, schemaReady: false, tables: [], migrationSql };
  }
  const supabase = getSupabaseAdmin();
  const [tableResults, clientsColProbe] = await Promise.all([
    Promise.all(
      PHASE3_INPUT_TABLES.map(async (t) => {
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
    supabase.from("clients").select("inputs_mode, inputs_read_mode").limit(1).then((r) => !r.error).catch(() => false),
  ]);

  const schemaReady = Boolean(clientsColProbe) && tableResults.every((t) => t.exists);
  return { configured: true, schemaReady, tables: tableResults, migrationSql };
}

export async function getPhase3RelationalOverviewStats(clientsData = []) {
  const migrationSql = readMigration0013Sql();
  const empty = {
    schemaReady: false,
    migrationSql,
    totalEmployees: 0,
    totalOutgoingItems: 0,
    totalContractorEntries: 0,
    totalNbClients: 0,
    totalBudgetItems: 0,
    totalCashAdjustments: 0,
    totalCashBankBalances: 0,
    backfilledClientsCount: 0,
    inputsModeClientsCount: 0,
    inputsReadModeClientsCount: 0,
  };
  if (!isSupabaseConfigured()) return empty;
  const supabase = getSupabaseAdmin();

  let schemaReady = false;
  let counts = [0, 0, 0, 0, 0, 0, 0];

  try {
    const probes = await Promise.all([
      ...PHASE3_INPUT_TABLES.map((t) => supabase.from(t.name).select("id").limit(1)),
      supabase.from("clients").select("inputs_mode").limit(1),
    ]);
    if (probes.every((r) => !r.error)) {
      const cntResps = await Promise.all(
        PHASE3_INPUT_TABLES.map((t) => supabase.from(t.name).select("id", { count: "exact", head: true }))
      );
      schemaReady = true;
      counts = cntResps.map((r) => r.count || 0);
    }
  } catch {
    schemaReady = false;
  }

  let backfilledClientsCount = 0;
  let inputsModeClientsCount = 0;
  let inputsReadModeClientsCount = 0;
  for (const c of clientsData || []) {
    if (c?.metadata?.relational_inputs_state?.lastBackfilledAt) backfilledClientsCount++;
    if ((c?.inputs_mode || c?.metadata?.inputs_mode) === "relational") inputsModeClientsCount++;
    if ((c?.inputs_read_mode || c?.metadata?.inputs_read_mode) === "relational") inputsReadModeClientsCount++;
  }

  return {
    schemaReady,
    migrationSql,
    totalEmployees: counts[0],
    totalOutgoingItems: counts[1],
    totalContractorEntries: counts[2],
    totalNbClients: counts[3],
    totalBudgetItems: counts[4],
    totalCashAdjustments: counts[5],
    totalCashBankBalances: counts[6],
    backfilledClientsCount,
    inputsModeClientsCount,
    inputsReadModeClientsCount,
  };
}

// ============================================================================
// 9. TWO-WAY UUID-PRESERVING RECONCILER & BACKFILL
// ============================================================================

async function fetchPaginatedInputTable_(supabase, tableName, selectCols, clientId, extraFilter = null) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from(tableName)
      .select(selectCols)
      .eq("client_id", clientId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (typeof extraFilter === "function") q = extraFilter(q);
    const { data, error } = await q;
    if (error) throw new Error(`Failed loading ${tableName}: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function syncPulseNotesInputIdsForClient_(supabase, clientId) {
  const [notes, emps, outs, entries] = await Promise.all([
    fetchPaginatedInputTable_(
      supabase,
      "pulse_notes",
      "id, entity_type, entity_key, parent_entity_key, employee_id, outgoing_item_id, contractor_entry_id",
      clientId,
      (q) => q.is("deleted_at", null).in("entity_type", ["employee", "outgoing", "contractor", "dividend", "contractor_bill"])
    ),
    fetchPaginatedInputTable_(supabase, "pulse_employees", "id, employee_name", clientId),
    fetchPaginatedInputTable_(supabase, "pulse_outgoing_items", "id, section, name, sheet_row_num", clientId),
    fetchPaginatedInputTable_(
      supabase,
      "pulse_contractor_entries",
      "id, outgoing_item_id, external_app_id",
      clientId,
      (q) => q.neq("external_app_id", "")
    ),
  ]);
  if (!Array.isArray(notes) || notes.length === 0) return;

  const empIdByKey = new Map();
  for (const e of emps || []) {
    if (e.employee_name) empIdByKey.set(buildEmployeeNoteKey(e.employee_name), e.id);
  }

  const outIdByKey = new Map();
  for (const o of outs || []) {
    if (!o.name) continue;
    if (o.section === "contractor" || o.section === "making_up_cos") outIdByKey.set(buildContractorRowNoteKey(o.name), o.id);
    else if (o.section === "dividend") outIdByKey.set(buildDividendRowNoteKey(o.name), o.id);
    else outIdByKey.set(buildOutgoingRowNoteKey(o.name), o.id);
  }

  const entryByAppKey = new Map();
  for (const ce of entries || []) {
    if (ce.external_app_id) {
      entryByAppKey.set(buildContractorBillNoteKey("", "", { appId: ce.external_app_id }), ce);
    }
  }

  const updates = [];
  for (const n of notes) {
    const patch = {};
    if (n.entity_type === "employee") {
      const eId = empIdByKey.get(n.entity_key) || null;
      if (eId && n.employee_id !== eId) patch.employee_id = eId;
    } else if (n.entity_type === "outgoing" || n.entity_type === "contractor" || n.entity_type === "dividend") {
      const lookup = n.parent_entity_key || n.entity_key;
      const oId = outIdByKey.get(lookup) || outIdByKey.get(n.entity_key) || null;
      if (oId && n.outgoing_item_id !== oId) patch.outgoing_item_id = oId;
    } else if (n.entity_type === "contractor_bill") {
      const ce = entryByAppKey.get(n.entity_key) || null;
      const parentId = ce?.outgoing_item_id || outIdByKey.get(n.parent_entity_key) || null;
      if (ce?.id && n.contractor_entry_id !== ce.id) patch.contractor_entry_id = ce.id;
      if (parentId && n.outgoing_item_id !== parentId) patch.outgoing_item_id = parentId;
    }
    if (Object.keys(patch).length > 0) {
      updates.push(supabase.from("pulse_notes").update(patch).eq("id", n.id));
    }
  }
  if (updates.length > 0) {
    await Promise.all(updates.map((p) => Promise.resolve(p).catch(() => { })));
  }
}

async function reconcileRowBasedTable_(supabase, tableName, desiredRows, existingRows, matchKeyFn, numericCols, jsonCols, forceFullUpsert) {
  const existingByRow = new Map();
  const existingByIdentity = new Map();
  for (const er of existingRows || []) {
    if (er.sheet_row_num !== null && er.sheet_row_num !== undefined) {
      existingByRow.set(Number(er.sheet_row_num), er);
    }
    const ik = matchKeyFn(er);
    if (ik && !existingByIdentity.has(ik)) existingByIdentity.set(ik, er);
  }

  const usedIds = new Set();
  const toUpsert = [];
  const toInsert = [];
  const resolvedRows = [];

  for (const row of desiredRows) {
    const ik = matchKeyFn(row);
    let prev = null;
    if (ik) {
      const cand = existingByIdentity.get(ik);
      if (cand && !usedIds.has(cand.id)) prev = cand;
    }
    if (!prev && row.sheet_row_num !== null && row.sheet_row_num !== undefined) {
      const cand = existingByRow.get(Number(row.sheet_row_num));
      if (cand && !usedIds.has(cand.id)) prev = cand;
    }

    if (prev) {
      usedIds.add(prev.id);
      const payload = { id: prev.id, ...row };
      resolvedRows.push(payload);
      if (forceFullUpsert || hasRecordChanged_(prev, payload, numericCols, jsonCols)) {
        toUpsert.push(payload);
      }
    } else {
      toInsert.push({ row, idx: resolvedRows.length });
      resolvedRows.push(row);
    }
  }

  const obsoleteIds = (existingRows || []).filter((e) => !usedIds.has(e.id)).map((e) => e.id);
  for (let i = 0; i < obsoleteIds.length; i += 200) {
    const { error } = await supabase.from(tableName).delete().in("id", obsoleteIds.slice(i, i + 200));
    if (error) throw new Error(`Failed deleting ${tableName}: ${error.message}`);
  }
  for (let i = 0; i < toUpsert.length; i += 200) {
    const { error } = await supabase.from(tableName).upsert(toUpsert.slice(i, i + 200), { onConflict: "id" });
    if (error) throw new Error(`Failed updating ${tableName}: ${error.message}`);
  }
  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += 200) {
      const slice = toInsert.slice(i, i + 200);
      const { data: inserted, error } = await supabase
        .from(tableName)
        .insert(slice.map((s) => s.row))
        .select("*");
      if (error) throw new Error(`Failed inserting ${tableName}: ${error.message}`);
      (inserted || []).forEach((rec, j) => {
        resolvedRows[slice[j].idx] = rec;
      });
    }
  }

  return {
    resolvedRows,
    mutatedCount: toUpsert.length + toInsert.length + obsoleteIds.length,
  };
}

const ALL_INPUT_TABS = ["Salaries", "Outgoings", "OutgNotes", "NBtoFind", "Budget", "Cash"];

async function runSingleInputReconcilePass_(ctx, targetTabs, options = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return null;

  const forceFullUpsert = Boolean(options.forceFullUpsert);
  const preloaded = options.preloadedGrids || {};
  const tabSet = new Set(targetTabs);
  const needOutgoings = tabSet.has("Outgoings") || tabSet.has("OutgNotes");
  const tabsToLoad = [...new Set([...targetTabs, ...(needOutgoings ? ["Outgoings"] : [])])];

  const loadedGrids = {};
  await Promise.all(
    tabsToLoad.map(async (tabName) => {
      if (preloaded[tabName]) {
        loadedGrids[tabName] = {
          values_grid: preloaded[tabName].values || preloaded[tabName].values_grid || [],
          formulas_grid: preloaded[tabName].formulas || preloaded[tabName].formulas_grid || [],
          notes_grid: preloaded[tabName].notes || preloaded[tabName].notes_grid || {},
        };
      } else {
        const strictNative = Boolean(ctx.gridStorageRetired || ctx.clientComputeMode === "native");
        let rec = null;
        try {
          rec = await getOrLoadVirtualTabGrid_(ctx, "client", tabName, null, { includeNotes: true });
        } catch (err) {
          if (strictNative) throw err;
          rec = null;
        }
        loadedGrids[tabName] = rec || {
          values_grid: [],
          formulas_grid: [],
          notes_grid: {},
        };
      }
    })
  );

  const clMetaResp = await supabase.from("clients").select("metadata").eq("id", ctx.clientId).maybeSingle();
  const hasValidClMeta = !clMetaResp?.error && Boolean(clMetaResp?.data);
  const prevMeta = hasValidClMeta && clMetaResp.data.metadata && typeof clMetaResp.data.metadata === "object" ? clMetaResp.data.metadata : {};
  const prevState = prevMeta.relational_inputs_state && typeof prevMeta.relational_inputs_state === "object" ? prevMeta.relational_inputs_state : {};
  const prevTabHeaders = prevState.tabHeaders && typeof prevState.tabHeaders === "object" ? prevState.tabHeaders : {};
  const nextTabHeaders = { ...prevTabHeaders };
  for (const tName of tabsToLoad) {
    if (Array.isArray(loadedGrids[tName]?.values_grid?.[0])) {
      nextTabHeaders[tName] = loadedGrids[tName].values_grid[0].map((v) => (v === undefined || v === null ? "" : String(v)));
    }
  }

  let employeesCount = Number(prevState.employeesCount || 0);
  let outgoingItemsCount = Number(prevState.outgoingItemsCount || 0);
  let contractorEntriesCount = Number(prevState.contractorEntriesCount || 0);
  let budgetItemsCount = Number(prevState.budgetItemsCount || 0);
  let cashAdjustmentsCount = Number(prevState.cashAdjustmentsCount || 0);
  let cashBankBalancesCount = Number(prevState.cashBankBalancesCount || 0);
  const deltaStats = {
    employeesMutated: 0,
    outgoingItemsMutated: 0,
    contractorEntriesMutated: 0,
    nbToFindMutated: 0,
    budgetItemsMutated: 0,
    cashAdjustmentsMutated: 0,
    cashBankBalancesMutated: 0,
  };

  let salRollups = null;
  let outRollups = null;
  let budRollups = null;

  if (tabSet.has("Salaries")) {
    const g = loadedGrids.Salaries || {};
    const existing = await fetchAllRowsForClient_(supabase, "pulse_employees", ctx.clientId);
    const desired = parseSalariesTabToEmployees({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      valuesGrid: g.values_grid,
      formulasGrid: g.formulas_grid,
      notesGrid: g.notes_grid,
    });
    const r = await reconcileRowBasedTable_(
      supabase,
      "pulse_employees",
      desired,
      existing,
      (x) => (x.employee_name ? normalizeTextKey_(x.employee_name) : `row:${x.sheet_row_num}`),
      ["sort_order", "sheet_row_num", "fte_salary", "fte", "delivery_pct"],
      ["monthly_overrides", "monthly_forecasts", "monthly_effective", "raw_scalars", "custom_formulas", "cell_notes"],
      forceFullUpsert
    );
    employeesCount = desired.length;
    deltaStats.employeesMutated = r.mutatedCount;
    salRollups = extractSalariesRollups_(
      g.values_grid,
      g.notes_grid,
      new Set(desired.map((e) => Number(e.sheet_row_num) - 1))
    );
  }

  let outgoingItemByRow = new Map();
  if (needOutgoings) {
    const existingOuts = await fetchAllRowsForClient_(supabase, "pulse_outgoing_items", ctx.clientId);
    if (tabSet.has("Outgoings")) {
      const g = loadedGrids.Outgoings || {};
      const desiredOuts = parseOutgoingsTabToItems({
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        valuesGrid: g.values_grid,
        formulasGrid: g.formulas_grid,
        notesGrid: g.notes_grid,
      });
      if (!options?.allowClearAllNotes) {
        const countCellNotes = (list) =>
          (list || []).reduce((sum, item) => {
            const cn = item?.cell_notes && typeof item.cell_notes === "object" ? item.cell_notes : {};
            return sum + Object.keys(cn).filter((ck) => String(cn[ck] ?? "").trim() !== "").length;
          }, 0);
        const existingTotalNotes = countCellNotes(existingOuts);
        const desiredTotalNotes = countCellNotes(desiredOuts);
        if (existingTotalNotes >= 5 && desiredTotalNotes === 0) {
          const outKey = (x) =>
            x.name ? `${x.section}::${normalizeTextKey_(x.name)}` : `${x.section}::row:${x.sheet_row_num}`;
          const existingByKey = new Map();
          const existingByRow = new Map();
          for (const ex of existingOuts || []) {
            existingByKey.set(outKey(ex), ex);
            if (ex.sheet_row_num) existingByRow.set(Number(ex.sheet_row_num), ex);
          }
          let restoredItemNotes = 0;
          for (const item of desiredOuts) {
            const match = existingByKey.get(outKey(item)) || existingByRow.get(Number(item.sheet_row_num));
            if (match?.cell_notes && Object.keys(match.cell_notes).length > 0) {
              item.cell_notes = { ...match.cell_notes };
              restoredItemNotes++;
            }
          }
          if (restoredItemNotes > 0) {
            console.warn(
              `[relationalInputsService] Preserved existing Outgoings cell_notes across ${restoredItemNotes} item(s) for ${ctx.clientName} against empty-notes write.`
            );
          }
        }
      }
      const r = await reconcileRowBasedTable_(
        supabase,
        "pulse_outgoing_items",
        desiredOuts,
        existingOuts,
        (x) => (x.name ? `${x.section}::${normalizeTextKey_(x.name)}` : `${x.section}::row:${x.sheet_row_num}`),
        ["sort_order", "sheet_row_num", "delivery_pct"],
        ["monthly_amounts", "fy_totals", "raw_scalars", "custom_formulas", "cell_notes"],
        forceFullUpsert
      );
      outgoingItemsCount = desiredOuts.length;
      deltaStats.outgoingItemsMutated = r.mutatedCount;
      for (const item of r.resolvedRows) {
        if (item.sheet_row_num) outgoingItemByRow.set(Number(item.sheet_row_num), item);
      }
      outRollups = extractOutgoingsRollups_(
        g.values_grid,
        g.notes_grid,
        new Set(desiredOuts.map((o) => Number(o.sheet_row_num))),
        g.formulas_grid
      );
    } else {
      for (const item of existingOuts) {
        if (item.sheet_row_num) outgoingItemByRow.set(Number(item.sheet_row_num), item);
      }
    }
  }

  if (tabSet.has("OutgNotes")) {
    const g = loadedGrids.OutgNotes || {};
    const [existingEntries, accDirectRows] = await Promise.all([
      fetchAllRowsForClient_(supabase, "pulse_contractor_entries", ctx.clientId),
      fetchPaginatedInputTable_(supabase, "accounting_direct_costs", "id, external_id", ctx.clientId),
    ]);
    const accCostFkByExtId = new Map();
    for (const r of accDirectRows || []) {
      const k = normalizeTextKey_(r.external_id);
      if (k) accCostFkByExtId.set(k, r.id);
    }

    const desiredEntries = parseOutgNotesTabToContractorEntries({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      valuesGrid: g.values_grid,
      formulasGrid: g.formulas_grid,
      outgoingItemByRow,
      accCostFkByExtId,
    });

    const byAppId = new Map();
    const byCellSlot = new Map();
    for (const ee of existingEntries) {
      const ak = normalizeTextKey_(ee.external_app_id);
      if (ak && !ee.is_placeholder) byAppId.set(ak, ee);
      byCellSlot.set(`${ee.sheet_row_num}:${ee.sheet_col_idx}:${ee.block_order}`, ee);
    }

    const usedIds = new Set();
    const toUpsert = [];
    const toInsert = [];
    for (const ce of desiredEntries) {
      const ak = normalizeTextKey_(ce.external_app_id);
      let prev = ak && !ce.is_placeholder ? byAppId.get(ak) : null;
      if (prev && usedIds.has(prev.id)) prev = null;
      if (!prev) {
        const slotCand = byCellSlot.get(`${ce.sheet_row_num}:${ce.sheet_col_idx}:${ce.block_order}`);
        if (slotCand && !usedIds.has(slotCand.id)) prev = slotCand;
      }
      if (prev) {
        usedIds.add(prev.id);
        const payload = { id: prev.id, ...ce };
        if (forceFullUpsert || hasRecordChanged_(prev, payload, ["sheet_row_num", "sheet_col_idx", "fy_index", "month_index", "block_order", "amount"])) {
          toUpsert.push(payload);
        }
      } else {
        toInsert.push(ce);
      }
    }

    const obsIds = existingEntries.filter((e) => !usedIds.has(e.id)).map((e) => e.id);
    for (let i = 0; i < obsIds.length; i += 200) {
      const { error } = await supabase.from("pulse_contractor_entries").delete().in("id", obsIds.slice(i, i + 200));
      if (error) throw new Error(`Failed deleting pulse_contractor_entries: ${error.message}`);
    }
    for (let i = 0; i < toUpsert.length; i += 200) {
      const { error } = await supabase.from("pulse_contractor_entries").upsert(toUpsert.slice(i, i + 200), { onConflict: "id" });
      if (error) throw new Error(`Failed updating pulse_contractor_entries: ${error.message}`);
    }
    for (let i = 0; i < toInsert.length; i += 200) {
      const { error } = await supabase.from("pulse_contractor_entries").insert(toInsert.slice(i, i + 200));
      if (error) throw new Error(`Failed inserting pulse_contractor_entries: ${error.message}`);
    }
    contractorEntriesCount = desiredEntries.length;
    deltaStats.contractorEntriesMutated = toUpsert.length + toInsert.length + obsIds.length;
  }

  if (tabSet.has("Budget")) {
    const g = loadedGrids.Budget || {};
    const existingBudget = await fetchAllRowsForClient_(supabase, "pulse_budget_items", ctx.clientId);
    const desiredBudget = parseBudgetTabToItems({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      valuesGrid: g.values_grid,
      formulasGrid: g.formulas_grid,
      notesGrid: g.notes_grid,
    });
    const r = await reconcileRowBasedTable_(
      supabase,
      "pulse_budget_items",
      desiredBudget,
      existingBudget,
      (x) => (x.name ? `${x.section}::${x.sheet_row_num}::${normalizeTextKey_(x.name)}` : `${x.section}::row:${x.sheet_row_num}`),
      ["sort_order", "sheet_row_num", "equiv_salary", "delivery_pct", "making_up_cos_pct"],
      ["monthly_values", "fy_totals", "raw_scalars", "custom_formulas", "cell_notes"],
      forceFullUpsert
    );
    budgetItemsCount = desiredBudget.length;
    deltaStats.budgetItemsMutated = r.mutatedCount;
    budRollups = extractBudgetRollups_(
      g.values_grid,
      g.notes_grid,
      new Set(desiredBudget.map((b) => Number(b.sheet_row_num))),
      g.formulas_grid
    );
  }

  if (tabSet.has("NBtoFind") || salRollups || outRollups || budRollups) {
    const { data: existingNb, error: nbErr } = await supabase
      .from("pulse_nb_to_find")
      .select("*")
      .eq("client_id", ctx.clientId)
      .maybeSingle();
    if (nbErr) {
      throw new Error(`pulse_nb_to_find load failed (${ctx.clientName}): ${nbErr.message}`);
    }

    let baseNbRecord = existingNb;
    if (tabSet.has("NBtoFind") || !existingNb) {
      let nbG = loadedGrids.NBtoFind;
      if (!nbG) {
        const strictNative = Boolean(ctx.gridStorageRetired || ctx.clientComputeMode === "native");
        try {
          nbG = await getOrLoadVirtualTabGrid_(ctx, "client", "NBtoFind", null, { includeNotes: true });
        } catch (err) {
          if (strictNative) throw err;
          nbG = null;
        }
        nbG = nbG || { values_grid: [], formulas_grid: [], notes_grid: {} };
      }
      baseNbRecord = parseNbToFindTabToRecord({
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        valuesGrid: nbG.values_grid,
        formulasGrid: nbG.formulas_grid,
        notesGrid: nbG.notes_grid,
      });
    }

    const prevRollups = existingNb?.reconciled_rollups && typeof existingNb.reconciled_rollups === "object"
      ? existingNb.reconciled_rollups
      : {};
    const nextRollups = {
      ...prevRollups,
      ...(tabSet.has("NBtoFind") || !existingNb ? baseNbRecord.reconciled_rollups : {}),
      ...(salRollups ? { _salariesRollups: salRollups } : {}),
      ...(outRollups ? { _outgoingsRollups: outRollups } : {}),
      ...(budRollups ? { _budgetRollups: budRollups } : {}),
    };
    const nbPayload = {
      ...(existingNb?.id ? { id: existingNb.id } : {}),
      ...(tabSet.has("NBtoFind") || !existingNb ? baseNbRecord : existingNb),
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      reconciled_rollups: nextRollups,
    };
    delete nbPayload.created_at;
    delete nbPayload.updated_at;

    const changed =
      forceFullUpsert ||
      !existingNb ||
      hasRecordChanged_(
        existingNb,
        nbPayload,
        [],
        [
          "manual_revenue_targets",
          "manual_direct_costs",
          "total_income_targets",
          "budget_targets",
          "dc_calc_row",
          "use_nb_flags",
          "reconciled_rollups",
          "raw_cells",
          "custom_formulas",
          "cell_notes",
        ]
      );
    if (changed) {
      const { error } = await supabase.from("pulse_nb_to_find").upsert(nbPayload, { onConflict: "client_id" });
      if (error) throw new Error(`Failed upserting pulse_nb_to_find: ${error.message}`);
      deltaStats.nbToFindMutated = 1;
    }
  }

  if (tabSet.has("Cash") || options.includeBankBreakdowns) {
    if (tabSet.has("Cash")) {
      const g = loadedGrids.Cash || {};
      const existingCash = await fetchAllRowsForClient_(supabase, "pulse_cash_adjustments", ctx.clientId);
      const desiredCash = parseCashTabToAdjustments({
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        valuesGrid: g.values_grid,
        formulasGrid: g.formulas_grid,
        notesGrid: g.notes_grid,
      });

      const byCoord = new Map(existingCash.map((r) => [`${r.sheet_row_num}:${r.sheet_col_idx}`, r]));
      const usedCoords = new Set();
      const cashToUpdate = [];
      const cashToInsertByCoord = new Map();
      for (const adj of desiredCash) {
        const ck = `${adj.sheet_row_num}:${adj.sheet_col_idx}`;
        usedCoords.add(ck);
        const prev = byCoord.get(ck);
        if (prev?.id) {
          const payload = { id: prev.id, ...adj };
          if (forceFullUpsert || hasRecordChanged_(prev, payload, ["sheet_row_num", "sheet_col_idx", "numeric_value"], ["raw_value"])) {
            cashToUpdate.push(payload);
          }
        } else {
          cashToInsertByCoord.set(ck, { ...adj });
        }
      }
      const cashToInsert = [...cashToInsertByCoord.values()];
      const obsIds = existingCash.filter((r) => !usedCoords.has(`${r.sheet_row_num}:${r.sheet_col_idx}`)).map((r) => r.id);
      for (let i = 0; i < obsIds.length; i += 200) {
        const { error } = await supabase.from("pulse_cash_adjustments").delete().in("id", obsIds.slice(i, i + 200));
        if (error) throw new Error(`Failed deleting pulse_cash_adjustments: ${error.message}`);
      }
      for (let i = 0; i < cashToUpdate.length; i += 200) {
        const { error } = await supabase
          .from("pulse_cash_adjustments")
          .upsert(cashToUpdate.slice(i, i + 200), { onConflict: "id" });
        if (error) throw new Error(`Failed updating pulse_cash_adjustments: ${error.message}`);
      }
      for (let i = 0; i < cashToInsert.length; i += 200) {
        const { error } = await supabase
          .from("pulse_cash_adjustments")
          .insert(cashToInsert.slice(i, i + 200));
        if (error) throw new Error(`Failed inserting pulse_cash_adjustments: ${error.message}`);
      }
      cashAdjustmentsCount = desiredCash.length;
      deltaStats.cashAdjustmentsMutated = cashToUpdate.length + cashToInsert.length + obsIds.length;
    }

    if (options.includeBankBreakdowns || tabSet.has("Cash")) {
      const [existingBk, breakdownData] = await Promise.all([
        fetchAllRowsForClient_(supabase, "pulse_cash_bank_balances", ctx.clientId),
        getClientCashBankBreakdowns(ctx.clientName, { forceSource: "system_config", throwOnError: true }),
      ]);
      const desiredBk = parseBankBreakdownsToRelational({
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        breakdownData,
      });
      const bkByMonth = new Map(existingBk.map((b) => [b.period_ym, b]));
      const usedMonths = new Set();
      const bkToUpdate = [];
      const bkToInsertByMonth = new Map();
      for (const bk of desiredBk) {
        usedMonths.add(bk.period_ym);
        const prev = bkByMonth.get(bk.period_ym);
        if (prev?.id) {
          const payload = { id: prev.id, ...bk };
          if (forceFullUpsert || hasRecordChanged_(prev, payload, ["total_balance"], ["accounts"])) {
            bkToUpdate.push(payload);
          }
        } else {
          bkToInsertByMonth.set(bk.period_ym, { ...bk });
        }
      }
      const bkToInsert = [...bkToInsertByMonth.values()];
      const obsBkIds = existingBk.filter((b) => !usedMonths.has(b.period_ym)).map((b) => b.id);
      if (obsBkIds.length > 0) {
        for (let i = 0; i < obsBkIds.length; i += 200) {
          const { error } = await supabase.from("pulse_cash_bank_balances").delete().in("id", obsBkIds.slice(i, i + 200));
          if (error) throw new Error(`Failed deleting pulse_cash_bank_balances: ${error.message}`);
        }
      }
      for (let i = 0; i < bkToUpdate.length; i += 200) {
        const { error } = await supabase
          .from("pulse_cash_bank_balances")
          .upsert(bkToUpdate.slice(i, i + 200), { onConflict: "id" });
        if (error) throw new Error(`Failed updating pulse_cash_bank_balances: ${error.message}`);
      }
      for (let i = 0; i < bkToInsert.length; i += 200) {
        const { error } = await supabase
          .from("pulse_cash_bank_balances")
          .insert(bkToInsert.slice(i, i + 200));
        if (error) throw new Error(`Failed inserting pulse_cash_bank_balances: ${error.message}`);
      }
      cashBankBalancesCount = desiredBk.length;
      deltaStats.cashBankBalancesMutated = bkToUpdate.length + bkToInsert.length + obsBkIds.length;
    }
  }

  await syncPulseNotesInputIdsForClient_(supabase, ctx.clientId).catch(() => { });

  const nowIso = new Date().toISOString();
  const summary = {
    clientName: ctx.clientName,
    lastBackfilledAt: options.updateBackfillTimestamp ? nowIso : prevState.lastBackfilledAt || nowIso,
    lastReconciledAt: nowIso,
    employeesCount,
    outgoingItemsCount,
    contractorEntriesCount,
    budgetItemsCount,
    cashAdjustmentsCount,
    cashBankBalancesCount,
    tabHeaders: nextTabHeaders,
    deltaStats,
  };

  if (hasValidClMeta) {
    await supabase
      .from("clients")
      .update({
        metadata: {
          ...prevMeta,
          relational_inputs_state: summary,
        },
      })
      .eq("id", ctx.clientId);
  }

  return summary;
}

export async function reconcileClientOperatingInputsFromGrids(
  ctxOrClientName,
  tabNames = ALL_INPUT_TABS,
  options = {}
) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const targetTabs = [...new Set((Array.isArray(tabNames) ? tabNames : []).filter((t) => ALL_INPUT_TABS.includes(t)))];
  if (targetTabs.length === 0) return null;

  const key = String(ctx.clientName || ctx.clientId).trim().toLowerCase();
  const pendingEntry = _pendingInputReconcileByClient.get(key) || { tabs: new Set(), opts: {} };
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
    includeBankBreakdowns: Boolean(prevOpts.includeBankBreakdowns || options?.includeBankBreakdowns),
    allowClearAllNotes: Boolean(prevOpts.allowClearAllNotes || options?.allowClearAllNotes),
    ...(mergedPreloaded ? { preloadedGrids: mergedPreloaded } : {}),
  };
  _pendingInputReconcileByClient.set(key, pendingEntry);

  if (_inFlightInputReconcileByClient.has(key)) {
    return _inFlightInputReconcileByClient.get(key);
  }

  const runner = (async () => {
    let lastSummary = null;
    while (_pendingInputReconcileByClient.has(key)) {
      const next = _pendingInputReconcileByClient.get(key);
      _pendingInputReconcileByClient.delete(key);
      const tabsToRun = [...next.tabs];
      if (tabsToRun.length === 0) break;
      lastSummary = await runSingleInputReconcilePass_(ctx, tabsToRun, next.opts);
    }
    return lastSummary;
  })();

  _inFlightInputReconcileByClient.set(key, runner);
  try {
    return await runner;
  } finally {
    if (_inFlightInputReconcileByClient.get(key) === runner) {
      _inFlightInputReconcileByClient.delete(key);
    }
  }
}

export async function backfillClientOperatingInputs(clientName) {
  const schema = await checkPhase3RelationalSchemaStatus();
  if (!schema.schemaReady) {
    throw new Error("Migration 0013 must be applied in Supabase SQL Editor before backfilling operating inputs.");
  }
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) {
    throw new Error(`Client "${clientName}" was not found in Supabase.`);
  }
  if (ctx.gridStorageRetired) {
    return {
      clientName: ctx.clientName,
      skippedRetired: true,
      employeesCount: 0,
      outgoingItemsCount: 0,
      contractorEntriesCount: 0,
      budgetItemsCount: 0,
      cashAdjustmentsCount: 0,
      cashBankBalancesCount: 0,
    };
  }
  return reconcileClientOperatingInputsFromGrids(ctx, ALL_INPUT_TABS, {
    forceFullUpsert: true,
    updateBackfillTimestamp: true,
    includeBankBreakdowns: true,
  });
}

export async function backfillAllClientsOperatingInputs() {
  const schema = await checkPhase3RelationalSchemaStatus();
  if (!schema.schemaReady) {
    throw new Error("Migration 0013 must be applied in Supabase SQL Editor before backfilling operating inputs.");
  }
  const supabase = getSupabaseAdmin();
  const { data: clients, error } = await supabase.from("clients").select("client_name").order("client_name");
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    try {
      const s = await backfillClientOperatingInputs(cl.client_name);
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

// ============================================================================
// 10. 100% LOSSLESS PARITY VERIFIER (IN-MEMORY & DB MODES)
// ============================================================================

export async function verifyRelationalInputsParity({ clientName = null, source = "auto" } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase3RelationalSchemaStatus();
  const cols = schema.schemaReady ? "id, client_name, inputs_mode, client_compute_mode, metadata" : "id, client_name, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  let { data: clients, error } = await query;
  if (error && String(error.message || "").includes("client_compute_mode")) {
    let fbQuery = supabase
      .from("clients")
      .select(schema.schemaReady ? "id, client_name, inputs_mode, metadata" : "id, client_name, metadata")
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
      const [salG, outG, outNg, nbG, budG, cashG, bkData] = await Promise.all([
        getOrLoadVirtualTabGrid_(ctx, "client", "Salaries", null, { includeNotes: true }),
        getOrLoadVirtualTabGrid_(ctx, "client", "Outgoings", null, { includeNotes: true }),
        getOrLoadVirtualTabGrid_(ctx, "client", "OutgNotes", null, { includeNotes: true }),
        getOrLoadVirtualTabGrid_(ctx, "client", "NBtoFind", null, { includeNotes: true }),
        getOrLoadVirtualTabGrid_(ctx, "client", "Budget", null, { includeNotes: true }),
        getOrLoadVirtualTabGrid_(ctx, "client", "Cash", null, { includeNotes: true }),
        getClientCashBankBreakdowns(cl.client_name, { forceSource: "system_config" }),
      ]);

      const canUseDb =
        schema.schemaReady &&
        (source === "db" || (source === "auto" && Boolean(cl.metadata?.relational_inputs_state?.lastBackfilledAt)));

      let usedSource = "in_memory";
      let employees = [];
      let outgoingItems = [];
      let contractorEntries = [];
      let nbRecord = null;
      let budgetItems = [];
      let cashAdjustments = [];
      let bankBalances = [];

      if (canUseDb) {
        usedSource = "db";
        const [dbEmp, dbOut, dbEntries, dbNbResp, dbBud, dbCash, dbBank] = await Promise.all([
          fetchAllRowsForClient_(supabase, "pulse_employees", cl.id),
          fetchAllRowsForClient_(supabase, "pulse_outgoing_items", cl.id),
          fetchAllRowsForClient_(supabase, "pulse_contractor_entries", cl.id),
          supabase.from("pulse_nb_to_find").select("*").eq("client_id", cl.id).maybeSingle(),
          fetchAllRowsForClient_(supabase, "pulse_budget_items", cl.id),
          fetchAllRowsForClient_(supabase, "pulse_cash_adjustments", cl.id),
          fetchAllRowsForClient_(supabase, "pulse_cash_bank_balances", cl.id),
        ]);
        employees = dbEmp;
        outgoingItems = dbOut;
        contractorEntries = dbEntries;
        nbRecord = dbNbResp?.data || null;
        budgetItems = dbBud;
        cashAdjustments = dbCash;
        bankBalances = dbBank;
      } else {
        employees = parseSalariesTabToEmployees({
          clientId: cl.id,
          clientName: cl.client_name,
          valuesGrid: salG?.values_grid || [],
          formulasGrid: salG?.formulas_grid || [],
          notesGrid: salG?.notes_grid || {},
        });
        outgoingItems = parseOutgoingsTabToItems({
          clientId: cl.id,
          clientName: cl.client_name,
          valuesGrid: outG?.values_grid || [],
          formulasGrid: outG?.formulas_grid || [],
          notesGrid: outG?.notes_grid || {},
        });
        const outByRow = new Map(outgoingItems.map((it) => [Number(it.sheet_row_num), it]));
        contractorEntries = parseOutgNotesTabToContractorEntries({
          clientId: cl.id,
          clientName: cl.client_name,
          valuesGrid: outNg?.values_grid || [],
          formulasGrid: outNg?.formulas_grid || [],
          outgoingItemByRow: outByRow,
        });
        nbRecord = parseNbToFindTabToRecord({
          clientId: cl.id,
          clientName: cl.client_name,
          valuesGrid: nbG?.values_grid || [],
          formulasGrid: nbG?.formulas_grid || [],
          notesGrid: nbG?.notes_grid || {},
        });
        budgetItems = parseBudgetTabToItems({
          clientId: cl.id,
          clientName: cl.client_name,
          valuesGrid: budG?.values_grid || [],
          formulasGrid: budG?.formulas_grid || [],
          notesGrid: budG?.notes_grid || {},
        });
        cashAdjustments = parseCashTabToAdjustments({
          clientId: cl.id,
          clientName: cl.client_name,
          valuesGrid: cashG?.values_grid || [],
          formulasGrid: cashG?.formulas_grid || [],
          notesGrid: cashG?.notes_grid || {},
        });
        bankBalances = parseBankBreakdownsToRelational({
          clientId: cl.id,
          clientName: cl.client_name,
          breakdownData: bkData,
        });
      }

      const projSal = projectEmployeesToSalariesGrid({
        employees,
        baseValuesGrid: salG?.values_grid || [],
        baseFormulasGrid: salG?.formulas_grid || [],
        baseNotesGrid: salG?.notes_grid || {},
      });
      const projOut = projectOutgoingItemsToGrid({
        items: outgoingItems,
        baseValuesGrid: outG?.values_grid || [],
        baseFormulasGrid: outG?.formulas_grid || [],
        baseNotesGrid: outG?.notes_grid || {},
      });
      const projOutN = projectContractorEntriesToOutgNotesGrid({
        entries: contractorEntries,
        baseValuesGrid: outNg?.values_grid || [],
        baseFormulasGrid: outNg?.formulas_grid || [],
        baseNotesGrid: outNg?.notes_grid || {},
      });
      const projNb = projectNbToFindRecordToGrid({
        record: nbRecord,
        baseValuesGrid: nbG?.values_grid || [],
        baseFormulasGrid: nbG?.formulas_grid || [],
        baseNotesGrid: nbG?.notes_grid || {},
      });
      const projBud = projectBudgetItemsToGrid({
        items: budgetItems,
        baseValuesGrid: budG?.values_grid || [],
        baseFormulasGrid: budG?.formulas_grid || [],
        baseNotesGrid: budG?.notes_grid || {},
      });
      const projCash = projectCashAdjustmentsToGrid({
        adjustments: cashAdjustments,
        baseValuesGrid: cashG?.values_grid || [],
        baseFormulasGrid: cashG?.formulas_grid || [],
        baseNotesGrid: cashG?.notes_grid || {},
      });

      const diffs = [
        ...compareGridsStrict_("Salaries", salG?.values_grid, salG?.formulas_grid, salG?.notes_grid, projSal.valuesGrid, projSal.formulasGrid, projSal.notesGrid),
        ...compareGridsStrict_("Outgoings", outG?.values_grid, outG?.formulas_grid, outG?.notes_grid, projOut.valuesGrid, projOut.formulasGrid, projOut.notesGrid),
        ...compareGridsStrict_("OutgNotes", outNg?.values_grid, outNg?.formulas_grid, outNg?.notes_grid, projOutN.valuesGrid, projOutN.formulasGrid, projOutN.notesGrid),
        ...compareGridsStrict_("NBtoFind", nbG?.values_grid, nbG?.formulas_grid, nbG?.notes_grid, projNb.valuesGrid, projNb.formulasGrid, projNb.notesGrid),
        ...compareGridsStrict_("Budget", budG?.values_grid, budG?.formulas_grid, budG?.notes_grid, projBud.valuesGrid, projBud.formulasGrid, projBud.notesGrid),
        ...compareGridsStrict_("Cash", cashG?.values_grid, cashG?.formulas_grid, cashG?.notes_grid, projCash.valuesGrid, projCash.formulasGrid, projCash.notesGrid),
      ];

      // Compare bank balance breakdowns against system_config
      const expectedBk = parseBankBreakdownsToRelational({
        clientId: cl.id,
        clientName: cl.client_name,
        breakdownData: bkData,
      });
      const normBk = (arr) =>
        [...(arr || [])]
          .map((x) => ({
            period_ym: x.period_ym,
            total_balance: Math.round((Number(x.total_balance) || 0) * 100) / 100,
            accounts: x.accounts || [],
          }))
          .sort((a, b) => a.period_ym.localeCompare(b.period_ym));
      if (stableJson_(normBk(expectedBk)) !== stableJson_(normBk(bankBalances))) {
        diffs.push({
          tabName: "CashBankBalances",
          kind: "bank_breakdown",
          expected: normBk(expectedBk),
          actual: normBk(bankBalances),
        });
      }

      results.push({
        clientName: cl.client_name,
        source: usedSource,
        inputsMode: cl.inputs_mode || cl.metadata?.inputs_mode || "grid",
        employeesCount: employees.length,
        outgoingItemsCount: outgoingItems.length,
        contractorEntriesCount: contractorEntries.length,
        budgetItemsCount: budgetItems.length,
        cashAdjustmentsCount: cashAdjustments.length,
        cashBankBalancesCount: bankBalances.length,
        totalMismatchCount: diffs.length,
        matched: diffs.length === 0,
        sampleMismatches: diffs.slice(0, 6),
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

export async function setClientInputsMode(clientName, inputsMode) {
  if (inputsMode !== "grid" && inputsMode !== "relational") {
    throw new Error("Invalid inputsMode. Expected 'grid' or 'relational'.");
  }
  const schema = await checkPhase3RelationalSchemaStatus();
  if (!schema.schemaReady) {
    throw new Error("Migration 0013 must be applied in Supabase SQL Editor before enabling relational inputs mode.");
  }

  const supabase = getSupabaseAdmin();
  const { data: cl, error: clErr } = await supabase
    .from("clients")
    .select("id, client_name, grid_storage_retired, metadata, client_sheet_id, master_sheet_id")
    .eq("client_name", clientName)
    .maybeSingle();
  if (clErr || !cl) throw new Error(`Client "${clientName}" not found.`);
  if (cl.grid_storage_retired && inputsMode !== "relational") {
    throw new Error(
      `Client "${clientName}" has retired grid storage and cannot be downgraded from 'relational' inputs_mode.`
    );
  }

  let backfillSummary = null;
  if (inputsMode === "relational" && !cl.grid_storage_retired) {
    backfillSummary = await backfillClientOperatingInputs(cl.client_name);
    const parity = await verifyRelationalInputsParity({ clientName: cl.client_name, source: "db" });
    const rec = parity.results?.[0];
    if (!rec || rec.error || rec.totalMismatchCount > 0) {
      throw new Error(
        `Phase 3 parity check failed for ${cl.client_name} (${rec?.error || `${rec?.totalMismatchCount} diffs`}). Mode unchanged.`
      );
    }
  }

  const nextMeta = {
    ...(cl.metadata && typeof cl.metadata === "object" ? cl.metadata : {}),
    ...(backfillSummary ? { relational_inputs_state: backfillSummary } : {}),
    inputs_mode: inputsMode,
  };
  const { error: updErr } = await supabase
    .from("clients")
    .update({ inputs_mode: inputsMode, metadata: nextMeta })
    .eq("id", cl.id);
  if (updErr) throw new Error(`Failed updating inputs_mode: ${updErr.message}`);

  invalidateSheetContextCache();
  if (cl.client_sheet_id) {
    await invalidatePmaClientCache(cl.client_sheet_id, cl.master_sheet_id || null, ["salaries", "outgoings", "expenses", "cash", "views", "budget"]).catch(() => { });
    if (redisClient?.isOpen) {
      await redisClient
        .del([
          `salaries_data:${cl.client_sheet_id}`,
          `pma_expenses_${cl.client_sheet_id}`,
          `pma_nbtofind_${cl.client_sheet_id}`,
          `pma_cash_${cl.client_sheet_id}`,
          `pulse:portal:budget:${cl.client_sheet_id}`,
          `pulse:portal:keydata:${cl.client_sheet_id}:all`,
        ])
        .catch(() => { });
    }
  }

  return {
    success: true,
    clientName: cl.client_name,
    inputsMode,
    backfillSummary,
  };
}

// ============================================================================
// 11. PHASE 3B: UUID ANCHORS, PURE-RELATIONAL TAB RECONSTRUCTION & READ PARITY
// ============================================================================

function buildInputsRelLookupFromArrays_({
  clientId,
  employees = [],
  outgoingItems = [],
  contractorEntries = [],
  budgetItems = [],
}) {
  const employeesByRow = new Map();
  const employeesByUuid = new Map();
  for (const e of employees || []) {
    if (e.sheet_row_num !== null && e.sheet_row_num !== undefined) {
      employeesByRow.set(Number(e.sheet_row_num), e);
    }
    if (e.id) employeesByUuid.set(e.id, e);
  }

  const outgoingsByRow = new Map();
  const outgoingsByUuid = new Map();
  for (const o of outgoingItems || []) {
    if (o.sheet_row_num !== null && o.sheet_row_num !== undefined) {
      outgoingsByRow.set(Number(o.sheet_row_num), o);
    }
    if (o.id) outgoingsByUuid.set(o.id, o);
  }

  const entriesByRowColOrder = new Map();
  const entriesByAppId = new Map();
  const entriesByUuid = new Map();
  const sortedEntries = [...(contractorEntries || [])].sort((a, b) =>
    (Number(a.sheet_row_num) - Number(b.sheet_row_num)) ||
    (Number(a.sheet_col_idx) - Number(b.sheet_col_idx)) ||
    (Number(a.block_order) - Number(b.block_order)) ||
    String(a.id || "").localeCompare(String(b.id || ""))
  );
  for (const ce of sortedEntries) {
    entriesByRowColOrder.set(`${ce.sheet_row_num}:${ce.sheet_col_idx}:${ce.block_order}`, ce);
    const ak = normalizeTextKey_(ce.external_app_id);
    if (ak && !ce.is_placeholder && !entriesByAppId.has(ak)) entriesByAppId.set(ak, ce);
    if (ce.id) entriesByUuid.set(ce.id, ce);
  }

  const budgetByRow = new Map();
  const budgetByUuid = new Map();
  for (const b of budgetItems || []) {
    if (b.sheet_row_num !== null && b.sheet_row_num !== undefined) {
      budgetByRow.set(Number(b.sheet_row_num), b);
    }
    if (b.id) budgetByUuid.set(b.id, b);
  }

  return {
    clientId,
    employeesByRow,
    employeesByUuid,
    outgoingsByRow,
    outgoingsByUuid,
    entriesByRowColOrder,
    entriesByAppId,
    budgetByRow,
    budgetByUuid,
  };
}

/**
 * Fast relational identity lookup map for hydrating operating inputs payloads with canonical UUIDs.
 */
export async function getClientRelationalInputsLookup(
  ctxOrClientName,
  { includeEmployees = true, includeOutgoing = true, includeEntries = false, includeBudget = false } = {}
) {
  if (!isSupabaseConfigured()) return null;
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const [employees, outgoingItems, contractorEntries, budgetItems] = await Promise.all([
    includeEmployees
      ? fetchAllRowsForClient_(supabase, "pulse_employees", ctx.clientId, { selectCols: "id, sheet_row_num, employee_name" })
      : Promise.resolve([]),
    includeOutgoing
      ? fetchAllRowsForClient_(supabase, "pulse_outgoing_items", ctx.clientId, { selectCols: "id, section, sheet_row_num, name" })
      : Promise.resolve([]),
    includeEntries
      ? fetchAllRowsForClient_(supabase, "pulse_contractor_entries", ctx.clientId, { selectCols: "id, outgoing_item_id, sheet_row_num, sheet_col_idx, block_order, external_app_id, is_placeholder" })
      : Promise.resolve([]),
    includeBudget
      ? fetchAllRowsForClient_(supabase, "pulse_budget_items", ctx.clientId, { selectCols: "id, section, sheet_row_num, name" })
      : Promise.resolve([]),
  ]);

  return buildInputsRelLookupFromArrays_({
    clientId: ctx.clientId,
    employees,
    outgoingItems,
    contractorEntries,
    budgetItems,
  });
}

/**
 * Resolves a caller-supplied `entityUuid` (`employee` | `outgoing_item` | `budget_item`)
 * strictly scoped to `ctx.clientId`, healing stale row numbers or throwing 409 if removed/moved.
 */
export async function resolveAuthoritativeInputAnchor({
  spreadsheetId = "",
  clientName = "",
  entityType = "",
  entityUuid = "",
  expectedSection = "",
  fallbackRowNum = null,
} = {}) {
  const ctx = await resolveSupabaseSheetContext({ spreadsheetId, clientName });
  const isRelational = ctx?.inputsMode === "relational";
  const cleanUuid = String(entityUuid || "").trim();

  if (!isRelational || !cleanUuid) {
    return {
      isRelational,
      resolved: false,
      entityUuid: cleanUuid || null,
      rowNum: fallbackRowNum !== null && fallbackRowNum !== undefined ? Number(fallbackRowNum) : null,
      record: null,
    };
  }

  if (!UUID_REGEX.test(cleanUuid)) {
    const err = new Error("Invalid item identifier.");
    err.statusCode = 400;
    throw err;
  }

  const tableByType = {
    employee: { table: "pulse_employees", cols: "id, client_id, sheet_row_num, employee_name" },
    outgoing_item: { table: "pulse_outgoing_items", cols: "id, client_id, section, sheet_row_num, name" },
    budget_item: { table: "pulse_budget_items", cols: "id, client_id, section, sheet_row_num, name" },
  };
  const cfg = tableByType[entityType];
  if (!cfg) {
    const err = new Error(`Unsupported entityType "${entityType}".`);
    err.statusCode = 400;
    throw err;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) {
    return {
      isRelational,
      resolved: false,
      entityUuid: cleanUuid,
      rowNum: fallbackRowNum !== null && fallbackRowNum !== undefined ? Number(fallbackRowNum) : null,
      record: null,
    };
  }

  const { data: rec, error } = await supabase
    .from(cfg.table)
    .select(cfg.cols)
    .eq("client_id", ctx.clientId)
    .eq("id", cleanUuid)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed verifying ${entityType} identity: ${error.message}`);
  }
  if (!rec) {
    const err = new Error("This item was modified or removed in another session. Please refresh and try again.");
    err.statusCode = 409;
    throw err;
  }
  if (expectedSection && rec.section && rec.section !== expectedSection) {
    const err = new Error("This item moved sections in another session. Please refresh and try again.");
    err.statusCode = 409;
    throw err;
  }

  return {
    isRelational: true,
    resolved: true,
    entityUuid: rec.id,
    rowNum: Number(rec.sheet_row_num),
    record: rec,
  };
}

/**
 * Preloads a client's normalized Phase 3 operating input tables in a single parallel batch
 * for pure-relational Phase 3B reads (zero `master_sheet_grids` reads).
 */
export async function preloadClientRelationalInputsBundle(
  ctxOrClientName,
  {
    includeSalaries = false,
    includeOutgoings = false,
    includeOutgNotes = false,
    includeNbToFind = false,
    includeBudget = false,
    includeCash = false,
    includeBankBalances = false,
  } = {}
) {
  if (!isSupabaseConfigured()) return null;
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const needNbRollups = includeSalaries || includeOutgoings || includeNbToFind || includeBudget;
  const [employees, outgoingItems, contractorEntries, nbResp, budgetItems, cashAdjustments, bankBalances] =
    await Promise.all([
      includeSalaries ? fetchAllRowsForClient_(supabase, "pulse_employees", ctx.clientId) : Promise.resolve([]),
      includeOutgoings ? fetchAllRowsForClient_(supabase, "pulse_outgoing_items", ctx.clientId) : Promise.resolve([]),
      includeOutgNotes ? fetchAllRowsForClient_(supabase, "pulse_contractor_entries", ctx.clientId) : Promise.resolve([]),
      needNbRollups
        ? supabase.from("pulse_nb_to_find").select("*").eq("client_id", ctx.clientId).maybeSingle()
        : Promise.resolve({ data: null }),
      includeBudget ? fetchAllRowsForClient_(supabase, "pulse_budget_items", ctx.clientId) : Promise.resolve([]),
      includeCash ? fetchAllRowsForClient_(supabase, "pulse_cash_adjustments", ctx.clientId) : Promise.resolve([]),
      includeBankBalances ? fetchAllRowsForClient_(supabase, "pulse_cash_bank_balances", ctx.clientId) : Promise.resolve([]),
    ]);

  const nbRecord = nbResp?.data || null;
  const rollups = nbRecord?.reconciled_rollups && typeof nbRecord.reconciled_rollups === "object"
    ? nbRecord.reconciled_rollups
    : {};

  return {
    ctx,
    clientId: ctx.clientId,
    employees,
    outgoingItems,
    contractorEntries,
    nbRecord,
    budgetItems,
    cashAdjustments,
    bankBalances,
    rollups,
    relLookup: buildInputsRelLookupFromArrays_({
      clientId: ctx.clientId,
      employees,
      outgoingItems,
      contractorEntries,
      budgetItems,
    }),
  };
}

function setGridCellDirect_(grid, r0, c0, val) {
  while (grid.length <= r0) grid.push([]);
  while (grid[r0].length <= c0) grid[r0].push("");
  grid[r0][c0] = val !== undefined && val !== null ? val : "";
}

function applySparseRollupsToGrid_(valuesGrid, sparseRows = {}) {
  if (!sparseRows || typeof sparseRows !== "object") return;
  for (const [rKey, rowObj] of Object.entries(sparseRows)) {
    const r0 = parseInt(rKey, 10);
    if (!Number.isInteger(r0) || r0 < 0 || !rowObj || typeof rowObj !== "object") continue;
    for (const [cKey, val] of Object.entries(rowObj)) {
      const c0 = parseInt(cKey, 10);
      if (!Number.isInteger(c0) || c0 < 0) continue;
      setGridCellDirect_(valuesGrid, r0, c0, val);
    }
  }
}

/**
 * Reconstructs `{ valuesGrid, notesGrid }` for an operating input tab strictly from
 * the preloaded Phase 3 relational bundle (zero `master_sheet_grids` / Sheet reads).
 */
export function reconstructRelationalTabFromBundle(bundle, tabName) {
  if (!bundle) return { valuesGrid: [], notesGrid: {} };
  const rollups = bundle.rollups && typeof bundle.rollups === "object" ? bundle.rollups : {};

  if (tabName === "Salaries") {
    const salR = rollups._salariesRollups && typeof rollups._salariesRollups === "object" ? rollups._salariesRollups : {};
    const targetLen = Math.max(0, Number(salR.rowCount) || 0);
    const valuesGrid = Array.from({ length: targetLen }, () => []);
    const notesGrid = {};
    if (salR.dateCells && typeof salR.dateCells === "object") notesGrid.__dateCells = salR.dateCells;
    if (salR.notes && typeof salR.notes === "object") {
      for (const [k, v] of Object.entries(salR.notes)) {
        if (!PROTOTYPE_KEYS.has(k) && v) notesGrid[k] = v;
      }
    }

    applySparseRollupsToGrid_(valuesGrid, salR.rows || {});

    for (const emp of bundle.employees || []) {
      const r0 = Number(emp.sheet_row_num) - 1;
      if (!Number.isInteger(r0) || r0 < 3 || r0 > 52) continue;
      const rawScalars = emp.raw_scalars && typeof emp.raw_scalars === "object" ? emp.raw_scalars : {};
      const monthlyOverrides = emp.monthly_overrides && typeof emp.monthly_overrides === "object" ? emp.monthly_overrides : {};
      const monthlyForecasts = emp.monthly_forecasts && typeof emp.monthly_forecasts === "object" ? emp.monthly_forecasts : {};
      const monthlyEffective = emp.monthly_effective && typeof emp.monthly_effective === "object" ? emp.monthly_effective : {};
      const customFormulas = emp.custom_formulas && typeof emp.custom_formulas === "object" ? emp.custom_formulas : {};
      const cellNotes = emp.cell_notes && typeof emp.cell_notes === "object" ? emp.cell_notes : {};

      const useScalarFallback =
        Object.keys(rawScalars).length === 0 &&
        Object.keys(monthlyOverrides).length === 0 &&
        Object.keys(customFormulas).length === 0 &&
        Object.keys(cellNotes).length === 0;
      const scalarFallback = {
        0: emp.employee_name || "",
        1: emp.role_title || "",
        2: emp.fte_salary ?? "",
        3: emp.fte ?? "",
        4: emp.start_date || "",
        5: emp.end_date || "",
        6: emp.delivery_pct ?? "",
        7: emp.student_loan_plan || "",
        8: emp.pension_pct || "",
      };
      for (let c = 0; c <= 8; c++) {
        const k = String(c);
        const val = Object.prototype.hasOwnProperty.call(rawScalars, k)
          ? rawScalars[k]
          : useScalarFallback
            ? scalarFallback[c]
            : "";
        if (isNonEmptyCell_(val)) setGridCellDirect_(valuesGrid, r0, c, val);
      }
      for (const [k, v] of Object.entries(monthlyOverrides)) {
        const c = parseInt(k, 10);
        if (Number.isInteger(c) && c >= 11 && isNonEmptyCell_(v)) setGridCellDirect_(valuesGrid, r0, c, v);
      }
      for (const [k, v] of Object.entries(monthlyForecasts)) {
        const c = parseInt(k, 10);
        if (Number.isInteger(c) && c >= 11 && isNonEmptyCell_(v)) setGridCellDirect_(valuesGrid, r0 + 150, c, v);
      }
      for (const [k, v] of Object.entries(monthlyEffective)) {
        const c = parseInt(k, 10);
        if (Number.isInteger(c) && c >= 0 && isNonEmptyCell_(v)) setGridCellDirect_(valuesGrid, r0 + 300, c, v);
      }
      for (const [k, nStr] of Object.entries(cellNotes)) {
        const c = parseInt(k, 10);
        if (Number.isInteger(c) && c >= 0 && nStr) notesGrid[`${r0}:${c}`] = nStr;
      }
    }

    for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
    return { valuesGrid, notesGrid };
  }

  if (tabName === "Outgoings") {
    const outR = rollups._outgoingsRollups && typeof rollups._outgoingsRollups === "object" ? rollups._outgoingsRollups : {};
    const targetLen = Math.max(0, Number(outR.rowCount) || 0);
    const valuesGrid = Array.from({ length: targetLen }, () => []);
    const notesGrid = {};
    if (outR.dateCells && typeof outR.dateCells === "object") notesGrid.__dateCells = outR.dateCells;
    if (outR.bgColors && typeof outR.bgColors === "object") notesGrid.__bg_colors = outR.bgColors;
    if (outR.formulaRowCount != null) notesGrid.__formulaRowCount = Number(outR.formulaRowCount) || 0;
    if (outR.formulaColCounts && typeof outR.formulaColCounts === "object") notesGrid.__formulaColCounts = outR.formulaColCounts;
    if (outR.notes && typeof outR.notes === "object") {
      for (const [k, v] of Object.entries(outR.notes)) {
        if (!PROTOTYPE_KEYS.has(k) && v) notesGrid[k] = v;
      }
    }

    applySparseRollupsToGrid_(valuesGrid, outR.rows || {});

    for (const it of bundle.outgoingItems || []) {
      const rowNum = Number(it.sheet_row_num);
      const r0 = rowNum - 1;
      if (!resolveOutgoingsSection_(rowNum)) continue;

      const rawScalars = it.raw_scalars && typeof it.raw_scalars === "object" ? it.raw_scalars : {};
      const monthlyAmounts = it.monthly_amounts && typeof it.monthly_amounts === "object" ? it.monthly_amounts : {};
      const fyTotals = it.fy_totals && typeof it.fy_totals === "object" ? it.fy_totals : {};
      const customFormulas = it.custom_formulas && typeof it.custom_formulas === "object" ? it.custom_formulas : {};
      const cellNotes = it.cell_notes && typeof it.cell_notes === "object" ? it.cell_notes : {};

      const useScalarFallback =
        Object.keys(rawScalars).length === 0 &&
        Object.keys(monthlyAmounts).length === 0 &&
        Object.keys(customFormulas).length === 0 &&
        Object.keys(cellNotes).length === 0;
      const scalarFallback = {
        0: it.name || "",
        1: it.vat_applicable || "",
        2: it.invoice_timing || "",
        3: it.payment_timing || "",
        4: it.delivery_pct ?? "",
      };
      for (let c = 0; c <= 5; c++) {
        const k = String(c);
        const hasRaw = Object.prototype.hasOwnProperty.call(rawScalars, k);
        const val = hasRaw ? rawScalars[k] : useScalarFallback && c <= 4 ? scalarFallback[c] : "";
        if (isNonEmptyCell_(val)) setGridCellDirect_(valuesGrid, r0, c, val);
      }
      for (const c of MONTHLY_48_COLS) {
        const k = String(c);
        const val = Object.prototype.hasOwnProperty.call(monthlyAmounts, k) ? monthlyAmounts[k] : "";
        if (isNonEmptyCell_(val)) setGridCellDirect_(valuesGrid, r0, c, val);
      }
      for (const b of YEAR_MONTH_BANDS) {
        const tv = fyTotals[String(b.fyIndex)];
        if (isNonEmptyCell_(tv)) setGridCellDirect_(valuesGrid, r0, b.totalCol, tv);
      }
      for (const [k, nStr] of Object.entries(cellNotes)) {
        const c = parseInt(k, 10);
        if (Number.isInteger(c) && c >= 0 && nStr) notesGrid[`${r0}:${c}`] = nStr;
      }
    }

    for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
    return { valuesGrid, notesGrid };
  }

  if (tabName === "OutgNotes") {
    const outHdr = rollups._outgoingsRollups?.rows?.["0"] || null;
    const valuesGrid = Array.from({ length: 112 }, () => []);
    if (outHdr) applySparseRollupsToGrid_(valuesGrid, { 0: outHdr });
    const byCell = new Map();
    for (const e of bundle.contractorEntries || []) {
      const k = `${e.sheet_row_num}:${e.sheet_col_idx}`;
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k).push(e);
    }
    for (const list of byCell.values()) {
      list.sort((a, b) => (Number(a.block_order) || 0) - (Number(b.block_order) || 0));
      const first = list[0];
      const r0 = Number(first.sheet_row_num) - 1;
      const c0 = Number(first.sheet_col_idx);
      if (r0 < 12 || r0 > 110 || !MONTHLY_48_COL_SET.has(c0)) continue;
      const formulaMeta = String(first.custom_formula || "");
      let combined = list.map((b) => String(b.raw_block ?? "")).join("");
      if (formulaMeta === "__number__" && combined !== "" && !Number.isNaN(Number(combined))) {
        combined = Number(combined);
      }
      if (isNonEmptyCell_(combined)) setGridCellDirect_(valuesGrid, r0, c0, combined);
    }
    for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
    return { valuesGrid, notesGrid: {} };
  }

  if (tabName === "NBtoFind") {
    const rec = bundle.nbRecord;
    const rr = rec?.reconciled_rollups && typeof rec.reconciled_rollups === "object" ? rec.reconciled_rollups : {};
    const nbMeta = rr._nbMeta && typeof rr._nbMeta === "object" ? rr._nbMeta : {};
    const targetLen = Math.max(25, Number(nbMeta.rowCount) || 0);
    const valuesGrid = Array.from({ length: targetLen }, () => []);
    const notesGrid = {};
    if (nbMeta.dateCells && typeof nbMeta.dateCells === "object") notesGrid.__dateCells = nbMeta.dateCells;

    if (rec) {
      for (const r0 of NBTF_ROLLUP_ROWS0) {
        const rowObj = rr[String(r0)];
        if (!rowObj || typeof rowObj !== "object") continue;
        for (const [cKey, val] of Object.entries(rowObj)) {
          const c0 = parseInt(cKey, 10);
          if (Number.isInteger(c0) && c0 >= 0 && isNonEmptyCell_(val)) {
            setGridCellDirect_(valuesGrid, r0, c0, val);
          }
        }
      }
      const rawCells = rec.raw_cells && typeof rec.raw_cells === "object" ? rec.raw_cells : {};
      for (const [k, val] of Object.entries(rawCells)) {
        const colon = k.indexOf(":");
        if (colon <= 0) continue;
        const r0 = parseInt(k.slice(0, colon), 10);
        const c0 = parseInt(k.slice(colon + 1), 10);
        if (Number.isInteger(r0) && Number.isInteger(c0) && isNonEmptyCell_(val)) {
          setGridCellDirect_(valuesGrid, r0, c0, val);
        }
      }
      const cellNotes = rec.cell_notes && typeof rec.cell_notes === "object" ? rec.cell_notes : {};
      for (const [k, nStr] of Object.entries(cellNotes)) {
        if (!PROTOTYPE_KEYS.has(k) && nStr) notesGrid[k] = nStr;
      }
    }

    for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
    return { valuesGrid, notesGrid };
  }

  if (tabName === "Budget") {
    const budR = rollups._budgetRollups && typeof rollups._budgetRollups === "object" ? rollups._budgetRollups : {};
    const targetLen = Math.max(0, Number(budR.rowCount) || 0);
    const valuesGrid = Array.from({ length: targetLen }, () => []);
    const notesGrid = {};
    if (budR.dateCells && typeof budR.dateCells === "object") notesGrid.__dateCells = budR.dateCells;
    if (budR.bgColors && typeof budR.bgColors === "object") notesGrid.__bg_colors = budR.bgColors;
    if (budR.formulaRowCount != null) notesGrid.__formulaRowCount = Number(budR.formulaRowCount) || 0;
    if (budR.formulaColCounts && typeof budR.formulaColCounts === "object") notesGrid.__formulaColCounts = budR.formulaColCounts;
    if (budR.notes && typeof budR.notes === "object") {
      for (const [k, v] of Object.entries(budR.notes)) {
        if (!PROTOTYPE_KEYS.has(k) && v) notesGrid[k] = v;
      }
    }

    applySparseRollupsToGrid_(valuesGrid, budR.rows || {});

    for (const it of bundle.budgetItems || []) {
      const rowNum = Number(it.sheet_row_num);
      const r0 = rowNum - 1;
      if (!BUDGET_SECTION_BY_ROW.has(rowNum)) continue;

      const rawScalars = it.raw_scalars && typeof it.raw_scalars === "object" ? it.raw_scalars : {};
      const monthlyValues = it.monthly_values && typeof it.monthly_values === "object" ? it.monthly_values : {};
      const fyTotals = it.fy_totals && typeof it.fy_totals === "object" ? it.fy_totals : {};
      const customFormulas = it.custom_formulas && typeof it.custom_formulas === "object" ? it.custom_formulas : {};
      const cellNotes = it.cell_notes && typeof it.cell_notes === "object" ? it.cell_notes : {};

      const useScalarFallback =
        Object.keys(rawScalars).length === 0 &&
        Object.keys(monthlyValues).length === 0 &&
        Object.keys(customFormulas).length === 0 &&
        Object.keys(cellNotes).length === 0;
      const scalarFallback = {
        0: it.name || "",
        1: it.section === "salary" ? (it.equiv_salary ?? "") : (it.section === "making_up_cos" ? (it.making_up_cos_pct ?? "") : ""),
        2: it.start_date || "",
        3: it.end_date || "",
        4: it.delivery_pct ?? "",
      };
      for (let c = 0; c <= 4; c++) {
        const k = String(c);
        const hasRaw = Object.prototype.hasOwnProperty.call(rawScalars, k);
        const val = hasRaw ? rawScalars[k] : useScalarFallback ? scalarFallback[c] : "";
        if (isNonEmptyCell_(val)) setGridCellDirect_(valuesGrid, r0, c, val);
      }
      for (const c of MONTHLY_48_COLS) {
        const k = String(c);
        const val = Object.prototype.hasOwnProperty.call(monthlyValues, k) ? monthlyValues[k] : "";
        if (isNonEmptyCell_(val)) setGridCellDirect_(valuesGrid, r0, c, val);
      }
      for (const b of YEAR_MONTH_BANDS) {
        const tv = fyTotals[String(b.fyIndex)];
        if (isNonEmptyCell_(tv)) setGridCellDirect_(valuesGrid, r0, b.totalCol, tv);
      }
      for (const [k, nStr] of Object.entries(cellNotes)) {
        const c = parseInt(k, 10);
        if (Number.isInteger(c) && c >= 0 && nStr) notesGrid[`${r0}:${c}`] = nStr;
      }
    }

    for (let r = 0; r < valuesGrid.length; r++) valuesGrid[r] = trimTrailingEmptyGridCells_(valuesGrid[r]);
    return { valuesGrid, notesGrid };
  }

  return { valuesGrid: [], notesGrid: {} };
}

/**
 * Slices a reconstructed relational tab into either `FORMATTED_VALUE` or `UNFORMATTED_VALUE` rows,
 * matching `masterEngineService.js` (`sliceGrid2D_` + `formatGridForDisplay`) verbatim.
 */
export function sliceRelationalTabValues(
  tabState,
  tabName,
  { startRow0 = 0, endRow0 = null, startCol0 = 0, endCol0 = null, formatted = true } = {}
) {
  const grid = tabState?.valuesGrid || [];
  const notesGrid = tabState?.notesGrid || {};
  if (!Array.isArray(grid) || grid.length === 0) return [];
  const eRow = endRow0 != null ? Math.min(grid.length - 1, endRow0) : grid.length - 1;
  if (startRow0 > eRow || startRow0 >= grid.length) return [];

  const sliced = [];
  for (let r = startRow0; r <= eRow; r++) {
    const rowArr = Array.isArray(grid[r]) ? grid[r] : [];
    const eCol = endCol0 != null ? endCol0 : Math.max(0, rowArr.length - 1);
    if (startCol0 > eCol || rowArr.length === 0) {
      sliced.push([]);
      continue;
    }
    const rowSlice = rowArr.slice(startCol0, eCol + 1).map((v) => (v === null || v === undefined ? "" : v));
    while (rowSlice.length > 0 && rowSlice[rowSlice.length - 1] === "") {
      rowSlice.pop();
    }
    sliced.push(rowSlice);
  }
  while (sliced.length > 0 && sliced[sliced.length - 1].length === 0) {
    sliced.pop();
  }

  if (!formatted) return sliced;
  return sliced.map((row, rOffset) => {
    if (!Array.isArray(row)) return [];
    const absR = startRow0 + rOffset;
    return row.map((cellVal, cOffset) =>
      formatCellForDisplay("client", tabName, absR, startCol0 + cOffset, cellVal, grid, notesGrid)
    );
  });
}

/**
 * Builds `spreadsheets.get`-compatible `rowData` from a reconstructed relational tab state,
 * matching `masterEngineService.js` lines 3788-3902 verbatim.
 */
export function buildRelationalSheetRowData(
  tabState,
  tabName,
  { startRow0 = 0, endRow0 = null, startCol0 = 0, endCol0 = null, notesOnly = false, includeFormulaDimensions = false } = {}
) {
  const grid = tabState?.valuesGrid || [];
  const notesGrid = tabState?.notesGrid || {};

  let maxNoteRowCount = 0;
  const noteMaxColCountByRow = new Map();
  for (const nKey of Object.keys(notesGrid)) {
    if (!nKey || nKey.startsWith("__")) continue;
    const colonIdx = nKey.indexOf(":");
    if (colonIdx <= 0) continue;
    const nr = parseInt(nKey.slice(0, colonIdx), 10);
    const nc = parseInt(nKey.slice(colonIdx + 1), 10);
    if (Number.isNaN(nr) || Number.isNaN(nc)) continue;
    if (
      nr >= startRow0 &&
      (endRow0 == null || nr <= endRow0) &&
      nc >= startCol0 &&
      (endCol0 == null || nc <= endCol0)
    ) {
      const rOffset = nr - startRow0;
      const cCount = nc - startCol0 + 1;
      if (rOffset + 1 > maxNoteRowCount) maxNoteRowCount = rOffset + 1;
      if (cCount > (noteMaxColCountByRow.get(rOffset) || 0)) {
        noteMaxColCountByRow.set(rOffset, cCount);
      }
    }
  }

  if (notesOnly) {
    const rowData = [];
    for (let rOffset = 0; rOffset < maxNoteRowCount; rOffset++) {
      const colCount = noteMaxColCountByRow.get(rOffset) || 0;
      if (colCount === 0) {
        rowData.push({ values: [] });
        continue;
      }
      const absR = startRow0 + rOffset;
      const values = [];
      for (let cOffset = 0; cOffset < colCount; cOffset++) {
        const absC = startCol0 + cOffset;
        const noteStr = notesGrid[`${absR}:${absC}`] || "";
        values.push(noteStr ? { note: noteStr } : {});
      }
      rowData.push({ values });
    }
    return rowData;
  }

  const slicedVals = sliceRelationalTabValues(tabState, tabName, {
    startRow0,
    endRow0,
    startCol0,
    endCol0,
    formatted: false,
  });
  const fTotalRows = includeFormulaDimensions ? Number(notesGrid.__formulaRowCount) || 0 : 0;
  const fSlicedRowCount =
    fTotalRows > startRow0
      ? (endRow0 != null ? Math.min(fTotalRows, endRow0 + 1) : fTotalRows) - startRow0
      : 0;
  const formulaColCounts =
    includeFormulaDimensions && notesGrid.__formulaColCounts && typeof notesGrid.__formulaColCounts === "object"
      ? notesGrid.__formulaColCounts
      : {};
  let maxFormulaColRowCount = 0;
  for (const [fRk, fColLen] of Object.entries(formulaColCounts)) {
    const fr = parseInt(fRk, 10);
    if (
      Number.isInteger(fr) &&
      fr >= startRow0 &&
      (endRow0 == null || fr <= endRow0) &&
      Number(fColLen) > startCol0
    ) {
      maxFormulaColRowCount = Math.max(maxFormulaColRowCount, fr - startRow0 + 1);
    }
  }
  const rowCount = Math.max(slicedVals.length, fSlicedRowCount, maxFormulaColRowCount, maxNoteRowCount);
  const rowData = [];
  for (let rOffset = 0; rOffset < rowCount; rOffset++) {
    const absR = startRow0 + rOffset;
    const rArr = slicedVals[rOffset] || [];
    const fRawCols = Number(formulaColCounts[String(absR)] || 0);
    const fMinCols =
      fRawCols > startCol0
        ? (endCol0 != null ? Math.min(fRawCols, endCol0 + 1) : fRawCols) - startCol0
        : 0;
    const colCount = Math.max(rArr.length, fMinCols, noteMaxColCountByRow.get(rOffset) || 0);
    const values = [];
    for (let cOffset = 0; cOffset < colCount; cOffset++) {
      const absC = startCol0 + cOffset;
      const cellVal = rArr[cOffset];
      const strVal = cellVal == null ? "" : String(cellVal);
      const dispVal = formatCellForDisplay("client", tabName, absR, absC, cellVal, grid, notesGrid);
      const numClean = typeof cellVal === "number" ? cellVal : parseFloat(strVal.replace(/[£$€,\s]/g, ""));
      const isNumeric =
        typeof cellVal === "number" ||
        (strVal !== "" && !isNaN(numClean) && /^[-+]?[£$€]?\s*[\d,]+(\.\d+)?%?$/.test(strVal.trim()));
      const noteKey = `${absR}:${absC}`;
      const noteStr = notesGrid[noteKey] || "";
      const baseEffFmt = { backgroundColor: { red: 1, green: 1, blue: 1 } };
      const savedBg = notesGrid.__bg_colors?.[noteKey];
      const effFmt = savedBg ? { ...baseEffFmt, backgroundColor: savedBg } : baseEffFmt;
      const cellObj = {
        effectiveValue: isNumeric ? { numberValue: numClean } : { stringValue: strVal },
        userEnteredValue: isNumeric ? { numberValue: numClean } : { stringValue: strVal },
        note: noteStr,
        effectiveFormat: effFmt,
      };
      if (dispVal !== "") cellObj.formattedValue = dispVal;
      values.push(cellObj);
    }
    rowData.push({ values });
  }
  return rowData;
}

function findFirstInputJsonDiff_(a, b, pathStr = "$") {
  if (a === b) return null;
  if (Number.isNaN(a) && Number.isNaN(b)) return null;
  if (typeof a !== typeof b || a === null || b === null) {
    return { path: pathStr, expected: a, actual: b };
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { path: pathStr, expected: a, actual: b };
    if (a.length !== b.length) return { path: `${pathStr}.length`, expected: a.length, actual: b.length };
    for (let i = 0; i < a.length; i++) {
      const d = findFirstInputJsonDiff_(a[i], b[i], `${pathStr}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (typeof a === "object") {
    const SKIP = new Set(["fetchedAt", "_cachedAt", "cachedAt", "lastUpdated", "updatedAt", "inputsReadMode", "jobsReadMode"]);
    const aKeys = Object.keys(a).filter((k) => !SKIP.has(k));
    const bKeys = Object.keys(b).filter((k) => !SKIP.has(k));
    const allKeys = [...new Set([...aKeys, ...bKeys])].sort();
    for (const k of allKeys) {
      if (a[k] === undefined && b[k] === undefined) continue;
      const d = findFirstInputJsonDiff_(a[k], b[k], `${pathStr}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return { path: pathStr, expected: a, actual: b };
}

/**
 * Verifies byte-for-byte JSON parity between legacy grid-read and Phase 3B pure-relational
 * read payloads across all 11 PMA + Portal operating input & bank-breakdown endpoints.
 */
export async function verifyRelationalInputsReadParity({ clientName = null } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase not configured.");
  const schema = await checkPhase3RelationalSchemaStatus();
  if (!schema.schemaReady) {
    throw new Error("Migration 0013 must be applied in Supabase before verifying Phase 3B read parity.");
  }

  let query = supabase
    .from("clients")
    .select("id, client_name, inputs_mode, inputs_read_mode, client_sheet_id, master_sheet_id, metadata")
    .order("client_name", { ascending: true });
  if (clientName) query = query.eq("client_name", clientName);
  const { data: clients, error } = await query;
  if (error) throw new Error(`Failed listing clients: ${error.message}`);

  const [
    { getSheetsClient },
    { getSalariesData },
    { fetchExpensesData },
    { handleGetOutgoings },
    { fetchNBToFindData },
    { fetchCashData },
    { getClientViewData },
    { buildPortalBudgetPayload },
    { buildPortalKeyDataPayload },
  ] = await Promise.all([
    import("./sheetsClient.js"),
    import("./salariesService.js"),
    import("./expensesService.js"),
    import("./workspaces.js"),
    import("./nbToFindService.js"),
    import("./cashEditService.js"),
    import("./viewsService.js"),
    import("../pages/api/portal/budget.js"),
    import("../pages/api/portal/key-data.js"),
  ]);
  const sheets = await getSheetsClient();

  const callOutgoingsHandler = async (body) => {
    const resObj = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    await handleGetOutgoings({ body }, resObj, sheets);
    return resObj.body;
  };

  const results = [];
  for (const cl of clients || []) {
    try {
      const ctx = await resolveSupabaseSheetContext({ clientName: cl.client_name });
      if (!ctx?.clientId) throw new Error("Missing Supabase client context");

      // Ensure rollups exist in pulse_nb_to_find.reconciled_rollups
      const { data: nbMetaCheck } = await supabase
        .from("pulse_nb_to_find")
        .select("reconciled_rollups")
        .eq("client_id", ctx.clientId)
        .maybeSingle();
      const rCheck = nbMetaCheck?.reconciled_rollups || {};
      if (!rCheck._salariesRollups || !rCheck._outgoingsRollups?.formulaColCounts || !rCheck._budgetRollups?.formulaColCounts || !rCheck._nbMeta) {
        await reconcileClientOperatingInputsFromGrids(ctx, ALL_INPUT_TABS, {
          forceFullUpsert: true,
          includeBankBreakdowns: true,
        });
      }

      const mismatches = [];

      const [
        bkGrid, bkRel,
        salGrid, salRel,
        expGrid, expRel,
        outGrid, outRel,
        nbGrid, nbRel,
        cashGrid, cashRel,
        vConGrid, vConRel,
        vOutGrid, vOutRel,
        vBudGrid, vBudRel,
        pBudGrid, pBudRel,
        pKdGrid, pKdRel,
      ] = await Promise.all([
        getClientCashBankBreakdowns(cl.client_name, { _forceInputsReadMode: "grid" }),
        getClientCashBankBreakdowns(cl.client_name, { _forceInputsReadMode: "relational" }),
        getSalariesData({ clientName: cl.client_name, masterSheetId: ctx.masterSheetId, clientSheetId: ctx.clientSheetId, bypassCache: true, _forceInputsReadMode: "grid" }),
        getSalariesData({ clientName: cl.client_name, masterSheetId: ctx.masterSheetId, clientSheetId: ctx.clientSheetId, bypassCache: true, _forceInputsReadMode: "relational" }),
        fetchExpensesData(cl.client_name, ctx.clientSheetId, true, { _forceInputsReadMode: "grid" }),
        fetchExpensesData(cl.client_name, ctx.clientSheetId, true, { _forceInputsReadMode: "relational" }),
        callOutgoingsHandler({ clientSheetId: ctx.clientSheetId, bypassCache: true, _forceInputsReadMode: "grid" }),
        callOutgoingsHandler({ clientSheetId: ctx.clientSheetId, bypassCache: true, _forceInputsReadMode: "relational" }),
        fetchNBToFindData(cl.client_name, ctx.clientSheetId, true, { _forceInputsReadMode: "grid" }),
        fetchNBToFindData(cl.client_name, ctx.clientSheetId, true, { _forceInputsReadMode: "relational" }),
        fetchCashData(cl.client_name, ctx.clientSheetId, true, { _forceInputsReadMode: "grid" }),
        fetchCashData(cl.client_name, ctx.clientSheetId, true, { _forceInputsReadMode: "relational" }),
        getClientViewData({ clientSheetId: ctx.clientSheetId, masterSheetId: ctx.masterSheetId, tab: "contractors", bypassCache: true, _forceInputsReadMode: "grid" }),
        getClientViewData({ clientSheetId: ctx.clientSheetId, masterSheetId: ctx.masterSheetId, tab: "contractors", bypassCache: true, _forceInputsReadMode: "relational" }),
        getClientViewData({ clientSheetId: ctx.clientSheetId, masterSheetId: ctx.masterSheetId, tab: "outgoings", bypassCache: true, _forceInputsReadMode: "grid" }),
        getClientViewData({ clientSheetId: ctx.clientSheetId, masterSheetId: ctx.masterSheetId, tab: "outgoings", bypassCache: true, _forceInputsReadMode: "relational" }),
        getClientViewData({ clientSheetId: ctx.clientSheetId, masterSheetId: ctx.masterSheetId, tab: "budget", bypassCache: true, _forceInputsReadMode: "grid" }),
        getClientViewData({ clientSheetId: ctx.clientSheetId, masterSheetId: ctx.masterSheetId, tab: "budget", bypassCache: true, _forceInputsReadMode: "relational" }),
        buildPortalBudgetPayload({ sheets, clientSheetId: ctx.clientSheetId, clientName: cl.client_name, _forceInputsReadMode: "grid" }),
        buildPortalBudgetPayload({ sheets, clientSheetId: ctx.clientSheetId, clientName: cl.client_name, _forceInputsReadMode: "relational" }),
        buildPortalKeyDataPayload({ sheets, clientSheetId: ctx.clientSheetId, clientName: cl.client_name, _forceInputsReadMode: "grid" }),
        buildPortalKeyDataPayload({ sheets, clientSheetId: ctx.clientSheetId, clientName: cl.client_name, _forceInputsReadMode: "relational" }),
      ]);

      const checks = [
        ["bankBreakdowns", bkGrid, bkRel],
        ["pma.salaries", salGrid, salRel],
        ["pma.expenses", expGrid, expRel],
        ["pma.outgoings", outGrid, outRel],
        ["pma.nbToFind", nbGrid, nbRel],
        ["pma.cash", cashGrid, cashRel],
        ["pma.viewContractors", vConGrid, vConRel],
        ["pma.viewOutgoings", vOutGrid, vOutRel],
        ["pma.viewBudget", vBudGrid, vBudRel],
        ["portal.budget", pBudGrid, pBudRel],
        [
          "portal.keyDataInputs",
          pKdGrid ? { outgoingsMeta: pKdGrid.outgoingsMeta, salaries: pKdGrid.salaries, outgoings: pKdGrid.outgoings, nbtofind: pKdGrid.nbtofind } : null,
          pKdRel ? { outgoingsMeta: pKdRel.outgoingsMeta, salaries: pKdRel.salaries, outgoings: pKdRel.outgoings, nbtofind: pKdRel.nbtofind } : null,
        ],
      ];

      for (const [label, a, b] of checks) {
        const d = findFirstInputJsonDiff_(a, b, label);
        if (d) mismatches.push(d);
      }

      results.push({
        clientName: cl.client_name,
        inputsMode: cl.inputs_mode || cl.metadata?.inputs_mode || "grid",
        inputsReadMode: cl.inputs_read_mode || cl.metadata?.inputs_read_mode || "grid",
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
 * Toggles `clients.inputs_read_mode` between `'grid'` and `'relational'`.
 * Switching to `'relational'` requires `inputs_mode = 'relational'` and verifies
 * 0 JSON payload diffs across all 11 PMA & Portal operating-input readers before cutting over.
 */
export async function setClientInputsReadMode(clientName, inputsReadMode) {
  if (inputsReadMode !== "grid" && inputsReadMode !== "relational") {
    throw new Error("Invalid inputsReadMode. Expected 'grid' or 'relational'.");
  }
  const schema = await checkPhase3RelationalSchemaStatus();
  if (!schema.schemaReady) {
    throw new Error("Migration 0013 must be applied in Supabase SQL Editor before enabling relational inputs read mode.");
  }

  const supabase = getSupabaseAdmin();
  const { data: cl, error: clErr } = await supabase
    .from("clients")
    .select("id, client_name, inputs_mode, grid_storage_retired, metadata, client_sheet_id, master_sheet_id")
    .eq("client_name", clientName)
    .maybeSingle();
  if (clErr || !cl) throw new Error(`Client "${clientName}" not found.`);
  if (cl.grid_storage_retired && inputsReadMode !== "relational") {
    throw new Error(
      `Client "${clientName}" has retired grid storage and cannot be downgraded from 'relational' inputs_read_mode.`
    );
  }

  if (inputsReadMode === "relational" && !cl.grid_storage_retired) {
    if (String(cl.inputs_mode || cl.metadata?.inputs_mode || "grid").toLowerCase() !== "relational") {
      throw new Error(`Client "${cl.client_name}" must be in relational inputs_mode before enabling direct relational reads.`);
    }
    const ctx = await resolveSupabaseSheetContext({ clientName: cl.client_name });
    await reconcileClientOperatingInputsFromGrids(ctx, ALL_INPUT_TABS, {
      forceFullUpsert: true,
      includeBankBreakdowns: true,
    });
    const parity = await verifyRelationalInputsReadParity({ clientName: cl.client_name });
    const rec = parity.results?.[0];
    if (!rec || rec.error || !rec.matched) {
      throw new Error(
        `Phase 3B read parity check failed for ${cl.client_name}: ${rec?.error || JSON.stringify(rec?.sampleMismatches || [])}`
      );
    }
  }

  const nextMeta = {
    ...(cl.metadata && typeof cl.metadata === "object" ? cl.metadata : {}),
    inputs_read_mode: inputsReadMode,
  };
  const { error: updErr } = await supabase
    .from("clients")
    .update({ inputs_read_mode: inputsReadMode, metadata: nextMeta })
    .eq("id", cl.id);
  if (updErr) throw new Error(`Failed updating inputs_read_mode: ${updErr.message}`);

  invalidateSheetContextCache();
  if (cl.client_sheet_id) {
    await invalidatePmaClientCache(cl.client_sheet_id, cl.master_sheet_id || null, ["salaries", "outgoings", "expenses", "cash", "views", "budget"]).catch(() => { });
    if (redisClient?.isOpen) {
      await redisClient
        .del([
          `salaries_data:${cl.client_sheet_id}`,
          `pma_expenses_${cl.client_sheet_id}`,
          `pma_nbtofind_${cl.client_sheet_id}`,
          `pma_cash_${cl.client_sheet_id}`,
          `pulse:pma:outgoings:${cl.client_sheet_id}`,
          `pulse:view_data:${cl.client_sheet_id}:contractors`,
          `pulse:view_data:${cl.client_sheet_id}:outgoings`,
          `pulse:view_data:${cl.client_sheet_id}:budget`,
          `pulse:portal:budget:${cl.client_sheet_id}`,
          `pulse:portal:keydata:${cl.client_sheet_id}:all`,
        ])
        .catch(() => { });
    }
  }

  return {
    success: true,
    clientName: cl.client_name,
    inputsReadMode,
  };
}
