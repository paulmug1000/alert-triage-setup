/**
 * ============================================================================
 * MICROSOFT EXCEL CRM OAUTH CALLBACK ROUTE: /api/integrations/excel/callback
 * ============================================================================
 */

import {
  exchangeExcelCodeForTokens,
  inspectExcelWorkbook,
  linkExcelToClient
} from "../../../../services/excelIntegrationService.js";
import { saveIntegrationTokens, getIntegrationTokens } from "../../../../services/vaultService.js";
import { verifySignedOAuthState, safeCompareSecret, verifyCallbackSessionInitiator, getTrustedClientIp, checkRateLimit } from "../../../../services/authService.js";
import { notifyStaffOnClientConnection } from "../../../../services/connectionNotifier.js";
import { sanitizeRedirectUrl, resolveCanonicalOAuthHost, sanitizeSpreadsheetTerms } from "../../../../utils/helpers.js";

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return acc;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) {
      try { acc[k] = decodeURIComponent(v); } catch { acc[k] = v; }
    }
    return acc;
  }, {});
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rl = await checkRateLimit("oauth-int-callback", getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ error: "Too many OAuth callback requests. Please retry shortly." });
  }

  const { code, state, error, error_description } = req.query;

  // 1. Verify HMAC-signed state early to extract redirectBack, client, and pending URL context (CRIT-02 & HIGH-06)
  const statePayload = state ? verifySignedOAuthState(String(state)) : null;

  let returnUrl = sanitizeRedirectUrl(statePayload?.redirectBack, "/pulse");
  if (returnUrl.startsWith("/pma") && !returnUrl.includes("nav=")) {
    const sep = returnUrl.includes("?") ? "&" : "?";
    returnUrl = `${returnUrl}${sep}nav=integrations`;
  }
  const clientKey = statePayload?.clientKey || statePayload?.clientName || "";
  const clientName = statePayload?.clientName || clientKey;
  const masterSheetId = statePayload?.masterSheetId;

  // 2. Handle user cancellation or denial gracefully
  if (error) {
    console.warn("⚠️ Excel OAuth cancelled or denied by user:", error, error_description);
    const sep = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${sep}integration=excel&status=denied&error=${encodeURIComponent(error_description || error)}${clientParam}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: "Missing authorization code or state parameter." });
  }

  const cookies = parseCookies(req.headers.cookie);
  const savedNonce = cookies.pulse_excel_nonce;

  const isProd = process.env.NODE_ENV === "production";
  const clearCookieOptions = `Path=/api/integrations/excel; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", `pulse_excel_nonce=; ${clearCookieOptions}`);

  if (!savedNonce || !statePayload?.nonce || !safeCompareSecret(String(statePayload.nonce), String(savedNonce))) {
    return res.status(403).json({ error: "State nonce verification failed (potential CSRF attempt)." });
  }

  const initiatorCheck = await verifyCallbackSessionInitiator(req, res, statePayload);
  if (!initiatorCheck.ok) {
    return res.status(403).json({ error: initiatorCheck.error });
  }

  try {
    const { host, proto } = resolveCanonicalOAuthHost(req);
    const redirectUri = `${proto}://${host}/api/integrations/excel/callback`;

    const azureTenantId = statePayload?.azureTenantId || "";

    // 3. Exchange authorization code for tokens
    const tokens = await exchangeExcelCodeForTokens({
      code,
      redirectUri,
      tenantId: azureTenantId || "common"
    });

    // 4. Fetch user profile from Microsoft Graph
    let userEmail = "";
    let displayName = "";
    try {
      const meRes = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` }
      });
      if (meRes.ok) {
        const meJson = await meRes.json();
        userEmail = meJson.mail || meJson.userPrincipalName || "";
        displayName = meJson.displayName || "";
      }
    } catch (meErr) {
      console.warn("Note fetching Microsoft me info:", meErr.message);
    }

    const accountLabel = userEmail ? `${displayName ? displayName + " " : ""}(${userEmail})` : "Microsoft 365 Account";

    const existingGrant = await getIntegrationTokens({
      clientKey,
      masterSheetId,
      tool: "excel"
    }).catch(() => null);

    // 5. Verify access to the workbook (using submitted URL, or previously linked driveId/fileId on simple reconnect)
    const existingDriveId = existingGrant?.metadata?.driveId || "";
    const existingFileId = existingGrant?.metadata?.fileId || "";
    const existingSheetName = existingGrant?.metadata?.sheetName || "";
    let inspectData = null;

    if (statePayload?.url || (existingDriveId && existingFileId)) {
      try {
        inspectData = await inspectExcelWorkbook({
          url: statePayload?.url || undefined,
          driveId: statePayload?.url ? undefined : existingDriveId,
          fileId: statePayload?.url ? undefined : existingFileId,
          sheetName: statePayload?.url ? "" : existingSheetName,
          token: tokens.accessToken,
          clientKey
        });
      } catch (accessErr) {
        console.warn(`⚠️ Excel file access verification failed for ${clientName} (${userEmail}):`, accessErr.message);
        const separator = returnUrl.includes("?") ? "&" : "?";
        const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
        const pendingUrl = statePayload?.url ? `&url=${encodeURIComponent(statePayload.url)}` : "";
        const helpfulMsg = accessErr.message
          ? (userEmail && !accessErr.message.includes(userEmail)
              ? `${accessErr.message} (Signed-in Microsoft 365 account: ${userEmail})`
              : accessErr.message)
          : (userEmail
              ? `Your Microsoft 365 account (${userEmail}) does not have permission to access the specified Excel spreadsheet on SharePoint/OneDrive. Please ensure the file is shared with ${userEmail} or sign in with an account that has access.`
              : `The Microsoft 365 account you signed in with does not have permission to access the specified Excel spreadsheet.`);
        return res.redirect(`${returnUrl}${separator}integration=excel&status=error&error=file_access_denied&message=${encodeURIComponent(helpfulMsg)}${clientParam}${pendingUrl}`);
      }
    }

    // 6. Encrypt and store tokens in Central Vault ONLY after file access is verified (preserving existing link metadata on reconnect)
    const prevMeta = existingGrant?.metadata || {};
    const resolvedMasterId = masterSheetId || existingGrant?.masterSheetId || "";
    const mergedTokens = {
      ...tokens,
      refreshToken: tokens.refreshToken || existingGrant?.tokens?.refreshToken || ""
    };
    await saveIntegrationTokens({
      clientKey,
      clientName,
      masterSheetId: resolvedMasterId,
      tool: "excel",
      tokens: mergedTokens,
      metadata: {
        ...prevMeta,
        userEmail,
        authorizedByPulseEmail: String(initiatorCheck.user?.email || statePayload?.initiatedBy || "").toLowerCase().trim(),
        displayName,
        accountName: accountLabel,
        tenantName: accountLabel,
        azureTenantId: azureTenantId || (statePayload?.url && statePayload.url !== prevMeta.url ? "" : (prevMeta.azureTenantId || "")),
        url: statePayload?.url || prevMeta.url || "",
        driveId: inspectData?.driveId || prevMeta.driveId || "",
        fileId: inspectData?.fileId || prevMeta.fileId || ""
      }
    });

    // 7. Auto-link Excel workbook behind the scenes
    if (statePayload?.url && resolvedMasterId && inspectData) {
      try {
        const defaultSheet = inspectData.defaultWorksheet || inspectData.worksheets?.[0]?.name || "Sheet1";
        const candidateRow = inspectData.candidateHeaderRow || 1;
        const suggested = inspectData.suggestedMapping || {};
        const keyHeaders = [
          suggested.clientCol || "Client",
          suggested.jobCol || "Job",
          suggested.revCol || "None",
          suggested.startCol || "None",
          suggested.endCol || "None",
          suggested.likeCol || "None"
        ].join(", ");

        await linkExcelToClient({
          clientKey,
          masterSheetId: resolvedMasterId,
          url: statePayload.url,
          driveId: inspectData.driveId,
          fileId: inspectData.fileId,
          sheetName: defaultSheet,
          rangeAddress: inspectData.rangeAddress,
          headerRowNum: candidateRow,
          keyHeaders
        });
        console.log(`✅ Auto-linked Excel workbook for ${clientName}`);
      } catch (autoLinkErr) {
        console.warn(`Auto-link Excel workbook notice for ${clientName}:`, autoLinkErr.message);
      }
    }

    // 8. Notify staff only upon verified connection
    notifyStaffOnClientConnection({
      clientName,
      tool: "excel",
      tenantName: accountLabel,
      masterSheetId: resolvedMasterId
    }).catch(err => console.error("Notification email error:", err.message));

    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    const pendingUrl = statePayload?.url ? `&url=${encodeURIComponent(statePayload.url)}` : "";
    
    // For client portal (/pulse), DO NOT pass modal=picker so modal doesn't pop up over confirmation
    const isPmaReturn = returnUrl.startsWith("/pma");
    const modalParam = isPmaReturn ? "&modal=picker" : "";

    return res.redirect(`${returnUrl}${separator}integration=excel&status=success&account=${encodeURIComponent(accountLabel)}${clientParam}&tenant=${encodeURIComponent(accountLabel)}${pendingUrl}${modalParam}`);

  } catch (err) {
    console.error("Excel OAuth callback error:", err);
    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${separator}integration=excel&status=error&message=${encodeURIComponent(sanitizeSpreadsheetTerms(err.message || "Connection failed"))}${clientParam}`);
  }
}
