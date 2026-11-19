import crypto from "crypto";
import { waitUntil } from "@vercel/functions";
import { redisClient } from "./redisClient.js";
import { getSupabaseAdmin, isSupabaseConfigured, isSupabaseControlPlaneActive } from "./supabaseClient.js";
import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { resolveSupabaseSheetContext } from "./masterEngineService.js";
import { runNativeMasterSync } from "./masterSyncEngine.js";
import { isValidGoogleScriptUrl } from "./eomTools.js";
import { getSessionUser, safeCompareSecret } from "./authService.js";
import { isUserAuthorizedForClient, getCanonicalAcSheetId } from "./userPermissions.js";
import { getClientWebAppUrl } from "./workspaces.js";
import { postGasWebAppLocked } from "../utils/helpers.js";

async function requireSystemOrAdmin_(req, res) {
  if (req?.isSystemAuthorized) return true;
  const sessionUser = req?._liveSessionUser || await getSessionUser(req);
  if (!sessionUser?.isAdmin || sessionUser?.isReadOnly) {
    res.status(403).json({ success: false, error: "Forbidden: System Administrator privileges required." });
    return false;
  }
  return true;
}

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
  if (await isSupabaseControlPlaneActive()) {
    try {
      const sb = getSupabaseAdmin();
      const { data: cfgRow, error } = await sb
        .from("system_config")
        .select("value")
        .eq("key", "sweep_schedule")
        .maybeSingle();
      if (!error && cfgRow?.value && typeof cfgRow.value === "object") {
        const schedule = {};
        for (const [cat, val] of Object.entries(cfgRow.value)) {
          const category = String(cat || "").trim().toLowerCase();
          if (!category) continue;
          schedule[category] = {
            rowIndex: val?.rowIndex || null,
            frequencyMinutes: parseInt(val?.frequencyMinutes, 10) || SWEEP_SCHEDULE_DEFAULTS[category] || 30,
            lastCheckedAt: val?.lastCheckedAt || "",
          };
        }
        for (const category of Object.keys(SWEEP_SCHEDULE_DEFAULTS)) {
          if (!schedule[category]) {
            schedule[category] = { rowIndex: null, frequencyMinutes: SWEEP_SCHEDULE_DEFAULTS[category], lastCheckedAt: "" };
          }
        }
        return schedule;
      }
    } catch (_) { }
  }

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
  if (isSupabaseConfigured()) {
    try {
      const sb = getSupabaseAdmin();
      if (sb) {
        const updatedSchedule = {
          ...schedule,
          [category]: {
            ...(entry || {}),
            frequencyMinutes: (entry && entry.frequencyMinutes) || SWEEP_SCHEDULE_DEFAULTS[category] || 30,
            lastCheckedAt: nowISO,
          },
        };
        await sb.from("system_config").upsert({
          key: "sweep_schedule",
          value: updatedSchedule,
          description: "Background alert sweep frequencies and last checked timestamps",
        });
      }
    } catch (_) { }
  }

  const updateSheet = async () => {
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
  };
  if (await isSupabaseControlPlaneActive()) {
    updateSheet().catch(() => { });
  } else {
    await updateSheet();
  }
}

const CLAUDE_USAGE_STATE_KEY = "claude_usage_state";
const MAX_CLAUDE_USAGE_ROWS = 2000;

function parseClaudeUsageConfigRows_(cfgRows = []) {
  const cfgMap = {};
  for (const row of cfgRows) {
    if (row[0] && row[1] !== undefined) cfgMap[String(row[0]).trim()] = String(row[1]).trim();
  }
  return {
    hourlyLimit: parseInt(cfgMap["hourly_limit"] || "10", 10) || 10,
    dailyLimit: parseInt(cfgMap["daily_limit"] || "30", 10) || 30,
    anomalyThreshold: parseInt(cfgMap["anomaly_threshold"] || "15", 10) || 15,
  };
}

