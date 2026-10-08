/**
 * ============================================================================
 * CONNECTION NOTIFIER SERVICE: services/connectionNotifier.js
 * ============================================================================
 * 
 * Sends an email notification to all active Admins and the assigned Client Manager
 * whenever a client tool connection (Accounting or CRM) is authorised.
 */

import nodemailer from "nodemailer";
import { getSheetsClient } from "./sheetsClient.js";
import { getAllUsers, matchesClientName, DEFAULT_AC_SHEET_ID } from "./userPermissions.js";
import { getClientSetupStatusForPortal } from "./setupService.js";
import { logPmaActivity } from "./pmaLogger.js";

const TOOL_NAMES = {
  xero: "Xero",
  quickbooks: "QuickBooks Online",
  capsule: "Capsule CRM",
  clickup: "ClickUp",
  close: "Close CRM",
  hubspot: "HubSpot",
  monday: "Monday.com",
  pipedrive: "Pipedrive"
};

function getToolDisplayName(tool) {
  const key = String(tool || "").toLowerCase().trim();
  return TOOL_NAMES[key] || tool || "Integration";
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
 * Notifies all active Admins and the client's assigned Client Manager
 * of a successful tool authorization.
 */
export async function notifyStaffOnClientConnection({
  clientName,
  tool,
  tenantName = "",
  masterSheetId = "",
  authorizerEmail = "",
  mode = "dedicated"
}) {
  if (!clientName || !tool) {
    console.warn("⚠️ notifyStaffOnClientConnection missing clientName or tool");
    return { success: false, error: "Missing required parameters" };
  }

  const toolDisplayName = getToolDisplayName(tool);
  const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
  const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;
  const appUrl = process.env.APP_BASE_URL || "https://app.pulsedashboard.co.uk";

  let sheets = null;
  let allUsers = [];

  try {
    sheets = await getSheetsClient();
    allUsers = await getAllUsers(sheets, DEFAULT_AC_SHEET_ID, false);
  } catch (err) {
    console.error("⚠️ Failed to load users for connection alert:", err.message);
  }

  // 1. Identify active Admins
  const activeAdmins = (allUsers || []).filter(
    (u) => u.status === "Active" && Boolean(u.isAdmin) && u.email && u.email.includes("@")
  );

  // 2. Identify active Client Managers assigned to this client
  const activeManagers = (allUsers || []).filter((u) => {
    if (u.status !== "Active" || u.role !== "ClientManager" || !u.email || !u.email.includes("@")) {
      return false;
    }
    if (u.assignedClients === "*") return true;
    if (Array.isArray(u.assignedClients)) {
      return u.assignedClients.some((assigned) => matchesClientName(assigned, clientName));
    }
    return false;
  });

  // 3. Deduplicate recipients
  const recipientMap = new Map();
  for (const admin of activeAdmins) {
    recipientMap.set(admin.email.toLowerCase().trim(), { email: admin.email, name: admin.name || "Admin", role: "Admin" });
  }
  for (const manager of activeManagers) {
    const key = manager.email.toLowerCase().trim();
    if (!recipientMap.has(key)) {
      recipientMap.set(key, { email: manager.email, name: manager.name || "Client Manager", role: "Client Manager" });
    }
  }

  const recipientList = Array.from(recipientMap.values());
  const recipientEmails = recipientList.map((r) => r.email);

  if (recipientEmails.length === 0) {
    console.warn(`⚠️ No active Admins or Client Managers found to notify for client "${clientName}".`);
    return { success: false, reason: "No eligible recipients found." };
  }

  // 4. Inspect overall client setup health (if available)
  let setupHealth = null;
  try {
    setupHealth = await getClientSetupStatusForPortal({ clientName, masterSheetId });
  } catch (healthErr) {
    console.warn("⚠️ Setup status lookup note:", healthErr.message);
  }

  const allConnected = setupHealth?.allToolsConnected === true;
  const remainingTools = (setupHealth?.unconnectedTools || [])
    .filter((t) => String(t.tool).toLowerCase() !== String(tool).toLowerCase())
    .map((t) => getToolDisplayName(t.tool));

  // 5. Format UK timestamp
  const nowFormatted = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London"
  }).format(new Date());

  const subject = `[Pulse] Connection Authorised: ${clientName} connected ${toolDisplayName}`;

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
        .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        .header { background: #0047AB; padding: 24px 32px; color: #ffffff; }
        .content { padding: 32px; }
        .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
        .detail-label { color: #64748b; font-weight: 500; }
        .detail-value { color: #0f172a; font-weight: 600; text-align: right; }
        .badge-success { display: inline-block; background: #dcfce7; color: #15803d; border: 1px solid #86efac; border-radius: 20px; padding: 3px 10px; font-size: 12px; font-weight: 700; }
        .status-box { padding: 14px 16px; border-radius: 8px; margin: 20px 0; font-size: 13px; line-height: 1.5; }
        .status-complete { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
        .status-pending { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
        .button { display: inline-block; background: #0047AB; color: #ffffff !important; padding: 12px 24px; border-radius: 8px; font-weight: 600; text-decoration: none; font-size: 14px; margin-top: 10px; }
        .footer { padding: 20px 32px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; opacity: 0.85; margin-bottom: 6px;">
            Integration Update
          </div>
          <h1 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.3px;">
            Tool Connection Authorised
          </h1>
        </div>
        <div class="content">
          <p style="font-size: 15px; line-height: 1.6; margin: 0 0 20px 0; color: #334155;">
            A new third-party integration has been successfully authorised for <strong>${escapeHtml(clientName)}</strong>.
          </p>

          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 16px; margin-bottom: 20px;">
            <div class="detail-row">
              <span class="detail-label">Client</span>
              <span class="detail-value">${escapeHtml(clientName)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Tool</span>
              <span class="detail-value">
                <span class="badge-success">✓ ${escapeHtml(toolDisplayName)}</span>
              </span>
            </div>
            ${tenantName ? `
            <div class="detail-row">
              <span class="detail-label">Organisation / Account</span>
              <span class="detail-value">${escapeHtml(tenantName)}</span>
            </div>
            ` : ""}
            <div class="detail-row" style="border-bottom: none;">
              <span class="detail-label">Authorised At</span>
              <span class="detail-value">${escapeHtml(nowFormatted)}</span>
            </div>
          </div>

          ${allConnected ? `
            <div class="status-box status-complete">
              <strong>✓ Setup Complete:</strong> All required tool connections for <strong>${escapeHtml(clientName)}</strong> are now active and ready for sync.
            </div>
          ` : remainingTools.length > 0 ? `
            <div class="status-box status-pending">
              <strong>⏳ Setup Still in Progress:</strong> Remaining integration pending connection: <strong>${escapeHtml(remainingTools.join(", "))}</strong>.
            </div>
          ` : ""}

          <div style="text-align: center; margin-top: 24px;">
            <a href="${appUrl}/PMA?nav=integrations&client=${encodeURIComponent(clientName)}" class="button">
              View in Pulse Management Area →
            </a>
          </div>
        </div>
        <div class="footer">
          <div>Pulse Ecosystem • Automated Integrations Notification</div>
          <div style="margin-top: 4px;">Sent to Admins and assigned Client Managers for ${escapeHtml(clientName)}.</div>
        </div>
      </div>
    </body>
    </html>
  `;

  const textBody = `
[Pulse] Tool Connection Authorised
----------------------------------
A new third-party integration has been authorised for ${clientName}.

Client: ${clientName}
Tool: ${toolDisplayName}
${tenantName ? `Organisation: ${tenantName}\n` : ""}Authorised At: ${nowFormatted}
${allConnected ? "Status: All required tool connections for this client are now active.\n" : remainingTools.length > 0 ? `Status: Remaining pending connection: ${remainingTools.join(", ")}\n` : ""}
View in Pulse Management Area:
${appUrl}/PMA?nav=integrations&client=${encodeURIComponent(clientName)}
  `.trim();

  if (!emailPass) {
    console.warn("⚠️ PMA_EMAIL_APP_PASSWORD not set. Simulating connection alert email for:", recipientEmails);
    return { success: true, simulated: true, recipients: recipientEmails };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: emailUser,
        pass: emailPass
      }
    });

    await transporter.sendMail({
      from: `"Pulse Notifications" <${emailUser}>`,
      to: recipientEmails.join(", "),
      subject,
      text: textBody,
      html: htmlBody
    });

    console.log(`📧 Sent connection notification email to ${recipientEmails.length} staff (${recipientEmails.join(", ")}) for ${clientName} [${toolDisplayName}].`);

    if (sheets) {
      logPmaActivity({
        action: "INTEGRATION_AUTH_NOTIFIED",
        clientName,
        details: `Notified ${recipientEmails.length} staff of ${toolDisplayName} connection (${recipientEmails.join(", ")})`,
        status: "SUCCESS"
      }, sheets).catch(() => {});
    }

    return { success: true, recipients: recipientEmails };
  } catch (sendErr) {
    console.error("❌ Failed to send connection alert email:", sendErr.message);
    return { success: false, error: sendErr.message };
  }
}
