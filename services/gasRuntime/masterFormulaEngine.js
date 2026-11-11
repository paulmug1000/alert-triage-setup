/**
 * Master Sheet Formula Engine (100% Verbatim 1:1 Implementation)
 * Version: 1.05 — Remove hardcoded column and blank-cell shortcuts in evaluateInvAppList and evaluateJnlAppList
 *
 * Evaluates the exact Google Sheets formulas on the Master Sheet tabs:
 *   1. Outgoings (Row 1 dates from KeyInfo!B2 + IMPORTRANGEs A4:AX8, A12:AX114)
 *   2. PLAdds (IMPORTRANGE from Recon!PLAdds!A1:AK200)
 *   3. InvAppList -> InvDashList -> InvComp
 *   4. JnlAppList -> DirDashList -> DirComp
 *   5. CRMList -> CRMComp
 *   6. PLComp
 *   7. KeyInfo & TimeComp formula cells
 */

const MS_PER_DAY = 86400000;
const EPOCH_OFFSET_DAYS = 25569; // Days between 1899-12-30 and 1970-01-01
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = [
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

export function todaySerial() {
  const now = new Date();
  // Use UK date components to match spreadsheet locale (Europe/London)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value || now.getUTCFullYear());
  const m = Number(parts.find((p) => p.type === "month")?.value || now.getUTCMonth() + 1);
  const d = Number(parts.find((p) => p.type === "day")?.value || now.getUTCDate());
  return ymdToSerial(y, m, d);
}

export function ymdToSerial(year, month1, day) {
  const utcMs = Date.UTC(year, month1 - 1, day);
  return Math.round(utcMs / MS_PER_DAY) + EPOCH_OFFSET_DAYS;
}

export function serialToYMD(serial) {
  const days = Math.floor(Number(serial));
  const utcMs = (days - EPOCH_OFFSET_DAYS) * MS_PER_DAY;
  const dt = new Date(utcMs);
  return {
    year: dt.getUTCFullYear(),
    month1: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

export function edateSerial(startVal, monthsOffset) {
  const s = toSerialOrNull(startVal);
  if (s === null) return "";
  const mOff = Math.trunc(Number(monthsOffset) || 0);
  const { year, month1, day } = serialToYMD(s);
  const totalMonths = (year * 12 + (month1 - 1)) + mOff;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth0 = ((totalMonths % 12) + 12) % 12;
  const maxDay = new Date(Date.UTC(targetYear, targetMonth0 + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, maxDay);
  return ymdToSerial(targetYear, targetMonth0 + 1, clampedDay);
}

export function eomonthSerial(startVal, monthsOffset) {
  const s = toSerialOrNull(startVal);
  if (s === null) return "";
  const mOff = Math.trunc(Number(monthsOffset) || 0);
  const { year, month1 } = serialToYMD(s);
  const totalMonths = (year * 12 + (month1 - 1)) + mOff;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth0 = ((totalMonths % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth0 + 1, 0)).getUTCDate();
  return ymdToSerial(targetYear, targetMonth0 + 1, lastDay);
}

export function toSerialOrNull(val) {
  if (val === "" || val === null || val === undefined || typeof val === "boolean") return null;
  if (typeof val === "number" && Number.isFinite(val)) return val;
  const str = String(val).trim();
  if (!str) return null;
  const cleanedNum = str.replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(cleanedNum)) {
    return Number(cleanedNum);
  }
  // Check D-MMM-YY or DD-MMM-YYYY (e.g. "5-Aug-25", "11-Sep-25", "09-Nov-26 07:15", "09-Nov-26, 07:15")
  const dmyMatch = str.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmyMatch) {
    const d = Number(dmyMatch[1]);
    const mToken = dmyMatch[2].toLowerCase();
    let mIdx = MONTHS_SHORT.findIndex((m) => m.toLowerCase() === mToken);
    if (mIdx < 0) {
      mIdx = MONTHS_FULL.findIndex((m) => m.toLowerCase() === mToken);
    }
    let y = Number(dmyMatch[3]);
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    if (mIdx >= 0) {
      const baseSerial = ymdToSerial(y, mIdx + 1, d);
      if (dmyMatch[4] !== undefined) {
        const hh = Number(dmyMatch[4]) || 0;
        const mm = Number(dmyMatch[5]) || 0;
        const ss = Number(dmyMatch[6]) || 0;
        return baseSerial + (hh * 3600 + mm * 60 + ss) / 86400;
      }
      return baseSerial;
    }
  }
  // Check Month-Year strings (e.g. "November 2025", "Nov 2025", "Nov-25", "Nov-2025")
  const myMatch = str.match(/^([A-Za-z]{3,9})[-/\s]+(\d{2,4})$/);
  if (myMatch) {
    const mToken = myMatch[1].toLowerCase();
    let mIdx = MONTHS_SHORT.findIndex((m) => m.toLowerCase() === mToken);
    if (mIdx < 0) {
      mIdx = MONTHS_FULL.findIndex((m) => m.toLowerCase() === mToken);
    }
    if (mIdx >= 0) {
      let y = Number(myMatch[2]);
      if (y < 100) y += y >= 70 ? 1900 : 2000;
      return ymdToSerial(y, mIdx + 1, 1);
    }
  }
  // Check DD/MM/YYYY (UK format, with optional comma before time e.g. "23/03/2022, 00:15")
  const ukSlash = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (ukSlash) {
    const d = Number(ukSlash[1]);
    const m = Number(ukSlash[2]);
    let y = Number(ukSlash[3]);
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    const baseSerial = ymdToSerial(y, m, d);
    if (ukSlash[4] !== undefined) {
      const hh = Number(ukSlash[4]) || 0;
      const mm = Number(ukSlash[5]) || 0;
      const ss = Number(ukSlash[6]) || 0;
      return baseSerial + (hh * 3600 + mm * 60 + ss) / 86400;
    }
    return baseSerial;
  }
  // Check YYYY-MM-DD (with optional time)
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (isoMatch) {
    const baseSerial = ymdToSerial(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
    if (isoMatch[4] !== undefined) {
      const hh = Number(isoMatch[4]) || 0;
      const mm = Number(isoMatch[5]) || 0;
      const ss = Number(isoMatch[6]) || 0;
      return baseSerial + (hh * 3600 + mm * 60 + ss) / 86400;
    }
    return baseSerial;
  }
  const parsed = Date.parse(str);
  if (!Number.isNaN(parsed)) {
    const dt = new Date(parsed);
    if (str.endsWith("Z")) {
      return ymdToSerial(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    return ymdToSerial(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }
  return null;
}

export function formatSerialDMMMYY(serialVal) {
  const s = toSerialOrNull(serialVal);
  if (s === null) return String(serialVal ?? "");
  const { year, month1, day } = serialToYMD(s);
  const yy = String(year).slice(-2);
  return `${day}-${MONTHS_SHORT[month1 - 1]}-${yy}`;
}

export function isBlankCell(v) {
  return v === "" || v === null || v === undefined;
}

export function gsN(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
}

export function toNumOrNull(v) {
  if (isBlankCell(v) || typeof v === "boolean") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(/,/g, "");
  if (!s) return null;
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function toNumOrZero(v) {
  const n = toNumOrNull(v);
  return n === null ? 0 : n;
}

export function gsRound(val, decimals = 2) {
  const n = toNumOrNull(val);
  if (n === null) return "";
  const factor = Math.pow(10, decimals);
  // Google Sheets ROUND uses half-away-from-zero
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * factor)) / factor;
}

/**
 * Google Sheets `=` comparison:
 * - Case-insensitive for strings
 * - Empty string `""` equals `null`/`undefined`/`""`
 * - Numeric comparison if both are numbers
 */
export function gsEq(a, b) {
  const aBlank = isBlankCell(a);
  const bBlank = isBlankCell(b);
  if (aBlank && bBlank) return true;
  if (aBlank || bBlank) return false;
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (typeof a === "boolean" && typeof b === "boolean") return a === b;
    return String(a).toUpperCase() === String(b).toUpperCase();
  }
  if (typeof a === "number" && typeof b === "number") {
    return a === b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  // In Google Sheets, number = string is FALSE unless coerced, EXCEPT in our JSON grid
  // sometimes numbers/booleans were serialized as strings during sheet dumps.
  return false;
}

/**
 * Loose equality for values that might have been serialized as strings in JSON grids
 */
export function gsValEq(a, b) {
  if (gsEq(a, b)) return true;
  const na = toNumOrNull(a);
  const nb = toNumOrNull(b);
  if (na !== null && nb !== null && na === nb) return true;
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

export function gsProper(val) {
  const s = String(val ?? "").toLowerCase();
  return s.replace(/(?:^|[^a-zA-Z])([a-zA-Z])/g, (m, ch) => m.slice(0, -1) + ch.toUpperCase());
}

export function getCell(grid, r0, c0) {
  if (!Array.isArray(grid) || !Array.isArray(grid[r0])) return "";
  const v = grid[r0][c0];
  return v === null || v === undefined ? "" : v;
}

export function setCell(grid, r0, c0, val) {
  while (grid.length <= r0) grid.push([]);
  while (grid[r0].length <= c0) grid[r0].push("");
  grid[r0][c0] = val === null || val === undefined ? "" : val;
}

export function clearRect(grid, startR0, endR0, startC0, endC0) {
  const maxR = Math.min(grid.length - 1, endR0);
  for (let r = startR0; r <= maxR; r++) {
    if (!Array.isArray(grid[r])) continue;
    const maxC = Math.min(grid[r].length - 1, endC0);
    for (let c = startC0; c <= maxC; c++) {
      grid[r][c] = "";
    }
  }
}

export function writeRect(grid, startR0, startC0, rows2D, numCols) {
  for (let i = 0; i < rows2D.length; i++) {
    const r0 = startR0 + i;
    while (grid.length <= r0) grid.push([]);
    const row = rows2D[i] || [];
    const width = numCols != null ? numCols : row.length;
    while (grid[r0].length < startC0 + width) grid[r0].push("");
    for (let j = 0; j < width; j++) {
      const v = row[j];
      grid[r0][startC0 + j] = v === null || v === undefined ? "" : v;
    }
  }
}

export function compactGrid2D(grid) {
  if (!Array.isArray(grid)) return [];
  const rows = [];
  for (let r = 0; r < grid.length; r++) {
    const srcRow = grid[r];
    if (!Array.isArray(srcRow)) {
      rows.push([]);
      continue;
    }
    let lastNonEmpty = -1;
    for (let c = srcRow.length - 1; c >= 0; c--) {
      const v = srcRow[c];
      if (v !== "" && v !== null && v !== undefined) {
        lastNonEmpty = c;
        break;
      }
    }
    if (lastNonEmpty < 0) {
      rows.push([]);
    } else {
      const trimmed = new Array(lastNonEmpty + 1);
      for (let c = 0; c <= lastNonEmpty; c++) {
        const v = srcRow[c];
        trimmed[c] = v === null || v === undefined ? "" : v;
      }
      rows.push(trimmed);
    }
  }
  while (rows.length > 0 && rows[rows.length - 1].length === 0) {
    rows.pop();
  }
  return rows;
}

export function compactGridInPlace(grid) {
  if (!Array.isArray(grid)) return;
  const compacted = compactGrid2D(grid);
  grid.splice(0, grid.length, ...compacted);
}

export function matchInRow0(needle, rowArr, startCol0 = 0, endCol0 = null) {
  if (isBlankCell(needle) || !Array.isArray(rowArr)) return -1;
  const target = String(needle).trim().toLowerCase();
  const maxC = endCol0 != null ? Math.min(rowArr.length - 1, endCol0) : rowArr.length - 1;
  for (let c = startCol0; c <= maxC; c++) {
    const cell = rowArr[c];
    if (!isBlankCell(cell) && String(cell).trim().toLowerCase() === target) {
      return c - startCol0; // 0-based offset within slice
    }
  }
  return -1;
}

/**
 * Google Sheets comparator for SORT(range, sortCol, isAscending)
 * In Google Sheets:
 * - Numbers < Strings < Booleans < Blank ("")
 * - Blank cells ("") ALWAYS sort last in both ascending and descending!
 */
export function gsSortCompare(a, b, isAsc = true) {
  const aBlank = isBlankCell(a);
  const bBlank = isBlankCell(b);
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1; // Blanks always at the bottom in Google Sheets SORT
  if (bBlank) return -1;

  const dir = isAsc ? 1 : -1;
  const na = typeof a === "number" ? a : toSerialOrNull(a);
  const nb = typeof b === "number" ? b : toSerialOrNull(b);
  const aIsNum = typeof a === "number" || (na !== null && /^-?\d+(\.\d+)?$/.test(String(a).trim()));
  const bIsNum = typeof b === "number" || (nb !== null && /^-?\d+(\.\d+)?$/.test(String(b).trim()));

  if (aIsNum && bIsNum) {
    const va = typeof a === "number" ? a : Number(a);
    const vb = typeof b === "number" ? b : Number(b);
    if (va !== vb) return (va < vb ? -1 : 1) * dir;
    return 0;
  }
  if (aIsNum !== bIsNum) {
    return (aIsNum ? -1 : 1) * dir;
  }
  const sa = String(a).toLowerCase();
  const sb = String(b).toLowerCase();
  if (sa !== sb) return (sa < sb ? -1 : 1) * dir;
  return 0;
}

// ============================================================================
// 1. Outgoings & PLAdds IMPORTRANGE + Header Dates
// ============================================================================

export function evaluateOutgoingsMasterTab(grids) {
  const keyInfo = grids.KeyInfo;
  const outgoings = grids.Outgoings;
  if (!Array.isArray(outgoings) || !Array.isArray(keyInfo)) return;

  const fyStart = toSerialOrNull(getCell(keyInfo, 1, 1)); // KeyInfo!B2
  if (fyStart !== null) {
    // G1:R1 (cols 6..17), V1:AG1 (cols 21..32), AK1:AV1 (cols 36..47)
    let curr = fyStart;
    const monthCols = [
      6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
      36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
    ];
    for (let i = 0; i < monthCols.length; i++) {
      const col = monthCols[i];
      if (i > 0) {
        const prevEom = eomonthSerial(curr, 1);
        const { year, month1 } = serialToYMD(prevEom);
        curr = ymdToSerial(year, month1, 1);
      }
      setCell(outgoings, 0, col, curr);
    }
  }
}

// ============================================================================
// 2. InvAppList -> InvDashList -> InvComp
// ============================================================================

export function evaluateInvAppList(grids) {
  const invAppList = grids.InvAppList;
  const invFromApp = grids.InvFromApp;
  const invComp = grids.InvComp;
  const keyInfo = grids.KeyInfo;
  if (!Array.isArray(invAppList) || !Array.isArray(invFromApp)) return;

  const f1Format = String(getCell(invAppList, 0, 5) || "Full").trim(); // F1
  const ca1Excl = String(getCell(invAppList, 0, 78) || "").trim(); // CA1
  const accountingSystem = String(getCell(keyInfo, 3, 16) || "Xero").trim(); // KeyInfo!Q4

  // BX2 = InvComp!B2, BZ2 = MATCH(BX2, BU3:CG3, 0)
  const sortHeader = getCell(invComp, 1, 1) || "Sent date"; // InvComp!B2
  setCell(invAppList, 1, 75, sortHeader); // BX2
  const bu3Headers = (invAppList[2] || []).slice(72, 85); // BU3:CG3 (cols 72..84)
  const bz2Match0 = matchInRow0(sortHeader, bu3Headers);
  const bz2Col1 = bz2Match0 >= 0 ? bz2Match0 + 1 : 7;
  setCell(invAppList, 1, 77, bz2Col1); // BZ2

  const e2On = getCell(invComp, 1, 4);
  const isOff = e2On === false || gsEq(e2On, "FALSE");

  // Clear A4:T5004 (rows 3..5003, cols 0..19) and BU4:CG5004 (cols 72..84)
  const maxExisting = Math.max(invAppList.length - 1, 3);
  clearRect(invAppList, 3, maxExisting, 0, 23);
  clearRect(invAppList, 3, maxExisting, 72, 84);

  if (isOff) return;

  // Map A2, B2, F2, G2, H2, K2..T2 to InvFromApp!1:1
  const appHeaders = invFromApp[0] || [];
  const idxA2 = matchInRow0(getCell(invAppList, 1, 0), appHeaders);  // A2 = ContactName
  const idxB2 = matchInRow0(getCell(invAppList, 1, 1), appHeaders);  // B2 = Reference
  const idxF2 = matchInRow0(getCell(invAppList, 1, 5), appHeaders);  // F2 = InvoiceNumber
  const idxG2 = matchInRow0(getCell(invAppList, 1, 6), appHeaders);  // G2 = Date
  const idxH2 = matchInRow0(getCell(invAppList, 1, 7), appHeaders);  // H2 = DueDate
  const idxK2 = matchInRow0(getCell(invAppList, 1, 10), appHeaders); // K2 = Type
  const idxL2 = matchInRow0(getCell(invAppList, 1, 11), appHeaders); // L2 = CurrencyCode
  const idxM2 = matchInRow0(getCell(invAppList, 1, 12), appHeaders); // M2 = CurrencyRate
  const idxO2 = matchInRow0(getCell(invAppList, 1, 14), appHeaders); // O2 = FullyPaidOnDate
  const idxP2 = matchInRow0(getCell(invAppList, 1, 15), appHeaders); // P2 = Status
  const idxQ2 = matchInRow0(getCell(invAppList, 1, 16), appHeaders); // Q2 = SentToContact
  const idxR2 = matchInRow0(getCell(invAppList, 1, 17), appHeaders); // R2 = Total
  const idxS2 = matchInRow0(getCell(invAppList, 1, 18), appHeaders); // S2 = SubTotal
  const idxT2 = matchInRow0(getCell(invAppList, 1, 19), appHeaders); // T2 = TotalTax

  // Filter InvFromApp!A2:Z5289 (skipping completely blank rows or rows missing client/invoice/type)
  const leftRows = [];
  const buSourceRows = [];
  for (let r = 1; r < invFromApp.length && r < 5289; r++) {
    const srcRow = invFromApp[r];
    if (!Array.isArray(srcRow) || srcRow.every(isBlankCell)) continue;

    const getVal = (idx) => (idx >= 0 ? (srcRow[idx] ?? "") : "");
    const A = getVal(idxA2); // Client
    const B = getVal(idxB2); // Job
    const G = getVal(idxG2); // Sent date
    const H = getVal(idxH2); // Due date
    const K = getVal(idxK2); // Type
    const L = getVal(idxL2); // Currency
    const M = getVal(idxM2); // Currency Rate
    const rawN = r < 4588 ? getVal(idxF2) : ""; // Invoice no (N4)

    // Skip rows where client, invoice no, and type are all blank
    if (isBlankCell(A) && isBlankCell(rawN) && isBlankCell(K)) continue;
    const N = typeof rawN === "number" ? (() => {
      const { year, month1 } = serialToYMD(rawN);
      return `${year}-${month1}`;
    })() : rawN;
    const O = getVal(idxO2); // Fully paid on
    const P = getVal(idxP2); // Status
    const Q = getVal(idxQ2); // Sent?
    const R = getVal(idxR2); // Total in curr
    const S = getVal(idxS2); // Total excl VAT in curr
    const T = getVal(idxT2); // VAT amount in curr

    const rate = isBlankCell(M) ? 1 : (toNumOrNull(M) || 1);
    const C = isBlankCell(R) ? "" : gsRound(toNumOrZero(R) / rate, 2);
    const D = isBlankCell(S) ? "" : gsRound(toNumOrZero(S) / rate, 2);
    const E = isBlankCell(T) ? "" : gsRound(toNumOrZero(T) / rate, 2);

    let F = "";
    if (!isBlankCell(N)) {
      const nText = String(N);
      if (gsEq(f1Format, "Full")) {
        F = nText;
      } else if (gsEq(f1Format, "StripPre")) {
        F = nText.replace(/^[^-]+-/, "");
      } else if (gsEq(f1Format, "Right4")) {
        const m = nText.match(/[a-zA-Z]*(\d+)[a-zA-Z]*/);
        F = m ? m[1].slice(-4) : "";
      } else if (gsEq(f1Format, "Right5")) {
        F = nText.slice(-5);
      } else {
        const m = nText.match(/[a-zA-Z]*(\d+)[a-zA-Z]*/);
        F = m ? m[1].slice(-3) : "";
      }
    }

    let I = "";
    if (!isBlankCell(O)) {
      if (gsEq(accountingSystem, "Xero")) {
        const oStr = String(O);
        const mid10 = oStr.slice(6, 16);
        const numMid = Number(mid10);
        I = Number.isFinite(numMid) && mid10.trim() !== "" ? numMid / 86400 + EPOCH_OFFSET_DAYS : "";
      } else {
        I = O;
      }
    }

    let J = "";
    if (!isBlankCell(P)) {
      const pStr = String(P);
      const qBool = Q === true || gsEq(Q, "TRUE");
      const qFalse = Q === false || gsEq(Q, "FALSE");
      if (gsEq(accountingSystem, "Xero")) {
        if (gsEq(pStr, "Paid")) {
          J = "Paid";
        } else if (
          (gsEq(pStr, "AUTHORISED") || gsEq(pStr, "AWAITING_PAYMENT") || gsEq(pStr, "OVERDUE")) &&
          qBool
        ) {
          J = "Sent";
        } else if (gsEq(pStr, "AUTHORISED")) {
          J = "Draft";
        } else {
          J = gsProper(pStr);
        }
      } else {
        if (gsEq(pStr, "Paid")) {
          J = "Paid";
        } else if (
          (gsEq(pStr, "AWAITING_PAYMENT") || gsEq(pStr, "OVERDUE") || gsEq(pStr, "AUTHORISED")) &&
          qFalse
        ) {
          J = qBool ? "Sent" : "Draft";
        } else {
          J = "Sent";
        }
      }
    }

    const row20 = [A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T];
    leftRows.push(row20);

    // Filter for BU4:CG: K <> "" and (CA1 <> "Yes" or (J <> "DELETED" and J <> "VOIDED"))
    const keepForBU = !isBlankCell(K) && (!gsEq(ca1Excl, "Yes") || (!gsEq(J, "DELETED") && !gsEq(J, "VOIDED")));
    if (keepForBU) {
      buSourceRows.push(row20.slice(0, 13)); // A..M (13 cols)
    }
  }

  writeRect(invAppList, 3, 0, leftRows, 20);

  // SORT(finalData, $BZ$2, TRUE, 7, TRUE)
  const sortIdx0 = Math.max(0, bz2Col1 - 1);
  buSourceRows.sort((rA, rB) => {
    const cmp1 = gsSortCompare(rA[sortIdx0], rB[sortIdx0], true);
    if (cmp1 !== 0) return cmp1;
    return gsSortCompare(rA[6], rB[6], true); // col 7 (index 6) = Sent date
  });

  writeRect(invAppList, 3, 72, buSourceRows, 13);
  compactGridInPlace(invAppList);
}

export function evaluateInvDashList(grids) {
  const invDashList = grids.InvDashList;
  const confCalcs = grids.ConfCalcs;
  const invComp = grids.InvComp;
  if (!Array.isArray(invDashList) || !Array.isArray(confCalcs)) return;

  // CB1 = InvComp!B2, CD1 = MATCH(CB1, BY2:CL2, 0)
  const sortHeader = getCell(invComp, 1, 1) || "Sent date";
  setCell(invDashList, 0, 79, sortHeader); // CB1
  const by2Headers = (invDashList[1] || []).slice(76, 90); // BY2:CL2 (cols 76..89)
  const cd1Match0 = matchInRow0(sortHeader, by2Headers);
  const cd1Col1 = cd1Match0 >= 0 ? cd1Match0 + 1 : 7;
  setCell(invDashList, 0, 81, cd1Col1); // CD1

  const e2On = getCell(invComp, 1, 4);
  const isOff = e2On === false || gsEq(e2On, "FALSE");

  const maxExisting = Math.max(invDashList.length - 1, 2);
  clearRect(invDashList, 2, maxExisting, 0, 90);

  if (isOff) return;

  // ConfCalcs rows 2..5001 (0-indexed rows 1..5000)
  const slot1 = [];
  const slot2 = [];
  const slot3 = [];
  const maxConfRow = Math.min(confCalcs.length, 5001);

  for (let r = 1; r < maxConfRow; r++) {
    const row = confCalcs[r];
    if (!Array.isArray(row)) continue;
    const A = row[0] ?? "";
    const B = row[1] ?? "";

    // Slot 1 (A3:N): AP (col 41) <> ""
    const AP = row[41];
    if (!isBlankCell(AP)) {
      slot1.push([
        A,
        B,
        row[173] ?? "", // FR
        AP,             // AP
        row[186] ?? "", // GE
        String(row[42] ?? ""), // AQ & ""
        row[43] ?? "",  // AR
        row[174] ?? "", // FS
        row[45] ?? "",  // AT
        !isBlankCell(A) ? 1 : "",
        "", "", "", "",
      ]);
    }

    // Slot 2 (P3:AC): AW (col 48) <> ""
    const AW = row[48];
    if (!isBlankCell(AW)) {
      slot2.push([
        A,
        B,
        row[177] ?? "", // FV
        AW,             // AW
        row[189] ?? "", // GH
        String(row[49] ?? ""), // AX & ""
        row[50] ?? "",  // AY
        row[178] ?? "", // FW
        row[52] ?? "",  // BA
        !isBlankCell(A) ? 2 : "",
        "", "", "", "",
      ]);
    }

    // Slot 3 (AE3:AR): BD (col 55) <> ""
    const BD = row[55];
    if (!isBlankCell(BD)) {
      slot3.push([
        A,
        B,
        row[181] ?? "", // FZ
        BD,             // BD
        row[192] ?? "", // GK
        String(row[56] ?? ""), // BE & ""
        row[57] ?? "",  // BF
        row[182] ?? "", // GA
        row[59] ?? "",  // BH
        !isBlankCell(A) ? 3 : "",
        "", "", "", "",
      ]);
    }
  }

  writeRect(invDashList, 2, 0, slot1, 14);  // A3:N
  writeRect(invDashList, 2, 15, slot2, 14); // P3:AC
  writeRect(invDashList, 2, 30, slot3, 14); // AE3:AR

  const combined = [...slot1, ...slot2, ...slot3]
    .filter((r) => !isBlankCell(r[0]) || !isBlankCell(r[1]))
    .map((r) => [
      r[0],
      r[1],
      gsRound(r[2], 2),
      gsRound(r[3], 2),
      gsRound(r[4], 2),
      r[5],
      typeof r[6] === "number" ? r[6] : "",
      typeof r[7] === "number" ? r[7] : "",
      r[8],
      r[9],
      r[10],
      r[11],
      r[12],
      r[13],
    ]);

  // BY3:CL = SORT(roundedData, $CD$1, FALSE) (descending!)
  const sortIdx0 = Math.max(0, cd1Col1 - 1);
  const sorted = [...combined].sort((a, b) => gsSortCompare(a[sortIdx0], b[sortIdx0], false));
  writeRect(invDashList, 2, 76, sorted, 14); // BY3:CL
  compactGridInPlace(invDashList);
}

export function evaluateInvComp(grids) {
  const invComp = grids.InvComp;
  const invAppList = grids.InvAppList;
  const invDashList = grids.InvDashList;
  if (!Array.isArray(invComp) || !Array.isArray(invAppList) || !Array.isArray(invDashList)) return;

  const today = todaySerial();
  const a2Months = getCell(invComp, 1, 0); // A2
  const monthsOffset = gsEq(a2Months, "All") ? -720 : -toNumOrZero(a2Months);
  const d2Start = edateSerial(today, monthsOffset);
  setCell(invComp, 1, 3, d2Start); // D2

  const e2On = getCell(invComp, 1, 4); // E2
  const isOff = e2On === false || gsEq(e2On, "FALSE");

  // Clear formula columns in rows 6..max (preserve Z = col 25 checkboxes and BT = col 71 checkboxes if any)
  const maxR = Math.max(invComp.length - 1, 5);
  clearRect(invComp, 5, maxR, 0, 24);  // A..Y
  clearRect(invComp, 5, maxR, 29, 31); // AD..AF
  clearRect(invComp, 5, maxR, 45, 70); // AT..BS
  clearRect(invComp, 5, maxR, 74, 76); // BW..BY

  if (isOff) {
    setCell(invComp, 1, 2, 0); // C2
    return;
  }

  // Left side A6:K (cols 0..10) from InvAppList!BU4:CF5004 where CA >= D2 (CA is col 78, offset 6 in BU..CF)
  const buHeaders = (invAppList[2] || []).slice(72, 84); // BU3:CF3
  const leftHeaderRow = (invComp[4] || []).slice(0, 11); // A5:K5
  const leftColMap = leftHeaderRow.map((h) => matchInRow0(h, buHeaders));

  const leftBaseRows = [];
  for (let r = 3; r < invAppList.length && r < 5004; r++) {
    const row = invAppList[r];
    if (!Array.isArray(row)) continue;
    const caDate = toSerialOrNull(row[78]); // CA
    if (caDate === null || caDate < d2Start) continue;
    const mapped = leftColMap.map((idx) => (idx >= 0 ? (row[72 + idx] ?? "") : ""));
    if (mapped.every(isBlankCell)) continue;
    leftBaseRows.push(mapped);
  }

  // Right side AT6:BD (cols 45..55) from InvDashList!BY3:CL3005 where CE >= D2 (CE is col 82, offset 6 in BY..CL)
  const byHeaders = (invDashList[1] || []).slice(76, 90); // BY2:CL2
  const rightHeaderRow = (invComp[4] || []).slice(45, 56); // AT5:BD5
  const rightColMap = rightHeaderRow.map((h) => matchInRow0(h, byHeaders));

  const rightBaseRows = [];
  for (let r = 2; r < invDashList.length && r < 3005; r++) {
    const row = invDashList[r];
    if (!Array.isArray(row)) continue;
    const ceDate = toSerialOrNull(row[82]); // CE
    if (ceDate === null || ceDate < d2Start) continue;
    const mapped = rightColMap.map((idx) => (idx >= 0 ? (row[76 + idx] ?? "") : ""));
    if (mapped.every(isBlankCell)) continue;
    rightBaseRows.push(mapped);
  }

  // Write base left (A6:K) and base right (AT6:BD)
  writeRect(invComp, 5, 0, leftBaseRows, 11);
  writeRect(invComp, 5, 45, rightBaseRows, 11);

  // C2 = COUNTIFS(AY:AY, "", AZ:AZ, "<=" & TODAY())
  // In rightBaseRows: AT=0, AU=1, AV=2, AW=3, AX=4, AY=5 (Invoice no), AZ=6 (Sent date), BA=7, BB=8, BC=9, BD=10
  let c2Count = 0;
  for (const rRow of rightBaseRows) {
    const ay = rRow[5];
    const az = toSerialOrNull(rRow[6]);
    if (isBlankCell(ay) && az !== null && az <= today) {
      c2Count++;
    }
  }
  setCell(invComp, 1, 2, c2Count);

  // Index rightBaseRows by AY & "" (first match for XLOOKUP, plus counts/sums for duplicate invoice numbers)
  const rightByInvNo = new Map();
  const rightInvCounts = new Map();
  for (const rRow of rightBaseRows) {
    const key = String(rRow[5] ?? "");
    if (!key) continue;
    const lowerKey = key.toLowerCase();
    if (!rightByInvNo.has(lowerKey)) {
      rightByInvNo.set(lowerKey, rRow);
    }
    rightInvCounts.set(lowerKey, (rightInvCounts.get(lowerKey) || 0) + 1);
  }

  // Evaluate Left-side M..Y (cols 12..24) and AD..AF (cols 29..31)
  for (let i = 0; i < leftBaseRows.length; i++) {
    const r0 = 5 + i;
    const lRow = leftBaseRows[i];
    const A = lRow[0]; // Client
    const B = lRow[1]; // Job
    const C = lRow[2]; // Invoice amount
    const F = lRow[5]; // Invoice no
    const G = lRow[6]; // Sent date
    const I = lRow[8]; // Fully paid on
    const J = lRow[9]; // Status

    const fKey = String(F ?? "").toLowerCase();
    const matchedRight = fKey ? rightByInvNo.get(fKey) : null;

    const M = matchedRight ? matchedRight[5] : ""; // Invoice no
    const S = !isBlankCell(F) && isBlankCell(M) ? 1 : ""; // Missing invoice?
    const mKey = String(M ?? "").toLowerCase();
    const W = S === 1 || isBlankCell(M) ? "" : (rightInvCounts.get(mKey) || 0) > 1 ? 1 : ""; // Duplicate inv no ?

    const N = matchedRight ? matchedRight[0] : ""; // Client (AT)
    let O = ""; // Invoice amount (AV)
    if (!isBlankCell(F)) {
      if (W !== 1) {
        O = matchedRight ? matchedRight[2] : "";
      } else {
        let sum = 0;
        for (const rRow of rightBaseRows) {
          if (String(rRow[5] ?? "").toLowerCase() === mKey) {
            sum += toNumOrZero(rRow[2]);
          }
        }
        O = sum;
      }
    }

    const P = matchedRight ? matchedRight[6] : ""; // Sent date (AZ)
    let Q = ""; // Pay date (BA = matchedRight[7])
    if (!isBlankCell(F)) {
      if (W !== 1) {
        Q = matchedRight ? matchedRight[7] : "";
      } else {
        let maxPaid = 0;
        for (const rRow of rightBaseRows) {
          if (String(rRow[5] ?? "").toLowerCase() === mKey) {
            const baNum = toNumOrZero(rRow[7]);
            if (baNum > maxPaid) maxPaid = baNum;
          }
        }
        Q = maxPaid === 0 ? "" : maxPaid;
      }
    }
    const R = matchedRight ? matchedRight[8] : ""; // Status (BB = matchedRight[8])

    const T = S === 1 ? "" : !gsEq(A, N) ? 1 : "";
    const U = S === 1 ? "" : Math.abs(toNumOrZero(C) - toNumOrZero(O)) > 0.02 ? 1 : "";
    const V = S === 1 ? "" : Math.floor(gsN(toSerialOrNull(G) ?? G)) !== Math.floor(gsN(toSerialOrNull(P) ?? P)) ? 1 : "";

    let X = "";
    if (S !== 1 && !isBlankCell(F) && !isBlankCell(I)) {
      const iInt = Math.floor(gsN(toSerialOrNull(I) ?? I));
      if (W === 1) {
        let foundMatch = false;
        for (const rRow of rightBaseRows) {
          if (
            String(rRow[5] ?? "").toLowerCase() === fKey &&
            Math.floor(gsN(toSerialOrNull(rRow[7]) ?? rRow[7])) === iInt
          ) {
            foundMatch = true;
            break;
          }
        }
        X = foundMatch ? "" : 1;
      } else {
        const qInt = Math.floor(gsN(toSerialOrNull(Q) ?? Q));
        X = iInt !== qInt ? 1 : "";
      }
    }

    const rPartPaid = String(R ?? "").toLowerCase().includes("part-paid");
    const Y = S === 1 ? "" : !gsEq(J, R) && !(gsEq(J, "Sent") && rPartPaid) ? 1 : "";

    const flagSum = toNumOrZero(S) + toNumOrZero(T) + toNumOrZero(U) + toNumOrZero(V) + toNumOrZero(W) + toNumOrZero(X) + toNumOrZero(Y);
    const AD = flagSum === 0 ? "" : A;
    const AE = flagSum === 0 ? "" : B;
    const AF = flagSum === 0 ? "" : F;

    writeRect(invComp, r0, 12, [[M, N, O, P, Q, R, S, T, U, V, W, X, Y]], 13);
    writeRect(invComp, r0, 29, [[AD, AE, AF]], 3);
  }

  // Index leftBaseRows by F & "" for right-side XLOOKUP (BH..BN, cols 59..65)
  const leftByInvNo = new Map();
  for (const lRow of leftBaseRows) {
    const key = String(lRow[5] ?? "").toLowerCase();
    if (key && !leftByInvNo.has(key)) {
      leftByInvNo.set(key, lRow);
    }
  }

  for (let i = 0; i < rightBaseRows.length; i++) {
    const r0 = 5 + i;
    const rRow = rightBaseRows[i];
    const AT = rRow[0]; // Client
    const AU = rRow[1]; // Job
    const AV = rRow[2]; // Invoice amount
    const AY = rRow[5]; // Invoice no
    const AZ = rRow[6]; // Sent date
    const BA = rRow[7]; // Pay date
    const BB = rRow[8]; // Status

    const ayKey = String(AY ?? "").toLowerCase();
    const matchedLeft = ayKey ? leftByInvNo.get(ayKey) : null;

    // BH: Invoice no (F=5), BI: Invoice amount (C=2), BJ: Total excl VAT (D=3), BK: VAT included (E=4), BL: Sent date (G=6), BM: Fully paid on (I=8), BN: Status (J=9)
    const BH = matchedLeft ? matchedLeft[5] : "";
    const BI = matchedLeft ? matchedLeft[2] : "";
    const BJ = matchedLeft ? matchedLeft[3] : "";
    const BK = matchedLeft ? matchedLeft[4] : "";
    const BL = matchedLeft ? matchedLeft[6] : "";
    const BM = matchedLeft ? matchedLeft[8] : "";
    const BN = matchedLeft ? matchedLeft[9] : "";

    const BO = !isBlankCell(AT) && isBlankCell(BH) ? 1 : "";
    const BP = BO === 1 ? "" : Math.abs(toNumOrZero(AV) - toNumOrZero(BI)) > 0.02 ? 1 : "";
    const BQ = BO === 1 ? "" : Math.floor(gsN(toSerialOrNull(AZ) ?? AZ)) !== Math.floor(gsN(toSerialOrNull(BL) ?? BL)) ? 1 : "";
    const BR =
      BO === 1 || !gsEq(BN, "Paid") || gsEq(BN, "Draft")
        ? ""
        : Math.floor(gsN(toSerialOrNull(BA) ?? BA)) !== Math.floor(gsN(toSerialOrNull(BM) ?? BM))
          ? 1
          : "";
    const BS = BO === 1 ? "" : !gsEq(BN, BB) ? 1 : "";

    const rFlagSum = toNumOrZero(BO) + toNumOrZero(BP) + toNumOrZero(BQ) + toNumOrZero(BR) + toNumOrZero(BS);
    const BW = rFlagSum === 0 ? "" : AT;
    const BX = rFlagSum === 0 ? "" : AU;
    const BY = rFlagSum === 0 ? "" : AY;

    writeRect(invComp, r0, 59, [[BH, BI, BJ, BK, BL, BM, BN, BO, BP, BQ, BR, BS]], 12);
    writeRect(invComp, r0, 74, [[BW, BX, BY]], 3);
  }
  const activeInvRows = Math.max(5, 5 + leftBaseRows.length, 5 + rightBaseRows.length);
  if (invComp.length > activeInvRows) invComp.length = activeInvRows;
  compactGridInPlace(invComp);
}

// ============================================================================
// 3. JnlAppList -> DirDashList -> DirComp
// ============================================================================

export function evaluateJnlAppList(grids) {
  const jnlAppList = grids.JnlAppList;
  const jnlsFromApp = grids.JnlsFromApp;
  const dirComp = grids.DirComp;
  if (!Array.isArray(jnlAppList) || !Array.isArray(jnlsFromApp)) return;

  const e2On = getCell(dirComp, 1, 4);
  const isOff = e2On === false || gsEq(e2On, "FALSE");

  const maxR = Math.max(jnlAppList.length - 1, 3);
  clearRect(jnlAppList, 3, maxR, 0, 14);  // A4:O
  clearRect(jnlAppList, 3, maxR, 27, 41); // AB4:AP
  clearRect(jnlAppList, 3, maxR, 78, 92); // CA4:CO

  if (isOff) return;

  const f2Mode = String(getCell(jnlAppList, 1, 5) || "Xero conv").trim(); // F2
  const cb2SortHeader = String(getCell(jnlAppList, 1, 79) || "Date").trim(); // CB2

  // AB2:AP2 (cols 27..41) header mapping into JnlsFromApp!1:1
  const appHeaders = jnlsFromApp[0] || [];
  const abColMap = [];
  for (let c = 27; c <= 41; c++) {
    const h = getCell(jnlAppList, 1, c);
    abColMap.push(matchInRow0(h, appHeaders));
  }

  const abRows = [];
  const aoRows = [];
  for (let r = 1; r < jnlsFromApp.length && r < 5002; r++) {
    const srcRow = jnlsFromApp[r];
    if (!Array.isArray(srcRow) || srcRow.every(isBlankCell)) continue;
    const abRow = abColMap.map((idx) => (idx >= 0 ? (srcRow[idx] ?? "") : ""));
    abRows.push(abRow);

    const AB = abRow[0]; // Date
    if (isBlankCell(AB)) continue;
    const AC = abRow[1]; // Description
    const AD = abRow[2]; // Net (Excl VAT)
    const AE = abRow[3]; // Reference
    const AF = abRow[4]; // Account Name
    const AG = abRow[5]; // Status
    const AH = abRow[6]; // Transaction ID
    const AI = abRow[7]; // Date Paid
    const AJ = abRow[8]; // VAT
    const AK = abRow[9]; // Gross (Incl VAT)
    const AL = abRow[10]; // Currency Code
    const AM = abRow[11]; // Currency Rate
    const AN = abRow[12];
    const AO = abRow[13];
    const AP = abRow[14];

    const rate = isBlankCell(AM) ? 1 : (toNumOrNull(AM) || 1);
    const C = isBlankCell(AD) ? "" : gsRound(toNumOrZero(AD) / rate, 2);

    let F = "";
    if (gsEq(f2Mode, "Actual")) {
      F = AG;
    } else if (gsEq(f2Mode, "Xero conv")) {
      if (gsEq(AG, "PAID")) F = "Paid";
      else if (gsEq(AG, "AUTHORISED")) F = "Received";
      else F = "";
    } else {
      if (gsEq(AG, "PAID")) F = "Paid";
      else if (gsEq(AG, "UNPAID")) F = "Received";
      else F = "";
    }

    const G = String(AH ?? "");
    const H = AI;
    const I = isBlankCell(AJ) ? "" : gsRound(toNumOrZero(AJ) / rate, 2);
    const J = isBlankCell(AK) ? "" : gsRound(toNumOrZero(AK) / rate, 2);

    aoRows.push([AB, AC, C, AE, AF, F, G, H, I, J, AL, AM, AN, AO, AP]);
  }

  writeRect(jnlAppList, 3, 27, abRows, 15);
  writeRect(jnlAppList, 3, 0, aoRows, 15);

  const a3Headers = (jnlAppList[2] || []).slice(0, 15);
  const sortCol0 = Math.max(0, matchInRow0(cb2SortHeader, a3Headers));
  const sortedCA = [...aoRows].sort((a, b) => gsSortCompare(a[sortCol0], b[sortCol0], true));
  writeRect(jnlAppList, 3, 78, sortedCA, 15); // CA4:CO
  compactGridInPlace(jnlAppList);
}

export function evaluateDirDashList(grids) {
  const dirDashList = grids.DirDashList;
  const confCalcs = grids.ConfCalcs;
  const outgoings = grids.Outgoings;
  const outgNotes = grids.OutgNotes;
  const keyInfo = grids.KeyInfo;
  if (!Array.isArray(dirDashList)) return;

  const vatRate = toNumOrZero(getCell(keyInfo, 8, 1)); // KeyInfo!B9 (e.g. 0.2)
  const ha1SortHeader = String(getCell(dirDashList, 0, 208) || "Rec date").trim(); // HA1
  const et2Headers = (dirDashList[1] || []).slice(149, 163); // ET2:FG2
  const hc1Match0 = matchInRow0(ha1SortHeader, et2Headers);
  const hc1Col1 = hc1Match0 >= 0 ? hc1Match0 + 1 : 7;
  setCell(dirDashList, 0, 210, hc1Col1); // HC1

  const maxR = Math.max(dirDashList.length - 1, 2);
  clearRect(dirDashList, 2, maxR, 0, 220);

  // 1. ConfCalcs Slots 1, 2, 3 (ConfCalcs!A2:Z5000 -> 0-indexed rows 1..4999)
  const slot1 = [];
  const slot2 = [];
  const slot3 = [];
  if (Array.isArray(confCalcs)) {
    for (let r = 1; r < confCalcs.length && r < 5000; r++) {
      const row = confCalcs[r];
      if (!Array.isArray(row)) continue;
      const A = row[0] ?? "";
      const B = row[1] ?? "";
      const C = row[2] ?? "";

      // Slot 1: BY (col 76) <> ""
      if (!isBlankCell(row[76])) {
        const desc = row[75] ?? ""; // BX
        const tag = isBlankCell(A) && isBlankCell(B) && isBlankCell(desc) ? "" : "Slot1";
        slot1.push([
          A, B, desc,
          row[196] ?? "", // GO (Gross Amount)
          row[76] ?? "",  // BY (Total excl VAT)
          row[197] ?? "", // GP (VAT included)
          row[78] ?? "",  // CA (Rec date)
          row[200] ?? "", // GS (Pay date)
          row[80] ?? "",  // CC (Status)
          row[81] ?? "",  // CD (App ID)
          tag,
          C, "", "",
        ]);
      }

      // Slot 2: CF (col 83) <> ""
      if (!isBlankCell(row[83])) {
        const desc = row[82] ?? ""; // CE
        const tag = isBlankCell(A) && isBlankCell(B) && isBlankCell(desc) ? "" : "Slot2";
        slot2.push([
          A, B, desc,
          row[203] ?? "", // GV
          row[83] ?? "",  // CF
          row[204] ?? "", // GW
          row[85] ?? "",  // CH
          row[207] ?? "", // GZ
          row[87] ?? "",  // CJ
          row[88] ?? "",  // CK
          tag,
          C, "", "",
        ]);
      }

      // Slot 3: CM (col 90) <> ""
      if (!isBlankCell(row[90])) {
        const desc = row[89] ?? ""; // CL
        const tag = isBlankCell(A) && isBlankCell(B) && isBlankCell(desc) ? "" : "Slot3";
        slot3.push([
          A, B, desc,
          row[210] ?? "", // HC
          row[90] ?? "",  // CM
          row[211] ?? "", // HD
          row[92] ?? "",  // CO
          row[214] ?? "", // HG
          row[94] ?? "",  // CQ
          row[95] ?? "",  // CR
          tag,
          C, "", "",
        ]);
      }
    }
  }

  writeRect(dirDashList, 2, 0, slot1, 14);  // A3:N
  writeRect(dirDashList, 2, 24, slot2, 14); // Y3:AL
  writeRect(dirDashList, 2, 48, slot3, 14); // AW3:BJ

  // 2. Outgoings Tab List (CH3:CO, cols 85..92)
  const ogRows = [];
  if (Array.isArray(outgoings)) {
    const blocks = [
      { startC: 6, endC: 17 },   // G..R
      { startC: 21, endC: 32 },  // V..AG
      { startC: 36, endC: 47 },  // AK..AV
    ];
    for (const blk of blocks) {
      for (let r = 12; r <= 110 && r < outgoings.length; r++) {
        const row = outgoings[r] || [];
        const notesRow = (Array.isArray(outgNotes) && outgNotes[r]) ? outgNotes[r] : [];
        for (let c = blk.startC; c <= blk.endC; c++) {
          const val = row[c];
          if (isBlankCell(val)) continue;
          const chDate = getCell(outgoings, 0, c);
          const ciDesc = row[0] ?? "";
          const cjAmt = val;
          const ckVat = row[1] ?? "";
          const clInv = row[2] ?? "";
          const cmPay = row[3] ?? "";
          const cnDel = row[4] ?? "";
          const coNotes = notesRow[c] ?? "";
          ogRows.push([chDate, ciDesc, cjAmt, ckVat, clInv, cmPay, cnDel, coNotes]);
        }
      }
    }
  }
  writeRect(dirDashList, 2, 85, ogRows, 8); // CH3:CO

  // 3. Data from Notes (CW3:DB, cols 100..105) + Single App IDs (DM3:DZ, cols 116..129) + Multiple App IDs (DE3:DJ, cols 108..113 & EC3:EP, cols 132..145)
  const cwRows = [];
  const dmRows = [];
  const deRows = [];

  for (const og of ogRows) {
    const [CH, CI, CJ, CK, CL, , , CO] = og;
    const coStr = String(CO ?? "");
    let CW = "", CX = "", CY = "", CZ = "", DA = "", DB = "";
    if (coStr) {
      const appIdMatches = coStr.match(/\{App ID:/gi) || [];
      if (appIdMatches.length > 1) {
        CW = "Multiple";
      } else {
        const mId = coStr.match(/\{App ID:\s*([^}]+)\s*\}/);
        CW = mId ? mId[1] : "";
      }
      const mStat = coStr.match(/\{Status:\s*([^}]+)\s*\}/);
      CX = mStat ? mStat[1] : "";
      const mRec = coStr.match(/\{Rec date:\s*([^}]+)\s*\}/);
      CY = mRec ? mRec[1] : "";
      const mPay = coStr.match(/\{Pay date:\s*([^}]+)\s*\}/);
      CZ = mPay ? mPay[1] : "";
      const mDesc = coStr.match(/\{Description:\s*([^}]+)\s*\}/);
      DA = mDesc ? mDesc[1] : "";
      const mAmt = coStr.match(/\{Amt:\s*([^}]+)\s*\}/);
      if (mAmt) {
        const nAmt = toNumOrNull(mAmt[1]);
        DB = nAmt !== null ? nAmt : "";
      }

      // Multiple App IDs extraction (DE3:DJ)
      if (appIdMatches.length >= 2) {
        const segments = coStr.split(/(?=\{App ID:)/i).filter((s) => /\{App ID:/i.test(s));
        for (const seg of segments) {
          const sId = (seg.match(/\{App ID:\s*([^}]+)\}/i) || [])[1] ?? "";
          const sStat = (seg.match(/\{Status:\s*([^}]+)\}/i) || [])[1] ?? "";
          const rawRDate = (seg.match(/\{Rec date:\s*([^}]+)\}/i) || [])[1] ?? "";
          const sRDate = rawRDate ? (toSerialOrNull(rawRDate) ?? rawRDate) : "";
          const rawPDate = (seg.match(/\{Pay date:\s*([^}]+)\}/i) || [])[1] ?? "";
          const sPDate = rawPDate ? (toSerialOrNull(rawPDate) ?? rawPDate) : "";
          const sDesc = (seg.match(/\{Description:\s*([^}]+)\}/i) || [])[1] ?? "";
          const rawAmt = (seg.match(/\{Amt:\s*([^}]+)\}/i) || [])[1] ?? "";
          const sAmt = rawAmt ? (toNumOrNull(rawAmt) ?? rawAmt) : "";
          if (sId) {
            deRows.push([sId, sStat, sRDate, sPDate, sDesc, sAmt]);
          }
        }
      }
    }
    cwRows.push([CW, CX, CY, CZ, DA, DB]);

    // Single App ID row (DM3:DZ)
    if (isBlankCell(CJ) || CW === "Multiple") {
      dmRows.push(["", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
    } else {
      const DO = isBlankCell(DA) ? CI : DA;
      const DQ = isBlankCell(DB) ? toNumOrZero(CJ) : toNumOrZero(DB);
      const DP = isBlankCell(DQ) ? "" : gsEq(CK, "Yes") ? DQ * (1 + vatRate) : DQ;
      const DR = isBlankCell(DQ) ? "" : DP - DQ;
      let DS = "";
      if (!isBlankCell(CI) && CW !== "Multiple") {
        if (isBlankCell(CY)) {
          const eom = eomonthSerial(CH, 0);
          DS = eom !== "" ? (gsEq(CL, "Curr") ? eom : eom + 5) : "";
        } else {
          DS = toSerialOrNull(CY) ?? CY;
        }
      }
      let DT = "";
      if (!isBlankCell(DS) && String(CZ ?? "").trim() !== "") {
        DT = toSerialOrNull(CZ) ?? CZ;
      }
      const DU = isBlankCell(CX) || CW === "Multiple" ? "" : CX;
      const DV = isBlankCell(CW) || CW === "Multiple" ? "" : CW;
      const DW = isBlankCell(DO) && isBlankCell(DP) ? "" : `OG-${formatSerialDMMMYY(CH)}`;
      dmRows.push(["", "", DO, DP, DQ, DR, DS, DT, DU, DV, DW, "", "", ""]);
    }
  }

  writeRect(dirDashList, 2, 100, cwRows, 6);  // CW3:DB
  writeRect(dirDashList, 2, 108, deRows, 6);  // DE3:DJ
  writeRect(dirDashList, 2, 116, dmRows, 14); // DM3:DZ

  // 4. Multiple App IDs mapped to EC3:EP (cols 132..145)
  const ecRows = [];
  for (const de of deRows) {
    const [DE, DF, DG, DH, DI, DJ] = de;
    if (isBlankCell(DE)) continue;
    const EL = DE;
    const EE = DI;
    const EG = toNumOrZero(DJ);
    // Wildcard XLOOKUP("*" & EL & "*", CO:CO, ...)
    const matchedOg = ogRows.find((r) => String(r[7] ?? "").toLowerCase().includes(String(EL).toLowerCase()));
    const ckMatch = matchedOg ? matchedOg[3] : "Not Found";
    const chMatch = matchedOg ? matchedOg[0] : "";
    const EF = EG * (gsEq(ckMatch, "Yes") ? 1 + vatRate : 1);
    const EH = EF - EG;
    const EI = DG;
    const EJ = DH;
    const EK = DF;
    const EM = chMatch !== "" ? `OG-${formatSerialDMMMYY(chMatch)}` : "OG-Not Found";
    ecRows.push(["", "", EE, EF, EG, EH, EI, EJ, EK, EL, EM, "", "", ""]);
  }
  writeRect(dirDashList, 2, 132, ecRows, 14); // EC3:EP

  // 5. Combined ET3:FG (cols 149..162) where Col4 (Gross Amount) is not null/empty
  const rawCombined = [...slot1, ...slot2, ...slot3, ...dmRows, ...ecRows].filter((r) => !isBlankCell(r[3]));
  const etRows = rawCombined.map((r) => {
    const c4 = toNumOrNull(r[3]);
    const c5 = toNumOrNull(r[4]);
    const c6 = toNumOrNull(r[5]);
    const c7 = toSerialOrNull(r[6]);
    const c8 = toSerialOrNull(r[7]);
    return [
      String(r[0] ?? ""),
      String(r[1] ?? ""),
      String(r[2] ?? ""),
      c4 !== null ? gsRound(c4, 2) : String(r[3] ?? ""),
      c5 !== null ? gsRound(c5, 2) : String(r[4] ?? ""),
      c6 !== null ? gsRound(c6, 2) : String(r[5] ?? ""),
      c7 !== null ? Math.floor(c7) : String(r[6] ?? ""),
      c8 !== null ? Math.floor(c8) : String(r[7] ?? ""),
      String(r[8] ?? ""),
      String(r[9] ?? ""),
      String(r[10] ?? ""),
      String(r[11] ?? ""),
      String(r[12] ?? ""),
      String(r[13] ?? ""),
    ];
  });
  writeRect(dirDashList, 2, 149, etRows, 14); // ET3:FG

  // 6. Sorted GW3:HJ (cols 204..217) ascending by $HC$1
  const sortIdx0 = Math.max(0, hc1Col1 - 1);
  const gwRows = [...etRows].sort((a, b) => gsSortCompare(a[sortIdx0], b[sortIdx0], true));
  writeRect(dirDashList, 2, 204, gwRows, 14); // GW3:HJ
  compactGridInPlace(dirDashList);
}

