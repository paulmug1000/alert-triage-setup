/**
 * ============================================================================
 * SETUP DEPLOYMENT URL API: /api/setup/deployment-url
 * ============================================================================
 * 
 * POST: Saves Master Sheet GAS deployment URL to Master KeyInfo!X29 and Column W
 * of Client Version Tracker, marking task p1_gas_deployment as complete.
 */

import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { assertSetupClientSheetBinding, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { saveDeploymentUrl } from "../../../services/setupService.js";
import { assertTrustedOrigin } from "../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }
  installSheetIdBoundary(req, res, sessionUser);

  if (!sessionUser.isAdmin || isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: Admin privileges required." });
  }

  const rl = await checkRateLimit("setup-deployment-url", sessionUser.email || getTrustedClientIp(req), 60, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
  }

  const { clientName, masterSheetId, deploymentUrl } = req.body || {};
  if (!clientName || !deploymentUrl) {
    return res.status(400).json({ success: false, error: "Missing required clientName or deploymentUrl." });
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
    const result = await saveDeploymentUrl(sheets, {
      clientName,
      masterSheetId,
      deploymentUrl,
      userEmail: sessionUser.email
    });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("POST /api/setup/deployment-url error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
