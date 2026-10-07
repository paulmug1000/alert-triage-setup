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

    return res.status(400).json({ success: false, error: `Tool "${tool}" is not supported for import.` });

  } catch (err) {
    console.error("Integration Import failure:", err.message);
    return res.status(400).json({
      success: false,
      error: `Failed to import credentials: ${err.message}`
    });
  }
}
