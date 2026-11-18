import templateData from "./reconSheetTemplateStyles.json";
import { colIndexToLetter, letterToColIndex } from "./masterComparisonSheetSpec.js";
import {
  createRowTemplateDecoder,
  getSheetNum,
  isSheetNonBlank,
  formatCellFromTemplateNf,
  formatReconYYMMMonthLabel,
} from "./sheetTemplateUtils.js";

export { colIndexToLetter, letterToColIndex, formatReconYYMMMonthLabel };

const RECON_BOOKMARKS = [
  { label: "Bank statement", col: 0 },
  { label: "Category summary", col: 20 },
  { label: "Revenue match", col: 25 },
  { label: "Invoices paid", col: 34 },
  { label: "Contractors match", col: 45 },
  { label: "Contractors paid", col: 54 },
  { label: "Recon statement", col: 81 },
  { label: "Month ready", col: 95 },
  { label: "P&L adds", col: 103 },
  { label: "P&L detail", col: 113 },
];

const RECON_BALANCE_CHECK_ROWS = new Set([22, 25, 28, 30, 32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62]);

const getDecodedRowTemplate = createRowTemplateDecoder(templateData.rowTemplates);

const BASE_RECON_SPEC = (() => {
  const raw = templateData.template || {};
  return {
    ...raw,
    hiddenCols: new Set(raw.hiddenCols || []),
    hiddenRows: new Set(raw.hiddenRows || []),
    bookmarks: RECON_BOOKMARKS,
  };
})();

export function getReconTabSpec(tabName) {
  const monthLabel = formatReconYYMMMonthLabel(tabName);
  return {
    ...BASE_RECON_SPEC,
    tabName,
    title: monthLabel ? `Bank reconciliation (${tabName} · ${monthLabel})` : `Bank reconciliation (${tabName})`,
  };
}

export function sortReconMonthTabsDescending(availableReconTabs = []) {
  const names = (Array.isArray(availableReconTabs) ? availableReconTabs : [])
    .map((t) => String(typeof t === "string" ? t : t?.tab_name || "").trim())
    .filter(Boolean);

  const monthTabs = [...new Set(names.filter((n) => /^\d{4}$/.test(n)))].sort((a, b) =>
    Number(b) - Number(a)
  );
  if (monthTabs.length > 0) return monthTabs;
  if (names.includes("Template")) return ["Template"];
  return names;
}

function applyReconConditionalFormatting(style, { r, c, rawValue, displayValue }) {
  const str = String(displayValue ?? rawValue ?? "");

  // CF[0/1]: AF5:AF100 (col 31) and AZ5:AZ100 (col 51)
  if (r >= 4 && r <= 99 && (c === 31 || c === 51)) {
    if (str.includes("No match")) {
      return { ...style, bg: "#ead1dc" };
    }
    return { ...style, bold: true };
  }

  // CF[2/3]: AQ5:AQ100 (col 42) and BK5:BK100 (col 62)
  if (r >= 4 && r <= 99 && (c === 42 || c === 62)) {
    let next = style;
    if (str.includes("No")) {
      next = { ...next, bg: "#ead1dc" };
    }
    if (str.includes("Matched")) {
      next = { ...next, bold: true };
    }
    return next;
  }

  // CF[4]: Col X (23) balance difference rows outside [-0.05, 0.05] -> #f4cccc
  if (c === 23 && RECON_BALANCE_CHECK_ROWS.has(r) && isSheetNonBlank(rawValue, displayValue)) {
    const n = getSheetNum(rawValue, displayValue);
    if (Number.isFinite(n) && (n < -0.05 || n > 0.05)) {
      return { ...style, bg: "#f4cccc" };
    }
  }

  return style;
}

export function getReconCellPresentation({ r, c, rawValue, displayValue, dynamicLists }) {
  let rawStyle = null;
  let tplId = BASE_RECON_SPEC.rowMap?.[String(r)];
  if (tplId === undefined && r >= 100 && BASE_RECON_SPEC.defaultDataRowTemplateId !== null) {
    tplId = BASE_RECON_SPEC.defaultDataRowTemplateId;
  }
  if (tplId !== undefined && tplId !== null) {
    const rowMap = getDecodedRowTemplate(tplId);
    const styleId = rowMap?.get(c);
    if (styleId !== undefined) {
      rawStyle = templateData.palette?.[styleId] || null;
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

  return applyReconConditionalFormatting(base, { r, c, rawValue, displayValue });
}

export function formatCellForReconSheet(rawValue, displayValue, numberFormat) {
  return formatCellFromTemplateNf(rawValue, displayValue, numberFormat);
}
