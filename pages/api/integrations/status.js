/**
 * ============================================================================
 * INTEGRATIONS STATUS ROUTE: /api/integrations/status
 * ============================================================================
 * 
 * Returns non-sensitive integration health and connection status.
 * Supports:
 * - ?all=true: Returns all clients in exact AutoUpdates order with their
 *   configured Accounting tool and CRM tool from KeyInfo, plus live Vault statuses.
 * - Single client mode: ?clientKey=...&masterSheetId=... for individual client status.
 */

import { getIntegrationStatus, getSharedXeroGrant, INTEGRATIONS_STATUS_CACHE_KEY } from "../../../services/vaultService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import { DEFAULT_AC_SHEET_ID, matchesClientName, isUserAuthorizedForClient, resolveClientNameBySheetId, canAccessPma, installSheetIdBoundary } from "../../../services/userPermissions.js";
import { getClientSetupConfig, revalidateClientsSetupInBackground } from "../../../services/setupService.js";
import { getSessionUser } from "../../../services/authService.js";
import { redisClient } from "../../../services/redisClient.js";

let _allIntegrationsStatusCache = null;
let _allIntegrationsStatusCachedAt = 0;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sessionUser = getSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ error: "Active session required." });
  }
  installSheetIdBoundary(req, res, sessionUser);

  const { all, clientKey, clientName, masterSheetId, refresh, force } = req.query;
  const forceRefresh = refresh === "true" || force === "true";

  // Mode 1: All Clients Status (for the new Multi-Client Integrations page)
  if (all === "true" || all === "1") {
    if (!canAccessPma(sessionUser)) {
      return res.status(403).json({ error: "Access denied: PMA privileges required." });
    }

    const now = Date.now();
    const cacheKey = INTEGRATIONS_STATUS_CACHE_KEY;

    if (forceRefresh) {
      _allIntegrationsStatusCache = null;
      _allIntegrationsStatusCachedAt = 0;
      if (redisClient?.isOpen) {
        try { await redisClient.del(cacheKey); } catch (e) {}
      }
    } else {
      let cachedData = null;
      if (redisClient?.isOpen) {
        try {
          const raw = await redisClient.get(cacheKey);
          if (raw) {
            cachedData = JSON.parse(raw);
            _allIntegrationsStatusCache = cachedData;
            _allIntegrationsStatusCachedAt = now;
          } else {
            // Redis key is deleted (invalidated) -> purge in-memory cache
            _allIntegrationsStatusCache = null;
            _allIntegrationsStatusCachedAt = 0;
          }
        } catch (e) {}
      } else if (_allIntegrationsStatusCache && (now - _allIntegrationsStatusCachedAt < 300000)) {
        cachedData = _allIntegrationsStatusCache;
      }

      if (cachedData) {
        let scopedClients = cachedData.allClients || [];
        if (!sessionUser.isAdmin && sessionUser.assignedClients !== "*") {
          const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
          scopedClients = scopedClients.filter(c => assignedList.some(assigned => matchesClientName(assigned, c.clientName)));
        }
        let attentionCount = 0;
        for (const c of scopedClients) {
          const accTool = String(c.accountingTool || "").toLowerCase();
          const crmTool = String(c.crmTool || "").toLowerCase();
          if (c.integrations?.[accTool]?.reconnectRequired) attentionCount++;
          if (c.integrations?.[crmTool]?.reconnectRequired) attentionCount++;
        }
        if (cachedData.sharedXero?.reconnectRequired) attentionCount++;

        const scopedSharedXero = cachedData.sharedXero
          ? {
              ...cachedData.sharedXero,
              availableTenants: sessionUser.isAdmin ? (cachedData.sharedXero.availableTenants || []) : []
            }
          : null;

        return res.status(200).json({
          success: true,
          allClients: scopedClients,
          sharedXero: scopedSharedXero,
          attentionCount
        });
      }
    }

function evaluateAutomationHealth({ frequency, isRunning, lastCommandTime, signalFeedback, lastRunEndTime, summary }) {
  const freq = String(frequency || "").trim();
  const running = Boolean(isRunning);
  const feedback = String(signalFeedback || "").trim();
  const sum = String(summary || "").trim();
  const lastCmd = String(lastCommandTime || "").trim();
  const lastEnd = String(lastRunEndTime || "").trim();

  const isFailureFeedback = feedback.toLowerCase().includes("fail") || feedback.toLowerCase().includes("error") || feedback.startsWith("Flag:");
  const isFailureSummary = sum.toLowerCase().includes("failure") || sum.toLowerCase().includes("error");

  let status = "inactive";
  let statusLabel = "Not scheduled";

  if (isFailureFeedback || isFailureSummary) {
    status = "error";
    statusLabel = "Attention required";
  } else if (running) {
    status = "running";
    statusLabel = "Sequence running";
  } else if (feedback.includes("OK") || (sum && !isFailureSummary) || lastEnd) {
    status = "healthy";
    statusLabel = "Sequences running successfully";
  } else if (!freq || freq === "-" || freq.toLowerCase() === "none") {
    status = "inactive";
    statusLabel = "Not scheduled";
  } else if (lastCmd) {
    status = "pending";
    statusLabel = "Signal sent (pending run)";
  }

  return {
    status,
    statusLabel,
    frequency: freq || "None",
    isRunning: running,
    lastCommandTime: lastCmd,
    signalFeedback: feedback,
    lastRunEndTime: lastEnd,
    summary: sum
  };
}

    try {
      const sheets = await getSheetsClient();
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: DEFAULT_AC_SHEET_ID,
        range: "AutoUpdates!A2:AJ500"
      });
      const rows = resp.data.values || [];
      let clients = rows
        .map((r, idx) => {
          const clientName = String(r[0] || "").trim();
          const clientSheetId = extractSheetIdFromUrl(r[11]) || String(r[11] || "").trim();
          const masterSheetId = extractSheetIdFromUrl(r[12]) || String(r[12] || "").trim();

          const crmAuto = evaluateAutomationHealth({
            frequency: r[15],
            isRunning: String(r[20] || "").trim().toUpperCase() === "YES",
            lastCommandTime: r[27],
            signalFeedback: r[28],
            lastRunEndTime: r[29],
            summary: r[30]
          });

          const accAuto = evaluateAutomationHealth({
            frequency: r[14],
            isRunning: String(r[19] || "").trim().toUpperCase() === "YES",
            lastCommandTime: r[22],
            signalFeedback: r[23],
            lastRunEndTime: r[24],
            summary: r[25]
          });

          return {
            clientName,
            clientSheetId,
            masterSheetId,
            autoUpdatesRow: idx + 2,
            crmAuto,
            accAuto
          };
        })
        .filter(c => c.clientName && c.clientName.toLowerCase() !== "client" && c.clientName.toLowerCase() !== "client name" && c.masterSheetId);

      // Respect user permissions
      const isGlobalScope = Boolean(sessionUser.isAdmin || sessionUser.assignedClients === "*");
      if (!isGlobalScope) {
        const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
        clients = clients.filter(c => assignedList.some(assigned => matchesClientName(assigned, c.clientName)));
      }

      const ALL_TOOLS = ["xero", "quickbooks", "monday", "pipedrive", "clickup", "capsule", "close", "hubspot", "googlesheet", "excel"];

      // Fetch configs and integration statuses for each client in exact AutoUpdates order
      const clientConfigs = await Promise.all(
        clients.map(async (c) => {
          try {
            const [cfg, ...toolStatuses] = await Promise.all([
              getClientSetupConfig({ clientName: c.clientName, masterSheetId: c.masterSheetId, forceSheetSync: forceRefresh }),
              ...ALL_TOOLS.map(tool => getIntegrationStatus({
                clientKey: c.clientName,
                masterSheetId: c.masterSheetId,
                tool
              }))
            ]);

            const integrations = {};
            ALL_TOOLS.forEach((tool, idx) => {
              integrations[tool] = toolStatuses[idx] || { connected: false, tool };
            });

            const crmToolClean = String(cfg.crmTool || "").toLowerCase();
            const crmKey = crmToolClean.includes("sheet") ? "googlesheet" : crmToolClean.includes("excel") ? "excel" : crmToolClean;
            let crmStatus = integrations[crmKey] || { connected: false, tool: cfg.crmTool };
            if (!crmStatus.connected && cfg.crmStatus?.connected) {
              crmStatus = cfg.crmStatus;
              integrations[crmKey] = crmStatus;
            }

            return {
              clientName: c.clientName,
              clientSheetId: c.clientSheetId,
              masterSheetId: c.masterSheetId,
              autoUpdatesRow: c.autoUpdatesRow,
              rowNumber: c.autoUpdatesRow,
              accountingTool: cfg.accountingTool || "None",
              accountingStatus: integrations[String(cfg.accountingTool || "").toLowerCase()] || { connected: false, tool: cfg.accountingTool },
              crmTool: cfg.crmTool || "None",
              crmStatus,
              crmDrives: cfg.crmDrives || "NA",
              setupMode: Boolean(cfg.setupMode),
              isSetupMode: Boolean(cfg.setupMode),
              requestConnections: Boolean(cfg.requestConnections),
              allRequiredToolsConnected: Boolean(cfg.allRequiredToolsConnected),
              integrations,
              automationHealth: {
                crm: c.crmAuto,
                accounting: c.accAuto
              }
            };
          } catch (cfgErr) {
            const integrations = {};
            for (const tool of ALL_TOOLS) {
              integrations[tool] = { connected: false, tool };
            }
            return {
              clientName: c.clientName,
              clientSheetId: c.clientSheetId,
              masterSheetId: c.masterSheetId,
              autoUpdatesRow: c.autoUpdatesRow,
              rowNumber: c.autoUpdatesRow,
              accountingTool: "None",
              accountingStatus: { connected: false },
              crmTool: "None",
              crmStatus: { connected: false },
              setupMode: false,
              isSetupMode: false,
              requestConnections: false,
              allRequiredToolsConnected: false,
              integrations,
              automationHealth: {
                crm: c.crmAuto,
                accounting: c.accAuto
              },
              error: cfgErr.message
            };
          }
        })
      );

      const sharedXeroRaw = await getSharedXeroGrant();
      const sharedXeroIsHealthy = Boolean(sharedXeroRaw && sharedXeroRaw.status === "connected" && !sharedXeroRaw.reconnectRequired);
      const sharedXero = sharedXeroRaw ? {
        connected: sharedXeroIsHealthy,
        status: sharedXeroIsHealthy ? "connected" : "reconnect_required",
        reconnectRequired: !sharedXeroIsHealthy,
        expiresAt: sharedXeroRaw.expiresAt,
        availableTenants: sharedXeroRaw.availableTenants || [],
        tenantCount: (sharedXeroRaw.availableTenants || []).length,
        lastRefreshedAt: sharedXeroRaw.lastRefreshedAt,
        updatedAt: sharedXeroRaw.updatedAt
      } : null;

      // Trigger non-blocking background revalidation for stale caches
      if (!forceRefresh) {
        revalidateClientsSetupInBackground(clients);
      }

      if (isGlobalScope) {
        if (redisClient?.isOpen) {
          try {
            await redisClient.set(cacheKey, JSON.stringify({ allClients: clientConfigs, sharedXero }), { EX: 86400 });
          } catch (e) {}
        }
        _allIntegrationsStatusCache = { allClients: clientConfigs, sharedXero };
        _allIntegrationsStatusCachedAt = now;
      }

      const scopedSharedXero = sharedXero
        ? {
            ...sharedXero,
            availableTenants: sessionUser.isAdmin ? (sharedXero.availableTenants || []) : []
          }
        : null;

      let attentionCount = 0;
      for (const c of clientConfigs) {
        const accTool = String(c.accountingTool || "").toLowerCase();
        const crmTool = String(c.crmTool || "").toLowerCase();
        if (c.integrations?.[accTool]?.reconnectRequired) attentionCount++;
        if (c.integrations?.[crmTool]?.reconnectRequired) attentionCount++;
      }
      if (sharedXero?.reconnectRequired) attentionCount++;

      return res.status(200).json({
        success: true,
        allClients: clientConfigs,
        sharedXero: scopedSharedXero,
        attentionCount
      });
    } catch (err) {
      console.error("Multi-client integrations status error:", err);
      return res.status(500).json({ error: err.message || "Failed to load multi-client integration statuses." });
    }
  }

  // Mode 2: Single Client Status (backwards compatible)
  if (!clientKey && !masterSheetId && !clientName) {
    return res.status(400).json({ error: "Missing clientKey, clientName, or masterSheetId parameter." });
  }

  let targetClient = clientName || clientKey;
  if (!targetClient && masterSheetId) {
    try {
      const sheets = await getSheetsClient();
      targetClient = await resolveClientNameBySheetId(sheets, masterSheetId);
    } catch (_) {}
  }

  if (!sessionUser.isAdmin) {
    if (!targetClient || !isUserAuthorizedForClient(sessionUser, targetClient)) {
      return res.status(403).json({ error: "Access denied to this client." });
    }
  }

  try {
    const tools = ["xero", "quickbooks", "monday", "pipedrive", "clickup", "capsule", "close", "hubspot", "googlesheet", "excel"];
    const statuses = {};

    for (const tool of tools) {
      const status = await getIntegrationStatus({
        clientKey: clientKey || clientName,
        masterSheetId,
        tool
      });
      statuses[tool] = status;
    }

    const sharedXeroRaw = await getSharedXeroGrant();
    const sharedXero = sharedXeroRaw ? {
      connected: sharedXeroRaw.status === "connected",
      status: sharedXeroRaw.status,
      reconnectRequired: sharedXeroRaw.status === "reconnect_required",
      expiresAt: sharedXeroRaw.expiresAt,
      availableTenants: sessionUser.isAdmin ? (sharedXeroRaw.availableTenants || []) : [],
      tenantCount: (sharedXeroRaw.availableTenants || []).length,
      lastRefreshedAt: sharedXeroRaw.lastRefreshedAt,
      updatedAt: sharedXeroRaw.updatedAt
    } : null;

    return res.status(200).json({
      success: true,
      integrations: statuses,
      sharedXero
    });
  } catch (err) {
    console.error("Integrations status query error:", err);
    return res.status(500).json({ error: err.message || "Failed to query integration status." });
  }
}
