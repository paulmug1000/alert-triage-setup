/**
 * ============================================================================
 * TOKEN BROKER API ROUTE: /api/integrations/token
 * ============================================================================
 * 
 * Provides an authenticated token vending machine for Google Apps Script (GAS)
 * and internal Pulse background jobs.
 * 
 * Security Features:
 * - Requires Bearer authentication via PULSE_INTERNAL_SECRET.
 * - Resolves client credentials via spreadsheetId or clientKey.
 * - Handles automated rolling refresh cycles (Xero, etc.) behind the scenes.
 * - Never returns permanent refresh tokens or client secrets to callers.
 * - Only returns short-lived, ready-to-use access tokens and tenant IDs.
 */

import { getIntegrationTokens, updateRefreshedTokens } from "../../../services/vaultService.js";
import { refreshXeroTokens } from "../../../services/xeroService.js";
import { getSessionUser } from "../../../services/authService.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // 1. Verify Authentication: Ecosystem Secret (for GAS) OR Admin Session (for PMA)
  const authHeader = req.headers.authorization || "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedSecret = tokenMatch ? tokenMatch[1].trim() : (req.query.secret || req.body?.secret || "");

  const expectedSecret = process.env.PULSE_INTERNAL_SECRET;
  const isSecretValid = Boolean(expectedSecret && providedSecret && providedSecret === expectedSecret);

  const sessionUser = getSessionUser(req);
  const isAdmin = Boolean(sessionUser?.isAdmin);

  if (!isSecretValid && !isAdmin) {
    console.warn("🚨 Token Broker: Unauthorized attempt to request integration token.");
    return res.status(401).json({ success: false, error: "Unauthorized: Invalid internal secret or admin session required." });
  }

  // 2. Parse Target Integration & Client Identifier
  const tool = String(req.query.tool || req.body?.tool || "xero").trim().toLowerCase();
  const spreadsheetId = req.query.spreadsheetId || req.query.sheetId || req.body?.spreadsheetId || req.body?.sheetId || "";
  const clientKey = req.query.clientKey || req.query.clientName || req.body?.clientKey || req.body?.clientName || "";

  if (!spreadsheetId && !clientKey) {
    return res.status(400).json({ success: false, error: "Missing spreadsheetId or clientKey parameter." });
  }

  try {
    // 3. Fetch from Vault
    const record = await getIntegrationTokens({
      clientKey,
      masterSheetId: spreadsheetId,
      tool
    });

    if (!record || !record.tokens || !record.tokens.accessToken) {
      return res.status(404).json({
        success: false,
        error: `No active ${tool} connection found for this client.`,
        reconnectRequired: true
      });
    }

    let accessToken = record.tokens.accessToken;
    let expiresIn = Math.max(0, Math.round(((record.expiresAt || 0) - Date.now()) / 1000));

    // 4. Token Freshness Evaluation (Buffer: 5 minutes)
    const isExpiringSoon = expiresIn < 300;

    if (isExpiringSoon && tool === "xero") {
      console.log(`🔄 Token Broker: Xero token for ${record.clientKey} is expiring in ${expiresIn}s. Triggering automatic refresh...`);

      if (!record.tokens.refreshToken) {
        return res.status(401).json({
          success: false,
          error: "No refresh token available to refresh connection. Please re-authorize in Pulse.",
          reconnectRequired: true
        });
      }

      try {
        const refreshed = await refreshXeroTokens(record.tokens.refreshToken);
        await updateRefreshedTokens({
          clientKey: record.clientKey,
          tool: "xero",
          tokens: refreshed
        });

        accessToken = refreshed.accessToken;
        expiresIn = refreshed.expiresIn;
        console.log(`✅ Token Broker: Successfully refreshed Xero token for ${record.clientKey}. Fresh for ${Math.round(expiresIn / 60)}m.`);
      } catch (refreshErr) {
        console.error(`🚨 Token Broker: Refresh failed for ${record.clientKey}:`, refreshErr.message);
        return res.status(401).json({
          success: false,
          error: `Failed to refresh Xero connection (${refreshErr.message}). Re-authorization required.`,
          reconnectRequired: true
        });
      }
    }

    // 5. Return short-lived access credentials
    return res.status(200).json({
      success: true,
      tool,
      clientKey: record.clientKey,
      clientName: record.clientName,
      accessToken,
      tenantId: record.tenantId || "",
      tenantName: record.tenantName || "",
      expiresIn
    });

  } catch (err) {
    console.error("Token Broker handler error:", err);
    return res.status(500).json({ success: false, error: err.message || "Internal Token Broker failure." });
  }
}
