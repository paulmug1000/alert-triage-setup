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

function safeJsonForScript(value) {
  return JSON.stringify(value ?? "")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
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
    body { font-family: 'Kumbh Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
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
      var targetOrigin = window.location.origin;
      try {
        if (document.referrer) {
          var ref = new URL(document.referrer).origin;
          if (ref === 'https://app.pulsedashboard.co.uk' || ref === 'https://pulsedashboard.co.uk' || ref === window.location.origin) {
            targetOrigin = ref;
          }
        }
      } catch(e) {}
      window.opener.postMessage({ type: 'PULSE_SSO_ERROR', provider: 'Microsoft', error: ${safeJsonForScript(error)} }, targetOrigin);
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
    body { font-family: 'Kumbh Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
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
        var targetOrigin = window.location.origin;
        try {
          if (document.referrer) {
            var ref = new URL(document.referrer).origin;
            if (ref === 'https://app.pulsedashboard.co.uk' || ref === 'https://pulsedashboard.co.uk' || ref === window.location.origin) {
              targetOrigin = ref;
            }
          }
        } catch(e) {}
        window.opener.postMessage({
          type: 'PULSE_SSO_SUCCESS',
          email: ${safeJsonForScript(email)},
          provider: ${safeJsonForScript(provider || 'Microsoft')},
          ssoToken: ${safeJsonForScript(ssoToken)}
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
  const { code, error, error_description, state } = req.query;

  let isPopup = false;
  let stateNonce = null;
  try {
    if (state) {
      const parsed = typeof state === "string" && (state.startsWith("{") ? JSON.parse(state) : { mode: state });
      if (parsed.mode === "popup") isPopup = true;
      if (parsed.nonce) stateNonce = parsed.nonce;
    }
  } catch (e) {}

  // Verify CSRF state nonce & PKCE code verifier (fail-closed)
  const cookies = parseCookies(req.headers.cookie);
  const cookieNonce = cookies.pma_oauth_nonce;
  const codeVerifier = cookies.pma_oauth_verifier;
  // Clear the OAuth cookies
  const isProd = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", [
    `pma_oauth_nonce=; Path=/api/auth/oauth; HttpOnly; Max-Age=0${isProd ? "; Secure" : ""}`,
    `pma_oauth_verifier=; Path=/api/auth/oauth; HttpOnly; Max-Age=0${isProd ? "; Secure" : ""}`
  ]);

  if (!stateNonce || !cookieNonce || stateNonce !== cookieNonce || !codeVerifier) {
    console.warn("⚠️ Microsoft OAuth state or PKCE verifier mismatch/missing (potential CSRF attempt)");
    if (isPopup) {
      return renderPopupResponse(res, { error: "state_mismatch" });
    }
    res.redirect("/pma?auth_error=state_mismatch");
    return;
  }

  if (error) {
    console.warn("⚠️ Microsoft OAuth error:", error, error_description);
    if (isPopup) {
      return renderPopupResponse(res, { error: String(error_description || error) });
    }
    res.redirect(`/pma?auth_error=${encodeURIComponent(error_description || error)}`);
    return;
  }

  if (!code) {
    if (isPopup) {
      return renderPopupResponse(res, { error: "missing_code" });
    }
    res.redirect("/pma?auth_error=missing_code");
    return;
  }

  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("❌ Missing AZURE_CLIENT_ID or AZURE_CLIENT_SECRET in environment");
    if (isPopup) {
      return renderPopupResponse(res, { error: "server_configuration_error" });
    }
    res.redirect("/pma?auth_error=server_configuration_error");
    return;
  }

  // Host resolution: prioritize verified pulsedashboard.co.uk host, then configured prod host
  const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
  const isPulseHost = reqHost && (reqHost === "pulsedashboard.co.uk" || reqHost.endsWith(".pulsedashboard.co.uk"));
  const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const host = isPulseHost ? reqHost : (prodHost || reqHost || "localhost:3000");
  const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
  const redirectUri = `${proto}://${host}/api/auth/oauth/microsoft/callback`;

  try {
    // 1. Exchange authorization code for tokens (RFC 7636 PKCE)
    const tokenPayload = {
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: "openid email profile User.Read",
      code_verifier: codeVerifier
    };

    const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenPayload)
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("❌ Microsoft token exchange failed:", tokenData);
      if (isPopup) {
        return renderPopupResponse(res, { error: tokenData.error_description || "Microsoft token exchange failed" });
      }
      res.redirect(`/pma?auth_error=${encodeURIComponent(tokenData.error_description || "Microsoft token exchange failed")}`);
      return;
    }

    // 2. Verify id_token identity & email domain ownership (CRIT-01: prevent nOAuth unverified mail spoofing)
    if (!tokenData.id_token) {
      console.error("❌ Microsoft token response missing id_token");
      if (isPopup) {
        return renderPopupResponse(res, { error: "missing_identity_token" });
      }
      res.redirect("/pma?auth_error=missing_identity_token");
      return;
    }

    let idClaims = null;
    try {
      const idTokenParts = String(tokenData.id_token).split(".");
      if (idTokenParts.length === 3) {
        idClaims = JSON.parse(Buffer.from(idTokenParts[1], "base64url").toString("utf8"));
      }
    } catch (parseErr) {
      console.error("❌ Failed to parse Microsoft id_token claims:", parseErr);
    }

    if (!idClaims || typeof idClaims !== "object") {
      if (isPopup) {
        return renderPopupResponse(res, { error: "invalid_identity_token" });
      }
      res.redirect("/pma?auth_error=invalid_identity_token");
      return;
    }

    // Consumer MSA tenant ID vs organizational Entra ID tenant
    const MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
    const isDomainVerified =
      idClaims.xms_edov === true ||
      idClaims.xms_edov === "true" ||
      idClaims.xms_edov === 1;

    // Fetch user profile from Microsoft Graph
    const graphRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const graphUser = await graphRes.json();
    if (!graphRes.ok) {
      console.error("❌ Failed to fetch Microsoft Graph user:", graphUser);
      if (isPopup) {
        return renderPopupResponse(res, { error: "failed_to_fetch_user_profile" });
      }
      res.redirect("/pma?auth_error=failed_to_fetch_user_profile");
      return;
    }

    // Only trust verified identity claims (never trust an unverified external directory's editable `mail` attribute)
    const upnEmail = String(idClaims.preferred_username || graphUser.userPrincipalName || "").toLowerCase().trim();
    const claimEmail = String(idClaims.email || "").toLowerCase().trim();
    let email = "";
    if (isDomainVerified) {
      email = claimEmail || upnEmail;
    } else if (idClaims.tid === MSA_TENANT_ID) {
      email = upnEmail || claimEmail;
    } else if (upnEmail && !upnEmail.includes("#ext#") && (!claimEmail || claimEmail === upnEmail)) {
      // If xms_edov is omitted on older tenant tokens, only accept UPN (which requires tenant DNS domain verification in Entra ID), never an arbitrary `mail` override
      email = upnEmail;
    }

    if (!email || !email.includes("@")) {
      console.error("❌ Unverified or missing email in Microsoft profile:", { tid: idClaims.tid, xms_edov: idClaims.xms_edov });
      if (isPopup) {
        return renderPopupResponse(res, { error: "unverified_email_domain" });
      }
      res.redirect("/pma?auth_error=unverified_email_domain");
      return;
    }

    console.log(`🔑 Verified Microsoft OAuth login attempt for: ${email} (isPopup: ${isPopup})`);

    // In popup mode, mint a strictly scoped SSO token (tokenType: "sso_token")
    if (isPopup) {
      const secret = getJwtSecret();
      const ssoToken = jwt.sign(
        { tokenType: "sso_token", email, provider: "Microsoft" },
        secret,
        { expiresIn: "5m" }
      );
      return renderPopupResponse(res, { email, provider: "Microsoft", ssoToken });
    }

    // 3. Verify user authorization in Users sheet and mint session cookie for PMA
    const forwarded = req.headers["x-forwarded-for"];
    const clientIp = req.headers["x-real-ip"]?.trim() || (typeof forwarded === "string" ? forwarded.split(",").pop() : forwarded?.[0])?.trim() || req.socket?.remoteAddress || "127.0.0.1";
    const result = await createSessionForVerifiedEmail(email, res, "Microsoft", undefined, clientIp);

    if (!result.success) {
      console.warn(`⛔ Access denied for Microsoft user ${email}:`, result.message);
      res.redirect(`/pma?auth_error=unauthorized&email=${encodeURIComponent(email)}&provider=Microsoft`);
      return;
    }

    console.log(`✅ Microsoft OAuth login successful for: ${email}`);

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

    res.redirect("/pma");
    return;
  } catch (err) {
    console.error("❌ Microsoft OAuth callback exception:", err);
    if (isPopup) {
      return renderPopupResponse(res, { error: err.message || "An unexpected error occurred" });
    }
    res.redirect(`/pma?auth_error=${encodeURIComponent(err.message || "An unexpected error occurred during Microsoft sign in")}`);
    return;
  }
}
