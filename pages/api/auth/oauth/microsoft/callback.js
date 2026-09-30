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
      window.opener.postMessage({ type: 'PULSE_SSO_ERROR', provider: 'Microsoft', error: ${JSON.stringify(error)} }, '*');
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
          provider: ${JSON.stringify(provider || 'Microsoft')},
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
  const { code, error, error_description, state } = req.query;

  let isPopup = false;
  try {
    if (state) {
      const parsed = typeof state === "string" && (state.startsWith("{") ? JSON.parse(state) : { mode: state });
      if (parsed.mode === "popup") isPopup = true;
    }
  } catch (e) {}

  if (error) {
    console.warn("⚠️ Microsoft OAuth error:", error, error_description);
    if (isPopup) {
      return renderPopupResponse(res, { error: String(error_description || error) });
    }
    res.redirect(`/?auth_error=${encodeURIComponent(error_description || error)}`);
    return;
  }

  if (!code) {
    if (isPopup) {
      return renderPopupResponse(res, { error: "missing_code" });
    }
    res.redirect("/?auth_error=missing_code");
    return;
  }

  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("❌ Missing AZURE_CLIENT_ID or AZURE_CLIENT_SECRET in environment");
    if (isPopup) {
      return renderPopupResponse(res, { error: "server_configuration_error" });
    }
    res.redirect("/?auth_error=server_configuration_error");
    return;
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
  const redirectUri = `${proto}://${host}/api/auth/oauth/microsoft/callback`;

  try {
    // 1. Exchange authorization code for tokens
    const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: "openid email profile User.Read"
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("❌ Microsoft token exchange failed:", tokenData);
      if (isPopup) {
        return renderPopupResponse(res, { error: tokenData.error_description || "Microsoft token exchange failed" });
      }
      res.redirect(`/?auth_error=${encodeURIComponent(tokenData.error_description || "Microsoft token exchange failed")}`);
      return;
    }

    // 2. Fetch user profile from Microsoft Graph
    const graphRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const graphUser = await graphRes.json();
    if (!graphRes.ok) {
      console.error("❌ Failed to fetch Microsoft Graph user:", graphUser);
      if (isPopup) {
        return renderPopupResponse(res, { error: "failed_to_fetch_user_profile" });
      }
      res.redirect("/?auth_error=failed_to_fetch_user_profile");
      return;
    }

    // Work accounts usually have 'mail', fallback to 'userPrincipalName'
    const email = (graphUser.mail || graphUser.userPrincipalName || "").toLowerCase().trim();
    if (!email) {
      console.error("❌ No email found in Microsoft profile:", graphUser);
      if (isPopup) {
        return renderPopupResponse(res, { error: "no_email_returned_from_microsoft" });
      }
      res.redirect("/?auth_error=no_email_returned_from_microsoft");
      return;
    }

    console.log(`🔑 Verified Microsoft OAuth login attempt for: ${email} (isPopup: ${isPopup})`);

    // In popup mode, mint an SSO token and hand back to opener
    if (isPopup) {
      const secret = process.env.PMA_JWT_SECRET || "pulse-sso-secret-fallback";
      const ssoToken = jwt.sign(
        { email, provider: "Microsoft" },
        secret,
        { expiresIn: "5m" }
      );
      return renderPopupResponse(res, { email, provider: "Microsoft", ssoToken });
    }

    // 3. Verify user authorization in Users sheet and mint session cookie for PMA
    const result = await createSessionForVerifiedEmail(email, res, "Microsoft");

    if (!result.success) {
      console.warn(`⛔ Access denied for Microsoft user ${email}:`, result.message);
      res.redirect(`/?auth_error=unauthorized&email=${encodeURIComponent(email)}&provider=Microsoft`);
      return;
    }

    console.log(`✅ Microsoft OAuth login successful for: ${email}`);
    res.redirect("/");
    return;
  } catch (err) {
    console.error("❌ Microsoft OAuth callback exception:", err);
    if (isPopup) {
      return renderPopupResponse(res, { error: err.message || "An unexpected error occurred" });
    }
    res.redirect(`/?auth_error=${encodeURIComponent(err.message || "An unexpected error occurred during Microsoft sign in")}`);
    return;
  }
}
