/**
 * ============================================================================
 * SUGGEST ACCOUNTING SETTINGS API: /api/setup/suggest-accounting-settings
 * ============================================================================
 * 
 * GET: Analyzes connected accounting tool (Xero/QBO) and returns suggested
 *      initial settings: Financial year start date (formatted d-Mmm-yy),
 *      VAT quarters, VAT payment scheme (Cash/Accrual), and PAYE cycle.
 * POST: Applies approved settings to Master Sheet KeyInfo!B2, B6, B8, B12.
 */

import { getSessionUser } from "../../../services/authService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { isUserAuthorizedForClient, verifyUserAuthorizedForSheet, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  suggestAccountingSettings,
  applyAccountingSettings
} from "../../../services/accountingSuggestionsService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req, res);
  installSheetIdBoundary(req, res, sessionUser);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  if (req.method === "GET") {
    const { clientName, masterSheetId } = req.query;
    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }

    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }
    if (!sessionUser.isAdmin && masterSheetId) {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }

    try {
      const suggestions = await suggestAccountingSettings({ clientName, masterSheetId });
      return res.status(200).json(suggestions);
    } catch (err) {
      console.error("GET /api/setup/suggest-accounting-settings error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    if (isReadOnlySession(sessionUser) || !sessionUser.isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required to apply accounting settings." });
    }
    const { clientName, masterSheetId, settings } = req.body || {};
    if (!clientName || !settings) {
      return res.status(400).json({ success: false, error: "Missing required clientName or settings payload." });
    }

    try {
      const result = await applyAccountingSettings({ clientName, masterSheetId, settings });
      return res.status(200).json(result);
    } catch (err) {
      console.error("POST /api/setup/suggest-accounting-settings error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ success: false, error: `Method ${req.method} not allowed.` });
}
