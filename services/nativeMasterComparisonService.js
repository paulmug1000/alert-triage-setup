/**
 * ============================================================================
 * PULSE PHASE 6B: NATIVE RELATIONAL MASTER COMPARISON ENGINE
 * ============================================================================
 * Computes Master Sheet comparison & derived tabs (`InvAppList`, `InvDashList`,
 * `InvComp`, `JnlAppList`, `DirDashList`, `DirComp`, `CRMList`, `CRMComp`,
 * `PLComp`, `TimeComp`, `Outgoings`) strictly from relational Postgres tables
 * (`accounting_invoices`, `accounting_direct_costs`, `accounting_pl_lines`,
 * `crm_deals_raw`, `time_entries_raw`, `pulse_master_sync_configs`,
 * `pulse_client_tab_blueprints`, `pulse_outgoing_items`, `pulse_contractor_entries`,
 * and `pulse_recon_pl_adds`) and persists results into `pulse_master_comparisons`.
 *
 * Also implements:
 *   - Gate 1B: `verifyNativeMasterComparisonParity` (16/16 live client replay)
 *   - Gate 2B: `verifyNativeMasterComparisonMutationMatrix` (CRM mode + Inv/Dir mutation clones)
 * ============================================================================
 */

import { getSupabaseAdmin } from "./supabaseClient.js";
import {
  resolveSupabaseSheetContext,
  invalidateMasterEngineCache,
  trimMasterCalcsGrid_,
  getLastClientEditTimestamp,
  getOrLoadVirtualTabGrid_,
} from "./masterEngineService.js";
import {
  PHASE4_CONFIG_AND_COMP_TABS,
  preloadClientRelationalMasterBundle,
  buildBaseRawMasterTabsFromBundle,
  buildMasterComparisonSeedGridsFromBundle,
  extractMasterSyncConfigFromGrids,
  invalidateClientRelationalMasterCache,
} from "./relationalMasterService.js";
import {
  preloadClientRelationalInputsBundle,
  reconstructRelationalTabFromBundle,
} from "./relationalInputsService.js";
import {
  preloadClientRelationalReconBundle,
  reconstructRelationalReconTabFromBundle,
} from "./relationalReconService.js";
import {
  loadNativeClientTabRecordsBatch,
  checkPhase6NativeComputeSchemaStatus,
  backfillClientNativeCalc,
} from "./nativeClientCalcService.js";
import {
  evaluateOutgoingsMasterTab,
  evaluateInvAppList,
  evaluateInvDashList,
  evaluateInvComp,
  evaluateJnlAppList,
  evaluateDirDashList,
  evaluateDirComp,
  evaluateCRMList,
  evaluateCRMComp,
  evaluateKeyInfoAndPLComp,
  evaluateTimeComp,
  compactGrid2D,
} from "./gasRuntime/masterFormulaEngine.js";

if (typeof window !== "undefined") {
  throw new Error("SECURITY VIOLATION: services/nativeMasterComparisonService.js must never run in browser code.");
}

export const MASTER_COMP_TYPE_BY_TAB = {
  InvAppList: "inv_app_list",
  InvDashList: "inv_dash_list",
  InvComp: "inv_comp",
  JnlAppList: "jnl_app_list",
  DirDashList: "dir_dash_list",
  DirComp: "dir_comp",
  CRMList: "crm_list",
  CRMComp: "crm_comp",
  PLComp: "pl_comp",
  TimeComp: "time_comp",
  Outgoings: "master_outgoings",
};

export const MASTER_COMP_TABS = Object.keys(MASTER_COMP_TYPE_BY_TAB);

const _masterCompCache = new Map();
const MASTER_COMP_TTL_MS = 15000;

export function invalidateClientNativeMasterCompCache(clientName) {
  const key = String(clientName || "").trim().toLowerCase();
  if (!key) {
    _masterCompCache.clear();
    return;
  }
  _masterCompCache.delete(key);
}

function clone2D_(grid) {
  if (!Array.isArray(grid)) return [];
  return grid.map((r) => (Array.isArray(r) ? [...r] : []));
}

