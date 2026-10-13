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

import { getSessionUser } from "../../../services/authService.js";
import {
  getIntegrationTokens,
  updateRefreshedTokens,
  getSharedXeroGrant,
  updateSharedXeroGrantTokens
} from "../../../services/vaultService.js";
import { fetchXeroBankAccounts, refreshXeroTokens } from "../../../services/xeroService.js";
import { fetchQuickBooksBankAccounts, refreshQBTokens } from "../../../services/quickbooksService.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  // 1. Authenticate user
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  // 2. Strict Admin-only check
  const isAdmin = Boolean(sessionUser.isAdmin || sessionUser.role === "Admin");
  if (!isAdmin) {
    return res.status(403).json({
      success: false,
      error: "Access denied: Bank accounts configuration is strictly restricted to Admins."
    });
  }

  const { clientName, masterSheetId, tool } = req.query;

  if (!clientName) {
    return res.status(400).json({
      success: false,
      error: "Missing required clientName parameter."
    });
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
            const refreshed = await refreshXeroTokens(record.tokens.refreshToken);
            accessToken = refreshed.accessToken;
            if (record.isSharedGrant) {
              await updateSharedXeroGrantTokens(refreshed);
            } else {
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "xero",
                tokens: refreshed
              });
            }
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
            const refreshed = await refreshQBTokens(record.tokens.refreshToken);
            accessToken = refreshed.accessToken;
            await updateRefreshedTokens({
              clientKey: record.clientKey,
              tool: "quickbooks",
              tokens: refreshed
            });
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
    return res.status(500).json({ success: false, error: err.message });
  }
}
