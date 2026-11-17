import templateData from "./clientSheetTemplateStyles.json";
import { colIndexToLetter, letterToColIndex } from "./masterComparisonSheetSpec.js";

export { colIndexToLetter, letterToColIndex };

export const CLIENT_SHEET_TABS = [
  "Confirmed",
  "Pipeline",
  "Cash",
  "NBtoFind",
  "Outgoings",
  "Salaries",
  "Budget",
];

const BOOKMARKS_BY_TAB = {
  Confirmed: [
    { label: "Job details", col: 0 },
    { label: "Fee & dates", col: 32 },
    { label: "Project invoices", col: 41 },
    { label: "Left to invoice", col: 74 },
    { label: "Direct costs", col: 75 },
  ],
  Pipeline: [
    { label: "Job details", col: 0 },
    { label: "Fee & likelihood", col: 32 },
    { label: "Project invoices", col: 41 },
    { label: "Direct costs", col: 75 },
    { label: "Copied?", col: 107 },
  ],
  Cash: [
    { label: "FY1", col: 1 },
    { label: "FY2", col: 13 },
    { label: "FY3", col: 25 },
  ],
  NBtoFind: [
    { label: "Targets", col: 0 },
    { label: "FY1", col: 6 },
    { label: "FY2", col: 21 },
    { label: "FY3", col: 36 },
  ],
  Outgoings: [
    { label: "Items", col: 0 },
    { label: "FY1", col: 6 },
    { label: "FY2", col: 21 },
    { label: "FY3", col: 36 },
  ],
  Salaries: [
    { label: "Staff info", col: 0 },
    { label: "FY1 (M1)", col: 11 },
    { label: "FY2 (M13)", col: 95 },
    { label: "FY3 (M25)", col: 179 },
  ],
  Budget: [
    { label: "P&L summary", col: 0 },
    { label: "FY1", col: 6 },
    { label: "FY2", col: 21 },
    { label: "FY3", col: 36 },
  ],
};

const decodedRowTplCache = new Map();

function getDecodedRowTemplate(tplId) {
  if (tplId === null || tplId === undefined) return null;
  if (decodedRowTplCache.has(tplId)) return decodedRowTplCache.get(tplId);
  const runs = templateData.rowTemplates?.[tplId];
  if (!Array.isArray(runs)) {
    decodedRowTplCache.set(tplId, null);
    return null;
  }
  const map = new Map();
  for (const [startC, endC, styleId] of runs) {
    for (let c = startC; c <= endC; c++) {
      map.set(c, styleId);
    }
  }
  decodedRowTplCache.set(tplId, map);
  return map;
}

export const CLIENT_SHEET_SPECS = (() => {
  const specs = {};
  for (const tabName of CLIENT_SHEET_TABS) {
    const raw = templateData.tabs?.[tabName];
    if (!raw) continue;
    specs[tabName] = {
      ...raw,
      hiddenCols: new Set(raw.hiddenCols || []),
      hiddenRows: new Set(raw.hiddenRows || []),
      bookmarks: BOOKMARKS_BY_TAB[tabName] || [],
    };
  }
  return specs;
})();

function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  const isParen = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()£$€,\s]/g, "");
  if (!cleaned) return NaN;
  if (cleaned.endsWith("%")) {
    const p = Number(cleaned.slice(0, -1));
    if (!Number.isFinite(p)) return NaN;
    return (isParen ? -Math.abs(p) : p) / 100;
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return NaN;
  return isParen ? -Math.abs(n) : n;
}

function getNum(rawValue, displayValue) {
  const n1 = toNum(rawValue);
  if (Number.isFinite(n1)) return n1;
  return toNum(displayValue);
}

function isNonBlank(rawValue, displayValue) {
  return String(rawValue ?? "").trim() !== "" || String(displayValue ?? "").trim() !== "";
}

function todayUtcSerial() {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor(utcMidnight / 86400000) + 25569;
}

