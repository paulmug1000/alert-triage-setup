/**
 * ============================================================================
 * SETUP PROVISION API: /api/setup/provision
 * ============================================================================
 * 
 * POST: Runs the end-to-end client provisioning engine:
 * 1. Creates client folder in Google Drive.
 * 2. Duplicates Master, Client, Recon templates & creates backup sheet.
 * 3. Shares files and syncs KeyInfo cross-links.
 * 4. Enrolls in Client Version Tracker, Automation Commander, and Reporting Control.
 * 5. Seeds ClientSetupOverview & ClientSetupTasks in Automation Commander.
 * 6. Seeds Redis setup config and logs activity.
 */

import { getSessionUser } from "../../../services/authService.js";
import { provisionNewClientSystem } from "../../../services/setupService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  // Provisioning is an admin-level operation
  if (!sessionUser.isAdmin && sessionUser.role !== "Admin") {
    return res.status(403).json({ success: false, error: "Only administrators can provision new client systems." });
  }

  const { clientName, accountingTool, crmTool, crmDrives, targetParentFolderId } = req.body || {};

  if (!clientName || !clientName.trim()) {
    return res.status(400).json({ success: false, error: "Client Name is required." });
  }

  try {
    const result = await provisionNewClientSystem({
      clientName: clientName.trim(),
      accountingTool: accountingTool || "None",
      crmTool: crmTool || "None",
      crmDrives: crmDrives || "NA",
      targetParentFolderId,
      userEmail: sessionUser.email
    });

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("POST /api/setup/provision error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
