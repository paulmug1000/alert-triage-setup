import { redisClient } from "./redisClient";
import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient";

export const SWEEP_SCHEDULE_TAB = "SweepSchedule";
export const SWEEP_SCHEDULE_DEFAULTS = {
  actionable: 30,
  info: 30,
  proactive: 1440,
};

export async function ensureClaudeUsageTab_(sheets, spreadsheetId) {
  return;
}

export async function ensureSweepScheduleTab(sheets, automationCommanderSheetId) {
  return;
}

export async function readSweepSchedule_(sheets, automationCommanderSheetId) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: automationCommanderSheetId,
    range: `${SWEEP_SCHEDULE_TAB}!A2:C10`,
  });
  const rows = resp.data.values || [];
  const schedule = {};
  rows.forEach((row, i) => {
    const category = String(row[0] || "").trim().toLowerCase();
    if (!category) return;
    schedule[category] = {
      rowIndex: i + 2,
      frequencyMinutes: parseInt(row[1], 10) || SWEEP_SCHEDULE_DEFAULTS[category] || 30,
      lastCheckedAt: row[2] || "",
    };
  });
  for (const category of Object.keys(SWEEP_SCHEDULE_DEFAULTS)) {
    if (!schedule[category]) {
      schedule[category] = { rowIndex: null, frequencyMinutes: SWEEP_SCHEDULE_DEFAULTS[category], lastCheckedAt: "" };
    }
  }
  return schedule;
}

export function isCategoryDue_(categoryEntry) {
  if (!categoryEntry.lastCheckedAt) return true;
  const last = new Date(categoryEntry.lastCheckedAt);
  if (isNaN(last.getTime())) return true;
  const elapsedMinutes = (Date.now() - last.getTime()) / 60000;
  return elapsedMinutes >= categoryEntry.frequencyMinutes;
}

export async function markCategoryChecked_(sheets, automationCommanderSheetId, category, schedule) {
  const nowISO = new Date().toISOString();
  const entry = schedule[category];
  if (entry && entry.rowIndex) {
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: automationCommanderSheetId,
      range: `${SWEEP_SCHEDULE_TAB}!C${entry.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[nowISO]] },
    }));
  } else {
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${SWEEP_SCHEDULE_TAB}!A:C`,
      valueInputOption: "RAW",
      requestBody: { values: [[category, (entry && entry.frequencyMinutes) || SWEEP_SCHEDULE_DEFAULTS[category] || 30, nowISO]] },
    }));
  }
}

export async function logClaudeUsage_(sheets, automationCommanderSheetId, clientName, alertType, inputTokens, outputTokens, source) {
  if (!automationCommanderSheetId) return;
  const acIdClean = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;
  await ensureClaudeUsageTab_(sheets, acIdClean);
  const costUsd = ((inputTokens || 0) / 1000000 * 3) + ((outputTokens || 0) / 1000000 * 15);
  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: acIdClean,
    range: "ClaudeUsage!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        new Date().toISOString(),
        source || "precompute",
        clientName || "",
        alertType || "",
        (inputTokens || 0) + (outputTokens || 0),
        costUsd.toFixed(6),
      ]],
    },
  }));
  console.log(`  📊 Logged Claude usage: ${clientName} ${alertType} — ${inputTokens}+${outputTokens} tokens, $${costUsd.toFixed(4)}`);
}