function eomonthSerial(startSerial, monthsOffset = 0) {
  if (!Number.isFinite(startSerial)) return NaN;
  const ms = Math.round((startSerial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return NaN;
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthsOffset + 1, 0));
  return Math.floor(end.getTime() / 86400000) + 25569;
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SHORT_MONTHS_MAP = Object.fromEntries(SHORT_MONTHS.map((m, i) => [m.toLowerCase(), i]));

function parseDateToSerial(val) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  const s = String(val ?? "").trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m1 = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})$/);
  if (m1) {
    const mon = SHORT_MONTHS_MAP[m1[2].slice(0, 3).toLowerCase()];
    if (mon !== undefined) {
      let yr = parseInt(m1[3], 10);
      if (yr < 100) yr += yr < 50 ? 2000 : 1900;
      return Math.floor(Date.UTC(yr, mon, parseInt(m1[1], 10)) / 86400000) + 25569;
    }
  }
  const mIso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (mIso) {
    return Math.floor(Date.UTC(parseInt(mIso[1], 10), parseInt(mIso[2], 10) - 1, parseInt(mIso[3], 10)) / 86400000) + 25569;
  }
  return NaN;
}

function applyCashCf(style, { r, c, rawValue, displayValue, grid }) {
  const n = getNum(rawValue, displayValue);
  // CF[0]: NUMBER_EQ(50000) -> #ffff00
  if (
    ((r >= 19 && r <= 20 && (c === 0 || c >= 37)) ||
      (r === 20 && c >= 1 && c <= 36) ||
      (r >= 66 && r <= 67)) &&
    n === 50000
  ) {
    return { ...style, bg: "#ffff00" };
  }
  // CF[1]: NUMBER_EQ(-1000000) -> #ffff00
  if ((r === 18 || r === 20 || (r >= 60 && r <= 67)) && c >= 1 && c <= 36 && n === -1000000) {
    return { ...style, bg: "#ffff00" };
  }
  // CF[2]: NUMBER_GREATER(0) -> #fff2cc
  if ((r === 18 || r === 20 || (r >= 60 && r <= 67)) && c >= 1 && c <= 36 && n > 0) {
    return { ...style, bg: "#fff2cc" };
  }
  // CF[3]: =B$36<>"" on r=3 or r=44, c=2..36 -> #ead1dc
  if ((r === 3 || r === 44) && c >= 2 && c <= 36) {
    const refVal = String(grid?.[35]?.[c - 1] ?? "").trim();
    if (refVal !== "") {
      return { ...style, bg: "#ead1dc" };
    }
  }
  return style;
}

function applyConfirmedCf(style, { r, c, rawValue, displayValue, grid }) {
  if (r < 1) return style;
  const n = getNum(rawValue, displayValue);
  // CF[0/1]: BW (74) / DC (106) > 1 or < -1 -> #f4c7c3
  if ((c === 74 || c === 106) && (n > 1 || n < -1)) {
    return { ...style, bg: "#f4c7c3" };
  }
  // CF[2]: AO (40) TEXT_CONTAINS("Err") -> #f4cccc
  if (c === 40 && (String(displayValue ?? "").includes("Err") || String(rawValue ?? "").includes("Err"))) {
    return { ...style, bg: "#f4cccc" };
  }
  // CF[3]: AG (32) =AND(ISNUMBER($BW2),OR($BW2<-0.01,$BW2>0.01)) -> #ffefe0
  if (c === 32) {
    const bw = toNum(grid?.[r]?.[74]);
    if (Number.isFinite(bw) && (bw < -0.01 || bw > 0.01)) {
      return { ...style, bg: "#ffefe0" };
    }
  }
  // CF[4]: AH (33) =AND(ISNUMBER($DC2),OR($DC2<-0.01,$DC2>0.01)) -> #ffefe0
  if (c === 33) {
    const dc = toNum(grid?.[r]?.[106]);
    if (Number.isFinite(dc) && (dc < -0.01 || dc > 0.01)) {
      return { ...style, bg: "#ffefe0" };
    }
  }
  // CF[5/6/7]: AR (43), AY (50), BF (57) send dates
  if (c === 43 || c === 50 || c === 57) {
    const sendSerial = parseDateToSerial(grid?.[r]?.[c]);
    if (Number.isFinite(sendSerial)) {
      const today = todayUtcSerial();
      const status = String(grid?.[r]?.[c + 2] ?? "").trim();
      const notSentOrPaid = status !== "Paid" && status !== "Sent" && status !== "Part-paid (received)";
      if (sendSerial < today && notSentOrPaid) {
        return { ...style, bg: "#e06666" };
      }
      if (sendSerial < today + 30 && notSentOrPaid) {
        return { ...style, bg: "#fff2cc" };
      }
      const daysToPay = toNum(grid?.[r]?.[c + 1]);
      if (
        Number.isFinite(daysToPay) &&
        sendSerial + daysToPay < today &&
        status !== "Paid" &&
        status !== "Part-paid (received)"
      ) {
        return { ...style, bg: "#ff9900" };
      }
    }
  }
  // CF[8]: AP (41) =AND(AP2<>"",AJ2="Retainer",AM2>EOMONTH(AL2,0)) -> #ead1dc
  if (c === 41) {
    const apNonBlank = String(grid?.[r]?.[41] ?? "").trim() !== "";
    const aj = String(grid?.[r]?.[35] ?? "").trim();
    const al = parseDateToSerial(grid?.[r]?.[37]);
    const am = parseDateToSerial(grid?.[r]?.[38]);
    if (apNonBlank && aj === "Retainer" && Number.isFinite(al) && Number.isFinite(am)) {
      if (am > eomonthSerial(al, 0)) {
        return { ...style, bg: "#ead1dc" };
      }
    }
  }
  return style;
}

