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
  getCrmDisplayName
} from "../utils/helpers.js";
import { isUserAuthorizedForClient, matchesClientName, sanitizeFormulaInput, getClientManagerClientMap, DEFAULT_AC_SHEET_ID, verifyUserAuthorizedForSheet, resolveClientNameBySheetId } from "./userPermissions.js";
export { DEFAULT_AC_SHEET_ID, resolveClientNameBySheetId };
import { logPmaActivity } from "./pmaLogger.js";
import { getSessionUser } from "./authService.js";
import { redisClient } from "./redisClient.js";
import { memoryCache, get2TierCache, set2TierCache, invalidatePmaClientCache } from "./cacheService.js";

let _allClientsMemoryCache = null;
let _allClientsCachedAt = 0;
let _assignedExpensesMemoryCache = null;
let _assignedExpensesCachedAt = 0;

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
    } catch (e) {}
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
      const scriptId   = String(row[10] || "").trim();
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

  // Enrich clientsArray and clientsObj with accountingTool and hasAccountingIntegration from Redis setup config
  if (redisClient?.isOpen && clientsArray && clientsArray.length > 0) {
    try {
      const needsLookup = clientsArray.some(c => c.hasAccountingIntegration === undefined);
      if (needsLookup) {
        const normalizeClientKey = (str) => String(str || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const setupKeys = clientsArray.map(c => `pulse:setup:${normalizeClientKey(c.clientName)}`);
        const configs = await redisClient.mGet(setupKeys);
        clientsArray.forEach((c, idx) => {
          const raw = configs[idx];
          if (raw) {
            try {
              const cfg = JSON.parse(raw);
              c.accountingTool = cfg.accountingTool || "None";
              c.crmTool = cfg.crmTool || "None";
              c.crmDrives = cfg.crmDrives || "NA";
              c.hasAccountingIntegration = ["xero", "quickbooks", "qb"].some(t => String(c.accountingTool).toLowerCase().includes(t));
              if (clientsObj[c.clientName]) {
                clientsObj[c.clientName].accountingTool = c.accountingTool;
                clientsObj[c.clientName].crmTool = c.crmTool;
                clientsObj[c.clientName].crmDrives = c.crmDrives;
                clientsObj[c.clientName].hasAccountingIntegration = c.hasAccountingIntegration;
              }
            } catch (_) {}
          } else {
            c.accountingTool = c.accountingTool || "None";
            c.hasAccountingIntegration = c.hasAccountingIntegration || false;
          }
        });
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
      redisClient.del(`pulse:assigned_expenses:${aeAcId}`).catch(() => {});
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
      if (cached && Array.isArray(cached.inbox)) {
        return res.status(200).json(cached);
      }
    }

    const allLocks = await checkAllGASLocks(sheets, sheetIdClean);
    const expLock = allLocks.expense;
    if (expLock.locked) {
      return res.status(200).json({ success: true, inbox: [], locked: true, lockMessage: "Expense automation is currently running - try again in a moment" });
    }

    await setMasterSwitch(sheets, sheetIdClean, "DirComp", true);
    const dataResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "DirComp!A6:AV1000",
    });
    await setMasterSwitch(sheets, sheetIdClean, "DirComp", false);

    const rows = dataResp.data.values || [];
    const inbox = [];
    let skippedNoFlag = 0, skippedNoAppId = 0;
    for (const row of rows) {
      if (!row || row.length === 0) continue;
      const rawFlag = String(row[40] || "").trim();
      const isMissing = rawFlag === "1";
      if (!isMissing) { skippedNoFlag++; continue; }

      const date        = String(row[0] || "").trim();
      const description = String(row[1] || "").trim();
      const amount      = parseFloat(String(row[2] || "0").replace(/,/g, "")) || 0;
      const reference   = String(row[3] || "").trim();
      const accountName = String(row[4] || "").trim();
      const status      = String(row[5] || "").trim();
      const appId       = String(row[6] || "").trim();
      const datePaid    = String(row[7] || "").trim();
      const vatAmount   = parseFloat(String(row[8] || "0").replace(/[£$€,]/g, "")) || 0;
      const contactName = String(row[11] || "").trim();

      if (!appId) { skippedNoAppId++; continue; }
      inbox.push({ appId, amount, date, description, reference, accountName, status, datePaid, vatAmount, contactName });
    }

    const payload = { success: true, inbox };
    await set2TierCache(cacheKey, payload, 60);
    return res.status(200).json(payload);
  } catch (err) {
    try { await setMasterSwitch(sheets, extractSheetIdFromUrl(req.body.masterSheetId || req.body.clientSheetId) || req.body.masterSheetId || req.body.clientSheetId, "DirComp", false); } catch(e) {}
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

      const client       = String(row[0] || "").trim();
      const job          = String(row[1] || "").trim();
      const invoiceAmt   = parseFloat(String(row[2] || "0").replace(/,/g, "")) || 0;
      const totalExclVAT = parseFloat(String(row[3] || "0").replace(/,/g, "")) || 0;
      const vatIncluded  = parseFloat(String(row[4] || "0").replace(/,/g, "")) || 0;
      const invoiceNo    = String(row[5] || "").trim();
      
      const fmtDate = (dStr) => {
        if (!dStr) return "";
        const nativeParsed = new Date(dStr);
        let d = null;
        if (!isNaN(nativeParsed.getTime())) d = nativeParsed;
        else {
          const MONTHS_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
          const parts = String(dStr).split(/[-\/]/);
          if (parts.length === 3) {
            const mNum = MONTHS_MAP[parts[1]?.toLowerCase()?.substring(0,3)];
            if (mNum !== undefined) {
              const yr = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
              d = new Date(yr, mNum, parseInt(parts[0]));
            }
          }
        }
        if (!d) return String(dStr).trim();
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
      };
      
      const sentDate     = fmtDate(row[6]);
      const dueDate      = fmtDate(row[7]);
      const fullyPaidOn  = fmtDate(row[8]);
      const status       = String(row[9] || "").trim();
      const currency     = String(row[10] || "").trim() || "GBP";

      if (!invoiceNo) { skippedNoInvNo++; continue; }
      inbox.push({
        invoiceNo, client, job, currency, sentDate, dueDate, fullyPaidOn, status,
        amount: totalExclVAT > 0 ? totalExclVAT : invoiceAmt,
        grossAmount: invoiceAmt, vatAmount: vatIncluded,
      });
    }

    const payload = { success: true, inbox };
    await set2TierCache(cacheKey, payload, 60);
    return res.status(200).json(payload);
  } catch (err) {
    try { await setMasterSwitch(sheets, extractSheetIdFromUrl(req.body.masterSheetId || req.body.clientSheetId) || req.body.masterSheetId || req.body.clientSheetId, "InvComp", false); } catch(e) {}
    console.error("❌ get_invoices_inbox error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCreateOutgoingsVendor(req, res, sheets) {
  const { clientSheetId, vendorName, vatFlag, invTiming, payTiming, deliveryPct } = req.body;
  if (!clientSheetId || !vendorName) return res.status(400).json({ success: false, error: "Missing clientSheetId or vendorName" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const checkResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Outgoings!A13:A110",
    });
    const rows = checkResp.data.values || [];
    let lastRow = 12;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.[0]) { lastRow = 12 + i; break; }
    }
    const newRow = lastRow + 2;
    if (newRow > 110) return res.status(400).json({ success: false, error: "Contractors section is full (max row 110)" });

    const pctNum = parseFloat(String(deliveryPct !== undefined && deliveryPct !== "" ? deliveryPct : "100").replace(/%/g, ""));
    const pctString = `${Number.isFinite(pctNum) ? Math.max(0, Math.min(100, pctNum)) : 100}%`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetIdClean,
      range: `Outgoings!A${newRow}:E${newRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[sanitizeFormulaInput(vendorName), sanitizeFormulaInput(String(vatFlag || "Yes")), sanitizeFormulaInput(String(invTiming || "Next")), sanitizeFormulaInput(String(payTiming || "Next")), pctString]] },
    });

    await applySheetFontFormat(sheets, sheetIdClean, "Outgoings", newRow - 1, newRow, 0, 50, "Arial", 9);

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "EXPENSES",
      action: "Vendor Created",
      summary: `Created new contractor/vendor '${vendorName}' for ${tenantClient || "Client"} (Row ${newRow})`,
      details: {
        vendorName,
        vatFlag: vatFlag || "Yes",
        invTiming: invTiming || "Next",
        payTiming: payTiming || "Next",
        deliveryPct: pctString,
        row: newRow,
        clientName: tenantClient
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, sheetRow: newRow });
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
      if (cached && Array.isArray(cached.contractors)) {
        return res.status(200).json(cached);
      }
    }

    const gridResp = await sheets.spreadsheets.get({
      spreadsheetId: sheetIdClean,
      ranges: ["Outgoings!A1:BG1", "Outgoings!A13:BG110"],
      includeGridData: true,
      fields: "sheets.data.rowData.values(formattedValue,note,effectiveValue)",
    });

    const sheetGrids = gridResp.data.sheets?.[0]?.data || [];
    const headerGridData = sheetGrids[0];
    const contractorGridData = sheetGrids[1];

    const headerCells = headerGridData?.rowData?.[0]?.values || [];
    const contractorRows = contractorGridData?.rowData || [];

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

      const vatFlag   = String(rowCells[1]?.formattedValue || "").trim();
      const invTiming = String(rowCells[2]?.formattedValue || "").trim();
      const payTiming = String(rowCells[3]?.formattedValue || "").trim();

      const cells = {};
      for (const month of months) {
        const cellData = rowCells[month.colIndex];
        const note = cellData?.note || "";
        const value = cellData?.formattedValue || "";
        const { topNote, blocks } = parseNoteParts(note);
        cells[month.colLetter] = { value, note, topNote, blocks };
      }

      contractors.push({ sheetRow: 13 + r, name, vatFlag, invTiming, payTiming, cells });
    }

    const payload = { success: true, contractors, months };
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
      if (cached && Array.isArray(cached.jobs)) {
        return res.status(200).json(cached);
      }
    }

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];

    const parseSheetDate = (d) => {
      if (!d) return null;
      const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (!m) return null;
      const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
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
      invoiceSlots: [1,2,3].map(n => {
        const base = n === 1 ? 41 : n === 2 ? 48 : 55;
        return { slotNum: n, amount: colVal(row,base), ref: colVal(row,base+1), sentDate: colVal(row,base+2),
          daysToPay: colVal(row,base+3), status: canonicalizeInvoiceStatus(colVal(row,base+4)), highlighted: false };
      }),
      expenseSlots: [1,2,3].map(n => {
        const base = n === 1 ? 75 : n === 2 ? 82 : 89;
        return { slotNum: n, description: colVal(row,base), amount: colVal(row,base+1), vat: colVal(row,base+2),
          date: colVal(row,base+3), daysToPay: colVal(row,base+4), status: canonicalizeExpenseStatus(colVal(row,base+5)),
          transactionId: colVal(row,base+6), highlighted: false };
      }),
    });

    const jobs = [];
    let ri = 1;
    while (ri < rows.length) {
      const row = rows[ri] || [];
      const client = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const budgetNum = parseFloat(String(row[33]||"").replace(/[£$€,\s]/g,"")) || 0;
      if (!client && !jobName) { ri++; continue; }

      const parentRowNum = ri + 1;
      const jobRows = [buildRowData(parentRowNum, row, true)];
      let cj = ri + 1;
      while (cj < rows.length) {
        const next = rows[cj] || [];
        const nc = String(next[0]||"").trim();
        const nj = String(next[1]||"").trim();
        const nRevenue = String(next[32]||"").trim();
        const nBudget = parseFloat(String(next[33]||"").replace(/[£$€,\s]/g,"")) || 0;
        const nStart = String(next[37]||"").trim();
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

    const payload = { success: true, jobs };
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
      } catch (_) {}
    }

    const hasAccountingIntegration = ["xero", "quickbooks", "qb"].some(t => accountingTool.toLowerCase().includes(t));

    const parseSheetDate = (d) => {
      if (!d) return null;
      const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (!m) return null;
      const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
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
      invoiceSlots: [1,2,3].map(n => {
        const base = n === 1 ? 41 : n === 2 ? 48 : 55;
        return { slotNum: n, amount: colVal(row,base), ref: colVal(row,base+1), sentDate: colVal(row,base+2),
          daysToPay: colVal(row,base+3), status: canonicalizeInvoiceStatus(colVal(row,base+4)), highlighted: false };
      }),
      expenseSlots: [1,2,3].map(n => {
        const base = n === 1 ? 75 : n === 2 ? 82 : 89;
        return { slotNum: n, description: colVal(row,base), amount: colVal(row,base+1), vat: colVal(row,base+2),
          date: colVal(row,base+3), daysToPay: colVal(row,base+4), status: canonicalizeExpenseStatus(colVal(row,base+5)),
          transactionId: colVal(row,base+6), highlighted: false };
      }),
    });

    const jobs = [];
    let ri = 1;
    while (ri < rows.length) {
      const row = rows[ri] || [];
      const client = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const revenueNum = parseFloat(String(row[32]||"").replace(/[£$€,\s]/g,"")) || 0;
      if (!client && !jobName) { ri++; continue; }

      const parentRowNum = ri + 1;
      const jobRows = [buildRowData(parentRowNum, row, true)];
      let cj = ri + 1;
      while (cj < rows.length) {
        const next = rows[cj] || [];
        const nc = String(next[0]||"").trim();
        const nj = String(next[1]||"").trim();
        const nRevenue = String(next[32]||"").trim();
        const nBudget = parseFloat(String(next[33]||"").replace(/[£$€,\s]/g,"")) || 0;
        const nStart = String(next[37]||"").trim();
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
          if (isReal) realInvoicedTotal += parseFloat(String(slot.amount||"").replace(/[£$€,\s]/g,"")) || 0;
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

    if (tabName === "All" || !tabName) {
      try {
        const batchResp = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: sheetIdClean,
          ranges: ["Confirmed!A1:DD5000", "Pipeline!A1:DD5000", "KeyInfo!C23:C26", "KeyInfo!G32:G75", "KeyInfo!Q4", "KeyInfo!Q8:Q9"],
          valueRenderOption: "FORMATTED_VALUE",
        });
        confRows = batchResp.data.valueRanges?.[0]?.values || [];
        pipeRows = batchResp.data.valueRanges?.[1]?.values || [];
        const plData = batchResp.data.valueRanges?.[2]?.values || [];
        const lsData = batchResp.data.valueRanges?.[3]?.values || [];
        const accData = batchResp.data.valueRanges?.[4]?.values || [];
        const crmData = batchResp.data.valueRanges?.[5]?.values || [];
        productLines = plData.flat().map(v => String(v || "").trim()).filter(Boolean);
        leadSources = lsData.flat().map(v => String(v || "").trim()).filter(Boolean);
        if (accData?.[0]?.[0]) accountingTool = String(accData[0][0]).trim();
        if (crmData?.[0]?.[0]) crmTool = String(crmData[0][0]).trim();
        if (crmData?.[1]?.[0]) crmDrives = String(crmData[1][0]).trim();

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
          } catch (_) {}
        }
      } catch (batchErr) {
        try {
          const cResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: "Confirmed!A1:DD5000",
            valueRenderOption: "FORMATTED_VALUE",
          });
          confRows = cResp.data.values || [];
        } catch (_) {}
        try {
          const pResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: "Pipeline!A1:DD5000",
            valueRenderOption: "FORMATTED_VALUE",
          });
          pipeRows = pResp.data.values || [];
        } catch (_) {}
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
          ranges: ["KeyInfo!C23:C26", "KeyInfo!G32:G75", "KeyInfo!Q4", "KeyInfo!Q8:Q9"],
          valueRenderOption: "FORMATTED_VALUE"
        });
        const plData = keyInfoResp.data.valueRanges?.[0]?.values || [];
        const lsData = keyInfoResp.data.valueRanges?.[1]?.values || [];
        const accData = keyInfoResp.data.valueRanges?.[2]?.values || [];
        const crmData = keyInfoResp.data.valueRanges?.[3]?.values || [];
        productLines = plData.flat().map(v => String(v || "").trim()).filter(Boolean);
        leadSources = lsData.flat().map(v => String(v || "").trim()).filter(Boolean);
        if (accData?.[0]?.[0]) accountingTool = String(accData[0][0]).trim();
        if (crmData?.[0]?.[0]) crmTool = String(crmData[0][0]).trim();
        if (crmData?.[1]?.[0]) crmDrives = String(crmData[1][0]).trim();

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
          } catch (_) {}
        }
      } catch (_) {}
    }

    // Phase 2 Optimization: Scoped cell notes range based on actual rows in the sheet
    // Cuts note scanning by over 90% (e.g. 50 rows instead of 1,000 rows across 90 columns)
    const confNoteMaxRow = Math.min(Math.max(confRows.length + 5, 20), 1000);
    const pipeNoteMaxRow = Math.min(Math.max(pipeRows.length + 5, 20), 1000);

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
      invoiceSlots: [1,2,3].map(n => {
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
      expenseSlots: [1,2,3].map(n => {
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

    const deletedConfRows = new Set(memoryCache.get(`deleted_job_rows:${sheetIdClean}:confirmed`) || []);
    const deletedPipeRows = new Set(memoryCache.get(`deleted_job_rows:${sheetIdClean}:pipeline`) || []);

    const parseTabJobs = (rows, currentTab) => {
      const deletedRowsSet = currentTab === "Pipeline" ? deletedPipeRows : deletedConfRows;
      const tabJobs = [];
      let ri = currentTab === "Pipeline" ? 5 : 1; 
      while (ri < rows.length) {
        const row = rows[ri] || [];
        const parentRowNum = ri + 1;
        if (deletedRowsSet.has(parentRowNum)) { ri++; continue; }

        const client = String(row[0] || "").trim();
        const jobName = String(row[1] || "").trim();
        if (!client && !jobName) { ri++; continue; }

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
      const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
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
    const payload = { success: true, jobs, productLines, leadSources, existingClients, accountingTool, crmTool, crmDrives, hasAccountingIntegration };
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
    const safeValue = sanitizeFormulaInput(value);
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetIdClean,
      range: `${tabName}!${cellRef}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[safeValue]] }
    });

    const targetCol = (colLetter || cellRef.replace(/[0-9]/g, "")).toUpperCase();
    const targetRow = parseInt(rowNum || cellRef.replace(/[^0-9]/g, ""), 10);

    // If Revenue (AG), Direct Costs (AH), or Dates (AL, AM) change on Confirmed tab, synchronize placeholders
    if (tabName === "Confirmed" && targetRow) {
      if (targetCol === "AG") {
        const revNum = parseFloat(safeValue) || 0;
        adjustJobInvoicePlaceholders_(sheets, sheetIdClean, tabName, [targetRow], revNum).catch(e => console.warn("Job revenue placeholder adjust failed:", e.message));
      } else if (targetCol === "AH") {
        const costNum = parseFloat(safeValue) || 0;
        adjustJobExpensePlaceholders_(sheets, sheetIdClean, tabName, [targetRow], costNum).catch(e => console.warn("Job expense placeholder adjust failed:", e.message));
      } else if (targetCol === "AL" || targetCol === "AM") {
        adjustJobInvoicePlaceholders_(sheets, sheetIdClean, tabName, [targetRow]).catch(e => console.warn("Job date invoice placeholder adjust failed:", e.message));
        adjustJobExpensePlaceholders_(sheets, sheetIdClean, tabName, [targetRow]).catch(e => console.warn("Job date expense placeholder adjust failed:", e.message));
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

    const valStr = value !== "" && value !== null && value !== undefined ? ` to "${value}"` : " (cleared)";
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

    return res.status(200).json({ success: true });
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

    const data = updates.map(u => ({
      range: `${tabName}!${u.cellRef || `${u.colLetter}${u.rowNum || rowNum}`}`,
      values: [[sanitizeFormulaInput(u.value)]]
    }));

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data
      }
    });

    // If Revenue (AG), Direct Costs (AH), or Dates (AL, AM) change on Confirmed tab, synchronize placeholders
    if (tabName === "Confirmed" && rowNum) {
      const targetRowNum = parseInt(rowNum, 10);
      const revUpdate = updates.find(u => (u.colLetter || "").toUpperCase() === "AG" || (u.cellRef || "").toUpperCase().startsWith("AG"));
      const costUpdate = updates.find(u => (u.colLetter || "").toUpperCase() === "AH" || (u.cellRef || "").toUpperCase().startsWith("AH"));
      const dateUpdate = updates.find(u => ["AL", "AM"].includes((u.colLetter || "").toUpperCase()) || ["AL", "AM"].some(c => (u.cellRef || "").toUpperCase().startsWith(c)));

      if (revUpdate) {
        const revNum = parseFloat(revUpdate.value) || 0;
        adjustJobInvoicePlaceholders_(sheets, sheetIdClean, tabName, [targetRowNum], revNum).catch(e => console.warn("Job fields revenue placeholder adjust failed:", e.message));
      } else if (dateUpdate) {
        adjustJobInvoicePlaceholders_(sheets, sheetIdClean, tabName, [targetRowNum]).catch(e => console.warn("Job fields date invoice placeholder adjust failed:", e.message));
      }

      if (costUpdate) {
        const costNum = parseFloat(costUpdate.value) || 0;
        adjustJobExpensePlaceholders_(sheets, sheetIdClean, tabName, [targetRowNum], costNum).catch(e => console.warn("Job fields expense placeholder adjust failed:", e.message));
      } else if (dateUpdate) {
        adjustJobExpensePlaceholders_(sheets, sheetIdClean, tabName, [targetRowNum]).catch(e => console.warn("Job fields date expense placeholder adjust failed:", e.message));
      }
    }

    let resolvedClient = req.body.clientName || "";
    if (!resolvedClient) {
      resolvedClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const resolvedEndClient = endClientName || "";
    const resolvedJobName = jobName || "";
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
        clientName: resolvedClient
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ update_job_fields error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function insertChildJobRow_(sheets, sheetIdClean, jobLastRow, jobClient, jobName) {
  const metaResp = await sheets.spreadsheets.get({
    spreadsheetId: sheetIdClean,
    fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
  });
  const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
  if (!confirmedSheet) throw new Error("Confirmed tab not found");
  const gridSheetId = confirmedSheet.properties.sheetId;
  const currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;
  const existingRowGroups = confirmedSheet.rowGroups || [];

  const fullResp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetIdClean,
    range: "Confirmed!A1:CR" + currentMaxRows,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const allRows = fullResp.data.values || [];
  let trueLastRow = 0;
  for (let r = allRows.length - 1; r >= 0; r--) {
    const row = allRows[r] || [];
    const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
    const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
    const z3 = row.slice(41, 60).some(c => c !== "" && c != null);
    const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
    if (z1 || z2 || z3 || z4) { trueLastRow = r + 1; break; }
  }

  const jobVAT = allRows[jobLastRow - 1]?.[34] ?? "";

  if (currentMaxRows - (trueLastRow + 1) < 1) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        requests: [{
          insertDimension: {
            range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 },
            inheritFromBefore: true,
          },
        }],
      },
    });
  }

  const sourceRowIndex0 = trueLastRow; 
  const destRowIndex0 = jobLastRow;    

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetIdClean,
    requestBody: {
      requests: [{
        moveDimension: {
          source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: sourceRowIndex0, endIndex: sourceRowIndex0 + 1 },
          destinationIndex: destRowIndex0,
        },
      }],
    },
  });

  const targetRowNum = jobLastRow + 1; 

  try {
    const destRowIndex1based0 = jobLastRow; 
    const coveringGroup = existingRowGroups.find(g =>
      g.range?.startIndex <= destRowIndex1based0 - 1 && g.range?.endIndex >= destRowIndex1based0
    );
    if (coveringGroup) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          requests: [
            { deleteDimensionGroup: { range: {
                sheetId: gridSheetId, dimension: "ROWS",
                startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex,
              } } },
            { addDimensionGroup: { range: {
                sheetId: gridSheetId, dimension: "ROWS",
                startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex + 1,
              } } },
          ],
        },
      });
    } else {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          requests: [{
            addDimensionGroup: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: destRowIndex1based0, endIndex: destRowIndex1based0 + 1 },
            },
          }],
        },
      });
    }
  } catch (groupErr) {
    console.log(`  ⚠ Row grouping for new child row failed (non-fatal): ${groupErr.message}`);
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetIdClean,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: `Confirmed!A${targetRowNum}`, values: [[jobClient || ""]] },
        { range: `Confirmed!B${targetRowNum}`, values: [[jobName || ""]] },
        { range: `Confirmed!AI${targetRowNum}`, values: [[jobVAT]] },
      ],
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
    const slotsNeeded = Math.max(1, Math.min(3, totalMonths - xeroCount));
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
  } catch (e) {}

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
  } catch (lookupErr) {}

  return null;
}

