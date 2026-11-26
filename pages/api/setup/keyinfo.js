/**
 * ============================================================================
 * SETUP KEYINFO API: /api/setup/keyinfo
 * ============================================================================
 * 
 * GET: Reads KeyInfo financial parameters directly from Master Sheet.
 * POST: Saves KeyInfo financial parameters to Master Sheet and marks task complete.
 */

import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { assertSetupClientSheetBinding, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { getMasterKeyInfoSettings, saveMasterKeyInfoSettings } from "../../../services/setupService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export default async function handler(req, res) {
  const sessionUser = await resolveLiveSessionUser(req, res);
  installSheetIdBoundary(req, res, sessionUser);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied." });
  }

  const rl = await checkRateLimit("setup-keyinfo", sessionUser.email || getTrustedClientIp(req), 120, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
  }

  const sheets = await getSheetsClient();

  if (req.method === "GET") {
    const { masterSheetId, clientName } = req.query;
    if (!masterSheetId) {
      return res.status(400).json({ success: false, error: "Missing masterSheetId" });
    }

    const bindAuth = await assertSetupClientSheetBinding(sessionUser, {
      clientName: clientName || "",
      masterSheetId,
      sheets,
    });
    if (!bindAuth.authorized) {
      return res.status(bindAuth.status || 403).json({ success: false, error: bindAuth.error || "Access denied to this client." });
    }

    try {
      const settings = await getMasterKeyInfoSettings(sheets, masterSheetId);
      return res.status(200).json({ success: true, settings });
    } catch (err) {
      console.error("GET /api/setup/keyinfo error:", err);
      return res.status(500).json({ success: false, error: sessionUser.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
    }
  }

  if (req.method === "POST") {
    if (!assertTrustedOrigin(req, res)) return;
    if (isReadOnlySession(sessionUser) || !sessionUser.isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required to modify KeyInfo financial settings." });
    }
    const { masterSheetId, clientName, settings } = req.body || {};
    if (!masterSheetId || !settings) {
      return res.status(400).json({ success: false, error: "Missing masterSheetId or settings." });
    }

    const bindAuth = await assertSetupClientSheetBinding(sessionUser, {
      clientName: clientName || "",
      masterSheetId,
      sheets,
    });
    if (!bindAuth.authorized) {
      return res.status(bindAuth.status || 403).json({ success: false, error: bindAuth.error || "Access denied to this client." });
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
