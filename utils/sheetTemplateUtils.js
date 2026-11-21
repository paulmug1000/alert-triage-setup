export const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const FULL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const SHORT_MONTHS_MAP = Object.fromEntries(SHORT_MONTHS.map((m, i) => [m.toLowerCase(), i]));

export function createRowTemplateDecoder(rowTemplates) {
  const cache = new Map();
  return function getDecodedRowTemplate(tplId) {
    if (tplId === null || tplId === undefined) return null;
    if (cache.has(tplId)) return cache.get(tplId);
    const runs = rowTemplates?.[tplId];
    if (!Array.isArray(runs)) {
      cache.set(tplId, null);
      return null;
    }
    const map = new Map();
    for (const [startC, endC, styleId] of runs) {
      for (let c = startC; c <= endC; c++) {
        map.set(c, styleId);
      }
    }
    cache.set(tplId, map);
    return map;
  };
}

export function toSheetNum(v) {
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

export function getSheetNum(rawValue, displayValue) {
  const n1 = toSheetNum(rawValue);
  if (Number.isFinite(n1)) return n1;
  return toSheetNum(displayValue);
}

export function isSheetNonBlank(rawValue, displayValue) {
  return String(rawValue ?? "").trim() !== "" || String(displayValue ?? "").trim() !== "";
}

export function excelSerialToUtcDate(serial) {
  if (typeof serial !== "number" || !Number.isFinite(serial) || serial < 1000) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatCellFromTemplateNf(rawValue, displayValue, numberFormat) {
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
    const dd = String(day).padStart(2, "0");
    const mIdx = d.getUTCMonth();
    const mon = SHORT_MONTHS[mIdx];
    const monFull = FULL_MONTHS[mIdx];
    const yrFull = d.getUTCFullYear();
    const yrShort = String(yrFull).slice(-2);
    if (nf.includes('mmm" "yy')) return `${mon} ${yrShort}`;
    if (nf.includes('mmm"-"yy') && !nf.includes("d")) return `${mon}-${yrShort}`;
    if (nf.includes("mmmm")) return `${day} ${monFull} ${yrFull}`;
    if (nf.includes("dd mmm yyyy")) return `${dd} ${mon} ${yrFull}`;
    if (nf.includes("d mmm yyyy")) return `${day} ${mon} ${yrFull}`;
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

  if (nf === "NUMBER:#,##0.00") {
    return num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (nf === "NUMBER:#,##0") {
    return Math.round(num).toLocaleString("en-GB");
  }
  if (nf === "NUMBER:0.00") {
    return num.toFixed(2);
  }
  if (nf === "NUMBER:0.0") {
    return num.toFixed(1);
  }
  if (nf === "NUMBER:0") {
    return String(Math.round(num));
  }

  return dispStr !== "" ? dispStr : String(rawValue);
}

export function formatReconYYMMMonthLabel(tabName) {
  const clean = String(tabName || "").trim();
  if (!/^\d{4}$/.test(clean)) return "";
  const yy = clean.slice(0, 2);
  const mm = parseInt(clean.slice(2, 4), 10);
  if (mm < 1 || mm > 12) return "";
  return `${SHORT_MONTHS[mm - 1]} ${yy}`;
}
