/**
 * ============================================================================
 * PULSE PHASE 6A: NATIVE RELATIONAL CLIENT FINANCIAL CALCULATOR SERVICE
 * ============================================================================
 * Reconstructs every Client Sheet tab purely from normalized relational tables
 * (`pulse_jobs`, `pulse_job_invoices`, `pulse_job_expenses`, `pulse_employees`,
 * `pulse_outgoing_items`, `pulse_contractor_entries`, `pulse_nb_to_find`,
 * `pulse_budget_items`, `pulse_cash_adjustments`, `pulse_financial_*`,
 * `pulse_recon_*`, and compacted `pulse_client_tab_blueprints`) without reading
 * or writing `master_sheet_grids` when `client_compute_mode === 'native'`.
 *
 * Also implements:
 *   - Gate 1A: `verifyNativeClientCalcParity` (16/16 live client replay parity)
 *   - Gate 2A: `verifyNativeClientMutationMatrix` (4x mutation clone parity)
 *   - Gate 4:  `verifyRelationalAccountingInvariants` (independent SQL math oracle)
 * ============================================================================
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import {
  CORE_CLIENT_TABS,
  resolveSupabaseSheetContext,
  invalidateMasterEngineCache,
  compactClientTabForStorage_,
  expandClientTabFromStorage_,
} from "./masterEngineService.js";
import { recalculateClientGrids } from "./gasRuntime/clientFormulaEngine.js";
import { compactGrid2D } from "./gasRuntime/masterFormulaEngine.js";
import {
  preloadClientRelationalJobsBundle,
  parseTabGridToRelationalModel,
  projectRelationalModelToTabGrid,
} from "./relationalJobsService.js";
import {
  preloadClientRelationalInputsBundle,
  parseSalariesTabToEmployees,
  projectEmployeesToSalariesGrid,
  parseOutgoingsTabToItems,
  projectOutgoingItemsToGrid,
  parseOutgNotesTabToContractorEntries,
  projectContractorEntriesToOutgNotesGrid,
  parseNbToFindTabToRecord,
  projectNbToFindRecordToGrid,
  parseBudgetTabToItems,
  projectBudgetItemsToGrid,
  parseCashTabToAdjustments,
  projectCashAdjustmentsToGrid,
  reconstructRelationalTabFromBundle,
} from "./relationalInputsService.js";
import {
  PHASE5_FINANCIAL_TABS,
  preloadClientRelationalFinancialsBundle,
  reconstructRelationalFinancialTabFromBundle,
} from "./relationalFinancialsService.js";
import {
  preloadClientRelationalReconBundle,
  reconstructRelationalReconTabFromBundle,
} from "./relationalReconService.js";
import { fetchVatData } from "./vatService.js";

if (typeof window !== "undefined") {
  throw new Error("SECURITY VIOLATION: services/nativeClientCalcService.js must never run in browser code.");
}

const PHASE5_SET = new Set(PHASE5_FINANCIAL_TABS);
const NON_FORMULA_TABS = new Set(["Sessions", "AppLog", "Welcome"]);
const ERROR_CELL_RE = /^#(?:REF!|NAME\?|VALUE!|DIV\/0!|NUM!|N\/A|ERROR!)\b/i;

const CORE_CLIENT_FORMULA_TABS_SET = new Set([
  ...CORE_CLIENT_TABS,
  "REF",
  "AppData",
  "FormCheck",
]);

const BUDGET_MANAGED_ROWS = new Set();
for (let r = 5; r <= 9; r++) BUDGET_MANAGED_ROWS.add(r);
for (let r = 13; r <= 17; r++) BUDGET_MANAGED_ROWS.add(r);
for (let r = 21; r <= 25; r++) BUDGET_MANAGED_ROWS.add(r);
for (let r = 58; r <= 112; r++) BUDGET_MANAGED_ROWS.add(r);
for (let r = 118; r <= 120; r++) BUDGET_MANAGED_ROWS.add(r);
for (let r = 126; r <= 143; r++) BUDGET_MANAGED_ROWS.add(r);
for (let r = 149; r <= 251; r++) BUDGET_MANAGED_ROWS.add(r);

const MONTHLY_48_COLS = [];
for (const band of [
  { startCol: 6, count: 12 },
  { startCol: 21, count: 12 },
  { startCol: 36, count: 12 },
]) {
  for (let i = 0; i < band.count; i++) MONTHLY_48_COLS.push(band.startCol + i);
}

let _cachedMigration0017Sql = null;
let _schemaReadyCache = { ready: null, checkedAt: 0 };
const _blueprintCache = new Map();
const BLUEPRINT_CACHE_TTL_MS = 30000;

export function readMigration0017Sql() {
  if (_cachedMigration0017Sql !== null) return _cachedMigration0017Sql;
  try {
    const candidates = [
      path.join(process.cwd(), "supabase", "migrations", "0017_phase6ab_native_compute.sql"),
      path.join(process.cwd(), "pulse-management-system", "supabase", "migrations", "0017_phase6ab_native_compute.sql"),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations/0017_phase6ab_native_compute.sql"),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    _cachedMigration0017Sql = found ? fs.readFileSync(found, "utf8") : "";
  } catch {
    _cachedMigration0017Sql = "";
  }
  return _cachedMigration0017Sql;
}

export function invalidateClientNativeCalcCache(clientName, tabNames = null) {
  const key = String(clientName || "").trim().toLowerCase();
  if (!key) {
    _blueprintCache.clear();
    return;
  }
  if (!Array.isArray(tabNames) || tabNames.length === 0) {
    for (const k of _blueprintCache.keys()) {
      if (k.startsWith(`${key}::`)) _blueprintCache.delete(k);
    }
    return;
  }
  for (const t of tabNames) {
    _blueprintCache.delete(`${key}::${t}`);
  }
}

function str_(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function clone2D_(grid) {
  if (!Array.isArray(grid)) return [];
  return grid.map((r) => (Array.isArray(r) ? [...r] : []));
}

function toNumOrNull_(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s || s.startsWith("#") || s.startsWith("=")) return null;
  const cleaned = s.replace(/[£$€,\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function findLastActiveJobRowForClear_(valuesGrid, tabName) {
  const minDef = tabName === "Confirmed" || tabName === "ConfCalcs" ? 295 : 105;
  if (!Array.isArray(valuesGrid)) return minDef;
  let last = 1;
  const scanMax = Math.min(valuesGrid.length - 1, 5050);
  for (let r = 1; r <= scanMax; r++) {
    const row = valuesGrid[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < Math.min(row.length, 108); c++) {
      const v = row[c];
      if (v !== "" && v !== null && v !== undefined && v !== 0 && v !== "0" && v !== false) {
        if (c < 40 || (c >= 41 && c < 60) || (c >= 75 && c < 96) || c === 107) {
          last = r;
          break;
        }
      }
    }
  }
  return Math.max(last + 2, minDef);
}

function formulaRefsMissingSheetInMap_(f, currentTab, loadedMap) {
  if (typeof f !== "string" || !f.includes("!")) return false;
  const stripped = f.replace(/"(?:""|[^"])*"/g, "");
  const hasTab = (name) =>
    loadedMap instanceof Set ? loadedMap.has(name) : Boolean(loadedMap && loadedMap[name]);
  const matches = stripped.matchAll(/(?:'([^']+)'|([A-Za-z0-9_]+))!/g);
  for (const m of matches) {
    const refTab = m[1] || m[2];
    if (refTab && refTab !== currentTab && refTab !== "REF" && !hasTab(refTab)) {
      return true;
    }
  }
  return false;
}

function buildInputSnapshotsForRecompute_(tabName, grid) {
  const rows = Array.isArray(grid) ? grid : [];
  let maxRow = rows.length;
  if (tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs") {
    maxRow = Math.min(rows.length, Math.max(findLastActiveJobRowForClear_(rows, tabName) + 4, 2));
  }
  return { maxRow };
}

function cloneFormulaEntryMap_(src) {
  const out = Object.create(null);
  for (const [k, rec] of Object.entries(src || {})) {
    if (!rec) continue;
    out[k] = {
      values: clone2D_(rec.values_grid || rec.values || []),
      formulas: clone2D_(rec.formulas_grid || rec.formulas || rec.values_grid || rec.values || []),
      notes: rec.notes_grid && typeof rec.notes_grid === "object" ? { ...rec.notes_grid } : {},
    };
  }
  return out;
}

function wipeFormulaValuesForRecompute_(gridsObj) {
  const preservedFormulaValues = new Map();
  for (const [tabName, entry] of Object.entries(gridsObj)) {
    if (!entry || NON_FORMULA_TABS.has(tabName)) continue;
    const vGrid = entry.values || [];
    const fGrid = entry.formulas || [];
    const { maxRow } = buildInputSnapshotsForRecompute_(tabName, vGrid);
    const limitR = Math.min(maxRow, fGrid.length);
    for (let r = 0; r < limitR; r++) {
      const rowF = fGrid[r] || [];
      for (let c = 0; c < rowF.length; c++) {
        const f = rowF[c];
        if (typeof f === "string" && f.startsWith("=")) {
          const curV = vGrid[r]?.[c];
          if (typeof curV === "string" && curV.startsWith("#REF! (Array result was not expanded")) {
            continue;
          }
          if (tabName === "DataForReport" && (c === 6 || r === 2)) {
            continue;
          }
          const refsNonCore = formulaRefsMissingSheetInMap_(f, tabName, CORE_CLIENT_FORMULA_TABS_SET);
          const hasImportRange = /IMPORTRANGE\s*\(/i.test(f);
          if (
            (refsNonCore || hasImportRange) &&
            curV !== "" &&
            curV !== null &&
            curV !== undefined &&
            !(typeof curV === "string" && curV.startsWith("#VALUE! (Cannot coerce 'Symbol("))
          ) {
            preservedFormulaValues.set(`${tabName}!${r},${c}`, curV);
          }
          if (refsNonCore) continue;
          if (vGrid[r]) vGrid[r][c] = "";
        }
      }
    }
  }
  return preservedFormulaValues;
}

async function extractReferencedReconGrids_(ctx, formulaGrids, { source = "db" } = {}) {
  const reconTabs = new Set();
  const rx = /IMPORTRANGE\s*\(\s*(?:KeyInfo!)?\$?G\$?1\s*,\s*"([^"]+)"/gi;
  for (const fGrid of formulaGrids || []) {
    if (!Array.isArray(fGrid)) continue;
    for (let r = 0; r < fGrid.length; r++) {
      const row = fGrid[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length; c++) {
        const f = row[c];
        if (typeof f !== "string" || !f.includes("!") || !/IMPORTRANGE/i.test(f)) continue;
        rx.lastIndex = 0;
        let m;
        while ((m = rx.exec(f)) !== null) {
          const refRange = m[1] || "";
          const bang = refRange.indexOf("!");
          if (bang > 0) {
            const tabName = refRange.slice(0, bang).trim().replace(/^'|'$/g, "");
            if (tabName) reconTabs.add(tabName);
          }
        }
      }
    }
  }
  if (reconTabs.size === 0) return null;

  const out = Object.create(null);
  try {
    const bundle = await preloadClientRelationalReconBundle(ctx, {
      source: source === "db" ? "db" : "in_memory",
    });
    for (const t of reconTabs) {
      const rec = reconstructRelationalReconTabFromBundle(bundle, t);
      if (rec && Array.isArray(rec.values_grid)) {
        out[t] = { values: rec.values_grid };
      }
    }
  } catch {
    // fallback empty
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ============================================================================
// 1. SCHEMA STATUS & OVERVIEW STATS
// ============================================================================

export async function checkPhase6NativeComputeSchemaStatus({ forceRefresh = false } = {}) {
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
      supabase.from("clients").select("client_compute_mode, master_compute_mode").limit(1),
      supabase.from("pulse_client_tab_blueprints").select("id, tab_name, row_count").limit(1),
      supabase
        .from("pulse_master_sync_configs")
        .select("client_id, master_key_info_grid, data_chg_alert_grid, master_pl_adds_grid")
        .limit(1),
      supabase
        .from("pulse_master_comparisons")
        .select("id, comparison_type, discrepancy_count")
        .limit(1),
    ]);
    const ready = checks.every((c) => !c.error);
    _schemaReadyCache = { ready, checkedAt: now };
    return {
      schemaReady: ready,
      ...(ready ? {} : { reason: checks.find((c) => c.error)?.error?.message || "Migration 0017 required" }),
    };
  } catch (err) {
    _schemaReadyCache = { ready: false, checkedAt: now };
    return { schemaReady: false, reason: err.message };
  }
}

export async function getPhase6NativeComputeOverviewStats() {
  const migrationSql = readMigration0017Sql();
  const status = await checkPhase6NativeComputeSchemaStatus();
  if (!status.schemaReady) {
    return {
      schemaReady: false,
      migrationSql,
      reason: status.reason || "Migration 0017 required",
      totalClientBlueprintTabs: 0,
      totalMasterComparisons: 0,
      clientsOnNativeClientCalc: 0,
      clientsOnShadowClientCalc: 0,
      clientsOnNativeMasterComp: 0,
      clientsOnShadowMasterComp: 0,
    };
  }
  const supabase = getSupabaseAdmin();
  const [bpCnt, mcCnt, clRowsRes] = await Promise.all([
    supabase.from("pulse_client_tab_blueprints").select("id", { count: "exact", head: true }),
    supabase.from("pulse_master_comparisons").select("id", { count: "exact", head: true }),
    supabase.from("clients").select("client_compute_mode, master_compute_mode"),
  ]);
  const cls = clRowsRes.data || [];
  return {
    schemaReady: true,
    migrationSql,
    totalClientBlueprintTabs: bpCnt.count || 0,
    totalMasterComparisons: mcCnt.count || 0,
    clientsOnNativeClientCalc: cls.filter((c) => c.client_compute_mode === "native").length,
    clientsOnShadowClientCalc: cls.filter((c) => c.client_compute_mode === "shadow").length,
    clientsOnNativeMasterComp: cls.filter((c) => c.master_compute_mode === "native").length,
    clientsOnShadowMasterComp: cls.filter((c) => c.master_compute_mode === "shadow").length,
  };
}

// ============================================================================
// 2. CLIENT TAB BLUEPRINT STORAGE & BACKFILL (`pulse_client_tab_blueprints`)
// ============================================================================

async function loadRawClientTabsFromGrids_(supabase, clientName, { valuesOnly = false, tabNames = null } = {}) {
  const list = Array.isArray(tabNames) && tabNames.length > 0 ? tabNames : CORE_CLIENT_TABS;
  const targetNames = [...list, ...list.map((t) => `Client::${t}`)];
  const selectCols = valuesOnly
    ? "tab_name, sheet_role, row_count, col_count, values_grid, notes_grid, updated_at"
    : "tab_name, sheet_role, row_count, col_count, values_grid, formulas_grid, notes_grid, updated_at";

  const rows = [];
  for (let i = 0; i < targetNames.length; i += 20) {
    const chunk = targetNames.slice(i, i + 20);
    const { data, error } = await supabase
      .from("master_sheet_grids")
      .select(selectCols)
      .eq("client_name", clientName)
      .in("sheet_role", ["client", "master"])
      .in("tab_name", chunk);
    if (error) throw new Error(`Failed loading client grids for ${clientName}: ${error.message}`);
    if (Array.isArray(data)) rows.push(...data);
  }

  const byTab = {};
  for (const t of list) {
    const rec =
      rows.find((r) => r.sheet_role === "client" && r.tab_name === t) ||
      rows.find((r) => r.sheet_role === "master" && r.tab_name === `Client::${t}`) ||
      null;
    if (!rec) continue;
    const clone = { ...rec, tab_name: t, sheet_role: "client" };
    expandClientTabFromStorage_(clone, t, { valuesOnly });
    byTab[t] = clone;
  }
  return byTab;
}

export async function saveNativeClientTabBlueprint(
  ctx,
  tabName,
  valuesGrid,
  formulasGrid = null,
  notesGrid = null,
  options = {}
) {
  if (!ctx?.clientId || !tabName) return null;
  const fullValues = Array.isArray(valuesGrid) ? valuesGrid : [];
  const fullFormulas =
    Array.isArray(formulasGrid) && formulasGrid.length > 0 ? formulasGrid : fullValues;
  const baseNotes = notesGrid && typeof notesGrid === "object" ? notesGrid : {};
  const maxCols = Math.max(
    fullValues.reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0),
    fullFormulas.reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0)
  );
  const { storedValues, storedFormulas, storedNotes, totalRows } = compactClientTabForStorage_(
    tabName,
    fullValues,
    fullFormulas,
    baseNotes
  );
  const cleanNotesMeta = storedNotes && typeof storedNotes === "object" ? storedNotes : {};
  const nowIso = new Date().toISOString();

  const rowPayload = {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    tab_name: tabName,
    row_count: totalRows,
    col_count: maxCols,
    base_values_grid: storedValues,
    formulas_blueprint: storedFormulas,
    notes_meta: cleanNotesMeta,
    updated_at: nowIso,
  };

  const cacheKey = `${String(ctx.clientName).trim().toLowerCase()}::${tabName}`;
  _blueprintCache.set(cacheKey, {
    expiresAt: Date.now() + BLUEPRINT_CACHE_TTL_MS,
    row: rowPayload,
  });

  if (options.memoryOnly) {
    return rowPayload;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return rowPayload;
  const { error } = await supabase
    .from("pulse_client_tab_blueprints")
    .upsert(rowPayload, { onConflict: "client_id,tab_name" });
  if (error) {
    throw new Error(`pulse_client_tab_blueprints upsert failed (${ctx.clientName}/${tabName}): ${error.message}`);
  }
  return rowPayload;
}

export async function backfillClientNativeCalc(clientName) {
  const schema = await checkPhase6NativeComputeSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0017 must be applied in Supabase SQL Editor before backfilling blueprints.");
  }
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) throw new Error(`Client "${clientName}" not found.`);

  const supabase = getSupabaseAdmin();
  const rawTabs = await loadRawClientTabsFromGrids_(supabase, ctx.clientName, { valuesOnly: false });
  const nowIso = new Date().toISOString();
  const rows = [];

  for (const [tabName, rec] of Object.entries(rawTabs)) {
    const vals = Array.isArray(rec.values_grid) ? rec.values_grid : [];
    const forms =
      Array.isArray(rec.formulas_grid) && rec.formulas_grid.length > 0 ? rec.formulas_grid : vals;
    const notes = rec.notes_grid && typeof rec.notes_grid === "object" ? rec.notes_grid : {};
    const maxCols = Math.max(
      Number(rec.col_count) || 0,
      vals.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
      forms.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
    );
    const { storedValues, storedFormulas, storedNotes, totalRows } = compactClientTabForStorage_(
      tabName,
      vals,
      forms,
      notes
    );
    rows.push({
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      tab_name: tabName,
      row_count: totalRows,
      col_count: maxCols,
      base_values_grid: storedValues,
      formulas_blueprint: storedFormulas,
      notes_meta: storedNotes || {},
      updated_at: nowIso,
    });
  }

  for (let i = 0; i < rows.length; i += 4) {
    const chunk = rows.slice(i, i + 4);
    const { error } = await supabase
      .from("pulse_client_tab_blueprints")
      .upsert(chunk, { onConflict: "client_id,tab_name" });
    if (error) {
      // Retry individually for large payloads
      for (const item of chunk) {
        const { error: singleErr } = await supabase
          .from("pulse_client_tab_blueprints")
          .upsert([item], { onConflict: "client_id,tab_name" });
        if (singleErr) {
          throw new Error(
            `Failed backfilling blueprint ${ctx.clientName}/${item.tab_name}: ${singleErr.message}`
          );
        }
      }
    }
  }

  const keepTabs = new Set(rows.map((r) => r.tab_name));
  const { data: existingRows } = await supabase
    .from("pulse_client_tab_blueprints")
    .select("id, tab_name")
    .eq("client_id", ctx.clientId);
  const staleIds = (existingRows || []).filter((r) => !keepTabs.has(r.tab_name)).map((r) => r.id);
  if (staleIds.length > 0) {
    await supabase.from("pulse_client_tab_blueprints").delete().in("id", staleIds);
  }

  const { data: clRow } = await supabase
    .from("clients")
    .select("metadata")
    .eq("id", ctx.clientId)
    .maybeSingle();
  const prevMeta = clRow?.metadata && typeof clRow.metadata === "object" ? clRow.metadata : {};
  const stateSummary = {
    lastBackfilledAt: nowIso,
    blueprintTabsCount: rows.length,
  };
  await supabase
    .from("clients")
    .update({
      metadata: {
        ...prevMeta,
        native_client_calc_state: {
          ...(prevMeta.native_client_calc_state || {}),
          ...stateSummary,
        },
      },
    })
    .eq("id", ctx.clientId);

  invalidateClientNativeCalcCache(ctx.clientName);
  return {
    clientName: ctx.clientName,
    blueprintTabsCount: rows.length,
    ...stateSummary,
  };
}

export async function backfillAllClientsNativeCalc() {
  const schema = await checkPhase6NativeComputeSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0017 must be applied in Supabase SQL Editor before backfilling blueprints.");
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
      const s = await backfillClientNativeCalc(cl.client_name);
      results.push({ ...s, error: null });
    } catch (err) {
      results.push({ clientName: cl.client_name, error: err.message, blueprintTabsCount: 0 });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    totalClients: results.length,
    clientsProcessed: results.filter((r) => !r.error).length,
    succeededCount: results.filter((r) => !r.error).length,
    errorCount: results.filter((r) => Boolean(r.error)).length,
    totalBlueprintTabs: results.reduce((a, r) => a + (r.blueprintTabsCount || 0), 0),
    results,
  };
}

// ============================================================================
// 3. GRID-FREE RELATIONAL CLIENT TAB ASSEMBLY
// ============================================================================

function expandBlueprintRow_(bpRow, tabName, { valuesOnly = false } = {}) {
  if (!bpRow) return null;
  const mockRec = {
    tab_name: tabName,
    sheet_role: "client",
    row_count: Number(bpRow.row_count) || 0,
    col_count: Number(bpRow.col_count) || 0,
    values_grid: Array.isArray(bpRow.base_values_grid) ? bpRow.base_values_grid : [],
    formulas_grid: !valuesOnly && Array.isArray(bpRow.formulas_blueprint) ? bpRow.formulas_blueprint : [],
    notes_grid: bpRow.notes_meta && typeof bpRow.notes_meta === "object" ? { ...bpRow.notes_meta } : {},
    updated_at: bpRow.updated_at || null,
  };
  expandClientTabFromStorage_(mockRec, tabName, { valuesOnly });
  return mockRec;
}

function budgetTemplateDefaultsForRow_(rowNum) {
  if (rowNum >= 58 && rowNum <= 112) return { col1: 0, col4: 1 };
  if (rowNum >= 126 && rowNum <= 143) return { col4: 1 };
  if (rowNum >= 149 && rowNum <= 251) return { col4: 0 };
  return {};
}

function clearUnoccupiedBudgetInputs_(valuesGrid, formulasGrid, notesGrid, rowsToClear) {
  for (const rowNum of rowsToClear) {
    if (!BUDGET_MANAGED_ROWS.has(rowNum)) continue;
    const r0 = rowNum - 1;
    const defs = budgetTemplateDefaultsForRow_(rowNum);
    const defaultCell = (c) => {
      if (c === 1 && defs.col1 !== undefined) return defs.col1;
      if (c === 4 && defs.col4 !== undefined) return defs.col4;
      return "";
    };
    if (Array.isArray(valuesGrid[r0])) {
      for (let c = 0; c <= 4; c++) {
        if (typeof formulasGrid?.[r0]?.[c] !== "string" || !formulasGrid[r0][c].startsWith("=")) {
          valuesGrid[r0][c] = defaultCell(c);
        }
      }
      for (const c of MONTHLY_48_COLS) {
        if (c < valuesGrid[r0].length) {
          if (typeof formulasGrid?.[r0]?.[c] !== "string" || !formulasGrid[r0][c].startsWith("=")) {
            valuesGrid[r0][c] = "";
          }
        }
      }
    }
    if (Array.isArray(formulasGrid?.[r0])) {
      for (let c = 0; c <= 4; c++) {
        if (typeof formulasGrid[r0][c] !== "string" || !formulasGrid[r0][c].startsWith("=")) {
          formulasGrid[r0][c] = defaultCell(c);
        }
      }
      for (const c of MONTHLY_48_COLS) {
        if (c < formulasGrid[r0].length) {
          if (typeof formulasGrid[r0][c] !== "string" || !formulasGrid[r0][c].startsWith("=")) {
            formulasGrid[r0][c] = "";
          }
        }
      }
    }
    if (notesGrid && typeof notesGrid === "object") {
      const prefix = `${r0}:`;
      for (const k of Object.keys(notesGrid)) {
        if (k.startsWith(prefix)) delete notesGrid[k];
      }
    }
  }
}

async function loadInMemoryBlueprintRowsMap_(supabase, clientName, tabNames, { rawGridsMap = null } = {}) {
  const sourceGrids =
    rawGridsMap || (await loadRawClientTabsFromGrids_(supabase, clientName, { valuesOnly: false, tabNames }));
  const map = new Map();
  for (const t of tabNames) {
    const rec = sourceGrids[t];
    if (!rec) continue;
    const vals = Array.isArray(rec.values_grid) ? rec.values_grid : [];
    const forms =
      Array.isArray(rec.formulas_grid) && rec.formulas_grid.length > 0 ? rec.formulas_grid : vals;
    const notes = rec.notes_grid && typeof rec.notes_grid === "object" ? rec.notes_grid : {};
    const maxCols = Math.max(
      Number(rec.col_count) || 0,
      vals.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
      forms.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
    );
    const { storedValues, storedFormulas, storedNotes, totalRows } = compactClientTabForStorage_(
      t,
      vals,
      forms,
      notes
    );
    map.set(t, {
      tab_name: t,
      row_count: totalRows,
      col_count: maxCols,
      base_values_grid: storedValues,
      formulas_blueprint: storedFormulas,
      notes_meta: storedNotes || {},
      updated_at: rec.updated_at || null,
    });
  }
  return { bpByTab: map, rawGridsMap: sourceGrids };
}

async function loadDbBlueprintRowsMap_(supabase, ctx, tabNames, { valuesOnly = false } = {}) {
  const clientKey = String(ctx.clientName || "").trim().toLowerCase();
  const map = new Map();
  const missing = [];
  for (const t of tabNames) {
    const ck = `${clientKey}::${t}`;
    const c = _blueprintCache.get(ck);
    if (c && c.expiresAt > Date.now() && (valuesOnly || Array.isArray(c.row?.formulas_blueprint))) {
      map.set(t, c.row);
    } else {
      missing.push(t);
    }
  }
  if (missing.length > 0) {
    const cols = valuesOnly
      ? "tab_name, row_count, col_count, base_values_grid, notes_meta, updated_at"
      : "tab_name, row_count, col_count, base_values_grid, formulas_blueprint, notes_meta, updated_at";
    for (let i = 0; i < missing.length; i += 12) {
      const chunk = missing.slice(i, i + 12);
      const { data, error } = await supabase
        .from("pulse_client_tab_blueprints")
        .select(cols)
        .eq("client_id", ctx.clientId)
        .in("tab_name", chunk);
      if (error) {
        throw new Error(`pulse_client_tab_blueprints query failed (${ctx.clientName}): ${error.message}`);
      }
      for (const row of data || []) {
        map.set(row.tab_name, row);
        if (!valuesOnly) {
          _blueprintCache.set(`${clientKey}::${row.tab_name}`, {
            expiresAt: Date.now() + BLUEPRINT_CACHE_TTL_MS,
            row,
          });
        }
      }
    }
  }
  return map;
}

function overlaySparseReconForValuesOnly_(projectedVals = [], projectedForms = [], reconVals = []) {
  const out = clone2D_(projectedVals);
  for (let r = 0; r < reconVals.length; r++) {
    const rRow = reconVals[r];
    if (!Array.isArray(rRow)) continue;
    while (out.length <= r) out.push([]);
    const pFormRow = projectedForms[r] || [];
    for (let c = 0; c < rRow.length; c++) {
      const rv = rRow[c];
      if (rv === "" || rv === null || rv === undefined) continue;
      const cur = out[r][c];
      const fStr = pFormRow[c];
      const isFormula = typeof fStr === "string" && fStr.startsWith("=");
      if (cur === "" || cur === null || cur === undefined || isFormula) {
        out[r][c] = rv;
      }
    }
  }
  return out;
}

export async function loadNativeClientTabRecordsBatch(
  ctxOrClientName,
  tabNames = CORE_CLIENT_TABS,
  {
    source = "db",
    valuesOnly = false,
    includeNotes = true,
    rawGridsOverride = null,
    jobsBundleOverride = null,
    inputsBundleOverride = null,
    financialsBundleOverride = null,
  } = {}
) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) throw new Error("Valid client context is required.");

  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const reqTabs = [...new Set((Array.isArray(tabNames) ? tabNames : CORE_CLIENT_TABS).filter(Boolean))];
  const reqSet = new Set(reqTabs);
  const needJobs = reqSet.has("Confirmed") || reqSet.has("Pipeline");
  const needSalaries = reqSet.has("Salaries");
  const needOutgoings = reqSet.has("Outgoings") || reqSet.has("OutgNotes");
  const needOutgNotes = reqSet.has("OutgNotes");
  const needNb = reqSet.has("NBtoFind");
  const needBudget = reqSet.has("Budget");
  const needCashAdj = reqSet.has("Cash") && !valuesOnly;
  const needAnyInputs = needSalaries || needOutgoings || needOutgNotes || needNb || needBudget || needCashAdj;
  const needFin = reqTabs.some((t) => PHASE5_SET.has(t));

  let bpByTab;
  let inMemRawGrids = rawGridsOverride || null;
  if (source === "in_memory") {
    const res = await loadInMemoryBlueprintRowsMap_(supabase, ctx.clientName, reqTabs, {
      rawGridsMap: inMemRawGrids,
    });
    bpByTab = res.bpByTab;
    inMemRawGrids = res.rawGridsMap;
  } else {
    bpByTab = await loadDbBlueprintRowsMap_(supabase, ctx, reqTabs, { valuesOnly });
  }

  let jobsBundle = jobsBundleOverride || null;
  let inputsBundle = inputsBundleOverride || null;
  let finBundle = financialsBundleOverride || null;

  if (source === "in_memory") {
    if (needJobs && !jobsBundle) {
      const mConf = reqSet.has("Confirmed")
        ? parseTabGridToRelationalModel({
            clientId: ctx.clientId,
            clientName: ctx.clientName,
            tabName: "Confirmed",
            valuesGrid: inMemRawGrids.Confirmed?.values_grid || [],
            formulasGrid: inMemRawGrids.Confirmed?.formulas_grid || [],
            notesGrid: inMemRawGrids.Confirmed?.notes_grid || {},
          })
        : { jobs: [] };
      const mPipe = reqSet.has("Pipeline")
        ? parseTabGridToRelationalModel({
            clientId: ctx.clientId,
            clientName: ctx.clientName,
            tabName: "Pipeline",
            valuesGrid: inMemRawGrids.Pipeline?.values_grid || [],
            formulasGrid: inMemRawGrids.Pipeline?.formulas_grid || [],
            notesGrid: inMemRawGrids.Pipeline?.notes_grid || {},
          })
        : { jobs: [] };
      jobsBundle = {
        jobsByTab: { Confirmed: mConf.jobs, Pipeline: mPipe.jobs },
        invoicesByJobId: new Map(),
        expensesByJobId: new Map(),
      };
    }
    if (needAnyInputs && !inputsBundle) {
      const outItems = needOutgoings
        ? parseOutgoingsTabToItems({
            clientId: ctx.clientId,
            clientName: ctx.clientName,
            valuesGrid: inMemRawGrids.Outgoings?.values_grid || [],
            formulasGrid: inMemRawGrids.Outgoings?.formulas_grid || [],
            notesGrid: inMemRawGrids.Outgoings?.notes_grid || {},
          })
        : [];
      const rowToItem = new Map(outItems.map((it) => [Number(it.sheet_row_num), it]));
      const salG = inMemRawGrids.Salaries || {};
      const outG = inMemRawGrids.Outgoings || {};
      const nbG = inMemRawGrids.NBtoFind || {};
      const budG = inMemRawGrids.Budget || {};
      const cashG = inMemRawGrids.Cash || {};
      inputsBundle = {
        employees: needSalaries
          ? parseSalariesTabToEmployees({
              clientId: ctx.clientId,
              clientName: ctx.clientName,
              valuesGrid: salG.values_grid || [],
              formulasGrid: salG.formulas_grid || [],
              notesGrid: salG.notes_grid || {},
            })
          : [],
        outgoingItems: outItems,
        contractorEntries: needOutgNotes
          ? parseOutgNotesTabToContractorEntries({
              clientId: ctx.clientId,
              clientName: ctx.clientName,
              valuesGrid: inMemRawGrids.OutgNotes?.values_grid || [],
              formulasGrid: inMemRawGrids.OutgNotes?.formulas_grid || [],
              outgoingItemByRow: rowToItem,
            })
          : [],
        nbRecord: needNb
          ? parseNbToFindTabToRecord({
              clientId: ctx.clientId,
              clientName: ctx.clientName,
              valuesGrid: nbG.values_grid || [],
              formulasGrid: nbG.formulas_grid || [],
              notesGrid: nbG.notes_grid || {},
            })
          : null,
        budgetItems: needBudget
          ? parseBudgetTabToItems({
              clientId: ctx.clientId,
              clientName: ctx.clientName,
              valuesGrid: budG.values_grid || [],
              formulasGrid: budG.formulas_grid || [],
              notesGrid: budG.notes_grid || {},
            })
          : [],
        cashAdjustments: needCashAdj
          ? parseCashTabToAdjustments({
              clientId: ctx.clientId,
              clientName: ctx.clientName,
              valuesGrid: cashG.values_grid || [],
              formulasGrid: cashG.formulas_grid || [],
              notesGrid: cashG.notes_grid || {},
            })
          : [],
        rollups: {
          tabHeaders: {
            Salaries: (salG.values_grid?.[0] || []).map((v) => String(v ?? "")),
            Outgoings: (outG.values_grid?.[0] || []).map((v) => String(v ?? "")),
            NBtoFind: (nbG.values_grid?.[0] || []).map((v) => String(v ?? "")),
            Budget: (budG.values_grid?.[0] || []).map((v) => String(v ?? "")),
          },
          _salariesRollups: {
            rowCount: (salG.values_grid || []).length,
            rows: Object.fromEntries((salG.values_grid || []).map((r, i) => [String(i), Object.fromEntries(r.map((v, c) => [String(c), v]).filter(([, v]) => v !== "" && v !== null && v !== undefined))])),
            dateCells: salG.notes_grid?.__dateCells || {},
            notes: salG.notes_grid || {},
          },
          _outgoingsRollups: {
            rowCount: (outG.values_grid || []).length,
            rows: Object.fromEntries((outG.values_grid || []).map((r, i) => [String(i), Object.fromEntries(r.map((v, c) => [String(c), v]).filter(([, v]) => v !== "" && v !== null && v !== undefined))])),
            dateCells: outG.notes_grid?.__dateCells || {},
            notes: outG.notes_grid || {},
          },
          _budgetRollups: {
            rowCount: (budG.values_grid || []).length,
            rows: Object.fromEntries((budG.values_grid || []).map((r, i) => [String(i), Object.fromEntries(r.map((v, c) => [String(c), v]).filter(([, v]) => v !== "" && v !== null && v !== undefined))])),
            dateCells: budG.notes_grid?.__dateCells || {},
            notes: budG.notes_grid || {},
          },
        },
      };
    }
    if (needFin && !finBundle) {
      finBundle = await preloadClientRelationalFinancialsBundle(ctx, {
        source: "in_memory",
        includeFormulas: false,
      });
    }
  } else {
    const [jB, iB, fB] = await Promise.all([
      needJobs && !jobsBundle ? preloadClientRelationalJobsBundle(ctx) : Promise.resolve(jobsBundle),
      needAnyInputs && !inputsBundle
        ? preloadClientRelationalInputsBundle(ctx, {
            includeSalaries: needSalaries,
            includeOutgoings: needOutgoings,
            includeOutgNotes: needOutgNotes,
            includeNbToFind: needNb,
            includeBudget: needBudget,
            includeCash: needCashAdj,
          })
        : Promise.resolve(inputsBundle),
      needFin && !finBundle
        ? preloadClientRelationalFinancialsBundle(ctx, { source: "db", includeFormulas: false })
        : Promise.resolve(finBundle),
    ]);
    jobsBundle = jB;
    inputsBundle = iB;
    finBundle = fB;
  }

  const outByTab = {};
  for (const tabName of reqTabs) {
    const bpExpanded = expandBlueprintRow_(bpByTab.get(tabName), tabName, { valuesOnly });
    const baseVals = bpExpanded?.values_grid || [];
    const baseForms = !valuesOnly ? (bpExpanded?.formulas_grid || baseVals) : [];
    const baseNotes = bpExpanded?.notes_grid || {};

    if ((tabName === "Confirmed" || tabName === "Pipeline") && jobsBundle) {
      const jobs = tabName === "Pipeline" ? jobsBundle.jobsByTab?.Pipeline || [] : jobsBundle.jobsByTab?.Confirmed || [];
      const baseJobsModel = parseTabGridToRelationalModel({
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        tabName,
        valuesGrid: baseVals,
        formulasGrid: baseForms,
        notesGrid: baseNotes,
      });
      const occupiedRowRangesToClear = (baseJobsModel.jobs || []).map((j) => ({
        startRowNum: j.sheet_row_num,
        sheet_child_row_count: j.sheet_child_row_count || 0,
      }));
      const projected = projectRelationalModelToTabGrid({
        tabName,
        jobs,
        invoicesByJobId: jobsBundle.invoicesByJobId,
        expensesByJobId: jobsBundle.expensesByJobId,
        baseValuesGrid: baseVals,
        baseFormulasGrid: baseForms,
        baseNotesGrid: baseNotes,
        occupiedRowRangesToClear,
      });
      const finalVals = projected.valuesGrid;
      const finalForms = !valuesOnly ? projected.formulasGrid : [];
      const finalNotes = projected.notesGrid;
      if (baseNotes.__dateCells) {
        finalNotes.__dateCells = { ...(baseNotes.__dateCells || {}), ...(finalNotes.__dateCells || {}) };
      }
      outByTab[tabName] = {
        sheet_role: "client",
        tab_name: tabName,
        row_count: finalVals.length,
        col_count: Math.max(
          Number(bpExpanded?.col_count) || 0,
          finalVals.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
        ),
        values_grid: finalVals,
        formulas_grid: finalForms,
        notes_grid: includeNotes ? finalNotes : {},
        updated_at: bpExpanded?.updated_at || null,
      };
      continue;
    }

    if (tabName === "Salaries" && inputsBundle) {
      const projected = projectEmployeesToSalariesGrid({
        employees: inputsBundle.employees || [],
        baseValuesGrid: baseVals,
        baseFormulasGrid: baseForms,
        baseNotesGrid: baseNotes,
      });
      const recon = valuesOnly ? reconstructRelationalTabFromBundle(inputsBundle, "Salaries") : null;
      const finalVals = valuesOnly && recon?.valuesGrid?.length > 0
        ? overlaySparseReconForValuesOnly_(projected.valuesGrid, projected.formulasGrid, recon.valuesGrid)
        : projected.valuesGrid;
      const finalNotes = {
        ...baseNotes,
        ...(recon?.notesGrid || {}),
        ...(projected.notesGrid || {}),
      };
      if (baseNotes.__dateCells || recon?.notesGrid?.__dateCells || projected.notesGrid?.__dateCells) {
        finalNotes.__dateCells = {
          ...(baseNotes.__dateCells || {}),
          ...(recon?.notesGrid?.__dateCells || {}),
          ...(projected.notesGrid?.__dateCells || {}),
        };
      }
      outByTab[tabName] = {
        sheet_role: "client",
        tab_name: tabName,
        row_count: finalVals.length,
        col_count: Math.max(Number(bpExpanded?.col_count) || 0, finalVals.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)),
        values_grid: finalVals,
        formulas_grid: !valuesOnly ? projected.formulasGrid : [],
        notes_grid: includeNotes ? finalNotes : {},
        updated_at: bpExpanded?.updated_at || null,
      };
      continue;
    }

    if (tabName === "Outgoings" && inputsBundle) {
      const projected = projectOutgoingItemsToGrid({
        items: inputsBundle.outgoingItems || [],
        baseValuesGrid: baseVals,
        baseFormulasGrid: baseForms,
        baseNotesGrid: baseNotes,
      });
      const recon = valuesOnly ? reconstructRelationalTabFromBundle(inputsBundle, "Outgoings") : null;
      const finalVals = valuesOnly && recon?.valuesGrid?.length > 0
        ? overlaySparseReconForValuesOnly_(projected.valuesGrid, projected.formulasGrid, recon.valuesGrid)
        : projected.valuesGrid;
      const finalNotes = {
        ...baseNotes,
        ...(recon?.notesGrid || {}),
        ...(projected.notesGrid || {}),
      };
      if (baseNotes.__dateCells || recon?.notesGrid?.__dateCells || projected.notesGrid?.__dateCells) {
        finalNotes.__dateCells = {
          ...(baseNotes.__dateCells || {}),
          ...(recon?.notesGrid?.__dateCells || {}),
          ...(projected.notesGrid?.__dateCells || {}),
        };
      }
      outByTab[tabName] = {
        sheet_role: "client",
        tab_name: tabName,
        row_count: finalVals.length,
        col_count: Math.max(Number(bpExpanded?.col_count) || 0, finalVals.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)),
        values_grid: finalVals,
        formulas_grid: !valuesOnly ? projected.formulasGrid : [],
        notes_grid: includeNotes ? finalNotes : {},
        updated_at: bpExpanded?.updated_at || null,
      };
      continue;
    }

    if (tabName === "OutgNotes" && inputsBundle) {
      const projected = projectContractorEntriesToOutgNotesGrid({
        entries: inputsBundle.contractorEntries || [],
        baseValuesGrid: baseVals,
        baseFormulasGrid: baseForms,
        baseNotesGrid: baseNotes,
      });
      outByTab[tabName] = {
        sheet_role: "client",
        tab_name: tabName,
        row_count: projected.valuesGrid.length,
        col_count: Math.max(Number(bpExpanded?.col_count) || 0, projected.valuesGrid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)),
        values_grid: projected.valuesGrid,
        formulas_grid: !valuesOnly ? projected.formulasGrid : [],
        notes_grid: includeNotes ? { ...baseNotes, ...(projected.notesGrid || {}) } : {},
        updated_at: bpExpanded?.updated_at || null,
      };
      continue;
    }

    if (tabName === "NBtoFind" && inputsBundle) {
      const projected = projectNbToFindRecordToGrid({
        record: inputsBundle.nbRecord || null,
        baseValuesGrid: baseVals,
        baseFormulasGrid: baseForms,
        baseNotesGrid: baseNotes,
      });
      const recon = valuesOnly ? reconstructRelationalTabFromBundle(inputsBundle, "NBtoFind") : null;
      const finalVals = valuesOnly && recon?.valuesGrid?.length > 0
        ? overlaySparseReconForValuesOnly_(projected.valuesGrid, projected.formulasGrid, recon.valuesGrid)
        : projected.valuesGrid;
      const finalNotes = {
        ...baseNotes,
        ...(recon?.notesGrid || {}),
        ...(projected.notesGrid || {}),
      };
      if (baseNotes.__dateCells || recon?.notesGrid?.__dateCells || projected.notesGrid?.__dateCells) {
        finalNotes.__dateCells = {
          ...(baseNotes.__dateCells || {}),
          ...(recon?.notesGrid?.__dateCells || {}),
          ...(projected.notesGrid?.__dateCells || {}),
        };
      }
      outByTab[tabName] = {
        sheet_role: "client",
        tab_name: tabName,
        row_count: finalVals.length,
        col_count: Math.max(Number(bpExpanded?.col_count) || 0, finalVals.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)),
        values_grid: finalVals,
        formulas_grid: !valuesOnly ? projected.formulasGrid : [],
        notes_grid: includeNotes ? finalNotes : {},
        updated_at: bpExpanded?.updated_at || null,
      };
      continue;
    }

    if (tabName === "Budget" && inputsBundle) {
      const budItems = inputsBundle.budgetItems || [];
      const occupied = new Set(budItems.map((it) => Number(it.sheet_row_num)).filter(Number.isInteger));
      const baseBudItems = parseBudgetTabToItems({
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        valuesGrid: baseVals,
        formulasGrid: baseForms,
        notesGrid: baseNotes,
      });
      const rowsToClear = new Set(
        baseBudItems
          .map((it) => Number(it.sheet_row_num))
          .filter((rn) => Number.isInteger(rn) && !occupied.has(rn))
      );
      const cleanBaseVals = clone2D_(baseVals);
      const cleanBaseForms = clone2D_(baseForms);
      const cleanBaseNotes = { ...baseNotes };
      if (rowsToClear.size > 0) {
        clearUnoccupiedBudgetInputs_(cleanBaseVals, cleanBaseForms, cleanBaseNotes, rowsToClear);
      }
      const projected = projectBudgetItemsToGrid({
        items: budItems,
        baseValuesGrid: cleanBaseVals,
        baseFormulasGrid: cleanBaseForms,
        baseNotesGrid: cleanBaseNotes,
      });
      const recon = valuesOnly ? reconstructRelationalTabFromBundle(inputsBundle, "Budget") : null;
      const finalVals = valuesOnly && recon?.valuesGrid?.length > 0
        ? overlaySparseReconForValuesOnly_(projected.valuesGrid, projected.formulasGrid, recon.valuesGrid)
        : projected.valuesGrid;
      const finalNotes = {
        ...cleanBaseNotes,
        ...(recon?.notesGrid || {}),
        ...(projected.notesGrid || {}),
      };
      if (cleanBaseNotes.__dateCells || recon?.notesGrid?.__dateCells || projected.notesGrid?.__dateCells) {
        finalNotes.__dateCells = {
          ...(cleanBaseNotes.__dateCells || {}),
          ...(recon?.notesGrid?.__dateCells || {}),
          ...(projected.notesGrid?.__dateCells || {}),
        };
      }
      outByTab[tabName] = {
        sheet_role: "client",
        tab_name: tabName,
        row_count: finalVals.length,
        col_count: Math.max(Number(bpExpanded?.col_count) || 0, finalVals.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)),
        values_grid: finalVals,
        formulas_grid: !valuesOnly ? projected.formulasGrid : [],
        notes_grid: includeNotes ? finalNotes : {},
        updated_at: bpExpanded?.updated_at || null,
      };
      continue;
    }

    if (PHASE5_SET.has(tabName) && finBundle) {
      const finRec = reconstructRelationalFinancialTabFromBundle(finBundle, tabName, {
        includeFormulas: false,
      });
      if (finRec) {
        let finalVals = finRec.values_grid || [];
        let finalForms = !valuesOnly ? (baseForms.length > 0 ? baseForms : finRec.values_grid || []) : [];
        let finalNotes = {
          ...baseNotes,
          ...(finRec.notes_grid || {}),
        };
        if (tabName === "Cash" && !valuesOnly && inputsBundle) {
          const projected = projectCashAdjustmentsToGrid({
            adjustments: inputsBundle.cashAdjustments || [],
            baseValuesGrid: finalVals,
            baseFormulasGrid: finalForms,
            baseNotesGrid: finalNotes,
          });
          finalVals = projected.valuesGrid;
          finalForms = projected.formulasGrid;
          finalNotes = projected.notesGrid;
        }
        outByTab[tabName] = {
          sheet_role: "client",
          tab_name: tabName,
          row_count: Math.max(finRec.row_count || 0, finalVals.length),
          col_count: Math.max(finRec.col_count || 0, Number(bpExpanded?.col_count) || 0),
          values_grid: finalVals,
          formulas_grid: finalForms,
          notes_grid: includeNotes ? finalNotes : {},
          updated_at: finRec.updated_at || bpExpanded?.updated_at || null,
        };
        continue;
      }
    }

    if (bpExpanded) {
      outByTab[tabName] = {
        sheet_role: "client",
        tab_name: tabName,
        row_count: bpExpanded.row_count || baseVals.length,
        col_count: bpExpanded.col_count || 0,
        values_grid: baseVals,
        formulas_grid: !valuesOnly ? baseForms : [],
        notes_grid: includeNotes ? baseNotes : {},
        updated_at: bpExpanded.updated_at || null,
      };
    }
  }

  return outByTab;
}

export async function loadNativeClientTabRecord(ctxOrClientName, tabName, options = {}) {
  const map = await loadNativeClientTabRecordsBatch(ctxOrClientName, [tabName], options);
  return (
    map[tabName] || {
      sheet_role: "client",
      tab_name: tabName,
      row_count: 0,
      col_count: 0,
      values_grid: [],
      formulas_grid: [],
      notes_grid: {},
    }
  );
}

// ============================================================================
// 4. MODE TOGGLE & SHADOW VERIFIER
// ============================================================================

export async function setClientComputeMode(clientName, mode) {
  const cleanMode = str_(mode).toLowerCase();
  if (cleanMode !== "grid_gas" && cleanMode !== "shadow" && cleanMode !== "native") {
    throw new Error("Invalid clientComputeMode. Expected 'grid_gas', 'shadow', or 'native'.");
  }
  const schema = await checkPhase6NativeComputeSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0017 must be applied in Supabase SQL Editor first.");
  }

  const supabase = getSupabaseAdmin();
  const { data: cl, error: fErr } = await supabase
    .from("clients")
    .select("id, client_name, jobs_mode, inputs_mode, financials_mode, metadata")
    .eq("client_name", clientName)
    .maybeSingle();
  if (fErr || !cl) throw new Error(fErr?.message || `Client "${clientName}" not found.`);

  if (cleanMode === "native") {
    if (cl.jobs_mode !== "relational" || cl.inputs_mode !== "relational" || cl.financials_mode !== "relational") {
      throw new Error(
        `Client "${clientName}" must have jobs_mode, inputs_mode, and financials_mode set to 'relational' before enabling native compute.`
      );
    }
  }

  if (cleanMode === "shadow" || cleanMode === "native") {
    await backfillClientNativeCalc(clientName);
  }

  const nextMeta = { ...(cl.metadata || {}), client_compute_mode: cleanMode };
  const { data: upd, error: uErr } = await supabase
    .from("clients")
    .update({ client_compute_mode: cleanMode, metadata: nextMeta })
    .eq("id", cl.id)
    .select("id, client_name, client_compute_mode, master_compute_mode")
    .single();
  if (uErr) throw new Error(`Failed updating client_compute_mode: ${uErr.message}`);

  invalidateMasterEngineCache(clientName, "client", null, { invalidateSheetContext: true });
  invalidateClientNativeCalcCache(clientName);
  return upd;
}

export async function runShadowClientCalcCheck(ctx, changedTabs = [], referenceGrids = {}) {
  if (!ctx?.clientId) return null;
  const schema = await checkPhase6NativeComputeSchemaStatus();
  if (!schema.schemaReady) return null;

  const supabase = getSupabaseAdmin();
  const relRecords = await loadNativeClientTabRecordsBatch(ctx, CORE_CLIENT_TABS, {
    source: "db",
    valuesOnly: false,
    includeNotes: true,
  });
  const shadowGrids = cloneFormulaEntryMap_(relRecords);
  const preservedFormulaValues = wipeFormulaValuesForRecompute_(shadowGrids);
  const reconGrids = shadowGrids.Cash?.formulas
    ? await extractReferencedReconGrids_(ctx, [shadowGrids.Cash.formulas], { source: "db" })
    : null;

  recalculateClientGrids(shadowGrids, {
    changedTabs: Array.isArray(changedTabs) && changedTabs.length > 0 ? changedTabs : CORE_CLIENT_TABS,
    reconGrids,
    preservedFormulaValues,
  });

  const compareTabs = [
    "ConfCalcs",
    "PipeCalcs",
    "Calcs",
    "Salaries",
    "Outgoings",
    "OutgNotes",
    "Monthly",
    "Budget",
    "NBtoFind",
    "ErrorCheck",
    "Performance",
    "VAT",
    "Cash",
    "Dashboard",
    "GPbyPL",
    "Year0Data",
  ];
  let totalDiffs = 0;
  const sampleDiffs = [];
  for (const t of compareTabs) {
    const refVals = referenceGrids[t]?.values || [];
    const shadVals = shadowGrids[t]?.values || [];
    if (refVals.length === 0 && shadVals.length === 0) continue;
    const { mismatchCount, diffs } = diff2DGrids_(t, refVals, shadVals, 4, 1e-5);
    totalDiffs += mismatchCount;
    if (sampleDiffs.length < 8) sampleDiffs.push(...diffs);
  }

  for (const t of changedTabs || []) {
    if (referenceGrids[t]?.values) {
      await saveNativeClientTabBlueprint(
        ctx,
        t,
        referenceGrids[t].values,
        referenceGrids[t].formulas,
        referenceGrids[t].notes || {}
      ).catch(() => {});
    }
  }

  const { data: clRow } = await supabase
    .from("clients")
    .select("metadata")
    .eq("id", ctx.clientId)
    .maybeSingle();
  const prevMeta = clRow?.metadata && typeof clRow.metadata === "object" ? clRow.metadata : {};
  await supabase
    .from("clients")
    .update({
      metadata: {
        ...prevMeta,
        native_client_calc_state: {
          ...(prevMeta.native_client_calc_state || {}),
          lastShadowAt: new Date().toISOString(),
          lastShadowMatched: totalDiffs === 0,
          lastShadowDiffCount: totalDiffs,
          sampleShadowDiffs: sampleDiffs.slice(0, 8),
        },
      },
    })
    .eq("id", ctx.clientId);

  if (totalDiffs > 0) {
    console.warn(
      `[nativeClientCalcService] Shadow diff detected on ${ctx.clientName}: ${totalDiffs} cell(s):`,
      JSON.stringify(sampleDiffs.slice(0, 4))
    );
  }
  return { matched: totalDiffs === 0, totalDiffs, sampleDiffs };
}

// ============================================================================
// 5. GATE 1A, GATE 2A & GATE 4 VERIFIERS
// ============================================================================

function normCell_(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  return String(v);
}

function cellsEqual_(va, vb, tol = 1e-5) {
  if (va === vb) return true;
  if (typeof va === "number" && typeof vb === "number") {
    return Math.abs(va - vb) <= tol;
  }
  return false;
}

function diff2DGrids_(tabName, gridA, gridB, maxSamples = 8, tol = 1e-5) {
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
      if (!cellsEqual_(va, vb, tol)) {
        mismatchCount++;
        if (diffs.length < maxSamples) {
          diffs.push({
            tab: tabName,
            tabName,
            row: r + 1,
            col: c + 1,
            cellKey: `R${r + 1}C${c + 1}`,
            grid: va,
            native: vb,
            expected: va,
            actual: vb,
          });
        }
      }
    }
  }
  return { mismatchCount, diffs };
}

const COMPARE_CLIENT_CALC_TABS = [
  "ConfCalcs",
  "PipeCalcs",
  "Calcs",
  "Salaries",
  "Outgoings",
  "OutgNotes",
  "Monthly",
  "Budget",
  "NBtoFind",
  "ErrorCheck",
  "Performance",
  "VAT",
  "Cash",
  "Dashboard",
  "GPbyPL",
  "Year0Data",
];

const RECOMPUTE_CHANGED_ROOTS = [
  "Confirmed",
  "Pipeline",
  "Salaries",
  "Outgoings",
  "OutgNotes",
  "Budget",
  "NBtoFind",
  "Cash",
  "KeyInfo",
];

export async function verifyNativeClientCalcParity({
  clientName = null,
  source = "auto",
  onlyActiveOrShadow = false,
  compareFrozenGrids = false,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase6NativeComputeSchemaStatus();
  const cols = schema.schemaReady
    ? "id, client_name, client_compute_mode, recon_read_mode, financials_read_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata"
    : "id, client_name, recon_read_mode, financials_read_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  const { data: clients, error } = await query;
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const targetClients = (clients || []).filter((cl) => {
    const mode = cl.client_compute_mode || "grid_gas";
    return !(onlyActiveOrShadow && mode !== "native" && mode !== "shadow");
  });

  const evalOneClient = async (cl) => {
    const mode = cl.client_compute_mode || "grid_gas";
    try {
      const ctx = {
        clientId: cl.id,
        clientName: cl.client_name,
        clientComputeMode: mode,
        clientSheetId: cl.client_sheet_id,
        masterSheetId: cl.master_sheet_id,
        reconSheetId: cl.recon_sheet_id,
      };
      const canUseDb =
        schema.schemaReady &&
        (source === "db" ||
          (source === "auto" && Boolean(cl.metadata?.native_client_calc_state?.lastBackfilledAt)));
      const effectiveSource = canUseDb ? "db" : "in_memory";
      let usePersistedNativeRef = false;
      if (mode === "native" && effectiveSource === "db" && !compareFrozenGrids) {
        const backfillMs = cl.metadata?.native_client_calc_state?.lastBackfilledAt
          ? Date.parse(cl.metadata.native_client_calc_state.lastBackfilledAt)
          : 0;
        const { data: latestBp } = await supabase
          .from("pulse_client_tab_blueprints")
          .select("updated_at")
          .eq("client_id", ctx.clientId)
          .order("updated_at", { ascending: false })
          .limit(1);
        const maxBpMs = latestBp?.[0]?.updated_at ? Date.parse(latestBp[0].updated_at) : 0;
        if (backfillMs > 0 && maxBpMs > backfillMs + 5000) {
          usePersistedNativeRef = true;
        }
      }
      const reconSource = cl.recon_read_mode === "relational" ? "db" : "in_memory";
      const tabsToCompare = usePersistedNativeRef
        ? ["Dashboard", "Year0Data", "VAT", "Cash", "ErrorCheck"]
        : COMPARE_CLIENT_CALC_TABS;

      let legacyGrids = null;
      let nativeGrids = null;

      if (usePersistedNativeRef) {
        const [persistedReadRecords, nativeRecords] = await Promise.all([
          loadNativeClientTabRecordsBatch(ctx, tabsToCompare, {
            source: "db",
            valuesOnly: true,
            includeNotes: true,
          }),
          loadNativeClientTabRecordsBatch(ctx, CORE_CLIENT_TABS, {
            source: "db",
            valuesOnly: false,
            includeNotes: true,
          }),
        ]);
        legacyGrids = cloneFormulaEntryMap_(persistedReadRecords);
        nativeGrids = cloneFormulaEntryMap_(nativeRecords);

        const nativePreserved = wipeFormulaValuesForRecompute_(nativeGrids);
        const reconGrids = await extractReferencedReconGrids_(
          ctx,
          [nativeGrids.Cash?.formulas || []],
          { source: reconSource }
        );
        recalculateClientGrids(nativeGrids, {
          changedTabs: RECOMPUTE_CHANGED_ROOTS,
          reconGrids,
          preservedFormulaValues: nativePreserved,
        });
      } else {
        const rawClientTabs = await loadRawClientTabsFromGrids_(supabase, cl.client_name, {
          valuesOnly: false,
        });
        legacyGrids = cloneFormulaEntryMap_(rawClientTabs);
        const nativeRecords = await loadNativeClientTabRecordsBatch(ctx, CORE_CLIENT_TABS, {
          source: effectiveSource,
          valuesOnly: false,
          includeNotes: true,
          rawGridsOverride: effectiveSource === "in_memory" ? rawClientTabs : null,
        });
        nativeGrids = cloneFormulaEntryMap_(nativeRecords);

        const legacyPreserved = wipeFormulaValuesForRecompute_(legacyGrids);
        const nativePreserved = wipeFormulaValuesForRecompute_(nativeGrids);
        const cashFormulaGrids = [
          legacyGrids.Cash?.formulas || nativeGrids.Cash?.formulas || [],
        ];
        const reconGrids = await extractReferencedReconGrids_(ctx, cashFormulaGrids, {
          source: reconSource,
        });

        recalculateClientGrids(legacyGrids, {
          changedTabs: RECOMPUTE_CHANGED_ROOTS,
          reconGrids,
          preservedFormulaValues: legacyPreserved,
        });
        recalculateClientGrids(nativeGrids, {
          changedTabs: RECOMPUTE_CHANGED_ROOTS,
          reconGrids,
          preservedFormulaValues: nativePreserved,
        });
      }

      let totalMismatchCount = 0;
      const sampleMismatches = [];
      let tabsChecked = 0;
      for (const tabName of tabsToCompare) {
        const expEntry = legacyGrids[tabName];
        const actEntry = nativeGrids[tabName];
        if (!expEntry && !actEntry) continue;
        tabsChecked++;
        const { mismatchCount, diffs } = diff2DGrids_(
          tabName,
          expEntry?.values || [],
          actEntry?.values || [],
          4,
          1e-5
        );
        totalMismatchCount += mismatchCount;
        if (sampleMismatches.length < 10) sampleMismatches.push(...diffs);
      }

      return {
        clientName: cl.client_name,
        source: effectiveSource,
        clientComputeMode: mode,
        tabsChecked,
        totalMismatchCount,
        matched: totalMismatchCount === 0,
        sampleMismatches: sampleMismatches.slice(0, 10),
        error: null,
      };
    } catch (err) {
      return {
        clientName: cl.client_name,
        source: "error",
        clientComputeMode: mode,
        tabsChecked: 0,
        totalMismatchCount: 0,
        matched: false,
        sampleMismatches: [],
        error: err.message,
      };
    }
  };

  const results = [];
  for (let i = 0; i < targetClients.length; i += 4) {
    const chunk = targetClients.slice(i, i + 4);
    const chunkRes = await Promise.all(chunk.map(evalOneClient));
    results.push(...chunkRes);
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

export async function verifyNativeClientMutationMatrix({
  clientNames = ["APPTEST", "Ayefour Design", "Base Three"],
  source = "auto",
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase6NativeComputeSchemaStatus();
  const cols = schema.schemaReady
    ? "id, client_name, client_compute_mode, recon_read_mode, financials_read_mode, recon_sheet_id, metadata"
    : "id, client_name, recon_read_mode, financials_read_mode, recon_sheet_id, metadata";
  const { data: clients, error } = await supabase
    .from("clients")
    .select(cols)
    .in("client_name", clientNames)
    .order("client_name");
  if (error) throw new Error(`Failed loading matrix clients: ${error.message}`);

  const matrixTabs = ["Calcs", "Outgoings", "Performance", "Dashboard", "VAT", "Cash", "Year0Data"];
  const results = [];

  for (const cl of clients || []) {
    const ctx = {
      clientId: cl.id,
      clientName: cl.client_name,
      reconSheetId: cl.recon_sheet_id,
    };
    const canUseDb =
      schema.schemaReady &&
      (source === "db" ||
        (source === "auto" && Boolean(cl.metadata?.native_client_calc_state?.lastBackfilledAt)));
    const effectiveSource = canUseDb ? "db" : "in_memory";

    const rawTabs = await loadRawClientTabsFromGrids_(supabase, cl.client_name, { valuesOnly: false });
    const nativeBaseRecords = await loadNativeClientTabRecordsBatch(ctx, CORE_CLIENT_TABS, {
      source: effectiveSource,
      valuesOnly: false,
      includeNotes: true,
      rawGridsOverride: effectiveSource === "in_memory" ? rawTabs : null,
    });
    const reconGrids = await extractReferencedReconGrids_(
      ctx,
      [nativeBaseRecords.Cash?.formulas_grid || rawTabs.Cash?.formulas_grid || []],
      { source: cl.recon_read_mode === "relational" ? "db" : "in_memory" }
    );

    const scenarios = [
      {
        name: "confirmed_job_rev_plus_1000",
        roots: ["Confirmed"],
        mutate: (gMap) => {
          const conf = gMap.Confirmed;
          if (!conf) return;
          const isJc = String(conf.values?.[0]?.[5] || "").trim().toLowerCase() === "date job will start";
          let r = 1;
          for (let i = 1; i < Math.min(conf.values.length, 300); i++) {
            if (conf.values[i]?.[0] || conf.values[i]?.[1]) {
              r = i;
              break;
            }
          }
          const revCol = isJc ? 8 : 32;
          const curRev = toNumOrNull_(conf.values?.[r]?.[revCol]) ?? 0;
          const nextRev = curRev + 1000;
          while (conf.values.length <= r) conf.values.push([]);
          while (conf.formulas.length <= r) conf.formulas.push([]);
          conf.values[r][revCol] = nextRev;
          conf.formulas[r][revCol] = nextRev;
          const curInv = toNumOrNull_(conf.values?.[r]?.[41]) ?? 0;
          const nextInv = curInv + 1000;
          conf.values[r][41] = nextInv;
          conf.formulas[r][41] = nextInv;
        },
      },
      {
        name: "salaries_row4_fte_plus_1200",
        roots: ["Salaries"],
        mutate: (gMap) => {
          const sal = gMap.Salaries;
          if (!sal || !Array.isArray(sal.values?.[3])) return;
          const curFte = toNumOrNull_(sal.values[3][2]) ?? 30000;
          const nextFte = curFte + 1200;
          sal.values[3][2] = nextFte;
          sal.formulas[3][2] = nextFte;
        },
      },
      {
        name: "outgoings_overhead_m1_plus_500",
        roots: ["Outgoings"],
        mutate: (gMap) => {
          const out = gMap.Outgoings;
          if (!out) return;
          let rTarget = 114;
          for (let r = 114; r <= Math.min(225, out.values.length - 1); r++) {
            if (out.values[r]?.[0]) {
              rTarget = r;
              break;
            }
          }
          const cur = toNumOrNull_(out.values?.[rTarget]?.[6]) ?? 0;
          const next = cur + 500;
          while (out.values.length <= rTarget) out.values.push([]);
          while (out.formulas.length <= rTarget) out.formulas.push([]);
          out.values[rTarget][6] = next;
          out.formulas[rTarget][6] = next;
        },
      },
      {
        name: "cash_k30_adjustment_plus_250",
        roots: ["Cash"],
        mutate: (gMap) => {
          const cash = gMap.Cash;
          if (!cash) return;
          const r = 29; // Row 30
          const c = 10; // Col K
          const cur = toNumOrNull_(cash.values?.[r]?.[c]) ?? 0;
          const next = cur + 250;
          while (cash.values.length <= r) cash.values.push([]);
          while (cash.formulas.length <= r) cash.formulas.push([]);
          cash.values[r][c] = next;
          cash.formulas[r][c] = next;
        },
      },
    ];

    for (const sc of scenarios) {
      const gA = cloneFormulaEntryMap_(rawTabs);
      const gB = cloneFormulaEntryMap_(nativeBaseRecords);
      sc.mutate(gA);
      sc.mutate(gB);
      const pA = wipeFormulaValuesForRecompute_(gA);
      const pB = wipeFormulaValuesForRecompute_(gB);

      recalculateClientGrids(gA, {
        changedTabs: sc.roots,
        reconGrids,
        preservedFormulaValues: pA,
      });
      recalculateClientGrids(gB, {
        changedTabs: sc.roots,
        reconGrids,
        preservedFormulaValues: pB,
      });

      let mism = 0;
      const samples = [];
      for (const t of matrixTabs) {
        if (!gA[t] && !gB[t]) continue;
        const { mismatchCount, diffs } = diff2DGrids_(t, gA[t]?.values || [], gB[t]?.values || [], 4, 1e-5);
        mism += mismatchCount;
        if (samples.length < 8) samples.push(...diffs);
      }

      results.push({
        clientName: cl.client_name,
        scenario: sc.name,
        source: effectiveSource,
        matched: mism === 0,
        mismatchCount: mism,
        sampleMismatches: samples,
      });
    }
  }

  return {
    success: true,
    checkedAt: new Date().toISOString(),
    scenariosChecked: results.length,
    matchedCount: results.filter((r) => r.matched).length,
    mismatchCount: results.filter((r) => !r.matched).length,
    results,
  };
}

// Gate 4: Independent SQL Accounting Invariants Oracle (runs without any Google Sheet dependency)
export async function verifyRelationalAccountingInvariants({
  clientName = null,
  onlyActive = false,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const { data: clients, error } = await supabase
    .from("clients")
    .select("id, client_name, status, client_sheet_id, metadata")
    .order("client_name");
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const monthAndFyTotalCols = [];
  for (let c = 6; c <= 17; c++) monthAndFyTotalCols.push(c);
  for (let c = 21; c <= 32; c++) monthAndFyTotalCols.push(c);
  for (let c = 36; c <= 47; c++) monthAndFyTotalCols.push(c);
  const fyBands = [
    { startC: 6, endC: 17, totC: 19 },
    { startC: 21, endC: 32, totC: 34 },
    { startC: 36, endC: 47, totC: 49 },
  ];

  const errorScanBounds = [
    { tab: "Dashboard", maxR: 34, maxC: 50 },
    { tab: "Performance", maxR: 83, maxC: 50 },
    { tab: "Year0Data", maxR: 34, maxC: 20 },
    { tab: "Cash", maxR: 76, maxC: 37 },
    { tab: "VAT", maxR: 35, maxC: 50 },
    { tab: "Calcs", maxR: 37, maxC: 52 },
  ];

  const results = [];
  for (const cl of clients || []) {
    if (clientName && cl.client_name !== clientName) continue;
    const effStatus = str_(cl.metadata?.statusOverride || cl.status || "live").toLowerCase();
    if (onlyActive && (effStatus === "inactive" || effStatus === "archived" || effStatus === "suspended")) {
      continue;
    }

    try {
      const ctx = { clientId: cl.id, clientName: cl.client_name };
      const bundle = await preloadClientRelationalFinancialsBundle(ctx, {
        source: "auto",
        includeFormulas: false,
      });
      const ki = reconstructRelationalFinancialTabFromBundle(bundle, "KeyInfo")?.values_grid || [];
      const dash = reconstructRelationalFinancialTabFromBundle(bundle, "Dashboard")?.values_grid || [];
      const perf = reconstructRelationalFinancialTabFromBundle(bundle, "Performance")?.values_grid || [];
      const y0 = reconstructRelationalFinancialTabFromBundle(bundle, "Year0Data")?.values_grid || [];
      const cash = reconstructRelationalFinancialTabFromBundle(bundle, "Cash")?.values_grid || [];
      const vat = reconstructRelationalFinancialTabFromBundle(bundle, "VAT")?.values_grid || [];
      const calcs = reconstructRelationalFinancialTabFromBundle(bundle, "Calcs")?.values_grid || [];

      const byTab = { Dashboard: dash, Performance: perf, Year0Data: y0, Cash: cash, VAT: vat, Calcs: calcs };
      const violations = [];
      const addViolation = (v) => {
        violations.push(v);
      };

      // 1. Scan core financial outputs for formula errors
      for (const b of errorScanBounds) {
        const g = byTab[b.tab] || [];
        for (let r = 0; r < Math.min(b.maxR, g.length); r++) {
          const row = g[r] || [];
          for (let c = 0; c < Math.min(b.maxC, row.length); c++) {
            const val = row[c];
            if (typeof val === "string" && ERROR_CELL_RE.test(val.trim())) {
              addViolation({
                kind: "formula_error_cell",
                tabName: b.tab,
                cellKey: `R${r + 1}C${c + 1}`,
                expected: "valid value",
                actual: val.trim().slice(0, 60),
              });
            }
          }
        }
      }

      // 2. Dashboard P&L accounting identities (tolerance 0.05 for floating-point accumulation)
      const b16No = str_(ki?.[15]?.[1]).toLowerCase() === "no";
      const valNum = (grid, r1, c0) => toNumOrNull_(grid?.[r1 - 1]?.[c0]) ?? 0;

      for (const c of [...monthAndFyTotalCols, 19, 34, 49]) {
        const revSum = valNum(dash, 4, c) + valNum(dash, 5, c) + valNum(dash, 6, c) + valNum(dash, 7, c) + valNum(dash, 8, c);
        const totalRev = valNum(dash, 9, c);
        if (Math.abs(revSum - totalRev) > 0.05) {
          addViolation({
            kind: "dashboard_revenue_sum",
            tabName: "Dashboard",
            cellKey: `R9C${c + 1}`,
            expected: Math.round(revSum * 100) / 100,
            actual: Math.round(totalRev * 100) / 100,
          });
        }

        const totalCos = valNum(dash, 16, c);
        const gp = valNum(dash, 18, c);
        if (!b16No) {
          const cosSum = valNum(dash, 12, c) + valNum(dash, 13, c) + valNum(dash, 14, c) + valNum(dash, 15, c);
          if (Math.abs(cosSum - totalCos) > 0.05) {
            addViolation({
              kind: "dashboard_cos_sum",
              tabName: "Dashboard",
              cellKey: `R16C${c + 1}`,
              expected: Math.round(cosSum * 100) / 100,
              actual: Math.round(totalCos * 100) / 100,
            });
          }
          if (Math.abs((totalRev - totalCos) - gp) > 0.05) {
            addViolation({
              kind: "dashboard_gross_profit",
              tabName: "Dashboard",
              cellKey: `R18C${c + 1}`,
              expected: Math.round((totalRev - totalCos) * 100) / 100,
              actual: Math.round(gp * 100) / 100,
            });
          }
        }

        const ohSum = valNum(dash, 23, c) + valNum(dash, 24, c) + valNum(dash, 25, c);
        const totalOh = valNum(dash, 26, c);
        if (Math.abs(ohSum - totalOh) > 0.05) {
          addViolation({
            kind: "dashboard_overheads_sum",
            tabName: "Dashboard",
            cellKey: `R26C${c + 1}`,
            expected: Math.round(ohSum * 100) / 100,
            actual: Math.round(totalOh * 100) / 100,
          });
        }
        const op = valNum(dash, 30, c);
        const expectedOp = (b16No ? totalRev : gp) - totalOh;
        if (Math.abs(expectedOp - op) > 0.05) {
          addViolation({
            kind: "dashboard_operating_profit",
            tabName: "Dashboard",
            cellKey: `R30C${c + 1}`,
            expected: Math.round(expectedOp * 100) / 100,
            actual: Math.round(op * 100) / 100,
          });
        }
      }

      // 3. Dashboard 12-month horizontal rollups == FY Totals
      for (const r1 of [4, 5, 6, 9, 16, 18, 26, 30]) {
        for (const band of fyBands) {
          let sum12 = 0;
          for (let c = band.startC; c <= band.endC; c++) sum12 += valNum(dash, r1, c);
          const fyTot = valNum(dash, r1, band.totC);
          if (Math.abs(sum12 - fyTot) > 0.05) {
            addViolation({
              kind: "dashboard_fy_horizontal_sum",
              tabName: "Dashboard",
              cellKey: `R${r1}C${band.totC + 1}`,
              expected: Math.round(sum12 * 100) / 100,
              actual: Math.round(fyTot * 100) / 100,
            });
          }
        }
      }

      // 4. Cash Table 1 (Excluding pipeline) 36-month continuity: Closing == Opening + Net movement
      for (let c = 1; c <= 36; c++) {
        const open = valNum(cash, 4, c);
        const net = valNum(cash, 32, c);
        const close = valNum(cash, 34, c);
        if (Math.abs((open + net) - close) > 0.05) {
          addViolation({
            kind: "cash_closing_identity",
            tabName: "Cash",
            cellKey: `R34C${c + 1}`,
            expected: Math.round((open + net) * 100) / 100,
            actual: Math.round(close * 100) / 100,
          });
        }
        if (c >= 2) {
          const prevActual = toNumOrNull_(cash?.[35]?.[c - 1]); // Row 36
          const prevCalcClose = valNum(cash, 34, c - 1);
          const expectedOpen = prevActual !== null ? prevActual : prevCalcClose;
          if (Math.abs(expectedOpen - open) > 0.05) {
            addViolation({
              kind: "cash_opening_carryforward",
              tabName: "Cash",
              cellKey: `R4C${c + 1}`,
              expected: Math.round(expectedOpen * 100) / 100,
              actual: Math.round(open * 100) / 100,
            });
          }
        }
      }

      // 5. VAT service quarter-rollup verification
      if (cl.client_sheet_id) {
        const vatRes = await fetchVatData(cl.client_name, cl.client_sheet_id, true);
        if (!Array.isArray(vatRes?.sections) || vatRes.sections.length < 2) {
          addViolation({
            kind: "vat_sections_missing",
            tabName: "VAT",
            cellKey: "sections",
            expected: ">= 2",
            actual: vatRes?.sections?.length ?? 0,
          });
        } else {
          for (const sec of vatRes.sections) {
            for (const row of sec.rows || []) {
              for (const fyVal of Object.values(row.fyData || {})) {
                for (const mCell of fyVal.months || []) {
                  if (mCell?.isError) {
                    addViolation({
                      kind: "vat_service_cell_error",
                      tabName: "VAT",
                      cellKey: `${sec.key}:${row.label}`,
                      expected: "valid number",
                      actual: mCell.rawDisplay || "error",
                    });
                  }
                }
              }
            }
          }
        }
      }

      results.push({
        clientName: cl.client_name,
        source: bundle?.source || "unknown",
        matched: violations.length === 0,
        totalMismatchCount: violations.length,
        violationCount: violations.length,
        sampleMismatches: violations.slice(0, 10),
        error: null,
      });
    } catch (err) {
      results.push({
        clientName: cl.client_name,
        source: "error",
        matched: false,
        totalMismatchCount: 0,
        violationCount: 0,
        sampleMismatches: [],
        error: err.message,
      });
    }
  }

  return {
    success: true,
    checkedAt: new Date().toISOString(),
    clientsChecked: results.length,
    matchedClientsCount: results.filter((r) => !r.error && r.matched).length,
    mismatchClientsCount: results.filter((r) => !r.error && !r.matched).length,
    errorClientsCount: results.filter((r) => Boolean(r.error)).length,
    results,
  };
}
