import { getSheetsClient, withRetry } from "./sheetsClient";

const MONTH_NAMES = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

export function parseMonthHeader(label) {
  if (!label || typeof label !== "string") return null;
  const match = label.trim().match(/^([A-Za-z]{3})\s*'?(\d{2,4})$/);
  if (!match) return null;
  const mStr = match[1].toLowerCase();
  const month = MONTH_NAMES[mStr];
  if (month === undefined) return null;
  let year = parseInt(match[2], 10);
  if (year < 100) year += 2000;
  return { month, year, label: `${match[1]} ${String(year).slice(-2)}` };
}

function colorToCss(rgbColor) {
  if (!rgbColor) return null;
  const r = Math.round((rgbColor.red ?? 0) * 255);
  const g = Math.round((rgbColor.green ?? 0) * 255);
  const b = Math.round((rgbColor.blue ?? 0) * 255);
  if (r === 255 && g === 255 && b === 255) return null; // Default pure white is treated as transparent/inherited
  const a = rgbColor.alpha !== undefined ? rgbColor.alpha : 1;
  return a < 1 ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`;
}

function borderToCss(border) {
  if (!border || !border.style || border.style === "NONE") return null;
  const col = colorToCss(border.color) || "#d0d0d0";
  switch (border.style) {
    case "DOUBLE": return `3px double ${col}`;
    case "SOLID_THICK": return `2px solid ${col}`;
    case "SOLID_MEDIUM": return `2px solid ${col}`;
    case "DASHED": return `1px dashed ${col}`;
    case "SOLID":
    default: return `1px solid ${col}`;
  }
}

export function parseCell(cell) {
  if (!cell) return null;
  const val = cell.formattedValue ?? "";
  const fmt = cell.effectiveFormat || {};
  const bg = colorToCss(fmt.backgroundColor);
  const tf = fmt.textFormat || {};
  const fg = colorToCss(tf.foregroundColor);
  const align = fmt.horizontalAlignment ? fmt.horizontalAlignment.toLowerCase() : null;
  
  const borders = fmt.borders || {};
  const bt = borderToCss(borders.top);
  const bb = borderToCss(borders.bottom);
  const bl = borderToCss(borders.left);
  const br = borderToCss(borders.right);

  const res = {};
  if (val !== "") res.v = val;
  if (bg) res.bg = bg;
  if (fg) res.c = fg;
  if (tf.bold) res.b = true;
  if (tf.italic) res.i = true;
  if (align && align !== "left") res.a = align;
  if (bt) res.bt = bt;
  if (bb) res.bb = bb;
  if (bl) res.bl = bl;
  if (br) res.br = br;

  return Object.keys(res).length > 0 ? res : null;
}

const FIELDS = "sheets(properties.title,data.rowData.values(formattedValue,effectiveFormat(backgroundColor,textFormat(bold,italic,foregroundColor),horizontalAlignment,borders)))";

export async function getClientViewData({ clientSheetId, tab }) {
  if (!clientSheetId) {
    throw new Error("Missing clientSheetId");
  }

  const sheets = await getSheetsClient();
  const now = new Date();
  const curMonth = now.getMonth();
  const curYear = now.getFullYear();

  if (tab === "dashboard") {
    const res = await withRetry(() => sheets.spreadsheets.get({
      spreadsheetId: clientSheetId,
      ranges: ["Dashboard!A1:AX54"],
      fields: FIELDS,
    }));

    const rowData = res.data.sheets[0]?.data[0]?.rowData || [];
    const matrix = rowData.map(r => (r.values || []).map(parseCell));
    const row0 = (rowData[0]?.values || []).map(c => c?.formattedValue || "");

    const fyConfigs = [
      { label: row0[19] || "FY1", totalCol: 19, monthCols: Array.from({ length: 12 }, (_, i) => 6 + i) },
      { label: row0[34] || "FY2", totalCol: 34, monthCols: Array.from({ length: 12 }, (_, i) => 21 + i) },
      { label: row0[49] || "FY3", totalCol: 49, monthCols: Array.from({ length: 12 }, (_, i) => 36 + i) },
    ];

    let defaultFyIndex = 0;
    fyConfigs.forEach((fy, idx) => {
      fy.months = fy.monthCols.map(colIdx => {
        const label = row0[colIdx];
        const parsed = parseMonthHeader(label);
        if (parsed && parsed.year === curYear && parsed.month === curMonth) {
          defaultFyIndex = idx;
        }
        return { colIdx, label, parsed };
      });
    });

    return {
      success: true,
      tab: "dashboard",
      fyConfigs,
      defaultFyIndex,
      matrix, // row 0: month headers, row 1: status headers, row 2..53: data
    };
  }

  if (tab === "cash") {
    const res = await withRetry(() => sheets.spreadsheets.get({
      spreadsheetId: clientSheetId,
      ranges: ["Cash!A1:AK76"],
      fields: FIELDS,
    }));

    const rowData = res.data.sheets[0]?.data[0]?.rowData || [];
    const matrix = rowData.map(r => (r.values || []).map(parseCell));
    const row0 = (rowData[0]?.values || []).map(c => c?.formattedValue || "");

    let prevMonth = curMonth - 1;
    let prevYear = curYear;
    if (prevMonth < 0) {
      prevMonth = 11;
      prevYear -= 1;
    }

    let prevMonthColIdx = 1;
    const monthCols = [];
    for (let c = 1; c < row0.length; c++) {
      const label = row0[c];
      const parsed = parseMonthHeader(label);
      if (parsed) {
        if (parsed.year === prevYear && parsed.month === prevMonth) {
          prevMonthColIdx = c;
        }
        monthCols.push({ colIdx: c, label, parsed });
      }
    }

    return {
      success: true,
      tab: "cash",
      monthCols,
      prevMonthColIdx,
      matrix, // row 0: headers, row 1..75: cash data
    };
  }

  if (tab === "contractors" || tab === "outgoings") {
    const res = await withRetry(() => sheets.spreadsheets.get({
      spreadsheetId: clientSheetId,
      ranges: ["Outgoings!A1:AX238"],
      fields: FIELDS,
    }));

    const rowData = res.data.sheets[0]?.data[0]?.rowData || [];
    const matrix = rowData.map(r => (r.values || []).map(parseCell));
    const row0 = (rowData[0]?.values || []).map(c => c?.formattedValue || "");

    const fyConfigs = [
      { label: row0[19] || "FY1", totalCol: 19, monthCols: Array.from({ length: 12 }, (_, i) => 6 + i) },
      { label: row0[34] || "FY2", totalCol: 34, monthCols: Array.from({ length: 12 }, (_, i) => 21 + i) },
      { label: row0[49] || "FY3", totalCol: 49, monthCols: Array.from({ length: 12 }, (_, i) => 36 + i) },
    ];

    let defaultFyIndex = 0;
    fyConfigs.forEach((fy, idx) => {
      fy.months = fy.monthCols.map(colIdx => {
        const label = row0[colIdx];
        const parsed = parseMonthHeader(label);
        if (parsed && parsed.year === curYear && parsed.month === curMonth) {
          defaultFyIndex = idx;
        }
        return { colIdx, label, parsed };
      });
    });

    if (tab === "contractors") {
      return {
        success: true,
        tab: "contractors",
        fyConfigs,
        defaultFyIndex,
        headerRow: matrix[0] || [],
        mainRows: matrix.slice(12, 114), // rows 13 to 114
        section1Rows: matrix.slice(117, 123), // rows 118 to 123
        section2Rows: matrix.slice(230, 237), // rows 231 to 237
      };
    } else {
      return {
        success: true,
        tab: "outgoings",
        fyConfigs,
        defaultFyIndex,
        headerRow: matrix[0] || [],
        mainRows: matrix.slice(125, 228), // rows 126 to 228
      };
    }
  }

  throw new Error(`Unsupported tab: ${tab}`);
}
