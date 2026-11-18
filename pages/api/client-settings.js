/**
 * ============================================================================
 * CLIENT SETTINGS API: /api/client-settings
 * ============================================================================
 * 
 * GET: Retrieves complete client settings from Redis or Google Sheets.
 * POST: Saves modified settings to Google Sheets (Master and Client) and updates Redis.
 * 
 * Strict Admin-only access.
 */

import { getSessionUser } from "../../services/authService.js";
import {
  canAccessPma,
  isUserAuthorizedForClient,
  isReadOnlySession,
  verifyUserAuthorizedForSheet
} from "../../services/userPermissions.js";
import { getSheetsClient } from "../../services/sheetsClient.js";
import { installSheetIdBoundary } from "../../services/sheetTokenService.js";
import { assertTrustedOrigin } from "../../utils/helpers.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes } from "../../services/masterEngineService.js";
import {
  getClientSettings,
  saveClientSettings,
  testCrmMappingsAndGetPreview,
  fetchCrmStatusesFromSheet,
  fetchCrmProductLinesFromSheet,
  fetchCrmLeadSourcesFromSheet,
  refreshChartOfAccountsService,
  pullFreshPlCategoriesService,
  pullCrmDataService
} from "../../services/clientSettingsService.js";

export const config = {
  maxDuration: 300,
};

export default async function handler(req, res) {
  // 1. Authenticate user
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  installSheetIdBoundary(req, res, sessionUser);

  // 2. Staff authorization check (Admin or ClientManager)
  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({
      success: false,
      error: "Access denied: PMA configuration requires staff privileges."
    });
  }

  // 3. Multi-tenant client authorization check
  const targetClient = req.method === "GET" ? req.query.clientName : req.body?.clientName;
  const reqMasterSheetId = req.method === "GET" ? req.query.masterSheetId : req.body?.masterSheetId;
  const reqClientSheetId = req.method === "GET" ? req.query.clientSheetId : req.body?.clientSheetId;
  if (!sessionUser.isAdmin) {
    if (!isUserAuthorizedForClient(sessionUser, targetClient)) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: Access denied to this client."
      });
    }
    const sheets = await getSheetsClient();
    for (const sId of [reqMasterSheetId, reqClientSheetId].filter(Boolean)) {
      const sheetAuth = await verifyUserAuthorizedForSheet(sessionUser, sId, targetClient, sheets);
      if (!sheetAuth.authorized) {
        return res.status(sheetAuth.status || 403).json({
          success: false,
          error: sheetAuth.error || "Forbidden: Spreadsheet access denied for this client."
        });
      }
    }
  }

  // 3. GET: Fetch settings
  if (req.method === "GET") {
    const { clientName, masterSheetId, clientSheetId, bypassCache } = req.query;

    if (!clientName || !masterSheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing required clientName or masterSheetId parameter."
      });
    }

    try {
      const data = await getClientSettings({
        clientName,
        masterSheetId,
        clientSheetId,
        bypassCache: bypassCache === "true" || bypassCache === true
      });

      if (!sessionUser.isAdmin && data && typeof data === "object") {
        const safeSettings = { ...data };
        delete safeSettings.main;
        delete safeSettings.automation;
        if (safeSettings.accounting && typeof safeSettings.accounting === "object") {
          const safeAccounting = { ...safeSettings.accounting };
          delete safeAccounting.expenseStatusMapping;
          safeSettings.accounting = safeAccounting;
        }
        if (safeSettings.customisation?.kpiColouring && typeof safeSettings.customisation.kpiColouring === "object") {
          const safeKpi = { ...safeSettings.customisation.kpiColouring };
          delete safeKpi.parentTemplateUrl;
          safeSettings.customisation = { ...safeSettings.customisation, kpiColouring: safeKpi };
        }
        return res.status(200).json({ success: true, settings: safeSettings });
      }

      return res.status(200).json({ success: true, settings: data });
    } catch (err) {
      console.error("GET /api/client-settings error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // 4. POST: Save settings or test CRM mappings
  if (req.method === "POST") {
    if (!assertTrustedOrigin(req, res)) return;
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: Read-only session cannot modify settings."
      });
    }

    const {
      clientName,
      masterSheetId,
      clientSheetId,
      settings,
      resetKpiToParent,
      action
    } = req.body;

    if (!clientName || !masterSheetId || (!settings && !action)) {
      return res.status(400).json({
        success: false,
        error: "Missing required clientName, masterSheetId, or settings payload."
      });
    }

    // Strip admin-only sections for non-admins to prevent unauthorized modifications
    if (!sessionUser.isAdmin && settings) {
      delete settings.main;
      delete settings.automation;
      if (settings.accounting) {
        delete settings.accounting.expenseStatusMapping;
      }
    }

    try {
      // Handle Option B: Test CRM mappings and refresh preview
      if (action === "test_crm_mappings") {
      try {
        const previewResult = await testCrmMappingsAndGetPreview({
          clientName,
          masterSheetId,
          clientSheetId,
          settings
        });

        return res.status(200).json(previewResult);
      } catch (err) {
        console.error("POST /api/client-settings (test_crm_mappings) error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    // Handle Check CRM data for statuses from CRMList
    if (action === "fetch_crm_statuses") {
      try {
        const statuses = await fetchCrmStatusesFromSheet({ masterSheetId });
        return res.status(200).json({ success: true, statuses });
      } catch (err) {
        console.error("POST /api/client-settings (fetch_crm_statuses) error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    // Handle Check CRM data for product lines
    if (action === "fetch_crm_product_lines") {
      try {
        const productLines = await fetchCrmProductLinesFromSheet({ masterSheetId });
        return res.status(200).json({ success: true, productLines });
      } catch (err) {
        console.error("POST /api/client-settings (fetch_crm_product_lines) error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    // Handle Check CRM data for lead sources
    if (action === "fetch_crm_lead_sources") {
      try {
        const leadSources = await fetchCrmLeadSourcesFromSheet({ masterSheetId });
        return res.status(200).json({ success: true, leadSources });
      } catch (err) {
        console.error("POST /api/client-settings (fetch_crm_lead_sources) error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    // Handle Fetch updated chart of accounts
    if (action === "refresh_chart_of_accounts") {
      try {
        const result = await refreshChartOfAccountsService({ clientName, masterSheetId });
        return res.status(200).json(result);
      } catch (err) {
        console.error("POST /api/client-settings (refresh_chart_of_accounts) error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    // Handle Pull updated P&L
    if (action === "pull_fresh_pl") {
      try {
        const result = await pullFreshPlCategoriesService({ clientName, masterSheetId });
        return res.status(200).json(result);
      } catch (err) {
        console.error("POST /api/client-settings (pull_fresh_pl) error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    // Handle Pull CRM data
    if (action === "pull_crm_data") {
      try {
        const result = await pullCrmDataService({
          clientName,
          masterSheetId,
          userEmail: sessionUser.email || "Admin"
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("POST /api/client-settings (pull_crm_data) error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    try {
      const result = await saveClientSettings({
        clientName,
        masterSheetId,
        clientSheetId,
        settings,
        resetKpiToParent: Boolean(resetKpiToParent)
      });

      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error("POST /api/client-settings error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
    } finally {
      await flushImmediateAndScheduleBackgroundClientRecomputes().catch(() => {});
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed." });
}
