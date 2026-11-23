/**
 * ============================================================================
 * INITIAL TAX PAYMENTS SETUP API: /api/setup/initial-tax
 * ============================================================================
 *
 * POST: action = "load_initial_tax" | "save_initial_tax"
 */

import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import {
  isUserAuthorizedForClient,
  assertSetupClientSheetBinding,
  canAccessPma,
  isReadOnlySession,
} from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  loadInitialTaxSetupData,
  saveInitialTaxSetupData,
} from "../../../services/taxSetupService.js";
import { getClientSetupConfig } from "../../../services/setupService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  installSheetIdBoundary(req, res, sessionUser);

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  if (!assertTrustedOrigin(req)) {
    return res.status(403).json({ success: false, error: "Untrusted request origin." });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Read-only session cannot modify initial tax estimates." });
  }

  const rl = await checkRateLimit("setup-initial-tax", sessionUser.email || getTrustedClientIp(req), 20, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  const isAdmin = Boolean(!sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin"));
  const { clientName, masterSheetId, action, corpTaxAmount, vatSlots } = req.body || {};

  if (!clientName) {
    return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
  }

  if (!isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  let resolvedMasterId = masterSheetId;
  if (!resolvedMasterId) {
    const cfg = await getClientSetupConfig({ clientName }).catch(() => null);
    resolvedMasterId = cfg?.masterSheetId || "";
  }
  if (!resolvedMasterId) {
    return res.status(400).json({ success: false, error: "No Master workspace configured for this client." });
  }

  const sheets = await getSheetsClient();
  const binding = await assertSetupClientSheetBinding(sessionUser, {
    clientName,
    masterSheetId: resolvedMasterId,
    sheets,
  });
  if (!binding.authorized) {
    return res.status(binding.status || 403).json({ success: false, error: binding.error || "Access denied to this client." });
  }

  try {
    if (action === "load_initial_tax") {
      const data = await loadInitialTaxSetupData({
        clientName,
        masterSheetId: resolvedMasterId,
      });
      let safeData = data;
      if (!isAdmin && data && typeof data === "object") {
        const { f6, ...rest } = data;
        safeData = {
          ...rest,
          vatSlots: Array.isArray(data.vatSlots)
            ? data.vatSlots.map(({ cashCol, vatCol, f6Num, ...slot }) => slot)
            : data.vatSlots,
        };
      }
      return res.status(200).json({ success: true, ...safeData });
    }

    if (action === "save_initial_tax") {
      const result = await saveInitialTaxSetupData({
        clientName,
        masterSheetId: resolvedMasterId,
        corpTaxAmount,
        vatSlots,
      });
      return res.status(200).json({ success: true, ...result });
    }

    return res.status(400).json({ success: false, error: "Invalid action specified." });
  } catch (err) {
    console.error("POST /api/setup/initial-tax error:", err);
    const msg = isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Failed to process initial tax setup.");
    return res.status(500).json({ success: false, error: msg });
  }
}
