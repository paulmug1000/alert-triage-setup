/**
 * ============================================================================
 * YEAR 0 SETUP API: /api/setup/year0
 * ============================================================================
 *
 * GET:  Loads current Year 0 P&L data, dividends in lieu of salary, and category adjustments.
 * POST: action = "pull_year0_pl" | "save_year0_adjustments"
 */

import { resolveLiveSessionUser } from "../../../services/authService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import {
  isUserAuthorizedForClient,
  verifyUserAuthorizedForSheet,
  canAccessPma,
  isReadOnlySession,
} from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  getYear0SetupData,
  pullYear0PL,
  saveYear0Adjustments,
  detectYear0Dividends,
} from "../../../services/year0SetupService.js";
import { getClientSetupConfig } from "../../../services/setupService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export const config = {
  maxDuration: 120,
};

export default async function handler(req, res) {
  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  installSheetIdBoundary(req, res, sessionUser);

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  const isAdmin = Boolean(!sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin"));

  if (req.method === "GET") {
    const { clientName, masterSheetId, clientSheetId } = req.query;
    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }
    if (!isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }

    let resolvedMasterId = masterSheetId;
    if (!resolvedMasterId) {
      const cfg = await getClientSetupConfig({ clientName, clientSheetId }).catch(() => null);
      resolvedMasterId = cfg?.masterSheetId || "";
    }
    if (!resolvedMasterId) {
      return res.status(400).json({ success: false, error: "No Master workspace configured for this client." });
    }

    if (!isAdmin) {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, resolvedMasterId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }

    try {
      const data = await getYear0SetupData({ clientName, masterSheetId: resolvedMasterId });
      return res.status(200).json({ success: true, ...data });
    } catch (err) {
      console.error("GET /api/setup/year0 error:", err);
      const msg = isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Failed to load Year 0 data.");
      return res.status(500).json({ success: false, error: msg });
    }
  }

  if (req.method === "POST") {
    if (!assertTrustedOrigin(req)) {
      return res.status(403).json({ success: false, error: "Untrusted request origin." });
    }
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify Year 0 setup." });
    }

    const { clientName, masterSheetId, clientSheetId, action, deliveryPct, monthlyDividends, categoryAdjustments } = req.body || {};
    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }
    if (!isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }

    let resolvedMasterId = masterSheetId;
    if (!resolvedMasterId) {
      const cfg = await getClientSetupConfig({ clientName, clientSheetId }).catch(() => null);
      resolvedMasterId = cfg?.masterSheetId || "";
    }
    if (!resolvedMasterId) {
      return res.status(400).json({ success: false, error: "No Master workspace configured for this client." });
    }

    if (!isAdmin) {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, resolvedMasterId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }

    try {
      if (action === "pull_year0_pl") {
        const data = await pullYear0PL({ clientName, masterSheetId: resolvedMasterId });
        return res.status(200).json({ success: true, ...data });
      }
      if (action === "detect_dividends") {
        const detected = await detectYear0Dividends({ clientName, masterSheetId: resolvedMasterId });
        return res.status(200).json({ success: true, ...detected });
      }
      if (action === "save_year0_adjustments") {
        const data = await saveYear0Adjustments({
          clientName,
          masterSheetId: resolvedMasterId,
          deliveryPct,
          monthlyDividends,
          categoryAdjustments,
        });
        return res.status(200).json({ success: true, ...data });
      }
      return res.status(400).json({ success: false, error: "Invalid action specified." });
    } catch (err) {
      console.error("POST /api/setup/year0 error:", err);
      const msg = isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Failed to update Year 0 setup.");
      return res.status(500).json({ success: false, error: msg });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed." });
}
