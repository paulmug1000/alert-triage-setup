import templateData from "./clientSheetTemplateStyles.json";
import { colIndexToLetter, letterToColIndex } from "./masterComparisonSheetSpec.js";
import {
  SHORT_MONTHS_MAP,
  createRowTemplateDecoder,
  toSheetNum,
  getSheetNum,
  isSheetNonBlank,
  formatCellFromTemplateNf,
} from "./sheetTemplateUtils.js";

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

const getDecodedRowTemplate = createRowTemplateDecoder(templateData.rowTemplates);

export const CLIENT_SHEET_SPECS = (() => {
  const specs = {};
  for (const tabName of CLIENT_SHEET_TABS) {
    const raw = templateData.tabs?.[tabName];
    if (!raw) continue;
    const hiddenRows = new Set(raw.hiddenRows || []);
    if (tabName === "Confirmed" || tabName === "Pipeline") {
      // Keep spreadsheet row 2 (0-indexed row 1) visible by default in the DB screen
      hiddenRows.delete(1);
    }
    specs[tabName] = {
      ...raw,
      hiddenCols: new Set(raw.hiddenCols || []),
      hiddenRows,
      bookmarks: BOOKMARKS_BY_TAB[tabName] || [],
    };
  }
  return specs;
})();

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
  const mUk = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mUk) {
    const day = parseInt(mUk[1], 10);
    const mon = parseInt(mUk[2], 10) - 1;
    let yr = parseInt(mUk[3], 10);
    if (yr < 100) yr += yr < 50 ? 2000 : 1900;
    if (mon >= 0 && mon <= 11 && day >= 1 && day <= 31) {
      return Math.floor(Date.UTC(yr, mon, day) / 86400000) + 25569;
    }
  }
  const mIso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (mIso) {
    return Math.floor(Date.UTC(parseInt(mIso[1], 10), parseInt(mIso[2], 10) - 1, parseInt(mIso[3], 10)) / 86400000) + 25569;
  }
  return NaN;
}

function getGridCellVal(grid, rawGrid, r, c) {
  const raw = rawGrid?.[r]?.[c];
  if (raw !== undefined && raw !== null && raw !== "") return raw;
  return grid?.[r]?.[c];
}

function applyCashCf(style, { r, c, rawValue, displayValue, grid }) {
  const n = getSheetNum(rawValue, displayValue);
  if (
    ((r >= 19 && r <= 20 && (c === 0 || c >= 37)) ||
      (r === 20 && c >= 1 && c <= 36) ||
      (r >= 66 && r <= 67)) &&
    n === 50000
  ) {
    return { ...style, bg: "#ffff00" };
  }
  if ((r === 18 || r === 20 || (r >= 60 && r <= 67)) && c >= 1 && c <= 36 && n === -1000000) {
    return { ...style, bg: "#ffff00" };
  }
  if ((r === 18 || r === 20 || (r >= 60 && r <= 67)) && c >= 1 && c <= 36 && n > 0) {
    return { ...style, bg: "#fff2cc" };
  }
  if ((r === 3 || r === 44) && c >= 2 && c <= 36) {
    const refVal = String(grid?.[35]?.[c - 1] ?? "").trim();
    if (refVal !== "") {
      return { ...style, bg: "#ead1dc" };
    }
  }
  return style;
}

