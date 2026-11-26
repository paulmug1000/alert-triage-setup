import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  verifyUserAuthorizedForSheet,
  unwrapSheetId,
  isReadOnlySession,
  canViewSalariesAndDividends,
} from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { handleUpdateOutgoingNote } from "../../../services/workspaces.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes } from "../../../services/masterEngineService.js";

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
      error: "Pulse is read-only when logged in with a one-time password.",
    });
  }

  const rl = await checkRateLimit("portal-update-outgoing-note", sessionUser.email || getTrustedClientIp(req), 60, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  const {
    clientSheetId,
    clientName,
    contractorName,
    sheetRow,
    colLetter,
    blocks,
  } = req.body || {};

  if (!clientSheetId || !sheetRow || !colLetter) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  if (blocks !== undefined && (!Array.isArray(blocks) || blocks.length > 200)) {
    return res.status(400).json({ success: false, error: "Invalid contractor expense items payload (max 200)." });
  }

  const parsedRow = parseInt(sheetRow, 10);
  const cleanColLetter = String(colLetter).trim().toUpperCase();
  if (isNaN(parsedRow) || parsedRow < 13 || parsedRow > 238 || !/^[E-Z]$|^A[A-Z]$/.test(cleanColLetter)) {
    return res.status(400).json({ success: false, error: "Invalid entry row or column" });
  }

  if (!canViewSalariesAndDividends(sessionUser) && ((parsedRow >= 115 && parsedRow <= 123) || (parsedRow >= 230 && parsedRow <= 238))) {
    return res.status(403).json({ success: false, error: "Forbidden: Access to salary and dividend entries is restricted." });
  }

  let verifiedClientName = String(clientName || "").trim();
  try {
    const sheets = await getSheetsClient();
    const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error });
    }
    verifiedClientName = auth.clientName;

    const liveGate = await assertClientPortalLive(sessionUser, verifiedClientName, res);
    if (!liveGate.allowed) return;

    const cleanSheetId = unwrapSheetId(clientSheetId) || clientSheetId;
    req.resolvedUser = sessionUser;
    req.body = {
      ...req.body,
      clientSheetId: cleanSheetId,
      clientName: verifiedClientName,
      sheetRow: parsedRow,
      colLetter: cleanColLetter,
    };

    await handleUpdateOutgoingNote(req, res, sheets);

    if (res.statusCode >= 200 && res.statusCode < 300) {
      const itemCount = Array.isArray(blocks) ? blocks.length : 0;
      logPulseActivity(sheets, {
        clientName: verifiedClientName || "Client",
        category: "CONTRACTORS",
        action: "CONTRACTOR_EXPENSE_UPDATED",
        summary: `Updated contractor expense entries${contractorName ? ` for '${String(contractorName).trim()}'` : ""} (${itemCount} item(s))`,
        details: {
          contractorName: contractorName || "",
          itemCount,
          clientName: verifiedClientName,
        },
        user: sessionUser.name || sessionUser.email,
      }).catch(() => {});
    }
    return;
  } catch (err) {
    console.error("❌ /api/portal/update-outgoing-note error:", err);
    if (!res.headersSent) {
      const rawMsg = err.message || "Failed to update contractor expense";
      return res.status(500).json({
        success: false,
        error: sessionUser.isAdmin ? rawMsg : sanitizeSpreadsheetTerms(rawMsg),
      });
    }
  } finally {
    await flushImmediateAndScheduleBackgroundClientRecomputes(null, verifiedClientName || "").catch(() => {});
  }
}
