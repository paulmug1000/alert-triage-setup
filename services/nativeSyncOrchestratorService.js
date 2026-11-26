/**
 * nativeSyncOrchestratorService.js (Phase 6D)
 *
 * Manages Phase 6D native zero-grid automation orchestration, relational logging,
 * backfill from `master_sheet_grids`, mode switching (`sync_orchestrator_mode`),
 * live state parity verification (Suite #16 in daily alerts), and a 6-suite
 * deterministic replay harness verifying 100% cell/row parity vs legacy
 * grid-backed `compiledMasterGas.js`.
 *
 * Relational storage targets:
 *   - `public.pulse_automation_logs`        (replaces `master::AutoLog`)
 *   - `public.pulse_execution_logs`         (replaces `master::GasExecLogs`)
 *   - `public.pulse_master_sync_configs`    (`master_year0_data_grid`,
 *     `master_year0_formulas_grid`, `master_rev_comp_grid`,
 *     `master_starter_pl_grid`, `master_starter_inv_grid`,
 *     `master_mgmt_rep_grid`, `sync_orchestrator_backfilled_at`)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import {
  resolveSupabaseSheetContext,
  invalidateMasterEngineCache,
} from "./masterEngineService.js";
import {
  preloadClientRelationalMasterBundle,
  invalidateClientRelationalMasterCache,
} from "./relationalMasterService.js";
import {
  preloadClientRelationalReconBundle,
  reconstructRelationalReconTabFromBundle,
  invalidateClientRelationalReconCache,
} from "./relationalReconService.js";
import { createMasterGasInstance } from "./gasRuntime/compiledMasterGas.js";
import { VirtualSpreadsheet, VirtualSheet, formatGasDate } from "./gasRuntime/gasEnvironment.js";
import { compactGrid2D } from "./gasRuntime/masterFormulaEngine.js";
import { normalizeCellForStorage, dateToSerial } from "./gasRuntime/sheetValueUtils.js";
import { sanitizeSheetCell_ } from "./nativeConnectorUtils.js";
import { runNativeRevenueComparisonDirect } from "./nativeAccountingPullService.js";

if (typeof window !== "undefined") {
  throw new Error("SECURITY VIOLATION: services/nativeSyncOrchestratorService.js must never run in browser code.");
}

export const MASTER_AUX_COL_BY_TAB = Object.freeze({
  Year0Data: "master_year0_data_grid",
  RevComp: "master_rev_comp_grid",
  StarterPL: "master_starter_pl_grid",
  StarterInv: "master_starter_inv_grid",
  MgmtRep: "master_mgmt_rep_grid",
});

export const MASTER_AUX_TABS = Object.freeze(Object.keys(MASTER_AUX_COL_BY_TAB));

export const MASTER_TRANSIENT_CLIENT_MIRROR_TABS = new Set([
  "ConfCalcs",
  "PipeCalcs",
  "Outgoings",
  "OutgNotes",
  "NBtoFind",
  "Budget",
  "Salaries",
  "Dashboard",
  "Performance",
  "Cash",
  "Calcs",
  "DataForReport",
  "Welcome",
  "MthlyClient",
]);

export const PHASE6D_MASTER_LOG_AND_AUX_TABS = new Set([
  "AutoLog",
  "GasExecLogs",
  ...MASTER_AUX_TABS,
  ...MASTER_TRANSIENT_CLIENT_MIRROR_TABS,
]);

export const AUTOLOG_HEADERS = ["Timestamp", "Category", "Summary", "Details"];
export const GASEXECLOGS_HEADERS = [
  "Timestamp",
  "Function / Sequence",
  "Trigger Source",
  "Duration",
  "Status",
  "Summary",
  "Console Transcript",
];

let _cachedMigration0019Sql = null;
let _schema6dCache = { checkedAt: 0, status: null };

export function readMigration0019Sql() {
  if (_cachedMigration0019Sql !== null) return _cachedMigration0019Sql;
  try {
    const p = path.resolve(process.cwd(), "supabase/migrations/0019_phase6d_native_sync_and_logs.sql");
    _cachedMigration0019Sql = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  } catch {
    _cachedMigration0019Sql = "";
  }
  return _cachedMigration0019Sql;
}

export async function checkPhase6NativeSyncSchemaStatus({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && _schema6dCache.status && now - _schema6dCache.checkedAt < 15000) {
    return _schema6dCache.status;
  }

  const supabase = getSupabaseAdmin();
  const migrationSql = readMigration0019Sql();
  if (!supabase) {
    return { schemaReady: false, migrationSql, error: "Supabase admin client not configured." };
  }

  const checks = await Promise.all([
    supabase.from("clients").select("sync_orchestrator_mode").limit(1),
    supabase.from("pulse_automation_logs").select("id").limit(1),
    supabase.from("pulse_execution_logs").select("id").limit(1),
    supabase
      .from("pulse_master_sync_configs")
      .select(
        "master_year0_data_grid, master_year0_formulas_grid, master_rev_comp_grid, master_starter_pl_grid, master_starter_inv_grid, master_mgmt_rep_grid, sync_orchestrator_backfilled_at"
      )
      .limit(1),
  ]);

  const errors = checks.map((c) => c.error?.message).filter(Boolean);
  const schemaReady = errors.length === 0;
  const status = {
    schemaReady,
    migrationSql,
    error: errors.join("; ") || null,
  };
  _schema6dCache = { checkedAt: now, status };
  return status;
}

export async function getPhase6NativeSyncOverviewStats() {
  const schema = await checkPhase6NativeSyncSchemaStatus();
  const supabase = getSupabaseAdmin();
  if (!supabase || !schema.schemaReady) {
    return {
      schemaReady: false,
      migrationSql: schema.migrationSql,
      totalAutoLogs: 0,
      totalExecLogs: 0,
      totalBackfilledConfigs: 0,
      error: schema.error || null,
    };
  }

  const [autoRes, execRes, cfgRes] = await Promise.all([
    supabase.from("pulse_automation_logs").select("id", { count: "exact", head: true }),
    supabase.from("pulse_execution_logs").select("id", { count: "exact", head: true }),
    supabase
      .from("pulse_master_sync_configs")
      .select("client_id", { count: "exact", head: true })
      .not("sync_orchestrator_backfilled_at", "is", null),
  ]);

  return {
    schemaReady: true,
    migrationSql: schema.migrationSql,
    totalAutoLogs: autoRes.count ?? 0,
    totalExecLogs: execRes.count ?? 0,
    totalBackfilledConfigs: cfgRes.count ?? 0,
  };
}

// ============================================================================
// 1. RELATIONAL AUTOLOG, GASEXECLOGS & MASTER AUXILIARY HELPERS
// ============================================================================

function parseRawTimestampToIso_(rawVal) {
  if (rawVal === null || rawVal === undefined || rawVal === "") return new Date().toISOString();
  if (rawVal instanceof Date && !isNaN(rawVal.getTime())) return rawVal.toISOString();
  if (typeof rawVal === "number" && Number.isFinite(rawVal) && rawVal > 20000 && rawVal < 100000) {
    const ms = Math.round((rawVal - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const s = String(rawVal).trim();
  if (!s) return new Date().toISOString();
  const dDirect = new Date(s);
  if (!isNaN(dDirect.getTime())) return dDirect.toISOString();
  return new Date().toISOString();
}

function buildAutoLogRowPayload_(ctx, rowLike, source = "automator") {
  const isArr = Array.isArray(rowLike);
  const rawCell = isArr ? (rowLike[0] ?? "") : (rowLike.rawTimestampCell ?? rowLike.timestamp ?? "");
  const cat = isArr ? String(rowLike[1] ?? "") : String(rowLike.category ?? "");
  const sum = isArr ? String(rowLike[2] ?? "") : String(rowLike.summary ?? "");
  const det = isArr ? String(rowLike[3] ?? "") : String(rowLike.details ?? "");
  const tsDisplay = isArr
    ? (typeof rawCell === "number" ? formatGasDate(new Date(Math.round((rawCell - 25569) * 86400 * 1000)), "Europe/London", "dd-MMM-yy HH:mm") : String(rawCell ?? ""))
    : String(rowLike.timestampDisplay || (typeof rawCell === "string" ? rawCell : ""));

  const safeRawCell =
    rawCell instanceof Date
      ? dateToSerial(rawCell)
      : rawCell === null || rawCell === undefined
        ? ""
        : rawCell;

  return {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    logged_at: (!isArr && rowLike.loggedAt) ? rowLike.loggedAt : parseRawTimestampToIso_(rawCell),
    raw_timestamp_cell: safeRawCell,
    timestamp_display: String(tsDisplay || "").slice(0, 120),
    category: String(sanitizeSheetCell_(cat)).slice(0, 120),
    summary: String(sanitizeSheetCell_(sum)).slice(0, 2000),
    details: String(sanitizeSheetCell_(det)),
    source: String(source || "automator").slice(0, 64),
  };
}

async function pruneClientAutomationLogs_(supabase, clientId, maxRows = 2500) {
  if (!supabase || !clientId) return;
  const { data: overflow } = await supabase
    .from("pulse_automation_logs")
    .select("id")
    .eq("client_id", clientId)
    .order("sort_seq", { ascending: false })
    .order("id", { ascending: false })
    .range(maxRows, maxRows + 500);
  const ids = (overflow || []).map((r) => r.id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 200) {
    await supabase.from("pulse_automation_logs").delete().in("id", ids.slice(i, i + 200));
  }
}

async function pruneClientExecutionLogs_(supabase, clientId, maxRows = 50) {
  if (!supabase || !clientId) return;
  const { data: overflow } = await supabase
    .from("pulse_execution_logs")
    .select("id")
    .eq("client_id", clientId)
    .order("sort_seq", { ascending: false })
    .order("id", { ascending: false })
    .range(maxRows, maxRows + 200);
  const ids = (overflow || []).map((r) => r.id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 200) {
    await supabase.from("pulse_execution_logs").delete().in("id", ids.slice(i, i + 200));
  }
}

export async function insertAutomationLogEntries(ctx, entries = [], { source = "automator" } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId || !Array.isArray(entries) || entries.length === 0) return 0;

  // Expect entries ordered newest-first if multiple, so insert oldest -> newest so newest gets highest sort_seq
  const ordered = entries.length > 1 ? [...entries].reverse() : [...entries];
  const payloads = ordered
    .filter(Boolean)
    .map((e) => buildAutoLogRowPayload_(ctx, e, source));
  if (payloads.length === 0) return 0;

  for (let i = 0; i < payloads.length; i += 200) {
    const chunk = payloads.slice(i, i + 200);
    const { error } = await supabase.from("pulse_automation_logs").insert(chunk);
    if (error) throw new Error(`pulse_automation_logs insert failed: ${error.message}`);
  }
  await pruneClientAutomationLogs_(supabase, ctx.clientId, 2500).catch(() => { });
  invalidateMasterEngineCache(ctx.clientName, "master", ["AutoLog"]);
  return payloads.length;
}

export async function replaceClientAutomationLogFromGrid(ctx, valuesGrid = []) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return 0;

  const rows = [];
  const startRow =
    Array.isArray(valuesGrid[0]) && String(valuesGrid[0][0] || "").trim().toLowerCase() === "timestamp" ? 1 : 0;
  // Insert from bottom (oldest) to top (newest) so `ORDER BY sort_seq DESC` matches valuesGrid row 2..N 1:1
  for (let r = valuesGrid.length - 1; r >= startRow; r--) {
    const row = valuesGrid[r];
    if (!Array.isArray(row) || !row.some((c) => c !== "" && c !== null && c !== undefined)) continue;
    rows.push(buildAutoLogRowPayload_(ctx, row, "grid_sync"));
  }

  const { error: delErr } = await supabase
    .from("pulse_automation_logs")
    .delete()
    .eq("client_id", ctx.clientId);
  if (delErr) throw new Error(`pulse_automation_logs replace delete failed: ${delErr.message}`);

  const capped = rows.slice(-2500);
  for (let i = 0; i < capped.length; i += 200) {
    const chunk = capped.slice(i, i + 200);
    const { error: insErr } = await supabase.from("pulse_automation_logs").insert(chunk);
    if (insErr) throw new Error(`pulse_automation_logs replace insert failed: ${insErr.message}`);
  }

  invalidateMasterEngineCache(ctx.clientName, "master", ["AutoLog"]);
  return capped.length;
}

export async function loadClientAutomationLogGrid(ctx, { limit = 5000 } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return [AUTOLOG_HEADERS];

  const rows = [];
  const cap = Math.max(1, Math.min(Number(limit) || 5000, 10000));
  for (let from = 0; from < cap; from += 1000) {
    const to = Math.min(cap - 1, from + 999);
    const { data, error } = await supabase
      .from("pulse_automation_logs")
      .select("raw_timestamp_cell, timestamp_display, category, summary, details")
      .eq("client_id", ctx.clientId)
      .order("sort_seq", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);
    if (error) throw new Error(`pulse_automation_logs load failed: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }

  const grid = [AUTOLOG_HEADERS];
  for (const r of rows) {
    const tsCell =
      r.raw_timestamp_cell !== null && r.raw_timestamp_cell !== undefined && r.raw_timestamp_cell !== ""
        ? r.raw_timestamp_cell
        : (r.timestamp_display || "");
    grid.push([tsCell, r.category || "", r.summary || "", r.details || ""]);
  }
  return grid;
}

export async function loadBatchClientAutomationLogGrids(canonicalClientNames = [], { limitPerClient = 250 } = {}) {
  const names = [...new Set((canonicalClientNames || []).map((n) => String(n || "").trim()).filter(Boolean))];
  const byLowerClientName = new Map();
  if (names.length === 0 || !isSupabaseConfigured()) {
    return { byLowerClientName, failed: false };
  }
  const supabase = getSupabaseAdmin();
  if (!supabase) return { byLowerClientName, failed: true };

  try {
    const grouped = new Map();
    const perClientCap = Math.max(1, Math.min(Number(limitPerClient) || 250, 1000));
    for (let i = 0; i < names.length; i += 4) {
      const batch = names.slice(i, i + 4);
      const batchRes = await Promise.all(
        batch.map((cName) =>
          supabase
            .from("pulse_automation_logs")
            .select("client_name, sort_seq, raw_timestamp_cell, timestamp_display, category, summary, details")
            .eq("client_name", cName)
            .order("sort_seq", { ascending: false })
            .order("id", { ascending: false })
            .limit(perClientCap)
        )
      );
      for (const { data: rows, error } of batchRes) {
        if (error) {
          return { byLowerClientName, failed: true, error: error.message };
        }
        for (const r of rows || []) {
          const key = String(r.client_name || "").trim().toLowerCase();
          if (!key) continue;
          if (!grouped.has(key)) grouped.set(key, [AUTOLOG_HEADERS]);
          const arr = grouped.get(key);
          if (arr.length - 1 >= perClientCap) continue;
          const tsCell =
            r.raw_timestamp_cell !== null && r.raw_timestamp_cell !== undefined && r.raw_timestamp_cell !== ""
              ? r.raw_timestamp_cell
              : (r.timestamp_display || "");
          arr.push([tsCell, r.category || "", r.summary || "", r.details || ""]);
        }
      }
    }

    for (const n of names) {
      const key = n.toLowerCase();
      const vGrid = grouped.get(key) || [AUTOLOG_HEADERS];
      byLowerClientName.set(key, {
        client_name: n,
        tab_name: "AutoLog",
        values_grid: vGrid,
        notes_grid: {},
      });
    }
    return { byLowerClientName, failed: false };
  } catch (err) {
    return { byLowerClientName, failed: true, error: err?.message || "Batch automation logs query error" };
  }
}

export async function insertExecutionLogEntry(ctx, entry = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return;

  const tsDisplay = String(entry.timestampDisplay || entry.timestamp || new Date().toISOString());
  const payload = {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    executed_at: entry.executedAt || new Date().toISOString(),
    timestamp_display: tsDisplay.slice(0, 120),
    function_name: String(entry.functionName || "runAgencyAutomator").slice(0, 200),
    trigger_source: String(entry.triggerSource || "Automated / API").slice(0, 200),
    duration_text: String(entry.durationText || entry.duration || "").slice(0, 64),
    status: String(entry.status || "Completed").slice(0, 120),
    summary: String(entry.summary || "").slice(0, 2000),
    transcript: String(entry.transcript || ""),
  };

  const { error } = await supabase.from("pulse_execution_logs").insert([payload]);
  if (error) throw new Error(`pulse_execution_logs insert failed: ${error.message}`);
  await pruneClientExecutionLogs_(supabase, ctx.clientId, 50).catch(() => { });
  invalidateMasterEngineCache(ctx.clientName, "master", ["GasExecLogs"]);
}

export async function replaceClientExecutionLogsFromGrid(ctx, valuesGrid = []) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return 0;

  const rows = [];
  const startRow =
    Array.isArray(valuesGrid[0]) && String(valuesGrid[0][0] || "").trim().toLowerCase() === "timestamp" ? 1 : 0;
  for (let r = valuesGrid.length - 1; r >= startRow; r--) {
    const row = valuesGrid[r];
    if (!Array.isArray(row) || !row.some(Boolean)) continue;
    rows.push({
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      executed_at: parseRawTimestampToIso_(row[0]),
      timestamp_display: String(row[0] ?? "").slice(0, 120),
      function_name: String(row[1] ?? "").slice(0, 200),
      trigger_source: String(row[2] ?? "").slice(0, 200),
      duration_text: String(row[3] ?? "").slice(0, 64),
      status: String(row[4] ?? "Completed").slice(0, 120),
      summary: String(row[5] ?? "").slice(0, 2000),
      transcript: String(row[6] ?? ""),
    });
  }

  const { error: delErr } = await supabase.from("pulse_execution_logs").delete().eq("client_id", ctx.clientId);
  if (delErr) throw new Error(`pulse_execution_logs replace delete failed: ${delErr.message}`);

  const capped = rows.slice(-50);
  if (capped.length > 0) {
    const { error: insErr } = await supabase.from("pulse_execution_logs").insert(capped);
    if (insErr) throw new Error(`pulse_execution_logs replace insert failed: ${insErr.message}`);
  }
  invalidateMasterEngineCache(ctx.clientName, "master", ["GasExecLogs"]);
  return capped.length;
}

export async function loadClientExecutionLogGrid(ctx, { limit = 50 } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return [GASEXECLOGS_HEADERS];

  const { data, error } = await supabase
    .from("pulse_execution_logs")
    .select("timestamp_display, function_name, trigger_source, duration_text, status, summary, transcript")
    .eq("client_id", ctx.clientId)
    .order("sort_seq", { ascending: false })
    .limit(Math.max(1, Math.min(Number(limit) || 50, 200)));

  if (error) throw new Error(`pulse_execution_logs load failed: ${error.message}`);

  const grid = [GASEXECLOGS_HEADERS];
  for (const r of data || []) {
    grid.push([
      r.timestamp_display || "",
      r.function_name || "",
      r.trigger_source || "",
      r.duration_text || "",
      r.status || "Completed",
      r.summary || "",
      r.transcript || "",
    ]);
  }
  return grid;
}

export async function loadMasterAuxTabFromConfig(ctx, tabName) {
  const col = Object.prototype.hasOwnProperty.call(MASTER_AUX_COL_BY_TAB, tabName)
    ? MASTER_AUX_COL_BY_TAB[tabName]
    : null;
  if (!col || !ctx?.clientId) return null;
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const selectCols = tabName === "Year0Data" ? `${col}, master_year0_formulas_grid` : col;
  const { data, error } = await supabase
    .from("pulse_master_sync_configs")
    .select(selectCols)
    .eq("client_id", ctx.clientId)
    .maybeSingle();

  if (error || !data) return null;
  const vGrid = Array.isArray(data[col]) ? compactGrid2D(data[col]) : [];
  const fGrid =
    tabName === "Year0Data" && Array.isArray(data.master_year0_formulas_grid) && data.master_year0_formulas_grid.length > 0
      ? compactGrid2D(data.master_year0_formulas_grid)
      : vGrid;

  return { values_grid: vGrid, formulas_grid: fGrid };
}

export async function saveMasterAuxTabsToConfig(ctx, auxTabsMap = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return;

  const patch = {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    updated_at: new Date().toISOString(),
  };
  let hasField = false;

  for (const [tabName, entry] of Object.entries(auxTabsMap || {})) {
    if (tabName === "__proto__" || tabName === "constructor" || tabName === "prototype") continue;
    const col = Object.prototype.hasOwnProperty.call(MASTER_AUX_COL_BY_TAB, tabName)
      ? MASTER_AUX_COL_BY_TAB[tabName]
      : null;
    if (!col) continue;
    const vals = Array.isArray(entry?.values_grid)
      ? compactGrid2D(entry.values_grid)
      : Array.isArray(entry)
        ? compactGrid2D(entry)
        : [];
    patch[col] = vals;
    hasField = true;
    if (tabName === "Year0Data" && Array.isArray(entry?.formulas_grid) && entry.formulas_grid.length > 0) {
      patch.master_year0_formulas_grid = compactGrid2D(entry.formulas_grid);
    }
  }

  if (!hasField) return;
  const { error } = await supabase
    .from("pulse_master_sync_configs")
    .upsert(patch, { onConflict: "client_id" });
  if (error) throw new Error(`saveMasterAuxTabsToConfig failed for ${ctx.clientName}: ${error.message}`);
}

// ============================================================================
// 2. MIGRATION 0019 BACKFILL FROM MASTER_SHEET_GRIDS
// ============================================================================

export async function backfillClientNativeSync(clientName) {
  const schema = await checkPhase6NativeSyncSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0019 tables/columns are not present in Supabase yet. Apply 0019_phase6d_native_sync_and_logs.sql first.");
  }

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) throw new Error(`Client "${clientName}" not found.`);
  if (ctx.gridStorageRetired) {
    const supa = getSupabaseAdmin();
    const [aCnt, eCnt, cfgRes] = await Promise.all([
      supa.from("pulse_automation_logs").select("id", { count: "exact", head: true }).eq("client_id", ctx.clientId),
      supa.from("pulse_execution_logs").select("id", { count: "exact", head: true }).eq("client_id", ctx.clientId),
      supa.from("pulse_master_sync_configs").select("master_year0_data_grid, master_rev_comp_grid, master_mgmt_rep_grid").eq("client_id", ctx.clientId).maybeSingle(),
    ]);
    return {
      clientName: ctx.clientName,
      skippedRetired: true,
      autoLogsCount: aCnt.count ?? 0,
      execLogsCount: eCnt.count ?? 0,
      auxTabsSynced: cfgRes?.data ? Object.values(cfgRes.data).filter((g) => Array.isArray(g) && g.length > 0).length : 0,
    };
  }

  const supabase = getSupabaseAdmin();
  const targetTabs = ["AutoLog", "GasExecLogs", ...MASTER_AUX_TABS];
  const { data: gridRows, error: gridErr } = await supabase
    .from("master_sheet_grids")
    .select("tab_name, values_grid, formulas_grid")
    .eq("client_name", ctx.clientName)
    .eq("sheet_role", "master")
    .in("tab_name", targetTabs);

  if (gridErr) throw new Error(`Failed loading master_sheet_grids for ${ctx.clientName}: ${gridErr.message}`);

  const byTab = new Map();
  for (const r of gridRows || []) {
    byTab.set(r.tab_name, {
      values_grid: compactGrid2D(r.values_grid || []),
      formulas_grid: compactGrid2D(r.formulas_grid || []),
    });
  }

  const isAlreadyNative = ctx.syncOrchestratorMode === "native";
  let autoLogsCount = 0;
  let execLogsCount = 0;

  if (!isAlreadyNative) {
    autoLogsCount = await replaceClientAutomationLogFromGrid(ctx, byTab.get("AutoLog")?.values_grid || []);
    execLogsCount = await replaceClientExecutionLogsFromGrid(ctx, byTab.get("GasExecLogs")?.values_grid || []);
  } else {
    const [aCnt, eCnt] = await Promise.all([
      supabase.from("pulse_automation_logs").select("id", { count: "exact", head: true }).eq("client_id", ctx.clientId),
      supabase.from("pulse_execution_logs").select("id", { count: "exact", head: true }).eq("client_id", ctx.clientId),
    ]);
    autoLogsCount = aCnt.count ?? 0;
    execLogsCount = eCnt.count ?? 0;
  }

  const nowIso = new Date().toISOString();
  const y0Rec = byTab.get("Year0Data");
  const cfgPatch = {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    sync_orchestrator_backfilled_at: nowIso,
    updated_at: nowIso,
  };

  if (!isAlreadyNative) {
    cfgPatch.master_year0_data_grid = y0Rec?.values_grid || [];
    cfgPatch.master_year0_formulas_grid = y0Rec?.formulas_grid?.length ? y0Rec.formulas_grid : (y0Rec?.values_grid || []);
    cfgPatch.master_rev_comp_grid = byTab.get("RevComp")?.values_grid || [];
    cfgPatch.master_starter_pl_grid = byTab.get("StarterPL")?.values_grid || [];
    cfgPatch.master_starter_inv_grid = byTab.get("StarterInv")?.values_grid || [];
    cfgPatch.master_mgmt_rep_grid = byTab.get("MgmtRep")?.values_grid || [];
  }

  const { error: cfgErr } = await supabase
    .from("pulse_master_sync_configs")
    .upsert(cfgPatch, { onConflict: "client_id" });
  if (cfgErr) throw new Error(`Failed backfilling Phase 6D aux grids for ${ctx.clientName}: ${cfgErr.message}`);

  const { data: curClient, error: curClientErr } = await supabase
    .from("clients")
    .select("metadata")
    .eq("id", ctx.clientId)
    .maybeSingle();

  const nextMeta = {
    ...(curClient?.metadata || {}),
    native_sync_state: {
      lastBackfilledAt: nowIso,
      autoLogsCount,
      execLogsCount,
      hasYear0Data: Boolean((y0Rec?.values_grid || []).length > 0),
      hasRevComp: Boolean((byTab.get("RevComp")?.values_grid || []).length > 0),
      hasMgmtRep: Boolean((byTab.get("MgmtRep")?.values_grid || []).length > 0),
    },
  };
  if (!curClientErr && curClient) {
    await supabase.from("clients").update({ metadata: nextMeta }).eq("id", ctx.clientId);
  }

  invalidateMasterEngineCache(ctx.clientName);
  invalidateClientRelationalMasterCache(ctx.clientName);

  return {
    clientName: ctx.clientName,
    autoLogsCount,
    execLogsCount,
    auxTabsSynced: MASTER_AUX_TABS.filter((t) => (byTab.get(t)?.values_grid || []).length > 0).length,
  };
}

export async function backfillAllClientsNativeSync() {
  const schema = await checkPhase6NativeSyncSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0019 tables/columns are not present in Supabase yet.");
  }
  const supabase = getSupabaseAdmin();
  const { data: clients, error } = await supabase
    .from("clients")
    .select("client_name")
    .order("client_name", { ascending: true });
  if (error) throw new Error(`Clients fetch failed: ${error.message}`);

  const results = [];
  for (const c of clients || []) {
    try {
      results.push(await backfillClientNativeSync(c.client_name));
    } catch (err) {
      results.push({ clientName: c.client_name, error: err.message });
    }
  }
  return {
    clientsProcessed: results.length,
    results,
  };
}

// ============================================================================
// 3. SAFE MODE SWITCHING (`grid_gas` -> `shadow` -> `native`)
// ============================================================================

export async function setClientSyncOrchestratorMode(clientName, modeRaw) {
  const mode = String(modeRaw || "").trim().toLowerCase();
  if (mode !== "grid_gas" && mode !== "shadow" && mode !== "native") {
    throw new Error(`Invalid syncOrchestratorMode "${modeRaw}". Expected 'grid_gas', 'shadow', or 'native'.`);
  }

  const schema = await checkPhase6NativeSyncSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0019 must be applied before modifying syncOrchestratorMode.");
  }

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) throw new Error(`Client "${clientName}" not found.`);
  if (ctx.gridStorageRetired) {
    if (mode !== "native") {
      throw new Error(
        `Client "${ctx.clientName}" has retired grid storage and cannot be downgraded from 'native' sync_orchestrator_mode.`
      );
    }
    const supa = getSupabaseAdmin();
    const [aCnt, eCnt, cfgRes] = await Promise.all([
      supa.from("pulse_automation_logs").select("id", { count: "exact", head: true }).eq("client_id", ctx.clientId),
      supa.from("pulse_execution_logs").select("id", { count: "exact", head: true }).eq("client_id", ctx.clientId),
      supa.from("pulse_master_sync_configs").select("master_year0_data_grid, master_rev_comp_grid, master_mgmt_rep_grid").eq("client_id", ctx.clientId).maybeSingle(),
    ]);
    return {
      clientName: ctx.clientName,
      syncOrchestratorMode: "native",
      skippedRetired: true,
      autoLogsCount: aCnt.count ?? 0,
      execLogsCount: eCnt.count ?? 0,
      auxTabsSynced: cfgRes?.data ? Object.values(cfgRes.data).filter((g) => Array.isArray(g) && g.length > 0).length : 0,
    };
  }

  const supabase = getSupabaseAdmin();
  if (mode === "native") {
    const { data: cfg } = await supabase
      .from("pulse_master_sync_configs")
      .select("sync_orchestrator_backfilled_at")
      .eq("client_id", ctx.clientId)
      .maybeSingle();
    if (!cfg?.sync_orchestrator_backfilled_at) {
      await backfillClientNativeSync(ctx.clientName);
    }
    const parity = await verifyNativeSyncStateParity({ clientName: ctx.clientName });
    if ((parity.mismatchClientsCount || 0) > 0 || (parity.errorClientsCount || 0) > 0) {
      throw new Error(
        `Cannot promote ${ctx.clientName} sync_orchestrator_mode to 'native': parity check failed (${JSON.stringify(
          parity.results?.[0]?.sampleMismatches || parity.results?.[0]?.error
        )}).`
      );
    }
  }

  const { data: curClient, error: curErr } = await supabase
    .from("clients")
    .select("metadata")
    .eq("id", ctx.clientId)
    .maybeSingle();
  if (curErr) throw new Error(`Failed loading client metadata for ${ctx.clientName}: ${curErr.message}`);

  const nextMeta = {
    ...(curClient?.metadata || {}),
    sync_orchestrator_mode: mode,
    native_sync_state: {
      ...(curClient?.metadata?.native_sync_state || {}),
      mode,
      updatedAt: new Date().toISOString(),
    },
  };

  const { error: upErr } = await supabase
    .from("clients")
    .update({ sync_orchestrator_mode: mode, metadata: nextMeta })
    .eq("id", ctx.clientId);
  if (upErr) throw new Error(`Failed updating sync_orchestrator_mode for ${ctx.clientName}: ${upErr.message}`);

  invalidateMasterEngineCache(ctx.clientName);
  invalidateClientRelationalMasterCache(ctx.clientName);
  invalidateClientRelationalReconCache(ctx.clientName);

  return {
    clientName: ctx.clientName,
    syncOrchestratorMode: mode,
  };
}

// ============================================================================
// 4. DATABASE STATE PARITY VERIFICATION (SUITE #16)
// ============================================================================

function normalizeCompareCell_(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Math.round(dateToSerial(v) * 10000) / 10000;
  if (typeof v === "number") return Math.round(v * 10000) / 10000;
  return String(v).trim();
}

function compareGridsSampled_(tabName, gridA = [], gridB = [], maxMismatches = 5) {
  const mismatches = [];
  const a = compactGrid2D(gridA || []);
  const b = compactGrid2D(gridB || []);
  if (a.length === 0 && b.length === 0) return mismatches;
  if (a.length !== b.length) {
    mismatches.push({
      tab: tabName,
      cell: "rows",
      rowLabel: "Row count",
      colLabel: tabName,
      sheetValue: a.length,
      supabaseValue: b.length,
    });
    return mismatches;
  }
  for (let r = 0; r < a.length && mismatches.length < maxMismatches; r++) {
    const cols = Math.max(a[r]?.length || 0, b[r]?.length || 0);
    for (let c = 0; c < cols; c++) {
      const va = normalizeCompareCell_(a[r]?.[c]);
      const vb = normalizeCompareCell_(b[r]?.[c]);
      if (va !== vb) {
        mismatches.push({
          tab: tabName,
          cell: `R${r + 1}C${c + 1}`,
          rowLabel: `Row ${r + 1}`,
          colLabel: `Col ${c + 1}`,
          sheetValue: va,
          supabaseValue: vb,
        });
        break;
      }
    }
  }
  return mismatches;
}

export async function verifyNativeSyncStateParity({
  clientName = null,
  onlyActiveOrShadow = false,
} = {}) {
  const checkedAt = new Date().toISOString();
  const schema = await checkPhase6NativeSyncSchemaStatus();
  if (!schema.schemaReady) {
    return {
      checkedAt,
      clientsChecked: 0,
      matchedClientsCount: 0,
      mismatchClientsCount: 0,
      errorClientsCount: 0,
      results: [],
    };
  }

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("clients")
    .select("id, client_name, sync_orchestrator_mode, metadata")
    .order("client_name", { ascending: true });
  if (clientName) query = query.eq("client_name", clientName);
  const { data: clients, error } = await query;
  if (error) throw new Error(`verifyNativeSyncStateParity query failed: ${error.message}`);

  const targets = (clients || []).filter((c) => {
    const m = String(c.sync_orchestrator_mode || c.metadata?.sync_orchestrator_mode || "grid_gas").toLowerCase();
    return !onlyActiveOrShadow || m === "shadow" || m === "native";
  });

  const results = [];
  for (const c of targets) {
    const mode = String(c.sync_orchestrator_mode || c.metadata?.sync_orchestrator_mode || "grid_gas").toLowerCase();
    try {
      const ctx = await resolveSupabaseSheetContext({ clientName: c.client_name });
      const { data: cfg } = await supabase
        .from("pulse_master_sync_configs")
        .select("*")
        .eq("client_id", c.id)
        .maybeSingle();

      if (!cfg) {
        results.push({
          clientName: c.client_name,
          mode,
          matched: false,
          mismatchCount: 1,
          sampleMismatches: [
            { tab: "pulse_master_sync_configs", cell: "row", rowLabel: "Missing config", colLabel: "6D", sheetValue: "exists", supabaseValue: "missing" },
          ],
        });
        continue;
      }

      const mismatches = [];

      if (mode !== "native") {
        const tabsToCheck = ["AutoLog", "GasExecLogs", ...MASTER_AUX_TABS];
        const { data: gridRows } = await supabase
          .from("master_sheet_grids")
          .select("tab_name, values_grid")
          .eq("client_name", c.client_name)
          .eq("sheet_role", "master")
          .in("tab_name", tabsToCheck);

        const gridMap = new Map();
        for (const r of gridRows || []) {
          gridMap.set(r.tab_name, compactGrid2D(r.values_grid || []));
        }

        const hasLogContent = (r) =>
          Array.isArray(r) && r.some((cell) => cell !== "" && cell !== null && cell !== undefined);

        if (gridMap.has("AutoLog")) {
          const alDbGrid = await loadClientAutomationLogGrid(ctx, { limit: 2500 });
          const alSheet = compactGrid2D(gridMap.get("AutoLog"));
          const hasHeader = Array.isArray(alSheet[0]) && String(alSheet[0][0] || "").trim().toLowerCase() === "timestamp";
          const alDataRows = (hasHeader ? alSheet.slice(1) : alSheet).filter(hasLogContent).slice(0, 2500);
          const alExpected = [AUTOLOG_HEADERS, ...alDataRows];
          const normalizedExpected = alExpected.map((r) => [r[0] ?? "", r[1] ?? "", r[2] ?? "", r[3] ?? ""]);
          const normalizedActual = alDbGrid.map((r) => [r[0] ?? "", r[1] ?? "", r[2] ?? "", r[3] ?? ""]);
          mismatches.push(...compareGridsSampled_("AutoLog", normalizedExpected, normalizedActual, 4));
        }

        if (gridMap.has("GasExecLogs")) {
          const exDbGrid = await loadClientExecutionLogGrid(ctx, { limit: 50 });
          const exSheet = compactGrid2D(gridMap.get("GasExecLogs"));
          const hasHeader = Array.isArray(exSheet[0]) && String(exSheet[0][0] || "").trim().toLowerCase() === "timestamp";
          const exDataRows = (hasHeader ? exSheet.slice(1) : exSheet).filter(hasLogContent).slice(0, 50);
          const exExpected = [GASEXECLOGS_HEADERS, ...exDataRows];
          const normExp = exExpected.map((r) => [r[0] ?? "", r[1] ?? "", r[2] ?? "", r[3] ?? "", r[4] ?? "", r[5] ?? "", r[6] ?? ""]);
          const normAct = exDbGrid.map((r) => [r[0] ?? "", r[1] ?? "", r[2] ?? "", r[3] ?? "", r[4] ?? "", r[5] ?? "", r[6] ?? ""]);
          mismatches.push(...compareGridsSampled_("GasExecLogs", normExp, normAct, 4));
        }

        for (const [tabName, colName] of Object.entries(MASTER_AUX_COL_BY_TAB)) {
          if (!gridMap.has(tabName)) continue;
          mismatches.push(...compareGridsSampled_(tabName, gridMap.get(tabName), cfg[colName] || [], 4));
        }
      } else {
        if (!cfg.sync_orchestrator_backfilled_at) {
          mismatches.push({
            tab: "pulse_master_sync_configs",
            cell: "sync_orchestrator_backfilled_at",
            rowLabel: "Backfill stamp",
            colLabel: "6D native",
            sheetValue: "timestamp",
            supabaseValue: "null",
          });
        }
        const [alGrid, exGrid, rBundle, mBundle] = await Promise.all([
          loadClientAutomationLogGrid(ctx, { limit: 50 }),
          loadClientExecutionLogGrid(ctx, { limit: 10 }),
          preloadClientRelationalReconBundle(ctx, { source: "db" }),
          preloadClientRelationalMasterBundle(ctx, { source: "db" }),
        ]);
        if (!Array.isArray(alGrid) || alGrid.length === 0) {
          mismatches.push({ tab: "pulse_automation_logs", cell: "rows", rowLabel: "AutoLog", colLabel: "6D native", sheetValue: "Array", supabaseValue: "invalid" });
        }
        if (!Array.isArray(exGrid) || exGrid.length === 0) {
          mismatches.push({ tab: "pulse_execution_logs", cell: "rows", rowLabel: "GasExecLogs", colLabel: "6D native", sheetValue: "Array", supabaseValue: "invalid" });
        }
        if (!rBundle || !(rBundle.periods?.length >= 0)) {
          mismatches.push({ tab: "bank_recon_periods", cell: "bundle", rowLabel: "Recon bundle", colLabel: "6D native", sheetValue: "Loaded", supabaseValue: "missing" });
        } else if (rBundle.periods.length > 0) {
          const sampleTab = rBundle.periods[0].month_key;
          const rec = reconstructRelationalReconTabFromBundle(rBundle, sampleTab);
          if (!Array.isArray(rec?.values_grid)) {
            mismatches.push({ tab: sampleTab, cell: "grid", rowLabel: sampleTab, colLabel: "6D native", sheetValue: "Array", supabaseValue: "null" });
          }
        }
        if (!mBundle) {
          mismatches.push({ tab: "relationalMaster", cell: "bundle", rowLabel: "Master bundle", colLabel: "6D native", sheetValue: "Loaded", supabaseValue: "missing" });
        }
      }

      results.push({
        clientName: c.client_name,
        mode,
        matched: mismatches.length === 0,
        mismatchCount: mismatches.length,
        sampleMismatches: mismatches.slice(0, 8),
      });
    } catch (err) {
      results.push({
        clientName: c.client_name,
        mode,
        matched: false,
        mismatchCount: 1,
        error: err.message,
      });
    }
  }

  return {
    checkedAt,
    clientsChecked: results.length,
    matchedClientsCount: results.filter((r) => r.matched && !r.error).length,
    mismatchClientsCount: results.filter((r) => !r.matched && !r.error).length,
    errorClientsCount: results.filter((r) => Boolean(r.error)).length,
    results,
  };
}

// ============================================================================
// 5. DETERMINISTIC 6-SUITE SYNC REPLAY PARITY HARNESS
// ============================================================================

function createInMemorySyncHarness_({ masterTabs = {}, clientTabs = {}, props = {} }) {
  const masterId = "mock_master_6d";
  const clientId = "mock_client_6d";
  const envState = { masterFormulasDirty: false, recomputeMasterFormulasSync: () => { } };

  const masterSS = new VirtualSpreadsheet({ id: masterId, name: "Mock Master", sheetRole: "master", isRemoteGoogleSheet: false, env: envState });
  const clientSS = new VirtualSpreadsheet({ id: clientId, name: "Mock Client", sheetRole: "client", isRemoteGoogleSheet: true, env: envState });

  let idx = 1;
  for (const [t, g] of Object.entries(masterTabs)) {
    const vals = compactGrid2D(g);
    const vs = new VirtualSheet(masterSS, t, vals, vals.map((r) => [...r]), {}, idx++, Math.max(500, vals.length), 80);
    masterSS.sheetsByName.set(t, vs);
  }
  for (const [t, g] of Object.entries(clientTabs)) {
    const vals = compactGrid2D(g);
    const vs = new VirtualSheet(clientSS, t, vals, vals.map((r) => [...r]), {}, idx++, Math.max(500, vals.length), 100);
    clientSS.sheetsByName.set(t, vs);
  }

  const propsMap = new Map(Object.entries(props));
  const env = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => masterSS,
      getActive: () => masterSS,
      openById: async (id) => (id === clientId ? clientSS : masterSS),
      openByUrl: async () => clientSS,
      flush: async () => { },
      getUi: () => ({ alert: () => { }, ButtonSet: { OK: 1 } }),
      WrapStrategy: { WRAP: "WRAP" },
      newConditionalFormatRule: () => {
        const b = { whenNumberNotBetween: () => b, setBackground: () => b, setFontColor: () => b, setRanges: () => b, build: () => ({}) };
        return b;
      },
    },
    Sheets: {
      Spreadsheets: {
        Values: {
          batchUpdate: async (resource, spreadsheetId) => {
            const targetSS = spreadsheetId === clientId ? clientSS : masterSS;
            const dataArr = Array.isArray(resource?.data) ? resource.data : [];
            for (const item of dataArr) {
              const rawRange = String(item?.range || "");
              const bangIdx = rawRange.indexOf("!");
              const tabPart = bangIdx >= 0 ? rawRange.slice(0, bangIdx).replace(/^'|'$/g, "") : "Confirmed";
              const a1Part = bangIdx >= 0 ? rawRange.slice(bangIdx + 1) : rawRange;
              const sh = targetSS.getSheetByName(tabPart);
              if (sh && Array.isArray(item?.values)) {
                sh.getRange(a1Part).setValues(item.values);
              }
            }
            return { totalUpdatedRanges: dataArr.length };
          },
        },
      },
    },
    UrlFetchApp: { fetch: async () => ({ getResponseCode: () => 404, getContentText: () => "{}" }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => propsMap.get(String(k)) ?? null,
        setProperty: (k, v) => propsMap.set(String(k), String(v ?? "")),
        deleteProperty: (k) => propsMap.delete(String(k)),
      }),
    },
    Utilities: {
      sleep: async () => { },
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => formatGasDate(d, tz || "Europe/London", fmt),
    },
    DriveApp: { getRootFolder: () => ({ createFile: () => ({ getId: () => "" }) }) },
    Drive: {},
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => { } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { } }) },
    Session: { getScriptTimeZone: () => "Europe/London" },
    Logger: { log: () => { } },
    HtmlService: {},
    ScriptApp: { getOAuthToken: async () => "" },
    ContentService: { createTextOutput: (t) => ({ getContent: () => t }) },
    console: { log: () => { }, info: () => { }, warn: () => { }, error: () => { } },
  };
  return { env, masterSS, clientSS };
}

function buildInvCompHeadersFixture_() {
  // Exact InvComp header row (row 5): App section left of/at Currency (0..8), Compare section right of Currency (9..16)
  return [
    "Client",
    "Job",
    "Total excl VAT",
    "VAT included",
    "Invoice no",
    "Sent date",
    "Fully paid on",
    "Status",
    "Currency",
    "Missing invoice?",
    "Client mismatch",
    "Inv amt mismatch?",
    "Sent date mismatch?",
    "Duplicate inv no ?",
    "Fully paid on mismatch?",
    "Status mismatch?",
    "Push?",
  ];
}

export async function verifyNativeSyncReplayParity() {
  const checkedAt = new Date().toISOString();
  const suites = [];

  const canonicalConfHeaders = [
    "Client",
    "Job name",
    "Confirmed?",
    "VAT?",
    "Project / Retainer",
    "Inv 1 ref",
    "Project invoice 1 / monthly retainer (excl VAT)",
    "Inv 1 SEND date",
    "Inv 1 days to pay",
    "Inv 1 status",
    "Inv 2 ref",
    "Project invoice 2 (excl VAT)",
    "Inv 2 SEND date",
    "Inv 2 days to pay",
    "Inv 2 status",
    "Inv 3 ref",
    "Project invoice 3 (excl VAT)",
    "Inv 3 SEND date",
    "Inv 3 days to pay",
    "Inv 3 status",
  ];

  // Suite 1: PushInvDetailsToConfirmed (grid vs native env state equality)
  try {
    const invCompH = buildInvCompHeadersFixture_();
    const invRow = [
      "Acme Ltd",
      "Brand Refresh",
      1500,
      300,
      "INV-9001",
      new Date("2026-10-05T00:00:00Z"),
      "",
      "Sent",
      "GBP",
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      true,
    ];

    const confRow = [
      "Acme Ltd",
      "Brand Refresh",
      "Yes",
      "Yes",
      "Project",
      "INV-9001",
      1000,
      new Date("2026-10-01T00:00:00Z"),
      30,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ];

    const masterTabs = {
      KeyInfo: (() => {
        const g = Array.from({ length: 30 }, () => []);
        g[16] = []; g[16][1] = "GBP";
        g[27] = []; g[27][23] = "mock_client_6d";
        return g;
      })(),
      DataChgAlert: (() => {
        const g = Array.from({ length: 42 }, () => []);
        g[38] = []; g[38][3] = "None"; g[38][5] = 0; g[38][7] = "No";
        return g;
      })(),
      InvComp: [[], [], [], [], invCompH, invRow],
    };
    const clientTabs = { Confirmed: [canonicalConfHeaders, confRow] };

    const h1 = createInMemorySyncHarness_({ masterTabs, clientTabs });
    const h2 = createInMemorySyncHarness_({ masterTabs, clientTabs });
    const g1 = createMasterGasInstance(h1.env);
    const g2 = createMasterGasInstance(h2.env);
    const r1 = await g1.PushInvDetailsToConfirmed(true);
    const r2 = await g2.PushInvDetailsToConfirmed(true);
    const cDiff = compareGridsSampled_("Suite1:Confirmed", h1.clientSS.getSheetByName("Confirmed").valuesGrid, h2.clientSS.getSheetByName("Confirmed").valuesGrid);
    const ok = cDiff.length === 0 && Number(r1?.count || r1 || 0) === Number(r2?.count || r2 || 0) && Number(h1.clientSS.getSheetByName("Confirmed").valuesGrid[1][6]) === 1500;
    suites.push({ id: 1, name: "PushInvDetailsToConfirmed", matched: ok, diffs: cDiff });
  } catch (e) {
    suites.push({ id: 1, name: "PushInvDetailsToConfirmed", matched: false, diffs: [{ error: e.message }] });
  }

  // Suite 2: processPartPaidInvoices (part-paid split + full payment resolution)
  try {
    const confRow = [
      "Acme Ltd",
      "Campaign",
      "Yes",
      "Yes",
      "Project",
      "INV-200",
      1000,
      new Date("2026-10-01T00:00:00Z"),
      30,
      "Sent",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ];
    const invFromApp = [
      ["InvoiceID", "ContactName", "InvoiceNumber", "Reference", "Type", "Date", "DueDate", "Status", "AmountDue", "AmountPaid", "Total", "FullyPaidOnDate", "SentToContact", "SubTotal", "TotalTax", "CurrencyCode", "CurrencyRate"],
      ["id-200", "Acme Ltd", "INV-200", "Ref", "ACCREC", new Date("2026-10-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"), "AUTHORISED", 600, 600, 1200, "", true, 1000, 200, "GBP", 1],
    ];
    const masterTabs = {
      KeyInfo: (() => { const g = Array.from({ length: 30 }, () => []); g[27] = []; g[27][23] = "mock_client_6d"; return g; })(),
      DataChgAlert: Array.from({ length: 10 }, () => []),
      InvAppList: [["", "", "", "", "", "StripPre"]],
      InvFromApp: invFromApp,
    };
    const h1 = createInMemorySyncHarness_({ masterTabs, clientTabs: { Confirmed: [canonicalConfHeaders, confRow] } });
    const h2 = createInMemorySyncHarness_({ masterTabs, clientTabs: { Confirmed: [canonicalConfHeaders, confRow] } });
    const r1 = await createMasterGasInstance(h1.env).processPartPaidInvoices(h1.masterSS, h1.masterSS.getSheetByName("DataChgAlert"));
    const r2 = await createMasterGasInstance(h2.env).processPartPaidInvoices(h2.masterSS, h2.masterSS.getSheetByName("DataChgAlert"));
    const diffs = compareGridsSampled_("Suite2:Confirmed", h1.clientSS.getSheetByName("Confirmed").valuesGrid, h2.clientSS.getSheetByName("Confirmed").valuesGrid);
    const sRow = h2.clientSS.getSheetByName("Confirmed").valuesGrid[1];
    const hasSplit = String(sRow[9]).includes("Part-paid (received)") && String(sRow[14]).includes("Part-paid (balance)");
    suites.push({ id: 2, name: "processPartPaidInvoices", matched: diffs.length === 0 && hasSplit && r1.count === r2.count, diffs });
  } catch (e) {
    suites.push({ id: 2, name: "processPartPaidInvoices", matched: false, diffs: [{ error: e.message }] });
  }

  // Suite 3: updateStaleUnsentInvoices & updateOverdueInvoicesInConfirmed
  try {
    const now = new Date();
    const oldSend = new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - 3));
    const overdueSend = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const confHeaders = ["Client", "Job name", "Confirmed?", "Inv 1 ref", "Inv 1 amt", "Inv 1 send date", "Inv 1 days to pay", "Inv 1 status", "Inv 2 ref", "Inv 2 amt", "Inv 2 send date", "Inv 2 days to pay", "Inv 2 status"];
    const confRow1 = ["Acme Ltd", "Stale Job", "Yes", "", 500, oldSend, 0, "", "INV-DUE", 750, overdueSend, 15, "Sent"];
    const masterTabs = {
      KeyInfo: (() => { const g = Array.from({ length: 30 }, () => []); g[27] = []; g[27][23] = "mock_client_6d"; return g; })(),
      DataChgAlert: (() => {
        const g = Array.from({ length: 55 }, () => []);
        g[46] = []; g[46][1] = "Yes"; // B47 = Yes (overdue enabled)
        g[51] = []; g[51][1] = 30;    // B52 = 30
        return g;
      })(),
    };
    const h1 = createInMemorySyncHarness_({ masterTabs, clientTabs: { Confirmed: [confHeaders, confRow1] } });
    const h2 = createInMemorySyncHarness_({ masterTabs, clientTabs: { Confirmed: [confHeaders, confRow1] } });
    const g1 = createMasterGasInstance(h1.env);
    const g2 = createMasterGasInstance(h2.env);
    await g1.updateStaleUnsentInvoices(h1.masterSS, h1.masterSS.getSheetByName("DataChgAlert"));
    await g1.updateOverdueInvoicesInConfirmed(h1.masterSS, h1.masterSS.getSheetByName("DataChgAlert"));
    await g2.updateStaleUnsentInvoices(h2.masterSS, h2.masterSS.getSheetByName("DataChgAlert"));
    await g2.updateOverdueInvoicesInConfirmed(h2.masterSS, h2.masterSS.getSheetByName("DataChgAlert"));
    const diffs = compareGridsSampled_("Suite3:Confirmed", h1.clientSS.getSheetByName("Confirmed").valuesGrid, h2.clientSS.getSheetByName("Confirmed").valuesGrid);
    suites.push({ id: 3, name: "updateStaleAndOverdueInvoices", matched: diffs.length === 0, diffs });
  } catch (e) {
    suites.push({ id: 3, name: "updateStaleAndOverdueInvoices", matched: false, diffs: [{ error: e.message }] });
  }

  // Suite 4: PushExpDetails & pushOutgoingsWithPLAddsToClientSheet (empty/guarded clean path)
  try {
    const outHeaders = ["Category", "Include?", "Basis", "Mode", "Share", "01/10/2026", "01/11/2026"];
    const plComp = (() => {
      const g = Array.from({ length: 92 }, () => new Array(28).fill(""));
      g[0][19] = new Date("2026-10-01T00:00:00Z");
      g[86][19] = false;
      g[88][4] = "Software";
      return g;
    })();
    const masterTabs = {
      KeyInfo: (() => { const g = Array.from({ length: 30 }, () => []); g[27] = []; g[27][23] = "mock_client_6d"; return g; })(),
      DataChgAlert: (() => { const g = Array.from({ length: 115 }, () => []); g[110] = []; g[110][7] = "None"; g[110][9] = 0; return g; })(),
      PLComp: plComp,
    };
    const h1 = createInMemorySyncHarness_({ masterTabs, clientTabs: { Outgoings: [outHeaders, ["Software", "Yes", "Curr", "Curr", 1, 100, 100]], Confirmed: [["Client", "Job name"]] } });
    const h2 = createInMemorySyncHarness_({ masterTabs, clientTabs: { Outgoings: [outHeaders, ["Software", "Yes", "Curr", "Curr", 1, 100, 100]], Confirmed: [["Client", "Job name"]] } });
    const r1 = await createMasterGasInstance(h1.env).pushOutgoingsWithPLAddsToClientSheet(true);
    const r2 = await createMasterGasInstance(h2.env).pushOutgoingsWithPLAddsToClientSheet(true);
    const diffs = compareGridsSampled_("Suite4:Outgoings", h1.clientSS.getSheetByName("Outgoings").valuesGrid, h2.clientSS.getSheetByName("Outgoings").valuesGrid);
    suites.push({ id: 4, name: "pushOutgoingsWithPLAdds", matched: diffs.length === 0 && Boolean(r1?.success ?? true) === Boolean(r2?.success ?? true), diffs });
  } catch (e) {
    suites.push({ id: 4, name: "pushOutgoingsWithPLAdds", matched: false, diffs: [{ error: e.message }] });
  }

  // Suite 5: runNativeRevenueComparisonDirect vs GAS runRevenueComparison (Xero mock HTTP replay)
  try {
    const monthlyGrid = [
      [],
      [],
      [],
      [],
      [new Date("2026-10-01T00:00:00Z")],
      [],
      [],
      [],
      ["", "", "Acme Limited", "Website", "", 1500],
      ["", "", "Beta Co", "Audit", "", 500],
      [],
      [],
      [],
      [new Date("2026-11-01T00:00:00Z")],
    ];
    const xeroPayload = {
      Invoices: [
        {
          InvoiceID: "x-inv-1",
          InvoiceNumber: "INV-001",
          Contact: { Name: "Acme Ltd" },
          Status: "AUTHORISED",
          Total: 1800,
          AmountCredited: 0,
          CurrencyRate: 1,
          LineAmountTypes: "Exclusive",
          DateString: "2026-10-12T00:00:00",
          LineItems: [{ Description: "Website Sprint", LineAmount: 1400, TaxAmount: 280 }],
        },
      ],
    };
    const revCompSeed = [[null, null, new Date("2026-10-01T00:00:00Z")], [null, null, ""]];
    const keyInfoGrid = (() => {
      const g = Array.from({ length: 30 }, () => []);
      g[3] = []; g[3][16] = "Xero"; // Q4
      g[1] = []; g[1][23] = "tenant-6d"; // X2
      g[27] = []; g[27][23] = "mock_client_6d"; // X28
      return g;
    })();

    const hGas = createInMemorySyncHarness_({
      masterTabs: { KeyInfo: keyInfoGrid, RevComp: revCompSeed, RevFromApp: [] },
      clientTabs: { Monthly: monthlyGrid },
    });
    hGas.env.UrlFetchApp = {
      fetch: async (url) => {
        if (String(url).includes("/api/integrations/token")) {
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ success: true, accessToken: "tok-xero-6d" }) };
        }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(xeroPayload) };
      },
    };
    const gasRes = await createMasterGasInstance(hGas.env).runRevenueComparison(true, "2026-10");

    const nativeRes = await runNativeRevenueComparisonDirect(
      { clientId: "00000000-0000-0000-0000-00000000006d", clientName: "MockClient6D" },
      {
        customTargetMonth: "2026-10",
        persistToDb: false,
        keyInfoOverride: keyInfoGrid,
        monthlyGridOverride: monthlyGrid,
        revCompGridOverride: revCompSeed,
        tokenOverride: { accessToken: "tok-xero-6d", metadata: { tenantId: "tenant-6d" } },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(xeroPayload),
          json: async () => xeroPayload,
        }),
      }
    );

    const revAppDiffs = compareGridsSampled_("Suite5:RevFromApp", hGas.masterSS.getSheetByName("RevFromApp").valuesGrid, nativeRes.revFromAppGrid);
    const revCompDiffs = compareGridsSampled_("Suite5:RevComp", hGas.masterSS.getSheetByName("RevComp").valuesGrid, nativeRes.revCompGrid);
    const totMatch =
      Math.abs(gasRes.dashboardTotal - nativeRes.dashboardTotal) < 0.01 &&
      Math.abs(gasRes.accountingTotal - nativeRes.accountingTotal) < 0.01 &&
      Math.abs(gasRes.variance - nativeRes.variance) < 0.01;
    suites.push({
      id: 5,
      name: "runRevenueComparison",
      matched: totMatch && revAppDiffs.length === 0 && revCompDiffs.length === 0,
      diffs: [...revAppDiffs, ...revCompDiffs],
    });
  } catch (e) {
    suites.push({ id: 5, name: "runRevenueComparison", matched: false, diffs: [{ error: e.message }] });
  }

  // Suite 6: writeToAutoLog + VirtualSheet normalizeCellForStorage serial & display parity
  try {
    const hGas = createInMemorySyncHarness_({
      masterTabs: { AutoLog: [AUTOLOG_HEADERS] },
      clientTabs: {},
    });
    const gasInst = createMasterGasInstance(hGas.env);
    gasInst.writeToAutoLog("INVOICES", "<b>Test summary</b>", "<b>Details line</b>\nLine 2");
    const gasAutoGrid = hGas.masterSS.getSheetByName("AutoLog").valuesGrid;
    const rawSerialCell = gasAutoGrid[1]?.[0];
    const fakeCtx = { clientId: "mock-id", clientName: "MockClient6D" };
    const normalizedPayload = buildAutoLogRowPayload_(fakeCtx, [
      rawSerialCell,
      gasAutoGrid[1]?.[1],
      gasAutoGrid[1]?.[2],
      gasAutoGrid[1]?.[3],
    ]);
    const formulaNormalizedSummary = normalizeCellForStorage("master", "AutoLog", 1, 2, "<b>=SUM(A1)</b>".replace(/<\/?[^>]+(>|$)/g, ""), "USER_ENTERED", gasAutoGrid, {});
    const match =
      normalizedPayload.summary === "Test summary" &&
      normalizedPayload.details === "Details line\nLine 2" &&
      String(normalizedPayload.raw_timestamp_cell) === String(rawSerialCell) &&
      typeof formulaNormalizedSummary === "string";
    suites.push({ id: 6, name: "writeToAutoLogParity", matched: match, diffs: match ? [] : [{ error: "AutoLog normalization mismatch" }] });
  } catch (e) {
    suites.push({ id: 6, name: "writeToAutoLogParity", matched: false, diffs: [{ error: e.message }] });
  }

  const suitesPassed = suites.filter((s) => s.matched).length;
  return {
    checkedAt,
    suitesTotal: suites.length,
    suitesPassed,
    suitesFailed: suites.length - suitesPassed,
    suites,
  };
}
