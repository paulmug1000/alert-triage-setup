/**
 * ============================================================================
 * CAPSULE CRM OAUTH 2.0 & API SERVICE
 * ============================================================================
 * 
 * Handles Capsule OAuth 2.0 authorization code flow, token refreshes, and account resolution.
 */

const CAPSULE_AUTH_URL = "https://api.capsulecrm.com/oauth/authorise";
const CAPSULE_TOKEN_URL = "https://api.capsulecrm.com/oauth/token";
const CAPSULE_API_BASE = "https://api.capsulecrm.com/api/v2";

export function getCapsuleCredentials(customClientId, customClientSecret) {
  const clientId = customClientId || process.env.CAPSULE_CLIENT_ID;
  const clientSecret = customClientSecret || process.env.CAPSULE_CLIENT_SECRET;

  return { clientId: clientId || "", clientSecret: clientSecret || "" };
}

export function buildCapsuleAuthUrl({ redirectUri, state, customClientId }) {
  const { clientId } = getCapsuleCredentials(customClientId);
  if (!clientId) {
    throw new Error("Capsule OAuth client ID missing (CAPSULE_CLIENT_ID not set).");
  }

  const url = new URL(CAPSULE_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read write");
  url.searchParams.set("state", state);

  return url.toString();
}

export async function exchangeCapsuleCodeForTokens({ code, redirectUri, customClientId, customClientSecret }) {
  const { clientId, clientSecret } = getCapsuleCredentials(customClientId, customClientSecret);
  if (!clientId || !clientSecret) {
    throw new Error("Capsule OAuth credentials missing (CAPSULE_CLIENT_ID / CAPSULE_CLIENT_SECRET not set).");
  }

  const bodyParams = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: code,
    redirect_uri: redirectUri
  });

  const res = await fetch(CAPSULE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: bodyParams.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.message || data.error_description || data.error || JSON.stringify(data);
    throw new Error(`Capsule token exchange failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in || 7200, // typically 2 hours
    scope: data.scope || ""
  };
}

export async function refreshCapsuleTokens(refreshToken, customClientId, customClientSecret) {
  const { clientId, clientSecret } = getCapsuleCredentials(customClientId, customClientSecret);
  if (!clientId || !clientSecret) {
    throw new Error("Capsule OAuth credentials missing for refresh (CAPSULE_CLIENT_ID / CAPSULE_CLIENT_SECRET not set).");
  }

  const bodyParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });

  const res = await fetch(CAPSULE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: bodyParams.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.message || data.error_description || data.error || JSON.stringify(data);
    throw new Error(`Capsule token refresh failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 7200
  };
}

export async function getCapsuleAccountInfo(accessToken) {
  if (!accessToken) return null;

  try {
    const cleanToken = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;

    // 1. Fetch site info
    const siteRes = await fetch(`${CAPSULE_API_BASE}/site`, {
      headers: {
        "Authorization": cleanToken,
        "Accept": "application/json"
      }
    });

    let siteData = null;
    if (siteRes.ok) {
      const sJson = await siteRes.json();
      siteData = sJson.site;
    }

    // 2. Fetch current user
    const userRes = await fetch(`${CAPSULE_API_BASE}/users/current`, {
      headers: {
        "Authorization": cleanToken,
        "Accept": "application/json"
      }
    });

    let userData = null;
    if (userRes.ok) {
      const uJson = await userRes.json();
      userData = uJson.user;
    }

    return {
      siteName: siteData?.name || "",
      siteUrl: siteData?.url || "",
      userId: userData?.id || "",
      userName: userData?.name || userData?.username || "",
      userEmail: userData?.email || ""
    };
  } catch (err) {
    console.warn("getCapsuleAccountInfo warning:", err.message);
    return null;
  }
}
