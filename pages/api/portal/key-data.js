import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache } from "../../../services/cacheService.js";
import { parseMoney, formatMoney } from "../../../services/deepDiveHelper.js";

const KEYDATA_CACHE_TTL_SECS = 60; // 60s cache

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
  const type = String(req.query.type || req.body?.type || "all").toLowerCase().trim();
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

  // Directly block access to Salaries and Dividends datasets for Senior (Restricted) users
  // Matching webappserver.gs lines 3371-3372 and 3393-3395
  if (isSeniorUser && (type === "salaries" || type === "dividends")) {
    return res.status(403).json({
      success: false,
      error: `Permission Denied: ${type === "salaries" ? "Salaries" : "Dividends"}`,
    });
  }

  const sanitizeForUser = (data) => {
    if (!isSeniorUser || !data) return data;
    return {
      ...data,
      salaries: null,
      outgoings: data.outgoings ? {
        ...data.outgoings,
        dividends: null,
      } : data.outgoings,
    };
  };

  const cacheKey = `pulse:portal:keydata:${clientSheetId}:${type}`;

  // 1. Check L1 Memory Cache
  if (!bypassCache) {
    const memCached = memoryCache.get(cacheKey);
    if (memCached) {
      return res.status(200).json({
        success: true,
        fromCache: true,
        fromMemory: true,
        data: sanitizeForUser(memCached),
        cachedAt: memCached._cachedAt || null,
      });
    }

    // 2. Check Redis cache
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        memoryCache.set(cacheKey, parsed, KEYDATA_CACHE_TTL_SECS);
        return res.status(200).json({
          success: true,
          fromCache: true,
          fromRedis: true,
          data: sanitizeForUser(parsed),
          cachedAt: parsed._cachedAt || null,
        });
      }
    } catch (cacheErr) {
      console.warn("⚠️ KeyData Redis read warning:", cacheErr.message);
    }
  }

  // 2. Fetch fresh data from Google Sheets API
  try {
    // Check what sheets exist in the spreadsheet
    const metaResp = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: clientSheetId,
        fields: "sheets.properties.title",
      })
    );
    const existingSheetTitles = new Set(
      (metaResp.data?.sheets || []).map((s) => s.properties?.title)
    );

    const hasConfirmed = existingSheetTitles.has("Confirmed") || existingSheetTitles.has("ConfCalcs");
    const confirmedTitle = existingSheetTitles.has("ConfCalcs") ? "ConfCalcs" : "Confirmed";

    const hasPipeline = existingSheetTitles.has("Pipeline") || existingSheetTitles.has("PipeCalcs");
    const pipelineTitle = existingSheetTitles.has("PipeCalcs") ? "PipeCalcs" : "Pipeline";

    const hasOutgoings = existingSheetTitles.has("Outgoings");
    const hasSalaries = existingSheetTitles.has("Salaries");
    const hasNBtoFind = existingSheetTitles.has("NBtoFind");

    const batchRanges = [];
    if (hasConfirmed) batchRanges.push(`${confirmedTitle}!A1:JF`);
    if (hasPipeline) batchRanges.push(`${pipelineTitle}!A1:JF`);
    if (hasSalaries) {
      batchRanges.push("Salaries!A1:I100");
      batchRanges.push("Salaries!A1:JC1");
      batchRanges.push("Salaries!A304:JC368");
    }
    if (hasOutgoings) batchRanges.push("Outgoings!A1:AV306");
    if (hasNBtoFind) batchRanges.push("NBtoFind!A1:AV50");
    batchRanges.push("KeyInfo!G32:G75"); // Lead sources
    batchRanges.push("KeyInfo!C23:C26"); // Product lines
    batchRanges.push("KeyInfo!F11:F12"); // Profit share % and switch
    batchRanges.push("KeyInfo!B15");     // Mode (Revenue vs Income)
    batchRanges.push("KeyInfo!B20");     // Contractor source
    batchRanges.push("KeyInfo!D15:D16"); // Split method (D15) & split enabled (D16)
    batchRanges.push("KeyInfo!D1");      // Master Sheet URL
    batchRanges.push("KeyInfo!C4:D5");   // Currency and thousands separator

    const batchResp = await withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: clientSheetId,
        ranges: batchRanges,
        valueRenderOption: "FORMATTED_VALUE",
      })
    );

    const valueRanges = batchResp.data.valueRanges || [];
    let rangeIdx = 0;

    const confirmedRows = hasConfirmed ? (valueRanges[rangeIdx++]?.values || []) : [];
    const pipelineRows = hasPipeline ? (valueRanges[rangeIdx++]?.values || []) : [];
    const salariesRows = hasSalaries ? (valueRanges[rangeIdx++]?.values || []) : [];
    const salariesHeadersRow = hasSalaries ? (valueRanges[rangeIdx++]?.values?.[0] || []) : [];
    const salariesDeepDiveRows = hasSalaries ? (valueRanges[rangeIdx++]?.values || []) : [];
    const outgoingsRows = hasOutgoings ? (valueRanges[rangeIdx++]?.values || []) : [];
    const nbtofindRows = hasNBtoFind ? (valueRanges[rangeIdx++]?.values || []) : [];
    const leadSourcesRows = valueRanges[rangeIdx++]?.values || [];
    const productLinesRows = valueRanges[rangeIdx++]?.values || [];
    const profitShareRows = valueRanges[rangeIdx++]?.values || [];
    const modeRows = valueRanges[rangeIdx++]?.values || [];
    const contractorSourceRows = valueRanges[rangeIdx++]?.values || [];
    const splitInfoRows = valueRanges[rangeIdx++]?.values || [];
    const masterUrlRows = valueRanges[rangeIdx++]?.values || [];
    const currencyRows = valueRanges[rangeIdx++]?.values || [];

    const rawCurrencySymbol = String(currencyRows?.[0]?.[1] || (currencyRows?.[0]?.[0] && currencyRows?.[0]?.[0] !== "Tracker currency" ? currencyRows?.[0]?.[0] : "") || "£").trim() || "£";
    let currencySymbol = rawCurrencySymbol;
    if (currencySymbol.toUpperCase() === "EUR" || currencySymbol === "€") currencySymbol = "€";
    else if (currencySymbol.toUpperCase() === "GBP" || currencySymbol === "£") currencySymbol = "£";
    else if (currencySymbol.toUpperCase() === "USD" || currencySymbol === "$") currencySymbol = "$";

    const rawThousandsSeparator = String(currencyRows?.[1]?.[1] || (currencyRows?.[1]?.[0] && currencyRows?.[1]?.[0] !== "Thous. separator" ? currencyRows?.[1]?.[0] : "") || "").trim();
    const thousandsSeparator = rawThousandsSeparator || (currencySymbol === "€" ? "." : ",");

    const leadSources = leadSourcesRows.flat().map((v) => String(v || "").trim()).filter(Boolean);
    const productLines = productLinesRows.flat().map((v) => String(v || "").trim()).filter(Boolean);
    const splitMethod = String(splitInfoRows[0]?.[0] || "Even By Month").trim();
    const splitEnabled = String(splitInfoRows[1]?.[0] || "").trim().toLowerCase() === "yes";

    const profitSharePctRaw = profitShareRows[0]?.[0] || "0%";
    const profitSharePct = parseFloat(String(profitSharePctRaw).replace("%", "")) / 100 || 0;
    const profitShareSwitch = String(profitShareRows[1]?.[0] || "").trim();
    const mode = String(modeRows[0]?.[0] || "Revenue").trim();
    const contractorSource = String(contractorSourceRows[0]?.[0] || "Cell Values").trim();
    const isNotesMode = contractorSource.toLowerCase().includes("notes");
    const masterUrl = String(masterUrlRows[0]?.[0] || "").trim();
    const masterSheetId = extractSheetIdFromUrl(masterUrl);

    // Helper: Safely parse dates, including Google Sheets serial numbers (e.g. 46296 or 55000), returning YYYY-MM-DD
    const formatDateVal = (val) => {
      if (!val && val !== 0) return "";
      if (typeof val === "number" || (!isNaN(Number(val)) && !String(val).includes("-") && !String(val).includes("/"))) {
        const num = Number(val);
        if (num > 30000 && num < 100000) {
          const d = new Date((num - 25569) * 86400 * 1000);
          const y = d.getUTCFullYear();
          const m = String(d.getUTCMonth() + 1).padStart(2, "0");
          const day = String(d.getUTCDate()).padStart(2, "0");
          return `${y}-${m}-${day}`;
        }
      }
      const str = String(val).trim();
      const ukMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if (ukMatch) {
        const y = ukMatch[3];
        const m = String(ukMatch[2]).padStart(2, "0");
        const day = String(ukMatch[1]).padStart(2, "0");
        return `${y}-${m}-${day}`;
      }
      const shortUk = str.match(/^(\d{1,2})[\-\/\s]([a-zA-Z]{3})[\-\/\s](\d{2,4})/);
      if (shortUk) {
        const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
        const mi = months[shortUk[2].toLowerCase()];
        let yr = parseInt(shortUk[3], 10);
        if (yr < 100) yr += 2000;
        if (mi !== undefined) {
          return `${yr}-${mi}-${String(shortUk[1]).padStart(2, "0")}`;
        }
      }
      const d = new Date(str);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      }
      return str;
    };

    // Helper: Safely parse date or month-year strings (e.g. "Jul 2026", "01/07/2026", 46296) to YYYY-MM-DD
    const parseDateToYMD = (val, isEnd = false) => {
      if (!val && val !== 0) return "";
      const str = String(val).trim();
      const myMatch = str.match(/^(?:(\d{1,2})[\/\-\s])?([a-zA-Z]{3,})[\/\-\s](\d{2,4})$/);
      if (myMatch) {
        const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
        const mi = months[myMatch[2].toLowerCase().substring(0, 3)];
        let yr = parseInt(myMatch[3], 10);
        if (yr < 100) yr += 2000;
        if (mi !== undefined) {
          let day = myMatch[1] ? String(myMatch[1]).padStart(2, "0") : (isEnd ? "28" : "01");
          if (isEnd && !myMatch[1]) {
            const lastDay = new Date(yr, parseInt(mi, 10), 0).getDate();
            day = String(lastDay).padStart(2, "0");
          }
          return `${yr}-${mi}-${day}`;
        }
      }
      return formatDateVal(val);
    };

    // Helper: Lookup by header in row
    const getValueByHeader = (row, colMap, headerNames) => {
      const names = Array.isArray(headerNames) ? headerNames : [headerNames];
      for (const name of names) {
        const normalized = name.toLowerCase().trim().replace(/\s+/g, " ");
        if (colMap.hasOwnProperty(normalized)) {
          const val = row[colMap[normalized]];
          if (val !== undefined && val !== null) return String(val).trim();
        }
      }
      return "";
    };

    // Helper: Parse jobs sheet with full parent-child hierarchy matching webappserver.gs
    const parseJobs = (rows, jobType) => {
      if (!rows || rows.length < 2) return [];
      const maxRow = rows.length;

      // Reverse lookup to find real last row containing data
      let realLastRow = 1;
      for (let i = maxRow - 1; i >= 1; i--) {
        const r = rows[i] || [];
        if ((r[0] && String(r[0]).trim() !== "") || (r[1] && String(r[1]).trim() !== "")) {
          realLastRow = i + 1;
          break;
        }
      }

      if (realLastRow < 2) return [];

      const headers = rows[0] || [];
      const colMap = {};
      headers.forEach((h, idx) => {
        if (h) {
          colMap[String(h).toLowerCase().trim().replace(/\s+/g, " ")] = idx;
        }
      });

      const parsed = [];
      let i = 1;

      while (i < realLastRow) {
        const row = rows[i] || [];
        const rowNum = i + 1;

        const client = getValueByHeader(row, colMap, "client");
        const jobName = getValueByHeader(row, colMap, ["job name", "job"]);
        const revenue = getValueByHeader(row, colMap, ["revenue (proj total / ongoing pm) - excl vat", "revenue"]);
        const directCosts = getValueByHeader(row, colMap, ["direct costs (proj total / ongoing pm) - excl vat", "direct costs"]);

        // Skip completely empty rows
        if (!client && !jobName) {
          i++;
          continue;
        }

        // Pipeline: skip if copied to confirmed
        if (jobType === "Pipeline") {
          const copied = getValueByHeader(row, colMap, "copied to confirmed tab?");
          if (copied && copied.toLowerCase() === "yes") {
            i++;
            continue;
          }
        }

        const isParent = (revenue && String(revenue).trim() !== "" && Math.abs(parseMoney(revenue)) > 0.001) ||
                         (directCosts && String(directCosts).trim() !== "" && Math.abs(parseMoney(directCosts)) > 0.001);

        if (isParent) {
          const projectRetainer = getValueByHeader(row, colMap, ["project / retainer", "proj / ret"]) || "Project";
          const isRetainer = projectRetainer.toLowerCase().includes("retainer");

          // Scan subsequent child rows
          let j = i + 1;
          const childRows = [];
          while (j < realLastRow) {
            const nextRow = rows[j] || [];
            const nextClient = getValueByHeader(nextRow, colMap, "client");
            const nextJobName = getValueByHeader(nextRow, colMap, ["job name", "job"]);
            const nextRev = getValueByHeader(nextRow, colMap, ["revenue (proj total / ongoing pm) - excl vat", "revenue"]);
            const nextDC = getValueByHeader(nextRow, colMap, ["direct costs (proj total / ongoing pm) - excl vat", "direct costs"]);

            if (
              nextClient === client &&
              nextJobName === jobName &&
              (!nextRev || String(nextRev).trim() === "" || Math.abs(parseMoney(nextRev)) < 0.001) &&
              (!nextDC || String(nextDC).trim() === "" || Math.abs(parseMoney(nextDC)) < 0.001)
            ) {
              childRows.push({ row: nextRow, rowNum: j + 1 });
              j++;
            } else {
              break;
            }
          }

          // Extract Invoices
          const invoices = [];
          let currentInvNum = 1;

          // Helper to extract invoice data from a row for given slot
          const extractInv = (r, slot) => {
            const amtH = slot === 1
              ? ["project invoice 1 / monthly retainer (excl vat)", "project invoice 1", "inv 1 amount"]
              : [`project invoice ${slot} (excl vat)`, `project invoice ${slot}`, `inv ${slot} amount`];
            const refH = [`inv ${slot} ref`];
            const dateH = [`inv ${slot} send date`, `inv ${slot} date`];
            const daysH = [`inv ${slot} days to pay`, `inv ${slot} days`];
            const statusH = [`inv ${slot} status`];

            const amt = getValueByHeader(r, colMap, amtH);
            const ref = getValueByHeader(r, colMap, refH);
            const sendDateRaw = getValueByHeader(r, colMap, dateH);
            const days = getValueByHeader(r, colMap, daysH) || "30";
            const status = getValueByHeader(r, colMap, statusH) || "";

            if (amt || ref || sendDateRaw) {
              return {
                num: currentInvNum++,
                ref,
                amount: amt,
                status,
                sendDate: formatDateVal(sendDateRaw),
                days,
              };
            }
            return null;
          };

          // Parent invoices
          let parentHasInvoice = false;
          for (let s = 1; s <= 3; s++) {
            const inv = extractInv(row, s);
            if (inv) {
              invoices.push({ ...inv, isChild: false, isParent: true });
              parentHasInvoice = true;
            }
          }

          // Child invoices & Retainer child recognition periods
          const childRetainers = [];
          childRows.forEach((cr) => {
            if (isRetainer) {
              let childInvSum = 0;
              for (let s = 1; s <= 3; s++) {
                const inv = extractInv(cr.row, s);
                if (inv) {
                  invoices.push({ ...inv, isChild: true, childRowNum: cr.rowNum });
                  childInvSum += (Number(inv.amount) || 0);
                }
              }

              const invAmtRaw = getValueByHeader(cr.row, colMap, ["project invoice 1 / monthly retainer (excl vat)", "project invoice 1", "inv 1 amount"]) || cr.row[41];
              const invAmt = childInvSum > 0 ? childInvSum : parseMoney(invAmtRaw);
              const startRaw = cr.row[146] !== undefined && String(cr.row[146]).trim() !== "" ? cr.row[146] : getValueByHeader(cr.row, colMap, ["start month"]);
              const endRaw = cr.row[147] !== undefined && String(cr.row[147]).trim() !== "" ? cr.row[147] : getValueByHeader(cr.row, colMap, ["end month"]);
              const monthsRaw = cr.row[148] !== undefined && String(cr.row[148]).trim() !== "" ? cr.row[148] : getValueByHeader(cr.row, colMap, ["months"]);
              const revPmRaw = cr.row[149] !== undefined && String(cr.row[149]).trim() !== "" ? cr.row[149] : getValueByHeader(cr.row, colMap, ["revenue pm"]);
              const incPmRaw = cr.row[150] !== undefined && String(cr.row[150]).trim() !== "" ? cr.row[150] : getValueByHeader(cr.row, colMap, ["income pm"]);
              const dcPmRaw = cr.row[152] !== undefined && String(cr.row[152]).trim() !== "" ? cr.row[152] : getValueByHeader(cr.row, colMap, ["3p costs pm"]);

              const startMonth = parseDateToYMD(startRaw, false);
              const endMonth = parseDateToYMD(endRaw, true);
              const months = parseInt(monthsRaw, 10) || 1;
              const revPm = parseMoney(revPmRaw) || (months > 0 ? invAmt / months : invAmt);
              const incPm = parseMoney(incPmRaw) || revPm;
              const dcPm = parseMoney(dcPmRaw) || 0;

              if (invAmt > 0 && startMonth && endMonth) {
                childRetainers.push({
                  amount: invAmt,
                  startMonth,
                  endMonth,
                  months,
                  revPm,
                  incPm,
                  dcPm,
                });
              }
            } else {
              for (let s = 1; s <= 3; s++) {
                const inv = extractInv(cr.row, s);
                if (inv) invoices.push({ ...inv, isChild: true, childRowNum: cr.rowNum });
              }
            }
          });

          // Extract Direct Expenses
          const directExpenses = [];
          let currentExpNum = 1;

          const extractExp = (r, slot) => {
            const amtH = [`direct inv ${slot} amt`, `direct inv ${slot} amount`];
            const descH = [`direct inv ${slot} descr.`, `direct inv ${slot} desc`];
            const vatH = [`dir inv. ${slot} vat?`, `dir inv ${slot} vat?`, `direct inv ${slot} vat?`];
            const dateH = [`dir inv. ${slot} rec date`, `direct inv ${slot} rec date`];
            const daysH = [`dir inv ${slot} days to pay`, `dir inv. ${slot} days to pay`];
            const statusH = [`dir inv ${slot} status`];

            const amt = getValueByHeader(r, colMap, amtH);
            const desc = getValueByHeader(r, colMap, descH);
            const vat = getValueByHeader(r, colMap, vatH) || "Yes";
            const recDateRaw = getValueByHeader(r, colMap, dateH);
            const days = getValueByHeader(r, colMap, daysH) || "30";
            const status = getValueByHeader(r, colMap, statusH) || "";

            if (amt || desc || recDateRaw) {
              return {
                num: currentExpNum++,
                desc,
                amount: amt,
                vat,
                recDate: formatDateVal(recDateRaw),
                days,
                status,
              };
            }
            return null;
          };

          for (let s = 1; s <= 3; s++) {
            const exp = extractExp(row, s);
            if (exp) directExpenses.push({ ...exp, isChild: false, isParent: true });
          }
          childRows.forEach((cr) => {
            for (let s = 1; s <= 3; s++) {
              const exp = extractExp(cr.row, s);
              if (exp) directExpenses.push({ ...exp, isChild: true, childRowNum: cr.rowNum });
            }
          });

          const startDateRaw = getValueByHeader(row, colMap, ["start date", "start month"]);
          const endDateRaw = getValueByHeader(row, colMap, ["end date", "end month"]);
          const likelihoodRaw = getValueByHeader(row, colMap, ["% likel.", "% likelihood", "% likely", "likelihood"]);
          const likelihood = likelihoodRaw || (jobType === "Confirmed" ? "100%" : "50%");
          const revNum = parseMoney(revenue);
          const dcNum = parseMoney(directCosts);
          const parsedLikel = parseFloat(String(likelihood).replace("%", ""));
          const likelihoodNum = !isNaN(parsedLikel)
            ? (String(likelihood).includes("%") || parsedLikel >= 1 ? parsedLikel / 100 : parsedLikel)
            : (jobType === "Confirmed" ? 1 : 0.5);

          const startDate = formatDateVal(startDateRaw);
          const endDate = formatDateVal(endDateRaw);

          const rawEqStart = row[146] !== undefined && String(row[146]).trim() !== "" ? row[146] : (getValueByHeader(row, colMap, ["start month"]) || startDateRaw);
          const rawErEnd = row[147] !== undefined && String(row[147]).trim() !== "" ? row[147] : (getValueByHeader(row, colMap, ["end month"]) || endDateRaw);

          const eqStartDate = parseDateToYMD(rawEqStart, false);
          const erEndDate = parseDateToYMD(rawErEnd, true);

          const jobObj = {
            id: `${jobType.toLowerCase()}-${rowNum}`,
            rowNumber: rowNum,
            type: jobType,
            client: client || "General",
            jobName: jobName || `Job #${rowNum}`,
            revenue,
            revNum,
            directCosts,
            dcNum,
            grossProfit: getValueByHeader(row, colMap, ["gross profit"]),
            grossMargin: getValueByHeader(row, colMap, ["margin", "gross profit margin"]),
            productLine: getValueByHeader(row, colMap, ["prod. line", "product line"]),
            leadSource: getValueByHeader(row, colMap, ["lead src", "lead source"]),
            projectRetainer,
            startDate,
            endDate,
            likelihood,
            likelihoodNum,
            weightedRevenue: Math.round(revNum * likelihoodNum),
            vat: getValueByHeader(row, colMap, ["vat?", "vat"]),
            projectCode: getValueByHeader(row, colMap, ["project code"]),
            dateConfirmed: formatDateVal(getValueByHeader(row, colMap, ["date conf", "date originally added to pipeline", "date added", "date confirmed"])),
            invoices,
            directExpenses,
            childRowNumbers: childRows.map((cr) => cr.rowNum),
            hasChildRows: childRows.length > 0,
            parentHasInvoice,
            parentId: rowNum - 2,
            isParent: true,
            totalAmount: revNum,
            totalRev: revenue,
            totalDC: directCosts,
            // Math Engine Columns (strictly ISO YYYY-MM-DD)
            eqStartDate,
            erEndDate,
            splitStr: getValueByHeader(row, colMap, ["revunevensplit"]) || (row[30] !== undefined ? String(row[30]) : ""),
            hasSplit: getValueByHeader(row, colMap, ["has split"]) || (row[253] !== undefined ? String(row[253]) : ""),
            origBaseRev: getValueByHeader(row, colMap, ["orig base rev"]) || (row[258] !== undefined ? String(row[258]) : ""),
            origBaseIncome: getValueByHeader(row, colMap, ["orig base income"]) || (row[259] !== undefined ? String(row[259]) : ""),
            childRetainers: childRetainers.length > 0 ? childRetainers : undefined,
          };

          // Flatten invoices directly onto jobObj (inv1Amount, inv1SendDate, etc.)
          invoices.forEach((inv, idx) => {
            const slot = idx + 1;
            jobObj[`inv${slot}Amount`] = inv.amount;
            jobObj[`inv${slot}Ref`] = inv.ref;
            jobObj[`inv${slot}SendDate`] = inv.sendDate;
            jobObj[`inv${slot}Days`] = inv.days;
            jobObj[`inv${slot}Status`] = inv.status;
            jobObj[`inv${slot}IsChild`] = !!inv.isChild;
          });

          // Flatten direct expenses directly onto jobObj (dirInv1Amount, etc.)
          directExpenses.forEach((exp, idx) => {
            const slot = idx + 1;
            jobObj[`dirInv${slot}Amount`] = exp.amount;
            jobObj[`dirInv${slot}Desc`] = exp.desc;
            jobObj[`dirInv${slot}Vat`] = exp.vat;
            jobObj[`dirInv${slot}RecDate`] = exp.recDate;
            jobObj[`dirInv${slot}SendDate`] = exp.recDate;
            jobObj[`dirInv${slot}Days`] = exp.days;
            jobObj[`dirInv${slot}Status`] = exp.status;
          });

          parsed.push(jobObj);

          i = j;
        } else {
          i++;
        }
      }

      // Sort by start date descending (latest first)
      parsed.sort((a, b) => {
        const dA = a.startDate ? new Date(a.startDate).getTime() : 0;
        const dB = b.startDate ? new Date(b.startDate).getTime() : 0;
        return (isNaN(dB) ? 0 : dB) - (isNaN(dA) ? 0 : dA);
      });

      return parsed;
    };

    const confirmedJobs = parseJobs(confirmedRows, "Confirmed");
    const pipelineJobs = parseJobs(pipelineRows, "Pipeline");
    const allJobs = [...confirmedJobs, ...pipelineJobs];

    const formatMoneyVal = (v) => {
      if (v === null || v === undefined || v === "" || v === 0 || v === "0") return `${currencySymbol}0`;
      const num = parseMoney(v);
      return formatMoney(num, 0, currencySymbol, thousandsSeparator);
    };

    // Helper: Parse Salaries
    const salariesList = [];
    if (salariesRows.length > 3) {
      for (let r = 3; r < salariesRows.length; r++) {
        const row = salariesRows[r];
        const name = String(row[0] || "").trim();
        if (!name) continue;
        const role = String(row[1] || "").trim();
        const fteSalaryNum = parseMoney(row[2]);
        const fteSalary = formatMoney(fteSalaryNum, 0, currencySymbol, thousandsSeparator);
        row[2] = fteSalary; // Normalize rawRows for salaries
        const fte = String(row[3] || "1.00").trim();
        const startDate = String(row[4] || "").trim();
        const endDate = String(row[5] || "").trim();
        const deliveryPct = String(row[6] || "").trim();
        const pensionPct = String(row[7] || "").trim();

        const fteNum = parseFloat(String(fte)) || 1.0;
        const actualAnnualCost = Math.round(fteSalaryNum * fteNum);
        const isDelivery = deliveryPct === "100%" || (parseFloat(deliveryPct) || 0) > 0;

        salariesList.push({
          rowNumber: r + 1,
          name,
          role,
          fteSalary,
          fteSalaryNum,
          fte,
          fteNum,
          actualAnnualCost,
          startDate,
          endDate,
          deliveryPct: deliveryPct || "0%",
          isDelivery,
          pensionPct: pensionPct || "0%",
        });
      }
    }

    const totalHeadcount = salariesList.length;
    const deliveryHeadcount = salariesList.filter((s) => s.isDelivery).length;
    const nonDeliveryHeadcount = totalHeadcount - deliveryHeadcount;
    const totalPayroll = salariesList.reduce((acc, s) => acc + s.actualAnnualCost, 0);

    // Helper: Parse Outgoings (Contractors, Expenses, Dividends) with 3 Years
    const outgoingsHeadersY1 = (outgoingsRows[0] || []).slice(6, 18).map((h) => String(h || "").trim());
    const outgoingsHeadersY2 = (outgoingsRows[0] || []).slice(21, 33).map((h) => String(h || "").trim());
    const outgoingsHeadersY3 = (outgoingsRows[0] || []).slice(36, 48).map((h) => String(h || "").trim());

    const parseOutgoingsSection = (startRow, endRow) => {
      const items = [];
      for (let r = startRow; r <= endRow && r < outgoingsRows.length; r++) {
        const row = outgoingsRows[r] || [];
        const name = String(row[0] || "").trim();
        if (!name || name.toLowerCase() === "hide") continue;

        const vat = String(row[1] || "").trim();
        const invoiceTiming = String(row[2] || "").trim();
        const paymentTiming = String(row[3] || "").trim();
        const deliveryPct = String(row[4] || "").trim();

        const allocationsY1 = (row.slice(6, 18) || []).map(formatMoneyVal);
        const allocationsY2 = (row.slice(21, 33) || []).map(formatMoneyVal);
        const allocationsY3 = (row.slice(36, 48) || []).map(formatMoneyVal);

        const sumAllocations = (arr) =>
          arr.reduce((acc, val) => acc + parseMoney(val), 0);

        const totalY1 = sumAllocations(allocationsY1);
        const totalY2 = sumAllocations(allocationsY2);
        const totalY3 = sumAllocations(allocationsY3);

        items.push({
          rowNumber: r + 1,
          name,
          vat,
          invoiceTiming,
          paymentTiming,
          deliveryPct,
          isDelivery: deliveryPct === "100%" || (parseFloat(deliveryPct) || 0) > 0,
          allocations: {
            1: allocationsY1,
            2: allocationsY2,
            3: allocationsY3,
          },
          totals: {
            1: totalY1,
            2: totalY2,
            3: totalY3,
          },
          monthlyAllocations: allocationsY1, // default to Year 1
          totalAnnual: totalY1,
        });
      }
      return items;
    };

    // Contractors: rows 13 to 110 (indices 12 to 109)
    const contractorsList = parseOutgoingsSection(12, 109);
    // Dividends: rows 118 to 121 (indices 117 to 120), strictly excluding summary/total rows as in original WebApp
    const dividendsList = parseOutgoingsSection(117, 120).filter((item) => !item.name.toLowerCase().includes("total"));
    // Expenses: rows 126 to 225 (indices 125 to 224)
    const expensesList = parseOutgoingsSection(125, 224);

    // Extract Transaction Breakdown (Row 300) and Actual VAT (Rows 304 & 305) from Outgoings
    // 0-indexed row indices: Row 300 -> 299, Row 304 -> 303, Row 305 -> 304
    const row300 = outgoingsRows[299] || [];
    const row304 = outgoingsRows[303] || [];
    const row305 = outgoingsRows[304] || [];

    const parseJsonCell = (cellVal) => {
      if (!cellVal) return [];
      try {
        const parsed = typeof cellVal === "string" ? JSON.parse(cellVal) : cellVal;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    const parseYearRow = (row, sliceStart, sliceEnd, parser = (v) => v) => {
      return (row.slice(sliceStart, sliceEnd) || []).map(parser);
    };

    const transactionsByMonth = {
      1: parseYearRow(row300, 6, 18, parseJsonCell),
      2: parseYearRow(row300, 21, 33, parseJsonCell),
      3: parseYearRow(row300, 36, 48, parseJsonCell),
    };

    const vatCashByMonth = {
      1: parseYearRow(row304, 6, 18, formatMoneyVal),
      2: parseYearRow(row304, 21, 33, formatMoneyVal),
      3: parseYearRow(row304, 36, 48, formatMoneyVal),
    };

    const vatAccrualByMonth = {
      1: parseYearRow(row305, 6, 18, formatMoneyVal),
      2: parseYearRow(row305, 21, 33, formatMoneyVal),
      3: parseYearRow(row305, 36, 48, formatMoneyVal),
    };

    // In Notes metadata mode, fetch and parse transactions from Master Sheet's OutgNotes tab
    let contractorTransactions = [];
    if (isNotesMode && masterSheetId) {
      try {
        const notesResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: masterSheetId,
            range: "OutgNotes!A1:AV112",
            valueRenderOption: "FORMATTED_VALUE",
          })
        );
        const notesRows = notesResp.data.values || [];
        const blockRegex = /\{App ID:\s*([^}]+)\}\{Amt:\s*([^}]+)\}(?:\{Status:\s*([^}]*)\})?(?:\{Rec date:\s*([^}]*)\})?(?:\{Pay date:\s*([^}]*)\})?(?:\{Description:\s*([^}]*)\})?/g;

        // Loop rows 13 to 111 (0-indexed indices 12 to 110)
        // Row 111 (index 110) is "Making up CoS amount"
        for (let r = 12; r <= 110 && r < notesRows.length; r++) {
          const contractorRow = outgoingsRows[r] || [];
          const contractorName = String(
            contractorRow[0] || (r === 110 ? "Making up CoS amount" : `Contractor ${r - 11}`)
          ).trim();
          if (!contractorName || contractorName.toLowerCase() === "hide") continue;

          // VAT setting from Col B of Outgoings (Row 111 VAT setting in Col B)
          const vatSetting = String(contractorRow[1] || "").trim();
          const isVat = vatSetting.toLowerCase() === "yes";

          const notesCells = notesRows[r] || [];
          for (let c = 0; c < notesCells.length; c++) {
            const cellText = notesCells[c];
            if (!cellText || !cellText.includes("{App ID:")) continue;

            let match;
            blockRegex.lastIndex = 0;
            while ((match = blockRegex.exec(cellText)) !== null) {
              const appId = match[1]?.trim() || "";
              const netAmount = parseFloat(String(match[2] || "").replace(/[£$€,\s]/g, "")) || 0;
              const status = match[3]?.trim() || "";
              const recDate = match[4]?.trim() || "";
              const payDate = match[5]?.trim() || "";
              const rawDesc = match[6]?.trim() || "";

              let vendor = contractorName;
              let itemDesc = rawDesc;
              const parenMatch = rawDesc.match(/^(.*?)\s*\((.*)\)$/);
              if (parenMatch && parenMatch[1].trim() && parenMatch[2].trim()) {
                vendor = parenMatch[1].trim();
                itemDesc = parenMatch[2].trim();
              } else if (rawDesc.startsWith("Placeholder Entry - ")) {
                vendor = rawDesc.replace("Placeholder Entry - ", "").trim() || vendor;
                itemDesc = "Placeholder Entry";
              } else if (rawDesc === "Placeholder Entry") {
                vendor = contractorName;
                itemDesc = "Placeholder Entry";
              }

              const vatAmount = isVat ? Math.round(netAmount * 0.20 * 100) / 100 : 0;
              const grossAmount = Math.round((netAmount + vatAmount) * 100) / 100;

              contractorTransactions.push({
                appId,
                vendor,
                itemDesc,
                rawDesc,
                contractorName,
                netAmount,
                vatAmount,
                grossAmount,
                amount: -Math.abs(grossAmount),
                vatSetting: isVat ? "Yes" : "No",
                status,
                recDate,
                payDate,
                rowNumber: r + 1,
              });
            }
          }
        }
      } catch (notesErr) {
        console.warn("⚠️ Failed to fetch OutgNotes from master sheet:", notesErr.message);
      }
    }

    // Fetch Recon Sheet bank transactions and CR2 "Month ready" gate
    const reconMonths = {};
    let reconSheetId = null;

    if (masterSheetId) {
      try {
        const reconCellResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: masterSheetId,
            range: "KeyInfo!G1",
            valueRenderOption: "FORMATTED_VALUE",
          })
        );
        const rUrl = String(reconCellResp.data.values?.[0]?.[0] || "").trim();
        if (rUrl) {
          reconSheetId = extractSheetIdFromUrl(rUrl) || rUrl;
        }
      } catch (err) {
        console.warn("⚠️ Failed to read KeyInfo!G1 from master sheet:", err.message);
      }
    }

    if (reconSheetId) {
      try {
        const reconMeta = await withRetry(() =>
          sheets.spreadsheets.get({
            spreadsheetId: reconSheetId,
            fields: "sheets.properties.title",
          })
        );
        const allReconTabTitles = (reconMeta.data.sheets || [])
          .map((s) => s.properties?.title)
          .filter((t) => /^\d{4}$/.test(t));

        // Get months across Outgoings headers (Year 1, 2, 3)
        const allOutgoingsMonthHeaders = [
          ...outgoingsHeadersY1,
          ...outgoingsHeadersY2,
          ...outgoingsHeadersY3,
        ].filter(Boolean);

        const targetTabNames = [];
        allOutgoingsMonthHeaders.forEach((h) => {
          const d = parseMonthYear(h);
          if (d) {
            const tabName = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
            if (allReconTabTitles.includes(tabName) && !targetTabNames.includes(tabName)) {
              targetTabNames.push(tabName);
            }
          }
        });

        if (targetTabNames.length > 0) {
          const batchRanges = [];
          targetTabNames.forEach((t) => {
            batchRanges.push(`'${t}'!CR2`);
            batchRanges.push(`'${t}'!CD4:CN30`);
            batchRanges.push(`'${t}'!A3:Q200`);
          });

          const reconBatchResp = await withRetry(() =>
            sheets.spreadsheets.values.batchGet({
              spreadsheetId: reconSheetId,
              ranges: batchRanges,
              valueRenderOption: "FORMATTED_VALUE",
            })
          );

          const valueRanges = reconBatchResp.data.valueRanges || [];
          for (let i = 0; i < targetTabNames.length; i++) {
            const tabName = targetTabNames[i];
            const cr2Val = valueRanges[i * 3]?.values?.[0]?.[0];
            const isReconciled = Boolean(cr2Val === true || String(cr2Val || "").trim().toUpperCase() === "TRUE");
            const unrecRows = valueRanges[i * 3 + 1]?.values || [];
            const bankRows = valueRanges[i * 3 + 2]?.values || [];

            const unreconciledItems = [];
            unrecRows.forEach((r) => {
              const dateVal = r[2]; // CF
              const payee = String(r[3] || "").trim(); // CG
              const desc = String(r[4] || "").trim(); // CH
              const rawAmt = parseFloat(String(r[5] || "0").replace(/[£$€,\s]/g, "")) || 0; // CI
              const amt = Math.abs(rawAmt);
              const cat = String(r[9] || "").trim(); // CK
              const vatApplies = String(r[10] || "").trim().toLowerCase() === "yes"; // CL

              // Credit card purchases are not cash account transactions: exclude them from cashflow
              const isCreditCard = /master\s*card|credit\s*card|visa\s*credit|amex/i.test(`${desc} ${payee}`);
              if (isCreditCard) return;

              if (amt > 0 && cat) {
                const vatAmt = vatApplies ? Math.round(amt * (20 / 120) * 100) / 100 : 0;
                const netAmt = Math.round((amt - vatAmt) * 100) / 100;
                unreconciledItems.push({
                  d: String(dateVal || ""),
                  p: String(dateVal || ""),
                  s: payee,
                  c: cat,
                  r: "UNRECON",
                  n: netAmt,
                  v: vatAmt,
                  g: amt,
                  u: true,
                });
              }
            });

            const isDateStr = (val) => {
              if (!val || typeof val !== "string") return false;
              const s = val.trim();
              if (/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(s)) return true;
              if (/^\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}$/.test(s)) return true;
              if (/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4}$/.test(s)) return true;
              return false;
            };

            const isTypeStr = (val) =>
              /^(expense|payment|bill payment|debit|credit|transfer|check)$/i.test(
                String(val || "").trim()
              );
            const isTaxRate = (val) =>
              /^(\d+(\.\d+)?%|no vat|zero|exempt)/i.test(String(val || "").trim()) ||
              /%/.test(String(val || ""));
            const isAccountStr = (val) =>
              /bank account|business account|revolut|starling|tide|barclays|hsbc|current account/i.test(
                String(val || "").trim()
              );

            const normCatKey = (s) =>
              String(s || "").replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
            const knownCategorySet = new Set(
              (expensesList || []).map((e) => normCatKey(e.name)).filter(Boolean)
            );
            [
              "debtors",
              "creditors",
              "freelancer",
              "net pay control",
              "dividend paid",
              "bank charges",
              "sales",
              "revenue",
            ].forEach((c) => knownCategorySet.add(c));

            const bankOutgoings = [];
            bankRows.forEach((r) => {
              const c = (idx) => String(r[idx] || "").trim();
              const outAmt = parseFloat(c(8).replace(/[£$€,\s]/g, "")) || 0;
              const inAmt = parseFloat(c(9).replace(/[£$€,\s]/g, "")) || 0;
              const catFormula = c(16);

              if (catFormula.toLowerCase() === "outgoings") {
                // Collect non-empty cells across columns 0..7 with their column indices
                const cells = [];
                for (let i = 0; i <= 7; i++) {
                  const val = c(i);
                  if (val) cells.push({ col: i, val });
                }

                // 1. Identify Date: first cell matching isDateStr
                const dateCell = cells.find((item) => isDateStr(item.val));
                const date = dateCell ? dateCell.val : "";

                // 2. Filter out date, transaction types (Expense, Payment, etc.), and tax rates
                const remaining = cells.filter((item) => {
                  if (item === dateCell) return false;
                  if (isDateStr(item.val)) return false;
                  if (isTypeStr(item.val)) return false;
                  if (isTaxRate(item.val)) return false;
                  return true;
                });

                // 3. Identify Category among remaining cells
                let sheetCategory = "";
                const catIdx = remaining.findIndex((item) =>
                  knownCategorySet.has(normCatKey(item.val))
                );
                let catCell = null;
                if (catIdx !== -1) {
                  catCell = remaining[catIdx];
                  sheetCategory = catCell.val;
                }

                // 4. Remaining cells after removing category
                const nonCat = remaining.filter((item) => item !== catCell);

                // 5. Account Name detection
                let account = "";
                const accIdx = nonCat.findIndex((item) => isAccountStr(item.val));
                let accCell = null;
                if (accIdx !== -1 && nonCat.length > 1) {
                  accCell = nonCat[accIdx];
                  account = accCell.val;
                }

                const payloadCells = nonCat.filter((item) => item !== accCell);

                // 6. Payee and Description
                let payee = "";
                let desc = "";
                if (payloadCells.length === 1) {
                  payee = payloadCells[0].val;
                } else if (payloadCells.length >= 2) {
                  payee = payloadCells[0].val;
                  desc = payloadCells[1].val;
                }

                // If no category was explicitly recognized from knownCategorySet,
                // but we had multiple payload cells, check if one of them was in col 5, 6 or 7
                if (!sheetCategory && payloadCells.length >= 2) {
                  const candidateCat = payloadCells[payloadCells.length - 1];
                  if (candidateCat.col >= 5) {
                    sheetCategory = candidateCat.val;
                    payee = payloadCells[0].val;
                  }
                }

                const netAmount = outAmt > 0 ? Math.abs(outAmt) : (inAmt > 0 ? -Math.abs(inAmt) : 0);
                if (netAmount !== 0) {
                  bankOutgoings.push({
                    d: date,
                    account,
                    payee,
                    desc,
                    sheetCategory,
                    amount: netAmount,
                    isCredit: inAmt > 0 && outAmt === 0,
                  });
                }
              }
            });

            reconMonths[tabName] = {
              isReconciled,
              unreconciledItems,
              bankOutgoings,
            };
          }
        }
      } catch (reconErr) {
        console.warn("⚠️ Failed to fetch Recon sheet tabs:", reconErr.message);
      }
    }

    const getFy = (headers, fallback) => {
      if (!headers || headers.length === 0) return fallback;
      const last = headers[headers.length - 1] || headers[0];
      const m = String(last).match(/(\d{2,4})/);
      return m ? `FY${m[1].slice(-2)}` : fallback;
    };
    const fyLabels = {
      1: getFy(outgoingsHeadersY1, "FY26"),
      2: getFy(outgoingsHeadersY2, "FY27"),
      3: getFy(outgoingsHeadersY3, "FY28"),
    };

    const today = new Date();
    let currentOutgoingsYear = 2; // Default to Year 2 (current financial year)
    const yearHeaders = {
      1: outgoingsHeadersY1,
      2: outgoingsHeadersY2,
      3: outgoingsHeadersY3,
    };
    for (const y of [1, 2, 3]) {
      const hdrs = yearHeaders[y] || [];
      if (hdrs.length > 0) {
        const first = parseMonthYear(hdrs[0]);
        if (first) {
          const start = new Date(first.getFullYear(), first.getMonth(), 1);
          const end = new Date(first.getFullYear(), first.getMonth() + 12, 0, 23, 59, 59);
          if (today >= start && today <= end) {
            currentOutgoingsYear = y;
            break;
          }
        }
      }
    }

    // Helper: Parse NBtoFind with 3 Years
    const nbHeadersY1 = (nbtofindRows[0] || []).slice(6, 18).map((h) => String(h || "").trim());
    const nbHeadersY2 = (nbtofindRows[0] || []).slice(21, 33).map((h) => String(h || "").trim());
    const nbHeadersY3 = (nbtofindRows[0] || []).slice(36, 48).map((h) => String(h || "").trim());

    // Row 18: NB to find figure to use (1-indexed Row 18 is 0-indexed index 17)
    const nbTargetRow = nbtofindRows[17] || nbtofindRows.find((r) => String(r[0] || "").toLowerCase().includes("figure to use")) || [];
    const nbY1 = nbTargetRow.length > 0 ? (nbTargetRow.slice(6, 18) || []).map(formatMoneyVal) : [];
    const nbY2 = nbTargetRow.length > 0 ? (nbTargetRow.slice(21, 33) || []).map(formatMoneyVal) : [];
    const nbY3 = nbTargetRow.length > 0 ? (nbTargetRow.slice(36, 48) || []).map(formatMoneyVal) : [];

    // Row 23: NB to find direct costs to use (1-indexed Row 23 is 0-indexed index 22)
    const nbDirectCostsRow = nbtofindRows[22] || nbtofindRows.find((r) => String(r[0] || "").toLowerCase().includes("direct costs to use")) || [];
    const nbDcY1 = nbDirectCostsRow.length > 0 ? (nbDirectCostsRow.slice(6, 18) || []).map(formatMoneyVal) : [];
    const nbDcY2 = nbDirectCostsRow.length > 0 ? (nbDirectCostsRow.slice(21, 33) || []).map(formatMoneyVal) : [];
    const nbDcY3 = nbDirectCostsRow.length > 0 ? (nbDirectCostsRow.slice(36, 48) || []).map(formatMoneyVal) : [];

    const sumNB = (arr) =>
      (arr || []).reduce((acc, v) => acc + parseMoney(v), 0);

    const totalConfirmedRevenue = confirmedJobs.reduce((acc, j) => acc + j.revNum, 0);
    const totalPipelineRevenue = pipelineJobs.reduce((acc, j) => acc + j.revNum, 0);
    const weightedPipelineRevenue = pipelineJobs.reduce((acc, j) => acc + j.weightedRevenue, 0);

    // Extract Outgoings Metadata for Advanced Scenario Planning & Making up CoS matching webappserver.gs (lines 3227-3281)
    const yearBlocks = [
      { start: 6, count: 12 },   // Year 1: Cols G-R (indices 6-17)
      { start: 21, count: 12 },  // Year 2: Cols V-AG (indices 21-32)
      { start: 36, count: 12 },  // Year 3: Cols AK-AV (indices 36-47)
    ];

    const outgoingsMeta = {
      makingUpCosPct: 0,
      salariesDel: [],
      salariesNonDel: [],
      makingUpCosBase: [],
      makingUpCosBaseConf: [],
      makingUpCosHardZero: [],
      profitShareBaseDel: [],
      profitShareBaseNonDel: [],
      contractorSource: contractorSource || "Cell Values",
      isNotesMode,
      contractorTransactions,
      makingUpCosVat: "",
      makingUpCosTiming: "Curr",
      profitSharePct,
      profitShareSwitch,
      mode,
    };

    const makingUpCosPctRaw = outgoingsRows[111] ? outgoingsRows[111][0] : "0%";
    outgoingsMeta.makingUpCosPct = parseFloat(String(makingUpCosPctRaw).replace("%", "")) / 100 || 0;

    if (outgoingsRows[110]) {
      outgoingsMeta.makingUpCosVat = outgoingsRows[110][1] || "";
      outgoingsMeta.makingUpCosTiming = outgoingsRows[110][3] || "Curr";
    }

    for (let yi = 0; yi < yearBlocks.length; yi++) {
      const blk = yearBlocks[yi];
      const sDel = [], sNonDel = [], mCos = [], mCosConf = [], mCosHz = [], psDel = [], psNonDel = [];
      for (let j = 0; j < blk.count; j++) {
        const cIdx = blk.start + j;
        sDel.push(outgoingsRows[5] ? (parseFloat(String(outgoingsRows[5][cIdx] || 0).replace(/[£,]/g, "")) || 0) : 0);
        sNonDel.push(outgoingsRows[6] ? (parseFloat(String(outgoingsRows[6][cIdx] || 0).replace(/[£,]/g, "")) || 0) : 0);
        mCos.push(outgoingsRows[110] ? (parseFloat(String(outgoingsRows[110][cIdx] || 0).replace(/[£,]/g, "")) || 0) : 0);
        mCosConf.push(outgoingsRows[244] ? (parseFloat(String(outgoingsRows[244][cIdx] || 0).replace(/[£,]/g, "")) || 0) : 0);
        const indicator = outgoingsRows[111] ? String(outgoingsRows[111][cIdx] || "").toUpperCase().trim() : "";
        mCosHz.push(indicator === "ZERO");
        psDel.push(outgoingsRows[234] ? (parseFloat(String(outgoingsRows[234][cIdx] || 0).replace(/[£,]/g, "")) || 0) : 0);
        psNonDel.push(outgoingsRows[235] ? (parseFloat(String(outgoingsRows[235][cIdx] || 0).replace(/[£,]/g, "")) || 0) : 0);
      }
      outgoingsMeta.salariesDel.push(sDel);
      outgoingsMeta.salariesNonDel.push(sNonDel);
      outgoingsMeta.makingUpCosBase.push(mCos);
      outgoingsMeta.makingUpCosBaseConf.push(mCosConf);
      outgoingsMeta.makingUpCosHardZero.push(mCosHz);
      outgoingsMeta.profitShareBaseDel.push(psDel);
      outgoingsMeta.profitShareBaseNonDel.push(psNonDel);
    }

    const keyDataPayload = {
      _cachedAt: new Date().toISOString(),
      outgoingsMeta,
      jobs: {
        all: allJobs,
        confirmed: confirmedJobs,
        pipeline: pipelineJobs,
        totalRevenue: totalConfirmedRevenue,
        pipelineRevenue: totalPipelineRevenue,
        weightedPipelineRevenue,
        totalJobsCount: allJobs.length,
        confirmedCount: confirmedJobs.length,
        pipelineCount: pipelineJobs.length,
      },
      salaries: {
        staff: salariesList,
        rawRows: salariesRows,
        headers: salariesRows[0] || [],
        monthHeaders: salariesHeadersRow,
        deepDive: salariesDeepDiveRows,
        totalHeadcount,
        deliveryHeadcount,
        nonDeliveryHeadcount,
        totalPayroll,
        averageSalary: totalHeadcount > 0 ? Math.round(totalPayroll / totalHeadcount) : 0,
      },
      outgoings: {
        headers: {
          1: outgoingsHeadersY1,
          2: outgoingsHeadersY2,
          3: outgoingsHeadersY3,
        },
        currentYear: currentOutgoingsYear,
        fyLabels,
        contractors: contractorsList,
        expenses: expensesList,
        dividends: dividendsList,
        contractorSource: contractorSource || "Cell Values",
        isNotesMode,
        contractorTransactions,
        transactionsByMonth,
        reconMonths,
        vatCashByMonth,
        vatAccrualByMonth,
      },
      nbtofind: {
        headers: {
          1: nbHeadersY1,
          2: nbHeadersY2,
          3: nbHeadersY3,
        },
        currentYear: currentOutgoingsYear,
        mode,
        isRevenueMode: mode.toLowerCase() === "revenue",
        allocations: {
          1: nbY1,
          2: nbY2,
          3: nbY3,
        },
        monthlyAllocations: currentOutgoingsYear === 2 ? nbY2 : (currentOutgoingsYear === 3 ? nbY3 : nbY1),
        totalTargets: {
          1: sumNB(nbY1),
          2: sumNB(nbY2),
          3: sumNB(nbY3),
        },
        directCosts: {
          1: nbDcY1,
          2: nbDcY2,
          3: nbDcY3,
        },
        monthlyDirectCosts: currentOutgoingsYear === 2 ? nbDcY2 : (currentOutgoingsYear === 3 ? nbDcY3 : nbDcY1),
        totalDirectCosts: {
          1: sumNB(nbDcY1),
          2: sumNB(nbDcY2),
          3: sumNB(nbDcY3),
        },
      },
      mode,
      formOptions: {
        leadSources,
        productLines,
        splitEnabled,
        splitMethod,
      },
      splitEnabled,
      splitMethod,
      currencySymbol,
      thousandsSeparator,
      clientInfo: {
        currencySymbol,
        thousandsSeparator,
      },
    };

    // Cache in L1 memory and Redis
    memoryCache.set(cacheKey, keyDataPayload, KEYDATA_CACHE_TTL_SECS);
    redisClient
      .set(cacheKey, JSON.stringify(keyDataPayload), { EX: KEYDATA_CACHE_TTL_SECS })
      .catch((err) => console.warn("⚠️ Failed to write key-data to Redis:", err.message));

    return res.status(200).json({
      success: true,
      fromCache: false,
      data: sanitizeForUser(keyDataPayload),
    });
  } catch (err) {
    console.error("❌ /api/portal/key-data error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
