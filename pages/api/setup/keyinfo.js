/**
 * ============================================================================
 * SETUP KEYINFO API: /api/setup/keyinfo
 * ============================================================================
 * 
 * GET: Reads KeyInfo financial parameters directly from Master Sheet.
 * POST: Saves KeyInfo financial parameters to Master Sheet and marks task complete.
 */

import { getSessionUser } from "../../../services/authService.js";
import { isUserAuthorizedForClient } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { getMasterKeyInfoSettings, saveMasterKeyInfoSettings } from "../../../services/setupService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (sessionUser.role === "ClientUser" || sessionUser.role === "Senior (Restricted)" || sessionUser.isClientUser) {
    return res.status(403).json({ success: false, error: "Access denied." });
  }

  const sheets = await getSheetsClient();

  if (req.method === "GET") {
    const { masterSheetId, clientName } = req.query;
    if (!masterSheetId) {
      return res.status(400).json({ success: false, error: "Missing masterSheetId" });
    }

    if (clientName && !sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }

    try {
      const settings = await getMasterKeyInfoSettings(sheets, masterSheetId);
      return res.status(200).json({ success: true, settings });
    } catch (err) {
      console.error("GET /api/setup/keyinfo error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    const { masterSheetId, clientName, settings } = req.body || {};
    if (!masterSheetId || !settings) {
      return res.status(400).json({ success: false, error: "Missing masterSheetId or settings." });
    }

    if (clientName && !sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }

    try {
      const updated = await saveMasterKeyInfoSettings(sheets, {
        masterSheetId,
        clientName,
        settings,
        userEmail: sessionUser.email
      });
      return res.status(200).json({ success: true, settings: updated });
    } catch (err) {
      console.error("POST /api/setup/keyinfo error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed." });
}
