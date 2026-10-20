import { getSheetsClient, withRetry, extractSheetIdFromUrl, colLetterToNum, colIndexToLetter, getSheetGid, getSheetId, applySheetFontFormat } from "./sheetsClient.js";
import { setMasterSwitch, checkAllGASLocks, fetchJobRowsForDisplay } from "./sharedHelpers.js";
import { logPmaActivity, DEFAULT_AC_SHEET_ID } from "./pmaLogger.js";
import { isPlaceholderInvoice, toSheetDateFormat } from "../utils/helpers.js";
import { getSessionUser } from "./authService.js";
import { isUserAuthorizedForClient, matchesClientName, sanitizeFormulaInput, getClientManagerClientMap } from "./userPermissions.js";
import { redisClient } from "./redisClient.js";
import { memoryCache } from "./cacheService.js";

let _allClientsMemoryCache = null;
let _allClientsCachedAt = 0;
let _assignedExpensesMemoryCache = null;
let _assignedExpensesCachedAt = 0;

export let assignedExpensesTabVerified = false;

export async function ensureAssignedExpensesTab_(sheets, spreadsheetId) {
  return;
}

const clientSheetIdToNameCache = new Map();

export async function resolveClientNameBySheetId(sheets, sheetId, acId = DEFAULT_AC_SHEET_ID) {
  if (!sheetId) return "";
  const cleanId = extractSheetIdFromUrl(sheetId) || sheetId;
  if (clientSheetIdToNameCache.has(cleanId)) {
    return clientSheetIdToNameCache.get(cleanId);
  }
  try {
    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId || DEFAULT_AC_SHEET_ID,
        range: "AutoUpdates!A2:N500"
      })
    );
    const rows = resp.data.values || [];
    for (const r of rows) {
      const cName = String(r[0] || "").trim();
      const clientUrl = String(r[11] || "").trim();
      const masterUrl = String(r[12] || "").trim();
      const cId = extractSheetIdFromUrl(clientUrl) || clientUrl;
      const mId = extractSheetIdFromUrl(masterUrl) || masterUrl;
      if (cId && cName) clientSheetIdToNameCache.set(cId, cName);
      if (mId && cName) clientSheetIdToNameCache.set(mId, cName);
      if ((cId === cleanId || mId === cleanId) && cName) {
        return cName;
      }
    }
  } catch (err) {
    console.warn("⚠️ Error resolving clientName by sheetId:", err.message);
  }
  return "";
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

