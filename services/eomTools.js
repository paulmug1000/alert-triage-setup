import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient";
import { redisClient } from "./redisClient";
import { memoryCache } from "./cacheService";
import { logPmaActivity } from "./pmaLogger";
import { getSessionUser } from "./authService";
import { getAllClients, DEFAULT_AC_SHEET_ID } from "./workspaces";

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
      r[0] && r[1] === clientName && (linkedTemplateIds.has(r[2]) || r[7] === linkedFunctionValue) && (r[5] !== "FALSE" && r[5] !== false)
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
    return linkedTask[0] || true;
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
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "KeyInfo!H12:H21" });
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
    const completedTaskId = await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, cashClientName, "cash_balance", cashWorkMonthKey);

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: cashClientName,
      category: "EOM",
      action: "Cash Balance Saved",
      summary: `Saved cash balance formula ${formula} on Cash!${targetColLetter}${targetRow} for ${cashClientName}`,
      details: { clientName: cashClientName, formula, targetCol: targetColLetter, targetRow }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, formula, targetCol: targetColLetter, targetRow, completedTaskId: typeof completedTaskId === "string" ? completedTaskId : null });
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

export function findNbToFindColIndex_(headers, monthKey) {
  if (!Array.isArray(headers) || !monthKey) return -1;
  const [targetYear, targetMonth] = monthKey.split("-").map(Number);
  const monthLabel = eomKeyToMonthStr_(monthKey);

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    if (isDateMatchJs_(h, monthLabel)) return i;

    const str = String(h).trim();
    const dMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (dMatch) {
      let m = parseInt(dMatch[2], 10);
      let y = parseInt(dMatch[3], 10);
      if (y < 100) y += 2000;
      if (y === targetYear && m === targetMonth) return i;
    }

    const num = Number(h);
    if (!isNaN(num) && num > 30000 && num < 60000) {
      const d = new Date(Math.round((num - 25569) * 86400 * 1000));
      if (d.getUTCFullYear() === targetYear && (d.getUTCMonth() + 1) === targetMonth) {
        return i;
      }
    }
  }
  return -1;
}

export async function handleEomMarkNbExclude(req, res, sheets) {
  const { automationCommanderSheetId, clientSheetId, clientName, workMonthKey, mode } = req.body;
  if (!automationCommanderSheetId || !clientSheetId || !clientName || !workMonthKey) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const targetMonthKey = eomWorkMonthToTargetMonth_(workMonthKey);
    const targetMonthLabel = eomKeyToMonthStr_(targetMonthKey);
    const currentMonthKey = workMonthKey;
    const currentMonthLabel = eomKeyToMonthStr_(currentMonthKey);

    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: clientSheetId,
      range: "NBtoFind!1:1",
      valueRenderOption: "FORMATTED_VALUE"
    });
    const headers = headerResp.data.values?.[0] || [];
    if (!headers.length) {
      return res.status(400).json({ success: false, error: "Could not read headers on the NBtoFind tab." });
    }

    const targetColIdx0 = findNbToFindColIndex_(headers, targetMonthKey);
    if (targetColIdx0 === -1) {
      return res.status(400).json({
        success: false,
        error: `Could not find a column for target month (${targetMonthLabel}) on the NBtoFind tab.`
      });
    }

    const updates = [];
    const markedMonths = [];
    const targetColLetter = columnIndexToLetter_(targetColIdx0 + 1);
    updates.push({
      range: `NBtoFind!${targetColLetter}25`,
      values: [["No"]]
    });
    markedMonths.push(targetMonthLabel);

    const shouldMarkBoth = mode === "both" || mode === "both_months";
    if (shouldMarkBoth) {
      const currentColIdx0 = findNbToFindColIndex_(headers, currentMonthKey);
      if (currentColIdx0 === -1) {
        return res.status(400).json({
          success: false,
          error: `Could not find a column for current month (${currentMonthLabel}) on the NBtoFind tab.`
        });
      }
      const currentColLetter = columnIndexToLetter_(currentColIdx0 + 1);
      updates.push({
        range: `NBtoFind!${currentColLetter}25`,
        values: [["No"]]
      });
      markedMonths.push(currentMonthLabel);
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: clientSheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates
      }
    });

    // Invalidate NBtoFind cache so the UI reflects the change immediately
    const cacheKey = `pma_nbtofind_${clientSheetId}`;
    try {
      if (redisClient?.isOpen) await redisClient.del(cacheKey);
      else memoryCache?.delete(cacheKey);
    } catch (e) {
      console.warn("NBtoFind cache invalidate error:", e?.message);
    }

    await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, clientName, "mark_nb_exclude", workMonthKey);

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName,
      category: "EOM",
      action: "Exclude NB to Find Marked",
      summary: `Marked NB to find as 'No' for ${markedMonths.join(" and ")} in row 25 on NBtoFind tab for ${clientName}`,
      details: { clientName, markedMonths, ranges: updates.map(u => u.range) }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, clientName, markedMonths, ranges: updates.map(u => u.range) });
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
      "linkedFunction": "push_outgoings",
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
      "linkedFunction": "cashflow_recon",
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
      "name": "Mark month to NOT include new business to find",
      "linkedFunction": "mark_nb_exclude",
      "clients": {}
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
      const linkedFunction = t.linkedFunction || (t.name.toLowerCase().includes("salaries") ? "salaries" : "");
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