function applyPipelineCf(style, { r, c, rawValue, displayValue, grid }) {
  if (r < 1) return style;
  const n = getNum(rawValue, displayValue);
  if ((c === 74 || c === 106) && (n > 1 || n < -1)) {
    return { ...style, bg: "#f4c7c3" };
  }
  if (c === 40 && (String(displayValue ?? "").includes("Err") || String(rawValue ?? "").includes("Err"))) {
    return { ...style, bg: "#f4cccc" };
  }
  if (c === 32) {
    const ag = toNum(grid?.[r]?.[32]);
    const an = toNum(grid?.[r]?.[39]);
    const dd = String(grid?.[r]?.[107] ?? "").trim();
    if (Number.isFinite(ag) && ag !== 0 && Number.isFinite(an) && an !== 0 && dd !== "Yes") {
      return { ...style, bg: "#c9daf8" };
    }
  }
  if (c === 33) {
    const dc = toNum(grid?.[r]?.[106]);
    if (Number.isFinite(dc) && (dc < -0.01 || dc > 0.01)) {
      return { ...style, bg: "#fce5cd" };
    }
  }
  return style;
}

function applyNbToFindCf(style, { r, c, rawValue, displayValue }) {
  if ((r === 8 || r === 11) && c === 0) {
    const s = String(displayValue ?? rawValue ?? "").trim();
    if (s === "Yes") return { ...style, bg: "#d9ead3" };
  }
  return style;
}

function applyOutgoingsCf(style, { r, c, rawValue, displayValue }) {
  const n = getNum(rawValue, displayValue);
  if (
    c === 5 &&
    ((r >= 11 && r <= 109) ||
      r === 111 ||
      (r >= 124 && r <= 225) ||
      (r >= 260 && r <= 271) ||
      (r >= 280 && r <= 291)) &&
    Number.isFinite(n) &&
    n < 1
  ) {
    return { ...style, bg: "#ffff00" };
  }
  if (
    r === 110 &&
    ((c >= 6 && c <= 17) || (c >= 21 && c <= 32) || (c >= 36 && c <= 47)) &&
    Number.isFinite(n) &&
    n > 0
  ) {
    return { ...style, bg: "#ffff00" };
  }
  return style;
}

function applySalariesCf(style, { r, c, rawValue, displayValue }) {
  const n = getNum(rawValue, displayValue);
  if (
    Number.isFinite(n) &&
    n < 1 &&
    ((r >= 3 && r <= 52 && (c === 9 || c === 10)) ||
      (r >= 153 && r <= 202 && c === 10) ||
      (r >= 303 && r <= 352 && c === 10))
  ) {
    return { ...style, bg: "#ffff00" };
  }
  return style;
}

