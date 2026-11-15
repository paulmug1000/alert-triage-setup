import { createHash } from "crypto";
import { waitUntil } from "@vercel/functions";
import { redisClient } from "./redisClient";
import {
  buildAlertFingerprint, ensureAlertMemoryTab, readAlertMemory,
  findMemoryRow, updateAlertMemoryRow, updateAlertMemoryRowsBatch, appendAlertMemoryRow,
  appendAlertMemoryRowsBatch, updateHandledAlertHash, updateHandledAlertHashesBatch,
  updateAlertMemoryCacheInPlace
} from "./alertMemory";
import { logPmaActivity } from "./pmaLogger";
import { getSessionUser } from "./authService";
import { matchesClientName, isUserAuthorizedForClient } from "./userPermissions";
import { ADMIN_ONLY_ALERT_TYPES, KNOWN_PROACTIVE_ALERT_TYPES } from "../utils/helpers";
import { restoreAlertToCacheAndSession, applyAlertRemovalToTriageData, PRECOMPUTED_KEY } from "./alertState";
import { invalidatePrecomputedMemoryCache } from "./triageEngine";

function findMatchingTaskMemoryCandidates_(memoryRows, {
  fingerprintHash,
  legacyHash,
  alertKey,
  legacyAlertKey,
  rowIndex,
  clientName,
  alertType,
  isProactive,
}) {
  if (!Array.isArray(memoryRows) || memoryRows.length === 0) return [];
  const matches = memoryRows.filter(r => {
    if (clientName && r.clientName && r.clientName !== clientName) return false;
    if (fingerprintHash && r.fingerprintHash === fingerprintHash) return true;
    if (legacyHash && r.fingerprintHash === legacyHash) return true;
    if (isProactive || alertKey || legacyAlertKey) {
      try {
        const s = JSON.parse(r.dataSnapshot || "{}");
        const snapKey = s.alertKey || s.proactiveAlertKey || "";
        const snapLegacy = s.legacyAlertKey || s.metadata?.legacyAlertKey || "";
        if (alertKey && (snapKey === alertKey || snapLegacy === alertKey)) return true;
        if (legacyAlertKey && (snapKey === legacyAlertKey || snapLegacy === legacyAlertKey)) return true;
      } catch (_) { }
      if (rowIndex != null && r.rowIndex === Number(rowIndex) && r.category === "proactive" && (!alertType || !r.alertType || r.alertType === alertType || r.alertType === "proactive")) {
        return true;
      }
    }
    return false;
  });

  if (matches.length > 1) {
    matches.sort((a, b) => {
      const aExact = a.fingerprintHash === fingerprintHash ? 1 : 0;
      const bExact = b.fingerprintHash === fingerprintHash ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      if (legacyHash) {
        const aLeg = a.fingerprintHash === legacyHash ? 1 : 0;
        const bLeg = b.fingerprintHash === legacyHash ? 1 : 0;
        if (aLeg !== bLeg) return bLeg - aLeg;
      }
      return (b.rowIndex || 0) - (a.rowIndex || 0);
    });
  }
  return matches;
}

async function pruneTaskAlertsFromRedisCaches_({ sessionId, targetIds, canRemoveClient }) {
  if (!targetIds || targetIds.length === 0) return;
  if (sessionId) {
    try {
      const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
      if (sessionData) {
        const parsed = JSON.parse(sessionData);
        const { removedCount } = applyAlertRemovalToTriageData(parsed, targetIds, canRemoveClient);
        if (removedCount > 0) {
          await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });
        }
      }
    } catch (e) { }
  }
  try {
    const preRaw = await redisClient.get(PRECOMPUTED_KEY);
    if (preRaw) {
      const pre = JSON.parse(preRaw);
      const { removedCount } = applyAlertRemovalToTriageData(pre, targetIds, canRemoveClient);
      if (removedCount > 0) {
        await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
      }
    }
  } catch (e) { }
  invalidatePrecomputedMemoryCache();
}

let _tasksMemoryCache = null;
let _tasksCachedAt = 0;

export async function updateTasksInCache(taskRows, remove = false) {
  const rows = Array.isArray(taskRows) ? taskRows : [taskRows];
  if (rows.length === 0) return;
  const now = Date.now();
  let tasks = _tasksMemoryCache;
  if (!tasks && redisClient?.isOpen) {
    try {
      const cached = await redisClient.get("triage_tasks_cache");
      if (cached) tasks = JSON.parse(cached);
    } catch (e) {}
  }
  if (!tasks) tasks = [];

  for (const updatedTaskRow of rows) {
    if (!updatedTaskRow || !updatedTaskRow.fingerprintHash) continue;
    const idx = tasks.findIndex(t => t.fingerprintHash === updatedTaskRow.fingerprintHash);
    if (remove) {
      if (idx !== -1) tasks.splice(idx, 1);
    } else {
      if (idx !== -1) {
        tasks[idx] = { ...tasks[idx], ...updatedTaskRow };
      } else {
        tasks.push(updatedTaskRow);
      }
    }
  }
  _tasksMemoryCache = tasks;
  _tasksCachedAt = now;
  if (redisClient?.isOpen) {
    try {
      await redisClient.set("triage_tasks_cache", JSON.stringify(tasks), { EX: 86400 * 7 });
    } catch (e) {}
  }
}

export async function updateTaskInCache(updatedTaskRow, remove = false) {
  return updateTasksInCache([updatedTaskRow], remove);
}

export async function invalidateTasksCache() {
  _tasksMemoryCache = null;
  _tasksCachedAt = 0;
  if (redisClient?.isOpen) {
    try {
      await redisClient.del("triage_tasks_cache");
    } catch (e) {}
  }
}

