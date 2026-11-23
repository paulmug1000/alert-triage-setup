/**
 * ============================================================================
 * PORTAL SETUP STATUS API: /api/setup/status
 * ============================================================================
 * 
 * Lightweight endpoint consumed by the Pulse Portal (/pulse) to evaluate
 * whether the current client is in Setup Mode, and whether tool connections
 * are being requested.
 */

import { resolveLiveSessionUser } from "../../../services/authService.js";
import { isUserAuthorizedForClient, verifyUserAuthorizedForSheet, matchesClientName, canAccessPma } from "../../../services/userPermissions.js";
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

  const { clientName, masterSheetId, clientSheetId } = req.query;
  if (!clientName) {
    return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
  }

  // Ensure user is authorized for this client
  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }
  if (!sessionUser.isAdmin && (clientSheetId || masterSheetId)) {
    try {
      const sheets = await getSheetsClient();
      let boundClient = String(clientName || "").trim();
      for (const sid of [clientSheetId, masterSheetId].filter(Boolean)) {
        const auth = await verifyUserAuthorizedForSheet(sessionUser, sid, boundClient, sheets);
        if (!auth.authorized) {
          return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
        }
        if (auth.clientName) {
          if (boundClient && !matchesClientName(boundClient, auth.clientName)) {
            return res.status(403).json({ success: false, error: "Access denied to this client." });
          }
          boundClient = auth.clientName;
        }
      }
    } catch (_) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }
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
