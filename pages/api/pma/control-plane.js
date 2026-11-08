import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { setControlPlaneSource } from "../../../services/supabaseClient.js";
import { getControlPlaneStatus, syncControlPlaneToSupabase } from "../../../services/controlPlaneMigrationService.js";
import { logPmaActivity } from "../../../services/pmaLogger.js";
import { getAllUsers, createOrUpdateUser, deleteUserByEmail, getCanonicalAcSheetId } from "../../../services/userPermissions.js";
import { getAllClients } from "../../../services/workspaces.js";
import { flushAllAlertMemoryCaches, searchAlertMemoryEntries, deleteAlertMemoryEntryByHash } from "../../../services/alertMemory.js";
import { invalidatePrecomputedMemoryCache, handleStorePrecomputed } from "../../../services/triageEngine.js";

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
      status: () => ({ json: () => {} }),
    };
    await handleStorePrecomputed(mockReq, mockRes, sheets);
  } catch (err) {
    console.warn("⚠️ refreshPrecomputedAlerts_ warning:", err.message);
  }
}

export const config = {
  maxDuration: 120,
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
      const status = await getControlPlaneStatus();
      return res.status(200).json({ success: true, ...status });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "Method not allowed." });
    }

    const { action, mode, automationCommanderSheetId } = req.body || {};

    if (!action || action === "status") {
      const status = await getControlPlaneStatus();
      return res.status(200).json({ success: true, ...status });
    }

    if (action === "sync_to_supabase") {
      const sheets = await getSheetsClient();
      const acId = automationCommanderSheetId || getCanonicalAcSheetId();
      const result = await syncControlPlaneToSupabase({
        sheets,
        automationCommanderSheetId: acId,
        userEmail: sessionUser.email || "Admin",
      });
      await flushAllAlertMemoryCaches(acId);
      await refreshPrecomputedAlerts_(sheets, acId);
      const status = await getControlPlaneStatus();
      return res.status(200).json({
        ...result,
        status,
      });
    }

    if (action === "set_source") {
      if (mode !== "sheets" && mode !== "supabase") {
        return res.status(400).json({ success: false, error: "Invalid source mode. Expected 'sheets' or 'supabase'." });
      }
      const acId = automationCommanderSheetId || getCanonicalAcSheetId();
      const newMode = await setControlPlaneSource(mode, sessionUser.email || "Admin");
      await flushAllAlertMemoryCaches(acId);
      invalidatePrecomputedMemoryCache();
      await logPmaActivity({
        automationCommanderSheetId: acId,
        category: "SYSTEM",
        action: "CONTROL_PLANE_SOURCE_CHANGED",
        summary: `Switched active Control Plane source to "${newMode}"`,
        details: { mode: newMode },
        userEmail: sessionUser.email || "Admin",
      });
      const status = await getControlPlaneStatus();
      return res.status(200).json({
        success: true,
        activeSource: newMode,
        status,
      });
    }

    if (action === "search_alert_memory") {
      const { query = "", clientName = "", status = "all", limit = 50 } = req.body || {};
      const acId = automationCommanderSheetId || getCanonicalAcSheetId();
      const sheets = await getSheetsClient();
      const entries = await searchAlertMemoryEntries(sheets, acId, {
        query,
        clientName,
        status,
        limit,
      });
      return res.status(200).json({ success: true, entries });
    }

    if (action === "delete_alert_memory") {
      const { fingerprintHash } = req.body || {};
      if (!fingerprintHash) {
        return res.status(400).json({ success: false, error: "fingerprintHash is required." });
      }
      const acId = automationCommanderSheetId || getCanonicalAcSheetId();
      const sheets = await getSheetsClient();
      const result = await deleteAlertMemoryEntryByHash(sheets, acId, fingerprintHash);
      await refreshPrecomputedAlerts_(sheets, acId);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: result.clientName || "System",
        category: "TRIAGE",
        action: "ALERT_MEMORY_ENTRY_DELETED",
        summary: `Deleted AlertMemory entry ${fingerprintHash} across Supabase, Google Sheet, and Redis cache`,
        details: result,
        userEmail: sessionUser.email || "Admin",
      });
      const status = await getControlPlaneStatus();
      return res.status(200).json({ ...result, status });
    }

    if (action === "flush_alert_memory_cache") {
      const acId = automationCommanderSheetId || getCanonicalAcSheetId();
      const sheets = await getSheetsClient();
      await flushAllAlertMemoryCaches(acId);
      await refreshPrecomputedAlerts_(sheets, acId);
      return res.status(200).json({ success: true });
    }

    if (action === "list_users") {
      const sheets = await getSheetsClient();
      const [users, clientsRes] = await Promise.all([
        getAllUsers(sheets, automationCommanderSheetId, true),
        getAllClients(sheets, sessionUser, false, automationCommanderSheetId).catch(() => ({ clientsArray: [] })),
      ]);
      const clientNames = (clientsRes?.clientsArray || []).map(c => c.clientName).filter(Boolean).sort();
      return res.status(200).json({
        success: true,
        users,
        clientNames,
      });
    }

    if (action === "save_user") {
      const { userPayload } = req.body || {};
      if (!userPayload || !userPayload.email) {
        return res.status(400).json({ success: false, error: "User email is required." });
      }
      const sheets = await getSheetsClient();
      const result = await createOrUpdateUser(sheets, {
        ...userPayload,
        actorEmail: sessionUser.email || "Admin",
      });
      await logPmaActivity(sheets, {
        automationCommanderSheetId,
        category: "SECURITY",
        action: result.isNew ? "USER_CREATED" : "USER_UPDATED",
        summary: `${result.isNew ? "Added" : "Updated"} user ${result.user?.email || userPayload.email} (${result.user?.role || userPayload.role})`,
        details: {
          email: result.user?.email || userPayload.email,
          name: result.user?.name || userPayload.name,
          role: result.user?.role || userPayload.role,
          assignedClients: result.user?.assignedClients,
          status: result.user?.status,
          dailyAlertsEmail: result.user?.dailyAlertsEmail,
        },
        userEmail: sessionUser.email || "Admin",
      });
      return res.status(200).json(result);
    }

    if (action === "delete_user") {
      const { email } = req.body || {};
      if (!email) {
        return res.status(400).json({ success: false, error: "User email is required." });
      }
      const sheets = await getSheetsClient();
      const result = await deleteUserByEmail(sheets, {
        email,
        actorEmail: sessionUser.email || "Admin",
      });
      await logPmaActivity(sheets, {
        automationCommanderSheetId,
        category: "SECURITY",
        action: "USER_DELETED",
        summary: `Deleted user ${email}`,
        details: { email },
        userEmail: sessionUser.email || "Admin",
      });
      return res.status(200).json(result);
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("❌ /api/pma/control-plane error:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
    });
  }
}
