import { waitUntil } from "@vercel/functions";
import { redisClient, scanRedisKeys } from "./redisClient.js";
import { getSheetsClient, extractSheetIdFromUrl, sanitizeFormulaInput } from "./sheetsClient.js";
import {
  queryAlertMemoryTargeted, updateAlertMemoryRow, updateAlertMemoryRowsBatch, appendAlertMemoryRow, appendAlertMemoryRowsBatch,
  ensureAlertMemoryTab, findMemoryRow, buildAlertFingerprint,
  extractCrmComparisonSnapshot, deleteAlertMemoryRows, deleteAlertMemoryEntryByHash,
  updateHandledAlertHash, updateHandledAlertHashesBatch, readHandledAlertHashes
} from "./alertMemory.js";
import { createHash } from "crypto";
import { logPmaActivity } from "./pmaLogger.js";
import { isSupabaseControlPlaneActive, shouldDualWriteLegacyControlPlaneSheets } from "./supabaseClient.js";
import { getSessionUser } from "./authService.js";
import { isUserAuthorizedForClient, canAccessPma, canViewSalariesAndDividends, DEFAULT_AC_SHEET_ID } from "./userPermissions.js";
import { matchesClientName, ADMIN_ONLY_ALERT_TYPES, toSheetDateFormat, KNOWN_PROACTIVE_ALERT_TYPES } from "../utils/helpers.js";
import { getAllClients } from "./workspaces.js";
import { invalidatePrecomputedMemoryCache, getExcludedClientNamesSet } from "./triageEngine.js";

export const PRECOMPUTED_KEY = "triage_precomputed";

/**
 * Schedules non-critical background work via Vercel waitUntil with a short macrotask yield
 * so HTTP responses flush cleanly before heavy background work executes.
 */
export function scheduleWaitUntil_(workFn, delayMs = 50) {
  const runner = (async () => {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return await workFn();
  })().catch((err) => {
    console.warn("[scheduleWaitUntil_] background task warning:", err?.message || err);
  });

  try {
    if (typeof waitUntil === "function") {
      waitUntil(runner);
    }
  } catch { }
  return runner;
}

let _precomputedPruneChain = Promise.resolve();

/**
 * Prunes alerts from the shared multi-KB PRECOMPUTED_KEY blob in the background via waitUntil.
 * Serialized sequentially so concurrent accepts/ignores never clobber each other's updates.
 */
export function prunePrecomputedInBackground_({ targetIds = [], canRemoveClient = null, transformPreFn = null, label = "cache sync" } = {}) {
  if (!redisClient?.isOpen) return;
  const chained = _precomputedPruneChain
    .catch(() => { })
    .then(async () => {
      try {
        const preRaw = await redisClient.get(PRECOMPUTED_KEY);
        if (!preRaw) return;
        const pre = JSON.parse(preRaw);
        let modified = false;
        if (Array.isArray(targetIds) && targetIds.length > 0) {
          const { removedCount } = applyAlertRemovalToTriageData(pre, targetIds, canRemoveClient);
          if (removedCount > 0) modified = true;
        }
        if (typeof transformPreFn === "function") {
          const customModified = transformPreFn(pre);
          if (customModified !== false) modified = true;
        }
        if (modified) {
          await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
        }
      } catch (e) {
        console.warn(`Could not sync PRECOMPUTED_KEY in ${label}:`, e.message);
      }
    });
  _precomputedPruneChain = chained;
  scheduleWaitUntil_(() => chained, 20);
}

