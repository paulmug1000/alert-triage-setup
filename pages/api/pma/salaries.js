import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../services/authService.js";
import {
  getSalariesData,
  saveEmployeeData,
  saveSalaryAmountOverride,
  saveDividendsData,
} from "../../../services/salariesService.js";
import { getClients } from "../../../services/workspaces.js";
import { verifyUserAuthorizedForSheet, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
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

  // 2. GET Request: Fetch Salaries & Dividends
  if (req.method === "GET") {
    let { clientName, masterSheetId, clientSheetId, bypassCache } = req.query;

    if (!clientSheetId && clientName) {
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

    if (!clientSheetId && !masterSheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing required clientSheetId parameter.",
      });
    }

    if (!sessionUser.isAdmin) {
      const sheets = await getSheetsClient();
      let boundClient = clientName;
      if (masterSheetId) {
        const masterAuth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, boundClient, sheets);
        if (!masterAuth.authorized) {
          return res.status(masterAuth.status || 403).json({ success: false, error: masterAuth.error || "Access denied to this client." });
        }
        boundClient = masterAuth.clientName || boundClient;
      }
      if (clientSheetId) {
        const clientAuth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, boundClient, sheets);
        if (!clientAuth.authorized) {
          return res.status(clientAuth.status || 403).json({ success: false, error: clientAuth.error || "Access denied to this client." });
        }
        boundClient = clientAuth.clientName || boundClient;
      }
      clientName = boundClient || clientName;
    }

    try {
      const data = await getSalariesData({
        clientName: clientName || "Client",
        masterSheetId,
        clientSheetId,
        bypassCache: (bypassCache === "true" || bypassCache === true) && !isReadOnlySession(sessionUser),
        minBypassAgeMs: sessionUser.isAdmin ? 0 : 15000,
      });

      return res.status(200).json(data);
    } catch (err) {
      console.error("Error in GET /api/pma/salaries:", err);
      return res.status(500).json({
        success: false,
        error: sessionUser.isAdmin ? (err.message || "Failed to load salaries data") : sanitizeSpreadsheetTerms(err.message || "Failed to load salaries data")
      });
    }
  }

  // 3. POST Request: Save modifications
  if (req.method === "POST") {
    if (!assertTrustedOrigin(req, res)) return;
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify salaries." });
    }
    let { action, clientName, masterSheetId, clientSheetId } = req.body || {};

    if (!masterSheetId && !clientSheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing required masterSheetId or clientSheetId parameter.",
      });
    }

    if (!sessionUser.isAdmin) {
      const sheets = await getSheetsClient();
      let boundClient = clientName;
      if (masterSheetId) {
        const masterAuth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, boundClient, sheets);
        if (!masterAuth.authorized) {
          return res.status(masterAuth.status || 403).json({ success: false, error: masterAuth.error || "Access denied to this client." });
        }
        boundClient = masterAuth.clientName || boundClient;
      }
      if (clientSheetId) {
        const clientAuth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, boundClient, sheets);
        if (!clientAuth.authorized) {
          return res.status(clientAuth.status || 403).json({ success: false, error: clientAuth.error || "Access denied to this client." });
        }
        boundClient = clientAuth.clientName || boundClient;
      }
      clientName = boundClient || clientName;
    }

    try {
      if (action === "save_employee") {
        const { sheetRow, employeeUuid, employeeData } = req.body;
        const result = await saveEmployeeData({
          masterSheetId,
          clientSheetId,
          clientName: clientName || "Client",
          sheetRow: sheetRow !== undefined && sheetRow !== null ? parseInt(sheetRow, 10) : null,
          employeeUuid: employeeUuid || null,
          employeeData,
          sessionUser,
        });
        return res.status(200).json(result);
      }

      if (action === "save_amount_override") {
        const { sheetRow, employeeUuid, colLetterStart, amounts } = req.body;
        const result = await saveSalaryAmountOverride({
          masterSheetId,
          clientSheetId,
          clientName: clientName || "Client",
          sheetRow: sheetRow !== undefined && sheetRow !== null ? parseInt(sheetRow, 10) : null,
          employeeUuid: employeeUuid || null,
          colLetterStart,
          amounts,
          sessionUser,
        });
        return res.status(200).json(result);
      }

      if (action === "save_dividends") {
        const { sheetRow, outgoingItemUuid, deliveryPct, monthlyAmounts, description } = req.body;
        const result = await saveDividendsData({
          clientSheetId,
          masterSheetId,
          clientName: clientName || "Client",
          sheetRow: parseInt(sheetRow || 118, 10),
          outgoingItemUuid: outgoingItemUuid || null,
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
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      return res.status(status).json({
        success: false,
        error: sessionUser.isAdmin ? (err.message || "Failed to save salaries data") : sanitizeSpreadsheetTerms(err.message || "Failed to save salaries data")
      });
    } finally {
      await flushImmediateAndScheduleBackgroundClientRecomputes().catch(() => {});
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed. Use GET or POST." });
}
