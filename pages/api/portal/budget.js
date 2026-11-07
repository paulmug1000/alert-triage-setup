import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry, getSheetTitles } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet } from "../../../services/userPermissions.js";
import { resolvePortalCache } from "../../../services/cacheService.js";

const BUDGET_CACHE_TTL_SECS = 60; // 60s L1 fresh window
const BUDGET_REDIS_TTL_SECS = 900; // 15m Redis SWR retention

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
  const isAutoRefresh = req.query.autoRefresh === "true" || req.body?.autoRefresh === true;

  if (!clientSheetId) {
    return res.status(400).json({ success: false, error: "clientSheetId is required" });
  }

  const sheets = await getSheetsClient();

  // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
  const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
  if (!auth.authorized) {
    return res.status(auth.status || 403).json({ success: false, error: auth.error });
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  const cacheKey = `pulse:portal:budget:${clientSheetId}`;

  try {
    const result = await resolvePortalCache({
      cacheKey,
      bypassCache,
      isAutoRefresh,
      isReadOnly: Boolean(sessionUser.isReadOnly),
      l1TtlSecs: BUDGET_CACHE_TTL_SECS,
      redisTtlSecs: BUDGET_REDIS_TTL_SECS,
      fetchFreshFn: async () => {
        // Check if Budget sheet exists using 15-minute cached tab metadata
        const existingTitles = await getSheetTitles(sheets, clientSheetId);

        if (!existingTitles.has("Budget")) {
          return {
            _skipCache: true,
            _noBudgetTab: true,
            message: "No Budget tab found for this client sheet",
          };
        }

        const [formattedBatchResp, mathResp] = await Promise.all([
          withRetry(() =>
            sheets.spreadsheets.values.batchGet({
              spreadsheetId: clientSheetId,
              ranges: ["Budget!A1:AX47", "AppData!A1:AX47", "KeyInfo!B15", "KeyInfo!D8"],
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

        const budgetDisp = formattedBatchResp.data?.valueRanges?.[0]?.values || [];
        const appDataDisp = formattedBatchResp.data?.valueRanges?.[1]?.values || [];
        const budgetMath = mathResp.data?.values || [];
        const mode = String(formattedBatchResp.data?.valueRanges?.[2]?.values?.[0]?.[0] || "Revenue").trim();
        const rawDirectCostsMode = String(formattedBatchResp.data?.valueRanges?.[3]?.values?.[0]?.[0] || "Contractors").trim();
        const directCostsMode =
          mode.toLowerCase() === "income"
            ? "Pass-through"
            : rawDirectCostsMode === "Pass-through"
            ? "Pass-through"
            : "Contractors";

        if (budgetDisp.length === 0) {
          return {
            _skipCache: true,
            _noBudgetTab: true,
            message: "Budget tab is empty",
          };
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
        let rowLabel = String(budgetDisp[r]?.[0] || "").trim();
        if (!rowLabel) continue;
        if (r === 29 && mode.toLowerCase() !== "income") {
          if (directCostsMode === "Contractors") continue;
          if (directCostsMode === "Pass-through") rowLabel = "Pass-through costs";
        }

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
      mode,
      directCostsMode,
      currentYearIdx,
      years: parsedYears,
      rawVals: budgetDisp,
      mathVals: budgetMath,
    };

    return budgetPayload;
  },
});

    if (result.data?._noBudgetTab) {
      return res.status(200).json({
        success: true,
        hasBudget: false,
        message: result.data.message || "No Budget tab found for this client sheet",
      });
    }

    return res.status(200).json({
      success: true,
      fromCache: result.fromCache,
      fromMemory: result.fromMemory,
      fromRedis: result.fromRedis,
      staleRevalidating: result.staleRevalidating,
      data: result.data,
      cachedAt: result.cachedAt,
    });
  } catch (err) {
    console.error("❌ /api/portal/budget error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
