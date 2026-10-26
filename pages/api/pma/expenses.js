import { getSessionUser } from "../../../services/authService.js";
import {
  fetchExpensesData,
  saveExpenseMetadata,
  toggleExpenseDelivery,
  saveExpenseAmount,
  addExpenseCategory,
} from "../../../services/expensesService.js";
import { getClients } from "../../../services/workspaces.js";
import { verifyUserAuthorizedForSheet } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";

export default async function handler(req, res) {
  // 1. Authenticate user
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  // Enforce PMA access roles (Admins, ClientManagers)
  const isPulseOnly =
    sessionUser.role === "ClientUser" ||
    sessionUser.role === "Senior (Restricted)" ||
    Boolean(sessionUser.isSenior) ||
    (!sessionUser.isAdmin && sessionUser.role !== "ClientManager");

  if (isPulseOnly) {
    return res.status(403).json({ success: false, error: "Forbidden: Access restricted to Pulse Portal" });
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

    if (!sessionUser.isAdmin) {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }

    try {
      const data = await fetchExpensesData(
        clientName || "Client",
        clientSheetId,
        bypassCache === "true" || bypassCache === true
      );
      return res.status(200).json(data);
    } catch (err) {
      console.error("Error in GET /api/pma/expenses:", err);
      return res.status(500).json({ success: false, error: err.message || "Failed to load expenses data" });
    }
  }

  // 3. POST Request: Save changes
  if (req.method === "POST") {
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

    if (!sessionUser.isAdmin) {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }

    try {
      // Action: save_metadata (Category, VAT, Delivery %)
      if (action === "save_metadata") {
        if (!sheetRow) return res.status(400).json({ success: false, error: "sheetRow is required" });
        const result = await saveExpenseMetadata({
          clientName: clientName || "Client",
          clientSheetId,
          sheetRow,
          category,
          vat,
          deliveryPct,
          userEmail: sessionUser.email,
        });
        return res.status(200).json(result);
      }

      // Action: toggle_delivery (move between delivery and non-delivery)
      if (action === "toggle_delivery") {
        if (!sheetRow) return res.status(400).json({ success: false, error: "sheetRow is required" });
        const result = await toggleExpenseDelivery({
          clientName: clientName || "Client",
          clientSheetId,
          sheetRow,
          targetDelivery,
          userEmail: sessionUser.email,
        });
        return res.status(200).json(result);
      }

      // Action: save_amounts (update monthly expense amounts)
      if (action === "save_amounts") {
        if (!sheetRow) return res.status(400).json({ success: false, error: "sheetRow is required" });
        const result = await saveExpenseAmount({
          clientName: clientName || "Client",
          clientSheetId,
          sheetRow,
          monthlyAmounts,
          cellNotes: req.body?.cellNotes,
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
      return res.status(500).json({ success: false, error: err.message || "Failed to save expenses" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ success: false, error: `Method ${req.method} Not Allowed` });
}
