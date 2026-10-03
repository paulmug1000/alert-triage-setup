import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { matchesClientName } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const { clientSheetId, clientName, sheetName, updates } = req.body || {};

  if (!clientSheetId || !sheetName || !Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({
      success: false,
      error: "clientSheetId, sheetName, and non-empty updates array are required",
    });
  }

  // Authorization check
  if (!sessionUser.isAdmin && clientName) {
    const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
    const isAuthorized = assignedList.some((assigned) => matchesClientName(assigned, clientName));
    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client" });
    }
  }

  const isSenior = sessionUser.isSenior || sessionUser.role === "Senior (Restricted)" || String(sessionUser.role || "").toLowerCase().includes("senior");
  if (isSenior) {
    const sLower = String(sheetName || "").toLowerCase();
    if (sLower.includes("salar") || sLower.includes("divid")) {
      return res.status(403).json({ success: false, error: "Forbidden: Senior users cannot modify salaries or dividends" });
    }
  }

  try {
    const sheets = await getSheetsClient();

    // Prepare batch update data
    const data = updates.map((u) => {
      // u: { range: "Salaries!A3:I3" or cell coordinate "C5", values: [["..."]] or [val] }
      let fullRange = u.range;
      if (!fullRange.includes("!")) {
        fullRange = `${sheetName}!${fullRange}`;
      }
      return {
        range: fullRange,
        values: Array.isArray(u.values) ? u.values : [[u.value]],
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

    // Invalidate Redis caches for this client
    try {
      const keys = await redisClient.keys(`pulse:portal:*:${clientSheetId}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (cacheErr) {
      console.warn("⚠️ Redis invalidation warning:", cacheErr.message);
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
