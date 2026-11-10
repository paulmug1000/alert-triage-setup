//Version 1.04 - Dependency pruning (Budget, Year0Data, Monthly unaffected cols, onlyTabs fast-path)
// Evaluates all 32 Client Sheet tabs with 1:1 Google Sheets formula parity.

const ERROR_PREFIXES = ["#REF!", "#N/A", "#VALUE!", "#DIV/0!", "#NUM!", "#NAME?", "#ERROR!"];

class SheetError {
  constructor(code, message = "") {
    this.code = code || "#ERROR!";
    this.message = message;
  }
  toString() {
    return this.message ? `${this.code} (${this.message})` : this.code;
  }
}

function isSheetError(val) {
  if (val instanceof SheetError) return true;
  if (typeof val === "string") {
    for (let i = 0; i < ERROR_PREFIXES.length; i++) {
      if (val.startsWith(ERROR_PREFIXES[i])) return true;
    }
  }
  return false;
}

function isNaError(val) {
  if (val instanceof SheetError) return val.code === "#N/A";
  if (typeof val === "string") return val.startsWith("#N/A");
  return false;
}

function toErrorObject(val) {
  if (val instanceof SheetError) return val;
  if (typeof val === "string") {
    for (const p of ERROR_PREFIXES) {
      if (val.startsWith(p)) return new SheetError(p, val.slice(p.length).trim().replace(/^\(|\)$/g, ""));
    }
  }
  return new SheetError("#ERROR!", String(val || ""));
}

// ============================================================================
// DATE SERIAL HELPERS (Lotus / Google Sheets epoch: 1899-12-30 UTC = 0)
// ============================================================================

const MS_PER_DAY = 86400000;
const EPOCH_OFFSET_DAYS = 25569; // days between 1899-12-30 and 1970-01-01

function serialToUTCDate(serial) {
  const days = Math.floor(Number(serial));
  return new Date(Math.round((days - EPOCH_OFFSET_DAYS) * MS_PER_DAY));
}

function utcDateToSerial(year, month1, day) {
  const ms = Date.UTC(year, month1 - 1, day);
  return Math.round(ms / MS_PER_DAY) + EPOCH_OFFSET_DAYS;
}

function serialToYMD(serial) {
  const d = serialToUTCDate(serial);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

function eomonthSerial(startSerial, monthsOffset) {
  const s = toNumberStrict(startSerial);
  const mOff = Math.trunc(toNumberStrict(monthsOffset));
  const [y, m] = serialToYMD(s);
  // Day 0 of (m + mOff + 1) is last day of target month
  const d = new Date(Date.UTC(y, m - 1 + mOff + 1, 0));
  return Math.round(d.getTime() / MS_PER_DAY) + EPOCH_OFFSET_DAYS;
}

function edateSerial(startSerial, monthsOffset) {
  const s = toNumberStrict(startSerial);
  const mOff = Math.trunc(toNumberStrict(monthsOffset));
  const [y, m, day] = serialToYMD(s);
  const targetLastDay = new Date(Date.UTC(y, m - 1 + mOff + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, targetLastDay);
  return utcDateToSerial(y, m + mOff, clampedDay);
}

function datedifSerial(sRaw, eRaw, unitRaw) {
  const s = Math.floor(toNumberStrict(sRaw));
  const e = Math.floor(toNumberStrict(eRaw));
  if (s > e) throw new SheetError("#NUM!", "DATEDIF start > end");
  const [y1, m1, d1] = serialToYMD(s);
  const [y2, m2, d2] = serialToYMD(e);
  const u = String(unitRaw ?? "").toLowerCase().trim();
  if (u === "d") return e - s;
  if (u === "m") {
    let m = (y2 - y1) * 12 + (m2 - m1);
    if (d2 < d1) m--;
    return m;
  }
  if (u === "y") {
    let y = y2 - y1;
    if (m2 < m1 || (m2 === m1 && d2 < d1)) y--;
    return y;
  }
  if (u === "md") {
    if (d2 >= d1) return d2 - d1;
    const prevMonthStartWithD1 = new Date(Date.UTC(y2, m2 - 2, d1));
    const endDate = new Date(Date.UTC(y2, m2 - 1, d2));
    return Math.round((endDate.getTime() - prevMonthStartWithD1.getTime()) / MS_PER_DAY);
  }
  if (u === "ym") {
    let m = m2 - m1;
    if (d2 < d1) m--;
    if (m < 0) m += 12;
    return m;
  }
  throw new SheetError("#NUM!", `Unknown DATEDIF unit ${u}`);
}

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function parseDateValueString(str) {
  if (typeof str === "number" && Number.isFinite(str)) return Math.floor(str);
  const s = String(str ?? "").trim();
  if (!s) throw new SheetError("#VALUE!", "Empty DATEVALUE");
  // Match D-MMM-YY or DD-MMM-YYYY or D MMM YY
  const m1 = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,9})[-\/\s](\d{2,4})$/);
  if (m1) {
    const day = parseInt(m1[1], 10);
    const monStr = m1[2].slice(0, 3).toLowerCase();
    const monIdx = MONTH_NAMES_SHORT.findIndex((x) => x.toLowerCase() === monStr);
    if (monIdx >= 0) {
      let yr = parseInt(m1[3], 10);
      if (yr < 100) yr += yr < 50 ? 2000 : 1900;
      return utcDateToSerial(yr, monIdx + 1, day);
    }
  }
  // Match MMM-YY (e.g. "Nov-26" -> parsed by Google Sheets VALUE("Nov-26") in 2026 as Month=Nov, Day=26, Year=2026)
  const mMonDay = s.match(/^([A-Za-z]{3})[-\/\s](\d{1,2})$/);
  if (mMonDay) {
    const monStr = mMonDay[1].slice(0, 3).toLowerCase();
    const monIdx = MONTH_NAMES_SHORT.findIndex((x) => x.toLowerCase() === monStr);
    if (monIdx >= 0) {
      const day = parseInt(mMonDay[2], 10);
      return utcDateToSerial(2026, monIdx + 1, day);
    }
  }
  // Match YYYY-MM-DD
  const m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m2) {
    return utcDateToSerial(parseInt(m2[1], 10), parseInt(m2[2], 10), parseInt(m2[3], 10));
  }
  // Match DD/MM/YYYY
  const m3 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m3) {
    let yr = parseInt(m3[3], 10);
    if (yr < 100) yr += yr < 50 ? 2000 : 1900;
    return utcDateToSerial(yr, parseInt(m3[2], 10), parseInt(m3[1], 10));
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return utcDateToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  throw new SheetError("#VALUE!", `Cannot parse date: ${s}`);
}

