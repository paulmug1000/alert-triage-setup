import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import { getSupabaseAdmin, isSupabaseConfigured, setControlPlaneSource } from "../../../services/supabaseClient.js";
import { redisClient } from "../../../services/redisClient.js";
import { getControlPlaneStatus, syncControlPlaneToSupabase } from "../../../services/controlPlaneMigrationService.js";
import { logPmaActivity } from "../../../services/pmaLogger.js";
import { getAllUsers, createOrUpdateUser, deleteUserByEmail, getCanonicalAcSheetId } from "../../../services/userPermissions.js";
import { getAllClients, clearAllClientsMemoryCache } from "../../../services/workspaces.js";
import { flushAllAlertMemoryCaches, searchAlertMemoryEntries, deleteAlertMemoryEntryByHash } from "../../../services/alertMemory.js";
import { invalidatePrecomputedMemoryCache, handleStorePrecomputed } from "../../../services/triageEngine.js";

const VALID_CLIENT_STATUSES = new Set(["live", "setup", "paused", "archived"]);
const VALID_ENGINE_MODES = new Set(["sheet", "supabase", "shadow"]);

function normalizeClientKey_(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function extractDriveFolderId_(val) {
  const str = String(val || "").trim();
  if (!str) return "";
  const match = str.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : str;
}

function buildClientRegistryPayload_(raw = {}) {
  const clientName = String(raw.client_name || "").trim();
  if (!clientName) {
    throw new Error("Client name is required.");
  }
  const normalizedKey = normalizeClientKey_(clientName);
  if (!normalizedKey) {
    throw new Error(`Invalid client name "${clientName}".`);
  }

  const rawStatus = String(raw.status || "live").trim().toLowerCase();
  const status = VALID_CLIENT_STATUSES.has(rawStatus) ? rawStatus : "live";

  const rawMasterMode = String(raw.master_mode || "sheet").trim().toLowerCase();
  const masterMode = VALID_ENGINE_MODES.has(rawMasterMode) ? rawMasterMode : "sheet";

  const rawClientMode = String(raw.client_mode || "sheet").trim().toLowerCase();
  const clientMode = VALID_ENGINE_MODES.has(rawClientMode) ? rawClientMode : "sheet";

  const clientSheetUrl = String(raw.client_sheet_url || "").trim();
  const masterSheetUrl = String(raw.master_sheet_url || "").trim();
  const reconSheetUrl = String(raw.recon_sheet_url || "").trim();
  const backupSheetUrl = String(raw.backup_sheet_url || "").trim();

  const parsedRowIndex = parseInt(String(raw.tracker_row_index ?? "").trim(), 10);
  const trackerRowIndex = Number.isFinite(parsedRowIndex) ? parsedRowIndex : null;

  const shortCodeRaw = String(raw.short_code || "").trim();

  return {
    client_name: clientName,
    normalized_key: normalizedKey,
    short_code: shortCodeRaw || null,
    service_type: String(raw.service_type || "").trim(),
    status,
    master_mode: masterMode,
    client_mode: clientMode,
    version_in_use: String(raw.version_in_use || "").trim(),
    webapp_version: String(raw.webapp_version || "").trim(),
    client_sheet_url: clientSheetUrl,
    master_sheet_url: masterSheetUrl,
    recon_sheet_url: reconSheetUrl,
    backup_sheet_url: backupSheetUrl,
    client_sheet_id: extractSheetIdFromUrl(clientSheetUrl) || String(raw.client_sheet_id || "").trim(),
    master_sheet_id: extractSheetIdFromUrl(masterSheetUrl) || String(raw.master_sheet_id || "").trim(),
    recon_sheet_id: extractSheetIdFromUrl(reconSheetUrl) || String(raw.recon_sheet_id || "").trim(),
    drive_folder_id: extractDriveFolderId_(raw.drive_folder_id),
    reports_folder_id: extractDriveFolderId_(raw.reports_folder_id),
    client_script_id: String(raw.client_script_id || "").trim(),
    master_script_id: String(raw.master_script_id || "").trim(),
    recon_script_id: String(raw.recon_script_id || "").trim(),
    master_deployment_url: String(raw.master_deployment_url || "").trim(),
    web_app_url: String(raw.web_app_url || "").trim(),
    tracker_row_index: trackerRowIndex,
  };
}

async function upsertClientRegistryRecord_(sb, rawRow) {
  const payload = buildClientRegistryPayload_(rawRow);
  const existingId = rawRow?.id && !String(rawRow.id).startsWith("__new_") ? String(rawRow.id).trim() : null;

  if (existingId) {
    const { data, error } = await sb
      .from("clients")
      .update(payload)
      .eq("id", existingId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  const { data, error } = await sb
    .from("clients")
    .upsert(payload, { onConflict: "normalized_key" })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function invalidateClientsCache_(acId) {
  clearAllClientsMemoryCache();
  if (!redisClient?.isOpen) return;
  const keys = new Set();
  const canonicalAcId = acId || getCanonicalAcSheetId();
  if (canonicalAcId) keys.add(`pulse:all_clients:${canonicalAcId}`);
  if (process.env.AUTOMATION_COMMANDER_SHEET_ID) {
    keys.add(`pulse:all_clients:${process.env.AUTOMATION_COMMANDER_SHEET_ID}`);
  }
  for (const k of keys) {
    await redisClient.del(k).catch(() => {});
  }
}

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

    if (action === "list_clients_registry") {
      if (!isSupabaseConfigured()) {
        return res.status(400).json({ success: false, error: "Supabase is not configured." });
      }
      const sb = getSupabaseAdmin();
      const [{ data: clientRows, error: clientErr }, { data: tplRow }] = await Promise.all([
        sb
          .from("clients")
          .select("*")
          .order("tracker_row_index", { ascending: true, nullsFirst: false })
          .order("client_name", { ascending: true }),
        sb
          .from("system_config")
          .select("value")
          .eq("key", "client_provisioning_templates")
          .maybeSingle(),
      ]);
      if (clientErr) throw new Error(clientErr.message);
      return res.status(200).json({
        success: true,
        clients: clientRows || [],
        templates: tplRow?.value || null,
      });
    }

    if (action === "save_client_registry_row") {
      if (!isSupabaseConfigured()) {
        return res.status(400).json({ success: false, error: "Supabase is not configured." });
      }
      const { row } = req.body || {};
      if (!row || !String(row.client_name || "").trim()) {
        return res.status(400).json({ success: false, error: "Client name is required." });
      }
      const sb = getSupabaseAdmin();
      const saved = await upsertClientRegistryRecord_(sb, row);
      await invalidateClientsCache_(automationCommanderSheetId);
      const sheets = await getSheetsClient().catch(() => null);
      await logPmaActivity(sheets, {
        automationCommanderSheetId,
        clientName: saved.client_name,
        category: "SYSTEM",
        action: "CLIENT_REGISTRY_SAVED",
        summary: `Saved client registry record for "${saved.client_name}" (status: ${saved.status}, master: ${saved.master_mode}, portal: ${saved.client_mode})`,
        details: {
          clientId: saved.id,
          status: saved.status,
          masterMode: saved.master_mode,
          clientMode: saved.client_mode,
          versionInUse: saved.version_in_use,
        },
        userEmail: sessionUser.email || "Admin",
      }).catch(() => {});
      return res.status(200).json({ success: true, client: saved });
    }

    if (action === "save_client_registry_batch") {
      if (!isSupabaseConfigured()) {
        return res.status(400).json({ success: false, error: "Supabase is not configured." });
      }
      const { rows } = req.body || {};
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ success: false, error: "At least one client row is required." });
      }
      const sb = getSupabaseAdmin();
      const savedClients = [];
      for (const row of rows) {
        const saved = await upsertClientRegistryRecord_(sb, row);
        savedClients.push(saved);
      }
      await invalidateClientsCache_(automationCommanderSheetId);
      const sheets = await getSheetsClient().catch(() => null);
      await logPmaActivity(sheets, {
        automationCommanderSheetId,
        clientName: savedClients.length === 1 ? savedClients[0].client_name : "Global",
        category: "SYSTEM",
        action: "CLIENT_REGISTRY_SAVED",
        summary: `Batch saved ${savedClients.length} client registry record${savedClients.length === 1 ? "" : "s"}: ${savedClients.map(c => c.client_name).join(", ")}`,
        details: { count: savedClients.length, clients: savedClients.map(c => c.client_name) },
        userEmail: sessionUser.email || "Admin",
      }).catch(() => {});
      return res.status(200).json({ success: true, clients: savedClients });
    }

    if (action === "delete_client_registry_row") {
      if (!isSupabaseConfigured()) {
        return res.status(400).json({ success: false, error: "Supabase is not configured." });
      }
      const { id, clientName } = req.body || {};
      const cleanId = String(id || "").trim();
      const cleanName = String(clientName || "").trim();
      if (!cleanId && !cleanName) {
        return res.status(400).json({ success: false, error: "Client ID or name is required." });
      }
      const sb = getSupabaseAdmin();
      let query = sb.from("clients").delete();
      query = cleanId ? query.eq("id", cleanId) : query.eq("client_name", cleanName);
      const { error: delErr } = await query;
      if (delErr) throw new Error(delErr.message);

      await invalidateClientsCache_(automationCommanderSheetId);
      const sheets = await getSheetsClient().catch(() => null);
      await logPmaActivity(sheets, {
        automationCommanderSheetId,
        clientName: cleanName || "Global",
        category: "SYSTEM",
        action: "CLIENT_REGISTRY_DELETED",
        summary: `Deleted client registry record "${cleanName || cleanId}"`,
        details: { id: cleanId || null, clientName: cleanName || null },
        userEmail: sessionUser.email || "Admin",
      }).catch(() => {});
      return res.status(200).json({ success: true });
    }

    if (action === "save_provisioning_templates") {
      if (!isSupabaseConfigured()) {
        return res.status(400).json({ success: false, error: "Supabase is not configured." });
      }
      const t = req.body?.templates || req.body || {};
      const templatesPayload = {
        clientTemplateId: String(t.clientTemplateId || "").trim(),
        masterTemplateId: String(t.masterTemplateId || "").trim(),
        reconTemplateId: String(t.reconTemplateId || "").trim(),
        clientTemplateScriptId: String(t.clientTemplateScriptId || "").trim(),
        masterTemplateScriptId: String(t.masterTemplateScriptId || "").trim(),
        reconTemplateScriptId: String(t.reconTemplateScriptId || "").trim(),
        updatedAt: new Date().toISOString(),
        updatedBy: sessionUser.email || "Admin",
      };
      const sb = getSupabaseAdmin();
      const { error: tplErr } = await sb.from("system_config").upsert({
        key: "client_provisioning_templates",
        value: templatesPayload,
        description: "Template Google Sheet and Apps Script IDs used when provisioning new clients",
        updated_by: sessionUser.email || "Admin",
      });
      if (tplErr) throw new Error(tplErr.message);
      if (redisClient?.isOpen) {
        await redisClient.del("pulse:setup:provisioning_templates").catch(() => {});
      }
      const sheets = await getSheetsClient().catch(() => null);
      await logPmaActivity(sheets, {
        automationCommanderSheetId,
        category: "SYSTEM",
        action: "PROVISIONING_TEMPLATES_SAVED",
        summary: "Updated client provisioning template sheet and script IDs",
        details: templatesPayload,
        userEmail: sessionUser.email || "Admin",
      }).catch(() => {});
      return res.status(200).json({ success: true, templates: templatesPayload });
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
