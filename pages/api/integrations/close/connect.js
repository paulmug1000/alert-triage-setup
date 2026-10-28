/**
 * ============================================================================
 * CLOSE CRM OAUTH INITIATION ROUTE: /api/integrations/close/connect
 * ============================================================================
 */

import crypto from "crypto";
import { buildCloseAuthUrl } from "../../../../services/closeService.js";
import { getSessionUser } from "../../../../services/authService.js";
import { isUserAuthorizedForClient, isReadOnlySession } from "../../../../services/userPermissions.js";
import { sanitizeRedirectUrl } from "../../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ error: "Active session required." });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ error: "Read-only session cannot initiate OAuth connections." });
  }

  const { clientKey, clientName, masterSheetId, clientSheetId, redirectBack } = req.method === "POST" ? req.body : req.query;

  if (!clientKey && !masterSheetId && !clientName) {
    return res.status(400).json({ error: "Missing required clientKey, clientName, or masterSheetId parameter." });
  }

  const targetName = clientName || clientKey;
  if (!sessionUser.isAdmin && targetName && !isUserAuthorizedForClient(sessionUser, targetName)) {
    return res.status(403).json({ error: "Access denied to this client." });
  }

  const sanitizedRedirectBack = sanitizeRedirectUrl(redirectBack, "/pma");

  try {
    const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
    const isPulseHost = reqHost && (reqHost === "pulsedashboard.co.uk" || reqHost.endsWith(".pulsedashboard.co.uk"));
    const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const host = isPulseHost ? reqHost : (prodHost || reqHost || "localhost:3000");
    const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
    const redirectUri = `${proto}://${host}/api/integrations/close/callback`;

    const nonce = crypto.randomBytes(16).toString("hex");

    const statePayload = {
      nonce,
      clientKey: clientKey || clientName,
      clientName: clientName || clientKey,
      masterSheetId: masterSheetId || "",
      clientSheetId: clientSheetId || "",
      redirectBack: sanitizedRedirectBack
    };

    const stateToken = Buffer.from(JSON.stringify(statePayload)).toString("base64url");

    const isProd = process.env.NODE_ENV === "production";
    const cookieOptions = `Path=/api/integrations/close; HttpOnly; SameSite=Lax; Max-Age=900${isProd ? "; Secure" : ""}`;

    res.setHeader("Set-Cookie", `pulse_close_nonce=${nonce}; ${cookieOptions}`);

    const authUrl = buildCloseAuthUrl({
      redirectUri,
      state: stateToken
    });

    return res.redirect(authUrl);
  } catch (err) {
    console.error("Close Connect initiation error:", err);
    return res.status(500).json({ error: err.message || "Failed to initiate Close connection." });
  }
}
