/**
 * Sheet Value & Date/Display Conversion Utilities
 * Version: 1.02 — Parse USER_ENTERED currency/comma-formatted numbers in normalizeCellForStorage & format string currency cells in formatCellForDisplay
 *
 * Bridges Google Sheets' internal UNFORMATTED_VALUE representation (used by
 * master_sheet_grids.values_grid and masterFormulaEngine.js) with:
 *   1. Google Sheets API v4 `FORMATTED_VALUE` (used by Next.js triageEngine, eomTools, proactiveChecks)
 *   2. Google Apps Script `Range.getValues()` / `Range.getValue()` (which returns JS `Date` instances
 *      for date/timestamp cells and raw numbers/booleans/strings for all other cells)
 *   3. Google Apps Script `Range.getDisplayValues()` / `Range.getDisplayValue()` (formatted strings)
 */

import {
  ymdToSerial,
  serialToYMD,
  toSerialOrNull,
} from "./masterFormulaEngine.js";

export { toSerialOrNull };

export function toNumber(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (val === null || val === undefined || val === "") return 0;
  const s = String(val).trim();
  if (!s) return 0;
  const isParen = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()£$€,\s]/g, "");
  if (cleaned.endsWith("%")) {
    const p = parseFloat(cleaned.slice(0, -1));
    return Number.isFinite(p) ? (isParen ? -Math.abs(p) : p) / 100 : 0;
  }
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return 0;
  return isParen ? -Math.abs(n) : n;
}

export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_FULL = [
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

const DATE_HEADER_PATTERNS = new Set([
  "date",
  "sent date",
  "fully paid on",
  "fully paid on date",
  "fully paid date",
  "pay date",
  "due date",
  "date paid",
  "rec date",
  "paid date",
  "start date",
  "end date",
  "project start",
  "project end",
  "date job will start",
  "date job will end",
  "date added to pipeline",
  "date confirmed",
  "date conf",
  "issue date",
  "txn date",
  "created",
  "created at",
  "created date",
  "date created",
  "updated",
  "updated at",
  "updated date",
  "close date",
  "close month",
  "expected close",
  "expected close date",
  "won date",
  "won time",
  "add time",
  "update time",
  "last contact date",
]);

const INV_DASH_DATE_COLS = new Set([6, 7, 21, 22, 36, 37, 53, 54, 66, 67, 82, 83, 97, 98]);
const INV_APP_DATE_COLS = new Set([6, 7, 8, 14, 78, 79, 80]);
const INV_COMP_DATE_COLS = new Set([6, 7, 8, 15, 16, 51, 52, 63, 64]);

const JNL_APP_DATE_COLS = new Set([0, 7, 27, 34, 78, 85]);
const DIR_DASH_DATE_COLS = new Set([6, 7, 30, 31, 54, 55, 85, 102, 103, 110, 111, 122, 123, 138, 139, 155, 156, 210, 211]);
const DIR_COMP_DATE_COLS = new Set([0, 7, 30, 31, 116, 117, 146, 152]);

const CRM_LIST_DATE_COLS = new Set([5, 6, 11, 32, 33, 38, 83, 84, 89, 108, 109, 114, 129, 130, 135]);
const CRM_COMP_DATE_COLS = new Set([
  5, 6, 11, 28, 29, 34, 45, 46, 64, 98, 99,
  121, 122, 125, 140, 141, 144, 155, 156, 173, 207, 208,
]);

const CRM_COMP_PCT_COLS = new Set([7, 30, 47, 100, 123, 142, 157, 209]);
const CRM_LIST_PCT_COLS = new Set([7, 34, 85, 110, 131]);

const CONF_PIPE_CALCS_DATE_COLS = new Set([
  3, 37, 38, 43, 50, 57, 78, 85, 92, 146, 147, 156, 158, 160, 164, 165, 174, 175, 176, 178, 179, 180,
  182, 183, 184, 187, 188, 190, 191, 193, 194, 198, 199, 200, 201, 202, 205, 206, 207, 208, 209,
  212, 213, 214, 215, 216, 218, 219,
]);

const MONTH_ROW0_TABS = new Set([
  "AppData",
  "Outgoings",
  "Dashboard",
  "Performance",
  "Budget",
  "NBtoFind",
  "VAT",
  "Year0Data",
]);

function isExplicitDateHeader_(hRaw) {
  if (!hRaw || typeof hRaw !== "string") return false;
  const h = hRaw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!h) return false;
  if (
    h.includes("days") ||
    h.includes("mismatch") ||
    h.includes("update ") ||
    h.includes("push") ||
    h.includes("ignore") ||
    h.includes("to date") ||
    h.includes("ytd")
  ) {
    return false;
  }
  if (DATE_HEADER_PATTERNS.has(h)) return true;
  if (
    h.endsWith(" date") ||
    h.startsWith("date ") ||
    h.startsWith("created ") ||
    h.startsWith("updated ") ||
    h.endsWith(" time") ||
    h === "timestamp"
  ) {
    return true;
  }
  if (/^(inv|exp|cost)\s*\d+\s*(send|sent|rec|paid|pay|due)?\s*date$/i.test(h)) return true;
  if (/^(inv|exp|cost)\s*\d+\s*(send|sent|paid)$/i.test(h)) return true;
  return false;
}

