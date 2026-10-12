/**
 * ============================================================================
 * SETUP CHECKLIST API: /api/setup/checklist
 * ============================================================================
 * 
 * GET: Retrieves the full 5-phase onboarding checklist for a client.
 * POST: Updates a specific checklist task's completion status.
 */

import { getSessionUser } from "../../../services/authService.js";
import { isUserAuthorizedForClient } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { getClientChecklistState, updateClientChecklistTask } from "../../../services/setupService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (sessionUser.role === "ClientUser" || sessionUser.role === "Senior (Restricted)" || sessionUser.isClientUser) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  const sheets = await getSheetsClient();

  if (req.method === "GET") {
    const { clientName, masterSheetId } = req.query;
    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }

    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }

    try {
      const state = await getClientChecklistState(sheets, clientName, masterSheetId);
      return res.status(200).json({ success: true, ...state });
    } catch (err) {
      console.error("GET /api/setup/checklist error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    const { clientName, taskId, isCompleted, metadata } = req.body || {};
    if (!clientName || !taskId) {
      return res.status(400).json({ success: false, error: "Missing required clientName or taskId." });
    }

    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }

    try {
      const updatedState = await updateClientChecklistTask(sheets, {
        clientName,
        taskId,
        isCompleted: Boolean(isCompleted),
        metadata: metadata || "",
        userEmail: sessionUser.email
      });
      return res.status(200).json({ success: true, ...updatedState });
    } catch (err) {
      console.error("POST /api/setup/checklist error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed." });
}
