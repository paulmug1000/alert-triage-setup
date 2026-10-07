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

import {
  getIntegrationTokens,
  updateRefreshedTokens,
  markIntegrationReconnectRequired,
  getSharedXeroGrant,
  updateSharedXeroGrantTokens
} from "../../../services/vaultService.js";
import { refreshXeroTokens } from "../../../services/xeroService.js";
import { refreshQBTokens } from "../../../services/quickbooksService.js";
import { refreshMondayTokens } from "../../../services/mondayService.js";
import { refreshPipedriveTokens } from "../../../services/pipedriveService.js";
import { refreshCapsuleTokens } from "../../../services/capsuleService.js";
import { refreshCloseTokens } from "../../../services/closeService.js";
import { refreshHubSpotTokens } from "../../../services/hubspotService.js";
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
      if (record.isSharedGrant) {
        console.log(`🔄 Token Broker: Shared Xero token expiring (${expiresIn}s). Checking latest shared grant...`);
        const latestShared = await getSharedXeroGrant();
        const latestExpiresIn = Math.max(0, Math.round(((latestShared?.expiresAt || 0) - Date.now()) / 1000));

        if (latestExpiresIn >= 300) {
          accessToken = latestShared.tokens.accessToken;
          expiresIn = latestExpiresIn;
          console.log(`✅ Token Broker: Using already-refreshed shared Xero token (${Math.round(expiresIn / 60)}m left).`);
        } else {
          const refreshToken = latestShared?.tokens?.refreshToken || record.tokens.refreshToken;
          if (!refreshToken) {
            return res.status(401).json({
              success: false,
              error: "No refresh token available on Central Shared Xero Grant. Please re-authorize in Pulse.",
              reconnectRequired: true
            });
          }
          try {
            const refreshed = await refreshXeroTokens(refreshToken);
            await updateSharedXeroGrantTokens(refreshed);
            accessToken = refreshed.accessToken;
            expiresIn = refreshed.expiresIn;
            console.log(`✅ Token Broker: Successfully refreshed Central Shared Xero Grant. Fresh for ${Math.round(expiresIn / 60)}m.`);
          } catch (refreshErr) {
            console.error("🚨 Token Broker: Central Shared Xero refresh failed:", refreshErr.message);
            try {
              await markIntegrationReconnectRequired({
                clientKey: record.clientKey,
                tool: "xero",
                error: refreshErr.message
              });
            } catch (_) {}
            return res.status(401).json({
              success: false,
              error: `Failed to refresh Central Shared Xero connection (${refreshErr.message}). Re-authorization required.`,
              reconnectRequired: true
            });
          }
        }
      } else {
        console.log(`🔄 Token Broker: Dedicated Xero token for ${record.clientKey} is expiring in ${expiresIn}s. Triggering automatic refresh...`);

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
          try {
            await markIntegrationReconnectRequired({
              clientKey: record.clientKey,
              tool: "xero",
              error: refreshErr.message
            });
          } catch (_) {}
          return res.status(401).json({
            success: false,
            error: `Failed to refresh Xero connection (${refreshErr.message}). Re-authorization required.`,
            reconnectRequired: true
          });
        }
      }
    } else if (isExpiringSoon && (tool === "quickbooks" || tool === "qb")) {
      console.log(`🔄 Token Broker: QuickBooks token for ${record.clientKey} is expiring in ${expiresIn}s. Triggering automatic refresh...`);

      if (!record.tokens.refreshToken) {
        return res.status(401).json({
          success: false,
          error: "No refresh token available to refresh QuickBooks connection. Please re-authorize in Pulse.",
          reconnectRequired: true
        });
      }

      try {
        const refreshed = await refreshQBTokens(record.tokens.refreshToken);
        await updateRefreshedTokens({
          clientKey: record.clientKey,
          tool: "quickbooks",
          tokens: refreshed
        });

        accessToken = refreshed.accessToken;
        expiresIn = refreshed.expiresIn;
        console.log(`✅ Token Broker: Successfully refreshed QuickBooks token for ${record.clientKey}. Fresh for ${Math.round(expiresIn / 60)}m.`);
      } catch (refreshErr) {
        console.error(`🚨 Token Broker: QuickBooks refresh failed for ${record.clientKey}:`, refreshErr.message);
        try {
          await markIntegrationReconnectRequired({
            clientKey: record.clientKey,
            tool: "quickbooks",
            error: refreshErr.message
          });
        } catch (_) {}
        return res.status(401).json({
          success: false,
          error: `Failed to refresh QuickBooks connection (${refreshErr.message}). Re-authorization required.`,
          reconnectRequired: true
        });
      }
    } else if (isExpiringSoon && tool === "pipedrive") {
      if (record.tokens.refreshToken) {
        try {
          const refreshed = await refreshPipedriveTokens(record.tokens.refreshToken);
          await updateRefreshedTokens({
            clientKey: record.clientKey,
            tool: "pipedrive",
            tokens: refreshed
          });
          accessToken = refreshed.accessToken;
          expiresIn = refreshed.expiresIn;
          console.log(`✅ Token Broker: Successfully refreshed Pipedrive token for ${record.clientKey}.`);
        } catch (refreshErr) {
          console.error(`🚨 Token Broker: Pipedrive refresh failed for ${record.clientKey}:`, refreshErr.message);
        }
      }
    } else if (isExpiringSoon && tool === "monday") {
      if (record.tokens.refreshToken) {
        try {
          const refreshed = await refreshMondayTokens(record.tokens.refreshToken);
          await updateRefreshedTokens({
            clientKey: record.clientKey,
            tool: "monday",
            tokens: refreshed
          });
          accessToken = refreshed.accessToken;
          expiresIn = refreshed.expiresIn;
          console.log(`✅ Token Broker: Successfully refreshed Monday.com token for ${record.clientKey}.`);
        } catch (refreshErr) {
          console.error(`🚨 Token Broker: Monday refresh failed for ${record.clientKey}:`, refreshErr.message);
        }
      }
    } else if (isExpiringSoon && tool === "capsule") {
      if (record.tokens.refreshToken) {
        try {
          const refreshed = await refreshCapsuleTokens(record.tokens.refreshToken);
          await updateRefreshedTokens({
            clientKey: record.clientKey,
            tool: "capsule",
            tokens: refreshed
          });
          accessToken = refreshed.accessToken;
          expiresIn = refreshed.expiresIn;
          console.log(`✅ Token Broker: Successfully refreshed Capsule CRM token for ${record.clientKey}.`);
        } catch (refreshErr) {
          console.error(`🚨 Token Broker: Capsule refresh failed for ${record.clientKey}:`, refreshErr.message);
        }
      }
    } else if (isExpiringSoon && tool === "close") {
      if (record.tokens.refreshToken) {
        try {
          const refreshed = await refreshCloseTokens(record.tokens.refreshToken);
          await updateRefreshedTokens({
            clientKey: record.clientKey,
            tool: "close",
            tokens: refreshed
          });
          accessToken = refreshed.accessToken;
          expiresIn = refreshed.expiresIn;
          console.log(`✅ Token Broker: Successfully refreshed Close CRM token for ${record.clientKey}.`);
        } catch (refreshErr) {
          console.error(`🚨 Token Broker: Close refresh failed for ${record.clientKey}:`, refreshErr.message);
        }
      }
    } else if (isExpiringSoon && tool === "hubspot") {
      if (record.tokens.refreshToken) {
        try {
          const refreshed = await refreshHubSpotTokens(record.tokens.refreshToken);
          await updateRefreshedTokens({
            clientKey: record.clientKey,
            tool: "hubspot",
            tokens: refreshed
          });
          accessToken = refreshed.accessToken;
          expiresIn = refreshed.expiresIn;
          console.log(`✅ Token Broker: Successfully refreshed HubSpot token for ${record.clientKey}.`);
        } catch (refreshErr) {
          console.error(`🚨 Token Broker: HubSpot refresh failed for ${record.clientKey}:`, refreshErr.message);
        }
      }
    }

    // 5. Return short-lived access credentials
    return res.status(200).json({
      success: true,
      tool,
      clientKey: record.clientKey,
      clientName: record.clientName,
      accessToken,
      tenantId: record.tenantId || record.realmId || "",
      tenantName: record.tenantName || record.companyName || "",
      realmId: record.realmId || record.tenantId || "",
      companyName: record.companyName || record.tenantName || "",
      expiresIn
    });

  } catch (err) {
    console.error("Token Broker handler error:", err);
    return res.status(500).json({ success: false, error: err.message || "Internal Token Broker failure." });
  }
}
