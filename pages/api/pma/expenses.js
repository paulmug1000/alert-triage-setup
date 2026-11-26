import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../services/authService.js";
import {
  fetchExpensesData,
  saveExpenseMetadata,
  toggleExpenseDelivery,
  saveExpenseAmount,
  saveExpenseBatch,
  addExpenseCategory,
} from "../../../services/expensesService.js";
import { getClients } from "../../../services/workspaces.js";
import { verifyUserAuthorizedForSheet, assertSetupClientSheetBinding, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
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

  // 2. GET Request: Fetch Expenses
  if (req.method === "GET") {
    let { clientName, clientSheetId, bypassCache } = req.query;

    if (!clientSheetId && clientName) {
      try {
        const all = await getClients();
        const match = all.find((c) => c.clientName?.toLowerCase() === clientName.toLowerCase().trim());
        if (match) clientSheetId = match.clientSheetId;
      } catch (e) {
        console.warn("Failed to resolve client sheet in GET /api/pma/expenses:", e);
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
      const data = await fetchExpensesData(
        clientName || "Client",
        clientSheetId,
        bypassCache === "true" || bypassCache === true,
        { minBypassAgeMs: sessionUser.isAdmin ? 0 : 15000 }
      );
      return res.status(200).json(data);
    } catch (err) {
      console.error("Error in GET /api/pma/expenses:", err);
      return res.status(500).json({
        success: false,
        error: sessionUser.isAdmin ? (err.message || "Failed to load expenses data") : sanitizeSpreadsheetTerms(err.message || "Failed to load expenses data")
      });
    }
  }

  // 3. POST Request: Save changes
  if (req.method === "POST") {
    if (!assertTrustedOrigin(req, res)) return;
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify expenses." });
    }
    let {
      action,
      clientName,
      clientSheetId,
      sheetRow,
      category,
      vat,
      deliveryPct,
      targetDelivery,
      monthlyAmounts,
    } = req.body || {};

    if (!clientSheetId && clientName) {
      try {
        const all = await getClients();
        const match = all.find((c) => c.clientName?.toLowerCase() === clientName.toLowerCase().trim());
        if (match) clientSheetId = match.clientSheetId;
      } catch (e) {
        console.warn("Failed to resolve client sheet in POST /api/pma/expenses:", e);
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
      const outgoingItemUuid = req.body?.outgoingItemUuid || null;
      // Action: save_metadata (Category, VAT, Delivery %)
      if (action === "save_metadata") {
        if (!sheetRow && !outgoingItemUuid) return res.status(400).json({ success: false, error: "sheetRow is required" });
        const result = await saveExpenseMetadata({
          clientName: clientName || "Client",
          clientSheetId,
          sheetRow,
          outgoingItemUuid,
          category,
          vat,
          deliveryPct,
          userEmail: sessionUser.email,
        });
        return res.status(200).json(result);
      }

      // Action: toggle_delivery (move between delivery and non-delivery)
      if (action === "toggle_delivery") {
        if (!sheetRow && !outgoingItemUuid) return res.status(400).json({ success: false, error: "sheetRow is required" });
        const result = await toggleExpenseDelivery({
          clientName: clientName || "Client",
          clientSheetId,
          sheetRow,
          outgoingItemUuid,
          targetDelivery,
          userEmail: sessionUser.email,
        });
        return res.status(200).json(result);
      }

      // Action: save_amounts (update monthly expense amounts)
      if (action === "save_amounts") {
        if (!sheetRow && !outgoingItemUuid) return res.status(400).json({ success: false, error: "sheetRow is required" });
        const result = await saveExpenseAmount({
          clientName: clientName || "Client",
          clientSheetId,
          sheetRow,
          outgoingItemUuid,
          monthlyAmounts,
          cellNotes: req.body?.cellNotes,
          userEmail: sessionUser.email,
        });
        return res.status(200).json(result);
      }

      // Action: save_batch (batch update amounts and notes across rows/columns)
      if (action === "save_batch") {
        const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
        const cellNotes = Array.isArray(req.body?.cellNotes) ? req.body.cellNotes : [];
        if (updates.length > 500 || cellNotes.length > 500) {
          return res.status(400).json({ success: false, error: "Batch update size exceeds maximum limit (500)." });
        }
        const result = await saveExpenseBatch({
          clientName: clientName || "Client",
          clientSheetId,
          updates,
          cellNotes,
          userEmail: sessionUser.email,
        });
        return res.status(200).json(result);
      }

      // Action: add_expense (add into first available empty row)
      if (action === "add_expense") {
        if (!category || !String(category).trim()) {
          return res.status(400).json({ success: false, error: "Category name is required" });
        }
        const result = await addExpenseCategory({
          clientName: clientName || "Client",
          clientSheetId,
          category,
          vat,
          deliveryPct,
          monthlyAmounts,
          userEmail: sessionUser.email,
        });
        return res.status(200).json(result);
      }

      return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
    } catch (err) {
      console.error("Error in POST /api/pma/expenses:", err);
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(status).json({
        success: false,
        error: sessionUser.isAdmin ? (err.message || "Failed to save expenses") : sanitizeSpreadsheetTerms(err.message || "Failed to save expenses")
      });
    } finally {
      await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, clientName || "").catch(() => { });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ success: false, error: `Method ${req.method} Not Allowed` });
}
