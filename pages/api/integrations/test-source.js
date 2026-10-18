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

export default async function handler(req, res) {
  let sessionUser = await getSessionUser(req);
  if (!sessionUser && process.env.NODE_ENV !== "production") {
    sessionUser = { email: "dev@pulsedashboard.co.uk", isAdmin: true, role: "Admin" };
  }
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const { clientKey, masterSheetId, tool = "", category = "crm" } = req.method === "POST" ? req.body : req.query;

  if (!masterSheetId) {
    return res.status(400).json({ success: false, error: "Missing masterSheetId parameter" });
  }

  const toolClean = String(tool || "").trim().toLowerCase();
  const sheets = await getSheetsClient();

  try {
    if (toolClean.includes("sheet")) {
      // 1. Google Sheet source check
      const kiRes = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: masterSheetId,
          range: "KeyInfo!X14:X15"
        })
      );
      const rows = kiRes.data.values || [];
      const url = (rows[0] && rows[0][0]) ? String(rows[0][0]).trim() : "";
      const tabName = (rows[1] && rows[1][0]) ? String(rows[1][0]).trim() : "";

      if (!url) {
        return res.status(200).json({
          success: false,
          error: "No Google Sheet URL configured in KeyInfo (X14)."
        });
      }

      const targetSheetId = extractSheetIdFromUrl(url);
      if (!targetSheetId) {
        return res.status(200).json({
          success: false,
          error: `Could not parse spreadsheet ID from URL: ${url}`
        });
      }

      // Check sheet accessibility
      let sheetMeta;
      try {
        sheetMeta = await sheets.spreadsheets.get({
          spreadsheetId: targetSheetId
        });
      } catch (accessErr) {
        if (accessErr.code === 403 || accessErr.message?.includes("403")) {
          return res.status(200).json({
            success: false,
            error: "Google Sheets access denied: ensure the service account (alert-triage-backend@automation-commander.iam.gserviceaccount.com) has Viewer or Editor access."
          });
        }
        if (accessErr.code === 404 || accessErr.message?.includes("404")) {
          return res.status(200).json({
            success: false,
            error: `Target Google Sheet not found (ID: ${targetSheetId}). Verify the URL in KeyInfo!X14.`
          });
        }
        return res.status(200).json({
          success: false,
          error: `Google Sheets error: ${accessErr.message}`
        });
      }

      const availableTabs = (sheetMeta.data.sheets || []).map(s => s.properties?.title || "");
      if (tabName && !availableTabs.includes(tabName)) {
        return res.status(200).json({
          success: false,
          error: `Tab "${tabName}" not found in remote sheet. Available tabs: ${availableTabs.slice(0, 5).join(", ")}${availableTabs.length > 5 ? "..." : ""}`
        });
      }

      // Read sample data to check row count and UUID column
      const sampleRange = tabName ? `'${tabName}'!1:5` : "1:5";
      const sampleRes = await sheets.spreadsheets.values.get({
        spreadsheetId: targetSheetId,
        range: sampleRange
      });
      const headers = sampleRes.data.values?.[0] || [];
      const hasSystemId = headers.some(h => String(h).trim() === "System ID (Do Not Edit)");

      return res.status(200).json({
        success: true,
        verified: true,
        tool: "Google Sheet",
        sheetTitle: sheetMeta.data.properties?.title || "Connected Sheet",
        tabName: tabName || availableTabs[0] || "Sheet1",
        headerCount: headers.length,
        hasSystemId,
        message: `Successfully connected to remote Google Sheet "${sheetMeta.data.properties?.title || targetSheetId}" (Tab: "${tabName || availableTabs[0]}", ${headers.length} columns detected${hasSystemId ? ", System ID header present" : ""}).`
      });
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

      if (!tenantId || !clientId || !clientSecret || !driveId || !fileId || !sheetName || !rangeAddress) {
        const missing = [];
        if (!tenantId) missing.push("Tenant ID (X33)");
        if (!clientId) missing.push("Client ID (X34)");
        if (!clientSecret) missing.push("Client Secret (X35)");
        if (!driveId) missing.push("Drive ID (X36)");
        if (!fileId) missing.push("File ID (X37)");
        if (!sheetName) missing.push("Worksheet Name (X38)");
        if (!rangeAddress) missing.push("Range Address (X39)");
        return res.status(200).json({
          success: false,
          error: `Missing Excel configuration in KeyInfo: ${missing.join(", ")}`
        });
      }

      // Step 1: Obtain Microsoft OAuth2 token
      const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
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

      // Step 2: Query Graph API workbook worksheet range
      const graphUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${fileId}/workbook/worksheets/${encodeURIComponent(sheetName)}/range(address='${encodeURIComponent(rangeAddress)}')`;
      const graphRes = await fetch(graphUrl, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
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
