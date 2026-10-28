import { getSessionUser } from "../../../services/authService.js";
import {
  getSalariesData,
  saveEmployeeData,
  saveSalaryAmountOverride,
  saveDividendsData,
} from "../../../services/salariesService.js";
import { getClients } from "../../../services/workspaces.js";
import { verifyUserAuthorizedForSheet, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";

export default async function handler(req, res) {
  // 1. Authenticate user
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Forbidden: Access restricted to Pulse Portal" });
  }

  // 2. GET Request: Fetch Salaries & Dividends
  if (req.method === "GET") {
    let { clientName, masterSheetId, clientSheetId, bypassCache } = req.query;

    if (!masterSheetId || !clientSheetId) {
      if (clientName) {
        try {
          const all = await getClients();
          const match = all.find((c) => c.clientName?.toLowerCase() === clientName.toLowerCase().trim());
          if (match) {
            masterSheetId = masterSheetId || match.masterSheetId;
            clientSheetId = clientSheetId || match.clientSheetId;
          }
        } catch (e) {
          console.warn("Failed to resolve client sheets in GET /api/pma/salaries:", e);
        }
      }
    }

    if (!masterSheetId || !clientSheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing required masterSheetId or clientSheetId parameter.",
      });
    }

    if (!sessionUser.isAdmin) {
      const sheets = await getSheetsClient();
      const masterAuth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, clientName, sheets);
      if (!masterAuth.authorized) {
        return res.status(masterAuth.status || 403).json({ success: false, error: masterAuth.error || "Access denied to this client." });
      }
      const clientAuth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
      if (!clientAuth.authorized) {
        return res.status(clientAuth.status || 403).json({ success: false, error: clientAuth.error || "Access denied to this client." });
      }
    }

    try {
      const data = await getSalariesData({
        clientName: clientName || "Client",
        masterSheetId,
        clientSheetId,
        bypassCache: bypassCache === "true" || bypassCache === true,
      });

      return res.status(200).json(data);
    } catch (err) {
      console.error("Error in GET /api/pma/salaries:", err);
      return res.status(500).json({ success: false, error: err.message || "Failed to load salaries data" });
    }
  }

  // 3. POST Request: Save modifications
  if (req.method === "POST") {
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify salaries." });
    }
    const { action, clientName, masterSheetId, clientSheetId } = req.body || {};

    if (!masterSheetId && !clientSheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing required masterSheetId or clientSheetId parameter.",
      });
    }

    if (!sessionUser.isAdmin) {
      const sheets = await getSheetsClient();
      if (masterSheetId) {
        const masterAuth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, clientName, sheets);
        if (!masterAuth.authorized) {
          return res.status(masterAuth.status || 403).json({ success: false, error: masterAuth.error || "Access denied to this client." });
        }
      }
      if (clientSheetId) {
        const clientAuth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
        if (!clientAuth.authorized) {
          return res.status(clientAuth.status || 403).json({ success: false, error: clientAuth.error || "Access denied to this client." });
        }
      }
    }

    try {
      if (action === "save_employee") {
        const { sheetRow, employeeData } = req.body;
        const result = await saveEmployeeData({
          masterSheetId,
          clientSheetId,
          clientName: clientName || "Client",
          sheetRow: parseInt(sheetRow, 10),
          employeeData,
          sessionUser,
        });
        return res.status(200).json(result);
      }

      if (action === "save_amount_override") {
        const { sheetRow, colLetterStart, amounts } = req.body;
        const result = await saveSalaryAmountOverride({
          masterSheetId,
          clientSheetId,
          clientName: clientName || "Client",
          sheetRow: parseInt(sheetRow, 10),
          colLetterStart,
          amounts,
          sessionUser,
        });
        return res.status(200).json(result);
      }

      if (action === "save_dividends") {
        const { sheetRow, deliveryPct, monthlyAmounts, description } = req.body;
        const result = await saveDividendsData({
          clientSheetId,
          masterSheetId,
          clientName: clientName || "Client",
          sheetRow: parseInt(sheetRow || 118, 10),
          deliveryPct,
          monthlyAmounts,
          description,
          sessionUser,
        });
        return res.status(200).json(result);
      }

      return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
    } catch (err) {
      console.error(`Error in POST /api/pma/salaries (action=${action}):`, err);
      return res.status(500).json({ success: false, error: err.message || "Failed to save salaries data" });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed. Use GET or POST." });
}