export function evaluateDirComp(grids) {
  const dirComp = grids.DirComp;
  const jnlAppList = grids.JnlAppList;
  const dirDashList = grids.DirDashList;
  if (!Array.isArray(dirComp) || !Array.isArray(jnlAppList) || !Array.isArray(dirDashList)) return;

  const today = todaySerial();
  const a2Months = getCell(dirComp, 1, 0); // A2
  const monthsOffset = gsEq(a2Months, "All") ? -720 : -toNumOrZero(a2Months);
  const d2Start = edateSerial(today, monthsOffset);
  setCell(dirComp, 1, 3, d2Start); // D2

  const e2On = getCell(dirComp, 1, 4); // E2
  const isOff = e2On === false || gsEq(e2On, "FALSE");

  // Clear formula columns in DirComp (preserve BD = col 55 checkboxes and action columns AZ..BZ / FU..GW if any, wait: let's only clear formula columns!)
  // Formula columns: A..N (0..13), X..AH (23..33), AO..AV (40..47), DG..DQ (110..120), EP..EY (145..154), FJ..FQ (165..172)
  const maxR = Math.max(dirComp.length - 1, 5);
  clearRect(dirComp, 5, maxR, 0, 13);
  clearRect(dirComp, 5, maxR, 23, 33);
  clearRect(dirComp, 5, maxR, 40, 47);
  clearRect(dirComp, 5, maxR, 110, 120);
  clearRect(dirComp, 5, maxR, 145, 154);
  clearRect(dirComp, 5, maxR, 165, 172);

  if (isOff) {
    setCell(dirComp, 1, 1, 0); // B2
    setCell(dirComp, 1, 2, 0); // C2
    return;
  }

  // 1. Left base A6:N (cols 0..13) from JnlAppList!CA4:CN1000 where CA >= D2
  const caHeaders = (jnlAppList[2] || []).slice(78, 92); // CA3:CN3
  const leftHeaders = (dirComp[4] || []).slice(0, 14); // A5:N5
  const leftColMap = leftHeaders.map((h) => matchInRow0(h, caHeaders));

  const leftBaseRows = [];
  for (let r = 3; r < jnlAppList.length && r < 1000; r++) {
    const row = jnlAppList[r];
    if (!Array.isArray(row)) continue;
    const caDate = toSerialOrNull(row[78]); // CA
    if (caDate === null || caDate < d2Start) continue;
    const mapped = leftColMap.map((idx) => (idx >= 0 ? (row[78 + idx] ?? "") : ""));
    if (mapped.every(isBlankCell)) continue;
    leftBaseRows.push(mapped);
  }
  writeRect(dirComp, 5, 0, leftBaseRows, 14);

  // 2. Right base DG6:DQ (cols 110..120) from DirDashList!GW3:HJ1009 where HC >= D2 and GZ <> 0
  // GW is col 204, GZ is col 207 (offset 3 = Gross Amount), HC is col 210 (offset 6 = Rec date)
  const gwHeaders = (dirDashList[1] || []).slice(204, 218); // GW2:HJ2
  const rightHeaders = (dirComp[4] || []).slice(110, 121); // DG5:DQ5
  const rightColMap = rightHeaders.map((h) => matchInRow0(h, gwHeaders));

  const rightBaseRows = [];
  for (let r = 2; r < dirDashList.length && r < 1009; r++) {
    const row = dirDashList[r];
    if (!Array.isArray(row)) continue;
    const hcDate = toSerialOrNull(row[210]); // HC
    const gzGross = toNumOrNull(row[207]);   // GZ
    if (hcDate === null || hcDate < d2Start) continue;
    if (gzGross === null || gzGross === 0) continue;
    const mapped = rightColMap.map((idx) => (idx >= 0 ? (row[204 + idx] ?? "") : ""));
    if (mapped.every(isBlankCell)) continue;
    rightBaseRows.push(mapped);
  }
  writeRect(dirComp, 5, 110, rightBaseRows, 11);

  // B2 = COUNTIFS(DP:DP, "*UNRECON-GAP*", DM:DM, "<=" & TODAY())
  // C2 = COUNTIFS(DP:DP, "*MANUAL-ENTRY*", DM:DM, "<=" & TODAY()) + COUNTIFS(DP:DP, "*PLACE-EXP*", DM:DM, "<=" & TODAY())
  // In rightBaseRows: DG=0(Client), DH=1(Job), DI=2(Desc), DJ=3(Gross), DK=4(Net), DL=5(VAT), DM=6(Rec date), DN=7(Pay date), DO=8(Status), DP=9(App ID), DQ=10(Source)
  let b2Count = 0;
  let c2Count = 0;
  for (const rRow of rightBaseRows) {
    const dpStr = String(rRow[9] ?? "").toUpperCase();
    const dmDate = toSerialOrNull(rRow[6]);
    if (dmDate !== null && dmDate <= today) {
      if (dpStr.includes("UNRECON-GAP")) b2Count++;
      if (dpStr.includes("MANUAL-ENTRY") || dpStr.includes("PLACE-EXP")) c2Count++;
    }
  }
  setCell(dirComp, 1, 1, b2Count);
  setCell(dirComp, 1, 2, c2Count);

  // Index rightBaseRows by DP & "" (App ID)
  const rightByAppId = new Map();
  const rightAppIdCounts = new Map();
  for (const rRow of rightBaseRows) {
    const key = String(rRow[9] ?? "").toLowerCase();
    if (!key) continue;
    if (!rightByAppId.has(key)) rightByAppId.set(key, rRow);
    rightAppIdCounts.set(key, (rightAppIdCounts.get(key) || 0) + 1);
  }

  // 3. Left compare X6:AH (cols 23..33) and flags AO6:AV (cols 40..47)
  // Left cols: A=0(Date), B=1(Desc), C=2(Amount), D=3(Ref), E=4(Acc), F=5(Status), G=6(TxID), H=7(Date paid), I=8(VAT), J=9(Gross)
  for (let i = 0; i < leftBaseRows.length; i++) {
    const r0 = 5 + i;
    const lRow = leftBaseRows[i];
    const A = lRow[0];
    const B = lRow[1];
    const C = lRow[2];
    const F = lRow[5];
    const G = lRow[6];
    const H = lRow[7];
    const I = lRow[8];

    const gKey = String(G ?? "").toLowerCase();
    const matchedRight = gKey ? rightByAppId.get(gKey) : null;

    const X = matchedRight ? matchedRight[9] : "";  // App ID (DP)
    const AO = !isBlankCell(G) && isBlankCell(X) ? 1 : ""; // Missing cost?
    const xKey = String(X ?? "").toLowerCase();
    const AP = AO === 1 || isBlankCell(X) ? "" : (rightAppIdCounts.get(xKey) || 0) > 1 ? 1 : ""; // Duplicate app ID?

    const Y = matchedRight ? matchedRight[0] : "";  // Client (DG)
    const Z = matchedRight ? matchedRight[1] : "";  // Job (DH)
    const AA = matchedRight ? matchedRight[2] : ""; // Desc (DI)

    let AB = "", AC = "", AD = "";
    if (!isBlankCell(G)) {
      if (AP !== 1) {
        AB = matchedRight ? matchedRight[3] : ""; // Gross (DJ)
        AC = matchedRight ? matchedRight[4] : ""; // Net (DK)
        AD = matchedRight ? matchedRight[5] : ""; // VAT (DL)
      } else {
        let sumDJ = 0, sumDK = 0, sumDL = 0;
        for (const rRow of rightBaseRows) {
          if (String(rRow[9] ?? "").toLowerCase() === xKey) {
            sumDJ += toNumOrZero(rRow[3]);
            sumDK += toNumOrZero(rRow[4]);
            sumDL += toNumOrZero(rRow[5]);
          }
        }
        AB = gsRound(sumDJ, 2);
        AC = gsRound(sumDK, 2);
        AD = gsRound(sumDL, 2);
      }
    }

    const AE = matchedRight ? matchedRight[6] : ""; // Rec date (DM)
    let AF = ""; // Pay date (DN)
    if (!isBlankCell(G)) {
      if (AP !== 1) {
        AF = matchedRight ? matchedRight[7] : "";
      } else {
        let mx = 0;
        for (const rRow of rightBaseRows) {
          if (String(rRow[9] ?? "").toLowerCase() === xKey) {
            const dnVal = toNumOrZero(rRow[7]);
            if (dnVal > mx) mx = dnVal;
          }
        }
        AF = mx === 0 ? "" : mx;
      }
    }
    const AG = matchedRight ? matchedRight[8] : ""; // Status (DO)
    const AH = matchedRight ? matchedRight[10] : ""; // Source (DQ)

    const AQ = AO === 1 ? "" : !gsEq(B, AA) ? 1 : "";
    const AR = AO === 1 ? "" : toNumOrZero(C) !== toNumOrZero(AC) ? 1 : "";
    const AS = AO === 1 ? "" : Math.abs(toNumOrZero(I) - toNumOrZero(AD)) > 0.05 ? 1 : "";
    const AT = AO === 1 ? "" : Math.floor(gsN(toSerialOrNull(A) ?? A)) !== Math.floor(gsN(toSerialOrNull(AE) ?? AE)) ? 1 : "";

    let AU = "";
    if (AO !== 1 && !isBlankCell(G) && !isBlankCell(H)) {
      const hInt = Math.floor(gsN(toSerialOrNull(H) ?? H));
      if (AP === 1) {
        let hasMatch = false;
        for (const rRow of rightBaseRows) {
          if (
            String(rRow[9] ?? "").toLowerCase() === gKey &&
            Math.floor(gsN(toSerialOrNull(rRow[7]) ?? rRow[7])) === hInt
          ) {
            hasMatch = true;
            break;
          }
        }
        AU = hasMatch ? "" : 1;
      } else {
        const afInt = Math.floor(gsN(toSerialOrNull(AF) ?? AF));
        AU = hInt !== afInt ? 1 : "";
      }
    }

    const agPartPaid = String(AG ?? "").toLowerCase().includes("part-paid");
    const AV = AO === 1 ? "" : !gsEq(F, AG) && !(gsEq(F, "Received") && agPartPaid) ? 1 : "";

    writeRect(dirComp, r0, 23, [[X, Y, Z, AA, AB, AC, AD, AE, AF, AG, AH]], 11);
    writeRect(dirComp, r0, 40, [[AO, AP, AQ, AR, AS, AT, AU, AV]], 8);
  }

  // Index leftBaseRows by G & "" (Transaction ID)
  const leftByTxId = new Map();
  for (const lRow of leftBaseRows) {
    const key = String(lRow[6] ?? "").toLowerCase();
    if (key && !leftByTxId.has(key)) leftByTxId.set(key, lRow);
  }

  // 4. Right compare EP6:EY (cols 145..154) and flags FJ6:FQ (cols 165..172)
  for (let i = 0; i < rightBaseRows.length; i++) {
    const r0 = 5 + i;
    const rRow = rightBaseRows[i];
    const DI = rRow[2]; // Desc
    const DK = rRow[4]; // Net
    const DM = rRow[6]; // Rec date
    const DN = rRow[7]; // Pay date
    const DO = rRow[8]; // Status
    const DP = rRow[9]; // App ID

    const dpKey = String(DP ?? "").toLowerCase();
    const matchedLeft = dpKey ? leftByTxId.get(dpKey) : null;

    // EP: TxID(G=6), EQ: Date(A=0), ER: Desc(B=1), ES: Amount(C=2), ET: Ref(D=3), EU: Acc(E=4), EV: Status(F=5), EW: Date paid(H=7), EX: VAT(I=8), EY: Gross(J=9)
    const EP = matchedLeft ? matchedLeft[6] : "";
    const EQ = matchedLeft ? matchedLeft[0] : "";
    const ER = matchedLeft ? matchedLeft[1] : "";
    const ES = matchedLeft ? matchedLeft[2] : "";
    const ET = matchedLeft ? matchedLeft[3] : "";
    const EU = matchedLeft ? matchedLeft[4] : "";
    const EV = matchedLeft ? matchedLeft[5] : "";
    const EW = matchedLeft ? matchedLeft[7] : "";
    const EX = matchedLeft ? matchedLeft[8] : "";
    const EY = matchedLeft ? matchedLeft[9] : "";

    const FJ = !isBlankCell(DI) && isBlankCell(EP) ? 1 : "";
    const epKey = String(EP ?? "").toLowerCase();
    const FK = FJ === 1 || isBlankCell(EP) ? "" : (rightAppIdCounts.get(epKey) || 0) > 1 ? 1 : "";
    const FL = FJ === 1 ? "" : !gsEq(DI, ER) ? 1 : "";
    const FM = FJ === 1 || FK === 1 ? "" : toNumOrZero(DK) !== toNumOrZero(ES) ? 1 : "";
    const FN = FJ === 1 || FK === 1 ? "" : toNumOrZero(DK) !== toNumOrZero(ES) ? 1 : ""; // Note: exact formula in FN6 is IF($DK6:$DK1005<>$ES6:$ES1005, 1, "")
    const FO = FJ === 1 ? "" : Math.floor(gsN(toSerialOrNull(DM) ?? DM)) !== Math.floor(gsN(toSerialOrNull(EQ) ?? EQ)) ? 1 : "";
    const FP = FJ === 1 || FK === 1 ? "" : Math.floor(gsN(toSerialOrNull(DN) ?? DN)) !== Math.floor(gsN(toSerialOrNull(EW) ?? EW)) ? 1 : "";
    const doPartPaid = String(DO ?? "").toLowerCase().includes("part-paid");
    const FQ = FJ === 1 ? "" : !gsEq(DO, EV) && !(gsEq(EV, "Received") && doPartPaid) ? 1 : "";

    writeRect(dirComp, r0, 145, [[EP, EQ, ER, ES, ET, EU, EV, EW, EX, EY]], 10);
    writeRect(dirComp, r0, 165, [[FJ, FK, FL, FM, FN, FO, FP, FQ]], 8);
  }
  const activeDirRows = Math.max(5, 5 + leftBaseRows.length, 5 + rightBaseRows.length);
  if (dirComp.length > activeDirRows) dirComp.length = activeDirRows;
  compactGridInPlace(dirComp);
}

