/**
 * ============================================================================
 * CLOSE CRM OAUTH 2.0 & API SERVICE
 * ============================================================================
 * 
 * Handles Close CRM OAuth 2.0 flow, token refreshes, and organization/user lookup.
 */

const CLOSE_AUTH_URL = "https://app.close.com/oauth2/authorize/";
const CLOSE_TOKEN_URL = "https://api.close.com/oauth2/token/";
const CLOSE_API_BASE = "https://api.close.com/api/v1";

export function getCloseCredentials(customClientId, customClientSecret) {
  const clientId = customClientId || process.env.CLOSE_CLIENT_ID;
  const clientSecret = customClientSecret || process.env.CLOSE_CLIENT_SECRET;

  return { clientId: clientId || "", clientSecret: clientSecret || "" };
}

export function buildCloseAuthUrl({ redirectUri, state, customClientId }) {
  const { clientId } = getCloseCredentials(customClientId);
  if (!clientId) {
    throw new Error("Close CRM OAuth client ID missing (CLOSE_CLIENT_ID not set).");
  }

  const url = new URL(CLOSE_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  return url.toString();
}

export async function exchangeCloseCodeForTokens({ code, redirectUri, customClientId, customClientSecret }) {
  const { clientId, clientSecret } = getCloseCredentials(customClientId, customClientSecret);
  if (!clientId || !clientSecret) {
    throw new Error("Close CRM OAuth credentials missing (CLOSE_CLIENT_ID / CLOSE_CLIENT_SECRET not set).");
  }

  const bodyParams = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: code,
    redirect_uri: redirectUri
  });

  const res = await fetch(CLOSE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: bodyParams.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.error_description || data.error || JSON.stringify(data);
    throw new Error(`Close token exchange failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in || 2592000 // default 30 days
  };
}

export async function refreshCloseTokens(refreshToken, customClientId, customClientSecret) {
  const { clientId, clientSecret } = getCloseCredentials(customClientId, customClientSecret);
  if (!clientId || !clientSecret) {
    throw new Error("Close CRM OAuth credentials missing for refresh (CLOSE_CLIENT_ID / CLOSE_CLIENT_SECRET not set).");
  }

  const bodyParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });

  const res = await fetch(CLOSE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: bodyParams.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.error_description || data.error || JSON.stringify(data);
    throw new Error(`Close token refresh failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 2592000
  };
}

export async function getCloseAccountInfo(accessTokenOrApiKey) {
  if (!accessTokenOrApiKey) return null;

  try {
    let authHeader = "";
    if (accessTokenOrApiKey.startsWith("api_")) {
      // API Key Basic Auth
      const basic = Buffer.from(`${accessTokenOrApiKey}:`).toString("base64");
      authHeader = `Basic ${basic}`;
    } else {
      authHeader = accessTokenOrApiKey.startsWith("Bearer ") ? accessTokenOrApiKey : `Bearer ${accessTokenOrApiKey}`;
    }

    const res = await fetch(`${CLOSE_API_BASE}/me/`, {
      headers: {
        "Authorization": authHeader,
        "Accept": "application/json"
      }
    });

    if (!res.ok) return null;
    const data = await res.json();

    const org = data.organizations && data.organizations.length > 0 ? data.organizations[0] : null;

    return {
      userId: data.id || "",
      userName: `${data.first_name || ""} ${data.last_name || ""}`.trim() || data.email || "",
      userEmail: data.email || "",
      organizationId: org?.id || "",
      organizationName: org?.name || ""
    };
  } catch (err) {
    console.warn("getCloseAccountInfo warning:", err.message);
    return null;
  }
}