export async function getAllClients(sheets, sessionUser = { isAdmin: true }, bypassCache = false, automationCommanderSheetId = DEFAULT_AC_SHEET_ID) {
  const acId = automationCommanderSheetId || process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_SHEET_ID;
  const cacheKey = `pulse:all_clients:${acId}`;
  const now = Date.now();

  let clientsArray = null;
  let clientsObj = null;

  if (!bypassCache && _allClientsMemoryCache && (now - _allClientsCachedAt < 600000)) {
    clientsArray = _allClientsMemoryCache.clientsArray;
    clientsObj = _allClientsMemoryCache.clientsObj;
  } else if (!bypassCache && redisClient?.isOpen) {
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

  let finalClientsArray = clientsArray;
  let finalClientsObj = clientsObj;

  const isAdminUser = !sessionUser || sessionUser.isAdmin || sessionUser.role === "Admin" || sessionUser.assignedClients === "*";
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
  const automationCommanderSheetId = req.body?.automationCommanderSheetId || process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_SHEET_ID;
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
  const aeAcId = req.body?.automationCommanderSheetId || process.env.AUTOMATION_COMMANDER_SHEET_ID || "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
  const { bypassCache } = req.body || {};
  const cacheKey = `pulse:assigned_expenses:${aeAcId}`;
  const now = Date.now();

  try {
    if (!bypassCache && _assignedExpensesMemoryCache && (now - _assignedExpensesCachedAt < 60000)) {
      return res.status(200).json({ success: true, assignedByClient: _assignedExpensesMemoryCache });
    }

    if (!bypassCache && redisClient?.isOpen) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          _assignedExpensesMemoryCache = parsed;
          _assignedExpensesCachedAt = now;
          return res.status(200).json({ success: true, assignedByClient: parsed });
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

    return res.status(200).json({ success: true, assignedByClient });
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
  const { masterSheetId, clientSheetId } = req.body;
  const sheetId = masterSheetId || clientSheetId;
  if (!sheetId) return res.status(400).json({ success: false, error: "Missing masterSheetId or clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(sheetId) || sheetId;
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

    return res.status(200).json({ success: true, inbox });
  } catch (err) {
    try { await setMasterSwitch(sheets, extractSheetIdFromUrl(req.body.masterSheetId || req.body.clientSheetId) || req.body.masterSheetId || req.body.clientSheetId, "DirComp", false); } catch(e) {}
    console.error("❌ get_outgoings_inbox error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetInvoicesInbox(req, res, sheets) {
  const { masterSheetId, clientSheetId } = req.body;
  const sheetId = masterSheetId || clientSheetId;
  if (!sheetId) return res.status(400).json({ success: false, error: "Missing masterSheetId or clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(sheetId) || sheetId;

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

    return res.status(200).json({ success: true, inbox });
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

    const pctValue = deliveryPct !== undefined && deliveryPct !== "" ? String(deliveryPct).replace(/%/g, "") : "100";
    const pctString = `${pctValue}%`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetIdClean,
      range: `Outgoings!A${newRow}:E${newRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[sanitizeFormulaInput(vendorName), vatFlag || "Yes", invTiming || "Next", payTiming || "Next", pctString]] },
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
  const { clientSheetId } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
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
      const blockRegex = /\{App ID:\s*([^}]+)\}\{Amt:\s*([^}]+)\}(?:\{Status:\s*([^}]*)\})?(?:\{Rec date:\s*([^}]*)\})?(?:\{Pay date:\s*([^}]*)\})?(?:\{Description:\s*([^}]*)\})?/g;
      let match;
      while ((match = blockRegex.exec(blockText)) !== null) {
        blocks.push({
          appId:       match[1]?.trim() || "",
          amount:      parseFloat(String(match[2] || "").replace(/[£$€,\s]/g, "")) || 0,
          status:      match[3]?.trim() || "",
          recDate:     match[4]?.trim() || "",
          payDate:     match[5]?.trim() || "",
          description: match[6]?.trim() || "",
        });
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

    return res.status(200).json({ success: true, contractors, months });
  } catch (err) {
    console.error("❌ get_outgoings error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetDirectCostsJobs(req, res, sheets) {
  const { clientSheetId, showAll } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
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
          daysToPay: colVal(row,base+3), status: colVal(row,base+4), highlighted: false };
      }),
      expenseSlots: [1,2,3].map(n => {
        const base = n === 1 ? 75 : n === 2 ? 82 : 89;
        return { slotNum: n, description: colVal(row,base), amount: colVal(row,base+1), vat: colVal(row,base+2),
          date: colVal(row,base+3), daysToPay: colVal(row,base+4), status: colVal(row,base+5),
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

      const startDate = parseSheetDate(row[37]);
      const passesFilter = showAll || (budgetNum > 0 && startDate && startDate >= sixMonthsAgo);
      if (passesFilter) {
        jobs.push({ client, jobName, projectCode: row[2] || "", rows: jobRows });
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

    return res.status(200).json({ success: true, jobs });
  } catch (err) {
    console.error("❌ get_direct_costs_jobs error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetInvoiceJobs(req, res, sheets) {
  const { clientSheetId, showAll } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
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
          daysToPay: colVal(row,base+3), status: colVal(row,base+4), highlighted: false };
      }),
      expenseSlots: [1,2,3].map(n => {
        const base = n === 1 ? 75 : n === 2 ? 82 : 89;
        return { slotNum: n, description: colVal(row,base), amount: colVal(row,base+1), vat: colVal(row,base+2),
          date: colVal(row,base+3), daysToPay: colVal(row,base+4), status: colVal(row,base+5),
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

    return res.status(200).json({ success: true, jobs });
  } catch (err) {
    console.error("❌ get_invoice_jobs error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetAllClientJobs(req, res, sheets) {
  const { clientSheetId, tabName = "All" } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

    let confRows = [];
    let pipeRows = [];
    let productLines = [];
    let leadSources = [];
    const notesBySheet = { Confirmed: [], Pipeline: [] };

    // Fetch cell notes in parallel with grid values
    const notesRanges = (tabName === "All" || !tabName)
      ? ["Confirmed!A1:CL1000", "Pipeline!A1:CL1000"]
      : [`${tabName}!A1:CL1000`];

    const fetchNotesPromise = sheets.spreadsheets.get({
      spreadsheetId: sheetIdClean,
      ranges: notesRanges,
      fields: "sheets(properties.title,data.rowData.values.note)",
    }).then((res) => {
      (res.data?.sheets || []).forEach((s) => {
        const title = s.properties?.title;
        if (title) {
          notesBySheet[title] = s.data?.[0]?.rowData || [];
        }
      });
    }).catch((err) => {
      console.warn("⚠️ get_all_client_jobs: could not fetch cell notes:", err?.message);
    });

    if (tabName === "All" || !tabName) {
      try {
        const batchResp = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: sheetIdClean,
          ranges: ["Confirmed!A1:DD5000", "Pipeline!A1:DD5000", "KeyInfo!C23:C26", "KeyInfo!G32:G75"],
          valueRenderOption: "FORMATTED_VALUE",
        });
        confRows = batchResp.data.valueRanges?.[0]?.values || [];
        pipeRows = batchResp.data.valueRanges?.[1]?.values || [];
        const plData = batchResp.data.valueRanges?.[2]?.values || [];
        const lsData = batchResp.data.valueRanges?.[3]?.values || [];
        productLines = plData.flat().map(v => String(v || "").trim()).filter(Boolean);
        leadSources = lsData.flat().map(v => String(v || "").trim()).filter(Boolean);
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
          ranges: ["KeyInfo!C23:C26", "KeyInfo!G32:G75"],
          valueRenderOption: "FORMATTED_VALUE"
        });
        const plData = keyInfoResp.data.valueRanges?.[0]?.values || [];
        const lsData = keyInfoResp.data.valueRanges?.[1]?.values || [];
        productLines = plData.flat().map(v => String(v || "").trim()).filter(Boolean);
        leadSources = lsData.flat().map(v => String(v || "").trim()).filter(Boolean);
      } catch (_) {}
    }

    // Await cell notes fetch if still in flight
    await fetchNotesPromise;

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
          status: colVal(row, base + 4),
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
          status: colVal(row, base + 5),
          transactionId: colVal(row, base + 6),
          highlighted: false,
          note: getNote(currentTab, rowNum, base)
        };
      }),
    });

    const parseTabJobs = (rows, currentTab) => {
      const tabJobs = [];
      let ri = currentTab === "Pipeline" ? 5 : 1; 
      while (ri < rows.length) {
        const row = rows[ri] || [];
        const client = String(row[0] || "").trim();
        const jobName = String(row[1] || "").trim();
        if (!client && !jobName) { ri++; continue; }

        const parentRowNum = ri + 1;
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

    return res.status(200).json({ success: true, jobs, productLines, leadSources, existingClients });
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
    const targetRow = rowNum || cellRef.replace(/[^0-9]/g, "");

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

    return res.status(200).json({
      success: true,
      placed,
      newRowNum: createNewRow ? currRowNum : undefined,
      newRowsCreated: knownJobRows.length > (Array.isArray(jobRows) ? jobRows.length : 1)
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

    let actualRowNum = parseInt(rowNum, 10);
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

    return res.status(200).json({ success: true });
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
      rowShifted: targetRowNum !== rowNum
    });
  } catch (err) {
    console.error("❌ assign_invoice_to_job error:", err);
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

    let actualRowNum = parseInt(rowNum, 10);
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
        } else if (ref2 === cleanTargetRef) {
          actualSlotNum = 2;
        } else if (ref3 === cleanTargetRef) {
          actualSlotNum = 3;
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
            if (r1 === cleanTargetRef) { actualRowNum = r + 1; actualSlotNum = 1; break; }
            if (r2 === cleanTargetRef) { actualRowNum = r + 1; actualSlotNum = 2; break; }
            if (r3 === cleanTargetRef) { actualRowNum = r + 1; actualSlotNum = 3; break; }
          }
        }
      } catch (scanErr) {
        console.warn("Invoice slot ref verification check skipped:", scanErr.message);
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
          invoice.status || "",
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

    return res.status(200).json({ success: true });
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

    const confirmedResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:AM5000",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const confirmedRows = confirmedResp.data.values || [];
    let lastDataRow = 1;
    for (let i = confirmedRows.length - 1; i >= 1; i--) {
      const r = confirmedRows[i] || [];
      if (r[0] || r[1] || r[32] || r[37]) { lastDataRow = i + 1; break; }
    }
    const newRow = lastDataRow + 1;

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
          { range: `Confirmed!A${newRow}`,  values: [[invoice.client || ""]] },
          { range: `Confirmed!B${newRow}`,  values: [[jobName || invoice.job || ""]] },
          { range: `Confirmed!C${newRow}`,  values: [[projectCode || ""]] },
          { range: `Confirmed!AG${newRow}`, values: [[revenue || invoice.amount || 0]] },
          { range: `Confirmed!AH${newRow}`, values: [[directCosts || 0]] },
          { range: `Confirmed!AI${newRow}`, values: [[vatYesNo || (invoice.vatAmount > 0 ? "Yes" : "No")]] },
          { range: `Confirmed!AJ${newRow}`, values: [[projectType || "Project"]] },
          { range: `Confirmed!AP${newRow}`, values: [[invoice.amount || 0]] },
          { range: `Confirmed!AQ${newRow}`, values: [[invoice.invoiceNo || ""]] },
          { range: `Confirmed!AS${newRow}`, values: [[daysToPay]] },
          { range: `Confirmed!AT${newRow}`, values: [[invoice.status || "Sent"]] },
        ],
      },
    });

    const dateFieldsToWrite = [
      { col: "AL", raw: startDate || invoice.sentDate },
      { col: "AM", raw: endDate || invoice.dueDate },
      { col: "AR", raw: invoice.sentDate },
    ];
    const dateWriteData = [];
    for (const f of dateFieldsToWrite) {
      if (!f.raw) continue;
      const formatted = toSheetDateFormat(f.raw);
      if (formatted) {
        dateWriteData.push({ range: `Confirmed!${f.col}${newRow}`, values: [[formatted]] });
      }
    }
    if (dateWriteData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
      });
    }

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
      { range: `${targetTab}!D${targetRow}`,  values: [[formatSheetDate(jobData.dateConfirmed || jobData.dateAdded)]] },
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
        const days = parseInt(inv.daysToPay, 10) || 30;
        const st = sanitizeFormulaInput(inv.status || "");
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
        const dp = parseInt(exp.daysToPay, 10) || 30;
        const st = sanitizeFormulaInput(exp.status || "");
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
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        requests: [{
          updateCells: {
            range: {
              sheetId: await getSheetGid(sheets, sheetIdClean, "Outgoings"),
              startRowIndex: rowIndex,
              endRowIndex: rowIndex + 1,
              startColumnIndex: colIndex,
              endColumnIndex: colIndex + 1,
            },
            rows: [{ values: [{ note: noteStr }] }],
            fields: "note",
          },
        }],
      },
    });

    console.log(`  ✅ Outgoings note updated: ${cellRef}`);

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
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
  const { clientSheetId: pullClientSheetId, masterSheetId: pullMasterSheetId } = req.body;
  if (!pullClientSheetId || !pullMasterSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId or masterSheetId" });
  try {
    const pullClientIdClean = extractSheetIdFromUrl(pullClientSheetId) || pullClientSheetId;
    const pullMasterIdClean = extractSheetIdFromUrl(pullMasterSheetId) || pullMasterSheetId;
    const gasResp = await fetch("https://script.google.com/macros/s/AKfycbzVvLSDtqWj3aHcn0UV9VPCybNm82sBNWynMo1-bMpvs3NzerPZXWkrpPJvVHaqDwwy/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refreshOutgoings", clientSheetId: pullClientIdClean, masterSheetId: pullMasterIdClean }),
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
  
  if (!pipeClientSheetId || !pipelineRow) {
    return res.status(400).json({ success: false, error: "Missing clientSheetId or pipelineRow" });
  }
  
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: pipeClientSheetId,
      range: `Pipeline!DD${pipelineRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [["Yes"]] },
    });
    
    console.log(`  ✅ mark_pipeline_copied: wrote Yes to Pipeline!DD${pipelineRow}`);
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
  const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

  try {
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
      action: "JOB_DELETED",
      summary: `Deleted job "${endClientName ? `${endClientName} - ` : ""}${jobName || "Job"}" from ${targetTab} (cleared ${rowNums.length} row${rowNums.length === 1 ? "" : "s"}: ${rowNums.join(", ")})`,
      details: {
        jobName,
        endClientName,
        tabName: targetTab,
        clearedRows: rowNums,
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true });
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
      for (const u of updates) {
        if (u.cellRef && u.value !== undefined) {
          batchData.push({
            range: `Pipeline!${u.cellRef}`,
            values: [[u.value]],
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