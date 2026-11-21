/**
 * ============================================================================
 * YEAR 0 SETUP SERVICE (services/year0SetupService.js)
 * ============================================================================
 *
 * Powers the "Check Year 0 setup, adding dividends in lieu of salary as required"
 * onboarding workflow:
 * 1. Reads Year 0 P&L breakdown, dividends in lieu of salary (Year0Data!BE35:BP35
 *    and Year0Data!BE49:BP49), and manual category adjustments (G7:R7, G15:R15,
 *    G25:R25) from the client's Master Sheet (both Google Sheet & Supabase modes).
 * 2. Pulls 12 monthly P&L reports leading up to KeyInfo!B2 from Xero or QuickBooks,
 *    writes Year0PLFromApp (verbatim with GAS getYear0PLfromXero / getYear0PLfromQB),
 *    evaluates Year0Data, and mirrors Year0Data!A1:BZ205 to the Client Sheet.
 * 3. Saves dividends in lieu of salary (split by Delivery % between CoS and
 *    Non-CoS staff costs) and monthly +/- category adjustments back to Master
 *    and Client sheets.
 */

import { getSheetsClient, withRetry, extractSheetIdFromUrl, colIndexToLetter } from "./sheetsClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import { resolveAccountingToolAuth } from "./accountingSuggestionsService.js";
import { assertValidQBRealmId } from "./quickbooksService.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes } from "./masterEngineService.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeFormulaInput } from "./userPermissions.js";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/**
 * Parses a spreadsheet number cell safely into a finite float (default 0).
 */
export function parseYear0Number(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  if (val === null || val === undefined || val === "") return 0;
  const cleaned = String(val).trim().replace(/[£$€,\s]/g, "");
  if (!cleaned || cleaned === "-") return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses a KeyInfo / spreadsheet date (Date, Excel serial, YYYY-MM-DD, or d-Mmm-yy).
 */
export function parseYear0Date(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === "number" && val > 20000 && val < 90000) {
    const utc = new Date(Math.round((val - 25569) * 86400 * 1000));
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  }
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{5}(?:\.\d+)?$/.test(s)) {
    const num = parseFloat(s);
    if (num > 20000 && num < 90000) {
      const utc = new Date(Math.round((num - 25569) * 86400 * 1000));
      return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    }
  }
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (isoMatch) {
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }
  const dmyMatch = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})$/.exec(s);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const monRaw = dmyMatch[2].slice(0, 3).toLowerCase();
    const monIdx = SHORT_MONTHS.findIndex((m) => m.toLowerCase() === monRaw);
    if (monIdx !== -1) {
      let yr = Number(dmyMatch[3]);
      if (yr < 100) yr += yr <= 69 ? 2000 : 1900;
      return new Date(yr, monIdx, day);
    }
  }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Builds the 12 Year 0 monthly period descriptors starting at EDATE(startDate, -12).
 */
export function buildYear0MonthColumns(startDate) {
  const b2 = parseYear0Date(startDate);
  if (!b2) return [];
  const periodStart = new Date(b2.getFullYear() - 1, b2.getMonth(), 1);
  const months = [];
  for (let i = 0; i < 12; i++) {
    const fromDate = new Date(periodStart.getFullYear(), periodStart.getMonth() + i, 1);
    const toDate = new Date(fromDate.getFullYear(), fromDate.getMonth() + 1, 0);
    const yyyy = fromDate.getFullYear();
    const mm = String(fromDate.getMonth() + 1).padStart(2, "0");
    const lastDd = String(toDate.getDate()).padStart(2, "0");
    const longName = LONG_MONTHS[fromDate.getMonth()];
    const shortName = SHORT_MONTHS[fromDate.getMonth()];
    months.push({
      index: i,
      monthHeader: `${longName} ${yyyy}`,
      shortLabel: `${shortName} ${String(yyyy).slice(-2)}`,
      fromDateStr: `${yyyy}-${mm}-01`,
      toDateStr: `${yyyy}-${mm}-${lastDd}`,
    });
  }
  return months;
}

/**
 * Splits 12 monthly dividend amounts by deliveryPct (0-100) into CoS and Non-CoS arrays.
 */
