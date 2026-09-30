import { createSessionForVerifiedEmail } from "../../../../../services/authService";
import jwt from "jsonwebtoken";

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
      window.opener.postMessage({ type: 'PULSE_SSO_ERROR', provider: 'Google', error: ${JSON.stringify(error)} }, '*');
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
        window.opener.postMessage({
          type: 'PULSE_SSO_SUCCESS',
          email: ${JSON.stringify(email)},
          provider: ${JSON.stringify(provider || 'Google')},
          ssoToken: ${JSON.stringify(ssoToken)}
        }, '*');
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
  try {
    if (state) {
      const parsed = typeof state === "string" && (state.startsWith("{") ? JSON.parse(state) : { mode: state });
      if (parsed.mode === "popup") isPopup = true;
    }
  } catch (e) {}

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

  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
  const redirectUri = `${proto}://${host}/api/auth/oauth/google/callback`;

  try {
    // 1. Exchange authorization code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
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

    // In popup mode, mint an SSO token and hand back to opener
    if (isPopup) {
      const secret = process.env.PMA_JWT_SECRET || "pulse-sso-secret-fallback";
      const ssoToken = jwt.sign(
        { email, provider: "Google" },
        secret,
        { expiresIn: "5m" }
      );
      return renderPopupResponse(res, { email, provider: "Google", ssoToken });
    }

    // 3. Verify user authorization in Users sheet and mint session cookie for PMA
    const result = await createSessionForVerifiedEmail(email, res, "Google");

    if (!result.success) {
      console.warn(`⛔ Access denied for Google user ${email}:`, result.message);
      res.redirect(`/?auth_error=unauthorized&email=${encodeURIComponent(email)}&provider=Google`);
      return;
    }

    console.log(`✅ Google OAuth login successful for: ${email}`);
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
