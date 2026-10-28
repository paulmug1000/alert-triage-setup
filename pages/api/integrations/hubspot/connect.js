/**
 * ============================================================================
 * HUBSPOT CRM OAUTH INITIATION ROUTE: /api/integrations/hubspot/connect
 * ============================================================================
 */

import crypto from "crypto";
import { buildHubSpotAuthUrl } from "../../../../services/hubspotService.js";
import { getSessionUser, createSignedOAuthState } from "../../../../services/authService.js";
import { getSheetsClient } from "../../../../services/sheetsClient.js";
import { isUserAuthorizedForClient, isReadOnlySession, verifyUserAuthorizedForSheet } from "../../../../services/userPermissions.js";
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
  if (!sessionUser.isAdmin && (masterSheetId || clientSheetId)) {
    const sheets = await getSheetsClient();
    if (masterSheetId) {
      const sheetAuth = await verifyUserAuthorizedForSheet(sheets, sessionUser, masterSheetId, targetName || "");
      if (!sheetAuth.authorized) return res.status(403).json({ error: "Access denied to this client." });
    }
    if (clientSheetId) {
      const sheetAuth = await verifyUserAuthorizedForSheet(sheets, sessionUser, clientSheetId, targetName || "");
      if (!sheetAuth.authorized) return res.status(403).json({ error: "Access denied to this client." });
    }
  }

  const sanitizedRedirectBack = sanitizeRedirectUrl(redirectBack, "/pma");

  try {
    const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
    const isPulseHost = reqHost && (reqHost === "pulsedashboard.co.uk" || reqHost.endsWith(".pulsedashboard.co.uk"));
    const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const host = isPulseHost ? reqHost : (prodHost || reqHost || "localhost:3000");
    const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
    const redirectUri = `${proto}://${host}/api/integrations/hubspot/callback`;

    const nonce = crypto.randomBytes(16).toString("hex");

    const statePayload = {
      nonce,
      clientKey: clientKey || clientName,
      clientName: clientName || clientKey,
      masterSheetId: masterSheetId || "",
      clientSheetId: clientSheetId || "",
      redirectBack: sanitizedRedirectBack
    };

    const stateToken = createSignedOAuthState(statePayload);

    const isProd = process.env.NODE_ENV === "production";
    const cookieOptions = `Path=/api/integrations/hubspot; HttpOnly; SameSite=Lax; Max-Age=900${isProd ? "; Secure" : ""}`;

    res.setHeader("Set-Cookie", `pulse_hubspot_nonce=${nonce}; ${cookieOptions}`);

    const authUrl = buildHubSpotAuthUrl({
      redirectUri,
      state: stateToken
    });

    return res.redirect(authUrl);
  } catch (err) {
    console.error("HubSpot Connect initiation error:", err);
    return res.status(500).json({ error: err.message || "Failed to initiate HubSpot connection." });
  }
}