export function splitDividendsByDeliveryPct(monthlyDividends = [], deliveryPct = 0) {
  const pctNum = Math.max(0, Math.min(100, parseYear0Number(deliveryPct)));
  const ratio = pctNum / 100;
  const cos = [];
  const nonCos = [];
  for (let m = 0; m < 12; m++) {
    const total = Math.round(parseYear0Number(monthlyDividends[m]) * 100) / 100;
    const cosVal = Math.round(total * ratio * 100) / 100;
    const nonCosVal = Math.round((total - cosVal) * 100) / 100;
    cos.push(cosVal);
    nonCos.push(nonCosVal);
  }
  return { cosDividends: cos, nonCosDividends: nonCos, deliveryPct: pctNum };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function resolveCleanId(rawId) {
  if (!rawId) return "";
  const unwrapped = unwrapSheetId(String(rawId).trim());
  return extractSheetIdFromUrl(unwrapped) || unwrapped;
}

/**
 * Mirrors Master Year0Data!A1:BZ205 to Client Sheet Year0Data tab,
 * 100% verbatim with GAS syncYear0DataToClientSheet_.
 */
async function syncYear0DataToClientSheet(sheets, cleanMasterId, rawClientSheetId) {
  const cleanClientId = resolveCleanId(rawClientSheetId);
  if (!cleanClientId) return;

  try {
    const [valResp, formResp] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: cleanMasterId,
          range: "Year0Data!A1:BZ205",
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      ),
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: cleanMasterId,
          range: "Year0Data!A1:BZ205",
          valueRenderOption: "FORMULA",
        })
      ),
    ]);

    const values = valResp.data?.values || [];
    const formulas = formResp.data?.values || [];
    const rowCount = Math.max(values.length, formulas.length, 205);
    const out = [];

    for (let r = 0; r < rowCount; r++) {
      const fRow = formulas[r] || [];
      const vRow = values[r] || [];
      const outRow = new Array(78).fill("");
      for (let c = 0; c < 78; c++) {
        const f = fRow[c];
        const v = vRow[c] !== undefined ? vRow[c] : "";
        if (typeof f === "string" && f.startsWith("=")) {
          if (/Year0PLFromApp|KeyInfo!\$?B[AE]|CC2:CC502|AZ71/i.test(f)) {
            outRow[c] = typeof v === "string" ? sanitizeFormulaInput(v) : v;
          } else if (/SUM\(BE\$82:BE\$589\)/i.test(f)) {
            outRow[c] = f.replace(/589/g, "205");
          } else {
            outRow[c] = f;
          }
        } else {
          outRow[c] = typeof v === "string" ? sanitizeFormulaInput(v) : v;
        }
      }
      out.push(outRow);
    }

    // Ensure Client Sheet has Year0Data tab (for Google Sheets)
    if (!cleanClientId.startsWith("sb-")) {
      const meta = await withRetry(() =>
        sheets.spreadsheets.get({
          spreadsheetId: cleanClientId,
          fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
        })
      );
      const y0Sheet = (meta.data?.sheets || []).find((s) => s.properties?.title === "Year0Data");
      if (!y0Sheet) {
        await withRetry(() =>
          sheets.spreadsheets.batchUpdate({
            spreadsheetId: cleanClientId,
            requestBody: {
              requests: [{ addSheet: { properties: { title: "Year0Data", hidden: true, gridProperties: { rowCount: 210, columnCount: 78 } } } }],
            },
          })
        );
      } else if ((y0Sheet.properties?.gridProperties?.columnCount || 0) < 78) {
        const currentCols = y0Sheet.properties?.gridProperties?.columnCount || 26;
        await withRetry(() =>
          sheets.spreadsheets.batchUpdate({
            spreadsheetId: cleanClientId,
            requestBody: {
              requests: [
                {
                  appendDimension: {
                    sheetId: y0Sheet.properties.sheetId,
                    dimension: "COLUMNS",
                    length: 78 - currentCols,
                  },
                },
              ],
            },
          })
        );
      }
    }

    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: cleanClientId,
        range: `Year0Data!A1:BZ${out.length}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: out },
      })
    );
  } catch (err) {
    console.warn("⚠️ syncYear0DataToClientSheet warning:", err.message);
  }
}

/**
 * Fetches 12 monthly P&L reports from Xero for the Year 0 window.
 * Preserves the exact structure and column ordering of GAS getYear0PLfromXero.
 */
async function fetchXeroYear0PL(auth, monthColumns) {
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "xero-tenant-id": auth.tenantId,
    Accept: "application/json",
  };

  // Run in batches of 3 to respect Xero per-minute rate limits while finishing in ~2s
  const monthlyResults = new Array(monthColumns.length).fill(null);
  const batchSize = 3;
  for (let start = 0; start < monthColumns.length; start += batchSize) {
    const slice = monthColumns.slice(start, start + batchSize);
    await Promise.all(
      slice.map(async (mc, offset) => {
        const url = `https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${mc.fromDateStr}&toDate=${mc.toDateStr}&standardLayout=false`;
        const res = await fetch(url, { headers, redirect: "manual" }).catch(() => null);
        if (!res || !res.ok) return;
        const json = await res.json().catch(() => null);
        if (json?.Reports?.[0]) {
          monthlyResults[start + offset] = json.Reports[0];
        }
      })
    );
  }

  const reportData = { headers: ["Description"], rowMap: new Map(), rowOrder: [] };

  for (let i = 0; i < monthColumns.length; i++) {
    const mc = monthColumns[i];
    reportData.headers.splice(1, 0, mc.monthHeader);
    const monthReport = monthlyResults[i];
    if (!monthReport) continue;

    const monthRowOrder = [];
    const collectStructure = (r) => {
      if (!r) return;
      if (r.RowType === "Section") {
        monthRowOrder.push({ title: String(r.Title || "").trim(), type: "Section" });
        if (Array.isArray(r.Rows)) r.Rows.forEach(collectStructure);
      } else if (r.RowType === "Row" || r.RowType === "SummaryRow") {
        const title = String(r.Cells?.[0]?.Value || "").trim();
        monthRowOrder.push({ title, type: r.RowType });
      }
    };
    (monthReport.Rows || []).forEach(collectStructure);

    if (reportData.rowOrder.length === 0) {
      reportData.rowOrder = monthRowOrder;
    } else {
      const masterTitles = new Set(reportData.rowOrder.map((r) => r.title));
      monthRowOrder.forEach((monthRow, index) => {
        if (!masterTitles.has(monthRow.title)) {
          let predecessorIdx = -1;
          for (let j = index - 1; j >= 0; j--) {
            const predTitle = monthRowOrder[j].title;
            const foundIdx = reportData.rowOrder.findIndex((r) => r.title === predTitle);
            if (foundIdx !== -1) {
              predecessorIdx = foundIdx;
              break;
            }
          }
          if (predecessorIdx !== -1) {
            reportData.rowOrder.splice(predecessorIdx + 1, 0, monthRow);
          } else {
            reportData.rowOrder.push(monthRow);
          }
          masterTitles.add(monthRow.title);
        }
      });
    }

    const collectValues = (row) => {
      if (!row) return;
      if (row.RowType === "Section" && Array.isArray(row.Rows)) {
        row.Rows.forEach(collectValues);
      } else if ((row.RowType === "Row" || row.RowType === "SummaryRow") && Array.isArray(row.Cells) && row.Cells.length > 1) {
        const title = String(row.Cells[0]?.Value || "").trim();
        const value = row.Cells[1]?.Value;
        if (!reportData.rowMap.has(title)) reportData.rowMap.set(title, {});
        reportData.rowMap.get(title)[mc.monthHeader] = value;
      }
    };
    (monthReport.Rows || []).forEach(collectValues);
  }

  return reportData;
}

/**
 * Fetches 12 monthly P&L reports from QuickBooks for the Year 0 window.
 * Preserves the exact structure and column ordering of GAS getYear0PLfromQB.
 */
async function fetchQuickBooksYear0PL(auth, monthColumns) {
  const safeRealmId = assertValidQBRealmId(auth.realmId);
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
  };

  const monthlyResults = new Array(monthColumns.length).fill(null);
  const batchSize = 3;
  for (let start = 0; start < monthColumns.length; start += batchSize) {
    const slice = monthColumns.slice(start, start + batchSize);
    await Promise.all(
      slice.map(async (mc, offset) => {
        const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/reports/ProfitAndLoss?start_date=${mc.fromDateStr}&end_date=${mc.toDateStr}&minorversion=73`;
        const res = await fetch(url, { headers, redirect: "manual" }).catch(() => null);
        if (!res || !res.ok) return;
        const json = await res.json().catch(() => null);
        if (json?.Rows?.Row) {
          monthlyResults[start + offset] = json;
        }
      })
    );
  }

  const reportData = { headers: ["Description"], rowMap: new Map(), rowOrder: [] };

  for (let i = 0; i < monthColumns.length; i++) {
    const mc = monthColumns[i];
    reportData.headers.splice(1, 0, mc.monthHeader);
    const monthReport = monthlyResults[i];
    if (!monthReport) continue;

    const monthRowOrder = [];
    const collectStructure = (r) => {
      if (!r || (!r.Header && !r.Summary && !r.ColData)) return;
      if (r.type === "Section" && r.Header?.ColData) {
        const title = String(r.Header.ColData[0]?.value || "").trim();
        monthRowOrder.push({ title, type: "Section" });
        if (r.Rows?.Row) r.Rows.Row.forEach(collectStructure);
      } else if (r.Summary?.ColData) {
        const title = String(r.Summary.ColData[0]?.value || "").trim();
        monthRowOrder.push({ title, type: "SummaryRow" });
      } else if (r.ColData) {
        const title = String(r.ColData[0]?.value || "").trim();
        monthRowOrder.push({ title, type: "Row" });
      }
    };
    (monthReport.Rows?.Row || []).forEach(collectStructure);

    if (reportData.rowOrder.length === 0) {
      reportData.rowOrder = monthRowOrder;
    } else {
      const masterTitles = new Set(reportData.rowOrder.map((r) => r.title));
      monthRowOrder.forEach((monthRow, index) => {
        if (!masterTitles.has(monthRow.title)) {
          let predecessorIdx = -1;
          for (let j = index - 1; j >= 0; j--) {
            const predTitle = monthRowOrder[j].title;
            const foundIdx = reportData.rowOrder.findIndex((r) => r.title === predTitle);
            if (foundIdx !== -1) {
              predecessorIdx = foundIdx;
              break;
            }
          }
          if (predecessorIdx !== -1) {
            reportData.rowOrder.splice(predecessorIdx + 1, 0, monthRow);
          } else {
            reportData.rowOrder.push(monthRow);
          }
          masterTitles.add(monthRow.title);
        }
      });
    }

    const collectValues = (row) => {
      if (!row || (!row.Header && !row.Summary && !row.ColData)) return;
      if (row.type === "Section" && row.Rows?.Row) {
        row.Rows.Row.forEach(collectValues);
      } else if (row.Summary?.ColData) {
        const title = String(row.Summary.ColData[0]?.value || "").trim();
        const value = row.Summary.ColData[1]?.value;
        if (!reportData.rowMap.has(title)) reportData.rowMap.set(title, {});
        reportData.rowMap.get(title)[mc.monthHeader] = value;
      } else if (row.ColData) {
        const title = String(row.ColData[0]?.value || "").trim();
        const value = row.ColData[1]?.value;
        if (!reportData.rowMap.has(title)) reportData.rowMap.set(title, {});
        reportData.rowMap.get(title)[mc.monthHeader] = value;
      }
    };
    (monthReport.Rows?.Row || []).forEach(collectValues);
  }

  return reportData;
}

