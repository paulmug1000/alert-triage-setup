import { waitUntil } from "@vercel/functions";
import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import {
  canAccessPma,
  isReadOnlySession,
  isUserAuthorizedForClient,
  canViewSalariesAndDividends,
} from "../../../services/userPermissions.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";
import {
  listPmaNotes,
  listClientNotes,
  getPmaOpenNotesCount,
  getClientNoteSummaries,
  createPulseNote,
  addPulseNoteReply,
  setPulseNoteStatus,
  editPulseNote,
  deletePulseNote,
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
  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA staff role required" });
  }
  if (req.method === "POST" && isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Session is read-only" });
  }

  const isGet = req.method === "GET";
  const rl = await checkRateLimit(
    isGet ? "pma-notes-read" : "pma-notes-write",
    sessionUser.email || getTrustedClientIp(req),
    isGet ? 120 : 45,
    60
  );
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  try {
    const scheduleBg = typeof waitUntil === "function" ? (p) => waitUntil(p) : null;

    if (isGet) {
      const mode = String(req.query.mode || "list").toLowerCase();
      const clientName = String(req.query.clientName || "").trim();

      if (clientName && !isUserAuthorizedForClient(sessionUser, clientName)) {
        return res.status(403).json({ success: false, error: "Access denied to this client" });
      }

      if (mode === "count") {
        const count = await getPmaOpenNotesCount({ sessionUser, clientName });
        return res.status(200).json({ success: true, count });
      }

      if (mode === "summary") {
        if (!clientName) {
          return res.status(400).json({ success: false, error: "clientName is required for summary mode" });
        }
        const summary = await getClientNoteSummaries({
          clientName,
          includeRestricted: canViewSalariesAndDividends(sessionUser),
        });
        return res.status(200).json({ success: true, ...summary });
      }

      if (mode === "entity") {
        if (!clientName) {
          return res.status(400).json({ success: false, error: "clientName is required for entity mode" });
        }
        const result = await listClientNotes({
          clientName,
          entityKey: String(req.query.entityKey || "").trim(),
          parentEntityKey: String(req.query.parentEntityKey || "").trim(),
          includeChildren: req.query.includeChildren === "true",
          entityType: String(req.query.entityType || "").trim(),
          filter: String(req.query.filter || "all").trim(),
          includeRestricted: canViewSalariesAndDividends(sessionUser),
        });
        return res.status(200).json({ success: true, ...result });
      }

      const statusFilter = String(req.query.status || "open").toLowerCase();
      const search = String(req.query.search || "").trim();
      const noteId = String(req.query.noteId || "").trim();
      const result = await listPmaNotes({
        sessionUser,
        clientName,
        statusFilter,
        search,
        noteId,
      });
      return res.status(200).json({ success: true, ...result });
    }

    const action = String(req.body?.action || "");
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

    if (action === "create") {
      const {
        clientName,
        scopeType,
        entityType,
        entityKey,
        parentEntityKey,
        entityLabel,
        contextMeta,
        body,
      } = req.body || {};
      if (!clientName || !isUserAuthorizedForClient(sessionUser, clientName)) {
        return res.status(403).json({ success: false, error: "Access denied to this client" });
      }
      const result = await createPulseNote({
        sessionUser,
        clientName,
        scopeType,
        entityType,
        entityKey,
        parentEntityKey,
        entityLabel,
        contextMeta,
        body,
        notifyManager: false,
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

    return res.status(400).json({ success: false, error: "Unsupported PMA notes action" });
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    const msg = sessionUser?.isAdmin
      ? err.message
      : statusCode === 503
        ? "Notes are temporarily unavailable. Please try again shortly."
        : sanitizeSpreadsheetTerms(err.message || "PMA notes request failed.");
    return res.status(statusCode).json({ success: false, error: msg });
  }
}
