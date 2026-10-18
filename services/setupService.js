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

import { redisClient } from "./redisClient.js";
import { getIntegrationStatus } from "./vaultService.js";
import { getSheetsClient, getDriveClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { logPmaActivity, DEFAULT_AC_SHEET_ID } from "./pmaLogger.js";
import { isUserAuthorizedForClient } from "./userPermissions.js";

export const TRACKER_SHEET_ID = "1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co";
export const REPORTING_CONTROL_SHEET_ID = "1uAJS6ZWn0o-GPU9Ea3DIVU9nzQoRnXrMfmBcQYHNJ_s";
export const DEFAULT_CLIENTS_FOLDER_ID = "16qLMIFy1GyiEZ4DkKjVaFXOKGQKDW8Cj";
export const CLIENT_SETUP_OVERVIEW_TAB = "ClientSetupOverview";
export const CLIENT_SETUP_TASKS_TAB = "ClientSetupTasks";

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
    title: "1. Infrastructure & Sheet Linking",
    description: "Drive folder provisioning, template duplication, cross-linking, and script deployment."
  },
  {
    id: "phase_2",
    title: "2. Settings & Tool Connections",
    description: "Core accounting & CRM tool choices, OAuth connections, and financial KeyInfo anchors."
  },
  {
    id: "phase_3",
    title: "3. Accounting Baseline & Data",
    description: "Chart of Accounts, P&L baselines, starter PL, invoices sync, and outgoings breakdown."
  },
  {
    id: "phase_4",
    title: "4. Automations & Cadence",
    description: "CRM data review, trigger scheduling, automation flags, and EoM inclusion."
  },
  {
    id: "phase_5",
    title: "5. User Access & Go-Live",
    description: "Client user assignment, welcome notifications, and live dashboard launch."
  }
];

export const SETUP_TASKS_CATALOG = [
  // Phase 1: Infrastructure & Linking
  { id: "p1_drive_folder", phaseId: "phase_1", title: "Create client folder in Google Drive", autoCompletable: true },
  { id: "p1_duplicate_templates", phaseId: "phase_1", title: "Duplicate client, master & recon templates", autoCompletable: true },
  { id: "p1_bookmarks", phaseId: "phase_1", title: "Create bookmarks for all three new sheets" },
  { id: "p1_importrange_auth", phaseId: "phase_1", title: "Authorise IMPORTRANGE connections (Master, Client, Recon)" },
  { id: "p1_agent_secret", phaseId: "phase_1", title: "Add global variable to master sheet: AGENT_TRIGGER_SECRET / ^V0#8pSKx)y9xq}|" },
  { id: "p1_gas_deployment", phaseId: "phase_1", title: "Deploy Master sheet GAS and copy deployment URL to KeyInfo!X29" },
  { id: "p1_rename_gas", phaseId: "phase_1", title: "Rename GAS file names" },
  { id: "p1_script_ids", phaseId: "phase_1", title: "Copy GAS script IDs into Client Version Tracker doc" },

  // Phase 2: Initial Settings & Integrations
  { id: "p2_select_tools", phaseId: "phase_2", title: "Select accounting tool and CRM in KeyInfo Q4, Q8 and Q9", autoCompletable: true },
  { id: "p2_connect_accounting", phaseId: "phase_2", title: "Connect to accounting tool via Pulse Vault", autoCompletable: true },
  { id: "p2_connect_crm", phaseId: "phase_2", title: "Connect to CRM tool via Pulse Vault", autoCompletable: true },
  { id: "p2_keyinfo_settings", phaseId: "phase_2", title: "Adjust core settings in KeyInfo (Start date, VAT, PAYE, Revenue focus, Profit share %)" },

  // Phase 3: Accounting Setup & Baseline
  { id: "p3_chart_of_accounts", phaseId: "phase_3", title: "Pull Chart of Accounts (KeyInfo AV2) and select manual categories" },
  { id: "p3_pull_pl", phaseId: "phase_3", title: "Pull P&L (KeyInfo AY2) and Year 0 P&L (KeyInfo AY5) and assign categories" },
  { id: "p3_year0_setup", phaseId: "phase_3", title: "Check Year 0 setup, adding dividends in lieu of salary as required" },
  { id: "p3_sync_invoices", phaseId: "phase_3", title: "Sync last x months of invoices (to 3 months before start date)" },
  { id: "p3_starter_pl", phaseId: "phase_3", title: "Run StarterPL setup" },
  { id: "p3_other_expenses", phaseId: "phase_3", title: "Add 'other expenses' forecast amounts into Outgoings tab" },
  { id: "p3_contractors_info", phaseId: "phase_3", title: "Add contractor information to Outgoings tab" },
  { id: "p3_employee_salaries", phaseId: "phase_3", title: "Add employee salaries information" },
  { id: "p3_dividends_info", phaseId: "phase_3", title: "Add dividends in lieu of salary information to Outgoings tab" },
  { id: "p3_cash_opening", phaseId: "phase_3", title: "Add cash opening figure" },

  // Phase 4: Automations & Cadence
  { id: "p4_review_crm", phaseId: "phase_4", title: "Review CRM data, mapping fields, and client assumptions" },
  { id: "p4_crm_list_tab", phaseId: "phase_4", title: "Set up CRMList tab (mappings, Confirmed & Pipeline definitions)" },
  { id: "p4_review_retainers", phaseId: "phase_4", title: "Review recurring invoices to check for retainers" },
  { id: "p4_agent_trigger", phaseId: "phase_4", title: "Turn on agent check (Master menu: Install Trigger: Agent Check)" },
  { id: "p4_pl_trigger", phaseId: "phase_4", title: "Turn on P&L download (Master menu: Install Trigger: P&L Download)" },
  { id: "p4_ac_enrollment", phaseId: "phase_4", title: "Add client name to column A of Automation Commander sheet", autoCompletable: true },
  { id: "p4_automation_freq", phaseId: "phase_4", title: "In master sheet DataChgAlert tab, select frequency of automations (Y2:Y5)" },
  { id: "p4_datachg_flags", phaseId: "phase_4", title: "Update other DataChgAlert flags as required" },
  { id: "p4_rep_control", phaseId: "phase_4", title: "Add client name to column A of Reporting Control sheet", autoCompletable: true },
  { id: "p4_eom_jobs", phaseId: "phase_4", title: "Add client details and monthly jobs to EoM section of PMA" },

  // Phase 5: Client Users & Go-Live
  { id: "p5_add_users", phaseId: "phase_5", title: "Add users to Users tab in Automation Commander sheet" },
  { id: "p5_email_client", phaseId: "phase_5", title: "Email client with login details and launch live access" }
];

