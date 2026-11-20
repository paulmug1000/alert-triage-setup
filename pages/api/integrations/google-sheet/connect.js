/**
 * ============================================================================
 * GOOGLE SHEET OAUTH INITIATION ROUTE: /api/integrations/google-sheet/connect
 * ============================================================================
 */

import crypto from "crypto";
import { buildGoogleSheetAuthUrl } from "../../../../services/googleSheetService.js";
import { resolveLiveSessionUser, createSignedOAuthState, getTrustedClientIp, checkRateLimit } from "../../../../services/authService.js";
import { getSheetsClient } from "../../../../services/sheetsClient.js";
import { isUserAuthorizedForClient, isReadOnlySession, verifyUserAuthorizedForSheet, matchesClientName } from "../../../../services/userPermissions.js";
import { sanitizeRedirectUrl, resolveCanonicalOAuthHost, assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (req.method === "POST" && !assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ error: "Active session required." });
  }

  const rl = await checkRateLimit("oauth-int-connect", sessionUser.email || getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ error: "Too many connection requests. Please retry shortly." });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ error: "Read-only session cannot initiate OAuth connections." });
  }
  if (sessionUser.role === "Senior (Restricted)" || sessionUser.isSenior) {
    return res.status(403).json({ error: "Forbidden: Senior (Restricted) users cannot connect integrations." });
  }

  const { clientKey, clientName, masterSheetId, clientSheetId, redirectBack } = req.method === "POST" ? req.body : req.query;

  if (!clientKey && !masterSheetId && !clientName) {
    return res.status(400).json({ error: "Missing required clientKey, clientName, or masterSheetId parameter." });
  }

  if (clientKey && clientName && !matchesClientName(clientKey, clientName)) {
    return res.status(403).json({ error: "Access denied: Mismatched clientKey and clientName." });
  }

  const targetName = clientName || clientKey;
  if (!sessionUser.isAdmin && targetName && !isUserAuthorizedForClient(sessionUser, targetName)) {
    return res.status(403).json({ error: "Access denied to this client." });
  }
  if (!sessionUser.isAdmin && (masterSheetId || clientSheetId)) {
    const sheets = await getSheetsClient();
    if (masterSheetId) {
      const sheetAuth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, targetName, sheets);
      if (!sheetAuth.authorized) return res.status(403).json({ error: "Access denied to this client." });
    }
    if (clientSheetId) {
      const sheetAuth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, targetName, sheets);
      if (!sheetAuth.authorized) return res.status(403).json({ error: "Access denied to this client." });
    }
  }

  const sanitizedRedirectBack = sanitizeRedirectUrl(redirectBack, "/pma");

  try {
    const { host, proto } = resolveCanonicalOAuthHost(req);
    const redirectUri = `${proto}://${host}/api/integrations/google-sheet/callback`;

    const nonce = crypto.randomBytes(16).toString("hex");

    const statePayload = {
      nonce,
      clientKey: clientKey || clientName,
      clientName: clientName || clientKey,
      masterSheetId: masterSheetId || "",
      clientSheetId: clientSheetId || "",
      redirectBack: sanitizedRedirectBack,
      url: (req.query?.url || req.body?.url || "").trim(),
      reconnectOnly: req.query?.reconnectOnly === "1" || req.body?.reconnectOnly === true,
      initiatedBy: sessionUser.email
    };

    const stateToken = createSignedOAuthState(statePayload);

    const isProd = process.env.NODE_ENV === "production";
    const cookieOptions = `Path=/api/integrations/google-sheet; HttpOnly; SameSite=Lax; Max-Age=900${isProd ? "; Secure" : ""}`;

    res.setHeader("Set-Cookie", `pulse_gsheet_nonce=${nonce}; ${cookieOptions}`);

    const authUrl = buildGoogleSheetAuthUrl({
      redirectUri,
      state: stateToken
    });

    return res.redirect(authUrl);
  } catch (err) {
    console.error("Google Sheet Connect initiation error:", err);
    return res.status(500).json({
      error: sessionUser?.isAdmin ? (err.message || "Failed to initiate Google Sheet connection.") : sanitizeSpreadsheetTerms(err.message || "Failed to initiate Google Sheet connection.")
    });
  }
}
