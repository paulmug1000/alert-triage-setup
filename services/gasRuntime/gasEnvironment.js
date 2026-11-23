/**
 * ============================================================================
 * PULSE GAS RUNTIME ENVIRONMENT (services/gasRuntime/gasEnvironment.js)
 * Version: 1.08 — Guard VirtualSheet notesGrid/tab maps against prototype pollution, normalize sheets.googleapis.com paths, and bind ScriptApp OAuth tokens strictly to authorized spreadsheet targets
 * ============================================================================
 * Provides a 100% faithful Google Apps Script execution environment for the
 * verbatim compiled Master GAS scripts (`compiledMasterGas.js`), backed by:
 *   - Supabase `master_sheet_grids` for Master & Recon spreadsheets
 *   - `masterFormulaEngine.js` for 1:1 in-memory formula evaluation
 *   - Google Sheets API v4 (`sheets`) for the Client Sheet & external sheets
 *   - In-process Pulse Token Broker (`vaultService.js`) for OAuth tokens
 */

import { randomUUID } from "crypto";
import dns from "dns";
import http from "http";
import https from "https";
import net from "net";
import zlib from "zlib";
import { getSupabaseAdmin } from "../supabaseClient.js";
import { extractSheetIdFromUrl } from "../sheetsClient.js";
import { assertExternalCrmSpreadsheet } from "../googleSheetService.js";
import {
  colLetterToIdx0,
  colIdx0ToLetter,
  parseA1Range,
  invalidateMasterEngineCache,
} from "../masterEngineService.js";
import {
  isDateCellCoord,
  isFormattedDateString,
  serialToDate,
  dateToSerial,
  toSerialOrNull,
  formatCellForDisplay,
  normalizeCellForStorage,
  MONTHS_SHORT,
  MONTHS_FULL,
} from "./sheetValueUtils.js";
import {
  evaluateAllMasterFormulas,
  evaluateOutgoingsMasterTab,
  evaluateInvAppList,
  evaluateInvDashList,
  evaluateInvComp,
  evaluateJnlAppList,
  evaluateDirDashList,
  evaluateDirComp,
  evaluateCRMList,
  evaluateCRMComp,
  evaluateKeyInfoAndPLComp,
  evaluateTimeComp,
  evaluateYear0Data,
  compactGrid2D,
} from "./masterFormulaEngine.js";
import {
  getIntegrationTokens,
  updateRefreshedTokens,
  markIntegrationReconnectRequired,
  getSharedXeroGrant,
  updateSharedXeroGrantTokens,
  refreshWithConcurrencyLock,
  isOAuthReconnectError,
} from "../vaultService.js";
import { refreshXeroTokens } from "../xeroService.js";
import { refreshQBTokens } from "../quickbooksService.js";
import { refreshMondayTokens } from "../mondayService.js";
import { refreshPipedriveTokens } from "../pipedriveService.js";
import { refreshCapsuleTokens } from "../capsuleService.js";
import { refreshCloseTokens } from "../closeService.js";
import { refreshHubSpotTokens } from "../hubspotService.js";
import { refreshGoogleSheetTokens } from "../googleSheetService.js";
import { refreshExcelTokens } from "../excelIntegrationService.js";

const FORMULA_DEPENDENT_MASTER_TABS = new Set([
  "Outgoings",
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
  "Year0Data",
  "TimeComp",
  "DataChgAlert",
]);

const FORMULA_INPUT_MASTER_TABS = new Set([
  "InvFromApp",
  "JnlsFromApp",
  "PLFromApp",
  "Year0PLFromApp",
  "DataFromCRM",
  "DataFromTime",
  "ConfCalcs",
  "PipeCalcs",
  "Outgoings",
  "PLAdds",
  "KeyInfo",
  "CRMComp",
  "PLComp",
  "Year0Data",
  "TimeComp",
  "DataChgAlert",
]);

const CLIENT_TABS_TO_PRELOAD = [
  "Confirmed",
  "Pipeline",
  "Outgoings",
  "OutgNotes",
  "Salaries",
  "KeyInfo",
  "Monthly",
  "Year0Data",
  "ConfCalcs",
  "PipeCalcs",
  "Budget",
  "Cash",
  "Dashboard",
  "Performance",
];

const ACTIVE_GAS_MASTER_TABS = [
  "KeyInfo",
  "DataChgAlert",
  "AutoLog",
  "InvComp",
  "InvFromApp",
  "InvAppList",
  "InvDashList",
  "JnlsFromApp",
  "JnlAppList",
  "DirDashList",
  "DirComp",
  "DataFromCRM",
  "CRMList",
  "CRMComp",
  "CRMGoogleBridge",
  "CRMExcelCopy",
  "CRMExcelBridge",
  "PLFromApp",
  "PLAdds",
  "PLComp",
  "Year0PLFromApp",
  "Year0Data",
  "StarterPL",
  "StarterInv",
  "RevFromApp",
  "RevComp",
  "Outgoings",
  "OutgNotes",
  "ConfCalcs",
  "PipeCalcs",
  "TimeComp",
  "DataFromTime",
  "ProjectsFromTime",
  "NBtoFind",
  "Data",
  "GasExecLogs",
  "GasScriptProps",
];

const COMPARISON_ONLY_MASTER_TABS = [
  "KeyInfo",
  "DataChgAlert",
  "InvFromApp",
  "InvAppList",
  "InvDashList",
  "InvComp",
  "JnlsFromApp",
  "JnlAppList",
  "DirDashList",
  "DirComp",
  "DataFromCRM",
  "CRMList",
  "CRMComp",
  "PLFromApp",
  "Year0PLFromApp",
  "PLAdds",
  "PLComp",
  "Outgoings",
  "OutgNotes",
  "ConfCalcs",
  "PipeCalcs",
];

function cloneGrid2D(grid) {
  if (!Array.isArray(grid)) return [];
  return grid.map((r) => (Array.isArray(r) ? [...r] : []));
}

function getGridLastRow(grid) {
  if (!Array.isArray(grid)) return 0;
  for (let r = grid.length - 1; r >= 0; r--) {
    const row = grid[r];
    if (Array.isArray(row) && row.some((c) => c !== "" && c !== null && c !== undefined)) {
      return r + 1;
    }
  }
  return 0;
}

function getGridLastCol(grid) {
  if (!Array.isArray(grid)) return 0;
  let maxC = 0;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    if (!Array.isArray(row)) continue;
    for (let c = row.length - 1; c >= maxC; c--) {
      if (row[c] !== "" && row[c] !== null && row[c] !== undefined) {
        maxC = c + 1;
        break;
      }
    }
  }
  return maxC;
}

