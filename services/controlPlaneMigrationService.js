/**
 * ============================================================================
 * STAGE 1: CONTROL PLANE MIGRATION & SYNC SERVICE
 * ============================================================================
 *
 * Synchronizes existing Control Plane spreadsheets (Automation Commander,
 * Clients Version Tracker) and permanent Redis records (AES-256-GCM OAuth Vault,
 * PMA Tasks, System Config) into the 10 Stage 1 Supabase PostgreSQL tables.
 */

import fs from "fs";
import path from "path";
import { getSupabaseAdmin, isSupabaseConfigured, getControlPlaneSource } from "./supabaseClient.js";
import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { redisClient } from "./redisClient.js";
import { getCanonicalAcSheetId } from "./userPermissions.js";
import { TRACKER_SHEET_ID } from "./setupService.js";
import { ALERT_MEMORY_RANGE, normalizeCategoryForType } from "./alertMemory.js";
import { PULSE_ACTIVITY_LOG_TAB } from "./pulseLogger.js";
import { PMA_ACTIVITY_LOG_TAB, logPmaActivity } from "./pmaLogger.js";

export const STAGE_1_TABLES = [
  { name: "clients", label: "Clients registry", source: "Version Tracker & AutoUpdates" },
  { name: "users", label: "Users & permissions", source: "Automation Commander (Users)" },
  { name: "tenant_integrations", label: "Encrypted OAuth vault", source: "Upstash Redis (AES-256-GCM)" },
  { name: "sync_schedules", label: "Automation sync schedules", source: "Automation Commander (AutoUpdates)" },
  { name: "alert_memory", label: "Alert triage memory", source: "Automation Commander (AlertMemory)" },
  { name: "activity_logs", label: "Security & activity logs", source: "PulseActivityLog & PmaActivityLog" },
  { name: "pma_tasks", label: "PMA triage tasks", source: "AlertMemory (status = task)" },
  { name: "client_setup_state", label: "Client onboarding state", source: "ClientSetupOverview & Tasks" },
  { name: "eom_cycles_and_tasks", label: "End-of-month checklists", source: "EOM tabs & Redis narratives" },
  { name: "system_config", label: "System & sweep config", source: "SweepSchedule & ClaudeUsage" },
];