function str_(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

export function summarizeMasterComparisonsFromGrids(grids = {}, clientName = "") {
  const invDash = grids.InvDashList || [];
  const dirDash = grids.DirDashList || [];
  const invComp = grids.InvComp || [];
  const dirComp = grids.DirComp || [];
  const crmComp = grids.CRMComp || [];

  const confirmedInvoicesScanned = Math.max(0, invDash.length - 2);
  const confirmedDirectCostsScanned = Math.max(0, dirDash.length - 2);

  let invDiscrepancyCount = 0;
  for (let r = 5; r < invComp.length; r++) {
    const row = invComp[r] || [];
    if (row[29] || row[30] || row[31]) invDiscrepancyCount++;
  }

  let dirDiscrepancyCount = 0;
  for (let r = 5; r < dirComp.length; r++) {
    const row = dirComp[r] || [];
    if (row.slice(40, 48).some((v) => v === 1 || v === "1")) dirDiscrepancyCount++;
  }

  let crmDashDiscrepancyCount = 0;
  let crmAppDiscrepancyCount = 0;
  for (let r = 5; r < crmComp.length; r++) {
    const row = crmComp[r] || [];
    if ([50, 51, 52, 53, 55, 56, 57].some((c) => row[c] === 1 || row[c] === "1")) {
      crmDashDiscrepancyCount++;
    }
    if ([161, 162, 163, 165, 166, 167].some((c) => row[c] === 1 || row[c] === "1")) {
      crmAppDiscrepancyCount++;
    }
  }
  const crmDiscrepancyCount = crmDashDiscrepancyCount + crmAppDiscrepancyCount;

  return {
    success: true,
    clientName,
    confirmedInvoicesScanned,
    confirmedDirectCostsScanned,
    invDiscrepancyCount,
    dirDiscrepancyCount,
    crmDiscrepancyCount,
    crmDashDiscrepancyCount,
    crmAppDiscrepancyCount,
  };
}

function runMasterComparisonEvaluators_(grids, requestedCrmMode = null, clientSheetId = "") {
  if (requestedCrmMode) {
    if (!Array.isArray(grids.CRMComp)) grids.CRMComp = [];
    while (grids.CRMComp.length <= 1) grids.CRMComp.push([]);
    while (grids.CRMComp[1].length <= 1) grids.CRMComp[1].push("");
    grids.CRMComp[1][1] = requestedCrmMode;
  }

  evaluateOutgoingsMasterTab(grids);
  evaluateInvAppList(grids);
  evaluateInvDashList(grids);
  evaluateInvComp(grids);
  evaluateJnlAppList(grids);
  evaluateDirDashList(grids);
  evaluateDirComp(grids);
  evaluateCRMList(grids);
  evaluateCRMComp(grids);
  evaluateKeyInfoAndPLComp(grids, { clientSheetId });
  evaluateTimeComp(grids);

  for (const tName of [
    "InvAppList",
    "InvDashList",
    "InvComp",
    "JnlAppList",
    "DirDashList",
    "DirComp",
    "CRMList",
    "CRMComp",
    "PLComp",
    "TimeComp",
    "Outgoings",
  ]) {
    if (Array.isArray(grids[tName])) {
      grids[tName] = compactGrid2D(grids[tName]);
    }
  }
  return grids;
}

export async function evaluateNativeMasterComparisonsInMemory(
  ctxOrClientName,
  {
    source = "auto",
    requestedCrmMode = null,
    masterBundleOverride = null,
    contextGridsOverride = null,
  } = {}
) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) throw new Error("Valid client context is required.");

  const schema = await checkPhase6NativeComputeSchemaStatus();
  const useDb =
    source === "db" ||
    (source === "auto" && schema.schemaReady);

  const [masterBundle, clientCalcsMap, inputsBundle, reconBundle] = await Promise.all([
    masterBundleOverride || preloadClientRelationalMasterBundle(ctx, { source: useDb ? "db" : "in_memory" }),
    loadNativeClientTabRecordsBatch(ctx, ["ConfCalcs", "PipeCalcs"], {
      source: useDb ? "db" : "in_memory",
      valuesOnly: true,
      includeNotes: false,
    }),
    preloadClientRelationalInputsBundle(ctx, {
      includeSalaries: false,
      includeOutgoings: true,
      includeOutgNotes: true,
      includeNbToFind: false,
      includeBudget: false,
      includeCash: false,
    }),
    preloadClientRelationalReconBundle(ctx, { source: useDb ? "db" : "in_memory" }).catch(() => null),
  ]);

  const rawMasterTabs = buildBaseRawMasterTabsFromBundle(masterBundle);
  const seedCompTabs = buildMasterComparisonSeedGridsFromBundle(masterBundle);

  const cfg = masterBundle?.config || {};
  let masterKeyInfo = clone2D_(contextGridsOverride?.KeyInfo || cfg.master_key_info_grid || []);
  let dataChgAlert = clone2D_(contextGridsOverride?.DataChgAlert || cfg.data_chg_alert_grid || []);
  let masterPlAdds = clone2D_(contextGridsOverride?.PLAdds || cfg.master_pl_adds_grid || []);

  if (masterKeyInfo.length === 0 && !useDb) {
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", "KeyInfo", null, { valuesOnly: true }).catch(() => null);
    masterKeyInfo = clone2D_(rec?.values_grid || []);
  }
  if (dataChgAlert.length === 0 && !useDb) {
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", "DataChgAlert", null, { valuesOnly: true }).catch(() => null);
    dataChgAlert = clone2D_(rec?.values_grid || []);
  }
  if (masterPlAdds.length === 0 && !useDb) {
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", "PLAdds", null, { valuesOnly: true }).catch(() => null);
    masterPlAdds = clone2D_(rec?.values_grid || []);
  }

  const outRecon = reconstructRelationalTabFromBundle(inputsBundle, "Outgoings");
  const outNotesRecon = reconstructRelationalTabFromBundle(inputsBundle, "OutgNotes");
  const reconPlAddsRec = reconBundle ? reconstructRelationalReconTabFromBundle(reconBundle, "PLAdds") : null;

  const clientConfCalcs = trimMasterCalcsGrid_(
    (clientCalcsMap.ConfCalcs?.values_grid || []).slice(0, 5001).map((r) => (r || []).slice(0, 267))
  );
  const clientPipeCalcs = trimMasterCalcsGrid_(
    (clientCalcsMap.PipeCalcs?.values_grid || []).slice(0, 1000).map((r) => (r || []).slice(0, 267))
  );
  const clientOutgoings = compactGrid2D(
    (outRecon.valuesGrid || []).slice(0, 295).map((r) => (r || []).slice(0, 50))
  );
  const clientOutgNotes = compactGrid2D(
    (outNotesRecon.valuesGrid || []).slice(0, 112).map((r) => (r || []).slice(0, 48))
  );
  const reconPlAddsVals =
    Array.isArray(reconPlAddsRec?.values_grid) && reconPlAddsRec.values_grid.length > 0
      ? compactGrid2D(reconPlAddsRec.values_grid)
      : null;

  const grids = {
    ...rawMasterTabs,
    ...seedCompTabs,
    KeyInfo: masterKeyInfo,
    DataChgAlert: dataChgAlert,
    ConfCalcs: clientConfCalcs,
    PipeCalcs: clientPipeCalcs,
    Outgoings: clientOutgoings,
    OutgNotes: clientOutgNotes,
    PLAdds: reconPlAddsVals || masterPlAdds,
    ...(reconPlAddsVals ? { ReconPLAdds: reconPlAddsVals } : {}),
  };

  runMasterComparisonEvaluators_(grids, requestedCrmMode, ctx?.clientSheetId || "");
  const summary = summarizeMasterComparisonsFromGrids(grids, ctx.clientName);

  const dfcGrid = grids.DataFromCRM || [];
  const crmCompGrid = grids.CRMComp || [];
  return {
    source: useDb ? "db" : "in_memory",
    grids,
    summary,
    crmMode: String(crmCompGrid[1]?.[1] || requestedCrmMode || "Pipeline").trim(),
    crmDealsCount: Math.max(0, dfcGrid.length - 1),
    sheetJobsCount: Math.max(0, crmCompGrid.length - 6),
  };
}

