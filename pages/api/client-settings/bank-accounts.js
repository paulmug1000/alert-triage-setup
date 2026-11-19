/**
 * ============================================================================
 * BANK ACCOUNTS API: /api/client-settings/bank-accounts
 * ============================================================================
 * 
 * Fetches the active list of potential bank accounts directly from the client's
 * connected accounting tool (Xero or QuickBooks Online) using Vault credentials.
 * 
 * Strict Admin-only access.
 */

import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../services/authService.js";
import { sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";
import {
  canAccessPma,
  isUserAuthorizedForClient,
  verifyUserAuthorizedForSheet
} from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes } from "../../../services/masterEngineService.js";
import {
  getIntegrationTokens,
  refreshStoredIntegrationToken
} from "../../../services/vaultService.js";
import { fetchXeroBankAccounts, refreshXeroTokens } from "../../../services/xeroService.js";
import { fetchQuickBooksBankAccounts, refreshQBTokens } from "../../../services/quickbooksService.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const rl = await checkRateLimit("bank-accounts", getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
  }

  // 1. Authenticate user against live directory
  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  installSheetIdBoundary(req, res, sessionUser);

  // 2. Staff authorization check (Admin or ClientManager)
  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({
      success: false,
      error: "Access denied: PMA configuration requires staff privileges."
    });
  }

  const { clientName, masterSheetId, tool } = req.query;

  if (!clientName) {
    return res.status(400).json({
      success: false,
      error: "Missing required clientName parameter."
    });
  }

  // 3. Multi-tenant client authorization check
  if (!sessionUser.isAdmin) {
    if (!isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: Access denied to this client."
      });
    }
    if (masterSheetId) {
      const sheets = await getSheetsClient();
      const sheetAuth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, clientName, sheets);
      if (!sheetAuth.authorized) {
        return res.status(sheetAuth.status || 403).json({
          success: false,
          error: sheetAuth.error || "Forbidden: Spreadsheet access denied for this client."
        });
      }
    }
  }

  try {
    // Determine priority tool list
    const requestedTool = String(tool || "").trim().toLowerCase();
    const candidateTools = requestedTool && requestedTool !== "none"
      ? [requestedTool]
      : ["xero", "quickbooks"];

    let accounts = null;
    let resolvedTool = null;
    let failureReason = null;

    for (const currentTool of candidateTools) {
      const record = await getIntegrationTokens({
        clientKey: clientName,
        masterSheetId,
        tool: currentTool
      });

      if (!record || !record.tokens?.accessToken) {
        continue;
      }

      // Check token expiration (refresh if within 5 mins or expired)
      const now = Date.now();
      const expiresAt = record.expiresAt || 0;
      const isExpiringSoon = (expiresAt - now) < 300000;

      let accessToken = record.tokens.accessToken;

      if (currentTool === "xero") {
        if (isExpiringSoon && record.tokens.refreshToken) {
          try {
            console.log(`🔄 Bank Accounts: Refreshing Xero token for ${clientName}...`);
            const refreshed = await refreshStoredIntegrationToken({
              clientKey: record.clientKey || clientName,
              masterSheetId: masterSheetId || record.masterSheetId || "",
              tool: "xero",
              refreshFn: (latest) => refreshXeroTokens(latest.tokens.refreshToken)
            });
            accessToken = refreshed.accessToken;
          } catch (refErr) {
            console.warn("⚠️ Bank Accounts: Failed to refresh Xero token:", refErr.message);
          }
        }

        const tenantId = record.tenantId;
        if (!tenantId) {
          failureReason = `Xero organisation / tenant ID is missing for client "${clientName}".`;
          continue;
        }

        try {
          const xeroAccounts = await fetchXeroBankAccounts(accessToken, tenantId);
          accounts = xeroAccounts;
          resolvedTool = "Xero";
          break;
        } catch (callErr) {
          console.warn(`⚠️ Bank Accounts: Xero fetch error for ${clientName}:`, callErr.message);
          failureReason = callErr.message;
        }
      } else if (currentTool === "quickbooks" || currentTool === "qb") {
        if (isExpiringSoon && record.tokens.refreshToken) {
          try {
            console.log(`🔄 Bank Accounts: Refreshing QuickBooks token for ${clientName}...`);
            const refreshed = await refreshStoredIntegrationToken({
              clientKey: record.clientKey || clientName,
              masterSheetId: masterSheetId || record.masterSheetId || "",
              tool: "quickbooks",
              refreshFn: (latest) => refreshQBTokens(latest.tokens.refreshToken)
            });
            accessToken = refreshed.accessToken;
          } catch (refErr) {
            console.warn("⚠️ Bank Accounts: Failed to refresh QuickBooks token:", refErr.message);
          }
        }

        const realmId = record.realmId || record.tenantId;
        if (!realmId) {
          failureReason = `QuickBooks company ID (realmId) is missing for client "${clientName}".`;
          continue;
        }

        try {
          const qbAccounts = await fetchQuickBooksBankAccounts(accessToken, realmId);
          accounts = qbAccounts;
          resolvedTool = "QuickBooks";
          break;
        } catch (callErr) {
          console.warn(`⚠️ Bank Accounts: QuickBooks fetch error for ${clientName}:`, callErr.message);
          failureReason = callErr.message;
        }
      }
    }

    if (accounts === null) {
      return res.status(404).json({
        success: false,
        error: failureReason || `No active Xero or QuickBooks integration connection found for "${clientName}". Please ensure the accounting tool is connected in PMA > Integrations.`
      });
    }

    return res.status(200).json({
      success: true,
      tool: resolvedTool,
      clientName,
      accounts
    });
  } catch (err) {
    console.error("GET /api/client-settings/bank-accounts fatal error:", err);
    return res.status(500).json({
      success: false,
      error: sessionUser.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Failed to load bank accounts.")
    });
  } finally {
    await flushImmediateAndScheduleBackgroundClientRecomputes().catch(() => {});
  }
}
