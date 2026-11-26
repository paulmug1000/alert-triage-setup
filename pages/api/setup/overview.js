/**
 * ============================================================================
 * SETUP OVERVIEW API: /api/setup/overview
 * ============================================================================
 * 
 * Returns setup status and progress for all clients the user has access to.
 */

import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { canAccessPma } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { getAllClientsSetupOverview } from "../../../services/setupService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method === "POST" && !assertTrustedOrigin(req, res)) return;
  const sessionUser = await resolveLiveSessionUser(req, res);
  installSheetIdBoundary(req, res, sessionUser);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const rl = await checkRateLimit("setup-overview", sessionUser.email || getTrustedClientIp(req), 120, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
  }

  try {
    const rawClients = req.body?.allOutgoingsClients;
    if (Array.isArray(rawClients) && rawClients.length > 500) {
      return res.status(400).json({ success: false, error: "Client filter list exceeds maximum limit (500)." });
    }
    const sheets = await getSheetsClient();
    const allOutgoingsClients = Array.isArray(rawClients) ? rawClients : [];
    const overview = await getAllClientsSetupOverview(sheets, sessionUser, allOutgoingsClients);
    return res.status(200).json({ success: true, clients: overview });
  } catch (err) {
    console.error("GET /api/setup/overview error:", err);
    return res.status(500).json({ success: false, error: sessionUser.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
  }
}
