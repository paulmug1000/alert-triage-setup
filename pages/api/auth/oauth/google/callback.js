import { createSessionForVerifiedEmail, getJwtSecret } from "../../../../../services/authService";
import jwt from "jsonwebtoken";


function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    acc[decodeURIComponent(key)] = decodeURIComponent(val);
    return acc;
  }, {});
}

function renderPopupResponse(res, { email, provider, ssoToken, error }) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (error) {
    return res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <title>Pulse Sign-In</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
    .card { background: #1e293b; padding: 32px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 360px; }
  </style>
</head>
<body>
  <div class="card">
    <h3 style="margin: 0 0 8px; color: #ef4444;">Sign-In Cancelled</h3>
    <p style="margin: 0; color: #94a3b8; font-size: 14px;">Closing window...</p>
  </div>
  <script>
    if (window.opener) {
      var targetOrigin = '*';
      try {
        if (document.referrer) {
          var ref = new URL(document.referrer).origin;
          if (ref === 'https://script.google.com' || ref.endsWith('.googleusercontent.com') || ref.endsWith('.pulsedashboard.co.uk')) {
            targetOrigin = ref;
          }
        }
      } catch(e) {}
      window.opener.postMessage({ type: 'PULSE_SSO_ERROR', provider: 'Google', error: ${JSON.stringify(error)} }, targetOrigin);
    }
    setTimeout(function() { window.close(); }, 1200);
  </script>
</body>
</html>`);
  }

  return res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <title>Pulse Sign-In</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
    .card { background: #1e293b; padding: 32px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 360px; }
    .spinner { width: 36px; height: 36px; border: 3px solid rgba(255,255,255,0.1); border-top-color: #3b82f6; border-radius: 50%; animation: spin 1s infinite linear; margin: 0 auto 16px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h3 style="margin: 0 0 8px;">Authenticated</h3>
    <p style="margin: 0; color: #94a3b8; font-size: 14px;">Returning to Pulse...</p>
  </div>
  <script>
    try {
      if (window.opener) {
        var targetOrigin = '*';
        try {
          if (document.referrer) {
            var ref = new URL(document.referrer).origin;
            if (ref === 'https://script.google.com' || ref.endsWith('.googleusercontent.com') || ref.endsWith('.pulsedashboard.co.uk')) {
              targetOrigin = ref;
            }
          }
        } catch(e) {}
        window.opener.postMessage({
          type: 'PULSE_SSO_SUCCESS',
          email: ${JSON.stringify(email)},
          provider: ${JSON.stringify(provider || 'Google')},
          ssoToken: ${JSON.stringify(ssoToken)}
        }, targetOrigin);
      }
    } catch (e) {
      console.error(e);
    }
    setTimeout(function() { window.close(); }, 400);
  </script>
</body>
</html>`);
}

