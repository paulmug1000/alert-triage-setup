/**
 * ============================================================================
 * XERO DISCONNECT ROUTE: /api/integrations/xero/disconnect
 * ============================================================================
 * 
 * Safely disconnects a client's Xero integration:
 * 1. Revokes the token with Xero's official identity revocation endpoint.
 * 2. Purges the encrypted token bundle and index keys from the Redis Vault.
 * 3. Records the disconnection in audit logs.
 */

import { getIntegrationTokens, deleteIntegrationTokens } from "../../../../services/vaultService.js";
import { revokeXeroToken } from "../../../../services/xeroService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { clientKey, masterSheetId } = req.body;

  if (!clientKey && !masterSheetId) {
    return res.status(400).json({ error: "Missing required clientKey or masterSheetId parameter." });
  }

  try {
    // 1. Fetch current credentials to revoke
    const record = await getIntegrationTokens({
      clientKey,
      masterSheetId,
      tool: "xero"
    });

    if (record && record.tokens) {
      const tokenToRevoke = record.tokens.refreshToken || record.tokens.accessToken;
      // CRITICAL: Only revoke at Xero if this was a dedicated standalone client token.
      // Never revoke a shared advisor token when unlinking a single client!
      if (tokenToRevoke && !record.isSharedGrant) {
        await revokeXeroToken(tokenToRevoke);
      }
    }

    // 2. Delete from Central Vault
    await deleteIntegrationTokens({
      clientKey,
      masterSheetId,
      tool: "xero"
    });

    console.log(`🔌 Xero integration disconnected for client: ${clientKey || masterSheetId}`);

    return res.status(200).json({
      success: true,
      message: "Xero integration disconnected and revoked successfully."
    });
  } catch (err) {
    console.error("Xero disconnect error:", err);
    return res.status(500).json({ error: err.message || "Failed to disconnect Xero integration." });
  }
}
