/**
 * ============================================================================
 * QUICKBOOKS (INTUIT) OAUTH 2.0 & API SERVICE
 * ============================================================================
 * 
 * Handles QuickBooks Online OAuth 2.0 with PKCE (RFC 7636), token exchanges,
 * rolling token refreshes, and company metadata resolution via Intuit API.
 */

const QB_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QB_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const QB_SCOPES = "com.intuit.quickbooks.accounting openid profile email";

/**
 * Resolves QuickBooks Client credentials from environment or sheet parameters.
 */
export function getQBCredentials(customClientId, customClientSecret) {
  const clientId = customClientId || process.env.QB_CLIENT_ID;
  const clientSecret = customClientSecret || process.env.QB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("QuickBooks OAuth credentials missing (QB_CLIENT_ID / QB_CLIENT_SECRET not set).");
  }

  return { clientId, clientSecret };
}

/**
 * Builds the Intuit authorization consent URL with PKCE.
 * 
 * @param {Object} params
 * @param {string} params.redirectUri
 * @param {string} params.state
 * @param {string} [params.codeChallenge]
 * @returns {string} Fully qualified authorization URL
 */
export function buildQBAuthUrl({ redirectUri, state, codeChallenge }) {
  const { clientId } = getQBCredentials();

  const url = new URL(QB_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", QB_SCOPES);
  url.searchParams.set("state", state);

  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  return url.toString();
}

/**
 * Exchanges authorization code for access & refresh tokens.
 */
export function exchangeQBCodeForTokens({ code, redirectUri, codeVerifier, customClientId, customClientSecret }) {
  const { clientId, clientSecret } = getQBCredentials(customClientId, customClientSecret);

  const bodyParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });

  if (codeVerifier) {
    bodyParams.set("code_verifier", codeVerifier);
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  return fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: bodyParams.toString()
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) {
      const errorMsg = data.error_description || data.error || JSON.stringify(data);
      throw new Error(`QuickBooks token exchange failed: ${errorMsg}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in, // typically 3600s
      refreshTokenExpiresIn: data.x_refresh_token_expires_in // typically ~100 days
    };
  });
}

/**
 * Refreshes an expired or expiring QuickBooks access token using the rolling refresh token.
 */
export function refreshQBTokens(refreshToken, customClientId, customClientSecret) {
  const { clientId, clientSecret } = getQBCredentials(customClientId, customClientSecret);

  const bodyParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  return fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: bodyParams.toString()
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) {
      const errorMsg = data.error_description || data.error || JSON.stringify(data);
      throw new Error(`QuickBooks token refresh failed: ${errorMsg}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in
    };
  });
}

/**
 * Resolves the Company Info (Name, etc.) from QuickBooks Online API.
 */
export async function getQBCompanyInfo(accessToken, realmId) {
  if (!realmId || !accessToken) return null;

  try {
    const url = `https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}?minorversion=73`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      console.warn(`⚠️ getQBCompanyInfo returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const info = data?.CompanyInfo;
    return {
      companyName: info?.CompanyName || info?.LegalName || "",
      fiscalYearStartMonth: info?.FiscalYearStartMonth || "",
      country: info?.Country || ""
    };
  } catch (err) {
    console.warn("⚠️ getQBCompanyInfo fetch error:", err.message);
    return null;
  }
}

/**
 * Revokes an access or refresh token with Intuit.
 */
export async function revokeQBToken(token, customClientId, customClientSecret) {
  if (!token) return true;
  try {
    const { clientId, clientSecret } = getQBCredentials(customClientId, customClientSecret);
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const bodyParams = new URLSearchParams({ token });
    const res = await fetch(QB_REVOKE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyParams.toString()
    });

    return res.ok;
  } catch (err) {
    console.warn("⚠️ revokeQBToken error:", err.message);
    return false;
  }
}
