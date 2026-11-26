import nodemailer from "nodemailer";
import { getAllUsers, canAccessPma, canViewSalariesAndDividends, getCanonicalAcSheetId } from "./userPermissions.js";
import { readAlertMemory, ensureAlertMemoryTab } from "./alertMemory.js";
import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { getSupabaseAdmin, isSupabaseControlPlaneActive } from "./supabaseClient.js";
import { redisClient } from "./redisClient.js";
const PRECOMPUTED_KEY = "triage_precomputed";
import { matchesClientName, stripRowInfo, ADMIN_ONLY_ALERT_TYPES, sanitizeSpreadsheetTerms } from "../utils/helpers.js";
import { logPmaActivity } from "./pmaLogger.js";
import { getOpenClientNotesForDigest } from "./pulseNotesService.js";
import { verifyBridgedClientsParity } from "./clientSheetBridgeService.js";
import { verifyRelationalJobsParity, verifyRelationalJobsReadParity } from "./relationalJobsService.js";
import { verifyRelationalInputsParity, verifyRelationalInputsReadParity } from "./relationalInputsService.js";
import {
  checkPhase4MasterSchemaStatus,
  verifyRelationalMasterParity,
  verifyRelationalMasterReadParity,
} from "./relationalMasterService.js";
import {
  checkPhase4ReconSchemaStatus,
  verifyRelationalReconParity,
  verifyRelationalReconReadParity,
} from "./relationalReconService.js";
import {
  checkPhase5FinancialsSchemaStatus,
  verifyRelationalFinancialsParity,
  verifyRelationalFinancialsReadParity,
} from "./relationalFinancialsService.js";
import {
  checkPhase6NativeComputeSchemaStatus,
  verifyNativeClientCalcParity,
  verifyRelationalAccountingInvariants,
} from "./nativeClientCalcService.js";
import {
  verifyNativeMasterComparisonParity,
} from "./nativeMasterComparisonService.js";
import {
  checkPhase6NativeConnectorsSchemaStatus,
  verifyNativeConnectorsStateParity,
} from "./nativeConnectorsParityService.js";
import {
  checkPhase6NativeSyncSchemaStatus,
  verifyNativeSyncStateParity,
} from "./nativeSyncOrchestratorService.js";
import { flushPendingClientRecomputes } from "./masterEngineService.js";
import { listClientSnapshots } from "./supabaseBackupService.js";

/**
 * Format today's date in UK format: e.g. "Tuesday, 29 September"
 */
export function getFormattedDigestDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(d);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build rich HTML email body for daily alert digest
 */
function buildDigestHtml({ user, formattedDate, totalAlerts, clientSummaries, appUrl }) {
  const clientRowsHtml = clientSummaries.map(cs => {
    const breakdownPills = [];
    if (cs.invoiceCount > 0) breakdownPills.push(`<span style="display:inline-block;background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:600;margin-right:5px;margin-bottom:4px;">Invoices: ${cs.invoiceCount}</span>`);
    if (cs.expenseCount > 0) breakdownPills.push(`<span style="display:inline-block;background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:600;margin-right:5px;margin-bottom:4px;">Expenses: ${cs.expenseCount}</span>`);
    if (cs.crmCount > 0) breakdownPills.push(`<span style="display:inline-block;background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:600;margin-right:5px;margin-bottom:4px;">CRM: ${cs.crmCount}</span>`);
    if (cs.proactiveCount > 0) breakdownPills.push(`<span style="display:inline-block;background:#fffbeb;color:#92400e;border:1px solid #fde68a;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:600;margin-right:5px;margin-bottom:4px;">Proactive: ${cs.proactiveCount}</span>`);
    if (cs.taskCount > 0) breakdownPills.push(`<span style="display:inline-block;background:#f3e8ff;color:#6b21a8;border:1px solid #e9d5ff;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:600;margin-right:5px;margin-bottom:4px;">Tasks: ${cs.taskCount}</span>`);
    if (cs.clientNotesCount > 0) breakdownPills.push(`<span style="display:inline-block;background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:600;margin-right:5px;margin-bottom:4px;">Client notes: ${cs.clientNotesCount}</span>`);

    const alertBullets = (cs.alerts || []).slice(0, 4).map(a =>
      `<li style="margin-bottom:4px;color:#4b5563;font-size:13px;line-height:1.4;">${escapeHtml(a.summary)}</li>`
    ).join("");

    const moreNotice = (cs.alerts || []).length > 4
      ? `<div style="font-size:12px;color:#9ca3af;margin-top:4px;font-style:italic;">+ ${cs.alerts.length - 4} more alert${cs.alerts.length - 4 > 1 ? "s" : ""} in Pulse</div>`
      : "";

    return `
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px 18px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong style="font-size:15px;color:#111827;">${escapeHtml(cs.clientName)}</strong>
          <span style="background:#1e3a8a;color:#ffffff;border-radius:12px;padding:2px 9px;font-size:11px;font-weight:700;">${cs.totalClientAlerts} alert${cs.totalClientAlerts !== 1 ? "s" : ""}</span>
        </div>
        <div style="margin-bottom:8px;">
          ${breakdownPills.join("")}
        </div>
        ${alertBullets ? `<ul style="margin:8px 0 4px 0;padding-left:18px;">${alertBullets}</ul>${moreNotice}` : ""}
      </div>
    `;
  }).join("");

  return `
    <div style="font-family:'Kumbh Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:620px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:10px;color:#1f2937;">
      <!-- Header -->
      <div style="background:#1a1a2e;color:#ffffff;padding:18px 24px;border-radius:8px 8px 0 0;display:flex;align-items:center;gap:12px;">
        <div style="width:28px;height:28px;background:#0066cc;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:#ffffff;line-height:28px;text-align:center;">P</div>
        <div>
          <div style="font-size:16px;font-weight:700;letter-spacing:0.3px;">Pulse Management Area</div>
          <div style="font-size:12px;color:#94a3b8;">Daily Alerts Digest - ${escapeHtml(formattedDate)}</div>
        </div>
      </div>

      <!-- Main Container -->
      <div style="background:#f3f4f6;padding:20px 24px;border:1px solid #e5e7eb;border-top:none;">
        <p style="font-size:15px;line-height:1.5;margin-top:0;margin-bottom:14px;">
          Hello ${escapeHtml(user.name || "there")},
        </p>
        <p style="font-size:14px;color:#4b5563;line-height:1.5;margin-bottom:18px;">
          Here is your 5:00 AM summary of outstanding alerts across the clients you manage:
        </p>

        <!-- Stats Overview Banner -->
        <div style="background:#ffffff;border:1px solid #e5e7eb;border-left:4px solid #0066cc;border-radius:6px;padding:14px 18px;margin-bottom:20px;">
          <div style="font-size:22px;font-weight:700;color:#0066cc;">${totalAlerts}</div>
          <div style="font-size:13px;color:#4b5563;font-weight:500;">
            Outstanding alert${totalAlerts === 1 ? "" : "s"} across ${clientSummaries.length} client${clientSummaries.length === 1 ? "" : "s"}
          </div>
        </div>

        <!-- Client Summaries -->
        <div style="margin-bottom:24px;">
          ${clientRowsHtml}
        </div>

        <!-- Call to Action -->
        <div style="text-align:center;margin:28px 0 16px 0;">
          <a href="${appUrl}/pma" target="_blank" style="background:#0066cc;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 28px;border-radius:6px;display:inline-block;box-shadow:0 2px 4px rgba(0,102,204,0.2);">
            Open Pulse Management Area &rarr;
          </a>
        </div>
      </div>

      <!-- Footer -->
      <div style="padding:16px 20px;font-size:11px;color:#9ca3af;line-height:1.6;text-align:center;">
        <p style="margin:0 0 4px 0;">
          You are receiving this summary because you have notifications enabled in the Pulse Management Area.
        </p>
        <p style="margin:0 0 6px 0;">
          To stop receiving this email, update your notification preferences in <strong>PMA &gt; Settings</strong>.
        </p>
        <p style="margin:0;">
          &copy; ${new Date().getFullYear()} Thrive Organisational Consulting Ltd. Automated message &mdash; please do not reply.
        </p>
      </div>
    </div>
  `;
}

/**
 * Core Orchestrator: Sends daily alert digests to eligible active users.
 * Accepts either positional (sheets, automationCommanderSheetId) or ({ sheets, automationCommanderSheetId }).
 */
