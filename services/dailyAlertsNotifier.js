import nodemailer from "nodemailer";
import { getAllUsers } from "./userPermissions.js";
import { readAlertMemory, ensureAlertMemoryTab } from "./alertMemory.js";
import { redisClient } from "./redisClient.js";
const PRECOMPUTED_KEY = "triage_precomputed";
import { matchesClientName } from "../utils/helpers.js";
import { logPmaActivity } from "./pmaLogger.js";

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

    const alertBullets = (cs.alerts || []).slice(0, 4).map(a =>
      `<li style="margin-bottom:4px;color:#4b5563;font-size:13px;line-height:1.4;">${a.summary}</li>`
    ).join("");

    const moreNotice = (cs.alerts || []).length > 4
      ? `<div style="font-size:12px;color:#9ca3af;margin-top:4px;font-style:italic;">+ ${cs.alerts.length - 4} more alert${cs.alerts.length - 4 > 1 ? "s" : ""} in Pulse</div>`
      : "";

    return `
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px 18px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong style="font-size:15px;color:#111827;">${cs.clientName}</strong>
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
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:620px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:10px;color:#1f2937;">
      <!-- Header -->
      <div style="background:#1a1a2e;color:#ffffff;padding:18px 24px;border-radius:8px 8px 0 0;display:flex;align-items:center;gap:12px;">
        <div style="width:28px;height:28px;background:#0066cc;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:#ffffff;line-height:28px;text-align:center;">P</div>
        <div>
          <div style="font-size:16px;font-weight:700;letter-spacing:0.3px;">Pulse Management App</div>
          <div style="font-size:12px;color:#94a3b8;">Daily Alerts Digest - ${formattedDate}</div>
        </div>
      </div>

      <!-- Main Container -->
      <div style="background:#f3f4f6;padding:20px 24px;border:1px solid #e5e7eb;border-top:none;">
        <p style="font-size:15px;line-height:1.5;margin-top:0;margin-bottom:14px;">
          Hello ${user.name || "there"},
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
          <a href="${appUrl}" target="_blank" style="background:#0066cc;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 28px;border-radius:6px;display:inline-block;box-shadow:0 2px 4px rgba(0,102,204,0.2);">
            Open Pulse Management App &rarr;
          </a>
        </div>
      </div>

      <!-- Footer -->
      <div style="padding:16px 20px;font-size:11px;color:#9ca3af;line-height:1.6;text-align:center;">
        <p style="margin:0 0 4px 0;">
          You are receiving this summary because you have notifications enabled in the Pulse Management App.
        </p>
        <p style="margin:0 0 6px 0;">
          To stop receiving this email, set <strong>Daily Alerts Email</strong> to <strong>No</strong> in the <strong>Users</strong> tab.
        </p>
        <p style="margin:0;">
          &copy; ${new Date().getFullYear()} Thrive Organisational Consulting Ltd. Automated message &mdash; please do not reply.
        </p>
      </div>
    </div>
  `;
}

/**
 * Core Orchestrator: Sends daily alert digests to eligible active users
 */
export async function sendDailyAlertsSummary(sheets, automationCommanderSheetId) {
  const acId = automationCommanderSheetId;
  const formattedDate = getFormattedDigestDate();
  const subject = `Pulse Management App Daily Digest - ${formattedDate}`;

  console.log(`\n📬 Daily Alerts Notifier starting for ${formattedDate}...`);

  // 1. Fetch all users from Users tab (bypassing Redis to ensure live opt-in status)
  const users = await getAllUsers(sheets, acId, true);
  const eligibleUsers = (users || []).filter(u =>
    u.status === "Active" &&
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

  // 3. Setup Email Transport
  const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
  const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;
  const appUrl = process.env.APP_BASE_URL || "https://project-shj9n.vercel.app";

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

  // 4. Process each eligible user
  for (const user of eligibleUsers) {
    const isGlobal = user.role === "Admin" || user.assignedClients === "*";
    const assignedList = Array.isArray(user.assignedClients) ? user.assignedClients : [];

    // Filter alerts to this user's authorized clients
    const userAlerts = allAlerts.filter(a => {
      if (!a.clientName) return false;
      if (isGlobal) return true;
      return assignedList.some(assigned => matchesClientName(assigned, a.clientName));
    });

    // Requirement #1: If user has 0 alerts, skip completely
    if (userAlerts.length === 0) {
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

      const summaryText = alert.summary || alert.alertSummary || (typeof alert.dataSnapshot === "string" ? alert.dataSnapshot.slice(0, 100) : "");
      if (summaryText) cm.alerts.push({ summary: summaryText });
    }

    const clientSummaries = Object.values(clientMap).sort((a, b) => b.totalClientAlerts - a.totalClientAlerts);
    const htmlBody = buildDigestHtml({
      user,
      formattedDate,
      totalAlerts: userAlerts.length,
      clientSummaries,
      appUrl
    });

    const textBody = `Hello ${user.name || "there"},\n\n` +
      `Here is your Pulse Management App daily summary for ${formattedDate}:\n` +
      `Total active alerts: ${userAlerts.length} across ${clientSummaries.length} clients.\n\n` +
      clientSummaries.map(cs => `• ${cs.clientName}: ${cs.totalClientAlerts} alert(s)`).join("\n") +
      `\n\nOpen Pulse Management App: ${appUrl}\n\n` +
      `To opt out of daily summaries, set 'Daily Alerts Email' to 'No' in the Users tab.`;

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

        await logPmaActivity(sheets, acId, {
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