export default async function handler(req, res) {
  const { code, error, state } = req.query;

  let isPopup = false;
  let stateNonce = null;
  try {
    if (state) {
      const parsed = typeof state === "string" && (state.startsWith("{") ? JSON.parse(state) : { mode: state });
      if (parsed.mode === "popup") isPopup = true;
      if (parsed.nonce) stateNonce = parsed.nonce;
    }
  } catch (e) {}

  // Verify CSRF state nonce & PKCE code verifier
  const cookies = parseCookies(req.headers.cookie);
  const cookieNonce = cookies.pma_oauth_nonce;
  const codeVerifier = cookies.pma_oauth_verifier;
  // Clear the OAuth cookies
  const isProd = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", [
    `pma_oauth_nonce=; Path=/api/auth/oauth; HttpOnly; Max-Age=0${isProd ? "; Secure" : ""}`,
    `pma_oauth_verifier=; Path=/api/auth/oauth; HttpOnly; Max-Age=0${isProd ? "; Secure" : ""}`
  ]);

  if (stateNonce && cookieNonce && stateNonce !== cookieNonce) {
    console.warn("⚠️ Google OAuth state mismatch (potential CSRF attempt)");
    if (isPopup) {
      return renderPopupResponse(res, { error: "state_mismatch" });
    }
    res.redirect("/?auth_error=state_mismatch");
    return;
  }

  if (error) {
    console.warn("⚠️ Google OAuth error:", error);
    if (isPopup) {
      return renderPopupResponse(res, { error: String(error) });
    }
    res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
    return;
  }

  if (!code) {
    if (isPopup) {
      return renderPopupResponse(res, { error: "missing_code" });
    }
    res.redirect("/?auth_error=missing_code");
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment");
    if (isPopup) {
      return renderPopupResponse(res, { error: "server_configuration_error" });
    }
    res.redirect("/?auth_error=server_configuration_error");
    return;
  }

  // Host resolution: prioritize verified pulsedashboard.co.uk host, then configured prod host
  const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
  const isPulseHost = reqHost && (reqHost === "pulsedashboard.co.uk" || reqHost.endsWith(".pulsedashboard.co.uk"));
  const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const host = isPulseHost ? reqHost : (prodHost || reqHost || "localhost:3000");
  const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
  const redirectUri = `${proto}://${host}/api/auth/oauth/google/callback`;

  try {
    // 1. Exchange authorization code for tokens (RFC 7636 PKCE)
    const tokenPayload = {
      code: String(code),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    };
    if (codeVerifier) {
      tokenPayload.code_verifier = codeVerifier;
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenPayload)
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("❌ Google token exchange failed:", tokenData);
      if (isPopup) {
        return renderPopupResponse(res, { error: tokenData.error_description || "Token exchange failed" });
      }
      res.redirect(`/?auth_error=${encodeURIComponent(tokenData.error_description || "Token exchange failed")}`);
      return;
    }

    // 2. Fetch user profile from Google UserInfo endpoint
    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const userData = await userRes.json();
    if (!userRes.ok || !userData.email) {
      console.error("❌ Failed to fetch Google userinfo:", userData);
      if (isPopup) {
        return renderPopupResponse(res, { error: "failed_to_fetch_user_profile" });
      }
      res.redirect("/?auth_error=failed_to_fetch_user_profile");
      return;
    }

    const email = userData.email.toLowerCase().trim();
    console.log(`🔑 Verified Google OAuth login attempt for: ${email} (isPopup: ${isPopup})`);

    // In popup mode, mint a strictly scoped SSO token (tokenType: "sso_token")
    if (isPopup) {
      const secret = getJwtSecret();
      const ssoToken = jwt.sign(
        { tokenType: "sso_token", email, provider: "Google" },
        secret,
        { expiresIn: "5m" }
      );
      return renderPopupResponse(res, { email, provider: "Google", ssoToken });
    }

    // 3. Verify user authorization in Users sheet and mint session cookie for PMA
    const forwarded = req.headers["x-forwarded-for"];
    const clientIp = (typeof forwarded === "string" ? forwarded.split(",")[0] : forwarded?.[0])?.trim() || req.socket?.remoteAddress || "127.0.0.1";
    const result = await createSessionForVerifiedEmail(email, res, "Google", undefined, clientIp);

    if (!result.success) {
      console.warn(`⛔ Access denied for Google user ${email}:`, result.message);
      res.redirect(`/?auth_error=unauthorized&email=${encodeURIComponent(email)}&provider=Google`);
      return;
    }

    console.log(`✅ Google OAuth login successful for: ${email}`);

    // If user is ClientUser or Senior (Restricted), take them directly to Pulse Portal (never PMA)
    const userRole = String(result.user?.role || "").trim();
    const isPulseOnly = userRole === "ClientUser" || 
                        userRole === "Senior (Restricted)" || 
                        Boolean(result.user?.isSenior) ||
                        (!result.user?.isAdmin && userRole !== "ClientManager");

    if (isPulseOnly) {
      res.redirect("/pulse");
      return;
    }

    res.redirect("/");
    return;
  } catch (err) {
    console.error("❌ Google OAuth callback exception:", err);
    if (isPopup) {
      return renderPopupResponse(res, { error: err.message || "An unexpected error occurred" });
    }
    res.redirect(`/?auth_error=${encodeURIComponent(err.message || "An unexpected error occurred during Google sign in")}`);
    return;
  }
}