export async function autoCompletePlcompTaskByName_(sheets, automationCommanderSheetId, clientName, workMonthKey) {
  try {
    if (!workMonthKey || !automationCommanderSheetId) return false;
    const clientTasksR = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "EomClientTasks!A2:H5000"
    }));
    const clientTasks = clientTasksR.data.values || [];
    const plcompTask = clientTasks.find(r =>
      r[0] && r[1] === clientName && String(r[3] || "").toLowerCase().includes("plcomp") && (r[5] !== "FALSE" && r[5] !== false)
    );
    if (!plcompTask) return false;

    const taskId = plcompTask[0];
    const statusResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "EomMonthlyStatus!A2:E200000"
    }));
    const statusRows = statusResp.data.values || [];
    const existingIdx = statusRows.findIndex(r => r[0] === clientName && r[1] === taskId && r[2] === workMonthKey);
    if (existingIdx === -1) {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A:E", valueInputOption: "RAW",
        requestBody: { values: [[clientName, taskId, workMonthKey, "done", new Date().toISOString()]] },
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

export async function handleEomGetPlCompData(req, res, sheets) {
  const { clientName, automationCommanderSheetId } = req.body;
  if (!clientName || !automationCommanderSheetId) {
    return res.status(400).json({ success: false, error: "Missing clientName or automationCommanderSheetId" });
  }

  try {
    const clientResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!A2:N500"
    }));
    const rows = clientResp.data.values || [];
    const clientRow = rows.find(r => String(r[0] || "").trim() === clientName);
    if (!clientRow) {
      return res.status(404).json({ success: false, error: `Client "${clientName}" not found in AutoUpdates` });
    }
    const masterSheetUrl = clientRow[12];
    const masterSheetId = extractSheetIdFromUrl(masterSheetUrl);
    if (!masterSheetId) {
      return res.status(400).json({ success: false, error: `No Master Sheet ID found for client "${clientName}"` });
    }

    const [c1Resp, dataResp, f87Resp, t87Resp] = await Promise.all([
      withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: "PLComp!C1",
        valueRenderOption: "FORMATTED_VALUE"
      })),
      withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: "PLComp!D1:Y595",
        valueRenderOption: "FORMATTED_VALUE"
      })),
      withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: "PLComp!F87:K87",
        valueRenderOption: "FORMATTED_VALUE"
      })),
      withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: "PLComp!T87:Y87",
        valueRenderOption: "FORMATTED_VALUE"
      }))
    ]);

    const lastUpdated = c1Resp.data.values?.[0]?.[0] || "";
    const allData = dataResp.data.values || [];

    const row1 = allData[0] || [];
    // Relative to Col D (index 0):
    // Cols F..K (not including unreconciled): indices 2, 3, 4, 5, 6, 7
    // Cols T..Y (including unreconciled): indices 16, 17, 18, 19, 20, 21
    const monthColsStandard = ["F", "G", "H", "I", "J", "K"];
    const monthIndicesStandard = [2, 3, 4, 5, 6, 7];

    const monthColsWithAdds = ["T", "U", "V", "W", "X", "Y"];
    const monthIndicesWithAdds = [16, 17, 18, 19, 20, 21];

    const f87Values = f87Resp.data.values?.[0] || [];
    const t87Values = t87Resp.data.values?.[0] || [];

    const monthsStandard = monthColsStandard.map((colLetter, idx) => ({
      colIndex: idx,
      colLetter,
      header: row1[monthIndicesStandard[idx]] || `Month ${idx + 1}`,
      checked: String(f87Values[idx] || "").toUpperCase() === "TRUE"
    }));

    const monthsWithAdds = monthColsWithAdds.map((colLetter, idx) => ({
      colIndex: idx,
      colLetter,
      header: row1[monthIndicesWithAdds[idx]] || `Month ${idx + 1}`,
      checked: String(t87Values[idx] || "").toUpperCase() === "TRUE"
    }));

    let cosStart = -1, cosEnd = -1;
    let overheadStart = -1;
    let nonOpIncStart = -1, nonOpIncEnd = -1;
    let nonOpExpStart = -1, nonOpExpEnd = -1;

    for (let r = 0; r < allData.length; r++) {
      const row = allData[r] || [];
      const colD = String(row[0] || "").trim().toLowerCase();
      const colE = String(row[1] || "").trim().toLowerCase();

      if (colD === "costs of sale" && cosStart === -1) {
        cosStart = r;
      }
      if (cosStart !== -1 && cosEnd === -1 && colE === "costs of sale total") {
        cosEnd = r;
      }

      if (colD === "non-operating income" && nonOpIncStart === -1) {
        nonOpIncStart = r;
      }
      if (nonOpIncStart !== -1 && nonOpIncEnd === -1 && colE === "non-operating income total") {
        nonOpIncEnd = r;
      }

      if (colD === "non-operating expenses" && nonOpExpStart === -1) {
        nonOpExpStart = r;
      }
      if (nonOpExpStart !== -1 && nonOpExpEnd === -1 && colE === "non-operating expenses total") {
        nonOpExpEnd = r;
      }

      if (colE === "overheads" && overheadStart === -1) {
        overheadStart = r;
      }
    }

    const extractRows = (startIdx, endIdx, colIndices) => {
      if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return [];
      const result = [];
      for (let i = startIdx; i < endIdx && i < allData.length; i++) {
        const row = allData[i] || [];
        const label = String(row[1] || "").trim();
        if (!label) continue;
        const values = colIndices.map(ci => row[ci] || "0.00");
        result.push({ label, values, rowNumber: i + 1 });
      }
      return result;
    };

    const buildSections = (colIndices) => {
      const sections = [];
      // 1. Costs of sale
      if (cosStart !== -1 && cosEnd !== -1) {
        const rows = extractRows(cosStart, cosEnd, colIndices);
        if (rows.length > 0) {
          sections.push({ title: "Costs of sale", rows });
        }
      }

      // 2. Overhead expenses (actual expense accounts start after Overheads label down to row 595)
      if (overheadStart !== -1) {
        const rows = extractRows(overheadStart + 1, Math.min(allData.length, 595), colIndices);
        if (rows.length > 0) {
          sections.push({ title: "Overhead expenses", rows });
        }
      }

      // 3. Non-operating income
      if (nonOpIncStart !== -1 && nonOpIncEnd !== -1) {
        const rows = extractRows(nonOpIncStart, nonOpIncEnd, colIndices);
        if (rows.length > 0) {
          sections.push({ title: "Non-operating income", rows });
        }
      }

      // 4. Non-operating expenses
      if (nonOpExpStart !== -1 && nonOpExpEnd !== -1) {
        const rows = extractRows(nonOpExpStart, nonOpExpEnd, colIndices);
        if (rows.length > 0) {
          sections.push({ title: "Non-operating expenses", rows });
        }
      }
      return sections;
    };

    const sectionsStandard = buildSections(monthIndicesStandard);
    const sectionsWithAdds = buildSections(monthIndicesWithAdds);

    return res.status(200).json({
      success: true,
      lastUpdated,
      includingUnreconciled: {
        months: monthsWithAdds,
        sections: sectionsWithAdds
      },
      notIncludingUnreconciled: {
        months: monthsStandard,
        sections: sectionsStandard
      },
      // Default top-level fields (including unreconciled items):
      months: monthsWithAdds,
      sections: sectionsWithAdds
    });
  } catch (err) {
    console.error("❌ eom_get_plcomp_data error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomPullFreshPl(req, res, sheets) {
  const { clientName, automationCommanderSheetId } = req.body;
  if (!clientName || !automationCommanderSheetId) {
    return res.status(400).json({ success: false, error: "Missing clientName or automationCommanderSheetId" });
  }

  try {
    const clientResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!A2:N500"
    }));
    const rows = clientResp.data.values || [];
    const clientRow = rows.find(r => String(r[0] || "").trim() === clientName);
    if (!clientRow) {
      return res.status(404).json({ success: false, error: `Client "${clientName}" not found in AutoUpdates` });
    }
    const webAppUrl = String(clientRow[13] || "").trim();
    if (!webAppUrl) {
      return res.status(400).json({ success: false, error: `No Master Web App URL configured for "${clientName}" (AutoUpdates column N)` });
    }

    const secret = process.env.AGENT_TRIGGER_SECRET || process.env.CRON_SECRET || "";
    const gasResp = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, action: "pull_pl", clientName }),
    });

    const gasText = await gasResp.text();
    let gasData = null;
    try { gasData = JSON.parse(gasText); } catch (e) {}
    if (!gasData) {
      console.error(`❌ Master Web App pull_pl failed (HTTP ${gasResp.status}):`, gasText.slice(0, 300));
      return res.status(502).json({
        success: false,
        error: `Client Master Web App returned HTTP ${gasResp.status} (${gasText.slice(0, 120).replace(/<[^>]*>/g, '').trim() || 'non-JSON'}). Please verify deployment permissions.`
      });
    }
    if (!gasData.success) {
      return res.status(200).json({ success: false, error: gasData.error || "P&L pull failed" });
    }

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName,
      category: "EOM",
      action: "Pulled Fresh P&L",
      summary: `Pulled fresh P&L data for ${clientName}`,
      details: { clientName }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, message: gasData.message || "Fresh P&L pulled successfully" });
  } catch (err) {
    console.error("❌ eom_pull_fresh_pl error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomPushOutgoings(req, res, sheets) {
  const { clientName, selectedMonths, automationCommanderSheetId, workMonthKey, includeUnreconciled } = req.body;
  if (!clientName || !automationCommanderSheetId || !Array.isArray(selectedMonths)) {
    return res.status(400).json({ success: false, error: "Missing clientName, automationCommanderSheetId, or selectedMonths" });
  }

  const isInclUnrec = includeUnreconciled !== false; // Default: true (Include unreconciled items)

  try {
    const clientResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!A2:N500"
    }));
    const rows = clientResp.data.values || [];
    const clientRow = rows.find(r => String(r[0] || "").trim() === clientName);
    if (!clientRow) {
      return res.status(404).json({ success: false, error: `Client "${clientName}" not found in AutoUpdates` });
    }
    const masterSheetUrl = clientRow[12];
    const masterSheetId = extractSheetIdFromUrl(masterSheetUrl);
    const webAppUrl = String(clientRow[13] || "").trim();
    if (!masterSheetId || !webAppUrl) {
      return res.status(400).json({ success: false, error: `Missing master sheet ID or Web App URL for "${clientName}"` });
    }

    // 1. Write checkboxes to appropriate range in PLComp
    // If includeUnreconciled: Columns T..Y (range PLComp!T87:Y87)
    // If not includeUnreconciled: Columns F..K (range PLComp!F87:K87)
    const targetCols = isInclUnrec
      ? ["T", "U", "V", "W", "X", "Y"]
      : ["F", "G", "H", "I", "J", "K"];
    const checkboxRange = isInclUnrec ? "PLComp!T87:Y87" : "PLComp!F87:K87";
    const checkboxRow = targetCols.map(col => selectedMonths.includes(col));

    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: masterSheetId,
      range: checkboxRange,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [checkboxRow] }
    }));

    // 2. Call Master Web App to run pushOutgoingsWithPLAddsToClientSheet (if including unreconciled)
    // or pushOutgoingsToClientSheet (if not including unreconciled)
    const secret = process.env.AGENT_TRIGGER_SECRET || process.env.CRON_SECRET || "";
    const action = isInclUnrec ? "push_outgoings_with_pl_adds" : "push_outgoings";
    const functionName = isInclUnrec ? "pushOutgoingsWithPLAddsToClientSheet" : "pushOutgoingsToClientSheet";

    const gasResp = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        action,
        functionName,
        includeUnreconciled: isInclUnrec,
        clientName
      }),
    });

    const gasText = await gasResp.text();
    let gasData = null;
    try { gasData = JSON.parse(gasText); } catch (e) {}
    if (!gasData) {
      console.error(`❌ Master Web App ${action} failed (HTTP ${gasResp.status}):`, gasText.slice(0, 300));
      return res.status(502).json({
        success: false,
        error: `Client Master Web App returned HTTP ${gasResp.status} (${gasText.slice(0, 120).replace(/<[^>]*>/g, '').trim() || 'non-JSON'}). Please verify deployment permissions.`
      });
    }
    if (!gasData.success) {
      return res.status(200).json({ success: false, error: gasData.error || "Push outgoings failed" });
    }

    // 3. Check if the relevant EoM month was pushed
    let markedTaskDone = false;
    let relevantColLetter = null;
    let targetMonthLabel = "";
    if (workMonthKey) {
      const targetMonthKey = eomWorkMonthToTargetMonth_(workMonthKey);
      targetMonthLabel = eomKeyToMonthStr_(targetMonthKey) || "";
      
      const checkRange = isInclUnrec ? "PLComp!T1:Y1" : "PLComp!F1:K1";
      const headersResp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: checkRange,
        valueRenderOption: "FORMATTED_VALUE"
      }));
      const headers = headersResp.data.values?.[0] || [];

      for (let i = 0; i < headers.length; i++) {
        if (headers[i] && isDateMatchJs_(headers[i], targetMonthLabel)) {
          relevantColLetter = targetCols[i];
          break;
        }
      }

      if (relevantColLetter && selectedMonths.includes(relevantColLetter)) {
        markedTaskDone = await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, clientName, "push_outgoings", workMonthKey);
        if (!markedTaskDone) {
          markedTaskDone = await autoCompletePlcompTaskByName_(sheets, automationCommanderSheetId, clientName, workMonthKey);
        }
      }
    }

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName,
      category: "EOM",
      action: isInclUnrec ? "Pushed Outgoings (incl. unreconciled)" : "Pushed Outgoings",
      summary: `Pushed outgoings for ${clientName} (${selectedMonths.join(", ")})${isInclUnrec ? " [including unreconciled items]" : " [not including unreconciled items]"}${markedTaskDone ? " - EoM task marked Done" : ""}`,
      details: { clientName, selectedMonths, includeUnreconciled: isInclUnrec, markedTaskDone }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({
      success: true,
      message: gasData.message || (isInclUnrec ? "Outgoings (including unreconciled items) pushed successfully." : "Outgoings pushed successfully."),
      warnings: gasData.warnings || [],
      markedTaskDone,
      targetMonthLabel
    });
  } catch (err) {
    console.error("❌ eom_push_outgoings error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ============================================================================
// DEFAULT EOM TASKS (Starting point for new clients during setup)
// ============================================================================

export async function ensureEomDefaultTasksTab_(sheets, spreadsheetId) {
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties.title"
    });
    const exists = meta.data.sheets?.some(s => s.properties?.title === "EomDefaultTasks");
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: "EomDefaultTasks",
                  gridProperties: { rowCount: 200, columnCount: 10, frozenRowCount: 1 }
                }
              }
            }
          ]
        }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "EomDefaultTasks!A1:I1",
        valueInputOption: "RAW",
        requestBody: {
          values: [["DefaultTaskId", "TemplateId", "TaskName", "DefaultNotes", "Active", "CreatedAt", "SortOrder", "LinkedFunction", "AlertCategories"]]
        }
      });
    }
  } catch (err) {
    console.warn("[ensureEomDefaultTasksTab_] Note:", err.message);
  }
}

