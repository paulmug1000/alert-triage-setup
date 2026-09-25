import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient";
import { redisClient } from "./redisClient";
import { logPmaActivity } from "./pmaLogger";

// Moved from triage.js local scope
let eomTabsVerified = false;

function columnIndexToLetter_(colNum1Indexed) {
  let s = "";
  let n = colNum1Indexed;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isDateMatchJs_(sheetHeader, aiDate) {
  if (!sheetHeader || !aiDate) return false;
  const s1 = String(sheetHeader).toLowerCase();
  const s2 = String(aiDate).toLowerCase();
  if (s1 === s2) return true;
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const m1 = months.find(m => s1.includes(m));
  const m2 = months.find(m => s2.includes(m));
  const y1 = s1.match(/\d{2,4}/);
  const y2 = s2.match(/\d{2,4}/);
  if (m1 && m2 && m1 === m2) {
    if (!y1 || !y2) return true;
    const year1 = y1[0].length === 2 ? "20" + y1[0] : y1[0];
    const year2 = y2[0].length === 2 ? "20" + y2[0] : y2[0];
    return year1 === year2;
  }
  return false;
}

export function monthStrToEomKey_(monthStr) {
  const monthAbbrs = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const parts = String(monthStr || "").trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const monthNum = monthAbbrs[parts[0].slice(0, 3).toLowerCase()];
  const year = parseInt(parts[1], 10);
  if (!monthNum || !year) return null;
  return `${year}-${String(monthNum).padStart(2, "0")}`;
}

export function eomKeyToMonthStr_(monthKey) {
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const parts = String(monthKey || "").split("-");
  if (parts.length !== 2) return null;
  const year = parseInt(parts[0], 10);
  const monthNum = parseInt(parts[1], 10);
  if (!year || !monthNum || monthNum < 1 || monthNum > 12) return null;
  return `${monthNames[monthNum - 1]} ${year}`;
}

export function eomWorkMonthToTargetMonth_(workMonthKey) {
  const [y, m] = String(workMonthKey || "").split("-").map(Number);
  if (!y || !m) return null;
  const d = new Date(y, m - 1 - 1, 1); 
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function eomTargetMonthToWorkMonth_(targetMonthKey) {
  const [y, m] = String(targetMonthKey || "").split("-").map(Number);
  if (!y || !m) return null;
  const d = new Date(y, m - 1 + 1, 1); 
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, clientName, linkedFunctionValue, workMonthKey) {
  try {
    if (!workMonthKey || !automationCommanderSheetId) return false;
    const [templatesR, clientTasksR] = await Promise.all([
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:F1000" })),
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" })),
    ]);
    const linkedTemplateIds = new Set((templatesR.data.values || []).filter(r => r[0] && r[3] === linkedFunctionValue).map(r => r[0]));
    const linkedTask = (clientTasksR.data.values || []).find(r =>
      r[0] && r[1] === clientName && linkedTemplateIds.has(r[2]) && (r[5] !== "FALSE" && r[5] !== false)
    );
    if (!linkedTask) return false;

    const statusResp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:E200000" }));
    const statusRows = statusResp.data.values || [];
    const existingIdx = statusRows.findIndex(r => r[0] === clientName && r[1] === linkedTask[0] && r[2] === workMonthKey);
    if (existingIdx === -1) {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A:E", valueInputOption: "RAW",
        requestBody: { values: [[clientName, linkedTask[0], workMonthKey, "done", new Date().toISOString()]] },
      }));
    } else {
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `EomMonthlyStatus!D${existingIdx + 2}:E${existingIdx + 2}`,
        valueInputOption: "RAW", requestBody: { values: [["done", new Date().toISOString()]] },
      }));
    }
    return true;
  } catch (e) {
    return false;
  }
}

export async function ensureEomTabs_(sheets, spreadsheetId) {
  if (eomTabsVerified) return;
  eomTabsVerified = true;
  return;
}