function normalizeKey(str) {
  return String(str || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function parseSafeTimestamp(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Reads the Stage 1 SQL migration file so Admins can view or copy it directly in PMA Settings.
 */
export function getStage1MigrationSql() {
  try {
    const sqlPath = path.join(process.cwd(), "supabase", "migrations", "0001_stage1_control_plane.sql");
    if (fs.existsSync(sqlPath)) {
      return fs.readFileSync(sqlPath, "utf8");
    }
  } catch (_) { }
  return "";
}

/**
 * Checks Supabase connectivity, table existence, and row counts across all 10 Stage 1 tables.
 */
export async function getControlPlaneStatus() {
  const configured = isSupabaseConfigured();
  const activeSource = await getControlPlaneSource(true);

  if (!configured) {
    return {
      configured: false,
      connected: false,
      schemaReady: false,
      activeSource: "sheets",
      tables: STAGE_1_TABLES.map(t => ({ ...t, exists: false, rowCount: 0 })),
      migrationSql: getStage1MigrationSql(),
    };
  }

  const sb = getSupabaseAdmin();
  const tableStatuses = await Promise.all(
    STAGE_1_TABLES.map(async (tbl) => {
      try {
        const { count, error, status } = await sb
          .from(tbl.name)
          .select("*", { count: "exact" })
          .limit(1);
        if (error || (status && status >= 400) || count === null || count === undefined) {
          return {
            ...tbl,
            exists: false,
            rowCount: 0,
            error: error?.message || `HTTP ${status || 404}: Table not created yet`,
          };
        }
        return { ...tbl, exists: true, rowCount: count };
      } catch (err) {
        return { ...tbl, exists: false, rowCount: 0, error: err.message };
      }
    })
  );

  const connected = tableStatuses.some(t => t.exists || !String(t.error || "").includes("fetch failed"));
  const schemaReady = tableStatuses.every(t => t.exists);

  let lastSyncMeta = null;
  if (schemaReady) {
    try {
      const { data } = await sb
        .from("system_config")
        .select("value, updated_at, updated_by")
        .eq("key", "stage1_last_sync")
        .maybeSingle();
      if (data) {
        lastSyncMeta = {
          ...(data.value || {}),
          updatedAt: data.updated_at,
          updatedBy: data.updated_by,
        };
      }
    } catch (_) { }
  }

  return {
    configured: true,
    connected,
    schemaReady,
    activeSource,
    dualWriteMirroring: true,
    lastSyncMeta,
    tables: tableStatuses,
    migrationSql: getStage1MigrationSql(),
  };
}

/**
 * Reads all 6 EoM control tabs from Automation Commander and upserts them
 * into `public.eom_cycles_and_tasks` using schemaVersion 2 payloads.
 */
export async function seedEomControlPlaneFromSheets(sheets, acId, sb, userEmail = "system") {
  if (!sheets || !acId || !sb) return { rowCount: 0 };

  const ranges = [
    "EomTemplates!A2:H1000",
    "EomClientTasks!A2:H5000",
    "EomMonthlyStatus!A2:F200000",
    "EomExcludedClients!A2:C1000",
    "EomDefaultTasks!A2:I1000",
    "EomBankAccounts!A2:C50000",
  ];

  let valueLists = null;
  try {
    const batchResp = await withRetry(() =>
      sheets.spreadsheets.values.batchGet({ spreadsheetId: acId, ranges })
    );
    const vrs = batchResp.data?.valueRanges || [];
    valueLists = ranges.map((_, idx) => vrs[idx]?.values || []);
  } catch (_) {
    const individual = await Promise.all(
      ranges.map((range) =>
        withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: acId, range }))
          .then((r) => r.data?.values || [])
          .catch(() => [])
      )
    );
    valueLists = individual;
  }

  const [
    tmplRows = [],
    clientTaskRows = [],
    statusRows = [],
    exclRows = [],
    defaultTaskRows = [],
    bankAccountRows = [],
  ] = valueLists;

  const nowIso = new Date().toISOString();
  const eomTemplates = tmplRows
    .filter((r) => r[0])
    .map((r, i) => ({
      templateId: r[0],
      name: r[1] || "",
      defaultNotes: r[2] || "",
      linkedFunction: r[3] || "",
      active: r[4] !== "FALSE" && r[4] !== false,
      createdAt: r[5] || "",
      alertCategories: r[6] || "",
      sortOrder: r[7] !== undefined && r[7] !== "" ? Number(r[7]) : 1000000 + i,
    }));

  const eomExcluded = exclRows
    .filter((r) => r[0])
    .map((r) => ({
      clientName: String(r[0]).trim(),
      excluded: r[1] === "TRUE" || r[1] === true,
      sortOrder: r[2] !== undefined && r[2] !== "" ? Number(r[2]) : null,
    }));

  const eomDefaultTasks = defaultTaskRows
    .filter((r) => r[0])
    .map((r, i) => ({
      defaultTaskId: r[0],
      templateId: r[1] || "",
      taskName: r[2] || "",
      defaultNotes: r[3] || "",
      active: r[4] !== "FALSE" && r[4] !== false,
      createdAt: r[5] || "",
      sortOrder: r[6] !== undefined && r[6] !== "" ? Number(r[6]) : 1000000 + i,
      linkedFunction: r[7] || "",
      alertCategories: r[8] || "",
    }));

  const bankAccountsByClient = {};
  let bankAccountsLoadedAt = "";
  bankAccountRows.forEach((r) => {
    const cName = String(r[0] || "").trim();
    const acct = String(r[1] || "").trim();
    if (!cName || !acct) return;
    if (!bankAccountsByClient[cName]) bankAccountsByClient[cName] = [];
    bankAccountsByClient[cName].push(acct);
    if (r[2]) bankAccountsLoadedAt = String(r[2]);
  });

  const eomRowsToUpsert = [
    {
      work_month_key: "__global__",
      client_name: "__system__",
      record_type: "template",
      tasks_payload: {
        schemaVersion: 2,
        seededAt: nowIso,
        templates: eomTemplates,
        excludedClients: eomExcluded,
        defaultTasks: eomDefaultTasks,
        bankAccountsByClient,
        bankAccountsLoadedAt,
      },
      updated_by: userEmail,
    },
  ];

  const clientTasksMap = new Map();
  clientTaskRows.forEach((r, idx) => {
    if (!r[0] || !r[1]) return;
    const cName = String(r[1]).trim();
    if (!clientTasksMap.has(cName)) clientTasksMap.set(cName, []);
    const rawH = r[7];
    const hasNumSort = rawH !== undefined && String(rawH).trim() !== "" && !isNaN(Number(rawH));
    clientTasksMap.get(cName).push({
      taskId: r[0],
      clientName: cName,
      templateId: r[2] || "",
      taskName: r[3] || "",
      clientNotes: r[4] || "",
      active: r[5] !== "FALSE" && r[5] !== false,
      createdAt: r[6] || "",
      sortOrder: hasNumSort ? Number(rawH) : 1000000 + idx,
      ...(hasNumSort || !rawH ? {} : { linkedFunction: String(rawH).trim() }),
    });
  });

  for (const [cName, tasks] of clientTasksMap.entries()) {
    eomRowsToUpsert.push({
      work_month_key: "__definitions__",
      client_name: cName,
      record_type: "client_tasks",
      tasks_payload: { tasks },
      updated_by: userEmail,
    });
  }

  const monthlyStatusByClientMonth = new Map();
  statusRows.forEach((r) => {
    const cName = String(r[0] || "").trim();
    const taskId = String(r[1] || "").trim();
    const monthKey = String(r[2] || "").trim();
    if (!cName || !taskId || !monthKey) return;
    const mapKey = `${monthKey}||${cName}`;
    if (!monthlyStatusByClientMonth.has(mapKey)) {
      monthlyStatusByClientMonth.set(mapKey, { monthKey, clientName: cName, statuses: {} });
    }
    monthlyStatusByClientMonth.get(mapKey).statuses[taskId] = {
      status: r[3] || "pending",
      completedAt: r[4] || "",
      notelet: r[5] || "",
    };
  });

  for (const { monthKey, clientName: cName, statuses } of monthlyStatusByClientMonth.values()) {
    eomRowsToUpsert.push({
      work_month_key: monthKey,
      client_name: cName,
      record_type: "client_tasks",
      tasks_payload: { statuses },
      updated_by: userEmail,
    });
  }

  for (let i = 0; i < eomRowsToUpsert.length; i += 500) {
    const batch = eomRowsToUpsert.slice(i, i + 500);
    const { error } = await sb
      .from("eom_cycles_and_tasks")
      .upsert(batch, { onConflict: "work_month_key,client_name,record_type" });
    if (error) {
      throw new Error(`Supabase eom_cycles_and_tasks upsert failed: ${error.message}`);
    }
  }

  return { rowCount: eomRowsToUpsert.length };
}

