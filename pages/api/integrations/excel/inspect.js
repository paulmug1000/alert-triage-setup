/**
 * ============================================================================
 * MICROSOFT EXCEL INSPECT API ROUTE: /api/integrations/excel/inspect
 * ============================================================================
 * 
 * Inspects a remote Microsoft Excel workbook via Microsoft Graph API.
 * Returns available worksheets, used range address, and headers.
 */

import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../../services/authService.js";
import { isUserAuthorizedForClient, isReadOnlySession } from "../../../../services/userPermissions.js";
import { inspectExcelWorkbook, refreshExcelTokens } from "../../../../services/excelIntegrationService.js";
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

  const rl = await checkRateLimit("excel-int", getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
  }

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Read-only session cannot inspect external workbooks." });
  }
  if (sessionUser.isSenior || sessionUser.role === "Senior (Restricted)") {
    return res.status(403).json({ success: false, error: "Restricted users cannot modify integrations." });
  }

  const {
    url,
    driveId,
    fileId,
    sheetName = "",
    clientKey,
    tenantId,
    clientId,
    clientSecret,
    headerRowNum
  } = req.body || {};

  if (!sessionUser.isAdmin && (!clientKey || !isUserAuthorizedForClient(sessionUser, clientKey))) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  if (!driveId && !fileId && !url) {
    return res.status(400).json({ success: false, error: "Missing url, driveId, or fileId parameter" });
  }

  try {
    let token = null;
    let azureCredentials = null;
    let grant = null;

    if (clientKey) {
      grant = await getIntegrationTokens({ clientKey, tool: "excel" });
      if (grant?.reconnectRequired) {
        return res.status(200).json({
          success: false,
          reconnectRequired: true,
          error: "Your Microsoft 365 authorisation has expired or been revoked. Please sign in again to re-authorise access."
        });
      }
      if (grant?.tokens?.accessToken && !grant.tokens.accessToken.startsWith("manual_")) {
        // Prevent non-owner users (including staff) from browsing unrelated workbooks across the authorizer's M365 tenant
        const grantOwner = String(grant.metadata?.authorizedByPulseEmail || grant.metadata?.userEmail || "").toLowerCase().trim();
        const callerEmail = String(sessionUser.email || "").toLowerCase().trim();
        if (!grantOwner || callerEmail !== grantOwner) {
          const linkedDrive = String(grant.metadata?.driveId || "").trim();
          const linkedFile = String(grant.metadata?.fileId || "").trim();
          const matchesLinked =
            linkedDrive &&
            linkedFile &&
            (!driveId || String(driveId).trim() === linkedDrive) &&
            (!fileId || String(fileId).trim() === linkedFile) &&
            !url;
          if (!matchesLinked) {
            return res.status(403).json({
              success: false,
              error: "Please authorise with your own Microsoft account to inspect a different workbook."
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
              tool: "excel",
              refreshFn: (latest) =>
                refreshExcelTokens(
                  latest.tokens.refreshToken,
                  latest?.metadata?.azureTenantId || grant.metadata?.azureTenantId
                )
            });
            token = refreshed.accessToken;
          } catch (rErr) {
            console.warn("Could not refresh Excel token before inspect:", rErr.message);
            if (isOAuthReconnectError(rErr)) {
              return res.status(200).json({
                success: false,
                reconnectRequired: true,
                error: "Your Microsoft 365 authorisation has expired or been revoked. Please sign in again to re-authorise access."
              });
            }
            token = grant.tokens.accessToken;
          }
        } else {
          token = grant.tokens.accessToken;
        }
      }
    }

    if (!token && sessionUser.isAdmin && tenantId && clientId && clientSecret) {
      azureCredentials = { tenantId, clientId, clientSecret };
    }

    const inspection = await inspectExcelWorkbook({
      url,
      driveId,
      fileId,
      sheetName,
      token,
      azureCredentials,
      headerRowNum
    });

    return res.status(200).json({
      success: true,
      ...inspection
    });
  } catch (err) {
    console.error("Error inspecting Excel workbook:", err);
    return res.status(200).json({
      success: false,
      error: sessionUser?.isAdmin ? (err.message || "Failed to inspect Excel workbook") : sanitizeSpreadsheetTerms(err.message || "Failed to inspect Excel workbook")
    });
  }
}
