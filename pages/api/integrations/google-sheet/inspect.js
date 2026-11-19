/**
 * ============================================================================
 * GOOGLE SHEET INSPECT API ROUTE: /api/integrations/google-sheet/inspect
 * ============================================================================
 * 
 * Inspects a Google Sheet by URL or ID.
 * Returns title, available worksheets/tabs, headers, and row counts.
 */

import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../../services/authService.js";
import { isUserAuthorizedForClient, isReadOnlySession } from "../../../../services/userPermissions.js";
import { extractSheetIdFromUrl } from "../../../../services/sheetsClient.js";
import { inspectGoogleSpreadsheet, refreshGoogleSheetTokens } from "../../../../services/googleSheetService.js";
import { getIntegrationTokens, refreshStoredIntegrationToken, isOAuthReconnectError } from "../../../../services/vaultService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../../utils/helpers.js";

export const config = {
  maxDuration: 120,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }
  if (!assertTrustedOrigin(req, res)) return;
  res.setHeader("Cache-Control", "no-store");

  const rl = await checkRateLimit("gsheet-int", getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
  }

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Read-only session cannot inspect external spreadsheets." });
  }
  if (sessionUser.isSenior || sessionUser.role === "Senior (Restricted)") {
    return res.status(403).json({ success: false, error: "Restricted users cannot modify integrations." });
  }

  const { url, sheetId, clientKey, tabName, headerRowNum } = req.body || {};

  if (!sessionUser.isAdmin && (!clientKey || !isUserAuthorizedForClient(sessionUser, clientKey))) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  if (!url && !sheetId) {
    return res.status(400).json({ success: false, error: "Missing url or sheetId parameter" });
  }

  try {
    // Check if client has a stored OAuth access token in Vault
    let accessToken = null;
    if (clientKey) {
      const grant = await getIntegrationTokens({ clientKey, tool: "googlesheet" });
      if (grant?.reconnectRequired) {
        return res.status(200).json({
          success: false,
          reconnectRequired: true,
          error: "Your Google authorisation has expired or been revoked. Please sign in with Google again to re-authorise access."
        });
      }
      if (grant?.tokens?.accessToken && !grant.tokens.accessToken.startsWith("manual_")) {
        const grantOwner = String(grant.metadata?.userEmail || "").toLowerCase().trim();
        const callerEmail = String(sessionUser.email || "").toLowerCase().trim();
        if (!grantOwner || callerEmail !== grantOwner) {
          const linkedSheetId = String(grant.metadata?.spreadsheetId || "").trim();
          const requestedSheetId = extractSheetIdFromUrl(url || sheetId) || String(sheetId || "").trim();
          if (!linkedSheetId || !requestedSheetId || requestedSheetId !== linkedSheetId) {
            return res.status(403).json({
              success: false,
              error: "Please authorise with your own Google account to inspect a different spreadsheet."
            });
          }
        }
        // If expired or expiring within 5 minutes, refresh automatically with concurrency lock
        const isExpiring = !grant.expiresAt || Date.now() > (grant.expiresAt - 300000);
        if (isExpiring && grant.tokens.refreshToken) {
          try {
            const refreshed = await refreshStoredIntegrationToken({
              clientKey: grant.clientKey || clientKey,
              masterSheetId: grant.masterSheetId || "",
              tool: "googlesheet",
              refreshFn: (latest) => refreshGoogleSheetTokens(latest.tokens.refreshToken)
            });
            accessToken = refreshed.accessToken;
          } catch (rErr) {
            console.warn("Could not refresh Google Sheet token before inspect:", rErr.message);
            if (isOAuthReconnectError(rErr)) {
              return res.status(200).json({
                success: false,
                reconnectRequired: true,
                error: "Your Google authorisation has expired or been revoked. Please sign in with Google again to re-authorise access."
              });
            }
            accessToken = grant.tokens.accessToken;
          }
        } else {
          accessToken = grant.tokens.accessToken;
        }
      }
    }

    const inspection = await inspectGoogleSpreadsheet({
      url,
      sheetId,
      accessToken,
      tabName,
      headerRowNum,
      clientKey,
      isAdmin: Boolean(sessionUser.isAdmin),
      allowServiceAccountFallback: Boolean(sessionUser?.isAdmin)
    });

    return res.status(200).json({
      success: true,
      ...inspection
    });
  } catch (err) {
    console.error("Error inspecting Google Sheet:", err);
    return res.status(200).json({
      success: false,
      error: sessionUser.isAdmin ? (err.message || "Failed to inspect Google Sheet") : sanitizeSpreadsheetTerms(err.message || "Failed to inspect external source")
    });
  }
}
