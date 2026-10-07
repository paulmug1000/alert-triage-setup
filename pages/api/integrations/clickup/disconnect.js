/**
 * ============================================================================
 * CLICKUP DISCONNECT ROUTE: /api/integrations/clickup/disconnect
 * ============================================================================
 */

import { deleteIntegrationTokens } from "../../../../services/vaultService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { clientKey, masterSheetId } = req.body;

  if (!clientKey && !masterSheetId) {
    return res.status(400).json({ error: "Missing required clientKey or masterSheetId parameter." });
  }

  try {
    await deleteIntegrationTokens({
      clientKey,
      masterSheetId,
      tool: "clickup"
    });

    console.log(`🔌 ClickUp integration disconnected for client: ${clientKey || masterSheetId}`);

    return res.status(200).json({
      success: true,
      message: "ClickUp integration disconnected successfully."
    });
  } catch (err) {
    console.error("ClickUp disconnect error:", err);
    return res.status(500).json({ error: err.message || "Failed to disconnect ClickUp integration." });
  }
}
