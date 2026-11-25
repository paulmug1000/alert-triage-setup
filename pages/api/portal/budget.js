import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, withRetry, getSheetTitles, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, unwrapSheetId, canViewSalariesAndDividends } from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { resolvePortalCache } from "../../../services/cacheService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";
import { hasNBToFindInBudget } from "../../../services/deepDiveHelper.js";
import { resolveSupabaseSheetContext } from "../../../services/masterEngineService.js";
import {
  preloadClientRelationalInputsBundle,
  reconstructRelationalTabFromBundle,
  sliceRelationalTabValues,
} from "../../../services/relationalInputsService.js";

const BUDGET_CACHE_TTL_SECS = 60; // 60s L1 fresh window
const BUDGET_REDIS_TTL_SECS = 86400; // 24h Redis SWR retention

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

export async function buildPortalBudgetPayload({ sheets, clientSheetId, clientName = "", _forceInputsReadMode = null }) {
  const [existingTitles, sbCtx] = await Promise.all([
    getSheetTitles(sheets, clientSheetId),
    resolveSupabaseSheetContext({ spreadsheetId: clientSheetId, clientName }).catch(() => null),
  ]);

  if (!existingTitles.has("Budget")) {
    return {
      _skipCache: true,
      _noBudgetTab: true,
      message: "No Budget tab found for this client sheet",
    };
  }

  const forceMode =
    _forceInputsReadMode === "grid" || _forceInputsReadMode === "relational"
      ? _forceInputsReadMode
      : null;
  const useRelReads = forceMode
    ? forceMode === "relational"
    : Boolean(sbCtx?.inputsMode === "relational" && sbCtx?.inputsReadMode === "relational" && sbCtx?.clientId);

  let budgetDisp = [];
  let actualsDisp = [];
  let budgetMath = [];
  let mode = "Revenue";
  let rawDirectCostsMode = "Contractors";
  let usedRelReads = false;

  if (useRelReads && sbCtx?.clientId) {
    const [formattedBatchResp, relBundle] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: clientSheetId,
          ranges: ["Performance!A1:AX47", "KeyInfo!B15", "KeyInfo!D8"],
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
      preloadClientRelationalInputsBundle(sbCtx, { includeBudget: true }).catch(() => null),
    ]);
    actualsDisp = formattedBatchResp.data?.valueRanges?.[0]?.values || [];
    mode = String(formattedBatchResp.data?.valueRanges?.[1]?.values?.[0]?.[0] || "Revenue").trim();
    rawDirectCostsMode = String(formattedBatchResp.data?.valueRanges?.[2]?.values?.[0]?.[0] || "Contractors").trim();

    if (relBundle?.rollups?._budgetRollups) {
      usedRelReads = true;
      const budState = reconstructRelationalTabFromBundle(relBundle, "Budget");
      budgetDisp = sliceRelationalTabValues(budState, "Budget", { startRow0: 0, endRow0: 46, startCol0: 0, endCol0: 49, formatted: true });
      budgetMath = sliceRelationalTabValues(budState, "Budget", { startRow0: 0, endRow0: 46, startCol0: 0, endCol0: 49, formatted: false });
    }
  }

  if (!usedRelReads) {
    const [formattedBatchResp, mathResp] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: clientSheetId,
          ranges: ["Budget!A1:AX47", "Performance!A1:AX47", "KeyInfo!B15", "KeyInfo!D8"],
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

    budgetDisp = formattedBatchResp.data?.valueRanges?.[0]?.values || [];
    actualsDisp = formattedBatchResp.data?.valueRanges?.[1]?.values || [];
    budgetMath = mathResp.data?.values || [];
    mode = String(formattedBatchResp.data?.valueRanges?.[2]?.values?.[0]?.[0] || "Revenue").trim();
    rawDirectCostsMode = String(formattedBatchResp.data?.valueRanges?.[3]?.values?.[0]?.[0] || "Contractors").trim();
  }

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

      // Actual row from Performance for comparison
      const actualRowValues = [];
      for (let m = 0; m < 12; m++) {
        actualRowValues.push(String(actualsDisp[r]?.[startCol + m] || "£0").trim());
      }
      const actualTotalVal = String(actualsDisp[r]?.[totalColIdx] || "£0").trim();

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

  const hasNBToFind = Boolean(hasNBToFindInBudget({ rawVals: budgetDisp, mathVals: budgetMath, mode }));

  return {
    _cachedAt: new Date().toISOString(),
    hasBudget: true,
    hasNBToFind,
    mode,
    directCostsMode,
    currentYearIdx,
    years: parsedYears,
    rawVals: budgetDisp,
    mathVals: budgetMath,
    inputsReadMode: usedRelReads ? "relational" : "grid",
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (req.method === "POST" && !assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const rl = await checkRateLimit("portal-budget", sessionUser.email || getTrustedClientIp(req), 120, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  const rawClientSheetId = String(req.query.clientSheetId || req.body?.clientSheetId || "").trim();
  const clientName = String(req.query.clientName || req.body?.clientName || "").trim();
  const bypassCache = req.query.bypassCache === "true" || req.body?.bypassCache === true;
  const isAutoRefresh = req.query.autoRefresh === "true" || req.body?.autoRefresh === true;

  if (!rawClientSheetId) {
    return res.status(400).json({ success: false, error: "clientSheetId is required" });
  }

  const clientSheetId = unwrapSheetId(extractSheetIdFromUrl(rawClientSheetId) || rawClientSheetId);
  if (!clientSheetId || clientSheetId === "__INVALID_WS_TOKEN__") {
    return res.status(400).json({ success: false, error: "Invalid clientSheetId" });
  }

  const sheets = await getSheetsClient();

  // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
  const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
  if (!auth.authorized) {
    return res.status(auth.status || 403).json({ success: false, error: auth.error });
  }
  const liveGate = await assertClientPortalLive(sessionUser, auth.clientName || clientName, res);
  if (!liveGate.allowed) return;

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
      fetchFreshFn: () =>
        buildPortalBudgetPayload({
          sheets,
          clientSheetId,
          clientName: auth.clientName || clientName,
        }),
    });

    if (result.data?._noBudgetTab) {
      return res.status(200).json({
        success: true,
        hasBudget: false,
        message: sessionUser?.isAdmin
          ? (result.data.message || "No Budget tab found for this client sheet")
          : "No budget configured for this workspace",
      });
    }

    const SENSITIVE_BUDGET_RE =
      /dividend|director|salar|wages|remuneration|paye|\bnic\b|pension|payroll|net\s*pay|staff\s*cost|staff\s*ratio|retained\s*profit/i;
    const isSenior = !canViewSalariesAndDividends(sessionUser);
    let responseData = result.data;
    if (isSenior && responseData && typeof responseData === "object") {
      responseData = { ...responseData };
      if (Array.isArray(responseData.years)) {
        responseData.years = responseData.years.map((yr) => ({
          ...yr,
          rows: Array.isArray(yr.rows)
            ? yr.rows.filter((r) => !SENSITIVE_BUDGET_RE.test(String(r?.label || "")))
            : yr.rows,
        }));
      }
      const maskBudgetGrid = (grid) =>
        Array.isArray(grid)
          ? grid.map((r, rIdx) => {
            if (rIdx >= 2 && Array.isArray(r) && SENSITIVE_BUDGET_RE.test(String(r[0] || ""))) {
              return [r[0], ...r.slice(1).map(() => "")];
            }
            return r;
          })
          : grid;
      if (Array.isArray(responseData.rawVals)) responseData.rawVals = maskBudgetGrid(responseData.rawVals);
      if (Array.isArray(responseData.mathVals)) responseData.mathVals = maskBudgetGrid(responseData.mathVals);
    }

    return res.status(200).json({
      success: true,
      fromCache: result.fromCache,
      fromMemory: result.fromMemory,
      fromRedis: result.fromRedis,
      staleRevalidating: result.staleRevalidating,
      data: responseData,
      cachedAt: result.cachedAt,
    });
  } catch (err) {
    console.error("❌ /api/portal/budget error:", err);
    return res.status(500).json({ success: false, error: sessionUser?.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
  }
}
