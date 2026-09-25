import { createHash } from "crypto";
import { redisClient } from "./redisClient";
import {
  buildAlertFingerprint, ensureAlertMemoryTab, readAlertMemory,
  findMemoryRow, updateAlertMemoryRow, appendAlertMemoryRow
} from "./alertMemory";
import { logPmaActivity } from "./pmaLogger";

export async function handleBulkCreateTasks(req, res, sheets) {
  const { alerts: alertsToTask, taskNote, snoozedUntil, automationCommanderSheetId: acId } = req.body;
  if (!alertsToTask?.length || !acId) return res.status(400).json({ success: false, error: "Missing alerts or automationCommanderSheetId" });
  try {
    console.log(`\n📋 Bulk creating ${alertsToTask.length} tasks`);
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

        const taskRow = {
          fingerprintHash, alertType: alert.type || alert.flagType || "unknown",
          clientName: alert.clientName || "", alertSummary,
          cachedOptionsJSON: memoryRow?.cachedOptionsJSON || "",
          status: "task", taskNote: taskNote || "", taskKey,
          dataSnapshot: JSON.stringify({ alertType: alert.type || alert.flagType || "", flagType: alert.flagType || "", masterSheetId: alert.masterSheetId || "" }),
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

    const createdCount = results.filter(r => r.taskKey).length;
    if (createdCount > 0) {
      logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        clientName: alertsToTask[0]?.clientName || "",
        category: "TRIAGE",
        action: "Tasks Created",
        summary: `Bulk created ${createdCount} task${createdCount > 1 ? "s" : ""}: ${taskNote || "Alert Tasks"}`,
        details: { count: createdCount, taskNote, clientName: alertsToTask[0]?.clientName }
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
      alertType:     alert.type || alert.flagType || "",
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
      taskNote:      taskNote || "",
      taskCreatedAt: now,
      snoozedUntil:  "",
      furtherNotes:  [], 
      taskKey,
      isProactive:   !!isProactive,
      proactiveAlertKey: proactiveAlertKey || "",
      alertData:     JSON.stringify(alert), 
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
        alertType: alert.type || alert.flagType || alert.alertType || "alert",
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
      details: { taskNote, alertType: alert.type || alert.flagType, clientName: alert.clientName }
    });

    return res.status(200).json({ success: true, taskKey, fingerprintHash });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetTasks(req, res, sheets) {
  const { automationCommanderSheetId: acId, filter, bypassCache } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });

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
      return {
        fingerprintHash:   r.fingerprintHash,
        alertType:         r.alertType,
        clientName:        r.clientName,
        alertSummary:      r.alertSummary,
        firstSeen:         r.firstSeen,
        lastSeen:          r.lastSeen,
        taskNote:          taskMeta.taskNote || "",
        taskCreatedAt:     taskMeta.taskCreatedAt || r.firstSeen || "",
        snoozedUntil:      taskMeta.snoozedUntil || "",
        isSnoozed,
        isResolved,
        furtherNotes:      taskMeta.furtherNotes || [],
        taskKey:           taskMeta.taskKey || "",
        isProactive:       !!taskMeta.isProactive,
        cachedOptionsJSON: r.cachedOptionsJSON || "",
        alertDataJSON:     taskMeta.alertData || "",
        resolvedAt:        taskMeta.resolvedAt || "",
      };
    });

    const requestedFilter = filter || "active";
    let filtered;
    if (requestedFilter === "snoozed") {
      filtered = parsed.filter(t => t.isSnoozed && !t.isResolved);
    } else if (requestedFilter === "resolved") {
      filtered = parsed.filter(t => t.isResolved);
    } else {
      filtered = parsed.filter(t => !t.isSnoozed && !t.isResolved);
    }

    filtered.sort((a, b) => new Date(a.taskCreatedAt || 0) - new Date(b.taskCreatedAt || 0));
    return res.status(200).json({ success: true, tasks: filtered, filter: requestedFilter });
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

    let taskMeta = {};
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
  const { fingerprintHash, snoozedUntil, automationCommanderSheetId: acId, unsnooze, updateCachedOptions, newCachedOptionsJSON, alertData } = req.body;
  if (!fingerprintHash || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    if (!memoryRow) return res.status(404).json({ success: false, error: "Task not found" });

    let taskMeta = {};
    try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
    if (unsnooze) { taskMeta.snoozedUntil = ""; } else { taskMeta.snoozedUntil = snoozedUntil || ""; }
    
    if (updateCachedOptions && newCachedOptionsJSON) {
      taskMeta.furtherNotes = [...(taskMeta.furtherNotes || []), { text: `Alert data changed — analysis updated${unsnooze ? " and task unsnoozed" : ""}`, timestamp: new Date().toISOString(), system: true }];
      if (alertData) taskMeta.alertData = alertData;
    }

    await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, {
      ...memoryRow,
      cachedOptionsJSON: updateCachedOptions && newCachedOptionsJSON ? newCachedOptionsJSON : memoryRow.cachedOptionsJSON,
      dataSnapshot: JSON.stringify(taskMeta),
    });
    await redisClient.del("triage_tasks_cache").catch(() => {});

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: memoryRow.clientName || "",
      category: "TRIAGE",
      action: unsnooze ? "Task Unsnoozed" : "Task Snoozed",
      summary: unsnooze
        ? `Unsnoozed task for ${memoryRow.clientName || "Client"}: ${memoryRow.alertSummary || "Task"}`
        : `Snoozed task for ${memoryRow.clientName || "Client"} until ${snoozedUntil}: ${memoryRow.alertSummary || "Task"}`,
      details: { fingerprintHash, snoozedUntil, unsnooze: !!unsnooze, clientName: memoryRow.clientName }
    });

    return res.status(200).json({ success: true });
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

    await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, { ...memoryRow, status: "cached" });
    await redisClient.del("triage_tasks_cache").catch(() => {});
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleResolveTask(req, res, sheets) {
  const { fingerprintHash, automationCommanderSheetId: acId } = req.body;
  if (!fingerprintHash || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
    if (!memoryRow) return res.status(404).json({ success: false, error: "Task not found" });

    let taskMeta = {};
    try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
    taskMeta.resolvedAt = new Date().toISOString();

    await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, { ...memoryRow, status: "task_resolved", dataSnapshot: JSON.stringify(taskMeta) });
    await redisClient.del("triage_tasks_cache").catch(() => {});

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      clientName: memoryRow.clientName || "",
      category: "TRIAGE",
      action: "Task Resolved",
      summary: `Resolved task for ${memoryRow.clientName || "Client"}: ${memoryRow.alertSummary || "Task"}`,
      details: { fingerprintHash, clientName: memoryRow.clientName }
    });

    return res.status(200).json({ success: true });
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
    taskMeta.furtherNotes = [...(taskMeta.furtherNotes || []), { text: `Alert data changed — analysis updated${unsnooze ? " and task unsnoozed" : ""}`, timestamp: new Date().toISOString(), system: true }];
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