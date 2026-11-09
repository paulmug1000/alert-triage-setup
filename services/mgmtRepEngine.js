/**
 * PULSE NATIVE MGMTREP CALCULATION, STYLING & GOOGLE SLIDES ENGINE
 *
 * Eliminates the dependency on Google Master Sheets (MgmtRep, Calcs, MthlyClient)
 * and the legacy Reporting Control spreadsheet for EoM Management Reports:
 *  1. Dynamically computes the complete MgmtRep virtual grid from Client Sheet + Supabase Master grids.
 *  2. Applies 100% verbatim base styles & 61 conditional formatting rules for all 23 report tables.
 *  3. Rasterizes native SVG charts to 2x High-DPI PNGs via @resvg/resvg-js and updates Google Slides
 *     presentations directly via the Google Slides API + Supabase Storage.
 */

import fs from "fs";
import path from "path";
import { Resvg } from "@resvg/resvg-js";
import { getSupabaseAdmin } from "./supabaseClient.js";
import { getSlidesClient } from "./sheetsClient.js";
import { resolveSupabaseSheetContext, invalidateMasterEngineCache } from "./masterEngineService.js";
import {
  renderMgmtRepChartsFromGrid,
  buildMgmtRepChartIdMapFromGrid,
  normalizeReportLabel,
} from "./mgmtRepChartRenderer.js";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EOM_CHART_STORAGE_BUCKET = "eom-report-charts";

let _cachedTemplateStyles = null;
function getTemplateStyles_() {
  if (_cachedTemplateStyles) return _cachedTemplateStyles;
  try {
    const filePath = path.join(process.cwd(), "services", "mgmtRepTemplateStyles.json");
    const altPath = path.join(process.cwd(), "pulse-management-system", "services", "mgmtRepTemplateStyles.json");
    const target = fs.existsSync(filePath) ? filePath : altPath;
    _cachedTemplateStyles = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (err) {
    console.warn("[mgmtRepEngine] Could not load mgmtRepTemplateStyles.json:", err?.message);
    _cachedTemplateStyles = { blocks: [], conditionalFormats: [] };
  }
  return _cachedTemplateStyles;
}

// ============================================================================
// DATE, NUMBER & FORMATTING HELPERS
// ============================================================================

export function parseNumber(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  const s = String(val).trim();
  if (!s || s === "-" || s === "—" || s.startsWith("#")) return 0;
  const isParenNeg = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[£$,%\s▲▼+]/g, "").replace(/^\((.*)\)$/, "$1");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return isParenNeg ? -Math.abs(n) : n;
}

export function hasNumericValue(val) {
  if (val === null || val === undefined || val === "") return false;
  if (typeof val === "number") return Number.isFinite(val);
  const s = String(val).trim();
  if (!s || s.startsWith("#")) return false;
  const cleaned = s.replace(/[£$,%\s▲▼+]/g, "").replace(/^\((.*)\)$/, "$1");
  return cleaned !== "" && Number.isFinite(Number(cleaned));
}

function roundCommercial_(n) {
  return n < 0 ? -Math.round(Math.abs(n)) : Math.round(n);
}

export function formatCurrencyGBP(val, showZero = true) {
  if (val === null || val === undefined || val === "") return "";
  const n = typeof val === "number" ? val : parseNumber(val);
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n) < 0.0001 && !showZero) return "";
  const rounded = roundCommercial_(n);
  if (rounded === 0) return "£0";
  const sign = rounded < 0 ? "-" : "";
  return `${sign}£${Math.abs(rounded).toLocaleString("en-GB")}`;
}

export function formatPercentWhole(val) {
  if (val === null || val === undefined || val === "") return "";
  let n;
  if (typeof val === "number") {
    n = val;
  } else {
    const s = String(val).trim();
    if (!s || s.startsWith("#")) return "";
    if (s.includes("%")) {
      n = parseNumber(s) / 100;
    } else {
      n = parseNumber(s);
    }
  }
  if (!Number.isFinite(n)) return "";
  return `${roundCommercial_(n * 100)}%`;
}

export function parseRatioValue(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") {
    return Math.abs(val) > 2.5 ? val / 100 : val;
  }
  const s = String(val).trim();
  if (!s || s.startsWith("#")) return 0;
  const n = parseNumber(s);
  return s.includes("%") || Math.abs(n) > 2.5 ? n / 100 : n;
}

export function formatSnapshotDeltaArrow(pctVal) {
  if (pctVal === null || pctVal === undefined || pctVal === "") return "";
  const n = typeof pctVal === "number" ? pctVal : parseNumber(pctVal);
  if (!Number.isFinite(n)) return "";
  const roundedPct = roundCommercial_(n * 100);
  if (n >= 0) {
    return `▲ ${roundedPct}% `;
  }
  return `▼ ${roundedPct}% `;
}

export function parseMonthInfo(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number" && raw > 25000 && raw < 80000) {
    const utcMs = Math.round((raw - 25569) * 86400 * 1000);
    const d = new Date(utcMs);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  }
  const s = String(raw).trim();
  // YYYY-MM
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };

  // 1-Jan-2026 or 01-Oct-26
  m = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,9})[-\/\s](\d{2,4})$/);
  if (m) {
    const mIdx = MONTH_ABBR.findIndex((a) => a.toLowerCase() === m[2].slice(0, 3).toLowerCase());
    if (mIdx >= 0) {
      let yr = Number(m[3]);
      if (yr < 100) yr += 2000;
      return { year: yr, month: mIdx + 1 };
    }
  }

  // Oct 2026 or Oct 26 or October 2026
  m = s.match(/^([A-Za-z]{3,9})[\s\-\/](\d{2,4})$/);
  if (m) {
    const mIdx = MONTH_ABBR.findIndex((a) => a.toLowerCase() === m[1].slice(0, 3).toLowerCase());
    if (mIdx >= 0) {
      let yr = Number(m[2]);
      if (yr < 100) yr += 2000;
      return { year: yr, month: mIdx + 1 };
    }
  }
  return null;
}

export function monthIndex(ym) {
  if (!ym) return -1;
  return ym.year * 12 + (ym.month - 1);
}

