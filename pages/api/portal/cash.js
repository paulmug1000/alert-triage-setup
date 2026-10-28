import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache } from "../../../services/cacheService.js";

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

  const sheets = await getSheetsClient();

  // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
  const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
  if (!auth.authorized) {
    return res.status(auth.status || 403).json({ success: false, error: auth.error });
  }

  const isSeniorUser = Boolean(
    sessionUser.isSenior ||
    sessionUser.role === "Senior (Restricted)" ||
    String(sessionUser.role || "").toLowerCase().includes("senior")
  );

  const sanitizeCashForUser = (payload) => {
    if (!isSeniorUser || !payload) return payload;
    const isRestrictedLabel = (lbl) =>
      /salar|divid|payroll|wages|director|remuneration|net pay/i.test(String(lbl || ""));
    const redactRows = (rows) =>
      Array.isArray(rows)
        ? rows.map((r) =>
            isRestrictedLabel(r?.label)
              ? {
                  ...r,
                  rollingValues: Array.isArray(r.rollingValues) ? r.rollingValues.map(() => "—") : r.rollingValues,
                  rollingNotes: Array.isArray(r.rollingNotes) ? r.rollingNotes.map(() => "") : r.rollingNotes,
                  allValues: Array.isArray(r.allValues) ? r.allValues.map(() => "—") : r.allValues,
                  allNotes: Array.isArray(r.allNotes) ? r.allNotes.map(() => "") : r.allNotes,
                }
              : r
          )
        : rows;
    return {
      ...payload,
      excludingPipeline: redactRows(payload.excludingPipeline),
      includingPipeline: redactRows(payload.includingPipeline),
    };
  };

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  const cacheKey = `pulse:portal:cash:${clientSheetId}`;

  // Purge existing cache on explicit refresh
  if (bypassCache) {
    memoryCache.del(cacheKey);
    redisClient.del(cacheKey).catch(() => {});
  }

  // 1. Try L1 Memory Cache
  if (!bypassCache) {
    const memCached = memoryCache.get(cacheKey);
    if (memCached) {
      return res.status(200).json({
        success: true,
        fromCache: true,
        fromMemory: true,
        data: sanitizeCashForUser(memCached),
        cachedAt: memCached._cachedAt || null,
      });
    }

    // 2. Try Redis cache
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        memoryCache.set(cacheKey, parsed, CASH_CACHE_TTL_SECS);
        return res.status(200).json({
          success: true,
          fromCache: true,
          fromRedis: true,
          data: sanitizeCashForUser(parsed),
          cachedAt: parsed._cachedAt || null,
        });
      }
    } catch (cacheErr) {
      console.warn("⚠️ Cash Redis read warning:", cacheErr.message);
    }
  }

  // 2. Fetch fresh data from Google Sheets API
  try {
    const resp = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: clientSheetId,
        ranges: ["Cash!A1:AZ80", "AppData!G59"],
        fields: "sheets(properties.title,data.rowData.values(formattedValue,note))",
      })
    );

    const cashSheet = resp.data?.sheets?.find((s) => s.properties?.title === "Cash");
    const appDataSheet = resp.data?.sheets?.find((s) => s.properties?.title === "AppData");
    const rawRows = cashSheet?.data?.[0]?.rowData || [];
    const g59Val = String(appDataSheet?.data?.[0]?.rowData?.[0]?.values?.[0]?.formattedValue || "").trim().toLowerCase();
    const showChart = g59Val === "yes";

    if (!rawRows.length) {
      return res.status(404).json({ success: false, error: "Cash sheet is empty or not found" });
    }

    const headerRow = rawRows[0]?.values || [];
    const monthCols = [];

    // Parse month columns from row 1
    for (let c = 1; c < headerRow.length; c++) {
      const h = String(headerRow[c]?.formattedValue || "").trim();
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

    // Build line items for Table 1 (Excluding pipeline: rows 3 to 38 -> indices 2 to 37)
    // and Table 2 (Including pipeline: rows 44 to 78 -> indices 43 to 77)
    const parseTableSection = (startRowIdx, endRowIdx) => {
      const sectionRows = [];
      for (let r = startRowIdx; r <= endRowIdx; r++) {
        const rowCells = rawRows[r]?.values || [];
        const label = String(rowCells[0]?.formattedValue || "").trim();
        if (!label) continue;

        // Extract values and notes for rolling 7 months
        const rollingValues = rollingMonthCols.map((m) => {
          const cell = rowCells[m.colIndex];
          const val = cell?.formattedValue;
          return val !== undefined && val !== null ? String(val).trim() : "£0";
        });

        const rollingNotes = rollingMonthCols.map((m) => {
          const cell = rowCells[m.colIndex];
          const note = cell?.note;
          return note !== undefined && note !== null ? String(note).trim() : "";
        });

        // Also extract all months for full-year/historical viewing
        const allValues = monthCols.map((m) => {
          const cell = rowCells[m.colIndex];
          const val = cell?.formattedValue;
          return val !== undefined && val !== null ? String(val).trim() : "£0";
        });

        const allNotes = monthCols.map((m) => {
          const cell = rowCells[m.colIndex];
          const note = cell?.note;
          return note !== undefined && note !== null ? String(note).trim() : "";
        });

        sectionRows.push({
          rowIndex: r + 1,
          label,
          rollingValues,
          rollingNotes,
          allValues,
          allNotes,
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
      showChart,
    };

    // Cache in L1 memory and Redis
    memoryCache.set(cacheKey, cashPayload, CASH_CACHE_TTL_SECS);
    redisClient
      .set(cacheKey, JSON.stringify(cashPayload), { EX: CASH_CACHE_TTL_SECS })
      .catch((err) => console.warn("⚠️ Failed to write cash payload to Redis:", err.message));

    return res.status(200).json({
      success: true,
      fromCache: false,
      data: sanitizeCashForUser(cashPayload),
    });
  } catch (err) {
    console.error("❌ /api/portal/cash error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
