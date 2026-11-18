/**
 * Setup API route for scanning and applying blank-Project-code matches
 * between CRM deals and existing Pipeline jobs.
 */

import { getSessionUser } from "../../../services/authService.js";
import { isUserAuthorizedForClient, verifyUserAuthorizedForSheet, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { scanBlankCodePipelineMatches, applyBlankCodePipelineMatches } from "../../../services/crmPipelineMatchService.js";
import { runNativeMasterAmdAction } from "../../../services/masterSyncEngine.js";
import { resolveSupabaseSheetContext } from "../../../services/masterEngineService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }
  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  const clientName = String(req.method === "GET" ? req.query?.clientName : req.body?.clientName || "").trim();
  const masterSheetId = String(req.method === "GET" ? req.query?.masterSheetId : req.body?.masterSheetId || "").trim();
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

  if (req.method === "GET") {
    try {
      const scanResult = await scanBlankCodePipelineMatches({ clientName, masterSheetId });
      return res.status(200).json(scanResult);
    } catch (err) {
      console.error("GET /api/setup/match-crm-pipeline error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
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
        return res.status(200).json({ ...scanResult, pulledFresh: supaCtx?.masterMode === "supabase" });
      }

      const result = await applyBlankCodePipelineMatches({
        clientName,
        masterSheetId,
        matches,
        userEmail: sessionUser.email || "Admin",
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error("POST /api/setup/match-crm-pipeline error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ success: false, error: `Method ${req.method} not allowed.` });
}
