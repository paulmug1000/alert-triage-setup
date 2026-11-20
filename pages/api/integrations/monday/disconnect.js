/**
 * ============================================================================
 * MONDAY.COM DISCONNECT ROUTE: /api/integrations/monday/disconnect
 * ============================================================================
 */

import { deleteIntegrationTokens } from "../../../../services/vaultService.js";
import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../../services/authService.js";
import { getSheetsClient } from "../../../../services/sheetsClient.js";
import { isUserAuthorizedForClient, isReadOnlySession, verifyUserAuthorizedForSheet, matchesClientName, canAccessPma } from "../../../../services/userPermissions.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const rl = await checkRateLimit("int-disconnect", getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ error: "Active session required." });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ error: "Read-only session cannot disconnect integrations." });
  }
  if (sessionUser.role === "Senior (Restricted)" || sessionUser.isSenior) {
    return res.status(403).json({ error: "Forbidden: Senior (Restricted) users cannot disconnect integrations." });
  }
  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ error: "Forbidden: Only PMA staff can disconnect active integrations." });
  }

  const { clientKey, clientName, masterSheetId } = req.body || {};

  if (!clientKey && !masterSheetId && !clientName) {
    return res.status(400).json({ error: "Missing required clientKey, clientName, or masterSheetId parameter." });
  }

  if (clientKey && clientName && !matchesClientName(clientKey, clientName)) {
    return res.status(403).json({ error: "Access denied: Mismatched clientKey and clientName." });
  }

  const targetClient = clientName || clientKey;
  if (!sessionUser.isAdmin) {
    if (targetClient && !isUserAuthorizedForClient(sessionUser, targetClient)) {
      return res.status(403).json({ error: "Access denied to this client." });
    }
    if (clientKey && !isUserAuthorizedForClient(sessionUser, clientKey)) {
      return res.status(403).json({ error: "Access denied to this client." });
    }
    if (masterSheetId) {
      const sheets = await getSheetsClient();
      const sheetAuth = await verifyUserAuthorizedForSheet(sheets, sessionUser, masterSheetId, targetClient || "");
      if (!sheetAuth.authorized) {
        return res.status(403).json({ error: "Access denied to this client." });
      }
    }
  }

  try {
    await deleteIntegrationTokens({
      clientKey: targetClient,
      masterSheetId,
      tool: "monday"
    });

    console.log(`🔌 Monday.com integration disconnected for client: ${targetClient || masterSheetId}`);

    return res.status(200).json({
      success: true,
      message: "Monday.com integration disconnected successfully."
    });
  } catch (err) {
    console.error("Monday.com disconnect error:", err);
    return res.status(500).json({
      error: sessionUser?.isAdmin ? (err.message || "Failed to disconnect Monday.com integration.") : sanitizeSpreadsheetTerms(err.message || "Failed to disconnect Monday.com integration.")
    });
  }
}