/**
 * Converts Year0PLFromApp reportData into a flat 2D matrix ready to write to the sheet.
 */
function buildYear0PLMatrix(reportData) {
  const rows = [reportData.headers];
  for (const rowInfo of reportData.rowOrder) {
    const newRow = [sanitizeFormulaInput(String(rowInfo.title || ""))];
    if (rowInfo.type === "Section") {
      for (let i = 1; i < reportData.headers.length; i++) newRow.push("");
    } else {
      const rowData = reportData.rowMap.get(rowInfo.title) || {};
      for (let i = 1; i < reportData.headers.length; i++) {
        const monthHeader = reportData.headers[i];
        const raw = rowData[monthHeader];
        if (raw === undefined || raw === null || raw === "") {
          newRow.push(0);
        } else {
          const num = parseFloat(String(raw).replace(/,/g, ""));
          newRow.push(Number.isFinite(num) ? num : sanitizeFormulaInput(String(raw)));
        }
      }
    }
    rows.push(newRow);
  }
  return rows;
}

/**
 * Extracts labeled category line items from Year0Data!BD..BP across a row range.
 */
function extractBreakdownRows(bdToBrRows, startRow1, endRow1, offsetRow1 = 1) {
  const items = [];
  for (let r1 = startRow1; r1 <= endRow1; r1++) {
    const idx = r1 - offsetRow1;
    const row = bdToBrRows[idx] || [];
    const label = String(row[0] ?? "").trim();
    if (!label) continue;
    const monthly = [];
    let sum = 0;
    for (let m = 0; m < 12; m++) {
      const val = round2(parseYear0Number(row[1 + m]));
      monthly.push(val);
      sum += val;
    }
    const total = round2(row[13] !== undefined && row[13] !== "" ? parseYear0Number(row[13]) : sum);
    if (Math.abs(total) < 0.005 && monthly.every((v) => Math.abs(v) < 0.005)) continue;
    items.push({ rowNum: r1, label, monthly, total });
  }
  return items;
}

