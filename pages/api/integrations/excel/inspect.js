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
    driveId,
    fileId,
    sheetName = "",
    clientKey,
    tenantId,
    clientId,
    clientSecret,
    headerRowNum
  } = req.method === "POST" ? req.body : req.query;

  if (!driveId || !fileId) {
    return res.status(400).json({ success: false, error: "Missing driveId or fileId parameter" });
  }

  try {
    let token = null;
    let azureCredentials = null;

    if (clientKey) {
      const grant = await getIntegrationTokens(clientKey, "excel");
      if (grant && grant.tokens?.accessToken) {
        token = grant.tokens.accessToken;
      }
    }

    if (!token && tenantId && clientId && clientSecret) {
      azureCredentials = { tenantId, clientId, clientSecret };
    }

    const inspection = await inspectExcelWorkbook({
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
