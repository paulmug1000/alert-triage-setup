import { waitUntil } from "@vercel/functions";
import { resolveLiveSessionUser, safeCompareSecret, getTrustedClientIp, checkRateLimit } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { getCanonicalAcSheetId } from "../../../services/userPermissions.js";
import { logPmaActivity } from "../../../services/pmaLogger.js";
import { invalidatePmaClientCache } from "../../../services/cacheService.js";
import { assertTrustedOrigin } from "../../../utils/helpers.js";
import { invalidatePrecomputedMemoryCache, handleStorePrecomputed } from "../../../services/triageEngine.js";
import {
  getStage2Status,
  migrateClientMasterAndReconToSupabase,
  setClientMasterMode,
  seedClientSheetToSupabase,
  setClientMode,
  materializeClientSheetFromMaster,
  restoreClientSheetImportranges,
  getVirtualTabForInspector,
  updateVirtualTabCellFromInspector,
  updateVirtualTabCellsFromInspector,
  getSupabaseClockStatusAndSyncConfig,
  setSupabaseClockEnabled,
  setSupabaseClockSchedule,
  triggerSupabaseClockNow,
  backfillNormalizedMirrorTablesFromVirtualGrids,
  clearPausedNormalizedMirrorTables,
} from "../../../services/masterEngineService.js";
import {
  runNativeMasterSync,
  runNativeMasterAmdAction,
  ensureFreshMasterComparisons,
  recomputeClientComparisonsInSupabase,
} from "../../../services/masterSyncEngine.js";
import {
  listClientSnapshots,
  createClientSnapshot,
  restoreClientSnapshot,
  getSnapshotCompressedBase64ById,
  importLocalSnapshotToCloud,
  deleteClientSnapshot,
  updateBackupPolicy,
  runDailyAutoBackupSweep,
} from "../../../services/supabaseBackupService.js";
import {
  setClientSheetBridgeMode,
  checkAndSyncClientSheetBridge,
  pushSupabaseClientToSheet,
  verifyBridgedClientsParity,
} from "../../../services/clientSheetBridgeService.js";

async function refreshPrecomputedAlerts_(sheets, acId) {
  invalidatePrecomputedMemoryCache();
  try {
    const mockReq = {
      body: {
        secret: (process.env.CRON_SECRET || "").trim(),
        automationCommanderSheetId: acId,
      },
      headers: {},
    };
    const mockRes = {
      status: () => ({ json: () => { } }),
    };
    await handleStorePrecomputed(mockReq, mockRes, sheets);
  } catch (err) {
    console.warn("[master-engine] refreshPrecomputedAlerts_ warning:", err.message);
  }
}

function scheduleBackgroundWork_(promise) {
  try {
    if (typeof waitUntil === "function") {
      waitUntil(promise);
    }
  } catch (_) {
    // Outside Vercel runtime, the unawaited promise continues in the event loop
  }
}

function scheduleAlertsRefreshInBackground_(sheets, acId) {
  invalidatePrecomputedMemoryCache();
  const job = refreshPrecomputedAlerts_(sheets, acId).catch((err) => {
    console.warn("[master-engine] background refreshPrecomputedAlerts_ warning:", err.message);
  });
  scheduleBackgroundWork_(job);
}

export const config = {
  maxDuration: 300,
  api: {
    bodyParser: {
      sizeLimit: "4mb",
    },
  },
};