// ============================================================================
// 4. CRMList -> CRMComp
// ============================================================================

export function evaluateCRMList(grids) {
  const crmList = grids.CRMList;
  const dataFromCRM = grids.DataFromCRM;
  const crmComp = grids.CRMComp;
  const keyInfo = grids.KeyInfo;
  if (!Array.isArray(crmList) || !Array.isArray(dataFromCRM)) return;

  const e2On = getCell(crmComp, 1, 4);
  const isOff = e2On === false || gsEq(e2On, "FALSE");

  const maxR = Math.max(crmList.length - 1, 3);
  clearRect(crmList, 3, maxR, 0, 14);    // A4:O
  clearRect(crmList, 3, maxR, 27, 41);   // AB4:AP
  clearRect(crmList, 3, maxR, 78, 92);   // CA4:CO
  clearRect(crmList, 3, maxR, 103, 117); // CZ4:DN
  clearRect(crmList, 3, maxR, 124, 138); // DU4:EI

  if (isOff) return;

  const a2Mode = String(getCell(crmList, 1, 0) || "Other").trim();
  const d2Mode = String(getCell(crmList, 1, 3) || "Actual").trim();
  const f2Mode = String(getCell(crmList, 1, 5) || "Actual").trim();
  const g2Mode = String(getCell(crmList, 1, 6) || "Actual").trim();
  const h2Mode = String(getCell(crmList, 1, 7) || "Actual").trim();
  const j2Mode = String(getCell(crmList, 1, 9) || "From CRM").trim();
  const k2Mode = String(getCell(crmList, 1, 10) || "Actual").trim();
  const m2Mode = String(getCell(crmList, 1, 12) || "Actual").trim();
  const cb2Sort = String(getCell(crmList, 1, 79) || "Start date").trim();

  // KeyInfo lookup tables:
  // Status/Likelihood mapping: KeyInfo!L32:N75 (0-indexed rows 31..74, cols 11, 12, 13)
  // Lead source mapping: KeyInfo!I32:J75 (0-indexed rows 31..74, cols 8, 9)
  // Product line mapping: KeyInfo!E23:F37 (0-indexed rows 22..36, cols 4, 5)
  const lookupKeyInfo = (needle, startR0, endR0, keyCol0, valCol0) => {
    if (isBlankCell(needle) || !Array.isArray(keyInfo)) return "";
    for (let r = startR0; r <= endR0 && r < keyInfo.length; r++) {
      const k = getCell(keyInfo, r, keyCol0);
      if (gsValEq(k, needle)) return getCell(keyInfo, r, valCol0);
    }
    return "";
  };

  // AB2:AP2 (cols 27..41) header mapping into DataFromCRM!1:1
  const crmHeaders = dataFromCRM[0] || [];
  const abColMap = [];
  for (let c = 27; c <= 41; c++) {
    const h = getCell(crmList, 1, c);
    abColMap.push(matchInRow0(h, crmHeaders));
  }

  const today = todaySerial();
  const date2050 = ymdToSerial(2050, 12, 31);

  const abRows = [];
  const aoRows = [];
  for (let r = 1; r < dataFromCRM.length && r < 5002; r++) {
    const srcRow = dataFromCRM[r];
    if (!Array.isArray(srcRow) || srcRow.every(isBlankCell)) continue;
    const abRow = abColMap.map((idx) => (idx >= 0 ? (srcRow[idx] ?? "") : ""));
    abRows.push(abRow);

    const [AB, AC, AD, AE, AF, AG, AH, AI, AJ, AK, AL, AM, AN, AO, AP] = abRow;
    const bothBlank = isBlankCell(AB) && isBlankCell(AC);
    if (bothBlank) {
      aoRows.push(["", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
      continue;
    }

    // A: Client
    let A = AB;
    if (!isBlankCell(AB) && gsEq(a2Mode, "String")) {
      const parts = String(AB).split('"');
      A = parts[7] ?? AB;
    }
    const B = AC;
    const C = AD;

    // D: Revenue
    let D = "";
    if (!isBlankCell(AE)) {
      if (gsEq(d2Mode, "Actual")) {
        D = toNumOrNull(AE) ?? AE;
      } else {
        const n = toNumOrNull(AE);
        if (n !== null) D = n;
        else {
          const m = String(AE).match(/(\d*\.?\d+)/);
          D = m ? Number(m[1]) : "";
        }
      }
    }

    // E: Direct costs
    const E = isBlankCell(D) ? "" : isBlankCell(AF) ? 0 : (toNumOrNull(AF) ?? AF);

    // J: Project / retainer (computed before G since G uses J)
    let J = "";
    const akStr = String(AK ?? "");
    const isRet = /retain/i.test(akStr);
    const isProj = /proj/i.test(akStr);
    if (gsEq(j2Mode, "From CRM")) J = AK;
    else if (gsEq(j2Mode, "All project")) J = "Project";
    else if (gsEq(j2Mode, "FromCRMOrAllProject")) J = isBlankCell(AK) ? "Project" : AK;
    else if (gsEq(j2Mode, "FromCRMOrAllRetainer")) J = isBlankCell(AK) ? "Retainer" : AK;
    else if (gsEq(j2Mode, "FromCRMConvertOrAllProject")) J = isBlankCell(AK) ? "Project" : isRet ? "Retainer" : isProj ? "Project" : AK;
    else if (gsEq(j2Mode, "FromCRMConvertOrAllRetainer")) J = isBlankCell(AK) ? "Retainer" : isRet ? "Retainer" : isProj ? "Project" : AK;
    else J = "Retainer";

    // F: Start date
    let F = "";
    if (!isBlankCell(AG) || gsEq(f2Mode, "Actual OR by Status")) {
      if (gsEq(f2Mode, "Actual")) {
        const s = toSerialOrNull(AG);
        F = s !== null ? Math.floor(s) : "";
      } else if (gsEq(f2Mode, "Convert US")) {
        const parts = String(AG).split(/[\/,]/).map((x) => Number(x.trim()));
        if (parts.length >= 3) F = ymdToSerial(parts[2], parts[0], parts[1]);
      } else if (gsEq(f2Mode, "Actual OR by Status")) {
        if (isBlankCell(AG)) {
          const mOff = toNumOrNull(lookupKeyInfo(AJ, 31, 74, 11, 13));
          if (mOff !== null) {
            const ed = edateSerial(today, mOff);
            const eom = eomonthSerial(ed, -1);
            F = eom !== "" ? eom + 1 : "";
          }
        } else {
          F = toSerialOrNull(AG) ?? AG;
        }
      } else {
        F = toSerialOrNull(AG) ?? AG;
      }
    }

    // G: End date
    let G = "";
    if (!isBlankCell(F)) {
      const fInt = Math.floor(toSerialOrNull(F) ?? 0);
      const ahSerial = toSerialOrNull(AH);
      const ahInt = ahSerial !== null ? Math.floor(ahSerial) : null;
      const ahBlank = isBlankCell(AH);

      if (gsEq(g2Mode, "Actual")) G = ahBlank ? "" : (ahInt ?? "");
      else if (gsEq(g2Mode, "Months")) G = ahBlank ? "" : edateSerial(fInt, toNumOrZero(AH)) - 1;
      else if (gsEq(g2Mode, "AddRetEnd")) G = ahBlank && gsEq(J, "Retainer") ? date2050 : ahBlank ? "" : (ahInt ?? "");
      else if (gsEq(g2Mode, "2MonthsForAll")) G = Math.floor(edateSerial(fInt, 2));
      else if (gsEq(g2Mode, "3MonthsForAll")) G = Math.floor(edateSerial(fInt, 3));
      else if (gsEq(g2Mode, "4MonthsForAll")) G = Math.floor(edateSerial(fInt, 4));
      else if (gsEq(g2Mode, "ActualOr2MonthsForAll")) G = ahBlank ? Math.floor(edateSerial(fInt, 2)) : (ahInt ?? "");
      else if (gsEq(g2Mode, "ActualOr3MonthsForAll")) G = ahBlank ? Math.floor(edateSerial(fInt, 3)) : (ahInt ?? "");
      else if (gsEq(g2Mode, "ActualOr4MonthsForAll")) G = ahBlank ? Math.floor(edateSerial(fInt, 4)) : (ahInt ?? "");
      else if (gsEq(g2Mode, "MonthsOr2MonthsForAll")) G = ahBlank ? Math.floor(edateSerial(fInt, 2)) : edateSerial(fInt, toNumOrZero(AH)) - 1;
      else if (gsEq(g2Mode, "MonthsOr3MonthsForAll")) G = ahBlank ? Math.floor(edateSerial(fInt, 3)) : edateSerial(fInt, toNumOrZero(AH)) - 1;
      else if (gsEq(g2Mode, "MonthsOr4MonthsForAll")) G = ahBlank ? Math.floor(edateSerial(fInt, 4)) : edateSerial(fInt, toNumOrZero(AH)) - 1;
      else if (gsEq(g2Mode, "ActualOrAddRetEndOr2MonthsProj")) G = ahBlank ? (gsEq(J, "Retainer") ? date2050 : Math.floor(edateSerial(fInt, 2))) : (ahInt ?? "");
      else if (gsEq(g2Mode, "ActualOrAddRetEndOr3MonthsProj")) G = ahBlank ? (gsEq(J, "Retainer") ? date2050 : Math.floor(edateSerial(fInt, 3))) : (ahInt ?? "");
      else if (gsEq(g2Mode, "ActualOrAddRetEndOr4MonthsProj")) G = ahBlank ? (gsEq(J, "Retainer") ? date2050 : Math.floor(edateSerial(fInt, 4))) : (ahInt ?? "");
    }

    // H: Likelihood
    let H = "";
    if (gsEq(h2Mode, "Mapped")) {
      H = lookupKeyInfo(AI, 31, 74, 11, 12);
    } else if (gsEq(h2Mode, "Divide by 100")) {
      const n = toNumOrNull(AI);
      H = n !== null ? n / 100 : "";
    } else if (gsEq(h2Mode, "ActualOrMappedByStatus")) {
      H = isBlankCell(AI) ? lookupKeyInfo(AJ, 31, 74, 11, 12) : (toNumOrNull(AI) ?? AI);
    } else {
      H = toNumOrNull(AI) ?? AI;
    }

    const I = AJ; // Status
    const K = gsEq(k2Mode, "Mapped") ? lookupKeyInfo(AL, 31, 74, 8, 9) : AL;
    const L = toSerialOrNull(AM) ?? AM;
    const M = gsEq(m2Mode, "Mapped") ? lookupKeyInfo(AN, 22, 36, 4, 5) : AN;
    const N = AO;

    aoRows.push([A, B, C, D, E, F, G, H, I, J, K, L, M, N, AP]);
  }

  writeRect(crmList, 3, 27, abRows, 15);
  writeRect(crmList, 3, 0, aoRows, 15);

  // CA4:CO = SORT(FILTER(A4:O5004, F<>"", G<>""), MATCH($CB$2, A3:O3, 0), TRUE)
  const a3Headers = (crmList[2] || []).slice(0, 15);
  const sortCol0 = Math.max(0, matchInRow0(cb2Sort, a3Headers));
  const caRows = aoRows
    .filter((r) => !isBlankCell(r[5]) && !isBlankCell(r[6]))
    .sort((a, b) => gsSortCompare(a[sortCol0], b[sortCol0], true));
  writeRect(crmList, 3, 78, caRows, 15); // CA4:CO

  // CZ4:DN (Confirmed jobs)
  const dd2ConfDef = String(getCell(crmList, 1, 107) || "").trim(); // DD2
  const df2StatIncl = String(getCell(crmList, 1, 109) || "").trim(); // DF2
  const dh2AndOr = String(getCell(crmList, 1, 111) || "Or").trim(); // DH2
  const inclRegex = df2StatIncl ? new RegExp(df2StatIncl.replace(/,\s*/g, "|"), "i") : null;

  const czRows = caRows.filter((r) => {
    const chLike = toNumOrNull(r[7]);
    const ciStat = String(r[8] ?? "");
    const c1 = gsEq(dd2ConfDef, "Likelihood 100%") ? chLike === 1 : true;
    const c2 = inclRegex ? inclRegex.test(ciStat) : true;
    if (gsEq(dh2AndOr, "And")) return c1 && c2;
    return (gsEq(dd2ConfDef, "Likelihood 100%") && chLike === 1) || (inclRegex ? inclRegex.test(ciStat) : false);
  });
  writeRect(crmList, 3, 103, czRows, 15); // CZ4:DN

  // DU4:EI (Pipeline jobs)
  const dy2PipeDef = gsEq(dd2ConfDef, "Likelihood 100%") ? "Likelihood < 100%" : "";
  setCell(crmList, 1, 128, dy2PipeDef); // DY2
  const ea2StatExcl = df2StatIncl;
  setCell(crmList, 1, 130, ea2StatExcl); // EA2
  const ec2AndOr = String(getCell(crmList, 1, 132) || "And").trim(); // EC2
  const ee2AddExcl = String(getCell(crmList, 1, 134) || "").trim(); // EE2
  const exclRegex = ea2StatExcl ? new RegExp(ea2StatExcl.replace(/,\s*/g, "|"), "i") : null;
  const addExclRegex = ee2AddExcl ? new RegExp(ee2AddExcl.replace(/,\s*/g, "|"), "i") : null;

  const duRows = caRows.filter((r) => {
    const chLike = toNumOrNull(r[7]);
    const ciStat = String(r[8] ?? "");
    let mainCond = false;
    if (gsEq(ec2AndOr, "And")) {
      const p1 = gsEq(dy2PipeDef, "Likelihood < 100%") ? (chLike !== null && chLike < 1) : true;
      const p2 = exclRegex ? !exclRegex.test(ciStat) : true;
      mainCond = p1 && p2;
    } else {
      const p1 = gsEq(dy2PipeDef, "Likelihood < 100%") && chLike !== null && chLike < 1;
      const p2 = exclRegex ? !exclRegex.test(ciStat) : false;
      mainCond = p1 || p2;
    }
    const addCond = addExclRegex ? !addExclRegex.test(ciStat) : true;
    return mainCond && addCond;
  });
  writeRect(crmList, 3, 124, duRows, 15); // DU4:EI
  compactGridInPlace(crmList);
}

export function evaluateCRMComp(grids) {
  const crmComp = grids.CRMComp;
  const crmList = grids.CRMList;
  const confCalcs = grids.ConfCalcs;
  const pipeCalcs = grids.PipeCalcs;
  const dataChgAlert = grids.DataChgAlert;
  if (!Array.isArray(crmComp) || !Array.isArray(crmList)) return;

  const today = todaySerial();
  const a2Months = getCell(crmComp, 1, 0); // A2
  const b2Mode = String(getCell(crmComp, 1, 1) || "Pipeline").trim(); // B2 ("Pipeline" or "Confirmed")
  const isConfMode = gsEq(b2Mode, "Confirmed");
  const monthsOffset = gsEq(a2Months, "All") ? -720 : -toNumOrZero(a2Months);
  const c2Start = edateSerial(today, monthsOffset);
  setCell(crmComp, 1, 2, c2Start); // C2

  // L2 = COUNTIFS(PipeCalcs!AL2:AL1001, "<" & EOMONTH(TODAY(), -1)+1, PipeCalcs!AL2:AL1001, ">0", PipeCalcs!AN2:AN1001, ">0", PipeCalcs!DD2:DD1001, "<>Yes")
  const currMonthStart = eomonthSerial(today, -1) + 1;
  let l2Count = 0;
  if (Array.isArray(pipeCalcs)) {
    for (let r = 1; r < pipeCalcs.length && r < 1001; r++) {
      const row = pipeCalcs[r];
      if (!Array.isArray(row)) continue;
      const alStart = toSerialOrNull(row[37]); // AL (col 37)
      const anLike = toNumOrNull(row[39]);     // AN (col 39)
      const ddCopied = String(row[107] ?? ""); // DD (col 107)
      if (alStart !== null && alStart > 0 && alStart < currMonthStart && anLike !== null && anLike > 0 && !gsEq(ddCopied, "Yes")) {
        l2Count++;
      }
    }
  }
  setCell(crmComp, 1, 11, l2Count); // L2

  const keyInfo = grids.KeyInfo;
  const isJobCosting =
    gsEq(String(getCell(keyInfo, 10, 3) || "").trim(), "JobCosting") ||
    !isBlankCell(getCell(crmComp, 4, 66)) ||
    !isBlankCell(getCell(crmComp, 4, 175));

  // Dynamic headers in row 5 that depend on B2
  const dateHeader5 = isConfMode ? "Date conf" : "Date originally added to pipeline";
  setCell(crmComp, 4, 64, dateHeader5);  // BM5
  setCell(crmComp, 4, 125, dateHeader5); // DV5
  setCell(crmComp, 4, 144, isConfMode ? "Date confirmed" : "Date originally added to pipeline"); // EO5
  setCell(crmComp, 4, 173, dateHeader5); // FR5

  if (isJobCosting) {
    // Ensure JobCosting headers in Row 5 (BO, BP, BR and FT, FU, FW, HB, HC)
    if (isBlankCell(getCell(crmComp, 4, 66))) setCell(crmComp, 4, 66, "Date job will start"); // BO5
    if (isBlankCell(getCell(crmComp, 4, 67))) setCell(crmComp, 4, 67, "Date job will end");   // BP5
    if (isBlankCell(getCell(crmComp, 4, 69))) setCell(crmComp, 4, 69, "Job revenue");         // BR5
    if (isBlankCell(getCell(crmComp, 4, 175))) setCell(crmComp, 4, 175, "Date job will start"); // FT5
    if (isBlankCell(getCell(crmComp, 4, 176))) setCell(crmComp, 4, 176, "Date job will end");   // FU5
    if (isBlankCell(getCell(crmComp, 4, 178))) setCell(crmComp, 4, 178, "Job revenue");         // FW5
    if (isBlankCell(getCell(crmComp, 4, 209))) setCell(crmComp, 4, 209, "% likel.");            // HB5
    if (isBlankCell(getCell(crmComp, 4, 210))) setCell(crmComp, 4, 210, "Copied to confirmed tab?"); // HC5

    // Ensure Row 4 Ignore flags on formula columns CP4 (93), CU4 (98), CV4 (99) and mirror CP4:CW4 -> GU4:HB4 (202..209)
    if (isBlankCell(getCell(crmComp, 3, 93))) setCell(crmComp, 3, 93, "Ignore");
    if (isBlankCell(getCell(crmComp, 3, 98))) setCell(crmComp, 3, 98, "Ignore");
    if (isBlankCell(getCell(crmComp, 3, 99))) setCell(crmComp, 3, 99, "Ignore");
    for (let offset = 0; offset < 8; offset++) {
      setCell(crmComp, 3, 202 + offset, getCell(crmComp, 3, 93 + offset));
    }
  }

  const ae4RemBlankEnd = String(getCell(crmComp, 3, 30) || "No").trim(); // AE4
  const ai4RemBlankRev = String(getCell(crmComp, 3, 34) || "No").trim(); // AI4

  const e2On = getCell(crmComp, 1, 4);
  const isOff = e2On === false || gsEq(e2On, "FALSE");

  // Clear formula columns in rows 6..max (preserve BH = col 59 and FM = col 168 checkboxes)
  const maxR = Math.max(crmComp.length - 1, 5);
  clearRect(crmComp, 5, maxR, 0, 57);    // A..BF
  clearRect(crmComp, 5, maxR, 61, 101);  // BJ..CX
  clearRect(crmComp, 5, maxR, 116, 167); // DM..FL
  clearRect(crmComp, 5, maxR, 170, 210); // FO..HC

  if (isOff) return;

  // 1. A6:M (cols 0..12) = CRMList!CA4:CM2003
  const aRows = [];
  for (let r = 3; r < crmList.length && r < 2003; r++) {
    const row = crmList[r];
    if (!Array.isArray(row)) continue;
    const slice = row.slice(78, 91); // CA..CM (13 cols)
    if (slice.every(isBlankCell)) continue;
    const A = slice[0] ?? "";
    const B = slice[1] ?? "";
    const D = slice[3] ?? "";
    const CE = slice[4] ?? "";
    const E = isBlankCell(A) && isBlankCell(B) ? "" : !isBlankCell(D) && isBlankCell(CE) ? 0 : CE;
    aRows.push([A, B, slice[2] ?? "", D, E, ...slice.slice(5, 13)]);
  }
  writeRect(crmComp, 5, 0, aRows, 13);

  // 2. X6:AL (cols 23..37) filtered from CRMList!CZ4:DN5004 (if Confirmed) or CRMList!DU4:EI5004 (if Pipeline)
  const srcStartCol = isConfMode ? 103 : 124; // CZ=103, DU=124
  const srcHeaders = (crmList[2] || []).slice(srcStartCol, srcStartCol + 15);
  const xHeaders = (crmComp[4] || []).slice(23, 38); // X5:AL5
  const xColMap = xHeaders.map((h) => matchInRow0(h, srcHeaders));

  const xRows = [];
  for (let r = 3; r < crmList.length && r < 5004; r++) {
    const row = crmList[r];
    if (!Array.isArray(row)) continue;
    const rev = row[srcStartCol + 3];       // DC or DX (Revenue)
    const startDate = toSerialOrNull(row[srcStartCol + 5]); // DE or DZ (Start date)
    const endDate = row[srcStartCol + 6];   // DF or EA (End date)
    if (startDate === null || startDate < c2Start) continue;
    if (gsEq(ae4RemBlankEnd, "Yes") && isBlankCell(endDate)) continue;
    if (gsEq(ai4RemBlankRev, "Yes") && toNumOrZero(rev) === 0) continue;

    const mapped = xColMap.map((idx) => (idx >= 0 ? (row[srcStartCol + idx] ?? "") : ""));
    if (mapped.every(isBlankCell)) continue;
    xRows.push(mapped);
  }
  writeRect(crmComp, 5, 23, xRows, 15);

  // 3. DM6:DY (cols 116..128) = Dashboard unfiltered by date (ConfCalcs or PipeCalcs where A<>"" or B<>"")
  const dashGrid = isConfMode ? confCalcs : pipeCalcs;
  const dashHeaders = Array.isArray(dashGrid) && dashGrid[0] ? dashGrid[0] : [];
  const dmHeaders = (crmComp[4] || []).slice(116, 129); // DM5:DY5
  const dmColMap = dmHeaders.map((h) => matchInRow0(h, dashHeaders));

  const dmRows = [];
  if (Array.isArray(dashGrid)) {
    const limitR = isConfMode ? 5001 : 1002;
    for (let r = 1; r < dashGrid.length && r < limitR; r++) {
      const row = dashGrid[r];
      if (!Array.isArray(row)) continue;
      if (isBlankCell(row[0]) && isBlankCell(row[1])) continue;
      const mapped = dmColMap.map((idx, cIdx) => {
        if (isConfMode && (cIdx === 7 || cIdx === 8)) return ""; // DT and DU are "" in Confirmed mode
        return idx >= 0 ? (row[idx] ?? "") : "";
      });
      dmRows.push(mapped);
    }
  }
  writeRect(crmComp, 5, 116, dmRows, 13);

  // 4. EF6:ER (cols 135..147) = Dashboard filtered by AL (Start date, col 37) >= C2
  const efHeaders = (crmComp[4] || []).slice(135, 148); // EF5:ER5
  const efColMap = efHeaders.map((h) => matchInRow0(h, dashHeaders));
  const efRows = [];
  if (Array.isArray(dashGrid)) {
    const limitR = isConfMode ? 1001 : 1002;
    for (let r = 1; r < dashGrid.length && r < limitR; r++) {
      const row = dashGrid[r];
      if (!Array.isArray(row)) continue;
      const alStart = toSerialOrNull(row[37]); // AL
      if (alStart === null || alStart < c2Start) continue;
      const mapped = efColMap.map((idx, cIdx) => {
        if (isConfMode && cIdx >= 7 && cIdx <= 11) return ""; // EM..EQ are "" in Confirmed mode
        return idx >= 0 ? (row[idx] ?? "") : "";
      });
      efRows.push(mapped);
    }
  }
  writeRect(crmComp, 5, 135, efRows, 13);

  // Index dmRows by DO (Project code, index 2 in DM..DY)
  const dmByProjCode = new Map();
  for (const dRow of dmRows) {
    const key = String(dRow[2] ?? "").toLowerCase();
    if (key && !dmByProjCode.has(key)) dmByProjCode.set(key, dRow);
  }

  // Helper to check DataChgAlert ignore flags
  const isAlertIgnore = (r0, c0) => gsEq(getCell(dataChgAlert, r0, c0), "Ignore");
  const colIgnore4 = (c0) => gsEq(getCell(crmComp, 3, c0), "Ignore");

  // 5. Left compare AO6:AX (cols 40..49), flags AY6:BF (cols 50..57), actions BJ6:BN (61..65) & CP6:CX (93..101)
  // DM..DY indices: DM=0(Client), DN=1(Job name), DO=2(Project code), DP=3(Rev), DQ=4(DirCosts), DR=5(Start), DS=6(End), DT=7(% likel), DU=8(Copied?), DV=9(Date), DW=10(Lead), DX=11(Proj/Ret), DY=12(VAT?)
  const aoHeaders = (crmComp[4] || []).slice(40, 50); // AO5:AX5
  const aoToDmMap = aoHeaders.map((h) => matchInRow0(h, dmHeaders));

  for (let i = 0; i < xRows.length; i++) {
    const r0 = 5 + i;
    const xRow = xRows[i];
    const [X, Y, Z, AA, AB, AC, AD, AE, , AG, AH, AI, AJ] = xRow;
    const zKey = String(Z ?? "").toLowerCase();
    const matchedDm = zKey ? dmByProjCode.get(zKey) : null;

    const aoRow = aoToDmMap.map((idx) => (matchedDm && idx >= 0 ? (matchedDm[idx] ?? "") : ""));
    const [AO, AP, AQ, AR, AS, AT, AU, AV, , AX] = aoRow;

    const AY = !isBlankCell(Z) && isBlankCell(AO) ? 1 : "";
    const hasAO = !isBlankCell(AO);
    const AZ = hasAO && !gsValEq(AP, X) ? 1 : "";
    const BA = String(AO ?? "").trim() !== "" && !gsEq(String(AQ ?? "").trim(), String(Y ?? "").trim()) ? 1 : "";
    const BB = hasAO && !gsValEq(AR, AA) ? 1 : "";
    const BC = hasAO && !gsValEq(AS, AB) ? 1 : "";
    const BD = hasAO && !gsValEq(AT, AC) ? 1 : "";
    const BE = hasAO && !gsValEq(AU, AD) ? 1 : "";
    const BF = isConfMode ? "" : hasAO && !gsValEq(AV, AE) ? 1 : "";

    writeRect(crmComp, r0, 40, [aoRow], 10);
    writeRect(crmComp, r0, 50, [[AY, AZ, BA, BB, BC, BD, BE, BF]], 8);

    const flagCheck = `${AY}${AZ}${BA}${BB}${BC}${BD}${BE}${BF}`;
    const alertCol0 = isConfMode ? 1 : 4; // B (col 1) for Confirmed, E (col 4) for Pipeline in DataChgAlert!B60 / E60
    if (flagCheck !== "") {
      const BJ = isAlertIgnore(59, alertCol0) ? "<IGNORE>" : X;
      const BK = isAlertIgnore(60, alertCol0) ? "<IGNORE>" : Y;
      const BL = Z;
      const BM = isConfMode ? "" : AI;
      const BN = AH;

      const CP = colIgnore4(93) ? "<IGNORE>" : AA;
      const CQ = (isAlertIgnore(62, alertCol0) || colIgnore4(94)) ? "<IGNORE>" : AB;
      const CR = isBlankCell(CP) ? "" : isBlankCell(AX) ? "Yes" : colIgnore4(95) ? "<IGNORE>" : AX;
      const CS = isBlankCell(CP) ? "" : colIgnore4(96) ? "<IGNORE>" : AG;
      const CT = isBlankCell(CQ) ? "" : colIgnore4(97) ? "<IGNORE>" : AJ;
      const CU = (isAlertIgnore(63, alertCol0) || colIgnore4(98)) ? "<IGNORE>" : AC;
      const CV = (isAlertIgnore(64, alertCol0) || colIgnore4(99)) ? "<IGNORE>" : AD;
      const CW = isConfMode ? "" : (isAlertIgnore(65, alertCol0) || colIgnore4(100)) ? "<IGNORE>" : AE;
      const CX = isConfMode ? (BF === 1 ? "DELETE" : "") : (toNumOrZero(AE) === 1 ? "Yes" : "No");

      writeRect(crmComp, r0, 61, [[BJ, BK, BL, BM, BN]], 5);
      if (isJobCosting || !isBlankCell(getCell(crmComp, 4, 66))) {
        const BO = (isAlertIgnore(63, alertCol0) || colIgnore4(66)) ? "<IGNORE>" : AC;
        const BP = (isAlertIgnore(64, alertCol0) || colIgnore4(67)) ? "<IGNORE>" : AD;
        const BR = colIgnore4(69) ? "<IGNORE>" : AA;
        setCell(crmComp, r0, 66, BO);
        setCell(crmComp, r0, 67, BP);
        setCell(crmComp, r0, 69, BR);
      }
      writeRect(crmComp, r0, 93, [[CP, CQ, CR, CS, CT, CU, CV, CW, CX]], 9);
    } else if (isConfMode && BF === 1) {
      setCell(crmComp, r0, 101, "DELETE");
    }
  }

  // 6. Right compare EU6:FD (cols 150..159), flags FE6:FL (cols 160..167), actions FO6:FS (170..174) & GU6:HA (202..208)
  const aByProjCode = new Map();
  for (const aRow of aRows) {
    const key = String(aRow[2] ?? "").toLowerCase(); // C = Project code
    if (key && !aByProjCode.has(key)) aByProjCode.set(key, aRow);
  }

  const a5Headers = (crmComp[4] || []).slice(0, 10); // A5:J5
  const euHeaders = (crmComp[4] || []).slice(150, 160); // EU5:FD5
  const euToAMap = euHeaders.map((h) => matchInRow0(h, a5Headers));

  // Pre-parse FL6 confirmed logic from CRMList!DD2, DF2, DH2
  const rawLike = String(getCell(crmList, 1, 107) || "");
  const rawIncl = String(getCell(crmList, 1, 109) || "");
  const logicType = String(getCell(crmList, 1, 111) || "Or").trim().toLowerCase();
  const opMatch = (rawLike.match(/[<>=]+/) || [])[0] || "=";
  const rawValMatch = (rawLike.match(/[\d.]+/) || [])[0];
  const likeTargetVal = rawValMatch ? Number(rawValMatch) / (rawLike.includes("%") ? 100 : 1) : 0;
  const flInclRegex = rawIncl.trim() ? new RegExp(rawIncl.trim().toLowerCase().replace(/\s*,\s*/g, "|"), "i") : null;

  for (let i = 0; i < efRows.length; i++) {
    const r0 = 5 + i;
    const efRow = efRows[i];
    // EF=0(Client), EG=1(Job), EH=2(ProjCode), EI=3(Rev), EJ=4(DirCosts), EK=5(Start), EL=6(End), EM=7(% likel), EN=8(Copied?), EO=9(Date), EP=10(Lead), EQ=11(ProdLine), ER=12(VAT?)
    const [EF, EG, EH, EI, EJ, EK, EL, EM, EN, EO, EP, EQ, ER] = efRow;
    const ehKey = String(EH ?? "").toLowerCase();
    const matchedA = ehKey ? aByProjCode.get(ehKey) : null;

    const euRow = euToAMap.map((idx) => (matchedA && idx >= 0 ? (matchedA[idx] ?? "") : ""));
    const [EU, EV, EW, EX, EY, EZ, FA, FB, FC, FD] = euRow;

    const FE = !isBlankCell(EG) && isBlankCell(EU) ? 1 : "";
    const FF = FE === 1 ? "" : !gsValEq(EF, EV) ? 1 : "";
    const FG = FE === 1 ? "" : !gsEq(String(EG ?? "").trim(), String(EW ?? "").trim()) ? 1 : "";
    const FH = FE === 1 ? "" : !gsValEq(EI, EX) ? 1 : "";
    const FI = FE === 1 ? "" : !gsValEq(EJ, EY) ? 1 : "";
    const FJ = FE === 1 ? "" : !gsValEq(EK, EZ) ? 1 : "";
    const FK = FE === 1 ? "" : !gsValEq(EL, FA) ? 1 : "";

    let FL = "";
    let rowIsConf = false;
    if (!isBlankCell(EU)) {
      const fbNum = gsN(toNumOrNull(FB) ?? FB);
      let likeCond = false;
      if (opMatch === "<") likeCond = fbNum < likeTargetVal;
      else if (opMatch === "<=") likeCond = fbNum <= likeTargetVal;
      else if (opMatch === ">") likeCond = fbNum > likeTargetVal;
      else if (opMatch === ">=") likeCond = fbNum >= likeTargetVal;
      else if (opMatch === "=") likeCond = fbNum === likeTargetVal;

      const statCond = flInclRegex ? flInclRegex.test(String(FC ?? "").toLowerCase()) : true;
      rowIsConf = logicType === "or" ? (likeCond || statCond) : (likeCond && statCond);

      if (isConfMode) {
        FL = rowIsConf ? "" : 1;
      } else {
        if (FE === 1) FL = "";
        else if (rowIsConf && !gsEq(EN, "Yes")) FL = 1;
        else if (!rowIsConf && !gsValEq(EM, FB)) FL = 1;
      }
    }

    writeRect(crmComp, r0, 150, [euRow], 10);
    writeRect(crmComp, r0, 160, [[FE, FF, FG, FH, FI, FJ, FK, FL]], 8);

    const rFlagCheck = `${FF}${FG}${FH}${FI}${FJ}${FK}${FL}`;
    const alertCol0 = isConfMode ? 1 : 4; // B (col 1) or E (col 4)
    if (rFlagCheck !== "") {
      const FO = isAlertIgnore(72, alertCol0) ? "<IGNORE>" : EV;
      const FP = isAlertIgnore(73, alertCol0) ? "<IGNORE>" : EW;
      const FQ = EU;
      const FR = isConfMode ? "" : EO;
      const FS = EP;

      const GU = (isAlertIgnore(74, alertCol0) || colIgnore4(202)) ? "<IGNORE>" : EX;
      const GV = (isAlertIgnore(75, alertCol0) || colIgnore4(203)) ? "<IGNORE>" : EY;
      const GW = isBlankCell(GU) ? "" : isBlankCell(ER) ? "Yes" : colIgnore4(204) ? "<IGNORE>" : ER;
      const GX = isBlankCell(GU) ? "" : colIgnore4(205) ? "<IGNORE>" : FD;
      const GY = isBlankCell(GU) ? "" : colIgnore4(206) ? "<IGNORE>" : EQ;
      const GZ = (isAlertIgnore(76, alertCol0) || colIgnore4(207)) ? "<IGNORE>" : EZ;
      const HA = (isAlertIgnore(76, alertCol0) || colIgnore4(208)) ? "<IGNORE>" : FA;

      writeRect(crmComp, r0, 170, [[FO, FP, FQ, FR, FS]], 5);
      if (isJobCosting || !isBlankCell(getCell(crmComp, 4, 175))) {
        const FT = (isAlertIgnore(76, alertCol0) || colIgnore4(175)) ? "<IGNORE>" : EZ;
        const FU = (isAlertIgnore(76, alertCol0) || colIgnore4(176)) ? "<IGNORE>" : FA;
        const fwAlertCol0 = isConfMode ? 4 : 1; // DataChgAlert!E75 in Confirmed, B75 in Pipeline
        const FW = (isAlertIgnore(74, fwAlertCol0) || colIgnore4(178)) ? "<IGNORE>" : EX;
        setCell(crmComp, r0, 175, FT);
        setCell(crmComp, r0, 176, FU);
        setCell(crmComp, r0, 178, FW);
      }
      writeRect(crmComp, r0, 202, [[GU, GV, GW, GX, GY, GZ, HA]], 7);
      if (isJobCosting || !isBlankCell(getCell(crmComp, 4, 209))) {
        const HB = isConfMode ? "" : (isAlertIgnore(78, 4) || colIgnore4(209)) ? "<IGNORE>" : FB;
        setCell(crmComp, r0, 209, HB);
      }
      if (isJobCosting || !isBlankCell(getCell(crmComp, 4, 210))) {
        const HC = isConfMode ? (FL === 1 ? "DELETE" : "") : (isBlankCell(FB) ? "" : (rowIsConf ? "Yes" : "No"));
        setCell(crmComp, r0, 210, HC);
      }
    } else if (isConfMode && FL === 1 && (isJobCosting || !isBlankCell(getCell(crmComp, 4, 210)))) {
      setCell(crmComp, r0, 210, "DELETE");
    }
  }
  const activeCrmRows = Math.max(5, 5 + aRows.length, 5 + xRows.length, 5 + dmRows.length, 5 + efRows.length);
  if (crmComp.length > activeCrmRows) crmComp.length = activeCrmRows;
  compactGridInPlace(crmComp);
}

// ============================================================================
// 5. KeyInfo & PLComp
// ============================================================================

export function evaluateKeyInfoAndPLComp(grids) {
  const keyInfo = grids.KeyInfo;
  const plComp = grids.PLComp;
  const plFromApp = grids.PLFromApp;
  const plAdds = grids.PLAdds;
  const year0PL = grids.Year0PLFromApp;
  const crmList = grids.CRMList;
  if (!Array.isArray(keyInfo)) return;

  // KeyInfo!E21 (Product lines missing from E23:E75 vs CRMList!AN4:AN5004)
  // KeyInfo!I29 (Lead sources missing from I32:I75 vs CRMList!AL4:AL5004)
  if (Array.isArray(crmList)) {
    const evalMissingCrmMapping = (kiStartR0, kiEndR0, kiCol0, crmCol0) => {
      const currentSet = new Set();
      for (let r0 = kiStartR0; r0 <= kiEndR0 && r0 < keyInfo.length; r0++) {
        const v = getCell(keyInfo, r0, kiCol0);
        if (!isBlankCell(v)) currentSet.add(String(v).trim().toLowerCase());
      }
      const seenMaster = new Set();
      const missingVals = [];
      const maxCrmR0 = Math.min(crmList.length - 1, 5003);
      for (let r0 = 3; r0 <= maxCrmR0; r0++) {
        const v = getCell(crmList, r0, crmCol0);
        if (isBlankCell(v)) continue;
        const rawStr = String(v).trim();
        if (!rawStr) continue;
        const lower = rawStr.toLowerCase();
        if (seenMaster.has(lower)) continue;
        seenMaster.add(lower);
        if (!currentSet.has(lower)) {
          missingVals.push(rawStr);
        }
      }
      return missingVals.length > 0
        ? `${missingVals.length} missing: ${missingVals.join(", ")}`
        : "0 missing";
    };

    setCell(keyInfo, 20, 4, evalMissingCrmMapping(22, 74, 4, 39)); // E21: E23:E75 vs CRMList!AN4:AN5004
    setCell(keyInfo, 28, 8, evalMissingCrmMapping(31, 74, 8, 37)); // I29: I32:I75 vs CRMList!AL4:AL5004
  }

  // KeyInfo!O6 = COUNTA(G5:G104) (only if O6 is used on this KeyInfo grid)
  if (!isBlankCell(getCell(keyInfo, 5, 14))) {
    let gCount = 0;
    for (let r = 4; r <= 103 && r < keyInfo.length; r++) {
      if (!isBlankCell(getCell(keyInfo, r, 6))) gCount++;
    }
    setCell(keyInfo, 5, 14, gCount); // O6
  }

  // KeyInfo!BE2 = UNIQUE(FILTER({Year0PLFromApp!A:A; PLFromApp!A:A}, <> "", <> 0, <> "0"))
  const seenCats = new Set();
  const uniqueCats = [];
  for (const srcGrid of [year0PL, plFromApp]) {
    if (!Array.isArray(srcGrid)) continue;
    for (let r = 0; r < srcGrid.length; r++) {
      const v = getCell(srcGrid, r, 0);
      if (isBlankCell(v) || v === 0 || v === "0") continue;
      const key = String(v).trim().toLowerCase();
      if (!seenCats.has(key)) {
        seenCats.add(key);
        uniqueCats.push([v]);
      }
    }
  }
  clearRect(keyInfo, 1, Math.max(keyInfo.length - 1, 200), 56, 56); // BE
  writeRect(keyInfo, 1, 56, uniqueCats, 1);

  if (!Array.isArray(plComp) || !Array.isArray(plFromApp)) return;

  // PLComp Row 1: F1:K1 (cols 5..10), M1:R1 (cols 12..17), T1:Y1 (cols 19..24) = PLFromApp!H1:M1 (cols 7..12)
  for (let i = 0; i < 6; i++) {
    const mHdr = getCell(plFromApp, 0, 7 + i);
    setCell(plComp, 0, 5 + i, mHdr);
    setCell(plComp, 0, 12 + i, mHdr);
    setCell(plComp, 0, 19 + i, mHdr);
  }

  // Helper to lookup [catName, monthHeader] in PLFromApp or PLAdds
  const lookupMatrix = (matrixGrid, catName, monthHdr) => {
    if (isBlankCell(catName) || isBlankCell(monthHdr) || !Array.isArray(matrixGrid) || !matrixGrid[0]) return "";
    const colIdx = matchInRow0(monthHdr, matrixGrid[0]);
    if (colIdx < 0) return "";
    for (let r = 0; r < matrixGrid.length; r++) {
      if (gsValEq(getCell(matrixGrid, r, 0), catName)) {
        return getCell(matrixGrid, r, colIdx);
      }
    }
    return "";
  };

  // Detect whether PLComp uses 4-block staff layout (Salaries 2..4 sum 5, NICs 6..8 sum 9, Pension 10..12 sum 13, Contractors 14..20 sum 21)
  // vs 2-block layout (CoS staff costs 2..11 sum 12, Non-CoS staff costs 13..20 sum 21)
  const isFourBlockStaff =
    gsEq(getCell(plComp, 5, 0), "NICs") ||
    gsEq(getCell(plComp, 4, 4), "Salaries total");
  const staffTotalRows1 = isFourBlockStaff ? new Set([5, 9, 13, 21]) : new Set([12, 21]);

  // Detect whether PLComp!B is mapped from KeyInfo!BA (modern layout: A81="Sales"/"Revenue" and/or A98="Ignore")
  // vs legacy static PLComp!B (where A81="Ignore")
  const usesKeyInfoBAMapping =
    !gsEq(getCell(plComp, 80, 0), "Ignore") ||
    gsEq(getCell(plComp, 97, 0), "Ignore");

  if (usesKeyInfoBAMapping) {
    const bKeyInfoMap = [
      { plStart: 2, plEnd: 11, kiStart: 19 },    // B2:B11 = KeyInfo!BA19:BA28
      { plStart: 13, plEnd: 20, kiStart: 35 },   // B13:B20 = KeyInfo!BA35:BA42
      { plStart: 22, plEnd: 24, kiStart: 50 },   // B22:B24 = KeyInfo!BA50:BA52
      { plStart: 26, plEnd: 28, kiStart: 54 },   // B26:B28 = KeyInfo!BA54:BA56
      { plStart: 30, plEnd: 47, kiStart: 59 },   // B30:B47 = KeyInfo!BA59:BA76
      { plStart: 52, plEnd: 63, kiStart: 81 },   // B52:B63 = KeyInfo!BA81:BA92
      { plStart: 65, plEnd: 74, kiStart: 101 },  // B65:B74 = KeyInfo!BA101:BA110
      { plStart: 81, plEnd: 96, kiStart: 2 },    // B81:B96 = KeyInfo!BA2:BA17
      { plStart: 98, plEnd: 179, kiStart: 128 }, // B98:B179 = KeyInfo!BA128:BA209
    ];
    for (const blk of bKeyInfoMap) {
      for (let r1 = blk.plStart; r1 <= blk.plEnd; r1++) {
        const kiR1 = blk.kiStart + (r1 - blk.plStart);
        const val = getCell(keyInfo, kiR1 - 1, 52); // BA is col 52
        setCell(plComp, r1 - 1, 1, val); // B
        if (r1 <= 74 && r1 !== 62 && r1 !== 63 && !staffTotalRows1.has(r1)) {
          setCell(plComp, r1 - 1, 4, val); // E = B
        }
      }
    }
  } else {
    // Legacy static PLComp!B: sync E = B on category rows 2..74
    const skipERows1 = new Set([5, 9, 12, 13, 21, 25, 29, 50, 51, 62, 63, 64, 75]);
    for (let r1 = 2; r1 <= 74; r1++) {
      if (!skipERows1.has(r1) && !staffTotalRows1.has(r1)) {
        setCell(plComp, r1 - 1, 4, getCell(plComp, r1 - 1, 1));
      }
    }
  }

  // E89:E597 = FILTER(PLFromApp!A:A, PLFromApp!A:A<>"", ISNA(XMATCH(PLFromApp!A:A, B:B, 0, 1)))
  const usedBSet = new Set();
  for (let r0 = 0; r0 < plComp.length; r0++) {
    const bVal = getCell(plComp, r0, 1);
    if (!isBlankCell(bVal)) usedBSet.add(String(bVal).trim().toLowerCase());
  }
  const unmappedCats = [];
  for (let r0 = 0; r0 < plFromApp.length; r0++) {
    const aVal = getCell(plFromApp, r0, 0);
    if (isBlankCell(aVal)) continue;
    if (!usedBSet.has(String(aVal).trim().toLowerCase())) {
      unmappedCats.push(aVal);
    }
  }
  for (let r0 = 88; r0 < Math.max(plComp.length, 88 + unmappedCats.length); r0++) {
    setCell(plComp, r0, 4, unmappedCats[r0 - 88] ?? "");
  }

  // Evaluate standard PLFromApp lookup rows
  const simpleBlocks = isFourBlockStaff
    ? [
      [2, 4, 5],
      [6, 8, 9],
      [10, 12, 13],
      [14, 20, 21],
      [22, 24, 25],
      [52, 61, 62],
      [65, 74, 75],
    ]
    : [
      [2, 11, 12],
      [13, 20, 21],
      [22, 24, 25],
      [52, 61, 62],
      [65, 74, 75],
    ];
  for (const [s1, e1, sum1] of simpleBlocks) {
    const sums = [0, 0, 0, 0, 0, 0];
    for (let r1 = s1; r1 <= e1; r1++) {
      const cat = getCell(plComp, r1 - 1, 1); // B
      for (let m = 0; m < 6; m++) {
        const hdr = getCell(plComp, 0, 5 + m);
        const v = lookupMatrix(plFromApp, cat, hdr);
        setCell(plComp, r1 - 1, 5 + m, v);
        sums[m] += toNumOrZero(v);
      }
    }
    for (let m = 0; m < 6; m++) {
      setCell(plComp, sum1 - 1, 5 + m, sums[m]);
    }
  }

  // Evaluate PLFromApp + PLAdds rows: 26..28 (sum 29), 30..49 (sum 50), 89..max (sum 83)
  const evaluateDualRow = (r0, catCol0) => {
    const cat = getCell(plComp, r0, catCol0);
    for (let m = 0; m < 6; m++) {
      const hdr = getCell(plComp, 0, 5 + m);
      const fVal = lookupMatrix(plFromApp, cat, hdr);
      const mVal = lookupMatrix(plAdds, cat, hdr);
      setCell(plComp, r0, 5 + m, fVal);
      setCell(plComp, r0, 12 + m, mVal);
      const hasAny = !isBlankCell(fVal) || !isBlankCell(mVal);
      setCell(plComp, r0, 19 + m, hasAny ? toNumOrZero(fVal) + toNumOrZero(mVal) : 0);
    }
  };

  for (let r1 = 26; r1 <= 28; r1++) evaluateDualRow(r1 - 1, 1);
  const a28Mode = getCell(plComp, 27, 0); // A28
  const a29Fallback = getCell(plComp, 28, 0); // A29
  for (const colStart of [5, 12, 19]) {
    for (let m = 0; m < 6; m++) {
      const c0 = colStart + m;
      if (gsEq(a28Mode, "As-Is")) {
        const s = toNumOrZero(getCell(plComp, 25, c0)) + toNumOrZero(getCell(plComp, 26, c0)) + toNumOrZero(getCell(plComp, 27, c0));
        setCell(plComp, 28, c0, s);
      } else {
        setCell(plComp, 28, c0, a29Fallback);
      }
    }
  }

  for (let r1 = 30; r1 <= 49; r1++) evaluateDualRow(r1 - 1, 1);
  for (const colStart of [5, 12, 19]) {
    for (let m = 0; m < 6; m++) {
      const c0 = colStart + m;
      let s = 0;
      for (let r1 = 30; r1 <= 49; r1++) s += toNumOrZero(getCell(plComp, r1 - 1, c0));
      setCell(plComp, 49, c0, s); // Row 50
    }
  }

  const maxUnmappedR1 = Math.max(89 + unmappedCats.length - 1, plComp.length, 180);
  for (let r1 = 89; r1 <= maxUnmappedR1; r1++) {
    evaluateDualRow(r1 - 1, 4); // Lookup by E
  }
  for (const colStart of [5, 12, 19]) {
    for (let m = 0; m < 6; m++) {
      const c0 = colStart + m;
      let s = 0;
      for (let r1 = 89; r1 <= maxUnmappedR1; r1++) s += toNumOrZero(getCell(plComp, r1 - 1, c0));
      setCell(plComp, 82, c0, s); // Row 83
    }
  }

  // Row 84 & Row 85
  for (let m = 0; m < 6; m++) {
    setCell(plComp, 83, 5 + m, toNumOrZero(getCell(plComp, 82, 5 + m)) + toNumOrZero(getCell(plComp, 28, 5 + m)));
    const totAdds = lookupMatrix(plAdds, "[Total for month]", getCell(plComp, 0, 12 + m));
    setCell(plComp, 83, 12 + m, totAdds);
    setCell(plComp, 83, 19 + m, toNumOrZero(getCell(plComp, 82, 19 + m)) + toNumOrZero(getCell(plComp, 28, 19 + m)));
    setCell(plComp, 84, 12 + m, toNumOrZero(totAdds) - toNumOrZero(getCell(plComp, 82, 12 + m)));
  }
  compactGridInPlace(keyInfo);
  compactGridInPlace(plComp);
}

/**
 * Evaluates all Master Sheet formula pipelines in dependency order.
 */
export function evaluateAllMasterFormulas(grids, options = {}) {
  const { onlyTabs = null } = options;
  const shouldRun = (t) => !onlyTabs || onlyTabs.includes(t);

  if (shouldRun("Outgoings")) evaluateOutgoingsMasterTab(grids);
  if (shouldRun("InvAppList") || shouldRun("InvComp")) evaluateInvAppList(grids);
  if (shouldRun("InvDashList") || shouldRun("InvComp")) evaluateInvDashList(grids);
  if (shouldRun("InvComp")) evaluateInvComp(grids);

  if (shouldRun("JnlAppList") || shouldRun("DirComp")) evaluateJnlAppList(grids);
  if (shouldRun("DirDashList") || shouldRun("DirComp")) evaluateDirDashList(grids);
  if (shouldRun("DirComp")) evaluateDirComp(grids);

  if (shouldRun("CRMList") || shouldRun("CRMComp")) evaluateCRMList(grids);
  if (shouldRun("CRMComp")) evaluateCRMComp(grids);

  if (shouldRun("KeyInfo") || shouldRun("PLComp")) evaluateKeyInfoAndPLComp(grids);

  for (const tName of [
    "InvAppList",
    "InvDashList",
    "InvComp",
    "JnlAppList",
    "DirDashList",
    "DirComp",
    "CRMList",
    "CRMComp",
    "PLComp",
    "KeyInfo",
  ]) {
    if (grids[tName]) compactGridInPlace(grids[tName]);
  }
}