export const OAUTH_TOOLS = [
  "xero",
  "quickbooks",
  "clickup",
  "close",
  "capsule",
  "hubspot",
  "monday",
  "pipedrive"
];

export function isOAuthTool(tool) {
  if (!tool) return false;
  const clean = String(tool).trim().toLowerCase();
  return OAUTH_TOOLS.includes(clean);
}

/**
 * Returns full setup configuration for a client (for PMA Setup view).
 */
export async function getClientSetupConfig({ clientName, masterSheetId, forceSheetSync = false }) {
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

  // Fast path: Only query Google Sheets API if:
  // 1) forceSheetSync is true, OR
  // 2) Redis does not have accountingTool and crmTool cached yet
  const hasCachedTools = config && typeof config.accountingTool === "string" && typeof config.crmTool === "string";
  const needsSheetSync = forceSheetSync || !hasCachedTools;

  let sheetQ4 = config?.accountingTool || "None";
  let sheetQ8 = config?.crmTool || "None";
  let sheetQ9 = config?.crmDrives || "NA";

  if (needsSheetSync && masterSheetId) {
    try {
      const sheets = await getSheetsClient();
      const res = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: masterSheetId,
          range: "KeyInfo!Q4:Q9"
        })
      );
      const rows = res.data.values || [];
      sheetQ4 = (rows[0] && rows[0][0]) ? String(rows[0][0]).trim() : "None";
      sheetQ8 = (rows[4] && rows[4][0]) ? String(rows[4][0]).trim() : "None";
      sheetQ9 = (rows[5] && rows[5][0]) ? String(rows[5][0]).trim() : "NA";

      // Persist to Redis so future visits load instantly from memory
      const updatedRecord = {
        ...(config || {}),
        clientName,
        masterSheetId: masterSheetId || config?.masterSheetId || "",
        setupMode: config?.setupMode === true,
        requestConnections: config?.requestConnections === true,
        accountingTool: sheetQ4,
        crmTool: sheetQ8,
        crmDrives: sheetQ9,
        sheetSyncedAt: new Date().toISOString(),
        updatedAt: config?.updatedAt || new Date().toISOString()
      };
      await redisClient.set(redisKey, JSON.stringify(updatedRecord));
      config = updatedRecord;
    } catch (sheetErr) {
      console.log(`Note reading KeyInfo!Q4:Q9 for ${clientName}:`, sheetErr.message);
    }
  }

  // Merge Redis config with sheet values
  const setupMode = config?.setupMode === true;
  const requestConnections = config?.requestConnections === true;
  const accountingTool = config?.accountingTool || sheetQ4 || "None";
  const crmTool = config?.crmTool || sheetQ8 || "None";
  const crmDrives = config?.crmDrives || sheetQ9 || "NA";

  // Check live connection statuses from Vault
  let accountingStatus = { connected: false, tool: accountingTool };
  if (isOAuthTool(accountingTool)) {
    accountingStatus = await getIntegrationStatus({
      clientKey: clientName,
      masterSheetId,
      tool: accountingTool
    });
  }

  let crmStatus = { connected: false, tool: crmTool };
  if (isOAuthTool(crmTool)) {
    crmStatus = await getIntegrationStatus({
      clientKey: clientName,
      masterSheetId,
      tool: crmTool
    });
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
      tool: crmTool.toLowerCase(),
      name: crmTool,
      type: "crm",
      connected: Boolean(crmStatus.connected)
    });
  }

  const allRequiredToolsConnected = requiredOAuthTools.length === 0 || requiredOAuthTools.every(t => t.connected);

  const fullConfig = {
    clientName,
    masterSheetId: masterSheetId || config?.masterSheetId || "",
    setupMode,
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

/**
 * Saves client setup configuration to Redis and persists tool choices to Master Sheet KeyInfo.
 */
export async function saveClientSetupConfig({
  clientName,
  masterSheetId,
  setupMode,
  requestConnections,
  accountingTool,
  crmTool,
  crmDrives,
  updatedBy
}) {
  if (!clientName) throw new Error("Missing clientName parameter.");

  const redisKey = getSetupRedisKey(clientName);
  const now = new Date().toISOString();

  const record = {
    clientName,
    masterSheetId: masterSheetId || "",
    setupMode: Boolean(setupMode),
    requestConnections: Boolean(requestConnections),
    accountingTool: accountingTool || "None",
    crmTool: crmTool || "None",
    crmDrives: crmDrives || "NA",
    updatedAt: now,
    updatedBy: updatedBy || "Admin"
  };

  // 1. Persist to Redis
  try {
    await redisClient.set(redisKey, JSON.stringify(record));
  } catch (err) {
    console.error(`Error writing setup config to Redis for ${clientName}:`, err);
    throw err;
  }

  // 2. Persist tool selections to Master Sheet KeyInfo!Q4, Q8, Q9
  if (masterSheetId) {
    try {
      const sheets = await getSheetsClient();
      await withRetry(() =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: masterSheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: [
              { range: "KeyInfo!Q4", values: [[record.accountingTool]] },
              { range: "KeyInfo!Q8", values: [[record.crmTool]] },
              { range: "KeyInfo!Q9", values: [[record.crmDrives]] }
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

  // 3. Update ClientSetupOverview in Automation Commander
  try {
    const sheets = await getSheetsClient();
    if (!record.setupMode) {
      await updateClientSetupOverviewRow(sheets, {
        clientName,
        status: "LIVE",
        progressPercent: 100,
        completedTasks: 34,
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
export async function getClientSetupStatusForPortal({ clientName, masterSheetId }) {
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

  // If no Redis config or missing tool selections, attempt reading KeyInfo!Q4:Q9
  let accountingTool = config?.accountingTool || "None";
  let crmTool = config?.crmTool || "None";

  if ((accountingTool === "None" || crmTool === "None") && masterSheetId) {
    try {
      const sheets = await getSheetsClient();
      const res = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: masterSheetId,
          range: "KeyInfo!Q4:Q9"
        })
      );
      const rows = res.data.values || [];
      const sheetQ4 = (rows[0] && rows[0][0]) ? String(rows[0][0]).trim() : "None";
      const sheetQ8 = (rows[4] && rows[4][0]) ? String(rows[4][0]).trim() : "None";
      if (accountingTool === "None" && sheetQ4 !== "None") accountingTool = sheetQ4;
      if (crmTool === "None" && sheetQ8 !== "None") crmTool = sheetQ8;

      // Cache back to Redis so we don't hit Google Sheets API repeatedly
      if (!config) {
        config = {
          clientName,
          masterSheetId,
          setupMode: false,
          requestConnections: false,
          accountingTool,
          crmTool,
          crmDrives: (rows[5] && rows[5][0]) ? String(rows[5][0]).trim() : "NA",
          updatedAt: new Date().toISOString()
        };
        await redisClient.set(redisKey, JSON.stringify(config)).catch(() => {});
      }
    } catch (sheetErr) {
      // Non-fatal sheet read note
    }
  }

  const setupMode = config?.setupMode === true;
  const requestConnections = config?.requestConnections === true;

  // Evaluate configured tools and connection health
  const configuredTools = [];

  const checkTool = async (toolName, type) => {
    if (!isOAuthTool(toolName)) return;
    const cleanTool = toolName.toLowerCase();
    const status = await getIntegrationStatus({
      clientKey: clientName,
      masterSheetId,
      tool: cleanTool
    });

    const isConnected = Boolean(status.connected);
    const needsReconnect = !isConnected || status.status === "reconnect_required" || Boolean(status.reconnectRequired);

    configuredTools.push({
      tool: cleanTool,
      name: toolName,
      type,
      connected: isConnected,
      needsReconnect,
      status: status.status || (isConnected ? "connected" : "disconnected"),
      tenantName: status.tenantName || status.companyName || ""
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
  const allToolsConnected = configuredTools.length === 0 || unconnectedTools.length === 0;
  const hasDisconnectedTools = configuredTools.some(t => !t.connected || t.needsReconnect);

  return {
    setupMode,
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

      for (const c of clients) {
        if (!c.clientName || !c.masterSheetId) continue;
        const redisKey = getSetupRedisKey(c.clientName);
        let config = null;
        try {
          const raw = await redisClient.get(redisKey);
          if (raw) config = JSON.parse(raw);
        } catch {}

        const lastSynced = config?.sheetSyncedAt ? new Date(config.sheetSyncedAt).getTime() : 0;
        const isStale = (now - lastSynced) > ONE_HOUR;

        if (isStale) {
          try {
            const sheets = await getSheetsClient();
            const res = await withRetry(() =>
              sheets.spreadsheets.values.get({
                spreadsheetId: c.masterSheetId,
                range: "KeyInfo!Q4:Q9"
              })
            );
            const rows = res.data.values || [];
            const sheetQ4 = (rows[0] && rows[0][0]) ? String(rows[0][0]).trim() : "None";
            const sheetQ8 = (rows[4] && rows[4][0]) ? String(rows[4][0]).trim() : "None";
            const sheetQ9 = (rows[5] && rows[5][0]) ? String(rows[5][0]).trim() : "NA";

            if (sheetQ4 !== config?.accountingTool || sheetQ8 !== config?.crmTool || sheetQ9 !== config?.crmDrives) {
              console.log(`🔄 Setup Background Sync: Updated tools for "${c.clientName}" in Redis: Acc=${sheetQ4}, CRM=${sheetQ8}`);
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
              sheetSyncedAt: new Date().toISOString(),
              updatedAt: config?.updatedAt || new Date().toISOString()
            };
            await redisClient.set(redisKey, JSON.stringify(updatedRecord));
          } catch (syncErr) {
            // Ignore background revalidation errors for individual clients
          }
        }
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
 * Ensure ClientSetupOverview and ClientSetupTasks tabs exist on Automation Commander.
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
    }
    setupTabsVerified = true;
  } catch (err) {
    console.warn("⚠️ ensureClientSetupTabs error:", err.message);
  }
}

/**
 * Returns setup overview for all clients (for the Setup screen main table).
 */
export async function getAllClientsSetupOverview(sheets, sessionUser, allOutgoingsClients = []) {
  await ensureClientSetupTabs(sheets);

  const acId = DEFAULT_AC_SHEET_ID;
  let overviewRows = [];
  try {
    const res = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: `${CLIENT_SETUP_OVERVIEW_TAB}!A2:L500`
      })
    );
    overviewRows = res.data.values || [];
  } catch (err) {
    console.warn("Warning reading ClientSetupOverview:", err.message);
  }

  const overviewMap = new Map();
  for (const r of overviewRows) {
    const name = String(r[0] || "").trim();
    if (name) {
      overviewMap.set(name.toLowerCase(), {
        clientName: name,
        status: String(r[1] || "LIVE").trim(),
        progressPercent: parseInt(String(r[2] || "100").replace(/[^0-9]/g, ""), 10) || 100,
        completedTasks: parseInt(String(r[3] || "34"), 10) || 34,
        totalTasks: parseInt(String(r[4] || "34"), 10) || 34,
        startedAt: r[5] || "",
        completedAt: r[6] || "",
        driveFolderUrl: r[7] || "",
        clientSheetUrl: r[8] || "",
        masterSheetUrl: r[9] || "",
        reconSheetUrl: r[10] || "",
        backupSheetUrl: r[11] || ""
      });
    }
  }

  const results = [];
  for (const c of allOutgoingsClients) {
    if (!c.clientName) continue;
    if (sessionUser && !isUserAuthorizedForClient(sessionUser, c.clientName)) {
      continue;
    }

    const redisKey = getSetupRedisKey(c.clientName);
    let cached = null;
    try {
      const raw = await redisClient.get(redisKey);
      if (raw) cached = JSON.parse(raw);
    } catch {}

    const setupMode = cached?.setupMode === true;
    const accountingTool = cached?.accountingTool || "None";
    const crmTool = cached?.crmTool || "None";

    const overview = overviewMap.get(c.clientName.toLowerCase());

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
      status,
      progressPercent,
      completedTasks,
      totalTasks: 34,
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

/**
 * Returns full checklist state for a specific client (the 5 phases, tasks, completion status, metadata).
 */
export async function getClientChecklistState(sheets, clientName, masterSheetId) {
  if (!clientName) throw new Error("Missing clientName");
  await ensureClientSetupTabs(sheets);

  const acId = DEFAULT_AC_SHEET_ID;
  const checklistRedisKey = getChecklistRedisKey(clientName);

  let taskStatusMap = new Map();

  // Try Redis first
  try {
    const raw = await redisClient.get(checklistRedisKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach(t => taskStatusMap.set(t.taskId, t));
      }
    }
  } catch (err) {
    console.warn("Redis checklist cache read error:", err.message);
  }

  // If not cached, query ClientSetupTasks tab on AC
  if (taskStatusMap.size === 0) {
    try {
      const res = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: acId,
          range: `${CLIENT_SETUP_TASKS_TAB}!A2:H5000`
        })
      );
      const rows = res.data.values || [];
      const clientRows = rows.filter(r => String(r[0] || "").trim().toLowerCase() === clientName.toLowerCase());

      for (const r of clientRows) {
        const taskId = String(r[2] || "").trim();
        if (taskId) {
          taskStatusMap.set(taskId, {
            taskId,
            phaseId: r[1] || "",
            isCompleted: String(r[4] || "").toUpperCase() === "TRUE",
            completedAt: r[5] || "",
            completedBy: r[6] || "",
            metadata: r[7] || ""
          });
        }
      }
    } catch (err) {
      console.warn("Error reading ClientSetupTasks from AC:", err.message);
    }
  }

  // Check live setup config & tool status from Vault for auto-completable tasks
  const config = await getClientSetupConfig({ clientName, masterSheetId }).catch(() => null);

  // Auto-complete tool connections if connected in Vault
  if (config?.accountingStatus?.connected && taskStatusMap.has("p2_connect_accounting")) {
    const t = taskStatusMap.get("p2_connect_accounting");
    t.isCompleted = true;
    t.metadata = `${config.accountingTool} Connected`;
  }
  if (config?.crmStatus?.connected && taskStatusMap.has("p2_connect_crm")) {
    const t = taskStatusMap.get("p2_connect_crm");
    t.isCompleted = true;
    t.metadata = `${config.crmTool} Connected`;
  }

  // Build full phase structure
  let totalTasks = SETUP_TASKS_CATALOG.length;
  let completedCount = 0;

  const phases = SETUP_PHASES.map(phase => {
    const tasksInPhase = SETUP_TASKS_CATALOG.filter(t => t.phaseId === phase.id);
    let phaseCompleted = 0;

    const tasks = tasksInPhase.map(catalogTask => {
      const recorded = taskStatusMap.get(catalogTask.id);
      const isCompleted = recorded ? Boolean(recorded.isCompleted) : false;
      if (isCompleted) {
        completedCount++;
        phaseCompleted++;
      }
      return {
        id: catalogTask.id,
        phaseId: catalogTask.phaseId,
        title: catalogTask.title,
        autoCompletable: Boolean(catalogTask.autoCompletable),
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
      isPhaseComplete: phaseCompleted === tasks.length,
      tasks
    };
  });

  const progressPercent = Math.round((completedCount / totalTasks) * 100);

  // Fetch Master Sheet KeyInfo parameters if masterSheetId provided
  let keyInfoSettings = null;
  if (masterSheetId) {
    keyInfoSettings = await getMasterKeyInfoSettings(sheets, masterSheetId).catch(() => null);
  }

  // Cache back to Redis
  const flatTaskList = [];
  phases.forEach(p => p.tasks.forEach(t => flatTaskList.push({ taskId: t.id, ...t })));
  await redisClient.set(checklistRedisKey, JSON.stringify(flatTaskList), { EX: 86400 }).catch(() => {});

  return {
    clientName,
    setupMode: Boolean(config?.setupMode),
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
  await ensureClientSetupTabs(sheets);

  const acId = DEFAULT_AC_SHEET_ID;
  const now = new Date().toISOString();
  const catalogItem = SETUP_TASKS_CATALOG.find(t => t.id === taskId);
  const phaseId = catalogItem?.phaseId || "";
  const taskTitle = catalogItem?.title || taskId;

  // 1. Read existing rows in ClientSetupTasks
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
    clientName,
    phaseId,
    taskId,
    taskTitle,
    isCompleted ? "TRUE" : "FALSE",
    isCompleted ? now : "",
    userEmail || "Admin",
    metadata || ""
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

  // 2. Invalidate checklist cache
  await redisClient.del(getChecklistRedisKey(clientName)).catch(() => {});

  // 3. Log activity
  logPmaActivity({
    action: isCompleted ? "setup_task_completed" : "setup_task_uncompleted",
    details: `${isCompleted ? "Completed" : "Unchecked"} task "${taskTitle}" for ${clientName}`,
    clientName,
    userEmail: userEmail || "Admin"
  }).catch(() => {});

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
 * Updates status, progress percent, completed tasks, or completedAt in ClientSetupOverview.
 */
export async function updateClientSetupOverviewRow(sheets, { clientName, status, progressPercent, completedTasks, completedAt }) {
  if (!clientName) return;
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
    sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "KeyInfo!A1:X29"
    })
  );
  const rows = res.data.values || [];

  const getCell = (r, c) => (rows[r - 1] && rows[r - 1][c - 1] !== undefined ? String(rows[r - 1][c - 1]).trim() : "");

  return {
    startDate: getCell(2, 2),        // B2: Tracker start date
    vatQuarters: getCell(6, 2),      // B6: VAT quarters
    vatMonths: getCell(7, 2),        // B7: VAT payment months
    vatScheme: getCell(8, 2),        // B8: VAT payment scheme
    vatRate: getCell(9, 2),          // B9: VAT rate
    payeCycle: getCell(12, 2),       // B12: PAYE cycle
    payeQuarterMonths: getCell(13, 2), // B13: PAYE quarterly months
    revenueFocus: getCell(15, 2),    // B15: Revenue or income focus
    profitShare: getCell(11, 6),     // F11: Profit share %
    contractorMethod: getCell(20, 2),// B20: Cashflow contractors method
    masterDeploymentUrl: getCell(29, 24) // X29: Master deployment URL
  };
}

/**
 * Saves core KeyInfo financial parameters to Master Sheet and marks task complete.
 */
export async function saveMasterKeyInfoSettings(sheets, { masterSheetId, clientName, settings, userEmail }) {
  if (!masterSheetId) throw new Error("Missing masterSheetId");

  const updates = [];
  if (settings.startDate !== undefined) updates.push({ range: "KeyInfo!B2", values: [[settings.startDate]] });
  if (settings.vatQuarters !== undefined) updates.push({ range: "KeyInfo!B6", values: [[settings.vatQuarters]] });
  if (settings.vatMonths !== undefined) updates.push({ range: "KeyInfo!B7", values: [[settings.vatMonths]] });
  if (settings.vatScheme !== undefined) updates.push({ range: "KeyInfo!B8", values: [[settings.vatScheme]] });
  if (settings.vatRate !== undefined) updates.push({ range: "KeyInfo!B9", values: [[settings.vatRate]] });
  if (settings.payeCycle !== undefined) updates.push({ range: "KeyInfo!B12", values: [[settings.payeCycle]] });
  if (settings.revenueFocus !== undefined) updates.push({ range: "KeyInfo!B15", values: [[settings.revenueFocus]] });
  if (settings.profitShare !== undefined) updates.push({ range: "KeyInfo!F11", values: [[settings.profitShare]] });
  if (settings.contractorMethod !== undefined) updates.push({ range: "KeyInfo!B20", values: [[settings.contractorMethod]] });

  if (updates.length > 0) {
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: masterSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updates
        }
      })
    );
  }

  // Auto-mark task p2_keyinfo_settings as completed
  if (clientName) {
    await updateClientChecklistTask(sheets, {
      clientName,
      taskId: "p2_keyinfo_settings",
      isCompleted: true,
      metadata: "Configured via PMA Settings Form",
      userEmail
    });
  }

  logPmaActivity({
    action: "master_keyinfo_settings_updated",
    details: `Updated Master Sheet KeyInfo financial parameters for ${clientName}`,
    clientName,
    userEmail: userEmail || "Admin"
  }).catch(() => {});

  return await getMasterKeyInfoSettings(sheets, masterSheetId);
}

/**
 * Saves Script IDs directly into Columns R, S, T of the Client Version Tracker sheet.
 */
export async function saveScriptIdsToTracker(sheets, { clientName, clientScriptId, masterScriptId, reconScriptId, userEmail }) {
  if (!clientName) throw new Error("Missing clientName");

  const trackerRes = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: TRACKER_SHEET_ID,
      range: "Clients!A1:A100"
    })
  );
  const rows = trackerRes.data.values || [];
  const targetRowIdx = rows.findIndex(r => String(r[0] || "").trim().toLowerCase() === clientName.toLowerCase());

  if (targetRowIdx === -1) {
    throw new Error(`Client "${clientName}" not found in Column A of Clients tracker sheet.`);
  }

  const rowNum = targetRowIdx + 1;

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `Clients!R${rowNum}:T${rowNum}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[clientScriptId || "", masterScriptId || "", reconScriptId || ""]]
      }
    })
  );

  // Auto-mark task p1_script_ids as complete
  await updateClientChecklistTask(sheets, {
    clientName,
    taskId: "p1_script_ids",
    isCompleted: true,
    metadata: `Client: ${clientScriptId || "NA"} | Master: ${masterScriptId || "NA"} | Recon: ${reconScriptId || "NA"}`,
    userEmail
  });

  logPmaActivity({
    action: "setup_script_ids_saved",
    details: `Saved Script IDs into Client Version Tracker row ${rowNum} for ${clientName}`,
    clientName,
    userEmail: userEmail || "Admin"
  }).catch(() => {});

  return { success: true, rowNum };
}

/**
 * Saves Master Sheet Deployment URL to KeyInfo!X29 and Column W of Client Version Tracker.
 */
export async function saveDeploymentUrl(sheets, { clientName, masterSheetId, deploymentUrl, userEmail }) {
  if (!clientName || !deploymentUrl) throw new Error("Missing clientName or deploymentUrl");

  // 1. Write to Master Sheet KeyInfo!X29
  if (masterSheetId) {
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: masterSheetId,
        range: "KeyInfo!X29",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[deploymentUrl]] }
      })
    );
  }

  // 2. Write to Column W of Clients Version Tracker
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
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[deploymentUrl]] }
      })
    );
  }

  // 3. Mark task p1_gas_deployment as complete
  await updateClientChecklistTask(sheets, {
    clientName,
    taskId: "p1_gas_deployment",
    isCompleted: true,
    metadata: deploymentUrl,
    userEmail
  });

  logPmaActivity({
    action: "setup_deployment_url_saved",
    details: `Saved Master GAS deployment URL for ${clientName}`,
    clientName,
    userEmail: userEmail || "Admin"
  }).catch(() => {});

  return { success: true };
}

/**
 * ============================================================================
 * FULL CLIENT PROVISIONING ENGINE (DRIVE + SHEETS + MULTI-REGISTRY ENROLLMENT)
 * ============================================================================
 */
export async function provisionNewClientSystem({
  clientName,
  accountingTool = "None",
  crmTool = "None",
  crmDrives = "NA",
  targetParentFolderId = DEFAULT_CLIENTS_FOLDER_ID,
  userEmail = "Admin"
}) {
  if (!clientName || !clientName.trim()) {
    throw new Error("Client name is required");
  }

  const cleanClientName = clientName.trim();
  const drive = await getDriveClient();
  const sheets = await getSheetsClient();
  await ensureClientSetupTabs(sheets);

  console.log(`🚀 Starting Provisioning for new client: "${cleanClientName}"...`);

  // 1. Get Template IDs from Row 3 of Clients Tracker sheet
  const templateRowRes = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: TRACKER_SHEET_ID,
      range: "Clients!A3:N3"
    })
  );
  const templateRow = (templateRowRes.data.values || [[]])[0];
  const clientTemplateUrl = templateRow[11] || ""; // Col L
  const masterTemplateUrl = templateRow[12] || ""; // Col M
  const reconTemplateUrl = templateRow[13] || "";  // Col N

  const clientTemplateId = extractSheetIdFromUrl(clientTemplateUrl);
  const masterTemplateId = extractSheetIdFromUrl(masterTemplateUrl);
  const reconTemplateId = extractSheetIdFromUrl(reconTemplateUrl);

  if (!clientTemplateId || !masterTemplateId || !reconTemplateId) {
    throw new Error("Missing template URLs in Row 3 of Clients Version Tracker (Columns L, M, N).");
  }

  // 2. Create Destination Folder in Google Drive
  console.log(`  📁 Creating Drive folder "${cleanClientName}" inside parent "${targetParentFolderId}"...`);
  const folderRes = await drive.files.create({
    requestBody: {
      name: cleanClientName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [targetParentFolderId]
    },
    fields: "id, name, webViewLink"
  });
  const folderId = folderRes.data.id;
  const folderUrl = folderRes.data.webViewLink || `https://drive.google.com/drive/folders/${folderId}`;

  // 3. Duplicate Templates into the New Folder
  console.log(`  📋 Copying Client, Master, Recon templates & creating backup sheet...`);
  const [clientCopy, masterCopy, reconCopy, backupCopy] = await Promise.all([
    drive.files.copy({
      fileId: clientTemplateId,
      requestBody: {
        name: `${cleanClientName} Agency Management Dashboard`,
        parents: [folderId]
      },
      fields: "id, name, webViewLink"
    }),
    drive.files.copy({
      fileId: masterTemplateId,
      requestBody: {
        name: `AMD ${cleanClientName} master`,
        parents: [folderId]
      },
      fields: "id, name, webViewLink"
    }),
    drive.files.copy({
      fileId: reconTemplateId,
      requestBody: {
        name: `Recon ${cleanClientName}`,
        parents: [folderId]
      },
      fields: "id, name, webViewLink"
    }),
    drive.files.create({
      requestBody: {
        name: `${cleanClientName} backup sheet`,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [folderId]
      },
      fields: "id, name, webViewLink"
    })
  ]);

  const clientUrl = clientCopy.data.webViewLink || `https://docs.google.com/spreadsheets/d/${clientCopy.data.id}/edit`;
  const masterUrl = masterCopy.data.webViewLink || `https://docs.google.com/spreadsheets/d/${masterCopy.data.id}/edit`;
  const reconUrl = reconCopy.data.webViewLink || `https://docs.google.com/spreadsheets/d/${reconCopy.data.id}/edit`;
  const backupUrl = backupCopy.data.webViewLink || `https://docs.google.com/spreadsheets/d/${backupCopy.data.id}/edit`;

  // 4. Grant Editor Permissions
  const emailsToShare = [
    "pulse@pulsedashboard.co.uk",
    "alert-triage-backend@automation-commander.iam.gserviceaccount.com"
  ];
  for (const fileId of [clientCopy.data.id, masterCopy.data.id, reconCopy.data.id, backupCopy.data.id]) {
    for (const email of emailsToShare) {
      drive.permissions.create({
        fileId,
        requestBody: { role: "writer", type: "user", emailAddress: email },
        sendNotificationEmail: false
      }).catch(err => console.warn(`Share note for ${email}:`, err.message));
    }
  }

  // 5. Update KeyInfo Tabs Across Sheets
  console.log(`  🔗 Linking KeyInfo tabs across Master, Recon, and Client sheets...`);
  await Promise.all([
    // Master Sheet KeyInfo
    withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: masterCopy.data.id,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: [
            { range: "KeyInfo!B1", values: [[cleanClientName]] },
            { range: "KeyInfo!C1", values: [[clientUrl]] },
            { range: "KeyInfo!D1", values: [[masterUrl]] },
            { range: "KeyInfo!G1", values: [[reconUrl]] },
            { range: "KeyInfo!Q4", values: [[accountingTool || "None"]] },
            { range: "KeyInfo!Q8", values: [[crmTool || "None"]] },
            { range: "KeyInfo!Q9", values: [[crmDrives || "NA"]] }
          ]
        }
      })
    ).catch(e => console.warn("Master KeyInfo update note:", e.message)),

    // Recon Sheet KeyInfo
    withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: reconCopy.data.id,
        range: "KeyInfo!D1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[masterUrl]] }
      })
    ).catch(e => console.warn("Recon KeyInfo update note:", e.message)),

    // Client Sheet KeyInfo
    withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientCopy.data.id,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: [
            { range: "KeyInfo!C1", values: [[clientUrl]] },
            { range: "KeyInfo!D1", values: [[masterUrl]] }
          ]
        }
      })
    ).catch(e => console.warn("Client KeyInfo update note:", e.message))
  ]);

  // 6. Enroll in Clients Version Tracker
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

  // 9. Seed Overview & Tasks in Automation Commander
  console.log(`  🎯 Seeding ClientSetupOverview & ClientSetupTasks...`);
  const now = new Date().toISOString();
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: DEFAULT_AC_SHEET_ID,
      range: `${CLIENT_SETUP_OVERVIEW_TAB}!A:L`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          cleanClientName, "IN_PROGRESS", "15%", "5", "34", now, "",
          folderUrl, clientUrl, masterUrl, reconUrl, backupUrl
        ]]
      }
    });

    const initialTaskRows = SETUP_TASKS_CATALOG.map(t => {
      const isAutoDone = [
        "p1_drive_folder",
        "p1_duplicate_templates",
        "p2_select_tools",
        "p4_ac_enrollment",
        "p4_rep_control",
        "p4_eom_jobs"
      ].includes(t.id);

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

    // 9b. Seed Default EoM Tasks for this client into EomClientTasks
    console.log(`  📋 Seeding Default EoM tasks for "${cleanClientName}"...`);
    try {
      const { applyDefaultEomTasksToClient_ } = await import("./eomTools");
      await applyDefaultEomTasksToClient_(sheets, DEFAULT_AC_SHEET_ID, cleanClientName);
    } catch (eomSeedErr) {
      console.warn("EoM default tasks seed note:", eomSeedErr.message);
    }
  } catch (seedErr) {
    console.warn("Setup tabs seed note:", seedErr.message);
  }

  // 10. Persist to Redis
  const setupConfigRecord = {
    clientName: cleanClientName,
    masterSheetId: masterCopy.data.id,
    clientSheetId: clientCopy.data.id,
    setupMode: true,
    requestConnections: false,
    accountingTool,
    crmTool,
    crmDrives,
    folderUrl,
    clientUrl,
    masterUrl,
    reconUrl,
    backupUrl,
    updatedAt: now,
    updatedBy: userEmail
  };
  await redisClient.set(getSetupRedisKey(cleanClientName), JSON.stringify(setupConfigRecord)).catch(() => {});
  await redisClient.del(getChecklistRedisKey(cleanClientName)).catch(() => {});

  logPmaActivity({
    action: "client_provisioned",
    details: `Successfully provisioned new client "${cleanClientName}" with folder & sheets`,
    clientName: cleanClientName,
    userEmail
  }).catch(() => {});

  console.log(`✅ Client "${cleanClientName}" successfully provisioned!`);

  return {
    success: true,
    clientName: cleanClientName,
    folderUrl,
    clientUrl,
    masterUrl,
    reconUrl,
    backupUrl,
    clientSheetId: clientCopy.data.id,
    masterSheetId: masterCopy.data.id,
    reconSheetId: reconCopy.data.id
  };
}