// ============================================================================
// PERSISTENCE & CONFIG SYNC
// ============================================================================

export async function syncMasterContextGridsToConfig(ctxOrClientName, partialGrids = {}) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const schema = await checkPhase6NativeComputeSchemaStatus();
  if (!schema.schemaReady) return null;

  const supabase = getSupabaseAdmin();
  const patch = { updated_at: new Date().toISOString() };
  if (partialGrids.KeyInfo) patch.master_key_info_grid = compactGrid2D(partialGrids.KeyInfo);
  if (partialGrids.DataChgAlert) patch.data_chg_alert_grid = compactGrid2D(partialGrids.DataChgAlert);
  if (partialGrids.PLAdds) patch.master_pl_adds_grid = compactGrid2D(partialGrids.PLAdds);

  if (
    partialGrids.CRMList ||
    partialGrids.CRMComp ||
    partialGrids.InvAppList ||
    partialGrids.InvDashList ||
    partialGrids.InvComp ||
    partialGrids.JnlAppList ||
    partialGrids.DirDashList ||
    partialGrids.DirComp ||
    partialGrids.PLComp ||
    partialGrids.TimeComp
  ) {
    const needInvHalf = Boolean(partialGrids.InvAppList) !== Boolean(partialGrids.InvDashList);
    const needJnlHalf = Boolean(partialGrids.JnlAppList) !== Boolean(partialGrids.DirDashList);
    let existingCfg = null;
    if (needInvHalf || needJnlHalf) {
      const { data: exRow } = await supabase
        .from("pulse_master_sync_configs")
        .select("inv_app_list_meta, jnl_app_list_meta")
        .eq("client_id", ctx.clientId)
        .maybeSingle();
      existingCfg = exRow || null;
    }

    const extracted = extractMasterSyncConfigFromGrids(ctx.clientId, ctx.clientName, partialGrids);
    if (partialGrids.CRMList) patch.crm_list_config = extracted.crm_list_config;
    if (partialGrids.CRMComp) patch.crm_comp_controls = extracted.crm_comp_controls;
    if (partialGrids.InvAppList && partialGrids.InvDashList) {
      patch.inv_app_list_meta = extracted.inv_app_list_meta;
    } else if (partialGrids.InvAppList) {
      const prev = existingCfg?.inv_app_list_meta || {};
      patch.inv_app_list_meta = {
        ...extracted.inv_app_list_meta,
        dashRowCount: prev.dashRowCount || 0,
        dashHeaderRows: prev.dashHeaderRows || [],
      };
    } else if (partialGrids.InvDashList) {
      const prev = existingCfg?.inv_app_list_meta || {};
      patch.inv_app_list_meta = {
        ...prev,
        dashRowCount: extracted.inv_app_list_meta.dashRowCount,
        dashHeaderRows: extracted.inv_app_list_meta.dashHeaderRows,
      };
    }
    if (partialGrids.InvComp) patch.inv_comp_controls = extracted.inv_comp_controls;
    if (partialGrids.JnlAppList && partialGrids.DirDashList) {
      patch.jnl_app_list_meta = extracted.jnl_app_list_meta;
    } else if (partialGrids.JnlAppList) {
      const prev = existingCfg?.jnl_app_list_meta || {};
      patch.jnl_app_list_meta = {
        ...extracted.jnl_app_list_meta,
        dashRowCount: prev.dashRowCount || 0,
        dashHeaderRows: prev.dashHeaderRows || [],
      };
    } else if (partialGrids.DirDashList) {
      const prev = existingCfg?.jnl_app_list_meta || {};
      patch.jnl_app_list_meta = {
        ...prev,
        dashRowCount: extracted.jnl_app_list_meta.dashRowCount,
        dashHeaderRows: extracted.jnl_app_list_meta.dashHeaderRows,
      };
    }
    if (partialGrids.DirComp) patch.dir_comp_controls = extracted.dir_comp_controls;
    if (partialGrids.PLComp) patch.pl_comp_meta = extracted.pl_comp_meta;
    if (partialGrids.TimeComp) patch.time_comp_controls = extracted.time_comp_controls;
  }

  const { error } = await supabase
    .from("pulse_master_sync_configs")
    .upsert({ client_id: ctx.clientId, client_name: ctx.clientName, ...patch }, { onConflict: "client_id" });
  if (error) {
    throw new Error(`syncMasterContextGridsToConfig failed (${ctx.clientName}): ${error.message}`);
  }
  invalidateClientRelationalMasterCache(ctx.clientName);
  invalidateClientNativeMasterCompCache(ctx.clientName);
  return patch;
}