/**
 * Determines whether a cell at (row0, col0) on `tabName` is a Date/Timestamp cell.
 */
export function isDateCellCoord(sheetRole, tabName, row0, col0, val, fullGrid = null, notesGrid = null) {
  if (val === "" || val === null || val === undefined || typeof val === "boolean") return false;

  if (notesGrid?.__dateCells?.[`${row0}:${col0}`]) return true;

  // Check if value is a number in plausible Google Sheets serial range (1954..2091 -> 20000..70000)
  const isPlausibleSerial = typeof val === "number" && val >= 20000 && val <= 75000;

  if (sheetRole === "recon" || /^\d{4}$/.test(tabName) || tabName === "Template") {
    if (row0 >= 2 && col0 === 1 && isPlausibleSerial) return true;
    if (row0 >= 3 && col0 === 81 && isPlausibleSerial) return true;
    if (tabName === "PLAdds" && row0 === 2 && col0 >= 3 && isPlausibleSerial) return true;
    return false;
  }

  if (tabName === "KeyInfo") {
    if (row0 === 1 && col0 === 1) return true; // B2 FY start date
    if (row0 === 2 && col0 >= 7 && col0 <= 13 && isPlausibleSerial) return true; // H3:N3
    if (row0 >= 32 && row0 <= 43 && (col0 === 21 || col0 === 31) && isPlausibleSerial) return true; // V33:V44, AF33:AF44
    return false;
  }

  if (MONTH_ROW0_TABS.has(tabName)) {
    if (row0 === 0 && col0 >= 6 && isPlausibleSerial) return true;
  }
  if (tabName === "AppData" && (row0 === 42 || row0 === 60 || row0 === 71 || row0 === 86) && col0 >= 6 && isPlausibleSerial) {
    return true;
  }
  if (tabName === "Cash" && row0 === 0 && col0 >= 1 && isPlausibleSerial) return true;
  if (tabName === "PLFromApp" && row0 === 0 && col0 >= 1 && isPlausibleSerial) return true;
  if (tabName === "PLAdds" && row0 === 2 && col0 >= 3 && isPlausibleSerial) return true;
  if (tabName === "TimeComp" && row0 === 3 && col0 >= 1 && isPlausibleSerial) return true;
  if (tabName === "Salaries" && row0 === 0 && col0 >= 2 && isPlausibleSerial) return true;

  if (tabName === "PLComp") {
    if ((row0 === 0 || row0 === 85) && col0 >= 5 && col0 <= 24 && isPlausibleSerial) return true;
    return false;
  }

  if (tabName === "InvAppList") {
    return Boolean(row0 >= 1 && INV_APP_DATE_COLS.has(col0) && isPlausibleSerial);
  }
  if (tabName === "InvDashList") {
    return Boolean(row0 >= 2 && INV_DASH_DATE_COLS.has(col0) && isPlausibleSerial);
  }
  if (tabName === "InvComp") {
    if (row0 === 1 && (col0 === 3 || col0 === 45) && isPlausibleSerial) return true;
    if (row0 >= 5 && INV_COMP_DATE_COLS.has(col0) && isPlausibleSerial) return true;
    return false;
  }

  if (tabName === "JnlAppList") {
    return Boolean(row0 >= 1 && JNL_APP_DATE_COLS.has(col0) && isPlausibleSerial);
  }
  if (tabName === "DirDashList") {
    return Boolean(row0 >= 2 && DIR_DASH_DATE_COLS.has(col0) && isPlausibleSerial);
  }
  if (tabName === "DirComp") {
    if (row0 === 1 && (col0 === 3 || col0 === 10) && isPlausibleSerial) return true;
    if (row0 >= 5 && DIR_COMP_DATE_COLS.has(col0) && isPlausibleSerial) return true;
    return false;
  }

  if (tabName === "CRMList") {
    return Boolean(row0 >= 1 && CRM_LIST_DATE_COLS.has(col0) && isPlausibleSerial);
  }
  if (tabName === "CRMComp") {
    if (row0 === 1 && (col0 === 2 || col0 === 9) && isPlausibleSerial) return true;
    if (row0 >= 5 && CRM_COMP_DATE_COLS.has(col0) && isPlausibleSerial) return true;
    return false;
  }

  if (tabName === "DataChgAlert") {
    if (row0 === 1 && (col0 === 8 || col0 === 13 || col0 === 15 || col0 === 17 || col0 === 25) && isPlausibleSerial) return true;
    if (row0 === 2 && col0 === 25 && isPlausibleSerial) return true;
    if (row0 === 3 && col0 >= 1 && col0 <= 8 && isPlausibleSerial) return true;
    if ((row0 === 34 || row0 === 35) && col0 === 1 && isPlausibleSerial) return true;
    return false;
  }

  if (tabName === "AutoLog" && row0 >= 1 && col0 === 0 && isPlausibleSerial) return true;
  if (tabName === "RevComp" && (row0 === 0 || row0 === 1) && col0 === 2 && isPlausibleSerial) return true;
  if (tabName === "RevFromApp" && row0 >= 1 && col0 === 0 && isPlausibleSerial) return true;

  if (
    (tabName === "ConfCalcs" || tabName === "PipeCalcs" || tabName === "Confirmed" || tabName === "Pipeline") &&
    row0 >= 1 &&
    CONF_PIPE_CALCS_DATE_COLS.has(col0) &&
    isPlausibleSerial
  ) {
    return true;
  }

  if (tabName === "Salaries" && row0 >= 3 && (col0 === 4 || col0 === 5) && isPlausibleSerial) {
    return true;
  }
  if (tabName === "Calcs" && row0 >= 1 && (col0 === 1 || col0 === 2) && isPlausibleSerial) {
    return true;
  }
  if (tabName === "GPbyPL" && (row0 === 0 || row0 === 1) && col0 >= 6 && isPlausibleSerial) {
    return true;
  }
  if (tabName === "Report" && (row0 === 0 || row0 === 230) && col0 === 1 && isPlausibleSerial) {
    return true;
  }
  if (tabName === "DataForReport" && row0 === 14 && col0 === 0 && isPlausibleSerial) {
    return true;
  }

  if (tabName === "DataFromCRM" && row0 >= 1 && isPlausibleSerial) {
    if (fullGrid?.[0]) {
      return isExplicitDateHeader_(fullGrid[0][col0]);
    }
    return col0 === 5 || col0 === 6 || col0 === 11;
  }
  if (tabName === "InvFromApp" && row0 >= 1 && (col0 === 0 || col0 === 5 || col0 === 6 || col0 === 13) && isPlausibleSerial) {
    // Check row 0 header if available
    if (fullGrid?.[0]) {
      return isExplicitDateHeader_(fullGrid[0][col0]);
    }
    return col0 === 0 || col0 === 13;
  }
  if (tabName === "JnlsFromApp" && row0 >= 1 && (col0 === 0 || col0 === 9 || col0 === 14) && isPlausibleSerial) {
    return true;
  }

  // Dynamic header check on header rows (row 0, 1, 4, 5) for Confirmed, Pipeline, InvFromApp, DataFromCRM, InvComp, DirComp, CRMComp, etc.
  if (row0 >= 1 && fullGrid && isPlausibleSerial) {
    if (fullGrid[0] && isExplicitDateHeader_(fullGrid[0][col0])) return true;
    if (row0 >= 2 && fullGrid[1] && isExplicitDateHeader_(fullGrid[1][col0])) return true;
    if (row0 >= 5 && fullGrid[4] && isExplicitDateHeader_(fullGrid[4][col0])) return true;
    if (row0 >= 6 && fullGrid[5] && isExplicitDateHeader_(fullGrid[5][col0])) return true;
  }

  // Row 0 month/date headers on financial/calculation tabs (e.g. Year0PLFromApp, StarterPL, OrinYrCalcs, YrCalcs, MgmtRep)
  if (row0 === 0 && col0 >= 1 && typeof val === "number" && val >= 40000 && val <= 60000) {
    return true;
  }

  return false;
}

