/**
 * ============================================================================
 * SETUP SERVICE - CLIENT SETUP MODE & ONBOARDING CONNECTIONS
 * ============================================================================
 * 
 * Manages the client "Setup Mode" lifecycle, tool selection, and OAuth connection
 * requests for client users.
 * 
 * Storage:
 * - Redis (`pulse:setup:<clientKey>`) for real-time sub-millisecond retrieval.
 * - Master Sheet `KeyInfo!Q4:Q9` as permanent, spreadsheet-backed storage:
 *     KeyInfo!Q4: Accounting Tool ('None', 'Xero', 'Quickbooks')
 *     KeyInfo!Q8: CRM Tool ('None', 'ClickUp', 'Close', 'Capsule', 'HubSpot', 'Monday', 'Pipedrive', 'Google Sheet', 'Excel')
 *     KeyInfo!Q9: CRM Drives ('NA', 'Pipeline', 'PipeAndConf')
 */

import { redisClient, scanRedisKeys, ensureRedisConnected } from "./redisClient.js";
import { invalidateAllClientsRedisKeys } from "./cacheService.js";
import { getSupabaseAdmin, isSupabaseConfigured, isSupabaseControlPlaneActive, shouldDualWriteLegacyControlPlaneSheets } from "./supabaseClient.js";
import { isValidGoogleScriptUrl } from "../utils/helpers.js";
import { getIntegrationStatus, INTEGRATIONS_STATUS_CACHE_KEY } from "./vaultService.js";
import { getSheetsClient, getDriveClient, withRetry, extractSheetIdFromUrl, sanitizeFormulaInput, getServiceAccountPoolEmails } from "./sheetsClient.js";
import { logPmaActivity, DEFAULT_AC_SHEET_ID } from "./pmaLogger.js";
import { isUserAuthorizedForClient, isPulseOnlyUser, resolveMasterSheetIdByClientName, resolveClientSheetIdByClientName, unwrapSheetId } from "./userPermissions.js";
import { clearAllClientsMemoryCache } from "./workspaces.js";
import { clearSsrClientsMemoryCache } from "./ssrSession.js";
import {
  resolveSupabaseSheetContext,
  isVirtualSupabaseSheetId,
  seedNewClientTemplatesToSupabase,
} from "./masterEngineService.js";
import { mirrorAutomationFrequenciesToSyncSchedules } from "./masterSyncEngine.js";

export const TRACKER_SHEET_ID = "1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co";
export const REPORTING_CONTROL_SHEET_ID = "1uAJS6ZWn0o-GPU9Ea3DIVU9nzQoRnXrMfmBcQYHNJ_s";
export const DEFAULT_CLIENTS_FOLDER_ID = "16qLMIFy1GyiEZ4DkKjVaFXOKGQKDW8Cj";
export const CLIENT_SETUP_OVERVIEW_TAB = "ClientSetupOverview";
export const CLIENT_SETUP_TASKS_TAB = "ClientSetupTasks";
export const SETUP_PROCESS_TEMPLATE_TAB = "SetupProcessTemplate";

function normalizeKey(str) {
  return String(str || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function getSetupRedisKey(clientName) {
  return `pulse:setup:${normalizeKey(clientName)}`;
}

function getChecklistRedisKey(clientName) {
  return `pulse:setup:checklist:${normalizeKey(clientName)}`;
}

export const SETUP_PHASES = [
  {
    id: "phase_1",
    title: "Step 0: Infrastructure & sheet linking",
    description: "Drive folder provisioning, template duplication, cross-linking, and script deployment.",
    adminOnly: true
  },
  {
    id: "phase_2",
    title: "Step 1: Initial settings",
    description: "Core accounting, CRM tool and Pulse settings."
  },
  {
    id: "phase_3",
    title: "Step 2: Accounting setup and initial data",
    description: "Chart of accounts, P&L baselines, initial P&L, invoices, cash and outgoings breakdown."
  },
  {
    id: "phase_4",
    title: "Step 3: CRM setup and initial data",
    description: "CRM field mappings, confirmed and pipeline definitions, and pipeline deal matching."
  },
  {
    id: "phase_5",
    title: "Step 4: Go-live and final data capture",
    description: "Make Pulse live for client users, send go-live email, and confirm receipt of final baseline details."
  }
];

export const SETUP_TASKS_CATALOG = [
  // Phase 1: Infrastructure & Linking
  { id: "p1_drive_folder", phaseId: "phase_1", title: "Create client folder in Google Drive", autoCompletable: true },
  { id: "p1_duplicate_templates", phaseId: "phase_1", title: "Duplicate client, master & recon templates", autoCompletable: true },
  { id: "p1_bookmarks", phaseId: "phase_1", title: "Create bookmarks for all three new sheets" },
  { id: "p1_importrange_auth", phaseId: "phase_1", title: "Authorise IMPORTRANGE connections (Master, Client, Recon)" },
  { id: "p1_agent_secret", phaseId: "phase_1", title: "Add global variable to master sheet: AGENT_TRIGGER_SECRET" },
  { id: "p1_gas_deployment", phaseId: "phase_1", title: "Deploy Master sheet GAS and copy deployment URL to KeyInfo!X29" },
  { id: "p1_rename_gas", phaseId: "phase_1", title: "Rename GAS file names" },
  { id: "p1_script_ids", phaseId: "phase_1", title: "Copy GAS script IDs into Client Version Tracker doc" },

  // Phase 2: Initial Settings & Integrations
  { id: "p2_confirm_tools", phaseId: "phase_2", title: "Confirm accounting and CRM tools" },
  { id: "p2_request_connections_email", phaseId: "phase_2", title: "Email client to request connections" },
  { id: "p2_connect_accounting", phaseId: "phase_2", title: "Awaiting client connection to accounting tool", autoCompletable: true },
  { id: "p2_connect_crm", phaseId: "phase_2", title: "Awaiting client connection to CRM tool", autoCompletable: true },
  { id: "p2_keyinfo_settings", phaseId: "phase_2", title: "Adjust core settings in KeyInfo (Start date, VAT, PAYE, Revenue focus, Profit share %, Invoice formatting, Automation cadences)" },
  { id: "p4_datachg_flags", phaseId: "phase_2", title: "Update other DataChgAlert flags as required" },

  // Phase 3: Accounting Setup & Baseline
  { id: "p3_chart_of_accounts", phaseId: "phase_3", title: "Pull Chart of Accounts and select manual categories" },
  { id: "p3_pull_pl", phaseId: "phase_3", title: "Pull P&L and Year 0 P&L and assign accounts to categories" },
  { id: "p3_year0_setup", phaseId: "phase_3", title: "Finalise Year 0 setup, adding dividends in lieu of salary as required" },
  { id: "p3_sync_invoices", phaseId: "phase_3", title: "Initial invoice setup" },
  { id: "p3_starter_pl", phaseId: "phase_3", title: "Set up initial P&L and forecast" },
  { id: "p3_other_expenses", phaseId: "phase_3", title: "Create budget" },
  { id: "p3_select_bank_accounts", phaseId: "phase_3", title: "Select bank accounts" },
  { id: "p3_cash_opening", phaseId: "phase_3", title: "Add cash opening figure" },
  { id: "p3_initial_tax_payments", phaseId: "phase_3", title: "Update initial tax payment amounts" },

  // Phase 4: Automations & Cadence
  { id: "p4_crm_list_tab", phaseId: "phase_4", title: "Set up CRMList tab (mappings, Confirmed & Pipeline definitions)" },
  { id: "p4_review_crm", phaseId: "phase_4", title: "Review CRM data, match existing pipeline jobs, and check assumptions" },

  // Phase 5: Go live and final data capture
  { id: "p5_make_live", phaseId: "phase_5", title: "Make Pulse live" },
  { id: "p5_email_client", phaseId: "phase_5", title: "Email client saying Pulse is live and requesting further information" }
];

export const DEFAULT_SETUP_PHASES = SETUP_PHASES;
export const DEFAULT_SETUP_TASKS_CATALOG = SETUP_TASKS_CATALOG;

export const OAUTH_TOOLS = [
  "xero",
  "quickbooks",
  "clickup",
  "close",
  "capsule",
  "hubspot",
  "monday",
  "pipedrive",
  "googlesheet",
  "google_sheet",
  "google sheet",
  "excel"
];

export function isOAuthTool(tool) {
  if (!tool) return false;
  const clean = String(tool).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return OAUTH_TOOLS.some(t => t.replace(/[^a-z0-9]/g, "") === clean);
}

async function autoClearRequestConnectionsIfReady_({ clientName, redisKey, config, hasRequiredTools, allConnected }) {
  if (!config || config.requestConnections !== true || !hasRequiredTools || !allConnected) {
    return Boolean(config?.requestConnections);
  }
  const now = new Date().toISOString();
  const nextRecord = {
    ...config,
    requestConnections: false,
    updatedAt: now,
  };
  await redisClient.set(redisKey, JSON.stringify(nextRecord)).catch(() => { });
  await redisClient.del(INTEGRATIONS_STATUS_CACHE_KEY).catch(() => { });
  if (isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      const norm = normalizeKey(clientName);
      const { data: existingClient } = await sb
        .from("clients")
        .select("id, metadata")
        .eq("normalized_key", norm)
        .maybeSingle();
      if (existingClient?.id && existingClient.metadata?.requestConnections !== false) {
        await sb
          .from("clients")
          .update({
            metadata: { ...(existingClient.metadata || {}), requestConnections: false },
            updated_at: now,
          })
          .eq("id", existingClient.id);
      }
    } catch (_) { }
  }
  return false;
}

/**
 * Returns full setup configuration for a client (for PMA Setup view).
 */
export async function getClientSetupConfig({ clientName, masterSheetId, clientSheetId, forceSheetSync = false }) {
  if (!clientName) throw new Error("Missing clientName parameter.");

  const redisKey = getSetupRedisKey(clientName);
  let config = null;

  try {
    const raw = await redisClient.get(redisKey);
    if (raw) {
      config = JSON.parse(raw);
    }
  } catch (err) {
    console.error(`Failed to read Redis setup config for ${clientName}:`, err);
  }

  // Fallback to Supabase clients.metadata on Redis cache miss
  if (!config && isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      const { data: dbClient } = await sb
        .from("clients")
        .select("master_sheet_id, client_sheet_id, metadata")
        .eq("normalized_key", normalizeKey(clientName))
        .maybeSingle();
      if (dbClient?.metadata && typeof dbClient.metadata === "object") {
        config = {
          clientName,
          masterSheetId: dbClient.master_sheet_id || "",
          clientSheetId: dbClient.client_sheet_id || "",
          setupMode: dbClient.metadata.setupMode === true,
          pulseLive: dbClient.metadata.pulseLive === true || dbClient.metadata.setupMode !== true,
          requestConnections: dbClient.metadata.requestConnections === true,
          accountingTool: dbClient.metadata.accountingTool || "None",
          crmTool: dbClient.metadata.crmTool || "None",
          crmDrives: dbClient.metadata.crmDrives || "NA",
        };
      }
    } catch (_) { }
  }

  // Fast path: Only query Google Sheets API if:
  // 1) forceSheetSync is true, OR
  // 2) Redis does not have accountingTool and crmTool cached yet, OR
  // 3) Both tools are cached as 'None' AND sheetSyncedAt has not been recorded yet
  const hasCachedTools =
    config &&
    typeof config.accountingTool === "string" &&
    typeof config.crmTool === "string" &&
    (Boolean(config.sheetSyncedAt) || !(config.accountingTool === "None" && config.crmTool === "None"));
  const needsSheetSync = forceSheetSync || !hasCachedTools;

  let resolvedMasterSheetId = unwrapSheetId(masterSheetId || config?.masterSheetId || "");
  let resolvedClientSheetId = unwrapSheetId(clientSheetId || config?.clientSheetId || "");
  let sheetQ4 = config?.accountingTool || "None";
  let sheetQ8 = config?.crmTool || "None";
  let sheetQ9 = config?.crmDrives || "NA";

  if (needsSheetSync) {
    try {
      const sheets = await getSheetsClient();
      if (!resolvedClientSheetId) {
        resolvedClientSheetId = await resolveClientSheetIdByClientName(sheets, clientName);
      }
      if (!resolvedMasterSheetId) {
        resolvedMasterSheetId = await resolveMasterSheetIdByClientName(sheets, clientName);
      }
      const targetKeyInfoSheetId = resolvedClientSheetId || resolvedMasterSheetId;
      if (targetKeyInfoSheetId) {
        const res = await withRetry(() =>
          sheets.spreadsheets.values.batchGet({
            spreadsheetId: targetKeyInfoSheetId,
            ranges: ["KeyInfo!Q4:Q9", "KeyInfo!B15", "KeyInfo!D8"]
          })
        );
        const valueRanges = res.data.valueRanges || [];
        const rows = valueRanges[0]?.values || [];
        sheetQ4 = (rows[0] && rows[0][0]) ? String(rows[0][0]).trim() : "None";
        sheetQ8 = (rows[4] && rows[4][0]) ? String(rows[4][0]).trim() : "None";
        sheetQ9 = (rows[5] && rows[5][0]) ? String(rows[5][0]).trim() : "NA";
        const sheetB15 = String(valueRanges[1]?.values?.[0]?.[0] || "Revenue").trim();
        const rawD8 = String(valueRanges[2]?.values?.[0]?.[0] || "Contractors").trim();
        const sheetD8 = sheetB15 === "Income" ? "Pass-through" : (rawD8 === "Pass-through" ? "Pass-through" : "Contractors");

        // Persist to Redis so future visits load instantly from memory
        const updatedRecord = {
          ...(config || {}),
          clientName,
          masterSheetId: resolvedMasterSheetId,
          setupMode: config?.setupMode === true,
          pulseLive: config?.pulseLive === true || config?.setupMode !== true,
          requestConnections: config?.requestConnections === true,
          accountingTool: sheetQ4,
          crmTool: sheetQ8,
          crmDrives: sheetQ9,
          revenueFocus: sheetB15,
          directCostsMode: sheetD8,
          sheetSyncedAt: new Date().toISOString(),
          updatedAt: config?.updatedAt || new Date().toISOString()
        };
        await redisClient.set(redisKey, JSON.stringify(updatedRecord));
        if (sheetD8 !== config?.directCostsMode || sheetB15 !== config?.revenueFocus) {
          await invalidateAllClientsRedisKeys();
          clearAllClientsMemoryCache();
          clearSsrClientsMemoryCache();
        }
        config = updatedRecord;
      }
    } catch (sheetErr) {
      console.log(`Note reading KeyInfo!Q4:Q9 for ${clientName}:`, sheetErr.message);
    }
  }

  // Merge Redis config with sheet values
  const setupMode = config?.setupMode === true;
  const pulseLive = !setupMode || config?.pulseLive === true;
  let requestConnections = config?.requestConnections === true;
  const accountingTool = config?.accountingTool || sheetQ4 || "None";
  const crmTool = config?.crmTool || sheetQ8 || "None";
  const crmDrives = config?.crmDrives || sheetQ9 || "NA";

  // Check live connection statuses from Vault
  let accountingStatus = { connected: false, tool: accountingTool };
  if (isOAuthTool(accountingTool)) {
    accountingStatus = await getIntegrationStatus({
      clientKey: clientName,
      masterSheetId: resolvedMasterSheetId,
      tool: accountingTool
    });
  }

  let crmStatus = { connected: false, tool: crmTool };
  const cleanCrm = String(crmTool || "").trim().toLowerCase();
  const crmKey = cleanCrm.includes("sheet") ? "googlesheet" : cleanCrm.includes("excel") ? "excel" : cleanCrm;

  if (isOAuthTool(crmTool)) {
    crmStatus = await getIntegrationStatus({
      clientKey: clientName,
      masterSheetId: resolvedMasterSheetId,
      tool: crmKey
    });
  }

  // Fallback for Google Sheet / Excel with valid sheet parameters in KeyInfo
  if (!crmStatus?.connected && cleanCrm.includes("sheet")) {
    const gUrl = config?.googleSheetUrl;
    if (gUrl && gUrl.startsWith("http")) {
      crmStatus = {
        connected: true,
        tool: "googlesheet",
        status: "connected",
        tenantName: config?.googleSheetTab || "Pipeline",
        companyName: config?.googleSheetTab || "Pipeline"
      };
    }
  } else if (!crmStatus?.connected && cleanCrm.includes("excel")) {
    if (config?.excel?.fileId || config?.excel?.driveId) {
      crmStatus = {
        connected: false,
        reconnectRequired: true,
        tool: "excel",
        status: "reconnect_required",
        tenantName: config?.excel?.sheetName || "Sheet1",
        companyName: config?.excel?.sheetName || "Sheet1"
      };
    }
  }

  // Calculate required tools that require API connection
  const requiredOAuthTools = [];
  if (isOAuthTool(accountingTool)) {
    requiredOAuthTools.push({
      tool: accountingTool.toLowerCase(),
      name: accountingTool,
      type: "accounting",
      connected: Boolean(accountingStatus.connected)
    });
  }
  if (isOAuthTool(crmTool)) {
    requiredOAuthTools.push({
      tool: crmKey,
      name: crmTool,
      type: "crm",
      connected: Boolean(crmStatus.connected)
    });
  }

  const hasRequiredTools = requiredOAuthTools.length > 0;
  const allRequiredToolsConnected = !hasRequiredTools || requiredOAuthTools.every(t => t.connected);

  if (requestConnections && hasRequiredTools && allRequiredToolsConnected) {
    requestConnections = await autoClearRequestConnectionsIfReady_({
      clientName,
      redisKey,
      config: {
        ...(config || {}),
        clientName,
        masterSheetId: masterSheetId || config?.masterSheetId || "",
        setupMode,
        pulseLive,
        requestConnections,
        accountingTool,
        crmTool,
        crmDrives,
      },
      hasRequiredTools,
      allConnected: allRequiredToolsConnected,
    });
  }

  const fullConfig = {
    clientName,
    masterSheetId: masterSheetId || config?.masterSheetId || "",
    setupMode,
    pulseLive,
    requestConnections,
    accountingTool,
    crmTool,
    crmDrives,
    accountingStatus,
    crmStatus,
    requiredOAuthTools,
    allRequiredToolsConnected,
    updatedAt: config?.updatedAt || null,
    updatedBy: config?.updatedBy || null
  };

  return fullConfig;
}

