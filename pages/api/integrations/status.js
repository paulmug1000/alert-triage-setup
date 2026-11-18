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
import { getSupabaseAdmin, isSupabaseConfigured, isSupabaseControlPlaneActive } from "../../../services/supabaseClient.js";
import { redisClient } from "../../../services/redisClient.js";

async function getExcludedClientNamesSet_() {
  const excluded = new Set();
  try {
    const sb = getSupabaseAdmin();
    if (!sb) return excluded;
    const { data: statusRows } = await sb
      .from("clients")
      .select("client_name, status, metadata");
    for (const c of (statusRows || [])) {
      const eff = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
      if (c.client_name && (eff === "inactive" || eff === "archived" || eff === "suspended")) {
        excluded.add(String(c.client_name).trim().toLowerCase());
      }
    }
  } catch (_) { }
  return excluded;
}

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
  const forceRefresh = (refresh === "true" || force === "true") && Boolean(sessionUser.isAdmin);

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
        try { await redisClient.del(cacheKey); } catch (e) { }
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
        } catch (e) { }
      } else if (_allIntegrationsStatusCache && (now - _allIntegrationsStatusCachedAt < 300000)) {
        cachedData = _allIntegrationsStatusCache;
      }

      if (cachedData) {
        const excludedClientNamesSet = await getExcludedClientNamesSet_();
        let scopedClients = (cachedData.allClients || []).filter(
          c => !excludedClientNamesSet.has(String(c?.clientName || "").trim().toLowerCase())
        );
        if (!sessionUser.isAdmin) {
          const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
          scopedClients = scopedClients
            .filter(c => assignedList.some(assigned => matchesClientName(assigned, c.clientName)))
            .map(c => {
              const copy = { ...c };
              if (copy.integrations?.xero) {
                copy.integrations = {
                  ...copy.integrations,
                  xero: {
                    ...copy.integrations.xero,
                    availableTenants: [],
                    metadata: copy.integrations.xero.metadata
                      ? { ...copy.integrations.xero.metadata, availableTenants: [] }
                      : copy.integrations.xero.metadata
                  }
                };
              }
              if (copy.accountingStatus) {
                copy.accountingStatus = {
                  ...copy.accountingStatus,
                  availableTenants: [],
                  metadata: copy.accountingStatus.metadata
                    ? { ...copy.accountingStatus.metadata, availableTenants: [] }
                    : copy.accountingStatus.metadata
                };
              }
              return copy;
            });
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
      const supaActive = isSupabaseConfigured() && await isSupabaseControlPlaneActive();
      const loadLegacyAutoUpdatesClients_ = async () => {
        const sheets = await getSheetsClient().catch(() => null);
        if (!sheets) {
          throw new Error("Unable to initialize Google Sheets client.");
        }
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: DEFAULT_AC_SHEET_ID,
          range: "AutoUpdates!A2:AJ500",
          _allowRetiredControlPlaneRead: true,
        });
        const rows = resp.data.values || [];
        return rows
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
      };

      const excludedClientNamesSet = await getExcludedClientNamesSet_();
      let clients = [];
      let loadedFromSupabase = false;

      if (supaActive) {
        const sb = getSupabaseAdmin();
        const [
          { data: sbClients, error: sbErr },
          { data: sbSchedules, error: schedErr },
        ] = await Promise.all([
          sb.from("clients").select("*").order("client_name", { ascending: true }),
          sb.from("sync_schedules").select("*"),
        ]);

        if (!sbErr && Array.isArray(sbClients) && sbClients.length > 0) {
          loadedFromSupabase = true;
          const schedByName = new Map();
          if (!schedErr && Array.isArray(sbSchedules)) {
            for (const s of sbSchedules) {
              const key = String(s?.client_name || "").trim().toLowerCase();
              if (key) schedByName.set(key, s);
            }
          }

          const defaultAuto = evaluateAutomationHealth({});
          const healthPriority = { error: 5, running: 4, pending: 3, healthy: 2, inactive: 1 };

          for (const sc of sbClients) {
            const cName = String(sc?.client_name || "").trim();
            if (!cName) continue;
            const eff = String(sc?.metadata?.statusOverride || sc?.status || "live").trim().toLowerCase();
            if (["inactive", "archived", "suspended"].includes(eff)) continue;

            const normKey = String(sc?.normalized_key || "").trim();
            const resolvedClientSheetId =
              String(sc?.client_sheet_id || "").trim() ||
              (sc?.client_mode === "supabase" && normKey ? `sb-client-${normKey}` : "");
            const resolvedMasterSheetId =
              String(sc?.master_sheet_id || "").trim() ||
              (sc?.master_mode === "supabase" && normKey ? `sb-master-${normKey}` : "");
            if (!resolvedMasterSheetId && sc?.master_mode !== "supabase") continue;

            const sched = schedByName.get(cName.toLowerCase()) || null;
            const flags = (sched?.flags && typeof sched.flags === "object") ? sched.flags : {};
            const inFlightMs = flags.in_flight_since ? Date.parse(flags.in_flight_since) : NaN;
            const hasActiveInFlight = !Number.isNaN(inFlightMs) && (Date.now() - inFlightMs) < 310_000;
            const inFlightSeqs = Array.isArray(flags.in_flight_seqs) ? flags.in_flight_seqs : null;

            const crmAuto = sched
              ? evaluateAutomationHealth({
                  frequency: sched.crm_freq,
                  isRunning: hasActiveInFlight && (!inFlightSeqs || inFlightSeqs.includes("crm")),
                  lastCommandTime: sched.last_crm_run || "",
                  signalFeedback: sched.crm_status || "",
                  lastRunEndTime: sched.last_crm_run || "",
                  summary: sched.crm_status || "",
                })
              : defaultAuto;
            const invAuto = sched
              ? evaluateAutomationHealth({
                  frequency: sched.inv_freq,
                  isRunning: hasActiveInFlight && (!inFlightSeqs || inFlightSeqs.includes("invoice")),
                  lastCommandTime: sched.last_inv_run || "",
                  signalFeedback: sched.inv_status || "",
                  lastRunEndTime: sched.last_inv_run || "",
                  summary: sched.inv_status || "",
                })
              : defaultAuto;
            const expAuto = sched
              ? evaluateAutomationHealth({
                  frequency: sched.exp_freq,
                  isRunning: hasActiveInFlight && (!inFlightSeqs || inFlightSeqs.includes("expense")),
                  lastCommandTime: sched.last_exp_run || "",
                  signalFeedback: sched.exp_status || "",
                  lastRunEndTime: sched.last_exp_run || "",
                  summary: sched.exp_status || "",
                })
              : defaultAuto;
            const accAuto = (healthPriority[expAuto.status] || 0) > (healthPriority[invAuto.status] || 0) ? expAuto : invAuto;

            clients.push({
              clientName: cName,
              clientSheetId: resolvedClientSheetId,
              masterSheetId: resolvedMasterSheetId,
              clientMode: sc?.client_mode || "sheets",
              masterMode: sc?.master_mode || "sheets",
              autoUpdatesRow: sc?.metadata?.autoUpdatesRow ?? null,
              crmAuto,
              accAuto,
              fallbackConfig: {
                accountingTool: sc?.metadata?.accountingTool || "None",
                crmTool: sc?.metadata?.crmTool || "None",
                crmDrives: sc?.metadata?.crmDrives || "NA",
                setupMode: Boolean(sc?.metadata?.setupMode),
              },
            });
          }
        } else if (sbErr) {
          console.warn("Supabase clients read fallback notice in /api/integrations/status:", sbErr.message);
        }
      }

      if (!loadedFromSupabase) {
        clients = await loadLegacyAutoUpdatesClients_();
      }

      if (excludedClientNamesSet.size > 0) {
        clients = clients.filter(
          c => !excludedClientNamesSet.has(String(c?.clientName || "").trim().toLowerCase())
        );
      }

      // Respect user permissions
      const isGlobalScope = Boolean(sessionUser.isAdmin);
      if (!isGlobalScope) {
        const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
        clients = clients.filter(c => assignedList.some(assigned => matchesClientName(assigned, c.clientName)));
      }

      const ALL_TOOLS = ["xero", "quickbooks", "monday", "pipedrive", "clickup", "capsule", "close", "hubspot", "googlesheet", "excel"];

      // Fetch configs and integration statuses for each client
      const clientConfigs = await Promise.all(
        clients.map(async (c) => {
          try {
            const [cfg, ...toolStatuses] = await Promise.all([
              getClientSetupConfig({
                clientName: c.clientName,
                masterSheetId: c.masterSheetId,
                clientSheetId: c.clientSheetId,
                forceSheetSync: forceRefresh,
              }),
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

            const effectiveAccTool = (cfg.accountingTool && cfg.accountingTool !== "None")
              ? cfg.accountingTool
              : (!cfg.updatedAt && c.fallbackConfig?.accountingTool ? c.fallbackConfig.accountingTool : (cfg.accountingTool || "None"));
            const effectiveCrmTool = (cfg.crmTool && cfg.crmTool !== "None")
              ? cfg.crmTool
              : (!cfg.updatedAt && c.fallbackConfig?.crmTool ? c.fallbackConfig.crmTool : (cfg.crmTool || "None"));
            const effectiveCrmDrives = (cfg.crmDrives && cfg.crmDrives !== "NA")
              ? cfg.crmDrives
              : (!cfg.updatedAt && c.fallbackConfig?.crmDrives ? c.fallbackConfig.crmDrives : (cfg.crmDrives || "NA"));
            const effectiveSetupMode = Boolean(cfg.setupMode || (!cfg.updatedAt && c.fallbackConfig?.setupMode));

            const crmToolClean = String(effectiveCrmTool || "").toLowerCase();
            const crmKey = crmToolClean.includes("sheet") ? "googlesheet" : crmToolClean.includes("excel") ? "excel" : crmToolClean;
            let crmStatus = integrations[crmKey] || { connected: false, tool: effectiveCrmTool };
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
              accountingTool: effectiveAccTool || "None",
              accountingStatus: integrations[String(effectiveAccTool || "").toLowerCase()] || { connected: false, tool: effectiveAccTool },
              crmTool: effectiveCrmTool || "None",
              crmStatus,
              crmDrives: effectiveCrmDrives || "NA",
              setupMode: effectiveSetupMode,
              isSetupMode: effectiveSetupMode,
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
          } catch (e) { }
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

      const scopedClientConfigs = sessionUser.isAdmin
        ? clientConfigs
        : clientConfigs.map(c => {
          const copy = { ...c };
          if (copy.integrations?.xero) {
            copy.integrations = {
              ...copy.integrations,
              xero: {
                ...copy.integrations.xero,
                availableTenants: [],
                metadata: copy.integrations.xero.metadata
                  ? { ...copy.integrations.xero.metadata, availableTenants: [] }
                  : copy.integrations.xero.metadata
              }
            };
          }
          if (copy.accountingStatus) {
            copy.accountingStatus = {
              ...copy.accountingStatus,
              availableTenants: [],
              metadata: copy.accountingStatus.metadata
                ? { ...copy.accountingStatus.metadata, availableTenants: [] }
                : copy.accountingStatus.metadata
            };
          }
          return copy;
        });

      return res.status(200).json({
        success: true,
        allClients: scopedClientConfigs,
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

  const isAdvisorKey = ["advisor", "advisor account", "central advisor", "central advisor account"].includes(String(clientKey || "").trim().toLowerCase());
  const isAdvisorName = ["advisor", "advisor account", "central advisor", "central advisor account"].includes(String(clientName || "").trim().toLowerCase());
  const isAdvisorLookup = isAdvisorKey || isAdvisorName;

  if (clientKey && clientName) {
    const isAdvisorMatch = isAdvisorKey && isAdvisorName;
    if (!isAdvisorMatch && !matchesClientName(clientKey, clientName)) {
      return res.status(403).json({ error: "Forbidden: Mismatched clientKey and clientName." });
    }
  }

  let targetClient = isAdvisorLookup ? "advisor" : (clientName || clientKey);
  if (!targetClient && masterSheetId) {
    try {
      const sheets = await getSheetsClient();
      targetClient = await resolveClientNameBySheetId(sheets, masterSheetId);
    } catch (_) { }
  }

  if (!sessionUser.isAdmin) {
    if (isAdvisorLookup) {
      return res.status(403).json({ error: "Access denied to central advisor status." });
    }
    if (!targetClient || !isUserAuthorizedForClient(sessionUser, targetClient)) {
      return res.status(403).json({ error: "Access denied to this client." });
    }
    if (clientKey && !isUserAuthorizedForClient(sessionUser, clientKey)) {
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
      if (!sessionUser.isAdmin && status && typeof status === "object") {
        delete status.availableTenants;
        if (status.metadata && typeof status.metadata === "object") {
          status.metadata = { ...status.metadata };
          delete status.metadata.availableTenants;
        }
      }
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
