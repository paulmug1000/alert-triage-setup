/**
 * ============================================================================
 * INTEGRATION IMPORT API ROUTE: /api/integrations/import
 * ============================================================================
 * 
 * Secure endpoint to import existing third-party OAuth credentials from a
 * client's Master Google Sheet into the Pulse Central Vault (Redis).
 * 
 * Flow for Xero:
 * 1. Validates Bearer authorization via PULSE_INTERNAL_SECRET.
 * 2. Takes { tool: 'xero', spreadsheetId, clientName, refreshToken, tenantId }.
 * 3. Immediately tests and refreshes the token against Xero's identity endpoint.
 * 4. Resolves the organization name via Xero /connections.
 * 5. Encrypts and persists credentials (AES-256-GCM) into Redis Vault.
 * 6. Returns a fresh, ready-to-use access token to the Master Sheet.
 */

import crypto from "crypto";
import { saveIntegrationTokens } from "../../../services/vaultService.js";
import { refreshXeroTokens, getXeroConnections } from "../../../services/xeroService.js";
import { refreshQBTokens, getQBCompanyInfo } from "../../../services/quickbooksService.js";
import { refreshMondayTokens, getMondayAccountInfo } from "../../../services/mondayService.js";
import { refreshPipedriveTokens, getPipedriveAccountInfo } from "../../../services/pipedriveService.js";
import { getClickUpWorkspaceInfo } from "../../../services/clickupService.js";
import { refreshCapsuleTokens, getCapsuleAccountInfo } from "../../../services/capsuleService.js";
import { refreshCloseTokens, getCloseAccountInfo } from "../../../services/closeService.js";
import { refreshHubSpotTokens, getHubSpotAccountInfo } from "../../../services/hubspotService.js";
import { getSessionUser } from "../../../services/authService.js";
import { redisClient } from "../../../services/redisClient.js";

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const { tool = "xero", spreadsheetId, clientName, refreshToken, tenantId } = req.body;

  if (!spreadsheetId) {
    return res.status(400).json({ success: false, error: "Missing required spreadsheetId parameter." });
  }

  // 1. Verify Authentication: Ecosystem Secret, Client-Specific Secret, OR Admin Session
  const authHeader = req.headers.authorization || "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedSecret = tokenMatch ? tokenMatch[1].trim() : (req.body?.secret || "");

  const expectedSecret = process.env.PULSE_INTERNAL_SECRET || "";
  const isMasterSecretValid = Boolean(expectedSecret && providedSecret && safeCompare(providedSecret, expectedSecret));

  const sessionUser = getSessionUser(req);
  const isAdmin = Boolean(sessionUser?.isAdmin);

  const providedClientSecret = String(
    req.headers["x-pulse-client-secret"] ||
    req.headers["x-client-secret"] ||
    req.body?.clientSecret ||
    ""
  ).trim();

  let isAuthorized = isAdmin;
  const redisSecretKey = `pulse:client_secret:${spreadsheetId}`;

  if (!isAuthorized) {
    let registeredHash = null;
    if (redisClient?.isOpen) {
      try {
        registeredHash = await redisClient.get(redisSecretKey);
      } catch (redisErr) {
        console.warn("⚠️ Integration Import: Error checking client secret in Redis:", redisErr.message);
      }
    }

    if (providedClientSecret) {
      const providedHash = crypto.createHash("sha256").update(providedClientSecret).digest("hex");
      if (registeredHash) {
        if (safeCompare(providedHash, registeredHash)) {
          isAuthorized = true;
        } else {
          return res.status(401).json({ success: false, error: "Unauthorized: Invalid client-specific secret." });
        }
      } else {
        if (isMasterSecretValid) {
          if (redisClient?.isOpen) {
            try {
              await redisClient.set(redisSecretKey, providedHash);
            } catch (_) {}
          }
          isAuthorized = true;
        } else {
          return res.status(401).json({ success: false, error: "Unauthorized: Valid ecosystem secret required for initial client registration." });
        }
      }
    } else {
      // Legacy fallback retired: client secret is strictly required
      console.warn(`🚨 Integration Import: Missing client-specific secret for ${spreadsheetId}.`);
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Client-specific secret (X-Pulse-Client-Secret) is required."
      });
    }
  }

  if (!isAuthorized) {
    console.warn("🚨 Integration Import: Unauthorized attempt.");
    return res.status(401).json({ success: false, error: "Unauthorized: Invalid internal secret or admin session required." });
  }

  try {
    const cleanTool = String(tool).trim().toLowerCase();

    if (cleanTool === "xero") {
      if (!refreshToken) {
        return res.status(400).json({ success: false, error: "Missing required refreshToken parameter for Xero." });
      }
      console.log(`📥 Integration Import: Importing existing Xero tokens for sheet: ${spreadsheetId}...`);

      // 2. Validate token directly with Xero
      const refreshed = await refreshXeroTokens(refreshToken);

      // 3. Resolve organization metadata
      let tenantName = "";
      let activeTenantId = tenantId || "";

      try {
        const connections = await getXeroConnections(refreshed.accessToken);
        if (connections && connections.length > 0) {
          // If specific tenantId was provided, match it; otherwise use the first
          const matched = activeTenantId ? connections.find(c => c.tenantId === activeTenantId) : connections[0];
          const selected = matched || connections[0];
          activeTenantId = selected.tenantId;
          tenantName = selected.tenantName;
        }
      } catch (connErr) {
        console.warn("⚠️ Xero connections fetch note during import:", connErr.message);
      }

      // 4. Encrypt and persist into Redis Vault
      const effectiveClientKey = clientName || tenantName || spreadsheetId;
      const effectiveClientName = clientName || tenantName || effectiveClientKey;

      await saveIntegrationTokens({
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        masterSheetId: spreadsheetId,
        tool: "xero",
        tokens: {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresIn: refreshed.expiresIn
        },
        metadata: {
          tenantId: activeTenantId,
          tenantName: tenantName,
          importedAt: new Date().toISOString()
        }
      });

      console.log(`✅ Integration Import: Successfully migrated Xero for "${effectiveClientName}" [${spreadsheetId}]. Org: "${tenantName}".`);

      return res.status(200).json({
        success: true,
        tool: "xero",
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        tenantId: activeTenantId,
        tenantName: tenantName,
        accessToken: refreshed.accessToken,
        expiresIn: refreshed.expiresIn,
        message: `Successfully imported Xero connection into Pulse Central Vault.`
      });
    }

    if (cleanTool === "quickbooks" || cleanTool === "qb") {
      if (!refreshToken) {
        return res.status(400).json({ success: false, error: "Missing required refreshToken parameter for QuickBooks." });
      }
      console.log(`📥 Integration Import: Importing existing QuickBooks tokens for sheet: ${spreadsheetId}...`);

      const { realmId = "", qbCompanyId = "", clientId = "", clientSecret = "" } = req.body;
      const activeRealmId = String(realmId || qbCompanyId || "").trim();

      // Validate and refresh token with Intuit
      const refreshed = await refreshQBTokens(refreshToken, clientId, clientSecret);

      // Resolve Company Name via QuickBooks API
      let companyName = "";
      try {
        const info = await getQBCompanyInfo(refreshed.accessToken, activeRealmId);
        if (info?.companyName) {
          companyName = info.companyName;
        }
      } catch (infoErr) {
        console.warn("⚠️ Note resolving QB company info during import:", infoErr.message);
      }

      const effectiveClientKey = clientName || companyName || spreadsheetId;
      const effectiveClientName = clientName || companyName || effectiveClientKey;

      await saveIntegrationTokens({
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        masterSheetId: spreadsheetId,
        tool: "quickbooks",
        tokens: {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresIn: refreshed.expiresIn
        },
        metadata: {
          realmId: activeRealmId,
          companyName: companyName || effectiveClientName,
          importedAt: new Date().toISOString()
        }
      });

      console.log(`✅ Integration Import: Successfully migrated QuickBooks for "${effectiveClientName}" [${spreadsheetId}]. Company: "${companyName || activeRealmId}".`);

      return res.status(200).json({
        success: true,
        tool: "quickbooks",
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        realmId: activeRealmId,
        companyName: companyName || activeRealmId,
        accessToken: refreshed.accessToken,
        expiresIn: refreshed.expiresIn,
        message: `Successfully imported QuickBooks connection into Pulse Central Vault.`
      });
    }

    if (cleanTool === "monday") {
      console.log(`📥 Integration Import: Importing existing Monday.com tokens for sheet: ${spreadsheetId}...`);

      const { accessToken: rawAccessToken = "", token = "", apiKey = "", clientId = "", clientSecret = "" } = req.body;
      let activeAccessToken = rawAccessToken || token || apiKey || "";
      let activeRefreshToken = refreshToken || "";

      if (!activeAccessToken && activeRefreshToken) {
        const refreshed = await refreshMondayTokens(activeRefreshToken, clientId, clientSecret);
        activeAccessToken = refreshed.accessToken;
        activeRefreshToken = refreshed.refreshToken;
      }

      let accountInfo = null;
      if (activeAccessToken) {
        accountInfo = await getMondayAccountInfo(activeAccessToken);
      }

      if (!accountInfo || !accountInfo.accountId) {
        console.error(`🚨 Integration Import: Rejected Monday.com import for ${spreadsheetId} - credentials could not be verified with Monday.com API.`);
        return res.status(401).json({
          success: false,
          error: "Provided Monday.com credentials could not be verified with Monday.com API. Re-authorization required via PMA > Integrations."
        });
      }

      const effectiveClientKey = clientName || accountInfo?.accountName || spreadsheetId;
      const effectiveClientName = clientName || accountInfo?.accountName || effectiveClientKey;

      await saveIntegrationTokens({
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        masterSheetId: spreadsheetId,
        tool: "monday",
        tokens: {
          accessToken: activeAccessToken,
          refreshToken: activeRefreshToken,
          expiresIn: 2592000
        },
        metadata: {
          accountId: accountInfo?.accountId || "",
          accountName: accountInfo?.accountName || effectiveClientName,
          userName: accountInfo?.userName || "",
          userEmail: accountInfo?.userEmail || "",
          importedAt: new Date().toISOString()
        }
      });

      console.log(`✅ Integration Import: Successfully migrated Monday.com for "${effectiveClientName}" [${spreadsheetId}].`);

      return res.status(200).json({
        success: true,
        tool: "monday",
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        accountName: accountInfo?.accountName || effectiveClientName,
        accessToken: activeAccessToken,
        message: `Successfully imported Monday.com connection into Pulse Central Vault.`
      });
    }

    if (cleanTool === "pipedrive") {
      console.log(`📥 Integration Import: Importing existing Pipedrive tokens for sheet: ${spreadsheetId}...`);

      const { accessToken: rawAccessToken = "", token = "", apiToken = "", clientId = "", clientSecret = "" } = req.body;
      let activeAccessToken = rawAccessToken || token || apiToken || "";
      let activeRefreshToken = refreshToken || "";

      if (!activeAccessToken && activeRefreshToken) {
        const refreshed = await refreshPipedriveTokens(activeRefreshToken, clientId, clientSecret);
        activeAccessToken = refreshed.accessToken;
        activeRefreshToken = refreshed.refreshToken;
      }

      let accountInfo = null;
      if (activeAccessToken) {
        accountInfo = await getPipedriveAccountInfo(activeAccessToken);
      }

      if (!accountInfo || !accountInfo.companyId) {
        console.error(`🚨 Integration Import: Rejected Pipedrive import for ${spreadsheetId} - credentials could not be verified with Pipedrive API.`);
        return res.status(401).json({
          success: false,
          error: "Provided Pipedrive credentials could not be verified with Pipedrive API. Re-authorization required via PMA > Integrations."
        });
      }

      const effectiveClientKey = clientName || accountInfo?.companyName || spreadsheetId;
      const effectiveClientName = clientName || accountInfo?.companyName || effectiveClientKey;

      await saveIntegrationTokens({
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        masterSheetId: spreadsheetId,
        tool: "pipedrive",
        tokens: {
          accessToken: activeAccessToken,
          refreshToken: activeRefreshToken,
          expiresIn: 3600
        },
        metadata: {
          companyId: accountInfo?.companyId || "",
          companyName: accountInfo?.companyName || effectiveClientName,
          userName: accountInfo?.userName || "",
          userEmail: accountInfo?.userEmail || "",
          importedAt: new Date().toISOString()
        }
      });

      console.log(`✅ Integration Import: Successfully migrated Pipedrive for "${effectiveClientName}" [${spreadsheetId}].`);

      return res.status(200).json({
        success: true,
        tool: "pipedrive",
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        companyName: accountInfo?.companyName || effectiveClientName,
        accessToken: activeAccessToken,
        message: `Successfully imported Pipedrive connection into Pulse Central Vault.`
      });
    }

    if (cleanTool === "clickup") {
      console.log(`📥 Integration Import: Importing existing ClickUp tokens for sheet: ${spreadsheetId}...`);

      const { accessToken: rawAccessToken = "", token = "", apiKey = "" } = req.body;
      const activeAccessToken = rawAccessToken || token || apiKey || "";

      let workspaceInfo = null;
      if (activeAccessToken) {
        workspaceInfo = await getClickUpWorkspaceInfo(activeAccessToken);
      }

      if (!workspaceInfo || (!workspaceInfo.teamId && !workspaceInfo.userId)) {
        console.error(`🚨 Integration Import: Rejected ClickUp import for ${spreadsheetId} - credentials could not be verified with ClickUp API.`);
        return res.status(401).json({
          success: false,
          error: "Provided ClickUp credentials could not be verified with ClickUp API. Re-authorization required via PMA > Integrations."
        });
      }

      const effectiveClientKey = clientName || workspaceInfo?.workspaceName || spreadsheetId;
      const effectiveClientName = clientName || workspaceInfo?.workspaceName || effectiveClientKey;

      await saveIntegrationTokens({
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        masterSheetId: spreadsheetId,
        tool: "clickup",
        tokens: {
          accessToken: activeAccessToken,
          refreshToken: "",
          expiresIn: 315360000
        },
        metadata: {
          teamId: workspaceInfo?.teamId || "",
          teamName: workspaceInfo?.workspaceName || effectiveClientName,
          userName: workspaceInfo?.userName || "",
          userEmail: workspaceInfo?.userEmail || "",
          importedAt: new Date().toISOString()
        }
      });

      console.log(`✅ Integration Import: Successfully migrated ClickUp for "${effectiveClientName}" [${spreadsheetId}].`);

      return res.status(200).json({
        success: true,
        tool: "clickup",
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        teamName: workspaceInfo?.workspaceName || effectiveClientName,
        accessToken: activeAccessToken,
        message: `Successfully imported ClickUp connection into Pulse Central Vault.`
      });
    }

    if (cleanTool === "capsule") {
      console.log(`📥 Integration Import: Importing existing Capsule CRM tokens for sheet: ${spreadsheetId}...`);

      const { accessToken: rawAccessToken = "", token = "", apiKey = "", clientId = "", clientSecret = "" } = req.body;
      let activeAccessToken = rawAccessToken || token || apiKey || "";
      let activeRefreshToken = refreshToken || "";

      if (!activeAccessToken && activeRefreshToken) {
        const refreshed = await refreshCapsuleTokens(activeRefreshToken, clientId, clientSecret);
        activeAccessToken = refreshed.accessToken;
        activeRefreshToken = refreshed.refreshToken;
      }

      let accountInfo = null;
      if (activeAccessToken) {
        accountInfo = await getCapsuleAccountInfo(activeAccessToken);
      }

      if (!accountInfo || (!accountInfo.siteName && !accountInfo.userId)) {
        console.error(`🚨 Integration Import: Rejected Capsule CRM import for ${spreadsheetId} - credentials could not be verified with Capsule API.`);
        return res.status(401).json({
          success: false,
          error: "Provided Capsule CRM credentials could not be verified with Capsule API. Re-authorization required via PMA > Integrations."
        });
      }

      const effectiveClientKey = clientName || accountInfo?.siteName || spreadsheetId;
      const effectiveClientName = clientName || accountInfo?.siteName || effectiveClientKey;

      await saveIntegrationTokens({
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        masterSheetId: spreadsheetId,
        tool: "capsule",
        tokens: {
          accessToken: activeAccessToken,
          refreshToken: activeRefreshToken,
          expiresIn: 7200
        },
        metadata: {
          siteName: accountInfo?.siteName || effectiveClientName,
          siteUrl: accountInfo?.siteUrl || "",
          userName: accountInfo?.userName || "",
          userEmail: accountInfo?.userEmail || "",
          importedAt: new Date().toISOString()
        }
      });

      console.log(`✅ Integration Import: Successfully migrated Capsule CRM for "${effectiveClientName}" [${spreadsheetId}].`);

      return res.status(200).json({
        success: true,
        tool: "capsule",
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        siteName: accountInfo?.siteName || effectiveClientName,
        accessToken: activeAccessToken,
        message: `Successfully imported Capsule CRM connection into Pulse Central Vault.`
      });
    }

    if (cleanTool === "close") {
      console.log(`📥 Integration Import: Importing existing Close CRM tokens for sheet: ${spreadsheetId}...`);

      const { accessToken: rawAccessToken = "", token = "", apiKey = "", clientId = "", clientSecret = "" } = req.body;
      let activeAccessToken = rawAccessToken || token || apiKey || "";
      let activeRefreshToken = refreshToken || "";

      if (!activeAccessToken && activeRefreshToken) {
        const refreshed = await refreshCloseTokens(activeRefreshToken, clientId, clientSecret);
        activeAccessToken = refreshed.accessToken;
        activeRefreshToken = refreshed.refreshToken;
      }

      let accountInfo = null;
      if (activeAccessToken) {
        accountInfo = await getCloseAccountInfo(activeAccessToken);
      }

      if (!accountInfo || (!accountInfo.userId && !accountInfo.organizationId)) {
        console.error(`🚨 Integration Import: Rejected Close CRM import for ${spreadsheetId} - credentials could not be verified with Close API.`);
        return res.status(401).json({
          success: false,
          error: "Provided Close CRM credentials could not be verified with Close API. Re-authorization required via PMA > Integrations."
        });
      }

      const effectiveClientKey = clientName || accountInfo?.organizationName || spreadsheetId;
      const effectiveClientName = clientName || accountInfo?.organizationName || effectiveClientKey;

      await saveIntegrationTokens({
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        masterSheetId: spreadsheetId,
        tool: "close",
        tokens: {
          accessToken: activeAccessToken,
          refreshToken: activeRefreshToken,
          expiresIn: 2592000
        },
        metadata: {
          organizationId: accountInfo?.organizationId || "",
          organizationName: accountInfo?.organizationName || effectiveClientName,
          userName: accountInfo?.userName || "",
          userEmail: accountInfo?.userEmail || "",
          importedAt: new Date().toISOString()
        }
      });

      console.log(`✅ Integration Import: Successfully migrated Close CRM for "${effectiveClientName}" [${spreadsheetId}].`);

      return res.status(200).json({
        success: true,
        tool: "close",
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        organizationName: accountInfo?.organizationName || effectiveClientName,
        accessToken: activeAccessToken,
        message: `Successfully imported Close CRM connection into Pulse Central Vault.`
      });
    }

    if (cleanTool === "hubspot") {
      console.log(`📥 Integration Import: Importing existing HubSpot tokens for sheet: ${spreadsheetId}...`);

      const { accessToken: rawAccessToken = "", token = "", apiKey = "", clientId = "", clientSecret = "" } = req.body;
      let activeAccessToken = rawAccessToken || token || apiKey || "";
      let activeRefreshToken = refreshToken || "";

      if (!activeAccessToken && activeRefreshToken) {
        const refreshed = await refreshHubSpotTokens(activeRefreshToken, clientId, clientSecret);
        activeAccessToken = refreshed.accessToken;
        activeRefreshToken = refreshed.refreshToken;
      }

      let accountInfo = null;
      if (activeAccessToken) {
        accountInfo = await getHubSpotAccountInfo(activeAccessToken);
      }

      if (!accountInfo || (!accountInfo.portalId && !accountInfo.hubId)) {
        console.error(`🚨 Integration Import: Rejected HubSpot import for ${spreadsheetId} - credentials could not be verified with HubSpot API.`);
        return res.status(401).json({
          success: false,
          error: "Provided HubSpot credentials could not be verified with HubSpot API. Re-authorization required via PMA > Integrations."
        });
      }

      const effectiveClientKey = clientName || accountInfo?.accountName || spreadsheetId;
      const effectiveClientName = clientName || accountInfo?.accountName || effectiveClientKey;

      await saveIntegrationTokens({
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        masterSheetId: spreadsheetId,
        tool: "hubspot",
        tokens: {
          accessToken: activeAccessToken,
          refreshToken: activeRefreshToken,
          expiresIn: 1800
        },
        metadata: {
          portalId: accountInfo?.portalId || "",
          hubId: accountInfo?.hubId || "",
          accountName: accountInfo?.accountName || effectiveClientName,
          userEmail: accountInfo?.userEmail || "",
          accountType: accountInfo?.accountType || "",
          importedAt: new Date().toISOString()
        }
      });

      console.log(`✅ Integration Import: Successfully migrated HubSpot for "${effectiveClientName}" [${spreadsheetId}].`);

      return res.status(200).json({
        success: true,
        tool: "hubspot",
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        accountName: accountInfo?.accountName || effectiveClientName,
        accessToken: activeAccessToken,
        message: `Successfully imported HubSpot connection into Pulse Central Vault.`
      });
    }

    return res.status(400).json({ success: false, error: `Tool "${tool}" is not supported for import.` });

  } catch (err) {
    console.error("Integration Import failure:", err.message);
    return res.status(400).json({
      success: false,
      error: `Failed to import credentials: ${err.message}`
    });
  }
}
