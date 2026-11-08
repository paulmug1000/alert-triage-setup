import { waitUntil } from "@vercel/functions";
import { getSheetsClient, withRetry, extractSheetIdFromUrl, colLetterToNum, colIndexToLetter, getSheetGid, getSheetId, applySheetFontFormat } from "./sheetsClient.js";
import { setMasterSwitch, checkAllGASLocks, fetchJobRowsForDisplay, getToleranceValues } from "./sharedHelpers.js";
import {
  isPlaceholderInvoice,
  isPlaceholderExpense,
  toSheetDateFormat,
  parseSheetDate,
  canonicalizeInvoiceStatus,
  canonicalizeExpenseStatus,
  hasActiveCrmIntegration,
  isCrmDrivenTab,
  getCrmDisplayName,
  NO_END_DATE_SHEET_VALUE,
  isNoEndDateSentinel,
  formatJobEndDateDisplay,
  classifyExpenseCategory
} from "../utils/helpers.js";
import { isUserAuthorizedForClient, matchesClientName, sanitizeFormulaInput, getClientManagerClientMap, DEFAULT_AC_SHEET_ID, verifyUserAuthorizedForSheet, resolveClientNameBySheetId } from "./userPermissions.js";
export { DEFAULT_AC_SHEET_ID, resolveClientNameBySheetId };
import { logPmaActivity } from "./pmaLogger.js";
import { getSessionUser } from "./authService.js";
import { getSettingsRedisKey } from "./clientSettingsService.js";
import { redisClient } from "./redisClient.js";
import { getSupabaseAdmin, isSupabaseControlPlaneActive } from "./supabaseClient.js";
import { memoryCache, get2TierCache, set2TierCache, invalidatePmaClientCache } from "./cacheService.js";
import { resolveAssignedAlertsInMemoryAndCache } from "./alertState.js";
import {
  provisionRetainerChildRows_,
  provisionRetainerScheduleInBackground,
  buildRetainerChildRowsWritePlan,
  groupAndCollapseRetainerChildRows_,
  executeChangeRetainerEndDate,
  executeChangeRetainerStartDate,
} from "./retainers.js";

let _allClientsMemoryCache = null;
let _allClientsCachedAt = 0;
let _assignedExpensesMemoryCache = null;
let _assignedExpensesCachedAt = 0;

export function clearAllClientsMemoryCache() {
  _allClientsMemoryCache = null;
  _allClientsCachedAt = 0;
}

export let assignedExpensesTabVerified = false;

export async function ensureAssignedExpensesTab_(sheets, spreadsheetId) {
  return;
}

export async function getClientWebAppUrl(sheets, clientName, acId = DEFAULT_AC_SHEET_ID) {
  if (!clientName) return "";
  const now = Date.now();
  if (_allClientsMemoryCache && (now - _allClientsCachedAt < 600000)) {
    const obj = _allClientsMemoryCache.clientsObj?.[clientName];
    if (obj?.webAppUrl) return obj.webAppUrl;
  }
  if (redisClient?.isOpen) {
    try {
      const cacheKey = `pulse:all_clients:${acId || DEFAULT_AC_SHEET_ID}`;
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        const obj = parsed.clientsObj?.[clientName];
        if (obj?.webAppUrl) return obj.webAppUrl;
      }
    } catch (e) { }
  }
  if (await isSupabaseControlPlaneActive()) {
    try {
      const sb = getSupabaseAdmin();
      const { data: row, error } = await sb
        .from("clients")
        .select("master_gas_webapp_url")
        .eq("client_name", clientName)
        .maybeSingle();
      if (!error && row?.master_gas_webapp_url) {
        return String(row.master_gas_webapp_url).trim();
      }
    } catch (_) {}
  }
  try {
    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId || DEFAULT_AC_SHEET_ID,
        range: "AutoUpdates!A2:N500"
      })
    );
    const rows = resp.data.values || [];
    const clientRow = rows.find(r => String(r[0] || "").trim() === clientName);
    return String(clientRow?.[13] || "").trim();
  } catch (err) {
    console.warn("⚠️ Error getting client webAppUrl:", err.message);
    return "";
  }
}

export async function getAllClients(sheets, sessionUser = { isAdmin: true }, bypassCache = false, _ignoredAcId = DEFAULT_AC_SHEET_ID) {
  const acId = process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_SHEET_ID;
  const cacheKey = `pulse:all_clients:${acId}`;
  const now = Date.now();
  const isCallerAdmin = !sessionUser || Boolean(sessionUser.isAdmin || sessionUser.role === "Admin");
  const effectiveBypass = Boolean(bypassCache && isCallerAdmin);

  let clientsArray = null;
  let clientsObj = null;

  if (!effectiveBypass && _allClientsMemoryCache && (now - _allClientsCachedAt < 600000)) {
    clientsArray = _allClientsMemoryCache.clientsArray;
    clientsObj = _allClientsMemoryCache.clientsObj;
  } else if (!effectiveBypass && redisClient?.isOpen) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        clientsArray = parsed.clientsArray;
        clientsObj = parsed.clientsObj;
        _allClientsMemoryCache = { clientsArray, clientsObj };
        _allClientsCachedAt = now;
      }
    } catch (e) {
      console.warn("⚠️ Redis get all clients cache error:", e.message);
    }
  }

  if (!clientsArray || !clientsObj) {
    if (await isSupabaseControlPlaneActive()) {
      try {
        const sb = getSupabaseAdmin();
        const [{ data: sbClients, error: sbErr }, cmMap] = await Promise.all([
          sb.from("clients").select("*").order("client_name", { ascending: true }),
          getClientManagerClientMap(sheets, acId),
        ]);
        if (!sbErr && Array.isArray(sbClients) && sbClients.length > 0) {
          clientsArray = [];
          clientsObj = {};
          for (const c of sbClients) {
            const clientName = String(c.client_name || "").trim();
            const clientSheetId = String(c.client_sheet_id || "").trim();
            const masterSheetId = String(c.master_sheet_id || "").trim();
            if (!clientName || !clientSheetId) continue;
            const reconSheetUrl = String(c.recon_sheet_url || "").trim();
            const reconSheetId = String(c.recon_sheet_id || "").trim();
            const scriptId = String(c.client_script_id || "").trim();
            const webAppUrl = String(c.master_gas_webapp_url || "").trim();
            const hasWebAppUrl = Boolean(webAppUrl);
            const splitEnabled = Boolean(c.split_enabled);
            const hasClientManager = cmMap.hasManager(clientName);
            const accountingTool = c.accounting_tool || "None";
            const crmTool = c.crm_tool || "None";
            const crmDrives = c.crm_drives || "NA";
            const revFocus = String(c.revenue_focus || "Revenue").trim();
            const rawDcMode = String(c.direct_costs_mode || "Contractors").trim();
            const directCostsMode = revFocus.toLowerCase() === "income" ? "Pass-through" : (rawDcMode === "Pass-through" ? "Pass-through" : "Contractors");
            const hasAccountingIntegration = ["xero", "quickbooks", "qb"].some(t => String(accountingTool).toLowerCase().includes(t));
            const item = {
              clientName,
              clientSheetId,
              masterSheetId,
              scriptId,
              webAppUrl,
              hasWebAppUrl,
              splitEnabled,
              reconSheetUrl,
              reconSheetId,
              hasClientManager,
              accountingTool,
              crmTool,
              crmDrives,
              directCostsMode,
              hasAccountingIntegration,
              clientMode: c.client_mode || "sheets",
            };
            clientsArray.push(item);
            clientsObj[clientName] = { ...item };
          }
          if (redisClient?.isOpen) {
            await redisClient.set(cacheKey, JSON.stringify({ clientsArray, clientsObj }), { EX: 86400 * 7 }).catch(() => {});
          }
          _allClientsMemoryCache = { clientsArray, clientsObj };
          _allClientsCachedAt = now;
        }
      } catch (sbErr) {
        console.warn("⚠️ Supabase getAllClients fallback to sheet:", sbErr.message);
      }
    }
  }

  if (!clientsArray || !clientsObj) {
    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: acId,
      range: "AutoUpdates!A2:DB500",
    }));
    const cmMap = await getClientManagerClientMap(sheets, acId);
    const rows = resp.data.values || [];
    clientsArray = [];
    clientsObj = {};
    for (const row of rows) {
      const clientName = String(row[0] || "").trim();
      const reconSheetUrl = row[9];
      const reconSheetId = extractSheetIdFromUrl(reconSheetUrl) || String(reconSheetUrl || "").trim();
      const scriptId = String(row[10] || "").trim();
      const clientSheetUrl = row[11];
      const masterSheetUrl = row[12];
      const webAppUrl = String(row[13] || "").trim();
      const hasWebAppUrl = !!webAppUrl;
      const splitEnabled = String(row[104] || "").trim().toLowerCase() === "yes";
      if (!clientName || !clientSheetUrl) continue;
      if (clientName.toLowerCase() === "client" || clientName.toLowerCase() === "client name") continue;
      const clientSheetId = extractSheetIdFromUrl(clientSheetUrl) || String(clientSheetUrl).trim();
      const masterSheetId = extractSheetIdFromUrl(masterSheetUrl) || String(masterSheetUrl || "").trim();
      const hasClientManager = cmMap.hasManager(clientName);
      clientsArray.push({ clientName, clientSheetId, masterSheetId, scriptId, webAppUrl, hasWebAppUrl, splitEnabled, reconSheetUrl, reconSheetId, hasClientManager });
      if (clientSheetId || masterSheetId) clientsObj[clientName] = { clientSheetId, masterSheetId, scriptId, webAppUrl, hasWebAppUrl, reconSheetUrl, reconSheetId, hasClientManager };
    }

    if (redisClient?.isOpen) {
      try {
        // 7-day TTL in Redis — clients in AutoUpdates change very rarely
        await redisClient.set(cacheKey, JSON.stringify({ clientsArray, clientsObj }), { EX: 86400 * 7 });
      } catch (e) {
        console.warn("⚠️ Redis set all clients cache error:", e.message);
      }
    }
    _allClientsMemoryCache = { clientsArray, clientsObj };
    _allClientsCachedAt = now;
  }

  // Enrich clientsArray and clientsObj with accountingTool, directCostsMode, and hasAccountingIntegration from Redis setup config
  if (redisClient?.isOpen && clientsArray && clientsArray.length > 0) {
    try {
      const normalizeClientKey = (str) => String(str || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
      const setupKeys = clientsArray.map(c => `pulse:setup:${normalizeClientKey(c.clientName)}`);
      const configs = await redisClient.mGet(setupKeys);
      let anyConfigChanged = false;
      clientsArray.forEach((c, idx) => {
        const raw = configs[idx];
        const prevAcc = c.accountingTool;
        const prevCrm = c.crmTool;
        const prevDrives = c.crmDrives;
        const prevDcMode = c.directCostsMode;
        const prevHasAcc = c.hasAccountingIntegration;
        if (raw) {
          try {
            const cfg = JSON.parse(raw);
            c.accountingTool = cfg.accountingTool || "None";
            c.crmTool = cfg.crmTool || "None";
            c.crmDrives = cfg.crmDrives || "NA";
            const revFocus = String(cfg.revenueFocus || "Revenue").trim();
            const rawDcMode = String(cfg.directCostsMode || "Contractors").trim();
            c.directCostsMode = revFocus.toLowerCase() === "income" ? "Pass-through" : (rawDcMode === "Pass-through" ? "Pass-through" : "Contractors");
            c.hasAccountingIntegration = ["xero", "quickbooks", "qb"].some(t => String(c.accountingTool).toLowerCase().includes(t));
            if (clientsObj[c.clientName]) {
              clientsObj[c.clientName].accountingTool = c.accountingTool;
              clientsObj[c.clientName].crmTool = c.crmTool;
              clientsObj[c.clientName].crmDrives = c.crmDrives;
              clientsObj[c.clientName].directCostsMode = c.directCostsMode;
              clientsObj[c.clientName].hasAccountingIntegration = c.hasAccountingIntegration;
            }
          } catch (_) { }
        } else {
          c.accountingTool = c.accountingTool || "None";
          c.directCostsMode = c.directCostsMode || "Contractors";
          c.hasAccountingIntegration = c.hasAccountingIntegration || false;
        }
        if (
          c.accountingTool !== prevAcc ||
          c.crmTool !== prevCrm ||
          c.crmDrives !== prevDrives ||
          c.directCostsMode !== prevDcMode ||
          c.hasAccountingIntegration !== prevHasAcc
        ) {
          anyConfigChanged = true;
        }
      });
      _allClientsMemoryCache = { clientsArray, clientsObj };
      if (anyConfigChanged) {
        redisClient.set(cacheKey, JSON.stringify({ clientsArray, clientsObj }), { EX: 86400 * 7 }).catch(() => { });
      }
    } catch (cfgErr) {
      console.warn("⚠️ Redis get tenant configs warning:", cfgErr.message);
    }
  }

  let finalClientsArray = clientsArray;
  let finalClientsObj = clientsObj;

  const isAdminUser = !sessionUser || sessionUser.isAdmin || sessionUser.role === "Admin";
  if (!isAdminUser) {
    const assignedList = Array.isArray(sessionUser?.assignedClients) ? sessionUser.assignedClients : [];
    finalClientsArray = clientsArray.filter(c =>
      assignedList.some(assigned => matchesClientName(assigned, c.clientName))
    );
    finalClientsObj = Object.fromEntries(
      Object.entries(clientsObj).filter(([k]) =>
        assignedList.some(assigned => matchesClientName(assigned, k))
      )
    );
  }

  finalClientsArray.sort((a, b) => a.clientName.localeCompare(b.clientName));
  return { clientsArray: finalClientsArray, clientsObj: finalClientsObj };
}

export async function getClients(sessionUser = { isAdmin: true }, bypassCache = false) {
  const sheets = await getSheetsClient();
  const { clientsArray } = await getAllClients(sheets, sessionUser, bypassCache);
  return clientsArray || [];
}