function applyBudgetCf(style, { r, c, rawValue, displayValue }) {
  const n = getNum(rawValue, displayValue);
  const str = String(displayValue ?? rawValue ?? "").trim();
  const inMainCols = (c >= 0 && c <= 34) || (c >= 36 && c <= 49);
  const inMonthCols = (c >= 6 && c <= 34) || (c >= 36 && c <= 49);
  const inYearAndMonthCols = (c >= 2 && c <= 19) || (c >= 21 && c <= 34) || (c >= 36 && c <= 49);

  // CF[0]: r36, c0 > 50% -> #d9ead3
  if (r === 36 && c === 0 && n > 0.5) return { ...style, bg: "#d9ead3" };
  // CF[1]: r9 / r27 c0 = "Hide from here" -> #fff2cc
  if ((r === 9 || r === 27) && c === 0 && str === "Hide from here") return { ...style, bg: "#fff2cc" };
  // CF[2]: r24 / r36 c0 = "Hide to here" -> #fff2cc
  if ((r === 24 || r === 36) && c === 0 && str === "Hide to here") return { ...style, bg: "#fff2cc" };
  // CF[3]: r44 c0 = "Hide" -> #fff2cc
  if (r === 44 && c === 0 && str === "Hide") return { ...style, bg: "#fff2cc" };

  // CF[4/6/7]: r48 Operating profit %
  if (r === 48 && inYearAndMonthCols && Number.isFinite(n)) {
    if (n < 0.05) return { ...style, bg: "#f4c7c3" };
    if (n >= 0.05 && n <= 0.15) return { ...style, bg: "#f9cb9c" };
    if (n > 0.15) return { ...style, bg: "#d9ead3" };
  }

  // CF[5]: r47 cols M, AB, AQ NOT_BLANK -> #b7e1cd
  if (r === 47 && (c === 12 || c === 27 || c === 42) && isNonBlank(rawValue, displayValue)) {
    return { ...style, bg: "#b7e1cd" };
  }

  // CF[8/9/10]: r50
  if (r === 50 && inYearAndMonthCols && Number.isFinite(n)) {
    if (n <= 0.55) return { ...style, bg: "#f9cb9c" };
    if (n > 0.55 && n <= 0.65) return { ...style, bg: "#d9ead3" };
    if (n > 0.55) return { ...style, bg: "#f4c7c3" };
  }

  // CF[11]: r1 c0..1 contains "Error present" -> #ff0000 / #ffffff
  if (r === 1 && (c === 0 || c === 1) && str.includes("Error present")) {
    return { ...style, bg: "#ff0000", fg: "#ffffff" };
  }

  // CF[12/13/14]: r36 Gross profit margin %
  if (r === 36 && inMainCols && Number.isFinite(n)) {
    if (n >= 0.5) return { ...style, bg: "#d9ead3" };
    if (n >= 0.45 && n <= 0.5) return { ...style, bg: "#fce5cd" };
    if (n <= 0.45) return { ...style, bg: "#f4cccc" };
  }

  // CF[15/16/17]: r44 Overheads as % of revenue
  if (r === 44 && inMonthCols && Number.isFinite(n)) {
    if (n > 0.3) return { ...style, bg: "#f4c7c3" };
    if (n >= 0.2 && n <= 0.3) return { ...style, bg: "#d9ead3" };
    if (n < 0.2) return { ...style, bg: "#fce5cd" };
  }

  // CF[18]: r19 c0 contains "Hide" -> #fff2cc
  if (r === 19 && c === 0 && str.includes("Hide")) {
    return { ...style, bg: "#fff2cc" };
  }

  return style;
}

