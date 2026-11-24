import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import {
  verifyUserAuthorizedForSheet,
  unwrapSheetId,
  isReadOnlySession,
} from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import {
  getAccountingCatalog,
  refreshAccountingCatalogSource,
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

  const {
    action = "get",
    clientSheetId: rawClientSheetId,
    clientName,
    itemType = "invoice",
    lookbackMonths = 3,
    targetJob = null,
    force = false,
  } = req.body || {};

  if (action !== "get" && action !== "refresh") {
    return res.status(400).json({ success: false, error: "Invalid action. Must be 'get' or 'refresh'." });
  }
  if (itemType !== "invoice" && itemType !== "directCost") {
    return res.status(400).json({ success: false, error: "Invalid itemType. Must be 'invoice' or 'directCost'." });
  }

  const rlMax = action === "refresh" ? 20 : 60;
  const rl = await checkRateLimit(
    `portal-acct-catalog-${action}`,
    sessionUser.email || getTrustedClientIp(req),
    rlMax,
    60
  );
  if (!rl.allowed) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please wait a moment and try again.",
    });
  }

  if (action === "refresh" && isReadOnlySession(sessionUser)) {
    return res.status(403).json({
      success: false,
      error: "Forbidden: Read-only sessions cannot refresh accounting feeds.",
    });
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

  try {
    if (action === "refresh") {
      const result = await refreshAccountingCatalogSource({
        sheets,
        clientSheetId: unwrapped,
        clientName: verifiedClientName,
        itemType,
        force: Boolean(force),
        userEmail: sessionUser.email || "Portal User",
      });
      return res.status(200).json(result);
    }

    const catalog = await getAccountingCatalog({
      sheets,
      clientSheetId: unwrapped,
      clientName: verifiedClientName,
      itemType,
      lookbackMonths,
      targetJob,
    });
    return res.status(200).json(catalog);
  } catch (err) {
    console.error(`❌ /api/portal/accounting-catalog (${action}) error:`, err);
    const status = err?.statusCode || 500;
    const rawMsg = err?.message || "Failed to load accounting catalog.";
    return res.status(status).json({
      success: false,
      error: isSysAdmin ? rawMsg : sanitizeSpreadsheetTerms(rawMsg),
    });
  }
}
