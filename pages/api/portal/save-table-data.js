import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, withRetry, colLetterToNum } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, sanitizeFormulaInput, isReadOnlySession } from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache, invalidatePmaClientCache, del2TierCache } from "../../../services/cacheService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes } from "../../../services/masterEngineService.js";
import { fetchExpensesData } from "../../../services/expensesService.js";

function colIdxToLetter_(idx) {
  let c = Number(idx) + 1;
  let letter = "";
  while (c > 0) {
    const rem = (c - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    c = Math.floor((c - rem - 1) / 26);
  }
  return letter;
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

  const rl = await checkRateLimit("portal-save-table", sessionUser.email || getTrustedClientIp(req), 40, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  const { clientSheetId, clientName, sheetName, updates } = req.body || {};

  if (!clientSheetId || !sheetName || !Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({
      success: false,
      error: "clientSheetId, sheetName, and non-empty updates array are required",
    });
  }
  if (updates.length > 500) {
    return res.status(400).json({
      success: false,
      error: "Batch update exceeds maximum limit of 500 ranges.",
    });
  }

  const ALLOWED_SHEETS = {
    outgoings: "Outgoings",
    salaries: "Salaries",
    nbtofind: "NBtoFind",
    "nb to find": "NBtoFind",
  };
  const canonicalSheetName = ALLOWED_SHEETS[String(sheetName || "").trim().toLowerCase()];
  if (!canonicalSheetName) {
    return res.status(400).json({
      success: false,
      error: "Invalid section specified.",
    });
  }

  try {
    const sheets = await getSheetsClient();

    // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
    const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error });
    }
    const verifiedClientName = auth.clientName;
    const liveGate = await assertClientPortalLive(sessionUser, verifiedClientName, res);
    if (!liveGate.allowed) return;

    const isSenior = sessionUser.isSenior || sessionUser.role === "Senior (Restricted)" || String(sessionUser.role || "").toLowerCase().includes("senior");
    if (isSenior) {
      const sLower = String(sheetName || "").toLowerCase();
      if (sLower.includes("salar") || sLower.includes("divid")) {
        return res.status(403).json({ success: false, error: "Forbidden: Senior users cannot modify salaries or dividends" });
      }
    }

    const reconciledColLetters = new Set();
    if (canonicalSheetName === "Outgoings" && !sessionUser.isAdmin) {
      const currentExpenses = await fetchExpensesData(verifiedClientName, clientSheetId, false);
      (currentExpenses?.fyConfigs || []).forEach((fy) => {
        (fy.monthCols || []).forEach((m) => {
          if (m.isReconciled && m.colLetter) {
            reconciledColLetters.add(String(m.colLetter).toUpperCase().trim());
          }
        });
      });
    }

    function sanitizeCell(v) {
      if (Array.isArray(v)) return v.map(sanitizeCell);
      return sanitizeFormulaInput(v);
    }

    // Prepare batch update data with formula injection neutralization and strict cell range validation
    const data = [];
    for (const u of updates) {
      const rawCoord = String(u.range || "").trim();
      const coordPart = rawCoord.includes("!") ? rawCoord.split("!").pop().trim() : rawCoord;
      if (rawCoord.includes("!")) {
        const prefixTab = rawCoord.split("!")[0].replace(/^'|'$/g, "").trim().toLowerCase();
        if (ALLOWED_SHEETS[prefixTab] !== canonicalSheetName) {
          return res.status(400).json({ success: false, error: "Cross-sheet range override is not permitted." });
        }
      }
      const rangeMatch = coordPart.toUpperCase().match(/^([A-Z]{1,2})(\d{1,4})(?::([A-Z]{1,2})(\d{1,4}))?$/);
      if (!rangeMatch) {
        return res.status(400).json({ success: false, error: `Invalid cell coordinate: ${coordPart}` });
      }
      const startCol = rangeMatch[1];
      const startRow = parseInt(rangeMatch[2], 10);
      const endCol = rangeMatch[3] || startCol;
      const endRow = rangeMatch[4] ? parseInt(rangeMatch[4], 10) : startRow;

      const startColIdx = colLetterToNum(startCol) - 1;
      const endColIdx = colLetterToNum(endCol) - 1;
      const minRow = Math.min(startRow, endRow);
      const maxRow = Math.max(startRow, endRow);
      const minColIdx = Math.min(startColIdx, endColIdx);
      const maxColIdx = Math.max(startColIdx, endColIdx);

      const rawValues = Array.isArray(u.values) ? u.values : [[u.value]];
      const normalizedRows = rawValues.map((row) => (Array.isArray(row) ? row : [row]));
      const expectedRowCount = maxRow - minRow + 1;
      const expectedColCount = maxColIdx - minColIdx + 1;
      if (normalizedRows.length !== expectedRowCount || normalizedRows.some((r) => r.length !== expectedColCount)) {
        return res.status(400).json({ success: false, error: "Payload dimensions do not match target coordinate bounds." });
      }

      if (minRow < 2) {
        return res.status(400).json({ success: false, error: "Header row cannot be modified." });
      }
      if (canonicalSheetName === "Outgoings") {
        const overlapsDividends = minRow <= 123 && maxRow >= 115;
        const overlapsSalaries = (minRow <= 7 && maxRow >= 6) || (minRow <= 238 && maxRow >= 230);
        if (isSenior && (overlapsDividends || overlapsSalaries)) {
          return res.status(403).json({ success: false, error: "Forbidden: Senior users cannot modify salary or dividend rows" });
        }
        for (let r = minRow; r <= maxRow; r++) {
          const isContractorRow = r >= 13 && r <= 110;
          const isDividendRow = !isSenior && r >= 115 && r <= 123;
          const isExpenseRow = r >= 126 && r <= 224;
          if (!isContractorRow && !isDividendRow && !isExpenseRow) {
            return res.status(403).json({ success: false, error: "This row is not within an editable section." });
          }
        }
        for (let cIdx = minColIdx; cIdx <= maxColIdx; cIdx++) {
          const isEditableCol =
            (cIdx >= 0 && cIdx <= 5) ||
            (cIdx >= 6 && cIdx <= 17) ||
            (cIdx >= 21 && cIdx <= 32) ||
            (cIdx >= 36 && cIdx <= 47);
          if (!isEditableCol) {
            return res.status(403).json({ success: false, error: "Formula and total columns cannot be modified." });
          }
          if (!sessionUser.isAdmin && maxRow >= 126 && minRow <= 224 && reconciledColLetters.has(colIdxToLetter_(cIdx))) {
            return res.status(403).json({ success: false, error: "Cannot modify expenses for a reconciled month." });
          }
        }
      } else if (canonicalSheetName === "Salaries") {
        if (minRow < 4 || maxRow > 53) {
          return res.status(403).json({ success: false, error: "This entry is not within an editable Salaries range." });
        }
        for (let cIdx = minColIdx; cIdx <= maxColIdx; cIdx++) {
          if (cIdx < 0 || cIdx > 8) {
            return res.status(403).json({ success: false, error: "Calculated totals cannot be modified." });
          }
        }
      } else if (canonicalSheetName === "NBtoFind") {
        const ALLOWED_NB_ROWS = new Set([3, 12, 20, 21, 25]);
        for (let r = minRow; r <= maxRow; r++) {
          if (!ALLOWED_NB_ROWS.has(r)) {
            return res.status(403).json({ success: false, error: "This entry is not within an editable NB to find range." });
          }
        }
        for (let cIdx = minColIdx; cIdx <= maxColIdx; cIdx++) {
          if (cIdx < 0 || cIdx > 49) {
            return res.status(403).json({ success: false, error: "Field is outside the editable NB to find range." });
          }
        }
      }
      const boundedStartCol = colIdxToLetter_(minColIdx);
      const boundedEndCol = colIdxToLetter_(maxColIdx);
      const fullRange = `${canonicalSheetName}!${boundedStartCol}${minRow}:${boundedEndCol}${maxRow}`;
      data.push({
        range: fullRange,
        values: normalizedRows.map((row) => row.map(sanitizeCell)),
      });
    }

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        _deferBackgroundRecompute: true,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data,
        },
      })
    );

    // Invalidate caches for this client across both Portal and PMA
    try {
      await invalidatePmaClientCache(clientSheetId, null, ["outgoings", "expenses", "salaries", "views", "cash", "jobs"]);
    } catch (cacheErr) {
      console.warn("⚠️ Cache invalidation warning:", cacheErr.message);
    }

    // Log Activity asynchronously without blocking response
    const sLower = String(sheetName || "").toLowerCase();
    let category = "OUTGOINGS";
    let action = "OUTGOINGS_MODIFIED";
    if (sLower.includes("salar")) {
      category = "SALARIES";
      action = "SALARIES_MODIFIED";
    } else if (sLower.includes("divid")) {
      category = "DIVIDENDS";
      action = "DIVIDENDS_MODIFIED";
    } else if (sLower.includes("nb to find") || sLower.includes("nbtofind")) {
      category = "NB_TO_FIND";
      action = "NB_TO_FIND_MODIFIED";
    }

    const summary = `Updated ${sheetName} (${data.length} cell${data.length > 1 ? "s" : ""} updated)`;

    logPulseActivity(sheets, {
      clientName: verifiedClientName || clientName || "Client",
      category,
      action,
      summary,
      details: {
        sheetName,
        clientName: verifiedClientName || clientName,
        cellCount: data.length
      },
      user: sessionUser.name || sessionUser.email
    }).catch((logErr) => {
      console.warn("⚠️ Failed to log table update activity:", logErr.message);
    });

    return res.status(200).json({
      success: true,
      updatedCount: data.length,
    });
  } catch (err) {
    console.error("❌ /api/portal/save-table-data error:", err);
    return res.status(500).json({
      success: false,
      error: sessionUser.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Failed to save data")
    });
  } finally {
    await flushImmediateAndScheduleBackgroundClientRecomputes().catch(() => { });
  }
}