export async function handleBustCache(req, res, sheets) {
  const { fingerprintHash, rowNumber, sheetName, automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  const sessionUser = getSessionUser(req, res);
  if (!req.isSystemAuthorized && (!sessionUser || (!sessionUser.isAdmin && !canAccessPma(sessionUser)))) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  try {
    const memoryRows = await queryAlertMemoryTargeted(
      sheets,
      acId,
      fingerprintHash ? { hashes: [fingerprintHash] } : { status: "cached" }
    );
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
    const [sessionData, preRaw, excludedClientNamesSet] = await Promise.all([
      redisClient.get(`triage_alerts:${sessionId}`),
      redisClient.get(PRECOMPUTED_KEY).catch(() => null),
      getExcludedClientNamesSet().catch(() => new Set()),
    ]);
    if (!sessionData) return res.status(404).json({ success: false, error: "Session not found" });
    const parsedSession = JSON.parse(sessionData);

    // Reconcile session alerts against triage_precomputed so any alert resolved via workspace assignment
    // or another tab/device is immediately pruned from this session as well.
    if (preRaw) {
      try {
        const pre = JSON.parse(preRaw);
        const preActiveIds = new Set();
        for (const a of (pre.alerts || [])) {
          if (a.fingerprintHash) preActiveIds.add(a.fingerprintHash);
          if (a.sheetName && a.rowNumber != null) preActiveIds.add(`${a.sheetName}-${a.rowNumber}`);
        }
        for (const na of (pre.noActionAlerts || [])) {
          if (na.fingerprintHash) preActiveIds.add(na.fingerprintHash);
          if (na.flagType) preActiveIds.add(`${na.clientName}___${na.flagType}`);
        }
        const staleTargetIds = [];
        for (const a of (parsedSession.alerts || [])) {
          const hasFp = a.fingerprintHash && preActiveIds.has(a.fingerprintHash);
          const hasRow = a.sheetName && a.rowNumber != null && preActiveIds.has(`${a.sheetName}-${a.rowNumber}`);
          if (!hasFp && !hasRow) {
            staleTargetIds.push(a.fingerprintHash || `${a.sheetName}-${a.rowNumber}`);
          }
        }
        if (staleTargetIds.length > 0) {
          applyAlertRemovalToTriageData(parsedSession, staleTargetIds);
          redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsedSession), { EX: 86400 * 7 }).catch(() => { });
        }
      } catch (_) { }
    }

    // Reconcile proactive alerts in parsedSession against handledMap
    try {
      const acId = process.env.AUTOMATION_COMMANDER_SHEET_ID || "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
      const handledMap = await readHandledAlertHashes(null, acId, false);
      if (parsedSession.proactiveAlerts && parsedSession.proactiveAlerts.length > 0 && handledMap && Object.keys(handledMap).length > 0) {
        const staleProactiveKeys = [];
        for (const pa of parsedSession.proactiveAlerts) {
          const hash = pa.fingerprintHash || createHash("sha256").update(pa.alertKey || "").digest("hex").substring(0, 16);
          const legacyHash = pa.legacyAlertKey ? createHash("sha256").update(pa.legacyAlertKey).digest("hex").substring(0, 16) : null;
          const status = handledMap[hash] || (legacyHash ? handledMap[legacyHash] : null);
          if (status && status !== "cached" && status !== "pending_automation") {
            if (pa.alertKey) staleProactiveKeys.push(pa.alertKey);
            if (pa.fingerprintHash) staleProactiveKeys.push(pa.fingerprintHash);
            if (hash) staleProactiveKeys.push(hash);
            if (legacyHash) staleProactiveKeys.push(legacyHash);
            if (pa.rowIndex != null) staleProactiveKeys.push(String(pa.rowIndex));
          }
        }
        if (staleProactiveKeys.length > 0) {
          applyAlertRemovalToTriageData(parsedSession, staleProactiveKeys);
          redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsedSession), { EX: 86400 * 7 }).catch(() => { });
        }
      }
    } catch (recErr) {
      console.warn("Could not reconcile proactive alerts in handleGetAlerts:", recErr.message);
    }

    let { alerts, noActionAlerts, proactiveAlerts, clientsWithFlags, resolvedNoActionFlags } = parsedSession;

    if (excludedClientNamesSet && excludedClientNamesSet.size > 0) {
      const keepActiveClient = (item) => !excludedClientNamesSet.has(String(item?.clientName || "").trim().toLowerCase());
      alerts = (alerts || []).filter(keepActiveClient);
      noActionAlerts = (noActionAlerts || []).filter(keepActiveClient);
      proactiveAlerts = (proactiveAlerts || []).filter(keepActiveClient);
      clientsWithFlags = (clientsWithFlags || []).filter(keepActiveClient);
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
    }
    if (!sessionUser.isAdmin) {
      const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      const allowSalaries = canViewSalariesAndDividends(sessionUser);
      const isAllowedAlert = (a) => {
        const aType = a.alertType || a.flagType || a.type;
        if (!allowSalaries && aType === "salary_forecast_in_actual_month") return false;
        return assignedList.some(assigned => matchesClientName(assigned, a.clientName)) &&
          !ADMIN_ONLY_ALERT_TYPES.has(aType);
      };
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
      || (pa.legacyAlertKey && targetSet.has(pa.legacyAlertKey))
      || (pa.metadata?.legacyAlertKey && targetSet.has(pa.metadata.legacyAlertKey))
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

  const resolveFlagKey = (a) => {
    let flagKey = a.flagType || a.alertType || a.type;
    if (flagKey === "invoice") flagKey = "invoiceDashboardDiscr";
    if (flagKey === "expense" || flagKey === "expenseDashboardDiscr") {
      flagKey = a.expenseCategoryType === "passthrough" ? "passThroughDashboardDiscr" : "contractorsDashboardDiscr";
    }
    if (flagKey === "crm") flagKey = a.alertType || "crmPipeAppDiscr";
    return flagKey;
  };

  const removedCountsByClientFlag = {};
  const removedTxIdsByClient = {};
  const removedInvNosByClient = {};
  for (const a of [...removedAlerts, ...removedNoAction]) {
    const cName = a.clientName;
    if (!cName) continue;
    const flagKey = resolveFlagKey(a);
    if (!removedCountsByClientFlag[cName]) removedCountsByClientFlag[cName] = {};
    removedCountsByClientFlag[cName][flagKey] = (removedCountsByClientFlag[cName][flagKey] || 0) + 1;

    const txId = String(a.summary?.transactionId || a.summary?.appId || a.data?.accounting?.[6] || "").trim().replace(/^#/, "");
    if (txId) {
      if (!removedTxIdsByClient[cName]) removedTxIdsByClient[cName] = new Set();
      removedTxIdsByClient[cName].add(txId);
    }
    const invNo = String(a.summary?.invoiceNo || a.data?.accounting?.[5] || "").trim().replace(/^#/, "");
    if (invNo) {
      if (!removedInvNosByClient[cName]) removedInvNosByClient[cName] = new Set();
      removedInvNosByClient[cName].add(invNo);
    }
  }

  if (data.clientsWithFlags) {
    data.clientsWithFlags = data.clientsWithFlags.map(c => {
      const clientRemovals = removedCountsByClientFlag[c.clientName];
      if (!clientRemovals) return c;
      const updatedCounts = { ...(c.alertCounts || {}) };
      const updatedFlags = { ...(c.flags || {}) };
      for (const [fKey, countRemoved] of Object.entries(clientRemovals)) {
        const remainingForFlag = [...keptAlerts, ...keptNoAction].filter(
          item => item.clientName === c.clientName && resolveFlagKey(item) === fKey
        ).length;
        if (remainingForFlag === 0) {
          updatedCounts[fKey] = 0;
          updatedFlags[fKey] = false;
        } else if (updatedCounts[fKey] != null) {
          updatedCounts[fKey] = Math.max(remainingForFlag, updatedCounts[fKey] - countRemoved);
        } else {
          updatedCounts[fKey] = remainingForFlag;
        }
      }
      const txSet = removedTxIdsByClient[c.clientName];
      const invSet = removedInvNosByClient[c.clientName];
      const nextClient = { ...c, alertCounts: updatedCounts, flags: updatedFlags };
      if (txSet && txSet.size > 0) {
        if (Array.isArray(nextClient.activeExpenseIds)) {
          nextClient.activeExpenseIds = nextClient.activeExpenseIds.filter(id => !txSet.has(String(id).replace(/^#/, "")));
        }
        if (Array.isArray(nextClient.activeContractorExpenseIds)) {
          nextClient.activeContractorExpenseIds = nextClient.activeContractorExpenseIds.filter(id => !txSet.has(String(id).replace(/^#/, "")));
        }
        if (Array.isArray(nextClient.activePassThroughExpenseIds)) {
          nextClient.activePassThroughExpenseIds = nextClient.activePassThroughExpenseIds.filter(id => !txSet.has(String(id).replace(/^#/, "")));
        }
      }
      if (invSet && invSet.size > 0 && Array.isArray(nextClient.activeInvoiceIds)) {
        nextClient.activeInvoiceIds = nextClient.activeInvoiceIds.filter(id => !invSet.has(String(id).replace(/^#/, "")));
      }
      return nextClient;
    });
  }

  return { removedCount: totalRemoved };
}

export function restoreAlertToTriageData(data, alert, category) {
  if (!data || !alert) return;
  const isProactive = (category === "proactive" || alert.isProactive) && KNOWN_PROACTIVE_ALERT_TYPES.has(alert.alertType || alert.type);
  const isInfo = category === "informational" || alert.isNoAction;

  const resolveFlagKey = (a) => {
    let flagKey = a.flagType || a.alertType || a.type;
    if (flagKey === "invoice") flagKey = "invoiceDashboardDiscr";
    if (flagKey === "expense" || flagKey === "expenseDashboardDiscr") {
      flagKey = a.expenseCategoryType === "passthrough" ? "passThroughDashboardDiscr" : "contractorsDashboardDiscr";
    }
    if (flagKey === "crm") flagKey = a.alertType || "crmPipeAppDiscr";
    return flagKey;
  };

  const alertMatches = (a, b) => {
    if (a.fingerprintHash && b.fingerprintHash && a.fingerprintHash === b.fingerprintHash) return true;
    if (a.alertKey && b.alertKey && a.alertKey === b.alertKey) return true;
    if (a.sheetName && a.rowNumber != null && b.sheetName && b.rowNumber != null &&
      a.sheetName === b.sheetName && String(a.rowNumber) === String(b.rowNumber)) return true;
    return false;
  };

  if (isProactive) {
    if (!data.proactiveAlerts) data.proactiveAlerts = [];
    const exists = data.proactiveAlerts.some(a => alertMatches(a, alert));
    if (!exists) {
      data.proactiveAlerts.unshift(alert);
    }
  } else if (isInfo) {
    if (!data.noActionAlerts) data.noActionAlerts = [];
    const exists = data.noActionAlerts.some(a => alertMatches(a, alert));
    if (!exists) {
      data.noActionAlerts.unshift(alert);
    }
  } else {
    if (!data.alerts) data.alerts = [];
    const exists = data.alerts.some(a => alertMatches(a, alert));
    if (!exists) {
      data.alerts.unshift(alert);
    }
  }

  if (data.totalAlerts != null && data.alerts) data.totalAlerts = data.alerts.length;
  if (data.noActionCount != null && data.noActionAlerts) data.noActionCount = data.noActionAlerts.length;

  if (!isProactive && alert.clientName && data.clientsWithFlags) {
    const flagKey = resolveFlagKey(alert);
    const clientIdx = data.clientsWithFlags.findIndex(c => matchesClientName(c.clientName, alert.clientName));
    if (clientIdx !== -1) {
      const c = data.clientsWithFlags[clientIdx];
      const updatedCounts = { ...(c.alertCounts || {}) };
      const updatedFlags = { ...(c.flags || {}) };
      if (flagKey) {
        updatedCounts[flagKey] = (updatedCounts[flagKey] || 0) + 1;
        updatedFlags[flagKey] = true;
      }
      data.clientsWithFlags[clientIdx] = { ...c, alertCounts: updatedCounts, flags: updatedFlags };
    } else {
      data.clientsWithFlags.push({
        clientName: alert.clientName,
        flags: flagKey ? { [flagKey]: true } : {},
        alertCounts: flagKey ? { [flagKey]: 1 } : {},
        activeExpenseIds: [],
        activeInvoiceIds: [],
      });
    }
  }
}

export async function restoreAlertToCacheAndSession(alert, category, sessionId) {
  try {
    if (sessionId && redisClient?.isOpen) {
      const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
      if (sessionData) {
        const parsed = JSON.parse(sessionData);
        restoreAlertToTriageData(parsed, alert, category);
        await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });
      }
    }
    if (redisClient?.isOpen) {
      invalidatePrecomputedMemoryCache();
      scheduleWaitUntil_(async () => {
        try {
          const preRaw = await redisClient.get(PRECOMPUTED_KEY);
          if (preRaw) {
            const pre = JSON.parse(preRaw);
            restoreAlertToTriageData(pre, alert, category);
            await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
            invalidatePrecomputedMemoryCache();
          }
        } catch (err) {
          console.warn("restoreAlertToCacheAndSession background PRECOMPUTED_KEY warning:", err.message);
        }
      });
    }
  } catch (err) {
    console.warn("restoreAlertToCacheAndSession error:", err.message);
  }
}

/**
 * Resolves any active missing-expense or missing-invoice alerts in AlertMemory,
 * triage_precomputed, and triage_alerts:{sessionId} when an expense or invoice
 * is assigned directly from the Contractors, Pass-through costs, or Invoices workspaces.
 */
export async function resolveAssignedAlertsInMemoryAndCache(sheets, {
  acSheetId = DEFAULT_AC_SHEET_ID,
  clientName = "",
  expenseIds = [],
  invoiceNos = [],
  sessionId = null
} = {}) {
  try {
    const cleanExpIds = new Set(
      (Array.isArray(expenseIds) ? expenseIds : [expenseIds])
        .map(id => String(id || "").trim().replace(/^#/, ""))
        .filter(Boolean)
    );
    const cleanInvNos = new Set(
      (Array.isArray(invoiceNos) ? invoiceNos : [invoiceNos])
        .map(no => String(no || "").trim().replace(/^#/, "").toLowerCase())
        .filter(Boolean)
    );
    if (cleanExpIds.size === 0 && cleanInvNos.size === 0) return;

    const targetAlertIds = new Set();
    const targetAcId = acSheetId || DEFAULT_AC_SHEET_ID;

    if (sheets && targetAcId) {
      try {
        const targetTypes = [
          ...(cleanExpIds.size > 0 ? ["contractorsDashboardDiscr", "passThroughDashboardDiscr", "expenseDashboardDiscr", "expense"] : []),
          ...(cleanInvNos.size > 0 ? ["invoiceDashboardDiscr", "invoice"] : []),
        ];
        const memoryRows = await queryAlertMemoryTargeted(sheets, targetAcId, {
          ...(clientName ? { clientName } : {}),
          alertTypes: targetTypes,
          statuses: ["cached", "pending_automation"],
        });
        const nowIso = new Date().toISOString();
        const batchUpdates = [];

        for (const r of (memoryRows || [])) {
          if (r.status !== "cached" && r.status !== "pending_automation") continue;
          if (clientName && !matchesClientName(r.clientName, clientName)) continue;

          const aType = String(r.alertType || "").trim();
          const isExpAlert = ["contractorsDashboardDiscr", "passThroughDashboardDiscr", "expenseDashboardDiscr", "expense"].includes(aType);
          const isInvAlert = ["invoiceDashboardDiscr", "invoice"].includes(aType);
          if (!isExpAlert && !isInvAlert) continue;

          let snapObj = {};
          try { snapObj = r.dataSnapshot ? JSON.parse(r.dataSnapshot) : {}; } catch { }

          let matched = false;
          if (isExpAlert && cleanExpIds.size > 0) {
            const payloadTx = String(
              snapObj?.summary?.transactionId ||
              snapObj?.summary?.appId ||
              snapObj?.data?.accounting?.[6] ||
              snapObj?.data?.accounting?.[10] ||
              snapObj?.data?.accounting?.[11] ||
              snapObj?.data?.accounting?.[0] ||
              ""
            ).trim().replace(/^#/, "");
            if (payloadTx && cleanExpIds.has(payloadTx)) {
              matched = true;
            }
          } else if (isInvAlert && cleanInvNos.size > 0) {
            const payloadInv = String(
              snapObj?.summary?.invoiceNo ||
              snapObj?.data?.accounting?.[5] ||
              snapObj?.data?.accounting?.[10] ||
              snapObj?.data?.accounting?.[1] ||
              snapObj?.data?.accounting?.[0] ||
              ""
            ).trim().replace(/^#/, "").toLowerCase();
            if (payloadInv && cleanInvNos.has(payloadInv)) {
              matched = true;
            } else {
              const sumStr = String(r.alertSummary || snapObj?.summary?.summary || "").trim().toLowerCase();
              for (const invNo of cleanInvNos) {
                if (sumStr.startsWith(`invoice ${invNo} `) || sumStr.includes(`invoice ${invNo} •`)) {
                  matched = true;
                  break;
                }
              }
            }
          }

          if (matched) {
            if (r.fingerprintHash) targetAlertIds.add(r.fingerprintHash);
            if (snapObj?.sheetName && snapObj?.rowNumber != null) {
              targetAlertIds.add(`${snapObj.sheetName}-${snapObj.rowNumber}`);
            }
            batchUpdates.push({
              rowIndex: r.rowIndex,
              updates: { ...r, status: "accepted", lastSeen: nowIso }
            });
          }
        }

        if (batchUpdates.length > 0) {
          await updateAlertMemoryRowsBatch(sheets, targetAcId, batchUpdates);
          console.log(`  ✅ Marked ${batchUpdates.length} assigned alert(s) as accepted in AlertMemory for ${clientName}`);
        }
      } catch (memErr) {
        console.warn("resolveAssignedAlertsInMemoryAndCache AlertMemory update failed:", memErr.message);
      }
    }

    const collectMatchingAlertIdsFromData = (data) => {
      if (!data?.alerts) return;
      for (const a of data.alerts) {
        if (clientName && !matchesClientName(a.clientName, clientName)) continue;
        const txId = String(a.summary?.transactionId || a.summary?.appId || a.data?.accounting?.[6] || "").trim().replace(/^#/, "");
        const invNo = String(a.summary?.invoiceNo || a.data?.accounting?.[5] || "").trim().replace(/^#/, "").toLowerCase();
        if ((txId && cleanExpIds.has(txId)) || (invNo && cleanInvNos.has(invNo))) {
          if (a.fingerprintHash) targetAlertIds.add(a.fingerprintHash);
          if (a.sheetName && a.rowNumber != null) targetAlertIds.add(`${a.sheetName}-${a.rowNumber}`);
        }
      }
    };

    if (redisClient?.isOpen) {
      if (sessionId) {
        try {
          const sessRaw = await redisClient.get(`triage_alerts:${sessionId}`);
          if (sessRaw) {
            const sess = JSON.parse(sessRaw);
            collectMatchingAlertIdsFromData(sess);
            if (targetAlertIds.size > 0) {
              const { removedCount } = applyAlertRemovalToTriageData(sess, targetAlertIds);
              if (removedCount > 0) {
                await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(sess), { EX: 86400 * 7 });
              }
            }
          }
        } catch (sessErr) {
          console.warn("resolveAssignedAlertsInMemoryAndCache session update failed:", sessErr.message);
        }
      }

      invalidatePrecomputedMemoryCache();
      prunePrecomputedInBackground_({
        label: "resolveAssignedAlertsInMemoryAndCache",
        transformPreFn: (pre) => {
          collectMatchingAlertIdsFromData(pre);
          if (targetAlertIds.size === 0) return false;
          const { removedCount } = applyAlertRemovalToTriageData(pre, targetAlertIds);
          return removedCount > 0;
        },
      });
    }
  } catch (err) {
    console.warn("resolveAssignedAlertsInMemoryAndCache error:", err.message);
  }
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
    invalidatePrecomputedMemoryCache();

    prunePrecomputedInBackground_({
      targetIds,
      canRemoveClient: allowedClientCheck,
      label: "handleRemoveAlert",
    });

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
    invalidatePrecomputedMemoryCache();
    prunePrecomputedInBackground_({
      label: "handleUpdateSessionFlags",
      transformPreFn: (parsed) => {
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
        return true;
      },
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleResolveNoActionFlag(req, res, sheets) {
  const { sessionId, clientName, flagType, fingerprintHash, preserveTaskStatus, automationCommanderSheetId: acIdResolve } = req.body;
  if (!sessionId || !clientName || !flagType) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    const targetIds = fingerprintHash ? [fingerprintHash] : [`${clientName}___${flagType}`];
    const canRemoveFlagClient = (cName) => !cName || matchesClientName(cName, clientName);

    const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
    if (!sessionData) return res.status(200).json({ success: true, notFound: true });
    const parsed = JSON.parse(sessionData);
    if (!parsed.resolvedNoActionFlags) parsed.resolvedNoActionFlags = [];
    const resolvedId = fingerprintHash || flagType;
    const key = `${clientName}___${resolvedId}`;
    if (!parsed.resolvedNoActionFlags.includes(key)) parsed.resolvedNoActionFlags.push(key);
    applyAlertRemovalToTriageData(parsed, targetIds, canRemoveFlagClient);
    await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });
    invalidatePrecomputedMemoryCache();

    prunePrecomputedInBackground_({
      targetIds,
      canRemoveClient: canRemoveFlagClient,
      label: "handleResolveNoActionFlag",
    });

    if (acIdResolve) {
      try {
        const acIdClean = extractSheetIdFromUrl(acIdResolve) || acIdResolve;
        const [memoryRows, handledMap] = await Promise.all([
          queryAlertMemoryTargeted(sheets, acIdClean, {
            hashes: fingerprintHash ? [fingerprintHash] : [],
            clientName,
            alertType: flagType,
            statuses: ["cached", "pending_automation"],
          }),
          readHandledAlertHashes(sheets, acIdClean, false),
        ]);
        const toAccept = memoryRows.filter(r => {
          if (r.clientName !== clientName || r.alertType !== flagType || (r.status !== "cached" && r.status !== "pending_automation")) return false;
          if (preserveTaskStatus && (r.status === "task" || (r.fingerprintHash && handledMap?.[r.fingerprintHash] === "task"))) return false;
          if (fingerprintHash) return r.fingerprintHash === fingerprintHash;
          return true;
        });
        const validUpdates = toAccept
          .filter(row => !(preserveTaskStatus && row.fingerprintHash && handledMap?.[row.fingerprintHash] === "task"))
          .map(row => ({ rowIndex: row.rowIndex, updates: { ...row, status: "accepted" } }));
        if (validUpdates.length > 0) {
          await updateAlertMemoryRowsBatch(sheets, acIdClean, validUpdates);
        }
        if (!preserveTaskStatus && fingerprintHash && handledMap?.[fingerprintHash] !== "task") {
          await updateHandledAlertHash(acIdClean, fingerprintHash, "accepted");
        }
      } catch (amErr) { }
    }
    invalidatePrecomputedMemoryCache();

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
  const { sessionId, clientName, flags = [], clearedFlagKeys = [], preserveTaskStatus, automationCommanderSheetId: acIdResolve } = req.body;
  if (!sessionId || !clientName) return res.status(400).json({ success: false, error: "Missing required fields" });
  if (!Array.isArray(flags) || flags.length === 0) return res.status(200).json({ success: true, count: 0 });

  try {
    const flagTargetIds = flags
      .map(f => f?.fingerprintHash || (f?.flagType ? `${clientName}___${f.flagType}` : null))
      .filter(Boolean);
    const canRemoveFlagClient = (cName) => !cName || matchesClientName(cName, clientName);

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

      if (flagTargetIds.length > 0) {
        applyAlertRemovalToTriageData(parsed, flagTargetIds, canRemoveFlagClient);
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

    if (clearedFlagKeys.length > 0 || flagTargetIds.length > 0) {
      const keysToZero = new Set(clearedFlagKeys);
      prunePrecomputedInBackground_({
        targetIds: flagTargetIds,
        canRemoveClient: canRemoveFlagClient,
        label: "handleBulkResolveNoActionFlags",
        transformPreFn: (parsed) => {
          if (keysToZero.size > 0) {
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
            if (parsed.noActionAnalysisResults) {
              const richFlags = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete", "retainerInvoicesCreated", "retainerInvoicesDeleted", "invoiceStaleUnsentChanges"];
              richFlags.forEach(flagType => { if (keysToZero.has(flagType)) delete parsed.noActionAnalysisResults[`${clientName}___${flagType}`]; });
            }
          }
          parsed.totalAlerts = (parsed.alerts || []).length;
          parsed.noActionCount = (parsed.noActionAlerts || []).length;
          return true;
        },
      });
    }

    if (acIdResolve) {
      try {
        const acIdClean = extractSheetIdFromUrl(acIdResolve) || acIdResolve;
        const flagHashes = flags.map(f => f.fingerprintHash).filter(Boolean);
        const [memoryRows, handledMap] = await Promise.all([
          queryAlertMemoryTargeted(sheets, acIdClean, {
            hashes: flagHashes,
            clientName,
            statuses: ["cached", "pending_automation"],
          }),
          readHandledAlertHashes(sheets, acIdClean, false),
        ]);
        const hashesSet = new Set(flags.map(f => f.fingerprintHash).filter(Boolean));
        const flagTypesSet = new Set(flags.map(f => f.flagType).filter(Boolean));
        const clearedSet = new Set(clearedFlagKeys || []);

        const toAccept = memoryRows.filter(r => {
          if (r.clientName !== clientName || (r.status !== "cached" && r.status !== "pending_automation")) return false;
          if (preserveTaskStatus && (r.status === "task" || (r.fingerprintHash && handledMap?.[r.fingerprintHash] === "task"))) return false;
          if (r.fingerprintHash && hashesSet.has(r.fingerprintHash)) return true;
          if (!r.fingerprintHash && flagTypesSet.has(r.alertType)) return true;
          if (clearedSet.has(r.alertType)) return true;
          return false;
        });

        if (toAccept.length > 0) {
          const updateItems = toAccept.map(row => ({
            rowIndex: row.rowIndex,
            updates: { ...row, status: "accepted" },
          }));
          await updateAlertMemoryRowsBatch(sheets, acIdClean, updateItems);
        }
        if (!preserveTaskStatus && hashesSet.size > 0) {
          const matchedHashes = new Set(toAccept.map(r => r.fingerprintHash).filter(Boolean));
          const extraHandled = {};
          for (const h of hashesSet) {
            if (!matchedHashes.has(h) && handledMap?.[h] !== "task") {
              extraHandled[h] = "accepted";
            }
          }
          if (Object.keys(extraHandled).length > 0) {
            await updateHandledAlertHashesBatch(acIdClean, extraHandled);
          }
        }
      } catch (amErr) {
        console.warn("⚠️ AlertMemory update error in handleBulkResolveNoActionFlags:", amErr.message);
      }
    }
    invalidatePrecomputedMemoryCache();

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
    if (!(await isSupabaseControlPlaneActive()) || shouldDualWriteLegacyControlPlaneSheets()) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "TriageLog!A:H", valueInputOption: "USER_ENTERED",
        requestBody: { values: [logRow] },
      });
    }

    if (decision.action === "ACCEPTED") {
      try {
        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const fp = alert.fingerprintHash || buildAlertFingerprint(alert);
        const memRows = await queryAlertMemoryTargeted(sheets, automationCommanderSheetId, { hashes: [fp] });
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

        if (req.body.sessionId) {
          const sRaw = await redisClient?.get(`triage_alerts:${req.body.sessionId}`);
          if (sRaw) {
            const sData = JSON.parse(sRaw);
            applyAlertRemovalToTriageData(sData, targetIds, canRemoveClient);
            await redisClient?.set(`triage_alerts:${req.body.sessionId}`, JSON.stringify(sData), { EX: 86400 * 7 });
          }
        }
        invalidatePrecomputedMemoryCache();
        prunePrecomputedInBackground_({
          targetIds,
          canRemoveClient,
          label: "handleRecordDecision",
        });
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
  const { alerts: alertsToIgnore, ignoreReason, sessionId, automationCommanderSheetId: acId } = req.body;
  if (!alertsToIgnore?.length || !acId) return res.status(400).json({ success: false, error: "Missing alerts or acId" });
  const sessionUser = getSessionUser(req, res);
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const batchHashes = alertsToIgnore.map(a => a?.fingerprintHash || buildAlertFingerprint(a)).filter(Boolean);
    const memoryRows = await queryAlertMemoryTargeted(sheets, acId, { hashes: batchHashes });
    const rowsToAppend = [];
    const rowsToUpdate = [];
    const targetIdsToRemove = [];

    for (const alert of alertsToIgnore) {
      if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin && (!alert?.clientName || !isUserAuthorizedForClient(sessionUser, alert.clientName))) {
        return res.status(403).json({ success: false, error: "Forbidden: Not authorized for one or more alerts in batch." });
      }
      const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);
      if (fingerprintHash) targetIdsToRemove.push(fingerprintHash);
      if (alert.id) targetIdsToRemove.push(alert.id);
      if (alert.sheetName && alert.rowNumber != null) {
        targetIdsToRemove.push(`${alert.sheetName}-${alert.rowNumber}`);
        if (alert.flagType || alert.type) {
          targetIdsToRemove.push(`${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`);
        }
      }
      if (alert.alertKey) targetIdsToRemove.push(alert.alertKey);
      if (alert.legacyAlertKey) targetIdsToRemove.push(alert.legacyAlertKey);
      if (alert.rowIndex != null) targetIdsToRemove.push(String(alert.rowIndex));

      const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
      if (memoryRow && !req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin && (!memoryRow.clientName || !isUserAuthorizedForClient(sessionUser, memoryRow.clientName))) {
        return res.status(403).json({ success: false, error: "Forbidden: Target AlertMemory row belongs to an unauthorized client." });
      }
      const alertSummary = alert.summary?.summary || `${alert.type || "alert"} ${alert.summary?.invoiceNo || ""} £${alert.summary?.amount || ""}`.trim();
      const crmIdentitySnap = alert.type === "crm" ? extractCrmComparisonSnapshot(alert) : null;
      const dataSnapshot = JSON.stringify({
        alertType: alert.type || alert.flagType || "", invoiceNo: alert.summary?.invoiceNo || "",
        amount: String(alert.summary?.amount || ""), vatIncluded: String(alert.summary?.vatIncluded || ""),
        status: String(alert.summary?.status || ""), sentDate: String(alert.summary?.sentDate || ""),
        datePaid: String(alert.summary?.datePaid || ""), client: String(alert.summary?.client || ""),
        job: String(alert.summary?.job || ""), flagType: alert.flagType || "",
        masterSheetId: alert.masterSheetId || "", crmJobName: crmIdentitySnap?.jobName || "",
        crmEndClient: crmIdentitySnap?.clientName || "", crmFields: crmIdentitySnap?.fields || null,
      });
      if (memoryRow && (!memoryRow.clientName || !alert.clientName || matchesClientName(alert.clientName, memoryRow.clientName))) {
        rowsToUpdate.push({ rowIndex: memoryRow.rowIndex, row: { ...memoryRow, status: "ignored", ignoreReason: ignoreReason || "", dataSnapshot } });
      } else {
        rowsToAppend.push({
          fingerprintHash, alertType: alert.type || alert.flagType || "unknown",
          clientName: alert.clientName || "", alertSummary, cachedOptionsJSON: "",
          status: "ignored", ignoreReason: ignoreReason || "", dataSnapshot
        });
      }
    }
    if (rowsToUpdate.length > 0) {
      await updateAlertMemoryRowsBatch(sheets, acId, rowsToUpdate.map(u => ({ rowIndex: u.rowIndex, updates: u.row })));
    }
    if (rowsToAppend.length > 0) {
      await appendAlertMemoryRowsBatch(sheets, acId, rowsToAppend);
    }

    if (targetIdsToRemove.length > 0) {
      const canRemoveClient = (cName) => req.isSystemAuthorized || !sessionUser || sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, cName);
      if (sessionId) {
        try {
          const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
          if (sessionData) {
            const parsed = JSON.parse(sessionData);
            const { removedCount } = applyAlertRemovalToTriageData(parsed, targetIdsToRemove, canRemoveClient);
            if (removedCount > 0) {
              await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });
            }
          }
        } catch (e) { }
      }
      prunePrecomputedInBackground_({
        targetIds: targetIdsToRemove,
        canRemoveClient,
        label: "handleBulkIgnoreAlerts",
      });
    }
    invalidatePrecomputedMemoryCache();

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

function findMatchingProactiveMemoryCandidates_(memoryRows, {
  alertKey,
  fingerprintHash,
  clientName,
  rowIndex,
  alertData,
  sessionUser,
  isSystemAuthorized,
}) {
  const effectiveAlertKey = alertKey || alertData?.alertKey || "";
  const rawLegacyKey = alertData?.legacyAlertKey || alertData?.metadata?.legacyAlertKey || "";
  const legacyFingerprintHash = rawLegacyKey
    ? createHash("sha256").update(rawLegacyKey).digest("hex").substring(0, 16)
    : null;
  const targetAlertType = alertData?.alertType || (effectiveAlertKey ? effectiveAlertKey.split("|")[0] : "");
  const targetStableJobKey = alertData?.stableJobKey || alertData?.metadata?.stableJobKey || "";

  const matchesDateAndRowGuards = (s) => {
    const targetEndDate = alertData?.endDate || alertData?.metadata?.endDate;
    const snapEndDate = s.endDate || s.metadata?.endDate;
    if (targetEndDate && snapEndDate && String(targetEndDate).trim() !== String(snapEndDate).trim()) return false;
    const targetStartDate = alertData?.startDate || alertData?.metadata?.startDate;
    const snapStartDate = s.startDate || s.metadata?.startDate;
    if (targetStartDate && snapStartDate && String(targetStartDate).trim() !== String(snapStartDate).trim()) return false;
    const targetRow = alertData?.confirmedRow ?? alertData?.metadata?.confirmedRow;
    const snapRow = s.confirmedRow ?? s.metadata?.confirmedRow;
    if (targetRow != null && snapRow != null && Number(targetRow) !== Number(snapRow)) return false;
    return true;
  };

  const candidateMatches = memoryRows.filter(r => {
    if (clientName && r.clientName !== clientName) return false;
    if (!isSystemAuthorized && sessionUser && !sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, r.clientName)) return false;
    if (fingerprintHash && r.fingerprintHash === fingerprintHash) return true;
    if (legacyFingerprintHash && r.fingerprintHash === legacyFingerprintHash) return true;
    try {
      const s = JSON.parse(r.dataSnapshot || "{}");
      const snapKey = s.alertKey || "";
      const snapLegacy = s.legacyAlertKey || s.metadata?.legacyAlertKey || "";
      if (effectiveAlertKey && (snapKey === effectiveAlertKey || snapLegacy === effectiveAlertKey)) return true;
      if (rawLegacyKey && (snapKey === rawLegacyKey || snapLegacy === rawLegacyKey)) {
        if (matchesDateAndRowGuards(s)) return true;
      }
      if (targetStableJobKey && (s.stableJobKey === targetStableJobKey || s.metadata?.stableJobKey === targetStableJobKey) && (!targetAlertType || r.alertType === targetAlertType)) {
        if (matchesDateAndRowGuards(s)) return true;
      }
      if (effectiveAlertKey && (effectiveAlertKey.startsWith("autolog_error|") || effectiveAlertKey.startsWith("infinite_loop|")) && snapKey.startsWith(effectiveAlertKey + "|")) {
        return true;
      }
    } catch (e) { }
    if (rowIndex != null && r.rowIndex === Number(rowIndex) && r.category === "proactive" && (!targetAlertType || !r.alertType || r.alertType === targetAlertType || r.alertType === "proactive")) {
      return true;
    }
    return false;
  });

  if (candidateMatches.length > 1) {
    const statusPriority = (s) => {
      if (s === "cached" || s === "pending_automation" || s === "task") return 4;
      if (s === "accepted" || s === "ignored") return 3;
      if (s === "auto_resolved") return 2;
      return 1; // superseded
    };
    const isExactMatch = (r) => {
      if (fingerprintHash && r.fingerprintHash === fingerprintHash) return 1;
      if (effectiveAlertKey) {
        try {
          const s = JSON.parse(r.dataSnapshot || "{}");
          if (s.alertKey === effectiveAlertKey) return 1;
        } catch (e) { }
      }
      return 0;
    };
    candidateMatches.sort((a, b) => {
      const exactDiff = isExactMatch(b) - isExactMatch(a);
      if (exactDiff !== 0) return exactDiff;
      if (legacyFingerprintHash) {
        const aLeg = a.fingerprintHash === legacyFingerprintHash ? 1 : 0;
        const bLeg = b.fingerprintHash === legacyFingerprintHash ? 1 : 0;
        if (aLeg !== bLeg) return bLeg - aLeg;
      }
      if (rowIndex != null) {
        const aMatch = a.rowIndex === Number(rowIndex) ? 1 : 0;
        const bMatch = b.rowIndex === Number(rowIndex) ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
      }
      const sp = statusPriority(b.status) - statusPriority(a.status);
      if (sp !== 0) return sp;
      return (b.rowIndex || 0) - (a.rowIndex || 0);
    });
  }

  return candidateMatches;
}

async function removeResolvedProactiveFromCaches_({ sessionId, targetIds, canRemoveClient }) {
  const activeSessionRedisKey = sessionId ? `triage_alerts:${sessionId}` : null;
  if (redisClient?.isOpen && activeSessionRedisKey) {
    try {
      const sessionData = await redisClient.get(activeSessionRedisKey);
      if (sessionData) {
        const parsed = JSON.parse(sessionData);
        const { removedCount } = applyAlertRemovalToTriageData(parsed, targetIds, canRemoveClient);
        if (removedCount > 0) {
          await redisClient.set(activeSessionRedisKey, JSON.stringify(parsed), { EX: 86400 * 7 });
        }
      }
    } catch (e) { }
  }
  invalidatePrecomputedMemoryCache();

  // Prune PRECOMPUTED_KEY (277 KB) and sweep other active sessions in the background via waitUntil
  if (redisClient?.isOpen) {
    scheduleWaitUntil_(async () => {
      try {
        const preRaw = await redisClient.get(PRECOMPUTED_KEY);
        if (preRaw) {
          const pre = JSON.parse(preRaw);
          const { removedCount } = applyAlertRemovalToTriageData(pre, targetIds, canRemoveClient);
          if (removedCount > 0) {
            await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
          }
        }
      } catch (_) { }

      try {
        const allSessionKeys = await scanRedisKeys("triage_alerts:*");
        const otherKeys = allSessionKeys.filter((sKey) => sKey && sKey !== activeSessionRedisKey);
        for (let i = 0; i < otherKeys.length; i += 10) {
          const chunk = otherKeys.slice(i, i + 10);
          await Promise.all(
            chunk.map(async (sKey) => {
              try {
                const sData = await redisClient.get(sKey);
                if (!sData) return;
                const parsed = JSON.parse(sData);
                const { removedCount } = applyAlertRemovalToTriageData(parsed, targetIds, canRemoveClient);
                if (removedCount > 0) {
                  await redisClient.set(sKey, JSON.stringify(parsed), { EX: 86400 * 7 });
                }
              } catch (_) { }
            })
          );
        }
      } catch (_) { }
    });
  }
}

function getProactiveActivityCategory_(alertKey) {
  const t = String(alertKey || "").toLowerCase();
  if (t.includes("salar") || t.includes("payroll")) return "SALARIES";
  if (t.includes("inv")) return "INVOICES";
  if (t.includes("exp") || t.includes("dir") || t.includes("cost") || t.includes("vendor") || t.includes("out")) return "EXPENSES";
  if (t.includes("crm")) return "CRM";
  if (t.includes("ret")) return "RETAINER";
  return "TRIAGE";
}

export async function handleAcknowledgeProactiveAlert(req, res, sheets) {
  const { alertKey, clientName, sessionId, automationCommanderSheetId: acId, alertData, rowIndex } = req.body;
  const effectiveAlertKey = alertKey || alertData?.alertKey || "";
  if (!effectiveAlertKey || !acId) return res.status(400).json({ success: false, error: "Missing alertKey or automationCommanderSheetId" });
  const sessionUser = getSessionUser(req);
  if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
    if (!clientName || !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client." });
    }
  }
  try {
    const fingerprintHash = createHash("sha256").update(effectiveAlertKey).digest("hex").substring(0, 16);
    const rawLegacyKey = alertData?.legacyAlertKey || alertData?.metadata?.legacyAlertKey || "";
    const legacyFingerprintHash = rawLegacyKey ? createHash("sha256").update(rawLegacyKey).digest("hex").substring(0, 16) : null;

    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await queryAlertMemoryTargeted(sheets, acId, {
      hashes: [fingerprintHash, legacyFingerprintHash].filter(Boolean),
      ...(clientName ? { clientName } : {}),
    });
    const candidateMatches = findMatchingProactiveMemoryCandidates_(memoryRows, {
      alertKey: effectiveAlertKey,
      fingerprintHash,
      clientName,
      rowIndex,
      alertData,
      sessionUser,
      isSystemAuthorized: req.isSystemAuthorized,
    });

    const targetIdsSet = new Set([effectiveAlertKey, fingerprintHash]);
    if (rawLegacyKey) targetIdsSet.add(rawLegacyKey);
    if (legacyFingerprintHash) targetIdsSet.add(legacyFingerprintHash);
    if (rowIndex != null) targetIdsSet.add(String(rowIndex));

    const hashesToMark = new Set([fingerprintHash]);
    if (legacyFingerprintHash) hashesToMark.add(legacyFingerprintHash);

    for (const c of candidateMatches) {
      if (c.fingerprintHash) {
        targetIdsSet.add(c.fingerprintHash);
        hashesToMark.add(c.fingerprintHash);
      }
      if (c.rowIndex != null) targetIdsSet.add(String(c.rowIndex));
      try {
        const s = JSON.parse(c.dataSnapshot || "{}");
        if (s.alertKey) targetIdsSet.add(s.alertKey);
        if (s.legacyAlertKey) targetIdsSet.add(s.legacyAlertKey);
        if (s.metadata?.legacyAlertKey) targetIdsSet.add(s.metadata.legacyAlertKey);
      } catch (_) { }
    }

    if (candidateMatches.length > 0) {
      const primaryRow = candidateMatches[0];
      let snap = {};
      try { snap = JSON.parse(primaryRow.dataSnapshot || "{}"); } catch (e) { }
      if (alertData) snap = { ...snap, ...alertData };

      const batchUpdates = [];
      for (const dup of candidateMatches.slice(1)) {
        if (dup.rowIndex === primaryRow.rowIndex) continue;
        batchUpdates.push({
          rowIndex: dup.rowIndex,
          updates: { ...dup, status: "superseded" },
        });
      }
      batchUpdates.push({
        rowIndex: primaryRow.rowIndex,
        updates: {
          ...primaryRow,
          _previousFingerprintHash: primaryRow.fingerprintHash,
          fingerprintHash,
          status: "accepted",
          clientName: clientName || primaryRow.clientName || "",
          dataSnapshot: JSON.stringify(snap),
        },
      });
      await updateAlertMemoryRowsBatch(sheets, acId, batchUpdates);
    } else {
      const snapStr = alertData ? JSON.stringify(alertData) : "";
      await appendAlertMemoryRow(sheets, acId, {
        fingerprintHash, alertType: alertData?.alertType || effectiveAlertKey.split("|")[0] || "proactive", clientName: clientName || "", alertSummary: "Acknowledged proactive alert",
        cachedOptionsJSON: "", status: "accepted", ignoreReason: "", dataSnapshot: snapStr
      });
    }

    const handledByHash = {};
    for (const h of hashesToMark) {
      if (h) handledByHash[h] = "accepted";
    }
    if (Object.keys(handledByHash).length > 0) {
      await updateHandledAlertHashesBatch(acId, handledByHash);
    }

    const canRemoveClient = (cName) => req.isSystemAuthorized || !sessionUser || sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, cName);
    await removeResolvedProactiveFromCaches_({ sessionId, targetIds: Array.from(targetIdsSet), canRemoveClient });

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: clientName || "",
      category: getProactiveActivityCategory_(effectiveAlertKey),
      action: "Proactive Alert Acknowledged",
      summary: `Acknowledged proactive alert (${effectiveAlertKey}) for ${clientName || "Client"}`,
      details: { alertKey: effectiveAlertKey, clientName }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleResolveProactiveAlert(req, res, sheets) {
  const { alertKey, clientName, sessionId, resolution, automationCommanderSheetId: acId, alertData, rowIndex } = req.body;
  const effectiveAlertKey = alertKey || alertData?.alertKey || "";
  if (!effectiveAlertKey || !acId) return res.status(400).json({ success: false, error: "Missing alertKey or automationCommanderSheetId" });
  const sessionUser = getSessionUser(req);
  if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
    if (!clientName || !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client." });
    }
  }
  try {
    const fingerprintHash = createHash("sha256").update(effectiveAlertKey).digest("hex").substring(0, 16);
    const rawLegacyKey = alertData?.legacyAlertKey || alertData?.metadata?.legacyAlertKey || "";
    const legacyFingerprintHash = rawLegacyKey ? createHash("sha256").update(rawLegacyKey).digest("hex").substring(0, 16) : null;

    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await queryAlertMemoryTargeted(sheets, acId, {
      hashes: [fingerprintHash, legacyFingerprintHash].filter(Boolean),
      ...(clientName ? { clientName } : {}),
    });
    const candidateMatches = findMatchingProactiveMemoryCandidates_(memoryRows, {
      alertKey: effectiveAlertKey,
      fingerprintHash,
      clientName,
      rowIndex,
      alertData,
      sessionUser,
      isSystemAuthorized: req.isSystemAuthorized,
    });

    const targetIdsSet = new Set([effectiveAlertKey, fingerprintHash]);
    if (rawLegacyKey) targetIdsSet.add(rawLegacyKey);
    if (legacyFingerprintHash) targetIdsSet.add(legacyFingerprintHash);
    if (rowIndex != null) targetIdsSet.add(String(rowIndex));

    const hashesToMark = new Set([fingerprintHash]);
    if (legacyFingerprintHash) hashesToMark.add(legacyFingerprintHash);

    for (const c of candidateMatches) {
      if (c.fingerprintHash) {
        targetIdsSet.add(c.fingerprintHash);
        hashesToMark.add(c.fingerprintHash);
      }
      if (c.rowIndex != null) targetIdsSet.add(String(c.rowIndex));
      try {
        const s = JSON.parse(c.dataSnapshot || "{}");
        if (s.alertKey) targetIdsSet.add(s.alertKey);
        if (s.legacyAlertKey) targetIdsSet.add(s.legacyAlertKey);
        if (s.metadata?.legacyAlertKey) targetIdsSet.add(s.metadata.legacyAlertKey);
      } catch (_) { }
    }

    if (candidateMatches.length > 0) {
      const primaryRow = candidateMatches[0];
      let snapObj = {};
      try { snapObj = JSON.parse(primaryRow.dataSnapshot || "{}"); } catch (e) { }
      if (alertData) snapObj = { ...snapObj, ...alertData };
      snapObj.resolution = resolution;

      const batchUpdates = [];
      for (const dup of candidateMatches.slice(1)) {
        if (dup.rowIndex === primaryRow.rowIndex) continue;
        batchUpdates.push({
          rowIndex: dup.rowIndex,
          updates: { ...dup, status: "superseded" },
        });
      }
      batchUpdates.push({
        rowIndex: primaryRow.rowIndex,
        updates: {
          ...primaryRow,
          _previousFingerprintHash: primaryRow.fingerprintHash,
          fingerprintHash,
          status: "accepted",
          clientName: clientName || primaryRow.clientName || "",
          dataSnapshot: JSON.stringify(snapObj),
        },
      });
      await updateAlertMemoryRowsBatch(sheets, acId, batchUpdates);
    } else {
      const snapObj = alertData ? { ...alertData, resolution } : { resolution };
      await appendAlertMemoryRow(sheets, acId, {
        fingerprintHash, alertType: alertData?.alertType || effectiveAlertKey.split("|")[0] || "proactive", clientName: clientName || "", alertSummary: resolution || "Resolved proactive alert",
        cachedOptionsJSON: "", status: "accepted", ignoreReason: "", dataSnapshot: JSON.stringify(snapObj)
      });
    }

    const handledByHash = {};
    for (const h of hashesToMark) {
      if (h) handledByHash[h] = "accepted";
    }
    if (Object.keys(handledByHash).length > 0) {
      await updateHandledAlertHashesBatch(acId, handledByHash);
    }

    const canRemoveClient = (cName) => req.isSystemAuthorized || !sessionUser || sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, cName);
    await removeResolvedProactiveFromCaches_({ sessionId, targetIds: Array.from(targetIdsSet), canRemoveClient });

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: clientName || "",
      category: getProactiveActivityCategory_(effectiveAlertKey),
      action: "Proactive Alert Resolved",
      summary: `Resolved proactive alert (${effectiveAlertKey}) for ${clientName || "Client"}: ${resolution || "Resolved"}`,
      details: { alertKey: effectiveAlertKey, resolution, clientName }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleBulkAcknowledgeProactiveAlerts(req, res, sheets) {
  const { alertKeys = [], alerts: rawAlerts = [], clientName, sessionId, automationCommanderSheetId: acId } = req.body;
  const itemsToProcess = [];
  const seenKeys = new Set();
  if (Array.isArray(rawAlerts) && rawAlerts.length > 0) {
    for (const a of rawAlerts) {
      if (!a) continue;
      const k = a.alertKey || "";
      if (k) seenKeys.add(k);
      itemsToProcess.push({
        alertKey: k,
        alertData: a,
        rowIndex: a.rowIndex ?? null,
        clientName: a.clientName || clientName || "",
      });
    }
  }
  if (Array.isArray(alertKeys)) {
    for (const k of alertKeys) {
      if (!k || seenKeys.has(k)) continue;
      seenKeys.add(k);
      itemsToProcess.push({
        alertKey: k,
        alertData: null,
        rowIndex: null,
        clientName: clientName || "",
      });
    }
  }

  if (itemsToProcess.length === 0 || !acId) {
    return res.status(400).json({ success: false, error: "Missing alertKeys or automationCommanderSheetId" });
  }
  const sessionUser = getSessionUser(req);
  if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
    for (const item of itemsToProcess) {
      const targetClient = item.clientName || clientName;
      if (!targetClient || !isUserAuthorizedForClient(sessionUser, targetClient)) {
        return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client." });
      }
    }
  }
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const bulkHashes = new Set();
    const bulkClients = new Set();
    if (clientName) bulkClients.add(clientName);
    for (const item of itemsToProcess) {
      const ek = item.alertKey || item.alertData?.alertKey || "";
      const lk = item.alertData?.legacyAlertKey || item.alertData?.metadata?.legacyAlertKey || "";
      if (ek) bulkHashes.add(createHash("sha256").update(ek).digest("hex").substring(0, 16));
      if (lk) bulkHashes.add(createHash("sha256").update(lk).digest("hex").substring(0, 16));
      if (item.alertData?.fingerprintHash) bulkHashes.add(item.alertData.fingerprintHash);
      if (item.clientName) bulkClients.add(item.clientName);
    }
    const memoryRows = await queryAlertMemoryTargeted(sheets, acId, {
      hashes: [...bulkHashes],
      clientNames: [...bulkClients],
    });
    const hashesToRemoveSet = new Set();
    const hashesToMarkHandled = {};
    const updateBatchItems = [];
    const appendItems = [];
    const queuedRowIndices = new Set();

    for (const item of itemsToProcess) {
      const effectiveAlertKey = item.alertKey || item.alertData?.alertKey || "";
      const fingerprintHash = effectiveAlertKey ? createHash("sha256").update(effectiveAlertKey).digest("hex").substring(0, 16) : (item.alertData?.fingerprintHash || "");
      const rawLegacyKey = item.alertData?.legacyAlertKey || item.alertData?.metadata?.legacyAlertKey || "";
      const legacyFingerprintHash = rawLegacyKey ? createHash("sha256").update(rawLegacyKey).digest("hex").substring(0, 16) : null;

      if (effectiveAlertKey) hashesToRemoveSet.add(effectiveAlertKey);
      if (rawLegacyKey) hashesToRemoveSet.add(rawLegacyKey);
      if (fingerprintHash) {
        hashesToRemoveSet.add(fingerprintHash);
        hashesToMarkHandled[fingerprintHash] = "accepted";
      }
      if (legacyFingerprintHash) {
        hashesToRemoveSet.add(legacyFingerprintHash);
        hashesToMarkHandled[legacyFingerprintHash] = "accepted";
      }
      if (item.rowIndex != null) hashesToRemoveSet.add(String(item.rowIndex));

      const candidateMatches = findMatchingProactiveMemoryCandidates_(memoryRows, {
        alertKey: effectiveAlertKey,
        fingerprintHash,
        clientName: item.clientName || clientName,
        rowIndex: item.rowIndex,
        alertData: item.alertData,
        sessionUser,
        isSystemAuthorized: req.isSystemAuthorized,
      });

      for (const c of candidateMatches) {
        if (c.fingerprintHash) {
          hashesToRemoveSet.add(c.fingerprintHash);
          hashesToMarkHandled[c.fingerprintHash] = "accepted";
        }
        if (c.rowIndex != null) hashesToRemoveSet.add(String(c.rowIndex));
        try {
          const s = JSON.parse(c.dataSnapshot || "{}");
          if (s.alertKey) hashesToRemoveSet.add(s.alertKey);
          if (s.legacyAlertKey) hashesToRemoveSet.add(s.legacyAlertKey);
          if (s.metadata?.legacyAlertKey) hashesToRemoveSet.add(s.metadata.legacyAlertKey);
        } catch (_) { }
      }

      if (candidateMatches.length > 0) {
        const primaryRow = candidateMatches[0];
        let snap = {};
        try { snap = JSON.parse(primaryRow.dataSnapshot || "{}"); } catch (e) { }
        if (item.alertData) snap = { ...snap, ...item.alertData };

        // Supersede duplicates first so primaryRow remains authoritative
        for (const dup of candidateMatches.slice(1)) {
          if (dup.rowIndex === primaryRow.rowIndex || queuedRowIndices.has(dup.rowIndex)) continue;
          queuedRowIndices.add(dup.rowIndex);
          updateBatchItems.push({
            rowIndex: dup.rowIndex,
            updates: {
              ...dup,
              status: "superseded"
            }
          });
        }
        if (!queuedRowIndices.has(primaryRow.rowIndex)) {
          queuedRowIndices.add(primaryRow.rowIndex);
          updateBatchItems.push({
            rowIndex: primaryRow.rowIndex,
            updates: {
              ...primaryRow,
              _previousFingerprintHash: primaryRow.fingerprintHash,
              fingerprintHash: fingerprintHash || primaryRow.fingerprintHash,
              status: "accepted",
              clientName: item.clientName || clientName || primaryRow.clientName || "",
              ...(item.alertData ? { dataSnapshot: JSON.stringify(snap) } : {}),
            }
          });
        }
      } else if (fingerprintHash) {
        appendItems.push({
          fingerprintHash,
          alertType: item.alertData?.alertType || (effectiveAlertKey ? effectiveAlertKey.split("|")[0] : "") || "proactive",
          clientName: item.clientName || clientName || "",
          alertSummary: "Acknowledged proactive alert",
          cachedOptionsJSON: "",
          status: "accepted",
          ignoreReason: "",
          dataSnapshot: item.alertData ? JSON.stringify(item.alertData) : "",
        });
      }
    }

    if (updateBatchItems.length > 0) {
      await updateAlertMemoryRowsBatch(sheets, acId, updateBatchItems);
    }
    if (appendItems.length > 0) {
      await appendAlertMemoryRowsBatch(sheets, acId, appendItems);
    }
    if (Object.keys(hashesToMarkHandled).length > 0) {
      await updateHandledAlertHashesBatch(acId, hashesToMarkHandled);
    }

    const canRemoveClient = (cName) => req.isSystemAuthorized || !sessionUser || sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, cName);
    await removeResolvedProactiveFromCaches_({ sessionId, targetIds: Array.from(hashesToRemoveSet), canRemoveClient });

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: clientName || "",
      category: "TRIAGE",
      action: "Proactive Alerts Acknowledged",
      summary: `Acknowledged ${itemsToProcess.length} proactive alerts for ${clientName || "Client"}`,
      details: { alertKeysCount: itemsToProcess.length, clientName }
    });

    return res.status(200).json({ success: true, count: itemsToProcess.length });
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
    const memoryRows = await queryAlertMemoryTargeted(sheets, automationCommanderSheetId, {
      hashes: [fingerprintHash],
    });
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    if (!memoryRow) return res.status(404).json({ success: false, error: "Alert not found in memory" });
    if (!req.isSystemAuthorized && (!sessionUser || (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, memoryRow.clientName)))) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client's alert." });
    }

    if (memoryRow.cachedOptionsJSON) {
      await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
        ...memoryRow, status: "cached", ignoreReason: "",
      });
    } else if (await isSupabaseControlPlaneActive()) {
      await deleteAlertMemoryEntryByHash(sheets, automationCommanderSheetId, fingerprintHash);
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
    const memoryRows = await queryAlertMemoryTargeted(sheets, automationCommanderSheetId, {
      statuses: ["ignored", "superseded"],
    });
    let ignoredAlerts = memoryRows
      .filter(r => r.status === "ignored" || (r.status === "superseded" && r.ignoreReason))
      .map(r => ({
        fingerprintHash: r.fingerprintHash,
        alertType: r.alertType,
        clientName: r.clientName,
        alertSummary: r.alertSummary,
        ignoreReason: r.ignoreReason,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        status: r.status,
      }));

    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
    }
    if (!sessionUser.isAdmin) {
      const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      const allowSalaries = canViewSalariesAndDividends(sessionUser);
      ignoredAlerts = ignoredAlerts.filter(a =>
        assignedList.some(assigned => matchesClientName(assigned, a.clientName)) &&
        !ADMIN_ONLY_ALERT_TYPES.has(a.alertType) &&
        (allowSalaries || a.alertType !== "salary_forecast_in_actual_month")
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
    const [all, handledMap, excludedClientNamesSet] = await Promise.all([
      queryAlertMemoryTargeted(sheets, acId, {
        category: "proactive",
        ...(req.body?.clientName ? { clientName: req.body.clientName } : {}),
      }),
      readHandledAlertHashes(sheets, acId, false),
      getExcludedClientNamesSet(),
    ]);
    const isClientExcluded = (name) => excludedClientNamesSet.has(String(name || "").trim().toLowerCase());
    const PROACTIVE_HANDLED_STATUSES = new Set(["accepted", "ignored", "task", "task_resolved", "superseded"]);
    const metaFields = [
      "jobName", "endClientName", "confirmedRow", "revenue", "startDate", "endDate",
      "frequencyDays", "lastInvoiceDate", "expectedByDate", "timestamp", "sequenceType", "summary", "jobInfo", "detailsSnippet",
      "childRowNum", "clientJobStr", "pipelineRow", "likelihood", "copiedToConf", "jobType",
      "possibleMatchInvoiceNo", "possibleMatchAmount", "possibleMatchSentDate", "possibleMatchConfidence", "possibleMatchConfirmedRow", "possibleMatchVatAmount", "possibleMatchStatus", "possibleMatchCase",
      "uninvoicedAmount", "projectCode", "draftCount", "draftTotal", "stableJobKey", "isRetainer", "tab",
      "directCosts", "unreceivedAmount", "placeholderCount", "placeholderTotal",
      "feeRevenue", "rechargedExpenses", "billableBudget", "feeInvoiced", "rechargedInvoiced", "uninvoicedFee", "uninvoicedRecharged", "rechargedDiff",
      "totalInvoiced", "totalExpenses", "diff", "childExp", "expectedForRow",
      "categoryName", "cleanName", "quarantineRow",
      "slotNum", "invoiceRef", "amount", "sentDate",
      "errorSnippet", "occurrenceCount", "category", "rawSnippet", "entityKey", "fieldName", "transition1", "transition2", "conflictType", "suggestion", "rawLogSnippet", "invoiceNo"
    ];

    let active = all
      .filter(r => {
        if (isClientExcluded(r.clientName)) return false;
        if (r.category !== "proactive" || r.status !== "cached" || !KNOWN_PROACTIVE_ALERT_TYPES.has(r.alertType)) return false;
        if (r.fingerprintHash && PROACTIVE_HANDLED_STATUSES.has(handledMap?.[r.fingerprintHash])) return false;
        return true;
      })
      .map(r => {
        let alert = {};
        try { alert = JSON.parse(r.dataSnapshot || "{}"); } catch (e) { alert = {}; }
        const metadata = { ...(alert.metadata || {}) };
        for (const f of metaFields) { if (alert[f] !== undefined) metadata[f] = alert[f]; }
        return {
          ...alert,
          fingerprintHash: r.fingerprintHash,
          rowIndex: r.rowIndex,
          clientName: alert.clientName || r.clientName,
          alertType: alert.alertType || r.alertType,
          metadata,
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen
        };
      })
      .filter(a => {
        if (isClientExcluded(a.clientName)) return false;
        if (!handledMap) return true;
        if (a.fingerprintHash && PROACTIVE_HANDLED_STATUSES.has(handledMap[a.fingerprintHash])) return false;
        if (a.alertKey) {
          const keyHash = createHash("sha256").update(a.alertKey).digest("hex").substring(0, 16);
          if (PROACTIVE_HANDLED_STATUSES.has(handledMap[keyHash])) return false;
        }
        const legKey = a.legacyAlertKey || a.metadata?.legacyAlertKey;
        if (legKey) {
          const legHash = createHash("sha256").update(legKey).digest("hex").substring(0, 16);
          if (PROACTIVE_HANDLED_STATUSES.has(handledMap[legHash])) return false;
        }
        return true;
      });

    // Precedence rule: "uninvoiced_revenue" takes precedence over "uninvoiced_new_job" for the same job
    const completedRevenueKeys = new Set();
    all.forEach(r => {
      if (r.alertType === "uninvoiced_revenue" && (r.status === "cached" || r.status === "task" || r.status === "accepted" || r.status === "pending_automation")) {
        try {
          const snap = JSON.parse(r.dataSnapshot || "{}");
          const jobKey = snap.stableJobKey || snap.metadata?.stableJobKey;
          if (jobKey) completedRevenueKeys.add(`${r.clientName}:::${jobKey}`);
        } catch (e) { }
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
      const allowSalaries = canViewSalariesAndDividends(sessionUser);
      active = active.filter(a => {
        if (!allowSalaries && a.alertType === "salary_forecast_in_actual_month") return false;
        return assignedList.some(assigned => matchesClientName(assigned, a.clientName)) &&
          !ADMIN_ONLY_ALERT_TYPES.has(a.alertType);
      });
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
                  } catch (e) { }
                }
              }
            }
          }
        }
        if (memoryUpdates.length > 0) {
          await updateAlertMemoryRowsBatch(sheets, acId, memoryUpdates).catch(() => { });
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