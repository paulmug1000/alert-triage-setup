/**
 * ============================================================================
 * CREATE BUDGET SETUP API: /api/setup/budget
 * ============================================================================
 *
 * POST: action = "load_seeded_budget" | "save_budget"
 */

import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import {
  isUserAuthorizedForClient,
  assertSetupClientSheetBinding,
  canAccessPma,
  isReadOnlySession,
} from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  pullBudgetSetupData,
  saveBudgetSetupData,
} from "../../../services/budgetSetupService.js";
import { getClientSetupConfig } from "../../../services/setupService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export const config = {
  maxDuration: 120,
  api: {
    bodyParser: {
      sizeLimit: "4mb",
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
    return res.status(403).json({ success: false, error: "Read-only session cannot modify Budget setup." });
  }

  const rl = await checkRateLimit("setup-budget", sessionUser.email || getTrustedClientIp(req), 20, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  const isAdmin = Boolean(!sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin"));
  const {
    clientName,
    masterSheetId,
    action,
    fy1Months,
    historicalMonthKeys,
    revenueRows,
    directCostRows,
    salaryRows,
    dividendRow,
    contractorRows,
    makingUpCosPct,
    expenseRows,
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

  const sheets = await getSheetsClient();
  const binding = await assertSetupClientSheetBinding(sessionUser, {
    clientName,
    masterSheetId: resolvedMasterId,
    sheets,
  });
  if (!binding.authorized) {
    return res.status(binding.status || 403).json({ success: false, error: binding.error || "Access denied to this client." });
  }

  try {
    if (action === "load_seeded_budget") {
      const data = await pullBudgetSetupData({
        clientName,
        masterSheetId: resolvedMasterId,
      });
      const safeData = isAdmin
        ? data
        : {
            ...data,
            fy1Months: Array.isArray(data?.fy1Months)
              ? data.fy1Months.map(({ col0, colLetter, ...rest }) => rest)
              : data?.fy1Months,
          };
      return res.status(200).json({ success: true, ...safeData });
    }

    if (action === "save_budget") {
      const result = await saveBudgetSetupData({
        clientName,
        masterSheetId: resolvedMasterId,
        fy1Months,
        historicalMonthKeys,
        revenueRows,
        directCostRows,
        salaryRows,
        dividendRow,
        contractorRows,
        makingUpCosPct,
        expenseRows,
      });
      return res.status(200).json({ success: true, ...result });
    }

    return res.status(400).json({ success: false, error: "Invalid action specified." });
  } catch (err) {
    console.error("POST /api/setup/budget error:", err);
    const msg = isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Failed to process budget setup.");
    return res.status(500).json({ success: false, error: msg });
  }
}
