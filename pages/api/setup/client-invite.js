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
import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  getAllUsers,
  createOrUpdateUser,
  matchesClientName,
  getCanonicalAcSheetId,
  canAccessPma,
  isUserAuthorizedForClient,
  assertSetupClientSheetBinding,
} from "../../../services/userPermissions.js";
import {
  updateClientChecklistTask,
  getClientSetupConfig,
  saveClientSetupConfig,
} from "../../../services/setupService.js";
import { logPmaActivity } from "../../../services/pmaLogger.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

const SINGLE_EMAIL_REGEX = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

function isAllowedPulseUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "pulsedashboard.co.uk" || host.endsWith(".pulsedashboard.co.uk");
  } catch {
    return false;
  }
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

function formatPlainTextToHtml(text) {
  const paragraphs = String(text || "").split(/\r?\n\r?\n/);
  const rendered = paragraphs
    .map((para) => {
      const escaped = escapeHtml(para.trim());
      if (!escaped) return "";
      const withLinks = escaped
        .replace(/(https?:\/\/[^\s<]+)/g, (url) => {
          if (!isAllowedPulseUrl(url)) return url;
          return `<a href="${url}" style="color: #023f98; font-weight: 600; text-decoration: underline;">${url}</a>`;
        })
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
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  if (req.method === "POST" && !assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: Staff privileges required." });
  }

  const isSysAdmin = Boolean(!sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin"));
  const rlBucket = req.method === "GET" ? "setup-client-invite-get" : "setup-client-invite";
  const rlMax = req.method === "GET" ? 60 : 20;
  const rl = await checkRateLimit(rlBucket, sessionUser.email || getTrustedClientIp(req), rlMax, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  if (req.method === "GET") {
    const clientName = String(req.query?.clientName || "").trim();
    if (!clientName) {
      return res.status(400).json({ success: false, error: "Client name is required." });
    }
    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }
    try {
      const sheets = await getSheetsClient().catch(() => null);
      const acId = getCanonicalAcSheetId();
      const allUsers = await getAllUsers(sheets, acId, true).catch(() => []);
      const contacts = (allUsers || [])
        .filter((u) => {
          const role = String(u.role || "");
          if (["Admin", "ClientManager"].includes(role)) return false;
          if (String(u.status || "Active").toLowerCase() === "suspended") return false;
          const assigned = Array.isArray(u.assignedClients) ? u.assignedClients : [];
          return assigned.some((c) => matchesClientName(c, clientName));
        })
        .map((u) => ({
          name: String(u.name || "").trim(),
          email: String(u.email || "").toLowerCase().trim(),
          role: u.role || "ClientUser",
        }))
        .filter((u) => u.email);
      return res.status(200).json({ success: true, contacts });
    } catch (err) {
      console.error("GET /api/setup/client-invite error:", err);
      return res.status(500).json({
        success: false,
        error: isSysAdmin ? (err.message || "Failed to load client contacts.") : sanitizeSpreadsheetTerms(err.message || "Failed to load client contacts."),
      });
    }
  }

  const { action } = req.body || {};

  if (action === "create_client_user") {
    if (sessionUser.isReadOnly || (!sessionUser.isAdmin && sessionUser.role !== "Admin")) {
      return res.status(403).json({ success: false, error: "Only administrators can manage onboarding invites." });
    }
  } else if (sessionUser.isReadOnly) {
    return res.status(403).json({ success: false, error: "Read-only session cannot send onboarding emails." });
  }

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
      if (!contactEmail || !SINGLE_EMAIL_REGEX.test(contactEmail)) {
        return res.status(400).json({ success: false, error: "Please enter a valid single client email address." });
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
      const masterSheetId = String(req.body?.masterSheetId || "").trim();
      const toEmail = String(req.body?.toEmail || "").toLowerCase().trim();
      const subject = String(req.body?.subject || "").trim();
      const body = String(req.body?.body || "").trim();

      if (!clientName) {
        return res.status(400).json({ success: false, error: "Client name is required." });
      }
      if (!isSysAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
        return res.status(403).json({ success: false, error: "Access denied to this client." });
      }
      if (masterSheetId) {
        const binding = await assertSetupClientSheetBinding(sessionUser, {
          clientName,
          masterSheetId,
          sheets,
        });
        if (!binding.authorized) {
          return res.status(binding.status || 403).json({ success: false, error: binding.error || "Access denied to this client." });
        }
      }
      if (!toEmail || !SINGLE_EMAIL_REGEX.test(toEmail)) {
        return res.status(400).json({ success: false, error: "Please enter a valid single recipient email address." });
      }
      if (!isSysAdmin) {
        const acId = getCanonicalAcSheetId();
        const allUsers = await getAllUsers(sheets, acId, true).catch(() => []);
        const isAssignedContact = (allUsers || []).some((u) => {
          if (String(u.email || "").toLowerCase().trim() !== toEmail) return false;
          const role = String(u.role || "");
          if (["Admin", "ClientManager"].includes(role)) return false;
          if (String(u.status || "Active").toLowerCase() === "suspended") return false;
          const assigned = Array.isArray(u.assignedClients) ? u.assignedClients : [];
          return assigned.some((c) => matchesClientName(c, clientName));
        });
        if (!isAssignedContact) {
          return res.status(403).json({
            success: false,
            error: "Non-administrators may only send onboarding connection emails to assigned contacts for this client.",
          });
        }
      }
      if (!subject) {
        return res.status(400).json({ success: false, error: "Email subject is required." });
      }
      if (!body) {
        return res.status(400).json({ success: false, error: "Email message body is required." });
      }

      const urlsInBody = body.match(/https?:\/\/[^\s<>"')]+/gi) || [];
      if (urlsInBody.some((u) => !isAllowedPulseUrl(u))) {
        return res.status(400).json({
          success: false,
          error: "Email links must point to an HTTPS pulsedashboard.co.uk address.",
        });
      }

      const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
      const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;

      if (!emailPass) {
        return res.status(500).json({
          success: false,
          error: isSysAdmin
            ? "Email sending is not configured on this environment (missing PMA_EMAIL_APP_PASSWORD)."
            : "Email sending is currently unavailable. Please contact an administrator.",
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

      if (clientName) {
        try {
          const cfg = await getClientSetupConfig({ clientName, masterSheetId }).catch(() => null);
          if (cfg && !cfg.requestConnections && cfg.requiredOAuthTools?.length > 0 && !cfg.allRequiredToolsConnected) {
            await saveClientSetupConfig({
              clientName,
              masterSheetId: masterSheetId || cfg.masterSheetId || "",
              setupMode: cfg.setupMode,
              pulseLive: cfg.pulseLive,
              requestConnections: true,
              accountingTool: cfg.accountingTool,
              crmTool: cfg.crmTool,
              crmDrives: cfg.crmDrives,
              updatedBy: sessionUser.name || sessionUser.email,
            }).catch(() => {});
          }
          await updateClientChecklistTask(sheets, {
            clientName,
            taskId: "p2_request_connections_email",
            isCompleted: true,
            metadata: `Sent to ${toEmail}`,
            userEmail: sessionUser.email || "Admin",
          }).catch(() => {});
        } catch (_) {}
      }

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
    return res.status(500).json({
      success: false,
      error: isSysAdmin ? (err.message || "Internal server error.") : sanitizeSpreadsheetTerms(err.message || "Request failed."),
    });
  }
}
