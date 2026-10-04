import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { matchesClientName } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache } from "../../../services/cacheService.js";

const BUDGET_CACHE_TTL_SECS = 60; // 60 seconds cache

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

  const cacheKey = `pulse:portal:budget:${clientSheetId}`;

  // 1. Check L1 Memory Cache
  if (!bypassCache) {
    const memCached = memoryCache.get(cacheKey);
    if (memCached) {
      return res.status(200).json({
        success: true,
        fromCache: true,
        fromMemory: true,
        data: memCached,
        cachedAt: memCached._cachedAt || null,
      });
    }

    // 2. Check Redis cache
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        memoryCache.set(cacheKey, parsed, BUDGET_CACHE_TTL_SECS);
        return res.status(200).json({
          success: true,
          fromCache: true,
          fromRedis: true,
          data: parsed,
          cachedAt: parsed._cachedAt || null,
        });
      }
    } catch (cacheErr) {
      console.warn("⚠️ Budget Redis read warning:", cacheErr.message);
    }
  }

  // 2. Fetch fresh data from Google Sheets API
  try {
    const sheets = await getSheetsClient();

    // Check if Budget sheet exists
    const metaResp = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: clientSheetId,
        fields: "sheets.properties.title",
      })
    );
    const existingTitles = new Set((metaResp.data?.sheets || []).map((s) => s.properties?.title));

    if (!existingTitles.has("Budget")) {
      return res.status(200).json({
        success: true,
        hasBudget: false,
        message: "No Budget tab found for this client sheet",
      });
    }

    const [budgetResp, appDataResp, mathResp] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: "Budget!A1:AX47",
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: "AppData!A1:AX47",
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: "Budget!A1:AX47",
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      ),
    ]);

    const budgetDisp = budgetResp.data?.values || [];
    const appDataDisp = appDataResp.data?.values || [];
    const budgetMath = mathResp.data?.values || [];

    if (budgetDisp.length === 0) {
      return res.status(200).json({
        success: true,
        hasBudget: false,
        message: "Budget tab is empty",
      });
    }

    // 3 Year blocks (Year 1: G:T = start 6, Year 2: V:AI = start 21, Year 3: AK:AX = start 36)
    const yearBlocks = [
      { id: "year1", label: "Year 1", start: 6, count: 14 },
      { id: "year2", label: "Year 2", start: 21, count: 14 },
      { id: "year3", label: "Year 3", start: 36, count: 14 },
    ];

    const today = new Date();
    let currentYearIdx = 0;
    let fallbackIdx = 0;

    const parsedYears = yearBlocks.map((blk, yIdx) => {
      const startCol = blk.start;
      const monthRow = budgetDisp[0] || [];
      const statusRow = budgetDisp[1] || [];

      // Extract 12 months
      const months = [];
      for (let m = 0; m < 12; m++) {
        const colIdx = startCol + m;
        const monthLabel = monthRow[colIdx] || `M${m + 1}`;
        const status = statusRow[colIdx] || "Budget";
        const dateObj = parseMonthYear(monthLabel);

        if (dateObj) {
          const fyStart = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
          const fyEnd = new Date(dateObj.getFullYear(), dateObj.getMonth() + 1, 0, 23, 59, 59);
          if (today >= fyStart && today <= fyEnd) {
            currentYearIdx = yIdx;
          }
          if (today > fyEnd) fallbackIdx = yIdx;
        }

        months.push({
          index: m + 1,
          label: monthLabel,
          status: status,
          colIdx,
        });
      }

      const totalColIdx = startCol + 13;
      const fyTotalLabel = monthRow[totalColIdx] || "FY Total";

      // Extract rows (Row 3 to 47)
      const rows = [];
      const numRows = Math.min(budgetDisp.length, 47);
      for (let r = 2; r < numRows; r++) {
        const rowLabel = String(budgetDisp[r]?.[0] || "").trim();
        if (!rowLabel) continue;

        const rowValues = [];
        for (let m = 0; m < 12; m++) {
          rowValues.push(String(budgetDisp[r]?.[startCol + m] || "£0").trim());
        }
        const totalVal = String(budgetDisp[r]?.[totalColIdx] || "£0").trim();

        // Actual row from AppData for comparison
        const actualRowValues = [];
        for (let m = 0; m < 12; m++) {
          actualRowValues.push(String(appDataDisp[r]?.[startCol + m] || "£0").trim());
        }
        const actualTotalVal = String(appDataDisp[r]?.[totalColIdx] || "£0").trim();

        rows.push({
          rowIndex: r + 1,
          label: rowLabel,
          values: rowValues,
          total: totalVal,
          actualValues: actualRowValues,
          actualTotal: actualTotalVal,
        });
      }

      return {
        id: blk.id,
        label: blk.label,
        yearIndex: yIdx,
        months,
        fyTotalLabel,
        rows,
      };
    });

    if (currentYearIdx === 0 && fallbackIdx > 0) {
      currentYearIdx = fallbackIdx;
    }

    const budgetPayload = {
      _cachedAt: new Date().toISOString(),
      hasBudget: true,
      currentYearIdx,
      years: parsedYears,
      rawVals: budgetDisp,
      mathVals: budgetMath,
    };

    // Cache in L1 memory and Redis
    memoryCache.set(cacheKey, budgetPayload, BUDGET_CACHE_TTL_SECS);
    redisClient
      .set(cacheKey, JSON.stringify(budgetPayload), { EX: BUDGET_CACHE_TTL_SECS })
      .catch((err) => console.warn("⚠️ Failed to write budget to Redis:", err.message));

    return res.status(200).json({
      success: true,
      fromCache: false,
      data: budgetPayload,
    });
  } catch (err) {
    console.error("❌ /api/portal/budget error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
