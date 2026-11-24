import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../services/authService.js";
import { fetchCashData, saveCashBatch, saveCashCellNote, saveCashBankBreakdown } from "../../../services/cashEditService.js";
import { getClients } from "../../../services/workspaces.js";
import { assertSetupClientSheetBinding, canAccessPma, isReadOnlySession, getCanonicalAcSheetId } from "../../../services/userPermissions.js";
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

  // 2. GET: Fetch Cash Edit Data (36 Months)
  if (req.method === "GET") {
    let { clientName, clientSheetId, bypassCache } = req.query;

    if (!clientSheetId && clientName) {
      try {
        const all = await getClients();
        const match = all.find((c) => c.clientName?.toLowerCase() === clientName.toLowerCase().trim());
        if (match) clientSheetId = match.clientSheetId;
      } catch (e) {
        console.warn("Failed to resolve client sheet in GET /api/pma/cash:", e);
      }
    }

    if (!clientSheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing required clientSheetId parameter.",
      });
    }

    const sheets = await getSheetsClient();
    const binding = await assertSetupClientSheetBinding(sessionUser, {
      clientName: clientName || "",
      clientSheetId,
      sheets,
    });
    if (!binding.authorized) {
      return res.status(binding.status || 403).json({ success: false, error: binding.error || "Access denied to this client." });
    }
    clientName = binding.clientName || clientName;

    try {
      const data = await fetchCashData(
        clientName || "Client",
        clientSheetId,
        bypassCache === "true" || bypassCache === true,
        { minBypassAgeMs: sessionUser.isAdmin ? 0 : 15000 }
      );
      if (!sessionUser.isAdmin && data) {
        const stripFormulas = (rows) => (rows || []).map(row => ({
          ...row,
          cells: (row.cells || []).map(({ formula, cellRef, colLetter, ...rest }) => ({
            ...rest,
            formula: "",
          })),
        }));
        return res.status(200).json({
          ...data,
          table1Rows: stripFormulas(data.table1Rows),
          table2Rows: stripFormulas(data.table2Rows),
        });
      }
      return res.status(200).json(data);
    } catch (err) {
      console.error("Error in GET /api/pma/cash:", err);
      return res.status(500).json({
        success: false,
        error: sessionUser.isAdmin ? (err.message || "Failed to load cash data") : sanitizeSpreadsheetTerms(err.message || "Failed to load cash data")
      });
    }
  }

  // 3. POST: Save Changes (Batch of cells, Note, or Bank Breakdown)
  if (req.method === "POST") {
    if (!assertTrustedOrigin(req, res)) return;
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify cash data." });
    }
    let {
      action,
      clientName,
      clientSheetId,
      updates,
      cellNotes,
      sheetRow,
      colIdx,
      colLetter,
      note,
      monthKey,
      accounts,
      clear,
    } = req.body || {};
    const automationCommanderSheetId = getCanonicalAcSheetId();

    if (!clientSheetId && clientName) {
      try {
        const all = await getClients();
        const match = all.find((c) => c.clientName?.toLowerCase() === clientName.toLowerCase().trim());
        if (match) clientSheetId = match.clientSheetId;
      } catch (e) {
        console.warn("Failed to resolve client sheet in POST /api/pma/cash:", e);
      }
    }

    if (!clientSheetId) {
      return res.status(400).json({ success: false, error: "Missing required clientSheetId." });
    }

    const sheets = await getSheetsClient();
    const binding = await assertSetupClientSheetBinding(sessionUser, {
      clientName: clientName || "",
      clientSheetId,
      sheets,
    });
    if (!binding.authorized) {
      return res.status(binding.status || 403).json({ success: false, error: binding.error || "Access denied to this client." });
    }
    clientName = binding.clientName || clientName;

    try {
      if (action === "save_note") {
        if (!sheetRow) return res.status(400).json({ success: false, error: "sheetRow is required" });
        const result = await saveCashCellNote({
          clientName: clientName || "Client",
          clientSheetId,
          sheetRow,
          colIdx,
          colLetter,
          note,
          userEmail: sessionUser.email,
          automationCommanderSheetId,
        });
        return res.status(200).json(result);
      }

      if (action === "save_bank_breakdown") {
        if (!monthKey || !/^\d{4}-\d{2}$/.test(String(monthKey).trim())) {
          return res.status(400).json({ success: false, error: "Valid monthKey (YYYY-MM) is required." });
        }
        if (!clear) {
          if (!Array.isArray(accounts) || accounts.length === 0) {
            return res.status(400).json({ success: false, error: "At least one bank account balance is required." });
          }
          if (accounts.length > 30) {
            return res.status(400).json({ success: false, error: "Too many bank accounts in request (max 30)." });
          }
        }
        const result = await saveCashBankBreakdown({
          clientName: clientName || "Client",
          clientSheetId,
          monthKey: String(monthKey).trim(),
          accounts: Array.isArray(accounts) ? accounts : [],
          clear: Boolean(clear),
          userEmail: sessionUser.email,
          automationCommanderSheetId,
        });
        return res.status(200).json(result);
      }

      if (Array.isArray(updates) && updates.length > 500) {
        return res.status(400).json({ success: false, error: "Too many cell updates in batch (max 500)." });
      }
      if (Array.isArray(cellNotes) && cellNotes.length > 500) {
        return res.status(400).json({ success: false, error: "Too many cell notes in batch (max 500)." });
      }

      // Default action: save_batch
      const result = await saveCashBatch({
        clientName: clientName || "Client",
        clientSheetId,
        updates: Array.isArray(updates) ? updates : [],
        cellNotes: Array.isArray(cellNotes) ? cellNotes : [],
        userEmail: sessionUser.email,
        automationCommanderSheetId,
        isAdmin: Boolean(sessionUser.isAdmin),
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error("Error in POST /api/pma/cash:", err);
      return res.status(500).json({
        success: false,
        error: sessionUser.isAdmin ? (err.message || "Failed to save cash changes") : sanitizeSpreadsheetTerms(err.message || "Failed to save cash changes")
      });
    } finally {
      await flushImmediateAndScheduleBackgroundClientRecomputes().catch(() => {});
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
