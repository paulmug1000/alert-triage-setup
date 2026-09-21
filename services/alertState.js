import { redisClient } from "./redisClient";
import { getSheetsClient, extractSheetIdFromUrl } from "./sheetsClient";
import {
  readAlertMemory, updateAlertMemoryRow, appendAlertMemoryRow,
  ensureAlertMemoryTab, findMemoryRow, buildAlertFingerprint,
  extractCrmComparisonSnapshot
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

export async function handleRemoveAlert(req, res) {
  const { sessionId, alertId } = req.body;
  if (!sessionId || !alertId) return res.status(400).json({ success: false, error: "Missing sessionId or alertId" });
  try {
    const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
    if (!sessionData) return res.status(200).json({ success: true, notFound: true });
    const parsed = JSON.parse(sessionData);
    const before = parsed.alerts.length + (parsed.proactiveAlerts?.length || 0);
    
    const alertToRemove = parsed.alerts.find(a => `${a.sheetName}-${a.rowNumber}` === alertId) 
                       || (parsed.proactiveAlerts || []).find(a => a.alertKey === alertId || a.fingerprintHash === alertId);
                       
    if (alertToRemove && parsed.clientsWithFlags) {
      let flagKey = alertToRemove.flagType || alertToRemove.alertType || alertToRemove.type;
      if (flagKey === "invoice") flagKey = "invoiceDashboardDiscr";
      if (flagKey === "expense") flagKey = "expenseDashboardDiscr";
      if (flagKey === "crm") flagKey = alertToRemove.alertType || "crmPipeAppDiscr";

      parsed.clientsWithFlags = parsed.clientsWithFlags.map(c => {
        if (c.clientName === alertToRemove.clientName && c.alertCounts && c.alertCounts[flagKey]) {
          c.alertCounts[flagKey] = Math.max(0, c.alertCounts[flagKey] - 1);
        }
        return c;
      });
    }

    parsed.alerts = parsed.alerts.filter(a => `${a.sheetName}-${a.rowNumber}` !== alertId);
    if (parsed.proactiveAlerts) {
      parsed.proactiveAlerts = parsed.proactiveAlerts.filter(a => a.alertKey !== alertId && a.fingerprintHash !== alertId);
    }
    
    const removed = before - (parsed.alerts.length + (parsed.proactiveAlerts?.length || 0));
    await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 3600 });
    return res.status(200).json({ success: true, removed });
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
  const { alertKey, automationCommanderSheetId: acId } = req.body;
  if (!alertKey || !acId) return res.status(400).json({ success: false, error: "Missing alertKey or automationCommanderSheetId" });
  try {
    const fingerprintHash = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const row = findMemoryRow(memoryRows, fingerprintHash);
    
    if (row) {
      await updateAlertMemoryRow(sheets, acId, row.rowIndex, { ...row, status: "accepted" });
    } else {
      await appendAlertMemoryRow(sheets, acId, {
        fingerprintHash, alertType: "proactive", clientName: "", alertSummary: "Acknowledged proactive alert",
        cachedOptionsJSON: "", status: "accepted", ignoreReason: ""
      });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleResolveProactiveAlert(req, res, sheets) {
  const { alertKey, resolution, automationCommanderSheetId: acId } = req.body;
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
      await updateAlertMemoryRow(sheets, acId, row.rowIndex, { ...row, status: "accepted", dataSnapshot: snap });
    } else {
      await appendAlertMemoryRow(sheets, acId, {
        fingerprintHash, alertType: "proactive", clientName: "", alertSummary: resolution || "Resolved proactive alert",
        cachedOptionsJSON: "", status: "accepted", ignoreReason: "", dataSnapshot: JSON.stringify({ resolution })
      });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleBulkAcknowledgeProactiveAlerts(req, res, sheets) {
  const { alertKeys, automationCommanderSheetId: acId } = req.body;
  if (!alertKeys || !alertKeys.length || !acId) return res.status(400).json({ success: false, error: "Missing alertKeys or automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    
    for (const alertKey of alertKeys) {
      const fingerprintHash = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
      const row = findMemoryRow(memoryRows, fingerprintHash);
      if (row) {
        await updateAlertMemoryRow(sheets, acId, row.rowIndex, { ...row, status: "accepted" });
      } else {
        await appendAlertMemoryRow(sheets, acId, {
          fingerprintHash, alertType: "proactive", clientName: "", alertSummary: "Acknowledged proactive alert",
          cachedOptionsJSON: "", status: "accepted", ignoreReason: ""
        });
      }
    }
    return res.status(200).json({ success: true, count: alertKeys.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}