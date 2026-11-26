/**
 * ============================================================================
 * SETUP SCRIPT IDS API: /api/setup/script-ids
 * ============================================================================
 * 
 * POST: Saves container-bound script IDs to Client Version Tracker (Columns R, S, T)
 * and marks task p1_script_ids as complete.
 */

import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { isUserAuthorizedForClient, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { saveScriptIdsToTracker } from "../../../services/setupService.js";
import { assertTrustedOrigin } from "../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!sessionUser.isAdmin || isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: Admin privileges required." });
  }

  const rl = await checkRateLimit("setup-script-ids", sessionUser.email || getTrustedClientIp(req), 60, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
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
