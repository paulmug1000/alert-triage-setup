import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { getCanonicalAcSheetId } from "../../../services/userPermissions.js";
import { logPmaActivity } from "../../../services/pmaLogger.js";
import { invalidatePrecomputedMemoryCache, handleStorePrecomputed } from "../../../services/triageEngine.js";
import {
  getStage2Status,
  migrateClientMasterAndReconToSupabase,
  setClientMasterMode,
  materializeClientSheetFromMaster,
  restoreClientSheetImportranges,
  getVirtualTabForInspector,
  updateVirtualTabCellFromInspector,
  getSupabaseClockStatusAndSyncConfig,
  setSupabaseClockEnabled,
  triggerSupabaseClockNow,
} from "../../../services/masterEngineService.js";
import {
  runNativeMasterSync,
  ensureFreshMasterComparisons,
  recomputeClientComparisonsInSupabase,
} from "../../../services/masterSyncEngine.js";

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

export const config = {
  maxDuration: 180,
};

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser || !sessionUser.isAdmin || sessionUser.isReadOnly) {
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

    const {
      action,
      clientName = "APPTEST",
      masterMode,
      syncType = "all",
      sheetRole = "master",
      tabName = "KeyInfo",
      maxRows = 300,
      maxCols = 60,
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
        userEmail: sessionUser.email || "Admin",
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
        userEmail: sessionUser.email || "Admin",
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, updated, status });
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
        userEmail: sessionUser.email || "Admin",
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
        userEmail: sessionUser.email || "Admin",
      }).catch(() => { });
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ ...result, status });
    }

    if (action === "run_native_sync") {
      const sheets = await getSheetsClient();
      if (syncType === "recompute") {
        const comparisons = await recomputeClientComparisonsInSupabase(sheets, cleanClient);
        await refreshPrecomputedAlerts_(sheets, acId);
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
        userEmail: sessionUser.email || "Admin",
      });
      await refreshPrecomputedAlerts_(sheets, acId);
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, syncResult, status });
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
      if (sheetRole === "master" && LIVE_COMPARISON_TABS.has(tabName)) {
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
        maxCols: Number(maxCols) || 60,
      });
      return res.status(200).json({ success: true, ...gridData });
    }

    if (action === "update_cell") {
      if (rowIndex0 === undefined || colIndex0 === undefined) {
        return res.status(400).json({ success: false, error: "rowIndex0 and colIndex0 are required." });
      }
      const sheets = await getSheetsClient();
      const updateRes = await updateVirtualTabCellFromInspector({
        sheets,
        clientName: cleanClient,
        sheetRole,
        tabName,
        rowIndex0: Number(rowIndex0),
        colIndex0: Number(colIndex0),
        value: value ?? "",
      });
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: cleanClient,
        category: "SYSTEM",
        action: "WORKBOOK_INSPECTOR_CELL_UPDATED",
        summary: `Updated ${cleanClient} (${sheetRole}) ${tabName}!${updateRes.cellCoord} to "${value ?? ""}"`,
        details: updateRes,
        userEmail: sessionUser.email || "Admin",
      }).catch(() => { });
      return res.status(200).json(updateRes);
    }

    if (action === "sync_clock_config") {
      await getSupabaseClockStatusAndSyncConfig(sessionUser.email || "Admin");
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, status });
    }

    if (action === "set_clock_enabled") {
      const enabled = Boolean(req.body?.enabled);
      await setSupabaseClockEnabled(enabled, sessionUser.email || "Admin");
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, status });
    }

    if (action === "trigger_clock_now") {
      const triggerResult = await triggerSupabaseClockNow(sessionUser.email || "Admin");
      const status = await getStage2Status(cleanClient);
      return res.status(200).json({ success: true, triggerResult, status });
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

