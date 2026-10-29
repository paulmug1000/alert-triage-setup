/**
 * ============================================================================
 * GOOGLE SHEET LINK API ROUTE: /api/integrations/google-sheet/link
 * ============================================================================
 * 
 * Links a verified Google Sheet and worksheet tab to the client's Master Sheet
 * (KeyInfo!X14:X15) and auto-completes task p2_connect_crm in Setup Mode.
 */

import { getSessionUser } from "../../../../services/authService.js";
import { isUserAuthorizedForClient, verifyUserAuthorizedForSheet, isReadOnlySession } from "../../../../services/userPermissions.js";
import { getSheetsClient } from "../../../../services/sheetsClient.js";
import { linkGoogleSheetToClient } from "../../../../services/googleSheetService.js";
import { updateClientChecklistTask } from "../../../../services/setupService.js";
import { saveIntegrationTokens, getIntegrationTokens } from "../../../../services/vaultService.js";
import { assertTrustedOrigin } from "../../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Read-only session cannot link spreadsheets." });
  }

  const { clientKey, masterSheetId, url, tabName, headerRowNum = 1, keyHeaders = "" } = req.body;

  if (!clientKey || !masterSheetId || !url) {
    return res.status(400).json({
      success: false,
      error: "Missing required clientKey, masterSheetId, or url parameters"
    });
  }

  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientKey)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  if (!sessionUser.isAdmin && masterSheetId) {
    try {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, clientKey, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error });
      }
    } catch (authErr) {
      return res.status(403).json({ success: false, error: "Failed to verify sheet authorization." });
    }
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

    // Check if vault record exists; update metadata or create connected status record
    const existingGrant = await getIntegrationTokens({ clientKey, tool: "googlesheet" });
    if (existingGrant) {
      await saveIntegrationTokens({
        clientKey,
        clientName: existingGrant.clientName || clientKey,
        masterSheetId: masterSheetId || existingGrant.masterSheetId,
        tool: "googlesheet",
        tokens: existingGrant.tokens,
        metadata: {
          ...(existingGrant.metadata || {}),
          tabName: tabName || "Sheet1",
          url: url.trim(),
          spreadsheetId: linkResult.spreadsheetId,
          headerRowNum,
          keyHeaders,
          accountName: existingGrant.metadata?.userEmail ? `Google Account (${existingGrant.metadata.userEmail})` : `Sheet: ${tabName || "Sheet1"}`
        }
      });
    } else {
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
      const sheets = await getSheetsClient();
      await updateClientChecklistTask(sheets, {
        clientName: clientKey,
        taskId: "p2_connect_crm",
        isCompleted: true,
        metadata: `Google Sheet Linked (${tabName || "Sheet1"})`,
        userEmail: sessionUser.email || "System"
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
