/**
 * ============================================================================
 * GOOGLE SHEET LINK API ROUTE: /api/integrations/google-sheet/link
 * ============================================================================
 * 
 * Links a verified Google Sheet and worksheet tab to the client's Master Sheet
 * (KeyInfo!X14:X15) and auto-completes task p2_connect_crm in Setup Mode.
 */

import { getSessionUser } from "../../../../services/authService.js";
import { linkGoogleSheetToClient } from "../../../../services/googleSheetService.js";
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

  const { clientKey, masterSheetId, url, tabName, headerRowNum = 1, keyHeaders = "" } = req.body;

  if (!clientKey || !masterSheetId || !url) {
    return res.status(400).json({
      success: false,
      error: "Missing required clientKey, masterSheetId, or url parameters"
    });
  }

  try {
    const linkResult = await linkGoogleSheetToClient({
      clientKey,
      masterSheetId,
      url,
      tabName: tabName || "Sheet1",
      headerRowNum,
      keyHeaders
    });

    // Check if vault record exists; if not, create connected status record
    const existingGrant = await getIntegrationTokens(clientKey, "googlesheet");
    if (!existingGrant) {
      await saveIntegrationTokens({
        clientKey,
        clientName: clientKey,
        masterSheetId,
        tool: "googlesheet",
        tokens: {
          accessToken: "manual_link",
          refreshToken: "",
          expiresIn: 31536000
        },
        metadata: {
          tabName: tabName || "Sheet1",
          url: url.trim(),
          spreadsheetId: linkResult.spreadsheetId,
          headerRowNum,
          keyHeaders,
          accountName: `Sheet: ${tabName || "Sheet1"}`,
          tenantName: tabName || "Sheet1"
        }
      });
    }

    // Auto-complete Setup task p2_connect_crm
    try {
      await updateClientSetupTaskStatus({
        clientName: clientKey,
        taskId: "p2_connect_crm",
        isCompleted: true,
        metadata: `Google Sheet Linked (${tabName || "Sheet1"})`,
        updatedBy: sessionUser.email || "System"
      });
    } catch (taskErr) {
      console.warn("Note updating p2_connect_crm task:", taskErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Successfully linked Google Sheet CRM (Tab: "${tabName || "Sheet1"}") to ${clientKey}.`,
      ...linkResult
    });
  } catch (err) {
    console.error("Error linking Google Sheet CRM:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to link Google Sheet CRM"
    });
  }
}
