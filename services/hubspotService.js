/**
 * ============================================================================
 * HUBSPOT CRM OAUTH 2.0 & API SERVICE
 * ============================================================================
 * 
 * Handles HubSpot OAuth 2.0 flow, token refreshes, and portal/account resolution.
 */

const HUBSPOT_AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const HUBSPOT_API_BASE = "https://api.hubapi.com";
const HUBSPOT_SCOPES = "crm.objects.deals.read crm.schemas.deals.read oauth crm.objects.contacts.read";

export function getHubSpotCredentials(customClientId, customClientSecret) {
  const clientId = customClientId || process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = customClientSecret || process.env.HUBSPOT_CLIENT_SECRET;

  return { clientId: clientId || "", clientSecret: clientSecret || "" };
}

export function buildHubSpotAuthUrl({ redirectUri, state, customClientId }) {
  const { clientId } = getHubSpotCredentials(customClientId);
  if (!clientId) {
    throw new Error("HubSpot OAuth client ID missing (HUBSPOT_CLIENT_ID not set).");
  }

  const url = new URL(HUBSPOT_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", HUBSPOT_SCOPES);
  url.searchParams.set("state", state);

  return url.toString();
}

export async function exchangeHubSpotCodeForTokens({ code, redirectUri, customClientId, customClientSecret }) {
  const { clientId, clientSecret } = getHubSpotCredentials(customClientId, customClientSecret);
  if (!clientId || !clientSecret) {
    throw new Error("HubSpot OAuth credentials missing (HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET not set).");
  }

  const bodyParams = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code: code
  });

  const res = await fetch(HUBSPOT_TOKEN_URL, {
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
    throw new Error(`HubSpot token exchange failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in || 1800 // typically 30 minutes
  };
}

export async function refreshHubSpotTokens(refreshToken, customClientId, customClientSecret) {
  const { clientId, clientSecret } = getHubSpotCredentials(customClientId, customClientSecret);
  if (!clientId || !clientSecret) {
    throw new Error("HubSpot OAuth credentials missing for refresh (HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET not set).");
  }

  const bodyParams = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });

  const res = await fetch(HUBSPOT_TOKEN_URL, {
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
    throw new Error(`HubSpot token refresh failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 1800
  };
}

export async function getHubSpotAccountInfo(accessToken) {
  if (!accessToken) return null;

  try {
    const cleanToken = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;

    // 1. Fetch Token Info (user email, hub_id)
    const tokenInfoRes = await fetch(`${HUBSPOT_API_BASE}/oauth/v1/access-tokens/${encodeURIComponent(accessToken.replace(/^Bearer\s+/i, ""))}`);
    let tokenInfo = null;
    if (tokenInfoRes.ok) {
      tokenInfo = await tokenInfoRes.json();
    }

    // 2. Fetch Account Details (portalId, timeZone, accountType)
    const detailsRes = await fetch(`${HUBSPOT_API_BASE}/account-info/v3/details`, {
      headers: {
        "Authorization": cleanToken,
        "Accept": "application/json"
      }
    });
    let details = null;
    if (detailsRes.ok) {
      details = await detailsRes.json();
    }

    const portalId = details?.portalId || tokenInfo?.hub_id || "";
    return {
      portalId: String(portalId),
      hubId: String(tokenInfo?.hub_id || portalId),
      userEmail: tokenInfo?.user || "",
      accountType: details?.accountType || "",
      companyCurrency: details?.companyCurrency || "",
      accountName: details?.portalId ? `HubSpot Portal ${details.portalId}` : (tokenInfo?.hub_id ? `HubSpot Hub ${tokenInfo.hub_id}` : "")
    };
  } catch (err) {
    console.warn("getHubSpotAccountInfo warning:", err.message);
    return null;
  }
}