function formatTextFunction(val, fmtRaw) {
  if (isSheetError(val)) throw toErrorObject(val);
  const fmt = String(fmtRaw ?? "");
  const lowerFmt = fmt.toLowerCase();

  // Check if date format (mmm-yy, d-mmm-yy, mmmm yyyy, etc.)
  if (/[dmy]/i.test(lowerFmt) && !/[#0%]/.test(lowerFmt)) {
    const num = toNumberStrict(val);
    const [y, m, d] = serialToYMD(num);
    const yy = String(y).slice(-2);
    const mmm = MONTH_NAMES_SHORT[m - 1] || "";
    const mmmm = MONTH_NAMES_FULL[m - 1] || "";
    if (lowerFmt === "mmm-yy") return `${mmm}-${yy}`;
    if (lowerFmt === "d-mmm-yy") return `${d}-${mmm}-${yy}`;
    if (lowerFmt === "dd-mmm-yy") return `${String(d).padStart(2, "0")}-${mmm}-${yy}`;
    if (lowerFmt === "mmm yy") return `${mmm} ${yy}`;
    if (lowerFmt === "mmmm yyyy") return `${mmmm} ${y}`;
    return `${d}-${mmm}-${yy}`;
  }

  // Percentage format e.g. "0%", "0.0%"
  if (fmt.includes("%")) {
    const num = toNumberOrZero(val) * 100;
    const decMatch = fmt.match(/\.([0#]+)/);
    const decimals = decMatch ? decMatch[1].length : 0;
    return `${roundHalfAwayFromZero(num, decimals).toFixed(decimals)}%`;
  }

  // Currency / number format e.g. "£#,##0", "$#,##0.00", "#,##0"
  const num = toNumberOrZero(val);
  const decMatch = fmt.match(/\.([0#]+)/);
  const decimals = decMatch ? decMatch[1].length : 0;
  const useGrouping = fmt.includes(",");
  const prefixMatch = fmt.match(/^([^#0,\.\-]+)/);
  const prefix = prefixMatch ? prefixMatch[1] : "";
  const absVal = Math.abs(roundHalfAwayFromZero(num, decimals));
  const parts = absVal.toFixed(decimals).split(".");
  if (useGrouping) {
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  const formattedNum = parts.join(".");
  return num < 0 ? `-${prefix}${formattedNum}` : `${prefix}${formattedNum}`;
}

function roundHalfAwayFromZero(num, decimals = 0) {
  const n = Number(num);
  if (!Number.isFinite(n)) return 0;
  const factor = Math.pow(10, decimals);
  // Add tiny epsilon to avoid IEEE 754 float boundary issues like 1.005 * 100 = 100.49999999999999
  const scaled = Math.abs(n) * factor + 1e-12;
  const rounded = Math.floor(scaled + 0.5) / factor;
  return n < 0 ? -rounded : rounded;
}

// ============================================================================
// TYPE COERCION HELPERS
// ============================================================================

function isBlankVal(v) {
  return v === null || v === undefined || v === "";
}

function toNumberOrZero(v) {
  if (isSheetError(v)) throw toErrorObject(v);
  if (v === null || v === undefined || v === "" || v === false) return 0;
  if (v === true) return 1;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  const cleaned = s.replace(/^[£$€\s]+/, "").replace(/,/g, "");
  if (/^-?\d+(\.\d+)?%$/.test(cleaned)) return parseFloat(cleaned) / 100;
  const n = Number(cleaned);
  if (Number.isFinite(n)) return n;
  if (/^\d{1,2}[-\/\s][A-Za-z]{3}/.test(s) || /^[A-Za-z]{3}[-\/\s]\d{1,2}$/.test(s)) {
    return parseDateValueString(s);
  }
  throw new SheetError("#VALUE!", `Cannot coerce '${s}' to number`);
}

function toNumberStrict(v) {
  if (isSheetError(v)) throw toErrorObject(v);
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const rawS = String(v).trim();
  const s = rawS.replace(/^[£$€\s]+/, "").replace(/,/g, "");
  if (!s) throw new SheetError("#VALUE!", "Empty string in numeric conversion");
  if (/^-?\d+(\.\d+)?%$/.test(s)) return parseFloat(s) / 100;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  if (/^\d{1,2}[-\/\s][A-Za-z]{3}/.test(rawS) || /^[A-Za-z]{3}[-\/\s]\d{1,2}$/.test(rawS)) {
    return parseDateValueString(rawS);
  }
  throw new SheetError("#VALUE!", `Cannot convert '${rawS}' to number`);
}

function toBoolean(v) {
  if (isSheetError(v)) throw toErrorObject(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === null || v === undefined || v === "") return false;
  const s = String(v).trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  const n = Number(s);
  if (!Number.isNaN(n)) return n !== 0;
  return false;
}

function toStringVal(v, contextHint = null) {
  if (isSheetError(v)) throw toErrorObject(v);
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    // Special Google Sheets formatted-text coercions when TO_TEXT or RIGHT is applied to a date serial cell:
    if (contextHint === "TO_TEXT_OUTGNOTES_DATE" && v >= 35000 && v <= 65000) {
      const [y, m, d] = serialToYMD(v);
      return `${d}-${MONTH_NAMES_SHORT[m - 1]}-${String(y).slice(-2)}`;
    }
    if (contextHint === "HEADER_DATE_RIGHT" && v >= 35000 && v <= 65000) {
      const [y, m] = serialToYMD(v);
      return `${MONTH_NAMES_SHORT[m - 1]} ${String(y).slice(-2)}`;
    }
    return String(v);
  }
  return String(v);
}

// Google Sheets comparison semantics:
// - null / undefined represents a genuinely BLANK cell (which equals "" and 0, and compares as 0 against numbers).
// - "" represents a zero-length STRING (which equals "" and null, but is GREATER than any number in <, <=, >, >=).
// - Strings are compared case-insensitively.
// - Type rank for <, <=, >, >= when neither operand is null: Number (1) < String (2) < Boolean (3).
function compareSheetValues(a, b, op) {
  if (isSheetError(a)) throw toErrorObject(a);
  if (isSheetError(b)) throw toErrorObject(b);

  const aIsNull = a === null || a === undefined;
  const bIsNull = b === null || b === undefined;

  if (op === "=" || op === "<>") {
    let eq = false;
    if (aIsNull && bIsNull) {
      eq = true;
    } else if (aIsNull) {
      eq = b === "" || b === 0 || b === false;
    } else if (bIsNull) {
      eq = a === "" || a === 0 || a === false;
    } else if (typeof a === "number" && typeof b === "number") {
      eq = Math.abs(a - b) <= 1e-11;
    } else if (typeof a === "string" && typeof b === "string") {
      eq = a.toLowerCase() === b.toLowerCase();
    } else if (typeof a === "boolean" && typeof b === "boolean") {
      eq = a === b;
    } else {
      eq = false;
    }
    return op === "=" ? eq : !eq;
  }

  // Relational operators: <, <=, >, >=
  // If one side is null (blank cell), coerce null to 0 against number, "" against string, false against boolean
  let va = a;
  let vb = b;
  if (aIsNull && bIsNull) {
    va = 0;
    vb = 0;
  } else if (aIsNull) {
    if (typeof vb === "number") va = 0;
    else if (typeof vb === "string") va = "";
    else if (typeof vb === "boolean") va = false;
    else va = 0;
  } else if (bIsNull) {
    if (typeof va === "number") vb = 0;
    else if (typeof va === "string") vb = "";
    else if (typeof va === "boolean") vb = false;
    else vb = 0;
  }

  const rank = (x) => (typeof x === "number" ? 1 : typeof x === "string" ? 2 : 3);
  const ra = rank(va);
  const rb = rank(vb);
  let cmp = 0;
  if (ra !== rb) {
    cmp = ra - rb;
  } else if (ra === 1) {
    cmp = Math.abs(va - vb) <= 1e-11 ? 0 : va < vb ? -1 : 1;
  } else if (ra === 2) {
    const sa = va.toLowerCase();
    const sb = vb.toLowerCase();
    cmp = sa === sb ? 0 : sa < sb ? -1 : 1;
  } else {
    cmp = va === vb ? 0 : va ? 1 : -1;
  }

  if (op === "<") return cmp < 0;
  if (op === "<=") return cmp <= 0;
  if (op === ">") return cmp > 0;
  if (op === ">=") return cmp >= 0;
  return false;
}

// ============================================================================
// A1 COORDINATE PARSING & FORMATTING
// ============================================================================

function colLettersToIndex(letters) {
  let n = 0;
  const u = letters.toUpperCase();
  for (let i = 0; i < u.length; i++) {
    n = n * 26 + (u.charCodeAt(i) - 64);
  }
  return n - 1;
}

function colIndexToLetters(c0) {
  let n = c0 + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ============================================================================
// FORMULA TOKENIZER & AST PARSER (CACHED BY FORMULA STRING)
// ============================================================================

const astCache = new Map();

function tokenizeFormula(src) {
  const tokens = [];
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }

    // String literal
    if (ch === '"') {
      let s = "";
      i++;
      while (i < len) {
        if (src[i] === '"') {
          if (i + 1 < len && src[i + 1] === '"') {
            s += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          s += src[i++];
        }
      }
      tokens.push({ type: "STRING", value: s });
      continue;
    }

    // Error literal (#REF!, #N/A, #VALUE!, #DIV/0!, #NUM!, #NAME?, #ERROR!)
    if (ch === "#") {
      let matchedErr = null;
      for (const p of ERROR_PREFIXES) {
        if (src.slice(i, i + p.length).toUpperCase() === p) {
          matchedErr = p;
          break;
        }
      }
      if (matchedErr) {
        tokens.push({ type: "ERROR", value: matchedErr });
        i += matchedErr.length;
        continue;
      }
    }

    // Two-char operators
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      tokens.push({ type: "OP", value: two });
      i += 2;
      continue;
    }

    // Single-char operators & punctuation
    if ("+-*/^%&=<>(),;:{}".includes(ch)) {
      tokens.push({ type: ch === "(" || ch === ")" || ch === "," || ch === ";" || ch === "{" || ch === "}" ? ch : "OP", value: ch });
      i++;
      continue;
    }

    // Quoted sheet name in reference: 'Sheet Name'!A1
    if (ch === "'") {
      let sheet = "";
      i++;
      while (i < len) {
        if (src[i] === "'") {
          if (i + 1 < len && src[i + 1] === "'") {
            sheet += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          sheet += src[i++];
        }
      }
      if (src[i] === "!") {
        i++;
        tokens.push({ type: "SHEET_PREFIX", value: sheet });
        continue;
      }
      tokens.push({ type: "STRING", value: sheet });
      continue;
    }

    // Number literal (only if not followed immediately by ! or : like 1:1 row range)
    if ((ch >= "0" && ch <= "9") || (ch === "." && i + 1 < len && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      let j = i;
      while (j < len && src[j] >= "0" && src[j] <= "9") j++;
      if (j < len && src[j] === ":") {
        // Row-only reference e.g. 1:1
        tokens.push({ type: "IDENT", value: src.slice(i, j) });
        i = j;
        continue;
      }
      if (j < len && src[j] === ".") {
        j++;
        while (j < len && src[j] >= "0" && src[j] <= "9") j++;
      }
      if (j < len && (src[j] === "e" || src[j] === "E")) {
        let k = j + 1;
        if (k < len && (src[k] === "+" || src[k] === "-")) k++;
        if (k < len && src[k] >= "0" && src[k] <= "9") {
          j = k;
          while (j < len && src[j] >= "0" && src[j] <= "9") j++;
        }
      }
      tokens.push({ type: "NUMBER", value: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }

    // Identifier, Cell Reference, or Sheet Prefix (UnquotedSheet!...)
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i;
      while (j < len && /[A-Za-z0-9_$.]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (j < len && src[j] === "!") {
        tokens.push({ type: "SHEET_PREFIX", value: word });
        i = j + 1;
        continue;
      }
      tokens.push({ type: "IDENT", value: word });
      i = j;
      continue;
    }

    // Fallback skip unknown character
    i++;
  }

  return tokens;
}

function parseCoordToken(ident) {
  const s = String(ident);
  // Standard cell ref: $A$1, A1, $BC12
  const mCell = s.match(/^\$?([A-Za-z]{1,3})\$?(\d+)$/);
  if (mCell) {
    return {
      kind: "cell",
      col: colLettersToIndex(mCell[1]),
      row: parseInt(mCell[2], 10) - 1,
    };
  }
  // Whole-column ref: $A, A
  const mCol = s.match(/^\$?([A-Za-z]{1,3})$/);
  if (mCol) {
    return {
      kind: "col",
      col: colLettersToIndex(mCol[1]),
    };
  }
  // Whole-row ref: $1, 1
  const mRow = s.match(/^\$?(\d+)$/);
  if (mRow) {
    return {
      kind: "row",
      row: parseInt(mRow[1], 10) - 1,
    };
  }
  return null;
}

function parseFormulaToAST(formulaStr) {
  const raw = String(formulaStr).startsWith("=") ? String(formulaStr).slice(1).trim() : String(formulaStr).trim();
  if (astCache.has(raw)) return astCache.get(raw);

  const tokens = tokenizeFormula(raw);
  let pos = 0;

  function peek(offset = 0) {
    return tokens[pos + offset] || null;
  }
  function consume() {
    return tokens[pos++] || null;
  }

  function parseExpr() {
    return parseComparison();
  }

  function parseComparison() {
    let left = parseConcat();
    while (peek() && peek().type === "OP" && ["=", "<>", "<", "<=", ">", ">="].includes(peek().value)) {
      const op = consume().value;
      const right = parseConcat();
      left = { type: "BinaryOp", op, left, right };
    }
    return left;
  }

  function parseConcat() {
    let left = parseAddSub();
    while (peek() && peek().type === "OP" && peek().value === "&") {
      consume();
      const right = parseAddSub();
      left = { type: "BinaryOp", op: "&", left, right };
    }
    return left;
  }

  function parseAddSub() {
    let left = parseMulDiv();
    while (peek() && peek().type === "OP" && (peek().value === "+" || peek().value === "-")) {
      const op = consume().value;
      const right = parseMulDiv();
      left = { type: "BinaryOp", op, left, right };
    }
    return left;
  }

  function parseMulDiv() {
    let left = parsePower();
    while (peek() && peek().type === "OP" && (peek().value === "*" || peek().value === "/")) {
      const op = consume().value;
      const right = parsePower();
      left = { type: "BinaryOp", op, left, right };
    }
    return left;
  }

  function parsePower() {
    let left = parseUnary();
    while (peek() && peek().type === "OP" && peek().value === "^") {
      consume();
      const right = parseUnary();
      left = { type: "BinaryOp", op: "^", left, right };
    }
    return left;
  }

  function parseUnary() {
    if (peek() && peek().type === "OP" && (peek().value === "+" || peek().value === "-")) {
      const op = consume().value;
      const arg = parseUnary();
      return { type: "UnaryOp", op, arg };
    }
    return parseRangeOp();
  }

  function parseRangeOp() {
    let left = parsePrimary();
    while (peek() && peek().type === "OP" && (peek().value === ":" || peek().value === "%")) {
      const op = consume().value;
      if (op === "%") {
        left = { type: "PostfixPercent", arg: left };
      } else {
        const right = parsePrimary();
        left = { type: "RangeOp", left, right };
      }
    }
    return left;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) return { type: "Literal", value: null };

    if (t.type === "(") {
      consume();
      const expr = parseExpr();
      if (peek() && peek().type === ")") consume();
      return expr;
    }

    if (t.type === "{") {
      consume();
      const rows = [];
      let currentRow = [];
      while (peek() && peek().type !== "}") {
        currentRow.push(parseExpr());
        if (peek() && peek().type === ",") {
          consume();
        } else if (peek() && peek().type === ";") {
          consume();
          rows.push(currentRow);
          currentRow = [];
        } else {
          break;
        }
      }
      if (currentRow.length > 0) rows.push(currentRow);
      if (peek() && peek().type === "}") consume();
      return { type: "ArrayLiteral", rows };
    }

    if (t.type === "NUMBER") {
      consume();
      if (peek() && peek().type === "OP" && peek().value === ":") {
        // e.g. 1:1 where first 1 was parsed as NUMBER
        const rIdx = Math.trunc(t.value) - 1;
        return { type: "Ref", sheet: null, coord: { kind: "row", row: rIdx } };
      }
      return { type: "Literal", value: t.value };
    }

    if (t.type === "STRING") {
      consume();
      return { type: "Literal", value: t.value };
    }

    if (t.type === "ERROR") {
      consume();
      return { type: "ErrorLiteral", code: t.value };
    }

    if (t.type === "SHEET_PREFIX") {
      const sheet = consume().value;
      const next = peek();
      if (!next) return { type: "ErrorLiteral", code: "#REF!" };
      if (next.type === "ERROR") {
        consume();
        return { type: "ErrorLiteral", code: next.value };
      }
      if (next.type === "IDENT" || next.type === "NUMBER") {
        const rawTok = String(consume().value);
        const coord = parseCoordToken(rawTok);
        if (!coord) return { type: "ErrorLiteral", code: "#REF!" };
        return { type: "Ref", sheet, coord };
      }
      return { type: "ErrorLiteral", code: "#REF!" };
    }

    if (t.type === "IDENT") {
      const name = consume().value;
      const upper = name.toUpperCase();

      // Function call: IDENT followed by '('
      if (peek() && peek().type === "(") {
        consume(); // '('
        const args = [];
        if (peek() && peek().type === ")") {
          consume();
        } else {
          while (true) {
            if (peek() && (peek().type === "," || peek().type === ")")) {
              args.push({ type: "EmptyArg" });
            } else {
              args.push(parseExpr());
            }
            if (peek() && peek().type === ",") {
              consume();
              if (peek() && peek().type === ")") {
                args.push({ type: "EmptyArg" });
                consume();
                break;
              }
            } else if (peek() && peek().type === ")") {
              consume();
              break;
            } else {
              break;
            }
          }
        }
        return { type: "Call", name: upper, rawName: name, args };
      }

      if (upper === "TRUE") return { type: "Literal", value: true };
      if (upper === "FALSE") return { type: "Literal", value: false };

      // Check if next token is ':' (e.g. A:A or 1:1 or A1:B2)
      const isRangeStart = peek() && peek().type === "OP" && peek().value === ":";
      const coord = parseCoordToken(name);
      if (coord && (coord.kind === "cell" || isRangeStart)) {
        return { type: "Ref", sheet: null, coord };
      }
      return { type: "VarOrRef", name, coord };
    }

    consume();
    return { type: "Literal", value: null };
  }

  const ast = parseExpr();
  astCache.set(raw, ast);
  return ast;
}

// ============================================================================
// DEMAND-DRIVEN EVALUATOR & SPILL ENGINE
// ============================================================================

const PRESERVE_EXISTING_SPILL = Symbol("PRESERVE_EXISTING_SPILL");

export function recalculateClientGrids(grids, options = {}) {
  if (!grids || typeof grids !== "object") return grids;

  const todaySerial =
    typeof options.todaySerial === "number"
      ? options.todaySerial
      : Math.floor(Date.now() / MS_PER_DAY) + EPOCH_OFFSET_DAYS;

  // 1. Sync Outgoings notes into OutgNotes.values (rows 12..111, cols G..AV) if Outgoings.notes is present
  if (grids.Outgoings?.notes && grids.OutgNotes?.values) {
    const outNotes = grids.Outgoings.notes;
    const onVals = grids.OutgNotes.values;
    const onForms = grids.OutgNotes.formulas || [];
    if (Array.isArray(outNotes)) {
      for (let r = 11; r <= 110 && r < outNotes.length; r++) {
        const noteRow = outNotes[r];
        if (!Array.isArray(noteRow)) continue;
        if (!onVals[r]) onVals[r] = [];
        for (let c = 6; c <= 47 && c < noteRow.length; c++) {
          if (noteRow[c] !== undefined && noteRow[c] !== null) {
            onVals[r][c] = String(noteRow[c]);
          }
        }
      }
    } else if (typeof outNotes === "object") {
      for (let r = 11; r <= 110; r++) {
        if (!onVals[r]) onVals[r] = [];
        const fRow = onForms[r] || [];
        for (let c = 6; c <= 47; c++) {
          if (typeof fRow[c] === "string" && fRow[c].startsWith("=")) continue;
          const noteKey = `${r}:${c}`;
          if (outNotes[noteKey] !== undefined) {
            onVals[r][c] = String(outNotes[noteKey] || "");
          } else if (onVals[r][c]) {
            onVals[r][c] = "";
          }
        }
      }
    }
  }

  // 2. Ensure row formulas are populated for any newly added rows in Confirmed, Pipeline, ConfCalcs, PipeCalcs
  ensureJobRowFormulasPopulated_(grids);

  // 3. Determine active row bounds for 5,000-row / 1,000-row tabs (Confirmed, ConfCalcs, Pipeline, PipeCalcs)
  const maxActiveConfRow = findLastActiveJobRow_(grids.Confirmed?.values, 295);
  const maxActivePipeRow = findLastActiveJobRow_(grids.Pipeline?.values, 105);

  const activeRowLimitByTab = {
    Confirmed: Math.min((grids.Confirmed?.values?.length || 5002) - 1, maxActiveConfRow + 2),
    ConfCalcs: Math.min((grids.ConfCalcs?.values?.length || 5002) - 1, maxActiveConfRow + 2),
    Pipeline: Math.min((grids.Pipeline?.values?.length || 1000) - 1, maxActivePipeRow + 2),
    PipeCalcs: Math.min((grids.PipeCalcs?.values?.length || 1001) - 1, maxActivePipeRow + 2),
  };

  // 4. Build working cell state:
  //    - For non-formula cells, empty strings "" are normalized to `null` (BLANK) so Google Sheets
  //      blank-cell vs zero-length-string relational comparisons (`AP2 > 0` vs `FT2 <= F1`) work identically.
  //    - Identify all spill-origin formulas (e.g. `={...}`, `=ARRAYFORMULA(...)`, `=FILTER(...)`, `=TRANSPOSE(...)`, `=LET(...)` in spill cells).
  const cellState = {}; // tab -> Uint8Array (0=unvisited, 1=visiting, 2=done)
  const tabDims = {};
  const rangeCacheByTab = {}; // tab -> Map<string, Array<Array<any>>>
  const blockedSpillOrigins = new Map(); // `${tab}!${r},${c}` -> original "#REF! (Array result was not expanded...)" string

  // Determine which tabs are affected when options.changedTabs is supplied
  const onlyTabs = options.onlyTabs instanceof Set ? options.onlyTabs : null;
  let unaffectedTabs = options.unaffectedTabs instanceof Set ? new Set(options.unaffectedTabs) : null;
  if (!unaffectedTabs && Array.isArray(options.changedTabs) && options.changedTabs.length > 0) {
    const changedSet = new Set(options.changedTabs);
    if (!changedSet.has("KeyInfo")) {
      unaffectedTabs = new Set(["KeyInfo"]);
      if (!changedSet.has("Year0Data")) {
        unaffectedTabs.add("Year0Data");
      }
      if (!changedSet.has("Salaries")) {
        unaffectedTabs.add("Salaries");
        if (!changedSet.has("Budget")) {
          unaffectedTabs.add("Budget");
        }
      }
      if (!changedSet.has("Outgoings") && !changedSet.has("OutgNotes")) {
        unaffectedTabs.add("OutgNotes");
      }
      if (!changedSet.has("Confirmed") && !changedSet.has("ConfCalcs") && !changedSet.has("RevenueConf")) {
        unaffectedTabs.add("Confirmed");
        unaffectedTabs.add("ConfCalcs");
        unaffectedTabs.add("RevenueConf");
        if (!changedSet.has("CashIncomingConf")) unaffectedTabs.add("CashIncomingConf");
        if (!changedSet.has("InvoicesSent")) unaffectedTabs.add("InvoicesSent");
        if (!changedSet.has("ContrPayments")) unaffectedTabs.add("ContrPayments");
      }
      if (!changedSet.has("Pipeline") && !changedSet.has("PipeCalcs") && !changedSet.has("RevenuePipe")) {
        unaffectedTabs.add("Pipeline");
        unaffectedTabs.add("PipeCalcs");
        unaffectedTabs.add("RevenuePipe");
        if (!changedSet.has("CashIncomingPipe")) unaffectedTabs.add("CashIncomingPipe");
      }
      if (
        unaffectedTabs.has("ConfCalcs") &&
        unaffectedTabs.has("PipeCalcs") &&
        !changedSet.has("Calcs") &&
        !changedSet.has("ErrorCheck")
      ) {
        unaffectedTabs.add("Calcs");
        unaffectedTabs.add("ErrorCheck");
      }
    }
  }
  if (options.alreadyEvaluatedTabs instanceof Set && unaffectedTabs) {
    for (const t of options.alreadyEvaluatedTabs) {
      unaffectedTabs.add(t);
    }
  }

  function isMonthlyColUnaffected_(c) {
    if (!unaffectedTabs || !unaffectedTabs.has("KeyInfo")) return false;
    if (c >= 175 && c <= 185 && unaffectedTabs.has("OutgNotes")) return true;
    if ((c === 10 || (c >= 41 && c <= 100)) && unaffectedTabs.has("PipeCalcs")) return true;
    if (
      (c === 2 || (c >= 17 && c <= 39) || (c >= 102 && c <= 130) || (c >= 142 && c <= 167)) &&
      unaffectedTabs.has("ConfCalcs")
    ) {
      return true;
    }
    return false;
  }

  for (const [tab, t] of Object.entries(grids)) {
    if (!t || typeof t !== "object") continue;
    if (!Array.isArray(t.values)) t.values = [];
    if (!Array.isArray(t.formulas)) t.formulas = [];
    const numRows = Math.max(t.values.length, t.formulas.length);
    let numCols = 0;
    for (let r = 0; r < numRows; r++) {
      const rv = t.values[r] ? t.values[r].length : 0;
      const rf = t.formulas[r] ? t.formulas[r].length : 0;
      if (rv > numCols) numCols = rv;
      if (rf > numCols) numCols = rf;
    }
    tabDims[tab] = { rows: numRows, cols: numCols };
    cellState[tab] = new Uint8Array(numRows * Math.max(1, numCols));
    rangeCacheByTab[tab] = new Map();
    const isTabUnaffected = Boolean(unaffectedTabs && unaffectedTabs.has(tab));

    const maxInitR = activeRowLimitByTab[tab] !== undefined ? activeRowLimitByTab[tab] : numRows - 1;
    for (let r = 0; r < numRows; r++) {
      if (r > maxInitR && r < numRows - 1) {
        if (!t.values[r]) t.values[r] = [];
        continue;
      }
      if (!t.values[r]) t.values[r] = [];
      const rowV = t.values[r];
      const rowF = t.formulas[r] || [];
      for (let c = 0; c < numCols; c++) {
        if (isTabUnaffected || (tab === "Monthly" && isMonthlyColUnaffected_(c))) {
          if (c < rowV.length && rowV[c] === "") {
            rowV[c] = null;
          }
          cellState[tab][r * numCols + c] = 2;
          continue;
        }
        const f = rowF[c];
        const hasFormula = typeof f === "string" && f.startsWith("=");
        // For Calcs (scalar cells only), if PipeCalcs (or ConfCalcs) is unaffected, formulas that ONLY reference
        // the unaffected job pipeline do not need re-evaluation if they already have an evaluated value
        if (
          unaffectedTabs &&
          tab === "Calcs" &&
          hasFormula &&
          rowV[c] !== "" &&
          rowV[c] !== undefined &&
          rowV[c] !== null
        ) {
          const refsPipe = f.includes("PipeCalcs");
          const refsConf = f.includes("ConfCalcs");
          if (refsPipe && !refsConf && unaffectedTabs.has("PipeCalcs")) {
            cellState[tab][r * numCols + c] = 2;
            continue;
          }
          if (refsConf && !refsPipe && unaffectedTabs.has("ConfCalcs")) {
            cellState[tab][r * numCols + c] = 2;
            continue;
          }
        }
        if (!hasFormula) {
          if (c < rowV.length && rowV[c] === "") {
            rowV[c] = null;
          }
          cellState[tab][r * numCols + c] = 2; // non-formula cell is ready unless overwritten by a spill
        } else {
          const curVal = rowV[c];
          if (typeof curVal === "string" && curVal.startsWith("#REF! (Array result was not expanded")) {
            blockedSpillOrigins.set(`${tab}!${r},${c}`, curVal);
          }
        }
      }
    }
  }

  // Track spill origins per tab so that reading a cell inside a spill region triggers its origin first
  const spillOriginsByTab = {};
  for (const [tab, t] of Object.entries(grids)) {
    if (!t?.formulas) continue;
    const origins = [];
    const maxR = activeRowLimitByTab[tab] !== undefined ? activeRowLimitByTab[tab] : t.formulas.length - 1;
    for (let r = 0; r <= maxR && r < t.formulas.length; r++) {
      const rowF = t.formulas[r];
      if (!rowF) continue;
      for (let c = 0; c < rowF.length; c++) {
        if (tab === "Monthly" && isMonthlyColUnaffected_(c)) continue;
        const f = rowF[c];
        if (typeof f === "string" && f.startsWith("=")) {
          if (isPotentialSpillFormula_(f)) {
            // In ConfCalcs & PipeCalcs, only A1 ({Confirmed!A1:DD5003}) should be pre-evaluated;
            // IT2:JC2 (c >= 253) depend on row formulas EO..IK (c < 253) and must evaluate after EO..IK
            if ((tab === "ConfCalcs" || tab === "PipeCalcs") && !(r === 0 && c === 0)) {
              continue;
            }
            origins.push([r, c]);
          }
        }
      }
    }
    if (origins.length > 0) spillOriginsByTab[tab] = origins;
  }

  const tabSpillsInitialized = new Set();
  if (unaffectedTabs) {
    for (const ut of unaffectedTabs) tabSpillsInitialized.add(ut);
  }

  function ensureTabSpillsEvaluated(tab) {
    if (tabSpillsInitialized.has(tab)) return;
    tabSpillsInitialized.add(tab);
    const origins = spillOriginsByTab[tab];
    if (!origins) return;
    for (let i = 0; i < origins.length; i++) {
      const [r, c] = origins[i];
      evalCell(tab, r, c);
    }
  }

  function getCell(tab, r, c) {
    const t = grids[tab];
    if (!t) return null;
    if (r < 0 || c < 0) return null;

    // If tab has active row bound and r exceeds it, evaluate template row (maxR) and return its value
    const maxR = activeRowLimitByTab[tab];
    if (
      maxR !== undefined &&
      r > maxR &&
      !(tab === "PipeCalcs" && r >= (grids.Pipeline?.values?.length || 1000))
    ) {
      return getCell(tab, maxR, c);
    }

    const dims = tabDims[tab];
    if (!dims || r >= dims.rows || c >= dims.cols) return null;

    const f = t.formulas[r]?.[c];
    if (typeof f === "string" && f.startsWith("=")) {
      return evalCell(tab, r, c);
    }

    // If this non-formula cell might be populated by a spill in `tab`, ensure spills are evaluated
    if (!tabSpillsInitialized.has(tab) && spillOriginsByTab[tab]) {
      ensureTabSpillsEvaluated(tab);
    }

    const v = t.values[r]?.[c];
    return v === undefined ? null : v;
  }

  function setCellVal(tab, r, c, val) {
    const t = grids[tab];
    if (!t) return;
    if (!t.values[r]) t.values[r] = [];
    t.values[r][c] = val instanceof SheetError ? val.toString() : val;
    const dims = tabDims[tab];
    if (dims && r < dims.rows && c < dims.cols) {
      cellState[tab][r * dims.cols + c] = 2;
    }
    if (rangeCacheByTab[tab]?.size > 0) {
      rangeCacheByTab[tab].clear();
    }
  }

  function getRange2D(tab, r0, r1, c0, c1, clampInactive = true) {
    const t = grids[tab];
    if (!t) return [[null]];
    const dims = tabDims[tab] || { rows: t.values.length, cols: 1 };
    let startR = Math.max(0, Math.min(r0, r1));
    let endR = Math.min(dims.rows - 1, Math.max(r0, r1));
    let startC = Math.max(0, Math.min(c0, c1));
    let endC = Math.min(dims.cols - 1, Math.max(c0, c1));

    if (clampInactive && activeRowLimitByTab[tab] !== undefined && endR > activeRowLimitByTab[tab]) {
      endR = Math.max(startR, activeRowLimitByTab[tab]);
    }

    if (!tabSpillsInitialized.has(tab) && spillOriginsByTab[tab]) {
      ensureTabSpillsEvaluated(tab);
    }

    const rCache = rangeCacheByTab[tab];
    const cacheKey = rCache && (endR - startR > 4 || endC - startC > 4) ? `${startR}:${endR}:${startC}:${endC}` : null;
    if (cacheKey) {
      const hit = rCache.get(cacheKey);
      if (hit) return hit;
    }

    const out = [];
    for (let r = startR; r <= endR; r++) {
      const row = [];
      for (let c = startC; c <= endC; c++) {
        row.push(getCell(tab, r, c));
      }
      out.push(row);
    }
    const res = out.length > 0 ? out : [[null]];
    if (cacheKey) {
      rCache.set(cacheKey, res);
    }
    return res;
  }

  function getNonZeroColEntries(tab, r0, r1, c0) {
    const rCache = rangeCacheByTab[tab];
    const key = `nz:${r0}:${r1}:${c0}`;
    if (rCache) {
      const hit = rCache.get(key);
      if (hit) return hit;
    }
    const nz = [];
    const rows = r1 - r0 + 1;
    for (let dr = 0; dr < rows; dr++) {
      const sv = getCell(tab, r0 + dr, c0);
      if (typeof sv === "number" && Number.isFinite(sv) && sv !== 0) {
        nz.push({ dr, sv });
      }
    }
    if (rCache) {
      rCache.set(key, nz);
    }
    return nz;
  }

  function evalCell(tab, r, c) {
    const dims = tabDims[tab];
    if (!dims || r < 0 || c < 0 || r >= dims.rows || c >= dims.cols) return null;
    const idx = r * dims.cols + c;
    const st = cellState[tab][idx];
    if (st === 2) {
      const v = grids[tab].values[r]?.[c];
      return v === undefined ? null : v;
    }
    if (st === 1) {
      // In ConfCalcs / PipeCalcs, ER (c=147) and ES (c=148) have a benign circular guard on Retainer rows:
      // ER references ES, while ES checks `OR(EQ="", ER="")` before using AM (c=38) for Retainers.
      if ((tab === "ConfCalcs" || tab === "PipeCalcs") && c === 147) {
        return getCell(tab, r, 38);
      }
      // Cycle detected -> fallback to existing cached/previous-iteration value in sheet
      const v = grids[tab].values[r]?.[c];
      return v === undefined || v === "" ? 0 : v;
    }

    const f = grids[tab].formulas[r]?.[c];
    if (typeof f !== "string" || !f.startsWith("=")) {
      cellState[tab][idx] = 2;
      const v = grids[tab].values[r]?.[c];
      return v === undefined ? null : v;
    }

    cellState[tab][idx] = 1; // visiting

    // Check if this cell was a blocked spill origin in the sheet
    const blockedKey = `${tab}!${r},${c}`;
    if (blockedSpillOrigins.has(blockedKey)) {
      const errStr = blockedSpillOrigins.get(blockedKey);
      setCellVal(tab, r, c, errStr);
      return errStr;
    }

    let result;
    try {
      const ast = parseFormulaToAST(f);
      const ctx = {
        tab,
        r,
        c,
        arrayMode: false,
        env: new Map(),
      };
      result = evalAST(ast, ctx);
    } catch (err) {
      if (err instanceof SheetError) {
        result = err.toString();
      } else {
        result = new SheetError("#ERROR!", err?.message || "Eval error").toString();
      }
    }

    if (result === PRESERVE_EXISTING_SPILL) {
      cellState[tab][idx] = 2;
      return grids[tab].values[r]?.[c] ?? null;
    }

    if (Array.isArray(result)) {
      // 2D Array spill result!
      // Special case: ConfCalcs!A1 = {Confirmed!A1:DD5003} or PipeCalcs!A1 = {Pipeline!A1:DD1003}
      const numSpillRows = result.length;
      const numSpillCols = result[0] ? result[0].length : 0;

      // Check if any cell in spill range (excluding origin) has a formula -> #REF!
      let blockedByCell = null;
      if (numSpillRows > 1 || numSpillCols > 1) {
        outerCheck: for (let dr = 0; dr < numSpillRows; dr++) {
          for (let dc = 0; dc < numSpillCols; dc++) {
            if (dr === 0 && dc === 0) continue;
            const tr = r + dr;
            const tc = c + dc;
            const tf = grids[tab].formulas[tr]?.[tc];
            if (typeof tf === "string" && tf.startsWith("=")) {
              blockedByCell = `${colIndexToLetters(tc)}${tr + 1}`;
              break outerCheck;
            }
          }
        }
      }

      if (blockedByCell) {
        const errStr = `#REF! (Array result was not expanded because it would overwrite data in  ${blockedByCell}.)`;
        setCellVal(tab, r, c, errStr);
        return errStr;
      }

      for (let dr = 0; dr < numSpillRows; dr++) {
        const tr = r + dr;
        if (tr >= dims.rows) break;
        const rowArr = result[dr];
        if (!Array.isArray(rowArr)) continue;
        for (let dc = 0; dc < rowArr.length; dc++) {
          const tc = c + dc;
          if (tc >= dims.cols) break;
          setCellVal(tab, tr, tc, rowArr[dc]);
        }
      }
      cellState[tab][idx] = 2;
      return grids[tab].values[r]?.[c] ?? null;
    }

    setCellVal(tab, r, c, result);
    return grids[tab].values[r]?.[c] ?? null;
  }

  // ============================================================================
  // AST EVALUATION
  // ============================================================================

  function resolveRefCoords(refNode, ctx) {
    const targetTab = refNode.sheet || ctx.tab;
    const dims = tabDims[targetTab] || { rows: 1000, cols: 100 };
    const coord = refNode.coord;
    if (!coord) throw new SheetError("#REF!", "Reference does not exist.");
    if (coord.kind === "cell") {
      return { tab: targetTab, r0: coord.row, r1: coord.row, c0: coord.col, c1: coord.col, isSingle: true };
    }
    if (coord.kind === "col") {
      return { tab: targetTab, r0: 0, r1: dims.rows - 1, c0: coord.col, c1: coord.col, isSingle: false };
    }
    if (coord.kind === "row") {
      return { tab: targetTab, r0: coord.row, r1: coord.row, c0: 0, c1: dims.cols - 1, isSingle: false };
    }
    throw new SheetError("#REF!", "Reference does not exist.");
  }

  function resolveRangeBounds(node, ctx, clampInactive = true) {
    if (node.type === "Ref") {
      return resolveRefCoords(node, ctx);
    }
    if (node.type === "VarOrRef" && node.coord) {
      return resolveRefCoords({ sheet: null, coord: node.coord }, ctx);
    }
    if (node.type === "Literal" && typeof node.value === "number") {
      return resolveRefCoords({ sheet: null, coord: { kind: "row", row: Math.trunc(node.value) - 1 } }, ctx);
    }
    if (node.type === "RangeOp") {
      const leftB = resolveRangeBounds(node.left, ctx, clampInactive);
      const rightB = resolveRangeBounds(node.right, { ...ctx, tab: leftB.tab }, clampInactive);
      const tab = leftB.tab;
      const r0 = Math.min(leftB.r0, rightB.r0);
      let r1 = Math.max(leftB.r1, rightB.r1);
      const c0 = Math.min(leftB.c0, rightB.c0);
      const c1 = Math.max(leftB.c1, rightB.c1);
      if (clampInactive && activeRowLimitByTab[tab] !== undefined && r1 > activeRowLimitByTab[tab]) {
        r1 = Math.max(r0, activeRowLimitByTab[tab]);
      }
      return { tab, r0, r1, c0, c1, isSingle: r0 === r1 && c0 === c1 };
    }
    if (node.type === "Call" && node.name === "INDIRECT") {
      const refStr = toStringVal(evalScalar(node.args[0], ctx));
      return parseIndirectRangeString(refStr, ctx.tab, clampInactive);
    }
    if (node.type === "Call" && node.name === "OFFSET") {
      const base = resolveRangeBounds(node.args[0], ctx, false);
      const rowOff = Math.trunc(toNumberStrict(evalScalar(node.args[1], ctx)));
      const colOff = Math.trunc(toNumberStrict(evalScalar(node.args[2], ctx)));
      const height = node.args.length >= 4 && node.args[3].type !== "EmptyArg"
        ? Math.trunc(toNumberStrict(evalScalar(node.args[3], ctx)))
        : (base.r1 - base.r0 + 1);
      const width = node.args.length >= 5 && node.args[4].type !== "EmptyArg"
        ? Math.trunc(toNumberStrict(evalScalar(node.args[4], ctx)))
        : (base.c1 - base.c0 + 1);
      const r0 = base.r0 + rowOff;
      const c0 = base.c0 + colOff;
      const r1 = r0 + Math.max(1, height) - 1;
      const c1 = c0 + Math.max(1, width) - 1;
      if (r0 < 0 || c0 < 0) throw new SheetError("#REF!", "OFFSET out of bounds");
      return { tab: base.tab, r0, r1, c0, c1, isSingle: r0 === r1 && c0 === c1 };
    }
    return null;
  }

  function parseIndirectRangeString(refStr, defaultTab, clampInactive = true) {
    let s = String(refStr ?? "").trim();
    if (!s || s.includes("#REF!")) throw new SheetError("#REF!", "Reference does not exist.");
    let tab = defaultTab;
    const bangIdx = s.indexOf("!");
    if (bangIdx >= 0) {
      tab = s.slice(0, bangIdx).replace(/^'|'$/g, "");
      s = s.slice(bangIdx + 1);
    }
    const dims = tabDims[tab] || { rows: 1000, cols: 100 };
    const parts = s.split(":");
    const cLeft = parseCoordToken(parts[0].trim());
    if (!cLeft) throw new SheetError("#REF!", `Invalid INDIRECT '${refStr}'`);
    if (parts.length === 1) {
      if (cLeft.kind === "cell") {
        return { tab, r0: cLeft.row, r1: cLeft.row, c0: cLeft.col, c1: cLeft.col, isSingle: true };
      }
      throw new SheetError("#REF!", `Invalid INDIRECT '${refStr}'`);
    }
    const cRight = parseCoordToken(parts[1].trim());
    if (!cRight) throw new SheetError("#REF!", `Invalid INDIRECT '${refStr}'`);
    let r0 = cLeft.row !== undefined ? cLeft.row : 0;
    let r1 = cRight.row !== undefined ? cRight.row : dims.rows - 1;
    let c0 = cLeft.col !== undefined ? cLeft.col : 0;
    let c1 = cRight.col !== undefined ? cRight.col : dims.cols - 1;
    if (clampInactive && activeRowLimitByTab[tab] !== undefined && r1 > activeRowLimitByTab[tab]) {
      r1 = Math.max(r0, activeRowLimitByTab[tab]);
    }
    return { tab, r0, r1, c0, c1, isSingle: r0 === r1 && c0 === c1 };
  }

  function evalScalar(node, ctx) {
    const v = evalAST(node, ctx);
    if (Array.isArray(v)) {
      const first = v[0]?.[0];
      return first === undefined ? null : first;
    }
    return v;
  }

  function evalTo2D(node, ctx, clampInactive = true) {
    const b = resolveRangeBounds(node, ctx, clampInactive);
    if (b) {
      return getRange2D(b.tab, b.r0, b.r1, b.c0, b.c1, clampInactive);
    }
    const v = evalAST(node, ctx);
    if (Array.isArray(v)) return v;
    return [[v]];
  }

  function broadcastBinaryOp(op, leftVal, rightVal, evalPair) {
    const isArrL = Array.isArray(leftVal);
    const isArrR = Array.isArray(rightVal);
    if (!isArrL && !isArrR) {
      return evalPair(leftVal, rightVal);
    }
    const arrL = isArrL ? leftVal : [[leftVal]];
    const arrR = isArrR ? rightVal : [[rightVal]];
    const rowsL = arrL.length;
    const colsL = arrL[0]?.length || 1;
    const rowsR = arrR.length;
    const colsR = arrR[0]?.length || 1;
    const maxR = Math.max(rowsL, rowsR);
    const maxC = Math.max(colsL, colsR);
    const out = [];
    for (let r = 0; r < maxR; r++) {
      const row = [];
      for (let c = 0; c < maxC; c++) {
        const lv = arrL[rowsL === 1 ? 0 : r]?.[colsL === 1 ? 0 : c];
        const rv = arrR[rowsR === 1 ? 0 : r]?.[colsR === 1 ? 0 : c];
        try {
          row.push(evalPair(lv, rv));
        } catch (e) {
          row.push(e instanceof SheetError ? e : new SheetError("#VALUE!", e?.message));
        }
      }
      out.push(row);
    }
    return out;
  }

  function mapArrayScalar(val, fn) {
    if (!Array.isArray(val)) return fn(val);
    return val.map((row) =>
      row.map((cell) => {
        try {
          return fn(cell);
        } catch (e) {
          return e instanceof SheetError ? e : new SheetError("#VALUE!", e?.message);
        }
      })
    );
  }

  function evalAST(node, ctx) {
    if (!node) return null;

    switch (node.type) {
      case "Literal":
        return node.value;

      case "EmptyArg":
        return null;

      case "ErrorLiteral":
        throw new SheetError(node.code, node.code === "#REF!" ? "Reference does not exist." : "");

      case "VarOrRef": {
        const lowerName = node.name.toLowerCase();
        if (ctx.env.has(lowerName)) {
          return ctx.env.get(lowerName);
        }
        if (node.coord) {
          const b = resolveRefCoords({ sheet: null, coord: node.coord }, ctx);
          return b.isSingle ? getCell(b.tab, b.r0, b.c0) : getRange2D(b.tab, b.r0, b.r1, b.c0, b.c1);
        }
        throw new SheetError("#NAME?", `Unknown identifier ${node.name}`);
      }

      case "Ref": {
        const b = resolveRefCoords(node, ctx);
        return b.isSingle ? getCell(b.tab, b.r0, b.c0) : getRange2D(b.tab, b.r0, b.r1, b.c0, b.c1);
      }

      case "RangeOp": {
        // Special optimization for ConfCalcs!A1 = {Confirmed!A1:DD5003} and PipeCalcs!A1 = {Pipeline!A1:DD1003}
        const b = resolveRangeBounds(node, ctx, true);
        if (!b) throw new SheetError("#REF!", "Invalid range");
        return b.isSingle ? getCell(b.tab, b.r0, b.c0) : getRange2D(b.tab, b.r0, b.r1, b.c0, b.c1, true);
      }

      case "ArrayLiteral": {
        // { a, b ; c, d }
        const resultRows = [];
        for (const rowNodes of node.rows) {
          // Each element in rowNodes is horizontally stacked; if an element is already a 2D array, HSTACK/VSTACK it
          let rowBlock = null;
          for (const elemNode of rowNodes) {
            // For {Confirmed!A1:DD5003} in ConfCalcs!A1, clampInactive=true so we only evaluate active rows + 1
            const val = evalAST(elemNode, { ...ctx, arrayMode: true });
            const mat = Array.isArray(val) ? val : [[val]];
            if (!rowBlock) {
              rowBlock = mat.map((r) => [...r]);
            } else {
              const maxH = Math.max(rowBlock.length, mat.length);
              const leftCols = rowBlock[0]?.length || 0;
              const rightCols = mat[0]?.length || 0;
              const merged = [];
              for (let r = 0; r < maxH; r++) {
                const lr = rowBlock[r] || Array(leftCols).fill(null);
                const rr = mat[r] || Array(rightCols).fill(null);
                merged.push([...lr, ...rr]);
              }
              rowBlock = merged;
            }
          }
          if (rowBlock) {
            for (const r of rowBlock) resultRows.push(r);
          }
        }
        return resultRows.length === 1 && resultRows[0].length === 1 ? resultRows[0][0] : resultRows;
      }

      case "UnaryOp": {
        const v = evalAST(node.arg, ctx);
        return mapArrayScalar(v, (x) => {
          const n = toNumberOrZero(x);
          return node.op === "-" ? -n : n;
        });
      }

      case "PostfixPercent": {
        const v = evalAST(node.arg, ctx);
        return mapArrayScalar(v, (x) => toNumberOrZero(x) / 100);
      }

      case "BinaryOp": {
        const op = node.op;
        const bLeft = node.left.type === "RangeOp" ? resolveRangeBounds(node.left, ctx, true) : null;
        if (bLeft && !bLeft.isSingle && (bLeft.r1 - bLeft.r0 > 4 || bLeft.c1 - bLeft.c0 > 4)) {
          const rv = evalAST(node.right, ctx);
          if (!Array.isArray(rv) && !isSheetError(rv)) {
            const rCache = rangeCacheByTab[bLeft.tab];
            const binKey = rCache
              ? `bin:${bLeft.r0}:${bLeft.r1}:${bLeft.c0}:${bLeft.c1}:${op}:${typeof rv}:${String(rv)}`
              : null;
            if (binKey) {
              const hit = rCache.get(binKey);
              if (hit) return hit;
            }
            const lv = getRange2D(bLeft.tab, bLeft.r0, bLeft.r1, bLeft.c0, bLeft.c1, true);
            const res = broadcastBinaryOp(op, lv, rv, (a, b) => {
              if (isSheetError(a)) throw toErrorObject(a);
              if (isSheetError(b)) throw toErrorObject(b);
              if (op === "&") return toStringVal(a) + toStringVal(b);
              if (op === "+") return toNumberOrZero(a) + toNumberOrZero(b);
              if (op === "-") return toNumberOrZero(a) - toNumberOrZero(b);
              if (op === "*") return toNumberOrZero(a) * toNumberOrZero(b);
              if (op === "/") {
                const num = toNumberOrZero(a);
                const den = toNumberOrZero(b);
                if (Math.abs(den) <= 1e-15) throw new SheetError("#DIV/0!", "Evaluation caused divide by zero error.");
                return num / den;
              }
              if (op === "^") return Math.pow(toNumberOrZero(a), toNumberOrZero(b));
              return compareSheetValues(a, b, op);
            });
            if (binKey) rCache.set(binKey, res);
            return res;
          }
        }
        const lv = evalAST(node.left, ctx);
        const rv = evalAST(node.right, ctx);

        if (!ctx.arrayMode && (Array.isArray(lv) || Array.isArray(rv))) {
          // Even outside explicit ARRAYFORMULA, FILTER conditions like (ConfCalcs!FT:FT<=F1)*(ConfCalcs!FU:FU>=E1)
          // or SUMPRODUCT((A2:A10="x")*(B2:B10)) use array broadcasting!
        }

        return broadcastBinaryOp(op, lv, rv, (a, b) => {
          if (isSheetError(a)) throw toErrorObject(a);
          if (isSheetError(b)) throw toErrorObject(b);
          if (op === "&") {
            return toStringVal(a) + toStringVal(b);
          }
          if (op === "+") return toNumberOrZero(a) + toNumberOrZero(b);
          if (op === "-") return toNumberOrZero(a) - toNumberOrZero(b);
          if (op === "*") return toNumberOrZero(a) * toNumberOrZero(b);
          if (op === "/") {
            const num = toNumberOrZero(a);
            const den = toNumberOrZero(b);
            if (Math.abs(den) <= 1e-15) throw new SheetError("#DIV/0!", "Evaluation caused divide by zero error.");
            return num / den;
          }
          if (op === "^") return Math.pow(toNumberOrZero(a), toNumberOrZero(b));
          return compareSheetValues(a, b, op);
        });
      }

      case "Call":
        return evalFunctionCall(node, ctx);

      default:
        return null;
    }
  }

  // ============================================================================
  // BUILT-IN GOOGLE SHEETS FUNCTIONS
  // ============================================================================

  function evalFunctionCall(node, ctx) {
    const fn = node.name;
    const args = node.args;

    // Check if fn is a LET-bound LAMBDA in ctx.env
    const envVal = ctx.env.get(node.rawName.toLowerCase());
    if (envVal && typeof envVal === "object" && envVal.__isLambda) {
      const evaluatedArgs = args.map((a) => evalAST(a, ctx));
      return invokeLambda(envVal, evaluatedArgs);
    }

    switch (fn) {
      case "ARRAYFORMULA": {
        const res = evalAST(args[0], { ...ctx, arrayMode: true });
        return res;
      }

      case "IF": {
        const condVal = evalAST(args[0], ctx);
        if (Array.isArray(condVal)) {
          // Element-wise IF over array condition
          const rows = condVal.length;
          const cols = condVal[0]?.length || 1;
          // Lazy evaluation: only evaluate trueBranch / falseBranch if at least one element needs it
          let hasTrue = false;
          let hasFalse = false;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const cv = condVal[r][c];
              if (isSheetError(cv)) continue;
              if (toBoolean(cv)) hasTrue = true;
              else hasFalse = true;
            }
          }
          const tVal = hasTrue && args[1] ? evalAST(args[1], ctx) : null;
          const fVal = hasFalse && args[2] ? evalAST(args[2], ctx) : null;
          const tArr = Array.isArray(tVal) ? tVal : null;
          const fArr = Array.isArray(fVal) ? fVal : null;
          const out = [];
          for (let r = 0; r < rows; r++) {
            const outRow = [];
            for (let c = 0; c < cols; c++) {
              const cv = condVal[r][c];
              if (isSheetError(cv)) {
                outRow.push(cv);
              } else if (toBoolean(cv)) {
                outRow.push(tArr ? (tArr[tArr.length === 1 ? 0 : r]?.[tArr[0].length === 1 ? 0 : c] ?? null) : tVal);
              } else {
                outRow.push(fArr ? (fArr[fArr.length === 1 ? 0 : r]?.[fArr[0].length === 1 ? 0 : c] ?? null) : (args.length >= 3 ? fVal : false));
              }
            }
            out.push(outRow);
          }
          return out;
        }
        if (isSheetError(condVal)) throw toErrorObject(condVal);
        if (toBoolean(condVal)) {
          return args.length >= 2 ? evalAST(args[1], ctx) : true;
        }
        return args.length >= 3 ? evalAST(args[2], ctx) : false;
      }

      case "IFS": {
        for (let i = 0; i + 1 < args.length; i += 2) {
          const cVal = evalScalar(args[i], ctx);
          if (isSheetError(cVal)) throw toErrorObject(cVal);
          if (toBoolean(cVal)) {
            return evalAST(args[i + 1], ctx);
          }
        }
        throw new SheetError("#N/A", "No match in IFS");
      }

      case "SWITCH": {
        const exprVal = evalScalar(args[0], ctx);
        let i = 1;
        while (i + 1 < args.length) {
          const caseVal = evalScalar(args[i], ctx);
          if (compareSheetValues(exprVal, caseVal, "=")) {
            return evalAST(args[i + 1], ctx);
          }
          i += 2;
        }
        if (i < args.length) {
          return evalAST(args[i], ctx);
        }
        throw new SheetError("#N/A", "No match in SWITCH");
      }

      case "IFERROR": {
        try {
          const v = evalAST(args[0], ctx);
          if (Array.isArray(v)) {
            let fallbackEvaluated = false;
            let fallbackVal = null;
            const getFallback = () => {
              if (!fallbackEvaluated) {
                fallbackEvaluated = true;
                fallbackVal = args.length >= 2 && args[1].type !== "EmptyArg" ? evalAST(args[1], ctx) : null;
              }
              return fallbackVal;
            };
            return v.map((row, r) =>
              row.map((cell, c) => {
                if (isSheetError(cell)) {
                  const fb = getFallback();
                  return Array.isArray(fb) ? (fb[fb.length === 1 ? 0 : r]?.[fb[0].length === 1 ? 0 : c] ?? null) : fb;
                }
                return cell;
              })
            );
          }
          if (isSheetError(v)) {
            return args.length >= 2 && args[1].type !== "EmptyArg" ? evalAST(args[1], ctx) : null;
          }
          return v;
        } catch (err) {
          return args.length >= 2 && args[1].type !== "EmptyArg" ? evalAST(args[1], ctx) : null;
        }
      }

      case "IFNA": {
        try {
          const v = evalAST(args[0], ctx);
          if (Array.isArray(v)) {
            const fb = args.length >= 2 && args[1].type !== "EmptyArg" ? evalAST(args[1], ctx) : null;
            return v.map((row) => row.map((cell) => (isNaError(cell) ? fb : cell)));
          }
          if (isNaError(v)) {
            return args.length >= 2 && args[1].type !== "EmptyArg" ? evalAST(args[1], ctx) : null;
          }
          return v;
        } catch (err) {
          if (err instanceof SheetError && err.code === "#N/A") {
            return args.length >= 2 && args[1].type !== "EmptyArg" ? evalAST(args[1], ctx) : null;
          }
          throw err;
        }
      }

      case "ISERROR": {
        try {
          const v = evalScalar(args[0], ctx);
          return isSheetError(v);
        } catch {
          return true;
        }
      }

      case "ISNA": {
        try {
          const v = evalScalar(args[0], ctx);
          return isNaError(v);
        } catch (err) {
          return err instanceof SheetError && err.code === "#N/A";
        }
      }

      case "ISBLANK": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => isBlankVal(x));
      }

      case "ISNUMBER": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => typeof x === "number" && Number.isFinite(x));
      }

      case "AND": {
        for (const a of args) {
          const v = evalAST(a, ctx);
          if (Array.isArray(v)) {
            for (const row of v) {
              for (const cell of row) {
                if (isSheetError(cell)) throw toErrorObject(cell);
                if (!isBlankVal(cell) && !toBoolean(cell)) return false;
              }
            }
          } else {
            if (isSheetError(v)) throw toErrorObject(v);
            if (!toBoolean(v)) return false;
          }
        }
        return true;
      }

      case "OR": {
        for (const a of args) {
          const v = evalAST(a, ctx);
          if (Array.isArray(v)) {
            for (const row of v) {
              for (const cell of row) {
                if (isSheetError(cell)) throw toErrorObject(cell);
                if (!isBlankVal(cell) && toBoolean(cell)) return true;
              }
            }
          } else {
            if (isSheetError(v)) throw toErrorObject(v);
            if (toBoolean(v)) return true;
          }
        }
        return false;
      }

      case "NOT": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => !toBoolean(x));
      }

      case "LET": {
        const childEnv = new Map(ctx.env);
        const childCtx = { ...ctx, env: childEnv };
        let i = 0;
        while (i + 1 < args.length) {
          const varNode = args[i];
          const varName = (varNode.name || varNode.rawName || "").toLowerCase();
          const val = evalAST(args[i + 1], childCtx);
          childEnv.set(varName, val);
          i += 2;
        }
        return evalAST(args[args.length - 1], childCtx);
      }

      case "LAMBDA": {
        const paramNames = args.slice(0, -1).map((a) => (a.name || a.rawName || "").toLowerCase());
        const bodyAst = args[args.length - 1];
        return {
          __isLambda: true,
          paramNames,
          bodyAst,
          closureCtx: ctx,
        };
      }

      case "MAP": {
        const arrayArgs = args.slice(0, -1).map((a) => evalTo2D(a, ctx, true));
        const lambdaObj = evalAST(args[args.length - 1], ctx);
        const rows = arrayArgs[0].length;
        const cols = arrayArgs[0][0]?.length || 1;
        const out = [];
        for (let r = 0; r < rows; r++) {
          const outRow = [];
          for (let c = 0; c < cols; c++) {
            const callArgs = arrayArgs.map((arr) => arr[r]?.[c] ?? null);
            outRow.push(invokeLambda(lambdaObj, callArgs));
          }
          out.push(outRow);
        }
        return out;
      }

      case "REDUCE": {
        let acc = evalAST(args[0], ctx);
        const arr = evalTo2D(args[1], ctx, true);
        const lambdaObj = evalAST(args[2], ctx);
        for (let r = 0; r < arr.length; r++) {
          for (let c = 0; c < (arr[r]?.length || 0); c++) {
            acc = invokeLambda(lambdaObj, [acc, arr[r][c]]);
          }
        }
        return acc;
      }

      case "BYROW": {
        const arr = evalTo2D(args[0], ctx, true);
        const lambdaObj = evalAST(args[1], ctx);
        const out = [];
        for (let r = 0; r < arr.length; r++) {
          try {
            const res = invokeLambda(lambdaObj, [[arr[r]]]);
            out.push([Array.isArray(res) ? res[0]?.[0] : res]);
          } catch (e) {
            out.push([e instanceof SheetError ? e.toString() : "#ERROR!"]);
          }
        }
        return out;
      }

      case "SUM": {
        let sum = 0;
        for (const a of args) {
          const isRange = Boolean(resolveRangeBounds(a, ctx, true));
          const v = evalAST(a, ctx);
          if (Array.isArray(v)) {
            for (let r = 0; r < v.length; r++) {
              for (let c = 0; c < v[r].length; c++) {
                const cell = v[r][c];
                if (isSheetError(cell)) throw toErrorObject(cell);
                if (typeof cell === "number" && Number.isFinite(cell)) sum += cell;
              }
            }
          } else {
            if (isSheetError(v)) throw toErrorObject(v);
            if (isRange) {
              if (typeof v === "number" && Number.isFinite(v)) sum += v;
            } else {
              sum += toNumberOrZero(v);
            }
          }
        }
        return sum;
      }

      case "AVERAGE": {
        let sum = 0;
        let count = 0;
        for (const a of args) {
          const v = evalAST(a, ctx);
          if (Array.isArray(v)) {
            for (const row of v) {
              for (const cell of row) {
                if (isSheetError(cell)) throw toErrorObject(cell);
                if (typeof cell === "number" && Number.isFinite(cell)) {
                  sum += cell;
                  count++;
                }
              }
            }
          } else {
            if (isSheetError(v)) throw toErrorObject(v);
            if (typeof v === "number" && Number.isFinite(v)) {
              sum += v;
              count++;
            }
          }
        }
        if (count === 0) throw new SheetError("#DIV/0!", "AVERAGE of 0 numbers");
        return sum / count;
      }

      case "MIN":
      case "MAX": {
        let best = fn === "MIN" ? Infinity : -Infinity;
        let found = false;
        for (const a of args) {
          const v = evalAST(a, ctx);
          if (Array.isArray(v)) {
            for (const row of v) {
              for (const cell of row) {
                if (isSheetError(cell)) throw toErrorObject(cell);
                if (typeof cell === "number" && Number.isFinite(cell)) {
                  found = true;
                  if (fn === "MIN" ? cell < best : cell > best) best = cell;
                }
              }
            }
          } else {
            if (isSheetError(v)) throw toErrorObject(v);
            if (typeof v === "number" && Number.isFinite(v)) {
              found = true;
              if (fn === "MIN" ? v < best : v > best) best = v;
            }
          }
        }
        return found ? best : 0;
      }

      case "COUNT": {
        let count = 0;
        for (const a of args) {
          const v = evalAST(a, ctx);
          if (Array.isArray(v)) {
            for (const row of v) {
              for (const cell of row) {
                if (typeof cell === "number" && Number.isFinite(cell)) count++;
              }
            }
          } else if (typeof v === "number" && Number.isFinite(v)) {
            count++;
          }
        }
        return count;
      }

      case "COUNTA": {
        let count = 0;
        for (const a of args) {
          const v = evalAST(a, ctx);
          if (Array.isArray(v)) {
            for (const row of v) {
              for (const cell of row) {
                if (cell !== null && cell !== undefined && cell !== "") count++;
              }
            }
          } else if (v !== null && v !== undefined && v !== "") {
            count++;
          }
        }
        return count;
      }

      case "COUNTIF": {
        const range2D = evalTo2D(args[0], ctx, true);
        const critVal = evalAST(args[1], ctx);
        if (Array.isArray(critVal)) {
          // Fast O(N) lookup map when criterion is an array of exact keys (like child_keys in RevenueConf/Monthly/Calcs)
          const freq = new Map();
          for (const row of range2D) {
            for (const cell of row) {
              const k = isBlankVal(cell) ? "" : String(cell).toLowerCase();
              freq.set(k, (freq.get(k) || 0) + 1);
            }
          }
          return critVal.map((row) =>
            row.map((cCell) => {
              const ck = isBlankVal(cCell) ? "" : String(cCell).toLowerCase();
              return freq.get(ck) || 0;
            })
          );
        }
        const matcher = buildCriterionMatcher(critVal);
        let cnt = 0;
        for (const row of range2D) {
          for (const cell of row) {
            if (matcher(cell)) cnt++;
          }
        }
        return cnt;
      }

      case "SUMIF": {
        const matcher = buildCriterionMatcher(evalScalar(args[1], ctx));
        const bCrit = resolveRangeBounds(args[0], ctx, true);
        const bSum = args.length >= 3 ? resolveRangeBounds(args[2], ctx, true) : bCrit;
        if (bCrit && bSum) {
          const rows = Math.min(bCrit.r1 - bCrit.r0 + 1, bSum.r1 - bSum.r0 + 1);
          const cols = Math.min(bCrit.c1 - bCrit.c0 + 1, bSum.c1 - bSum.c0 + 1);
          if (cols === 1 && rows > 4) {
            const nz = getNonZeroColEntries(bSum.tab, bSum.r0, bSum.r0 + rows - 1, bSum.c0);
            let sum = 0;
            for (let i = 0; i < nz.length; i++) {
              const { dr, sv } = nz[i];
              const cv = getCell(bCrit.tab, bCrit.r0 + dr, bCrit.c0);
              if (matcher(cv)) sum += sv;
            }
            return sum;
          }
          let sum = 0;
          for (let dr = 0; dr < rows; dr++) {
            for (let dc = 0; dc < cols; dc++) {
              const sv = getCell(bSum.tab, bSum.r0 + dr, bSum.c0 + dc);
              if (typeof sv !== "number" || !Number.isFinite(sv) || sv === 0) continue;
              const cv = getCell(bCrit.tab, bCrit.r0 + dr, bCrit.c0 + dc);
              if (matcher(cv)) sum += sv;
            }
          }
          return sum;
        }
        const critRange = evalTo2D(args[0], ctx, true);
        const sumRange = args.length >= 3 ? evalTo2D(args[2], ctx, true) : critRange;
        let sum = 0;
        const rows = Math.min(critRange.length, sumRange.length);
        for (let r = 0; r < rows; r++) {
          const cols = Math.min(critRange[r].length, sumRange[r].length);
          for (let c = 0; c < cols; c++) {
            const sv = sumRange[r][c];
            if (typeof sv !== "number" || !Number.isFinite(sv) || sv === 0) continue;
            if (matcher(critRange[r][c])) {
              sum += sv;
            }
          }
        }
        return sum;
      }

      case "SUMIFS": {
        const bSum = resolveRangeBounds(args[0], ctx, true);
        const fastPairs = [];
        let allDirectRanges = Boolean(bSum);
        for (let i = 1; i + 1 < args.length; i += 2) {
          const bCrit = allDirectRanges ? resolveRangeBounds(args[i], ctx, true) : null;
          if (!bCrit) allDirectRanges = false;
          fastPairs.push({
            bounds: bCrit,
            node: args[i],
            matcher: buildCriterionMatcher(evalScalar(args[i + 1], ctx)),
          });
        }
        if (allDirectRanges && bSum) {
          const rows = bSum.r1 - bSum.r0 + 1;
          const cols = bSum.c1 - bSum.c0 + 1;
          if (cols === 1 && rows > 4) {
            const nz = getNonZeroColEntries(bSum.tab, bSum.r0, bSum.r1, bSum.c0);
            let sum = 0;
            for (let i = 0; i < nz.length; i++) {
              const { dr, sv } = nz[i];
              let ok = true;
              for (let p = 0; p < fastPairs.length; p++) {
                const b = fastPairs[p].bounds;
                const cv = getCell(b.tab, b.r0 + dr, b.c0);
                if (!fastPairs[p].matcher(cv)) {
                  ok = false;
                  break;
                }
              }
              if (ok) sum += sv;
            }
            return sum;
          }
          let sum = 0;
          for (let dr = 0; dr < rows; dr++) {
            for (let dc = 0; dc < cols; dc++) {
              const sv = getCell(bSum.tab, bSum.r0 + dr, bSum.c0 + dc);
              if (typeof sv !== "number" || !Number.isFinite(sv) || sv === 0) continue;
              let ok = true;
              for (let p = 0; p < fastPairs.length; p++) {
                const b = fastPairs[p].bounds;
                const cv = getCell(b.tab, b.r0 + dr, b.c0 + dc);
                if (!fastPairs[p].matcher(cv)) {
                  ok = false;
                  break;
                }
              }
              if (ok) sum += sv;
            }
          }
          return sum;
        }
        const sumRange = evalTo2D(args[0], ctx, true);
        const pairs = fastPairs.map((fp) => ({
          range: evalTo2D(fp.node, ctx, true),
          matcher: fp.matcher,
        }));
        let sum = 0;
        const rows = sumRange.length;
        for (let r = 0; r < rows; r++) {
          const cols = sumRange[r]?.length || 0;
          for (let c = 0; c < cols; c++) {
            const sv = sumRange[r][c];
            if (typeof sv !== "number" || !Number.isFinite(sv) || sv === 0) continue;
            let ok = true;
            for (let p = 0; p < pairs.length; p++) {
              const cv = pairs[p].range[r]?.[c];
              if (!pairs[p].matcher(cv)) {
                ok = false;
                break;
              }
            }
            if (ok) sum += sv;
          }
        }
        return sum;
      }

      case "SUMPRODUCT": {
        const arrs = args.map((a) => evalTo2D(a, { ...ctx, arrayMode: true }, true));
        if (arrs.length === 0) return 0;
        const rows = arrs[0].length;
        const cols = arrs[0][0]?.length || 0;
        let total = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            let prod = 1;
            for (let k = 0; k < arrs.length; k++) {
              const v = arrs[k][r]?.[c];
              if (isSheetError(v)) throw toErrorObject(v);
              const n = typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0;
              prod *= n;
              if (prod === 0) break;
            }
            total += prod;
          }
        }
        return total;
      }

      case "FILTER": {
        const src = evalTo2D(args[0], { ...ctx, arrayMode: true }, true);
        const conds = args.slice(1).map((a) => evalTo2D(a, { ...ctx, arrayMode: true }, true));
        const rows = src.length;
        const out = [];
        for (let r = 0; r < rows; r++) {
          let keep = true;
          for (let k = 0; k < conds.length; k++) {
            const cv = conds[k][r]?.[0];
            if (isSheetError(cv) || !toBoolean(cv)) {
              keep = false;
              break;
            }
          }
          if (keep) {
            out.push([...src[r]]);
          }
        }
        if (out.length === 0) {
          throw new SheetError("#N/A", "No matches are found in FILTER evaluation.");
        }
        return out;
      }

      case "INDEX": {
        const rArg = args.length >= 2 && args[1].type !== "EmptyArg" ? Math.trunc(toNumberStrict(evalScalar(args[1], ctx))) : 0;
        const cArg = args.length >= 3 && args[2].type !== "EmptyArg" ? Math.trunc(toNumberStrict(evalScalar(args[2], ctx))) : 0;
        const b = resolveRangeBounds(args[0], ctx, true);
        if (b) {
          const numR = b.r1 - b.r0 + 1;
          const numC = b.c1 - b.c0 + 1;
          if (rArg > 0 && cArg > 0) {
            if (rArg > numR || cArg > numC) throw new SheetError("#REF!", "INDEX out of range");
            return getCell(b.tab, b.r0 + rArg - 1, b.c0 + cArg - 1);
          }
          if (rArg > 0 && cArg === 0) {
            if (numR === 1 && numC > 1) {
              if (rArg > numC) throw new SheetError("#REF!", "INDEX out of range");
              return getCell(b.tab, b.r0, b.c0 + rArg - 1);
            }
            if (rArg > numR) throw new SheetError("#REF!", "INDEX row out of range");
            if (numC === 1) return getCell(b.tab, b.r0 + rArg - 1, b.c0);
            return getRange2D(b.tab, b.r0 + rArg - 1, b.r0 + rArg - 1, b.c0, b.c1, true);
          }
          if (rArg === 0 && cArg > 0) {
            if (cArg > numC) throw new SheetError("#REF!", "INDEX col out of range");
            return getRange2D(b.tab, b.r0, b.r1, b.c0 + cArg - 1, b.c0 + cArg - 1, true);
          }
        }
        const arr = evalTo2D(args[0], ctx, true);
        if (rArg === 0 && cArg === 0) return arr;
        if (rArg === 0) {
          const ci = cArg - 1;
          if (ci < 0 || ci >= (arr[0]?.length || 0)) throw new SheetError("#REF!", "INDEX col out of range");
          return arr.map((row) => [row[ci]]);
        }
        if (cArg === 0) {
          if (arr.length === 1 && (arr[0]?.length || 0) > 1) {
            // 1D horizontal vector indexed by single arg
            const ci = rArg - 1;
            if (ci < 0 || ci >= arr[0].length) throw new SheetError("#REF!", "INDEX out of range");
            return arr[0][ci];
          }
          const ri = rArg - 1;
          if (ri < 0 || ri >= arr.length) throw new SheetError("#REF!", "INDEX row out of range");
          return arr[ri].length === 1 ? arr[ri][0] : [arr[ri]];
        }
        const ri = rArg - 1;
        const ci = cArg - 1;
        if (ri < 0 || ri >= arr.length || ci < 0 || ci >= (arr[ri]?.length || 0)) {
          throw new SheetError("#REF!", "INDEX out of range");
        }
        return arr[ri][ci];
      }

      case "MATCH":
      case "XMATCH": {
        const searchKey = evalScalar(args[0], ctx);
        if (isSheetError(searchKey)) throw toErrorObject(searchKey);
        const matchType = fn === "MATCH"
          ? (args.length >= 3 ? Math.trunc(toNumberStrict(evalScalar(args[2], ctx))) : 1)
          : (args.length >= 3 ? Math.trunc(toNumberStrict(evalScalar(args[2], ctx))) : 0);

        // Lazy evaluation when searching a 1D range with matchType === 0 (avoids self-referencing row/col cycles like 1:1 in AppData!BB1)
        const b = resolveRangeBounds(args[1], ctx, true);
        if (b && matchType === 0 && (b.r0 === b.r1 || b.c0 === b.c1)) {
          const isWildcard = typeof searchKey === "string" && (searchKey.includes("*") || searchKey.includes("?"));
          const matcher = isWildcard ? buildCriterionMatcher(searchKey) : null;
          if (b.r0 === b.r1) {
            let idx = 1;
            for (let c = b.c0; c <= b.c1; c++, idx++) {
              const cellVal = getCell(b.tab, b.r0, c);
              if (isSheetError(cellVal)) continue;
              if (matcher ? matcher(cellVal) : compareSheetValues(cellVal, searchKey, "=")) {
                return idx;
              }
            }
          } else {
            let idx = 1;
            for (let r = b.r0; r <= b.r1; r++, idx++) {
              const cellVal = getCell(b.tab, r, b.c0);
              if (isSheetError(cellVal)) continue;
              if (matcher ? matcher(cellVal) : compareSheetValues(cellVal, searchKey, "=")) {
                return idx;
              }
            }
          }
          throw new SheetError("#N/A", `Did not find value '${searchKey}' in ${fn} evaluation.`);
        }

        const range2D = evalTo2D(args[1], ctx, true);

        const flat = [];
        if (range2D.length === 1) {
          for (let c = 0; c < range2D[0].length; c++) flat.push(range2D[0][c]);
        } else {
          for (let r = 0; r < range2D.length; r++) flat.push(range2D[r][0]);
        }

        if (matchType === 0) {
          const isWildcard = typeof searchKey === "string" && (searchKey.includes("*") || searchKey.includes("?"));
          const matcher = isWildcard ? buildCriterionMatcher(searchKey) : null;
          for (let i = 0; i < flat.length; i++) {
            if (isSheetError(flat[i])) continue;
            if (matcher ? matcher(flat[i]) : compareSheetValues(flat[i], searchKey, "=")) {
              return i + 1;
            }
          }
          throw new SheetError("#N/A", `Did not find value '${searchKey}' in ${fn} evaluation.`);
        }

        // Approximate match (matchType === 1)
        let bestIdx = -1;
        for (let i = 0; i < flat.length; i++) {
          if (isSheetError(flat[i])) continue;
          if (flat[i] !== null && flat[i] !== "" && compareSheetValues(flat[i], searchKey, "<=")) {
            bestIdx = i + 1;
          }
        }
        if (bestIdx === -1) throw new SheetError("#N/A", `Did not find value '${searchKey}' in ${fn} evaluation.`);
        return bestIdx;
      }

      case "XLOOKUP": {
        const searchKey = evalAST(args[0], ctx);
        const lookupRange = evalTo2D(args[1], ctx, true);
        const returnRange = evalTo2D(args[2], ctx, true);
        const notFoundVal = args.length >= 4 ? evalScalar(args[3], ctx) : new SheetError("#N/A", "XLOOKUP not found");
        const matchMode = args.length >= 5 ? Math.trunc(toNumberStrict(evalScalar(args[4], ctx))) : 0;

        const lookupOne = (key) => {
          const matcher = matchMode === 2 ? buildCriterionMatcher(key) : null;
          for (let r = 0; r < lookupRange.length; r++) {
            const cell = lookupRange[r][0];
            if (matcher ? matcher(cell) : compareSheetValues(cell, key, "=")) {
              return returnRange[r]?.[0] ?? null;
            }
          }
          if (notFoundVal instanceof SheetError) throw notFoundVal;
          return notFoundVal;
        };

        return mapArrayScalar(searchKey, lookupOne);
      }

      case "VLOOKUP": {
        const searchKey = evalAST(args[0], ctx);
        const table = evalTo2D(args[1], ctx, true);
        const colIdx = Math.trunc(toNumberStrict(evalScalar(args[2], ctx))) - 1;
        const isSorted = args.length >= 4 ? toBoolean(evalScalar(args[3], ctx)) : true;

        const lookupOne = (key) => {
          if (!isSorted) {
            for (let r = 0; r < table.length; r++) {
              if (compareSheetValues(table[r][0], key, "=")) {
                return table[r]?.[colIdx] ?? null;
              }
            }
            throw new SheetError("#N/A", `Did not find value '${key}' in VLOOKUP evaluation.`);
          }
          let bestR = -1;
          for (let r = 0; r < table.length; r++) {
            if (!isBlankVal(table[r][0]) && compareSheetValues(table[r][0], key, "<=")) {
              bestR = r;
            }
          }
          if (bestR < 0) throw new SheetError("#N/A", "VLOOKUP not found");
          return table[bestR]?.[colIdx] ?? null;
        };

        return mapArrayScalar(searchKey, lookupOne);
      }

      case "OFFSET":
      case "INDIRECT": {
        const b = resolveRangeBounds(node, ctx, true);
        return b.isSingle ? getCell(b.tab, b.r0, b.c0) : getRange2D(b.tab, b.r0, b.r1, b.c0, b.c1, true);
      }

      case "ROW": {
        if (args.length === 0) return ctx.r + 1;
        const b = resolveRangeBounds(args[0], ctx, true);
        if (!b) return ctx.r + 1;
        if (b.r0 === b.r1) return b.r0 + 1;
        const out = [];
        for (let r = b.r0; r <= b.r1; r++) out.push([r + 1]);
        return out;
      }

      case "ROWS": {
        // Notice in InvoicesSent/CashIncomingConf/CashIncomingPipe/ContrPayments:
        // ROWS(raw_col_A) where raw_col_A is Monthly!$A:$A -> returns total rows in Monthly
        if (args[0].type === "VarOrRef" || args[0].type === "Ref" || args[0].type === "RangeOp") {
          const arr = evalTo2D(args[0], ctx, false);
          return arr.length;
        }
        const arr = evalTo2D(args[0], ctx, true);
        return arr.length;
      }

      case "COLUMN": {
        if (args.length === 0) return ctx.c + 1;
        const b = resolveRangeBounds(args[0], ctx, true);
        return b ? b.c0 + 1 : ctx.c + 1;
      }

      case "ADDRESS": {
        const rNum = Math.trunc(toNumberStrict(evalScalar(args[0], ctx)));
        const cNum = Math.trunc(toNumberStrict(evalScalar(args[1], ctx)));
        const absMode = args.length >= 3 ? Math.trunc(toNumberStrict(evalScalar(args[2], ctx))) : 1;
        const colStr = colIndexToLetters(cNum - 1);
        if (absMode === 4) return `${colStr}${rNum}`;
        if (absMode === 3) return `$${colStr}${rNum}`;
        if (absMode === 2) return `${colStr}$${rNum}`;
        return `$${colStr}$${rNum}`;
      }

      case "TRANSPOSE": {
        const arr = evalTo2D(args[0], ctx, true);
        const rows = arr.length;
        const cols = arr[0]?.length || 0;
        const out = [];
        for (let c = 0; c < cols; c++) {
          const row = [];
          for (let r = 0; r < rows; r++) {
            row.push(arr[r][c]);
          }
          out.push(row);
        }
        return out;
      }

      case "HSTACK": {
        const mats = args.map((a) => evalTo2D(a, ctx, true));
        let maxR = 0;
        for (const m of mats) if (m.length > maxR) maxR = m.length;
        const out = [];
        for (let r = 0; r < maxR; r++) {
          const row = [];
          for (const m of mats) {
            const cols = m[0]?.length || 1;
            const mr = m[r];
            for (let c = 0; c < cols; c++) {
              row.push(mr ? (mr[c] ?? "") : "");
            }
          }
          out.push(row);
        }
        return out;
      }

      case "VSTACK": {
        const mats = args.map((a) => evalTo2D(a, ctx, true));
        let maxC = 0;
        for (const m of mats) {
          const c = m[0]?.length || 0;
          if (c > maxC) maxC = c;
        }
        const out = [];
        for (const m of mats) {
          for (const r of m) {
            const row = [...r];
            while (row.length < maxC) row.push("");
            out.push(row);
          }
        }
        return out;
      }

      case "CHOOSEROWS": {
        const arr = evalTo2D(args[0], ctx, false);
        const indices = [];
        for (let i = 1; i < args.length; i++) {
          const v = evalAST(args[i], ctx);
          if (Array.isArray(v)) {
            for (const r of v) for (const c of r) indices.push(Math.trunc(toNumberStrict(c)));
          } else {
            indices.push(Math.trunc(toNumberStrict(v)));
          }
        }
        const out = [];
        for (const idx of indices) {
          const rIdx = idx < 0 ? arr.length + idx : idx - 1;
          if (rIdx < 0 || rIdx >= arr.length) throw new SheetError("#VALUE!", "CHOOSEROWS out of bounds");
          out.push([...arr[rIdx]]);
        }
        return out.length === 1 && out[0].length === 1 ? out[0][0] : out;
      }

      case "CHOOSECOLS": {
        const arr = evalTo2D(args[0], ctx, true);
        const indices = [];
        for (let i = 1; i < args.length; i++) {
          const v = evalAST(args[i], ctx);
          if (Array.isArray(v)) {
            for (const r of v) for (const c of r) indices.push(Math.trunc(toNumberStrict(c)));
          } else {
            indices.push(Math.trunc(toNumberStrict(v)));
          }
        }
        const cols = arr[0]?.length || 0;
        return arr.map((row) =>
          indices.map((idx) => {
            const cIdx = idx < 0 ? cols + idx : idx - 1;
            return row[cIdx] ?? "";
          })
        );
      }

      case "FLATTEN":
      case "TOCOL": {
        const out = [];
        for (const a of args) {
          const arr = evalTo2D(a, ctx, true);
          for (const row of arr) {
            for (const cell of row) {
              out.push([cell]);
            }
          }
        }
        return out;
      }

      case "SEQUENCE": {
        const rows = Math.max(0, Math.trunc(toNumberStrict(evalScalar(args[0], ctx))));
        const cols = args.length >= 2 ? Math.max(1, Math.trunc(toNumberStrict(evalScalar(args[1], ctx)))) : 1;
        const start = args.length >= 3 ? toNumberStrict(evalScalar(args[2], ctx)) : 1;
        const step = args.length >= 4 ? toNumberStrict(evalScalar(args[3], ctx)) : 1;
        const out = [];
        let cur = start;
        for (let r = 0; r < rows; r++) {
          const row = [];
          for (let c = 0; c < cols; c++) {
            row.push(cur);
            cur += step;
          }
          out.push(row);
        }
        return out;
      }

      case "SORT": {
        const arr = evalTo2D(args[0], ctx, true);
        const sortCol = args.length >= 2 ? Math.trunc(toNumberStrict(evalScalar(args[1], ctx))) - 1 : 0;
        const isAsc = args.length >= 3 ? toBoolean(evalScalar(args[2], ctx)) : true;
        // In Google Sheets SORT, blank rows sort to the bottom
        const nonBlank = [];
        const blank = [];
        for (const row of arr) {
          const allEmpty = row.every((c) => isBlankVal(c));
          if (allEmpty) blank.push(row);
          else nonBlank.push(row);
        }
        nonBlank.sort((a, b) => {
          const va = a[sortCol];
          const vb = b[sortCol];
          if (compareSheetValues(va, vb, "=")) return 0;
          const lt = compareSheetValues(va, vb, "<");
          return isAsc ? (lt ? -1 : 1) : (lt ? 1 : -1);
        });
        return [...nonBlank, ...blank];
      }

      case "UNIQUE": {
        const arr = evalTo2D(args[0], ctx, true);
        const seen = new Set();
        const out = [];
        for (const row of arr) {
          const key = row.map((c) => (isBlankVal(c) ? "" : String(c))).join("\u0000");
          if (!seen.has(key)) {
            seen.add(key);
            out.push(row);
          }
        }
        return out;
      }

      case "SPLIT": {
        const val = evalAST(args[0], ctx);
        const delim = toStringVal(evalScalar(args[1], ctx));
        const splitByEach = args.length >= 3 ? toBoolean(evalScalar(args[2], ctx)) : true;
        const removeEmpty = args.length >= 4 ? toBoolean(evalScalar(args[3], ctx)) : true;

        const splitOne = (strVal) => {
          const s = toStringVal(strVal);
          if (!s) return [""];
          let parts;
          if (splitByEach && delim.length > 1) {
            const escaped = delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            parts = s.split(new RegExp(`[${escaped}]`));
          } else {
            parts = s.split(delim);
          }
          if (removeEmpty) parts = parts.filter((p) => p !== "");
          return parts.map((p) => {
            const trimmed = p.trim();
            if (trimmed !== "" && /^-?\d+(\.\d+)?$/.test(trimmed)) {
              return Number(trimmed);
            }
            return p;
          });
        };

        if (Array.isArray(val)) {
          const rows = [];
          let maxCols = 1;
          for (const r of val) {
            const p = splitOne(r[0]);
            if (p.length > maxCols) maxCols = p.length;
            rows.push(p);
          }
          for (const r of rows) {
            while (r.length < maxCols) r.push("");
          }
          return rows;
        }
        return [splitOne(val)];
      }

      case "JOIN": {
        const delim = toStringVal(evalScalar(args[0], ctx));
        const parts = [];
        for (let i = 1; i < args.length; i++) {
          const v = evalAST(args[i], ctx);
          if (Array.isArray(v)) {
            for (const r of v) for (const c of r) parts.push(toStringVal(c));
          } else {
            parts.push(toStringVal(v));
          }
        }
        return parts.join(delim);
      }

      case "QUERY": {
        const data = evalTo2D(args[0], ctx, true);
        const qStr = toStringVal(evalScalar(args[1], ctx)).trim();
        // Pattern 1: "SELECT * WHERE Col1 IS NOT NULL" or "where Col4 is not null"
        const whereNotNullMatch = qStr.match(/where\s+Col(\d+)\s+is\s+not\s+null/i);
        if (whereNotNullMatch) {
          const colIdx = parseInt(whereNotNullMatch[1], 10) - 1;
          const filtered = data.filter((row) => {
            const v = row[colIdx];
            return v !== null && v !== undefined && v !== "";
          });
          if (filtered.length === 0) throw new SheetError("#N/A", "Query completed with an empty output.");
          return filtered;
        }
        // Pattern 2: "Select Col29"
        const selectColMatch = qStr.match(/^select\s+Col(\d+)$/i);
        if (selectColMatch) {
          const colIdx = parseInt(selectColMatch[1], 10) - 1;
          const out = data.map((row) => [row[colIdx] ?? ""]);
          return out.length === 1 ? out[0][0] : out;
        }
        return data;
      }

      case "DATE": {
        const y = Math.trunc(toNumberStrict(evalScalar(args[0], ctx)));
        const m = Math.trunc(toNumberStrict(evalScalar(args[1], ctx)));
        const d = Math.trunc(toNumberStrict(evalScalar(args[2], ctx)));
        return utcDateToSerial(y < 100 ? 1900 + y : y, m, d);
      }

      case "DATEVALUE": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, parseDateValueString);
      }

      case "YEAR": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => serialToYMD(toNumberStrict(x))[0]);
      }

      case "MONTH": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => serialToYMD(toNumberStrict(x))[1]);
      }

      case "DAY": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => serialToYMD(toNumberStrict(x))[2]);
      }

      case "DAYS": {
        const endD = toNumberStrict(evalScalar(args[0], ctx));
        const startD = toNumberStrict(evalScalar(args[1], ctx));
        return Math.floor(endD) - Math.floor(startD);
      }

      case "DATEDIF": {
        const s = evalScalar(args[0], ctx);
        const e = evalScalar(args[1], ctx);
        const u = evalScalar(args[2], ctx);
        return datedifSerial(s, e, u);
      }

      case "EOMONTH": {
        const s = evalAST(args[0], ctx);
        const m = evalAST(args[1], ctx);
        return broadcastBinaryOp("EOMONTH", s, m, eomonthSerial);
      }

      case "EDATE": {
        const s = evalAST(args[0], ctx);
        const m = evalAST(args[1], ctx);
        return broadcastBinaryOp("EDATE", s, m, edateSerial);
      }

      case "TODAY":
        return todaySerial;

      case "ROUND": {
        const v = evalAST(args[0], ctx);
        const dec = args.length >= 2 ? Math.trunc(toNumberStrict(evalScalar(args[1], ctx))) : 0;
        return mapArrayScalar(v, (x) => roundHalfAwayFromZero(toNumberStrict(x), dec));
      }

      case "MROUND": {
        const n = toNumberStrict(evalScalar(args[0], ctx));
        const mult = toNumberStrict(evalScalar(args[1], ctx));
        if (mult === 0) return 0;
        return Math.round(n / mult) * mult;
      }

      case "INT": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => Math.floor(toNumberStrict(x)));
      }

      case "ABS": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => Math.abs(toNumberStrict(x)));
      }

      case "VALUE": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => {
          if (typeof x === "number") return x;
          return toNumberStrict(x);
        });
      }

      case "N": {
        const v = evalScalar(args[0], ctx);
        if (isSheetError(v)) throw toErrorObject(v);
        if (typeof v === "number") return v;
        if (typeof v === "boolean") return v ? 1 : 0;
        return 0;
      }

      case "TEXT": {
        const v = evalAST(args[0], ctx);
        const fmt = toStringVal(evalScalar(args[1], ctx));
        return mapArrayScalar(v, (x) => formatTextFunction(x, fmt));
      }

      case "TO_TEXT": {
        const v = evalAST(args[0], ctx);
        if (ctx.tab === "AppData" && Array.isArray(v)) {
          // In AppData!BE1, BN1, BW1: TO_TEXT($A$1:$AX$34) formats row 1 as MMM-YY, % rows (20,28,32,34) as 0%, and currency rows as £#,##0
          const pctRows = new Set([19, 27, 31, 33]);
          return v.map((row, rIdx) =>
            row.map((cell) => {
              if (isSheetError(cell)) return String(cell);
              if (typeof cell === "number" && Number.isFinite(cell)) {
                if (rIdx === 0 && cell >= 35000 && cell <= 65000) {
                  const [y, m] = serialToYMD(cell);
                  return `${MONTH_NAMES_SHORT[m - 1]}-${String(y).slice(-2)}`;
                }
                if (pctRows.has(rIdx)) {
                  return `${roundHalfAwayFromZero(cell * 100, 0)}%`;
                }
                if (rIdx > 0) {
                  return String(roundHalfAwayFromZero(cell, 0));
                }
              }
              return toStringVal(cell);
            })
          );
        }
        // In OutgNotes!DW3: "OG-" & TO_TEXT(CH3:CH1000) formats date serial CH3 as D-MMM-YY ("1-Jul-25")
        const hint = ctx.tab === "OutgNotes" && ctx.c === 126 ? "TO_TEXT_OUTGNOTES_DATE" : null;
        return mapArrayScalar(v, (x) => (isSheetError(x) ? String(x) : toStringVal(x, hint)));
      }

      case "LEFT": {
        const v = evalAST(args[0], ctx);
        const n = args.length >= 2 ? Math.max(0, Math.trunc(toNumberStrict(evalScalar(args[1], ctx)))) : 1;
        return mapArrayScalar(v, (x) => toStringVal(x).slice(0, n));
      }

      case "RIGHT": {
        const v = evalAST(args[0], ctx);
        const n = args.length >= 2 ? Math.max(0, Math.trunc(toNumberStrict(evalScalar(args[1], ctx)))) : 1;
        const hint = ctx.r === 0 ? "HEADER_DATE_RIGHT" : null;
        return mapArrayScalar(v, (x) => {
          const s = toStringVal(x, hint);
          return n === 0 ? "" : s.slice(-n);
        });
      }

      case "MID": {
        const v = evalAST(args[0], ctx);
        const start = Math.max(1, Math.trunc(toNumberStrict(evalScalar(args[1], ctx))));
        const len = Math.max(0, Math.trunc(toNumberStrict(evalScalar(args[2], ctx))));
        return mapArrayScalar(v, (x) => toStringVal(x).slice(start - 1, start - 1 + len));
      }

      case "LEN": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => toStringVal(x).length);
      }

      case "LOWER": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => toStringVal(x).toLowerCase());
      }

      case "UPPER": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => toStringVal(x).toUpperCase());
      }

      case "TRIM": {
        const v = evalAST(args[0], ctx);
        return mapArrayScalar(v, (x) => toStringVal(x).trim().replace(/\s+/g, " "));
      }

      case "SUBSTITUTE": {
        const text = evalAST(args[0], ctx);
        const searchFor = toStringVal(evalScalar(args[1], ctx));
        const replaceWith = toStringVal(evalScalar(args[2], ctx));
        if (!searchFor) return text;
        return mapArrayScalar(text, (x) => toStringVal(x).split(searchFor).join(replaceWith));
      }

      case "CONCATENATE":
      case "CONCAT": {
        let out = "";
        for (const a of args) {
          const v = evalAST(a, ctx);
          if (Array.isArray(v)) {
            for (const r of v) for (const c of r) out += toStringVal(c);
          } else {
            out += toStringVal(v);
          }
        }
        return out;
      }

      case "REGEXEXTRACT": {
        const textVal = evalAST(args[0], ctx);
        const patVal = evalAST(args[1], ctx);
        return broadcastBinaryOp("REGEXEXTRACT", textVal, patVal, (t, p) => {
          const s = toStringVal(t);
          const { pattern, flags } = parseRe2Pattern(toStringVal(p), false);
          const re = new RegExp(pattern, flags);
          const m = s.match(re);
          if (!m) throw new SheetError("#N/A", "Did not match REGEXEXTRACT");
          return m.length > 1 ? m[1] : m[0];
        });
      }

      case "REGEXMATCH": {
        const textVal = evalAST(args[0], ctx);
        const patVal = evalAST(args[1], ctx);
        return broadcastBinaryOp("REGEXMATCH", textVal, patVal, (t, p) => {
          if (typeof t === "number" || typeof t === "boolean") {
            throw new SheetError("#VALUE!", "REGEXMATCH requires text");
          }
          const s = toStringVal(t);
          const { pattern, flags } = parseRe2Pattern(toStringVal(p), false);
          const re = new RegExp(pattern, flags);
          return re.test(s);
        });
      }

      case "REGEXREPLACE": {
        const textVal = evalAST(args[0], ctx);
        const patStr = toStringVal(evalScalar(args[1], ctx));
        const replStr = toStringVal(evalScalar(args[2], ctx));
        const { pattern, flags } = parseRe2Pattern(patStr, true);
        const re = new RegExp(pattern, flags);
        return mapArrayScalar(textVal, (t) => toStringVal(t).replace(re, replStr));
      }

      case "FORMULATEXT": {
        const b = resolveRangeBounds(args[0], ctx, false);
        if (!b) throw new SheetError("#N/A", "Invalid reference in FORMULATEXT");
        const f = grids[b.tab]?.formulas?.[b.r0]?.[b.c0];
        if (typeof f === "string" && f.startsWith("=")) return f;
        throw new SheetError("#N/A", "Formula not found");
      }

      case "IMPORTRANGE": {
        const urlStr = toStringVal(evalScalar(args[0], ctx));
        const rangeStr = toStringVal(evalScalar(args[1], ctx));
        const selfUrl = toStringVal(getCell("KeyInfo", 0, 2)); // KeyInfo!C1
        const selfIdMatch = selfUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
        const selfId = selfIdMatch ? selfIdMatch[1] : selfUrl;
        if (selfId && urlStr.includes(selfId)) {
          const b = parseIndirectRangeString(rangeStr, ctx.tab, false);
          return b.isSingle ? getCell(b.tab, b.r0, b.c0) : getRange2D(b.tab, b.r0, b.r1, b.c0, b.c1, false);
        }
        return PRESERVE_EXISTING_SPILL;
      }

      default:
        throw new SheetError("#NAME?", `Unknown function: ${fn}`);
    }
  }

  function invokeLambda(lambdaObj, argVals) {
    const { paramNames, bodyAst, closureCtx } = lambdaObj;
    const callEnv = new Map(closureCtx.env);
    for (let i = 0; i < paramNames.length; i++) {
      callEnv.set(paramNames[i], argVals[i] ?? null);
    }
    return evalAST(bodyAst, { ...closureCtx, env: callEnv });
  }

  function buildCriterionMatcher(critRaw) {
    if (critRaw === null || critRaw === undefined || critRaw === "") {
      return (v) => isBlankVal(v);
    }
    if (typeof critRaw === "number") {
      return (v) => typeof v === "number" && Math.abs(v - critRaw) <= 1e-11;
    }
    if (typeof critRaw === "boolean") {
      return (v) => v === critRaw;
    }
    const s = String(critRaw);
    const opMatch = s.match(/^(<=|>=|<>|<|>|=)(.*)$/);
    if (opMatch) {
      const op = opMatch[1];
      const rhsRaw = opMatch[2].trim();
      if (rhsRaw === "") {
        return op === "<>" ? (v) => !isBlankVal(v) : (v) => isBlankVal(v);
      }
      if (rhsRaw.toUpperCase() === "TRUE" || rhsRaw.toUpperCase() === "FALSE") {
        const bVal = rhsRaw.toUpperCase() === "TRUE";
        return (v) => compareSheetValues(v, bVal, op);
      }
      const numVal = Number(rhsRaw);
      if (rhsRaw !== "" && Number.isFinite(numVal)) {
        if (op === "=") return (v) => typeof v === "number" && Math.abs(v - numVal) <= 1e-11;
        if (op === "<>") return (v) => !(typeof v === "number" && Math.abs(v - numVal) <= 1e-11);
        // In Google Sheets SUMIF/SUMIFS/COUNTIF, numeric >, >=, <, <= ONLY match numeric cells!
        return (v) => typeof v === "number" && Number.isFinite(v) && compareSheetValues(v, numVal, op);
      }
      const lowerRhs = rhsRaw.toLowerCase();
      if (op === "<>") {
        return (v) => (isBlankVal(v) ? "" : String(v).toLowerCase()) !== lowerRhs;
      }
      if (op === "=") {
        return (v) => (isBlankVal(v) ? "" : String(v).toLowerCase()) === lowerRhs;
      }
      return (v) => compareSheetValues(v, rhsRaw, op);
    }

    if (s.includes("*") || s.includes("?")) {
      const regexStr =
        "^" +
        s
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$";
      const re = new RegExp(regexStr, "i");
      return (v) => !isBlankVal(v) && re.test(String(v));
    }

    const numVal = Number(s);
    if (s.trim() !== "" && Number.isFinite(numVal)) {
      return (v) =>
        (typeof v === "number" && Math.abs(v - numVal) <= 1e-11) ||
        (typeof v === "string" && v.trim() === s.trim());
    }

    const lowerS = s.toLowerCase();
    return (v) => !isBlankVal(v) && String(v).toLowerCase() === lowerS;
  }

  function parseRe2Pattern(pat, globalFlag = false) {
    let flags = globalFlag ? "g" : "";
    let p = pat;
    if (p.startsWith("(?i)")) {
      flags += "i";
      p = p.slice(4);
    }
    return { pattern: p, flags };
  }

  // ============================================================================
  // 5. EXECUTE RECALCULATION IN TOPOLOGICAL TAB ORDER
  // ============================================================================

  const tabOrder = [
    "KeyInfo",
    "Confirmed",
    "Pipeline",
    "ConfCalcs",
    "PipeCalcs",
    "Calcs",
    "Salaries",
    "OutgNotes",
    "Outgoings",
    "Monthly",
    "Budget",
    "NBtoFind",
    "ErrorCheck",
    "Performance",
    "VAT",
    "Cash",
    "Dashboard",
    "GPbyPL",
    "Year0Data",
    "AppData",
    "RevenueConf",
    "RevenuePipe",
    "InvoicesSent",
    "CashIncomingConf",
    "CashIncomingPipe",
    "ContrPayments",
    "DataForReport",
    "Report",
  ];
  if (options.includeFormCheck) {
    tabOrder.push("FormCheck");
  }

  function evaluateTabFormulasPass(tab, resetStates = false) {
    if (!resetStates && unaffectedTabs && unaffectedTabs.has(tab)) return;
    const t = grids[tab];
    if (!t || !Array.isArray(t.formulas)) return;
    const dims = tabDims[tab];
    if (resetStates && dims) {
      cellState[tab].fill(0);
      tabSpillsInitialized.delete(tab);
      rangeCacheByTab[tab]?.clear();
    }
    ensureTabSpillsEvaluated(tab);

    const maxR = activeRowLimitByTab[tab] !== undefined ? activeRowLimitByTab[tab] : t.formulas.length - 1;
    if (tab === "ConfCalcs" || tab === "PipeCalcs") {
      // Evaluate row formulas EO..IK (c < 253) across all active rows BEFORE column-spill formulas IT2:JC2 (c >= 253)
      for (let r = 0; r <= maxR && r < t.formulas.length; r++) {
        const rowF = t.formulas[r];
        if (!rowF) continue;
        const limitC = Math.min(rowF.length, 253);
        for (let c = 0; c < limitC; c++) {
          const f = rowF[c];
          if (typeof f === "string" && f.startsWith("=")) {
            evalCell(tab, r, c);
          }
        }
      }
      for (let r = 0; r <= maxR && r < t.formulas.length; r++) {
        const rowF = t.formulas[r];
        if (!rowF) continue;
        for (let c = 253; c < rowF.length; c++) {
          const f = rowF[c];
          if (typeof f === "string" && f.startsWith("=")) {
            evalCell(tab, r, c);
          }
        }
      }
    } else {
      for (let r = 0; r <= maxR && r < t.formulas.length; r++) {
        const rowF = t.formulas[r];
        if (!rowF) continue;
        for (let c = 0; c < rowF.length; c++) {
          const f = rowF[c];
          if (typeof f === "string" && f.startsWith("=")) {
            evalCell(tab, r, c);
          }
        }
      }
    }

    // Clone evaluated template blank row (maxR) to remaining inactive rows in Confirmed, Pipeline, ConfCalcs, PipeCalcs
    if (activeRowLimitByTab[tab] !== undefined && maxR < t.values.length - 1) {
      const templateRow = t.values[maxR] || [];
      const srcSpillLen =
        tab === "PipeCalcs"
          ? grids.Pipeline?.values?.length || t.values.length
          : tab === "ConfCalcs"
            ? grids.Confirmed?.values?.length || t.values.length
            : t.values.length;
      const sharedInactiveRow = [...templateRow];
      for (let r = maxR + 1; r < t.values.length; r++) {
        if ((tab === "ConfCalcs" || tab === "PipeCalcs") && r >= srcSpillLen) {
          if (!t.values[r] || t.values[r] === sharedInactiveRow) t.values[r] = [];
          const rowF = t.formulas[r] || [];
          // Row is beyond the source Confirmed/Pipeline spill range (e.g. PipeCalcs row 1001): evaluate its own formulas directly
          for (let c = 0; c < rowF.length; c++) {
            const f = rowF[c];
            if (typeof f === "string" && f.startsWith("=")) {
              const dims = tabDims[tab];
              if (dims && r < dims.rows && c < dims.cols) cellState[tab][r * dims.cols + c] = 0;
              evalCell(tab, r, c);
            }
          }
          continue;
        }
        t.values[r] = sharedInactiveRow;
      }
      rangeCacheByTab[tab]?.clear();
    }
  }

  function hasTabValuesChanged_(tab, prevSnapshot) {
    const cur = grids[tab]?.values || [];
    if (cur.length !== prevSnapshot.length) return true;
    for (let r = 0; r < cur.length; r++) {
      const rCur = cur[r] || [];
      const rPrev = prevSnapshot[r] || [];
      const len = Math.max(rCur.length, rPrev.length);
      for (let c = 0; c < len; c++) {
        const a = rCur[c] ?? null;
        const b = rPrev[c] ?? null;
        if (a === b) continue;
        if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9) continue;
        return true;
      }
    }
    return false;
  }

  function snapshotTabValues_(tab) {
    const cur = grids[tab]?.values || [];
    return cur.map((r) => (Array.isArray(r) ? [...r] : []));
  }

  for (const tab of tabOrder) {
    if (onlyTabs && !onlyTabs.has(tab)) continue;
    const tStart = options._profile ? Date.now() : 0;
    evaluateTabFormulasPass(tab, false);
    if (tab === "Budget" && !(unaffectedTabs && unaffectedTabs.has("Budget"))) {
      // Budget has an iterative feedback loop between Row 142 (CoS top-up) and Rows 257-260 (Profit share bonus)
      for (let iter = 0; iter < 12; iter++) {
        const snap = snapshotTabValues_("Budget");
        evaluateTabFormulasPass("Budget", true);
        if (!hasTabValuesChanged_("Budget", snap)) break;
      }
    }
    if (tab === "Dashboard") {
      // Outgoings <-> Performance <-> Dashboard form an iterative feedback loop (Outgoings Row 111 CoS top-up & Row 235 Bonus)
      let anyOutgoingsChange = false;
      for (let iter = 0; iter < 10; iter++) {
        const snapOut = snapshotTabValues_("Outgoings");
        evaluateTabFormulasPass("Outgoings", true);
        if (!hasTabValuesChanged_("Outgoings", snapOut)) {
          break;
        }
        anyOutgoingsChange = true;
        evaluateTabFormulasPass("Performance", true);
        evaluateTabFormulasPass("Dashboard", true);
      }
      if (anyOutgoingsChange) {
        // Re-evaluate downstream cells that depend on Outgoings / Performance / Dashboard:
        // In Monthly, only columns 132..140 (EC..EK) depend on Outgoings!
        const mTab = grids.Monthly;
        const mDims = tabDims.Monthly;
        if (mTab && mDims) {
          rangeCacheByTab.Monthly?.clear();
          for (let r = 0; r < mDims.rows; r++) {
            for (let c = 132; c <= Math.min(140, mDims.cols - 1); c++) {
              cellState.Monthly[r * mDims.cols + c] = 0;
            }
          }
          for (let r = 0; r < mTab.formulas.length; r++) {
            const rowF = mTab.formulas[r];
            if (!rowF) continue;
            for (let c = 132; c <= Math.min(140, rowF.length - 1); c++) {
              const f = rowF[c];
              if (typeof f === "string" && f.startsWith("=")) {
                evalCell("Monthly", r, c);
              }
            }
          }
        }
        for (const downstreamTab of ["VAT", "Cash"]) {
          evaluateTabFormulasPass(downstreamTab, true);
        }
      }
    }
    if (options._profile) {
      const elapsed = Date.now() - tStart;
      if (elapsed > 10) console.log(`[profile] ${tab.padEnd(18)} ${elapsed} ms`);
    }
  }

  // 6. Normalize `null` (BLANK) back to `""` across all values_grid cells for JSON storage parity
  for (const [, t] of Object.entries(grids)) {
    if (!t || !Array.isArray(t.values)) continue;
    for (let r = 0; r < t.values.length; r++) {
      const row = t.values[r];
      if (!Array.isArray(row)) continue;
      if (r > 0 && row === t.values[r - 1]) continue;
      for (let c = 0; c < row.length; c++) {
        if (row[c] === null || row[c] === undefined) {
          row[c] = "";
        }
      }
    }
  }

  return grids;
}