/**
 * Checks if a string is an explicit date string (e.g. "25-Jul-2026", "1-Nov-26", "25/07/2026", "2026-07-25").
 */
export function isFormattedDateString(val) {
  if (typeof val !== "string") return false;
  const s = val.trim();
  if (!s || s.length < 5 || s.length > 32) return false;
  if (/^\d{1,2}[-/\s][A-Za-z]{3,9}[-/\s]\d{2,4}(,?\s+\d{1,2}:\d{2}(:\d{2})?)?$/.test(s)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}(,?\s+\d{1,2}:\d{2}(:\d{2})?)?$/.test(s)) return true;
  if (/^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/.test(s)) return true;
  if (/^[A-Za-z]{3}\s+\d{1,2}-[A-Za-z]{3}\s+\d{1,2}:\d{2}$/.test(s)) return true;
  const myMatch = s.match(/^([A-Za-z]{3,9})[-/\s]+(\d{2,4})$/);
  if (myMatch) {
    const mToken = myMatch[1].toLowerCase();
    const isMonth =
      MONTHS_SHORT.some((m) => m.toLowerCase() === mToken) ||
      MONTHS_FULL.some((m) => m.toLowerCase() === mToken);
    if (isMonth) return true;
  }
  return false;
}

/**
 * Converts a Google Sheets serial number (or date string) into a JavaScript `Date` object
 * in local time, matching Google Apps Script's `Range.getValue()` / `Range.getValues()`.
 */