export async function sendDailyAlertsSummary(sheetsOrOptions, maybeAcId) {
  let sheets = null;
  let acId = null;

  if (
    sheetsOrOptions &&
    typeof sheetsOrOptions === "object" &&
    !sheetsOrOptions.spreadsheets &&
    ("sheets" in sheetsOrOptions || "automationCommanderSheetId" in sheetsOrOptions)
  ) {
    sheets = sheetsOrOptions.sheets || null;
    acId = sheetsOrOptions.automationCommanderSheetId || maybeAcId || getCanonicalAcSheetId();
  } else {
    sheets = sheetsOrOptions || null;
    acId = maybeAcId || getCanonicalAcSheetId();
  }

  if (!sheets) {
    sheets = await getSheetsClient().catch(() => null);
  }

  const formattedDate = getFormattedDigestDate();
  const subject = `Pulse Management Area Daily Digest - ${formattedDate}`;

  console.log(`\n📬 Daily Alerts Notifier starting for ${formattedDate}...`);

  // 1. Fetch all users from Users tab (bypassing Redis to ensure live opt-in status)
  const users = await getAllUsers(sheets, acId, true);
  const eligibleUsers = (users || []).filter(u =>
    u.status === "Active" &&
    canAccessPma(u) &&
    String(u.dailyAlertsEmail || "Yes").toLowerCase() !== "no" &&
    u.email && u.email.includes("@")
  );

  console.log(`  Found ${users.length} total users, ${eligibleUsers.length} active with Daily Alerts Email enabled.`);

  if (eligibleUsers.length === 0) {
    return { success: true, message: "No eligible active users configured for daily email digests.", sentCount: 0 };
  }

  // 2. Fetch active alerts from precomputed cache or AlertMemory
  let allAlerts = [];
  try {
    const raw = await redisClient.get(PRECOMPUTED_KEY);
    if (raw) {
      const preData = JSON.parse(raw);
      const combined = [
        ...(preData.alerts || []),
        ...(preData.proactiveAlerts || []),
        ...(preData.noActionAlerts || []),
      ];
      allAlerts = combined;
      console.log(`  Loaded ${allAlerts.length} total active alerts from Redis cache.`);
    }
  } catch (e) {
    console.warn("  Redis cache fetch warning, falling back to AlertMemory:", e.message);
  }

  if (!allAlerts.length) {
    const supabaseActive = await isSupabaseControlPlaneActive().catch(() => false);
    if (supabaseActive || (sheets && acId)) {
      await ensureAlertMemoryTab(sheets, acId);
      const memoryRows = await readAlertMemory(sheets, acId);
      allAlerts = (memoryRows || [])
        .filter(r => r.status === "cached" || r.status === "pending_automation" || r.status === "task")
        .map(r => ({
          clientName: r.clientName,
          alertType: r.alertType,
          summary: r.alertSummary,
          status: r.status,
          category: r.category
        }));
      console.log(`  Loaded ${allAlerts.length} active alerts directly from AlertMemory.`);
    }
  }

  // Filter out alerts belonging to inactive/archived/suspended clients
  try {
    const sb = getSupabaseAdmin();
    if (sb && allAlerts.length > 0) {
      const { data: statusRows } = await sb
        .from("clients")
        .select("client_name, status, metadata");
      const excluded = new Set(
        (statusRows || [])
          .filter((c) => {
            const eff = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
            return c.client_name && (eff === "inactive" || eff === "archived" || eff === "suspended");
          })
          .map((c) => String(c.client_name).trim().toLowerCase())
      );
      if (excluded.size > 0) {
        allAlerts = allAlerts.filter((a) => !excluded.has(String(a?.clientName || "").trim().toLowerCase()));
      }
    }
  } catch (statusErr) {
    console.warn("  Supabase client status filter warning:", statusErr.message);
  }

  // 3. Setup Email Transport
  const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
  const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;
  const appUrl = process.env.APP_BASE_URL || "https://app.pulsedashboard.co.uk";

  if (!emailPass) {
    console.warn("⚠️ PMA_EMAIL_APP_PASSWORD is not set. Emails will be skipped or simulated in development.");
  }

  let transporter = null;
  if (emailPass) {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: emailUser,
        pass: emailPass
      }
    });
  }

  const results = {
    sent: [],
    skippedZeroAlerts: [],
    errors: []
  };

  const openClientNotes = await getOpenClientNotesForDigest().catch(() => []);

  // 4. Process each eligible user
  for (const user of eligibleUsers) {
    const isAdminUser = user.role === "Admin" || Boolean(user.isAdmin);
    const isGlobal = isAdminUser || user.assignedClients === "*";
    const assignedList = Array.isArray(user.assignedClients) ? user.assignedClients : [];

    const allowSalaries = canViewSalariesAndDividends(user);

    // Filter alerts to this user's authorized clients and exclude admin-only alerts for non-admins
    const userAlerts = allAlerts.filter(a => {
      if (!a.clientName) return false;
      if (!isAdminUser) {
        const aType = a.alertType || a.flagType || a.type || "";
        if (a.isAdminOnly || ADMIN_ONLY_ALERT_TYPES.has(aType)) return false;
        if (!allowSalaries && aType === "salary_forecast_in_actual_month") return false;
      }
      if (isGlobal) return true;
      return assignedList.some(assigned => matchesClientName(assigned, a.clientName));
    });

    const userClientNotes = openClientNotes.filter((n) => {
      if (!n.client_name) return false;
      if (!allowSalaries && n.visibility_scope === "restricted_salary") return false;
      if (isGlobal) return true;
      return assignedList.some((assigned) => matchesClientName(assigned, n.client_name));
    });

    // Requirement #1: If user has 0 alerts and 0 open client notes, skip completely
    if (userAlerts.length === 0 && userClientNotes.length === 0) {
      console.log(`  ⏭️ Skipped ${user.email}: 0 active alerts for assigned clients.`);
      results.skippedZeroAlerts.push(user.email);
      continue;
    }

    // Group alerts by client for the user's digest
    const clientMap = {};
    for (const alert of userAlerts) {
      const cName = alert.clientName || "Unknown Client";
      if (!clientMap[cName]) {
        clientMap[cName] = {
          clientName: cName,
          totalClientAlerts: 0,
          invoiceCount: 0,
          expenseCount: 0,
          crmCount: 0,
          proactiveCount: 0,
          taskCount: 0,
          clientNotesCount: 0,
          alerts: []
        };
      }
      const cm = clientMap[cName];
      cm.totalClientAlerts++;

      const type = (alert.alertType || alert.flagType || alert.type || "").toLowerCase();
      if (type.includes("invoice")) cm.invoiceCount++;
      else if (type.includes("expense")) cm.expenseCount++;
      else if (type.includes("crm")) cm.crmCount++;
      else if (type.includes("task") || alert.status === "task") cm.taskCount++;
      else cm.proactiveCount++;

      const rawSummaryText = alert.summary || alert.alertSummary || (typeof alert.dataSnapshot === "string" ? alert.dataSnapshot.slice(0, 100) : "");
      const summaryText = isAdminUser ? rawSummaryText : sanitizeSpreadsheetTerms(stripRowInfo(rawSummaryText));
      if (summaryText) cm.alerts.push({ summary: summaryText });
    }

    for (const note of userClientNotes) {
      const cName = note.client_name || "Unknown Client";
      if (!clientMap[cName]) {
        clientMap[cName] = {
          clientName: cName,
          totalClientAlerts: 0,
          invoiceCount: 0,
          expenseCount: 0,
          crmCount: 0,
          proactiveCount: 0,
          taskCount: 0,
          clientNotesCount: 0,
          alerts: []
        };
      }
      const cm = clientMap[cName];
      cm.totalClientAlerts++;
      cm.clientNotesCount++;
      const label = sanitizeSpreadsheetTerms(note.entity_label || note.entity_type || "Note");
      const snippet = sanitizeSpreadsheetTerms(String(note.body || "").trim().slice(0, 90));
      cm.alerts.push({ summary: `Client note (${label}): ${snippet}` });
    }

    const totalItems = userAlerts.length + userClientNotes.length;
    const clientSummaries = Object.values(clientMap).sort((a, b) => b.totalClientAlerts - a.totalClientAlerts);
    const htmlBody = buildDigestHtml({
      user,
      formattedDate,
      totalAlerts: totalItems,
      clientSummaries,
      appUrl
    });

    const textBody = `Hello ${user.name || "there"},\n\n` +
      `Here is your Pulse Management Area daily summary for ${formattedDate}:\n` +
      `Total active alerts: ${userAlerts.length} across ${clientSummaries.length} clients.\n\n` +
      clientSummaries.map(cs => `• ${cs.clientName}: ${cs.totalClientAlerts} alert(s)`).join("\n") +
      `\n\nOpen Pulse Management Area: ${appUrl}/pma\n\n` +
      `To opt out of daily summaries, update your notification preferences in PMA > Settings.`;

    if (transporter) {
      try {
        await transporter.sendMail({
          from: `"Pulse" <${emailUser}>`,
          to: user.email,
          subject,
          text: textBody,
          html: htmlBody
        });
        console.log(`  ✅ Daily digest sent to ${user.email} (${userAlerts.length} alerts).`);
        results.sent.push({ email: user.email, alertsCount: userAlerts.length });

        await logPmaActivity(sheets, {
          automationCommanderSheetId: acId,
          user: "Pulse System",
          action: "Daily Digest Sent",
          summary: `Daily alert digest sent to ${user.email} (${userAlerts.length} alerts across ${clientSummaries.length} clients)`
        }).catch(() => { });

      } catch (sendErr) {
        console.error(`  ❌ Failed sending digest to ${user.email}:`, sendErr.message);
        results.errors.push({ email: user.email, error: sendErr.message });
      }
    } else {
      console.log(`  [SIMULATED] Would send daily digest to ${user.email} (${userAlerts.length} alerts).`);
      results.sent.push({ email: user.email, alertsCount: userAlerts.length, simulated: true });
    }
  }

  console.log(`📬 Daily Alerts Notifier finished: ${results.sent.length} sent, ${results.skippedZeroAlerts.length} skipped (zero alerts), ${results.errors.length} errors.\n`);
  return {
    success: true,
    sentCount: results.sent.length,
    skippedCount: results.skippedZeroAlerts.length,
    errors: results.errors,
    results
  };
}

/**
 * Seeds persisted Confirmed / Pipeline tab error notification flags from AutoUpdates!A2:CF100
 * if Supabase `amd_tab_error_notifications` does not exist yet.
 */