export async function handleGetAllClients(req, res, sheets) {
  const automationCommanderSheetId = process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_SHEET_ID;
  const { bypassCache } = req.body || {};

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  try {
    const { clientsArray, clientsObj } = await getAllClients(sheets, sessionUser, bypassCache, automationCommanderSheetId);
    return res.status(200).json({ success: true, clients: clientsArray, clientsMap: clientsObj });
  } catch (err) {
    console.error("❌ get_all_clients error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetAssignedExpenses(req, res, sheets) {
  const aeAcId = process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_SHEET_ID;
  const { bypassCache } = req.body || {};
  const cacheKey = `pulse:assigned_expenses:${aeAcId}`;
  const now = Date.now();

  try {
    const sessionUser = getSessionUser(req);
    const filterAssignedForUser = (assignedMap) => {
      if (!sessionUser || sessionUser.isAdmin) return assignedMap;
      const filtered = {};
      for (const [cName, ids] of Object.entries(assignedMap || {})) {
        if (isUserAuthorizedForClient(sessionUser, cName)) {
          filtered[cName] = ids;
        }
      }
      return filtered;
    };

    if (!bypassCache && _assignedExpensesMemoryCache && (now - _assignedExpensesCachedAt < 60000)) {
      return res.status(200).json({ success: true, assignedByClient: filterAssignedForUser(_assignedExpensesMemoryCache) });
    }

    if (!bypassCache && redisClient?.isOpen) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          _assignedExpensesMemoryCache = parsed;
          _assignedExpensesCachedAt = now;
          return res.status(200).json({ success: true, assignedByClient: filterAssignedForUser(parsed) });
        }
      } catch (e) {
        console.warn("⚠️ Redis get assigned expenses cache error:", e.message);
      }
    }

    await ensureAssignedExpensesTab_(sheets, aeAcId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: aeAcId, range: "AssignedExpenses!A2:C50000" }));
    const assignedByClient = {};
    (resp.data.values || []).forEach(r => {
      if (!r[0] || !r[1]) return;
      if (!assignedByClient[r[0]]) assignedByClient[r[0]] = [];
      assignedByClient[r[0]].push(r[1]);
    });

    if (redisClient?.isOpen) {
      try {
        await redisClient.set(cacheKey, JSON.stringify(assignedByClient), { EX: 300 });
      } catch (e) {
        console.warn("⚠️ Redis set assigned expenses cache error:", e.message);
      }
    }
    _assignedExpensesMemoryCache = assignedByClient;
    _assignedExpensesCachedAt = now;

    return res.status(200).json({ success: true, assignedByClient: filterAssignedForUser(assignedByClient) });
  } catch (err) {
    console.error("❌ get_assigned_expenses error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleMarkExpenseAssigned(req, res, sheets) {
  const { automationCommanderSheetId: aeAcId, clientName: aeClientName, appId: aeAppId } = req.body;
  if (!aeAcId || !aeClientName || !aeAppId) {
    return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId, clientName, or appId" });
  }
  try {
    _assignedExpensesMemoryCache = null;
    _assignedExpensesCachedAt = 0;
    if (redisClient?.isOpen) {
      redisClient.del(`pulse:assigned_expenses:${aeAcId}`).catch(() => { });
    }
    await ensureAssignedExpensesTab_(sheets, aeAcId);
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: aeAcId, range: "AssignedExpenses!A:C", valueInputOption: "RAW",
      requestBody: { values: [[aeClientName, aeAppId, new Date().toISOString()]] },
    }));
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ mark_expense_assigned error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handlePruneAssignedExpenses(req, res, sheets) {
  const { automationCommanderSheetId: aeAcId, clientName: aeClientName, validAppIds } = req.body;
  if (!aeAcId || !aeClientName || !Array.isArray(validAppIds)) {
    return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId, clientName, or validAppIds" });
  }
  try {
    await ensureAssignedExpensesTab_(sheets, aeAcId);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: aeAcId, range: "AssignedExpenses!A2:C50000" });
    const rows = resp.data.values || [];
    const validSet = new Set(validAppIds);
    const keptRows = rows.filter(r => !(r[0] === aeClientName) || validSet.has(r[1]));
    if (keptRows.length !== rows.length) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: aeAcId, range: `AssignedExpenses!A2:C${rows.length + 1}` });
      if (keptRows.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: aeAcId, range: "AssignedExpenses!A2", valueInputOption: "RAW", requestBody: { values: keptRows },
        });
      }
    }
    return res.status(200).json({ success: true, removed: rows.length - keptRows.length });
  } catch (err) {
    console.error("❌ prune_assigned_expenses error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetOutgoingsInbox(req, res, sheets) {
  const { masterSheetId, clientSheetId, bypassCache, clientName } = req.body;
  const sheetId = masterSheetId || clientSheetId;
  if (!sheetId) return res.status(400).json({ success: false, error: "Missing masterSheetId or clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(sheetId) || sheetId;

    const sessionUser = getSessionUser(req);
    if (sessionUser && !sessionUser.isAdmin) {
      const auth = await verifyUserAuthorizedForSheet(sessionUser, sheetIdClean, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }
    const cacheKey = `pulse:pma:outgoings_inbox:${sheetIdClean}`;

    if (!bypassCache) {
      const cached = await get2TierCache(cacheKey);
      if (cached && Array.isArray(cached.inbox) && cached.directCostsMode !== undefined) {
        return res.status(200).json(cached);
      }
    }

    const allLocks = await checkAllGASLocks(sheets, sheetIdClean);
    const expLock = allLocks.expense;
    if (expLock.locked) {
      return res.status(200).json({ success: true, inbox: [], locked: true, lockMessage: "Expense automation is currently running - try again in a moment" });
    }

    await setMasterSwitch(sheets, sheetIdClean, "DirComp", true);
    const dataResp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetIdClean,
      ranges: ["DirComp!A6:AV1000", "KeyInfo!B15", "KeyInfo!D8", "KeyInfo!AT4:AT22", "KeyInfo!AT24:AT40"],
    });
    await setMasterSwitch(sheets, sheetIdClean, "DirComp", false);

    const valRanges = dataResp.data.valueRanges || [];
    const rows = valRanges[0]?.values || [];
    const revFocus = String(valRanges[1]?.values?.[0]?.[0] || "Revenue").trim();
    const rawDcMode = String(valRanges[2]?.values?.[0]?.[0] || "Contractors").trim();
    const directCostsMode = revFocus.toLowerCase() === "income" ? "Pass-through" : (rawDcMode === "Pass-through" ? "Pass-through" : "Contractors");
    const contractorsList = (valRanges[3]?.values || []).map(r => String(r?.[0] || "").trim()).filter(Boolean);
    const passThroughList = (valRanges[4]?.values || []).map(r => String(r?.[0] || "").trim()).filter(Boolean);

    const inbox = [];
    let skippedNoFlag = 0, skippedNoAppId = 0;
    for (const row of rows) {
      if (!row || row.length === 0) continue;
      const rawFlag = String(row[40] || "").trim();
      const isMissing = rawFlag === "1";
      if (!isMissing) { skippedNoFlag++; continue; }

      const date = String(row[0] || "").trim();
      const description = String(row[1] || "").trim();
      const amount = parseFloat(String(row[2] || "0").replace(/,/g, "")) || 0;
      const reference = String(row[3] || "").trim();
      const accountName = String(row[4] || "").trim();
      const status = String(row[5] || "").trim();
      const appId = String(row[6] || "").trim();
      const datePaid = String(row[7] || "").trim();
      const vatAmount = parseFloat(String(row[8] || "0").replace(/[£$€,]/g, "")) || 0;
      const contactName = String(row[11] || "").trim();

      if (!appId) { skippedNoAppId++; continue; }
      const { flagType, expenseCategoryType } = classifyExpenseCategory(accountName, contractorsList, passThroughList, directCostsMode);
      inbox.push({ appId, amount, date, description, reference, accountName, status, datePaid, vatAmount, contactName, expenseCategoryType, flagType });
    }

    const payload = { success: true, inbox, directCostsMode };
    await set2TierCache(cacheKey, payload, 60);
    return res.status(200).json(payload);
  } catch (err) {
    try { await setMasterSwitch(sheets, extractSheetIdFromUrl(req.body.masterSheetId || req.body.clientSheetId) || req.body.masterSheetId || req.body.clientSheetId, "DirComp", false); } catch (e) { }
    console.error("❌ get_outgoings_inbox error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetInvoicesInbox(req, res, sheets) {
  const { masterSheetId, clientSheetId, bypassCache, clientName } = req.body;
  const sheetId = masterSheetId || clientSheetId;
  if (!sheetId) return res.status(400).json({ success: false, error: "Missing masterSheetId or clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(sheetId) || sheetId;

    const sessionUser = getSessionUser(req);
    if (sessionUser && !sessionUser.isAdmin) {
      const auth = await verifyUserAuthorizedForSheet(sessionUser, sheetIdClean, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }
    const cacheKey = `pulse:pma:invoices_inbox:${sheetIdClean}`;

    if (!bypassCache) {
      const cached = await get2TierCache(cacheKey);
      if (cached && Array.isArray(cached.inbox)) {
        return res.status(200).json(cached);
      }
    }

    const allLocks = await checkAllGASLocks(sheets, sheetIdClean);
    const invLock = allLocks.invoice;
    if (invLock.locked) {
      return res.status(200).json({ success: true, inbox: [], locked: true, lockMessage: "Invoice automation is currently running - try again in a moment" });
    }

    await setMasterSwitch(sheets, sheetIdClean, "InvComp", true);
    const dataResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "InvComp!A6:Y1000",
    });
    await setMasterSwitch(sheets, sheetIdClean, "InvComp", false);

    const rows = dataResp.data.values || [];
    const inbox = [];
    let skippedNoFlag = 0, skippedNoInvNo = 0;
    for (const row of rows) {
      if (!row || row.length === 0) continue;
      const isMissing = String(row[18] || "").trim() === "1";
      if (!isMissing) { skippedNoFlag++; continue; }

      const client = String(row[0] || "").trim();
      const job = String(row[1] || "").trim();
      const invoiceAmt = parseFloat(String(row[2] || "0").replace(/,/g, "")) || 0;
      const totalExclVAT = parseFloat(String(row[3] || "0").replace(/,/g, "")) || 0;
      const vatIncluded = parseFloat(String(row[4] || "0").replace(/,/g, "")) || 0;
      const invoiceNo = String(row[5] || "").trim();

      const fmtDate = (dStr) => {
        if (!dStr) return "";
        const nativeParsed = new Date(dStr);
        let d = null;
        if (!isNaN(nativeParsed.getTime())) d = nativeParsed;
        else {
          const MONTHS_MAP = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
          const parts = String(dStr).split(/[-\/]/);
          if (parts.length === 3) {
            const mNum = MONTHS_MAP[parts[1]?.toLowerCase()?.substring(0, 3)];
            if (mNum !== undefined) {
              const yr = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
              d = new Date(yr, mNum, parseInt(parts[0]));
            }
          }
        }
        if (!d) return String(dStr).trim();
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
      };

      const sentDate = fmtDate(row[6]);
      const dueDate = fmtDate(row[7]);
      const fullyPaidOn = fmtDate(row[8]);
      const status = String(row[9] || "").trim();
      const currency = String(row[10] || "").trim() || "GBP";

      if (!invoiceNo) { skippedNoInvNo++; continue; }
      inbox.push({
        invoiceNo, client, job, currency, sentDate, dueDate, fullyPaidOn, status,
        amount: totalExclVAT !== 0 ? totalExclVAT : invoiceAmt,
        grossAmount: invoiceAmt, vatAmount: vatIncluded,
        isMissing,
      });
    }

    const payload = { success: true, inbox };
    await set2TierCache(cacheKey, payload, 60);
    return res.status(200).json(payload);
  } catch (err) {
    try { await setMasterSwitch(sheets, extractSheetIdFromUrl(req.body.masterSheetId || req.body.clientSheetId) || req.body.masterSheetId || req.body.clientSheetId, "InvComp", false); } catch (e) { }
    console.error("❌ get_invoices_inbox error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCreateOutgoingsVendor(req, res, sheets) {
  const { clientSheetId, masterSheetId, vendorName, vatFlag, invTiming, payTiming, deliveryPct } = req.body;
  if (!clientSheetId || !vendorName) return res.status(400).json({ success: false, error: "Missing clientSheetId or vendorName" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const cleanVendorName = String(vendorName || "").trim();
    const checkResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Outgoings!A13:E110",
    });
    const rows = checkResp.data.values || [];

    const pctNum = parseFloat(String(deliveryPct !== undefined && deliveryPct !== "" ? deliveryPct : "100").replace(/%/g, ""));
    const pctString = `${Number.isFinite(pctNum) ? Math.max(0, Math.min(100, pctNum)) : 100}%`;

    // 1. Check if vendor already exists in Outgoings
    for (let i = 0; i < rows.length; i++) {
      const existingName = String(rows[i]?.[0] || "").trim();
      if (existingName && existingName.toLowerCase() === cleanVendorName.toLowerCase()) {
        const existingRow = 13 + i;
        const existingVendorObj = {
          sheetRow: existingRow,
          name: existingName,
          vatFlag: String(rows[i]?.[1] || vatFlag || "Yes").trim(),
          invTiming: String(rows[i]?.[2] || invTiming || "Next").trim(),
          payTiming: String(rows[i]?.[3] || payTiming || "Next").trim(),
          deliveryPct: String(rows[i]?.[4] || pctString).trim(),
          cells: {},
        };
        return res.status(200).json({
          success: true,
          sheetRow: existingRow,
          vendor: existingVendorObj,
          alreadyExisted: true,
        });
      }
    }

    // 2. Find next available row in contractors section (rows 13 to 110)
    let lastPopulatedRow = 12;
    for (let i = rows.length - 1; i >= 0; i--) {
      const val = String(rows[i]?.[0] || "").trim();
      if (val && !val.startsWith("=") && val.toLowerCase() !== "contractors") {
        lastPopulatedRow = 13 + i;
        break;
      }
    }
    const newRow = lastPopulatedRow + 1;
    if (newRow > 110) return res.status(400).json({ success: false, error: "Contractors section is full (max row 110)" });

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetIdClean,
      range: `Outgoings!A${newRow}:E${newRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[sanitizeFormulaInput(cleanVendorName), sanitizeFormulaInput(String(vatFlag || "Yes")), sanitizeFormulaInput(String(invTiming || "Next")), sanitizeFormulaInput(String(payTiming || "Next")), pctString]] },
    });

    await applySheetFontFormat(sheets, sheetIdClean, "Outgoings", newRow - 1, newRow, 0, 50, "Arial", 9);

    // Invalidate server-side caches immediately across L1/L2
    const cleanMasterId = masterSheetId ? (extractSheetIdFromUrl(masterSheetId) || masterSheetId) : null;
    await invalidatePmaClientCache(sheetIdClean, cleanMasterId, ["outgoings"]).catch(e => console.warn("Cache invalidate failed:", e.message));

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "EXPENSES",
      action: "Vendor Created",
      summary: `Created new contractor/vendor '${cleanVendorName}' for ${tenantClient || "Client"} (Row ${newRow})`,
      details: {
        vendorName: cleanVendorName,
        vatFlag: vatFlag || "Yes",
        invTiming: invTiming || "Next",
        payTiming: payTiming || "Next",
        deliveryPct: pctString,
        row: newRow,
        clientName: tenantClient
      }
    }).catch(e => console.error("PMA log failed:", e));

    const newVendorObj = {
      sheetRow: newRow,
      name: cleanVendorName,
      vatFlag: vatFlag || "Yes",
      invTiming: invTiming || "Next",
      payTiming: payTiming || "Next",
      deliveryPct: pctString,
      cells: {},
    };

    return res.status(200).json({ success: true, sheetRow: newRow, vendor: newVendorObj });
  } catch (err) {
    console.error("❌ create_outgoings_vendor error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetOutgoings(req, res, sheets) {
  const { clientSheetId, bypassCache } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const cacheKey = `pulse:pma:outgoings:${sheetIdClean}`;

    if (!bypassCache) {
      const cached = await get2TierCache(cacheKey);
      if (
        cached &&
        Array.isArray(cached.contractors) &&
        cached.directCostsMode !== undefined &&
        cached.makingUpCos !== undefined &&
        (cached.contractors.length === 0 || cached.contractors[0]?.deliveryPct !== undefined)
      ) {
        return res.status(200).json(cached);
      }
    }

    const [gridResp, keyInfoResp] = await Promise.all([
      sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        ranges: ["Outgoings!A1:BG1", "Outgoings!A13:BG110", "Outgoings!A111:BG250"],
        includeGridData: true,
        fields: "sheets.data.rowData.values(formattedValue,note,effectiveValue)",
      }),
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: sheetIdClean,
        ranges: ["KeyInfo!B15", "KeyInfo!D8"],
      }).catch(() => null),
    ]);
    const kiRanges = keyInfoResp?.data?.valueRanges || [];
    const revFocus = String(kiRanges[0]?.values?.[0]?.[0] || "Revenue").trim();
    const rawDcMode = String(kiRanges[1]?.values?.[0]?.[0] || "Contractors").trim();
    const directCostsMode = revFocus.toLowerCase() === "income" ? "Pass-through" : (rawDcMode === "Pass-through" ? "Pass-through" : "Contractors");

    const sheetGrids = gridResp.data.sheets?.[0]?.data || [];
    const headerGridData = sheetGrids[0];
    const contractorGridData = sheetGrids[1];
    const extraGridData = sheetGrids[2];

    const headerCells = headerGridData?.rowData?.[0]?.values || [];
    const contractorRows = contractorGridData?.rowData || [];
    const extraRows = extraGridData?.rowData || [];

    const SHEET_EPOCH = new Date(1899, 11, 30);
    const months = [];
    for (let i = 6; i < headerCells.length; i++) {
      const cell = headerCells[i];
      if (!cell) continue;
      const fv = cell.formattedValue || "";
      const ev = cell.effectiveValue;

      if (fv.toLowerCase().includes("total") || fv.toLowerCase().includes("fy")) continue;

      let dateObj = null;
      if (ev?.numberValue) {
        const d = new Date(SHEET_EPOCH.getTime() + ev.numberValue * 86400000);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2020) dateObj = d;
      }
      if (!dateObj && fv) {
        const d = new Date(fv);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2020) dateObj = d;
      }

      if (dateObj) {
        const label = dateObj.toLocaleString("en-GB", { month: "short", year: "2-digit" });
        const isoMonth = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}`;
        months.push({ colIndex: i, colLetter: colIndexToLetter(i + 1), label, isoMonth, dateObj: dateObj.toISOString() });
      }
    }

    const parseNoteParts = (note) => {
      if (!note) return { topNote: "", blocks: [] };
      const firstBlockIdx = note.indexOf("{App ID:");
      let topNote = "";
      let blockText = "";
      if (firstBlockIdx !== -1) {
        topNote = note.substring(0, firstBlockIdx).trim();
        blockText = note.substring(firstBlockIdx);
      } else if (note.includes("{") && note.includes("}")) {
        blockText = note;
      } else {
        topNote = note.trim();
      }

      const blocks = [];
      const rawBlocks = blockText.split(/(?=\{App ID:)/).map((s) => s.trim()).filter(Boolean);
      for (const raw of rawBlocks) {
        if (!raw.includes("{App ID:")) continue;
        const getTag = (key) => {
          const m = raw.match(new RegExp(`\\{${key}:\\s*([^}]*)\\}`, "i"));
          return m ? m[1].trim() : "";
        };
        const appId = getTag("App ID");
        const amtStr = getTag("Amt");
        const amount = parseFloat(amtStr.replace(/[£$€,\s]/g, "")) || 0;
        const status = getTag("Status");
        const recDate = getTag("Rec date");
        const payDate = getTag("Pay date");
        const description = getTag("Description");
        if (appId) {
          blocks.push({ appId, amount, status, recDate, payDate, description });
        }
      }
      return { topNote, blocks };
    };

    const contractors = [];
    for (let r = 0; r < contractorRows.length; r++) {
      const rowCells = contractorRows[r]?.values || [];
      const name = String(rowCells[0]?.formattedValue || "").trim();
      if (!name) continue;
      if (name.toLowerCase() === "contractors" || name.startsWith("Total") || name.startsWith("=")) continue;

      const vatFlag = String(rowCells[1]?.formattedValue || "").trim();
      const invTiming = String(rowCells[2]?.formattedValue || "").trim();
      const payTiming = String(rowCells[3]?.formattedValue || "").trim();
      const deliveryPct = String(rowCells[4]?.formattedValue || "").trim();

      const cells = {};
      for (const month of months) {
        const cellData = rowCells[month.colIndex];
        const note = cellData?.note || "";
        const value = cellData?.formattedValue || "";
        const { topNote, blocks } = parseNoteParts(note);
        cells[month.colLetter] = { value, note, topNote, blocks };
      }

      contractors.push({ sheetRow: 13 + r, name, vatFlag, invTiming, payTiming, deliveryPct, cells });
    }

    const extraOutgoingsRows = [];
    for (let r = 0; r < extraRows.length; r++) {
      const rowCells = extraRows[r]?.values || [];
      const name = String(rowCells[0]?.formattedValue || "").trim();
      if (!name || name.startsWith("Total") || name.startsWith("=")) continue;

      const vatFlag = String(rowCells[1]?.formattedValue || "").trim();
      const invTiming = String(rowCells[2]?.formattedValue || "").trim();
      const payTiming = String(rowCells[3]?.formattedValue || "").trim();
      const deliveryPct = String(rowCells[4]?.formattedValue || "").trim();

      const cells = {};
      let hasAnyNoteOrValue = false;
      for (const month of months) {
        const cellData = rowCells[month.colIndex];
        const note = cellData?.note || "";
        const value = cellData?.formattedValue || "";
        if (note || value) hasAnyNoteOrValue = true;
        const { topNote, blocks } = parseNoteParts(note);
        cells[month.colLetter] = { value, note, topNote, blocks };
      }

      if (hasAnyNoteOrValue || r === 0) {
        extraOutgoingsRows.push({ sheetRow: 111 + r, name, vatFlag, invTiming, payTiming, deliveryPct, cells });
      }
    }

    // Row 111 is "Making up CoS" formula row; Row 112 is the "Zero" override row
    const row111Values = extraRows[0]?.values || [];
    const row112Values = extraRows[1]?.values || [];
    const cosRawName = String(row111Values[0]?.formattedValue || "").trim();
    const cosPct = String(row112Values[0]?.formattedValue || "").trim();

    const makingUpCosCells = {};
    for (const month of months) {
      const cell111 = row111Values[month.colIndex];
      const cell112 = row112Values[month.colIndex];

      const val111Str = cell111?.formattedValue || "";
      const val111Num = typeof cell111?.effectiveValue?.numberValue === "number"
        ? cell111.effectiveValue.numberValue
        : parseFloat(String(val111Str).replace(/[^0-9.-]/g, "")) || 0;

      const raw112 = String(cell112?.formattedValue || cell112?.effectiveValue?.stringValue || "").trim();
      const isZero = raw112.toUpperCase() === "ZERO";

      makingUpCosCells[month.colLetter] = {
        amount: val111Num,
        formatted: val111Str || (val111Num ? `£${val111Num.toLocaleString("en-GB")}` : "£0"),
        isZero,
        overrideValue: raw112,
        note: cell111?.note || "",
      };
    }

    const makingUpCos = {
      name: cosRawName || "Making up Cos",
      pct: cosPct || "",
      cells: makingUpCosCells,
    };

    const payload = { success: true, contractors, extraOutgoingsRows, months, directCostsMode, makingUpCos };
    await set2TierCache(cacheKey, payload, 120);
    return res.status(200).json(payload);
  } catch (err) {
    console.error("❌ get_outgoings error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetDirectCostsJobs(req, res, sheets) {
  const { clientSheetId, showAll, bypassCache } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const cacheKey = `pulse:pma:direct_costs_jobs:${sheetIdClean}:${showAll ? "all" : "active"}`;

    if (!bypassCache) {
      const cached = await get2TierCache(cacheKey);
      if (cached && Array.isArray(cached.jobs) && cached.directCostsMode !== undefined) {
        return res.status(200).json(cached);
      }
    }

    const batchResp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetIdClean,
      ranges: ["Confirmed!A1:CR5000", "KeyInfo!B15", "KeyInfo!D8"],
      valueRenderOption: "FORMATTED_VALUE",
    });
    const valRanges = batchResp.data.valueRanges || [];
    const rows = valRanges[0]?.values || [];
    const revFocus = String(valRanges[1]?.values?.[0]?.[0] || "Revenue").trim();
    const rawDcMode = String(valRanges[2]?.values?.[0]?.[0] || "Contractors").trim();
    const directCostsMode = revFocus.toLowerCase() === "income" ? "Pass-through" : (rawDcMode === "Pass-through" ? "Pass-through" : "Contractors");

    const parseSheetDate = (d) => {
      if (!d) return null;
      const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (!m) return null;
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mIdx = months[m[2].toLowerCase()];
      if (mIdx === undefined) return null;
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
      return new Date(yr, mIdx, parseInt(m[1]));
    };
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
    const buildRowData = (rowNum, row, isParent) => ({
      rowNum, isParent,
      client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
      revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
      projectRetainer: colVal(row, 35), startDate: colVal(row, 37), endDate: colVal(row, 38),
      likelihood: null, copiedToConf: null,
      invoiceSlots: [1, 2, 3].map(n => {
        const base = n === 1 ? 41 : n === 2 ? 48 : 55;
        return {
          slotNum: n, amount: colVal(row, base), ref: colVal(row, base + 1), sentDate: colVal(row, base + 2),
          daysToPay: colVal(row, base + 3), status: canonicalizeInvoiceStatus(colVal(row, base + 4)), highlighted: false
        };
      }),
      expenseSlots: [1, 2, 3].map(n => {
        const base = n === 1 ? 75 : n === 2 ? 82 : 89;
        return {
          slotNum: n, description: colVal(row, base), amount: colVal(row, base + 1), vat: colVal(row, base + 2),
          date: colVal(row, base + 3), daysToPay: colVal(row, base + 4), status: canonicalizeExpenseStatus(colVal(row, base + 5)),
          transactionId: colVal(row, base + 6), highlighted: false
        };
      }),
    });

    const jobs = [];
    let ri = 1;
    while (ri < rows.length) {
      const row = rows[ri] || [];
      const client = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const budgetNum = parseFloat(String(row[33] || "").replace(/[£$€,\s]/g, "")) || 0;
      if (!client && !jobName) { ri++; continue; }

      const parentRowNum = ri + 1;
      const jobRows = [buildRowData(parentRowNum, row, true)];
      let cj = ri + 1;
      while (cj < rows.length) {
        const next = rows[cj] || [];
        const nc = String(next[0] || "").trim();
        const nj = String(next[1] || "").trim();
        const nRevenue = String(next[32] || "").trim();
        const nBudget = parseFloat(String(next[33] || "").replace(/[£$€,\s]/g, "")) || 0;
        const nStart = String(next[37] || "").trim();
        if (nc === client && nj === jobName && !nRevenue && !nBudget && !nStart) {
          jobRows.push(buildRowData(cj + 1, next, false));
          cj++;
        } else {
          break;
        }
      }
      ri = cj;

      let realCostsTotal = 0;
      let hasAnyExpenses = false;
      for (const jr of jobRows) {
        for (const slot of jr.expenseSlots) {
          const isReal = (slot.transactionId || slot.description) && !isPlaceholderExpense(slot);
          if (isReal) {
            realCostsTotal += parseFloat(String(slot.amount || "").replace(/[£$€,\s]/g, "")) || 0;
            hasAnyExpenses = true;
          } else if (slot.amount || slot.description || slot.transactionId) {
            hasAnyExpenses = true;
          }
        }
      }
      const revenueNum = parseFloat(String(row[32] || "").replace(/[£$€,\s]/g, "")) || 0;
      const unreceivedCosts = budgetNum - realCostsTotal;

      const hasDirectCosts = budgetNum > 0 || hasAnyExpenses;
      const parentStart = parseSheetDate(row[37]);
      const parentEnd = parseSheetDate(row[38]);
      let hasRecentDate = (parentStart && parentStart >= sixMonthsAgo) || (parentEnd && parentEnd >= sixMonthsAgo);
      if (!hasRecentDate) {
        for (const jr of jobRows) {
          const rStart = parseSheetDate(jr.startDate);
          const rEnd = parseSheetDate(jr.endDate);
          if ((rStart && rStart >= sixMonthsAgo) || (rEnd && rEnd >= sixMonthsAgo)) {
            hasRecentDate = true;
            break;
          }
          for (const slot of jr.expenseSlots) {
            const sDate = parseSheetDate(slot.date);
            if (sDate && sDate >= sixMonthsAgo) {
              hasRecentDate = true;
              break;
            }
          }
          if (hasRecentDate) break;
        }
      }

      const passesFilter = showAll ? true : (hasDirectCosts && hasRecentDate);
      if (passesFilter) {
        jobs.push({ client, jobName, projectCode: row[2] || "", rows: jobRows, unreceivedCosts });
      }
    }

    jobs.sort((a, b) => {
      const da = parseSheetDate(a.rows[0]?.startDate);
      const db = parseSheetDate(b.rows[0]?.startDate);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db - da;
    });

    const payload = { success: true, jobs, directCostsMode };
    await set2TierCache(cacheKey, payload, 120);
    return res.status(200).json(payload);
  } catch (err) {
    console.error("❌ get_direct_costs_jobs error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetInvoiceJobs(req, res, sheets) {
  const { clientSheetId, showAll, bypassCache } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const cacheKey = `pulse:pma:invoice_jobs:${sheetIdClean}:${showAll ? "all" : "active"}`;

    if (!bypassCache) {
      const cached = await get2TierCache(cacheKey);
      if (cached && Array.isArray(cached.jobs) && cached.hasAccountingIntegration !== undefined) {
        return res.status(200).json(cached);
      }
    }

    const batchResp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetIdClean,
      ranges: ["Confirmed!A1:CR5000", "KeyInfo!Q4", "KeyInfo!Q8:Q9"],
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = batchResp.data.valueRanges?.[0]?.values || [];
    const accRows = batchResp.data.valueRanges?.[1]?.values || [];
    const crmRows = batchResp.data.valueRanges?.[2]?.values || [];
    let accountingTool = String(accRows?.[0]?.[0] || "None").trim();
    const crmTool = String(crmRows?.[0]?.[0] || "None").trim();
    const crmDrives = String(crmRows?.[1]?.[0] || "NA").trim();

    if ((accountingTool === "None" || !accountingTool) && redisClient?.isOpen) {
      try {
        const clientNameMatch = rows[1]?.[0] || "";
        if (clientNameMatch) {
          const normKey = String(clientNameMatch).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
          const rawCfg = await redisClient.get(`pulse:setup:${normKey}`);
          if (rawCfg) {
            const parsedCfg = JSON.parse(rawCfg);
            if (parsedCfg?.accountingTool) accountingTool = parsedCfg.accountingTool;
          }
        }
      } catch (_) { }
    }

    const hasAccountingIntegration = ["xero", "quickbooks", "qb"].some(t => accountingTool.toLowerCase().includes(t));

    const parseSheetDate = (d) => {
      if (!d) return null;
      const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (!m) return null;
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mIdx = months[m[2].toLowerCase()];
      if (mIdx === undefined) return null;
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
      return new Date(yr, mIdx, parseInt(m[1]));
    };

    const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
    const buildRowData = (rowNum, row, isParent) => ({
      rowNum, isParent,
      client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
      revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
      projectRetainer: colVal(row, 35), startDate: colVal(row, 37), endDate: colVal(row, 38),
      likelihood: null, copiedToConf: null,
      invoiceSlots: [1, 2, 3].map(n => {
        const base = n === 1 ? 41 : n === 2 ? 48 : 55;
        return {
          slotNum: n, amount: colVal(row, base), ref: colVal(row, base + 1), sentDate: colVal(row, base + 2),
          daysToPay: colVal(row, base + 3), status: canonicalizeInvoiceStatus(colVal(row, base + 4)), highlighted: false
        };
      }),
      expenseSlots: [1, 2, 3].map(n => {
        const base = n === 1 ? 75 : n === 2 ? 82 : 89;
        return {
          slotNum: n, description: colVal(row, base), amount: colVal(row, base + 1), vat: colVal(row, base + 2),
          date: colVal(row, base + 3), daysToPay: colVal(row, base + 4), status: canonicalizeExpenseStatus(colVal(row, base + 5)),
          transactionId: colVal(row, base + 6), highlighted: false
        };
      }),
    });

    const jobs = [];
    let ri = 1;
    while (ri < rows.length) {
      const row = rows[ri] || [];
      const client = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const revenueNum = parseFloat(String(row[32] || "").replace(/[£$€,\s]/g, "")) || 0;
      if (!client && !jobName) { ri++; continue; }

      const parentRowNum = ri + 1;
      const jobRows = [buildRowData(parentRowNum, row, true)];
      let cj = ri + 1;
      while (cj < rows.length) {
        const next = rows[cj] || [];
        const nc = String(next[0] || "").trim();
        const nj = String(next[1] || "").trim();
        const nRevenue = String(next[32] || "").trim();
        const nBudget = parseFloat(String(next[33] || "").replace(/[£$€,\s]/g, "")) || 0;
        const nStart = String(next[37] || "").trim();
        if (nc === client && nj === jobName && !nRevenue && !nBudget && !nStart) {
          jobRows.push(buildRowData(cj + 1, next, false));
          cj++;
        } else {
          break;
        }
      }
      ri = cj;

      let realInvoicedTotal = 0;
      for (const jr of jobRows) {
        for (const slot of jr.invoiceSlots) {
          const ref = String(slot.ref || "").trim();
          const isReal = ref && !isPlaceholderInvoice(ref);
          if (isReal) realInvoicedTotal += parseFloat(String(slot.amount || "").replace(/[£$€,\s]/g, "")) || 0;
        }
      }
      const uninvoicedAmount = revenueNum - realInvoicedTotal;
      const passesFilter = showAll || uninvoicedAmount > 0;
      if (passesFilter) {
        jobs.push({ client, jobName, projectCode: row[2] || "", rows: jobRows, uninvoicedAmount });
      }
    }

    jobs.sort((a, b) => {
      const da = parseSheetDate(a.rows[0]?.startDate);
      const db = parseSheetDate(b.rows[0]?.startDate);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db - da;
    });

    const payload = { success: true, jobs, accountingTool, crmTool, crmDrives, hasAccountingIntegration };
    await set2TierCache(cacheKey, payload, 120);
    return res.status(200).json(payload);
  } catch (err) {
    console.error("❌ get_invoice_jobs error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetAllClientJobs(req, res, sheets) {
  const { clientSheetId, tabName = "All", bypassCache } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  if (tabName && tabName !== "All" && tabName !== "Confirmed" && tabName !== "Pipeline") {
    return res.status(400).json({ success: false, error: "Invalid tabName. Must be All, Confirmed, or Pipeline." });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const cacheKey = `pulse:pma:jobs:${sheetIdClean}:${tabName || "All"}`;

    if (!bypassCache) {
      const cached = await get2TierCache(cacheKey);
      if (cached && Array.isArray(cached.jobs) && cached.hasAccountingIntegration !== undefined) {
        return res.status(200).json(cached);
      }
    }

    let confRows = [];
    let pipeRows = [];
    let productLines = [];
    let leadSources = [];
    const notesBySheet = { Confirmed: [], Pipeline: [] };

    let accountingTool = "None";
    let crmTool = "None";
    let crmDrives = "NA";
    let noEndDateRetainerMonths = 18;

    if (tabName === "All" || !tabName) {
      try {
        const batchResp = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: sheetIdClean,
          ranges: ["Confirmed!A1:DD5000", "Pipeline!A1:DD5000", "KeyInfo!C23:C26", "KeyInfo!G32:G75", "KeyInfo!Q4", "KeyInfo!Q8:Q9", "KeyInfo!D18"],
          valueRenderOption: "FORMATTED_VALUE",
        });
        confRows = batchResp.data.valueRanges?.[0]?.values || [];
        pipeRows = batchResp.data.valueRanges?.[1]?.values || [];
        const plData = batchResp.data.valueRanges?.[2]?.values || [];
        const lsData = batchResp.data.valueRanges?.[3]?.values || [];
        const accData = batchResp.data.valueRanges?.[4]?.values || [];
        const crmData = batchResp.data.valueRanges?.[5]?.values || [];
        const d18Data = batchResp.data.valueRanges?.[6]?.values || [];
        productLines = plData.flat().map(v => String(v || "").trim()).filter(Boolean);
        leadSources = lsData.flat().map(v => String(v || "").trim()).filter(Boolean);
        if (accData?.[0]?.[0]) accountingTool = String(accData[0][0]).trim();
        if (crmData?.[0]?.[0]) crmTool = String(crmData[0][0]).trim();
        if (crmData?.[1]?.[0]) crmDrives = String(crmData[1][0]).trim();
        const parsedD18 = parseInt(String(d18Data?.[0]?.[0] || "").trim(), 10);
        if (!isNaN(parsedD18) && parsedD18 > 0) noEndDateRetainerMonths = parsedD18;

        if ((accountingTool === "None" || !accountingTool) && redisClient?.isOpen) {
          try {
            const clientNameMatch = confRows[1]?.[0] || pipeRows[1]?.[0] || "";
            if (clientNameMatch) {
              const normKey = String(clientNameMatch).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
              const rawCfg = await redisClient.get(`pulse:setup:${normKey}`);
              if (rawCfg) {
                const parsedCfg = JSON.parse(rawCfg);
                if (parsedCfg?.accountingTool) accountingTool = parsedCfg.accountingTool;
              }
            }
          } catch (_) { }
        }
      } catch (batchErr) {
        try {
          const cResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: "Confirmed!A1:DD5000",
            valueRenderOption: "FORMATTED_VALUE",
          });
          confRows = cResp.data.values || [];
        } catch (_) { }
        try {
          const pResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: "Pipeline!A1:DD5000",
            valueRenderOption: "FORMATTED_VALUE",
          });
          pipeRows = pResp.data.values || [];
        } catch (_) { }
      }
    } else {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: `${tabName}!A1:DD5000`,
        valueRenderOption: "FORMATTED_VALUE",
      });
      if (tabName === "Confirmed") {
        confRows = resp.data.values || [];
      } else {
        pipeRows = resp.data.values || [];
      }
      try {
        const keyInfoResp = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: sheetIdClean,
          ranges: ["KeyInfo!C23:C26", "KeyInfo!G32:G75", "KeyInfo!Q4", "KeyInfo!Q8:Q9", "KeyInfo!D18"],
          valueRenderOption: "FORMATTED_VALUE"
        });
        const plData = keyInfoResp.data.valueRanges?.[0]?.values || [];
        const lsData = keyInfoResp.data.valueRanges?.[1]?.values || [];
        const accData = keyInfoResp.data.valueRanges?.[2]?.values || [];
        const crmData = keyInfoResp.data.valueRanges?.[3]?.values || [];
        const d18Data = keyInfoResp.data.valueRanges?.[4]?.values || [];
        productLines = plData.flat().map(v => String(v || "").trim()).filter(Boolean);
        leadSources = lsData.flat().map(v => String(v || "").trim()).filter(Boolean);
        if (accData?.[0]?.[0]) accountingTool = String(accData[0][0]).trim();
        if (crmData?.[0]?.[0]) crmTool = String(crmData[0][0]).trim();
        if (crmData?.[1]?.[0]) crmDrives = String(crmData[1][0]).trim();
        const parsedD18 = parseInt(String(d18Data?.[0]?.[0] || "").trim(), 10);
        if (!isNaN(parsedD18) && parsedD18 > 0) noEndDateRetainerMonths = parsedD18;

        if ((accountingTool === "None" || !accountingTool) && redisClient?.isOpen) {
          try {
            const clientNameMatch = confRows[1]?.[0] || pipeRows[1]?.[0] || "";
            if (clientNameMatch) {
              const normKey = String(clientNameMatch).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
              const rawCfg = await redisClient.get(`pulse:setup:${normKey}`);
              if (rawCfg) {
                const parsedCfg = JSON.parse(rawCfg);
                if (parsedCfg?.accountingTool) accountingTool = parsedCfg.accountingTool;
              }
            }
          } catch (_) { }
        }
      } catch (_) { }
    }

    // Phase 2 Optimization: Scoped cell notes range based on actual active job rows in the sheet
    // (confRows.length can be 5000 due to formula columns BT:DD, so find the last row with actual job/slot data)
    const getLastActiveRowCount = (rowsArr) => {
      if (!Array.isArray(rowsArr)) return 0;
      for (let i = rowsArr.length - 1; i >= 0; i--) {
        const r = rowsArr[i];
        if (r && (r[0] || r[1] || r[32] || r[41] || r[42] || r[48] || r[55] || r[75] || r[82] || r[89])) {
          return i + 1;
        }
      }
      return 0;
    };
    const confNoteMaxRow = Math.min(Math.max(getLastActiveRowCount(confRows) + 5, 20), 1000);
    const pipeNoteMaxRow = Math.min(Math.max(getLastActiveRowCount(pipeRows) + 5, 20), 1000);

    const notesRanges = (tabName === "All" || !tabName)
      ? [`Confirmed!A1:CL${confNoteMaxRow}`, `Pipeline!A1:CL${pipeNoteMaxRow}`]
      : (tabName === "Confirmed" ? [`Confirmed!A1:CL${confNoteMaxRow}`] : [`Pipeline!A1:CL${pipeNoteMaxRow}`]);

    if (notesRanges.length > 0) {
      try {
        const notesResp = await sheets.spreadsheets.get({
          spreadsheetId: sheetIdClean,
          ranges: notesRanges,
          fields: "sheets(properties.title,data.rowData.values.note)",
        });
        (notesResp.data?.sheets || []).forEach((s) => {
          const title = s.properties?.title;
          if (title) {
            notesBySheet[title] = s.data?.[0]?.rowData || [];
          }
        });
      } catch (err) {
        console.warn("⚠️ get_all_client_jobs: could not fetch cell notes:", err?.message);
      }
    }

    const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";

    const getNote = (sheetTitle, rowNum, colIdx) => {
      const sData = notesBySheet[sheetTitle];
      if (!sData) return "";
      const r = sData[rowNum - 1];
      if (!r || !r.values) return "";
      return r.values[colIdx]?.note || "";
    };

    // Dynamically locate "Copied to confirmed tab?" column in Pipeline headers, fallback to 107 (Column DD)
    let pipelineCopiedColIdx = 107;
    if (pipeRows && pipeRows.length > 0) {
      for (let r = 0; r < Math.min(pipeRows.length, 5); r++) {
        const hRow = pipeRows[r] || [];
        const found = hRow.findIndex((h) => {
          const s = String(h || "").trim().toLowerCase();
          return s.includes("copied") || s.includes("conf?");
        });
        if (found !== -1) {
          pipelineCopiedColIdx = found;
          break;
        }
      }
    }

    const buildRowData = (rowNum, row, isParent, currentTab) => ({
      rowNum, isParent, tabName: currentTab,
      note: getNote(currentTab, rowNum, 0),
      client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
      dateConf: colVal(row, 3),
      leadSrc: colVal(row, 4),
      unevenSplit: colVal(row, 30),
      revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
      projectRetainer: colVal(row, 35), prodLine: colVal(row, 36),
      startDate: colVal(row, 37), endDate: colVal(row, 38),
      likelihood: currentTab === "Pipeline" ? colVal(row, 39) : (colVal(row, 39) || "100%"),
      copiedToConf: currentTab === "Pipeline" ? colVal(row, pipelineCopiedColIdx) : null,
      leftToInvoice: colVal(row, 74),
      costsOutstanding: colVal(row, 106),
      invoiceSlots: [1, 2, 3].map(n => {
        const base = n === 1 ? 41 : n === 2 ? 48 : 55;
        return {
          slotNum: n,
          amount: colVal(row, base),
          ref: colVal(row, base + 1),
          sentDate: colVal(row, base + 2),
          daysToPay: colVal(row, base + 3),
          status: canonicalizeInvoiceStatus(colVal(row, base + 4)),
          highlighted: false,
          note: getNote(currentTab, rowNum, base)
        };
      }),
      expenseSlots: [1, 2, 3].map(n => {
        const base = n === 1 ? 75 : n === 2 ? 82 : 89;
        return {
          slotNum: n,
          description: colVal(row, base),
          amount: colVal(row, base + 1),
          vat: colVal(row, base + 2),
          date: colVal(row, base + 3),
          daysToPay: colVal(row, base + 4),
          status: canonicalizeExpenseStatus(colVal(row, base + 5)),
          transactionId: colVal(row, base + 6),
          highlighted: false,
          note: getNote(currentTab, rowNum, base)
        };
      }),
    });

    const deletedConfEntries = new Set(memoryCache.get(`deleted_job_rows:${sheetIdClean}:confirmed`) || []);
    const deletedPipeEntries = new Set(memoryCache.get(`deleted_job_rows:${sheetIdClean}:pipeline`) || []);

    const parseTabJobs = (rows, currentTab) => {
      const deletedEntriesSet = currentTab === "Pipeline" ? deletedPipeEntries : deletedConfEntries;
      const tabJobs = [];
      let ri = currentTab === "Pipeline" ? 5 : 1;
      while (ri < rows.length) {
        const row = rows[ri] || [];
        const parentRowNum = ri + 1;

        const client = String(row[0] || "").trim();
        const jobName = String(row[1] || "").trim();
        if (!client && !jobName) { ri++; continue; }

        const rowSig = `${parentRowNum}:${client.toLowerCase()}:${jobName.toLowerCase()}`;
        if (deletedEntriesSet.has(rowSig)) { ri++; continue; }

        const jobRows = [buildRowData(parentRowNum, row, true, currentTab)];
        let cj = ri + 1;
        while (cj < rows.length) {
          const next = rows[cj] || [];
          const nc = String(next[0] || "").trim();
          const nj = String(next[1] || "").trim();
          const nRevenue = String(next[32] || "").trim();
          const nStart = String(next[37] || "").trim();
          const nEnd = String(next[38] || "").trim();

          const hasParentIndicators = (nStart !== "" || nEnd !== "") || (nRevenue !== "" && parseFloat(String(nRevenue).replace(/[^0-9.-]/g, "")) > 0);
          if (hasParentIndicators) {
            break;
          }

          const clientMatches = !nc || nc.toLowerCase() === client.toLowerCase();
          const jobMatches = (nj && nj.toLowerCase() === jobName.toLowerCase()) || (!nj && (next[41] || next[42] || next[75] || next[76]));

          if (clientMatches && jobMatches) {
            jobRows.push(buildRowData(cj + 1, next, false, currentTab));
            cj++;
          } else {
            break;
          }
        }
        ri = cj;

        // Skip pipeline jobs that have been copied to confirmed tab (Column DD == "Yes")
        if (currentTab === "Pipeline") {
          const parentCopiedVal = String(colVal(row, pipelineCopiedColIdx) || "").trim().toLowerCase();
          if (parentCopiedVal === "yes" || parentCopiedVal === "y") {
            continue;
          }
        }

        tabJobs.push({
          id: `${currentTab.toLowerCase()}_${parentRowNum}`,
          tabName: currentTab,
          status: currentTab,
          client,
          jobName,
          projectCode: row[2] || "",
          copiedToConf: currentTab === "Pipeline" ? colVal(row, pipelineCopiedColIdx) : null,
          note: getNote(currentTab, parentRowNum, 0),
          rows: jobRows
        });
      }
      return tabJobs;
    };

    let jobs = [];
    if (tabName === "All" || !tabName) {
      const confJobs = parseTabJobs(confRows, "Confirmed");
      const pipeJobs = parseTabJobs(pipeRows, "Pipeline");
      jobs = [...confJobs, ...pipeJobs];
    } else if (tabName === "Confirmed") {
      jobs = parseTabJobs(confRows, "Confirmed");
    } else {
      jobs = parseTabJobs(pipeRows, "Pipeline");
    }

    const parseSheetDate = (d) => {
      if (!d) return null;
      const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (!m) return null;
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mIdx = months[m[2].toLowerCase()];
      if (mIdx === undefined) return null;
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
      return new Date(yr, mIdx, parseInt(m[1]));
    };

    jobs.sort((a, b) => {
      const da = parseSheetDate(a.rows[0]?.startDate);
      const db = parseSheetDate(b.rows[0]?.startDate);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db - da;
    });

    const distinctPl = new Set(productLines);
    const distinctLs = new Set(leadSources);
    const distinctClients = new Set();
    jobs.forEach(j => {
      if (j.client) distinctClients.add(String(j.client).trim());
      j.rows?.forEach(r => {
        if (r.client) distinctClients.add(String(r.client).trim());
        if (r.prodLine) distinctPl.add(String(r.prodLine).trim());
        if (r.leadSrc) distinctLs.add(String(r.leadSrc).trim());
      });
    });
    productLines = Array.from(distinctPl).filter(Boolean).sort();
    leadSources = Array.from(distinctLs).filter(Boolean).sort();
    const existingClients = Array.from(distinctClients).filter(Boolean).sort();
    const hasAccountingIntegration = ["xero", "quickbooks", "qb"].some(t => accountingTool.toLowerCase().includes(t));
    const payload = { success: true, jobs, productLines, leadSources, existingClients, accountingTool, crmTool, crmDrives, hasAccountingIntegration, noEndDateRetainerMonths };
    await set2TierCache(cacheKey, payload, 120);
    return res.status(200).json(payload);
  } catch (err) {
    console.error("❌ get_all_client_jobs error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateJobField(req, res, sheets) {
  const { clientSheetId, tabName, cellRef, value, colLetter, rowNum, fieldName, endClientName, jobName } = req.body;
  if (!clientSheetId || !tabName || !cellRef) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  if (tabName !== "Confirmed" && tabName !== "Pipeline") {
    return res.status(400).json({ success: false, error: "Invalid tabName. Must be Confirmed or Pipeline." });
  }
  const cleanCellRef = String(cellRef).trim().toUpperCase();
  if (!/^[A-Z]{1,2}\d{1,4}$/.test(cleanCellRef)) {
    return res.status(400).json({ success: false, error: "Invalid cellRef format." });
  }
  const parsedColLetters = cleanCellRef.replace(/[0-9]/g, "");
  const parsedRowNum = parseInt(cleanCellRef.replace(/[^0-9]/g, ""), 10);
  const colIdx0 = parsedColLetters.split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const isProtectedFormulaCol =
    (colIdx0 >= 5 && colIdx0 <= 29) ||
    colIdx0 === 31 ||
    colIdx0 === 40 ||
    (colIdx0 >= 60 && colIdx0 <= 74) ||
    (colIdx0 >= 96 && colIdx0 <= 106);
  if (!Number.isFinite(parsedRowNum) || parsedRowNum < 2 || isProtectedFormulaCol) {
    return res.status(400).json({ success: false, error: "Cannot overwrite header row or protected formula columns." });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const targetCol = (colLetter || cellRef.replace(/[0-9]/g, "")).toUpperCase();
    const targetRow = parseInt(rowNum || cellRef.replace(/[^0-9]/g, ""), 10);
    const normalizedVal = (targetCol === "AM" && isNoEndDateSentinel(value)) ? NO_END_DATE_SHEET_VALUE : value;
    const safeValue = sanitizeFormulaInput(normalizedVal);
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetIdClean,
      range: `${tabName}!${cellRef}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[safeValue]] }
    });

    // If Revenue (AG), Direct Costs (AH), Dates (AL, AM), or Type (AJ) change, synchronize placeholders or provision retainer rows
    let backgroundProvisioning = false;
    let invoiceSlotUpdates = [];
    let expenseSlotUpdates = [];
    if ((tabName === "Confirmed" || tabName === "Pipeline") && targetRow) {
      if (tabName === "Confirmed" && targetCol === "AJ" && String(safeValue || "").trim().toLowerCase() === "retainer") {
        await provisionRetainerChildRows_(sheets, {
          clientSheetId: sheetIdClean,
          masterSheetId: req.body.masterSheetId,
          clientName: req.body.clientName || "",
          parentRowNum: targetRow,
          client: endClientName || "",
          jobName: jobName || "",
        });
      } else if (targetCol === "AG") {
        const revNum = parseFloat(String(safeValue || "").replace(/[£$€,\s]/g, "")) || 0;
        const invAdj = await adjustJobInvoicePlaceholders_(sheets, sheetIdClean, tabName, [targetRow], revNum, req.body.masterSheetId).catch(e => {
          console.warn("Job revenue placeholder adjust failed:", e.message);
          return null;
        });
        if (invAdj?.slotUpdates) invoiceSlotUpdates = invAdj.slotUpdates;
      } else if (targetCol === "AH") {
        const costNum = parseFloat(String(safeValue || "").replace(/[£$€,\s]/g, "")) || 0;
        const expAdj = await adjustJobExpensePlaceholders_(sheets, sheetIdClean, tabName, [targetRow], costNum, req.body.masterSheetId).catch(e => {
          console.warn("Job expense placeholder adjust failed:", e.message);
          return null;
        });
        if (expAdj?.slotUpdates) expenseSlotUpdates = expAdj.slotUpdates;
      } else if (targetCol === "AL" || targetCol === "AM") {
        const [invAdj, expAdj] = await Promise.all([
          adjustJobInvoicePlaceholders_(sheets, sheetIdClean, tabName, [targetRow], undefined, req.body.masterSheetId).catch(e => {
            console.warn("Job date invoice placeholder adjust failed:", e.message);
            return null;
          }),
          adjustJobExpensePlaceholders_(sheets, sheetIdClean, tabName, [targetRow], undefined, req.body.masterSheetId).catch(e => {
            console.warn("Job date expense placeholder adjust failed:", e.message);
            return null;
          })
        ]);
        if (invAdj?.slotUpdates) invoiceSlotUpdates = invAdj.slotUpdates;
        if (expAdj?.slotUpdates) expenseSlotUpdates = expAdj.slotUpdates;
      }
    }

    const FIELD_NAMES = {
      A: "Client",
      B: "Job Name",
      C: "Project Code",
      D: "Date Confirmed",
      E: "Lead Source",
      AE: "Revenue Split",
      AG: "Revenue",
      AH: "Direct Costs",
      AI: "VAT",
      AJ: "Type",
      AK: "Product Line",
      AL: "Start Date",
      AM: "End Date",
      AN: "Likelihood",
      DD: "Copied to Confirmed"
    };
    const resolvedFieldName = fieldName || FIELD_NAMES[targetCol] || `Field ${targetCol}`;

    // Resolve clientName (the Pulse tenant, e.g. "Ayefour Design")
    let resolvedClient = req.body.clientName || "";
    if (!resolvedClient) {
      resolvedClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }

    // Resolve endClient and jobName
    let resolvedEndClient = endClientName || "";
    let resolvedJobName = jobName || "";

    if ((!resolvedEndClient || !resolvedJobName) && targetRow) {
      try {
        const nameResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `${tabName}!A${targetRow}:B${targetRow}`,
            valueRenderOption: "FORMATTED_VALUE"
          })
        );
        const rowVals = nameResp.data.values?.[0] || [];
        if (!resolvedEndClient && rowVals[0]) resolvedEndClient = String(rowVals[0]).trim();
        if (!resolvedJobName && rowVals[1]) resolvedJobName = String(rowVals[1]).trim();
      } catch (nameErr) {
        console.warn("⚠️ Could not read job row identity:", nameErr.message);
      }
    }

    // If the edit itself changed column A (End Client) or B (Job Name), reflect the new value
    if (targetCol === "A" && value) resolvedEndClient = value;
    if (targetCol === "B" && value) resolvedJobName = value;

    let jobIdentifier = "";
    if (resolvedEndClient && resolvedJobName) {
      jobIdentifier = `"${resolvedEndClient} - ${resolvedJobName}"`;
    } else if (resolvedJobName) {
      jobIdentifier = `"${resolvedJobName}"`;
    } else if (resolvedEndClient) {
      jobIdentifier = `"${resolvedEndClient}"`;
    } else {
      jobIdentifier = `Row ${targetRow || cellRef}`;
    }

    const displayLogVal = targetCol === "AM" ? formatJobEndDateDisplay(normalizedVal, "") : value;
    const valStr = displayLogVal !== "" && displayLogVal !== null && displayLogVal !== undefined ? ` to "${displayLogVal}"` : " (cleared)";
    const summary = `Updated ${resolvedFieldName} for ${jobIdentifier}${valStr}`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: resolvedClient,
      category: "JOB",
      action: `Job ${resolvedFieldName} Updated`,
      summary,
      details: {
        tabName,
        cellRef,
        field: resolvedFieldName,
        endClient: resolvedEndClient,
        jobName: resolvedJobName,
        newValue: value,
        clientName: resolvedClient
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, backgroundProvisioning, invoiceSlotUpdates, expenseSlotUpdates });
  } catch (err) {
    console.error("❌ update_job_field error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateJobFields(req, res, sheets) {
  const { clientSheetId, tabName, rowNum, updates, endClientName, jobName } = req.body;
  if (!clientSheetId || !tabName || !Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ success: false, error: "Missing required fields or empty updates" });
  }
  if (tabName !== "Confirmed" && tabName !== "Pipeline") {
    return res.status(400).json({ success: false, error: "Invalid tabName. Must be Confirmed or Pipeline." });
  }
  for (const u of updates) {
    const targetRef = String(u.cellRef || `${u.colLetter || ""}${u.rowNum || rowNum || ""}`).trim().toUpperCase();
    if (!/^[A-Z]{1,2}\d{1,4}$/.test(targetRef)) {
      return res.status(400).json({ success: false, error: `Invalid cell reference in updates: ${targetRef}` });
    }
    const parsedColLetters = targetRef.replace(/[0-9]/g, "");
    const parsedRowNum = parseInt(targetRef.replace(/[^0-9]/g, ""), 10);
    const colIdx0 = parsedColLetters.split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const isProtectedFormulaCol =
      (colIdx0 >= 5 && colIdx0 <= 29) ||
      colIdx0 === 31 ||
      colIdx0 === 40 ||
      (colIdx0 >= 60 && colIdx0 <= 74) ||
      (colIdx0 >= 96 && colIdx0 <= 106);
    if (!Number.isFinite(parsedRowNum) || parsedRowNum < 2 || isProtectedFormulaCol) {
      return res.status(400).json({ success: false, error: `Cannot overwrite header row or protected formula column: ${targetRef}` });
    }
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

    const targetRowNum = rowNum ? parseInt(rowNum, 10) : null;
    const typeUpdate = updates.find(u => (u.colLetter || "").toUpperCase() === "AJ" || (u.cellRef || "").toUpperCase().startsWith("AJ"));
    let isRetainerJob = false;
    if (tabName === "Confirmed" && targetRowNum) {
      if (req.body.isRetainer !== undefined) {
        isRetainerJob = Boolean(req.body.isRetainer);
      } else if (typeUpdate) {
        isRetainerJob = String(typeUpdate.value || "").trim().toLowerCase() === "retainer";
      } else {
        try {
          const typeCellResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `${tabName}!AJ${targetRowNum}`,
            valueRenderOption: "FORMATTED_VALUE"
          });
          const val = typeCellResp.data?.values?.[0]?.[0] || "";
          isRetainerJob = String(val).trim().toLowerCase() === "retainer";
        } catch (e) {
          console.warn("Could not check job type cell:", e.message);
        }
      }
    }

    const startDateUpdate = updates.find(u => (u.colLetter || "").toUpperCase() === "AL" || (u.cellRef || "").toUpperCase().startsWith("AL"));
    const endDateUpdate = updates.find(u => (u.colLetter || "").toUpperCase() === "AM" || (u.cellRef || "").toUpperCase().startsWith("AM"));
    const isChangingToRetainer = tabName === "Confirmed" && typeUpdate && String(typeUpdate.value || "").trim().toLowerCase() === "retainer";
    const isExistingRetainer = isRetainerJob && !isChangingToRetainer;

    const isSettingRetainer = updates.some(
      u => ((u.colLetter || "").toUpperCase() === "AJ" || (u.cellRef || "").toUpperCase().startsWith("AJ")) &&
        String(u.value || "").trim().toLowerCase() === "retainer"
    );

    // If it's an existing retainer on Confirmed and start/end dates changed, exclude those date columns from initial write
    // so executeChangeRetainerStartDate / executeChangeRetainerEndDate can inspect current sheet values and handle row manipulation safely.
    const initialUpdates = updates.filter(u => {
      const colUp = (u.colLetter || String(u.cellRef || "").replace(/[0-9]/g, "")).toUpperCase();
      if (isExistingRetainer) {
        if (startDateUpdate && (colUp === "AL" || colUp === "AM")) return false;
        if (endDateUpdate && colUp === "AM") return false;
      }
      return true;
    });

    if (initialUpdates.length > 0) {
      const data = initialUpdates.map(u => {
        const colUp = (u.colLetter || String(u.cellRef || "").replace(/[0-9]/g, "")).toUpperCase();
        let v = u.value;
        if (colUp === "AM" && (isNoEndDateSentinel(v) || (isSettingRetainer && !String(v || "").trim()))) {
          v = NO_END_DATE_SHEET_VALUE;
        }
        return {
          range: `${tabName}!${u.cellRef || `${u.colLetter}${u.rowNum || rowNum}`}`,
          values: [[sanitizeFormulaInput(v)]]
        };
      });

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data
        }
      });
    }

    // If Revenue (AG), Direct Costs (AH), Dates (AL, AM), or Type (AJ) change, synchronize placeholders or provision retainer rows
    let backgroundProvisioning = false;
    let invoiceSlotUpdates = [];
    let expenseSlotUpdates = [];
    let retainerTrimmed = 0;
    let retainerGrown = 0;

    let resolvedClient = req.body.clientName || "";
    if (!resolvedClient) {
      resolvedClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const clientUpdate = updates.find(u => (u.colLetter || "").toUpperCase() === "A");
    const jobNameUpdate = updates.find(u => (u.colLetter || "").toUpperCase() === "B");
    const effectiveClient = clientUpdate ? String(clientUpdate.value || "") : (endClientName || "");
    const effectiveJobName = jobNameUpdate ? String(jobNameUpdate.value || "") : (jobName || "");

    if ((tabName === "Confirmed" || tabName === "Pipeline") && targetRowNum) {
      const revUpdate = updates.find(u => (u.colLetter || "").toUpperCase() === "AG" || (u.cellRef || "").toUpperCase().startsWith("AG"));
      const costUpdate = updates.find(u => (u.colLetter || "").toUpperCase() === "AH" || (u.cellRef || "").toUpperCase().startsWith("AH"));
      const dateUpdate = updates.find(u => ["AL", "AM"].includes((u.colLetter || "").toUpperCase()) || ["AL", "AM"].some(c => (u.cellRef || "").toUpperCase().startsWith(c)));

      if (isChangingToRetainer) {
        await provisionRetainerChildRows_(sheets, {
          clientSheetId: sheetIdClean,
          masterSheetId: req.body.masterSheetId,
          clientName: resolvedClient,
          parentRowNum: targetRowNum,
          client: effectiveClient,
          jobName: effectiveJobName,
        });
      } else if (isExistingRetainer) {
        if (startDateUpdate) {
          const retStartResult = await executeChangeRetainerStartDate(sheets, {
            clientSheetId: sheetIdClean,
            masterSheetId: req.body.masterSheetId,
            client: effectiveClient,
            jobName: effectiveJobName,
            parentRowNum: targetRowNum,
            newStartDate: startDateUpdate.value,
            newEndDate: endDateUpdate ? endDateUpdate.value : undefined,
            newMonthlyAmount: revUpdate ? revUpdate.value : undefined,
            clientName: resolvedClient,
            automationCommanderSheetId: req.body.automationCommanderSheetId
          });
          if (retStartResult && !retStartResult.success) {
            return res.status(200).json(retStartResult);
          }
          retainerTrimmed = retStartResult?.trimmed || 0;
          retainerGrown = retStartResult?.grown || 0;
        } else if (endDateUpdate) {
          const retEndResult = await executeChangeRetainerEndDate(sheets, {
            clientSheetId: sheetIdClean,
            masterSheetId: req.body.masterSheetId,
            client: effectiveClient,
            jobName: effectiveJobName,
            parentRowNum: targetRowNum,
            newEndDate: endDateUpdate.value,
            noEndDate: isNoEndDateSentinel(endDateUpdate.value),
            clientName: resolvedClient,
            automationCommanderSheetId: req.body.automationCommanderSheetId
          });
          if (retEndResult && !retEndResult.success) {
            return res.status(200).json(retEndResult);
          }
          retainerTrimmed = retEndResult?.trimmed || 0;
          retainerGrown = retEndResult?.grown || 0;
        }
      } else {
        // Standard Project: adjust invoice & expense placeholders across the 3 slots
        if (revUpdate) {
          const revNum = parseFloat(String(revUpdate.value || "").replace(/[£$€,\s]/g, "")) || 0;
          const invAdj = await adjustJobInvoicePlaceholders_(sheets, sheetIdClean, tabName, [targetRowNum], revNum, req.body.masterSheetId).catch(e => {
            console.warn("Job fields revenue placeholder adjust failed:", e.message);
            return null;
          });
          if (invAdj?.slotUpdates) invoiceSlotUpdates = invAdj.slotUpdates;
        } else if (dateUpdate) {
          const invAdj = await adjustJobInvoicePlaceholders_(sheets, sheetIdClean, tabName, [targetRowNum], undefined, req.body.masterSheetId).catch(e => {
            console.warn("Job fields date invoice placeholder adjust failed:", e.message);
            return null;
          });
          if (invAdj?.slotUpdates) invoiceSlotUpdates = invAdj.slotUpdates;
        }

        if (costUpdate) {
          const costNum = parseFloat(String(costUpdate.value || "").replace(/[£$€,\s]/g, "")) || 0;
          const expAdj = await adjustJobExpensePlaceholders_(sheets, sheetIdClean, tabName, [targetRowNum], costNum, req.body.masterSheetId).catch(e => {
            console.warn("Job fields expense placeholder adjust failed:", e.message);
            return null;
          });
          if (expAdj?.slotUpdates) expenseSlotUpdates = expAdj.slotUpdates;
        } else if (dateUpdate) {
          const expAdj = await adjustJobExpensePlaceholders_(sheets, sheetIdClean, tabName, [targetRowNum], undefined, req.body.masterSheetId).catch(e => {
            console.warn("Job fields date expense placeholder adjust failed:", e.message);
            return null;
          });
          if (expAdj?.slotUpdates) expenseSlotUpdates = expAdj.slotUpdates;
        }
      }
    }

    const resolvedEndClient = effectiveClient || endClientName || "";
    const resolvedJobName = effectiveJobName || jobName || "";
    const jobIdentifier = resolvedEndClient && resolvedJobName ? `"${resolvedEndClient} - ${resolvedJobName}"` : `Row ${rowNum}`;
    const fieldSummary = updates.map(u => u.fieldName || u.colLetter).join(", ");

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: resolvedClient,
      category: "JOB",
      action: "Job Fields Updated",
      summary: `Updated ${fieldSummary} for ${jobIdentifier}`,
      details: {
        tabName,
        rowNum,
        updates,
        endClient: resolvedEndClient,
        jobName: resolvedJobName,
        clientName: resolvedClient,
        isRetainer: isRetainerJob,
        trimmed: retainerTrimmed,
        grown: retainerGrown
      }
    }).catch(e => console.error("PMA log failed:", e));

    await invalidatePmaClientCache(sheetIdClean, req.body.masterSheetId, ["jobs", "invoices", "outgoings", "retainers", "cash"]).catch(e => console.warn("Cache invalidate failed in update_job_fields:", e.message));

    return res.status(200).json({
      success: true,
      backgroundProvisioning,
      invoiceSlotUpdates,
      expenseSlotUpdates,
      trimmed: retainerTrimmed,
      grown: retainerGrown,
      isRetainer: isRetainerJob
    });
  } catch (err) {
    console.error("❌ update_job_fields error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function insertChildJobRow_(sheets, sheetIdClean, jobLastRow, jobClient, jobName, options = {}) {
  const { cachedAllRows = null, deferValueWrites = false } = options;
  const canReuseCachedRows = Array.isArray(cachedAllRows) && cachedAllRows.length >= 200;

  const [metaResp, fullResp] = await Promise.all([
    sheets.spreadsheets.get({
      spreadsheetId: sheetIdClean,
      fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
    }),
    canReuseCachedRows
      ? Promise.resolve(null)
      : sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
  ]);
  const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
  if (!confirmedSheet) throw new Error("Confirmed tab not found");
  const gridSheetId = confirmedSheet.properties.sheetId;
  const currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;
  const existingRowGroups = confirmedSheet.rowGroups || [];

  const allRows = canReuseCachedRows ? cachedAllRows : (fullResp?.data?.values || []);
  let trueLastRow = 0;
  for (let r = allRows.length - 1; r >= 0; r--) {
    const row = allRows[r] || [];
    const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
    const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
    const z3 = row.slice(41, 60).some(c => c !== "" && c != null);
    const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
    if (z1 || z2 || z3 || z4) { trueLastRow = r + 1; break; }
  }
  if (trueLastRow < jobLastRow) trueLastRow = jobLastRow;

  const jobVAT = allRows[jobLastRow - 1]?.[34] ?? "";

  const sourceRowIndex0 = trueLastRow;
  const destRowIndex0 = jobLastRow;
  const targetRowNum = jobLastRow + 1;

  const baseStructuralRequests = [];
  if (currentMaxRows - (trueLastRow + 1) < 1) {
    baseStructuralRequests.push({
      insertDimension: {
        range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 },
        inheritFromBefore: true,
      },
    });
  }
  baseStructuralRequests.push({
    moveDimension: {
      source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: sourceRowIndex0, endIndex: sourceRowIndex0 + 1 },
      destinationIndex: destRowIndex0,
    },
  });

  const groupRequests = [];
  const destRowIndex1based0 = jobLastRow;
  const coveringGroup = existingRowGroups.find(g =>
    g.range?.startIndex <= destRowIndex1based0 - 1 && g.range?.endIndex >= destRowIndex1based0
  );
  if (coveringGroup) {
    const groupEndIdx = coveringGroup.range.endIndex + 1;
    groupRequests.push(
      {
        deleteDimensionGroup: {
          range: {
            sheetId: gridSheetId, dimension: "ROWS",
            startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex,
          }
        }
      },
      {
        addDimensionGroup: {
          range: {
            sheetId: gridSheetId, dimension: "ROWS",
            startIndex: coveringGroup.range.startIndex, endIndex: groupEndIdx,
          }
        }
      },
    );
    if (coveringGroup.collapsed) {
      groupRequests.push(
        {
          updateDimensionGroup: {
            dimensionGroup: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: groupEndIdx },
              depth: coveringGroup.depth || 1,
              collapsed: true,
            },
            fields: "collapsed",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: groupEndIdx },
            properties: { hiddenByUser: true },
            fields: "hiddenByUser",
          },
        }
      );
    } else {
      groupRequests.push({
        updateDimensionProperties: {
          range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: groupEndIdx },
          properties: { hiddenByUser: false },
          fields: "hiddenByUser",
        },
      });
    }
  } else {
    groupRequests.push(
      {
        addDimensionGroup: {
          range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: destRowIndex1based0, endIndex: destRowIndex1based0 + 1 },
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: destRowIndex1based0, endIndex: destRowIndex1based0 + 1 },
          properties: { hiddenByUser: false },
          fields: "hiddenByUser",
        },
      },
    );
  }

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: { requests: [...baseStructuralRequests, ...groupRequests] },
    });
  } catch (combinedErr) {
    console.log(`  ⚠ Combined move+group failed (${combinedErr.message}), falling back to moveDimension only`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: { requests: baseStructuralRequests },
    });
  }

  const rowValueUpdates = [
    { range: `Confirmed!A${targetRowNum}`, values: [[sanitizeFormulaInput(jobClient || "")]] },
    { range: `Confirmed!B${targetRowNum}`, values: [[sanitizeFormulaInput(jobName || "")]] },
    { range: `Confirmed!AI${targetRowNum}`, values: [[jobVAT]] },
  ];

  if (deferValueWrites) {
    return { targetRowNum, valueUpdates: rowValueUpdates };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetIdClean,
    requestBody: {
      valueInputOption: "RAW",
      data: rowValueUpdates,
    },
  });

  return targetRowNum;
}

function generateAutoPlaceholderRef_(prefix = "PLACE-INV") {
  const ms = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const now = new Date();
  const dateStr = `${ms[now.getMonth()]}-${String(now.getFullYear()).slice(-2)}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${dateStr}-${rand}`;
}

export function calculateRevenueSplit(amount, mode, start, end, retainerDay = 28, xeroCount = 0) {
  const startDate = start instanceof Date && !isNaN(start.getTime()) ? start : new Date();
  const endDate = end instanceof Date && !isNaN(end.getTime()) ? end : startDate;
  const midDate = new Date(startDate.getTime() + (endDate.getTime() - startDate.getTime()) / 2);
  const modeClean = String(mode || "50-50").trim().toLowerCase();

  if (modeClean === "even-split") {
    const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    const totalMonths = Math.round(diffDays / 30.4375);
    const slotsNeeded = Math.max(1, totalMonths - xeroCount);
    const amtPerMonth = amount / slotsNeeded;
    const allocations = [];
    for (let m = 0; m < slotsNeeded; m++) {
      const invDate = new Date(startDate.getFullYear(), startDate.getMonth() + xeroCount + m, retainerDay || 1);
      allocations.push({ amt: Math.round(amtPerMonth * 100) / 100, date: invDate });
    }
    return allocations;
  }

  let weights = [1];
  let dates = [endDate];

  if (modeClean.includes("50-50")) {
    if (xeroCount === 0) {
      weights = [0.5, 0.5];
      dates = [startDate, endDate];
    } else {
      weights = [1];
      dates = [endDate];
    }
  } else if (modeClean.includes("33-33-33")) {
    if (xeroCount === 0) {
      weights = [1 / 3, 1 / 3, 1 / 3];
      dates = [startDate, midDate, endDate];
    } else if (xeroCount === 1) {
      weights = [0.5, 0.5];
      dates = [midDate, endDate];
    } else {
      weights = [1];
      dates = [endDate];
    }
  } else if (modeClean.includes("50-25-25")) {
    if (xeroCount === 0) {
      weights = [0.5, 0.25, 0.25];
      dates = [startDate, midDate, endDate];
    } else if (xeroCount === 1) {
      weights = [0.5, 0.5];
      dates = [midDate, endDate];
    } else {
      weights = [1];
      dates = [endDate];
    }
  } else if (modeClean.includes("25-25-50")) {
    if (xeroCount === 0) {
      weights = [0.25, 0.25, 0.5];
      dates = [startDate, midDate, endDate];
    } else if (xeroCount === 1) {
      weights = [1 / 3, 2 / 3];
      dates = [midDate, endDate];
    } else {
      weights = [1];
      dates = [endDate];
    }
  } else if (modeClean.includes("25-75")) {
    if (xeroCount === 0) {
      weights = [0.25, 0.75];
      dates = [startDate, endDate];
    } else {
      weights = [1];
      dates = [endDate];
    }
  } else if (modeClean.includes("100 at start")) {
    weights = [1];
    dates = [startDate];
  } else {
    // default / "100 at end"
    weights = [1];
    dates = [endDate];
  }

  const allocations = [];
  for (let i = 0; i < weights.length; i++) {
    allocations.push({ amt: Math.round(amount * weights[i] * 100) / 100, date: dates[i] });
  }
  return allocations;
}

export async function resolveMasterSheetIdForClient_(sheets, sheetIdClean, clientName) {
  if (!sheetIdClean) return null;
  const cleanId = extractSheetIdFromUrl(sheetIdClean) || sheetIdClean;
  try {
    const d1Res = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanId,
      range: "KeyInfo!D1",
    }));
    const d1Val = d1Res.data?.values?.[0]?.[0];
    if (d1Val) return extractSheetIdFromUrl(d1Val) || String(d1Val).trim();
  } catch (e) { }

  try {
    const clients = await loadClientsFromCommander(sheets);
    const found = clients.find(c =>
      (clientName && c.clientName && c.clientName.toLowerCase() === clientName.toLowerCase()) ||
      extractSheetIdFromUrl(c.clientSheetId) === cleanId ||
      extractSheetIdFromUrl(c.masterSheetId) === cleanId
    );
    if (found?.masterSheetId) {
      return extractSheetIdFromUrl(found.masterSheetId) || found.masterSheetId;
    }
  } catch (lookupErr) { }

  return null;
}

export function isAutoInvoicePlaceholderRef_(ref) {
  const r = String(ref || "").trim().toUpperCase();
  if (!r) return false;
  return r.startsWith("PLACE") || r.startsWith("MANUAL-INV") || r.startsWith("UNRECON-GAP");
}

export function isAutoExpensePlaceholderId_(id) {
  const cleanId = String(id || "").trim().toUpperCase();
  if (!cleanId) return false;
  return (
    cleanId.startsWith("PLACE-EXP") ||
    cleanId.startsWith("PLACE-GAP") ||
    cleanId.startsWith("MANUAL-ENTRY") ||
    cleanId.startsWith("MANUAL-GAP") ||
    cleanId.startsWith("UNRECON-GAP")
  );
}

/**
 * Resolves the full parent + contiguous child row group for a job on Confirmed or Pipeline.
 * Even if called with only a single child row or parent row, walks upward to find the parent row
 * (the row holding Revenue/Direct Costs/Start Date) and downward to collect all child rows.
 */
export async function resolveFullJobRowGroup_(sheets, sheetIdClean, targetTab, seedRowNums, cachedAllRows = null) {
  const validSeeds = (Array.isArray(seedRowNums) ? seedRowNums : [seedRowNums])
    .map(r => parseInt(typeof r === "object" ? r?.rowNum : r, 10))
    .filter(n => !isNaN(n) && n >= 2);
  if (validSeeds.length === 0) return null;

  const minSeedRowNum = Math.min(...validSeeds);
  const maxSeedRowNum = Math.max(...validSeeds);

  let allRows = cachedAllRows;
  let usedWindowFetch = false;
  let windowStartRow = 1;
  let windowEndRow = 5000;

  if (!allRows) {
    windowStartRow = Math.max(1, minSeedRowNum - 60);
    windowEndRow = maxSeedRowNum + 80;
    usedWindowFetch = true;
    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: `${targetTab}!A${windowStartRow}:CR${windowEndRow}`,
        valueRenderOption: "UNFORMATTED_VALUE"
      })
    );
    const fetched = resp.data.values || [];
    allRows = [];
    for (let i = 0; i < fetched.length; i++) {
      allRows[windowStartRow - 1 + i] = fetched[i];
    }
  }

  const norm = (s) => String(s || "").trim().toLowerCase();
  const isParentRowAt = (idx0) => {
    const r = allRows[idx0] || [];
    const hasRev = r[32] !== undefined && r[32] !== null && String(r[32]).trim() !== "";
    const hasDir = r[33] !== undefined && r[33] !== null && String(r[33]).trim() !== "";
    const hasStart = r[37] !== undefined && r[37] !== null && String(r[37]).trim() !== "";
    return hasRev || hasDir || hasStart;
  };
  const rowHasAnySlotData = (idx0) => {
    const r = allRows[idx0] || [];
    for (let c = 41; c <= 60; c++) {
      if (r[c] !== undefined && r[c] !== null && String(r[c]).trim() !== "") return true;
    }
    for (let c = 75; c <= 95; c++) {
      if (r[c] !== undefined && r[c] !== null && String(r[c]).trim() !== "") return true;
    }
    return false;
  };

  let parentIdx0 = minSeedRowNum - 1;
  const seedRow = allRows[parentIdx0] || [];
  const seedClient = norm(seedRow[0]);
  const seedJob = norm(seedRow[1]);

  // Walk upward if minSeedRowNum is a child row
  while (parentIdx0 > 1 && !isParentRowAt(parentIdx0)) {
    const prevRow = allRows[parentIdx0 - 1] || [];
    const prevClient = norm(prevRow[0]);
    const prevJob = norm(prevRow[1]);
    const sameIdentity =
      (!seedClient && !seedJob) ||
      (prevClient === seedClient && prevJob === seedJob);
    if (!sameIdentity) break;
    parentIdx0--;
  }

  const parentRow = allRows[parentIdx0] || [];
  const parentClient = norm(parentRow[0]) || seedClient;
  const parentJob = norm(parentRow[1]) || seedJob;
  const allRowNums = [parentIdx0 + 1];

  // Walk downward to collect all contiguous child rows belonging to this parent job
  let nextIdx0 = parentIdx0 + 1;
  while (nextIdx0 < allRows.length) {
    const r = allRows[nextIdx0] || [];
    const rClient = norm(r[0]);
    const rJob = norm(r[1]);
    const hasIdentity = Boolean(rClient || rJob);
    const matchesParentIdentity =
      (rClient === parentClient && rJob === parentJob) ||
      (!hasIdentity && rowHasAnySlotData(nextIdx0));

    if (!matchesParentIdentity) break;
    if (isParentRowAt(nextIdx0)) break; // Next independent job with same client/job name

    allRowNums.push(nextIdx0 + 1);
    nextIdx0++;
  }

  // If the job group reached the edge of the fetched window, fall back to a full-tab fetch
  const hitTopWindowBound = usedWindowFetch && windowStartRow > 2 && parentIdx0 <= windowStartRow - 1 && !isParentRowAt(parentIdx0);
  const hitBottomWindowBound = usedWindowFetch && nextIdx0 >= windowEndRow;
  if (hitTopWindowBound || hitBottomWindowBound) {
    const fullResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: `${targetTab}!A1:CR5000`,
        valueRenderOption: "UNFORMATTED_VALUE"
      })
    );
    return resolveFullJobRowGroup_(sheets, sheetIdClean, targetTab, validSeeds, fullResp.data.values || []);
  }

  // Also include any explicitly passed seed rows that weren't contiguous
  for (const sNum of validSeeds) {
    if (!allRowNums.includes(sNum) && sNum - 1 < allRows.length) {
      allRowNums.push(sNum);
    }
  }
  allRowNums.sort((a, b) => a - b);

  return {
    parentRowNum: parentIdx0 + 1,
    lastRowNum: allRowNums[allRowNums.length - 1],
    allRowNums,
    parentRow,
    allRows
  };
}

/**
 * Live slot resolver for placing a real invoice onto a job.
 * Priority Order:
 *  1. Existing slot with the same invoice reference (idempotent update in-place)
 *  2. Manual placeholder (amt > 0, blank ref) matching within £5
 *  3. Automatic placeholder (PLACE-INV-...)
 *  4. Remaining Manual placeholder (amt > 0, blank ref) outside £5
 *  5. Completely Empty slot (amt === 0, blank ref)
 *  6. Overflow: insert new child row at end of job group
 */
export async function resolveLiveInvoiceSlot_(sheets, sheetIdClean, targetTab, seedRowNums, requestedRowNum, requestedSlotNum, invoice, options = {}) {
  const { preferRequestedIfValid = false, cachedAllRows = null, jobClient = "", jobName = "" } = options;
  const group = await resolveFullJobRowGroup_(sheets, sheetIdClean, targetTab, seedRowNums, cachedAllRows);
  if (!group) {
    return { rowNum: requestedRowNum, slotNum: requestedSlotNum || 1, createdNewRow: false, allRowNums: seedRowNums };
  }

  const invAmt = parseFloat(String(invoice?.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
  const invRefClean = String(invoice?.invoiceNo || "").trim().toLowerCase();
  const isIncomingPlaceholder = !invRefClean || isAutoInvoicePlaceholderRef_(invRefClean) || String(invoice?.status || "").trim().toLowerCase() === "placeholder";

  const slotCandidates = [];
  for (const rNum of group.allRowNums) {
    const rowArr = group.allRows[rNum - 1] || [];
    for (let s = 1; s <= 3; s++) {
      const baseCol = s === 1 ? 41 : s === 2 ? 48 : 55; // AP=41, AW=48, BD=55
      const amt = parseFloat(String(rowArr[baseCol] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const ref = String(rowArr[baseCol + 1] || "").trim();
      const st = String(rowArr[baseCol + 4] || "").trim();

      // Exact same invoice ref already placed on this job -> update in place
      if (!isIncomingPlaceholder && invRefClean && ref.toLowerCase() === invRefClean) {
        return { rowNum: rNum, slotNum: s, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
      }

      const isEmpty = !ref && Math.abs(amt) < 0.005;
      const isAuto = isAutoInvoicePlaceholderRef_(ref);
      const isManualPlaceholder = !ref && Math.abs(amt) >= 0.005;
      const isRealOccupied = Boolean(ref && !isAuto);

      slotCandidates.push({
        rowNum: rNum,
        slotNum: s,
        amt,
        ref,
        st,
        isEmpty,
        isAuto,
        isManualPlaceholder,
        isRealOccupied,
        amtDiff: Math.abs(amt - invAmt),
        isRequested: rNum === Number(requestedRowNum) && s === Number(requestedSlotNum)
      });
    }
  }

  // If editing a placeholder directly from JobDetailModal, keep the requested slot
  if (isIncomingPlaceholder && requestedRowNum && requestedSlotNum) {
    return { rowNum: Number(requestedRowNum), slotNum: Number(requestedSlotNum), createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
  }

  // If caller explicitly chose a slot in the UI (not Triage) and that slot is not occupied by another real invoice, respect it
  if (preferRequestedIfValid) {
    const reqCand = slotCandidates.find(c => c.isRequested);
    if (reqCand && !reqCand.isRealOccupied) {
      return { rowNum: reqCand.rowNum, slotNum: reqCand.slotNum, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
    }
  }

  // Priority 1: Manual placeholder (amt > 0, blank ref) matching within £5.00
  const p1 = slotCandidates
    .filter(c => c.isManualPlaceholder && c.amtDiff <= 5.001)
    .sort((a, b) => (a.isRequested === b.isRequested ? (a.amtDiff - b.amtDiff || a.rowNum - b.rowNum || a.slotNum - b.slotNum) : (a.isRequested ? -1 : 1)));
  if (p1.length > 0) {
    return { rowNum: p1[0].rowNum, slotNum: p1[0].slotNum, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
  }

  // Priority 2: Automatic placeholder (PLACE-INV-...) buffer
  const p2 = slotCandidates
    .filter(c => c.isAuto)
    .sort((a, b) => (a.isRequested === b.isRequested ? (a.rowNum - b.rowNum || a.slotNum - b.slotNum) : (a.isRequested ? -1 : 1)));
  if (p2.length > 0) {
    return { rowNum: p2[0].rowNum, slotNum: p2[0].slotNum, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
  }

  // Priority 3: Any remaining Manual placeholder (amt > 0, blank ref) outside £5 — use up before empty slots
  const p3 = slotCandidates
    .filter(c => c.isManualPlaceholder)
    .sort((a, b) => (a.isRequested === b.isRequested ? (a.amtDiff - b.amtDiff || a.rowNum - b.rowNum || a.slotNum - b.slotNum) : (a.isRequested ? -1 : 1)));
  if (p3.length > 0) {
    return { rowNum: p3[0].rowNum, slotNum: p3[0].slotNum, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
  }

  // Priority 4: Completely Empty slot (amt === 0, blank ref)
  const p4 = slotCandidates
    .filter(c => c.isEmpty)
    .sort((a, b) => (a.isRequested === b.isRequested ? (a.rowNum - b.rowNum || a.slotNum - b.slotNum) : (a.isRequested ? -1 : 1)));
  if (p4.length > 0) {
    return { rowNum: p4[0].rowNum, slotNum: p4[0].slotNum, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
  }

  // Priority 5: All existing slots across parent + child rows are occupied by real invoices -> insert new child row
  const resolvedClient = jobClient || String(group.parentRow[0] || "").trim();
  const resolvedJob = jobName || String(group.parentRow[1] || "").trim();
  const newRowNum = await insertChildJobRow_(sheets, sheetIdClean, group.lastRowNum, resolvedClient, resolvedJob);
  const updatedRowNums = [...group.allRowNums, newRowNum];
  return { rowNum: newRowNum, slotNum: 1, createdNewRow: true, allRowNums: updatedRowNums, parentRowNum: group.parentRowNum };
}

/**
 * Live slot resolver for placing a real expense onto a job.
 * Priority Order:
 *  1. Existing slot with the same expense App ID (idempotent update in-place)
 *  2. Manual placeholder (amt > 0, blank ID) matching within £5
 *  3. Automatic placeholder (PLACE-EXP-...)
 *  4. Remaining Manual placeholder (amt > 0, blank ID) outside £5
 *  5. Completely Empty slot (amt === 0, blank ID & blank desc)
 *  6. Overflow: insert new child row at end of job group
 */
export async function resolveLiveExpenseSlot_(sheets, sheetIdClean, targetTab, seedRowNums, requestedRowNum, requestedSlotNum, expense, options = {}) {
  const { preferRequestedIfValid = false, cachedAllRows = null, jobClient = "", jobName = "" } = options;
  const group = await resolveFullJobRowGroup_(sheets, sheetIdClean, targetTab, seedRowNums, cachedAllRows);
  if (!group) {
    return { rowNum: requestedRowNum, slotNum: requestedSlotNum || 1, createdNewRow: false, allRowNums: seedRowNums };
  }

  const expAmt = parseFloat(String(expense?.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
  const expIdClean = String(expense?.appId || expense?.transactionId || "").trim();
  const expDescClean = String(expense?.description || expense?.contactName || "").trim().toLowerCase();
  const isIncomingPlaceholder = isAutoExpensePlaceholderId_(expIdClean) || expDescClean.startsWith("placeholder") || String(expense?.status || "").trim().toLowerCase() === "placeholder";

  const slotCandidates = [];
  for (const rNum of group.allRowNums) {
    const rowArr = group.allRows[rNum - 1] || [];
    for (let s = 1; s <= 3; s++) {
      const baseCol = s === 1 ? 75 : s === 2 ? 82 : 89; // BX=75, CE=82, CL=89
      const desc = String(rowArr[baseCol] || "").trim();
      const amt = parseFloat(String(rowArr[baseCol + 1] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const st = String(rowArr[baseCol + 5] || "").trim();
      const id = String(rowArr[baseCol + 6] || "").trim();

      if (!isIncomingPlaceholder && expIdClean && id === expIdClean) {
        return { rowNum: rNum, slotNum: s, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
      }

      const isEmpty = !desc && !id && Math.abs(amt) < 0.005;
      const isAuto = isAutoExpensePlaceholderId_(id) || (!id && /^placeholder/i.test(desc));
      const isManualPlaceholder = !id && !isAuto && Math.abs(amt) >= 0.005;
      const isRealOccupied = Boolean(id && !isAuto);

      const descMatches = Boolean(desc && expDescClean && (desc.toLowerCase().includes(expDescClean) || expDescClean.includes(desc.toLowerCase())));

      slotCandidates.push({
        rowNum: rNum,
        slotNum: s,
        desc,
        amt,
        st,
        id,
        isEmpty,
        isAuto,
        isManualPlaceholder,
        isRealOccupied,
        descMatches,
        amtDiff: Math.abs(amt - expAmt),
        isRequested: rNum === Number(requestedRowNum) && s === Number(requestedSlotNum)
      });
    }
  }

  if (isIncomingPlaceholder && requestedRowNum && requestedSlotNum) {
    return { rowNum: Number(requestedRowNum), slotNum: Number(requestedSlotNum), createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
  }

  if (preferRequestedIfValid) {
    const reqCand = slotCandidates.find(c => c.isRequested);
    if (reqCand && !reqCand.isRealOccupied) {
      return { rowNum: reqCand.rowNum, slotNum: reqCand.slotNum, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
    }
  }

  // Priority 1: Manual placeholder (amt > 0, blank ID) matching within £5.00
  const p1 = slotCandidates
    .filter(c => c.isManualPlaceholder && c.amtDiff <= 5.001)
    .sort((a, b) => {
      if (a.descMatches !== b.descMatches) return a.descMatches ? -1 : 1;
      if (a.isRequested !== b.isRequested) return a.isRequested ? -1 : 1;
      return a.amtDiff - b.amtDiff || a.rowNum - b.rowNum || a.slotNum - b.slotNum;
    });
  if (p1.length > 0) {
    return { rowNum: p1[0].rowNum, slotNum: p1[0].slotNum, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
  }

  // Priority 2: Automatic placeholder (PLACE-EXP-...) buffer
  const p2 = slotCandidates
    .filter(c => c.isAuto)
    .sort((a, b) => (a.isRequested === b.isRequested ? (a.rowNum - b.rowNum || a.slotNum - b.slotNum) : (a.isRequested ? -1 : 1)));
  if (p2.length > 0) {
    return { rowNum: p2[0].rowNum, slotNum: p2[0].slotNum, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
  }

  // Priority 3: Any remaining Manual placeholder (amt > 0, blank ID) outside £5 — use up before empty slots
  const p3 = slotCandidates
    .filter(c => c.isManualPlaceholder)
    .sort((a, b) => (a.isRequested === b.isRequested ? (a.amtDiff - b.amtDiff || a.rowNum - b.rowNum || a.slotNum - b.slotNum) : (a.isRequested ? -1 : 1)));
  if (p3.length > 0) {
    return { rowNum: p3[0].rowNum, slotNum: p3[0].slotNum, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
  }

  // Priority 4: Completely Empty slot (amt === 0, blank ID)
  const p4 = slotCandidates
    .filter(c => c.isEmpty)
    .sort((a, b) => (a.isRequested === b.isRequested ? (a.rowNum - b.rowNum || a.slotNum - b.slotNum) : (a.isRequested ? -1 : 1)));
  if (p4.length > 0) {
    return { rowNum: p4[0].rowNum, slotNum: p4[0].slotNum, createdNewRow: false, allRowNums: group.allRowNums, parentRowNum: group.parentRowNum };
  }

  // Priority 5: All existing slots across parent + child rows are occupied by real expenses -> insert new child row
  const resolvedClient = jobClient || String(group.parentRow[0] || "").trim();
  const resolvedJob = jobName || String(group.parentRow[1] || "").trim();
  const newRowNum = await insertChildJobRow_(sheets, sheetIdClean, group.lastRowNum, resolvedClient, resolvedJob);
  const updatedRowNums = [...group.allRowNums, newRowNum];
  return { rowNum: newRowNum, slotNum: 1, createdNewRow: true, allRowNums: updatedRowNums, parentRowNum: group.parentRowNum };
}

export async function adjustJobInvoicePlaceholders_(sheets, sheetIdClean, targetTab, rowNums, jobRevenue, passedMasterSheetId, cachedAllRows = null, options = {}) {
  const { preloadedTolerances = null, returnBatchDataOnly = false } = options;
  try {
    const group = await resolveFullJobRowGroup_(sheets, sheetIdClean, targetTab, rowNums, cachedAllRows);
    if (!group || group.allRowNums.length === 0) return null;

    const { parentRowNum, allRowNums, parentRow, allRows } = group;
    const isRetainer = String(parentRow[35] || "").trim().toLowerCase().includes("retainer"); // AJ = 35

    const slotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    };

    let effectiveRev = typeof jobRevenue === "number" ? jobRevenue : parseFloat(String(jobRevenue ?? "").replace(/[£$€,\s]/g, ""));
    if (effectiveRev === undefined || effectiveRev === null || isNaN(effectiveRev)) {
      effectiveRev = parseFloat(String(parentRow[32] || "0").replace(/[£$€,\s]/g, "")) || 0; // AG = 32
    }

    if (targetTab === "Confirmed" && isRetainer) {
      if (effectiveRev > 0) {
        const batchData = [];
        const slotUpdates = [];
        for (const rNum of allRowNums) {
          const rowArr = allRows[rNum - 1] || [];
          const amt = parseFloat(String(rowArr[41] || "0").replace(/[£$€,\s]/g, "")) || 0;
          const ref = String(rowArr[42] || "").trim();
          const sent = String(rowArr[43] || "").trim();
          const days = String(rowArr[44] || "").trim();
          const st = String(rowArr[45] || "").trim();
          const isPlaceholderRow = !ref || isAutoInvoicePlaceholderRef_(ref);
          const isSentOrPaid = ["sent", "paid"].includes(st.toLowerCase());
          if (isPlaceholderRow && !isSentOrPaid && (amt > 0 || sent)) {
            batchData.push({
              range: `${targetTab}!AP${rNum}`,
              values: [[effectiveRev]]
            });
            slotUpdates.push({
              rowNum: rNum,
              slotNum: 1,
              amount: String(effectiveRev),
              ref,
              sentDate: sent,
              daysToPay: days,
              status: st
            });
          }
        }
        if (batchData.length > 0) {
          if (!returnBatchDataOnly) {
            await withRetry(() =>
              sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: sheetIdClean,
                requestBody: { valueInputOption: "RAW", data: batchData }
              })
            );
          }
          return { rowNum: slotUpdates[0].rowNum, slotNum: 1, amount: effectiveRev, cleared: false, slotUpdates, batchData };
        }
      }
      return null;
    }

    let realInvoicedTotal = 0;
    let realCount = 0;
    let manualPlaceholdersTotal = 0;
    let manualCount = 0;
    const autoPlaceholders = [];
    const emptySlots = [];
    let parentEmptyCount = 0;

    for (const rNum of allRowNums) {
      const rowArr = allRows[rNum - 1] || [];
      for (let s = 1; s <= 3; s++) {
        const base = s === 1 ? 41 : s === 2 ? 48 : 55; // AP=41, AW=48, BD=55
        const amt = parseFloat(String(rowArr[base] || "0").replace(/[£$€,\s]/g, "")) || 0;
        const ref = String(rowArr[base + 1] || "").trim();
        const sent = String(rowArr[base + 2] || "").trim();
        const days = String(rowArr[base + 3] || "").trim();
        const st = String(rowArr[base + 4] || "").trim();

        const isEmpty = !ref && Math.abs(amt) < 0.005;
        const isAuto = isAutoInvoicePlaceholderRef_(ref);
        const isManualPlaceholder = !ref && Math.abs(amt) >= 0.005;

        if (isEmpty) {
          emptySlots.push({ rowNum: rNum, slotNum: s, currentAmount: 0, isAuto: false, currentRef: "", currentSent: sent, currentDays: days });
          if (rNum === parentRowNum) parentEmptyCount++;
        } else if (isAuto) {
          const slotObj = { rowNum: rNum, slotNum: s, currentAmount: amt, isAuto: true, currentRef: ref, currentSent: sent, currentDays: days };
          autoPlaceholders.push(slotObj);
        } else if (isManualPlaceholder) {
          // Manual placeholders (amt > 0, blank Ref) are preserved untouched; their amounts and slot count reduce the remaining automatic gap
          manualPlaceholdersTotal += amt;
          manualCount++;
        } else {
          realInvoicedTotal += amt;
          realCount++;
        }
      }
    }

    // Order available slots identically to GAS: all existing automatic placeholders across parent + child rows FIRST, then empty slots
    const availableSlots = [...autoPlaceholders, ...emptySlots];

    if (effectiveRev > 0) {
      const remainingToInvoice = Math.max(0, Math.round((effectiveRev - realInvoicedTotal - manualPlaceholdersTotal) * 100) / 100);

      if (remainingToInvoice > 0.01) {
        let tols = preloadedTolerances;
        if (!tols) {
          const masterId = passedMasterSheetId || await resolveMasterSheetIdForClient_(sheets, sheetIdClean);
          tols = masterId ? await getToleranceValues(sheets, masterId) : {
            invoiceLogicMode: "50-50",
            retainerInvoiceDay: 28,
            defaultDaysToPay: 30
          };
        }

        const rawStartDate = parentRow[37]; // AL = 37
        const rawEndDate = parentRow[38];   // AM = 38
        const startDate = rawStartDate ? parseSheetDate(rawStartDate) : new Date();
        const endDate = rawEndDate ? parseSheetDate(rawEndDate) : startDate;

        const occupiedNonAutoCount = realCount + manualCount;
        const allocations = calculateRevenueSplit(
          remainingToInvoice,
          tols.invoiceLogicMode || "50-50",
          startDate,
          endDate,
          tols.retainerInvoiceDay || 28,
          occupiedNonAutoCount
        );

        // Bump past calculated placeholder dates to the 5th of the current month to match GAS runInvoiceSheetAudit_
        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const targetFifth = new Date(now.getFullYear(), now.getMonth(), 5);
        allocations.forEach(alloc => {
          if (alloc.date instanceof Date && !isNaN(alloc.date.getTime()) && alloc.date < currentMonthStart) {
            alloc.date = targetFifth;
          }
        });

        const daysToPayVal = tols.defaultDaysToPay || 30;
        let newChildRowCreated = false;
        let newChildRowNum = null;
        const batchData = [];

        // If we need more slots than available and all 3 parent slots are occupied, create a new child row just like GAS
        if (allocations.length > availableSlots.length && parentEmptyCount === 0 && targetTab === "Confirmed") {
          try {
            const childResult = await insertChildJobRow_(
              sheets,
              sheetIdClean,
              group.lastRowNum,
              String(parentRow[0] || "").trim(),
              String(parentRow[1] || "").trim(),
              { cachedAllRows: allRows, deferValueWrites: true }
            );
            newChildRowNum = typeof childResult === "object" ? childResult.targetRowNum : childResult;
            if (typeof childResult === "object" && Array.isArray(childResult.valueUpdates)) {
              batchData.push(...childResult.valueUpdates);
            }
            newChildRowCreated = true;
            for (let s = 1; s <= 3; s++) {
              availableSlots.push({ rowNum: newChildRowNum, slotNum: s, currentAmount: 0, isAuto: false, currentRef: "", currentSent: "", currentDays: "" });
            }
          } catch (childErr) {
            console.warn("adjustJobInvoicePlaceholders_ child row creation skipped:", childErr.message);
          }
        }

        const slotsToUse = Math.min(allocations.length, availableSlots.length);
        const slotUpdates = [];

        for (let k = 0; k < slotsToUse; k++) {
          const target = availableSlots[k];
          const cols = slotCols[target.slotNum];
          let amountToWrite = allocations[k].amt;
          if (k === slotsToUse - 1 && allocations.length > slotsToUse) {
            for (let j = k + 1; j < allocations.length; j++) amountToWrite += allocations[j].amt;
            amountToWrite = Math.round(amountToWrite * 100) / 100;
          }
          // Preserve existing PLACE-INV reference when updating in-place (matching GAS writeManualEntry_)
          const autoRef = (target.isAuto && target.currentRef) ? target.currentRef : generateAutoPlaceholderRef_("PLACE-INV");
          const sentDate = toSheetDateFormat(allocations[k].date);
          const parsedExistingDays = parseInt(String(target.currentDays || "").replace(/[^\d-]/g, ""), 10);
          const effectiveDays = (!isNaN(parsedExistingDays) && parsedExistingDays > 0 && parsedExistingDays <= 365) ? parsedExistingDays : daysToPayVal;

          batchData.push({
            range: `${targetTab}!${cols.a}${target.rowNum}:${cols.st}${target.rowNum}`,
            values: [[amountToWrite, autoRef, sentDate, effectiveDays, ""]]
          });
          slotUpdates.push({
            rowNum: target.rowNum,
            slotNum: target.slotNum,
            amount: String(amountToWrite),
            ref: autoRef,
            sentDate,
            daysToPay: String(effectiveDays),
            status: ""
          });
        }

        // Clear any surplus auto placeholders beyond slotsToUse
        for (let k = slotsToUse; k < availableSlots.length; k++) {
          const extra = availableSlots[k];
          if (extra.isAuto) {
            const extraCols = slotCols[extra.slotNum];
            batchData.push({
              range: `${targetTab}!${extraCols.a}${extra.rowNum}:${extraCols.st}${extra.rowNum}`,
              values: [["", "", "", "", ""]]
            });
            slotUpdates.push({
              rowNum: extra.rowNum,
              slotNum: extra.slotNum,
              amount: "",
              ref: "",
              sentDate: "",
              daysToPay: "",
              status: ""
            });
          }
        }

        if (batchData.length > 0 && !returnBatchDataOnly) {
          await withRetry(() =>
            sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: { valueInputOption: "RAW", data: batchData }
            })
          );
        }

        if (availableSlots.length > 0) {
          return {
            rowNum: availableSlots[0].rowNum,
            slotNum: availableSlots[0].slotNum,
            amount: allocations[0]?.amt || remainingToInvoice,
            cleared: false,
            slotUpdates,
            batchData,
            newChildRowCreated,
            newChildRow: newChildRowNum
          };
        }
      } else {
        // Clear all auto placeholders when remaining gap is 0
        const batchData = [];
        const slotUpdates = [];
        for (const p of autoPlaceholders) {
          const cols = slotCols[p.slotNum];
          batchData.push({
            range: `${targetTab}!${cols.a}${p.rowNum}:${cols.st}${p.rowNum}`,
            values: [["", "", "", "", ""]]
          });
          slotUpdates.push({
            rowNum: p.rowNum,
            slotNum: p.slotNum,
            amount: "",
            ref: "",
            sentDate: "",
            daysToPay: "",
            status: ""
          });
        }
        if (batchData.length > 0) {
          if (!returnBatchDataOnly) {
            await withRetry(() =>
              sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: sheetIdClean,
                requestBody: { valueInputOption: "RAW", data: batchData }
              })
            );
          }
          return { rowNum: autoPlaceholders[0].rowNum, slotNum: autoPlaceholders[0].slotNum, amount: 0, cleared: true, slotUpdates, batchData };
        }
      }
    }
  } catch (err) {
    console.warn("adjustJobInvoicePlaceholders_ error (non-fatal):", err.message);
  }
  return null;
}

export async function adjustJobExpensePlaceholders_(sheets, sheetIdClean, targetTab, rowNums, jobBudget, passedMasterSheetId, cachedAllRows = null, options = {}) {
  const { preloadedTolerances = null, returnBatchDataOnly = false } = options;
  try {
    const group = await resolveFullJobRowGroup_(sheets, sheetIdClean, targetTab, rowNums, cachedAllRows);
    if (!group || group.allRowNums.length === 0) return null;

    const { parentRowNum, allRowNums, parentRow, allRows } = group;
    const isRetainer = String(parentRow[35] || "").trim().toLowerCase().includes("retainer"); // AJ = 35

    const slotCols = {
      1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
      2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
      3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
    };

    let effectiveBudget = jobBudget;
    if (effectiveBudget === undefined || effectiveBudget === null || isNaN(effectiveBudget)) {
      effectiveBudget = parseFloat(String(parentRow[33] || "0").replace(/[£$€,\s]/g, "")) || 0; // AH = 33
    }
    const parentVat = String(parentRow[34] || "").trim() || "No"; // AI = 34

    if (targetTab === "Confirmed" && isRetainer) {
      const batchData = [];
      const slotUpdates = [];
      for (const rNum of allRowNums) {
        if (rNum === parentRowNum) continue;
        const rowArr = allRows[rNum - 1] || [];
        let rowRealAndManual = 0;
        const rowAutos = [];
        for (let s = 1; s <= 3; s++) {
          const base = s === 1 ? 75 : s === 2 ? 82 : 89;
          const desc = String(rowArr[base] || "").trim();
          const amt = parseFloat(String(rowArr[base + 1] || "0").replace(/[£$€,\s]/g, "")) || 0;
          const vatVal = String(rowArr[base + 2] || "").trim();
          const dtVal = String(rowArr[base + 3] || "").trim();
          const dpVal = String(rowArr[base + 4] || "").trim();
          const st = String(rowArr[base + 5] || "").trim();
          const id = String(rowArr[base + 6] || "").trim();
          const isAuto = isAutoExpensePlaceholderId_(id) || (!id && /^placeholder/i.test(desc));
          if (isAuto) {
            rowAutos.push({ rowNum: rNum, slotNum: s, desc, amt, vatVal, dtVal, dpVal, st, id });
          } else if (Math.abs(amt) >= 0.005) {
            rowRealAndManual += amt;
          }
        }
        if (rowAutos.length === 0) continue;
        const rowGap = Math.max(0, Math.round((effectiveBudget - rowRealAndManual) * 100) / 100);
        for (let idx = 0; idx < rowAutos.length; idx++) {
          const autoSlot = rowAutos[idx];
          const cols = slotCols[autoSlot.slotNum];
          if (idx === 0 && rowGap > 0.01) {
            if (Math.abs(autoSlot.amt - rowGap) > 0.01) {
              batchData.push({
                range: `${targetTab}!${cols.a}${rNum}`,
                values: [[rowGap]]
              });
              slotUpdates.push({
                rowNum: rNum,
                slotNum: autoSlot.slotNum,
                description: autoSlot.desc,
                amount: String(rowGap),
                vat: autoSlot.vatVal,
                date: autoSlot.dtVal,
                daysToPay: autoSlot.dpVal,
                status: autoSlot.st,
                transactionId: autoSlot.id
              });
            }
          } else {
            batchData.push({
              range: `${targetTab}!${cols.d}${rNum}:${cols.id}${rNum}`,
              values: [["", "", "", "", "", "", ""]]
            });
            slotUpdates.push({
              rowNum: rNum,
              slotNum: autoSlot.slotNum,
              description: "",
              amount: "",
              vat: "",
              date: "",
              daysToPay: "",
              status: "",
              transactionId: ""
            });
          }
        }
      }
      if (batchData.length > 0) {
        if (!returnBatchDataOnly) {
          await withRetry(() =>
            sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: { valueInputOption: "RAW", data: batchData }
            })
          );
        }
        return {
          rowNum: slotUpdates[0].rowNum,
          slotNum: slotUpdates[0].slotNum,
          amount: parseFloat(slotUpdates[0].amount) || 0,
          cleared: !slotUpdates[0].amount,
          slotUpdates,
          batchData
        };
      }
      return null;
    }

    let realExpensesTotal = 0;
    let realCount = 0;
    let manualExpensesTotal = 0;
    let manualCount = 0;
    const autoPlaceholders = [];
    const emptySlots = [];
    let parentEmptyCount = 0;

    for (const rNum of allRowNums) {
      const rowArr = allRows[rNum - 1] || [];
      for (let s = 1; s <= 3; s++) {
        const base = s === 1 ? 75 : s === 2 ? 82 : 89; // BX=75, CE=82, CL=89
        const desc = String(rowArr[base] || "").trim();
        const amt = parseFloat(String(rowArr[base + 1] || "0").replace(/[£$€,\s]/g, "")) || 0;
        const vatVal = String(rowArr[base + 2] || "").trim();
        const dtVal = String(rowArr[base + 3] || "").trim();
        const dpVal = String(rowArr[base + 4] || "").trim();
        const st = String(rowArr[base + 5] || "").trim();
        const id = String(rowArr[base + 6] || "").trim();

        const isEmpty = !desc && !id && Math.abs(amt) < 0.005;
        const isAuto = isAutoExpensePlaceholderId_(id) || (!id && /^placeholder/i.test(desc));
        const isManualPlaceholder = !id && !isAuto && Math.abs(amt) >= 0.005;

        if (isEmpty) {
          emptySlots.push({ rowNum: rNum, slotNum: s, currentAmount: 0, isAuto: false, currentId: "", currentVat: vatVal, currentDays: dpVal });
          if (rNum === parentRowNum) parentEmptyCount++;
        } else if (isAuto) {
          autoPlaceholders.push({ rowNum: rNum, slotNum: s, currentAmount: amt, isAuto: true, currentId: id, currentVat: vatVal, currentDays: dpVal });
        } else if (isManualPlaceholder) {
          // Manual placeholders (amt > 0, blank App ID) are preserved untouched; their amounts and count reduce the remaining automatic gap
          manualExpensesTotal += amt;
          manualCount++;
        } else if ((id || desc) && Math.abs(amt) >= 0.005) {
          realExpensesTotal += amt;
          realCount++;
        }
      }
    }

    // Order available slots identically to GAS: all existing automatic placeholders across parent + child rows FIRST, then empty slots
    const availableSlots = [...autoPlaceholders, ...emptySlots];

    if (effectiveBudget > 0) {
      const remainingDC = Math.max(0, Math.round((effectiveBudget - realExpensesTotal - manualExpensesTotal) * 100) / 100);

      if (remainingDC > 0.01) {
        let tols = preloadedTolerances;
        if (!tols) {
          const masterId = passedMasterSheetId || await resolveMasterSheetIdForClient_(sheets, sheetIdClean);
          tols = masterId ? await getToleranceValues(sheets, masterId) : {
            expenseLogicMode: "100 at start",
            retainerExpenseDay: 28,
            defaultDaysToPay: 30
          };
        }

        const rawStartDate = parentRow[37]; // AL = 37
        const rawEndDate = parentRow[38];   // AM = 38
        const startDate = rawStartDate ? parseSheetDate(rawStartDate) : new Date();
        const endDate = rawEndDate ? parseSheetDate(rawEndDate) : startDate;

        const occupiedNonAutoCount = realCount + manualCount;
        const allocations = calculateRevenueSplit(
          remainingDC,
          tols.expenseLogicMode || "100 at start",
          startDate,
          endDate,
          tols.retainerExpenseDay || 28,
          occupiedNonAutoCount
        );

        // Bump past calculated placeholder dates to the 5th of the current month to match GAS runSheetAudit
        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const targetFifth = new Date(now.getFullYear(), now.getMonth(), 5);
        allocations.forEach(alloc => {
          if (alloc.date instanceof Date && !isNaN(alloc.date.getTime()) && alloc.date < currentMonthStart) {
            alloc.date = targetFifth;
          }
        });

        const daysToPayVal = tols.defaultDaysToPay || 30;
        const batchData = [];
        const slotUpdates = [];
        let newChildRowCreated = false;
        let newChildRow = null;

        if (allocations.length > availableSlots.length && parentEmptyCount === 0 && targetTab === "Confirmed") {
          try {
            const inserted = await insertChildJobRow_(
              sheets,
              sheetIdClean,
              group.lastRowNum,
              String(parentRow[0] || "").trim(),
              String(parentRow[1] || "").trim(),
              { cachedAllRows: allRows, deferValueWrites: true }
            );
            newChildRow = typeof inserted === "object" ? inserted.targetRowNum : inserted;
            newChildRowCreated = Boolean(newChildRow);
            if (Array.isArray(inserted?.valueUpdates)) {
              batchData.push(...inserted.valueUpdates);
            }
            for (let s = 1; s <= 3; s++) {
              availableSlots.push({ rowNum: newChildRow, slotNum: s, currentAmount: 0, isAuto: false, currentId: "", currentVat: parentVat, currentDays: "" });
            }
          } catch (childErr) {
            console.warn("adjustJobExpensePlaceholders_ child row creation skipped:", childErr.message);
          }
        }

        const slotsToUse = Math.min(allocations.length, availableSlots.length);

        for (let k = 0; k < slotsToUse; k++) {
          const target = availableSlots[k];
          const cols = slotCols[target.slotNum];
          let amountToWrite = allocations[k].amt;
          if (k === slotsToUse - 1 && allocations.length > slotsToUse) {
            for (let j = k + 1; j < allocations.length; j++) amountToWrite += allocations[j].amt;
            amountToWrite = Math.round(amountToWrite * 100) / 100;
          }
          const autoId = (target.isAuto && target.currentId) ? target.currentId : generateAutoPlaceholderRef_("PLACE-EXP");
          const dt = toSheetDateFormat(allocations[k].date);
          const parsedExistingDays = parseInt(String(target.currentDays || "").replace(/[^\d-]/g, ""), 10);
          const effectiveDays = (!isNaN(parsedExistingDays) && parsedExistingDays > 0 && parsedExistingDays <= 365) ? parsedExistingDays : daysToPayVal;
          const effectiveVat = (target.currentVat === "Yes" || target.currentVat === "No") ? target.currentVat : parentVat;

          batchData.push({
            range: `${targetTab}!${cols.d}${target.rowNum}:${cols.id}${target.rowNum}`,
            values: [["Placeholder Entry - Project Direct Cost", amountToWrite, effectiveVat, dt, effectiveDays, "", autoId]]
          });
          slotUpdates.push({
            rowNum: target.rowNum,
            slotNum: target.slotNum,
            description: "Placeholder Entry - Project Direct Cost",
            amount: String(amountToWrite),
            vat: effectiveVat,
            date: dt,
            daysToPay: String(effectiveDays),
            status: "",
            transactionId: autoId
          });
        }

        // Clear any surplus auto placeholders beyond slotsToUse
        for (let k = slotsToUse; k < availableSlots.length; k++) {
          const extra = availableSlots[k];
          if (extra.isAuto) {
            const extraCols = slotCols[extra.slotNum];
            batchData.push({
              range: `${targetTab}!${extraCols.d}${extra.rowNum}:${extraCols.id}${extra.rowNum}`,
              values: [["", "", "", "", "", "", ""]]
            });
            slotUpdates.push({
              rowNum: extra.rowNum,
              slotNum: extra.slotNum,
              description: "",
              amount: "",
              vat: "",
              date: "",
              daysToPay: "",
              status: "",
              transactionId: ""
            });
          }
        }

        if (batchData.length > 0 && !returnBatchDataOnly) {
          await withRetry(() =>
            sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: { valueInputOption: "RAW", data: batchData }
            })
          );
        }

        if (availableSlots.length > 0) {
          return {
            rowNum: availableSlots[0].rowNum,
            slotNum: availableSlots[0].slotNum,
            amount: allocations[0]?.amt || remainingDC,
            cleared: false,
            slotUpdates,
            batchData,
            newChildRowCreated,
            newChildRow
          };
        }
      } else {
        const batchData = [];
        const slotUpdates = [];
        for (const p of autoPlaceholders) {
          const cols = slotCols[p.slotNum];
          batchData.push({
            range: `${targetTab}!${cols.d}${p.rowNum}:${cols.id}${p.rowNum}`,
            values: [["", "", "", "", "", "", ""]]
          });
          slotUpdates.push({
            rowNum: p.rowNum,
            slotNum: p.slotNum,
            description: "",
            amount: "",
            vat: "",
            date: "",
            daysToPay: "",
            status: "",
            transactionId: ""
          });
        }
        if (batchData.length > 0) {
          if (!returnBatchDataOnly) {
            await withRetry(() =>
              sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: sheetIdClean,
                requestBody: { valueInputOption: "RAW", data: batchData }
              })
            );
          }
          return { rowNum: autoPlaceholders[0].rowNum, slotNum: autoPlaceholders[0].slotNum, amount: 0, cleared: true, slotUpdates, batchData };
        }
      }
    }
  } catch (err) {
    console.warn("adjustJobExpensePlaceholders_ error (non-fatal):", err.message);
  }
  return null;
}

export async function handleAssignExpenseToJob(req, res, sheets) {
  const { clientSheetId, masterSheetId, rowNum, slotNum, expense, expenses, createNewRow, jobLastRow, jobClient, jobName, jobRows } = req.body;
  const expenseList = Array.isArray(expenses) && expenses.length > 0 ? expenses : (expense ? [expense] : []);
  if (!clientSheetId || expenseList.length === 0) {
    return res.status(400).json({ success: false, error: "Missing clientSheetId or expense" });
  }
  if (!createNewRow && (!rowNum || !slotNum)) {
    return res.status(400).json({ success: false, error: "Missing rowNum or slotNum" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

    const slotCols = {
      1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
      2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
      3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
    };

    const parseExpenseDate = (dateStr) => {
      if (!dateStr) return null;
      const m = String(dateStr).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (!m) return null;
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mIdx = months[m[2].toLowerCase()];
      if (mIdx === undefined) return null;
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
      return new Date(yr, mIdx, parseInt(m[1]));
    };
    const fmtDate = (d) => {
      const ms = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return d.getDate() + "-" + ms[d.getMonth()] + "-" + d.getFullYear();
    };

    const getExpenseDescription = (exp) => {
      let rawVendor = String(exp?.contactName || "").trim();
      let rawDesc = String(exp?.description || "").trim();
      const rawAccount = String(exp?.accountName || "").trim();
      const bracketRegex = /^([^(]+?)\s*[\(\[]([^)\]]+)[\)\]]$/;

      let vendor = "";
      let description = "";

      if (rawVendor) {
        const vMatch = rawVendor.match(bracketRegex);
        if (vMatch) {
          vendor = vMatch[1].trim();
          description = vMatch[2].trim();
        } else {
          vendor = rawVendor;
        }
      }

      if (rawDesc) {
        const dMatch = rawDesc.match(bracketRegex);
        if (dMatch) {
          if (!vendor) vendor = dMatch[1].trim();
          if (!description || description === rawDesc) description = dMatch[2].trim();
        } else if (!description) {
          if (!vendor || rawDesc.toLowerCase() !== vendor.toLowerCase()) {
            description = rawDesc;
          }
        }
      }

      if (!vendor) {
        vendor = rawDesc || rawAccount || "Expense";
        if (vendor === description) description = "";
      }

      if (description && vendor && description.toLowerCase() === vendor.toLowerCase()) {
        description = "";
      }

      if (vendor && description) return `${vendor} - ${description}`;
      return vendor || description || exp?.accountName || "";
    };

    let currRowNum = rowNum;
    let currSlotNum = slotNum;
    let dynamicJobLastRow = jobLastRow || rowNum;

    // Track known rows for this job so multi-item sequential placement can spill across rows
    let knownJobRows = Array.isArray(jobRows) ? jobRows.map(r => typeof r === "object" ? r.rowNum : r) : [rowNum].filter(Boolean);

    if (createNewRow) {
      if (!jobLastRow) return res.status(400).json({ success: false, error: "Missing jobLastRow for createNewRow" });
      const newRowNum = await insertChildJobRow_(sheets, sheetIdClean, jobLastRow, jobClient, jobName);
      currRowNum = newRowNum;
      currSlotNum = 1;
      dynamicJobLastRow = newRowNum;
      knownJobRows.push(newRowNum);
    }

    const valueUpdates = [];
    const dateUpdates = [];
    const placed = [];

    // Live-resolve job rows and slot availability before writing (in parallel with tolerance values lookup)
    const seedRows = knownJobRows.length > 0 ? knownJobRows : [currRowNum].filter(Boolean);
    const [liveGroup, preloadedTolerances] = await Promise.all([
      !createNewRow
        ? resolveFullJobRowGroup_(sheets, sheetIdClean, "Confirmed", seedRows)
        : Promise.resolve(null),
      masterSheetId
        ? getToleranceValues(sheets, masterSheetId).catch(() => null)
        : Promise.resolve(null)
    ]);
    if (liveGroup && liveGroup.allRowNums.length > 0) {
      knownJobRows = [...liveGroup.allRowNums];
      dynamicJobLastRow = liveGroup.lastRowNum;
    }

    for (const exp of expenseList) {
      if (!createNewRow && liveGroup) {
        const resolved = await resolveLiveExpenseSlot_(
          sheets,
          sheetIdClean,
          "Confirmed",
          knownJobRows,
          currRowNum,
          currSlotNum,
          exp,
          {
            preferRequestedIfValid: Boolean(!req.body.fromTriage && expenseList.length === 1),
            cachedAllRows: liveGroup.allRows,
            jobClient,
            jobName
          }
        );
        currRowNum = resolved.rowNum;
        currSlotNum = resolved.slotNum;
        if (resolved.createdNewRow) {
          dynamicJobLastRow = currRowNum;
          if (!knownJobRows.includes(currRowNum)) knownJobRows.push(currRowNum);
          liveGroup.allRows[currRowNum - 1] = [jobClient || "", jobName || ""];
        }
        // Mark slot as occupied in cachedAllRows so subsequent expenses in a multi-item batch pick the next priority slot
        const baseCol = currSlotNum === 1 ? 75 : currSlotNum === 2 ? 82 : 89;
        if (!liveGroup.allRows[currRowNum - 1]) liveGroup.allRows[currRowNum - 1] = [];
        liveGroup.allRows[currRowNum - 1][baseCol] = exp.description || exp.contactName || "Expense";
        liveGroup.allRows[currRowNum - 1][baseCol + 1] = exp.amount || 0;
        liveGroup.allRows[currRowNum - 1][baseCol + 6] = exp.appId || "ASSIGNED";
      } else if (currSlotNum > 3) {
        // If current slot exceeds 3, spill over to the next row of this job or create a new child row
        const nextKnownRow = knownJobRows.find(r => r > currRowNum);
        if (nextKnownRow) {
          currRowNum = nextKnownRow;
          currSlotNum = 1;
        } else {
          const newRowNum = await insertChildJobRow_(sheets, sheetIdClean, dynamicJobLastRow, jobClient, jobName);
          currRowNum = newRowNum;
          currSlotNum = 1;
          dynamicJobLastRow = newRowNum;
          knownJobRows.push(newRowNum);
        }
      }

      const slotColsForSlot = slotCols[currSlotNum];
      if (!slotColsForSlot) break;

      const vatAmountRaw = parseFloat(String(exp.vatAmount || "0").replace(/[£$€,]/g, "")) || 0;
      const vatYesNo = vatAmountRaw > 0 ? "Yes" : "No";
      const descToSave = getExpenseDescription(exp);
      const cleanExpStatus = String(exp.status || "").trim().toLowerCase() === "placeholder" ? "" : (exp.status || "");
      const parsedExpenseDate = parseExpenseDate(exp.date);
      const dateStrToWrite = parsedExpenseDate ? fmtDate(parsedExpenseDate) : (exp.date || "");

      if (liveGroup && liveGroup.allRows) {
        const baseCol = currSlotNum === 1 ? 75 : currSlotNum === 2 ? 82 : 89;
        if (!liveGroup.allRows[currRowNum - 1]) liveGroup.allRows[currRowNum - 1] = [];
        liveGroup.allRows[currRowNum - 1][baseCol] = descToSave;
        liveGroup.allRows[currRowNum - 1][baseCol + 1] = exp.amount || 0;
        liveGroup.allRows[currRowNum - 1][baseCol + 2] = vatYesNo;
        liveGroup.allRows[currRowNum - 1][baseCol + 3] = dateStrToWrite;
        liveGroup.allRows[currRowNum - 1][baseCol + 4] = 30;
        liveGroup.allRows[currRowNum - 1][baseCol + 5] = cleanExpStatus;
        liveGroup.allRows[currRowNum - 1][baseCol + 6] = exp.appId || "";
      }

      valueUpdates.push({
        range: `Confirmed!${slotColsForSlot.d}${currRowNum}:${slotColsForSlot.id}${currRowNum}`,
        values: [[
          sanitizeFormulaInput(descToSave),
          exp.amount || 0,
          vatYesNo,
          dateStrToWrite,
          30,
          sanitizeFormulaInput(cleanExpStatus),
          sanitizeFormulaInput(exp.appId || "")
        ]]
      });

      placed.push({
        rowNum: currRowNum,
        slotNum: currSlotNum,
        description: descToSave,
        amount: exp.amount || 0,
        vat: vatYesNo,
        date: dateStrToWrite,
        status: cleanExpStatus,
        transactionId: exp.appId || "",
        appId: exp.appId || ""
      });

      currSlotNum++;
    }

    // Compute placeholder adjustments BEFORE flushing valueUpdates so that any child row insertion
    // happens first and all value writes (placed expenses + new child row A/B/AJ + auto-placeholders)
    // are executed in a SINGLE values.batchUpdate call!
    let placeholderAdjustment = null;
    try {
      placeholderAdjustment = await adjustJobExpensePlaceholders_(
        sheets,
        sheetIdClean,
        "Confirmed",
        knownJobRows,
        req.body.jobBudget,
        masterSheetId,
        liveGroup?.allRows,
        { preloadedTolerances, returnBatchDataOnly: true }
      );
      if (placeholderAdjustment?.newChildRow && !knownJobRows.includes(placeholderAdjustment.newChildRow)) {
        knownJobRows.push(placeholderAdjustment.newChildRow);
      }
      if (Array.isArray(placeholderAdjustment?.batchData) && placeholderAdjustment.batchData.length > 0) {
        valueUpdates.push(...placeholderAdjustment.batchData);
      }
    } catch (pErr) {
      console.warn("handleAssignExpenseToJob placeholder adjustment failed (non-fatal):", pErr.message);
    }

    if (valueUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: valueUpdates,
        },
      });
    }

    const jobIdentifier = (jobClient && jobName) ? `"${jobClient} - ${jobName}"` : `"${jobName || jobClient || "Job"}"`;

    const summaryStr = placed.length === 1
      ? `Placed expense '${placed[0].description}' (£${placed[0].amount}) into ${jobIdentifier} (Row ${placed[0].rowNum}, Slot ${placed[0].slotNum})`
      : `Placed ${placed.length} expenses into ${jobIdentifier} sequentially starting at Row ${placed[0].rowNum}, Slot ${placed[0].slotNum}`;

    const assignedExpenseIds = placed.map(p => p.appId || p.transactionId).filter(Boolean);

    const bgTasks = (async () => {
      try {
        await invalidatePmaClientCache(sheetIdClean, masterSheetId, ["outgoings", "jobs"]);
      } catch (cErr) { }
      try {
        let tenantClient = req.body.clientName || "";
        if (!tenantClient) {
          tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
        }
        await Promise.all([
          resolveAssignedAlertsInMemoryAndCache(sheets, {
            acSheetId: req.body.automationCommanderSheetId,
            clientName: tenantClient,
            expenseIds: assignedExpenseIds,
            sessionId: req.body.sessionId || null,
          }),
          logPmaActivity(sheets, {
            automationCommanderSheetId: req.body.automationCommanderSheetId,
            clientName: tenantClient,
            category: "EXPENSES",
            action: createNewRow ? "Expense Placed (New Row)" : (placed.length > 1 ? "Expenses Placed (Sequential)" : "Expense Placed"),
            summary: summaryStr,
            details: {
              count: placed.length,
              endClient: jobClient,
              jobName,
              clientName: tenantClient,
              placed
            }
          })
        ]);
      } catch (e) {
        console.error("PMA log failed:", e);
      }
    })();
    try { waitUntil(bgTasks); } catch (_) { }

    return res.status(200).json({
      success: true,
      placed,
      newRowNum: createNewRow ? currRowNum : undefined,
      newRowsCreated: Boolean(
        knownJobRows.length > (Array.isArray(jobRows) ? jobRows.length : 1) ||
        placeholderAdjustment?.newChildRowCreated
      ),
      placeholderAdjustment
    });
  } catch (err) {
    console.error("❌ assign_expense_to_job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateExpenseSlot(req, res, sheets) {
  const { clientSheetId, masterSheetId, rowNum, slotNum, expense, deleteSlot, tabName, jobClient, jobName, createNewRow } = req.body;
  if (!clientSheetId || !rowNum || (!slotNum && !createNewRow)) return res.status(400).json({ success: false, error: "Missing clientSheetId, rowNum, or slotNum" });
  if (!deleteSlot && !expense) return res.status(400).json({ success: false, error: "Missing expense (or set deleteSlot: true)" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const targetTab = tabName ? String(tabName).trim() : "Confirmed";
    if (targetTab !== "Confirmed" && targetTab !== "Pipeline") {
      return res.status(400).json({ success: false, error: "Invalid tabName" });
    }

    let actualRowNum = parseInt(rowNum, 10);
    if (isNaN(actualRowNum) || actualRowNum < 2) {
      return res.status(400).json({ success: false, error: "Invalid rowNum" });
    }
    let actualSlotNum = parseInt(slotNum, 10);

    let resolvedExpenseJobRows = Array.isArray(req.body.jobRowNums) && req.body.jobRowNums.length > 0
      ? req.body.jobRowNums
      : [actualRowNum];

    const [liveGroup, preloadedTolerances] = await Promise.all([
      !createNewRow
        ? resolveFullJobRowGroup_(sheets, sheetIdClean, targetTab, resolvedExpenseJobRows).catch(() => null)
        : Promise.resolve(null),
      masterSheetId
        ? getToleranceValues(sheets, masterSheetId).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (liveGroup && liveGroup.allRowNums.length > 0) {
      resolvedExpenseJobRows = [...liveGroup.allRowNums];
    }

    let deferredChildRowWrites = [];
    if (createNewRow) {
      const childResult = await insertChildJobRow_(sheets, sheetIdClean, actualRowNum, jobClient || "", jobName || "", {
        deferValueWrites: true,
      });
      const newRowNum = typeof childResult === "object" ? childResult.targetRowNum : childResult;
      if (childResult?.valueUpdates) deferredChildRowWrites = childResult.valueUpdates;
      actualRowNum = newRowNum;
      actualSlotNum = 1;
      if (!resolvedExpenseJobRows.includes(newRowNum)) resolvedExpenseJobRows.push(newRowNum);
    } else if (!deleteSlot && expense) {
      try {
        const liveResolved = await resolveLiveExpenseSlot_(
          sheets,
          sheetIdClean,
          targetTab,
          resolvedExpenseJobRows,
          actualRowNum,
          actualSlotNum,
          expense,
          {
            preferRequestedIfValid: !req.body.fromTriage,
            cachedAllRows: liveGroup?.allRows || null,
            jobClient: jobClient || req.body.endClientName || "",
            jobName: jobName || ""
          }
        );
        if (liveResolved?.rowNum && liveResolved?.slotNum) {
          actualRowNum = liveResolved.rowNum;
          actualSlotNum = liveResolved.slotNum;
          if (Array.isArray(liveResolved.allRowNums) && liveResolved.allRowNums.length > 0) {
            resolvedExpenseJobRows = liveResolved.allRowNums;
          }
        }
      } catch (liveErr) {
        console.warn("Live expense slot verification skipped:", liveErr.message);
      }
    }

    const slotCols = {
      1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
      2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
      3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
    }[actualSlotNum];
    if (!slotCols) return res.status(400).json({ success: false, error: "Invalid slotNum" });

    const isExpPlaceholder = !deleteSlot && expense && (
      isPlaceholderExpense(expense.transactionId, expense.description, expense.status) ||
      (!String(expense.transactionId || "").trim() && String(expense.status || "").trim().toLowerCase() === "placeholder")
    );
    const sanitizedExpStatus = (!deleteSlot && expense)
      ? (isExpPlaceholder || String(expense.status || "").trim().toLowerCase() === "placeholder" ? "" : (expense.status || ""))
      : "";

    const formattedDate = (!deleteSlot && expense?.date) ? (toSheetDateFormat(expense.date) || expense.date) : "";
    const values = deleteSlot
      ? ["", "", "", "", "", "", ""]
      : [
        sanitizeFormulaInput(expense.description || ""),
        expense.amount || 0,
        expense.vat || "No",
        formattedDate,
        expense.daysToPay || 30,
        sanitizeFormulaInput(sanitizedExpStatus),
        sanitizeFormulaInput(expense.transactionId || ""),
      ];

    // Update cachedAllRows in-place so adjustJobExpensePlaceholders_ needs zero additional reads
    if (liveGroup?.allRows) {
      const baseCol = actualSlotNum === 1 ? 75 : actualSlotNum === 2 ? 82 : 89;
      if (!liveGroup.allRows[actualRowNum - 1]) liveGroup.allRows[actualRowNum - 1] = [];
      for (let k = 0; k < 7; k++) {
        liveGroup.allRows[actualRowNum - 1][baseCol + k] = values[k];
      }
    }

    const allWriteData = [
      ...deferredChildRowWrites,
      {
        range: `${targetTab}!${slotCols.d}${actualRowNum}:${slotCols.id}${actualRowNum}`,
        values: [values],
      },
    ];

    let placeholderAdjustment = null;
    try {
      placeholderAdjustment = await adjustJobExpensePlaceholders_(
        sheets,
        sheetIdClean,
        targetTab,
        resolvedExpenseJobRows,
        req.body.jobBudget,
        masterSheetId,
        liveGroup?.allRows || null,
        { preloadedTolerances, returnBatchDataOnly: true }
      );
      if (Array.isArray(placeholderAdjustment?.batchData) && placeholderAdjustment.batchData.length > 0) {
        allWriteData.push(...placeholderAdjustment.batchData);
      }
    } catch (pErr) {
      console.warn("handleUpdateExpenseSlot placeholder adjustment failed (non-fatal):", pErr.message);
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: allWriteData,
      },
    });

    const bgTasks = (async () => {
      try {
        await invalidatePmaClientCache(sheetIdClean, masterSheetId, ["outgoings", "jobs"]);
      } catch (_) { }
      try {
        let tenantClient = req.body.clientName || "";
        if (!tenantClient) {
          tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
        }
        let endClient = req.body.endClientName || String(liveGroup?.parentRow?.[0] || "").trim() || "";
        let job = req.body.jobName || String(liveGroup?.parentRow?.[1] || "").trim() || "";
        const jobIdentifier = (endClient && job) ? `"${endClient} - ${job}"` : `"${job || endClient || `Row ${rowNum}`}"`;

        await logPmaActivity(sheets, {
          automationCommanderSheetId: req.body.automationCommanderSheetId,
          clientName: tenantClient,
          category: "EXPENSES",
          action: deleteSlot ? "Expense Slot Cleared" : "Expense Slot Updated",
          summary: deleteSlot
            ? `Cleared expense slot #${slotNum} on ${targetTab} Row ${rowNum} for ${jobIdentifier}`
            : `Updated expense slot #${slotNum} on ${targetTab} Row ${rowNum} for ${jobIdentifier} (${expense?.description || "Expense"}, £${expense?.amount || 0})`,
          details: {
            slotNum,
            rowNum,
            endClient,
            jobName: job,
            clientName: tenantClient,
            deleteSlot: !!deleteSlot,
            description: expense?.description,
            amount: expense?.amount,
            status: expense?.status
          }
        });
      } catch (e) {
        console.error("PMA log failed:", e);
      }
    })();
    try { waitUntil(bgTasks); } catch (_) { }

    return res.status(200).json({
      success: true,
      rowNum: actualRowNum,
      slotNum: actualSlotNum,
      placeholderAdjustment
    });
  } catch (err) {
    console.error("❌ update_expense_slot error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleAssignInvoiceToJob(req, res, sheets) {
  const {
    clientSheetId, masterSheetId, rowNum, slotNum, invoice, createNewRow,
    jobLastRow, jobClient, jobName, updateClientName, newClientName, jobRowNums,
    updateJobName, newJobName
  } = req.body;
  console.log(`ℹ PMA handleAssignInvoiceToJob: client="${req.body.clientName}", job="${jobName}", invoiceNo="${invoice?.invoiceNo}", createNewRow=${createNewRow}, rowNum=${rowNum}, slotNum=${slotNum}`);
  if (!clientSheetId || !invoice) {
    console.error(`❌ PMA handleAssignInvoiceToJob: Missing clientSheetId (${clientSheetId}) or invoice (${Boolean(invoice)})`);
    return res.status(400).json({ success: false, error: "Missing clientSheetId or invoice" });
  }
  if (!createNewRow && (!rowNum || !slotNum)) {
    console.error(`❌ PMA handleAssignInvoiceToJob: Missing rowNum (${rowNum}) or slotNum (${slotNum})`);
    return res.status(400).json({ success: false, error: "Missing rowNum or slotNum" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const slotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    };

    const effectiveClientName = (updateClientName && newClientName) ? newClientName : (jobClient || "");
    const effectiveJobName = (updateJobName && newJobName) ? newJobName : (jobName || "");

    const norm = (s) => String(s || "").trim().toLowerCase();
    const targetClient = norm(jobClient);
    const targetJobName = norm(jobName);

    let currentMaxRows = 5000;
    let gridSheetId = null;
    let existingRowGroups = [];
    let allRows = [];
    let preloadedTolerances = null;

    const findMatchingRowsIn = (rowsArr) => {
      const indices = [];
      for (let i = 1; i < rowsArr.length; i++) {
        const r = rowsArr[i];
        if (!r) continue;
        const c = norm(r[0]);
        const j = norm(r[1]);
        if (targetClient && targetJobName && c === targetClient && j === targetJobName) {
          indices.push(i + 1);
        }
      }
      if (indices.length === 0 && targetJobName) {
        for (let i = 1; i < rowsArr.length; i++) {
          const r = rowsArr[i];
          if (!r) continue;
          const j = norm(r[1]);
          if (j === targetJobName) {
            indices.push(i + 1);
          }
        }
      }
      return indices;
    };

    if (createNewRow) {
      const [metaResp, fullResp, tols] = await Promise.all([
        sheets.spreadsheets.get({
          spreadsheetId: sheetIdClean,
          fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
        }),
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "UNFORMATTED_VALUE",
        }),
        masterSheetId ? getToleranceValues(sheets, masterSheetId).catch(() => null) : Promise.resolve(null),
      ]);
      preloadedTolerances = tols;
      const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
      if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });
      gridSheetId = confirmedSheet.properties.sheetId;
      currentMaxRows = confirmedSheet.properties.gridProperties?.rowCount || 5000;
      existingRowGroups = confirmedSheet.rowGroups || [];
      allRows = fullResp.data.values || [];
    } else {
      const seedCandidates = (Array.isArray(jobRowNums) && jobRowNums.length > 0 ? jobRowNums : [rowNum])
        .map(n => parseInt(n, 10))
        .filter(n => !isNaN(n) && n >= 2);
      const minSeed = seedCandidates.length > 0 ? Math.min(...seedCandidates) : (parseInt(rowNum, 10) || 2);
      const maxSeed = seedCandidates.length > 0 ? Math.max(...seedCandidates) : (parseInt(rowNum, 10) || 2);
      const winStart = Math.max(1, minSeed - 40);
      const winEnd = maxSeed + 60;

      const [winResp, tols] = await Promise.all([
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `Confirmed!A${winStart}:BH${winEnd}`,
          valueRenderOption: "UNFORMATTED_VALUE",
        }).catch(() => null),
        masterSheetId ? getToleranceValues(sheets, masterSheetId).catch(() => null) : Promise.resolve(null),
      ]);
      preloadedTolerances = tols;

      let windowResolved = false;
      if (winResp?.data?.values) {
        const fetched = winResp.data.values;
        const sparseRows = [];
        for (let i = 0; i < fetched.length; i++) {
          sparseRows[winStart - 1 + i] = fetched[i];
        }
        const winMatches = findMatchingRowsIn(sparseRows);
        const hitsBoundary = winMatches.length > 0 && (
          (winStart > 2 && winMatches[0] <= winStart + 1) ||
          winMatches[winMatches.length - 1] >= winEnd - 1
        );
        const directRowMatch = winMatches.length === 0 && targetJobName && norm(sparseRows[rowNum - 1]?.[1]) === targetJobName;
        if ((winMatches.length > 0 && !hitsBoundary) || directRowMatch) {
          allRows = sparseRows;
          windowResolved = true;
        }
      }

      if (!windowResolved) {
        const fullResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:BH5000",
          valueRenderOption: "UNFORMATTED_VALUE",
        });
        allRows = fullResp.data.values || [];
      }
    }

    const matchingRowIndices = findMatchingRowsIn(allRows);

    let targetRowNum = rowNum;
    let targetSlotNum = slotNum;
    const allWriteData = [];

    if (createNewRow) {
      const actualJobLastRow = matchingRowIndices.length > 0
        ? matchingRowIndices[matchingRowIndices.length - 1]
        : jobLastRow;
      if (!actualJobLastRow) return res.status(400).json({ success: false, error: "Missing jobLastRow for createNewRow" });

      let trueLastRow = 0;
      for (let r = allRows.length - 1; r >= 0; r--) {
        const row = allRows[r] || [];
        const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
        const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
        const z3 = row.slice(41, 60).some(c => c !== "" && c != null);
        const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
        if (z1 || z2 || z3 || z4) { trueLastRow = r + 1; break; }
      }

      const jobVAT = allRows[actualJobLastRow - 1]?.[34] ?? "";
      const vatAmountVal = parseFloat(String(invoice.vatAmount || invoice.vatIncluded || 0)) || 0;
      const vatVal = vatAmountVal > 0 ? "Yes" : (invoice.vatYesNo || jobVAT || "No");

      const structuralRequests = [];
      if (currentMaxRows - (trueLastRow + 1) < 1) {
        structuralRequests.push({
          insertDimension: {
            range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 },
            inheritFromBefore: true,
          },
        });
        currentMaxRows += 5;
      }

      const sourceRowIndex0 = trueLastRow;
      const destRowIndex0 = actualJobLastRow;

      structuralRequests.push({
        moveDimension: {
          source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: sourceRowIndex0, endIndex: sourceRowIndex0 + 1 },
          destinationIndex: destRowIndex0,
        },
      });

      targetRowNum = actualJobLastRow + 1;
      targetSlotNum = 1;

      const destRowIndex1based0 = actualJobLastRow;
      const coveringGroup = existingRowGroups.find(g =>
        g.range?.startIndex <= destRowIndex1based0 - 1 && g.range?.endIndex >= destRowIndex1based0
      );
      if (coveringGroup) {
        const groupEndIdx = coveringGroup.range.endIndex + 1;
        structuralRequests.push(
          {
            deleteDimensionGroup: {
              range: {
                sheetId: gridSheetId, dimension: "ROWS",
                startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex,
              }
            }
          },
          {
            addDimensionGroup: {
              range: {
                sheetId: gridSheetId, dimension: "ROWS",
                startIndex: coveringGroup.range.startIndex, endIndex: groupEndIdx,
              }
            }
          },
        );
        if (coveringGroup.collapsed) {
          structuralRequests.push(
            {
              updateDimensionGroup: {
                dimensionGroup: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: groupEndIdx },
                  depth: coveringGroup.depth || 1,
                  collapsed: true,
                },
                fields: "collapsed",
              },
            },
            {
              updateDimensionProperties: {
                range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: groupEndIdx },
                properties: { hiddenByUser: true },
                fields: "hiddenByUser",
              },
            }
          );
        } else {
          structuralRequests.push({
            updateDimensionProperties: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: groupEndIdx },
              properties: { hiddenByUser: false },
              fields: "hiddenByUser",
            },
          });
        }
      } else {
        structuralRequests.push(
          {
            addDimensionGroup: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: destRowIndex1based0, endIndex: destRowIndex1based0 + 1 },
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: destRowIndex1based0, endIndex: destRowIndex1based0 + 1 },
              properties: { hiddenByUser: false },
              fields: "hiddenByUser",
            },
          }
        );
      }

      // Execute all structural & grouping operations in a single batchUpdate call
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: { requests: structuralRequests },
      });

      allWriteData.push(
        { range: `Confirmed!A${targetRowNum}`, values: [[sanitizeFormulaInput(effectiveClientName)]] },
        { range: `Confirmed!B${targetRowNum}`, values: [[sanitizeFormulaInput(effectiveJobName)]] },
        { range: `Confirmed!AI${targetRowNum}`, values: [[vatVal]] },
      );

      // Reflect the newly inserted child row in allRows
      allRows[targetRowNum - 1] = [];
      allRows[targetRowNum - 1][0] = effectiveClientName;
      allRows[targetRowNum - 1][1] = effectiveJobName;
      allRows[targetRowNum - 1][34] = vatVal;
    } else {
      // Existing row slot placement: defensively verify targetRowNum
      if (!matchingRowIndices.includes(rowNum)) {
        if (matchingRowIndices.length > 0) {
          const origJobRows = Array.isArray(jobRowNums) ? jobRowNums : [rowNum];
          const relIdx = origJobRows.indexOf(rowNum);
          if (relIdx >= 0 && matchingRowIndices[relIdx]) {
            targetRowNum = matchingRowIndices[relIdx];
          } else {
            const slotBaseCol = targetSlotNum === 1 ? 41 : targetSlotNum === 2 ? 48 : 55;
            const foundRow = matchingRowIndices.find(rNum => {
              const r = allRows[rNum - 1] || [];
              const amt = String(r[slotBaseCol] || "").trim();
              const ref = String(r[slotBaseCol + 1] || "").trim();
              return !ref || isPlaceholderInvoice(ref) || !amt;
            });
            targetRowNum = foundRow || matchingRowIndices[0];
          }
          console.log(`ℹ Reconciled shifted row from ${rowNum} to ${targetRowNum} for job "${jobName}"`);
        } else {
          const candJob = norm(allRows[rowNum - 1]?.[1]);
          if (targetJobName && candJob === targetJobName) {
            targetRowNum = rowNum;
          } else {
            return res.status(400).json({
              success: false,
              error: `Could not verify job "${jobName}" on Confirmed sheet (expected row ${rowNum}). Rows may have been moved or deleted. Please refresh the page.`
            });
          }
        }
      }

      // Live-resolve best slot across the job's parent + child rows using the 5-step priority order
      try {
        const seedRowsForJob = matchingRowIndices.length > 0 ? matchingRowIndices : [targetRowNum];
        const liveResolved = await resolveLiveInvoiceSlot_(
          sheets,
          sheetIdClean,
          "Confirmed",
          seedRowsForJob,
          targetRowNum,
          targetSlotNum,
          invoice,
          {
            preferRequestedIfValid: Boolean(!req.body.fromTriage && req.body.explicitSlotSelection),
            cachedAllRows: allRows,
            jobClient: effectiveClientName,
            jobName: effectiveJobName
          }
        );
        if (liveResolved?.rowNum && liveResolved?.slotNum) {
          targetRowNum = liveResolved.rowNum;
          targetSlotNum = liveResolved.slotNum;
          if (Array.isArray(liveResolved.allRowNums)) {
            for (const rNum of liveResolved.allRowNums) {
              if (!matchingRowIndices.includes(rNum)) matchingRowIndices.push(rNum);
            }
          }
        }
      } catch (liveErr) {
        console.warn("handleAssignInvoiceToJob live slot resolution skipped:", liveErr.message);
      }
    }

    if (updateClientName && newClientName) {
      const rowsToUpdate = new Set(matchingRowIndices.length > 0 ? matchingRowIndices : (Array.isArray(jobRowNums) ? jobRowNums : []));
      if (rowNum) rowsToUpdate.add(rowNum);
      if (targetRowNum) rowsToUpdate.add(targetRowNum);

      for (const r of rowsToUpdate) {
        allWriteData.push({
          range: `Confirmed!A${r}`,
          values: [[sanitizeFormulaInput(newClientName)]]
        });
        if (allRows[r - 1]) allRows[r - 1][0] = newClientName;
      }
    }

    if (updateJobName && newJobName) {
      const rowsToUpdate = new Set(matchingRowIndices.length > 0 ? matchingRowIndices : (Array.isArray(jobRowNums) ? jobRowNums : []));
      if (rowNum) rowsToUpdate.add(rowNum);
      if (targetRowNum) rowsToUpdate.add(targetRowNum);

      for (const r of rowsToUpdate) {
        allWriteData.push({
          range: `Confirmed!B${r}`,
          values: [[sanitizeFormulaInput(newJobName)]]
        });
        if (allRows[r - 1]) allRows[r - 1][1] = newJobName;
      }
    }

    // Update revenue if user chose to increase job revenue to match total invoiced
    const parentRowIndex = matchingRowIndices.length > 0 ? matchingRowIndices[0] : (createNewRow ? targetRowNum : rowNum);
    let effectiveRevenue = undefined;
    if (req.body.updateJobRevenue && req.body.newJobRevenue !== undefined) {
      effectiveRevenue = parseFloat(req.body.newJobRevenue) || 0;
      allWriteData.push({
        range: `Confirmed!AG${parentRowIndex}`,
        values: [[effectiveRevenue]]
      });
      if (allRows[parentRowIndex - 1]) allRows[parentRowIndex - 1][32] = effectiveRevenue;
    }

    const slotColsForSlot = slotCols[targetSlotNum];
    if (!slotColsForSlot) return res.status(400).json({ success: false, error: "Invalid slotNum" });

    let daysToPay = 30;
    if (invoice.sentDate && invoice.dueDate) {
      const parseD = (d) => {
        const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      };
      const sent = parseD(invoice.sentDate), due = parseD(invoice.dueDate);
      if (sent && due) daysToPay = Math.round((due - sent) / 86400000);
    }

    let formattedSentStr = invoice.sentDate || "";
    if (invoice.sentDate) {
      const parsedSentDate = (() => {
        const m = String(invoice.sentDate).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      })();
      if (parsedSentDate) {
        const ms = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        formattedSentStr = `${parsedSentDate.getDate()}-${ms[parsedSentDate.getMonth()]}-${parsedSentDate.getFullYear()}`;
      }
    }

    allWriteData.push(
      { range: `Confirmed!${slotColsForSlot.a}${targetRowNum}`, values: [[invoice.amount || 0]] },
      { range: `Confirmed!${slotColsForSlot.ref}${targetRowNum}`, values: [[sanitizeFormulaInput(invoice.invoiceNo || "")]] },
      { range: `Confirmed!${slotColsForSlot.days}${targetRowNum}`, values: [[daysToPay]] },
      { range: `Confirmed!${slotColsForSlot.st}${targetRowNum}`, values: [[sanitizeFormulaInput(invoice.status || "Sent")]] },
    );
    if (formattedSentStr) {
      allWriteData.push({
        range: `Confirmed!${slotColsForSlot.sent}${targetRowNum}`,
        values: [[formattedSentStr]],
      });
    }

    // Update in-memory allRows for targetRowNum so placeholder adjustments know this slot has a real invoice!
    if (allRows) {
      if (!allRows[targetRowNum - 1]) allRows[targetRowNum - 1] = [];
      const baseCol = targetSlotNum === 1 ? 41 : targetSlotNum === 2 ? 48 : 55;
      allRows[targetRowNum - 1][baseCol] = invoice.amount || 0;
      allRows[targetRowNum - 1][baseCol + 1] = invoice.invoiceNo || "";
      allRows[targetRowNum - 1][baseCol + 2] = formattedSentStr;
      allRows[targetRowNum - 1][baseCol + 3] = daysToPay;
      allRows[targetRowNum - 1][baseCol + 4] = invoice.status || "Sent";
    }

    // Compute placeholder adjustments BEFORE flushing allWriteData so all cell updates happen in a SINGLE batchUpdate!
    const allJobRowsToCheck = matchingRowIndices.length > 0 ? [...matchingRowIndices] : [targetRowNum];
    if (createNewRow && !allJobRowsToCheck.includes(targetRowNum)) {
      allJobRowsToCheck.push(targetRowNum);
    }
    let placeholderAdjustment = null;
    try {
      placeholderAdjustment = await adjustJobInvoicePlaceholders_(
        sheets,
        sheetIdClean,
        "Confirmed",
        allJobRowsToCheck,
        effectiveRevenue,
        masterSheetId,
        allRows,
        { preloadedTolerances, returnBatchDataOnly: true }
      );
      if (Array.isArray(placeholderAdjustment?.batchData) && placeholderAdjustment.batchData.length > 0) {
        allWriteData.push(...placeholderAdjustment.batchData);
      }
    } catch (pErr) {
      console.warn("handleAssignInvoiceToJob placeholder adjustment failed (non-fatal):", pErr.message);
    }

    if (allWriteData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: allWriteData,
        },
      });
    }

    const endClient = effectiveClientName || jobClient || "";
    const jobIdentifier = (endClient && jobName) ? `"${endClient} - ${jobName}"` : `"${jobName || endClient || "Job"}"`;

    const bgInvoiceTasks = (async () => {
      try {
        await invalidatePmaClientCache(sheetIdClean, masterSheetId, ["invoices", "jobs", "retainers", "cash"]);
      } catch (_) { }
      try {
        let tenantClient = req.body.clientName || "";
        if (!tenantClient) {
          tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
        }
        await Promise.all([
          resolveAssignedAlertsInMemoryAndCache(sheets, {
            acSheetId: req.body.automationCommanderSheetId,
            clientName: tenantClient,
            invoiceNos: [invoice.invoiceNo].filter(Boolean),
            sessionId: req.body.sessionId || null,
          }),
          logPmaActivity(sheets, {
            automationCommanderSheetId: req.body.automationCommanderSheetId,
            clientName: tenantClient,
            category: "INVOICES",
            action: createNewRow ? "Invoice Placed (New Row)" : "Invoice Placed",
            summary: `Placed invoice #${invoice.invoiceNo} (£${invoice.amount || 0}) into ${jobIdentifier} (Row ${targetRowNum}, Slot ${targetSlotNum})`,
            details: {
              invoiceNumber: invoice.invoiceNo,
              amount: invoice.amount,
              jobName,
              endClient,
              clientName: tenantClient,
              slot: targetSlotNum,
              row: targetRowNum,
              isNewRow: !!createNewRow
            }
          })
        ]);
      } catch (e) {
        console.error("PMA log failed:", e);
      }
    })();
    try { waitUntil(bgInvoiceTasks); } catch (_) { }

    return res.status(200).json({
      success: true,
      newRowNum: createNewRow ? targetRowNum : undefined,
      targetRowNum,
      rowShifted: targetRowNum !== rowNum,
      placeholderAdjustment,
      updatedRevenue: req.body.updateJobRevenue ? effectiveRevenue : undefined
    });
  } catch (err) {
    console.error("❌ assign_invoice_to_job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleMoveInvoiceToJob(req, res, sheets) {
  const {
    clientSheetId, masterSheetId, tabName,
    sourceRowNum, sourceSlotNum, sourceJobClient, sourceJobName, invoiceRef,
    targetJobClient, targetJobName, targetRowNum, targetSlotNum, createNewRow, targetJobLastRow,
    updateTargetRevenue, newTargetRevenue,
    invoice
  } = req.body;

  if (!clientSheetId || !invoice) {
    return res.status(400).json({ success: false, error: "Missing clientSheetId or invoice" });
  }
  if (!sourceRowNum || !sourceSlotNum) {
    return res.status(400).json({ success: false, error: "Missing sourceRowNum or sourceSlotNum" });
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const targetTab = tabName ? String(tabName).trim() : "Confirmed";
    if (targetTab !== "Confirmed" && targetTab !== "Pipeline") {
      return res.status(400).json({ success: false, error: "Invalid tabName" });
    }

    const slotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    };

    const sSlotCols = slotCols[sourceSlotNum];
    if (!sSlotCols) return res.status(400).json({ success: false, error: "Invalid sourceSlotNum" });

    let actualTargetRowNum = targetRowNum;
    let actualTargetSlotNum = targetSlotNum;

    const [sourceGroup, targetGroup, preloadedTolerances] = await Promise.all([
      resolveFullJobRowGroup_(sheets, sheetIdClean, targetTab, [sourceRowNum]).catch(() => null),
      !createNewRow
        ? resolveFullJobRowGroup_(sheets, sheetIdClean, targetTab, [targetRowNum]).catch(() => null)
        : Promise.resolve(null),
      masterSheetId
        ? getToleranceValues(sheets, masterSheetId).catch(() => null)
        : Promise.resolve(null),
    ]);

    let deferredChildRowWrites = [];
    if (createNewRow) {
      const childResult = await insertChildJobRow_(
        sheets,
        sheetIdClean,
        targetJobLastRow || targetRowNum,
        targetJobClient,
        targetJobName,
        { deferValueWrites: true }
      );
      const newRowNum = typeof childResult === "object" ? childResult.targetRowNum : childResult;
      if (childResult?.valueUpdates) deferredChildRowWrites = childResult.valueUpdates;
      actualTargetRowNum = newRowNum;
      actualTargetSlotNum = 1;
    }

    const tSlotCols = slotCols[actualTargetSlotNum];
    if (!tSlotCols) return res.status(400).json({ success: false, error: "Invalid targetSlotNum" });

    const daysToPay = parseInt(invoice.daysToPay, 10) || 30;
    const invAmt = parseFloat(invoice.amount) || 0;
    const invRef = sanitizeFormulaInput(invoice.invoiceNo || invoice.ref || "");
    const invStatus = sanitizeFormulaInput(invoice.status ? canonicalizeInvoiceStatus(invoice.status) : "Sent");
    const formattedSentDate = invoice.sentDate ? (toSheetDateFormat(invoice.sentDate) || invoice.sentDate) : "";

    let effectiveTargetRevenue = undefined;
    const allWriteData = [
      ...deferredChildRowWrites,
      // Clear source slot
      { range: `${targetTab}!${sSlotCols.a}${sourceRowNum}:${sSlotCols.st}${sourceRowNum}`, values: [["", "", "", "", ""]] },
      // Write target slot
      {
        range: `${targetTab}!${tSlotCols.a}${actualTargetRowNum}:${tSlotCols.st}${actualTargetRowNum}`,
        values: [[invAmt, invRef, formattedSentDate, daysToPay, invStatus]],
      },
    ];

    if (updateTargetRevenue && newTargetRevenue !== undefined) {
      effectiveTargetRevenue = parseFloat(newTargetRevenue) || 0;
      const revTargetRow = targetGroup?.parentRowNum || actualTargetRowNum;
      allWriteData.push({
        range: `${targetTab}!AG${revTargetRow}`,
        values: [[effectiveTargetRevenue]],
      });
    }

    // Update preloaded groups in-place so adjustJobInvoicePlaceholders_ computes in-memory and any structural
    // child-row insertions inside adjustJobInvoicePlaceholders_ run BEFORE values.batchUpdate!
    if (sourceGroup?.allRows?.[sourceRowNum - 1]) {
      const sBaseCol = sourceSlotNum === 1 ? 41 : sourceSlotNum === 2 ? 48 : 55;
      for (let k = 0; k < 5; k++) sourceGroup.allRows[sourceRowNum - 1][sBaseCol + k] = "";
    }
    if (!createNewRow && targetGroup?.allRows) {
      if (!targetGroup.allRows[actualTargetRowNum - 1]) targetGroup.allRows[actualTargetRowNum - 1] = [];
      const tBaseCol = actualTargetSlotNum === 1 ? 41 : actualTargetSlotNum === 2 ? 48 : 55;
      const tVals = [invAmt, invRef, formattedSentDate, daysToPay, invStatus];
      for (let k = 0; k < 5; k++) targetGroup.allRows[actualTargetRowNum - 1][tBaseCol + k] = tVals[k];
      if (effectiveTargetRevenue !== undefined && targetGroup.allRows[targetGroup.parentRowNum - 1]) {
        targetGroup.allRows[targetGroup.parentRowNum - 1][32] = effectiveTargetRevenue;
      }
    }

    const [sourcePlaceholderAdjustment, targetPlaceholderAdjustment] = await Promise.all([
      adjustJobInvoicePlaceholders_(sheets, sheetIdClean, targetTab, sourceGroup?.allRowNums || [sourceRowNum], undefined, masterSheetId, {
        preloadedGroup: sourceGroup,
        preloadedTolerances,
        returnBatchDataOnly: true,
      }).catch(sErr => {
        console.warn("Source job placeholder adjustment check failed:", sErr.message);
        return null;
      }),
      adjustJobInvoicePlaceholders_(sheets, sheetIdClean, targetTab, targetGroup?.allRowNums || [actualTargetRowNum], effectiveTargetRevenue, masterSheetId, {
        preloadedGroup: !createNewRow ? targetGroup : null,
        preloadedTolerances,
        returnBatchDataOnly: true,
      }).catch(tErr => {
        console.warn("Target job placeholder adjustment check failed:", tErr.message);
        return null;
      }),
    ]);

    if (sourcePlaceholderAdjustment?.batchData?.length > 0) {
      allWriteData.push(...sourcePlaceholderAdjustment.batchData);
    }
    if (targetPlaceholderAdjustment?.batchData?.length > 0) {
      allWriteData.push(...targetPlaceholderAdjustment.batchData);
    }

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: allWriteData,
        },
      })
    );

    const bgTasks = (async () => {
      try {
        await invalidatePmaClientCache(sheetIdClean, masterSheetId, ["invoices", "jobs", "retainers", "cash"]);
      } catch (_) { }
      try {
        let tenantClient = req.body.clientName || "";
        if (!tenantClient) {
          tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
        }

        await logPmaActivity(sheets, {
          automationCommanderSheetId: req.body.automationCommanderSheetId,
          clientName: tenantClient,
          category: "INVOICES",
          action: "Invoice Moved",
          summary: `Moved invoice #${invRef} (£${invAmt}) from "${sourceJobName}" to "${targetJobName}"`,
          details: {
            invoiceNumber: invRef,
            amount: invAmt,
            sourceJobName,
            targetJobName,
            sourceRowNum,
            targetRowNum: actualTargetRowNum,
            targetSlotNum: actualTargetSlotNum,
            clientName: tenantClient
          }
        });
      } catch (e) {
        console.error("PMA log failed:", e);
      }
    })();
    try { waitUntil(bgTasks); } catch (_) { }

    return res.status(200).json({
      success: true,
      targetRowNum: actualTargetRowNum,
      targetSlotNum: actualTargetSlotNum,
      isNewRow: !!createNewRow,
      sourcePlaceholderAdjustment,
      targetPlaceholderAdjustment,
      updatedTargetRevenue: updateTargetRevenue ? effectiveTargetRevenue : undefined
    });
  } catch (err) {
    console.error("❌ handleMoveInvoiceToJob error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleVerifyInvoiceSlot(req, res, sheets) {
  const { clientSheetId, rowNum, slotNum, invoiceRef, tabName } = req.body;
  if (!clientSheetId || !invoiceRef) {
    return res.status(400).json({ success: false, error: "Missing clientSheetId or invoiceRef" });
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const targetTab = tabName ? String(tabName).trim() : "Confirmed";
    if (targetTab !== "Confirmed" && targetTab !== "Pipeline") {
      return res.status(400).json({ success: false, error: "Invalid tabName" });
    }
    const cleanTargetRef = String(invoiceRef).trim().toLowerCase();
    const parsedRowNum = rowNum ? parseInt(rowNum, 10) : null;

    const extractSlotMatchFromRow = (rowVals, liveRowNum) => {
      if (!rowVals) return null;
      const slots = [
        { slotNum: 1, ref: String(rowVals[42] || "").trim(), amt: rowVals[41], sent: rowVals[43], status: rowVals[45] },
        { slotNum: 2, ref: String(rowVals[49] || "").trim(), amt: rowVals[48], sent: rowVals[50], status: rowVals[52] },
        { slotNum: 3, ref: String(rowVals[56] || "").trim(), amt: rowVals[55], sent: rowVals[57], status: rowVals[59] },
      ];
      const match = slots.find(s => s.ref.toLowerCase() === cleanTargetRef);
      if (!match) return null;
      return {
        success: true,
        found: true,
        liveRowNum,
        liveSlotNum: match.slotNum,
        liveClient: String(rowVals[0] || "").trim(),
        liveJobName: String(rowVals[1] || "").trim(),
        liveProjectCode: String(rowVals[2] || "").trim(),
        liveAmount: match.amt || "",
        liveSentDate: match.sent || "",
        liveStatus: canonicalizeInvoiceStatus(match.status) || "",
        rowShifted: parsedRowNum ? liveRowNum !== parsedRowNum : false
      };
    };

    // 1. If rowNum provided as hint, check a local window (+/- 35 rows) first to avoid downloading 5,000 rows
    if (parsedRowNum && parsedRowNum > 0) {
      const winStart = Math.max(2, parsedRowNum - 35);
      const winEnd = parsedRowNum + 35;
      try {
        const checkResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!A${winStart}:BH${winEnd}`,
          valueRenderOption: "FORMATTED_VALUE"
        });
        const winRows = checkResp.data.values || [];
        // Check exact rowNum first
        const exactOffset = parsedRowNum - winStart;
        if (exactOffset >= 0 && exactOffset < winRows.length) {
          const exactHit = extractSlotMatchFromRow(winRows[exactOffset], parsedRowNum);
          if (exactHit) return res.status(200).json(exactHit);
        }
        // Check neighboring rows in the local window
        for (let i = 0; i < winRows.length; i++) {
          if (i === exactOffset) continue;
          const neighborHit = extractSlotMatchFromRow(winRows[i], winStart + i);
          if (neighborHit) return res.status(200).json(neighborHit);
        }
      } catch (rowErr) {
        console.warn(`handleVerifyInvoiceSlot window check failed around row ${parsedRowNum}:`, rowErr.message);
      }
    }

    // 2. Fallback: scan the tab if not found in the local window
    const scanResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: `${targetTab}!A1:BH5000`,
      valueRenderOption: "FORMATTED_VALUE"
    });
    const allRows = scanResp.data.values || [];

    for (let r = 0; r < allRows.length; r++) {
      const hit = extractSlotMatchFromRow(allRows[r], r + 1);
      if (hit) return res.status(200).json(hit);
    }

    // 3. Not found anywhere on the tab
    return res.status(200).json({
      success: true,
      found: false,
      message: `Invoice reference "${invoiceRef}" was not found on ${targetTab}.`
    });
  } catch (err) {
    console.error("❌ handleVerifyInvoiceSlot error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateInvoiceSlot(req, res, sheets) {
  const { clientSheetId, masterSheetId, rowNum, slotNum, invoice, deleteSlot, jobClient, jobName, tabName, createNewRow } = req.body;
  if (!clientSheetId || !rowNum || (!slotNum && !createNewRow)) return res.status(400).json({ success: false, error: "Missing clientSheetId, rowNum, or slotNum" });
  if (!deleteSlot && !invoice) return res.status(400).json({ success: false, error: "Missing invoice (or set deleteSlot: true)" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const targetTab = tabName ? String(tabName).trim() : "Confirmed";
    if (targetTab !== "Confirmed" && targetTab !== "Pipeline") {
      return res.status(400).json({ success: false, error: "Invalid tabName" });
    }

    let actualRowNum = parseInt(rowNum, 10);
    if (isNaN(actualRowNum) || actualRowNum < 2) {
      return res.status(400).json({ success: false, error: "Invalid rowNum" });
    }
    let actualSlotNum = parseInt(slotNum, 10);

    let resolvedInvoiceJobRows = Array.isArray(req.body.jobRowNums) && req.body.jobRowNums.length > 0
      ? req.body.jobRowNums.map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n >= 2)
      : [actualRowNum];
    if (resolvedInvoiceJobRows.length === 0) resolvedInvoiceJobRows = [actualRowNum];

    // Fetch local job window (A:CR) and tolerance values in parallel so we have client/job names,
    // all 3 invoice slots, and revenue in memory from a SINGLE read!
    const [liveGroup, preloadedTolerances] = await Promise.all([
      !createNewRow
        ? resolveFullJobRowGroup_(sheets, sheetIdClean, targetTab, resolvedInvoiceJobRows).catch(() => null)
        : Promise.resolve(null),
      masterSheetId
        ? getToleranceValues(sheets, masterSheetId).catch(() => null)
        : Promise.resolve(null),
    ]);

    let cachedAllRows = liveGroup?.allRows || null;
    if (liveGroup && liveGroup.allRowNums.length > 0) {
      resolvedInvoiceJobRows = [...liveGroup.allRowNums];
    }
    let resolvedParentRowNum = liveGroup?.parentRowNum || actualRowNum;

    let deferredChildRowWrites = [];
    if (createNewRow) {
      const childResult = await insertChildJobRow_(sheets, sheetIdClean, actualRowNum, jobClient || "", jobName || "", {
        deferValueWrites: true,
      });
      const newRowNum = typeof childResult === "object" ? childResult.targetRowNum : childResult;
      if (childResult?.valueUpdates) deferredChildRowWrites = childResult.valueUpdates;
      actualRowNum = newRowNum;
      actualSlotNum = 1;
      if (!resolvedInvoiceJobRows.includes(newRowNum)) resolvedInvoiceJobRows.push(newRowNum);
    }

    let verifiedClient = jobClient || req.body.endClientName || String(liveGroup?.parentRow?.[0] || "").trim() || "";
    let verifiedJob = jobName || req.body.jobName || String(liveGroup?.parentRow?.[1] || "").trim() || "";
    let invoiceRefFound = false;

    const norm = (s) => String(s || "").trim().toLowerCase();

    if (!createNewRow && (jobClient || jobName)) {
      const targetClient = norm(jobClient);
      const targetJobName = norm(jobName);
      const currentVals = cachedAllRows?.[actualRowNum - 1] || [];
      const curClient = norm(currentVals[0]);
      const curJob = norm(currentVals[1]);
      if (currentVals[0]) verifiedClient = String(currentVals[0]).trim();
      if (currentVals[1]) verifiedJob = String(currentVals[1]).trim();

      if ((targetClient && curClient !== targetClient) || (targetJobName && curJob !== targetJobName)) {
        // First search within cachedAllRows window
        const matches = [];
        if (cachedAllRows) {
          for (let i = 1; i < cachedAllRows.length; i++) {
            const r = cachedAllRows[i];
            if (!r) continue;
            if (norm(r[0]) === targetClient && norm(r[1]) === targetJobName) {
              matches.push(i + 1);
            }
          }
        }
        if (matches.length === 0) {
          try {
            const searchResp = await sheets.spreadsheets.values.get({
              spreadsheetId: sheetIdClean,
              range: `${targetTab}!A1:B5000`,
              valueRenderOption: "UNFORMATTED_VALUE"
            });
            const searchRows = searchResp.data.values || [];
            for (let i = 1; i < searchRows.length; i++) {
              const r = searchRows[i] || [];
              if (norm(r[0]) === targetClient && norm(r[1]) === targetJobName) {
                matches.push(i + 1);
              }
            }
          } catch (checkErr) {
            console.warn(`Row verification check failed in update_invoice_slot on ${targetTab}:`, checkErr.message);
          }
        }
        if (matches.length > 0 && !matches.includes(actualRowNum)) {
          actualRowNum = matches[0];
          resolvedInvoiceJobRows = matches;
          resolvedParentRowNum = matches[0];
          console.log(`ℹ Reconciled update_invoice_slot row from ${rowNum} to ${actualRowNum} on ${targetTab} for job "${jobName}"`);
        }
      }
    }

    if (req.body.invoiceRef) {
      const cleanTargetRef = norm(req.body.invoiceRef);
      const checkRowForRef = (rowArr) => {
        if (!rowArr) return 0;
        if (norm(rowArr[42]) === cleanTargetRef) return 1;
        if (norm(rowArr[49]) === cleanTargetRef) return 2;
        if (norm(rowArr[56]) === cleanTargetRef) return 3;
        return 0;
      };

      // 1. Check actualRowNum in memory first
      const directSlot = checkRowForRef(cachedAllRows?.[actualRowNum - 1]);
      if (directSlot > 0) {
        actualSlotNum = directSlot;
        invoiceRefFound = true;
      } else if (cachedAllRows) {
        // 2. Check all other rows in the fetched window in memory
        for (let r = 0; r < cachedAllRows.length; r++) {
          const s = checkRowForRef(cachedAllRows[r]);
          if (s > 0) {
            actualRowNum = r + 1;
            actualSlotNum = s;
            invoiceRefFound = true;
            break;
          }
        }
      }

      // 3. Only if not found in local window, fall back to scanning AQ1:BE5000
      if (!invoiceRefFound) {
        try {
          const scanResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `${targetTab}!AQ1:BE5000`,
            valueRenderOption: "UNFORMATTED_VALUE"
          });
          const allScanRows = scanResp.data.values || [];
          for (let r = 0; r < allScanRows.length; r++) {
            const rowArr = allScanRows[r] || [];
            const r1 = norm(rowArr[0]);
            const r2 = norm(rowArr[7]);
            const r3 = norm(rowArr[14]);
            if (r1 === cleanTargetRef) { actualRowNum = r + 1; actualSlotNum = 1; invoiceRefFound = true; break; }
            if (r2 === cleanTargetRef) { actualRowNum = r + 1; actualSlotNum = 2; invoiceRefFound = true; break; }
            if (r3 === cleanTargetRef) { actualRowNum = r + 1; actualSlotNum = 3; invoiceRefFound = true; break; }
          }
          if (invoiceRefFound && !resolvedInvoiceJobRows.includes(actualRowNum)) {
            resolvedInvoiceJobRows = [actualRowNum];
            cachedAllRows = null;
          }
        } catch (scanErr) {
          console.warn("Invoice slot ref verification check skipped:", scanErr.message);
        }
      }

      // If deleteSlot is true and the invoiceRef was not found anywhere, do not write to arbitrary row
      if (deleteSlot && !invoiceRefFound) {
        console.log(`ℹ Invoice "${req.body.invoiceRef}" is no longer on ${targetTab}; already deleted.`);
        return res.status(200).json({
          success: true,
          alreadyDeleted: true,
          message: "Invoice reference was not found on the Confirmed tab. It appears to have already been removed."
        });
      }
    }

    if (!deleteSlot && !createNewRow && invoice && !invoiceRefFound) {
      try {
        const liveResolved = await resolveLiveInvoiceSlot_(
          sheets,
          sheetIdClean,
          targetTab,
          resolvedInvoiceJobRows,
          actualRowNum,
          actualSlotNum,
          invoice,
          {
            preferRequestedIfValid: !req.body.fromTriage,
            cachedAllRows,
            jobClient: jobClient || req.body.endClientName || "",
            jobName: jobName || ""
          }
        );
        if (liveResolved?.rowNum && liveResolved?.slotNum) {
          actualRowNum = liveResolved.rowNum;
          actualSlotNum = liveResolved.slotNum;
          if (Array.isArray(liveResolved.allRowNums) && liveResolved.allRowNums.length > 0) {
            resolvedInvoiceJobRows = liveResolved.allRowNums;
          }
          if (liveResolved.parentRowNum) {
            resolvedParentRowNum = liveResolved.parentRowNum;
          }
        }
      } catch (liveErr) {
        console.warn("Live invoice slot verification skipped:", liveErr.message);
      }
    }

    const slotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    }[actualSlotNum];
    if (!slotCols) return res.status(400).json({ success: false, error: "Invalid slotNum" });

    const isInvPlaceholder = !deleteSlot && invoice && (
      isPlaceholderInvoice(invoice.invoiceNo, invoice.status) ||
      !String(invoice.invoiceNo || "").trim()
    );
    const sanitizedInvStatus = (!deleteSlot && invoice)
      ? (isInvPlaceholder || String(invoice.status || "").trim().toLowerCase() === "placeholder"
        ? ""
        : (invoice.status ? canonicalizeInvoiceStatus(invoice.status) : ""))
      : "";

    const formattedSentDate = (!deleteSlot && invoice?.sentDate)
      ? (toSheetDateFormat(invoice.sentDate) || invoice.sentDate)
      : "";

    const values = deleteSlot
      ? ["", "", "", "", ""]
      : [
        invoice.amount || 0,
        sanitizeFormulaInput(invoice.invoiceNo || ""),
        formattedSentDate,
        invoice.daysToPay || 30,
        sanitizeFormulaInput(sanitizedInvStatus),
      ];

    // Update cachedAllRows in-place so adjustJobInvoicePlaceholders_ requires zero additional reads
    if (cachedAllRows) {
      const baseCol = actualSlotNum === 1 ? 41 : actualSlotNum === 2 ? 48 : 55;
      if (!cachedAllRows[actualRowNum - 1]) cachedAllRows[actualRowNum - 1] = [];
      for (let k = 0; k < 5; k++) {
        cachedAllRows[actualRowNum - 1][baseCol + k] = values[k];
      }
    }

    const allWriteData = [
      ...deferredChildRowWrites,
      {
        range: `${targetTab}!${slotCols.a}${actualRowNum}:${slotCols.st}${actualRowNum}`,
        values: [values],
      },
    ];

    // Update revenue if requested
    let effectiveRevenue = undefined;
    if (req.body.updateJobRevenue && req.body.newJobRevenue !== undefined) {
      effectiveRevenue = parseFloat(req.body.newJobRevenue) || 0;
      const revTargetRow = resolvedParentRowNum || actualRowNum;
      allWriteData.push({
        range: `${targetTab}!AG${revTargetRow}`,
        values: [[effectiveRevenue]],
      });
      if (cachedAllRows?.[revTargetRow - 1]) {
        cachedAllRows[revTargetRow - 1][32] = effectiveRevenue;
      }
    }

    // Compute placeholder adjustments BEFORE flushing allWriteData so all writes execute in a SINGLE batchUpdate!
    let placeholderAdjustment = null;
    try {
      placeholderAdjustment = await adjustJobInvoicePlaceholders_(
        sheets,
        sheetIdClean,
        targetTab,
        resolvedInvoiceJobRows,
        effectiveRevenue,
        masterSheetId,
        cachedAllRows,
        { preloadedTolerances, returnBatchDataOnly: true }
      );
      if (Array.isArray(placeholderAdjustment?.batchData) && placeholderAdjustment.batchData.length > 0) {
        allWriteData.push(...placeholderAdjustment.batchData);
      }
    } catch (pErr) {
      console.warn("handleUpdateInvoiceSlot placeholder adjustment failed (non-fatal):", pErr.message);
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: allWriteData,
      },
    });

    const bgTasks = (async () => {
      try {
        await invalidatePmaClientCache(sheetIdClean, masterSheetId, ["invoices", "jobs", "retainers", "cash"]);
      } catch (_) { }
      try {
        let tenantClient = req.body.clientName || "";
        if (!tenantClient) {
          tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
        }
        let endClient = req.body.endClientName || verifiedClient || "";
        let job = req.body.jobName || verifiedJob || "";
        const jobIdentifier = (endClient && job) ? `"${endClient} - ${job}"` : `"${job || endClient || `Row ${rowNum}`}"`;

        await logPmaActivity(sheets, {
          automationCommanderSheetId: req.body.automationCommanderSheetId,
          clientName: tenantClient,
          category: "INVOICES",
          action: deleteSlot ? "Invoice Slot Cleared" : "Invoice Slot Updated",
          summary: deleteSlot
            ? `Cleared invoice slot #${actualSlotNum} on ${targetTab} Row ${actualRowNum} for ${jobIdentifier}`
            : `Updated invoice slot #${actualSlotNum} on ${targetTab} Row ${actualRowNum} for ${jobIdentifier} (Inv #${invoice?.invoiceNo || ""}, £${invoice?.amount || 0})`,
          details: {
            slotNum: actualSlotNum,
            rowNum: actualRowNum,
            endClient,
            jobName: job,
            clientName: tenantClient,
            deleteSlot: !!deleteSlot,
            invoiceNumber: invoice?.invoiceNo,
            amount: invoice?.amount,
            status: invoice?.status
          }
        });
      } catch (e) {
        console.error("PMA log failed:", e);
      }
    })();
    try { waitUntil(bgTasks); } catch (_) { }

    return res.status(200).json({
      success: true,
      rowNum: actualRowNum,
      slotNum: actualSlotNum,
      placeholderAdjustment,
      updatedRevenue: req.body.updateJobRevenue ? effectiveRevenue : undefined
    });
  } catch (err) {
    console.error("❌ update_invoice_slot error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCreateJobFromInvoice(req, res, sheets) {
  const { clientSheetId, jobName, projectCode, revenue, directCosts, vatYesNo, projectType, startDate, endDate, invoice } = req.body;
  if (!clientSheetId || !invoice) return res.status(400).json({ success: false, error: "Missing clientSheetId or invoice" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const startRow = 2;

    // Scan Confirmed tab across full width A1:CR5000 to find the true next available row
    const isRetainerReq = String(projectType || "").trim().toLowerCase() === "retainer";
    let targetMasterId = (req.body.masterSheetId || invoice.masterSheetId)
      ? (extractSheetIdFromUrl(req.body.masterSheetId || invoice.masterSheetId) || req.body.masterSheetId || invoice.masterSheetId)
      : null;

    const [resp, metaResp, tols] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:BH5000",
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      ),
      isRetainerReq
        ? sheets.spreadsheets
          .get(
            {
              spreadsheetId: sheetIdClean,
              fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
            },
            { timeout: 8000, retry: false }
          )
          .catch(() => null)
        : Promise.resolve(null),
      (async () => {
        try {
          if (!targetMasterId && sheetIdClean) {
            targetMasterId = await resolveMasterSheetIdForClient_(sheets, sheetIdClean, req.body.clientName);
          }
          return await getToleranceValues(sheets, targetMasterId || sheetIdClean);
        } catch (e) {
          return null;
        }
      })(),
    ]);
    const allRows = resp.data.values || [];
    const confirmedSheetMeta = (metaResp?.data?.sheets || []).find(
      s => s.properties?.title === "Confirmed" || s.properties?.title === "ConfCalcs"
    ) || null;

    // Step 1: Find the last row with active job data
    let lastJobRow = startRow - 1;
    for (let i = startRow - 1; i < allRows.length; i++) {
      const row = allRows[i] || [];
      const hasA = row[0] !== undefined && String(row[0]).trim() !== "";
      const hasB = row[1] !== undefined && String(row[1]).trim() !== "";
      const hasRev = row[32] !== undefined && String(row[32]).trim() !== "";
      const hasDates = (row[37] !== undefined && String(row[37]).trim() !== "") || (row[38] !== undefined && String(row[38]).trim() !== "");

      let hasSlotData = false;
      for (let c = 41; c <= 60; c++) {
        if (row[c] !== undefined && String(row[c]).trim() !== "") { hasSlotData = true; break; }
      }
      if (!hasSlotData) {
        for (let c = 75; c <= 95; c++) {
          if (row[c] !== undefined && String(row[c]).trim() !== "") { hasSlotData = true; break; }
        }
      }

      if (hasA || hasB || hasRev || hasDates || hasSlotData) {
        lastJobRow = i + 1; // 1-indexed
      }
    }

    // Step 2: Find the FIRST blank row beneath all existing jobs
    let newRow = Math.max(startRow, lastJobRow + 1);
    for (let r = lastJobRow; r < allRows.length; r++) {
      const row = allRows[r] || [];
      const isBlank = [0, 1, 2, 3, 4, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42, 48, 55, 75, 82, 89].every(idx => {
        const v = row[idx];
        return v === undefined || v === null || String(v).trim() === "";
      });
      if (isBlank) {
        newRow = r + 1; // 1-indexed
        break;
      }
    }

    // Read client's default days to pay from DataChgAlert!B52 (Master Sheet)
    let clientDefaultDays = 30;
    const b52Val = parseInt(tols?.defaultDaysToPay, 10);
    if (!isNaN(b52Val) && b52Val >= 0 && b52Val <= 365) {
      clientDefaultDays = b52Val;
    }

    // Days to pay calculation and sanitisation:
    // MUST strictly be an integer number of days (defaulting to DataChgAlert!B52), NEVER a date string.
    let finalDaysToPay = clientDefaultDays;
    const explicitDays = req.body.daysToPay !== undefined ? req.body.daysToPay : invoice.daysToPay;

    const looksLikeDate = (val) => {
      if (!val) return false;
      const s = String(val).trim();
      return /^[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}/.test(s) || // ISO YYYY-MM-DD
        /^[0-9]{1,2}[-/][A-Za-z]{3}[-/][0-9]{2,4}/.test(s) || // 15-Oct-26
        /^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}/.test(s) || // 15/10/2026
        /[A-Za-z]{3,9}/.test(s); // contains month text
    };

    if (explicitDays !== undefined && explicitDays !== null && explicitDays !== "" && !looksLikeDate(explicitDays)) {
      const parsedDays = parseInt(String(explicitDays).replace(/[^\d-]/g, ""), 10);
      if (!isNaN(parsedDays) && parsedDays >= 0 && parsedDays <= 365) {
        finalDaysToPay = parsedDays;
      }
    } else if (invoice.sentDate && invoice.dueDate) {
      const sent = parseSheetDate(invoice.sentDate);
      const due = parseSheetDate(invoice.dueDate);
      if (sent && due) {
        const diff = Math.round((due.getTime() - sent.getTime()) / 86400000);
        if (!isNaN(diff)) {
          finalDaysToPay = diff > 0 ? diff : (invoice.status?.toLowerCase() === "paid" ? 0 : clientDefaultDays);
        }
      }
    }

    finalDaysToPay = typeof finalDaysToPay === "number" && !isNaN(finalDaysToPay) ? Math.min(365, Math.max(0, finalDaysToPay)) : clientDefaultDays;

    const formatSheetDate = (dStr) => toSheetDateFormat(dStr);
    const todayFormatted = formatSheetDate(new Date());
    const isRetainer = String(projectType || "").trim().toLowerCase() === "retainer";
    const resolvedRetainerEndDate = (endDate && !req.body.noEndDate && !isNoEndDateSentinel(endDate))
      ? formatSheetDate(endDate)
      : NO_END_DATE_SHEET_VALUE;

    const updateData = [
      { range: `Confirmed!A${newRow}`, values: [[sanitizeFormulaInput(invoice.client || "")]] },
      { range: `Confirmed!B${newRow}`, values: [[sanitizeFormulaInput(jobName || invoice.job || "")]] },
      { range: `Confirmed!C${newRow}`, values: [[sanitizeFormulaInput(projectCode || "")]] },
      { range: `Confirmed!D${newRow}`, values: [[todayFormatted]] },
      { range: `Confirmed!AG${newRow}`, values: [[parseFloat(revenue) || parseFloat(invoice.amount) || 0]] },
      { range: `Confirmed!AH${newRow}`, values: [[parseFloat(directCosts) || 0]] },
      { range: `Confirmed!AI${newRow}`, values: [[sanitizeFormulaInput(vatYesNo || (invoice.vatAmount > 0 ? "Yes" : "No"))]] },
      { range: `Confirmed!AJ${newRow}`, values: [[sanitizeFormulaInput(projectType || "Project")]] },
      { range: `Confirmed!AL${newRow}`, values: [[formatSheetDate(startDate || invoice.sentDate)]] },
      { range: `Confirmed!AM${newRow}`, values: [[isRetainer ? resolvedRetainerEndDate : formatSheetDate(endDate || invoice.dueDate)]] },
    ];

    let retainerPlan = null;
    if (isRetainer) {
      retainerPlan = buildRetainerChildRowsWritePlan({
        parentRowNum: newRow,
        client: invoice.client || "",
        jobName: jobName || invoice.job || "",
        monthlyRevenue: parseFloat(revenue) || parseFloat(invoice.amount) || 0,
        vat: vatYesNo || (invoice.vatAmount > 0 ? "Yes" : "No"),
        startDate: formatSheetDate(startDate || invoice.sentDate),
        endDate: resolvedRetainerEndDate,
        b51TargetDay: tols?.retainerInvoiceDay || 28,
        defaultDaysToPay: clientDefaultDays,
        initialInvoices: [
          {
            amount: parseFloat(invoice.amount) || 0,
            ref: invoice.invoiceNo || "",
            sentDate: formatSheetDate(invoice.sentDate),
            daysToPay: finalDaysToPay,
            status: canonicalizeInvoiceStatus(invoice.status) || "Sent",
          },
        ],
        confirmedTabTitle: "Confirmed",
      });
      if (retainerPlan.writeData.length > 0) {
        updateData.push(...retainerPlan.writeData);
      }
    } else {
      updateData.push(
        { range: `Confirmed!AP${newRow}`, values: [[parseFloat(invoice.amount) || 0]] },
        { range: `Confirmed!AQ${newRow}`, values: [[sanitizeFormulaInput(invoice.invoiceNo || "")]] },
        { range: `Confirmed!AR${newRow}`, values: [[formatSheetDate(invoice.sentDate)]] },
        { range: `Confirmed!AS${newRow}`, values: [[finalDaysToPay]] },
        { range: `Confirmed!AT${newRow}`, values: [[sanitizeFormulaInput(canonicalizeInvoiceStatus(invoice.status) || "Sent")]] },
      );
    }

    // Group FIRST while sheet is idle (<1s), then write cell values SECOND so grouping never waits behind formula recalculation
    if (retainerPlan?.rowsToCreate > 0) {
      await groupAndCollapseRetainerChildRows_(
        sheets,
        sheetIdClean,
        retainerPlan.startWriteRow,
        retainerPlan.endWriteRow,
        confirmedSheetMeta
      );
    }
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updateData,
        },
      })
    );

    const endClient = invoice?.client || "";
    const createdJob = jobName || invoice?.job || "Job";
    const jobIdentifier = endClient ? `"${endClient} - ${createdJob}"` : `"${createdJob}"`;

    const logPromise = (async () => {
      let tenantClient = req.body.clientName || "";
      if (!tenantClient) {
        tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
      }
      await Promise.all([
        resolveAssignedAlertsInMemoryAndCache(sheets, {
          acSheetId: req.body.automationCommanderSheetId,
          clientName: tenantClient,
          invoiceNos: [invoice?.invoiceNo].filter(Boolean),
          sessionId: req.body.sessionId || null,
        }),
        logPmaActivity(sheets, {
          automationCommanderSheetId: req.body.automationCommanderSheetId,
          clientName: tenantClient,
          category: "INVOICES",
          action: "Job Created from Invoice",
          summary: `Created new job ${jobIdentifier} from invoice #${invoice?.invoiceNo} (£${invoice?.amount || 0}) (Row ${newRow})`,
          details: {
            jobName: createdJob,
            endClient,
            clientName: tenantClient,
            invoiceNumber: invoice?.invoiceNo,
            amount: invoice?.amount,
            projectCode,
            revenue,
            row: newRow
          }
        })
      ]);
    })().catch(e => console.error("PMA log failed:", e));
    if (typeof waitUntil === "function") {
      try { waitUntil(logPromise); } catch (_) { }
    }

    memoryCache.del(`deleted_job_rows:${sheetIdClean}:confirmed`);
    invalidatePmaClientCache(sheetIdClean, targetMasterId, ["jobs", "invoices", "retainers", "cash"]).catch(() => { });

    return res.status(200).json({ success: true, newRowNum: newRow, backgroundProvisioning: isRetainer });
  } catch (err) {
    console.error("❌ create_job_from_invoice error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleAddNewJob(req, res, sheets) {
  const { clientSheetId, tabName, jobData } = req.body;
  if (!clientSheetId || !jobData || !jobData.jobName) {
    return res.status(400).json({ success: false, error: "Missing clientSheetId or required job data" });
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const targetTab = (jobData.status || tabName || "Confirmed") === "Pipeline" ? "Pipeline" : "Confirmed";
    const startRow = 2;

    const isConfirmedRetainer =
      targetTab === "Confirmed" &&
      String(jobData.projectRetainer || "").trim().toLowerCase() === "retainer";

    let targetMasterId = (jobData.masterSheetId || req.body.masterSheetId)
      ? (extractSheetIdFromUrl(jobData.masterSheetId || req.body.masterSheetId) || jobData.masterSheetId || req.body.masterSheetId)
      : null;

    const [resp, metaResp, tols] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!A1:CR5000`,
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      ),
      isConfirmedRetainer
        ? sheets.spreadsheets
          .get(
            {
              spreadsheetId: sheetIdClean,
              fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
            },
            { timeout: 8000, retry: false }
          )
          .catch(() => null)
        : Promise.resolve(null),
      (async () => {
        try {
          if (!targetMasterId && sheetIdClean) {
            targetMasterId = await resolveMasterSheetIdForClient_(sheets, sheetIdClean, req.body.clientName || jobData.client);
          }
          return await getToleranceValues(sheets, targetMasterId || sheetIdClean);
        } catch (e) {
          return null;
        }
      })(),
    ]);
    const allRows = resp.data.values || [];
    const confirmedSheetMeta = (metaResp?.data?.sheets || []).find(
      s => s.properties?.title === targetTab || s.properties?.title === "Confirmed"
    ) || null;

    // Step 1: Find the last row with active job data
    let lastJobRow = startRow - 1;
    for (let i = startRow - 1; i < allRows.length; i++) {
      const row = allRows[i] || [];
      const hasA = row[0] !== undefined && String(row[0]).trim() !== "";
      const hasB = row[1] !== undefined && String(row[1]).trim() !== "";
      const hasRev = row[32] !== undefined && String(row[32]).trim() !== "";
      const hasDates = (row[37] !== undefined && String(row[37]).trim() !== "") || (row[38] !== undefined && String(row[38]).trim() !== "");

      let hasSlotData = false;
      for (let c = 41; c <= 60; c++) {
        if (row[c] !== undefined && String(row[c]).trim() !== "") { hasSlotData = true; break; }
      }
      if (!hasSlotData) {
        for (let c = 75; c <= 95; c++) {
          if (row[c] !== undefined && String(row[c]).trim() !== "") { hasSlotData = true; break; }
        }
      }

      if (hasA || hasB || hasRev || hasDates || hasSlotData) {
        lastJobRow = i + 1; // 1-indexed
      }
    }

    // Step 2: Find the FIRST blank row beneath all existing jobs
    let targetRow = Math.max(startRow, lastJobRow + 1);
    for (let r = lastJobRow; r < allRows.length; r++) {
      const row = allRows[r] || [];
      const isBlank = [0, 1, 2, 3, 4, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42, 48, 55, 75, 82, 89].every(idx => {
        const v = row[idx];
        return v === undefined || v === null || String(v).trim() === "";
      });
      if (isBlank) {
        targetRow = r + 1; // 1-indexed
        break;
      }
    }

    const formatSheetDate = (dStr) => toSheetDateFormat(dStr);
    const isRetainerJob = String(jobData.projectRetainer || "").trim().toLowerCase() === "retainer";
    const resolvedEndDate = isRetainerJob
      ? ((jobData.endDate && !jobData.noEndDate && !isNoEndDateSentinel(jobData.endDate)) ? formatSheetDate(jobData.endDate) : NO_END_DATE_SHEET_VALUE)
      : (isNoEndDateSentinel(jobData.endDate) ? NO_END_DATE_SHEET_VALUE : formatSheetDate(jobData.endDate));

    const updateData = [
      { range: `${targetTab}!A${targetRow}`, values: [[sanitizeFormulaInput(jobData.client || "")]] },
      { range: `${targetTab}!B${targetRow}`, values: [[sanitizeFormulaInput(jobData.jobName || "")]] },
      { range: `${targetTab}!C${targetRow}`, values: [[sanitizeFormulaInput(jobData.projectCode || "")]] },
      { range: `${targetTab}!D${targetRow}`, values: [[formatSheetDate(jobData.dateConfirmed || jobData.dateAdded || new Date())]] },
      { range: `${targetTab}!E${targetRow}`, values: [[sanitizeFormulaInput(jobData.leadSource || "")]] },
      { range: `${targetTab}!AG${targetRow}`, values: [[parseFloat(jobData.revenue) || 0]] },
      { range: `${targetTab}!AH${targetRow}`, values: [[parseFloat(jobData.directCosts) || 0]] },
      { range: `${targetTab}!AI${targetRow}`, values: [[sanitizeFormulaInput(jobData.vat || "Yes")]] },
      { range: `${targetTab}!AJ${targetRow}`, values: [[sanitizeFormulaInput(jobData.projectRetainer || "Project")]] },
      { range: `${targetTab}!AK${targetRow}`, values: [[sanitizeFormulaInput(jobData.productLine || "")]] },
      { range: `${targetTab}!AL${targetRow}`, values: [[formatSheetDate(jobData.startDate)]] },
      { range: `${targetTab}!AM${targetRow}`, values: [[resolvedEndDate]] },
    ];

    if (jobData.unevenSplit || jobData.splitStr) {
      const splitVal = sanitizeFormulaInput(jobData.unevenSplit || jobData.splitStr || "");
      if (splitVal) {
        updateData.push({ range: `${targetTab}!AE${targetRow}`, values: [[splitVal]] });
      }
    }

    if (targetTab === "Pipeline" && jobData.likelihood !== undefined && jobData.likelihood !== null && jobData.likelihood !== "") {
      let lNum = parseFloat(jobData.likelihood);
      if (!isNaN(lNum)) {
        if (lNum > 1) lNum = lNum / 100;
        updateData.push({ range: `${targetTab}!AN${targetRow}`, values: [[lNum]] });
      }
    }

    // Read client's default days to pay from DataChgAlert!B52 (Master Sheet)
    let clientDefaultDays = 30;
    const b52Val = parseInt(tols?.defaultDaysToPay, 10);
    if (!isNaN(b52Val) && b52Val >= 0 && b52Val <= 365) {
      clientDefaultDays = b52Val;
    }

    // Invoice Slots (up to 3) - skipped on parent row for Confirmed Retainers (handled on child rows in background)
    const invoiceSlotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    };
    let writtenInvoicesCount = 0;
    if (!isConfirmedRetainer && jobData.invoices && Array.isArray(jobData.invoices)) {
      for (const inv of jobData.invoices) {
        const sCols = invoiceSlotCols[inv.slotNum || 1];
        if (!sCols) continue;
        const amt = parseFloat(inv.amount) || 0;
        const ref = sanitizeFormulaInput(inv.invoiceNo || "");
        const sent = formatSheetDate(inv.sentDate);
        let days = clientDefaultDays;
        if (inv.daysToPay !== undefined && inv.daysToPay !== null && inv.daysToPay !== "") {
          const sDays = String(inv.daysToPay).trim();
          if (!/^[0-9]{4}[-/]/.test(sDays) && !/[A-Za-z]{3}/.test(sDays)) {
            const p = parseInt(sDays.replace(/[^\d-]/g, ""), 10);
            if (!isNaN(p) && p >= 0 && p <= 365) days = p;
          }
        }
        const st = sanitizeFormulaInput(canonicalizeInvoiceStatus(inv.status) || "");
        if (amt > 0 || ref || sent || st) {
          writtenInvoicesCount++;
          updateData.push(
            { range: `${targetTab}!${sCols.a}${targetRow}`, values: [[amt]] },
            { range: `${targetTab}!${sCols.ref}${targetRow}`, values: [[ref]] },
            { range: `${targetTab}!${sCols.sent}${targetRow}`, values: [[sent]] },
            { range: `${targetTab}!${sCols.days}${targetRow}`, values: [[days]] },
            { range: `${targetTab}!${sCols.st}${targetRow}`, values: [[st]] }
          );
        }
      }
    }

    if (!isConfirmedRetainer && writtenInvoicesCount === 0 && (parseFloat(jobData.revenue) || 0) > 0) {
      const rev = parseFloat(jobData.revenue) || 0;
      const startDate = jobData.startDate ? parseSheetDate(jobData.startDate) : new Date();
      const endDate = jobData.endDate ? parseSheetDate(jobData.endDate) : startDate;
      const allocations = calculateRevenueSplit(rev, tols?.invoiceLogicMode || "50-50", startDate, endDate, tols?.retainerInvoiceDay || 28, 0);

      allocations.forEach((alloc, idx) => {
        const sNum = idx + 1;
        const sCols = invoiceSlotCols[sNum];
        if (!sCols) return;
        writtenInvoicesCount++;
        const autoRef = generateAutoPlaceholderRef_("PLACE-INV");
        const sent = toSheetDateFormat(alloc.date);
        updateData.push(
          { range: `${targetTab}!${sCols.a}${targetRow}`, values: [[alloc.amt]] },
          { range: `${targetTab}!${sCols.ref}${targetRow}`, values: [[autoRef]] },
          { range: `${targetTab}!${sCols.sent}${targetRow}`, values: [[sent]] },
          { range: `${targetTab}!${sCols.days}${targetRow}`, values: [[clientDefaultDays]] },
          { range: `${targetTab}!${sCols.st}${targetRow}`, values: [[""]] }
        );
      });
    }

    // Expense / Direct Cost Slots (up to 3)
    const expenseSlotCols = {
      1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
      2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
      3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
    };
    let writtenExpensesCount = 0;
    if (jobData.expenses && Array.isArray(jobData.expenses)) {
      for (const exp of jobData.expenses) {
        const eCols = expenseSlotCols[exp.slotNum || 1];
        if (!eCols) continue;
        const desc = sanitizeFormulaInput(exp.description || "");
        const amt = parseFloat(exp.amount) || 0;
        const vatVal = sanitizeFormulaInput(exp.vat || "No");
        const dt = formatSheetDate(exp.date);
        let dp = clientDefaultDays;
        if (exp.daysToPay !== undefined && exp.daysToPay !== null && exp.daysToPay !== "") {
          const sDp = String(exp.daysToPay).trim();
          if (!/^[0-9]{4}[-/]/.test(sDp) && !/[A-Za-z]{3}/.test(sDp)) {
            const p = parseInt(sDp.replace(/[^\d-]/g, ""), 10);
            if (!isNaN(p) && p >= 0 && p <= 365) dp = p;
          }
        }
        const st = sanitizeFormulaInput(canonicalizeExpenseStatus(exp.status) || "");
        const txId = sanitizeFormulaInput(exp.transactionId || "");
        if (amt > 0 || desc || dt || txId) {
          writtenExpensesCount++;
          updateData.push(
            { range: `${targetTab}!${eCols.d}${targetRow}`, values: [[desc]] },
            { range: `${targetTab}!${eCols.a}${targetRow}`, values: [[amt]] },
            { range: `${targetTab}!${eCols.v}${targetRow}`, values: [[vatVal]] },
            { range: `${targetTab}!${eCols.dt}${targetRow}`, values: [[dt]] },
            { range: `${targetTab}!${eCols.dp}${targetRow}`, values: [[dp]] },
            { range: `${targetTab}!${eCols.st}${targetRow}`, values: [[st]] },
            { range: `${targetTab}!${eCols.id}${targetRow}`, values: [[txId]] }
          );
        }
      }
    }

    if (!isConfirmedRetainer && writtenExpensesCount === 0 && (parseFloat(jobData.directCosts) || 0) > 0) {
      const dc = parseFloat(jobData.directCosts) || 0;
      const startDate = jobData.startDate ? parseSheetDate(jobData.startDate) : new Date();
      const endDate = jobData.endDate ? parseSheetDate(jobData.endDate) : startDate;
      const allocations = calculateRevenueSplit(dc, tols?.expenseLogicMode || "100 at start", startDate, endDate, tols?.retainerExpenseDay || 28, 0);

      allocations.forEach((alloc, idx) => {
        const sNum = idx + 1;
        const eCols = expenseSlotCols[sNum];
        if (!eCols) return;
        writtenExpensesCount++;
        const autoId = generateAutoPlaceholderRef_("PLACE-EXP");
        const dt = toSheetDateFormat(alloc.date);
        updateData.push(
          { range: `${targetTab}!${eCols.d}${targetRow}`, values: [["Placeholder - Direct cost"]] },
          { range: `${targetTab}!${eCols.a}${targetRow}`, values: [[alloc.amt]] },
          { range: `${targetTab}!${eCols.v}${targetRow}`, values: [[sanitizeFormulaInput(jobData.vat || "Yes")]] },
          { range: `${targetTab}!${eCols.dt}${targetRow}`, values: [[dt]] },
          { range: `${targetTab}!${eCols.dp}${targetRow}`, values: [[clientDefaultDays]] },
          { range: `${targetTab}!${eCols.st}${targetRow}`, values: [[""]] },
          { range: `${targetTab}!${eCols.id}${targetRow}`, values: [[autoId]] }
        );
      });
    }

    let retainerPlan = null;
    if (isConfirmedRetainer) {
      retainerPlan = buildRetainerChildRowsWritePlan({
        parentRowNum: targetRow,
        client: jobData.client || "",
        jobName: jobData.jobName || "",
        monthlyRevenue: parseFloat(jobData.revenue) || 0,
        vat: jobData.vat || "Yes",
        startDate: formatSheetDate(jobData.startDate),
        endDate: resolvedEndDate,
        b51TargetDay: tols?.retainerInvoiceDay || 28,
        defaultDaysToPay: clientDefaultDays,
        initialInvoices: Array.isArray(jobData.invoices) ? jobData.invoices : [],
        confirmedTabTitle: targetTab,
      });
      if (retainerPlan.writeData.length > 0) {
        updateData.push(...retainerPlan.writeData);
      }
    }

    // Group FIRST while sheet is idle (<1s), then write cell values SECOND so grouping never waits behind formula recalculation
    if (retainerPlan?.rowsToCreate > 0) {
      await groupAndCollapseRetainerChildRows_(
        sheets,
        sheetIdClean,
        retainerPlan.startWriteRow,
        retainerPlan.endWriteRow,
        confirmedSheetMeta
      );
    }
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updateData,
        },
      })
    );

    const endClient = jobData.client || "";
    const createdJob = jobData.jobName || "Job";
    const jobIdentifier = endClient ? `"${endClient} - ${createdJob}"` : `"${createdJob}"`;

    const summaryAdditions = [];
    if (jobData.unevenSplit || jobData.splitStr) summaryAdditions.push("custom revenue split");
    if (writtenInvoicesCount > 0) summaryAdditions.push(`${writtenInvoicesCount} invoice(s)`);
    if (writtenExpensesCount > 0) summaryAdditions.push(`${writtenExpensesCount} expense(s)`);
    const detailsExtra = summaryAdditions.length > 0 ? ` with ${summaryAdditions.join(" and ")}` : "";

    const logPromise = (async () => {
      let tenantClient = req.body.clientName || "";
      if (!tenantClient) {
        tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
      }
      await logPmaActivity(sheets, {
        automationCommanderSheetId: req.body.automationCommanderSheetId,
        clientName: tenantClient,
        category: "JOB",
        action: "Job Created",
        summary: `Created new ${targetTab} job ${jobIdentifier} (£${parseFloat(jobData.revenue) || 0})${detailsExtra} (Row ${targetRow})`,
        details: {
          tabName: targetTab,
          row: targetRow,
          client: endClient,
          jobName: createdJob,
          projectCode: jobData.projectCode,
          revenue: jobData.revenue,
          directCosts: jobData.directCosts,
          vat: jobData.vat,
          projectRetainer: jobData.projectRetainer,
          productLine: jobData.productLine,
          leadSource: jobData.leadSource,
          startDate: jobData.startDate,
          endDate: jobData.endDate,
          likelihood: jobData.likelihood,
          invoicesCount: writtenInvoicesCount,
          expensesCount: writtenExpensesCount,
          clientName: tenantClient
        }
      });
    })().catch(e => console.error("PMA log failed:", e));
    if (typeof waitUntil === "function") {
      try { waitUntil(logPromise); } catch (_) { }
    }

    // Clear any deleted_job_rows tombstones and invalidate PMA job caches immediately so the new job is visible right away
    memoryCache.del(`deleted_job_rows:${sheetIdClean}:${targetTab.toLowerCase()}`);
    invalidatePmaClientCache(sheetIdClean, targetMasterId, ["jobs", "invoices", "retainers", "cash"]).catch(() => { });

    const formattedDateConf = formatSheetDate(jobData.dateConfirmed || jobData.dateAdded || new Date());
    const formattedStartDate = formatSheetDate(jobData.startDate);
    const formattedRev = parseFloat(jobData.revenue) || 0;
    const formattedDc = parseFloat(jobData.directCosts) || 0;
    const formattedVat = sanitizeFormulaInput(jobData.vat || "Yes");
    const formattedType = sanitizeFormulaInput(jobData.projectRetainer || "Project");
    const formattedProdLine = sanitizeFormulaInput(jobData.productLine || "");
    const formattedLeadSrc = sanitizeFormulaInput(jobData.leadSource || "");
    const formattedCode = sanitizeFormulaInput(jobData.projectCode || "");
    const formattedClient = sanitizeFormulaInput(jobData.client || "");
    const formattedJobName = sanitizeFormulaInput(jobData.jobName || "");
    const formattedLikelihood = targetTab === "Pipeline"
      ? `${Math.round((parseFloat(jobData.likelihood) > 1 ? parseFloat(jobData.likelihood) : (parseFloat(jobData.likelihood) || 0.5) * 100))}%`
      : "100%";

    const newJob = {
      id: `${targetTab.toLowerCase()}_${targetRow}`,
      tabName: targetTab,
      status: targetTab,
      client: formattedClient,
      jobName: formattedJobName,
      projectCode: formattedCode,
      copiedToConf: targetTab === "Pipeline" ? "" : null,
      note: "",
      rows: [
        {
          rowNum: targetRow,
          isParent: true,
          tabName: targetTab,
          note: "",
          client: formattedClient,
          jobName: formattedJobName,
          projectCode: formattedCode,
          dateConf: formattedDateConf,
          leadSrc: formattedLeadSrc,
          unevenSplit: sanitizeFormulaInput(jobData.unevenSplit || jobData.splitStr || ""),
          revenue: `£${formattedRev.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          directCosts: `£${formattedDc.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          vat: formattedVat,
          projectRetainer: formattedType,
          prodLine: formattedProdLine,
          startDate: formattedStartDate,
          endDate: resolvedEndDate,
          likelihood: formattedLikelihood,
          copiedToConf: targetTab === "Pipeline" ? "" : null,
          leftToInvoice: "",
          costsOutstanding: "",
          invoiceSlots: [1, 2, 3].map(n => ({
            slotNum: n,
            amount: "",
            ref: "",
            sentDate: "",
            daysToPay: "",
            status: "",
            highlighted: false,
            note: ""
          })),
          expenseSlots: [1, 2, 3].map(n => ({
            slotNum: n,
            description: "",
            amount: "",
            vat: "",
            date: "",
            daysToPay: "",
            status: "",
            transactionId: "",
            highlighted: false,
            note: ""
          })),
        },
        ...(retainerPlan?.childRowsForUi || []),
      ]
    };

    return res.status(200).json({
      success: true,
      targetRow,
      targetTab,
      childRowCount: retainerPlan?.rowsToCreate || 0,
      backgroundProvisioning: false,
      newJob,
    });
  } catch (err) {
    console.error("❌ add_new_job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateOutgoingNote(req, res, sheets) {
  const { clientSheetId, sheetRow, colLetter, blocks, topNote } = req.body;
  if (!clientSheetId || !sheetRow || !colLetter) return res.status(400).json({ success: false, error: "Missing required fields" });
  const parsedRow = parseInt(sheetRow, 10);
  const cleanColLetter = String(colLetter).trim().toUpperCase();
  if (isNaN(parsedRow) || parsedRow < 4 || parsedRow > 400 || !/^[E-Z]$|^A[A-Z]$/.test(cleanColLetter)) {
    return res.status(400).json({ success: false, error: "Invalid Outgoings row or column" });
  }
  const colIdx0 = colLetterToNum(cleanColLetter) - 1;
  const isMonthlyCol = (colIdx0 >= 6 && colIdx0 <= 17) || (colIdx0 >= 21 && colIdx0 <= 32) || (colIdx0 >= 36 && colIdx0 <= 47);
  if (!isMonthlyCol) {
    return res.status(400).json({ success: false, error: "Invalid Outgoings monthly column" });
  }
  const sessionUser = getSessionUser(req);
  if (sessionUser?.role === "Senior (Restricted)" && ((parsedRow >= 115 && parsedRow <= 123) || (parsedRow >= 230 && parsedRow <= 238))) {
    return res.status(403).json({ success: false, error: "Forbidden: Access to salary and dividend rows is restricted." });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

    let finalTopNote = typeof topNote === "string" ? topNote.trim() : "";
    if (topNote === undefined) {
      try {
        const existingNoteResp = await withRetry(() =>
          sheets.spreadsheets.get({
            spreadsheetId: sheetIdClean,
            ranges: [`Outgoings!${colLetter}${sheetRow}`],
            includeGridData: true,
            fields: "sheets.data.rowData.values.note",
          })
        );
        const curNote = existingNoteResp.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.note || "";
        const firstIdx = curNote.indexOf("{App ID:");
        if (firstIdx !== -1) {
          finalTopNote = curNote.substring(0, firstIdx).trim();
        } else if (!curNote.includes("{")) {
          finalTopNote = curNote.trim();
        }
      } catch (e) { }
    }

    const computeOutgoingsDefaultDates = (headerStr, recTimingStr, payTimingStr) => {
      const mNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const mMatch = String(headerStr || "").trim().match(/([A-Za-z]{3})[\s\-]*(\d{2,4})/);
      if (!mMatch) return { rec: "", pay: "", monthTag: "" };
      const mIdx = mNames.findIndex(m => m.toLowerCase() === mMatch[1].toLowerCase());
      let yr = parseInt(mMatch[2], 10);
      if (yr < 100) yr += 2000;
      if (mIdx === -1 || isNaN(yr)) return { rec: "", pay: "", monthTag: "" };
      const baseDate = new Date(yr, mIdx, 1);
      const today = new Date();
      const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);

      const recDate = new Date(yr, mIdx, 1);
      if (String(recTimingStr || "Curr").trim().toLowerCase().includes("next")) {
        recDate.setMonth(recDate.getMonth() + 1);
      }
      recDate.setDate(5);
      if (recDate < currentMonthStart) {
        recDate.setFullYear(today.getFullYear(), today.getMonth(), 5);
      }

      const payDate = new Date(yr, mIdx, 1);
      if (String(payTimingStr || "Curr").trim().toLowerCase().includes("next")) {
        payDate.setMonth(payDate.getMonth() + 1);
      }
      payDate.setDate(28);
      if (payDate < currentMonthStart) {
        const targetPayMonth = today.getDate() > 20 ? today.getMonth() + 1 : today.getMonth();
        payDate.setFullYear(today.getFullYear(), targetPayMonth, 28);
      }

      const fmt = (d) => `${d.getDate()}-${mNames[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
      return {
        rec: fmt(recDate),
        pay: fmt(payDate),
        monthTag: `${mNames[baseDate.getMonth()]}-${String(baseDate.getFullYear()).slice(-2)}`
      };
    };

    let resolvedBlocks = blocks || [];
    const hasBlankPlaceholderDates = resolvedBlocks.some(b => {
      const idUpper = String(b.appId || "").toUpperCase();
      const isPl = idUpper.includes("PLACE-EXP") || idUpper.includes("MANUAL-EXP") || idUpper.includes("MANUAL-ENTRY") || idUpper.includes("UNRECON-GAP");
      return isPl && (!b.recDate || !b.payDate);
    });
    if (hasBlankPlaceholderDates) {
      try {
        const metaResp = await withRetry(() =>
          sheets.spreadsheets.values.batchGet({
            spreadsheetId: sheetIdClean,
            ranges: [`Outgoings!${colLetter}1`, `Outgoings!C${sheetRow}:D${sheetRow}`],
            valueRenderOption: "FORMATTED_VALUE"
          })
        );
        const hStr = metaResp.data.valueRanges?.[0]?.values?.[0]?.[0] || "";
        const rowTimings = metaResp.data.valueRanges?.[1]?.values?.[0] || [];
        const est = computeOutgoingsDefaultDates(hStr, rowTimings[0] || "Curr", rowTimings[1] || "Curr");
        if (est.rec || est.pay) {
          resolvedBlocks = resolvedBlocks.map(b => {
            const idUpper = String(b.appId || "").toUpperCase();
            const isPl = idUpper.includes("PLACE-EXP") || idUpper.includes("MANUAL-EXP") || idUpper.includes("MANUAL-ENTRY") || idUpper.includes("UNRECON-GAP");
            if (!isPl) return b;
            return {
              ...b,
              recDate: b.recDate || est.rec,
              payDate: b.payDate || est.pay
            };
          });
        }
      } catch (e) { }
    }

    const blockStr = resolvedBlocks.map(b =>
      `{App ID: ${b.appId}}{Amt: ${b.amount}}{Status:${b.status ? " " + b.status : ""}}{Rec date:${b.recDate ? " " + b.recDate : ""}}{Pay date:${b.payDate ? " " + b.payDate : ""}}{Description:${b.description ? " " + b.description : ""}}`
    ).join("\n");

    const noteStr = finalTopNote
      ? (finalTopNote + (blockStr ? "\n" + blockStr : ""))
      : blockStr;

    const cellTotal = resolvedBlocks
      .filter(b => !b.appId.startsWith("UNRECON-GAP"))
      .reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);

    const cellRef = `Outgoings!${colLetter}${sheetRow}`;
    if (blocks !== undefined) {
      if (parsedRow === 111) {
        // Row 111 ("Making up CoS") is a formula row; Row 112 is the manual override row ("ZERO" clears Making up CoS)
        if (resolvedBlocks.length === 0) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetIdClean,
            range: `Outgoings!${colLetter}112`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [["ZERO"]] },
          });
        }
      } else {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: cellRef,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[cellTotal || ""]] },
        });
      }
    }

    const colIndex = colLetterToNum(colLetter) - 1;
    const rowIndex = sheetRow - 1;
    const outgoingsGid = await getSheetGid(sheets, sheetIdClean, "Outgoings");

    let newCosNote = null;
    if (sheetRow >= 12 && sheetRow <= 110) {
      try {
        const cosCellResp = await withRetry(() =>
          sheets.spreadsheets.get({
            spreadsheetId: sheetIdClean,
            ranges: [`Outgoings!${colLetter}1`, `Outgoings!C111:D111`, `Outgoings!${colLetter}111`],
            includeGridData: true,
            fields: "sheets.data.rowData.values(effectiveValue,formattedValue,note)",
          })
        );
        const gridArr = cosCellResp.data.sheets?.[0]?.data || [];
        const hCellStr = gridArr[0]?.rowData?.[0]?.values?.[0]?.formattedValue || "";
        const cosTimingsRow = gridArr[1]?.rowData?.[0]?.values || [];
        const cosInvTiming = cosTimingsRow[0]?.formattedValue || "Curr";
        const cosPayTiming = cosTimingsRow[1]?.formattedValue || "Curr";
        const cosCell = gridArr[2]?.rowData?.[0]?.values?.[0];
        if (cosCell) {
          const cosVal = typeof cosCell.effectiveValue?.numberValue === "number"
            ? cosCell.effectiveValue.numberValue
            : parseFloat(String(cosCell.formattedValue || "").replace(/[^0-9.-]/g, "")) || 0;
          const existingCosNote = cosCell.note || "";
          const cosEst = computeOutgoingsDefaultDates(hCellStr, cosInvTiming, cosPayTiming);
          if (Math.abs(cosVal) <= 0.001) {
            if (existingCosNote) {
              newCosNote = "";
            }
          } else if (existingCosNote.includes("{Amt:")) {
            newCosNote = existingCosNote.replace(/\{Amt:\s*[^}]*\}/, `{Amt: ${cosVal.toFixed(2)}}`);
            if (cosEst.rec) newCosNote = newCosNote.replace(/\{Rec date:\s*\}/g, `{Rec date: ${cosEst.rec}}`);
            if (cosEst.pay) newCosNote = newCosNote.replace(/\{Pay date:\s*\}/g, `{Pay date: ${cosEst.pay}}`);
          } else if (Math.abs(cosVal) > 0.001) {
            const cosPrefix = cosEst.monthTag ? `PLACE-EXP-${cosEst.monthTag}-Makin-` : `PLACE-EXP-${colLetter}-Makin-`;
            const rand = Math.floor(1000 + Math.random() * 9000);
            newCosNote = `{App ID: ${cosPrefix}${rand}}{Amt: ${cosVal.toFixed(2)}}{Status: }{Rec date: ${cosEst.rec}}{Pay date: ${cosEst.pay}}{Description: Placeholder Entry - Making up CoS}`;
          }
        }
      } catch (cosErr) {
        console.warn("Could not inspect Row 111 Making up CoS:", cosErr.message);
      }
    }

    const noteRequests = [{
      updateCells: {
        range: {
          sheetId: outgoingsGid,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: colIndex,
          endColumnIndex: colIndex + 1,
        },
        rows: [{ values: [{ note: noteStr }] }],
        fields: "note",
      },
    }];

    if (newCosNote !== null) {
      noteRequests.push({
        updateCells: {
          range: {
            sheetId: outgoingsGid,
            startRowIndex: 110,
            endRowIndex: 111,
            startColumnIndex: colIndex,
            endColumnIndex: colIndex + 1,
          },
          rows: [{ values: [{ note: newCosNote }] }],
          fields: "note",
        },
      });
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: { requests: noteRequests },
    });

    console.log(`  ✅ Outgoings note updated: ${cellRef}${newCosNote !== null ? " (and Row 111 Making up CoS)" : ""}`);

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }

    let targetMasterId = req.body.masterSheetId ? (extractSheetIdFromUrl(req.body.masterSheetId) || req.body.masterSheetId) : null;
    if (!targetMasterId) {
      try {
        const clients = await loadClientsFromCommander(sheets);
        const found = clients.find(c =>
          (tenantClient && c.clientName && c.clientName.toLowerCase() === tenantClient.toLowerCase()) ||
          extractSheetIdFromUrl(c.clientSheetId) === sheetIdClean ||
          extractSheetIdFromUrl(c.masterSheetId) === sheetIdClean
        );
        if (found?.masterSheetId) {
          targetMasterId = extractSheetIdFromUrl(found.masterSheetId) || found.masterSheetId;
        }
      } catch (lookupErr) {
        console.warn("Could not resolve masterSheetId in handleUpdateOutgoingNote:", lookupErr.message);
      }
    }

    if (targetMasterId) {
      const masterData = [
        { range: `OutgNotes!${colLetter}${sheetRow}`, values: [[noteStr]] }
      ];
      if (newCosNote !== null) {
        masterData.push({ range: `OutgNotes!${colLetter}111`, values: [[newCosNote]] });
      }
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: targetMasterId,
        requestBody: {
          valueInputOption: "RAW",
          data: masterData
        }
      }).catch(e => console.warn("Failed to write to Master OutgNotes:", e.message));

      // Trigger GAS refreshOutgoings asynchronously without blocking response
      const cronSecret = process.env.CRON_SECRET || process.env.AGENT_TRIGGER_SECRET || "";
      if (cronSecret) {
        fetch("https://script.google.com/macros/s/AKfycbzVvLSDtqWj3aHcn0UV9VPCybNm82sBNWynMo1-bMpvs3NzerPZXWkrpPJvVHaqDwwy/exec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "refreshOutgoings", clientSheetId: sheetIdClean, masterSheetId: targetMasterId, secret: cronSecret }),
        }).catch(e => console.warn("Background refreshOutgoings GAS call failed:", e.message));
      }
    }

    let contractor = req.body.contractorName || "";
    if (!contractor && sheetRow) {
      try {
        const vResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `Outgoings!A${sheetRow}`,
            valueRenderOption: "FORMATTED_VALUE"
          })
        );
        contractor = String(vResp.data.values?.[0]?.[0] || "").trim();
      } catch (e) { }
    }
    const contractorIdentifier = contractor ? `"${contractor}" (${cellRef})` : cellRef;

    const noteAssignedAppIds = (blocks || []).map(b => b?.appId || b?.transactionId).filter(Boolean);
    const bgNoteTasks = Promise.all([
      noteAssignedAppIds.length > 0
        ? resolveAssignedAlertsInMemoryAndCache(sheets, {
          acSheetId: req.body.automationCommanderSheetId,
          clientName: tenantClient,
          expenseIds: noteAssignedAppIds,
          sessionId: req.body.sessionId || null,
        })
        : Promise.resolve(),
      logPmaActivity(sheets, {
        automationCommanderSheetId: req.body.automationCommanderSheetId,
        clientName: tenantClient,
        category: "EXPENSES",
        action: "Outgoing Note Updated",
        summary: `Updated outgoings note for ${contractorIdentifier} (${(blocks || []).length} item${(blocks || []).length !== 1 ? "s" : ""}, Total: £${cellTotal.toFixed(2)})`,
        details: {
          vendor: contractor,
          cellRef,
          sheetRow,
          colLetter,
          itemCount: (blocks || []).length,
          total: cellTotal,
          clientName: tenantClient
        }
      })
    ]).catch(e => console.error("PMA log failed:", e));
    try { waitUntil(bgNoteTasks); } catch (_) { }

    await invalidatePmaClientCache(sheetIdClean, null, ["outgoings", "views"]).catch(() => { });

    return res.status(200).json({ success: true, cellRef, blockCount: (blocks || []).length, cellTotal });
  } catch (err) {
    console.error("❌ update_outgoing_note error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleSetMakingUpCosZero(req, res, sheets) {
  const { clientSheetId, colLetter, zero, clientName, automationCommanderSheetId } = req.body;
  if (!clientSheetId || !colLetter) {
    return res.status(400).json({ success: false, error: "Missing required fields: clientSheetId, colLetter" });
  }
  const cleanColLetter = String(colLetter).trim().toUpperCase();
  if (!/^[E-Z]$|^A[A-Z]$/.test(cleanColLetter)) {
    return res.status(400).json({ success: false, error: "Invalid Outgoings monthly column" });
  }

  const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const sessionUser = getSessionUser(req);
  if (sessionUser && !sessionUser.isAdmin) {
    const auth = await verifyUserAuthorizedForSheet(sessionUser, sheetIdClean, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
    }
  }

  try {
    const cellRange = `Outgoings!${cleanColLetter}112`;
    const writeValue = zero ? "Zero" : "";

    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: sheetIdClean,
        range: cellRange,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[writeValue]] },
      })
    );

    // Read back row 111 in that column to get recalculated value
    let recalculatedAmount = 0;
    let recalculatedFormatted = "£0";
    try {
      const readResp = await withRetry(() =>
        sheets.spreadsheets.get({
          spreadsheetId: sheetIdClean,
          ranges: [`Outgoings!${cleanColLetter}111`],
          includeGridData: true,
          fields: "sheets.data.rowData.values(effectiveValue,formattedValue)",
        })
      );
      const cell111 = readResp.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0];
      if (cell111) {
        recalculatedFormatted = cell111.formattedValue || "";
        recalculatedAmount = typeof cell111.effectiveValue?.numberValue === "number"
          ? cell111.effectiveValue.numberValue
          : parseFloat(String(cell111.formattedValue || "").replace(/[^0-9.-]/g, "")) || 0;
      }
    } catch (e) {
      console.warn("Could not read back recalculated row 111:", e.message);
    }

    // Invalidate caches
    await invalidatePmaClientCache(sheetIdClean, null, ["outgoings", "views", "cash"]).catch(() => { });

    const bgLog = logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: clientName || "",
      category: "EXPENSES",
      action: zero ? "Making up CoS zeroed" : "Making up CoS restored",
      summary: zero
        ? `Zeroed Making up CoS for ${cleanColLetter} (row 112)`
        : `Restored Making up CoS for ${cleanColLetter} (cleared row 112)`,
      details: {
        cellRef: cellRange,
        colLetter: cleanColLetter,
        zero: !!zero,
        amount: recalculatedAmount,
      },
      user: sessionUser?.email || "Unknown user",
    }).catch(e => console.error("PMA log failed:", e));
    try { waitUntil(bgLog); } catch (_) { }

    return res.status(200).json({
      success: true,
      colLetter: cleanColLetter,
      isZero: !!zero,
      overrideValue: writeValue,
      amount: recalculatedAmount,
      formatted: recalculatedFormatted || (recalculatedAmount ? `£${recalculatedAmount.toLocaleString("en-GB")}` : "£0"),
    });
  } catch (err) {
    console.error("❌ set_making_up_cos_zero error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleSetMakingUpCosTarget(req, res, sheets) {
  const { clientSheetId, targetPct, clientName, automationCommanderSheetId } = req.body;
  if (!clientSheetId) {
    return res.status(400).json({ success: false, error: "Missing required field: clientSheetId" });
  }

  const cleanNum = Math.min(100, Math.max(0, parseInt(String(targetPct).replace(/[^0-9]/g, ""), 10) || 0));
  const formattedPct = `${cleanNum}%`;

  const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const sessionUser = getSessionUser(req);
  if (sessionUser && !sessionUser.isAdmin) {
    const auth = await verifyUserAuthorizedForSheet(sessionUser, sheetIdClean, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
    }
  }

  try {
    // 1. Update Outgoings!A112 in Client Sheet
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: sheetIdClean,
        range: "Outgoings!A112",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[formattedPct]] },
      })
    );

    // 2. Invalidate Client Settings cache in Redis so Client Settings immediately reflects the change
    if (redisClient?.isOpen) {
      try {
        if (clientName) {
          const settingsKey = getSettingsRedisKey(clientName);
          await redisClient.del(settingsKey);
        }
        await redisClient.del(`pulse:client_settings:${sheetIdClean}`);
      } catch (e) {
        console.warn("Could not invalidate client settings cache:", e.message);
      }
    }

    // 3. Read back header (months) and row 111 & 112 to get freshly recalculated figures across all months
    const gridResp = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        ranges: ["Outgoings!A1:BG1", "Outgoings!A111:BG112"],
        includeGridData: true,
        fields: "sheets.data.rowData.values(formattedValue,effectiveValue,note)",
      })
    );

    const sheetGrids = gridResp.data.sheets?.[0]?.data || [];
    const headerCells = sheetGrids[0]?.rowData?.[0]?.values || [];
    const row111Values = sheetGrids[1]?.rowData?.[0]?.values || [];
    const row112Values = sheetGrids[1]?.rowData?.[1]?.values || [];

    const SHEET_EPOCH = new Date(1899, 11, 30);
    const months = [];
    for (let i = 6; i < headerCells.length; i++) {
      const cell = headerCells[i];
      if (!cell) continue;
      const fv = cell.formattedValue || "";
      const ev = cell.effectiveValue;

      if (fv.toLowerCase().includes("total") || fv.toLowerCase().includes("fy")) continue;

      let dateObj = null;
      if (ev?.numberValue) {
        const d = new Date(SHEET_EPOCH.getTime() + ev.numberValue * 86400000);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2020) dateObj = d;
      }
      if (!dateObj && fv) {
        const d = new Date(fv);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2020) dateObj = d;
      }

      if (dateObj) {
        const label = dateObj.toLocaleString("en-GB", { month: "short", year: "2-digit" });
        const isoMonth = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}`;
        months.push({ colIndex: i, colLetter: colIndexToLetter(i + 1), label, isoMonth });
      }
    }

    const cosRawName = String(row111Values[0]?.formattedValue || "").trim();
    const cosPct = String(row112Values[0]?.formattedValue || formattedPct).trim();

    const makingUpCosCells = {};
    for (const month of months) {
      const cell111 = row111Values[month.colIndex];
      const cell112 = row112Values[month.colIndex];

      const val111Str = cell111?.formattedValue || "";
      const val111Num = typeof cell111?.effectiveValue?.numberValue === "number"
        ? cell111.effectiveValue.numberValue
        : parseFloat(String(val111Str).replace(/[^0-9.-]/g, "")) || 0;

      const raw112 = String(cell112?.formattedValue || cell112?.effectiveValue?.stringValue || "").trim();
      const isZero = raw112.toUpperCase() === "ZERO";

      makingUpCosCells[month.colLetter] = {
        amount: val111Num,
        formatted: val111Str || (val111Num ? `£${val111Num.toLocaleString("en-GB")}` : "£0"),
        isZero,
        overrideValue: raw112,
        note: cell111?.note || "",
      };
    }

    const makingUpCos = {
      name: cosRawName || "Making up Cos",
      pct: cosPct || formattedPct,
      cells: makingUpCosCells,
    };

    // 4. Update outgoings cache with new makingUpCos
    const outgoingsCacheKey = `pulse:pma:outgoings:${sheetIdClean}`;
    if (redisClient?.isOpen) {
      try {
        const cachedRaw = await redisClient.get(outgoingsCacheKey);
        if (cachedRaw) {
          const parsed = JSON.parse(cachedRaw);
          parsed.makingUpCos = makingUpCos;
          await redisClient.set(outgoingsCacheKey, JSON.stringify(parsed), { EX: 120 });
        } else {
          await redisClient.del(outgoingsCacheKey);
        }
      } catch (e) { }
    }

    // Invalidate PMA cache for views
    await invalidatePmaClientCache(sheetIdClean, null, ["views"]).catch(() => { });

    // 5. Activity log
    const bgLog = logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: clientName || "",
      category: "EXPENSES",
      action: "Making up Cos target updated",
      summary: `Updated Making up Cos target to ${formattedPct} in Outgoings!A112`,
      details: {
        cellRef: "Outgoings!A112",
        targetPct: formattedPct,
      },
      user: sessionUser?.email || "Unknown user",
    }).catch(e => console.error("PMA log failed:", e));
    try { waitUntil(bgLog); } catch (_) { }

    return res.status(200).json({
      success: true,
      targetPct: formattedPct,
      makingUpCos,
    });
  } catch (err) {
    console.error("❌ set_making_up_cos_target error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleFireOutgoingsPull(req, res, sheets) {
  const { clientSheetId: pullClientSheetId, masterSheetId: pullMasterSheetId, clientName } = req.body;
  if (!pullClientSheetId || !pullMasterSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId or masterSheetId" });
  try {
    const pullClientIdClean = extractSheetIdFromUrl(pullClientSheetId) || pullClientSheetId;
    const pullMasterIdClean = extractSheetIdFromUrl(pullMasterSheetId) || pullMasterSheetId;

    const sessionUser = getSessionUser(req);
    if (sessionUser && !sessionUser.isAdmin) {
      const clientAuth = await verifyUserAuthorizedForSheet(sessionUser, pullClientIdClean, clientName, sheets);
      if (!clientAuth.authorized) {
        return res.status(clientAuth.status || 403).json({ success: false, error: clientAuth.error || "Access denied to this client." });
      }
      const masterAuth = await verifyUserAuthorizedForSheet(sessionUser, pullMasterIdClean, clientAuth.clientName, sheets);
      if (!masterAuth.authorized) {
        return res.status(masterAuth.status || 403).json({ success: false, error: masterAuth.error || "Access denied to this master sheet." });
      }
    }

    const cronSecret = process.env.CRON_SECRET || process.env.AGENT_TRIGGER_SECRET || "";
    if (!cronSecret) {
      return res.status(500).json({ success: false, error: "Server CRON_SECRET is not configured." });
    }
    const gasResp = await fetch("https://script.google.com/macros/s/AKfycbzVvLSDtqWj3aHcn0UV9VPCybNm82sBNWynMo1-bMpvs3NzerPZXWkrpPJvVHaqDwwy/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refreshOutgoings", clientSheetId: pullClientIdClean, masterSheetId: pullMasterIdClean, secret: cronSecret }),
    });
    const gasData = await gasResp.json().catch(() => ({}));
    console.log(`  📋 fire_outgoings_pull GAS call: ${gasData.success ? "OK" : gasData.error || "no response"}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.log(`  ⚠ fire_outgoings_pull GAS call failed (non-fatal): ${err.message}`);
    return res.status(200).json({ success: false, error: err.message });
  }
}

