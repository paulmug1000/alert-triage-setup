/**
 * ============================================================================
 * CLICKUP OAUTH 2.0 & API SERVICE
 * ============================================================================
 * 
 * Handles ClickUp OAuth 2.0 code exchange, API queries, and team/user resolution.
 */

const CLICKUP_AUTH_URL = "https://app.clickup.com/api";
const CLICKUP_TOKEN_URL = "https://api.clickup.com/api/v2/oauth/token";
const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";

export function getClickUpCredentials(customClientId, customClientSecret) {
  const clientId = customClientId || process.env.CLICKUP_CLIENT_ID;
  const clientSecret = customClientSecret || process.env.CLICKUP_CLIENT_SECRET;

  return { clientId: clientId || "", clientSecret: clientSecret || "" };
}

export function buildClickUpAuthUrl({ redirectUri, state, customClientId }) {
  const { clientId } = getClickUpCredentials(customClientId);
  if (!clientId) {
    throw new Error("ClickUp OAuth client ID missing (CLICKUP_CLIENT_ID not set).");
  }

  const url = new URL(CLICKUP_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  return url.toString();
}

export async function exchangeClickUpCodeForTokens({ code, redirectUri, customClientId, customClientSecret }) {
  const { clientId, clientSecret } = getClickUpCredentials(customClientId, customClientSecret);
  if (!clientId || !clientSecret) {
    throw new Error("ClickUp OAuth credentials missing (CLICKUP_CLIENT_ID / CLICKUP_CLIENT_SECRET not set).");
  }

  const bodyParams = {
    client_id: clientId,
    client_secret: clientSecret,
    code: code
  };

  const res = await fetch(CLICKUP_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(bodyParams)
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.err || data.error || JSON.stringify(data);
    throw new Error(`ClickUp token exchange failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: "",
    tokenType: "Bearer",
    expiresIn: 315360000 // ClickUp tokens do not expire (10 years)
  };
}

export async function getClickUpWorkspaceInfo(accessToken) {
  if (!accessToken) return null;

  try {
    const cleanToken = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;
    // 1. Fetch User
    const userRes = await fetch(`${CLICKUP_API_BASE}/user`, {
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

    // 2. Fetch Teams (Workspaces)
    const teamRes = await fetch(`${CLICKUP_API_BASE}/team`, {
      headers: {
        "Authorization": cleanToken,
        "Accept": "application/json"
      }
    });

    let teamData = null;
    if (teamRes.ok) {
      const tJson = await teamRes.json();
      if (tJson.teams && tJson.teams.length > 0) {
        teamData = tJson.teams[0];
      }
    }

    return {
      userId: userData?.id || "",
      userName: userData?.username || "",
      userEmail: userData?.email || "",
      teamId: teamData?.id || "",
      teamName: teamData?.name || "",
      workspaceName: teamData?.name || userData?.username || ""
    };
  } catch (err) {
    console.warn("getClickUpWorkspaceInfo warning:", err.message);
    return null;
  }
}
