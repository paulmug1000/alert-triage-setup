/**
 * ============================================================================
 * STARTER P&L SETUP API: /api/setup/starter-pl
 * ============================================================================
 *
 * POST: action = "pull_and_analyse" | "push_to_outgoings" | "assign_category_mapping"
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
  pullAndBuildStarterPlData,
  pushStarterPlSetup,
  assignStarterPlCategoryMapping,
} from "../../../services/starterPlService.js";
import { getClientSetupConfig } from "../../../services/setupService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export const config = {
  maxDuration: 120,
  api: {
    bodyParser: {
      sizeLimit: "6mb",
    },
  },
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
    return res.status(403).json({ success: false, error: "Read-only session cannot modify StarterPL setup." });
  }

  const isAdmin = Boolean(!sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin"));
  const {
    clientName,
    masterSheetId,
    action,
    checkedMonthKeys,
    outgoingsMonths,
    expenseItems,
    depreciationItem,
    nonOpIncomeItems,
    nonOpExpenseItems,
    contractors,
    salaryEmployees,
    dividends,
    combineSalariesAsSingleRow,
    categoryName,
    targetSection,
  } = req.body || {};

  if (!clientName) {
    return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
  }

  if (!isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  let resolvedMasterId = masterSheetId;
  if (!resolvedMasterId) {
    const cfg = await getClientSetupConfig({ clientName }).catch(() => null);
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
    if (action === "pull_and_analyse") {
      const data = await pullAndBuildStarterPlData({
        clientName,
        masterSheetId: resolvedMasterId,
      });
      return res.status(200).json({ success: true, ...data });
    }

    if (action === "push_to_outgoings") {
      const result = await pushStarterPlSetup({
        clientName,
        masterSheetId: resolvedMasterId,
        checkedMonthKeys,
        outgoingsMonths,
        expenseItems,
        depreciationItem,
        nonOpIncomeItems,
        nonOpExpenseItems,
        contractors,
        salaryEmployees,
        dividends,
        combineSalariesAsSingleRow,
      });
      return res.status(200).json({ success: true, ...result });
    }

    if (action === "assign_category_mapping") {
      const mapped = await assignStarterPlCategoryMapping({
        clientName,
        masterSheetId: resolvedMasterId,
        categoryName,
        targetSection,
      });
      return res.status(200).json({
        success: true,
        categoryName: mapped.categoryName,
        targetSection: mapped.targetSection,
        sectionLabel: mapped.sectionLabel,
        ...(isAdmin ? { targetBaRow: mapped.targetBaRow } : {}),
      });
    }

    return res.status(400).json({ success: false, error: "Invalid action specified." });
  } catch (err) {
    console.error("POST /api/setup/starter-pl error:", err);
    const msg = isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Failed to process StarterPL setup.");
    return res.status(500).json({ success: false, error: msg });
  }
}
