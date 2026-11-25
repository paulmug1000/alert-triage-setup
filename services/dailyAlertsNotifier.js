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
import { flushPendingClientRecomputes } from "./masterEngineService.js";

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
  const supabaseErrorGrids = new Map();
  const supaClientNames = clientList.filter((c) => c.clientMode === "supabase").map((c) => c.clientName);
  if (sb && supaClientNames.length > 0) {
    try {
      const { data: ecRows } = await sb
        .from("master_sheet_grids")
        .select("client_name, values_grid")
        .eq("tab_name", "ErrorCheck")
        .eq("sheet_role", "client")
        .in("client_name", supaClientNames);
      for (const row of ecRows || []) {
        if (row.client_name && Array.isArray(row.values_grid)) {
          supabaseErrorGrids.set(String(row.client_name).trim().toLowerCase(), row.values_grid);
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

async function runFullActiveClientsParityCheck_() {
  const [phase4Schema, phase4ReconSchema, phase5FinSchema] = await Promise.all([
    checkPhase4MasterSchemaStatus().catch(() => ({ schemaReady: false })),
    checkPhase4ReconSchemaStatus().catch(() => ({ schemaReady: false })),
    checkPhase5FinancialsSchemaStatus().catch(() => ({ schemaReady: false })),
  ]);
  const phase4Ready = Boolean(phase4Schema?.schemaReady);
  const phase4ReconReady = Boolean(phase4ReconSchema?.schemaReady);
  const phase5FinReady = Boolean(phase5FinSchema?.schemaReady);

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
  ] = await Promise.all([
    verifyBridgedClientsParity({
      includePureSupabase: true,
      settleOnMismatch: true,
      skipRelationalSummary: true,
    }),
    verifyRelationalJobsParity({ source: "db" }),
    verifyRelationalInputsParity({ source: "db" }),
    verifyRelationalJobsReadParity(),
    verifyRelationalInputsReadParity(),
    phase4Ready
      ? verifyRelationalMasterParity({ source: "db", onlyIngestionEnabled: true }).catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),
    phase4Ready
      ? verifyRelationalMasterReadParity({ source: "db", onlyReadEnabled: true }).catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),
    phase4ReconReady
      ? verifyRelationalReconParity({ source: "db", onlyReconEnabled: true }).catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),
    phase4ReconReady
      ? verifyRelationalReconReadParity({ source: "db", onlyReadEnabled: true }).catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),
    phase5FinReady
      ? verifyRelationalFinancialsParity({ source: "db", onlyFinancialsEnabled: true }).catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),
    phase5FinReady
      ? verifyRelationalFinancialsReadParity({ source: "db", onlyReadEnabled: true }).catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),
  ]);

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
      (fRead && (fRead.error || !fRead.matched));
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

    const combinedError = row.error || (relErrors.length > 0 ? relErrors.join("; ") : null);
    const totalMismatchCount = (row.dashboardMismatchCount || 0) + (row.cashMismatchCount || 0) + relationalMismatchCount;
    const sampleMismatches = [...(row.sampleMismatches || []).slice(0, 5), ...relDiffs.slice(0, 8)].slice(0, 12);

    return {
      ...row,
      error: combinedError,
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
      totalMismatchCount,
      sampleMismatches,
    };
  });

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
} = {}) {
  const sb = getSupabaseAdmin();
  const report = parityReportOverride || await runFullActiveClientsParityCheck_();

  const nowIso = report?.checkedAt || new Date().toISOString();
  let prevState = { clients: {}, transientErrors: {} };
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
        };
      }
    } catch (err) {
      console.warn("[checkAndNotifyClientParity] Failed reading state:", err.message);
    }
  }

  const nextClients = { ...(prevState.clients || {}) };
  const nextTransientErrors = { ...(prevState.transientErrors || {}) };
  const newlyFlagged = [];

  for (const row of report?.results || []) {
    const name = row?.clientName;
    if (!name) continue;

    if (row.error) {
      const failCount = (Number(nextTransientErrors[name]) || 0) + 1;
      nextTransientErrors[name] = failCount;
      // Only notify on persistent read failures (2+ consecutive hourly runs) to avoid single transient API blips
      if (failCount >= 2) {
        const fp = buildParityFingerprint_(row);
        if (nextClients[name]?.fingerprint !== fp) {
          newlyFlagged.push(row);
          nextClients[name] = {
            fingerprint: fp,
            notifiedAt: nowIso,
            error: row.error,
          };
        }
      }
      continue;
    }

    delete nextTransientErrors[name];

    if ((row.totalMismatchCount || 0) > 0) {
      const fp = buildParityFingerprint_(row);
      if (nextClients[name]?.fingerprint !== fp) {
        newlyFlagged.push(row);
        nextClients[name] = {
          fingerprint: fp,
          notifiedAt: nowIso,
          totalMismatchCount: row.totalMismatchCount,
          dashboardMismatchCount: row.dashboardMismatchCount,
          cashMismatchCount: row.cashMismatchCount,
          relationalMismatchCount: row.relationalMismatchCount || 0,
          sampleMismatches: row.sampleMismatches || [],
        };
      }
    } else if (nextClients[name]) {
      delete nextClients[name];
    }
  }

  if (sb && !dryRunEmail) {
    try {
      await sb.from("system_config").upsert({
        key: "client_parity_monitor_state",
        value: {
          lastCheckedAt: nowIso,
          clientsChecked: report?.clientsChecked || 0,
          matchedClientsCount: report?.matchedClientsCount || 0,
          mismatchClientsCount: report?.mismatchClientsCount || 0,
          clients: nextClients,
          transientErrors: nextTransientErrors,
        },
        description: "Hourly Dashboard and Cashflow parity monitor deduplication state",
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
    newlyFlaggedCount: newlyFlagged.length,
    flaggedClients: newlyFlagged.map((c) => c.clientName),
    emailed,
    emailSubject,
    emailHtml,
    emailText,
  };
}