export async function handleEomGetDefaultTasks(req, res, sheets) {
  const { automationCommanderSheetId } = req.body;
  if (!automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureEomDefaultTasksTab_(sheets, automationCommanderSheetId);
    const [tasksResp, templatesResp] = await Promise.all([
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomDefaultTasks!A2:I1000" })),
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:H1000" })),
    ]);

    const templateById = {};
    (templatesResp.data.values || []).forEach(r => {
      if (r[0]) {
        templateById[r[0]] = {
          templateId: r[0],
          name: r[1] || "",
          defaultNotes: r[2] || "",
          linkedFunction: r[3] || "",
          active: r[4] !== "FALSE" && r[4] !== false,
          alertCategories: r[6] || "",
        };
      }
    });

    const rows = (tasksResp.data.values || []).filter(r => r[0]);
    const defaultTasks = rows.map((r, i) => {
      const template = r[1] ? templateById[r[1]] : null;
      return {
        defaultTaskId: r[0],
        templateId: r[1] || "",
        taskName: r[2] || (template ? template.name : ""),
        name: r[1] ? (template ? template.name : "(template deleted)") : (r[2] || ""),
        defaultNotes: r[3] !== undefined && r[3] !== "" ? r[3] : (template ? template.defaultNotes : ""),
        active: r[4] !== "FALSE" && r[4] !== false,
        createdAt: r[5] || "",
        sortOrder: r[6] !== undefined && r[6] !== "" ? Number(r[6]) : 1000000 + i,
        linkedFunction: r[7] || (template ? template.linkedFunction : ""),
        alertCategories: r[8] || (template ? template.alertCategories : ""),
      };
    }).sort((a, b) => a.sortOrder - b.sortOrder);

    return res.status(200).json({ success: true, defaultTasks });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomSaveDefaultTask(req, res, sheets) {
  const { automationCommanderSheetId, defaultTaskId, templateId, taskName, defaultNotes, active, sortOrder, linkedFunction, alertCategories } = req.body;
  if (!automationCommanderSheetId || (!templateId && !taskName)) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    await ensureEomDefaultTasksTab_(sheets, automationCommanderSheetId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomDefaultTasks!A2:I1000" }));
    const rows = resp.data.values || [];

    if (defaultTaskId) {
      const rowIdx = rows.findIndex(r => r[0] === defaultTaskId);
      if (rowIdx === -1) return res.status(404).json({ success: false, error: "Default task not found" });
      const sheetRow = rowIdx + 2;
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId,
        range: `EomDefaultTasks!B${sheetRow}:I${sheetRow}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            templateId || "",
            taskName || "",
            defaultNotes || "",
            active !== false,
            rows[rowIdx][5] || new Date().toISOString(),
            sortOrder !== undefined ? sortOrder : (rows[rowIdx][6] || sheetRow * 10),
            linkedFunction || "",
            alertCategories || ""
          ]]
        }
      }));
      return res.status(200).json({ success: true, defaultTaskId });
    }

    const newId = `deftask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const newSortOrder = sortOrder !== undefined ? sortOrder : (rows.length + 1) * 10;
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: "EomDefaultTasks!A:I",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          newId,
          templateId || "",
          taskName || "",
          defaultNotes || "",
          active !== false,
          new Date().toISOString(),
          newSortOrder,
          linkedFunction || "",
          alertCategories || ""
        ]]
      }
    }));
    return res.status(200).json({ success: true, defaultTaskId: newId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomDeleteDefaultTask(req, res, sheets) {
  const { automationCommanderSheetId, defaultTaskId } = req.body;
  if (!automationCommanderSheetId || !defaultTaskId) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    await ensureEomDefaultTasksTab_(sheets, automationCommanderSheetId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomDefaultTasks!A2:I1000" }));
    const rows = resp.data.values || [];
    const rowIdx = rows.findIndex(r => r[0] === defaultTaskId);
    if (rowIdx === -1) return res.status(404).json({ success: false, error: "Default task not found" });

    const sheetRow = rowIdx + 2;
    await withRetry(() => sheets.spreadsheets.values.clear({
      spreadsheetId: automationCommanderSheetId,
      range: `EomDefaultTasks!A${sheetRow}:I${sheetRow}`
    }));

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomReorderDefaultTasks(req, res, sheets) {
  const { automationCommanderSheetId, orderedDefaultTaskIds } = req.body;
  if (!automationCommanderSheetId || !Array.isArray(orderedDefaultTaskIds) || orderedDefaultTaskIds.length === 0) {
    return res.status(400).json({ success: false, error: "Missing orderedDefaultTaskIds" });
  }
  try {
    await ensureEomDefaultTasksTab_(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomDefaultTasks!A2:I1000" });
    const rows = resp.data.values || [];
    const rowIndexById = {};
    rows.forEach((r, idx) => { if (r[0]) rowIndexById[r[0]] = idx; });

    const writes = [];
    orderedDefaultTaskIds.forEach((id, index) => {
      if (id in rowIndexById) {
        const sheetRow = rowIndexById[id] + 2;
        writes.push({
          range: `EomDefaultTasks!G${sheetRow}`,
          values: [[(index + 1) * 10]]
        });
      }
    });

    if (writes.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: automationCommanderSheetId,
        requestBody: { valueInputOption: "RAW", data: writes }
      });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleEomSeedDefaultTasksFromTemplates(req, res, sheets) {
  const { automationCommanderSheetId } = req.body;
  if (!automationCommanderSheetId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureEomDefaultTasksTab_(sheets, automationCommanderSheetId);
    const [templatesResp, existingResp] = await Promise.all([
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:H1000" })),
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomDefaultTasks!A2:I1000" })),
    ]);

    const existingRows = existingResp.data.values || [];
    const existingTemplateIds = new Set(existingRows.filter(r => r[0] && r[1]).map(r => r[1]));

    const templates = (templatesResp.data.values || [])
      .filter(r => r[0] && (r[4] !== "FALSE" && r[4] !== false))
      .sort((a, b) => (Number(a[7]) || 0) - (Number(b[7]) || 0));

    const newRows = [];
    let sortCounter = (existingRows.length + 1) * 10;
    for (const t of templates) {
      if (!existingTemplateIds.has(t[0])) {
        const id = `deftask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        newRows.push([
          id,
          t[0], // templateId
          t[1] || "", // taskName
          t[2] || "", // defaultNotes
          true,
          new Date().toISOString(),
          sortCounter,
          t[3] || "", // linkedFunction
          t[6] || ""  // alertCategories
        ]);
        sortCounter += 10;
      }
    }

    if (newRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId,
        range: "EomDefaultTasks!A:I",
        valueInputOption: "RAW",
        requestBody: { values: newRows }
      });
    }

    return res.status(200).json({ success: true, seededCount: newRows.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function applyDefaultEomTasksToClient_(sheets, automationCommanderSheetId, clientName) {
  if (!automationCommanderSheetId || !clientName) return { success: false, appliedCount: 0 };
  try {
    await ensureEomDefaultTasksTab_(sheets, automationCommanderSheetId);
    const [defaultsResp, clientTasksResp] = await Promise.all([
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomDefaultTasks!A2:I1000" })),
      withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" })),
    ]);

    const activeDefaults = (defaultsResp.data.values || [])
      .filter(r => r[0] && (r[4] !== "FALSE" && r[4] !== false))
      .sort((a, b) => (Number(a[6]) || 0) - (Number(b[6]) || 0));

    if (activeDefaults.length === 0) return { success: true, appliedCount: 0, reason: "No active default tasks configured." };

    const clientExisting = (clientTasksResp.data.values || []).filter(r => r[0] && r[1] === clientName);
    const existingTemplateIds = new Set(clientExisting.filter(r => r[2]).map(r => r[2]));
    const existingCustomNames = new Set(clientExisting.filter(r => !r[2] && r[3]).map(r => r[3].trim().toLowerCase()));

    const rowsToAppend = [];
    let startSort = (clientExisting.length + 1) * 10;
    for (const dt of activeDefaults) {
      const templateId = dt[1] || "";
      const taskName = dt[2] || "";
      const defaultNotes = dt[3] || "";
      const sortOrder = dt[6] !== undefined && dt[6] !== "" ? Number(dt[6]) : startSort;

      // Skip if already assigned to this client
      if (templateId && existingTemplateIds.has(templateId)) continue;
      if (!templateId && taskName && existingCustomNames.has(taskName.trim().toLowerCase())) continue;

      const newTaskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      rowsToAppend.push([
        newTaskId,
        clientName,
        templateId,
        taskName,
        defaultNotes,
        true,
        new Date().toISOString(),
        sortOrder
      ]);
      startSort += 10;
    }

    if (rowsToAppend.length > 0) {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId,
        range: "EomClientTasks!A:H",
        valueInputOption: "RAW",
        requestBody: { values: rowsToAppend }
      }));
    }

    return { success: true, appliedCount: rowsToAppend.length };
  } catch (err) {
    console.error(`[applyDefaultEomTasksToClient_] Error for ${clientName}:`, err);
    return { success: false, error: err.message, appliedCount: 0 };
  }
}

export async function handleEomApplyDefaultTasks(req, res, sheets) {
  const { automationCommanderSheetId, clientName } = req.body;
  if (!automationCommanderSheetId || !clientName) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    const result = await applyDefaultEomTasksToClient_(sheets, automationCommanderSheetId, clientName);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ============================================================================
// EOM REPORTING CONTROL (Management Reports & Month-End Email Drafting)
// ============================================================================

export const REPORTING_CONTROL_SHEET_ID = "1uAJS6ZWn0o-GPU9Ea3DIVU9nzQoRnXrMfmBcQYHNJ_s";
export const CLIENT_VERSION_TRACKER_SHEET_ID = "1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co";

function parseHeaderToMonthKey_(headerStr) {
  if (!headerStr) return "";
  const s = String(headerStr).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const match = s.match(/^([a-zA-Z]+)[\s-]*(\d{2,4})$/);
  if (match) {
    const m = months[match[1].toLowerCase().slice(0, 3)];
    let y = match[2];
    if (y.length === 2) y = "20" + y;
    if (m && y) return `${y}-${m}`;
  }
  return s;
}

function resolveAcSheetId_(providedId) {
  if (providedId && String(providedId).trim() !== REPORTING_CONTROL_SHEET_ID) {
    return String(providedId).trim();
  }
  return process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_SHEET_ID;
}

export const DEFAULT_CHART_REFS = [
  { code: "[MonthSnapshot]", range: "C31:J47", label: "Month Snapshot" },
  { code: "[BusinessPerformance]", range: "U106:AA137", label: "Business Performance" },
  { code: "[QuarterOutcome]", range: "U202:AA224", label: "Quarter Outcome" },
  { code: "[QuarterSnapshot]", range: "C231:J243", label: "Quarter Snapshot" },
  { code: "[Overheads20]", range: "AB371:AG391", label: "Overheads 20" },
  { code: "[Overheads30]", range: "AB371:AG401", label: "Overheads 30" },
  { code: "[Overheads40]", range: "AB371:AG411", label: "Overheads 40" },
  { code: "[Overheads60]", range: "AB371:AG431", label: "Overheads 60" },
  { code: "[CurrMonth]", range: "U502:AA533", label: "Current Month" },
  { code: "[PerfYTD]", range: "A544:T574", label: "Performance YTD" },
  { code: "[FYForecast]", range: "A643:T674", label: "FY Forecast" },
  { code: "[NextFYForecast]", range: "AH643:AV674", label: "Next FY Forecast" },
  { code: "[Targets]", range: "A789:M797", label: "Targets" },
  { code: "[Cashflow]", range: "A831:H843", label: "Cashflow" },
  { code: "[Bookings3]", range: "A1016:C1016", label: "Bookings 3m" },
  { code: "[Bookings6]", range: "A983:B983", label: "Bookings 6m" },
  { code: "[Bookings12]", range: "A954:C954", label: "Bookings 12m" },
  { code: "[Pipeline3]", range: "A1143:D1143", label: "Pipeline 3m" },
  { code: "[Pipeline6]", range: "A1112:D1112", label: "Pipeline 6m" },
  { code: "[Pipeline12]", range: "A1081:D1081", label: "Pipeline 12m" },
  { code: "[Util10]", range: "A1223:J1234", label: "Utilisation 10" },
  { code: "[Util15]", range: "A1223:J1239", label: "Utilisation 15" },
  { code: "[Util20]", range: "A1223:J1244", label: "Utilisation 20" }
];

/**
 * Ensures EomReportingConfig and ChartRefs tabs exist in Reporting Control spreadsheet
 */
export async function ensureEomReportingTabs_(sheets, spreadsheetId = REPORTING_CONTROL_SHEET_ID) {
  const targetId = REPORTING_CONTROL_SHEET_ID;
  try {
    const meta = await withRetry(() => sheets.spreadsheets.get({
      spreadsheetId: targetId,
      fields: "sheets.properties.title"
    }));
    const existingTitles = new Set(meta.data.sheets?.map(s => s.properties?.title) || []);
    const requests = [];

    if (!existingTitles.has("EomReportingConfig")) {
      requests.push({
        addSheet: {
          properties: {
            title: "EomReportingConfig",
            gridProperties: { rowCount: 100, columnCount: 10, frozenRowCount: 1 }
          }
        }
      });
    }

    if (requests.length > 0) {
      await withRetry(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId: targetId,
        requestBody: { requests }
      }));
    }

    if (!existingTitles.has("EomReportingConfig")) {
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: targetId,
        range: "EomReportingConfig!A1:G1",
        valueInputOption: "RAW",
        requestBody: {
          values: [["ClientName", "EmailTo", "EmailSubj", "EmailBody", "FolderUrl", "WebAppUrl", "UpdatedAt"]]
        }
      }));
    }
  } catch (err) {
    console.warn("[ensureEomReportingTabs_] Note:", err.message);
  }
}

/**
 * Loads all reporting control clients, configuration, chart references, and latest presentations
 * All stored directly in Reporting Control spreadsheet (REPORTING_CONTROL_SHEET_ID)
 */
export async function handleEomGetReportingData(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }

  const { eomMonthKey, reportMonthKey } = req.body;
  const rcId = REPORTING_CONTROL_SHEET_ID;
  const targetReportMonth = reportMonthKey || eomMonthKey;

  try {
    await ensureEomReportingTabs_(sheets, rcId);

    // 1. Fetch clients from getAllClients
    const clientsData = await getAllClients(sheets, { isAdmin: true }, false);
    const clientsArray = clientsData.clientsArray || [];

    // 2. Fetch folder URLs from Client Version Tracker (Col 53: Mgmt Reports folder)
    const trackerFolders = {};
    try {
      const trackerResp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: CLIENT_VERSION_TRACKER_SHEET_ID,
        range: "Clients!A2:BA100",
        valueRenderOption: "FORMATTED_VALUE"
      }));
      (trackerResp.data.values || []).forEach(row => {
        const cName = String(row[0] || "").trim();
        const folder = String(row[52] || "").trim(); // Col 53 is 0-index 52
        if (cName && folder) trackerFolders[cName] = folder;
      });
    } catch (tErr) {
      console.warn("Tracker folders fetch note:", tErr.message);
    }

    // 3. Fetch EomReportingConfig from Reporting Control spreadsheet
    const configResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: rcId,
      range: "EomReportingConfig!A2:G500",
      valueRenderOption: "FORMATTED_VALUE"
    }));
    const configMap = {};
    let systemWebAppUrl = process.env.REPORTING_WEBAPP_URL || "";
    (configResp.data.values || []).forEach(r => {
      const cName = String(r[0] || "").trim();
      if (!cName) return;
      if (cName === "__SYSTEM__") {
        if (r[5]) systemWebAppUrl = String(r[5]).trim();
        return;
      }
      configMap[cName] = {
        emailTo: r[1] || "",
        emailSubj: r[2] || "",
        emailBody: r[3] || "",
        folderUrl: r[4] || "",
        webAppUrl: r[5] || ""
      };
    });

    // 4. Fetch ChartRefs from Reporting Control spreadsheet
    const chartRefsResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: rcId,
      range: "ChartRefs!A1:C100",
      valueRenderOption: "FORMATTED_VALUE"
    }));
    const chartRefs = [];
    (chartRefsResp.data.values || []).forEach(r => {
      const code = String(r[0] || "").trim();
      const range = String(r[1] || "").trim();
      const label = String(r[2] || "").trim();
      if (!code || code === "Chart code" || code === "Speaker notes code") return;
      chartRefs.push({ code, range, label: label || code.replace(/^\[|\]$/g, "") });
    });

    // 5. Fetch ReportsLog matrix from Reporting Control spreadsheet
    const logResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: rcId,
      range: "ReportsLog!A1:Z100",
      valueRenderOption: "FORMATTED_VALUE"
    }));
    const logRows = logResp.data.values || [];
    const headerRow = logRows[0] || [];
    const colMonthKeys = headerRow.map((h, i) => i === 0 ? "" : parseHeaderToMonthKey_(h));

    const logsByClient = {};
    for (let r = 1; r < logRows.length; r++) {
      const row = logRows[r];
      const cName = String(row[0] || "").trim();
      if (!cName) continue;
      logsByClient[cName] = [];
      for (let c = 1; c < row.length; c++) {
        const url = String(row[c] || "").trim();
        const mKey = colMonthKeys[c];
        if (url && mKey) {
          logsByClient[cName].push({
            month: mKey,
            reportUrl: url,
            reportName: `${cName} Management Report (${headerRow[c] || mKey})`,
            createdAt: ""
          });
        }
      }
    }

    // 6. Match clients and construct payload
    const clients = clientsArray.map(c => {
      const name = c.clientName;
      const conf = configMap[name] || {};
      const folderUrl = conf.folderUrl || trackerFolders[name] || "";
      const history = logsByClient[name] || logsByClient[c.clientName] || [];
      const monthReport = history.find(h => h.month === targetReportMonth) || null;
      const latestReport = monthReport || history[0] || null;

      return {
        clientName: name,
        clientSheetId: c.clientSheetId,
        masterSheetId: c.masterSheetId,
        masterSheetUrl: c.masterSheetId ? `https://docs.google.com/spreadsheets/d/${c.masterSheetId}/edit` : "",
        clientSheetUrl: c.clientSheetId ? `https://docs.google.com/spreadsheets/d/${c.clientSheetId}/edit` : "",
        folderUrl: folderUrl,
        hasDeckConfigured: !!folderUrl,
        emailTo: conf.emailTo || "",
        emailSubj: conf.emailSubj || "End of month queries",
        emailBody: conf.emailBody || "",
        webAppUrl: conf.webAppUrl || systemWebAppUrl || c.webAppUrl || "",
        latestReport: latestReport,
        reportHistory: history
      };
    });

    return res.status(200).json({
      success: true,
      clients,
      systemWebAppUrl,
      chartRefs: chartRefs.length > 0 ? chartRefs : DEFAULT_CHART_REFS
    });
  } catch (err) {
    console.error("❌ handleEomGetReportingData error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Saves reporting email template, folder, or system web app URL to Reporting Control spreadsheet
 */
export async function handleEomSaveReportingConfig(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }

  const { clientName, emailTo, emailSubj, emailBody, folderUrl, webAppUrl } = req.body;
  const rcId = REPORTING_CONTROL_SHEET_ID;

  if (!clientName) {
    return res.status(400).json({ success: false, error: "Missing clientName" });
  }

  try {
    await ensureEomReportingTabs_(sheets, rcId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: rcId,
      range: "EomReportingConfig!A2:G500"
    }));
    const rows = resp.data.values || [];
    const existingIdx = rows.findIndex(r => String(r[0] || "").trim() === clientName);
    const now = new Date().toISOString();

    const rowData = [
      clientName,
      emailTo !== undefined ? emailTo : (rows[existingIdx]?.[1] || ""),
      emailSubj !== undefined ? emailSubj : (rows[existingIdx]?.[2] || ""),
      emailBody !== undefined ? emailBody : (rows[existingIdx]?.[3] || ""),
      folderUrl !== undefined ? folderUrl : (rows[existingIdx]?.[4] || ""),
      webAppUrl !== undefined ? webAppUrl : (rows[existingIdx]?.[5] || ""),
      now
    ];

    if (existingIdx === -1) {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: rcId,
        range: "EomReportingConfig!A:G",
        valueInputOption: "RAW",
        requestBody: { values: [rowData] }
      }));
    } else {
      const sheetRow = existingIdx + 2;
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: rcId,
        range: `EomReportingConfig!A${sheetRow}:G${sheetRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [rowData] }
      }));
    }

    return res.status(200).json({ success: true, clientName });
  } catch (err) {
    console.error("❌ handleEomSaveReportingConfig error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Saves (creates or updates) a chart and table reference in ChartRefs tab on Reporting Control sheet
 */
export async function handleEomSaveChartRef(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }

  const { code, range, label, originalCode } = req.body;
  if (!code || !range) {
    return res.status(400).json({ success: false, error: "Both code and range are required." });
  }

  const rawCode = String(code).trim();
  const cleanCode = rawCode.startsWith("[") && rawCode.endsWith("]") ? rawCode : `[${rawCode.replace(/^\[+|\]+$/g, "")}]`;
  const cleanRange = String(range).trim();
  const cleanLabel = String(label || "").trim();
  const rcId = REPORTING_CONTROL_SHEET_ID;

  try {
    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: rcId,
      range: "ChartRefs!A1:C100"
    }));
    const rows = resp.data.values || [];
    const lookupCode = originalCode || cleanCode;
    const existingIdx = rows.findIndex((r, i) => i > 0 && String(r[0] || "").trim() === lookupCode);

    if (existingIdx !== -1) {
      const sheetRow = existingIdx + 1;
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: rcId,
        range: `ChartRefs!A${sheetRow}:C${sheetRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [[cleanCode, cleanRange, cleanLabel]] }
      }));
    } else {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: rcId,
        range: "ChartRefs!A:C",
        valueInputOption: "RAW",
        requestBody: { values: [[cleanCode, cleanRange, cleanLabel]] }
      }));
    }

    return res.status(200).json({
      success: true,
      message: `Reference ${cleanCode} saved successfully.`,
      chartRef: { code: cleanCode, range: cleanRange, label: cleanLabel }
    });
  } catch (err) {
    console.error("❌ handleEomSaveChartRef error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Deletes a chart and table reference from ChartRefs tab on Reporting Control sheet
 */
export async function handleEomDeleteChartRef(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }

  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ success: false, error: "Missing code to delete." });
  }

  const rcId = REPORTING_CONTROL_SHEET_ID;

  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: rcId,
      fields: "sheets.properties"
    });
    const sheetObj = meta.data.sheets.find(s => s.properties.title === "ChartRefs");
    if (!sheetObj) {
      return res.status(404).json({ success: false, error: "ChartRefs sheet not found." });
    }
    const sheetId = sheetObj.properties.sheetId;

    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: rcId,
      range: "ChartRefs!A1:C100"
    }));
    const rows = resp.data.values || [];
    const targetIdx = rows.findIndex((r, i) => i > 0 && String(r[0] || "").trim() === code);

    if (targetIdx === -1) {
      return res.status(404).json({ success: false, error: `Reference ${code} not found.` });
    }

    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: rcId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: sheetId,
                dimension: "ROWS",
                startIndex: targetIdx,
                endIndex: targetIdx + 1
              }
            }
          }
        ]
      }
    }));

    return res.status(200).json({ success: true, message: `Reference ${code} deleted successfully.` });
  } catch (err) {
    console.error("❌ handleEomDeleteChartRef error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export function isValidGoogleScriptUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(url.trim());
}

/**
 * Proxies a PING test to the GAS Reporting Web App from the backend to prevent browser CORS blocks
 */
export async function handleEomTestReportingWebApp(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }

  const { webAppUrl } = req.body || {};
  const cleanUrl = String(webAppUrl || "").trim();
  if (!cleanUrl) {
    return res.status(400).json({ success: false, error: "Missing Web App URL to test." });
  }

  if (!isValidGoogleScriptUrl(cleanUrl)) {
    return res.status(400).json({
      success: false,
      error: "Invalid Web App URL: Target URL must strictly be a Google Apps Script Web App ending with /exec."
    });
  }

  try {
    const secret = (process.env.REPORTING_WEBAPP_SECRET || process.env.AGENT_TRIGGER_SECRET || "").trim();
    if (!secret) {
      return res.status(500).json({
        success: false,
        error: "Reporting Web App secret is not configured on the server."
      });
    }
    const gasResp = await fetch(cleanUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "PING", secret })
    });

    const gasText = await gasResp.text();
    let gasData = null;
    try { gasData = JSON.parse(gasText); } catch (e) {}

    if (!gasData) {
      return res.status(200).json({
        success: false,
        error: `Server returned HTTP ${gasResp.status} (${gasText.slice(0, 100).replace(/<[^>]*>/g, '').trim() || 'non-JSON response'}).`
      });
    }

    if (!gasData.success) {
      return res.status(200).json({
        success: false,
        error: gasData.error || "Web App returned failure."
      });
    }

    return res.status(200).json({
      success: true,
      message: gasData.message || "Connection successful!"
    });
  } catch (err) {
    return res.status(200).json({
      success: false,
      error: `Connection error: ${err.message}`
    });
  }
}

