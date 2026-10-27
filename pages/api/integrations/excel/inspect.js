/**
 * ============================================================================
 * MICROSOFT EXCEL INSPECT API ROUTE: /api/integrations/excel/inspect
 * ============================================================================
 * 
 * Inspects a remote Microsoft Excel workbook via Microsoft Graph API.
 * Returns available worksheets, used range address, and headers.
 */

import { getSessionUser } from "../../../../services/authService.js";
import { inspectExcelWorkbook } from "../../../../services/excelIntegrationService.js";
import { getIntegrationTokens } from "../../../../services/vaultService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
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
  } = req.method === "POST" ? req.body : req.query;

  if (!driveId && !fileId && !url) {
    return res.status(400).json({ success: false, error: "Missing url, driveId, or fileId parameter" });
  }

  try {
    let token = null;
    let azureCredentials = null;

    if (clientKey) {
      const grant = await getIntegrationTokens({ clientKey, tool: "excel" });
      if (grant && grant.tokens) {
        // If expired or expiring within 60s, refresh automatically
        const isExpiring = grant.expiresAt && Date.now() > (grant.expiresAt - 60000);
        if (isExpiring && grant.tokens.refreshToken) {
          try {
            const { refreshExcelTokens } = await import("../../../../services/excelIntegrationService.js");
            const { updateRefreshedTokens } = await import("../../../../services/vaultService.js");
            const refreshed = await refreshExcelTokens(grant.tokens.refreshToken);
            await updateRefreshedTokens({
              clientKey,
              tool: "excel",
              tokens: {
                ...grant.tokens,
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken || grant.tokens.refreshToken,
                expiresIn: refreshed.expiresIn,
                expiresAt: Date.now() + (refreshed.expiresIn * 1000)
              }
            });
            token = refreshed.accessToken;
          } catch (rErr) {
            console.warn("Could not refresh Excel token before inspect:", rErr.message);
            token = grant.tokens.accessToken;
          }
        } else {
          token = grant.tokens.accessToken;
        }
      }
    }

    if (!token && tenantId && clientId && clientSecret) {
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
      error: err.message || "Failed to inspect Excel workbook"
    });
  }
}
