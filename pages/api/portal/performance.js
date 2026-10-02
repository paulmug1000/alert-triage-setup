import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { matchesClientName } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";

const PERF_CACHE_TTL_SECS = 60; // 60 seconds cache

// Fast month string parser (e.g. "Apr 26" -> Date)
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

  const cacheKey = `pulse:portal:performance:${clientSheetId}`;

  // 1. Check Redis cache
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
      console.warn("⚠️ Performance Redis read warning:", cacheErr.message);
    }
  }

  // 2. Fetch fresh data from Google Sheets API
  try {
    const sheets = await getSheetsClient();

    const [formattedResp, mathResp] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: clientSheetId,
          ranges: ["AppData!A1:CR35", "AppData!Z42:Z59", "AppData!W40:W44"],
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: "AppData!A1:CR35",
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      ),
    ]);

    const appDataDisp = formattedResp.data.valueRanges?.[0]?.values || [];
    const thresholdsRaw = (formattedResp.data.valueRanges?.[1]?.values || []).map((r) => r[0] || "");
    const toggles = formattedResp.data.valueRanges?.[2]?.values || [];
    const appDataMath = mathResp.data?.values || [];

    const version = toggles[0]?.[0] || ""; // W40
    const showExtraRows = toggles[2]?.[0] === "Yes"; // W42
    const numRows = showExtraRows ? 34 : 32;

    // Thresholds: Z42:Z59 (18 rows) - normalize percentages into decimal numbers (e.g. "49.50%" -> 0.495)
    const thresholds = thresholdsRaw.slice(0, 18).map((v) => {
      if (typeof v === "number") return v > 1 ? v / 100 : v;
      const s = String(v || "").replace(/%/g, "").trim();
      const n = parseFloat(s);
      if (isNaN(n)) return 0;
      return String(v).includes("%") || n > 1 ? n / 100 : n;
    });

    // Year Blocks mapping (0-indexed start column, count 14)
    // Hist: CE:CR (Col 83 -> index 82)
    // Year 1: G:T (Col 7 -> index 6)
    // Year 2: V:AI (Col 22 -> index 21)
    // Year 3: AK:AX (Col 37 -> index 36)
    const yearBlockConfigs = [
      { id: "hist", name: "Historical Year", start: 82, count: 14 },
      { id: "year1", name: "Year 1", start: 6, count: 14 },
      { id: "year2", name: "Year 2", start: 21, count: 14 },
      { id: "year3", name: "Year 3", start: 36, count: 14 },
    ];

    const today = new Date();
    let currentYearIdx = 1; // Default to Year 1
    let fallbackIdx = 0;

    // Determine current financial year by inspecting row 1 month dates
    for (let bi = 0; bi < yearBlockConfigs.length; bi++) {
      const blk = yearBlockConfigs[bi];
      const firstMonthStr = appDataDisp[0]?.[blk.start];
      const d = parseMonthYear(firstMonthStr);

      if (d) {
        const fyStart = new Date(d.getFullYear(), d.getMonth(), 1);
        const fyEnd = new Date(d.getFullYear(), d.getMonth() + 12, 0, 23, 59, 59);

        if (today >= fyStart && today <= fyEnd) {
          currentYearIdx = bi;
          break;
        }
        if (today > fyEnd) {
          fallbackIdx = bi;
        }
      }
    }

    if (currentYearIdx === 1 && fallbackIdx > 1) {
      currentYearIdx = fallbackIdx;
    }

    // Build line items (Column A, rows 1 to numRows)
    const lineItemLabels = [];
    for (let i = 0; i < numRows; i++) {
      lineItemLabels.push(appDataDisp[i]?.[0] !== undefined ? String(appDataDisp[i][0]).trim() : "");
    }

    // Build the 4 year blocks
    const years = yearBlockConfigs.map((blk, yIdx) => {
      const headerMonths = [];
      for (let j = 0; j < 12; j++) {
        const mStr = appDataDisp[0]?.[blk.start + j] || `M${j + 1}`;
        headerMonths.push(String(mStr).trim());
      }
      const totalColHeader = appDataDisp[0]?.[blk.start + 13] || "FY Total";

      // Row 2 is status (Actual / Forecast)
      const monthStatuses = [];
      for (let j = 0; j < 12; j++) {
        monthStatuses.push(appDataDisp[1]?.[blk.start + j] || "Forecast");
      }

      // Build data rows for this year
      const rows = [];
      for (let i = 0; i < numRows; i++) {
        const label = lineItemLabels[i];
        const monthlyValues = [];
        const monthlyMath = [];

        for (let j = 0; j < 12; j++) {
          const colIdx = blk.start + j;
          const valDisp = appDataDisp[i]?.[colIdx] !== undefined ? String(appDataDisp[i][colIdx]).trim() : "";
          const valMath = typeof appDataMath[i]?.[colIdx] === "number" ? appDataMath[i][colIdx] : null;
          monthlyValues.push(valDisp);
          monthlyMath.push(valMath);
        }

        const totalVal = appDataDisp[i]?.[blk.start + 13] !== undefined ? String(appDataDisp[i][blk.start + 13]).trim() : "";
        const totalMath = typeof appDataMath[i]?.[blk.start + 13] === "number" ? appDataMath[i][blk.start + 13] : null;

        rows.push({
          rowIndex: i + 1,
          label,
          monthlyValues,
          monthlyMath,
          totalVal,
          totalMath,
        });
      }

      // Financial year title extracted from first and last month, e.g. "FY27 (Apr 26 - Mar 27)"
      const startMonth = headerMonths[0];
      const endMonth = headerMonths[11];
      const fyLabel = totalColHeader.replace(/\s*total/i, "").trim() || blk.name;
      const displayTitle = `${fyLabel} (${startMonth} – ${endMonth})`;

      return {
        id: blk.id,
        yearIndex: yIdx,
        name: blk.name,
        fyLabel,
        displayTitle,
        headerMonths,
        monthStatuses,
        statusValues: monthStatuses,
        totalColHeader,
        rows,
      };
    });

    const performanceData = {
      _cachedAt: new Date().toISOString(),
      version,
      showExtraRows,
      numRows,
      currentYearIdx,
      thresholds,
      lineItemLabels,
      years,
    };

    // Cache in Redis
    redisClient
      .set(cacheKey, JSON.stringify(performanceData), { EX: PERF_CACHE_TTL_SECS })
      .catch((err) => console.warn("⚠️ Failed to write performance data to Redis:", err.message));

    return res.status(200).json({
      success: true,
      fromCache: false,
      data: performanceData,
    });
  } catch (err) {
    console.error("❌ /api/portal/performance error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