/**
 * Imports all existing Control Plane spreadsheet tabs and permanent Redis keys into Supabase.
 */
export async function syncControlPlaneToSupabase({ sheets, automationCommanderSheetId, userEmail = "Admin" }) {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to your environment variables first.");
  }

  const sb = getSupabaseAdmin();
  if (!sheets) {
    sheets = await getSheetsClient();
  }
  const acId = automationCommanderSheetId || getCanonicalAcSheetId();
  const summary = {};

  // ── 1. CLIENTS & SYNC SCHEDULES (Version Tracker + AutoUpdates) ────────────
  const [trackerResp, autoUpdatesResp] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: TRACKER_SHEET_ID,
        range: "Clients!A5:AN500",
      })
    ).catch(() => ({ data: { values: [] } })),
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: "AutoUpdates!A3:AJ500",
      })
    ).catch(() => ({ data: { values: [] } })),
  ]);

  const trackerRows = trackerResp.data?.values || [];
  const autoRows = autoUpdatesResp.data?.values || [];

  const clientsByKey = new Map();
  const schedulesToUpsert = [];

  trackerRows.forEach((row, idx) => {
    const clientName = String(row[0] || "").trim();
    if (!clientName) return;
    const normKey = normalizeKey(clientName);
    if (!normKey) return;

    const clientUrl = String(row[11] || "").trim();
    const masterUrl = String(row[12] || "").trim();
    const reconUrl = String(row[13] || "").trim();

    clientsByKey.set(normKey, {
      client_name: clientName,
      normalized_key: normKey,
      version_in_use: String(row[1] || "").trim(),
      service_type: String(row[5] || "").trim(),
      client_sheet_url: clientUrl,
      master_sheet_url: masterUrl,
      recon_sheet_url: reconUrl,
      client_sheet_id: extractSheetIdFromUrl(clientUrl) || "",
      master_sheet_id: extractSheetIdFromUrl(masterUrl) || "",
      recon_sheet_id: extractSheetIdFromUrl(reconUrl) || "",
      web_app_url: String(row[14] || "").trim(),
      short_code: String(row[15] || "").trim() || null,
      client_script_id: String(row[17] || "").trim(),
      master_script_id: String(row[18] || "").trim(),
      recon_script_id: String(row[19] || "").trim(),
      webapp_version: String(row[20] || "").trim(),
      master_deployment_url: String(row[22] || "").trim(),
      backup_sheet_url: String(row[24] || "").trim(),
      tracker_row_index: idx + 5,
      status: "live",
      master_mode: "sheet",
      client_mode: "sheet",
    });
  });

  autoRows.forEach((row, idx) => {
    const clientName = String(row[0] || "").trim();
    if (!clientName) return;
    const normKey = normalizeKey(clientName);
    if (!normKey) return;

    const reconUrl = String(row[9] || "").trim();
    const clientUrl = String(row[11] || "").trim();
    const masterUrl = String(row[12] || "").trim();
    const webAppUrl = String(row[13] || "").trim();

    const existing = clientsByKey.get(normKey) || {
      client_name: clientName,
      normalized_key: normKey,
      status: "live",
      master_mode: "sheet",
      client_mode: "sheet",
    };

    clientsByKey.set(normKey, {
      ...existing,
      client_sheet_url: existing.client_sheet_url || clientUrl,
      master_sheet_url: existing.master_sheet_url || masterUrl,
      recon_sheet_url: existing.recon_sheet_url || reconUrl,
      client_sheet_id: existing.client_sheet_id || extractSheetIdFromUrl(clientUrl) || "",
      master_sheet_id: existing.master_sheet_id || extractSheetIdFromUrl(masterUrl) || "",
      recon_sheet_id: existing.recon_sheet_id || extractSheetIdFromUrl(reconUrl) || "",
      web_app_url: existing.web_app_url || webAppUrl,
      auto_updates_row_index: idx + 3,
    });

    schedulesToUpsert.push({
      client_name: clientName,
      automation_enabled: true,
      inv_freq: String(row[14] || "").trim(),
      crm_freq: String(row[15] || "").trim(),
      exp_freq: String(row[16] || "").trim(),
      last_inv_run: parseSafeTimestamp(row[22]),
      inv_status: String(row[23] || "").trim(),
      last_crm_run: parseSafeTimestamp(row[27]),
      crm_status: String(row[28] || "").trim(),
      last_exp_run: parseSafeTimestamp(row[34]),
      exp_status: String(row[35] || "").trim(),
    });
  });

  const clientRecords = Array.from(clientsByKey.values());
  if (clientRecords.length > 0) {
    const { error: clientErr } = await sb
      .from("clients")
      .upsert(clientRecords, { onConflict: "normalized_key" });
    if (clientErr) throw new Error(`clients upsert failed: ${clientErr.message}`);
  }
  summary.clients = clientRecords.length;

  // Map client_name -> id for foreign keys
  const { data: dbClients } = await sb.from("clients").select("id, client_name, normalized_key");
  const clientIdByNormKey = new Map();
  (dbClients || []).forEach(c => {
    clientIdByNormKey.set(c.normalized_key, c.id);
  });

  if (schedulesToUpsert.length > 0) {
    const { data: existingScheds } = await sb.from("sync_schedules").select("*");
    const existingByClient = new Map();
    (existingScheds || []).forEach(ex => {
      if (ex?.client_name) existingByClient.set(ex.client_name, ex);
    });

    const pickSeqState = (ex, sheetLastIso, sheetStatus, seqPrefix, freqVal) => {
      const exLastIso = ex?.[`last_${seqPrefix}_run`] || null;
      const exStatus = ex?.[`${seqPrefix}_status`];
      const exMs = exLastIso ? new Date(exLastIso).getTime() : NaN;
      const shMs = sheetLastIso ? new Date(sheetLastIso).getTime() : NaN;
      const keepExistingRun =
        Boolean(exLastIso) &&
        (!sheetLastIso || (!Number.isNaN(exMs) && (Number.isNaN(shMs) || exMs >= shMs)));

      if (keepExistingRun) {
        return { lastRun: exLastIso, status: typeof exStatus === "string" ? exStatus : sheetStatus };
      }
      if (!freqVal && ex && exStatus === "") {
        return { lastRun: sheetLastIso, status: "" };
      }
      return { lastRun: sheetLastIso, status: sheetStatus };
    };

    const enrichedSchedules = schedulesToUpsert.map(s => {
      const ex = existingByClient.get(s.client_name);
      const invState = pickSeqState(ex, s.last_inv_run, s.inv_status, "inv", s.inv_freq);
      const crmState = pickSeqState(ex, s.last_crm_run, s.crm_status, "crm", s.crm_freq);
      const expState = pickSeqState(ex, s.last_exp_run, s.exp_status, "exp", s.exp_freq);
      return {
        ...s,
        client_id: clientIdByNormKey.get(normalizeKey(s.client_name)) || null,
        automation_enabled: typeof ex?.automation_enabled === "boolean" ? ex.automation_enabled : s.automation_enabled,
        flags: (ex?.flags && typeof ex.flags === "object") ? ex.flags : {},
        last_inv_run: invState.lastRun,
        inv_status: invState.status,
        last_crm_run: crmState.lastRun,
        crm_status: crmState.status,
        last_exp_run: expState.lastRun,
        exp_status: expState.status,
      };
    });
    const { error: schedErr } = await sb
      .from("sync_schedules")
      .upsert(enrichedSchedules, { onConflict: "client_name" });
    if (schedErr) throw new Error(`sync_schedules upsert failed: ${schedErr.message}`);
  }
  summary.sync_schedules = schedulesToUpsert.length;

  // ── 2. USERS (Automation Commander Users tab) ──────────────────────────────
  const usersResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: acId,
      range: "Users!A2:H500",
    })
  ).catch(() => ({ data: { values: [] } }));

  const userRows = usersResp.data?.values || [];
  const usersToUpsert = [];
  userRows.forEach((row, idx) => {
    const email = String(row[0] || "").toLowerCase().trim();
    if (!email) return;
    const roleRaw = String(row[2] || "").trim().toLowerCase();
    let role = "ClientUser";
    if (roleRaw === "admin") role = "Admin";
    else if (roleRaw.includes("senior")) role = "Senior (Restricted)";
    else if (roleRaw.includes("manager")) role = "ClientManager";

    const assignedRaw = String(row[3] || "").trim();
    const assignedClients = (role === "Admin" && assignedRaw === "*")
      ? ["*"]
      : assignedRaw.split(",").map(c => c.trim()).filter(Boolean);

    usersToUpsert.push({
      email,
      full_name: String(row[1] || "").trim() || email.split("@")[0],
      role,
      assigned_clients: assignedClients,
      status: String(row[4] || "").trim().toLowerCase() === "suspended" ? "Suspended" : "Active",
      created_at: parseSafeTimestamp(row[5]) || new Date().toISOString(),
      last_login_at: parseSafeTimestamp(row[6]),
      daily_alerts_email: String(row[7] || "").trim().toLowerCase() === "no" ? "No" : "Yes",
      sheet_row_index: idx + 2,
    });
  });

  if (usersToUpsert.length > 0) {
    const { error: userErr } = await sb
      .from("users")
      .upsert(usersToUpsert, { onConflict: "email" });
    if (userErr) throw new Error(`users upsert failed: ${userErr.message}`);
  }
  summary.users = usersToUpsert.length;

  // ── 3. ENCRYPTED OAUTH VAULT (Upstash Redis pulse:vault:*) ─────────────────
  let vaultCount = 0;
  if (redisClient?.isOpen) {
    try {
      const vaultKeys = await redisClient.keys("pulse:vault:client:*");
      const sharedXero = await redisClient.get("pulse:vault:shared:xero");
      const vaultRows = [];

      if (sharedXero) {
        let parsedShared = null;
        try { parsedShared = JSON.parse(sharedXero); } catch (_) { }
        if (parsedShared || String(sharedXero).startsWith("enc:v1:")) {
          vaultRows.push({
            client_key: "__shared_xero__",
            tool: "xero",
            encrypted_payload: sharedXero,
            status: parsedShared?.status || "connected",
          });
        }
      }

      for (const k of (vaultKeys || [])) {
        const parts = String(k).split(":");
        // pulse:vault:client:<clientKey>:<tool>
        if (parts.length >= 5) {
          const tool = parts[parts.length - 1];
          const clientKey = parts.slice(3, parts.length - 1).join(":");
          const val = await redisClient.get(k);
          if (val) {
            let parsed = null;
            try { parsed = JSON.parse(val); } catch (_) { }
            if (parsed || String(val).startsWith("enc:v1:")) {
              vaultRows.push({
                client_id: clientIdByNormKey.get(clientKey) || null,
                client_key: clientKey,
                tool,
                master_sheet_id: parsed?.masterSheetId || "",
                encrypted_payload: val,
                tenant_org_id: parsed?.tenantId || parsed?.realmId || "",
                tenant_org_name: parsed?.tenantName || parsed?.companyName || "",
                status: parsed?.status || "connected",
              });
            }
          }
        }
      }

      if (vaultRows.length > 0) {
        const { error: vErr } = await sb
          .from("tenant_integrations")
          .upsert(vaultRows, { onConflict: "client_key,tool" });
        if (vErr) throw new Error(`tenant_integrations upsert failed: ${vErr.message}`);
        vaultCount = vaultRows.length;
      }
    } catch (vErr) {
      console.warn("⚠️ Vault migration warning:", vErr.message);
    }
  }
  summary.tenant_integrations = vaultCount;

  // ── 4. ALERT MEMORY & PMA TASKS (Automation Commander AlertMemory) ─────────
  const amResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: acId,
      range: ALERT_MEMORY_RANGE,
    })
  ).catch(() => ({ data: { values: [] } }));

  const amRows = (amResp.data?.values || []).slice(1);
  // Deduplicate by fingerprint_hash (prefer highest priority row matching findMemoryRow)
  const amByHash = new Map();
  const tasksByHash = new Map();

  const statusPriority = (st) => {
    if (st === "ignored" || st === "accepted" || st === "task" || st === "pending_automation") return 3;
    if (st === "cached") return 2;
    return 1;
  };

  amRows.forEach((row, idx) => {
    const fp = String(row[0] || "").trim();
    if (!fp) return;
    const alertType = String(row[1] || "").trim();
    const clientName = String(row[2] || "").trim();
    const alertSummary = String(row[3] || "").trim();
    const cachedOptionsJson = String(row[4] || "");
    const status = String(row[5] || "cached").trim();
    const ignoreReason = String(row[6] || "");
    const firstSeen = String(row[7] || "");
    const lastSeen = String(row[8] || "");
    const lastRechecked = String(row[9] || "");
    const dataSnapshot = String(row[10] || "");
    const category = normalizeCategoryForType(alertType, String(row[11] || "discrepancy"));

    const candidate = {
      fingerprint_hash: fp,
      alert_type: alertType,
      client_name: clientName,
      alert_summary: alertSummary,
      cached_options_json: cachedOptionsJson,
      status,
      ignore_reason: ignoreReason,
      first_seen: firstSeen,
      last_seen: lastSeen,
      last_rechecked: lastRechecked,
      data_snapshot: dataSnapshot,
      category,
      sheet_row_index: idx + 2,
    };

    const existing = amByHash.get(fp);
    if (!existing || statusPriority(status) >= statusPriority(existing.status)) {
      amByHash.set(fp, candidate);
    }

    if (status === "task") {
      let parsedSnap = {};
      try {
        if (dataSnapshot) parsedSnap = JSON.parse(dataSnapshot);
      } catch (_) { }
      tasksByHash.set(fp, {
        fingerprint_hash: fp,
        task_key: parsedSnap.taskKey || `${clientName}||${alertType}||${fp}`,
        client_name: clientName,
        alert_type: alertType,
        alert_summary: alertSummary,
        task_note: parsedSnap.taskNote || ignoreReason || "",
        status: "task",
        snoozed_until: parsedSnap.snoozedUntil || "",
        created_by_email: parsedSnap.createdByEmail || "",
        created_by_name: parsedSnap.createdByName || "",
        is_admin_only: Boolean(parsedSnap.isAdminOnly),
        data_snapshot: parsedSnap,
      });
    }
  });

  const uniqueAmRows = Array.from(amByHash.values());
  const BATCH_SIZE = 400;
  for (let i = 0; i < uniqueAmRows.length; i += BATCH_SIZE) {
    const chunk = uniqueAmRows.slice(i, i + BATCH_SIZE);
    const { error: amErr } = await sb
      .from("alert_memory")
      .upsert(chunk, { onConflict: "fingerprint_hash" });
    if (amErr) throw new Error(`alert_memory batch upsert failed: ${amErr.message}`);
  }
  summary.alert_memory = uniqueAmRows.length;

  const uniqueTaskRows = Array.from(tasksByHash.values());
  if (uniqueTaskRows.length > 0) {
    const { error: taskErr } = await sb
      .from("pma_tasks")
      .upsert(uniqueTaskRows, { onConflict: "fingerprint_hash" });
    if (taskErr) throw new Error(`pma_tasks upsert failed: ${taskErr.message}`);
  }
  summary.pma_tasks = uniqueTaskRows.length;

  // ── 5. ACTIVITY LOGS (PulseActivityLog & PmaActivityLog) ───────────────────
  const [pulseLogsResp, pmaLogsResp] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: `${PULSE_ACTIVITY_LOG_TAB}!A2:G1500`,
      })
    ).catch(() => ({ data: { values: [] } })),
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: `${PMA_ACTIVITY_LOG_TAB}!A2:G1500`,
      })
    ).catch(() => ({ data: { values: [] } })),
  ]);

  const activityRows = [];
  const parseActivityRow = (row, source) => {
    const ts = parseSafeTimestamp(row[0]);
    if (!ts) return null;
    let detailsObj = {};
    try {
      detailsObj = row[5] ? JSON.parse(row[5]) : {};
    } catch (_) {
      detailsObj = { raw: String(row[5] || "") };
    }
    return {
      logged_at: ts,
      source,
      client_name: String(row[1] || "System").trim(),
      category: String(row[2] || source).trim().toUpperCase(),
      action: String(row[3] || "").trim(),
      summary: String(row[4] || "").trim(),
      details: detailsObj,
      user_email: String(row[6] || "System").trim(),
    };
  };

  (pulseLogsResp.data?.values || []).forEach(r => {
    const item = parseActivityRow(r, "PULSE");
    if (item) activityRows.push(item);
  });
  (pmaLogsResp.data?.values || []).forEach(r => {
    const item = parseActivityRow(r, "PMA");
    if (item) activityRows.push(item);
  });

  if (activityRows.length > 0) {
    // Clear previous imported snapshot only if table is empty to avoid duplicate log rows on re-runs
    const { count: existingLogCount } = await sb
      .from("activity_logs")
      .select("*", { count: "exact", head: true });
    if (!existingLogCount || existingLogCount === 0) {
      for (let i = 0; i < activityRows.length; i += BATCH_SIZE) {
        const chunk = activityRows.slice(i, i + BATCH_SIZE);
        await sb.from("activity_logs").insert(chunk);
      }
    }
  }
  summary.activity_logs = activityRows.length;

  // ── 6. CLIENT SETUP STATE (ClientSetupOverview & ClientSetupTasks) ─────────
  const [setupOvResp, setupTasksResp] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: "ClientSetupOverview!A2:N500",
      })
    ).catch(() => ({ data: { values: [] } })),
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: "ClientSetupTasks!A2:H2000",
      })
    ).catch(() => ({ data: { values: [] } })),
  ]);

  const tasksByClientKey = new Map();
  (setupTasksResp.data?.values || []).forEach(r => {
    const cName = String(r[0] || "").trim();
    const phaseId = String(r[1] || "").trim();
    const taskId = String(r[2] || "").trim();
    if (!cName || !taskId) return;
    const norm = normalizeKey(cName);
    if (!tasksByClientKey.has(norm)) tasksByClientKey.set(norm, {});
    const isCompleted = String(r[4] || "").toUpperCase() === "TRUE";
    tasksByClientKey.get(norm)[taskId] = {
      phaseId,
      isCompleted,
      status: isCompleted ? "completed" : "pending",
      completedAt: String(r[5] || "").trim(),
      completedBy: String(r[6] || "").trim(),
      metadata: String(r[7] || "").trim(),
    };
  });

  const setupStatesToUpsert = [];
  (setupOvResp.data?.values || []).forEach(r => {
    const cName = String(r[0] || "").trim();
    if (!cName) return;
    const norm = normalizeKey(cName);
    setupStatesToUpsert.push({
      client_id: clientIdByNormKey.get(norm) || null,
      client_name: cName,
      normalized_key: norm,
      setup_status: String(r[1] || "IN_PROGRESS").trim(),
      accounting_tool: String(r[2] || "None").trim(),
      crm_tool: String(r[3] || "None").trim(),
      crm_drives: String(r[4] || "NA").trim(),
      overview_data: { rawRow: r },
      tasks_map: tasksByClientKey.get(norm) || {},
    });
  });

  if (setupStatesToUpsert.length > 0) {
    const { error: setupErr } = await sb
      .from("client_setup_state")
      .upsert(setupStatesToUpsert, { onConflict: "normalized_key" });
    if (setupErr) throw new Error(`client_setup_state upsert failed: ${setupErr.message}`);
  }
  summary.client_setup_state = setupStatesToUpsert.length;

  // ── 6b. EOM TEMPLATES, CLIENT TASKS & MONTHLY STATUS ───────────────────────
  try {
    const eomSeedRes = await seedEomControlPlaneFromSheets(sheets, acId, sb, userEmail);
    summary.eom_cycles_and_tasks = eomSeedRes.rowCount || 0;
  } catch (eomErr) {
    console.warn("⚠️ EoM migration sync warning:", eomErr.message);
  }

  // ── 7. SYSTEM CONFIG (SweepSchedule & Stage 1 Sync Metadata) ───────────────
  const sweepResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: acId,
      range: "SweepSchedule!A2:C10",
    })
  ).catch(() => ({ data: { values: [] } }));

  const sweepObj = {};
  (sweepResp.data?.values || []).forEach(r => {
    const cat = String(r[0] || "").trim().toLowerCase();
    if (cat) {
      sweepObj[cat] = {
        frequencyMinutes: parseInt(r[1], 10) || 30,
        lastCheckedAt: String(r[2] || ""),
      };
    }
  });

  const nowIso = new Date().toISOString();
  await sb.from("system_config").upsert([
    {
      key: "sweep_schedule",
      value: sweepObj,
      description: "Background alert sweep frequencies and last checked timestamps",
      updated_by: userEmail,
    },
    {
      key: "stage1_last_sync",
      value: { summary, syncedAt: nowIso },
      description: "Metadata from the latest Stage 1 Control Plane migration sync",
      updated_by: userEmail,
    },
  ]);
  summary.system_config = 2;

  await logPmaActivity(sheets, {
    automationCommanderSheetId: acId,
    category: "SYSTEM",
    action: "SUPABASE_STAGE1_SYNC",
    summary: `Synced Control Plane to Supabase (${summary.clients} clients, ${summary.users} users, ${summary.alert_memory} alert memory rows)`,
    details: summary,
    userEmail,
  });

  return {
    success: true,
    syncedAt: nowIso,
    summary,
  };
}