function formatDateForUserEntered_(val) {
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "";
    const y = val.getFullYear();
    const m = MONTHS_SHORT[val.getMonth()] || "Jan";
    const d = val.getDate();
    const hh = val.getHours();
    const mm = val.getMinutes();
    const ss = val.getSeconds();
    if (hh !== 0 || mm !== 0 || ss !== 0) {
      return `${d}-${m}-${y} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    }
    return `${d}-${m}-${y}`;
  }
  return val === null || val === undefined ? "" : val;
}

/**
 * Formats a Date object according to Java SimpleDateFormat pattern (used by Utilities.formatDate)
 */
export function formatGasDate(dateObj, timeZone = "Europe/London", pattern = "yyyy-MM-dd") {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  if (isNaN(d.getTime())) return "";

  let year, month1, day, hour24, minute, second;
  const tzClean = String(timeZone || "UTC").trim();
  const isUtc = /^(utc|gmt|etc\/utc|etc\/gmt)$/i.test(tzClean);

  if (isUtc) {
    year = d.getUTCFullYear();
    month1 = d.getUTCMonth() + 1;
    day = d.getUTCDate();
    hour24 = d.getUTCHours();
    minute = d.getUTCMinutes();
    second = d.getUTCSeconds();
  } else {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: tzClean,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(d);
      const map = {};
      for (const p of parts) map[p.type] = p.value;
      year = parseInt(map.year, 10);
      month1 = parseInt(map.month, 10);
      day = parseInt(map.day, 10);
      hour24 = parseInt(map.hour, 10) % 24;
      minute = parseInt(map.minute, 10);
      second = parseInt(map.second, 10);
    } catch {
      year = d.getUTCFullYear();
      month1 = d.getUTCMonth() + 1;
      day = d.getUTCDate();
      hour24 = d.getUTCHours();
      minute = d.getUTCMinutes();
      second = d.getUTCSeconds();
    }
  }

  const yy = String(year).slice(-2);
  const mFull = MONTHS_FULL[month1 - 1] || "January";
  const mShort = MONTHS_SHORT[month1 - 1] || "Jan";
  const MM = String(month1).padStart(2, "0");
  const M = String(month1);
  const dd = String(day).padStart(2, "0");
  const dStr = String(day);
  const HH = String(hour24).padStart(2, "0");
  const H = String(hour24);
  const hour12 = hour24 % 12 || 12;
  const hh = String(hour12).padStart(2, "0");
  const h = String(hour12);
  const mm = String(minute).padStart(2, "0");
  const m = String(minute);
  const ss = String(second).padStart(2, "0");
  const s = String(second);
  const ampm = hour24 >= 12 ? "PM" : "AM";

  // Replace quoted literals and pattern tokens in a single pass
  return String(pattern).replace(
    /'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s|a/g,
    (match, quoted) => {
      if (quoted !== undefined) return quoted;
      switch (match) {
        case "yyyy":
          return String(year);
        case "yy":
          return yy;
        case "MMMM":
          return mFull;
        case "MMM":
          return mShort;
        case "MM":
          return MM;
        case "M":
          return M;
        case "dd":
          return dd;
        case "d":
          return dStr;
        case "HH":
          return HH;
        case "H":
          return H;
        case "hh":
          return hh;
        case "h":
          return h;
        case "mm":
          return mm;
        case "m":
          return m;
        case "ss":
          return ss;
        case "s":
          return s;
        case "a":
          return ampm;
        default:
          return match;
      }
    }
  );
}

/**
 * Retries transient Google Sheets API errors (429 rate limits, 5xx, network blips)
 * with exponential backoff + jitter.
 */
async function withSheetsRetry_(fn, label = "Sheets API", maxRetries = 4) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = Number(err?.code || err?.status || err?.response?.status || 0);
      const msg = String(err?.message || "").toLowerCase();
      const isTransient =
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        msg.includes("quota") ||
        msg.includes("rate limit") ||
        msg.includes("429") ||
        msg.includes("etimedout") ||
        msg.includes("econnreset") ||
        msg.includes("socket hang up");
      if (!isTransient || attempt === maxRetries) {
        throw err;
      }
      const waitMs = Math.min(20000, 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500));
      console.warn(`[gasEnvironment] ${label} transient error (${status || err.message}), retrying in ${waitMs}ms...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/**
 * Resolves a fresh OAuth access token in-process for `/api/integrations/token` requests
 */
export async function resolveBrokerTokenInProcess(ctx, toolRaw) {
  const tool = String(toolRaw || "xero").trim().toLowerCase();
  const normalizedTool = tool === "qb" ? "quickbooks" : tool === "google_sheet" ? "googlesheet" : tool;

  const record = await getIntegrationTokens({
    clientKey: ctx.clientName,
    masterSheetId: ctx.masterSheetId,
    tool: normalizedTool,
  });

  if (!record || !record.tokens || !record.tokens.accessToken) {
    return {
      status: 404,
      body: {
        success: false,
        error: `No active ${normalizedTool} connection found for this client.`,
        reconnectRequired: true,
      },
    };
  }

  let accessToken = record.tokens.accessToken;
  let expiresIn = Math.max(0, Math.round(((record.expiresAt || 0) - Date.now()) / 1000));
  const isExpiringSoon = expiresIn < 300;

  if (isExpiringSoon) {
    const OAUTH_REFRESHERS = {
      quickbooks: refreshQBTokens,
      pipedrive: refreshPipedriveTokens,
      monday: refreshMondayTokens,
      capsule: refreshCapsuleTokens,
      close: refreshCloseTokens,
      hubspot: refreshHubSpotTokens,
      googlesheet: refreshGoogleSheetTokens,
      excel: refreshExcelTokens,
    };

    if (normalizedTool === "xero" || OAUTH_REFRESHERS[normalizedTool]) {
      const lockKey = (normalizedTool === "xero" && record.isSharedGrant)
        ? "xero:shared"
        : `${normalizedTool}:${record.clientKey}`;

      const getLatestTokenFn = async () => {
        const latest = (normalizedTool === "xero" && record.isSharedGrant)
          ? await getSharedXeroGrant({ bypassL1: true })
          : await getIntegrationTokens({
            clientKey: record.clientKey,
            masterSheetId: ctx.masterSheetId,
            tool: normalizedTool,
            bypassL1: true,
          });
        if (!latest?.tokens?.accessToken) return null;
        const latestExpiresIn = Math.max(0, Math.round(((latest.expiresAt || 0) - Date.now()) / 1000));
        return {
          accessToken: latest.tokens.accessToken,
          expiresIn: latestExpiresIn,
          refreshToken: latest.tokens.refreshToken,
          metadata: latest.metadata || {},
        };
      };

      try {
        const refreshResult = await refreshWithConcurrencyLock(
          lockKey,
          async () => {
            const latest = await getLatestTokenFn();
            if (latest && latest.expiresIn >= 300) {
              return { accessToken: latest.accessToken, expiresIn: latest.expiresIn };
            }
            const refreshTokenToUse = latest?.refreshToken || record.tokens.refreshToken;
            if (!refreshTokenToUse) {
              return { accessToken, expiresIn };
            }
            if (normalizedTool === "xero" && record.isSharedGrant) {
              const refreshed = await refreshXeroTokens(refreshTokenToUse);
              await updateSharedXeroGrantTokens(refreshed);
              return { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn || 1800 };
            }
            const refreshFn = normalizedTool === "xero" ? refreshXeroTokens : OAUTH_REFRESHERS[normalizedTool];
            const refreshed = normalizedTool === "excel"
              ? await refreshExcelTokens(refreshTokenToUse, latest?.metadata?.azureTenantId || record.metadata?.azureTenantId)
              : await refreshFn(refreshTokenToUse);
            await updateRefreshedTokens({ clientKey: record.clientKey, tool: normalizedTool, tokens: refreshed });
            const defaultExp = normalizedTool === "xero" || normalizedTool === "hubspot" ? 1800 : 3600;
            return { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn || defaultExp };
          },
          async () => {
            const latest = await getLatestTokenFn();
            return latest ? { accessToken: latest.accessToken, expiresIn: latest.expiresIn } : null;
          }
        );
        if (refreshResult?.accessToken) {
          accessToken = refreshResult.accessToken;
          expiresIn = refreshResult.expiresIn ?? expiresIn;
        }
      } catch (refreshErr) {
        if (isOAuthReconnectError(refreshErr)) {
          try {
            await markIntegrationReconnectRequired({
              clientKey: record.clientKey,
              masterSheetId: ctx.masterSheetId,
              tool: normalizedTool,
              error: refreshErr.message,
              isSharedGrant: Boolean(normalizedTool === "xero" && record.isSharedGrant),
            });
          } catch (_) { }
        }
        return {
          status: 401,
          body: {
            success: false,
            error: `Failed to refresh ${normalizedTool} connection (${refreshErr.message}).`,
            reconnectRequired: true,
          },
        };
      }
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      tool: normalizedTool,
      clientKey: record.clientKey,
      clientName: record.clientName,
      accessToken,
      tenantId: record.tenantId || record.realmId || "",
      tenantName: record.tenantName || record.companyName || "",
      realmId: record.realmId || record.tenantId || "",
      companyName: record.companyName || record.tenantName || "",
      expiresIn,
    },
  };
}

function hexToGoogleRgb_(hex) {
  if (!hex || typeof hex !== "string") return null;
  let clean = hex.replace("#", "").trim();
  if (clean.length === 3) {
    clean = clean.split("").map((c) => c + c).join("");
  }
  if (clean.length !== 6) return null;
  const num = parseInt(clean, 16);
  if (isNaN(num)) return null;
  return {
    red: ((num >> 16) & 255) / 255,
    green: ((num >> 8) & 255) / 255,
    blue: (num & 255) / 255,
  };
}

class VirtualRange {
  constructor(sheet, startRow1, startCol1, numRows = 1, numCols = 1) {
    this.sheet = sheet;
    this.startRow1 = Math.max(1, Number(startRow1) || 1);
    this.startCol1 = Math.max(1, Number(startCol1) || 1);
    this.numRows = Math.max(1, Number(numRows) || 1);
    this.numCols = Math.max(1, Number(numCols) || 1);
  }

  getSheet() {
    return this.sheet;
  }

  getRow() {
    return this.startRow1;
  }

  getColumn() {
    return this.startCol1;
  }

  getLastRow() {
    return this.startRow1 + this.numRows - 1;
  }

  getLastColumn() {
    return this.startCol1 + this.numCols - 1;
  }

  getNumRows() {
    return this.numRows;
  }

  getNumColumns() {
    return this.numCols;
  }

  getA1Notation() {
    const c1 = colIdx0ToLetter(this.startCol1 - 1);
    const r1 = this.startRow1;
    if (this.numRows === 1 && this.numCols === 1) {
      return `${c1}${r1}`;
    }
    const c2 = colIdx0ToLetter(this.startCol1 + this.numCols - 2);
    const r2 = this.startRow1 + this.numRows - 1;
    return `${c1}${r1}:${c2}${r2}`;
  }

  getValue() {
    return this.getValues()[0]?.[0] ?? "";
  }

  getValues() {
    this.sheet._beforeRead();
    const grid = this.sheet.valuesGrid;
    const notes = this.sheet.notesGrid;
    const sheetRole = this.sheet.spreadsheet.sheetRole;
    const tabName = this.sheet.name;
    const out = [];

    for (let r = 0; r < this.numRows; r++) {
      const r0 = this.startRow1 - 1 + r;
      const srcRow = grid[r0] || [];
      const rowArr = [];
      for (let c = 0; c < this.numCols; c++) {
        const c0 = this.startCol1 - 1 + c;
        let val = srcRow[c0];
        if (val === null || val === undefined) {
          val = "";
        } else if (
          typeof val === "number" &&
          isDateCellCoord(sheetRole, tabName, r0, c0, val, grid, notes)
        ) {
          val = serialToDate(val);
        } else if (typeof val === "string" && isFormattedDateString(val)) {
          const ser = toSerialOrNull(val);
          if (ser !== null && isDateCellCoord(sheetRole, tabName, r0, c0, ser, grid, notes)) {
            val = serialToDate(ser);
          }
        }
        rowArr.push(val);
      }
      out.push(rowArr);
    }
    return out;
  }

  getDisplayValue() {
    return this.getDisplayValues()[0]?.[0] ?? "";
  }

  getDisplayValues() {
    this.sheet._beforeRead();
    const grid = this.sheet.valuesGrid;
    const notes = this.sheet.notesGrid;
    const sheetRole = this.sheet.spreadsheet.sheetRole;
    const tabName = this.sheet.name;
    const out = [];

    for (let r = 0; r < this.numRows; r++) {
      const r0 = this.startRow1 - 1 + r;
      const srcRow = grid[r0] || [];
      const rowArr = [];
      for (let c = 0; c < this.numCols; c++) {
        const c0 = this.startCol1 - 1 + c;
        const val = srcRow[c0];
        rowArr.push(formatCellForDisplay(sheetRole, tabName, r0, c0, val, grid, notes));
      }
      out.push(rowArr);
    }
    return out;
  }

  getFormula() {
    return this.getFormulas()[0]?.[0] ?? "";
  }

  getFormulas() {
    this.sheet._beforeRead();
    const fGrid = this.sheet.formulasGrid;
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const r0 = this.startRow1 - 1 + r;
      const srcRow = fGrid[r0] || [];
      const rowArr = [];
      for (let c = 0; c < this.numCols; c++) {
        const c0 = this.startCol1 - 1 + c;
        const f = srcRow[c0];
        rowArr.push(typeof f === "string" && f.startsWith("=") ? f : "");
      }
      out.push(rowArr);
    }
    return out;
  }

  getNote() {
    return this.getNotes()[0]?.[0] ?? "";
  }

  getNotes() {
    const notes = this.sheet.notesGrid || {};
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const r0 = this.startRow1 - 1 + r;
      const rowArr = [];
      for (let c = 0; c < this.numCols; c++) {
        const c0 = this.startCol1 - 1 + c;
        rowArr.push(String(notes[`${r0}:${c0}`] || ""));
      }
      out.push(rowArr);
    }
    return out;
  }

  setValue(val) {
    const matrix = Array.from({ length: this.numRows }, () =>
      Array.from({ length: this.numCols }, () => val)
    );
    return this.setValues(matrix);
  }

  setValues(values) {
    if (!Array.isArray(values) || values.length === 0) return this;
    const sheetRole = this.sheet.spreadsheet.sheetRole;
    const tabName = this.sheet.name;
    const grid = this.sheet.valuesGrid;
    const fGrid = this.sheet.formulasGrid;
    const notes = this.sheet.notesGrid;
    const remoteRows = [];

    for (let r = 0; r < values.length; r++) {
      const r0 = this.startRow1 - 1 + r;
      if (r0 < 0 || r0 >= 50000) {
        throw new Error(`VirtualRange.setValues row index out of bounds (${r0 + 1} for ${tabName})`);
      }
      while (grid.length <= r0) grid.push([]);
      while (fGrid.length <= r0) fGrid.push([]);
      const rowVals = Array.isArray(values[r]) ? values[r] : [values[r]];
      const remoteRow = [];

      for (let c = 0; c < rowVals.length; c++) {
        const c0 = this.startCol1 - 1 + c;
        if (c0 < 0 || c0 >= 600) {
          throw new Error(`VirtualRange.setValues column index out of bounds (${c0 + 1} for ${tabName})`);
        }
        while (grid[r0].length <= c0) grid[r0].push("");
        while (fGrid[r0].length <= c0) fGrid[r0].push("");
        const rawVal = rowVals[c];
        const isTextCol = this.sheet.textCols.has(c0);
        const normVal = normalizeCellForStorage(
          sheetRole,
          tabName,
          r0,
          c0,
          rawVal,
          "USER_ENTERED",
          grid,
          notes,
          isTextCol
        );
        grid[r0][c0] = normVal;
        if (typeof rawVal === "string" && rawVal.trim().startsWith("=")) {
          fGrid[r0][c0] = rawVal.trim();
        } else {
          fGrid[r0][c0] = normVal;
        }
        remoteRow.push(formatDateForUserEntered_(rawVal));
      }
      remoteRows.push(remoteRow);
    }

    this.sheet._afterWriteValues(this.startRow1, this.startCol1, remoteRows);
    return this;
  }

  setFormula(formula) {
    return this.setValue(formula);
  }

  setFormulas(formulas) {
    return this.setValues(formulas);
  }

  setNote(note) {
    const str = note === null || note === undefined ? "" : String(note);
    const matrix = Array.from({ length: this.numRows }, () =>
      Array.from({ length: this.numCols }, () => str)
    );
    return this.setNotes(matrix);
  }

  setNotes(notesMatrix) {
    if (!Array.isArray(notesMatrix)) return this;
    const notes = this.sheet.notesGrid;
    for (let r = 0; r < notesMatrix.length; r++) {
      const r0 = this.startRow1 - 1 + r;
      if (r0 < 0 || r0 >= 50000) {
        throw new Error(`VirtualRange.setNotes row index out of bounds (${r0 + 1} for ${this.sheet.name})`);
      }
      const rowNotes = Array.isArray(notesMatrix[r]) ? notesMatrix[r] : [notesMatrix[r]];
      for (let c = 0; c < rowNotes.length; c++) {
        const c0 = this.startCol1 - 1 + c;
        if (c0 < 0 || c0 >= 600) {
          throw new Error(`VirtualRange.setNotes column index out of bounds (${c0 + 1} for ${this.sheet.name})`);
        }
        const nStr = rowNotes[c] === null || rowNotes[c] === undefined ? "" : String(rowNotes[c]);
        if (nStr) {
          notes[`${r0}:${c0}`] = nStr;
        } else {
          delete notes[`${r0}:${c0}`];
        }
      }
    }
    this.sheet._afterWriteNotes(this.startRow1, this.startCol1, notesMatrix);
    return this;
  }

  clearNote() {
    return this.setNote("");
  }

  clearContent() {
    const grid = this.sheet.valuesGrid;
    const fGrid = this.sheet.formulasGrid;
    for (let r = 0; r < this.numRows; r++) {
      const r0 = this.startRow1 - 1 + r;
      if (grid[r0]) {
        for (let c = 0; c < this.numCols; c++) {
          const c0 = this.startCol1 - 1 + c;
          if (c0 < grid[r0].length) grid[r0][c0] = "";
        }
      }
      if (fGrid[r0]) {
        for (let c = 0; c < this.numCols; c++) {
          const c0 = this.startCol1 - 1 + c;
          if (c0 < fGrid[r0].length) fGrid[r0][c0] = "";
        }
      }
    }
    this.sheet._afterClearValues(this.getA1Notation());
    return this;
  }

  clearContents() {
    return this.clearContent();
  }

  clear(options) {
    if (!options || options.contentsOnly !== false) {
      this.clearContent();
    }
    return this;
  }

  clearFormat() {
    return this;
  }

  clearDataValidations() {
    return this;
  }

  setNumberFormat(fmt) {
    if (String(fmt || "").trim() === "@") {
      for (let c = 0; c < this.numCols; c++) {
        this.sheet.textCols.add(this.startCol1 - 1 + c);
      }
    }
    return this;
  }

  setNumberFormats(formatsMatrix) {
    if (Array.isArray(formatsMatrix)) {
      for (let r = 0; r < formatsMatrix.length; r++) {
        const row = formatsMatrix[r];
        if (Array.isArray(row)) {
          for (let c = 0; c < row.length; c++) {
            if (String(row[c] || "").trim() === "@") {
              this.sheet.textCols.add(this.startCol1 - 1 + c);
            }
          }
        }
      }
    }
    return this;
  }
  setBackground(color) {
    if (this.sheet && this.sheet.spreadsheet && this.sheet.spreadsheet.isRemoteGoogleSheet) {
      const rgb = hexToGoogleRgb_(color);
      const cellObj = rgb
        ? { userEnteredFormat: { backgroundColor: rgb } }
        : { userEnteredFormat: {} };
      this.sheet.spreadsheet._onSheetMutated(this.sheet.name, {
        type: "structural",
        request: {
          repeatCell: {
            range: {
              sheetId: Number(this.sheet.sheetId || 0),
              startRowIndex: this.startRow1 - 1,
              endRowIndex: this.startRow1 - 1 + this.numRows,
              startColumnIndex: this.startCol1 - 1,
              endColumnIndex: this.startCol1 - 1 + this.numCols,
            },
            cell: cellObj,
            fields: "userEnteredFormat.backgroundColor",
          },
        },
      });
    }
    return this;
  }
  setBackgrounds(colorMatrix) {
    if (!Array.isArray(colorMatrix) || colorMatrix.length === 0) return this;
    if (this.sheet && this.sheet.spreadsheet && this.sheet.spreadsheet.isRemoteGoogleSheet) {
      for (let r = 0; r < colorMatrix.length; r++) {
        const row = colorMatrix[r];
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < row.length; c++) {
          const color = row[c];
          const rgb = hexToGoogleRgb_(color);
          const cellObj = rgb
            ? { userEnteredFormat: { backgroundColor: rgb } }
            : { userEnteredFormat: {} };
          this.sheet.spreadsheet._onSheetMutated(this.sheet.name, {
            type: "structural",
            request: {
              repeatCell: {
                range: {
                  sheetId: Number(this.sheet.sheetId || 0),
                  startRowIndex: this.startRow1 - 1 + r,
                  endRowIndex: this.startRow1 + r,
                  startColumnIndex: this.startCol1 - 1 + c,
                  endColumnIndex: this.startCol1 + c,
                },
                cell: cellObj,
                fields: "userEnteredFormat.backgroundColor",
              },
            },
          });
        }
      }
    }
    return this;
  }
  setFontColor() {
    return this;
  }
  setFontFamily() {
    return this;
  }
  setFontLine() {
    return this;
  }
  setFontSize() {
    return this;
  }
  setFontStyle() {
    return this;
  }
  setFontWeight() {
    return this;
  }
  setVerticalAlignment() {
    return this;
  }
  setHorizontalAlignment() {
    return this;
  }
  setWrapStrategy() {
    return this;
  }
  setDataValidation() {
    return this;
  }
  shiftRowGroupDepth(delta) {
    const d = Number(delta) || 1;
    if (this.sheet && this.sheet.spreadsheet && this.sheet.spreadsheet.isRemoteGoogleSheet) {
      const startIndex = this.startRow1 - 1;
      const endIndex = startIndex + this.numRows;
      const range = {
        sheetId: this.sheet.sheetId,
        dimension: "ROWS",
        startIndex,
        endIndex,
      };

      if (d > 0) {
        for (let i = 0; i < d; i++) {
          this.sheet.spreadsheet._onSheetMutated(this.sheet.name, {
            type: "structural",
            request: {
              addDimensionGroup: { range },
            },
          });
        }
        if (!this.sheet.rowGroups) this.sheet.rowGroups = [];
        this.sheet.rowGroups.push({
          range,
          depth: (this.sheet.getRowGroupDepth(this.startRow1) || 0) + d,
        });
      } else if (d < 0) {
        const hasCoveringGroup = (this.sheet.rowGroups || []).some(
          (g) =>
            g.range &&
            g.range.dimension === "ROWS" &&
            g.range.startIndex <= startIndex &&
            g.range.endIndex >= endIndex
        );
        if (hasCoveringGroup) {
          for (let i = 0; i < Math.abs(d); i++) {
            this.sheet.spreadsheet._onSheetMutated(this.sheet.name, {
              type: "structural",
              request: {
                deleteDimensionGroup: { range },
              },
            });
          }
          if (this.sheet.rowGroups) {
            this.sheet.rowGroups = this.sheet.rowGroups.filter(
              (g) =>
                !(
                  g.range &&
                  g.range.dimension === "ROWS" &&
                  g.range.startIndex === startIndex &&
                  g.range.endIndex === endIndex
                )
            );
          }
        }
      }
    }
    return this;
  }
}