export function serialToDate(val) {
  if (val instanceof Date) return val;
  if (typeof val === "number" && Number.isFinite(val)) {
    const intDays = Math.floor(val);
    const frac = val - intDays;
    const { year, month1, day } = serialToYMD(intDays);
    if (Math.abs(frac) < 1e-7) {
      return new Date(year, month1 - 1, day);
    }
    const totalMs = Math.round(frac * 86400000);
    return new Date(year, month1 - 1, day, 0, 0, 0, totalMs);
  }
  if (typeof val === "string") {
    const s = toSerialOrNull(val);
    if (s !== null) {
      const { year, month1, day } = serialToYMD(s);
      return new Date(year, month1 - 1, day);
    }
    const parsed = new Date(val);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

/**
 * Converts a JavaScript `Date` object into a Google Sheets serial number,
 * preserving fractional time-of-day if hours/minutes/seconds/ms are non-zero.
 */
export function dateToSerial(dt) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return "";
  const daySerial = ymdToSerial(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  const msInDay =
    (dt.getHours() * 3600 + dt.getMinutes() * 60 + dt.getSeconds()) * 1000 +
    dt.getMilliseconds();
  if (msInDay === 0) return daySerial;
  return daySerial + msInDay / 86400000;
}

const CONF_PIPE_CURRENCY_COLS = new Set([32, 33, 41, 48, 55, 74, 76, 83, 90, 106]);

function formatWholeCurrency_(val) {
  const rounded = Math.sign(val) * Math.round(Math.abs(val) + 1e-7);
  if (rounded === 0) return "£0";
  const sign = rounded < 0 ? "-" : "";
  return `${sign}£${Math.abs(rounded).toLocaleString("en-GB")}`;
}

function formatTwoDecCurrency_(val) {
  const rounded = Math.sign(val) * (Math.round(Math.abs(val) * 100 + 1e-7) / 100);
  if (rounded === 0) return "£0.00";
  const sign = rounded < 0 ? "-" : "";
  return `${sign}£${Math.abs(rounded).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Formats an unformatted cell value for display (`FORMATTED_VALUE` / `getDisplayValues()`).
 */
export function formatCellForDisplay(sheetRole, tabName, row0, col0, val, fullGrid = null, notesGrid = null) {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  if (val instanceof Date) {
    const s = dateToSerial(val);
    if (typeof s === "number") {
      return formatSerialForCell_(sheetRole, tabName, row0, col0, s);
    }
    return "";
  }
  if (
    typeof val === "string" &&
    (tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs") &&
    row0 >= 1 &&
    CONF_PIPE_CURRENCY_COLS.has(col0)
  ) {
    const trimmed = val.trim();
    if (/^-?[£$€]?\s*-?\d[\d,]*(\.\d+)?$/.test(trimmed)) {
      const isNeg = trimmed.includes("-");
      const parsedNum = Number(trimmed.replace(/[£$€,\s-]/g, ""));
      if (Number.isFinite(parsedNum)) {
        val = isNeg ? -parsedNum : parsedNum;
      }
    }
  }
  if (typeof val === "number" && Number.isFinite(val)) {
    if (isDateCellCoord(sheetRole, tabName, row0, col0, val, fullGrid, notesGrid)) {
      return formatSerialForCell_(sheetRole, tabName, row0, col0, val);
    }
    // Check percentage columns in CRMComp / CRMList / DataFromCRM / Confirmed / Pipeline / Outgoings / Budget
    if (
      (tabName === "CRMComp" && row0 >= 6 && CRM_COMP_PCT_COLS.has(col0)) ||
      (tabName === "CRMList" && row0 >= 1 && CRM_LIST_PCT_COLS.has(col0)) ||
      (tabName === "DataFromCRM" && row0 >= 1 && col0 === 7)
    ) {
      return `${(val * 100).toFixed(2)}%`;
    }
    if (
      ((tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs") &&
        row0 >= 1 &&
        col0 === 39) ||
      ((tabName === "Outgoings" || tabName === "Budget") && row0 >= 11 && col0 === 4 && val <= 1) ||
      (tabName === "Outgoings" && row0 === 111 && col0 === 0) ||
      (tabName === "Budget" && row0 === 142 && col0 === 0) ||
      (tabName === "NBtoFind" && row0 === 20 && col0 === 0)
    ) {
      return `${Math.round(val * 100)}%`;
    }
    if (
      (tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs") &&
      row0 >= 1 &&
      CONF_PIPE_CURRENCY_COLS.has(col0)
    ) {
      return formatTwoDecCurrency_(val);
    }
    if (tabName === "Salaries") {
      if (row0 >= 3 && row0 <= 368) {
        if (col0 === 2) return formatTwoDecCurrency_(val);
        if (col0 === 3) return val.toFixed(2);
        if (col0 === 6 || col0 === 8 || col0 === 9) return `${Math.round(val * 100)}%`;
      }
      if (col0 >= 11 && row0 >= 3 && row0 <= 368) {
        return formatTwoDecCurrency_(val);
      }
    }
    if (tabName === "NBtoFind" && row0 >= 2 && row0 <= 23 && col0 >= 6) {
      return formatWholeCurrency_(val);
    }
    if (tabName === "AppData") {
      if (row0 >= 41 && row0 <= 56 && col0 === 25) {
        return `${(val * 100).toFixed(2)}%`;
      }
      if ((row0 === 57 || row0 === 58) && col0 === 25) {
        return `${Math.round(val * 100)}%`;
      }
      if ((row0 === 19 || row0 === 27 || row0 === 31 || row0 === 33 || row0 === 78) && col0 >= 6) {
        return `${Math.round(val * 100)}%`;
      }
      if (
        col0 >= 6 &&
        ((row0 >= 2 && row0 <= 33) ||
          (row0 >= 46 && row0 <= 48) ||
          (row0 >= 52 && row0 <= 54) ||
          row0 === 61 ||
          row0 === 62 ||
          row0 === 73 ||
          row0 === 75 ||
          row0 === 77 ||
          row0 === 80 ||
          row0 === 82 ||
          (row0 >= 87 && row0 <= 89))
      ) {
        return formatWholeCurrency_(val);
      }
    }
    if (tabName === "Budget" && col0 >= 6) {
      if (row0 === 36 || row0 === 44) {
        return `${Math.round(val * 100)}%`;
      }
      if (row0 >= 2 && row0 <= 46) {
        return formatWholeCurrency_(val);
      }
    }
    if (tabName === "Cash" && col0 >= 1 && row0 >= 2 && row0 <= 77) {
      if (row0 === 36) {
        return formatTwoDecCurrency_(val);
      }
      return formatWholeCurrency_(val);
    }
    if (tabName === "Outgoings" && col0 >= 6 && row0 >= 5 && row0 <= 295) {
      if (row0 >= 125 && row0 <= 224 && col0 >= 36 && col0 <= 47) {
        return formatTwoDecCurrency_(val);
      }
      return formatWholeCurrency_(val);
    }
    if (!Number.isInteger(val) && String(val).length > 11) {
      return String(Number(val.toPrecision(10)));
    }
    return String(val);
  }
  return String(val);
}

function formatSerialForCell_(sheetRole, tabName, row0, col0, serial) {
  const intDays = Math.floor(serial);
  const frac = serial - intDays;
  const { year, month1, day } = serialToYMD(intDays);
  const mShort = MONTHS_SHORT[month1 - 1] || "Jan";
  const yy = String(year).slice(-2);

  if (Math.abs(frac) >= 1e-5) {
    const totalMins = Math.round(frac * 1440);
    const hh = String(Math.floor(totalMins / 60) % 24).padStart(2, "0");
    const mm = String(totalMins % 60).padStart(2, "0");
    return `${String(day).padStart(2, "0")}-${mShort}-${yy} ${hh}:${mm}`;
  }

  if (
    (tabName === "KeyInfo" && row0 === 1 && col0 === 1) ||
    (tabName === "Salaries" && row0 >= 3 && (col0 === 4 || col0 === 5))
  ) {
    return `${day}-${mShort}-${year}`;
  }

  if (
    (MONTH_ROW0_TABS.has(tabName) && row0 === 0 && col0 >= 6) ||
    (tabName === "AppData" && (row0 === 42 || row0 === 60 || row0 === 71 || row0 === 86) && col0 >= 6) ||
    (tabName === "Cash" && row0 === 0 && col0 >= 1) ||
    (tabName === "Salaries" && row0 === 0 && col0 >= 2) ||
    (tabName === "TimeComp" && row0 === 3 && col0 >= 1)
  ) {
    return `${mShort} ${yy}`;
  }

  return `${day}-${mShort}-${yy}`;
}

/**
 * Formats a 2D slice of `values_grid` into `FORMATTED_VALUE` strings.
 */
export function formatGridForDisplay(
  sheetRole,
  tabName,
  slicedGrid,
  startRow0 = 0,
  startCol0 = 0,
  fullGrid = null,
  notesGrid = null
) {
  if (!Array.isArray(slicedGrid)) return [];
  return slicedGrid.map((row, rOffset) => {
    if (!Array.isArray(row)) return [];
    const absR = startRow0 + rOffset;
    return row.map((cellVal, cOffset) => {
      const absC = startCol0 + cOffset;
      return formatCellForDisplay(sheetRole, tabName, absR, absC, cellVal, fullGrid, notesGrid);
    });
  });
}

/**
 * Converts a cell value written via `setValue` / `setValues` or `values.update`
 * into its canonical `UNFORMATTED_VALUE` representation for storage in `values_grid`.
 */
export function normalizeCellForStorage(
  sheetRole,
  tabName,
  row0,
  col0,
  val,
  valueInputOption = "USER_ENTERED",
  fullGrid = null,
  notesGrid = null,
  isTextFormatted = false
) {
  if (val === null || val === undefined) return "";
  if (val instanceof Date) {
    return dateToSerial(val);
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  if (typeof val === "string") {
    if (valueInputOption === "RAW" || isTextFormatted) return val;
    if (tabName === "DataFromCRM" && col0 === 2 && row0 >= 1) return val;
    const trimmed = val.trim();
    if (!trimmed) return "";
    if (trimmed.toUpperCase() === "TRUE") return true;
    if (trimmed.toUpperCase() === "FALSE") return false;
    // Preserve leading-apostrophe forced text or formulas
    if (val.startsWith("'")) return val.slice(1);
    if (trimmed.startsWith("=")) return trimmed;

    // Check if it's a formatted date string
    if (isFormattedDateString(trimmed)) {
      const s = toSerialOrNull(trimmed);
      if (s !== null) return s;
    }

    // Check if it's a plain number (avoid coercing 0-prefixed codes like "0012" or phone numbers)
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
    // Check if it's a currency-prefixed or comma-grouped number (e.g. "£20080", "£20,080.00", "-£1,200", "20,080")
    if (
      /^-?[£$€]\s*-?(0|[1-9]\d*)(,\d{3})*(\.\d+)?$/.test(trimmed) ||
      /^-?(0|[1-9]\d{0,2})(,\d{3})+(\.\d+)?$/.test(trimmed)
    ) {
      const isNeg = trimmed.includes("-");
      const n = Number(trimmed.replace(/[£$€,\s-]/g, ""));
      if (Number.isFinite(n)) return isNeg ? -n : n;
    }
    // Check if it's a percentage in a percentage column
    if (/^-?\d+(\.\d+)?%$/.test(trimmed)) {
      const n = Number(trimmed.slice(0, -1));
      if (Number.isFinite(n)) return n / 100;
    }
  }
  return val;
}
