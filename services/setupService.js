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
import { getSheetsClient, withRetry } from "./sheetsClient.js";

function normalizeKey(str) {
  return String(str || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function getSetupRedisKey(clientName) {
  return `pulse:setup:${normalizeKey(clientName)}`;
}

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
export async function getClientSetupConfig({ clientName, masterSheetId }) {
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

  // If not cached in Redis or missing sheet fields, read Master Sheet KeyInfo!Q4:Q9
  let sheetQ4 = "None";
  let sheetQ8 = "None";
  let sheetQ9 = "NA";

  if (masterSheetId) {
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
