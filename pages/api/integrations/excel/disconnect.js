/**
 * ============================================================================
 * MICROSOFT EXCEL CRM DISCONNECT ROUTE: /api/integrations/excel/disconnect
 * ============================================================================
 */

import { getSessionUser } from "../../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../../services/sheetsClient.js";
import { removeIntegrationTokens } from "../../../../services/vaultService.js";
import { updateClientSetupTaskStatus } from "../../../../services/setupService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const { clientKey, masterSheetId } = req.body;
  if (!clientKey) {
    return res.status(400).json({ success: false, error: "Missing clientKey parameter" });
  }

  try {
    // 1. Clear KeyInfo!X33:X41 in master sheet if available
    if (masterSheetId) {
      const sheets = await getSheetsClient();
      await withRetry(() =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: masterSheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: [
              { range: "KeyInfo!X33", values: [[""]] },
              { range: "KeyInfo!X34", values: [[""]] },
              { range: "KeyInfo!X35", values: [[""]] },
              { range: "KeyInfo!X36", values: [[""]] },
              { range: "KeyInfo!X37", values: [[""]] },
              { range: "KeyInfo!X38", values: [[""]] },
              { range: "KeyInfo!X39", values: [[""]] },
              { range: "KeyInfo!X40", values: [[""]] },
              { range: "KeyInfo!X41", values: [[""]] }
            ]
          }
        })
      );
    }

    // 2. Remove vault record
    await removeIntegrationTokens(clientKey, "excel");

    // 3. Reset task in setup checklist
    try {
      await updateClientSetupTaskStatus({
        clientName: clientKey,
        taskId: "p2_connect_crm",
        isCompleted: false,
        metadata: "Disconnected",
        updatedBy: sessionUser.email || "System"
      });
    } catch (e) {}

    return res.status(200).json({
      success: true,
      message: `Disconnected Microsoft Excel CRM for ${clientKey}.`
    });
  } catch (err) {
    console.error("Error disconnecting Microsoft Excel CRM:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to disconnect Microsoft Excel CRM"
    });
  }
}
