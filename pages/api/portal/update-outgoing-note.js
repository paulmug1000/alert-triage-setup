import { waitUntil } from "@vercel/functions";
import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  verifyUserAuthorizedForSheet,
  unwrapSheetId,
  isReadOnlySession,
  getCanonicalAcSheetId,
} from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { handleUpdateOutgoingNote, parseOutgoingsNoteParts_ } from "../../../services/workspaces.js";
import { fetchExpensesData } from "../../../services/expensesService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";
import { assertTrustedOrigin, isPlaceholderExpense, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes } from "../../../services/masterEngineService.js";

function colLetterToIdx0_(letters) {
  const clean = String(letters || "").trim().toUpperCase();
  if (!clean) return -1;
  let num = 0;
  for (let i = 0; i < clean.length; i++) {
    num = num * 26 + (clean.charCodeAt(i) - 64);
  }
  return num - 1;
}

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
  if (isNaN(parsedRow) || parsedRow < 13 || parsedRow > 110 || !/^[E-Z]$|^A[A-Z]$/.test(cleanColLetter)) {
    return res.status(400).json({ success: false, error: "Invalid contractor row or column" });
  }
  const colIdx0 = colLetterToIdx0_(cleanColLetter);
  const isMonthlyCol =
    (colIdx0 >= 6 && colIdx0 <= 17) ||
    (colIdx0 >= 21 && colIdx0 <= 32) ||
    (colIdx0 >= 36 && colIdx0 <= 47);
  if (!isMonthlyCol) {
    return res.status(400).json({ success: false, error: "Invalid monthly column" });
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

    if (!sessionUser.isAdmin) {
      const currentExpenses = await fetchExpensesData(verifiedClientName, cleanSheetId, false).catch(() => null);
      let isReconciledMonth = false;
      (currentExpenses?.fyConfigs || []).forEach((fy) => {
        (fy.monthCols || []).forEach((m) => {
          if (m.isReconciled && String(m.colLetter || "").toUpperCase().trim() === cleanColLetter) {
            isReconciledMonth = true;
          }
        });
      });
      if (isReconciledMonth) {
        return res.status(403).json({
          success: false,
          error: "Forbidden: Cannot modify contractor expenses in a reconciled month.",
        });
      }
    }

    let validatedBlocks = blocks;
    if (Array.isArray(blocks)) {
      const existingNoteResp = await sheets.spreadsheets
        .get({
          spreadsheetId: cleanSheetId,
          ranges: [`Outgoings!${cleanColLetter}${parsedRow}`],
          includeGridData: true,
          fields: "sheets.data.rowData.values.note",
        })
        .catch(() => null);
      const existingNoteStr =
        existingNoteResp?.data?.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.note || "";
      const { blocks: existingBlocks } = parseOutgoingsNoteParts_(existingNoteStr);

      const lockedExistingByAppId = new Map();
      for (const eb of existingBlocks) {
        if (!eb?.appId) continue;
        const isPl = isPlaceholderExpense(eb.appId, eb.description, eb.status);
        const isPaidExisting = String(eb.status || "").trim().toLowerCase() === "paid";
        if (!isPl || isPaidExisting) {
          lockedExistingByAppId.set(String(eb.appId).trim(), { block: eb, isSynced: !isPl, isPaid: isPaidExisting });
        }
      }

      if (lockedExistingByAppId.size > 0) {
        const incomingByAppId = new Map();
        for (const nb of blocks) {
          const idStr = String(nb?.appId || "").trim();
          if (idStr) incomingByAppId.set(idStr, nb);
        }
        for (const [lockedId] of lockedExistingByAppId.entries()) {
          if (!incomingByAppId.has(lockedId)) {
            return res.status(403).json({
              success: false,
              error: "Forbidden: Synced or paid contractor bills cannot be deleted from Pulse.",
            });
          }
        }
        validatedBlocks = blocks.map((nb) => {
          const idStr = String(nb?.appId || "").trim();
          const lockInfo = idStr ? lockedExistingByAppId.get(idStr) : null;
          if (!lockInfo) return nb;
          const eb = lockInfo.block;
          return {
            ...nb,
            appId: eb.appId,
            amount: eb.amount,
            status: eb.status,
            recDate: eb.recDate,
            description: eb.description,
            payDate: lockInfo.isPaid ? eb.payDate : nb.payDate,
          };
        });
      }
    }

    req.resolvedUser = sessionUser;
    req.body = {
      ...req.body,
      clientSheetId: cleanSheetId,
      clientName: verifiedClientName,
      automationCommanderSheetId: getCanonicalAcSheetId(),
      sheetRow: parsedRow,
      colLetter: cleanColLetter,
      ...(validatedBlocks !== undefined ? { blocks: validatedBlocks } : {}),
    };

    await handleUpdateOutgoingNote(req, res, sheets);

    if (res.statusCode >= 200 && res.statusCode < 300) {
      const itemCount = Array.isArray(validatedBlocks) ? validatedBlocks.length : 0;
      const activityPromise = logPulseActivity(sheets, {
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
      }).catch(() => { });
      try { waitUntil(activityPromise); } catch (_) { }
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
    await flushImmediateAndScheduleBackgroundClientRecomputes(null, verifiedClientName || "").catch(() => { });
  }
}