export async function computeAndPersistNativeMasterComparisons(
  ctxOrClientName,
  { requestedCrmMode = null, updateBackfillTimestamp = false, source = "auto" } = {}
) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) throw new Error("Valid client context is required.");

  const schema = await checkPhase6NativeComputeSchemaStatus();
  if (!schema.schemaReady) {
    throw new Error("Migration 0017 must be applied in Supabase SQL Editor first.");
  }

  const evalRes = await evaluateNativeMasterComparisonsInMemory(ctx, {
    source,
    requestedCrmMode,
  });

  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const summary = evalRes.summary;

  if (requestedCrmMode) {
    const { data: cfgRow, error: cfgErr } = await supabase
      .from("pulse_master_sync_configs")
      .select("crm_comp_controls")
      .eq("client_id", ctx.clientId)
      .maybeSingle();
    if (cfgErr) {
      throw new Error(`Failed reading pulse_master_sync_configs (${ctx.clientName}): ${cfgErr.message}`);
    }
    const prevCtrl = cfgRow?.crm_comp_controls || {};
    const nextHdrs = Array.isArray(prevCtrl.headerRows) ? clone2D_(prevCtrl.headerRows) : [[], []];
    while (nextHdrs.length <= 1) nextHdrs.push([]);
    while (nextHdrs[1].length <= 1) nextHdrs[1].push("");
    nextHdrs[1][1] = requestedCrmMode;
    const { error: cfgUpdErr } = await supabase
      .from("pulse_master_sync_configs")
      .update({
        crm_comp_controls: { ...prevCtrl, headerRows: nextHdrs },
        updated_at: nowIso,
      })
      .eq("client_id", ctx.clientId);
    if (cfgUpdErr) {
      throw new Error(`Failed updating crm_comp_controls (${ctx.clientName}): ${cfgUpdErr.message}`);
    }
  }

  const upsertRows = MASTER_COMP_TABS.map((tabName) => {
    const compType = MASTER_COMP_TYPE_BY_TAB[tabName];
    const grid = compactGrid2D(evalRes.grids[tabName] || []);
    let discrepancyCount = 0;
    let secondaryDiscrepancyCount = 0;
    let scannedCount = 0;
    let modeLabel = "";

    if (tabName === "InvComp") {
      discrepancyCount = summary.invDiscrepancyCount;
      scannedCount = summary.confirmedInvoicesScanned;
    } else if (tabName === "DirComp") {
      discrepancyCount = summary.dirDiscrepancyCount;
      scannedCount = summary.confirmedDirectCostsScanned;
    } else if (tabName === "CRMComp") {
      discrepancyCount = summary.crmDashDiscrepancyCount;
      secondaryDiscrepancyCount = summary.crmAppDiscrepancyCount;
      scannedCount = evalRes.sheetJobsCount;
      modeLabel = evalRes.crmMode;
    }

    return {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      comparison_type: compType,
      mode_label: modeLabel,
      discrepancy_count: discrepancyCount,
      secondary_discrepancy_count: secondaryDiscrepancyCount,
      scanned_count: scannedCount,
      rows_grid: grid,
      summary_meta: tabName === "InvComp" || tabName === "DirComp" || tabName === "CRMComp" ? summary : {},
      computed_at: nowIso,
      updated_at: nowIso,
    };
  });

  const { error: uErr } = await supabase
    .from("pulse_master_comparisons")
    .upsert(upsertRows, { onConflict: "client_id,comparison_type" });
  if (uErr) {
    throw new Error(`pulse_master_comparisons upsert failed (${ctx.clientName}): ${uErr.message}`);
  }

  const byTab = {};
  for (const tabName of MASTER_COMP_TABS) {
    byTab[tabName] = evalRes.grids[tabName] || [];
  }
  _masterCompCache.set(String(ctx.clientName).trim().toLowerCase(), {
    expiresAt: Date.now() + MASTER_COMP_TTL_MS,
    computedAtMs: Date.now(),
    byTab,
    summary,
  });

  const { data: clRow, error: clErr } = await supabase
    .from("clients")
    .select("metadata")
    .eq("id", ctx.clientId)
    .maybeSingle();
  if (!clErr && clRow) {
    const prevMeta = clRow.metadata && typeof clRow.metadata === "object" ? clRow.metadata : {};
    const nextState = {
      ...(prevMeta.native_master_comp_state || {}),
      lastComputedAt: nowIso,
      ...(updateBackfillTimestamp ? { lastBackfilledAt: nowIso } : {}),
      invDiscrepancyCount: summary.invDiscrepancyCount,
      dirDiscrepancyCount: summary.dirDiscrepancyCount,
      crmDiscrepancyCount: summary.crmDiscrepancyCount,
    };
    const { error: metaUpdErr } = await supabase
      .from("clients")
      .update({
        metadata: {
          ...prevMeta,
          native_master_comp_state: nextState,
        },
      })
      .eq("id", ctx.clientId);
    if (metaUpdErr) {
      throw new Error(`clients metadata update failed (${ctx.clientName}): ${metaUpdErr.message}`);
    }
  }

  return {
    ...evalRes,
    persistedRowsCount: upsertRows.length,
    computedAt: nowIso,
  };
}

