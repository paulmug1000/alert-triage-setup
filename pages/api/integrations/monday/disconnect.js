/**
 * ============================================================================
 * MONDAY.COM DISCONNECT ROUTE: /api/integrations/monday/disconnect
 * ============================================================================
 */

import { deleteIntegrationTokens } from "../../../../services/vaultService.js";
import { getSessionUser } from "../../../../services/authService.js";
import { getSheetsClient } from "../../../../services/sheetsClient.js";
import { isUserAuthorizedForClient, isReadOnlySession, verifyUserAuthorizedForSheet } from "../../../../services/userPermissions.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ error: "Active session required." });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ error: "Read-only session cannot disconnect integrations." });
  }

  const { clientKey, clientName, masterSheetId } = req.body || {};

  if (!clientKey && !masterSheetId && !clientName) {
    return res.status(400).json({ error: "Missing required clientKey, clientName, or masterSheetId parameter." });
  }

  const targetClient = clientName || clientKey;
  if (!sessionUser.isAdmin) {
    if (targetClient && !isUserAuthorizedForClient(sessionUser, targetClient)) {
      return res.status(403).json({ error: "Access denied to this client." });
    }
    if (masterSheetId) {
      const sheets = await getSheetsClient();
      const sheetAuth = await verifyUserAuthorizedForSheet(sheets, sessionUser, masterSheetId);
      if (!sheetAuth.authorized) {
        return res.status(403).json({ error: "Access denied to this client." });
      }
    }
  }

  try {
    await deleteIntegrationTokens({
      clientKey,
      masterSheetId,
      tool: "monday"
    });

    console.log(`🔌 Monday.com integration disconnected for client: ${clientKey || masterSheetId}`);

    return res.status(200).json({
      success: true,
      message: "Monday.com integration disconnected successfully."
    });
  } catch (err) {
    console.error("Monday.com disconnect error:", err);
    return res.status(500).json({ error: err.message || "Failed to disconnect Monday.com integration." });
  }
}
