/**
 * ============================================================================
 * CASH OPENING FIGURE API: /api/setup/cash-opening
 * ============================================================================
 *
 * POST: action = "detect_balances" | "save_balances"
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
  detectCashOpeningBalances,
  saveCashOpeningBalances,
} from "../../../services/cashOpeningService.js";
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
    return res.status(403).json({ success: false, error: "Read-only session cannot modify cash opening figures." });
  }

  const rl = await checkRateLimit("setup-cash-opening", sessionUser.email || getTrustedClientIp(req), 20, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  const isAdmin = Boolean(!sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin"));
  const { clientName, masterSheetId, action, updates } = req.body || {};

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
    if (action === "detect_balances") {
      const data = await detectCashOpeningBalances({
        clientName,
        masterSheetId: resolvedMasterId,
      });
      const safeData = isAdmin
        ? data
        : {
            ...data,
            accounts: Array.isArray(data?.accounts)
              ? data.accounts.map(({ targetRow, targetCol0, targetColLetter, targetCellRef, ...rest }) => rest)
              : data?.accounts,
            entries: Array.isArray(data?.entries)
              ? data.entries.map(({ targetRow, targetCol0, targetColLetter, targetCellRef, ...rest }) => rest)
              : data?.entries,
          };
      return res.status(200).json({ success: true, ...safeData });
    }

    if (action === "save_balances") {
      const result = await saveCashOpeningBalances({
        clientName,
        masterSheetId: resolvedMasterId,
        updates,
      });
      let safeResult = result;
      if (!isAdmin && result && typeof result === "object") {
        const { rangesWritten, ...rest } = result;
        safeResult = rest;
      }
      return res.status(200).json({ success: true, ...safeResult });
    }

    return res.status(400).json({ success: false, error: "Invalid action specified." });
  } catch (err) {
    console.error("POST /api/setup/cash-opening error:", err);
    const msg = isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Failed to process cash opening balances.");
    return res.status(500).json({ success: false, error: msg });
  }
}
