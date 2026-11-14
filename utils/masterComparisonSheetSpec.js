/**
 * Exact layout, styling, column width, hidden column, validation, number format,
 * and conditional formatting specifications extracted verbatim from the Google Sheets
 * Master Template (`InvComp`, `DirComp`, `CRMComp`).
 */

export function colIndexToLetter(index) {
  let n = Number(index);
  if (!Number.isFinite(n) || n < 0) return "";
  let s = "";
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

export function letterToColIndex(letter) {
  const clean = String(letter || "").trim().toUpperCase();
  if (!clean) return -1;
  let result = 0;
  for (let i = 0; i < clean.length; i++) {
    result = result * 26 + (clean.charCodeAt(i) - 64);
  }
  return result - 1;
}

function expandRanges(specs) {
  const set = new Set();
  for (const item of specs) {
    if (Array.isArray(item)) {
      const start = typeof item[0] === "string" ? letterToColIndex(item[0]) : item[0];
      const end = typeof item[1] === "string" ? letterToColIndex(item[1]) : item[1];
      for (let c = start; c <= end; c++) set.add(c);
    } else if (typeof item === "string") {
      set.add(letterToColIndex(item));
    } else if (typeof item === "number") {
      set.add(item);
    }
  }
  return set;
}

function buildWidthMap(totalCols, entries) {
  const widths = new Array(totalCols).fill(100);
  for (const [spec, px] of entries) {
    if (Array.isArray(spec)) {
      const start = typeof spec[0] === "string" ? letterToColIndex(spec[0]) : spec[0];
      const end = typeof spec[1] === "string" ? letterToColIndex(spec[1]) : spec[1];
      for (let c = start; c <= end; c++) {
        if (c >= 0 && c < totalCols) widths[c] = px;
      }
    } else {
      const c = typeof spec === "string" ? letterToColIndex(spec) : spec;
      if (c >= 0 && c < totalCols) widths[c] = px;
    }
  }
  return widths;
}

function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = String(v ?? "").trim().replace(/,/g, "").replace(/^£/, "");
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function isEqNum(rawValue, displayValue, target) {
  const n1 = toNum(rawValue);
  if (Number.isFinite(n1)) return n1 === target;
  const n2 = toNum(displayValue);
  return Number.isFinite(n2) && n2 === target;
}

function isGreaterThan(rawValue, displayValue, target) {
  const n1 = toNum(rawValue);
  if (Number.isFinite(n1)) return n1 > target;
  const n2 = toNum(displayValue);
  return Number.isFinite(n2) && n2 > target;
}

function isBoolTrue(rawValue, displayValue) {
  if (rawValue === true || displayValue === true) return true;
  const s1 = String(rawValue ?? "").trim().toUpperCase();
  const s2 = String(displayValue ?? "").trim().toUpperCase();
  return s1 === "TRUE" || s2 === "TRUE";
}

function isBoolFalse(rawValue, displayValue) {
  if (rawValue === false || displayValue === false) return true;
  const s1 = String(rawValue ?? "").trim().toUpperCase();
  const s2 = String(displayValue ?? "").trim().toUpperCase();
  return s1 === "FALSE" || s2 === "FALSE";
}

function isNonBlank(rawValue, displayValue) {
  const sRaw = String(rawValue ?? "").trim();
  const sDisp = String(displayValue ?? "").trim();
  return sRaw !== "" || sDisp !== "";
}

function applyStylesToCols(rowMap, entries) {
  for (const [colSpec, style] of entries) {
    const cols = expandRanges([colSpec]);
    for (const c of cols) {
      rowMap[c] = { ...(rowMap[c] || {}), ...style };
    }
  }
}

// ---------------------------------------------------------------------------
// InvComp Specification (147 cols: A..EQ, active A..CE)
// ---------------------------------------------------------------------------
const INVCOMP_HIDDEN = expandRanges([26, [39, 44], 57]);
const INVCOMP_FLAG_COLS = expandRanges([[18, 24], [66, 71]]); // S..Y, BO..BT
const INVCOMP_ACTION_COLS = expandRanges([[32, 37], [77, 80]]); // AG..AL, BZ..CC
const INVCOMP_CHECKBOX_COLS = expandRanges([27, 72]); // AB, BU
const INVCOMP_WIDTHS = buildWidthMap(147, [
  ["A", 196], ["B", 160], [["C", "E"], 76], ["F", 54], [["G", "I"], 92],
  ["J", 67], ["K", 69], ["L", 82], ["M", 55], ["N", 222], [["O", "P"], 69],
  [["Q", "R"], 73], [["S", "Y"], 65], ["Z", 30], ["AB", 62], ["AC", 67],
  ["AD", 270], ["AE", 242], ["AF", 77], [["AG", "AK"], 195], ["AL", 168], ["AM", 338],
  ["AT", 100], ["AU", 201], [["AV", "AX"], 82], ["AY", 81], [["AZ", "BA"], 85],
  ["BB", 66], ["BC", 61], ["BD", 58], ["BE", 30], ["BG", 100], ["BH", 74],
  [["BI", "BL"], 69], ["BM", 73], ["BN", 54], [["BO", "BS"], 76],
  [["BT", "BU"], 48], ["BV", 106], ["BW", 158], ["BX", 201], ["BY", 77],
  [["BZ", "CD"], 205], ["CE", 470], ["DH", 169], ["DI", 158],
]);

const INVCOMP_ROWS_1_TO_5 = (() => {
  const r0 = {};
  applyStylesToCols(r0, [
    ["A", { bg: "#0000ff", fg: "#ffffff", fontSize: 10, align: "right" }],
    ["B", { bg: "#0000ff", fg: "#ffffff", fontSize: 10, align: "left" }],
    ["C", { bg: "#0000ff", fg: "#ffffff", fontSize: 9, italic: true, align: "left" }],
    ["D", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "right" }],
    ["E", { bg: "#0000ff", fg: "#ffffff", fontSize: 9, bold: true, align: "center" }],
    ["L", { bg: "#ffffff", fg: "#000000", fontSize: 8, italic: true, align: "center", wrap: true }],
    ["AT", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "left" }],
    [["AV", "AX"], { fontSize: 9, align: "right", nf: "NUMBER:#,##0.00" }],
    [["DN", "DO"], { fontSize: 9, italic: true, nf: "DATE:d-mmm-yyyy" }],
  ]);

  const r1 = {};
  applyStylesToCols(r1, [
    ["A", { bg: "#ead1dc", fg: "#000000", fontSize: 10, align: "right", dv: ["1", "3", "6", "7", "12", "13", "18", "19", "24", "25", "All"] }],
    ["B", { bg: "#ead1dc", fg: "#000000", fontSize: 10, align: "left", dv: ["Sent date", "Invoice no"] }],
    ["C", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "right", nf: "NUMBER:#,##0" }],
    ["D", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "right", nf: "DATE:d-mmm-yy" }],
    ["E", { bg: "#00ff00", fg: "#000000", fontSize: 19, align: "center", checkbox: true }],
    [["G", "K"], { bg: "#9900ff", fg: "#ffffff", fontSize: 10, align: "left" }],
    ["G", { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "left", colspan: 2 }],
    ["L", { bg: "#ffffff", fg: "#000000", fontSize: 8, italic: true, align: "center", wrap: true, nf: "DATE_TIME:ddd d-mmm hh:mm" }],
    [["N", "O"], { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "left" }],
    ["P", { bg: "#ffffff", fg: "#000000", fontSize: 10, nf: "DATE:d-mmm-yy" }],
    [["Q", "U"], { bg: "#9900ff", fg: "#ffffff", fontSize: 10, align: "center" }],
    ["Q", { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "left" }],
    [["X", "AB"], { bg: "#9900ff", fg: "#ffffff", fontSize: 10, align: "center" }],
    ["X", { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "left" }],
    ["AT", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "left", nf: "DATE:d-mmm-yy" }],
    [["AV", "AX"], { fontSize: 10, align: "right", nf: "NUMBER:#,##0.00" }],
    [["BQ", "BU"], { bg: "#9900ff", fg: "#ffffff", fontSize: 10, align: "center" }],
    ["BQ", { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "left" }],
  ]);

  const r3 = {};
  applyStylesToCols(r3, [
    [["A", "K"], { bg: "#0000ff", fg: "#ffffff", fontSize: 15, bold: true, align: "left" }],
    [["M", "AB"], { bg: "#70ad47", fg: "#000000", fontSize: 10, bold: true, italic: true, align: "left" }],
    ["AB", { bg: "#70ad47", fg: "#ffffff", fontSize: 9, bold: true, italic: true, align: "right" }],
    [["AD", "AF"], { bg: "#741b47", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left" }],
    [["AT", "BE"], { bg: "#70ad47", fg: "#000000", fontSize: 15, bold: true, align: "left" }],
    [["BH", "BU"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left" }],
    [["BW", "BY"], { bg: "#741b47", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left" }],
  ]);

  const r4 = {};
  applyStylesToCols(r4, [
    [["A", "K"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, align: "left", wrap: true }],
    [["C", "E"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, align: "right", wrap: true }],
    [["G", "I"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, align: "right", wrap: true }],
    [["M", "Z"], { bg: "#70ad47", fg: "#000000", fontSize: 10, bold: true, italic: true, align: "left", wrap: true }],
    ["O", { align: "right" }], ["P", { align: "right" }],
    [["Q", "R"], { italic: false }],
    [["S", "Y"], { fontSize: 8, align: "center", wrap: true }],
    ["AB", { bg: "#70ad47", fg: "#000000", fontSize: 9, bold: true, italic: true, align: "center", wrap: true }],
    [["AD", "AF"], { bg: "#741b47", fg: "#ffffff", fontSize: 10, bold: true, align: "left", wrap: true }],
    [["AG", "AL"], { bg: "#ffffff", fg: "#000000", fontSize: 8, bold: true, italic: true, align: "left", wrap: true }],
    [["AT", "BE"], { bg: "#70ad47", fg: "#000000", fontSize: 10, bold: true, align: "left", wrap: true }],
    [["AV", "AX"], { align: "right" }],
    [["BH", "BU"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left", wrap: true }],
    [["BI", "BM"], { align: "right" }],
    [["BJ", "BK"], { italic: false, align: "right" }],
    [["BO", "BS"], { fontSize: 8, align: "center", wrap: true }],
    ["BU", { align: "right" }],
    [["BW", "BY"], { bg: "#741b47", fg: "#ffffff", fontSize: 10, bold: true, align: "left", wrap: true }],
    [["BZ", "CC"], { bg: "#ffffff", fg: "#000000", fontSize: 8, bold: true, italic: true, align: "left", wrap: true }],
  ]);

  return { 0: r0, 1: r1, 2: {}, 3: r3, 4: r4 };
})();

function getInvCompDataCellStyle(r, c) {
  // Base background colors in Row 6+: #efefef on M..AL & BH..CC except AB & BU (#ffffff)
  let bg = "#ffffff";
  if ((c >= 12 && c <= 37 && c !== 27) || (c >= 59 && c <= 80 && c !== 72)) {
    bg = "#efefef";
  }
  const fontSize = ((c >= 12 && c <= 24) || (c >= 59 && c <= 72 && r >= 6) || (c >= 47 && c <= 49 && r >= 6)) ? 9 : 10;

  let align = "left";
  let nf = "GENERAL";
  let checkbox = false;

  if (c === 1) align = "left";
  else if (c >= 2 && c <= 4) { align = r === 5 ? "center" : "right"; nf = "NUMBER:#,##0.00"; }
  else if (c >= 6 && c <= 8) { align = r === 5 ? "center" : "right"; nf = "DATE:d-mmm-yyyy"; }
  else if (c >= 0 && c <= 10) align = r === 5 ? "center" : "left";
  else if (c === 13) { align = r === 5 ? "center" : "left"; }
  else if (c === 14) { align = r === 5 ? "center" : "right"; nf = "NUMBER:#,##0.00"; }
  else if (c === 15 || c === 16) { align = r === 5 ? "center" : "right"; nf = "DATE:d-mmm-yy"; }
  else if (c >= 18 && c <= 24) { align = "center"; }
  else if (c === 27) { align = "center"; checkbox = true; }
  else if (c >= 47 && c <= 49) { align = r === 5 ? "center" : "right"; nf = "NUMBER:#,##0.00"; }
  else if (c === 51 || c === 52) { align = r === 5 ? "center" : "right"; nf = "DATE:d-mmm-yy"; }
  else if (c >= 60 && c <= 62) { align = r === 5 ? "center" : "right"; nf = "NUMBER:#,##0.00"; }
  else if (c === 63 || c === 64) { align = r === 5 ? "center" : "right"; nf = "DATE:d-mmm-yy"; }
  else if (c >= 66 && c <= 70) { align = "center"; }
  else if (c === 72) { align = "center"; checkbox = true; }
  else if (c >= 113 && c <= 115) { align = "right"; nf = "NUMBER:#,##0.00"; }
  else if (c === 117 || c === 118) { nf = "DATE:d-mmm-yyyy"; }

  return { bg, fg: "#000000", fontSize, bold: false, italic: false, align, wrap: false, nf, checkbox };
}

function applyInvCompConditionalFormatting(style, { r, c, rawValue, displayValue, bhCounts }) {
  // CF[0]: [V6:V3005, X6:Y3005, BQ6:BT3006] NUMBER_EQ(1) -> #a4c2f4
  if (r >= 5 && (c === 21 || c === 23 || c === 24 || (c >= 68 && c <= 71)) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#a4c2f4" };
  }
  // CF[1]: [U6:V3006] NUMBER_EQ(1) -> #ffff00
  if (r >= 5 && (c === 20 || c === 21) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#ffff00" };
  }
  // CF[2]: [AG6:AL3037, BZ6:CC3005] NOT_BLANK -> #ffff00
  if (r >= 5 && ((c >= 32 && c <= 37) || (c >= 77 && c <= 80)) && isNonBlank(rawValue, displayValue)) {
    return { ...style, bg: "#ffff00" };
  }
  // CF[3]: [BP6:BP3005] COUNTIF($BH$6:$BH$3005,$BH6)=1 AND BP6=1 -> #ffff00
  if (r >= 5 && c === 67 && isEqNum(rawValue, displayValue, 1)) {
    const bhVal = String(bhCounts?.rowValueMap?.[r] ?? "").trim();
    if (bhVal && bhCounts?.counts?.get(bhVal) === 1) {
      return { ...style, bg: "#ffff00" };
    }
  }
  // CF[4/5]: [E2] TRUE -> #00ff00, FALSE -> #ff0000
  if (r === 1 && c === 4) {
    if (isBoolTrue(rawValue, displayValue)) return { ...style, bg: "#00ff00" };
    if (isBoolFalse(rawValue, displayValue)) return { ...style, bg: "#ff0000" };
  }
  // CF[6]: [S6:S3005, BO6:BO3005] NUMBER_EQ(1) -> #ff9900
  if (r >= 5 && (c === 18 || c === 66) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#ff9900" };
  }
  // CF[7]: [T6:T3005] NUMBER_EQ(1) -> #fce5cd
  if (r >= 5 && c === 19 && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#fce5cd" };
  }
  // CF[8]: [C2] NUMBER_GREATER(0) -> #ffff00
  if (r === 1 && c === 2 && isGreaterThan(rawValue, displayValue, 0)) {
    return { ...style, bg: "#ffff00" };
  }
  return style;
}

// ---------------------------------------------------------------------------
// DirComp Specification (251 cols: A..IQ, active A..GG)
// ---------------------------------------------------------------------------
const DIRCOMP_HIDDEN = expandRanges([
  [11, 21], [34, 38], [49, 53], [56, 108], [121, 143], [155, 163], [173, 177], [180, 187],
]);
const DIRCOMP_FLAG_COLS = expandRanges([[40, 47], [165, 172]]); // AO..AV, FJ..FQ
const DIRCOMP_ACTION_COLS = new Set();
const DIRCOMP_CHECKBOX_COLS = expandRanges([55]); // BD
const DIRCOMP_WIDTHS = buildWidthMap(251, [
  ["A", 122], ["B", 301], ["C", 93], ["D", 98], ["E", 131], ["F", 82], ["G", 190],
  ["H", 78], [["I", "J"], 76], ["K", 83], ["W", 100], ["X", 62], ["Y", 109], ["Z", 103],
  ["AA", 179], [["AB", "AG"], 68], ["AH", 86], ["AN", 23], [["AO", "AW"], 68],
  ["BC", 33], ["BD", 68], ["DF", 380], ["DG", 182], ["DH", 157], ["DI", 168],
  [["DJ", "DL"], 78], [["DM", "DN"], 85], [["DO", "DP"], 56], ["DQ", 92],
  [["EO", "EP"], 100], ["EQ", 73], ["ER", 124], ["ES", 66], ["ET", 85], ["EU", 153],
  ["EV", 58], ["EW", 75], ["EX", 59], ["EY", 63], ["FI", 24], [["FJ", "FQ"], 65],
  ["FW", 24], ["FX", 48],
]);

const DIRCOMP_ROWS_1_TO_5 = (() => {
  const r0 = {};
  applyStylesToCols(r0, [
    ["A", { bg: "#0000ff", fg: "#ffffff", fontSize: 10, align: "right" }],
    [["B", "C"], { bg: "#0000ff", fg: "#ffffff", fontSize: 9, italic: true, align: "right" }],
    ["D", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "left" }],
    ["E", { bg: "#0000ff", fg: "#ffffff", fontSize: 9, bold: true, align: "center" }],
    ["K", { bg: "#ffffff", fg: "#000000", fontSize: 8, italic: true, align: "center", wrap: true }],
    ["G", { align: "center", colspan: 2 }],
  ]);

  const r1 = {};
  applyStylesToCols(r1, [
    ["A", { bg: "#ead1dc", fg: "#000000", fontSize: 10, align: "right", nf: "NUMBER:#,##0", dv: ["1", "3", "6", "7", "12", "13", "18", "19", "24", "25", "All"] }],
    [["B", "C"], { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "right", nf: "NUMBER:#,##0" }],
    ["D", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "left", nf: "DATE:d-mmm-yy" }],
    ["E", { bg: "#00ff00", fg: "#000000", fontSize: 19, align: "center", checkbox: true }],
    [["G", "H"], { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "left" }],
    ["K", { bg: "#ffffff", fg: "#000000", fontSize: 8, italic: true, align: "center", wrap: true, nf: "DATE_TIME:ddd d-mmm hh:mm" }],
    [["AP", "AS"], { bg: "#9900ff", fg: "#000000", fontSize: 12, align: "center" }],
    ["AP", { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "left" }],
    [["AV", "BD"], { bg: "#9900ff", fg: "#000000", fontSize: 12, align: "left" }],
    ["AV", { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "left" }],
  ]);

  const r3 = {};
  applyStylesToCols(r3, [
    [["A", "K"], { bg: "#0000ff", fg: "#ffffff", fontSize: 15, bold: true, align: "left" }],
    [["X", "BD"], { bg: "#70ad47", fg: "#000000", fontSize: 10, bold: true, italic: true, align: "left" }],
    [["AO", "AV"], { align: "center", bold: false, italic: false }],
    [["DG", "DQ"], { bg: "#70ad47", fg: "#000000", fontSize: 15, bold: true, align: "left" }],
    [["EP", "FX"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left" }],
    [["FJ", "FQ"], { fontSize: 8, align: "center", bold: false, italic: false }],
    ["GH", { bg: "#ff00ff", fg: "#000000", fontSize: 10, bold: true, italic: true, align: "left" }],
  ]);

  const r4 = {};
  applyStylesToCols(r4, [
    [["A", "K"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, align: "left", wrap: true }],
    ["C", { align: "right" }], ["I", { align: "right" }], ["J", { align: "right" }],
    [["X", "BD"], { bg: "#70ad47", fg: "#000000", fontSize: 10, bold: true, italic: true, align: "left", wrap: true }],
    [["AB", "AD"], { align: "right" }],
    ["AN", { align: "center" }],
    [["AO", "AV"], { fontSize: 8, align: "center", wrap: true }],
    ["AW", { fontSize: 9, align: "center", wrap: true }],
    ["BD", { align: "center" }],
    [["DG", "DQ"], { bg: "#70ad47", fg: "#000000", fontSize: 10, bold: true, align: "left", wrap: true }],
    ["DJ", { italic: true, align: "right" }], ["DK", { align: "right" }], ["DL", { align: "right" }], ["DM", { align: "right" }],
    [["EP", "FX"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left", wrap: true }],
    ["EQ", { align: "right" }], ["ES", { align: "right" }], ["EW", { align: "right" }],
    ["EX", { align: "right" }], ["EY", { align: "right" }], ["FI", { italic: false, align: "right" }],
    [["FJ", "FQ"], { fontSize: 8, align: "center", wrap: true }],
    ["FW", { italic: false, align: "right" }], ["FX", { align: "center" }],
  ]);

  return { 0: r0, 1: r1, 2: {}, 3: r3, 4: r4 };
})();

function getDirCompDataCellStyle(r, c) {
  let bg = "#ffffff";
  if ((c >= 23 && c <= 48) || (c >= 145 && c <= 172)) {
    bg = "#efefef";
  }
  let align = r >= 6 && c >= 145 && c <= 172 ? "center" : "left";
  let nf = "GENERAL";
  let checkbox = false;

  if (c === 0 || c === 7) { align = "left"; nf = "DATE:d-mmm-yy"; }
  else if (c === 2 || c === 8 || c === 9) { align = r >= 6 ? "right" : "left"; nf = "NUMBER:#,##0.00"; }
  else if (c === 26 || c === 30 || c === 31) { align = r >= 6 ? "right" : "left"; nf = "DATE:d-mmm-yy"; }
  else if (c >= 27 && c <= 29) { align = r >= 6 ? "right" : "left"; nf = "NUMBER:#,##0.00"; }
  else if (c >= 40 && c <= 47) { align = "center"; }
  else if (c === 55) { align = "center"; checkbox = true; }
  else if (c >= 113 && c <= 115) { align = r >= 6 ? "right" : "left"; nf = "NUMBER:#,##0.00"; }
  else if (c === 116 || c === 117) { align = "left"; nf = "DATE:d-mmm-yy"; }
  else if (c === 146 || c === 152) { nf = "DATE:d-mmm-yy"; }
  else if (c === 148 || c === 153 || c === 154) { nf = "NUMBER:0.00"; }
  else if (c >= 165 && c <= 172) { align = "center"; }

  return { bg, fg: "#000000", fontSize: 10, bold: false, italic: false, align, wrap: false, nf, checkbox };
}

function applyDirCompConditionalFormatting(style, { r, c, rawValue, displayValue, grid }) {
  // CF[0/1]: [E2]
  if (r === 1 && c === 4) {
    if (isBoolTrue(rawValue, displayValue)) return { ...style, bg: "#00ff00" };
    if (isBoolFalse(rawValue, displayValue)) return { ...style, bg: "#ff0000" };
  }
  // CF[2]: [AB6:AD1005] =$AP6=1 -> #fff2cc
  if (r >= 5 && c >= 27 && c <= 29) {
    const apCell = grid?.[r]?.[41];
    if (isEqNum(apCell, apCell, 1)) return { ...style, bg: "#fff2cc" };
  }
  // CF[3]: [AO6:AO1006, FJ6:FJ1006] === 1 -> #ff9900
  if (r >= 5 && (c === 40 || c === 165) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#ff9900" };
  }
  // CF[4]: [AT6:AV1006, FO6:FQ1006] === 1 -> #a4c2f4
  if (r >= 5 && ((c >= 45 && c <= 47) || (c >= 170 && c <= 172)) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#a4c2f4" };
  }
  // CF[5]: [AQ6:AQ1006, FL6:FL1006] === 1 -> #ead1dc
  if (r >= 5 && (c === 42 || c === 167) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#ead1dc", fg: "#000000" };
  }
  // CF[6]: [AR6:AS1006, FM6:FN1006] === 1 -> #ffff00
  if (r >= 5 && (c === 43 || c === 44 || c === 168 || c === 169) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#ffff00" };
  }
  // CF[7]: [B2] > 0 -> #ffff00
  if (r === 1 && c === 1 && isGreaterThan(rawValue, displayValue, 0)) {
    return { ...style, bg: "#ffff00" };
  }
  return style;
}

// ---------------------------------------------------------------------------
// CRMComp Specification (267 cols: A..JG, active A..HT)
// ---------------------------------------------------------------------------
const CRMCOMP_HIDDEN = expandRanges([[16, 22], 38, [111, 115], [130, 133]]);
const CRMCOMP_FLAG_COLS = expandRanges([[50, 57], [160, 167]]); // AY..BF, FE..FL
const CRMCOMP_ACTION_COLS = expandRanges([[102, 109], [220, 227]]); // CY..DF, HM..HT
const CRMCOMP_CHECKBOX_COLS = expandRanges([59, 168]); // BH, FM
const CRMCOMP_WIDTHS = buildWidthMap(267, [
  ["A", 174], ["B", 212], [["C", "E"], 73], [["F", "G"], 92], ["H", 88], ["I", 131],
  ["J", 109], [["K", "L"], 114], [["M", "P"], 96], ["X", 132], ["Y", 158], ["Z", 82],
  [["AA", "AB"], 74], [["AC", "AD"], 76], ["AE", 52], ["AF", 93], ["AG", 77],
  [["AH", "AI"], 94], [["AJ", "AK"], 77], ["AL", 88], ["AN", 30], ["AO", 69],
  ["AP", 116], ["AQ", 176], [["AR", "AS"], 79], [["AT", "AU"], 70], ["AV", 44],
  ["AW", 65], ["AX", 34], [["AY", "BF"], 43], ["BG", 23], ["BH", 53], ["BI", 48],
  ["BJ", 158], ["BK", 259], ["BL", 77], [["BM", "BN"], 91], [["BO", "CO"], 12],
  [["CP", "CS"], 77], ["CT", 69], [["CU", "CV"], 77], ["CW", 56], ["CX", 104],
  [["CY", "DF"], 42], ["DG", 369], ["DM", 109], ["DN", 213], ["DO", 75],
  [["DP", "DQ"], 76], [["DR", "DS"], 70], ["DT", 64], ["DU", 65], [["DV", "DW"], 82],
  ["DX", 108], [["DY", "DZ"], 48], ["EE", 205], ["EF", 144], ["EG", 182],
  [["EH", "EJ"], 82], [["EK", "EL"], 73], ["EM", 45], ["EN", 59], [["EO", "EP"], 83],
  ["EQ", 89], ["ER", 41], ["ES", 33], ["ET", 46], ["EU", 74], ["EV", 114],
  ["EW", 192], [["EX", "EY"], 69], [["EZ", "FA"], 73], ["FB", 49], ["FC", 73],
  ["FD", 74], [["FE", "FL"], 51], ["FM", 45], ["FN", 48], ["FO", 158], ["FP", 217],
  ["FQ", 74], [["FR", "FS"], 109], [["FT", "GT"], 25], [["GU", "GV"], 76], ["GW", 43],
  ["GX", 64], ["GY", 158], [["GZ", "HA"], 74], ["HB", 52], ["HC", 80], ["HD", 29],
  [["HE", "HT"], 40],
]);

const CRMCOMP_ROWS_1_TO_5 = (() => {
  const r0 = {};
  applyStylesToCols(r0, [
    [["A", "B"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, align: "right" }],
    ["C", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "right" }],
    ["E", { bg: "#0000ff", fg: "#ffffff", fontSize: 9, bold: true, align: "center" }],
    ["G", { align: "center", colspan: 2 }],
    ["J", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "center" }],
    ["L", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "left" }],
  ]);

  const r1 = {};
  applyStylesToCols(r1, [
    ["A", { bg: "#ead1dc", fg: "#000000", fontSize: 10, align: "right", dv: ["1", "3", "6", "7", "12", "13", "18", "19", "24", "25", "All"] }],
    ["B", { bg: "#ead1dc", fg: "#000000", fontSize: 10, align: "right", dv: ["Confirmed", "Pipeline"] }],
    ["C", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "right", nf: "DATE:d-mmm-yy" }],
    ["E", { bg: "#00ff00", fg: "#000000", fontSize: 19, align: "center", checkbox: true }],
    [["G", "I"], { bg: "#9900ff", fg: "#ffffff", fontSize: 10, align: "left" }],
    ["G", { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "left" }],
    ["J", { bg: "#ffffff", fg: "#000000", fontSize: 9, italic: true, align: "center", wrap: true, nf: "DATE_TIME:ddd d-mmm hh:mm" }],
    ["L", { bg: "#ffffff", fg: "#000000", fontSize: 9, align: "center", nf: "NUMBER:#,##0" }],
    [["X", "Y"], { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "left" }],
    [["AY", "BH"], { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "center" }],
    ["AY", { align: "left" }],
    [["FF", "FM"], { bg: "#9900ff", fg: "#ffffff", fontSize: 13, bold: true, align: "center" }],
    ["FF", { align: "left" }],
  ]);

  const r3 = {};
  applyStylesToCols(r3, [
    [["A", "O"], { bg: "#9fc5e8", fg: "#000000", fontSize: 15, bold: true, align: "left" }],
    [["X", "AL"], { bg: "#0000ff", fg: "#ffffff", fontSize: 15, bold: true, align: "left" }],
    ["AD", { fontSize: 9, bold: true, italic: true, align: "right" }],
    ["AE", { bg: "#d9d9d9", fg: "#000000", fontSize: 9, bold: true, italic: true, align: "right", dv: ["Yes", "No"] }],
    ["AH", { fontSize: 9, bold: true, italic: true, align: "right" }],
    ["AI", { bg: "#d9d9d9", fg: "#000000", fontSize: 9, bold: true, italic: true, align: "right", dv: ["Yes", "No"] }],
    [["AO", "BH"], { bg: "#70ad47", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left" }],
    [["AY", "BF"], { fontSize: 8, align: "center" }],
    [["BJ", "DF"], { bg: "#741b47", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left" }],
    [["CP", "CW"], { bg: "#efefef", fg: "#000000", fontSize: 10, bold: false, italic: false, align: "center", dv: ["Ignore"] }],
    [["DA", "DF"], { fontSize: 8, align: "right", wrap: true }],
    [["DM", "DZ"], { bg: "#b6d7a8", fg: "#000000", fontSize: 15, bold: true, align: "left" }],
    [["EF", "ES"], { bg: "#70ad47", fg: "#ffffff", fontSize: 15, bold: true, align: "left" }],
    [["EU", "FM"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left" }],
    [["FE", "FG"], { fontSize: 8, align: "center" }],
    [["FH", "FL"], { align: "center" }],
    [["FO", "HT"], { bg: "#741b47", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left" }],
    [["GU", "HB"], { bg: "#efefef", fg: "#000000", fontSize: 12, bold: false, italic: false }],
    [["HO", "HT"], { fontSize: 8, align: "right", wrap: true }],
  ]);

  const r4 = {};
  applyStylesToCols(r4, [
    [["A", "O"], { bg: "#9fc5e8", fg: "#000000", fontSize: 10, bold: true, align: "left", wrap: true }],
    [["X", "AL"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, align: "left", wrap: true }],
    [["AO", "BH"], { bg: "#70ad47", fg: "#ffffff", fontSize: 10, bold: true, align: "left", wrap: true }],
    ["AO", { italic: true }], ["AP", { italic: true }], ["AR", { align: "right" }], ["AS", { align: "right" }],
    ["AT", { italic: true }], ["AU", { italic: true }],
    [["AY", "BF"], { fontSize: 8, italic: true, align: "center" }],
    ["BH", { fontSize: 8, italic: true }],
    [["BJ", "DF"], { bg: "#741b47", fg: "#ffffff", fontSize: 10, bold: true, align: "left", wrap: true }],
    ["BO", { bg: "#ffff00" }],
    [["CY", "DF"], { fontSize: 8, italic: true }],
    [["DM", "DZ"], { bg: "#b6d7a8", fg: "#000000", fontSize: 10, bold: true, align: "left", wrap: true }],
    ["DP", { align: "right" }], ["DQ", { align: "right" }], ["DR", { align: "right" }], ["DT", { align: "right" }],
    [["EF", "ES"], { bg: "#70ad47", fg: "#ffffff", fontSize: 10, bold: true, align: "left", wrap: true }],
    ["EI", { align: "right" }], ["EJ", { align: "right" }], ["EK", { align: "right" }], ["EM", { align: "right" }],
    [["EU", "FM"], { bg: "#0000ff", fg: "#ffffff", fontSize: 10, bold: true, italic: true, align: "left", wrap: true }],
    ["EX", { align: "right" }], ["EY", { align: "right" }], ["EZ", { align: "right" }], ["FA", { align: "right" }],
    [["FE", "FL"], { fontSize: 8, align: "center" }],
    ["FM", { align: "right" }],
    [["FO", "HT"], { bg: "#741b47", fg: "#ffffff", fontSize: 10, bold: true, align: "left", wrap: true }],
    ["FT", { bg: "#ffff00" }],
    [["HM", "HT"], { fontSize: 8, italic: true }],
  ]);

  return { 0: r0, 1: r1, 2: {}, 3: r3, 4: r4 };
})();

function getCrmCompDataCellStyle(r, c) {
  let bg = "#ffffff";
  if (
    (c >= 0 && c <= 14) ||
    (c >= 40 && c <= 109) ||
    (c >= 150 && c <= 227 && c !== 168 && c !== 169)
  ) {
    bg = "#efefef";
  }

  let align = "left";
  let nf = "GENERAL";
  let checkbox = false;

  if (c === 3) { align = r >= 6 ? "right" : "left"; nf = "NUMBER:#,##0.00"; }
  else if (c === 4) { align = r === 5 ? "center" : "right"; nf = "NUMBER:0.00"; }
  else if (c === 5 || c === 6 || c === 11) { align = r >= 6 ? "right" : "left"; nf = "DATE:d-mmm-yy"; }
  else if (c === 7) { align = r >= 6 ? "right" : "left"; nf = "PERCENT:0%"; }
  else if (c === 26 || c === 27) { align = "right"; nf = "NUMBER:#,##0.00"; }
  else if (c === 28 || c === 29 || c === 34) { align = "right"; nf = "DATE:d-mmm-yy"; }
  else if (c === 30) { align = "right"; nf = "PERCENT:0.00%"; }
  else if (c === 43 || c === 44) { align = r >= 6 ? "right" : "left"; nf = "NUMBER:#,##0.00"; }
  else if (c === 45 || c === 46) { align = r >= 6 ? "right" : "left"; nf = "DATE:d-mmm-yy"; }
  else if (c === 47) { align = r >= 6 ? "right" : "left"; nf = "PERCENT:0%"; }
  else if (c >= 50 && c <= 57) { align = "center"; }
  else if (c === 59) { align = "center"; checkbox = true; }
  else if (c === 93 || c === 94) { align = "left"; nf = "NUMBER:#,##0.00"; }
  else if (c === 98 || c === 99) { align = "left"; nf = "DATE:d-mmm-yy"; }
  else if (c === 100) { align = r >= 6 ? "right" : "left"; nf = "PERCENT:0%"; }
  else if (c === 119 || c === 120) { align = r === 5 ? "center" : "right"; nf = "CURRENCY:[$£]#,##0.00"; }
  else if (c === 121 || c === 122) { align = r === 5 ? "center" : "right"; nf = "DATE:d-mmm-yyyy"; }
  else if (c === 123) { align = r === 5 ? "center" : "right"; nf = "PERCENT:0%"; }
  else if (c === 125) { align = r === 5 ? "center" : "left"; nf = "DATE:d-mmm-yy"; }
  else if (c === 137 || c === 138) { align = r === 5 ? "center" : "right"; nf = "CURRENCY:[$£]#,##0.00"; }
  else if (c === 139 || c === 140) { align = r === 5 ? "center" : "right"; nf = "DATE:d-mmm-yyyy"; }
  else if (c === 141) { align = r === 5 ? "center" : "right"; nf = "PERCENT:0%"; }
  else if (c === 144) { align = r === 5 ? "center" : "left"; nf = "DATE:d-mmm-yy"; }
  else if (c === 153 || c === 154) { align = r === 5 ? "center" : "right"; nf = "NUMBER:#,##0.00"; }
  else if (c === 155 || c === 156) { align = r === 5 ? "center" : "right"; nf = "DATE:d-mmm-yy"; }
  else if (c === 157) { align = r === 5 ? "center" : "right"; nf = "PERCENT:0%"; }
  else if (c >= 160 && c <= 167) { align = "center"; }
  else if (c === 168) { align = "center"; checkbox = true; }
  else if (c === 173) { nf = "DATE:d-mmm-yy"; }
  else if (c === 202 || c === 203) { nf = "NUMBER:#,##0.00"; }
  else if (c === 207 || c === 208) { nf = "DATE:d-mmm-yy"; }
  else if (c === 209) { nf = "PERCENT:0.00%"; }

  if (r === 5) align = c >= 116 ? "center" : align;

  return { bg, fg: "#000000", fontSize: 10, bold: false, italic: false, align, wrap: false, nf, checkbox };
}

function applyCrmCompConditionalFormatting(style, { r, c, rawValue, displayValue, grid }) {
  // CF[0/1]: [E2] TEXT_EQ(TRUE / FALSE)
  if (r === 1 && c === 4) {
    if (isBoolTrue(rawValue, displayValue)) return { ...style, bg: "#00ff00" };
    if (isBoolFalse(rawValue, displayValue)) return { ...style, bg: "#ff0000" };
  }
  // CF[2]: [FL6:FL2005] =AND($B$2="Confirmed",$FL6=1) -> #ff00ff
  if (r >= 5 && c === 167) {
    const b2 = String(grid?.[1]?.[1] ?? "").trim();
    if (b2 === "Confirmed" && isEqNum(rawValue, displayValue, 1)) {
      return { ...style, bg: "#ff00ff" };
    }
  }
  // CF[3]: [BC6:BC2006, FI6:FI2006] NUMBER_EQ(1) -> #fce5cd
  if (r >= 5 && (c === 54 || c === 164) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#fce5cd" };
  }
  // CF[4]: [BD6:BF2006, FJ6:FK2006] NUMBER_EQ(1) -> #c9daf8
  if (r >= 5 && ((c >= 55 && c <= 57) || c === 165 || c === 166) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#c9daf8" };
  }
  // CF[5]: [AY6:AY2005, FE6:FE2006] NUMBER_EQ(1) -> #ff9900
  if (r >= 5 && (c === 50 || c === 160) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#ff9900" };
  }
  // CF[6]: [AZ3:BB2008, FF3:FH2008] NUMBER_EQ(1) -> #ffff00
  if (r >= 2 && ((c >= 51 && c <= 53) || (c >= 161 && c <= 163)) && isEqNum(rawValue, displayValue, 1)) {
    return { ...style, bg: "#ffff00" };
  }
  // CF[7]: [CY6:DF2008, HM6:HT2005] NOT_BLANK -> #ffff00
  if (r >= 5 && ((c >= 102 && c <= 109) || (c >= 220 && c <= 227)) && isNonBlank(rawValue, displayValue)) {
    return { ...style, bg: "#ffff00" };
  }
  // CF[8]: [AF4:AG4] =AND($AE$4="Yes",$AF$4>0) -> #ff00ff
  if (r === 3 && (c === 31 || c === 32)) {
    const ae4 = String(grid?.[3]?.[30] ?? "").trim();
    if (ae4 === "Yes" && isGreaterThan(grid?.[3]?.[31], grid?.[3]?.[31], 0)) {
      return { ...style, bg: "#ff00ff", fg: "#000000" };
    }
  }
  // CF[9]: [L2] > 0 -> #ffff00
  if (r === 1 && c === 11 && isGreaterThan(rawValue, displayValue, 0)) {
    return { ...style, bg: "#ffff00" };
  }
  return style;
}

// ---------------------------------------------------------------------------
// Unified Spec Registry
// ---------------------------------------------------------------------------
export const COMPARISON_SHEET_SPECS = {
  InvComp: {
    tabName: "InvComp",
    title: "Invoices comparison (InvComp)",
    totalCols: 147,
    primaryEndCol: 82, // CE
    frozenRows: 5,
    tabColor: "#0000ff",
    hiddenCols: INVCOMP_HIDDEN,
    flagCols: INVCOMP_FLAG_COLS,
    actionCols: INVCOMP_ACTION_COLS,
    checkboxCols: INVCOMP_CHECKBOX_COLS,
    widths: INVCOMP_WIDTHS,
    rowHeights: { 0: 20, 1: 42, 2: 20, 3: 35, default: 20 },
    bookmarks: [
      { label: "App", col: 0 },
      { label: "Dashboard compare", col: 12 },
      { label: "Actions required (Dash)", col: 29 },
      { label: "Dashboard", col: 45 },
      { label: "App compare", col: 59 },
      { label: "Actions required (App)", col: 74 },
    ],
  },
  DirComp: {
    tabName: "DirComp",
    title: "Direct costs comparison (DirComp)",
    totalCols: 251,
    primaryEndCol: 189, // GH ("End")
    frozenRows: 5,
    tabColor: "#0000ff",
    hiddenCols: DIRCOMP_HIDDEN,
    flagCols: DIRCOMP_FLAG_COLS,
    actionCols: DIRCOMP_ACTION_COLS,
    checkboxCols: DIRCOMP_CHECKBOX_COLS,
    widths: DIRCOMP_WIDTHS,
    rowHeights: { 0: 20, 1: 39, 2: 20, 3: 35, default: 20 },
    bookmarks: [
      { label: "App", col: 0 },
      { label: "Dashboard compare", col: 23 },
      { label: "Dashboard", col: 110 },
      { label: "App compare", col: 145 },
    ],
  },
  CRMComp: {
    tabName: "CRMComp",
    title: "CRM comparison (CRMComp)",
    totalCols: 267,
    primaryEndCol: 227, // HT
    frozenRows: 5,
    tabColor: "#0000ff",
    hiddenCols: CRMCOMP_HIDDEN,
    flagCols: CRMCOMP_FLAG_COLS,
    actionCols: CRMCOMP_ACTION_COLS,
    checkboxCols: CRMCOMP_CHECKBOX_COLS,
    widths: CRMCOMP_WIDTHS,
    rowHeights: { 0: 20, 1: 46, 2: 20, 3: 35, default: 20 },
    bookmarks: [
      { label: "CRM (all jobs)", col: 0 },
      { label: "CRM (filtered)", col: 23 },
      { label: "Dashboard compare", col: 40 },
      { label: "Actions required", col: 61 },
      { label: "Dashboard (all)", col: 116 },
      { label: "Dashboard (filtered)", col: 135 },
      { label: "CRM compare", col: 150 },
      { label: "Actions required 2", col: 170 },
    ],
  },
};

export function precomputeInvCompBhCounts(grid) {
  const counts = new Map();
  const rowValueMap = {};
  if (!Array.isArray(grid)) return { counts, rowValueMap };
  const limit = Math.min(grid.length, 3005);
  for (let r = 5; r < limit; r++) {
    const val = String(grid[r]?.[59] ?? "").trim();
    rowValueMap[r] = val;
    if (val) counts.set(val, (counts.get(val) || 0) + 1);
  }
  return { counts, rowValueMap };
}

export function getCellPresentation({ tabName, r, c, rawValue, displayValue, grid, bhCounts }) {
  let base;
  if (r >= 0 && r <= 4) {
    const map =
      tabName === "InvComp" ? INVCOMP_ROWS_1_TO_5[r]
        : tabName === "DirComp" ? DIRCOMP_ROWS_1_TO_5[r]
          : CRMCOMP_ROWS_1_TO_5[r];
    base = {
      bg: "#ffffff",
      fg: "#000000",
      fontSize: 10,
      bold: false,
      italic: false,
      align: "left",
      wrap: false,
      nf: "GENERAL",
      checkbox: false,
      ...(map?.[c] || {}),
    };
  } else if (tabName === "InvComp") {
    base = getInvCompDataCellStyle(r, c);
  } else if (tabName === "DirComp") {
    base = getDirCompDataCellStyle(r, c);
  } else {
    base = getCrmCompDataCellStyle(r, c);
  }

  if (tabName === "InvComp") {
    return applyInvCompConditionalFormatting(base, { r, c, rawValue, displayValue, grid, bhCounts });
  }
  if (tabName === "DirComp") {
    return applyDirCompConditionalFormatting(base, { r, c, rawValue, displayValue, grid });
  }
  return applyCrmCompConditionalFormatting(base, { r, c, rawValue, displayValue, grid });
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function excelSerialToUtcDate(serial) {
  if (typeof serial !== "number" || !Number.isFinite(serial) || serial < 1000) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatCellForComparisonSheet(rawValue, displayValue, numberFormat) {
  if (displayValue === null || displayValue === undefined) displayValue = "";
  const dispStr = String(displayValue);
  if (dispStr.startsWith("#")) return dispStr;

  const nf = String(numberFormat || "GENERAL");
  if (typeof rawValue === "boolean" || dispStr.toUpperCase() === "TRUE" || dispStr.toUpperCase() === "FALSE") {
    return dispStr.toUpperCase();
  }

  // If displayValue is already a non-numeric human string (e.g. "14-May-26"), prefer it unless raw is a fresh number
  const isDispNumeric = dispStr !== "" && !Number.isNaN(Number(dispStr.replace(/,/g, "")));
  const num = typeof rawValue === "number" && Number.isFinite(rawValue)
    ? rawValue
    : (isDispNumeric ? Number(dispStr.replace(/,/g, "")) : NaN);

  if (!Number.isFinite(num)) {
    return dispStr;
  }

  if (nf.startsWith("DATE_TIME:")) {
    if (!isDispNumeric && dispStr) return dispStr;
    const d = excelSerialToUtcDate(num);
    if (!d) return dispStr;
    const dayName = SHORT_DAYS[d.getUTCDay()];
    const day = d.getUTCDate();
    const mon = SHORT_MONTHS[d.getUTCMonth()];
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${dayName} ${day}-${mon} ${hh}:${mm}`;
  }

  if (nf.startsWith("DATE:")) {
    if (!isDispNumeric && dispStr) return dispStr;
    const d = excelSerialToUtcDate(num);
    if (!d) return dispStr;
    const day = d.getUTCDate();
    const mon = SHORT_MONTHS[d.getUTCMonth()];
    const yrFull = d.getUTCFullYear();
    const yrShort = String(yrFull).slice(-2);
    return nf.includes("yyyy") ? `${day}-${mon}-${yrFull}` : `${day}-${mon}-${yrShort}`;
  }

  if (nf === "PERCENT:0.00%") {
    if (!isDispNumeric && dispStr.includes("%")) return dispStr;
    return `${(num * 100).toFixed(2)}%`;
  }
  if (nf === "PERCENT:0%") {
    if (!isDispNumeric && dispStr.includes("%")) return dispStr;
    return `${Math.round(num * 100)}%`;
  }

  if (nf === "CURRENCY:[$£]#,##0.00") {
    const sign = num < 0 ? "-" : "";
    return `${sign}£${Math.abs(num).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (nf === "NUMBER:#,##0.00") {
    return num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (nf === "NUMBER:0.00") {
    return num.toFixed(2);
  }
  if (nf === "NUMBER:#,##0") {
    return Math.round(num).toLocaleString("en-GB");
  }

  return dispStr !== "" ? dispStr : String(rawValue);
}

export function isRowDiscrepancy(tabName, rowValues, rowIndex0) {
  if (rowIndex0 < 5 || !Array.isArray(rowValues)) return false;
  const spec = COMPARISON_SHEET_SPECS[tabName];
  if (!spec) return false;
  for (const c of spec.flagCols) {
    if (isEqNum(rowValues[c], rowValues[c], 1)) return true;
  }
  for (const c of spec.checkboxCols) {
    if (isBoolTrue(rowValues[c], rowValues[c])) return true;
  }
  for (const c of spec.actionCols) {
    if (String(rowValues[c] ?? "").trim() !== "") return true;
  }
  return false;
}
