import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, sanitizeFormulaInput } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache } from "../../../services/cacheService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  if (sessionUser.isReadOnly) {
    return res.status(403).json({
      success: false,
      error: "Pulse is read-only when logged in with a one-time password.",
    });
  }

  const { clientSheetId, clientName, sheetName, updates } = req.body || {};

  if (!clientSheetId || !sheetName || !Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({
      success: false,
      error: "clientSheetId, sheetName, and non-empty updates array are required",
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

    const isSenior = sessionUser.isSenior || sessionUser.role === "Senior (Restricted)" || String(sessionUser.role || "").toLowerCase().includes("senior");
    if (isSenior) {
      const sLower = String(sheetName || "").toLowerCase();
      if (sLower.includes("salar") || sLower.includes("divid")) {
        return res.status(403).json({ success: false, error: "Forbidden: Senior users cannot modify salaries or dividends" });
      }
    }

    function sanitizeCell(v) {
      if (Array.isArray(v)) return v.map(sanitizeCell);
      return sanitizeFormulaInput(v);
    }

    // Prepare batch update data with formula injection neutralization
    const data = updates.map((u) => {
      // u: { range: "Salaries!A3:I3" or cell coordinate "C5", values: [["..."]] or [val] }
      let fullRange = u.range;
      if (!fullRange.includes("!")) {
        fullRange = `${sheetName}!${fullRange}`;
      }
      const rawValues = Array.isArray(u.values) ? u.values : [[u.value]];
      return {
        range: fullRange,
        values: rawValues.map(row => (Array.isArray(row) ? row.map(sanitizeCell) : [sanitizeCell(row)])),
      };
    });

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data,
        },
      })
    );

    // Invalidate caches for this client
    try {
      memoryCache.del(`pulse:portal:*:${clientSheetId}*`);
      const keys = await redisClient.keys(`pulse:portal:*:${clientSheetId}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (cacheErr) {
      console.warn("⚠️ Cache invalidation warning:", cacheErr.message);
    }

    // Log Activity
    try {
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

      await logPulseActivity(sheets, {
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
      });
    } catch (logErr) {
      console.warn("⚠️ Failed to log table update activity:", logErr.message);
    }

    return res.status(200).json({
      success: true,
      updatedCount: data.length,
    });
  } catch (err) {
    console.error("❌ /api/portal/save-table-data error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
