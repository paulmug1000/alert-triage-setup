/**
 * ============================================================================
 * GOOGLE SHEET INSPECT API ROUTE: /api/integrations/google-sheet/inspect
 * ============================================================================
 * 
 * Inspects a Google Sheet by URL or ID.
 * Returns title, available worksheets/tabs, headers, and row counts.
 */

import { getSessionUser } from "../../../../services/authService.js";
import { isUserAuthorizedForClient, isReadOnlySession } from "../../../../services/userPermissions.js";
import { inspectGoogleSpreadsheet } from "../../../../services/googleSheetService.js";
import { getIntegrationTokens } from "../../../../services/vaultService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Read-only session cannot inspect external spreadsheets." });
  }

  const { url, sheetId, clientKey, tabName, headerRowNum } = req.method === "POST" ? req.body : req.query;

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
      if (grant && grant.tokens) {
        // If expired or expiring within 60s, refresh automatically
        const isExpiring = grant.expiresAt && Date.now() > (grant.expiresAt - 60000);
        if (isExpiring && grant.tokens.refreshToken) {
          try {
            const { refreshGoogleSheetTokens } = await import("../../../../services/googleSheetService.js");
            const { updateRefreshedTokens } = await import("../../../../services/vaultService.js");
            const refreshed = await refreshGoogleSheetTokens(grant.tokens.refreshToken);
            await updateRefreshedTokens({
              clientKey,
              tool: "googlesheet",
              tokens: {
                ...grant.tokens,
                accessToken: refreshed.accessToken,
                expiresIn: refreshed.expiresIn,
                expiresAt: Date.now() + (refreshed.expiresIn * 1000)
              }
            });
            accessToken = refreshed.accessToken;
          } catch (rErr) {
            console.warn("Could not refresh Google Sheet token before inspect:", rErr.message);
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
      isAdmin: Boolean(sessionUser.isAdmin)
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
