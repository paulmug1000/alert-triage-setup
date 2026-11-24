import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import {
  verifyUserAuthorizedForSheet,
  unwrapSheetId,
  isReadOnlySession,
  getCanonicalAcSheetId,
} from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import {
  batchAssignOrUnassignJobItems,
  moveAccountingItemToJob,
} from "../../../services/accountingCatalogService.js";
import {
  assertTrustedOrigin,
  sanitizeSpreadsheetTerms,
} from "../../../utils/helpers.js";

export const config = {
  maxDuration: 120,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({
      success: false,
      error: "Forbidden: Read-only sessions cannot perform modifications.",
    });
  }

  const rl = await checkRateLimit(
    "portal-assign-items",
    sessionUser.email || getTrustedClientIp(req),
    30,
    60
  );
  if (!rl.allowed) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please wait a moment and try again.",
    });
  }

  const {
    action = "batch_assign",
    clientSheetId: rawClientSheetId,
    clientName,
    itemType = "invoice",
    targetJob = null,
    assignItems = [],
    unassignKeys = [],
    updateJobRevenue = false,
    newJobRevenue,
    updateJobBudget = false,
    newJobBudget,
    itemKey = "",
    sourceType = "auto",
  } = req.body || {};

  if (action !== "batch_assign" && action !== "move") {
    return res.status(400).json({ success: false, error: "Invalid action. Must be 'batch_assign' or 'move'." });
  }
  if (itemType !== "invoice" && itemType !== "directCost") {
    return res.status(400).json({ success: false, error: "Invalid itemType. Must be 'invoice' or 'directCost'." });
  }
  if (!targetJob || typeof targetJob !== "object") {
    return res.status(400).json({ success: false, error: "Missing targetJob." });
  }
  if (action === "batch_assign") {
    const aLen = Array.isArray(assignItems) ? assignItems.length : 0;
    const uLen = Array.isArray(unassignKeys) ? unassignKeys.length : 0;
    if (aLen + uLen > 50) {
      return res.status(400).json({ success: false, error: "Too many items in a single batch (maximum 50)." });
    }
  }

  const unwrapped = unwrapSheetId(
    extractSheetIdFromUrl(rawClientSheetId) || String(rawClientSheetId || "").trim()
  );
  if (!unwrapped || unwrapped === "__INVALID_WS_TOKEN__") {
    return res.status(400).json({ success: false, error: "Valid clientSheetId is required" });
  }

  const sheets = await getSheetsClient();
  const auth = await verifyUserAuthorizedForSheet(sessionUser, unwrapped, clientName, sheets);
  if (!auth.authorized) {
    return res.status(auth.status || 403).json({ success: false, error: auth.error });
  }

  const verifiedClientName = auth.clientName;
  const liveGate = await assertClientPortalLive(sessionUser, verifiedClientName, res);
  if (!liveGate.allowed) return;

  const isSysAdmin = Boolean(
    !sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin")
  );
  const automationCommanderSheetId = getCanonicalAcSheetId();

  try {
    if (action === "move") {
      const result = await moveAccountingItemToJob({
        sheets,
        clientSheetId: unwrapped,
        clientName: verifiedClientName,
        itemType,
        itemKey,
        sourceType,
        targetJob,
        updateJobRevenue: Boolean(updateJobRevenue),
        newJobRevenue,
        updateJobBudget: Boolean(updateJobBudget),
        newJobBudget,
        userEmail: sessionUser.email || "Portal User",
        automationCommanderSheetId,
        isSysAdmin,
      });
      return res.status(200).json(result);
    }

    const result = await batchAssignOrUnassignJobItems({
      sheets,
      clientSheetId: unwrapped,
      clientName: verifiedClientName,
      itemType,
      targetJob,
      assignItems: Array.isArray(assignItems) ? assignItems : [],
      unassignKeys: Array.isArray(unassignKeys) ? unassignKeys : [],
      updateJobRevenue: Boolean(updateJobRevenue),
      newJobRevenue,
      updateJobBudget: Boolean(updateJobBudget),
      newJobBudget,
      userEmail: sessionUser.email || "Portal User",
      automationCommanderSheetId,
      isSysAdmin,
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error(`❌ /api/portal/assign-job-items (${action}) error:`, err);
    const status = err?.statusCode || 500;
    const rawMsg = err?.message || "Failed to update job items.";
    return res.status(status).json({
      success: false,
      error: isSysAdmin ? rawMsg : sanitizeSpreadsheetTerms(rawMsg),
    });
  }
}
