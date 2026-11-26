import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import {
  verifyUserAuthorizedForSheet,
  unwrapSheetId,
  resolveClientNameBySheetId,
} from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { fetchInvoiceDetailsForClient } from "../../../services/workspaces.js";
import {
  assertTrustedOrigin,
  matchesClientName,
  sanitizeSpreadsheetTerms,
} from "../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const rl = await checkRateLimit(
    "portal-invoice-details",
    sessionUser.email || getTrustedClientIp(req),
    90,
    60
  );
  if (!rl.allowed) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please wait a moment and try again.",
    });
  }

  const {
    clientSheetId: rawClientSheetId,
    masterSheetId: rawMasterSheetId,
    clientName,
    invoiceNo,
    bypassCache = false,
  } = req.body || {};

  const cleanInvNo = String(invoiceNo || "").replace(/^#/, "").trim();
  if (!cleanInvNo || cleanInvNo.length > 120) {
    return res.status(400).json({ success: false, error: "Invalid or missing invoice number." });
  }

  const unwrappedClientId = unwrapSheetId(
    extractSheetIdFromUrl(rawClientSheetId) || String(rawClientSheetId || "").trim()
  );
  if (!unwrappedClientId || unwrappedClientId === "__INVALID_WS_TOKEN__") {
    return res.status(400).json({ success: false, error: "Valid clientSheetId is required." });
  }

  const sheets = await getSheetsClient();
  const auth = await verifyUserAuthorizedForSheet(sessionUser, unwrappedClientId, clientName, sheets);
  if (!auth.authorized) {
    return res.status(auth.status || 403).json({
      success: false,
      error: sessionUser.isAdmin ? auth.error : sanitizeSpreadsheetTerms(auth.error || "Access denied to this client."),
    });
  }

  const verifiedClientName = auth.clientName && auth.clientName !== "Admin"
    ? auth.clientName
    : String(clientName || "").trim();

  const liveGate = await assertClientPortalLive(sessionUser, verifiedClientName, res);
  if (!liveGate.allowed) return;

  const isSysAdmin = Boolean(
    !sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin")
  );

  let verifiedMasterId = "";
  if (rawMasterSheetId) {
    const unwrappedMasterId = unwrapSheetId(
      extractSheetIdFromUrl(rawMasterSheetId) || String(rawMasterSheetId).trim()
    );
    if (!unwrappedMasterId || unwrappedMasterId === "__INVALID_WS_TOKEN__") {
      return res.status(403).json({ success: false, error: "Forbidden: Invalid workspace reference." });
    }
    if (!isSysAdmin) {
      const mAuth = await verifyUserAuthorizedForSheet(sessionUser, unwrappedMasterId, verifiedClientName, sheets);
      if (!mAuth.authorized) {
        return res.status(mAuth.status || 403).json({
          success: false,
          error: sanitizeSpreadsheetTerms(mAuth.error || "Access denied to this client."),
        });
      }
    } else if (verifiedClientName) {
      const mClient = await resolveClientNameBySheetId(sheets, unwrappedMasterId);
      if (!mClient || !matchesClientName(verifiedClientName, mClient)) {
        return res.status(403).json({ success: false, error: "Forbidden: Client identifier mismatch for workspace." });
      }
    }
    verifiedMasterId = unwrappedMasterId;
  }

  try {
    const payload = await fetchInvoiceDetailsForClient({
      sheets,
      masterSheetId: verifiedMasterId,
      clientSheetId: unwrappedClientId,
      clientName: verifiedClientName,
      invoiceNo: cleanInvNo,
      bypassCache: Boolean(bypassCache),
    });
    if (!payload.success) {
      return res.status(payload.status || 400).json({
        success: false,
        error: isSysAdmin ? payload.error : sanitizeSpreadsheetTerms(payload.error || "Failed to load invoice details."),
      });
    }
    return res.status(200).json(payload);
  } catch (err) {
    console.error("❌ /api/portal/invoice-details error:", err);
    const status = err?.statusCode || 500;
    const rawMsg = err?.message || "Failed to load invoice details.";
    return res.status(status).json({
      success: false,
      error: isSysAdmin ? rawMsg : sanitizeSpreadsheetTerms(rawMsg),
    });
  }
}