class VirtualRangeList {
  constructor(sheet, a1Notations) {
    this.sheet = sheet;
    this.ranges = (Array.isArray(a1Notations) ? a1Notations : []).map((a1) =>
      sheet.getRange(a1)
    );
  }

  getRanges() {
    return this.ranges;
  }

  clearContent() {
    for (const r of this.ranges) r.clearContent();
    return this;
  }

  clearContents() {
    return this.clearContent();
  }

  clear(options) {
    for (const r of this.ranges) r.clear(options);
    return this;
  }

  clearFormat() {
    return this;
  }

  clearNote() {
    for (const r of this.ranges) r.clearNote();
    return this;
  }

  clearDataValidations() {
    return this;
  }

  setValue(val) {
    for (const r of this.ranges) r.setValue(val);
    return this;
  }

  setFormula(f) {
    for (const r of this.ranges) r.setFormula(f);
    return this;
  }

  setNote(n) {
    for (const r of this.ranges) r.setNote(n);
    return this;
  }

  setNumberFormat(fmt) {
    for (const r of this.ranges) r.setNumberFormat(fmt);
    return this;
  }

  check() {
    return this.setValue(true);
  }

  uncheck() {
    return this.setValue(false);
  }

  setFontWeight() {
    return this;
  }
  setFontColor() {
    return this;
  }
  setFontLine() {
    return this;
  }
  setFontStyle() {
    return this;
  }
  setFontSize() {
    return this;
  }
  setFontFamily() {
    return this;
  }
  setBackground(color) {
    for (const r of this.ranges) r.setBackground(color);
    return this;
  }
  setBackgrounds(colors) {
    for (const r of this.ranges) r.setBackgrounds(colors);
    return this;
  }
  setHorizontalAlignment() {
    return this;
  }
  setVerticalAlignment() {
    return this;
  }
  setWrapStrategy() {
    return this;
  }
}

class VirtualSheet {
  constructor(spreadsheet, name, valuesGrid = [], formulasGrid = [], notesGrid = {}, sheetId = 0, maxRows = 1000, maxCols = 50, rowGroups = []) {
    this.spreadsheet = spreadsheet;
    this.name = name;
    this.valuesGrid = cloneGrid2D(valuesGrid);
    this.formulasGrid = formulasGrid && formulasGrid.length > 0 ? cloneGrid2D(formulasGrid) : cloneGrid2D(valuesGrid);
    const notesInit = Object.create(null);
    for (const [nk, nv] of Object.entries(notesGrid || {})) {
      if (nk === "__proto__" || nk === "constructor" || nk === "prototype") continue;
      notesInit[nk] = nv;
    }
    this.notesGrid = notesInit;
    this.sheetId = sheetId;
    this.maxRows = Math.max(maxRows, this.valuesGrid.length, 500);
    this.maxCols = Math.max(maxCols, getGridLastCol(this.valuesGrid), 30);
    this.rowGroups = Array.isArray(rowGroups) ? JSON.parse(JSON.stringify(rowGroups)) : [];
    this.dirty = false;
    this.textCols = new Set();
    if (spreadsheet?.sheetRole === "master" && name === "InvFromApp") {
      this.textCols = new Set([0, 2, 3]);
    } else if (spreadsheet?.sheetRole === "master" && name === "JnlsFromApp") {
      this.textCols = new Set([0, 5, 8]);
    }
  }

  _beforeRead() {
    this.spreadsheet._beforeSheetRead(this.name);
  }

  _afterWriteValues(startRow1, startCol1, remoteRows) {
    this.dirty = true;
    this.maxRows = Math.max(this.maxRows, this.valuesGrid.length);
    this.spreadsheet._onSheetMutated(this.name, {
      type: "values",
      range: `'${this.name}'!${colIdx0ToLetter(startCol1 - 1)}${startRow1}`,
      values: remoteRows,
    });
  }

  _afterClearValues(a1Coord) {
    this.dirty = true;
    const fullRange = a1Coord.includes("!") ? a1Coord : `'${this.name}'!${a1Coord}`;
    this.spreadsheet._onSheetMutated(this.name, {
      type: "clear",
      range: fullRange,
    });
  }

  _afterWriteNotes(startRow1, startCol1, notesMatrix) {
    this.dirty = true;
    if (this.spreadsheet.isRemoteGoogleSheet) {
      const rows = notesMatrix.map((r) =>
        (Array.isArray(r) ? r : [r]).map((n) => ({
          note: n === null || n === undefined ? "" : String(n),
        }))
      );
      this.spreadsheet._onSheetMutated(this.name, {
        type: "structural",
        request: {
          updateCells: {
            range: {
              sheetId: this.sheetId,
              startRowIndex: startRow1 - 1,
              endRowIndex: startRow1 - 1 + rows.length,
              startColumnIndex: startCol1 - 1,
              endColumnIndex: startCol1 - 1 + (rows[0]?.length || 1),
            },
            rows: rows.map((values) => ({ values })),
            fields: "note",
          },
        },
      });
    } else {
      this.spreadsheet._onSheetMutated(this.name, { type: "notes" });
    }
  }

  getName() {
    return this.name;
  }

  getSheetName() {
    return this.name;
  }

  getSheetId() {
    return this.sheetId;
  }

  getParent() {
    return this.spreadsheet;
  }

  getLastRow() {
    this._beforeRead();
    return getGridLastRow(this.valuesGrid);
  }

  getLastColumn() {
    this._beforeRead();
    return getGridLastCol(this.valuesGrid);
  }

  getMaxRows() {
    this._beforeRead();
    return Math.max(this.maxRows, this.valuesGrid.length, 1);
  }

  getMaxColumns() {
    this._beforeRead();
    return Math.max(this.maxCols, getGridLastCol(this.valuesGrid), 1);
  }

  getDataRange() {
    this._beforeRead();
    const lr = Math.max(1, getGridLastRow(this.valuesGrid));
    const lc = Math.max(1, getGridLastCol(this.valuesGrid));
    return new VirtualRange(this, 1, 1, lr, lc);
  }

  getRange(rowOrA1, col, numRows, numCols) {
    if (typeof rowOrA1 === "string") {
      const parsed = parseA1Range(rowOrA1, this.name);
      this._beforeRead();
      const sRow1 = (parsed.startRow0 ?? 0) + 1;
      const sCol1 = (parsed.startCol0 ?? 0) + 1;
      const eRow1 =
        parsed.endRow0 != null
          ? parsed.endRow0 + 1
          : Math.max(sRow1, getGridLastRow(this.valuesGrid), this.maxRows);
      const eCol1 =
        parsed.endCol0 != null
          ? parsed.endCol0 + 1
          : Math.max(sCol1, getGridLastCol(this.valuesGrid), this.maxCols);
      return new VirtualRange(
        this,
        sRow1,
        sCol1,
        Math.max(1, eRow1 - sRow1 + 1),
        Math.max(1, eCol1 - sCol1 + 1)
      );
    }
    return new VirtualRange(
      this,
      rowOrA1,
      col ?? 1,
      numRows ?? 1,
      numCols ?? 1
    );
  }

  getRangeList(a1Notations) {
    const list = Array.isArray(a1Notations) ? a1Notations : [a1Notations];
    return new VirtualRangeList(
      this,
      list.map((s) => {
        const str = String(s || "");
        return str.includes("!") ? str.split("!")[1] : str;
      })
    );
  }

  appendRow(rowContents) {
    const nextRow1 = this.getLastRow() + 1;
    const arr = Array.isArray(rowContents) ? rowContents : [rowContents];
    this.getRange(nextRow1, 1, 1, Math.max(1, arr.length)).setValues([arr]);
    return this;
  }

  clear() {
    this.valuesGrid = [];
    this.formulasGrid = [];
    this.dirty = true;
    this.spreadsheet._onSheetMutated(this.name, {
      type: "clear",
      range: `'${this.name}'`,
    });
    return this;
  }

  clearContents() {
    return this.clear();
  }

  _remapNotesRows(mapRowFn) {
    if (!this.notesGrid || typeof this.notesGrid !== "object") return;
    const next = Object.create(null);
    for (const [k, v] of Object.entries(this.notesGrid)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (k.startsWith("__")) {
        next[k] = v;
        continue;
      }
      const colonIdx = k.indexOf(":");
      if (colonIdx < 0) continue;
      const oldR0 = Number(k.slice(0, colonIdx));
      const cPart = k.slice(colonIdx + 1);
      if (!Number.isInteger(oldR0)) continue;
      const newR0 = mapRowFn(oldR0);
      if (newR0 >= 0) {
        next[`${newR0}:${cPart}`] = v;
      }
    }
    this.notesGrid = next;
  }

  insertRowBefore(beforePosition) {
    return this.insertRowsBefore(beforePosition, 1);
  }

  insertRowsBefore(beforePosition, howMany = 1) {
    const pos = Math.max(1, Number(beforePosition) || 1);
    return this.insertRowsAfter(pos - 1, howMany);
  }

  insertRowAfter(afterPosition) {
    return this.insertRowsAfter(afterPosition, 1);
  }

  insertRowsAfter(afterPosition, howMany = 1) {
    const idx0 = Math.max(0, Number(afterPosition) || 0);
    const count = Math.max(1, Number(howMany) || 1);
    while (this.valuesGrid.length < idx0) this.valuesGrid.push([]);
    while (this.formulasGrid.length < idx0) this.formulasGrid.push([]);
    const blankRows = Array.from({ length: count }, () => []);
    this.valuesGrid.splice(idx0, 0, ...blankRows.map((r) => [...r]));
    this.formulasGrid.splice(idx0, 0, ...blankRows.map((r) => [...r]));
    this._remapNotesRows((oldR0) => (oldR0 >= idx0 ? oldR0 + count : oldR0));
    this.maxRows += count;
    this.dirty = true;

    if (this.spreadsheet.isRemoteGoogleSheet) {
      this.spreadsheet._onSheetMutated(this.name, {
        type: "structural",
        request: {
          insertDimension: {
            range: {
              sheetId: this.sheetId,
              dimension: "ROWS",
              startIndex: idx0,
              endIndex: idx0 + count,
            },
            inheritFromBefore: idx0 > 0,
          },
        },
      });
    } else {
      this.spreadsheet._onSheetMutated(this.name, { type: "structural_local" });
    }
    return this;
  }

  insertColumnsAfter(afterPosition, howMany = 1) {
    const count = Math.max(1, Number(howMany) || 1);
    this.maxCols += count;
    if (this.spreadsheet.isRemoteGoogleSheet) {
      const idx0 = Math.max(0, Number(afterPosition) || 0);
      this.spreadsheet._onSheetMutated(this.name, {
        type: "structural",
        request: {
          insertDimension: {
            range: {
              sheetId: this.sheetId,
              dimension: "COLUMNS",
              startIndex: idx0,
              endIndex: idx0 + count,
            },
            inheritFromBefore: idx0 > 0,
          },
        },
      });
    }
    return this;
  }

  deleteRow(rowPosition) {
    return this.deleteRows(rowPosition, 1);
  }

  deleteRows(rowPosition, howMany = 1) {
    const start0 = Math.max(0, (Number(rowPosition) || 1) - 1);
    const count = Math.max(1, Number(howMany) || 1);
    this.valuesGrid.splice(start0, count);
    this.formulasGrid.splice(start0, count);
    this._remapNotesRows((oldR0) => {
      if (oldR0 >= start0 && oldR0 < start0 + count) return -1;
      if (oldR0 >= start0 + count) return oldR0 - count;
      return oldR0;
    });
    this.dirty = true;

    if (this.spreadsheet.isRemoteGoogleSheet) {
      this.spreadsheet._onSheetMutated(this.name, {
        type: "structural",
        request: {
          deleteDimension: {
            range: {
              sheetId: this.sheetId,
              dimension: "ROWS",
              startIndex: start0,
              endIndex: start0 + count,
            },
          },
        },
      });
    } else {
      this.spreadsheet._onSheetMutated(this.name, { type: "structural_local" });
    }
    return this;
  }

  moveRows(rowSpec, destinationIndex) {
    const srcStart1 = rowSpec.getRow();
    const numRows = rowSpec.getNumRows();
    const srcStart0 = srcStart1 - 1;
    const dest0 = Math.max(0, (Number(destinationIndex) || 1) - 1);

    while (this.valuesGrid.length < srcStart0 + numRows) this.valuesGrid.push([]);
    while (this.formulasGrid.length < srcStart0 + numRows) this.formulasGrid.push([]);

    const wrappedForms = this.formulasGrid.map((r, r0) => ({
      oldR1: r0 + 1,
      cells: Array.isArray(r) ? [...r] : [],
    }));
    const movedVals = this.valuesGrid.splice(srcStart0, numRows);
    const movedForms = wrappedForms.splice(srcStart0, numRows);
    const insertAt0 = srcStart0 < dest0 ? Math.max(0, dest0 - numRows) : dest0;
    this.valuesGrid.splice(insertAt0, 0, ...movedVals);
    wrappedForms.splice(insertAt0, 0, ...movedForms);
    this.formulasGrid = wrappedForms.map((fObj, newR0) => {
      const newR1 = newR0 + 1;
      if (fObj.oldR1 === newR1) return fObj.cells;
      const re = new RegExp(`(?<![A-Za-z0-9_$'!])(\\$?[A-Za-z]{1,3})${fObj.oldR1}(?![0-9(])`, "g");
      return fObj.cells.map((cell) =>
        typeof cell === "string" && cell.startsWith("=")
          ? cell.replace(re, (m, colPart) => (/^PL$/i.test(colPart) ? m : `${colPart}${newR1}`))
          : cell
      );
    });
    this._remapNotesRows((oldR0) => {
      if (oldR0 >= srcStart0 && oldR0 < srcStart0 + numRows) return insertAt0 + (oldR0 - srcStart0);
      if (srcStart0 < insertAt0 && oldR0 >= srcStart0 + numRows && oldR0 < insertAt0 + numRows) return oldR0 - numRows;
      if (insertAt0 < srcStart0 && oldR0 >= insertAt0 && oldR0 < srcStart0) return oldR0 + numRows;
      return oldR0;
    });
    this.dirty = true;

    if (this.spreadsheet.isRemoteGoogleSheet) {
      this.spreadsheet._onSheetMutated(this.name, {
        type: "structural",
        request: {
          moveDimension: {
            source: {
              sheetId: this.sheetId,
              dimension: "ROWS",
              startIndex: srcStart0,
              endIndex: srcStart0 + numRows,
            },
            destinationIndex: dest0,
          },
        },
      });
    } else {
      this.spreadsheet._onSheetMutated(this.name, { type: "structural_local" });
    }
    return this;
  }

  getRowGroupDepth(rowPosition) {
    const row0 = (Number(rowPosition) || 1) - 1;
    let maxDepth = 0;
    for (const g of (this.rowGroups || [])) {
      if (g.range && g.range.dimension === "ROWS") {
        if (row0 >= g.range.startIndex && row0 < g.range.endIndex) {
          maxDepth = Math.max(maxDepth, Number(g.depth) || 1);
        }
      }
    }
    return maxDepth;
  }