/**
 * Reads the current Year 0 P&L, Dividends in lieu of salary, and Category Adjustments.
 */
export async function getYear0SetupData({ clientName, masterSheetId }) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) {
    throw new Error("Master workspace ID is required.");
  }

  const sheets = await getSheetsClient();
  const [batchValResp, adjFormResp, auth] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: cleanMasterId,
        ranges: [
          "KeyInfo!B2",
          "KeyInfo!B15:B17",
          "KeyInfo!D8",
          "KeyInfo!X28",
          "Year0Data!A1:T35",
          "Year0Data!BD1:BR77",
          "Year0Data!BD82:BR205",
          "Year0PLFromApp!A1:M10",
          "KeyInfo!D4:D5",
          "KeyInfo!B123:B140",
        ],
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    ),
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: cleanMasterId,
        ranges: [
          "Year0Data!G7:R7",
          "Year0Data!G15:R15",
          "Year0Data!G25:R25",
        ],
        valueRenderOption: "FORMULA",
      })
    ),
    resolveAccountingToolAuth(clientName, cleanMasterId).catch(() => null),
  ]);

  const vr = batchValResp.data?.valueRanges || [];
  const rawB2 = vr[0]?.values?.[0]?.[0] || "";
  const b15to17 = vr[1]?.values || [];
  const revOrInc = String(b15to17[0]?.[0] || "Revenue").trim();
  const splitDelivery = String(b15to17[1]?.[0] || "Yes").trim().toLowerCase() !== "no";
  const currency = String(b15to17[2]?.[0] || "GBP").trim() || "GBP";
  const basis = String(vr[2]?.values?.[0]?.[0] || "Accrual").trim() || "Accrual";
  const clientSheetId = String(vr[3]?.values?.[0]?.[0] || "").trim();

  const d4to5 = vr[8]?.values || [];
  const rawSym = String(d4to5[0]?.[0] || "").trim();
  const upperCurr = currency.toUpperCase();
  const fallbackSym = upperCurr === "EUR" ? "€" : upperCurr === "USD" ? "$" : "£";
  const currencySymbol = rawSym
    ? (rawSym.toUpperCase() === "EUR" ? "€" : rawSym.toUpperCase() === "USD" ? "$" : rawSym.toUpperCase() === "GBP" ? "£" : rawSym)
    : fallbackSym;
  const thousandsSeparator = String(d4to5[1]?.[0] || "").trim() || (currencySymbol === "€" ? "." : ",");
  const b123to140 = vr[9]?.values || [];
  const thresholds = Array.from({ length: 18 }, (_, i) => b123to140[i]?.[0] ?? "");

  const summaryGrid = vr[4]?.values || [];
  const bdTopGrid = vr[5]?.values || []; // Rows 1..77
  const bdOhGrid = vr[6]?.values || [];  // Rows 82..205
  const y0PlSample = vr[7]?.values || [];
  const hasYear0PL = y0PlSample.length > 1;

  const startDateObj = parseYear0Date(rawB2);
  const startDateFormatted = startDateObj
    ? `${startDateObj.getDate()}-${SHORT_MONTHS[startDateObj.getMonth()]}-${String(startDateObj.getFullYear()).slice(-2)}`
    : String(rawB2 || "");
  const fallbackMonths = startDateObj ? buildYear0MonthColumns(startDateObj) : [];

  // Derive 12 month labels from Year0Data!G1:R1 or BE1:BP1 or KeyInfo!B2 - 12m
  const months = [];
  for (let m = 0; m < 12; m++) {
    const rawHeader = (summaryGrid[0]?.[6 + m] ?? "") || (bdTopGrid[0]?.[1 + m] ?? "");
    const parsed = parseYear0Date(rawHeader);
    if (parsed) {
      months.push({
        index: m,
        monthHeader: `${LONG_MONTHS[parsed.getMonth()]} ${parsed.getFullYear()}`,
        shortLabel: `${SHORT_MONTHS[parsed.getMonth()]} ${String(parsed.getFullYear()).slice(-2)}`,
      });
    } else if (fallbackMonths[m]) {
      months.push(fallbackMonths[m]);
    } else {
      months.push({ index: m, monthHeader: `Month ${m + 1}`, shortLabel: `M${m + 1}` });
    }
  }

  // Helper to read 12 monthly cells (cols G..R = idx 6..17 on summaryGrid, or cols BE..BP = idx 1..12 on bdTopGrid)
  const readSummary12 = (row1) => {
    const r = summaryGrid[row1 - 1] || [];
    return Array.from({ length: 12 }, (_, m) => round2(parseYear0Number(r[6 + m])));
  };
  const readBd12 = (row1) => {
    const r = bdTopGrid[row1 - 1] || [];
    return Array.from({ length: 12 }, (_, m) => round2(parseYear0Number(r[1 + m])));
  };

  // Manual adjustments live in G7:R7 (Rev), G15:R15 (CoS), G25:R25 (Overheads)
  const adjFormVR = adjFormResp.data?.valueRanges || [];
  const revAdj = readSummary12(7);
  const cosAdj = readSummary12(15);
  const ohAdj = readSummary12(25);
  const hasFormulaSlot = {
    revenue: (adjFormVR[0]?.values?.[0] || []).some((c) => typeof c === "string" && c.startsWith("=")),
    costOfSales: (adjFormVR[1]?.values?.[0] || []).some((c) => typeof c === "string" && c.startsWith("=")),
    overheads: (adjFormVR[2]?.values?.[0] || []).some((c) => typeof c === "string" && c.startsWith("=")),
  };

  // Dividends in lieu of salary: BE35:BP35 (CoS) and BE49:BP49 (Non-CoS)
  const cosDiv = readBd12(35);
  const nonCosDiv = readBd12(49);
  const monthlyDividends = Array.from({ length: 12 }, (_, m) => round2(cosDiv[m] + nonCosDiv[m]));
  const totalCosDiv = cosDiv.reduce((a, b) => a + b, 0);
  const totalNonCosDiv = nonCosDiv.reduce((a, b) => a + b, 0);
  const totalDividends = totalCosDiv + totalNonCosDiv;
  const deliveryPct =
    totalDividends > 0.005 ? round2((totalCosDiv / totalDividends) * 100) : 0;

  // Base totals excluding dividends and manual adjustments (1:1 with Year0Data structure)
  const be20 = readBd12(20); // Revenue mapped total
  const be36 = readBd12(36); // CoS staff total (includes row 35 cosDiv)
  const be50 = readBd12(50); // Non-CoS staff total (includes row 49 nonCosDiv)
  const be73 = readBd12(73); // Other CoS total
  const be76 = readBd12(76); // Overheads total (BE82:BE589)

  const sumRev4 = readSummary12(4);
  const sumRev5 = readSummary12(5);
  const sumRev6 = readSummary12(6);
  const sumRev8 = readSummary12(8);
  const baseRevenue = Array.from({ length: 12 }, (_, m) => {
    const sumSide = round2(sumRev4[m] + sumRev5[m] + sumRev6[m] + sumRev8[m]);
    return sumSide !== 0 || !hasYear0PL ? sumSide : be20[m];
  });

  // CoS staff excluding row 35 dividends, Non-CoS staff excluding row 49 dividends
  const cosStaffBase = Array.from({ length: 12 }, (_, m) => round2(be36[m] - cosDiv[m]));
  const nonCosStaffBase = Array.from({ length: 12 }, (_, m) => round2(be50[m] - nonCosDiv[m]));

  // CoS Other from summary rows 13 + 14 (or be73 when splitDelivery and income mode)
  const sumCos13 = readSummary12(13);
  const sumCos14 = readSummary12(14);
  const isIncomeMode = revOrInc.toLowerCase() === "income";
  const cosOther = Array.from({ length: 12 }, (_, m) => {
    if (!splitDelivery) return 0;
    const sumSide = round2(sumCos13[m] + sumCos14[m]);
    return sumSide !== 0 ? sumSide : isIncomeMode ? be73[m] : 0;
  });

  // Non-CoS Other from summary row 24 (or be76 + (splitDelivery && !isIncomeMode ? 0 : be73))
  const sumOh24 = readSummary12(24);
  const overheadsOther = Array.from({ length: 12 }, (_, m) => {
    const sumSide = round2(sumOh24[m]);
    if (sumSide !== 0) return sumSide;
    return splitDelivery ? be76[m] : round2(be73[m] + be76[m]);
  });

  // Mapped category line items (excluding dividends rows 35 & 49 so dividends aren't double-shown)
  const breakdown = {
    revenue: extractBreakdownRows(bdTopGrid, 2, 19, 1),
    cosStaff: extractBreakdownRows(bdTopGrid, 21, 34, 1),
    nonCosStaff: extractBreakdownRows(bdTopGrid, 37, 48, 1),
    otherCos: extractBreakdownRows(bdTopGrid, 55, 72, 1),
    corpTax: extractBreakdownRows(bdTopGrid, 51, 53, 1),
    overheads: extractBreakdownRows(bdOhGrid, 82, 205, 82),
  };

  return {
    clientName: clientName || "",
    masterSheetId: cleanMasterId,
    clientSheetId,
    startDate: startDateFormatted,
    currency,
    currencySymbol,
    thousandsSeparator,
    thresholds,
    revOrInc,
    splitDelivery,
    basis,
    hasYear0PL,
    accountingTool: auth?.tool || "",
    months,
    baseData: {
      revenue: baseRevenue,
      cosStaff: cosStaffBase,
      cosOther,
      nonCosStaff: nonCosStaffBase,
      overheadsOther,
    },
    dividends: {
      deliveryPct,
      monthly: monthlyDividends,
      cosMonthly: cosDiv,
      nonCosMonthly: nonCosDiv,
    },
    adjustments: {
      revenue: revAdj,
      costOfSales: cosAdj,
      overheads: ohAdj,
      hasFormulaSlot,
    },
    breakdown,
  };
}

