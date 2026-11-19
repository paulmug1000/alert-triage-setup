import {
  createSessionForVerifiedEmail,
  verifySignedOAuthState,
  safeCompareSecret,
  getTrustedClientIp,
} from "../../../../../services/authService";

const CANONICAL_PULSE_HOSTS = new Set([
  "pulsedashboard.co.uk",
  "app.pulsedashboard.co.uk",
  "pma.pulsedashboard.co.uk",
]);

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try {
      acc[decodeURIComponent(key)] = decodeURIComponent(val);
    } catch {
      acc[key] = val;
    }
    return acc;
  }, {});
}

export default async function handler(req, res) {
  const { code, error, state } = req.query;

  const cookies = parseCookies(req.headers.cookie);
  const cookieNonce = cookies.pma_oauth_nonce;
  const codeVerifier = cookies.pma_oauth_verifier;
  const isProd = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", [
    `pma_oauth_nonce=; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`,
    `pma_oauth_verifier=; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`
  ]);

  const statePayload = verifySignedOAuthState(String(state || ""));
  if (
    !statePayload ||
    !statePayload.nonce ||
    !cookieNonce ||
    !safeCompareSecret(String(statePayload.nonce), String(cookieNonce)) ||
    !codeVerifier
  ) {
    console.warn("⚠️ Google OAuth state or PKCE verifier mismatch/missing (potential CSRF attempt)");
    res.redirect("/pma?auth_error=state_mismatch");
    return;
  }

  if (error) {
    console.warn("⚠️ Google OAuth error:", String(error));
    res.redirect("/pma?auth_error=oauth_denied");
    return;
  }

  if (!code) {
    res.redirect("/pma?auth_error=missing_code");
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment");
    res.redirect("/pma?auth_error=server_configuration_error");
    return;
  }

  const reqHostRaw = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  const isPulseHost = CANONICAL_PULSE_HOSTS.has(reqHostRaw);
  const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const host = isPulseHost ? reqHostRaw : (prodHost || (process.env.NODE_ENV !== "production" ? reqHostRaw : "app.pulsedashboard.co.uk") || "localhost:3000");
  const isLocal = process.env.NODE_ENV !== "production" && (host.startsWith("localhost") || host.startsWith("127.0.0.1"));
  const proto = isLocal ? (req.headers["x-forwarded-proto"] || "http") : "https";
  const redirectUri = `${proto}://${host}/api/auth/oauth/google/callback`;

  try {
    const tokenPayload = {
      code: String(code),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier
    };

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenPayload)
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("❌ Google token exchange failed:", {
        status: tokenRes.status,
        error: tokenData?.error,
        error_description: tokenData?.error_description
      });
      res.redirect("/pma?auth_error=token_exchange_failed");
      return;
    }

    // Strictly verify OIDC id_token claims, nonce, and issuer returned by Google
    if (!tokenData.id_token) {
      res.redirect("/pma?auth_error=invalid_identity_token");
      return;
    }
    let idClaims = null;
    try {
      const parts = String(tokenData.id_token).split(".");
      if (parts.length !== 3) {
        res.redirect("/pma?auth_error=invalid_identity_token");
        return;
      }
      idClaims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      const validIssuer =
        idClaims?.iss === "https://accounts.google.com" ||
        idClaims?.iss === "accounts.google.com";
      if (
        !idClaims ||
        typeof idClaims !== "object" ||
        idClaims.aud !== clientId ||
        !validIssuer ||
        typeof idClaims.exp !== "number" ||
        idClaims.exp * 1000 <= Date.now() ||
        !cookieNonce ||
        !idClaims.nonce ||
        !safeCompareSecret(String(idClaims.nonce), String(cookieNonce))
      ) {
        res.redirect("/pma?auth_error=invalid_identity_token");
        return;
      }
    } catch {
      res.redirect("/pma?auth_error=invalid_identity_token");
      return;
    }

    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const userData = await userRes.json();
    if (
      !userRes.ok ||
      !userData.email ||
      userData.email_verified !== true ||
      (idClaims.sub && userData.sub && idClaims.sub !== userData.sub)
    ) {
      console.error("❌ Failed to fetch verified Google userinfo:", { status: userRes.status, verified: userData?.email_verified });
      res.redirect("/pma?auth_error=failed_to_fetch_user_profile");
      return;
    }

    const email = userData.email.toLowerCase().trim();
    console.log(`🔑 Verified Google OAuth login attempt for: ${email}`);

    const clientIp = getTrustedClientIp(req);
    const result = await createSessionForVerifiedEmail(email, res, "Google", undefined, clientIp);

    if (!result.success) {
      console.warn(`⛔ Access denied for Google user ${email}:`, result.message);
      res.redirect(`/pma?auth_error=unauthorized&email=${encodeURIComponent(email)}&provider=Google`);
      return;
    }

    console.log(`✅ Google OAuth login successful for: ${email}`);

    const userRole = String(result.user?.role || "").trim();
    const isPulseOnly = userRole === "ClientUser" ||
      userRole === "Senior (Restricted)" ||
      Boolean(result.user?.isSenior) ||
      (!result.user?.isAdmin && userRole !== "ClientManager");

    res.redirect(isPulseOnly ? "/pulse" : "/pma");
    return;
  } catch (err) {
    console.error("❌ Google OAuth callback exception:", err?.message || err);
    res.redirect("/pma?auth_error=oauth_callback_failed");
    return;
  }
}
