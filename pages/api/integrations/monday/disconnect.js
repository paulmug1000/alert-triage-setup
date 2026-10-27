/**
 * ============================================================================
 * MONDAY.COM DISCONNECT ROUTE: /api/integrations/monday/disconnect
 * ============================================================================
 */

import { deleteIntegrationTokens } from "../../../../services/vaultService.js";
import { getSessionUser } from "../../../../services/authService.js";
import { isUserAuthorizedForClient } from "../../../../services/userPermissions.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ error: "Active session required." });
  }

  const { clientKey, clientName, masterSheetId } = req.body || {};

  if (!clientKey && !masterSheetId && !clientName) {
    return res.status(400).json({ error: "Missing required clientKey, clientName, or masterSheetId parameter." });
  }

  const targetClient = clientName || clientKey;
  if (!sessionUser.isAdmin && targetClient && !isUserAuthorizedForClient(sessionUser, targetClient)) {
    return res.status(403).json({ error: "Access denied to this client." });
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