const PORTAL_LIVE_GATE_TTL_MS = 3000;
const _portalLiveGateCache = new Map();

/**
 * Blocks Pulse-only users from accessing tenant portal APIs while the client is
 * in Setup Holding Gate (setupMode === true && pulseLive !== true).
 */
export async function assertClientPortalLive(sessionUser, clientName, res = null) {
  if (!clientName || !isPulseOnlyUser(sessionUser)) {
    return { allowed: true };
  }
  const norm = normalizeKey(clientName);
  const cached = _portalLiveGateCache.get(norm);
  let gated = false;
  if (cached && cached.expiresAt > Date.now()) {
    gated = cached.gated;
  } else {
    let cfg = null;
    try {
      await ensureRedisConnected(300).catch(() => { });
      const raw = await redisClient.get(getSetupRedisKey(clientName));
      if (raw) cfg = JSON.parse(raw);
    } catch { }
    if (!cfg && isSupabaseConfigured()) {
      try {
        const sb = getSupabaseAdmin();
        const { data: dbClient } = await sb
          .from("clients")
          .select("metadata")
          .eq("normalized_key", norm)
          .maybeSingle();
        if (dbClient?.metadata && typeof dbClient.metadata === "object") {
          cfg = {
            setupMode: dbClient.metadata.setupMode === true,
            pulseLive: dbClient.metadata.pulseLive === true || dbClient.metadata.setupMode !== true,
          };
        }
      } catch { }
    }
    gated = Boolean(cfg && cfg.setupMode === true && !cfg.pulseLive);
    _portalLiveGateCache.set(norm, { gated, expiresAt: Date.now() + PORTAL_LIVE_GATE_TTL_MS });
  }
  if (gated) {
    if (res && !res.headersSent) {
      res.status(403).json({
        success: false,
        setupHolding: true,
        error: "Your Pulse workspace is currently being configured and will be available shortly.",
      });
    }
    return { allowed: false };
  }
  return { allowed: true };
}

/**
 * Saves client setup configuration to Redis and persists tool choices to Master Sheet KeyInfo.
 */
export async function saveClientSetupConfig({
  clientName,
  masterSheetId,
  setupMode,
  pulseLive,
  requestConnections,
  accountingTool,
  crmTool,
  crmDrives,
  updatedBy
}) {
  if (!clientName) throw new Error("Missing clientName parameter.");

  const redisKey = getSetupRedisKey(clientName);
  _portalLiveGateCache.delete(normalizeKey(clientName));
  const now = new Date().toISOString();

  // Read existing cached data so we preserve any integration objects (e.g. googleSheet, excel)
  let existing = {};
  try {
    const raw = await redisClient.get(redisKey);
    if (raw) existing = JSON.parse(raw);
  } catch (e) {
    // Ignore read error
  }

  const nextSetupMode = Boolean(setupMode);
  const nextPulseLive = !nextSetupMode
    ? true
    : (pulseLive !== undefined ? Boolean(pulseLive) : Boolean(existing.pulseLive));

  const record = {
    ...existing,
    clientName,
    masterSheetId: masterSheetId || existing.masterSheetId || "",
    setupMode: nextSetupMode,
    pulseLive: nextPulseLive,
    requestConnections: nextSetupMode ? Boolean(requestConnections) : false,
    accountingTool: accountingTool !== undefined ? accountingTool : (existing.accountingTool || "None"),
    crmTool: crmTool !== undefined ? crmTool : (existing.crmTool || "None"),
    crmDrives: crmDrives !== undefined ? crmDrives : (existing.crmDrives || "NA"),
    updatedAt: now,
    updatedBy: updatedBy || existing.updatedBy || "Admin"
  };

  // 1. Persist to Redis and invalidate cached multi-client integration status
  try {
    await redisClient.set(redisKey, JSON.stringify(record));
    await redisClient.del(INTEGRATIONS_STATUS_CACHE_KEY).catch(() => { });
  } catch (err) {
    console.error(`Error writing setup config to Redis for ${clientName}:`, err);
    throw err;
  }

  // 2. Persist tool selections to Master Sheet KeyInfo!Q4, Q8, Q9 (if spreadsheet-backed) and Supabase
  const realMasterSheetId = unwrapSheetId(masterSheetId || record.masterSheetId);
  if (realMasterSheetId) {
    try {
      const sheets = await getSheetsClient();
      await withRetry(() =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: realMasterSheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: [
              { range: "KeyInfo!Q4", values: [[sanitizeFormulaInput(String(record.accountingTool || "None"))]] },
              { range: "KeyInfo!Q8", values: [[sanitizeFormulaInput(String(record.crmTool || "None"))]] },
              { range: "KeyInfo!Q9", values: [[sanitizeFormulaInput(String(record.crmDrives || "NA"))]] }
            ]
          }
        })
      );
      console.log(`✅ Saved KeyInfo Q4/Q8/Q9 for ${clientName}: Accounting=${record.accountingTool}, CRM=${record.crmTool}, Drives=${record.crmDrives}`);
    } catch (sheetErr) {
      console.error(`Warning: Failed to update KeyInfo Q4/Q8/Q9 for ${clientName}:`, sheetErr.message);
      // Non-fatal for the web response, but logged
    }
  }

  if (isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      const norm = normalizeKey(clientName);
      const { data: existingClient } = await sb
        .from("clients")
        .select("id, metadata")
        .eq("normalized_key", norm)
        .maybeSingle();
      if (existingClient?.id) {
        const nextMeta = {
          ...(existingClient.metadata || {}),
          setupMode: Boolean(record.setupMode),
          pulseLive: Boolean(record.pulseLive),
          requestConnections: Boolean(record.requestConnections),
          accountingTool: record.accountingTool || "None",
          crmTool: record.crmTool || "None",
          crmDrives: record.crmDrives || "NA",
        };
        await sb.from("clients").update({ metadata: nextMeta, updated_at: now }).eq("id", existingClient.id);
        await sb
          .from("tenant_key_info")
          .update({
            accounting_tool: record.accountingTool || "None",
            crm_tool: record.crmTool || "None",
            crm_drives: record.crmDrives || "NA",
            updated_at: now,
          })
          .eq("client_id", existingClient.id);
      }
    } catch (sbSyncErr) {
      console.warn("Supabase saveClientSetupConfig metadata sync notice:", sbSyncErr.message);
    }
  }

  // 3. Update setup status in Supabase client_setup_state (and AC in legacy mode)
  try {
    const sheets = await getSheetsClient().catch(() => null);
    if (!record.setupMode) {
      await updateClientSetupOverviewRow(sheets, {
        clientName,
        status: "LIVE",
        progressPercent: 100,
        completedAt: now
      });
    } else {
      await updateClientSetupOverviewRow(sheets, {
        clientName,
        status: "IN_PROGRESS"
      });
    }
  } catch (overviewErr) {
    console.warn("ClientSetupOverview sync notice:", overviewErr.message);
  }

  return await getClientSetupConfig({ clientName, masterSheetId });
}

/**
 * Fast lookup for the client portal auth gate (/pulse).
 * Safe and fast; returns false for any client without setup mode enabled.
 */
export async function getClientSetupStatusForPortal({ clientName, masterSheetId, clientSheetId }) {
  if (!clientName) return { setupMode: false, configuredTools: [], hasDisconnectedTools: false };

  const redisKey = getSetupRedisKey(clientName);
  let config = null;

  try {
    const raw = await redisClient.get(redisKey);
    if (raw) {
      config = JSON.parse(raw);
    }
  } catch (err) {
    console.error(`Error querying Redis setup config for ${clientName}:`, err);
  }

  // If no Redis config yet, attempt reading KeyInfo!Q4:Q9 from Client Sheet (falling back to Master Sheet)
  let resolvedMasterSheetId = unwrapSheetId(masterSheetId || config?.masterSheetId || "");
  let resolvedClientSheetId = unwrapSheetId(clientSheetId || config?.clientSheetId || "");
  let accountingTool = config?.accountingTool || "None";
  let crmTool = config?.crmTool || "None";

  const needsInitialSync = !config || (!config.sheetSyncedAt && accountingTool === "None" && crmTool === "None");

  if (needsInitialSync) {
    try {
      const sheets = await getSheetsClient();
      if (!resolvedClientSheetId) {
        resolvedClientSheetId = await resolveClientSheetIdByClientName(sheets, clientName);
      }
      if (!resolvedMasterSheetId) {
        resolvedMasterSheetId = await resolveMasterSheetIdByClientName(sheets, clientName);
      }
      const targetKeyInfoSheetId = resolvedClientSheetId || resolvedMasterSheetId;
      if (targetKeyInfoSheetId) {
        const res = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: targetKeyInfoSheetId,
            range: "KeyInfo!Q4:Q9"
          })
        );
        const rows = res.data.values || [];
        const sheetQ4 = (rows[0] && rows[0][0]) ? String(rows[0][0]).trim() : "None";
        const sheetQ8 = (rows[4] && rows[4][0]) ? String(rows[4][0]).trim() : "None";
        const sheetQ9 = (rows[5] && rows[5][0]) ? String(rows[5][0]).trim() : "NA";
        if (accountingTool === "None" && sheetQ4 !== "None") accountingTool = sheetQ4;
        if (crmTool === "None" && sheetQ8 !== "None") crmTool = sheetQ8;

        config = {
          ...(config || {}),
          clientName,
          masterSheetId: resolvedMasterSheetId,
          clientSheetId: resolvedClientSheetId,
          setupMode: config?.setupMode === true,
          requestConnections: config?.requestConnections === true,
          accountingTool,
          crmTool,
          crmDrives: config?.crmDrives || sheetQ9,
          sheetSyncedAt: new Date().toISOString(),
          updatedAt: config?.updatedAt || new Date().toISOString()
        };
        await redisClient.set(redisKey, JSON.stringify(config)).catch(() => { });
      }
    } catch (sheetErr) {
      // Non-fatal sheet read note
    }
  }

  // Also load Supabase metadata fallback if Redis has no config yet
  if (!config && isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      const { data: dbClient } = await sb
        .from("clients")
        .select("master_sheet_id, client_sheet_id, metadata")
        .eq("normalized_key", normalizeKey(clientName))
        .maybeSingle();
      if (dbClient?.metadata && typeof dbClient.metadata === "object") {
        config = {
          clientName,
          masterSheetId: dbClient.master_sheet_id || resolvedMasterSheetId,
          clientSheetId: dbClient.client_sheet_id || resolvedClientSheetId,
          setupMode: dbClient.metadata.setupMode === true,
          pulseLive: dbClient.metadata.pulseLive === true || dbClient.metadata.setupMode !== true,
          requestConnections: dbClient.metadata.requestConnections === true,
          accountingTool: dbClient.metadata.accountingTool || accountingTool,
          crmTool: dbClient.metadata.crmTool || crmTool,
          crmDrives: dbClient.metadata.crmDrives || "NA",
        };
        accountingTool = config.accountingTool;
        crmTool = config.crmTool;
      }
    } catch (_) { }
  }

  const setupMode = config?.setupMode === true;
  const pulseLive = !setupMode || config?.pulseLive === true;
  let requestConnections = config?.requestConnections === true;

  // Evaluate configured tools and connection health
  const configuredTools = [];

  const checkTool = async (toolName, type) => {
    if (!isOAuthTool(toolName)) return;
    const cleanLower = toolName.toLowerCase();
    const cleanTool = cleanLower.includes("sheet") ? "googlesheet" : cleanLower.includes("excel") ? "excel" : cleanLower;
    let status = await getIntegrationStatus({
      clientKey: clientName,
      masterSheetId: resolvedMasterSheetId,
      tool: cleanTool
    });

    if (!status?.connected && !status?.reconnectRequired && cleanLower.includes("sheet")) {
      if (config?.googleSheetUrl && config.googleSheetUrl.startsWith("http")) {
        status = { connected: true, status: "connected", tenantName: config.googleSheetTab || "Pipeline" };
      }
    }

    let hasLinkedSpreadsheet = true;
    const computeHasLinkedSpreadsheet = () => {
      if (cleanTool === "googlesheet") {
        return Boolean(
          config?.googleSheetUrl ||
          status?.metadata?.url ||
          status?.metadata?.spreadsheetId ||
          status?.metadata?.spreadsheetTitle
        );
      }
      if (cleanTool === "excel") {
        return Boolean(
          config?.excel?.fileId ||
          config?.excel?.driveId ||
          status?.metadata?.fileId ||
          status?.metadata?.driveId ||
          status?.metadata?.url
        );
      }
      return true;
    };

    hasLinkedSpreadsheet = computeHasLinkedSpreadsheet();

    // Fallback: if Redis config/Vault metadata hasn't cached KeyInfo spreadsheet coords yet, read once from Master Sheet
    if (!hasLinkedSpreadsheet && (cleanTool === "excel" || cleanTool === "googlesheet")) {
      try {
        const sheets = await getSheetsClient();
        if (!resolvedMasterSheetId) {
          resolvedMasterSheetId = await resolveMasterSheetIdByClientName(sheets, clientName);
        }
        if (resolvedMasterSheetId) {
          const range = cleanTool === "excel" ? "KeyInfo!X36:X38" : "KeyInfo!X11:X12";
          const kiRes = await withRetry(() =>
            sheets.spreadsheets.values.get({
              spreadsheetId: resolvedMasterSheetId,
              range
            })
          );
          const vals = kiRes.data.values || [];
          if (cleanTool === "excel") {
            const driveId = String(vals[0]?.[0] || "").trim();
            const fileId = String(vals[1]?.[0] || "").trim();
            const sheetName = String(vals[2]?.[0] || "").trim();
            if (driveId || fileId) {
              config = {
                ...(config || {}),
                clientName,
                masterSheetId: resolvedMasterSheetId,
                excel: { ...(config?.excel || {}), driveId, fileId, sheetName }
              };
              await redisClient.set(redisKey, JSON.stringify(config)).catch(() => { });
            }
          } else {
            const gUrl = String(vals[0]?.[0] || "").trim();
            const gTab = String(vals[1]?.[0] || "").trim();
            if (gUrl && gUrl.startsWith("http")) {
              config = {
                ...(config || {}),
                clientName,
                masterSheetId: resolvedMasterSheetId,
                googleSheetUrl: gUrl,
                googleSheetTab: gTab
              };
              await redisClient.set(redisKey, JSON.stringify(config)).catch(() => { });
              if (!status?.connected && !status?.reconnectRequired) {
                status = { connected: true, status: "connected", tenantName: gTab || "Pipeline" };
              }
            }
          }
          hasLinkedSpreadsheet = computeHasLinkedSpreadsheet();
        }
      } catch (_) {
        // Non-fatal Master Sheet fallback note
      }
    }

    const isConnected = Boolean(status?.connected) && hasLinkedSpreadsheet;
    const hasEverConnected = Boolean(
      status?.updatedAt ||
      status?.lastRefreshedAt ||
      status?.tokens ||
      status?.metadata?.userEmail ||
      status?.reconnectRequired ||
      status?.status === "reconnect_required" ||
      status?.status === "expired"
    );
    const needsReconnect = (!isConnected && hasEverConnected) || status?.status === "reconnect_required" || Boolean(status?.reconnectRequired);

    configuredTools.push({
      tool: cleanTool,
      name: toolName,
      type,
      connected: isConnected,
      hasLinkedSpreadsheet,
      needsReconnect,
      hasEverConnected,
      status: status?.status || (isConnected ? "connected" : "disconnected"),
      tenantName: status?.tenantName || status?.companyName || ""
    });
  };

  try {
    await Promise.all([
      checkTool(accountingTool, "accounting"),
      checkTool(crmTool, "crm")
    ]);
  } catch (evalErr) {
    console.error(`Error checking tool health for ${clientName}:`, evalErr);
  }

  const unconnectedTools = configuredTools.filter(t => !t.connected);
  const connectedTools = configuredTools.filter(t => t.connected);
  const hasRequiredTools = configuredTools.length > 0;
  const allToolsConnected = !hasRequiredTools || unconnectedTools.length === 0;
  const hasDisconnectedTools = configuredTools.some(t => !t.connected || t.needsReconnect);

  if (requestConnections && hasRequiredTools && allToolsConnected) {
    requestConnections = await autoClearRequestConnectionsIfReady_({
      clientName,
      redisKey,
      config: {
        ...(config || {}),
        clientName,
        masterSheetId: resolvedMasterSheetId,
        clientSheetId: resolvedClientSheetId,
        setupMode,
        pulseLive,
        requestConnections,
        accountingTool,
        crmTool,
      },
      hasRequiredTools,
      allConnected: allToolsConnected,
    });
  }

  return {
    setupMode,
    pulseLive,
    requestConnections,
    requiredTools: configuredTools,
    unconnectedTools,
    connectedTools,
    allToolsConnected,
    configuredTools,
    hasDisconnectedTools
  };
}

