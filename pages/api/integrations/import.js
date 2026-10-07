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

import { saveIntegrationTokens } from "../../../services/vaultService.js";
import { refreshXeroTokens, getXeroConnections } from "../../../services/xeroService.js";
import { refreshQBTokens, getQBCompanyInfo } from "../../../services/quickbooksService.js";
import { refreshMondayTokens, getMondayAccountInfo } from "../../../services/mondayService.js";
import { refreshPipedriveTokens, getPipedriveAccountInfo } from "../../../services/pipedriveService.js";
import { getSessionUser } from "../../../services/authService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // 1. Verify Authentication: Ecosystem Secret (for GAS) OR Admin Session (for PMA)
  const authHeader = req.headers.authorization || "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedSecret = tokenMatch ? tokenMatch[1].trim() : (req.body?.secret || "");

  const expectedSecret = process.env.PULSE_INTERNAL_SECRET;
  const isSecretValid = Boolean(expectedSecret && providedSecret && providedSecret === expectedSecret);

  const sessionUser = getSessionUser(req);
  const isAdmin = Boolean(sessionUser?.isAdmin);

  if (!isSecretValid && !isAdmin) {
    console.warn("🚨 Integration Import: Unauthorized attempt.");
    return res.status(401).json({ success: false, error: "Unauthorized: Invalid internal secret or admin session required." });
  }

  const { tool = "xero", spreadsheetId, clientName, refreshToken, tenantId } = req.body;

  if (!spreadsheetId) {
    return res.status(400).json({ success: false, error: "Missing required spreadsheetId parameter." });
  }

  if (!refreshToken) {
    return res.status(400).json({ success: false, error: "Missing required refreshToken parameter." });
  }

  try {
    const cleanTool = String(tool).trim().toLowerCase();

    if (cleanTool === "xero") {
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

    return res.status(400).json({ success: false, error: `Tool "${tool}" is not supported for import.` });

  } catch (err) {
    console.error("Integration Import failure:", err.message);
    return res.status(400).json({
      success: false,
      error: `Failed to import credentials: ${err.message}`
    });
  }
}
