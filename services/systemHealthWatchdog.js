/**
 * ============================================================================
 * PULSE SYSTEM HEALTH WATCHDOG (services/systemHealthWatchdog.js)
 * ============================================================================
 * Lightweight dead-man's switch & pipeline failure detector.
 * Evaluates Redis + Supabase telemetry across:
 *   1. Alert cache freshness (`triage_precomputed.computedAt` <= 90m)
 *   2. Flag sweep errors / incomplete sweeps / stalled refresh status
 *   3. Failed `pulse_execution_logs` runs & overdue `sync_schedules`
 *   4. Scheduled `pg_cron` webhook heartbeat (`<= 75m`)
 *   5. Hourly parity monitor freshness (`<= 180m`)
 *   6. Daily 05:00 UK digest & daily Supabase snapshot completion
 *
 * Emails `paul@gothrive.uk` (or `DAILY_ALERTS_RECIPIENT`) on new or resolved
 * incidents with incident deduplication in `system_config`, and exposes fast
 * cached status to PMA Admins (`getSystemHealthSummary`).
 */

import nodemailer from "nodemailer";
import { getSupabaseAdmin } from "./supabaseClient.js";
import { redisClient, ensureRedisConnected } from "./redisClient.js";
import { isClientRecordInSetupMode } from "./masterSyncEngine.js";
import { getCanonicalAcSheetId } from "./userPermissions.js";
import { getSheetsClient } from "./sheetsClient.js";
import { logPmaActivity } from "./pmaLogger.js";

if (typeof window !== "undefined") {
  throw new Error("SECURITY VIOLATION: services/systemHealthWatchdog.js must never run in browser code.");
}

const PRECOMPUTED_KEY = "triage_precomputed";
const PMA_TRIAGE_REFRESH_STATUS_KEY = "pma:triage:refresh_status";
const SWEEP_TELEMETRY_KEY = "system_watchdog_sweep_telemetry";
const WATCHDOG_STATE_KEY = "system_watchdog_state";
const HEALTH_CACHE_TTL_MS = 25000;

let _healthSummaryCache = { value: null, expiresAt: 0 };

function parseTimestampMs_(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  if (!val) return 0;
  const parsed = Date.parse(String(val));
  return Number.isFinite(parsed) ? parsed : 0;
}