/**
 * Asynchronously revalidates client setup configs from Google Sheets in the background.
 * Checks clients that haven't been synced from the sheet recently (or whose cache is stale)
 * and updates Redis without blocking the API response.
 */
export function revalidateClientsSetupInBackground(clients = []) {
  if (!Array.isArray(clients) || clients.length === 0) return;

  // Run asynchronously in background without blocking response
  Promise.resolve().then(async () => {
    try {
      const ONE_HOUR = 60 * 60 * 1000;
      const now = Date.now();

      let anyClientChanged = false;
      for (const c of clients) {
        if (!c.clientName || !c.masterSheetId) continue;
        const redisKey = getSetupRedisKey(c.clientName);
        let config = null;
        try {
          const raw = await redisClient.get(redisKey);
          if (raw) config = JSON.parse(raw);
        } catch { }

        const lastSynced = config?.sheetSyncedAt ? new Date(config.sheetSyncedAt).getTime() : 0;
        const isStale = (now - lastSynced) > ONE_HOUR || !config?.directCostsMode;

        if (isStale) {
          try {
            const sheets = await getSheetsClient();
            const res = await withRetry(() =>
              sheets.spreadsheets.values.batchGet({
                spreadsheetId: c.masterSheetId,
                ranges: ["KeyInfo!Q4:Q9", "KeyInfo!B15", "KeyInfo!D8"]
              })
            );
            const valueRanges = res.data.valueRanges || [];
            const rows = valueRanges[0]?.values || [];
            const sheetQ4 = (rows[0] && rows[0][0]) ? String(rows[0][0]).trim() : "None";
            const sheetQ8 = (rows[4] && rows[4][0]) ? String(rows[4][0]).trim() : "None";
            const sheetQ9 = (rows[5] && rows[5][0]) ? String(rows[5][0]).trim() : "NA";
            const sheetB15 = String(valueRanges[1]?.values?.[0]?.[0] || "Revenue").trim();
            const rawD8 = String(valueRanges[2]?.values?.[0]?.[0] || "Contractors").trim();
            const sheetD8 = sheetB15 === "Income" ? "Pass-through" : (rawD8 === "Pass-through" ? "Pass-through" : "Contractors");

            if (
              sheetQ4 !== config?.accountingTool ||
              sheetQ8 !== config?.crmTool ||
              sheetQ9 !== config?.crmDrives ||
              sheetB15 !== config?.revenueFocus ||
              sheetD8 !== config?.directCostsMode
            ) {
              anyClientChanged = true;
              console.log(`🔄 Setup Background Sync: Updated config for "${c.clientName}" in Redis: Acc=${sheetQ4}, CRM=${sheetQ8}, Mode=${sheetB15}/${sheetD8}`);
            }

            const updatedRecord = {
              ...(config || {}),
              clientName: c.clientName,
              masterSheetId: c.masterSheetId,
              setupMode: config?.setupMode === true,
              requestConnections: config?.requestConnections === true,
              accountingTool: sheetQ4,
              crmTool: sheetQ8,
              crmDrives: sheetQ9,
              revenueFocus: sheetB15,
              directCostsMode: sheetD8,
              sheetSyncedAt: new Date().toISOString(),
              updatedAt: config?.updatedAt || new Date().toISOString()
            };
            await redisClient.set(redisKey, JSON.stringify(updatedRecord));
          } catch (syncErr) {
            // Ignore background revalidation errors for individual clients
          }
        }
      }
      if (anyClientChanged) {
        try {
          await invalidateAllClientsRedisKeys();
          clearAllClientsMemoryCache();
          clearSsrClientsMemoryCache();
        } catch { }
      }
    } catch (bgErr) {
      console.warn("Background setup revalidation notice:", bgErr.message);
    }
  });
}

/**
 * ============================================================================
 * ONBOARDING & SETUP CHECKLIST FUNCTIONS (AUTOMATION COMMANDER STORAGE)
 * ============================================================================
 */

let setupTabsVerified = false;

/**
 * Ensure ClientSetupOverview, ClientSetupTasks, and SetupProcessTemplate tabs exist on Automation Commander.
 */
export async function ensureClientSetupTabs(sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID) {
  const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
  if (setupTabsVerified) return;

  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: acId,
      fields: "sheets.properties.title"
    });
    const titles = new Set((meta.data.sheets || []).map(s => s.properties.title));

    const requests = [];
    if (!titles.has(CLIENT_SETUP_OVERVIEW_TAB)) {
      requests.push({
        addSheet: {
          properties: {
            title: CLIENT_SETUP_OVERVIEW_TAB,
            gridProperties: { rowCount: 500, columnCount: 15, frozenRowCount: 1 }
          }
        }
      });
    }
    if (!titles.has(CLIENT_SETUP_TASKS_TAB)) {
      requests.push({
        addSheet: {
          properties: {
            title: CLIENT_SETUP_TASKS_TAB,
            gridProperties: { rowCount: 5000, columnCount: 10, frozenRowCount: 1 }
          }
        }
      });
    }
    if (!titles.has(SETUP_PROCESS_TEMPLATE_TAB)) {
      requests.push({
        addSheet: {
          properties: {
            title: SETUP_PROCESS_TEMPLATE_TAB,
            gridProperties: { rowCount: 200, columnCount: 15, frozenRowCount: 1 }
          }
        }
      });
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: acId,
        requestBody: { requests }
      });

      if (!titles.has(CLIENT_SETUP_OVERVIEW_TAB)) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: acId,
          range: `${CLIENT_SETUP_OVERVIEW_TAB}!A1:L1`,
          valueInputOption: "RAW",
          requestBody: {
            values: [[
              "Client Name", "Status", "Progress %", "Completed Tasks", "Total Tasks",
              "Started At", "Completed At", "Drive Folder URL", "Client Sheet URL",
              "Master Sheet URL", "Recon Sheet URL", "Backup Sheet URL"
            ]]
          }
        });
      }

      if (!titles.has(CLIENT_SETUP_TASKS_TAB)) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: acId,
          range: `${CLIENT_SETUP_TASKS_TAB}!A1:H1`,
          valueInputOption: "RAW",
          requestBody: {
            values: [[
              "Client Name", "Phase ID", "Task ID", "Task Title",
              "Is Completed", "Completed At", "Completed By", "Metadata"
            ]]
          }
        });
      }

      if (!titles.has(SETUP_PROCESS_TEMPLATE_TAB)) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: acId,
          range: `${SETUP_PROCESS_TEMPLATE_TAB}!A1:L1`,
          valueInputOption: "RAW",
          requestBody: {
            values: [[
              "Phase ID", "Phase Title", "Phase Description", "Phase Order",
              "Task ID", "Task Title", "Task Order", "Auto Completable",
              "Notes", "Active", "Updated At", "Updated By"
            ]]
          }
        });

        // Seed default tasks
        const defaultRows = DEFAULT_SETUP_TASKS_CATALOG.map((t, idx) => {
          const phase = DEFAULT_SETUP_PHASES.find(p => p.id === t.phaseId);
          const phaseOrder = phase ? (DEFAULT_SETUP_PHASES.indexOf(phase) + 1) : 1;
          return [
            t.phaseId,
            phase?.title || "",
            phase?.description || "",
            phaseOrder,
            t.id,
            t.title,
            (idx + 1) * 10,
            t.autoCompletable ? "TRUE" : "FALSE",
            "",
            "TRUE",
            new Date().toISOString(),
            "System Initialiser"
          ];
        });
        await sheets.spreadsheets.values.update({
          spreadsheetId: acId,
          range: `${SETUP_PROCESS_TEMPLATE_TAB}!A2:L${defaultRows.length + 1}`,
          valueInputOption: "RAW",
          requestBody: { values: defaultRows }
        });
      }
    }
    setupTabsVerified = true;
  } catch (err) {
    console.warn("⚠️ ensureClientSetupTabs error:", err.message);
  }
}

function normalizeSetupPhases(phases = []) {
  const defaultMap = new Map(DEFAULT_SETUP_PHASES.map(p => [p.id, p]));
  const legacyTitleMap = {
    "1. infrastructure & sheet linking": "Step 0: Infrastructure & sheet linking",
    "0. infrastructure & sheet linking": "Step 0: Infrastructure & sheet linking",
    "2. settings & tool connections": "Step 1: Settings & tool connections",
    "1. settings & tool connections": "Step 1: Settings & tool connections",
    "3. accounting baseline & data": "Step 2: Accounting baseline & data",
    "2. accounting baseline & data": "Step 2: Accounting baseline & data",
    "4. automations & cadence": "Step 3: CRM setup & review",
    "3. automations & cadence": "Step 3: CRM setup & review",
    "step 3: automations & cadence": "Step 3: CRM setup & review",
    "5. user access & go-live": "Step 4: Go live and final data capture",
    "4. user access & go-live": "Step 4: Go live and final data capture",
    "step 4: user access & go-live": "Step 4: Go live and final data capture"
  };
  return (phases || []).map(p => {
    const def = defaultMap.get(p.id);
    const lowerTitle = String(p.title || "").trim().toLowerCase();
    const normalizedTitle = legacyTitleMap[lowerTitle] || p.title || def?.title || p.id;
    const normalizedDesc =
      (p.id === "phase_5" && String(p.description || "").trim().toLowerCase().includes("client user assignment")) ||
        (p.id === "phase_4" && String(p.description || "").trim().toLowerCase().includes("trigger scheduling"))
        ? def?.description || p.description
        : p.description;
    return {
      ...p,
      title: normalizedTitle,
      description: normalizedDesc,
      adminOnly: p.id === "phase_1" || Boolean(p.adminOnly || def?.adminOnly)
    };
  });
}

const RETIRED_SETUP_TASK_IDS = new Set([
  "p2_select_tools",
  "p3_contractors_info",
  "p3_employee_salaries",
  "p3_dividends_info",
  "p4_review_retainers",
  "p4_agent_trigger",
  "p4_pl_trigger",
  "p4_automation_freq",
  "p4_ac_enrollment",
  "p4_rep_control",
  "p4_eom_jobs",
  "p5_add_users",
]);

const RENAMED_SETUP_TASK_TITLES = {
  p2_connect_accounting: {
    legacyMatches: [
      "connect to accounting tool via pulse vault",
      "connect to accounting tool",
    ],
    title: "Awaiting client connection to accounting tool",
  },
  p2_connect_crm: {
    legacyMatches: [
      "connect to crm tool via pulse vault",
      "connect to crm tool",
    ],
    title: "Awaiting client connection to CRM tool",
  },
  p2_keyinfo_settings: {
    legacyMatches: [
      "adjust core settings in keyinfo (start date, vat, paye, revenue focus, profit share %)",
      "adjust core settings in keyinfo (start date, vat, paye, revenue focus, profit share %, automation cadences)",
    ],
    title: "Adjust core settings in KeyInfo (Start date, VAT, PAYE, Revenue focus, Profit share %, Invoice formatting, Automation cadences)",
  },
  p3_other_expenses: {
    legacyMatches: ["add 'other expenses' forecast amounts into outgoings tab"],
    title: "Create budget",
  },
  p5_email_client: {
    legacyMatches: ["email client with login details and launch live access"],
    title: "Email client saying Pulse is live and requesting further information",
  },
};

function normalizeSetupTasks(tasks = []) {
  let changed = false;
  const orderByDefaultId = new Map(
    DEFAULT_SETUP_TASKS_CATALOG.map((t, idx) => [t.id, (idx + 1) * 10])
  );
  const defaultById = new Map(
    DEFAULT_SETUP_TASKS_CATALOG.map((t) => [t.id, t])
  );

  const kept = [];
  const seenIds = new Set();

  for (const t of tasks || []) {
    if (!t || !t.id) continue;
    if (RETIRED_SETUP_TASK_IDS.has(t.id)) {
      changed = true;
      continue;
    }
    seenIds.add(t.id);
    let nextTask = t;
    const def = defaultById.get(t.id);
    if (def && def.phaseId && t.phaseId !== def.phaseId) {
      nextTask = {
        ...nextTask,
        phaseId: def.phaseId,
        order: orderByDefaultId.get(t.id),
      };
      changed = true;
    }
    const renameRule = RENAMED_SETUP_TASK_TITLES[t.id];
    if (renameRule) {
      const lowerTitle = String(nextTask.title || "").trim().toLowerCase();
      if (renameRule.legacyMatches.includes(lowerTitle)) {
        nextTask = { ...nextTask, title: renameRule.title };
        changed = true;
      }
    }
    kept.push(nextTask);
  }

  // Ensure any newly introduced built-in catalog tasks (e.g. p3_select_bank_accounts, p3_starter_pl)
  // are inserted cleanly at the appropriate position if missing from persisted template.
  for (let i = 0; i < DEFAULT_SETUP_TASKS_CATALOG.length; i++) {
    const def = DEFAULT_SETUP_TASKS_CATALOG[i];
    if (seenIds.has(def.id)) continue;
    // Pick an order placed cleanly between its predecessor and successor in the kept list
    const prevDef = i > 0 ? DEFAULT_SETUP_TASKS_CATALOG[i - 1] : null;
    const nextDef = i + 1 < DEFAULT_SETUP_TASKS_CATALOG.length ? DEFAULT_SETUP_TASKS_CATALOG[i + 1] : null;
    const prevTask = prevDef ? kept.find((x) => x.id === prevDef.id) : null;
    const nextTask = nextDef ? kept.find((x) => x.id === nextDef.id) : null;
    let derivedOrder = orderByDefaultId.get(def.id);
    if (prevTask && nextTask && Number.isFinite(Number(prevTask.order)) && Number.isFinite(Number(nextTask.order))) {
      derivedOrder = Math.round((Number(prevTask.order) + Number(nextTask.order)) / 2);
      if (derivedOrder === Number(prevTask.order) || derivedOrder === Number(nextTask.order)) {
        derivedOrder = Number(prevTask.order) + 5;
      }
    } else if (prevTask && Number.isFinite(Number(prevTask.order))) {
      derivedOrder = Number(prevTask.order) + 5;
    } else if (nextTask && Number.isFinite(Number(nextTask.order))) {
      derivedOrder = Math.max(1, Number(nextTask.order) - 5);
    }

    kept.push({
      ...def,
      order: derivedOrder,
      active: true,
      description: "",
    });
    seenIds.add(def.id);
    changed = true;
  }

  // Ensure built-in phase order constraints (p4_crm_list_tab before p4_review_crm; p4_datachg_flags after p2_keyinfo_settings)
  const ensureRelativeOrder = (firstId, secondId) => {
    const first = kept.find((x) => x.id === firstId);
    const second = kept.find((x) => x.id === secondId);
    if (first && second && first.phaseId === second.phaseId && Number(first.order) >= Number(second.order)) {
      const tmp = first.order;
      first.order = second.order;
      second.order = tmp === second.order ? tmp + 1 : tmp;
      changed = true;
    }
  };
  ensureRelativeOrder("p2_confirm_tools", "p2_request_connections_email");
  ensureRelativeOrder("p2_request_connections_email", "p2_connect_accounting");
  ensureRelativeOrder("p2_connect_accounting", "p2_connect_crm");
  ensureRelativeOrder("p2_connect_accounting", "p2_keyinfo_settings");
  ensureRelativeOrder("p4_crm_list_tab", "p4_review_crm");
  ensureRelativeOrder("p2_keyinfo_settings", "p4_datachg_flags");
  ensureRelativeOrder("p5_make_live", "p5_email_client");

  kept.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  return { tasks: kept, changed };
}

