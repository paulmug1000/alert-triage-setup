import { redisClient } from "./redisClient";
import { getSheetsClient, extractSheetIdFromUrl } from "./sheetsClient";
import {
  readAlertMemory, updateAlertMemoryRow, appendAlertMemoryRow,
  ensureAlertMemoryTab, findMemoryRow, buildAlertFingerprint,
  extractCrmComparisonSnapshot, deleteAlertMemoryRows
} from "./alertMemory";
import { createHash } from "crypto";

const PRECOMPUTED_KEY = "triage_precomputed";

export async function handleBustCache(req, res, sheets) {
  const { fingerprintHash, rowNumber, sheetName, automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    const memoryRows = await readAlertMemory(sheets, acId);
    let row = null;
    if (fingerprintHash) {
      row = findMemoryRow(memoryRows, fingerprintHash);
    } else if (rowNumber && sheetName) {
      row = memoryRows.find(r => r.status === "cached" && r.cachedOptionsJSON && r.alertSummary?.includes(String(rowNumber)));
    }
    if (!row) return res.status(404).json({ success: false, error: "Alert not found in AlertMemory" });
    await updateAlertMemoryRow(sheets, acId, row.rowIndex, { ...row, cachedOptionsJSON: "" });
    console.log(`  ✅ Cache cleared for row ${row.rowIndex} (${row.fingerprintHash})`);
    return res.status(200).json({ success: true, fingerprintHash: row.fingerprintHash });
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
    const { alerts, noActionAlerts, proactiveAlerts, clientsWithFlags, resolvedNoActionFlags } = JSON.parse(sessionData);
    console.log(`✅ Retrieved ${alerts.length} alerts from Redis for session ${sessionId}`);
    return res.status(200).json({
      success: true, alerts, noActionAlerts, proactiveAlerts: proactiveAlerts || [],
      clientsWithFlags, resolvedNoActionFlags: resolvedNoActionFlags || [],
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export function applyAlertRemovalToTriageData(data, targetIds) {
  if (!data) return { removedCount: 0 };
  const targetList = Array.isArray(targetIds) ? targetIds : Array.from(targetIds || []);
  const targetSet = new Set(targetList.map(String));
  
  const removedAlerts = [];
  const keptAlerts = [];
  for (const a of (data.alerts || [])) {
    const isTarget = targetSet.has(`${a.sheetName}-${a.rowNumber}`)
      || (a.fingerprintHash && targetSet.has(a.fingerprintHash))
      || (a.id && targetSet.has(a.id))
      || targetSet.has(`${a.flagType || a.type}-${a.sheetName}-${a.rowNumber}`);
    if (isTarget) removedAlerts.push(a);
    else keptAlerts.push(a);
  }

  const removedNoAction = [];
  const keptNoAction = [];
  for (const na of (data.noActionAlerts || [])) {
    const isTarget = (na.fingerprintHash && targetSet.has(na.fingerprintHash))
      || (na.id && targetSet.has(na.id))
      || targetSet.has(`${na.flagType}-${na.flagDetail || ""}`)
      || targetSet.has(`${na.clientName}___${na.flagType}`);
    if (isTarget) removedNoAction.push(na);
    else keptNoAction.push(na);
  }

  const removedProactive = [];
  const keptProactive = [];
  for (const pa of (data.proactiveAlerts || [])) {
    const isTarget = (pa.alertKey && targetSet.has(pa.alertKey))
      || (pa.fingerprintHash && targetSet.has(pa.fingerprintHash))
      || (pa.rowIndex != null && targetSet.has(String(pa.rowIndex)));
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
  try {
    const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
    if (!sessionData) return res.status(200).json({ success: true, notFound: true });
    const parsed = JSON.parse(sessionData);
    
    const { removedCount } = applyAlertRemovalToTriageData(parsed, targetIds);
    await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 3600 });

    try {
      const preRaw = await redisClient.get(PRECOMPUTED_KEY);
      if (preRaw) {
        const pre = JSON.parse(preRaw);
        applyAlertRemovalToTriageData(pre, targetIds);
        await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 3600 });
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
      await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(parsed), { EX: 3600 });
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
    await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 3600 });

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
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleRecordDecision(req, res, sheets) {
  const { alert, decision, automationCommanderSheetId } = req.body;
  if (!alert || !decision || !automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing alert, decision, or acId" });
  try {
    const timestamp = new Date().toISOString();
    const alertAmount = alert.summary?.amount || alert.data?.amount || alert.data?.revenue || "";
    const logRow = [
      timestamp, alert.type || alert.flagType, `${alert.sheetName}-${alert.rowNumber}`,
      alert.clientName || "", alertAmount, JSON.stringify(decision.claudeRecommendation || {}),
      decision.action, decision.notes || "",
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId, range: "TriageLog!A:H", valueInputOption: "USER_ENTERED",
      requestBody: { values: [logRow] },
    });
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
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const rowsToAppend = [];
    const rowsToUpdate = [];

    for (const alert of alertsToIgnore) {
      const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);
      const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
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
      if (memoryRow) {
        rowsToUpdate.push({ rowIndex: memoryRow.rowIndex, row: { ...memoryRow, status: "ignored", ignoreReason: ignoreReason || "", dataSnapshot } });
      } else {
        rowsToAppend.push({ fingerprintHash, alertType: alert.type || alert.flagType || "unknown",
          clientName: alert.clientName || "", alertSummary, cachedOptionsJSON: "",
          status: "ignored", ignoreReason: ignoreReason || "", dataSnapshot });
      }
    }
    for (const u of rowsToUpdate) await updateAlertMemoryRow(sheets, acId, u.rowIndex, u.row);
    for (const a of rowsToAppend) await appendAlertMemoryRow(sheets, acId, a);
    return res.status(200).json({ success: true, count: alertsToIgnore.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleAcknowledgeProactiveAlert(req, res, sheets) {
  const { alertKey, clientName, sessionId, automationCommanderSheetId: acId } = req.body;
  if (!alertKey || !acId) return res.status(400).json({ success: false, error: "Missing alertKey or automationCommanderSheetId" });
  try {
    const fingerprintHash = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const row = findMemoryRow(memoryRows, fingerprintHash);
    
    if (row) {
      await updateAlertMemoryRow(sheets, acId, row.rowIndex, { ...row, status: "accepted", clientName: clientName || row.clientName || "" });
    } else {
      await appendAlertMemoryRow(sheets, acId, {
        fingerprintHash, alertType: "proactive", clientName: clientName || "", alertSummary: "Acknowledged proactive alert",
        cachedOptionsJSON: "", status: "accepted", ignoreReason: ""
      });
    }

    if (sessionId) {
      try {
        const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
        if (sessionData) {
          const parsed = JSON.parse(sessionData);
          applyAlertRemovalToTriageData(parsed, [alertKey, fingerprintHash]);
          await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 3600 });
        }
      } catch (e) {}
    }
    try {
      const preRaw = await redisClient.get(PRECOMPUTED_KEY);
      if (preRaw) {
        const pre = JSON.parse(preRaw);
        applyAlertRemovalToTriageData(pre, [alertKey, fingerprintHash]);
        await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 3600 });
      }
    } catch (e) {}

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleResolveProactiveAlert(req, res, sheets) {
  const { alertKey, clientName, sessionId, resolution, automationCommanderSheetId: acId } = req.body;
  if (!alertKey || !acId) return res.status(400).json({ success: false, error: "Missing alertKey or automationCommanderSheetId" });
  try {
    const fingerprintHash = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const row = findMemoryRow(memoryRows, fingerprintHash);
    
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

    if (sessionId) {
      try {
        const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
        if (sessionData) {
          const parsed = JSON.parse(sessionData);
          applyAlertRemovalToTriageData(parsed, [alertKey, fingerprintHash]);
          await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 3600 });
        }
      } catch (e) {}
    }
    try {
      const preRaw = await redisClient.get(PRECOMPUTED_KEY);
      if (preRaw) {
        const pre = JSON.parse(preRaw);
        applyAlertRemovalToTriageData(pre, [alertKey, fingerprintHash]);
        await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 3600 });
      }
    } catch (e) {}

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleBulkAcknowledgeProactiveAlerts(req, res, sheets) {
  const { alertKeys, clientName, sessionId, automationCommanderSheetId: acId } = req.body;
  if (!alertKeys || !alertKeys.length || !acId) return res.status(400).json({ success: false, error: "Missing alertKeys or automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const hashesToRemove = [];
    
    for (const alertKey of alertKeys) {
      const fingerprintHash = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
      hashesToRemove.push(alertKey, fingerprintHash);
      const row = findMemoryRow(memoryRows, fingerprintHash);
      if (row) {
        await updateAlertMemoryRow(sheets, acId, row.rowIndex, { ...row, status: "accepted", clientName: clientName || row.clientName || "" });
      } else {
        await appendAlertMemoryRow(sheets, acId, {
          fingerprintHash, alertType: "proactive", clientName: clientName || "", alertSummary: "Acknowledged proactive alert",
          cachedOptionsJSON: "", status: "accepted", ignoreReason: ""
        });
      }
    }

    if (sessionId) {
      try {
        const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
        if (sessionData) {
          const parsed = JSON.parse(sessionData);
          applyAlertRemovalToTriageData(parsed, hashesToRemove);
          await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 3600 });
        }
      } catch (e) {}
    }
    try {
      const preRaw = await redisClient.get(PRECOMPUTED_KEY);
      if (preRaw) {
        const pre = JSON.parse(preRaw);
        applyAlertRemovalToTriageData(pre, hashesToRemove);
        await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 3600 });
      }
    } catch (e) {}

    return res.status(200).json({ success: true, count: alertKeys.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUnignoreAlert(req, res, sheets) {
  const { fingerprintHash, automationCommanderSheetId } = req.body;
  if (!fingerprintHash || !automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
    const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    if (!memoryRow) return res.status(404).json({ success: false, error: "Alert not found in memory" });

    if (memoryRow.cachedOptionsJSON) {
      await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
        ...memoryRow, status: "cached", ignoreReason: "",
      });
    } else {
      await deleteAlertMemoryRows(sheets, automationCommanderSheetId, [memoryRow.rowIndex]);
    }
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
    const ignoredAlerts = memoryRows
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
      "directCosts","unreceivedAmount","placeholderCount","placeholderTotal"
    ];
      
    const active = all
      .filter(r => r.category === "proactive" && r.status === "cached")
      .map(r => {
        let alert = {};
        try { alert = JSON.parse(r.dataSnapshot || "{}"); } catch (e) { alert = {}; }
        const metadata = {};
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
    const countsByClient = {};
    for (const a of active) {
      countsByClient[a.clientName] = (countsByClient[a.clientName] || 0) + 1;
    }
    const clientFilter = req.body.clientName;
    const alerts = clientFilter ? active.filter(a => a.clientName === clientFilter) : active;
    return res.status(200).json({ success: true, alerts, countsByClient });
  } catch (err) {
    console.error(`❌ Error in get_proactive_alerts:`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
}