export async function loadPersistedOrEvaluateMasterComparisonTab(
  ctxOrClientName,
  tabName,
  { maxAgeMs = 15000 } = {}
) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return [];

  const compType = MASTER_COMP_TYPE_BY_TAB[tabName];
  if (!compType) return [];

  const clientKey = String(ctx.clientName || "").trim().toLowerCase();
  const lastEditMs = getLastClientEditTimestamp(clientKey);
  const cached = _masterCompCache.get(clientKey);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.computedAtMs >= lastEditMs &&
    cached.byTab?.[tabName]
  ) {
    return clone2D_(cached.byTab[tabName]);
  }

  const schema = await checkPhase6NativeComputeSchemaStatus();
  if (!schema.schemaReady) {
    const ev = await evaluateNativeMasterComparisonsInMemory(ctx, { source: "in_memory" });
    return clone2D_(ev.grids[tabName] || []);
  }

  const supabase = getSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from("pulse_master_comparisons")
    .select("comparison_type, rows_grid, computed_at")
    .eq("client_id", ctx.clientId);

  if (!error && Array.isArray(rows) && rows.length >= MASTER_COMP_TABS.length) {
    const newestMs = rows.reduce((m, r) => {
      const t = r.computed_at ? Date.parse(r.computed_at) : 0;
      return t > m ? t : m;
    }, 0);
    const [mSyncRes, rCfgRes, bpRes] = await Promise.all([
      supabase
        .from("pulse_master_sync_configs")
        .select("updated_at")
        .eq("client_id", ctx.clientId)
        .maybeSingle(),
      supabase
        .from("pulse_recon_configs")
        .select("updated_at")
        .eq("client_id", ctx.clientId)
        .maybeSingle(),
      supabase
        .from("pulse_client_tab_blueprints")
        .select("updated_at")
        .eq("client_id", ctx.clientId)
        .in("tab_name", ["Confirmed", "Pipeline", "Outgoings", "OutgNotes"]),
    ]);
    let dbMaxUpdatedMs = 0;
    for (const u of [mSyncRes?.data?.updated_at, rCfgRes?.data?.updated_at]) {
      const t = u ? Date.parse(u) : 0;
      if (t > dbMaxUpdatedMs) dbMaxUpdatedMs = t;
    }
    for (const row of bpRes?.data || []) {
      const t = row?.updated_at ? Date.parse(row.updated_at) : 0;
      if (t > dbMaxUpdatedMs) dbMaxUpdatedMs = t;
    }
    const effectiveLastEditMs = Math.max(lastEditMs, dbMaxUpdatedMs);
    const staleByClientEdit = effectiveLastEditMs > 0 && newestMs < effectiveLastEditMs;
    const staleByAge = maxAgeMs > 0 && Date.now() - newestMs > maxAgeMs;
    if (!staleByClientEdit && !staleByAge) {
      const byTab = {};
      for (const [t, cType] of Object.entries(MASTER_COMP_TYPE_BY_TAB)) {
        const found = rows.find((r) => r.comparison_type === cType);
        byTab[t] = Array.isArray(found?.rows_grid) ? found.rows_grid : [];
      }
      _masterCompCache.set(clientKey, {
        expiresAt: Date.now() + MASTER_COMP_TTL_MS,
        computedAtMs: newestMs,
        byTab,
      });
      return clone2D_(byTab[tabName] || []);
    }
  }

  const persisted = await computeAndPersistNativeMasterComparisons(ctx, { source: "db" });
  return clone2D_(persisted.grids[tabName] || []);
}

export async function loadMasterContextTabFromConfig(ctxOrClientName, tabName) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return [];

  const schema = await checkPhase6NativeComputeSchemaStatus();
  if (!schema.schemaReady) {
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", tabName, null).catch(() => null);
    return clone2D_(rec?.values_grid || []);
  }

  const colMap = {
    KeyInfo: "master_key_info_grid",
    DataChgAlert: "data_chg_alert_grid",
    PLAdds: "master_pl_adds_grid",
  };
  const col = colMap[tabName];
  if (!col) return [];

  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("pulse_master_sync_configs")
    .select(col)
    .eq("client_id", ctx.clientId)
    .maybeSingle();

  const grid = Array.isArray(data?.[col]) ? data[col] : [];
  if (grid.length > 0) return clone2D_(grid);

  if (ctx.gridStorageRetired || ctx.masterComputeMode === "native") {
    return [];
  }

  const fallback = await getOrLoadVirtualTabGrid_(ctx, "master", tabName, null).catch(() => null);
  return clone2D_(fallback?.values_grid || []);
}

