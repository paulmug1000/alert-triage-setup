/**
 * ============================================================================
 * SETUP DEPLOYMENT URL API: /api/setup/deployment-url
 * ============================================================================
 * 
 * POST: Saves Master Sheet GAS deployment URL to Master KeyInfo!X29 and Column W
 * of Client Version Tracker, marking task p1_gas_deployment as complete.
 */

import { getSessionUser } from "../../../services/authService.js";
import { isUserAuthorizedForClient, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { saveDeploymentUrl } from "../../../services/setupService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!sessionUser.isAdmin || isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: Admin privileges required." });
  }

  const { clientName, masterSheetId, deploymentUrl } = req.body || {};
  if (!clientName || !deploymentUrl) {
    return res.status(400).json({ success: false, error: "Missing required clientName or deploymentUrl." });
  }

  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  try {
    const sheets = await getSheetsClient();
    const result = await saveDeploymentUrl(sheets, {
      clientName,
      masterSheetId,
      deploymentUrl,
      userEmail: sessionUser.email
    });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("POST /api/setup/deployment-url error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