  getRowGroup() {
    return {
      isCollapsed: () => false,
      collapse: () => { },
      expand: () => { },
    };
  }

  unhideRow(rangeSpec) {
    if (this.spreadsheet && this.spreadsheet.isRemoteGoogleSheet && rangeSpec) {
      const startRow1 = typeof rangeSpec.getRow === "function" ? rangeSpec.getRow() : Number(rangeSpec) || 1;
      const numRows = typeof rangeSpec.getNumRows === "function" ? rangeSpec.getNumRows() : 1;
      this.spreadsheet._onSheetMutated(this.name, {
        type: "structural",
        request: {
          updateDimensionProperties: {
            range: {
              sheetId: this.sheetId,
              dimension: "ROWS",
              startIndex: startRow1 - 1,
              endIndex: startRow1 - 1 + numRows,
            },
            properties: {
              hiddenByUser: false,
            },
            fields: "hiddenByUser",
          },
        },
      });
    }
    return this;
  }
  hideSheet() {
    return this;
  }
  showSheet() {
    return this;
  }
  setFrozenRows() {
    return this;
  }
  setColumnWidth() {
    return this;
  }
  clearConditionalFormatRules() {
    return this;
  }
  setConditionalFormatRules() {
    return this;
  }
}

class VirtualSpreadsheet {
  constructor({ id, name, sheetRole, isRemoteGoogleSheet = false, env }) {
    this.id = id;
    this.name = name || id;
    this.sheetRole = sheetRole; // 'master' | 'recon' | 'client' | 'external'
    this.isRemoteGoogleSheet = isRemoteGoogleSheet;
    this.env = env;
    this.sheetsByName = new Map();
    this.remoteMutationPhases = []; // Ordered phases of { type: 'values' | 'clear' | 'structural', ... }
  }

  getId() {
    return this.id;
  }

  getUrl() {
    return `https://docs.google.com/spreadsheets/d/${this.id}/edit`;
  }

  getName() {
    return this.name;
  }

  getSpreadsheetTimeZone() {
    return "Europe/London";
  }

  getNumSheets() {
    return this.sheetsByName.size;
  }

  getSheets() {
    return [...this.sheetsByName.values()];
  }

  getSheetByName(name) {
    return this.sheetsByName.get(String(name || "").trim()) || null;
  }

  insertSheet(name) {
    const clean = String(name || `Sheet${this.sheetsByName.size + 1}`).trim();
    if (!clean || clean === "__proto__" || clean === "constructor" || clean === "prototype") {
      throw new Error(`Invalid sheet name: ${clean}`);
    }
    if (this.sheetsByName.has(clean)) return this.sheetsByName.get(clean);
    const s = new VirtualSheet(this, clean, [], [], {}, this.sheetsByName.size + 100);
    s.dirty = true;
    this.sheetsByName.set(clean, s);
    return s;
  }

  getRange(a1Notation) {
    const parsed = parseA1Range(a1Notation, "KeyInfo");
    const sheet = this.getSheetByName(parsed.tabName) || this.insertSheet(parsed.tabName);
    const coord = String(a1Notation || "").includes("!")
      ? String(a1Notation).split("!")[1]
      : a1Notation;
    return sheet.getRange(coord);
  }

  getRangeList(a1Notations) {
    const list = Array.isArray(a1Notations) ? a1Notations : [a1Notations];
    const firstParsed = parseA1Range(list[0] || "KeyInfo!A1", "KeyInfo");
    const sheet = this.getSheetByName(firstParsed.tabName) || this.insertSheet(firstParsed.tabName);
    return sheet.getRangeList(list);
  }

  _beforeSheetRead(tabName) {
    if (this.sheetRole === "master" && this.env.masterFormulasDirty) {
      if (FORMULA_DEPENDENT_MASTER_TABS.has(tabName)) {
        const dirty = this.env.dirtyInputMasterTabs;
        if (!dirty || dirty.size === 0) return;
        const needsForRead =
          ((tabName === "InvAppList" || tabName === "InvDashList" || tabName === "InvComp") &&
            (dirty.has("InvFromApp") || dirty.has("InvComp") || dirty.has("ConfCalcs") || dirty.has("KeyInfo") || dirty.has("InvAppList") || dirty.has("InvDashList"))) ||
          ((tabName === "JnlAppList" || tabName === "DirDashList" || tabName === "DirComp") &&
            (dirty.has("JnlsFromApp") || dirty.has("DirComp") || dirty.has("ConfCalcs") || dirty.has("Outgoings") || dirty.has("OutgNotes") || dirty.has("KeyInfo") || dirty.has("JnlAppList") || dirty.has("DirDashList"))) ||
          ((tabName === "CRMList" || tabName === "CRMComp") &&
            (dirty.has("DataFromCRM") || dirty.has("CRMComp") || dirty.has("CRMList") || dirty.has("KeyInfo") || dirty.has("ConfCalcs") || dirty.has("PipeCalcs") || dirty.has("DataChgAlert"))) ||
          ((tabName === "Outgoings" || tabName === "KeyInfo" || tabName === "PLComp") &&
            (dirty.has("PLFromApp") || dirty.has("Year0PLFromApp") || dirty.has("PLAdds") || dirty.has("PLComp") || dirty.has("KeyInfo") || dirty.has("Outgoings") || dirty.has("DataFromCRM"))) ||
          (tabName === "Year0Data" && (dirty.has("Year0PLFromApp") || dirty.has("Year0Data") || dirty.has("KeyInfo"))) ||
          (tabName === "TimeComp" && (dirty.has("DataFromTime") || dirty.has("TimeComp") || dirty.has("KeyInfo"))) ||
          tabName === "DataChgAlert";
        if (needsForRead) {
          this.env.recomputeMasterFormulasSync(true);
        }
      }
    }
  }

  _onSheetMutated(tabName, mutation) {
    if (
      (this.sheetRole === "master" &&
        (FORMULA_INPUT_MASTER_TABS.has(tabName) || tabName === "OutgNotes" || tabName === "Year0PLFromApp")) ||
      (this.sheetRole === "recon" && tabName === "PLAdds")
    ) {
      // Ignore lock/timestamp status writes in DataChgAlert rows 1..50 (only rows >= 50 hold ignore flags used by CRMComp)
      let isIgnoredLockWrite = false;
      if (tabName === "DataChgAlert" && mutation?.range) {
        const mRow = String(mutation.range).match(/![A-Z]+(\d+)/i);
        if (mRow && parseInt(mRow[1], 10) < 50) {
          isIgnoredLockWrite = true;
        }
      }
      if (!isIgnoredLockWrite) {
        this.env.dirtyInputMasterTabs?.add(this.sheetRole === "recon" ? "PLAdds" : tabName);
        this.env.masterFormulasDirty = true;
        this.env.gridsMutatedAfterRecompute = true;
      }
    }

    if (this.isRemoteGoogleSheet && mutation) {
      const lastPhase = this.remoteMutationPhases[this.remoteMutationPhases.length - 1];
      if (mutation.type === "values") {
        if (lastPhase && lastPhase.type === "values") {
          lastPhase.data.push({ range: mutation.range, values: mutation.values });
        } else {
          this.remoteMutationPhases.push({
            type: "values",
            data: [{ range: mutation.range, values: mutation.values }],
          });
        }
      } else if (mutation.type === "clear") {
        if (lastPhase && lastPhase.type === "clear") {
          lastPhase.ranges.push(mutation.range);
        } else {
          this.remoteMutationPhases.push({
            type: "clear",
            ranges: [mutation.range],
          });
        }
      } else if (mutation.type === "structural") {
        if (lastPhase && lastPhase.type === "structural") {
          lastPhase.requests.push(mutation.request);
        } else {
          this.remoteMutationPhases.push({
            type: "structural",
            requests: [mutation.request],
          });
        }
      }
    }
  }
}

/**
 * Creates a complete GAS execution environment for a client in `master_mode = 'supabase'`.
 */
