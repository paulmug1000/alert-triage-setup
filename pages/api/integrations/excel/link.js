/**
 * ============================================================================
 * MICROSOFT EXCEL LINK API ROUTE: /api/integrations/excel/link
 * ============================================================================
 * 
 * Links a verified Excel workbook and worksheet to the client's Master Sheet
 * (KeyInfo!X33:X41) and auto-completes task p2_connect_crm in Setup Mode.
 */

import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../../services/authService.js";
import { isUserAuthorizedForClient, verifyUserAuthorizedForSheet, isReadOnlySession, resolveMasterSheetIdByClientName } from "../../../../services/userPermissions.js";
import { getSheetsClient } from "../../../../services/sheetsClient.js";
import { linkExcelToClient } from "../../../../services/excelIntegrationService.js";
import { updateClientChecklistTask } from "../../../../services/setupService.js";
import { saveIntegrationTokens, getIntegrationTokens } from "../../../../services/vaultService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const rl = await checkRateLimit("excel-int", getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
  }

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Read-only session cannot link workbooks." });
  }
  if (sessionUser.role === "Senior (Restricted)" || sessionUser.isSenior) {
    return res.status(403).json({ success: false, error: "Forbidden: Senior (Restricted) users cannot link integrations." });
  }

  const {
    clientKey,
    masterSheetId,
    tenantId = "",
    clientId = "",
    clientSecret = "",
    url = "",
    driveId,
    fileId,
    sheetName,
    rangeAddress = "",
    headerRowNum = "1",
    keyHeaders = ""
  } = req.body;

  if (!clientKey || ((!driveId || !fileId) && !url) || !sheetName) {
    return res.status(400).json({
      success: false,
      error: "Missing required parameters (clientKey, sheetName, and either url or driveId/fileId)"
    });
  }

  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientKey)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  let resolvedMasterSheetId = masterSheetId || "";
  try {
    const sheets = await getSheetsClient();
    if (!resolvedMasterSheetId) {
      resolvedMasterSheetId = await resolveMasterSheetIdByClientName(sheets, clientKey);
    }
    if (!resolvedMasterSheetId) {
      return res.status(400).json({
        success: false,
        error: "Could not resolve master configuration for this client."
      });
    }
    if (!sessionUser.isAdmin) {
      const auth = await verifyUserAuthorizedForSheet(sessionUser, resolvedMasterSheetId, clientKey, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error });
      }
    }
  } catch (authErr) {
    return res.status(403).json({ success: false, error: "Failed to verify sheet authorization." });
  }

  try {
    const existingGrant = await getIntegrationTokens({ clientKey, masterSheetId: resolvedMasterSheetId, tool: "excel" });
    if (existingGrant?.tokens?.accessToken && !existingGrant.tokens.accessToken.startsWith("manual_")) {
      const grantOwner = String(existingGrant.metadata?.userEmail || "").toLowerCase().trim();
      const callerEmail = String(sessionUser.email || "").toLowerCase().trim();
      if (!grantOwner || callerEmail !== grantOwner) {
        const linkedDrive = String(existingGrant.metadata?.driveId || "").trim();
        const linkedFile = String(existingGrant.metadata?.fileId || "").trim();
        const matchesLinked =
          linkedDrive &&
          linkedFile &&
          String(driveId || "").trim() === linkedDrive &&
          String(fileId || "").trim() === linkedFile &&
          !url;
        if (!matchesLinked) {
          return res.status(403).json({
            success: false,
            error: "Please authorise with your own Microsoft account before linking a different workbook."
          });
        }
      }
    }

    const safeTenantId = sessionUser.isAdmin ? tenantId : "";
    const safeClientId = sessionUser.isAdmin ? clientId : "";
    const safeClientSecret = sessionUser.isAdmin ? clientSecret : "";

    const linkResult = await linkExcelToClient({
      clientKey,
      masterSheetId: resolvedMasterSheetId,
      tenantId: safeTenantId,
      clientId: safeClientId,
      clientSecret: safeClientSecret,
      url,
      driveId,
      fileId,
      sheetName,
      rangeAddress,
      headerRowNum,
      keyHeaders
    });

    // Update Vault metadata or create connected status record
    if (existingGrant) {
      await saveIntegrationTokens({
        clientKey,
        clientName: existingGrant.clientName || clientKey,
        masterSheetId: resolvedMasterSheetId || existingGrant.masterSheetId,
        tool: "excel",
        tokens: existingGrant.tokens,
        metadata: {
          ...(existingGrant.metadata || {}),
          sheetName,
          driveId: linkResult.driveId || driveId,
          fileId: linkResult.fileId || fileId,
          rangeAddress,
          headerRowNum,
          keyHeaders,
          accountName: existingGrant.metadata?.userEmail ? `Microsoft 365 (${existingGrant.metadata.userEmail})` : `Worksheet: ${sheetName}`
        }
      });
    } else {
      await saveIntegrationTokens({
        clientKey,
        clientName: clientKey,
        masterSheetId: resolvedMasterSheetId,
        tool: "excel",
        tokens: {
          accessToken: "manual_credentials",
          refreshToken: "",
          expiresIn: 31536000
        },
        metadata: {
          sheetName,
          driveId: linkResult.driveId || driveId,
          fileId: linkResult.fileId || fileId,
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
      const sheets = await getSheetsClient();
      await updateClientChecklistTask(sheets, {
        clientName: clientKey,
        taskId: "p2_connect_crm",
        isCompleted: true,
        metadata: `Excel Linked (${sheetName})`,
        userEmail: sessionUser.email || "System"
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
      error: sessionUser?.isAdmin ? (err.message || "Failed to link Microsoft Excel CRM") : sanitizeSpreadsheetTerms(err.message || "Failed to link Microsoft Excel CRM")
    });
  }
}