function mapClaudeUsageSheetRows_(usageRows = []) {
  const mapped = [];
  for (const row of usageRows) {
    if (!row?.[0]) continue;
    mapped.push({
      ts: String(row[0]),
      action: String(row[1] ?? ""),
      client: String(row[2] ?? ""),
      alertType: String(row[3] ?? ""),
      tokens: row[4] !== undefined && row[4] !== "" ? Number(row[4]) || row[4] : 0,
      cost: String(row[5] ?? "0"),
    });
  }
  return mapped.slice(-MAX_CLAUDE_USAGE_ROWS);
}

async function readClaudeUsageFromAcSheet_(sheets, acId) {
  const acIdClean = extractSheetIdFromUrl(acId) || acId || getCanonicalAcSheetId();
  if (!acIdClean) {
    return {
      config: { hourlyLimit: 10, dailyLimit: 30, anomalyThreshold: 15 },
      usageRows: [],
    };
  }
  const activeSheets = sheets || (await getSheetsClient().catch(() => null));
  if (!activeSheets) {
    return {
      config: { hourlyLimit: 10, dailyLimit: 30, anomalyThreshold: 15 },
      usageRows: [],
    };
  }
  const [cfgResp, usageResp] = await Promise.all([
    withRetry(() => activeSheets.spreadsheets.values.get({ spreadsheetId: acIdClean, range: "ClaudeUsage!A1:B6" })),
    withRetry(() => activeSheets.spreadsheets.values.get({ spreadsheetId: acIdClean, range: "ClaudeUsage!A8:F2000" })),
  ]);
  return {
    config: parseClaudeUsageConfigRows_(cfgResp.data.values || []),
    usageRows: mapClaudeUsageSheetRows_(usageResp.data.values || []),
  };
}

export async function getOrSeedClaudeUsageState_(sheets, automationCommanderSheetId) {
  const sb = getSupabaseAdmin();
  if (!sb) {
    return await readClaudeUsageFromAcSheet_(sheets, automationCommanderSheetId);
  }
  try {
    const { data: existing } = await sb
      .from("system_config")
      .select("value")
      .eq("key", CLAUDE_USAGE_STATE_KEY)
      .maybeSingle();

    if (existing?.value && typeof existing.value === "object" && existing.value.config) {
      const cfg = existing.value.config;
      return {
        config: {
          hourlyLimit: parseInt(cfg.hourlyLimit ?? 10, 10) || 10,
          dailyLimit: parseInt(cfg.dailyLimit ?? 30, 10) || 30,
          anomalyThreshold: parseInt(cfg.anomalyThreshold ?? 15, 10) || 15,
        },
        usageRows: Array.isArray(existing.value.usageRows) ? existing.value.usageRows : [],
        seededAt: existing.value.seededAt || null,
        updatedAt: existing.value.updatedAt || null,
      };
    }
  } catch (err) {
    console.warn("[getOrSeedClaudeUsageState_] Read error:", err.message);
  }

  let seeded;
  try {
    seeded = await readClaudeUsageFromAcSheet_(sheets, automationCommanderSheetId);
  } catch (sheetErr) {
    console.warn("[getOrSeedClaudeUsageState_] AC sheet seed fallback:", sheetErr.message);
    seeded = {
      config: { hourlyLimit: 10, dailyLimit: 30, anomalyThreshold: 15 },
      usageRows: [],
    };
  }

  const nowIso = new Date().toISOString();
  const payload = {
    config: seeded.config,
    usageRows: seeded.usageRows,
    seededAt: nowIso,
    updatedAt: nowIso,
  };
  await sb.from("system_config").upsert({
    key: CLAUDE_USAGE_STATE_KEY,
    value: payload,
    description: "Claude API budget limits and usage telemetry migrated from ClaudeUsage tab",
    updated_by: "System (Migration Seed)",
  });
  return payload;
}

