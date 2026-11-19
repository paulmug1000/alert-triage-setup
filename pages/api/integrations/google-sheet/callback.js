/**
 * ============================================================================
 * GOOGLE SHEET CRM OAUTH CALLBACK ROUTE: /api/integrations/google-sheet/callback
 * ============================================================================
 */

import {
  exchangeGoogleSheetCodeForTokens
} from "../../../../services/googleSheetService.js";
import { saveIntegrationTokens, getIntegrationTokens } from "../../../../services/vaultService.js";
import { verifySignedOAuthState, safeCompareSecret, verifyCallbackSessionInitiator } from "../../../../services/authService.js";
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

  if (!savedNonce || !statePayload?.nonce || !safeCompareSecret(String(statePayload.nonce), String(savedNonce))) {
    return res.status(403).json({ error: "State nonce verification failed (potential CSRF attempt)." });
  }

  const initiatorCheck = await verifyCallbackSessionInitiator(req, res, statePayload);
  if (!initiatorCheck.ok) {
    return res.status(403).json({ error: initiatorCheck.error });
  }

  try {
    const { host, proto } = resolveCanonicalOAuthHost(req);
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

    // 5. Preserve any existing linked spreadsheet metadata if re-authorizing
    const existingGrant = await getIntegrationTokens({
      clientKey,
      masterSheetId,
      tool: "googlesheet"
    }).catch(() => null);

    // 6. Encrypt and store OAuth tokens in Central Vault (spreadsheet selection occurs via Google Picker in the browser)
    const resolvedMasterId = masterSheetId || existingGrant?.masterSheetId || "";
    const mergedTokens = {
      ...tokens,
      refreshToken: tokens.refreshToken || existingGrant?.tokens?.refreshToken || ""
    };
    await saveIntegrationTokens({
      clientKey,
      clientName,
      masterSheetId: resolvedMasterId,
      tool: "googlesheet",
      tokens: mergedTokens,
      metadata: {
        ...(existingGrant?.metadata || {}),
        userEmail,
        accountName: userEmail ? `Google Account (${userEmail})` : "Google Account",
        tenantName: userEmail || "Google Account"
      }
    });

    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    const hasLinkedSheet = Boolean(existingGrant?.metadata?.spreadsheetId || existingGrant?.metadata?.url);

    if (statePayload?.reconnectOnly && hasLinkedSheet) {
      return res.redirect(`${returnUrl}${separator}integration=googlesheet&status=success&account=${encodeURIComponent(userEmail)}${clientParam}&tenant=${encodeURIComponent(userEmail)}`);
    }

    return res.redirect(`${returnUrl}${separator}integration=googlesheet&status=oauth_authorized&modal=picker&account=${encodeURIComponent(userEmail)}${clientParam}&tenant=${encodeURIComponent(userEmail)}`);

  } catch (err) {
    console.error("Google Sheet OAuth callback error:", err);
    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${separator}integration=googlesheet&status=error&message=${encodeURIComponent(sanitizeSpreadsheetTerms(err.message || "Connection failed"))}${clientParam}`);
  }
}