async function seedAmdTabErrorStateFromAcSheet_(sheets, acId) {
  const initialClients = {};
  if (!sheets || !acId) {
    return { clients: initialClients, updatedAt: new Date().toISOString() };
  }
  try {
    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: "AutoUpdates!A2:CG100",
        valueRenderOption: "FORMATTED_VALUE",
      })
    );
    const rows = resp.data.values || [];
    const headerRow = rows[0] || [];
    const confStatIdxRaw = headerRow.findIndex((h) => String(h || "").trim().toLowerCase() === "errors - conf - notified?");
    const pipeStatIdxRaw = headerRow.findIndex((h) => String(h || "").trim().toLowerCase() === "errors - pipe - notified?");
    const idxConfStat = confStatIdxRaw !== -1 ? confStatIdxRaw : 82;
    const idxPipeStat = pipeStatIdxRaw !== -1 ? pipeStatIdxRaw : 83;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const clientName = String(row[0] || "").trim();
      if (!clientName) continue;
      const confVal = String(row[idxConfStat] || "").trim() === "Notified" ? "Notified" : "";
      const pipeVal = String(row[idxPipeStat] || "").trim() === "Notified" ? "Notified" : "";
      initialClients[clientName] = { confirmed: confVal, pipeline: pipeVal };
    }
  } catch (err) {
    console.warn("[checkAndNotifyTabErrors] Non-fatal AC seed note:", err.message);
  }
  return {
    clients: initialClients,
    seededAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Checks each client's Confirmed and Pipeline ErrorCheck!B3:B4 status (100% verbatim equivalent
 * of legacy GAS `checkAMDErrors()`) and sends "[AMD] Errors present" when newly detected errors
 * appear, resetting "Notified" when resolved.
 */
export async function checkAndNotifyTabErrors({ sheets: providedSheets, automationCommanderSheetId, recipientOverride } = {}) {
  const sb = getSupabaseAdmin();
  const sheets = providedSheets || (await getSheetsClient().catch(() => null));
  const acId = automationCommanderSheetId || getCanonicalAcSheetId();

  // 1. Load or seed notification state in Supabase system_config
  let notifState = null;
  if (sb) {
    try {
      const { data: cfgRow } = await sb
        .from("system_config")
        .select("value")
        .eq("key", "amd_tab_error_notifications")
        .maybeSingle();
      if (cfgRow?.value && typeof cfgRow.value === "object") {
        notifState = {
          ...cfgRow.value,
          clients: { ...(cfgRow.value.clients || {}) },
        };
      }
    } catch (err) {
      console.warn("[checkAndNotifyTabErrors] Failed reading amd_tab_error_notifications:", err.message);
    }
  }

  let stateNeedsSave = false;
  if (!notifState) {
    notifState = await seedAmdTabErrorStateFromAcSheet_(sheets, acId);
    stateNeedsSave = true;
  }

  // 2. Load active clients (Supabase primary, AC fallback)
  let clientList = [];
  if (sb) {
    try {
      const { data: dbClients, error } = await sb
        .from("clients")
        .select("client_name, status, metadata, client_mode, master_mode, client_sheet_id, master_sheet_id")
        .order("client_name", { ascending: true });
      if (!error && Array.isArray(dbClients) && dbClients.length > 0) {
        clientList = dbClients
          .filter((c) => {
            const st = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
            return c.client_name && st !== "inactive" && st !== "archived" && st !== "suspended";
          })
          .map((c) => ({
            clientName: String(c.client_name).trim(),
            clientMode: String(c.client_mode || "sheet").trim().toLowerCase(),
            clientSheetId: extractSheetIdFromUrl(c.client_sheet_id) || String(c.client_sheet_id || "").trim(),
          }));
      }
    } catch (err) {
      console.warn("[checkAndNotifyTabErrors] Supabase clients load warning:", err.message);
    }
  }

  if (clientList.length === 0 && sheets && acId) {
    try {
      const resp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: acId,
          range: "AutoUpdates!A3:M100",
        })
      );
      clientList = (resp.data.values || [])
        .filter((r) => String(r[0] || "").trim() && String(r[11] || "").trim())
        .map((r) => ({
          clientName: String(r[0]).trim(),
          clientMode: "sheet",
          clientSheetId: extractSheetIdFromUrl(r[11]) || String(r[11] || "").trim(),
        }));
    } catch (err) {
      console.warn("[checkAndNotifyTabErrors] AC fallback client load failed:", err.message);
    }
  }

  if (clientList.length === 0) {
    return { success: true, checked: 0, errorDetails: [], emailed: false };
  }

  // 3. Batch-load Supabase virtual ErrorCheck grids for client_mode === "supabase" clients
  //    Prefer relational pulse_financial_configs.error_check_grid (Phase 5/6) with fallback to master_sheet_grids.
  const supabaseErrorGrids = new Map();
  const supaClientNames = clientList.filter((c) => c.clientMode === "supabase").map((c) => c.clientName);
  if (sb && supaClientNames.length > 0) {
    try {
      const { data: finCfgRows } = await sb
        .from("pulse_financial_configs")
        .select("client_name, error_check_grid")
        .in("client_name", supaClientNames)
        .then((r) => r)
        .catch(() => ({ data: [] }));
      for (const cfg of finCfgRows || []) {
        if (cfg.client_name && Array.isArray(cfg.error_check_grid) && cfg.error_check_grid.length > 0) {
          supabaseErrorGrids.set(String(cfg.client_name).trim().toLowerCase(), cfg.error_check_grid);
        }
      }
      const missingEcClients = supaClientNames.filter(
        (n) => !supabaseErrorGrids.has(String(n || "").trim().toLowerCase())
      );
      if (missingEcClients.length > 0) {
        const { data: ecRows } = await sb
          .from("master_sheet_grids")
          .select("client_name, values_grid")
          .eq("tab_name", "ErrorCheck")
          .eq("sheet_role", "client")
          .in("client_name", missingEcClients);
        for (const row of ecRows || []) {
          if (row.client_name && Array.isArray(row.values_grid)) {
            supabaseErrorGrids.set(String(row.client_name).trim().toLowerCase(), row.values_grid);
          }
        }
      }
    } catch (err) {
      console.warn("[checkAndNotifyTabErrors] Failed loading Supabase ErrorCheck grids:", err.message);
    }
  }

  // 4. Inspect ErrorCheck!B3:B4 per client (100% verbatim to GAS checkAMDErrors)
  const errorDetails = [];
  let checkedCount = 0;

  for (const client of clientList) {
    let b3 = "";
    let b4 = "";
    let readOk = false;

    if (client.clientMode === "supabase") {
      const grid = supabaseErrorGrids.get(client.clientName.toLowerCase());
      if (Array.isArray(grid)) {
        b3 = grid[2]?.[1] ?? "";
        b4 = grid[3]?.[1] ?? "";
        readOk = true;
      }
    } else if (sheets && client.clientSheetId) {
      try {
        const ecResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: client.clientSheetId,
            range: "ErrorCheck!B3:B4",
            valueRenderOption: "FORMATTED_VALUE",
          })
        );
        const vals = ecResp.data.values || [];
        b3 = vals[0]?.[0] ?? "";
        b4 = vals[1]?.[0] ?? "";
        readOk = true;
      } catch (err) {
        console.warn(`[checkAndNotifyTabErrors] Could not read ErrorCheck!B3:B4 for ${client.clientName}: ${err.message}`);
      }
    }

    if (!readOk) continue;
    checkedCount++;

    const prevState = notifState.clients[client.clientName] || { confirmed: "", pipeline: "" };
    const nextState = { ...prevState };

    const confErr = String(b3 || "").trim().toLowerCase() === "yes";
    const confNotified = String(prevState.confirmed || "") === "Notified";

    if (confErr && !confNotified) {
      errorDetails.push(`${client.clientName}: Confirmed tab error`);
      nextState.confirmed = "Notified";
      stateNeedsSave = true;
    } else if (!confErr && confNotified) {
      nextState.confirmed = "";
      stateNeedsSave = true;
    }

    const pipeErr = String(b4 || "").trim().toLowerCase() === "yes";
    const pipeNotified = String(prevState.pipeline || "") === "Notified";

    if (pipeErr && !pipeNotified) {
      errorDetails.push(`${client.clientName}: Pipeline tab error`);
      nextState.pipeline = "Notified";
      stateNeedsSave = true;
    } else if (!pipeErr && pipeNotified) {
      nextState.pipeline = "";
      stateNeedsSave = true;
    }

    notifState.clients[client.clientName] = nextState;
  }

  // 5. Persist updated notification state in Supabase system_config
  if (sb && stateNeedsSave) {
    try {
      notifState.updatedAt = new Date().toISOString();
      await sb.from("system_config").upsert({
        key: "amd_tab_error_notifications",
        value: notifState,
        description: "Confirmed & Pipeline tab error notification tracking (replaces AutoUpdates!CE:CF)",
        updated_by: "System (Cron)",
      });
    } catch (err) {
      console.warn("[checkAndNotifyTabErrors] Failed persisting amd_tab_error_notifications:", err.message);
    }
  }

  // 6. Send email if new errors were detected
  let emailed = false;
  if (errorDetails.length > 0) {
    const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
    const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;
    const recipient = recipientOverride || process.env.DAILY_ALERTS_RECIPIENT || "paul@gothrive.uk";
    const subject = "[AMD] Errors present";
    const textBody = errorDetails.join("\n");

    if (emailPass) {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: emailUser, pass: emailPass },
      });
      await transporter.sendMail({
        from: `"Pulse" <${emailUser}>`,
        to: recipient,
        subject,
        text: textBody,
      });
      emailed = true;
      console.log(`🚨 [AMD Errors] Sent "${subject}" to ${recipient}: ${errorDetails.join("; ")}`);
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        user: "Pulse System",
        action: "AMD Tab Error Alert Sent",
        summary: `${subject}: ${errorDetails.join("; ")}`,
      }).catch(() => { });
    } else {
      console.warn(`⚠️ [AMD Errors] PMA_EMAIL_APP_PASSWORD not set. Would send to ${recipient}: ${errorDetails.join("; ")}`);
    }
  }

  return {
    success: true,
    checked: checkedCount,
    errorDetails,
    emailed,
  };
}

