/**
 * ============================================================================
 * INTEGRATIONS STATUS ROUTE: /api/integrations/status
 * ============================================================================
 * 
 * Returns non-sensitive integration health and connection status for a client.
 * Safe to be consumed by client portal and PMA UI views.
 */

import { getIntegrationStatus } from "../../../services/vaultService.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { clientKey, clientName, masterSheetId } = req.query;

  if (!clientKey && !masterSheetId && !clientName) {
    return res.status(400).json({ error: "Missing clientKey, clientName, or masterSheetId parameter." });
  }

  try {
    const tools = ["xero", "quickbooks", "monday", "pipedrive", "clickup"];
    const statuses = {};

    for (const tool of tools) {
      const status = await getIntegrationStatus({
        clientKey: clientKey || clientName,
        masterSheetId,
        tool
      });
      statuses[tool] = status;
    }

    return res.status(200).json({
      success: true,
      integrations: statuses
    });
  } catch (err) {
    console.error("Integrations status query error:", err);
    return res.status(500).json({ error: err.message || "Failed to query integration status." });
  }
}
