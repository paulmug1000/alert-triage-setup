/**
 * ============================================================================
 * PIPEDRIVE CRM OAUTH 2.0 & API SERVICE
 * ============================================================================
 * 
 * Handles Pipedrive OAuth 2.0 authorization code flow, Basic Auth token exchange,
 * rolling token refreshes, and company/user metadata resolution.
 */

const PIPEDRIVE_AUTH_URL = "https://oauth.pipedrive.com/oauth/authorize";
const PIPEDRIVE_TOKEN_URL = "https://oauth.pipedrive.com/oauth/token";
const PIPEDRIVE_REVOKE_URL = "https://oauth.pipedrive.com/oauth/revoke";
const PIPEDRIVE_API_URL = "https://api.pipedrive.com/v1";

export function getPipedriveCredentials(customClientId, customClientSecret) {
  const clientId = customClientId || process.env.PIPEDRIVE_CLIENT_ID;
  const clientSecret = customClientSecret || process.env.PIPEDRIVE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Pipedrive OAuth credentials missing (PIPEDRIVE_CLIENT_ID / PIPEDRIVE_CLIENT_SECRET not set).");
  }

  return { clientId, clientSecret };
}

export function buildPipedriveAuthUrl({ redirectUri, state }) {
  const { clientId } = getPipedriveCredentials();

  const url = new URL(PIPEDRIVE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  return url.toString();
}

export async function exchangePipedriveCodeForTokens({ code, redirectUri, customClientId, customClientSecret }) {
  const { clientId, clientSecret } = getPipedriveCredentials(customClientId, customClientSecret);
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const bodyParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });

  const res = await fetch(PIPEDRIVE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: bodyParams.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.error_description || data.error || JSON.stringify(data);
    throw new Error(`Pipedrive token exchange failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in || 3600, // typically 1 hour
    scope: data.scope || ""
  };
}

export async function refreshPipedriveTokens(refreshToken, customClientId, customClientSecret) {
  const { clientId, clientSecret } = getPipedriveCredentials(customClientId, customClientSecret);
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const bodyParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const res = await fetch(PIPEDRIVE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: bodyParams.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.error_description || data.error || JSON.stringify(data);
    throw new Error(`Pipedrive token refresh failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 3600
  };
}

export async function getPipedriveAccountInfo(accessToken) {
  if (!accessToken) return null;

  try {
    const res = await fetch(`${PIPEDRIVE_API_URL}/users/me`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json"
      }
    });

    if (!res.ok) return null;
    const json = await res.json();
    const user = json?.data;

    return {
      userName: user?.name || "",
      userEmail: user?.email || "",
      companyId: user?.company_id ? String(user.company_id) : "",
      companyName: user?.company_name || ""
    };
  } catch (err) {
    console.warn("⚠️ getPipedriveAccountInfo error:", err.message);
    return null;
  }
}

export async function revokePipedriveToken(token, customClientId, customClientSecret) {
  if (!token) return true;
  try {
    const { clientId, clientSecret } = getPipedriveCredentials(customClientId, customClientSecret);
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const bodyParams = new URLSearchParams({ token });
    const res = await fetch(PIPEDRIVE_REVOKE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyParams.toString()
    });

    return res.ok;
  } catch (err) {
    console.warn("⚠️ revokePipedriveToken error:", err.message);
    return false;
  }
}
