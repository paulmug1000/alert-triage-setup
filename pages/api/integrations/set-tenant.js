/**
 * ============================================================================
 * SET ACTIVE TENANT API ROUTE: /api/integrations/set-tenant
 * ============================================================================
 * 
 * Allows PMA administrators to switch the active organisation (tenant)
 * for a client that has multiple connected Xero organisations.
 * Updates both the Vault metadata in Redis and KeyInfo!X2 in the Master Sheet.
 */

import { getIntegrationTokens, saveIntegrationTokens } from "../../../services/vaultService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { getSessionUser } from "../../../services/authService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // 1. Verify Authentication
  const authHeader = req.headers.authorization || "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedSecret = tokenMatch ? tokenMatch[1].trim() : (req.body?.secret || "");

  const expectedSecret = process.env.PULSE_INTERNAL_SECRET;
  const isSecretValid = Boolean(expectedSecret && providedSecret && providedSecret === expectedSecret);

  const sessionUser = getSessionUser(req);
  const isAdmin = Boolean(sessionUser?.isAdmin);

  if (!isSecretValid && !isAdmin) {
    return res.status(401).json({ success: false, error: "Unauthorized: Admin session required." });
  }

  const { clientKey, masterSheetId, tool = "xero", tenantId, tenantName } = req.body;

  if (!clientKey && !masterSheetId) {
    return res.status(400).json({ success: false, error: "Missing clientKey or masterSheetId parameter." });
  }

  if (!tenantId) {
    return res.status(400).json({ success: false, error: "Missing tenantId parameter." });
  }

  try {
    // 2. Load existing token record from Vault
    const record = await getIntegrationTokens({ clientKey, masterSheetId, tool });
    if (!record || !record.tokens) {
      return res.status(404).json({ success: false, error: `No active ${tool} connection found for this client.` });
    }

    const effectiveMasterSheetId = masterSheetId || record.masterSheetId;
    const effectiveClientKey = clientKey || record.clientKey;
    const effectiveClientName = record.clientName || effectiveClientKey;

    // 3. Update Vault metadata
    const updatedMetadata = {
      ...(record.metadata || {}),
      tenantId: String(tenantId).trim(),
      tenantName: tenantName || record.tenantName,
      tenantSwitchedAt: new Date().toISOString()
    };

    await saveIntegrationTokens({
      clientKey: effectiveClientKey,
      clientName: effectiveClientName,
      masterSheetId: effectiveMasterSheetId,
      tool,
      tokens: record.tokens,
      metadata: updatedMetadata
    });

    // 4. Update KeyInfo!X2 in Master Sheet
    if (effectiveMasterSheetId && tool === "xero") {
      try {
        const sheets = await getSheetsClient();
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: effectiveMasterSheetId,
            range: "KeyInfo!X2",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[tenantId]] }
          })
        );
        console.log(`✅ set-tenant: Updated KeyInfo!X2 in Master Sheet [${effectiveMasterSheetId}] to "${tenantId}" (${tenantName || ''})`);
      } catch (sheetErr) {
        console.warn("⚠️ set-tenant: Note updating KeyInfo!X2:", sheetErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      clientKey: effectiveClientKey,
      tool,
      tenantId,
      tenantName: tenantName || record.tenantName,
      message: `Successfully set active organisation to ${tenantName || tenantId}.`
    });

  } catch (err) {
    console.error("set-tenant handler error:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to update active tenant." });
  }
}