export function getClientCellPresentation({ tabName, r, c, rawValue, displayValue, grid, dynamicLists }) {
  const spec = CLIENT_SHEET_SPECS[tabName];
  let rawStyle = null;
  if (spec) {
    let tplId = spec.rowMap?.[String(r)];
    if (tplId === undefined && r >= 2 && spec.defaultDataRowTemplateId !== null && spec.defaultDataRowTemplateId !== undefined) {
      tplId = spec.defaultDataRowTemplateId;
    }
    if (tplId !== undefined && tplId !== null) {
      const rowMap = getDecodedRowTemplate(tplId);
      const styleId = rowMap?.get(c);
      if (styleId !== undefined) {
        rawStyle = templateData.palette?.[styleId] || null;
      }
    }
  }

  let base = {
    bg: rawStyle?.bg || "#ffffff",
    fg: rawStyle?.fg || "#000000",
    fontSize: rawStyle?.fontSize || 10,
    bold: Boolean(rawStyle?.bold),
    italic: Boolean(rawStyle?.italic),
    align: rawStyle?.align || "left",
    valign: rawStyle?.valign || "bottom",
    wrap: rawStyle?.wrap === "WRAP",
    wrapStrategy: rawStyle?.wrap || "OVERFLOW_CELL",
    nf: rawStyle?.nf || "GENERAL",
    checkbox: Boolean(rawStyle?.checkbox),
    dv: Array.isArray(rawStyle?.dv)
      ? rawStyle.dv
      : rawStyle?.dvRange && Array.isArray(dynamicLists?.[rawStyle.dvRange])
        ? dynamicLists[rawStyle.dvRange]
        : null,
    borders: rawStyle?.b || null,
  };

  if (tabName === "Cash") return applyCashCf(base, { r, c, rawValue, displayValue, grid });
  if (tabName === "Confirmed") return applyConfirmedCf(base, { r, c, rawValue, displayValue, grid });
  if (tabName === "Pipeline") return applyPipelineCf(base, { r, c, rawValue, displayValue, grid });
  if (tabName === "NBtoFind") return applyNbToFindCf(base, { r, c, rawValue, displayValue });
  if (tabName === "Outgoings") return applyOutgoingsCf(base, { r, c, rawValue, displayValue });
  if (tabName === "Salaries") return applySalariesCf(base, { r, c, rawValue, displayValue });
  if (tabName === "Budget") return applyBudgetCf(base, { r, c, rawValue, displayValue });
  return base;
}

function excelSerialToUtcDate(serial) {
  if (typeof serial !== "number" || !Number.isFinite(serial) || serial < 1000) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatCellForClientSheet(rawValue, displayValue, numberFormat) {
  if (displayValue === null || displayValue === undefined) displayValue = "";
  const dispStr = String(displayValue);
  if (dispStr.startsWith("#")) return dispStr;

  const nf = String(numberFormat || "GENERAL");
  if (typeof rawValue === "boolean" || dispStr.toUpperCase() === "TRUE" || dispStr.toUpperCase() === "FALSE") {
    return dispStr.toUpperCase();
  }

  const isDispNumeric = dispStr !== "" && !Number.isNaN(Number(dispStr.replace(/,/g, "")));
  const num =
    typeof rawValue === "number" && Number.isFinite(rawValue)
      ? rawValue
      : isDispNumeric
        ? Number(dispStr.replace(/,/g, ""))
        : NaN;

  if (!Number.isFinite(num)) {
    return dispStr;
  }

  if (nf.startsWith("DATE:")) {
    if (!isDispNumeric && dispStr) return dispStr;
    const d = excelSerialToUtcDate(num);
    if (!d) return dispStr;
    const day = d.getUTCDate();
    const mon = SHORT_MONTHS[d.getUTCMonth()];
    const yrFull = d.getUTCFullYear();
    const yrShort = String(yrFull).slice(-2);
    if (nf.includes('mmm" "yy')) return `${mon} ${yrShort}`;
    if (nf.includes('mmm"-"yy') && !nf.includes("d")) return `${mon}-${yrShort}`;
    if (nf.includes("yyyy")) return `${day}-${mon}-${yrFull}`;
    return `${day}-${mon}-${yrShort}`;
  }

  if (nf.startsWith("PERCENT:")) {
    if (!isDispNumeric && dispStr.includes("%")) return dispStr;
    if (nf.includes(".0%")) return `${(num * 100).toFixed(1)}%`;
    return `${Math.round(num * 100)}%`;
  }

  if (nf.includes("£")) {
    if (!isDispNumeric && dispStr.includes("£")) return dispStr;
    const hasDecimals = nf.includes(".00");
    const sign = num < 0 ? "-" : "";
    if (hasDecimals) {
      return `${sign}£${Math.abs(num).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `${sign}£${Math.round(Math.abs(num)).toLocaleString("en-GB")}`;
  }

  if (nf === "NUMBER:#,##0") {
    return Math.round(num).toLocaleString("en-GB");
  }
  if (nf === "NUMBER:0.00") {
    return num.toFixed(2);
  }
  if (nf === "NUMBER:0") {
    return String(Math.round(num));
  }

  return dispStr !== "" ? dispStr : String(rawValue);
}
