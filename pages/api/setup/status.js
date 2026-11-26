/**
 * ============================================================================
 * PORTAL SETUP STATUS API: /api/setup/status
 * ============================================================================
 * 
 * Lightweight endpoint consumed by the Pulse Portal (/pulse) to evaluate
 * whether the current client is in Setup Mode, and whether tool connections
 * are being requested.
 */

import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { assertSetupClientSheetBinding, canAccessPma } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { getClientSetupStatusForPortal } from "../../../services/setupService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }
  installSheetIdBoundary(req, res, sessionUser);

  const rl = await checkRateLimit("setup-status", sessionUser.email || getTrustedClientIp(req), 120, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
  }

  const { clientName, masterSheetId, clientSheetId } = req.query;
  if (!clientName) {
    return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
  }

  try {
    const sheets = await getSheetsClient();
    const bindAuth = await assertSetupClientSheetBinding(sessionUser, {
      clientName,
      masterSheetId: masterSheetId || "",
      clientSheetId: clientSheetId || "",
      sheets,
    });
    if (!bindAuth.authorized) {
      return res.status(bindAuth.status || 403).json({ success: false, error: bindAuth.error || "Access denied to this client." });
    }
  } catch (_) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  try {
    const status = await getClientSetupStatusForPortal({ clientName, masterSheetId, clientSheetId });
    const staffCanAccessPma = canAccessPma(sessionUser);
    const safeStatus =
      !staffCanAccessPma && status?.pulseLive === true
        ? { ...status, setupMode: false }
        : status;
    return res.status(200).json({
      success: true,
      userRole: sessionUser.role,
      isAdmin: Boolean(sessionUser.isAdmin),
      isClientManager: staffCanAccessPma && sessionUser.role === "ClientManager",
      isClientUser: sessionUser.role === "ClientUser" || Boolean(sessionUser.isClientUser),
      status: safeStatus
    });
  } catch (err) {
    console.error("GET /api/setup/status error:", err);
    return res.status(500).json({ success: false, error: sessionUser?.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Failed to load setup status.") });
  }
}
