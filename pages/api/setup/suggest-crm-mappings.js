/**
 * ============================================================================
 * SUGGEST CRM MAPPINGS API: /api/setup/suggest-crm-mappings
 * ============================================================================
 * 
 * GET: Analyzes 100+ sample rows from DataFromCRM!A1:ZZ, matches the 13 Pulse fields,
 *      determines transformation rules, and suggests confirmed job criteria.
 * POST: Applies approved CRM field mappings, format rules, and job definitions
 *       to Master Sheet CRMList!AB2:AN2, CRMList!A2:M2, CRMList!DD2:DH2, CRMList!EE2.
 */

import { getSessionUser } from "../../../services/authService.js";
import { isUserAuthorizedForClient } from "../../../services/userPermissions.js";
import {
  suggestCrmMappings,
  applyCrmMappings
} from "../../../services/crmSuggestionsService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (sessionUser.role === "ClientUser" || sessionUser.role === "Senior (Restricted)" || sessionUser.isClientUser) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  if (req.method === "GET") {
    const { clientName, masterSheetId } = req.query;
    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }

    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }

    try {
      const suggestions = await suggestCrmMappings({ clientName, masterSheetId });
      return res.status(200).json(suggestions);
    } catch (err) {
      console.error("GET /api/setup/suggest-crm-mappings error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    const { clientName, masterSheetId, fieldMappings, jobDefinitions } = req.body || {};
    if (!clientName || !Array.isArray(fieldMappings)) {
      return res.status(400).json({ success: false, error: "Missing required clientName or fieldMappings payload." });
    }

    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }

    try {
      const result = await applyCrmMappings({
        clientName,
        masterSheetId,
        fieldMappings,
        jobDefinitions
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error("POST /api/setup/suggest-crm-mappings error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ success: false, error: `Method ${req.method} not allowed.` });
}
