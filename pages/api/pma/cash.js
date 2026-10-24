import { getSessionUser } from "../../../services/authService.js";
import { fetchCashData, saveCashBatch, saveCashCellNote } from "../../../services/cashEditService.js";
import { getClients } from "../../../services/workspaces.js";

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

    try {
      const data = await fetchCashData(
        clientName || "Client",
        clientSheetId,
        bypassCache === "true" || bypassCache === true
      );
      return res.status(200).json(data);
    } catch (err) {
      console.error("Error in GET /api/pma/cash:", err);
      return res.status(500).json({ success: false, error: err.message || "Failed to load cash data" });
    }
  }

  // 3. POST: Save Changes (Batch of cells or Note)
  if (req.method === "POST") {
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
      automationCommanderSheetId,
    } = req.body || {};

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

      // Default action: save_batch
      const result = await saveCashBatch({
        clientName: clientName || "Client",
        clientSheetId,
        updates: updates || [],
        cellNotes: cellNotes || [],
        userEmail: sessionUser.email,
        automationCommanderSheetId,
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error("Error in POST /api/pma/cash:", err);
      return res.status(500).json({ success: false, error: err.message || "Failed to save cash changes" });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
