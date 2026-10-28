/**
 * ============================================================================
 * SETUP CHECKLIST API: /api/setup/checklist
 * ============================================================================
 * 
 * GET: Retrieves the full 5-phase onboarding checklist for a client.
 * POST: Updates a specific checklist task's completion status.
 */

import { getSessionUser } from "../../../services/authService.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { isUserAuthorizedForClient, verifyUserAuthorizedForSheet, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { getClientChecklistState, updateClientChecklistTask } from "../../../services/setupService.js";
import { sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

function sanitizeChecklistStateForUser(state, sessionUser) {
  if (!state || sessionUser?.isAdmin) return state;
  const sanitizeTask = (t) =>
    t && typeof t === "object"
      ? {
          ...t,
          title: t.title ? sanitizeSpreadsheetTerms(t.title) : t.title,
          description: t.description ? sanitizeSpreadsheetTerms(t.description) : t.description,
          instructions: Array.isArray(t.instructions)
            ? t.instructions.map((step) => sanitizeSpreadsheetTerms(String(step || "")))
            : t.instructions,
          metadata: t.metadata ? sanitizeSpreadsheetTerms(String(t.metadata)) : t.metadata,
        }
      : t;
  return {
    ...state,
    phases: Array.isArray(state.phases)
      ? state.phases.map((p) => ({
          ...p,
          title: p.title ? sanitizeSpreadsheetTerms(p.title) : p.title,
          description: p.description ? sanitizeSpreadsheetTerms(p.description) : p.description,
          tasks: Array.isArray(p.tasks) ? p.tasks.map(sanitizeTask) : p.tasks,
        }))
      : state.phases,
    tasks: Array.isArray(state.tasks) ? state.tasks.map(sanitizeTask) : state.tasks,
  };
}

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req, res);
  installSheetIdBoundary(req, res, sessionUser);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Access denied: PMA configuration requires staff privileges." });
  }

  const sheets = await getSheetsClient();

  if (req.method === "GET") {
    const { clientName, masterSheetId } = req.query;
    if (!clientName) {
      return res.status(400).json({ success: false, error: "Missing required clientName parameter." });
    }

    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }
    if (!sessionUser.isAdmin && masterSheetId) {
      const auth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }

    try {
      const state = await getClientChecklistState(sheets, clientName, masterSheetId);
      return res.status(200).json({ success: true, ...sanitizeChecklistStateForUser(state, sessionUser) });
    } catch (err) {
      console.error("GET /api/setup/checklist error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify checklist." });
    }
    const { clientName, masterSheetId, taskId, isCompleted, metadata } = req.body || {};
    if (!clientName || !taskId) {
      return res.status(400).json({ success: false, error: "Missing required clientName or taskId." });
    }

    if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
      return res.status(403).json({ success: false, error: "Access denied to this client." });
    }
    if (!sessionUser.isAdmin && masterSheetId) {
      const auth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
      }
    }

    try {
      const updatedState = await updateClientChecklistTask(sheets, {
        clientName,
        taskId,
        isCompleted: Boolean(isCompleted),
        metadata: metadata || "",
        userEmail: sessionUser.email
      });
      return res.status(200).json({ success: true, ...sanitizeChecklistStateForUser(updatedState, sessionUser) });
    } catch (err) {
      console.error("POST /api/setup/checklist error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed." });
}
