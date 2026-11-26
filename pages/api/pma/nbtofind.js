import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../services/authService.js";
import {
  fetchNBToFindData,
  saveNBToFindSettings,
  saveNBToFindMonthlyValues,
} from "../../../services/nbToFindService.js";
import { getClients } from "../../../services/workspaces.js";
import { assertSetupClientSheetBinding, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes } from "../../../services/masterEngineService.js";

export default async function handler(req, res) {
  // 1. Authenticate user
  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Forbidden: Access restricted to Pulse Portal" });
  }

  installSheetIdBoundary(req, res, sessionUser);

  const rl = await checkRateLimit("pma-view", sessionUser.email || getTrustedClientIp(req), 120, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please retry shortly." });
  }

  // 2. GET Request: Fetch NBtoFind data
  if (req.method === "GET") {
    let { clientName, clientSheetId, bypassCache } = req.query;

    if (!clientSheetId && clientName) {
      try {
        const all = await getClients();
        const match = all.find((c) => c.clientName?.toLowerCase() === clientName.toLowerCase().trim());
        if (match) clientSheetId = match.clientSheetId;
      } catch (e) {
        console.warn("Failed to resolve client sheet in GET /api/pma/nbtofind:", e);
      }
    }

    if (!clientSheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing required clientSheetId parameter.",
      });
    }

    const sheets = await getSheetsClient();
    const bindAuth = await assertSetupClientSheetBinding(sessionUser, {
      clientName,
      clientSheetId,
      sheets,
    });
    if (!bindAuth.authorized) {
      return res.status(bindAuth.status || 403).json({ success: false, error: bindAuth.error || "Access denied to this client." });
    }
    clientName = bindAuth.clientName || clientName;

    try {
      const data = await fetchNBToFindData(
        clientName || "Client",
        clientSheetId,
        bypassCache === "true" || bypassCache === true,
        { minBypassAgeMs: sessionUser.isAdmin ? 0 : 15000 }
      );
      return res.status(200).json(data);
    } catch (err) {
      console.error("Error in GET /api/pma/nbtofind:", err);
      return res.status(500).json({
        success: false,
        error: sessionUser.isAdmin ? (err.message || "Failed to load NB to find data") : sanitizeSpreadsheetTerms(err.message || "Failed to load NB to find data")
      });
    }
  }

  // 3. POST Request: Save changes
  if (req.method === "POST") {
    if (!assertTrustedOrigin(req, res)) return;
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify NB to find data." });
    }
    let {
      action,
      clientName,
      clientSheetId,
      sheetRow,
      useTargets,
      useBudgetForIncomeTargets,
      directCostsPercentage,
      monthlyValues,
    } = req.body || {};

    if (!clientSheetId && clientName) {
      try {
        const all = await getClients();
        const match = all.find((c) => c.clientName?.toLowerCase() === clientName.toLowerCase().trim());
        if (match) clientSheetId = match.clientSheetId;
      } catch (e) {
        console.warn("Failed to resolve client sheet in POST /api/pma/nbtofind:", e);
      }
    }

    if (!clientSheetId) {
      return res.status(400).json({ success: false, error: "Missing required clientSheetId." });
    }

    const sheets = await getSheetsClient();
    const bindAuth = await assertSetupClientSheetBinding(sessionUser, {
      clientName,
      clientSheetId,
      sheets,
    });
    if (!bindAuth.authorized) {
      return res.status(bindAuth.status || 403).json({ success: false, error: bindAuth.error || "Access denied to this client." });
    }
    clientName = bindAuth.clientName || clientName;

    try {
      // Action: save_settings (Cells A9, A12, and A21)
      if (action === "save_settings") {
        const result = await saveNBToFindSettings({
          clientName: clientName || "Client",
          clientSheetId,
          useTargets,
          useBudgetForIncomeTargets,
          directCostsPercentage,
          userEmail: sessionUser.email,
        });
        return res.status(200).json(result);
      }

      // Action: save_monthly_values (Row 3, Row 5, Row 10, or Row 25)
      if (action === "save_monthly_values") {
        if (!sheetRow) return res.status(400).json({ success: false, error: "sheetRow is required" });
        const result = await saveNBToFindMonthlyValues({
          clientName: clientName || "Client",
          clientSheetId,
          sheetRow,
          monthlyValues,
          cellNotes: req.body?.cellNotes,
          userEmail: sessionUser.email,
        });
        return res.status(200).json(result);
      }

      return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
    } catch (err) {
      console.error("Error in POST /api/pma/nbtofind:", err);
      return res.status(500).json({
        success: false,
        error: sessionUser.isAdmin ? (err.message || "Failed to save NB to find data") : sanitizeSpreadsheetTerms(err.message || "Failed to save NB to find data")
      });
    } finally {
      await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, clientName || "").catch(() => {});
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ success: false, error: `Method ${req.method} Not Allowed` });
}
