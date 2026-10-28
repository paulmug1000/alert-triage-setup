import { getSessionUser } from "../../../services/authService.js";
import { fetchCashData, saveCashBatch, saveCashCellNote } from "../../../services/cashEditService.js";
import { getClients } from "../../../services/workspaces.js";
import { verifyUserAuthorizedForSheet, canAccessPma, isReadOnlySession, getCanonicalAcSheetId } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";

export default async function handler(req, res) {
  // 1. Authenticate user
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Forbidden: Access restricted to Pulse Portal" });
  }

  installSheetIdBoundary(req, res, sessionUser);

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

    if (!sessionUser.isAdmin) {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }

    try {
      const data = await fetchCashData(
        clientName || "Client",
        clientSheetId,
        bypassCache === "true" || bypassCache === true
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
      return res.status(500).json({ success: false, error: err.message || "Failed to load cash data" });
    }
  }

  // 3. POST: Save Changes (Batch of cells or Note)
  if (req.method === "POST") {
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

    if (!sessionUser.isAdmin) {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
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
        isAdmin: Boolean(sessionUser.isAdmin),
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error("Error in POST /api/pma/cash:", err);
      return res.status(500).json({ success: false, error: err.message || "Failed to save cash changes" });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
