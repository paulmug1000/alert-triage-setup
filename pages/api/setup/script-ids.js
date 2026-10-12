/**
 * ============================================================================
 * SETUP SCRIPT IDS API: /api/setup/script-ids
 * ============================================================================
 * 
 * POST: Saves container-bound script IDs to Client Version Tracker (Columns R, S, T)
 * and marks task p1_script_ids as complete.
 */

import { getSessionUser } from "../../../services/authService.js";
import { isUserAuthorizedForClient } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { saveScriptIdsToTracker } from "../../../services/setupService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (sessionUser.role === "ClientUser" || sessionUser.role === "Senior (Restricted)" || sessionUser.isClientUser) {
    return res.status(403).json({ success: false, error: "Access denied." });
  }

  const { clientName, clientScriptId, masterScriptId, reconScriptId } = req.body || {};
  if (!clientName) {
    return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
  }

  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  try {
    const sheets = await getSheetsClient();
    const result = await saveScriptIdsToTracker(sheets, {
      clientName,
      clientScriptId,
      masterScriptId,
      reconScriptId,
      userEmail: sessionUser.email
    });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("POST /api/setup/script-ids error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