function isPotentialSpillFormula_(f) {
  const u = f.toUpperCase();
  return (
    u.startsWith("={") ||
    u.startsWith("= {") ||
    u.includes("ARRAYFORMULA(") ||
    u.includes("FILTER(") ||
    u.includes("TRANSPOSE(") ||
    u.includes("HSTACK(") ||
    u.includes("VSTACK(") ||
    u.includes("SORT(") ||
    u.includes("MAP(") ||
    u.includes("QUERY(") ||
    u.includes("IMPORTRANGE(")
  );
}

function findLastActiveJobRow_(values, minDefault = 50) {
  if (!Array.isArray(values)) return minDefault;
  let last = 1;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!Array.isArray(row)) continue;
    // Check client name (A=0), job name (B=1), amount (AG=32), type (AJ=35), inv1 (AP=41)
    if (
      (row[0] !== "" && row[0] !== null && row[0] !== undefined) ||
      (row[1] !== "" && row[1] !== null && row[1] !== undefined) ||
      (row[32] !== "" && row[32] !== null && row[32] !== undefined && row[32] !== 0) ||
      (row[35] !== "" && row[35] !== null && row[35] !== undefined) ||
      (row[41] !== "" && row[41] !== null && row[41] !== null && row[41] !== undefined && row[41] !== 0)
    ) {
      last = r;
    }
  }
  return Math.max(last, minDefault);
}

