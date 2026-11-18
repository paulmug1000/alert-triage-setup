/**
 * ============================================================================
 * SETUP CLIENT INVITE API: /api/setup/client-invite
 * ============================================================================
 *
 * POST:
 * - action = "create_client_user": Adds/updates the client contact as a ClientUser
 *   assigned to the newly provisioned client.
 * - action = "send_connection_email": Sends the tool-connection request email
 *   from pulse@pulsedashboard.co.uk.
 */

import nodemailer from "nodemailer";
import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  getAllUsers,
  createOrUpdateUser,
  matchesClientName,
  getCanonicalAcSheetId,
} from "../../../services/userPermissions.js";
import { logPmaActivity } from "../../../services/pmaLogger.js";
import { assertTrustedOrigin } from "../../../utils/helpers.js";

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPlainTextToHtml(text) {
  const paragraphs = String(text || "").split(/\r?\n\r?\n/);
  const rendered = paragraphs
    .map((para) => {
      const escaped = escapeHtml(para.trim());
      if (!escaped) return "";
      const withLinks = escaped
        .replace(
          /(https?:\/\/[^\s<]+)/g,
          '<a href="$1" style="color: #023f98; font-weight: 600; text-decoration: underline;">$1</a>'
        )
        .replace(/\r?\n/g, "<br>");
      return `<p style="margin: 0 0 14px 0; font-size: 14px; line-height: 1.6; color: #1e293b;">${withLinks}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b;">
      ${rendered}
    </div>
  `;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = getSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (sessionUser.isReadOnly || (!sessionUser.isAdmin && sessionUser.role !== "Admin")) {
    return res.status(403).json({ success: false, error: "Only administrators can manage onboarding invites." });
  }

  const { action } = req.body || {};

  try {
    const sheets = await getSheetsClient().catch(() => null);

    if (action === "create_client_user") {
      const clientName = String(req.body?.clientName || "").trim();
      const contactName = String(req.body?.contactName || "").trim();
      const contactEmail = String(req.body?.contactEmail || "").toLowerCase().trim();

      if (!clientName) {
        return res.status(400).json({ success: false, error: "Client name is required." });
      }
      if (!contactName) {
        return res.status(400).json({ success: false, error: "Client contact name is required." });
      }
      if (!contactEmail || !contactEmail.includes("@")) {
        return res.status(400).json({ success: false, error: "Please enter a valid client email address." });
      }

      const acId = getCanonicalAcSheetId();
      const existingUsers = await getAllUsers(sheets, acId, true).catch(() => []);
      const existing = existingUsers.find((u) => u.email === contactEmail);

      let targetRole = "ClientUser";
      let targetClients = [clientName];

      if (existing) {
        if (existing.role === "Admin") {
          targetRole = "Admin";
          targetClients = ["*"];
        } else {
          targetRole = existing.role || "ClientUser";
          const currentList = Array.isArray(existing.assignedClients)
            ? existing.assignedClients.filter((c) => c && c !== "*")
            : [];
          const alreadyHasClient = currentList.some((c) => matchesClientName(c, clientName));
          targetClients = alreadyHasClient ? currentList : [...currentList, clientName];
        }
      }

      const savedUser = await createOrUpdateUser(sheets, {
        email: contactEmail,
        name: contactName,
        role: targetRole,
        assignedClients: targetClients,
        status: existing?.status || "Active",
        dailyAlertsEmail: existing?.dailyAlertsEmail || "Yes",
      });

      logPmaActivity({
        action: "setup_client_user_added",
        details: `Added client user "${contactName}" (${contactEmail}) assigned to "${clientName}"`,
        clientName,
        userEmail: sessionUser.email || "Admin",
      }).catch(() => {});

      return res.status(200).json({ success: true, user: savedUser });
    }

    if (action === "send_connection_email") {
      const clientName = String(req.body?.clientName || "").trim();
      const toEmail = String(req.body?.toEmail || "").toLowerCase().trim();
      const subject = String(req.body?.subject || "").trim();
      const body = String(req.body?.body || "").trim();

      if (!toEmail || !toEmail.includes("@")) {
        return res.status(400).json({ success: false, error: "Please enter a valid recipient email address." });
      }
      if (!subject) {
        return res.status(400).json({ success: false, error: "Email subject is required." });
      }
      if (!body) {
        return res.status(400).json({ success: false, error: "Email message body is required." });
      }

      const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
      const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;

      if (!emailPass) {
        return res.status(500).json({
          success: false,
          error: "Email sending is not configured on this environment (missing PMA_EMAIL_APP_PASSWORD).",
        });
      }

      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {
          user: emailUser,
          pass: emailPass,
        },
      });

      await transporter.sendMail({
        from: `"The Pulse Team" <${emailUser}>`,
        replyTo: emailUser,
        to: toEmail,
        subject,
        text: body,
        html: formatPlainTextToHtml(body),
      });

      logPmaActivity({
        action: "setup_connection_email_sent",
        details: `Sent tool connection setup email to ${toEmail} from ${emailUser}`,
        clientName,
        userEmail: sessionUser.email || "Admin",
      }).catch(() => {});

      return res.status(200).json({ success: true, sentTo: toEmail, sentFrom: emailUser });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("POST /api/setup/client-invite error:", err);
    return res.status(500).json({ success: false, error: err.message || "Internal server error." });
  }
}
