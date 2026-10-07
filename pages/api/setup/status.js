/**
 * ============================================================================
 * PORTAL SETUP STATUS API: /api/setup/status
 * ============================================================================
 * 
 * Lightweight endpoint consumed by the Pulse Portal (/pulse) to evaluate
 * whether the current client is in Setup Mode, and whether tool connections
 * are being requested.
 */

import { getSessionUser } from "../../../services/authService.js";
import { isUserAuthorizedForClient } from "../../../services/userPermissions.js";
import { getClientSetupStatusForPortal } from "../../../services/setupService.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  const { clientName, masterSheetId } = req.query;
  if (!clientName) {
    return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
  }

  // Ensure user is authorized for this client
  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  try {
    const status = await getClientSetupStatusForPortal({ clientName, masterSheetId });
    return res.status(200).json({
      success: true,
      userRole: sessionUser.role,
      isAdmin: Boolean(sessionUser.isAdmin),
      isClientManager: sessionUser.role === "ClientManager",
      isClientUser: sessionUser.role === "ClientUser" || Boolean(sessionUser.isClientUser),
      status
    });
  } catch (err) {
    console.error("GET /api/setup/status error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