async function saveClaudeUsageState_(sb, state) {
  if (!sb) return;
  await sb.from("system_config").upsert({
    key: CLAUDE_USAGE_STATE_KEY,
    value: {
      config: state.config,
      usageRows: (state.usageRows || []).slice(-MAX_CLAUDE_USAGE_ROWS),
      seededAt: state.seededAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    description: "Claude API budget limits and usage telemetry migrated from ClaudeUsage tab",
    updated_by: "System (Claude Usage)",
  });
}

export async function logClaudeUsage_(sheets, automationCommanderSheetId, clientName, alertType, inputTokens, outputTokens, source) {
  const acIdClean = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId || getCanonicalAcSheetId();
  const costUsd = ((inputTokens || 0) / 1000000 * 3) + ((outputTokens || 0) / 1000000 * 15);
  const entry = {
    ts: new Date().toISOString(),
    action: String(source || "precompute"),
    client: String(clientName || ""),
    alertType: String(alertType || ""),
    tokens: (inputTokens || 0) + (outputTokens || 0),
    cost: costUsd.toFixed(6),
  };

  const sb = getSupabaseAdmin();
  if (sb) {
    const state = await getOrSeedClaudeUsageState_(sheets, acIdClean);
    state.usageRows = [...(state.usageRows || []), entry].slice(-MAX_CLAUDE_USAGE_ROWS);
    await saveClaudeUsageState_(sb, state);
  }

  const supaControlPlane = await isSupabaseControlPlaneActive().catch(() => false);
  if (!supaControlPlane && sheets && acIdClean) {
    await ensureClaudeUsageTab_(sheets, acIdClean);
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: acIdClean,
      range: "ClaudeUsage!A:F",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          entry.ts,
          entry.action,
          entry.client,
          entry.alertType,
          entry.tokens,
          entry.cost,
        ]],
      },
    }));
  }
  console.log(`  📊 Logged Claude usage: ${clientName} ${alertType} - ${inputTokens}+${outputTokens} tokens, $${costUsd.toFixed(4)}`);
}