/**
 * Pulls the 12-month Year 0 P&L from connected Xero or QuickBooks, writes Year0PLFromApp,
 * evaluates Year0Data, syncs Year0Data!A1:BZ205 to Client Sheet, and returns refreshed setup data.
 */
export async function pullYear0PL({ clientName, masterSheetId }) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const auth = await resolveAccountingToolAuth(clientName, cleanMasterId);
  if (!auth) {
    throw new Error("No active Xero or QuickBooks connection found for this client.");
  }

  const sheets = await getSheetsClient();
  const keyInfoResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: ["KeyInfo!B2", "KeyInfo!X28"],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const rawB2 = keyInfoResp.data?.valueRanges?.[0]?.values?.[0]?.[0];
  const rawClientSheetId = keyInfoResp.data?.valueRanges?.[1]?.values?.[0]?.[0] || "";
  const monthColumns = buildYear0MonthColumns(rawB2);
  if (monthColumns.length !== 12) {
    throw new Error("A valid start date is required in company settings before pulling Year 0 figures.");
  }

  const reportData =
    auth.tool === "Xero"
      ? await fetchXeroYear0PL(auth, monthColumns)
      : await fetchQuickBooksYear0PL(auth, monthColumns);

  if (!reportData || reportData.rowOrder.length === 0) {
    throw new Error(`No Year 0 P&L data was returned from ${auth.tool} for the 12 months prior to start date.`);
  }

  const matrix = buildYear0PLMatrix(reportData);
  const colCount = Math.max(...matrix.map((r) => r.length), 1);
  // colIndexToLetter is 1-based (1 -> A, 13 -> M)
  const endCol = colIndexToLetter(colCount);
  const targetRange = `Year0PLFromApp!A1:${endCol}${matrix.length}`;

  // Clear existing Year0PLFromApp contents and write updated matrix using explicit end bounds
  await withRetry(() =>
    sheets.spreadsheets.values.clear({
      spreadsheetId: cleanMasterId,
      range: "Year0PLFromApp!A1:Z600",
    })
  ).catch(() => { });

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: cleanMasterId,
      range: targetRange,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: matrix },
    })
  );

  // Ensure Client Sheet gets evaluated Year0Data snapshot (for Sheet and Supabase modes)
  const cleanClientId = resolveCleanId(rawClientSheetId);
  if (cleanMasterId.startsWith("sb-")) {
    await flushImmediateAndScheduleBackgroundClientRecomputes(clientName || cleanMasterId).catch(() => { });
  }
  if (cleanClientId) {
    await syncYear0DataToClientSheet(sheets, cleanMasterId, cleanClientId);
  }

  await invalidatePmaClientCache(cleanMasterId, clientName, ["setup", "dashboard", "mgmtRep", "all"]).catch(() => { });

  await logPmaActivity(sheets, {
    clientName: clientName || "",
    category: "SETUP",
    action: "YEAR0_PL_PULLED",
    summary: `Pulled Year 0 P&L (${reportData.rowOrder.length} rows) from ${auth.tool}`,
  }).catch(() => { });

  return await getYear0SetupData({ clientName, masterSheetId: cleanMasterId });
}

