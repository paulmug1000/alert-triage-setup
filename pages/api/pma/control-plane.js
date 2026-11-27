import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import { getSupabaseAdmin, isSupabaseConfigured, setControlPlaneSource } from "../../../services/supabaseClient.js";
import { redisClient } from "../../../services/redisClient.js";
import { getControlPlaneStatus, syncControlPlaneToSupabase } from "../../../services/controlPlaneMigrationService.js";
import { logPmaActivity } from "../../../services/pmaLogger.js";
import { getAllUsers, createOrUpdateUser, deleteUserByEmail, getCanonicalAcSheetId, clearClientMappingCaches, invalidateUsersCache } from "../../../services/userPermissions.js";
import { getAllClients, clearAllClientsMemoryCache } from "../../../services/workspaces.js";
import { clearSsrClientsMemoryCache } from "../../../services/ssrSession.js";
import { memoryCache } from "../../../services/cacheService.js";
import { invalidateTasksCache } from "../../../services/tasksController.js";
import { flushAllAlertMemoryCaches, searchAlertMemoryEntries, deleteAlertMemoryEntryByHash, archiveClientAlertMemory } from "../../../services/alertMemory.js";
import { invalidatePrecomputedMemoryCache, handleStorePrecomputed } from "../../../services/triageEngine.js";
import { syncProvisioningTemplateSnapshots, getProvisioningTemplateSnapshotsMeta } from "../../../services/masterEngineService.js";
import { renameTenantClient } from "../../../services/tenantRenameService.js";
import { assertTrustedOrigin } from "../../../utils/helpers.js";

const VALID_CLIENT_STATUSES = new Set(["live", "setup", "paused", "suspended", "archived"]);
const VALID_ENGINE_MODES = new Set(["sheet", "supabase", "shadow"]);
const EXCLUDED_CLIENT_STATUSES = new Set(["inactive", "archived", "suspended"]);

function isExcludedClientStatus_(status) {
  return EXCLUDED_CLIENT_STATUSES.has(String(status || "").trim().toLowerCase());
}

function normalizeClientStatusFromDb_(row) {
  if (!row || typeof row !== "object") return row;
  const override = String(row?.metadata?.statusOverride || "").trim().toLowerCase();
  if (override && VALID_CLIENT_STATUSES.has(override)) {
    return { ...row, status: override };
  }
  return row;
}