export async function handleBulkCreateTasks(req, res, sheets) {
  const { alerts: alertsToTask, taskNote, snoozedUntil, automationCommanderSheetId: acId, sessionId } = req.body;
  if (!alertsToTask?.length || !acId) return res.status(400).json({ success: false, error: "Missing alerts or automationCommanderSheetId" });

  const sessionUser = getSessionUser(req);
  if (!sessionUser) return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });

  const createdByEmail = sessionUser.email || "";
  const createdByName = sessionUser.name || (sessionUser.email ? sessionUser.email.split("@")[0] : "");
  const now = new Date().toISOString();

  try {
    const results = [];
    const createdTaskRows = [];
    const taskMetaEntries = [];
    const statusByHash = {};
    const targetIdsToRemove = [];

    for (const alert of alertsToTask) {
      if (!sessionUser.isAdmin && (!alert.clientName || !isUserAuthorizedForClient(sessionUser, alert.clientName))) {
        results.push({ fingerprintHash: alert.fingerprintHash || null, error: "Access denied to this client" });
        continue;
      }
      try {
        const rawAlertKey = alert.alertKey || alert.proactiveAlertKey || "";
        const fingerprintHash = alert.fingerprintHash || (rawAlertKey ? createHash("sha256").update(rawAlertKey).digest("hex").substring(0, 16) : null) || buildAlertFingerprint(alert);
        const rawLegacyKey = alert.legacyAlertKey || alert.metadata?.legacyAlertKey || "";
        const legacyHash = rawLegacyKey ? createHash("sha256").update(rawLegacyKey).digest("hex").substring(0, 16) : null;
        const alertType = alert.type || alert.flagType || alert.alertType || "";
        const isProactiveAlert = Boolean(alert.isProactive || rawAlertKey || KNOWN_PROACTIVE_ALERT_TYPES.has(alertType));
        const isInfoAlert = Boolean(alert.isInfo || alert.category === "informational");
        const category = isProactiveAlert ? "proactive" : (isInfoAlert ? "informational" : "discrepancy");

        const taskRef = `TASK-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
        const taskKey = `${alert.clientName}||${alertType || "alert"}||${taskRef}`;
        const alertSummary = alert.summary?.summary || alert.heading || `${alertType || "alert"} ${alert.summary?.invoiceNo || ""} £${alert.summary?.amount || ""}`.trim();
        const isAdminOnly = ADMIN_ONLY_ALERT_TYPES.has(alertType);

        const taskRow = {
          fingerprintHash, alertType: alertType || "unknown",
          clientName: alert.clientName || "", alertSummary,
          cachedOptionsJSON: "",
          status: "task", taskNote: taskNote || "", taskKey,
          snoozedUntil: snoozedUntil || "",
          category,
          dataSnapshot: JSON.stringify({
            alertType,
            flagType: alert.flagType || "",
            masterSheetId: alert.masterSheetId || "",
            taskNote: taskNote || "",
            taskCreatedAt: now,
            createdByEmail,
            createdByName,
            isAdminOnly,
            taskKey,
            snoozedUntil: snoozedUntil || "",
            isProactive: isProactiveAlert,
            proactiveAlertKey: rawAlertKey,
            alertKey: rawAlertKey || undefined,
            legacyAlertKey: rawLegacyKey || undefined,
            alertData: JSON.stringify(alert),
          }),
        };

        createdTaskRows.push(taskRow);
        taskMetaEntries.push({
          taskRow,
          fingerprintHash,
          legacyHash,
          alertKey: rawAlertKey,
          legacyAlertKey: rawLegacyKey,
          rowIndex: alert.rowIndex ?? null,
          clientName: alert.clientName || "",
          alertType,
          isProactive: isProactiveAlert,
        });
        statusByHash[fingerprintHash] = "task";
        if (legacyHash) statusByHash[legacyHash] = "task";

        targetIdsToRemove.push(fingerprintHash);
        if (legacyHash) targetIdsToRemove.push(legacyHash);
        if (rawAlertKey) targetIdsToRemove.push(rawAlertKey);
        if (rawLegacyKey) targetIdsToRemove.push(rawLegacyKey);
        if (alert.id) targetIdsToRemove.push(alert.id);
        if (alert.rowIndex != null) targetIdsToRemove.push(String(alert.rowIndex));
        if (alert.sheetName && alert.rowNumber != null) {
          targetIdsToRemove.push(`${alert.sheetName}-${alert.rowNumber}`);
          if (alert.flagType || alert.type) {
            targetIdsToRemove.push(`${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`);
          }
        }

        results.push({ fingerprintHash, taskKey });
      } catch (alertErr) {
        results.push({ fingerprintHash: null, error: alertErr.message });
      }
    }

    if (createdTaskRows.length > 0) {
      await updateTasksInCache(createdTaskRows);
      await updateHandledAlertHashesBatch(acId, statusByHash);
      await updateAlertMemoryCacheInPlace(acId, (cache) => {
        for (const meta of taskMetaEntries) {
          const matchedRows = findMatchingTaskMemoryCandidates_(cache, meta);
          for (const row of matchedRows) {
            row.status = "task";
            row.ignoreReason = "";
            row.snoozedUntil = snoozedUntil || row.snoozedUntil || "";
          }
        }
      });
      const canRemoveClient = (cName) => sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, cName);
      await pruneTaskAlertsFromRedisCaches_({ sessionId, targetIds: targetIdsToRemove, canRemoveClient });
    }

    const syncBulkToSheets = async () => {
      try {
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);
        const toUpdate = [];
        const toAppend = [];
        const queuedRowIndices = new Set();

        for (const meta of taskMetaEntries) {
          const { taskRow } = meta;
          const candidates = findMatchingTaskMemoryCandidates_(memoryRows, meta);
          if (candidates.length > 0) {
            const primaryRow = candidates[0];
            for (const dup of candidates.slice(1)) {
              if (dup.rowIndex === primaryRow.rowIndex || queuedRowIndices.has(dup.rowIndex)) continue;
              queuedRowIndices.add(dup.rowIndex);
              toUpdate.push({
                rowIndex: dup.rowIndex,
                updates: { ...dup, status: "superseded" },
              });
            }
            if (!queuedRowIndices.has(primaryRow.rowIndex)) {
              queuedRowIndices.add(primaryRow.rowIndex);
              let prevSnap = {};
              try { prevSnap = JSON.parse(primaryRow.dataSnapshot || "{}"); } catch (_) { }
              let newSnap = {};
              try { newSnap = JSON.parse(taskRow.dataSnapshot || "{}"); } catch (_) { }
              toUpdate.push({
                rowIndex: primaryRow.rowIndex,
                updates: {
                  ...primaryRow,
                  ...taskRow,
                  _previousFingerprintHash: primaryRow.fingerprintHash,
                  cachedOptionsJSON: primaryRow.cachedOptionsJSON || "",
                  dataSnapshot: JSON.stringify({ ...prevSnap, ...newSnap }),
                }
              });
            }
          } else {
            toAppend.push(taskRow);
          }
        }

        if (toUpdate.length > 0) {
          await updateAlertMemoryRowsBatch(sheets, acId, toUpdate);
        }
        if (toAppend.length > 0) {
          await appendAlertMemoryRowsBatch(sheets, acId, toAppend);
        }

        const createdCount = results.filter(r => r.taskKey).length;
        if (createdCount > 0) {
          logPmaActivity(sheets, {
            automationCommanderSheetId: acId,
            clientName: alertsToTask[0]?.clientName || "",
            category: "TRIAGE",
            action: "Tasks Created",
            summary: `Bulk created ${createdCount} task${createdCount > 1 ? "s" : ""}: ${taskNote || "Alert Tasks"}`,
            details: { count: createdCount, taskNote, clientName: alertsToTask[0]?.clientName, createdBy: createdByEmail }
          });
        }
      } catch (bgErr) {
        console.error("❌ Background sheet persist failed for bulk tasks:", bgErr.message);
      }
    };

    if (typeof waitUntil === "function") {
      waitUntil(syncBulkToSheets());
    } else {
      syncBulkToSheets();
    }

    return res.status(200).json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCreateTask(req, res, sheets) {
  const { alert, taskNote, snoozedUntil, automationCommanderSheetId: acId, isProactive, proactiveAlertKey, isInfo, sessionId } = req.body;
  if (!alert || !acId) return res.status(400).json({ success: false, error: "Missing alert or automationCommanderSheetId" });

  const sessionUser = getSessionUser(req);
  if (!sessionUser) return res.status(401).json({ success: false, error: "Unauthorized" });
  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, alert.clientName)) {
    return res.status(403).json({ success: false, error: "Access denied to this client" });
  }

  const alertType = alert.type || alert.flagType || alert.alertType || "";
  const isAdminOnly = ADMIN_ONLY_ALERT_TYPES.has(alertType);
  if (!sessionUser.isAdmin && isAdminOnly) {
    return res.status(403).json({ success: false, error: "Access denied: cannot create task for Admin-only alert" });
  }

  const createdByEmail = sessionUser.email || "";
  const createdByName = sessionUser.name || (sessionUser.email ? sessionUser.email.split("@")[0] : "");

  try {
    const effectiveAlertKey = proactiveAlertKey || alert.alertKey || "";
    const fingerprintHash = alert.fingerprintHash || (effectiveAlertKey ? createHash("sha256").update(effectiveAlertKey).digest("hex").substring(0, 16) : null) || buildAlertFingerprint(alert);
    const rawLegacyKey = alert.legacyAlertKey || alert.metadata?.legacyAlertKey || "";
    const legacyHash = rawLegacyKey ? createHash("sha256").update(rawLegacyKey).digest("hex").substring(0, 16) : null;
    const effectiveIsProactive = Boolean(isProactive || effectiveAlertKey || KNOWN_PROACTIVE_ALERT_TYPES.has(alertType));
    const now = new Date().toISOString();

    const taskRef = alert.summary?.invoiceNo || alert.summary?.reference || alert.summary?.jobName || effectiveAlertKey || fingerprintHash.slice(0, 8);
    const taskKey = `${alert.clientName}||${alert.type || alert.flagType || "alert"}||${taskRef}`;

    // Fast duplicate check against in-memory / Redis tasks cache (< 5ms)
    let currentTasks = _tasksMemoryCache;
    if (!currentTasks && redisClient?.isOpen) {
      try {
        const cached = await redisClient.get("triage_tasks_cache");
        if (cached) currentTasks = JSON.parse(cached);
      } catch (e) {}
    }
    if (currentTasks) {
      const existingTask = currentTasks.find(r => r.status === "task" && (r.taskKey === taskKey || r.fingerprintHash === fingerprintHash));
      if (existingTask) {
        return res.status(409).json({ success: false, error: "A task already exists for this alert", existingTaskHash: existingTask.fingerprintHash });
      }
    }

    const alertSummary = alert.summary?.summary || alert.heading || `${alert.type || alert.flagType || alert.alertType || "alert"} ${alert.summary?.invoiceNo || alert.summary?.reference || ""} ${alert.summary?.amount ? "£" + alert.summary.amount : ""}`.trim();

    const alertFieldsSnapshot = {
      alertType,
      invoiceNo:     alert.summary?.invoiceNo     || "",
      reference:     alert.summary?.reference     || "",
      amount:        String(alert.summary?.amount || ""),
      status:        alert.summary?.status        || "",
      flagType:      alert.flagType               || "",
      masterSheetId: alert.masterSheetId          || "",
      taskKey,
    };

    const taskMeta = {
      taskNote:          taskNote || "",
      taskCreatedAt:     now,
      createdByEmail,
      createdByName,
      isAdminOnly,
      snoozedUntil:      snoozedUntil || "",
      furtherNotes:      [], 
      taskKey,
      isProactive:       effectiveIsProactive,
      proactiveAlertKey: effectiveAlertKey,
      alertKey:          effectiveAlertKey || undefined,
      legacyAlertKey:    rawLegacyKey || undefined,
      alertData:         JSON.stringify(alert), 
    };

    const createdRow = {
      fingerprintHash,
      alertType: alertType || "alert",
      clientName: alert.clientName || "",
      alertSummary,
      cachedOptionsJSON: "",
      status: "task",
      snoozedUntil: snoozedUntil || "",
      ignoreReason: "",
      category: effectiveIsProactive ? "proactive" : (isInfo ? "informational" : "discrepancy"),
      dataSnapshot: JSON.stringify({ ...alertFieldsSnapshot, ...taskMeta }),
    };

    const matchCriteria = {
      fingerprintHash,
      legacyHash,
      alertKey: effectiveAlertKey,
      legacyAlertKey: rawLegacyKey,
      rowIndex: alert.rowIndex ?? null,
      clientName: alert.clientName || "",
      alertType,
      isProactive: effectiveIsProactive,
    };

    // Immediately commit to Redis task cache, handled hashes, AlertMemory memory cache, and triage Redis caches (< 10ms)
    await updateTaskInCache(createdRow);
    await updateHandledAlertHash(acId, fingerprintHash, "task");
    if (legacyHash) {
      await updateHandledAlertHash(acId, legacyHash, "task");
    }
    await updateAlertMemoryCacheInPlace(acId, (cache) => {
      const matchedRows = findMatchingTaskMemoryCandidates_(cache, matchCriteria);
      for (const row of matchedRows) {
        row.status = "task";
        row.ignoreReason = "";
        row.snoozedUntil = snoozedUntil || row.snoozedUntil || "";
      }
    });

    const targetIdsToRemove = [fingerprintHash];
    if (legacyHash) targetIdsToRemove.push(legacyHash);
    if (effectiveAlertKey) targetIdsToRemove.push(effectiveAlertKey);
    if (rawLegacyKey) targetIdsToRemove.push(rawLegacyKey);
    if (alert.id) targetIdsToRemove.push(alert.id);
    if (alert.rowIndex != null) targetIdsToRemove.push(String(alert.rowIndex));
    if (alert.sheetName && alert.rowNumber != null) {
      targetIdsToRemove.push(`${alert.sheetName}-${alert.rowNumber}`);
      if (alert.flagType || alert.type) {
        targetIdsToRemove.push(`${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`);
      }
    }
    const canRemoveClient = (cName) => sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, cName);
    await pruneTaskAlertsFromRedisCaches_({ sessionId, targetIds: targetIdsToRemove, canRemoveClient });

    const taskCat = (() => {
      const t = String(alert.type || alert.flagType || alert.alertType || "").toLowerCase();
      if (t.includes("inv")) return "INVOICES";
      if (t.includes("exp") || t.includes("dir") || t.includes("cost") || t.includes("vendor") || t.includes("out")) return "EXPENSES";
      if (t.includes("crm")) return "CRM";
      if (t.includes("ret")) return "RETAINER";
      return "TRIAGE";
    })();

    // Background sync to Google Sheets and PMA activity log without blocking the HTTP response
    const syncToSheets = async () => {
      try {
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);
        const candidates = findMatchingTaskMemoryCandidates_(memoryRows, matchCriteria);

        if (candidates.length > 0) {
          const primaryRow = candidates[0];
          for (const dup of candidates.slice(1)) {
            if (dup.rowIndex === primaryRow.rowIndex) continue;
            await updateAlertMemoryRow(sheets, acId, dup.rowIndex, {
              ...dup,
              status: "superseded",
            });
          }
          let prevSnap = {};
          try { prevSnap = JSON.parse(primaryRow.dataSnapshot || "{}"); } catch (_) { }
          const updatedRow = {
            ...primaryRow,
            _previousFingerprintHash: primaryRow.fingerprintHash,
            fingerprintHash: createdRow.fingerprintHash,
            category: createdRow.category,
            status: "task",
            snoozedUntil: snoozedUntil || primaryRow.snoozedUntil || "",
            ignoreReason: "",
            cachedOptionsJSON: primaryRow.cachedOptionsJSON || "",
            dataSnapshot: JSON.stringify({ ...prevSnap, ...alertFieldsSnapshot, ...taskMeta }),
          };
          await updateAlertMemoryRow(sheets, acId, primaryRow.rowIndex, updatedRow);
        } else {
          await appendAlertMemoryRow(sheets, acId, createdRow);
        }

        logPmaActivity(sheets, {
          automationCommanderSheetId: acId,
          clientName: alert.clientName || "",
          category: taskCat,
          action: "Task Created",
          summary: `Created task for ${alert.clientName || "Client"}: ${taskNote || alert.type || "Alert Task"}`,
          details: { taskNote, alertType: alert.type || alert.flagType, clientName: alert.clientName, createdBy: createdByEmail }
        });
      } catch (bgErr) {
        console.error("❌ Background sheet persist failed for task:", bgErr.message);
      }
    };

    if (typeof waitUntil === "function") {
      waitUntil(syncToSheets());
    } else {
      syncToSheets();
    }

    return res.status(200).json({ success: true, taskKey, fingerprintHash, snoozedHandled: !!snoozedUntil });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetTasks(req, res, sheets) {
  const { automationCommanderSheetId: acId, filter, bypassCache, clientName, forceRefresh } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const TASK_CACHE_KEY = "triage_tasks_cache";
  const TASK_CACHE_TTL_S = 86400 * 7; // 7-day TTL in Redis

  try {
    let allTasks = null;
    const nowMs = Date.now();
    const isForceRefresh = !!forceRefresh;
    if (!isForceRefresh && !bypassCache && _tasksMemoryCache && (nowMs - _tasksCachedAt < 300000)) {
      allTasks = _tasksMemoryCache;
    } else if (!isForceRefresh && redisClient?.isOpen) {
      try {
        const cached = await redisClient.get(TASK_CACHE_KEY);
        if (cached) allTasks = JSON.parse(cached);
      } catch (e) {}
    }

    if (!allTasks) {
      await ensureAlertMemoryTab(sheets, acId);
      const rows = await readAlertMemory(sheets, acId);
      allTasks = rows.filter(r => r.status === "task" || r.status === "task_resolved");
      if (redisClient?.isOpen) {
        await redisClient.set(TASK_CACHE_KEY, JSON.stringify(allTasks), { EX: TASK_CACHE_TTL_S });
      }
    }
    _tasksMemoryCache = allTasks;
    _tasksCachedAt = nowMs;

    const now = new Date();
    const parsed = allTasks.map(r => {
      let taskMeta = {};
      try { taskMeta = JSON.parse(r.dataSnapshot || "{}"); } catch (e) {}
      const snoozedUntil = taskMeta.snoozedUntil ? new Date(taskMeta.snoozedUntil) : null;
      const isSnoozed = snoozedUntil && snoozedUntil > now;
      const isResolved = r.status === "task_resolved";
      const alertType = r.alertType || taskMeta.alertType || "";
      const isAdminOnly = !!taskMeta.isAdminOnly || ADMIN_ONLY_ALERT_TYPES.has(alertType);
      const createdByEmail = taskMeta.createdByEmail || taskMeta.createdBy || "";
      const createdByName = taskMeta.createdByName || "";

      return {
        fingerprintHash:   r.fingerprintHash,
        alertType,
        clientName:        r.clientName,
        alertSummary:      r.alertSummary,
        firstSeen:         r.firstSeen,
        lastSeen:          r.lastSeen,
        taskNote:          taskMeta.taskNote || "",
        taskCreatedAt:     taskMeta.taskCreatedAt || r.firstSeen || "",
        snoozedUntil:      taskMeta.snoozedUntil || "",
        isSnoozed,
        isResolved,
        isAdminOnly,
        createdByEmail,
        createdByName,
        furtherNotes:      taskMeta.furtherNotes || [],
        taskKey:           taskMeta.taskKey || "",
        isProactive:       !!taskMeta.isProactive,
        cachedOptionsJSON: r.cachedOptionsJSON || "",
        alertDataJSON:     taskMeta.alertData || "",
        resolvedAt:        taskMeta.resolvedAt || "",
      };
    });

    const userEmail = String(sessionUser.email || "").trim().toLowerCase();
    const userName = String(sessionUser.name || "").trim().toLowerCase();
    // Only Admin is an internal staff role able to see all clients
    const isAdmin = !!(sessionUser.isAdmin || sessionUser.role === "Admin");

    // Check if task was created by the logged-in user
    const checkIsMine = (t) => {
      const taskEmail = String(t.createdByEmail || "").trim().toLowerCase();
      const taskName = String(t.createdByName || "").trim().toLowerCase();
      if (taskEmail && userEmail) return taskEmail === userEmail;
      if (!taskEmail && taskName && userName) return taskName === userName;
      return false;
    };

    let accessibleTasks = parsed;
    if (!isAdmin) {
      // 1. Must be assigned to client
      const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      accessibleTasks = accessibleTasks.filter(t =>
        assignedList.some(assigned => matchesClientName(assigned, t.clientName))
      );
      // 2. Hide admin-only alert tasks from non-admins
      accessibleTasks = accessibleTasks.filter(t => !t.isAdminOnly && !ADMIN_ONLY_ALERT_TYPES.has(t.alertType));
      // 3. Non-admins only ever see items that they turned into tasks
      accessibleTasks = accessibleTasks.filter(t => checkIsMine(t));
    }

    if (clientName && typeof clientName === "string" && clientName.trim()) {
      accessibleTasks = accessibleTasks.filter(t => matchesClientName(clientName.trim(), t.clientName));
    }

    // Compute counts
    let myActiveCount = 0;
    let mySnoozedCount = 0;
    let otherActiveCount = 0;
    let otherSnoozedCount = 0;
    let resolvedCount = 0;

    for (const t of accessibleTasks) {
      const isMine = checkIsMine(t);
      if (t.isResolved) {
        resolvedCount++;
      } else if (t.isSnoozed) {
        if (isMine) mySnoozedCount++;
        else if (isAdmin) otherSnoozedCount++;
      } else {
        if (isMine) myActiveCount++;
        else if (isAdmin) otherActiveCount++;
      }
    }

    const requestedFilter = filter || "active";
    let filtered = [];

    if (requestedFilter === "snoozed") {
      filtered = accessibleTasks.filter(t => checkIsMine(t) && t.isSnoozed && !t.isResolved);
    } else if (requestedFilter === "other_active") {
      filtered = isAdmin ? accessibleTasks.filter(t => !checkIsMine(t) && !t.isSnoozed && !t.isResolved) : [];
    } else if (requestedFilter === "other_snoozed") {
      filtered = isAdmin ? accessibleTasks.filter(t => !checkIsMine(t) && t.isSnoozed && !t.isResolved) : [];
    } else if (requestedFilter === "resolved") {
      filtered = accessibleTasks.filter(t => t.isResolved && (isAdmin || checkIsMine(t)));
    } else {
      // "active" (default)
      filtered = accessibleTasks.filter(t => checkIsMine(t) && !t.isSnoozed && !t.isResolved);
    }

    filtered.sort((a, b) => new Date(a.taskCreatedAt || 0) - new Date(b.taskCreatedAt || 0));

    return res.status(200).json({
      success: true,
      tasks: filtered,
      filter: requestedFilter,
      counts: {
        active: myActiveCount,
        snoozed: mySnoozedCount,
        otherActive: otherActiveCount,
        otherSnoozed: otherSnoozedCount,
        resolved: resolvedCount,
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleAddTaskNote(req, res, sheets) {
  const { fingerprintHash, noteText, automationCommanderSheetId: acId } = req.body;
  if (!fingerprintHash || !noteText || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    if (!memoryRow || (memoryRow.status !== "task" && memoryRow.status !== "task_resolved")) {
      return res.status(404).json({ success: false, error: "Task not found" });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser) return res.status(401).json({ success: false, error: "Unauthorized" });
    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, memoryRow.clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client's tasks" });
    }

    let taskMeta = {};
    try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
    const isAdminOnly = !!taskMeta.isAdminOnly || ADMIN_ONLY_ALERT_TYPES.has(memoryRow.alertType);
    if (!sessionUser.isAdmin && isAdminOnly) {
      return res.status(403).json({ success: false, error: "Access denied: task belongs to an Admin-only alert" });
    }
    try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
    const notes = Array.isArray(taskMeta.furtherNotes) ? taskMeta.furtherNotes : [];
    notes.push({ text: noteText, timestamp: new Date().toISOString() });
    taskMeta.furtherNotes = notes;

    const updatedRow = { ...memoryRow, dataSnapshot: JSON.stringify(taskMeta) };
    await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, updatedRow);
    await updateTaskInCache(updatedRow);

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: memoryRow.clientName || "",
      category: "TRIAGE",
      action: "Task Note Added",
      summary: `Added note to task for ${memoryRow.clientName || "Client"}: "${noteText}"`,
      details: { fingerprintHash, noteText, clientName: memoryRow.clientName }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleSnoozeTask(req, res, sheets) {
  const { fingerprintHash, fingerprintHashes, snoozedUntil, automationCommanderSheetId: acId, unsnooze, updateCachedOptions, newCachedOptionsJSON, alertData } = req.body;
  const hashes = Array.isArray(fingerprintHashes) && fingerprintHashes.length > 0
    ? fingerprintHashes
    : (fingerprintHash ? [fingerprintHash] : []);
  if (hashes.length === 0 || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const sessionUser = getSessionUser(req);
    if (!sessionUser) return res.status(401).json({ success: false, error: "Unauthorized" });

    const batchUpdates = [];
    const snoozedTasks = [];

    for (const hash of hashes) {
      const memoryRow = findMemoryRow(memoryRows, hash);
      if (!memoryRow || (memoryRow.status !== "task" && memoryRow.status !== "task_resolved")) continue;

      if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, memoryRow.clientName)) {
        continue;
      }

      let taskMeta = {};
      try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
      const isAdminOnly = !!taskMeta.isAdminOnly || ADMIN_ONLY_ALERT_TYPES.has(memoryRow.alertType);
      if (!sessionUser.isAdmin && isAdminOnly) {
        continue;
      }
      if (unsnooze) { taskMeta.snoozedUntil = ""; } else { taskMeta.snoozedUntil = snoozedUntil || ""; }

      if (updateCachedOptions && newCachedOptionsJSON) {
        taskMeta.furtherNotes = [...(taskMeta.furtherNotes || []), { text: `Alert data changed - analysis updated${unsnooze ? " and task unsnoozed" : ""}`, timestamp: new Date().toISOString(), system: true }];
        if (alertData) taskMeta.alertData = alertData;
      }

      const updatedRow = {
        ...memoryRow,
        cachedOptionsJSON: updateCachedOptions && newCachedOptionsJSON ? newCachedOptionsJSON : memoryRow.cachedOptionsJSON,
        dataSnapshot: JSON.stringify(taskMeta),
      };
      batchUpdates.push({
        rowIndex: memoryRow.rowIndex,
        updates: updatedRow,
      });
      snoozedTasks.push(updatedRow);
    }

    if (batchUpdates.length === 0) {
      return res.status(404).json({ success: false, error: "No eligible tasks found to snooze" });
    }

    await updateAlertMemoryRowsBatch(sheets, acId, batchUpdates);
    await updateTasksInCache(snoozedTasks);

    if (snoozedTasks.length === 1) {
      logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: snoozedTasks[0].clientName || "",
        category: "TRIAGE",
        action: unsnooze ? "Task Unsnoozed" : "Task Snoozed",
        summary: unsnooze
          ? `Unsnoozed task for ${snoozedTasks[0].clientName || "Client"}: ${snoozedTasks[0].alertSummary || "Task"}`
          : `Snoozed task for ${snoozedTasks[0].clientName || "Client"} until ${snoozedUntil}: ${snoozedTasks[0].alertSummary || "Task"}`,
        details: { fingerprintHash: snoozedTasks[0].fingerprintHash, snoozedUntil, unsnooze: !!unsnooze, clientName: snoozedTasks[0].clientName }
      });
    } else {
      logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: "Multiple Clients",
        category: "TRIAGE",
        action: unsnooze ? "Tasks Unsnoozed (Bulk)" : "Tasks Snoozed (Bulk)",
        summary: unsnooze
          ? `Unsnoozed ${snoozedTasks.length} tasks in bulk`
          : `Snoozed ${snoozedTasks.length} tasks in bulk until ${snoozedUntil}`,
        details: { count: snoozedTasks.length, snoozedUntil, hashes: snoozedTasks.map(t => t.fingerprintHash) }
      });
    }

    return res.status(200).json({ success: true, count: snoozedTasks.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleRevertTaskToAlert(req, res, sheets) {
  const { fingerprintHash, automationCommanderSheetId: acId, sessionId } = req.body;
  if (!fingerprintHash || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    if (!memoryRow || (memoryRow.status !== "task" && memoryRow.status !== "task_resolved")) {
      return res.status(404).json({ success: false, error: "Task not found" });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser) return res.status(401).json({ success: false, error: "Unauthorized" });
    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, memoryRow.clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client's tasks" });
    }
    let taskMeta = {};
    try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
    const isAdminOnly = !!taskMeta.isAdminOnly || ADMIN_ONLY_ALERT_TYPES.has(memoryRow.alertType);
    if (!sessionUser.isAdmin && isAdminOnly) {
      return res.status(403).json({ success: false, error: "Access denied: task belongs to an Admin-only alert" });
    }

    let originalAlert = null;
    if (taskMeta.alertData) {
      try {
        originalAlert = typeof taskMeta.alertData === "string" ? JSON.parse(taskMeta.alertData) : taskMeta.alertData;
      } catch (e) {
        console.warn("Failed to parse alertData on task revert:", e);
      }
    }

    if (!originalAlert) {
      originalAlert = {
        fingerprintHash,
        type: memoryRow.alertType || taskMeta.alertType || "alert",
        flagType: taskMeta.flagType || memoryRow.alertType || "",
        clientName: memoryRow.clientName || "",
        heading: memoryRow.alertSummary || "Alert",
        summary: {
          summary: memoryRow.alertSummary,
          invoiceNo: taskMeta.invoiceNo || "",
          reference: taskMeta.reference || "",
          amount: taskMeta.amount || "",
          status: taskMeta.status || "",
        },
        masterSheetId: taskMeta.masterSheetId || "",
        isProactive: !!taskMeta.isProactive || memoryRow.category === "proactive",
        proactiveAlertKey: taskMeta.proactiveAlertKey || "",
      };
    }

    if (!originalAlert.fingerprintHash) {
      originalAlert.fingerprintHash = fingerprintHash;
    }

    const category = memoryRow.category || (taskMeta.isProactive ? "proactive" : (originalAlert.isNoAction ? "informational" : "discrepancy"));

    const restoredRow = {
      ...memoryRow,
      status: "cached",
      snoozedUntil: "",
      ignoreReason: "",
      dataSnapshot: taskMeta.alertData ? (typeof taskMeta.alertData === "string" ? taskMeta.alertData : JSON.stringify(taskMeta.alertData)) : memoryRow.dataSnapshot,
    };

    await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, restoredRow);
    await updateTaskInCache({ fingerprintHash }, true);
    await updateHandledAlertHash(acId, fingerprintHash, "cached");

    await restoreAlertToCacheAndSession(originalAlert, category, sessionId);

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: memoryRow.clientName || "",
      category: "TRIAGE",
      action: "Task Reverted to Alert",
      summary: `Reverted task to alert for ${memoryRow.clientName || "Client"}: ${memoryRow.alertSummary || "Alert"}`,
      details: { fingerprintHash, clientName: memoryRow.clientName, alertType: memoryRow.alertType }
    });

    return res.status(200).json({
      success: true,
      alert: originalAlert,
      category,
      clientName: memoryRow.clientName,
      alertType: memoryRow.alertType,
      fingerprintHash,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleResolveTask(req, res, sheets) {
  const { fingerprintHash, fingerprintHashes, automationCommanderSheetId: acId } = req.body;
  const hashes = Array.isArray(fingerprintHashes) && fingerprintHashes.length > 0
    ? fingerprintHashes
    : (fingerprintHash ? [fingerprintHash] : []);
  if (hashes.length === 0 || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const sessionUser = getSessionUser(req);
    if (!sessionUser) return res.status(401).json({ success: false, error: "Unauthorized" });

    const batchUpdates = [];
    const resolvedTasks = [];

    for (const hash of hashes) {
      const memoryRow = findMemoryRow(memoryRows, hash);
      if (!memoryRow || (memoryRow.status !== "task" && memoryRow.status !== "task_resolved")) continue;

      if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, memoryRow.clientName)) {
        continue;
      }

      let taskMeta = {};
      try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
      const isAdminOnly = !!taskMeta.isAdminOnly || ADMIN_ONLY_ALERT_TYPES.has(memoryRow.alertType);
      if (!sessionUser.isAdmin && isAdminOnly) {
        continue;
      }
      taskMeta.resolvedAt = new Date().toISOString();

      const updatedRow = { ...memoryRow, status: "task_resolved", dataSnapshot: JSON.stringify(taskMeta) };
      batchUpdates.push({
        rowIndex: memoryRow.rowIndex,
        updates: updatedRow
      });
      resolvedTasks.push(updatedRow);
    }

    if (batchUpdates.length === 0) {
      return res.status(404).json({ success: false, error: "No eligible tasks found to resolve" });
    }

    await updateAlertMemoryRowsBatch(sheets, acId, batchUpdates);
    await updateTasksInCache(resolvedTasks);

    if (resolvedTasks.length === 1) {
      logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: resolvedTasks[0].clientName || "",
        category: "TRIAGE",
        action: "Task Resolved",
        summary: `Resolved task for ${resolvedTasks[0].clientName || "Client"}: ${resolvedTasks[0].alertSummary || "Task"}`,
        details: { fingerprintHash: resolvedTasks[0].fingerprintHash, clientName: resolvedTasks[0].clientName }
      });
    } else {
      logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: "Multiple Clients",
        category: "TRIAGE",
        action: "Tasks Resolved (Bulk)",
        summary: `Resolved ${resolvedTasks.length} tasks in bulk across ${new Set(resolvedTasks.map(t => t.clientName)).size} client(s)`,
        details: { count: resolvedTasks.length, hashes: resolvedTasks.map(t => t.fingerprintHash) }
      });
    }

    return res.status(200).json({ success: true, count: resolvedTasks.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateTask(req, res, sheets) {
  const { fingerprintHash, newCachedOptionsJSON, newAlertData, unsnooze, automationCommanderSheetId: acId } = req.body;
  if (!fingerprintHash || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });
  const sessionUser = getSessionUser(req);
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    if (!memoryRow || (memoryRow.status !== "task" && memoryRow.status !== "task_resolved")) {
      return res.status(404).json({ success: false, error: "Task not found" });
    }

    if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
      const rowClient = memoryRow.clientName || memoryRow.client;
      if (!rowClient || !isUserAuthorizedForClient(sessionUser, rowClient)) {
        return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client's task." });
      }
    }

    let taskMeta = {};
    try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
    const isAdminOnly = !!taskMeta.isAdminOnly || ADMIN_ONLY_ALERT_TYPES.has(memoryRow.alertType);
    if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin && isAdminOnly) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to Admin-only task." });
    }
    taskMeta.furtherNotes = [...(taskMeta.furtherNotes || []), { text: `Alert data changed - analysis updated${unsnooze ? " and task unsnoozed" : ""}`, timestamp: new Date().toISOString(), system: true }];
    if (unsnooze) taskMeta.snoozedUntil = "";
    if (newAlertData) taskMeta.alertData = newAlertData;

    const updatedRow = { ...memoryRow, cachedOptionsJSON: newCachedOptionsJSON || memoryRow.cachedOptionsJSON, dataSnapshot: JSON.stringify(taskMeta) };
    await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, updatedRow);
    await updateTaskInCache(updatedRow);
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCheckExistingTask(req, res, sheets) {
  const { alert, automationCommanderSheetId: acId } = req.body;
  if (!alert || !acId) return res.status(400).json({ success: false, error: "Missing alert or automationCommanderSheetId" });
  const sessionUser = getSessionUser(req);
  if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
    if (!alert.clientName || !isUserAuthorizedForClient(sessionUser, alert.clientName)) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client." });
    }
  }
  try {
    const taskRef = alert.summary?.invoiceNo || alert.summary?.reference || alert.summary?.jobName || alert.alertKey || "";
    const taskKey = `${alert.clientName}||${alert.type || alert.flagType || "alert"}||${taskRef}`;

    // Fast path: Check tasks cache (~50 active tasks, <1ms) rather than 9MB AlertMemory!
    let tasksList = _tasksMemoryCache;
    if (!tasksList && redisClient?.isOpen) {
      try {
        const cached = await redisClient.get("triage_tasks_cache");
        if (cached) tasksList = JSON.parse(cached);
      } catch (e) {}
    }

    let match = null;
    if (tasksList && tasksList.length > 0) {
      match = tasksList.find(r => (r.status === "task") && (() => { try { return JSON.parse(r.dataSnapshot || "{}").taskKey === taskKey; } catch(e) { return false; } })());
    }

    if (!match && !tasksList) {
      await ensureAlertMemoryTab(sheets, acId);
      const memoryRows = await readAlertMemory(sheets, acId);
      match = memoryRows.find(r => (r.status === "task") && (() => { try { return JSON.parse(r.dataSnapshot || "{}").taskKey === taskKey; } catch(e) { return false; } })());
    }

    if (!match) return res.status(200).json({ success: true, found: false });

    let taskMeta = {};
    try { taskMeta = JSON.parse(match.dataSnapshot || "{}"); } catch (e) {}
    const snoozedUntil = taskMeta.snoozedUntil ? new Date(taskMeta.snoozedUntil) : null;

    return res.status(200).json({
      success: true, found: true,
      task: {
        fingerprintHash: match.fingerprintHash,
        taskKey,
        taskNote: taskMeta.taskNote || "",
        taskCreatedAt: taskMeta.taskCreatedAt || match.firstSeen || "",
        isSnoozed: !!(snoozedUntil && snoozedUntil > new Date()),
        snoozedUntil: taskMeta.snoozedUntil || "",
        furtherNotes: taskMeta.furtherNotes || [],
        dataChanged: match.fingerprintHash !== (alert.fingerprintHash || buildAlertFingerprint(alert)),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}