function applyConfirmedCf(style, { r, c, rawValue, displayValue, grid, rawGrid }) {
  if (r < 1) return style;
  const n = getSheetNum(rawValue, displayValue);
  if ((c === 74 || c === 106) && (n > 1 || n < -1)) {
    return { ...style, bg: "#f4c7c3" };
  }
  if (c === 40 && (String(displayValue ?? "").includes("Err") || String(rawValue ?? "").includes("Err"))) {
    return { ...style, bg: "#f4cccc" };
  }
  if (c === 32) {
    const bw = toSheetNum(getGridCellVal(grid, rawGrid, r, 74));
    if (Number.isFinite(bw) && (bw < -0.01 || bw > 0.01)) {
      return { ...style, bg: "#ffefe0" };
    }
  }
  if (c === 33) {
    const dc = toSheetNum(getGridCellVal(grid, rawGrid, r, 106));
    if (Number.isFinite(dc) && (dc < -0.01 || dc > 0.01)) {
      return { ...style, bg: "#ffefe0" };
    }
  }
  if (c === 43 || c === 50 || c === 57) {
    const sendSerial = parseDateToSerial(getGridCellVal(grid, rawGrid, r, c));
    if (Number.isFinite(sendSerial)) {
      const today = todayUtcSerial();
      const status = String(getGridCellVal(grid, rawGrid, r, c + 2) ?? "").trim();
      const notSentOrPaid = status !== "Paid" && status !== "Sent" && status !== "Part-paid (received)";
      if (sendSerial < today && notSentOrPaid) {
        return { ...style, bg: "#e06666" };
      }
      if (sendSerial < today + 30 && notSentOrPaid) {
        return { ...style, bg: "#fff2cc" };
      }
      const daysRaw = getGridCellVal(grid, rawGrid, r, c + 1);
      const daysToPay = String(daysRaw ?? "").trim() === "" ? 0 : toSheetNum(daysRaw);
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
  if (c === 41) {
    const apNonBlank = String(getGridCellVal(grid, rawGrid, r, 41) ?? "").trim() !== "";
    const aj = String(getGridCellVal(grid, rawGrid, r, 35) ?? "").trim();
    const al = parseDateToSerial(getGridCellVal(grid, rawGrid, r, 37));
    const am = parseDateToSerial(getGridCellVal(grid, rawGrid, r, 38));
    if (apNonBlank && aj === "Retainer" && Number.isFinite(al) && Number.isFinite(am)) {
      if (am > eomonthSerial(al, 0)) {
        return { ...style, bg: "#ead1dc" };
      }
    }
  }
  return style;
}

function isPipelineSssOrangeCol(c) {
  return (
    (c >= 3 && c <= 31) ||
    c === 34 ||
    c === 36 ||
    (c >= 41 && c <= 74) ||
    (c >= 76 && c <= 79) ||
    c === 83 ||
    (c >= 85 && c <= 86) ||
    c === 90 ||
    (c >= 92 && c <= 93) ||
    c === 106
  );
}

function applyPipelineCf(style, { r, c, rawValue, displayValue, grid, rawGrid }) {
  if (r === 0) {
    const ao1 = String(getGridCellVal(grid, rawGrid, 0, 40) ?? "").trim();
    if (ao1 === "SSS") {
      if (c >= 75 && c <= 94) {
        return { ...style, bg: "#c27ba0" };
      }
      if (isPipelineSssOrangeCol(c)) {
        return { ...style, bg: "#f6b26b" };
      }
    } else if (ao1 === "SSC" && (c === 3 || c === 4)) {
      return { ...style, bg: "#f9cb9c" };
    }
    return style;
  }

  const n = getSheetNum(rawValue, displayValue);
  if ((c === 74 || c === 106) && (n > 1 || n < -1)) {
    return { ...style, bg: "#f4c7c3" };
  }
  if (c === 40) {
    if (String(displayValue ?? "").includes("Err") || String(rawValue ?? "").includes("Err")) {
      return { ...style, bg: "#f4cccc" };
    }
    if (r === 2 && isSheetNonBlank(rawValue, displayValue)) {
      return { ...style, bg: "#b7e1cd" };
    }
  }
  if (c === 32) {
    const ag = toSheetNum(getGridCellVal(grid, rawGrid, r, 32));
    const an = toSheetNum(getGridCellVal(grid, rawGrid, r, 39));
    const dd = String(getGridCellVal(grid, rawGrid, r, 107) ?? "").trim();
    if (Number.isFinite(ag) && ag !== 0 && Number.isFinite(an) && an !== 0 && dd !== "Yes") {
      return { ...style, bg: "#c9daf8" };
    }
  }
  if (c === 33) {
    const dc = toSheetNum(getGridCellVal(grid, rawGrid, r, 106));
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
  const n = getSheetNum(rawValue, displayValue);
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

function applySalariesCf(style) {
  return style;
}

function applyBudgetCf(style, { r, c, rawValue, displayValue }) {
  const n = getSheetNum(rawValue, displayValue);
  const str = String(displayValue ?? rawValue ?? "").trim();
  const inMainCols = (c >= 0 && c <= 34) || (c >= 36 && c <= 49);
  const inMonthCols = (c >= 6 && c <= 34) || (c >= 36 && c <= 49);
  const inYearAndMonthCols = (c >= 2 && c <= 19) || (c >= 21 && c <= 34) || (c >= 36 && c <= 49);

  if (r === 36 && c === 0 && n > 0.5) return { ...style, bg: "#d9ead3" };
  if ((r === 9 || r === 27) && c === 0 && str === "Hide from here") return { ...style, bg: "#fff2cc" };
  if ((r === 24 || r === 36) && c === 0 && str === "Hide to here") return { ...style, bg: "#fff2cc" };
  if (r === 44 && c === 0 && str === "Hide") return { ...style, bg: "#fff2cc" };

  if (r === 48 && inYearAndMonthCols && Number.isFinite(n)) {
    if (n < 0.05) return { ...style, bg: "#f4c7c3" };
    if (n >= 0.05 && n <= 0.15) return { ...style, bg: "#f9cb9c" };
    if (n > 0.15) return { ...style, bg: "#d9ead3" };
  }

  if (r === 47 && (c === 12 || c === 27 || c === 42) && isSheetNonBlank(rawValue, displayValue)) {
    return { ...style, bg: "#b7e1cd" };
  }

  if (r === 50 && inYearAndMonthCols && Number.isFinite(n)) {
    if (n <= 0.55) return { ...style, bg: "#f9cb9c" };
    if (n > 0.55 && n <= 0.65) return { ...style, bg: "#d9ead3" };
    if (n > 0.55) return { ...style, bg: "#f4c7c3" };
  }

  if (r === 1 && (c === 0 || c === 1) && str.includes("Error present")) {
    return { ...style, bg: "#ff0000", fg: "#ffffff" };
  }

  if (r === 36 && inMainCols && Number.isFinite(n)) {
    if (n >= 0.5) return { ...style, bg: "#d9ead3" };
    if (n >= 0.45 && n <= 0.5) return { ...style, bg: "#fce5cd" };
    if (n <= 0.45) return { ...style, bg: "#f4cccc" };
  }

  if (r === 44 && inMonthCols && Number.isFinite(n)) {
    if (n > 0.3) return { ...style, bg: "#f4c7c3" };
    if (n >= 0.2 && n <= 0.3) return { ...style, bg: "#d9ead3" };
    if (n < 0.2) return { ...style, bg: "#fce5cd" };
  }

  if (r === 19 && c === 0 && str.includes("Hide")) {
    return { ...style, bg: "#fff2cc" };
  }

  return style;
}

export function getClientCellPresentation({ tabName, r, c, rawValue, displayValue, grid, rawGrid, dynamicLists }) {
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

  const base = {
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
  if (tabName === "Confirmed") return applyConfirmedCf(base, { r, c, rawValue, displayValue, grid, rawGrid });
  if (tabName === "Pipeline") return applyPipelineCf(base, { r, c, rawValue, displayValue, grid, rawGrid });
  if (tabName === "NBtoFind") return applyNbToFindCf(base, { r, c, rawValue, displayValue });
  if (tabName === "Outgoings") return applyOutgoingsCf(base, { r, c, rawValue, displayValue });
  if (tabName === "Salaries") return applySalariesCf(base, { r, c, rawValue, displayValue });
  if (tabName === "Budget") return applyBudgetCf(base, { r, c, rawValue, displayValue });
  return base;
}

export function formatCellForClientSheet(rawValue, displayValue, numberFormat) {
  return formatCellFromTemplateNf(rawValue, displayValue, numberFormat);
}