const SETUP_PROCESS_TEMPLATE_CONFIG_KEY = "setup_process_template";

function parseSetupTemplateSheetRows_(rows = []) {
  const phasesMap = new Map();
  DEFAULT_SETUP_PHASES.forEach((p, idx) => {
    phasesMap.set(p.id, { ...p, order: idx + 1 });
  });

  const tasks = [];
  rows.forEach((r, idx) => {
    const phaseId = String(r[0] || "").trim();
    const phaseTitle = String(r[1] || "").trim();
    const phaseDesc = String(r[2] || "").trim();
    const phaseOrder = Number(r[3]) || (phasesMap.size + 1);

    if (phaseId) {
      if (!phasesMap.has(phaseId)) {
        phasesMap.set(phaseId, {
          id: phaseId,
          title: phaseTitle || phaseId,
          description: phaseDesc || "",
          order: phaseOrder
        });
      } else {
        const existing = phasesMap.get(phaseId);
        if (phaseTitle) existing.title = phaseTitle;
        if (phaseDesc) existing.description = phaseDesc;
        if (r[3] !== undefined && r[3] !== "") existing.order = Number(r[3]);
      }
    }

    const taskId = String(r[4] || "").trim();
    const taskTitle = String(r[5] || "").trim();
    if (taskId && taskTitle) {
      const taskOrder = Number(r[6]) !== undefined && !isNaN(Number(r[6])) ? Number(r[6]) : ((idx + 1) * 10);
      const autoCompletable = String(r[7] || "").toUpperCase() === "TRUE";
      const description = String(r[8] || "").trim();
      const active = r[9] === undefined || String(r[9] || "").toUpperCase() !== "FALSE";

      tasks.push({
        id: taskId,
        phaseId,
        title: taskTitle,
        order: taskOrder,
        autoCompletable,
        description,
        active
      });
    }
  });

  const phases = normalizeSetupPhases(Array.from(phasesMap.values()).sort((a, b) => a.order - b.order));
  tasks.sort((a, b) => a.order - b.order);
  return { phases, tasks };
}

/**
 * Returns full setup process template (Phases & Tasks catalog) with Redis & Supabase persistence.
 */
export async function getSetupProcessTemplate(sheets, forceRefresh = false) {
  const cacheKey = "pulse:setup:process_template";
  if (!forceRefresh) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.phases?.length && parsed?.tasks?.length) {
          const norm = normalizeSetupTasks(parsed.tasks);
          if (!norm.changed) {
            return {
              ...parsed,
              phases: normalizeSetupPhases(parsed.phases),
              tasks: norm.tasks,
            };
          }
          // Fall through to normalize and persist Supabase/Redis when catalog changed
        }
      }
    } catch (e) {
      console.warn("Redis setup process template read error:", e.message);
    }
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data: cfgRow } = await sb
        .from("system_config")
        .select("value")
        .eq("key", SETUP_PROCESS_TEMPLATE_CONFIG_KEY)
        .maybeSingle();
      if (cfgRow?.value?.phases?.length && cfgRow?.value?.tasks?.length) {
        const norm = normalizeSetupTasks(cfgRow.value.tasks);
        const templateData = {
          phases: normalizeSetupPhases(cfgRow.value.phases),
          tasks: norm.tasks,
        };
        if (norm.changed) {
          try {
            await sb.from("system_config").upsert({
              key: SETUP_PROCESS_TEMPLATE_CONFIG_KEY,
              value: {
                ...cfgRow.value,
                phases: templateData.phases,
                tasks: templateData.tasks,
                updatedAt: new Date().toISOString(),
              },
              description: "Client onboarding setup phases and task checklist catalog",
              updated_by: "System (Catalog Sync)",
            });
          } catch (_) { }
          try {
            const keys = await scanRedisKeys("pulse:setup:checklist:*");
            if (keys?.length) await redisClient.del(keys);
          } catch (_) { }
        }
        await redisClient.set(cacheKey, JSON.stringify(templateData), { EX: 86400 }).catch(() => { });
        return templateData;
      }
    } catch (sbErr) {
      console.warn("Supabase setup_process_template read warning:", sbErr.message);
    }
  }

  const acId = DEFAULT_AC_SHEET_ID;
  let templateData = null;

  try {
    const activeSheets = sheets || (await getSheetsClient().catch(() => null));
    if (activeSheets && acId) {
      await ensureClientSetupTabs(activeSheets);
      const res = await withRetry(() =>
        activeSheets.spreadsheets.values.get({
          spreadsheetId: acId,
          range: `${SETUP_PROCESS_TEMPLATE_TAB}!A2:L200`
        })
      );
      const rows = res.data.values || [];
      if (rows.length > 0) {
        templateData = parseSetupTemplateSheetRows_(rows);
        templateData.tasks = normalizeSetupTasks(templateData.tasks).tasks;
      }
    }
  } catch (err) {
    console.warn("Setup process template AC sheet seed fallback:", err.message);
  }

  if (!templateData || !templateData.tasks?.length) {
    templateData = {
      phases: normalizeSetupPhases(DEFAULT_SETUP_PHASES),
      tasks: DEFAULT_SETUP_TASKS_CATALOG.map((t, idx) => ({ ...t, order: (idx + 1) * 10, active: true, description: "" }))
    };
  }

  if (sb) {
    try {
      await sb.from("system_config").upsert({
        key: SETUP_PROCESS_TEMPLATE_CONFIG_KEY,
        value: {
          phases: templateData.phases,
          tasks: templateData.tasks,
          seededAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        description: "Client onboarding setup phases and task checklist catalog",
        updated_by: "System (Migration Seed)"
      });
    } catch (_) { }
  }

  await redisClient.set(cacheKey, JSON.stringify(templateData), { EX: 86400 }).catch(() => { });
  return templateData;
}

/**
 * Saves setup process template changes to Supabase system_config (and AC sheet in legacy mode) and updates Redis cache.
 */
export async function saveSetupProcessTemplate(sheets, { phases, tasks }, userEmail = "admin@pulse") {
  const acId = DEFAULT_AC_SHEET_ID;
  const now = new Date().toISOString();

  const phaseMap = new Map((phases || DEFAULT_SETUP_PHASES).map((p, idx) => [p.id, { ...p, order: p.order || (idx + 1) }]));
  const templateData = {
    phases: normalizeSetupPhases(Array.from(phaseMap.values()).sort((a, b) => a.order - b.order)),
    tasks: (tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0))
  };

  const sb = getSupabaseAdmin();
  if (sb) {
    await sb.from("system_config").upsert({
      key: SETUP_PROCESS_TEMPLATE_CONFIG_KEY,
      value: {
        phases: templateData.phases,
        tasks: templateData.tasks,
        updatedAt: now,
        updatedBy: userEmail
      },
      description: "Client onboarding setup phases and task checklist catalog",
      updated_by: userEmail || "admin@pulse"
    });
  }

  const supaControlPlane = await isSupabaseControlPlaneActive().catch(() => false);
  if (!supaControlPlane && sheets && acId) {
    await ensureClientSetupTabs(sheets);
    const rows = (tasks || []).map((t, idx) => {
      const phase = phaseMap.get(t.phaseId) || { id: t.phaseId, title: t.phaseId, description: "", order: 1 };
      const taskOrder = t.order !== undefined && !isNaN(Number(t.order)) ? Number(t.order) : ((idx + 1) * 10);
      return [
        phase.id || "",
        phase.title || "",
        phase.description || "",
        phase.order || 1,
        t.id,
        t.title,
        taskOrder,
        t.autoCompletable ? "TRUE" : "FALSE",
        t.description || "",
        t.active !== false ? "TRUE" : "FALSE",
        now,
        userEmail
      ];
    });

    await withRetry(() =>
      sheets.spreadsheets.values.clear({
        spreadsheetId: acId,
        range: `${SETUP_PROCESS_TEMPLATE_TAB}!A2:L300`
      })
    );

    if (rows.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId: acId,
          range: `${SETUP_PROCESS_TEMPLATE_TAB}!A2:L${rows.length + 1}`,
          valueInputOption: "RAW",
          requestBody: { values: rows }
        })
      );
    }
  }

  await redisClient.set("pulse:setup:process_template", JSON.stringify(templateData), { EX: 86400 }).catch(() => { });

  // Clear client checklist caches so updated template displays immediately
  try {
    const keys = await scanRedisKeys("pulse:setup:checklist:*");
    if (keys && keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (e) {
    console.warn("Could not invalidate client checklist caches:", e.message);
  }

  // Log in PMA Activity
  await logPmaActivity(sheets, {
    client: "Global",
    category: "Setup",
    action: "edit_setup_process",
    summary: `Updated setup process template: ${(tasks || []).length} steps configured across ${(phases || []).length} phases`,
    user: userEmail
  }).catch(() => { });

  return templateData;
}

/**
 * Resets setup process template back to system defaults.
 */
export async function seedDefaultSetupProcessTemplate(sheets, userEmail = "System Initialiser") {
  const defaultTasks = DEFAULT_SETUP_TASKS_CATALOG.map((t, idx) => ({
    ...t,
    order: (idx + 1) * 10,
    active: true,
    description: ""
  }));
  return await saveSetupProcessTemplate(sheets, {
    phases: DEFAULT_SETUP_PHASES,
    tasks: defaultTasks
  }, userEmail);
}

/**
 * Returns setup overview for all clients (for the Setup screen main table).
 */
export async function getAllClientsSetupOverview(sheets, sessionUser, allOutgoingsClients = []) {
  const acId = DEFAULT_AC_SHEET_ID;
  const overviewMap = new Map();
  const sb = getSupabaseAdmin();

  const clientMetaMap = new Map();

  if (sb) {
    try {
      const [{ data: stateRows }, { data: dbClients }] = await Promise.all([
        sb.from("client_setup_state").select("client_name, normalized_key, setup_status, accounting_tool, crm_tool, overview_data"),
        sb.from("clients").select("id, client_name, normalized_key, status, client_sheet_url, master_sheet_url, recon_sheet_url, drive_folder_id, metadata"),
      ]);
      for (const c of (dbClients || [])) {
        if (c.normalized_key) clientMetaMap.set(c.normalized_key, c);
        if (c.client_name) clientMetaMap.set(c.client_name.trim().toLowerCase(), c);
      }
      for (const s of (stateRows || [])) {
        const name = String(s.client_name || "").trim();
        if (!name) continue;
        const ov = (s.overview_data && typeof s.overview_data === "object") ? s.overview_data : {};
        const cRow = clientMetaMap.get(s.normalized_key) || clientMetaMap.get(name.toLowerCase()) || {};
        overviewMap.set(name.toLowerCase(), {
          clientName: name,
          status: String(s.setup_status || ov.status || "LIVE").trim(),
          progressPercent: Number(ov.progressPercent ?? 100),
          completedTasks: Number(ov.completedTasks ?? 34),
          totalTasks: Number(ov.totalTasks ?? 34),
          startedAt: ov.startedAt || "",
          completedAt: ov.completedAt || "",
          driveFolderUrl: ov.driveFolderUrl || (cRow.drive_folder_id ? `https://drive.google.com/drive/folders/${cRow.drive_folder_id}` : ""),
          clientSheetUrl: ov.clientSheetUrl || cRow.client_sheet_url || "",
          masterSheetUrl: ov.masterSheetUrl || cRow.master_sheet_url || "",
          reconSheetUrl: ov.reconSheetUrl || cRow.recon_sheet_url || "",
          backupSheetUrl: ov.backupSheetUrl || "",
          accountingTool: s.accounting_tool || "",
          crmTool: s.crm_tool || "",
        });
      }
    } catch (sbErr) {
      console.warn("Warning reading Supabase client_setup_state:", sbErr.message);
    }
  }

  const supaControlPlane = await isSupabaseControlPlaneActive().catch(() => false);
  if (!supaControlPlane && overviewMap.size === 0 && sheets && acId) {
    await ensureClientSetupTabs(sheets);
    try {
      const [overviewRes, tasksRes] = await Promise.all([
        withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: acId,
            range: `${CLIENT_SETUP_OVERVIEW_TAB}!A2:L500`
          })
        ),
        sb
          ? withRetry(() =>
            sheets.spreadsheets.values.get({
              spreadsheetId: acId,
              range: `${CLIENT_SETUP_TASKS_TAB}!A2:H5000`
            })
          ).catch(() => null)
          : Promise.resolve(null),
      ]);

      const tasksByClientKey = new Map();
      const tasksClientNames = new Map();
      for (const r of (tasksRes?.data?.values || [])) {
        const cName = String(r[0] || "").trim();
        const taskId = String(r[2] || "").trim();
        if (!cName || !taskId) continue;
        const cKey = normalizeKey(cName);
        if (!tasksByClientKey.has(cKey)) tasksByClientKey.set(cKey, {});
        if (!tasksClientNames.has(cKey)) tasksClientNames.set(cKey, cName);
        const isComp = String(r[4] || "").toUpperCase() === "TRUE";
        tasksByClientKey.get(cKey)[taskId] = {
          phaseId: String(r[1] || "").trim(),
          isCompleted: isComp,
          status: isComp ? "completed" : "pending",
          completedAt: r[5] || "",
          completedBy: r[6] || "",
          metadata: r[7] || "",
        };
      }

      const seedRows = [];
      const seededKeys = new Set();
      for (const r of (overviewRes.data.values || [])) {
        const name = String(r[0] || "").trim();
        if (name) {
          const pctRaw = parseInt(String(r[2] ?? "").replace(/[^0-9]/g, ""), 10);
          const compRaw = parseInt(String(r[3] ?? ""), 10);
          const totalRaw = parseInt(String(r[4] ?? ""), 10);
          const entry = {
            clientName: name,
            status: String(r[1] || "LIVE").trim(),
            progressPercent: Number.isNaN(pctRaw) ? 100 : pctRaw,
            completedTasks: Number.isNaN(compRaw) ? 34 : compRaw,
            totalTasks: Number.isNaN(totalRaw) ? 34 : totalRaw,
            startedAt: r[5] || "",
            completedAt: r[6] || "",
            driveFolderUrl: r[7] || "",
            clientSheetUrl: r[8] || "",
            masterSheetUrl: r[9] || "",
            reconSheetUrl: r[10] || "",
            backupSheetUrl: r[11] || ""
          };
          overviewMap.set(name.toLowerCase(), entry);

          const norm = normalizeKey(name);
          seededKeys.add(norm);
          const cRow = clientMetaMap.get(norm) || clientMetaMap.get(name.toLowerCase()) || {};
          seedRows.push({
            client_id: cRow.id || null,
            client_name: name,
            normalized_key: norm,
            setup_status: entry.status,
            accounting_tool: cRow.metadata?.accountingTool || "None",
            crm_tool: cRow.metadata?.crmTool || "None",
            crm_drives: cRow.metadata?.crmDrives || "NA",
            tasks_map: tasksByClientKey.get(norm) || {},
            overview_data: {
              status: entry.status,
              progressPercent: entry.progressPercent,
              completedTasks: entry.completedTasks,
              totalTasks: entry.totalTasks,
              startedAt: entry.startedAt,
              completedAt: entry.completedAt,
              driveFolderUrl: entry.driveFolderUrl,
              clientSheetUrl: entry.clientSheetUrl,
              masterSheetUrl: entry.masterSheetUrl,
              reconSheetUrl: entry.reconSheetUrl,
              backupSheetUrl: entry.backupSheetUrl,
            },
          });
        }
      }

      for (const [cKey, tMap] of tasksByClientKey.entries()) {
        if (seededKeys.has(cKey)) continue;
        const origName = tasksClientNames.get(cKey) || cKey;
        const cRow = clientMetaMap.get(cKey) || clientMetaMap.get(origName.toLowerCase()) || {};
        const name = cRow.client_name || origName;
        seedRows.push({
          client_id: cRow.id || null,
          client_name: name,
          normalized_key: cKey,
          setup_status: "LIVE",
          accounting_tool: cRow.metadata?.accountingTool || "None",
          crm_tool: cRow.metadata?.crmTool || "None",
          crm_drives: cRow.metadata?.crmDrives || "NA",
          tasks_map: tMap,
          overview_data: {
            status: "LIVE",
            progressPercent: 100,
            completedTasks: 34,
            totalTasks: 34,
            driveFolderUrl: cRow.drive_folder_id ? `https://drive.google.com/drive/folders/${cRow.drive_folder_id}` : "",
            clientSheetUrl: cRow.client_sheet_url || "",
            masterSheetUrl: cRow.master_sheet_url || "",
            reconSheetUrl: cRow.recon_sheet_url || "",
            backupSheetUrl: "",
          },
        });
      }

      if (sb && seedRows.length > 0) {
        try {
          const { error: upsertErr } = await sb.from("client_setup_state").upsert(seedRows, { onConflict: "normalized_key" });
          if (upsertErr) {
            console.warn("Warning seeding client_setup_state:", upsertErr.message);
          }
        } catch (seedErr) {
          console.warn("Warning seeding client_setup_state from ClientSetupOverview:", seedErr.message);
        }
      }
    } catch (err) {
      console.warn("Warning reading ClientSetupOverview:", err.message);
    }
  }

  const filteredClients = [];
  for (const c of allOutgoingsClients) {
    if (!c.clientName) continue;
    const cMeta = clientMetaMap.get(normalizeKey(c.clientName)) || clientMetaMap.get(c.clientName.trim().toLowerCase());
    if (cMeta) {
      const effStatus = String(cMeta?.metadata?.statusOverride || cMeta?.status || "live").trim().toLowerCase();
      if (["inactive", "archived", "suspended"].includes(effStatus)) continue;
    }
    if (sessionUser && !isUserAuthorizedForClient(sessionUser, c.clientName)) {
      continue;
    }
    filteredClients.push(c);
  }

  let cachedRawValues = [];
  if (filteredClients.length > 0 && redisClient?.isOpen) {
    try {
      const setupKeys = filteredClients.map((c) => getSetupRedisKey(c.clientName));
      cachedRawValues = (await redisClient.mGet(setupKeys)) || [];
    } catch { }
  }

  const results = [];
  for (let i = 0; i < filteredClients.length; i++) {
    const c = filteredClients[i];
    let cached = null;
    try {
      const raw = cachedRawValues[i];
      if (raw) cached = JSON.parse(raw);
    } catch { }

    const cMeta = clientMetaMap.get(normalizeKey(c.clientName)) || clientMetaMap.get(c.clientName.trim().toLowerCase());
    const overview = overviewMap.get(c.clientName.toLowerCase());
    const setupMode =
      cached?.setupMode === true ||
      cMeta?.metadata?.setupMode === true ||
      String(overview?.status || "").toUpperCase() === "IN_PROGRESS";
    const pulseLive = !setupMode || cached?.pulseLive === true || cMeta?.metadata?.pulseLive === true;
    const accountingTool = cached?.accountingTool || overview?.accountingTool || "None";
    const crmTool = cached?.crmTool || overview?.crmTool || "None";

    const status = setupMode ? "IN_PROGRESS" : (overview?.status || "LIVE");
    const progressPercent = overview ? overview.progressPercent : (setupMode ? 15 : 100);
    const completedTasks = overview ? overview.completedTasks : (setupMode ? 5 : 34);

    results.push({
      clientName: c.clientName,
      masterSheetId: c.masterSheetId || "",
      clientSheetId: c.clientSheetId || "",
      clientUrl: c.clientUrl || overview?.clientSheetUrl || "",
      masterUrl: c.masterUrl || overview?.masterSheetUrl || "",
      reconUrl: c.reconUrl || overview?.reconSheetUrl || "",
      driveFolderUrl: overview?.driveFolderUrl || "",
      setupMode,
      pulseLive,
      status,
      progressPercent,
      completedTasks,
      totalTasks: overview?.totalTasks || 34,
      accountingTool,
      crmTool,
      updatedAt: cached?.updatedAt || overview?.startedAt || ""
    });
  }

  // Sort: Clients in Setup Mode / In Progress first, then alphabetically
  results.sort((a, b) => {
    if (a.setupMode && !b.setupMode) return -1;
    if (!a.setupMode && b.setupMode) return 1;
    return a.clientName.localeCompare(b.clientName);
  });

  return results;
}

