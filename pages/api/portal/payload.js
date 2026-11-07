import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet } from "../../../services/userPermissions.js";
import { resolvePortalCache } from "../../../services/cacheService.js";
import { formatCurrencyString } from "../../../services/deepDiveHelper.js";

const PAYLOAD_CACHE_TTL_SECS = 60; // 60s L1 fresh window
const PAYLOAD_REDIS_TTL_SECS = 900; // 15m Redis SWR retention

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

  const cacheKey = `pulse:portal:payload:${clientSheetId}`;

  try {
    const result = await resolvePortalCache({
      cacheKey,
      bypassCache,
      isAutoRefresh,
      isReadOnly: Boolean(sessionUser.isReadOnly),
      l1TtlSecs: PAYLOAD_CACHE_TTL_SECS,
      redisTtlSecs: PAYLOAD_REDIS_TTL_SECS,
      isValidPayload: (p) => p && (p.hasBudget !== undefined || p.clientInfo?.hasBudget !== undefined),
      fetchFreshFn: async () => {
        // Perform batch reads in parallel for maximum speed
        const [formattedResp, unformattedChartResp] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: clientSheetId,
          ranges: ["KeyInfo!A1:J20", "AppData!A1:BW90", "AppData!W40:W44"],
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: "AppData!G71:S90",
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      ),
    ]);

    const keyInfoData = formattedResp.data.valueRanges?.[0]?.values || [];
    const appDataDisp = formattedResp.data.valueRanges?.[1]?.values || [];
    const toggles = formattedResp.data.valueRanges?.[2]?.values || [];
    const chartRawRows = unformattedChartResp.data?.values || [];

    // --- 1. Client Info (from KeyInfo & AppData) ---
    const sheetClientName = keyInfoData[0]?.[1] || clientName || "";
    const currencySymbol = String(keyInfoData[3]?.[3] || (keyInfoData[3]?.[2] && keyInfoData[3]?.[2] !== "Tracker currency" ? keyInfoData[3]?.[2] : "") || "£").trim() || "£";
    const thousandsSeparator = String(keyInfoData[4]?.[3] || (keyInfoData[4]?.[2] && keyInfoData[4]?.[2] !== "Thous. separator" ? keyInfoData[4]?.[2] : "") || ",").trim() || ",";
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
        .replace(/[\u2010-\u2015]/g, "-") // normalize en-dash / em-dash to hyphen
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

    const monthPeriod = tableRows[0]?.value || ""; // Oct 26
    const monthStatus = tableRows[1]?.value || "Forecast"; // Forecast or Actual
    const zeroCcy = `${currencySymbol}0`;
    const revenueFormatted = findRowVal(["Total revenue", "Total income", "Revenue", "Income"]) || zeroCcy;
    const confirmedFormatted = findRowVal(["Confirmed revenue", "Confirmed income", "Confirmed"]) || zeroCcy;
    const pipelineFormatted = findRowVal(["Pipeline revenue", "Pipeline income", "Pipeline"]) || zeroCcy;
    const newBizFormatted = findRowVal(["New business to find", "New business", "New biz"]) || zeroCcy;
    const costOfSalesFormatted = findRowVal(["Total costs of sale", "Total cost of sales", "Cost of sales", "Costs of sale"]) || zeroCcy;
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
    // Row 71 in sheet is index 0 of chartRawRows
    const switchValues = chartRawRows[0] || [];
    const showChart = String(switchValues[0] || "").trim().toLowerCase() === "yes";
    const showTrendlines = String(switchValues[2] || "").trim().toLowerCase() === "yes";

    let chartData = { showChart: false, showTrendlines: false };
    if (showChart) {
      // Row 87 = months (index 16), Row 88 = revenue (index 17), Row 89 = gross profit (index 18), Row 90 = op profit (index 19)
      const monthsFormatted = [];
      const revenue = [];
      const grossProfit = [];
      const operatingProfit = [];

      const monthRow = appDataDisp[86] || []; // formatted month names (Nov 25, Dec 25...)
      const revRow = chartRawRows[17] || [];
      const gpRow = chartRawRows[18] || [];
      const opRow = chartRawRows[19] || [];

      for (let j = 7; j <= 18; j++) {
        // cols H-S in appDataDisp (indices 7 to 18) -> cols H-S in chartRawRows (indices 1 to 12)
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

    const payload = {
      _cachedAt: new Date().toISOString(),
      hasBudget,
      hasCash,
      mode,
      directCostsMode,
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
    return payload;
  },
});

    return res.status(200).json({
      success: true,
      fromCache: result.fromCache,
      fromMemory: result.fromMemory,
      fromRedis: result.fromRedis,
      staleRevalidating: result.staleRevalidating,
      payload: result.data,
      cachedAt: result.cachedAt,
    });
  } catch (err) {
    console.error("❌ /api/portal/payload error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
