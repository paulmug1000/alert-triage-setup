/**
 * ============================================================================
 * GOOGLE SHEET CRM OAUTH CALLBACK ROUTE: /api/integrations/google-sheet/callback
 * ============================================================================
 */

import {
  exchangeGoogleSheetCodeForTokens,
  inspectGoogleSpreadsheet,
  linkGoogleSheetToClient
} from "../../../../services/googleSheetService.js";
import { saveIntegrationTokens } from "../../../../services/vaultService.js";
import { verifySignedOAuthState } from "../../../../services/authService.js";
import { notifyStaffOnClientConnection } from "../../../../services/connectionNotifier.js";
import { sanitizeRedirectUrl } from "../../../../utils/helpers.js";

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, pair) => {
    const [k, v] = pair.trim().split("=");
    if (k && v) acc[k] = decodeURIComponent(v);
    return acc;
  }, {});
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
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
    console.warn("⚠️ Google Sheet OAuth cancelled or denied by user:", error, error_description);
    const sep = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${sep}integration=googlesheet&status=denied&error=${encodeURIComponent(error_description || error)}${clientParam}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: "Missing authorization code or state parameter." });
  }

  const cookies = parseCookies(req.headers.cookie);
  const savedNonce = cookies.pulse_gsheet_nonce;

  const isProd = process.env.NODE_ENV === "production";
  const clearCookieOptions = `Path=/api/integrations/google-sheet; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", `pulse_gsheet_nonce=; ${clearCookieOptions}`);

  if (!savedNonce || statePayload?.nonce !== savedNonce) {
    return res.status(403).json({ error: "State nonce verification failed (potential CSRF attempt)." });
  }

  try {
    const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
    const isPulseHost = reqHost && (reqHost === "pulsedashboard.co.uk" || reqHost.endsWith(".pulsedashboard.co.uk"));
    const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const host = isPulseHost ? reqHost : (prodHost || reqHost || "localhost:3000");
    const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
    const redirectUri = `${proto}://${host}/api/integrations/google-sheet/callback`;

    // 3. Exchange authorization code for tokens
    const tokens = await exchangeGoogleSheetCodeForTokens({
      code,
      redirectUri
    });

    // 4. Fetch user identity to store friendly connected account info
    let userEmail = "";
    try {
      const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` }
      });
      if (userRes.ok) {
        const uJson = await userRes.json();
        userEmail = uJson.email || "";
      }
    } catch (uErr) {
      console.warn("Note fetching Google userinfo:", uErr.message);
    }

    // 5. If a spreadsheet URL was provided, verify access via user's Google token
    let inspectData = null;
    if (statePayload?.url) {
      try {
        inspectData = await inspectGoogleSpreadsheet({
          url: statePayload.url,
          accessToken: tokens.accessToken
        });
      } catch (accessErr) {
        console.warn(`⚠️ Google Sheet access verification failed for ${clientName} (${userEmail}):`, accessErr.message);
        const separator = returnUrl.includes("?") ? "&" : "?";
        const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
        const pendingUrl = `&url=${encodeURIComponent(statePayload.url)}`;
        const helpfulMsg = accessErr.message || (userEmail
          ? `Your Google account (${userEmail}) does not have permission to access the specified Google Sheet. Please share the Google Sheet with ${userEmail} (Viewer permissions) or sign in with an account that has access.`
          : `The Google account you signed in with does not have permission to access the specified Google Sheet.`);
        return res.redirect(`${returnUrl}${separator}integration=googlesheet&status=error&error=file_access_denied&message=${encodeURIComponent(helpfulMsg)}${clientParam}${pendingUrl}`);
      }
    }

    // 6. Encrypt and store tokens in Central Vault ONLY after file access is verified
    await saveIntegrationTokens({
      clientKey,
      clientName,
      masterSheetId,
      tool: "googlesheet",
      tokens,
      metadata: {
        userEmail,
        accountName: userEmail ? `Google Account (${userEmail})` : "Google Account",
        tenantName: userEmail || "Google Account",
        url: statePayload?.url || "",
        spreadsheetTitle: inspectData?.title || ""
      }
    });

    // 7. Auto-link Google Sheet behind the scenes
    if (statePayload?.url && masterSheetId && inspectData) {
      try {
        const defaultTab = inspectData.selectedTab || inspectData.defaultTab || inspectData.tabs?.[0]?.title || "Sheet1";
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

        await linkGoogleSheetToClient({
          clientKey,
          masterSheetId,
          url: statePayload.url,
          tabName: defaultTab,
          headerRowNum: candidateRow,
          keyHeaders
        });
        console.log(`✅ Auto-linked Google Sheet for ${clientName}`);
      } catch (autoLinkErr) {
        console.warn(`Auto-link Google Sheet notice for ${clientName}:`, autoLinkErr.message);
      }
    }

    // 8. Notify staff only upon verified connection
    notifyStaffOnClientConnection({
      clientName,
      tool: "googlesheet",
      tenantName: userEmail || "Google Account",
      masterSheetId
    }).catch(err => console.error("Notification email error:", err.message));

    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    const pendingUrl = statePayload?.url ? `&url=${encodeURIComponent(statePayload.url)}` : "";

    // For client portal (/pulse), DO NOT pass modal=picker so modal doesn't pop up over confirmation
    const isPmaReturn = returnUrl.startsWith("/pma");
    const modalParam = isPmaReturn ? "&modal=picker" : "";

    return res.redirect(`${returnUrl}${separator}integration=googlesheet&status=success&account=${encodeURIComponent(userEmail)}${clientParam}&tenant=${encodeURIComponent(userEmail)}${pendingUrl}${modalParam}`);

  } catch (err) {
    console.error("Google Sheet OAuth callback error:", err);
    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${separator}integration=googlesheet&status=error&message=${encodeURIComponent(err.message)}${clientParam}`);
  }
}
