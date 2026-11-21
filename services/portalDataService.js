import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import { memoryCache, trackRedisKeyForClient } from "./cacheService.js";
import { redisClient, ensureRedisConnected } from "./redisClient.js";
import { formatCurrencyString, parseMoney } from "./deepDiveHelper.js";
import { getAllClients } from "./workspaces.js";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import { formatGridForDisplay } from "./gasRuntime/sheetValueUtils.js";

export const PORTAL_L1_TTL_SECS = 60;
export const PORTAL_REDIS_TTL_SECS = 86400; // 24h Redis SWR retention

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PERCENT_ROW_INDICES = new Set([19, 27, 31, 33]);
const DASHBOARD_MONTH_COL_RANGES = [
  [6, 17],
  [21, 32],
  [36, 47],
];

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

function getLondonYearMonth(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "numeric",
    }).formatToParts(now);
    const yr = parseInt(parts.find((p) => p.type === "year")?.value || "", 10);
    const mon = parseInt(parts.find((p) => p.type === "month")?.value || "", 10);
    if (Number.isFinite(yr) && Number.isFinite(mon) && mon >= 1 && mon <= 12) {
      return { year: yr, month0: mon - 1 };
    }
  } catch (_) {}
  return { year: now.getFullYear(), month0: now.getMonth() };
}

function addMonthsYM(year, month0, deltaMonths) {
  const d = new Date(Date.UTC(year, month0 + deltaMonths, 1));
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth() };
}

function ymKey(year, month0) {
  return `${year}-${String(month0 + 1).padStart(2, "0")}`;
}

function parseSheetMonthHeader(dispVal, mathVal) {
  if (typeof mathVal === "number" && Number.isFinite(mathVal) && mathVal >= 20000 && mathVal <= 80000) {
    const dt = new Date(Math.round((Math.floor(mathVal) - 25569) * 86400000));
    const y = dt.getUTCFullYear();
    const m0 = dt.getUTCMonth();
    return {
      year: y,
      month0: m0,
      label: dispVal ? String(dispVal).trim() : `${MONTHS_SHORT[m0]} ${String(y).slice(-2)}`,
    };
  }
  const parsed = parseMonthYear(dispVal);
  if (parsed) {
    return {
      year: parsed.getFullYear(),
      month0: parsed.getMonth(),
      label: String(dispVal).trim(),
    };
  }
  return null;
}

function buildMonthColumnLookup({ dashDisp = [], dashMath = [], year0Disp = [], year0Math = [] }) {
  const map = new Map();
  // Year0Data!G1:T34 (monthly cols 0..11)
  for (let c = 0; c < 12; c++) {
    const parsed = parseSheetMonthHeader(year0Disp[0]?.[c], year0Math[0]?.[c]);
    if (parsed) {
      map.set(ymKey(parsed.year, parsed.month0), {
        source: "year0",
        colIdx: c,
        dispGrid: year0Disp,
        mathGrid: year0Math,
        label: parsed.label,
      });
    }
  }
  // Dashboard!A1:AX34 (Year 1: 6..17, Year 2: 21..32, Year 3: 36..47)
  for (const [startC, endC] of DASHBOARD_MONTH_COL_RANGES) {
    for (let c = startC; c <= endC; c++) {
      const parsed = parseSheetMonthHeader(dashDisp[0]?.[c], dashMath[0]?.[c]);
      if (parsed) {
        map.set(ymKey(parsed.year, parsed.month0), {
          source: "dashboard",
          colIdx: c,
          dispGrid: dashDisp,
          mathGrid: dashMath,
          label: parsed.label,
        });
      }
    }
  }
  return map;
}

function normalizeYesNoFlag(val, fallback = "Yes") {
  const s = String(val ?? "").trim().toLowerCase();
  if (!s) return fallback;
  if (s === "no" || s === "false" || s === "0") return "No";
  if (s === "yes" || s === "true" || s === "1") return "Yes";
  return String(val).trim();
}

function extractMarginRatio_(rawMath, rawDisp, rev, profit, thousandsSeparator) {
  if (typeof rawMath === "number" && Number.isFinite(rawMath)) {
    const dispStr = String(rawDisp ?? "").trim();
    const dispNum = parseFloat(dispStr.replace(/[£$€,\s%]/g, ""));
    if (Math.abs(rawMath) > 1 && Number.isFinite(dispNum) && Math.abs(rawMath - dispNum) < 1) {
      return rawMath / 100;
    }
    return rawMath;
  }
  if (rawDisp !== undefined && rawDisp !== null && String(rawDisp).trim() !== "") {
    const dispStr = String(rawDisp).trim();
    const p = parseMoney(dispStr, thousandsSeparator);
    return dispStr.includes("%") || Math.abs(p) > 1 ? p / 100 : p;
  }
  return rev ? profit / rev : 0;
}

