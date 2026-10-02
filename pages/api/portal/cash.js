import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { matchesClientName } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";

const CASH_CACHE_TTL_SECS = 60; // 60 seconds cache

// Fast month string parser (e.g. "Oct 26" -> Date)
function parseMonthYear(str) {
  if (!str) return null;
  const match = String(str).trim().match(/^([a-zA-Z]{3})[\s\-](\d{2,4})$/);
  if (match) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const m = months[match[1].toLowerCase()];
    let yr = parseInt(match[2], 10);
    if (yr < 100) yr += 2000;
    if (m !== undefined && !isNaN(yr)) {
      return new Date(yr, m, 1);
    }
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const clientSheetId = String(req.query.clientSheetId || req.body?.clientSheetId || "").trim();
  const clientName = String(req.query.clientName || req.body?.clientName || "").trim();
  const bypassCache = req.query.bypassCache === "true" || req.body?.bypassCache === true;

  if (!clientSheetId) {
    return res.status(400).json({ success: false, error: "clientSheetId is required" });
  }

  // Authorization check
  if (!sessionUser.isAdmin && clientName) {
    const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
    const isAuthorized = assignedList.some((assigned) => matchesClientName(assigned, clientName));
    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client" });
    }
  }

  const cacheKey = `pulse:portal:cash:${clientSheetId}`;

  // 1. Try Redis cache
  if (!bypassCache) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        return res.status(200).json({
          success: true,
          fromCache: true,
          data: parsed,
          cachedAt: parsed._cachedAt || null,
        });
      }
    } catch (cacheErr) {
      console.warn("⚠️ Cash Redis read warning:", cacheErr.message);
    }
  }

  // 2. Fetch fresh data from Google Sheets API
  try {
    const sheets = await getSheetsClient();

    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: "Cash!A1:AZ80",
        valueRenderOption: "FORMATTED_VALUE",
      })
    );

    const rows = resp.data?.values || [];
    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Cash sheet is empty or not found" });
    }

    const headerRow = rows[0] || [];
    const monthCols = [];

    // Parse month columns from row 1
    for (let c = 1; c < headerRow.length; c++) {
      const h = String(headerRow[c] || "").trim();
      if (!h) continue;
      const parsedDate = parseMonthYear(h);
      monthCols.push({
        colIndex: c,
        monthStr: h,
        date: parsedDate ? parsedDate.toISOString() : null,
      });
    }

    // Determine current month index
    const today = new Date();
    let currentMonthIdx = 0;
    for (let i = 0; i < monthCols.length; i++) {
      const d = monthCols[i].date ? new Date(monthCols[i].date) : null;
      if (d) {
        const mStart = new Date(d.getFullYear(), d.getMonth(), 1);
        const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
        if (today >= mStart && today <= mEnd) {
          currentMonthIdx = i;
          break;
        }
      }
    }

    // Rolling 7-month window: M-1 to M+5
    const windowStartIdx = Math.max(0, currentMonthIdx - 1);
    const windowEndIdx = Math.min(monthCols.length, windowStartIdx + 7);
    const rollingMonthCols = monthCols.slice(windowStartIdx, windowEndIdx);

    // Build line items for Table 1 (Excluding pipeline: rows 3 to 36 -> indices 2 to 35)
    // and Table 2 (Including pipeline: rows 44 to 75 -> indices 43 to 74)
    const parseTableSection = (startRowIdx, endRowIdx) => {
      const sectionRows = [];
      for (let r = startRowIdx; r <= endRowIdx; r++) {
        const row = rows[r] || [];
        const label = String(row[0] || "").trim();
        if (!label) continue;

        // Extract values for rolling 7 months
        const rollingValues = rollingMonthCols.map((m) => {
          const val = row[m.colIndex];
          return val !== undefined ? String(val).trim() : "£0";
        });

        // Also extract all months for full-year/historical viewing
        const allValues = monthCols.map((m) => {
          const val = row[m.colIndex];
          return val !== undefined ? String(val).trim() : "£0";
        });

        sectionRows.push({
          rowIndex: r + 1,
          label,
          rollingValues,
          allValues,
        });
      }
      return sectionRows;
    };

    const excludingPipelineRows = parseTableSection(2, 37);
    const includingPipelineRows = parseTableSection(43, 77);

    const cashPayload = {
      _cachedAt: new Date().toISOString(),
      currentMonth: monthCols[currentMonthIdx]?.monthStr || "Current Month",
      currentMonthIdx,
      rollingMonths: rollingMonthCols.map((m) => m.monthStr),
      allMonths: monthCols.map((m) => m.monthStr),
      excludingPipeline: excludingPipelineRows,
      includingPipeline: includingPipelineRows,
    };

    // Cache in Redis
    redisClient
      .set(cacheKey, JSON.stringify(cashPayload), { EX: CASH_CACHE_TTL_SECS })
      .catch((err) => console.warn("⚠️ Failed to write cash payload to Redis:", err.message));

    return res.status(200).json({
      success: true,
      fromCache: false,
      data: cashPayload,
    });
  } catch (err) {
    console.error("❌ /api/portal/cash error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
