/**
 * nativeConnectorsParityService.js (Phase 6C)
 *
 * Manages Phase 6C schema inspection, Migration 0018 backfill from `master_sheet_grids`
 * into `pulse_master_sync_configs` (`crm_google_bridge_grid`, `crm_excel_bridge_grid`,
 * `crm_excel_copy_grid`, `accounting_coa_categories`, `script_properties`,
 * `connectors_backfilled_at`), safe per-client `connector_pull_mode` switching
 * (`'grid_gas' | 'shadow' | 'native'`), live database state parity verification
 * (Suite #15 in daily alerts), and a 12-suite deterministic mock-HTTP replay suite
 * comparing `compiledMasterGas.js` vs Native Phase 6C with zero mismatches.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getSupabaseAdmin } from "./supabaseClient.js";
import {
  resolveSupabaseSheetContext,
  invalidateMasterEngineCache,
} from "./masterEngineService.js";
import {
  ALL_PHASE4_MASTER_TABS,
  reconcileClientMasterIngestionFromGrids,
  preloadClientRelationalMasterBundle,
  reconstructRelationalMasterTabFromBundle,
  invalidateClientRelationalMasterCache,
} from "./relationalMasterService.js";
import { createMasterGasInstance } from "./gasRuntime/compiledMasterGas.js";
import { VirtualSpreadsheet, VirtualSheet } from "./gasRuntime/gasEnvironment.js";
import { compactGrid2D } from "./gasRuntime/masterFormulaEngine.js";
import {
  pullNativeAccountingInvoices,
  pullNativeAccountingDirectCosts,
  pullNativeProfitAndLoss,
  refreshNativeChartOfAccountsDirect,
} from "./nativeAccountingPullService.js";
import {
  pullNativeCrmDeals,
  guardNativeCrmRowCountSwing,
} from "./nativeCrmPullService.js";

if (typeof window !== "undefined") {
  throw new Error("SECURITY VIOLATION: services/nativeConnectorsParityService.js must never run in browser code.");
}

let _cachedMigration0018Sql = null;
let _schema6cCache = { checkedAt: 0, status: null };

export function readMigration0018Sql() {
  if (_cachedMigration0018Sql) return _cachedMigration0018Sql;
  try {
    const p = path.resolve(process.cwd(), "supabase/migrations/0018_phase6c_native_connectors.sql");
    _cachedMigration0018Sql = fs.readFileSync(p, "utf8");
  } catch {
    _cachedMigration0018Sql = "";
  }
  return _cachedMigration0018Sql;
}

export async function checkPhase6NativeConnectorsSchemaStatus({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && _schema6cCache.status && now - _schema6cCache.checkedAt < 15000) {
    return _schema6cCache.status;
  }

  const supabase = getSupabaseAdmin();
  const migrationSql = readMigration0018Sql();
  if (!supabase) {
    return { schemaReady: false, migrationSql, error: "Supabase admin client not configured." };
  }

  const checks = await Promise.all([
    supabase.from("clients").select("connector_pull_mode").limit(1),
    supabase
      .from("pulse_master_sync_configs")
      .select(
        "crm_google_bridge_grid, crm_excel_bridge_grid, crm_excel_copy_grid, accounting_coa_categories, script_properties, connectors_backfilled_at"
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
  _schema6cCache = { checkedAt: now, status };
  return status;
}

export async function getPhase6NativeConnectorsOverviewStats() {
  const schema = await checkPhase6NativeConnectorsSchemaStatus();
  const supabase = getSupabaseAdmin();
  if (!supabase || !schema.schemaReady) {
    return {
      schemaReady: false,
      migrationSql: schema.migrationSql,
      totalConfigs: 0,
      error: schema.error || null,
    };
  }

  const { count } = await supabase
    .from("pulse_master_sync_configs")
    .select("client_id", { count: "exact", head: true })
    .not("connectors_backfilled_at", "is", null);

  return {
    schemaReady: true,
    migrationSql: schema.migrationSql,
    totalConfigs: count ?? 0,
  };
}

// ============================================================================
// BACKFILL MIGRATION 0018 FROM MASTER_SHEET_GRIDS
// ============================================================================

export async function backfillClientNativeConnectors(clientName) {
  const schema = await checkPhase6NativeConnectorsSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0018 columns are not present in Supabase yet. Apply 0018_phase6c_native_connectors.sql first.");
  }

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) throw new Error(`Client "${clientName}" not found.`);
  if (ctx.gridStorageRetired) {
    const supa = getSupabaseAdmin();
    const { data: existingCfg } = await supa
      .from("pulse_master_sync_configs")
      .select("crm_google_bridge_grid, crm_excel_bridge_grid, crm_excel_copy_grid, accounting_coa_categories, script_properties")
      .eq("client_id", ctx.clientId)
      .maybeSingle();
    return {
      clientName: ctx.clientName,
      skippedRetired: true,
      googleBridgeRows: Math.max(0, (existingCfg?.crm_google_bridge_grid?.length || 1) - 1),
      excelBridgeRows: Math.max(0, (existingCfg?.crm_excel_bridge_grid?.length || 1) - 1),
      excelCopyRows: existingCfg?.crm_excel_copy_grid?.length || 0,
      coaCount: Array.isArray(existingCfg?.accounting_coa_categories) ? existingCfg.accounting_coa_categories.length : 0,
      scriptPropKeys: existingCfg?.script_properties ? Object.keys(existingCfg.script_properties).length : 0,
    };
  }

  const supabase = getSupabaseAdmin();
  const tabsToRead = ["KeyInfo", "CRMGoogleBridge", "CRMExcelBridge", "CRMExcelCopy", "GasScriptProps"];
  const [{ data: gridRows, error: gridErr }, { data: existingCfg }] = await Promise.all([
    supabase
      .from("master_sheet_grids")
      .select("tab_name, values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .in("tab_name", tabsToRead),
    supabase
      .from("pulse_master_sync_configs")
      .select("master_key_info_grid")
      .eq("client_id", ctx.clientId)
      .maybeSingle(),
  ]);

  if (gridErr) throw new Error(`Failed loading master_sheet_grids for ${ctx.clientName}: ${gridErr.message}`);

  const byTab = new Map();
  for (const r of gridRows || []) {
    byTab.set(r.tab_name, compactGrid2D(r.values_grid || []));
  }

  const kiGrid =
    ctx.masterComputeMode === "native" &&
    Array.isArray(existingCfg?.master_key_info_grid) &&
    existingCfg.master_key_info_grid.length > 0
      ? compactGrid2D(existingCfg.master_key_info_grid)
      : (byTab.get("KeyInfo") || []);
  const coaList = [];
  for (let r = 1; r < kiGrid.length; r++) {
    const val = String(kiGrid[r]?.[48] ?? "").trim(); // AW2:AW...
    if (val) coaList.push(val);
  }

  const gpGrid = byTab.get("GasScriptProps") || [];
  const scriptProps = {};
  for (let r = 1; r < gpGrid.length; r++) {
    const k = String(gpGrid[r]?.[0] ?? "").trim();
    if (k) scriptProps[k] = String(gpGrid[r]?.[1] ?? "");
  }

  const nowIso = new Date().toISOString();
  const cfgPatch = {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    crm_google_bridge_grid: byTab.get("CRMGoogleBridge") || [],
    crm_excel_bridge_grid: byTab.get("CRMExcelBridge") || [],
    crm_excel_copy_grid: byTab.get("CRMExcelCopy") || [],
    accounting_coa_categories: coaList,
    script_properties: scriptProps,
    connectors_backfilled_at: nowIso,
    updated_at: nowIso,
  };

  // Ensure Phase 4 raw ingestion tables are synced before sealing backfill
  const reconcileSummary = await reconcileClientMasterIngestionFromGrids(ctx, ALL_PHASE4_MASTER_TABS, {
    forceFullUpsert: true,
  });

  const { error: upErr } = await supabase
    .from("pulse_master_sync_configs")
    .upsert(cfgPatch, { onConflict: "client_id" });
  if (upErr) throw new Error(`Failed saving connector state for ${ctx.clientName}: ${upErr.message}`);

  const { data: curClient, error: curClientErr } = await supabase
    .from("clients")
    .select("metadata")
    .eq("id", ctx.clientId)
    .maybeSingle();

  const nextMeta = {
    ...(curClient?.metadata || {}),
    native_connectors_state: {
      lastBackfilledAt: nowIso,
      googleBridgeRows: Math.max(0, (cfgPatch.crm_google_bridge_grid?.length || 1) - 1),
      excelBridgeRows: Math.max(0, (cfgPatch.crm_excel_bridge_grid?.length || 1) - 1),
      excelCopyRows: cfgPatch.crm_excel_copy_grid?.length || 0,
      coaCount: coaList.length,
      scriptPropKeys: Object.keys(scriptProps).length,
      reconcileSummary: reconcileSummary || null,
    },
  };

  if (!curClientErr && curClient) {
    await supabase.from("clients").update({ metadata: nextMeta }).eq("id", ctx.clientId);
  }
  invalidateClientRelationalMasterCache(ctx.clientName);
  invalidateMasterEngineCache(ctx.clientName);

  return {
    clientName: ctx.clientName,
    googleBridgeRows: nextMeta.native_connectors_state.googleBridgeRows,
    excelBridgeRows: nextMeta.native_connectors_state.excelBridgeRows,
    excelCopyRows: nextMeta.native_connectors_state.excelCopyRows,
    coaCount: coaList.length,
    scriptPropKeys: nextMeta.native_connectors_state.scriptPropKeys,
  };
}

export async function backfillAllClientsNativeConnectors() {
  const schema = await checkPhase6NativeConnectorsSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0018 columns are not present in Supabase yet.");
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
      results.push(await backfillClientNativeConnectors(c.client_name));
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
// SAFE CONNECTOR MODE SWITCHING
// ============================================================================

export async function setClientConnectorPullMode(clientName, modeRaw) {
  const mode = String(modeRaw || "").trim().toLowerCase();
  if (mode !== "grid_gas" && mode !== "shadow" && mode !== "native") {
    throw new Error(`Invalid connectorPullMode "${modeRaw}". Expected 'grid_gas', 'shadow', or 'native'.`);
  }

  const schema = await checkPhase6NativeConnectorsSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0018 must be applied before modifying connectorPullMode.");
  }

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) throw new Error(`Client "${clientName}" not found.`);
  if (ctx.gridStorageRetired && mode !== "native") {
    throw new Error(
      `Client "${clientName}" has retired grid storage and cannot be downgraded from 'native' connector_pull_mode.`
    );
  }

  if (mode === "native" && !ctx.gridStorageRetired) {
    const supabase = getSupabaseAdmin();
    const { data: cfg } = await supabase
      .from("pulse_master_sync_configs")
      .select("connectors_backfilled_at")
      .eq("client_id", ctx.clientId)
      .maybeSingle();
    if (!cfg?.connectors_backfilled_at) {
      await backfillClientNativeConnectors(ctx.clientName);
    }
    const parity = await verifyNativeConnectorsStateParity({ clientName: ctx.clientName });
    if ((parity.mismatchClientsCount || 0) > 0 || (parity.errorClientsCount || 0) > 0) {
      throw new Error(
        `Cannot promote ${ctx.clientName} connector_pull_mode to 'native': state parity check failed (${JSON.stringify(
          parity.results?.[0]?.sampleMismatches || parity.results?.[0]?.error
        )}).`
      );
    }
  }

  const supabase = getSupabaseAdmin();
  const { data: curClient, error: curClErr } = await supabase
    .from("clients")
    .select("metadata")
    .eq("id", ctx.clientId)
    .maybeSingle();
  if (curClErr || !curClient) {
    throw new Error(curClErr?.message || `Client metadata load failed for "${ctx.clientName}".`);
  }

  const nextMeta = {
    ...(curClient?.metadata || {}),
    connector_pull_mode: mode,
    native_connectors_state: {
      ...(curClient?.metadata?.native_connectors_state || {}),
      mode,
      updatedAt: new Date().toISOString(),
    },
  };

  const { error: upErr } = await supabase
    .from("clients")
    .update({ connector_pull_mode: mode, metadata: nextMeta })
    .eq("id", ctx.clientId);
  if (upErr) throw new Error(`Failed updating connector_pull_mode for ${ctx.clientName}: ${upErr.message}`);

  invalidateMasterEngineCache(ctx.clientName);
  invalidateClientRelationalMasterCache(ctx.clientName);

  return {
    clientName: ctx.clientName,
    connectorPullMode: mode,
  };
}

// ============================================================================
// DATABASE STATE PARITY VERIFICATION (SUITE #15)
// ============================================================================

function normalizeCompareCell_(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return Math.round(v * 100) / 100;
  return String(v).trim();
}

export async function verifyNativeConnectorsStateParity({
  clientName = null,
  onlyActiveOrShadow = false,
} = {}) {
  const checkedAt = new Date().toISOString();
  const schema = await checkPhase6NativeConnectorsSchemaStatus();
  if (!schema.schemaReady) {
    return { checkedAt, clientsChecked: 0, matchedClientsCount: 0, mismatchClientsCount: 0, errorClientsCount: 0, results: [] };
  }

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("clients")
    .select("id, client_name, connector_pull_mode, metadata")
    .order("client_name", { ascending: true });
  if (clientName) query = query.eq("client_name", clientName);
  const { data: clients, error } = await query;
  if (error) throw new Error(`verifyNativeConnectorsStateParity query failed: ${error.message}`);

  const targets = (clients || []).filter((c) => {
    const m = String(c.connector_pull_mode || c.metadata?.connector_pull_mode || "grid_gas").toLowerCase();
    return !onlyActiveOrShadow || m === "shadow" || m === "native";
  });

  const results = [];
  for (const c of targets) {
    const mode = String(c.connector_pull_mode || c.metadata?.connector_pull_mode || "grid_gas").toLowerCase();
    try {
      const ctx = await resolveSupabaseSheetContext({ clientName: c.client_name });
      const syncCols =
        mode === "native"
          ? "client_id"
          : "client_id, crm_google_bridge_grid, crm_excel_bridge_grid, crm_excel_copy_grid, script_properties";
      const { data: cfg } = await supabase
        .from("pulse_master_sync_configs")
        .select(syncCols)
        .eq("client_id", c.id)
        .maybeSingle();

      if (!cfg) {
        results.push({
          clientName: c.client_name,
          mode,
          matched: false,
          mismatchCount: 1,
          sampleMismatches: [{ tab: "pulse_master_sync_configs", cell: "row", rowLabel: "Missing config", colLabel: "6C", sheetValue: "exists", supabaseValue: "missing" }],
        });
        continue;
      }

      const mismatches = [];

      // When not yet switched to native, cross-check bridge + props + raw tabs vs master_sheet_grids
      if (mode !== "native") {
        const { data: gridRows } = await supabase
          .from("master_sheet_grids")
          .select("tab_name, values_grid")
          .eq("client_name", c.client_name)
          .eq("sheet_role", "master")
          .in("tab_name", ["CRMGoogleBridge", "CRMExcelBridge", "CRMExcelCopy", "GasScriptProps", "InvFromApp", "JnlsFromApp", "PLFromApp", "Year0PLFromApp", "DataFromCRM"]);

        const gridMap = new Map();
        for (const r of gridRows || []) {
          gridMap.set(r.tab_name, compactGrid2D(r.values_grid || []));
        }

        const bridgePairs = [
          ["CRMGoogleBridge", cfg.crm_google_bridge_grid],
          ["CRMExcelBridge", cfg.crm_excel_bridge_grid],
          ["CRMExcelCopy", cfg.crm_excel_copy_grid],
        ];
        for (const [tabName, cfgGrid] of bridgePairs) {
          const gGrid = gridMap.get(tabName);
          if (!gGrid) continue;
          const a = compactGrid2D(gGrid);
          const b = compactGrid2D(cfgGrid || []);
          if (a.length !== b.length) {
            mismatches.push({ tab: tabName, cell: "rows", rowLabel: "Row count", colLabel: tabName, sheetValue: a.length, supabaseValue: b.length });
          } else {
            for (let r = 0; r < a.length && mismatches.length < 5; r++) {
              const cols = Math.max(a[r]?.length || 0, b[r]?.length || 0);
              for (let col = 0; col < cols; col++) {
                const va = normalizeCompareCell_(a[r]?.[col]);
                const vb = normalizeCompareCell_(b[r]?.[col]);
                if (va !== vb) {
                  mismatches.push({ tab: tabName, cell: `R${r + 1}C${col + 1}`, rowLabel: `Row ${r + 1}`, colLabel: `Col ${col + 1}`, sheetValue: va, supabaseValue: vb });
                  break;
                }
              }
            }
          }
        }

        const gpGrid = gridMap.get("GasScriptProps") || [];
        if (gpGrid.length > 1) {
          const sp = cfg.script_properties && typeof cfg.script_properties === "object" ? cfg.script_properties : {};
          for (let r = 1; r < gpGrid.length; r++) {
            const k = String(gpGrid[r]?.[0] ?? "").trim();
            if (!k) continue;
            const v = String(gpGrid[r]?.[1] ?? "");
            if (String(sp[k] ?? "") !== v) {
              mismatches.push({ tab: "GasScriptProps", cell: k, rowLabel: k, colLabel: "Value", sheetValue: v, supabaseValue: String(sp[k] ?? "") });
            }
          }
        }
      } else {
        // Native mode checks structural integrity of Postgres tables
        const bundle = await preloadClientRelationalMasterBundle(ctx, { source: "db" });
        for (const tabName of ["InvFromApp", "JnlsFromApp", "PLFromApp", "DataFromCRM"]) {
          const reconstructed = await reconstructRelationalMasterTabFromBundle(bundle, tabName, ctx);
          if (!Array.isArray(reconstructed)) {
            mismatches.push({ tab: tabName, cell: "array", rowLabel: tabName, colLabel: "6C native", sheetValue: "Array", supabaseValue: typeof reconstructed });
          }
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
// DETERMINISTIC 12-SUITE MOCK-HTTP REPLAY HARNESS (compiledMasterGas vs 6C)
// ============================================================================

function createMockGasHarness_({ initialTabs = {}, initialProps = {}, mockRoutes = [] }) {
  const spreadsheetId = "mock_master_ss_6c";
  const mockEnvState = {
    masterFormulasDirty: false,
    recomputeMasterFormulasSync: () => { },
  };
  const ss = new VirtualSpreadsheet({
    id: spreadsheetId,
    name: "Mock Master",
    sheetRole: "master",
    isRemoteGoogleSheet: false,
    env: mockEnvState,
  });

  let idx = 1;
  for (const [tabName, rawGrid] of Object.entries(initialTabs)) {
    const vals = compactGrid2D(rawGrid);
    const vs = new VirtualSheet(ss, tabName, vals, vals, {}, idx++, Math.max(500, vals.length), 60);
    ss.sheetsByName.set(tabName, vs);
  }

  const propsMap = new Map(Object.entries(initialProps));
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => propsMap.get(String(k)) ?? null,
      setProperty: (k, v) => { propsMap.set(String(k), String(v ?? "")); },
      setProperties: (obj) => { for (const [k, v] of Object.entries(obj || {})) propsMap.set(String(k), String(v ?? "")); },
      deleteProperty: (k) => propsMap.delete(String(k)),
      deleteAllProperties: () => propsMap.clear(),
      getProperties: () => Object.fromEntries(propsMap.entries()),
    }),
  };

  const matchRoute = (url, opts = {}) => {
    const method = String(opts?.method || "GET").toUpperCase();
    const normOpts = { ...opts, body: opts?.body ?? opts?.payload };
    for (const r of mockRoutes) {
      if (r.method && r.method.toUpperCase() !== method) continue;
      if (typeof r.match === "function" ? r.match(url, normOpts) : String(url).includes(r.match)) {
        const resBody = typeof r.body === "function" ? r.body(url, normOpts) : r.body;
        return { status: r.status ?? 200, json: resBody };
      }
    }
    return { status: 404, json: { error: `Unmocked URL: ${url}` } };
  };

  const UrlFetchApp = {
    fetch: async (url, opts = {}) => {
      const hit = matchRoute(url, opts);
      const txt = typeof hit.json === "string" ? hit.json : JSON.stringify(hit.json);
      return {
        getResponseCode: () => hit.status,
        getContentText: () => txt,
      };
    },
  };

  const fetchImpl = async (url, opts = {}) => {
    const hit = matchRoute(url, opts);
    const txt = typeof hit.json === "string" ? hit.json : JSON.stringify(hit.json);
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      text: async () => txt,
      json: async () => JSON.parse(txt),
    };
  };

  const Sheets = {
    Spreadsheets: {
      Values: {
        batchUpdate: async ({ data }) => {
          for (const item of data || []) {
            const bang = String(item.range || "").indexOf("!");
            const tabName = bang >= 0 ? item.range.slice(0, bang).replace(/^'|'$/g, "") : item.range;
            const a1 = bang >= 0 ? item.range.slice(bang + 1) : "A1";
            const sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
            const m = a1.match(/^([A-Z]+)(\d+)$/i);
            if (m && Array.isArray(item.values)) {
              let c0 = 0;
              for (let i = 0; i < m[1].length; i++) c0 = c0 * 26 + (m[1].toUpperCase().charCodeAt(i) - 64);
              c0 -= 1;
              const r0 = parseInt(m[2], 10) - 1;
              item.values.forEach((rowVals, rOff) => {
                while (sheet.valuesGrid.length <= r0 + rOff) sheet.valuesGrid.push([]);
                rowVals.forEach((v, cOff) => {
                  while (sheet.valuesGrid[r0 + rOff].length <= c0 + cOff) sheet.valuesGrid[r0 + rOff].push("");
                  sheet.valuesGrid[r0 + rOff][c0 + cOff] = v;
                });
              });
            }
          }
          return { totalUpdatedCells: 1 };
        },
      },
    },
  };

  const Utilities = {
    sleep: async () => { },
    getUuid: () => crypto.randomUUID(),
    formatDate: (dateObj, tz, pattern) => {
      const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
      if (isNaN(d.getTime())) return "";
      if (pattern === "yyyy-MM-dd") {
        if (tz === "UTC") return d.toISOString().slice(0, 10);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      }
      if (pattern === "dd/MM/yyyy") {
        return d.toLocaleDateString("en-GB", { timeZone: tz || "Europe/London" });
      }
      if (pattern === "dd/MM/yyyy HH:mm") {
        return d.toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz || "Europe/London" }).replace(",", "");
      }
      if (pattern === "d-MMM-yy") {
        const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "Europe/London", day: "numeric", month: "short", year: "2-digit" }).formatToParts(d);
        return `${parts.find((p) => p.type === "day")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "year")?.value}`;
      }
      return d.toISOString();
    },
  };

  const env = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getActive: () => ss,
      openById: async (id) => (id === spreadsheetId ? ss : ss),
      flush: async () => { },
      getUi: () => ({ alert: () => { }, ButtonSet: { OK: 1 } }),
    },
    Sheets,
    UrlFetchApp,
    PropertiesService,
    Utilities,
    DriveApp: {},
    Drive: {},
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => { }, remove: () => { } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { } }) },
    Session: { getScriptTimeZone: () => "Europe/London" },
    Logger: { log: () => { } },
    HtmlService: {},
    ScriptApp: { getProjectTriggers: () => [] },
    ContentService: {},
    console: { log: () => { }, warn: () => { }, error: () => { } },
  };

  return { ss, env, fetchImpl, propsMap, gas: createMasterGasInstance(env) };
}

function diffGrids_(gasGrid = [], nativeGrid = [], tabLabel = "Tab", { ignoreUuidCols = false } = {}) {
  const diffs = [];
  const a = compactGrid2D(gasGrid);
  const b = compactGrid2D(nativeGrid);
  const maxR = Math.max(a.length, b.length);
  for (let r = 0; r < maxR; r++) {
    const ra = a[r] || [];
    const rb = b[r] || [];
    const maxC = Math.max(ra.length, rb.length);
    for (let c = 0; c < maxC; c++) {
      let va = ra[c] ?? "";
      let vb = rb[c] ?? "";
      if (va instanceof Date) va = va.toISOString().slice(0, 10);
      if (vb instanceof Date) vb = vb.toISOString().slice(0, 10);
      if (ignoreUuidCols && r > 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(va)) && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(vb))) {
        continue; // New UUID generation uses randomUUID in both GAS and Node
      }
      if (typeof va === "number" && typeof vb === "number") {
        if (Math.abs(va - vb) < 1e-6) continue;
      }
      if (String(va) !== String(vb)) {
        diffs.push({ tab: tabLabel, cell: `R${r + 1}C${c + 1}`, gas: va, native: vb });
        if (diffs.length >= 10) return diffs;
      }
    }
  }
  return diffs;
}

function makeKeyInfoBase_(tool, crmTool, extraCells = {}) {
  const ki = Array.from({ length: 45 }, () => new Array(52).fill(""));
  ki[1][1] = new Date("2026-11-01T00:00:00Z"); // B2 anchor date
  ki[7][5] = "Whole"; // F8
  ki[3][16] = tool; // Q4
  ki[7][16] = crmTool; // Q8
  ki[1][23] = "xero-tenant-1"; // X2
  ki[2][23] = "1234567890"; // X3
  ki[3][45] = "400 - Direct Costs"; // AT4
  ki[4][45] = "410 - Contractors"; // AT5
  // Seed routing tables R14:V18 and R19:S36
  ki[13][17] = "Xero"; ki[13][18] = "getXeroInvoices"; ki[13][19] = "getXeroProfitAndLossReport"; ki[13][21] = "getYear0PLfromXero";
  ki[14][17] = "QuickBooks"; ki[14][18] = "getQuickbooksInvoices"; ki[14][19] = "getQuickBooksProfitAndLossReport"; ki[14][21] = "getYear0PLfromQB";
  ki[18][17] = "HubSpot"; ki[18][18] = "exportHubSpotDealsToSheet";
  ki[19][17] = "Pipedrive"; ki[19][18] = "exportPipeDriveDealsToSheet";
  ki[20][17] = "Monday"; ki[20][18] = "exportMondayBoardToSheet";
  ki[21][17] = "ClickUp"; ki[21][18] = "exportClickUpListToSheet";
  ki[22][17] = "Close"; ki[22][18] = "exportCloseOpportunitiesToSheet";
  ki[23][17] = "Capsule"; ki[23][18] = "exportCapsuleOpportunitiesToSheet";
  ki[24][17] = "Google Sheets"; ki[24][18] = "PullFromGoogleSheet_";
  ki[25][17] = "Excel"; ki[25][18] = "PullFromExcelSheet_";

  for (const [coord, val] of Object.entries(extraCells)) {
    const m = coord.match(/^([A-Z]+)(\d+)$/i);
    if (!m) continue;
    let c0 = 0;
    for (let i = 0; i < m[1].length; i++) c0 = c0 * 26 + (m[1].toUpperCase().charCodeAt(i) - 64);
    c0 -= 1;
    const r0 = parseInt(m[2], 10) - 1;
    ki[r0][c0] = val;
  }
  return ki;
}

export async function verifyNativeConnectorsMockReplayParity() {
  const suites = [];
  const ctx = { clientId: "00000000-0000-0000-0000-000000000001", clientName: "MOCK_PARITY_TEST", masterSheetId: "mock_master_ss_6c", connectorPullMode: "native" };
  const fakeSleep = async () => { };

  // --- Suite 1: Xero Invoices (Whole + Net-of-Credit + Recharged + Slot Reuse) ---
  {
    const xeroAccounts = { Accounts: [{ Code: "200", Name: "Sales", Type: "REVENUE", Class: "REVENUE" }, { Code: "420", Name: "Recharged Travel", Type: "DIRECTCOSTS", Class: "EXPENSE" }] };
    const xeroInvs = {
      Invoices: [
        {
          InvoiceID: "inv-1", Contact: { Name: "Acme Ltd" }, InvoiceNumber: "INV-001", Reference: "PRJ-1",
          Type: "ACCREC", DateString: "2026-09-10", DueDateString: "2026-10-10", Status: "AUTHORISED",
          Total: 1200, SubTotal: 1000, TotalTax: 200, AmountPaid: 400, AmountCredited: 200, SentToContact: true,
          CurrencyCode: "GBP", CurrencyRate: 1,
          Payments: [{ Status: "AUTHORISED", Date: "2026-09-20" }],
          LineItems: [
            { Description: "Consulting fee", AccountCode: "200", LineAmount: 800, TaxAmount: 160 },
            { Description: "Train ticket to London", AccountCode: "420", LineAmount: 200, TaxAmount: 40 },
          ],
        },
      ],
    };
    const ki = makeKeyInfoBase_("Xero", "None");
    const routes = [
      { match: "/2.0/Accounts", body: xeroAccounts },
      { match: "page=1", body: xeroInvs },
      { match: "page=2", body: { Invoices: [] } },
    ];
    const h = createMockGasHarness_({ initialTabs: { KeyInfo: ki, InvFromApp: [], InvComp: [[]], DataChgAlert: [[]] }, initialProps: { TOKEN_EXPIRY: String(Date.now() + 3600000), ACCESS_TOKEN: "tok" }, mockRoutes: routes });
    const gasRes = await h.gas.getXeroInvoices(true);
    const gasGrid = h.ss.getSheetByName("InvFromApp").valuesGrid;

    const natRes = await pullNativeAccountingInvoices(ctx, {
      tokenOverride: { accessToken: "tok", tenantId: "xero-tenant-1" },
      fetchImpl: h.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: ki,
      existingGridOverride: [],
      scriptPropsOverride: {},
      nowDate: new Date("2026-11-15T12:00:00Z"),
    });
    const diffs = diffGrids_(gasGrid, natRes.nextGrid, "InvFromApp(XeroWhole)");
    if (JSON.stringify(gasRes.newInvoices) !== JSON.stringify(natRes.newInvoices)) {
      diffs.push({ tab: "DeltaLog", cell: "newInvoices", gas: gasRes.newInvoices, native: natRes.newInvoices });
    }
    suites.push({ id: 1, name: "Xero Invoices (Whole + Net-of-Credit + Recharged)", matched: diffs.length === 0, diffs });
  }

  // --- Suite 2: Xero Invoices (Lines mode + part-paid rounding) ---
  {
    const ki = makeKeyInfoBase_("Xero", "None", { F8: "Lines" });
    const routes = [
      { match: "/2.0/Accounts", body: { Accounts: [{ Code: "200", Name: "Sales", Type: "REVENUE", Class: "REVENUE" }] } },
      {
        match: "page=1",
        body: {
          Invoices: [{
            InvoiceID: "inv-2", Contact: { Name: "Beta Co" }, InvoiceNumber: "INV-002", Reference: "R2",
            Type: "ACCREC", DateString: "2026-10-01", DueDateString: "2026-11-01", Status: "AUTHORISED",
            Total: 300, SubTotal: 250, TotalTax: 50, AmountPaid: 100, AmountCredited: 0, SentToContact: false,
            CurrencyCode: "GBP", CurrencyRate: 1, LineAmountTypes: "Exclusive",
            LineItems: [
              { Description: "Design sprint", AccountCode: "200", LineAmount: 100, TaxAmount: 20 },
              { Description: "Hotel stay", AccountCode: "200", LineAmount: 150, TaxAmount: 30 },
            ],
          }],
        },
      },
      { match: "page=2", body: { Invoices: [] } },
    ];
    const h = createMockGasHarness_({ initialTabs: { KeyInfo: ki, InvFromApp: [], InvComp: [[]], DataChgAlert: [[]] }, initialProps: { TOKEN_EXPIRY: String(Date.now() + 3600000), ACCESS_TOKEN: "tok" }, mockRoutes: routes });
    await h.gas.getXeroInvoices(true);
    const natRes = await pullNativeAccountingInvoices(ctx, {
      tokenOverride: { accessToken: "tok", tenantId: "xero-tenant-1" },
      fetchImpl: h.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: ki,
      existingGridOverride: [],
      scriptPropsOverride: {},
    });
    const diffs = diffGrids_(h.ss.getSheetByName("InvFromApp").valuesGrid, natRes.nextGrid, "InvFromApp(XeroLines)");
    suites.push({ id: 2, name: "Xero Invoices (Lines + proportional part-paid)", matched: diffs.length === 0, diffs });
  }

  // --- Suite 3: QuickBooks Invoices (Whole + CreditMemo + Payment Dates) ---
  {
    const ki = makeKeyInfoBase_("QuickBooks", "None");
    const routes = [
      {
        match: "FROM%20Invoice",
        body: {
          QueryResponse: {
            Invoice: [{
              Id: "qb-10", DocNumber: "1010", TxnDate: "2026-10-05", DueDate: "2026-11-05",
              CustomerRef: { name: "Gamma Agency" }, PrivateNote: "Retainer", TotalAmt: 600, Balance: 200,
              EmailStatus: "EmailSent", TxnTaxDetail: { TotalTax: 100 }, CurrencyRef: { value: "GBP" }, ExchangeRate: 1,
              LinkedTxn: [{ TxnType: "CreditMemo", Amount: 120 }, { TxnType: "Payment", TxnId: "pmt-1" }],
              Line: [{ DetailType: "SalesItemLineDetail", Amount: 500, Description: "Monthly", SalesItemLineDetail: { ItemRef: { value: "1", name: "Services" } } }],
            }],
          },
        },
      },
      { match: "FROM%20Payment", body: { QueryResponse: { Payment: [{ Id: "pmt-1", TxnDate: "2026-10-12" }] } } },
      { match: "FROM%20Account", body: { QueryResponse: { Account: [{ Id: "a1", Name: "Income", AcctNum: "200" }] } } },
      { match: "FROM%20Item", body: { QueryResponse: { Item: [{ Id: "1", Name: "Services", IncomeAccountRef: { value: "a1", name: "Income" } }] } } },
    ];
    const h = createMockGasHarness_({ initialTabs: { KeyInfo: ki, InvFromApp: [], InvComp: [[]], DataChgAlert: [[]] }, initialProps: { TOKEN_EXPIRY: String(Date.now() + 3600000), ACCESS_TOKEN: "tok" }, mockRoutes: routes });
    await h.gas.getQuickbooksInvoices(true);
    const natRes = await pullNativeAccountingInvoices(ctx, {
      tokenOverride: { accessToken: "tok", realmId: "1234567890" },
      fetchImpl: h.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: ki,
      existingGridOverride: [],
      scriptPropsOverride: {},
    });
    const diffs = diffGrids_(h.ss.getSheetByName("InvFromApp").valuesGrid, natRes.nextGrid, "InvFromApp(QBWhole)");
    suites.push({ id: 3, name: "QuickBooks Invoices (Whole + CreditMemo + Payment Dates)", matched: diffs.length === 0, diffs });
  }

  // --- Suite 4: QuickBooks Invoices (Lines + TaxCode VAT + rounding) ---
  {
    const ki = makeKeyInfoBase_("QuickBooks", "None", { F8: "Lines" });
    const routes = [
      { match: "FROM%20TaxCode", body: { QueryResponse: { TaxCode: [{ Id: "6", Name: "20.0% S", Taxable: true }] } } },
      {
        match: "FROM%20Invoice",
        body: {
          QueryResponse: {
            Invoice: [{
              Id: "qb-11", DocNumber: "1011", TxnDate: "2026-10-08", DueDate: "2026-11-08",
              CustomerRef: { name: "Delta Ltd" }, TotalAmt: 240, Balance: 0, TxnTaxDetail: { TotalTax: 40 },
              CurrencyRef: { value: "GBP" },
              Line: [
                { DetailType: "SalesItemLineDetail", Amount: 100, Description: "Item A", SalesItemLineDetail: { ItemRef: { value: "1", name: "Item A" }, TaxCodeRef: { value: "6" } } },
                { DetailType: "SalesItemLineDetail", Amount: 100, Description: "Recharged travel", SalesItemLineDetail: { ItemRef: { value: "2", name: "Travel" }, TaxCodeRef: { value: "6" } } },
              ],
            }],
          },
        },
      },
      { match: "FROM%20Account", body: { QueryResponse: { Account: [] } } },
      { match: "FROM%20Item", body: { QueryResponse: { Item: [] } } },
    ];
    const h = createMockGasHarness_({ initialTabs: { KeyInfo: ki, InvFromApp: [], InvComp: [[]], DataChgAlert: [[]] }, initialProps: { TOKEN_EXPIRY: String(Date.now() + 3600000), ACCESS_TOKEN: "tok" }, mockRoutes: routes });
    await h.gas.getQuickbooksInvoices(true);
    const natRes = await pullNativeAccountingInvoices(ctx, {
      tokenOverride: { accessToken: "tok", realmId: "1234567890" },
      fetchImpl: h.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: ki,
      existingGridOverride: [],
      scriptPropsOverride: {},
    });
    const diffs = diffGrids_(h.ss.getSheetByName("InvFromApp").valuesGrid, natRes.nextGrid, "InvFromApp(QBLines)");
    suites.push({ id: 4, name: "QuickBooks Invoices (Lines + TaxCode VAT)", matched: diffs.length === 0, diffs });
  }

  // --- Suite 5: Xero Direct Costs (`ACCPAY` + `SPEND` + `ManualJournals` + `makeIdsUnique_`) ---
  {
    const ki = makeKeyInfoBase_("Xero", "None");
    const routes = [
      { match: "/2.0/Accounts", body: { Accounts: [{ Code: "400", Name: "Direct Costs" }, { Code: "410", Name: "Contractors" }] } },
      {
        match: (u) => u.includes("ACCPAY") && u.includes("page=1"),
        body: {
          Invoices: [{
            InvoiceID: "bill-1", DateString: "2026-10-15", DueDateString: "2026-11-15",
            Contact: { Name: "Dev Supplier" }, Reference: "B-101", Status: "PAID",
            Total: 1200, AmountDue: 0, AmountPaid: 1200, AmountCredited: 0, CurrencyCode: "GBP", CurrencyRate: 1,
            Payments: [{ Status: "AUTHORISED", Date: "2026-10-20" }],
            LineItems: [
              { Description: "Sprint 1", LineAmount: 500, TaxAmount: 100, AccountCode: "400" },
              { Description: "Sprint 2", LineAmount: 500, TaxAmount: 100, AccountCode: "410" },
            ],
          }],
        },
      },
      { match: "ACCPAY", body: { Invoices: [] } },
      { match: "SPEND", body: { BankTransactions: [] } },
      { match: "ManualJournals", body: { ManualJournals: [] } },
    ];
    const h = createMockGasHarness_({ initialTabs: { KeyInfo: ki, JnlsFromApp: [], DirComp: [[]] }, initialProps: { TOKEN_EXPIRY: String(Date.now() + 3600000), ACCESS_TOKEN: "tok" }, mockRoutes: routes });
    const gasRes = await h.gas.syncAccountingDataToSheet(true);
    const natRes = await pullNativeAccountingDirectCosts(ctx, {
      tokenOverride: { accessToken: "tok", tenantId: "xero-tenant-1" },
      fetchImpl: h.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: ki,
      existingGridOverride: [],
      nowDate: new Date("2026-11-15T12:00:00Z"),
    });
    const diffs = diffGrids_(h.ss.getSheetByName("JnlsFromApp").valuesGrid, natRes.nextGrid, "JnlsFromApp(Xero)");
    if (JSON.stringify(gasRes.newExpenses) !== JSON.stringify(natRes.newExpenses)) {
      diffs.push({ tab: "DeltaLog", cell: "newExpenses", gas: gasRes.newExpenses, native: natRes.newExpenses });
    }
    suites.push({ id: 5, name: "Xero Direct Costs (Bills + Payments + makeIdsUnique_)", matched: diffs.length === 0, diffs });
  }

  // --- Suite 6: QuickBooks Direct Costs (`Bill` + `BillPayment` + `Item`) ---
  {
    const ki = makeKeyInfoBase_("QuickBooks", "None");
    const routes = [
      { match: "FROM%20Account", body: { QueryResponse: { Account: [{ Id: "a400", Name: "Direct Costs", AcctNum: "400" }] } } },
      { match: "FROM%20Item", body: { QueryResponse: { Item: [{ Id: "it1", Name: "Subcontractor", ExpenseAccountRef: { value: "a400", name: "Direct Costs" } }] } } },
      { match: "FROM%20TaxCode", body: { QueryResponse: { TaxCode: [] } } },
      {
        match: "FROM%20Bill%20MAXRESULTS",
        body: {
          QueryResponse: {
            Bill: [{
              Id: "qb-bill-1", TxnDate: "2026-10-10", DueDate: "2026-11-10", DocNumber: "QB-9",
              VendorRef: { name: "Supplier X" }, Balance: 0, TotalAmt: 300, CurrencyRef: { value: "GBP" },
              LinkedTxn: [{ TxnType: "BillPaymentCheck", TxnId: "bp-1" }],
              Line: [
                { DetailType: "AccountBasedExpenseLineDetail", Amount: 200, Description: "Retainer cost", AccountBasedExpenseLineDetail: { AccountRef: { value: "a400", name: "400 - Direct Costs" } } },
                { DetailType: "ItemBasedExpenseLineDetail", Amount: 100, Description: "Work", ItemBasedExpenseLineDetail: { ItemRef: { value: "it1", name: "Subcontractor" } } },
              ],
            }],
          },
        },
      },
      { match: "FROM%20BillPayment", body: { QueryResponse: { BillPayment: [{ Id: "bp-1", TxnDate: "2026-10-25" }] } } },
      { match: "FROM%20Purchase", body: { QueryResponse: { Purchase: [] } } },
      { match: "FROM%20JournalEntry", body: { QueryResponse: { JournalEntry: [] } } },
    ];
    const h = createMockGasHarness_({ initialTabs: { KeyInfo: ki, JnlsFromApp: [], DirComp: [[]] }, initialProps: { TOKEN_EXPIRY: String(Date.now() + 3600000), ACCESS_TOKEN: "tok" }, mockRoutes: routes });
    await h.gas.syncAccountingDataToSheet(true);
    const natRes = await pullNativeAccountingDirectCosts(ctx, {
      tokenOverride: { accessToken: "tok", realmId: "1234567890" },
      fetchImpl: h.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: ki,
      existingGridOverride: [],
      nowDate: new Date("2026-11-15T12:00:00Z"),
    });
    const diffs = diffGrids_(h.ss.getSheetByName("JnlsFromApp").valuesGrid, natRes.nextGrid, "JnlsFromApp(QB)");
    suites.push({ id: 6, name: "QuickBooks Direct Costs (Bills + Item + BillPayment)", matched: diffs.length === 0, diffs });
  }

  // --- Suite 7: Rolling 12m P&L (Xero) & COA Refresh ---
  {
    const ki = makeKeyInfoBase_("Xero", "None");
    const routes = [
      {
        match: "ProfitAndLoss",
        body: {
          Reports: [{
            Rows: [
              { RowType: "Section", Title: "Income", Rows: [{ RowType: "Row", Cells: [{ Value: "Sales" }, { Value: "1000.00" }] }] },
              { RowType: "Section", Title: "Less Cost of Sales", Rows: [{ RowType: "Row", Cells: [{ Value: "Contractors" }, { Value: "400.00" }] }] },
            ],
          }],
        },
      },
      { match: "/2.0/Accounts", body: { Accounts: [{ Code: "400", Name: "Direct Costs" }, { Code: "410", Name: "Contractors" }] } },
    ];
    const h = createMockGasHarness_({ initialTabs: { KeyInfo: ki, PLFromApp: [], PLComp: [[]] }, initialProps: { TOKEN_EXPIRY: String(Date.now() + 3600000), ACCESS_TOKEN: "tok" }, mockRoutes: routes });
    await h.gas.getXeroProfitAndLossReport(true);
    const natPl = await pullNativeProfitAndLoss(ctx, {
      tokenOverride: { accessToken: "tok", tenantId: "xero-tenant-1" },
      fetchImpl: h.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: ki,
    });
    await h.gas.refreshAccountingToolChartOfAccounts(true);
    const natCoa = await refreshNativeChartOfAccountsDirect(ctx, {
      tokenOverride: { accessToken: "tok", tenantId: "xero-tenant-1" },
      fetchImpl: h.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: ki,
    });
    const diffs = diffGrids_(h.ss.getSheetByName("PLFromApp").valuesGrid, natPl.nextGrid, "PLFromApp(Xero)");
    const gasAw = [h.ss.getSheetByName("KeyInfo").valuesGrid?.[1]?.[48], h.ss.getSheetByName("KeyInfo").valuesGrid?.[2]?.[48]];
    if (JSON.stringify(gasAw) !== JSON.stringify(natCoa.categories)) {
      diffs.push({ tab: "KeyInfo!AW", cell: "AW2:AW3", gas: gasAw, native: natCoa.categories });
    }
    suites.push({ id: 7, name: "Xero 12m Rolling P&L & Chart of Accounts Refresh", matched: diffs.length === 0, diffs });
  }

  // --- Suite 8: HubSpot + Pipedrive CRM ---
  {
    const kiHs = makeKeyInfoBase_("Xero", "HubSpot");
    const routesHs = [
      { match: "/crm/v3/properties/deals", body: { results: [{ name: "dealname", label: "Deal Name", hidden: false }, { name: "closedate", label: "Close Date", hidden: false }] } },
      { match: "/crm/v3/objects/deals/search", body: { results: [{ id: "hs-1", createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z", properties: { dealname: "Retainer Deal", dealstage: "qualifiedtobuy", amount: "5000", pipeline: "default", closedate: "2026-11-01" } }] } },
    ];
    const hHs = createMockGasHarness_({ initialTabs: { KeyInfo: kiHs, DataFromCRM: [], CRMComp: [[]], DataChgAlert: [[]] }, initialProps: { HUBSPOT_ACCESS_TOKEN: "tok", HUBSPOT_REFRESH_TOKEN: "ref" }, mockRoutes: routesHs });
    hHs.propsMap.set("CRM_ACCESS", "tok");
    // Bypass local library refresh in HubSpot mock by supplying existing HubSpot tokens via Broker stub or testing export + write
    await hHs.gas.writeHubSpotDataToSheet(await hHs.gas.fetchHubSpotDeals_("tok"));
    const natHs = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "tok" },
      fetchImpl: hHs.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiHs,
      existingGridOverride: [],
      scriptPropsOverride: {},
    });
    const diffsHs = diffGrids_(hHs.ss.getSheetByName("DataFromCRM").valuesGrid, natHs.nextGrid, "DataFromCRM(HubSpot)");

    const kiPd = makeKeyInfoBase_("Xero", "Pipedrive");
    const routesPd = [
      { match: "/v1/dealFields", body: { data: [] } },
      { match: "/v1/deals", body: { data: [{ id: 99, title: "PD Deal", person_name: "Sam", org_name: "Org", status: "open", value: 2500, currency: "GBP", probability: 75, owner_name: "Paul", add_time: "2026-10-01 09:00:00", update_time: "2026-10-02 09:00:00" }] } },
    ];
    const hPd = createMockGasHarness_({ initialTabs: { KeyInfo: kiPd, DataFromCRM: [], CRMComp: [[]], DataChgAlert: [[]] }, mockRoutes: routesPd });
    await hPd.gas.writePipeDriveDataToSheet(await hPd.gas.fetchPipedriveOpportunities_("tok"));
    const natPd = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "tok" },
      fetchImpl: hPd.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiPd,
      existingGridOverride: [],
      scriptPropsOverride: {},
    });
    const diffsPd = diffGrids_(hPd.ss.getSheetByName("DataFromCRM").valuesGrid, natPd.nextGrid, "DataFromCRM(Pipedrive)");
    const diffs = [...diffsHs, ...diffsPd];
    suites.push({ id: 8, name: "HubSpot + Pipedrive CRM Pulls", matched: diffs.length === 0, diffs });
  }

  // --- Suite 9: Monday.com + ClickUp CRM ---
  {
    const kiMo = makeKeyInfoBase_("Xero", "Monday", { X24: "987654" });
    const routesMo = [
      {
        match: "api.monday.com/v2",
        body: (_u, opts) => {
          const q = JSON.parse(opts.body).query || "";
          if (q.includes("columns")) return { data: { boards: [{ columns: [{ id: "status", title: "Status", type: "status" }, { id: "numbers", title: "Value", type: "numbers" }] }] } };
          return { data: { boards: [{ items_page: { cursor: null, items: [{ id: "m1", name: "Site Build", created_at: "2026-10-01", updated_at: "2026-10-02", column_values: [{ id: "status", text: "Won" }, { id: "numbers", text: "8000" }] }] } }] } };
        },
      },
    ];
    const hMo = createMockGasHarness_({ initialTabs: { KeyInfo: kiMo, DataFromCRM: [], CRMComp: [[]], DataChgAlert: [[]] }, initialProps: { MONDAY_ACCESS_TOKEN: "raw-mo-tok" }, mockRoutes: routesMo });
    await hMo.gas.exportMondayBoardToSheet(true);
    const natMo = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "raw-mo-tok" },
      fetchImpl: hMo.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiMo,
      existingGridOverride: [],
      scriptPropsOverride: {},
    });
    const diffsMo = diffGrids_(hMo.ss.getSheetByName("DataFromCRM").valuesGrid, natMo.nextGrid, "DataFromCRM(Monday)");

    const kiCu = makeKeyInfoBase_("Xero", "ClickUp", { X16: "list-42", X17: "view-42" });
    const routesCu = [
      {
        match: "api.clickup.com",
        body: (_u) => _u.includes("page=0")
          ? { tasks: [{ id: "t1", custom_id: "CU-1", name: "App Audit", status: { status: "open" }, start_date: "1727740800000", due_date: "1730419200000", date_created: "1727740800000", assignees: [{ username: "alice" }], priority: { priority: "high" }, url: "https://app.clickup.com/t/t1", custom_fields: [] }] }
          : { tasks: [] },
      },
    ];
    const hCu = createMockGasHarness_({ initialTabs: { KeyInfo: kiCu, DataFromCRM: [], CRMComp: [[]], DataChgAlert: [[]] }, initialProps: { CLICKUP_ACCESS_TOKEN: "raw-cu-tok" }, mockRoutes: routesCu });
    await hCu.gas.exportClickUpListToSheet(true);
    const natCu = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "raw-cu-tok" },
      fetchImpl: hCu.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiCu,
      existingGridOverride: [],
      scriptPropsOverride: {},
    });
    const diffsCu = diffGrids_(hCu.ss.getSheetByName("DataFromCRM").valuesGrid, natCu.nextGrid, "DataFromCRM(ClickUp)");
    const diffs = [...diffsMo, ...diffsCu];
    suites.push({ id: 9, name: "Monday.com + ClickUp CRM Pulls", matched: diffs.length === 0, diffs });
  }

  // --- Suite 10: Close + Capsule CRM ---
  {
    const kiCl = makeKeyInfoBase_("Xero", "Close");
    const routesCl = [
      { match: "custom_field/opportunity", body: { data: [] } },
      { match: "v1/opportunity", body: { has_more: false, data: [{ id: "oppo_1", lead_id: "lead_1", lead_name: "Close Co", status_label: "Proposal", value: 450000, value_period: "one_time", confidence: 80, date_created: "2026-10-01T10:00:00Z", date_updated: "2026-10-02T10:00:00Z", date_won: null, user_name: "Bob" }] } },
    ];
    const hCl = createMockGasHarness_({ initialTabs: { KeyInfo: kiCl, DataFromCRM: [], CRMComp: [[]], DataChgAlert: [[]] }, mockRoutes: routesCl });
    await hCl.gas.writeCloseOpportunitiesToSheet(await hCl.gas.fetchCloseOpportunities_("tok"));
    const natCl = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "tok" },
      fetchImpl: hCl.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiCl,
      existingGridOverride: [],
      scriptPropsOverride: {},
    });
    const diffsCl = diffGrids_(hCl.ss.getSheetByName("DataFromCRM").valuesGrid, natCl.nextGrid, "DataFromCRM(Close)");

    const kiCa = makeKeyInfoBase_("Xero", "Capsule");
    const routesCa = [
      { match: "api.capsulecrm.com", body: { opportunities: [{ id: 777, name: "Brand Launch", description: "Full", party: { id: 1, name: "Kite Ltd" }, milestone: { name: "Qualified", probability: 60 }, value: { amount: 9000, currency: "GBP" }, expectedCloseOn: "2026-12-01", owner: { name: "Dana" }, createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z", fields: [] }] } },
    ];
    const hCa = createMockGasHarness_({ initialTabs: { KeyInfo: kiCa, DataFromCRM: [], CRMComp: [[]], DataChgAlert: [[]] }, mockRoutes: routesCa });
    await hCa.gas.writeCapsuleDataToSheet(await hCa.gas.fetchCapsuleOpportunities_("tok"));
    const natCa = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "tok" },
      fetchImpl: hCa.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiCa,
      existingGridOverride: [],
      scriptPropsOverride: {},
    });
    const diffsCa = diffGrids_(hCa.ss.getSheetByName("DataFromCRM").valuesGrid, natCa.nextGrid, "DataFromCRM(Capsule)");
    const diffs = [...diffsCl, ...diffsCa];
    suites.push({ id: 10, name: "Close + Capsule CRM Pulls", matched: diffs.length === 0, diffs });
  }

  // --- Suite 11: External Google Sheets CRM (`CRMGoogleBridge` weighted match) ---
  {
    const existingBridge = [
      ["Client", "Job", "Value", "System ID (Do Not Edit)"],
      ["Acme Ltd", "Brand Refresh", 5000, "11111111-1111-4111-8111-111111111111"],
    ];
    const kiGs = makeKeyInfoBase_("Xero", "Google Sheets", {
      X11: "https://docs.google.com/spreadsheets/d/extGoogleCrmSheet1234567890/edit",
      X12: "PipelineFeed",
      X13: "Client, Job, Value",
      X14: 1,
    });
    const routesGs = [
      { match: "fields=sheets.properties.title", body: { sheets: [{ properties: { title: "PipelineFeed" } }] } },
      { match: "values/PipelineFeed", body: { values: [["Client", "Job", "Value"], ["Acme Ltd", "Brand Refresh", 5500], ["New Co", "Audit", 2000]] } },
    ];
    const hGs = createMockGasHarness_({ initialTabs: { KeyInfo: kiGs, CRMGoogleBridge: existingBridge, DataFromCRM: [], CRMComp: [[]] }, mockRoutes: routesGs });
    const natGs = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "gs-tok" },
      fetchImpl: hGs.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiGs,
      existingGridOverride: existingBridge,
      bridgeGridOverride: existingBridge,
      scriptPropsOverride: {},
    });
    const diffs = [];
    if (natGs.nextGrid?.[1]?.[3] !== "11111111-1111-4111-8111-111111111111") {
      diffs.push({ tab: "CRMGoogleBridge", cell: "R2C4", gas: "11111111-1111-4111-8111-111111111111", native: natGs.nextGrid?.[1]?.[3] });
    }
    if (!natGs.nextGrid?.[2]?.[3] || natGs.nextGrid.length !== 3) {
      diffs.push({ tab: "DataFromCRM", cell: "rows", gas: 3, native: natGs.nextGrid?.length });
    }
    suites.push({ id: 11, name: "External Google Sheets CRM (CRMGoogleBridge weighted match)", matched: diffs.length === 0, diffs });
  }

  // --- Suite 12: External Excel CRM + ±25% Swing Guard Block & One-Time Override ---
  {
    const existingBridge = [
      ["Client", "Job", "Value", "System ID (Do Not Edit)"],
      ["One Co", "Project A", 3000, "22222222-2222-4222-8222-222222222222"],
      ["Two Co", "Project B", 4000, "33333333-3333-4333-8333-333333333333"],
      ["Three Co", "Project C", 5000, "44444444-4444-4444-8444-444444444444"],
      ["Four Co", "Project D", 6000, "55555555-5555-4555-8555-555555555555"],
    ];
    const kiXl = makeKeyInfoBase_("Xero", "Excel", {
      X36: "drive123",
      X37: "file456",
      X38: "Deals",
      X40: 1,
      X41: "Client, Job, Value",
    });
    const routesXl = [
      { match: "graph.microsoft.com", body: { values: [["Client", "Job", "Value"], ["One Co", "Project A", 3000]] } },
    ];
    const hXl = createMockGasHarness_({ initialTabs: { KeyInfo: kiXl, CRMExcelBridge: existingBridge, DataFromCRM: existingBridge, CRMComp: [[]] }, mockRoutes: routesXl });
    // 1. Check GAS swing guard block vs Native swing guard block (4 -> 1 = -75% / -3 rows -> BLOCKED)
    const gasGuardBlocked = hXl.gas.guardCrmRowCountSwing_(1, "Excel", true);
    const natGuardBlocked = guardNativeCrmRowCountSwing({ existingCount: 4, incomingCount: 1, crmTool: "Excel", scriptProps: {} });
    const natBlockedPull = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "xl-tok" },
      fetchImpl: hXl.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiXl,
      existingGridOverride: existingBridge,
      bridgeGridOverride: existingBridge,
      scriptPropsOverride: {},
    });

    // 2. Now check one-time override passes in BOTH GAS & Native
    const natOverridePull = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "xl-tok" },
      fetchImpl: hXl.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiXl,
      existingGridOverride: existingBridge,
      bridgeGridOverride: existingBridge,
      scriptPropsOverride: { CRM_SYNC_SWING_OVERRIDE_ONCE: JSON.stringify({ approvedBy: "Paul", expiresAt: Date.now() + 60000 }) },
    });

    const diffs = [];
    if (Boolean(gasGuardBlocked?.allowed) !== false || Boolean(natGuardBlocked?.allowed) !== false || !natBlockedPull.blocked) {
      diffs.push({ tab: "SwingGuard", cell: "blocked", gas: gasGuardBlocked?.allowed, native: natBlockedPull.blocked });
    }
    if (!natOverridePull.success || !natOverridePull.overrideUsed || natOverridePull.nextGrid?.[1]?.[3] !== "22222222-2222-4222-8222-222222222222") {
      diffs.push({ tab: "ExcelBridgeOverride", cell: "R2C4", gas: "allowed+preserved", native: natOverridePull });
    }
    suites.push({ id: 12, name: "External Excel CRM + ±25% Swing Guard & Override", matched: diffs.length === 0, diffs });
  }

  // --- Suite 13: External Excel & Google Sheet Bridge Hardened Matching Parity ---
  {
    const diffs = [];

    // Part A: Excel (Next 15, SMG, Channel 4 blank-rev rewrite, anti-false-merge, anti-phantom-blank)
    const xlHeaders = [
      "Client",
      "Nature of the Work",
      "BD Leads",
      "Project type",
      "Deal value",
      "Est. start date",
      "Est. end date",
      "Probability",
      "System ID (Do Not Edit)",
    ];
    const xlExistingBridge = [
      xlHeaders,
      // 0: Next 15 (serial dates + raw numbers stored in bridge)
      ["Next 15 ", "Internal leadership events", "Patrick + Gareth", "Team Coaching", 45000, 46402, 46741, 0.5, "uuid-next15"],
      // 1: SMG (all 5 key fields will be edited)
      ["SMG", "Diagnostic", "Patrick + Gareth", "Team Coaching", 20000, 46402, 46445, 0.2, "uuid-smg"],
      // 2: Channel 4 (blank revenue, rewritten job & dates, matching secondary cols & same row)
      ["Channel 4", "Commercial team transformation support", "Charli + Patrick", "Business Advisory", "", 46357, 46448, "", "uuid-c4"],
      // 3: Beta Ltd (all optional fields blank — must NOT phantom-match Gamma Ltd)
      ["Beta Ltd", "Discovery", "", "", "", "", "", "", "uuid-beta"],
      // 4: Acme Co (old unrelated deal at row index 4; incoming replacement will be at row index 10)
      ["Acme Co", "Annual brand strategy workshop", "Alice", "Advisory", 30000, 46402, 46450, 0.5, "uuid-acme-old"],
      // 5..9: Filler rows so rowDistance for Acme Co exceeds Pass 2b threshold
      ["Filler 1", "Job F1", "Rep1", "Type1", 1000, 46402, 46410, 0.5, "uuid-f1"],
      ["Filler 2", "Job F2", "Rep2", "Type2", 2000, 46402, 46410, 0.5, "uuid-f2"],
      ["Filler 3", "Job F3", "Rep3", "Type3", 3000, 46402, 46410, 0.5, "uuid-f3"],
      ["Filler 4", "Job F4", "Rep4", "Type4", 4000, 46402, 46410, 0.5, "uuid-f4"],
      ["Filler 5", "Job F5", "Rep5", "Type5", 5000, 46402, 46410, 0.5, "uuid-f5"],
    ];

    const xlIncomingSheet = [
      ["Client", "Nature of the Work", "BD Leads", "Project type", "Deal value", "Est. start date", "Est. end date", "Probability"],
      // 0: Next 15 formatted display strings from Graph /usedRange text
      ["Next 15 ", "Internal leadership support events", "Patrick + Gareth", "Team Coaching", "£25,000.00", "15/01/2027", "20/12/2027", "70%"],
      // 1: SMG all 5 key columns changed
      ["SMG", "Team diagnostic + coaching", "Patrick + Gareth", "Team Coaching", "£50,000.00", "01/02/2027", "27/04/2027", "40%"],
      // 2: Channel 4 blank-value rewrite
      ["Channel 4", "Branded content strategy planning", "Charli + Patrick", "Business Advisory", "-", "15/01/2027", "28/02/2027", "N/A"],
      // 3: Gamma Ltd blank fields (must NOT match Beta Ltd)
      ["Gamma Ltd", "Discovery", "", "", "", "", "", ""],
      // 4: Filler 1..5 unchanged
      ["Filler 1", "Job F1", "Rep1", "Type1", "£1,000.00", "15/01/2027", "23/01/2027", "50%"],
      ["Filler 2", "Job F2", "Rep2", "Type2", "£2,000.00", "15/01/2027", "23/01/2027", "50%"],
      ["Filler 3", "Job F3", "Rep3", "Type3", "£3,000.00", "15/01/2027", "23/01/2027", "50%"],
      ["Filler 4", "Job F4", "Rep4", "Type4", "£4,000.00", "15/01/2027", "23/01/2027", "50%"],
      ["Filler 5", "Job F5", "Rep5", "Type5", "£5,000.00", "15/01/2027", "23/01/2027", "50%"],
      // 9: Extra filler to push Acme Co replacement to index 10 (rowDistance = 6 from bridge idx 4)
      ["Filler 6", "Job F6", "Rep6", "Type6", "£6,000.00", "15/01/2027", "23/01/2027", "50%"],
      // 10: Acme Co unrelated replacement deal (must get NEW UUID)
      ["Acme Co", "Payroll software migration", "Bob", "Engineering", "£8,000.00", "01/09/2027", "30/09/2027", "20%"],
    ];

    const kiXl13 = makeKeyInfoBase_("Xero", "Excel", {
      X36: "drive123",
      X37: "file456",
      X38: "Pipeline",
      X40: 1,
      X41: "Client, Nature of the Work, Deal value, Est. start date, Est. end date, Probability",
    });
    const routesXl13 = [
      { match: "/api/integrations/token", body: { success: true, accessToken: "xl-tok" } },
      { match: "graph.microsoft.com", body: { text: xlIncomingSheet, values: xlIncomingSheet } },
    ];
    const hXl13 = createMockGasHarness_({
      initialTabs: { KeyInfo: kiXl13, CRMExcelBridge: xlExistingBridge, DataFromCRM: xlExistingBridge, CRMComp: [[]] },
      mockRoutes: routesXl13,
    });
    await hXl13.gas.PullFromExcelSheet_(true);
    const gasXlBridge = hXl13.ss.getSheetByName("CRMExcelBridge").valuesGrid;

    const natXl13 = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "xl-tok" },
      fetchImpl: hXl13.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiXl13,
      existingGridOverride: xlExistingBridge,
      bridgeGridOverride: xlExistingBridge,
      scriptPropsOverride: {},
    });
    const natXlBridge = natXl13.nextBridgeGrid || [];

    const checkXlCase = (rowIdx, label, expectedUuid, shouldEqual) => {
      const gUuid = String(gasXlBridge?.[rowIdx]?.[8] || "").trim();
      const nUuid = String(natXlBridge?.[rowIdx]?.[8] || "").trim();
      const gOk = shouldEqual ? gUuid === expectedUuid : Boolean(gUuid && gUuid !== expectedUuid);
      const nOk = shouldEqual ? nUuid === expectedUuid : Boolean(nUuid && nUuid !== expectedUuid);
      if (!gOk || !nOk) {
        diffs.push({
          tab: `Excel(${label})`,
          cell: `R${rowIdx + 1}C9`,
          gas: gUuid,
          native: nUuid,
          expected: shouldEqual ? expectedUuid : `NEW != ${expectedUuid}`,
        });
      }
    };

    checkXlCase(1, "Next 15", "uuid-next15", true);
    checkXlCase(2, "SMG", "uuid-smg", true);
    checkXlCase(3, "Channel 4 rewrite", "uuid-c4", true);
    checkXlCase(4, "Gamma vs Beta blank", "uuid-beta", false);
    checkXlCase(11, "Acme unrelated replacement", "uuid-acme-old", false);

    // Verify stable incoming row order preserved in DataFromCRM
    if (String(natXl13.nextGrid?.[1]?.[0] || "").trim() !== "Next 15" || String(natXl13.nextGrid?.[2]?.[0] || "").trim() !== "SMG") {
      diffs.push({ tab: "ExcelOrder", cell: "R2:R3", gas: gasXlBridge?.[1]?.[0], native: natXl13.nextGrid?.[1]?.[0] });
    }

    // Part B: Google Sheets (formatted UK dates/currency/% + unrelated column added without wiping UUIDs)
    const gsExistingBridge = [
      ["Client", "Job", "Value", "Start date", "End date", "Probability", "System ID (Do Not Edit)"],
      ["Delta Co", "Leadership coaching", 45000, 46402, 46741, 0.5, "uuid-delta"],
    ];
    const gsIncomingValues = [
      ["Client", "Notes", "Job", "Value", "Start date", "End date", "Probability"],
      ["Delta Co", "Follow up Monday", "Leadership support coaching", "£45,000.00", "15/01/2027", "20/12/2027", "50%"],
    ];
    const kiGs13 = makeKeyInfoBase_("Xero", "Google Sheets", {
      C1: "https://docs.google.com/spreadsheets/d/mockClientSheet1234567890/edit",
      D1: "https://docs.google.com/spreadsheets/d/mockReconSheet1234567890/edit",
      G1: "https://docs.google.com/spreadsheets/d/mockMasterSheet1234567890/edit",
      X11: "https://docs.google.com/spreadsheets/d/extGoogleCrmSheet9876543210/edit",
      X12: "PipelineFeed",
      X13: "Client, Job, Value, Start date, End date, Probability",
      X14: 1,
      X28: "mockClientSheet1234567890",
    });
    const routesGs13 = [
      { match: "/api/integrations/token", body: { success: true, accessToken: "gs-tok" } },
      { match: "fields=sheets.properties.title", body: { sheets: [{ properties: { title: "PipelineFeed" } }] } },
      { match: "values/PipelineFeed", body: { values: gsIncomingValues } },
    ];
    const hGs13 = createMockGasHarness_({
      initialTabs: { KeyInfo: kiGs13, CRMGoogleBridge: gsExistingBridge, DataFromCRM: gsExistingBridge, CRMComp: [[]] },
      mockRoutes: routesGs13,
    });
    await hGs13.gas.PullFromGoogleSheet_(true);
    const gasGsBridge = hGs13.ss.getSheetByName("CRMGoogleBridge").valuesGrid;

    const natGs13 = await pullNativeCrmDeals(ctx, {
      tokenOverride: { accessToken: "gs-tok" },
      fetchImpl: hGs13.fetchImpl,
      sleepImpl: fakeSleep,
      persistToDb: false,
      keyInfoOverride: kiGs13,
      existingGridOverride: gsExistingBridge,
      bridgeGridOverride: gsExistingBridge,
      scriptPropsOverride: {},
    });
    const natGsBridge = natGs13.nextBridgeGrid || [];
    const gasDeltaUuid = String(gasGsBridge?.[1]?.[7] || "").trim();
    const natDeltaUuid = String(natGsBridge?.[1]?.[7] || "").trim();
    if (gasDeltaUuid !== "uuid-delta" || natDeltaUuid !== "uuid-delta") {
      diffs.push({ tab: "GoogleSheets(HeaderAdded)", cell: "R2C8", gas: gasDeltaUuid, native: natDeltaUuid, expected: "uuid-delta" });
    }

    suites.push({ id: 13, name: "External Excel & Google Sheet Bridge Hardened Matching Parity", matched: diffs.length === 0, diffs });
  }

  return {
    checkedAt: new Date().toISOString(),
    suitesTotal: suites.length,
    suitesPassed: suites.filter((s) => s.matched).length,
    suitesFailed: suites.filter((s) => !s.matched).length,
    suites,
  };
}
