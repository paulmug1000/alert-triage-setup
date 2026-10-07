/**
 * ============================================================================
 * SETUP CONFIG API: /api/setup/config
 * ============================================================================
 * 
 * GET: Retrieves setup configuration, tool choices, and live connection status.
 * POST: Saves setup configuration, toggles setup mode, and updates KeyInfo Q4/Q8/Q9.
 * 
 * Access restricted to Admins and assigned ClientManagers.
 */

import { getSessionUser } from "../../../services/authService.js";
import { isUserAuthorizedForClient } from "../../../services/userPermissions.js";
import { getClientSetupConfig, saveClientSetupConfig } from "../../../services/setupService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  // Block ClientUser and Senior (Restricted) from accessing internal PMA setup configuration
  if (sessionUser.role === "ClientUser" || sessionUser.role === "Senior (Restricted)" || sessionUser.isClientUser) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  if (req.method === "GET") {
    const { clientName, masterSheetId } = req.query;
    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }

    // Role scoping: ClientManagers can only view assigned clients
    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }

    try {
      const config = await getClientSetupConfig({ clientName, masterSheetId });
      return res.status(200).json({ success: true, config });
    } catch (err) {
      console.error("GET /api/setup/config error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    const {
      clientName,
      masterSheetId,
      setupMode,
      requestConnections,
      accountingTool,
      crmTool,
      crmDrives
    } = req.body || {};

    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }

    // Role scoping: ClientManagers can only edit assigned clients
    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to modify this client." });
    }

    try {
      const updatedConfig = await saveClientSetupConfig({
        clientName,
        masterSheetId,
        setupMode,
        requestConnections,
        accountingTool,
        crmTool,
        crmDrives,
        updatedBy: sessionUser.name || sessionUser.email
      });

      return res.status(200).json({ success: true, config: updatedConfig });
    } catch (err) {
      console.error("POST /api/setup/config error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
