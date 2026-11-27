/**
 * gridRetirementService.js (Phase 6E)
 *
 * Manages Phase 6E zero-grid hardening, `SheetBridgeBaseline` migration out of
 * `master_sheet_grids` into `pulse_master_sync_configs.sheet_bridge_baseline`,
 * tenant zero-grid readiness auditing, and dry-run-first retirement/purging of
 * obsolete `master_sheet_grids` rows.
 */

import fs from "fs";
import path from "path";
import { getSupabaseAdmin } from "./supabaseClient.js";
import { escapeIlikeExact } from "../utils/helpers.js";

if (typeof window !== "undefined") {
  throw new Error("SECURITY VIOLATION: services/gridRetirementService.js must never run in browser code.");
}

let _cachedMigration0020Sql = null;
let _schema6eCache = { checkedAt: 0, status: null };

export function readMigration0020Sql() {
  if (_cachedMigration0020Sql !== null) return _cachedMigration0020Sql;
  try {
    const p = path.resolve(process.cwd(), "supabase/migrations/0020_phase6e_retire_grid_blobs.sql");
    _cachedMigration0020Sql = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  } catch {
    _cachedMigration0020Sql = "";
  }
  return _cachedMigration0020Sql;
}

export async function checkPhase6eRetirementSchemaStatus({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && _schema6eCache.status && now - _schema6eCache.checkedAt < 15000) {
    return _schema6eCache.status;
  }

  const supabase = getSupabaseAdmin();
  const migrationSql = readMigration0020Sql();
  if (!supabase) {
    return { schemaReady: false, migrationSql, error: "Supabase admin client not configured." };
  }

  const checks = await Promise.all([
    supabase.from("clients").select("grid_storage_retired, grid_retired_at").limit(1),
    supabase.from("pulse_master_sync_configs").select("sheet_bridge_baseline").limit(1),
  ]);

  const errors = checks.map((c) => c.error?.message).filter(Boolean);
  const schemaReady = errors.length === 0;
  const status = {
    schemaReady,
    migrationSql,
    error: errors.join("; ") || null,
  };
  _schema6eCache = { checkedAt: now, status };
  return status;
}

export async function getPhase6eRetirementOverviewStats() {
  const schema = await checkPhase6eRetirementSchemaStatus();
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return {
      schemaReady: false,
      migrationSql: schema.migrationSql,
      retiredClientsCount: 0,
      remainingGridRows: 0,
      migratedBaselinesCount: 0,
      error: schema.error || null,
    };
  }

  const gridCountPromise = (async () => {
    try {
      const r = await supabase
        .from("master_sheet_grids")
        .select("id", { count: "exact", head: true });
      return r.count ?? 0;
    } catch {
      return 0;
    }
  })();

  if (!schema.schemaReady) {
    const remainingGridRows = await gridCountPromise;
    return {
      schemaReady: false,
      migrationSql: schema.migrationSql,
      retiredClientsCount: 0,
      remainingGridRows,
      migratedBaselinesCount: 0,
      error: schema.error || null,
    };
  }

  const [retiredResp, baselineResp, remainingGridRows] = await Promise.all([
    supabase.from("clients").select("id", { count: "exact", head: true }).eq("grid_storage_retired", true),
    supabase
      .from("pulse_master_sync_configs")
      .select("client_id", { count: "exact", head: true })
      .not("sheet_bridge_baseline", "is", null),
    gridCountPromise,
  ]);

  return {
    schemaReady: true,
    migrationSql: schema.migrationSql,
    retiredClientsCount: retiredResp.count ?? 0,
    remainingGridRows,
    migratedBaselinesCount: baselineResp.count ?? 0,
  };
}