/**
 * Pure helper converting an opening balance + 12 consecutive month-end Balance Sheet balances
 * into 12 monthly outflow movements (oriented positive in the net direction of drawings/dividends).
 */
export function computeMonthlyMovementsFromBalances(openingBalance = 0, monthlyClosingBalances = []) {
  const open = parseYear0Number(openingBalance);
  const closings = Array.from({ length: 12 }, (_, m) => parseYear0Number(monthlyClosingBalances[m]));
  const rawDeltas = closings.map((curr, m) => round2(curr - (m === 0 ? open : closings[m - 1])));

  const netChange = round2(closings[11] - open);
  // In Xero/QB, Dividends Paid & overdrawn DLAs typically decrease Balance Sheet equity/liability (become more negative).
  // Orient outflows positively when netChange <= 0 (or majority of non-zero movements are negative).
  const nonZeroNeg = rawDeltas.filter((d) => d < -0.005).length;
  const nonZeroPos = rawDeltas.filter((d) => d > 0.005).length;
  const sign = netChange < -0.005 || (Math.abs(netChange) <= 0.005 && nonZeroNeg >= nonZeroPos) ? -1 : 1;

  const monthly = rawDeltas.map((d) => {
    const oriented = round2(d * sign);
    return Math.abs(oriented) < 0.005 ? 0 : oriented;
  });
  const annualTotal = round2(monthly.reduce((sum, v) => sum + v, 0));
  const monthlyAverage = round2(annualTotal / 12);

  return {
    openingBalance: round2(open),
    closingBalance: round2(closings[11]),
    monthly,
    annualTotal,
    monthlyAverage,
  };
}

/**
 * Extracts Year 0 Dividends / Directors' Loan / Drawings account balances from Xero.
 */
export async function extractXeroDividendCandidates(auth, monthColumns) {
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "xero-tenant-id": auth.tenantId,
    Accept: "application/json",
  };

  // Opening date = 1 day before Year 0 starts
  const [y, mo, da] = monthColumns[0].fromDateStr.split("-").map(Number);
  const dayBefore = new Date(y, mo - 1, da - 1);
  const openDateStr = `${dayBefore.getFullYear()}-${String(dayBefore.getMonth() + 1).padStart(2, "0")}-${String(dayBefore.getDate()).padStart(2, "0")}`;
  const endDateStr = monthColumns[11].toDateStr;

  const [accRes, openBsRes, yrBsRes] = await Promise.all([
    fetch("https://api.xero.com/api.xro/2.0/Accounts", { headers, redirect: "manual" }).catch(() => null),
    fetch(`https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?date=${openDateStr}`, { headers, redirect: "manual" }).catch(() => null),
    fetch(`https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?date=${endDateStr}&periods=11&timeframe=MONTH`, { headers, redirect: "manual" }).catch(() => null),
  ]);

  if (!accRes?.ok || !yrBsRes?.ok) {
    throw new Error("Could not fetch Balance Sheet and Chart of Accounts from Xero.");
  }

  const [accJson, openBsJson, yrBsJson] = await Promise.all([
    accRes.json(),
    openBsRes?.ok ? openBsRes.json().catch(() => null) : null,
    yrBsRes.json(),
  ]);

  const accounts = accJson?.Accounts || [];
  const candidateAccounts = [];
  for (const a of accounts) {
    const name = String(a.Name || "").trim();
    if (!name) continue;
    if (/ordinary shares|share capital|retained earnings|current year earnings|historical adjustment/i.test(name)) {
      continue;
    }
    const isDividend =
      (a.Class === "EQUITY" || a.Type === "EQUITY") &&
      /\bdividend/i.test(name);
    const isDla =
      /director(?:'s|s'|s)?\s*(?:loan|current)|\bdla\b|owner.*drawing|\bdrawings\b|shareholder\s*(?:loan|current)/i.test(name);
    if (isDividend || isDla) {
      candidateAccounts.push({
        accountId: a.AccountID,
        code: String(a.Code || "").trim(),
        name,
        kind: isDividend ? "dividend" : "dla",
      });
    }
  }

  if (candidateAccounts.length === 0) return [];

  const candidateById = new Map(candidateAccounts.map((c) => [c.accountId, c]));
  const candidateByName = new Map(candidateAccounts.map((c) => [c.name.toLowerCase(), c]));

  const openingByAcct = new Map();
  const walkOpen = (node) => {
    if (!node) return;
    if (node.RowType === "Row") {
      const cells = node.Cells || [];
      const title = String(cells[0]?.Value || "").trim();
      const acctAttr = (cells[0]?.Attributes || []).find((at) => String(at.Id || "").toLowerCase() === "account")?.Value;
      const match = (acctAttr && candidateById.get(acctAttr)) || candidateByName.get(title.toLowerCase());
      if (match) {
        openingByAcct.set(match.accountId, parseYear0Number(cells[1]?.Value));
      }
    }
    if (Array.isArray(node.Rows)) node.Rows.forEach(walkOpen);
  };
  (openBsJson?.Reports?.[0]?.Rows || []).forEach(walkOpen);

  // Periods=11 returns 12 columns newest-first (Month 12 .. Month 1)
  const monthlyByAcct = new Map();
  const walkYr = (node) => {
    if (!node) return;
    if (node.RowType === "Row") {
      const cells = node.Cells || [];
      const title = String(cells[0]?.Value || "").trim();
      const acctAttr = (cells[0]?.Attributes || []).find((at) => String(at.Id || "").toLowerCase() === "account")?.Value;
      const match = (acctAttr && candidateById.get(acctAttr)) || candidateByName.get(title.toLowerCase());
      if (match && cells.length >= 13) {
        // Reverse cells 1..12 so index 0 is Month 1 (oldest) and index 11 is Month 12 (newest)
        const reversed = [];
        for (let m = 12; m >= 1; m--) {
          reversed.push(parseYear0Number(cells[m]?.Value));
        }
        monthlyByAcct.set(match.accountId, reversed);
      }
    }
    if (Array.isArray(node.Rows)) node.Rows.forEach(walkYr);
  };
  (yrBsJson?.Reports?.[0]?.Rows || []).forEach(walkYr);

  return candidateAccounts
    .map((acct) => {
      const opening = openingByAcct.get(acct.accountId) ?? 0;
      const closings = monthlyByAcct.get(acct.accountId) || Array(12).fill(opening);
      const calc = computeMonthlyMovementsFromBalances(opening, closings);
      return {
        ...acct,
        ...calc,
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dividend" ? -1 : 1;
      return Math.abs(b.annualTotal) - Math.abs(a.annualTotal);
    });
}