function escapeHtml_(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getUkClockParts_(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

function parseScheduleIntervalMs_(freqStr) {
  const freq = String(freqStr || "").trim().toLowerCase();
  if (!freq) return null;
  if (freq.includes("week") || freq.includes("month")) return null;
  if (freq.includes("24")) return { intervalMs: 24 * 3600 * 1000, isDaily: true };
  if (freq.includes("hr")) {
    const n = parseFloat(freq);
    if (!n || n <= 0) return null;
    return { intervalMs: n * 3600 * 1000, isDaily: n >= 24 };
  }
  if (freq.includes("min")) {
    const n = parseFloat(freq);
    if (!n || n <= 0) return null;
    return { intervalMs: n * 60 * 1000, isDaily: false };
  }
  return null;
}

export function invalidateSystemHealthCache() {
  _healthSummaryCache = { value: null, expiresAt: 0 };
}

/**
 * Records structured telemetry at the end of a full (or failed) alert sweep run
 * so transient timeouts/errors and partial aborts are never silent.
 */
export async function recordSweepRunTelemetry({
  startedAt = Date.now(),
  completedFullSweep = true,
  clientsChecked = 0,
  expectedClients = 0,
  errorsCount = 0,
  errorDetails = [],
  categoriesRun = "",
} = {}) {
  try {
    const sb = getSupabaseAdmin();
    if (!sb) return null;

    const { data: existingRow } = await sb
      .from("system_config")
      .select("value")
      .eq("key", SWEEP_TELEMETRY_KEY)
      .maybeSingle();

    const prev = existingRow?.value && typeof existingRow.value === "object" ? existingRow.value : {};
    const nowIso = new Date().toISOString();
    const errs = Number(errorsCount) || 0;
    const checked = Number(clientsChecked) || 0;
    const expected = Number(expectedClients) || 0;
    const isFullClean = Boolean(completedFullSweep) && errs === 0 && (expected === 0 || checked >= expected);
    const isIncomplete = Boolean(completedFullSweep) && expected > 0 && checked < expected;

    const nextValue = {
      lastRunAt: nowIso,
      lastRunStartedAt: new Date(parseTimestampMs_(startedAt) || Date.now()).toISOString(),
      lastFullSuccessAt: isFullClean ? nowIso : (prev.lastFullSuccessAt || null),
      lastRunClientsChecked: checked,
      lastRunExpectedClients: expected,
      lastRunCompletedFull: Boolean(completedFullSweep),
      lastRunErrorsCount: errs,
      lastRunErrorDetails: Array.isArray(errorDetails) ? errorDetails.slice(0, 15) : [],
      lastCategoriesRun: String(categoriesRun || ""),
      consecutiveErrorRuns: errs > 0 ? (Number(prev.consecutiveErrorRuns) || 0) + 1 : 0,
      consecutiveIncompleteRuns: isIncomplete
        ? (Number(prev.consecutiveIncompleteRuns) || 0) + 1
        : (completedFullSweep ? 0 : (Number(prev.consecutiveIncompleteRuns) || 0)),
    };

    await sb.from("system_config").upsert({
      key: SWEEP_TELEMETRY_KEY,
      value: nextValue,
      description: "Tracks alert sweep completion counts, client errors, and consecutive failure streaks",
      updated_by: "System (Sweep)",
    });

    invalidateSystemHealthCache();
    return nextValue;
  } catch (err) {
    console.warn("[SystemHealthWatchdog] Failed recording sweep telemetry:", err.message);
    return null;
  }
}

/**
 * Evaluates live pipeline health from Redis & Supabase without modifying any state
 * or sending emails. Safe to call on PMA Home load (cached 25s).
 */
export async function getSystemHealthSummary({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && _healthSummaryCache.value && _healthSummaryCache.expiresAt > now) {
    return _healthSummaryCache.value;
  }

  const sb = getSupabaseAdmin();
  await ensureRedisConnected().catch(() => {});

  const [preRawRes, statusRawRes, sysCfgRes, clientsRes, setupRes, schedRes, masterCfgRes, execLogRes] = await Promise.all([
    redisClient?.isOpen ? redisClient.get(PRECOMPUTED_KEY).catch(() => null) : Promise.resolve(null),
    redisClient?.isOpen ? redisClient.get(PMA_TRIAGE_REFRESH_STATUS_KEY).catch(() => null) : Promise.resolve(null),
    sb
      ? sb
          .from("system_config")
          .select("key, value, updated_at")
          .in("key", [
            "supabase_cron_clock",
            "client_parity_monitor_state",
            "daily_alerts_email_state",
            "supabase_backup_policy",
            SWEEP_TELEMETRY_KEY,
          ])
      : Promise.resolve({ data: [] }),
    sb ? sb.from("clients").select("id, client_name, status, metadata") : Promise.resolve({ data: [] }),
    sb ? sb.from("client_setup_state").select("client_name, setup_status") : Promise.resolve({ data: [] }),
    sb
      ? sb
          .from("sync_schedules")
          .select("client_name, automation_enabled, inv_freq, crm_freq, exp_freq, last_inv_run, last_crm_run, last_exp_run")
      : Promise.resolve({ data: [] }),
    sb ? sb.from("pulse_master_sync_configs").select("client_name, data_chg_alert_grid") : Promise.resolve({ data: [] }),
    sb
      ? sb
          .from("pulse_execution_logs")
          .select("client_name, func_name, status, error_message, started_at")
          .gte("started_at", new Date(now - 2 * 3600 * 1000).toISOString())
          .order("started_at", { ascending: false })
          .limit(80)
      : Promise.resolve({ data: [] }),
  ]);

  const sysMap = new Map();
  for (const row of sysCfgRes?.data || []) {
    if (row?.key) sysMap.set(row.key, row.value);
  }

  const setupByName = new Map();
  for (const row of setupRes?.data || []) {
    if (row?.client_name) setupByName.set(String(row.client_name).trim().toLowerCase(), row);
  }

  const liveClientNames = new Set();
  for (const c of clientsRes?.data || []) {
    const effStatus = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
    if (effStatus !== "live") continue;
    const key = String(c.client_name || "").trim().toLowerCase();
    if (!key) continue;
    if (isClientRecordInSetupMode(c, setupByName.get(key))) continue;
    liveClientNames.add(key);
  }

  const dcaByName = new Map();
  for (const row of masterCfgRes?.data || []) {
    if (row?.client_name && Array.isArray(row.data_chg_alert_grid) && row.data_chg_alert_grid.length > 0) {
      dcaByName.set(String(row.client_name).trim().toLowerCase(), row.data_chg_alert_grid);
    }
  }

  const issues = [];

  // 1. Alert cache freshness (`triage_precomputed`)
  let precomputedMs = 0;
  let precomputedMinutesAgo = null;
  if (preRawRes) {
    try {
      const preObj = JSON.parse(preRawRes);
      precomputedMs = parseTimestampMs_(preObj?.computedAt);
    } catch (_) { }
  }
  if (!precomputedMs) {
    issues.push({
      id: "alert_cache_stale",
      severity: "critical",
      immediateEmail: true,
      needsEmail: true,
      title: "Alert cache is missing",
      detail: "Precomputed alert data is not available in cache. Background alert sweeps may be failing.",
    });
  } else {
    precomputedMinutesAgo = Math.max(0, Math.round((now - precomputedMs) / 60000));
    if (now - precomputedMs > 90 * 60 * 1000) {
      issues.push({
        id: "alert_cache_stale",
        severity: "critical",
        immediateEmail: true,
        needsEmail: true,
        title: "Alert cache is stale",
        detail: `Precomputed alerts were last updated ${precomputedMinutesAgo} minutes ago (expected within 90 minutes).`,
      });
    }
  }

  // 2. Flag sweep errors / incomplete sweeps / stalled refresh status
  let refreshStatus = null;
  if (statusRawRes) {
    try {
      refreshStatus = JSON.parse(statusRawRes);
    } catch (_) { }
  }
  const sweepTelemetry = sysMap.get(SWEEP_TELEMETRY_KEY) || null;
  const sweepErrorsCount = Number(sweepTelemetry?.lastRunErrorsCount) || 0;
  const consecutiveErrorRuns = Number(sweepTelemetry?.consecutiveErrorRuns) || 0;
  const consecutiveIncompleteRuns = Number(sweepTelemetry?.consecutiveIncompleteRuns) || 0;

  if (sweepErrorsCount > 0) {
    const sampleDetails = (sweepTelemetry?.lastRunErrorDetails || [])
      .slice(0, 3)
      .map((d) => `${d.clientName || "Unknown"} (${d.error || d.step || "Error"})`)
      .join("; ");
    issues.push({
      id: "flag_sweep_health",
      severity: "critical",
      immediateEmail: false,
      needsEmail: consecutiveErrorRuns >= 2,
      title: `Alert sweep recorded ${sweepErrorsCount} client ${sweepErrorsCount === 1 ? "error" : "errors"}`,
      detail: sampleDetails || "One or more clients failed during the latest alert sweep.",
    });
  } else if (
    sweepTelemetry?.lastRunCompletedFull &&
    Number(sweepTelemetry?.lastRunExpectedClients) > 0 &&
    Number(sweepTelemetry?.lastRunClientsChecked) < Number(sweepTelemetry?.lastRunExpectedClients)
  ) {
    issues.push({
      id: "flag_sweep_health",
      severity: "warning",
      immediateEmail: false,
      needsEmail: consecutiveIncompleteRuns >= 2,
      title: "Alert sweep finished only a partial client list",
      detail: `Latest sweep checked ${sweepTelemetry.lastRunClientsChecked} of ${sweepTelemetry.lastRunExpectedClients} live clients.`,
    });
  } else if (refreshStatus?.status === "error") {
    issues.push({
      id: "flag_sweep_health",
      severity: "critical",
      immediateEmail: false,
      needsEmail: false,
      title: "Background alert refresh reported an error",
      detail: String(refreshStatus.error || "Alert refresh failed before completing."),
    });
  } else if (refreshStatus?.status === "running" && (now - parseTimestampMs_(refreshStatus.updatedAt)) > 180000) {
    issues.push({
      id: "flag_sweep_health",
      severity: "warning",
      immediateEmail: false,
      needsEmail: false,
      title: "Background alert refresh appears stalled",
      detail: "An in-progress alert refresh has stopped sending progress updates for over 3 minutes.",
    });
  }

  // 3. Master sync failures (`pulse_execution_logs`) & overdue `sync_schedules`
  const syncFailures = [];
  const seenLatestExec = new Set();
  for (const log of execLogRes?.data || []) {
    const clientName = String(log.client_name || "").trim();
    const funcName = String(log.func_name || "").trim();
    if (!clientName || !liveClientNames.has(clientName.toLowerCase())) continue;
    const dedupKey = `${clientName.toLowerCase()}::${funcName.toLowerCase()}`;
    if (seenLatestExec.has(dedupKey)) continue;
    seenLatestExec.add(dedupKey);
    if (String(log.status || "").trim().toLowerCase() === "failed") {
      syncFailures.push(`${clientName} (${funcName || "sync"}: ${String(log.error_message || "Failed").slice(0, 100)})`);
    }
  }

  const overdueSyncs = [];
  for (const s of schedRes?.data || []) {
    if (s?.automation_enabled === false) continue;
    const name = String(s?.client_name || "").trim();
    const key = name.toLowerCase();
    if (!key || !liveClientNames.has(key)) continue;

    const dcaGrid = dcaByName.get(key) || null;
    const pairs = [
      ["Invoices", dcaGrid ? String(dcaGrid[1]?.[24] ?? "").trim() : s.inv_freq, s.last_inv_run],
      ["CRM", dcaGrid ? String(dcaGrid[2]?.[24] ?? "").trim() : s.crm_freq, s.last_crm_run],
      ["Expenses", dcaGrid ? String(dcaGrid[3]?.[24] ?? "").trim() : s.exp_freq, s.last_exp_run],
    ];
    for (const [label, freqVal, lastIso] of pairs) {
      const parsedFreq = parseScheduleIntervalMs_(freqVal);
      if (!parsedFreq) continue;
      const lastMs = parseTimestampMs_(lastIso);
      if (!lastMs) continue;
      const ageMs = now - lastMs;
      const maxAllowedMs = parsedFreq.isDaily
        ? 36 * 3600 * 1000
        : Math.max(3 * 3600 * 1000, Math.round(parsedFreq.intervalMs * 2.5));
      if (ageMs > maxAllowedMs) {
        const hrsAgo = Math.round(ageMs / 3600000);
        overdueSyncs.push(`${name} (${label}, ${hrsAgo}h ago)`);
      }
    }
  }

  if (syncFailures.length > 0 || overdueSyncs.length > 0) {
    const parts = [];
    if (syncFailures.length > 0) {
      parts.push(`Failed runs: ${syncFailures.slice(0, 4).join("; ")}${syncFailures.length > 4 ? ` (+${syncFailures.length - 4} more)` : ""}`);
    }
    if (overdueSyncs.length > 0) {
      parts.push(`Overdue schedules: ${overdueSyncs.slice(0, 4).join("; ")}${overdueSyncs.length > 4 ? ` (+${overdueSyncs.length - 4} more)` : ""}`);
    }
    issues.push({
      id: "master_sync_failures",
      severity: syncFailures.length > 0 ? "critical" : "warning",
      immediateEmail: syncFailures.length > 0,
      needsEmail: true,
      title: syncFailures.length > 0 ? "Data sync failures detected" : "Scheduled data syncs are overdue",
      detail: parts.join(". "),
    });
  }

  // 4. Cron webhook heartbeat (`supabase_cron_clock`)
  const cronClock = sysMap.get("supabase_cron_clock") || null;
  const lastWebhookAt = cronClock?.lastWebhookReceivedAt || null;
  const lastWebhookMs = parseTimestampMs_(lastWebhookAt);
  if (lastWebhookMs > 0 && (now - lastWebhookMs) > 75 * 60 * 1000) {
    const minsAgo = Math.round((now - lastWebhookMs) / 60000);
    issues.push({
      id: "cron_heartbeat",
      severity: "critical",
      immediateEmail: true,
      needsEmail: true,
      title: "Scheduled cron trigger has stalled",
      detail: `Last scheduled cron webhook arrived ${minsAgo} minutes ago (expected every 10 to 30 minutes).`,
    });
  }

  // 5. Hourly parity monitor freshness
  const parityState = sysMap.get("client_parity_monitor_state") || null;
  const lastParityCheckAt = parityState?.lastCheckedAt || null;
  const lastParityMs = parseTimestampMs_(lastParityCheckAt);
  if (lastParityMs > 0 && (now - lastParityMs) > 180 * 60 * 1000) {
    const minsAgo = Math.round((now - lastParityMs) / 60000);
    issues.push({
      id: "parity_monitor_stale",
      severity: "warning",
      immediateEmail: true,
      needsEmail: true,
      title: "Hourly parity monitor is overdue",
      detail: `Data parity monitor last completed ${minsAgo} minutes ago (expected hourly).`,
    });
  }

  // 6. Daily 05:00 UK digest & daily backup snapshot
  const uk = getUkClockParts_(new Date(now));
  const dailyEmailState = sysMap.get("daily_alerts_email_state") || null;
  const backupPolicy = sysMap.get("supabase_backup_policy") || null;
  const dailyGaps = [];
  if ((uk.hour > 6 || (uk.hour === 6 && uk.minute >= 30)) && dailyEmailState?.lastSentDate && dailyEmailState.lastSentDate !== uk.dateStr) {
    dailyGaps.push(`Daily alerts digest has not completed for ${uk.dateStr} (last sent ${dailyEmailState.lastSentDate})`);
  }
  if (backupPolicy?.autoDailyEnabled !== false && backupPolicy?.lastDailyBackupAt) {
    const lastBackupMs = parseTimestampMs_(backupPolicy.lastDailyBackupAt);
    if (lastBackupMs > 0 && (now - lastBackupMs) > 30 * 3600 * 1000) {
      const hrsAgo = Math.round((now - lastBackupMs) / 3600000);
      dailyGaps.push(`Automated daily database backup ran ${hrsAgo} hours ago (expected every 24 hours)`);
    }
  }
  if (dailyGaps.length > 0) {
    issues.push({
      id: "daily_jobs_health",
      severity: "warning",
      immediateEmail: true,
      needsEmail: true,
      title: "Daily maintenance job overdue",
      detail: dailyGaps.join(". "),
    });
  }

  const summary = {
    healthy: issues.length === 0,
    checkedAt: new Date(now).toISOString(),
    precomputedMinutesAgo,
    lastWebhookAt,
    lastParityCheckAt,
    issues: issues.map(({ id, severity, title, detail, immediateEmail, needsEmail }) => ({
      id,
      severity,
      title,
      detail,
      immediateEmail: Boolean(immediateEmail),
      needsEmail: Boolean(needsEmail),
    })),
  };

  _healthSummaryCache = { value: summary, expiresAt: now + HEALTH_CACHE_TTL_MS };
  return summary;
}

function buildWatchdogEmailHtml_({ issues = [], resolvedIds = [], checkedAt = "", appUrl = "" }) {
  const isRecoveryOnly = issues.length === 0 && resolvedIds.length > 0;
  const issueCards = issues
    .map((iss) => {
      const isCrit = iss.severity === "critical";
      const badgeBg = isCrit ? "#fef2f2" : "#fffbeb";
      const badgeFg = isCrit ? "#991b1b" : "#92400e";
      const badgeBorder = isCrit ? "#fecaca" : "#fde68a";
      const badgeLabel = isCrit ? "Critical" : "Warning";
      return `
        <div style="background:#ffffff;border:1px solid #e5e7eb;border-left:4px solid ${isCrit ? "#dc2626" : "#d97706"};border-radius:8px;padding:14px 16px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
            <strong style="font-size:14px;color:#111827;">${escapeHtml_(iss.title)}</strong>
            <span style="background:${badgeBg};color:${badgeFg};border:1px solid ${badgeBorder};border-radius:12px;padding:2px 8px;font-size:11px;font-weight:700;">${badgeLabel}</span>
          </div>
          <div style="font-size:13px;color:#4b5563;line-height:1.45;">${escapeHtml_(iss.detail)}</div>
        </div>`;
    })
    .join("");

  const resolvedSection = resolvedIds.length > 0
    ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px;margin-top:12px;font-size:13px;color:#166534;">
         <strong>Resolved since last check:</strong> ${escapeHtml_(resolvedIds.join(", "))}
       </div>`
    : "";

  return `
    <div style="font-family:'Kumbh Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:10px;color:#1f2937;">
      <div style="background:#1a1a2e;color:#ffffff;padding:18px 24px;border-radius:8px 8px 0 0;">
        <div style="font-size:16px;font-weight:700;">${isRecoveryOnly ? "Pulse system monitor: issues resolved" : "Pulse system monitor"}</div>
        <div style="font-size:12px;color:#94a3b8;">Automated pipeline health check · ${escapeHtml_(checkedAt)}</div>
      </div>
      <div style="background:#f3f4f6;padding:20px 24px;border:1px solid #e5e7eb;border-top:none;">
        <p style="font-size:14px;color:#374151;line-height:1.5;margin-top:0;">
          ${isRecoveryOnly
            ? "All previously flagged system health issues have now recovered."
            : `The automated system monitor detected ${issues.length} active pipeline ${issues.length === 1 ? "issue" : "issues"} requiring attention:`}
        </p>
        ${issueCards}
        ${resolvedSection}
        <div style="text-align:center;margin:24px 0 8px 0;">
          <a href="${appUrl}/pma" target="_blank" style="background:#0066cc;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 24px;border-radius:6px;display:inline-block;">
            Open Pulse Management Area
          </a>
        </div>
      </div>
    </div>`;
}

/**
 * Runs at the start of `/api/cron`: checks all watchdog health gates, deduplicates
 * incident notifications in `system_config`, and emails the admin on new/reminder
 * or resolved incidents.
 */
export async function checkAndNotifySystemHealth({
  recipientOverride = "",
  dryRunEmail = false,
  persistState = null,
} = {}) {
  const summary = await getSystemHealthSummary({ bypassCache: true });
  const sb = getSupabaseAdmin();
  const now = Date.now();
  const nowIso = summary.checkedAt || new Date(now).toISOString();
  const REMINDER_COOLDOWN_MS = 6 * 3600 * 1000;

  let prevState = { activeIncidents: {}, transientCounts: {} };
  if (sb) {
    try {
      const { data: cfgRow } = await sb
        .from("system_config")
        .select("value")
        .eq("key", WATCHDOG_STATE_KEY)
        .maybeSingle();
      if (cfgRow?.value && typeof cfgRow.value === "object") {
        prevState = {
          activeIncidents: { ...(cfgRow.value.activeIncidents || {}) },
          transientCounts: { ...(cfgRow.value.transientCounts || {}) },
        };
      }
    } catch (err) {
      console.warn("[checkAndNotifySystemHealth] Failed reading watchdog state:", err.message);
    }
  }

  const nextActiveIncidents = {};
  const nextTransientCounts = {};
  const issuesToNotify = [];
  const currentIssueIds = new Set(summary.issues.map((i) => i.id));

  for (const iss of summary.issues) {
    const count = (Number(prevState.transientCounts?.[iss.id]) || 0) + 1;
    nextTransientCounts[iss.id] = count;
    const prevInc = prevState.activeIncidents?.[iss.id] || null;
    const shouldNotifyByRule = iss.immediateEmail || iss.needsEmail || count >= 2;
    const lastNotifiedMs = parseTimestampMs_(prevInc?.lastNotifiedAt);
    const cooldownElapsed = !lastNotifiedMs || (now - lastNotifiedMs) >= REMINDER_COOLDOWN_MS;

    if (shouldNotifyByRule && cooldownElapsed) {
      issuesToNotify.push(iss);
      nextActiveIncidents[iss.id] = {
        id: iss.id,
        title: iss.title,
        severity: iss.severity,
        firstDetectedAt: prevInc?.firstDetectedAt || nowIso,
        lastNotifiedAt: nowIso,
      };
    } else if (prevInc) {
      nextActiveIncidents[iss.id] = {
        ...prevInc,
        title: iss.title,
        severity: iss.severity,
      };
    } else {
      nextActiveIncidents[iss.id] = {
        id: iss.id,
        title: iss.title,
        severity: iss.severity,
        firstDetectedAt: nowIso,
        lastNotifiedAt: null,
      };
    }
  }

  const resolvedIncidents = [];
  for (const [prevId, prevInc] of Object.entries(prevState.activeIncidents || {})) {
    if (!currentIssueIds.has(prevId) && prevInc?.lastNotifiedAt) {
      resolvedIncidents.push(prevInc.title || prevId);
    }
  }

  const shouldSendEmail = issuesToNotify.length > 0 || (summary.issues.length === 0 && resolvedIncidents.length > 0);
  let emailed = false;
  let emailSubject = "";
  let emailText = "";
  let emailHtml = "";

  if (shouldSendEmail) {
    const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
    const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;
    const appUrl = process.env.APP_BASE_URL || "https://app.pulsedashboard.co.uk";
    const recipient = recipientOverride || process.env.DAILY_ALERTS_RECIPIENT || "paul@gothrive.uk";

    if (issuesToNotify.length > 0) {
      emailSubject = `Pulse system monitor: ${issuesToNotify.length} pipeline ${issuesToNotify.length === 1 ? "issue" : "issues"} detected`;
    } else {
      emailSubject = "Pulse system monitor: all pipeline issues resolved";
    }

    emailHtml = buildWatchdogEmailHtml_({
      issues: issuesToNotify.length > 0 ? issuesToNotify : [],
      resolvedIds: resolvedIncidents,
      checkedAt: nowIso,
      appUrl,
    });
    emailText =
      (issuesToNotify.length > 0
        ? `Pulse system monitor detected ${issuesToNotify.length} issue(s) at ${nowIso}:\n\n` +
          issuesToNotify.map((i) => `- [${i.severity}] ${i.title}: ${i.detail}`).join("\n")
        : `Pulse system monitor: all previously notified issues resolved as of ${nowIso}.`) +
      (resolvedIncidents.length > 0 ? `\n\nResolved: ${resolvedIncidents.join(", ")}` : "") +
      `\n\nOpen Pulse Management Area: ${appUrl}/pma`;

    if (!dryRunEmail && emailPass) {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: emailUser, pass: emailPass },
      });
      await transporter.sendMail({
        from: `"Pulse" <${emailUser}>`,
        to: recipient,
        subject: emailSubject,
        text: emailText,
        html: emailHtml,
      });
      emailed = true;
      console.log(`CRON Watchdog: Sent "${emailSubject}" to ${recipient}`);
      const sheets = await getSheetsClient().catch(() => null);
      const acId = getCanonicalAcSheetId();
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        user: "Pulse System",
        action: "System Health Watchdog Alert",
        summary: emailSubject,
      }).catch(() => { });
    }
  }

  const shouldPersist = persistState !== null ? Boolean(persistState) : !dryRunEmail;
  if (sb && shouldPersist) {
    try {
      await sb.from("system_config").upsert({
        key: WATCHDOG_STATE_KEY,
        value: {
          lastCheckedAt: nowIso,
          healthy: summary.healthy,
          activeIncidents: nextActiveIncidents,
          transientCounts: nextTransientCounts,
        },
        description: "Deduplication and cooldown state for Pulse system health watchdog alerts",
        updated_by: "System (Cron)",
      });
    } catch (err) {
      console.warn("[checkAndNotifySystemHealth] Failed persisting watchdog state:", err.message);
    }
  }

  return {
    ...summary,
    notifiedIssuesCount: issuesToNotify.length,
    resolvedIncidents,
    emailed,
    emailSubject,
    emailText,
    emailHtml,
  };
}