function formatParityCellSnippet_(val) {
  if (val === undefined || val === null || val === "") return "blank";
  if (typeof val === "number" && Number.isFinite(val)) {
    return String(Math.round(val * 100) / 100);
  }
  if (typeof val === "object") {
    try {
      const s = JSON.stringify(val);
      return s.length > 80 ? `${s.slice(0, 77)}...` : s;
    } catch {
      return String(val);
    }
  }
  const s = String(val);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function normalizeRelationalDbDiff_(suiteLabel, d = {}) {
  const cellCoord =
    d.cellKey ||
    (Number.isInteger(d.r0) && Number.isInteger(d.c0) ? `R${d.r0 + 1}C${d.c0 + 1}` : d.kind || "table");
  return {
    tab: `${suiteLabel}${d.tabName ? ` (${d.tabName})` : ""}`,
    cell: cellCoord,
    rowLabel: d.kind ? `${d.kind} (${cellCoord})` : cellCoord,
    colLabel: "Grid vs DB",
    sheetValue: formatParityCellSnippet_(d.expected),
    supabaseValue: formatParityCellSnippet_(d.actual),
  };
}

function normalizeRelationalReadDiff_(suiteLabel, d = {}) {
  const pathStr = String(d.path || "$");
  const shortPath = pathStr.length > 56 ? `${pathStr.slice(0, 53)}...` : pathStr;
  return {
    tab: suiteLabel,
    cell: shortPath,
    rowLabel: shortPath,
    colLabel: "Grid vs Relational API",
    sheetValue: formatParityCellSnippet_(d.expected),
    supabaseValue: formatParityCellSnippet_(d.actual),
  };
}

function indexSuiteResultsByClient_(suiteReport) {
  const map = new Map();
  for (const r of suiteReport?.results || []) {
    if (r?.clientName) map.set(r.clientName, r);
  }
  return map;
}

async function fetchAllRowsForHealth_(sb, tableName, selectCols, filterFn = null) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(tableName).select(selectCols).order("id", { ascending: true }).range(from, from + 999);
    if (typeof filterFn === "function") q = filterFn(q);
    const { data, error } = await q;
    if (error) throw new Error(`${tableName} health query failed: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function runSuiteSafe_(label, suiteFailures, fn) {
  try {
    const res = await fn();
    if (res && typeof res === "object") return res;
    return { results: [] };
  } catch (err) {
    const msg = err?.message || String(err);
    suiteFailures.push({ label, error: msg });
    console.warn(`[checkAndNotifyClientParity] Verifier suite "${label}" threw:`, msg);
    return { results: [], suiteError: msg };
  }
}

async function collectZeroGridHealthAndMetrics_(sb, activeClients = [], suiteFailures = []) {
  const perClientMetrics = new Map();
  const perClientIssues = new Map();
  const platformIssues = [];

  for (const sErr of suiteFailures) {
    platformIssues.push({
      tab: "Verifier suite error",
      cell: sErr.label,
      rowLabel: sErr.label,
      colLabel: "Suite execution",
      sheetValue: "Passed",
      supabaseValue: `Error: ${sErr.error}`,
    });
  }

  if (!sb) {
    return { perClientMetrics, perClientIssues, platformIssues };
  }

  const activeById = new Map();
  const activeByName = new Map();
  for (const c of activeClients || []) {
    if (!c?.id || !c?.client_name) continue;
    activeById.set(c.id, c);
    activeByName.set(String(c.client_name).trim().toLowerCase(), c);
    perClientMetrics.set(c.client_name, {
      outgoingsNotesCount: 0,
      confirmedNotesCount: 0,
      contractorEntriesCount: 0,
      confirmedJobsCount: 0,
      dirDiscrepancies: 0,
      invDiscrepancies: 0,
    });
  }

  const pushClientIssue = (clientName, issue) => {
    if (!perClientIssues.has(clientName)) perClientIssues.set(clientName, []);
    perClientIssues.get(clientName).push(issue);
  };

  try {
    const [
      outgRows,
      bpConfRes,
      contrRows,
      jobRows,
      mcRowsRes,
      schedRes,
      execLogsRes,
      intRes,
      gridDriftRes,
      cronCfgRes,
      snapshotsRes,
    ] = await Promise.all([
      fetchAllRowsForHealth_(sb, "pulse_outgoing_items", "client_id, cell_notes"),
      sb
        .from("pulse_client_tab_blueprints")
        .select("client_id, notes_meta")
        .eq("tab_name", "Confirmed"),
      fetchAllRowsForHealth_(sb, "pulse_contractor_entries", "client_id"),
      fetchAllRowsForHealth_(sb, "pulse_jobs", "client_id", (q) => q.eq("tab_type", "confirmed")),
      sb
        .from("pulse_master_comparisons")
        .select("client_id, comparison_type, discrepancy_count")
        .in("comparison_type", ["dir_comp", "inv_comp"]),
      sb.from("sync_schedules").select("client_name, flags"),
      sb
        .from("pulse_execution_logs")
        .select("client_id, client_name, function_name, status, executed_at, summary")
        .order("executed_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(200),
      sb.from("tenant_integrations").select("client_id, tool, status"),
      sb.from("master_sheet_grids").select("client_name").limit(200),
      sb
        .from("system_config")
        .select("value")
        .eq("key", "supabase_cron_clock")
        .maybeSingle(),
      listClientSnapshots().catch((err) => ({ error: err?.message || "Failed listing snapshots", snapshots: [] })),
    ]);

    for (const r of outgRows || []) {
      const cl = activeById.get(r.client_id);
      if (!cl) continue;
      const cn = r.cell_notes && typeof r.cell_notes === "object" ? r.cell_notes : {};
      const cnt = Object.keys(cn).filter((k) => String(cn[k] ?? "").trim() !== "").length;
      perClientMetrics.get(cl.client_name).outgoingsNotesCount += cnt;
    }

    if (bpConfRes.error) throw new Error(`Confirmed blueprints query failed: ${bpConfRes.error.message}`);
    for (const r of bpConfRes.data || []) {
      const cl = activeById.get(r.client_id);
      if (!cl) continue;
      const nm = r.notes_meta && typeof r.notes_meta === "object" ? r.notes_meta : {};
      const cnt = Object.keys(nm).filter((k) => !k.startsWith("__") && String(nm[k] ?? "").trim() !== "").length;
      perClientMetrics.get(cl.client_name).confirmedNotesCount += cnt;
    }

    for (const r of contrRows || []) {
      const cl = activeById.get(r.client_id);
      if (!cl) continue;
      perClientMetrics.get(cl.client_name).contractorEntriesCount += 1;
    }

    for (const r of jobRows || []) {
      const cl = activeById.get(r.client_id);
      if (!cl) continue;
      perClientMetrics.get(cl.client_name).confirmedJobsCount += 1;
    }

    if (mcRowsRes.error) throw new Error(`Master comparisons health query failed: ${mcRowsRes.error.message}`);
    for (const r of mcRowsRes.data || []) {
      const cl = activeById.get(r.client_id);
      if (!cl) continue;
      const m = perClientMetrics.get(cl.client_name);
      if (r.comparison_type === "dir_comp") m.dirDiscrepancies = Number(r.discrepancy_count) || 0;
      else if (r.comparison_type === "inv_comp") m.invDiscrepancies = Number(r.discrepancy_count) || 0;
    }

    const nowMs = Date.now();

    // Stuck sync_schedules (> 45 min)
    for (const s of schedRes.data || []) {
      const cl = activeByName.get(String(s.client_name || "").trim().toLowerCase());
      if (!cl) continue;
      const inFlightSince = s.flags?.in_flight_since;
      if (inFlightSince) {
        const ts = new Date(inFlightSince).getTime();
        const ageMins = Number.isFinite(ts) ? Math.round((nowMs - ts) / 60000) : null;
        if (ageMins !== null && ageMins > 45) {
          pushClientIssue(cl.client_name, {
            tab: "Sync scheduler",
            cell: "in_flight_since",
            rowLabel: "Stuck in-flight sync",
            colLabel: "Schedule lock",
            sheetValue: "<= 45 min",
            supabaseValue: `Stuck ${ageMins} min`,
          });
        }
      }
    }

    // Repeated recent execution log failures (2 consecutive failures within 24h per client+function)
    const logsByClientFn = new Map();
    for (const l of execLogsRes.data || []) {
      const cl = activeById.get(l.client_id) || activeByName.get(String(l.client_name || "").trim().toLowerCase());
      if (!cl) continue;
      const execMs = new Date(l.executed_at || 0).getTime();
      if (!Number.isFinite(execMs) || nowMs - execMs > 24 * 3600 * 1000) continue;
      const fnName = String(l.function_name || "sync").trim();
      const key = `${cl.client_name}::${fnName}`;
      if (!logsByClientFn.has(key)) logsByClientFn.set(key, { clientName: cl.client_name, fnName, entries: [] });
      const grp = logsByClientFn.get(key);
      if (grp.entries.length < 2) grp.entries.push(l);
    }
    for (const grp of logsByClientFn.values()) {
      if (grp.entries.length === 2 && grp.entries.every((e) => /fail|error/i.test(String(e.status || "")))) {
        pushClientIssue(grp.clientName, {
          tab: "Native sync",
          cell: grp.fnName,
          rowLabel: `${grp.fnName} consecutive failures`,
          colLabel: "Execution log",
          sheetValue: "Completed",
          supabaseValue: formatParityCellSnippet_(grp.entries[0]?.summary || grp.entries[0]?.status || "Failed"),
        });
      }
    }

    // Integration auth / token health
    for (const ti of intRes.data || []) {
      const cl = activeById.get(ti.client_id);
      if (!cl) continue;
      const st = String(ti.status || "").trim().toLowerCase();
      if (st === "error" || st === "expired" || st === "revoked" || st === "reauth_required") {
        pushClientIssue(cl.client_name, {
          tab: "Integration auth",
          cell: ti.tool || "integration",
          rowLabel: `${ti.tool || "Integration"} connection status`,
          colLabel: "Token vault",
          sheetValue: "connected",
          supabaseValue: st,
        });
      }
    }

    // Zero-grid drift check on retired tenants
    const driftCounts = new Map();
    for (const g of gridDriftRes.data || []) {
      const cl = activeByName.get(String(g.client_name || "").trim().toLowerCase());
      if (cl && cl.grid_storage_retired) {
        driftCounts.set(cl.client_name, (driftCounts.get(cl.client_name) || 0) + 1);
      }
    }
    for (const [cName, cnt] of driftCounts.entries()) {
      pushClientIssue(cName, {
        tab: "Zero-grid drift",
        cell: "master_sheet_grids",
        rowLabel: "Retired tenant grid rows detected",
        colLabel: "Storage hygiene",
        sheetValue: "0",
        supabaseValue: String(cnt),
      });
    }

    // Platform cron clock freshness (> 75 min)
    const lastCronAt = cronCfgRes?.data?.value?.lastWebhookReceivedAt;
    const lastCronMs = lastCronAt ? new Date(lastCronAt).getTime() : NaN;
    if (!Number.isFinite(lastCronMs) || nowMs - lastCronMs > 75 * 60000) {
      const ageDesc = Number.isFinite(lastCronMs)
        ? `${Math.round((nowMs - lastCronMs) / 60000)} min ago`
        : "missing";
      platformIssues.push({
        tab: "Cron clock",
        cell: "supabase_cron_clock",
        rowLabel: "Last 30-minute cron webhook",
        colLabel: "Scheduler",
        sheetValue: "<= 75 min ago",
        supabaseValue: ageDesc,
      });
    }

    // Daily automated backup sweep freshness (> 30 hours)
    const latestDailyAuto = (snapshotsRes?.snapshots || []).find((s) => s.triggerType === "daily_auto");
    const lastAutoMs = latestDailyAuto?.createdAt ? new Date(latestDailyAuto.createdAt).getTime() : NaN;
    if (!Number.isFinite(lastAutoMs) || nowMs - lastAutoMs > 30 * 3600 * 1000) {
      const ageDesc = Number.isFinite(lastAutoMs)
        ? `${Math.round((nowMs - lastAutoMs) / 3600000)}h ago`
        : snapshotsRes?.error || "missing";
      platformIssues.push({
        tab: "Backup health",
        cell: "daily_auto",
        rowLabel: "Latest daily Format v2 snapshot",
        colLabel: "Supabase Storage",
        sheetValue: "<= 30h ago",
        supabaseValue: ageDesc,
      });
    }
  } catch (healthErr) {
    platformIssues.push({
      tab: "Health telemetry",
      cell: "collector",
      rowLabel: "Health metrics collection error",
      colLabel: "Telemetry",
      sheetValue: "OK",
      supabaseValue: healthErr.message,
    });
  }

  return { perClientMetrics, perClientIssues, platformIssues };
}

async function runFullActiveClientsParityCheck_() {
  const sb = getSupabaseAdmin();
  const [
    clientsRes,
    phase4Schema,
    phase4ReconSchema,
    phase5FinSchema,
    phase6Schema,
    phase6cSchema,
    phase6dSchema,
  ] = await Promise.all([
    sb
      ? sb
          .from("clients")
          .select("id, client_name, status, grid_storage_retired, metadata")
          .order("client_name", { ascending: true })
          .then(async (res) => {
            if (res.error && String(res.error.message || "").includes("grid_storage_retired")) {
              return sb
                .from("clients")
                .select("id, client_name, status, metadata")
                .order("client_name", { ascending: true });
            }
            return res;
          })
      : Promise.resolve({ data: [] }),
    checkPhase4MasterSchemaStatus().catch(() => ({ schemaReady: false })),
    checkPhase4ReconSchemaStatus().catch(() => ({ schemaReady: false })),
    checkPhase5FinancialsSchemaStatus().catch(() => ({ schemaReady: false })),
    checkPhase6NativeComputeSchemaStatus().catch(() => ({ schemaReady: false })),
    checkPhase6NativeConnectorsSchemaStatus().catch(() => ({ schemaReady: false })),
    checkPhase6NativeSyncSchemaStatus().catch(() => ({ schemaReady: false })),
  ]);

  const activeClients = (clientsRes?.data || []).filter((c) => {
    const effStatus = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
    return Boolean(c?.client_name) && !["inactive", "archived", "suspended"].includes(effStatus);
  });
  const hasUnretiredClients = activeClients.some((c) => !c.grid_storage_retired);

  const phase4Ready = Boolean(phase4Schema?.schemaReady);
  const phase4ReconReady = Boolean(phase4ReconSchema?.schemaReady);
  const phase5FinReady = Boolean(phase5FinSchema?.schemaReady);
  const phase6Ready = Boolean(phase6Schema?.schemaReady);
  const phase6cReady = Boolean(phase6cSchema?.schemaReady);
  const phase6dReady = Boolean(phase6dSchema?.schemaReady);

  const suiteFailures = [];
  const noopSuite = Promise.resolve({ results: [] });

  const [
    sheetReport,
    jobsDbRep,
    inputsDbRep,
    jobsReadRep,
    inputsReadRep,
    masterDbRep,
    masterReadRep,
    reconDbRep,
    reconReadRep,
    finDbRep,
    finReadRep,
    natMasterRep,
    natConnRep,
    natSyncRep,
    zeroGridHealth,
  ] = await Promise.all([
    runSuiteSafe_("Bridged & headline parity", suiteFailures, () =>
      verifyBridgedClientsParity({
        includePureSupabase: true,
        settleOnMismatch: true,
        skipRelationalSummary: true,
      })
    ),
    hasUnretiredClients
      ? runSuiteSafe_("Jobs DB", suiteFailures, () => verifyRelationalJobsParity({ source: "db" }))
      : noopSuite,
    hasUnretiredClients
      ? runSuiteSafe_("Inputs DB", suiteFailures, () => verifyRelationalInputsParity({ source: "db" }))
      : noopSuite,
    hasUnretiredClients
      ? runSuiteSafe_("Jobs API read", suiteFailures, () => verifyRelationalJobsReadParity())
      : noopSuite,
    hasUnretiredClients
      ? runSuiteSafe_("Inputs API read", suiteFailures, () => verifyRelationalInputsReadParity())
      : noopSuite,
    phase4Ready
      ? runSuiteSafe_("Master DB", suiteFailures, () =>
          verifyRelationalMasterParity({ source: "db", onlyIngestionEnabled: true })
        )
      : noopSuite,
    hasUnretiredClients && phase4Ready
      ? runSuiteSafe_("Master SQL read", suiteFailures, () =>
          verifyRelationalMasterReadParity({ source: "db", onlyReadEnabled: true })
        )
      : noopSuite,
    phase4ReconReady
      ? runSuiteSafe_("Recon DB", suiteFailures, () =>
          verifyRelationalReconParity({ source: "db", onlyReconEnabled: true })
        )
      : noopSuite,
    hasUnretiredClients && phase4ReconReady
      ? runSuiteSafe_("Recon SQL read", suiteFailures, () =>
          verifyRelationalReconReadParity({ source: "db", onlyReadEnabled: true })
        )
      : noopSuite,
    hasUnretiredClients && phase5FinReady
      ? runSuiteSafe_("Financials DB", suiteFailures, () =>
          verifyRelationalFinancialsParity({ source: "db", onlyFinancialsEnabled: true })
        )
      : noopSuite,
    hasUnretiredClients && phase5FinReady
      ? runSuiteSafe_("Financials SQL read", suiteFailures, () =>
          verifyRelationalFinancialsReadParity({ source: "db", onlyReadEnabled: true })
        )
      : noopSuite,
    phase6Ready
      ? runSuiteSafe_("Native master comp", suiteFailures, () =>
          verifyNativeMasterComparisonParity({ source: "db", onlyActiveOrShadow: true })
        )
      : noopSuite,
    phase6cReady
      ? runSuiteSafe_("Native connectors", suiteFailures, () =>
          verifyNativeConnectorsStateParity({ onlyActiveOrShadow: true })
        )
      : noopSuite,
    phase6dReady
      ? runSuiteSafe_("Native sync & logs", suiteFailures, () =>
          verifyNativeSyncStateParity({ onlyActiveOrShadow: true })
        )
      : noopSuite,
    collectZeroGridHealthAndMetrics_(sb, activeClients, suiteFailures),
  ]);

  const natClientRep = phase6Ready
    ? await runSuiteSafe_("Native client calc", suiteFailures, () =>
        verifyNativeClientCalcParity({ source: "db", onlyActiveOrShadow: true, onlyActive: true })
      )
    : await noopSuite;

  const invariantsRep = await runSuiteSafe_("Accounting invariants", suiteFailures, () =>
    verifyRelationalAccountingInvariants({ onlyActive: true })
  );

  // Re-attach any Wave 2 suite errors caught after Wave 1 telemetry ran
  if (suiteFailures.length > 0 && zeroGridHealth?.platformIssues) {
    const existingLabels = new Set(zeroGridHealth.platformIssues.map((p) => p.rowLabel));
    for (const sf of suiteFailures) {
      if (!existingLabels.has(sf.label)) {
        zeroGridHealth.platformIssues.push({
          tab: "Verifier suite error",
          cell: sf.label,
          rowLabel: sf.label,
          colLabel: "Suite execution",
          sheetValue: "Passed",
          supabaseValue: `Error: ${sf.error}`,
        });
      }
    }
  }

  const jobsDbMap = indexSuiteResultsByClient_(jobsDbRep);
  const inputsDbMap = indexSuiteResultsByClient_(inputsDbRep);
  const jobsReadMap = indexSuiteResultsByClient_(jobsReadRep);
  const inputsReadMap = indexSuiteResultsByClient_(inputsReadRep);
  const masterDbMap = indexSuiteResultsByClient_(masterDbRep);
  const masterReadMap = indexSuiteResultsByClient_(masterReadRep);
  const reconDbMap = indexSuiteResultsByClient_(reconDbRep);
  const reconReadMap = indexSuiteResultsByClient_(reconReadRep);
  const finDbMap = indexSuiteResultsByClient_(finDbRep);
  const finReadMap = indexSuiteResultsByClient_(finReadRep);
  const natClientMap = indexSuiteResultsByClient_(natClientRep);
  const natMasterMap = indexSuiteResultsByClient_(natMasterRep);
  const natConnMap = indexSuiteResultsByClient_(natConnRep);
  const natSyncMap = indexSuiteResultsByClient_(natSyncRep);
  const invariantsMap = indexSuiteResultsByClient_(invariantsRep);

  const activeNames = (sheetReport?.results || []).map((r) => r?.clientName).filter(Boolean);
  const clientsNeedingSettle = [];
  for (const name of activeNames) {
    const jDb = jobsDbMap.get(name);
    const iDb = inputsDbMap.get(name);
    const jRead = jobsReadMap.get(name);
    const iRead = inputsReadMap.get(name);
    const mDb = masterDbMap.get(name);
    const mRead = masterReadMap.get(name);
    const rDb = reconDbMap.get(name);
    const rRead = reconReadMap.get(name);
    const fDb = finDbMap.get(name);
    const fRead = finReadMap.get(name);
    const nClient = natClientMap.get(name);
    const nMaster = natMasterMap.get(name);
    const nConn = natConnMap.get(name);
    const nSync = natSyncMap.get(name);
    const inv = invariantsMap.get(name);
    const hasRelIssue =
      (jDb && (jDb.error || !jDb.matched)) ||
      (iDb && (iDb.error || !iDb.matched)) ||
      (jRead && (jRead.error || !jRead.matched)) ||
      (iRead && (iRead.error || !iRead.matched)) ||
      (mDb && (mDb.error || !mDb.matched)) ||
      (mRead && (mRead.error || !mRead.matched)) ||
      (rDb && (rDb.error || !rDb.matched)) ||
      (rRead && (rRead.error || !rRead.matched)) ||
      (fDb && (fDb.error || !fDb.matched)) ||
      (fRead && (fRead.error || !fRead.matched)) ||
      (nClient && (nClient.error || !nClient.matched)) ||
      (nMaster && (nMaster.error || !nMaster.matched)) ||
      (nConn && (nConn.error || !nConn.matched)) ||
      (nSync && (nSync.error || !nSync.matched)) ||
      (inv && (inv.error || !inv.matched));
    if (hasRelIssue) {
      clientsNeedingSettle.push(name);
    }
  }

  if (clientsNeedingSettle.length > 0) {
    await Promise.all(
      clientsNeedingSettle.map((name) => flushPendingClientRecomputes(null, name).catch(() => { }))
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));

    for (const name of clientsNeedingSettle) {
      const retries = [];
      const jDb = jobsDbMap.get(name);
      const iDb = inputsDbMap.get(name);
      const jRead = jobsReadMap.get(name);
      const iRead = inputsReadMap.get(name);
      const mDb = masterDbMap.get(name);
      const mRead = masterReadMap.get(name);
      const rDb = reconDbMap.get(name);
      const rRead = reconReadMap.get(name);
      const fDb = finDbMap.get(name);
      const fRead = finReadMap.get(name);
      const nClient = natClientMap.get(name);
      const nMaster = natMasterMap.get(name);
      const nConn = natConnMap.get(name);
      const nSync = natSyncMap.get(name);
      const inv = invariantsMap.get(name);

      if (jDb && (jDb.error || !jDb.matched)) {
        retries.push(
          verifyRelationalJobsParity({ clientName: name, source: "db" })
            .then((r) => { if (r?.results?.[0]) jobsDbMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (iDb && (iDb.error || !iDb.matched)) {
        retries.push(
          verifyRelationalInputsParity({ clientName: name, source: "db" })
            .then((r) => { if (r?.results?.[0]) inputsDbMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (jRead && (jRead.error || !jRead.matched)) {
        retries.push(
          verifyRelationalJobsReadParity({ clientName: name })
            .then((r) => { if (r?.results?.[0]) jobsReadMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (iRead && (iRead.error || !iRead.matched)) {
        retries.push(
          verifyRelationalInputsReadParity({ clientName: name })
            .then((r) => { if (r?.results?.[0]) inputsReadMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (mDb && (mDb.error || !mDb.matched)) {
        retries.push(
          verifyRelationalMasterParity({ clientName: name, source: "db", onlyIngestionEnabled: true })
            .then((r) => { if (r?.results?.[0]) masterDbMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (mRead && (mRead.error || !mRead.matched)) {
        retries.push(
          verifyRelationalMasterReadParity({ clientName: name, source: "db", onlyReadEnabled: true })
            .then((r) => { if (r?.results?.[0]) masterReadMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (rDb && (rDb.error || !rDb.matched)) {
        retries.push(
          verifyRelationalReconParity({ clientName: name, source: "db", onlyReconEnabled: true })
            .then((r) => { if (r?.results?.[0]) reconDbMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (rRead && (rRead.error || !rRead.matched)) {
        retries.push(
          verifyRelationalReconReadParity({ clientName: name, source: "db", onlyReadEnabled: true })
            .then((r) => { if (r?.results?.[0]) reconReadMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (fDb && (fDb.error || !fDb.matched)) {
        retries.push(
          verifyRelationalFinancialsParity({ clientName: name, source: "db", onlyFinancialsEnabled: true })
            .then((r) => { if (r?.results?.[0]) finDbMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (fRead && (fRead.error || !fRead.matched)) {
        retries.push(
          verifyRelationalFinancialsReadParity({ clientName: name, source: "db", onlyReadEnabled: true })
            .then((r) => { if (r?.results?.[0]) finReadMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (nClient && (nClient.error || !nClient.matched)) {
        retries.push(
          verifyNativeClientCalcParity({ clientName: name, source: "db", onlyActiveOrShadow: true })
            .then((r) => { if (r?.results?.[0]) natClientMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (nMaster && (nMaster.error || !nMaster.matched)) {
        retries.push(
          verifyNativeMasterComparisonParity({ clientName: name, source: "db", onlyActiveOrShadow: true })
            .then((r) => { if (r?.results?.[0]) natMasterMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (nConn && (nConn.error || !nConn.matched)) {
        retries.push(
          verifyNativeConnectorsStateParity({ clientName: name, onlyActiveOrShadow: true })
            .then((r) => { if (r?.results?.[0]) natConnMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (nSync && (nSync.error || !nSync.matched)) {
        retries.push(
          verifyNativeSyncStateParity({ clientName: name, onlyActiveOrShadow: true })
            .then((r) => { if (r?.results?.[0]) natSyncMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (inv && (inv.error || !inv.matched)) {
        retries.push(
          verifyRelationalAccountingInvariants({ clientName: name, onlyActive: true })
            .then((r) => { if (r?.results?.[0]) invariantsMap.set(name, r.results[0]); })
            .catch(() => { })
        );
      }
      if (retries.length > 0) await Promise.all(retries);
    }
  }

  const mergedResults = (sheetReport?.results || []).map((row) => {
    const name = row?.clientName;
    if (!name) return row;

    const jDb = jobsDbMap.get(name) || null;
    const iDb = inputsDbMap.get(name) || null;
    const jRead = jobsReadMap.get(name) || null;
    const iRead = inputsReadMap.get(name) || null;
    const mDb = masterDbMap.get(name) || null;
    const mRead = masterReadMap.get(name) || null;
    const rDb = reconDbMap.get(name) || null;
    const rRead = reconReadMap.get(name) || null;
    const fDb = finDbMap.get(name) || null;
    const fRead = finReadMap.get(name) || null;
    const nClient = natClientMap.get(name) || null;
    const nMaster = natMasterMap.get(name) || null;
    const nConn = natConnMap.get(name) || null;
    const nSync = natSyncMap.get(name) || null;
    const inv = invariantsMap.get(name) || null;

    const suites = [
      { label: "Jobs DB", rec: jDb, isRead: false },
      { label: "Inputs DB", rec: iDb, isRead: false },
      { label: "Jobs API read", rec: jRead, isRead: true },
      { label: "Inputs API read", rec: iRead, isRead: true },
      { label: "Master DB", rec: mDb, isRead: false },
      { label: "Master SQL read", rec: mRead, isRead: false },
      { label: "Recon DB", rec: rDb, isRead: false },
      { label: "Recon SQL read", rec: rRead, isRead: false },
      { label: "Financials DB", rec: fDb, isRead: false },
      { label: "Financials SQL read", rec: fRead, isRead: false },
      { label: "Native client calc", rec: nClient, isRead: false },
      { label: "Native master comp", rec: nMaster, isRead: false },
      { label: "Native connectors", rec: nConn, isRead: false },
      { label: "Native sync & logs", rec: nSync, isRead: false },
      { label: "Accounting invariants", rec: inv, isRead: false },
    ];

    const relDiffs = [];
    const relErrors = [];
    let relationalMismatchCount = 0;

    for (const s of suites) {
      if (!s.rec) continue;
      if (s.rec.error) {
        relErrors.push(`${s.label}: ${s.rec.error}`);
      } else if (!s.rec.matched) {
        const count = s.rec.totalMismatchCount ?? s.rec.mismatchCount ?? (s.rec.sampleMismatches?.length || 1);
        relationalMismatchCount += count;
        for (const d of s.rec.sampleMismatches || []) {
          relDiffs.push(s.isRead ? normalizeRelationalReadDiff_(s.label, d) : normalizeRelationalDbDiff_(s.label, d));
        }
      }
    }

    const liveMetrics = zeroGridHealth?.perClientMetrics?.get(name) || null;
    const clientHealthIssues = zeroGridHealth?.perClientIssues?.get(name) || [];
    for (const issue of clientHealthIssues) {
      relationalMismatchCount++;
      relDiffs.push(issue);
    }

    const combinedError = row.error || (relErrors.length > 0 ? relErrors.join("; ") : null);
    const totalMismatchCount = (row.dashboardMismatchCount || 0) + (row.cashMismatchCount || 0) + relationalMismatchCount;
    const sampleMismatches = [...(row.sampleMismatches || []).slice(0, 5), ...relDiffs.slice(0, 8)].slice(0, 12);

    return {
      ...row,
      error: combinedError,
      liveMetrics,
      relationalMismatchCount,
      relationalJobsDbMatched: jDb ? Boolean(jDb.matched && !jDb.error) : true,
      relationalInputsDbMatched: iDb ? Boolean(iDb.matched && !iDb.error) : true,
      relationalJobsReadMatched: jRead ? Boolean(jRead.matched && !jRead.error) : true,
      relationalInputsReadMatched: iRead ? Boolean(iRead.matched && !iRead.error) : true,
      relationalMasterDbMatched: mDb ? Boolean(mDb.matched && !mDb.error) : true,
      relationalMasterReadMatched: mRead ? Boolean(mRead.matched && !mRead.error) : true,
      relationalReconDbMatched: rDb ? Boolean(rDb.matched && !rDb.error) : true,
      relationalReconReadMatched: rRead ? Boolean(rRead.matched && !rRead.error) : true,
      relationalFinancialsDbMatched: fDb ? Boolean(fDb.matched && !fDb.error) : true,
      relationalFinancialsReadMatched: fRead ? Boolean(fRead.matched && !fRead.error) : true,
      nativeClientCalcMatched: nClient ? Boolean(nClient.matched && !nClient.error) : true,
      nativeMasterCompMatched: nMaster ? Boolean(nMaster.matched && !nMaster.error) : true,
      nativeConnectorsMatched: nConn ? Boolean(nConn.matched && !nConn.error) : true,
      nativeSyncMatched: nSync ? Boolean(nSync.matched && !nSync.error) : true,
      accountingInvariantsMatched: inv ? Boolean(inv.matched && !inv.error) : true,
      totalMismatchCount,
      sampleMismatches,
    };
  });

  if (Array.isArray(zeroGridHealth?.platformIssues) && zeroGridHealth.platformIssues.length > 0) {
    mergedResults.push({
      clientName: "System (platform health)",
      dashboardMismatchCount: 0,
      cashMismatchCount: 0,
      relationalMismatchCount: zeroGridHealth.platformIssues.length,
      totalMismatchCount: zeroGridHealth.platformIssues.length,
      sampleMismatches: zeroGridHealth.platformIssues.slice(0, 12),
      error: null,
    });
  }

  const errorClientsCount = mergedResults.filter((r) => Boolean(r.error || r.lastError)).length;
  const mismatchClientsCount = mergedResults.filter((r) => !r.error && r.totalMismatchCount > 0).length;
  const matchedClientsCount = mergedResults.filter((r) => !r.error && !r.lastError && r.totalMismatchCount === 0).length;

  return {
    ...sheetReport,
    clientsChecked: mergedResults.length,
    matchedClientsCount,
    mismatchClientsCount,
    errorClientsCount,
    results: mergedResults,
  };
}

function buildParityFingerprint_(row) {
  if (row?.error) {
    return `read_error:${String(row.error).slice(0, 120)}`;
  }
  const samples = Array.isArray(row?.sampleMismatches) ? row.sampleMismatches : [];
  const parts = samples
    .map((m) => `${m.tab || ""}:${m.cell || ""}:${m.rowLabel || ""}:${m.colLabel || ""}:${m.sheetValue}->${m.supabaseValue}`)
    .sort();
  return `${row?.dashboardMismatchCount || 0}:${row?.cashMismatchCount || 0}:${row?.relationalMismatchCount || 0}|${parts.join("|")}`.slice(0, 500);
}

function buildParityAlertHtml_({ flaggedClients, checkedAt, clientsChecked, appUrl }) {
  const clientCards = flaggedClients
    .map((c) => {
      const counts = [];
      if (c.dashboardMismatchCount > 0) counts.push(`Dashboard: ${c.dashboardMismatchCount}`);
      if (c.cashMismatchCount > 0) counts.push(`Cashflow: ${c.cashMismatchCount}`);
      if (c.relationalMismatchCount > 0) counts.push(`Relational: ${c.relationalMismatchCount}`);
      if (c.error) counts.push(`Read error: ${c.error}`);

      const rowsHtml = (c.sampleMismatches || [])
        .slice(0, 10)
        .map(
          (m) => `
          <tr>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#334155;">${escapeHtml(m.tab)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#0f172a;font-weight:600;">${escapeHtml(m.rowLabel || m.cell)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#475569;">${escapeHtml(m.colLabel || m.cell)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#0f172a;text-align:right;">${escapeHtml(String(m.sheetValue ?? "—"))}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#b91c1c;text-align:right;font-weight:600;">${escapeHtml(String(m.supabaseValue ?? "—"))}</td>
          </tr>`
        )
        .join("");

      const tableHtml = rowsHtml
        ? `
          <table style="width:100%;border-collapse:collapse;margin-top:10px;">
            <thead>
              <tr style="background:#f8fafc;">
                <th style="padding:6px 8px;text-align:left;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Area</th>
                <th style="padding:6px 8px;text-align:left;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Metric</th>
                <th style="padding:6px 8px;text-align:left;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Period / scope</th>
                <th style="padding:6px 8px;text-align:right;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Expected</th>
                <th style="padding:6px 8px;text-align:right;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Actual</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>`
        : "";

      const extraNote =
        (c.totalMismatchCount || 0) > (c.sampleMismatches || []).length
          ? `<div style="font-size:11px;color:#64748b;margin-top:6px;">Showing ${(c.sampleMismatches || []).length} of ${c.totalMismatchCount} detected cell differences.</div>`
          : "";

      return `
        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong style="font-size:15px;color:#111827;">${escapeHtml(c.clientName)}</strong>
            <span style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:12px;padding:2px 9px;font-size:11px;font-weight:700;">
              ${escapeHtml(counts.join(" · "))}
            </span>
          </div>
          ${tableHtml}
          ${extraNote}
        </div>`;
    })
    .join("");

  return `
    <div style="font-family:'Kumbh Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:660px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:10px;color:#1f2937;">
      <div style="background:#1a1a2e;color:#ffffff;padding:18px 24px;border-radius:8px 8px 0 0;">
        <div style="font-size:16px;font-weight:700;">Pulse parity check</div>
        <div style="font-size:12px;color:#94a3b8;">Hourly sheet and relational parity alert · ${escapeHtml(checkedAt)}</div>
      </div>
      <div style="background:#f3f4f6;padding:20px 24px;border:1px solid #e5e7eb;border-top:none;">
        <p style="font-size:14px;color:#374151;line-height:1.5;margin-top:0;">
          The hourly parity check scanned ${clientsChecked} active client${clientsChecked === 1 ? "" : "s"} and found new sheet or relational disparities on ${flaggedClients.length} client${flaggedClients.length === 1 ? "" : "s"}.
        </p>
        ${clientCards}
        <div style="text-align:center;margin:24px 0 10px 0;">
          <a href="${appUrl}/pma" target="_blank" style="background:#0066cc;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 24px;border-radius:6px;display:inline-block;">
            Open Pulse Management Area
          </a>
        </div>
      </div>
    </div>`;
}

