/**
 * ============================================================================
 * INITIAL INVOICES SETUP API: /api/setup/initial-invoices
 * ============================================================================
 *
 * POST actions:
 * - "import_and_analyse": Imports 12 months of sales invoices leading up to
 *   KeyInfo!B2 and detects recurring retainer candidates.
 * - "create_retainers": Creates confirmed Retainer jobs on Confirmed ("Retainer (Mmm-yy-)",
 *   start >= B2 - 3m, end = "No end date") with relevant invoices on child rows.
 * - "create_remaining_jobs": Creates one Project job per remaining invoice dated >= B2 - 3m.
 */

import { resolveLiveSessionUser } from "../../../services/authService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import {
  isUserAuthorizedForClient,
  verifyUserAuthorizedForSheet,
  canAccessPma,
  isReadOnlySession,
} from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  importAndAnalyseInitialInvoices,
  createInitialRetainerJobs,
  createInitialProjectJobs,
} from "../../../services/initialInvoicesService.js";
import { getClientSetupConfig } from "../../../services/setupService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export const config = {
  maxDuration: 120,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  installSheetIdBoundary(req, res, sessionUser);

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  if (!assertTrustedOrigin(req)) {
    return res.status(403).json({ success: false, error: "Untrusted request origin." });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Read-only session cannot perform initial invoice setup." });
  }

  const isAdmin = Boolean(sessionUser.isAdmin || sessionUser.role === "Admin");
  const { clientName, masterSheetId, action, retainers, invoices } = req.body || {};

  if (!clientName) {
    return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
  }

  if (!isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  let resolvedMasterId = masterSheetId;
  if (!resolvedMasterId) {
    const cfg = await getClientSetupConfig(clientName).catch(() => null);
    resolvedMasterId = cfg?.masterSheetId || "";
  }
  if (!resolvedMasterId) {
    return res.status(400).json({ success: false, error: "No Master workspace configured for this client." });
  }

  if (!isAdmin) {
    const sheets = await getSheetsClient();
    const auth = await verifyUserAuthorizedForSheet(sessionUser, resolvedMasterId, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
    }
  }

  try {
    if (action === "import_and_analyse") {
      const result = await importAndAnalyseInitialInvoices({
        clientName,
        masterSheetId: resolvedMasterId,
      });
      return res.status(200).json({ success: true, ...result });
    }

    if (action === "create_retainers") {
      const result = await createInitialRetainerJobs({
        clientName,
        masterSheetId: resolvedMasterId,
        retainers: Array.isArray(retainers) ? retainers : [],
      });
      return res.status(200).json({ success: true, ...result });
    }

    if (action === "create_remaining_jobs") {
      const result = await createInitialProjectJobs({
        clientName,
        masterSheetId: resolvedMasterId,
        invoices: Array.isArray(invoices) ? invoices : [],
      });
      return res.status(200).json({ success: true, ...result });
    }

    return res.status(400).json({ success: false, error: "Invalid action specified." });
  } catch (err) {
    console.error("POST /api/setup/initial-invoices error:", err);
    const msg = isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Initial invoice setup failed.");
    return res.status(500).json({ success: false, error: msg });
  }
}
