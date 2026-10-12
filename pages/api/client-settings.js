/**
 * ============================================================================
 * CLIENT SETTINGS API: /api/client-settings
 * ============================================================================
 * 
 * GET: Retrieves complete client settings from Redis or Google Sheets.
 * POST: Saves modified settings to Google Sheets (Master and Client) and updates Redis.
 * 
 * Strict Admin-only access.
 */

import { getSessionUser } from "../../services/authService.js";
import { getClientSettings, saveClientSettings } from "../../services/clientSettingsService.js";

export default async function handler(req, res) {
  // 1. Authenticate user
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  // 2. Strict Admin-only check
  const isAdmin = Boolean(sessionUser.isAdmin || sessionUser.role === "Admin");
  if (!isAdmin) {
    return res.status(403).json({
      success: false,
      error: "Access denied: Client settings configuration is strictly restricted to Admins."
    });
  }

  // 3. GET: Fetch settings
  if (req.method === "GET") {
    const { clientName, masterSheetId, clientSheetId, bypassCache } = req.query;

    if (!clientName || !masterSheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing required clientName or masterSheetId parameter."
      });
    }

    try {
      const data = await getClientSettings({
        clientName,
        masterSheetId,
        clientSheetId,
        bypassCache: bypassCache === "true" || bypassCache === true
      });

      return res.status(200).json({ success: true, settings: data });
    } catch (err) {
      console.error("GET /api/client-settings error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // 4. POST: Save settings
  if (req.method === "POST") {
    const {
      clientName,
      masterSheetId,
      clientSheetId,
      settings,
      resetKpiToParent
    } = req.body;

    if (!clientName || !masterSheetId || !settings) {
      return res.status(400).json({
        success: false,
        error: "Missing required clientName, masterSheetId, or settings payload."
      });
    }

    try {
      const result = await saveClientSettings({
        clientName,
        masterSheetId,
        clientSheetId,
        settings,
        resetKpiToParent: Boolean(resetKpiToParent)
      });

      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error("POST /api/client-settings error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed." });
}