export async function migrateSheetBridgeBaselinesToRelational({
  clientName = null,
  dryRun = true,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase admin client not configured.");

  const isDryRun = dryRun !== false;
  if (!isDryRun) {
    const schema = await checkPhase6eRetirementSchemaStatus({ forceRefresh: true });
    if (!schema.schemaReady) {
      throw new Error("Migration 0020 must be applied before migrating SheetBridgeBaseline rows to pulse_master_sync_configs.");
    }
  }

  let q = supabase
    .from("master_sheet_grids")
    .select("client_id, client_name, notes_grid, updated_at")
    .eq("sheet_role", "master")
    .eq("tab_name", "SheetBridgeBaseline")
    .order("client_name", { ascending: true });
  if (clientName) {
    q = q.ilike("client_name", escapeIlikeExact(String(clientName).trim()));
  }
  const { data: baselineRows, error } = await q;
  if (error) throw new Error(`Failed reading SheetBridgeBaseline rows: ${error.message}`);

  const results = [];
  let migratedCount = 0;

  for (const row of baselineRows || []) {
    let targetClientId = row.client_id;
    let targetClientName = row.client_name;
    if (!targetClientId && targetClientName) {
      const { data: cRow } = await supabase
        .from("clients")
        .select("id, client_name")
        .ilike("client_name", escapeIlikeExact(targetClientName))
        .maybeSingle();
      if (cRow) {
        targetClientId = cRow.id;
        targetClientName = cRow.client_name;
      }
    }
    const tabCount =
      row.notes_grid?.tabs && typeof row.notes_grid.tabs === "object"
        ? Object.keys(row.notes_grid.tabs).length
        : 0;

    if (!targetClientId) {
      results.push({
        clientName: targetClientName,
        status: "skipped_no_client_id",
        tabCount,
      });
      continue;
    }

    if (isDryRun) {
      results.push({
        clientName: targetClientName,
        clientId: targetClientId,
        status: "would_migrate",
        driveVersion: String(row.notes_grid?.driveVersion || ""),
        tabCount,
      });
      continue;
    }

    const nowIso = new Date().toISOString();
    const payload = row.notes_grid && typeof row.notes_grid === "object" ? row.notes_grid : {};
    const { error: upErr } = await supabase
      .from("pulse_master_sync_configs")
      .upsert(
        {
          client_id: targetClientId,
          client_name: targetClientName,
          sheet_bridge_baseline: payload,
          updated_at: nowIso,
        },
        { onConflict: "client_id" }
      );
    if (upErr) {
      throw new Error(`Failed migrating bridge baseline for ${targetClientName}: ${upErr.message}`);
    }

    // Lossless read-back check
    const { data: readBack, error: rbErr } = await supabase
      .from("pulse_master_sync_configs")
      .select("sheet_bridge_baseline")
      .eq("client_id", targetClientId)
      .maybeSingle();
    if (rbErr || JSON.stringify(readBack?.sheet_bridge_baseline || {}) !== JSON.stringify(payload)) {
      throw new Error(`Baseline read-back verification failed for ${targetClientName}.`);
    }

    migratedCount++;
    results.push({
      clientName: targetClientName,
      clientId: targetClientId,
      status: "migrated",
      driveVersion: String(payload?.driveVersion || ""),
      tabCount,
    });
  }

  return {
    dryRun: isDryRun,
    baselinesFound: (baselineRows || []).length,
    migratedCount,
    results,
  };
}

export async function verifyZeroGridReadiness({ clientName = null } = {}) {
  const checkedAt = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase admin client not configured.");

  const schema = await checkPhase6eRetirementSchemaStatus();

  const clientCols = [
    "id",
    "client_name",
    "status",
    "client_mode",
    "master_mode",
    "jobs_mode",
    "jobs_read_mode",
    "inputs_mode",
    "inputs_read_mode",
    "master_ingestion_mode",
    "master_read_mode",
    "recon_mode",
    "recon_read_mode",
    "financials_mode",
    "financials_read_mode",
    "client_compute_mode",
    "master_compute_mode",
    "connector_pull_mode",
    "sync_orchestrator_mode",
    ...(schema.schemaReady ? ["grid_storage_retired", "grid_retired_at"] : []),
    "metadata",
  ].join(", ");

  let clientQuery = supabase.from("clients").select(clientCols).order("client_name", { ascending: true });
  if (clientName) {
    clientQuery = clientQuery.ilike("client_name", escapeIlikeExact(String(clientName).trim()));
  }
  const { data: clients, error: cErr } = await clientQuery;
  if (cErr) throw new Error(`verifyZeroGridReadiness clients query failed: ${cErr.message}`);

  // Never select the full sheet_bridge_baseline JSONB blob across all tenants; use relBaselineRes below instead
  const syncSelect = "client_id, client_name, sync_orchestrator_backfilled_at";

  const clientIds = (clients || []).map((c) => c.id).filter(Boolean);
  const filterByClient = Boolean(clientName && clientIds.length > 0);
  const cleanClientPattern = clientName ? escapeIlikeExact(String(clientName).trim()) : null;

  const fetchPagedQuery_ = async (buildQuery, orderCol, label) => {
    const all = [];
    for (let from = 0; ; from += 1000) {
      let q = buildQuery().order(orderCol, { ascending: true }).range(from, from + 999);
      const { data: page, error: qErr } = await q;
      if (qErr) throw new Error(`verifyZeroGridReadiness ${label} query failed: ${qErr.message}`);
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      if (page.length < 1000) break;
    }
    return { data: all, error: null };
  };

  const [bpRes, finRes, syncRes, gridMetaRows, bridgeRes, relBaselineRes] = await Promise.all([
    fetchPagedQuery_(
      () => {
        let q = supabase.from("pulse_client_tab_blueprints").select("client_id");
        if (filterByClient) q = q.in("client_id", clientIds);
        return q;
      },
      "id",
      "blueprints"
    ),
    fetchPagedQuery_(
      () => {
        let q = supabase.from("pulse_financial_configs").select("client_id");
        if (filterByClient) q = q.in("client_id", clientIds);
        return q;
      },
      "client_id",
      "financials"
    ),
    fetchPagedQuery_(
      () => {
        let q = supabase.from("pulse_master_sync_configs").select(syncSelect);
        if (filterByClient) q = q.in("client_id", clientIds);
        return q;
      },
      "client_id",
      "sync configs"
    ),
    (async () => {
      const all = [];
      for (let from = 0; ; from += 1000) {
        let gq = supabase
          .from("master_sheet_grids")
          .select("client_name")
          .order("client_name", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + 999);
        if (cleanClientPattern) gq = gq.ilike("client_name", cleanClientPattern);
        const { data: page, error: gErr } = await gq;
        if (gErr) throw new Error(`verifyZeroGridReadiness master_sheet_grids query failed: ${gErr.message}`);
        if (!Array.isArray(page) || page.length === 0) break;
        all.push(...page);
        if (page.length < 1000) break;
      }
      return all;
    })(),
    fetchPagedQuery_(
      () => {
        let q = supabase
          .from("master_sheet_grids")
          .select("client_name")
          .eq("sheet_role", "master")
          .eq("tab_name", "SheetBridgeBaseline");
        if (cleanClientPattern) q = q.ilike("client_name", cleanClientPattern);
        return q;
      },
      "id",
      "bridge baseline"
    ),
    schema.schemaReady
      ? fetchPagedQuery_(
          () => {
            let q = supabase
              .from("pulse_master_sync_configs")
              .select("client_id")
              .not("sheet_bridge_baseline->tabs", "is", null);
            if (filterByClient) q = q.in("client_id", clientIds);
            return q;
          },
          "client_id",
          "relational bridge baseline"
        )
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (bpRes.error) throw new Error(`verifyZeroGridReadiness blueprints query failed: ${bpRes.error.message}`);
  if (finRes.error) throw new Error(`verifyZeroGridReadiness financials query failed: ${finRes.error.message}`);
  if (syncRes.error) throw new Error(`verifyZeroGridReadiness sync configs query failed: ${syncRes.error.message}`);
  if (bridgeRes.error) throw new Error(`verifyZeroGridReadiness bridge baseline query failed: ${bridgeRes.error.message}`);
  if (relBaselineRes.error) throw new Error(`verifyZeroGridReadiness relational bridge baseline query failed: ${relBaselineRes.error.message}`);

  const bpRows = bpRes.data;
  const finRows = finRes.data;
  const syncRows = syncRes.data;
  const bridgeRows = bridgeRes.data;
  const relBaselineSet = new Set((relBaselineRes.data || []).map((r) => r.client_id).filter(Boolean));

  const bpCountByClient = new Map();
  for (const r of bpRows || []) {
    if (r.client_id) bpCountByClient.set(r.client_id, (bpCountByClient.get(r.client_id) || 0) + 1);
  }
  const finSet = new Set((finRows || []).map((r) => r.client_id).filter(Boolean));
  const syncByClientId = new Map((syncRows || []).map((r) => [r.client_id, r]));
  const gridCountByName = new Map();
  for (const g of gridMetaRows || []) {
    if (g.client_name) gridCountByName.set(g.client_name, (gridCountByName.get(g.client_name) || 0) + 1);
  }
  const gridBaselineSet = new Set((bridgeRows || []).map((b) => b.client_name).filter(Boolean));

  const results = [];
  let totalRemainingGridRows = 0;

  for (const c of clients || []) {
    const blockers = [];
    const checkEq = (field, expected) => {
      const actual = String(c[field] || c.metadata?.[field] || "").trim().toLowerCase();
      if (actual !== expected) blockers.push(`${field}=${actual || "unset"} (expected ${expected})`);
    };

    checkEq("client_mode", "supabase");
    checkEq("master_mode", "supabase");
    checkEq("jobs_mode", "relational");
    checkEq("jobs_read_mode", "relational");
    checkEq("inputs_mode", "relational");
    checkEq("inputs_read_mode", "relational");
    checkEq("master_ingestion_mode", "relational");
    checkEq("master_read_mode", "relational");
    checkEq("recon_mode", "relational");
    checkEq("recon_read_mode", "relational");
    checkEq("financials_mode", "relational");
    checkEq("financials_read_mode", "relational");
    checkEq("client_compute_mode", "native");
    checkEq("master_compute_mode", "native");
    checkEq("connector_pull_mode", "native");
    checkEq("sync_orchestrator_mode", "native");

    const bpCount = bpCountByClient.get(c.id) || 0;
    if (bpCount === 0) blockers.push("missing pulse_client_tab_blueprints");
    if (!finSet.has(c.id)) blockers.push("missing pulse_financial_configs");
    const syncCfg = syncByClientId.get(c.id);
    if (!syncCfg) {
      blockers.push("missing pulse_master_sync_configs");
    } else if (!syncCfg.sync_orchestrator_backfilled_at) {
      blockers.push("missing sync_orchestrator_backfilled_at");
    }

    const hasGridBaseline = gridBaselineSet.has(c.client_name);
    const hasRelationalBaseline = relBaselineSet.has(c.id);
    const bridgeMode = String(c.metadata?.sheet_bridge_mode || "off").trim().toLowerCase();
    if (schema.schemaReady && (hasGridBaseline || bridgeMode !== "off") && !hasRelationalBaseline) {
      blockers.push("SheetBridgeBaseline not yet migrated to pulse_master_sync_configs");
    }

    const remainingGridRows = gridCountByName.get(c.client_name) || 0;
    totalRemainingGridRows += remainingGridRows;

    const ready = blockers.length === 0;
    results.push({
      clientName: c.client_name,
      clientId: c.id,
      status: String(c.status || "live").toLowerCase(),
      gridStorageRetired: Boolean(c.grid_storage_retired),
      gridRetiredAt: c.grid_retired_at || null,
      blueprintTabsCount: bpCount,
      hasRelationalBaseline,
      hasLegacyGridBaseline: hasGridBaseline,
      remainingGridRows,
      ready,
      blockers,
    });
  }

  return {
    checkedAt,
    schemaReady: schema.schemaReady,
    clientsChecked: results.length,
    readyClientsCount: results.filter((r) => r.ready).length,
    notReadyClientsCount: results.filter((r) => !r.ready).length,
    retiredClientsCount: results.filter((r) => r.gridStorageRetired).length,
    totalRemainingGridRows,
    results,
  };
}

export async function retireClientGridStorage(
  clientName,
  {
    dryRun = true,
    createSafetyBackup = true,
    triggeredBy = "Admin",
  } = {}
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase admin client not configured.");
  if (!clientName || !String(clientName).trim()) {
    throw new Error("clientName is required.");
  }

  const isDryRun = dryRun !== false;
  const schema = await checkPhase6eRetirementSchemaStatus({ forceRefresh: true });
  if (!isDryRun && !schema.schemaReady) {
    throw new Error("Migration 0020 must be applied before retiring grid storage.");
  }

  // Migrate baseline automatically if present before readiness validation
  if (!isDryRun) {
    await migrateSheetBridgeBaselinesToRelational({ clientName, dryRun: false });
  }

  const readiness = await verifyZeroGridReadiness({ clientName });
  const target = readiness.results?.[0];
  if (!target) throw new Error(`Client "${clientName}" not found.`);

  if (!isDryRun && !target.ready) {
    throw new Error(
      `Cannot retire grid storage for ${target.clientName}: ${target.blockers.join("; ")}`
    );
  }

  if (isDryRun) {
    return {
      dryRun: true,
      clientName: target.clientName,
      ready: target.ready,
      blockers: target.blockers,
      wouldPurgeGridRows: target.remainingGridRows,
      alreadyRetired: target.gridStorageRetired,
    };
  }

  let safetySnapshotId = null;
  if (createSafetyBackup) {
    const { createClientSnapshot } = await import("./supabaseBackupService.js");
    const snap = await createClientSnapshot({
      clientName: target.clientName,
      triggerType: "pre_grid_retirement",
      label: "Pre-Phase 6E grid retirement snapshot (Format v2)",
      createdBy: triggeredBy,
    });
    safetySnapshotId = snap?.id || null;
  }

  const nowIso = new Date().toISOString();
  const { data: curClient, error: curErr } = await supabase
    .from("clients")
    .select("metadata")
    .eq("id", target.clientId)
    .maybeSingle();
  if (curErr || !curClient) {
    throw new Error(curErr?.message || `Failed reading client metadata for ${target.clientName}.`);
  }

  const nextMeta = {
    ...(curClient.metadata || {}),
    grid_retirement_state: {
      retiredAt: nowIso,
      purgedGridRows: target.remainingGridRows,
      safetySnapshotId,
      triggeredBy,
    },
  };

  const { error: upErr } = await supabase
    .from("clients")
    .update({
      grid_storage_retired: true,
      grid_retired_at: nowIso,
      metadata: nextMeta,
    })
    .eq("id", target.clientId);
  if (upErr) {
    throw new Error(`Failed setting grid_storage_retired for ${target.clientName}: ${upErr.message}`);
  }

  if (target.remainingGridRows > 0) {
    const { error: delErr } = await supabase
      .from("master_sheet_grids")
      .delete()
      .eq("client_name", target.clientName);
    if (delErr) {
      throw new Error(`Failed purging master_sheet_grids for ${target.clientName}: ${delErr.message}`);
    }
  }

  const [
    { invalidateMasterEngineCache },
    { invalidateClientRelationalMasterCache },
    { invalidateClientRelationalReconCache },
  ] = await Promise.all([
    import("./masterEngineService.js"),
    import("./relationalMasterService.js"),
    import("./relationalReconService.js"),
  ]);
  invalidateMasterEngineCache(target.clientName);
  invalidateClientRelationalMasterCache(target.clientName);
  invalidateClientRelationalReconCache(target.clientName);

  return {
    dryRun: false,
    clientName: target.clientName,
    retired: true,
    retiredAt: nowIso,
    purgedGridRows: target.remainingGridRows,
    safetySnapshotId,
  };
}

export async function retireAllClientsGridStorage({
  dryRun = true,
  createSafetyBackup = true,
  triggeredBy = "Admin",
} = {}) {
  const readiness = await verifyZeroGridReadiness();
  const results = [];
  for (const r of readiness.results || []) {
    try {
      results.push(
        await retireClientGridStorage(r.clientName, {
          dryRun,
          createSafetyBackup,
          triggeredBy,
        })
      );
    } catch (err) {
      results.push({
        dryRun: dryRun !== false,
        clientName: r.clientName,
        error: err.message,
      });
    }
  }
  return {
    dryRun: dryRun !== false,
    clientsProcessed: results.length,
    retiredCount: results.filter((r) => r.retired || r.wouldPurgeGridRows >= 0).length,
    totalPurgedOrEligibleRows: results.reduce(
      (sum, r) => sum + (Number(r.purgedGridRows ?? r.wouldPurgeGridRows) || 0),
      0
    ),
    results,
  };
}