function parseCellMathValue_(rawMath, valDisp, isPercentRow, thousandsSeparator) {
  if (typeof rawMath === "number") return rawMath;
  if (!valDisp) return null;
  const parsed = parseMoney(valDisp, thousandsSeparator);
  return isPercentRow && String(valDisp).includes("%") ? parsed / 100 : parsed;
}

async function getCachedPortalFeatureFlags(cleanClientId, clientName = "") {
  if (!cleanClientId) return null;
  const cacheKey = `pulse:portal:flags:${cleanClientId}`;
  const cached = memoryCache.get(cacheKey);
  if (cached) return cached;

  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  try {
    let clientRow = null;
    const cleanStr = String(cleanClientId).trim();
    if (cleanStr.startsWith("sb-client-")) {
      const { data: normRows } = await supabase
        .from("clients")
        .select("id, client_name, version_in_use, webapp_version")
        .eq("normalized_key", cleanStr.slice("sb-client-".length))
        .limit(1);
      clientRow = normRows?.[0] || null;
    } else {
      const { data: idRows } = await supabase
        .from("clients")
        .select("id, client_name, version_in_use, webapp_version")
        .eq("client_sheet_id", cleanStr)
        .limit(1);
      clientRow = idRows?.[0] || null;
    }
    const trimmedName = String(clientName || "").trim();
    if (!clientRow && trimmedName) {
      const { data: nameRows } = await supabase
        .from("clients")
        .select("id, client_name, version_in_use, webapp_version")
        .eq("client_name", trimmedName)
        .limit(1);
      clientRow = nameRows?.[0] || null;
    }
    const resolvedName = clientRow?.client_name || trimmedName;

    let flags = null;
    if (resolvedName) {
      const { data: tkiRows } = await supabase
        .from("tenant_key_info")
        .select("portal_feature_flags")
        .eq("client_name", resolvedName)
        .limit(1);
      flags = tkiRows?.[0]?.portal_feature_flags || null;
    }

    const result = {
      ...(flags && typeof flags === "object" ? flags : {}),
      version:
        (flags && typeof flags === "object" && flags.version) ||
        clientRow?.version_in_use ||
        clientRow?.webapp_version ||
        "",
    };
    memoryCache.set(cacheKey, result, PORTAL_L1_TTL_SECS);
    return result;
  } catch (err) {
    console.warn(`[portalDataService] Feature flags fallback warning for ${cleanClientId}:`, err?.message);
    return null;
  }
}

export function clearPortalFeatureFlagsMemoryCache(cleanClientId) {
  if (!cleanClientId) return;
  memoryCache.del(`pulse:portal:flags:${cleanClientId}`);
}

function formatMonthCellForPortal(i, rawDisp, rawMath, currencySymbol, thousandsSeparator) {
  if (i === 0) {
    if (rawDisp !== undefined && rawDisp !== null && String(rawDisp).trim() !== "") {
      return String(rawDisp).trim();
    }
    const parsed = parseSheetMonthHeader(rawDisp, rawMath);
    return parsed?.label || "";
  }
  if (i === 1) {
    return rawDisp !== undefined && rawDisp !== null && String(rawDisp).trim() !== ""
      ? String(rawDisp)
      : "Forecast";
  }
  if (PERCENT_ROW_INDICES.has(i)) {
    const dispStr = rawDisp !== undefined && rawDisp !== null ? String(rawDisp).trim() : "";
    if (dispStr.includes("%")) return dispStr;
    if (typeof rawMath === "number" && Number.isFinite(rawMath)) {
      return `${Math.round(rawMath * 100)}%`;
    }
    if (dispStr !== "" && !Number.isNaN(Number(dispStr))) {
      return `${Math.round(Number(dispStr) * 100)}%`;
    }
    return dispStr;
  }
  const dispStr = rawDisp !== undefined && rawDisp !== null ? String(rawDisp) : "";
  if (dispStr !== "") {
    if (typeof rawMath === "number" && Number.isFinite(rawMath) && !/[£$€¥%]/.test(dispStr)) {
      return formatCurrencyString(Math.round(rawMath), 0, currencySymbol, thousandsSeparator);
    }
    return formatCurrencyString(dispStr, null, currencySymbol, thousandsSeparator);
  }
  if (typeof rawMath === "number" && Number.isFinite(rawMath)) {
    return formatCurrencyString(Math.round(rawMath), 0, currencySymbol, thousandsSeparator);
  }
  return "";
}

