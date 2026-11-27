/**
 * Setup API route for scanning and applying blank-Project-code matches
 * between CRM deals and existing Pipeline jobs.
 */

import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import {
  isUserAuthorizedForClient,
  assertSetupClientSheetBinding,
  canAccessPma,
  isReadOnlySession,
  installSheetIdBoundary,
} from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { scanBlankCodePipelineMatches, applyBlankCodePipelineMatches } from "../../../services/crmPipelineMatchService.js";
import { runNativeMasterAmdAction } from "../../../services/masterSyncEngine.js";
import { resolveSupabaseSheetContext } from "../../../services/masterEngineService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

function scrubMatchItemRow_(item) {
  if (!item || typeof item !== "object") return item;
  const { rowNum, ...rest } = item;
  return {
    ...rest,
    ...(rowNum !== undefined ? { lineId: rowNum } : {}),
  };
}

function redactMatchScanForUser_(resObj, isAdmin) {
  if (isAdmin || !resObj || typeof resObj !== "object") return resObj;
  const out = { ...resObj };
  if (Array.isArray(out.clearMatches)) {
    out.clearMatches = out.clearMatches.map((m) => ({
      ...m,
      pipelineRow: scrubMatchItemRow_(m?.pipelineRow),
      crmDeal: scrubMatchItemRow_(m?.crmDeal),
    }));
  }
  if (Array.isArray(out.possibleMatches)) {
    out.possibleMatches = out.possibleMatches.map((m) => ({
      ...m,
      crmDeal: scrubMatchItemRow_(m?.crmDeal),
      candidateOptions: Array.isArray(m?.candidateOptions)
        ? m.candidateOptions.map(scrubMatchItemRow_)
        : m?.candidateOptions,
    }));
  }
  if (Array.isArray(out.blankCodePipelineRows)) {
    out.blankCodePipelineRows = out.blankCodePipelineRows.map(scrubMatchItemRow_);
  }
  if (Array.isArray(out.unmatchedDeals)) {
    out.unmatchedDeals = out.unmatchedDeals.map(scrubMatchItemRow_);
  }
  if (Array.isArray(out.skipped)) {
    out.skipped = out.skipped.map((s) => ({
      ...(s || {}),
      ...(s?.rowNum !== undefined ? { lineId: s.rowNum } : {}),
      rowNum: undefined,
      reason: s?.reason ? sanitizeSpreadsheetTerms(s.reason) : s?.reason,
    }));
  }
  if (typeof out.message === "string") {
    out.message = sanitizeSpreadsheetTerms(out.message);
  }
  return out;
}

export const config = {
  maxDuration: 120,
};

export default async function handler(req, res) {
  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }
  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }
  installSheetIdBoundary(req, res, sessionUser);
  const isSysAdmin = Boolean(!sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin"));

  const rl = await checkRateLimit("setup-match-crm-pipeline", sessionUser.email || getTrustedClientIp(req), 20, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  const clientName = String(req.method === "GET" ? req.query?.clientName : req.body?.clientName || "").trim();
  const masterSheetId = String(req.method === "GET" ? req.query?.masterSheetId : req.body?.masterSheetId || "").trim();
  if (!clientName) {
    return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
  }

  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }
  if (masterSheetId) {
    const sheets = await getSheetsClient();
    const binding = await assertSetupClientSheetBinding(sessionUser, {
      clientName,
      masterSheetId,
      sheets,
    });
    if (!binding.authorized) {
      return res.status(binding.status || 403).json({ success: false, error: binding.error || "Access denied to this client." });
    }
  }

  if (req.method === "GET") {
    try {
      const scanResult = await scanBlankCodePipelineMatches({ clientName, masterSheetId });
      return res.status(200).json(redactMatchScanForUser_(scanResult, isSysAdmin));
    } catch (err) {
      console.error("GET /api/setup/match-crm-pipeline error:", err);
      return res.status(500).json({ success: false, error: sessionUser.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
    }
  }

  if (req.method === "POST") {
    if (!assertTrustedOrigin(req, res)) return;
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify pipeline jobs." });
    }

    const { action = "apply", matches = [] } = req.body || {};

    try {
      if (action === "pull_and_scan") {
        const sheets = await getSheetsClient();
        const supaCtx = await resolveSupabaseSheetContext({ clientName, spreadsheetId: masterSheetId });
        if (supaCtx?.masterMode === "supabase") {
          await runNativeMasterAmdAction({
            sheets,
            clientName: supaCtx.clientName || clientName,
            amdAction: "pull_crm",
            userEmail: sessionUser.email || "Admin",
          });
        }
        const scanResult = await scanBlankCodePipelineMatches({ clientName, masterSheetId });
        return res.status(200).json(
          redactMatchScanForUser_({ ...scanResult, pulledFresh: supaCtx?.masterMode === "supabase" }, isSysAdmin)
        );
      }

      const result = await applyBlankCodePipelineMatches({
        clientName,
        masterSheetId,
        matches,
        userEmail: sessionUser.email || "Admin",
      });
      return res.status(200).json(redactMatchScanForUser_(result, isSysAdmin));
    } catch (err) {
      console.error("POST /api/setup/match-crm-pipeline error:", err);
      return res.status(500).json({ success: false, error: sessionUser.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ success: false, error: `Method ${req.method} not allowed.` });
}
