/**
 * ============================================================================
 * MONDAY.COM OAUTH 2.0 & GRAPHQL API SERVICE
 * ============================================================================
 * 
 * Handles Monday.com OAuth 2.0 code exchange, token refreshes, and GraphQL queries
 * to fetch authenticated user and account information.
 */

const MONDAY_AUTH_URL = "https://auth.monday.com/oauth2/authorize";
const MONDAY_TOKEN_URL = "https://auth.monday.com/oauth2/token";
const MONDAY_API_URL = "https://api.monday.com/v2";

export function getMondayCredentials(customClientId, customClientSecret) {
  const clientId = customClientId || process.env.MONDAY_CLIENT_ID;
  const clientSecret = customClientSecret || process.env.MONDAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Monday.com OAuth credentials missing (MONDAY_CLIENT_ID / MONDAY_CLIENT_SECRET not set).");
  }

  return { clientId, clientSecret };
}

export function buildMondayAuthUrl({ redirectUri, state }) {
  const { clientId } = getMondayCredentials();

  const url = new URL(MONDAY_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  return url.toString();
}

export async function exchangeMondayCodeForTokens({ code, redirectUri, customClientId, customClientSecret }) {
  const { clientId, clientSecret } = getMondayCredentials(customClientId, customClientSecret);

  const bodyParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri
  });

  const res = await fetch(MONDAY_TOKEN_URL, {
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
    throw new Error(`Monday.com token exchange failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in || 2592000 // default 30 days if unspecified
  };
}

export async function refreshMondayTokens(refreshToken, customClientId, customClientSecret) {
  const { clientId, clientSecret } = getMondayCredentials(customClientId, customClientSecret);

  const bodyParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });

  const res = await fetch(MONDAY_TOKEN_URL, {
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
    throw new Error(`Monday.com token refresh failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 2592000
  };
}

export async function getMondayAccountInfo(accessToken) {
  if (!accessToken) return null;

  try {
    const query = `
      query {
        me {
          id
          name
          email
          account {
            id
            name
          }
        }
      }
    `;

    const res = await fetch(MONDAY_API_URL, {
      method: "POST",
      headers: {
        "Authorization": accessToken,
        "Content-Type": "application/json",
        "API-Version": "2024-04"
      },
      body: JSON.stringify({ query })
    });

    if (!res.ok) return null;
    const data = await res.json();
    const me = data?.data?.me;

    return {
      userName: me?.name || "",
      userEmail: me?.email || "",
      accountId: me?.account?.id ? String(me.account.id) : "",
      accountName: me?.account?.name || ""
    };
  } catch (err) {
    console.warn("⚠️ getMondayAccountInfo error:", err.message);
    return null;
  }
}
