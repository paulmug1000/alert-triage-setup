/**
 * ============================================================================
 * PULSE PHASE 6C: NATIVE CONNECTOR SHARED UTILITIES
 * ============================================================================
 * 100% verbatim ports of GAS cell sanitization, date/amount log formatting,
 * slot-reuse delta grid engine, KeyInfo/ScriptProperties helpers, and
 * SSRF-hardened external HTTP fetch helpers for Accounting & CRM pulls.
 * ============================================================================
 */

import { getSupabaseAdmin } from "./supabaseClient.js";
import { formatGasDate } from "./gasRuntime/gasEnvironment.js";
import {
  normalizeCellForStorage,
  dateToSerial,
  serialToDate,
  isDateCellCoord,
  isFormattedDateString,
  toSerialOrNull,
} from "./gasRuntime/sheetValueUtils.js";
import { compactGrid2D } from "./gasRuntime/masterFormulaEngine.js";
import {
  getOrLoadVirtualTabGrid_,
  saveVirtualTabGrid_,
} from "./masterEngineService.js";
import {
  invalidateClientRelationalMasterCache,
} from "./relationalMasterService.js";

if (typeof window !== "undefined") {
  throw new Error("SECURITY VIOLATION: services/nativeConnectorUtils.js must never run in browser code.");
}

// ============================================================================
// 1. FORMULA & CELL SANITIZATION (100% VERBATIM 1_Core_and_Xero.gs:18-114)
// ============================================================================

export function evaluateSafeSheetArithmetic_(expr) {
  if (typeof expr !== "string" || expr.length > 80) return NaN;
  let pos = 0;
  const len = expr.length;
  function skipWs() {
    while (pos < len && /\s/.test(expr.charAt(pos))) pos++;
  }
  function parseExpr() {
    let left = parseTerm();
    if (!Number.isFinite(left)) return NaN;
    while (true) {
      skipWs();
      const ch = expr.charAt(pos);
      if (ch !== "+" && ch !== "-") break;
      pos++;
      const right = parseTerm();
      if (!Number.isFinite(right)) return NaN;
      left = ch === "+" ? left + right : left - right;
    }
    return left;
  }
  function parseTerm() {
    let left = parseFactor();
    if (!Number.isFinite(left)) return NaN;
    while (true) {
      skipWs();
      const ch = expr.charAt(pos);
      if (ch !== "*" && ch !== "/") break;
      pos++;
      const right = parseFactor();
      if (!Number.isFinite(right)) return NaN;
      if (ch === "/") {
        if (Math.abs(right) < 1e-12) return NaN;
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }
  function parseFactor() {
    skipWs();
    if (pos >= len) return NaN;
    const ch = expr.charAt(pos);
    if (ch === "+" || ch === "-") {
      pos++;
      const inner = parseFactor();
      return ch === "-" ? -inner : inner;
    }
    if (ch === "(") {
      pos++;
      const innerVal = parseExpr();
      skipWs();
      if (expr.charAt(pos) !== ")") return NaN;
      pos++;
      return innerVal;
    }
    const start = pos;
    let sawDot = false;
    let sawDigit = false;
    while (pos < len) {
      const c = expr.charAt(pos);
      if (c >= "0" && c <= "9") {
        sawDigit = true;
        pos++;
      } else if (c === "." && !sawDot) {
        sawDot = true;
        pos++;
      } else {
        break;
      }
    }
    if (!sawDigit) return NaN;
    return Number(expr.slice(start, pos));
  }
  const val = parseExpr();
  skipWs();
  return pos === len ? val : NaN;
}

export function sanitizeSheetCell_(val) {
  if (val === null || val === undefined) return "";
  if (typeof val !== "string") return val;
  const trimmed = val.trimStart();
  const compact = trimmed.trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(compact)) return val;
  if (/^=[0-9\s+\-*/().]+$/.test(compact) && /[0-9]/.test(compact)) {
    if (Number.isFinite(evaluateSafeSheetArithmetic_(compact.slice(1)))) return val;
  }
  if (/^[\s'’]*[=+\-@]/.test(val)) {
    return "'" + val.replace(/^[\s'’]+/, "");
  }
  return val;
}

export function sanitizeSheetMatrix_(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) =>
    Array.isArray(row) ? row.map((cell) => sanitizeSheetCell_(cell)) : row
  );
}

// ============================================================================
// 2. DATE, AMOUNT & COMPARISON HELPERS (100% VERBATIM 1_Core_and_Xero.gs)
// ============================================================================

export function normalizeDateToYmd_(val, timeZone = "Europe/London") {
  if (val === null || val === undefined || val === "") return "";
  const tz = timeZone || "Europe/London";

  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "";
    return formatGasDate(val, tz, "yyyy-MM-dd");
  }
  if (typeof val === "number" && val > 20000 && val < 70000) {
    const epoch = new Date(1899, 11, 30);
    const d = new Date(epoch.getTime() + Math.round(val * 86400000));
    return formatGasDate(d, tz, "yyyy-MM-dd");
  }
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return "";
    const xeroMatch = s.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
    if (xeroMatch) {
      const d = new Date(parseInt(xeroMatch[1], 10));
      if (!isNaN(d.getTime())) {
        return formatGasDate(d, tz, "yyyy-MM-dd");
      }
    }
    const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
    }
    const textDateMatch = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})(?:[T\s].*)?$/);
    if (textDateMatch) {
      const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
      const mKey = textDateMatch[2].slice(0, 3).toLowerCase();
      if (months[mKey]) {
        let y = textDateMatch[3];
        if (y.length === 2) y = (parseInt(y, 10) > 50 ? "19" : "20") + y;
        return `${y}-${String(months[mKey]).padStart(2, "0")}-${textDateMatch[1].padStart(2, "0")}`;
      }
    }
    const dmyMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:[T\s].*)?$/);
    if (dmyMatch) {
      let y = dmyMatch[3];
      if (y.length === 2) y = (parseInt(y, 10) > 50 ? "19" : "20") + y;
      return `${y}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[1].padStart(2, "0")}`;
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return formatGasDate(d, tz, "yyyy-MM-dd");
    }
  }
  return "";
}

