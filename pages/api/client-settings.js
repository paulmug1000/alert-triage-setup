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
  getClientSettings,
  saveClientSettings,
  testCrmMappingsAndGetPreview,
  fetchCrmStatusesFromSheet,
  fetchCrmProductLinesFromSheet,
  fetchCrmLeadSourcesFromSheet,
  refreshChartOfAccountsService,
  pullFreshPlCategoriesService
} from "../../services/clientSettingsService.js";

export default async function handler(req, res) {
  // 1. Authenticate user
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  // 2. Strict Admin-only check
  const isAdmin = Boolean(sessionUser.isAdmin || sessionUser.role === "Admin");
  if (!isAdmin) {
    return res.status(403).json({
      success: false,
      error: "Access denied: Client settings configuration is strictly restricted to Admins."
    });
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

      return res.status(200).json({ success: true, settings: data });
    } catch (err) {
      console.error("GET /api/client-settings error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // 4. POST: Save settings or test CRM mappings
  if (req.method === "POST") {
    const {
      clientName,
      masterSheetId,
      clientSheetId,
      settings,
      resetKpiToParent,
      action
    } = req.body;

    if (!clientName || !masterSheetId || !settings) {
      return res.status(400).json({
        success: false,
        error: "Missing required clientName, masterSheetId, or settings payload."
      });
    }

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
  }

  return res.status(405).json({ success: false, error: "Method not allowed." });
}
