/**
 * ============================================================================
 * SET ACTIVE TENANT API ROUTE: /api/integrations/set-tenant
 * ============================================================================
 * 
 * Allows PMA administrators to switch the active organisation (tenant)
 * for a client that has multiple connected Xero organisations.
 * Updates both the Vault metadata in Redis and KeyInfo!X2 in the Master Sheet.
 */

import { getIntegrationTokens, saveIntegrationTokens, getSharedXeroGrant, linkClientToSharedXero } from "../../../services/vaultService.js";
import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import { resolveLiveSessionUser, safeCompareSecret, getTrustedClientIp, checkRateLimit } from "../../../services/authService.js";
import { notifyStaffOnClientConnection } from "../../../services/connectionNotifier.js";
import { isReadOnlySession, resolveClientNameBySheetId, isUserAuthorizedForClient } from "../../../services/userPermissions.js";
import { unwrapSheetId } from "../../../services/sheetTokenService.js";
import { assertTrustedOrigin } from "../../../utils/helpers.js";

const XERO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // 1. Verify Authentication
  const authHeader = req.headers.authorization || "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedSecret = tokenMatch ? tokenMatch[1].trim() : (req.body?.secret || "");

  const expectedSecret = process.env.PULSE_INTERNAL_SECRET;
  const isSecretValid = Boolean(expectedSecret && providedSecret && safeCompareSecret(providedSecret, expectedSecret));

  const sessionUser = isSecretValid ? null : await resolveLiveSessionUser(req, res);
  const isAdmin = Boolean(sessionUser?.isAdmin && !isReadOnlySession(sessionUser));

  if (!isSecretValid && !isAdmin) {
    return res.status(401).json({ success: false, error: "Unauthorized: Admin session required." });
  }
  if (!isSecretValid && !assertTrustedOrigin(req, res)) {
    return;
  }

  const rl = await checkRateLimit("int-set-tenant", sessionUser?.email || getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many tenant updates. Please retry shortly." });
  }

  const { clientKey, masterSheetId: rawMasterSheetId, tool = "xero", tenantId, tenantName } = req.body || {};
  const unwrappedMaster = rawMasterSheetId ? unwrapSheetId(String(rawMasterSheetId).trim()) : "";
  const masterSheetId = unwrappedMaster ? (extractSheetIdFromUrl(unwrappedMaster) || unwrappedMaster) : "";

  if (!clientKey && !masterSheetId) {
    return res.status(400).json({ success: false, error: "Missing clientKey or masterSheetId parameter." });
  }

  const cleanTenantId = String(tenantId || "").trim();
  if (!cleanTenantId) {
    return res.status(400).json({ success: false, error: "Missing tenantId parameter." });
  }
  const cleanTool = String(tool || "xero").trim().toLowerCase();
  if (cleanTool === "xero" && !XERO_UUID_RE.test(cleanTenantId)) {
    return res.status(400).json({ success: false, error: "Invalid Xero tenantId format." });
  }

  try {
    let resolvedClientKey = String(clientKey || "").trim();
    if (!resolvedClientKey && masterSheetId) {
      const sheets = await getSheetsClient();
      resolvedClientKey = (await resolveClientNameBySheetId(sheets, masterSheetId)) || "";
    }
    if (sessionUser && !sessionUser.isAdmin && (!resolvedClientKey || !isUserAuthorizedForClient(sessionUser, resolvedClientKey))) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }

    // 2. Load existing token record from Vault
    let record = await getIntegrationTokens({ clientKey: resolvedClientKey, masterSheetId, tool: cleanTool });

    const isTenantAllowed = (availableList) => {
      if (!Array.isArray(availableList) || availableList.length === 0) return true;
      return availableList.some((t) => {
        const id = typeof t === "string" ? t : (t?.tenantId || t?.id || "");
        return String(id).trim().toLowerCase() === cleanTenantId.toLowerCase();
      });
    };

    // If no existing record, check if this is Xero and we have a Central Shared Grant
    if ((!record || !record.tokens) && cleanTool === "xero") {
      const sharedGrant = await getSharedXeroGrant();
      if (sharedGrant && sharedGrant.status === "connected") {
        if (!isTenantAllowed(sharedGrant.availableTenants)) {
          return res.status(403).json({ success: false, error: "Selected tenantId is not available in the authorised Xero grant." });
        }
        await linkClientToSharedXero({
          clientKey: resolvedClientKey,
          clientName: resolvedClientKey,
          masterSheetId,
          tenantId: cleanTenantId,
          tenantName,
          availableTenants: sharedGrant.availableTenants || []
        });

        // Update KeyInfo!X2 in Master Sheet
        if (masterSheetId) {
          try {
            const sheets = await getSheetsClient();
            await withRetry(() =>
              sheets.spreadsheets.values.update({
                spreadsheetId: masterSheetId,
                range: "KeyInfo!X2",
                valueInputOption: "RAW",
                requestBody: { values: [[cleanTenantId]] }
              })
            );
            console.log(`✅ set-tenant: Updated KeyInfo!X2 in Master Sheet [${masterSheetId}] to "${cleanTenantId}" (${tenantName || ''})`);
          } catch (sheetErr) {
            console.warn("⚠️ set-tenant: Note updating KeyInfo!X2:", sheetErr.message);
          }
        }

        notifyStaffOnClientConnection({
          clientName: resolvedClientKey,
          tool: "xero",
          tenantName: tenantName || cleanTenantId,
          masterSheetId,
          mode: "shared"
        }).catch(() => {});

        return res.status(200).json({
          success: true,
          clientKey: resolvedClientKey,
          tool: cleanTool,
          tenantId: cleanTenantId,
          tenantName: tenantName || cleanTenantId,
          isSharedGrant: true,
          message: `Successfully linked ${resolvedClientKey} to shared organisation "${tenantName || cleanTenantId}".`
        });
      }
    }

    if (!record || !record.tokens) {
      return res.status(404).json({ success: false, error: `No active ${cleanTool} connection found for this client.` });
    }

    const availableFromRecord = record.metadata?.availableTenants || record.availableTenants;
    if (cleanTool === "xero" && !isTenantAllowed(availableFromRecord)) {
      return res.status(403).json({ success: false, error: "Selected tenantId is not available for this Xero connection." });
    }

    const effectiveMasterSheetId = masterSheetId || record.masterSheetId;
    const effectiveClientKey = resolvedClientKey || record.clientKey;
    const effectiveClientName = record.clientName || effectiveClientKey;

    // 3. Update Vault metadata
    const updatedMetadata = {
      ...(record.metadata || {}),
      tenantId: cleanTenantId,
      tenantName: tenantName || record.tenantName,
      tenantSwitchedAt: new Date().toISOString()
    };

    if (record.isSharedGrant && cleanTool === "xero") {
      await linkClientToSharedXero({
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        masterSheetId: effectiveMasterSheetId,
        tenantId: cleanTenantId,
        tenantName: tenantName || record.tenantName,
        availableTenants: record.metadata?.availableTenants || []
      });
    } else {
      await saveIntegrationTokens({
        clientKey: effectiveClientKey,
        clientName: effectiveClientName,
        masterSheetId: effectiveMasterSheetId,
        tool: cleanTool,
        tokens: record.tokens,
        metadata: updatedMetadata
      });
    }

    // 4. Update KeyInfo!X2 in Master Sheet
    if (effectiveMasterSheetId && cleanTool === "xero") {
      try {
        const sheets = await getSheetsClient();
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: effectiveMasterSheetId,
            range: "KeyInfo!X2",
            valueInputOption: "RAW",
            requestBody: { values: [[cleanTenantId]] }
          })
        );
        console.log(`✅ set-tenant: Updated KeyInfo!X2 in Master Sheet [${effectiveMasterSheetId}] to "${cleanTenantId}" (${tenantName || ''})`);
      } catch (sheetErr) {
        console.warn("⚠️ set-tenant: Note updating KeyInfo!X2:", sheetErr.message);
      }
    }

    notifyStaffOnClientConnection({
      clientName: effectiveClientName,
      tool: cleanTool,
      tenantName: tenantName || record.tenantName || "",
      masterSheetId: effectiveMasterSheetId
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      clientKey: effectiveClientKey,
      tool: cleanTool,
      tenantId: cleanTenantId,
      tenantName: tenantName || record.tenantName,
      message: `Successfully set active organisation to ${tenantName || cleanTenantId}.`
    });

  } catch (err) {
    console.error("set-tenant handler error:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to update active tenant." });
  }
}