export function formatLogDate_(val, timeZone = "Europe/London") {
  const ymd = normalizeDateToYmd_(val, timeZone);
  if (!ymd) return val === null || val === undefined ? "" : String(val).trim();
  const parts = ymd.split("-");
  const mIndex = parseInt(parts[1], 10) - 1;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mStr = monthNames[mIndex] || parts[1];
  const yy = parts[0].slice(-2);
  return `${parts[2]}-${mStr}-${yy}`;
}

export function formatLogAmount_(val) {
  if (val === null || val === undefined || val === "") return "0.00";
  if (val instanceof Date) {
    const epochZero = new Date(1899, 11, 30).getTime();
    val = Math.round(((val.getTime() - epochZero) / 86400000) * 100) / 100;
  }
  const num = parseFloat(String(val).replace(/[^0-9.-]/g, ""));
  if (isNaN(num)) return String(val).trim();
  return num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function valuesAreDifferent_(v1, v2) {
  const norm = (val) => {
    if (val === null || val === undefined) return "";
    if (typeof val === "number") return Math.round(val * 100) / 100;
    const s = String(val).trim();
    if (!s) return "";
    const n = parseFloat(s.replace(/[£$€,]/g, ""));
    if (!isNaN(n) && /^[-+]?[£$€,0-9.]+$/.test(s)) return Math.round(n * 100) / 100;
    return s;
  };
  return norm(v1) !== norm(v2);
}

/**
 * Simulates reading a row back through GAS VirtualRange.getValues(), turning date
 * serials into JS Date instances where isDateCellCoord indicates a date column.
 */
export function toVirtualReadRow_(tabName, grid, row0) {
  const row = Array.isArray(grid[row0]) ? grid[row0] : [];
  return row.map((v, c0) => {
    let val = v === null || v === undefined ? "" : v;
    if (typeof val === "number" && isDateCellCoord("master", tabName, row0, c0, val, grid, {})) {
      val = serialToDate(val);
    } else if (typeof val === "string" && isFormattedDateString(val)) {
      const ser = toSerialOrNull(val);
      if (ser !== null && isDateCellCoord("master", tabName, row0, c0, ser, grid, {})) {
        val = serialToDate(ser);
      }
    }
    return val;
  });
}

// ============================================================================
// 3. HTTP FETCHERS & VALIDATION GUARDS (Rule 15 Hardened + Testable)
// ============================================================================

export function assertValidQBRealmId(realmId) {
  const safe = String(realmId || "").trim();
  if (!/^\d{1,30}$/.test(safe)) {
    throw new Error("Invalid QuickBooks Realm ID.");
  }
  return safe;
}

export function assertValidMondayBoardId(boardId) {
  const safe = String(boardId || "").trim();
  if (!/^\d+$/.test(safe)) {
    throw new Error("Invalid Monday.com Board ID format (must be numeric).");
  }
  return safe;
}

export function assertValidMondayCursor(cursor) {
  const safe = String(cursor || "").trim();
  if (!/^[A-Za-z0-9+/=_.-]+$/.test(safe)) {
    throw new Error("Invalid Monday.com pagination cursor.");
  }
  return safe;
}

export function assertValidGraphSegment(val, label = "id") {
  const clean = String(val || "").trim();
  if (!clean || !/^[A-Za-z0-9!._-]{1,220}$/.test(clean)) {
    throw new Error(`Invalid Microsoft Graph ${label}.`);
  }
  return clean;
}

export async function defaultSleepMs(ms) {
  const wait = Math.min(60000, Math.max(0, Number(ms) || 0));
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export async function connectorFetch(
  url,
  { method = "GET", headers = {}, body = undefined, timeoutMs = 30000, fetchImpl = null } = {}
) {
  const fn = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof fn !== "function") {
    throw new Error("HTTP fetch implementation is unavailable.");
  }
  const init = {
    method,
    headers: { ...headers },
    redirect: "manual",
    ...(timeoutMs > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {}),
  };
  if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
    init.body = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  }
  const resp = await fn(url, init);
  const text = await resp.text();
  const hdrObj = {};
  if (resp.headers && typeof resp.headers.forEach === "function") {
    resp.headers.forEach((v, k) => {
      hdrObj[String(k).toLowerCase()] = v;
    });
  } else if (resp.headers && typeof resp.headers === "object") {
    for (const [k, v] of Object.entries(resp.headers)) {
      hdrObj[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }
  }
  let parsedJson = null;
  try {
    parsedJson = text ? JSON.parse(text) : {};
  } catch {
    parsedJson = null;
  }
  return {
    status: resp.status,
    ok: resp.status >= 200 && resp.status < 300,
    text,
    headers: hdrObj,
    json: parsedJson,
  };
}

export async function fetchQuickBooksWithRetry_(
  url,
  options = {},
  { label = "QuickBooks API", maxRetries = 3, fetchImpl = null, sleepImpl = null } = {}
) {
  const sleep = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  let lastResp = null;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastErr = null;
    try {
      lastResp = await connectorFetch(url, { ...options, fetchImpl });
      const code = lastResp.status;
      if (code !== 429 && code !== 500 && code !== 502 && code !== 503 && code !== 504) {
        return lastResp;
      }
      if (attempt === maxRetries) return lastResp;
      let waitMs = Math.min(60000, 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 500));
      try {
        const retryAfterSec = parseFloat(String(lastResp.headers?.["retry-after"] || "").trim());
        if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
          waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterSec * 1000) + 500));
        }
      } catch { }
      console.warn(`[${label}] HTTP ${code} rate-limited/transient (attempt ${attempt + 1}/${maxRetries}). Waiting ${waitMs}ms...`);
      await sleep(waitMs);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) throw err;
      const waitMs = Math.min(30000, 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 300));
      console.warn(`[${label}] Network error (${err?.message || err}); retry ${attempt + 1}/${maxRetries} in ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }
  if (lastErr) throw lastErr;
  return lastResp;
}

export async function fetchXeroWithRetry_(
  url,
  options = {},
  { label = "Xero API", maxRetries = 4, fetchImpl = null, sleepImpl = null } = {}
) {
  const sleep = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  let lastResp = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResp = await connectorFetch(url, { ...options, fetchImpl });
    const code = lastResp.status;
    if (code !== 429 && code !== 502 && code !== 503 && code !== 504) {
      return lastResp;
    }
    if (attempt === maxRetries) {
      return lastResp;
    }
    let waitMs = Math.min(60000, 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 500));
    try {
      const retryAfterRaw = lastResp.headers?.["retry-after"];
      const retryAfterSec = parseFloat(String(retryAfterRaw || "").trim());
      if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterSec * 1000) + 500));
      }
    } catch { }
    console.warn(`[${label}] HTTP ${code} rate-limited/transient (attempt ${attempt + 1}/${maxRetries}). Waiting ${waitMs}ms before retry...`);
    await sleep(waitMs);
  }
  return lastResp;
}

// ============================================================================
// 4. VIRTUAL STORAGE NORMALIZATION & SLOT-REUSE DELTA ENGINE
// ============================================================================

export function formatValueForGasSetValues_(val) {
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "";
    return dateToSerial(val);
  }
  return val === null || val === undefined ? "" : val;
}

export function normalizeMasterGridRow_(tabName, row0, rowVals, fullGrid, textColsSet = new Set()) {
  const normalized = [];
  for (let c0 = 0; c0 < rowVals.length; c0++) {
    const rawVal = rowVals[c0];
    const isTextCol = textColsSet.has(c0);
    normalized.push(
      normalizeCellForStorage(
        "master",
        tabName,
        row0,
        c0,
        rawVal,
        "USER_ENTERED",
        fullGrid,
        {},
        isTextCol
      )
    );
  }
  return normalized;
}

export function normalizeVirtualMasterGrid(tabName, rawGrid = [], textColsSet = new Set()) {
  const out = [];
  for (let r0 = 0; r0 < rawGrid.length; r0++) {
    const row = Array.isArray(rawGrid[r0]) ? rawGrid[r0] : [];
    const normRow = [];
    for (let c0 = 0; c0 < row.length; c0++) {
      // Header row (r0 === 0) is stored directly as text unless formula/number
      const useText = r0 === 0 ? false : textColsSet.has(c0);
      normRow.push(
        normalizeCellForStorage(
          "master",
          tabName,
          r0,
          c0,
          row[c0],
          "USER_ENTERED",
          out,
          {},
          useText
        )
      );
    }
    out.push(normRow);
  }
  return compactGrid2D(out);
}

/**
 * 100% verbatim port of GAS slot-reuse delta engine used across SaaS CRMs,
 * PullFromGoogleSheet_, PullFromExcelSheet_, and writeToGoogleSheet.
 */
export function applySlotReuseDeltaGrid({
  existingGrid = [],
  headers = [],
  incomingRows = [],
  textColsSet = new Set(),
  tabName = "DataFromCRM",
  idColIdx = 0,
  forceFullOverwrite = false,
  preserveExistingHeadersIfPresent = false,
  headerSelfHealFn = null,
  compareRowsEqualFn = null,
  onNewRow = null,
  onUpdatedRow = null,
}) {
  const grid = Array.isArray(existingGrid) ? existingGrid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];
  const lastRow = grid.length;
  const oldHeaders = lastRow > 0 ? grid[0] || [] : [];

  const normHeaders = headers.map((h) => (h === null || h === undefined ? "" : h));
  const headersMatch = JSON.stringify(oldHeaders) === JSON.stringify(normHeaders);
  const needsFullOverwrite = forceFullOverwrite || lastRow <= 1 || (!preserveExistingHeadersIfPresent && !headersMatch);

  if (needsFullOverwrite) {
    let headerRow = [...normHeaders];
    if (preserveExistingHeadersIfPresent && lastRow > 0 && oldHeaders.some((c) => c !== "" && c !== null && c !== undefined)) {
      headerRow = [...oldHeaders];
      if (typeof headerSelfHealFn === "function") {
        headerRow = headerSelfHealFn(headerRow);
      }
    }
    const nextRaw = [headerRow, ...incomingRows.map((r) => [...r])];
    const nextGrid = normalizeVirtualMasterGrid(tabName, nextRaw, textColsSet);
    for (let i = 1; i < nextGrid.length; i++) {
      if (typeof onNewRow === "function") onNewRow(nextGrid[i], i + 1);
    }
    return {
      nextGrid,
      dataChanged: incomingRows.length > 0 || lastRow > 1,
      fullOverwrite: true,
    };
  }

  let effectiveHeaders = [...oldHeaders];
  if (typeof headerSelfHealFn === "function") {
    effectiveHeaders = headerSelfHealFn(effectiveHeaders);
  }
  grid[0] = effectiveHeaders;

  const incomingMap = new Map();
  for (const row of incomingRows) {
    incomingMap.set(String(row[idColIdx] ?? ""), row);
  }

  const rowsToDelete = [];
  let dataChanged = false;
  const numDataCols = Math.max(effectiveHeaders.length, incomingRows[0]?.length || 0);

  for (let r0 = 1; r0 < lastRow; r0++) {
    const oldRowRead = toVirtualReadRow_(tabName, grid, r0);
    const rowId = String(oldRowRead[idColIdx] ?? "");
    const sheetRowNum = r0 + 1;

    if (!rowId || rowId.trim() === "") {
      rowsToDelete.push(sheetRowNum);
      continue;
    }

    if (!incomingMap.has(rowId)) {
      rowsToDelete.push(sheetRowNum);
      dataChanged = true;
    } else {
      const newData = incomingMap.get(rowId);
      const isEqual =
        typeof compareRowsEqualFn === "function"
          ? compareRowsEqualFn(oldRowRead, newData, r0)
          : JSON.stringify(oldRowRead) === JSON.stringify(newData);

      if (!isEqual) {
        if (typeof onUpdatedRow === "function") {
          onUpdatedRow(oldRowRead, newData, sheetRowNum);
        }
        grid[r0] = normalizeMasterGridRow_(tabName, r0, newData, grid, textColsSet);
        dataChanged = true;
      }
      incomingMap.delete(rowId);
    }
  }

  const rowsToAppend = Array.from(incomingMap.values());
  if (rowsToAppend.length > 0) {
    dataChanged = true;
    for (const r of rowsToAppend) {
      if (typeof onNewRow === "function") onNewRow(r, null);
    }
  }

  if (!dataChanged) {
    return { nextGrid: compactGrid2D(grid), dataChanged: false, fullOverwrite: false };
  }

  const findLastNonEmptyRow1 = () => {
    for (let r = grid.length - 1; r >= 0; r--) {
      const row = grid[r];
      if (Array.isArray(row) && row.some((c) => c !== "" && c !== null && c !== undefined)) {
        return r + 1;
      }
    }
    return 0;
  };

  while (rowsToAppend.length > 0) {
    const newRowData = rowsToAppend.shift();
    if (rowsToDelete.length > 0) {
      const recycleRow = rowsToDelete.shift();
      const r0 = recycleRow - 1;
      while (grid.length <= r0) grid.push([]);
      grid[r0] = normalizeMasterGridRow_(tabName, r0, newRowData, grid, textColsSet);
    } else {
      const startRow1 = findLastNonEmptyRow1() + 1;
      const r0 = startRow1 - 1;
      while (grid.length <= r0) grid.push([]);
      grid[r0] = normalizeMasterGridRow_(tabName, r0, newRowData, grid, textColsSet);
    }
  }

  for (const rowNum of rowsToDelete) {
    const r0 = rowNum - 1;
    if (grid[r0]) {
      for (let c = 0; c < Math.max(grid[r0].length, numDataCols); c++) {
        grid[r0][c] = "";
      }
    }
  }

  return {
    nextGrid: compactGrid2D(grid),
    dataChanged: true,
    fullOverwrite: false,
  };
}

// ============================================================================
// 5. CONTEXT GRIDS & SCRIPT PROPERTIES STATE HELPERS
// ============================================================================

export function patchGrid2DCell(grid, row1, col1, value) {
  const out = Array.isArray(grid) ? grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];
  const r0 = Math.max(0, Number(row1) - 1);
  const c0 = Math.max(0, Number(col1) - 1);
  while (out.length <= r0) out.push([]);
  while (out[r0].length <= c0) out[r0].push("");
  out[r0][c0] = value;
  return out;
}

export function readKeyInfoCellRaw(keyInfoGrid, cellA1, fallback = "") {
  const m = String(cellA1 || "").trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return fallback;
  let col0 = 0;
  for (let i = 0; i < m[1].length; i++) {
    col0 = col0 * 26 + (m[1].charCodeAt(i) - 64);
  }
  col0 -= 1;
  const row0 = parseInt(m[2], 10) - 1;
  const v = keyInfoGrid?.[row0]?.[col0];
  return v === undefined || v === null || String(v).trim() === "" ? fallback : v;
}

export function readKeyInfoDateCell(keyInfoGrid, cellA1) {
  const raw = readKeyInfoCellRaw(keyInfoGrid, cellA1, "");
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "number" && raw > 20000 && raw < 70000) {
    return serialToDate(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const ser = toSerialOrNull(raw.trim());
    if (ser !== null) return serialToDate(ser);
    const d = new Date(raw.trim());
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

export async function loadConnectorContextState(ctx, keyInfoOverride = null) {
  const supabase = getSupabaseAdmin();
  let cfgRow = null;
  if (supabase && ctx?.clientId) {
    const { data, error } = await supabase
      .from("pulse_master_sync_configs")
      .select("*")
      .eq("client_id", ctx.clientId)
      .maybeSingle();
    if (error && !/42P01|does not exist/i.test(String(error.message || ""))) {
      throw new Error(`Failed loading pulse_master_sync_configs for ${ctx.clientName}: ${error.message}`);
    }
    if (data) cfgRow = data;
  }

  let keyInfoGrid = Array.isArray(keyInfoOverride) && keyInfoOverride.length > 0
    ? keyInfoOverride.map((r) => (Array.isArray(r) ? [...r] : []))
    : Array.isArray(cfgRow?.master_key_info_grid) && cfgRow.master_key_info_grid.length > 0
      ? cfgRow.master_key_info_grid.map((r) => (Array.isArray(r) ? [...r] : []))
      : [];

  if (keyInfoGrid.length === 0) {
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", "KeyInfo", null).catch(() => null);
    if (Array.isArray(rec?.values_grid)) {
      keyInfoGrid = rec.values_grid.map((r) => (Array.isArray(r) ? [...r] : []));
    }
  }

  let dataChgAlertGrid =
    Array.isArray(cfgRow?.data_chg_alert_grid) && cfgRow.data_chg_alert_grid.length > 0
      ? cfgRow.data_chg_alert_grid.map((r) => (Array.isArray(r) ? [...r] : []))
      : [];
  if (dataChgAlertGrid.length === 0) {
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", "DataChgAlert", null).catch(() => null);
    if (Array.isArray(rec?.values_grid)) {
      dataChgAlertGrid = rec.values_grid.map((r) => (Array.isArray(r) ? [...r] : []));
    }
  }

  // Merge ScriptProperties from config column and GasScriptProps tab fallback
  let scriptProps = {};
  if (cfgRow?.script_properties && typeof cfgRow.script_properties === "object" && !Array.isArray(cfgRow.script_properties)) {
    scriptProps = { ...cfgRow.script_properties };
  }
  if (Object.keys(scriptProps).length === 0) {
    const gpRec = await getOrLoadVirtualTabGrid_(ctx, "master", "GasScriptProps", null).catch(() => null);
    const gpRows = Array.isArray(gpRec?.values_grid) ? gpRec.values_grid : [];
    for (let r = 1; r < gpRows.length; r++) {
      const k = String(gpRows[r]?.[0] ?? "").trim();
      if (k) scriptProps[k] = String(gpRows[r]?.[1] ?? "");
    }
  }

  return {
    cfgRow: cfgRow || {},
    keyInfoGrid,
    dataChgAlertGrid,
    scriptProps,
    timeZone: "Europe/London",
  };
}

export async function saveConnectorConfigPatch(ctx, patch = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return;
  const nowIso = new Date().toISOString();
  const payload = {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    ...patch,
    updated_at: nowIso,
  };
  const { error } = await supabase
    .from("pulse_master_sync_configs")
    .upsert(payload, { onConflict: "client_id" });
  if (error) {
    // Graceful fallback only if Migration 0018 columns are not added yet
    const safePatch = { ...patch };
    let strippedAny = false;
    for (const col of [
      "crm_google_bridge_grid",
      "crm_excel_bridge_grid",
      "crm_excel_copy_grid",
      "accounting_coa_categories",
      "script_properties",
      "connectors_backfilled_at",
    ]) {
      if (col in safePatch && String(error.message || "").includes(col)) {
        delete safePatch[col];
        strippedAny = true;
      }
    }
    if (!strippedAny) {
      throw new Error(`pulse_master_sync_configs upsert failed (${ctx.clientName}): ${error.message}`);
    }
    if (Object.keys(safePatch).length > 0) {
      const { error: retryErr } = await supabase
        .from("pulse_master_sync_configs")
        .upsert({ client_id: ctx.clientId, client_name: ctx.clientName, ...safePatch, updated_at: nowIso }, { onConflict: "client_id" });
      if (retryErr) {
        throw new Error(`pulse_master_sync_configs retry upsert failed (${ctx.clientName}): ${retryErr.message}`);
      }
    }
  }
  invalidateClientRelationalMasterCache(ctx.clientName);
}

export async function persistConnectorScriptProperties(ctx, updates = {}, deleteKeys = []) {
  const state = await loadConnectorContextState(ctx);
  const nextProps = { ...state.scriptProps };
  for (const dk of deleteKeys || []) {
    delete nextProps[dk];
  }
  for (const [k, v] of Object.entries(updates || {})) {
    nextProps[k] = String(v ?? "");
  }
  await saveConnectorConfigPatch(ctx, { script_properties: nextProps });

  // Also keep GasScriptProps virtual tab synchronized unless connector_pull_mode === 'native'
  if (ctx?.connectorPullMode !== "native") {
    const propRows = [["Key", "Value"]];
    for (const [k, v] of Object.entries(nextProps)) {
      propRows.push([k, v]);
    }
    await saveVirtualTabGrid_(ctx, "master", "GasScriptProps", propRows, propRows, {}).catch(() => { });
  }
  return nextProps;
}

export async function stampMasterCompTimestamp(ctx, compTabName, cellA1, dateObj = new Date()) {
  const m = String(cellA1 || "").trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return;
  let col1 = 0;
  for (let i = 0; i < m[1].length; i++) col1 = col1 * 26 + (m[1].charCodeAt(i) - 64);
  const row1 = parseInt(m[2], 10);
  const serialVal = dateToSerial(dateObj);

  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return;

  const ctrlColMap = {
    InvComp: "inv_comp_controls",
    DirComp: "dir_comp_controls",
    CRMComp: "crm_comp_controls",
    PLComp: "pl_comp_meta",
  };
  const colName = ctrlColMap[compTabName];
  if (!colName) return;

  try {
    const { data: cfg } = await supabase
      .from("pulse_master_sync_configs")
      .select(colName)
      .eq("client_id", ctx.clientId)
      .maybeSingle();
    if (!cfg || !cfg[colName]) return;
    const ctrl = { ...cfg[colName] };
    if (compTabName === "PLComp") {
      const seedCols = Array.isArray(ctrl.seedColsAtoE) ? ctrl.seedColsAtoE.map((r) => [...(r || [])]) : [];
      while (seedCols.length < row1) seedCols.push([]);
      while (seedCols[row1 - 1].length < col1) seedCols[row1 - 1].push("");
      seedCols[row1 - 1][col1 - 1] = serialVal;
      if (row1 === 1) {
        const hdr = Array.isArray(ctrl.headerRow) ? [...ctrl.headerRow] : [];
        while (hdr.length < col1) hdr.push("");
        hdr[col1 - 1] = serialVal;
        ctrl.headerRow = hdr;
      }
      ctrl.seedColsAtoE = seedCols;
    } else {
      const hdrRows = Array.isArray(ctrl.headerRows) ? ctrl.headerRows.map((r) => [...(r || [])]) : [];
      while (hdrRows.length < row1) hdrRows.push([]);
      while (hdrRows[row1 - 1].length < col1) hdrRows[row1 - 1].push("");
      hdrRows[row1 - 1][col1 - 1] = serialVal;
      ctrl.headerRows = hdrRows;
    }
    await saveConnectorConfigPatch(ctx, { [colName]: ctrl });
  } catch { }
}
