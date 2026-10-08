/**
 * ============================================================================
 * CLICKUP OAUTH CALLBACK ROUTE: /api/integrations/clickup/callback
 * ============================================================================
 */

import { exchangeClickUpCodeForTokens, getClickUpWorkspaceInfo } from "../../../../services/clickupService.js";
import { saveIntegrationTokens } from "../../../../services/vaultService.js";
import { notifyStaffOnClientConnection } from "../../../../services/connectionNotifier.js";

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, pair) => {
    const [k, v] = pair.trim().split("=");
    if (k && v) acc[k] = decodeURIComponent(v);
    return acc;
  }, {});
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { code, state, error, error_description } = req.query;

  if (error) {
    console.warn("⚠️ ClickUp OAuth denied by user:", error, error_description);
    return res.redirect(`/portal?integration=clickup&status=denied&error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: "Missing authorization code or state parameter." });
  }

  const cookies = parseCookies(req.headers.cookie);
  const savedNonce = cookies.pulse_clickup_nonce;

  const isProd = process.env.NODE_ENV === "production";
  const clearCookieOptions = `Path=/api/integrations/clickup; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", `pulse_clickup_nonce=; ${clearCookieOptions}`);

  let statePayload = null;
  try {
    const stateJson = Buffer.from(state, "base64url").toString("utf8");
    statePayload = JSON.parse(stateJson);
  } catch (err) {
    return res.status(400).json({ error: "Invalid state token structure." });
  }

  if (!savedNonce || statePayload.nonce !== savedNonce) {
    return res.status(403).json({ error: "State nonce verification failed (potential CSRF attempt)." });
  }

  try {
    const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
    const isPulseHost = reqHost && (reqHost === "pulsedashboard.co.uk" || reqHost.endsWith(".pulsedashboard.co.uk"));
    const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const host = isPulseHost ? reqHost : (prodHost || reqHost || "localhost:3000");
    const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
    const redirectUri = `${proto}://${host}/api/integrations/clickup/callback`;

    // 1. Exchange code
    const tokens = await exchangeClickUpCodeForTokens({
      code,
      redirectUri
    });

    const clientKey = statePayload.clientKey || statePayload.clientName;
    const clientName = statePayload.clientName || clientKey;
    const masterSheetId = statePayload.masterSheetId;

    // 2. Fetch workspace metadata
    const workspaceInfo = await getClickUpWorkspaceInfo(tokens.accessToken);
    const workspaceName = workspaceInfo?.workspaceName || workspaceInfo?.teamName || clientName;

    // 3. Encrypt and store tokens in Central Vault
    await saveIntegrationTokens({
      clientKey,
      clientName,
      masterSheetId,
      tool: "clickup",
      tokens,
      metadata: {
        teamId: workspaceInfo?.teamId || "",
        teamName: workspaceName,
        userName: workspaceInfo?.userName || "",
        userEmail: workspaceInfo?.userEmail || ""
      }
    });

    // Notify all Admins and assigned Client Manager
    notifyStaffOnClientConnection({
      clientName,
      tool: "clickup",
      tenantName: workspaceName || "",
      masterSheetId
    }).catch(err => console.error("Notification email error:", err.message));

    const returnUrl = statePayload.redirectBack || "/portal";
    const separator = returnUrl.includes("?") ? "&" : "?";
    return res.redirect(`${returnUrl}${separator}integration=clickup&status=success&workspace=${encodeURIComponent(workspaceName)}`);

  } catch (err) {
    console.error("ClickUp OAuth callback processing error:", err);
    const returnUrl = statePayload?.redirectBack || "/portal";
    const separator = returnUrl.includes("?") ? "&" : "?";
    return res.redirect(`${returnUrl}${separator}integration=clickup&status=error&message=${encodeURIComponent(err.message)}`);
  }
}
