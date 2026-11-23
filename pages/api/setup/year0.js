/**
 * ============================================================================
 * YEAR 0 SETUP API: /api/setup/year0
 * ============================================================================
 *
 * GET:  Loads current Year 0 P&L data, dividends in lieu of salary, and category adjustments.
 * POST: action = "pull_year0_pl" | "save_year0_adjustments"
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

function redactYear0ForRole(payload, isAdmin) {
  if (isAdmin || !payload || typeof payload !== "object") return payload;
  const redactLine = (line, idx) => {
    if (!line || typeof line !== "object") return line;
    const { rowNum, ...rest } = line;
    return {
      ...rest,
      lineId: rest.lineId ?? (rowNum != null ? `line-${rowNum}` : `line-${idx}`),
    };
  };
  if (!payload.breakdown || typeof payload.breakdown !== "object") return payload;
  const nextBreakdown = { ...payload.breakdown };
  for (const k of ["revenue", "cosStaff", "otherCos", "nonCosStaff", "overheads"]) {
    if (Array.isArray(nextBreakdown[k])) {
      nextBreakdown[k] = nextBreakdown[k].map(redactLine);
    }
  }
  return { ...payload, breakdown: nextBreakdown };
}

export default async function handler(req, res) {
  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  installSheetIdBoundary(req, res, sessionUser);

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  const rl = await checkRateLimit("setup-year0", sessionUser.email || getTrustedClientIp(req), 20, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
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

    const sheets = await getSheetsClient();
    const binding = await assertSetupClientSheetBinding(sessionUser, {
      clientName,
      masterSheetId: resolvedMasterId,
      clientSheetId,
      sheets,
    });
    if (!binding.authorized) {
      return res.status(binding.status || 403).json({ success: false, error: binding.error || "Access denied to this client." });
    }

    try {
      const data = await getYear0SetupData({ clientName, masterSheetId: resolvedMasterId });
      return res.status(200).json({ success: true, ...redactYear0ForRole(data, isAdmin) });
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

    const sheets = await getSheetsClient();
    const binding = await assertSetupClientSheetBinding(sessionUser, {
      clientName,
      masterSheetId: resolvedMasterId,
      clientSheetId,
      sheets,
    });
    if (!binding.authorized) {
      return res.status(binding.status || 403).json({ success: false, error: binding.error || "Access denied to this client." });
    }

    try {
      if (action === "pull_year0_pl") {
        const data = await pullYear0PL({ clientName, masterSheetId: resolvedMasterId });
        return res.status(200).json({ success: true, ...redactYear0ForRole(data, isAdmin) });
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