/**
 * Extracts Year 0 Dividends / Directors' Loan / Drawings account balances from QuickBooks.
 */
export async function extractQuickBooksDividendCandidates(auth, monthColumns) {
  const safeRealmId = assertValidQBRealmId(auth.realmId);
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
  };

  const [y, mo, da] = monthColumns[0].fromDateStr.split("-").map(Number);
  const dayBefore = new Date(y, mo - 1, da - 1);
  const openDateStr = `${dayBefore.getFullYear()}-${String(dayBefore.getMonth() + 1).padStart(2, "0")}-${String(dayBefore.getDate()).padStart(2, "0")}`;
  const startDateStr = monthColumns[0].fromDateStr;
  const endDateStr = monthColumns[11].toDateStr;

  const accQuery = encodeURIComponent(
    "SELECT Id, Name, AccountType, AccountSubType, Active FROM Account WHERE AccountType IN ('Equity', 'Other Current Asset', 'Other Current Liability') AND Active = true MAXRESULTS 1000"
  );
  const [accRes, openBsRes, yrBsRes] = await Promise.all([
    fetch(`https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/query?query=${accQuery}&minorversion=73`, { headers, redirect: "manual" }).catch(() => null),
    fetch(`https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/reports/BalanceSheet?start_date=${openDateStr}&end_date=${openDateStr}&minorversion=73`, { headers, redirect: "manual" }).catch(() => null),
    fetch(`https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/reports/BalanceSheet?start_date=${startDateStr}&end_date=${endDateStr}&summarize_column_by=Month&minorversion=73`, { headers, redirect: "manual" }).catch(() => null),
  ]);

  if (!accRes?.ok || !yrBsRes?.ok) {
    throw new Error("Could not fetch Balance Sheet and Chart of Accounts from QuickBooks.");
  }

  const [accJson, openBsJson, yrBsJson] = await Promise.all([
    accRes.json(),
    openBsRes?.ok ? openBsRes.json().catch(() => null) : null,
    yrBsRes.json(),
  ]);

  const accounts = accJson?.QueryResponse?.Account || [];
  const candidateAccounts = [];
  for (const a of accounts) {
    const name = String(a.Name || "").trim();
    const subType = String(a.AccountSubType || "");
    if (!name) continue;
    if (/retained earnings|opening balance|share capital|common stock/i.test(name)) continue;
    const isDividend =
      a.AccountType === "Equity" &&
      (/\bdividend/i.test(name) || /dividend/i.test(subType));
    const isDla =
      /director(?:'s|s'|s)?\s*(?:loan|current)|\bdla\b|owner.*drawing|owner.*pay|\bdrawings\b|shareholder|distribution/i.test(name) ||
      /OwnerEquity|PartnerDistributions|ShareholderNotesPayable/i.test(subType);
    if (isDividend || isDla) {
      candidateAccounts.push({
        accountId: String(a.Id),
        code: "",
        name,
        kind: isDividend ? "dividend" : "dla",
      });
    }
  }

  if (candidateAccounts.length === 0) return [];
  const candidateById = new Map(candidateAccounts.map((c) => [c.accountId, c]));
  const candidateByName = new Map(candidateAccounts.map((c) => [c.name.toLowerCase(), c]));

  const openingByAcct = new Map();
  const walkQb = (rows, visitor) => {
    for (const r of rows || []) {
      if (r.ColData) visitor(r.ColData);
      if (r.Rows?.Row) walkQb(r.Rows.Row, visitor);
    }
  };
  walkQb(openBsJson?.Rows?.Row, (cols) => {
    const title = String(cols[0]?.value || "").trim();
    const id = cols[0]?.id ? String(cols[0].id) : "";
    const match = (id && candidateById.get(id)) || candidateByName.get(title.toLowerCase());
    if (match) openingByAcct.set(match.accountId, parseYear0Number(cols[1]?.value));
  });

  // QB BalanceSheet summarize_column_by=Month returns columns in chronological order (oldest -> newest) + optional Total col
  const monthlyByAcct = new Map();
  const colDefs = yrBsJson?.Columns?.Column || [];
  walkQb(yrBsJson?.Rows?.Row, (cols) => {
    const title = String(cols[0]?.value || "").trim();
    const id = cols[0]?.id ? String(cols[0].id) : "";
    const match = (id && candidateById.get(id)) || candidateByName.get(title.toLowerCase());
    if (match && cols.length >= 13) {
      // Take the first 12 data columns (index 1..12)
      const vals = [];
      for (let m = 1; m <= 12 && m < colDefs.length; m++) {
        vals.push(parseYear0Number(cols[m]?.value));
      }
      if (vals.length === 12) monthlyByAcct.set(match.accountId, vals);
    }
  });

  return candidateAccounts
    .map((acct) => {
      const opening = openingByAcct.get(acct.accountId) ?? 0;
      const closings = monthlyByAcct.get(acct.accountId) || Array(12).fill(opening);
      const calc = computeMonthlyMovementsFromBalances(opening, closings);
      return {
        ...acct,
        ...calc,
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dividend" ? -1 : 1;
      return Math.abs(b.annualTotal) - Math.abs(a.annualTotal);
    });
}

