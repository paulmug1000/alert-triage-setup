/**
 * ============================================================================
 * GOOGLE SHEET INSPECT API ROUTE: /api/integrations/google-sheet/inspect
 * ============================================================================
 * 
 * Inspects a Google Sheet by URL or ID.
 * Returns title, available worksheets/tabs, headers, and row counts.
 */

import { getSessionUser } from "../../../../services/authService.js";
import { inspectGoogleSpreadsheet } from "../../../../services/googleSheetService.js";
import { getIntegrationTokens } from "../../../../services/vaultService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const { url, sheetId, clientKey, tabName, headerRowNum } = req.method === "POST" ? req.body : req.query;

  if (!url && !sheetId) {
    return res.status(400).json({ success: false, error: "Missing url or sheetId parameter" });
  }

  try {
    // Check if client has a stored OAuth access token in Vault
    let accessToken = null;
    if (clientKey) {
      const grant = await getIntegrationTokens(clientKey, "googlesheet");
      if (grant && grant.tokens?.accessToken) {
        accessToken = grant.tokens.accessToken;
      }
    }

    const inspection = await inspectGoogleSpreadsheet({
      url,
      sheetId,
      accessToken,
      tabName,
      headerRowNum
    });

    return res.status(200).json({
      success: true,
      ...inspection
    });
  } catch (err) {
    console.error("Error inspecting Google Sheet:", err);
    return res.status(200).json({
      success: false,
      error: err.message || "Failed to inspect Google Sheet"
    });
  }
}
