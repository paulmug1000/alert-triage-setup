import { formatCellFromTemplateNf } from "./sheetTemplateUtils.js";

const TIME_COMP_WIDTHS = (() => {
  const widths = new Array(471).fill(66);
  widths[0] = 206;
  widths[1] = 62;
  widths[2] = 62;
  widths[3] = 62;
  for (let c = 4; c <= 10; c++) widths[c] = 77;
  widths[11] = 27;
  return widths;
})();

export const TIME_COMP_SPEC = {
  tabName: "TimeComp",
  title: "Time & utilisation comparison (TimeComp)",
  totalCols: 471,
  primaryEndCol: 462,
  frozenRows: 8,
  frozenCols: 4,
  tabColor: "#0000ff",
  hiddenCols: new Set([5, 6, 7, 8, 9]),
  hiddenRows: new Set(),
  widths: TIME_COMP_WIDTHS,
  rowHeights: {
    3: 27,
    5: 25,
    10: 10,
  },
  bookmarks: [
    { label: "Controls & staff", col: 0 },
    { label: "Month 1", col: 12 },
    { label: "Month 13 (FY2)", col: 168 },
    { label: "Month 25 (FY3)", col: 324 },
  ],
};

function isBoolTrue(rawValue, displayValue) {
  if (rawValue === true || displayValue === true) return true;
  return (
    String(rawValue ?? "").trim().toUpperCase() === "TRUE" ||
    String(displayValue ?? "").trim().toUpperCase() === "TRUE"
  );
}

function isBoolFalse(rawValue, displayValue) {
  if (rawValue === false || displayValue === false) return true;
  return (
    String(rawValue ?? "").trim().toUpperCase() === "FALSE" ||
    String(displayValue ?? "").trim().toUpperCase() === "FALSE"
  );
}

export function getTimeCompCellPresentation({ r, c, rawValue, displayValue }) {
  const base = {
    bg: "#ffffff",
    fg: "#000000",
    fontSize: 10,
    bold: false,
    italic: false,
    align: "left",
    valign: "bottom",
    wrap: false,
    wrapStrategy: "OVERFLOW_CELL",
    nf: "GENERAL",
    checkbox: false,
    dv: null,
    borders: null,
  };

  if (r === 0) {
    if (c === 4) {
      return { ...base, bg: "#0000ff", fg: "#ffffff", fontSize: 9, bold: true, align: "center" };
    }
    if (c === 10) {
      return { ...base, fontSize: 9, italic: true, align: "center" };
    }
    return base;
  }

  if (r === 1) {
    if (c === 4) {
      let bg = "#ffffff";
      if (isBoolTrue(rawValue, displayValue)) bg = "#00ff00";
      else if (isBoolFalse(rawValue, displayValue)) bg = "#ff0000";
      return { ...base, bg, fontSize: 9, align: "center", checkbox: true };
    }
    if (c === 10) {
      return { ...base, bg: "#d9ead3", fontSize: 9, align: "center", nf: "DATE_TIME:ddd d-mmm hh:mm" };
    }
    return base;
  }

  if (r === 3) {
    const isMonthStart = c >= 12 && (c - 12) % 13 === 0;
    return {
      ...base,
      bg: "#45818e",
      fg: isMonthStart ? "#ffffff" : "#000000",
      fontSize: 12,
      bold: isMonthStart,
      align: isMonthStart ? "right" : "left",
      valign: "middle",
      nf: c >= 1 ? 'DATE:mmm" "yy' : "GENERAL",
    };
  }

  if (r === 4) {
    if (c >= 12 && (c - 12) % 13 === 1) {
      return { ...base, italic: true, fontSize: 10, align: "right", nf: "NUMBER:#,##0" };
    }
    return base;
  }

  if (r === 5) {
    return {
      ...base,
      bg: "#d0e0e3",
      fg: "#000000",
      fontSize: 11,
      bold: c === 0,
      align: "left",
      valign: "middle",
    };
  }

  if (r === 7) {
    const isMonthCol = c >= 12 && (c - 12) % 13 <= 8;
    if (c === 1 || c === 2 || c === 3 || isMonthCol) {
      return {
        ...base,
        bold: true,
        fontSize: 10,
        align: "left",
        valign: "bottom",
        wrap: true,
        wrapStrategy: "WRAP",
      };
    }
    return base;
  }

  if (r === 9) {
    if (c === 0) return { ...base, bold: true, align: "left" };
    if (c === 2) return { ...base, align: "right", nf: "PERCENT:0%" };
    if (c >= 12) {
      const off = (c - 12) % 13;
      if (off >= 0 && off <= 5) return { ...base, align: "right", nf: "NUMBER:#,##0" };
      if (off >= 6 && off <= 8) return { ...base, align: "right", nf: "PERCENT:0%" };
    }
    return base;
  }

  if (r >= 11) {
    if (c === 0) return { ...base, bg: "#efefef", fontSize: 12, align: "left" };
    if (c === 1) return { ...base, bg: "#efefef", fontSize: 12, align: "right", nf: "NUMBER:0.0" };
    if (c === 2) return { ...base, bg: "#efefef", fontSize: 12, align: "right", nf: "PERCENT:0%" };
    if (c === 3) return { ...base, bg: "#efefef", fontSize: 12, align: "left" };
    if (c >= 12) {
      const off = (c - 12) % 13;
      if (off === 0 || off === 1 || off === 3) {
        return { ...base, bg: "#efefef", fontSize: 12, align: "right", nf: "NUMBER:#,##0" };
      }
      if (off === 2 || off === 4 || off === 5) {
        return { ...base, bg: "#ffffff", fontSize: 10, align: "right", nf: "NUMBER:#,##0" };
      }
      if (off >= 6 && off <= 8) {
        return { ...base, bg: "#ffffff", fontSize: 10, align: "right", nf: "PERCENT:0%" };
      }
    }
  }

  return base;
}

export function formatCellForTimeComp(rawValue, displayValue, numberFormat) {
  return formatCellFromTemplateNf(rawValue, displayValue, numberFormat);
}