export async function createGasEnvironment({
  ctx,
  sheets,
  onProgress = null,
  autoReconcileFn = null,
  executionMeta = null,
  loadTabsMode = "all",
  includeReconMonthly = true,
}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const execStartedAtMs = Date.now();
  const execStartedAtIso = new Date(execStartedAtMs).toISOString();
  const executionLogs = [];
  const uiAlerts = [];

  function formatLogArg_(arg) {
    if (arg === null) return "null";
    if (arg === undefined) return "undefined";
    if (arg instanceof Error) return arg.stack || arg.message || String(arg);
    if (typeof arg === "object") {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }

  function appendExecLog(level, args) {
    if (executionLogs.length >= 1000) return;
    const now = new Date();
    const timeStr = now.toISOString().slice(11, 23); // HH:mm:ss.SSS UTC
    const msg = args.map(formatLogArg_).join(" ");
    executionLogs.push(`[${timeStr}] [${level}] ${msg}`);
  }

  const gasConsole = {
    log: (...args) => {
      appendExecLog("INFO", args);
      globalThis.console.log(`[GAS:${ctx.clientName}]`, ...args);
    },
    info: (...args) => {
      appendExecLog("INFO", args);
      globalThis.console.info(`[GAS:${ctx.clientName}]`, ...args);
    },
    warn: (...args) => {
      appendExecLog("WARN", args);
      globalThis.console.warn(`[GAS:${ctx.clientName}]`, ...args);
    },
    error: (...args) => {
      appendExecLog("ERROR", args);
      globalThis.console.error(`[GAS:${ctx.clientName}]`, ...args);
    },
  };

  const envState = {
    ctx,
    sheets,
    masterFormulasDirty: false,
    dirtyInputMasterTabs: new Set(),
    gridsMutatedAfterRecompute: false,
    uiAlerts,
    masterSS: null,
    reconSS: null,
    remoteSpreadsheets: new Map(),
    scriptProperties: new Map(),
    scriptPropertiesDirty: false,
    scriptCache: new Map(),
    recomputeMasterFormulasSync: () => { },
  };

  // Seed ScriptProperties with environment secrets
  envState.scriptProperties.set(
    "PULSE_INTERNAL_SECRET",
    String(process.env.PULSE_INTERNAL_SECRET || "").trim()
  );
  envState.scriptProperties.set(
    "AGENT_TRIGGER_SECRET",
    String(process.env.AGENT_TRIGGER_SECRET || process.env.CRON_SECRET || "").trim()
  );
  envState.scriptProperties.set(
    "CRON_SECRET",
    String(process.env.CRON_SECRET || "").trim()
  );
  envState.scriptProperties.set(
    "VERCEL_BYPASS_TOKEN",
    String(process.env.VERCEL_BYPASS_TOKEN || process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim()
  );

  // 1. Load active Master & Recon tabs for this client from Supabase `master_sheet_grids`
  // Omit `formulas_grid` on bulk fetch (since Master formulas are evaluated in JS by `masterFormulaEngine.js`).
  // Note: Master tabs are filtered to ACTIVE_GAS_MASTER_TABS (or COMPARISON_ONLY_MASTER_TABS when `loadTabsMode === "comparisons_only"`);
  // Recon tabs (monthly MMYY tabs, KeyInfo, PLAdds, etc.) are all loaded for full GAS runtime runs,
  // or narrowed to `PLAdds` when `loadTabsMode === "comparisons_only"`.
  const isComparisonsOnly = loadTabsMode === "comparisons_only";
  const skipReconMonthly = isComparisonsOnly || includeReconMonthly === false;
  const masterTabsFilter = isComparisonsOnly ? COMPARISON_ONLY_MASTER_TABS : ACTIVE_GAS_MASTER_TABS;
  const reconQuery = supabase
    .from("master_sheet_grids")
    .select("id, sheet_role, tab_name, values_grid, notes_grid, row_count, col_count")
    .eq("client_name", ctx.clientName)
    .eq("sheet_role", "recon");
  const filteredReconQuery = isComparisonsOnly
    ? reconQuery.eq("tab_name", "PLAdds")
    : skipReconMonthly
      ? reconQuery.in("tab_name", ["KeyInfo", "PLAdds"])
      : reconQuery;

  const [masterGridResp, reconGridResp, y0FormulaResp] = await Promise.all([
    supabase
      .from("master_sheet_grids")
      .select("id, sheet_role, tab_name, values_grid, notes_grid, row_count, col_count")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .in("tab_name", masterTabsFilter),
    filteredReconQuery,
    skipReconMonthly
      ? Promise.resolve({ data: null })
      : supabase
        .from("master_sheet_grids")
        .select("formulas_grid")
        .eq("client_name", ctx.clientName)
        .eq("sheet_role", "master")
        .eq("tab_name", "Year0Data")
        .maybeSingle(),
  ]);

  if (masterGridResp?.error) {
    throw new Error(`Failed to load master_sheet_grids for ${ctx.clientName}: ${masterGridResp.error.message}`);
  }
  if (reconGridResp?.error) {
    throw new Error(`Failed to load recon_sheet_grids for ${ctx.clientName}: ${reconGridResp.error.message}`);
  }
  const gridRows = [...(masterGridResp?.data || []), ...(reconGridResp?.data || [])];
  const y0FormulasGrid = y0FormulaResp?.data?.formulas_grid || null;

  const masterSS = new VirtualSpreadsheet({
    id: ctx.masterSheetId || `virtual_master_${ctx.clientName}`,
    name: `${ctx.clientName} Master`,
    sheetRole: "master",
    isRemoteGoogleSheet: false,
    env: envState,
  });

  const reconSS = new VirtualSpreadsheet({
    id: ctx.reconSheetId || `virtual_recon_${ctx.clientName}`,
    name: `${ctx.clientName} Recon`,
    sheetRole: "recon",
    isRemoteGoogleSheet: false,
    env: envState,
  });

  envState.masterSS = masterSS;
  envState.reconSS = reconSS;

  let idxCounter = 1;
  for (const row of gridRows) {
    const targetSS = row.sheet_role === "recon" ? reconSS : masterSS;
    const compactedVals = compactGrid2D(row.values_grid || []);
    const fGrid =
      row.sheet_role === "master" && row.tab_name === "Year0Data" && Array.isArray(y0FormulasGrid)
        ? y0FormulasGrid
        : compactedVals;
    const vs = new VirtualSheet(
      targetSS,
      row.tab_name,
      compactedVals,
      fGrid,
      row.notes_grid || {},
      idxCounter++,
      Math.max(1000, row.row_count || 0),
      Math.max(50, row.col_count || 0)
    );
    vs._loadedValuesJson = JSON.stringify(compactedVals);
    vs._loadedNotesJson = JSON.stringify(row.notes_grid || {});
    targetSS.sheetsByName.set(row.tab_name, vs);
  }

  // Hydrate persisted ScriptProperties from virtual `GasScriptProps` tab
  const propsSheet = masterSS.getSheetByName("GasScriptProps");
  if (propsSheet && Array.isArray(propsSheet.valuesGrid)) {
    for (let r = 1; r < propsSheet.valuesGrid.length; r++) {
      const k = String(propsSheet.valuesGrid[r]?.[0] ?? "").trim();
      const v = propsSheet.valuesGrid[r]?.[1];
      if (k && !envState.scriptProperties.has(k)) {
        envState.scriptProperties.set(k, String(v ?? ""));
      }
    }
  }

  // Ensure KeyInfo!C1/D1/X28/X32 contain the canonical Client/Master/Recon IDs
  const kiSheet = masterSS.getSheetByName("KeyInfo");
  if (kiSheet) {
    while (kiSheet.valuesGrid.length < 35) kiSheet.valuesGrid.push([]);
    if (ctx.clientSheetId) {
      if (!kiSheet.valuesGrid[0][2]) {
        kiSheet.valuesGrid[0][2] = `https://docs.google.com/spreadsheets/d/${ctx.clientSheetId}/edit`;
      }
      if (!kiSheet.valuesGrid[27]) kiSheet.valuesGrid[27] = [];
      kiSheet.valuesGrid[27][23] = ctx.clientSheetId; // X28
    }
    if (ctx.reconSheetId) {
      if (!kiSheet.valuesGrid[31]) kiSheet.valuesGrid[31] = [];
      if (!kiSheet.valuesGrid[31][23]) {
        kiSheet.valuesGrid[31][23] = `https://docs.google.com/spreadsheets/d/${ctx.reconSheetId}/edit`; // X32
      }
    }
  }

  const initialE21 = String(kiSheet?.valuesGrid?.[20]?.[4] ?? "");
  const initialI29 = String(kiSheet?.valuesGrid?.[28]?.[8] ?? "");

  // Clear any stale concurrency locks in DataChgAlert!B4:I4 before starting
  const dcaSheet = masterSS.getSheetByName("DataChgAlert");
  if (dcaSheet && dcaSheet.valuesGrid[3]) {
    for (let c = 1; c <= 8; c++) {
      if (dcaSheet.valuesGrid[3][c]) {
        dcaSheet.valuesGrid[3][c] = "";
        dcaSheet.dirty = true;
      }
    }
  }

  // Helper to sync live ConfCalcs (A1:JG5001), PipeCalcs (A1:JG1000), Outgoings (A1:AX295), and OutgNotes (A1:AV112) from Client Sheet into Master grids
  async function syncClientLinkedMasterTabsFromLiveSheet() {
    if (!sheets || !ctx.clientSheetId) return;
    try {
      const [resp, outgNotesResp] = await Promise.all([
        withSheetsRetry_(
          () =>
            sheets.spreadsheets.values.batchGet({
              spreadsheetId: ctx.clientSheetId,
              ranges: ["ConfCalcs!A1:JG5001", "PipeCalcs!A1:JG1000", "Outgoings!A1:AX295"],
              valueRenderOption: "UNFORMATTED_VALUE",
              _bypassSupabaseVirtualSheet: ctx.clientMode !== "supabase",
            }),
          `syncClientLinkedMasterTabs batchGet(${ctx.clientName})`
        ),
        withSheetsRetry_(
          () =>
            sheets.spreadsheets.values.get({
              spreadsheetId: ctx.clientSheetId,
              range: "OutgNotes!A1:AV112",
              valueRenderOption: "UNFORMATTED_VALUE",
              _bypassSupabaseVirtualSheet: ctx.clientMode !== "supabase",
            }),
          `syncClientLinkedMasterTabs OutgNotes(${ctx.clientName})`
        ).catch(() => null),
      ]);
      const vRanges = resp?.data?.valueRanges || [];
      const trimCalcsGrid_ = (rawRows) => {
        const compacted = compactGrid2D(rawRows);
        let lastActive = 119;
        const checkCols = [0, 1, 17, 32, 35, 37, 41, 48, 55, 76, 83, 90];
        const isAct = (v) => v !== "" && v !== null && v !== undefined && v !== 0 && v !== "0" && v !== false;
        for (let r = compacted.length - 1; r >= 120; r--) {
          const row = compacted[r];
          if (!Array.isArray(row)) continue;
          if (checkCols.some((c) => isAct(row[c]))) {
            lastActive = r;
            break;
          }
        }
        const keepCount = Math.min(compacted.length, lastActive + 11);
        return compactGrid2D(compacted.slice(0, keepCount));
      };
      let anyTabChanged = false;
      if (vRanges[0]?.values) {
        const nextCc = trimCalcsGrid_(vRanges[0].values);
        const ccSheet = masterSS.getSheetByName("ConfCalcs") || masterSS.insertSheet("ConfCalcs");
        if (JSON.stringify(nextCc) !== JSON.stringify(ccSheet.valuesGrid)) {
          ccSheet.valuesGrid = nextCc;
          ccSheet.dirty = true;
          anyTabChanged = true;
        }
      }
      if (vRanges[1]?.values) {
        const nextPc = trimCalcsGrid_(vRanges[1].values);
        const pcSheet = masterSS.getSheetByName("PipeCalcs") || masterSS.insertSheet("PipeCalcs");
        if (JSON.stringify(nextPc) !== JSON.stringify(pcSheet.valuesGrid)) {
          pcSheet.valuesGrid = nextPc;
          pcSheet.dirty = true;
          anyTabChanged = true;
        }
      }
      if (vRanges[2]?.values) {
        const nextOut = compactGrid2D(vRanges[2].values);
        const outSheet = masterSS.getSheetByName("Outgoings") || masterSS.insertSheet("Outgoings");
        if (JSON.stringify(nextOut) !== JSON.stringify(outSheet.valuesGrid)) {
          outSheet.valuesGrid = nextOut;
          outSheet.dirty = true;
          anyTabChanged = true;
        }
      }
      const clientOutgNotes = outgNotesResp?.data?.values;
      if (
        Array.isArray(clientOutgNotes) &&
        clientOutgNotes.some((r) => Array.isArray(r) && r.some((cell) => cell !== "" && cell !== null && cell !== undefined))
      ) {
        const nextOn = compactGrid2D(clientOutgNotes);
        const onSheet = masterSS.getSheetByName("OutgNotes") || masterSS.insertSheet("OutgNotes");
        if (JSON.stringify(nextOn) !== JSON.stringify(onSheet.valuesGrid)) {
          onSheet.valuesGrid = nextOn;
          onSheet.dirty = true;
          anyTabChanged = true;
        }
      }
      if (anyTabChanged) {
        if (masterSS.getSheetByName("ConfCalcs")?.dirty) envState.dirtyInputMasterTabs.add("ConfCalcs");
        if (masterSS.getSheetByName("PipeCalcs")?.dirty) envState.dirtyInputMasterTabs.add("PipeCalcs");
        if (masterSS.getSheetByName("Outgoings")?.dirty) envState.dirtyInputMasterTabs.add("Outgoings");
        if (masterSS.getSheetByName("OutgNotes")?.dirty) envState.dirtyInputMasterTabs.add("OutgNotes");
        envState.masterFormulasDirty = true;
      }
    } catch (err) {
      console.warn(`[gasEnvironment] Could not refresh ConfCalcs/PipeCalcs/Outgoings for ${ctx.clientName}:`, err.message);
    }
  }

  await syncClientLinkedMasterTabsFromLiveSheet();

  // Synchronous in-memory Master formula evaluator (selective DAG when triggered by dirty tabs)
  envState.recomputeMasterFormulasSync = (onlyDirty = false) => {
    const gridsObj = {};
    for (const [tName, sObj] of masterSS.sheetsByName.entries()) {
      gridsObj[tName] = sObj.valuesGrid;
    }
    const reconPlAdds = reconSS.getSheetByName("PLAdds");
    if (reconPlAdds && reconPlAdds.valuesGrid.length > 0) {
      gridsObj.ReconPLAdds = reconPlAdds.valuesGrid;
      const masterPlAdds = masterSS.getSheetByName("PLAdds") || masterSS.insertSheet("PLAdds");
      masterPlAdds.valuesGrid = compactGrid2D(reconPlAdds.valuesGrid);
      gridsObj.PLAdds = masterPlAdds.valuesGrid;
      masterPlAdds.dirty = true;
    }
    let evaluatedTabs;
    if (!onlyDirty || envState.dirtyInputMasterTabs.size === 0) {
      evaluateAllMasterFormulas(gridsObj);
      evaluatedTabs = [
        "Outgoings",
        "InvAppList",
        "InvDashList",
        "InvComp",
        "JnlAppList",
        "DirDashList",
        "DirComp",
        "CRMList",
        "CRMComp",
        "KeyInfo",
        "PLComp",
        "Year0Data",
        "TimeComp",
        "DataChgAlert",
      ];
    } else {
      const d = envState.dirtyInputMasterTabs;
      const outSet = new Set();
      const needsCrm =
        d.has("CRMComp") || d.has("DataFromCRM") || d.has("CRMList") || d.has("KeyInfo") ||
        d.has("ConfCalcs") || d.has("PipeCalcs") || d.has("DataChgAlert");
      const needsPl =
        d.has("PLComp") || d.has("PLFromApp") || d.has("Year0PLFromApp") ||
        d.has("PLAdds") || d.has("KeyInfo") || d.has("Outgoings");
      const needsInv =
        d.has("InvFromApp") || d.has("InvAppList") || d.has("InvDashList") || d.has("InvComp") ||
        d.has("ConfCalcs") || d.has("KeyInfo");
      const needsDir =
        d.has("JnlsFromApp") || d.has("JnlAppList") || d.has("DirDashList") || d.has("DirComp") ||
        d.has("ConfCalcs") || d.has("Outgoings") || d.has("OutgNotes") || d.has("KeyInfo");
      const needsYear0 = d.has("Year0PLFromApp") || d.has("Year0Data") || d.has("KeyInfo");
      const needsTime = d.has("DataFromTime") || d.has("TimeComp") || d.has("KeyInfo");

      if (needsCrm) {
        evaluateCRMList(gridsObj);
        evaluateCRMComp(gridsObj);
        outSet.add("CRMList");
        outSet.add("CRMComp");
      }
      if (needsPl || needsCrm || needsYear0) {
        if (d.has("KeyInfo") || d.has("Outgoings")) {
          evaluateOutgoingsMasterTab(gridsObj);
          outSet.add("Outgoings");
        }
        evaluateKeyInfoAndPLComp(gridsObj);
        outSet.add("KeyInfo");
        if (needsPl) outSet.add("PLComp");
      }
      if (needsYear0 && gridsObj.Year0Data?.length > 0) {
        evaluateYear0Data(gridsObj);
        outSet.add("Year0Data");
      }
      if (needsTime && gridsObj.TimeComp?.length > 0) {
        evaluateTimeComp(gridsObj);
        outSet.add("TimeComp");
      }
      if (needsInv) {
        evaluateInvAppList(gridsObj);
        evaluateInvDashList(gridsObj);
        evaluateInvComp(gridsObj);
        outSet.add("InvAppList");
        outSet.add("InvDashList");
        outSet.add("InvComp");
      }
      if (needsDir) {
        evaluateJnlAppList(gridsObj);
        evaluateDirDashList(gridsObj);
        evaluateDirComp(gridsObj);
        outSet.add("JnlAppList");
        outSet.add("DirDashList");
        outSet.add("DirComp");
      }
      evaluatedTabs = [...outSet];
    }
    for (const fTab of evaluatedTabs) {
      const sObj = masterSS.getSheetByName(fTab);
      if (sObj && gridsObj[fTab]) {
        sObj.valuesGrid = gridsObj[fTab];
        sObj.dirty = true;
      }
    }
    envState.dirtyInputMasterTabs.clear();
    envState.masterFormulasDirty = false;
    envState.gridsMutatedAfterRecompute = false;
  };

  // Run initial formula evaluation so all comparison tabs are fresh
  envState.recomputeMasterFormulasSync();

  // Helper to open & preload a remote Google Spreadsheet (e.g. Client Sheet or external CRM sheet)
  async function openRemoteGoogleSpreadsheet(rawIdOrUrl) {
    const cleanId = extractSheetIdFromUrl(rawIdOrUrl) || String(rawIdOrUrl || "").trim();
    if (!cleanId) throw new Error(`Invalid spreadsheet ID or URL: ${rawIdOrUrl}`);
    if (cleanId === ctx.masterSheetId) return masterSS;
    if (cleanId === ctx.reconSheetId) return reconSS;
    if (envState.remoteSpreadsheets.has(cleanId)) {
      return envState.remoteSpreadsheets.get(cleanId);
    }
    if (!sheets) {
      throw new Error(`Google Sheets API client is required to open remote spreadsheet ${cleanId}`);
    }

    const isClientSheet = cleanId === ctx.clientSheetId;
    if (!isClientSheet) {
      const kiSheet = masterSS?.getSheetByName?.("KeyInfo");
      const x11Raw = String(kiSheet?.valuesGrid?.[10]?.[23] ?? "").trim();
      const x14Raw = String(kiSheet?.valuesGrid?.[13]?.[23] ?? "").trim();
      const allowedExternalIds = new Set(
        [
          extractSheetIdFromUrl(x11Raw) || x11Raw,
          extractSheetIdFromUrl(x14Raw) || x14Raw,
        ].filter(Boolean)
      );
      if (!allowedExternalIds.has(cleanId)) {
        throw new Error(`Access denied: Remote spreadsheet "${cleanId}" is not authorized for the active tenant.`);
      }
      await assertExternalCrmSpreadsheet(sheets, cleanId);
    }
    const bypassVirtual = isClientSheet ? ctx.clientMode !== "supabase" : true;
    const metaResp = await withSheetsRetry_(
      () =>
        sheets.spreadsheets.get({
          spreadsheetId: cleanId,
          fields: "properties.title,sheets(properties(sheetId,title,index,gridProperties),rowGroups)",
          _bypassSupabaseVirtualSheet: bypassVirtual,
        }),
      `spreadsheets.get(${cleanId})`
    );

    const remoteSS = new VirtualSpreadsheet({
      id: cleanId,
      name: metaResp?.data?.properties?.title || cleanId,
      sheetRole: isClientSheet ? "client" : "external",
      isRemoteGoogleSheet: true,
      env: envState,
    });

    const rawSheets = metaResp?.data?.sheets || [];
    const sheetPropsList = rawSheets.map((s) => s.properties).filter(Boolean);
    const existingTabNames = new Set(sheetPropsList.map((p) => p.title));

    const tabsToLoad = isClientSheet
      ? CLIENT_TABS_TO_PRELOAD.filter((t) => existingTabNames.has(t))
      : sheetPropsList.map((p) => p.title);

    const valuesByTab = new Map();
    const formulasByTab = new Map();
    const notesByTab = new Map();

    const chunks = [];
    for (let i = 0; i < tabsToLoad.length; i += 6) {
      chunks.push(tabsToLoad.slice(i, i + 6));
    }

    const noteRanges = [];
    if (isClientSheet) {
      if (existingTabNames.has("Outgoings")) noteRanges.push("Outgoings!A1:AZ230");
      if (existingTabNames.has("Confirmed")) noteRanges.push("Confirmed!A1:CR5000");
    }

    const [chunkResults, notesResp] = await Promise.all([
      Promise.all(
        chunks.map(async (chunk) => {
          const ranges = chunk.map((t) => `'${t}'`);
          const [valBatch, formBatch] = await Promise.all([
            withSheetsRetry_(
              () =>
                sheets.spreadsheets.values.batchGet({
                  spreadsheetId: cleanId,
                  ranges,
                  valueRenderOption: "UNFORMATTED_VALUE",
                  _bypassSupabaseVirtualSheet: bypassVirtual,
                }),
              `values.batchGet(${cleanId})`
            ),
            withSheetsRetry_(
              () =>
                sheets.spreadsheets.values.batchGet({
                  spreadsheetId: cleanId,
                  ranges,
                  valueRenderOption: "FORMULA",
                  _bypassSupabaseVirtualSheet: bypassVirtual,
                }),
              `values.batchGet formulas(${cleanId})`
            ).catch(() => ({ data: { valueRanges: [] } })),
          ]);
          return { chunk, valBatch, formBatch };
        })
      ),
      noteRanges.length > 0
        ? withSheetsRetry_(
          () =>
            sheets.spreadsheets.get({
              spreadsheetId: cleanId,
              ranges: noteRanges,
              fields: "sheets(properties.title,data(startRow,startColumn,rowData.values.note))",
              _bypassSupabaseVirtualSheet: bypassVirtual,
            }),
          `spreadsheets.get notes(${cleanId})`
        ).catch((nErr) => {
          console.warn(`[gasEnvironment] Note preload warning for ${cleanId}:`, nErr.message);
          return null;
        })
        : Promise.resolve(null),
    ]);

    for (const { chunk, valBatch, formBatch } of chunkResults) {
      chunk.forEach((tabName, idx) => {
        valuesByTab.set(tabName, valBatch?.data?.valueRanges?.[idx]?.values || []);
        formulasByTab.set(tabName, formBatch?.data?.valueRanges?.[idx]?.values || []);
      });
    }

    if (notesResp?.data?.sheets) {
      for (const sh of notesResp.data.sheets) {
        const tName = sh.properties?.title;
        if (!tName) continue;
        const nMap = {};
        for (const dBlock of sh.data || []) {
          const sR = dBlock.startRow || 0;
          const sC = dBlock.startColumn || 0;
          (dBlock.rowData || []).forEach((rObj, rOff) => {
            (rObj.values || []).forEach((cObj, cOff) => {
              if (cObj?.note) {
                nMap[`${sR + rOff}:${sC + cOff}`] = cObj.note;
              }
            });
          });
        }
        notesByTab.set(tName, nMap);
      }
    }

    for (const sh of rawSheets) {
      const prop = sh.properties || {};
      const tName = prop.title;
      if (!tName) continue;
      const vGrid = valuesByTab.get(tName) || [];
      const fGrid = formulasByTab.get(tName) || vGrid;
      const nGrid = notesByTab.get(tName) || {};
      const maxR = prop.gridProperties?.rowCount || Math.max(1000, vGrid.length);
      const maxC = prop.gridProperties?.columnCount || Math.max(50, getGridLastCol(vGrid));
      const vs = new VirtualSheet(remoteSS, tName, vGrid, fGrid, nGrid, prop.sheetId || 0, maxR, maxC, sh.rowGroups || []);
      remoteSS.sheetsByName.set(tName, vs);
    }

    envState.remoteSpreadsheets.set(cleanId, remoteSS);
    return remoteSS;
  }

  // Flush all pending remote mutations & recompute Master formulas & persist dirty Master/Recon grids
  async function flushAll({ persistSupabase = true } = {}) {
    let clientSheetWasMutated = false;

    for (const [remoteId, remoteSS] of envState.remoteSpreadsheets.entries()) {
      if (remoteSS.remoteMutationPhases.length === 0) continue;
      const isClientSheet = remoteId === ctx.clientSheetId;
      if (isClientSheet) clientSheetWasMutated = true;
      const bypassVirtual = isClientSheet ? ctx.clientMode !== "supabase" : true;

      const phases = remoteSS.remoteMutationPhases.splice(0, remoteSS.remoteMutationPhases.length);
      for (let pIdx = 0; pIdx < phases.length; pIdx++) {
        const phase = phases[pIdx];
        const skipRecompute = isClientSheet && !bypassVirtual && pIdx < phases.length - 1;
        if (phase.type === "clear" && phase.ranges.length > 0) {
          await withSheetsRetry_(
            () =>
              sheets.spreadsheets.values.batchClear({
                spreadsheetId: remoteId,
                requestBody: { ranges: phase.ranges },
                _bypassSupabaseVirtualSheet: bypassVirtual,
                _skipFormulaRecompute: skipRecompute,
              }),
            `values.batchClear(${remoteId})`
          );
        } else if (phase.type === "values" && phase.data.length > 0) {
          await withSheetsRetry_(
            () =>
              sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: remoteId,
                requestBody: {
                  valueInputOption: "USER_ENTERED",
                  data: phase.data,
                },
                _bypassSupabaseVirtualSheet: bypassVirtual,
                _skipFormulaRecompute: skipRecompute,
              }),
            `values.batchUpdate(${remoteId})`
          );
        } else if (phase.type === "structural" && phase.requests.length > 0) {
          await withSheetsRetry_(
            () =>
              sheets.spreadsheets.batchUpdate({
                spreadsheetId: remoteId,
                requestBody: { requests: phase.requests },
                _bypassSupabaseVirtualSheet: bypassVirtual,
                _skipFormulaRecompute: skipRecompute,
                _flushPendingRecompute: !skipRecompute,
              }),
            `spreadsheets.batchUpdate(${remoteId})`
          );
        }
      }
    }

    if (clientSheetWasMutated) {
      if (ctx.clientMode === "supabase") {
        try {
          const { flushPendingClientRecomputes } = await import("../masterEngineService.js");
          if (typeof flushPendingClientRecomputes === "function") {
            await flushPendingClientRecomputes(null, ctx.clientName);
          }
        } catch (flushErr) {
          console.warn(`[gasEnvironment] flushPendingClientRecomputes warning for ${ctx.clientName}:`, flushErr.message);
        }
        const clientRemoteSS = ctx.clientSheetId ? envState.remoteSpreadsheets.get(ctx.clientSheetId) : null;
        if (clientRemoteSS) {
          const refreshTabs = ["Confirmed", "Pipeline", "Outgoings", "ConfCalcs", "PipeCalcs"].filter((t) =>
            clientRemoteSS.sheetsByName.has(t)
          );
          if (refreshTabs.length > 0) {
            try {
              const ranges = refreshTabs.map((t) => `'${t}'`);
              const [valRes, formRes] = await Promise.all([
                withSheetsRetry_(
                  () =>
                    sheets.spreadsheets.values.batchGet({
                      spreadsheetId: ctx.clientSheetId,
                      ranges,
                      valueRenderOption: "UNFORMATTED_VALUE",
                      _bypassSupabaseVirtualSheet: false,
                    }),
                  `refreshRemoteClientValues(${ctx.clientName})`
                ),
                withSheetsRetry_(
                  () =>
                    sheets.spreadsheets.values.batchGet({
                      spreadsheetId: ctx.clientSheetId,
                      ranges,
                      valueRenderOption: "FORMULA",
                      _bypassSupabaseVirtualSheet: false,
                    }),
                  `refreshRemoteClientFormulas(${ctx.clientName})`
                ),
              ]);
              const vList = valRes?.data?.valueRanges || [];
              const fList = formRes?.data?.valueRanges || [];
              refreshTabs.forEach((tName, idx) => {
                const vs = clientRemoteSS.sheetsByName.get(tName);
                if (!vs) return;
                if (Array.isArray(vList[idx]?.values)) vs.valuesGrid = cloneGrid2D(vList[idx].values);
                if (Array.isArray(fList[idx]?.values)) vs.formulasGrid = cloneGrid2D(fList[idx].values);
                vs.dirty = false;
              });
            } catch (refErr) {
              console.warn(`[gasEnvironment] Remote client tab refresh warning (${ctx.clientName}):`, refErr.message);
            }
          }
        }
      }
      await syncClientLinkedMasterTabsFromLiveSheet();
    }

    if (envState.masterFormulasDirty || envState.gridsMutatedAfterRecompute) {
      envState.recomputeMasterFormulasSync(true);
    }

    if (persistSupabase) {
      const upserts = [];
      const nowIso = new Date().toISOString();
      const collectUpsert = (sObj, sheetRole) => {
        if (!sObj.dirty) return;
        sObj.valuesGrid = compactGrid2D(sObj.valuesGrid);
        const notesObj = sObj.notesGrid || {};
        const nextValsJson = JSON.stringify(sObj.valuesGrid);
        const nextNotesJson = JSON.stringify(notesObj);
        if (sObj._loadedValuesJson === nextValsJson && sObj._loadedNotesJson === nextNotesJson) {
          sObj.dirty = false;
          return;
        }
        sObj._loadedValuesJson = nextValsJson;
        sObj._loadedNotesJson = nextNotesJson;
        const maxC = getGridLastCol(sObj.valuesGrid);
        upserts.push({
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          sheet_role: sheetRole,
          tab_name: sObj.name,
          values_grid: sObj.valuesGrid,
          notes_grid: notesObj,
          row_count: sObj.valuesGrid.length,
          col_count: maxC,
          updated_at: nowIso,
        });
        sObj.dirty = false;
      };

      for (const sObj of masterSS.sheetsByName.values()) {
        collectUpsert(sObj, "master");
      }
      for (const sObj of reconSS.sheetsByName.values()) {
        collectUpsert(sObj, "recon");
      }

      for (let i = 0; i < upserts.length; i += 6) {
        const batch = upserts.slice(i, i + 6);
        const { error: batchErr } = await supabase
          .from("master_sheet_grids")
          .upsert(batch, { onConflict: "client_name,sheet_role,tab_name" });
        if (batchErr) {
          await Promise.all(
            batch.map(async (item) => {
              const { error: uErr } = await supabase
                .from("master_sheet_grids")
                .upsert([item], { onConflict: "client_name,sheet_role,tab_name" });
              if (uErr) {
                console.warn(
                  `[gasEnvironment] Supabase upsert warning for ${ctx.clientName} (${item.tab_name}):`,
                  uErr.message
                );
              }
            })
          );
        }
      }

      if (upserts.length > 0) {
        const masterMutatedTabs = upserts.filter((u) => u.sheet_role === "master").map((u) => u.tab_name);
        const reconMutatedTabs = upserts.filter((u) => u.sheet_role === "recon").map((u) => u.tab_name);
        if (masterMutatedTabs.length > 0) {
          invalidateMasterEngineCache(ctx.clientName, "master", masterMutatedTabs);
        }
        if (reconMutatedTabs.length > 0) {
          invalidateMasterEngineCache(ctx.clientName, "recon", reconMutatedTabs);
        }
      }

      // Mirror KeyInfo!E21 and KeyInfo!I29 to Client Sheet if they changed
      const curKi = masterSS.getSheetByName("KeyInfo");
      if (curKi && sheets && ctx.clientSheetId) {
        const curE21 = String(curKi.valuesGrid?.[20]?.[4] ?? "");
        const curI29 = String(curKi.valuesGrid?.[28]?.[8] ?? "");
        if (curE21 !== initialE21 || curI29 !== initialI29) {
          try {
            await sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: ctx.clientSheetId,
              requestBody: {
                valueInputOption: "RAW",
                data: [
                  { range: "KeyInfo!E21", values: [[curE21]] },
                  { range: "KeyInfo!I29", values: [[curI29]] },
                ],
              },
              _bypassSupabaseVirtualSheet: ctx.clientMode !== "supabase",
            });
          } catch (_) { }
        }
      }
    }
  }

  const dummyMenu = {
    addItem: () => dummyMenu,
    addSeparator: () => dummyMenu,
    addSubMenu: () => dummyMenu,
    addToUi: () => { },
  };

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => masterSS,
    getActive: () => masterSS,
    openById: async (id) => openRemoteGoogleSpreadsheet(id),
    openByUrl: async (url) => openRemoteGoogleSpreadsheet(url),
    flush: async () => {
      await flushAll({ persistSupabase: true });
    },
    getUi: () => ({
      ButtonSet: { OK: "OK", OK_CANCEL: "OK_CANCEL", YES_NO: "YES_NO", YES_NO_CANCEL: "YES_NO_CANCEL" },
      Button: { OK: "OK", CANCEL: "CANCEL", YES: "YES", NO: "NO", CLOSE: "CLOSE" },
      alert: (title, msg) => {
        const text = msg !== undefined && msg !== null ? `${title}: ${msg}` : String(title ?? "");
        if (text.trim()) {
          uiAlerts.push(text.trim());
          gasConsole.log(`[UI Alert] ${text.trim()}`);
        }
        return "OK";
      },
      prompt: () => ({ getSelectedButton: () => "OK", getResponseText: () => "" }),
      createMenu: () => dummyMenu,
      showModalDialog: () => { },
      showSidebar: () => { },
    }),
    WrapStrategy: { WRAP: "WRAP", OVERFLOW: "OVERFLOW", CLIP: "CLIP" },
    CopyPasteType: { PASTE_NORMAL: "PASTE_NORMAL", PASTE_VALUES: "PASTE_VALUES" },
    Dimension: { ROWS: "ROWS", COLUMNS: "COLUMNS" },
    Direction: { UP: "UP", DOWN: "DOWN", PREVIOUS: "PREVIOUS", NEXT: "NEXT" },
    newConditionalFormatRule: () => {
      const builder = {
        whenNumberNotBetween: () => builder,
        setBackground: () => builder,
        setFontColor: () => builder,
        setRanges: () => builder,
        build: () => ({}),
      };
      return builder;
    },
    newDataValidation: () => {
      const builder = {
        requireValueInRange: () => builder,
        setAllowInvalid: () => builder,
        build: () => ({}),
      };
      return builder;
    },
  };

  const Sheets = {
    Spreadsheets: {
      Values: {
        batchUpdate: async (resource, spreadsheetId) => {
          const cleanId = extractSheetIdFromUrl(spreadsheetId) || String(spreadsheetId || "").trim();
          const dataItems = resource?.data || [];
          const valueInputOption = resource?.valueInputOption || "USER_ENTERED";

          if (!cleanId || cleanId === ctx.masterSheetId || cleanId === masterSS.getId()) {
            for (const item of dataItems) {
              if (!item?.range || !Array.isArray(item.values)) continue;
              const rng = masterSS.getRange(item.range);
              const sRow1 = rng.getRow();
              const sCol1 = rng.getColumn();
              const numR = item.values.length;
              const numC = Math.max(1, ...item.values.map((r) => (Array.isArray(r) ? r.length : 1)));
              rng.getSheet().getRange(sRow1, sCol1, numR, numC).setValues(item.values);
            }
            return { totalUpdatedRanges: dataItems.length };
          }

          const remoteSS = await openRemoteGoogleSpreadsheet(cleanId);
          for (const item of dataItems) {
            if (!item?.range || !Array.isArray(item.values)) continue;
            const rng = remoteSS.getRange(item.range);
            const sRow1 = rng.getRow();
            const sCol1 = rng.getColumn();
            const numR = item.values.length;
            const numC = Math.max(1, ...item.values.map((r) => (Array.isArray(r) ? r.length : 1)));
            rng.getSheet().getRange(sRow1, sCol1, numR, numC).setValues(item.values);
          }
          await flushAll({ persistSupabase: false });
          return { totalUpdatedRanges: dataItems.length };
        },
      },
    },
  };

  const isCanonicalPulseHost_ = (hostname) => {
    const h = String(hostname || "").toLowerCase();
    return (
      h === "app.pulsedashboard.co.uk" ||
      h === "pulsedashboard.co.uk" ||
      h === "pma.pulsedashboard.co.uk" ||
      (process.env.NODE_ENV !== "production" && (h === "localhost" || h === "127.0.0.1"))
    );
  };

  const MAX_SSRF_REDIRECT_HOPS = 5;
  const MAX_FETCH_TIMEOUT_MS = 45000;
  const MAX_FETCH_RESPONSE_BYTES = 25 * 1024 * 1024;

  const isBlockedIpv4_ = (ip) => {
    const m = String(ip || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return true;
    const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  };

  const expandIpv6Groups_ = (rawIp) => {
    let ip = String(rawIp || "").toLowerCase().split("%")[0];
    const lastColon = ip.lastIndexOf(":");
    const tail = lastColon >= 0 ? ip.slice(lastColon + 1) : "";
    if (tail.includes(".")) {
      const m = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (!m) return null;
      const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      if (o.some((n) => n < 0 || n > 255)) return null;
      const hi = ((o[0] << 8) | o[1]).toString(16).padStart(4, "0");
      const lo = ((o[2] << 8) | o[3]).toString(16).padStart(4, "0");
      ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
    }
    const halves = ip.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
    const total = left.length + right.length;
    if (halves.length === 1 && total !== 8) return null;
    if (halves.length === 2 && total >= 8) return null;
    const zeros = halves.length === 2 ? new Array(8 - total).fill(0) : [];
    const hexGroups = [...left, ...zeros, ...right];
    if (hexGroups.length !== 8) return null;
    const nums = [];
    for (const g of hexGroups) {
      if (typeof g === "number") {
        nums.push(g);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
        nums.push(parseInt(g, 16));
      }
    }
    return nums;
  };

  const isBlockedIpAddress_ = (rawIp) => {
    const cleaned = String(rawIp || "").trim().replace(/^\[|\]$/g, "").split("%")[0].replace(/\.+$/, "");
    const ver = net.isIP(cleaned);
    if (ver === 4) return isBlockedIpv4_(cleaned);
    if (ver === 6) {
      const g = expandIpv6Groups_(cleaned);
      if (!g) return true;
      const allZeroFirst5 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
      if (allZeroFirst5 && g[5] === 0) {
        if (g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
        const compatV4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
        return isBlockedIpv4_(compatV4);
      }
      if (allZeroFirst5 && g[5] === 0xffff) {
        const mappedV4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
        return isBlockedIpv4_(mappedV4);
      }
      // IPv4-translated (::ffff:0:0/96)
      if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
        const translatedV4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
        return isBlockedIpv4_(translatedV4);
      }
      if (g[0] === 0x0064 && (g[1] & 0xfffe) === 0xff9a) {
        const nat64V4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
        return isBlockedIpv4_(nat64V4);
      }
      if (g[0] === 0x2002) {
        const sixTo4V4 = `${(g[1] >> 8) & 0xff}.${g[1] & 0xff}.${(g[2] >> 8) & 0xff}.${g[2] & 0xff}`;
        if (isBlockedIpv4_(sixTo4V4)) return true;
      }
      // Teredo (2001::/32), Documentation (2001:db8::/32), BMWG (2001:2::/48)
      if (g[0] === 0x2001 && (g[1] === 0x0000 || g[1] === 0x0db8 || (g[1] === 0x0002 && g[2] === 0x0000))) {
        return true;
      }
      if ((g[0] & 0xfe00) === 0xfc00) return true;
      if ((g[0] & 0xffc0) === 0xfe80) return true;
      if ((g[0] & 0xffc0) === 0xfec0) return true;
      if ((g[0] & 0xff00) === 0xff00) return true;
      if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
      return false;
    }
    return true;
  };

  const isBlockedSsrfHost_ = (rawHostname) => {
    const h = String(rawHostname || "")
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/, "");
    if (!h) return true;
    if (
      h === "localhost" ||
      h.endsWith(".localhost") ||
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      h === "metadata.google.internal" ||
      h === "metadata" ||
      h === "instance-data"
    ) {
      return true;
    }
    if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) return true;
    if (net.isIP(h.split("%")[0]) !== 0) {
      return isBlockedIpAddress_(h);
    }
    if (/^[\da-f.x]+$/i.test(h) && h.split(".").every((part) => /^(0x[0-9a-f]+|\d+)$/i.test(part))) {
      return true;
    }
    return false;
  };

  const assertSafeExternalTarget_ = async (targetUrlObj, allowLoopbackNonProd = false) => {
    const cleanHost = String(targetUrlObj.hostname || "")
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/, "");
    const isLoopbackNonProd =
      allowLoopbackNonProd &&
      process.env.NODE_ENV !== "production" &&
      targetUrlObj.protocol === "http:" &&
      (cleanHost === "localhost" || cleanHost === "127.0.0.1");
    if (isLoopbackNonProd) {
      return {
        cleanHost,
        pinnedAddress: cleanHost === "localhost" ? "127.0.0.1" : cleanHost,
        pinnedFamily: 4,
        isLoopbackNonProd: true,
      };
    }
    if (targetUrlObj.protocol !== "https:" || isBlockedSsrfHost_(cleanHost)) {
      throw new Error(`Blocked unsafe external fetch target in UrlFetchApp.fetch: ${targetUrlObj.origin}`);
    }

    let pinnedAddress = cleanHost;
    let pinnedFamily = net.isIP(cleanHost.split("%")[0]);
    if (pinnedFamily === 0) {
      let resolved;
      try {
        resolved = await dns.promises.lookup(cleanHost, { all: true, verbatim: true });
      } catch (dnsErr) {
        throw new Error(`Blocked unresolvable host in UrlFetchApp.fetch: ${cleanHost} (${dnsErr.message})`);
      }
      if (!Array.isArray(resolved) || resolved.length === 0) {
        throw new Error(`Blocked host with no DNS records in UrlFetchApp.fetch: ${cleanHost}`);
      }
      for (const rec of resolved) {
        if (!rec?.address || isBlockedIpAddress_(rec.address)) {
          throw new Error(`Blocked private or reserved DNS target in UrlFetchApp.fetch: ${cleanHost}`);
        }
      }
      pinnedAddress = resolved[0].address;
      pinnedFamily = resolved[0].family || net.isIP(pinnedAddress) || 4;
    } else {
      pinnedAddress = cleanHost.split("%")[0];
    }

    if (cleanHost === "sheets.googleapis.com") {
      const normPath = String(targetUrlObj.pathname || "").replace(/\/+/g, "/");
      const ssMatch = normPath.match(/^\/v4\/spreadsheets\/([^/?#:]+)/);
      if (!ssMatch) {
        throw new Error("Blocked unsupported sheets.googleapis.com path in UrlFetchApp.fetch");
      }
      let decodedId = ssMatch[1];
      try { decodedId = decodeURIComponent(ssMatch[1]); } catch { }
      if (decodedId && decodedId !== ctx.clientSheetId) {
        await assertExternalCrmSpreadsheet(sheets, decodedId);
      }
    }

    return { cleanHost, pinnedAddress, pinnedFamily, isLoopbackNonProd: false };
  };

  const isSensitiveHeaderKey_ = (k) => {
    const lk = String(k || "").trim().toLowerCase();
    return (
      [
        "authorization",
        "cookie",
        "x-pulse-client-secret",
        "x-cron-secret",
        "x-internal-secret",
        "x-api-key",
        "api-key",
        "api-token",
        "x-auth-token",
        "x-vercel-protection-bypass",
        "harvest-account-id",
      ].includes(lk) || /(?:token|secret|api[-_]?key|auth)/i.test(lk)
    );
  };

  const executePinnedHttpRequest_ = async (
    targetUrlObj,
    { method = "GET", headers = {}, body = undefined, pinnedAddress, pinnedFamily = 4, cleanHost, timeoutMs = MAX_FETCH_TIMEOUT_MS, maxBytes = MAX_FETCH_RESPONSE_BYTES }
  ) => {
    const isHttps = targetUrlObj.protocol === "https:";
    const transport = isHttps ? https : http;
    const reqHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (v === undefined || v === null) continue;
      reqHeaders[k] = String(v).replace(/[\r\n]+/g, " ");
    }
    const hasHost = Object.keys(reqHeaders).some((k) => k.toLowerCase() === "host");
    if (!hasHost && targetUrlObj.host) {
      reqHeaders["Host"] = targetUrlObj.host;
    }
    let bodyBuf = null;
    if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
      bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
      const hasContentLen = Object.keys(reqHeaders).some((k) => k.toLowerCase() === "content-length");
      if (!hasContentLen) {
        reqHeaders["Content-Length"] = String(bodyBuf.byteLength);
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const doneReject = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const doneResolve = (val) => {
        if (settled) return;
        settled = true;
        resolve(val);
      };

      const reqOpts = {
        protocol: targetUrlObj.protocol,
        hostname: cleanHost || targetUrlObj.hostname,
        port: targetUrlObj.port ? Number(targetUrlObj.port) : (isHttps ? 443 : 80),
        path: `${targetUrlObj.pathname}${targetUrlObj.search}`,
        method,
        headers: reqHeaders,
        lookup: (_hostname, opts, cb) => {
          const cbFn = typeof opts === "function" ? opts : cb;
          const wantAll = typeof opts === "object" && opts !== null && Boolean(opts.all);
          if (wantAll) {
            return cbFn(null, [{ address: pinnedAddress, family: pinnedFamily }]);
          }
          return cbFn(null, pinnedAddress, pinnedFamily);
        },
      };
      if (isHttps && net.isIP(String(cleanHost || "")) === 0) {
        reqOpts.servername = cleanHost;
      }

      const clientReq = transport.request(reqOpts, (res) => {
        const resHeaders = {};
        for (const [hk, hv] of Object.entries(res.headers || {})) {
          resHeaders[hk.toLowerCase()] = Array.isArray(hv) ? hv.join(", ") : String(hv ?? "");
        }
        const clNum = resHeaders["content-length"] ? Number(resHeaders["content-length"]) : NaN;
        if (Number.isFinite(clNum) && clNum > maxBytes) {
          res.destroy();
          clientReq.destroy();
          return doneReject(new Error(`Response content-length (${clNum}) exceeded ${maxBytes} byte limit in UrlFetchApp.fetch`));
        }

        const chunks = [];
        let totalBytes = 0;
        res.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            res.destroy();
            clientReq.destroy();
            return doneReject(new Error(`Response exceeded ${maxBytes} byte limit in UrlFetchApp.fetch`));
          }
          chunks.push(chunk);
        });
        res.on("error", (resErr) => doneReject(resErr));
        res.on("end", () => {
          try {
            let buf = Buffer.concat(chunks);
            const enc = String(resHeaders["content-encoding"] || "").toLowerCase().trim();
            if (enc.includes("br")) {
              buf = zlib.brotliDecompressSync(buf, { maxOutputLength: maxBytes });
            } else if (enc.includes("gzip") || enc.includes("x-gzip")) {
              buf = zlib.gunzipSync(buf, { maxOutputLength: maxBytes });
            } else if (enc.includes("deflate")) {
              buf = zlib.inflateSync(buf, { maxOutputLength: maxBytes });
            }
            const status = res.statusCode || 0;
            doneResolve({
              status,
              ok: status >= 200 && status < 300,
              headers: resHeaders,
              bodyBuffer: buf,
            });
          } catch (decodeErr) {
            doneReject(new Error(`Failed to decode response in UrlFetchApp.fetch: ${decodeErr.message}`));
          }
        });
      });

      clientReq.setTimeout(timeoutMs, () => {
        clientReq.destroy(new Error(`Request timed out after ${timeoutMs}ms in UrlFetchApp.fetch`));
      });
      clientReq.on("error", (reqErr) => doneReject(reqErr));

      if (bodyBuf) {
        clientReq.write(bodyBuf);
      }
      clientReq.end();
    });
  };

  const UrlFetchApp = {
    fetch: async (url, params = {}) => {
      const urlStr = String(url || "");
      let uObj;
      try {
        uObj = new URL(urlStr, "https://app.pulsedashboard.co.uk");
      } catch {
        throw new Error(`Invalid URL in UrlFetchApp.fetch: ${urlStr}`);
      }

      // 1. Intercept internal Token Broker calls (`/api/integrations/token`)
      if (isCanonicalPulseHost_(uObj.hostname) && uObj.pathname === "/api/integrations/token") {
        let bodyObj = {};
        if (params.payload) {
          try {
            bodyObj = typeof params.payload === "string" ? JSON.parse(params.payload) : params.payload;
          } catch { }
        }
        const tool = uObj.searchParams.get("tool") || bodyObj.tool || "xero";
        const result = await resolveBrokerTokenInProcess(ctx, tool);
        const text = JSON.stringify(result.body);
        return {
          getResponseCode: () => result.status,
          getContentText: () => text,
          getHeaders: () => ({ "content-type": "application/json" }),
          getAllHeaders: () => ({ "content-type": "application/json" }),
        };
      }

      // 2. Intercept internal `/api/triage` calls (`agent_progress` and `auto_reconcile_bank_feeds`)
      if (isCanonicalPulseHost_(uObj.hostname) && uObj.pathname === "/api/triage") {
        let bodyObj = {};
        if (params.payload) {
          try {
            bodyObj = typeof params.payload === "string" ? JSON.parse(params.payload) : params.payload;
          } catch { }
        }
        if (bodyObj.action === "agent_progress") {
          if (typeof onProgress === "function") {
            await onProgress(bodyObj).catch(() => { });
          }
          const text = JSON.stringify({ success: true });
          return {
            getResponseCode: () => 200,
            getContentText: () => text,
            getHeaders: () => ({}),
            getAllHeaders: () => ({}),
          };
        }
        if (bodyObj.action === "auto_reconcile_bank_feeds" && typeof autoReconcileFn === "function") {
          await flushAll({ persistSupabase: true });
          const resObj = await autoReconcileFn({
            clientName: ctx.clientName,
            masterSheetId: ctx.masterSheetId,
            reconSheetId: ctx.reconSheetId,
          }).catch((e) => ({ success: false, error: e.message }));
          // Reload Recon PLAdds and all reconciled monthly tabs into reconSS so downstream reads see cleared items immediately
          const tabsToReload = new Set([
            "PLAdds",
            ...(Array.isArray(resObj?.reconciledMonths) ? resObj.reconciledMonths.map(m => m?.tabName).filter(Boolean) : []),
          ]);
          const { data: reloadedRows } = await supabase
            .from("master_sheet_grids")
            .select("*")
            .eq("client_name", ctx.clientName)
            .eq("sheet_role", "recon")
            .in("tab_name", Array.from(tabsToReload));
          for (const rRow of reloadedRows || []) {
            if (Array.isArray(rRow.values_grid)) {
              const compacted = compactGrid2D(rRow.values_grid);
              const s = reconSS.getSheetByName(rRow.tab_name) || reconSS.insertSheet(rRow.tab_name);
              s.valuesGrid = cloneGrid2D(compacted);
              s.formulasGrid = cloneGrid2D(compacted);
              s._loadedValuesJson = JSON.stringify(compacted);
              if (rRow.tab_name === "PLAdds") {
                envState.masterFormulasDirty = true;
              }
            }
          }
          const text = JSON.stringify(resObj || { success: true });
          return {
            getResponseCode: () => 200,
            getContentText: () => text,
            getHeaders: () => ({}),
            getAllHeaders: () => ({}),
          };
        }
      }

      // 3. External HTTP fetch (SSRF + DNS-pinned socket + manual redirect + timeout + bounded response)
      let currentUrlObj = uObj;
      let targetPin = await assertSafeExternalTarget_(currentUrlObj, true);

      let currentMethod = String(params.method || "GET").toUpperCase();
      let currentHeaders = { ...(params.headers || {}) };
      if (params.contentType && !currentHeaders["Content-Type"] && !currentHeaders["content-type"]) {
        currentHeaders["Content-Type"] = params.contentType;
      }

      let currentBody = undefined;
      if (currentMethod !== "GET" && currentMethod !== "HEAD" && params.payload !== undefined) {
        if (typeof params.payload === "string" || Buffer.isBuffer(params.payload)) {
          currentBody = params.payload;
        } else if (typeof params.payload === "object") {
          const ct = String(currentHeaders["Content-Type"] || currentHeaders["content-type"] || "");
          if (ct.includes("application/json")) {
            currentBody = JSON.stringify(params.payload);
          } else {
            currentBody = new URLSearchParams(params.payload).toString();
            if (!ct) currentHeaders["Content-Type"] = "application/x-www-form-urlencoded";
          }
        }
      }

      const hasAuthOrSecretHeader = Object.keys(currentHeaders).some((k) => isSensitiveHeaderKey_(k));
      const allowRedirects = params.followRedirects !== false && !hasAuthOrSecretHeader;

      let resp = null;
      for (let hop = 0; hop <= MAX_SSRF_REDIRECT_HOPS; hop++) {
        const authHdrKey = Object.keys(currentHeaders).find((k) => k.toLowerCase() === "authorization");
        if (authHdrKey) {
          const bearerVal = String(currentHeaders[authHdrKey] || "").replace(/^Bearer\s+/i, "").trim();
          if (bearerVal && issuedServiceOAuthTokens.has(bearerVal)) {
            const normPath = String(currentUrlObj.pathname || "").replace(/\/+/g, "/");
            if (targetPin.cleanHost !== "sheets.googleapis.com" || !/^\/v4\/spreadsheets\/[^/?#:]+/.test(normPath)) {
              throw new Error(`Blocked internal service OAuth token egress to unauthorized target: ${targetPin.cleanHost}`);
            }
          }
        }
        resp = await executePinnedHttpRequest_(currentUrlObj, {
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          pinnedAddress: targetPin.pinnedAddress,
          pinnedFamily: targetPin.pinnedFamily,
          cleanHost: targetPin.cleanHost,
          timeoutMs: MAX_FETCH_TIMEOUT_MS,
          maxBytes: MAX_FETCH_RESPONSE_BYTES,
        });

        const isRedirect = [301, 302, 303, 307, 308].includes(resp.status);
        if (!isRedirect || !allowRedirects) {
          break;
        }
        const location = resp.headers["location"];
        if (!location) {
          break;
        }
        if (hop === MAX_SSRF_REDIRECT_HOPS) {
          throw new Error(`Exceeded maximum redirect hops (${MAX_SSRF_REDIRECT_HOPS}) in UrlFetchApp.fetch`);
        }

        let nextUrlObj;
        try {
          nextUrlObj = new URL(location, currentUrlObj.toString());
        } catch {
          throw new Error(`Invalid redirect location in UrlFetchApp.fetch: ${location}`);
        }
        targetPin = await assertSafeExternalTarget_(nextUrlObj, false);

        if (nextUrlObj.origin !== currentUrlObj.origin) {
          const stripped = {};
          for (const [k, v] of Object.entries(currentHeaders)) {
            if (!isSensitiveHeaderKey_(k)) {
              stripped[k] = v;
            }
          }
          currentHeaders = stripped;
        }
        if (resp.status === 301 || resp.status === 302 || resp.status === 303) {
          if (currentMethod !== "GET" && currentMethod !== "HEAD") {
            currentMethod = "GET";
            currentBody = undefined;
          }
        }
        currentUrlObj = nextUrlObj;
      }

      const respBuffer = resp.bodyBuffer || Buffer.alloc(0);
      const respText = respBuffer.toString("utf8");
      const respHeaders = resp.headers || {};

      if (!resp.ok && !params.muteHttpExceptions) {
        const sanitizedErrUrl = `${currentUrlObj.origin}${currentUrlObj.pathname}`;
        throw new Error(`Request failed for ${sanitizedErrUrl} returned code ${resp.status}: ${respText.slice(0, 500)}`);
      }

      return {
        getResponseCode: () => resp.status,
        getContentText: () => respText,
        getContent: () => respBuffer,
        getHeaders: () => respHeaders,
        getAllHeaders: () => respHeaders,
      };
    },
    fetchAll: async (requests) =>
      Promise.all(
        (requests || []).map((req) =>
          typeof req === "string"
            ? UrlFetchApp.fetch(req)
            : UrlFetchApp.fetch(req.url, req)
        )
      ),
  };

  const issuedServiceOAuthTokens = new Set();

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => envState.scriptProperties.get(String(k)) ?? null,
      setProperty: (k, v) => {
        const keyStr = String(k);
        const valStr = String(v ?? "");
        if (envState.scriptProperties.get(keyStr) !== valStr) {
          envState.scriptProperties.set(keyStr, valStr);
          envState.scriptPropertiesDirty = true;
        }
      },
      setProperties: (obj, deleteAllOthers = false) => {
        if (deleteAllOthers) {
          envState.scriptProperties.clear();
        }
        if (obj && typeof obj === "object") {
          for (const [k, v] of Object.entries(obj)) {
            envState.scriptProperties.set(String(k), String(v ?? ""));
          }
          envState.scriptPropertiesDirty = true;
        }
      },
      deleteProperty: (k) => {
        if (envState.scriptProperties.delete(String(k))) {
          envState.scriptPropertiesDirty = true;
        }
      },
      deleteAllProperties: () => {
        envState.scriptProperties.clear();
        envState.scriptPropertiesDirty = true;
      },
      getProperties: () => Object.fromEntries(envState.scriptProperties.entries()),
    }),
    getUserProperties: () => PropertiesService.getScriptProperties(),
    getDocumentProperties: () => PropertiesService.getScriptProperties(),
  };

  const Utilities = {
    formatDate: (date, tz, format) => formatGasDate(date, tz, format),
    sleep: async (ms) => {
      const waitMs = Math.min(Math.max(0, Number(ms) || 0), 5000);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    },
    getUuid: () => randomUUID(),
    base64Encode: (data) => {
      if (Buffer.isBuffer(data)) return data.toString("base64");
      if (Array.isArray(data)) return Buffer.from(data).toString("base64");
      return Buffer.from(String(data ?? ""), "utf8").toString("base64");
    },
    parseCsv: (csvStr) => {
      const text = String(csvStr || "");
      const rows = [];
      let curRow = [];
      let curVal = "";
      let inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (inQuotes) {
          if (ch === '"' && next === '"') {
            curVal += '"';
            i++;
          } else if (ch === '"') {
            inQuotes = false;
          } else {
            curVal += ch;
          }
        } else {
          if (ch === '"') {
            inQuotes = true;
          } else if (ch === ",") {
            curRow.push(curVal);
            curVal = "";
          } else if (ch === "\r" && next === "\n") {
            curRow.push(curVal);
            rows.push(curRow);
            curRow = [];
            curVal = "";
            i++;
          } else if (ch === "\n" || ch === "\r") {
            curRow.push(curVal);
            rows.push(curRow);
            curRow = [];
            curVal = "";
          } else {
            curVal += ch;
          }
        }
      }
      if (curVal !== "" || curRow.length > 0) {
        curRow.push(curVal);
        rows.push(curRow);
      }
      return rows;
    },
  };

  const CacheService = {
    getScriptCache: () => ({
      get: (k) => envState.scriptCache.get(String(k)) ?? null,
      getAll: (keys) => {
        const out = {};
        if (Array.isArray(keys)) {
          for (const k of keys) {
            const ks = String(k);
            if (envState.scriptCache.has(ks)) out[ks] = envState.scriptCache.get(ks);
          }
        }
        return out;
      },
      put: (k, v) => envState.scriptCache.set(String(k), String(v ?? "")),
      putAll: (obj) => {
        if (obj && typeof obj === "object") {
          for (const [k, v] of Object.entries(obj)) {
            envState.scriptCache.set(String(k), String(v ?? ""));
          }
        }
      },
      remove: (k) => envState.scriptCache.delete(String(k)),
    }),
  };

  const LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      waitLock: () => true,
      hasLock: () => true,
      releaseLock: () => { },
    }),
  };

  const Session = {
    getScriptTimeZone: () => "Europe/London",
    getActiveUser: () => ({ getEmail: () => "system@pulsedashboard.co.uk" }),
    getEffectiveUser: () => ({ getEmail: () => "system@pulsedashboard.co.uk" }),
  };

  const Logger = {
    log: (...args) => {
      appendExecLog("INFO", args);
      globalThis.console.log(`[GAS:${ctx.clientName}]`, ...args);
    },
    clear: () => { },
    getLog: () => executionLogs.join("\n"),
  };

  const HtmlService = {
    createHtmlOutput: (html = "") => ({
      getContent: () => String(html),
      setWidth: function () { return this; },
      setHeight: function () { return this; },
      setTitle: function () { return this; },
    }),
    createHtmlOutputFromFile: () => HtmlService.createHtmlOutput(""),
    createTemplateFromFile: () => ({
      evaluate: () => HtmlService.createHtmlOutput(""),
    }),
  };

  const ScriptApp = {
    WeekDay: {
      SUNDAY: "SUNDAY",
      MONDAY: "MONDAY",
      TUESDAY: "TUESDAY",
      WEDNESDAY: "WEDNESDAY",
      THURSDAY: "THURSDAY",
      FRIDAY: "FRIDAY",
      SATURDAY: "SATURDAY",
    },
    getProjectTriggers: () => [],
    deleteTrigger: () => { },
    newTrigger: () => {
      const tb = {
        timeBased: () => tb,
        everyMinutes: () => tb,
        after: () => tb,
        onWeekDay: () => tb,
        atHour: () => tb,
        create: () => ({ getUniqueId: () => randomUUID() }),
      };
      return tb;
    },
    getOAuthToken: async () => {
      try {
        const authClient = sheets?.context?._options?.auth;
        if (authClient && typeof authClient.getAccessToken === "function") {
          const tokenRes = await authClient.getAccessToken();
          const tok = tokenRes?.token || "";
          if (tok) issuedServiceOAuthTokens.add(tok);
          return tok;
        }
      } catch { }
      return "";
    },
  };

  const ContentService = {
    MimeType: { JSON: "JSON", TEXT: "TEXT" },
    createTextOutput: (text = "") => ({
      _text: String(text),
      setMimeType: function () { return this; },
      getContent: function () { return this._text; },
    }),
  };

  const DriveApp = {
    getRootFolder: () => ({
      createFile: () => ({ getId: () => "", setTrashed: () => { } }),
    }),
  };

  const Drive = {};

  return {
    SpreadsheetApp,
    Sheets,
    UrlFetchApp,
    PropertiesService,
    Utilities,
    DriveApp,
    Drive,
    CacheService,
    LockService,
    Session,
    Logger,
    HtmlService,
    ScriptApp,
    ContentService,
    console: gasConsole,
    executionLogs,
    uiAlerts,
    masterSS,
    reconSS,
    recomputeMasterFormulasSync: envState.recomputeMasterFormulasSync,
    finalizeExecution: async (finalMeta = {}) => {
      // Clear any B4:I4 GAS locks before final persistence
      const dca = masterSS.getSheetByName("DataChgAlert");
      if (dca && dca.valuesGrid[3]) {
        for (let c = 1; c <= 8; c++) {
          if (dca.valuesGrid[3][c]) {
            dca.valuesGrid[3][c] = "";
            dca.dirty = true;
          }
        }
      }

      // Persist GAS execution console transcript to virtual `GasExecLogs` tab if applicable
      const fnName = finalMeta?.functionName || executionMeta?.functionName || "";
      const shouldRecord =
        finalMeta?.recordExecution !== false && (Boolean(fnName) || executionLogs.length > 0);
      if (shouldRecord) {
        const durationSec = ((Date.now() - execStartedAtMs) / 1000).toFixed(2) + "s";
        const triggerSrc =
          finalMeta?.triggerSource || executionMeta?.triggerSource || "Automated / API";
        const hasErrLog = executionLogs.some((l) => l.includes("[ERROR]"));
        const statusStr =
          finalMeta?.status || (hasErrLog ? "Completed with warnings" : "Completed");
        const summaryStr =
          finalMeta?.summary ||
          executionMeta?.summary ||
          `${executionLogs.length} console log line(s)`;
        const transcript =
          executionLogs.length > 0
            ? executionLogs.join("\n")
            : `[${execStartedAtIso.slice(11, 23)}] [INFO] Execution completed (${fnName || "GAS runtime"}) with no console output.`;

        let execLogSheet = masterSS.getSheetByName("GasExecLogs");
        if (!execLogSheet) {
          execLogSheet = masterSS.insertSheet("GasExecLogs");
        }
        const headerRow = [
          "Timestamp",
          "Function / Sequence",
          "Trigger Source",
          "Duration",
          "Status",
          "Summary",
          "Console Transcript",
        ];
        const existingRows = Array.isArray(execLogSheet.valuesGrid)
          ? execLogSheet.valuesGrid.slice(1).filter((r) => Array.isArray(r) && r.some(Boolean))
          : [];
        const newEntry = [
          execStartedAtIso,
          fnName || "runAgencyAutomator",
          triggerSrc,
          durationSec,
          statusStr,
          summaryStr,
          transcript,
        ];
        const nextGrid = [headerRow, newEntry, ...existingRows.slice(0, 39)];
        execLogSheet.valuesGrid = nextGrid;
        execLogSheet.formulasGrid = cloneGrid2D(nextGrid);
        execLogSheet.dirty = true;
      }

      if (envState.scriptPropertiesDirty) {
        const EPHEMERAL_KEYS = new Set([
          "PULSE_INTERNAL_SECRET",
          "PULSE_CLIENT_SECRET",
          "AGENT_TRIGGER_SECRET",
          "CRON_SECRET",
          "VERCEL_BYPASS_TOKEN",
          "CURRENT_RUN_ID",
          "CURRENT_RUN_CLIENT",
        ]);
        const propRows = [["Key", "Value"]];
        for (const [k, v] of envState.scriptProperties.entries()) {
          if (!EPHEMERAL_KEYS.has(k)) {
            propRows.push([k, v]);
          }
        }
        let pSheet = masterSS.getSheetByName("GasScriptProps");
        if (!pSheet) {
          pSheet = masterSS.insertSheet("GasScriptProps");
        }
        pSheet.valuesGrid = propRows;
        pSheet.formulasGrid = cloneGrid2D(propRows);
        pSheet.dirty = true;
      }

      if (envState.gridsMutatedAfterRecompute) {
        envState.masterFormulasDirty = true;
      }
      await flushAll({ persistSupabase: true });
    },
  };
}

