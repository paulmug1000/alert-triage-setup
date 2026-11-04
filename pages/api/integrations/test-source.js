/**
 * ============================================================================
 * SPREADSHEET SOURCE TEST API ROUTE: /api/integrations/test-source
 * ============================================================================
 * 
 * Tests live connection for non-third-party spreadsheet integrations:
 * - Google Sheet (KeyInfo!X14:X15)
 * - Microsoft Excel via Azure Graph API (KeyInfo!X33:X41)
 */

import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, extractSheetIdFromUrl, withRetry } from "../../../services/sheetsClient.js";
import { getIntegrationTokens, updateRefreshedTokens } from "../../../services/vaultService.js";
import { verifyUserAuthorizedForSheet, isReadOnlySession } from "../../../services/userPermissions.js";
import { assertExternalCrmSpreadsheet, inspectGoogleSpreadsheet, refreshGoogleSheetTokens } from "../../../services/googleSheetService.js";
import { assertSafeGraphId } from "../../../services/excelIntegrationService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Read-only session cannot test integration sources." });
  }

  installSheetIdBoundary(req, res, sessionUser);

  const { clientKey, masterSheetId, tool = "", category = "crm" } = req.method === "POST" ? req.body : req.query;

  if (!masterSheetId) {
    return res.status(400).json({ success: false, error: "Missing masterSheetId parameter" });
  }

  const sheets = await getSheetsClient();

  if (!sessionUser.isAdmin) {
    try {
      const auth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, clientKey, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error });
      }
    } catch (authErr) {
      return res.status(403).json({ success: false, error: "Access denied to this sheet." });
    }
  }

  const toolClean = String(tool || "").trim().toLowerCase();

  try {
    if (toolClean.includes("sheet")) {
      // 1. Google Sheet source check (X11: URL, X12: Tab, with fallback to legacy X14:X15)
      const kiRes = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: masterSheetId,
          range: "KeyInfo!X11:X15"
        })
      );
      const rows = kiRes.data.values || [];
      const x11Url = (rows[0] && rows[0][0]) ? String(rows[0][0]).trim() : "";
      const x12Tab = (rows[1] && rows[1][0]) ? String(rows[1][0]).trim() : "";
      const x14Url = (rows[3] && rows[3][0]) ? String(rows[3][0]).trim() : "";
      const x15Tab = (rows[4] && rows[4][0]) ? String(rows[4][0]).trim() : "";

      const url = x11Url || x14Url;
      const tabName = x12Tab || x15Tab;

      if (!url) {
        return res.status(200).json({
          success: false,
          error: sessionUser.isAdmin ? "No Google Sheet URL configured in KeyInfo (X11)." : "No external Google Sheet URL configured."
        });
      }

      const targetSheetId = extractSheetIdFromUrl(url);
      if (!targetSheetId) {
        return res.status(200).json({
          success: false,
          error: `Could not parse spreadsheet ID from URL: ${url}`
        });
      }

      // Enforce blocklist against internal Pulse control-plane and tenant spreadsheets (CRIT-03)
      try {
        await assertExternalCrmSpreadsheet(sheets, targetSheetId);
      } catch (blockErr) {
        return res.status(403).json({
          success: false,
          error: blockErr.message || "Access denied to internal spreadsheet."
        });
      }

      // Obtain OAuth token from Vault if connected via Google Sign-In / Picker (drive.file)
      let gsAccessToken = null;
      if (clientKey || masterSheetId) {
        const grant = await getIntegrationTokens({ clientKey, masterSheetId, tool: "googlesheet" }).catch(() => null);
        if (grant && grant.tokens?.accessToken && !grant.tokens.accessToken.startsWith("manual_")) {
          const isExpiring = grant.expiresAt && Date.now() > (grant.expiresAt - 60000);
          if (isExpiring && grant.tokens.refreshToken) {
            try {
              const refreshed = await refreshGoogleSheetTokens(grant.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: grant.clientKey || clientKey,
                tool: "googlesheet",
                tokens: {
                  ...grant.tokens,
                  accessToken: refreshed.accessToken,
                  expiresIn: refreshed.expiresIn,
                  expiresAt: Date.now() + (refreshed.expiresIn * 1000)
                }
              });
              gsAccessToken = refreshed.accessToken;
            } catch {
              gsAccessToken = grant.tokens.accessToken;
            }
          } else {
            gsAccessToken = grant.tokens.accessToken;
          }
        }
      }

      try {
        const inspection = await inspectGoogleSpreadsheet({
          url,
          sheetId: targetSheetId,
          accessToken: gsAccessToken,
          tabName: tabName || null,
          clientKey,
          isAdmin: Boolean(sessionUser.isAdmin)
        });
        const availableTabs = (inspection.tabs || []).map(t => t.title || "");
        if (tabName && !availableTabs.includes(tabName)) {
          return res.status(200).json({
            success: false,
            error: `Tab "${tabName}" not found in remote sheet. Available tabs: ${availableTabs.slice(0, 5).join(", ")}${availableTabs.length > 5 ? "..." : ""}`
          });
        }
        return res.status(200).json({
          success: true,
          verified: true,
          tool: "Google Sheet",
          sheetTitle: inspection.title || "Connected Sheet",
          tabName: tabName || inspection.selectedTab || availableTabs[0] || "Sheet1",
          headerCount: (inspection.headers || []).length,
          hasSystemId: Boolean(inspection.hasSystemId),
          message: `Successfully connected to remote Google Sheet "${inspection.title || targetSheetId}" (Tab: "${tabName || inspection.selectedTab || availableTabs[0]}", ${(inspection.headers || []).length} columns detected${inspection.hasSystemId ? ", System ID header present" : ""}).`
        });
      } catch (accessErr) {
        return res.status(200).json({
          success: false,
          error: sessionUser.isAdmin ? accessErr.message : sanitizeSpreadsheetTerms(accessErr.message)
        });
      }
    }

    if (toolClean.includes("excel")) {
      // 2. Microsoft Excel / Azure Graph API check
      const kiRes = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: masterSheetId,
          range: "KeyInfo!X33:X41"
        })
      );
      const rows = kiRes.data.values || [];
      const tenantId = (rows[0] && rows[0][0]) ? String(rows[0][0]).trim() : "";
      const clientId = (rows[1] && rows[1][0]) ? String(rows[1][0]).trim() : "";
      const clientSecret = (rows[2] && rows[2][0]) ? String(rows[2][0]).trim() : "";
      const driveId = (rows[3] && rows[3][0]) ? String(rows[3][0]).trim() : "";
      const fileId = (rows[4] && rows[4][0]) ? String(rows[4][0]).trim() : "";
      const sheetName = (rows[5] && rows[5][0]) ? String(rows[5][0]).trim() : "";
      const rangeAddress = (rows[6] && rows[6][0]) ? String(rows[6][0]).trim() : "";

      if (!driveId || !fileId || !sheetName) {
        const missing = [];
        if (!driveId) missing.push(sessionUser.isAdmin ? "Drive ID (X36)" : "Drive ID");
        if (!fileId) missing.push(sessionUser.isAdmin ? "File ID (X37)" : "File ID");
        if (!sheetName) missing.push(sessionUser.isAdmin ? "Worksheet Name (X38)" : "Worksheet Name");
        return res.status(200).json({
          success: false,
          error: sessionUser.isAdmin
            ? `Missing Excel configuration in KeyInfo: ${missing.join(", ")}`
            : `Missing Excel configuration: ${missing.join(", ")}`
        });
      }

      // Step 1: Obtain Microsoft OAuth token (from Vault or fallback to Azure App Credentials in X33:X35)
      let accessToken = null;
      if (clientKey || masterSheetId) {
        const grant = await getIntegrationTokens({ clientKey, masterSheetId, tool: "excel" }).catch(() => null);
        if (grant && grant.tokens?.accessToken && !grant.tokens.accessToken.startsWith("manual_")) {
          accessToken = grant.tokens.accessToken;
        }
      }

      if (!accessToken) {
        if (!tenantId || !clientId || !clientSecret) {
          return res.status(200).json({
            success: false,
            error: sessionUser.isAdmin
              ? "No Microsoft authorization found. Please connect Excel via OAuth or populate Azure credentials in KeyInfo (X33-X35)."
              : sanitizeSpreadsheetTerms("No Microsoft authorization found. Please connect Excel via OAuth or populate Azure credentials.")
          });
        }

        const safeTenantId = assertSafeGraphId(tenantId, "tenantId");
        const tokenUrl = `https://login.microsoftonline.com/${safeTenantId}/oauth2/v2.0/token`;
        const tokenBody = new URLSearchParams({
          client_id: clientId,
          scope: "https://graph.microsoft.com/.default",
          client_secret: clientSecret,
          grant_type: "client_credentials"
        });

        const tokenRes = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenBody.toString()
        });

        const tokenData = await tokenRes.json();
        if (!tokenRes.ok || !tokenData.access_token) {
          return res.status(200).json({
            success: false,
            error: `Microsoft Azure authentication failed: ${tokenData.error_description || tokenData.error || tokenRes.statusText}`
          });
        }
        accessToken = tokenData.access_token;
      }

      // Step 2: Query Graph API workbook worksheet range or usedRange (validate IDs against path traversal - HIGH-04)
      const safeDriveId = assertSafeGraphId(driveId, "driveId");
      const safeFileId = assertSafeGraphId(fileId, "fileId");
      const cleanAddress = (rangeAddress || "").trim();
      let graphUrl;
      if (!cleanAddress || cleanAddress.toLowerCase() === "usedrange") {
        graphUrl = `https://graph.microsoft.com/v1.0/drives/${safeDriveId}/items/${safeFileId}/workbook/worksheets/${encodeURIComponent(sheetName)}/usedRange?$select=address,values`;
      } else {
        graphUrl = `https://graph.microsoft.com/v1.0/drives/${safeDriveId}/items/${safeFileId}/workbook/worksheets/${encodeURIComponent(sheetName)}/range(address='${encodeURIComponent(cleanAddress)}')`;
      }

      const graphRes = await fetch(graphUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const graphData = await graphRes.json();

      if (!graphRes.ok) {
        return res.status(200).json({
          success: false,
          error: `Microsoft Graph API error: ${graphData.error?.message || graphRes.statusText}`
        });
      }

      const rowsCount = Array.isArray(graphData.values) ? graphData.values.length : 0;
      return res.status(200).json({
        success: true,
        verified: true,
        tool: "Excel",
        sheetName,
        rangeAddress,
        rowsCount,
        message: `Successfully verified Microsoft Excel workbook via Azure Graph API (Worksheet: "${sheetName}", Range: "${rangeAddress}", ${rowsCount} rows accessible).`
      });
    }

    return res.status(400).json({
      success: false,
      error: `Unsupported source tool: "${tool}". Only Google Sheet and Excel are supported for non-API source verification.`
    });
  } catch (err) {
    console.error("Error in /api/integrations/test-source:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to test spreadsheet source connection"
    });
  }
}