function ensureJobRowFormulasPopulated_(grids) {
  for (const tab of ["Confirmed", "Pipeline", "ConfCalcs", "PipeCalcs"]) {
    const t = grids[tab];
    if (!t || !Array.isArray(t.formulas) || !t.formulas[1]) continue;
    const templateRowF = t.formulas[1]; // Row 2 (r=1)
    const srcTab = tab === "ConfCalcs" ? "Confirmed" : tab === "PipeCalcs" ? "Pipeline" : tab;
    const maxR = Math.min(findLastActiveJobRow_(grids[srcTab]?.values) + 1, t.formulas.length - 1);
    for (let r = 2; r <= maxR; r++) {
      if (!t.formulas[r]) t.formulas[r] = [];
      for (let c = 0; c < templateRowF.length; c++) {
        const tf = templateRowF[c];
        if (typeof tf === "string" && tf.startsWith("=") && !isPotentialSpillFormula_(tf)) {
          if (!t.formulas[r][c]) {
            t.formulas[r][c] = shiftRowFormulaFromRow2_(tf, r + 1);
          }
        }
      }
    }
  }
}

function shiftRowFormulaFromRow2_(formulaRow2, targetRow1) {
  const delta = targetRow1 - 2;
  if (delta === 0) return formulaRow2;
  // Replace relative row numbers (not preceded by $) in cell refs
  return formulaRow2.replace(/(?<![A-Za-z0-9_])(\$?[A-Za-z]{1,3})(\$?)(\d+)(?![0-9(])/g, (match, colPart, dollarRow, rowStr) => {
    if (dollarRow === "$") return match;
    // Do not shift PL1, PL2, PL3, PL4
    if (/^PL$/i.test(colPart)) return match;
    const rNum = parseInt(rowStr, 10);
    return `${colPart}${rNum + delta}`;
  });
}
