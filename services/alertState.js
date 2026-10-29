import { redisClient } from "./redisClient.js";
import { getSheetsClient, extractSheetIdFromUrl, sanitizeFormulaInput } from "./sheetsClient.js";
import {
  readAlertMemory, updateAlertMemoryRow, updateAlertMemoryRowsBatch, appendAlertMemoryRow, appendAlertMemoryRowsBatch,
  ensureAlertMemoryTab, findMemoryRow, buildAlertFingerprint,
  extractCrmComparisonSnapshot, deleteAlertMemoryRows, updateHandledAlertHash
} from "./alertMemory.js";
import { createHash } from "crypto";
import { logPmaActivity } from "./pmaLogger.js";
import { getSessionUser } from "./authService.js";
import { isUserAuthorizedForClient, canAccessPma } from "./userPermissions.js";
import { matchesClientName, ADMIN_ONLY_ALERT_TYPES, toSheetDateFormat } from "../utils/helpers.js";
import { getAllClients } from "./workspaces.js";

const PRECOMPUTED_KEY = "triage_precomputed";

export async function handleBustCache(req, res, sheets) {
  const { fingerprintHash, rowNumber, sheetName, automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  const sessionUser = getSessionUser(req, res);
  if (!req.isSystemAuthorized && (!sessionUser || (!sessionUser.isAdmin && !canAccessPma(sessionUser)))) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  try {
    const memoryRows = await readAlertMemory(sheets, acId);
    let row = null;
    if (fingerprintHash) {
      row = findMemoryRow(memoryRows, fingerprintHash);
    } else if (rowNumber && sheetName) {
      row = memoryRows.find(r => r.status === "cached" && r.cachedOptionsJSON && r.alertSummary?.includes(String(rowNumber)));
    }
    if (!row) return res.status(404).json({ success: false, error: "Alert not found in AlertMemory" });
    if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, row.clientName)) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client." });
    }
    await updateAlertMemoryRow(sheets, acId, row.rowIndex, { ...row, cachedOptionsJSON: "" });
    console.log(`  ✅ Cache cleared for row ${row.rowIndex} (${row.fingerprintHash})`);
    return res.status(200).json({ success: true, ...(sessionUser?.isAdmin ? { fingerprintHash: row.fingerprintHash } : {}) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetAlerts(req, res) {
  const { sessionId } = req.query;
  console.log(`\n🔍 get_alerts request: sessionId=${sessionId}`);
  if (!sessionId) return res.status(400).json({ success: false, error: "Missing sessionId" });
  try {
    const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
    if (!sessionData) return res.status(404).json({ success: false, error: "Session not found" });
    let { alerts, noActionAlerts, proactiveAlerts, clientsWithFlags, resolvedNoActionFlags } = JSON.parse(sessionData);
    
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
    }
    if (!sessionUser.isAdmin) {
      const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      const isAllowedAlert = (a) =>
        assignedList.some(assigned => matchesClientName(assigned, a.clientName)) &&
        !ADMIN_ONLY_ALERT_TYPES.has(a.alertType || a.flagType || a.type);
      alerts = (alerts || []).filter(isAllowedAlert);
      noActionAlerts = (noActionAlerts || []).filter(isAllowedAlert);
      proactiveAlerts = (proactiveAlerts || []).filter(isAllowedAlert);
      clientsWithFlags = (clientsWithFlags || []).filter(c => assignedList.some(assigned => matchesClientName(assigned, c.clientName)));
      resolvedNoActionFlags = (resolvedNoActionFlags || []).filter(f => assignedList.some(assigned => matchesClientName(assigned, f?.clientName)));
    }

    console.log(`✅ Retrieved ${(alerts || []).length} alerts from Redis for session ${sessionId}`);
    return res.status(200).json({
      success: true, alerts: alerts || [], noActionAlerts: noActionAlerts || [], proactiveAlerts: proactiveAlerts || [],
      clientsWithFlags: clientsWithFlags || [], resolvedNoActionFlags: resolvedNoActionFlags || [],
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export function applyAlertRemovalToTriageData(data, targetIds, allowedClientCheck = null) {
  if (!data) return { removedCount: 0 };
  const targetList = Array.isArray(targetIds) ? targetIds : Array.from(targetIds || []);
  const targetSet = new Set(targetList.map(String));
  const canRemove = (item) => !allowedClientCheck || allowedClientCheck(item?.clientName);
  
  const removedAlerts = [];
  const keptAlerts = [];
  for (const a of (data.alerts || [])) {
    const isTarget = canRemove(a) && (
      targetSet.has(`${a.sheetName}-${a.rowNumber}`)
      || (a.fingerprintHash && targetSet.has(a.fingerprintHash))
      || (a.id && targetSet.has(a.id))
      || targetSet.has(`${a.flagType || a.type}-${a.sheetName}-${a.rowNumber}`)
    );
    if (isTarget) removedAlerts.push(a);
    else keptAlerts.push(a);
  }

  const removedNoAction = [];
  const keptNoAction = [];
  for (const na of (data.noActionAlerts || [])) {
    const isTarget = canRemove(na) && (
      (na.fingerprintHash && targetSet.has(na.fingerprintHash))
      || (na.id && targetSet.has(na.id))
      || targetSet.has(`${na.flagType}-${na.flagDetail || ""}`)
      || targetSet.has(`${na.clientName}___${na.flagType}`)
    );
    if (isTarget) removedNoAction.push(na);
    else keptNoAction.push(na);
  }

  const removedProactive = [];
  const keptProactive = [];
  for (const pa of (data.proactiveAlerts || [])) {
    const isTarget = canRemove(pa) && (
      (pa.alertKey && targetSet.has(pa.alertKey))
      || (pa.fingerprintHash && targetSet.has(pa.fingerprintHash))
      || (pa.rowIndex != null && targetSet.has(String(pa.rowIndex)))
    );
    if (isTarget) removedProactive.push(pa);
    else keptProactive.push(pa);
  }

  const totalRemoved = removedAlerts.length + removedNoAction.length + removedProactive.length;
  if (totalRemoved === 0) return { removedCount: 0 };

  data.alerts = keptAlerts;
  data.noActionAlerts = keptNoAction;
  data.proactiveAlerts = keptProactive;
  if (data.totalAlerts != null) data.totalAlerts = keptAlerts.length;
  if (data.noActionCount != null) data.noActionCount = keptNoAction.length;

  const removedCountsByClientFlag = {};
  for (const a of [...removedAlerts, ...removedNoAction]) {
    const cName = a.clientName;
    if (!cName) continue;
    let flagKey = a.flagType || a.alertType || a.type;
    if (flagKey === "invoice") flagKey = "invoiceDashboardDiscr";
    if (flagKey === "expense") flagKey = "expenseDashboardDiscr";
    if (flagKey === "crm") flagKey = a.alertType || "crmPipeAppDiscr";
    if (!removedCountsByClientFlag[cName]) removedCountsByClientFlag[cName] = {};
    removedCountsByClientFlag[cName][flagKey] = (removedCountsByClientFlag[cName][flagKey] || 0) + 1;
  }

  if (data.clientsWithFlags) {
    data.clientsWithFlags = data.clientsWithFlags.map(c => {
      const clientRemovals = removedCountsByClientFlag[c.clientName];
      if (!clientRemovals) return c;
      const updatedCounts = { ...(c.alertCounts || {}) };
      const updatedFlags = { ...(c.flags || {}) };
      for (const [fKey, countRemoved] of Object.entries(clientRemovals)) {
        if (updatedCounts[fKey] != null) {
          updatedCounts[fKey] = Math.max(0, updatedCounts[fKey] - countRemoved);
          if (updatedCounts[fKey] === 0) {
            updatedFlags[fKey] = false;
          }
        }
      }
      return { ...c, alertCounts: updatedCounts, flags: updatedFlags };
    });
  }

  return { removedCount: totalRemoved };
}

export async function handleRemoveAlert(req, res) {
  const { sessionId, alertId, alertIds } = req.body;
  const targetIds = Array.isArray(alertIds) ? alertIds : (alertId ? [alertId] : []);
  if (!sessionId || !targetIds.length) return res.status(400).json({ success: false, error: "Missing sessionId or alertId(s)" });
  const sessionUser = getSessionUser(req);
  const allowedClientCheck = (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin)
    ? (cName) => Boolean(cName && isUserAuthorizedForClient(sessionUser, cName))
    : null;
  try {
    const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
    if (!sessionData) return res.status(200).json({ success: true, notFound: true });
    const parsed = JSON.parse(sessionData);
    
    const { removedCount } = applyAlertRemovalToTriageData(parsed, targetIds, allowedClientCheck);
    await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });

    try {
      const preRaw = await redisClient.get(PRECOMPUTED_KEY);
      if (preRaw) {
        const pre = JSON.parse(preRaw);
        applyAlertRemovalToTriageData(pre, targetIds, allowedClientCheck);
        await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
      }
    } catch (e) {
      console.warn("Could not sync PRECOMPUTED_KEY in handleRemoveAlert:", e.message);
    }

    return res.status(200).json({ success: true, removed: removedCount });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateSessionFlags(req, res) {
  const { sessionId, clientName, clearedFlagKeys } = req.body;
  if (!sessionId || !clientName || !clearedFlagKeys) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    const keysToZero = new Set(clearedFlagKeys);
    const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
    if (sessionData) {
      const parsed = JSON.parse(sessionData);
      parsed.alerts = parsed.alerts.filter(a => { if (a.clientName !== clientName) return true; return !keysToZero.has(a.flagType || a.type); });
      if (parsed.noActionAlerts) {
        parsed.noActionAlerts = parsed.noActionAlerts.filter(na => {
          if (na.clientName && na.clientName !== clientName) return true;
          const targetClientId = (parsed.clientsWithFlags || []).find(c => c.clientName === clientName)?.masterSheetId;
          if (!na.clientName && na.clientId !== targetClientId) return true; 
          return !keysToZero.has(na.flagType);
        });
      }
      if (parsed.clientsWithFlags) {
        parsed.clientsWithFlags = parsed.clientsWithFlags.map(c => {
          if (c.clientName !== clientName) return c;
          const updatedFlags = { ...c.flags };
          keysToZero.forEach(k => { updatedFlags[k] = false; });
          return { ...c, flags: updatedFlags };
        });
      }
      await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 3600 });
    }
    const precomputed = await redisClient.get(PRECOMPUTED_KEY);
    if (precomputed) {
      const parsed = JSON.parse(precomputed);
      parsed.alerts = (parsed.alerts || []).filter(a => { if (a.clientName !== clientName) return true; return !keysToZero.has(a.flagType || a.type); });
      if (parsed.noActionAlerts) {
        parsed.noActionAlerts = parsed.noActionAlerts.filter(na => {
          if (na.clientName && na.clientName !== clientName) return true;
          const precompTargetClientId = (parsed.clientsWithFlags || []).find(c => c.clientName === clientName)?.masterSheetId;
          if (!na.clientName && na.clientId !== precompTargetClientId) return true;
          return !keysToZero.has(na.flagType);
        });
      }
      if (parsed.clientsWithFlags) {
        parsed.clientsWithFlags = parsed.clientsWithFlags.map(c => {
          if (c.clientName !== clientName) return c;
          const updatedFlags = { ...c.flags };
          keysToZero.forEach(k => { updatedFlags[k] = false; });
          return { ...c, flags: updatedFlags };
        });
      }
      parsed.totalAlerts = (parsed.alerts || []).length;
      parsed.noActionCount = (parsed.noActionAlerts || []).length;
      if (parsed.noActionAnalysisResults) {
        const richFlags = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete", "retainerInvoicesCreated", "retainerInvoicesDeleted", "invoiceStaleUnsentChanges"];
        richFlags.forEach(flagType => { if (keysToZero.has(flagType)) delete parsed.noActionAnalysisResults[`${clientName}___${flagType}`]; });
      }
      await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(parsed), { EX: 86400 * 7 });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleResolveNoActionFlag(req, res, sheets) {
  const { sessionId, clientName, flagType, fingerprintHash, automationCommanderSheetId: acIdResolve } = req.body;
  if (!sessionId || !clientName || !flagType) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
    if (!sessionData) return res.status(200).json({ success: true, notFound: true });
    const parsed = JSON.parse(sessionData);
    if (!parsed.resolvedNoActionFlags) parsed.resolvedNoActionFlags = [];
    const resolvedId = fingerprintHash || flagType;
    const key = `${clientName}___${resolvedId}`;
    if (!parsed.resolvedNoActionFlags.includes(key)) parsed.resolvedNoActionFlags.push(key);
    await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });

    if (acIdResolve) {
      try {
        const acIdClean = extractSheetIdFromUrl(acIdResolve) || acIdResolve;
        const memoryRows = await readAlertMemory(sheets, acIdClean);
        const toAccept = memoryRows.filter(r => {
          if (r.clientName !== clientName || r.alertType !== flagType || r.status !== "cached") return false;
          if (fingerprintHash) return r.fingerprintHash === fingerprintHash;
          return true; 
        });
        for (const row of toAccept) {
          await updateAlertMemoryRow(sheets, acIdClean, row.rowIndex, { ...row, status: "accepted" });
        }
      } catch (amErr) {}
    }

    const flagCat = (() => {
      const t = String(flagType || "").toLowerCase();
      if (t.includes("inv")) return "INVOICES";
      if (t.includes("exp") || t.includes("dir") || t.includes("cost") || t.includes("vendor") || t.includes("out")) return "EXPENSES";
      if (t.includes("crm")) return "CRM";
      if (t.includes("ret")) return "RETAINER";
      if (t.includes("job") || t.includes("sal")) return "JOB";
      return "TRIAGE";
    })();

    logPmaActivity(sheets, {
      automationCommanderSheetId: acIdResolve,
      clientName,
      category: flagCat,
      action: "Flag Resolved",
      summary: `Resolved flag: ${flagType} for ${clientName}`,
      details: { flagType, fingerprintHash, clientName }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleBulkResolveNoActionFlags(req, res, sheets) {
  const { sessionId, clientName, flags = [], clearedFlagKeys = [], automationCommanderSheetId: acIdResolve } = req.body;
  if (!sessionId || !clientName) return res.status(400).json({ success: false, error: "Missing required fields" });
  if (!Array.isArray(flags) || flags.length === 0) return res.status(200).json({ success: true, count: 0 });

  try {
    const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
    if (sessionData) {
      const parsed = JSON.parse(sessionData);
      if (!parsed.resolvedNoActionFlags) parsed.resolvedNoActionFlags = [];

      for (const flag of flags) {
        const resolvedId = flag.fingerprintHash || flag.flagType;
        const key = `${clientName}___${resolvedId}`;
        if (!parsed.resolvedNoActionFlags.includes(key)) {
          parsed.resolvedNoActionFlags.push(key);
        }
      }

      if (clearedFlagKeys.length > 0) {
        const keysToZero = new Set(clearedFlagKeys);
        if (parsed.alerts) {
          parsed.alerts = parsed.alerts.filter(a => {
            if (a.clientName !== clientName) return true;
            return !keysToZero.has(a.flagType || a.type);
          });
        }
        if (parsed.noActionAlerts) {
          parsed.noActionAlerts = parsed.noActionAlerts.filter(na => {
            if (na.clientName && na.clientName !== clientName) return true;
            const targetClientId = (parsed.clientsWithFlags || []).find(c => c.clientName === clientName)?.masterSheetId;
            if (!na.clientName && na.clientId !== targetClientId) return true;
            return !keysToZero.has(na.flagType);
          });
        }
        if (parsed.clientsWithFlags) {
          parsed.clientsWithFlags = parsed.clientsWithFlags.map(c => {
            if (c.clientName !== clientName) return c;
            const updatedFlags = { ...c.flags };
            keysToZero.forEach(k => { updatedFlags[k] = false; });
            return { ...c, flags: updatedFlags };
          });
        }
      }

      await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });
    }

    if (clearedFlagKeys.length > 0) {
      try {
        const keysToZero = new Set(clearedFlagKeys);
        const precomputed = await redisClient.get(PRECOMPUTED_KEY);
        if (precomputed) {
          const parsed = JSON.parse(precomputed);
          parsed.alerts = (parsed.alerts || []).filter(a => { if (a.clientName !== clientName) return true; return !keysToZero.has(a.flagType || a.type); });
          if (parsed.noActionAlerts) {
            parsed.noActionAlerts = parsed.noActionAlerts.filter(na => {
              if (na.clientName && na.clientName !== clientName) return true;
              const precompTargetClientId = (parsed.clientsWithFlags || []).find(c => c.clientName === clientName)?.masterSheetId;
              if (!na.clientName && na.clientId !== precompTargetClientId) return true;
              return !keysToZero.has(na.flagType);
            });
          }
          if (parsed.clientsWithFlags) {
            parsed.clientsWithFlags = parsed.clientsWithFlags.map(c => {
              if (c.clientName !== clientName) return c;
              const updatedFlags = { ...c.flags };
              keysToZero.forEach(k => { updatedFlags[k] = false; });
              return { ...c, flags: updatedFlags };
            });
          }
          parsed.totalAlerts = (parsed.alerts || []).length;
          parsed.noActionCount = (parsed.noActionAlerts || []).length;
          if (parsed.noActionAnalysisResults) {
            const richFlags = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete", "retainerInvoicesCreated", "retainerInvoicesDeleted", "invoiceStaleUnsentChanges"];
            richFlags.forEach(flagType => { if (keysToZero.has(flagType)) delete parsed.noActionAnalysisResults[`${clientName}___${flagType}`]; });
          }
          await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(parsed), { EX: 86400 * 7 });
        }
      } catch (preErr) {
        console.warn("⚠️ Failed updating PRECOMPUTED_KEY in handleBulkResolveNoActionFlags:", preErr.message);
      }
    }

    if (acIdResolve) {
      try {
        const acIdClean = extractSheetIdFromUrl(acIdResolve) || acIdResolve;
        const memoryRows = await readAlertMemory(sheets, acIdClean);
        const hashesSet = new Set(flags.map(f => f.fingerprintHash).filter(Boolean));
        const flagTypesSet = new Set(flags.map(f => f.flagType).filter(Boolean));

        const toAccept = memoryRows.filter(r => {
          if (r.clientName !== clientName || r.status !== "cached") return false;
          if (r.fingerprintHash && hashesSet.has(r.fingerprintHash)) return true;
          if (!r.fingerprintHash && flagTypesSet.has(r.alertType)) return true;
          return false;
        });

        if (toAccept.length > 0) {
          const updateItems = toAccept.map(row => ({
            rowIndex: row.rowIndex,
            updates: { ...row, status: "accepted" },
          }));
          await updateAlertMemoryRowsBatch(sheets, acIdClean, updateItems);
        }
      } catch (amErr) {
        console.warn("⚠️ AlertMemory update error in handleBulkResolveNoActionFlags:", amErr.message);
      }
    }

    logPmaActivity(sheets, {
      automationCommanderSheetId: acIdResolve,
      clientName,
      category: "TRIAGE",
      action: "Flags Resolved",
      summary: `Resolved ${flags.length} flag${flags.length > 1 ? "s" : ""} for ${clientName}`,
      details: { count: flags.length, clientName }
    });

    return res.status(200).json({ success: true, count: flags.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleRecordDecision(req, res, sheets) {
  const { alert, decision, automationCommanderSheetId } = req.body;
  if (!alert || !decision || !automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing alert, decision, or acId" });
  const sessionUser = getSessionUser(req, res);
  if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
    if (!alert.clientName || !isUserAuthorizedForClient(sessionUser, alert.clientName)) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client." });
    }
  }
  const canRemoveClient = (cName) => req.isSystemAuthorized || !sessionUser || sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, cName);
  try {
    const timestamp = new Date().toISOString();
    const alertAmount = alert.summary?.amount || alert.data?.amount || alert.data?.revenue || "";
    const logRow = [
      timestamp,
      sanitizeFormulaInput(String(alert.type || alert.flagType || "")),
      sanitizeFormulaInput(`${alert.sheetName}-${alert.rowNumber}`),
      sanitizeFormulaInput(String(alert.clientName || "")),
      sanitizeFormulaInput(String(alertAmount)),
      sanitizeFormulaInput(JSON.stringify(decision.claudeRecommendation || {})),
      sanitizeFormulaInput(String(decision.action || "")),
      sanitizeFormulaInput(String(decision.notes || "")),
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId, range: "TriageLog!A:H", valueInputOption: "USER_ENTERED",
      requestBody: { values: [logRow] },
    });

    if (decision.action === "ACCEPTED") {
      try {
        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const memRows = await readAlertMemory(sheets, automationCommanderSheetId);
        const fp = alert.fingerprintHash || buildAlertFingerprint(alert);
        const mr = findMemoryRow(memRows, fp);
        const alertSummary = alert.summary?.summary || `${alert.type || alert.flagType || "alert"} ${alert.summary?.invoiceNo || alert.summary?.description || ""} £${alert.summary?.amount || ""}`.trim();
        const isMrClientMatch = mr && (
          (req.isSystemAuthorized || !sessionUser || sessionUser.isAdmin)
            ? (!mr.clientName || !alert.clientName || matchesClientName(alert.clientName, mr.clientName))
            : (mr.clientName && alert.clientName && matchesClientName(alert.clientName, mr.clientName))
        );
        if (mr && isMrClientMatch) {
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, mr.rowIndex, { ...mr, status: "accepted" });
        } else if (!mr) {
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
            fingerprintHash: fp,
            alertType: alert.type || alert.flagType || "unknown",
            clientName: alert.clientName || "",
            alertSummary,
            cachedOptionsJSON: "",
            status: "accepted",
            ignoreReason: "",
            dataSnapshot: "",
          });
        }
        await updateHandledAlertHash(automationCommanderSheetId, fp, "accepted");
      } catch (memErr) {
        console.warn(`  ⚠️ Could not update AlertMemory in handleRecordDecision: ${memErr.message}`);
      }

      try {
        const fp = alert.fingerprintHash || buildAlertFingerprint(alert);
        const alertId = `${alert.sheetName}-${alert.rowNumber}`;
        const txnId = alert.summary?.transactionId || alert.summary?.appId || "";
        const targetIds = [alertId, fp, `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`, txnId].filter(Boolean);

        const preRaw = await redisClient?.get(PRECOMPUTED_KEY);
        if (preRaw) {
          const pre = JSON.parse(preRaw);
          applyAlertRemovalToTriageData(pre, targetIds, canRemoveClient);
          await redisClient?.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
        }
        if (req.body.sessionId) {
          const sRaw = await redisClient?.get(`triage_alerts:${req.body.sessionId}`);
          if (sRaw) {
            const sData = JSON.parse(sRaw);
            applyAlertRemovalToTriageData(sData, targetIds, canRemoveClient);
            await redisClient?.set(`triage_alerts:${req.body.sessionId}`, JSON.stringify(sData), { EX: 86400 * 7 });
          }
        }
      } catch (rErr) {
        console.warn(`  ⚠️ Could not sync Redis in handleRecordDecision: ${rErr.message}`);
      }
    }

    return res.status(200).json({ success: true, message: "Decision recorded" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleIgnoreAlert(req, res, sheets) {
  const { alert, automationCommanderSheetId } = req.body;
  if (!alert || !automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing alert or acId" });
  
  // Wrap the single alert in an array and reuse the bulk ignore logic
  req.body.alerts = [alert];
  return handleBulkIgnoreAlerts(req, res, sheets);
}

export async function handleBulkIgnoreAlerts(req, res, sheets) {
  const { alerts: alertsToIgnore, ignoreReason, automationCommanderSheetId: acId } = req.body;
  if (!alertsToIgnore?.length || !acId) return res.status(400).json({ success: false, error: "Missing alerts or acId" });
  const sessionUser = getSessionUser(req, res);
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const rowsToAppend = [];
    const rowsToUpdate = [];

    for (const alert of alertsToIgnore) {
      if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin && (!alert?.clientName || !isUserAuthorizedForClient(sessionUser, alert.clientName))) {
        return res.status(403).json({ success: false, error: "Forbidden: Not authorized for one or more alerts in batch." });
      }
      const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);
      const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
      if (memoryRow && !req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin && (!memoryRow.clientName || !isUserAuthorizedForClient(sessionUser, memoryRow.clientName))) {
        return res.status(403).json({ success: false, error: "Forbidden: Target AlertMemory row belongs to an unauthorized client." });
      }
      const alertSummary = alert.summary?.summary || `${alert.type || "alert"} ${alert.summary?.invoiceNo || ""} £${alert.summary?.amount || ""}`.trim();
      const crmIdentitySnap = alert.type === "crm" ? extractCrmComparisonSnapshot(alert) : null;
      const dataSnapshot = JSON.stringify({
        alertType:  alert.type || alert.flagType || "", invoiceNo:  alert.summary?.invoiceNo || "",
        amount:     String(alert.summary?.amount || ""), vatIncluded: String(alert.summary?.vatIncluded || ""),
        status:     String(alert.summary?.status || ""), sentDate:   String(alert.summary?.sentDate || ""),
        datePaid:   String(alert.summary?.datePaid || ""), client:     String(alert.summary?.client || ""),
        job:        String(alert.summary?.job || ""), flagType:   alert.flagType || "",
        masterSheetId: alert.masterSheetId || "", crmJobName:    crmIdentitySnap?.jobName    || "",
        crmEndClient:  crmIdentitySnap?.clientName || "", crmFields:     crmIdentitySnap?.fields     || null,
      });
      if (memoryRow && (!memoryRow.clientName || !alert.clientName || matchesClientName(alert.clientName, memoryRow.clientName))) {
        rowsToUpdate.push({ rowIndex: memoryRow.rowIndex, row: { ...memoryRow, status: "ignored", ignoreReason: ignoreReason || "", dataSnapshot } });
      } else {
        rowsToAppend.push({ fingerprintHash, alertType: alert.type || alert.flagType || "unknown",
          clientName: alert.clientName || "", alertSummary, cachedOptionsJSON: "",
          status: "ignored", ignoreReason: ignoreReason || "", dataSnapshot });
      }
    }
    if (rowsToUpdate.length > 0) {
      await updateAlertMemoryRowsBatch(sheets, acId, rowsToUpdate.map(u => ({ rowIndex: u.rowIndex, updates: u.row })));
    }
    if (rowsToAppend.length > 0) {
      await appendAlertMemoryRowsBatch(sheets, acId, rowsToAppend);
    }

    const firstAlert = alertsToIgnore[0];
    const alertCat = (() => {
      const t = String(firstAlert?.type || firstAlert?.flagType || "").toLowerCase();
      if (t.includes("inv")) return "INVOICES";
      if (t.includes("exp") || t.includes("dir") || t.includes("cost") || t.includes("vendor") || t.includes("out")) return "EXPENSES";
      if (t.includes("crm")) return "CRM";
      if (t.includes("ret")) return "RETAINER";
      return "TRIAGE";
    })();

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: firstAlert?.clientName || "",
      category: alertCat,
      action: "Alert(s) Ignored",
      summary: `Ignored ${alertsToIgnore.length} alert${alertsToIgnore.length > 1 ? "s" : ""} (${firstAlert?.clientName || "Client"}): ${ignoreReason || "No reason specified"}`,
      details: { count: alertsToIgnore.length, ignoreReason, clientName: firstAlert?.clientName }
    });

    return res.status(200).json({ success: true, count: alertsToIgnore.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleAcknowledgeProactiveAlert(req, res, sheets) {
  const { alertKey, clientName, sessionId, automationCommanderSheetId: acId, alertData } = req.body;
  if (!alertKey || !acId) return res.status(400).json({ success: false, error: "Missing alertKey or automationCommanderSheetId" });
  const sessionUser = getSessionUser(req);
  if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
    if (!clientName || !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client." });
    }
  }
  try {
    const fingerprintHash = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const candidateMatches = memoryRows.filter(r => {
      if (clientName && r.clientName !== clientName) return false;
      if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, r.clientName)) return false;
      if (r.fingerprintHash === fingerprintHash) return true;
      if (alertKey.startsWith("autolog_error|") || alertKey.startsWith("infinite_loop|")) {
        try {
          const s = JSON.parse(r.dataSnapshot || "{}");
          const k = s.alertKey || s.legacyAlertKey || "";
          if (k === alertKey || k === alertData?.legacyAlertKey) return true;
          if (k.startsWith(alertKey + "|")) return true;
        } catch(e) { return false; }
      }
      return false;
    });

    if (candidateMatches.length > 0) {
      const primaryRow = candidateMatches[0];
      let snap = {};
      try { snap = JSON.parse(primaryRow.dataSnapshot || "{}"); } catch(e) {}
      if (alertData) snap = { ...snap, ...alertData };
      await updateAlertMemoryRow(sheets, acId, primaryRow.rowIndex, { 
        ...primaryRow, 
        fingerprintHash,
        status: "accepted", 
        clientName: clientName || primaryRow.clientName || "",
        dataSnapshot: JSON.stringify(snap)
      });
      for (const dup of candidateMatches.slice(1)) {
        await updateAlertMemoryRow(sheets, acId, dup.rowIndex, {
          ...dup,
          status: "superseded"
        });
      }
    } else {
      const snapStr = alertData ? JSON.stringify(alertData) : "";
      await appendAlertMemoryRow(sheets, acId, {
        fingerprintHash, alertType: "proactive", clientName: clientName || "", alertSummary: "Acknowledged proactive alert",
        cachedOptionsJSON: "", status: "accepted", ignoreReason: "", dataSnapshot: snapStr
      });
    }

    const canRemoveClient = (cName) => req.isSystemAuthorized || !sessionUser || sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, cName);
    if (sessionId) {
      try {
        const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
        if (sessionData) {
          const parsed = JSON.parse(sessionData);
          applyAlertRemovalToTriageData(parsed, [alertKey, fingerprintHash], canRemoveClient);
          await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });
        }
      } catch (e) {}
    }
    try {
      const preRaw = await redisClient.get(PRECOMPUTED_KEY);
      if (preRaw) {
        const pre = JSON.parse(preRaw);
        applyAlertRemovalToTriageData(pre, [alertKey, fingerprintHash], canRemoveClient);
        await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
      }
    } catch (e) {}

    const alertCat = (() => {
      const t = String(alertKey || "").toLowerCase();
      if (t.includes("inv")) return "INVOICES";
      if (t.includes("exp") || t.includes("dir") || t.includes("cost") || t.includes("vendor") || t.includes("out")) return "EXPENSES";
      if (t.includes("crm")) return "CRM";
      if (t.includes("ret")) return "RETAINER";
      return "TRIAGE";
    })();

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: clientName || "",
      category: alertCat,
      action: "Proactive Alert Acknowledged",
      summary: `Acknowledged proactive alert (${alertKey}) for ${clientName || "Client"}`,
      details: { alertKey, clientName }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleResolveProactiveAlert(req, res, sheets) {
  const { alertKey, clientName, sessionId, resolution, automationCommanderSheetId: acId } = req.body;
  if (!alertKey || !acId) return res.status(400).json({ success: false, error: "Missing alertKey or automationCommanderSheetId" });
  const sessionUser = getSessionUser(req);
  if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
    if (!clientName || !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client." });
    }
  }
  try {
    const fingerprintHash = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const row = findMemoryRow(memoryRows, fingerprintHash);
    if (row && !req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, row.clientName)) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client's alert." });
    }
    
    if (row) {
      let snap = row.dataSnapshot;
      try {
        const parsed = JSON.parse(snap || "{}");
        parsed.resolution = resolution;
        snap = JSON.stringify(parsed);
      } catch(e) {}
      await updateAlertMemoryRow(sheets, acId, row.rowIndex, { ...row, status: "accepted", clientName: clientName || row.clientName || "", dataSnapshot: snap });
    } else {
      await appendAlertMemoryRow(sheets, acId, {
        fingerprintHash, alertType: "proactive", clientName: clientName || "", alertSummary: resolution || "Resolved proactive alert",
        cachedOptionsJSON: "", status: "accepted", ignoreReason: "", dataSnapshot: JSON.stringify({ resolution })
      });
    }

    const canRemoveClient = (cName) => req.isSystemAuthorized || !sessionUser || sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, cName);
    if (sessionId) {
      try {
        const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
        if (sessionData) {
          const parsed = JSON.parse(sessionData);
          applyAlertRemovalToTriageData(parsed, [alertKey, fingerprintHash], canRemoveClient);
          await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });
        }
      } catch (e) {}
    }
    try {
      const preRaw = await redisClient.get(PRECOMPUTED_KEY);
      if (preRaw) {
        const pre = JSON.parse(preRaw);
        applyAlertRemovalToTriageData(pre, [alertKey, fingerprintHash], canRemoveClient);
        await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
      }
    } catch (e) {}

    const alertCat = (() => {
      const t = String(alertKey || "").toLowerCase();
      if (t.includes("inv")) return "INVOICES";
      if (t.includes("exp") || t.includes("dir") || t.includes("cost") || t.includes("vendor") || t.includes("out")) return "EXPENSES";
      if (t.includes("crm")) return "CRM";
      if (t.includes("ret")) return "RETAINER";
      return "TRIAGE";
    })();

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: clientName || "",
      category: alertCat,
      action: "Proactive Alert Resolved",
      summary: `Resolved proactive alert (${alertKey}) for ${clientName || "Client"}: ${resolution || "Resolved"}`,
      details: { alertKey, resolution, clientName }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleBulkAcknowledgeProactiveAlerts(req, res, sheets) {
  const { alertKeys, clientName, sessionId, automationCommanderSheetId: acId } = req.body;
  if (!alertKeys || !alertKeys.length || !acId) return res.status(400).json({ success: false, error: "Missing alertKeys or automationCommanderSheetId" });
  const sessionUser = getSessionUser(req);
  if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
    if (!clientName || !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client." });
    }
  }
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const hashesToRemove = [];
    const updateBatchItems = [];
    const appendItems = [];
    
    for (const alertKey of alertKeys) {
      const fingerprintHash = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
      hashesToRemove.push(alertKey, fingerprintHash);
      const candidateMatches = memoryRows.filter(r => {
        if (clientName && r.clientName !== clientName) return false;
        if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, r.clientName)) return false;
        if (r.fingerprintHash === fingerprintHash) return true;
        if (alertKey.startsWith("autolog_error|") || alertKey.startsWith("infinite_loop|")) {
          try {
            const s = JSON.parse(r.dataSnapshot || "{}");
            const k = s.alertKey || s.legacyAlertKey || "";
            if (k === alertKey) return true;
            if (k.startsWith(alertKey + "|")) return true;
          } catch(e) { return false; }
        }
        return false;
      });

      if (candidateMatches.length > 0) {
        const primaryRow = candidateMatches[0];
        updateBatchItems.push({
          rowIndex: primaryRow.rowIndex,
          updates: { 
            ...primaryRow, 
            fingerprintHash,
            status: "accepted", 
            clientName: clientName || primaryRow.clientName || "" 
          }
        });
        for (const dup of candidateMatches.slice(1)) {
          updateBatchItems.push({
            rowIndex: dup.rowIndex,
            updates: {
              ...dup,
              status: "superseded"
            }
          });
        }
      } else {
        appendItems.push({
          fingerprintHash, alertType: "proactive", clientName: clientName || "", alertSummary: "Acknowledged proactive alert",
          cachedOptionsJSON: "", status: "accepted", ignoreReason: ""
        });
      }
    }

    if (updateBatchItems.length > 0) {
      await updateAlertMemoryRowsBatch(sheets, acId, updateBatchItems);
    }
    if (appendItems.length > 0) {
      await appendAlertMemoryRowsBatch(sheets, acId, appendItems);
    }

    const canRemoveClient = (cName) => req.isSystemAuthorized || !sessionUser || sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, cName);
    if (sessionId) {
      try {
        const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
        if (sessionData) {
          const parsed = JSON.parse(sessionData);
          applyAlertRemovalToTriageData(parsed, hashesToRemove, canRemoveClient);
          await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });
        }
      } catch (e) {}
    }
    try {
      const preRaw = await redisClient.get(PRECOMPUTED_KEY);
      if (preRaw) {
        const pre = JSON.parse(preRaw);
        applyAlertRemovalToTriageData(pre, hashesToRemove, canRemoveClient);
        await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
      }
    } catch (e) {}

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: clientName || "",
      category: "TRIAGE",
      action: "Proactive Alerts Acknowledged",
      summary: `Acknowledged ${alertKeys.length} proactive alerts for ${clientName || "Client"}`,
      details: { alertKeysCount: alertKeys.length, clientName }
    });

    return res.status(200).json({ success: true, count: alertKeys.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUnignoreAlert(req, res, sheets) {
  const { fingerprintHash, automationCommanderSheetId } = req.body;
  if (!fingerprintHash || !automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing required fields" });
  const sessionUser = getSessionUser(req);
  try {
    await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
    const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    if (!memoryRow) return res.status(404).json({ success: false, error: "Alert not found in memory" });
    if (!req.isSystemAuthorized && (!sessionUser || (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, memoryRow.clientName)))) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client's alert." });
    }

    if (memoryRow.cachedOptionsJSON) {
      await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
        ...memoryRow, status: "cached", ignoreReason: "",
      });
    } else {
      await deleteAlertMemoryRows(sheets, automationCommanderSheetId, [memoryRow.rowIndex]);
    }

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: memoryRow.clientName || "",
      category: "TRIAGE",
      action: "Unignore Alert",
      summary: `Unignored alert: ${memoryRow.alertType || memoryRow.alertSummary}`,
      details: { fingerprintHash, alertType: memoryRow.alertType, clientName: memoryRow.clientName }
    });

    return res.status(200).json({ success: true, message: "Alert un-ignored" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetIgnoredAlerts(req, res, sheets) {
  const automationCommanderSheetId = req.body.automationCommanderSheetId || req.query.automationCommanderSheetId;
  if (!automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
    const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
    let ignoredAlerts = memoryRows
      .filter(r => r.status === "ignored" || (r.status === "superseded" && r.ignoreReason))
      .map(r => ({
        fingerprintHash: r.fingerprintHash,
        alertType:       r.alertType,
        clientName:      r.clientName,
        alertSummary:    r.alertSummary,
        ignoreReason:    r.ignoreReason,
        firstSeen:       r.firstSeen,
        lastSeen:        r.lastSeen,
        status:          r.status,
      }));

    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
    }
    if (!sessionUser.isAdmin) {
      const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      ignoredAlerts = ignoredAlerts.filter(a =>
        assignedList.some(assigned => matchesClientName(assigned, a.clientName)) &&
        !ADMIN_ONLY_ALERT_TYPES.has(a.alertType)
      );
    }

    return res.status(200).json({ success: true, ignoredAlerts });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetProactiveAlerts(req, res, sheets) {
  const acId = req.body.automationCommanderSheetId || req.query.automationCommanderSheetId;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const all = await readAlertMemory(sheets, acId);
    const metaFields = [
      "jobName","endClientName","confirmedRow","revenue","startDate","endDate",
      "frequencyDays","lastInvoiceDate","expectedByDate","timestamp","sequenceType","summary","jobInfo","detailsSnippet",
      "childRowNum","clientJobStr","pipelineRow","likelihood","copiedToConf","jobType",
      "possibleMatchInvoiceNo","possibleMatchAmount","possibleMatchSentDate","possibleMatchConfidence","possibleMatchConfirmedRow","possibleMatchVatAmount","possibleMatchStatus","possibleMatchCase",
      "uninvoicedAmount","projectCode","draftCount","draftTotal","stableJobKey","isRetainer","tab",
      "directCosts","unreceivedAmount","placeholderCount","placeholderTotal",
      "totalInvoiced","totalExpenses","diff","childExp","expectedForRow",
      "categoryName","cleanName","quarantineRow",
      "slotNum","invoiceRef","amount","sentDate",
      "errorSnippet","occurrenceCount","category","rawSnippet","entityKey","fieldName","transition1","transition2","conflictType","suggestion","rawLogSnippet","invoiceNo"
    ];
      
    let active = all
      .filter(r => r.category === "proactive" && r.status === "cached")
      .map(r => {
        let alert = {};
        try { alert = JSON.parse(r.dataSnapshot || "{}"); } catch (e) { alert = {}; }
        const metadata = { ...(alert.metadata || {}) };
        for (const f of metaFields) { if (alert[f] !== undefined) metadata[f] = alert[f]; }
        return {
          ...alert,
          rowIndex: r.rowIndex,
          clientName: alert.clientName || r.clientName,
          alertType: alert.alertType || r.alertType,
          metadata,
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen
        };
      });

    // Precedence rule: "uninvoiced_revenue" takes precedence over "uninvoiced_new_job" for the same job
    const completedRevenueKeys = new Set();
    all.forEach(r => {
      if (r.alertType === "uninvoiced_revenue" && (r.status === "cached" || r.status === "task" || r.status === "accepted" || r.status === "pending_automation")) {
        try {
          const snap = JSON.parse(r.dataSnapshot || "{}");
          const jobKey = snap.stableJobKey || snap.metadata?.stableJobKey;
          if (jobKey) completedRevenueKeys.add(`${r.clientName}:::${jobKey}`);
        } catch (e) {}
      }
    });

    if (completedRevenueKeys.size > 0) {
      active = active.filter(a => {
        if (a.alertType === "uninvoiced_new_job") {
          const k = `${a.clientName}:::${a.stableJobKey || a.metadata?.stableJobKey}`;
          if (completedRevenueKeys.has(k)) return false;
        }
        return true;
      });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
    }
    if (!sessionUser.isAdmin) {
      const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      active = active.filter(a =>
        assignedList.some(assigned => matchesClientName(assigned, a.clientName)) &&
        !ADMIN_ONLY_ALERT_TYPES.has(a.alertType)
      );
    }

    const countsByClient = {};
    for (const a of active) {
      countsByClient[a.clientName] = (countsByClient[a.clientName] || 0) + 1;
    }
    const clientFilter = req.body.clientName;
    const alerts = clientFilter ? active.filter(a => a.clientName === clientFilter) : active;

    // Self-heal any cached revenue_mismatch / direct_costs_mismatch alerts that had serial-number endDate formatted as "1-Jan-XX"
    const corruptedAlerts = alerts.filter(a =>
      (a.alertType === "direct_costs_mismatch" || a.alertType === "revenue_mismatch") &&
      /^1-Jan-\d{2}$/.test(String(a.endDate || a.metadata?.endDate || "").trim()) &&
      !a._endDateVerified &&
      Number(a.confirmedRow || a.metadata?.confirmedRow) > 1
    );
    if (corruptedAlerts.length > 0) {
      try {
        const allClientsData = await getAllClients(sheets, { isAdmin: true }, false, acId);
        const clientsObj = allClientsData?.clientsObj || {};
        const byClient = new Map();
        for (const ca of corruptedAlerts) {
          if (!byClient.has(ca.clientName)) byClient.set(ca.clientName, []);
          byClient.get(ca.clientName).push(ca);
        }
        const memoryUpdates = [];
        for (const [cName, cAlerts] of byClient.entries()) {
          const cSheetId = clientsObj[cName]?.clientSheetId;
          if (!cSheetId) continue;
          const maxRow = Math.max(...cAlerts.map(x => Number(x.confirmedRow || x.metadata?.confirmedRow) || 2), 10) + 5;
          const amRes = await sheets.spreadsheets.values.get({
            spreadsheetId: cSheetId,
            range: `Confirmed!AM1:AM${maxRow}`,
            valueRenderOption: "UNFORMATTED_VALUE"
          });
          const amCol = amRes.data?.values || [];
          for (const ca of cAlerts) {
            let rIdx = (Number(ca.confirmedRow || ca.metadata?.confirmedRow) || 2) - 1;
            while (rIdx > 1 && (amCol[rIdx]?.[0] === undefined || amCol[rIdx]?.[0] === "")) {
              rIdx--;
            }
            const rawEnd = amCol[rIdx]?.[0];
            if (rawEnd) {
              const fixedEnd = toSheetDateFormat(rawEnd);
              if (fixedEnd) {
                ca.endDate = fixedEnd;
                ca._endDateVerified = true;
                if (ca.metadata) ca.metadata.endDate = fixedEnd;
                const origMemRow = all.find(r => r.rowIndex === ca.rowIndex);
                if (origMemRow) {
                  try {
                    const snap = JSON.parse(origMemRow.dataSnapshot || "{}");
                    snap.endDate = fixedEnd;
                    snap._endDateVerified = true;
                    if (snap.metadata) snap.metadata.endDate = fixedEnd;
                    memoryUpdates.push({
                      rowIndex: origMemRow.rowIndex,
                      updates: { ...origMemRow, dataSnapshot: JSON.stringify(snap) }
                    });
                  } catch (e) {}
                }
              }
            }
          }
        }
        if (memoryUpdates.length > 0) {
          await updateAlertMemoryRowsBatch(sheets, acId, memoryUpdates).catch(() => {});
        }
      } catch (healErr) {
        console.warn("Could not self-heal proactive alert endDate:", healErr.message);
      }
    }

    return res.status(200).json({ success: true, alerts, countsByClient });
  } catch (err) {
    console.error(`❌ Error in get_proactive_alerts:`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
}