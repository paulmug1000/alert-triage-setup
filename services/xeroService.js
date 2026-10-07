/**
 * ============================================================================
 * XERO SERVICE - OAUTH 2.0 PROTOCOL & API WRAPPER
 * ============================================================================
 * 
 * Handles Xero's official OAuth 2.0 Authorization Code flow with PKCE,
 * token exchange, tenant resolution (/connections), automated token refresh,
 * and token revocation.
 */

import crypto from "crypto";

const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
const XERO_REVOCATION_URL = "https://identity.xero.com/connect/revocation";

// Full required scopes for Pulse invoice, tracking, and P&L sync
export const XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.transactions",
  "accounting.settings",
  "accounting.reports.read",
  "offline_access"
].join(" ");

/**
 * Returns configured Xero credentials from environment.
 */
export function getXeroCredentials() {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing XERO_CLIENT_ID or XERO_CLIENT_SECRET environment variable.");
  }

  return { clientId, clientSecret };
}

/**
 * Generates the Xero authorization consent URL with PKCE (RFC 7636).
 * 
 * @param {Object} params
 * @param {string} params.redirectUri
 * @param {string} params.state
 * @param {string} [params.codeChallenge]
 * @returns {string} Fully qualified authorization URL
 */
export function buildXeroAuthUrl({ redirectUri, state, codeChallenge }) {
  const { clientId } = getXeroCredentials();

  const url = new URL(XERO_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", XERO_SCOPES);
  url.searchParams.set("state", state);

  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  return url.toString();
}

/**
 * Exchanges the authorization code for tokens.
 * 
 * @param {Object} params
 * @param {string} params.code
 * @param {string} params.redirectUri
 * @param {string} [params.codeVerifier]
 * @returns {Promise<Object>} { accessToken, refreshToken, idToken, expiresIn, tokenType, scope }
 */
export async function exchangeCodeForTokens({ code, redirectUri, codeVerifier }) {
  const { clientId, clientSecret } = getXeroCredentials();

  const bodyParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });

  if (codeVerifier) {
    bodyParams.set("code_verifier", codeVerifier);
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: bodyParams.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.error_description || data.error || JSON.stringify(data);
    throw new Error(`Xero token exchange failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token || "",
    expiresIn: data.expires_in || 1800,
    tokenType: data.token_type || "Bearer",
    scope: data.scope || ""
  };
}

/**
 * Fetches authorized Xero organisations (tenants) for this token.
 * 
 * @param {string} accessToken
 * @returns {Promise<Array<{ id: string, tenantId: string, tenantType: string, tenantName: string, createdDateUtc: string }>>}
 */
export async function getXeroConnections(accessToken) {
  const res = await fetch(XERO_CONNECTIONS_URL, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch Xero connections (${res.status}): ${errorText}`);
  }

  const connections = await res.json();
  return connections.map(conn => ({
    id: conn.id,
    tenantId: conn.tenantId,
    tenantType: conn.tenantType,
    tenantName: conn.tenantName,
    createdDateUtc: conn.createdDateUtc
  }));
}

/**
 * Refreshes an expired or expiring access token using the rolling refresh token.
 * Xero returns a new access token AND a new rolling refresh token.
 * 
 * @param {string} refreshToken
 * @returns {Promise<Object>} { accessToken, refreshToken, expiresIn }
 */
export async function refreshXeroTokens(refreshToken) {
  const { clientId, clientSecret } = getXeroCredentials();

  const bodyParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: bodyParams.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.error_description || data.error || JSON.stringify(data);
    throw new Error(`Xero token refresh failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 1800,
    tokenType: data.token_type || "Bearer"
  };
}

/**
 * Revokes a Xero token when a user clicks "Disconnect" (required for security audit).
 * 
 * @param {string} token Can be either access_token or refresh_token
 * @returns {Promise<boolean>}
 */
export async function revokeXeroToken(token) {
  const { clientId, clientSecret } = getXeroCredentials();

  const bodyParams = new URLSearchParams({
    token
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const res = await fetch(XERO_REVOCATION_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyParams.toString()
    });

    return res.ok || res.status === 200;
  } catch (err) {
    console.warn("⚠️ Xero revocation call failed:", err.message);
    return false;
  }
}