function formatToolDisplayName(tool) {
  const clean = String(tool || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const labels = {
    xero: "Xero",
    quickbooks: "QuickBooks",
    clickup: "ClickUp",
    close: "Close",
    capsule: "Capsule",
    hubspot: "HubSpot",
    monday: "Monday",
    pipedrive: "Pipedrive",
    googlesheet: "Google Sheet",
    excel: "Excel",
  };
  return labels[clean] || String(tool || "").trim();
}

/**
 * Returns full checklist state for a specific client (the 5 phases, tasks, completion status, metadata).
 */
export async function getClientChecklistState(sheets, clientName, masterSheetId) {
  if (!clientName) throw new Error("Missing clientName");

  const acId = DEFAULT_AC_SHEET_ID;
  const checklistRedisKey = getChecklistRedisKey(clientName);

  let taskStatusMap = new Map();
  let foundInRedisOrSupabase = false;

  // Try Redis first
  try {
    const raw = await redisClient.get(checklistRedisKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach(t => taskStatusMap.set(t.taskId, t));
        foundInRedisOrSupabase = true;
      }
    }
  } catch (err) {
    console.warn("Redis checklist cache read error:", err.message);
  }

  // If not cached, try Supabase client_setup_state
  const supaControlPlane = await isSupabaseControlPlaneActive().catch(() => false);
  if (!foundInRedisOrSupabase && isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      const norm = normalizeKey(clientName);
      const { data: row, error } = await sb
        .from("client_setup_state")
        .select("tasks_map")
        .eq("normalized_key", norm)
        .maybeSingle();
      if (!error && row) {
        foundInRedisOrSupabase = true;
        if (row.tasks_map && typeof row.tasks_map === "object") {
          for (const [tId, tVal] of Object.entries(row.tasks_map)) {
            if (tId && tVal && typeof tVal === "object") {
              const isComp = tVal.isCompleted !== undefined
                ? Boolean(tVal.isCompleted)
                : String(tVal.status || "").toUpperCase() === "TRUE" || String(tVal.status || "").toLowerCase() === "completed";
              taskStatusMap.set(tId, {
                taskId: tId,
                phaseId: tVal.phaseId || "",
                isCompleted: isComp,
                completedAt: tVal.completedAt || "",
                completedBy: tVal.completedBy || "",
                metadata: tVal.metadata || tVal.notes || "",
              });
            }
          }
        }
      }
    } catch (_) { }
  }

  // If still not found in Redis or Supabase (and legacy AC control plane is active), read ClientSetupTasks tab on AC once and backfill Supabase
  if (!supaControlPlane && !foundInRedisOrSupabase && sheets && acId) {
    await ensureClientSetupTabs(sheets);
    try {
      const res = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: acId,
          range: `${CLIENT_SETUP_TASKS_TAB}!A2:H5000`
        })
      );
      const rows = res.data.values || [];
      const clientRows = rows.filter(r => String(r[0] || "").trim().toLowerCase() === clientName.toLowerCase());
      const seedTasksMap = {};

      for (const r of clientRows) {
        const taskId = String(r[2] || "").trim();
        if (taskId) {
          const isComp = String(r[4] || "").toUpperCase() === "TRUE";
          taskStatusMap.set(taskId, {
            taskId,
            phaseId: r[1] || "",
            isCompleted: isComp,
            completedAt: r[5] || "",
            completedBy: r[6] || "",
            metadata: r[7] || ""
          });
          seedTasksMap[taskId] = {
            phaseId: String(r[1] || "").trim(),
            isCompleted: isComp,
            status: isComp ? "completed" : "pending",
            completedAt: r[5] || "",
            completedBy: r[6] || "",
            metadata: r[7] || ""
          };
        }
      }

      if (isSupabaseConfigured() && Object.keys(seedTasksMap).length > 0) {
        try {
          const sb = getSupabaseAdmin();
          const norm = normalizeKey(clientName);
          const { data: existingState, error: existingStateErr } = await sb
            .from("client_setup_state")
            .select("tasks_map")
            .eq("normalized_key", norm)
            .maybeSingle();
          if (existingStateErr) {
            throw new Error(`Failed to read client_setup_state for ${norm}: ${existingStateErr.message}`);
          }
          const mergedTasks = {
            ...seedTasksMap,
            ...(existingState?.tasks_map && typeof existingState.tasks_map === "object" ? existingState.tasks_map : {}),
          };
          await sb.from("client_setup_state").upsert({
            client_name: clientName,
            normalized_key: norm,
            tasks_map: mergedTasks,
          }, { onConflict: "normalized_key" });
        } catch (seedErr) {
          console.warn("Warning seeding client_setup_state tasks_map:", seedErr.message);
        }
      }
    } catch (err) {
      console.warn("Error reading ClientSetupTasks from AC:", err.message);
    }
  }

  // Check live setup config & tool status from Vault for auto-completable tasks
  const config = await getClientSetupConfig({ clientName, masterSheetId }).catch(() => null);

  // Auto-complete tool connections if connected in Vault
  if (config?.accountingStatus?.connected) {
    const existing = taskStatusMap.get("p2_connect_accounting") || { taskId: "p2_connect_accounting", phaseId: "phase_2" };
    existing.isCompleted = true;
    existing.metadata = `${formatToolDisplayName(config.accountingTool)} connected`;
    taskStatusMap.set("p2_connect_accounting", existing);
  }
  if (config?.crmStatus?.connected) {
    const existing = taskStatusMap.get("p2_connect_crm") || { taskId: "p2_connect_crm", phaseId: "phase_2" };
    existing.isCompleted = true;
    existing.metadata = `${formatToolDisplayName(config.crmTool)} connected`;
    taskStatusMap.set("p2_connect_crm", existing);
  }

  // Resolve client & master provisioning mode from Supabase clients registry
  const sheetCtx = await resolveSupabaseSheetContext({ clientName }).catch(() => null);
  let clientRowMeta = null;
  if (isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      const { data } = await sb
        .from("clients")
        .select("client_mode, master_mode, client_sheet_id, master_sheet_id, recon_sheet_id, client_script_id, master_script_id, recon_script_id, master_deployment_url")
        .eq("normalized_key", normalizeKey(clientName))
        .maybeSingle();
      clientRowMeta = data || null;
    } catch (_) { }
  }

  const clientMode = (clientRowMeta?.client_mode || sheetCtx?.clientMode) === "supabase" ? "supabase" : "sheet";
  const masterMode = (clientRowMeta?.master_mode || sheetCtx?.masterMode) === "supabase" ? "supabase" : "sheet";
  const resolvedClientSheetId = clientRowMeta?.client_sheet_id || sheetCtx?.clientSheetId || config?.clientSheetId || "";
  const resolvedMasterSheetId = masterSheetId || clientRowMeta?.master_sheet_id || sheetCtx?.masterSheetId || config?.masterSheetId || "";
  const resolvedReconSheetId = clientRowMeta?.recon_sheet_id || sheetCtx?.reconSheetId || "";

  const hasRealClientSheet = clientMode === "sheet" && Boolean(resolvedClientSheetId && !isVirtualSupabaseSheetId(resolvedClientSheetId));
  const hasRealMasterSheet = masterMode === "sheet" && Boolean(resolvedMasterSheetId && !isVirtualSupabaseSheetId(resolvedMasterSheetId));
  const hasRealReconSheet = masterMode === "sheet" && Boolean(resolvedReconSheetId && !isVirtualSupabaseSheetId(resolvedReconSheetId));
  const hasAnyGoogleSheet = clientMode === "sheet" || masterMode === "sheet";

  const hasCrmSelected = Boolean(
    config?.crmTool &&
    !["none", "na", "n/a", ""].includes(String(config.crmTool).trim().toLowerCase())
  );

  // Fetch Master Sheet KeyInfo parameters before filtering applicability (e.g. Transfers hides initial tax payments)
  let keyInfoSettings = null;
  if (resolvedMasterSheetId) {
    keyInfoSettings = await getMasterKeyInfoSettings(sheets, resolvedMasterSheetId).catch(() => null);
  }
  const isTransfersTaxMethod =
    String(keyInfoSettings?.taxPaymentMethod || "Standard").trim().toLowerCase() === "transfers";

  const isTaskApplicableForMode = (taskId) => {
    if (["p2_connect_crm", "p4_crm_list_tab", "p4_review_crm"].includes(taskId)) {
      return hasCrmSelected;
    }
    if (taskId === "p3_initial_tax_payments") {
      return !isTransfersTaxMethod;
    }
    if (["p1_importrange_auth", "p1_agent_secret", "p1_gas_deployment"].includes(taskId)) {
      return masterMode === "sheet";
    }
    if (["p1_drive_folder", "p1_duplicate_templates", "p1_bookmarks", "p1_rename_gas", "p1_script_ids"].includes(taskId)) {
      return hasAnyGoogleSheet;
    }
    return true;
  };

  // Build full phase structure from dynamic setup process template
  const template = await getSetupProcessTemplate(sheets);
  const phasesCatalog = template?.phases || DEFAULT_SETUP_PHASES;
  const allActiveTasksCatalog = (template?.tasks || DEFAULT_SETUP_TASKS_CATALOG).filter(t => t.active !== false);
  const tasksCatalog = allActiveTasksCatalog.filter(t => isTaskApplicableForMode(t.id));

  const totalTasks = tasksCatalog.length;
  let completedCount = 0;

  const phases = phasesCatalog
    .map(phase => {
      const tasksInPhase = tasksCatalog.filter(t => t.phaseId === phase.id);
      let phaseCompleted = 0;

      const tasks = tasksInPhase.map(catalogTask => {
        const recorded = taskStatusMap.get(catalogTask.id);
        const isCompleted = recorded ? Boolean(recorded.isCompleted) : false;
        if (isCompleted) {
          completedCount++;
          phaseCompleted++;
        }

        let taskTitle = catalogTask.title;
        if (catalogTask.id === "p1_bookmarks") {
          if (clientMode === "sheet" && masterMode !== "sheet") {
            taskTitle = "Create bookmark for new client sheet";
          } else if (clientMode !== "sheet" && masterMode === "sheet") {
            taskTitle = "Create bookmarks for new master and recon sheets";
          }
        }
        let waitingOnClient = false;
        if (!isCompleted && config?.requestConnections) {
          if (catalogTask.id === "p2_connect_accounting" && isOAuthTool(config.accountingTool)) {
            waitingOnClient = true;
          } else if (catalogTask.id === "p2_connect_crm" && isOAuthTool(config.crmTool)) {
            waitingOnClient = true;
          }
        }

        return {
          id: catalogTask.id,
          phaseId: catalogTask.phaseId,
          title: taskTitle,
          autoCompletable: Boolean(catalogTask.autoCompletable),
          waitingOnClient,
          description: catalogTask.description || "",
          order: catalogTask.order,
          isCompleted,
          completedAt: recorded?.completedAt || "",
          completedBy: recorded?.completedBy || "",
          metadata: recorded?.metadata || ""
        };
      });

      return {
        ...phase,
        totalCount: tasks.length,
        completedCount: phaseCompleted,
        isPhaseComplete: tasks.length > 0 && phaseCompleted === tasks.length,
        tasks
      };
    })
    .filter(phase => phase.tasks.length > 0);

  const progressPercent = totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 100;

  // Cache full catalog status back to Redis so mode toggles never lose task history
  const flatTaskList = allActiveTasksCatalog.map(catalogTask => {
    const recorded = taskStatusMap.get(catalogTask.id);
    return {
      taskId: catalogTask.id,
      id: catalogTask.id,
      phaseId: catalogTask.phaseId,
      title: catalogTask.title,
      autoCompletable: Boolean(catalogTask.autoCompletable),
      description: catalogTask.description || "",
      order: catalogTask.order,
      isCompleted: recorded ? Boolean(recorded.isCompleted) : false,
      completedAt: recorded?.completedAt || "",
      completedBy: recorded?.completedBy || "",
      metadata: recorded?.metadata || ""
    };
  });
  await redisClient.set(checklistRedisKey, JSON.stringify(flatTaskList), { EX: 86400 }).catch(() => { });

  return {
    clientName,
    setupMode: Boolean(config?.setupMode),
    pulseLive: Boolean(config?.pulseLive) || !config?.setupMode,
    clientMode,
    masterMode,
    hasRealClientSheet,
    hasRealMasterSheet,
    hasRealReconSheet,
    clientSheetId: resolvedClientSheetId,
    masterSheetId: resolvedMasterSheetId,
    scriptIds: {
      clientScriptId: clientRowMeta?.client_script_id || "",
      masterScriptId: clientRowMeta?.master_script_id || "",
      reconScriptId: clientRowMeta?.recon_script_id || "",
    },
    deploymentUrl: clientRowMeta?.master_deployment_url || "",
    totalTasks,
    completedCount,
    progressPercent,
    phases,
    keyInfoSettings,
    config
  };
}

/**
 * Updates a single checklist task status for a client.
 */
