/**
 * ============================================================================
 * GOOGLE SHEET CRM DISCONNECT ROUTE: /api/integrations/google-sheet/disconnect
 * ============================================================================
 */

import { getSessionUser } from "../../../../services/authService.js";
import { isUserAuthorizedForClient } from "../../../../services/userPermissions.js";
import { getSheetsClient, withRetry } from "../../../../services/sheetsClient.js";
import { deleteIntegrationTokens } from "../../../../services/vaultService.js";
import { updateClientChecklistTask } from "../../../../services/setupService.js";
import { redisClient } from "../../../../services/redisClient.js";

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

  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientKey)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  try {
    const sheets = await getSheetsClient();

    // 1. Clear KeyInfo!X11:X15 and reset Q8 in master sheet if available
    if (masterSheetId) {
      await withRetry(() =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: masterSheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: [
              { range: "KeyInfo!X11", values: [[""]] },
              { range: "KeyInfo!X12", values: [[""]] },
              { range: "KeyInfo!X13", values: [[""]] },
              { range: "KeyInfo!X14", values: [[""]] },
              { range: "KeyInfo!X15", values: [[""]] },
              { range: "KeyInfo!Q8", values: [["None"]] }
            ]
          }
        })
      );
    }

    // 2. Remove vault record
    await deleteIntegrationTokens({ clientKey, masterSheetId, tool: "googlesheet" });

    // 3. Reset task in setup checklist
    try {
      await updateClientChecklistTask(sheets, {
        clientName: clientKey,
        taskId: "p2_connect_crm",
        isCompleted: false,
        metadata: "Disconnected",
        userEmail: sessionUser.email || "System"
      });
    } catch (e) {}

    // 4. Invalidate Redis setup cache
    const cleanClient = String(clientKey || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const redisKey = `pulse:setup:${cleanClient}`;
    if (redisClient?.isOpen) {
      try {
        const raw = await redisClient.get(redisKey);
        if (raw) {
          const prev = JSON.parse(raw);
          delete prev.googleSheetUrl;
          delete prev.googleSheetTab;
          await redisClient.set(redisKey, JSON.stringify(prev));
        }
      } catch (e) {}
    }

    return res.status(200).json({
      success: true,
      message: `Disconnected Google Sheet CRM for ${clientKey}.`
    });
  } catch (err) {
    console.error("Error disconnecting Google Sheet CRM:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to disconnect Google Sheet CRM"
    });
  }
}