function normalizeClientKey_(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function extractDriveFolderId_(val) {
  const str = String(val || "").trim();
  if (!str) return "";
  const match = str.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : str;
}

function buildClientRegistryPayload_(raw = {}, { isUpdate = false } = {}) {
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

  const clientSheetUrl = String(raw.client_sheet_url || "").trim();
  const masterSheetUrl = String(raw.master_sheet_url || "").trim();
  const reconSheetUrl = String(raw.recon_sheet_url || "").trim();
  const backupSheetUrl = String(raw.backup_sheet_url || "").trim();

  const payload = {
    client_name: clientName,
    normalized_key: normalizedKey,
    status,
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
  };

  if (!isUpdate) {
    const rawMasterMode = String(raw.master_mode || "sheet").trim().toLowerCase();
    const rawClientMode = String(raw.client_mode || "sheet").trim().toLowerCase();
    const parsedRowIndex = parseInt(String(raw.tracker_row_index ?? "").trim(), 10);
    const shortCodeRaw = String(raw.short_code || "").trim();

    payload.short_code = shortCodeRaw || null;
    payload.service_type = String(raw.service_type || "").trim();
    payload.version_in_use = String(raw.version_in_use || "").trim();
    payload.master_mode = VALID_ENGINE_MODES.has(rawMasterMode) ? rawMasterMode : "sheet";
    payload.client_mode = VALID_ENGINE_MODES.has(rawClientMode) ? rawClientMode : "sheet";
    payload.tracker_row_index = Number.isFinite(parsedRowIndex) ? parsedRowIndex : null;
  }

  return payload;
}

async function syncReportsFolderToEomConfig_(sb, savedClients, actorEmail = "Admin") {
  if (!Array.isArray(savedClients) || savedClients.length === 0) return;
  try {
    const { data: cfgRow, error } = await sb
      .from("system_config")
      .select("value")
      .eq("key", "eom_reporting_control_state")
      .maybeSingle();
    if (error || !cfgRow?.value || typeof cfgRow.value !== "object") return;

    const state = { ...cfgRow.value };
    const configsByClient = { ...(state.configsByClient || {}) };
    let changed = false;

    for (const c of savedClients) {
      if (!c?.client_name) continue;
      const existingKey =
        Object.keys(configsByClient).find(k => k.trim().toLowerCase() === c.client_name.trim().toLowerCase()) ||
        c.client_name;
      const targetUrl = c.reports_folder_id
        ? `https://drive.google.com/drive/folders/${c.reports_folder_id}`
        : "";
      const prevConf = configsByClient[existingKey] || {};
      if (String(prevConf.folderUrl || "") !== targetUrl) {
        configsByClient[existingKey] = {
          ...prevConf,
          folderUrl: targetUrl,
          updatedAt: new Date().toISOString(),
        };
        changed = true;
      }
    }

    if (changed) {
      state.configsByClient = configsByClient;
      await sb.from("system_config").upsert({
        key: "eom_reporting_control_state",
        value: state,
        updated_by: actorEmail || "Admin",
      });
    }
  } catch (err) {
    console.warn("syncReportsFolderToEomConfig_ warning:", err.message);
  }
}

async function upsertClientRegistryRecord_(sb, rawRow) {
  const existingId = rawRow?.id && !String(rawRow.id).startsWith("__new_") ? String(rawRow.id).trim() : null;

  if (existingId) {
    const payload = buildClientRegistryPayload_(rawRow, { isUpdate: true });
    const { data: existingRow, error: existingErr } = await sb
      .from("clients")
      .select("id, client_name, metadata, client_sheet_id, master_sheet_id, recon_sheet_id, client_mode, master_mode")
      .eq("id", existingId)
      .maybeSingle();
    if (existingErr) {
      throw new Error(`Failed loading client "${existingId}": ${existingErr.message}`);
    }
    if (!existingRow) {
      throw new Error(`Client "${existingId}" was not found.`);
    }

    if (
      existingRow?.client_name &&
      payload.client_name &&
      String(existingRow.client_name).trim() !== String(payload.client_name).trim()
    ) {
      throw new Error(
        `Renaming existing client "${existingRow.client_name}" via inline edit is blocked. Use the Rename action next to the client name to migrate all tenant data.`
      );
    }

    if (existingRow) {
      if (!payload.client_sheet_id) {
        if (existingRow.client_mode === "supabase" || String(existingRow.client_sheet_id || "").startsWith("sb-")) {
          payload.client_sheet_id = existingRow.client_sheet_id || `sb-client-${payload.normalized_key}`;
        }
      }
      if (!payload.master_sheet_id) {
        if (existingRow.master_mode === "supabase" || String(existingRow.master_sheet_id || "").startsWith("sb-")) {
          payload.master_sheet_id = existingRow.master_sheet_id || `sb-master-${payload.normalized_key}`;
        }
      }
      if (!payload.recon_sheet_id) {
        if (existingRow.master_mode === "supabase" || String(existingRow.recon_sheet_id || "").startsWith("sb-")) {
          payload.recon_sheet_id = existingRow.recon_sheet_id || `sb-recon-${payload.normalized_key}`;
        }
      }
    }

    const nextMetadata = { ...(existingRow?.metadata || {}) };
    if (payload.status === "suspended") {
      nextMetadata.statusOverride = "suspended";
    } else {
      delete nextMetadata.statusOverride;
    }
    payload.metadata = nextMetadata;

    let { data, error } = await sb
      .from("clients")
      .update(payload)
      .eq("id", existingId)
      .select("*")
      .single();

    if (
      error &&
      (error.code === "23514" || String(error.message || "").includes("clients_status_check")) &&
      payload.status === "suspended"
    ) {
      ({ data, error } = await sb
        .from("clients")
        .update({
          ...payload,
          status: "archived",
          metadata: { ...nextMetadata, statusOverride: "suspended" },
        })
        .eq("id", existingId)
        .select("*")
        .single());
    }

    if (error) throw new Error(error.message);
    return normalizeClientStatusFromDb_(data);
  }

  const payload = buildClientRegistryPayload_(rawRow, { isUpdate: false });
  const { data: existingByKey, error: existingByKeyErr } = await sb
    .from("clients")
    .select("id, metadata")
    .eq("normalized_key", payload.normalized_key)
    .maybeSingle();
  if (existingByKeyErr) {
    throw new Error(`Failed to check existing client registry row: ${existingByKeyErr.message}`);
  }

  const nextMetadata = { ...(existingByKey?.metadata || {}) };
  if (payload.status === "suspended") {
    nextMetadata.statusOverride = "suspended";
  } else {
    delete nextMetadata.statusOverride;
  }
  payload.metadata = nextMetadata;

  let { data, error } = await sb
    .from("clients")
    .upsert(payload, { onConflict: "normalized_key" })
    .select("*")
    .single();

  if (
    error &&
    (error.code === "23514" || String(error.message || "").includes("clients_status_check")) &&
    payload.status === "suspended"
  ) {
    ({ data, error } = await sb
      .from("clients")
      .upsert(
        {
          ...payload,
          status: "archived",
          metadata: { ...nextMetadata, statusOverride: "suspended" },
        },
        { onConflict: "normalized_key" }
      )
      .select("*")
      .single());
  }

  if (error) throw new Error(error.message);
  return normalizeClientStatusFromDb_(data);
}

async function invalidateClientsCache_(acId, extraExcludedNames = []) {
  clearAllClientsMemoryCache();
  clearSsrClientsMemoryCache();
  clearClientMappingCaches();
  invalidatePrecomputedMemoryCache();
  await import("../../../services/masterEngineService.js")
    .then((m) => m.invalidateSheetContextCache?.())
    .catch(() => { });
  const canonicalAcId = acId || getCanonicalAcSheetId();
  if (canonicalAcId) {
    memoryCache.del(`pulse:portal:allClients:${canonicalAcId}`);
  }
  if (process.env.AUTOMATION_COMMANDER_SHEET_ID) {
    memoryCache.del(`pulse:portal:allClients:${process.env.AUTOMATION_COMMANDER_SHEET_ID}`);
  }
  if (!redisClient?.isOpen) return;
  const keys = new Set(["pulse:integrations:status_all"]);
  if (canonicalAcId) {
    keys.add(`pulse:all_clients:${canonicalAcId}`);
    keys.add(`pulse:portal:allClients:${canonicalAcId}`);
  }
  if (process.env.AUTOMATION_COMMANDER_SHEET_ID) {
    keys.add(`pulse:all_clients:${process.env.AUTOMATION_COMMANDER_SHEET_ID}`);
    keys.add(`pulse:portal:allClients:${process.env.AUTOMATION_COMMANDER_SHEET_ID}`);
  }
  for (const k of keys) {
    await redisClient.del(k).catch(() => { });
  }

  // Prune any inactive/archived/suspended/deleted clients from triage_precomputed so PMA Alerts updates immediately
  try {
    const sb = getSupabaseAdmin();
    const rawPre = await redisClient.get("triage_precomputed");
    if (sb && rawPre) {
      const { data: statusRows } = await sb
        .from("clients")
        .select("client_name, status, metadata");
      const excluded = new Set(
        (statusRows || [])
          .filter((c) => {
            const eff = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
            return c.client_name && (eff === "inactive" || eff === "archived" || eff === "suspended");
          })
          .map((c) => String(c.client_name).trim().toLowerCase())
      );
      for (const extraName of (Array.isArray(extraExcludedNames) ? extraExcludedNames : [])) {
        const cleanExtra = String(extraName || "").trim().toLowerCase();
        if (cleanExtra) excluded.add(cleanExtra);
      }
      if (excluded.size > 0) {
        const pre = JSON.parse(rawPre);
        const keep = (item) => !excluded.has(String(item?.clientName || "").trim().toLowerCase());
        const nextClients = Array.isArray(pre.clientsWithFlags) ? pre.clientsWithFlags.filter(keep) : pre.clientsWithFlags;
        const nextAlerts = Array.isArray(pre.alerts) ? pre.alerts.filter(keep) : pre.alerts;
        const nextProactive = Array.isArray(pre.proactiveAlerts) ? pre.proactiveAlerts.filter(keep) : pre.proactiveAlerts;
        const nextNoAction = Array.isArray(pre.noActionAlerts) ? pre.noActionAlerts.filter(keep) : pre.noActionAlerts;
        const changed =
          (Array.isArray(pre.clientsWithFlags) && nextClients.length !== pre.clientsWithFlags.length) ||
          (Array.isArray(pre.alerts) && nextAlerts.length !== pre.alerts.length) ||
          (Array.isArray(pre.proactiveAlerts) && nextProactive.length !== pre.proactiveAlerts.length) ||
          (Array.isArray(pre.noActionAlerts) && nextNoAction.length !== pre.noActionAlerts.length);
        if (changed) {
          pre.clientsWithFlags = nextClients;
          pre.alerts = nextAlerts;
          pre.proactiveAlerts = nextProactive;
          pre.noActionAlerts = nextNoAction;
          pre.totalAlerts = Array.isArray(nextAlerts) ? nextAlerts.length : 0;
          pre.noActionCount = Array.isArray(nextNoAction) ? nextNoAction.length : 0;
          await redisClient.set("triage_precomputed", JSON.stringify(pre), { EX: 86400 * 7 });
        }
      }
    }
  } catch (pruneErr) {
    console.warn("invalidateClientsCache_ triage_precomputed prune warning:", pruneErr.message);
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
      status: () => ({ json: () => { } }),
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
  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser || !sessionUser.isAdmin || sessionUser.isReadOnly) {
    return res.status(403).json({
      success: false,
      error: "Forbidden: System administrator access is required.",
    });
  }

  const rl = await checkRateLimit("pma-control-plane", sessionUser.email || getTrustedClientIp(req), 60, 60);
  if (!rl.allowed) {
    return res.status(429).json({
      success: false,
      error: "Too many control-plane requests. Please wait a moment.",
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
    if (!assertTrustedOrigin(req, res)) return;

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
      const sb = isSupabaseConfigured() ? getSupabaseAdmin() : null;
      const [users, clientsRes, sbClientsRes] = await Promise.all([
        getAllUsers(sheets, automationCommanderSheetId, true),
        getAllClients(sheets, sessionUser, false, automationCommanderSheetId).catch(() => ({ clientsArray: [] })),
        sb
          ? sb.from("clients").select("client_name, status, metadata").order("client_name", { ascending: true })
          : Promise.resolve({ data: [] }),
      ]);
      const clientNames = (clientsRes?.clientsArray || []).map(c => c.clientName).filter(Boolean).sort();
      const clientStatusMap = {};
      for (const row of sbClientsRes?.data || []) {
        const name = String(row?.client_name || "").trim();
        if (!name) continue;
        const normalized = normalizeClientStatusFromDb_(row);
        clientStatusMap[name] = String(normalized?.status || "live").trim().toLowerCase();
      }
      return res.status(200).json({
        success: true,
        users,
        clientNames,
        clientStatusMap,
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
      const [{ data: clientRows, error: clientErr }, { data: tplRow }, snapshotMeta] = await Promise.all([
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
        getProvisioningTemplateSnapshotsMeta().catch(() => null),
      ]);
      if (clientErr) throw new Error(clientErr.message);
      return res.status(200).json({
        success: true,
        clients: (clientRows || []).map(normalizeClientStatusFromDb_),
        templates: tplRow?.value || null,
        snapshotMeta,
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
      const acId = automationCommanderSheetId || getCanonicalAcSheetId();
      const sheets = await getSheetsClient().catch(() => null);
      await syncReportsFolderToEomConfig_(sb, [saved], sessionUser.email || "Admin");
      let archiveRes = { archivedCount: 0 };
      if (isExcludedClientStatus_(saved.status)) {
        archiveRes = await archiveClientAlertMemory(sheets, acId, [saved.client_name]).catch((e) => {
          console.warn("archiveClientAlertMemory warning:", e.message);
          return { archivedCount: 0 };
        });
      }
      await invalidateClientsCache_(acId);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: saved.client_name,
        category: "SYSTEM",
        action: "CLIENT_REGISTRY_SAVED",
        summary: `Saved client registry record for "${saved.client_name}" (status: ${saved.status})`,
        details: {
          clientId: saved.id,
          status: saved.status,
          driveFolderId: saved.drive_folder_id,
          reportsFolderId: saved.reports_folder_id,
          archivedAlertMemoryCount: archiveRes?.archivedCount || 0,
        },
        userEmail: sessionUser.email || "Admin",
      }).catch(() => { });
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
      if (rows.length > 200) {
        return res.status(400).json({ success: false, error: "Batch client registry size exceeds maximum limit (200)." });
      }
      const sb = getSupabaseAdmin();
      const savedClients = [];
      for (const row of rows) {
        const saved = await upsertClientRegistryRecord_(sb, row);
        savedClients.push(saved);
      }
      const acId = automationCommanderSheetId || getCanonicalAcSheetId();
      const sheets = await getSheetsClient().catch(() => null);
      await syncReportsFolderToEomConfig_(sb, savedClients, sessionUser.email || "Admin");
      const excludedSavedNames = savedClients.filter((c) => isExcludedClientStatus_(c.status)).map((c) => c.client_name);
      if (excludedSavedNames.length > 0) {
        await archiveClientAlertMemory(sheets, acId, excludedSavedNames).catch((e) => {
          console.warn("archiveClientAlertMemory batch warning:", e.message);
        });
      }
      await invalidateClientsCache_(acId);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: savedClients.length === 1 ? savedClients[0].client_name : "Global",
        category: "SYSTEM",
        action: "CLIENT_REGISTRY_SAVED",
        summary: `Batch saved ${savedClients.length} client registry record${savedClients.length === 1 ? "" : "s"}: ${savedClients.map(c => c.client_name).join(", ")}`,
        details: { count: savedClients.length, clients: savedClients.map(c => c.client_name) },
        userEmail: sessionUser.email || "Admin",
      }).catch(() => { });
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
      let resolvedClientName = cleanName;
      let resolvedNormKey = "";
      {
        let lookupQuery = sb.from("clients").select("client_name, normalized_key");
        lookupQuery = cleanId ? lookupQuery.eq("id", cleanId) : lookupQuery.eq("client_name", cleanName);
        const { data: existingClient, error: lookupErr } = await lookupQuery.maybeSingle();
        if (lookupErr) throw new Error(`Failed to look up client before delete: ${lookupErr.message}`);
        if (!resolvedClientName && existingClient?.client_name) {
          resolvedClientName = String(existingClient.client_name).trim();
        }
        if (existingClient?.normalized_key) {
          resolvedNormKey = String(existingClient.normalized_key).trim();
        }
      }
      let query = sb.from("clients").delete();
      query = cleanId ? query.eq("id", cleanId) : query.eq("client_name", cleanName);
      const { error: delErr } = await query;
      if (delErr) throw new Error(delErr.message);

      if (resolvedClientName) {
        const { error: eomDelErr } = await sb
          .from("eom_cycles_and_tasks")
          .delete()
          .eq("client_name", resolvedClientName);
        if (eomDelErr) {
          console.warn("eom_cycles_and_tasks delete cleanup warning:", eomDelErr.message);
        }
      }
      if (resolvedNormKey) {
        const { error: cfgDelErr } = await sb
          .from("system_config")
          .delete()
          .eq("key", `cash_bank_breakdowns:${resolvedNormKey}`);
        if (cfgDelErr) {
          console.warn("cash_bank_breakdowns delete cleanup warning:", cfgDelErr.message);
        }
        const { error: tiDelErr } = await sb
          .from("tenant_integrations")
          .delete()
          .eq("client_key", resolvedNormKey);
        if (tiDelErr) {
          console.warn("tenant_integrations delete cleanup warning:", tiDelErr.message);
        }
        if (redisClient?.isOpen) {
          try {
            const vKeys = [];
            for await (const k of redisClient.scanIterator({ MATCH: `pulse:vault:*:${resolvedNormKey}:*` })) {
              vKeys.push(k);
            }
            if (vKeys.length > 0) await redisClient.del(vKeys);
          } catch { }
        }
      }

      if (resolvedClientName) {
        await Promise.all([
          sb.from("pma_tasks").delete().eq("client_name", resolvedClientName).then((r) => {
            if (r?.error) console.warn("pma_tasks delete cleanup warning:", r.error.message);
          }),
          sb.from("alert_memory").delete().eq("client_name", resolvedClientName).then((r) => {
            if (r?.error) console.warn("alert_memory delete cleanup warning:", r.error.message);
          }),
        ]);
        const targetLower = resolvedClientName.trim().toLowerCase();
        const { data: usersWithClient } = await sb.from("users").select("id, assigned_clients");
        for (const u of usersWithClient || []) {
          if (!Array.isArray(u.assigned_clients)) continue;
          const filtered = u.assigned_clients.filter((c) => String(c || "").trim().toLowerCase() !== targetLower);
          if (filtered.length !== u.assigned_clients.length) {
            await sb.from("users").update({ assigned_clients: filtered }).eq("id", u.id);
          }
        }
      }

      const acId = automationCommanderSheetId || getCanonicalAcSheetId();
      const sheets = await getSheetsClient().catch(() => null);
      if (resolvedClientName) {
        await archiveClientAlertMemory(sheets, acId, [resolvedClientName]).catch((e) => {
          console.warn("archiveClientAlertMemory delete warning:", e.message);
        });
      }
      await invalidateClientsCache_(acId, resolvedClientName ? [resolvedClientName] : []);
      await invalidateTasksCache().catch(() => { });
      await invalidateUsersCache().catch(() => { });
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: resolvedClientName || "Global",
        category: "SYSTEM",
        action: "CLIENT_REGISTRY_DELETED",
        summary: `Deleted client registry record "${resolvedClientName || cleanId}"`,
        details: { id: cleanId || null, clientName: resolvedClientName || null },
        userEmail: sessionUser.email || "Admin",
      }).catch(() => { });
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
        await redisClient.del("pulse:setup:provisioning_templates").catch(() => { });
      }
      const sheets = await getSheetsClient().catch(() => null);
      await logPmaActivity(sheets, {
        automationCommanderSheetId,
        category: "SYSTEM",
        action: "PROVISIONING_TEMPLATES_SAVED",
        summary: "Updated client provisioning template sheet and script IDs",
        details: templatesPayload,
        userEmail: sessionUser.email || "Admin",
      }).catch(() => { });
      return res.status(200).json({ success: true, templates: templatesPayload });
    }

    if (action === "sync_provisioning_template_snapshots") {
      if (!isSupabaseConfigured()) {
        return res.status(400).json({ success: false, error: "Supabase is not configured." });
      }
      const t = req.body?.templates || {};
      const sheets = await getSheetsClient();
      const snapRes = await syncProvisioningTemplateSnapshots(sheets, {
        clientTemplateId: t.clientTemplateId || "",
        masterTemplateId: t.masterTemplateId || "",
        reconTemplateId: t.reconTemplateId || "",
        userEmail: sessionUser.email || "Admin",
      });
      await logPmaActivity(sheets, {
        automationCommanderSheetId,
        category: "SYSTEM",
        action: "PROVISIONING_TEMPLATE_SNAPSHOTS_SYNCED",
        summary: "Synced Client, Master, and Recon template snapshots to Supabase",
        details: snapRes.meta,
        userEmail: sessionUser.email || "Admin",
      }).catch(() => { });
      return res.status(200).json({ success: true, snapshotMeta: snapRes.meta });
    }

    if (action === "rename_client") {
      const { clientId, oldClientName, newClientName } = req.body || {};
      const acId = automationCommanderSheetId || getCanonicalAcSheetId();
      const sheets = await getSheetsClient().catch(() => null);
      const result = await renameTenantClient({
        clientId,
        oldClientName,
        newClientName,
        sheets,
        acId,
      });
      await invalidateClientsCache_(acId);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        source: "PMA",
        clientName: result.newClientName,
        category: "SYSTEM",
        action: "RENAMED_CLIENT",
        summary: `Renamed client "${result.oldClientName}" to "${result.newClientName}"`,
        details: result,
        userEmail: sessionUser.email || "Admin",
      }).catch(() => { });
      return res.status(200).json({ success: true, result });
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
