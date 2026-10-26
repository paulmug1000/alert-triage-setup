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

import crypto from "crypto";
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
import { redisClient } from "../../../services/redisClient.js";

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Module-level in-flight refresh mutex to prevent local container concurrent refresh token collisions
const inFlightRefreshes = new Map();

/**
 * Distributed concurrency mutex using Redis SET NX EX, backed by in-memory deduplication.
 * Prevents single-use refresh token collisions across multiple serverless containers.
 */
async function refreshWithConcurrencyLock(lockKey, refreshFn, getLatestTokenFn) {
  const redisLockKey = `pulse:lock:refresh:${lockKey}`;

  // 1. Fast in-process check for local container deduplication
  if (inFlightRefreshes.has(lockKey)) {
    console.log(`⏳ Token Broker: Local refresh already in-flight for "${lockKey}". Awaiting active promise...`);
    return await inFlightRefreshes.get(lockKey);
  }

  const promise = (async () => {
    let hasRedisLock = false;
    try {
      if (redisClient?.isOpen) {
        // Try to acquire distributed Redis lock (valid for 20 seconds)
        const acquired = await redisClient.set(redisLockKey, "locked", { NX: true, EX: 20 });
        if (!acquired) {
          console.log(`🔒 Token Broker: Another worker holds distributed lock for "${lockKey}". Waiting for fresh token...`);
          // Spin-wait for up to 6 seconds for the active worker to finish and persist fresh tokens
          for (let attempt = 0; attempt < 24; attempt++) {
            await new Promise(r => setTimeout(r, 250));
            if (getLatestTokenFn) {
              const fresh = await getLatestTokenFn();
              if (fresh && fresh.expiresIn >= 300) {
                console.log(`✅ Token Broker: Obtained fresh token refreshed by concurrent worker for "${lockKey}".`);
                return fresh;
              }
            }
          }
          console.warn(`⚠️ Token Broker: Distributed lock wait timeout for "${lockKey}". Proceeding with local refresh attempt.`);
        } else {
          hasRedisLock = true;
        }
      }

      return await refreshFn();
    } finally {
      if (hasRedisLock && redisClient?.isOpen) {
        try { await redisClient.del(redisLockKey); } catch (_) {}
      }
      inFlightRefreshes.delete(lockKey);
    }
  })();

  inFlightRefreshes.set(lockKey, promise);
  return await promise;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // 1. Parse Target Integration & Client Identifier
  const tool = String(req.query.tool || req.body?.tool || "xero").trim().toLowerCase();
  const spreadsheetId = req.query.spreadsheetId || req.query.sheetId || req.body?.spreadsheetId || req.body?.sheetId || "";
  const clientKey = req.query.clientKey || req.query.clientName || req.body?.clientKey || req.body?.clientName || "";

  if (!spreadsheetId && !clientKey) {
    return res.status(400).json({ success: false, error: "Missing spreadsheetId or clientKey parameter." });
  }

  // 2. Verify Authentication: Ecosystem Secret, Client-Specific Secret, OR Admin Session
  const authHeader = req.headers.authorization || "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedSecret = tokenMatch ? tokenMatch[1].trim() : (req.query.secret || req.body?.secret || "");

  const expectedSecret = process.env.PULSE_INTERNAL_SECRET || "";
  const isMasterSecretValid = Boolean(expectedSecret && providedSecret && safeCompare(providedSecret, expectedSecret));

  const sessionUser = getSessionUser(req);
  const isAdmin = Boolean(sessionUser?.isAdmin);

  // Client-specific secret sent in custom header (or body fallback)
  const providedClientSecret = String(
    req.headers["x-pulse-client-secret"] ||
    req.headers["x-client-secret"] ||
    req.body?.clientSecret ||
    ""
  ).trim();

  let isAuthorized = isAdmin;
  const targetIdentifier = spreadsheetId || clientKey;
  const redisSecretKey = `pulse:client_secret:${targetIdentifier}`;

  if (!isAuthorized) {
    let registeredHash = null;
    if (redisClient?.isOpen) {
      try {
        registeredHash = await redisClient.get(redisSecretKey);
      } catch (redisErr) {
        console.warn("⚠️ Token Broker: Error checking client secret in Redis:", redisErr.message);
      }
    }

    if (providedClientSecret) {
      const providedHash = crypto.createHash("sha256").update(providedClientSecret).digest("hex");
      if (registeredHash) {
        if (safeCompare(providedHash, registeredHash)) {
          isAuthorized = true;
        } else {
          console.warn(`🚨 Token Broker: Invalid client-specific secret presented for ${targetIdentifier}.`);
          return res.status(401).json({ success: false, error: "Unauthorized: Invalid client-specific secret." });
        }
      } else {
        // Auto-registration handshake: requires valid ecosystem master secret to bind
        if (isMasterSecretValid) {
          if (redisClient?.isOpen) {
            try {
              await redisClient.set(redisSecretKey, providedHash);
              console.log(`✅ Token Broker: Registered new client-specific secret for ${targetIdentifier}`);
            } catch (regErr) {
              console.warn("⚠️ Token Broker: Failed to persist client secret in Redis:", regErr.message);
            }
          }
          isAuthorized = true;
        } else {
          console.warn(`🚨 Token Broker: Unauthorized attempt to register client secret for ${targetIdentifier}.`);
          return res.status(401).json({ success: false, error: "Unauthorized: Valid ecosystem secret required for initial client registration." });
        }
      }
    } else {
      // Legacy fallback: no client secret provided
      if (registeredHash) {
        // Once a sheet is registered with its own secret, legacy calls without that secret are rejected
        console.warn(`🚨 Token Broker: Legacy secret rejected for already-registered sheet ${targetIdentifier}.`);
        return res.status(401).json({ success: false, error: "Unauthorized: Client-specific secret is required for this registered sheet." });
      } else if (isMasterSecretValid) {
        // Sheet has not yet upgraded its script; allow under legacy master secret
        isAuthorized = true;
      }
    }
  }

  if (!isAuthorized) {
    console.warn("🚨 Token Broker: Unauthorized attempt to request integration token.");
    return res.status(401).json({ success: false, error: "Unauthorized: Invalid internal secret or admin session required." });
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

    const shouldVerify = req.query.verify === "true" || req.query.test === "true" || req.body?.verify === true;

    if (record.reconnectRequired && !shouldVerify) {
      return res.status(401).json({
        success: false,
        error: `Connection to ${tool} requires re-authorization. Please visit PMA > Integrations.`,
        reconnectRequired: true,
        lastError: record.lastError || null
      });
    }

    let accessToken = record.tokens.accessToken;
    let expiresIn = Math.max(0, Math.round(((record.expiresAt || 0) - Date.now()) / 1000));

    // 4. Token Freshness Evaluation (Buffer: 5 minutes)
    const isExpiringSoon = expiresIn < 300;

    if (isExpiringSoon && tool === "xero") {
      const lockKey = record.isSharedGrant ? "xero:shared" : `xero:${record.clientKey}`;

      try {
        const refreshResult = await refreshWithConcurrencyLock(lockKey, async () => {
          if (record.isSharedGrant) {
            console.log(`🔄 Token Broker: Shared Xero token expiring (${expiresIn}s). Checking latest shared grant...`);
            const latestShared = await getSharedXeroGrant();
            const latestExpiresIn = Math.max(0, Math.round(((latestShared?.expiresAt || 0) - Date.now()) / 1000));

            if (latestExpiresIn >= 300) {
              console.log(`✅ Token Broker: Using already-refreshed shared Xero token (${Math.round(latestExpiresIn / 60)}m left).`);
              return {
                accessToken: latestShared.tokens.accessToken,
                expiresIn: latestExpiresIn
              };
            }

            const refreshToken = latestShared?.tokens?.refreshToken;
            if (!refreshToken) {
              throw new Error("No refresh token available on Central Shared Xero Grant. Please re-authorize in Pulse.");
            }

            const refreshed = await refreshXeroTokens(refreshToken);
            await updateSharedXeroGrantTokens(refreshed);
            console.log(`✅ Token Broker: Successfully refreshed Central Shared Xero Grant. Fresh for ${Math.round(refreshed.expiresIn / 60)}m.`);
            return {
              accessToken: refreshed.accessToken,
              expiresIn: refreshed.expiresIn
            };
          } else {
            console.log(`🔄 Token Broker: Dedicated Xero token for ${record.clientKey} expiring (${expiresIn}s). Checking freshness...`);
            const latestDedicated = await getIntegrationTokens({ clientKey: record.clientKey, tool: "xero" });
            const latestExpiresIn = Math.max(0, Math.round(((latestDedicated?.expiresAt || 0) - Date.now()) / 1000));

            if (latestExpiresIn >= 300) {
              console.log(`✅ Token Broker: Using already-refreshed dedicated Xero token for ${record.clientKey} (${Math.round(latestExpiresIn / 60)}m left).`);
              return {
                accessToken: latestDedicated.tokens.accessToken,
                expiresIn: latestExpiresIn
              };
            }

            if (!latestDedicated?.tokens?.refreshToken) {
              throw new Error("No refresh token available for dedicated connection. Please re-authorize in Pulse.");
            }

            const refreshed = await refreshXeroTokens(latestDedicated.tokens.refreshToken);
            await updateRefreshedTokens({
              clientKey: record.clientKey,
              tool: "xero",
              tokens: refreshed
            });
            console.log(`✅ Token Broker: Successfully refreshed dedicated Xero token for ${record.clientKey}. Fresh for ${Math.round(refreshed.expiresIn / 60)}m.`);
            return {
              accessToken: refreshed.accessToken,
              expiresIn: refreshed.expiresIn
            };
          }
        }, async () => {
          if (record.isSharedGrant) {
            const latestShared = await getSharedXeroGrant();
            const latestExpiresIn = Math.max(0, Math.round(((latestShared?.expiresAt || 0) - Date.now()) / 1000));
            return latestShared?.tokens?.accessToken ? { accessToken: latestShared.tokens.accessToken, expiresIn: latestExpiresIn } : null;
          } else {
            const latestDedicated = await getIntegrationTokens({ clientKey: record.clientKey, tool: "xero" });
            const latestExpiresIn = Math.max(0, Math.round(((latestDedicated?.expiresAt || 0) - Date.now()) / 1000));
            return latestDedicated?.tokens?.accessToken ? { accessToken: latestDedicated.tokens.accessToken, expiresIn: latestExpiresIn } : null;
          }
        });

        accessToken = refreshResult.accessToken;
        expiresIn = refreshResult.expiresIn;
      } catch (refreshErr) {
        console.error(`🚨 Token Broker: Refresh failed for [${lockKey}]:`, refreshErr.message);
        const errMsg = String(refreshErr.message || "").toLowerCase();
        const isAuthFailure = errMsg.includes("invalid_grant") || errMsg.includes("consumed") || errMsg.includes("unauthorized") || errMsg.includes("re-authorize");
        if (isAuthFailure) {
          try {
            await markIntegrationReconnectRequired({
              clientKey: record.clientKey,
              tool: "xero",
              error: refreshErr.message,
              isSharedGrant: Boolean(record.isSharedGrant)
            });
          } catch (_) {}
        }
        return res.status(401).json({
          success: false,
          error: `Failed to refresh Xero connection (${refreshErr.message}). Re-authorization required.`,
          reconnectRequired: isAuthFailure
        });
      }
    } else if (isExpiringSoon && (tool === "quickbooks" || tool === "qb")) {
      const lockKey = `quickbooks:${record.clientKey}`;
      try {
        const refreshResult = await refreshWithConcurrencyLock(
          lockKey,
          async () => {
            console.log(`🔄 Token Broker: QuickBooks token for ${record.clientKey} is expiring in ${expiresIn}s. Triggering automatic refresh...`);
            const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "quickbooks" });
            const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
            if (latestExpiresIn >= 300) {
              return { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn };
            }
            if (!latest?.tokens?.refreshToken) {
              throw new Error("No refresh token available to refresh QuickBooks connection. Please re-authorize in Pulse.");
            }
            const refreshed = await refreshQBTokens(latest.tokens.refreshToken);
            await updateRefreshedTokens({
              clientKey: record.clientKey,
              tool: "quickbooks",
              tokens: refreshed
            });
            console.log(`✅ Token Broker: Successfully refreshed QuickBooks token for ${record.clientKey}. Fresh for ${Math.round(refreshed.expiresIn / 60)}m.`);
            return { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn };
          },
          async () => {
            const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "quickbooks" });
            const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
            return latest?.tokens?.accessToken ? { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn } : null;
          }
        );
        accessToken = refreshResult.accessToken;
        expiresIn = refreshResult.expiresIn;
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
        const lockKey = `pipedrive:${record.clientKey}`;
        try {
          const refreshResult = await refreshWithConcurrencyLock(
            lockKey,
            async () => {
              const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "pipedrive" });
              const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
              if (latestExpiresIn >= 300) {
                return { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn };
              }
              const refreshed = await refreshPipedriveTokens(latest?.tokens?.refreshToken || record.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "pipedrive",
                tokens: refreshed
              });
              console.log(`✅ Token Broker: Successfully refreshed Pipedrive token for ${record.clientKey}.`);
              return { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn };
            },
            async () => {
              const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "pipedrive" });
              const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
              return latest?.tokens?.accessToken ? { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn } : null;
            }
          );
          accessToken = refreshResult.accessToken;
          expiresIn = refreshResult.expiresIn;
        } catch (refreshErr) {
          console.error(`🚨 Token Broker: Pipedrive refresh failed for ${record.clientKey}:`, refreshErr.message);
          if (refreshErr.message.includes("invalid_grant") || refreshErr.message.includes("unauthorized") || refreshErr.message.includes("revoked")) {
            await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "pipedrive", error: refreshErr.message });
          }
          return res.status(401).json({
            success: false,
            error: `Failed to refresh Pipedrive connection (${refreshErr.message}). Re-authorization required.`,
            reconnectRequired: true
          });
        }
      }
    } else if (isExpiringSoon && tool === "monday") {
      if (record.tokens.refreshToken) {
        const lockKey = `monday:${record.clientKey}`;
        try {
          const refreshResult = await refreshWithConcurrencyLock(
            lockKey,
            async () => {
              const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "monday" });
              const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
              if (latestExpiresIn >= 300) {
                return { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn };
              }
              const refreshed = await refreshMondayTokens(latest?.tokens?.refreshToken || record.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "monday",
                tokens: refreshed
              });
              console.log(`✅ Token Broker: Successfully refreshed Monday.com token for ${record.clientKey}.`);
              return { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn };
            },
            async () => {
              const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "monday" });
              const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
              return latest?.tokens?.accessToken ? { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn } : null;
            }
          );
          accessToken = refreshResult.accessToken;
          expiresIn = refreshResult.expiresIn;
        } catch (refreshErr) {
          console.error(`🚨 Token Broker: Monday refresh failed for ${record.clientKey}:`, refreshErr.message);
          if (refreshErr.message.includes("invalid_grant") || refreshErr.message.includes("unauthorized") || refreshErr.message.includes("revoked")) {
            await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "monday", error: refreshErr.message });
          }
          return res.status(401).json({
            success: false,
            error: `Failed to refresh Monday.com connection (${refreshErr.message}). Re-authorization required.`,
            reconnectRequired: true
          });
        }
      }
    } else if (isExpiringSoon && tool === "capsule") {
      if (record.tokens.refreshToken) {
        const lockKey = `capsule:${record.clientKey}`;
        try {
          const refreshResult = await refreshWithConcurrencyLock(
            lockKey,
            async () => {
              const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "capsule" });
              const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
              if (latestExpiresIn >= 300) {
                return { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn };
              }
              const refreshed = await refreshCapsuleTokens(latest?.tokens?.refreshToken || record.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "capsule",
                tokens: refreshed
              });
              console.log(`✅ Token Broker: Successfully refreshed Capsule CRM token for ${record.clientKey}.`);
              return { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn };
            },
            async () => {
              const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "capsule" });
              const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
              return latest?.tokens?.accessToken ? { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn } : null;
            }
          );
          accessToken = refreshResult.accessToken;
          expiresIn = refreshResult.expiresIn;
        } catch (refreshErr) {
          console.error(`🚨 Token Broker: Capsule refresh failed for ${record.clientKey}:`, refreshErr.message);
          if (refreshErr.message.includes("invalid_grant") || refreshErr.message.includes("unauthorized") || refreshErr.message.includes("revoked")) {
            await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "capsule", error: refreshErr.message });
          }
          return res.status(401).json({
            success: false,
            error: `Failed to refresh Capsule connection (${refreshErr.message}). Re-authorization required.`,
            reconnectRequired: true
          });
        }
      }
    } else if (isExpiringSoon && tool === "close") {
      if (record.tokens.refreshToken) {
        const lockKey = `close:${record.clientKey}`;
        try {
          const refreshResult = await refreshWithConcurrencyLock(
            lockKey,
            async () => {
              const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "close" });
              const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
              if (latestExpiresIn >= 300) {
                return { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn };
              }
              const refreshed = await refreshCloseTokens(latest?.tokens?.refreshToken || record.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "close",
                tokens: refreshed
              });
              console.log(`✅ Token Broker: Successfully refreshed Close CRM token for ${record.clientKey}.`);
              return { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn };
            },
            async () => {
              const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "close" });
              const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
              return latest?.tokens?.accessToken ? { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn } : null;
            }
          );
          accessToken = refreshResult.accessToken;
          expiresIn = refreshResult.expiresIn;
        } catch (refreshErr) {
          console.error(`🚨 Token Broker: Close refresh failed for ${record.clientKey}:`, refreshErr.message);
          if (refreshErr.message.includes("invalid_grant") || refreshErr.message.includes("unauthorized") || refreshErr.message.includes("revoked")) {
            await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "close", error: refreshErr.message });
          }
          return res.status(401).json({
            success: false,
            error: `Failed to refresh Close connection (${refreshErr.message}). Re-authorization required.`,
            reconnectRequired: true
          });
        }
      }
    } else if (isExpiringSoon && tool === "hubspot") {
      if (record.tokens.refreshToken) {
        const lockKey = `hubspot:${record.clientKey}`;
        try {
          const refreshResult = await refreshWithConcurrencyLock(
            lockKey,
            async () => {
              const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "hubspot" });
              const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
              if (latestExpiresIn >= 300) {
                return { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn };
              }
              const refreshed = await refreshHubSpotTokens(latest?.tokens?.refreshToken || record.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "hubspot",
                tokens: refreshed
              });
              console.log(`✅ Token Broker: Successfully refreshed HubSpot token for ${record.clientKey}.`);
              return { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn };
            },
            async () => {
              const latest = await getIntegrationTokens({ clientKey: record.clientKey, tool: "hubspot" });
              const latestExpiresIn = Math.max(0, Math.round(((latest?.expiresAt || 0) - Date.now()) / 1000));
              return latest?.tokens?.accessToken ? { accessToken: latest.tokens.accessToken, expiresIn: latestExpiresIn } : null;
            }
          );
          accessToken = refreshResult.accessToken;
          expiresIn = refreshResult.expiresIn;
        } catch (refreshErr) {
          console.error(`🚨 Token Broker: HubSpot refresh failed for ${record.clientKey}:`, refreshErr.message);
          if (refreshErr.message.includes("invalid_grant") || refreshErr.message.includes("unauthorized") || refreshErr.message.includes("revoked")) {
            await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "hubspot", error: refreshErr.message });
          }
          return res.status(401).json({
            success: false,
            error: `Failed to refresh HubSpot connection (${refreshErr.message}). Re-authorization required.`,
            reconnectRequired: true
          });
        }
      }
    }
    if (shouldVerify) {
      if (tool === "xero") {
        const tenantId = record.tenantId || "";
        if (!tenantId) {
          return res.status(400).json({
            success: false,
            error: `Configuration Error: Client "${record.clientName}" does not have a Xero tenant ID configured.`,
            reconnectRequired: true
          });
        }
        try {
          const testRes = await fetch("https://api.xero.com/api.xro/2.0/Organisation", {
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "xero-tenant-id": tenantId,
              "Accept": "application/json"
            }
          });
          if (!testRes.ok) {
            const errBody = await testRes.text();
            let parsedErr = errBody;
            try { parsedErr = JSON.parse(errBody); } catch {}
            console.error(`🚨 Token Broker: Provider test failed for ${record.clientName} (Xero HTTP ${testRes.status}):`, errBody);
            return res.status(testRes.status === 403 || testRes.status === 401 ? 403 : 502).json({
              success: false,
              verified: false,
              status: testRes.status,
              error: `Xero API Error: HTTP ${testRes.status} (${testRes.statusText}). This token does not have access to organisation "${record.tenantName || tenantId}". Re-authorization required.`,
              providerDetails: parsedErr,
              reconnectRequired: true
            });
          }
          const orgData = await testRes.json();
          const orgName = orgData?.Organisations?.[0]?.Name || record.tenantName;
          return res.status(200).json({
            success: true,
            verified: true,
            tool,
            clientKey: record.clientKey,
            clientName: record.clientName,
            accessToken,
            tenantId,
            tenantName: orgName,
            expiresIn,
            message: `Verified successfully with Xero API for "${orgName}"!`
          });
        } catch (callErr) {
          return res.status(502).json({
            success: false,
            verified: false,
            error: `Failed to contact Xero API: ${callErr.message}`,
            reconnectRequired: false
          });
        }
      } else if (tool === "quickbooks" || tool === "qb") {
        const realmId = record.realmId || record.tenantId || "";
        if (!realmId) {
          return res.status(400).json({
            success: false,
            error: `Configuration Error: Client "${record.clientName}" does not have a QuickBooks company ID (realmId) configured.`,
            reconnectRequired: true
          });
        }
        try {
          const testRes = await fetch(`https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`, {
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Accept": "application/json"
            }
          });
          if (!testRes.ok) {
            const errBody = await testRes.text();
            return res.status(testRes.status === 403 || testRes.status === 401 ? 403 : 502).json({
              success: false,
              verified: false,
              status: testRes.status,
              error: `QuickBooks API Error: HTTP ${testRes.status} (${testRes.statusText}). Re-authorization required.`,
              providerDetails: errBody,
              reconnectRequired: true
            });
          }
          const qbData = await testRes.json();
          const compName = qbData?.CompanyInfo?.CompanyName || record.companyName;
          return res.status(200).json({
            success: true,
            verified: true,
            tool,
            clientKey: record.clientKey,
            clientName: record.clientName,
            accessToken,
            realmId,
            companyName: compName,
            expiresIn,
            message: `Verified successfully with QuickBooks API for "${compName}"!`
          });
        } catch (callErr) {
          return res.status(502).json({
            success: false,
            verified: false,
            error: `Failed to contact QuickBooks API: ${callErr.message}`,
            reconnectRequired: false
          });
        }
      } else if (tool === "close") {
        try {
          let testRes = await fetch("https://api.close.com/api/v1/me/", {
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Accept": "application/json"
            }
          });

          // If token returned 401, attempt emergency refresh
          if (testRes.status === 401 && record.tokens?.refreshToken) {
            console.log(`⚠️ Token Broker verify: Close returned 401 for ${record.clientName}. Attempting emergency refresh...`);
            try {
              const refreshed = await refreshCloseTokens(record.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "close",
                tokens: refreshed
              });
              accessToken = refreshed.accessToken;
              expiresIn = refreshed.expiresIn;
              testRes = await fetch("https://api.close.com/api/v1/me/", {
                headers: {
                  "Authorization": `Bearer ${accessToken}`,
                  "Accept": "application/json"
                }
              });
            } catch (refErr) {
              console.error(`🚨 Token Broker: Close emergency refresh failed:`, refErr.message);
              if (refErr.message.includes("invalid_grant") || refErr.message.includes("unauthorized")) {
                await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "close", error: refErr.message });
              }
              return res.status(401).json({
                success: false,
                verified: false,
                status: 401,
                error: `Close CRM API Error: HTTP 401 (Unauthorized). Token refresh rejected: ${refErr.message}. Re-authorization required.`,
                reconnectRequired: true
              });
            }
          }

          if (!testRes.ok) {
            const errBody = await testRes.text();
            await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "close", error: `HTTP ${testRes.status}: ${errBody}` });
            return res.status(testRes.status === 401 ? 401 : 502).json({
              success: false,
              verified: false,
              status: testRes.status,
              error: `Close CRM API Error: HTTP ${testRes.status} (${testRes.statusText}). Re-authorization required.`,
              providerDetails: errBody,
              reconnectRequired: true
            });
          }

          const accData = await testRes.json();
          const orgName = accData?.organizations?.[0]?.name || record.metadata?.organizationName || record.clientName;
          return res.status(200).json({
            success: true,
            verified: true,
            tool,
            clientKey: record.clientKey,
            clientName: record.clientName,
            accessToken,
            expiresIn,
            organizationName: orgName,
            message: `Verified successfully with Close CRM API for "${orgName}"!`
          });
        } catch (callErr) {
          return res.status(502).json({
            success: false,
            verified: false,
            error: `Failed to contact Close CRM API: ${callErr.message}`,
            reconnectRequired: false
          });
        }
      } else if (tool === "clickup") {
        try {
          const cleanToken = accessToken.startsWith("Bearer ") ? accessToken : accessToken;
          const testRes = await fetch("https://api.clickup.com/api/v2/team", {
            headers: {
              "Authorization": cleanToken,
              "Accept": "application/json"
            }
          });

          if (!testRes.ok) {
            const errBody = await testRes.text();
            if (testRes.status === 401 || testRes.status === 403) {
              await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "clickup", error: `HTTP ${testRes.status}: ${errBody}` });
            }
            return res.status(testRes.status === 401 || testRes.status === 403 ? 401 : 502).json({
              success: false,
              verified: false,
              status: testRes.status,
              error: `ClickUp API Error: HTTP ${testRes.status} (${testRes.statusText}). Token invalid or revoked. Re-authorization required.`,
              providerDetails: errBody,
              reconnectRequired: testRes.status === 401 || testRes.status === 403
            });
          }

          const teamData = await testRes.json();
          const teamName = teamData?.teams?.[0]?.name || record.metadata?.teamName || record.clientName;
          return res.status(200).json({
            success: true,
            verified: true,
            tool,
            clientKey: record.clientKey,
            clientName: record.clientName,
            accessToken,
            expiresIn,
            teamName,
            workspaceName: teamName,
            message: `Verified successfully with ClickUp API for workspace "${teamName}"!`
          });
        } catch (callErr) {
          return res.status(502).json({
            success: false,
            verified: false,
            error: `Failed to contact ClickUp API: ${callErr.message}`,
            reconnectRequired: false
          });
        }
      } else if (tool === "capsule") {
        try {
          const cleanToken = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;
          let testRes = await fetch("https://api.capsulecrm.com/api/v2/site", {
            headers: {
              "Authorization": cleanToken,
              "Accept": "application/json"
            }
          });

          // If token returned 401, attempt emergency refresh
          if (testRes.status === 401 && record.tokens?.refreshToken) {
            console.log(`⚠️ Token Broker verify: Capsule returned 401 for ${record.clientName}. Attempting emergency refresh...`);
            try {
              const refreshed = await refreshCapsuleTokens(record.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "capsule",
                tokens: refreshed
              });
              accessToken = refreshed.accessToken;
              expiresIn = refreshed.expiresIn;
              testRes = await fetch("https://api.capsulecrm.com/api/v2/site", {
                headers: {
                  "Authorization": `Bearer ${accessToken}`,
                  "Accept": "application/json"
                }
              });
            } catch (refErr) {
              console.error(`🚨 Token Broker: Capsule emergency refresh failed:`, refErr.message);
              await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "capsule", error: refErr.message });
              return res.status(401).json({
                success: false,
                verified: false,
                status: 401,
                error: `Capsule CRM API Error: HTTP 401 (Unauthorized). Token refresh rejected: ${refErr.message}. Re-authorization required.`,
                reconnectRequired: true
              });
            }
          }

          if (!testRes.ok) {
            const errBody = await testRes.text();
            if (testRes.status === 401 || testRes.status === 403) {
              await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "capsule", error: `HTTP ${testRes.status}: ${errBody}` });
            }
            return res.status(testRes.status === 401 || testRes.status === 403 ? 401 : 502).json({
              success: false,
              verified: false,
              status: testRes.status,
              error: `Capsule CRM API Error: HTTP ${testRes.status} (${testRes.statusText}). Re-authorization required.`,
              providerDetails: errBody,
              reconnectRequired: testRes.status === 401 || testRes.status === 403
            });
          }

          const siteData = await testRes.json();
          const siteName = siteData?.site?.name || record.metadata?.siteName || record.clientName;
          const siteUrl = siteData?.site?.url || "";
          return res.status(200).json({
            success: true,
            verified: true,
            tool,
            clientKey: record.clientKey,
            clientName: record.clientName,
            accessToken,
            expiresIn,
            siteName,
            siteUrl,
            message: `Verified successfully with Capsule CRM API for "${siteName}"!`
          });
        } catch (callErr) {
          return res.status(502).json({
            success: false,
            verified: false,
            error: `Failed to contact Capsule CRM API: ${callErr.message}`,
            reconnectRequired: false
          });
        }
      } else if (tool === "pipedrive") {
        try {
          const cleanToken = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;
          let testRes = await fetch("https://api.pipedrive.com/v1/users/me", {
            headers: {
              "Authorization": cleanToken,
              "Accept": "application/json"
            }
          });

          // If token returned 401, attempt emergency refresh
          if (testRes.status === 401 && record.tokens?.refreshToken) {
            console.log(`⚠️ Token Broker verify: Pipedrive returned 401 for ${record.clientName}. Attempting emergency refresh...`);
            try {
              const refreshed = await refreshPipedriveTokens(record.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "pipedrive",
                tokens: refreshed
              });
              accessToken = refreshed.accessToken;
              expiresIn = refreshed.expiresIn;
              testRes = await fetch("https://api.pipedrive.com/v1/users/me", {
                headers: {
                  "Authorization": `Bearer ${accessToken}`,
                  "Accept": "application/json"
                }
              });
            } catch (refErr) {
              console.error(`🚨 Token Broker: Pipedrive emergency refresh failed:`, refErr.message);
              await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "pipedrive", error: refErr.message });
              return res.status(401).json({
                success: false,
                verified: false,
                status: 401,
                error: `Pipedrive API Error: HTTP 401 (Unauthorized). Token refresh rejected: ${refErr.message}. Re-authorization required.`,
                reconnectRequired: true
              });
            }
          }

          if (!testRes.ok) {
            const errBody = await testRes.text();
            if (testRes.status === 401 || testRes.status === 403) {
              await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "pipedrive", error: `HTTP ${testRes.status}: ${errBody}` });
            }
            return res.status(testRes.status === 401 || testRes.status === 403 ? 401 : 502).json({
              success: false,
              verified: false,
              status: testRes.status,
              error: `Pipedrive API Error: HTTP ${testRes.status} (${testRes.statusText}). Re-authorization required.`,
              providerDetails: errBody,
              reconnectRequired: testRes.status === 401 || testRes.status === 403
            });
          }

          const pipeData = await testRes.json();
          const compName = pipeData?.data?.company_name || record.metadata?.companyName || record.clientName;
          const userName = pipeData?.data?.name || "";
          return res.status(200).json({
            success: true,
            verified: true,
            tool,
            clientKey: record.clientKey,
            clientName: record.clientName,
            accessToken,
            expiresIn,
            companyName: compName,
            userName,
            message: `Verified successfully with Pipedrive API for "${compName}"!`
          });
        } catch (callErr) {
          return res.status(502).json({
            success: false,
            verified: false,
            error: `Failed to contact Pipedrive API: ${callErr.message}`,
            reconnectRequired: false
          });
        }
      } else if (tool === "monday") {
        try {
          const query = `query { me { id name email account { id name } } }`;
          let testRes = await fetch("https://api.monday.com/v2", {
            method: "POST",
            headers: {
              "Authorization": accessToken,
              "Content-Type": "application/json",
              "API-Version": "2024-04"
            },
            body: JSON.stringify({ query })
          });

          // If token returned 401, attempt emergency refresh
          if (testRes.status === 401 && record.tokens?.refreshToken) {
            console.log(`⚠️ Token Broker verify: Monday returned 401 for ${record.clientName}. Attempting emergency refresh...`);
            try {
              const refreshed = await refreshMondayTokens(record.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "monday",
                tokens: refreshed
              });
              accessToken = refreshed.accessToken;
              expiresIn = refreshed.expiresIn;
              testRes = await fetch("https://api.monday.com/v2", {
                method: "POST",
                headers: {
                  "Authorization": accessToken,
                  "Content-Type": "application/json",
                  "API-Version": "2024-04"
                },
                body: JSON.stringify({ query })
              });
            } catch (refErr) {
              console.error(`🚨 Token Broker: Monday emergency refresh failed:`, refErr.message);
              await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "monday", error: refErr.message });
              return res.status(401).json({
                success: false,
                verified: false,
                status: 401,
                error: `Monday.com API Error: HTTP 401 (Unauthorized). Token refresh rejected: ${refErr.message}. Re-authorization required.`,
                reconnectRequired: true
              });
            }
          }

          const monData = await testRes.json().catch(() => null);
          const hasError = !testRes.ok || (monData?.errors && monData?.errors.length > 0 && !monData?.data?.me);

          if (hasError) {
            const errDetails = monData?.errors?.[0]?.message || monData?.error_message || (await testRes.text().catch(() => "Unknown error"));
            if (testRes.status === 401 || errDetails.includes("unauthorized") || errDetails.includes("not authenticated")) {
              await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "monday", error: errDetails });
            }
            return res.status(testRes.status === 401 ? 401 : 502).json({
              success: false,
              verified: false,
              status: testRes.status,
              error: `Monday.com API Error: ${errDetails}. Re-authorization required.`,
              reconnectRequired: testRes.status === 401 || errDetails.includes("unauthorized")
            });
          }

          const accountName = monData?.data?.me?.account?.name || record.metadata?.accountName || record.clientName;
          const userName = monData?.data?.me?.name || "";
          return res.status(200).json({
            success: true,
            verified: true,
            tool,
            clientKey: record.clientKey,
            clientName: record.clientName,
            accessToken,
            expiresIn,
            accountName,
            userName,
            message: `Verified successfully with Monday.com API for "${accountName}"!`
          });
        } catch (callErr) {
          return res.status(502).json({
            success: false,
            verified: false,
            error: `Failed to contact Monday.com API: ${callErr.message}`,
            reconnectRequired: false
          });
        }
      } else if (tool === "hubspot") {
        try {
          const cleanToken = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;
          let testRes = await fetch("https://api.hubapi.com/account-info/v3/details", {
            headers: {
              "Authorization": cleanToken,
              "Accept": "application/json"
            }
          });

          // If token returned 401, attempt emergency refresh
          if (testRes.status === 401 && record.tokens?.refreshToken) {
            console.log(`⚠️ Token Broker verify: HubSpot returned 401 for ${record.clientName}. Attempting emergency refresh...`);
            try {
              const refreshed = await refreshHubSpotTokens(record.tokens.refreshToken);
              await updateRefreshedTokens({
                clientKey: record.clientKey,
                tool: "hubspot",
                tokens: refreshed
              });
              accessToken = refreshed.accessToken;
              expiresIn = refreshed.expiresIn;
              testRes = await fetch("https://api.hubapi.com/account-info/v3/details", {
                headers: {
                  "Authorization": `Bearer ${accessToken}`,
                  "Accept": "application/json"
                }
              });
            } catch (refErr) {
              console.error(`🚨 Token Broker: HubSpot emergency refresh failed:`, refErr.message);
              await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "hubspot", error: refErr.message });
              return res.status(401).json({
                success: false,
                verified: false,
                status: 401,
                error: `HubSpot API Error: HTTP 401 (Unauthorized). Token refresh rejected: ${refErr.message}. Re-authorization required.`,
                reconnectRequired: true
              });
            }
          }

          if (!testRes.ok) {
            const errBody = await testRes.text();
            if (testRes.status === 401 || testRes.status === 403) {
              await markIntegrationReconnectRequired({ clientKey: record.clientKey, tool: "hubspot", error: `HTTP ${testRes.status}: ${errBody}` });
            }
            return res.status(testRes.status === 401 || testRes.status === 403 ? 401 : 502).json({
              success: false,
              verified: false,
              status: testRes.status,
              error: `HubSpot API Error: HTTP ${testRes.status} (${testRes.statusText}). Re-authorization required.`,
              providerDetails: errBody,
              reconnectRequired: testRes.status === 401 || testRes.status === 403
            });
          }

          const hubData = await testRes.json();
          const portalId = hubData?.portalId || record.metadata?.portalId || "";
          const accountName = portalId ? `HubSpot Portal ${portalId}` : (record.metadata?.accountName || record.clientName);
          return res.status(200).json({
            success: true,
            verified: true,
            tool,
            clientKey: record.clientKey,
            clientName: record.clientName,
            accessToken,
            expiresIn,
            portalId,
            accountName,
            message: `Verified successfully with HubSpot API for "${accountName}"!`
          });
        } catch (callErr) {
          return res.status(502).json({
            success: false,
            verified: false,
            error: `Failed to contact HubSpot API: ${callErr.message}`,
            reconnectRequired: false
          });
        }
      } else {
        return res.status(400).json({
          success: false,
          verified: false,
          error: `Live verification is not supported for tool "${tool}".`,
          reconnectRequired: false
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
