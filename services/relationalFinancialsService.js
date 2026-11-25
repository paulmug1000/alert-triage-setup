/**
 * ============================================================================
 * PULSE PHASE 5: RELATIONAL FINANCIAL CALCULATION ENGINE SERVICE (5A + 5B + 5C)
 * ============================================================================
 * Replaces virtual calculated Client Sheet grids with normalized Postgres tables
 * and 100% lossless cell-for-cell reconstruction:
 *   - Phase 5A: `Calcs` -> `pulse_job_monthly_rollups`
 *               `Year0Data` -> `pulse_year0_lines`
 *   - Phase 5B: `Dashboard`, `Performance`, `GPbyPL` -> `pulse_financial_statements`
 *   - Phase 5C: `VAT` -> `pulse_vat_schedules`
 *               `Cash` -> `pulse_cashflow_lines`
 *               `KeyInfo`, `ErrorCheck`, `tab_meta`, `formula_blueprints` -> `pulse_financial_configs`
 * ============================================================================
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import {
  resolveSupabaseSheetContext,
  invalidateMasterEngineCache,
  compactClientTabForStorage_,
  expandClientTabFromStorage_,
  parseA1Range,
} from "./masterEngineService.js";
import { compactGrid2D } from "./gasRuntime/masterFormulaEngine.js";
import { formatGridForDisplay } from "./gasRuntime/sheetValueUtils.js";
import {
  buildPortalPayloadFromGrids,
  buildPortalPerformanceFromGrids,
} from "./portalDataService.js";

export const PHASE5_FINANCIAL_TABS = [
  "Calcs",
  "Year0Data",
  "Performance",
  "Dashboard",
  "GPbyPL",
  "VAT",
  "Cash",
  "ErrorCheck",
  "KeyInfo",
];

const PHASE5_TAB_SET = new Set(PHASE5_FINANCIAL_TABS);

const STATEMENT_TYPE_BY_TAB = {
  Dashboard: "dashboard",
  Performance: "performance",
  GPbyPL: "gp_by_pl",
};

export function isManagedFinancialTab(tabName) {
  return PHASE5_TAB_SET.has(String(tabName || "").trim());
}

let _cachedMigration0016Sql = null;
let _schemaReadyCache = { ready: null, checkedAt: 0 };
const _financialsBundleCache = new Map();
const FINANCIALS_BUNDLE_TTL_MS = 15000;
const _pendingFinancialsReconcileByClient = new Map();
const _inFlightFinancialsReconcileByClient = new Map();

export function readMigration0016Sql() {
  if (_cachedMigration0016Sql !== null) return _cachedMigration0016Sql;
  try {
    const candidates = [
      path.join(process.cwd(), "supabase", "migrations", "0016_phase5_financial_engine.sql"),
      path.join(process.cwd(), "pulse-management-system", "supabase", "migrations", "0016_phase5_financial_engine.sql"),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations/0016_phase5_financial_engine.sql"),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    _cachedMigration0016Sql = found ? fs.readFileSync(found, "utf8") : "";
  } catch {
    _cachedMigration0016Sql = "";
  }
  return _cachedMigration0016Sql;
}

export function invalidateClientRelationalFinancialsCache(clientName) {
  const key = String(clientName || "").trim().toLowerCase();
  if (!key) {
    _financialsBundleCache.clear();
    return;
  }
  _financialsBundleCache.delete(key);
}

function str_(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function safeNumericOrNull_(val, limit = 1e15) {
  if (val === null || val === undefined || val === "" || typeof val === "boolean") return null;
  let n = null;
  if (typeof val === "number") {
    n = val;
  } else {
    const s = String(val).trim();
    if (!s || s.startsWith("#") || s.startsWith("=")) return null;
    const cleaned = s.replace(/[£$,\s]/g, "");
    if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
    n = Number(cleaned);
  }
  if (!Number.isFinite(n) || Math.abs(n) >= limit) return null;
  return Math.round(n * 10000) / 10000;
}

function serialToIsoMonth_(val) {
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n) || n < 20000 || n > 90000) return "";
  const dt = new Date(Math.round((Math.floor(n) - 25569) * 86400000));
  if (Number.isNaN(dt.getTime())) return "";
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

function trimTrailingEmptyCells_(row) {
  if (!Array.isArray(row)) return [];
  let last = row.length - 1;
  while (last >= 0) {
    const v = row[last];
    if (v !== "" && v !== null && v !== undefined) break;
    last--;
  }
  if (last < 0) return [];
  return row.slice(0, last + 1).map((v) => (v === null || v === undefined ? "" : v));
}

function isRowEmpty_(row) {
  if (!Array.isArray(row) || row.length === 0) return true;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    if (v !== "" && v !== null && v !== undefined) return false;
  }
  return true;
}

function sliceFixed_(row, startCol, count) {
  const arr = [];
  const src = Array.isArray(row) ? row : [];
  for (let i = 0; i < count; i++) {
    const v = src[startCol + i];
    arr.push(v === undefined || v === null ? "" : v);
  }
  return arr;
}

function clone2D_(grid) {
  if (!Array.isArray(grid)) return [];
  return grid.map((r) => (Array.isArray(r) ? [...r] : []));
}

function cleanNotesObject_(rawNotes) {
  if (!rawNotes || typeof rawNotes !== "object" || Array.isArray(rawNotes)) return {};
  const out = {};
  for (const [k, v] of Object.entries(rawNotes)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (k === "__formulas_grid" || k === "__compact_meta") continue;
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

async function fetchAllRowsByClientId_(supabase, table, clientId, orderCol = "row_index") {
  const all = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select("*").eq("client_id", clientId);
    if (orderCol) q = q.order(orderCol, { ascending: true });
    q = q.order("id", { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

async function fetchAllSelectByClientId_(supabase, table, selectCols, clientId) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select(selectCols)
      .eq("client_id", clientId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

async function upsertInChunks_(supabase, table, rows, onConflict) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 250) {
    const chunk = rows.slice(i, i + 250);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

// ============================================================================
// 1. LOSSLESS PARSER & RECONSTRUCTOR (ALL 9 PHASE 5 TABS)
// ============================================================================

function findColIdxByHeader_(headerRow, candidates, fallbackIdx) {
  if (Array.isArray(headerRow)) {
    const lowerSet = new Set(candidates.map((c) => c.toLowerCase()));
    for (let c = 0; c < headerRow.length; c++) {
      const h = str_(headerRow[c]).toLowerCase();
      if (h && lowerSet.has(h)) return c;
    }
  }
  return fallbackIdx;
}

export function parseClientFinancialsFromTabRecords({
  clientId,
  clientName,
  tabRecordsByTab = {},
  includeBlueprints = true,
}) {
  const nowIso = new Date().toISOString();
  const rollupRows = [];
  const year0Rows = [];
  const statementRows = [];
  const vatRows = [];
  const cashflowRows = [];
  const tabMeta = {};
  const formulaBlueprints = {};
  let clientKeyInfoGrid = [];
  let clientKeyInfoNotes = {};
  let errorCheckGrid = [];

  for (const tabName of PHASE5_FINANCIAL_TABS) {
    const rec = tabRecordsByTab[tabName];
    if (!rec) {
      tabMeta[tabName] = { present: false };
      continue;
    }

    const vGridRaw = Array.isArray(rec.values_grid) ? rec.values_grid : [];
    const vGrid = vGridRaw.map((r) => trimTrailingEmptyCells_(r));
    const fGrid = Array.isArray(rec.formulas_grid) && rec.formulas_grid.length > 0 ? rec.formulas_grid : vGridRaw;
    const cleanNotes = cleanNotesObject_(rec.notes_grid);
    const maxCols = Math.max(
      Number(rec.col_count) || 0,
      vGrid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
    );

    tabMeta[tabName] = {
      present: true,
      row_count: vGrid.length,
      col_count: maxCols,
      header_row: trimTrailingEmptyCells_(vGrid[0] || []),
      notes_grid: cleanNotes,
      updated_at: rec.updated_at || nowIso,
    };

    if (includeBlueprints) {
      try {
        const compacted = compactClientTabForStorage_(tabName, vGridRaw, fGrid, cleanNotes);
        formulaBlueprints[tabName] = compacted.storedFormulas || [];
      } catch {
        formulaBlueprints[tabName] = [];
      }
    }

    if (tabName === "Calcs") {
      const hdr = vGrid[0] || [];
      const idxPipeRev = findColIdxByHeader_(hdr, ["pipeline revenue @ %"], 4);
      const idxPipeInc = findColIdxByHeader_(hdr, ["pipeline income @ %"], 5);
      const idxPipeDc = findColIdxByHeader_(hdr, ["pipeline direct costs @ %"], 7);
      const idxConfRev = findColIdxByHeader_(hdr, ["confirmed revenue"], 10);
      const idxConfInc = findColIdxByHeader_(hdr, ["confirmed net income", "confirmed income"], 11);
      const idxConfDc = findColIdxByHeader_(hdr, ["confirmed direct costs"], 12);
      const idxConfCash = findColIdxByHeader_(hdr, ["confirmed cash in", "confirmed cash incoming"], 17);
      const idxPipeCash = findColIdxByHeader_(hdr, ["pipeline cash in", "pipeline cash incoming"], 20);
      const idxConfDcOut = findColIdxByHeader_(hdr, ["confirmed direct costs out", "direct costs out (conf)"], 27);
      const idxPipeDcOut = findColIdxByHeader_(hdr, ["pipeline direct costs out", "direct costs out (pipe)"], 30);

      for (let r = 1; r < vGrid.length; r++) {
        const row = vGrid[r] || [];
        if (isRowEmpty_(row)) continue;
        rollupRows.push({
          client_id: clientId,
          client_name: clientName,
          month_index: r,
          month_serial: safeNumericOrNull_(row[0], 1e9),
          iso_month: serialToIsoMonth_(row[0]),
          confirmed_revenue: safeNumericOrNull_(row[idxConfRev]),
          confirmed_net_income: safeNumericOrNull_(row[idxConfInc]),
          confirmed_direct_costs: safeNumericOrNull_(row[idxConfDc]),
          pipeline_revenue: safeNumericOrNull_(row[idxPipeRev]),
          pipeline_income: safeNumericOrNull_(row[idxPipeInc]),
          pipeline_direct_costs: safeNumericOrNull_(row[idxPipeDc]),
          confirmed_cash_in: safeNumericOrNull_(row[idxConfCash]),
          pipeline_cash_in: safeNumericOrNull_(row[idxPipeCash]),
          confirmed_direct_costs_out: safeNumericOrNull_(row[idxConfDcOut]),
          pipeline_direct_costs_out: safeNumericOrNull_(row[idxPipeDcOut]),
          raw_row: row,
          updated_at: nowIso,
        });
      }
    } else if (tabName === "Year0Data") {
      for (let r = 0; r < vGrid.length; r++) {
        const row = vGrid[r] || [];
        if (isRowEmpty_(row)) continue;
        year0Rows.push({
          client_id: clientId,
          client_name: clientName,
          row_index: r + 1,
          line_label: str_(row[0]),
          fy0_months: sliceFixed_(row, 6, 12),
          fy0_total: safeNumericOrNull_(row[18]),
          raw_row: row,
          updated_at: nowIso,
        });
      }
    } else if (STATEMENT_TYPE_BY_TAB[tabName]) {
      const statementType = STATEMENT_TYPE_BY_TAB[tabName];
      let currentSection = "";
      for (let r = 0; r < vGrid.length; r++) {
        const row = vGrid[r] || [];
        if (isRowEmpty_(row)) continue;
        const label = str_(row[0]);
        const hasMonthVal = row.slice(6, 18).some((v) => v !== "" && v !== null && v !== undefined);
        if (label && !hasMonthVal && r >= 2) {
          currentSection = label;
        }
        const pickTotal = (primaryCol, altCol) => {
          const v1 = row[primaryCol];
          const n1 = safeNumericOrNull_(v1);
          if (n1 !== null) return n1;
          return safeNumericOrNull_(row[altCol]);
        };
        statementRows.push({
          client_id: clientId,
          client_name: clientName,
          statement_type: statementType,
          row_index: r + 1,
          section: currentSection,
          line_label: label,
          fy1_months: sliceFixed_(row, 6, 12),
          fy1_total: pickTotal(18, 19),
          fy2_months: sliceFixed_(row, 21, 12),
          fy2_total: pickTotal(33, 34),
          fy3_months: sliceFixed_(row, 36, 12),
          fy3_total: pickTotal(48, 49),
          raw_row: row,
          updated_at: nowIso,
        });
      }
    } else if (tabName === "VAT") {
      for (let r = 0; r < vGrid.length; r++) {
        const row = vGrid[r] || [];
        if (isRowEmpty_(row)) continue;
        const scheme =
          r < 2
            ? "header"
            : r < 9
              ? "accrual_confirmed"
              : r < 16
                ? "accrual_total"
                : r < 23
                  ? "cash_confirmed"
                  : r < 30
                    ? "cash_total"
                    : "payment_schedule";
        vatRows.push({
          client_id: clientId,
          client_name: clientName,
          row_index: r + 1,
          scheme,
          line_label: str_(row[0]),
          fy1_months: sliceFixed_(row, 6, 12),
          fy2_months: sliceFixed_(row, 21, 12),
          fy3_months: sliceFixed_(row, 36, 12),
          raw_row: row,
          updated_at: nowIso,
        });
      }
    } else if (tabName === "Cash") {
      for (let r = 0; r < vGrid.length; r++) {
        const row = vGrid[r] || [];
        if (isRowEmpty_(row)) continue;
        const section =
          r === 0
            ? "header"
            : r < 42
              ? "excluding_pipeline"
              : "including_pipeline";
        cashflowRows.push({
          client_id: clientId,
          client_name: clientName,
          row_index: r + 1,
          section,
          line_label: str_(row[0]),
          monthly_values: sliceFixed_(row, 1, 36),
          raw_row: row,
          updated_at: nowIso,
        });
      }
    } else if (tabName === "KeyInfo") {
      clientKeyInfoGrid = vGrid;
      clientKeyInfoNotes = cleanNotes;
    } else if (tabName === "ErrorCheck") {
      errorCheckGrid = vGrid;
    }
  }

  const configRow = {
    client_id: clientId,
    client_name: clientName,
    client_key_info_grid: clientKeyInfoGrid,
    client_key_info_notes: clientKeyInfoNotes,
    error_check_grid: errorCheckGrid,
    tab_meta: tabMeta,
    formula_blueprints: formulaBlueprints,
    updated_at: nowIso,
  };

  return {
    rollupRows,
    year0Rows,
    statementRows,
    vatRows,
    cashflowRows,
    configRow,
  };
}

export function reconstructRelationalFinancialTabFromBundle(
  bundle,
  tabName,
  { includeFormulas = false } = {}
) {
  if (!bundle || !isManagedFinancialTab(tabName)) return null;
  const cfg = bundle.config || {};
  const tabMetaMap = cfg.tab_meta && typeof cfg.tab_meta === "object" ? cfg.tab_meta : {};
  const meta = tabMetaMap[tabName];
  if (!meta || !meta.present) return null;

  const rowCount = Math.max(0, Number(meta.row_count) || 0);
  let valuesGrid = [];

  if (tabName === "Calcs") {
    let maxIdx = Math.max(rowCount - 1, 0);
    for (const r of bundle.rollupRows || []) {
      if (Number(r.month_index) > maxIdx) maxIdx = Number(r.month_index);
    }
    valuesGrid = Array.from({ length: maxIdx + 1 }, () => []);
    if (Array.isArray(meta.header_row)) {
      valuesGrid[0] = [...meta.header_row];
    }
    for (const r of bundle.rollupRows || []) {
      const idx = Number(r.month_index);
      if (Number.isInteger(idx) && idx >= 1) {
        while (valuesGrid.length <= idx) valuesGrid.push([]);
        valuesGrid[idx] = Array.isArray(r.raw_row) ? [...r.raw_row] : [];
      }
    }
  } else if (tabName === "Year0Data") {
    valuesGrid = Array.from({ length: rowCount }, () => []);
    for (const r of bundle.year0Rows || []) {
      const r0 = Number(r.row_index) - 1;
      if (Number.isInteger(r0) && r0 >= 0) {
        while (valuesGrid.length <= r0) valuesGrid.push([]);
        valuesGrid[r0] = Array.isArray(r.raw_row) ? [...r.raw_row] : [];
      }
    }
  } else if (STATEMENT_TYPE_BY_TAB[tabName]) {
    const targetType = STATEMENT_TYPE_BY_TAB[tabName];
    valuesGrid = Array.from({ length: rowCount }, () => []);
    const list =
      bundle.statementRowsByType?.get(targetType) ||
      (bundle.statementRows || []).filter((r) => r.statement_type === targetType);
    for (const r of list) {
      const r0 = Number(r.row_index) - 1;
      if (Number.isInteger(r0) && r0 >= 0) {
        while (valuesGrid.length <= r0) valuesGrid.push([]);
        valuesGrid[r0] = Array.isArray(r.raw_row) ? [...r.raw_row] : [];
      }
    }
  } else if (tabName === "VAT") {
    valuesGrid = Array.from({ length: rowCount }, () => []);
    for (const r of bundle.vatRows || []) {
      const r0 = Number(r.row_index) - 1;
      if (Number.isInteger(r0) && r0 >= 0) {
        while (valuesGrid.length <= r0) valuesGrid.push([]);
        valuesGrid[r0] = Array.isArray(r.raw_row) ? [...r.raw_row] : [];
      }
    }
  } else if (tabName === "Cash") {
    valuesGrid = Array.from({ length: rowCount }, () => []);
    for (const r of bundle.cashflowRows || []) {
      const r0 = Number(r.row_index) - 1;
      if (Number.isInteger(r0) && r0 >= 0) {
        while (valuesGrid.length <= r0) valuesGrid.push([]);
        valuesGrid[r0] = Array.isArray(r.raw_row) ? [...r.raw_row] : [];
      }
    }
  } else if (tabName === "KeyInfo") {
    valuesGrid = clone2D_(cfg.client_key_info_grid || []);
    while (valuesGrid.length < rowCount) valuesGrid.push([]);
  } else if (tabName === "ErrorCheck") {
    valuesGrid = clone2D_(cfg.error_check_grid || []);
    while (valuesGrid.length < rowCount) valuesGrid.push([]);
  }

  const notesGrid = cleanNotesObject_(
    meta.notes_grid && typeof meta.notes_grid === "object"
      ? meta.notes_grid
      : tabName === "KeyInfo"
        ? cfg.client_key_info_notes
        : {}
  );
  const colCount = Math.max(
    Number(meta.col_count) || 0,
    valuesGrid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
  );

  let formulasGrid = valuesGrid;
  if (includeFormulas && cfg.formula_blueprints?.[tabName]) {
    try {
      const mockRec = {
        row_count: valuesGrid.length,
        col_count: colCount,
        values_grid: clone2D_(valuesGrid),
        formulas_grid: cfg.formula_blueprints[tabName],
        notes_grid: { ...notesGrid },
      };
      expandClientTabFromStorage_(mockRec, tabName, { valuesOnly: false });
      formulasGrid = Array.isArray(mockRec.formulas_grid) ? mockRec.formulas_grid : valuesGrid;
    } catch {
      formulasGrid = valuesGrid;
    }
  }

  return {
    sheet_role: "client",
    tab_name: tabName,
    row_count: valuesGrid.length,
    col_count: colCount,
    values_grid: valuesGrid,
    formulas_grid: formulasGrid,
    notes_grid: notesGrid,
    updated_at: meta.updated_at || cfg.updated_at || null,
  };
}

// ============================================================================
// 2. SCHEMA CHECK & OVERVIEW STATS
// ============================================================================

export async function checkPhase5FinancialsSchemaStatus({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && _schemaReadyCache.ready !== null && now - _schemaReadyCache.checkedAt < 60000) {
    return { schemaReady: _schemaReadyCache.ready };
  }
  const supabase = getSupabaseAdmin();
  if (!isSupabaseConfigured() || !supabase) {
    return { schemaReady: false, reason: "Supabase is not configured." };
  }
  try {
    const checks = await Promise.all([
      supabase.from("clients").select("financials_mode, financials_read_mode").limit(1),
      supabase.from("pulse_job_monthly_rollups").select("id, month_index, raw_row").limit(1),
      supabase.from("pulse_year0_lines").select("id, row_index, raw_row").limit(1),
      supabase.from("pulse_financial_statements").select("id, statement_type, row_index, raw_row").limit(1),
      supabase.from("pulse_vat_schedules").select("id, row_index, raw_row").limit(1),
      supabase.from("pulse_cashflow_lines").select("id, row_index, raw_row").limit(1),
      supabase.from("pulse_financial_configs").select("client_id, tab_meta, formula_blueprints").limit(1),
    ]);
    const ready = checks.every((c) => !c.error);
    _schemaReadyCache = { ready, checkedAt: now };
    return {
      schemaReady: ready,
      ...(ready ? {} : { reason: checks.find((c) => c.error)?.error?.message || "Migration 0016 required" }),
    };
  } catch (err) {
    _schemaReadyCache = { ready: false, checkedAt: now };
    return { schemaReady: false, reason: err.message };
  }
}

export async function getPhase5FinancialsOverviewStats() {
  const migrationSql = readMigration0016Sql();
  const status = await checkPhase5FinancialsSchemaStatus();
  if (!status.schemaReady) {
    return {
      schemaReady: false,
      migrationSql,
      reason: status.reason || "Migration 0016 required",
      totalRollupMonths: 0,
      totalYear0Lines: 0,
      totalStatementLines: 0,
      totalVatRows: 0,
      totalCashflowLines: 0,
      totalFinancialConfigs: 0,
    };
  }
  const supabase = getSupabaseAdmin();
  const [rolCnt, y0Cnt, stmtCnt, vatCnt, cashCnt, cfgCnt] = await Promise.all([
    supabase.from("pulse_job_monthly_rollups").select("id", { count: "exact", head: true }),
    supabase.from("pulse_year0_lines").select("id", { count: "exact", head: true }),
    supabase.from("pulse_financial_statements").select("id", { count: "exact", head: true }),
    supabase.from("pulse_vat_schedules").select("id", { count: "exact", head: true }),
    supabase.from("pulse_cashflow_lines").select("id", { count: "exact", head: true }),
    supabase.from("pulse_financial_configs").select("client_id", { count: "exact", head: true }),
  ]);

  return {
    schemaReady: true,
    migrationSql,
    totalRollupMonths: rolCnt.count || 0,
    totalYear0Lines: y0Cnt.count || 0,
    totalStatementLines: stmtCnt.count || 0,
    totalVatRows: vatCnt.count || 0,
    totalCashflowLines: cashCnt.count || 0,
    totalFinancialConfigs: cfgCnt.count || 0,
  };
}

// ============================================================================
// 3. VIRTUAL CLIENT GRID LOADER & IDEMPOTENT RECONCILE / BACKFILL
// ============================================================================

async function loadExpandedPhase5TabRecords_(supabase, clientName, { valuesOnly = false } = {}) {
  const targetNames = [...PHASE5_FINANCIAL_TABS, ...PHASE5_FINANCIAL_TABS.map((t) => `Client::${t}`)];
  const selectCols = valuesOnly
    ? "tab_name, sheet_role, row_count, col_count, values_grid, notes_grid, updated_at"
    : "tab_name, sheet_role, row_count, col_count, values_grid, formulas_grid, notes_grid, updated_at";
  const { data: rows, error } = await supabase
    .from("master_sheet_grids")
    .select(selectCols)
    .eq("client_name", clientName)
    .in("sheet_role", ["client", "master"])
    .in("tab_name", targetNames);
  if (error) throw new Error(`Failed loading client grids for ${clientName}: ${error.message}`);

  const byTab = {};
  for (const t of PHASE5_FINANCIAL_TABS) {
    const rec =
      (rows || []).find((r) => r.sheet_role === "client" && r.tab_name === t) ||
      (rows || []).find((r) => r.sheet_role === "master" && r.tab_name === `Client::${t}`) ||
      null;
    if (!rec) continue;
    const clone = { ...rec };
    expandClientTabFromStorage_(clone, t, { valuesOnly });
    byTab[t] = clone;
  }
  return byTab;
}

async function runSingleFinancialsReconcilePass_(ctx, tabNames = null, options = {}) {
  const schema = await checkPhase5FinancialsSchemaStatus();
  if (!schema.schemaReady) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const targetAll =
    tabNames === null || tabNames === undefined || Boolean(options.forceFullUpsert);
  const reqSet = new Set(Array.isArray(tabNames) ? tabNames : []);

  const shouldSyncCalcs = targetAll || reqSet.has("Calcs");
  const shouldSyncYear0 = targetAll || reqSet.has("Year0Data");
  const shouldSyncStatements =
    targetAll || reqSet.has("Dashboard") || reqSet.has("Performance") || reqSet.has("GPbyPL");
  const shouldSyncVat = targetAll || reqSet.has("VAT");
  const shouldSyncCash = targetAll || reqSet.has("Cash");

  const tabRecordsByTab = await loadExpandedPhase5TabRecords_(supabase, ctx.clientName, {
    valuesOnly: false,
  });

  const parsed = parseClientFinancialsFromTabRecords({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    tabRecordsByTab,
    includeBlueprints: true,
  });

  // Always keep pulse_financial_configs synchronized (carries KeyInfo, ErrorCheck, tab_meta, blueprints)
  const { error: cfgErr } = await supabase
    .from("pulse_financial_configs")
    .upsert(parsed.configRow, { onConflict: "client_id" });
  if (cfgErr) throw new Error(`pulse_financial_configs upsert failed: ${cfgErr.message}`);

  if (shouldSyncCalcs) {
    await upsertInChunks_(
      supabase,
      "pulse_job_monthly_rollups",
      parsed.rollupRows,
      "client_id,month_index"
    );
    const keepIdx = new Set(parsed.rollupRows.map((r) => r.month_index));
    const existing = await fetchAllSelectByClientId_(
      supabase,
      "pulse_job_monthly_rollups",
      "id, month_index",
      ctx.clientId
    );
    const staleIds = existing.filter((r) => !keepIdx.has(r.month_index)).map((r) => r.id);
    for (let i = 0; i < staleIds.length; i += 200) {
      await supabase.from("pulse_job_monthly_rollups").delete().in("id", staleIds.slice(i, i + 200));
    }
  }

  if (shouldSyncYear0) {
    await upsertInChunks_(
      supabase,
      "pulse_year0_lines",
      parsed.year0Rows,
      "client_id,row_index"
    );
    const keepIdx = new Set(parsed.year0Rows.map((r) => r.row_index));
    const existing = await fetchAllSelectByClientId_(
      supabase,
      "pulse_year0_lines",
      "id, row_index",
      ctx.clientId
    );
    const staleIds = existing.filter((r) => !keepIdx.has(r.row_index)).map((r) => r.id);
    for (let i = 0; i < staleIds.length; i += 200) {
      await supabase.from("pulse_year0_lines").delete().in("id", staleIds.slice(i, i + 200));
    }
  }

  if (shouldSyncStatements) {
    const activeStmtRows = targetAll
      ? parsed.statementRows
      : parsed.statementRows.filter((r) => {
          if (r.statement_type === "dashboard") return reqSet.has("Dashboard");
          if (r.statement_type === "performance") return reqSet.has("Performance");
          if (r.statement_type === "gp_by_pl") return reqSet.has("GPbyPL");
          return false;
        });
    await upsertInChunks_(
      supabase,
      "pulse_financial_statements",
      activeStmtRows,
      "client_id,statement_type,row_index"
    );
    const keepKeys = new Set(parsed.statementRows.map((r) => `${r.statement_type}::${r.row_index}`));
    const existing = await fetchAllSelectByClientId_(
      supabase,
      "pulse_financial_statements",
      "id, statement_type, row_index",
      ctx.clientId
    );
    const staleIds = existing
      .filter((r) => {
        if (!targetAll) {
          if (r.statement_type === "dashboard" && !reqSet.has("Dashboard")) return false;
          if (r.statement_type === "performance" && !reqSet.has("Performance")) return false;
          if (r.statement_type === "gp_by_pl" && !reqSet.has("GPbyPL")) return false;
        }
        return !keepKeys.has(`${r.statement_type}::${r.row_index}`);
      })
      .map((r) => r.id);
    for (let i = 0; i < staleIds.length; i += 200) {
      await supabase.from("pulse_financial_statements").delete().in("id", staleIds.slice(i, i + 200));
    }
  }

  if (shouldSyncVat) {
    await upsertInChunks_(
      supabase,
      "pulse_vat_schedules",
      parsed.vatRows,
      "client_id,row_index"
    );
    const keepIdx = new Set(parsed.vatRows.map((r) => r.row_index));
    const existing = await fetchAllSelectByClientId_(
      supabase,
      "pulse_vat_schedules",
      "id, row_index",
      ctx.clientId
    );
    const staleIds = existing.filter((r) => !keepIdx.has(r.row_index)).map((r) => r.id);
    for (let i = 0; i < staleIds.length; i += 200) {
      await supabase.from("pulse_vat_schedules").delete().in("id", staleIds.slice(i, i + 200));
    }
  }

  if (shouldSyncCash) {
    await upsertInChunks_(
      supabase,
      "pulse_cashflow_lines",
      parsed.cashflowRows,
      "client_id,row_index"
    );
    const keepIdx = new Set(parsed.cashflowRows.map((r) => r.row_index));
    const existing = await fetchAllSelectByClientId_(
      supabase,
      "pulse_cashflow_lines",
      "id, row_index",
      ctx.clientId
    );
    const staleIds = existing.filter((r) => !keepIdx.has(r.row_index)).map((r) => r.id);
    for (let i = 0; i < staleIds.length; i += 200) {
      await supabase.from("pulse_cashflow_lines").delete().in("id", staleIds.slice(i, i + 200));
    }
  }

  invalidateClientRelationalFinancialsCache(ctx.clientName);

  const summary = {
    clientName: ctx.clientName,
    rollupMonthsCount: parsed.rollupRows.length,
    year0LinesCount: parsed.year0Rows.length,
    statementLinesCount: parsed.statementRows.length,
    vatRowsCount: parsed.vatRows.length,
    cashflowLinesCount: parsed.cashflowRows.length,
  };

  if (options.updateBackfillTimestamp) {
    const { data: cRow } = await supabase
      .from("clients")
      .select("metadata")
      .eq("id", ctx.clientId)
      .maybeSingle();
    const nextMeta = {
      ...(cRow?.metadata || {}),
      relational_financials_state: {
        lastBackfilledAt: new Date().toISOString(),
        ...summary,
      },
    };
    await supabase.from("clients").update({ metadata: nextMeta }).eq("id", ctx.clientId);
  }

  return summary;
}

export async function reconcileClientFinancialsFromGrids(
  ctxOrClientName,
  tabNames = null,
  options = {}
) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const key = String(ctx.clientName || "").trim().toLowerCase();
  const prevPending = _pendingFinancialsReconcileByClient.get(key) || {
    allTabs: false,
    tabs: new Set(),
    opts: {},
  };
  if (tabNames === null || tabNames === undefined || options?.forceFullUpsert) {
    prevPending.allTabs = true;
  } else if (Array.isArray(tabNames)) {
    for (const t of tabNames) prevPending.tabs.add(t);
  }
  prevPending.opts = {
    forceFullUpsert: Boolean(prevPending.opts.forceFullUpsert || options?.forceFullUpsert),
    updateBackfillTimestamp: Boolean(
      prevPending.opts.updateBackfillTimestamp || options?.updateBackfillTimestamp
    ),
  };
  _pendingFinancialsReconcileByClient.set(key, prevPending);

  if (_inFlightFinancialsReconcileByClient.has(key)) {
    return _inFlightFinancialsReconcileByClient.get(key);
  }

  const runner = (async () => {
    let lastSummary = null;
    while (_pendingFinancialsReconcileByClient.has(key)) {
      const next = _pendingFinancialsReconcileByClient.get(key);
      _pendingFinancialsReconcileByClient.delete(key);
      lastSummary = await runSingleFinancialsReconcilePass_(
        ctx,
        next.allTabs ? null : [...next.tabs],
        next.opts
      );
    }
    return lastSummary;
  })();

  _inFlightFinancialsReconcileByClient.set(key, runner);
  try {
    return await runner;
  } finally {
    if (_inFlightFinancialsReconcileByClient.get(key) === runner) {
      _inFlightFinancialsReconcileByClient.delete(key);
    }
  }
}

export async function backfillClientFinancials(clientName) {
  const schema = await checkPhase5FinancialsSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error(
      "Migration 0016 must be applied in Supabase SQL Editor before backfilling financial calculations."
    );
  }
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) {
    throw new Error(`Client "${clientName}" was not found in Supabase.`);
  }
  return reconcileClientFinancialsFromGrids(ctx, null, {
    forceFullUpsert: true,
    updateBackfillTimestamp: true,
  });
}

export async function backfillAllClientsFinancials() {
  const schema = await checkPhase5FinancialsSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error(
      "Migration 0016 must be applied in Supabase SQL Editor before backfilling financial calculations."
    );
  }
  const supabase = getSupabaseAdmin();
  const { data: clients, error } = await supabase
    .from("clients")
    .select("client_name")
    .order("client_name");
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    try {
      const s = await backfillClientFinancials(cl.client_name);
      results.push({ ...s, error: null });
    } catch (err) {
      results.push({ clientName: cl.client_name, error: err.message });
    }
  }
  const succeededCount = results.filter((r) => !r.error).length;
  return {
    checkedAt: new Date().toISOString(),
    totalClients: results.length,
    clientsProcessed: succeededCount,
    succeededCount,
    errorCount: results.filter((r) => Boolean(r.error)).length,
    rollupMonthsCount: results.reduce((a, r) => a + (r.rollupMonthsCount || 0), 0),
    year0LinesCount: results.reduce((a, r) => a + (r.year0LinesCount || 0), 0),
    statementLinesCount: results.reduce((a, r) => a + (r.statementLinesCount || 0), 0),
    vatRowsCount: results.reduce((a, r) => a + (r.vatRowsCount || 0), 0),
    cashflowLinesCount: results.reduce((a, r) => a + (r.cashflowLinesCount || 0), 0),
    results,
  };
}

// ============================================================================
// 4. RELATIONAL FINANCIALS BUNDLE LOADER
// ============================================================================

async function loadInMemoryFinancialsBundleForClient_(ctx, { includeFormulas = true } = {}) {
  const supabase = getSupabaseAdmin();
  const tabRecordsByTab = await loadExpandedPhase5TabRecords_(supabase, ctx.clientName, {
    valuesOnly: !includeFormulas,
  });
  const parsed = parseClientFinancialsFromTabRecords({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    tabRecordsByTab,
    includeBlueprints: includeFormulas,
  });
  const statementRowsByType = new Map();
  for (const r of parsed.statementRows) {
    if (!statementRowsByType.has(r.statement_type)) statementRowsByType.set(r.statement_type, []);
    statementRowsByType.get(r.statement_type).push(r);
  }
  return {
    source: "in_memory",
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    loadedAt: Date.now(),
    rollupRows: parsed.rollupRows,
    year0Rows: parsed.year0Rows,
    statementRows: parsed.statementRows,
    statementRowsByType,
    vatRows: parsed.vatRows,
    cashflowRows: parsed.cashflowRows,
    config: parsed.configRow,
    reconstructedTabCache: new Map(),
  };
}

export async function preloadClientRelationalFinancialsBundle(
  ctxOrClientName,
  { source = "db", includeFormulas = false } = {}
) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  if (source === "in_memory") {
    return loadInMemoryFinancialsBundleForClient_(ctx, { includeFormulas: true });
  }

  const cacheKey = `${String(ctx.clientName || "").trim().toLowerCase()}::${includeFormulas ? "wf" : "vo"}`;
  const cached = _financialsBundleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.bundle;
  }

  const schema = await checkPhase5FinancialsSchemaStatus();
  if (!schema.schemaReady) {
    if (source === "db") {
      throw new Error("Migration 0016 schema not applied in Supabase.");
    }
    return loadInMemoryFinancialsBundleForClient_(ctx, { includeFormulas: true });
  }

  const supabase = getSupabaseAdmin();
  const cfgSelect = includeFormulas
    ? "client_id, client_name, client_key_info_grid, client_key_info_notes, error_check_grid, tab_meta, formula_blueprints, updated_at"
    : "client_id, client_name, client_key_info_grid, client_key_info_notes, error_check_grid, tab_meta, updated_at";

  const [rollupRows, year0Rows, statementRows, vatRows, cashflowRows, cfgRes] = await Promise.all([
    fetchAllRowsByClientId_(supabase, "pulse_job_monthly_rollups", ctx.clientId, "month_index"),
    fetchAllRowsByClientId_(supabase, "pulse_year0_lines", ctx.clientId, "row_index"),
    fetchAllRowsByClientId_(supabase, "pulse_financial_statements", ctx.clientId, "row_index"),
    fetchAllRowsByClientId_(supabase, "pulse_vat_schedules", ctx.clientId, "row_index"),
    fetchAllRowsByClientId_(supabase, "pulse_cashflow_lines", ctx.clientId, "row_index"),
    supabase.from("pulse_financial_configs").select(cfgSelect).eq("client_id", ctx.clientId).maybeSingle(),
  ]);
  if (cfgRes.error) throw new Error(`pulse_financial_configs query failed: ${cfgRes.error.message}`);

  const statementRowsByType = new Map();
  for (const r of statementRows) {
    if (!statementRowsByType.has(r.statement_type)) statementRowsByType.set(r.statement_type, []);
    statementRowsByType.get(r.statement_type).push(r);
  }

  const bundle = {
    source: "db",
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    loadedAt: Date.now(),
    rollupRows,
    year0Rows,
    statementRows,
    statementRowsByType,
    vatRows,
    cashflowRows,
    config: cfgRes.data || {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      client_key_info_grid: [],
      client_key_info_notes: {},
      error_check_grid: [],
      tab_meta: {},
      formula_blueprints: {},
    },
    reconstructedTabCache: new Map(),
  };

  _financialsBundleCache.set(cacheKey, {
    expiresAt: Date.now() + FINANCIALS_BUNDLE_TTL_MS,
    bundle,
  });

  return bundle;
}

// ============================================================================
// 5. MODE TOGGLES
// ============================================================================

export async function setClientFinancialsMode(clientName, mode) {
  const cleanMode = str_(mode).toLowerCase();
  if (cleanMode !== "grid" && cleanMode !== "relational") {
    throw new Error("Invalid financialsMode. Expected 'grid' or 'relational'.");
  }
  const schema = await checkPhase5FinancialsSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0016 must be applied in Supabase SQL Editor first.");
  }
  const supabase = getSupabaseAdmin();
  const { data: cl, error: fErr } = await supabase
    .from("clients")
    .select("id, client_name, metadata")
    .eq("client_name", clientName)
    .maybeSingle();
  if (fErr || !cl) throw new Error(fErr?.message || `Client "${clientName}" not found.`);

  if (cleanMode === "relational") {
    await backfillClientFinancials(clientName);
  }

  const nextMeta = { ...(cl.metadata || {}), financials_mode: cleanMode };
  const { data: upd, error: uErr } = await supabase
    .from("clients")
    .update({ financials_mode: cleanMode, metadata: nextMeta })
    .eq("id", cl.id)
    .select("id, client_name, financials_mode, financials_read_mode")
    .single();
  if (uErr) throw new Error(`Failed updating financials_mode: ${uErr.message}`);
  invalidateMasterEngineCache(clientName, "client", null, { invalidateSheetContext: true });
  invalidateClientRelationalFinancialsCache(clientName);
  return upd;
}

export async function setClientFinancialsReadMode(clientName, mode) {
  const cleanMode = str_(mode).toLowerCase();
  if (cleanMode !== "grid" && cleanMode !== "relational") {
    throw new Error("Invalid financialsReadMode. Expected 'grid' or 'relational'.");
  }
  const schema = await checkPhase5FinancialsSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0016 must be applied in Supabase SQL Editor first.");
  }
  const supabase = getSupabaseAdmin();
  const { data: cl, error: fErr } = await supabase
    .from("clients")
    .select("id, client_name, financials_mode, metadata")
    .eq("client_name", clientName)
    .maybeSingle();
  if (fErr || !cl) throw new Error(fErr?.message || `Client "${clientName}" not found.`);

  if (cleanMode === "relational" && cl.financials_mode !== "relational") {
    throw new Error(
      `Switch ${clientName} to relational financial calculation mode before enabling direct SQL reads.`
    );
  }

  const nextMeta = { ...(cl.metadata || {}), financials_read_mode: cleanMode };
  const { data: upd, error: uErr } = await supabase
    .from("clients")
    .update({ financials_read_mode: cleanMode, metadata: nextMeta })
    .eq("id", cl.id)
    .select("id, client_name, financials_mode, financials_read_mode")
    .single();
  if (uErr) throw new Error(`Failed updating financials_read_mode: ${uErr.message}`);
  invalidateMasterEngineCache(clientName, "client", null, { invalidateSheetContext: true });
  invalidateClientRelationalFinancialsCache(clientName);
  return upd;
}

// ============================================================================
// 6. 100% CELL-FOR-CELL & PORTAL-PAYLOAD PARITY VERIFIERS
// ============================================================================

function normCell_(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    return v;
  }
  if (typeof v === "boolean") return v;
  return String(v);
}

function cellsEqual_(va, vb) {
  if (va === vb) return true;
  if (typeof va === "number" && typeof vb === "number") {
    return Math.abs(va - vb) <= 1e-6;
  }
  return false;
}

function diff2DGrids_(tabName, gridA, gridB, maxSamples = 8) {
  const a = compactGrid2D(gridA || []);
  const b = compactGrid2D(gridB || []);
  const maxR = Math.max(a.length, b.length);
  const diffs = [];
  let mismatchCount = 0;

  for (let r = 0; r < maxR; r++) {
    const rowA = a[r] || [];
    const rowB = b[r] || [];
    const maxC = Math.max(rowA.length, rowB.length);
    for (let c = 0; c < maxC; c++) {
      const va = normCell_(rowA[c]);
      const vb = normCell_(rowB[c]);
      if (!cellsEqual_(va, vb)) {
        mismatchCount++;
        if (diffs.length < maxSamples) {
          diffs.push({
            tab: tabName,
            tabName,
            row: r + 1,
            col: c + 1,
            cellKey: `R${r + 1}C${c + 1}`,
            grid: va,
            relational: vb,
            expected: va,
            actual: vb,
          });
        }
      }
    }
  }
  return { mismatchCount, diffs };
}

function sliceGridForTest_(rec, rangeStr, { formatted = true } = {}) {
  if (!rec) return [];
  const parsed = parseA1Range(rangeStr);
  const grid = rec.values_grid || [];
  const notesGrid = rec.notes_grid || {};
  const startR = parsed.startRow0 ?? 0;
  const endR = Math.min(grid.length - 1, parsed.endRow0 ?? grid.length - 1);
  if (startR > endR || grid.length === 0) return [];
  const sliced = [];
  for (let r = startR; r <= endR; r++) {
    const row = Array.isArray(grid[r]) ? grid[r] : [];
    const startC = parsed.startCol0 ?? 0;
    const endC = parsed.endCol0 !== null ? parsed.endCol0 : Math.max(0, row.length - 1);
    const out = row.slice(startC, endC + 1).map((v) => (v === null || v === undefined ? "" : v));
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    sliced.push(out);
  }
  while (sliced.length > 0 && sliced[sliced.length - 1].length === 0) sliced.pop();
  if (!formatted) return sliced;
  return formatGridForDisplay(
    "client",
    parsed.tabName,
    sliced,
    parsed.startRow0 ?? 0,
    parsed.startCol0 ?? 0,
    grid,
    notesGrid
  );
}

export async function verifyRelationalFinancialsParity({
  clientName = null,
  source = "auto",
  onlyFinancialsEnabled = false,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase5FinancialsSchemaStatus();
  const cols = schema.schemaReady
    ? "id, client_name, financials_mode, metadata"
    : "id, client_name, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  const { data: clients, error } = await query;
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    if (onlyFinancialsEnabled && cl.financials_mode !== "relational") continue;
    try {
      const ctx = { clientId: cl.id, clientName: cl.client_name };
      const canUseDb =
        schema.schemaReady &&
        (source === "db" ||
          (source === "auto" && Boolean(cl.metadata?.relational_financials_state?.lastBackfilledAt)));

      const [bundle, tabRecordsByTab] = await Promise.all([
        preloadClientRelationalFinancialsBundle(ctx, {
          source: canUseDb ? "db" : "in_memory",
          includeFormulas: false,
        }),
        loadExpandedPhase5TabRecords_(supabase, cl.client_name, { valuesOnly: true }),
      ]);

      let totalMismatchCount = 0;
      const sampleMismatches = [];
      let tabsChecked = 0;

      for (const tabName of PHASE5_FINANCIAL_TABS) {
        const expectedRec = tabRecordsByTab[tabName] || null;
        const actualRec = reconstructRelationalFinancialTabFromBundle(bundle, tabName);
        if (!expectedRec && !actualRec) continue;
        tabsChecked++;

        if (!expectedRec || !actualRec) {
          totalMismatchCount++;
          if (sampleMismatches.length < 10) {
            sampleMismatches.push({
              tab: tabName,
              tabName,
              cellKey: "tab_presence",
              grid: expectedRec ? "present" : "missing",
              relational: actualRec ? "present" : "missing",
              expected: expectedRec ? "present" : "missing",
              actual: actualRec ? "present" : "missing",
            });
          }
          continue;
        }

        const expectedVals = compactGrid2D(expectedRec.values_grid || []);
        const actualVals = actualRec.values_grid || [];
        const { mismatchCount, diffs } = diff2DGrids_(tabName, expectedVals, actualVals, 4);
        totalMismatchCount += mismatchCount;
        if (sampleMismatches.length < 10) sampleMismatches.push(...diffs);

        const expNotes = cleanNotesObject_(expectedRec.notes_grid);
        const actNotes = cleanNotesObject_(actualRec.notes_grid);
        if (Object.keys(expNotes).length !== Object.keys(actNotes).length) {
          totalMismatchCount++;
          if (sampleMismatches.length < 10) {
            sampleMismatches.push({
              tab: tabName,
              tabName,
              cellKey: "notes_count",
              grid: Object.keys(expNotes).length,
              relational: Object.keys(actNotes).length,
              expected: Object.keys(expNotes).length,
              actual: Object.keys(actNotes).length,
            });
          }
        }
      }

      results.push({
        clientName: cl.client_name,
        source: bundle?.source || "unknown",
        financialsMode: cl.financials_mode || "grid",
        tabsChecked,
        rollupMonthsCount: bundle?.rollupRows?.length || 0,
        year0LinesCount: bundle?.year0Rows?.length || 0,
        statementLinesCount: bundle?.statementRows?.length || 0,
        vatRowsCount: bundle?.vatRows?.length || 0,
        cashflowLinesCount: bundle?.cashflowRows?.length || 0,
        totalMismatchCount,
        matched: totalMismatchCount === 0,
        sampleMismatches: sampleMismatches.slice(0, 10),
        error: null,
      });
    } catch (err) {
      results.push({
        clientName: cl.client_name,
        source: "error",
        totalMismatchCount: 0,
        matched: false,
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
    matchedClientsCount: results.filter((r) => !r.error && r.matched).length,
    mismatchClientsCount: results.filter((r) => !r.error && !r.matched).length,
    errorClientsCount: results.filter((r) => Boolean(r.error)).length,
    results,
  };
}

export async function verifyRelationalFinancialsReadParity({
  clientName = null,
  source = "auto",
  onlyReadEnabled = false,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase5FinancialsSchemaStatus();
  const cols = schema.schemaReady
    ? "id, client_name, financials_mode, financials_read_mode, metadata"
    : "id, client_name, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  const { data: clients, error } = await query;
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const checkRanges = [
    { tab: "KeyInfo", range: "KeyInfo!A1:J21" },
    { tab: "KeyInfo", range: "KeyInfo!B123:B148" },
    { tab: "Dashboard", range: "Dashboard!A1:AX34" },
    { tab: "Year0Data", range: "Year0Data!G1:T34" },
    { tab: "Performance", range: "Performance!A1:AX83" },
    { tab: "VAT", range: "VAT!A1:AX35" },
    { tab: "Cash", range: "Cash!A1:AK76" },
    { tab: "Calcs", range: "Calcs!A1:AZ37" },
  ];

  const results = [];
  for (const cl of clients || []) {
    if (onlyReadEnabled && cl.financials_read_mode !== "relational") continue;
    try {
      const ctx = { clientId: cl.id, clientName: cl.client_name };
      const canUseDb =
        schema.schemaReady &&
        (source === "db" ||
          (source === "auto" && Boolean(cl.metadata?.relational_financials_state?.lastBackfilledAt)));

      const [bundle, tabRecordsByTab] = await Promise.all([
        preloadClientRelationalFinancialsBundle(ctx, {
          source: canUseDb ? "db" : "in_memory",
          includeFormulas: false,
        }),
        loadExpandedPhase5TabRecords_(supabase, cl.client_name, { valuesOnly: true }),
      ]);

      let mismatchCount = 0;
      const sampleMismatches = [];

      const reconByTab = {};
      for (const tabName of PHASE5_FINANCIAL_TABS) {
        if (tabRecordsByTab[tabName]) {
          reconByTab[tabName] = reconstructRelationalFinancialTabFromBundle(bundle, tabName);
        }
      }

      // 1. Compare formatted + unformatted API slice outputs on all key financial ranges
      for (const item of checkRanges) {
        const expRec = tabRecordsByTab[item.tab];
        const actRec = reconByTab[item.tab];
        if (!expRec && !actRec) continue;
        for (const isFmt of [true, false]) {
          const expSlice = sliceGridForTest_(expRec, item.range, { formatted: isFmt });
          const actSlice = sliceGridForTest_(actRec, item.range, { formatted: isFmt });
          const { mismatchCount: mCnt, diffs } = diff2DGrids_(
            `${item.range}(${isFmt ? "fmt" : "raw"})`,
            expSlice,
            actSlice,
            3
          );
          mismatchCount += mCnt;
          if (sampleMismatches.length < 10) sampleMismatches.push(...diffs);
        }
      }

      // 2. Compare Portal Home + Performance payloads built from SQL vs virtual grids
      const buildPortalBundleFromSource_ = (tabMap) => {
        const keyInfoData = sliceGridForTest_(tabMap.KeyInfo, "KeyInfo!A1:J21", { formatted: true });
        const keyInfoRulesAndFlags = sliceGridForTest_(tabMap.KeyInfo, "KeyInfo!B123:B148", { formatted: true });
        const dashDisp = sliceGridForTest_(tabMap.Dashboard, "Dashboard!A1:AX34", { formatted: true });
        const year0Disp = sliceGridForTest_(tabMap.Year0Data, "Year0Data!G1:T34", { formatted: true });
        const dashMath = sliceGridForTest_(tabMap.Dashboard, "Dashboard!A1:AX34", { formatted: false });
        const year0Math = sliceGridForTest_(tabMap.Year0Data, "Year0Data!G1:T34", { formatted: false });

        const thresholdsRaw = [];
        for (let r = 0; r < 18; r++) thresholdsRaw.push(keyInfoRulesAndFlags[r]?.[0] ?? "");
        const featureFlags = {
          version: keyInfoData[0]?.[0] || "",
          showStaffCostsRatio: String(keyInfoRulesAndFlags[20]?.[0] || "Yes"),
          showCashMenu: String(keyInfoRulesAndFlags[21]?.[0] || "Yes"),
          showBudget: String(keyInfoRulesAndFlags[22]?.[0] || "Yes"),
          showCashflowChart: String(keyInfoRulesAndFlags[23]?.[0] || "Yes"),
          showLast12MonthsChart: String(keyInfoRulesAndFlags[24]?.[0] || "Yes"),
          showTrendlines: String(keyInfoRulesAndFlags[25]?.[0] || "Yes"),
        };

        const payload = buildPortalPayloadFromGrids({
          keyInfoData,
          dashDisp,
          dashMath,
          year0Disp,
          year0Math,
          thresholdsRaw,
          featureFlags,
          clientName: cl.client_name,
        });
        const perf = buildPortalPerformanceFromGrids({
          keyInfoData,
          dashDisp,
          dashMath,
          year0Disp,
          year0Math,
          thresholdsRaw,
          featureFlags,
          clientName: cl.client_name,
        });
        return { payload, perf };
      };

      const stripCachedAt_ = (obj) => {
        if (!obj || typeof obj !== "object") return obj;
        const copy = { ...obj };
        delete copy._cachedAt;
        return copy;
      };

      const gridPortal = buildPortalBundleFromSource_(tabRecordsByTab);
      const sqlPortal = buildPortalBundleFromSource_(reconByTab);
      const gridPayloadStr = JSON.stringify(stripCachedAt_(gridPortal.payload));
      const sqlPayloadStr = JSON.stringify(stripCachedAt_(sqlPortal.payload));
      if (gridPayloadStr !== sqlPayloadStr) {
        mismatchCount++;
        if (sampleMismatches.length < 10) {
          sampleMismatches.push({
            tab: "PortalHome",
            tabName: "PortalHome",
            cellKey: "payload",
            grid: "grid payload",
            relational: "differs from grid",
            expected: gridPayloadStr.slice(0, 120),
            actual: sqlPayloadStr.slice(0, 120),
          });
        }
      }
      const gridPerfStr = JSON.stringify(stripCachedAt_(gridPortal.perf));
      const sqlPerfStr = JSON.stringify(stripCachedAt_(sqlPortal.perf));
      if (gridPerfStr !== sqlPerfStr) {
        mismatchCount++;
        if (sampleMismatches.length < 10) {
          sampleMismatches.push({
            tab: "PortalPerformance",
            tabName: "PortalPerformance",
            cellKey: "perf",
            grid: "grid performance",
            relational: "differs from grid",
            expected: gridPerfStr.slice(0, 120),
            actual: sqlPerfStr.slice(0, 120),
          });
        }
      }

      results.push({
        clientName: cl.client_name,
        source: bundle?.source || "unknown",
        financialsMode: cl.financials_mode || "grid",
        financialsReadMode: cl.financials_read_mode || "grid",
        tabsChecked: Object.keys(reconByTab).length,
        statementLinesCount: bundle?.statementRows?.length || 0,
        cashflowLinesCount: bundle?.cashflowRows?.length || 0,
        matched: mismatchCount === 0,
        mismatchCount,
        sampleMismatches: sampleMismatches.slice(0, 10),
        error: null,
      });
    } catch (err) {
      results.push({
        clientName: cl.client_name,
        source: "error",
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
    schemaReady: schema.schemaReady,
    clientsChecked: results.length,
    matchedClientsCount: results.filter((r) => !r.error && r.matched).length,
    mismatchClientsCount: results.filter((r) => !r.error && !r.matched).length,
    errorClientsCount: results.filter((r) => Boolean(r.error)).length,
    results,
  };
}