export async function backfillClientNativeMasterComparisons(clientName) {
  const schema = await checkPhase6NativeComputeSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0017 must be applied in Supabase SQL Editor first.");
  }
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) throw new Error(`Client "${clientName}" not found.`);

  if (!ctx.gridStorageRetired) {
    const supabase = getSupabaseAdmin();
    // Ensure client blueprints exist so ConfCalcs & PipeCalcs are present in pulse_client_tab_blueprints
    if (!ctx.metadata?.native_client_calc_state?.lastBackfilledAt) {
      await backfillClientNativeCalc(ctx.clientName);
    }

    const contextTabs = ["KeyInfo", "DataChgAlert", "PLAdds", ...PHASE4_CONFIG_AND_COMP_TABS];
    const { data: mRows, error: mErr } = await supabase
      .from("master_sheet_grids")
      .select("tab_name, values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .in("tab_name", contextTabs);
    if (mErr) throw new Error(`Failed reading Master context grids (${ctx.clientName}): ${mErr.message}`);

    const gridMap = {};
    for (const r of mRows || []) {
      gridMap[r.tab_name] = compactGrid2D(r.values_grid || []);
    }
    if (Object.keys(gridMap).length > 0) {
      await syncMasterContextGridsToConfig(ctx, gridMap);
    }
  }

  const persisted = await computeAndPersistNativeMasterComparisons(ctx, {
    updateBackfillTimestamp: true,
    source: "db",
  });
  return {
    clientName: ctx.clientName,
    persistedRowsCount: persisted.persistedRowsCount,
    ...persisted.summary,
  };
}

export async function backfillAllClientsNativeMasterComparisons() {
  const schema = await checkPhase6NativeComputeSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0017 must be applied in Supabase SQL Editor first.");
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
      const res = await backfillClientNativeMasterComparisons(cl.client_name);
      results.push({ ...res, error: null });
    } catch (err) {
      results.push({ clientName: cl.client_name, error: err.message, persistedRowsCount: 0 });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    totalClients: results.length,
    clientsProcessed: results.filter((r) => !r.error).length,
    succeededCount: results.filter((r) => !r.error).length,
    errorCount: results.filter((r) => Boolean(r.error)).length,
    totalComparisonRows: results.reduce((a, r) => a + (r.persistedRowsCount || 0), 0),
    results,
  };
}

export async function setClientMasterComputeMode(clientName, mode) {
  const cleanMode = str_(mode).toLowerCase();
  if (cleanMode !== "grid_gas" && cleanMode !== "shadow" && cleanMode !== "native") {
    throw new Error("Invalid masterComputeMode. Expected 'grid_gas', 'shadow', or 'native'.");
  }
  const schema = await checkPhase6NativeComputeSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0017 must be applied in Supabase SQL Editor first.");
  }

  const supabase = getSupabaseAdmin();
  const { data: cl, error: fErr } = await supabase
    .from("clients")
    .select("id, client_name, master_ingestion_mode, grid_storage_retired, metadata")
    .eq("client_name", clientName)
    .maybeSingle();
  if (fErr || !cl) throw new Error(fErr?.message || `Client "${clientName}" not found.`);

  if (cl.grid_storage_retired && cleanMode !== "native") {
    throw new Error(
      `Client "${clientName}" has retired grid storage and cannot be downgraded from 'native' master_compute_mode.`
    );
  }

  if (cleanMode === "native" && cl.master_ingestion_mode !== "relational") {
    throw new Error(
      `Client "${clientName}" must have master_ingestion_mode = 'relational' before enabling native master comparisons.`
    );
  }

  let baseMeta = cl.metadata || {};
  if (cleanMode === "shadow" || cleanMode === "native") {
    await backfillClientNativeMasterComparisons(clientName);
    const { data: freshCl } = await supabase
      .from("clients")
      .select("metadata")
      .eq("id", cl.id)
      .maybeSingle();
    if (freshCl?.metadata && typeof freshCl.metadata === "object") {
      baseMeta = freshCl.metadata;
    }
  }

  const nextMeta = { ...baseMeta, master_compute_mode: cleanMode };
  const { data: upd, error: uErr } = await supabase
    .from("clients")
    .update({ master_compute_mode: cleanMode, metadata: nextMeta })
    .eq("id", cl.id)
    .select("id, client_name, client_compute_mode, master_compute_mode")
    .single();
  if (uErr) throw new Error(`Failed updating master_compute_mode: ${uErr.message}`);

  invalidateMasterEngineCache(clientName, "master", null, { invalidateSheetContext: true });
  invalidateClientNativeMasterCompCache(clientName);
  return upd;
}

// ============================================================================
// GATE 1B & GATE 2B VERIFIERS
// ============================================================================