export async function handleEomGetTemplates(req, res, sheets) {
  const { automationCommanderSheetId } = req.body;
  if (!automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:H1000" }));
    const rows = resp.data.values || [];
    const templates = rows.filter(r => r[0]).map((r, i) => ({
      templateId: r[0], name: r[1] || "", defaultNotes: r[2] || "", linkedFunction: r[3] || "",
      active: r[4] !== "FALSE" && r[4] !== false, createdAt: r[5] || "", alertCategories: r[6] || "",
      sortOrder: r[7] !== undefined && r[7] !== "" ? Number(r[7]) : 1000000 + i,
    })).sort((a, b) => a.sortOrder - b.sortOrder);
    return res.status(200).json({ success: true, templates });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomGetExcludedClients(req, res, sheets) {
  const { automationCommanderSheetId } = req.body;
  if (!automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomExcludedClients!A2:C1000" }));
    const clients = (resp.data.values || []).filter(r => r[0]).map(r => ({
      clientName: r[0], excluded: r[1] === "TRUE" || r[1] === true,
      sortOrder: r[2] !== undefined && r[2] !== "" ? Number(r[2]) : null,
    }));
    return res.status(200).json({ success: true, clients });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomToggleClientExcluded(req, res, sheets) {
  const { automationCommanderSheetId, clientName: exClientName, excluded } = req.body;
  if (!automationCommanderSheetId || !exClientName) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomExcludedClients!A2:C1000" });
    const rows = resp.data.values || [];
    const rowIdx = rows.findIndex(r => r[0] === exClientName);

    if (rowIdx === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "EomExcludedClients!A:C", valueInputOption: "RAW",
        requestBody: { values: [[exClientName, excluded, ""]] },
      });
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `EomExcludedClients!B${rowIdx + 2}`,
        valueInputOption: "RAW", requestBody: { values: [[excluded]] },
      });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomReorderClients(req, res, sheets) {
  const { automationCommanderSheetId, orderedClientNames } = req.body;
  if (!automationCommanderSheetId || !Array.isArray(orderedClientNames) || orderedClientNames.length === 0) return res.status(400).json({ success: false, error: "Missing orderedClientNames" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomExcludedClients!A2:C1000" });
    const rows = resp.data.values || [];
    const rowIdxByClient = {};
    rows.forEach((r, i) => { if (r[0]) rowIdxByClient[r[0]] = i; });

    const writes = [];
    const newRows = [];
    orderedClientNames.forEach((clientName, index) => {
      const sortOrder = (index + 1) * 10;
      if (clientName in rowIdxByClient) {
        const sheetRow = rowIdxByClient[clientName] + 2;
        writes.push({ range: `EomExcludedClients!C${sheetRow}`, values: [[sortOrder]] });
      } else {
        newRows.push([clientName, false, sortOrder]);
      }
    });
    if (writes.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: automationCommanderSheetId, requestBody: { valueInputOption: "RAW", data: writes },
      });
    }
    if (newRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "EomExcludedClients!A:C", valueInputOption: "RAW",
        requestBody: { values: newRows },
      });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomSaveTemplate(req, res, sheets) {
  const { automationCommanderSheetId, templateId, name, defaultNotes, linkedFunction, active, alertCategories } = req.body;
  if (!automationCommanderSheetId || !name) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:H1000" });
    const rows = resp.data.values || [];

    if (templateId) {
      const rowIdx = rows.findIndex(r => r[0] === templateId);
      if (rowIdx === -1) return res.status(404).json({ success: false, error: "Template not found" });
      const sheetRow = rowIdx + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `EomTemplates!B${sheetRow}:E${sheetRow}`,
        valueInputOption: "RAW", requestBody: { values: [[name, defaultNotes || "", linkedFunction || "", active !== false]] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `EomTemplates!G${sheetRow}`,
        valueInputOption: "RAW", requestBody: { values: [[alertCategories || ""]] },
      });
      return res.status(200).json({ success: true, templateId });
    }

    const newId = `tmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A:H", valueInputOption: "RAW",
      requestBody: { values: [[newId, name, defaultNotes || "", linkedFunction || "", true, new Date().toISOString(), alertCategories || "", Date.now()]] },
    });
    return res.status(200).json({ success: true, templateId: newId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomGetClientTasks(req, res, sheets) {
  const { automationCommanderSheetId, clientName: filterClient } = req.body;
  if (!automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const [tasksResp, templatesResp] = await Promise.all([
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" })),
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:G1000" })),
    ]);
    const templateNameById = {};
    const templateLinkedFunctionById = {};
    const templateAlertCategoriesById = {};
    (templatesResp.data.values || []).forEach(r => {
      if (r[0]) { templateNameById[r[0]] = r[1] || ""; templateLinkedFunctionById[r[0]] = r[3] || ""; templateAlertCategoriesById[r[0]] = r[6] || ""; }
    });

    const rows = (tasksResp.data.values || []).filter(r => r[0]);
    const tasks = rows
      .filter(r => !filterClient || r[1] === filterClient)
      .map((r, i) => ({
        taskId: r[0], clientName: r[1], templateId: r[2] || "",
        name: r[2] ? (templateNameById[r[2]] || "(template deleted)") : (r[3] || ""),
        linkedFunction: r[2] ? (templateLinkedFunctionById[r[2]] || "") : "",
        alertCategories: r[2] ? (templateAlertCategoriesById[r[2]] || "") : "",
        clientNotes: r[4] || "", active: r[5] !== "FALSE" && r[5] !== false, createdAt: r[6] || "",
        sortOrder: r[7] !== undefined && r[7] !== "" ? Number(r[7]) : 1000000 + i,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return res.status(200).json({ success: true, tasks });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomGetClientDetail(req, res, sheets) {
  const { automationCommanderSheetId, clientName: detailClient, monthKey: detailMonthKey } = req.body;
  if (!automationCommanderSheetId || !detailClient || !detailMonthKey) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const [tasksResp, templatesResp, statusResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" }),
      sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:G1000" }),
      sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:F200000" }),
    ]);
    const templateNameById = {};
    const templateLinkedFunctionById = {};
    const templateAlertCategoriesById = {};
    (templatesResp.data.values || []).forEach(r => {
      if (r[0]) { templateNameById[r[0]] = r[1] || ""; templateLinkedFunctionById[r[0]] = r[3] || ""; templateAlertCategoriesById[r[0]] = r[6] || ""; }
    });

    const rows = (tasksResp.data.values || []).filter(r => r[0]);
    const tasks = rows
      .filter(r => r[1] === detailClient)
      .map((r, i) => ({
        taskId: r[0], clientName: r[1], templateId: r[2] || "",
        name: r[2] ? (templateNameById[r[2]] || "(template deleted)") : (r[3] || ""),
        linkedFunction: r[2] ? (templateLinkedFunctionById[r[2]] || "") : "",
        alertCategories: r[2] ? (templateAlertCategoriesById[r[2]] || "") : "",
        clientNotes: r[4] || "", active: r[5] !== "FALSE" && r[5] !== false, createdAt: r[6] || "",
        sortOrder: r[7] !== undefined && r[7] !== "" ? Number(r[7]) : 1000000 + i,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const statusOverrides = (statusResp.data.values || [])
      .filter(r => r[0] === detailClient && r[2] === detailMonthKey)
      .map(r => ({ clientName: r[0], taskId: r[1], status: r[3] || "pending", notelet: r[5] || "" }));

    return res.status(200).json({ success: true, tasks, statusOverrides });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomSaveClientTask(req, res, sheets) {
  const { automationCommanderSheetId, taskId, clientName: taskClientName, templateId: taskTemplateId, taskName, clientNotes, active: taskActive } = req.body;
  if (!automationCommanderSheetId || !taskClientName || (!taskTemplateId && !taskName)) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" }));
    const rows = resp.data.values || [];

    if (taskId) {
      const rowIdx = rows.findIndex(r => r[0] === taskId);
      if (rowIdx === -1) return res.status(404).json({ success: false, error: "Task assignment not found" });
      const sheetRow = rowIdx + 2;
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `EomClientTasks!B${sheetRow}:F${sheetRow}`,
        valueInputOption: "RAW", requestBody: { values: [[taskClientName, taskTemplateId || "", taskName || "", clientNotes || "", taskActive !== false]] },
      }));
      return res.status(200).json({ success: true, taskId });
    }

    const newId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A:H", valueInputOption: "RAW",
      requestBody: { values: [[newId, taskClientName, taskTemplateId || "", taskName || "", clientNotes || "", true, new Date().toISOString(), Date.now()]] },
    }));
    return res.status(200).json({ success: true, taskId: newId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomGetMonthStatus(req, res, sheets) {
  const { automationCommanderSheetId, monthKey, clientName: statusClient } = req.body;
  if (!automationCommanderSheetId || !monthKey) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const [tasksResp, templatesResp] = await Promise.all([
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:G5000" })),
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:G1000" })),
    ]);
    const templateLinkedFunctionById = {};
    const templateAlertCategoriesById = {};
    (templatesResp.data.values || []).forEach(r => {
      if (r[0]) { templateLinkedFunctionById[r[0]] = r[3] || ""; templateAlertCategoriesById[r[0]] = r[6] || ""; }
    });

    const activeTasks = (tasksResp.data.values || [])
      .filter(r => r[0] && (r[5] !== "FALSE" && r[5] !== false))
      .filter(r => !statusClient || r[1] === statusClient)
      .map(r => ({
        taskId: r[0], clientName: r[1],
        linkedFunction: r[2] ? (templateLinkedFunctionById[r[2]] || "") : "",
        alertCategories: r[2] ? (templateAlertCategoriesById[r[2]] || "") : "",
      }));

    const statusResp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:F200000" }));
    const statusOverrides = (statusResp.data.values || [])
      .filter(r => (!statusClient || r[0] === statusClient) && r[2] === monthKey)
      .map(r => ({ clientName: r[0], taskId: r[1], status: r[3] || "pending", notelet: r[5] || "" }));

    return res.status(200).json({ success: true, monthKey, activeTasks, statusOverrides });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomUpdateTaskStatus(req, res, sheets) {
  const { automationCommanderSheetId, clientName: uClientName, taskId: uTaskId, monthKey: uMonthKey, status: uStatus } = req.body;
  if (!automationCommanderSheetId || !uClientName || !uTaskId || !uMonthKey || !uStatus) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:F200000" }));
    const rows = resp.data.values || [];
    const rowIdx = rows.findIndex(r => r[0] === uClientName && r[1] === uTaskId && r[2] === uMonthKey);
    const completedAt = uStatus === "done" ? new Date().toISOString() : "";

    if (rowIdx === -1) {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A:F", valueInputOption: "RAW",
        requestBody: { values: [[uClientName, uTaskId, uMonthKey, uStatus, completedAt, ""]] },
      }));
    } else {
      const sheetRow = rowIdx + 2;
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `EomMonthlyStatus!D${sheetRow}:E${sheetRow}`,
        valueInputOption: "RAW", requestBody: { values: [[uStatus, completedAt]] },
      }));
    }

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: uClientName,
      category: "EOM",
      action: "EoM Task Updated",
      summary: `Updated EoM task '${uTaskId}' status to ${uStatus} for ${uClientName} (${uMonthKey})`,
      details: { clientName: uClientName, taskId: uTaskId, monthKey: uMonthKey, status: uStatus }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomUpdateTaskStatusBatch(req, res, sheets) {
  const { updates, automationCommanderSheetId } = req.body;
  if (!updates || !updates.length || !automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing updates" });
  try {
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:F200000" }));
    const rows = resp.data.values || [];
    
    const appends = [];
    const updateRequests = [];
    const nowIso = new Date().toISOString();

    for (const u of updates) {
      const rowIdx = rows.findIndex(r => r[0] === u.clientName && r[1] === u.taskId && r[2] === u.monthKey);
      const completedAt = u.status === "done" ? nowIso : "";
      
      if (rowIdx === -1) {
        rows.push([u.clientName, u.taskId, u.monthKey, u.status, completedAt, ""]);
        appends.push([u.clientName, u.taskId, u.monthKey, u.status, completedAt, ""]);
      } else {
        const sheetRow = rowIdx + 2;
        updateRequests.push({
          range: `EomMonthlyStatus!D${sheetRow}:E${sheetRow}`,
          values: [[u.status, completedAt]]
        });
        rows[rowIdx][3] = u.status;
        rows[rowIdx][4] = completedAt;
      }
    }

    if (appends.length > 0) {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A:F", valueInputOption: "RAW",
        requestBody: { values: appends },
      }));
    }
    if (updateRequests.length > 0) {
      await withRetry(() => sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: automationCommanderSheetId, requestBody: { valueInputOption: "RAW", data: updateRequests },
      }));
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomUpdateTaskNotelet(req, res, sheets) {
  const { automationCommanderSheetId, clientName: uClientName, taskId: uTaskId, monthKey: uMonthKey, notelet } = req.body;
  if (!automationCommanderSheetId || !uClientName || !uTaskId || !uMonthKey) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:F200000" }));
    const rows = resp.data.values || [];
    const rowIdx = rows.findIndex(r => r[0] === uClientName && r[1] === uTaskId && r[2] === uMonthKey);

    if (rowIdx === -1) {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A:F", valueInputOption: "RAW",
        requestBody: { values: [[uClientName, uTaskId, uMonthKey, "pending", "", notelet || ""]] },
      }));
    } else {
      const sheetRow = rowIdx + 2;
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `EomMonthlyStatus!F${sheetRow}`,
        valueInputOption: "RAW", requestBody: { values: [[notelet || ""]] },
      }));
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomReorderTasks(req, res, sheets) {
  const { automationCommanderSheetId, clientName: rClientName, orderedTaskIds } = req.body;
  if (!automationCommanderSheetId || !rClientName || !Array.isArray(orderedTaskIds) || orderedTaskIds.length === 0) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" });
    const rows = resp.data.values || [];
    const rowIndexByTaskId = {};
    rows.forEach((r, i) => { if (r[0]) rowIndexByTaskId[r[0]] = i + 2; });

    const writes = [];
    orderedTaskIds.forEach((taskId, index) => {
      const sheetRow = rowIndexByTaskId[taskId];
      if (!sheetRow) return; 
      writes.push({ range: `EomClientTasks!H${sheetRow}`, values: [[(index + 1) * 10]] });
    });
    if (writes.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: automationCommanderSheetId, requestBody: { valueInputOption: "RAW", data: writes },
      });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomReorderTemplates(req, res, sheets) {
  const { automationCommanderSheetId, orderedTemplateIds } = req.body;
  if (!automationCommanderSheetId || !Array.isArray(orderedTemplateIds) || orderedTemplateIds.length === 0) return res.status(400).json({ success: false, error: "Missing orderedTemplateIds" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:H1000" });
    const rows = resp.data.values || [];
    const rowIndexByTemplateId = {};
    rows.forEach((r, i) => { if (r[0]) rowIndexByTemplateId[r[0]] = i + 2; });

    const writes = [];
    orderedTemplateIds.forEach((templateId, index) => {
      const sheetRow = rowIndexByTemplateId[templateId];
      if (!sheetRow) return; 
      writes.push({ range: `EomTemplates!H${sheetRow}`, values: [[(index + 1) * 10]] });
    });
    if (writes.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: automationCommanderSheetId, requestBody: { valueInputOption: "RAW", data: writes },
      });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomLoadBankAccounts(req, res, sheets) {
  const { automationCommanderSheetId } = req.body;
  if (!automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const clientResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "AutoUpdates!A2:N500" });
    const clients = (clientResp.data.values || [])
      .map(r => ({ clientName: String(r[0] || "").trim(), clientSheetUrl: r[11] }))
      .filter(c => c.clientName && c.clientSheetUrl)
      .filter(c => c.clientName.toLowerCase() !== "client" && c.clientName.toLowerCase() !== "client name");

    const loadedAt = new Date().toISOString();
    const newRows = [];
    const failedClients = [];
    for (const c of clients) {
      try {
        const clientSheetId = extractSheetIdFromUrl(c.clientSheetUrl) || String(c.clientSheetUrl).trim();
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "KeyInfo!H12:H22" });
        const accountNames = (resp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
        accountNames.forEach(name => newRows.push([c.clientName, name, loadedAt]));
      } catch (clientErr) {
        failedClients.push(c.clientName);
      }
    }

    const existingResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomBankAccounts!A2:C50000" });
    const existingRowCount = (existingResp.data.values || []).length;
    if (existingRowCount > 0) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: automationCommanderSheetId, range: `EomBankAccounts!A2:C${existingRowCount + 1}`,
      });
    }
    if (newRows.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: "EomBankAccounts!A2", valueInputOption: "RAW",
        requestBody: { values: newRows },
      });
    }
    return res.status(200).json({ success: true, clientsProcessed: clients.length, accountsLoaded: newRows.length, failedClients });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomGetBankAccounts(req, res, sheets) {
  const { automationCommanderSheetId } = req.body;
  if (!automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomBankAccounts!A2:C50000" }));
    const rows = (resp.data.values || []).filter(r => r[0] && r[1]);
    const accountsByClient = {};
    let loadedAt = "";
    rows.forEach(r => {
      if (!accountsByClient[r[0]]) accountsByClient[r[0]] = [];
      accountsByClient[r[0]].push(r[1]);
      if (r[2]) loadedAt = r[2]; 
    });
    return res.status(200).json({ success: true, accountsByClient, loadedAt });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomGetCashBalanceProgress(req, res, sheets) {
  const { automationCommanderSheetId, monthKey: progressTargetMonthKey } = req.body;
  if (!automationCommanderSheetId || !progressTargetMonthKey) return res.status(400).json({ success: false, error: "Missing required fields" });
  const progressWorkMonthKey = eomTargetMonthToWorkMonth_(progressTargetMonthKey);
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);
    const [templatesR, clientTasksR, statusR] = await Promise.all([
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:F1000" })),
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" })),
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:E200000" })),
    ]);
    const cashTemplateIds = new Set((templatesR.data.values || []).filter(r => r[0] && r[3] === "cash_balance").map(r => r[0]));
    const cashTaskIdByClient = {};
    (clientTasksR.data.values || []).forEach(r => {
      if (r[0] && cashTemplateIds.has(r[2]) && (r[5] !== "FALSE" && r[5] !== false)) cashTaskIdByClient[r[1]] = r[0];
    });
    const statusRows = statusR.data.values || [];
    const completedClients = Object.keys(cashTaskIdByClient).filter(clientName => {
      const taskId = cashTaskIdByClient[clientName];
      return statusRows.some(r => r[0] === clientName && r[1] === taskId && r[2] === progressWorkMonthKey && r[3] === "done");
    });
    return res.status(200).json({ success: true, completedClients, hasLinkedTemplate: cashTemplateIds.size > 0 });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomSaveCashBalance(req, res, sheets) {
  const { automationCommanderSheetId, clientSheetId: cashClientSheetId, clientName: cashClientName, monthKey: cashTargetMonthKey, amounts } = req.body;
  if (!automationCommanderSheetId || !cashClientSheetId || !cashClientName || !cashTargetMonthKey || !Array.isArray(amounts) || amounts.length === 0) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  const numericAmounts = amounts.map(a => parseFloat(a)).filter(a => !isNaN(a) && a !== 0);
  if (numericAmounts.length === 0) return res.status(400).json({ success: false, error: "No valid, non-zero amounts provided" });
  try {
    const monthLabel = eomKeyToMonthStr_(cashTargetMonthKey);
    const [headerResp, colAResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: cashClientSheetId, range: "Cash!1:1" }),
      sheets.spreadsheets.values.get({ spreadsheetId: cashClientSheetId, range: "Cash!A1:A200" }),
    ]);
    const headers = headerResp.data.values?.[0] || [];
    let targetColIdx0 = -1;
    for (let i = 0; i < headers.length; i++) {
      if (headers[i] && isDateMatchJs_(headers[i], monthLabel)) { targetColIdx0 = i; break; }
    }
    if (targetColIdx0 === -1) return res.status(400).json({ success: false, error: `Could not find a column for ${monthLabel} on the Cash tab.` });
    const colAValues = colAResp.data.values || [];
    const targetRowIdx = colAValues.findIndex(r => String(r[0] || "").trim().toLowerCase() === "actual closing balance");
    if (targetRowIdx === -1) return res.status(400).json({ success: false, error: `Could not find a row labelled "Actual closing balance" on the Cash tab.` });
    const targetColLetter = columnIndexToLetter_(targetColIdx0 + 1);
    const targetRow = targetRowIdx + 1;
    const formula = "=" + numericAmounts.join("+");

    await sheets.spreadsheets.values.update({
      spreadsheetId: cashClientSheetId, range: `Cash!${targetColLetter}${targetRow}`,
      valueInputOption: "USER_ENTERED", requestBody: { values: [[formula]] },
    });

    const cashWorkMonthKey = eomTargetMonthToWorkMonth_(cashTargetMonthKey);
    await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, cashClientName, "cash_balance", cashWorkMonthKey);

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: cashClientName,
      category: "EOM",
      action: "Cash Balance Saved",
      summary: `Saved cash balance formula ${formula} on Cash!${targetColLetter}${targetRow} for ${cashClientName}`,
      details: { clientName: cashClientName, formula, targetCol: targetColLetter, targetRow }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, formula, targetCol: targetColLetter, targetRow });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomCreateDashboardBackup(req, res, sheets) {
  const { automationCommanderSheetId, clientSheetId, clientName: backupClientName, workMonthKey: backupWorkMonthKey } = req.body;
  if (!automationCommanderSheetId || !clientSheetId || !backupClientName || !backupWorkMonthKey) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    const clientResp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "AutoUpdates!A2:E500" }));
    const clientRows = clientResp.data.values || [];
    const row = clientRows.find(r => String(r[0] || "").trim() === backupClientName);
    if (!row || !row[4]) return res.status(400).json({ success: false, error: "No backup sheet URL found in AutoUpdates column E for this client." });
    const backupSheetId = extractSheetIdFromUrl(row[4]) || String(row[4]).trim();

    const sourceMeta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: clientSheetId, fields: "sheets.properties" }));
    const sourceSheet = sourceMeta.data.sheets.find(s => s.properties.title === "Dashboard");
    if (!sourceSheet) return res.status(400).json({ success: false, error: "Source client sheet does not have a 'Dashboard' tab." });
    const sourceSheetId = sourceSheet.properties.sheetId;

    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const tabName = `${yy}${mm}${dd}`;

    const backupMeta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: backupSheetId, fields: "sheets.properties" }));
    const existingSheet = backupMeta.data.sheets.find(s => s.properties.title === tabName);
    if (existingSheet) {
      await withRetry(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId: backupSheetId,
        requestBody: { requests: [{ deleteSheet: { sheetId: existingSheet.properties.sheetId } }] }
      }));
    }

    const copyResp = await withRetry(() => sheets.spreadsheets.sheets.copyTo({
      spreadsheetId: clientSheetId, sheetId: sourceSheetId, requestBody: { destinationSpreadsheetId: backupSheetId }
    }));
    const newSheetId = copyResp.data.sheetId;

    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: backupSheetId,
      requestBody: {
        requests: [{ updateSheetProperties: { properties: { sheetId: newSheetId, title: tabName, index: 0 }, fields: "title,index" } }]
      }
    }));

    const sourceDataResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: clientSheetId, range: "Dashboard!A1:ZZ", valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER"
    }));
    const sourceData = sourceDataResp.data.values || [];
    
    if (sourceData.length > 0) {
      await withRetry(() => sheets.spreadsheets.values.clear({ spreadsheetId: backupSheetId, range: `'${tabName}'!A1:ZZ` }));
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: backupSheetId, range: `'${tabName}'!A1`, valueInputOption: "RAW", requestBody: { values: sourceData }
      }));
    }

    await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, backupClientName, "create_backup", backupWorkMonthKey);

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: backupClientName,
      category: "EOM",
      action: "Dashboard Backup Created",
      summary: `Created dashboard backup sheet '${tabName}' for ${backupClientName}`,
      details: { clientName: backupClientName, tabName }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, tabName });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomMarkMonthActual(req, res, sheets) {
  const { automationCommanderSheetId, clientSheetId: perfClientSheetId, clientName: perfClientName, workMonthKey: perfWorkMonthKey } = req.body;
  if (!automationCommanderSheetId || !perfClientSheetId || !perfClientName || !perfWorkMonthKey) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    const targetMonthKey = eomWorkMonthToTargetMonth_(perfWorkMonthKey);
    const monthLabel = eomKeyToMonthStr_(targetMonthKey);

    const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId: perfClientSheetId, range: "Performance!1:1" });
    const headers = headerResp.data.values?.[0] || [];
    let targetColIdx0 = -1;
    for (let i = 0; i < headers.length; i++) {
      if (headers[i] && isDateMatchJs_(headers[i], monthLabel)) { targetColIdx0 = i; break; }
    }
    if (targetColIdx0 === -1) return res.status(400).json({ success: false, error: `Could not find a column for ${monthLabel} on the Performance tab.` });
    const targetColLetter = columnIndexToLetter_(targetColIdx0 + 1);

    await sheets.spreadsheets.values.update({
      spreadsheetId: perfClientSheetId, range: `Performance!${targetColLetter}2`,
      valueInputOption: "USER_ENTERED", requestBody: { values: [["Actual"]] },
    });

    await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, perfClientName, "mark_actual", perfWorkMonthKey);

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: perfClientName,
      category: "EOM",
      action: "Month Marked Actual",
      summary: `Marked month ${monthLabel} as Actual on Performance tab for ${perfClientName}`,
      details: { clientName: perfClientName, month: monthLabel, col: targetColLetter }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, monthLabel, targetCol: targetColLetter });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export const EOM_SEED_DATA = {
  "templates": [
    {
      "name": "Check and sort invoice discrepancies (InvComp)",
      "clients": {
        "Thrive": "Check and sort invoice discrepancies (InvComp)",
        "Eleven": "Check and sort invoice discrepancies (InvComp)",
        "Orinoco": "Check and sort invoice discrepancies (InvComp)",
        "Rascal": "Check and sort invoice discrepancies (InvComp)",
        "Base Three": "Check and sort invoice discrepancies (InvComp)",
        "Incredibble": "Check and sort any invoice discrepancies (InvComp)",
        "Get Better": "Check and sort any invoice discrepancies (InvComp)",
        "Starlight": "Check and sort any invoice discrepancies (InvComp)",
        "GeoBrand": "Check and sort any invoice discrepancies (InvComp)",
        "Seen": "Check and sort any invoice discrepancies (InvComp)"
      }
    },
    {
      "name": "Add actuals to salaries",
      "clients": {
        "Thrive": "Add actuals to salaries",
        "Eleven": "Add actuals to salaries",
        "Orinoco": "Add actuals to salaries",
        "Advance Online": "Add actuals to salaries",
        "Incredibble": "Add actuals to salaries",
        "ANRPR": "Add actuals to salaries",
        "Starlight": "Import salaries info AND check employee list is accurate",
        "GeoBrand": "Import salaries info AND check employee list is accurate",
        "Seen": "Import salaries info AND check employee list is accurate"
      }
    },
    {
      "name": "Use PLComp to add actual outgoings for current and prev month",
      "clients": {
        "Thrive": "Use PLComp to add actual outgoings for current and prev month",
        "Eleven": "Use PLComp to add actual outgoings for current and prev month",
        "Orinoco": "Use PLComp to add actual outgoings for current and prev month",
        "Advance Online": "Use PLComp to add actual outgoings for current and prev month",
        "Beyond the Blueprint": "Use PLComp to add actual outgoings for current and prev month",
        "Rascal": "Use PLComp to add actual outgoings for current and prev month",
        "ANRPR": "Use PLComp to add actual outgoings for current and prev month",
        "Hancock & Rowe": "Use PLComp to add actual outgoings for current and prev month",
        "Base Three": "Use PLComp to add actual outgoings for current and prev month",
        "Incredibble": "Use recon tab and PLComp to add actual outgoings for current and prev month",
        "Get Better": "Use recon tab and PLComp to add actual outgoings for current and prev month",
        "Starlight": "Use recon tab and PLComp to add actual outgoings for current and prev month",
        "GeoBrand": "Use recon tab and PLComp to add actual outgoings for current and prev month",
        "Seen": "Use recon tab and PLComp to add actual outgoings for current and prev month"
      }
    },
    {
      "name": "Send end of month data request email",
      "clients": {
        "Thrive": "Send end of month data request email (payslips, leave tracker, conf + pipe)",
        "Eleven": "Send end of month data request email (payslips, contr)",
        "Orinoco": "Send end of month data request email (payslips, contr, pipe)",
        "Advance Online": "Send end of month data request email (payslips)",
        "ANRPR": "Send end of month data request email (payslips)",
        "Hancock & Rowe": "Send end of month data request email"
      }
    },
    {
      "name": "Add bank account closing balance",
      "clients": {
        "Thrive": "Add bank account closing balance",
        "Eleven": "Add bank account closing balance",
        "Orinoco": "Add bank account closing balance",
        "Advance Online": "Add bank account closing balance",
        "Incredibble": "Add bank account closing balance",
        "ANRPR": "Add bank account closing balance",
        "Starlight": "Add bank account closing balance",
        "GeoBrand": "Add bank account closing balance",
        "Seen": "Add bank account closing balance"
      }
    },
    {
      "name": "Reconcile cashflow forecast against actual",
      "clients": {
        "Thrive": "Reconcile cashflow forecast against actual (use bank recon sheet)",
        "Eleven": "Reconcile cashflow forecast against actual (use bank recon sheet)",
        "Orinoco": "Reconcile cashflow forecast against actual",
        "Advance Online": "Reconcile cashflow forecast against actual (use bank recon sheet)",
        "Incredibble": "Reconcile cashflow forecast against actual",
        "Rascal": "Reconcile cashflow forecast against actual",
        "Get Better": "Reconcile cashflow forecast against actual",
        "ANRPR": "Reconcile cashflow forecast against actual (use bank recon sheet)",
        "Starlight": "Reconcile cashflow forecast against actual",
        "GeoBrand": "Reconcile cashflow forecast against actual",
        "Seen": "Reconcile cashflow forecast against actual",
        "Hancock & Rowe": "Reconcile cashflow forecast against actual"
      }
    },
    {
      "name": "Change \"forecast\" to \"actual\" in Master Performance tab",
      "clients": {
        "Thrive": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Eleven": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Orinoco": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Advance Online": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Incredibble": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Beyond the Blueprint": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Get Better": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "ANRPR": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Starlight": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "GeoBrand": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Seen": "Change \"forecast\" to \"actual\" in Master Performance tab"
      }
    },
    {
      "name": "Create backup of dashboard in static sheet",
      "clients": {
        "Thrive": "Create backup of dashboard in static sheet",
        "Eleven": "Create backup of dashboard in static sheet",
        "Orinoco": "Create backup of dashboard in static sheet",
        "Advance Online": "Create backup of dashboard in static sheet",
        "Beyond the Blueprint": "Create backup of dashboard in static sheet",
        "Rascal": "Create backup of dashboard in static sheet",
        "Get Better": "Create backup of dashboard in static sheet",
        "ANRPR": "Create backup of dashboard in static sheet",
        "Base Three": "Create backup of dashboard in static sheet"
      }
    },
    {
      "name": "Create and send monthly management report",
      "clients": {
        "Thrive": "Create and send monthly management report",
        "Eleven": "Create and send monthly management report",
        "Orinoco": "Create and send monthly management report",
        "Advance Online": "Create and send monthly management report",
        "ANRPR": "Create and send monthly management report"
      }
    },
    {
      "name": "Check tracker against Xero re corp tax",
      "clients": {
        "Eleven": "Check tracker against Xero re corp tax",
        "Orinoco": "Check tracker against Xero re corp tax",
        "Hancock & Rowe": "Check tracker against Xero re corp tax"
      }
    },
    {
      "name": "Send tax transfer amounts",
      "clients": {
        "Eleven": "Send tax transfer amounts",
        "Orinoco": "Send tax transfer amounts",
        "Hancock & Rowe": "Send tax transfer amounts"
      }
    },
    {
      "name": "Check and sort expense discrepancies (DirComp)",
      "clients": {
        "Incredibble": "Check and sort expense discrepancies (DirComp)",
        "Get Better": "Check and sort expense discrepancies (DirComp)",
        "GeoBrand": "Check and sort expense discrepancies (DirComp)",
        "Seen": "Check and sort expense discrepancies (DirComp)"
      }
    },
    {
      "name": "Check and sort confirmed and pipeline discrepancies (CRMComp)",
      "clients": {
        "Rascal": "Check and sort confirmed and pipeline discrepancies (CRMComp)",
        "Starlight": "Check and sort confirmed and pipeline discrepancies (CRMComp)",
        "GeoBrand": "Check and sort confirmed and pipeline discrepancies (CRMComp)",
        "Seen": "Check and sort confirmed and pipeline discrepancies (CRMComp)"
      }
    },
    {
      "name": "Check retainer jobs all have invoices",
      "clients": {
        "Get Better": "Check retainer jobs all have invoices (i.e. check they haven't finished without us being told)",
        "Starlight": "Check retainer jobs all have invoices (i.e. check they haven't finished without us being told)",
        "GeoBrand": "Check retainer jobs all have invoices (i.e. check they haven't finished without us being told)",
        "Seen": "Check retainer jobs all have invoices (i.e. check they haven't finished without us being told)"
      }
    },
    {
      "name": "Compare dashboard month to Xero month and make changes as required",
      "clients": {
        "Get Better": "Compare dashboard month to Xero month and make changes as required (if revenue doesn't match, look for phasing differences. Also have the \"revenue comparison\" sheet available - download all revenue items from Xero, compile, then get Gemini to compare with revenue items from dashboard)",
        "Starlight": "Compare dashboard month to Xero month and make changes as required (if revenue doesn't match, look for phasing differences. Also have the \"revenue comparison\" sheet available - download all revenue items from Xero, compile, then get Gemini to compare with revenue items from dashboard)",
        "GeoBrand": "Compare dashboard month to Xero month and make changes as required (if revenue doesn't match, look for phasing differences. Also have the \"revenue comparison\" sheet available - download all revenue items from Xero, compile, then get Gemini to compare with revenue items from dashboard)",
        "Seen": "Compare dashboard month to Xero month and make changes as required (if revenue doesn't match, look for phasing differences. Also have the \"revenue comparison\" sheet available - download all revenue items from Xero, compile, then get Gemini to compare with revenue items from dashboard)"
      }
    }
  ],
  "customTasks": {
    "Thrive": [
      "Update NB to find figures (incl remove any from \"current month\")",
      "Add actuals to leave",
      "Send email requesting closing bank account balance",
      "Update utilisation numbers (WMJ: Reports - Billable Summary - Hours)",
      "Update project overservicing numbers (Resource Manager - Traffic Calendar - Task Date (make it \"Due\") - custom - enter previous month's dates - click Completed Tasks - click Search - Print ) ... copy into \"Thrive project analysis\" FIRST sheet",
      "Time breakdown (WMJ: Reports - Proj Fin Reports - Time Detail Data (no costs)) - might need to search for it!"
    ],
    "Eleven": [
      "Check pipeline is updated",
      "Update contractors based on actual bills and Ben's forecast",
      "Zero \"making up CoS\" row",
      "Add extra invoices for prev month once Ben replies",
      "Check and update third party pass-through costs",
      "Check N&O commissions against tracker (N&O x Eleven \u2013 Introduction & Referral Tracker)",
      "Update tax tracker tab",
      "Send dividend certificate"
    ],
    "Orinoco": [
      "Check confirmed job dates - do any need changing? (During monthly finance meeting)",
      "Check pipeline is updated (no need for this as Capsule link created)",
      "Update contractors based on actual bills and Bianca's forecast",
      "Zero \"making up CoS\" row",
      "Check and update third party pass-through costs"
    ],
    "Advance Online": [
      "Request closing bank account balances",
      "Update revenue based on figure from Quickbooks",
      "Manualy add contractor costs into Outgoings tab (EXCLUDING EMMERL)",
      "Manualy add total Emmerl costs into Outgoings tab (go into Emmerl in Quickbooks and get \"total expenses\" figure)",
      "Ensure loan costs are correctly captured in cashflow"
    ],
    "Incredibble": [
      "Send email requesting closing bank account balance",
      "Move expenses in Outgoings to correct months if required, and split out any Incredibble own marketing to separate 0% delivery row",
      "Calculate corp tax and VAT amounts to transfer and tell Helen",
      "Email Helen to say it's ready"
    ],
    "Beyond the Blueprint": [
      "Check and update confirmed tab",
      "Check and update pipeline tab",
      "Check and update partner invoices",
      "Add recharged expenses to column R of Confirmed tab (only include things that have actually been recharged on an invoice)",
      "Update partner win fees in dashboard",
      "Send partners emails telling them the win fee amounts",
      "Create partner win fee accruals bills",
      "Update partner dashboard tab",
      "Tell Patrick and Gareth dashboard is updated",
      "Review transactions for VAT return"
    ],
    "Rascal": [
      "Complete Xero reconciliations (make list of invoices needed first)",
      "Check all cont. dir. costs updated and captured in conf & pipe for cash",
      "Create monthly management report",
      "Check balance sheet accounts (including wages payable, NICs, PAYE, stud. loan)",
      "Payroll prep",
      "Update BrightPay PAYE paid figure for prev month",
      "Download coding notices",
      "Payroll submission",
      "Payroll journal",
      "Ensure FPS submitted in BrightPay",
      "Pension contributions in Aviva portal",
      "Schedule salary payments"
    ],
    "Get Better": [
      "Import salaries info AND check employee list is accurate (Rippling - Reports - FY Salaries & Deductions (PAUL) - Change \"Date as of\" and \"Pay Run Name\" Filter Date - Download - IMPORT AS-IS (I FIXED THIS 18/8/26) ... OLD APPROACH WAS: CHANGE COLUMN HEADER NAMES TO REFLECT SHEET - DELETE EXTRANEOUS COLUMNS - SAVE AS JPEG AND IMPORT INTO AMD)",
      "Check and sort pipeline discrepancies (CRMComp)",
      "Check depreciation has been captured correctly - enter in Outgoings if not",
      "Send Patrick any queries and update dashboard accordingly",
      "Email Rich and Patrick to say it's ready"
    ],
    "ANRPR": [
      "Request closing bank account balances",
      "Check InvComp and DirComp",
      "Calculate corp tax and VAT amounts to transfer"
    ],
    "Starlight": [
      "Email Steve asking for payroll summary",
      "Send Steve any queries and update dashboard accordingly",
      "Email Steve to say Pulse is updated and ready"
    ],
    "GeoBrand": [
      "Email asking for payroll summary",
      "Send queries and update dashboard accordingly",
      "Email to say Pulse is updated and ready"
    ],
    "Seen": [
      "Email asking for payroll summary",
      "Send queries and update dashboard accordingly",
      "Calculate \"what salaries + divs should be\" figure",
      "Email to say Pulse is updated and ready, and provide salaries figure"
    ],
    "Hancock & Rowe": [
      "Use InvComp to make dashboard invoices match Xero",
      "Check confirmed income for prev month",
      "Update salaries",
      "Update contractors",
      "Update third party pass-through costs",
      "Create backup of dashboard in extension"
    ],
    "Astra": [
      "Check income for prev month - have we recognised income for all projects - particularly those working from prepayments?",
      "Review contractor costs for prev month - i.e. compare tracker to QB and flag any discrepancies",
      "Update outgoings based on QB and flag any issues with bookkeeping",
      "Overwrite dollar amounts with actuals on Rev and Cont tabs",
      "Finalise accounts in dashboard"
    ],
    "TaxWatch": [
      "Reconcile tracker against statements etc"
    ],
    "Meee": [
      "Approve bills in Xero"
    ],
    "Base Three": [
      "Check with Dania that pipeline is updated",
      "Update contractors based on QB numbers",
      "Update partner payments for previous month from QB + Dania",
      "Tell Dania dashboard is updated"
    ]
  }
};

export async function handleEomSeedFromChecklist(req, res, sheets) {
  const { automationCommanderSheetId } = req.body;
  if (!automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    await ensureEomTabs_(sheets, automationCommanderSheetId);

    const clientResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "AutoUpdates!A2:N500" });
    const liveClients = (clientResp.data.values || [])
      .map(r => String(r[0] || "").trim())
      .filter(Boolean)
      .filter(n => n.toLowerCase() !== "client" && n.toLowerCase() !== "client name");

    const matchShortName = (shortName) => {
      const norm = shortName.trim().toLowerCase();
      const matches = liveClients.filter(full => full.toLowerCase().startsWith(norm) || full.toLowerCase().includes(norm));
      return matches.length === 1 ? matches[0] : null;
    };

    const unmatched = new Set();
    const shortNamesUsed = new Set();
    EOM_SEED_DATA.templates.forEach(t => Object.keys(t.clients).forEach(c => shortNamesUsed.add(c)));
    Object.keys(EOM_SEED_DATA.customTasks).forEach(c => shortNamesUsed.add(c));
    const shortToFull = {};
    shortNamesUsed.forEach(s => {
      const full = matchShortName(s);
      if (full) shortToFull[s] = full; else unmatched.add(s);
    });

    const existingTemplatesResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:F1000" });
    const existingTemplateByName = {};
    (existingTemplatesResp.data.values || []).forEach(r => { if (r[0]) existingTemplateByName[r[1]] = r[0]; });

    const newTemplateRows = [];
    const templateIdByName = { ...existingTemplateByName };
    for (const t of EOM_SEED_DATA.templates) {
      if (templateIdByName[t.name]) continue;
      const newId = `tmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const linkedFunction = t.name.toLowerCase().includes("salaries") ? "salaries" : "";
      newTemplateRows.push([newId, t.name, "", linkedFunction, true, new Date().toISOString()]);
      templateIdByName[t.name] = newId;
    }
    if (newTemplateRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A:F", valueInputOption: "RAW",
        requestBody: { values: newTemplateRows },
      });
    }

    const existingTasksResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:G5000" });
    const existingTaskKeys = new Set();
    (existingTasksResp.data.values || []).forEach(r => {
      if (r[0]) existingTaskKeys.add(`${r[1]}|||${r[2] || ""}|||${r[3] || ""}`);
    });

    const newTaskRows = [];
    let assignmentsCreated = 0;
    const orderCounter = {};
    const nextOrder = (client) => { orderCounter[client] = (orderCounter[client] || 0) + 1; return orderCounter[client]; };

    for (const t of EOM_SEED_DATA.templates) {
      const templateId = templateIdByName[t.name];
      for (const [shortName, originalText] of Object.entries(t.clients)) {
        const fullName = shortToFull[shortName];
        if (!fullName) continue;
        const key = `${fullName}|||${templateId}|||`;
        if (existingTaskKeys.has(key)) continue;
        const newId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        newTaskRows.push([newId, fullName, templateId, "", originalText, true, new Date().toISOString(), nextOrder(fullName)]);
        existingTaskKeys.add(key);
        assignmentsCreated++;
      }
    }
    for (const [shortName, taskList] of Object.entries(EOM_SEED_DATA.customTasks)) {
      const fullName = shortToFull[shortName];
      if (!fullName) continue;
      for (const taskName of taskList) {
        const key = `${fullName}|||${""}|||${taskName}`;
        if (existingTaskKeys.has(key)) continue;
        const newId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        newTaskRows.push([newId, fullName, "", taskName, "", true, new Date().toISOString(), nextOrder(fullName)]);
        existingTaskKeys.add(key);
        assignmentsCreated++;
      }
    }
    if (newTaskRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A:H", valueInputOption: "RAW",
        requestBody: { values: newTaskRows },
      });
    }

    return res.status(200).json({
      success: true,
      templatesCreated: newTemplateRows.length,
      assignmentsCreated,
      matchedClients: Object.keys(shortToFull).length,
      unmatchedClients: Array.from(unmatched),
    });
  } catch (err) {
    console.error("❌ eom_seed_from_checklist error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}