export async function handleGetClaudeSettings(req, res, sheets) {
  if (!(await requireSystemOrAdmin_(req, res))) return;
  const { automationCommanderSheetId: acId } = req.body || {};
  const acIdClean = extractSheetIdFromUrl(acId) || acId || getCanonicalAcSheetId();
  if (!isSupabaseConfigured() && !acIdClean) {
    return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  }
  try {
    const state = await getOrSeedClaudeUsageState_(sheets, acIdClean);
    const { hourlyLimit, dailyLimit, anomalyThreshold } = state.config;
    const usageRows = state.usageRows || [];

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const curHour = now.getUTCHours();

    let todayCalls = 0, todayCost = 0, hourCalls = 0, hourCost = 0, weeklyCalls = 0, weeklyCost = 0;
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const recentRows = [];

    for (const row of usageRows) {
      const ts = row?.ts ? new Date(row.ts) : null;
      if (!ts || isNaN(ts)) continue;
      const cost = parseFloat(row.cost || "0") || 0;
      if (ts >= weekAgo) { weeklyCalls++; weeklyCost += cost; }
      if (ts.toISOString().slice(0, 10) === todayStr) {
        todayCalls++; todayCost += cost;
        if (ts.getUTCHours() === curHour) { hourCalls++; hourCost += cost; }
      }
      recentRows.push({
        ts: row.ts,
        action: row.action,
        client: row.client,
        alertType: row.alertType,
        tokens: row.tokens,
        cost: row.cost,
      });
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
  } catch (err) {
    console.error("❌ get_claude_settings error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleSaveClaudeSettings(req, res, sheets) {
  const { automationCommanderSheetId: acId, hourlyLimit, dailyLimit, anomalyThreshold } = req.body || {};
  const acIdClean = extractSheetIdFromUrl(acId) || acId || getCanonicalAcSheetId();
  if (!isSupabaseConfigured() && !acIdClean) {
    return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  }
  try {
    const nextConfig = {
      hourlyLimit: parseInt(hourlyLimit, 10) || 10,
      dailyLimit: parseInt(dailyLimit, 10) || 30,
      anomalyThreshold: parseInt(anomalyThreshold, 10) || 15,
    };

    const sb = getSupabaseAdmin();
    if (sb) {
      const state = await getOrSeedClaudeUsageState_(sheets, acIdClean);
      state.config = nextConfig;
      await saveClaudeUsageState_(sb, state);
    }

    const supaControlPlane = await isSupabaseControlPlaneActive().catch(() => false);
    if (!supaControlPlane && sheets && acIdClean) {
      await ensureClaudeUsageTab_(sheets, acIdClean);
      await sheets.spreadsheets.values.update({
        spreadsheetId: acIdClean,
        range: "ClaudeUsage!B2:B4",
        valueInputOption: "RAW",
        requestBody: { values: [[nextConfig.hourlyLimit], [nextConfig.dailyLimit], [nextConfig.anomalyThreshold]] },
      });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ save_claude_settings error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCheckClaudeBudget(req, res, sheets) {
  const { automationCommanderSheetId: acId } = req.body || {};
  const acIdClean = extractSheetIdFromUrl(acId) || acId || getCanonicalAcSheetId();
  if (!isSupabaseConfigured() && !acIdClean) return res.status(200).json({ allowed: true });
  try {
    const state = await getOrSeedClaudeUsageState_(sheets, acIdClean);
    const hourlyLimit = state.config?.hourlyLimit || 10;
    const dailyLimit = state.config?.dailyLimit || 30;

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const curHour = now.getUTCHours();
    let hourCalls = 0, dayCalls = 0;

    for (const row of (state.usageRows || [])) {
      const ts = row?.ts ? new Date(row.ts) : null;
      if (!ts || isNaN(ts)) continue;
      if (ts.toISOString().slice(0, 10) === todayStr) {
        dayCalls++;
        if (ts.getUTCHours() === curHour) hourCalls++;
      }
    }

    if (dayCalls >= dailyLimit) return res.status(200).json({ allowed: false, reason: `Daily limit reached (${dayCalls}/${dailyLimit})` });
    if (hourCalls >= hourlyLimit) return res.status(200).json({ allowed: false, reason: `Hourly limit reached (${hourCalls}/${hourlyLimit})` });
    return res.status(200).json({ allowed: true, hourCalls, dayCalls, hourlyLimit, dailyLimit });
  } catch (err) {
    console.error("❌ check_claude_budget error:", err);
    return res.status(200).json({ allowed: true });
  }
}

export async function handleLogClaudeUsage(req, res, sheets) {
  if (!(await requireSystemOrAdmin_(req, res))) return;
  const { automationCommanderSheetId, source, clientName, alertType, inputTokens, outputTokens } = req.body;
  try {
    await logClaudeUsage_(sheets, automationCommanderSheetId, clientName, alertType, inputTokens, outputTokens, source);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ log_claude_usage route error:", err);
    return res.status(200).json({ success: false });
  }
}

export async function handleGetAppLog(req, res, sheets) {
  if (!(await requireSystemOrAdmin_(req, res))) return;
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
    const gasUrl = (
      process.env.AUTOMATION_COMMANDER_WEBAPP_URL ||
      "https://script.google.com/macros/s/AKfycbzVvLSDtqWj3aHcn0UV9VPCybNm82sBNWynMo1-bMpvs3NzerPZXWkrpPJvVHaqDwwy/exec"
    ).trim();
    const gasResp = await postGasWebAppLocked(gasUrl, { action: "run_proactive_checks" });
    const gasData = await gasResp.json().catch(() => ({}));
    if (!gasData.success) throw new Error(gasData.error || "Failed to trigger Apps Script");
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ trigger_proactive_checks error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetSweepSchedule(req, res, sheets) {
  if (!(await requireSystemOrAdmin_(req, res))) return;
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
    if (isSupabaseConfigured()) {
      try {
        const sb = getSupabaseAdmin();
        if (sb) {
          const updatedSchedule = {
            ...schedule,
            [normalisedCategory]: {
              ...(entry || {}),
              frequencyMinutes: freqNum,
              lastCheckedAt: entry?.lastCheckedAt || "",
            },
          };
          await sb.from("system_config").upsert({
            key: "sweep_schedule",
            value: updatedSchedule,
            description: "Background alert sweep frequencies and last checked timestamps",
          });
        }
      } catch (_) { }
    }

    const updateSheet = async () => {
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
    };
    if (await isSupabaseControlPlaneActive()) {
      updateSheet().catch(() => { });
    } else {
      await updateSheet();
    }
    console.log(`✅ save_sweep_frequency: ${normalisedCategory} → ${freqNum} min`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ save_sweep_frequency error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleTriggerAgentRun(req, res, sheets) {
  const { clientName: targetClientName, types } = req.body;
  const acSheetId = getCanonicalAcSheetId();
  if (!acSheetId || !targetClientName || !Array.isArray(types) || types.length === 0) {
    return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId, clientName, or types" });
  }
  const sessionUser = getSessionUser(req);
  if (!req.isSystemAuthorized && (!sessionUser || (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, targetClientName)))) {
    return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client." });
  }
  const rawSecret = process.env.CRON_SECRET || process.env.AGENT_TRIGGER_SECRET || "";
  const agentSecret = String(rawSecret).replace(/^["']|["']$/g, '').trim();
  if (!agentSecret) {
    return res.status(500).json({ success: false, error: "AGENT_TRIGGER_SECRET is not configured on server" });
  }
  try {
    const supaCtx = await resolveSupabaseSheetContext({ clientName: targetClientName });
    if (supaCtx && supaCtx.masterMode === "supabase") {
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const activeRunObj = { runId, clientName: targetClientName, types, startedAt: Date.now(), status: "running" };
      await redisClient.set(`active_agent_run:${targetClientName}`, JSON.stringify(activeRunObj), { EX: 1800 });
      await redisClient.set("active_agent_run:latest", JSON.stringify(activeRunObj), { EX: 1800 });

      const progressKey = `agent_run:${targetClientName}:${runId}`;
      const liveEntries = [
        {
          stage: "init",
          message: `Starting automation run for [${types.join(", ")}] (${targetClientName})...`,
          at: new Date().toISOString(),
        },
      ];
      await redisClient.set(
        progressKey,
        JSON.stringify({
          entries: liveEntries,
          done: false,
        }),
        { EX: 1800 }
      );

      const nativeTask = (async () => {
        try {
          const syncType = types.length === 1 ? types[0] : "all";
          const syncRes = await runNativeMasterSync({
            sheets,
            clientName: targetClientName,
            syncType,
            types,
            runId,
            onProgress: async (prog) => {
              if (!prog || !prog.message) return;
              liveEntries.push({
                stage: prog.stage || "info",
                message: prog.message,
                at: new Date().toISOString(),
              });
              await redisClient
                .set(progressKey, JSON.stringify({ entries: liveEntries, done: Boolean(prog.done) }), { EX: 1800 })
                .catch(() => { });
            },
            userEmail: sessionUser?.email || "System",
          });
          liveEntries.push({
            stage: "done",
            message: `All requested sequences complete (${syncRes.comparisons?.invDiscrepancyCount ?? 0} invoice flags, ${syncRes.comparisons?.dirDiscrepancyCount ?? 0} expense flags).`,
            at: new Date().toISOString(),
          });
          await redisClient.set(progressKey, JSON.stringify({ entries: liveEntries, done: true }), { EX: 1800 });
          await redisClient.set(
            `active_agent_run:${targetClientName}`,
            JSON.stringify({
              runId,
              clientName: targetClientName,
              status: "completed",
              done: true,
              completedAt: Date.now(),
            }),
            { EX: 600 }
          );
        } catch (err) {
          await redisClient.set(
            progressKey,
            JSON.stringify({
              entries: [{ stage: "error", message: err.message, at: new Date().toISOString() }],
              done: true,
            }),
            { EX: 1800 }
          );
          await redisClient.set(
            `active_agent_run:${targetClientName}`,
            JSON.stringify({
              runId,
              clientName: targetClientName,
              status: "error",
              error: err.message,
              completedAt: Date.now(),
            }),
            { EX: 600 }
          );
        }
      })();

      waitUntil(nativeTask);
      return res.status(200).json({ success: true, triggered: types, runId, engine: "supabase" });
    }

    const webAppUrl = await getClientWebAppUrl(sheets, targetClientName, acSheetId);
    if (!webAppUrl || !isValidGoogleScriptUrl(webAppUrl)) {
      return res.status(400).json({ success: false, error: `No valid Google Apps Script Web App URL configured for "${targetClientName}"` });
    }

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Initialize Redis tracking so user can navigate away and return
    const activeRunObj = { runId, clientName: targetClientName, types, startedAt: Date.now(), status: "running" };
    await redisClient.set(`active_agent_run:${targetClientName}`, JSON.stringify(activeRunObj), { EX: 1800 });
    await redisClient.set("active_agent_run:latest", JSON.stringify(activeRunObj), { EX: 1800 });

    const progressKey = `agent_run:${targetClientName}:${runId}`;
    await redisClient.set(progressKey, JSON.stringify({
      entries: [{ stage: "init", message: "Contacting client Master Sheet Web App...", at: new Date().toISOString() }],
      done: false
    }), { EX: 1800 });

    // Execute via Vercel Pro waitUntil so the response returns to the browser in < 300ms
    const task = (async () => {
      const startTime = Date.now();
      try {
        console.log(`[Agent run] Invoking Web App for ${targetClientName} (runId: ${runId})...`);
        const gasResp = await postGasWebAppLocked(webAppUrl, {
          secret: agentSecret,
          types,
          clientName: targetClientName,
          runId
        });
        const gasData = await gasResp.json().catch(() => null);
        if (gasData && gasData.success === false) {
          const errMsg = gasData?.error || "Client Web App reported an error during execution";
          console.error(`[Agent run] Web App reported failure for ${targetClientName}:`, errMsg);
          const raw = await redisClient.get(progressKey).catch(() => null);
          const existing = raw ? JSON.parse(raw) : { entries: [], done: false };
          existing.entries.push({ stage: "error", message: errMsg, at: new Date().toISOString() });
          existing.done = true;
          await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 }).catch(() => { });
          await redisClient.set(`active_agent_run:${targetClientName}`, JSON.stringify({
            runId, clientName: targetClientName, status: "error", error: errMsg, completedAt: Date.now()
          }), { EX: 600 }).catch(() => { });
        } else if (gasData && gasData.success) {
          const raw = await redisClient.get(progressKey).catch(() => null);
          const existing = raw ? JSON.parse(raw) : { entries: [], done: false };
          if (!existing.done) {
            existing.entries.push({ stage: "done", message: "All requested sequences complete.", at: new Date().toISOString() });
            existing.done = true;
            await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 }).catch(() => { });
            await redisClient.set(`active_agent_run:${targetClientName}`, JSON.stringify({
              runId, clientName: targetClientName, status: "completed", done: true, completedAt: Date.now()
            }), { EX: 600 }).catch(() => { });
          }
        }
      } catch (fetchErr) {
        const elapsedMs = Date.now() - startTime;
        console.warn(`[Agent run] Background fetch connection closed for ${targetClientName} after ${elapsedMs}ms:`, fetchErr.message);
        const raw = await redisClient.get(progressKey).catch(() => null);
        const existing = raw ? JSON.parse(raw) : { entries: [], done: false };

        // Google Apps Script Web Apps often drop the client HTTP connection after ~30-50s
        // while the execution continues to completion inside Google Cloud.
        // If the connection was open for >= 5s, the Web App already received the payload and is executing.
        // Do NOT mark the run as fatal error / done = true.
        if (elapsedMs >= 5000 && !existing.done) {
          existing.entries.push({
            stage: "info",
            message: "Automation sequence in progress (Google Apps Script executing in background)...",
            at: new Date().toISOString()
          });
          await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 }).catch(() => { });
        } else if (!existing.done) {
          // Immediate failure (< 5s), e.g. invalid URL or DNS error
          existing.entries.push({ stage: "error", message: `Failed to connect to client Web App: ${fetchErr.message}`, at: new Date().toISOString() });
          existing.done = true;
          await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 }).catch(() => { });
          await redisClient.set(`active_agent_run:${targetClientName}`, JSON.stringify({
            runId, clientName: targetClientName, status: "error", error: fetchErr.message, completedAt: Date.now()
          }), { EX: 600 }).catch(() => { });
        }
      }
    })();

    waitUntil(task);

    return res.status(200).json({ success: true, triggered: types, runId });
  } catch (err) {
    console.error(`trigger_agent_run error for "${targetClientName}":`, err);
    return res.status(500).json({ success: false, error: `Failed to reach client Web App: ${err.message}` });
  }
}

export async function handleAgentProgress(req, res) {
  const { secret: progressSecret, clientName: progressClientName, runId: progressRunId, stage, message, done } = req.body;
  const cleanProgressSecret = String(progressSecret || "").replace(/^["']|["']$/g, '').trim();
  const validSecrets = [
    process.env.AGENT_TRIGGER_SECRET,
    process.env.CRON_SECRET
  ].filter(Boolean).map(s => String(s).replace(/^["']|["']$/g, '').trim());

  if (!cleanProgressSecret || !validSecrets.some(s => safeCompareSecret(cleanProgressSecret, s))) {
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
    if (done) {
      existing.done = true;
      await redisClient.set(`active_agent_run:${progressClientName}`, JSON.stringify({
        runId: progressRunId, clientName: progressClientName, status: "completed", done: true, completedAt: Date.now()
      }), { EX: 600 }).catch(() => { });
    }
    await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(`agent_progress error for "${progressClientName}"/"${progressRunId}":`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetAgentRunProgress(req, res) {
  const { clientName: pollClientName, runId: pollRunId } = req.body;
  if (!pollClientName || !pollRunId) {
    return res.status(400).json({ success: false, error: "Missing clientName or runId" });
  }
  const sessionUser = getSessionUser(req);
  if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
    if (!isUserAuthorizedForClient(sessionUser, pollClientName)) {
      return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client." });
    }
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

export async function handleGetActiveAgentRun(req, res) {
  const { clientName } = req.body || {};
  const sessionUser = getSessionUser(req);
  try {
    let key = clientName ? `active_agent_run:${clientName}` : "active_agent_run:latest";
    const raw = await redisClient.get(key);
    if (!raw) return res.status(200).json({ success: true, activeRun: null });
    const activeRun = JSON.parse(raw);
    if (!req.isSystemAuthorized && sessionUser && !sessionUser.isAdmin) {
      if (!activeRun?.clientName || !isUserAuthorizedForClient(sessionUser, activeRun.clientName)) {
        return res.status(200).json({ success: true, activeRun: null });
      }
    }
    return res.status(200).json({ success: true, activeRun });
  } catch (err) {
    console.error("❌ get_active_agent_run error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * DECOMMISSIONED SECURITY STUB:
 * Global application secrets (CRON_SECRET, PULSE_INTERNAL_SECRET, VERCEL_BYPASS_TOKEN, AGENT_TRIGGER_SECRET)
 * must never be broadcast to external or retiring legacy Master GAS WebApp URLs.
 * Master Google Sheets are retiring in favour of Supabase Masters; rotate global secrets in Vercel once retired.
 */
export async function handleSyncAllMasterScriptSecrets(req, res, _sheets) {
  const clientFilter = req.body?.clientFilter ? String(req.body.clientFilter).trim().toLowerCase() : null;
  let validatedTargetCount = 0;

  try {
    if (isSupabaseConfigured() && (await isSupabaseControlPlaneActive())) {
      const sb = getSupabaseAdmin();
      const { data: sbClients } = await sb
        .from("clients")
        .select("client_name, master_mode, web_app_url, master_deployment_url");
      for (const c of sbClients || []) {
        const clientName = String(c?.client_name || "").trim();
        if (!clientName) continue;
        if (String(c?.master_mode || "").trim().toLowerCase() === "supabase") continue;
        if (clientFilter && !clientName.toLowerCase().includes(clientFilter)) continue;
        const webAppUrl = String(c.master_deployment_url || c.web_app_url || "").trim();
        if (isValidGoogleScriptUrl(webAppUrl)) validatedTargetCount++;
      }
    }
  } catch (err) {
    console.warn("[sync_all_master_script_secrets] Target count lookup note:", err.message);
  }

  return res.status(410).json({
    success: false,
    decommissioned: true,
    validatedTargetCount,
    error: "Global secret broadcasting via sync_script_secrets has been disabled. Legacy Master Google Sheets are retiring in favour of Supabase Masters; rotate shared secrets in Vercel once retirement completes."
  });
}