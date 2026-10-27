/**
 * ============================================================================
 * GOOGLE SHEET CRM OAUTH CALLBACK ROUTE: /api/integrations/google-sheet/callback
 * ============================================================================
 */

import { exchangeGoogleSheetCodeForTokens } from "../../../../services/googleSheetService.js";
import { saveIntegrationTokens } from "../../../../services/vaultService.js";
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

  if (error) {
    console.warn("⚠️ Google Sheet OAuth denied by user:", error, error_description);
    return res.redirect(`/pulse?integration=googlesheet&status=denied&error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: "Missing authorization code or state parameter." });
  }

  const cookies = parseCookies(req.headers.cookie);
  const savedNonce = cookies.pulse_gsheet_nonce;

  const isProd = process.env.NODE_ENV === "production";
  const clearCookieOptions = `Path=/api/integrations/google-sheet; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", `pulse_gsheet_nonce=; ${clearCookieOptions}`);

  let statePayload = null;
  try {
    const stateJson = Buffer.from(state, "base64url").toString("utf8");
    statePayload = JSON.parse(stateJson);
  } catch (err) {
    return res.status(400).json({ error: "Invalid state token structure." });
  }

  if (!savedNonce || statePayload.nonce !== savedNonce) {
    return res.status(403).json({ error: "State nonce verification failed (potential CSRF attempt)." });
  }

  try {
    const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
    const isPulseHost = reqHost && (reqHost === "pulsedashboard.co.uk" || reqHost.endsWith(".pulsedashboard.co.uk"));
    const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const host = isPulseHost ? reqHost : (prodHost || reqHost || "localhost:3000");
    const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
    const redirectUri = `${proto}://${host}/api/integrations/google-sheet/callback`;

    // 1. Exchange code
    const tokens = await exchangeGoogleSheetCodeForTokens({
      code,
      redirectUri
    });

    const clientKey = statePayload.clientKey || statePayload.clientName;
    const clientName = statePayload.clientName || clientKey;
    const masterSheetId = statePayload.masterSheetId;

    // 2. Fetch user identity to store friendly connected account info
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

    // 3. Encrypt and store tokens in Central Vault
    await saveIntegrationTokens({
      clientKey,
      clientName,
      masterSheetId,
      tool: "googlesheet",
      tokens,
      metadata: {
        userEmail,
        accountName: userEmail ? `Google Account (${userEmail})` : "Google Account",
        tenantName: userEmail || "Google Account"
      }
    });

    // Notify staff
    notifyStaffOnClientConnection({
      clientName,
      tool: "googlesheet",
      tenantName: userEmail || "Google Account",
      masterSheetId
    }).catch(err => console.error("Notification email error:", err.message));

    let returnUrl = sanitizeRedirectUrl(statePayload?.redirectBack, "/pma?nav=integrations");
    if (!returnUrl.includes("nav=")) {
      const sep = returnUrl.includes("?") ? "&" : "?";
      returnUrl = `${returnUrl}${sep}nav=integrations`;
    }
    const separator = returnUrl.includes("?") ? "&" : "?";
    return res.redirect(`${returnUrl}${separator}integration=googlesheet&status=success&modal=picker&account=${encodeURIComponent(userEmail)}&client=${encodeURIComponent(clientName)}`);

  } catch (err) {
    console.error("Google Sheet OAuth callback error:", err);
    let returnUrl = sanitizeRedirectUrl(statePayload?.redirectBack, "/pma?nav=integrations");
    if (!returnUrl.includes("nav=")) {
      const sep = returnUrl.includes("?") ? "&" : "?";
      returnUrl = `${returnUrl}${sep}nav=integrations`;
    }
    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientName = statePayload?.clientName || statePayload?.clientKey || "";
    return res.redirect(`${returnUrl}${separator}integration=googlesheet&status=error&message=${encodeURIComponent(err.message)}&client=${encodeURIComponent(clientName)}`);
  }
}