export function addMonths(ym, delta) {
  const total = ym.year * 12 + (ym.month - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { year, month };
}

export function formatShortMonth(ym) {
  if (!ym) return "";
  return `${MONTH_ABBR[ym.month - 1]} ${String(ym.year).slice(-2)}`;
}

export function formatLongMonth(ym) {
  if (!ym) return "";
  return `${MONTH_ABBR[ym.month - 1]} ${ym.year}`;
}

export function formatDateDMonY(ym) {
  if (!ym) return "";
  return `1-${MONTH_ABBR[ym.month - 1]}-${ym.year}`;
}

export function ymToSerialFirstOfMonth(ym) {
  if (!ym) return 0;
  const utcMs = Date.UTC(ym.year, ym.month - 1, 1);
  return Math.round(utcMs / 86400000) + 25569;
}

export function ymToSerialEndOfMonth(ym) {
  if (!ym) return 0;
  const utcMs = Date.UTC(ym.year, ym.month, 0);
  return Math.round(utcMs / 86400000) + 25569;
}

export function parseA1RangeCoords(rangeA1 = "") {
  const clean = String(rangeA1 || "").replace(/^.*!/, "").trim();
  const m = clean.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!m) return null;
  const colToIdx0 = (letters) => {
    let n = 0;
    for (const ch of letters.toUpperCase()) {
      n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
  };
  const startCol0 = colToIdx0(m[1]);
  const startRow0 = Number(m[2]) - 1;
  const endCol0 = m[3] ? colToIdx0(m[3]) : startCol0;
  const endRow0 = m[4] ? Number(m[4]) - 1 : startRow0;
  return { startRow0, endRow0, startCol0, endCol0 };
}

// ============================================================================
// CORE MGMTREP DYNAMIC GRID CALCULATOR
// ============================================================================

/**
 * Computes the complete MgmtRep 2D display grid (1-indexed rows up to 2620)
 * directly from Client Sheet tabs + Supabase Master grids.
 */
export async function computeNativeMgmtRepForClient({
  sheets,
  clientId = null,
  clientName = "",
  clientSheetId,
  masterSheetId = null,
  reportMonthKey = "",
  checkedCategoriesOverride = null,
  persistToSupabase = true,
}) {
  const sb = getSupabaseAdmin();

  // 1. Resolve client context in Supabase
  const ctx = await resolveSupabaseSheetContext({
    clientName: clientName || undefined,
    spreadsheetId: clientSheetId || masterSheetId || undefined,
  });
  const resolvedClientId = clientId || ctx?.clientId || null;
  const resolvedClientName = clientName || ctx?.clientName || "";
  const resolvedClientSheetId = clientSheetId || ctx?.clientSheetId;

  // 2. Load Master tabs from Supabase master_sheet_grids (MgmtRep, KeyInfo, Year0Data, TimeComp)
  const masterGrids = {};
  if (sb && (resolvedClientName || resolvedClientId)) {
    let q = sb
      .from("master_sheet_grids")
      .select("tab_name, values_grid")
      .eq("sheet_role", "master")
      .in("tab_name", ["MgmtRep", "KeyInfo", "Year0Data", "TimeComp"]);
    if (resolvedClientName) q = q.eq("client_name", resolvedClientName);
    else q = q.eq("client_id", resolvedClientId);

    const { data: rows } = await q;
    for (const r of rows || []) {
      if (Array.isArray(r.values_grid)) {
        masterGrids[r.tab_name] = r.values_grid;
      }
    }
  }

  // Fallback to Template or any existing MgmtRep base grid if not yet in Supabase
  if (!masterGrids.MgmtRep && sb) {
    const { data: tplRows } = await sb
      .from("master_sheet_grids")
      .select("values_grid")
      .eq("sheet_role", "master")
      .eq("tab_name", "MgmtRep")
      .limit(1);
    if (tplRows?.[0]?.values_grid) {
      masterGrids.MgmtRep = tplRows[0].values_grid;
    }
  }

  // 3. Load live Client Sheet tabs (both FORMATTED_VALUE for exact display strings and UNFORMATTED_VALUE for unrounded math)
  const clientRanges = [
    "Dashboard!A1:BO150",
    "Budget!A1:BO325",
    "Outgoings!A1:BC235",
    "Cash!A1:BS80",
    "Monthly!A1:O2800",
  ];
  const [clientFmtRes, clientUnfmtRes] = await Promise.all([
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: resolvedClientSheetId,
      ranges: clientRanges,
      valueRenderOption: "FORMATTED_VALUE",
    }),
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: resolvedClientSheetId,
      ranges: [
        ...clientRanges,
        "ConfCalcs!E1:E1000",
        "ConfCalcs!HK1:HN1000",
        "PipeCalcs!E1:E1000",
        "PipeCalcs!HK1:HN1000",
      ],
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const vRanges = clientFmtRes?.data?.valueRanges || [];
  const dashGrid = vRanges[0]?.values || [];
  const budgetGrid = vRanges[1]?.values || [];
  const outgoingsGrid = vRanges[2]?.values || [];
  const cashGrid = vRanges[3]?.values || [];
  const monthlyGrid = vRanges[4]?.values || [];

  const uRanges = clientUnfmtRes?.data?.valueRanges || [];
  const dashUnfmt = uRanges[0]?.values || [];
  const budgetUnfmt = uRanges[1]?.values || [];
  const outgoingsUnfmt = uRanges[2]?.values || [];
  const cashUnfmt = uRanges[3]?.values || [];
  const monthlyUnfmt = uRanges[4]?.values || [];
  const confLeadCol = uRanges[5]?.values || [];
  const confDatesVals = uRanges[6]?.values || [];
  const pipeLeadCol = uRanges[7]?.values || [];
  const pipeDatesVals = uRanges[8]?.values || [];

  const keyInfoGrid = masterGrids.KeyInfo || [];
  const year0Grid = masterGrids.Year0Data || [];
  const timeCompGrid = masterGrids.TimeComp || [];

  // Clone MgmtRep base grid (preserving static labels, headings, and layout)
  const baseMgmt = masterGrids.MgmtRep || [];
  const maxRows = Math.max(baseMgmt.length, 2620);
  const mgmtGrid = Array.from({ length: maxRows }, (_, r) => {
    const src = baseMgmt[r];
    return Array.isArray(src) ? [...src] : [];
  });

  const getCell = (grid, r1, c1) => grid?.[r1 - 1]?.[c1 - 1] ?? "";
  const setCell = (r1, c1, val) => {
    while (mgmtGrid.length < r1) mgmtGrid.push([]);
    const row = mgmtGrid[r1 - 1];
    while (row.length < c1) row.push("");
    row[c1 - 1] = val === null || val === undefined ? "" : String(val);
  };

  // 4. Resolve KeyInfo parameters & Target Report Month
  const fyStartYm = parseMonthInfo(getCell(keyInfoGrid, 2, 2)) || { year: 2025, month: 1 };
  const revOrIncRaw = String(getCell(keyInfoGrid, 15, 2) || "Revenue").trim();
  const isIncomeMode = revOrIncRaw.toLowerCase() === "income";
  const revOrIncLabel = isIncomeMode ? "Income" : "Revenue";

  const targetYm =
    parseMonthInfo(reportMonthKey) ||
    parseMonthInfo(getCell(mgmtGrid, 1, 2)) ||
    addMonths(fyStartYm, 11);

  setCell(1, 2, formatLongMonth(targetYm)); // B1 e.g. "Oct 2026"

  // Find targetYm column in Dashboard!1:1 (1-based)
  const dashRow1 = dashGrid[0] || [];
  const findDashCol1 = (ym) => {
    if (!ym) return -1;
    const targetIdx = monthIndex(ym);
    for (let c1 = 1; c1 <= dashRow1.length; c1++) {
      const cellYm = parseMonthInfo(dashRow1[c1 - 1]);
      if (cellYm && monthIndex(cellYm) === targetIdx) return c1;
    }
    return -1;
  };

  const G2 = findDashCol1(targetYm);
  const currFyStartYear = targetYm.month < fyStartYm.month ? targetYm.year - 1 : targetYm.year;
  const currFyStartYm = { year: currFyStartYear, month: fyStartYm.month };
  const J2 = findDashCol1(currFyStartYm);
  const K2 = G2 > 0 && J2 > 0 ? G2 - J2 : Math.max(0, monthIndex(targetYm) - monthIndex(currFyStartYm));
  const M2 = G2 < 21 ? 1 : G2 < 36 ? 2 : 3;
  const nextMonthYm = addMonths(targetYm, 1);
  const O2 = G2 > 0 ? G2 + 1 : -1;

  setCell(2, 7, G2);
  setCell(2, 8, currFyStartYear);
  setCell(2, 9, formatDateDMonY(currFyStartYm));
  setCell(2, 10, J2);
  setCell(2, 11, K2);
  setCell(2, 12, revOrIncLabel);
  setCell(2, 13, M2);
  setCell(2, 14, formatDateDMonY(nextMonthYm));
  setCell(2, 15, O2);

  // Helper to lookup row by Col A label in a grid
  const findRowByColA = (grid, label, startR1 = 1, endR1 = grid.length) => {
    const cleanTarget = String(label || "").trim().toLowerCase();
    if (!cleanTarget) return -1;
    for (let r1 = startR1; r1 <= Math.min(endR1, grid.length); r1++) {
      const cellStr = String(getCell(grid, r1, 1) || "").trim().toLowerCase();
      if (cellStr === cleanTarget) return r1;
    }
    return -1;
  };

  // ============================================================================
  // SECTION A: 48-MONTH TREND TABLE (AB12:BX30) & QUARTERLY ROLLUP (AB33:BX45)
  // ============================================================================
  const year0StartYm = addMonths(fyStartYm, -12);
  const year0Row1 = year0Grid[0] || [];
  const findYear0Col1 = (ym) => {
    const idx = monthIndex(ym);
    for (let c1 = 1; c1 <= year0Row1.length; c1++) {
      const cYm = parseMonthInfo(year0Row1[c1 - 1]);
      if (cYm && monthIndex(cYm) === idx) return c1;
    }
    return -1;
  };

  const trendMetricRows = [
    { mgmtRow: 20, dashRow: 9, isPct: false },  // Total revenue / income
    { mgmtRow: 22, dashRow: 16, isPct: false }, // Total costs of sale
    { mgmtRow: 24, dashRow: 18, isPct: false }, // Gross profit
    { mgmtRow: 25, dashRow: 20, isPct: true },  // Gross profit margin %
    { mgmtRow: 27, dashRow: 24, isPct: false }, // Salaries
    { mgmtRow: 28, dashRow: 26, isPct: false }, // Total overheads
    { mgmtRow: 29, dashRow: 30, isPct: false }, // Operating profit
    { mgmtRow: 30, dashRow: 32, isPct: true },  // Operating profit %
  ];

  for (const tm of trendMetricRows) {
    const lbl = getCell(dashGrid, tm.dashRow, 1);
    if (lbl) setCell(tm.mgmtRow, 28, lbl);
  }

  // Track numeric values in trend table for exact quarterly rollups and MonthSnapshot
  const trendNumeric = {};
  for (const tm of trendMetricRows) trendNumeric[tm.mgmtRow] = {};

  for (let mIdx = 0; mIdx < 48; mIdx++) {
    const col1 = 29 + mIdx; // Col AC = 29 .. Col BX = 76
    const ym = addMonths(year0StartYm, mIdx);
    const qtrPos = (mIdx % 3) + 1;
    const qtrStartYm = addMonths(year0StartYm, Math.floor(mIdx / 3) * 3);

    setCell(12, col1, qtrPos);
    setCell(13, col1, formatDateDMonY(qtrStartYm));
    setCell(14, col1, formatShortMonth(ym));

    if (monthIndex(ym) <= monthIndex(targetYm)) {
      setCell(18, col1, formatShortMonth(ym));
      const isYear0 = monthIndex(ym) < monthIndex(fyStartYm);
      const srcGrid = isYear0 ? year0Grid : dashUnfmt;
      const srcCol1 = isYear0 ? findYear0Col1(ym) : findDashCol1(ym);

      for (const tm of trendMetricRows) {
        const label = getCell(mgmtGrid, tm.mgmtRow, 28);
        const srcRow1 = isYear0 ? findRowByColA(year0Grid, label, 1, 41) : tm.dashRow;
        const rawCell = srcCol1 > 0 && srcRow1 > 0 ? getCell(srcGrid, srcRow1, srcCol1) : "";
        if (rawCell === "" || rawCell === null || rawCell === undefined) {
          setCell(tm.mgmtRow, col1, "");
        } else {
          const num = tm.isPct ? parseRatioValue(rawCell) : parseNumber(rawCell);
          trendNumeric[tm.mgmtRow][col1] = num;
          setCell(tm.mgmtRow, col1, tm.isPct ? formatPercentWhole(num) : formatCurrencyGBP(num));
        }
      }
    } else {
      setCell(18, col1, "");
      for (const tm of trendMetricRows) {
        setCell(tm.mgmtRow, col1, "");
      }
    }
  }

  // Quarterly rollup in AB33:BF45 (16 quarters across cols 29..44)
  for (let q = 0; q < 16; q++) {
    const qCol1 = 29 + q;
    const m1Col = 29 + q * 3;
    const m2Col = m1Col + 1;
    const m3Col = m1Col + 2;
    const m3Ym = addMonths(year0StartYm, q * 3 + 2);
    if (monthIndex(m3Ym) <= monthIndex(targetYm)) {
      const revSum = (trendNumeric[20][m1Col] || 0) + (trendNumeric[20][m2Col] || 0) + (trendNumeric[20][m3Col] || 0);
      const cosSum = (trendNumeric[22][m1Col] || 0) + (trendNumeric[22][m2Col] || 0) + (trendNumeric[22][m3Col] || 0);
      const gpSum = (trendNumeric[24][m1Col] || 0) + (trendNumeric[24][m2Col] || 0) + (trendNumeric[24][m3Col] || 0);
      const gpPct = revSum !== 0 ? gpSum / revSum : 0;
      const salSum = (trendNumeric[27][m1Col] || 0) + (trendNumeric[27][m2Col] || 0) + (trendNumeric[27][m3Col] || 0);
      const ovhSum = (trendNumeric[28][m1Col] || 0) + (trendNumeric[28][m2Col] || 0) + (trendNumeric[28][m3Col] || 0);
      const ovhPct = revSum !== 0 ? ovhSum / revSum : 0;
      const opSum = (trendNumeric[29][m1Col] || 0) + (trendNumeric[29][m2Col] || 0) + (trendNumeric[29][m3Col] || 0);
      const opPct = revSum !== 0 ? opSum / revSum : 0;

      setCell(35, qCol1, formatCurrencyGBP(revSum));
      setCell(37, qCol1, formatCurrencyGBP(cosSum));
      setCell(39, qCol1, formatCurrencyGBP(gpSum));
      setCell(40, qCol1, formatPercentWhole(gpPct));
      setCell(41, qCol1, formatCurrencyGBP(salSum));
      setCell(42, qCol1, formatCurrencyGBP(ovhSum));
      setCell(43, qCol1, formatPercentWhole(ovhPct));
      setCell(44, qCol1, formatCurrencyGBP(opSum));
      setCell(45, qCol1, formatPercentWhole(opPct));
    } else {
      for (const r of [35, 37, 39, 40, 41, 42, 43, 44, 45]) setCell(r, qCol1, "");
    }
  }

  // ============================================================================
  // SECTION B: MONTH SNAPSHOT (C12:H26 & C31:J47)
  // ============================================================================
  const targetTrendCol1 = 29 + (monthIndex(targetYm) - monthIndex(year0StartYm));
  const prevMonthTrendCol1 = targetTrendCol1 - 1;
  const prevFyTrendCol1 = targetTrendCol1 - 12;

  const prevMonthYm = addMonths(targetYm, -1);
  const prevFyYm = addMonths(targetYm, -12);
  setCell(13, 3, formatDateDMonY(prevMonthYm));
  setCell(14, 3, formatDateDMonY(prevFyYm));
  setCell(15, 3, monthIndex(prevFyYm) < monthIndex(fyStartYm) ? "TRUE" : "FALSE");

  const computeSnapDiff = (currVal, prevVal, isGpPrevFy = false) => {
    const diff = currVal - prevVal;
    let pct = currVal !== 0 ? diff / currVal : 0;
    if (!isGpPrevFy && currVal < 0 && diff < 0) pct = -pct;
    const dir = diff > 0 ? "Up" : "Down";
    return { diff, pct, dir };
  };

  const revCurr = trendNumeric[20][targetTrendCol1] ?? 0;
  const revPrevM = trendNumeric[20][prevMonthTrendCol1] ?? 0;
  const revPrevY = trendNumeric[20][prevFyTrendCol1] ?? 0;
  const revDiffM = computeSnapDiff(revCurr, revPrevM);
  const revDiffY = computeSnapDiff(revCurr, revPrevY);

  const gpCurr = trendNumeric[24][targetTrendCol1] ?? 0;
  const gpPrevM = trendNumeric[24][prevMonthTrendCol1] ?? 0;
  const gpPrevY = trendNumeric[24][prevFyTrendCol1] ?? 0;
  const gpDiffM = computeSnapDiff(gpCurr, gpPrevM);
  const gpDiffY = computeSnapDiff(gpCurr, gpPrevY, true);

  const gpPctCurr = trendNumeric[25][targetTrendCol1] ?? 0;
  const gpPctPrevM = trendNumeric[25][prevMonthTrendCol1] ?? 0;
  const gpPctPrevY = trendNumeric[25][prevFyTrendCol1] ?? 0;
  const gpPctDiffM = computeSnapDiff(gpPctCurr, gpPctPrevM);
  const gpPctDiffY = computeSnapDiff(gpPctCurr, gpPctPrevY);

  const opCurr = trendNumeric[29][targetTrendCol1] ?? 0;
  const opPrevM = trendNumeric[29][prevMonthTrendCol1] ?? 0;
  const opPrevY = trendNumeric[29][prevFyTrendCol1] ?? 0;
  const opDiffM = computeSnapDiff(opCurr, opPrevM);
  const opDiffY = computeSnapDiff(opCurr, opPrevY);

  const opPctCurr = trendNumeric[30][targetTrendCol1] ?? 0;
  const opPctPrevM = trendNumeric[30][prevMonthTrendCol1] ?? 0;
  const opPctPrevY = trendNumeric[30][prevFyTrendCol1] ?? 0;
  const opPctDiffM = computeSnapDiff(opPctCurr, opPctPrevM);
  const opPctDiffY = computeSnapDiff(opPctCurr, opPctPrevY);

  // Populate helper rows 12..26
  const writeSnapHelperBlock = (baseRow, curr, prevM, prevY, diffM, diffY, isPct) => {
    const fmt = isPct ? formatPercentWhole : formatCurrencyGBP;
    setCell(baseRow, 5, fmt(curr));
    setCell(baseRow + 1, 5, fmt(prevM));
    setCell(baseRow + 1, 6, fmt(diffM.diff));
    setCell(baseRow + 1, 7, formatPercentWhole(diffM.pct));
    setCell(baseRow + 1, 8, diffM.dir);
    setCell(baseRow + 2, 5, fmt(prevY));
    setCell(baseRow + 2, 6, fmt(diffY.diff));
    setCell(baseRow + 2, 7, formatPercentWhole(diffY.pct));
    setCell(baseRow + 2, 8, diffY.dir);
  };

  writeSnapHelperBlock(12, revCurr, revPrevM, revPrevY, revDiffM, revDiffY, false);
  writeSnapHelperBlock(15, gpCurr, gpPrevM, gpPrevY, gpDiffM, gpDiffY, false);
  writeSnapHelperBlock(18, gpPctCurr, gpPctPrevM, gpPctPrevY, gpPctDiffM, gpPctDiffY, true);
  writeSnapHelperBlock(21, opCurr, opPrevM, opPrevY, opDiffM, opDiffY, false);
  writeSnapHelperBlock(24, opPctCurr, opPctPrevM, opPctPrevY, opPctDiffM, opPctDiffY, true);

  // Populate MonthSnapshot display cells (C31:J47)
  setCell(33, 3, revOrIncLabel);
  setCell(33, 6, formatCurrencyGBP(gpCurr));
  setCell(33, 9, formatCurrencyGBP(opCurr));

  setCell(35, 3, formatCurrencyGBP(revCurr));
  setCell(35, 6, formatSnapshotDeltaArrow(gpDiffM.pct));
  setCell(35, 9, formatSnapshotDeltaArrow(opDiffM.pct));

  setCell(36, 6, formatSnapshotDeltaArrow(gpDiffY.pct));
  setCell(36, 9, formatSnapshotDeltaArrow(opDiffY.pct));

  setCell(37, 3, formatSnapshotDeltaArrow(revDiffM.pct));
  setCell(38, 3, formatSnapshotDeltaArrow(revDiffY.pct));

  setCell(41, 6, formatPercentWhole(gpPctCurr));
  setCell(41, 9, formatPercentWhole(opPctCurr));

  setCell(43, 6, `${gpPctDiffM.dir === "Up" ? "▲" : "▼"} from ${formatPercentWhole(gpPctPrevM)}`);
  setCell(43, 9, `${opPctDiffM.dir === "Up" ? "▲" : "▼"} from ${formatPercentWhole(opPctPrevM)}`);
  setCell(44, 6, `${gpPctDiffY.dir === "Up" ? "▲" : "▼"} from ${formatPercentWhole(gpPctPrevY)}`);
  setCell(44, 9, `${opPctDiffY.dir === "Up" ? "▲" : "▼"} from ${formatPercentWhole(opPctPrevY)}`);

  // Helper mapping Dashboard row (4..32) to Budget row (5..10 / 21..26 for Revenue/Income, 29..49 for COS..OP)
  const getBudgetRowForDashRow = (dRow) => {
    if (dRow >= 4 && dRow <= 9) {
      return isIncomeMode ? dRow + 17 : dRow + 1;
    }
    if (dRow >= 12 && dRow <= 32) {
      return dRow + 17;
    }
    return -1;
  };

  // ============================================================================
  // SECTION C: BUSINESS PERFORMANCE (U106:AA137) & CURR/NEXT MONTH (U502:AA533)
  // ============================================================================
  const populateMonthVsBudgetBlock = (startRow1, dashCol1) => {
    if (dashCol1 <= 0) return;
    const mHeader = getCell(dashGrid, 1, dashCol1);
    const statusHeader = getCell(dashGrid, 2, dashCol1);
    const sectionHeader = getCell(dashGrid, 3, 1);

    setCell(startRow1, 22, mHeader); // Col V (22)
    setCell(startRow1 + 1, 21, getCell(dashGrid, 2, 1)); // Col U (21)
    setCell(startRow1 + 1, 22, statusHeader);
    setCell(startRow1 + 2, 21, sectionHeader);

    // Rows dashRow 4..32 map to startRow1 + 3 .. startRow1 + 31
    for (let dRow = 4; dRow <= 32; dRow++) {
      const mRow = startRow1 + (dRow - 1);
      const bRow = getBudgetRowForDashRow(dRow);
      const label = getCell(dashGrid, dRow, 1);
      const actFmt = getCell(dashGrid, dRow, dashCol1);
      const budFmt = bRow > 0 ? getCell(budgetGrid, bRow, dashCol1) : "";
      const actUnfmt = getCell(dashUnfmt, dRow, dashCol1);
      const budUnfmt = bRow > 0 ? getCell(budgetUnfmt, bRow, dashCol1) : "";

      setCell(mRow, 21, label);
      setCell(mRow, 22, actFmt);
      setCell(mRow, 24, budFmt);

      // Compute Var £ (Col Z = 26) and Var % (Col AA = 27) where applicable
      const isSpacerOrHeader =
        !label ||
        dRow === 10 || dRow === 11 || dRow === 17 || dRow === 19 ||
        dRow === 21 || dRow === 22 || dRow === 27 || dRow === 29 || dRow === 31;
      const isMarginPctRow = dRow === 20 || dRow === 28 || dRow === 32;
      const isPipelineOrNbRow = dRow === 5 || dRow === 6 || dRow === 7 || dRow === 8;

      if (isSpacerOrHeader || isMarginPctRow || isPipelineOrNbRow) {
        if (!isPipelineOrNbRow) {
          setCell(mRow, 26, "");
          setCell(mRow, 27, "");
        }
        continue;
      }

      if (label === "Hide") {
        setCell(mRow, 26, "£0");
        setCell(mRow, 27, "0%");
        continue;
      }

      if (hasNumericValue(actUnfmt) || hasNumericValue(budUnfmt)) {
        const actVal = parseNumber(actUnfmt);
        const budVal = parseNumber(budUnfmt);
        // Costs of sale (rows 12..16) and Overheads (rows 23..26) are expense rows: Var = Budget - Actual
        const isExpenseRow = (dRow >= 12 && dRow <= 16) || (dRow >= 23 && dRow <= 26);
        const varGbp = isExpenseRow ? budVal - actVal : actVal - budVal;
        const varPct = budVal !== 0 ? varGbp / budVal : 0;
        setCell(mRow, 26, formatCurrencyGBP(varGbp));
        setCell(mRow, 27, budVal !== 0 ? formatPercentWhole(varPct) : "0%");
      } else {
        setCell(mRow, 26, "");
        setCell(mRow, 27, "");
      }
    }
  };

  populateMonthVsBudgetBlock(106, G2); // [BusinessPerformance] U106:AA137
  populateMonthVsBudgetBlock(502, O2); // [CurrMonth] (Next month forecast) U502:AA533

  // ============================================================================
  // SECTION D: OVERHEADS (A371:F493 & AB371:AG493)
  // ============================================================================
  if (G2 > 0) {
    const mHeader = getCell(outgoingsGrid, 1, G2) || formatShortMonth(targetYm);
    setCell(371, 2, mHeader);
    setCell(371, 29, mHeader); // Col AC (29)

    const checkedRows = [];
    let totalAct = 0;
    let totalBud = 0;

    // Outgoings!A125:BC228 (104 rows -> MgmtRep rows 372..475)
    const maxOvhRows = 122;
    for (let i = 0; i < maxOvhRows; i++) {
      const mgmtR = 372 + i;
      const outR = 125 + i;
      const budR = 149 + i;

      const catName = outR <= 228 ? String(getCell(outgoingsGrid, outR, 1) || "").trim() : "";
      const actRaw = outR <= 228 ? getCell(outgoingsUnfmt, outR, G2) : "";
      const budRaw = budR <= 252 ? getCell(budgetUnfmt, budR, G2) : "";

      if (!catName) {
        setCell(mgmtR, 1, "");
        setCell(mgmtR, 2, "");
        setCell(mgmtR, 3, "");
        setCell(mgmtR, 4, "");
        setCell(mgmtR, 5, "");
        continue;
      }

      const actVal = parseNumber(actRaw);
      const budVal = parseNumber(budRaw);
      const varGbp = budVal - actVal;
      const varPctStr = budVal === 0 ? (varGbp < 0 ? "!!!" : "0%") : formatPercentWhole(varGbp / budVal);

      setCell(mgmtR, 1, catName);
      setCell(mgmtR, 2, formatCurrencyGBP(actVal));
      setCell(mgmtR, 3, formatCurrencyGBP(budVal));
      setCell(mgmtR, 4, formatCurrencyGBP(varGbp));
      setCell(mgmtR, 5, varPctStr);

      let isChecked = false;
      if (Array.isArray(checkedCategoriesOverride)) {
        isChecked = checkedCategoriesOverride.some(
          (c) => String(c || "").trim().toLowerCase() === catName.toLowerCase()
        );
        setCell(mgmtR, 6, isChecked ? "TRUE" : "FALSE");
      } else {
        const rawChk = String(getCell(mgmtGrid, mgmtR, 6) || "").trim().toUpperCase();
        isChecked = rawChk === "TRUE" || rawChk === "1" || rawChk === "YES";
      }

      totalAct += actVal;
      totalBud += budVal;

      if (isChecked) {
        checkedRows.push({
          catName,
          actStr: formatCurrencyGBP(actVal),
          budStr: formatCurrencyGBP(budVal),
          varGbpStr: formatCurrencyGBP(varGbp),
          varPctStr,
        });
      }
    }

    const totalVarGbp = totalBud - totalAct;
    const totalVarPctStr = totalBud !== 0 ? formatPercentWhole(totalVarGbp / totalBud) : "0%";
    setCell(370, 2, formatCurrencyGBP(totalAct));
    setCell(370, 3, formatCurrencyGBP(totalBud));
    setCell(370, 4, formatCurrencyGBP(totalVarGbp));
    setCell(370, 5, totalVarPctStr);

    // Populate filtered table AB372:AG493 (cols 28..33)
    for (let i = 0; i < maxOvhRows; i++) {
      const mgmtR = 372 + i;
      if (i < checkedRows.length) {
        const item = checkedRows[i];
        setCell(mgmtR, 28, item.catName);
        setCell(mgmtR, 29, item.actStr);
        setCell(mgmtR, 30, item.budStr);
        setCell(mgmtR, 31, "");
        setCell(mgmtR, 32, item.varGbpStr);
        setCell(mgmtR, 33, item.varPctStr);
      } else if (i === checkedRows.length) {
        // Spacer row before Total
        for (let c = 28; c <= 33; c++) setCell(mgmtR, c, "");
      } else if (i === checkedRows.length + 1) {
        // Total row
        setCell(mgmtR, 28, "Total");
        setCell(mgmtR, 29, formatCurrencyGBP(totalAct));
        setCell(mgmtR, 30, formatCurrencyGBP(totalBud));
        setCell(mgmtR, 31, "");
        setCell(mgmtR, 32, formatCurrencyGBP(totalVarGbp));
        setCell(mgmtR, 33, totalVarPctStr);
      } else {
        for (let c = 28; c <= 33; c++) setCell(mgmtR, c, "");
      }
    }
  }

  // ============================================================================
  // SECTION E: PERFORMANCE YTD (A540:T574)
  // ============================================================================
  if (J2 > 0 && G2 >= J2) {
    const ytdMonthsCount = Math.min(12, K2 + 1);
    const totalCol1 = 2 + ytdMonthsCount + 1;

    for (let offset = 0; offset < 14; offset++) {
      const col1 = 2 + offset;
      const dashCol = J2 + offset;
      setCell(541, col1, dashCol);

      if (offset < ytdMonthsCount) {
        setCell(542, col1, dashCol);
        setCell(544, col1, getCell(dashGrid, 1, dashCol));
        setCell(545, col1, getCell(dashGrid, 2, dashCol));
      } else if (offset === ytdMonthsCount) {
        setCell(542, col1, "");
        setCell(544, col1, "");
        setCell(545, col1, "");
      } else if (offset === ytdMonthsCount + 1) {
        setCell(542, col1, "Total");
        setCell(544, col1, "Total");
        setCell(545, col1, "");
      } else {
        setCell(542, col1, "");
        setCell(544, col1, "");
        setCell(545, col1, "");
      }
    }

    const perfYtdDashRows = [4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
    const ytdSumsByMgmtRow = {};

    for (let idx = 0; idx < perfYtdDashRows.length; idx++) {
      const dRow = perfYtdDashRows[idx];
      const bRow = getBudgetRowForDashRow(dRow);
      const mRow = 547 + idx; // 547 .. 574
      const label = getCell(dashGrid, dRow, 1);
      setCell(mRow, 1, label);

      const isSpacerOrHeader =
        !label ||
        dRow === 8 || dRow === 10 || dRow === 11 || dRow === 17 || dRow === 19 ||
        dRow === 21 || dRow === 22 || dRow === 27 || dRow === 29 || dRow === 31;
      const isPctRow = dRow === 20 || dRow === 28 || dRow === 32;

      let ytdActSum = 0;
      let ytdBudSum = 0;
      for (let m = 0; m < ytdMonthsCount; m++) {
        const dCol = J2 + m;
        const c1 = 2 + m;
        setCell(mRow, c1, getCell(dashGrid, dRow, dCol));
        if (!isSpacerOrHeader && !isPctRow) {
          ytdActSum += parseNumber(getCell(dashUnfmt, dRow, dCol));
          if (bRow > 0) {
            ytdBudSum += parseNumber(getCell(budgetUnfmt, bRow, dCol));
          }
        }
      }
      ytdSumsByMgmtRow[mRow] = { ytdActSum, ytdBudSum };

      // Clear remaining columns up to col 15 (O)
      for (let c1 = 2 + ytdMonthsCount; c1 <= 15; c1++) {
        setCell(mRow, c1, "");
      }

      if (isSpacerOrHeader) {
        setCell(mRow, 17, "");
        setCell(mRow, 19, "");
        setCell(mRow, 20, "");
        continue;
      }

      if (isPctRow) {
        const revAct = ytdSumsByMgmtRow[551]?.ytdActSum || 0;
        const revBud = ytdSumsByMgmtRow[551]?.ytdBudSum || 0;
        let numAct = 0;
        let numBud = 0;
        if (dRow === 20) {
          numAct = ytdSumsByMgmtRow[560]?.ytdActSum || 0;
          numBud = ytdSumsByMgmtRow[560]?.ytdBudSum || 0;
        } else if (dRow === 28) {
          numAct = ytdSumsByMgmtRow[568]?.ytdActSum || 0;
          numBud = ytdSumsByMgmtRow[568]?.ytdBudSum || 0;
        } else if (dRow === 32) {
          numAct = ytdSumsByMgmtRow[572]?.ytdActSum || 0;
          numBud = ytdSumsByMgmtRow[572]?.ytdBudSum || 0;
        }
        if (totalCol1 <= 15) setCell(mRow, totalCol1, revAct !== 0 ? formatPercentWhole(numAct / revAct) : "0%");
        setCell(mRow, 17, revBud !== 0 ? formatPercentWhole(numBud / revBud) : "0%");
        setCell(mRow, 19, "");
        setCell(mRow, 20, "");
      } else {
        if (totalCol1 <= 15) setCell(mRow, totalCol1, formatCurrencyGBP(ytdActSum));
        const isPipelineOrNbRow = dRow === 5 || dRow === 6;
        if (isPipelineOrNbRow) {
          setCell(mRow, 17, "");
          setCell(mRow, 19, "");
          setCell(mRow, 20, "");
        } else if (label === "Hide") {
          setCell(mRow, 17, "£0");
          setCell(mRow, 19, "£0");
          setCell(mRow, 20, "0%");
        } else {
          setCell(mRow, 17, formatCurrencyGBP(ytdBudSum));
          const isExpenseRow = (dRow >= 12 && dRow <= 16) || (dRow >= 23 && dRow <= 26);
          const varGbp = isExpenseRow ? ytdBudSum - ytdActSum : ytdActSum - ytdBudSum;
          const varPct = ytdBudSum !== 0 ? varGbp / ytdBudSum : 0;
          setCell(mRow, 19, formatCurrencyGBP(varGbp));
          setCell(mRow, 20, ytdBudSum !== 0 ? formatPercentWhole(varPct) : "0%");
        }
      }
    }
  }

  // ============================================================================
  // SECTION F: FY FORECAST (A643:T674) & NEXT FY FORECAST (AH643:AV674)
  // ============================================================================
  if (J2 > 0) {
    // Current FY: 12 months in cols B..M (2..13) = Dashboard cols J2..J2+11, Col O (15) = Dashboard col J2+13 ("FY total")
    for (let m = 0; m < 12; m++) {
      const c1 = 2 + m;
      const dCol = J2 + m;
      setCell(643, c1, getCell(dashGrid, 1, dCol));
      setCell(644, c1, getCell(dashGrid, 2, dCol));
    }
    setCell(643, 14, "");
    setCell(644, 14, "");
    setCell(643, 15, "FY total");
    setCell(644, 15, "");

    const fyTotalDashCol1 = J2 + 13;
    for (let dRow = 4; dRow <= 32; dRow++) {
      const mRow = 642 + dRow; // dRow 4 -> 646 .. dRow 32 -> 674
      const bRow = getBudgetRowForDashRow(dRow);
      const label = getCell(dashGrid, dRow, 1);
      setCell(mRow, 1, label);

      for (let m = 0; m < 12; m++) {
        setCell(mRow, 2 + m, getCell(dashGrid, dRow, J2 + m));
      }
      setCell(mRow, 14, "");
      const fyActFmt = getCell(dashGrid, dRow, fyTotalDashCol1);
      const fyBudFmt = bRow > 0 ? getCell(budgetGrid, bRow, fyTotalDashCol1) : "";
      const fyActUnfmt = getCell(dashUnfmt, dRow, fyTotalDashCol1);
      const fyBudUnfmt = bRow > 0 ? getCell(budgetUnfmt, bRow, fyTotalDashCol1) : "";
      setCell(mRow, 15, fyActFmt);

      const isSpacerOrHeader =
        !label ||
        dRow === 7 || dRow === 8 || dRow === 10 || dRow === 11 || dRow === 17 ||
        dRow === 19 || dRow === 21 || dRow === 22 || dRow === 27 || dRow === 29 || dRow === 31;
      const isPctRow = dRow === 20 || dRow === 28 || dRow === 32;
      const isPipelineOrNbRow = dRow === 5 || dRow === 6;

      if (isSpacerOrHeader || isPipelineOrNbRow) {
        setCell(mRow, 17, "");
        setCell(mRow, 19, "");
        setCell(mRow, 20, "");
      } else if (isPctRow) {
        setCell(mRow, 17, fyBudFmt);
        setCell(mRow, 19, "");
        setCell(mRow, 20, "");
      } else if (label === "Hide") {
        setCell(mRow, 17, "£0");
        setCell(mRow, 19, "£0");
        setCell(mRow, 20, "0%");
      } else {
        setCell(mRow, 17, fyBudFmt);
        const actVal = parseNumber(fyActUnfmt);
        const budVal = parseNumber(fyBudUnfmt);
        const isExpenseRow = (dRow >= 12 && dRow <= 16) || (dRow >= 23 && dRow <= 26);
        const varGbp = isExpenseRow ? budVal - actVal : actVal - budVal;
        const varPct = budVal !== 0 ? varGbp / budVal : 0;
        setCell(mRow, 19, formatCurrencyGBP(varGbp));
        setCell(mRow, 20, budVal !== 0 ? formatPercentWhole(varPct) : "0%");
      }
    }

    // Next FY Forecast (AH643:AV674, cols 34..48) if Next FY exists on Dashboard
    const nextFyStartYm = addMonths(currFyStartYm, 12);
    const nextFyDashCol1 = findDashCol1(nextFyStartYm);
    if (nextFyDashCol1 > 0) {
      for (let m = 0; m < 12; m++) {
        const c1 = 35 + m; // AI (35) .. AT (46)
        const dCol = nextFyDashCol1 + m;
        setCell(643, c1, getCell(dashGrid, 1, dCol));
        setCell(644, c1, getCell(dashGrid, 2, dCol));
      }
      setCell(643, 48, "FY total");
      for (let dRow = 4; dRow <= 32; dRow++) {
        const mRow = 642 + dRow;
        setCell(mRow, 34, getCell(dashGrid, dRow, 1));
        for (let m = 0; m < 12; m++) {
          setCell(mRow, 35 + m, getCell(dashGrid, dRow, nextFyDashCol1 + m));
        }
        setCell(mRow, 48, getCell(dashGrid, dRow, nextFyDashCol1 + 13));
      }
    }
  }

  // ============================================================================
  // SECTION G: TARGETS (A789:M797 & A801:N803)
  // ============================================================================
  if (J2 > 0) {
    for (let m = 0; m < 12; m++) {
      const c1 = 2 + m; // B..M
      const dCol = J2 + m;
      const mHdr = getCell(dashGrid, 1, dCol);
      const tRaw = getCell(dashGrid, 88, dCol);
      const aRaw = getCell(dashGrid, 89, dCol);
      const dRaw = getCell(dashGrid, 90, dCol);

      setCell(789, c1, mHdr);
      setCell(790, c1, tRaw);
      setCell(791, c1, aRaw);
      setCell(792, c1, dRaw);

      if (m <= K2) {
        setCell(801, c1, mHdr);
        setCell(802, c1, tRaw);
        setCell(803, c1, aRaw);
      } else {
        setCell(801, c1, "");
        setCell(802, c1, "");
        setCell(803, c1, "");
      }
    }
    setCell(801, 14, "");
    setCell(802, 14, "");
    setCell(803, 14, "");

    // Quarterly targets (Q1 at col 2, Q2 at col 5, Q3 at col 8, Q4 at col 11)
    for (let q = 0; q < 4; q++) {
      const c1 = 2 + q * 3;
      const dCol = J2 + q * 3;
      setCell(794, c1, `Q${q + 1}`);
      setCell(795, c1, getCell(dashGrid, 93, dCol));
      setCell(796, c1, getCell(dashGrid, 94, dCol));
      setCell(797, c1, getCell(dashGrid, 95, dCol));
    }
  }

  // ============================================================================
  // SECTION H: CASHFLOW (A829:H843 & AC831:AO835)
  // ============================================================================
  const cashRow1 = cashGrid[0] || [];
  const findCashCol1 = (ym) => {
    if (!ym) return -1;
    const idx = monthIndex(ym);
    for (let c1 = 1; c1 <= cashRow1.length; c1++) {
      const cYm = parseMonthInfo(cashRow1[c1 - 1]);
      if (cYm && monthIndex(cYm) === idx) return c1;
    }
    return -1;
  };

  const targetCashCol1 = findCashCol1(targetYm);
  if (targetCashCol1 > 0) {
    const startCashCol1 = targetCashCol1 + 1; // Next month (e.g. Nov 26)
    setCell(829, 3, startCashCol1);

    for (let i = 0; i < 7; i++) {
      const c1 = 2 + i; // B..H
      const cashCol = startCashCol1 + i;
      setCell(831, c1, getCell(cashGrid, 1, cashCol));
      setCell(832, c1, getCell(cashGrid, 2, cashCol));
      setCell(835, c1, getCell(cashGrid, 4, cashCol));  // Excl pipeline: Opening balance (row 835)
      setCell(836, c1, getCell(cashGrid, 32, cashCol)); // Excl pipeline: Net cash movement (row 836)
      setCell(837, c1, getCell(cashGrid, 34, cashCol)); // Excl pipeline: Closing balance (row 837)
      setCell(841, c1, getCell(cashGrid, 45, cashCol)); // Incl pipeline: Opening balance (row 841)
      setCell(842, c1, getCell(cashGrid, 74, cashCol)); // Incl pipeline: Net cash movement (row 842)
      setCell(843, c1, getCell(cashGrid, 76, cashCol)); // Incl pipeline: Closing balance (row 843)
    }

    // Chart data table AC831:AO835 (cols 30..41 = 12 months: targetYm - 3 .. targetYm + 8)
    for (let i = 0; i < 12; i++) {
      const c1 = 30 + i; // AD (30) .. AO (41)
      const ym = addMonths(targetYm, i - 3);
      if (monthIndex(ym) < monthIndex(fyStartYm)) {
        setCell(831, c1, "");
        setCell(833, c1, "");
        setCell(834, c1, "");
        setCell(835, c1, "");
        continue;
      }
      setCell(831, c1, formatLongMonth(ym));
      const cCol = findCashCol1(ym);
      const openExcl = cCol > 0 ? getCell(cashGrid, 4, cCol) : "";
      const openIncl = cCol > 0 ? getCell(cashGrid, 45, cCol) : "";

      if (i <= 4) {
        setCell(833, c1, openExcl);
      } else {
        setCell(833, c1, "");
      }

      if (i >= 4) {
        setCell(834, c1, openExcl);
        setCell(835, c1, openIncl);
      } else {
        setCell(834, c1, "");
        setCell(835, c1, "");
      }
    }
  }

  // ============================================================================
  // SECTION I: CLIENT BREAKDOWN (A1445:K1650 & A1679:M1705) FROM MONTHLY TAB
  // ============================================================================
  {
    // Parse Monthly!A1:O2800 into month blocks
    const monthBlocks = new Map(); // monthIndex -> { startRow0, endRow0 }
    let currentIdx = null;
    let currentStart = 0;
    for (let r0 = 0; r0 < monthlyGrid.length; r0++) {
      const cellA = String(monthlyGrid[r0]?.[0] || "").trim();
      const ym = cellA ? parseMonthInfo(cellA) : null;
      if (ym && cellA.length <= 10) {
        if (currentIdx !== null) {
          monthBlocks.set(currentIdx, { startRow0: currentStart, endRow0: r0 - 1 });
        }
        currentIdx = monthIndex(ym);
        currentStart = r0;
      }
    }
    if (currentIdx !== null) {
      monthBlocks.set(currentIdx, { startRow0: currentStart, endRow0: monthlyGrid.length - 1 });
    }

    // Collect all unique clients across the 12 months of the current FY
    const clientCanonicalMap = new Map(); // lower -> proper/display name
    const ensureClientKey = (rawName) => {
      const clean = String(rawName || "").trim();
      if (!clean || clean.toLowerCase() === "client" || clean.toUpperCase().includes("TOTAL:")) return null;
      const lower = clean.toLowerCase();
      if (!clientCanonicalMap.has(lower)) {
        const proper = clean
          .toLowerCase()
          .replace(/(?:^|[\s(-])([a-z])/g, (m) => m.toUpperCase());
        clientCanonicalMap.set(lower, proper);
      }
      return lower;
    };

    const clientFyData = new Map();
    const getClientEntry = (lower) => {
      if (!clientFyData.has(lower)) {
        clientFyData.set(lower, {
          name: clientCanonicalMap.get(lower),
          confProj: new Array(12).fill(0),
          confRet: new Array(12).fill(0),
          pipeProj: new Array(12).fill(0),
          pipeRet: new Array(12).fill(0),
        });
      }
      return clientFyData.get(lower);
    };

    for (let m = 0; m < 12; m++) {
      const ym = addMonths(currFyStartYm, m);
      const blk = monthBlocks.get(monthIndex(ym));
      if (!blk) continue;

      for (let r0 = blk.startRow0 + 4; r0 <= blk.endRow0; r0++) {
        const row = monthlyGrid[r0] || [];
        const uRow = monthlyUnfmt[r0] || row;
        const confClient = String(row[2] || "").trim();
        if (confClient && !confClient.toUpperCase().includes("TOTAL:")) {
          const cKey = ensureClientKey(confClient);
          if (cKey) {
            const entry = getClientEntry(cKey);
            const cType = String(row[4] || "").trim().toLowerCase();
            const val = parseNumber(isIncomeMode ? uRow[6] : uRow[5]);
            if (cType === "project") entry.confProj[m] += val;
            else if (cType === "retainer") entry.confRet[m] += val;
          }
        }
        const pipeClient = String(row[10] || "").trim();
        if (pipeClient && !pipeClient.toUpperCase().includes("TOTAL:")) {
          const pKey = ensureClientKey(pipeClient);
          if (pKey) {
            const entry = getClientEntry(pKey);
            const pType = String(row[12] || "").trim().toLowerCase();
            const val = parseNumber(isIncomeMode ? uRow[14] : uRow[13]);
            if (pType === "project") entry.pipeProj[m] += val;
            else if (pType === "retainer") entry.pipeRet[m] += val;
          }
        }
      }
    }

    const sortedClients = [...clientFyData.values()].sort((a, b) => a.name.localeCompare(b.name));
    const targetM = Math.max(0, Math.min(11, K2));

    // 1. Month Client Breakdown (A1450:E1650): filter clients where totalMonth[targetM] > 0
    const monthActiveClients = sortedClients.filter((c) => {
      const totMth = c.confProj[targetM] + c.confRet[targetM] + c.pipeProj[targetM] + c.pipeRet[targetM];
      return totMth > 0;
    });

    let mthProjTotal = 0;
    let mthRetTotal = 0;
    for (const c of monthActiveClients) {
      mthProjTotal += c.confProj[targetM];
      mthRetTotal += c.confRet[targetM];
    }
    const mthGrandTotal = mthProjTotal + mthRetTotal;
    setCell(1445, 3, formatCurrencyGBP(mthGrandTotal));
    setCell(1446, 3, formatCurrencyGBP(mthProjTotal));
    setCell(1447, 3, formatCurrencyGBP(mthRetTotal));

    for (let i = 0; i < 201; i++) {
      const r1 = 1450 + i;
      if (i < monthActiveClients.length) {
        const c = monthActiveClients[i];
        const cp = c.confProj[targetM];
        const cr = c.confRet[targetM];
        const tot = cp + cr;
        setCell(r1, 1, c.name);
        setCell(r1, 2, formatCurrencyGBP(cp));
        setCell(r1, 3, formatCurrencyGBP(cr));
        setCell(r1, 4, tot !== 0 ? formatCurrencyGBP(tot) : "");
        setCell(r1, 5, tot !== 0 && mthGrandTotal !== 0 ? formatPercentWhole(tot / mthGrandTotal) : "");
      } else {
        for (let col = 1; col <= 5; col++) setCell(r1, col, "");
      }
    }

    // 2. YTD Client Breakdown (G1450:K1650) & Stacked Column (A1679:M1705): filter clients where yrConfTotal > 0
    const ytdActiveClients = sortedClients.filter((c) => {
      const yrConf = c.confProj.reduce((a, b) => a + b, 0) + c.confRet.reduce((a, b) => a + b, 0);
      return yrConf > 0;
    });

    let ytdProjTotal = 0;
    let ytdRetTotal = 0;
    for (const c of ytdActiveClients) {
      for (let m = 0; m <= targetM; m++) {
        ytdProjTotal += c.confProj[m];
        ytdRetTotal += c.confRet[m];
      }
    }
    const ytdGrandTotal = ytdProjTotal + ytdRetTotal;
    setCell(1445, 9, formatCurrencyGBP(ytdGrandTotal));
    setCell(1446, 9, formatCurrencyGBP(ytdProjTotal));
    setCell(1447, 9, formatCurrencyGBP(ytdRetTotal));

    for (let i = 0; i < 201; i++) {
      const r1 = 1450 + i;
      if (i < ytdActiveClients.length) {
        const c = ytdActiveClients[i];
        let cpYtd = 0;
        let crYtd = 0;
        for (let m = 0; m <= targetM; m++) {
          cpYtd += c.confProj[m];
          crYtd += c.confRet[m];
        }
        const totYtd = cpYtd + crYtd;
        setCell(r1, 7, c.name);
        setCell(r1, 8, formatCurrencyGBP(cpYtd));
        setCell(r1, 9, formatCurrencyGBP(crYtd));
        setCell(r1, 10, formatCurrencyGBP(totYtd));
        setCell(r1, 11, totYtd !== 0 && ytdGrandTotal !== 0 ? formatPercentWhole(totYtd / ytdGrandTotal) : "");
      } else {
        for (let col = 7; col <= 11; col++) setCell(r1, col, "");
      }
    }

    // Populate A1679:M1705 (YTD Stacked Column table)
    for (let m = 0; m < 12; m++) {
      const c1 = 2 + m; // B..M
      if (m <= targetM) {
        setCell(1679, c1, formatShortMonth(addMonths(currFyStartYm, m)));
      } else {
        setCell(1679, c1, "");
      }
    }
    for (let i = 0; i < 30; i++) {
      const r1 = 1680 + i;
      if (i < ytdActiveClients.length) {
        const c = ytdActiveClients[i];
        setCell(r1, 1, c.name);
        for (let m = 0; m < 12; m++) {
          if (m <= targetM) {
            const mTot = c.confProj[m] + c.confRet[m] + c.pipeProj[m] + c.pipeRet[m];
            setCell(r1, 2 + m, formatCurrencyGBP(mTot));
          } else {
            setCell(r1, 2 + m, "");
          }
        }
      } else {
        for (let col = 1; col <= 13; col++) setCell(r1, col, "");
      }
    }
  }

  // ============================================================================
  // SECTION J: BOOKINGS & PIPELINE BY SOURCE × MONTH (FROM CONFCALCS & PIPECALCS)
  // ============================================================================
  {
    // Extract 41 lead sources from KeyInfo!G32:G72 (col 7, rows 32..72)
    const rawSources = [];
    for (let r1 = 32; r1 <= 72; r1++) {
      const s = String(getCell(keyInfoGrid, r1, 7) || "").trim();
      rawSources.push(s);
    }

    const computeSourceMatrixFor12Months = (leadCol, datesVals) => {
      // 12 months ending at targetYm: m = 0..11 -> addMonths(targetYm, m - 11)
      const months12 = Array.from({ length: 12 }, (_, m) => addMonths(targetYm, m - 11));
      const monthBounds = months12.map((ym) => ({
        ym,
        label: formatLongMonth(ym),
        startSerial: ymToSerialFirstOfMonth(ym),
        endSerial: ymToSerialEndOfMonth(ym),
      }));

      // Pre-parse rows from ConfCalcs / PipeCalcs
      const records = [];
      const rowCount = Math.max(leadCol.length, datesVals.length);
      for (let r0 = 5; r0 < rowCount; r0++) {
        const src = String(leadCol[r0]?.[0] || "").trim();
        if (!src) continue;
        const dv = datesVals[r0] || [];
        const hkStart = Number(dv[0]); // Col HK: Start of month serial
        const hlEnd = Number(dv[1]);   // Col HL: End of month serial
        const hmInc = parseNumber(dv[2]); // Col HM: Income
        const hnRev = parseNumber(dv[3]); // Col HN: Revenue
        const amount = isIncomeMode ? hmInc : hnRev;
        if (!Number.isFinite(hkStart) || !Number.isFinite(hlEnd) || amount === 0) continue;
        records.push({ src, hkStart, hlEnd, amount });
      }

      // Compute 41 sources × 12 months exactly matching Calcs SUMIFS formula:
      // SUMIFS(amount, HL >= monthStart, E == src) - SUMIFS(amount, HK > monthEnd, E == src)
      // which equals: sum of amount where E == src AND HL >= monthStart AND HK <= monthEnd
      const sourceRows = rawSources.map((fullSrc) => {
        const shortLabel = fullSrc.length > 6 ? fullSrc.slice(6) : fullSrc;
        const values12 = monthBounds.map((mb) => {
          if (!fullSrc) return 0;
          let sum = 0;
          for (const rec of records) {
            if (rec.src === fullSrc && rec.hlEnd >= mb.startSerial && rec.hkStart <= mb.endSerial) {
              sum += rec.amount;
            }
          }
          return sum;
        });
        const total12 = values12.reduce((a, b) => a + b, 0);
        const total6 = values12.slice(6).reduce((a, b) => a + b, 0);
        const total3 = values12.slice(9).reduce((a, b) => a + b, 0);
        const total1 = values12[11] || 0;
        return { fullSrc, shortLabel, values12, total12, total6, total3, total1 };
      });

      return { monthBounds, sourceRows };
    };

    const populateBookingsOrPipelineSection = ({
      leadCol,
      datesVals,
      rawStartRow1,       // 1917 for Bookings, 2223 for Pipeline
      filter12HeaderRow1, // 1963 for Bookings, 2269 for Pipeline
      subRawRow1,         // 2010 for Bookings, 2316 for Pipeline
      subFilterHeaderRow1,// 2057 for Bookings, 2363 for Pipeline
      summaryRows,        // { r12: [952, 954], r6: [983, 985], r3: [1014, 1016], r1: [1045, 1047], summaryCol2: 3 or 4 }
    }) => {
      const { monthBounds, sourceRows } = computeSourceMatrixFor12Months(leadCol, datesVals);

      // 1. Headers for 12m raw & filter tables
      for (let m = 0; m < 12; m++) {
        setCell(rawStartRow1, 2 + m, monthBounds[m].label);
        setCell(filter12HeaderRow1, 2 + m, monthBounds[m].label);
      }
      setCell(rawStartRow1, 14, "TOTAL");
      setCell(filter12HeaderRow1, 14, "TOTAL");

      // 2. Populate raw 41 rows
      const monthTotals12 = new Array(12).fill(0);
      for (let i = 0; i < 41; i++) {
        const r1 = rawStartRow1 + 1 + i;
        const sr = sourceRows[i];
        setCell(r1, 1, sr.shortLabel);
        for (let m = 0; m < 12; m++) {
          setCell(r1, 2 + m, sr.values12[m]);
          monthTotals12[m] += sr.values12[m];
        }
        setCell(r1, 14, sr.total12);
      }
      const grandTotal12 = monthTotals12.reduce((a, b) => a + b, 0);
      const rawTotRow1 = rawStartRow1 + 42;
      setCell(rawTotRow1, 1, "TOTAL");
      for (let m = 0; m < 12; m++) setCell(rawTotRow1, 2 + m, monthTotals12[m]);
      setCell(rawTotRow1, 14, grandTotal12);

      // 3. Populate filtered 12m table (rows filter12HeaderRow1 + 1 .. + 41, total at + 42)
      const active12 = sourceRows.filter((sr) => sr.shortLabel && sr.total12 > 0);
      for (let i = 0; i < 41; i++) {
        const r1 = filter12HeaderRow1 + 1 + i;
        if (i < active12.length) {
          const sr = active12[i];
          setCell(r1, 1, sr.shortLabel);
          for (let m = 0; m < 12; m++) setCell(r1, 2 + m, formatCurrencyGBP(sr.values12[m]));
          setCell(r1, 14, formatCurrencyGBP(sr.total12));
        } else {
          for (let c = 1; c <= 14; c++) setCell(r1, c, "");
        }
      }
      const filter12TotRow1 = filter12HeaderRow1 + 42;
      setCell(filter12TotRow1, 1, "TOTAL");
      for (let m = 0; m < 12; m++) setCell(filter12TotRow1, 2 + m, formatCurrencyGBP(monthTotals12[m]));
      setCell(filter12TotRow1, 14, formatCurrencyGBP(grandTotal12));

      // 4. Populate 6m (cols A:H), 3m (cols J:N), 1m (cols P:R) filtered tables at subFilterHeaderRow1
      for (let m = 0; m < 6; m++) setCell(subFilterHeaderRow1, 2 + m, monthBounds[6 + m].label);
      setCell(subFilterHeaderRow1, 8, "TOTAL");
      for (let m = 0; m < 3; m++) setCell(subFilterHeaderRow1, 11 + m, monthBounds[9 + m].label);
      setCell(subFilterHeaderRow1, 14, "TOTAL");
      setCell(subFilterHeaderRow1, 17, monthBounds[11].label);
      setCell(subFilterHeaderRow1, 18, "TOTAL");

      const active6 = sourceRows.filter((sr) => sr.shortLabel && sr.total6 > 0);
      const active3 = sourceRows.filter((sr) => sr.shortLabel && sr.total3 > 0);
      const active1 = sourceRows.filter((sr) => sr.shortLabel && sr.total1 > 0);

      for (let i = 0; i < 41; i++) {
        const r1 = subFilterHeaderRow1 + 1 + i;
        // 6m block (cols 1..8)
        if (i < active6.length) {
          const sr = active6[i];
          setCell(r1, 1, sr.shortLabel);
          for (let m = 0; m < 6; m++) setCell(r1, 2 + m, formatCurrencyGBP(sr.values12[6 + m]));
          setCell(r1, 8, formatCurrencyGBP(sr.total6));
        } else {
          for (let c = 1; c <= 8; c++) setCell(r1, c, "");
        }
        // 3m block (cols 10..14)
        if (i < active3.length) {
          const sr = active3[i];
          setCell(r1, 10, sr.shortLabel);
          for (let m = 0; m < 3; m++) setCell(r1, 11 + m, formatCurrencyGBP(sr.values12[9 + m]));
          setCell(r1, 14, formatCurrencyGBP(sr.total3));
        } else {
          for (let c = 10; c <= 14; c++) setCell(r1, c, "");
        }
        // 1m block (cols 16..18)
        if (i < active1.length) {
          const sr = active1[i];
          setCell(r1, 16, sr.shortLabel);
          setCell(r1, 17, formatCurrencyGBP(sr.total1));
          setCell(r1, 18, formatCurrencyGBP(sr.total1));
        } else {
          for (let c = 16; c <= 18; c++) setCell(r1, c, "");
        }
      }

      const grandTotal6 = monthTotals12.slice(6).reduce((a, b) => a + b, 0);
      const grandTotal3 = monthTotals12.slice(9).reduce((a, b) => a + b, 0);
      const grandTotal1 = monthTotals12[11] || 0;

      const subTotRow1 = subFilterHeaderRow1 + 42;
      setCell(subTotRow1, 1, "TOTAL");
      for (let m = 0; m < 6; m++) setCell(subTotRow1, 2 + m, formatCurrencyGBP(monthTotals12[6 + m]));
      setCell(subTotRow1, 8, formatCurrencyGBP(grandTotal6));
      setCell(subTotRow1, 10, "TOTAL");
      for (let m = 0; m < 3; m++) setCell(subTotRow1, 11 + m, formatCurrencyGBP(monthTotals12[9 + m]));
      setCell(subTotRow1, 14, formatCurrencyGBP(grandTotal3));
      setCell(subTotRow1, 16, "TOTAL");
      setCell(subTotRow1, 17, formatCurrencyGBP(grandTotal1));
      setCell(subTotRow1, 18, formatCurrencyGBP(grandTotal1));

      // 5. Populate slide summary cells (952..1174)
      const writeSumPair = (rowsPair, totalVal) => {
        const fmt = formatCurrencyGBP(totalVal);
        setCell(rowsPair[0], 2, fmt);
        setCell(rowsPair[0], 9, fmt);
        setCell(rowsPair[1], summaryRows.summaryColLeft, fmt);
        setCell(rowsPair[1], summaryRows.summaryColRight, fmt);
      };
      writeSumPair(summaryRows.r12, grandTotal12);
      writeSumPair(summaryRows.r6, grandTotal6);
      writeSumPair(summaryRows.r3, grandTotal3);
      writeSumPair(summaryRows.r1, grandTotal1);
    };

    // Bookings (ConfCalcs)
    populateBookingsOrPipelineSection({
      leadCol: confLeadCol,
      datesVals: confDatesVals,
      rawStartRow1: 1917,
      filter12HeaderRow1: 1963,
      subRawRow1: 2010,
      subFilterHeaderRow1: 2057,
      summaryRows: {
        r12: [952, 954],
        r6: [983, 985],
        r3: [1014, 1016],
        r1: [1045, 1047],
        summaryColLeft: 3,
        summaryColRight: 11,
      },
    });

    // Pipeline (PipeCalcs)
    populateBookingsOrPipelineSection({
      leadCol: pipeLeadCol,
      datesVals: pipeDatesVals,
      rawStartRow1: 2223,
      filter12HeaderRow1: 2269,
      subRawRow1: 2316,
      subFilterHeaderRow1: 2363,
      summaryRows: {
        r12: [1079, 1081],
        r6: [1110, 1112],
        r3: [1141, 1143],
        r1: [1172, 1174],
        summaryColLeft: 4,
        summaryColRight: 12,
      },
    });
  }

  // ============================================================================
  // SECTION K: UTILISATION (A1223:J1244) FROM TIMECOMP
  // ============================================================================
  if (timeCompGrid.length >= 10) {
    // Find targetYm block in TimeComp row 4 (index 3)
    const tcRow4 = timeCompGrid[3] || [];
    const tcRow8 = timeCompGrid[7] || [];
    let tcMonthStartCol0 = -1;
    const targetIdx = monthIndex(targetYm);
    for (let c0 = 0; c0 < tcRow4.length; c0++) {
      const ym = parseMonthInfo(tcRow4[c0]);
      if (ym && monthIndex(ym) === targetIdx) {
        tcMonthStartCol0 = c0;
        break;
      }
    }

    if (tcMonthStartCol0 >= 0) {
      // Find sub-column offsets within the month block from row 8 headers
      const findSubCol0 = (headerName) => {
        const target = headerName.toLowerCase();
        for (let c0 = tcMonthStartCol0; c0 < Math.min(tcRow8.length, tcMonthStartCol0 + 15); c0++) {
          if (String(tcRow8[c0] || "").trim().toLowerCase() === target) return c0;
        }
        return -1;
      };
      const colBillable = findSubCol0("Billable hrs logged");
      const colTotalLogged = findSubCol0("Total hrs logged");
      const colActualWorking = findSubCol0("Actual working hours");
      const colMissingHrs = findSubCol0("Missing hrs");
      const colUtilPct = findSubCol0("Util %");
      const colUtilTargetAch = findSubCol0("Util target ach %");
      // Util target % is in TimeComp!A8:D8
      let colUtilTarget = -1;
      for (let c0 = 0; c0 < 4; c0++) {
        if (String(tcRow8[c0] || "").trim().toLowerCase() === "util target %") colUtilTarget = c0;
      }

      const extractEmpRow = (tcRow0) => {
        const r = timeCompGrid[tcRow0] || [];
        const name = String(r[0] || "").trim();
        if (!name) return null;
        return {
          name,
          billable: colBillable >= 0 ? r[colBillable] ?? "0" : "0",
          totalLogged: colTotalLogged >= 0 ? r[colTotalLogged] ?? "0" : "0",
          actualWorking: colActualWorking >= 0 ? r[colActualWorking] ?? "0" : "0",
          missingHrs: colMissingHrs >= 0 ? r[colMissingHrs] ?? "0" : "0",
          utilPct: colUtilPct >= 0 ? r[colUtilPct] ?? "" : "",
          utilTarget: colUtilTarget >= 0 ? r[colUtilTarget] ?? "" : "",
          utilTargetAch: colUtilTargetAch >= 0 ? r[colUtilTargetAch] ?? "" : "",
        };
      };

      const totalEmp = extractEmpRow(9) || {
        name: "Total",
        billable: "0",
        totalLogged: "0",
        actualWorking: "0",
        missingHrs: "0",
        utilPct: "",
        utilTarget: "",
        utilTargetAch: "",
      };
      const empRows = [];
      for (let r0 = 11; r0 < Math.min(timeCompGrid.length, 62); r0++) {
        const emp = extractEmpRow(r0);
        if (emp) empRows.push(emp);
      }

      const stack = [
        ...(empRows.length > 0 ? empRows : [{ name: "", billable: "", totalLogged: "", actualWorking: "", missingHrs: "", utilPct: "", utilTarget: "", utilTargetAch: "" }]),
        { name: "", billable: "", totalLogged: "", actualWorking: "", missingHrs: "", utilPct: "", utilTarget: "", utilTargetAch: "" },
        totalEmp,
      ];

      for (let i = 0; i < 50; i++) {
        const r1 = 1224 + i;
        if (i < stack.length) {
          const item = stack[i];
          setCell(r1, 1, item.name);
          setCell(r1, 2, item.billable);
          setCell(r1, 3, item.totalLogged);
          setCell(r1, 4, item.actualWorking);
          setCell(r1, 5, item.missingHrs);
          setCell(r1, 6, "");
          setCell(r1, 7, item.utilPct);
          setCell(r1, 8, item.utilTarget);
          setCell(r1, 9, "");
          setCell(r1, 10, item.utilTargetAch);
        } else {
          for (let c = 1; c <= 10; c++) setCell(r1, c, "");
        }
      }
    }
  }

  // Persist updated MgmtRep virtual grid back to Supabase
  if (persistToSupabase && sb && resolvedClientName) {
    await sb.from("master_sheet_grids").upsert(
      {
        client_id: resolvedClientId,
        client_name: resolvedClientName,
        sheet_role: "master",
        tab_name: "MgmtRep",
        values_grid: mgmtGrid,
        formulas_grid: mgmtGrid,
        row_count: mgmtGrid.length,
        col_count: mgmtGrid.reduce((max, r) => Math.max(max, Array.isArray(r) ? r.length : 0), 35),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_name,sheet_role,tab_name" }
    );
    invalidateMasterEngineCache(resolvedClientName);
  }

  const charts = renderMgmtRepChartsFromGrid(mgmtGrid);
  const chartIdMap = buildMgmtRepChartIdMapFromGrid(mgmtGrid);

  return {
    mgmtGrid,
    charts,
    chartIdMap,
    targetYm,
    reportMonthLabel: formatLongMonth(targetYm),
  };
}

// ============================================================================
// NATIVE TABLE STYLING & CONDITIONAL FORMATTING ENGINE
// ============================================================================

function parseThresholdNumber_(raw, mgmtGrid) {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim();
  // Cell reference like "=$M$1232"
  const m = s.match(/^=?\$?([A-Z]+)\$?(\d+)$/i);
  if (m) {
    const coords = parseA1RangeCoords(`${m[1]}${m[2]}`);
    if (coords) {
      return parseNumber(mgmtGrid?.[coords.startRow0]?.[coords.startCol0]);
    }
  }
  if (s.endsWith("%")) {
    return parseFloat(s.slice(0, -1)) / 100;
  }
  return parseNumber(s);
}

function parseCellValueForCond_(rawVal, isPctHint = false) {
  if (rawVal === null || rawVal === undefined || rawVal === "") return { isBlank: true, num: NaN, str: "" };
  const str = String(rawVal).trim();
  if (!str) return { isBlank: true, num: NaN, str: "" };
  if (str.endsWith("%") || str.includes("%")) {
    const cleaned = str.replace(/[▲▼%\s+]/g, "");
    const n = Number(cleaned);
    return { isBlank: false, num: Number.isFinite(n) ? n / 100 : NaN, str };
  }
  const hasDigits = /\d/.test(str);
  if (!hasDigits) return { isBlank: false, num: NaN, str };
  const n = parseNumber(str);
  return { isBlank: false, num: isPctHint ? n / 100 : n, str };
}

function rgbObjToHex_(c) {
  if (!c || (c.red === undefined && c.green === undefined && c.blue === undefined)) return null;
  const r = Math.round((c.red ?? 0) * 255);
  const g = Math.round((c.green ?? 0) * 255);
  const b = Math.round((c.blue ?? 0) * 255);
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function evaluateConditionalRuleAtCell_(cf, r0, c0, mgmtGrid) {
  const br = cf.booleanRule;
  if (!br || !br.condition) return false;
  const type = br.condition.type;
  const condVals = (br.condition.values || []).map((v) => v.userEnteredValue ?? "");
  const rawCell = mgmtGrid?.[r0]?.[c0] ?? "";
  const cellInfo = parseCellValueForCond_(rawCell);

  if (type === "NOT_BLANK") {
    return !cellInfo.isBlank;
  }
  if (type === "BLANK") {
    return cellInfo.isBlank;
  }
  if (type === "TEXT_CONTAINS") {
    const needle = String(condVals[0] || "").toLowerCase();
    return Boolean(needle && cellInfo.str.toLowerCase().includes(needle));
  }
  if (
    type === "NUMBER_LESS" ||
    type === "NUMBER_LESS_THAN_EQ" ||
    type === "NUMBER_GREATER" ||
    type === "NUMBER_GREATER_THAN_EQ" ||
    type === "NUMBER_BETWEEN"
  ) {
    if (cellInfo.isBlank || !Number.isFinite(cellInfo.num)) return false;
    const v0 = parseThresholdNumber_(condVals[0], mgmtGrid);
    if (type === "NUMBER_LESS") return cellInfo.num < v0 - 1e-9;
    if (type === "NUMBER_LESS_THAN_EQ") return cellInfo.num <= v0 + 1e-9;
    if (type === "NUMBER_GREATER") return cellInfo.num > v0 + 1e-9;
    if (type === "NUMBER_GREATER_THAN_EQ") return cellInfo.num >= v0 - 1e-9;
    if (type === "NUMBER_BETWEEN") {
      const v1 = parseThresholdNumber_(condVals[1], mgmtGrid);
      const lo = Math.min(v0, v1);
      const hi = Math.max(v0, v1);
      return cellInfo.num >= lo - 1e-9 && cellInfo.num <= hi + 1e-9;
    }
  }
  if (type === "CUSTOM_FORMULA") {
    const f = String(condVals[0] || "").trim();
    // 1. Overheads empty row: =$AB372=""
    if (f === '=$AB372=""') {
      return String(mgmtGrid?.[r0]?.[27] ?? "").trim() === "";
    }
    // 2. Overheads Total row checks
    if (f.startsWith('=AND($AB372="Total"')) {
      const isTotal = String(mgmtGrid?.[r0]?.[27] ?? "").trim() === "Total";
      if (!isTotal) return false;
      const afInfo = parseCellValueForCond_(mgmtGrid?.[r0]?.[31]); // AF (col 32, idx 31)
      const agInfo = parseCellValueForCond_(mgmtGrid?.[r0]?.[32]); // AG (col 33, idx 32)
      if (f.includes("AF372<0.5%")) return agInfo.num < 0.005;
      if (f.includes("AF372>=0.5%")) return agInfo.num >= 0.005;
      if (f.includes("AF372<0.5")) return afInfo.num < 0.5;
      if (f.includes("AF372>=0.5")) return afInfo.num >= 0.5;
      return true;
    }
    if (f === '=$AB372="Total"') {
      return String(mgmtGrid?.[r0]?.[27] ?? "").trim() === "Total";
    }
    // 3. Hide row checks
    if (f === '=$U119="Hide"' || f === '=$U515="Hide"') {
      return String(mgmtGrid?.[r0]?.[20] ?? "").trim() === "Hide";
    }
    if (f === '=$A556="Hide"' || f === '=$A656="Hide"') {
      return String(mgmtGrid?.[r0]?.[0] ?? "").trim() === "Hide";
    }
    // 4. MonthSnapshot & QuarterSnapshot Up/Down checks: =H19="Up", =H20="Down", etc.
    const mUpDown = f.match(/^=([A-Z]+)(\d+)="(Up|Down)"$/i);
    if (mUpDown) {
      const coords = parseA1RangeCoords(`${mUpDown[1]}${mUpDown[2]}`);
      if (coords) {
        return String(mgmtGrid?.[coords.startRow0]?.[coords.startCol0] ?? "").trim() === mUpDown[3];
      }
    }
    // 5. Utilisation rules (rows 1224..1274)
    if (f === '=$A1224="Total"') {
      return String(mgmtGrid?.[r0]?.[0] ?? "").trim() === "Total";
    }
    if (f === '=AND($A1224="",$A1223="")') {
      return String(mgmtGrid?.[r0]?.[0] ?? "").trim() === "" && String(mgmtGrid?.[r0 - 1]?.[0] ?? "").trim() === "";
    }
    if (f.startsWith('=AND(A1224<>""')) {
      const aStr = String(mgmtGrid?.[r0]?.[0] ?? "").trim();
      if (!aStr) return false;
      const dNum = parseNumber(mgmtGrid?.[r0]?.[3]); // D: Actual working hrs
      const eNum = parseNumber(mgmtGrid?.[r0]?.[4]); // E: Hours not tracked
      const jInfo = parseCellValueForCond_(mgmtGrid?.[r0]?.[9]); // J: Actual v target %
      const ratioED = dNum > 0 ? eNum / dNum : 0;
      if (f.includes("(E1224/D1224)>$M$1226")) return ratioED > 0.1;
      if (f.includes("(E1224/D1224)<$M$1228")) return ratioED < 0.05;
      if (f.includes("(E1224/D1224)<$M$1226")) return ratioED <= 0.1;
      if (f.includes("J1224>$M$1232")) return jInfo.num > 0.85;
      if (f.includes("J1224>$M$1230")) return jInfo.num >= 0.75;
      if (f.includes("J1224<$M$1230")) return jInfo.num < 0.75;
    }
  }
  return false;
}

/**
 * Builds the array of styled table objects ({ code, sheetName, rangeA1, rowCount, colCount, rows })
 * from a 2D MgmtRep grid, applying exact base styles and conditional formatting rules.
 */
export function buildNativeStyledTables(mgmtGrid = [], chartRefsList = []) {
  const tpl = getTemplateStyles_();
  const blocks = tpl.blocks || [];
  const condRules = tpl.conditionalFormats || [];

  // Index base style blocks by (r0, c0) for O(1) lookup
  const baseStyleMap = new Map();
  for (const blk of blocks) {
    const rStart = blk.startRow || 0;
    const cStart = blk.startCol || 0;
    (blk.rows || []).forEach((rowArr, rIdx) => {
      (rowArr || []).forEach((cellStyle, cIdx) => {
        const key = `${rStart + rIdx}:${cStart + cIdx}`;
        if (!baseStyleMap.has(key)) {
          baseStyleMap.set(key, cellStyle);
        }
      });
    });
  }

  return chartRefsList
    .filter((ref) => ref && (ref.rangeA1 || ref.range))
    .map((ref) => {
      const rawRange = String(ref.rangeA1 || ref.range || "").trim();
      const cleanRangeA1 = rawRange.includes("!") ? rawRange.split("!")[1] : rawRange;
      const coords = parseA1RangeCoords(cleanRangeA1);
      if (!coords) return null;
      const { startRow0, endRow0, startCol0, endCol0 } = coords;
      const rows = [];

      for (let r0 = startRow0; r0 <= endRow0; r0++) {
        const rowCells = [];
        for (let c0 = startCol0; c0 <= endCol0; c0++) {
          const rawText = String(mgmtGrid?.[r0]?.[c0] ?? "");
          const text = c0 === startCol0 ? normalizeReportLabel(rawText) : rawText;
          // Lookup base style (for Overheads30..60 rows > 431, inherit from row 372)
          const styleLookupRow0 = r0 > 430 && r0 <= 492 && c0 >= 27 && c0 <= 32 ? 371 : r0;
          const base = baseStyleMap.get(`${styleLookupRow0}:${c0}`) || {
            bg: "#ffffff",
            fg: "#000000",
            bold: false,
            italic: false,
            underline: false,
            fontSize: 10,
            fontFamily: "Arial",
            align: "",
            valign: "MIDDLE",
          };

          const cellStyle = { ...base };

          // Evaluate conditional formatting rules in order (first matching rule wins per property in Google Sheets)
          let bgApplied = false;
          let fgApplied = false;
          let boldApplied = false;

          for (const cf of condRules) {
            const inRange = (cf.ranges || []).some(
              (rg) =>
                r0 >= (rg.startRowIndex ?? 0) &&
                r0 < (rg.endRowIndex ?? 0) &&
                c0 >= (rg.startColumnIndex ?? 0) &&
                c0 < (rg.endColumnIndex ?? 0)
            );
            if (!inRange) continue;
            if (!evaluateConditionalRuleAtCell_(cf, r0, c0, mgmtGrid)) continue;

            const fmt = cf.booleanRule?.format || {};
            const cfBg = rgbObjToHex_(fmt.backgroundColorStyle?.rgbColor || fmt.backgroundColor);
            const cfFg = rgbObjToHex_(fmt.textFormat?.foregroundColorStyle?.rgbColor || fmt.textFormat?.foregroundColor);
            if (cfBg && !bgApplied) {
              cellStyle.bg = cfBg;
              bgApplied = true;
            }
            if (cfFg && !fgApplied) {
              cellStyle.fg = cfFg;
              fgApplied = true;
            }
            if (typeof fmt.textFormat?.bold === "boolean" && !boldApplied) {
              cellStyle.bold = fmt.textFormat.bold;
              boldApplied = true;
            }
          }

          let align = String(cellStyle.align || "").toUpperCase();
          if (!align) {
            align = /^[£$-\d(▲▼+]/.test(text.trim()) && c0 > startCol0 ? "RIGHT" : "LEFT";
          }

          rowCells.push({
            v: text,
            text,
            bg: cellStyle.bg || "#ffffff",
            fg: cellStyle.fg || "#000000",
            b: Boolean(cellStyle.bold),
            bold: Boolean(cellStyle.bold),
            i: Boolean(cellStyle.italic),
            italic: Boolean(cellStyle.italic),
            u: Boolean(cellStyle.underline),
            underline: Boolean(cellStyle.underline),
            fontSize: cellStyle.fontSize || 10,
            fontFamily: cellStyle.fontFamily || "Arial",
            a: align.toLowerCase(),
            align,
            valign: cellStyle.valign || "MIDDLE",
          });
        }
        rows.push(rowCells);
      }

      return {
        code: ref.code,
        label: ref.label || String(ref.code || "").replace(/^\[|\]$/g, ""),
        sheetName: ref.sheetName || "MgmtRep",
        range: rawRange.includes("!") ? rawRange : `MgmtRep!${rawRange}`,
        rangeA1: cleanRangeA1,
        rowCount: rows.length,
        colCount: rows[0]?.length || 0,
        rows,
      };
    })
    .filter(Boolean);
}

// ============================================================================
// HIGH-DPI SVG RASTERIZER & NATIVE GOOGLE SLIDES DECK UPDATER
// ============================================================================

export function rasterizeSvgToPngBuffer(svgString, scale = 2) {
  const resvg = new Resvg(svgString, {
    fitTo: { mode: "zoom", value: scale },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "Arial",
    },
  });
  const rendered = resvg.render();
  return rendered.asPng();
}

async function ensureChartStorageBucket_(sb) {
  if (!sb) return false;
  try {
    const { data: buckets } = await sb.storage.listBuckets();
    if (!buckets?.some((b) => b.name === EOM_CHART_STORAGE_BUCKET)) {
      await sb.storage.createBucket(EOM_CHART_STORAGE_BUCKET, {
        public: false,
        fileSizeLimit: 10485760,
      });
    }
    return true;
  } catch (err) {
    console.warn("[mgmtRepEngine] Bucket check warning:", err?.message);
    return false;
  }
}

function hexToRgbColor_(hex) {
  const clean = String(hex || "#000000").replace("#", "").trim();
  if (clean.length !== 6) return { red: 0, green: 0, blue: 0 };
  return {
    red: parseInt(clean.slice(0, 2), 16) / 255,
    green: parseInt(clean.slice(2, 4), 16) / 255,
    blue: parseInt(clean.slice(4, 6), 16) / 255,
  };
}

/**
 * Updates a Google Slides Management Report presentation 100% natively:
 * - Replaces {{Month Year}} / {{Previous Month Year}} placeholders (when mode === "GENERATE")
 * - Rasterizes all native SVG charts to 2x High-DPI PNGs, uploads to Supabase Storage,
 *   and embeds/replaces every chart element on the presentation at its exact bounding box.
 * - Populates & styles every table whose slide speaker notes match a ChartRef [Code].
 */
export async function updateGoogleSlidesPresentationNative({
  presentationId,
  mgmtGrid,
  chartRefsList = [],
  targetMonthKey = "",
  mode = "UPDATE",
  skipChartRefresh = false,
}) {
  const slidesApi = await getSlidesClient();
  const sb = getSupabaseAdmin();

  const presRes = await slidesApi.presentations.get({ presentationId });
  const presentation = presRes.data;
  const slides = presentation.slides || [];

  const targetYm = parseMonthInfo(targetMonthKey) || parseMonthInfo(mgmtGrid?.[0]?.[1]) || { year: 2026, month: 10 };
  const prevYm = addMonths(targetYm, -1);
  const fullMonthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const shortMonthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const monthYearText = `${fullMonthNames[targetYm.month - 1]} ${targetYm.year}`;
  const prevMonthYearText = `${fullMonthNames[prevYm.month - 1]} ${prevYm.year}`;
  const targetFileStr = `${shortMonthNames[targetYm.month - 1]} ${String(targetYm.year).slice(-2)}`;
  const prevFileStr = `${shortMonthNames[prevYm.month - 1]} ${String(prevYm.year).slice(-2)}`;
  const targetCompactStr = `${shortMonthNames[targetYm.month - 1]}${String(targetYm.year).slice(-2)}`;
  const prevCompactStr = `${shortMonthNames[prevYm.month - 1]}${String(prevYm.year).slice(-2)}`;

  const styledTables = buildNativeStyledTables(mgmtGrid, chartRefsList);
  const styledTableByCode = new Map();
  for (const st of styledTables) {
    styledTableByCode.set(String(st.code || "").trim().toLowerCase(), st);
  }

  const chartIdMap = buildMgmtRepChartIdMapFromGrid(mgmtGrid);

  const batchRequests = [];
  let chartsUpdated = 0;
  const tablesUpdatedList = [];
  const uploadedChartPaths = [];

  // 1. Placeholder and prior-month date replacement on GENERATE
  if (String(mode).toUpperCase() === "GENERATE") {
    batchRequests.push(
      {
        replaceAllText: {
          containsText: { text: "{{Month Year}}", matchCase: false },
          replaceText: monthYearText,
        },
      },
      {
        replaceAllText: {
          containsText: { text: "{{Previous Month Year}}", matchCase: false },
          replaceText: prevMonthYearText,
        },
      },
      {
        replaceAllText: {
          containsText: { text: prevMonthYearText, matchCase: false },
          replaceText: monthYearText,
        },
      },
      {
        replaceAllText: {
          containsText: { text: prevFileStr, matchCase: false },
          replaceText: targetFileStr,
        },
      },
      {
        replaceAllText: {
          containsText: { text: prevCompactStr, matchCase: false },
          replaceText: targetCompactStr,
        },
      }
    );
  }

  // 2. Prepare chart PNG signed URLs for all chart elements present in the deck
  const chartSignedUrlByChartId = new Map();
  if (!skipChartRefresh && sb) {
    await ensureChartStorageBucket_(sb);
    const neededChartIds = new Set();

    for (const slide of slides) {
      for (const pe of slide.pageElements || []) {
        if (pe.sheetsChart?.chartId) {
          neededChartIds.add(Number(pe.sheetsChart.chartId));
        } else if (pe.image) {
          const alt = String(pe.title || pe.description || "");
          const m = alt.match(/PULSE_CHART:(\d+)/);
          if (m) neededChartIds.add(Number(m[1]));
        }
      }
    }

    const runStamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await Promise.all(
      [...neededChartIds].map(async (cid) => {
        const chartDef = chartIdMap.get(cid);
        if (!chartDef || !chartDef.svg) return;
        const isSparkline = chartDef.id.startsWith("sparkline");
        const pngBuffer = rasterizeSvgToPngBuffer(chartDef.svg, isSparkline ? 3 : 2);
        const storagePath = `${presentationId}/${runStamp}_chart_${cid}.png`;
        const { error: upErr } = await sb.storage
          .from(EOM_CHART_STORAGE_BUCKET)
          .upload(storagePath, pngBuffer, { contentType: "image/png", upsert: true });
        if (!upErr) {
          uploadedChartPaths.push(storagePath);
          const { data: signed } = await sb.storage
            .from(EOM_CHART_STORAGE_BUCKET)
            .createSignedUrl(storagePath, 300);
          if (signed?.signedUrl) {
            chartSignedUrlByChartId.set(cid, signed.signedUrl);
          }
        }
      })
    );
  }

  // 3. Walk slides and generate chart replacement + table cell formatting requests
  for (let sIdx = 0; sIdx < slides.length; sIdx++) {
    const slide = slides[sIdx];
    const slideId = slide.objectId;

    // Extract speaker notes text
    let notesText = "";
    for (const ne of slide.slideProperties?.notesPage?.pageElements || []) {
      for (const te of ne.shape?.text?.textElements || []) {
        if (te.textRun?.content) notesText += te.textRun.content;
      }
    }

    // 3a. Replace chart elements on this slide
    if (!skipChartRefresh) {
      for (const pe of slide.pageElements || []) {
        let matchedChartId = null;
        if (pe.sheetsChart?.chartId) {
          matchedChartId = Number(pe.sheetsChart.chartId);
        } else if (pe.image) {
          const alt = String(pe.title || pe.description || "");
          const m = alt.match(/PULSE_CHART:(\d+)/);
          if (m) matchedChartId = Number(m[1]);
        }

        if (matchedChartId && chartSignedUrlByChartId.has(matchedChartId)) {
          const signedUrl = chartSignedUrlByChartId.get(matchedChartId);
          const newObjId = `pulse_ch_${sIdx}_${matchedChartId}_${Date.now().toString(36).slice(-4)}`;
          batchRequests.push(
            {
              createImage: {
                objectId: newObjId,
                url: signedUrl,
                elementProperties: {
                  pageObjectId: slideId,
                  size: pe.size,
                  transform: pe.transform,
                },
              },
            },
            {
              updatePageElementAltText: {
                objectId: newObjId,
                title: `PULSE_CHART:${matchedChartId}`,
                description: `PULSE_CHART:${matchedChartId}`,
              },
            },
            {
              deleteObject: {
                objectId: pe.objectId,
              },
            }
          );
          chartsUpdated++;
        }
      }
    }

    // 3b. Update slide tables matching speaker notes [Code]
    const notesLower = notesText.toLowerCase();
    let matchedTableDef = null;
    for (const [codeLower, st] of styledTableByCode.entries()) {
      if (codeLower && notesLower.includes(codeLower)) {
        matchedTableDef = st;
        break;
      }
    }

    if (matchedTableDef) {
      const tableElements = (slide.pageElements || []).filter((pe) => pe.table);
      if (tableElements.length === 1) {
        const tblEl = tableElements[0];
        const tblObjId = tblEl.objectId;
        const slideRows = tblEl.table.rows || 0;
        const slideCols = tblEl.table.columns || 0;
        const maxR = Math.min(slideRows, matchedTableDef.rowCount);
        const maxC = Math.min(slideCols, matchedTableDef.colCount);

        for (let r = 0; r < maxR; r++) {
          for (let c = 0; c < maxC; c++) {
            const cellDef = matchedTableDef.rows[r]?.[c];
            if (!cellDef) continue;

            const existingCell = tblEl.table.tableRows?.[r]?.tableCells?.[c];
            const existingText = (existingCell?.text?.textElements || [])
              .map((te) => te.textRun?.content || "")
              .join("")
              .replace(/\n$/, "");

            // Clear existing text if non-empty
            if (existingText.length > 0) {
              batchRequests.push({
                deleteText: {
                  objectId: tblObjId,
                  cellLocation: { rowIndex: r, columnIndex: c },
                  textRange: { type: "ALL" },
                },
              });
            }

            // Update cell background color
            if (cellDef.bg) {
              batchRequests.push({
                updateTableCellProperties: {
                  objectId: tblObjId,
                  tableRange: {
                    location: { rowIndex: r, columnIndex: c },
                    rowSpan: 1,
                    columnSpan: 1,
                  },
                  tableCellProperties: {
                    tableCellBackgroundFill: {
                      solidFill: {
                        color: { rgbColor: hexToRgbColor_(cellDef.bg) },
                      },
                    },
                  },
                  fields: "tableCellBackgroundFill.solidFill.color",
                },
              });
            }

            // Insert new text and style it
            const newText = String(cellDef.text ?? "");
            if (newText.length > 0) {
              batchRequests.push({
                insertText: {
                  objectId: tblObjId,
                  cellLocation: { rowIndex: r, columnIndex: c },
                  insertionIndex: 0,
                  text: newText,
                },
              });

              const alignMap = {
                LEFT: "START",
                CENTER: "CENTER",
                RIGHT: "END",
              };
              const slideAlign = alignMap[String(cellDef.align || "").toUpperCase()] || "START";

              batchRequests.push(
                {
                  updateParagraphStyle: {
                    objectId: tblObjId,
                    cellLocation: { rowIndex: r, columnIndex: c },
                    style: { alignment: slideAlign },
                    textRange: { type: "ALL" },
                    fields: "alignment",
                  },
                },
                {
                  updateTextStyle: {
                    objectId: tblObjId,
                    cellLocation: { rowIndex: r, columnIndex: c },
                    style: {
                      bold: Boolean(cellDef.bold),
                      italic: Boolean(cellDef.italic),
                      underline: Boolean(cellDef.underline),
                      foregroundColor: {
                        opaqueColor: { rgbColor: hexToRgbColor_(cellDef.fg || "#000000") },
                      },
                    },
                    textRange: { type: "ALL" },
                    fields: "bold,italic,underline,foregroundColor",
                  },
                }
              );
            }
          }
        }
        tablesUpdatedList.push({
          code: matchedTableDef.code,
          slideNumber: sIdx + 1,
        });
      }
    }
  }

  // Execute batchUpdate in chunks of 450 requests to stay well within Google Slides API limits
  const CHUNK_SIZE = 450;
  for (let i = 0; i < batchRequests.length; i += CHUNK_SIZE) {
    const chunk = batchRequests.slice(i, i + CHUNK_SIZE);
    await slidesApi.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: chunk },
    });
  }

  // Clean up temporary chart PNGs from Supabase Storage
  if (uploadedChartPaths.length > 0 && sb) {
    sb.storage
      .from(EOM_CHART_STORAGE_BUCKET)
      .remove(uploadedChartPaths)
      .catch(() => {});
  }

  return {
    success: true,
    presentationId,
    reportUrl: `https://docs.google.com/presentation/d/${presentationId}/edit`,
    reportName: presentation.title || "",
    chartsUpdated,
    tablesUpdated: tablesUpdatedList,
    tablesUpdatedCount: tablesUpdatedList.length,
    totalRequests: batchRequests.length,
  };
}