export async function updateClientChecklistTask(sheets, { clientName, taskId, isCompleted, metadata, userEmail }) {
  if (!clientName || !taskId) throw new Error("Missing clientName or taskId");

  const acId = DEFAULT_AC_SHEET_ID;
  const now = new Date().toISOString();
  const template = await getSetupProcessTemplate(sheets).catch(() => null);
  const catalogItem = (template?.tasks || DEFAULT_SETUP_TASKS_CATALOG).find(t => t.id === taskId) || DEFAULT_SETUP_TASKS_CATALOG.find(t => t.id === taskId);
  const phaseId = catalogItem?.phaseId || "";
  const taskTitle = catalogItem?.title || taskId;

  // 1. Primary write to Supabase client_setup_state
  if (isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      const norm = normalizeKey(clientName);
      const { data: existingState } = await sb
        .from("client_setup_state")
        .select("tasks_map")
        .eq("normalized_key", norm)
        .maybeSingle();
      const tasksMap = (existingState?.tasks_map && typeof existingState.tasks_map === "object")
        ? { ...existingState.tasks_map }
        : {};
      tasksMap[taskId] = {
        phaseId: phaseId || "",
        isCompleted: Boolean(isCompleted),
        status: isCompleted ? "completed" : "pending",
        completedAt: isCompleted ? now : "",
        completedBy: String(userEmail || "Admin"),
        metadata: String(metadata || ""),
      };
      await sb.from("client_setup_state").upsert({
        client_name: clientName,
        normalized_key: norm,
        tasks_map: tasksMap,
      }, { onConflict: "normalized_key" });
    } catch (sbErr) {
      console.warn("⚠️ Supabase updateClientChecklistTask warning:", sbErr.message);
    }
  }

  // 1b. Legacy Automation Commander fallback mirror (only when AC control plane is active)
  const supaControlPlane = await isSupabaseControlPlaneActive().catch(() => false);
  if (!supaControlPlane && sheets && acId) {
    await ensureClientSetupTabs(sheets);
    const res = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: `${CLIENT_SETUP_TASKS_TAB}!A2:H5000`
      })
    );
    const rows = res.data.values || [];
    const existingIdx = rows.findIndex(
      r => String(r[0] || "").trim().toLowerCase() === clientName.toLowerCase() && String(r[2] || "").trim() === taskId
    );

    const newRowValues = [
      sanitizeFormulaInput(String(clientName || "")),
      sanitizeFormulaInput(String(phaseId || "")),
      sanitizeFormulaInput(String(taskId || "")),
      sanitizeFormulaInput(String(taskTitle || "")),
      isCompleted ? "TRUE" : "FALSE",
      isCompleted ? now : "",
      sanitizeFormulaInput(String(userEmail || "Admin")),
      sanitizeFormulaInput(String(metadata || ""))
    ];

    if (existingIdx === -1) {
      await withRetry(() =>
        sheets.spreadsheets.values.append({
          spreadsheetId: acId,
          range: `${CLIENT_SETUP_TASKS_TAB}!A:H`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [newRowValues] }
        })
      );
    } else {
      const rowNum = existingIdx + 2;
      await withRetry(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId: acId,
          range: `${CLIENT_SETUP_TASKS_TAB}!A${rowNum}:H${rowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [newRowValues] }
        })
      );
    }
  }

  // 2. Invalidate checklist cache
  await redisClient.del(getChecklistRedisKey(clientName)).catch(() => { });

  // 3. Log activity
  logPmaActivity({
    action: isCompleted ? "setup_task_completed" : "setup_task_uncompleted",
    details: `${isCompleted ? "Completed" : "Unchecked"} task "${taskTitle}" for ${clientName}`,
    clientName,
    userEmail: userEmail || "Admin"
  }).catch(() => { });

  // Return fresh checklist state and sync overview
  const freshChecklist = await getClientChecklistState(sheets, clientName);
  try {
    await updateClientSetupOverviewRow(sheets, {
      clientName,
      status: freshChecklist.setupMode ? "IN_PROGRESS" : "LIVE",
      progressPercent: freshChecklist.progressPercent,
      completedTasks: freshChecklist.completedCount
    });
  } catch (ovErr) {
    console.warn("Failed to update ClientSetupOverview from task toggle:", ovErr.message);
  }
  return freshChecklist;
}

/**
 * Updates status, progress percent, completed tasks, or completedAt in Supabase client_setup_state (and AC in legacy mode).
 */
export async function updateClientSetupOverviewRow(sheets, { clientName, status, progressPercent, completedTasks, completedAt }) {
  if (!clientName) return;
  if (isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      const norm = normalizeKey(clientName);
      const { data: existingState } = await sb
        .from("client_setup_state")
        .select("overview_data")
        .eq("normalized_key", norm)
        .maybeSingle();
      const overviewData = (existingState?.overview_data && typeof existingState.overview_data === "object")
        ? { ...existingState.overview_data }
        : {};
      if (progressPercent !== undefined) overviewData.progressPercent = progressPercent;
      if (completedTasks !== undefined) overviewData.completedTasks = completedTasks;
      if (completedAt !== undefined) overviewData.completedAt = completedAt;
      const upsertPayload = {
        client_name: clientName,
        normalized_key: norm,
        overview_data: overviewData,
      };
      if (status !== undefined) {
        upsertPayload.setup_status = status;
        const { data: existingClient } = await sb
          .from("clients")
          .select("metadata")
          .eq("normalized_key", norm)
          .maybeSingle();
        if (existingClient) {
          const nextSetupMode = status === "IN_PROGRESS";
          await sb
            .from("clients")
            .update({
              metadata: {
                ...(existingClient.metadata || {}),
                setupMode: nextSetupMode,
                ...(nextSetupMode ? {} : { pulseLive: true }),
              },
            })
            .eq("normalized_key", norm);
        }
      }
      await sb.from("client_setup_state").upsert(upsertPayload, { onConflict: "normalized_key" });
    } catch (_) { }
  }

  const supaControlPlane = await isSupabaseControlPlaneActive().catch(() => false);
  if (supaControlPlane || !sheets) return;

  await ensureClientSetupTabs(sheets);
  const acId = DEFAULT_AC_SHEET_ID;
  try {
    const res = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: `${CLIENT_SETUP_OVERVIEW_TAB}!A2:G500`
      })
    );
    const rows = res.data.values || [];
    const idx = rows.findIndex(r => String(r[0] || "").trim().toLowerCase() === clientName.toLowerCase());
    if (idx !== -1) {
      const rowNum = idx + 2;
      const updateData = [];
      if (status !== undefined) updateData.push({ range: `${CLIENT_SETUP_OVERVIEW_TAB}!B${rowNum}`, values: [[status]] });
      if (progressPercent !== undefined) updateData.push({ range: `${CLIENT_SETUP_OVERVIEW_TAB}!C${rowNum}`, values: [[`${progressPercent}%`]] });
      if (completedTasks !== undefined) updateData.push({ range: `${CLIENT_SETUP_OVERVIEW_TAB}!D${rowNum}`, values: [[String(completedTasks)]] });
      if (completedAt !== undefined) updateData.push({ range: `${CLIENT_SETUP_OVERVIEW_TAB}!G${rowNum}`, values: [[completedAt]] });

      if (updateData.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: acId,
            requestBody: {
              valueInputOption: "USER_ENTERED",
              data: updateData
            }
          })
        );
      }
    }
  } catch (err) {
    console.warn("updateClientSetupOverviewRow error:", err.message);
  }
}

/**
 * Reads core KeyInfo financial parameters directly from Master Sheet.
 */
export async function getMasterKeyInfoSettings(sheets, masterSheetId) {
  if (!masterSheetId) return null;
  const res = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: masterSheetId,
      ranges: ["KeyInfo!A1:X29", "DataChgAlert!Y2:Y4", "InvAppList!F1", "InvAppList!N4:N20"]
    })
  );
  const valueRanges = res.data.valueRanges || [];
  const rows = valueRanges[0]?.values || [];
  const dcaFreqRows = valueRanges[1]?.values || [];
  const invFmtRaw = valueRanges[2]?.values?.[0]?.[0];
  const rawInvRows = valueRanges[3]?.values || [];

  const getCell = (r, c) => (rows[r - 1] && rows[r - 1][c - 1] !== undefined ? String(rows[r - 1][c - 1]).trim() : "");
  const getFreq = (idx) => (dcaFreqRows[idx] && dcaFreqRows[idx][0] !== undefined ? String(dcaFreqRows[idx][0]).trim() : "");
  const rawRechDel = getCell(21, 4);
  const sampleInvoiceNumbers = Array.from(new Set(
    rawInvRows.map((r) => String(r[0] || "").trim()).filter((v) => v && !v.startsWith("#"))
  )).slice(0, 5);

  return {
    startDate: getCell(2, 2),        // B2: Tracker start date
    vatQuarters: getCell(6, 2),      // B6: VAT quarters
    vatMonths: getCell(7, 2),        // B7: VAT payment months
    vatScheme: getCell(8, 2),        // B8: VAT payment scheme
    vatRate: getCell(9, 2),          // B9: VAT rate
    taxPaymentMethod: getCell(10, 2) || "Standard", // B10: Tax payment method (Standard / Transfers)
    payeCycle: getCell(12, 2),       // B12: PAYE cycle
    payeQuarterMonths: getCell(13, 2), // B13: PAYE quarterly months
    revenueFocus: getCell(15, 2),    // B15: Revenue or income focus
    invoiceMethod: getCell(8, 6) === "Whole" ? "Whole" : "Lines", // F8: Invoice method (Whole / Lines)
    directCostsMode: getCell(15, 2) === "Income" ? "Pass-through" : (getCell(8, 4) === "Pass-through" ? "Pass-through" : "Contractors"), // D8: Job direct costs treatment
    profitShare: getCell(11, 6),     // F11: Profit share %
    contractorMethod: getCell(20, 2),// B20: Cashflow contractors method
    rechargedExpensesDeliveryPct: rawRechDel === "0" || rawRechDel === "0%" || rawRechDel === "0.0%" ? "0%" : "100%", // D21: Recharged expenses delivery %
    invoiceNumberFormatting: String(invFmtRaw || "StripPre").trim() || "StripPre", // InvAppList!F1
    sampleInvoiceNumbers,
    invoicesFrequency: getFreq(0),   // DataChgAlert!Y2: Invoices automation cadence
    crmFrequency: getFreq(1),        // DataChgAlert!Y3: CRM automation cadence
    expensesFrequency: getFreq(2),   // DataChgAlert!Y4: Expenses automation cadence
    masterDeploymentUrl: getCell(29, 24) // X29: Master deployment URL
  };
}

/**
 * Saves core KeyInfo financial parameters (and optional automation cadences) to Master Sheet and marks task complete.
 */
export async function saveMasterKeyInfoSettings(sheets, { masterSheetId, clientName, settings, userEmail }) {
  if (!masterSheetId) throw new Error("Missing masterSheetId");

  const updates = [];
  if (settings.startDate !== undefined) updates.push({ range: "KeyInfo!B2", values: [[sanitizeFormulaInput(String(settings.startDate))]] });
  if (settings.vatQuarters !== undefined) updates.push({ range: "KeyInfo!B6", values: [[sanitizeFormulaInput(String(settings.vatQuarters))]] });
  if (settings.vatMonths !== undefined) updates.push({ range: "KeyInfo!B7", values: [[sanitizeFormulaInput(String(settings.vatMonths))]] });
  if (settings.vatScheme !== undefined) updates.push({ range: "KeyInfo!B8", values: [[sanitizeFormulaInput(String(settings.vatScheme))]] });
  if (settings.vatRate !== undefined) updates.push({ range: "KeyInfo!B9", values: [[sanitizeFormulaInput(String(settings.vatRate))]] });
  if (settings.payeCycle !== undefined) updates.push({ range: "KeyInfo!B12", values: [[sanitizeFormulaInput(String(settings.payeCycle))]] });
  if (settings.revenueFocus !== undefined) updates.push({ range: "KeyInfo!B15", values: [[sanitizeFormulaInput(String(settings.revenueFocus))]] });
  if (settings.invoiceMethod !== undefined) updates.push({ range: "KeyInfo!F8", values: [[sanitizeFormulaInput(String(settings.invoiceMethod === "Whole" ? "Whole" : "Lines"))]] });
  if (settings.directCostsMode !== undefined || settings.revenueFocus !== undefined) {
    const rf = settings.revenueFocus || "Revenue";
    const dcm = rf === "Income" ? "Pass-through" : (settings.directCostsMode === "Pass-through" ? "Pass-through" : "Contractors");
    updates.push({ range: "KeyInfo!D8", values: [[sanitizeFormulaInput(String(dcm))]] });
  }
  if (settings.profitShare !== undefined) updates.push({ range: "KeyInfo!F11", values: [[sanitizeFormulaInput(String(settings.profitShare))]] });
  if (settings.contractorMethod !== undefined) updates.push({ range: "KeyInfo!B20", values: [[sanitizeFormulaInput(String(settings.contractorMethod))]] });
  let rechargedRow21Payload = null;
  if (settings.rechargedExpensesDeliveryPct !== undefined) {
    const rawPct = String(settings.rechargedExpensesDeliveryPct ?? "").trim();
    const numVal = rawPct === "0" || rawPct === "0%" || rawPct === "0.0%" ? 0 : 1;
    const c21Note =
      "Recharged expenses delivery % (100% = recharged expenses captured as CoS, 0% = captured within overhead categories)";
    rechargedRow21Payload = { range: "KeyInfo!C21:D21", values: [[c21Note, numVal]] };
    updates.push(rechargedRow21Payload);
  }

  const dcaUpdates = [];
  if (settings.invoicesFrequency !== undefined) {
    dcaUpdates.push({ range: "DataChgAlert!Y2", values: [[sanitizeFormulaInput(String(settings.invoicesFrequency || "").trim())]] });
  }
  if (settings.crmFrequency !== undefined) {
    dcaUpdates.push({ range: "DataChgAlert!Y3", values: [[sanitizeFormulaInput(String(settings.crmFrequency || "").trim())]] });
  }
  if (settings.expensesFrequency !== undefined) {
    dcaUpdates.push({ range: "DataChgAlert!Y4", values: [[sanitizeFormulaInput(String(settings.expensesFrequency || "").trim())]] });
  }

  const invAppUpdates = [];
  if (settings.invoiceNumberFormatting !== undefined) {
    invAppUpdates.push({
      range: "InvAppList!F1",
      values: [[sanitizeFormulaInput(String(settings.invoiceNumberFormatting || "StripPre").trim() || "StripPre")]],
    });
  }

  const allMasterUpdates = [...updates, ...dcaUpdates, ...invAppUpdates];
  if (allMasterUpdates.length > 0) {
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: masterSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: allMasterUpdates
        }
      })
    );

    // If Master is Google Sheet and Client is Supabase, mirror KeyInfo settings (never DataChgAlert/InvAppList) to virtual Client Sheet
    if (updates.length > 0) {
      try {
        const ctx = await resolveSupabaseSheetContext({ spreadsheetId: masterSheetId, clientName }).catch(() => null);
        if (ctx && ctx.masterMode === "sheet" && ctx.clientMode === "supabase" && ctx.clientSheetId) {
          await withRetry(() =>
            sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: ctx.clientSheetId,
              requestBody: { valueInputOption: "USER_ENTERED", data: updates },
            })
          );
        }
      } catch (_) { }
    }
  }

  if (dcaUpdates.length > 0 && clientName) {
    await mirrorAutomationFrequenciesToSyncSchedules(clientName, {
      invoices: settings.invoicesFrequency,
      crm: settings.crmFrequency,
      expenses: settings.expensesFrequency,
    });
  }
  if ((dcaUpdates.length > 0 || invAppUpdates.length > 0) && clientName && redisClient?.isOpen) {
    await redisClient.del(`pulse:client_settings:${normalizeKey(clientName)}`).catch(() => { });
  }

  if (rechargedRow21Payload) {
    try {
      const ctx = await resolveSupabaseSheetContext({ spreadsheetId: masterSheetId, masterSheetId, clientName }).catch(() => null);
      let clientSheetId = ctx?.clientSheetId || "";
      if (!clientSheetId && masterSheetId) {
        const { resolveClientSheetIdFromMaster } = await import("./masterEngineService.js");
        clientSheetId = await resolveClientSheetIdFromMaster(sheets, masterSheetId, clientName).catch(() => "");
      }
      if (clientSheetId && !(ctx?.masterMode === "sheet" && ctx?.clientMode === "supabase")) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: clientSheetId,
            requestBody: { valueInputOption: "USER_ENTERED", data: [rechargedRow21Payload] },
          })
        );
      }
    } catch (_) { }
  }

  // Auto-mark task p2_keyinfo_settings as completed
  if (clientName) {
    if (isSupabaseConfigured() && (settings.directCostsMode !== undefined || settings.revenueFocus !== undefined)) {
      try {
        const sb = getSupabaseAdmin();
        const normKey = normalizeKey(clientName);
        const { data: curClient, error: curClientErr } = await sb
          .from("clients")
          .select("metadata")
          .eq("normalized_key", normKey)
          .maybeSingle();
        if (curClientErr) {
          throw new Error(`Failed to load client metadata for ${normKey}: ${curClientErr.message}`);
        }
        const existingMeta = curClient?.metadata && typeof curClient.metadata === "object" ? curClient.metadata : {};
        const rf = settings.revenueFocus || existingMeta.revenueFocus || "Revenue";
        const dcm = rf === "Income" ? "Pass-through" : (settings.directCostsMode === "Pass-through" ? "Pass-through" : "Contractors");
        await sb
          .from("clients")
          .update({ metadata: { ...existingMeta, revenueFocus: rf, directCostsMode: dcm } })
          .eq("normalized_key", normKey);
        await sb
          .from("tenant_key_info")
          .update({ revenue_or_income_mode: rf, direct_costs_mode: dcm, updated_at: new Date().toISOString() })
          .eq("normalized_key", normKey);
      } catch (_) { }
    }
    await updateClientChecklistTask(sheets, {
      clientName,
      taskId: "p2_keyinfo_settings",
      isCompleted: true,
      metadata: "Configured via PMA Settings Form",
      userEmail
    });
    if (redisClient?.isOpen && (settings.directCostsMode !== undefined || settings.revenueFocus !== undefined)) {
      try {
        const setupKey = getSetupRedisKey(clientName);
        let existingSetup = {};
        const rawSetup = await redisClient.get(setupKey);
        if (rawSetup) existingSetup = JSON.parse(rawSetup);
        const rf = settings.revenueFocus || existingSetup.revenueFocus || "Revenue";
        const dcm = rf === "Income" ? "Pass-through" : (settings.directCostsMode === "Pass-through" ? "Pass-through" : "Contractors");
        await redisClient.set(setupKey, JSON.stringify({
          ...existingSetup,
          clientName,
          masterSheetId,
          revenueFocus: rf,
          directCostsMode: dcm,
          sheetSyncedAt: new Date().toISOString()
        }));
        await invalidateAllClientsRedisKeys();
        clearAllClientsMemoryCache();
        clearSsrClientsMemoryCache();
      } catch { }
    }
  }

  logPmaActivity({
    action: "master_keyinfo_settings_updated",
    details: `Updated Master Sheet KeyInfo financial parameters for ${clientName}`,
    clientName,
    userEmail: userEmail || "Admin"
  }).catch(() => { });

  return await getMasterKeyInfoSettings(sheets, masterSheetId);
}

const CLIENT_PROVISIONING_TEMPLATES_KEY = "client_provisioning_templates";

/**
 * Loads or seeds the client/master/recon template URLs and Apps Script IDs
 * from Supabase `system_config` (`client_provisioning_templates`), seeding on first read
 * from Row 3 of the legacy Clients Version Tracker sheet (`Clients!A3:T3`).
 */
export async function getProvisioningTemplates(sheets) {
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data: cfgRow } = await sb
        .from("system_config")
        .select("value")
        .eq("key", CLIENT_PROVISIONING_TEMPLATES_KEY)
        .maybeSingle();
      const val = cfgRow?.value;
      if (val && typeof val === "object" && (val.clientTemplateId || val.clientTemplateUrl) && (val.masterTemplateId || val.masterTemplateUrl) && (val.reconTemplateId || val.reconTemplateUrl)) {
        return {
          clientTemplateUrl: val.clientTemplateUrl || "",
          masterTemplateUrl: val.masterTemplateUrl || "",
          reconTemplateUrl: val.reconTemplateUrl || "",
          clientTemplateId: val.clientTemplateId || extractSheetIdFromUrl(val.clientTemplateUrl),
          masterTemplateId: val.masterTemplateId || extractSheetIdFromUrl(val.masterTemplateUrl),
          reconTemplateId: val.reconTemplateId || extractSheetIdFromUrl(val.reconTemplateUrl),
          clientTemplateScriptId: val.clientTemplateScriptId || "",
          masterTemplateScriptId: val.masterTemplateScriptId || "",
          reconTemplateScriptId: val.reconTemplateScriptId || "",
        };
      }
    } catch (sbErr) {
      console.warn("[getProvisioningTemplates] Supabase read warning:", sbErr.message);
    }
  }

  const activeSheets = sheets || (await getSheetsClient().catch(() => null));
  if (!activeSheets) {
    throw new Error("Could not load client provisioning templates from Supabase or Google Sheets.");
  }

  const templateRowRes = await withRetry(() =>
    activeSheets.spreadsheets.values.get({
      spreadsheetId: TRACKER_SHEET_ID,
      range: "Clients!A3:T3"
    })
  );
  const templateRow = (templateRowRes.data.values || [[]])[0] || [];
  const clientTemplateUrl = String(templateRow[11] || "").trim(); // Col L
  const masterTemplateUrl = String(templateRow[12] || "").trim(); // Col M
  const reconTemplateUrl = String(templateRow[13] || "").trim();  // Col N

  const clientTemplateId = extractSheetIdFromUrl(clientTemplateUrl);
  const masterTemplateId = extractSheetIdFromUrl(masterTemplateUrl);
  const reconTemplateId = extractSheetIdFromUrl(reconTemplateUrl);

  const result = {
    clientTemplateUrl,
    masterTemplateUrl,
    reconTemplateUrl,
    clientTemplateId,
    masterTemplateId,
    reconTemplateId,
    clientTemplateScriptId: String(templateRow[17] || "").trim(), // Col R
    masterTemplateScriptId: String(templateRow[18] || "").trim(), // Col S
    reconTemplateScriptId: String(templateRow[19] || "").trim(),  // Col T
  };

  if (sb && clientTemplateId && masterTemplateId && reconTemplateId) {
    const nowIso = new Date().toISOString();
    try {
      await sb.from("system_config").upsert({
        key: CLIENT_PROVISIONING_TEMPLATES_KEY,
        value: {
          ...result,
          seededAt: nowIso,
          updatedAt: nowIso,
        },
        description: "Client, Master, and Recon Google Sheet template URLs and Script IDs seeded from Tracker row 3",
        updated_by: "System (Migration Seed)",
      });
    } catch (_) { }
  }

  return result;
}

/**
 * Saves Script IDs to Supabase `public.clients` (primary) and legacy Clients Version Tracker (non-Supabase control plane mode).
 */
export async function saveScriptIdsToTracker(sheets, { clientName, clientScriptId, masterScriptId, reconScriptId, userEmail }) {
  if (!clientName) throw new Error("Missing clientName");

  const norm = normalizeKey(clientName);
  let rowNum = null;
  let clientMode = "sheet";
  let masterMode = "sheet";

  if (isSupabaseConfigured()) {
    const sb = getSupabaseAdmin();
    const { data: existingClient } = await sb
      .from("clients")
      .select("client_mode, master_mode, client_script_id, master_script_id, recon_script_id")
      .eq("normalized_key", norm)
      .maybeSingle();

    if (existingClient) {
      clientMode = existingClient.client_mode || "sheet";
      masterMode = existingClient.master_mode || "sheet";
    }

    const updatePayload = {};
    if (clientScriptId !== undefined) updatePayload.client_script_id = String(clientScriptId || "");
    if (masterScriptId !== undefined) updatePayload.master_script_id = String(masterScriptId || "");
    if (reconScriptId !== undefined) updatePayload.recon_script_id = String(reconScriptId || "");

    if (Object.keys(updatePayload).length > 0) {
      await sb
        .from("clients")
        .update(updatePayload)
        .eq("normalized_key", norm);
    }
  }

  const supaControlPlane = await isSupabaseControlPlaneActive().catch(() => false);
  if (!supaControlPlane && sheets) {
    try {
      const trackerRes = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: TRACKER_SHEET_ID,
          range: "Clients!A1:A100"
        })
      );
      const rows = trackerRes.data.values || [];
      const targetRowIdx = rows.findIndex(r => String(r[0] || "").trim().toLowerCase() === clientName.toLowerCase());

      if (targetRowIdx !== -1) {
        rowNum = targetRowIdx + 1;
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: TRACKER_SHEET_ID,
            range: `Clients!R${rowNum}:T${rowNum}`,
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                sanitizeFormulaInput(String(clientScriptId || "")),
                sanitizeFormulaInput(String(masterScriptId || "")),
                sanitizeFormulaInput(String(reconScriptId || ""))
              ]]
            }
          })
        );
      }
    } catch (trackerErr) {
      console.warn("[saveScriptIdsToTracker] Legacy tracker update note:", trackerErr.message);
    }
  }

  const metaParts = [];
  if (clientMode === "sheet") metaParts.push(`Client: ${clientScriptId || "NA"}`);
  if (masterMode === "sheet") {
    metaParts.push(`Master: ${masterScriptId || "NA"}`);
    metaParts.push(`Recon: ${reconScriptId || "NA"}`);
  }

  // Auto-mark task p1_script_ids as complete
  await updateClientChecklistTask(sheets, {
    clientName,
    taskId: "p1_script_ids",
    isCompleted: true,
    metadata: metaParts.join(" | ") || "Saved",
    userEmail
  });

  logPmaActivity({
    action: "setup_script_ids_saved",
    details: rowNum
      ? `Saved Script IDs into Supabase and Client Version Tracker row ${rowNum} for ${clientName}`
      : `Saved Script IDs for ${clientName}`,
    clientName,
    userEmail: userEmail || "Admin"
  }).catch(() => { });

  return { success: true, rowNum };
}

/**
 * Saves Master Sheet Deployment URL to KeyInfo!X29, Supabase `public.clients` (`master_deployment_url`),
 * and (in legacy mode) Column W of Client Version Tracker.
 */
export async function saveDeploymentUrl(sheets, { clientName, masterSheetId, deploymentUrl, userEmail }) {
  if (!clientName || !deploymentUrl) throw new Error("Missing clientName or deploymentUrl");

  const trimmedUrl = String(deploymentUrl).trim();
  if (!isValidGoogleScriptUrl(trimmedUrl)) {
    throw new Error("Invalid deployment URL: Must be a deployed Google Apps Script Web App URL (https://script.google.com/macros/s/<id>/exec).");
  }

  // 1. Write to Master Sheet KeyInfo!X29
  if (masterSheetId && sheets) {
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: masterSheetId,
        range: "KeyInfo!X29",
        valueInputOption: "RAW",
        requestBody: { values: [[trimmedUrl]] }
      })
    );
  }

  // 2. Write to Supabase public.clients (primary)
  if (isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      await sb
        .from("clients")
        .update({ master_deployment_url: trimmedUrl })
        .eq("normalized_key", normalizeKey(clientName));
    } catch (sbErr) {
      console.warn("[saveDeploymentUrl] Supabase update warning:", sbErr.message);
    }
  }

  // 2b. Legacy mirror to Column W of Clients Version Tracker when not on Supabase control plane
  const supaControlPlane = await isSupabaseControlPlaneActive().catch(() => false);
  if (!supaControlPlane && sheets) {
    try {
      const trackerRes = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: TRACKER_SHEET_ID,
          range: "Clients!A1:A100"
        })
      );
      const rows = trackerRes.data.values || [];
      const targetRowIdx = rows.findIndex(r => String(r[0] || "").trim().toLowerCase() === clientName.toLowerCase());

      if (targetRowIdx !== -1) {
        const rowNum = targetRowIdx + 1;
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: TRACKER_SHEET_ID,
            range: `Clients!W${rowNum}`,
            valueInputOption: "RAW",
            requestBody: { values: [[trimmedUrl]] }
          })
        );
      }
    } catch (trackerErr) {
      console.warn("[saveDeploymentUrl] Legacy tracker update note:", trackerErr.message);
    }
  }

  // 3. Mark task p1_gas_deployment as complete
  await updateClientChecklistTask(sheets, {
    clientName,
    taskId: "p1_gas_deployment",
    isCompleted: true,
    metadata: deploymentUrl,
    userEmail
  });

  // 4. Global secret broadcasting (CRON_SECRET, PULSE_INTERNAL_SECRET, VERCEL_BYPASS_TOKEN, AGENT_TRIGGER_SECRET)
  // via sync_script_secrets has been severed as Master Google Sheets retire in favour of Supabase Masters.

  logPmaActivity({
    action: "setup_deployment_url_saved",
    details: `Saved Master GAS deployment URL for ${clientName}`,
    clientName,
    userEmail: userEmail || "Admin"
  }).catch(() => { });

  return { success: true };
}

/**
 * ============================================================================
 * FULL CLIENT PROVISIONING ENGINE (DRIVE + SHEETS + MULTI-REGISTRY ENROLLMENT)
 * ============================================================================
 */
function extractDriveFolderId(input) {
  if (!input) return "";
  const str = String(input).trim();
  const folderMatch = str.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch && folderMatch[1]) return folderMatch[1];
  const idParamMatch = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch && idParamMatch[1]) return idParamMatch[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(str)) return str;
  return "";
}

export async function provisionNewClientSystem({
  clientName,
  clientMode = "supabase",
  masterMode = "supabase",
  accountingTool = "None",
  crmTool = "None",
  crmDrives = "NA",
  targetParentFolderId = DEFAULT_CLIENTS_FOLDER_ID,
  existingFolderId = "",
  userEmail = "Admin"
}) {
  if (!clientName || !clientName.trim()) {
    throw new Error("Client name is required");
  }
  if (!["supabase", "sheet"].includes(clientMode) || !["supabase", "sheet"].includes(masterMode)) {
    throw new Error("Invalid provisioning mode: clientMode and masterMode must be 'supabase' or 'sheet'.");
  }
  if ((clientMode === "supabase" || masterMode === "supabase") && !isSupabaseConfigured()) {
    throw new Error("Supabase must be configured to provision Supabase-backed client or master engines.");
  }

  const cleanClientName = sanitizeFormulaInput(clientName.trim());
  const norm = normalizeKey(cleanClientName);
  const needsClientSheet = clientMode === "sheet";
  const needsMasterSheet = masterMode === "sheet";
  const needsDriveFolder = needsClientSheet || needsMasterSheet;

  const sheets = await getSheetsClient();
  const drive = needsDriveFolder ? await getDriveClient() : null;
  const supaControlPlane = await isSupabaseControlPlaneActive().catch(() => false);
  if (!supaControlPlane) {
    await ensureClientSetupTabs(sheets);
  }

  console.log(`🚀 Starting Provisioning for new client: "${cleanClientName}" (client=${clientMode}, master=${masterMode})...`);

  // 1. Get Template IDs from Supabase `system_config` (`client_provisioning_templates`) with Tracker fallback
  const templates = await getProvisioningTemplates(sheets);
  const { clientTemplateId, masterTemplateId, reconTemplateId } = templates;

  if (!clientTemplateId || !masterTemplateId || !reconTemplateId) {
    throw new Error("Missing client provisioning template IDs in Supabase system_config (`client_provisioning_templates`) or Clients Version Tracker Row 3.");
  }

  // 2. Use Existing Folder or Create Destination Folder in Google Drive (ONLY if at least one sheet is Google Sheets)
  let folderId = "";
  let folderUrl = "";
  if (needsDriveFolder) {
    const parsedExistingId = extractDriveFolderId(existingFolderId);

    if (parsedExistingId) {
      console.log(`  📁 Using existing Drive folder "${parsedExistingId}" for "${cleanClientName}"...`);
      const existingMeta = await withRetry(() =>
        drive.files.get({
          fileId: parsedExistingId,
          fields: "id, name, webViewLink, mimeType",
          supportsAllDrives: true
        })
      );
      if (!existingMeta?.data?.id) {
        throw new Error("Could not access the specified existing Google Drive folder.");
      }
      folderId = existingMeta.data.id;
      folderUrl = existingMeta.data.webViewLink || `https://drive.google.com/drive/folders/${folderId}`;
    } else {
      const parentId = extractDriveFolderId(targetParentFolderId) || DEFAULT_CLIENTS_FOLDER_ID;
      console.log(`  📁 Creating Drive folder "${cleanClientName}" inside parent "${parentId}"...`);
      const folderRes = await drive.files.create({
        requestBody: {
          name: cleanClientName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId]
        },
        fields: "id, name, webViewLink",
        supportsAllDrives: true
      });
      folderId = folderRes.data.id;
      folderUrl = folderRes.data.webViewLink || `https://drive.google.com/drive/folders/${folderId}`;
    }
  }

  // 3. Duplicate Only Required Templates into the Drive Folder
  let clientCopy = null;
  let masterCopy = null;
  let reconCopy = null;
  let backupCopy = null;

  if (needsDriveFolder) {
    console.log(`  📋 Copying required templates into Google Drive (client=${needsClientSheet}, master=${needsMasterSheet})...`);
    const copyTasks = [];
    if (needsClientSheet) {
      copyTasks.push(
        drive.files.copy({
          fileId: clientTemplateId,
          requestBody: {
            name: `${cleanClientName} Agency Management Dashboard`,
            parents: [folderId]
          },
          fields: "id, name, webViewLink"
        }).then((res) => { clientCopy = res; })
      );
    }
    if (needsMasterSheet) {
      copyTasks.push(
        drive.files.copy({
          fileId: masterTemplateId,
          requestBody: {
            name: `AMD ${cleanClientName} master`,
            parents: [folderId]
          },
          fields: "id, name, webViewLink"
        }).then((res) => { masterCopy = res; }),
        drive.files.copy({
          fileId: reconTemplateId,
          requestBody: {
            name: `Recon ${cleanClientName}`,
            parents: [folderId]
          },
          fields: "id, name, webViewLink"
        }).then((res) => { reconCopy = res; }),
        drive.files.create({
          requestBody: {
            name: `${cleanClientName} backup sheet`,
            mimeType: "application/vnd.google-apps.spreadsheet",
            parents: [folderId]
          },
          fields: "id, name, webViewLink"
        }).then((res) => { backupCopy = res; })
      );
    }
    await Promise.all(copyTasks);
  }

  const clientSheetId = needsClientSheet ? clientCopy.data.id : `sb-client-${norm}`;
  const masterSheetId = needsMasterSheet ? masterCopy.data.id : `sb-master-${norm}`;
  const reconSheetId = needsMasterSheet ? reconCopy.data.id : `sb-recon-${norm}`;

  const clientUrl = needsClientSheet ? (clientCopy.data.webViewLink || `https://docs.google.com/spreadsheets/d/${clientSheetId}/edit`) : "";
  const masterUrl = needsMasterSheet ? (masterCopy.data.webViewLink || `https://docs.google.com/spreadsheets/d/${masterSheetId}/edit`) : "";
  const reconUrl = needsMasterSheet ? (reconCopy.data.webViewLink || `https://docs.google.com/spreadsheets/d/${reconSheetId}/edit`) : "";
  const backupUrl = needsMasterSheet ? (backupCopy.data.webViewLink || `https://docs.google.com/spreadsheets/d/${backupCopy.data.id}/edit`) : "";

  // 4. Grant Editor Permissions on created Google Drive files
  const createdFileIds = [
    clientCopy?.data?.id,
    masterCopy?.data?.id,
    reconCopy?.data?.id,
    backupCopy?.data?.id,
  ].filter(Boolean);

  if (createdFileIds.length > 0 && drive) {
    const emailsToShare = [
      ...new Set([
        "pulse@pulsedashboard.co.uk",
        "alert-triage-backend@automation-commander.iam.gserviceaccount.com",
        ...getServiceAccountPoolEmails(),
      ]),
    ];
    const groupEmail = (process.env.GOOGLE_SERVICE_ACCOUNT_GROUP_EMAIL || "").trim().toLowerCase();
    for (const fileId of createdFileIds) {
      for (const email of emailsToShare) {
        const isGroup = groupEmail && email.toLowerCase() === groupEmail;
        drive.permissions.create({
          fileId,
          requestBody: { role: "writer", type: isGroup ? "group" : "user", emailAddress: email },
          sendNotificationEmail: false,
          supportsAllDrives: true,
        }).catch(err => console.warn(`Share note for ${email}:`, err.message));
      }
    }
  }

  // 5. Update KeyInfo Tabs Across Created Google Sheets
  if (createdFileIds.length > 0) {
    console.log(`  🔗 Linking KeyInfo tabs across created Google Sheets...`);
    const linkPromises = [];
    const clientRefForSheet = clientUrl || clientSheetId;
    const masterRefForSheet = masterUrl || masterSheetId;
    const reconRefForSheet = reconUrl || reconSheetId;

    if (needsMasterSheet && masterCopy?.data?.id) {
      linkPromises.push(
        withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: masterCopy.data.id,
            requestBody: {
              valueInputOption: "USER_ENTERED",
              data: [
                { range: "KeyInfo!B1", values: [[cleanClientName]] },
                { range: "KeyInfo!C1", values: [[clientRefForSheet]] },
                { range: "KeyInfo!D1", values: [[masterRefForSheet]] },
                { range: "KeyInfo!G1", values: [[reconRefForSheet]] },
                { range: "KeyInfo!Q4", values: [[accountingTool || "None"]] },
                { range: "KeyInfo!Q8", values: [[crmTool || "None"]] },
                { range: "KeyInfo!Q9", values: [[crmDrives || "NA"]] }
              ]
            },
            _bypassSupabaseVirtualSheet: true,
          })
        ).catch(e => console.warn("Master KeyInfo update note:", e.message))
      );
    }

    if (needsMasterSheet && reconCopy?.data?.id) {
      linkPromises.push(
        withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: reconCopy.data.id,
            range: "KeyInfo!C1:D1",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[clientRefForSheet, masterRefForSheet]] },
            _bypassSupabaseVirtualSheet: true,
          })
        ).catch(e => console.warn("Recon KeyInfo update note:", e.message))
      );
    }

    if (needsClientSheet && clientCopy?.data?.id) {
      linkPromises.push(
        withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: clientCopy.data.id,
            requestBody: {
              valueInputOption: "USER_ENTERED",
              data: [
                { range: "KeyInfo!C1", values: [[clientRefForSheet]] },
                { range: "KeyInfo!D1", values: [[masterRefForSheet]] }
              ]
            },
            _bypassSupabaseVirtualSheet: true,
          })
        ).catch(e => console.warn("Client KeyInfo update note:", e.message))
      );
    }

    await Promise.all(linkPromises);
  }

  // 6. Enroll in Legacy Sheets Control Plane (only when Supabase control plane is inactive)
  if (!supaControlPlane) {
    console.log(`  📝 Enrolling into Clients Version Tracker...`);
    try {
      const aRes = await sheets.spreadsheets.values.get({
        spreadsheetId: TRACKER_SHEET_ID,
        range: "Clients!A1:A100"
      });
      const aVals = aRes.data.values || [];
      let targetRow = -1;
      for (let i = 4; i < aVals.length; i++) {
        if (!aVals[i] || !aVals[i][0] || aVals[i][0].trim() === "") {
          targetRow = i + 1;
          break;
        }
      }
      if (targetRow === -1) targetRow = aVals.length + 1;

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TRACKER_SHEET_ID,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: [
            { range: `Clients!A${targetRow}`, values: [[cleanClientName]] },
            { range: `Clients!L${targetRow}`, values: [[clientUrl]] },
            { range: `Clients!M${targetRow}`, values: [[masterUrl]] },
            { range: `Clients!N${targetRow}`, values: [[reconUrl]] },
            { range: `Clients!Y${targetRow}`, values: [[backupUrl]] }
          ]
        }
      });
    } catch (trackerErr) {
      console.warn("Tracker enrollment note:", trackerErr.message);
    }

    // 7. Enroll in Automation Commander (AutoUpdates!A:A)
    console.log(`  🤖 Enrolling into Automation Commander AutoUpdates...`);
    try {
      const acRes = await sheets.spreadsheets.values.get({
        spreadsheetId: DEFAULT_AC_SHEET_ID,
        range: "AutoUpdates!A1:A500"
      });
      const acNames = (acRes.data.values || []).map(r => String(r[0] || "").trim().toLowerCase());
      if (!acNames.includes(cleanClientName.toLowerCase())) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: DEFAULT_AC_SHEET_ID,
          range: "AutoUpdates!A:M",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[
              cleanClientName, "", "", "", "", "", "", "", "", "", "",
              clientUrl, masterUrl
            ]]
          }
        });
      }
    } catch (acErr) {
      console.warn("AC AutoUpdates enrollment note:", acErr.message);
    }

    // 8. Enroll in Reporting Control (RepControl!A:A)
    console.log(`  📊 Enrolling into Reporting Control...`);
    try {
      const repRes = await sheets.spreadsheets.values.get({
        spreadsheetId: REPORTING_CONTROL_SHEET_ID,
        range: "RepControl!A1:A500"
      });
      const repNames = (repRes.data.values || []).map(r => String(r[0] || "").trim().toLowerCase());
      if (!repNames.includes(cleanClientName.toLowerCase())) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: REPORTING_CONTROL_SHEET_ID,
          range: "RepControl!A:A",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[cleanClientName]] }
        });
      }
    } catch (repErr) {
      console.warn("Reporting Control enrollment note:", repErr.message);
    }
  }

  // 9. Seed Overview & Initial Tasks
  const now = new Date().toISOString();
  const autoDoneTaskIds = new Set([
    ...(needsDriveFolder ? ["p1_drive_folder", "p1_duplicate_templates"] : []),
  ]);
  const hasCrmOnProvision = Boolean(
    crmTool && !["none", "na", "n/a", ""].includes(String(crmTool).trim().toLowerCase())
  );
  const template = await getSetupProcessTemplate(sheets).catch(() => null);
  const catalogTasks = (template?.tasks || DEFAULT_SETUP_TASKS_CATALOG).filter(t => t.active !== false);
  const initialTasksMap = {};
  for (const t of catalogTasks) {
    const isAutoDone = autoDoneTaskIds.has(t.id);
    initialTasksMap[t.id] = {
      phaseId: t.phaseId || "",
      isCompleted: isAutoDone,
      status: isAutoDone ? "completed" : "pending",
      completedAt: isAutoDone ? now : "",
      completedBy: isAutoDone ? "Provisioning Engine" : "",
      metadata: isAutoDone ? "Automated upon creation" : ""
    };
  }

  const isProvisionTaskApplicable = (t) => {
    if (["p2_connect_crm", "p4_crm_list_tab", "p4_review_crm"].includes(t.id)) return hasCrmOnProvision;
    if (["p1_importrange_auth", "p1_agent_secret", "p1_gas_deployment"].includes(t.id)) return needsMasterSheet;
    if (["p1_drive_folder", "p1_duplicate_templates", "p1_bookmarks", "p1_rename_gas", "p1_script_ids"].includes(t.id)) return needsDriveFolder;
    return true;
  };
  const applicableTasksCount = catalogTasks.filter(isProvisionTaskApplicable).length;
  const applicableCompletedCount = catalogTasks.filter(
    (t) => autoDoneTaskIds.has(t.id) && isProvisionTaskApplicable(t)
  ).length;
  const initialProgressPct = applicableTasksCount > 0
    ? Math.round((applicableCompletedCount / applicableTasksCount) * 100)
    : 0;

  if (!supaControlPlane) {
    console.log(`  🎯 Seeding ClientSetupOverview & ClientSetupTasks...`);
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: DEFAULT_AC_SHEET_ID,
        range: `${CLIENT_SETUP_OVERVIEW_TAB}!A:L`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[
            cleanClientName, "IN_PROGRESS", `${initialProgressPct}%`, String(applicableCompletedCount), String(applicableTasksCount), now, "",
            folderUrl, clientUrl, masterUrl, reconUrl, backupUrl
          ]]
        }
      });

      const initialTaskRows = catalogTasks.map(t => {
        const isAutoDone = autoDoneTaskIds.has(t.id);
        return [
          cleanClientName,
          t.phaseId,
          t.id,
          t.title,
          isAutoDone ? "TRUE" : "FALSE",
          isAutoDone ? now : "",
          isAutoDone ? "Provisioning Engine" : "",
          isAutoDone ? "Automated upon creation" : ""
        ];
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId: DEFAULT_AC_SHEET_ID,
        range: `${CLIENT_SETUP_TASKS_TAB}!A:H`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: initialTaskRows }
      });
    } catch (seedErr) {
      console.warn("Setup tabs seed note:", seedErr.message);
    }
  }

  // 9b. Seed Default EoM Tasks for this client into Supabase EoM state (and EomClientTasks if legacy)
  console.log(`  📋 Seeding Default EoM tasks for "${cleanClientName}"...`);
  try {
    const { applyDefaultEomTasksToClient_ } = await import("./eomTools");
    await applyDefaultEomTasksToClient_(sheets, DEFAULT_AC_SHEET_ID, cleanClientName);
  } catch (eomSeedErr) {
    console.warn("EoM default tasks seed note:", eomSeedErr.message);
  }

  // 10. Persist to Redis & Supabase
  const hasSelectedTools = Boolean(
    (accountingTool && accountingTool !== "None") ||
    (crmTool && crmTool !== "None")
  );
  const setupConfigRecord = {
    clientName: cleanClientName,
    masterSheetId,
    clientSheetId,
    clientMode,
    masterMode,
    setupMode: true,
    requestConnections: hasSelectedTools,
    accountingTool,
    crmTool,
    crmDrives,
    folderUrl,
    clientUrl,
    masterUrl,
    reconUrl,
    backupUrl,
    sheetSyncedAt: now,
    updatedAt: now,
    updatedBy: userEmail
  };
  await redisClient.set(getSetupRedisKey(cleanClientName), JSON.stringify(setupConfigRecord)).catch(() => { });
  await redisClient.del(getChecklistRedisKey(cleanClientName)).catch(() => { });

  if (isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      const { data: insertedClient, error: clientUpsertErr } = await sb
        .from("clients")
        .upsert({
          client_name: cleanClientName,
          normalized_key: norm,
          status: "live",
          client_mode: clientMode,
          master_mode: masterMode,
          client_sheet_id: clientSheetId,
          client_sheet_url: clientUrl,
          master_sheet_id: masterSheetId,
          master_sheet_url: masterUrl,
          recon_sheet_id: reconSheetId,
          recon_sheet_url: reconUrl,
          backup_sheet_url: backupUrl,
          drive_folder_id: folderId,
          grid_storage_retired: false,
          grid_retired_at: null,
          metadata: {
            setupMode: true,
            requestConnections: hasSelectedTools,
            folderUrl,
            backupSheetId: backupCopy?.data?.id || "",
            accountingTool: accountingTool || "None",
            crmTool: crmTool || "None",
            crmDrives: crmDrives || "NA",
          },
        }, { onConflict: "normalized_key" })
        .select("id")
        .maybeSingle();

      if (clientUpsertErr) {
        console.warn("⚠️ Supabase clients upsert warning:", clientUpsertErr.message);
      }

      // Seed virtual Supabase grids directly from templates (and materialize Client Google Sheet if Master is Supabase)
      if (clientMode === "supabase" || masterMode === "supabase") {
        console.log(`  🗄️ Seeding Supabase virtual workbooks from templates (client=${clientMode}, master=${masterMode})...`);
        await seedNewClientTemplatesToSupabase(sheets, {
          clientId: insertedClient?.id || null,
          clientName: cleanClientName,
          normalizedKey: norm,
          clientMode,
          masterMode,
          clientSheetId,
          clientUrl,
          masterSheetId,
          masterUrl,
          reconSheetId,
          reconUrl,
          accountingTool,
          crmTool,
          crmDrives,
          clientTemplateId,
          masterTemplateId,
          reconTemplateId,
        });
      }

      await sb.from("client_setup_state").upsert({
        client_id: insertedClient?.id || null,
        client_name: cleanClientName,
        normalized_key: norm,
        setup_status: "IN_PROGRESS",
        accounting_tool: accountingTool || "None",
        crm_tool: crmTool || "None",
        crm_drives: crmDrives || "NA",
        tasks_map: initialTasksMap,
        overview_data: {
          status: "IN_PROGRESS",
          progressPercent: initialProgressPct,
          completedTasks: applicableCompletedCount,
          totalTasks: applicableTasksCount,
          driveFolderUrl: folderUrl,
          clientSheetUrl: clientUrl,
          masterSheetUrl: masterUrl,
          reconSheetUrl: reconUrl,
          backupSheetUrl: backupUrl,
          startedAt: now,
        },
      }, { onConflict: "normalized_key" });
    } catch (sbErr) {
      console.warn("⚠️ Supabase provisionNewClientSystem warning:", sbErr.message);
      if (clientMode === "supabase" || masterMode === "supabase") {
        throw sbErr;
      }
    }
  }

  // Invalidate client list caches so the new client appears immediately across workspaces & portal
  try {
    clearAllClientsMemoryCache();
    clearSsrClientsMemoryCache();
    if (redisClient?.isOpen) {
      await Promise.all([
        invalidateAllClientsRedisKeys(),
        redisClient.del(INTEGRATIONS_STATUS_CACHE_KEY),
      ]);
    }
  } catch (_) { }

  logPmaActivity({
    action: "client_provisioned",
    details: `Provisioned new client "${cleanClientName}" (client: ${clientMode}, master: ${masterMode})`,
    clientName: cleanClientName,
    userEmail
  }).catch(() => { });

  console.log(`✅ Client "${cleanClientName}" successfully provisioned!`);

  return {
    success: true,
    clientName: cleanClientName,
    clientMode,
    masterMode,
    setupMode: true,
    requestConnections: hasSelectedTools,
    accountingTool: accountingTool || "None",
    crmTool: crmTool || "None",
    hasRealClientSheet: needsClientSheet,
    hasRealMasterSheet: needsMasterSheet,
    folderUrl,
    clientUrl,
    masterUrl,
    reconUrl,
    backupUrl,
    clientSheetId,
    masterSheetId,
    reconSheetId
  };
}

