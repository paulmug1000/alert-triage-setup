/**
 * ============================================================================
 * QUICKBOOKS DISCONNECT ROUTE: /api/integrations/quickbooks/disconnect
 * ============================================================================
 * 
 * Safely disconnects a client's QuickBooks integration:
 * 1. Revokes the token with Intuit's official revocation endpoint.
 * 2. Purges the encrypted token bundle and index keys from the Redis Vault.
 * 3. Records the disconnection in audit logs.
 */

import { getIntegrationTokens, deleteIntegrationTokens } from "../../../../services/vaultService.js";
import { revokeQBToken } from "../../../../services/quickbooksService.js";
import { getSessionUser } from "../../../../services/authService.js";
import { getSheetsClient } from "../../../../services/sheetsClient.js";
import { isUserAuthorizedForClient, isReadOnlySession, verifyUserAuthorizedForSheet, matchesClientName } from "../../../../services/userPermissions.js";
import { assertTrustedOrigin } from "../../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ error: "Active session required." });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ error: "Read-only session cannot disconnect integrations." });
  }

  const { clientKey, clientName, masterSheetId } = req.body || {};

  if (!clientKey && !masterSheetId && !clientName) {
    return res.status(400).json({ error: "Missing required clientKey, clientName, or masterSheetId parameter." });
  }

  if (clientKey && clientName && !matchesClientName(clientKey, clientName)) {
    return res.status(403).json({ error: "Access denied: Mismatched clientKey and clientName." });
  }

  const targetClient = clientName || clientKey;
  if (!sessionUser.isAdmin) {
    if (targetClient && !isUserAuthorizedForClient(sessionUser, targetClient)) {
      return res.status(403).json({ error: "Access denied to this client." });
    }
    if (clientKey && !isUserAuthorizedForClient(sessionUser, clientKey)) {
      return res.status(403).json({ error: "Access denied to this client." });
    }
    if (masterSheetId) {
      const sheets = await getSheetsClient();
      const sheetAuth = await verifyUserAuthorizedForSheet(sheets, sessionUser, masterSheetId, targetClient || "");
      if (!sheetAuth.authorized) {
        return res.status(403).json({ error: "Access denied to this client." });
      }
    }
  }

  try {
    // 1. Fetch current credentials to revoke
    const record = await getIntegrationTokens({
      clientKey,
      masterSheetId,
      tool: "quickbooks"
    });

    if (record && record.tokens) {
      const tokenToRevoke = record.tokens.refreshToken || record.tokens.accessToken;
      if (tokenToRevoke) {
        await revokeQBToken(tokenToRevoke);
      }
    }

    // 2. Delete from Central Vault
    await deleteIntegrationTokens({
      clientKey,
      masterSheetId,
      tool: "quickbooks"
    });

    console.log(`🔌 QuickBooks integration disconnected for client: ${clientKey || masterSheetId}`);

    return res.status(200).json({
      success: true,
      message: "QuickBooks integration disconnected and revoked successfully."
    });
  } catch (err) {
    console.error("QuickBooks disconnect error:", err);
    return res.status(500).json({ error: err.message || "Failed to disconnect QuickBooks integration." });
  }
}
