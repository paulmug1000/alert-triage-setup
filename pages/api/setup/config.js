/**
 * ============================================================================
 * SETUP CONFIG API: /api/setup/config
 * ============================================================================
 * 
 * GET: Retrieves setup configuration, tool choices, and live connection status.
 * POST: Saves setup configuration, toggles setup mode, and updates KeyInfo Q4/Q8/Q9.
 * 
 * Access restricted to Admins and assigned ClientManagers.
 */

import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { assertSetupClientSheetBinding, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { getClientSetupConfig, saveClientSetupConfig } from "../../../services/setupService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export default async function handler(req, res) {
  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }
  installSheetIdBoundary(req, res, sessionUser);

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  const rl = await checkRateLimit("setup-config", sessionUser.email || getTrustedClientIp(req), 120, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
  }

  if (req.method === "GET") {
    const { clientName, masterSheetId } = req.query;
    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }

    try {
      const sheets = await getSheetsClient();
      const bindAuth = await assertSetupClientSheetBinding(sessionUser, {
        clientName,
        masterSheetId: masterSheetId || "",
        sheets,
      });
      if (!bindAuth.authorized) {
        return res.status(bindAuth.status || 403).json({ success: false, error: bindAuth.error || "Access denied to this client." });
      }
    } catch (_) {
      return res.status(403).json({ success: false, error: "Access denied to this spreadsheet." });
    }

    try {
      const config = await getClientSetupConfig({ clientName, masterSheetId });
      if (!sessionUser.isAdmin && config && typeof config === "object") {
        if (config.integrations?.xero) {
          delete config.integrations.xero.availableTenants;
          if (config.integrations.xero.metadata) {
            delete config.integrations.xero.metadata.availableTenants;
          }
        }
        if (config.accountingStatus) {
          delete config.accountingStatus.availableTenants;
          if (config.accountingStatus.metadata) {
            delete config.accountingStatus.metadata.availableTenants;
          }
        }
      }
      return res.status(200).json({ success: true, config });
    } catch (err) {
      console.error("GET /api/setup/config error:", err);
      return res.status(500).json({ success: false, error: sessionUser.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
    }
  }

  if (req.method === "POST") {
    if (!assertTrustedOrigin(req, res)) return;
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify setup configuration." });
    }
    const {
      clientName,
      masterSheetId,
      setupMode,
      pulseLive,
      requestConnections,
      accountingTool,
      crmTool,
      crmDrives
    } = req.body || {};

    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }

    try {
      const sheets = await getSheetsClient();
      const bindAuth = await assertSetupClientSheetBinding(sessionUser, {
        clientName,
        masterSheetId: masterSheetId || "",
        sheets,
      });
      if (!bindAuth.authorized) {
        return res.status(bindAuth.status || 403).json({ success: false, error: bindAuth.error || "Access denied to modify this client." });
      }
    } catch (_) {
      return res.status(403).json({ success: false, error: "Access denied to this spreadsheet." });
    }

    try {
      const updatedConfig = await saveClientSetupConfig({
        clientName,
        masterSheetId,
        setupMode,
        pulseLive,
        requestConnections,
        accountingTool,
        crmTool,
        crmDrives,
        updatedBy: sessionUser.name || sessionUser.email
      });
      if (!sessionUser.isAdmin && updatedConfig && typeof updatedConfig === "object") {
        if (updatedConfig.integrations?.xero) {
          delete updatedConfig.integrations.xero.availableTenants;
          if (updatedConfig.integrations.xero.metadata) {
            delete updatedConfig.integrations.xero.metadata.availableTenants;
          }
        }
        if (updatedConfig.accountingStatus) {
          delete updatedConfig.accountingStatus.availableTenants;
          if (updatedConfig.accountingStatus.metadata) {
            delete updatedConfig.accountingStatus.metadata.availableTenants;
          }
        }
      }

      return res.status(200).json({ success: true, config: updatedConfig });
    } catch (err) {
      console.error("POST /api/setup/config error:", err);
      return res.status(500).json({ success: false, error: sessionUser.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