export async function adjustJobInvoicePlaceholders_(sheets, sheetIdClean, targetTab, rowNums, jobRevenue, passedMasterSheetId) {
  try {
    const validRowNums = (Array.isArray(rowNums) ? rowNums : [rowNums]).map(Number).filter(n => n && n >= 2);
    if (validRowNums.length === 0) return null;
    const minRow = Math.min(...validRowNums);
    const maxRow = Math.max(...validRowNums);

    const slotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    };

    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: `${targetTab}!AG${minRow}:BH${maxRow}`,
        valueRenderOption: "UNFORMATTED_VALUE"
      })
    );
    const rows = resp.data.values || [];
    let effectiveRev = jobRevenue;
    if (effectiveRev === undefined || effectiveRev === null || isNaN(effectiveRev)) {
      effectiveRev = parseFloat(String(rows[0]?.[0] || "0").replace(/[£$€,\s]/g, "")) || 0;
    }

    let realInvoicedTotal = 0;
    let realCount = 0;
    let manualPlaceholdersTotal = 0;
    const availableSlots = [];
    const autoPlaceholders = [];

    for (const rNum of validRowNums) {
      const rowArr = rows[rNum - minRow] || [];
      for (let s = 1; s <= 3; s++) {
        const base = s === 1 ? 9 : s === 2 ? 16 : 23;
        const amt = parseFloat(String(rowArr[base] || "0").replace(/[£$€,\s]/g, "")) || 0;
        const ref = String(rowArr[base + 1] || "").trim();
        const sent = String(rowArr[base + 2] || "").trim();
        const days = String(rowArr[base + 3] || "").trim();
        const st = String(rowArr[base + 4] || "").trim();

        const isPlace = isPlaceholderInvoice(ref, st);
        const isEmpty = !ref && !amt;

        if (isEmpty) {
          availableSlots.push({ rowNum: rNum, slotNum: s, currentAmount: 0, isAuto: false, currentSent: sent });
        } else if (isPlace) {
          const isAuto = !ref || ref.toUpperCase().startsWith("PLACE");
          if (isAuto) {
            autoPlaceholders.push({ rowNum: rNum, slotNum: s, currentAmount: amt, currentSent: sent });
            availableSlots.push({ rowNum: rNum, slotNum: s, currentAmount: amt, isAuto: true, currentSent: sent });
          } else {
            manualPlaceholdersTotal += amt;
          }
        } else {
          realInvoicedTotal += amt;
          realCount++;
        }
      }
    }

    if (effectiveRev > 0) {
      const remainingToInvoice = Math.max(0, Math.round((effectiveRev - realInvoicedTotal - manualPlaceholdersTotal) * 100) / 100);

      if (remainingToInvoice > 0.01) {
        const masterId = passedMasterSheetId || await resolveMasterSheetIdForClient_(sheets, sheetIdClean);
        const tols = masterId ? await getToleranceValues(sheets, masterId) : {
          invoiceLogicMode: "50-50",
          retainerInvoiceDay: 28,
          defaultDaysToPay: 30
        };

        const primaryRowData = rows[0] || [];
        const rawStartDate = primaryRowData[5]; // AL: Start date (AG=0, AH=1, AI=2, AJ=3, AK=4, AL=5)
        const rawEndDate = primaryRowData[6];   // AM: End date
        const startDate = rawStartDate ? parseSheetDate(rawStartDate) : new Date();
        const endDate = rawEndDate ? parseSheetDate(rawEndDate) : startDate;

        const allocations = calculateRevenueSplit(
          remainingToInvoice,
          tols.invoiceLogicMode || "50-50",
          startDate,
          endDate,
          tols.retainerInvoiceDay || 28,
          realCount
        );

        const daysToPayVal = tols.defaultDaysToPay || 30;
        const slotsToUse = Math.min(allocations.length, availableSlots.length);

        for (let k = 0; k < slotsToUse; k++) {
          const target = availableSlots[k];
          const cols = slotCols[target.slotNum];
          let amountToWrite = allocations[k].amt;
          if (k === slotsToUse - 1 && allocations.length > slotsToUse) {
            for (let j = k + 1; j < allocations.length; j++) amountToWrite += allocations[j].amt;
          }
          const autoRef = generateAutoPlaceholderRef_("PLACE-INV");
          const sentDate = toSheetDateFormat(allocations[k].date);

          await withRetry(() =>
            sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean,
              range: `${targetTab}!${cols.a}${target.rowNum}:${cols.st}${target.rowNum}`,
              valueInputOption: "RAW",
              requestBody: { values: [[amountToWrite, autoRef, sentDate, daysToPayVal, "Placeholder"]] }
            })
          );
        }

        // Clear any surplus auto placeholders beyond slotsToUse
        for (let k = slotsToUse; k < availableSlots.length; k++) {
          const extra = availableSlots[k];
          if (extra.isAuto) {
            const extraCols = slotCols[extra.slotNum];
            await withRetry(() =>
              sheets.spreadsheets.values.update({
                spreadsheetId: sheetIdClean,
                range: `${targetTab}!${extraCols.a}${extra.rowNum}:${extraCols.st}${extra.rowNum}`,
                valueInputOption: "RAW",
                requestBody: { values: [["", "", "", "", ""]] }
              })
            );
          }
        }

        if (availableSlots.length > 0) {
          return { rowNum: availableSlots[0].rowNum, slotNum: availableSlots[0].slotNum, amount: allocations[0]?.amt || remainingToInvoice, cleared: false };
        }
      } else {
        // Clear all auto placeholders
        for (const p of autoPlaceholders) {
          const cols = slotCols[p.slotNum];
          await withRetry(() =>
            sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean,
              range: `${targetTab}!${cols.a}${p.rowNum}:${cols.st}${p.rowNum}`,
              valueInputOption: "RAW",
              requestBody: { values: [["", "", "", "", ""]] }
            })
          );
        }
        if (autoPlaceholders.length > 0) {
          return { rowNum: autoPlaceholders[0].rowNum, slotNum: autoPlaceholders[0].slotNum, amount: 0, cleared: true };
        }
      }
    }
  } catch (err) {
    console.warn("adjustJobInvoicePlaceholders_ error (non-fatal):", err.message);
  }
  return null;
}

