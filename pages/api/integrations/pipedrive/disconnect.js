/**
 * ============================================================================
 * PIPEDRIVE DISCONNECT ROUTE: /api/integrations/pipedrive/disconnect
 * ============================================================================
 */

import { getIntegrationTokens, deleteIntegrationTokens } from "../../../../services/vaultService.js";
import { revokePipedriveToken } from "../../../../services/pipedriveService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { clientKey, masterSheetId } = req.body;

  if (!clientKey && !masterSheetId) {
    return res.status(400).json({ error: "Missing required clientKey or masterSheetId parameter." });
  }

  try {
    const record = await getIntegrationTokens({
      clientKey,
      masterSheetId,
      tool: "pipedrive"
    });

    if (record && record.tokens) {
      const tokenToRevoke = record.tokens.refreshToken || record.tokens.accessToken;
      if (tokenToRevoke) {
        await revokePipedriveToken(tokenToRevoke);
      }
    }

    await deleteIntegrationTokens({
      clientKey,
      masterSheetId,
      tool: "pipedrive"
    });

    console.log(`🔌 Pipedrive integration disconnected for client: ${clientKey || masterSheetId}`);

    return res.status(200).json({
      success: true,
      message: "Pipedrive integration disconnected successfully."
    });
  } catch (err) {
    console.error("Pipedrive disconnect error:", err);
    return res.status(500).json({ error: err.message || "Failed to disconnect Pipedrive integration." });
  }
}