export default async function handler(req, res) {
  const rl = await checkRateLimit("pma-master-engine", getTrustedClientIp(req), 120, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many master engine requests. Please retry shortly." });
  }

  const cronSecret = process.env.CRON_SECRET?.trim();
  const authHeader = String(req.headers.authorization || "").trim();
  const headerSecret = String(req.headers["x-cron-secret"] || "").trim();
  const expectedBearer = `Bearer ${cronSecret}`;
  const providedSecret = String(req.body?.secret || headerSecret || authHeader || "").trim();
  const isCronAuth = Boolean(
    cronSecret &&
    providedSecret &&
    (safeCompareSecret(providedSecret, cronSecret) ||
      safeCompareSecret(providedSecret, expectedBearer) ||
      (headerSecret && safeCompareSecret(headerSecret, cronSecret)))
  );

  const sessionUser = isCronAuth ? null : await resolveLiveSessionUser(req, res);
  if (!isCronAuth && (!sessionUser || !sessionUser.isAdmin || sessionUser.isReadOnly)) {
    return res.status(403).json({
      success: false,
      error: "Forbidden: System administrator access is required.",
    });
  }

  try {
    if (req.method === "GET") {
      const targetClient = String(req.query?.clientName || "APPTEST").trim();
      const status = await getStage2Status(targetClient);
      return res.status(200).json({ success: true, ...status });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "Method not allowed." });
    }
    if (!isCronAuth && !assertTrustedOrigin(req, res)) return;

    const {
      action,
      clientName = "APPTEST",
      masterMode,
      clientMode,
      syncType = "all",
      sheetRole = "master",
      tabName = "KeyInfo",
      maxRows = 300,
      maxCols = 500,
      rowIndex0,
      colIndex0,
      value,
      automationCommanderSheetId,
    } = req.body || {};

    const cleanClient = String(clientName || "APPTEST").trim();
    const acId = automationCommanderSheetId || getCanonicalAcSheetId();

    if (!action || action === "status") {
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, ...status });
    }

    if (action === "migrate_client") {
      const sheets = await getSheetsClient();
      const summary = await migrateClientMasterAndReconToSupabase(sheets, cleanClient);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "MASTER_RECON_MIGRATED_TO_SUPABASE",
        summary: `Migrated Master & Recon sheets for ${cleanClient} into Supabase (${summary.masterTabsSynced} master tabs, ${summary.reconTabsSynced} recon tabs)`,
        details: summary,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, summary, status });
    }

    if (action === "set_master_mode") {
      if (masterMode !== "sheet" && masterMode !== "supabase") {
        return res.status(400).json({ success: false, error: "Invalid masterMode. Expected 'sheet' or 'supabase'." });
      }
      const sheets = await getSheetsClient();
      const updated = await setClientMasterMode(cleanClient, masterMode);
      await refreshPrecomputedAlerts_(sheets, acId);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "CLIENT_MASTER_MODE_CHANGED",
        summary: `Switched ${cleanClient} master engine mode to "${masterMode}"`,
        details: { clientName: cleanClient, masterMode },
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, updated, status });
    }

    if (action === "seed_client_sheet") {
      const sheets = await getSheetsClient();
      const summary = await seedClientSheetToSupabase(sheets, cleanClient);
      await invalidatePmaClientCache(summary.clientSheetId, summary.masterSheetId, [
        "jobs",
        "invoices",
        "retainers",
        "outgoings",
        "views",
        "cash",
      ]).catch(() => { });
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "CLIENT_SHEET_SEEDED_TO_SUPABASE",
        summary: `Pushed Google Sheet data to Supabase for ${cleanClient} (${summary.clientTabsSynced} client tabs, ${summary.outgoingsNotesCount} outgoings notes)`,
        details: summary,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, summary, status });
    }

    if (action === "push_supabase_to_client_sheet") {
      const sheets = await getSheetsClient();
      const summary = await pushSupabaseClientToSheet(cleanClient);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "CLIENT_SUPABASE_PUSHED_TO_SHEET",
        summary: summary.summary || `Pushed Supabase data to Google Sheet for ${cleanClient}`,
        details: summary,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, summary, status });
    }

    if (action === "set_client_mode") {
      if (clientMode !== "sheet" && clientMode !== "supabase") {
        return res.status(400).json({ success: false, error: "Invalid clientMode. Expected 'sheet' or 'supabase'." });
      }
      const sheets = await getSheetsClient();
      const updated = await setClientMode(cleanClient, clientMode);
      await refreshPrecomputedAlerts_(sheets, acId);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "CLIENT_PORTAL_MODE_CHANGED",
        summary: `Switched ${cleanClient} client portal engine mode to "${clientMode}"`,
        details: { clientName: cleanClient, clientMode },
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, updated, status });
    }

    if (action === "set_sheet_bridge_mode") {
      const bridgeMode = String(req.body?.bridgeMode || "").trim().toLowerCase();
      if (!["off", "dry_run", "live"].includes(bridgeMode)) {
        return res.status(400).json({ success: false, error: "Invalid bridgeMode. Expected 'off', 'dry_run', or 'live'." });
      }
      const sheets = await getSheetsClient();
      const updated = await setClientSheetBridgeMode(sheets, cleanClient, bridgeMode);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "CLIENT_SHEET_BRIDGE_MODE_CHANGED",
        summary: `Switched ${cleanClient} Google Sheet bridge mode to "${bridgeMode}"`,
        details: updated,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, updated, status });
    }

    if (action === "sync_sheet_bridge_inbound") {
      const sheets = await getSheetsClient();
      const syncSummary = await checkAndSyncClientSheetBridge(cleanClient, {
        direction: "inbound",
        force: true,
        allowDryRunApplyInbound: Boolean(req.body?.applyInDryRun),
      });
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "CLIENT_SHEET_BRIDGE_INBOUND",
        summary: `Sheet bridge inbound check for ${cleanClient}: ${syncSummary.summary || syncSummary.reason || "complete"}`,
        details: syncSummary,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, syncSummary, status });
    }

    if (action === "verify_sheet_bridge_parity") {
      const targetClientFilter = req.body?.allBridged ? null : cleanClient;
      const parityReport = await verifyBridgedClientsParity({ clientName: targetClientFilter });
      return res.status(200).json({ success: true, parityReport });
    }

    if (action === "sync_sheet_bridge_outbound") {
      const sheets = await getSheetsClient();
      const syncSummary = await checkAndSyncClientSheetBridge(cleanClient, {
        direction: "outbound",
        force: true,
      });
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "CLIENT_SHEET_BRIDGE_OUTBOUND",
        summary: `Sheet bridge outbound check for ${cleanClient}: ${syncSummary.summary || syncSummary.reason || "complete"}`,
        details: syncSummary,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, syncSummary, status });
    }

    if (action === "verify_sheet_bridge_parity") {
      const targetClientFilter = req.body?.allBridged ? null : cleanClient;
      const parityReport = await verifyBridgedClientsParity({ clientName: targetClientFilter });
      return res.status(200).json({ success: true, parityReport });
    }

    if (action === "materialize_client_sheet") {
      const sheets = await getSheetsClient();
      const result = await materializeClientSheetFromMaster(sheets, cleanClient);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "CLIENT_SHEET_IMPORTRANGE_MATERIALIZED",
        summary: `Materialized ${result.materializedRangesCount} IMPORTRANGE ranges on ${cleanClient} Client Sheet`,
        details: result,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ ...result, status });
    }

    if (action === "restore_client_importranges") {
      const sheets = await getSheetsClient();
      const result = await restoreClientSheetImportranges(sheets, cleanClient);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "CLIENT_SHEET_IMPORTRANGE_RESTORED",
        summary: `Restored ${result.restoredRangesCount} IMPORTRANGE formulas on ${cleanClient} Client Sheet`,
        details: result,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ ...result, status });
    }

    if (action === "run_native_sync" || action === "run_native_master_sync") {
      const sheets = await getSheetsClient();
      if (syncType === "recompute") {
        const comparisons = await recomputeClientComparisonsInSupabase(sheets, cleanClient);
        if (!req.body?.skipAlertsRefresh && !isCronAuth) {
          scheduleAlertsRefreshInBackground_(sheets, acId);
        } else {
          invalidatePrecomputedMemoryCache();
        }
        const status = await getStage2Status(cleanClient);
        return res.status(200).json({
          success: true,
          syncResult: { clientName: cleanClient, syncType: "recompute", comparisons },
          status,
        });
      }
      const syncResult = await runNativeMasterSync({
        sheets,
        clientName: cleanClient,
        syncType,
        types: req.body?.types || null,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      });
      if (!req.body?.skipAlertsRefresh && !isCronAuth) {
        scheduleAlertsRefreshInBackground_(sheets, acId);
      } else {
        invalidatePrecomputedMemoryCache();
      }
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, syncResult, status });
    }

    if (action === "run_amd_action") {
      const amdAction = String(req.body?.amdAction || "").trim();
      if (!amdAction) {
        return res.status(400).json({ success: false, error: "amdAction is required." });
      }
      const sheets = await getSheetsClient();
      const userEmail = sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin");
      const amdResult = await runNativeMasterAmdAction({
        sheets,
        clientName: cleanClient,
        amdAction,
        userEmail,
      });
      if (!req.body?.skipAlertsRefresh && !isCronAuth) {
        scheduleAlertsRefreshInBackground_(sheets, acId);
      } else {
        invalidatePrecomputedMemoryCache();
      }
      scheduleBackgroundWork_(
        logPmaActivity(sheets, {
          automationCommanderSheetId: acId,
          clientName: cleanClient,
          category: "SYSTEM",
          action: `AMD_ACTION_${amdAction.toUpperCase()}`,
          summary: `Executed AMD action "${amdResult.label}" on ${cleanClient} (${amdResult.durationMs}ms)`,
          details: amdResult,
          userEmail,
        }).catch(() => { })
      );
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, amdResult, status });
    }

    if (action === "backfill_normalized_mirrors") {
      const sheets = await getSheetsClient();
      const summary = await backfillNormalizedMirrorTablesFromVirtualGrids(cleanClient);
      scheduleBackgroundWork_(
        logPmaActivity(sheets, {
          automationCommanderSheetId: acId,
          clientName: cleanClient,
          category: "SYSTEM",
          action: "NORMALIZED_MIRROR_TABLES_BACKFILLED",
          summary: `Backfilled normalised SQL mirror tables for ${cleanClient}`,
          details: summary,
          userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
        }).catch(() => { })
      );
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, summary, status });
    }

    if (action === "clear_paused_mirrors") {
      const sheets = await getSheetsClient();
      const summary = await clearPausedNormalizedMirrorTables({ force: Boolean(req.body?.force) });
      scheduleBackgroundWork_(
        logPmaActivity(sheets, {
          automationCommanderSheetId: acId,
          clientName: cleanClient,
          category: "SYSTEM",
          action: "PAUSED_MIRROR_TABLES_CLEARED",
          summary: `Cleared ${summary.totalDeleted || 0} stale row(s) across 14 paused SQL mirror tables`,
          details: summary,
          userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
        }).catch(() => { })
      );
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, summary, status });
    }

    if (action === "get_tab_grid") {
      const LIVE_COMPARISON_TABS = new Set([
        "InvComp",
        "DirComp",
        "CRMComp",
        "PLComp",
        "InvDashList",
        "DirDashList",
        "CRMList",
        "InvAppList",
        "JnlAppList",
        "ConfCalcs",
        "PipeCalcs",
      ]);
      if (req.body?.ensureFresh && sheetRole === "master" && LIVE_COMPARISON_TABS.has(tabName)) {
        try {
          const sheets = await getSheetsClient();
          await ensureFreshMasterComparisons(sheets, { clientName: cleanClient, maxAgeMs: 15000 });
        } catch (_) { }
      }
      const gridData = await getVirtualTabForInspector({
        clientName: cleanClient,
        sheetRole,
        tabName,
        maxRows: Number(maxRows) || 300,
        maxCols: Number(maxCols) || 500,
        includeFormulas: req.body?.includeFormulas !== undefined ? Boolean(req.body.includeFormulas) : true,
        includeRawValues: Boolean(req.body?.includeRawValues),
        includeNotes: Boolean(req.body?.includeNotes),
        trimTrailingEmptyRows: Boolean(req.body?.trimTrailingEmptyRows),
      });
      return res.status(200).json({ success: true, ...gridData });
    }

    if (action === "update_cell" || action === "update_cells") {
      const updatesList =
        action === "update_cells"
          ? req.body?.updates
          : rowIndex0 !== undefined && colIndex0 !== undefined
            ? [{ rowIndex0: Number(rowIndex0), colIndex0: Number(colIndex0), value: value ?? "" }]
            : null;
      if (!Array.isArray(updatesList) || updatesList.length === 0) {
        return res.status(400).json({
          success: false,
          error:
            action === "update_cells"
              ? "updates array is required."
              : "rowIndex0 and colIndex0 are required.",
        });
      }
      if (updatesList.length > 5000) {
        return res.status(400).json({
          success: false,
          error: "Too many cells in a single batch update (max 5000).",
        });
      }
      const sheets = await getSheetsClient();
      const updateRes =
        action === "update_cells"
          ? await updateVirtualTabCellsFromInspector({
            sheets,
            clientName: cleanClient,
            sheetRole,
            tabName,
            updates: updatesList,
          })
          : await updateVirtualTabCellFromInspector({
            sheets,
            clientName: cleanClient,
            sheetRole,
            tabName,
            rowIndex0: Number(rowIndex0),
            colIndex0: Number(colIndex0),
            value: value ?? "",
          });
      if (sheetRole === "client" && updateRes?.clientSheetId) {
        scheduleBackgroundWork_(
          invalidatePmaClientCache(updateRes.clientSheetId, updateRes.masterSheetId, [
            "jobs",
            "invoices",
            "retainers",
            "outgoings",
            "views",
            "cash",
          ]).catch(() => { })
        );
      }
      const rangeLabel = String(req.body?.rangeLabel || "").trim();
      const logSummary =
        updatesList.length === 1
          ? `Updated ${cleanClient} (${sheetRole}) ${tabName}!${updateRes.cellCoord} to "${updatesList[0]?.value ?? ""}"`
          : `Updated ${updatesList.length} cells in ${cleanClient} (${sheetRole}) ${tabName}${rangeLabel ? `!${rangeLabel}` : ""}`;
      scheduleBackgroundWork_(
        logPmaActivity(sheets, {
          automationCommanderSheetId: acId,
          clientName: cleanClient,
          category: "SYSTEM",
          action: updatesList.length === 1 ? "WORKBOOK_INSPECTOR_CELL_UPDATED" : "WORKBOOK_INSPECTOR_CELLS_UPDATED",
          summary: logSummary,
          details: updateRes,
          userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
        }).catch(() => { })
      );
      if (req.body?.returnUpdatedGrid) {
        const gridData = await getVirtualTabForInspector({
          clientName: cleanClient,
          sheetRole,
          tabName,
          maxRows: Number(maxRows) || 300,
          maxCols: Number(maxCols) || 500,
          includeFormulas: req.body?.includeFormulas !== undefined ? Boolean(req.body.includeFormulas) : true,
          includeRawValues: Boolean(req.body?.includeRawValues ?? true),
          includeNotes: Boolean(req.body?.includeNotes ?? true),
          trimTrailingEmptyRows: Boolean(req.body?.trimTrailingEmptyRows),
        });
        return res.status(200).json({ ...updateRes, gridData });
      }
      return res.status(200).json(updateRes);
    }

    if (action === "sync_clock_config") {
      await getSupabaseClockStatusAndSyncConfig(sessionUser?.email || "Admin");
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, status });
    }

    if (action === "set_clock_enabled") {
      const enabled = Boolean(req.body?.enabled);
      await setSupabaseClockEnabled(enabled, sessionUser?.email || "Admin");
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, status });
    }

    if (action === "set_clock_schedule") {
      const rawSchedule = String(req.body?.schedule || "").trim();
      const normalizedSchedule = rawSchedule === "*/1 * * * *" ? "* * * * *" : rawSchedule;
      const ALLOWED_CLOCK_SCHEDULES = new Set([
        "* * * * *",
        "*/2 * * * *",
        "*/5 * * * *",
        "*/10 * * * *",
        "*/15 * * * *",
        "*/30 * * * *",
      ]);
      if (!ALLOWED_CLOCK_SCHEDULES.has(normalizedSchedule)) {
        return res.status(400).json({ success: false, error: "Invalid cron schedule selection." });
      }
      await setSupabaseClockSchedule(normalizedSchedule, sessionUser?.email || "Admin");
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, status });
    }

    if (action === "trigger_clock_now") {
      const triggerResult = await triggerSupabaseClockNow(sessionUser?.email || "Admin");
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, triggerResult, status });
    }

    if (action === "list_backups") {
      const allClients = Boolean(req.body?.allClients);
      const data = await listClientSnapshots({ clientName: allClients ? null : cleanClient });
      return res.status(200).json({ success: true, ...data });
    }

    if (action === "create_backup") {
      const label = String(req.body?.label || "").trim();
      const snapshot = await createClientSnapshot({
        clientName: cleanClient,
        triggerType: "manual",
        label,
        createdBy: sessionUser?.email || "Admin",
      });
      const sheets = await getSheetsClient();
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "SUPABASE_SNAPSHOT_CREATED",
        summary: `Created Supabase workbook snapshot for ${cleanClient}${label ? ` ("${label}")` : ""}`,
        details: snapshot,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const backupList = await listClientSnapshots({ clientName: req.body?.allClients ? null : cleanClient });
      return res.status(200).json({ success: true, snapshot, ...backupList });
    }

    if (action === "download_backup") {
      const snapshotId = String(req.body?.snapshotId || "").trim();
      if (!snapshotId) {
        return res.status(400).json({ success: false, error: "snapshotId is required." });
      }
      const { entry, compressedBase64 } = await getSnapshotCompressedBase64ById(snapshotId);
      return res.status(200).json({ success: true, entry, compressedBase64 });
    }

    if (action === "restore_backup") {
      const snapshotId = String(req.body?.snapshotId || "").trim();
      const scope = String(req.body?.scope || "all").trim();
      const targetRole = req.body?.targetRole ? String(req.body.targetRole).trim() : null;
      const targetTabName = req.body?.targetTabName ? String(req.body.targetTabName).trim() : null;
      const createPreRestoreBackup = req.body?.createPreRestoreBackup !== false;

      const restoreResult = await restoreClientSnapshot({
        snapshotId,
        scope,
        targetRole,
        targetTabName,
        createPreRestoreBackup,
        restoredBy: sessionUser?.email || "Admin",
      });
      const sheets = await getSheetsClient();
      await refreshPrecomputedAlerts_(sheets, acId);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: restoreResult.clientName || cleanClient,
        category: "SYSTEM",
        action: "SUPABASE_SNAPSHOT_RESTORED",
        summary: `Restored ${restoreResult.restoredTabsCount} tab(s) (${scope === "single_tab" ? `${targetRole}:${targetTabName}` : scope}) for ${restoreResult.clientName || cleanClient} from snapshot ${snapshotId}`,
        details: restoreResult,
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });
      const [status, backupList] = await Promise.all([
        getStage2Status(cleanClient),
        listClientSnapshots({ clientName: req.body?.allClients ? null : cleanClient }),
      ]);
      return res.status(200).json({ success: true, restoreResult, status, ...backupList });
    }

    if (action === "import_backup") {
      const uploadedCompressedBase64 = String(req.body?.uploadedCompressedBase64 || "").trim();
      if (!uploadedCompressedBase64) {
        return res.status(400).json({ success: false, error: "uploadedCompressedBase64 is required." });
      }
      const label = String(req.body?.label || "").trim();
      const restoreImmediately = Boolean(req.body?.restoreImmediately);
      const scope = String(req.body?.scope || "all").trim();
      const targetRole = req.body?.targetRole ? String(req.body.targetRole).trim() : null;
      const targetTabName = req.body?.targetTabName ? String(req.body.targetTabName).trim() : null;
      const createPreRestoreBackup = req.body?.createPreRestoreBackup !== false;

      const importedEntry = await importLocalSnapshotToCloud({
        uploadedCompressedBase64,
        clientNameOverride: req.body?.useSelectedClient ? cleanClient : null,
        labelOverride: label,
        importedBy: sessionUser?.email || "Admin",
      });

      let restoreResult = null;
      if (restoreImmediately) {
        restoreResult = await restoreClientSnapshot({
          snapshotId: importedEntry.id,
          scope,
          targetRole,
          targetTabName,
          createPreRestoreBackup,
          restoredBy: sessionUser?.email || "Admin",
        });
      }

      const sheets = await getSheetsClient();
      if (restoreImmediately) {
        await refreshPrecomputedAlerts_(sheets, acId);
      }
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: importedEntry.clientName || cleanClient,
        category: "SYSTEM",
        action: restoreImmediately ? "SUPABASE_SNAPSHOT_IMPORTED_AND_RESTORED" : "SUPABASE_SNAPSHOT_IMPORTED",
        summary: restoreImmediately
          ? `Imported & restored ${restoreResult?.restoredTabsCount || 0} tab(s) for ${importedEntry.clientName}`
          : `Imported local snapshot file for ${importedEntry.clientName} into cloud backup catalogue`,
        details: { importedEntry, restoreResult },
        userEmail: sessionUser?.email || (isCronAuth ? "System (Scheduled Sync)" : "Admin"),
      }).catch(() => { });

      const [status, backupList] = await Promise.all([
        getStage2Status(cleanClient),
        listClientSnapshots({ clientName: req.body?.allClients ? null : cleanClient }),
      ]);
      return res.status(200).json({ success: true, importedEntry, restoreResult, status, ...backupList });
    }

    if (action === "delete_backup") {
      const snapshotId = String(req.body?.snapshotId || "").trim();
      const deleted = await deleteClientSnapshot({
        snapshotId,
        deletedBy: sessionUser?.email || "Admin",
      });
      const backupList = await listClientSnapshots({ clientName: req.body?.allClients ? null : cleanClient });
      return res.status(200).json({ success: true, ...deleted, ...backupList });
    }

    if (action === "update_backup_policy") {
      const policy = await updateBackupPolicy(
        {
          autoDailyEnabled: req.body?.autoDailyEnabled,
          retentionDays: req.body?.retentionDays,
        },
        sessionUser?.email || "Admin"
      );
      const backupList = await listClientSnapshots({ clientName: req.body?.allClients ? null : cleanClient });
      return res.status(200).json({ success: true, ...backupList, policy });
    }

    if (action === "run_daily_backup_sweep") {
      const sweepResult = await runDailyAutoBackupSweep({
        force: true,
        triggeredBy: sessionUser?.email || "Admin",
      });
      const backupList = await listClientSnapshots({ clientName: req.body?.allClients ? null : cleanClient });
      return res.status(200).json({ success: true, sweepResult, ...backupList });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("❌ /api/pma/master-engine error:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
    });
  }
}

