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
  const { code, error, error_description, state } = req.query;

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
    console.warn("⚠️ Microsoft OAuth state or PKCE verifier mismatch/missing (potential CSRF attempt)");
    res.redirect("/pma?auth_error=state_mismatch");
    return;
  }

  if (error) {
    console.warn("⚠️ Microsoft OAuth error:", String(error), String(error_description || ""));
    res.redirect("/pma?auth_error=oauth_denied");
    return;
  }

  if (!code) {
    res.redirect("/pma?auth_error=missing_code");
    return;
  }

  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("❌ Missing AZURE_CLIENT_ID or AZURE_CLIENT_SECRET in environment");
    res.redirect("/pma?auth_error=server_configuration_error");
    return;
  }

  const reqHostRaw = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  const isPulseHost = CANONICAL_PULSE_HOSTS.has(reqHostRaw);
  const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const host = isPulseHost ? reqHostRaw : (prodHost || (process.env.NODE_ENV !== "production" ? reqHostRaw : "app.pulsedashboard.co.uk") || "localhost:3000");
  const isLocal = process.env.NODE_ENV !== "production" && (host.startsWith("localhost") || host.startsWith("127.0.0.1"));
  const proto = isLocal ? (req.headers["x-forwarded-proto"] || "http") : "https";
  const redirectUri = `${proto}://${host}/api/auth/oauth/microsoft/callback`;

  try {
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
      console.error("❌ Microsoft token exchange failed:", {
        status: tokenRes.status,
        error: tokenData?.error,
        error_description: tokenData?.error_description
      });
      res.redirect("/pma?auth_error=token_exchange_failed");
      return;
    }

    if (!tokenData.id_token) {
      console.error("❌ Microsoft token response missing id_token");
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
      console.error("❌ Failed to parse Microsoft id_token claims:", parseErr?.message);
    }

    if (
      !idClaims ||
      typeof idClaims !== "object" ||
      idClaims.aud !== clientId ||
      typeof idClaims.exp !== "number" ||
      idClaims.exp * 1000 <= Date.now() ||
      typeof idClaims.tid !== "string" ||
      !idClaims.tid.trim() ||
      typeof idClaims.iss !== "string" ||
      idClaims.iss !== `https://login.microsoftonline.com/${idClaims.tid.trim()}/v2.0` ||
      !safeCompareSecret(String(idClaims.nonce || ""), String(cookieNonce))
    ) {
      res.redirect("/pma?auth_error=invalid_identity_token");
      return;
    }

    // Explicitly reject unverified email domains (prevents consumer MSA alias takeover)
    const explicitlyUnverified =
      idClaims.xms_edov === false ||
      idClaims.xms_edov === "false" ||
      idClaims.xms_edov === 0 ||
      idClaims.email_verified === false;

    if (explicitlyUnverified) {
      console.error("❌ Explicitly unverified Microsoft email domain claim:", { tid: idClaims.tid, xms_edov: idClaims.xms_edov });
      res.redirect("/pma?auth_error=unverified_email_domain");
      return;
    }

    const MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
    const isDomainVerified =
      idClaims.xms_edov === true ||
      idClaims.xms_edov === "true" ||
      idClaims.xms_edov === 1;

    const graphRes = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,userType", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const graphUser = await graphRes.json();
    if (!graphRes.ok) {
      console.error("❌ Failed to fetch Microsoft Graph user:", { status: graphRes.status });
      res.redirect("/pma?auth_error=failed_to_fetch_user_profile");
      return;
    }

    const graphUpn = String(graphUser.userPrincipalName || "").toLowerCase().trim();
    const graphUserType = String(graphUser.userType || "").toLowerCase().trim();
    const preferredUsername = String(idClaims.preferred_username || "").toLowerCase().trim();
    const claimEmail = String(idClaims.email || "").toLowerCase().trim();

    // Always block B2B Guest / external UPNs even if preferred_username shadows a victim domain
    if (graphUserType === "guest" || graphUpn.includes("#ext#") || preferredUsername.includes("#ext#")) {
      console.error("❌ Blocked external or B2B guest Microsoft identity:", { tid: idClaims.tid, userType: graphUserType });
      res.redirect("/pma?auth_error=unverified_email_domain");
      return;
    }

    // Never allow idClaims.preferred_username to shadow an inconsistent Graph UPN
    const upnEmail = graphUpn || preferredUsername;
    const isNativeMsaDomain = /@(outlook|hotmail|live|msn)\.(com|co\.uk|[a-z]{2,3}(\.[a-z]{2})?)$/i.test(upnEmail);

    let email = "";
    if (isDomainVerified) {
      email = claimEmail || upnEmail;
    } else if (idClaims.tid === MSA_TENANT_ID) {
      if (upnEmail && isNativeMsaDomain) {
        email = upnEmail;
      }
    } else if (
      idClaims.xms_edov === undefined &&
      graphUpn &&
      (!preferredUsername || preferredUsername === graphUpn) &&
      (!claimEmail || claimEmail === graphUpn)
    ) {
      email = graphUpn;
    }

    if (!email || !email.includes("@")) {
      console.error("❌ Unverified or missing email in Microsoft profile:", { tid: idClaims.tid, xms_edov: idClaims.xms_edov });
      res.redirect("/pma?auth_error=unverified_email_domain");
      return;
    }

    console.log(`🔑 Verified Microsoft OAuth login attempt for: ${email}`);

    const clientIp = getTrustedClientIp(req);
    const result = await createSessionForVerifiedEmail(email, res, "Microsoft", undefined, clientIp);

    if (!result.success) {
      console.warn(`⛔ Access denied for Microsoft user ${email}:`, result.message);
      res.redirect(`/pma?auth_error=unauthorized&email=${encodeURIComponent(email)}&provider=Microsoft`);
      return;
    }

    console.log(`✅ Microsoft OAuth login successful for: ${email}`);

    const userRole = String(result.user?.role || "").trim();
    const isPulseOnly = userRole === "ClientUser" ||
      userRole === "Senior (Restricted)" ||
      Boolean(result.user?.isSenior) ||
      (!result.user?.isAdmin && userRole !== "ClientManager");

    res.redirect(isPulseOnly ? "/pulse" : "/pma");
    return;
  } catch (err) {
    console.error("❌ Microsoft OAuth callback exception:", err?.message || err);
    res.redirect("/pma?auth_error=oauth_callback_failed");
    return;
  }
}
