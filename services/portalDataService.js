import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import { memoryCache } from "./cacheService.js";
import { redisClient } from "./redisClient.js";
import { formatCurrencyString, parseMoney } from "./deepDiveHelper.js";
import { getAllClients } from "./workspaces.js";

export const PORTAL_L1_TTL_SECS = 60;
export const PORTAL_REDIS_TTL_SECS = 86400; // 24h Redis SWR retention

function parseMonthYear(str) {
  if (!str) return null;
  const match = String(str).trim().match(/^([a-zA-Z]{3})[\s\-](\d{2,4})$/);
  if (match) {
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
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

/**
 * Builds the exact Portal Home payload from KeyInfo!A1:J20 and AppData!A1:CR90 grids.
 */
export function buildPortalPayloadFromGrids({
  keyInfoData = [],
  appDataDisp = [],
  toggles = [],
  chartRawRows = [],
  clientName = "",
}) {
  // --- 1. Client Info (from KeyInfo & AppData) ---
  const sheetClientName = keyInfoData[0]?.[1] || clientName || "";
  const currencySymbol =
    String(
      keyInfoData[3]?.[3] ||
        (keyInfoData[3]?.[2] && keyInfoData[3]?.[2] !== "Tracker currency" ? keyInfoData[3]?.[2] : "") ||
        "£"
    ).trim() || "£";
  const thousandsSeparator =
    String(
      keyInfoData[4]?.[3] ||
        (keyInfoData[4]?.[2] && keyInfoData[4]?.[2] !== "Thous. separator" ? keyInfoData[4]?.[2] : "") ||
        ","
    ).trim() || ",";
  const vatRate = parseFloat(keyInfoData[8]?.[1]) || 0.2;
  const splitMethod = keyInfoData[14]?.[3] || "Even By Month";
  const splitEnabled = keyInfoData[15]?.[3] === "Yes";
  const authMode = keyInfoData[4]?.[9] ? String(keyInfoData[4][9]).trim() : "EmailOTP";
  const rawFocus = String(keyInfoData[14]?.[1] || "").trim();
  const mode = rawFocus.toLowerCase() === "income" ? "Income" : "Revenue";
  const rawDirectCostsMode = String(keyInfoData[7]?.[3] || "").trim();
  const directCostsMode =
    mode === "Income"
      ? "Pass-through"
      : rawDirectCostsMode.toLowerCase().includes("pass")
        ? "Pass-through"
        : "Contractors";
  const jobCostingStyleRaw = String(keyInfoData[10]?.[3] || "").trim();
  const isJobCosting = jobCostingStyleRaw.toLowerCase().replace(/[\s_-]+/g, "") === "jobcosting";
  const jobCostingStyle = isJobCosting ? "JobCosting" : "Standard";
  const standardChargeOutRate = parseFloat(String(keyInfoData[11]?.[3] || "0").replace(/[£$€,\s]/g, "")) || 0;
  const contractorDayRate = parseFloat(String(keyInfoData[12]?.[3] || "0").replace(/[£$€,\s]/g, "")) || 0;

  const version = toggles[0]?.[0] || appDataDisp[39]?.[22] || ""; // W40
  const showExtraRows = String(toggles[2]?.[0] || appDataDisp[41]?.[22] || "").trim().toLowerCase() === "yes"; // W42
  const hasCash = String(toggles[3]?.[0] || appDataDisp[42]?.[22] || "").trim().toLowerCase() === "yes"; // W43
  const hasBudget = String(toggles[4]?.[0] || appDataDisp[43]?.[22] || "").trim().toLowerCase() === "yes"; // W44
  const numRows = showExtraRows ? 34 : 32;

  // --- 2. Month Breakdowns (Curr: BD:BE, Prev: BV:BW, Next: BM:BN) ---
  const extractMonthData = (labelCol, valCol, headerRowIdx) => {
    const rows = [];
    for (let i = 0; i < numRows; i++) {
      let label = appDataDisp[i]?.[labelCol] !== undefined ? String(appDataDisp[i][labelCol]) : "";
      const lowerLabel = label.trim().toLowerCase();
      if (splitEnabled && mode === "Revenue") {
        if (i === 12) {
          label = directCostsMode === "Pass-through" ? "Pass-through costs" : "Other expenses - delivery";
        } else if (i === 13) {
          label = directCostsMode === "Pass-through" ? "Other expenses - delivery" : "Hide";
        }
      } else if (lowerLabel === "direct costs" || lowerLabel === "pass-through costs") {
        label = mode === "Revenue" && directCostsMode === "Pass-through" ? "Pass-through costs" : "Hide";
      }
      let val = appDataDisp[i]?.[valCol] !== undefined ? String(appDataDisp[i][valCol]) : "";
      if (i > 1 && val && !val.includes("%")) {
        val = formatCurrencyString(val, null, currencySymbol, thousandsSeparator);
      }
      rows.push({
        rowIndex: i + 1,
        label,
        value: val,
      });
    }
    const hText = appDataDisp[headerRowIdx]?.[labelCol] || "";
    const mPeriod = rows[0]?.value || "";
    const mStatus = rows[1]?.value || "Forecast";
    return { rows, tableRows: rows, headerText: hText, monthPeriod: mPeriod, monthStatus: mStatus };
  };

  const currMonthData = extractMonthData(55, 56, 40);
  const prevMonthData = extractMonthData(73, 74, 40);
  const nextMonthData = extractMonthData(64, 65, 40);

  const tableRows = currMonthData.rows;
  const headerText = currMonthData.headerText;

  // Thresholds: Z42:Z59 (indices 41 to 58)
  const thresholds = [];
  for (let i = 41; i <= 58; i++) {
    thresholds.push(appDataDisp[i]?.[25] || "");
  }

  // Parse KPI values from the month rows
  const normalizeLabel = (str) =>
    String(str || "")
      .replace(/[\u2010-\u2015]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const findRowVal = (namePrefixes) => {
    const prefixes = (Array.isArray(namePrefixes) ? namePrefixes : [namePrefixes]).map(normalizeLabel);
    const found = tableRows.find((r) => {
      if (!r.label || !r.value || !String(r.value).trim()) return false;
      const norm = normalizeLabel(r.label);
      return prefixes.some((p) => norm.startsWith(p));
    });
    return found ? found.value : "";
  };

  const monthPeriod = tableRows[0]?.value || "";
  const monthStatus = tableRows[1]?.value || "Forecast";
  const zeroCcy = `${currencySymbol}0`;
  const revenueFormatted = findRowVal(["Total revenue", "Total income", "Revenue", "Income"]) || zeroCcy;
  const confirmedFormatted = findRowVal(["Confirmed revenue", "Confirmed income", "Confirmed"]) || zeroCcy;
  const pipelineFormatted = findRowVal(["Pipeline revenue", "Pipeline income", "Pipeline"]) || zeroCcy;
  const newBizFormatted = findRowVal(["New business to find", "New business", "New biz"]) || zeroCcy;
  const costOfSalesFormatted =
    findRowVal(["Total costs of sale", "Total cost of sales", "Cost of sales", "Costs of sale"]) || zeroCcy;
  const grossProfitFormatted = findRowVal(["Gross profit"]) || zeroCcy;
  const grossMarginPercent = findRowVal(["Gross profit margin", "Gross margin"]) || "0%";
  const overheadsFormatted = findRowVal(["Total overheads", "Overheads"]) || zeroCcy;
  const overheadsPercent = findRowVal(["Overheads as %", "Overheads %"]) || "0%";
  const operatingProfitFormatted = findRowVal(["Operating profit"]) || zeroCcy;
  const operatingMarginPercent = findRowVal(["Operating profit %", "Operating margin"]) || "0%";
  const staffCostsDelivery = findRowVal(["Staff costs - delivery", "Staff costs delivery"]) || zeroCcy;
  const staffCostsNonDelivery = findRowVal(["Staff costs - non-delivery", "Staff costs non-delivery"]) || zeroCcy;
  const staffRatio = findRowVal(["Staff costs to income", "Staff costs to revenue", "Staff ratio"]) || "0%";

  // --- 3. Chart Data (Rows 71-90) ---
  const switchValues = chartRawRows[0] || [];
  const showChart = String(switchValues[0] || "").trim().toLowerCase() === "yes";
  const showTrendlines = String(switchValues[2] || "").trim().toLowerCase() === "yes";

  let chartData = { showChart: false, showTrendlines: false };
  if (showChart) {
    const monthsFormatted = [];
    const revenue = [];
    const grossProfit = [];
    const operatingProfit = [];

    const monthRow = appDataDisp[86] || [];
    const revRow = chartRawRows[17] || [];
    const gpRow = chartRawRows[18] || [];
    const opRow = chartRawRows[19] || [];

    for (let j = 7; j <= 18; j++) {
      const m = monthRow[j];
      const cCol = j - 6;
      if (m && String(m).trim() !== "") {
        monthsFormatted.push(String(m).trim());
        revenue.push(parseFloat(revRow[cCol]) || 0);
        grossProfit.push(parseFloat(gpRow[cCol]) || 0);
        operatingProfit.push(parseFloat(opRow[cCol]) || 0);
      }
    }

    chartData = {
      showChart: true,
      showTrendlines,
      months: monthsFormatted,
      revenue,
      grossProfit,
      operatingProfit,
      label1: revRow[0] ? String(revRow[0]).trim() : "Income",
      label2: gpRow[0] ? String(gpRow[0]).trim() : "Gross profit",
      label3: opRow[0] ? String(opRow[0]).trim() : "Operating profit",
    };
  }

  return {
    _cachedAt: new Date().toISOString(),
    hasBudget,
    hasCash,
    mode,
    directCostsMode,
    isJobCosting,
    jobCostingStyle,
    standardChargeOutRate,
    contractorDayRate,
    currencySymbol,
    thousandsSeparator,
    clientInfo: {
      name: sheetClientName,
      version,
      currencySymbol,
      thousandsSeparator,
      vatRate,
      hasBudget,
      hasCash,
      mode,
      directCostsMode,
      isJobCosting,
      jobCostingStyle,
      standardChargeOutRate,
      contractorDayRate,
      splitMethod,
      splitEnabled,
      authMode,
    },
    currMonth: {
      headerText,
      monthPeriod,
      monthStatus,
      thresholds,
      tableRows,
      kpis: {
        revenue: revenueFormatted,
        confirmedIncome: confirmedFormatted,
        pipelineIncome: pipelineFormatted,
        newBizIncome: newBizFormatted,
        costOfSales: costOfSalesFormatted,
        grossProfit: grossProfitFormatted,
        grossMarginPercent,
        overheads: overheadsFormatted,
        overheadsPercent,
        operatingProfit: operatingProfitFormatted,
        operatingMarginPercent,
        staffCostsDelivery,
        staffCostsNonDelivery,
        staffRatio,
      },
    },
    chartData,
    months: {
      curr: { ...currMonthData, thresholds },
      prev: { ...prevMonthData, thresholds },
      next: { ...nextMonthData, thresholds },
    },
  };
}

/**
 * Builds the exact Portal Performance payload from KeyInfo!A1:J20 and AppData!A1:CR90 grids.
 */
export function buildPortalPerformanceFromGrids({
  keyInfoData = [],
  appDataDisp = [],
  appDataMath = [],
  toggles = [],
  thresholdsRaw = [],
}) {
  const mode = String(keyInfoData[14]?.[1] || "Revenue").trim();
  const rawDirectCostsMode = String(keyInfoData[7]?.[3] || "Contractors").trim();
  const directCostsMode =
    mode.toLowerCase() === "income"
      ? "Pass-through"
      : rawDirectCostsMode === "Pass-through"
        ? "Pass-through"
        : "Contractors";

  const currencySymbol =
    String(
      keyInfoData[3]?.[3] ||
        (keyInfoData[3]?.[2] && keyInfoData[3]?.[2] !== "Tracker currency" ? keyInfoData[3]?.[2] : "") ||
        "£"
    ).trim() || "£";
  const thousandsSeparator =
    String(
      keyInfoData[4]?.[3] ||
        (keyInfoData[4]?.[2] && keyInfoData[4]?.[2] !== "Thous. separator" ? keyInfoData[4]?.[2] : "") ||
        ","
    ).trim() || ",";

  const version = toggles[0]?.[0] || appDataDisp[39]?.[22] || ""; // W40
  const showExtraRows = (toggles[2]?.[0] || appDataDisp[41]?.[22]) === "Yes"; // W42
  const numRows = showExtraRows ? 34 : 32;

  const thresholds = thresholdsRaw.slice(0, 18).map((v) => {
    if (typeof v === "number") return v > 1 ? v / 100 : v;
    const s = String(v || "").replace(/%/g, "").trim();
    const n = parseFloat(s);
    if (isNaN(n)) return 0;
    return String(v).includes("%") || n > 1 ? n / 100 : n;
  });

  const yearBlockConfigs = [
    { id: "hist", name: "Historical Year", start: 82, count: 14 },
    { id: "year1", name: "Year 1", start: 6, count: 14 },
    { id: "year2", name: "Year 2", start: 21, count: 14 },
    { id: "year3", name: "Year 3", start: 36, count: 14 },
  ];

  const today = new Date();
  let currentYearIdx = 1;
  let fallbackIdx = 0;

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

  const lineItemLabels = [];
  for (let i = 0; i < numRows; i++) {
    lineItemLabels.push(appDataDisp[i]?.[0] !== undefined ? String(appDataDisp[i][0]).trim() : "");
  }
  if (mode.toLowerCase() !== "income" && lineItemLabels.length > 13 && lineItemLabels[11]) {
    if (directCostsMode === "Contractors") {
      lineItemLabels[12] = "Other expenses - delivery";
      lineItemLabels[13] = "Hide";
    } else if (directCostsMode === "Pass-through") {
      lineItemLabels[12] = "Pass-through costs";
      lineItemLabels[13] = "Other expenses - delivery";
    }
  }

  const years = yearBlockConfigs.map((blk, yIdx) => {
    const headerMonths = [];
    for (let j = 0; j < 12; j++) {
      const mStr = appDataDisp[0]?.[blk.start + j] || `M${j + 1}`;
      headerMonths.push(String(mStr).trim());
    }
    const totalColHeader = appDataDisp[0]?.[blk.start + 13] || "FY Total";

    const monthStatuses = [];
    for (let j = 0; j < 12; j++) {
      monthStatuses.push(appDataDisp[1]?.[blk.start + j] || "Forecast");
    }

    const rows = [];
    for (let i = 0; i < numRows; i++) {
      const label = lineItemLabels[i];
      const monthlyValues = [];
      const monthlyMath = [];

      for (let j = 0; j < 12; j++) {
        const colIdx = blk.start + j;
        const valDisp = appDataDisp[i]?.[colIdx] !== undefined ? String(appDataDisp[i][colIdx]).trim() : "";
        const rawMath = appDataMath[i]?.[colIdx];
        const valMath =
          typeof rawMath === "number" ? rawMath : valDisp ? parseMoney(valDisp, thousandsSeparator) : null;
        monthlyValues.push(formatCurrencyString(valDisp, null, currencySymbol, thousandsSeparator));
        monthlyMath.push(valMath);
      }

      const rawTotalVal =
        appDataDisp[i]?.[blk.start + 13] !== undefined ? String(appDataDisp[i][blk.start + 13]).trim() : "";
      const rawTotalMath = appDataMath[i]?.[blk.start + 13];
      const totalVal = formatCurrencyString(rawTotalVal, null, currencySymbol, thousandsSeparator);
      const totalMath =
        typeof rawTotalMath === "number"
          ? rawTotalMath
          : rawTotalVal
            ? parseMoney(rawTotalVal, thousandsSeparator)
            : null;

      rows.push({
        rowIndex: i + 1,
        label,
        monthlyValues,
        monthlyMath,
        totalVal,
        totalMath,
      });
    }

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

  return {
    _cachedAt: new Date().toISOString(),
    currencySymbol,
    thousandsSeparator,
    mode,
    directCostsMode,
    version,
    showExtraRows,
    numRows,
    currentYearIdx,
    thresholds,
    lineItemLabels,
    years,
  };
}

const _inFlightHomeBuilds = new Map();

/**
 * Fetches KeyInfo!A1:J20 and AppData!A1:CR90 (Formatted + Unformatted) in a single pass
 * and constructs BOTH the Portal Home payload AND the Performance dataset simultaneously.
 * Coalesces concurrent requests for the same clientSheetId and saves both to L1 Memory and L2 Redis.
 */
export async function fetchAndBuildPortalHomeAndPerformance(
  sheets,
  rawOrWrappedClientSheetId,
  clientName = "",
  { saveToCache = true } = {}
) {
  const cleanClientId = unwrapSheetId(extractSheetIdFromUrl(rawOrWrappedClientSheetId) || rawOrWrappedClientSheetId);
  if (!cleanClientId) throw new Error("clientSheetId is required");

  if (_inFlightHomeBuilds.has(cleanClientId)) {
    return _inFlightHomeBuilds.get(cleanClientId);
  }

  const buildPromise = (async () => {
    const activeSheets = sheets || (await getSheetsClient());

    const [formattedResp, unformattedResp] = await Promise.all([
      withRetry(() =>
        activeSheets.spreadsheets.values.batchGet({
          spreadsheetId: cleanClientId,
          ranges: ["KeyInfo!A1:J20", "AppData!A1:CR90"],
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
      withRetry(() =>
        activeSheets.spreadsheets.values.get({
          spreadsheetId: cleanClientId,
          range: "AppData!A1:CR90",
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      ),
    ]);

    const keyInfoData = formattedResp.data.valueRanges?.[0]?.values || [];
    const appDataDisp = formattedResp.data.valueRanges?.[1]?.values || [];
    // Extract AppData!W40:W44 (rows 40..44 -> 0-indexed 39..43, col W -> 0-indexed 22)
    const toggles = [];
    for (let r = 39; r <= 43; r++) {
      toggles.push([appDataDisp[r]?.[22] ?? ""]);
    }
    const appDataMath = unformattedResp.data?.values || [];

    // Extract AppData!G71:S90 (rows 71..90 -> 0-indexed 70..89, cols G..S -> 0-indexed 6..18)
    const chartRawRows = [];
    for (let r = 70; r < 90; r++) {
      const row = appDataMath[r] || [];
      chartRawRows.push(row.slice(6, 19));
    }

    // Extract AppData!Z42:Z59 (rows 42..59 -> 0-indexed 41..58, col Z -> 0-indexed 25)
    const thresholdsRaw = [];
    for (let r = 41; r <= 58; r++) {
      thresholdsRaw.push(appDataDisp[r]?.[25] ?? "");
    }

    const payload = buildPortalPayloadFromGrids({
      keyInfoData,
      appDataDisp,
      toggles,
      chartRawRows,
      clientName,
    });

    const performanceData = buildPortalPerformanceFromGrids({
      keyInfoData,
      appDataDisp,
      appDataMath,
      toggles,
      thresholdsRaw,
    });

    if (saveToCache) {
      const payloadKey = `pulse:portal:payload:${cleanClientId}`;
      const perfKey = `pulse:portal:performance:${cleanClientId}`;
      memoryCache.set(payloadKey, payload, PORTAL_L1_TTL_SECS);
      memoryCache.set(perfKey, performanceData, PORTAL_L1_TTL_SECS);
      if (redisClient?.isOpen) {
        Promise.all([
          redisClient.set(payloadKey, JSON.stringify(payload), { EX: PORTAL_REDIS_TTL_SECS }),
          redisClient.set(perfKey, JSON.stringify(performanceData), { EX: PORTAL_REDIS_TTL_SECS }),
        ]).catch((err) => {
          console.warn(`[portalDataService] Redis cache write warning for ${cleanClientId}:`, err?.message);
        });
      }
    }

    return { payload, performanceData, cleanClientId };
  })();

  _inFlightHomeBuilds.set(cleanClientId, buildPromise);
  try {
    return await buildPromise;
  } finally {
    _inFlightHomeBuilds.delete(cleanClientId);
  }
}

/**
 * Reads cached Portal Home (payload + performanceData) from L1 Memory or L2 Redis (<5ms)
 * for SSR hydration or sibling cache lookup.
 */
export async function getCachedPortalHomeAndPerformance(rawOrWrappedClientSheetId, { perfOnly = false } = {}) {
  const cleanClientId = unwrapSheetId(extractSheetIdFromUrl(rawOrWrappedClientSheetId) || rawOrWrappedClientSheetId);
  if (!cleanClientId) return { payload: null, performanceData: null };

  const payloadKey = `pulse:portal:payload:${cleanClientId}`;
  const perfKey = `pulse:portal:performance:${cleanClientId}`;

  if (perfOnly) {
    let performanceData = memoryCache.get(perfKey);
    if (!performanceData && redisClient?.isOpen) {
      try {
        const rawPerf = await Promise.race([
          redisClient.get(perfKey),
          new Promise((resolve) => setTimeout(() => resolve(null), 120)),
        ]);
        if (rawPerf) {
          performanceData = JSON.parse(rawPerf);
          memoryCache.set(perfKey, performanceData, PORTAL_L1_TTL_SECS);
        }
      } catch (_) {}
    }
    return { payload: null, performanceData: performanceData || null };
  }

  let payload = memoryCache.get(payloadKey);
  let performanceData = memoryCache.get(perfKey);

  if ((!payload || !performanceData) && redisClient?.isOpen) {
    try {
      const pair = await Promise.race([
        redisClient.mGet([payloadKey, perfKey]),
        new Promise((resolve) => setTimeout(() => resolve(null), 150)),
      ]);
      if (Array.isArray(pair)) {
        if (!payload && pair[0]) {
          payload = JSON.parse(pair[0]);
        }
        if (!performanceData && pair[1]) {
          performanceData = JSON.parse(pair[1]);
        }
      }
    } catch (_) {}
  }

  return { payload: payload || null, performanceData: performanceData || null };
}

/**
 * Background pre-warmer for active clients' Pulse Home Page caches (payload + performanceData).
 * Called by /api/cron to ensure every active client's Pulse Home Page is warm in Redis 24/7.
 */
export async function warmAllClientsPortalHomeCache({
  sheets = null,
  maxClientsPerRun = 25,
  minStaleAgeMs = 20 * 60 * 1000, // Refresh if missing or older than 20 minutes
} = {}) {
  try {
    const activeSheets = sheets || (await getSheetsClient({ pool: "background" }));
    const { clientsArray } = await getAllClients(activeSheets, { isAdmin: true }, false);
    if (!Array.isArray(clientsArray) || clientsArray.length === 0) {
      return { warmed: 0, skipped: 0 };
    }

    const candidates = [];
    const now = Date.now();

    for (const c of clientsArray) {
      const cleanId = unwrapSheetId(extractSheetIdFromUrl(c.clientSheetId) || c.clientSheetId);
      if (!cleanId) continue;
      candidates.push({ clientName: c.clientName, cleanId });
    }

    let existingPayloads = [];
    if (redisClient?.isOpen && candidates.length > 0) {
      try {
        const keys = candidates.map((c) => `pulse:portal:payload:${c.cleanId}`);
        existingPayloads = await redisClient.mGet(keys);
      } catch (_) {}
    }

    const toWarm = [];
    candidates.forEach((c, idx) => {
      const raw = existingPayloads[idx];
      if (!raw) {
        toWarm.push({ ...c, ageMs: Infinity });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const cachedAtMs = parsed?._cachedAt ? new Date(parsed._cachedAt).getTime() : 0;
        const ageMs = cachedAtMs ? now - cachedAtMs : Infinity;
        if (ageMs >= minStaleAgeMs) {
          toWarm.push({ ...c, ageMs });
        }
      } catch {
        toWarm.push({ ...c, ageMs: Infinity });
      }
    });

    // Prioritize missing/oldest caches first
    toWarm.sort((a, b) => b.ageMs - a.ageMs);
    const batch = toWarm.slice(0, maxClientsPerRun);

    let warmed = 0;
    const CONCURRENCY = 2;
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const slice = batch.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async (item) => {
          try {
            await fetchAndBuildPortalHomeAndPerformance(activeSheets, item.cleanId, item.clientName, {
              saveToCache: true,
            });
            warmed++;
          } catch (err) {
            console.warn(`[warmAllClientsPortalHomeCache] Skip ${item.clientName}:`, err?.message);
          }
        })
      );
    }

    return { warmed, skipped: candidates.length - warmed, totalCandidates: candidates.length };
  } catch (err) {
    console.warn("[warmAllClientsPortalHomeCache] Error:", err?.message);
    return { warmed: 0, skipped: 0, error: err?.message };
  }
}