/**
 * Inspects Xero or QuickBooks Balance Sheet / Chart of Accounts to extract Year 0
 * Dividends Paid and Director's Loan / Drawings monthly movements.
 */
export async function detectYear0Dividends({ clientName, masterSheetId }) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const auth = await resolveAccountingToolAuth(clientName, cleanMasterId);
  if (!auth) {
    throw new Error("No active Xero or QuickBooks connection found for this client.");
  }

  const sheets = await getSheetsClient();
  const keyResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: ["KeyInfo!B2"],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const rawB2 = keyResp.data?.valueRanges?.[0]?.values?.[0]?.[0];
  const monthColumns = buildYear0MonthColumns(rawB2);
  if (monthColumns.length !== 12) {
    throw new Error("A valid start date is required before checking accounting dividend accounts.");
  }

  const candidates =
    auth.tool === "Xero"
      ? await extractXeroDividendCandidates(auth, monthColumns)
      : await extractQuickBooksDividendCandidates(auth, monthColumns);

  return {
    accountingTool: auth.tool,
    months: monthColumns.map((m) => ({ monthHeader: m.monthHeader, shortLabel: m.shortLabel })),
    candidates,
  };
}

/**
 * Saves Dividends in lieu of salary (Year0Data!BE35:BP35 & BE49:BP49) and
 * monthly category adjustments (G7:R7, G15:R15, G25:R25) to Master & Client sheets.
 */
export async function saveYear0Adjustments({
  clientName,
  masterSheetId,
  deliveryPct = 0,
  monthlyDividends = [],
  categoryAdjustments = {},
}) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const [keyResp, existingFormResp] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: cleanMasterId,
        ranges: ["KeyInfo!X28"],
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    ),
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: cleanMasterId,
        ranges: ["Year0Data!G7:R7", "Year0Data!G15:R15", "Year0Data!G25:R25"],
        valueRenderOption: "FORMULA",
      })
    ),
  ]);

  const rawClientSheetId = keyResp.data?.valueRanges?.[0]?.values?.[0]?.[0] || "";
  const { cosDividends, nonCosDividends } = splitDividendsByDeliveryPct(monthlyDividends, deliveryPct);

  const normalizeAdjRow = (arr) =>
    Array.from({ length: 12 }, (_, m) => round2(parseYear0Number(arr?.[m])));

  const revAdj = normalizeAdjRow(categoryAdjustments.revenue);
  const cosAdj = normalizeAdjRow(categoryAdjustments.costOfSales);
  const ohAdj = normalizeAdjRow(categoryAdjustments.overheads);

  const formRanges = existingFormResp.data?.valueRanges || [];
  const hasFormula = (idx) => (formRanges[idx]?.values?.[0] || []).some((c) => typeof c === "string" && c.startsWith("="));
  const isAllZero = (arr) => arr.every((v) => Math.abs(v) < 0.005);

  const batchData = [
    { range: "Year0Data!BE35:BP35", values: [cosDividends] },
    { range: "Year0Data!BE49:BP49", values: [nonCosDividends] },
  ];

  // Only write adjustment row if non-zero OR it currently contains static numbers (avoid clobbering blank Performance link if unused)
  if (!isAllZero(revAdj) || !hasFormula(0)) {
    batchData.push({ range: "Year0Data!G7:R7", values: [revAdj.map((v) => (v === 0 ? "" : v))] });
  }
  if (!isAllZero(cosAdj) || !hasFormula(1)) {
    batchData.push({ range: "Year0Data!G15:R15", values: [cosAdj.map((v) => (v === 0 ? "" : v))] });
  }
  if (!isAllZero(ohAdj) || !hasFormula(2)) {
    batchData.push({ range: "Year0Data!G25:R25", values: [ohAdj.map((v) => (v === 0 ? "" : v))] });
  }

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cleanMasterId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: batchData,
      },
    })
  );

  const cleanClientId = resolveCleanId(rawClientSheetId);
  if (cleanMasterId.startsWith("sb-")) {
    await flushImmediateAndScheduleBackgroundClientRecomputes(clientName || cleanMasterId).catch(() => { });
  }
  if (cleanClientId) {
    await syncYear0DataToClientSheet(sheets, cleanMasterId, cleanClientId);
  }

  await invalidatePmaClientCache(cleanMasterId, clientName, ["setup", "dashboard", "mgmtRep", "all"]).catch(() => { });

  const divTotal = monthlyDividends.reduce((s, v) => s + parseYear0Number(v), 0);
  await logPmaActivity(sheets, {
    clientName: clientName || "",
    category: "SETUP",
    action: "YEAR0_ADJUSTMENTS_SAVED",
    summary: `Saved Year 0 adjustments (Dividends in lieu of salary: ${round2(divTotal)}, Delivery split: ${round2(deliveryPct)}%)`,
  }).catch(() => { });

  return await getYear0SetupData({ clientName, masterSheetId: cleanMasterId });
}
