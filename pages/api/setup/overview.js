/**
 * ============================================================================
 * SETUP OVERVIEW API: /api/setup/overview
 * ============================================================================
 * 
 * Returns setup status and progress for all clients the user has access to.
 */

import { getSessionUser } from "../../../services/authService.js";
import { canAccessPma } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { getAllClientsSetupOverview } from "../../../services/setupService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    const sheets = await getSheetsClient();
    const allOutgoingsClients = req.body?.allOutgoingsClients || [];
    const overview = await getAllClientsSetupOverview(sheets, sessionUser, allOutgoingsClients);
    return res.status(200).json({ success: true, clients: overview });
  } catch (err) {
    console.error("GET /api/setup/overview error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
