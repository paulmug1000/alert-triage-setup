import { getSessionUser } from "../../../services/authService.js";
import {
  fetchNBToFindData,
  saveNBToFindSettings,
  saveNBToFindMonthlyValues,
} from "../../../services/nbToFindService.js";
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

    if (!sessionUser.isAdmin) {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }

    try {
      const data = await fetchNBToFindData(
        clientName || "Client",
        clientSheetId,
        bypassCache === "true" || bypassCache === true
      );
      return res.status(200).json(data);
    } catch (err) {
      console.error("Error in GET /api/pma/nbtofind:", err);
      return res.status(500).json({ success: false, error: err.message || "Failed to load NB to find data" });
    }
  }

  // 3. POST Request: Save changes
  if (req.method === "POST") {
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

    if (!sessionUser.isAdmin) {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }

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
      return res.status(500).json({ success: false, error: err.message || "Failed to save NB to find data" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ success: false, error: `Method ${req.method} Not Allowed` });
}