export async function handleMarkPipelineCopied(req, res, sheets) {
  const { clientSheetId: pipeClientSheetId, pipelineRow } = req.body;
  const parsedPipeRow = parseInt(pipelineRow, 10);
  if (!pipeClientSheetId || !pipelineRow || isNaN(parsedPipeRow) || parsedPipeRow < 2 || parsedPipeRow > 5000) {
    return res.status(400).json({ success: false, error: "Missing or invalid clientSheetId or pipelineRow" });
  }

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: pipeClientSheetId,
      range: `Pipeline!DD${parsedPipeRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [["Yes"]] },
    });

    console.log(`  ✅ mark_pipeline_copied: wrote Yes to Pipeline!DD${parsedPipeRow}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ mark_pipeline_copied error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleDeleteDirectJob(req, res, sheets) {
  const { clientSheetId, tabName, rowNums, clientName, jobName, endClientName } = req.body;
  if (!clientSheetId || !rowNums || !Array.isArray(rowNums) || rowNums.length === 0) {
    return res.status(400).json({ success: false, error: "Missing clientSheetId or rowNums" });
  }

  const targetTab = tabName ? String(tabName).trim() : "Confirmed";
  if (targetTab !== "Confirmed" && targetTab !== "Pipeline") {
    return res.status(400).json({ success: false, error: "Invalid tabName" });
  }
  const minJobRow = 2;
  const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

  try {
    const unassignedInvoices = [];
    const validScanRows = rowNums.map(Number).filter(n => n >= minJobRow);
    const minR = validScanRows.length > 0 ? Math.min(...validScanRows) : minJobRow;
    const maxR = validScanRows.length > 0 ? Math.max(...validScanRows) : minJobRow;

    const [scanResp, metaResp] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!AP${minR}:BH${maxR}`,
          valueRenderOption: "UNFORMATTED_VALUE"
        })
      ).catch((e) => {
        console.warn("Pre-delete scan for real invoices failed (non-fatal):", e.message);
        return null;
      }),
      rowNums.length > 0
        ? withRetry(() =>
          sheets.spreadsheets.get({
            spreadsheetId: sheetIdClean,
            fields: "sheets(properties,rowGroups)",
          })
        ).catch(() => null)
        : Promise.resolve(null),
    ]);

    const scanData = scanResp?.data?.values || [];
    for (const rNum of validScanRows) {
      const rIdx = Number(rNum) - minR;
      const rowVals = scanData[rIdx] || [];
      for (let s = 1; s <= 3; s++) {
        const base = s === 1 ? 0 : s === 2 ? 7 : 14;
        const a = rowVals[base];
        const ref = String(rowVals[base + 1] || "").trim();
        const sent = rowVals[base + 2];
        const st = String(rowVals[base + 4] || "").trim();
        if (ref && !isPlaceholderInvoice(ref, st)) {
          unassignedInvoices.push({
            invoiceNo: ref,
            amount: parseFloat(a) || 0,
            sentDate: sent || "",
            status: st || "",
            slotNum: s,
            rowNum: rNum
          });
        }
      }
    }

    // 1. Clean up dimension groups and unhide rows FIRST while the sheet is idle (<1s),
    // before values.batchClear triggers formula recalculation.
    if (rowNums.length > 0 && metaResp) {
      try {
        const sheetMetaList = metaResp.data?.sheets || [];
        const sheetObj = sheetMetaList.find(s => s.properties?.title === targetTab);
        if (sheetObj && sheetObj.properties?.sheetId !== undefined) {
          const sortedRows = [...rowNums].map(Number).sort((a, b) => a - b);
          const cleanupRequests = [];
          if (sortedRows.length > 1 && sheetObj.rowGroups) {
            const childStartIndex = sortedRows[1] - 1;
            const childEndIndex = sortedRows[sortedRows.length - 1];
            const matchingGroup = (sheetObj.rowGroups || []).find(
              g => g.range?.startIndex <= childStartIndex && g.range?.endIndex >= childEndIndex
            );
            if (matchingGroup) {
              cleanupRequests.push(
                {
                  deleteDimensionGroup: {
                    range: {
                      sheetId: sheetObj.properties.sheetId,
                      dimension: "ROWS",
                      startIndex: matchingGroup.range.startIndex,
                      endIndex: matchingGroup.range.endIndex,
                    },
                  },
                },
                {
                  updateDimensionProperties: {
                    range: {
                      sheetId: sheetObj.properties.sheetId,
                      dimension: "ROWS",
                      startIndex: matchingGroup.range.startIndex,
                      endIndex: matchingGroup.range.endIndex,
                    },
                    properties: { hiddenByUser: false },
                    fields: "hiddenByUser",
                  },
                }
              );
            }
          }
          for (const rNum of sortedRows) {
            cleanupRequests.push({
              updateDimensionProperties: {
                range: {
                  sheetId: sheetObj.properties.sheetId,
                  dimension: "ROWS",
                  startIndex: rNum - 1,
                  endIndex: rNum,
                },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            });
          }
          if (cleanupRequests.length > 0) {
            await withRetry(() =>
              sheets.spreadsheets.batchUpdate({
                spreadsheetId: sheetIdClean,
                requestBody: { requests: cleanupRequests },
              })
            );
          }
        }
      } catch (groupErr) {
        console.warn("⚠️ Group cleanup non-fatal warning in delete job:", groupErr.message);
      }
    }

    // 2. Clear cell data SECOND while preserving all formula columns:
    // [1, 7]: A:G (Client, Job, Code, Date, Lead Source, etc.)
    // [31, 31]: AE (Uneven splits)
    // [33, 39]: AG:AM (Revenue, Direct Costs, VAT, Type, Product Line, Start Date, End Date)
    // [40, 40]: AN (Likelihood)
    // [42, 60]: AP:BH (Invoice slots)
    // [76, 96]: BX:CR (Direct cost slots)
    // [108, 108]: DD (Copied to Confirmed?)
    const colRanges = [
      [1, 7],     // A:G
      [31, 31],   // AE
      [33, 39],   // AG:AM
      [40, 40],   // AN
      [42, 60],   // AP:BH
      [76, 96],   // BX:CR
      [108, 108], // DD
    ];

    const clearRanges = [];
    for (const rNum of rowNums) {
      const r = parseInt(rNum, 10);
      if (isNaN(r) || r < minJobRow) continue;
      for (const [startCol, endCol] of colRanges) {
        const startLetter = colIndexToLetter(startCol);
        const endLetter = colIndexToLetter(endCol);
        clearRanges.push(`${targetTab}!${startLetter}${r}:${endLetter}${r}`);
      }
    }

    if (clearRanges.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.values.batchClear({
          spreadsheetId: sheetIdClean,
          requestBody: { ranges: clearRanges },
        })
      );
    }

    // Invalidate caches & record deleted row signatures briefly (15s) to avoid stale Sheets API read replicas
    // Scoped by row + client + jobName so a new job immediately created on the same blanked row is never suppressed
    const delCacheKey = `deleted_job_rows:${sheetIdClean}:${targetTab.toLowerCase()}`;
    const prevDel = memoryCache.get(delCacheKey) || [];
    const delClientLower = String(endClientName || "").trim().toLowerCase();
    const delJobLower = String(jobName || "").trim().toLowerCase();
    const newSigs = rowNums.map(r => `${Number(r)}:${delClientLower}:${delJobLower}`);
    const updatedDel = Array.from(new Set([...prevDel, ...newSigs]));
    memoryCache.set(delCacheKey, updatedDel, 15); // 15s TTL

    await invalidatePmaClientCache(sheetIdClean, null, ["jobs", "invoices", "retainers", "cash"]);

    // Log activity
    const tenantClient = clientName || (await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId));
    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "JOBS",
      action: "JOB_DELETED",
      summary: `Deleted job "${endClientName ? `${endClientName} - ` : ""}${jobName || "Job"}" from ${targetTab} (cleared ${rowNums.length} row${rowNums.length === 1 ? "" : "s"}: ${rowNums.join(", ")})`,
      details: {
        jobName,
        endClientName,
        tabName: targetTab,
        clearedRows: rowNums,
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, unassignedInvoices });
  } catch (err) {
    console.error("❌ handleDeleteDirectJob error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleMarkPipelineAlreadyConfirmed(req, res, sheets) {
  const { clientSheetId, rowNum, clientName, jobName, endClientName, updates } = req.body;
  if (!clientSheetId || !rowNum) {
    return res.status(400).json({ success: false, error: "Missing clientSheetId or rowNum" });
  }

  const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const pRow = parseInt(rowNum, 10);
  if (isNaN(pRow) || pRow < 2) {
    return res.status(400).json({ success: false, error: "Invalid rowNum" });
  }

  try {
    // Guard: Prevent manual promotion of CRM-originated pipeline deals
    try {
      const codeResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `Pipeline!C${pRow}`,
          valueRenderOption: "FORMATTED_VALUE",
        })
      );
      const parentProjectCode = (codeResp.data?.values?.[0]?.[0] || "").trim();
      if (parentProjectCode) {
        let crmTool = "None";
        let crmDrives = "NA";
        try {
          const kiResp = await withRetry(() =>
            sheets.spreadsheets.values.get({
              spreadsheetId: sheetIdClean,
              range: "KeyInfo!Q8:Q9",
              valueRenderOption: "FORMATTED_VALUE",
            })
          );
          const kiRows = kiResp.data?.values || [];
          if (kiRows[0]?.[0]) crmTool = String(kiRows[0][0]).trim();
          if (kiRows[1]?.[0]) crmDrives = String(kiRows[1][0]).trim();
        } catch (kiErr) {
          if (redisClient?.isOpen && clientName) {
            try {
              const normKey = String(clientName).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
              const rawCfg = await redisClient.get(`pulse:setup:${normKey}`);
              if (rawCfg) {
                const parsed = JSON.parse(rawCfg);
                if (parsed.crmTool) crmTool = parsed.crmTool;
                if (parsed.crmDrives) crmDrives = parsed.crmDrives;
              }
            } catch (e) { }
          }
        }

        if (hasActiveCrmIntegration(crmTool) && isCrmDrivenTab("pipeline", crmDrives)) {
          return res.status(400).json({
            success: false,
            error: `Cannot manually confirm a CRM pipeline deal. Please update the deal status directly in ${getCrmDisplayName(crmTool)}.`,
          });
        }
      }
    } catch (crmCheckErr) {
      console.warn("⚠️ CRM check warning in handleMarkPipelineAlreadyConfirmed:", crmCheckErr.message);
    }

    let likelihoodCol = "AN";
    let copiedStatusCol = "DD";
    try {
      const pHeaderResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Pipeline!1:2",
          valueRenderOption: "FORMATTED_VALUE",
        })
      );
      const rows = pHeaderResp.data?.values || [];
      const headerRow = rows[1] && rows[1].length > 10 ? rows[1] : (rows[0] || []);
      const lIdx = headerRow.findIndex((h) => {
        const s = String(h || "").trim().toLowerCase();
        return s === "% likel." || s === "% likelihood" || s === "% likely" || s === "likelihood";
      });
      if (lIdx !== -1) likelihoodCol = colIndexToLetter(lIdx + 1);
      const cIdx = headerRow.findIndex((h) => {
        const s = String(h || "").trim().toLowerCase();
        return s.includes("copied") || s.includes("conf?");
      });
      if (cIdx !== -1) copiedStatusCol = colIndexToLetter(cIdx + 1);
    } catch (e) {
      console.warn("⚠️ Failed to detect pipeline header columns, falling back to AN & DD:", e.message);
    }

    const batchData = [
      {
        range: `Pipeline!${likelihoodCol}${pRow}`,
        values: [["100%"]],
      },
      {
        range: `Pipeline!${copiedStatusCol}${pRow}`,
        values: [["Yes"]],
      },
    ];

    if (Array.isArray(updates) && updates.length > 0) {
      const ALLOWED_UPDATE_COLS = new Set(["A", "B", "C", "D", "E", "F", "G", "AE", "AG", "AH", "AI", "AJ", "AK", "AL", "AM", "AN", "DD"]);
      for (const u of updates) {
        const match = String(u?.cellRef || "").trim().toUpperCase().match(/^([A-Z]{1,2})(\d{1,4})$/);
        if (match && ALLOWED_UPDATE_COLS.has(match[1]) && parseInt(match[2], 10) === pRow && u.value !== undefined) {
          const safeVal = typeof u.value === "number" ? u.value : sanitizeFormulaInput(String(u.value));
          batchData.push({
            range: `Pipeline!${match[1]}${pRow}`,
            values: [[safeVal]],
          });
        }
      }
    }

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: batchData,
        },
      })
    );

    // Invalidate caches
    memoryCache.del(`pulse:portal:*:${sheetIdClean}*`);
    try {
      const keys = await redisClient.keys(`pulse:portal:*:${sheetIdClean}*`);
      if (keys.length > 0) await redisClient.del(...keys);
    } catch (e) { }

    // Log activity
    const tenantClient = clientName || (await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId));
    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "JOBS",
      action: "JOB_MARKED_ALREADY_CONFIRMED",
      summary: `Marked job "${endClientName ? `${endClientName} - ` : ""}${jobName || "Job"}" as already confirmed (Pipeline Row ${pRow}: Likelihood = 100%, Copied = Yes)`,
      details: {
        jobName,
        endClientName,
        rowNum: pRow,
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ handleMarkPipelineAlreadyConfirmed error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetDefaultDaysToPay(req, res, sheets) {
  const { clientSheetId, masterSheetId, clientName } = req.body || {};
  let sheetIdClean = clientSheetId ? (extractSheetIdFromUrl(clientSheetId) || clientSheetId) : null;
  let masterIdClean = masterSheetId ? (extractSheetIdFromUrl(masterSheetId) || masterSheetId) : null;

  if (!masterIdClean && (sheetIdClean || clientName)) {
    try {
      const { clientsArray } = await getAllClients(sheets, { isAdmin: true }, false);
      const found = clientsArray?.find(c =>
        (sheetIdClean && (extractSheetIdFromUrl(c.clientSheetId) === sheetIdClean || extractSheetIdFromUrl(c.masterSheetId) === sheetIdClean)) ||
        (clientName && c.clientName?.toLowerCase() === clientName.toLowerCase())
      );
      if (found?.masterSheetId) {
        masterIdClean = extractSheetIdFromUrl(found.masterSheetId) || found.masterSheetId;
      }
    } catch (lookupErr) {
      console.warn("Could not resolve masterSheetId in handleGetDefaultDaysToPay:", lookupErr.message);
    }
  }

  try {
    const tols = await getToleranceValues(sheets, masterIdClean || sheetIdClean);
    const b52Val = parseInt(tols?.defaultDaysToPay, 10);
    const defaultDays = !isNaN(b52Val) && b52Val >= 0 && b52Val <= 365 ? b52Val : 30;
    return res.status(200).json({ success: true, defaultDaysToPay: defaultDays });
  } catch (err) {
    return res.status(200).json({ success: true, defaultDaysToPay: 30 });
  }
}