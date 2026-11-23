/**
 * ============================================================================
 * SUGGEST CATEGORY MAPPINGS API: /api/setup/suggest-category-mappings
 * ============================================================================
 * 
 * GET: Analyzes client's P&L and Chart of Accounts and classifies accounts
 *      into Pulse sections: Revenue, CoS staff costs (Salaries, Wages, Pension, NI),
 *      Other CoS, Corporation tax, Depreciation, Non-operating income/expense, and Ignore.
 * POST: Applies approved category mapping rules to Master Sheet KeyInfo!BA2:BA180.
 */

import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { isUserAuthorizedForClient, assertSetupClientSheetBinding, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  suggestCategoryMappings,
  applyCategoryMappings
} from "../../../services/accountingSuggestionsService.js";
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

  const rl = await checkRateLimit("setup-suggest-categories", sessionUser.email || getTrustedClientIp(req), 20, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  if (req.method === "GET") {
    const { clientName, masterSheetId } = req.query;
    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }

    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }
    if (masterSheetId) {
      const sheets = await getSheetsClient();
      const binding = await assertSetupClientSheetBinding(sessionUser, { clientName, masterSheetId, sheets });
      if (!binding.authorized) {
        return res.status(binding.status || 403).json({ success: false, error: binding.error || "Access denied to this client." });
      }
    }

    try {
      const suggestions = await suggestCategoryMappings({ clientName, masterSheetId, isAdmin: Boolean(sessionUser.isAdmin) });
      return res.status(200).json(suggestions);
    } catch (err) {
      console.error("GET /api/setup/suggest-category-mappings error:", err);
      return res.status(500).json({ success: false, error: sessionUser.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
    }
  }

  if (req.method === "POST") {
    if (!assertTrustedOrigin(req, res)) return;
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify category mappings." });
    }
    const { clientName, masterSheetId, mappings } = req.body || {};
    if (!clientName || !mappings) {
      return res.status(400).json({ success: false, error: "Missing required clientName or mappings payload." });
    }

    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }
    if (masterSheetId) {
      const sheets = await getSheetsClient();
      const binding = await assertSetupClientSheetBinding(sessionUser, { clientName, masterSheetId, sheets });
      if (!binding.authorized) {
        return res.status(binding.status || 403).json({ success: false, error: binding.error || "Access denied to this client." });
      }
    }

    try {
      const result = await applyCategoryMappings({ clientName, masterSheetId, mappings });
      return res.status(200).json(result);
    } catch (err) {
      console.error("POST /api/setup/suggest-category-mappings error:", err);
      return res.status(500).json({ success: false, error: sessionUser.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ success: false, error: `Method ${req.method} not allowed.` });
}