export async function handleGetClaudeSettings(req, res, sheets) {
  const { automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    const acIdClean = extractSheetIdFromUrl(acId) || acId;
    await ensureClaudeUsageTab_(sheets, acIdClean);
    const [cfgResp, usageResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: acIdClean, range: "ClaudeUsage!A1:B6" }),
      sheets.spreadsheets.values.get({ spreadsheetId: acIdClean, range: "ClaudeUsage!A8:F2000" }),
    ]);
    const cfg = cfgResp.data.values || [];
    const cfgMap = {};
    for (const row of cfg) { if (row[0] && row[1] !== undefined) cfgMap[String(row[0]).trim()] = String(row[1]).trim(); }

    const hourlyLimit = parseInt(cfgMap["hourly_limit"] || "10");
    const dailyLimit  = parseInt(cfgMap["daily_limit"]  || "30");
    const anomalyThreshold = parseInt(cfgMap["anomaly_threshold"] || "15");

    const usageRows = (usageResp.data.values || []).filter(r => r[0]);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const curHour = now.getUTCHours();

    let todayCalls = 0, todayCost = 0, hourCalls = 0, hourCost = 0, weeklyCalls = 0, weeklyCost = 0;
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const recentRows = [];

    for (const row of usageRows) {
      const ts = row[0] ? new Date(row[0]) : null;
      if (!ts || isNaN(ts)) continue;
      const cost = parseFloat(row[5] || "0") || 0;
      if (ts >= weekAgo) { weeklyCalls++; weeklyCost += cost; }
      if (ts.toISOString().slice(0, 10) === todayStr) {
        todayCalls++; todayCost += cost;
        if (ts.getUTCHours() === curHour) { hourCalls++; hourCost += cost; }
      }
      recentRows.push({ ts: row[0], action: row[1], client: row[2], alertType: row[3], tokens: row[4], cost: row[5] });
    }
    recentRows.sort((a, b) => new Date(b.ts) - new Date(a.ts));

    return res.status(200).json({
      success: true,
      config: { hourlyLimit, dailyLimit, anomalyThreshold },
      usage: {
        today: { calls: todayCalls, cost: todayCost.toFixed(4) },
        thisHour: { calls: hourCalls, cost: hourCost.toFixed(4) },
        week: { calls: weeklyCalls, cost: weeklyCost.toFixed(4) },
      },
      recentRows: recentRows.slice(0, 50),
    });
  } catch(err) {
    console.error("❌ get_claude_settings error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleSaveClaudeSettings(req, res, sheets) {
  const { automationCommanderSheetId: acId, hourlyLimit, dailyLimit, anomalyThreshold } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    const acIdClean = extractSheetIdFromUrl(acId) || acId;
    await ensureClaudeUsageTab_(sheets, acIdClean);
    await sheets.spreadsheets.values.update({
      spreadsheetId: acIdClean,
      range: "ClaudeUsage!B2:B4",
      valueInputOption: "RAW",
      requestBody: { values: [[parseInt(hourlyLimit) || 10], [parseInt(dailyLimit) || 30], [parseInt(anomalyThreshold) || 15]] },
    });
    return res.status(200).json({ success: true });
  } catch(err) {
    console.error("❌ save_claude_settings error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCheckClaudeBudget(req, res, sheets) {
  const { automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(200).json({ allowed: true });
  try {
    const acIdClean = extractSheetIdFromUrl(acId) || acId;
    await ensureClaudeUsageTab_(sheets, acIdClean);
    const [cfgResp, usageResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: acIdClean, range: "ClaudeUsage!B2:B4" }),
      sheets.spreadsheets.values.get({ spreadsheetId: acIdClean, range: "ClaudeUsage!A8:A2000" }),
    ]);
    const cfgVals = cfgResp.data.values || [];
    const hourlyLimit = parseInt(cfgVals[0]?.[0] || "10");
    const dailyLimit  = parseInt(cfgVals[1]?.[0] || "30");

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const curHour = now.getUTCHours();
    let hourCalls = 0, dayCalls = 0;

    for (const row of (usageResp.data.values || [])) {
      const ts = row[0] ? new Date(row[0]) : null;
      if (!ts || isNaN(ts)) continue;
      if (ts.toISOString().slice(0, 10) === todayStr) {
        dayCalls++;
        if (ts.getUTCHours() === curHour) hourCalls++;
      }
    }

    if (dayCalls >= dailyLimit)  return res.status(200).json({ allowed: false, reason: `Daily limit reached (${dayCalls}/${dailyLimit})` });
    if (hourCalls >= hourlyLimit) return res.status(200).json({ allowed: false, reason: `Hourly limit reached (${hourCalls}/${hourlyLimit})` });
    return res.status(200).json({ allowed: true, hourCalls, dayCalls, hourlyLimit, dailyLimit });
  } catch(err) {
    console.error("❌ check_claude_budget error:", err);
    return res.status(200).json({ allowed: true });
  }
}

export async function handleLogClaudeUsage(req, res, sheets) {
  const { automationCommanderSheetId, source, clientName, alertType, inputTokens, outputTokens } = req.body;
  try {
    await logClaudeUsage_(sheets, automationCommanderSheetId, clientName, alertType, inputTokens, outputTokens, source);
    return res.status(200).json({ success: true });
  } catch(err) {
    console.error("❌ log_claude_usage route error:", err);
    return res.status(200).json({ success: false }); 
  }
}