/**
 * Builds the exact Portal Home payload from KeyInfo, Dashboard, and Year0Data grids
 * (or legacy AppData grids when supplied directly).
 */
export function buildPortalPayloadFromGrids({
  keyInfoData = [],
  dashDisp = [],
  dashMath = [],
  year0Disp = [],
  year0Math = [],
  thresholdsRaw = [],
  featureFlags = {},
  appDataDisp = [],
  toggles = [],
  chartRawRows = [],
  clientName = "",
}) {
  const hasSourceTabs = Array.isArray(dashDisp) && dashDisp.length > 0;
  const labelGrid = hasSourceTabs ? dashDisp : appDataDisp;

  // --- 1. Client Info (from KeyInfo & feature flags) ---
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

  const version = featureFlags?.version || toggles[0]?.[0] || appDataDisp[39]?.[22] || keyInfoData[0]?.[0] || "";
  const showExtraRows =
    normalizeYesNoFlag(
      featureFlags?.showStaffCostsRatio ?? toggles[2]?.[0] ?? appDataDisp[41]?.[22],
      "Yes"
    ).toLowerCase() === "yes";
  const hasCash =
    normalizeYesNoFlag(
      featureFlags?.showCashMenu ?? toggles[3]?.[0] ?? appDataDisp[42]?.[22],
      "Yes"
    ).toLowerCase() === "yes";
  const hasBudget =
    normalizeYesNoFlag(
      featureFlags?.showBudget ?? toggles[4]?.[0] ?? appDataDisp[43]?.[22],
      "Yes"
    ).toLowerCase() === "yes";
  const numRows = showExtraRows ? 34 : 32;

  const zeroCcy = `${currencySymbol}0`;

  // --- 2. Month Breakdowns (Curr, Prev, Next) ---
  let currMonthData;
  let prevMonthData;
  let nextMonthData;

  if (hasSourceTabs) {
    const monthColMap = buildMonthColumnLookup({ dashDisp, dashMath, year0Disp, year0Math });
    const londonYM = getLondonYearMonth();

    const extractMonthFromSource = (offsetMonths, bannerKind) => {
      const targetYM = addMonthsYM(londonYM.year, londonYM.month0, offsetMonths);
      const entry = monthColMap.get(ymKey(targetYM.year, targetYM.month0));
      const rows = [];
      for (let i = 0; i < numRows; i++) {
        let label = labelGrid[i]?.[0] !== undefined ? String(labelGrid[i][0]) : "";
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
        const rawDisp = entry ? entry.dispGrid?.[i]?.[entry.colIdx] : i === 0 ? `${MONTHS_SHORT[targetYM.month0]} ${String(targetYM.year).slice(-2)}` : "";
        const rawMath = entry ? entry.mathGrid?.[i]?.[entry.colIdx] : undefined;
        const val = formatMonthCellForPortal(i, rawDisp, rawMath, currencySymbol, thousandsSeparator);
        rows.push({
          rowIndex: i + 1,
          label,
          value: val,
        });
      }

      const revTopic = String(rows[2]?.label || (mode === "Income" ? "income" : "revenue")).trim().toLowerCase() || "revenue";
      const revText = rows[8]?.value || zeroCcy;
      const gpText = rows[17]?.value || zeroCcy;
      const gpPctText = rows[19]?.value || "0%";
      const opText = rows[29]?.value || zeroCcy;
      const opPctText = rows[31]?.value || "0%";
      const prefix =
        bannerKind === "prev"
          ? `Last month’s ${revTopic} was`
          : bannerKind === "next"
            ? `Next month’s ${revTopic} is forecast to be`
            : `This month’s ${revTopic} is forecast to be`;
      const hText = `${prefix}\n${revText}\nwith gross profit of  ${gpText}  (${gpPctText})\nand operating profit of  ${opText}  (${opPctText})`;

      const mPeriod = rows[0]?.value || "";
      const mStatus = rows[1]?.value || "Forecast";
      return { rows, tableRows: rows, headerText: hText, monthPeriod: mPeriod, monthStatus: mStatus };
    };

    currMonthData = extractMonthFromSource(0, "curr");
    prevMonthData = extractMonthFromSource(-1, "prev");
    nextMonthData = extractMonthFromSource(1, "next");
  } else {
    const extractMonthDataLegacy = (labelCol, valCol, headerRowIdx) => {
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

    currMonthData = extractMonthDataLegacy(55, 56, 40);
    prevMonthData = extractMonthDataLegacy(73, 74, 40);
    nextMonthData = extractMonthDataLegacy(64, 65, 40);
  }

  const tableRows = currMonthData.rows;
  const headerText = currMonthData.headerText;

  // Thresholds: KeyInfo!B123:B140 (or legacy AppData!Z42:Z59)
  const thresholds = [];
  if (Array.isArray(thresholdsRaw) && thresholdsRaw.length > 0) {
    for (let i = 0; i < 18; i++) {
      thresholds.push(thresholdsRaw[i] !== undefined && thresholdsRaw[i] !== null ? String(thresholdsRaw[i]) : "");
    }
  } else {
    for (let i = 41; i <= 58; i++) {
      thresholds.push(appDataDisp[i]?.[25] || "");
    }
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

  // --- 3. Trailing 12-Month Chart Data ---
  let chartData = { showChart: false, showTrendlines: false };
  if (hasSourceTabs) {
    const showChart =
      normalizeYesNoFlag(featureFlags?.showLast12MonthsChart, "Yes").toLowerCase() === "yes";
    const showTrendlines =
      normalizeYesNoFlag(featureFlags?.showTrendlines, "Yes").toLowerCase() === "yes";

    if (showChart) {
      const monthColMap = buildMonthColumnLookup({ dashDisp, dashMath, year0Disp, year0Math });
      const londonYM = getLondonYearMonth();
      const monthsFormatted = [];
      const revenue = [];
      const grossProfit = [];
      const operatingProfit = [];

      const readNumericCell = (entry, rowIdx) => {
        if (!entry) return 0;
        const mVal = entry.mathGrid?.[rowIdx]?.[entry.colIdx];
        if (typeof mVal === "number" && Number.isFinite(mVal)) return mVal;
        const dVal = entry.dispGrid?.[rowIdx]?.[entry.colIdx];
        if (dVal !== undefined && dVal !== null && String(dVal).trim() !== "") {
          return parseMoney(dVal, thousandsSeparator);
        }
        return 0;
      };

      for (let offset = -11; offset <= 0; offset++) {
        const ym = addMonthsYM(londonYM.year, londonYM.month0, offset);
        const entry = monthColMap.get(ymKey(ym.year, ym.month0));
        const fallbackLabel = `${MONTHS_SHORT[ym.month0]} ${String(ym.year).slice(-2)}`;
        monthsFormatted.push(entry?.label || fallbackLabel);
        revenue.push(readNumericCell(entry, 8));
        grossProfit.push(readNumericCell(entry, 17));
        operatingProfit.push(readNumericCell(entry, 29));
      }

      const row9Label = String(dashDisp[8]?.[0] || "").trim().toLowerCase();
      chartData = {
        showChart: true,
        showTrendlines,
        months: monthsFormatted,
        revenue,
        grossProfit,
        operatingProfit,
        label1: row9Label === "total revenue" ? "Revenue" : row9Label === "total income" ? "Income" : mode === "Income" ? "Income" : "Revenue",
        label2: "Gross profit",
        label3: "Operating profit",
      };
    }
  } else {
    const switchValues = chartRawRows[0] || [];
    const showChart = String(switchValues[0] || "").trim().toLowerCase() === "yes";
    const showTrendlines = String(switchValues[2] || "").trim().toLowerCase() === "yes";

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
  }

  // --- 4. 48-Month Timeline for "At a glance" deltas & multi-year sparklines ---
  const glanceTimeline = [];
  const glanceBlockConfigs = hasSourceTabs
    ? [
        { yIdx: 0, start: 0, disp: year0Disp, math: year0Math },
        { yIdx: 1, start: 6, disp: dashDisp, math: dashMath },
        { yIdx: 2, start: 21, disp: dashDisp, math: dashMath },
        { yIdx: 3, start: 36, disp: dashDisp, math: dashMath },
      ]
    : [
        { yIdx: 0, start: 82, disp: appDataDisp, math: [] },
        { yIdx: 1, start: 6, disp: appDataDisp, math: [] },
        { yIdx: 2, start: 21, disp: appDataDisp, math: [] },
        { yIdx: 3, start: 36, disp: appDataDisp, math: [] },
      ];

  const readGlanceCellNum = (blk, rowIdx, colIdx) => {
    const rawM = blk.math?.[rowIdx]?.[colIdx];
    if (typeof rawM === "number" && Number.isFinite(rawM)) return rawM;
    const rawD = blk.disp?.[rowIdx]?.[colIdx];
    if (rawD !== undefined && rawD !== null && String(rawD).trim() !== "") {
      return parseMoney(rawD, thousandsSeparator);
    }
    return 0;
  };

  for (const blk of glanceBlockConfigs) {
    for (let m = 0; m < 12; m++) {
      const colIdx = blk.start + m;
      const rawHeaderDisp = blk.disp?.[0]?.[colIdx];
      const rawHeaderMath = blk.math?.[0]?.[colIdx];
      const parsedHeader = parseSheetMonthHeader(rawHeaderDisp, rawHeaderMath);
      const monthStr = String(rawHeaderDisp || parsedHeader?.label || `M${m + 1}`).trim();
      const rev = readGlanceCellNum(blk, 8, colIdx);
      const gp = readGlanceCellNum(blk, 17, colIdx);
      const op = readGlanceCellNum(blk, 29, colIdx);
      const gpMargin = extractMarginRatio_(blk.math?.[19]?.[colIdx], blk.disp?.[19]?.[colIdx], rev, gp, thousandsSeparator);
      const opMargin = extractMarginRatio_(blk.math?.[31]?.[colIdx], blk.disp?.[31]?.[colIdx], rev, op, thousandsSeparator);
      glanceTimeline.push({
        yIdx: blk.yIdx,
        mIdx: m,
        monthStr,
        year: parsedHeader?.year ?? null,
        month0: parsedHeader?.month0 ?? null,
        rev,
        gp,
        op,
        gpMargin,
        opMargin,
      });
    }
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
    glanceTimeline,
    months: {
      curr: { ...currMonthData, thresholds },
      prev: { ...prevMonthData, thresholds },
      next: { ...nextMonthData, thresholds },
    },
  };
}

/**
 * Builds the exact Portal Performance payload from KeyInfo, Dashboard, and Year0Data grids
 * (or legacy AppData grids when supplied directly).
 */
export function buildPortalPerformanceFromGrids({
  keyInfoData = [],
  dashDisp = [],
  dashMath = [],
  year0Disp = [],
  year0Math = [],
  featureFlags = {},
  appDataDisp = [],
  appDataMath = [],
  toggles = [],
  thresholdsRaw = [],
}) {
  const hasSourceTabs = Array.isArray(dashDisp) && dashDisp.length > 0;
  const labelGrid = hasSourceTabs ? dashDisp : appDataDisp;

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

  const version = featureFlags?.version || toggles[0]?.[0] || appDataDisp[39]?.[22] || keyInfoData[0]?.[0] || "";
  const showExtraRows =
    normalizeYesNoFlag(
      featureFlags?.showStaffCostsRatio ?? toggles[2]?.[0] ?? appDataDisp[41]?.[22],
      "Yes"
    ) === "Yes";
  const numRows = showExtraRows ? 34 : 32;

  const thresholds = thresholdsRaw.slice(0, 18).map((v) => {
    if (typeof v === "number") return v > 1 ? v / 100 : v;
    const s = String(v || "").replace(/%/g, "").trim();
    const n = parseFloat(s);
    if (isNaN(n)) return 0;
    return String(v).includes("%") || n > 1 ? n / 100 : n;
  });

  const yearBlockConfigs = hasSourceTabs
    ? [
        { id: "hist", name: "Historical Year", start: 0, count: 14, disp: year0Disp, math: year0Math },
        { id: "year1", name: "Year 1", start: 6, count: 14, disp: dashDisp, math: dashMath },
        { id: "year2", name: "Year 2", start: 21, count: 14, disp: dashDisp, math: dashMath },
        { id: "year3", name: "Year 3", start: 36, count: 14, disp: dashDisp, math: dashMath },
      ]
    : [
        { id: "hist", name: "Historical Year", start: 82, count: 14, disp: appDataDisp, math: appDataMath },
        { id: "year1", name: "Year 1", start: 6, count: 14, disp: appDataDisp, math: appDataMath },
        { id: "year2", name: "Year 2", start: 21, count: 14, disp: appDataDisp, math: appDataMath },
        { id: "year3", name: "Year 3", start: 36, count: 14, disp: appDataDisp, math: appDataMath },
      ];

  const today = new Date();
  let currentYearIdx = 1;
  let fallbackIdx = 0;

  for (let bi = 0; bi < yearBlockConfigs.length; bi++) {
    const blk = yearBlockConfigs[bi];
    const firstMonthStr = blk.disp[0]?.[blk.start];
    const firstMonthMath = blk.math[0]?.[blk.start];
    const parsedHeader = parseSheetMonthHeader(firstMonthStr, firstMonthMath);
    const d = parsedHeader ? new Date(parsedHeader.year, parsedHeader.month0, 1) : parseMonthYear(firstMonthStr);

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
    lineItemLabels.push(labelGrid[i]?.[0] !== undefined ? String(labelGrid[i][0]).trim() : "");
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
    const srcDisp = blk.disp || [];
    const srcMath = blk.math || [];
    const headerMonths = [];
    for (let j = 0; j < 12; j++) {
      const mStr = srcDisp[0]?.[blk.start + j] || `M${j + 1}`;
      headerMonths.push(String(mStr).trim());
    }
    const totalColHeader = srcDisp[0]?.[blk.start + 13] || "FY Total";

    const monthStatuses = [];
    for (let j = 0; j < 12; j++) {
      monthStatuses.push(srcDisp[1]?.[blk.start + j] || "Forecast");
    }

    const rows = [];
    for (let i = 0; i < numRows; i++) {
      const label = lineItemLabels[i];
      const monthlyValues = [];
      const monthlyMath = [];

      for (let j = 0; j < 12; j++) {
        const colIdx = blk.start + j;
        const valDisp = srcDisp[i]?.[colIdx] !== undefined ? String(srcDisp[i][colIdx]).trim() : "";
        const rawMath = srcMath[i]?.[colIdx];
        const valMath = parseCellMathValue_(rawMath, valDisp, PERCENT_ROW_INDICES.has(i), thousandsSeparator);
        if (PERCENT_ROW_INDICES.has(i)) {
          const pctStr = valDisp.includes("%")
            ? valDisp
            : typeof rawMath === "number" && Number.isFinite(rawMath)
              ? `${Math.round(rawMath * 100)}%`
              : valDisp;
          monthlyValues.push(pctStr);
        } else if (i > 1 && typeof rawMath === "number" && Number.isFinite(rawMath) && valDisp && !/[£$€¥%]/.test(valDisp)) {
          monthlyValues.push(formatCurrencyString(Math.round(rawMath), 0, currencySymbol, thousandsSeparator));
        } else {
          monthlyValues.push(formatCurrencyString(valDisp, null, currencySymbol, thousandsSeparator));
        }
        monthlyMath.push(valMath);
      }

      const rawTotalVal =
        srcDisp[i]?.[blk.start + 13] !== undefined ? String(srcDisp[i][blk.start + 13]).trim() : "";
      const rawTotalMath = srcMath[i]?.[blk.start + 13];
      let totalVal;
      if (PERCENT_ROW_INDICES.has(i)) {
        totalVal = rawTotalVal.includes("%")
          ? rawTotalVal
          : typeof rawTotalMath === "number" && Number.isFinite(rawTotalMath)
            ? `${Math.round(rawTotalMath * 100)}%`
            : rawTotalVal;
      } else if (
        i > 1 &&
        typeof rawTotalMath === "number" &&
        Number.isFinite(rawTotalMath) &&
        rawTotalVal &&
        !/[£$€¥%]/.test(rawTotalVal)
      ) {
        totalVal = formatCurrencyString(Math.round(rawTotalMath), 0, currencySymbol, thousandsSeparator);
      } else {
        totalVal = formatCurrencyString(rawTotalVal, null, currencySymbol, thousandsSeparator);
      }
      const totalMath = parseCellMathValue_(rawTotalMath, rawTotalVal, PERCENT_ROW_INDICES.has(i), thousandsSeparator);

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

function savePortalHomeToCaches_(cleanClientId, payload, performanceData) {
  const payloadKey = `pulse:portal:payload:${cleanClientId}`;
  const perfKey = `pulse:portal:performance:${cleanClientId}`;
  memoryCache.set(payloadKey, payload, PORTAL_L1_TTL_SECS);
  memoryCache.set(perfKey, performanceData, PORTAL_L1_TTL_SECS);
  if (redisClient?.isOpen) {
    Promise.all([
      redisClient.set(payloadKey, JSON.stringify(payload), { EX: PORTAL_REDIS_TTL_SECS }),
      redisClient.set(perfKey, JSON.stringify(performanceData), { EX: PORTAL_REDIS_TTL_SECS }),
      trackRedisKeyForClient(payloadKey),
      trackRedisKeyForClient(perfKey),
    ]).catch((err) => {
      console.warn(`[portalDataService] Redis cache write warning for ${cleanClientId}:`, err?.message);
    });
  }
}

const _inFlightHomeBuilds = new Map();

/**
 * Fetches KeyInfo, Dashboard, and Year0Data directly (Formatted + Unformatted) in parallel
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
          ranges: ["KeyInfo!A1:J21", "KeyInfo!B123:B148", "Dashboard!A1:AX34", "Year0Data!G1:T34"],
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
      withRetry(() =>
        activeSheets.spreadsheets.values.batchGet({
          spreadsheetId: cleanClientId,
          ranges: ["Dashboard!A1:AX34", "Year0Data!G1:T34"],
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      ),
    ]);

    const fmtRanges = formattedResp.data?.valueRanges || [];
    const keyInfoData = fmtRanges[0]?.values || [];
    const keyInfoRulesAndFlags = fmtRanges[1]?.values || [];
    const dashDisp = fmtRanges[2]?.values || [];
    const year0Disp = fmtRanges[3]?.values || [];

    const unfmtRanges = unformattedResp.data?.valueRanges || [];
    const dashMath = unfmtRanges[0]?.values || [];
    const year0Math = unfmtRanges[1]?.values || [];

    // Extract thresholds from KeyInfo!B123:B140 (indices 0..17 of B123:B148)
    const thresholdsRaw = [];
    for (let r = 0; r < 18; r++) {
      thresholdsRaw.push(keyInfoRulesAndFlags[r]?.[0] ?? "");
    }

    // Extract the 6 Pulse UI feature switches from KeyInfo!B143:B148 (indices 20..25 of B123:B148)
    const sheetFlagRaw = {
      showStaffCostsRatio: String(keyInfoRulesAndFlags[20]?.[0] ?? "").trim(),
      showCashMenu: String(keyInfoRulesAndFlags[21]?.[0] ?? "").trim(),
      showBudget: String(keyInfoRulesAndFlags[22]?.[0] ?? "").trim(),
      showCashflowChart: String(keyInfoRulesAndFlags[23]?.[0] ?? "").trim(),
      showLast12MonthsChart: String(keyInfoRulesAndFlags[24]?.[0] ?? "").trim(),
      showTrendlines: String(keyInfoRulesAndFlags[25]?.[0] ?? "").trim(),
    };

    const hasMissingSheetFlags = Object.values(sheetFlagRaw).some((v) => !v);
    const dbFallbackFlags = hasMissingSheetFlags
      ? await getCachedPortalFeatureFlags(cleanClientId, keyInfoData[0]?.[1] || clientName)
      : null;

    const featureFlags = {
      version: dbFallbackFlags?.version || keyInfoData[0]?.[0] || "",
      showStaffCostsRatio: normalizeYesNoFlag(
        sheetFlagRaw.showStaffCostsRatio || dbFallbackFlags?.showStaffCostsRatio,
        "Yes"
      ),
      showCashMenu: normalizeYesNoFlag(
        sheetFlagRaw.showCashMenu || dbFallbackFlags?.showCashMenu,
        "Yes"
      ),
      showBudget: normalizeYesNoFlag(
        sheetFlagRaw.showBudget || dbFallbackFlags?.showBudget,
        "Yes"
      ),
      showCashflowChart: normalizeYesNoFlag(
        sheetFlagRaw.showCashflowChart || dbFallbackFlags?.showCashflowChart,
        "Yes"
      ),
      showLast12MonthsChart: normalizeYesNoFlag(
        sheetFlagRaw.showLast12MonthsChart || dbFallbackFlags?.showLast12MonthsChart,
        "Yes"
      ),
      showTrendlines: normalizeYesNoFlag(
        sheetFlagRaw.showTrendlines || dbFallbackFlags?.showTrendlines,
        "Yes"
      ),
    };

    const payload = buildPortalPayloadFromGrids({
      keyInfoData,
      dashDisp,
      dashMath,
      year0Disp,
      year0Math,
      thresholdsRaw,
      featureFlags,
      clientName,
    });

    const performanceData = buildPortalPerformanceFromGrids({
      keyInfoData,
      dashDisp,
      dashMath,
      year0Disp,
      year0Math,
      thresholdsRaw,
      featureFlags,
    });

    if (saveToCache) {
      savePortalHomeToCaches_(cleanClientId, payload, performanceData);
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
 * Re-warms the Portal Home & Performance caches directly in RAM from freshly evaluated
 * virtual Client Sheet grids (zero extra DB or Google Sheets round-trips).
 */
export async function warmPortalHomeFromVirtualGrids({
  clientSheetId,
  clientName = "",
  keyInfoValues = [],
  dashboardValues = [],
  year0Values = [],
} = {}) {
  const cleanClientId = unwrapSheetId(extractSheetIdFromUrl(clientSheetId) || clientSheetId);
  if (!cleanClientId || !Array.isArray(dashboardValues) || dashboardValues.length === 0) return null;

  const keyInfoTopRaw = keyInfoValues.slice(0, 21).map((r) => (Array.isArray(r) ? r.slice(0, 10) : []));
  const keyInfoData = formatGridForDisplay("client", "KeyInfo", keyInfoTopRaw, 0, 0, keyInfoValues);

  const keyInfoRulesSlice = [];
  for (let r = 122; r <= 147; r++) {
    keyInfoRulesSlice.push([keyInfoValues[r]?.[1] ?? ""]);
  }
  const keyInfoRulesDisp = formatGridForDisplay("client", "KeyInfo", keyInfoRulesSlice, 122, 1, keyInfoValues);

  const dashMath = dashboardValues.slice(0, 34).map((r) => (Array.isArray(r) ? r.slice(0, 50) : []));
  const dashDisp = formatGridForDisplay("client", "Dashboard", dashMath, 0, 0, dashboardValues);

  const year0Math = year0Values.slice(0, 34).map((r) => (Array.isArray(r) ? r.slice(6, 20) : []));
  const year0Disp = formatGridForDisplay("client", "Year0Data", year0Math, 0, 6, year0Values);

  const thresholdsRaw = [];
  for (let r = 0; r < 18; r++) {
    thresholdsRaw.push(keyInfoRulesDisp[r]?.[0] ?? "");
  }

  const sheetFlagRaw = {
    showStaffCostsRatio: String(keyInfoRulesDisp[20]?.[0] ?? "").trim(),
    showCashMenu: String(keyInfoRulesDisp[21]?.[0] ?? "").trim(),
    showBudget: String(keyInfoRulesDisp[22]?.[0] ?? "").trim(),
    showCashflowChart: String(keyInfoRulesDisp[23]?.[0] ?? "").trim(),
    showLast12MonthsChart: String(keyInfoRulesDisp[24]?.[0] ?? "").trim(),
    showTrendlines: String(keyInfoRulesDisp[25]?.[0] ?? "").trim(),
  };

  const hasMissingSheetFlags = Object.values(sheetFlagRaw).some((v) => !v);
  const dbFallbackFlags = hasMissingSheetFlags
    ? await getCachedPortalFeatureFlags(cleanClientId, keyInfoData[0]?.[1] || clientName)
    : null;

  const featureFlags = {
    version: dbFallbackFlags?.version || keyInfoData[0]?.[0] || "",
    showStaffCostsRatio: normalizeYesNoFlag(
      sheetFlagRaw.showStaffCostsRatio || dbFallbackFlags?.showStaffCostsRatio,
      "Yes"
    ),
    showCashMenu: normalizeYesNoFlag(
      sheetFlagRaw.showCashMenu || dbFallbackFlags?.showCashMenu,
      "Yes"
    ),
    showBudget: normalizeYesNoFlag(
      sheetFlagRaw.showBudget || dbFallbackFlags?.showBudget,
      "Yes"
    ),
    showCashflowChart: normalizeYesNoFlag(
      sheetFlagRaw.showCashflowChart || dbFallbackFlags?.showCashflowChart,
      "Yes"
    ),
    showLast12MonthsChart: normalizeYesNoFlag(
      sheetFlagRaw.showLast12MonthsChart || dbFallbackFlags?.showLast12MonthsChart,
      "Yes"
    ),
    showTrendlines: normalizeYesNoFlag(
      sheetFlagRaw.showTrendlines || dbFallbackFlags?.showTrendlines,
      "Yes"
    ),
  };

  const payload = buildPortalPayloadFromGrids({
    keyInfoData,
    dashDisp,
    dashMath,
    year0Disp,
    year0Math,
    thresholdsRaw,
    featureFlags,
    clientName,
  });

  const performanceData = buildPortalPerformanceFromGrids({
    keyInfoData,
    dashDisp,
    dashMath,
    year0Disp,
    year0Math,
    thresholdsRaw,
    featureFlags,
  });

  savePortalHomeToCaches_(cleanClientId, payload, performanceData);
  return { payload, performanceData };
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
    if (!performanceData) {
      if (!redisClient?.isOpen) {
        try { await ensureRedisConnected(400); } catch (_) {}
      }
      if (redisClient?.isOpen) {
        try {
          const rawPerf = await Promise.race([
            redisClient.get(perfKey),
            new Promise((resolve) => setTimeout(() => resolve(null), 500)),
          ]);
          if (rawPerf) {
            performanceData = JSON.parse(rawPerf);
            memoryCache.set(perfKey, performanceData, PORTAL_L1_TTL_SECS);
          }
        } catch (_) {}
      }
    }
    return { payload: null, performanceData: performanceData || null };
  }

  let payload = memoryCache.get(payloadKey);
  let performanceData = memoryCache.get(perfKey);

  if (!payload || !performanceData) {
    if (!redisClient?.isOpen) {
      try { await ensureRedisConnected(400); } catch (_) {}
    }
    if (redisClient?.isOpen) {
      try {
        const pair = await Promise.race([
          redisClient.mGet([payloadKey, perfKey]),
          new Promise((resolve) => setTimeout(() => resolve(null), 500)),
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
