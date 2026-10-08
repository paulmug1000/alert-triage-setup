/**
 * ============================================================================
 * XERO OAUTH INITIATION ROUTE: /api/integrations/xero/connect
 * ============================================================================
 * 
 * Initiates the OAuth 2.0 authorization code flow with PKCE for Xero.
 * Generates cryptographic state and PKCE challenge, stores them in secure
 * HttpOnly cookies, and redirects the user to the Xero consent screen.
 */

import crypto from "crypto";
import { buildXeroAuthUrl } from "../../../../services/xeroService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../../services/sheetsClient.js";
import { DEFAULT_AC_SHEET_ID, matchesClientName } from "../../../../services/userPermissions.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { clientKey, clientName, masterSheetId, clientSheetId, redirectBack, mode } = req.method === "POST" ? req.body : req.query;

  if (!clientKey && !masterSheetId && !clientName) {
    return res.status(400).json({ error: "Missing required clientKey, clientName, or masterSheetId parameter." });
  }

  // Determine connection mode:
  // - "advisor": powers Central Advisor Shared Grant (accumulates orgs)
  // - "dedicated": isolated per-client dedicated grant (e.g. client self-service in setup)
  const isExplicitAdvisor = mode === "advisor" || clientKey === "advisor";
  const isClientPortal = !mode && (redirectBack?.startsWith("/pulse") || redirectBack?.startsWith("/portal"));
  const effectiveMode = isExplicitAdvisor ? "advisor" : (isClientPortal ? "dedicated" : (mode || "advisor"));

  try {
    let resolvedMasterSheetId = masterSheetId || "";
    let resolvedClientSheetId = clientSheetId || "";
    const targetName = clientName || clientKey;

    if ((!resolvedMasterSheetId || !resolvedClientSheetId) && targetName && targetName !== "advisor") {
      try {
        const sheets = await getSheetsClient();
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: DEFAULT_AC_SHEET_ID,
          range: "AutoUpdates!A2:N500"
        });
        const rows = resp.data.values || [];
        const match = rows.find(r => matchesClientName(r[0], targetName));
        if (match) {
          if (!resolvedClientSheetId && match[11]) {
            resolvedClientSheetId = extractSheetIdFromUrl(match[11]) || String(match[11]).trim();
          }
          if (!resolvedMasterSheetId && match[12]) {
            resolvedMasterSheetId = extractSheetIdFromUrl(match[12]) || String(match[12]).trim();
          }
        }
      } catch (lookupErr) {
        console.warn("⚠️ Xero Connect: Note resolving sheet IDs:", lookupErr.message);
      }
    }

    // Dynamic Host Resolution
    const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
    const isPulseHost = reqHost && (reqHost === "pulsedashboard.co.uk" || reqHost.endsWith(".pulsedashboard.co.uk"));
    const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const host = isPulseHost ? reqHost : (prodHost || reqHost || "localhost:3000");
    const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
    const redirectUri = `${proto}://${host}/api/integrations/xero/callback`;

    // PKCE Generation (RFC 7636)
    const nonce = crypto.randomBytes(16).toString("hex");
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    // State payload carrying client identification and return path
    const statePayload = {
      nonce,
      clientKey: clientKey || clientName,
      clientName: clientName || clientKey,
      masterSheetId: resolvedMasterSheetId,
      clientSheetId: resolvedClientSheetId,
      redirectBack: redirectBack || "/portal",
      mode: effectiveMode
    };

    const stateToken = Buffer.from(JSON.stringify(statePayload)).toString("base64url");

    // Secure HttpOnly state cookie
    const isProd = process.env.NODE_ENV === "production";
    const cookieOptions = `Path=/api/integrations/xero; HttpOnly; SameSite=Lax; Max-Age=900${isProd ? "; Secure" : ""}`;

    res.setHeader("Set-Cookie", [
      `pulse_xero_nonce=${nonce}; ${cookieOptions}`,
      `pulse_xero_verifier=${codeVerifier}; ${cookieOptions}`
    ]);

    const authUrl = buildXeroAuthUrl({
      redirectUri,
      state: stateToken,
      codeChallenge
    });

    return res.redirect(authUrl);
  } catch (err) {
    console.error("Xero Connect initiation error:", err);
    return res.status(500).json({ error: err.message || "Failed to initiate Xero connection." });
  }
}