function normCell_(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : String(v);
  if (typeof v === "boolean") return v;
  return String(v);
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
      let same = va === vb;
      if (!same && typeof va === "number" && typeof vb === "number") {
        same = Math.abs(va - vb) <= 0.005;
      }
      if (!same) {
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

async function evaluateFreshLegacyMasterComparisons_(supabase, ctx) {
  const rawTabs = [
    "KeyInfo",
    "DataChgAlert",
    "InvFromApp",
    "RevFromApp",
    "JnlsFromApp",
    "PLFromApp",
    "Year0PLFromApp",
    "DataFromCRM",
    "DataFromTime",
    "ProjectsFromTime",
    "CRMList",
    "CRMComp",
    "InvAppList",
    "InvDashList",
    "InvComp",
    "JnlAppList",
    "DirDashList",
    "DirComp",
    "PLComp",
    "TimeComp",
    "PLAdds",
  ];
  const [mRes, cRes, rRes] = await Promise.all([
    supabase
      .from("master_sheet_grids")
      .select("tab_name, values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .in("tab_name", rawTabs),
    supabase
      .from("master_sheet_grids")
      .select("tab_name, sheet_role, values_grid")
      .eq("client_name", ctx.clientName)
      .in("sheet_role", ["client", "master"])
      .in("tab_name", [
        "ConfCalcs",
        "PipeCalcs",
        "Outgoings",
        "OutgNotes",
        "Client::ConfCalcs",
        "Client::PipeCalcs",
        "Client::Outgoings",
        "Client::OutgNotes",
      ]),
    supabase
      .from("master_sheet_grids")
      .select("tab_name, values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "recon")
      .eq("tab_name", "PLAdds")
      .maybeSingle(),
  ]);

  const grids = {};
  for (const r of mRes.data || []) {
    grids[r.tab_name] = clone2D_(r.values_grid || []);
  }
  const pickClient = (t) => {
    const cRows = cRes.data || [];
    const hit =
      cRows.find((x) => x.sheet_role === "client" && x.tab_name === t) ||
      cRows.find((x) => x.sheet_role === "master" && x.tab_name === `Client::${t}`);
    return hit?.values_grid || [];
  };
  grids.ConfCalcs = trimMasterCalcsGrid_(pickClient("ConfCalcs").slice(0, 5001).map((r) => (r || []).slice(0, 267)));
  grids.PipeCalcs = trimMasterCalcsGrid_(pickClient("PipeCalcs").slice(0, 1000).map((r) => (r || []).slice(0, 267)));
  grids.Outgoings = compactGrid2D(pickClient("Outgoings").slice(0, 295).map((r) => (r || []).slice(0, 50)));
  grids.OutgNotes = compactGrid2D(pickClient("OutgNotes").slice(0, 112).map((r) => (r || []).slice(0, 48)));
  if (Array.isArray(rRes.data?.values_grid) && rRes.data.values_grid.length > 0) {
    grids.ReconPLAdds = compactGrid2D(rRes.data.values_grid);
    grids.PLAdds = clone2D_(grids.ReconPLAdds);
  }

  runMasterComparisonEvaluators_(grids, null, ctx?.clientSheetId || "");
  return grids;
}

export async function verifyNativeMasterComparisonParity({
  clientName = null,
  source = "auto",
  onlyActiveOrShadow = false,
  compareFrozenGrids = false,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase6NativeComputeSchemaStatus();
  const cols = schema.schemaReady
    ? "id, client_name, master_compute_mode, recon_sheet_id, metadata"
    : "id, client_name, recon_sheet_id, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  const { data: clients, error } = await query;
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    const mode = cl.master_compute_mode || "grid_gas";
    if (onlyActiveOrShadow && mode !== "native" && mode !== "shadow") continue;

    try {
      const ctx = {
        clientId: cl.id,
        clientName: cl.client_name,
        masterComputeMode: mode,
        reconSheetId: cl.recon_sheet_id || `sb-recon-${String(cl.client_name).toLowerCase()}`,
      };
      const canUseDb =
        schema.schemaReady &&
        (source === "db" ||
          (source === "auto" && Boolean(cl.metadata?.native_master_comp_state?.lastBackfilledAt)));
      const effectiveSource = canUseDb ? "db" : "in_memory";

      let legacyGrids = null;
      let nativeRes = null;
      if (mode === "native" && effectiveSource === "db" && !compareFrozenGrids) {
        const [{ data: compRows, error: compErr }, freshNative] = await Promise.all([
          supabase
            .from("pulse_master_comparisons")
            .select("comparison_type, rows_grid")
            .eq("client_id", ctx.clientId),
          evaluateNativeMasterComparisonsInMemory(ctx, { source: "db" }),
        ]);
        if (compErr) throw new Error(`Failed loading pulse_master_comparisons: ${compErr.message}`);
        legacyGrids = {};
        for (const [tabName, cType] of Object.entries(MASTER_COMP_TYPE_BY_TAB)) {
          const hit = (compRows || []).find((r) => r.comparison_type === cType);
          legacyGrids[tabName] = Array.isArray(hit?.rows_grid) ? hit.rows_grid : [];
        }
        nativeRes = freshNative;
      } else {
        const [frozenLegacy, freshNative] = await Promise.all([
          evaluateFreshLegacyMasterComparisons_(supabase, ctx),
          evaluateNativeMasterComparisonsInMemory(ctx, { source: effectiveSource }),
        ]);
        legacyGrids = frozenLegacy;
        nativeRes = freshNative;
      }

      let totalMismatchCount = 0;
      const sampleMismatches = [];
      for (const tabName of MASTER_COMP_TABS) {
        const { mismatchCount, diffs } = diff2DGrids_(
          tabName,
          legacyGrids[tabName] || [],
          nativeRes.grids[tabName] || [],
          4
        );
        totalMismatchCount += mismatchCount;
        if (sampleMismatches.length < 10) sampleMismatches.push(...diffs);
      }

      const legacySummary = summarizeMasterComparisonsFromGrids(legacyGrids, cl.client_name);
      const nativeSummary = nativeRes.summary;
      for (const key of [
        "confirmedInvoicesScanned",
        "confirmedDirectCostsScanned",
        "invDiscrepancyCount",
        "dirDiscrepancyCount",
        "crmDiscrepancyCount",
      ]) {
        if (legacySummary[key] !== nativeSummary[key]) {
          totalMismatchCount++;
          sampleMismatches.push({
            tab: "Summary",
            tabName: "Summary",
            cellKey: key,
            grid: legacySummary[key],
            native: nativeSummary[key],
            expected: legacySummary[key],
            actual: nativeSummary[key],
          });
        }
      }

      results.push({
        clientName: cl.client_name,
        source: effectiveSource,
        masterComputeMode: mode,
        invDiscrepancies: nativeSummary.invDiscrepancyCount,
        dirDiscrepancies: nativeSummary.dirDiscrepancyCount,
        crmDiscrepancies: nativeSummary.crmDiscrepancyCount,
        totalMismatchCount,
        matched: totalMismatchCount === 0,
        sampleMismatches: sampleMismatches.slice(0, 10),
        error: null,
      });
    } catch (err) {
      results.push({
        clientName: cl.client_name,
        source: "error",
        masterComputeMode: mode,
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

export async function verifyNativeMasterComparisonMutationMatrix({
  clientNames = ["APPTEST", "Ayefour Design", "Get Better"],
  source = "auto",
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase6NativeComputeSchemaStatus();
  const { data: clients, error } = await supabase
    .from("clients")
    .select("id, client_name, recon_sheet_id, metadata")
    .in("client_name", clientNames)
    .order("client_name");
  if (error) throw new Error(`Failed loading Master matrix clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    const ctx = {
      clientId: cl.id,
      clientName: cl.client_name,
      reconSheetId: cl.recon_sheet_id || `sb-recon-${String(cl.client_name).toLowerCase()}`,
    };
    const canUseDb =
      schema.schemaReady &&
      (source === "db" ||
        (source === "auto" && Boolean(cl.metadata?.native_master_comp_state?.lastBackfilledAt)));
    const effectiveSource = canUseDb ? "db" : "in_memory";

    const [legacyBase, nativeBase] = await Promise.all([
      evaluateFreshLegacyMasterComparisons_(supabase, ctx),
      evaluateNativeMasterComparisonsInMemory(ctx, { source: effectiveSource }),
    ]);

    const scenarios = [
      {
        name: "crm_comp_confirmed_mode",
        apply: (g) => {
          runMasterComparisonEvaluators_(g, "Confirmed", ctx?.clientSheetId || "");
        },
        tabs: ["CRMList", "CRMComp"],
      },
      {
        name: "crm_comp_pipeline_mode",
        apply: (g) => {
          runMasterComparisonEvaluators_(g, "Pipeline", ctx?.clientSheetId || "");
        },
        tabs: ["CRMList", "CRMComp"],
      },
      {
        name: "synthetic_unmatched_invoice_row",
        apply: (g) => {
          const hdr = g.InvFromApp?.[0] || [];
          const row = new Array(Math.max(hdr.length, 20)).fill("");
          const setCol = (name, val) => {
            const idx = hdr.findIndex((h) => String(h || "").trim().toLowerCase() === name.toLowerCase());
            if (idx >= 0) row[idx] = val;
          };
          setCol("ContactName", "Synthetic Test Client Ltd");
          setCol("Reference", "SYNTH-999");
          setCol("InvoiceNumber", "INV-SYNTH-999");
          setCol("Date", 46000);
          setCol("DueDate", 46030);
          setCol("Type", "ACCREC");
          setCol("CurrencyCode", "GBP");
          setCol("CurrencyRate", 1);
          setCol("Status", "AUTHORISED");
          setCol("SentToContact", true);
          setCol("Total", 1200);
          setCol("SubTotal", 1000);
          setCol("TotalTax", 200);
          g.InvFromApp.push(row);
          runMasterComparisonEvaluators_(g, null, ctx?.clientSheetId || "");
        },
        tabs: ["InvAppList", "InvComp"],
      },
      {
        name: "synthetic_direct_cost_bill",
        apply: (g) => {
          const hdr = g.JnlsFromApp?.[0] || [];
          const row = new Array(Math.max(hdr.length, 15)).fill("");
          const setCol = (names, val) => {
            const idx = hdr.findIndex((h) =>
              names.includes(String(h || "").trim().toLowerCase())
            );
            if (idx >= 0) row[idx] = val;
          };
          setCol(["contactname", "supplier", "contact"], "Synthetic Supplier Ltd");
          setCol(["description", "reference", "item"], "SYNTH-EXP-999");
          setCol(["date", "invoicedate"], 46000);
          setCol(["net", "subtotal", "amount"], 450);
          setCol(["gross", "total"], 540);
          setCol(["type", "transactiontype"], "ACCPAY");
          setCol(["sourceid", "invoiceid", "externalid"], "ext-synth-dir-999");
          g.JnlsFromApp.push(row);
          runMasterComparisonEvaluators_(g, null, ctx?.clientSheetId || "");
        },
        tabs: ["JnlAppList", "DirComp"],
      },
    ];

    for (const sc of scenarios) {
      const gA = Object.fromEntries(Object.entries(legacyBase).map(([k, v]) => [k, clone2D_(v)]));
      const gB = Object.fromEntries(Object.entries(nativeBase.grids).map(([k, v]) => [k, clone2D_(v)]));
      sc.apply(gA);
      sc.apply(gB);

      let mism = 0;
      const samples = [];
      for (const t of sc.tabs) {
        const { mismatchCount, diffs } = diff2DGrids_(t, gA[t] || [], gB[t] || [], 4);
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