export async function adjustJobExpensePlaceholders_(sheets, sheetIdClean, targetTab, rowNums, jobBudget, passedMasterSheetId) {
  try {
    const validRowNums = (Array.isArray(rowNums) ? rowNums : [rowNums]).map(Number).filter(n => n && n >= 2);
    if (validRowNums.length === 0) return null;
    const minRow = Math.min(...validRowNums);
    const maxRow = Math.max(...validRowNums);

    const slotCols = {
      1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
      2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
      3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
    };

    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: `${targetTab}!AH${minRow}:CR${maxRow}`,
        valueRenderOption: "UNFORMATTED_VALUE"
      })
    );
    const rows = resp.data.values || [];
    let effectiveBudget = jobBudget;
    if (effectiveBudget === undefined || effectiveBudget === null || isNaN(effectiveBudget)) {
      effectiveBudget = parseFloat(String(rows[0]?.[0] || "0").replace(/[£$€,\s]/g, "")) || 0;
    }

    let realExpensesTotal = 0;
    let realCount = 0;
    let manualExpensesTotal = 0;
    const availableSlots = [];
    const autoPlaceholders = [];

    for (const rNum of validRowNums) {
      const rowArr = rows[rNum - minRow] || [];
      for (let s = 1; s <= 3; s++) {
        const base = s === 1 ? 42 : s === 2 ? 49 : 56;
        const desc = String(rowArr[base] || "").trim();
        const amt = parseFloat(String(rowArr[base + 1] || "0").replace(/[£$€,\s]/g, "")) || 0;
        const st = String(rowArr[base + 5] || "").trim();
        const id = String(rowArr[base + 6] || "").trim();

        const isPlace = isPlaceholderExpense(id, desc, st);
        const isEmpty = !desc && !id && !amt;

        if (isEmpty) {
          availableSlots.push({ rowNum: rNum, slotNum: s, currentAmount: 0, isAuto: false });
        } else if (isPlace) {
          const isAuto = (!id && !desc) || id.toUpperCase().startsWith("PLACE") || desc.toUpperCase().startsWith("PLACE");
          if (isAuto) {
            autoPlaceholders.push({ rowNum: rNum, slotNum: s, currentAmount: amt });
            availableSlots.push({ rowNum: rNum, slotNum: s, currentAmount: amt, isAuto: true });
          } else {
            manualExpensesTotal += amt;
          }
        } else if ((id || desc) && amt > 0) {
          realExpensesTotal += amt;
          realCount++;
        }
      }
    }

    if (effectiveBudget > 0) {
      const remainingDC = Math.max(0, Math.round((effectiveBudget - realExpensesTotal - manualExpensesTotal) * 100) / 100);

      if (remainingDC > 0.01) {
        const masterId = passedMasterSheetId || await resolveMasterSheetIdForClient_(sheets, sheetIdClean);
        const tols = masterId ? await getToleranceValues(sheets, masterId) : {
          expenseLogicMode: "100 at start",
          retainerExpenseDay: 28,
          defaultDaysToPay: 30
        };

        const primaryRowData = rows[0] || [];
        const rawStartDate = primaryRowData[4]; // AL: Start date (AH=0, AI=1, AJ=2, AK=3, AL=4)
        const rawEndDate = primaryRowData[5];   // AM: End date
        const startDate = rawStartDate ? parseSheetDate(rawStartDate) : new Date();
        const endDate = rawEndDate ? parseSheetDate(rawEndDate) : startDate;

        const allocations = calculateRevenueSplit(
          remainingDC,
          tols.expenseLogicMode || "100 at start",
          startDate,
          endDate,
          tols.retainerExpenseDay || 28,
          realCount
        );

        const daysToPayVal = tols.defaultDaysToPay || 30;
        const slotsToUse = Math.min(allocations.length, availableSlots.length);

        for (let k = 0; k < slotsToUse; k++) {
          const target = availableSlots[k];
          const cols = slotCols[target.slotNum];
          let amountToWrite = allocations[k].amt;
          if (k === slotsToUse - 1 && allocations.length > slotsToUse) {
            for (let j = k + 1; j < allocations.length; j++) amountToWrite += allocations[j].amt;
          }
          const autoId = generateAutoPlaceholderRef_("PLACE-EXP");
          const dt = toSheetDateFormat(allocations[k].date);

          await withRetry(() =>
            sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean,
              range: `${targetTab}!${cols.d}${target.rowNum}:${cols.id}${target.rowNum}`,
              valueInputOption: "RAW",
              requestBody: { values: [["Placeholder - Direct cost", amountToWrite, "Yes", dt, daysToPayVal, "Placeholder", autoId]] }
            })
          );
        }

        // Clear any surplus auto placeholders beyond slotsToUse
        for (let k = slotsToUse; k < availableSlots.length; k++) {
          const extra = availableSlots[k];
          if (extra.isAuto) {
            const extraCols = slotCols[extra.slotNum];
            await withRetry(() =>
              sheets.spreadsheets.values.update({
                spreadsheetId: sheetIdClean,
                range: `${targetTab}!${extraCols.d}${extra.rowNum}:${extraCols.id}${extra.rowNum}`,
                valueInputOption: "RAW",
                requestBody: { values: [["", "", "", "", "", "", ""]] }
              })
            );
          }
        }

        if (availableSlots.length > 0) {
          return { rowNum: availableSlots[0].rowNum, slotNum: availableSlots[0].slotNum, amount: allocations[0]?.amt || remainingDC, cleared: false };
        }
      } else {
        for (const p of autoPlaceholders) {
          const cols = slotCols[p.slotNum];
          await withRetry(() =>
            sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean,
              range: `${targetTab}!${cols.d}${p.rowNum}:${cols.id}${p.rowNum}`,
              valueInputOption: "RAW",
              requestBody: { values: [["", "", "", "", "", "", ""]] }
            })
          );
        }
        if (autoPlaceholders.length > 0) {
          return { rowNum: autoPlaceholders[0].rowNum, slotNum: autoPlaceholders[0].slotNum, amount: 0, cleared: true };
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
      const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
      const mIdx = months[m[2].toLowerCase()];
      if (mIdx === undefined) return null;
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
      return new Date(yr, mIdx, parseInt(m[1]));
    };
    const fmtDate = (d) => {
      const ms = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
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

    for (const exp of expenseList) {
      // If current slot exceeds 3, spill over to the next row of this job or create a new child row
      if (currSlotNum > 3) {
        const nextKnownRow = knownJobRows.find(r => r > currRowNum);
        if (nextKnownRow) {
          currRowNum = nextKnownRow;
          currSlotNum = 1;
        } else {
          // No more rows for this job - create a new child row
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

      valueUpdates.push(
        { range: `Confirmed!${slotColsForSlot.d}${currRowNum}`,  values: [[descToSave]] },
        { range: `Confirmed!${slotColsForSlot.a}${currRowNum}`,  values: [[exp.amount || 0]] },
        { range: `Confirmed!${slotColsForSlot.v}${currRowNum}`,  values: [[vatYesNo]] },
        { range: `Confirmed!${slotColsForSlot.dp}${currRowNum}`, values: [[30]] },
        { range: `Confirmed!${slotColsForSlot.st}${currRowNum}`, values: [[exp.status || ""]] },
        { range: `Confirmed!${slotColsForSlot.id}${currRowNum}`, values: [[exp.appId || ""]] }
      );

      const parsedExpenseDate = parseExpenseDate(exp.date);
      if (parsedExpenseDate) {
        dateUpdates.push({
          range: `Confirmed!${slotColsForSlot.dt}${currRowNum}`,
          values: [[fmtDate(parsedExpenseDate)]]
        });
      }

      placed.push({
        rowNum: currRowNum,
        slotNum: currSlotNum,
        description: descToSave,
        amount: exp.amount || 0,
        vat: vatYesNo,
        date: parsedExpenseDate ? fmtDate(parsedExpenseDate) : (exp.date || ""),
        status: exp.status || "",
        transactionId: exp.appId || "",
        appId: exp.appId || ""
      });

      currSlotNum++;
    }

    if (valueUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "RAW",
          data: valueUpdates,
        },
      });
    }

    if (dateUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: dateUpdates,
        },
      });
    }

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const jobIdentifier = (jobClient && jobName) ? `"${jobClient} - ${jobName}"` : `"${jobName || jobClient || "Job"}"`;

    const summaryStr = placed.length === 1
      ? `Placed expense '${placed[0].description}' (£${placed[0].amount}) into ${jobIdentifier} (Row ${placed[0].rowNum}, Slot ${placed[0].slotNum})`
      : `Placed ${placed.length} expenses into ${jobIdentifier} sequentially starting at Row ${placed[0].rowNum}, Slot ${placed[0].slotNum}`;

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
    }).catch(e => console.error("PMA log failed:", e));

    let placeholderAdjustment = null;
    try {
      placeholderAdjustment = await adjustJobExpensePlaceholders_(
        sheets, sheetIdClean, "Confirmed", knownJobRows, req.body.jobBudget
      );
    } catch (pErr) {
      console.warn("handleAssignExpenseToJob placeholder adjustment failed (non-fatal):", pErr.message);
    }

    return res.status(200).json({
      success: true,
      placed,
      newRowNum: createNewRow ? currRowNum : undefined,
      newRowsCreated: knownJobRows.length > (Array.isArray(jobRows) ? jobRows.length : 1),
      placeholderAdjustment
    });
  } catch (err) {
    console.error("❌ assign_expense_to_job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateExpenseSlot(req, res, sheets) {
  const { clientSheetId, rowNum, slotNum, expense, deleteSlot, tabName, jobClient, jobName, createNewRow } = req.body;
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

    if (createNewRow) {
      const newRowNum = await insertChildJobRow_(sheets, sheetIdClean, actualRowNum, jobClient || "", jobName || "");
      actualRowNum = newRowNum;
      actualSlotNum = 1;
    }

    const slotCols = {
      1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
      2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
      3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
    }[actualSlotNum];
    if (!slotCols) return res.status(400).json({ success: false, error: "Invalid slotNum" });

    const values = deleteSlot
      ? ["", "", "", "", "", "", ""]
      : [
          expense.description || "",
          expense.amount || 0,
          expense.vat || "No",
          expense.date || "",
          expense.daysToPay || 30,
          expense.status || "",
          expense.transactionId || "",
        ];

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `${targetTab}!${slotCols.d}${actualRowNum}`,  values: [[values[0]]] },
          { range: `${targetTab}!${slotCols.a}${actualRowNum}`,  values: [[values[1]]] },
          { range: `${targetTab}!${slotCols.v}${actualRowNum}`,  values: [[values[2]]] },
          { range: `${targetTab}!${slotCols.dp}${actualRowNum}`, values: [[values[4]]] },
          { range: `${targetTab}!${slotCols.st}${actualRowNum}`, values: [[values[5]]] },
          { range: `${targetTab}!${slotCols.id}${actualRowNum}`, values: [[values[6]]] },
        ],
      },
    });

    if (deleteSlot) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetIdClean,
        range: `${targetTab}!${slotCols.dt}${actualRowNum}`,
        valueInputOption: "RAW",
        requestBody: { values: [[""]] },
      });
    } else if (expense.date) {
      const formattedDate = toSheetDateFormat(expense.date);
      if (formattedDate) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!${slotCols.dt}${actualRowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[formattedDate]] },
        });
      }
    }

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    let endClient = req.body.endClientName || "";
    let job = req.body.jobName || "";
    if (!endClient || !job) {
      try {
        const nameResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `${targetTab}!A${rowNum}:B${rowNum}`,
            valueRenderOption: "FORMATTED_VALUE"
          })
        );
        const rowVals = nameResp.data.values?.[0] || [];
        if (!endClient && rowVals[0]) endClient = String(rowVals[0]).trim();
        if (!job && rowVals[1]) job = String(rowVals[1]).trim();
      } catch (e) {}
    }
    const jobIdentifier = (endClient && job) ? `"${endClient} - ${job}"` : `"${job || endClient || `Row ${rowNum}`}"`;

    logPmaActivity(sheets, {
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
    }).catch(e => console.error("PMA log failed:", e));

    let placeholderAdjustment = null;
    try {
      const rowsToCheck = Array.isArray(req.body.jobRowNums) && req.body.jobRowNums.length > 0
        ? req.body.jobRowNums
        : [actualRowNum];
      placeholderAdjustment = await adjustJobExpensePlaceholders_(
        sheets, sheetIdClean, targetTab, rowsToCheck, req.body.jobBudget
      );
    } catch (pErr) {
      console.warn("handleUpdateExpenseSlot placeholder adjustment failed (non-fatal):", pErr.message);
    }

    return res.status(200).json({ success: true, placeholderAdjustment });
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
  if (!clientSheetId || !invoice) return res.status(400).json({ success: false, error: "Missing clientSheetId or invoice" });
  if (!createNewRow && (!rowNum || !slotNum)) return res.status(400).json({ success: false, error: "Missing rowNum or slotNum" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const slotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    };

    const effectiveClientName = (updateClientName && newClientName) ? newClientName : (jobClient || "");
    const effectiveJobName = (updateJobName && newJobName) ? newJobName : (jobName || "");

    const metaResp = await sheets.spreadsheets.get({
      spreadsheetId: sheetIdClean,
      fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
    });
    const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
    if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });
    const gridSheetId = confirmedSheet.properties.sheetId;
    let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;
    const existingRowGroups = confirmedSheet.rowGroups || [];

    const fullResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR" + Math.min(currentMaxRows, 5000),
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const allRows = fullResp.data.values || [];

    const norm = (s) => String(s || "").trim().toLowerCase();
    const targetClient = norm(jobClient);
    const targetJobName = norm(jobName);

    // Locate all rows currently in the sheet that belong to this job
    const matchingRowIndices = [];
    for (let i = 1; i < allRows.length; i++) {
      const r = allRows[i] || [];
      const c = norm(r[0]);
      const j = norm(r[1]);
      if (targetClient && targetJobName && c === targetClient && j === targetJobName) {
        matchingRowIndices.push(i + 1);
      }
    }
    // If no exact client+job match, check jobName match alone as fallback
    if (matchingRowIndices.length === 0 && targetJobName) {
      for (let i = 1; i < allRows.length; i++) {
        const r = allRows[i] || [];
        const j = norm(r[1]);
        if (j === targetJobName) {
          matchingRowIndices.push(i + 1);
        }
      }
    }

    let targetRowNum = rowNum;
    let targetSlotNum = slotNum;

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

      if (currentMaxRows - (trueLastRow + 1) < 1) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            requests: [{
              insertDimension: {
                range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 },
                inheritFromBefore: true,
              },
            }],
          },
        });
        currentMaxRows += 5;
      }

      const sourceRowIndex0 = trueLastRow; 
      const destRowIndex0 = actualJobLastRow;    

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          requests: [{
            moveDimension: {
              source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: sourceRowIndex0, endIndex: sourceRowIndex0 + 1 },
              destinationIndex: destRowIndex0,
            },
          }],
        },
      });

      targetRowNum = actualJobLastRow + 1; 
      targetSlotNum = 1; 

      try {
        const destRowIndex1based0 = actualJobLastRow; 
        const coveringGroup = existingRowGroups.find(g =>
          g.range?.startIndex <= destRowIndex1based0 - 1 && g.range?.endIndex >= destRowIndex1based0
        );
        if (coveringGroup) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: {
              requests: [
                { deleteDimensionGroup: { range: {
                    sheetId: gridSheetId, dimension: "ROWS",
                    startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex,
                  } } },
                { addDimensionGroup: { range: {
                    sheetId: gridSheetId, dimension: "ROWS",
                    startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex + 1,
                  } } },
              ],
            },
          });
        } else {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: {
              requests: [{
                addDimensionGroup: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: destRowIndex1based0, endIndex: destRowIndex1based0 + 1 },
                },
              }],
            },
          });
        }
      } catch (groupErr) {
        console.log(`  ⚠ Row grouping for new child row failed (non-fatal): ${groupErr.message}`);
      }

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "RAW",
          data: [
            { range: `Confirmed!A${targetRowNum}`, values: [[effectiveClientName]] },
            { range: `Confirmed!B${targetRowNum}`, values: [[effectiveJobName]] },
            { range: `Confirmed!AI${targetRowNum}`, values: [[vatVal]] },
          ],
        },
      });
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
    }

    if (updateClientName && newClientName) {
      const rowsToUpdate = new Set(matchingRowIndices.length > 0 ? matchingRowIndices : (Array.isArray(jobRowNums) ? jobRowNums : []));
      if (rowNum) rowsToUpdate.add(rowNum);
      if (targetRowNum) rowsToUpdate.add(targetRowNum);

      if (rowsToUpdate.size > 0) {
        const clientUpdates = Array.from(rowsToUpdate).map(r => ({
          range: `Confirmed!A${r}`,
          values: [[newClientName]]
        }));
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            valueInputOption: "RAW",
            data: clientUpdates,
          },
        });
      }
    }

    if (updateJobName && newJobName) {
      const rowsToUpdate = new Set(matchingRowIndices.length > 0 ? matchingRowIndices : (Array.isArray(jobRowNums) ? jobRowNums : []));
      if (rowNum) rowsToUpdate.add(rowNum);
      if (targetRowNum) rowsToUpdate.add(targetRowNum);

      if (rowsToUpdate.size > 0) {
        const jobUpdates = Array.from(rowsToUpdate).map(r => ({
          range: `Confirmed!B${r}`,
          values: [[newJobName]]
        }));
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            valueInputOption: "RAW",
            data: jobUpdates,
          },
        });
      }
    }


    // Update revenue if user chose to increase job revenue to match total invoiced
    const parentRowIndex = matchingRowIndices.length > 0 ? matchingRowIndices[0] : (createNewRow ? targetRowNum : rowNum);
    let effectiveRevenue = undefined;
    if (req.body.updateJobRevenue && req.body.newJobRevenue !== undefined) {
      effectiveRevenue = parseFloat(req.body.newJobRevenue) || 0;
      await withRetry(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `Confirmed!AG${parentRowIndex}`,
          valueInputOption: "RAW",
          requestBody: { values: [[effectiveRevenue]] },
        })
      );
    }

    const slotColsForSlot = slotCols[targetSlotNum];
    if (!slotColsForSlot) return res.status(400).json({ success: false, error: "Invalid slotNum" });

    let daysToPay = 30;
    if (invoice.sentDate && invoice.dueDate) {
      const parseD = (d) => {
        const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      };
      const sent = parseD(invoice.sentDate), due = parseD(invoice.dueDate);
      if (sent && due) daysToPay = Math.round((due - sent) / 86400000);
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `Confirmed!${slotColsForSlot.a}${targetRowNum}`,    values: [[invoice.amount || 0]] },
          { range: `Confirmed!${slotColsForSlot.ref}${targetRowNum}`,  values: [[invoice.invoiceNo || ""]] },
          { range: `Confirmed!${slotColsForSlot.days}${targetRowNum}`, values: [[daysToPay]] },
          { range: `Confirmed!${slotColsForSlot.st}${targetRowNum}`,   values: [[invoice.status || "Sent"]] },
        ],
      },
    });

    if (invoice.sentDate) {
      const parsedSentDate = (() => {
        if (!invoice.sentDate) return null;
        const m = String(invoice.sentDate).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      })();
      if (parsedSentDate) {
        const fmt = (d) => { const ms = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return d.getDate() + "-" + ms[d.getMonth()] + "-" + d.getFullYear(); };
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `Confirmed!${slotColsForSlot.sent}${targetRowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[fmt(parsedSentDate)]] },
        });
      }
    }

    // Adjust any existing placeholder invoice slot on this job
    const allJobRowsToCheck = matchingRowIndices.length > 0 ? [...matchingRowIndices] : [targetRowNum];
    if (createNewRow && !allJobRowsToCheck.includes(targetRowNum)) {
      allJobRowsToCheck.push(targetRowNum);
    }
    let placeholderAdjustment = null;
    try {
      placeholderAdjustment = await adjustJobInvoicePlaceholders_(
        sheets, sheetIdClean, "Confirmed", allJobRowsToCheck, effectiveRevenue
      );
    } catch (pErr) {
      console.warn("handleAssignInvoiceToJob placeholder adjustment failed (non-fatal):", pErr.message);
    }

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const endClient = effectiveClientName || jobClient || "";
    const jobIdentifier = (endClient && jobName) ? `"${endClient} - ${jobName}"` : `"${jobName || endClient || "Job"}"`;

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
    }).catch(e => console.error("PMA log failed:", e));

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

    // 1. Clear source invoice slot
    const sSlotCols = slotCols[sourceSlotNum];
    if (!sSlotCols) return res.status(400).json({ success: false, error: "Invalid sourceSlotNum" });

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "RAW",
          data: [
            { range: `${targetTab}!${sSlotCols.a}${sourceRowNum}`, values: [[""]] },
            { range: `${targetTab}!${sSlotCols.ref}${sourceRowNum}`, values: [[""]] },
            { range: `${targetTab}!${sSlotCols.sent}${sourceRowNum}`, values: [[""]] },
            { range: `${targetTab}!${sSlotCols.days}${sourceRowNum}`, values: [[""]] },
            { range: `${targetTab}!${sSlotCols.st}${sourceRowNum}`, values: [[""]] },
          ],
        },
      })
    );

    // Adjust any placeholder invoice on source job
    let sourcePlaceholderAdjustment = null;
    try {
      const fullResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!A1:B5000`,
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      );
      const allRows = fullResp.data.values || [];
      const norm = (s) => String(s || "").trim().toLowerCase();
      const sClientNorm = norm(sourceJobClient);
      const sJobNorm = norm(sourceJobName);

      const sourceRowNums = [];
      for (let i = 1; i < allRows.length; i++) {
        const r = allRows[i] || [];
        if (norm(r[0]) === sClientNorm && norm(r[1]) === sJobNorm) {
          sourceRowNums.push(i + 1);
        }
      }
      if (sourceRowNums.length > 0) {
        sourcePlaceholderAdjustment = await adjustJobInvoicePlaceholders_(
          sheets, sheetIdClean, targetTab, sourceRowNums
        );
      }
    } catch (sErr) {
      console.warn("Source job placeholder adjustment check failed:", sErr.message);
    }

    // 2. Assign invoice to target job
    let actualTargetRowNum = targetRowNum;
    let actualTargetSlotNum = targetSlotNum;

    if (createNewRow) {
      const newRowNum = await insertChildJobRow_(sheets, sheetIdClean, targetJobLastRow || targetRowNum, targetJobClient, targetJobName);
      actualTargetRowNum = newRowNum;
      actualTargetSlotNum = 1;
    }

    // Update target job revenue if requested
    let effectiveTargetRevenue = undefined;
    if (updateTargetRevenue && newTargetRevenue !== undefined) {
      effectiveTargetRevenue = parseFloat(newTargetRevenue) || 0;
      await withRetry(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!AG${actualTargetRowNum}`,
          valueInputOption: "RAW",
          requestBody: { values: [[effectiveTargetRevenue]] },
        })
      );
    }

    const tSlotCols = slotCols[actualTargetSlotNum];
    if (!tSlotCols) return res.status(400).json({ success: false, error: "Invalid targetSlotNum" });

    let daysToPay = parseInt(invoice.daysToPay, 10) || 30;
    const invAmt = parseFloat(invoice.amount) || 0;
    const invRef = invoice.invoiceNo || invoice.ref || "";
    const invStatus = invoice.status ? canonicalizeInvoiceStatus(invoice.status) : "Sent";

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "RAW",
          data: [
            { range: `${targetTab}!${tSlotCols.a}${actualTargetRowNum}`, values: [[invAmt]] },
            { range: `${targetTab}!${tSlotCols.ref}${actualTargetRowNum}`, values: [[invRef]] },
            { range: `${targetTab}!${tSlotCols.days}${actualTargetRowNum}`, values: [[daysToPay]] },
            { range: `${targetTab}!${tSlotCols.st}${actualTargetRowNum}`, values: [[invStatus]] },
          ],
        },
      })
    );

    if (invoice.sentDate) {
      const formattedSentDate = toSheetDateFormat(invoice.sentDate);
      if (formattedSentDate) {
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: sheetIdClean,
            range: `${targetTab}!${tSlotCols.sent}${actualTargetRowNum}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[formattedSentDate]] },
          })
        );
      }
    }

    // Adjust any placeholder invoice on target job
    let targetPlaceholderAdjustment = null;
    try {
      const targetScanResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!A1:B5000`,
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      );
      const allTargetRows = targetScanResp.data.values || [];
      const norm = (s) => String(s || "").trim().toLowerCase();
      const tClientNorm = norm(targetJobClient);
      const tJobNorm = norm(targetJobName);

      const targetRowNums = [];
      for (let i = 1; i < allTargetRows.length; i++) {
        const r = allTargetRows[i] || [];
        if (norm(r[0]) === tClientNorm && norm(r[1]) === tJobNorm) {
          targetRowNums.push(i + 1);
        }
      }
      if (targetRowNums.length > 0) {
        targetPlaceholderAdjustment = await adjustJobInvoicePlaceholders_(
          sheets, sheetIdClean, targetTab, targetRowNums, effectiveTargetRevenue
        );
      }
    } catch (tErr) {
      console.warn("Target job placeholder adjustment check failed:", tErr.message);
    }

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }

    logPmaActivity(sheets, {
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
    }).catch(e => console.error("PMA log failed:", e));

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

    // 1. If rowNum provided as hint, check that row first
    if (parsedRowNum && parsedRowNum > 0) {
      try {
        const checkResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!A${parsedRowNum}:BH${parsedRowNum}`,
          valueRenderOption: "FORMATTED_VALUE"
        });
        const rowVals = checkResp.data.values?.[0] || [];
        const client = String(rowVals[0] || "").trim();
        const job = String(rowVals[1] || "").trim();
        const pCode = String(rowVals[2] || "").trim();

        const slots = [
          { slotNum: 1, ref: String(rowVals[42] || "").trim(), amt: rowVals[41], sent: rowVals[43], status: rowVals[45] },
          { slotNum: 2, ref: String(rowVals[49] || "").trim(), amt: rowVals[48], sent: rowVals[50], status: rowVals[52] },
          { slotNum: 3, ref: String(rowVals[56] || "").trim(), amt: rowVals[55], sent: rowVals[57], status: rowVals[59] },
        ];

        const match = slots.find(s => s.ref.toLowerCase() === cleanTargetRef);
        if (match) {
          return res.status(200).json({
            success: true,
            found: true,
            liveRowNum: parsedRowNum,
            liveSlotNum: match.slotNum,
            liveClient: client,
            liveJobName: job,
            liveProjectCode: pCode,
            liveAmount: match.amt || "",
            liveSentDate: match.sent || "",
            liveStatus: canonicalizeInvoiceStatus(match.status) || "",
            rowShifted: false
          });
        }
      } catch (rowErr) {
        console.warn(`handleVerifyInvoiceSlot single-row check failed for row ${parsedRowNum}:`, rowErr.message);
      }
    }

    // 2. Scan the Confirmed tab live to find where the invoiceRef actually lives
    const scanResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: `${targetTab}!A1:BH5000`,
      valueRenderOption: "FORMATTED_VALUE"
    });
    const allRows = scanResp.data.values || [];

    for (let r = 0; r < allRows.length; r++) {
      const rowArr = allRows[r] || [];
      const s1 = String(rowArr[42] || "").trim().toLowerCase();
      const s2 = String(rowArr[49] || "").trim().toLowerCase();
      const s3 = String(rowArr[56] || "").trim().toLowerCase();

      let matchedSlot = null;
      let slotData = null;
      if (s1 === cleanTargetRef) {
        matchedSlot = 1;
        slotData = { amt: rowArr[41], sent: rowArr[43], status: rowArr[45] };
      } else if (s2 === cleanTargetRef) {
        matchedSlot = 2;
        slotData = { amt: rowArr[48], sent: rowArr[50], status: rowArr[52] };
      } else if (s3 === cleanTargetRef) {
        matchedSlot = 3;
        slotData = { amt: rowArr[55], sent: rowArr[57], status: rowArr[59] };
      }

      if (matchedSlot) {
        const liveRowNum = r + 1;
        return res.status(200).json({
          success: true,
          found: true,
          liveRowNum,
          liveSlotNum: matchedSlot,
          liveClient: String(rowArr[0] || "").trim(),
          liveJobName: String(rowArr[1] || "").trim(),
          liveProjectCode: String(rowArr[2] || "").trim(),
          liveAmount: slotData?.amt || "",
          liveSentDate: slotData?.sent || "",
          liveStatus: canonicalizeInvoiceStatus(slotData?.status) || "",
          rowShifted: parsedRowNum ? liveRowNum !== parsedRowNum : false
        });
      }
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
  const { clientSheetId, rowNum, slotNum, invoice, deleteSlot, jobClient, jobName, tabName, createNewRow } = req.body;
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

    if (createNewRow) {
      const newRowNum = await insertChildJobRow_(sheets, sheetIdClean, actualRowNum, jobClient || "", jobName || "");
      actualRowNum = newRowNum;
      actualSlotNum = 1;
    }

    if (!createNewRow && (jobClient || jobName)) {
      try {
        const checkResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!A${actualRowNum}:B${actualRowNum}`,
          valueRenderOption: "UNFORMATTED_VALUE"
        });
        const currentVals = checkResp.data.values?.[0] || [];
        const norm = (s) => String(s || "").trim().toLowerCase();
        const curClient = norm(currentVals[0]);
        const curJob = norm(currentVals[1]);
        const targetClient = norm(jobClient);
        const targetJobName = norm(jobName);

        if ((targetClient && curClient !== targetClient) || (targetJobName && curJob !== targetJobName)) {
          const searchResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `${targetTab}!A1:B5000`,
            valueRenderOption: "UNFORMATTED_VALUE"
          });
          const searchRows = searchResp.data.values || [];
          const matches = [];
          for (let i = 1; i < searchRows.length; i++) {
            const r = searchRows[i] || [];
            if (norm(r[0]) === targetClient && norm(r[1]) === targetJobName) {
              matches.push(i + 1);
            }
          }
          if (matches.length > 0 && !matches.includes(actualRowNum)) {
            actualRowNum = matches[0];
            console.log(`ℹ Reconciled update_invoice_slot row from ${rowNum} to ${actualRowNum} on ${targetTab} for job "${jobName}"`);
          }
        }
      } catch (checkErr) {
        console.warn(`Row verification check failed in update_invoice_slot on ${targetTab}:`, checkErr.message);
      }
    }

    let invoiceRefFound = false;
    if (req.body.invoiceRef) {
      const cleanTargetRef = String(req.body.invoiceRef).trim().toLowerCase();
      try {
        const slotCheckResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!AQ${actualRowNum}:BE${actualRowNum}`,
          valueRenderOption: "UNFORMATTED_VALUE"
        });
        const slotVals = slotCheckResp.data.values?.[0] || [];
        const ref1 = String(slotVals[0] || "").trim().toLowerCase();
        const ref2 = String(slotVals[7] || "").trim().toLowerCase();
        const ref3 = String(slotVals[14] || "").trim().toLowerCase();
        if (ref1 === cleanTargetRef) {
          actualSlotNum = 1;
          invoiceRefFound = true;
        } else if (ref2 === cleanTargetRef) {
          actualSlotNum = 2;
          invoiceRefFound = true;
        } else if (ref3 === cleanTargetRef) {
          actualSlotNum = 3;
          invoiceRefFound = true;
        } else {
          const scanResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `${targetTab}!AQ1:BE5000`,
            valueRenderOption: "UNFORMATTED_VALUE"
          });
          const allScanRows = scanResp.data.values || [];
          for (let r = 0; r < allScanRows.length; r++) {
            const rowArr = allScanRows[r] || [];
            const r1 = String(rowArr[0] || "").trim().toLowerCase();
            const r2 = String(rowArr[7] || "").trim().toLowerCase();
            const r3 = String(rowArr[14] || "").trim().toLowerCase();
            if (r1 === cleanTargetRef) { actualRowNum = r + 1; actualSlotNum = 1; invoiceRefFound = true; break; }
            if (r2 === cleanTargetRef) { actualRowNum = r + 1; actualSlotNum = 2; invoiceRefFound = true; break; }
            if (r3 === cleanTargetRef) { actualRowNum = r + 1; actualSlotNum = 3; invoiceRefFound = true; break; }
          }
        }
      } catch (scanErr) {
        console.warn("Invoice slot ref verification check skipped:", scanErr.message);
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

    const slotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    }[actualSlotNum];
    if (!slotCols) return res.status(400).json({ success: false, error: "Invalid slotNum" });

    const values = deleteSlot
      ? ["", "", "", "", ""]
      : [
          invoice.amount || 0,
          invoice.invoiceNo || "",
          invoice.sentDate || "",
          invoice.daysToPay || 30,
          invoice.status ? canonicalizeInvoiceStatus(invoice.status) : "",
        ];

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `${targetTab}!${slotCols.a}${actualRowNum}`,    values: [[values[0]]] },
          { range: `${targetTab}!${slotCols.ref}${actualRowNum}`,  values: [[values[1]]] },
          { range: `${targetTab}!${slotCols.days}${actualRowNum}`, values: [[values[3]]] },
          { range: `${targetTab}!${slotCols.st}${actualRowNum}`,   values: [[values[4]]] },
        ],
      },
    });

    if (deleteSlot) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetIdClean,
        range: `${targetTab}!${slotCols.sent}${actualRowNum}`,
        valueInputOption: "RAW",
        requestBody: { values: [[""]] },
      });
    } else if (invoice.sentDate) {
      const formattedSentDate = toSheetDateFormat(invoice.sentDate);
      if (formattedSentDate) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!${slotCols.sent}${actualRowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[formattedSentDate]] },
        });
      }
    }

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    let endClient = req.body.endClientName || "";
    let job = req.body.jobName || "";
    if (!endClient || !job) {
      try {
        const nameResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `${targetTab}!A${rowNum}:B${rowNum}`,
            valueRenderOption: "FORMATTED_VALUE"
          })
        );
        const rowVals = nameResp.data.values?.[0] || [];
        if (!endClient && rowVals[0]) endClient = String(rowVals[0]).trim();
        if (!job && rowVals[1]) job = String(rowVals[1]).trim();
      } catch (e) {}
    }
    const jobIdentifier = (endClient && job) ? `"${endClient} - ${job}"` : `"${job || endClient || `Row ${rowNum}`}"`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "INVOICES",
      action: deleteSlot ? "Invoice Slot Cleared" : "Invoice Slot Updated",
      summary: deleteSlot
        ? `Cleared invoice slot #${slotNum} on ${targetTab} Row ${rowNum} for ${jobIdentifier}`
        : `Updated invoice slot #${slotNum} on ${targetTab} Row ${rowNum} for ${jobIdentifier} (Inv #${invoice?.invoiceNo || ""}, £${invoice?.amount || 0})`,
      details: {
        slotNum,
        rowNum,
        endClient,
        jobName: job,
        clientName: tenantClient,
        deleteSlot: !!deleteSlot,
        invoiceNumber: invoice?.invoiceNo,
        amount: invoice?.amount,
        status: invoice?.status
      }
    }).catch(e => console.error("PMA log failed:", e));

    // Update revenue if requested
    let effectiveRevenue = undefined;
    if (req.body.updateJobRevenue && req.body.newJobRevenue !== undefined) {
      effectiveRevenue = parseFloat(req.body.newJobRevenue) || 0;
      await withRetry(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!AG${actualRowNum}`,
          valueInputOption: "RAW",
          requestBody: { values: [[effectiveRevenue]] },
        })
      );
    }

    // Adjust any placeholder invoice slot on this job
    let placeholderAdjustment = null;
    try {
      const rowsToCheck = Array.isArray(req.body.jobRowNums) && req.body.jobRowNums.length > 0
        ? req.body.jobRowNums
        : [actualRowNum];
      placeholderAdjustment = await adjustJobInvoicePlaceholders_(
        sheets, sheetIdClean, targetTab, rowsToCheck, effectiveRevenue
      );
    } catch (pErr) {
      console.warn("handleUpdateInvoiceSlot placeholder adjustment failed (non-fatal):", pErr.message);
    }

    return res.status(200).json({
      success: true,
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
    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "UNFORMATTED_VALUE",
    }));
    const allRows = resp.data.values || [];

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
    let targetMasterId = (req.body.masterSheetId || invoice.masterSheetId) ? (extractSheetIdFromUrl(req.body.masterSheetId || invoice.masterSheetId) || req.body.masterSheetId || invoice.masterSheetId) : null;
    if (!targetMasterId && sheetIdClean) {
      try {
        const { clientsArray } = await getAllClients(sheets, { isAdmin: true }, false);
        const found = clientsArray?.find(c => 
          extractSheetIdFromUrl(c.clientSheetId) === sheetIdClean || 
          extractSheetIdFromUrl(c.masterSheetId) === sheetIdClean ||
          (req.body.clientName && c.clientName?.toLowerCase() === req.body.clientName.toLowerCase())
        );
        if (found?.masterSheetId) {
          targetMasterId = extractSheetIdFromUrl(found.masterSheetId) || found.masterSheetId;
        }
      } catch (e) {}
    }
    try {
      const tols = await getToleranceValues(sheets, targetMasterId || sheetIdClean);
      const b52Val = parseInt(tols?.defaultDaysToPay, 10);
      if (!isNaN(b52Val) && b52Val >= 0 && b52Val <= 365) {
        clientDefaultDays = b52Val;
      }
    } catch (e) {
      console.warn("Could not read DataChgAlert!B52 defaultDaysToPay:", e.message);
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

    const updateData = [
      { range: `Confirmed!A${newRow}`,  values: [[sanitizeFormulaInput(invoice.client || "")]] },
      { range: `Confirmed!B${newRow}`,  values: [[sanitizeFormulaInput(jobName || invoice.job || "")]] },
      { range: `Confirmed!C${newRow}`,  values: [[sanitizeFormulaInput(projectCode || "")]] },
      { range: `Confirmed!D${newRow}`,  values: [[todayFormatted]] },
      { range: `Confirmed!AG${newRow}`, values: [[parseFloat(revenue) || parseFloat(invoice.amount) || 0]] },
      { range: `Confirmed!AH${newRow}`, values: [[parseFloat(directCosts) || 0]] },
      { range: `Confirmed!AI${newRow}`, values: [[sanitizeFormulaInput(vatYesNo || (invoice.vatAmount > 0 ? "Yes" : "No"))]] },
      { range: `Confirmed!AJ${newRow}`, values: [[sanitizeFormulaInput(projectType || "Project")]] },
      { range: `Confirmed!AL${newRow}`, values: [[formatSheetDate(startDate || invoice.sentDate)]] },
      { range: `Confirmed!AM${newRow}`, values: [[formatSheetDate(endDate || invoice.dueDate)]] },
      { range: `Confirmed!AP${newRow}`, values: [[parseFloat(invoice.amount) || 0]] },
      { range: `Confirmed!AQ${newRow}`, values: [[sanitizeFormulaInput(invoice.invoiceNo || "")]] },
      { range: `Confirmed!AR${newRow}`, values: [[formatSheetDate(invoice.sentDate)]] },
      { range: `Confirmed!AS${newRow}`, values: [[finalDaysToPay]] },
      { range: `Confirmed!AT${newRow}`, values: [[sanitizeFormulaInput(canonicalizeInvoiceStatus(invoice.status) || "Sent")]] },
    ];

    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updateData,
      },
    }));

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const endClient = invoice?.client || "";
    const createdJob = jobName || invoice?.job || "Job";
    const jobIdentifier = endClient ? `"${endClient} - ${createdJob}"` : `"${createdJob}"`;

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
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, newRowNum: newRow });
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
    const startRow = targetTab === "Pipeline" ? 6 : 2;

    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: `${targetTab}!A1:CR5000`,
      valueRenderOption: "UNFORMATTED_VALUE",
    }));
    const allRows = resp.data.values || [];

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

    const updateData = [
      { range: `${targetTab}!A${targetRow}`,  values: [[sanitizeFormulaInput(jobData.client || "")]] },
      { range: `${targetTab}!B${targetRow}`,  values: [[sanitizeFormulaInput(jobData.jobName || "")]] },
      { range: `${targetTab}!C${targetRow}`,  values: [[sanitizeFormulaInput(jobData.projectCode || "")]] },
      { range: `${targetTab}!D${targetRow}`,  values: [[formatSheetDate(jobData.dateConfirmed || jobData.dateAdded || new Date())]] },
      { range: `${targetTab}!E${targetRow}`,  values: [[sanitizeFormulaInput(jobData.leadSource || "")]] },
      { range: `${targetTab}!AG${targetRow}`, values: [[parseFloat(jobData.revenue) || 0]] },
      { range: `${targetTab}!AH${targetRow}`, values: [[parseFloat(jobData.directCosts) || 0]] },
      { range: `${targetTab}!AI${targetRow}`, values: [[sanitizeFormulaInput(jobData.vat || "Yes")]] },
      { range: `${targetTab}!AJ${targetRow}`, values: [[sanitizeFormulaInput(jobData.projectRetainer || "Project")]] },
      { range: `${targetTab}!AK${targetRow}`, values: [[sanitizeFormulaInput(jobData.productLine || "")]] },
      { range: `${targetTab}!AL${targetRow}`, values: [[formatSheetDate(jobData.startDate)]] },
      { range: `${targetTab}!AM${targetRow}`, values: [[formatSheetDate(jobData.endDate)]] },
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
    let targetMasterId = (jobData.masterSheetId || req.body.masterSheetId) ? (extractSheetIdFromUrl(jobData.masterSheetId || req.body.masterSheetId) || jobData.masterSheetId || req.body.masterSheetId) : null;
    if (!targetMasterId && sheetIdClean) {
      try {
        const { clientsArray } = await getAllClients(sheets, { isAdmin: true }, false);
        const found = clientsArray?.find(c => 
          extractSheetIdFromUrl(c.clientSheetId) === sheetIdClean || 
          extractSheetIdFromUrl(c.masterSheetId) === sheetIdClean ||
          ((req.body.clientName || jobData.client) && c.clientName?.toLowerCase() === (req.body.clientName || jobData.client).toLowerCase())
        );
        if (found?.masterSheetId) {
          targetMasterId = extractSheetIdFromUrl(found.masterSheetId) || found.masterSheetId;
        }
      } catch (e) {}
    }
    let tols = null;
    try {
      tols = await getToleranceValues(sheets, targetMasterId || sheetIdClean);
      const b52Val = parseInt(tols?.defaultDaysToPay, 10);
      if (!isNaN(b52Val) && b52Val >= 0 && b52Val <= 365) {
        clientDefaultDays = b52Val;
      }
    } catch (e) {}

    // Invoice Slots (up to 3)
    const invoiceSlotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    };
    let writtenInvoicesCount = 0;
    if (jobData.invoices && Array.isArray(jobData.invoices)) {
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
            { range: `${targetTab}!${sCols.a}${targetRow}`,    values: [[amt]] },
            { range: `${targetTab}!${sCols.ref}${targetRow}`,  values: [[ref]] },
            { range: `${targetTab}!${sCols.sent}${targetRow}`, values: [[sent]] },
            { range: `${targetTab}!${sCols.days}${targetRow}`, values: [[days]] },
            { range: `${targetTab}!${sCols.st}${targetRow}`,   values: [[st]] }
          );
        }
      }
    }

    if (writtenInvoicesCount === 0 && (parseFloat(jobData.revenue) || 0) > 0) {
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
          { range: `${targetTab}!${sCols.a}${targetRow}`,    values: [[alloc.amt]] },
          { range: `${targetTab}!${sCols.ref}${targetRow}`,  values: [[autoRef]] },
          { range: `${targetTab}!${sCols.sent}${targetRow}`, values: [[sent]] },
          { range: `${targetTab}!${sCols.days}${targetRow}`, values: [[clientDefaultDays]] },
          { range: `${targetTab}!${sCols.st}${targetRow}`,   values: [["Placeholder"]] }
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
            { range: `${targetTab}!${eCols.d}${targetRow}`,  values: [[desc]] },
            { range: `${targetTab}!${eCols.a}${targetRow}`,  values: [[amt]] },
            { range: `${targetTab}!${eCols.v}${targetRow}`,  values: [[vatVal]] },
            { range: `${targetTab}!${eCols.dt}${targetRow}`, values: [[dt]] },
            { range: `${targetTab}!${eCols.dp}${targetRow}`, values: [[dp]] },
            { range: `${targetTab}!${eCols.st}${targetRow}`, values: [[st]] },
            { range: `${targetTab}!${eCols.id}${targetRow}`, values: [[txId]] }
          );
        }
      }
    }

    if (writtenExpensesCount === 0 && (parseFloat(jobData.directCosts) || 0) > 0) {
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
          { range: `${targetTab}!${eCols.d}${targetRow}`,   values: [["Placeholder - Direct cost"]] },
          { range: `${targetTab}!${eCols.a}${targetRow}`,   values: [[alloc.amt]] },
          { range: `${targetTab}!${eCols.v}${targetRow}`,   values: [[sanitizeFormulaInput(jobData.vat || "Yes")]] },
          { range: `${targetTab}!${eCols.dt}${targetRow}`,  values: [[dt]] },
          { range: `${targetTab}!${eCols.dp}${targetRow}`,  values: [[clientDefaultDays]] },
          { range: `${targetTab}!${eCols.st}${targetRow}`,  values: [["Placeholder"]] },
          { range: `${targetTab}!${eCols.id}${targetRow}`,  values: [[autoId]] }
        );
      });
    }

    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updateData
      }
    }));

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const endClient = jobData.client || "";
    const createdJob = jobData.jobName || "Job";
    const jobIdentifier = endClient ? `"${endClient} - ${createdJob}"` : `"${createdJob}"`;

    const summaryAdditions = [];
    if (jobData.unevenSplit || jobData.splitStr) summaryAdditions.push("custom revenue split");
    if (writtenInvoicesCount > 0) summaryAdditions.push(`${writtenInvoicesCount} invoice(s)`);
    if (writtenExpensesCount > 0) summaryAdditions.push(`${writtenExpensesCount} expense(s)`);
    const detailsExtra = summaryAdditions.length > 0 ? ` with ${summaryAdditions.join(" and ")}` : "";

    logPmaActivity(sheets, {
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
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, targetRow, targetTab });
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
      } catch (e) {}
    }

    const blockStr = (blocks || []).map(b =>
      `{App ID: ${b.appId}}{Amt: ${b.amount}}{Status:${b.status ? " " + b.status : ""}}{Rec date:${b.recDate ? " " + b.recDate : ""}}{Pay date:${b.payDate ? " " + b.payDate : ""}}{Description:${b.description ? " " + b.description : ""}}`
    ).join("\n");

    const noteStr = finalTopNote
      ? (finalTopNote + (blockStr ? "\n" + blockStr : ""))
      : blockStr;

    const cellTotal = (blocks || [])
      .filter(b => !b.appId.startsWith("UNRECON-GAP"))
      .reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);

    const cellRef = `Outgoings!${colLetter}${sheetRow}`;
    if (blocks !== undefined) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetIdClean,
        range: cellRef,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[cellTotal || ""]] },
      });
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
            ranges: [`Outgoings!${colLetter}111`],
            includeGridData: true,
            fields: "sheets.data.rowData.values(effectiveValue,formattedValue,note)",
          })
        );
        const cosCell = cosCellResp.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0];
        if (cosCell) {
          const cosVal = typeof cosCell.effectiveValue?.numberValue === "number"
            ? cosCell.effectiveValue.numberValue
            : parseFloat(String(cosCell.formattedValue || "").replace(/[^0-9.-]/g, "")) || 0;
          const existingCosNote = cosCell.note || "";
          if (Math.abs(cosVal) <= 0.001) {
            if (existingCosNote) {
              newCosNote = "";
            }
          } else if (existingCosNote.includes("{Amt:")) {
            newCosNote = existingCosNote.replace(/\{Amt:\s*[^}]*\}/, `{Amt: ${cosVal.toFixed(2)}}`);
          } else if (Math.abs(cosVal) > 0.001) {
            newCosNote = `{App ID: PLACE-EXP-${colLetter}-Makin-1111}{Amt: ${cosVal.toFixed(2)}}{Status: }{Rec date: }{Pay date: }{Description: Placeholder Entry - Making up CoS}`;
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
      } catch (e) {}
    }
    const contractorIdentifier = contractor ? `"${contractor}" (${cellRef})` : cellRef;

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
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, cellRef, blockCount: (blocks || []).length, cellTotal });
  } catch (err) {
    console.error("❌ update_outgoing_note error:", err);
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
  } catch(err) {
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
  const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

  try {
    const unassignedInvoices = [];
    try {
      const minR = Math.min(...rowNums.map(Number).filter(n => n >= 2));
      const maxR = Math.max(...rowNums.map(Number).filter(n => n >= 2));
      const scanResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: `${targetTab}!AP${minR}:BH${maxR}`,
          valueRenderOption: "UNFORMATTED_VALUE"
        })
      );
      const scanData = scanResp.data.values || [];
      for (const rNum of rowNums) {
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
    } catch (e) {
      console.warn("Pre-delete scan for real invoices failed (non-fatal):", e.message);
    }

    // Exact column ranges to blank out while preserving all formula columns:
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
      if (isNaN(r) || r < 2) continue;
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

    // Clean up dimension groups if child rows were grouped
    if (rowNums.length > 1) {
      try {
        const metaResp = await withRetry(() =>
          sheets.spreadsheets.get({
            spreadsheetId: sheetIdClean,
            fields: "sheets(properties,rowGroups)",
          })
        );
        const sheetMetaList = metaResp.data?.sheets || [];
        const sheetObj = sheetMetaList.find(s => s.properties?.title === targetTab);
        if (sheetObj && sheetObj.rowGroups) {
          const sortedRows = [...rowNums].map(Number).sort((a, b) => a - b);
          const childStartIndex = sortedRows[1] - 1;
          const childEndIndex = sortedRows[sortedRows.length - 1];
          const matchingGroup = (sheetObj.rowGroups || []).find(
            g => g.range?.startIndex <= childStartIndex && g.range?.endIndex >= childEndIndex
          );
          if (matchingGroup) {
            await withRetry(() =>
              sheets.spreadsheets.batchUpdate({
                spreadsheetId: sheetIdClean,
                requestBody: {
                  requests: [
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
                  ],
                },
              })
            );
          }
        }
      } catch (groupErr) {
        console.warn("⚠️ Group cleanup non-fatal warning in delete job:", groupErr.message);
      }
    }

    // Invalidate caches & record deleted row numbers to avoid stale Sheets API read replicas
    const delCacheKey = `deleted_job_rows:${sheetIdClean}:${targetTab.toLowerCase()}`;
    const prevDel = memoryCache.get(delCacheKey) || [];
    const updatedDel = Array.from(new Set([...prevDel, ...rowNums.map(Number)]));
    memoryCache.set(delCacheKey, updatedDel, 300); // 5 min TTL

    memoryCache.del(`pulse:portal:*:${sheetIdClean}*`);
    memoryCache.del(`pulse:view_data:${sheetIdClean}:*`);
    try {
      const keys = await redisClient.keys(`pulse:portal:*:${sheetIdClean}*`);
      if (keys.length > 0) await redisClient.del(...keys);
    } catch (e) {}

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
            } catch (e) {}
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
      const SAFE_CELL_REF_RE = /^[A-Z]{1,2}\d{1,4}$/;
      for (const u of updates) {
        if (u && SAFE_CELL_REF_RE.test(String(u.cellRef || "")) && u.value !== undefined) {
          const safeVal = typeof u.value === "number" ? u.value : sanitizeFormulaInput(String(u.value));
          batchData.push({
            range: `Pipeline!${u.cellRef}`,
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
    } catch (e) {}

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