export async function handleGetAppLog(req, res, sheets) {
  const APP_LOG_SHEET_ID = "1v1N5ymNkcUCSPfzEGJxE43ylgGN95iyZmhKgnz62OQQ";
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: APP_LOG_SHEET_ID,
      range: "AppLogPull!A1:V1000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rawRows = resp.data.values || [];
    const rows = rawRows.filter(row =>
      row.some(cell => String(cell ?? "").trim() !== "")
    );
    console.log(`  ✅ App Log: ${rows.length} non-empty rows loaded`);
    return res.status(200).json({ success: true, rows });
  } catch (err) {
    console.error("❌ get_app_log error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleTriggerProactiveChecks(req, res) {
  try {
    const gasUrl = "https://script.google.com/macros/s/AKfycbzVvLSDtqWj3aHcn0UV9VPCybNm82sBNWynMo1-bMpvs3NzerPZXWkrpPJvVHaqDwwy/exec";
    const gasResp = await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run_proactive_checks" }),
    });
    const gasData = await gasResp.json().catch(() => ({}));
    if (!gasData.success) throw new Error(gasData.error || "Failed to trigger Apps Script");
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ trigger_proactive_checks error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetSweepSchedule(req, res, sheets) {
  const { automationCommanderSheetId: acIdGetSchedule } = req.body;
  if (!acIdGetSchedule) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureSweepScheduleTab(sheets, acIdGetSchedule);
    const schedule = await readSweepSchedule_(sheets, acIdGetSchedule);
    return res.status(200).json({ success: true, schedule });
  } catch (err) {
    console.error("❌ get_sweep_schedule error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleSaveSweepFrequency(req, res, sheets) {
  const { automationCommanderSheetId: acIdSaveFreq, category, frequencyMinutes } = req.body;
  if (!acIdSaveFreq) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  const normalisedCategory = String(category || "").trim().toLowerCase();
  if (!SWEEP_SCHEDULE_DEFAULTS[normalisedCategory]) {
    return res.status(400).json({ success: false, error: `Unknown category: ${category}` });
  }
  const freqNum = parseInt(frequencyMinutes, 10);
  if (!freqNum || freqNum < 1) {
    return res.status(400).json({ success: false, error: `Invalid frequencyMinutes: ${frequencyMinutes}` });
  }
  try {
    await ensureSweepScheduleTab(sheets, acIdSaveFreq);
    const schedule = await readSweepSchedule_(sheets, acIdSaveFreq);
    const entry = schedule[normalisedCategory];
    if (entry && entry.rowIndex) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: acIdSaveFreq,
        range: `${SWEEP_SCHEDULE_TAB}!B${entry.rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [[freqNum]] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: acIdSaveFreq,
        range: `${SWEEP_SCHEDULE_TAB}!A:C`,
        valueInputOption: "RAW",
        requestBody: { values: [[normalisedCategory, freqNum, ""]] },
      });
    }
    console.log(`✅ save_sweep_frequency: ${normalisedCategory} → ${freqNum} min`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ save_sweep_frequency error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleTriggerAgentRun(req, res, sheets) {
  const { automationCommanderSheetId: acSheetId, clientName: targetClientName, types } = req.body;
  if (!acSheetId || !targetClientName || !Array.isArray(types) || types.length === 0) {
    return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId, clientName, or types" });
  }
  const agentSecret = process.env.AGENT_TRIGGER_SECRET;
  if (!agentSecret) {
    return res.status(500).json({ success: false, error: "AGENT_TRIGGER_SECRET not configured on the server" });
  }
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: acSheetId,
      range: "AutoUpdates!A2:N1000",
    });
    const rows = resp.data.values || [];
    const row = rows.find(r => String(r[0] || "").trim() === targetClientName);
    if (!row) {
      return res.status(404).json({ success: false, error: `Client "${targetClientName}" not found in AutoUpdates` });
    }
    const webAppUrl = String(row[13] || "").trim(); // col N
    if (!webAppUrl) {
      return res.status(400).json({ success: false, error: `No Web App URL configured for "${targetClientName}" (column N) — deploy and add it first` });
    }

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const gasResp = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: agentSecret, types, clientName: targetClientName, runId }),
    });
    const gasData = await gasResp.json().catch(() => null);
    if (!gasData) {
      return res.status(502).json({ success: false, error: "No valid response from the client's Web App — check the deployment URL and that it's still active" });
    }
    if (!gasData.success) {
      return res.status(200).json({ success: false, error: gasData.error || "Client Web App reported failure" });
    }
    return res.status(200).json({ success: true, triggered: gasData.triggered || types, runId });
  } catch (err) {
    console.error(`❌ trigger_agent_run error for "${targetClientName}":`, err);
    return res.status(500).json({ success: false, error: `Failed to reach client Web App: ${err.message}` });
  }
}

export async function handleAgentProgress(req, res) {
  const { secret: progressSecret, clientName: progressClientName, runId: progressRunId, stage, message, done } = req.body;
  if (progressSecret !== process.env.AGENT_TRIGGER_SECRET) {
    return res.status(200).json({ success: false, error: "Invalid secret" });
  }
  if (!progressClientName || !progressRunId) {
    return res.status(400).json({ success: false, error: "Missing clientName or runId" });
  }
  try {
    const progressKey = `agent_run:${progressClientName}:${progressRunId}`;
    const existingRaw = await redisClient.get(progressKey);
    const existing = existingRaw ? JSON.parse(existingRaw) : { entries: [], done: false };
    existing.entries.push({ stage: stage || "", message: message || "", at: new Date().toISOString() });
    if (done) existing.done = true;
    await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(`❌ agent_progress error for "${progressClientName}"/"${progressRunId}":`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetAgentRunProgress(req, res) {
  const { clientName: pollClientName, runId: pollRunId } = req.body;
  if (!pollClientName || !pollRunId) {
    return res.status(400).json({ success: false, error: "Missing clientName or runId" });
  }
  try {
    const progressKey = `agent_run:${pollClientName}:${pollRunId}`;
    const raw = await redisClient.get(progressKey);
    const data = raw ? JSON.parse(raw) : { entries: [], done: false };
    return res.status(200).json({ success: true, entries: data.entries, done: data.done });
  } catch (err) {
    console.error(`❌ get_agent_run_progress error for "${pollClientName}"/"${pollRunId}":`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
}