import { waitUntil } from "@vercel/functions";
import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import {
  verifyUserAuthorizedForSheet,
  unwrapSheetId,
  isReadOnlySession,
  canViewSalariesAndDividends,
} from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";
import {
  getClientNoteSummaries,
  listClientNotes,
  createPulseNote,
  addPulseNoteReply,
  setPulseNoteStatus,
  editPulseNote,
  deletePulseNote,
  markNoteRepliesRead,
} from "../../../services/pulseNotesService.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (req.method === "POST" && !assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const rawClientSheetId = String(req.query.clientSheetId || req.body?.clientSheetId || "").trim();
  const clientName = String(req.query.clientName || req.body?.clientName || "").trim();
  if (!rawClientSheetId) {
    return res.status(400).json({ success: false, error: "clientSheetId is required" });
  }

  const clientSheetId = unwrapSheetId(extractSheetIdFromUrl(rawClientSheetId) || rawClientSheetId);
  if (!clientSheetId || clientSheetId === "__INVALID_WS_TOKEN__") {
    return res.status(400).json({ success: false, error: "Invalid clientSheetId" });
  }

  const isGet = req.method === "GET";
  const action = isGet ? String(req.query.mode || "list") : String(req.body?.action || "");
  const isNotifyAction =
    !isGet &&
    ((action === "create" && Boolean(req.body?.notifyManager)) || action === "reply");

  const rlBucket = isGet ? "portal-notes-read" : isNotifyAction ? "portal-notes-notify" : "portal-notes-write";
  const rlMax = isGet ? 120 : isNotifyAction ? 15 : 40;

  if (!isGet && isReadOnlySession(sessionUser)) {
    return res.status(403).json({
      success: false,
      error: "Pulse is read-only when signed in with a one-time password.",
    });
  }

  try {
    const [rl, initialAuth] = await Promise.all([
      checkRateLimit(rlBucket, sessionUser.email || getTrustedClientIp(req), rlMax, 60),
      verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, null),
    ]);
    if (!rl.allowed) {
      return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
    }
    let auth = initialAuth;
    if (!auth.authorized && auth.status === 403) {
      const sheets = await getSheetsClient().catch(() => null);
      if (sheets) {
        auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
      }
    }
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error });
    }
    const verifiedClientName = auth.clientName || clientName;
    const liveGate = await assertClientPortalLive(sessionUser, verifiedClientName, res);
    if (!liveGate.allowed) return;

    const includeRestricted = canViewSalariesAndDividends(sessionUser);
    const scheduleBg = typeof waitUntil === "function" ? (p) => waitUntil(p) : null;

    if (isGet) {
      const mode = String(req.query.mode || "list").toLowerCase();
      if (mode === "summary") {
        const summary = await getClientNoteSummaries({
          clientName: verifiedClientName,
          includeRestricted,
        });
        return res.status(200).json({ success: true, ...summary });
      }

      const entityKey = String(req.query.entityKey || "").trim();
      const parentEntityKey = String(req.query.parentEntityKey || "").trim();
      const entityType = String(req.query.entityType || "").trim();
      const noteId = String(req.query.noteId || "").trim();
      const filter = String(req.query.filter || "all").trim();
      const includeChildren = req.query.includeChildren === "true";

      const result = await listClientNotes({
        clientName: verifiedClientName,
        entityKey,
        parentEntityKey,
        includeChildren,
        entityType,
        noteId,
        filter,
        includeRestricted,
      });
      return res.status(200).json({ success: true, ...result });
    }

    // POST mutations
    if (action === "create") {
      const {
        scopeType,
        entityType,
        entityKey,
        parentEntityKey,
        entityLabel,
        contextMeta,
        body,
        notifyManager,
      } = req.body || {};
      const result = await createPulseNote({
        sessionUser,
        clientName: verifiedClientName,
        scopeType,
        entityType,
        entityKey,
        parentEntityKey,
        entityLabel,
        contextMeta,
        body,
        notifyManager: Boolean(notifyManager),
        scheduleBg,
      });
      return res.status(200).json({ success: true, ...result });
    }

    if (action === "reply") {
      const { noteId, body } = req.body || {};
      const result = await addPulseNoteReply({
        sessionUser,
        noteId,
        body,
        scheduleBg,
      });
      return res.status(200).json({ success: true, ...result });
    }

    if (action === "resolve" || action === "reopen") {
      const { noteId } = req.body || {};
      const result = await setPulseNoteStatus({
        sessionUser,
        noteId,
        status: action === "resolve" ? "resolved" : "open",
        scheduleBg,
      });
      return res.status(200).json({ success: true, ...result });
    }

    if (action === "edit") {
      const { noteId, body } = req.body || {};
      const result = await editPulseNote({ sessionUser, noteId, body });
      return res.status(200).json({ success: true, ...result });
    }

    if (action === "delete") {
      const { noteId } = req.body || {};
      const result = await deletePulseNote({ sessionUser, noteId });
      return res.status(200).json({ success: true, ...result });
    }

    if (action === "mark_read") {
      const { noteIds } = req.body || {};
      const result = await markNoteRepliesRead({
        sessionUser,
        clientName: verifiedClientName,
        noteIds: Array.isArray(noteIds) ? noteIds : [],
      });
      return res.status(200).json({ success: true, ...result });
    }

    return res.status(400).json({ success: false, error: "Unsupported notes action" });
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    const msg = sessionUser?.isAdmin
      ? err.message
      : statusCode === 503
        ? "Notes are temporarily unavailable. Please try again shortly."
        : sanitizeSpreadsheetTerms(err.message || "Notes request failed.");
    return res.status(statusCode).json({ success: false, error: msg });
  }
}
