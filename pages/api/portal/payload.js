import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { matchesClientName } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache } from "../../../services/cacheService.js";

const PAYLOAD_CACHE_TTL_SECS = 60; // 60 seconds cache

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

  // Authorization check: Only Admin is global.
  // Consultants & clients can only query sheets for their authorized clients.
  if (!sessionUser.isAdmin && clientName) {
    const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
    const isAuthorized = assignedList.some((assigned) => matchesClientName(assigned, clientName));
    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client" });
    }
  }

  const cacheKey = `pulse:portal:payload:${clientSheetId}`;

  // 1. Try L1 Memory Cache first (sub-millisecond)
  if (!bypassCache) {
    const memCached = memoryCache.get(cacheKey);
    if (memCached && (memCached.hasBudget !== undefined || memCached.clientInfo?.hasBudget !== undefined)) {
      return res.status(200).json({
        success: true,
        fromCache: true,
        fromMemory: true,
        payload: memCached,
        cachedAt: memCached._cachedAt || null,
      });
    }

    // 2. Try Redis cache (distributed L2)
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.hasBudget !== undefined || parsed.clientInfo?.hasBudget !== undefined) {
          memoryCache.set(cacheKey, parsed, PAYLOAD_CACHE_TTL_SECS);
          return res.status(200).json({
            success: true,
            fromCache: true,
            fromRedis: true,
            payload: parsed,
            cachedAt: parsed._cachedAt || null,
          });
        }
      }
    } catch (cacheErr) {
      console.warn("⚠️ Portal payload Redis read error:", cacheErr.message);
    }
  }

  // 2. Fetch fresh data from Google Sheets API via Service Account
  try {
    const sheets = await getSheetsClient();

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
    const currencySymbol = keyInfoData[3]?.[3] || "£";
    const thousandsSeparator = keyInfoData[4]?.[3] || ",";
    const vatRate = parseFloat(keyInfoData[8]?.[1]) || 0.2;
    const splitMethod = keyInfoData[14]?.[3] || "Even By Month";
    const splitEnabled = keyInfoData[15]?.[3] === "Yes";
    const authMode = keyInfoData[4]?.[9] ? String(keyInfoData[4][9]).trim() : "EmailOTP";

    const version = toggles[0]?.[0] || appDataDisp[39]?.[22] || ""; // W40
    const showExtraRows = String(toggles[2]?.[0] || appDataDisp[41]?.[22] || "").trim().toLowerCase() === "yes"; // W42
    const hasCash = String(toggles[3]?.[0] || appDataDisp[42]?.[22] || "").trim().toLowerCase() === "yes"; // W43
    const hasBudget = String(toggles[4]?.[0] || appDataDisp[43]?.[22] || "").trim().toLowerCase() === "yes"; // W44
    const numRows = showExtraRows ? 34 : 32;

    // --- 2. Month Breakdowns (Curr: BD:BE, Prev: BV:BW, Next: BM:BN) ---
    const extractMonthData = (labelCol, valCol, headerRowIdx) => {
      const rows = [];
      for (let i = 0; i < numRows; i++) {
        const label = appDataDisp[i]?.[labelCol] !== undefined ? String(appDataDisp[i][labelCol]) : "";
        const val = appDataDisp[i]?.[valCol] !== undefined ? String(appDataDisp[i][valCol]) : "";
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
    const revenueFormatted = findRowVal(["Total revenue", "Total income", "Revenue", "Income"]) || "£0";
    const confirmedFormatted = findRowVal(["Confirmed revenue", "Confirmed income", "Confirmed"]) || "£0";
    const pipelineFormatted = findRowVal(["Pipeline revenue", "Pipeline income", "Pipeline"]) || "£0";
    const newBizFormatted = findRowVal(["New business to find", "New business", "New biz"]) || "£0";
    const costOfSalesFormatted = findRowVal(["Total costs of sale", "Total cost of sales", "Cost of sales", "Costs of sale"]) || "£0";
    const grossProfitFormatted = findRowVal(["Gross profit"]) || "£0";
    const grossMarginPercent = findRowVal(["Gross profit margin", "Gross margin"]) || "0%";
    const overheadsFormatted = findRowVal(["Total overheads", "Overheads"]) || "£0";
    const overheadsPercent = findRowVal(["Overheads as %", "Overheads %"]) || "0%";
    const operatingProfitFormatted = findRowVal(["Operating profit"]) || "£0";
    const operatingMarginPercent = findRowVal(["Operating profit %", "Operating margin"]) || "0%";
    const staffCostsDelivery = findRowVal(["Staff costs - delivery", "Staff costs delivery"]) || "£0";
    const staffCostsNonDelivery = findRowVal(["Staff costs - non-delivery", "Staff costs non-delivery"]) || "£0";
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
      clientInfo: {
        name: sheetClientName,
        version,
        currencySymbol,
        thousandsSeparator,
        vatRate,
        hasBudget,
        hasCash,
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

    // Cache in L1 memory and Redis
    memoryCache.set(cacheKey, payload, PAYLOAD_CACHE_TTL_SECS);
    redisClient
      .set(cacheKey, JSON.stringify(payload), { EX: PAYLOAD_CACHE_TTL_SECS })
      .catch((err) => console.warn("⚠️ Failed to write portal payload to Redis:", err.message));

    return res.status(200).json({
      success: true,
      fromCache: false,
      payload,
    });
  } catch (err) {
    console.error("❌ /api/portal/payload error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
