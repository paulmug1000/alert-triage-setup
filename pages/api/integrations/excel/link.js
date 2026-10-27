/**
 * ============================================================================
 * MICROSOFT EXCEL LINK API ROUTE: /api/integrations/excel/link
 * ============================================================================
 * 
 * Links a verified Excel workbook and worksheet to the client's Master Sheet
 * (KeyInfo!X33:X41) and auto-completes task p2_connect_crm in Setup Mode.
 */

import { getSessionUser } from "../../../../services/authService.js";
import { linkExcelToClient } from "../../../../services/excelIntegrationService.js";
import { updateClientSetupTaskStatus } from "../../../../services/setupService.js";
import { saveIntegrationTokens, getIntegrationTokens } from "../../../../services/vaultService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const {
    clientKey,
    masterSheetId,
    tenantId = "",
    clientId = "",
    clientSecret = "",
    driveId,
    fileId,
    sheetName,
    rangeAddress = "",
    headerRowNum = "1",
    keyHeaders = ""
  } = req.body;

  if (!clientKey || !masterSheetId || !driveId || !fileId || !sheetName) {
    return res.status(400).json({
      success: false,
      error: "Missing required parameters (clientKey, masterSheetId, driveId, fileId, sheetName)"
    });
  }

  try {
    const linkResult = await linkExcelToClient({
      clientKey,
      masterSheetId,
      tenantId,
      clientId,
      clientSecret,
      driveId,
      fileId,
      sheetName,
      rangeAddress,
      headerRowNum,
      keyHeaders
    });

    // Check if vault record exists; if not, create connected status record
    const existingGrant = await getIntegrationTokens(clientKey, "excel");
    if (!existingGrant) {
      await saveIntegrationTokens({
        clientKey,
        clientName: clientKey,
        masterSheetId,
        tool: "excel",
        tokens: {
          accessToken: "manual_credentials",
          refreshToken: "",
          expiresIn: 31536000
        },
        metadata: {
          sheetName,
          driveId,
          fileId,
          rangeAddress,
          headerRowNum,
          keyHeaders,
          accountName: `Worksheet: ${sheetName}`,
          tenantName: sheetName
        }
      });
    }

    // Auto-complete Setup task p2_connect_crm
    try {
      await updateClientSetupTaskStatus({
        clientName: clientKey,
        taskId: "p2_connect_crm",
        isCompleted: true,
        metadata: `Excel Linked (${sheetName})`,
        updatedBy: sessionUser.email || "System"
      });
    } catch (taskErr) {
      console.warn("Note updating p2_connect_crm task for Excel:", taskErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Successfully linked Microsoft Excel CRM (Worksheet: "${sheetName}") to ${clientKey}.`,
      ...linkResult
    });
  } catch (err) {
    console.error("Error linking Microsoft Excel CRM:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to link Microsoft Excel CRM"
    });
  }
}