/**
 * Executes a reporting action (GENERATE, UPDATE, EMAIL) across target clients
 */
export async function handleEomRunReportingAction(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }

  const {
    mode, // "GENERATE" | "UPDATE" | "EMAIL"
    clients = [],
    eomMonthKey,
    reportMonthKey,
    webAppUrlOverride,
    automationCommanderSheetId
  } = req.body;

  const acId = resolveAcSheetId_(automationCommanderSheetId);

  if (!mode || !["GENERATE", "UPDATE", "EMAIL"].includes(mode)) {
    return res.status(400).json({ success: false, error: "Invalid action mode. Expected GENERATE, UPDATE, or EMAIL." });
  }

  if (!Array.isArray(clients) || clients.length === 0) {
    return res.status(400).json({ success: false, error: "No clients selected to process." });
  }

  const effectiveReportMonth = reportMonthKey || eomMonthKey;
  const effectiveWorkMonth = eomMonthKey || reportMonthKey;

  try {
    // 1. Resolve target date for reports (e.g. "2026-09" -> 2026-09-01)
    let rawTargetDate = null;
    if (effectiveReportMonth && /^\d{4}-\d{2}$/.test(effectiveReportMonth)) {
      const [y, m] = effectiveReportMonth.split("-").map(Number);
      rawTargetDate = new Date(Date.UTC(y, m - 1, 1));
    } else {
      const now = new Date();
      rawTargetDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
    }
    const targetDateFormatted = rawTargetDate.toISOString().slice(0, 10);

    // 2. Phase 1: Update Master Sheet MgmtRep!B1 date natively if GENERATE or UPDATE
    if (mode === "GENERATE" || mode === "UPDATE") {
      for (const c of clients) {
        if (c.masterSheetId) {
          try {
            await withRetry(() => sheets.spreadsheets.values.update({
              spreadsheetId: c.masterSheetId,
              range: "MgmtRep!B1",
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[targetDateFormatted]] }
            }));
          } catch (mErr) {
            console.warn(`Master MgmtRep date update note for ${c.clientName}:`, mErr.message);
          }
        }
      }
    }

    // 3. Resolve Web App URL
    const targetWebAppUrl = String(webAppUrlOverride || process.env.REPORTING_WEBAPP_URL || clients[0]?.webAppUrl || "").trim();
    if (!targetWebAppUrl) {
      return res.status(400).json({
        success: false,
        error: "Reporting Web App URL is not configured. Please enter the deployed Google Apps Script Web App URL in settings."
      });
    }

    if (!isValidGoogleScriptUrl(targetWebAppUrl)) {
      return res.status(400).json({
        success: false,
        error: "Invalid Web App URL: Target URL must strictly be a Google Apps Script Web App ending with /exec."
      });
    }

    const secret = (process.env.REPORTING_WEBAPP_SECRET || process.env.AGENT_TRIGGER_SECRET || "").trim();
    if (!secret) {
      return res.status(500).json({
        success: false,
        error: "Reporting Web App secret is not configured on the server."
      });
    }

    // 4. Fetch active chartMap from ChartRefs tab in Reporting Control sheet
    let chartMap = null;
    try {
      const crResp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: REPORTING_CONTROL_SHEET_ID,
        range: "ChartRefs!A1:B100",
        valueRenderOption: "FORMATTED_VALUE"
      }));
      const mapObj = {};
      (crResp.data.values || []).forEach(r => {
        const code = String(r[0] || "").trim();
        const rng = String(r[1] || "").trim();
        if (code && rng && code !== "Chart code" && code !== "Speaker notes code") {
          mapObj[code] = rng;
        }
      });
      if (Object.keys(mapObj).length > 0) chartMap = mapObj;
    } catch (crErr) {
      console.warn("Could not read ChartRefs for job payload:", crErr.message);
    }

    // 5. Dispatch to GAS Reporting Web App
    const gasPayload = {
      secret,
      action: mode,
      targetMonth: effectiveReportMonth,
      chartMap: chartMap || undefined,
      clients: clients.map(c => ({
        clientName: c.clientName,
        masterSheetUrl: c.masterSheetUrl || (c.masterSheetId ? `https://docs.google.com/spreadsheets/d/${c.masterSheetId}/edit` : ""),
        folderUrl: c.folderUrl || "",
        emailTo: c.emailTo || "",
        emailSubj: c.emailSubj || "End of month queries",
        emailBody: c.emailBody || ""
      }))
    };

    const gasResp = await fetch(targetWebAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gasPayload)
    });

    const gasText = await gasResp.text();
    let gasData = null;
    try { gasData = JSON.parse(gasText); } catch (e) {}

    if (!gasData) {
      console.error(`❌ Reporting Web App returned HTTP ${gasResp.status}:`, gasText.slice(0, 300));
      return res.status(502).json({
        success: false,
        error: `Reporting Web App returned HTTP ${gasResp.status} (${gasText.slice(0, 150).replace(/<[^>]*>/g, '').trim() || 'non-JSON'}). Please verify script deployment.`
      });
    }

    if (!gasData.success) {
      return res.status(200).json({ success: false, error: gasData.error || "Reporting action failed", results: gasData.results || [] });
    }

    // 5. Phase 3: Post-processing (ReportsLog & EoM task auto-completion)
    const clientResults = gasData.results || [];
    const logAppends = [];
    const nowIso = new Date().toISOString();

    for (const resItem of clientResults) {
      const cName = resItem.clientName;
      if (resItem.success) {
        if ((mode === "GENERATE" || mode === "UPDATE") && resItem.reportUrl) {
          logAppends.push([cName, effectiveReportMonth, resItem.reportUrl, resItem.reportName || "", nowIso]);

          // Auto-complete task "Create and send monthly management report" in EoM
          try {
            await autoCompleteTaskByKeyword_(sheets, acId, cName, effectiveWorkMonth, "monthly management report");
          } catch (tErr) {
            console.warn(`Task auto-completion note for ${cName}:`, tErr.message);
          }
        } else if (mode === "EMAIL") {
          // Auto-complete task "Send end of month data request email" in EoM
          try {
            await autoCompleteTaskByKeyword_(sheets, acId, cName, effectiveWorkMonth, "data request email");
          } catch (tErr) {
            console.warn(`Task auto-completion note for ${cName}:`, tErr.message);
          }
        }
      }
    }

    if (logAppends.length > 0) {
      try {
        await withRetry(() => sheets.spreadsheets.values.append({
          spreadsheetId: acId,
          range: "ReportsLog!A:E",
          valueInputOption: "RAW",
          requestBody: { values: logAppends }
        }));
      } catch (logErr) {
        console.warn("ReportsLog append error:", logErr.message);
      }
    }

    // Log PMA Activity
    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      category: "REPORTING",
      action: mode === "GENERATE" ? "Generated Management Reports" : (mode === "UPDATE" ? "Updated Management Decks" : "Drafted End of Month Emails"),
      summary: `${mode === "GENERATE" ? "Generated reports" : (mode === "UPDATE" ? "Updated decks" : "Drafted emails")} for ${clients.map(c => c.clientName).join(", ")} (Report: ${effectiveReportMonth}, Cycle: ${effectiveWorkMonth})`,
      details: { mode, reportMonthKey: effectiveReportMonth, eomMonthKey: effectiveWorkMonth, clients: clients.map(c => c.clientName), clientResults }
    }).catch(e => console.error("PMA log failed:", e));

    if (res.writableEnded || req.closed) return;
    return res.status(200).json({
      success: true,
      message: mode === "GENERATE"
        ? `Successfully generated ${clientResults.filter(r => r.success).length} report(s).`
        : (mode === "UPDATE"
          ? `Successfully updated ${clientResults.filter(r => r.success).length} deck(s).`
          : `Successfully drafted ${clientResults.filter(r => r.success).length} email(s) in Gmail.`),
      results: clientResults
    });

  } catch (err) {
    console.error("❌ handleEomRunReportingAction error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Auto-completes an EoM task matching a keyword in its task name
 */
export async function autoCompleteTaskByKeyword_(sheets, automationCommanderSheetId, clientName, workMonthKey, keyword) {
  try {
    if (!workMonthKey || !automationCommanderSheetId || !keyword) return false;
    const clientTasksR = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "EomClientTasks!A2:H5000"
    }));
    const clientTasks = clientTasksR.data.values || [];
    const matchedTask = clientTasks.find(r =>
      r[0] && r[1] === clientName && String(r[3] || "").toLowerCase().includes(keyword.toLowerCase()) && (r[5] !== "FALSE" && r[5] !== false)
    );
    if (!matchedTask) return false;

    const taskId = matchedTask[0];
    const statusResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "EomMonthlyStatus!A2:E200000"
    }));
    const statusRows = statusResp.data.values || [];
    const existingIdx = statusRows.findIndex(r => r[0] === clientName && r[1] === taskId && r[2] === workMonthKey);
    const now = new Date().toISOString();

    if (existingIdx === -1) {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId,
        range: "EomMonthlyStatus!A:E",
        valueInputOption: "RAW",
        requestBody: { values: [[clientName, taskId, workMonthKey, "done", now]] },
      }));
    } else {
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId,
        range: `EomMonthlyStatus!D${existingIdx + 2}:E${existingIdx + 2}`,
        valueInputOption: "RAW",
        requestBody: { values: [["done", now]] },
      }));
    }
    return true;
  } catch (e) {
    return false;
  }
}