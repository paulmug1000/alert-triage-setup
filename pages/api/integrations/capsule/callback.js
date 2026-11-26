/**
 * ============================================================================
 * CAPSULE CRM OAUTH CALLBACK ROUTE: /api/integrations/capsule/callback
 * ============================================================================
 */

import { exchangeCapsuleCodeForTokens, getCapsuleAccountInfo } from "../../../../services/capsuleService.js";
import { saveIntegrationTokens } from "../../../../services/vaultService.js";
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

  // 1. Verify HMAC-signed state early to extract redirectBack and client context (CRIT-02 & HIGH-06)
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
    console.warn("⚠️ Capsule OAuth cancelled or denied by user:", error, error_description);
    const sep = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${sep}integration=capsule&status=denied&error=${encodeURIComponent(error_description || error)}${clientParam}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: "Missing authorization code or state parameter." });
  }

  const cookies = parseCookies(req.headers.cookie);
  const savedNonce = cookies.pulse_capsule_nonce;

  const isProd = process.env.NODE_ENV === "production";
  const clearCookieOptions = `Path=/api/integrations/capsule; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", `pulse_capsule_nonce=; ${clearCookieOptions}`);

  if (!savedNonce || !statePayload?.nonce || !safeCompareSecret(String(statePayload.nonce), String(savedNonce))) {
    return res.status(403).json({ error: "State nonce verification failed (potential CSRF attempt)." });
  }

  const initiatorCheck = await verifyCallbackSessionInitiator(req, res, statePayload);
  if (!initiatorCheck.ok) {
    return res.status(403).json({ error: initiatorCheck.error });
  }

  try {
    const { host, proto } = resolveCanonicalOAuthHost(req);
    const redirectUri = `${proto}://${host}/api/integrations/capsule/callback`;

    // 1. Exchange code
    const tokens = await exchangeCapsuleCodeForTokens({
      code,
      redirectUri
    });

    const clientKey = statePayload.clientKey || statePayload.clientName;
    const clientName = statePayload.clientName || clientKey;
    const masterSheetId = statePayload.masterSheetId;

    // 2. Fetch and strictly verify site/account metadata before persisting tokens
    const accountInfo = await getCapsuleAccountInfo(tokens.accessToken);
    if (!accountInfo || (!accountInfo.siteName && !accountInfo.siteUrl && !accountInfo.userEmail)) {
      throw new Error("Capsule CRM verification failed: unable to read authenticated site profile.");
    }
    const siteName = accountInfo.siteName || clientName;

    // 3. Encrypt and store tokens in Central Vault
    await saveIntegrationTokens({
      clientKey,
      clientName,
      masterSheetId,
      tool: "capsule",
      tokens,
      metadata: {
        siteName,
        siteUrl: accountInfo?.siteUrl || "",
        userName: accountInfo?.userName || "",
        userEmail: accountInfo?.userEmail || ""
      }
    });

    // Notify all Admins and assigned Client Manager
    notifyStaffOnClientConnection({
      clientName,
      tool: "capsule",
      tenantName: siteName || "",
      masterSheetId
    }).catch(err => console.error("Notification email error:", err.message));

    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${separator}integration=capsule&status=success&site=${encodeURIComponent(siteName)}${clientParam}`);

  } catch (err) {
    console.error("Capsule OAuth callback processing error:", err);
    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${separator}integration=capsule&status=error&message=${encodeURIComponent(sanitizeSpreadsheetTerms(err.message || "Connection failed"))}${clientParam}`);
  }
}