/**
 * Runs the hourly Dashboard + Year0Data + Cashflow + Relational DB/API read parity check across all active clients
 * (both live Google Sheet bridge and pure-Supabase tenants) and emails Paul once per new disparity fingerprint.
 */
export async function checkAndNotifyClientParity({
  recipientOverride,
  dryRunEmail = false,
  parityReportOverride = null,
  resetBaselines = false,
  persistState = null,
} = {}) {
  const sb = getSupabaseAdmin();
  const report = parityReportOverride || await runFullActiveClientsParityCheck_();

  const nowIso = report?.checkedAt || new Date().toISOString();
  let prevState = { clients: {}, transientErrors: {}, baselines: {} };
  if (sb) {
    try {
      const { data: cfgRow } = await sb
        .from("system_config")
        .select("value")
        .eq("key", "client_parity_monitor_state")
        .maybeSingle();
      if (cfgRow?.value && typeof cfgRow.value === "object") {
        prevState = {
          ...cfgRow.value,
          clients: { ...(cfgRow.value.clients || {}) },
          transientErrors: { ...(cfgRow.value.transientErrors || {}) },
          baselines: { ...(cfgRow.value.baselines || {}) },
        };
      }
    } catch (err) {
      console.warn("[checkAndNotifyClientParity] Failed reading state:", err.message);
    }
  }

  const nextClients = { ...(prevState.clients || {}) };
  const nextTransientErrors = { ...(prevState.transientErrors || {}) };
  const nextBaselines = { ...(prevState.baselines || {}) };
  const newlyFlagged = [];

  const evalResults = [];
  for (const row of report?.results || []) {
    const name = row?.clientName;
    if (!name) continue;

    // Anomaly guard: compare live counts against stored per-client baselines
    const curMetrics = row.liveMetrics || null;
    const prevBase = prevState.baselines?.[name] || null;
    const anomalyDiffs = [];
    const nextClientBase = curMetrics ? { ...curMetrics } : prevBase ? { ...prevBase } : null;

    if (curMetrics && prevBase && !resetBaselines && !row.error) {
      const checkDrop = (field, label, minRatioDrop, minAbsDrop) => {
        const prevVal = Number(prevBase[field]) || 0;
        const curVal = Number(curMetrics[field]) || 0;
        if (prevVal <= 0) return false;
        const drop = prevVal - curVal;
        const wipedToZero = prevVal >= 5 && curVal === 0;
        const largeDrop = drop >= minAbsDrop && drop / prevVal >= minRatioDrop;
        if (wipedToZero || largeDrop) {
          anomalyDiffs.push({
            tab: "Anomaly guard",
            cell: field,
            rowLabel: label,
            colLabel: "Previous vs current",
            sheetValue: String(prevVal),
            supabaseValue: String(curVal),
          });
          // Keep higher baseline latched until restored or reset
          nextClientBase[field] = prevVal;
          return true;
        }
        return false;
      };

      checkDrop("outgoingsNotesCount", "Outgoings notes count", 0.5, 5);
      checkDrop("confirmedNotesCount", "Confirmed notes count", 0.5, 5);
      checkDrop("contractorEntriesCount", "Contractor entries count", 0.5, 5);
      checkDrop("confirmedJobsCount", "Confirmed jobs count", 0.25, 5);

      for (const [discField, discLabel] of [
        ["dirDiscrepancies", "Contractor cost discrepancies"],
        ["invDiscrepancies", "Invoice discrepancies"],
      ]) {
        const prevVal = Number(prevBase[discField]) || 0;
        const curVal = Number(curMetrics[discField]) || 0;
        if (curVal - prevVal >= 15) {
          anomalyDiffs.push({
            tab: "Anomaly guard",
            cell: discField,
            rowLabel: discLabel,
            colLabel: "Previous vs current",
            sheetValue: String(prevVal),
            supabaseValue: String(curVal),
          });
        }
      }
    }

    if (nextClientBase) {
      nextBaselines[name] = nextClientBase;
    }

    const enrichedRow = anomalyDiffs.length > 0
      ? {
          ...row,
          relationalMismatchCount: (row.relationalMismatchCount || 0) + anomalyDiffs.length,
          totalMismatchCount: (row.totalMismatchCount || 0) + anomalyDiffs.length,
          sampleMismatches: [...anomalyDiffs, ...(row.sampleMismatches || [])].slice(0, 12),
        }
      : row;
    evalResults.push(enrichedRow);

    if (enrichedRow.error) {
      const failCount = (Number(nextTransientErrors[name]) || 0) + 1;
      nextTransientErrors[name] = failCount;
      // Only notify on persistent read failures (2+ consecutive hourly runs) to avoid single transient API blips
      if (failCount >= 2) {
        const fp = buildParityFingerprint_(enrichedRow);
        if (nextClients[name]?.fingerprint !== fp) {
          newlyFlagged.push(enrichedRow);
          nextClients[name] = {
            fingerprint: fp,
            notifiedAt: nowIso,
            error: enrichedRow.error,
          };
        }
      }
      continue;
    }

    delete nextTransientErrors[name];

    if ((enrichedRow.totalMismatchCount || 0) > 0) {
      const fp = buildParityFingerprint_(enrichedRow);
      if (nextClients[name]?.fingerprint !== fp) {
        newlyFlagged.push(enrichedRow);
        nextClients[name] = {
          fingerprint: fp,
          notifiedAt: nowIso,
          totalMismatchCount: enrichedRow.totalMismatchCount,
          dashboardMismatchCount: enrichedRow.dashboardMismatchCount,
          cashMismatchCount: enrichedRow.cashMismatchCount,
          relationalMismatchCount: enrichedRow.relationalMismatchCount || 0,
          sampleMismatches: enrichedRow.sampleMismatches || [],
        };
      }
    } else if (nextClients[name]) {
      delete nextClients[name];
    }
  }

  const hasPlatformRow = evalResults.some((r) => r?.clientName === "System (platform health)");
  if (!hasPlatformRow && nextClients["System (platform health)"]) {
    delete nextClients["System (platform health)"];
  }

  const finalErrorClientsCount = evalResults.filter((r) => Boolean(r.error || r.lastError)).length;
  const finalMismatchClientsCount = evalResults.filter((r) => !r.error && (r.totalMismatchCount || 0) > 0).length;
  const finalMatchedClientsCount = evalResults.filter((r) => !r.error && !r.lastError && (r.totalMismatchCount || 0) === 0).length;

  const shouldPersistState = persistState !== null ? Boolean(persistState) : !dryRunEmail;
  if (sb && shouldPersistState) {
    try {
      await sb.from("system_config").upsert({
        key: "client_parity_monitor_state",
        value: {
          lastCheckedAt: nowIso,
          clientsChecked: evalResults.length,
          matchedClientsCount: finalMatchedClientsCount,
          mismatchClientsCount: finalMismatchClientsCount,
          clients: nextClients,
          transientErrors: nextTransientErrors,
          baselines: nextBaselines,
        },
        description: "Hourly Dashboard, Cashflow, and zero-grid health/parity monitor state",
        updated_by: "System (Cron)",
      });
    } catch (err) {
      console.warn("[checkAndNotifyClientParity] Failed persisting state:", err.message);
    }
  }

  let emailed = false;
  let emailSubject = "";
  let emailHtml = "";
  let emailText = "";

  if (newlyFlagged.length > 0) {
    const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
    const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;
    const appUrl = process.env.APP_BASE_URL || "https://app.pulsedashboard.co.uk";
    const recipient = recipientOverride || process.env.DAILY_ALERTS_RECIPIENT || "paul@gothrive.uk";

    emailSubject = `Pulse parity check: disparities detected (${newlyFlagged.length} client${newlyFlagged.length === 1 ? "" : "s"})`;
    emailHtml = buildParityAlertHtml_({
      flaggedClients: newlyFlagged,
      checkedAt: nowIso,
      clientsChecked: report?.clientsChecked || 0,
      appUrl,
    });
    emailText =
      `Pulse parity check scanned ${report?.clientsChecked || 0} client(s) at ${nowIso} and detected disparities on ${newlyFlagged.length} client(s):\n\n` +
      newlyFlagged
        .map((c) => {
          const header = `${c.clientName} (Dashboard: ${c.dashboardMismatchCount || 0}, Cashflow: ${c.cashMismatchCount || 0}, Relational: ${c.relationalMismatchCount || 0}${c.error ? `, Error: ${c.error}` : ""})`;
          const lines = (c.sampleMismatches || [])
            .slice(0, 10)
            .map((m) => `  - ${m.tab} | ${m.rowLabel || m.cell} | ${m.colLabel || m.cell}: Expected=${m.sheetValue} vs Actual=${m.supabaseValue}`);
          return [header, ...lines].join("\n");
        })
        .join("\n\n") +
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
      console.log(`CRON: Sent parity alert "${emailSubject}" to ${recipient}`);
      const sheets = await getSheetsClient().catch(() => null);
      const acId = getCanonicalAcSheetId();
      await logPmaActivity(sheets, {
        automationCommanderSheetId: acId,
        user: "Pulse System",
        action: "Parity Disparity Alert Sent",
        summary: `${emailSubject}: ${newlyFlagged.map((c) => c.clientName).join(", ")}`,
      }).catch(() => { });
    }
  }

  return {
    success: true,
    ...report,
    clientsChecked: evalResults.length,
    matchedClientsCount: finalMatchedClientsCount,
    mismatchClientsCount: finalMismatchClientsCount,
    errorClientsCount: finalErrorClientsCount,
    results: evalResults,
    newlyFlaggedCount: newlyFlagged.length,
    flaggedClients: newlyFlagged.map((c) => c.clientName),
    emailed,
    emailSubject,
    emailHtml,
    emailText,
  };
}
