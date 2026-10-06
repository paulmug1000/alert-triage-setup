import { createHash } from "crypto";
import { redisClient } from "./redisClient";
import {
  buildAlertFingerprint, ensureAlertMemoryTab, readAlertMemory,
  findMemoryRow, updateAlertMemoryRow, updateAlertMemoryRowsBatch, appendAlertMemoryRow
} from "./alertMemory";
import { logPmaActivity } from "./pmaLogger";
import { getSessionUser } from "./authService";
import { matchesClientName, isUserAuthorizedForClient } from "./userPermissions";
import { ADMIN_ONLY_ALERT_TYPES } from "../utils/helpers";

export async function handleBulkCreateTasks(req, res, sheets) {
  const { alerts: alertsToTask, taskNote, snoozedUntil, automationCommanderSheetId: acId } = req.body;
  if (!alertsToTask?.length || !acId) return res.status(400).json({ success: false, error: "Missing alerts or automationCommanderSheetId" });

  const sessionUser = getSessionUser(req);
  if (!sessionUser) return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });

  const createdByEmail = sessionUser.email || "";
  const createdByName = sessionUser.name || (sessionUser.email ? sessionUser.email.split("@")[0] : "");
  const now = new Date().toISOString();

  try {
    console.log(`\n📋 Bulk creating ${alertsToTask.length} tasks by ${createdByEmail || "user"}`);
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const results = [];

    for (const alert of alertsToTask) {
      try {
        const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);
        const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
        const taskRef = `TASK-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
        const taskKey = `${alert.clientName}||${alert.type || alert.flagType || "alert"}||${taskRef}`;
        const alertSummary = alert.summary?.summary || `${alert.type || "alert"} ${alert.summary?.invoiceNo || ""} £${alert.summary?.amount || ""}`.trim();
        const alertType = alert.type || alert.flagType || alert.alertType || "";
        const isAdminOnly = ADMIN_ONLY_ALERT_TYPES.has(alertType);

        const taskRow = {
          fingerprintHash, alertType: alertType || "unknown",
          clientName: alert.clientName || "", alertSummary,
          cachedOptionsJSON: memoryRow?.cachedOptionsJSON || "",
          status: "task", taskNote: taskNote || "", taskKey,
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
          }),
        };

        if (memoryRow) {
          await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, taskRow);
        } else {
          await appendAlertMemoryRow(sheets, acId, taskRow);
        }

        if (snoozedUntil) {
          const freshRows = await readAlertMemory(sheets, acId);
          const taskMemRow = findMemoryRow(freshRows, fingerprintHash);
          if (taskMemRow) await updateAlertMemoryRow(sheets, acId, taskMemRow.rowIndex, { ...taskMemRow, snoozedUntil });
        }
        results.push({ fingerprintHash, taskKey });
      } catch (alertErr) {
        results.push({ fingerprintHash: null, error: alertErr.message });
      }
    }

    await redisClient.del("triage_tasks_cache").catch(() => {});

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

    return res.status(200).json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCreateTask(req, res, sheets) {
  const { alert, taskNote, automationCommanderSheetId: acId, isProactive, proactiveAlertKey, isInfo } = req.body;
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
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);

    const fingerprintHash = alert.fingerprintHash || (alert.alertKey ? createHash("sha256").update(alert.alertKey).digest("hex").substring(0, 16) : null) || buildAlertFingerprint(alert);
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    const now = new Date().toISOString();

    const taskRef = alert.summary?.invoiceNo || alert.summary?.reference || alert.summary?.jobName || alert.alertKey || fingerprintHash.slice(0, 8);
    const taskKey = `${alert.clientName}||${alert.type || alert.flagType || "alert"}||${taskRef}`;

    const existingTask = memoryRows.find(r => r.status === "task" && r.taskKey === taskKey);
    if (existingTask) {
      return res.status(409).json({ success: false, error: "A task already exists for this alert", existingTaskHash: existingTask.fingerprintHash });
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

    let cachedOptionsJSON = memoryRow?.cachedOptionsJSON ? memoryRow.cachedOptionsJSON : "";

    const taskMeta = {
      taskNote:          taskNote || "",
      taskCreatedAt:     now,
      createdByEmail,
      createdByName,
      isAdminOnly,
      snoozedUntil:      "",
      furtherNotes:      [], 
      taskKey,
      isProactive:       !!isProactive,
      proactiveAlertKey: proactiveAlertKey || "",
      alertData:         JSON.stringify(alert), 
    };

    if (memoryRow) {
      await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, {
        ...memoryRow,
        status: "task",
        ignoreReason: "",
        cachedOptionsJSON,
        dataSnapshot: JSON.stringify({ ...JSON.parse(memoryRow.dataSnapshot || "{}"), ...alertFieldsSnapshot, ...taskMeta }),
      });
    } else {
      await appendAlertMemoryRow(sheets, acId, {
        fingerprintHash,
        alertType: alertType || "alert",
        clientName: alert.clientName || "",
        alertSummary,
        cachedOptionsJSON,
        status: "task",
        ignoreReason: "",
        category: isProactive ? "proactive" : (isInfo ? "informational" : "discrepancy"),
        dataSnapshot: JSON.stringify({ ...alertFieldsSnapshot, ...taskMeta }),
      });
    }

    await redisClient.del("triage_tasks_cache").catch(() => {});

    const taskCat = (() => {
      const t = String(alert.type || alert.flagType || alert.alertType || "").toLowerCase();
      if (t.includes("inv")) return "INVOICES";
      if (t.includes("exp") || t.includes("dir") || t.includes("cost") || t.includes("vendor") || t.includes("out")) return "EXPENSES";
      if (t.includes("crm")) return "CRM";
      if (t.includes("ret")) return "RETAINER";
      return "TRIAGE";
    })();

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: alert.clientName || "",
      category: taskCat,
      action: "Task Created",
      summary: `Created task for ${alert.clientName || "Client"}: ${taskNote || alert.type || "Alert Task"}`,
      details: { taskNote, alertType: alert.type || alert.flagType, clientName: alert.clientName, createdBy: createdByEmail }
    });

    return res.status(200).json({ success: true, taskKey, fingerprintHash });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetTasks(req, res, sheets) {
  const { automationCommanderSheetId: acId, filter, bypassCache } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const TASK_CACHE_KEY = "triage_tasks_cache";
  const TASK_CACHE_TTL_S = 300; 

  try {
    let allTasks = null;
    if (!bypassCache) {
      try {
        const cached = await redisClient.get(TASK_CACHE_KEY);
        if (cached) allTasks = JSON.parse(cached);
      } catch (e) {}
    }

    if (!allTasks) {
      await ensureAlertMemoryTab(sheets, acId);
      const rows = await readAlertMemory(sheets, acId);
      allTasks = rows.filter(r => r.status === "task" || r.status === "task_resolved");
      await redisClient.set(TASK_CACHE_KEY, JSON.stringify(allTasks), { EX: TASK_CACHE_TTL_S });
    }

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
      filtered = accessibleTasks.filter(t => t.isResolved);
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
    if (!memoryRow) return res.status(404).json({ success: false, error: "Task not found" });

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

    await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, { ...memoryRow, dataSnapshot: JSON.stringify(taskMeta) });
    await redisClient.del("triage_tasks_cache").catch(() => {});

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
      if (!memoryRow) continue;

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

      batchUpdates.push({
        rowIndex: memoryRow.rowIndex,
        updates: {
          ...memoryRow,
          cachedOptionsJSON: updateCachedOptions && newCachedOptionsJSON ? newCachedOptionsJSON : memoryRow.cachedOptionsJSON,
          dataSnapshot: JSON.stringify(taskMeta),
        }
      });
      snoozedTasks.push(memoryRow);
    }

    if (batchUpdates.length === 0) {
      return res.status(404).json({ success: false, error: "No eligible tasks found to snooze" });
    }

    await updateAlertMemoryRowsBatch(sheets, acId, batchUpdates);
    await redisClient.del("triage_tasks_cache").catch(() => {});

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
  const { fingerprintHash, automationCommanderSheetId: acId } = req.body;
  if (!fingerprintHash || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    if (!memoryRow) return res.status(404).json({ success: false, error: "Task not found" });

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

    await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, { ...memoryRow, status: "cached" });
    await redisClient.del("triage_tasks_cache").catch(() => {});
    return res.status(200).json({ success: true });
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
      if (!memoryRow) continue;

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

      batchUpdates.push({
        rowIndex: memoryRow.rowIndex,
        updates: { ...memoryRow, status: "task_resolved", dataSnapshot: JSON.stringify(taskMeta) }
      });
      resolvedTasks.push(memoryRow);
    }

    if (batchUpdates.length === 0) {
      return res.status(404).json({ success: false, error: "No eligible tasks found to resolve" });
    }

    await updateAlertMemoryRowsBatch(sheets, acId, batchUpdates);
    await redisClient.del("triage_tasks_cache").catch(() => {});

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
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    if (!memoryRow) return res.status(404).json({ success: false, error: "Task not found" });

    let taskMeta = {};
    try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
    taskMeta.furtherNotes = [...(taskMeta.furtherNotes || []), { text: `Alert data changed - analysis updated${unsnooze ? " and task unsnoozed" : ""}`, timestamp: new Date().toISOString(), system: true }];
    if (unsnooze) taskMeta.snoozedUntil = "";
    if (newAlertData) taskMeta.alertData = newAlertData;

    await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: newCachedOptionsJSON || memoryRow.cachedOptionsJSON, dataSnapshot: JSON.stringify(taskMeta) });
    await redisClient.del("triage_tasks_cache").catch(() => {});
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCheckExistingTask(req, res, sheets) {
  const { alert, automationCommanderSheetId: acId } = req.body;
  if (!alert || !acId) return res.status(400).json({ success: false, error: "Missing alert or automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);

    const taskRef = alert.summary?.invoiceNo || alert.summary?.reference || alert.summary?.jobName || alert.alertKey || "";
    const taskKey = `${alert.clientName}||${alert.type || alert.flagType || "alert"}||${taskRef}`;

    const match = memoryRows.find(r => (r.status === "task") && (() => { try { return JSON.parse(r.dataSnapshot || "{}").taskKey === taskKey; } catch(e) { return false; } })());
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