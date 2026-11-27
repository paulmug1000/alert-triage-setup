import fs from "fs";
import path from "path";
import { waitUntil } from "@vercel/functions";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import { extractSheetIdFromUrl } from "./sheetsClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import {
  formatCellForDisplay,
  formatGridForDisplay,
  normalizeCellForStorage,
} from "./gasRuntime/sheetValueUtils.js";
import {
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
} from "./gasRuntime/masterFormulaEngine.js";
import { recalculateClientGrids } from "./gasRuntime/clientFormulaEngine.js";

const STAGE2_TABLES = [
  { name: "tenant_key_info", label: "Tenant KeyInfo & settings" },
  { name: "master_sheet_grids", label: "Virtual Master, Recon & Client grids" },
  { name: "accounting_invoices", label: "Accounting invoices (InvFromApp)" },
  { name: "accounting_direct_costs", label: "Direct costs & bills (JnlsFromApp)" },
  { name: "accounting_pl_lines", label: "P&L monthly lines (PLFromApp)" },
  { name: "crm_deals_raw", label: "CRM deals (DataFromCRM)" },
  { name: "time_entries_raw", label: "Time entries (TimeComp)" },
  { name: "bank_recon_periods", label: "Bank recon periods (YYMM)" },
  { name: "bank_recon_items", label: "Bank recon transactions & items" },
  { name: "bank_recon_learning_map", label: "Bank recon category learning map" },
];

const STAGE4_TABLES = [
  { name: "client_jobs", label: "Confirmed & Pipeline jobs" },
  { name: "client_outgoings", label: "Overhead & Direct cost forecasts (Outgoings)" },
  { name: "client_salaries", label: "Staff salaries & roles (Salaries)" },
  { name: "client_budgets_and_targets", label: "Budgets & NB targets (Budget / NBtoFind)" },
  { name: "client_cash_balances", label: "Actual & forecast cash balances (Cash)" },
];

const PAUSED_STAGE2_MIRROR_TABLES = new Set();

export function shouldSyncNormalizedMirrorTables() {
  const v = String(process.env.PULSE_SYNC_NORMALIZED_MIRROR_TABLES || "").trim().toLowerCase();
  return v === "true" || v === "1";
}

export const CORE_CLIENT_TABS = [
  "Welcome",
  "Dashboard",
  "Cash",
  "Confirmed",
  "Pipeline",
  "NBtoFind",
  "Outgoings",
  "Salaries",
  "Report",
  "KeyInfo",
  "InvoicesSent",
  "Performance",
  "Budget",
  "GPbyPL",
  "DataForReport",
  "RevenueConf",
  "RevenuePipe",
  "CashIncomingConf",
  "CashIncomingPipe",
  "Calcs",
  "ErrorCheck",
  "VAT",
  "Monthly",
  "ContrPayments",
  "Sessions",
  "AppLog",
  "ConfCalcs",
  "PipeCalcs",
  "OutgNotes",
  "Year0Data",
];

const CORE_MASTER_TABS = [
  "KeyInfo",
  "DataChgAlert",
  "Budget",
  "InvComp",
  "DirComp",
  "PLComp",
  "CRMComp",
  "TimeComp",
  "InvFromApp",
  "JnlsFromApp",
  "PLFromApp",
  "DataFromCRM",
  "CRMList",
  "InvAppList",
  "InvDashList",
  "JnlAppList",
  "DirDashList",
  "PLAdds",
  "OutgNotes",
  "AutoLog",
  "MgmtRep",
  "Year0Data",
  "Year0PLFromApp",
  "RevComp",
  "RevFromApp",
  "Outgoings",
  "MthlyClient",
  "Welcome",
  "CRMGoogleBridge",
  "CRMExcelBridge",
  "CRMExcelCopy",
  "StarterInv",
  "StarterPL",
  "DataFromTime",
  "ProjectsFromTime",
  "ConfCalcs",
  "PipeCalcs",
  "Salaries",
  "Dashboard",
  "Performance",
  "Cash",
  "Tax",
  "Calcs",
  "DataForReport",
];

let _sheetContextCache = {
  bySheetId: new Map(),
  byClientName: new Map(),
  expiresAt: 0,
  inFlight: null,
};

const _gridMemoryCache = new Map();
const MAX_GRID_MEMORY_CACHE = 160;
const GRID_CACHE_TTL_MS = 30000;
const _tabWriteRevisionMap = new Map();
const _stagedCopiedTabsByClientRole = new Map();
const _renamedVirtualSheetIds = new Map();

function bumpTabWriteRevision_(clientName, sheetRole, tabName) {
  const key = `${String(clientName || "").trim().toLowerCase()}::${sheetRole}::${tabName}`;
  const next = (_tabWriteRevisionMap.get(key) || 0) + 1;
  _tabWriteRevisionMap.set(key, next);
  return next;
}

export function getTabWriteRevision_(clientName, sheetRole, tabName) {
  const key = `${String(clientName || "").trim().toLowerCase()}::${sheetRole}::${tabName}`;
  return _tabWriteRevisionMap.get(key) || 0;
}

function setGridMemoryCache_(cacheKey, record, ttlMs = GRID_CACHE_TTL_MS) {
  if (_gridMemoryCache.has(cacheKey)) {
    _gridMemoryCache.delete(cacheKey);
  } else if (_gridMemoryCache.size >= MAX_GRID_MEMORY_CACHE) {
    let evictCount = Math.max(1, _gridMemoryCache.size - MAX_GRID_MEMORY_CACHE + 16);
    for (const k of _gridMemoryCache.keys()) {
      _gridMemoryCache.delete(k);
      if (--evictCount <= 0) break;
    }
  }
  _gridMemoryCache.set(cacheKey, {
    record,
    expiresAt: Date.now() + ttlMs,
  });
}

function normalizeClientKey_(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

export function colLetterToIdx0(letters) {
  const clean = String(letters || "").trim().toUpperCase();
  if (!clean) return 0;
  let num = 0;
  for (let i = 0; i < clean.length; i++) {
    num = num * 26 + (clean.charCodeAt(i) - 64);
  }
  return Math.max(0, num - 1);
}

export function colIdx0ToLetter(idx0) {
  let n = Number(idx0) + 1;
  if (!Number.isFinite(n) || n <= 0 || n > 16384) {
    throw new Error(`Column index out of range (${idx0})`);
  }
  let str = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    str = String.fromCharCode(65 + rem) + str;
    n = Math.floor((n - 1) / 26);
  }
  return str || "A";
}

/**
 * Parses an A1 range string like "'2610'!U3:X16", "KeyInfo!B15", "CRMList!1:2", "AutoLog!A:D"
 */
export function parseA1Range(a1Str, defaultTab = "KeyInfo") {
  const raw = String(a1Str || "").trim();
  let tabName = defaultTab;
  let coordPart = raw;

  if (raw.includes("!")) {
    const bangIdx = raw.indexOf("!");
    tabName = raw
      .slice(0, bangIdx)
      .trim()
      .replace(/^'+|'+$/g, "");
    coordPart = raw.slice(bangIdx + 1).trim();
  } else if (raw) {
    const unquoted = raw.replace(/^'+|'+$/g, "");
    const isCoordPattern =
      /^\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{0,3}\$?\d*)?$/.test(unquoted) ||
      /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}$/.test(unquoted) ||
      /^\$?\d+:\$?\d+$/.test(unquoted);
    if (isCoordPattern) {
      tabName = defaultTab;
      coordPart = unquoted;
    } else {
      return { tabName: unquoted, startRow0: 0, endRow0: null, startCol0: 0, endCol0: null };
    }
  }

  if (!coordPart) {
    return { tabName, startRow0: 0, endRow0: null, startCol0: 0, endCol0: null };
  }

  const parts = coordPart.split(":");
  const parseRef = (ref, isEnd) => {
    const clean = String(ref || "").replace(/\$/g, "").trim().toUpperCase();
    const m = clean.match(/^([A-Z]+)?(\d+)?$/);
    if (!m) {
      return { col0: isEnd ? null : 0, row0: isEnd ? null : 0 };
    }
    const colLetters = m[1] || "";
    const rowDigits = m[2] || "";
    return {
      col0: colLetters ? colLetterToIdx0(colLetters) : isEnd ? null : 0,
      row0: rowDigits ? Math.max(0, parseInt(rowDigits, 10) - 1) : isEnd ? null : 0,
    };
  };

  const p1 = parseRef(parts[0], false);
  if (parts.length === 1) {
    const singleClean = String(parts[0] || "").replace(/\$/g, "").trim();
    const isRowOnly = /^\d+$/.test(singleClean);
    const isColOnly = /^[A-Za-z]+$/.test(singleClean);
    return {
      tabName,
      startRow0: p1.row0 ?? 0,
      endRow0: isColOnly ? null : p1.row0 ?? 0,
      startCol0: p1.col0 ?? 0,
      endCol0: isRowOnly ? null : p1.col0 ?? 0,
    };
  }

  const p2 = parseRef(parts[1], true);
  return {
    tabName,
    startRow0: p1.row0 ?? 0,
    endRow0: p2.row0,
    startCol0: p1.col0 ?? 0,
    endCol0: p2.col0,
  };
}

function sliceGrid2D_(grid, parsed) {
  if (!Array.isArray(grid) || grid.length === 0) return [];
  const sRow = parsed.startRow0 ?? 0;
  const eRow = parsed.endRow0 != null ? Math.min(grid.length - 1, parsed.endRow0) : grid.length - 1;
  if (sRow > eRow || sRow >= grid.length) return [];

  const sCol = parsed.startCol0 ?? 0;
  const out = [];
  for (let r = sRow; r <= eRow; r++) {
    const rowArr = Array.isArray(grid[r]) ? grid[r] : [];
    const eCol = parsed.endCol0 != null ? parsed.endCol0 : Math.max(0, rowArr.length - 1);
    if (sCol > eCol || rowArr.length === 0) {
      out.push([]);
      continue;
    }
    const sliced = rowArr.slice(sCol, eCol + 1).map((v) => (v === null || v === undefined ? "" : v));
    while (sliced.length > 0 && sliced[sliced.length - 1] === "") {
      sliced.pop();
    }
    out.push(sliced);
  }
  while (out.length > 0 && out[out.length - 1].length === 0) {
    out.pop();
  }
  return out;
}

function applyWriteToGrid2D_(
  grid,
  parsed,
  incomingValues,
  { sheetRole = "master", tabName = "", valueInputOption = "USER_ENTERED", notesGrid = null, isFormulaGrid = false } = {}
) {
  const nextGrid = Array.isArray(grid) ? grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];
  const rows = Array.isArray(incomingValues) ? incomingValues : [];
  const sRow = parsed.startRow0 ?? 0;
  const sCol = parsed.startCol0 ?? 0;

  for (let rOffset = 0; rOffset < rows.length; rOffset++) {
    const targetR = sRow + rOffset;
    if (targetR < 0 || targetR >= 50000) {
      throw new Error(`Virtual sheet write row out of bounds (${targetR + 1} in ${tabName || "sheet"})`);
    }
    if (parsed.endRow0 != null && targetR > parsed.endRow0) break;
    while (nextGrid.length <= targetR) nextGrid.push([]);
    const rowVals = Array.isArray(rows[rOffset]) ? rows[rOffset] : [rows[rOffset]];
    for (let cOffset = 0; cOffset < rowVals.length; cOffset++) {
      const targetC = sCol + cOffset;
      if (targetC < 0 || targetC >= 600) {
        throw new Error(`Virtual sheet write column out of bounds (${targetC + 1} in ${tabName || "sheet"})`);
      }
      if (parsed.endCol0 != null && targetC > parsed.endCol0) break;
      while (nextGrid[targetR].length <= targetC) nextGrid[targetR].push("");
      const val = rowVals[cOffset];
      if (isFormulaGrid) {
        nextGrid[targetR][targetC] = val === null || val === undefined ? "" : val;
      } else {
        nextGrid[targetR][targetC] = normalizeCellForStorage(
          sheetRole,
          tabName || parsed.tabName,
          targetR,
          targetC,
          val,
          valueInputOption,
          nextGrid,
          notesGrid
        );
      }
    }
  }
  return nextGrid;
}

function clearRangeInGrid2D_(grid, parsed) {
  const nextGrid = Array.isArray(grid) ? grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];
  if (nextGrid.length === 0) return nextGrid;
  const sRow = parsed.startRow0 ?? 0;
  const eRow = parsed.endRow0 != null ? Math.min(nextGrid.length - 1, parsed.endRow0) : nextGrid.length - 1;
  const sCol = parsed.startCol0 ?? 0;

  for (let r = sRow; r <= eRow; r++) {
    if (!Array.isArray(nextGrid[r])) continue;
    const eCol = parsed.endCol0 != null ? Math.min(nextGrid[r].length - 1, parsed.endCol0) : nextGrid[r].length - 1;
    for (let c = sCol; c <= eCol; c++) {
      nextGrid[r][c] = "";
    }
  }
  return nextGrid;
}

export function invalidateSheetContextCache() {
  _sheetContextCache.expiresAt = 0;
}

export function invalidateMasterEngineCache(clientName = null, sheetRole = null, tabNames = null, options = {}) {
  if (options?.invalidateSheetContext || (!clientName && options?.invalidateSheetContext !== false)) {
    _sheetContextCache.expiresAt = 0;
  }
  if (!sheetRole || sheetRole === "client") {
    import("./relationalFinancialsService.js")
      .then(({ invalidateClientRelationalFinancialsCache }) => invalidateClientRelationalFinancialsCache(clientName))
      .catch(() => { });
    import("./nativeClientCalcService.js")
      .then(({ invalidateClientNativeCalcCache }) => invalidateClientNativeCalcCache(clientName, tabNames))
      .catch(() => { });
  }
  if (!sheetRole || sheetRole === "master" || sheetRole === "client") {
    import("./nativeMasterComparisonService.js")
      .then(({ invalidateClientNativeMasterCompCache }) => invalidateClientNativeMasterCompCache(clientName))
      .catch(() => { });
  }
  if (!clientName) {
    _gridMemoryCache.clear();
    return;
  }
  const cleanClient = String(clientName).trim().toLowerCase();
  const rolePrefix = sheetRole ? `${cleanClient}::${sheetRole}::` : `${cleanClient}::`;
  if (tabNames && (Array.isArray(tabNames) || tabNames instanceof Set)) {
    const tabSet = tabNames instanceof Set ? tabNames : new Set(tabNames);
    if (sheetRole) {
      for (const t of tabSet) {
        _gridMemoryCache.delete(`${cleanClient}::${sheetRole}::${t}`);
      }
      return;
    }
    for (const key of _gridMemoryCache.keys()) {
      if (key.startsWith(rolePrefix)) {
        const lastSep = key.lastIndexOf("::");
        const tName = lastSep >= 0 ? key.slice(lastSep + 2) : "";
        if (tabSet.has(tName)) _gridMemoryCache.delete(key);
      }
    }
    return;
  }
  for (const key of _gridMemoryCache.keys()) {
    if (key.startsWith(rolePrefix)) _gridMemoryCache.delete(key);
  }
}

/**
 * Returns true if a sheet ID is a synthetic Supabase-only virtual identifier (no Google Sheet exists).
 */
export function isVirtualSupabaseSheetId(id) {
  const s = String(id || "").trim();
  return !s || s.startsWith("sb-");
}

function patchGridCell_(grid, r0, c0, val) {
  const out = Array.isArray(grid) ? grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];
  while (out.length <= r0) out.push([]);
  while (out[r0].length <= c0) out[r0].push("");
  out[r0][c0] = val;
  return out;
}

/**
 * Resolves whether a given spreadsheetId or clientName belongs to a client in Supabase
 * and returns its master_mode ('sheet' | 'supabase'), sheetRole ('master' | 'recon' | 'client'), etc.
 */
export async function resolveSupabaseSheetContext({ spreadsheetId = "", clientName = "" } = {}) {
  if (!isSupabaseConfigured()) return null;
  const now = Date.now();

  if (now >= _sheetContextCache.expiresAt || _sheetContextCache.byClientName.size === 0) {
    const supabase = getSupabaseAdmin();
    if (!supabase) return null;
    if (!_sheetContextCache.inFlight) {
      _sheetContextCache.inFlight = (async () => {
        try {
          let { data, error } = await supabase
            .from("clients")
            .select("id, client_name, normalized_key, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, recon_mode, recon_read_mode, financials_mode, financials_read_mode, client_compute_mode, master_compute_mode, connector_pull_mode, sync_orchestrator_mode, grid_storage_retired, client_sheet_id, master_sheet_id, recon_sheet_id, metadata");
          if (error && String(error.message || "").includes("grid_storage_retired")) {
            ({ data, error } = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, recon_mode, recon_read_mode, financials_mode, financials_read_mode, client_compute_mode, master_compute_mode, connector_pull_mode, sync_orchestrator_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata"));
          }
          if (error && String(error.message || "").includes("sync_orchestrator_mode")) {
            ({ data, error } = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, recon_mode, recon_read_mode, financials_mode, financials_read_mode, client_compute_mode, master_compute_mode, connector_pull_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata"));
          }
          if (error && (String(error.message || "").includes("client_compute_mode") || String(error.message || "").includes("master_compute_mode") || String(error.message || "").includes("connector_pull_mode"))) {
            ({ data, error } = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, recon_mode, recon_read_mode, financials_mode, financials_read_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata"));
          }
          if (error && (String(error.message || "").includes("financials_mode") || String(error.message || "").includes("financials_read_mode"))) {
            ({ data, error } = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, recon_mode, recon_read_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata"));
          }
          if (error && (String(error.message || "").includes("recon_mode") || String(error.message || "").includes("recon_read_mode"))) {
            ({ data, error } = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata"));
          }
          if (error && (String(error.message || "").includes("master_ingestion_mode") || String(error.message || "").includes("master_read_mode"))) {
            ({ data, error } = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata"));
          }
          if (error && (String(error.message || "").includes("inputs_mode") || String(error.message || "").includes("jobs_read_mode"))) {
            ({ data, error } = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, master_mode, client_mode, jobs_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata"));
          }
          if (error && String(error.message || "").includes("jobs_mode")) {
            ({ data, error } = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, master_mode, client_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata"));
          }
          if (!error && Array.isArray(data)) {
            const bySheetId = new Map();
            const byClientName = new Map();
            for (const row of data) {
              const normKey = String(row.normalized_key || normalizeClientKey_(row.client_name || "")).trim();
              const cId =
                extractSheetIdFromUrl(row.client_sheet_id) ||
                String(row.client_sheet_id || "").trim() ||
                (row.client_mode === "supabase" && normKey ? `sb-client-${normKey}` : "");
              const mId =
                extractSheetIdFromUrl(row.master_sheet_id) ||
                String(row.master_sheet_id || "").trim() ||
                (row.master_mode === "supabase" && normKey ? `sb-master-${normKey}` : "");
              const rId =
                extractSheetIdFromUrl(row.recon_sheet_id) ||
                String(row.recon_sheet_id || "").trim() ||
                ((row.metadata?.reconMode === "supabase" || row.master_mode === "supabase") && normKey
                  ? `sb-recon-${normKey}`
                  : "");
              const entry = {
                clientId: row.id,
                clientName: row.client_name,
                normalizedKey: normKey,
                masterMode: row.master_mode || "sheet",
                clientMode: row.client_mode || "sheet",
                jobsMode: String(row.jobs_mode || row.metadata?.jobs_mode || "grid").trim().toLowerCase() === "relational"
                  ? "relational"
                  : "grid",
                jobsReadMode: String(row.jobs_read_mode || row.metadata?.jobs_read_mode || "grid").trim().toLowerCase() === "relational"
                  ? "relational"
                  : "grid",
                inputsMode: String(row.inputs_mode || row.metadata?.inputs_mode || "grid").trim().toLowerCase() === "relational"
                  ? "relational"
                  : "grid",
                inputsReadMode: String(row.inputs_read_mode || row.metadata?.inputs_read_mode || "grid").trim().toLowerCase() === "relational"
                  ? "relational"
                  : "grid",
                masterIngestionMode: String(row.master_ingestion_mode || row.metadata?.master_ingestion_mode || "grid").trim().toLowerCase() === "relational"
                  ? "relational"
                  : "grid",
                masterReadMode: String(row.master_read_mode || row.metadata?.master_read_mode || "grid").trim().toLowerCase() === "relational"
                  ? "relational"
                  : "grid",
                reconMode: String(row.recon_mode || row.metadata?.recon_mode || "grid").trim().toLowerCase() === "relational"
                  ? "relational"
                  : "grid",
                reconReadMode: String(row.recon_read_mode || row.metadata?.recon_read_mode || "grid").trim().toLowerCase() === "relational"
                  ? "relational"
                  : "grid",
                financialsMode: String(row.financials_mode || row.metadata?.financials_mode || "grid").trim().toLowerCase() === "relational"
                  ? "relational"
                  : "grid",
                financialsReadMode: String(row.financials_read_mode || row.metadata?.financials_read_mode || "grid").trim().toLowerCase() === "relational"
                  ? "relational"
                  : "grid",
                clientComputeMode: String(row.client_compute_mode || row.metadata?.client_compute_mode || "grid_gas").trim().toLowerCase(),
                masterComputeMode: String(row.master_compute_mode || row.metadata?.master_compute_mode || "grid_gas").trim().toLowerCase(),
                connectorPullMode: String(row.connector_pull_mode || row.metadata?.connector_pull_mode || "grid_gas").trim().toLowerCase(),
                syncOrchestratorMode: String(row.sync_orchestrator_mode || row.metadata?.sync_orchestrator_mode || "grid_gas").trim().toLowerCase(),
                gridStorageRetired: Boolean(row.grid_storage_retired),
                sheetBridgeMode: String(row.metadata?.sheet_bridge_mode || "off").trim().toLowerCase(),
                metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
                clientSheetId: cId,
                masterSheetId: mId,
                reconSheetId: rId,
              };
              byClientName.set(String(row.client_name || "").trim().toLowerCase(), entry);
              if (normKey) byClientName.set(normKey.toLowerCase(), entry);
              if (mId) bySheetId.set(mId, { ...entry, sheetRole: "master" });
              if (rId) bySheetId.set(rId, { ...entry, sheetRole: "recon" });
              if (cId) bySheetId.set(cId, { ...entry, sheetRole: "client" });
              if (normKey) {
                if (row.client_mode === "supabase") {
                  bySheetId.set(`sb-client-${normKey}`, { ...entry, sheetRole: "client" });
                }
                if (row.master_mode === "supabase") {
                  bySheetId.set(`sb-master-${normKey}`, { ...entry, sheetRole: "master" });
                  bySheetId.set(`sb-recon-${normKey}`, { ...entry, sheetRole: "recon" });
                }
              }
            }
            _sheetContextCache = {
              bySheetId,
              byClientName,
              expiresAt: Date.now() + 30000,
              inFlight: null,
            };
          } else {
            _sheetContextCache.inFlight = null;
          }
        } catch (err) {
          _sheetContextCache.inFlight = null;
          console.warn("[masterEngineService] Context lookup warning:", err.message);
        }
      })();
    }
    await _sheetContextCache.inFlight;
  }

  if (spreadsheetId) {
    const cleanId = extractSheetIdFromUrl(spreadsheetId) || String(spreadsheetId).trim();
    const matched = _sheetContextCache.bySheetId.get(cleanId);
    if (matched) return matched;
  }
  if (clientName) {
    const cleanName = String(clientName).trim().toLowerCase();
    const matched = _sheetContextCache.byClientName.get(cleanName) || _sheetContextCache.byClientName.get(normalizeClientKey_(cleanName));
    if (matched) return matched;
  }
  return null;
}

let _useClientRoleFallback = false;

function findLastActiveClientJobRow_(values, minDefault = 50) {
  if (!Array.isArray(values)) return minDefault;
  let last = 1;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!Array.isArray(row)) continue;
    if (
      (row[0] !== "" && row[0] !== null && row[0] !== undefined) ||
      (row[1] !== "" && row[1] !== null && row[1] !== undefined) ||
      (row[17] !== "" && row[17] !== null && row[17] !== undefined && row[17] !== 0) ||
      (row[32] !== "" && row[32] !== null && row[32] !== undefined && row[32] !== 0) ||
      (row[35] !== "" && row[35] !== null && row[35] !== undefined) ||
      (row[41] !== "" && row[41] !== null && row[41] !== undefined && row[41] !== 0) ||
      (row[48] !== "" && row[48] !== null && row[48] !== undefined && row[48] !== 0) ||
      (row[55] !== "" && row[55] !== null && row[55] !== undefined && row[55] !== 0)
    ) {
      last = r;
    }
  }
  return Math.max(last, minDefault);
}

const FORMULA_TOKEN_SHIFT_RE_ = /"(?:""|[^"])*"|'(?:''|[^'])*'!|[A-Za-z0-9_]+!|(?<![A-Za-z0-9_])(\$?[A-Za-z]{1,3})(\$?)(\d+)(?![0-9(])/g;

// Matches same-sheet cell references only (skipping string literals and CrossSheet!A1:B2 references)
const SAME_SHEET_FORMULA_REF_RE_ =
  /"(?:""|[^"])*"|((?:'(?:''|[^'])*'|[A-Za-z0-9_]+)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)|(?<![A-Za-z0-9_$'!])(\$?[A-Za-z]{1,3})(\$?)(\d+)(?![0-9(])/g;

function shiftFormulaRowByDelta_(formula, delta) {
  if (!formula || typeof formula !== "string" || !formula.startsWith("=") || delta === 0) return formula;
  return formula.replace(FORMULA_TOKEN_SHIFT_RE_, (match, colPart, dollarRow, rowStr) => {
    if (!colPart) return match; // Skip quoted string literals and sheet prefixes
    if (dollarRow === "$") return match;
    if (/^PL$/i.test(colPart)) return match;
    const rNum = parseInt(rowStr, 10);
    return `${colPart}${Math.max(1, rNum + delta)}`;
  });
}

function shiftRelativeRowsAboveThreshold_(formula, minRow1Inclusive, delta) {
  if (!formula || typeof formula !== "string" || !formula.startsWith("=") || delta === 0) return formula;
  return formula.replace(SAME_SHEET_FORMULA_REF_RE_, (match, crossSheetRef, colPart, dollarRow, rowStr) => {
    if (crossSheetRef || !colPart) return match; // Skip quoted string literals and cross-sheet refs
    if (dollarRow === "$") return match;
    if (/^PL$/i.test(colPart)) return match;
    const rNum = parseInt(rowStr, 10);
    if (rNum < minRow1Inclusive) return match;
    return `${colPart}${Math.max(1, rNum + delta)}`;
  });
}

function buildCompiledRowFormulaShifter_(tplFormRow) {
  const descriptors = new Array(tplFormRow.length);
  for (let c = 0; c < tplFormRow.length; c++) {
    const cell = tplFormRow[c];
    if (typeof cell !== "string" || !cell.startsWith("=")) {
      descriptors[c] = null;
      continue;
    }
    const parts = [];
    const baseRows = [];
    let lastIdx = 0;
    FORMULA_TOKEN_SHIFT_RE_.lastIndex = 0;
    let m;
    while ((m = FORMULA_TOKEN_SHIFT_RE_.exec(cell)) !== null) {
      const colPart = m[1];
      if (!colPart || m[2] === "$" || /^PL$/i.test(colPart)) continue;
      parts.push(cell.slice(lastIdx, m.index) + colPart);
      baseRows.push(parseInt(m[3], 10));
      lastIdx = m.index + m[0].length;
    }
    if (baseRows.length === 0) {
      descriptors[c] = null;
    } else {
      parts.push(cell.slice(lastIdx));
      descriptors[c] = { parts, baseRows };
    }
  }
  return descriptors;
}

function applyCompiledRowFormulaShifter_(tplFormRow, descriptors, delta) {
  if (delta === 0) return [...tplFormRow];
  const out = [...tplFormRow];
  for (let c = 0; c < descriptors.length; c++) {
    const desc = descriptors[c];
    if (!desc) continue;
    const { parts, baseRows } = desc;
    let s = parts[0];
    for (let i = 0; i < baseRows.length; i++) {
      s += Math.max(1, baseRows[i] + delta) + parts[i + 1];
    }
    out[c] = s;
  }
  return out;
}

function trimTrailingEmptyCells_(row) {
  if (!Array.isArray(row) || row.length === 0) return [];
  let end = row.length;
  while (end > 0) {
    const v = row[end - 1];
    if (v !== "" && v !== null && v !== undefined) break;
    end--;
  }
  const out = new Array(end);
  for (let i = 0; i < end; i++) {
    const v = row[i];
    out[i] = v === null || v === undefined ? "" : v;
  }
  return out;
}

function compactFormulasGrid2D_(fGrid, { hasSkippedMiddleRows = false } = {}) {
  if (!Array.isArray(fGrid) || fGrid.length === 0) return [];
  const fullOnlyFormulas = [];
  const out = [];
  for (let r = 0; r < fGrid.length; r++) {
    const row = Array.isArray(fGrid[r]) ? fGrid[r] : [];
    const fullRow = [];
    const compactRow = [];
    const isTailAfterSkip = hasSkippedMiddleRows && r === fGrid.length - 1;
    const prevFullRow = r > 0 && !isTailAfterSkip ? fullOnlyFormulas[r - 1] : null;
    const prevBlockRow = r >= 77 && !isTailAfterSkip ? fullOnlyFormulas[r - 77] : null;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell === "string" && cell.startsWith("=")) {
        fullRow[c] = cell;
        if (prevFullRow && typeof prevFullRow[c] === "string" && prevFullRow[c].startsWith("=")) {
          if (shiftFormulaRowByDelta_(prevFullRow[c], 1) === cell) {
            compactRow[c] = "^";
            continue;
          }
        }
        if (prevBlockRow && typeof prevBlockRow[c] === "string" && prevBlockRow[c].startsWith("=")) {
          if (shiftFormulaRowByDelta_(prevBlockRow[c], 77) === cell) {
            compactRow[c] = "^77";
            continue;
          }
        }
        compactRow[c] = cell;
      } else {
        fullRow[c] = "";
        compactRow[c] = "";
      }
    }
    fullOnlyFormulas.push(fullRow);
    out.push(trimTrailingEmptyCells_(compactRow));
  }
  return out;
}

function expandFormulasGrid2D_(storedForms, storedVals, minCols = 0) {
  const rowCount = Math.max(
    Array.isArray(storedForms) ? storedForms.length : 0,
    Array.isArray(storedVals) ? storedVals.length : 0
  );
  const fullOnlyFormulas = [];
  const out = [];
  for (let r = 0; r < rowCount; r++) {
    const fRow = Array.isArray(storedForms?.[r]) ? storedForms[r] : [];
    const vRow = Array.isArray(storedVals?.[r]) ? storedVals[r] : [];
    const colCount = Math.max(fRow.length, vRow.length, r === 0 ? minCols : 0);
    const fullRow = new Array(colCount);
    const outRow = new Array(colCount);
    const prevFullRow = r > 0 ? fullOnlyFormulas[r - 1] : null;
    const prevBlockRow = r >= 77 ? fullOnlyFormulas[r - 77] : null;
    for (let c = 0; c < colCount; c++) {
      const token = fRow[c];
      let resolvedFormula = "";
      if (token === "^" && prevFullRow && prevFullRow[c]) {
        resolvedFormula = shiftFormulaRowByDelta_(prevFullRow[c], 1);
      } else if (token === "^77" && prevBlockRow && prevBlockRow[c]) {
        resolvedFormula = shiftFormulaRowByDelta_(prevBlockRow[c], 77);
      } else if (typeof token === "string" && token.startsWith("=")) {
        resolvedFormula = token;
      }
      fullRow[c] = resolvedFormula;
      outRow[c] = resolvedFormula || (vRow[c] ?? "");
    }
    fullOnlyFormulas.push(fullRow);
    out.push(outRow);
  }
  return out;
}

export function trimMasterCalcsGrid_(rawRows) {
  const compacted = compactGrid2D(rawRows);
  if (compacted.length <= 130) return compacted;
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
}

export function compactClientTabForStorage_(tabName, valuesGrid, formulasGrid, notesGrid) {
  const cleanNotes = { ...(notesGrid || {}) };
  delete cleanNotes.__formulas_grid;
  delete cleanNotes.__compact_meta;

  const vGrid = Array.isArray(valuesGrid) ? valuesGrid : [];
  const fGrid = Array.isArray(formulasGrid) && formulasGrid.length > 0 ? formulasGrid : vGrid;

  if (
    (tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs") &&
    vGrid.length > 350
  ) {
    const minDef = tabName === "Confirmed" || tabName === "ConfCalcs" ? 295 : 105;
    const activeRow = findLastActiveClientJobRow_(vGrid, minDef);
    const templateRowIdx = Math.min(vGrid.length - 2, activeRow + 2);
    if (vGrid.length > templateRowIdx + 3) {
      const compactVals = [...vGrid.slice(0, templateRowIdx + 1), vGrid[vGrid.length - 1] || []].map((r) =>
        trimTrailingEmptyCells_(r)
      );
      const rawCompactForms = [...fGrid.slice(0, templateRowIdx + 1), fGrid[fGrid.length - 1] || []];
      const compactForms = compactFormulasGrid2D_(rawCompactForms, { hasSkippedMiddleRows: true });
      cleanNotes.__compact_meta = {
        totalRows: vGrid.length,
        templateRowIdx,
      };
      return { storedValues: compactVals, storedFormulas: compactForms, storedNotes: cleanNotes, totalRows: vGrid.length };
    }
  }

  const compactVals = vGrid.map((r) => trimTrailingEmptyCells_(r));
  const storedFormulas = compactFormulasGrid2D_(fGrid);
  return { storedValues: compactVals, storedFormulas, storedNotes: cleanNotes, totalRows: vGrid.length };
}

export function expandClientTabFromStorage_(data, tabName, { valuesOnly = false } = {}) {
  const hadNotesGridFromDb = Boolean(data.notes_grid && typeof data.notes_grid === "object");
  const rawNotes = hadNotesGridFromDb ? { ...data.notes_grid } : {};
  const hasLegacyEmbeddedFormulas = Array.isArray(rawNotes.__formulas_grid);
  const hasDbFormulasCol = Array.isArray(data.formulas_grid) && data.formulas_grid.length > 0;
  const storedVals = Array.isArray(data.values_grid) ? data.values_grid : [];
  const minCols = Math.min(Math.max(0, Number(data.col_count) || 0), 600);
  let meta = rawNotes.__compact_meta;
  if (
    !meta &&
    data.row_count > storedVals.length &&
    storedVals.length >= 2 &&
    (tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs")
  ) {
    meta = { totalRows: data.row_count, templateRowIdx: storedVals.length - 2 };
  }
  const storedForms = !valuesOnly
    ? (hasDbFormulasCol
      ? data.formulas_grid
      : hasLegacyEmbeddedFormulas
        ? rawNotes.__formulas_grid
        : storedVals)
    : null;

  delete rawNotes.__formulas_grid;
  delete rawNotes.__compact_meta;

  const rawDbNotesJson = !hasLegacyEmbeddedFormulas && hadNotesGridFromDb ? JSON.stringify(rawNotes) : null;
  const rawDbFormulasJson = !valuesOnly && hasDbFormulasCol ? JSON.stringify(data.formulas_grid) : null;
  const hasMigratedFormulasCol = !hasLegacyEmbeddedFormulas && (hasDbFormulasCol || storedVals.length === 0);

  if (meta && meta.totalRows > storedVals.length && storedVals.length >= 2) {
    const totalRows = Math.min(Math.max(0, Math.trunc(Number(meta.totalRows) || 0)), 50000);
    const templateRowIdx = Math.max(0, Math.min(storedVals.length - 1, Math.trunc(Number(meta.templateRowIdx) || 0)));
    const uncompactedForms = valuesOnly ? null : expandFormulasGrid2D_(storedForms, storedVals, minCols);
    const expandedVals = [];
    const expandedForms = valuesOnly ? expandedVals : [];
    const tplValRow = storedVals[templateRowIdx] || [];
    const tplFormRow = uncompactedForms ? (uncompactedForms[templateRowIdx] || []) : null;
    const tplFormulaShifter = !valuesOnly && tplFormRow ? buildCompiledRowFormulaShifter_(tplFormRow) : null;
    const tailValRow = storedVals[storedVals.length - 1] || [];
    const tailFormRow = uncompactedForms ? (uncompactedForms[uncompactedForms.length - 1] || []) : null;

    for (let r = 0; r <= templateRowIdx; r++) {
      const rowCopy = Array.isArray(storedVals[r]) ? [...storedVals[r]] : [];
      if (r === 0 && minCols > rowCopy.length) {
        while (rowCopy.length < minCols) rowCopy.push("");
      }
      expandedVals.push(rowCopy);
      if (!valuesOnly) {
        expandedForms.push(Array.isArray(uncompactedForms[r]) ? [...uncompactedForms[r]] : []);
      }
    }
    for (let r = templateRowIdx + 1; r < totalRows - 1; r++) {
      expandedVals.push([...tplValRow]);
      if (!valuesOnly) {
        expandedForms.push(
          tplFormRow ? applyCompiledRowFormulaShifter_(tplFormRow, tplFormulaShifter, r - templateRowIdx) : []
        );
      }
    }
    expandedVals.push([...tailValRow]);
    if (!valuesOnly) {
      expandedForms.push([...tailFormRow]);
    }

    data.values_grid = expandedVals;
    data.formulas_grid = expandedForms;
    data.notes_grid = rawNotes;
    data.tab_name = tabName;
    data.sheet_role = "client";
    data._storedTemplateRowIdx = templateRowIdx;
    data._hasMigratedFormulasCol = hasMigratedFormulasCol;
    data._notesLoaded = hadNotesGridFromDb;
    if (rawDbNotesJson) {
      data._dbNotesJson = rawDbNotesJson;
    }
    if (rawDbFormulasJson) {
      data._dbFormulasJson = rawDbFormulasJson;
    }
    return data;
  }

  const expandedVals = storedVals.map((r, rIdx) => {
    const copy = Array.isArray(r) ? [...r] : [];
    if (rIdx === 0 && minCols > copy.length) {
      while (copy.length < minCols) copy.push("");
    }
    return copy;
  });
  const expandedForms = valuesOnly ? expandedVals : expandFormulasGrid2D_(storedForms, expandedVals, minCols);

  data.values_grid = expandedVals;
  data.formulas_grid = expandedForms;
  data.notes_grid = rawNotes;
  data.tab_name = tabName;
  data.sheet_role = "client";
  data._hasMigratedFormulasCol = hasMigratedFormulasCol;
  data._notesLoaded = hadNotesGridFromDb;
  if (rawDbNotesJson) {
    data._dbNotesJson = rawDbNotesJson;
  }
  if (rawDbFormulasJson) {
    data._dbFormulasJson = rawDbFormulasJson;
  }
  return data;
}

const _inFlightGridLoads = new Map();

function doesCachedClientRecordSatisfy_(rec, { valuesOnly = false, includeNotes = false } = {}) {
  return Boolean(rec && (!rec._valuesOnlyLoaded || valuesOnly) && (!valuesOnly || !includeNotes || rec._notesLoaded !== false));
}

function shouldStoreClientRecordInCache_(existingEntry, { valuesOnly = false, includeNotes = false } = {}) {
  if (!existingEntry || existingEntry.expiresAt <= Date.now()) return true;
  if (!valuesOnly) return true;
  if (includeNotes) return Boolean(existingEntry.record?._valuesOnlyLoaded);
  return Boolean(existingEntry.record?._valuesOnlyLoaded && existingEntry.record?._notesLoaded === false);
}

export const NATIVE_CONNECTOR_BYPASS_GRID_TABS = new Set([
  "InvFromApp",
  "RevFromApp",
  "JnlsFromApp",
  "PLFromApp",
  "Year0PLFromApp",
  "DataFromCRM",
  "DataFromTime",
  "ProjectsFromTime",
  "CRMGoogleBridge",
  "CRMExcelBridge",
  "CRMExcelCopy",
  "GasScriptProps",
]);

export async function getOrLoadVirtualTabGrid_(ctx, sheetRole, tabName, rawSheetsApi = null, options = {}) {
  const valuesOnly = Boolean(options?.valuesOnly);
  const includeNotes = Boolean(options?.includeNotes);
  const supabase = getSupabaseAdmin();
  if (!supabase) return { values_grid: [], formulas_grid: [], notes_grid: {} };

  const cacheKey = `${ctx.clientName.toLowerCase()}::${sheetRole}::${tabName}`;
  const cached = _gridMemoryCache.get(cacheKey);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    (sheetRole !== "client" || doesCachedClientRecordSatisfy_(cached.record, { valuesOnly, includeNotes }))
  ) {
    return cached.record;
  }

  // Coalesce concurrent requests for the same tab
  const fullInFlight = _inFlightGridLoads.get(cacheKey);
  if (fullInFlight) {
    return fullInFlight;
  }
  const notesInFlightKey = `${cacheKey}::vn`;
  if (valuesOnly && !includeNotes && _inFlightGridLoads.has(notesInFlightKey)) {
    return _inFlightGridLoads.get(notesInFlightKey);
  }
  const inFlightKey = !valuesOnly ? cacheKey : includeNotes ? notesInFlightKey : `${cacheKey}::vo`;
  if (_inFlightGridLoads.has(inFlightKey)) {
    return _inFlightGridLoads.get(inFlightKey);
  }

  const loadPromise = (async () => {
    let data = null;
    let error = null;

    if (sheetRole === "client" && ctx.clientComputeMode === "native") {
      try {
        const effectiveIncludeNotes = !valuesOnly || includeNotes;
        const { loadNativeClientTabRecord } = await import("./nativeClientCalcService.js");
        const relRec = await loadNativeClientTabRecord(ctx, tabName, {
          source: "db",
          valuesOnly,
          includeNotes: effectiveIncludeNotes,
        });
        if (relRec && Array.isArray(relRec.values_grid) && relRec.values_grid.length > 0) {
          const recOut = {
            client_id: ctx.clientId,
            client_name: ctx.clientName,
            sheet_role: "client",
            tab_name: tabName,
            ...relRec,
            _valuesOnlyLoaded: valuesOnly,
            _notesLoaded: effectiveIncludeNotes,
          };
          const existing = _gridMemoryCache.get(cacheKey);
          if (shouldStoreClientRecordInCache_(existing, { valuesOnly, includeNotes })) {
            setGridMemoryCache_(cacheKey, recOut);
          }
          return recOut;
        }
      } catch (natErr) {
        console.warn(`[masterEngineService] Native client tab load fallback (${ctx.clientName}/${tabName}):`, natErr?.message);
        if (ctx.gridStorageRetired) throw natErr;
      }
    }

    if (sheetRole === "master" && ctx.masterComputeMode === "native") {
      try {
        const {
          MASTER_COMP_TYPE_BY_TAB,
          loadMasterContextTabFromConfig,
          loadPersistedOrEvaluateMasterComparisonTab,
        } = await import("./nativeMasterComparisonService.js");
        if (tabName === "KeyInfo" || tabName === "DataChgAlert" || tabName === "PLAdds") {
          const ctxGrid = await loadMasterContextTabFromConfig(ctx, tabName);
          if (Array.isArray(ctxGrid) && ctxGrid.length > 0) {
            const recOut = {
              client_id: ctx.clientId,
              client_name: ctx.clientName,
              sheet_role: "master",
              tab_name: tabName,
              values_grid: ctxGrid,
              formulas_grid: ctxGrid,
              notes_grid: {},
              row_count: ctxGrid.length,
              col_count: ctxGrid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
              updated_at: new Date().toISOString(),
            };
            setGridMemoryCache_(cacheKey, recOut);
            return recOut;
          }
        } else if (Object.prototype.hasOwnProperty.call(MASTER_COMP_TYPE_BY_TAB, tabName)) {
          const compGrid = await loadPersistedOrEvaluateMasterComparisonTab(ctx, tabName);
          if (Array.isArray(compGrid)) {
            const recOut = {
              client_id: ctx.clientId,
              client_name: ctx.clientName,
              sheet_role: "master",
              tab_name: tabName,
              values_grid: compGrid,
              formulas_grid: compGrid,
              notes_grid: {},
              row_count: compGrid.length,
              col_count: compGrid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
              updated_at: new Date().toISOString(),
            };
            setGridMemoryCache_(cacheKey, recOut);
            return recOut;
          }
        }
      } catch (natMasterErr) {
        console.warn(`[masterEngineService] Native master tab load fallback (${ctx.clientName}/${tabName}):`, natMasterErr?.message);
        if (ctx.gridStorageRetired) throw natMasterErr;
      }
    }

    if (
      sheetRole === "master" &&
      ctx.connectorPullMode === "native" &&
      NATIVE_CONNECTOR_BYPASS_GRID_TABS.has(tabName)
    ) {
      try {
        if (
          tabName === "CRMGoogleBridge" ||
          tabName === "CRMExcelBridge" ||
          tabName === "CRMExcelCopy" ||
          tabName === "GasScriptProps"
        ) {
          const { data: cfg6c } = await supabase
            .from("pulse_master_sync_configs")
            .select("crm_google_bridge_grid, crm_excel_bridge_grid, crm_excel_copy_grid, script_properties")
            .eq("client_id", ctx.clientId)
            .maybeSingle();
          if (cfg6c) {
            let vGrid = [];
            if (tabName === "CRMGoogleBridge") vGrid = Array.isArray(cfg6c.crm_google_bridge_grid) ? cfg6c.crm_google_bridge_grid : [];
            else if (tabName === "CRMExcelBridge") vGrid = Array.isArray(cfg6c.crm_excel_bridge_grid) ? cfg6c.crm_excel_bridge_grid : [];
            else if (tabName === "CRMExcelCopy") vGrid = Array.isArray(cfg6c.crm_excel_copy_grid) ? cfg6c.crm_excel_copy_grid : [];
            else if (tabName === "GasScriptProps") {
              const sp = cfg6c.script_properties && typeof cfg6c.script_properties === "object" ? cfg6c.script_properties : {};
              vGrid = [["Key", "Value"], ...Object.entries(sp).map(([k, v]) => [k, String(v ?? "")])];
            }
            const compacted = compactGrid2D(vGrid);
            const recOut = {
              client_id: ctx.clientId,
              client_name: ctx.clientName,
              sheet_role: "master",
              tab_name: tabName,
              values_grid: compacted,
              formulas_grid: compacted,
              notes_grid: {},
              row_count: compacted.length,
              col_count: compacted.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
              updated_at: new Date().toISOString(),
            };
            setGridMemoryCache_(cacheKey, recOut);
            return recOut;
          }
        } else {
          const {
            preloadClientRelationalMasterBundle,
            reconstructRelationalMasterTabFromBundle,
          } = await import("./relationalMasterService.js");
          const bundle = await preloadClientRelationalMasterBundle(ctx, {
            source: "db",
            tabs: [tabName],
          });
          const rGrid = await reconstructRelationalMasterTabFromBundle(bundle, tabName, ctx);
          if (Array.isArray(rGrid)) {
            const compacted = compactGrid2D(rGrid);
            const recOut = {
              client_id: ctx.clientId,
              client_name: ctx.clientName,
              sheet_role: "master",
              tab_name: tabName,
              values_grid: compacted,
              formulas_grid: compacted,
              notes_grid: {},
              row_count: compacted.length,
              col_count: compacted.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
              updated_at: new Date().toISOString(),
            };
            setGridMemoryCache_(cacheKey, recOut);
            return recOut;
          }
        }
      } catch (c6LoadErr) {
        console.warn(`[masterEngineService] Native connector tab load fallback (${ctx.clientName}/${tabName}):`, c6LoadErr?.message);
        if (ctx.gridStorageRetired) throw c6LoadErr;
      }
    }

    if (sheetRole === "master" && ctx.syncOrchestratorMode === "native") {
      try {
        const {
          MASTER_AUX_COL_BY_TAB,
          MASTER_TRANSIENT_CLIENT_MIRROR_TABS,
          loadClientAutomationLogGrid,
          loadClientExecutionLogGrid,
          loadMasterAuxTabFromConfig,
        } = await import("./nativeSyncOrchestratorService.js");
        if (tabName === "AutoLog") {
          const alGrid = await loadClientAutomationLogGrid(ctx, { limit: 2500 });
          const recOut = {
            client_id: ctx.clientId,
            client_name: ctx.clientName,
            sheet_role: "master",
            tab_name: "AutoLog",
            values_grid: alGrid,
            formulas_grid: alGrid,
            notes_grid: {},
            row_count: alGrid.length,
            col_count: 4,
            updated_at: new Date().toISOString(),
          };
          setGridMemoryCache_(cacheKey, recOut);
          return recOut;
        }
        if (tabName === "GasExecLogs") {
          const exGrid = await loadClientExecutionLogGrid(ctx, { limit: 50 });
          const recOut = {
            client_id: ctx.clientId,
            client_name: ctx.clientName,
            sheet_role: "master",
            tab_name: "GasExecLogs",
            values_grid: exGrid,
            formulas_grid: exGrid,
            notes_grid: {},
            row_count: exGrid.length,
            col_count: 7,
            updated_at: new Date().toISOString(),
          };
          setGridMemoryCache_(cacheKey, recOut);
          return recOut;
        }
        if (Object.prototype.hasOwnProperty.call(MASTER_AUX_COL_BY_TAB, tabName)) {
          const auxRec = await loadMasterAuxTabFromConfig(ctx, tabName);
          if (auxRec && Array.isArray(auxRec.values_grid)) {
            const compacted = compactGrid2D(auxRec.values_grid);
            const recOut = {
              client_id: ctx.clientId,
              client_name: ctx.clientName,
              sheet_role: "master",
              tab_name: tabName,
              values_grid: compacted,
              formulas_grid: Array.isArray(auxRec.formulas_grid) && auxRec.formulas_grid.length > 0 ? auxRec.formulas_grid : compacted,
              notes_grid: {},
              row_count: compacted.length,
              col_count: compacted.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
              updated_at: new Date().toISOString(),
            };
            setGridMemoryCache_(cacheKey, recOut);
            return recOut;
          }
        }
        if (MASTER_TRANSIENT_CLIENT_MIRROR_TABS.has(tabName)) {
          if (ctx.clientComputeMode === "native") {
            const clientTargetTab = tabName === "MthlyClient" ? "Monthly" : tabName;
            const { loadNativeClientTabRecord } = await import("./nativeClientCalcService.js");
            const cRec = await loadNativeClientTabRecord(ctx, clientTargetTab, { source: "db", valuesOnly: true }).catch(() => null);
            if (cRec && Array.isArray(cRec.values_grid)) {
              const compacted = compactGrid2D(cRec.values_grid);
              const recOut = {
                client_id: ctx.clientId,
                client_name: ctx.clientName,
                sheet_role: "master",
                tab_name: tabName,
                values_grid: compacted,
                formulas_grid: compacted,
                notes_grid: cRec.notes_grid || {},
                row_count: compacted.length,
                col_count: compacted.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
                updated_at: new Date().toISOString(),
              };
              setGridMemoryCache_(cacheKey, recOut);
              return recOut;
            }
          }
        }
      } catch (c6dLoadErr) {
        console.warn(`[masterEngineService] Native Phase 6D tab load fallback (${ctx.clientName}/${tabName}):`, c6dLoadErr?.message);
        if (ctx.gridStorageRetired) throw c6dLoadErr;
      }
    }

    if (sheetRole === "recon" && (ctx.reconReadMode === "relational" || ctx.syncOrchestratorMode === "native")) {
      try {
        const {
          isManagedReconTab,
          preloadClientRelationalReconBundle,
          reconstructRelationalReconTabFromBundle,
        } = await import("./relationalReconService.js");
        if (isManagedReconTab(tabName)) {
          const bundle = await preloadClientRelationalReconBundle(ctx, { source: "db" });
          const rRec = reconstructRelationalReconTabFromBundle(bundle, tabName);
          if (rRec && Array.isArray(rRec.values_grid)) {
            const recOut = {
              client_id: ctx.clientId,
              client_name: ctx.clientName,
              sheet_role: "recon",
              tab_name: tabName,
              values_grid: compactGrid2D(rRec.values_grid),
              formulas_grid: compactGrid2D(rRec.formulas_grid || rRec.values_grid),
              notes_grid: rRec.notes_grid || {},
              row_count: rRec.row_count || rRec.values_grid.length,
              col_count: rRec.col_count || 0,
              updated_at: rRec.updated_at || new Date().toISOString(),
            };
            setGridMemoryCache_(cacheKey, recOut);
            return recOut;
          }
        }
      } catch (relReconLoadErr) {
        console.warn(`[masterEngineService] Native recon tab load fallback (${ctx.clientName}/${tabName}):`, relReconLoadErr?.message);
        if (ctx.gridStorageRetired) throw relReconLoadErr;
      }
    }

    if (ctx.gridStorageRetired && ctx.clientComputeMode === "native" && ctx.masterComputeMode === "native" && ctx.syncOrchestratorMode === "native") {
      return {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: sheetRole,
        tab_name: tabName,
        values_grid: [],
        formulas_grid: [],
        notes_grid: {},
        row_count: 0,
        col_count: 0,
      };
    }

    if (sheetRole === "client") {
      const selectCols = !valuesOnly
        ? "id, client_id, client_name, sheet_role, tab_name, values_grid, formulas_grid, notes_grid, row_count, col_count, updated_at"
        : includeNotes
          ? "id, client_id, client_name, sheet_role, tab_name, values_grid, notes_grid, row_count, col_count, updated_at"
          : "id, client_id, client_name, sheet_role, tab_name, values_grid, row_count, col_count, updated_at";
      const dbRole = _useClientRoleFallback ? "master" : "client";
      const dbTab = _useClientRoleFallback ? `Client::${tabName}` : tabName;
      const res = await supabase
        .from("master_sheet_grids")
        .select(selectCols)
        .eq("client_name", ctx.clientName)
        .eq("sheet_role", dbRole)
        .eq("tab_name", dbTab)
        .maybeSingle();
      data = res.data;
      error = res.error;
      if (!error && !data && !_useClientRoleFallback) {
        const legacyRes = await supabase
          .from("master_sheet_grids")
          .select(selectCols)
          .eq("client_name", ctx.clientName)
          .eq("sheet_role", "master")
          .eq("tab_name", `Client::${tabName}`)
          .maybeSingle();
        if (!legacyRes.error && legacyRes.data) {
          data = legacyRes.data;
        }
      }
      if (!error && data) {
        expandClientTabFromStorage_(data, tabName, { valuesOnly });
        data._valuesOnlyLoaded = valuesOnly;
        data._notesLoaded = !valuesOnly || includeNotes;
        const existing = _gridMemoryCache.get(cacheKey);
        if (shouldStoreClientRecordInCache_(existing, { valuesOnly, includeNotes })) {
          setGridMemoryCache_(cacheKey, data);
        }
        return data;
      }
    } else {
      const res = await supabase
        .from("master_sheet_grids")
        .select("id, client_id, client_name, sheet_role, tab_name, values_grid, notes_grid, row_count, col_count, updated_at")
        .eq("client_name", ctx.clientName)
        .eq("sheet_role", sheetRole)
        .eq("tab_name", tabName)
        .maybeSingle();
      data = res.data;
      error = res.error;
      if (!error && data) {
        data.values_grid = compactGrid2D(data.values_grid || []);
        data.formulas_grid = data.values_grid;
        setGridMemoryCache_(cacheKey, data);
        return data;
      }
    }

    // Lazy-seed from underlying Google Sheet if not yet in master_sheet_grids
    const sourceSheetId =
      sheetRole === "recon" ? ctx.reconSheetId : sheetRole === "client" ? ctx.clientSheetId : ctx.masterSheetId;
    if (rawSheetsApi && sourceSheetId) {
      try {
        const [valResp, formResp] = await Promise.all([
          rawSheetsApi.spreadsheets.values.get({
            spreadsheetId: sourceSheetId,
            range: `'${tabName}'`,
            valueRenderOption: "UNFORMATTED_VALUE",
          }),
          rawSheetsApi.spreadsheets.values
            .get({
              spreadsheetId: sourceSheetId,
              range: `'${tabName}'`,
              valueRenderOption: "FORMULA",
            })
            .catch(() => ({ data: { values: [] } })),
        ]);
        const valuesGrid = valResp?.data?.values || [];
        const formulasGrid = formResp?.data?.values || valuesGrid;
        const maxCols = valuesGrid.reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0);

        await saveVirtualTabGrid_(ctx, sheetRole, tabName, valuesGrid, formulasGrid, {});
        const saved = _gridMemoryCache.get(cacheKey)?.record;
        if (saved) return saved;
        return {
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          sheet_role: sheetRole,
          tab_name: tabName,
          values_grid: valuesGrid,
          formulas_grid: formulasGrid,
          notes_grid: {},
          row_count: valuesGrid.length,
          col_count: maxCols,
        };
      } catch {
        // Tab may not exist on legacy sheet
      }
    }

    const emptyRecord = {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      sheet_role: sheetRole,
      tab_name: tabName,
      values_grid: [],
      formulas_grid: [],
      notes_grid: {},
      row_count: 0,
      col_count: 0,
    };
    return emptyRecord;
  })();

  _inFlightGridLoads.set(inFlightKey, loadPromise);
  try {
    return await loadPromise;
  } finally {
    _inFlightGridLoads.delete(inFlightKey);
  }
}

async function getVirtualTabGridForWrite_(ctx, sheetRole, tabName, rawSheetsApi = null, options = {}) {
  const supabase = getSupabaseAdmin();
  const cacheKey = `${ctx.clientName.toLowerCase()}::${sheetRole}::${tabName}`;
  const cached = _gridMemoryCache.get(cacheKey);
  const skipGridStalenessCheck =
    (sheetRole === "client" && ctx.clientComputeMode === "native") ||
    (sheetRole === "master" && (ctx.masterComputeMode === "native" || ctx.syncOrchestratorMode === "native")) ||
    (sheetRole === "recon" && ctx.syncOrchestratorMode === "native");
  if (supabase && cached && !skipGridStalenessCheck && !hasPendingOrInFlightClientRecompute_(ctx.clientName)) {
    try {
      const q = supabase
        .from("master_sheet_grids")
        .select("updated_at")
        .eq("client_name", ctx.clientName);
      let metaRow = null;
      if (sheetRole === "client") {
        const { data: candidates } = await q
          .in("sheet_role", ["client", "master"])
          .in("tab_name", [String(tabName), `Client::${String(tabName)}`]);
        metaRow =
          (candidates || []).find((r) => r.sheet_role === "client" && r.tab_name === String(tabName)) ||
          (candidates || []).find((r) => r.sheet_role === "master" && r.tab_name === `Client::${String(tabName)}`) ||
          null;
      } else {
        const resSingle = await q.eq("sheet_role", sheetRole).eq("tab_name", tabName).maybeSingle();
        metaRow = resSingle?.data || null;
      }
      const dbUpdatedMs = metaRow?.updated_at ? new Date(metaRow.updated_at).getTime() : 0;
      const cachedUpdatedMs = cached.record?.updated_at ? new Date(cached.record.updated_at).getTime() : 0;
      if (dbUpdatedMs > 0 && (!cachedUpdatedMs || dbUpdatedMs > cachedUpdatedMs)) {
        _gridMemoryCache.delete(cacheKey);
      }
    } catch (_) { }
  }
  const effectiveOpts =
    sheetRole === "client" && options.includeNotes === undefined
      ? { ...options, includeNotes: true }
      : options;
  return getOrLoadVirtualTabGrid_(ctx, sheetRole, tabName, rawSheetsApi, effectiveOpts);
}

export function recomputeReconTabFormulasSync_(grid) {
  if (!Array.isArray(grid) || grid.length < 3) return;

  // 1. Recompute U3:X17 from bank transactions A3:Q (unbounded rows)
  // Col I (index 8): OutAmount, Col J (index 9): InAmount, Col Q (index 16): Category
  const categoryTotals = new Map();
  const maxTxRow = grid.length;
  for (let r = 2; r < maxTxRow; r++) {
    const row = grid[r] || [];
    const cat = String(row[16] || "").trim().toLowerCase();
    if (!cat) continue;
    const outVal = parseFloat(String(row[8] || "0").replace(/[£,\s]/g, "")) || 0;
    const inVal = parseFloat(String(row[9] || "0").replace(/[£,\s]/g, "")) || 0;
    if (!categoryTotals.has(cat)) {
      categoryTotals.set(cat, { out: 0, in: 0 });
    }
    const entry = categoryTotals.get(cat);
    entry.out += outVal;
    entry.in += inVal;
  }

  let totalOut = 0;
  let totalIn = 0;
  let totalNet = 0;

  for (let r = 2; r <= 15; r++) {
    const row = grid[r] || [];
    const catName = String(row[20] || "").trim();
    if (!catName || catName.toLowerCase() === "total") continue;
    const catKey = catName.toLowerCase();
    const entry = categoryTotals.get(catKey) || { out: 0, in: 0 };
    const outVal = Math.round(entry.out * 100) / 100;
    const inVal = Math.round(entry.in * 100) / 100;
    const netVal = Math.round((inVal - outVal) * 100) / 100;

    while (row.length < 24) row.push("");
    row[21] = outVal;
    row[22] = inVal;
    row[23] = netVal;
    grid[r] = row;

    totalOut += outVal;
    totalIn += inVal;
    totalNet += netVal;
  }

  // Row 17 (index 16): Total
  if (grid.length > 16) {
    const row17 = grid[16] || [];
    while (row17.length < 24) row17.push("");
    row17[20] = "Total";
    row17[21] = Math.round(totalOut * 100) / 100;
    row17[22] = Math.round(totalIn * 100) / 100;
    row17[23] = Math.round(totalNet * 100) / 100;
    grid[16] = row17;
  }

  // 2. Recompute CP (col 93) & CZ3:DA from unreconciled items CD4:CN (unbounded rows)
  const da1Val = String(grid[0]?.[104] || "").trim().toLowerCase();
  const isQb = da1Val.includes("quick");
  const mult = isQb ? -1 : 1;

  const plCategorySums = new Map();
  const origCatNameByLower = new Map();
  const maxUnrecRow = grid.length;
  for (let r = 3; r < maxUnrecRow; r++) {
    const row = grid[r] || [];
    const origCat = String(row[90] || "").trim();
    const cat = origCat.toLowerCase();
    const rawAmtStr = String(row[86] ?? "").trim();
    if (!cat && !rawAmtStr) continue;
    const rawAmt = parseFloat(rawAmtStr.replace(/[£,\s]/g, "")) || 0;
    const vatApplies = String(row[91] || "").trim().toLowerCase() === "yes";
    const cpVal = -(vatApplies ? rawAmt / 1.2 : rawAmt);
    while (row.length < 94) row.push("");
    row[93] = Math.round(cpVal * 100) / 100;
    grid[r] = row;
    if (cat) {
      if (!origCatNameByLower.has(cat)) origCatNameByLower.set(cat, origCat);
      plCategorySums.set(cat, (plCategorySums.get(cat) || 0) + cpVal);
    }
  }

  const seenCzCats = new Set();
  for (let r = 2; r < Math.min(grid.length, 120); r++) {
    const row = grid[r] || [];
    const czCat = String(row[103] || "").trim();
    if (!czCat) continue;
    const czLower = czCat.toLowerCase();
    seenCzCats.add(czLower);
    const sumCp = plCategorySums.get(czLower) || 0;
    const daVal = Math.round(sumCp * mult * 100) / 100;
    while (row.length < 105) row.push("");
    row[104] = daVal;
    grid[r] = row;
  }

  for (const [catLower, sumCp] of plCategorySums.entries()) {
    if (seenCzCats.has(catLower) || Math.abs(sumCp) <= 1e-9) continue;
    let targetR = -1;
    for (let r = 2; r < 120; r++) {
      if (!String(grid[r]?.[103] || "").trim()) {
        targetR = r;
        break;
      }
    }
    if (targetR === -1) break;
    while (grid.length <= targetR) grid.push([]);
    const row = grid[targetR] || [];
    while (row.length < 105) row.push("");
    row[103] = origCatNameByLower.get(catLower) || catLower;
    row[104] = Math.round(sumCp * mult * 100) / 100;
    grid[targetR] = row;
  }
}

export async function saveVirtualTabGrid_(
  ctx,
  sheetRole,
  tabName,
  valuesGrid,
  formulasGrid = null,
  notesGrid = null,
  options = {}
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const cacheKey = `${ctx.clientName.toLowerCase()}::${sheetRole}::${tabName}`;
  const existing = _gridMemoryCache.get(cacheKey)?.record || {};

  if (sheetRole === "client") {
    const fullValues = Array.isArray(valuesGrid) ? valuesGrid : [];
    const fullFormulas =
      Array.isArray(formulasGrid) && formulasGrid.length > 0 ? formulasGrid : existing.formulas_grid || fullValues;
    const baseNotes = notesGrid || existing.notes_grid || {};
    const maxCols = Math.max(
      Number(existing.col_count) || 0,
      fullValues.reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0),
      fullFormulas.reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0)
    );

    if (options.memoryOnly) {
      const inMemoryRecord = {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: "client",
        tab_name: tabName,
        values_grid: fullValues,
        formulas_grid: fullFormulas,
        notes_grid: { ...baseNotes },
        row_count: fullValues.length,
        col_count: maxCols,
        updated_at: new Date().toISOString(),
        _storedTemplateRowIdx: existing._storedTemplateRowIdx,
        _hasMigratedFormulasCol: existing._hasMigratedFormulasCol,
        _dbNotesJson: existing._dbNotesJson,
        _dbFormulasJson: existing._dbFormulasJson,
        _notesLoaded: existing._notesLoaded !== false,
        _persistedImmediate: false,
        _persistedToDbImmediate: false,
      };
      delete inMemoryRecord.notes_grid.__formulas_grid;
      delete inMemoryRecord.notes_grid.__compact_meta;
      setGridMemoryCache_(cacheKey, inMemoryRecord);
      return;
    }

    if (ctx.clientComputeMode === "native") {
      const inMemoryRecord = {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: "client",
        tab_name: tabName,
        values_grid: fullValues,
        formulas_grid: fullFormulas,
        notes_grid: { ...baseNotes },
        row_count: fullValues.length,
        col_count: maxCols,
        updated_at: new Date().toISOString(),
        _hasMigratedFormulasCol: true,
        _notesLoaded: true,
        _persistedImmediate: Boolean(options.markPersistedImmediate),
        _persistedToDbImmediate: Boolean(options.markPersistedToDbImmediate || options.markPersistedImmediate),
      };
      delete inMemoryRecord.notes_grid.__formulas_grid;
      delete inMemoryRecord.notes_grid.__compact_meta;
      setGridMemoryCache_(cacheKey, inMemoryRecord);
      const {
        saveNativeClientTabBlueprint,
      } = await import("./nativeClientCalcService.js");
      await saveNativeClientTabBlueprint(ctx, tabName, fullValues, fullFormulas, baseNotes, {
        ...options,
        notesLoaded: options.notesLoaded !== undefined ? options.notesLoaded : (notesGrid !== null ? true : existing._notesLoaded !== false),
      });
      return;
    }

    const dbSheetRole = _useClientRoleFallback ? "master" : "client";
    const dbTabName = _useClientRoleFallback ? `Client::${tabName}` : tabName;

    // Fast path for valuesOnly saves (downstream tabs whose formulas/notes did not change):
    // avoid running compactFormulasGrid2D_ regex compaction across all rows once formulas_grid is migrated.
    if (!options.memoryOnly && !_useClientRoleFallback && Boolean(options.valuesOnly) && existing._hasMigratedFormulasCol) {
      let fastNextTplIdx = undefined;
      let fastStoredValues = null;
      if (
        (tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs") &&
        fullValues.length > 350
      ) {
        const minDef = tabName === "Confirmed" || tabName === "ConfCalcs" ? 295 : 105;
        const activeRow = findLastActiveClientJobRow_(fullValues, minDef);
        const tplIdx = Math.min(fullValues.length - 2, activeRow + 2);
        if (fullValues.length > tplIdx + 3) {
          fastNextTplIdx = tplIdx;
          if (existing._storedTemplateRowIdx === undefined || fastNextTplIdx === existing._storedTemplateRowIdx) {
            fastStoredValues = [...fullValues.slice(0, tplIdx + 1), fullValues[fullValues.length - 1] || []].map((r) =>
              trimTrailingEmptyCells_(r)
            );
          }
        }
      } else {
        fastStoredValues = fullValues.map((r) => trimTrailingEmptyCells_(r));
      }

      if (fastStoredValues) {
        const inMemoryRecord = {
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          sheet_role: "client",
          tab_name: tabName,
          values_grid: fullValues,
          formulas_grid: fullFormulas,
          notes_grid: { ...baseNotes },
          row_count: fullValues.length,
          col_count: maxCols,
          updated_at: new Date().toISOString(),
          _storedTemplateRowIdx: fastNextTplIdx ?? existing._storedTemplateRowIdx,
          _hasMigratedFormulasCol: true,
          _dbNotesJson: existing._dbNotesJson,
          _dbFormulasJson: existing._dbFormulasJson,
          _notesLoaded: existing._notesLoaded !== false,
          _persistedImmediate: Boolean(options.markPersistedImmediate),
          _persistedToDbImmediate: Boolean(options.markPersistedToDbImmediate || options.markPersistedImmediate),
        };
        delete inMemoryRecord.notes_grid.__formulas_grid;
        delete inMemoryRecord.notes_grid.__compact_meta;
        setGridMemoryCache_(cacheKey, inMemoryRecord);

        const { error: updErr } = await supabase
          .from("master_sheet_grids")
          .update({
            values_grid: fastStoredValues,
            row_count: fullValues.length,
            col_count: maxCols,
            updated_at: inMemoryRecord.updated_at,
          })
          .eq("client_name", ctx.clientName)
          .eq("sheet_role", dbSheetRole)
          .eq("tab_name", dbTabName);
        if (!updErr) return;
      }
    }

    const { storedValues, storedFormulas, storedNotes, totalRows } = compactClientTabForStorage_(
      tabName,
      fullValues,
      fullFormulas,
      baseNotes
    );
    const nextTplIdx = storedNotes.__compact_meta?.templateRowIdx;
    const nextNotesJson = JSON.stringify(storedNotes);
    const nextFormulasJson = JSON.stringify(storedFormulas);

    const inMemoryRecord = {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      sheet_role: "client",
      tab_name: tabName,
      values_grid: fullValues,
      formulas_grid: fullFormulas,
      notes_grid: { ...baseNotes },
      row_count: totalRows,
      col_count: maxCols,
      updated_at: new Date().toISOString(),
      _storedTemplateRowIdx: nextTplIdx ?? existing._storedTemplateRowIdx,
      _hasMigratedFormulasCol: true,
      _dbNotesJson: nextNotesJson,
      _dbFormulasJson: nextFormulasJson,
      _notesLoaded: true,
      _persistedImmediate: Boolean(options.markPersistedImmediate),
      _persistedToDbImmediate: Boolean(options.markPersistedToDbImmediate || options.markPersistedImmediate),
    };
    delete inMemoryRecord.notes_grid.__formulas_grid;
    delete inMemoryRecord.notes_grid.__compact_meta;

    setGridMemoryCache_(cacheKey, inMemoryRecord);

    if (!_useClientRoleFallback && existing._hasMigratedFormulasCol) {
      const updatePayload = {
        values_grid: storedValues,
        row_count: totalRows,
        col_count: maxCols,
        updated_at: inMemoryRecord.updated_at,
      };
      if (!existing._dbFormulasJson || nextFormulasJson !== existing._dbFormulasJson) {
        updatePayload.formulas_grid = storedFormulas;
      }
      if (!existing._dbNotesJson || nextNotesJson !== existing._dbNotesJson) {
        updatePayload.notes_grid = storedNotes;
      }
      const { error: updErr } = await supabase
        .from("master_sheet_grids")
        .update(updatePayload)
        .eq("client_name", ctx.clientName)
        .eq("sheet_role", dbSheetRole)
        .eq("tab_name", dbTabName);
      if (!updErr) return;
    }

    const payload = {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      sheet_role: dbSheetRole,
      tab_name: dbTabName,
      values_grid: storedValues,
      formulas_grid: storedFormulas,
      notes_grid: storedNotes,
      row_count: totalRows,
      col_count: maxCols,
      updated_at: inMemoryRecord.updated_at,
    };

    let { error: upsertErr } = await supabase.from("master_sheet_grids").upsert(payload, {
      onConflict: "client_name,sheet_role,tab_name",
    });

    if (upsertErr && !_useClientRoleFallback && upsertErr.message.includes("sheet_role")) {
      _useClientRoleFallback = true;
      payload.sheet_role = "master";
      payload.tab_name = `Client::${tabName}`;
      const retry = await supabase.from("master_sheet_grids").upsert(payload, {
        onConflict: "client_name,sheet_role,tab_name",
      });
      upsertErr = retry.error;
    }

    if (upsertErr) {
      throw new Error(`Supabase master_sheet_grids client upsert failed (${tabName}): ${upsertErr.message}`);
    }
    return;
  }

  if (sheetRole === "recon" && /^\d{4}$/.test(String(tabName || "").trim())) {
    recomputeReconTabFormulasSync_(valuesGrid);
  }

  const compactedValues =
    sheetRole === "master" && (tabName === "ConfCalcs" || tabName === "PipeCalcs")
      ? trimMasterCalcsGrid_(valuesGrid || [])
      : compactGrid2D(valuesGrid || []);
  const finalNotes = notesGrid || existing.notes_grid || {};
  const maxCols = compactedValues.reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0);

  const payload = {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    sheet_role: sheetRole,
    tab_name: tabName,
    values_grid: compactedValues,
    notes_grid: finalNotes,
    row_count: compactedValues.length,
    col_count: maxCols,
    updated_at: new Date().toISOString(),
    ...(sheetRole === "master" && tabName === "Year0Data" && Array.isArray(formulasGrid) && formulasGrid.length > 0
      ? { formulas_grid: compactGrid2D(formulasGrid) }
      : {}),
  };

  setGridMemoryCache_(cacheKey, { ...payload, formulas_grid: formulasGrid || existing.formulas_grid || compactedValues });

  if (options.memoryOnly) {
    return;
  }

  if (sheetRole === "master" && ctx.masterComputeMode === "native") {
    const {
      MASTER_COMP_TYPE_BY_TAB,
      syncMasterContextGridsToConfig,
      invalidateClientNativeMasterCompCache,
      computeAndPersistNativeMasterComparisons,
    } = await import("./nativeMasterComparisonService.js");
    if (
      tabName === "KeyInfo" ||
      tabName === "DataChgAlert" ||
      tabName === "PLAdds" ||
      Object.prototype.hasOwnProperty.call(MASTER_COMP_TYPE_BY_TAB, tabName)
    ) {
      await syncMasterContextGridsToConfig(ctx, { [tabName]: compactedValues });
      if (tabName === "KeyInfo") {
        await syncStructuredKeyInfoFromGrid_(ctx, valuesGrid).catch((e) =>
          console.warn("[masterEngineService] KeyInfo relational sync warning:", e.message)
        );
      }
      invalidateClientNativeMasterCompCache(ctx.clientName);
      if (
        tabName === "KeyInfo" ||
        tabName === "PLAdds" ||
        Object.prototype.hasOwnProperty.call(MASTER_COMP_TYPE_BY_TAB, tabName)
      ) {
        const masterTabDomainMap = {
          InvAppList: ["inv"],
          InvDashList: ["inv"],
          InvComp: ["inv"],
          JnlAppList: ["dir"],
          DirDashList: ["dir"],
          DirComp: ["dir"],
          Outgoings: ["dir"],
          CRMList: ["crm"],
          CRMComp: ["crm"],
          PLAdds: ["pl"],
          PLComp: ["pl"],
          TimeComp: ["time"],
        };
        const targetDomains = tabName === "KeyInfo" ? null : masterTabDomainMap[tabName] || null;
        await computeAndPersistNativeMasterComparisons(ctx, {
          source: "db",
          domains: targetDomains,
        }).catch((e) =>
          console.warn(`[masterEngineService] Native comparison refresh warning (${ctx.clientName}/${tabName}):`, e?.message)
        );
      }
      return;
    }
  }

  if (
    sheetRole === "master" &&
    ctx.connectorPullMode === "native" &&
    NATIVE_CONNECTOR_BYPASS_GRID_TABS.has(tabName)
  ) {
    if (
      tabName === "CRMGoogleBridge" ||
      tabName === "CRMExcelBridge" ||
      tabName === "CRMExcelCopy" ||
      tabName === "GasScriptProps"
    ) {
      const colPatch = {};
      if (tabName === "CRMGoogleBridge") colPatch.crm_google_bridge_grid = compactedValues;
      else if (tabName === "CRMExcelBridge") colPatch.crm_excel_bridge_grid = compactedValues;
      else if (tabName === "CRMExcelCopy") colPatch.crm_excel_copy_grid = compactedValues;
      else if (tabName === "GasScriptProps") {
        const spMap = {};
        for (let r = 1; r < compactedValues.length; r++) {
          const k = String(compactedValues[r]?.[0] ?? "").trim();
          if (k) spMap[k] = String(compactedValues[r]?.[1] ?? "");
        }
        colPatch.script_properties = spMap;
      }
      const { error: p6cErr } = await supabase
        .from("pulse_master_sync_configs")
        .upsert(
          { client_id: ctx.clientId, client_name: ctx.clientName, ...colPatch, updated_at: new Date().toISOString() },
          { onConflict: "client_id" }
        );
      if (p6cErr) throw new Error(`pulse_master_sync_configs upsert failed (${tabName}): ${p6cErr.message}`);
      return;
    }

    const headerColByPhase4Tab = {
      InvFromApp: "inv_headers",
      RevFromApp: "rev_headers",
      JnlsFromApp: "jnl_headers",
      PLFromApp: "pl_headers",
      Year0PLFromApp: "year0_pl_headers",
      DataFromCRM: "crm_raw_headers",
      DataFromTime: "time_data_headers",
      ProjectsFromTime: "time_projects_headers",
    };
    const headerCol = headerColByPhase4Tab[tabName];
    if (headerCol && Array.isArray(compactedValues?.[0]) && compactedValues[0].length > 0 && ctx.clientId) {
      try {
        const { error: hdrUpsertErr } = await supabase
          .from("pulse_master_sync_configs")
          .upsert(
            {
              client_id: ctx.clientId,
              client_name: ctx.clientName,
              [headerCol]: compactedValues[0].map((v) => String(v ?? "").trim()),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "client_id" }
          );
        if (hdrUpsertErr) {
          console.warn(`[masterEngineService] pulse_master_sync_configs header upsert warning (${tabName}):`, hdrUpsertErr.message);
        }
      } catch (_) { }
    }

    const { reconcileClientMasterIngestionFromGrids } = await import("./relationalMasterService.js");
    await reconcileClientMasterIngestionFromGrids(ctx, [tabName], {
      gridsOverride: { [tabName]: compactedValues },
      skipConfigUpsert: true,
    });
    return;
  }

  if (sheetRole === "master" && ctx.syncOrchestratorMode === "native") {
    const {
      MASTER_AUX_COL_BY_TAB,
      MASTER_TRANSIENT_CLIENT_MIRROR_TABS,
      replaceClientAutomationLogFromGrid,
      replaceClientExecutionLogsFromGrid,
      saveMasterAuxTabsToConfig,
    } = await import("./nativeSyncOrchestratorService.js");
    if (tabName === "AutoLog") {
      await replaceClientAutomationLogFromGrid(ctx, compactedValues);
      return;
    }
    if (tabName === "GasExecLogs") {
      await replaceClientExecutionLogsFromGrid(ctx, compactedValues);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(MASTER_AUX_COL_BY_TAB, tabName)) {
      await saveMasterAuxTabsToConfig(ctx, {
        [tabName]: { values_grid: compactedValues, formulas_grid: formulasGrid },
      });
      return;
    }
    if (MASTER_TRANSIENT_CLIENT_MIRROR_TABS.has(tabName)) {
      return;
    }
  }

  if (sheetRole === "recon" && ctx.syncOrchestratorMode === "native") {
    const { isManagedReconTab, reconcileClientReconFromGrids } = await import("./relationalReconService.js");
    if (isManagedReconTab(tabName)) {
      await reconcileClientReconFromGrids(ctx, [tabName], {
        recordsOverride: {
          [tabName]: {
            values_grid: compactedValues,
            formulas_grid: formulasGrid || compactedValues,
            notes_grid: finalNotes,
            row_count: compactedValues.length,
            col_count: maxCols,
          },
        },
      });
      return;
    }
  }

  if (ctx.gridStorageRetired && ctx.clientComputeMode === "native" && ctx.masterComputeMode === "native" && ctx.syncOrchestratorMode === "native") {
    return;
  }

  const { error: upsertErr } = await supabase.from("master_sheet_grids").upsert(payload, {
    onConflict: "client_name,sheet_role,tab_name",
  });
  if (upsertErr) {
    throw new Error(`Supabase master_sheet_grids upsert failed (${tabName}): ${upsertErr.message}`);
  }

  // Keep live tenant_key_info synchronized unconditionally; normalized recon/master ingestion uses Phase 4 lossless services
  if (sheetRole === "master" && tabName === "KeyInfo") {
    await syncStructuredKeyInfoFromGrid_(ctx, valuesGrid).catch((e) =>
      console.warn("[masterEngineService] KeyInfo relational sync warning:", e.message)
    );
  } else if (
    sheetRole === "recon" &&
    /^\d{4}$/.test(tabName) &&
    (options?.syncNormalizedMirrors || shouldSyncNormalizedMirrorTables())
  ) {
    if (ctx.reconMode === "relational") {
      const { reconcileClientReconFromGrids } = await import("./relationalReconService.js");
      await reconcileClientReconFromGrids(ctx, [tabName], {
        recordsOverride: {
          [tabName]: {
            values_grid: compactedValues,
            formulas_grid: formulasGrid || compactedValues,
            notes_grid: finalNotes,
            row_count: compactedValues.length,
            col_count: maxCols,
          },
        },
      }).catch((e) => console.warn("[masterEngineService] Recon Phase 4C sync warning:", e.message));
    } else {
      await syncReconPeriodAndItemsFromGrid_(ctx, tabName, valuesGrid).catch((e) =>
        console.warn("[masterEngineService] Recon relational sync warning:", e.message)
      );
    }
  }
}

function isNonFormulaKeyInfoOnlyUpdates_(updatesList) {
  if (!Array.isArray(updatesList) || updatesList.length === 0) return false;
  return updatesList.every((u) => {
    const p = u?.parsed || (u?.range ? parseA1Range(u.range) : null);
    return Boolean(p && p.tabName === "KeyInfo" && (p.startRow0 ?? 0) >= 119);
  });
}

/**
 * Mirrors Master KeyInfo or Budget cell writes onto the Client Sheet (when client_mode = 'sheet')
 * AND into the virtual Client Sheet in Supabase (when seeded or client_mode = 'supabase').
 */
async function mirrorMasterWriteToClientSheetIfNeeded_(ctx, rawSheetsApi, rangeUpdates) {
  if (!ctx) return;
  const clientDataUpdates = [];

  for (const item of rangeUpdates) {
    const parsed = parseA1Range(item.range);
    if (parsed.tabName === "KeyInfo") {
      // Only mirror cells inside KeyInfo!A1:AZ150 (skipping C1/D1/E1/G1 sheet URL pointers on row 1 cols C..G)
      const sRow = parsed.startRow0 ?? 0;
      const sCol = parsed.startCol0 ?? 0;
      if (sRow <= 150 && sCol <= 51) {
        if (sRow === 0 && sCol >= 2 && sCol <= 6) continue;
        clientDataUpdates.push({
          range: item.range,
          values: item.values,
          parsed,
        });
      }
    } else if (parsed.tabName === "Budget") {
      clientDataUpdates.push({
        range: item.range,
        values: item.values,
        parsed,
      });
    }
  }

  if (clientDataUpdates.length === 0) return;

  if (rawSheetsApi && ctx.clientSheetId && ctx.clientMode === "sheet") {
    try {
      await rawSheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId: ctx.clientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: clientDataUpdates.map(({ range, values }) => ({ range, values })),
        },
      });
    } catch (err) {
      console.warn(`[masterEngineService] Direct Client Sheet mirror warning (${ctx.clientName}):`, err.message);
    }
  }

  // Also mirror into virtual Client Sheet if client_mode === 'supabase'
  if (ctx.clientMode === "supabase") {
    try {
      const updatedTabs = new Set();
      for (const u of clientDataUpdates) {
        bumpTabWriteRevision_(ctx.clientName, "client", u.parsed.tabName);
        const rec = await getOrLoadVirtualTabGrid_(ctx, "client", u.parsed.tabName, rawSheetsApi);
        if (Array.isArray(rec.values_grid) && rec.values_grid.length > 0) {
          const nextVals = applyWriteToGrid2D_(rec.values_grid, u.parsed, u.values, {
            sheetRole: "client",
            tabName: u.parsed.tabName,
            valueInputOption: "USER_ENTERED",
            notesGrid: rec.notes_grid,
            isFormulaGrid: false,
          });
          const nextForms = applyWriteToGrid2D_(rec.formulas_grid || rec.values_grid, u.parsed, u.values, {
            sheetRole: "client",
            tabName: u.parsed.tabName,
            valueInputOption: "USER_ENTERED",
            notesGrid: rec.notes_grid,
            isFormulaGrid: true,
          });
          await saveVirtualTabGrid_(ctx, "client", u.parsed.tabName, nextVals, nextForms, rec.notes_grid, {
            memoryOnly:
              !isNonFormulaKeyInfoOnlyUpdates_(clientDataUpdates) &&
              !["Sessions", "AppLog", "Welcome", "OutgNotes"].includes(u.parsed.tabName),
          });
          updatedTabs.add(u.parsed.tabName);
        }
      }
      if (updatedTabs.size > 0) {
        if (isNonFormulaKeyInfoOnlyUpdates_(clientDataUpdates)) {
          await syncPhase5FinancialsIfEnabled_(ctx, ["KeyInfo"]);
          await import("./cacheService.js")
            .then(({ invalidatePmaClientCache }) => invalidatePmaClientCache(ctx.clientSheetId, ctx.masterSheetId))
            .catch(() => { });
        } else {
          const clientCtx = { ...ctx, sheetRole: "client" };
          await recomputeAndPersistImmediateClientTabs_(clientCtx, [...updatedTabs], rawSheetsApi, {
            deferBackgroundRecompute: false,
          });
        }
        if (ctx.sheetBridgeMode && ctx.sheetBridgeMode !== "off") {
          import("./clientSheetBridgeService.js")
            .then(({ scheduleOutboundSheetBridgeSync }) =>
              scheduleOutboundSheetBridgeSync(ctx.clientName, [...updatedTabs])
            )
            .catch(() => { });
        }
      }
    } catch (err) {
      console.warn(`[masterEngineService] Virtual Client Sheet mirror warning (${ctx.clientName}):`, err.message);
    }
  }
}

function hashTabNameToSheetId_(tabName) {
  let h = 1000;
  const s = String(tabName || "");
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) & 0x3fffffff;
  }
  return h;
}

const CASH_GRAY_ROWS = new Set([6, 8, 10, 12, 14, 16, 19, 21, 24, 26, 28, 29, 35]);
const CASH_CREAM_R18_60_COLS = new Set([2, 9, 10, 31, 32, 33, 34, 35, 36]);
const CASH_CREAM_R20_COLS = new Set([19, 20, 23, 25]);
const CASH_CREAM_R62_COLS = new Set([2, 19, 20]);

function getCashEffectiveFormat_(r0, c0) {
  const isBold =
    r0 === 0 ||
    r0 === 3 ||
    r0 === 33 ||
    r0 === 44 ||
    r0 === 75 ||
    (c0 === 0 && (r0 === 1 || r0 === 35 || r0 === 42));

  let bg = { red: 1, green: 1, blue: 1 };
  if (r0 === 0 && c0 <= 36) {
    bg = { red: 56 / 255, green: 118 / 255, blue: 29 / 255 };
  } else if ((r0 === 33 || r0 === 75) && c0 <= 36) {
    bg = { red: 207 / 255, green: 226 / 255, blue: 243 / 255 };
  } else if (CASH_GRAY_ROWS.has(r0) && c0 >= 1 && c0 <= 36) {
    bg = { red: 239 / 255, green: 239 / 255, blue: 239 / 255 };
  } else if (r0 === 3) {
    if (c0 === 1) bg = { red: 1, green: 1, blue: 0 };
    else if (c0 === 10 || c0 === 11) bg = { red: 234 / 255, green: 209 / 255, blue: 220 / 255 };
  } else if ((r0 === 7 || r0 === 11 || r0 === 15) && c0 === 1) {
    bg = { red: 1, green: 1, blue: 0 };
  } else if (r0 === 18 || r0 === 60) {
    if (c0 === 1) bg = { red: 1, green: 1, blue: 0 };
    else if (CASH_CREAM_R18_60_COLS.has(c0)) bg = { red: 1, green: 242 / 255, blue: 204 / 255 };
  } else if (r0 === 20) {
    if (c0 === 1 || c0 === 2) bg = { red: 1, green: 1, blue: 0 };
    else if (CASH_CREAM_R20_COLS.has(c0)) bg = { red: 1, green: 242 / 255, blue: 204 / 255 };
  } else if (r0 === 44 && (c0 === 1 || c0 === 10 || c0 === 11)) {
    bg = { red: 234 / 255, green: 209 / 255, blue: 220 / 255 };
  } else if (r0 === 62) {
    if (c0 === 1) bg = { red: 1, green: 1, blue: 0 };
    else if (CASH_CREAM_R62_COLS.has(c0)) bg = { red: 1, green: 242 / 255, blue: 204 / 255 };
  }

  return {
    backgroundColor: bg,
    textFormat: { bold: isBold },
  };
}

export async function recomputeMasterFormulasForTabs(ctx, updatedTabNames = [], rawSheetsApi = null) {
  return recomputeMasterFormulasAfterVirtualWrite_(ctx, updatedTabNames, rawSheetsApi);
}

async function recomputeMasterFormulasAfterVirtualWrite_(ctx, updatedTabNames, rawSheetsApi) {
  const tabsSet = new Set(updatedTabNames);
  const needsCrm =
    tabsSet.has("CRMComp") ||
    tabsSet.has("DataFromCRM") ||
    tabsSet.has("CRMList") ||
    tabsSet.has("KeyInfo") ||
    tabsSet.has("ConfCalcs") ||
    tabsSet.has("PipeCalcs");
  const needsPl =
    tabsSet.has("PLComp") ||
    tabsSet.has("PLFromApp") ||
    tabsSet.has("Year0PLFromApp") ||
    tabsSet.has("PLAdds") ||
    tabsSet.has("KeyInfo") ||
    tabsSet.has("Outgoings");
  const needsInv =
    tabsSet.has("InvFromApp") ||
    tabsSet.has("InvAppList") ||
    tabsSet.has("InvDashList") ||
    tabsSet.has("InvComp") ||
    tabsSet.has("ConfCalcs") ||
    tabsSet.has("KeyInfo");
  const needsDir =
    tabsSet.has("JnlsFromApp") ||
    tabsSet.has("JnlAppList") ||
    tabsSet.has("DirDashList") ||
    tabsSet.has("DirComp") ||
    tabsSet.has("ConfCalcs") ||
    tabsSet.has("Outgoings") ||
    tabsSet.has("OutgNotes") ||
    tabsSet.has("KeyInfo");
  const needsYear0 =
    tabsSet.has("Year0PLFromApp") ||
    tabsSet.has("Year0Data") ||
    tabsSet.has("KeyInfo");
  const needsTime =
    tabsSet.has("DataFromTime") ||
    tabsSet.has("TimeComp") ||
    tabsSet.has("KeyInfo");

  if (!needsCrm && !needsPl && !needsInv && !needsDir && !needsYear0 && !needsTime) return;

  const masterTabsNeeded = new Set(["KeyInfo", "DataChgAlert"]);
  if (needsCrm) {
    ["DataFromCRM", "CRMList", "CRMComp", "ConfCalcs", "PipeCalcs"].forEach((t) => masterTabsNeeded.add(t));
  }
  if (needsPl) {
    ["Outgoings", "PLFromApp", "Year0PLFromApp", "PLAdds", "PLComp", "InvFromApp", "JnlsFromApp", "CRMList"].forEach((t) =>
      masterTabsNeeded.add(t)
    );
  }
  if (needsInv) {
    ["InvFromApp", "InvAppList", "InvDashList", "InvComp", "ConfCalcs"].forEach((t) => masterTabsNeeded.add(t));
  }
  if (needsDir) {
    ["JnlsFromApp", "JnlAppList", "DirDashList", "DirComp", "ConfCalcs", "Outgoings", "OutgNotes"].forEach((t) =>
      masterTabsNeeded.add(t)
    );
  }
  if (needsYear0) {
    ["Year0Data", "Year0PLFromApp"].forEach((t) => masterTabsNeeded.add(t));
  }
  if (needsTime) {
    ["TimeComp", "DataFromTime"].forEach((t) => masterTabsNeeded.add(t));
  }

  const grids = Object.create(null);
  const recordsByTab = {};
  const clientKey = String(ctx.clientName || "").toLowerCase();
  const missingMasterTabs = [];
  let nativeCompTabsSet = null;
  if (ctx.masterComputeMode === "native") {
    try {
      const { MASTER_COMP_TYPE_BY_TAB } = await import("./nativeMasterComparisonService.js");
      nativeCompTabsSet = new Set([
        "KeyInfo",
        "DataChgAlert",
        "PLAdds",
        ...Object.keys(MASTER_COMP_TYPE_BY_TAB || {}),
      ]);
    } catch { }
  }
  for (const t of masterTabsNeeded) {
    const cached = _gridMemoryCache.get(`${clientKey}::master::${t}`);
    if (cached && cached.expiresAt > Date.now() && !cached.record._valuesOnlyLoaded) {
      recordsByTab[t] = cached.record;
    } else if (ctx.masterReadMode === "relational" && PHASE4_MASTER_TAB_SET_.has(t)) {
      // Phase 4 relational tables are loaded via getOrLoadVirtualTabGrid_ below
      continue;
    } else if (nativeCompTabsSet && nativeCompTabsSet.has(t)) {
      // Phase 6B native master context & comparison tabs are loaded via getOrLoadVirtualTabGrid_ below
      continue;
    } else {
      missingMasterTabs.push(t);
    }
  }
  const supabase = getSupabaseAdmin();
  if (missingMasterTabs.length > 0 && supabase) {
    const { data: mRows } = await supabase
      .from("master_sheet_grids")
      .select("id, client_id, client_name, sheet_role, tab_name, values_grid, notes_grid, row_count, col_count")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .in("tab_name", missingMasterTabs);
    for (const r of mRows || []) {
      r.values_grid = compactGrid2D(r.values_grid || []);
      r.formulas_grid = r.values_grid;
      recordsByTab[r.tab_name] = r;
      setGridMemoryCache_(`${clientKey}::master::${r.tab_name}`, r);
    }
  }
  for (const t of masterTabsNeeded) {
    const rec = recordsByTab[t] || (await getOrLoadVirtualTabGrid_(ctx, "master", t, rawSheetsApi));
    recordsByTab[t] = rec;
    grids[t] = Array.isArray(rec.values_grid) ? rec.values_grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];
  }

  if (needsPl && ctx.reconSheetId) {
    const reconPlAdds = await getOrLoadVirtualTabGrid_(ctx, "recon", "PLAdds", rawSheetsApi);
    if (Array.isArray(reconPlAdds.values_grid) && reconPlAdds.values_grid.length > 0) {
      grids.ReconPLAdds = reconPlAdds.values_grid;
    }
  }

  const watchedKeyInfoCells = [
    { range: "KeyInfo!E21", r: 20, c: 4 },
    { range: "KeyInfo!I29", r: 28, c: 8 },
    { range: "KeyInfo!E2", r: 1, c: 4 },
    { range: "KeyInfo!F2", r: 1, c: 5 },
    { range: "KeyInfo!B4", r: 3, c: 1 },
    { range: "KeyInfo!E6", r: 5, c: 4 },
    { range: "KeyInfo!F6", r: 5, c: 5 },
    { range: "KeyInfo!B7", r: 6, c: 1 },
    { range: "KeyInfo!D9", r: 8, c: 3 },
  ];
  const prevKeyInfoVals = watchedKeyInfoCells.map((cell) => grids.KeyInfo?.[cell.r]?.[cell.c] ?? "");

  const masterSnapCache = new Map();
  const snapMaster_ = (t) => {
    if (!masterSnapCache.has(t)) {
      masterSnapCache.set(t, JSON.stringify(grids[t] || []));
    }
    return masterSnapCache.get(t);
  };

  const dirtyCandidates = new Set();
  if (needsCrm) {
    snapMaster_("CRMList");
    snapMaster_("CRMComp");
    evaluateCRMList(grids);
    evaluateCRMComp(grids);
    dirtyCandidates.add("CRMList");
    dirtyCandidates.add("CRMComp");
  }
  if (needsPl || needsCrm || needsYear0) {
    if (tabsSet.has("KeyInfo") || tabsSet.has("Outgoings")) {
      snapMaster_("Outgoings");
      evaluateOutgoingsMasterTab(grids);
      dirtyCandidates.add("Outgoings");
    }
    snapMaster_("KeyInfo");
    if (needsPl) snapMaster_("PLComp");
    evaluateKeyInfoAndPLComp(grids, { clientSheetId: ctx?.clientSheetId || "" });
    dirtyCandidates.add("KeyInfo");
    if (needsPl) dirtyCandidates.add("PLComp");
  }
  if (needsYear0 && grids.Year0Data?.length > 0) {
    snapMaster_("Year0Data");
    evaluateYear0Data(grids);
    dirtyCandidates.add("Year0Data");
  }
  if (needsTime && grids.TimeComp?.length > 0) {
    snapMaster_("TimeComp");
    evaluateTimeComp(grids);
    dirtyCandidates.add("TimeComp");
  }
  if (needsInv) {
    snapMaster_("InvAppList");
    snapMaster_("InvDashList");
    snapMaster_("InvComp");
    evaluateInvAppList(grids);
    evaluateInvDashList(grids);
    evaluateInvComp(grids);
    dirtyCandidates.add("InvAppList");
    dirtyCandidates.add("InvDashList");
    dirtyCandidates.add("InvComp");
  }
  if (needsDir) {
    snapMaster_("JnlAppList");
    snapMaster_("DirDashList");
    snapMaster_("DirComp");
    evaluateJnlAppList(grids);
    evaluateDirDashList(grids);
    evaluateDirComp(grids);
    dirtyCandidates.add("JnlAppList");
    dirtyCandidates.add("DirDashList");
    dirtyCandidates.add("DirComp");
  }

  const changedMasterTabs = [...dirtyCandidates].filter(
    (t) => JSON.stringify(grids[t] || []) !== masterSnapCache.get(t)
  );

  if (changedMasterTabs.length > 0) {
    await Promise.all(
      changedMasterTabs.map((t) => {
        const origRec = recordsByTab[t] || {};
        return saveVirtualTabGrid_(ctx, "master", t, grids[t] || [], origRec.formulas_grid, origRec.notes_grid);
      })
    );
    await syncPhase4MasterIngestionIfEnabled_(ctx, changedMasterTabs);
  }

  const mirrorUpdates = [];
  watchedKeyInfoCells.forEach((cell, idx) => {
    const nextVal = grids.KeyInfo?.[cell.r]?.[cell.c] ?? "";
    if (nextVal !== prevKeyInfoVals[idx]) {
      mirrorUpdates.push({ range: cell.range, values: [[nextVal]] });
    }
  });
  if (mirrorUpdates.length > 0) {
    await mirrorMasterWriteToClientSheetIfNeeded_(ctx, rawSheetsApi, mirrorUpdates);
  }
}

const _pendingClientTabsByClient = new Map();
const _pendingClientCtxByClient = new Map();
const _inFlightClientRecomputeByClient = new Map();
const _unpersistedSkippedClientTabsByClient = new Map();
const _pendingNotesChangedTabsByClient = new Map();
const _pendingAllowClearAllNotesTabsByClient = new Map();
const _activeRecomputeSourceTabsByClient = new Map();

function hasPendingOrInFlightClientRecompute_(clientNameOrKey) {
  const key = String(clientNameOrKey || "").toLowerCase();
  if (!key) return false;
  const pendingSet = _pendingClientTabsByClient.get(key);
  const unpersistedSet = _unpersistedSkippedClientTabsByClient.get(key);
  return Boolean(
    (pendingSet && pendingSet.size > 0) ||
    (unpersistedSet && unpersistedSet.size > 0) ||
    _inFlightClientRecomputeByClient.has(key)
  );
}

function hasFormulaCellsChanged_(prevFormulas, nextFormulas) {
  const maxR = Math.max(
    Array.isArray(prevFormulas) ? prevFormulas.length : 0,
    Array.isArray(nextFormulas) ? nextFormulas.length : 0
  );
  for (let r = 0; r < maxR; r++) {
    const rA = prevFormulas?.[r] || [];
    const rB = nextFormulas?.[r] || [];
    if (rA === rB) continue;
    const maxC = Math.max(rA.length, rB.length);
    for (let c = 0; c < maxC; c++) {
      const fA = typeof rA[c] === "string" && rA[c].startsWith("=") ? rA[c] : "";
      const fB = typeof rB[c] === "string" && rB[c].startsWith("=") ? rB[c] : "";
      if (fA !== fB) return true;
    }
  }
  return false;
}

function snapshotClientValuesForDiff_(tabName, vals) {
  if (!Array.isArray(vals)) return "[]";
  let targetRows = vals;
  if (
    (tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs") &&
    vals.length > 350
  ) {
    const minDef = tabName === "Confirmed" || tabName === "ConfCalcs" ? 295 : 105;
    const activeRow = findLastActiveClientJobRow_(vals, minDef);
    const tplIdx = Math.min(vals.length - 2, activeRow + 2);
    targetRows = [...vals.slice(0, tplIdx + 1), vals[vals.length - 1] || []];
  }
  return JSON.stringify(targetRows.map((r) => trimTrailingEmptyCells_(r)));
}

function queuePendingClientTabs_(
  clientNameOrCtx,
  tabNames,
  { isSkippedStep = false, notesChangedTabs = null, allowClearAllNotesTabs = null } = {}
) {
  const clientName = typeof clientNameOrCtx === "object" ? clientNameOrCtx?.clientName : clientNameOrCtx;
  const key = String(clientName || "").toLowerCase();
  if (!key) return;
  if (typeof clientNameOrCtx === "object" && clientNameOrCtx) {
    const prevCtx = _pendingClientCtxByClient.get(key);
    if (prevCtx) {
      _pendingClientCtxByClient.set(key, {
        ...clientNameOrCtx,
        _suppressBridgeOutbound: Boolean(prevCtx._suppressBridgeOutbound && clientNameOrCtx._suppressBridgeOutbound),
      });
    } else {
      _pendingClientCtxByClient.set(key, clientNameOrCtx);
    }
  }
  let set = _pendingClientTabsByClient.get(key);
  if (!set) {
    set = new Set();
    _pendingClientTabsByClient.set(key, set);
  }
  for (const t of tabNames) {
    if (t) set.add(t);
  }
  if (isSkippedStep) {
    let unpersisted = _unpersistedSkippedClientTabsByClient.get(key);
    if (!unpersisted) {
      unpersisted = new Set();
      _unpersistedSkippedClientTabsByClient.set(key, unpersisted);
    }
    for (const t of tabNames) {
      if (t) unpersisted.add(t);
    }
  }
  if (notesChangedTabs) {
    let notesSet = _pendingNotesChangedTabsByClient.get(key);
    if (!notesSet) {
      notesSet = new Set();
      _pendingNotesChangedTabsByClient.set(key, notesSet);
    }
    for (const t of notesChangedTabs) {
      if (t) notesSet.add(t);
    }
  }
  if (allowClearAllNotesTabs) {
    let clearSet = _pendingAllowClearAllNotesTabsByClient.get(key);
    if (!clearSet) {
      clearSet = new Set();
      _pendingAllowClearAllNotesTabsByClient.set(key, clearSet);
    }
    for (const t of allowClearAllNotesTabs) {
      if (t) clearSet.add(t);
    }
  }
}

function scheduleBackgroundClientRecompute_(ctx, rawSheetsApi = null) {
  // Yield briefly so the active HTTP response flushes, then let any fast
  // debounced outbound Google Sheet push finish before CPU-bound HyperFormula runs.
  const bgPromise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 75));
    if (
      ctx?.clientMode === "supabase" &&
      !ctx._suppressBridgeOutbound &&
      ctx?.sheetBridgeMode &&
      ctx.sheetBridgeMode !== "off"
    ) {
      try {
        const { waitForPendingOutboundSheetBridge } = await import("./clientSheetBridgeService.js");
        await Promise.race([
          waitForPendingOutboundSheetBridge(ctx.clientName),
          new Promise((resolve) => setTimeout(resolve, 8000)),
        ]);
      } catch { }
    }
    await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi);
  })().catch((e) =>
    console.warn("[masterEngineService] Background client formula recompute warning:", e.message)
  );
  try {
    waitUntil(bgPromise);
  } catch {
    // Outside Vercel request context, bgPromise continues running asynchronously
  }
  return bgPromise;
}

export async function flushPendingClientRecomputes(rawSheetsApi = null, clientName = null) {
  const keys = clientName
    ? [String(clientName).toLowerCase()]
    : [
      ...new Set([
        ..._pendingClientTabsByClient.keys(),
        ..._unpersistedSkippedClientTabsByClient.keys(),
        ..._inFlightClientRecomputeByClient.keys(),
      ]),
    ];
  for (const key of keys) {
    const ctx = _pendingClientCtxByClient.get(key);
    if (hasPendingOrInFlightClientRecompute_(key) && ctx) {
      await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
        console.warn("[masterEngineService] Deferred client formula recompute warning:", e.message)
      );
    }
  }
}

/**
 * Interactive request flush: synchronously persists only any immediate input tabs
 * (_unpersistedSkippedClientTabsByClient, ~1s) and ensures downstream multi-tab
 * formula recalculation runs in the background via Vercel waitUntil instead of blocking
 * interactive HTTP responses for ~40s.
 */
const _inFlightImmediateClientFlushByClient = new Map();

export async function flushImmediateAndScheduleBackgroundClientRecomputes(rawSheetsApi = null, clientName = null) {
  const keys = clientName
    ? [String(clientName).toLowerCase()]
    : [
      ...new Set([
        ..._unpersistedSkippedClientTabsByClient.keys(),
        ..._inFlightImmediateClientFlushByClient.keys(),
        ..._pendingClientTabsByClient.keys(),
      ]),
    ];
  for (const key of keys) {
    const inFlight = _inFlightImmediateClientFlushByClient.get(key);
    const ctx = _pendingClientCtxByClient.get(key);
    const unpersistedSet = _unpersistedSkippedClientTabsByClient.get(key);
    if (inFlight || (unpersistedSet && unpersistedSet.size > 0)) {
      if (ctx) {
        await recomputeAndPersistImmediateClientTabs_(ctx, [], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Immediate client flush warning:", e.message)
        );
      } else if (inFlight) {
        await inFlight.catch(() => { });
      }
      continue;
    }
    const pendingSet = _pendingClientTabsByClient.get(key);
    if (ctx && pendingSet && pendingSet.size > 0 && !_inFlightClientRecomputeByClient.has(key)) {
      scheduleBackgroundClientRecompute_(ctx, rawSheetsApi);
    }
  }
}

const DIRECT_INPUT_CLIENT_TABS = new Set([
  "Confirmed",
  "Pipeline",
  "KeyInfo",
  "Sessions",
  "AppLog",
  "Welcome",
]);

const FULLY_SELF_CONTAINED_CLIENT_TABS = new Set([
  "Confirmed",
  "Pipeline",
  "KeyInfo",
  "Salaries",
]);

function doesClientRangeNeedFormulaFlush_(parsed, clientName = "") {
  if (!parsed || !parsed.tabName) return false;
  const key = String(clientName || "").toLowerCase();
  const unpersistedSkipped = key ? _unpersistedSkippedClientTabsByClient.get(key) : null;
  if (unpersistedSkipped && unpersistedSkipped.has(parsed.tabName)) {
    return true;
  }
  if (DIRECT_INPUT_CLIENT_TABS.has(parsed.tabName)) return false;

  const sourceTabs = key ? _activeRecomputeSourceTabsByClient.get(key) : null;

  if (parsed.tabName === "Salaries") {
    // Salaries only depends on KeyInfo and itself, and is 100% evaluated immediately in Step 1
    if (!sourceTabs || !sourceTabs.has("KeyInfo")) {
      return false;
    }
    const sR = parsed.startRow0 ?? 0;
    const eR = parsed.endRow0 ?? 999;
    return eR >= 54 || sR >= 54;
  }

  if (parsed.tabName === "Outgoings") {
    const sR = parsed.startRow0 ?? 0;
    const eR = parsed.endRow0 ?? 999;
    // Rows 225..226 in Col E (E225:E226) contain formulas (=E226 and =IF(KeyInfo!$D$21=..., 1, ...)),
    // while Columns A..D contain static labels/dropdowns.
    const touchesRechargedRows = sR <= 227 && eR >= 224;
    if (parsed.endCol0 !== null && parsed.endCol0 !== undefined && parsed.endCol0 <= 4) {
      return Boolean(
        sR <= 225 &&
        eR >= 224 &&
        parsed.endCol0 >= 4 &&
        (!sourceTabs || sourceTabs.has("KeyInfo") || sourceTabs.has("Outgoings"))
      );
    }
    // In Outgoings, Rows 12..110 (direct costs), Rows 118..121 (Dividends in lieu of salary),
    // and Rows 126..224 (Expenses) only depend on Outgoings and KeyInfo,
    // which are already evaluated in Step 1.
    // Rows 225..228 (Recharged expenses rows & Overheads subtotals) depend on Confirmed, KeyInfo & Performance.
    // Rows 6..9 (Salaries/Performance), Row 111 (Making up CoS from Dashboard),
    // and Rows 233+ (Bonus & Grand Total Overheads) depend on other tabs.
    const touchesRow111 = sR <= 110 && eR >= 110;
    const touchesBottomSummaries = eR >= 232 || sR >= 232;
    const touchesStaffSummaries = sR <= 8 && eR >= 5 && Boolean(sourceTabs && (sourceTabs.has("Salaries") || sourceTabs.has("KeyInfo")));
    const touchesRechargedDeps =
      touchesRechargedRows &&
      (!sourceTabs || sourceTabs.has("Confirmed") || sourceTabs.has("KeyInfo") || sourceTabs.has("Outgoings"));
    return touchesRow111 || touchesBottomSummaries || touchesStaffSummaries || touchesRechargedDeps;
  }

  if (parsed.tabName === "NBtoFind") {
    // When only NBtoFind was edited, all NBtoFind formulas were already evaluated in Step 1
    if (sourceTabs && sourceTabs.size === 1 && sourceTabs.has("NBtoFind")) {
      return false;
    }
    return true;
  }

  if (parsed.tabName === "Cash") {
    // When only Cash was edited, all Cash formulas were already evaluated in Step 1
    if (sourceTabs && sourceTabs.size === 1 && sourceTabs.has("Cash")) {
      return false;
    }
    return true;
  }

  if (parsed.tabName === "Budget") {
    if (sourceTabs && sourceTabs.size === 1 && sourceTabs.has("Budget")) {
      return false;
    }
    return true;
  }

  return true;
}

function remapNotesGridRows_(notesGrid, mapRowFn) {
  if (!notesGrid || typeof notesGrid !== "object") return Object.create(null);
  const next = Object.create(null);
  for (const [k, v] of Object.entries(notesGrid)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (k === "__bg_colors" && v && typeof v === "object") {
      const remappedColors = Object.create(null);
      for (const [ck, cv] of Object.entries(v)) {
        if (ck === "__proto__" || ck === "constructor" || ck === "prototype") continue;
        const cColon = ck.indexOf(":");
        if (cColon < 0) continue;
        const oldR0 = Number(ck.slice(0, cColon));
        const cPart = ck.slice(cColon + 1);
        if (!Number.isInteger(oldR0)) continue;
        const newR0 = mapRowFn(oldR0);
        if (newR0 >= 0) {
          remappedColors[`${newR0}:${cPart}`] = cv;
        }
      }
      next.__bg_colors = remappedColors;
      continue;
    }
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
  return next;
}

const _lastClientEditTimestampMap = new Map();

export function getLastClientEditTimestamp(clientName) {
  if (!clientName) return 0;
  return _lastClientEditTimestampMap.get(String(clientName).trim().toLowerCase()) || 0;
}

function formulaRefsMissingSheetInMap_(f, currentTab, loadedMap) {
  if (typeof f !== "string" || !f.includes("!")) return false;
  const stripped = f.replace(/"(?:""|[^"])*"/g, "");
  const hasTab = (name) =>
    loadedMap instanceof Set ? loadedMap.has(name) : Boolean(loadedMap && loadedMap[name]);
  const matches = stripped.matchAll(/(?:'([^']+)'|([A-Za-z0-9_]+))!/g);
  for (const m of matches) {
    const refTab = m[1] || m[2];
    if (refTab && refTab !== currentTab && refTab !== "REF" && !hasTab(refTab)) {
      return true;
    }
  }
  return false;
}

const CORE_CLIENT_FORMULA_TABS_SET = new Set([
  ...CORE_CLIENT_TABS,
  "REF",
  "AppData",
  "FormCheck",
]);

async function loadReferencedReconGridsForClientFormulas_(ctx, formulaGrids, rawSheetsApi = null) {
  const reconTabs = new Set();
  const rx = /IMPORTRANGE\s*\(\s*(?:KeyInfo!)?\$?G\$?1\s*,\s*"([^"]+)"/gi;
  for (const fGrid of formulaGrids || []) {
    if (!Array.isArray(fGrid)) continue;
    for (let r = 0; r < fGrid.length; r++) {
      const row = fGrid[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length; c++) {
        const f = row[c];
        if (typeof f !== "string" || !f.includes("!") || !/IMPORTRANGE/i.test(f)) continue;
        rx.lastIndex = 0;
        let m;
        while ((m = rx.exec(f)) !== null) {
          const refRange = m[1] || "";
          const bang = refRange.indexOf("!");
          if (bang > 0) {
            const tabName = refRange.slice(0, bang).trim().replace(/^'|'$/g, "");
            if (tabName) reconTabs.add(tabName);
          }
        }
      }
    }
  }
  if (reconTabs.size === 0) return null;
  const out = Object.create(null);
  if (ctx?.reconReadMode === "relational") {
    try {
      const {
        isManagedReconTab,
        preloadClientRelationalReconBundle,
        reconstructRelationalReconTabFromBundle,
      } = await import("./relationalReconService.js");
      const bundle = await preloadClientRelationalReconBundle(ctx, { source: "db" });
      for (const tabName of reconTabs) {
        if (!isManagedReconTab(tabName)) continue;
        const relRec = reconstructRelationalReconTabFromBundle(bundle, tabName);
        if (relRec && Array.isArray(relRec.values_grid)) {
          out[tabName] = { values: relRec.values_grid };
        }
      }
    } catch { }
  }
  const missingReconTabs = [...reconTabs].filter((t) => !out[t]);
  if (missingReconTabs.length > 0) {
    await Promise.all(
      missingReconTabs.map(async (tabName) => {
        const rec = await getOrLoadVirtualTabGrid_(ctx, "recon", tabName, rawSheetsApi, {
          valuesOnly: true,
        }).catch(() => null);
        if (rec && Array.isArray(rec.values_grid)) {
          out[tabName] = { values: rec.values_grid };
        }
      })
    );
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function syncPhase2RelationalJobsIfEnabled_(ctx, tabNames = [], preloadedGrids = null) {
  if (!ctx || ctx.jobsMode !== "relational") return;
  const mapped = [];
  for (const t of Array.isArray(tabNames) ? tabNames : []) {
    if (t === "Confirmed" || t === "ConfCalcs") mapped.push("Confirmed");
    else if (t === "Pipeline" || t === "PipeCalcs") mapped.push("Pipeline");
  }
  const relevant = [...new Set(mapped)];
  if (relevant.length === 0) return;
  try {
    const { reconcileClientRelationalJobsFromGrids } = await import("./relationalJobsService.js");
    await reconcileClientRelationalJobsFromGrids(
      ctx,
      relevant,
      preloadedGrids ? { preloadedGrids } : {}
    );
    const { invalidateClientRelationalMasterCache } = await import("./relationalMasterService.js");
    invalidateClientRelationalMasterCache(ctx.clientName);
  } catch (err) {
    console.warn(`[masterEngineService] Phase 2 relational job reconciliation warning (${ctx.clientName}):`, err?.message);
  }
}

const PHASE3_INPUT_TAB_SET_ = new Set(["Salaries", "Outgoings", "OutgNotes", "NBtoFind", "Budget", "Cash"]);

async function syncPhase3OperatingInputsIfEnabled_(
  ctx,
  tabNames = [],
  preloadedGrids = null,
  { allowClearAllNotes = false } = {}
) {
  if (!ctx || ctx.inputsMode !== "relational") return;
  const relevant = [...new Set((Array.isArray(tabNames) ? tabNames : []).filter((t) => PHASE3_INPUT_TAB_SET_.has(t)))];
  if (relevant.length === 0) return;
  try {
    const { reconcileClientOperatingInputsFromGrids } = await import("./relationalInputsService.js");
    await reconcileClientOperatingInputsFromGrids(
      ctx,
      relevant,
      {
        ...(preloadedGrids ? { preloadedGrids } : {}),
        ...(allowClearAllNotes ? { allowClearAllNotes: true } : {}),
      }
    );
    const { invalidateClientRelationalMasterCache } = await import("./relationalMasterService.js");
    invalidateClientRelationalMasterCache(ctx.clientName);
  } catch (err) {
    console.warn(`[masterEngineService] Phase 3 relational inputs reconciliation warning (${ctx.clientName}):`, err?.message);
  }
}

const PHASE5_FINANCIAL_TAB_SET_ = new Set([
  "Calcs",
  "Year0Data",
  "Performance",
  "Dashboard",
  "GPbyPL",
  "VAT",
  "Cash",
  "ErrorCheck",
  "KeyInfo",
]);

async function syncPhase5FinancialsIfEnabled_(ctx, tabNames = [], preloadedGrids = null) {
  if (!ctx) return;
  try {
    const {
      invalidateClientRelationalFinancialsCache,
      reconcileClientFinancialsFromGrids,
    } = await import("./relationalFinancialsService.js");
    invalidateClientRelationalFinancialsCache(ctx.clientName);
    if (ctx.financialsMode !== "relational") return;
    const relevant = [...new Set((Array.isArray(tabNames) ? tabNames : []).filter((t) => PHASE5_FINANCIAL_TAB_SET_.has(t)))];
    if (relevant.length === 0) return;
    await reconcileClientFinancialsFromGrids(
      ctx,
      relevant,
      preloadedGrids ? { preloadedGrids } : {}
    );
  } catch (err) {
    console.warn(`[masterEngineService] Phase 5 relational financials reconciliation warning (${ctx.clientName}):`, err?.message);
  }
}

const PHASE4_MASTER_TAB_SET_ = new Set([
  "InvFromApp",
  "RevFromApp",
  "JnlsFromApp",
  "PLFromApp",
  "Year0PLFromApp",
  "DataFromCRM",
  "DataFromTime",
  "ProjectsFromTime",
  "CRMList",
  "CRMComp",
  "InvAppList",
  "InvDashList",
  "InvComp",
  "JnlAppList",
  "DirDashList",
  "DirComp",
  "PLComp",
  "TimeComp",
]);

async function syncPhase4MasterIngestionIfEnabled_(ctx, tabNames = []) {
  if (!ctx) return;
  const list = Array.isArray(tabNames) ? tabNames : [];
  if (list.includes("KeyInfo")) {
    import("./relationalMasterService.js")
      .then(({ invalidateClientRelationalMasterCache }) => invalidateClientRelationalMasterCache(ctx.clientName))
      .catch(() => { });
  }
  if (ctx.masterIngestionMode !== "relational") return;
  const relevant = [...new Set(list.filter((t) => PHASE4_MASTER_TAB_SET_.has(t)))];
  if (relevant.length === 0) return;
  try {
    const { reconcileClientMasterIngestionFromGrids } = await import("./relationalMasterService.js");
    await reconcileClientMasterIngestionFromGrids(ctx, relevant);
  } catch (err) {
    console.warn(`[masterEngineService] Phase 4 relational master reconciliation warning (${ctx.clientName}):`, err?.message);
  }
}

async function syncPhase4ReconIfEnabled_(ctx, tabNames = [], { deletedMonthKeys = [] } = {}) {
  if (!ctx) return;
  try {
    const {
      isManagedReconTab,
      invalidateClientRelationalReconCache,
      reconcileClientReconFromGrids,
      deleteClientReconPeriod,
    } = await import("./relationalReconService.js");
    invalidateClientRelationalReconCache(ctx.clientName);
    if (ctx.reconMode !== "relational") return;

    const cleanDeleted = [...new Set((deletedMonthKeys || []).map((t) => String(t || "").trim()).filter(Boolean))];
    for (const delTab of cleanDeleted) {
      if (/^\d{4}$/.test(delTab)) {
        await deleteClientReconPeriod(ctx, delTab).catch((err) =>
          console.warn(`[masterEngineService] Phase 4C delete recon period warning (${ctx.clientName}/${delTab}):`, err?.message)
        );
      }
    }

    const relevant = [...new Set((Array.isArray(tabNames) ? tabNames : []).map((t) => String(t || "").trim()).filter((t) => isManagedReconTab(t)))];
    if (relevant.length > 0) {
      await reconcileClientReconFromGrids(ctx, relevant);
    }
  } catch (err) {
    console.warn(`[masterEngineService] Phase 4C relational recon reconciliation warning (${ctx.clientName}):`, err?.message);
  }
}

async function recomputeAndPersistImmediateClientTabs_(
  ctx,
  targetTabNames,
  rawSheetsApi = null,
  { notesChangedTabs = new Set(), allowClearAllNotesTabs = new Set(), deferBackgroundRecompute = false } = {}
) {
  const clientKey = String(ctx.clientName || "").toLowerCase();
  if (Array.isArray(targetTabNames) && targetTabNames.length > 0) {
    queuePendingClientTabs_(ctx, targetTabNames, {
      isSkippedStep: true,
      notesChangedTabs,
      allowClearAllNotesTabs,
    });
  } else {
    _pendingClientCtxByClient.set(clientKey, ctx);
    if (notesChangedTabs || allowClearAllNotesTabs) {
      queuePendingClientTabs_(ctx, [], { notesChangedTabs, allowClearAllNotesTabs });
    }
  }

  if (_inFlightImmediateClientFlushByClient.has(clientKey)) {
    return _inFlightImmediateClientFlushByClient.get(clientKey);
  }

  const runLoop = (async () => {
    while (true) {
      const skippedSet = _unpersistedSkippedClientTabsByClient.get(clientKey);
      if (!skippedSet || skippedSet.size === 0) break;
      await runSingleImmediateClientTabsPass_(ctx, [], rawSheetsApi, { deferBackgroundRecompute });
    }
  })();

  _inFlightImmediateClientFlushByClient.set(clientKey, runLoop);
  try {
    await runLoop;
  } finally {
    if (_inFlightImmediateClientFlushByClient.get(clientKey) === runLoop) {
      _inFlightImmediateClientFlushByClient.delete(clientKey);
    }
  }
}

async function runSingleImmediateClientTabsPass_(
  ctx,
  targetTabNames,
  rawSheetsApi = null,
  { notesChangedTabs = new Set(), allowClearAllNotesTabs = new Set(), deferBackgroundRecompute = false } = {}
) {
  const clientKey = String(ctx.clientName || "").toLowerCase();
  _lastClientEditTimestampMap.set(clientKey, Date.now());

  const nonFormulaTabs = new Set(["Sessions", "AppLog", "Welcome"]);
  const skippedSet = _unpersistedSkippedClientTabsByClient.get(clientKey);
  const pendingNotesSet = _pendingNotesChangedTabsByClient.get(clientKey);
  const pendingClearSet = _pendingAllowClearAllNotesTabsByClient.get(clientKey);

  const allImmediateTabs = [
    ...new Set([...(skippedSet ? [...skippedSet] : []), ...(Array.isArray(targetTabNames) ? targetTabNames : [])]),
  ].filter((t) => t && !nonFormulaTabs.has(t));

  if (skippedSet) skippedSet.clear();

  const mergedNotesChanged = new Set([
    ...(pendingNotesSet ? [...pendingNotesSet] : []),
    ...(notesChangedTabs instanceof Set ? [...notesChangedTabs] : Array.isArray(notesChangedTabs) ? notesChangedTabs : []),
  ]);
  if (pendingNotesSet) pendingNotesSet.clear();

  const mergedAllowClearNotes = new Set([
    ...(pendingClearSet ? [...pendingClearSet] : []),
    ...(allowClearAllNotesTabs instanceof Set
      ? [...allowClearAllNotesTabs]
      : Array.isArray(allowClearAllNotesTabs)
        ? allowClearAllNotesTabs
        : []),
  ]);
  if (pendingClearSet) pendingClearSet.clear();

  if (allImmediateTabs.length === 0) {
    if (hasPendingOrInFlightClientRecompute_(clientKey)) {
      scheduleBackgroundClientRecompute_(ctx, rawSheetsApi);
    }
    return;
  }

  const localGrids = Object.create(null);
  const records = {};

  // Always include KeyInfo in localGrids if cached (or load it if a tab besides Confirmed/Pipeline needs it)
  const keyInfoCacheKey = `${clientKey}::client::KeyInfo`;
  const keyInfoEntry = _gridMemoryCache.get(keyInfoCacheKey);
  let keyInfoRec = keyInfoEntry && keyInfoEntry.expiresAt > Date.now() ? keyInfoEntry.record : null;
  if (
    !keyInfoRec &&
    allImmediateTabs.some((t) => t !== "Confirmed" && t !== "Pipeline")
  ) {
    keyInfoRec = await getOrLoadVirtualTabGrid_(ctx, "client", "KeyInfo", rawSheetsApi, { valuesOnly: true });
  }
  if (keyInfoRec && !allImmediateTabs.includes("KeyInfo")) {
    localGrids.KeyInfo = {
      values: Array.isArray(keyInfoRec.values_grid) ? keyInfoRec.values_grid : [],
      formulas: Array.isArray(keyInfoRec.formulas_grid) ? keyInfoRec.formulas_grid : [],
      notes: keyInfoRec.notes_grid || {},
    };
  }

  // If OutgNotes is updated, include cached Outgoings (with notes) so notes sync accurately
  if (allImmediateTabs.includes("OutgNotes") && !allImmediateTabs.includes("Outgoings")) {
    const outgEntry = _gridMemoryCache.get(`${clientKey}::client::Outgoings`);
    const outgRec =
      outgEntry && outgEntry.expiresAt > Date.now() && outgEntry.record?._notesLoaded !== false
        ? outgEntry.record
        : null;
    if (outgRec) {
      localGrids.Outgoings = {
        values: Array.isArray(outgRec.values_grid) ? outgRec.values_grid : [],
        formulas: Array.isArray(outgRec.formulas_grid) ? outgRec.formulas_grid : [],
        notes: outgRec.notes_grid || {},
      };
    }
  }

  for (const tabName of allImmediateTabs) {
    const cacheKey = `${clientKey}::client::${tabName}`;
    const entry = _gridMemoryCache.get(cacheKey);
    let rec =
      entry && entry.expiresAt > Date.now() && !entry.record?._valuesOnlyLoaded
        ? entry.record
        : null;
    if (!rec) {
      rec = await getOrLoadVirtualTabGrid_(ctx, "client", tabName, rawSheetsApi);
    }
    if (!rec) continue;
    records[tabName] = rec;
    const origVals = Array.isArray(rec.values_grid) ? rec.values_grid : [];
    const vGrid = origVals.map((r) => (Array.isArray(r) ? [...r] : []));
    const fGrid =
      Array.isArray(rec.formulas_grid) && rec.formulas_grid.length > 0
        ? rec.formulas_grid
        : vGrid.map((r) => [...r]);
    localGrids[tabName] = {
      values: vGrid,
      formulas: fGrid,
      notes: rec.notes_grid || {},
    };
  }

  // Wipe self-contained formula cells on each target tab so recalculateClientGrids computes fresh values
  const preservedFormulaValues = new Map();
  for (const tabName of allImmediateTabs) {
    const entry = localGrids[tabName];
    if (!entry) continue;
    const { values: vGrid, formulas: fGrid } = entry;
    const maxWipeR =
      (tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs") &&
        fGrid.length > 350
        ? Math.min(fGrid.length, findLastActiveClientJobRow_(vGrid, tabName.startsWith("Conf") ? 295 : 105) + 4)
        : fGrid.length;
    for (let r = 0; r < maxWipeR; r++) {
      const rowF = fGrid[r] || [];
      for (let c = 0; c < rowF.length; c++) {
        const f = rowF[c];
        if (typeof f === "string" && f.startsWith("=")) {
          const curV = vGrid[r]?.[c];
          if (typeof curV === "string" && curV.startsWith("#REF! (Array result was not expanded")) {
            continue;
          }
          if (tabName === "DataForReport" && (c === 6 || r === 2)) {
            continue;
          }
          const refsMissing = formulaRefsMissingSheetInMap_(f, tabName, localGrids);
          const hasImportRange = /IMPORTRANGE\s*\(/i.test(f);
          if (
            (refsMissing || hasImportRange) &&
            curV !== "" &&
            curV !== null &&
            curV !== undefined &&
            !(typeof curV === "string" && curV.startsWith("#VALUE! (Cannot coerce 'Symbol("))
          ) {
            preservedFormulaValues.set(`${tabName}!${r},${c}`, curV);
          }
          if (refsMissing) {
            continue;
          }
          if (vGrid[r]) vGrid[r][c] = "";
        }
      }
    }
  }

  const reconGrids = localGrids.Cash?.formulas
    ? await loadReferencedReconGridsForClientFormulas_(ctx, [localGrids.Cash.formulas], rawSheetsApi)
    : null;

  recalculateClientGrids(localGrids, {
    changedTabs: allImmediateTabs,
    onlyTabs: new Set(allImmediateTabs),
    reconGrids,
    preservedFormulaValues,
  });

  await Promise.all(
    allImmediateTabs.map((t) => {
      if (!localGrids[t]) return Promise.resolve();
      const isFullySelfContained = FULLY_SELF_CONTAINED_CLIENT_TABS.has(t);
      return saveVirtualTabGrid_(
        ctx,
        "client",
        t,
        localGrids[t].values,
        localGrids[t].formulas,
        records[t]?.notes_grid || {},
        {
          valuesOnly: !mergedNotesChanged.has(t),
          allowClearAllNotes: mergedAllowClearNotes.has(t),
          markPersistedImmediate: isFullySelfContained,
          markPersistedToDbImmediate: true,
        }
      );
    })
  );

  await syncPhase2RelationalJobsIfEnabled_(ctx, allImmediateTabs, localGrids);
  await syncPhase3OperatingInputsIfEnabled_(ctx, allImmediateTabs, localGrids, {
    allowClearAllNotes: mergedAllowClearNotes.size > 0,
  });
  await syncPhase5FinancialsIfEnabled_(ctx, allImmediateTabs, localGrids);

  let activeSourceSet = _activeRecomputeSourceTabsByClient.get(clientKey);
  if (!activeSourceSet) {
    activeSourceSet = new Set();
    _activeRecomputeSourceTabsByClient.set(clientKey, activeSourceSet);
  }
  for (const t of allImmediateTabs) activeSourceSet.add(t);

  if (
    ctx.clientMode === "supabase" &&
    !ctx._suppressBridgeOutbound &&
    ctx.sheetBridgeMode &&
    ctx.sheetBridgeMode !== "off"
  ) {
    try {
      const { scheduleOutboundSheetBridgeSync } = await import("./clientSheetBridgeService.js");
      scheduleOutboundSheetBridgeSync(ctx.clientName, allImmediateTabs);
    } catch { }
  }

  queuePendingClientTabs_(ctx, allImmediateTabs);
  if (!deferBackgroundRecompute) {
    scheduleBackgroundClientRecompute_(ctx, rawSheetsApi);
  }
}

async function recomputeClientFormulasAfterVirtualWrite_(ctx, updatedTabNames, rawSheetsApi) {
  const clientKey = String(ctx.clientName || "").toLowerCase();
  _lastClientEditTimestampMap.set(clientKey, Date.now());
  if (Array.isArray(updatedTabNames) && updatedTabNames.length > 0) {
    queuePendingClientTabs_(ctx, updatedTabNames);
  }
  const skippedSet = _unpersistedSkippedClientTabsByClient.get(clientKey);
  if (skippedSet && skippedSet.size > 0) {
    queuePendingClientTabs_(ctx, [...skippedSet]);
    skippedSet.clear();
  }

  while (_inFlightClientRecomputeByClient.has(clientKey)) {
    await _inFlightClientRecomputeByClient.get(clientKey).catch(() => { });
  }

  const pendingSetCheck = _pendingClientTabsByClient.get(clientKey);
  if (!pendingSetCheck || pendingSetCheck.size === 0) {
    _activeRecomputeSourceTabsByClient.delete(clientKey);
    return;
  }

  const runPassPromise = (async () => {
    let needsMasterCompRefresh = false;
    let recomputeAllDomains = false;
    const affectedMasterDomains = new Set();
    while (true) {
      const pendingSet = _pendingClientTabsByClient.get(clientKey);
      if (!pendingSet || pendingSet.size === 0) break;
      const allUpdatedTabs = [...pendingSet];
      pendingSet.clear();
      const passRes = await executeClientFormulaRecomputePass_(ctx, clientKey, allUpdatedTabs, rawSheetsApi);
      if (passRes?.affectsMasterComparisons) {
        needsMasterCompRefresh = true;
        if (passRes.masterCompDomains === null) {
          recomputeAllDomains = true;
        } else if (Array.isArray(passRes.masterCompDomains)) {
          for (const d of passRes.masterCompDomains) affectedMasterDomains.add(d);
        }
      }
    }
    if (
      needsMasterCompRefresh &&
      (ctx.masterComputeMode === "native" || ctx.masterComputeMode === "shadow")
    ) {
      try {
        const {
          invalidateClientNativeMasterCompCache,
          computeAndPersistNativeMasterComparisons,
        } = await import("./nativeMasterComparisonService.js");
        invalidateClientNativeMasterCompCache(ctx.clientName);
        await computeAndPersistNativeMasterComparisons(ctx, {
          source: "db",
          domains: recomputeAllDomains || affectedMasterDomains.size === 0 ? null : [...affectedMasterDomains],
        });
        if (ctx.masterComputeMode === "native") {
          const [{ markMasterComparisonsFresh }, { invalidatePmaClientCache }] = await Promise.all([
            import("./masterSyncEngine.js"),
            import("./cacheService.js"),
          ]);
          markMasterComparisonsFresh(ctx.clientName);
          await invalidatePmaClientCache(ctx.clientSheetId, ctx.masterSheetId).catch(() => { });
        }
      } catch (e) {
        console.warn(
          `[masterEngineService] Post-client-recompute master comparison refresh warning (${ctx.clientName}):`,
          e?.message
        );
      }
    }
  })();

  _inFlightClientRecomputeByClient.set(clientKey, runPassPromise);
  try {
    await runPassPromise;
  } finally {
    if (_inFlightClientRecomputeByClient.get(clientKey) === runPassPromise) {
      _inFlightClientRecomputeByClient.delete(clientKey);
      if (!(_pendingClientTabsByClient.get(clientKey)?.size > 0)) {
        _activeRecomputeSourceTabsByClient.delete(clientKey);
      }
    }
  }
}

export async function recomputeClientFormulasForBridge(
  clientName,
  changedTabs = [],
  { allowClearAllNotesTabs = [] } = {}
) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx || ctx.clientMode !== "supabase") return;
  const tabs = Array.isArray(changedTabs) && changedTabs.length > 0 ? changedTabs : ["Confirmed"];
  const clearSet = new Set(Array.isArray(allowClearAllNotesTabs) ? allowClearAllNotesTabs : []);
  const suppressedCtx = { ...ctx, sheetRole: "client", _suppressBridgeOutbound: true };
  await recomputeAndPersistImmediateClientTabs_(
    suppressedCtx,
    tabs,
    null,
    {
      notesChangedTabs: clearSet,
      allowClearAllNotesTabs: clearSet,
    }
  );
  await flushPendingClientRecomputes(null, ctx.clientName);
}

const CLIENT_TAB_DIRECT_DEPS = {
  KeyInfo: [],
  Confirmed: [],
  Pipeline: [],
  Salaries: ["KeyInfo"],
  ConfCalcs: ["Confirmed", "KeyInfo"],
  PipeCalcs: ["Pipeline", "KeyInfo"],
  Calcs: ["ConfCalcs", "PipeCalcs", "KeyInfo"],
  ErrorCheck: ["ConfCalcs", "PipeCalcs"],
  RevenueConf: ["ConfCalcs", "KeyInfo"],
  RevenuePipe: ["PipeCalcs", "KeyInfo"],
  Budget: ["KeyInfo", "Performance"],
  NBtoFind: ["KeyInfo", "Budget", "Dashboard"],
  OutgNotes: ["Outgoings", "KeyInfo"],
  Outgoings: ["KeyInfo", "Salaries", "Performance", "Dashboard", "Confirmed", "Monthly"],
  Performance: ["KeyInfo", "Calcs", "NBtoFind", "Outgoings"],
  Dashboard: ["Performance", "ErrorCheck", "KeyInfo", "Outgoings", "Calcs"],
  Monthly: ["KeyInfo", "Dashboard", "Outgoings", "ConfCalcs", "PipeCalcs", "OutgNotes"],
  VAT: ["KeyInfo", "Outgoings", "Calcs"],
  Cash: ["KeyInfo", "Calcs", "Outgoings", "Performance", "VAT"],
  GPbyPL: ["Performance", "Outgoings", "KeyInfo", "Dashboard", "Calcs"],
  Year0Data: ["Performance", "KeyInfo", "ErrorCheck"],
  InvoicesSent: ["Monthly"],
  CashIncomingConf: ["Monthly"],
  CashIncomingPipe: ["Monthly"],
  ContrPayments: ["Monthly", "KeyInfo"],
  Report: ["KeyInfo", "DataForReport", "Dashboard", "Cash"],
  DataForReport: ["Report", "KeyInfo"],
};

const MASTER_COMP_AFFECTING_CLIENT_TABS = new Set([
  "Confirmed",
  "ConfCalcs",
  "Pipeline",
  "PipeCalcs",
  "Outgoings",
  "OutgNotes",
  "KeyInfo",
]);

function mapClientTabsToMasterCompDomains_(tabs = []) {
  const domainSet = new Set();
  for (const t of tabs) {
    if (t === "KeyInfo") return null;
    if (t === "Confirmed" || t === "ConfCalcs") {
      domainSet.add("inv");
      domainSet.add("dir");
      domainSet.add("crm");
    } else if (t === "Pipeline" || t === "PipeCalcs") {
      domainSet.add("crm");
    } else if (t === "Outgoings" || t === "OutgNotes") {
      domainSet.add("dir");
    }
  }
  return [...domainSet];
}

async function executeClientFormulaRecomputePass_(ctx, clientKey, allUpdatedTabs, rawSheetsApi) {
  const nonFormulaTabs = new Set(["Sessions", "AppLog", "Welcome"]);
  const hasCalcRelevantChange = allUpdatedTabs.some((t) => !nonFormulaTabs.has(t));
  if (!hasCalcRelevantChange) {
    return { affectsMasterComparisons: false, masterCompDomains: [] };
  }

  const changedSet = new Set(allUpdatedTabs);
  const unaffectedTabs = new Set();
  if (!changedSet.has("KeyInfo")) {
    unaffectedTabs.add("KeyInfo");
    if (!changedSet.has("Salaries")) {
      unaffectedTabs.add("Salaries");
    }
    if (!changedSet.has("Budget")) {
      unaffectedTabs.add("Budget");
    }
    if (!changedSet.has("DataForReport") && !changedSet.has("Report")) {
      unaffectedTabs.add("DataForReport");
    }
    if (!changedSet.has("Confirmed") && !changedSet.has("ConfCalcs") && !changedSet.has("RevenueConf")) {
      unaffectedTabs.add("Confirmed");
      unaffectedTabs.add("ConfCalcs");
      unaffectedTabs.add("RevenueConf");
      if (!changedSet.has("CashIncomingConf")) unaffectedTabs.add("CashIncomingConf");
      if (!changedSet.has("InvoicesSent")) unaffectedTabs.add("InvoicesSent");
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
      if (
        unaffectedTabs.has("Budget") &&
        !changedSet.has("NBtoFind") &&
        !changedSet.has("Dashboard")
      ) {
        unaffectedTabs.add("NBtoFind");
      }
      if (
        unaffectedTabs.has("Salaries") &&
        unaffectedTabs.has("NBtoFind") &&
        !changedSet.has("Outgoings") &&
        !changedSet.has("OutgNotes") &&
        !changedSet.has("Monthly") &&
        !changedSet.has("Performance") &&
        !changedSet.has("Dashboard")
      ) {
        unaffectedTabs.add("Outgoings");
        unaffectedTabs.add("OutgNotes");
        unaffectedTabs.add("Monthly");
        unaffectedTabs.add("Performance");
        unaffectedTabs.add("Dashboard");
        if (!changedSet.has("ContrPayments")) unaffectedTabs.add("ContrPayments");
        if (!changedSet.has("Year0Data")) unaffectedTabs.add("Year0Data");
        if (!changedSet.has("VAT")) unaffectedTabs.add("VAT");
        if (!changedSet.has("GPbyPL")) unaffectedTabs.add("GPbyPL");
      }
    }
  }

  function isMonthlyColUnaffected_(c) {
    if (!unaffectedTabs.has("KeyInfo")) return false;
    if (c >= 175 && c <= 185 && unaffectedTabs.has("OutgNotes")) return true;
    if ((c === 10 || (c >= 41 && c <= 57) || (c >= 83 && c <= 105)) && unaffectedTabs.has("PipeCalcs")) return true;
    if (
      (c === 2 ||
        (c >= 17 && c <= 39) ||
        (c >= 59 && c <= 81) ||
        (c >= 107 && c <= 130) ||
        (c >= 142 && c <= 167)) &&
      unaffectedTabs.has("ConfCalcs")
    ) {
      return true;
    }
    return false;
  }

  // Record per-tab write revisions at pass start to prevent overwriting concurrent user edits
  const startRevByTab = {};
  for (const t of CORE_CLIENT_TABS) {
    startRevByTab[t] = getTabWriteRevision_(ctx.clientName, "client", t);
  }

  const supabase = getSupabaseAdmin();
  const recordsByTab = {};
  const prevSnapshots = {};
  const grids = Object.create(null);
  const preservedFormulaValues = new Map();
  const alreadyEvaluatedTabs = new Set();
  const wasPersistedToDbImmediate = new Set();

  // Compute exact set of unaffected tabs actually read by any affected tab
  const neededUnaffectedDeps = new Set();
  for (const tabName of CORE_CLIENT_TABS) {
    if (nonFormulaTabs.has(tabName) || unaffectedTabs.has(tabName)) continue;
    const deps = CLIENT_TAB_DIRECT_DEPS[tabName] || [];
    for (const d of deps) {
      if (tabName === "Monthly") {
        if (d === "ConfCalcs" && unaffectedTabs.has("ConfCalcs") && isMonthlyColUnaffected_(2)) continue;
        if (d === "PipeCalcs" && unaffectedTabs.has("PipeCalcs") && isMonthlyColUnaffected_(10)) continue;
        if (d === "OutgNotes" && unaffectedTabs.has("OutgNotes") && isMonthlyColUnaffected_(175)) continue;
      }
      neededUnaffectedDeps.add(d);
    }
  }

  // 1. Check in-memory cache first; batch-load only affected tabs + needed direct dependencies
  const missingAffectedTabs = [];
  const missingUnaffectedTabs = [];
  const missingUnaffectedWithNotesTabs = [];
  for (const tabName of CORE_CLIENT_TABS) {
    if (nonFormulaTabs.has(tabName)) continue;
    const cacheKey = `${clientKey}::client::${tabName}`;
    const cached = _gridMemoryCache.get(cacheKey);
    const isUnneededUnaffected = unaffectedTabs.has(tabName) && !neededUnaffectedDeps.has(tabName);
    const isUnaffected = unaffectedTabs.has(tabName);
    const requiresNotes = isUnaffected && tabName === "Outgoings" && !unaffectedTabs.has("OutgNotes");
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      doesCachedClientRecordSatisfy_(cached.record, { valuesOnly: isUnaffected, includeNotes: requiresNotes })
    ) {
      recordsByTab[tabName] = cached.record;
      if (cached.record._persistedImmediate) {
        cached.record._persistedImmediate = false;
        alreadyEvaluatedTabs.add(tabName);
      }
      if (cached.record._persistedToDbImmediate) {
        cached.record._persistedToDbImmediate = false;
        wasPersistedToDbImmediate.add(tabName);
      }
    } else if (isUnneededUnaffected) {
      recordsByTab[tabName] = { values_grid: [], formulas_grid: [], notes_grid: {}, _skippedFetch: true };
    } else if (requiresNotes) {
      missingUnaffectedWithNotesTabs.push(tabName);
    } else if (isUnaffected) {
      missingUnaffectedTabs.push(tabName);
    } else {
      missingAffectedTabs.push(tabName);
    }
  }

  if (
    (missingAffectedTabs.length > 0 || missingUnaffectedTabs.length > 0 || missingUnaffectedWithNotesTabs.length > 0) &&
    supabase
  ) {
    if (ctx.clientComputeMode === "native") {
      try {
        const { loadNativeClientTabRecordsBatch } = await import("./nativeClientCalcService.js");
        const allMissingTabs = [
          ...missingAffectedTabs,
          ...missingUnaffectedWithNotesTabs,
          ...missingUnaffectedTabs,
        ];
        const loadedMap = await loadNativeClientTabRecordsBatch(ctx, allMissingTabs, {
          source: "db",
          valuesOnly: false,
          includeNotes: true,
        });
        for (const t of allMissingTabs) {
          const rec = loadedMap[t];
          if (!rec) continue;
          const isAff = missingAffectedTabs.includes(t);
          const reqNotes = missingUnaffectedWithNotesTabs.includes(t);
          rec._valuesOnlyLoaded = !isAff;
          rec._notesLoaded = isAff || reqNotes;
          recordsByTab[t] = rec;
          const existing = _gridMemoryCache.get(`${clientKey}::client::${t}`);
          if (shouldStoreClientRecordInCache_(existing, { valuesOnly: !isAff, includeNotes: rec._notesLoaded })) {
            setGridMemoryCache_(`${clientKey}::client::${t}`, rec);
          }
        }
      } catch (natLoadErr) {
        console.warn(`[masterEngineService] Native client batch load fallback (${ctx.clientName}):`, natLoadErr?.message);
      }
    }

    const stillMissingAffected = missingAffectedTabs.filter((t) => !recordsByTab[t]);
    const stillMissingUnaffNotes = missingUnaffectedWithNotesTabs.filter((t) => !recordsByTab[t]);
    const stillMissingUnaff = missingUnaffectedTabs.filter((t) => !recordsByTab[t]);

    const dbRole = _useClientRoleFallback ? "master" : "client";
    const queries = [];
    if (!ctx.gridStorageRetired && stillMissingAffected.length > 0) {
      const targetNames = _useClientRoleFallback
        ? stillMissingAffected.map((t) => `Client::${t}`)
        : stillMissingAffected;
      const CHUNK_SIZE = 5;
      for (let i = 0; i < targetNames.length; i += CHUNK_SIZE) {
        const chunk = targetNames.slice(i, i + CHUNK_SIZE);
        queries.push(
          supabase
            .from("master_sheet_grids")
            .select("id, client_id, client_name, sheet_role, tab_name, values_grid, formulas_grid, notes_grid, row_count, col_count")
            .eq("client_name", ctx.clientName)
            .eq("sheet_role", dbRole)
            .in("tab_name", chunk)
            .then(({ data }) => ({ rows: data || [], valuesOnly: false, includeNotes: true }))
        );
      }
    }
    if (!ctx.gridStorageRetired && stillMissingUnaffNotes.length > 0) {
      const targetNames = _useClientRoleFallback
        ? stillMissingUnaffNotes.map((t) => `Client::${t}`)
        : stillMissingUnaffNotes;
      queries.push(
        supabase
          .from("master_sheet_grids")
          .select("id, client_id, client_name, sheet_role, tab_name, values_grid, notes_grid, row_count, col_count")
          .eq("client_name", ctx.clientName)
          .eq("sheet_role", dbRole)
          .in("tab_name", targetNames)
          .then(({ data }) => ({ rows: data || [], valuesOnly: true, includeNotes: true }))
      );
    }
    if (!ctx.gridStorageRetired && stillMissingUnaff.length > 0) {
      const targetNames = _useClientRoleFallback
        ? stillMissingUnaff.map((t) => `Client::${t}`)
        : stillMissingUnaff;
      queries.push(
        supabase
          .from("master_sheet_grids")
          .select("id, client_id, client_name, sheet_role, tab_name, values_grid, row_count, col_count")
          .eq("client_name", ctx.clientName)
          .eq("sheet_role", dbRole)
          .in("tab_name", targetNames)
          .then(({ data }) => ({ rows: data || [], valuesOnly: true, includeNotes: false }))
      );
    }
    const queryResults = await Promise.all(queries);
    for (const { rows, valuesOnly, includeNotes } of queryResults) {
      for (const r of rows) {
        const cleanTab = r.tab_name.startsWith("Client::") ? r.tab_name.slice(8) : r.tab_name;
        if (!recordsByTab[cleanTab]) {
          expandClientTabFromStorage_(r, cleanTab, { valuesOnly });
          r._valuesOnlyLoaded = valuesOnly;
          r._notesLoaded = !valuesOnly || includeNotes;
          recordsByTab[cleanTab] = r;
          const existing = _gridMemoryCache.get(`${clientKey}::client::${cleanTab}`);
          if (shouldStoreClientRecordInCache_(existing, { valuesOnly, includeNotes })) {
            setGridMemoryCache_(`${clientKey}::client::${cleanTab}`, r);
          }
        }
      }
    }
  }

  for (const tabName of CORE_CLIENT_TABS) {
    if (nonFormulaTabs.has(tabName)) continue;
    let rec = recordsByTab[tabName];
    if (rec && rec._skippedFetch) {
      continue;
    }
    if (!rec) {
      const isUnaff = unaffectedTabs.has(tabName);
      rec = await getOrLoadVirtualTabGrid_(ctx, "client", tabName, rawSheetsApi, {
        valuesOnly: isUnaff,
        includeNotes: isUnaff && tabName === "Outgoings" && !unaffectedTabs.has("OutgNotes"),
      });
      recordsByTab[tabName] = rec;
    }
    const origVals = Array.isArray(rec.values_grid) ? rec.values_grid : [];
    const isUnaffected = unaffectedTabs.has(tabName) || alreadyEvaluatedTabs.has(tabName);

    if (isUnaffected) {
      grids[tabName] = {
        values: origVals,
        formulas: rec.formulas_grid || [],
        notes: rec.notes_grid || {},
        _valuesOnlyLoaded: Boolean(rec._valuesOnlyLoaded),
        _notesLoaded: rec._notesLoaded !== false,
      };
      continue;
    }

    prevSnapshots[tabName] = snapshotClientValuesForDiff_(tabName, origVals);

    const vGrid = origVals.map((r) => (Array.isArray(r) ? [...r] : []));
    const fGrid =
      Array.isArray(rec.formulas_grid) && rec.formulas_grid.length > 0
        ? rec.formulas_grid
        : vGrid.map((r) => [...r]);

    // Wipe formula cell values (except blocked spill #REF! and DataForReport external IMPORTRANGE cols/rows)
    // so recalculateClientGrids computes fresh values across all dependent tabs
    const maxWipeR =
      (tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs") &&
        fGrid.length > 350
        ? Math.min(fGrid.length, findLastActiveClientJobRow_(vGrid, tabName.startsWith("Conf") ? 295 : 105) + 4)
        : fGrid.length;
    for (let r = 0; r < maxWipeR; r++) {
      const rowF = fGrid[r] || [];
      for (let c = 0; c < rowF.length; c++) {
        const f = rowF[c];
        if (typeof f === "string" && f.startsWith("=")) {
          if (tabName === "Monthly" && isMonthlyColUnaffected_(c)) {
            continue;
          }
          const curV = vGrid[r]?.[c];
          if (typeof curV === "string" && curV.startsWith("#REF! (Array result was not expanded")) {
            continue;
          }
          if (tabName === "DataForReport" && (c === 6 || r === 2)) {
            continue;
          }
          const refsNonCore = formulaRefsMissingSheetInMap_(f, tabName, CORE_CLIENT_FORMULA_TABS_SET);
          const hasImportRange = /IMPORTRANGE\s*\(/i.test(f);
          if (
            (refsNonCore || hasImportRange) &&
            curV !== "" &&
            curV !== null &&
            curV !== undefined &&
            !(typeof curV === "string" && curV.startsWith("#VALUE! (Cannot coerce 'Symbol("))
          ) {
            preservedFormulaValues.set(`${tabName}!${r},${c}`, curV);
          }
          if (refsNonCore) {
            continue;
          }
          if (tabName === "Calcs" && curV !== "" && curV !== undefined && curV !== null) {
            const refsPipe = f.includes("PipeCalcs");
            const refsConf = f.includes("ConfCalcs");
            if (refsPipe && !refsConf && unaffectedTabs.has("PipeCalcs")) continue;
            if (refsConf && !refsPipe && unaffectedTabs.has("ConfCalcs")) continue;
          }
          if (vGrid[r]) vGrid[r][c] = "";
        }
      }
    }

    grids[tabName] = {
      values: vGrid,
      formulas: fGrid,
      notes: rec.notes_grid || {},
    };
  }

  const reconGrids =
    grids.Cash?.formulas && !unaffectedTabs.has("Cash")
      ? await loadReferencedReconGridsForClientFormulas_(ctx, [grids.Cash.formulas], rawSheetsApi)
      : null;

  recalculateClientGrids(grids, {
    changedTabs: allUpdatedTabs,
    unaffectedTabs,
    alreadyEvaluatedTabs,
    reconGrids,
    preservedFormulaValues,
  });

  // 2. Persist any unpersisted updated tabs plus any downstream tabs whose evaluated values changed
  //    (guarding against overwriting any tab mutated concurrently during this pass)
  const concurrentUpdatedTabs = [];
  const dirtyTabs = CORE_CLIENT_TABS.filter((t) => {
    if (nonFormulaTabs.has(t) || unaffectedTabs.has(t) || alreadyEvaluatedTabs.has(t) || !grids[t]?.values?.length) {
      return false;
    }
    if (getTabWriteRevision_(ctx.clientName, "client", t) !== startRevByTab[t]) {
      concurrentUpdatedTabs.push(t);
      return false;
    }
    if (changedSet.has(t) && !wasPersistedToDbImmediate.has(t)) return true;
    return snapshotClientValuesForDiff_(t, grids[t].values) !== prevSnapshots[t];
  });

  if (concurrentUpdatedTabs.length > 0) {
    queuePendingClientTabs_(ctx, concurrentUpdatedTabs);
  }

  await Promise.all(
    dirtyTabs.map((t) =>
      saveVirtualTabGrid_(
        ctx,
        "client",
        t,
        grids[t].values,
        grids[t].formulas,
        recordsByTab[t]?.notes_grid || {},
        { valuesOnly: !changedSet.has(t) || wasPersistedToDbImmediate.has(t) }
      )
    )
  );

  const phaseSyncTabs = [...new Set([...allUpdatedTabs, ...dirtyTabs])];
  await syncPhase2RelationalJobsIfEnabled_(ctx, phaseSyncTabs, grids);
  await syncPhase3OperatingInputsIfEnabled_(ctx, phaseSyncTabs, grids, {
    allowClearAllNotes: Boolean(ctx._suppressBridgeOutbound),
  });
  await syncPhase5FinancialsIfEnabled_(ctx, phaseSyncTabs, grids);
  if (ctx.clientComputeMode === "shadow") {
    import("./nativeClientCalcService.js")
      .then(({ runShadowClientCalcCheck }) => runShadowClientCalcCheck(ctx, phaseSyncTabs, grids))
      .catch((e) => console.warn("[masterEngineService] Phase 6A shadow check warning:", e?.message));
  }
  if (ctx.masterComputeMode === "native") {
    import("./nativeMasterComparisonService.js")
      .then(({ invalidateClientNativeMasterCompCache }) => invalidateClientNativeMasterCompCache(ctx.clientName))
      .catch(() => { });
  }

  if (dirtyTabs.length > 0) {
    await import("./cacheService.js")
      .then(({ invalidatePmaClientCache }) =>
        invalidatePmaClientCache(ctx.clientSheetId, ctx.masterSheetId)
      )
      .catch(() => { });
    if (ctx.clientSheetId) {
      const resolveCachedOrMemVals = async (tab) => {
        if (Array.isArray(grids[tab]?.values) && grids[tab].values.length > 0) return grids[tab].values;
        const memRec = _gridMemoryCache.get(`${clientKey}::client::${tab}`)?.record;
        if (Array.isArray(memRec?.values_grid) && memRec.values_grid.length > 0) return memRec.values_grid;
        const loaded = await getOrLoadVirtualTabGrid_(ctx, "client", tab, rawSheetsApi, { valuesOnly: true });
        return Array.isArray(loaded?.values_grid) ? loaded.values_grid : [];
      };
      Promise.all([
        resolveCachedOrMemVals("KeyInfo"),
        resolveCachedOrMemVals("Dashboard"),
        resolveCachedOrMemVals("Year0Data"),
      ])
        .then(async ([keyInfoValues, dashboardValues, year0Values]) => {
          if (!dashboardValues.length) return;
          const { warmPortalHomeFromVirtualGrids } = await import("./portalDataService.js");
          await warmPortalHomeFromVirtualGrids({
            clientSheetId: ctx.clientSheetId,
            clientName: ctx.clientName,
            keyInfoValues,
            dashboardValues,
            year0Values,
          });
        })
        .catch(() => { });
    }
  }

  // Refresh memory cache TTL for all loaded tabs of this client so consecutive operations stay warm
  const refreshedExpiry = Date.now() + GRID_CACHE_TTL_MS;
  for (const tabName of CORE_CLIENT_TABS) {
    const cacheKey = `${clientKey}::client::${tabName}`;
    const entry = _gridMemoryCache.get(cacheKey);
    if (entry) {
      entry.expiresAt = refreshedExpiry;
    }
  }

  // Sync Stage 4 normalized mirror tables only when explicitly enabled (paused by default)
  if (shouldSyncNormalizedMirrorTables()) {
    const changedTabList = [...new Set([...allUpdatedTabs, ...dirtyTabs])];
    syncStructuredClientTablesFromGrids_(ctx, grids, changedTabList).catch((e) =>
      console.warn("[masterEngineService] Stage 4 relational sync warning:", e.message)
    );
  }

  if (
    !ctx._suppressBridgeOutbound &&
    ctx.clientMode === "supabase" &&
    ctx.sheetBridgeMode &&
    ctx.sheetBridgeMode !== "off"
  ) {
    const bridgeTabs = [...new Set([...allUpdatedTabs, ...dirtyTabs])];
    if (bridgeTabs.length > 0) {
      import("./clientSheetBridgeService.js")
        .then(({ scheduleOutboundSheetBridgeSync }) =>
          scheduleOutboundSheetBridgeSync(ctx.clientName, bridgeTabs)
        )
        .catch(() => { });
    }
  }
  const masterCompTabs = phaseSyncTabs.filter((t) => MASTER_COMP_AFFECTING_CLIENT_TABS.has(t));
  return {
    affectsMasterComparisons: masterCompTabs.length > 0,
    masterCompDomains: masterCompTabs.length > 0 ? mapClientTabsToMasterCompDomains_(masterCompTabs) : [],
  };
}

/**
 * Intercepts Google Sheets v4 API calls from sheetsClient.js when a client's
 * master_mode === 'supabase' (for Master/Recon) or client_mode === 'supabase' (for Client Sheet).
 */
export async function handleVirtualSheetsCall({
  namespace,
  method,
  params,
  ctx,
  rawSheetsApi,
}) {
  const supabase = getSupabaseAdmin();
  const sheetRole = ctx.sheetRole; // 'master' | 'recon' | 'client'
  const spreadsheetId = params?.spreadsheetId || "";

  // 1. values.get
  if (namespace === "values" && method === "get") {
    const rangeStr = params.range || "KeyInfo!A1:Z100";
    const parsed = parseA1Range(rangeStr);
    if (sheetRole === "client" && ctx.sheetBridgeMode === "live") {
      await import("./clientSheetBridgeService.js")
        .then(({ ensureClientSheetBridgeFreshOnRead }) => ensureClientSheetBridgeFreshOnRead(ctx))
        .catch((e) => console.warn("[masterEngineService] Bridge read check warning:", e.message));
    }
    if (
      sheetRole === "client" &&
      params.valueRenderOption !== "FORMULA" &&
      doesClientRangeNeedFormulaFlush_(parsed, ctx.clientName)
    ) {
      if (hasPendingOrInFlightClientRecompute_(ctx.clientName)) {
        await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Read-barrier formula recompute warning:", e.message)
        );
      }
    }
    const isUnformatted = params.valueRenderOption === "UNFORMATTED_VALUE";
    const isFormulaReq = params.valueRenderOption === "FORMULA";
    let rec = null;
    if (sheetRole === "master" && ctx.masterComputeMode === "native" && !isFormulaReq) {
      try {
        const {
          MASTER_COMP_TYPE_BY_TAB,
          loadMasterContextTabFromConfig,
          loadPersistedOrEvaluateMasterComparisonTab,
        } = await import("./nativeMasterComparisonService.js");
        if (parsed.tabName === "KeyInfo" || parsed.tabName === "DataChgAlert" || parsed.tabName === "PLAdds") {
          const ctxGrid = await loadMasterContextTabFromConfig(ctx, parsed.tabName);
          if (Array.isArray(ctxGrid) && ctxGrid.length > 0) {
            rec = {
              values_grid: ctxGrid,
              formulas_grid: ctxGrid,
              notes_grid: {},
            };
          }
        } else if (Object.prototype.hasOwnProperty.call(MASTER_COMP_TYPE_BY_TAB, parsed.tabName)) {
          const compGrid = await loadPersistedOrEvaluateMasterComparisonTab(ctx, parsed.tabName);
          if (Array.isArray(compGrid)) {
            rec = {
              values_grid: compGrid,
              formulas_grid: compGrid,
              notes_grid: {},
            };
          }
        }
      } catch (natMasterErr) {
        console.warn(`[masterEngineService] Native master get fallback for ${ctx.clientName}/${parsed.tabName}:`, natMasterErr?.message);
      }
    }
    if (
      !rec &&
      sheetRole === "master" &&
      ctx.masterReadMode === "relational" &&
      !isFormulaReq &&
      PHASE4_MASTER_TAB_SET_.has(parsed.tabName)
    ) {
      try {
        const {
          preloadClientRelationalMasterBundle,
          reconstructRelationalMasterTabFromBundle,
        } = await import("./relationalMasterService.js");
        const bundle = await preloadClientRelationalMasterBundle(ctx, {
          source: "db",
          tabs: [parsed.tabName],
        });
        const reconGrid = await reconstructRelationalMasterTabFromBundle(bundle, parsed.tabName, ctx);
        rec = {
          values_grid: reconGrid,
          formulas_grid: reconGrid,
          notes_grid: {},
        };
      } catch (relErr) {
        console.warn(`[masterEngineService] Relational master read fallback for ${ctx.clientName}/${parsed.tabName}:`, relErr?.message);
        rec = null;
      }
    } else if (
      sheetRole === "recon" &&
      ctx.reconReadMode === "relational" &&
      !isFormulaReq
    ) {
      try {
        const {
          isManagedReconTab,
          preloadClientRelationalReconBundle,
          reconstructRelationalReconTabFromBundle,
        } = await import("./relationalReconService.js");
        if (isManagedReconTab(parsed.tabName)) {
          const bundle = await preloadClientRelationalReconBundle(ctx, { source: "db" });
          const reconstructed = reconstructRelationalReconTabFromBundle(bundle, parsed.tabName);
          if (reconstructed) rec = reconstructed;
        }
      } catch (relErr) {
        console.warn(`[masterEngineService] Relational recon read fallback for ${ctx.clientName}/${parsed.tabName}:`, relErr?.message);
        rec = null;
      }
    } else if (
      sheetRole === "client" &&
      (params._forceFinancialsReadMode === "relational" ||
        (params._forceFinancialsReadMode !== "grid" && ctx.financialsReadMode === "relational")) &&
      PHASE5_FINANCIAL_TAB_SET_.has(parsed.tabName)
    ) {
      try {
        const {
          preloadClientRelationalFinancialsBundle,
          reconstructRelationalFinancialTabFromBundle,
        } = await import("./relationalFinancialsService.js");
        const bundle = await preloadClientRelationalFinancialsBundle(ctx, {
          source: "db",
          includeFormulas: isFormulaReq,
        });
        const reconstructed = reconstructRelationalFinancialTabFromBundle(bundle, parsed.tabName, {
          includeFormulas: isFormulaReq,
        });
        if (reconstructed) rec = reconstructed;
      } catch (relErr) {
        console.warn(`[masterEngineService] Relational financials read fallback for ${ctx.clientName}/${parsed.tabName}:`, relErr?.message);
        rec = null;
      }
    }
    if (!rec) {
      rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, parsed.tabName, rawSheetsApi, {
        valuesOnly: sheetRole === "client" && !isFormulaReq,
        includeNotes: false,
      });
    }
    const isFormula =
      isFormulaReq && Array.isArray(rec.formulas_grid) && rec.formulas_grid.length > 0;
    const sourceGrid = isFormula ? rec.formulas_grid : rec.values_grid || [];
    const sliced = sliceGrid2D_(sourceGrid, parsed);
    const values =
      isFormula || isUnformatted
        ? sliced
        : formatGridForDisplay(
          sheetRole,
          parsed.tabName,
          sliced,
          parsed.startRow0 ?? 0,
          parsed.startCol0 ?? 0,
          rec.values_grid || [],
          rec.notes_grid || {}
        );
    return {
      status: 200,
      data: {
        range: rangeStr,
        majorDimension: "ROWS",
        values,
      },
    };
  }

  // 2. values.batchGet
  if (namespace === "values" && method === "batchGet") {
    const ranges = Array.isArray(params.ranges) ? params.ranges : [params.ranges].filter(Boolean);
    const parsedList = ranges.map((r) => ({ raw: r, parsed: parseA1Range(r) }));
    if (sheetRole === "client" && ctx.sheetBridgeMode === "live") {
      await import("./clientSheetBridgeService.js")
        .then(({ ensureClientSheetBridgeFreshOnRead }) => ensureClientSheetBridgeFreshOnRead(ctx))
        .catch((e) => console.warn("[masterEngineService] Bridge read check warning:", e.message));
    }
    if (
      sheetRole === "client" &&
      params.valueRenderOption !== "FORMULA" &&
      parsedList.some((p) => doesClientRangeNeedFormulaFlush_(p.parsed, ctx.clientName))
    ) {
      if (hasPendingOrInFlightClientRecompute_(ctx.clientName)) {
        await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Read-barrier formula recompute warning:", e.message)
        );
      }
    }
    const uniqueTabs = [...new Set(parsedList.map((p) => p.parsed.tabName))];

    const isFormulaReq = params.valueRenderOption === "FORMULA";
    const isUnformattedReq = params.valueRenderOption === "UNFORMATTED_VALUE";
    const useValuesOnly = !isFormulaReq;
    const byTab = new Map();
    if (sheetRole === "client") {
      const clientKeyLower = ctx.clientName.toLowerCase();
      const useRelFinancialsBatch =
        params._forceFinancialsReadMode === "relational" ||
        (params._forceFinancialsReadMode !== "grid" && ctx.financialsReadMode === "relational");
      const relFinTabs = useRelFinancialsBatch
        ? uniqueTabs.filter((t) => PHASE5_FINANCIAL_TAB_SET_.has(t))
        : [];
      if (relFinTabs.length > 0) {
        try {
          const {
            preloadClientRelationalFinancialsBundle,
            reconstructRelationalFinancialTabFromBundle,
          } = await import("./relationalFinancialsService.js");
          const bundle = await preloadClientRelationalFinancialsBundle(ctx, {
            source: "db",
            includeFormulas: isFormulaReq,
          });
          for (const t of relFinTabs) {
            const reconstructed = reconstructRelationalFinancialTabFromBundle(bundle, t, {
              includeFormulas: isFormulaReq,
            });
            if (reconstructed) byTab.set(t, reconstructed);
          }
        } catch (relErr) {
          console.warn(`[masterEngineService] Relational financials batchGet fallback for ${ctx.clientName}:`, relErr?.message);
        }
      }
      const uncachedTabs = [];
      const inFlightWaits = [];
      for (const t of uniqueTabs) {
        if (byTab.has(t)) continue;
        const cKey = `${clientKeyLower}::client::${t}`;
        const cached = _gridMemoryCache.get(cKey);
        if (
          cached &&
          cached.expiresAt > Date.now() &&
          doesCachedClientRecordSatisfy_(cached.record, { valuesOnly: useValuesOnly, includeNotes: false })
        ) {
          byTab.set(t, cached.record);
        } else {
          const inflight =
            _inFlightGridLoads.get(cKey) ||
            (useValuesOnly ? _inFlightGridLoads.get(`${cKey}::vn`) || _inFlightGridLoads.get(`${cKey}::vo`) : null);
          if (inflight) {
            inFlightWaits.push(
              inflight.then((rec) => {
                if (rec) byTab.set(t, rec);
              })
            );
          } else {
            uncachedTabs.push(t);
          }
        }
      }
      if (uncachedTabs.length > 0 && supabase && ctx.clientComputeMode === "native") {
        try {
          const { loadNativeClientTabRecordsBatch } = await import("./nativeClientCalcService.js");
          const loadedMap = await loadNativeClientTabRecordsBatch(ctx, uncachedTabs, {
            source: "db",
            valuesOnly: useValuesOnly,
            includeNotes: !useValuesOnly,
          });
          for (const t of uncachedTabs) {
            const rec = loadedMap?.[t];
            if (!rec || !Array.isArray(rec.values_grid) || rec.values_grid.length === 0) continue;
            const fullRec = {
              client_id: ctx.clientId,
              client_name: ctx.clientName,
              sheet_role: "client",
              tab_name: t,
              ...rec,
              _valuesOnlyLoaded: useValuesOnly,
              _notesLoaded: !useValuesOnly,
            };
            byTab.set(t, fullRec);
            const existing = _gridMemoryCache.get(`${clientKeyLower}::client::${t}`);
            if (shouldStoreClientRecordInCache_(existing, { valuesOnly: useValuesOnly, includeNotes: false })) {
              setGridMemoryCache_(`${clientKeyLower}::client::${t}`, fullRec);
            }
          }
        } catch (natErr) {
          console.warn(`[masterEngineService] Native client batchGet fallback (${ctx.clientName}):`, natErr?.message);
        }
      }
      const gridUncachedTabs = uncachedTabs.filter((t) => !byTab.has(t));
      if (gridUncachedTabs.length > 0 && supabase) {
        const dbRole = _useClientRoleFallback ? "master" : "client";
        const targetNames = _useClientRoleFallback
          ? gridUncachedTabs.map((t) => `Client::${t}`)
          : gridUncachedTabs;
        const selectCols = useValuesOnly
          ? "id, client_id, client_name, sheet_role, tab_name, values_grid, row_count, col_count, updated_at"
          : "id, client_id, client_name, sheet_role, tab_name, values_grid, formulas_grid, notes_grid, row_count, col_count, updated_at";
        const flightSuffix = useValuesOnly ? "::vo" : "";
        const batchPromise = (async () => {
          const { data: rows } = await supabase
            .from("master_sheet_grids")
            .select(selectCols)
            .eq("client_name", ctx.clientName)
            .eq("sheet_role", dbRole)
            .in("tab_name", targetNames);
          const loadedMap = new Map();
          for (const r of rows || []) {
            const cleanTab = r.tab_name.startsWith("Client::") ? r.tab_name.slice(8) : r.tab_name;
            expandClientTabFromStorage_(r, cleanTab, { valuesOnly: useValuesOnly });
            r._valuesOnlyLoaded = useValuesOnly;
            r._notesLoaded = !useValuesOnly;
            loadedMap.set(cleanTab, r);
            byTab.set(cleanTab, r);
            const existing = _gridMemoryCache.get(`${clientKeyLower}::client::${cleanTab}`);
            if (shouldStoreClientRecordInCache_(existing, { valuesOnly: useValuesOnly, includeNotes: false })) {
              setGridMemoryCache_(`${clientKeyLower}::client::${cleanTab}`, r);
            }
          }
          return loadedMap;
        })();
        for (const t of gridUncachedTabs) {
          const fKey = `${clientKeyLower}::client::${t}${flightSuffix}`;
          _inFlightGridLoads.set(
            fKey,
            batchPromise.then((m) => m.get(t) || null)
          );
        }
        try {
          await batchPromise;
        } finally {
          for (const t of gridUncachedTabs) {
            const fKey = `${clientKeyLower}::client::${t}${flightSuffix}`;
            _inFlightGridLoads.delete(fKey);
          }
        }
      }
      if (inFlightWaits.length > 0) {
        await Promise.all(inFlightWaits);
      }
      const remainingTabs = uniqueTabs.filter((t) => !byTab.has(t));
      for (let i = 0; i < remainingTabs.length; i += 3) {
        const chunk = remainingTabs.slice(i, i + 3);
        await Promise.all(
          chunk.map(async (tabName) => {
            const rec = await getOrLoadVirtualTabGrid_(ctx, "client", tabName, rawSheetsApi, {
              valuesOnly: useValuesOnly,
              includeNotes: false,
            });
            byTab.set(tabName, rec);
          })
        );
      }
    } else {
      const clientKeyLower = ctx.clientName.toLowerCase();
      if (sheetRole === "master" && ctx.masterComputeMode === "native" && !isFormulaReq) {
        try {
          const {
            MASTER_COMP_TYPE_BY_TAB,
            loadMasterContextTabFromConfig,
            loadPersistedOrEvaluateMasterComparisonTab,
          } = await import("./nativeMasterComparisonService.js");
          const nativeCtxTabs = uniqueTabs.filter((t) => !byTab.has(t) && (t === "KeyInfo" || t === "DataChgAlert" || t === "PLAdds"));
          const nativeCompTabs = uniqueTabs.filter((t) => !byTab.has(t) && Object.prototype.hasOwnProperty.call(MASTER_COMP_TYPE_BY_TAB, t));
          if (nativeCtxTabs.length > 0 || nativeCompTabs.length > 0) {
            await Promise.all([
              ...nativeCtxTabs.map(async (t) => {
                const ctxGrid = await loadMasterContextTabFromConfig(ctx, t);
                if (Array.isArray(ctxGrid) && ctxGrid.length > 0) {
                  const recOut = {
                    client_id: ctx.clientId,
                    client_name: ctx.clientName,
                    sheet_role: "master",
                    tab_name: t,
                    values_grid: ctxGrid,
                    formulas_grid: ctxGrid,
                    notes_grid: {},
                    row_count: ctxGrid.length,
                    col_count: ctxGrid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
                    updated_at: new Date().toISOString(),
                  };
                  byTab.set(t, recOut);
                  setGridMemoryCache_(`${clientKeyLower}::master::${t}`, recOut);
                }
              }),
              ...nativeCompTabs.map(async (t) => {
                const compGrid = await loadPersistedOrEvaluateMasterComparisonTab(ctx, t);
                if (Array.isArray(compGrid)) {
                  const recOut = {
                    client_id: ctx.clientId,
                    client_name: ctx.clientName,
                    sheet_role: "master",
                    tab_name: t,
                    values_grid: compGrid,
                    formulas_grid: compGrid,
                    notes_grid: {},
                    row_count: compGrid.length,
                    col_count: compGrid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
                    updated_at: new Date().toISOString(),
                  };
                  byTab.set(t, recOut);
                  setGridMemoryCache_(`${clientKeyLower}::master::${t}`, recOut);
                }
              }),
            ]);
          }
        } catch (natMasterErr) {
          console.warn(`[masterEngineService] Native master batchGet fallback for ${ctx.clientName}:`, natMasterErr?.message);
        }
      }
      const relationalPhase4Tabs =
        sheetRole === "master" && ctx.masterReadMode === "relational" && !isFormulaReq
          ? uniqueTabs.filter((t) => !byTab.has(t) && PHASE4_MASTER_TAB_SET_.has(t))
          : [];
      if (relationalPhase4Tabs.length > 0) {
        try {
          const {
            preloadClientRelationalMasterBundle,
            reconstructRelationalMasterTabFromBundle,
          } = await import("./relationalMasterService.js");
          const bundle = await preloadClientRelationalMasterBundle(ctx, {
            source: "db",
            tabs: relationalPhase4Tabs,
          });
          await Promise.all(
            relationalPhase4Tabs.map(async (t) => {
              const reconGrid = await reconstructRelationalMasterTabFromBundle(bundle, t, ctx);
              byTab.set(t, {
                values_grid: reconGrid,
                formulas_grid: reconGrid,
                notes_grid: {},
              });
            })
          );
        } catch (relErr) {
          console.warn(`[masterEngineService] Relational master batchGet fallback for ${ctx.clientName}:`, relErr?.message);
        }
      }
      if (sheetRole === "master" && ctx.connectorPullMode === "native") {
        const c6Tabs = uniqueTabs.filter(
          (t) =>
            !byTab.has(t) &&
            (t === "CRMGoogleBridge" || t === "CRMExcelBridge" || t === "CRMExcelCopy" || t === "GasScriptProps")
        );
        if (c6Tabs.length > 0) {
          try {
            const { data: cfg6c } = await supabase
              .from("pulse_master_sync_configs")
              .select("crm_google_bridge_grid, crm_excel_bridge_grid, crm_excel_copy_grid, script_properties")
              .eq("client_id", ctx.clientId)
              .maybeSingle();
            if (cfg6c) {
              for (const t of c6Tabs) {
                let vGrid = [];
                if (t === "CRMGoogleBridge") vGrid = Array.isArray(cfg6c.crm_google_bridge_grid) ? cfg6c.crm_google_bridge_grid : [];
                else if (t === "CRMExcelBridge") vGrid = Array.isArray(cfg6c.crm_excel_bridge_grid) ? cfg6c.crm_excel_bridge_grid : [];
                else if (t === "CRMExcelCopy") vGrid = Array.isArray(cfg6c.crm_excel_copy_grid) ? cfg6c.crm_excel_copy_grid : [];
                else if (t === "GasScriptProps") {
                  const sp = cfg6c.script_properties && typeof cfg6c.script_properties === "object" ? cfg6c.script_properties : {};
                  vGrid = [["Key", "Value"], ...Object.entries(sp).map(([k, v]) => [k, String(v ?? "")])];
                }
                const compacted = compactGrid2D(vGrid);
                const recOut = {
                  values_grid: compacted,
                  formulas_grid: compacted,
                  notes_grid: {},
                };
                byTab.set(t, recOut);
                setGridMemoryCache_(`${clientKeyLower}::master::${t}`, recOut);
              }
            }
          } catch (c6Err) {
            console.warn(`[masterEngineService] Phase 6C batchGet fallback (${ctx.clientName}):`, c6Err?.message);
          }
        }
      }
      if (sheetRole === "master" && ctx.syncOrchestratorMode === "native") {
        try {
          const {
            PHASE6D_MASTER_LOG_AND_AUX_TABS,
          } = await import("./nativeSyncOrchestratorService.js");
          const c6dTabs = uniqueTabs.filter((t) => !byTab.has(t) && PHASE6D_MASTER_LOG_AND_AUX_TABS.has(t));
          if (c6dTabs.length > 0) {
            await Promise.all(
              c6dTabs.map(async (t) => {
                const loaded = await getOrLoadVirtualTabGrid_(ctx, "master", t, rawSheetsApi).catch(() => null);
                if (loaded) byTab.set(t, loaded);
              })
            );
          }
        } catch (c6dErr) {
          console.warn(`[masterEngineService] Phase 6D batchGet fallback (${ctx.clientName}):`, c6dErr?.message);
        }
      }
      if (sheetRole === "recon" && (ctx.reconReadMode === "relational" || ctx.syncOrchestratorMode === "native") && !isFormulaReq) {
        try {
          const {
            isManagedReconTab,
            preloadClientRelationalReconBundle,
            reconstructRelationalReconTabFromBundle,
          } = await import("./relationalReconService.js");
          const managedTabs = uniqueTabs.filter((t) => isManagedReconTab(t));
          if (managedTabs.length > 0) {
            const bundle = await preloadClientRelationalReconBundle(ctx, { source: "db" });
            for (const t of managedTabs) {
              const reconstructed = reconstructRelationalReconTabFromBundle(bundle, t);
              if (reconstructed) byTab.set(t, reconstructed);
            }
          }
        } catch (relErr) {
          console.warn(`[masterEngineService] Relational recon batchGet fallback for ${ctx.clientName}:`, relErr?.message);
        }
      }
      const uncachedTabs = [];
      const inFlightWaits = [];
      for (const t of uniqueTabs) {
        if (byTab.has(t)) continue;
        const cKey = `${clientKeyLower}::${sheetRole}::${t}`;
        const cached = _gridMemoryCache.get(cKey);
        if (cached && cached.expiresAt > Date.now()) {
          byTab.set(t, cached.record);
        } else {
          const inflight = _inFlightGridLoads.get(cKey) || _inFlightGridLoads.get(`${cKey}::vo`);
          if (inflight) {
            inFlightWaits.push(
              inflight.then((rec) => {
                if (rec) byTab.set(t, rec);
              })
            );
          } else {
            uncachedTabs.push(t);
          }
        }
      }
      if (uncachedTabs.length > 0 && supabase) {
        const batchPromise = (async () => {
          const { data: rows } = await supabase
            .from("master_sheet_grids")
            .select("id, client_id, client_name, sheet_role, tab_name, values_grid, notes_grid, row_count, col_count, updated_at")
            .eq("client_name", ctx.clientName)
            .eq("sheet_role", sheetRole)
            .in("tab_name", uncachedTabs);
          const loadedMap = new Map();
          for (const r of rows || []) {
            r.values_grid = compactGrid2D(r.values_grid || []);
            r.formulas_grid = r.values_grid;
            loadedMap.set(r.tab_name, r);
            byTab.set(r.tab_name, r);
            setGridMemoryCache_(`${clientKeyLower}::${sheetRole}::${r.tab_name}`, r);
          }
          return loadedMap;
        })();
        for (const t of uncachedTabs) {
          const fKey = `${clientKeyLower}::${sheetRole}::${t}`;
          _inFlightGridLoads.set(
            fKey,
            batchPromise.then((m) => m.get(t) || null)
          );
        }
        try {
          await batchPromise;
        } finally {
          for (const t of uncachedTabs) {
            _inFlightGridLoads.delete(`${clientKeyLower}::${sheetRole}::${t}`);
          }
        }
      }
      if (inFlightWaits.length > 0) {
        await Promise.all(inFlightWaits);
      }
    }

    const valueRanges = [];
    for (const item of parsedList) {
      let rec = byTab.get(item.parsed.tabName);
      if (!rec) {
        rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, item.parsed.tabName, rawSheetsApi);
        byTab.set(item.parsed.tabName, rec);
      }
      const isFormula =
        isFormulaReq && Array.isArray(rec.formulas_grid) && rec.formulas_grid.length > 0;
      const sourceGrid = isFormula ? rec.formulas_grid : rec.values_grid || [];
      const sliced = sliceGrid2D_(sourceGrid, item.parsed);
      const values =
        isFormula || isUnformattedReq
          ? sliced
          : formatGridForDisplay(
            sheetRole,
            item.parsed.tabName,
            sliced,
            item.parsed.startRow0 ?? 0,
            item.parsed.startCol0 ?? 0,
            rec.values_grid || [],
            rec.notes_grid || {}
          );
      valueRanges.push({
        range: item.raw,
        majorDimension: "ROWS",
        values,
      });
    }

    return {
      status: 200,
      data: {
        spreadsheetId,
        valueRanges,
      },
    };
  }

  // 3. values.update
  if (namespace === "values" && method === "update") {
    const rangeStr = params.range || "KeyInfo!A1";
    const incomingValues = params.requestBody?.values || params.resource?.values || [];
    const valueInputOption = params.valueInputOption || params.requestBody?.valueInputOption || "USER_ENTERED";
    const parsed = parseA1Range(rangeStr);
    const rec = await getVirtualTabGridForWrite_(ctx, sheetRole, parsed.tabName, rawSheetsApi);
    const prevValSnap =
      sheetRole === "client" ? snapshotClientValuesForDiff_(parsed.tabName, rec.values_grid) : null;
    const prevFormSnap =
      sheetRole === "client"
        ? snapshotClientValuesForDiff_(parsed.tabName, rec.formulas_grid || rec.values_grid)
        : null;
    const prevFormulasGrid = sheetRole === "client" ? rec.formulas_grid || rec.values_grid : null;
    const updatedValues = applyWriteToGrid2D_(rec.values_grid || [], parsed, incomingValues, {
      sheetRole,
      tabName: parsed.tabName,
      valueInputOption,
      notesGrid: rec.notes_grid,
      isFormulaGrid: false,
    });
    const updatedFormulas = applyWriteToGrid2D_(rec.formulas_grid || rec.values_grid || [], parsed, incomingValues, {
      sheetRole,
      tabName: parsed.tabName,
      valueInputOption,
      notesGrid: rec.notes_grid,
      isFormulaGrid: true,
    });
    if (
      prevValSnap !== null &&
      snapshotClientValuesForDiff_(parsed.tabName, updatedValues) === prevValSnap &&
      snapshotClientValuesForDiff_(parsed.tabName, updatedFormulas) === prevFormSnap
    ) {
      if (sheetRole === "client" && !params._skipFormulaRecompute) {
        const pendingSet = _pendingClientTabsByClient.get(String(ctx.clientName || "").toLowerCase());
        if (pendingSet && pendingSet.size > 0) {
          if (params._syncFormulaRecompute) {
            await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
              console.warn("[masterEngineService] Client formula recompute warning:", e.message)
            );
          } else {
            await recomputeAndPersistImmediateClientTabs_(ctx, [], rawSheetsApi).catch((e) =>
              console.warn("[masterEngineService] Immediate client tab recompute warning:", e.message)
            );
          }
        }
      }
      return {
        status: 200,
        data: {
          spreadsheetId,
          updatedRange: rangeStr,
          updatedRows: incomingValues.length,
        },
      };
    }
    const formulasChanged =
      sheetRole === "client" ? hasFormulaCellsChanged_(prevFormulasGrid, updatedFormulas) : false;
    const isNonFormulaKeyInfoOnly = isNonFormulaKeyInfoOnlyUpdates_([{ parsed }]);
    bumpTabWriteRevision_(ctx.clientName, sheetRole, parsed.tabName);
    const isDeferredClientSave =
      sheetRole === "client" &&
      !isNonFormulaKeyInfoOnly &&
      !["Sessions", "AppLog", "Welcome"].includes(parsed.tabName);
    await saveVirtualTabGrid_(ctx, sheetRole, parsed.tabName, updatedValues, updatedFormulas, rec.notes_grid, {
      memoryOnly: isDeferredClientSave,
    });

    if (sheetRole === "master") {
      if (!params._skipMasterFormulaRecompute && !isNonFormulaKeyInfoOnly) {
        await recomputeMasterFormulasAfterVirtualWrite_(ctx, [parsed.tabName], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Formula recompute warning:", e.message)
        );
      }
      await syncPhase4MasterIngestionIfEnabled_(ctx, [parsed.tabName]);
      await mirrorMasterWriteToClientSheetIfNeeded_(ctx, rawSheetsApi, [{ range: rangeStr, values: incomingValues }]);
    } else if (sheetRole === "recon") {
      await syncPhase4ReconIfEnabled_(ctx, [parsed.tabName]);
    } else if (sheetRole === "client") {
      if (isNonFormulaKeyInfoOnly) {
        await syncPhase5FinancialsIfEnabled_(ctx, [parsed.tabName]);
        await import("./cacheService.js")
          .then(({ invalidatePmaClientCache }) => invalidatePmaClientCache(ctx.clientSheetId, ctx.masterSheetId))
          .catch(() => { });
        if (ctx.sheetBridgeMode && ctx.sheetBridgeMode !== "off") {
          import("./clientSheetBridgeService.js")
            .then(({ scheduleOutboundSheetBridgeSync }) =>
              scheduleOutboundSheetBridgeSync(ctx.clientName, [parsed.tabName])
            )
            .catch(() => { });
        }
      } else if (params._skipFormulaRecompute) {
        queuePendingClientTabs_(ctx, [parsed.tabName], {
          isSkippedStep: true,
          notesChangedTabs: formulasChanged ? [parsed.tabName] : null,
        });
      } else if (params._syncFormulaRecompute) {
        await recomputeClientFormulasAfterVirtualWrite_(ctx, [parsed.tabName], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Client formula recompute warning:", e.message)
        );
      } else {
        await recomputeAndPersistImmediateClientTabs_(ctx, [parsed.tabName], rawSheetsApi, {
          notesChangedTabs: formulasChanged ? new Set([parsed.tabName]) : new Set(),
          deferBackgroundRecompute: Boolean(params._deferBackgroundRecompute),
        }).catch((e) =>
          console.warn("[masterEngineService] Immediate client tab recompute warning:", e.message)
        );
      }
    }

    return {
      status: 200,
      data: {
        spreadsheetId,
        updatedRange: rangeStr,
        updatedRows: incomingValues.length,
      },
    };
  }

  // 4. values.batchUpdate
  if (namespace === "values" && method === "batchUpdate") {
    const dataItems = params.requestBody?.data || params.resource?.data || [];
    const valueInputOption =
      params.valueInputOption || params.requestBody?.valueInputOption || params.resource?.valueInputOption || "USER_ENTERED";
    const byTabUpdates = new Map();
    for (const d of dataItems) {
      if (!d || !d.range) continue;
      const parsed = parseA1Range(d.range);
      if (!byTabUpdates.has(parsed.tabName)) byTabUpdates.set(parsed.tabName, []);
      byTabUpdates.get(parsed.tabName).push({ parsed, values: d.values || [], rawRange: d.range });
    }

    const actuallyChangedTabs = [];
    const formulasChangedTabs = new Set();
    const tabEntries = [...byTabUpdates.entries()];
    const allBatchUpdates = [];
    for (const [, updates] of tabEntries) allBatchUpdates.push(...updates);
    const isNonFormulaKeyInfoOnlyBatch = isNonFormulaKeyInfoOnlyUpdates_(allBatchUpdates);
    const preloadedRecs = await Promise.all(
      tabEntries.map(([tabName]) => getVirtualTabGridForWrite_(ctx, sheetRole, tabName, rawSheetsApi))
    );
    for (let idx = 0; idx < tabEntries.length; idx++) {
      const [tabName, updates] = tabEntries[idx];
      const rec = preloadedRecs[idx];
      const prevValSnap =
        sheetRole === "client" ? snapshotClientValuesForDiff_(tabName, rec.values_grid) : null;
      const prevFormSnap =
        sheetRole === "client"
          ? snapshotClientValuesForDiff_(tabName, rec.formulas_grid || rec.values_grid)
          : null;
      const prevFormulasGrid = sheetRole === "client" ? rec.formulas_grid || rec.values_grid : null;
      let nextVals = rec.values_grid || [];
      let nextForms = rec.formulas_grid || rec.values_grid || [];
      for (const u of updates) {
        nextVals = applyWriteToGrid2D_(nextVals, u.parsed, u.values, {
          sheetRole,
          tabName,
          valueInputOption,
          notesGrid: rec.notes_grid,
          isFormulaGrid: false,
        });
        nextForms = applyWriteToGrid2D_(nextForms, u.parsed, u.values, {
          sheetRole,
          tabName,
          valueInputOption,
          notesGrid: rec.notes_grid,
          isFormulaGrid: true,
        });
      }
      if (
        prevValSnap !== null &&
        snapshotClientValuesForDiff_(tabName, nextVals) === prevValSnap &&
        snapshotClientValuesForDiff_(tabName, nextForms) === prevFormSnap
      ) {
        continue;
      }
      bumpTabWriteRevision_(ctx.clientName, sheetRole, tabName);
      if (sheetRole === "client" && hasFormulaCellsChanged_(prevFormulasGrid, nextForms)) {
        formulasChangedTabs.add(tabName);
      }
      actuallyChangedTabs.push(tabName);
      const isDeferredClientSave =
        sheetRole === "client" &&
        !isNonFormulaKeyInfoOnlyBatch &&
        !["Sessions", "AppLog", "Welcome"].includes(tabName);
      await saveVirtualTabGrid_(ctx, sheetRole, tabName, nextVals, nextForms, rec.notes_grid, {
        memoryOnly: isDeferredClientSave,
      });
    }

    if (sheetRole === "master" && actuallyChangedTabs.length > 0) {
      if (!params._skipMasterFormulaRecompute && !isNonFormulaKeyInfoOnlyBatch) {
        await recomputeMasterFormulasAfterVirtualWrite_(ctx, actuallyChangedTabs, rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Formula recompute warning:", e.message)
        );
      }
      await syncPhase4MasterIngestionIfEnabled_(ctx, actuallyChangedTabs);
      await mirrorMasterWriteToClientSheetIfNeeded_(ctx, rawSheetsApi, dataItems);
    } else if (sheetRole === "recon" && actuallyChangedTabs.length > 0) {
      await syncPhase4ReconIfEnabled_(ctx, actuallyChangedTabs);
    } else if (sheetRole === "client") {
      const pendingSet = _pendingClientTabsByClient.get(String(ctx.clientName || "").toLowerCase());
      const hasWork = actuallyChangedTabs.length > 0 || (pendingSet && pendingSet.size > 0);
      if (isNonFormulaKeyInfoOnlyBatch && (!pendingSet || pendingSet.size === 0)) {
        if (actuallyChangedTabs.length > 0) {
          await syncPhase5FinancialsIfEnabled_(ctx, actuallyChangedTabs);
          await import("./cacheService.js")
            .then(({ invalidatePmaClientCache }) => invalidatePmaClientCache(ctx.clientSheetId, ctx.masterSheetId))
            .catch(() => { });
          if (ctx.sheetBridgeMode && ctx.sheetBridgeMode !== "off") {
            import("./clientSheetBridgeService.js")
              .then(({ scheduleOutboundSheetBridgeSync }) =>
                scheduleOutboundSheetBridgeSync(ctx.clientName, actuallyChangedTabs)
              )
              .catch(() => { });
          }
        }
      } else if (params._skipFormulaRecompute) {
        if (actuallyChangedTabs.length > 0) {
          queuePendingClientTabs_(ctx, actuallyChangedTabs, {
            isSkippedStep: true,
            notesChangedTabs: [...formulasChangedTabs],
          });
        }
      } else if (hasWork) {
        if (params._syncFormulaRecompute) {
          await recomputeClientFormulasAfterVirtualWrite_(ctx, actuallyChangedTabs, rawSheetsApi).catch((e) =>
            console.warn("[masterEngineService] Client formula recompute warning:", e.message)
          );
        } else {
          await recomputeAndPersistImmediateClientTabs_(ctx, actuallyChangedTabs, rawSheetsApi, {
            notesChangedTabs: formulasChangedTabs,
            deferBackgroundRecompute: Boolean(params._deferBackgroundRecompute),
          }).catch((e) =>
            console.warn("[masterEngineService] Immediate client tab recompute warning:", e.message)
          );
        }
      }
    }

    return {
      status: 200,
      data: {
        spreadsheetId,
        totalUpdatedRanges: dataItems.length,
      },
    };
  }

  // 5. values.append
  if (namespace === "values" && method === "append") {
    const rangeStr = params.range || "AutoLog!A:D";
    const incomingValues = params.requestBody?.values || params.resource?.values || [];
    if (!Array.isArray(incomingValues) || incomingValues.length > 50000) {
      throw new Error("values.append payload exceeds maximum row limit (50,000).");
    }
    for (const row of incomingValues) {
      if (Array.isArray(row) && row.length > 600) {
        throw new Error("values.append payload exceeds maximum column limit (600).");
      }
    }
    const valueInputOption = params.valueInputOption || "USER_ENTERED";
    const parsed = parseA1Range(rangeStr);
    if (sheetRole === "master" && parsed.tabName === "AutoLog" && ctx.syncOrchestratorMode === "native") {
      const { insertAutomationLogEntries } = await import("./nativeSyncOrchestratorService.js");
      const normAppendRows = incomingValues.map((row) =>
        (Array.isArray(row) ? row : [row]).map((v, cIdx) =>
          normalizeCellForStorage(sheetRole, "AutoLog", 1, (parsed.startCol0 ?? 0) + cIdx, v, valueInputOption, [], {})
        )
      );
      await insertAutomationLogEntries(ctx, normAppendRows, { source: "values.append" });
      return {
        status: 200,
        data: {
          spreadsheetId,
          updates: { updatedRange: rangeStr, updatedRows: incomingValues.length },
        },
      };
    }
    const rec = await getVirtualTabGridForWrite_(ctx, sheetRole, parsed.tabName, rawSheetsApi);
    const baseRow0 = Array.isArray(rec.values_grid) ? rec.values_grid.length : 0;
    if (baseRow0 + incomingValues.length > 50000) {
      throw new Error(`values.append would exceed maximum tab row limit (50,000) for "${parsed.tabName}".`);
    }
    const normRows = incomingValues.map((row, rIdx) =>
      (Array.isArray(row) ? row : [row]).map((v, cIdx) =>
        normalizeCellForStorage(
          sheetRole,
          parsed.tabName,
          baseRow0 + rIdx,
          (parsed.startCol0 ?? 0) + cIdx,
          v,
          valueInputOption,
          rec.values_grid,
          rec.notes_grid
        )
      )
    );
    const nextVals = Array.isArray(rec.values_grid) ? [...rec.values_grid, ...normRows] : [...normRows];
    const nextForms = Array.isArray(rec.formulas_grid) ? [...rec.formulas_grid, ...incomingValues] : [...incomingValues];
    bumpTabWriteRevision_(ctx.clientName, sheetRole, parsed.tabName);
    const isDeferredClientSave =
      sheetRole === "client" && !["Sessions", "AppLog", "Welcome"].includes(parsed.tabName);
    await saveVirtualTabGrid_(ctx, sheetRole, parsed.tabName, nextVals, nextForms, rec.notes_grid, {
      memoryOnly: isDeferredClientSave,
    });

    if (sheetRole === "recon") {
      await syncPhase4ReconIfEnabled_(ctx, [parsed.tabName]);
    } else if (sheetRole === "master") {
      if (!params._skipMasterFormulaRecompute) {
        await recomputeMasterFormulasAfterVirtualWrite_(ctx, [parsed.tabName], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Master formula recompute after append warning:", e.message)
        );
      }
      await syncPhase4MasterIngestionIfEnabled_(ctx, [parsed.tabName]);
    } else if (sheetRole === "client") {
      if (params._skipFormulaRecompute) {
        queuePendingClientTabs_(ctx, [parsed.tabName], {
          isSkippedStep: true,
          notesChangedTabs: [parsed.tabName],
        });
      } else if (params._syncFormulaRecompute) {
        await recomputeClientFormulasAfterVirtualWrite_(ctx, [parsed.tabName], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Client formula recompute warning:", e.message)
        );
      } else {
        await recomputeAndPersistImmediateClientTabs_(ctx, [parsed.tabName], rawSheetsApi, {
          notesChangedTabs: new Set([parsed.tabName]),
        }).catch((e) =>
          console.warn("[masterEngineService] Immediate client tab recompute warning:", e.message)
        );
      }
    }

    return {
      status: 200,
      data: {
        spreadsheetId,
        updates: { updatedRange: rangeStr, updatedRows: incomingValues.length },
      },
    };
  }

  // 6. values.clear & values.batchClear
  if (namespace === "values" && (method === "clear" || method === "batchClear")) {
    const ranges =
      method === "clear"
        ? [params.range].filter(Boolean)
        : params.requestBody?.ranges || params.resource?.ranges || [];
    const byTabClears = new Map();
    for (const r of ranges) {
      const parsed = parseA1Range(r);
      if (!byTabClears.has(parsed.tabName)) byTabClears.set(parsed.tabName, []);
      byTabClears.get(parsed.tabName).push(parsed);
    }

    const formulasChangedTabs = new Set();
    for (const [tabName, clears] of byTabClears.entries()) {
      const rec = await getVirtualTabGridForWrite_(ctx, sheetRole, tabName, rawSheetsApi);
      const prevFormulasGrid = sheetRole === "client" ? rec.formulas_grid || rec.values_grid : null;
      let nextVals = rec.values_grid || [];
      let nextForms = rec.formulas_grid || rec.values_grid || [];
      for (const c of clears) {
        nextVals = clearRangeInGrid2D_(nextVals, c);
        nextForms = clearRangeInGrid2D_(nextForms, c);
      }
      if (sheetRole === "client" && hasFormulaCellsChanged_(prevFormulasGrid, nextForms)) {
        formulasChangedTabs.add(tabName);
      }
      bumpTabWriteRevision_(ctx.clientName, sheetRole, tabName);
      const isDeferredClientSave =
        Boolean(params._skipFormulaRecompute) ||
        (sheetRole === "client" && !["Sessions", "AppLog", "Welcome"].includes(tabName));
      await saveVirtualTabGrid_(ctx, sheetRole, tabName, nextVals, nextForms, rec.notes_grid, {
        memoryOnly: isDeferredClientSave,
      });
    }

    if (sheetRole === "client") {
      if (params._skipFormulaRecompute) {
        queuePendingClientTabs_(ctx, [...byTabClears.keys()], {
          isSkippedStep: true,
          notesChangedTabs: [...formulasChangedTabs],
        });
      } else if (params._syncFormulaRecompute) {
        await recomputeClientFormulasAfterVirtualWrite_(ctx, [...byTabClears.keys()], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Client formula recompute warning:", e.message)
        );
      } else {
        await recomputeAndPersistImmediateClientTabs_(ctx, [...byTabClears.keys()], rawSheetsApi, {
          notesChangedTabs: formulasChangedTabs,
        }).catch((e) =>
          console.warn("[masterEngineService] Immediate client tab recompute warning:", e.message)
        );
      }
    } else if (sheetRole === "master") {
      const clearedMasterTabs = [...byTabClears.keys()];
      if (!params._skipMasterFormulaRecompute && clearedMasterTabs.length > 0) {
        await recomputeMasterFormulasAfterVirtualWrite_(ctx, clearedMasterTabs, rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Formula recompute warning:", e.message)
        );
      }
      await syncPhase4MasterIngestionIfEnabled_(ctx, clearedMasterTabs);
    } else if (sheetRole === "recon") {
      await syncPhase4ReconIfEnabled_(ctx, [...byTabClears.keys()]);
    }

    return {
      status: 200,
      data: { spreadsheetId, clearedRanges: ranges },
    };
  }

  // 7. spreadsheets.get
  if (namespace === "spreadsheets" && method === "get") {
    const requestedRanges = Array.isArray(params.ranges) ? params.ranges : params.ranges ? [params.ranges] : [];
    const includeGridData = Boolean(params.includeGridData || requestedRanges.length > 0);
    if (sheetRole === "client" && includeGridData && ctx.sheetBridgeMode === "live") {
      await import("./clientSheetBridgeService.js")
        .then(({ ensureClientSheetBridgeFreshOnRead }) => ensureClientSheetBridgeFreshOnRead(ctx))
        .catch((e) => console.warn("[masterEngineService] Bridge read check warning:", e.message));
    }
    if (
      sheetRole === "client" &&
      includeGridData &&
      (requestedRanges.length === 0 || requestedRanges.some((r) => doesClientRangeNeedFormulaFlush_(parseA1Range(r), ctx.clientName)))
    ) {
      if (hasPendingOrInFlightClientRecompute_(ctx.clientName)) {
        await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Read-barrier formula recompute warning:", e.message)
        );
      }
    }
    const targetTabNames =
      requestedRanges.length > 0 ? new Set(requestedRanges.map((r) => parseA1Range(r).tabName)) : null;

    let allTabs = [];
    if (sheetRole === "client") {
      if (!includeGridData) {
        if (ctx.clientComputeMode === "native") {
          const { data: bpRows } = await supabase
            .from("pulse_client_tab_blueprints")
            .select("tab_name, row_count, col_count")
            .eq("client_id", ctx.clientId)
            .order("tab_name", { ascending: true });
          for (const r of bpRows || []) {
            allTabs.push({ ...r, sheet_role: "client" });
          }
        }
        if (allTabs.length === 0) {
          const { data: tabRows } = await supabase
            .from("master_sheet_grids")
            .select("tab_name, sheet_role, row_count, col_count")
            .eq("client_name", ctx.clientName)
            .or("sheet_role.eq.client,and(sheet_role.eq.master,tab_name.like.Client::%)")
            .order("tab_name", { ascending: true });
          const seen = new Set();
          for (const r of tabRows || []) {
            const cleanTab = r.tab_name.startsWith("Client::") ? r.tab_name.slice(8) : r.tab_name;
            if (seen.has(cleanTab)) continue;
            seen.add(cleanTab);
            allTabs.push({ ...r, tab_name: cleanTab, sheet_role: "client" });
          }
        }
      } else if (targetTabNames && targetTabNames.size > 0) {
        const fieldsStr = String(params.fields || "");
        const needFormulas = !fieldsStr || fieldsStr.includes("userEnteredValue");
        const needNotes = !fieldsStr || fieldsStr.includes("note") || fieldsStr.includes("effectiveFormat");
        const useRelFinancialsGet =
          params._forceFinancialsReadMode === "relational" ||
          (params._forceFinancialsReadMode !== "grid" && ctx.financialsReadMode === "relational");
        let relFinancialsBundle = null;
        let reconstructFinancialsFn = null;
        if (useRelFinancialsGet && [...targetTabNames].some((t) => PHASE5_FINANCIAL_TAB_SET_.has(t))) {
          try {
            const mod = await import("./relationalFinancialsService.js");
            relFinancialsBundle = await mod.preloadClientRelationalFinancialsBundle(ctx, {
              source: "db",
              includeFormulas: needFormulas,
            });
            reconstructFinancialsFn = mod.reconstructRelationalFinancialTabFromBundle;
          } catch (relErr) {
            console.warn(`[masterEngineService] Relational financials spreadsheets.get fallback for ${ctx.clientName}:`, relErr?.message);
          }
        }
        const loadedTargetTabs = await Promise.all(
          [...targetTabNames].map((tName) => {
            if (relFinancialsBundle && reconstructFinancialsFn && PHASE5_FINANCIAL_TAB_SET_.has(tName)) {
              const reconstructed = reconstructFinancialsFn(relFinancialsBundle, tName, {
                includeFormulas: needFormulas,
              });
              if (reconstructed) return reconstructed;
            }
            return getOrLoadVirtualTabGrid_(ctx, "client", tName, rawSheetsApi, {
              valuesOnly: !needFormulas,
              includeNotes: needNotes,
            });
          })
        );
        allTabs.push(...loadedTargetTabs);
      } else {
        const fieldsStr = String(params.fields || "");
        const needFormulas = !fieldsStr || fieldsStr.includes("userEnteredValue");
        if (ctx.clientComputeMode === "native") {
          try {
            const { data: bpRows } = await supabase
              .from("pulse_client_tab_blueprints")
              .select("tab_name")
              .eq("client_id", ctx.clientId)
              .order("tab_name", { ascending: true });
            const bpTabs = (bpRows || []).map((r) => r.tab_name).filter(Boolean);
            if (bpTabs.length > 0) {
              const { loadNativeClientTabRecordsBatch } = await import("./nativeClientCalcService.js");
              const loadedMap = await loadNativeClientTabRecordsBatch(ctx, bpTabs, {
                source: "db",
                valuesOnly: !needFormulas,
                includeNotes: true,
              });
              for (const tName of bpTabs) {
                if (loadedMap?.[tName]) allTabs.push(loadedMap[tName]);
              }
            }
          } catch (natErr) {
            console.warn(`[masterEngineService] Native client spreadsheets.get fallback (${ctx.clientName}):`, natErr?.message);
          }
        }
        if (allTabs.length === 0) {
          const selectCols = needFormulas
            ? "tab_name, sheet_role, row_count, col_count, values_grid, formulas_grid, notes_grid"
            : "tab_name, sheet_role, row_count, col_count, values_grid, notes_grid";
          const { data: tabRows } = await supabase
            .from("master_sheet_grids")
            .select(selectCols)
            .eq("client_name", ctx.clientName)
            .or("sheet_role.eq.client,and(sheet_role.eq.master,tab_name.like.Client::%)")
            .order("tab_name", { ascending: true });
          const seen = new Set();
          for (const r of tabRows || []) {
            const cleanTab = r.tab_name.startsWith("Client::") ? r.tab_name.slice(8) : r.tab_name;
            if (seen.has(cleanTab)) continue;
            seen.add(cleanTab);
            expandClientTabFromStorage_(r, cleanTab, { valuesOnly: !needFormulas });
            allTabs.push(r);
          }
        }
      }
    } else {
      let reconResolvedFromSql = false;
      if (sheetRole === "recon" && (ctx.reconReadMode === "relational" || ctx.syncOrchestratorMode === "native")) {
        try {
          const {
            isManagedReconTab,
            preloadClientRelationalReconBundle,
            reconstructRelationalReconTabFromBundle,
          } = await import("./relationalReconService.js");
          const bundle = await preloadClientRelationalReconBundle(ctx, { source: "db" });
          const rawTabListMeta = Array.isArray(bundle?.config?.tab_list) ? bundle.config.tab_list : [];
          const tabListMeta =
            rawTabListMeta.length > 0
              ? rawTabListMeta
              : bundle && (bundle.periods.length > 0 || Object.keys(bundle.config || {}).length > 0)
                ? [
                  ...(bundle.periods || []).map((p) => ({
                    tab_name: p.month_key,
                    row_count: p.row_count || 200,
                    col_count: p.col_count || 105,
                  })),
                  ...["PLAdds", "Data", "KeyInfo", "Template"].filter((cfgT) => {
                    if (cfgT === "PLAdds") return Array.isArray(bundle.config?.pl_adds_grid) && bundle.config.pl_adds_grid.length > 0;
                    if (cfgT === "Data") return Array.isArray(bundle.config?.data_grid) && bundle.config.data_grid.length > 0;
                    if (cfgT === "KeyInfo") return Array.isArray(bundle.config?.key_info_grid) && bundle.config.key_info_grid.length > 0;
                    if (cfgT === "Template") return Boolean(bundle.config?.template_meta?.values_grid?.length);
                    return false;
                  }).map((cfgT) => ({ tab_name: cfgT, row_count: 200, col_count: 50 })),
                ]
                : [];
          if (bundle && (tabListMeta.length > 0 || bundle.periods.length > 0)) {
            if (!includeGridData) {
              if (tabListMeta.length > 0) {
                allTabs = tabListMeta.map((t) => ({
                  tab_name: t.tab_name,
                  row_count: t.row_count || 0,
                  col_count: t.col_count || 0,
                }));
                reconResolvedFromSql = true;
              }
            } else if (targetTabNames && targetTabNames.size > 0) {
              const fieldsStr = String(params.fields || "");
              const wantsAllProperties = !fieldsStr || fieldsStr.includes("properties");
              const targetList = [...targetTabNames];
              if (targetList.every((t) => isManagedReconTab(t))) {
                const gridByTab = new Map();
                for (const tName of targetList) {
                  const reconstructed = reconstructRelationalReconTabFromBundle(bundle, tName);
                  if (reconstructed) gridByTab.set(tName, reconstructed);
                }
                if (gridByTab.size === targetList.length) {
                  if (wantsAllProperties && tabListMeta.length > 0) {
                    allTabs = tabListMeta.map((m) => gridByTab.get(m.tab_name) || { ...m, formulas_grid: [] });
                  } else {
                    allTabs = [...gridByTab.values()];
                  }
                  reconResolvedFromSql = true;
                }
              }
            } else if (tabListMeta.length > 0 && tabListMeta.every((t) => isManagedReconTab(t.tab_name))) {
              allTabs = tabListMeta
                .map((t) => reconstructRelationalReconTabFromBundle(bundle, t.tab_name))
                .filter(Boolean);
              reconResolvedFromSql = allTabs.length === tabListMeta.length;
            }
          }
        } catch (relErr) {
          console.warn(`[masterEngineService] Relational recon spreadsheets.get fallback for ${ctx.clientName}:`, relErr?.message);
        }
      } else if (sheetRole === "master" && (ctx.masterComputeMode === "native" || ctx.syncOrchestratorMode === "native")) {
        const masterTabNames =
          targetTabNames && targetTabNames.size > 0
            ? [...targetTabNames]
            : [...new Set([...CORE_MASTER_TABS, "GasScriptProps", "GasExecLogs"])];
        if (!includeGridData) {
          allTabs = masterTabNames.map((t) => ({
            tab_name: t,
            row_count: 1,
            col_count: 1,
          }));
          reconResolvedFromSql = true;
        } else {
          const loadedMaster = await Promise.all(
            masterTabNames.map(async (tName) => {
              const rec = await getOrLoadVirtualTabGrid_(ctx, "master", tName, rawSheetsApi, { valuesOnly: true }).catch(() => null);
              return rec
                ? {
                  tab_name: tName,
                  row_count: rec.row_count || (rec.values_grid || []).length,
                  col_count: rec.col_count || 0,
                  values_grid: rec.values_grid || [],
                  formulas_grid: rec.formulas_grid || rec.values_grid || [],
                  notes_grid: rec.notes_grid || {},
                }
                : null;
            })
          );
          allTabs = loadedMaster.filter(Boolean);
          reconResolvedFromSql = true;
        }
      }

      if (!reconResolvedFromSql) {
        if (includeGridData && targetTabNames && targetTabNames.size > 0) {
          const fieldsStr = String(params.fields || "");
          const wantsAllProperties = !fieldsStr || fieldsStr.includes("properties");
          const targetList = [...targetTabNames];
          const [gridRes, metaRes] = await Promise.all([
            supabase
              .from("master_sheet_grids")
              .select("tab_name, row_count, col_count, values_grid, notes_grid")
              .eq("client_name", ctx.clientName)
              .eq("sheet_role", sheetRole)
              .in("tab_name", targetList),
            wantsAllProperties
              ? supabase
                .from("master_sheet_grids")
                .select("tab_name, row_count, col_count")
                .eq("client_name", ctx.clientName)
                .eq("sheet_role", sheetRole)
                .order("tab_name", { ascending: true })
              : Promise.resolve({ data: [] }),
          ]);
          const gridByTab = new Map();
          for (const r of gridRes.data || []) {
            r.values_grid = compactGrid2D(r.values_grid || []);
            r.formulas_grid = r.values_grid;
            gridByTab.set(r.tab_name, r);
          }
          if (wantsAllProperties && Array.isArray(metaRes.data) && metaRes.data.length > 0) {
            allTabs = metaRes.data.map((m) => gridByTab.get(m.tab_name) || { ...m, formulas_grid: [] });
          } else {
            allTabs = [...gridByTab.values()];
          }
        } else {
          const selectCols = includeGridData
            ? "tab_name, row_count, col_count, values_grid, notes_grid"
            : "tab_name, row_count, col_count";
          const { data: tabRows } = await supabase
            .from("master_sheet_grids")
            .select(selectCols)
            .eq("client_name", ctx.clientName)
            .eq("sheet_role", sheetRole)
            .order("tab_name", { ascending: true });
          allTabs = (tabRows || []).map((r) => ({ ...r, formulas_grid: r.values_grid }));
        }
      }

      if (sheetRole === "recon") {
        allTabs.sort((a, b) => {
          const aIsMonth = /^\d{4}$/.test(a.tab_name);
          const bIsMonth = /^\d{4}$/.test(b.tab_name);
          if (aIsMonth && bIsMonth) return b.tab_name.localeCompare(a.tab_name);
          if (aIsMonth !== bIsMonth) return aIsMonth ? -1 : 1;
          return a.tab_name.localeCompare(b.tab_name);
        });
      }
    }

    const sheetsPayload = allTabs.map((t, idx) => {
      const sId = hashTabNameToSheetId_(t.tab_name);
      const sheetObj = {
        properties: {
          sheetId: sId,
          title: t.tab_name,
          index: idx,
          gridProperties: {
            rowCount: Math.max(1000, t.row_count || 0),
            columnCount: Math.max(50, t.col_count || 0),
          },
        },
      };

      if (sheetRole === "client" && (t.tab_name === "Confirmed" || t.tab_name === "Pipeline") && Array.isArray(t.values_grid)) {
        const vals = t.values_grid;
        const derivedRowGroups = [];
        for (let r = 1; r < vals.length; r++) {
          const tag = String(vals[r]?.[2] || "");
          if (!tag.includes("[Retainer Master")) continue;
          let endChild = r + 1;
          while (endChild < vals.length) {
            const cTag = String(vals[endChild]?.[2] || "");
            if (!cTag.includes("[Retainer") || cTag.includes("[Retainer Master")) break;
            endChild++;
          }
          if (endChild > r + 1) {
            derivedRowGroups.push({
              range: {
                sheetId: sId,
                dimension: "ROWS",
                startIndex: r + 1,
                endIndex: endChild,
              },
              depth: 1,
            });
          }
        }
        if (derivedRowGroups.length > 0) {
          sheetObj.rowGroups = derivedRowGroups;
        }
      }

      if (includeGridData) {
        const matchingRanges =
          requestedRanges.length > 0
            ? requestedRanges.map((r) => parseA1Range(r, t.tab_name)).filter((p) => p.tabName === t.tab_name)
            : [{ tabName: t.tab_name, startRow0: 0, endRow0: (t.row_count || 1) - 1, startCol0: 0, endCol0: (t.col_count || 1) - 1 }];

        if (matchingRanges.length > 0) {
          const fieldsStr = String(params.fields || "");
          const wantFormulas = !fieldsStr || fieldsStr.includes("userEnteredValue");
          const isNotesOnlyReq =
            fieldsStr.includes("note") &&
            !fieldsStr.includes("formattedValue") &&
            !fieldsStr.includes("effectiveValue") &&
            !fieldsStr.includes("userEnteredValue") &&
            !fieldsStr.includes("effectiveFormat");

          sheetObj.data = matchingRanges.map((mr) => {
            const mrStartR = mr.startRow0 ?? 0;
            const mrStartC = mr.startCol0 ?? 0;
            let maxNoteRowCount = 0;
            const noteMaxColCountByRow = new Map();
            if (t.notes_grid && typeof t.notes_grid === "object") {
              for (const nKey of Object.keys(t.notes_grid)) {
                if (nKey.startsWith("__") || !t.notes_grid[nKey]) continue;
                const colonIdx = nKey.indexOf(":");
                if (colonIdx <= 0) continue;
                const nr = parseInt(nKey.slice(0, colonIdx), 10);
                const nc = parseInt(nKey.slice(colonIdx + 1), 10);
                if (Number.isNaN(nr) || Number.isNaN(nc)) continue;
                if (
                  nr >= mrStartR &&
                  (mr.endRow0 == null || nr <= mr.endRow0) &&
                  nc >= mrStartC &&
                  (mr.endCol0 == null || nc <= mr.endCol0)
                ) {
                  const rOffset = nr - mrStartR;
                  const cCount = nc - mrStartC + 1;
                  if (rOffset + 1 > maxNoteRowCount) maxNoteRowCount = rOffset + 1;
                  if (cCount > (noteMaxColCountByRow.get(rOffset) || 0)) {
                    noteMaxColCountByRow.set(rOffset, cCount);
                  }
                }
              }
            }

            if (isNotesOnlyReq) {
              const rowData = [];
              for (let rOffset = 0; rOffset < maxNoteRowCount; rOffset++) {
                const colCount = noteMaxColCountByRow.get(rOffset) || 0;
                if (colCount === 0) {
                  rowData.push({ values: [] });
                  continue;
                }
                const absR = mrStartR + rOffset;
                const values = [];
                for (let cOffset = 0; cOffset < colCount; cOffset++) {
                  const absC = mrStartC + cOffset;
                  const noteStr = t.notes_grid?.[`${absR}:${absC}`] || "";
                  values.push(noteStr ? { note: noteStr } : {});
                }
                rowData.push({ values });
              }
              return {
                startRow: mrStartR,
                startColumn: mrStartC,
                rowData,
              };
            }

            const slicedVals = sliceGrid2D_(t.values_grid || [], mr);
            const slicedForms = wantFormulas ? sliceGrid2D_(t.formulas_grid || t.values_grid || [], mr) : [];
            const rowCount = Math.max(
              slicedVals.length,
              slicedForms.length,
              maxNoteRowCount,
              t.tab_name === "Cash" && mr.endRow0 != null ? Math.min(76, mr.endRow0 + 1) - mrStartR : 0
            );
            const rowData = [];
            for (let rOffset = 0; rOffset < rowCount; rOffset++) {
              const absR = mrStartR + rOffset;
              const rArr = slicedVals[rOffset] || [];
              const fArr = slicedForms[rOffset] || [];
              const colCount = Math.max(
                rArr.length,
                fArr.length,
                noteMaxColCountByRow.get(rOffset) || 0,
                t.tab_name === "Cash" && mr.endCol0 != null ? Math.min(37, mr.endCol0 + 1) - mrStartC : 0
              );
              const values = [];
              for (let cOffset = 0; cOffset < colCount; cOffset++) {
                const absC = (mr.startCol0 ?? 0) + cOffset;
                const cellVal = rArr[cOffset];
                const strVal = cellVal == null ? "" : String(cellVal);
                const dispVal = formatCellForDisplay(
                  sheetRole,
                  t.tab_name,
                  absR,
                  absC,
                  cellVal,
                  t.values_grid,
                  t.notes_grid
                );
                const formVal = fArr[cOffset] == null ? strVal : String(fArr[cOffset]);
                const numClean = typeof cellVal === "number" ? cellVal : parseFloat(strVal.replace(/[£$€,\s]/g, ""));
                const isNumeric =
                  typeof cellVal === "number" ||
                  (strVal !== "" && !isNaN(numClean) && /^[-+]?[£$€]?\s*[\d,]+(\.\d+)?%?$/.test(strVal.trim()));
                const noteKey = `${absR}:${absC}`;
                const noteStr = t.notes_grid?.[noteKey] || "";
                const baseEffFmt =
                  t.tab_name === "Cash"
                    ? getCashEffectiveFormat_(absR, absC)
                    : { backgroundColor: { red: 1, green: 1, blue: 1 } };
                const savedBg = t.notes_grid?.__bg_colors?.[`${absR}:${absC}`];
                const effFmt = savedBg ? { ...baseEffFmt, backgroundColor: savedBg } : baseEffFmt;
                const cellObj = {
                  effectiveValue: isNumeric ? { numberValue: numClean } : { stringValue: strVal },
                  userEnteredValue: formVal.startsWith("=")
                    ? { formulaValue: formVal }
                    : isNumeric
                      ? { numberValue: numClean }
                      : { stringValue: strVal },
                  note: noteStr,
                  effectiveFormat: effFmt,
                };
                if (dispVal !== "") {
                  cellObj.formattedValue = dispVal;
                }
                values.push(cellObj);
              }
              rowData.push({ values });
            }
            return {
              startRow: mr.startRow0 ?? 0,
              startColumn: mr.startCol0 ?? 0,
              rowData,
            };
          });
        }
      }
      return sheetObj;
    });

    if (targetTabNames && targetTabNames.size > 0) {
      const filteredSheets = sheetsPayload.filter((s) => targetTabNames.has(s.properties.title));
      return {
        status: 200,
        data: {
          spreadsheetId,
          properties: { title: `${ctx.clientName} (${sheetRole})` },
          sheets: filteredSheets.length > 0 ? filteredSheets : sheetsPayload,
        },
      };
    }

    return {
      status: 200,
      data: {
        spreadsheetId,
        properties: { title: `${ctx.clientName} (${sheetRole})` },
        sheets: sheetsPayload,
      },
    };
  }

  // 8. spreadsheets.batchUpdate (handles updateSheetProperties, updateCells, repeatCell backgroundColor, moveDimension, insertDimension, deleteDimension)
  if (namespace === "spreadsheets" && method === "batchUpdate") {
    const requests = params.requestBody?.requests || params.resource?.requests || [];
    const isBgRepeatCell_ = (req) => {
      const rng = req?.repeatCell?.range;
      if (!rng || !String(req?.repeatCell?.fields || "").includes("backgroundColor")) return false;
      const rCount = Math.max(
        0,
        Number(rng.endRowIndex ?? Number(rng.startRowIndex ?? 0) + 1) - Number(rng.startRowIndex ?? 0)
      );
      const cCount = Math.max(
        0,
        Number(rng.endColumnIndex ?? Number(rng.startColumnIndex ?? 0) + 1) - Number(rng.startColumnIndex ?? 0)
      );
      return rCount > 0 && cCount > 0 && rCount * cCount <= 20000;
    };
    const hasDataOrSheetUpdates = requests.some(
      (req) =>
        req.updateSheetProperties?.properties ||
        req.deleteSheet?.sheetId !== undefined ||
        req.updateCells?.range ||
        isBgRepeatCell_(req) ||
        (req.moveDimension?.source && req.moveDimension.source.dimension === "ROWS") ||
        (req.insertDimension?.range && req.insertDimension.range.dimension === "ROWS") ||
        (req.deleteDimension?.range && req.deleteDimension.range.dimension === "ROWS")
    );
    if (!hasDataOrSheetUpdates) {
      // Visual-only operations (row grouping, hiddenByUser, repeatCell formatting) require zero DB queries
      // and must NOT prematurely flush pending formula recomputes in the middle of a multi-step operation
      // unless explicitly requested via _flushPendingRecompute.
      if (sheetRole === "client" && ctx.sheetBridgeMode && ctx.sheetBridgeMode !== "off") {
        const hasRowGroupOrHideOps = requests.some(
          (req) =>
            req?.addDimensionGroup?.range?.dimension === "ROWS" ||
            req?.deleteDimensionGroup?.range?.dimension === "ROWS" ||
            req?.updateDimensionGroup?.dimensionGroup?.range?.dimension === "ROWS" ||
            (req?.updateDimensionProperties?.range?.dimension === "ROWS" &&
              String(req?.updateDimensionProperties?.fields || "").includes("hiddenByUser"))
        );
        if (hasRowGroupOrHideOps) {
          const visualMetaBySheetId = new Map(
            CORE_CLIENT_TABS.map((tn) => [hashTabNameToSheetId_(tn), { tab_name: tn }])
          );
          const visualTabs = new Set();
          for (const req of requests) {
            const sId =
              req?.addDimensionGroup?.range?.sheetId ??
              req?.deleteDimensionGroup?.range?.sheetId ??
              req?.updateDimensionGroup?.dimensionGroup?.range?.sheetId ??
              req?.updateDimensionProperties?.range?.sheetId ??
              null;
            const tn = sId !== null ? visualMetaBySheetId.get(sId)?.tab_name : null;
            if (tn) visualTabs.add(tn);
          }
          import("./clientSheetBridgeService.js")
            .then(({ recordBridgeStructuralRequests, scheduleOutboundSheetBridgeSync }) => {
              recordBridgeStructuralRequests(ctx.clientName, requests, visualMetaBySheetId);
              if (visualTabs.size > 0) {
                scheduleOutboundSheetBridgeSync(ctx.clientName, [...visualTabs]);
              }
            })
            .catch(() => { });
        }
      }
      if (sheetRole === "client" && params._flushPendingRecompute) {
        const pendingSet = _pendingClientTabsByClient.get(String(ctx.clientName || "").toLowerCase());
        if (pendingSet && pendingSet.size > 0) {
          if (params._syncFormulaRecompute) {
            await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
              console.warn("[masterEngineService] Client formula recompute warning:", e.message)
            );
          } else {
            await recomputeAndPersistImmediateClientTabs_(ctx, [], rawSheetsApi).catch((e) =>
              console.warn("[masterEngineService] Immediate client tab recompute warning:", e.message)
            );
          }
        }
      }
      return {
        status: 200,
        data: { spreadsheetId, replies: requests.map(() => ({})) },
      };
    }

    let tabMetaRows = [];
    let usingBlueprintMeta = false;
    if (sheetRole === "client") {
      if (ctx.clientComputeMode === "native") {
        const { data: bpRows } = await supabase
          .from("pulse_client_tab_blueprints")
          .select("id, tab_name")
          .eq("client_id", ctx.clientId)
          .order("tab_name", { ascending: true });
        if (Array.isArray(bpRows) && bpRows.length > 0) {
          tabMetaRows = bpRows.map((r) => ({ id: r.id, tab_name: r.tab_name, sheet_role: "client" }));
          usingBlueprintMeta = true;
        }
      }
      if (tabMetaRows.length === 0) {
        const { data: rows } = await supabase
          .from("master_sheet_grids")
          .select("id, tab_name, sheet_role")
          .eq("client_name", ctx.clientName)
          .or("sheet_role.eq.client,and(sheet_role.eq.master,tab_name.like.Client::%)")
          .order("tab_name", { ascending: true });
        const seen = new Set();
        for (const r of rows || []) {
          const cleanTab = r.tab_name.startsWith("Client::") ? r.tab_name.slice(8) : r.tab_name;
          if (seen.has(cleanTab)) continue;
          seen.add(cleanTab);
          tabMetaRows.push({ id: r.id, tab_name: cleanTab, sheet_role: "client" });
        }
      }
    } else if (sheetRole === "recon" && (ctx.reconReadMode === "relational" || ctx.syncOrchestratorMode === "native")) {
      const { isManagedReconTab, preloadClientRelationalReconBundle } = await import("./relationalReconService.js");
      const rBundle = await preloadClientRelationalReconBundle(ctx, { source: "db" });
      const reconTabNames = new Set(["KeyInfo", "PLAdds", "Data", "Template"]);
      for (const mKey of rBundle?.periodByMonth?.keys?.() || []) {
        reconTabNames.add(mKey);
      }
      for (const metaItem of Array.isArray(rBundle?.config?.tab_list) ? rBundle.config.tab_list : []) {
        const tn = typeof metaItem === "string" ? metaItem : metaItem?.tab_name;
        if (tn && isManagedReconTab(tn)) reconTabNames.add(tn);
      }
      tabMetaRows = [...reconTabNames].map((tn) => ({
        id: `rel-recon:${tn}`,
        tab_name: tn,
        sheet_role: "recon",
        isRelationalRecon: true,
      }));
      const stagePrefix = `${ctx.clientName.toLowerCase()}::recon::`;
      for (const [sKey, sRec] of _stagedCopiedTabsByClientRole.entries()) {
        if (sKey.startsWith(stagePrefix)) {
          tabMetaRows.push({
            id: `staged:${sRec.tab_name}`,
            tab_name: sRec.tab_name,
            sheet_role: "recon",
            isStagedTemp: true,
          });
        }
      }
    } else if (sheetRole === "master" && (ctx.masterComputeMode === "native" || ctx.syncOrchestratorMode === "native")) {
      const masterTabNames = [...new Set([...CORE_MASTER_TABS, "GasScriptProps", "GasExecLogs"])];
      tabMetaRows = masterTabNames.map((tn) => ({
        id: `rel-master:${tn}`,
        tab_name: tn,
        sheet_role: "master",
        isRelationalMaster: true,
      }));
    } else {
      const { data: rows } = await supabase
        .from("master_sheet_grids")
        .select("id, tab_name, sheet_role")
        .eq("client_name", ctx.clientName)
        .eq("sheet_role", sheetRole)
        .order("tab_name", { ascending: true });
      tabMetaRows = rows || [];
    }

    const metaBySheetId = new Map();
    const metaByTabName = new Map();
    tabMetaRows.forEach((t) => {
      metaBySheetId.set(hashTabNameToSheetId_(t.tab_name), t);
      metaByTabName.set(t.tab_name, t);
    });
    const renamePrefix = `${ctx.clientName.toLowerCase()}::${sheetRole}::`;
    for (const [aliasKey, newTabName] of _renamedVirtualSheetIds.entries()) {
      if (!aliasKey.startsWith(renamePrefix)) continue;
      const oldSheetId = Number(aliasKey.slice(renamePrefix.length));
      const matchedMeta = metaByTabName.get(newTabName);
      if (matchedMeta && Number.isFinite(oldSheetId) && !metaBySheetId.has(oldSheetId)) {
        metaBySheetId.set(oldSheetId, matchedMeta);
      }
    }

    const loadedTargetBySheetId = new Map();
    const getTargetTabRecord = async (sId) => {
      if (loadedTargetBySheetId.has(sId)) return loadedTargetBySheetId.get(sId);
      const meta = metaBySheetId.get(sId);
      if (!meta) return null;
      const stageKey = `${ctx.clientName.toLowerCase()}::${sheetRole}::${meta.tab_name}`;
      const staged = _stagedCopiedTabsByClientRole.get(stageKey);
      const rec = staged
        ? { ...staged, tab_name: meta.tab_name }
        : await getVirtualTabGridForWrite_(ctx, sheetRole, meta.tab_name, rawSheetsApi);
      rec.id = meta.id;
      rec.tab_name = meta.tab_name;
      loadedTargetBySheetId.set(sId, rec);
      return rec;
    };

    const dirtyTargets = new Map();
    const valueChangedClientTabs = new Set();
    const noteOnlyClientTabs = new Set();
    const clearedNotesClientTabs = new Set();
    const renamedReconTabs = new Set();
    const deletedReconTabs = new Set();

    for (const req of requests) {
      if (req.updateSheetProperties?.properties) {
        const props = req.updateSheetProperties.properties;
        const meta = metaBySheetId.get(props.sheetId);
        if (meta && props.title && props.title !== meta.tab_name) {
          const oldTabName = meta.tab_name;
          if (meta.isStagedTemp || meta.isRelationalRecon || meta.isRelationalMaster) {
            const oldStageKey = `${ctx.clientName.toLowerCase()}::${sheetRole}::${oldTabName}`;
            const prevRec = await getTargetTabRecord(props.sheetId);
            _stagedCopiedTabsByClientRole.delete(oldStageKey);
            meta.tab_name = props.title;
            meta.isStagedTemp = false;
            if (prevRec) {
              prevRec.tab_name = props.title;
              dirtyTargets.set(props.title, prevRec);
            }
          } else {
            await supabase
              .from(usingBlueprintMeta ? "pulse_client_tab_blueprints" : "master_sheet_grids")
              .update({ tab_name: props.title })
              .eq("id", meta.id);
            meta.tab_name = props.title;
          }
          if (_renamedVirtualSheetIds.size > 500) _renamedVirtualSheetIds.clear();
          _renamedVirtualSheetIds.set(`${renamePrefix}${props.sheetId}`, props.title);
          metaBySheetId.set(hashTabNameToSheetId_(props.title), meta);
          if (sheetRole === "recon") {
            if (/^\d{4}$/.test(String(oldTabName || "").trim())) {
              deletedReconTabs.add(oldTabName);
            }
            renamedReconTabs.add(props.title);
          }
        }
      } else if (req.deleteSheet?.sheetId !== undefined) {
        const meta = metaBySheetId.get(req.deleteSheet.sheetId);
        if (meta) {
          if (meta.isStagedTemp) {
            _stagedCopiedTabsByClientRole.delete(`${ctx.clientName.toLowerCase()}::${sheetRole}::${meta.tab_name}`);
          } else if (!meta.isRelationalRecon && !meta.isRelationalMaster) {
            await supabase
              .from(usingBlueprintMeta ? "pulse_client_tab_blueprints" : "master_sheet_grids")
              .delete()
              .eq("id", meta.id);
          }
          _renamedVirtualSheetIds.delete(`${renamePrefix}${req.deleteSheet.sheetId}`);
          metaBySheetId.delete(req.deleteSheet.sheetId);
          dirtyTargets.delete(meta.tab_name);
          if (sheetRole === "recon") {
            deletedReconTabs.add(meta.tab_name);
            renamedReconTabs.add("PLAdds");
          }
        }
      } else if (isBgRepeatCell_(req)) {
        const rng = req.repeatCell.range;
        const target = await getTargetTabRecord(rng.sheetId);
        if (target) {
          const sR = Math.max(0, Number(rng.startRowIndex ?? 0));
          const eR = Math.max(sR + 1, Number(rng.endRowIndex ?? sR + 1));
          const sC = Math.max(0, Number(rng.startColumnIndex ?? 0));
          const eC = Math.max(sC + 1, Number(rng.endColumnIndex ?? sC + 1));
          const nextNotes = { ...(target.notes_grid || {}) };
          const bgColors = { ...(nextNotes.__bg_colors || {}) };
          const bg =
            req.repeatCell?.cell?.userEnteredFormat?.backgroundColor ||
            req.repeatCell?.cell?.effectiveFormat?.backgroundColor ||
            null;
          const isWhiteReset =
            bg &&
            Number(bg.red ?? 0) >= 0.99 &&
            Number(bg.green ?? 0) >= 0.99 &&
            Number(bg.blue ?? 0) >= 0.99;
          for (let r = sR; r < eR; r++) {
            for (let c = sC; c < eC; c++) {
              const key = `${r}:${c}`;
              if (bg && !isWhiteReset) bgColors[key] = bg;
              else delete bgColors[key];
            }
          }
          nextNotes.__bg_colors = bgColors;
          target.notes_grid = nextNotes;
          dirtyTargets.set(target.tab_name, target);
          if (sheetRole === "client") {
            if (target.tab_name === "Outgoings") {
              valueChangedClientTabs.add(target.tab_name);
            } else {
              noteOnlyClientTabs.add(target.tab_name);
            }
          }
        }
      } else if (req.updateCells?.range) {
        const rng = req.updateCells.range;
        const target = await getTargetTabRecord(rng.sheetId);
        if (target && Array.isArray(req.updateCells.rows)) {
          const fieldsStr = String(req.updateCells.fields || "");
          const isNoteOnly = fieldsStr.includes("note") && !fieldsStr.includes("userEnteredValue");
          const nextNotes = { ...(target.notes_grid || {}) };
          const sR = rng.startRowIndex ?? 0;
          const sC = rng.startColumnIndex ?? 0;

          req.updateCells.rows.forEach((r, rOff) => {
            (r.values || []).forEach((v, cOff) => {
              if (v.note !== undefined) {
                const key = `${sR + rOff}:${sC + cOff}`;
                if (v.note) nextNotes[key] = String(v.note);
                else {
                  delete nextNotes[key];
                  if (sheetRole === "client") clearedNotesClientTabs.add(target.tab_name);
                }
              }
            });
          });

          if (isNoteOnly) {
            target.notes_grid = nextNotes;
            dirtyTargets.set(target.tab_name, target);
            if (sheetRole === "client") {
              if (target.tab_name === "Outgoings") {
                valueChangedClientTabs.add(target.tab_name);
              } else {
                noteOnlyClientTabs.add(target.tab_name);
              }
            }
          } else {
            const incoming = req.updateCells.rows.map((r) =>
              (r.values || []).map((v) => {
                const uev = v.userEnteredValue || {};
                return uev.stringValue ?? uev.numberValue ?? uev.boolValue ?? uev.formulaValue ?? "";
              })
            );
            const parsed = {
              tabName: target.tab_name,
              startRow0: sR,
              startCol0: sC,
            };
            const nextVals = applyWriteToGrid2D_(target.values_grid || [], parsed, incoming, {
              sheetRole,
              tabName: target.tab_name,
              notesGrid: nextNotes,
              isFormulaGrid: false,
            });
            const nextForms = applyWriteToGrid2D_(target.formulas_grid || target.values_grid || [], parsed, incoming, {
              sheetRole,
              tabName: target.tab_name,
              notesGrid: nextNotes,
              isFormulaGrid: true,
            });
            target.values_grid = nextVals;
            target.formulas_grid = nextForms;
            target.notes_grid = nextNotes;
            dirtyTargets.set(target.tab_name, target);
            if (sheetRole === "client") valueChangedClientTabs.add(target.tab_name);
          }
        }
      } else if (req.moveDimension?.source && req.moveDimension.source.dimension === "ROWS") {
        const src = req.moveDimension.source;
        const target = await getTargetTabRecord(src.sheetId);
        if (target) {
          const s = Math.max(0, Number(src.startIndex ?? 0));
          const e = Math.max(s, Number(src.endIndex ?? s + 1));
          const count = e - s;
          const d = Math.max(0, Number(req.moveDimension.destinationIndex ?? 0));
          const nextVals = (target.values_grid || []).map((r) => (Array.isArray(r) ? [...r] : []));
          const nextForms = (target.formulas_grid || target.values_grid || []).map((r, r0) => ({
            oldR1: r0 + 1,
            cells: Array.isArray(r) ? [...r] : [],
          }));
          if (count > 0 && s < nextVals.length && d !== s) {
            const movedV = nextVals.splice(s, count);
            const movedF = nextForms.splice(s, count);
            const insertAt = d <= s ? d : Math.max(0, d - count);
            nextVals.splice(insertAt, 0, ...movedV);
            nextForms.splice(insertAt, 0, ...movedF);
            const oldRow1ToNewRow1 = new Map();
            nextForms.forEach((fObj, newR0) => {
              oldRow1ToNewRow1.set(fObj.oldR1, newR0 + 1);
            });
            const finalForms = nextForms.map((fObj) =>
              fObj.cells.map((cell) =>
                typeof cell === "string" && cell.startsWith("=")
                  ? cell.replace(SAME_SHEET_FORMULA_REF_RE_, (match, crossSheetRef, colPart, dollarRow, rowStr) => {
                    if (crossSheetRef || !colPart || /^PL$/i.test(colPart)) return match;
                    const oldR1 = parseInt(rowStr, 10);
                    const mappedR1 = oldRow1ToNewRow1.get(oldR1);
                    return mappedR1 && mappedR1 !== oldR1 ? `${colPart}${dollarRow}${mappedR1}` : match;
                  })
                  : cell
              )
            );
            target.values_grid = nextVals;
            target.formulas_grid = finalForms;
            target.notes_grid = remapNotesGridRows_(target.notes_grid, (oldR0) => {
              if (oldR0 >= s && oldR0 < s + count) return insertAt + (oldR0 - s);
              if (s < insertAt && oldR0 >= s + count && oldR0 < insertAt + count) return oldR0 - count;
              if (insertAt < s && oldR0 >= insertAt && oldR0 < s) return oldR0 + count;
              return oldR0;
            });
            dirtyTargets.set(target.tab_name, target);
            if (sheetRole === "client") valueChangedClientTabs.add(target.tab_name);
          }
        }
      } else if (req.insertDimension?.range && req.insertDimension.range.dimension === "ROWS") {
        const rng = req.insertDimension.range;
        const target = await getTargetTabRecord(rng.sheetId);
        if (target) {
          const s = Math.max(0, Number(rng.startIndex ?? 0));
          const e = Math.max(s, Number(rng.endIndex ?? s + 1));
          const count = e - s;
          if (count > 0) {
            if (s > 50000 || s + count > 50000 || (target.values_grid || []).length + count > 50000) {
              throw new Error(`insertDimension exceeds maximum virtual sheet row limit (50000)`);
            }
            const nextVals = (target.values_grid || []).map((r) => (Array.isArray(r) ? [...r] : []));
            const nextForms = (target.formulas_grid || target.values_grid || []).map((r, r0) => ({
              oldR1: r0 + 1,
              cells: Array.isArray(r) ? [...r] : [],
            }));
            while (nextVals.length < s) nextVals.push([]);
            while (nextForms.length < s) nextForms.push({ oldR1: nextForms.length + 1, cells: [] });

            const inherit = Boolean(req.insertDimension.inheritFromBefore) && s > 0;
            const rawDonorCells = inherit && nextForms[s - 1] ? nextForms[s - 1].cells : [];
            const rowBelowCells = inherit && nextForms[s] ? nextForms[s].cells : [];
            const tplFormCells = inherit
              ? rawDonorCells.map((c, colIdx) => {
                if (typeof c !== "string" || !c.startsWith("=")) return "";
                // Skip Row-2 vertical spill anchors when Row 3 does not hold a formula in that column
                if (s === 2 && !(typeof rowBelowCells[colIdx] === "string" && rowBelowCells[colIdx].startsWith("="))) {
                  return "";
                }
                return c;
              })
              : [];

            const insertedV = Array.from({ length: count }, () => []);
            const insertedF = Array.from({ length: count }, (_, k) => ({
              isInserted: true,
              cells: tplFormCells.map((cell) => {
                if (typeof cell !== "string" || !cell.startsWith("=")) return "";
                const withShiftedBelow = shiftRelativeRowsAboveThreshold_(cell, s + 1, count);
                // Shift inherited relative refs <= s by +(k + 1) without double-shifting refs that were >= s + 1 or cross-sheet refs
                return withShiftedBelow.replace(SAME_SHEET_FORMULA_REF_RE_, (match, crossSheetRef, colPart, dollarRow, rowStr) => {
                  if (crossSheetRef || !colPart || dollarRow === "$" || /^PL$/i.test(colPart)) return match;
                  const rNum = parseInt(rowStr, 10);
                  if (rNum > s) return match;
                  return `${colPart}${Math.max(1, rNum + k + 1)}`;
                });
              }),
            }));
            nextVals.splice(s, 0, ...insertedV);
            nextForms.splice(s, 0, ...insertedF);

            const finalForms = nextForms.map((fObj) => {
              if (fObj.isInserted) return fObj.cells;
              return fObj.cells.map((cell) => shiftRelativeRowsAboveThreshold_(cell, s + 1, count));
            });
            target.values_grid = nextVals;
            target.formulas_grid = finalForms;
            target.notes_grid = remapNotesGridRows_(target.notes_grid, (oldR0) =>
              oldR0 >= s ? oldR0 + count : oldR0
            );
            dirtyTargets.set(target.tab_name, target);
            if (sheetRole === "client") valueChangedClientTabs.add(target.tab_name);
          }
        }
      } else if (req.deleteDimension?.range && req.deleteDimension.range.dimension === "ROWS") {
        const rng = req.deleteDimension.range;
        const target = await getTargetTabRecord(rng.sheetId);
        if (target) {
          const s = Math.max(0, Number(rng.startIndex ?? 0));
          const e = Math.max(s, Number(rng.endIndex ?? s + 1));
          const count = e - s;
          const nextVals = (target.values_grid || []).map((r) => (Array.isArray(r) ? [...r] : []));
          const nextForms = (target.formulas_grid || target.values_grid || []).map((r, r0) => ({
            oldR1: r0 + 1,
            cells: Array.isArray(r) ? [...r] : [],
          }));
          if (count > 0 && s < nextVals.length) {
            nextVals.splice(s, count);
            nextForms.splice(s, count);
            const finalForms = nextForms.map((fObj) =>
              fObj.cells.map((cell) => shiftRelativeRowsAboveThreshold_(cell, e + 1, -count))
            );
            target.values_grid = nextVals;
            target.formulas_grid = finalForms;
            target.notes_grid = remapNotesGridRows_(target.notes_grid, (oldR0) => {
              if (oldR0 >= s && oldR0 < s + count) return -1;
              if (oldR0 >= s + count) return oldR0 - count;
              return oldR0;
            });
            dirtyTargets.set(target.tab_name, target);
            if (sheetRole === "client") valueChangedClientTabs.add(target.tab_name);
          }
        }
      }
    }

    const pendingClientSet = _pendingClientTabsByClient.get(String(ctx.clientName || "").toLowerCase());
    const willRunClientFormulaRecompute =
      sheetRole === "client" &&
      !params._skipFormulaRecompute &&
      (valueChangedClientTabs.size > 0 || (pendingClientSet && pendingClientSet.size > 0));

    for (const [tabName, target] of dirtyTargets.entries()) {
      bumpTabWriteRevision_(ctx.clientName, sheetRole, tabName);
      const isDeferredClientSave =
        sheetRole === "client" &&
        !["Sessions", "AppLog", "Welcome"].includes(tabName) &&
        (Boolean(params._skipFormulaRecompute) || willRunClientFormulaRecompute);
      await saveVirtualTabGrid_(
        ctx,
        sheetRole,
        tabName,
        target.values_grid || [],
        target.formulas_grid || [],
        target.notes_grid || {},
        { memoryOnly: isDeferredClientSave, allowClearAllNotes: clearedNotesClientTabs.has(tabName) }
      );
    }

    if (sheetRole === "client") {
      if (params._skipFormulaRecompute) {
        if (valueChangedClientTabs.size > 0 || dirtyTargets.size > 0) {
          queuePendingClientTabs_(ctx, [...valueChangedClientTabs, ...dirtyTargets.keys()], {
            isSkippedStep: true,
            notesChangedTabs: [...dirtyTargets.keys()],
            allowClearAllNotesTabs: [...clearedNotesClientTabs],
          });
        }
      } else if (willRunClientFormulaRecompute) {
        if (params._syncFormulaRecompute) {
          if (clearedNotesClientTabs.size > 0) {
            queuePendingClientTabs_(ctx, [], { allowClearAllNotesTabs: [...clearedNotesClientTabs] });
          }
          await recomputeClientFormulasAfterVirtualWrite_(
            ctx,
            [...valueChangedClientTabs, ...dirtyTargets.keys()],
            rawSheetsApi
          ).catch((e) =>
            console.warn("[masterEngineService] Client formula recompute warning:", e.message)
          );
        } else {
          await recomputeAndPersistImmediateClientTabs_(
            ctx,
            [...valueChangedClientTabs, ...dirtyTargets.keys()],
            rawSheetsApi,
            {
              notesChangedTabs: new Set(dirtyTargets.keys()),
              allowClearAllNotesTabs: clearedNotesClientTabs,
              deferBackgroundRecompute: Boolean(params._deferBackgroundRecompute),
            }
          ).catch((e) =>
            console.warn("[masterEngineService] Immediate client tab recompute warning:", e.message)
          );
        }
      } else if (noteOnlyClientTabs.size > 0) {
        const noteTabsArr = [...noteOnlyClientTabs];
        const noteGrids = {};
        for (const [tName, rec] of dirtyTargets.entries()) {
          noteGrids[tName] = {
            values: rec.values_grid || [],
            formulas: rec.formulas_grid || [],
            notes: rec.notes_grid || {},
          };
        }
        await syncPhase2RelationalJobsIfEnabled_(ctx, noteTabsArr, noteGrids);
        await syncPhase3OperatingInputsIfEnabled_(ctx, noteTabsArr, noteGrids, {
          allowClearAllNotes: noteTabsArr.some((t) => clearedNotesClientTabs.has(t)),
        });
        await syncPhase5FinancialsIfEnabled_(ctx, noteTabsArr, noteGrids);
        syncStructuredClientTablesFromGrids_(ctx, noteGrids, noteTabsArr).catch((e) =>
          console.warn("[masterEngineService] Stage 4 relational note sync warning:", e.message)
        );
      }

      if (ctx.sheetBridgeMode && ctx.sheetBridgeMode !== "off") {
        import("./clientSheetBridgeService.js")
          .then(({ recordBridgeStructuralRequests, scheduleOutboundSheetBridgeSync }) => {
            recordBridgeStructuralRequests(ctx.clientName, requests, metaBySheetId);
            if (dirtyTargets.size > 0) {
              scheduleOutboundSheetBridgeSync(ctx.clientName, [...dirtyTargets.keys()]);
            }
          })
          .catch(() => { });
      }
    } else if (sheetRole === "master") {
      const touchedMasterTabs = [...dirtyTargets.keys()];
      if (touchedMasterTabs.length > 0) {
        if (!params._skipMasterFormulaRecompute) {
          await recomputeMasterFormulasAfterVirtualWrite_(ctx, touchedMasterTabs, rawSheetsApi).catch((e) =>
            console.warn("[masterEngineService] Master formula recompute after batchUpdate warning:", e.message)
          );
        }
        await syncPhase4MasterIngestionIfEnabled_(ctx, touchedMasterTabs);
      }
    } else if (sheetRole === "recon") {
      const touchedReconTabs = [...new Set([...dirtyTargets.keys(), ...renamedReconTabs])];
      if (touchedReconTabs.length > 0 || deletedReconTabs.size > 0) {
        await syncPhase4ReconIfEnabled_(ctx, touchedReconTabs, {
          deletedMonthKeys: [...deletedReconTabs],
        });
        if (ctx.masterComputeMode === "native") {
          import("./nativeMasterComparisonService.js")
            .then(({ invalidateClientNativeMasterCompCache }) => invalidateClientNativeMasterCompCache(ctx.clientName))
            .catch(() => { });
        }
      }
    }

    return {
      status: 200,
      data: { spreadsheetId, replies: requests.map(() => ({})) },
    };
  }

  // 9. spreadsheets.sheets.copyTo (used by reconTabService when duplicating Template -> YYMM)
  if (namespace === "sheets" && method === "copyTo") {
    let sourceTabName = "Template";
    let knownTabNames = [];
    if (sheetRole === "recon" && (ctx.reconReadMode === "relational" || ctx.syncOrchestratorMode === "native")) {
      try {
        const { preloadClientRelationalReconBundle } = await import("./relationalReconService.js");
        const rBundle = await preloadClientRelationalReconBundle(ctx, { source: "db" });
        knownTabNames = [...new Set(["KeyInfo", "PLAdds", "Data", "Template", ...Array.from(rBundle?.periodByMonth?.keys?.() || [])])];
      } catch { }
    } else if (supabase) {
      const { data: metaTabs } = await supabase
        .from("master_sheet_grids")
        .select("tab_name")
        .eq("client_name", ctx.clientName)
        .eq("sheet_role", sheetRole)
        .order("tab_name", { ascending: true });
      knownTabNames = (metaTabs || []).map((t) => t.tab_name).filter(Boolean);
    }
    if (params.sheetId !== undefined && params.sheetId !== null) {
      const matched = knownTabNames.find((tn) => hashTabNameToSheetId_(tn) === Number(params.sheetId));
      if (matched) sourceTabName = matched;
    }
    const sourceRec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, sourceTabName, rawSheetsApi);
    const tempTitle = `Copy of ${sourceTabName} ${Date.now().toString().slice(-4)}`;
    if (ctx.gridStorageRetired || (sheetRole === "recon" && ctx.syncOrchestratorMode === "native")) {
      const stageKey = `${ctx.clientName.toLowerCase()}::${sheetRole}::${tempTitle}`;
      _stagedCopiedTabsByClientRole.set(stageKey, {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: sheetRole,
        tab_name: tempTitle,
        values_grid: (sourceRec.values_grid || []).map((r) => (Array.isArray(r) ? [...r] : [])),
        formulas_grid: (sourceRec.formulas_grid || sourceRec.values_grid || []).map((r) => (Array.isArray(r) ? [...r] : [])),
        notes_grid: sourceRec.notes_grid && typeof sourceRec.notes_grid === "object" ? { ...sourceRec.notes_grid } : {},
      });
    } else {
      await saveVirtualTabGrid_(
        ctx,
        sheetRole,
        tempTitle,
        sourceRec.values_grid || [],
        sourceRec.formulas_grid || [],
        sourceRec.notes_grid || {}
      );
      if (supabase) {
        const { data: tabRows } = await supabase
          .from("master_sheet_grids")
          .select("tab_name")
          .eq("client_name", ctx.clientName)
          .eq("sheet_role", sheetRole)
          .order("tab_name", { ascending: true });
        knownTabNames = (tabRows || []).map((t) => t.tab_name).filter(Boolean);
      }
    }
    const idx = knownTabNames.findIndex((t) => t === tempTitle);
    const newSheetId = hashTabNameToSheetId_(tempTitle);
    return {
      status: 200,
      data: {
        sheetId: newSheetId,
        title: tempTitle,
        index: idx >= 0 ? idx : 0,
      },
    };
  }

  return { status: 200, data: {} };
}

/**
 * Extracts structured settings from a KeyInfo 2D grid and upserts public.tenant_key_info
 */
async function syncStructuredKeyInfoFromGrid_(ctx, keyInfoGrid) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !Array.isArray(keyInfoGrid)) return;

  const cell = (r1, cLetter) => {
    const r0 = r1 - 1;
    const c0 = colLetterToIdx0(cLetter);
    return String(keyInfoGrid[r0]?.[c0] ?? "").trim();
  };

  const rangeCol = (cLetter, startR1, endR1) => {
    const c0 = colLetterToIdx0(cLetter);
    const out = [];
    for (let r = startR1 - 1; r <= endR1 - 1; r++) {
      const v = String(keyInfoGrid[r]?.[c0] ?? "").trim();
      if (v) out.push(v);
    }
    return out;
  };

  const nonCashAccounts = [];
  for (let r = 22; r <= 27; r++) {
    const name = String(keyInfoGrid[r]?.[colLetterToIdx0("H")] ?? "").trim();
    const accId = String(keyInfoGrid[r]?.[colLetterToIdx0("I")] ?? "").trim();
    if (name && !name.toLowerCase().includes("non-cash") && !name.endsWith(":")) {
      nonCashAccounts.push({ name, id: accId });
    }
  }

  const overheadMappings = [];
  for (let r = 1; r < Math.min(keyInfoGrid.length, 210); r++) {
    const plCat = String(keyInfoGrid[r]?.[colLetterToIdx0("AZ")] ?? "").trim();
    const outCat = String(keyInfoGrid[r]?.[colLetterToIdx0("BA")] ?? "").trim();
    if (plCat || outCat) {
      overheadMappings.push({ row: r + 1, plCategory: plCat, outgoingsCategory: outCat });
    }
  }

  const payload = {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    normalized_key: ctx.normalizedKey || normalizeClientKey_(ctx.clientName),
    fy_start_date: formatCellForDisplay("master", "KeyInfo", 1, 1, keyInfoGrid[1]?.[1], keyInfoGrid),
    revenue_or_income_mode: cell(15, "B") || "Revenue",
    direct_costs_mode: cell(8, "D") || "Contractors",
    accounting_tool: cell(4, "Q") || "None",
    crm_tool: cell(8, "Q") || "None",
    crm_drives: cell(9, "Q") || "NA",
    primary_currency: cell(17, "B") || "GBP",
    currency_symbol: cell(4, "D") || "£",
    invoice_method: cell(8, "F") || "Whole",
    contractor_categories: rangeCol("AT", 4, 22),
    passthrough_categories: rangeCol("AT", 24, 40),
    tracked_bank_accounts: rangeCol("H", 12, 21).filter(
      (n) => !n.toLowerCase().includes("non-cash") && !n.endsWith(":")
    ),
    tracked_non_cash_accounts: nonCashAccounts,
    overhead_mappings: overheadMappings,
    product_lines: rangeCol("B", 23, 37),
    lead_sources: [...rangeCol("G", 32, 60), ...rangeCol("G", 63, 72)],
    updated_at: new Date().toISOString(),
  };

  await supabase.from("tenant_key_info").upsert(payload, { onConflict: "client_id" });
}

function parseNumericVal_(val) {
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  if (val == null || val === "") return 0;
  const s = String(val).trim();
  const isParen = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()£$€,\s]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return isParen ? -Math.abs(num) : num;
}

/**
 * Extracts structured Bank Recon period summary and items from a Recon YYMM grid
 */
async function syncReconPeriodAndItemsFromGrid_(ctx, monthKey, grid) {
  if (ctx.reconMode === "native" || ctx.gridStorageRetired) {
    const { reconcileClientReconFromGrids } = await import("./relationalReconService.js");
    await reconcileClientReconFromGrids(ctx, [monthKey], {
      gridsOverride: { [monthKey]: grid },
    });
    return;
  }
  const supabase = getSupabaseAdmin();
  if (!supabase || !Array.isArray(grid) || !/^\d{4}$/.test(monthKey)) return;

  const yy = monthKey.slice(0, 2);
  const mm = monthKey.slice(2, 4);
  const isoMonth = `20${yy}-${mm}`;

  const da1Raw = String(grid[0]?.[colLetterToIdx0("DA")] ?? "").trim();
  const accountingPlatform = da1Raw.toLowerCase().includes("quick") ? "Quickbooks" : "Xero";
  const cr2Raw = grid[1]?.[colLetterToIdx0("CR")];
  const isComplete = Boolean(cr2Raw === true || String(cr2Raw ?? "").trim().toUpperCase() === "TRUE");

  // Totals in U3:X16 (rows 2..15, cols 20..23)
  const actualsSummary = {};
  for (let r = 2; r <= 15; r++) {
    const label = String(grid[r]?.[20] ?? "").trim();
    if (!label || label.toLowerCase() === "total") continue;
    actualsSummary[label] = {
      out: String(grid[r]?.[21] ?? ""),
      in: String(grid[r]?.[22] ?? ""),
      net: parseNumericVal_(grid[r]?.[23]),
      formattedNet: String(grid[r]?.[23] ?? "£0.00"),
    };
  }

  await supabase.from("bank_recon_periods").upsert(
    {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      month_key: monthKey,
      iso_month: isoMonth,
      accounting_platform: accountingPlatform,
      is_complete: isComplete,
      actuals_summary: actualsSummary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_id,month_key" }
  );

  // Extract reconciled bank transactions (A3:Q200 -> rows 2..199) and unreconciled items (CD4:CN60 -> rows 3..59, cols 81..91)
  const itemsToInsert = [];
  for (let r = 2; r < Math.min(grid.length, 200); r++) {
    const row = grid[r] || [];
    const txnDate = formatCellForDisplay("recon", monthKey, r, 1, row[1] || row[0], grid);
    const accountName = String(row[2] || "").trim();
    const payee = String(row[3] || row[4] || "").trim();
    const particulars = String(row[4] || "").trim();
    const ref = String(row[6] || row[5] || "").trim();
    const outAmt = parseNumericVal_(row[8]);
    const inAmt = parseNumericVal_(row[9]);
    const category = String(row[16] || "").trim();
    if (!txnDate && !payee && !outAmt && !inAmt) continue;
    itemsToInsert.push({
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      month_key: monthKey,
      item_type: "reconciled",
      row_index: r + 1,
      is_reconciled: true,
      txn_date: txnDate,
      account_name: accountName,
      payee,
      particulars,
      reference: ref,
      out_amount: outAmt,
      in_amount: inAmt,
      net_amount: inAmt - outAmt,
      vat_amount: 0,
      category,
    });
  }

  const colCD = colLetterToIdx0("CD"); // 81
  for (let r = 3; r < Math.min(grid.length, 60); r++) {
    const row = grid[r] || [];
    const dateVal = row[colCD + 2] ?? row[colCD]; // CF for Xero, CD for QB
    const txnDate = formatCellForDisplay("recon", monthKey, r, colCD + 2, dateVal, grid);
    const payee = String(row[colCD + 3] || "").trim(); // CG
    const particulars = String(row[colCD + 4] || "").trim(); // CH
    const rawAmt = parseNumericVal_(row[colCD + 5]); // CI
    const cat = String(row[colCD + 9] || "").trim(); // CM
    const vatApplies = String(row[colCD + 10] || "No").trim(); // CN
    const vatAmt = vatApplies.toLowerCase() === "yes" ? Math.round(Math.abs(rawAmt) * (20 / 120) * 100) / 100 : 0;
    const netAmt = Math.round((Math.abs(rawAmt) - vatAmt) * 100) / 100;
    if (!txnDate && !payee && !rawAmt) continue;
    itemsToInsert.push({
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      month_key: monthKey,
      item_type: "unreconciled",
      row_index: r + 1,
      is_reconciled: false,
      txn_date: txnDate,
      account_name: "",
      payee,
      particulars,
      reference: "",
      out_amount: rawAmt < 0 ? Math.abs(rawAmt) : 0,
      in_amount: rawAmt > 0 ? rawAmt : 0,
      net_amount: netAmt,
      vat_amount: vatAmt,
      category: cat,
      vat_applies: vatApplies,
      is_excluded: false,
    });
  }

  await supabase
    .from("bank_recon_items")
    .delete()
    .eq("client_name", ctx.clientName)
    .eq("month_key", monthKey);

  if (itemsToInsert.length > 0) {
    for (let i = 0; i < itemsToInsert.length; i += 200) {
      await supabase.from("bank_recon_items").insert(itemsToInsert.slice(i, i + 200));
    }
  }
}

/**
 * Full 1-click migration of a client's Master Sheet & Recon Sheet into Supabase Stage 2 tables
 */
export async function migrateClientMasterAndReconToSupabase(sheets, clientName = "APPTEST") {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  invalidateMasterEngineCache(clientName, null, null, { invalidateSheetContext: true });
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found in Supabase clients registry.`);
  if (isVirtualSupabaseSheetId(ctx.masterSheetId) && isVirtualSupabaseSheetId(ctx.reconSheetId)) {
    throw new Error(`Client "${clientName}" was provisioned directly in Supabase and has no Google Master or Recon sheets to sync from.`);
  }

  const summary = {
    clientName: ctx.clientName,
    masterTabsSynced: 0,
    reconTabsSynced: 0,
    invoicesCount: 0,
    directCostsCount: 0,
    plLinesCount: 0,
    crmDealsCount: 0,
    timeEntriesCount: 0,
    reconPeriodsCount: 0,
    reconItemsCount: 0,
    learningPatternsCount: 0,
  };

  // 1. Fetch Master Sheet metadata & tabs (bypassing virtual router so we read live legacy sheet)
  if (ctx.masterSheetId && !isVirtualSupabaseSheetId(ctx.masterSheetId)) {
    const masterMeta = await sheets.spreadsheets.get({
      spreadsheetId: ctx.masterSheetId,
      fields: "sheets.properties.title",
      _bypassSupabaseVirtualSheet: true,
    });
    const existingMasterTabs = new Set((masterMeta.data.sheets || []).map((s) => s.properties.title));
    const orderedCore = CORE_MASTER_TABS.filter((t) => existingMasterTabs.has(t));
    const extraTabs = [...existingMasterTabs].filter(
      (t) => !CORE_MASTER_TABS.includes(t) && t !== "GasExecLogs" && t !== "GasScriptProps"
    );
    const tabsToPull = [...orderedCore, ...extraTabs];

    let migratedInvMode = "Whole";
    const pulledMasterGrids = {};

    for (let i = 0; i < tabsToPull.length; i += 6) {
      const chunk = tabsToPull.slice(i, i + 6);
      const ranges = chunk.map((t) => `'${t}'`);
      const [valBatch, formBatch] = await Promise.all([
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: ctx.masterSheetId,
          ranges,
          valueRenderOption: "UNFORMATTED_VALUE",
          _bypassSupabaseVirtualSheet: true,
        }),
        sheets.spreadsheets.values
          .batchGet({
            spreadsheetId: ctx.masterSheetId,
            ranges,
            valueRenderOption: "FORMULA",
            _bypassSupabaseVirtualSheet: true,
          })
          .catch(() => ({ data: { valueRanges: [] } })),
      ]);

      const vList = valBatch.data.valueRanges || [];
      const fList = formBatch.data.valueRanges || [];

      for (let j = 0; j < chunk.length; j++) {
        const tabName = chunk[j];
        const vGrid = vList[j]?.values || [];
        const fGrid = fList[j]?.values || vGrid;
        pulledMasterGrids[tabName] = { values: vGrid, formulas: fGrid, notes: {} };
        await saveVirtualTabGrid_(ctx, "master", tabName, vGrid, fGrid, {});
        summary.masterTabsSynced++;

        if (tabName === "KeyInfo") {
          const rawMode = String(vGrid[7]?.[6] || "Whole").trim();
          if (rawMode) migratedInvMode = rawMode;
        } else if (tabName === "DataChgAlert") {
          const invFreq = String(vGrid[1]?.[24] || "").trim();
          const crmFreq = String(vGrid[2]?.[24] || "").trim();
          const expFreq = String(vGrid[3]?.[24] || "").trim();
          try {
            await supabase
              .from("sync_schedules")
              .update({
                inv_freq: invFreq || "Not Used",
                crm_freq: crmFreq || "Not Used",
                exp_freq: expFreq || "Not Used",
                updated_at: new Date().toISOString(),
              })
              .eq("client_name", ctx.clientName);
          } catch (_) {
            // ignore non-critical sync_schedules update warning
          }
        } else if (
          tabName === "InvFromApp" ||
          tabName === "RevFromApp" ||
          tabName === "JnlsFromApp" ||
          tabName === "PLFromApp" ||
          tabName === "Year0PLFromApp" ||
          tabName === "DataFromCRM" ||
          tabName === "DataFromTime" ||
          tabName === "ProjectsFromTime" ||
          tabName === "TimeComp"
        ) {
          // Delegated to lossless Phase 4A/4B relational mappers after the tab loop
        }
      }
    }

    const { reconcileClientMasterIngestionFromGrids } = await import("./relationalMasterService.js");
    const masterIngestRes = await reconcileClientMasterIngestionFromGrids(ctx, tabsToPull, {
      forceFullUpsert: true,
      gridsOverride: pulledMasterGrids,
    }).catch(() => null);
    if (masterIngestRes) {
      summary.invoicesCount = masterIngestRes.invoicesCount ?? summary.invoicesCount;
      summary.directCostsCount = masterIngestRes.directCostsCount ?? summary.directCostsCount;
      summary.plLinesCount = masterIngestRes.plLinesCount ?? summary.plLinesCount;
      summary.crmDealsCount = masterIngestRes.crmDealsCount ?? summary.crmDealsCount;
      summary.timeEntriesCount = masterIngestRes.timeEntriesCount ?? summary.timeEntriesCount;
    }

    // Seed GasScriptProps if not already initialized so the very first scheduled sync uses the Delta Update Engine cleanly
    const { data: existingProps } = await supabase
      .from("master_sheet_grids")
      .select("values_grid")
      .eq("client_id", ctx.clientId)
      .eq("sheet_role", "master")
      .eq("tab_name", "GasScriptProps")
      .maybeSingle();

    if (!existingProps?.values_grid || existingProps.values_grid.length < 2) {
      const seedGrid = [
        ["Key", "Value", "UpdatedAt"],
        ["INV_LAST_IMPORT_MODE", migratedInvMode || "Whole", new Date().toISOString()],
        ["EXP_LAST_IMPORT_MODE", "Whole", new Date().toISOString()],
      ];
      await saveVirtualTabGrid_(ctx, "master", "GasScriptProps", seedGrid, seedGrid, {});
    }
  }

  // 2. Fetch Recon Sheet metadata & tabs
  if (ctx.reconSheetId && !isVirtualSupabaseSheetId(ctx.reconSheetId)) {
    const reconMeta = await sheets.spreadsheets.get({
      spreadsheetId: ctx.reconSheetId,
      fields: "sheets.properties.title",
      _bypassSupabaseVirtualSheet: true,
    });
    const allReconTabs = (reconMeta.data.sheets || [])
      .map((s) => s.properties.title)
      .filter((t) => Boolean(t));

    const learningPatterns = new Map();

    for (let i = 0; i < allReconTabs.length; i += 5) {
      const chunk = allReconTabs.slice(i, i + 5);
      const ranges = chunk.map((t) => `'${t}'`);
      const [valBatch, formBatch] = await Promise.all([
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: ctx.reconSheetId,
          ranges,
          valueRenderOption: "UNFORMATTED_VALUE",
          _bypassSupabaseVirtualSheet: true,
        }),
        sheets.spreadsheets.values
          .batchGet({
            spreadsheetId: ctx.reconSheetId,
            ranges,
            valueRenderOption: "FORMULA",
            _bypassSupabaseVirtualSheet: true,
          })
          .catch(() => ({ data: { valueRanges: [] } })),
      ]);

      const vList = valBatch.data.valueRanges || [];
      const fList = formBatch.data.valueRanges || [];

      for (let j = 0; j < chunk.length; j++) {
        const tabName = chunk[j];
        const vGrid = vList[j]?.values || [];
        const fGrid = fList[j]?.values || vGrid;
        await saveVirtualTabGrid_(ctx, "recon", tabName, vGrid, fGrid, {}, { syncNormalizedMirrors: true });
        summary.reconTabsSynced++;

        if (/^\d{4}$/.test(tabName)) {
          summary.reconPeriodsCount++;
          for (let r = 2; r < Math.min(vGrid.length, 200); r++) {
            const row = vGrid[r] || [];
            const payee = String(row[3] || row[4] || "").trim().toLowerCase();
            const cat = String(row[16] || "").trim();
            if (payee && cat && !cat.startsWith("#")) {
              const key = `${payee}:::${cat}`;
              learningPatterns.set(key, {
                match_pattern: payee,
                category: cat,
                confidence_count: (learningPatterns.get(key)?.confidence_count || 0) + 1,
              });
            }
          }
        }
      }
    }

    const { count: itemCnt } = await supabase
      .from("bank_recon_items")
      .select("*", { count: "exact", head: true })
      .eq("client_name", ctx.clientName);
    summary.reconItemsCount = itemCnt || 0;

    if (learningPatterns.size > 0) {
      const dedupByPattern = new Map();
      for (const item of learningPatterns.values()) {
        const existing = dedupByPattern.get(item.match_pattern);
        if (!existing || item.confidence_count > existing.confidence_count) {
          dedupByPattern.set(item.match_pattern, {
            client_id: ctx.clientId,
            client_name: ctx.clientName,
            match_pattern: item.match_pattern,
            category: item.category,
            confidence_count: item.confidence_count,
            updated_at: new Date().toISOString(),
          });
        }
      }
      const rows = [...dedupByPattern.values()];
      await supabase.from("bank_recon_learning_map").delete().eq("client_name", ctx.clientName);
      for (let i = 0; i < rows.length; i += 200) {
        await supabase.from("bank_recon_learning_map").insert(rows.slice(i, i + 200));
      }
      summary.learningPatternsCount = rows.length;
    }
  }

  invalidateMasterEngineCache(ctx.clientName);
  return summary;
}

async function syncInvoicesTableFromGrid_(ctx, grid) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !Array.isArray(grid)) return 0;

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const issueDate = String(row[0] || "").trim();
    const invNo = String(row[1] || "").trim();
    const contactName = String(row[2] || "").trim();
    const desc = String(row[3] || "").trim();
    const accCode = String(row[4] || "").trim();
    const taxType = String(row[5] || "").trim();
    const tracking = String(row[6] || "").trim();
    const net = parseNumericVal_(row[7]);
    const tax = parseNumericVal_(row[8]);
    const gross = parseNumericVal_(row[9]);
    const status = String(row[10] || "").trim();
    const invType = String(row[11] || "ACCREC").trim();
    const extId = String(row[12] || "").trim();
    const paidDate = String(row[13] || "").trim();
    const curr = String(row[14] || "GBP").trim();
    const amtDue = parseNumericVal_(row[15]);
    const amtPaid = parseNumericVal_(row[16]);

    if (!invNo && !contactName && !extId && !net && !gross) continue;
    rows.push({
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      external_id: extId || `row_${r + 1}`,
      invoice_number: invNo,
      contact_name: contactName,
      description: desc,
      account_code: accCode,
      tax_type: taxType,
      tracking_category: tracking,
      issue_date: issueDate,
      fully_paid_date: paidDate,
      status,
      invoice_type: invType,
      sub_total: net,
      tax_total: tax,
      total: gross,
      amount_due: amtDue,
      amount_paid: amtPaid,
      currency_code: curr || "GBP",
      raw_row: row,
      synced_at: new Date().toISOString(),
    });
  }

  await supabase.from("accounting_invoices").delete().eq("client_name", ctx.clientName);
  for (let i = 0; i < rows.length; i += 200) {
    await supabase.from("accounting_invoices").insert(rows.slice(i, i + 200));
  }
  return rows.length;
}

async function syncDirectCostsTableFromGrid_(ctx, grid) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !Array.isArray(grid)) return 0;

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const txnDate = String(row[0] || "").trim();
    const supplier = String(row[1] || "").trim();
    const net = parseNumericVal_(row[2]);
    const vat = parseNumericVal_(row[3]);
    const gross = parseNumericVal_(row[4]);
    const ref = String(row[5] || "").trim();
    const accName = String(row[6] || "").trim();
    const status = String(row[7] || "").trim();
    const extId = String(row[8] || "").trim();
    const paidDate = String(row[9] || "").trim();
    const curr = String(row[10] || "GBP").trim();
    const currRate = parseNumericVal_(row[11]) || 1;
    const amtDue = parseNumericVal_(row[12]);
    const amtPaid = parseNumericVal_(row[13]);
    const dueDate = String(row[14] || "").trim();

    if (!supplier && !extId && !net && !gross) continue;
    rows.push({
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      external_id: extId || `jnl_${r + 1}`,
      cost_type: "contractor",
      supplier_name: supplier,
      description: supplier,
      account_name: accName,
      txn_date: txnDate,
      due_date: dueDate,
      paid_date: paidDate,
      net_amount: net,
      vat_amount: vat,
      gross_amount: gross,
      amount_due: amtDue,
      amount_paid: amtPaid,
      status,
      reference: ref,
      currency_code: curr || "GBP",
      currency_rate: currRate,
      raw_row: row,
      synced_at: new Date().toISOString(),
    });
  }

  await supabase.from("accounting_direct_costs").delete().eq("client_name", ctx.clientName);
  for (let i = 0; i < rows.length; i += 200) {
    await supabase.from("accounting_direct_costs").insert(rows.slice(i, i + 200));
  }
  return rows.length;
}

async function syncPLLinesTableFromGrid_(ctx, grid) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !Array.isArray(grid) || grid.length < 2) return 0;

  // Locate header row with month dates
  let headerRowIdx = 0;
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const nonEmpty = (grid[r] || []).filter((c) => String(c || "").trim() !== "");
    if (nonEmpty.length >= 3) {
      headerRowIdx = r;
      break;
    }
  }
  const headers = grid[headerRowIdx] || [];
  const rows = [];

  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const accountName = String(row[0] || "").trim();
    if (!accountName || accountName.toLowerCase().startsWith("total")) continue;
    for (let c = 1; c < headers.length; c++) {
      const mHeader = String(headers[c] || "").trim();
      if (!mHeader) continue;
      const amt = parseNumericVal_(row[c]);
      if (amt === 0 && !row[c]) continue;
      rows.push({
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        month_date: mHeader,
        section: "overheads",
        account_name: accountName,
        basis: "accrual",
        net_amount: amt,
        vat_amount: 0,
        synced_at: new Date().toISOString(),
      });
    }
  }

  await supabase.from("accounting_pl_lines").delete().eq("client_name", ctx.clientName);
  const dedup = new Map();
  for (const item of rows) {
    dedup.set(`${item.month_date}:::${item.account_name}:::${item.basis}`, item);
  }
  const uniqueRows = [...dedup.values()];
  for (let i = 0; i < uniqueRows.length; i += 200) {
    await supabase.from("accounting_pl_lines").insert(uniqueRows.slice(i, i + 200));
  }
  return uniqueRows.length;
}

async function syncCrmDealsTableFromGrid_(ctx, grid) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !Array.isArray(grid) || grid.length < 2) return 0;

  const headers = (grid[0] || []).map((h, i) => String(h || `Col_${i + 1}`).trim());
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    if (row.every((c) => !String(c || "").trim())) continue;
    const rawObj = {};
    headers.forEach((h, i) => {
      if (row[i] !== undefined && row[i] !== "") rawObj[h] = row[i];
    });
    const extId = String(row[0] || `crm_row_${r + 1}`).trim();
    const dealName = String(row[1] || row[2] || "").trim();
    const companyName = String(row[2] || row[1] || "").trim();
    rows.push({
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      external_id: extId,
      deal_name: dealName,
      company_name: companyName,
      raw_payload: rawObj,
      synced_at: new Date().toISOString(),
    });
  }

  await supabase.from("crm_deals_raw").delete().eq("client_name", ctx.clientName);
  const dedup = new Map();
  for (const item of rows) dedup.set(item.external_id, item);
  const uniqueRows = [...dedup.values()];
  for (let i = 0; i < uniqueRows.length; i += 200) {
    await supabase.from("crm_deals_raw").insert(uniqueRows.slice(i, i + 200));
  }
  return uniqueRows.length;
}

async function syncTimeEntriesTableFromGrid_(ctx, grid) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !Array.isArray(grid) || grid.length < 12) return 0;

  const monthHeaders = grid[3] || []; // Row 4 (0-idx 3)
  const rows = [];
  for (let r = 11; r < Math.min(grid.length, 62); r++) {
    const row = grid[r] || [];
    const staffName = String(row[0] || "").trim();
    if (!staffName) continue;
    for (let c = 1; c < monthHeaders.length; c++) {
      const mLabel = String(monthHeaders[c] || "").trim();
      if (!mLabel) continue;
      const hrs = parseNumericVal_(row[c]);
      if (!hrs) continue;
      rows.push({
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        month_date: mLabel,
        staff_name: staffName,
        client_label: "",
        job_label: "Total utilization",
        hours_logged: hrs,
        synced_at: new Date().toISOString(),
      });
    }
  }

  await supabase.from("time_entries_raw").delete().eq("client_name", ctx.clientName);
  const dedup = new Map();
  for (const item of rows) dedup.set(`${item.month_date}:::${item.staff_name}:::${item.job_label}`, item);
  const uniqueRows = [...dedup.values()];
  for (let i = 0; i < uniqueRows.length; i += 200) {
    await supabase.from("time_entries_raw").insert(uniqueRows.slice(i, i + 200));
  }
  return uniqueRows.length;
}

/**
 * Materializes all IMPORTRANGE links on a client's Client Sheet (e.g. APPTEST)
 * by replacing IMPORTRANGE wrapper formulas with local self-contained formulas/values
 * from the Master Sheet (stored in Supabase), while backing up the original IMPORTRANGEs.
 */
export async function materializeClientSheetFromMaster(sheets, clientName = "APPTEST") {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx || !ctx.clientSheetId || !ctx.masterSheetId) {
    throw new Error(`Client "${clientName}" is missing clientSheetId or masterSheetId.`);
  }
  if (isVirtualSupabaseSheetId(ctx.clientSheetId)) {
    throw new Error(`Client "${clientName}" was provisioned in Supabase without a Google Client Sheet.`);
  }
  if (isVirtualSupabaseSheetId(ctx.masterSheetId)) {
    throw new Error(`Client "${clientName}" has no Google Master Sheet; its Client Sheet IMPORTRANGEs are already materialized.`);
  }

  // Check which tabs actually exist on both the Client Sheet and Master Sheet
  const [clientMeta, masterMeta, { data: existingKi }] = await Promise.all([
    sheets.spreadsheets.get({
      spreadsheetId: ctx.clientSheetId,
      fields: "sheets.properties.title",
      _bypassSupabaseVirtualSheet: true,
    }),
    sheets.spreadsheets.get({
      spreadsheetId: ctx.masterSheetId,
      fields: "sheets.properties.title",
      _bypassSupabaseVirtualSheet: true,
    }),
    supabase
      .from("tenant_key_info")
      .select("client_importrange_backup")
      .eq("client_id", ctx.clientId)
      .maybeSingle(),
  ]);

  const clientTabs = new Set((clientMeta.data.sheets || []).map((s) => s.properties.title));
  const masterTabs = new Set((masterMeta.data.sheets || []).map((s) => s.properties.title));

  // Known IMPORTRANGE locations on Client Sheets that pull from Master Sheet ($D$1 / $E$1)
  const targets = [];
  if (clientTabs.has("KeyInfo") && masterTabs.has("KeyInfo")) {
    targets.push(
      {
        id: "keyinfo_header",
        clientRange: "KeyInfo!A1:B1",
        masterRange: "KeyInfo!A1:B1",
        mode: "VALUES_ONLY",
      },
      {
        id: "keyinfo_body",
        clientRange: "KeyInfo!A2:AZ150",
        masterRange: "KeyInfo!A2:AZ150",
        mode: "FORMULAS_NO_EXTERNAL",
      }
    );
  }

  if (clientTabs.has("Welcome") && masterTabs.has("Welcome")) {
    targets.push({
      id: "welcome_block",
      clientRange: "Welcome!B3:D26",
      masterRange: "Welcome!B3:D26",
      mode: "VALUES_ONLY",
    });
  }

  // Check if YrCalcs!A1 on Client Sheet has an IMPORTRANGE pointing to Master Sheet (e.g. OrinYrCalcs!A1:JH8)
  if (clientTabs.has("YrCalcs")) {
    let yrFormula = String(existingKi?.client_importrange_backup?.yrcalcs_block?.originalFormula || "");
    if (!yrFormula) {
      const yrAnchorResp = await sheets.spreadsheets.values
        .get({
          spreadsheetId: ctx.clientSheetId,
          range: "YrCalcs!A1",
          valueRenderOption: "FORMULA",
          _bypassSupabaseVirtualSheet: true,
        })
        .catch(() => null);
      yrFormula = String(yrAnchorResp?.data?.values?.[0]?.[0] || "");
    }
    if (/importrange/i.test(yrFormula)) {
      const rangeMatch = yrFormula.match(/["']([^"'!]+)!([A-Za-z0-9:$]+)["']/);
      if (rangeMatch) {
        const srcTab = rangeMatch[1].replace(/^'|'$/g, "");
        const srcCoords = rangeMatch[2].replace(/\$/g, "");
        if (masterTabs.has(srcTab)) {
          targets.push({
            id: "yrcalcs_block",
            clientRange: `YrCalcs!${srcCoords}`,
            masterRange: `${srcTab}!${srcCoords}`,
            mode: "FORMULAS_NO_EXTERNAL",
          });
        }
      }
    }
  }

  if (targets.length === 0) {
    throw new Error(`No matching IMPORTRANGE target tabs found on ${clientName} Client Sheet.`);
  }

  // 1. Read existing Client Sheet formulas at those target anchor cells for backup
  const anchorRanges = targets.map((t) => {
    const tab = t.clientRange.split("!")[0];
    const startCoord = t.clientRange.split("!")[1].split(":")[0];
    return `${tab}!${startCoord}`;
  });

  const existingAnchorsResp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ctx.clientSheetId,
    ranges: anchorRanges,
    valueRenderOption: "FORMULA",
    _bypassSupabaseVirtualSheet: true,
  });

  const backupMap = {};
  (existingAnchorsResp.data.valueRanges || []).forEach((vr, idx) => {
    const t = targets[idx];
    const formulaCell = vr.values?.[0]?.[0] || "";
    backupMap[t.id] = {
      clientRange: t.clientRange,
      anchorRange: anchorRanges[idx],
      originalFormula: formulaCell,
    };
  });

  const hasExistingImportrangeBackup =
    existingKi?.client_importrange_backup &&
    Object.values(existingKi.client_importrange_backup).some((b) =>
      /importrange/i.test(String(b?.originalFormula || ""))
    );

  const finalBackupToSave = hasExistingImportrangeBackup
    ? { ...backupMap, ...existingKi.client_importrange_backup }
    : backupMap;

  // 2. Fetch both FORMATTED_VALUE and FORMULA from Master Sheet for all targets
  const masterRanges = targets.map((t) => t.masterRange);
  const [masterValResp, masterFormResp] = await Promise.all([
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: ctx.masterSheetId,
      ranges: masterRanges,
      valueRenderOption: "FORMATTED_VALUE",
      _bypassSupabaseVirtualSheet: true,
    }),
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: ctx.masterSheetId,
      ranges: masterRanges,
      valueRenderOption: "FORMULA",
      _bypassSupabaseVirtualSheet: true,
    }),
  ]);

  const batchWriteData = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const vals = masterValResp.data.valueRanges?.[i]?.values || [];
    const forms = masterFormResp.data.valueRanges?.[i]?.values || [];

    const maxR = Math.max(vals.length, forms.length);
    const mergedRows = [];
    for (let r = 0; r < maxR; r++) {
      const vRow = vals[r] || [];
      const fRow = forms[r] || [];
      const maxC = Math.max(vRow.length, fRow.length);
      const outRow = [];
      for (let c = 0; c < maxC; c++) {
        const fCell = fRow[c];
        const vCell = vRow[c] ?? "";
        if (t.mode === "VALUES_ONLY") {
          outRow.push(vCell);
        } else {
          // If formula contains IMPORTRANGE or references a Master-only tab (e.g. CRMList!, PLFromApp!), fall back to evaluated value
          if (
            typeof fCell === "string" &&
            /\b(importrange|CRMList!|PLFromApp!|Year0PLFromApp!|PLComp!|InvComp!|DirComp!|CRMComp!|DataFromCRM!)/i.test(fCell)
          ) {
            outRow.push(vCell);
          } else if (typeof fCell === "string" && fCell.startsWith("=")) {
            outRow.push(fCell);
          } else {
            outRow.push(vCell !== "" && vCell !== undefined ? vCell : fCell !== undefined ? fCell : "");
          }
        }
      }
      mergedRows.push(outRow);
    }

    // For KeyInfo!A2:AZ150, expand the 3 template IMPORTRANGE blocks (R2, G32, A77) using their evaluated values
    if (t.id === "keyinfo_body") {
      for (let r = 0; r < mergedRows.length; r++) {
        const vRow = vals[r] || [];
        for (let c = 0; c < Math.max(mergedRows[r].length, vRow.length); c++) {
          if (mergedRows[r][c] === undefined || mergedRows[r][c] === "") {
            if (vRow[c] !== undefined && vRow[c] !== "") {
              mergedRows[r][c] = vRow[c];
            }
          }
        }
      }
    }

    batchWriteData.push({
      range: t.clientRange,
      values: mergedRows,
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ctx.clientSheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: batchWriteData,
    },
    _bypassSupabaseVirtualSheet: true,
  });

  await supabase
    .from("tenant_key_info")
    .update({
      client_importrange_backup: finalBackupToSave,
      client_materialized_at: new Date().toISOString(),
    })
    .eq("client_id", ctx.clientId);

  return {
    success: true,
    clientName: ctx.clientName,
    materializedRangesCount: batchWriteData.length,
    materializedAt: new Date().toISOString(),
  };
}

/**
 * Restores the original IMPORTRANGE formulas onto a client's Client Sheet (1-click rollback)
 */
export async function restoreClientSheetImportranges(sheets, clientName = "APPTEST") {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx || !ctx.clientSheetId) throw new Error(`Client "${clientName}" not found.`);
  if (isVirtualSupabaseSheetId(ctx.clientSheetId) || isVirtualSupabaseSheetId(ctx.masterSheetId)) {
    throw new Error(`Cannot restore IMPORTRANGEs because "${clientName}" does not have both Google Client and Google Master sheets.`);
  }

  const { data: ki } = await supabase
    .from("tenant_key_info")
    .select("client_importrange_backup")
    .eq("client_id", ctx.clientId)
    .maybeSingle();

  const backup = ki?.client_importrange_backup || {};
  const entries = Object.values(backup).filter((b) => b && b.clientRange && b.originalFormula);
  if (entries.length === 0) {
    throw new Error(`No backed-up IMPORTRANGE formulas found for ${clientName}.`);
  }

  // 1. Clear the materialized ranges first so IMPORTRANGE can spill without #REF!
  await sheets.spreadsheets.values.batchClear({
    spreadsheetId: ctx.clientSheetId,
    requestBody: {
      ranges: entries.map((e) => e.clientRange),
    },
    _bypassSupabaseVirtualSheet: true,
  });

  // 2. Write back the anchor IMPORTRANGE formulas
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ctx.clientSheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: entries.map((e) => ({
        range: e.anchorRange,
        values: [[e.originalFormula]],
      })),
    },
    _bypassSupabaseVirtualSheet: true,
  });

  await supabase
    .from("tenant_key_info")
    .update({ client_materialized_at: null })
    .eq("client_id", ctx.clientId);

  return {
    success: true,
    clientName: ctx.clientName,
    restoredRangesCount: entries.length,
  };
}

/**
 * Switches a client's master_mode between 'sheet' and 'supabase'
 */
export async function setClientMasterMode(clientName, masterMode) {
  const cleanMode = masterMode === "supabase" ? "supabase" : "sheet";
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  if (cleanMode === "sheet") {
    const { data: cur } = await supabase
      .from("clients")
      .select("master_sheet_id, grid_storage_retired")
      .eq("client_name", clientName)
      .maybeSingle();
    if (cur?.grid_storage_retired) {
      throw new Error(`Cannot downgrade "${clientName}" to legacy grid sheets after grid storage has been retired.`);
    }
    if (!cur?.master_sheet_id || isVirtualSupabaseSheetId(cur.master_sheet_id)) {
      throw new Error(`Cannot switch "${clientName}" Master & Recon to Google Sheets because no Google Master Sheet was provisioned for this client.`);
    }
  }

  const { data, error } = await supabase
    .from("clients")
    .update({ master_mode: cleanMode, updated_at: new Date().toISOString() })
    .eq("client_name", clientName)
    .select("id, client_name, master_mode, client_mode")
    .maybeSingle();

  if (error) throw new Error(error.message);
  _sheetContextCache.expiresAt = 0;
  return data;
}

/**
 * Switches a client's client_mode between 'sheet' and 'supabase'
 */
export async function setClientMode(clientName, clientMode) {
  const cleanMode = clientMode === "supabase" ? "supabase" : "sheet";
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  let resetMetadataPatch = null;
  if (cleanMode === "sheet") {
    const { data: cur } = await supabase
      .from("clients")
      .select("client_sheet_id, grid_storage_retired, metadata")
      .eq("client_name", clientName)
      .maybeSingle();
    if (cur?.grid_storage_retired) {
      throw new Error(`Cannot downgrade "${clientName}" to legacy grid sheets after grid storage has been retired.`);
    }
    if (!cur?.client_sheet_id || isVirtualSupabaseSheetId(cur.client_sheet_id)) {
      throw new Error(`Cannot switch "${clientName}" Client Portal to Google Sheets because no Google Client Sheet was provisioned for this client.`);
    }
    resetMetadataPatch = {
      ...(cur?.metadata && typeof cur.metadata === "object" ? cur.metadata : {}),
      sheet_bridge_mode: "off",
    };
  }

  const { data, error } = await supabase
    .from("clients")
    .update({
      client_mode: cleanMode,
      ...(resetMetadataPatch ? { metadata: resetMetadataPatch } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("client_name", clientName)
    .select("id, client_name, master_mode, client_mode")
    .maybeSingle();

  if (error) throw new Error(error.message);
  _sheetContextCache.expiresAt = 0;
  return data;
}

/**
 * Synchronizes the 5 Stage 4 structured relational tables (client_jobs, client_outgoings,
 * client_salaries, client_budgets_and_targets, client_cash_balances) when those tables exist in Supabase.
 */
let _stage4TablesVerified = false;
const _inFlightStage4SyncByClient = new Map();

async function syncStructuredClientTablesFromGrids_(ctx, grids, changedTabs = null, options = {}) {
  if (!options?.force && !shouldSyncNormalizedMirrorTables()) return;
  const clientKey = String(ctx?.clientName || "").trim().toLowerCase();
  if (!clientKey) {
    return syncStructuredClientTablesFromGridsImpl_(ctx, grids, changedTabs, options);
  }
  const prev = _inFlightStage4SyncByClient.get(clientKey) || Promise.resolve();
  const next = prev
    .catch(() => { })
    .then(() => syncStructuredClientTablesFromGridsImpl_(ctx, grids, changedTabs, options));
  _inFlightStage4SyncByClient.set(clientKey, next);
  try {
    await next;
  } finally {
    if (_inFlightStage4SyncByClient.get(clientKey) === next) {
      _inFlightStage4SyncByClient.delete(clientKey);
    }
  }
}

async function syncStructuredClientTablesFromGridsImpl_(ctx, grids, changedTabs = null, options = {}) {
  if (!options?.force && !shouldSyncNormalizedMirrorTables()) return;
  const supabase = getSupabaseAdmin();
  if (!supabase || !grids) return;
  const tabSet = changedTabs ? new Set(changedTabs) : null;

  if (!_stage4TablesVerified) {
    // Quick probe once per process to see if Stage 4 tables exist in Supabase
    const { error: probeErr } = await supabase.from("client_jobs").select("id").limit(1);
    if (probeErr) return; // 0004_stage4_client_sheet_engine.sql not applied yet
    _stage4TablesVerified = true;
  }

  const nowIso = new Date().toISOString();

  // 1. client_jobs (Confirmed & Pipeline)
  for (const [tabName, tabType] of [
    ["Confirmed", "confirmed"],
    ["Pipeline", "pipeline"],
  ]) {
    if (tabSet && !tabSet.has(tabName)) continue;
    const vGrid = grids[tabName]?.values;
    if (!Array.isArray(vGrid) || vGrid.length === 0) continue;
    const maxRow = findLastActiveClientJobRow_(vGrid, 1);
    const jobRows = [];
    for (let r = 1; r <= maxRow && r < vGrid.length; r++) {
      const row = vGrid[r] || [];
      const cName = String(row[0] ?? "").trim();
      const jName = String(row[1] ?? "").trim();
      const totalVal = parseNumericVal_(row[32]);
      if (!cName && !jName && !totalVal) continue;
      jobRows.push({
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        tab_type: tabType,
        row_index: r + 1,
        sort_order: r,
        customer_name: cName,
        job_name: jName,
        project_code: String(row[2] ?? "").trim(),
        date_confirmed: formatCellForDisplay("client", tabName, r, 3, row[3], vGrid),
        lead_source: String(row[5] ?? "").trim(),
        job_type: String(row[35] ?? "Project").trim(),
        product_line: String(row[6] ?? "").trim(),
        start_date: formatCellForDisplay("client", tabName, r, 37, row[37], vGrid),
        end_date: formatCellForDisplay("client", tabName, r, 38, row[38], vGrid),
        likelihood_pct: parseNumericVal_(row[39] ?? 1),
        total_revenue: totalVal,
        total_direct_costs: parseNumericVal_(row[33]),
        raw_row: row.slice(0, 108),
        updated_at: nowIso,
      });
    }
    const { error: delErr } = await supabase
      .from("client_jobs")
      .delete()
      .eq("client_name", ctx.clientName)
      .eq("tab_type", tabType);
    if (delErr) {
      console.warn(`[masterEngineService] client_jobs delete error (${ctx.clientName}/${tabType}):`, delErr.message);
    }
    for (let i = 0; i < jobRows.length; i += 200) {
      const { error: insErr } = await supabase.from("client_jobs").insert(jobRows.slice(i, i + 200));
      if (insErr) {
        console.warn(`[masterEngineService] client_jobs insert error (${ctx.clientName}/${tabType}):`, insErr.message);
      }
    }
  }

  // 2. client_outgoings (Outgoings)
  if (!tabSet || tabSet.has("Outgoings")) {
    const outGrid = grids.Outgoings?.values;
    if (Array.isArray(outGrid) && outGrid.length > 0) {
      const outNotes = grids.Outgoings?.notes || {};
      const mHeaders = (outGrid[0] || []).slice(6, 48).map((v, i) => formatCellForDisplay("client", "Outgoings", 0, 6 + i, v, outGrid));
      const outRows = [];
      for (let r = 11; r < Math.min(outGrid.length, 310); r++) {
        const row = outGrid[r] || [];
        const catName = String(row[0] ?? "").trim();
        if (!catName) continue;
        const monthlyAmounts = {};
        const monthlyNotes = {};
        for (let c = 6; c <= 47; c++) {
          const mKey = mHeaders[c - 6] || `Col_${c}`;
          const v = row[c];
          if (v !== "" && v !== null && v !== undefined) monthlyAmounts[mKey] = parseNumericVal_(v);
          const nk = `${r}:${c}`;
          if (outNotes[nk]) monthlyNotes[mKey] = outNotes[nk];
        }
        outRows.push({
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          section: r < 110 ? "contractor" : r < 120 ? "cos_topup" : "expense",
          row_index: r + 1,
          label: catName,
          vat_applicable: String(row[1] ?? "No").trim(),
          invoice_status: String(row[2] ?? "").trim(),
          pay_status: String(row[3] ?? "").trim(),
          delivery_pct: parseNumericVal_(row[4]),
          likelihood_pct: parseNumericVal_(row[5] ?? 1),
          monthly_values: monthlyAmounts,
          cell_notes: monthlyNotes,
          raw_row: row.slice(0, 50),
          updated_at: nowIso,
        });
      }
      const { error: delOutErr } = await supabase.from("client_outgoings").delete().eq("client_name", ctx.clientName);
      if (delOutErr) {
        console.warn(`[masterEngineService] client_outgoings delete error (${ctx.clientName}):`, delOutErr.message);
      }
      for (let i = 0; i < outRows.length; i += 200) {
        const { error: insOutErr } = await supabase.from("client_outgoings").insert(outRows.slice(i, i + 200));
        if (insOutErr) {
          console.warn(`[masterEngineService] client_outgoings insert error (${ctx.clientName}):`, insOutErr.message);
        }
      }
    }
  }

  // 3. client_salaries (Salaries)
  if (!tabSet || tabSet.has("Salaries")) {
    const salGrid = grids.Salaries?.values;
    if (Array.isArray(salGrid) && salGrid.length > 0) {
      const salRows = [];
      for (let r = 3; r < Math.min(salGrid.length, 65); r++) {
        const row = salGrid[r] || [];
        const sName = String(row[0] ?? "").trim();
        const sRole = String(row[1] ?? "").trim();
        const annual = parseNumericVal_(row[2]);
        if (!sName && !sRole && !annual) continue;
        salRows.push({
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          row_index: r + 1,
          sort_order: r,
          employee_name: sName,
          role_title: sRole,
          fte_salary: annual,
          fte_fraction: parseNumericVal_(row[3] ?? 1),
          start_date: formatCellForDisplay("client", "Salaries", r, 4, row[4], salGrid),
          end_date: formatCellForDisplay("client", "Salaries", r, 5, row[5], salGrid),
          delivery_pct: parseNumericVal_(row[6]),
          student_loan_plan: String(row[7] ?? "None").trim(),
          pension_opt_in: String(row[8] ?? "Yes").trim(),
          raw_row: row.slice(0, 270),
          updated_at: nowIso,
        });
      }
      const { error: delSalErr } = await supabase.from("client_salaries").delete().eq("client_name", ctx.clientName);
      if (delSalErr) {
        console.warn(`[masterEngineService] client_salaries delete error (${ctx.clientName}):`, delSalErr.message);
      }
      if (salRows.length > 0) {
        const { error: insSalErr } = await supabase.from("client_salaries").insert(salRows);
        if (insSalErr) {
          console.warn(`[masterEngineService] client_salaries insert error (${ctx.clientName}):`, insSalErr.message);
        }
      }
    }
  }

  // 4. client_budgets_and_targets (Budget & NBtoFind)
  for (const [tabName, modelType] of [
    ["Budget", "budget"],
    ["NBtoFind", "nb_to_find"],
  ]) {
    if (tabSet && !tabSet.has(tabName)) continue;
    const bGrid = grids[tabName]?.values;
    if (!Array.isArray(bGrid) || bGrid.length === 0) continue;
    const bRows = [];
    for (let r = 1; r < Math.min(bGrid.length, 260); r++) {
      const row = bGrid[r] || [];
      const lbl = String(row[0] ?? "").trim();
      if (!lbl) continue;
      bRows.push({
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        model_type: modelType,
        row_index: r + 1,
        line_key: `R${r + 1}`,
        label: lbl,
        raw_row: row.slice(0, 60),
        updated_at: nowIso,
      });
    }
    const { error: delBudErr } = await supabase
      .from("client_budgets_and_targets")
      .delete()
      .eq("client_name", ctx.clientName)
      .eq("model_type", modelType);
    if (delBudErr) {
      console.warn(`[masterEngineService] client_budgets_and_targets delete error (${ctx.clientName}/${modelType}):`, delBudErr.message);
    }
    for (let i = 0; i < bRows.length; i += 200) {
      const { error: insBudErr } = await supabase.from("client_budgets_and_targets").insert(bRows.slice(i, i + 200));
      if (insBudErr) {
        console.warn(`[masterEngineService] client_budgets_and_targets insert error (${ctx.clientName}/${modelType}):`, insBudErr.message);
      }
    }
  }

  // 5. client_cash_balances (Cash)
  if ((!tabSet || tabSet.has("Cash")) && Array.isArray(grids.Cash?.values) && grids.Cash.values.length > 0) {
    const cashGrid = grids.Cash.values;
    const cashRow0 = cashGrid[0] || [];
    const cashRows = [];
    for (let c = 1; c < cashRow0.length; c++) {
      const mDate = formatCellForDisplay("client", "Cash", 0, c, cashRow0[c], cashGrid);
      if (!mDate) continue;
      cashRows.push({
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        month_date: mDate,
        col_index: c + 1,
        account_balances: {
          opening_balance: parseNumericVal_(cashGrid[3]?.[c]),
          forecast_closing_balance: parseNumericVal_(cashGrid[33]?.[c]),
          actual_closing_balance:
            cashGrid[35]?.[c] !== "" && cashGrid[35]?.[c] !== undefined ? parseNumericVal_(cashGrid[35]?.[c]) : null,
        },
        adjustments: {},
        updated_at: nowIso,
      });
    }
    const { error: delCashErr } = await supabase.from("client_cash_balances").delete().eq("client_name", ctx.clientName);
    if (delCashErr) {
      console.warn(`[masterEngineService] client_cash_balances delete error (${ctx.clientName}):`, delCashErr.message);
    }
    if (cashRows.length > 0) {
      const { error: insCashErr } = await supabase.from("client_cash_balances").insert(cashRows);
      if (insCashErr) {
        console.warn(`[masterEngineService] client_cash_balances insert error (${ctx.clientName}):`, insCashErr.message);
      }
    }
  }
}

/**
 * Full 1-click seeding of a client's Client Sheet (all 31 core tabs + Outgoings notes)
 * into Supabase Stage 4 virtual grids & structured relational tables.
 */
export async function seedClientSheetToSupabase(sheets, clientName = "APPTEST") {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  invalidateMasterEngineCache(clientName, null, null, { invalidateSheetContext: true });
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx || !ctx.clientSheetId) {
    throw new Error(`Client "${clientName}" not found or missing clientSheetId.`);
  }
  if (isVirtualSupabaseSheetId(ctx.clientSheetId)) {
    throw new Error(`Client "${clientName}" was provisioned directly in Supabase and has no Google Client Sheet to sync from.`);
  }

  const metaResp = await sheets.spreadsheets.get({
    spreadsheetId: ctx.clientSheetId,
    fields: "sheets(properties(sheetId,title))",
    _bypassSupabaseVirtualSheet: true,
  });
  const existingTitles = new Set((metaResp.data.sheets || []).map((s) => s.properties.title));
  const tabsToFetch = CORE_CLIENT_TABS.filter((t) => existingTitles.has(t));

  // Fetch cell notes across note-bearing tabs (Outgoings, Confirmed, Pipeline, Cash, Salaries, NBtoFind)
  const noteRangeSpecs = {
    Outgoings: { range: "Outgoings!G13:AV226", startRow0: 12, startCol0: 6 },
    Confirmed: { range: "Confirmed!AP2:CR500", startRow0: 1, startCol0: 41 },
    Pipeline: { range: "Pipeline!AP2:CR300", startRow0: 1, startCol0: 41 },
    Cash: { range: "Cash!B1:AK76", startRow0: 0, startCol0: 1 },
    Salaries: { range: "Salaries!A4:I53", startRow0: 3, startCol0: 0 },
    NBtoFind: { range: "NBtoFind!A1:AV25", startRow0: 0, startCol0: 0 },
  };
  const notesByTab = Object.create(null);
  const noteTabsPresent = Object.keys(noteRangeSpecs).filter((t) => existingTitles.has(t));
  if (noteTabsPresent.length > 0) {
    try {
      const notesResp = await sheets.spreadsheets.get({
        spreadsheetId: ctx.clientSheetId,
        ranges: noteTabsPresent.map((t) => noteRangeSpecs[t].range),
        fields: "sheets(properties.title,data(startRow,startColumn,rowData.values.note))",
        _bypassSupabaseVirtualSheet: true,
      });
      for (const sheetObj of notesResp?.data?.sheets || []) {
        const tName = sheetObj?.properties?.title;
        const cfg = noteRangeSpecs[tName];
        if (!tName || !cfg) continue;
        const gridData = sheetObj?.data?.[0];
        const sR = Number(gridData?.startRow ?? cfg.startRow0);
        const sC = Number(gridData?.startColumn ?? cfg.startCol0);
        const tabNotes = Object.create(null);
        (gridData?.rowData || []).forEach((rObj, rOff) => {
          (rObj?.values || []).forEach((vObj, cOff) => {
            if (vObj?.note) {
              tabNotes[`${sR + rOff}:${sC + cOff}`] = String(vObj.note);
            }
          });
        });
        notesByTab[tName] = tabNotes;
      }
    } catch (e) {
      console.warn(`[masterEngineService] Client Sheet notes fetch warning (${clientName}):`, e.message);
    }
  }
  const outNotesMap = notesByTab.Outgoings || {};

  const grids = Object.create(null);
  const chunkSize = 8;
  for (let i = 0; i < tabsToFetch.length; i += chunkSize) {
    const batch = tabsToFetch.slice(i, i + chunkSize);
    const ranges = batch.map((t) => `'${t}'`);
    const [valResp, formResp] = await Promise.all([
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: ctx.clientSheetId,
        ranges,
        valueRenderOption: "UNFORMATTED_VALUE",
        _bypassSupabaseVirtualSheet: true,
      }),
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: ctx.clientSheetId,
        ranges,
        valueRenderOption: "FORMULA",
        _bypassSupabaseVirtualSheet: true,
      }),
    ]);

    for (let j = 0; j < batch.length; j++) {
      const tabName = batch[j];
      const valuesGrid = valResp.data.valueRanges?.[j]?.values || [];
      const formulasGrid = formResp.data.valueRanges?.[j]?.values || valuesGrid;
      const notesGrid = notesByTab[tabName] || {};
      grids[tabName] = {
        values: valuesGrid,
        formulas: formulasGrid,
        notes: notesGrid,
      };
      await saveVirtualTabGrid_(ctx, "client", tabName, valuesGrid, formulasGrid, notesGrid);
    }
  }

  await syncStructuredClientTablesFromGrids_(ctx, grids, null, { force: true }).catch((e) =>
    console.warn("[masterEngineService] Stage 4 relational sync warning:", e.message)
  );
  await syncPhase2RelationalJobsIfEnabled_(ctx, tabsToFetch);
  await syncPhase3OperatingInputsIfEnabled_(ctx, tabsToFetch);
  await syncPhase5FinancialsIfEnabled_(ctx, tabsToFetch);

  await import("./clientSheetBridgeService.js")
    .then(({ seedSheetBridgeBaselineFromSheetSeed }) => seedSheetBridgeBaselineFromSheetSeed(ctx, grids))
    .catch((e) => console.warn("[masterEngineService] Sheet bridge baseline seed warning:", e.message));

  invalidateMasterEngineCache(ctx.clientName);

  return {
    success: true,
    clientName: ctx.clientName,
    clientSheetId: ctx.clientSheetId,
    masterSheetId: ctx.masterSheetId,
    clientTabsSynced: tabsToFetch.length,
    outgoingsNotesCount: Object.keys(outNotesMap).length,
    usedRoleFallback: _useClientRoleFallback,
  };
}

/**
 * Manually backfills the 13 normalised workbook mirror tables (Stage 2 raw mirrors &
 * Stage 4 client tables) directly from live virtual grids in `master_sheet_grids`.
 */
export async function backfillNormalizedMirrorTablesFromVirtualGrids(clientName = "APPTEST") {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found in Supabase clients registry.`);

  const masterSourceTabs = ["InvFromApp", "JnlsFromApp", "PLFromApp", "DataFromCRM", "TimeComp"];
  const clientMirrorTabs = ["Confirmed", "Pipeline", "Outgoings", "Salaries", "Budget", "NBtoFind", "Cash"];

  const [masterRes, reconRes, clientRes] = await Promise.all([
    supabase
      .from("master_sheet_grids")
      .select("tab_name, values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .in("tab_name", masterSourceTabs),
    supabase
      .from("master_sheet_grids")
      .select("tab_name, values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "recon"),
    supabase
      .from("master_sheet_grids")
      .select("tab_name, sheet_role, values_grid, notes_grid, row_count, col_count")
      .eq("client_name", ctx.clientName)
      .or("sheet_role.eq.client,and(sheet_role.eq.master,tab_name.like.Client::%)"),
  ]);

  if (masterRes.error) throw new Error(`Master grid read failed: ${masterRes.error.message}`);
  if (reconRes.error) throw new Error(`Recon grid read failed: ${reconRes.error.message}`);
  if (clientRes.error) throw new Error(`Client grid read failed: ${clientRes.error.message}`);

  const summary = {
    success: true,
    clientName: ctx.clientName,
    invoicesCount: 0,
    directCostsCount: 0,
    plLinesCount: 0,
    crmDealsCount: 0,
    timeEntriesCount: 0,
    reconPeriodsCount: 0,
    learningPatternsCount: 0,
    clientTabsBackfilled: 0,
  };

  let usedPhase4RelationalBackfill = false;
  let relationalMasterSchemaReady = false;
  try {
    const {
      checkPhase4MasterSchemaStatus,
      reconcileClientMasterIngestionFromGrids,
      ALL_PHASE4_MASTER_TABS,
    } = await import("./relationalMasterService.js");
    const st = await checkPhase4MasterSchemaStatus();
    relationalMasterSchemaReady = Boolean(st?.schemaReady);
    if (relationalMasterSchemaReady) {
      const p4 = await reconcileClientMasterIngestionFromGrids(ctx, ALL_PHASE4_MASTER_TABS, {
        forceFullUpsert: true,
        updateBackfillTimestamp: true,
      });
      summary.invoicesCount = p4?.counts?.invoices ?? 0;
      summary.directCostsCount = p4?.counts?.directCosts ?? 0;
      summary.plLinesCount = p4?.counts?.plLines ?? 0;
      summary.crmDealsCount = p4?.counts?.crmDeals ?? 0;
      summary.timeEntriesCount = p4?.counts?.timeEntries ?? 0;
      usedPhase4RelationalBackfill = true;
    }
  } catch (err) {
    console.warn(`[masterEngineService] Phase 4 relational backfill error (${ctx.clientName}):`, err?.message);
    if (relationalMasterSchemaReady) {
      throw err;
    }
  }

  if (!usedPhase4RelationalBackfill && !relationalMasterSchemaReady) {
    for (const row of masterRes.data || []) {
      const vGrid = Array.isArray(row.values_grid) ? row.values_grid : [];
      if (row.tab_name === "InvFromApp") summary.invoicesCount = await syncInvoicesTableFromGrid_(ctx, vGrid);
      else if (row.tab_name === "JnlsFromApp") summary.directCostsCount = await syncDirectCostsTableFromGrid_(ctx, vGrid);
      else if (row.tab_name === "PLFromApp") summary.plLinesCount = await syncPLLinesTableFromGrid_(ctx, vGrid);
      else if (row.tab_name === "DataFromCRM") summary.crmDealsCount = await syncCrmDealsTableFromGrid_(ctx, vGrid);
      else if (row.tab_name === "TimeComp") summary.timeEntriesCount = await syncTimeEntriesTableFromGrid_(ctx, vGrid);
    }
  }

  let usedPhase4ReconBackfill = false;
  try {
    const {
      checkPhase4ReconSchemaStatus,
      isManagedReconTab,
      reconcileClientReconFromGrids,
    } = await import("./relationalReconService.js");
    const stRecon = await checkPhase4ReconSchemaStatus();
    if (stRecon?.schemaReady) {
      const reconTabNames = [...new Set((reconRes.data || []).map((r) => String(r.tab_name || "").trim()).filter((t) => isManagedReconTab(t)))];
      if (reconTabNames.length > 0) {
        const p4r = await reconcileClientReconFromGrids(ctx, reconTabNames, {
          forceFullUpsert: true,
          updateBackfillTimestamp: true,
        });
        summary.reconPeriodsCount = p4r?.periodsCount ?? reconTabNames.filter((t) => /^\d{4}$/.test(t)).length;
        summary.learningPatternsCount = p4r?.learningRulesCount ?? 0;
      }
      usedPhase4ReconBackfill = true;
    }
  } catch (err) {
    console.warn(`[masterEngineService] Phase 4C relational recon backfill warning (${ctx.clientName}):`, err?.message);
  }

  if (!usedPhase4ReconBackfill) {
    const learningPatterns = new Map();
    for (const row of reconRes.data || []) {
      if (!/^\d{4}$/.test(String(row.tab_name || "").trim())) continue;
      const vGrid = Array.isArray(row.values_grid) ? row.values_grid : [];
      await syncReconPeriodAndItemsFromGrid_(ctx, row.tab_name, vGrid);
      summary.reconPeriodsCount++;
      for (let r = 2; r < Math.min(vGrid.length, 200); r++) {
        const cells = vGrid[r] || [];
        const payee = String(cells[3] || cells[4] || "").trim().toLowerCase();
        const cat = String(cells[16] || "").trim();
        if (payee && cat && !cat.startsWith("#")) {
          const key = `${payee}:::${cat}`;
          learningPatterns.set(key, {
            match_pattern: payee,
            category: cat,
            confidence_count: (learningPatterns.get(key)?.confidence_count || 0) + 1,
          });
        }
      }
    }

    if (learningPatterns.size > 0) {
      const dedupByPattern = new Map();
      for (const item of learningPatterns.values()) {
        const existing = dedupByPattern.get(item.match_pattern);
        if (!existing || item.confidence_count > existing.confidence_count) {
          dedupByPattern.set(item.match_pattern, {
            client_id: ctx.clientId,
            client_name: ctx.clientName,
            match_pattern: item.match_pattern,
            category: item.category,
            confidence_count: item.confidence_count,
            updated_at: new Date().toISOString(),
          });
        }
      }
      const rows = [...dedupByPattern.values()];
      await supabase.from("bank_recon_learning_map").delete().eq("client_name", ctx.clientName);
      for (let i = 0; i < rows.length; i += 200) {
        await supabase.from("bank_recon_learning_map").insert(rows.slice(i, i + 200));
      }
      summary.learningPatternsCount = rows.length;
    }
  }

  const clientMirrorSet = new Set(clientMirrorTabs);
  const clientGrids = {};
  for (const row of clientRes.data || []) {
    const cleanTab = String(row.tab_name || "").startsWith("Client::")
      ? row.tab_name.slice(8)
      : row.tab_name;
    if (!clientMirrorSet.has(cleanTab) || clientGrids[cleanTab]) continue;
    expandClientTabFromStorage_(row, cleanTab, { valuesOnly: true });
    clientGrids[cleanTab] = {
      values: row.values_grid || [],
      notes: cleanTab === "Outgoings" ? row.notes_grid || {} : {},
    };
  }
  const clientTabNames = Object.keys(clientGrids);
  if (clientTabNames.length > 0) {
    await syncStructuredClientTablesFromGrids_(ctx, clientGrids, clientTabNames, { force: true });
    summary.clientTabsBackfilled = clientTabNames.length;
  }

  try {
    const {
      checkPhase5FinancialsSchemaStatus,
      reconcileClientFinancialsFromGrids,
    } = await import("./relationalFinancialsService.js");
    const stFin = await checkPhase5FinancialsSchemaStatus();
    if (stFin?.schemaReady) {
      await reconcileClientFinancialsFromGrids(ctx, null, {
        forceFullUpsert: true,
        updateBackfillTimestamp: true,
      });
    }
  } catch (err) {
    console.warn(`[masterEngineService] Phase 5 relational financials backfill warning (${ctx.clientName}):`, err?.message);
  }

  return summary;
}

const ALL_PAUSED_MIRROR_TABLES = [
  "client_jobs",
  "client_outgoings",
  "client_salaries",
  "client_budgets_and_targets",
  "client_cash_balances",
  "pma_tasks",
];

/**
 * Clears stale historical rows from the 14 write-only SQL mirror tables
 * when normalized mirror syncing is paused (`PULSE_SYNC_NORMALIZED_MIRROR_TABLES=false`).
 */
export async function clearPausedNormalizedMirrorTables({ force = false } = {}) {
  if (shouldSyncNormalizedMirrorTables() && !force) {
    throw new Error(
      "Normalized SQL mirror table sync is currently enabled; disable PULSE_SYNC_NORMALIZED_MIRROR_TABLES before clearing mirror tables."
    );
  }
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const deletedByTable = {};
  let totalDeleted = 0;

  for (const tbl of ALL_PAUSED_MIRROR_TABLES) {
    const { count, error } = await supabase
      .from(tbl)
      .delete({ count: "exact" })
      .not("id", "is", null);
    if (error) {
      throw new Error(`Failed clearing ${tbl}: ${error.message}`);
    }
    const n = count || 0;
    deletedByTable[tbl] = n;
    totalDeleted += n;
  }

  return {
    success: true,
    totalDeleted,
    deletedByTable,
  };
}

let _verifiedStage2SchemaReady = false;
let _cachedSqlFiles = null;

function readCachedMigrationSqlFiles_() {
  if (_cachedSqlFiles) return _cachedSqlFiles;
  let migrationSql = "";
  let clockMigrationSql = "";
  try {
    const sqlPath = path.join(process.cwd(), "supabase", "migrations", "0002_stage2_master_and_recon.sql");
    if (fs.existsSync(sqlPath)) {
      migrationSql = fs.readFileSync(sqlPath, "utf8");
    }
  } catch {
    // ignore
  }
  try {
    const clockSqlPath = path.join(process.cwd(), "supabase", "migrations", "0003_supabase_30m_cron_clock.sql");
    if (fs.existsSync(clockSqlPath)) {
      clockMigrationSql = fs.readFileSync(clockSqlPath, "utf8");
    }
  } catch {
    // ignore
  }
  _cachedSqlFiles = { migrationSql, clockMigrationSql };
  return _cachedSqlFiles;
}

/**
 * Returns Stage 2 table counts, client master_mode / client_mode status, and virtual tabs for PMA DB & Workbook Inspector
 */
export async function getStage2Status(targetClientName = "APPTEST") {
  if (!isSupabaseConfigured()) {
    return { configured: false, schemaReady: false, tables: [], clients: [] };
  }
  const supabase = getSupabaseAdmin();

  const [
    tableResults,
    clientsResp,
    allKiResp,
    allGridsResp,
    allSchedsResp,
    allIntsResp,
    targetGridsResp,
    clockStatus,
    phase2JobsStats,
    phase3InputsStats,
    phase4MasterStats,
    phase4ReconStats,
    phase5FinancialsStats,
    phase6NativeStats,
    phase6ConnectorsStats,
    phase6SyncStats,
    phase6RetirementStats,
    execLogClientsResp,
    bpTabRowsResp,
  ] = await Promise.all([
    Promise.all(
      STAGE2_TABLES.map(async (t) => {
        if (_verifiedStage2SchemaReady && !shouldSyncNormalizedMirrorTables() && PAUSED_STAGE2_MIRROR_TABLES.has(t.name)) {
          return { ...t, exists: true, count: 0, mirrorPaused: true };
        }
        try {
          const { count, error } = await supabase
            .from(t.name)
            .select("client_name", { count: "exact", head: true })
            .eq("client_name", targetClientName);
          if (error) {
            return { ...t, exists: false, count: 0, error: error.message };
          }
          return { ...t, exists: true, count: count ?? 0 };
        } catch (err) {
          return { ...t, exists: false, count: 0, error: err.message };
        }
      })
    ),
    (() =>
      supabase
        .from("clients")
        .select("id, client_name, normalized_key, status, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, recon_mode, recon_read_mode, financials_mode, financials_read_mode, client_compute_mode, master_compute_mode, connector_pull_mode, sync_orchestrator_mode, grid_storage_retired, grid_retired_at, client_sheet_id, master_sheet_id, recon_sheet_id, metadata")
        .order("client_name", { ascending: true })
        .then(async (res) => {
          if (res.error && String(res.error.message || "").includes("grid_storage_retired")) {
            res = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, status, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, recon_mode, recon_read_mode, financials_mode, financials_read_mode, client_compute_mode, master_compute_mode, connector_pull_mode, sync_orchestrator_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata")
              .order("client_name", { ascending: true });
          }
          if (res.error && String(res.error.message || "").includes("sync_orchestrator_mode")) {
            res = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, status, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, recon_mode, recon_read_mode, financials_mode, financials_read_mode, client_compute_mode, master_compute_mode, connector_pull_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata")
              .order("client_name", { ascending: true });
          }
          if (res.error && (String(res.error.message || "").includes("client_compute_mode") || String(res.error.message || "").includes("master_compute_mode") || String(res.error.message || "").includes("connector_pull_mode"))) {
            res = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, status, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, recon_mode, recon_read_mode, financials_mode, financials_read_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata")
              .order("client_name", { ascending: true });
          }
          if (res.error && (String(res.error.message || "").includes("financials_mode") || String(res.error.message || "").includes("financials_read_mode"))) {
            res = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, status, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, recon_mode, recon_read_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata")
              .order("client_name", { ascending: true });
          }
          if (res.error && (String(res.error.message || "").includes("recon_mode") || String(res.error.message || "").includes("recon_read_mode"))) {
            res = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, status, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, master_ingestion_mode, master_read_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata")
              .order("client_name", { ascending: true });
          }
          if (res.error && (String(res.error.message || "").includes("master_ingestion_mode") || String(res.error.message || "").includes("master_read_mode"))) {
            res = await supabase
              .from("clients")
              .select("id, client_name, normalized_key, status, master_mode, client_mode, jobs_mode, jobs_read_mode, inputs_mode, inputs_read_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata")
              .order("client_name", { ascending: true });
          }
          if (res.error && (String(res.error.message || "").includes("inputs_mode") || String(res.error.message || "").includes("jobs_read_mode"))) {
            return supabase
              .from("clients")
              .select("id, client_name, normalized_key, status, master_mode, client_mode, client_sheet_id, master_sheet_id, recon_sheet_id, metadata")
              .order("client_name", { ascending: true });
          }
          return res;
        }))(),
    supabase
      .from("tenant_key_info")
      .select("client_name, accounting_tool, crm_tool, crm_drives, client_materialized_at, updated_at")
      .then((r) => r)
      .catch(() => ({ data: [] })),
    (async () => {
      try {
        const all = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase
            .from("master_sheet_grids")
            .select("client_name, sheet_role, tab_name, updated_at")
            .order("client_name", { ascending: true })
            .order("sheet_role", { ascending: true })
            .order("tab_name", { ascending: true })
            .range(from, from + 999);
          if (error || !Array.isArray(data) || data.length === 0) break;
          all.push(...data);
          if (data.length < 1000) break;
        }
        return { data: all };
      } catch {
        return { data: [] };
      }
    })(),
    supabase
      .from("sync_schedules")
      .select("client_name, inv_freq, crm_freq, exp_freq, last_inv_run, last_crm_run, last_exp_run")
      .then((r) => r)
      .catch(() => ({ data: [] })),
    supabase
      .from("tenant_integrations")
      .select("client_id, tool, status")
      .then((r) => r)
      .catch(() => ({ data: [] })),
    supabase
      .from("master_sheet_grids")
      .select("sheet_role, tab_name, row_count, col_count, updated_at")
      .eq("client_name", targetClientName)
      .order("tab_name", { ascending: true })
      .then((r) => r)
      .catch(() => ({ data: [] })),
    getSupabaseClockStatusAndSyncConfig().catch(() => null),
    import("./relationalJobsService.js")
      .then(({ getPhase2RelationalOverviewStats }) =>
        getPhase2RelationalOverviewStats([])
      )
      .catch(() => null),
    import("./relationalInputsService.js")
      .then(({ getPhase3RelationalOverviewStats }) =>
        getPhase3RelationalOverviewStats([])
      )
      .catch(() => null),
    import("./relationalMasterService.js")
      .then(({ getPhase4MasterOverviewStats }) =>
        getPhase4MasterOverviewStats()
      )
      .catch(() => null),
    import("./relationalReconService.js")
      .then(({ getPhase4ReconOverviewStats }) =>
        getPhase4ReconOverviewStats()
      )
      .catch(() => null),
    import("./relationalFinancialsService.js")
      .then(({ getPhase5FinancialsOverviewStats }) =>
        getPhase5FinancialsOverviewStats()
      )
      .catch(() => null),
    import("./nativeClientCalcService.js")
      .then(({ getPhase6NativeComputeOverviewStats }) =>
        getPhase6NativeComputeOverviewStats()
      )
      .catch(() => null),
    import("./nativeConnectorsParityService.js")
      .then(({ getPhase6NativeConnectorsOverviewStats }) =>
        getPhase6NativeConnectorsOverviewStats()
      )
      .catch(() => null),
    import("./nativeSyncOrchestratorService.js")
      .then(({ getPhase6NativeSyncOverviewStats }) =>
        getPhase6NativeSyncOverviewStats()
      )
      .catch(() => null),
    import("./gridRetirementService.js")
      .then(({ getPhase6eRetirementOverviewStats }) =>
        getPhase6eRetirementOverviewStats()
      )
      .catch(() => null),
    (async () => {
      try {
        const all = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase
            .from("pulse_execution_logs")
            .select("client_id")
            .order("id", { ascending: true })
            .range(from, from + 999);
          if (error || !Array.isArray(data) || data.length === 0) break;
          all.push(...data);
          if (data.length < 1000) break;
        }
        return { data: all };
      } catch {
        return { data: [] };
      }
    })(),
    (async () => {
      try {
        const all = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase
            .from("pulse_client_tab_blueprints")
            .select("client_id, tab_name, updated_at")
            .order("id", { ascending: true })
            .range(from, from + 999);
          if (error || !Array.isArray(data) || data.length === 0) break;
          all.push(...data);
          if (data.length < 1000) break;
        }
        return { data: all };
      } catch {
        return { data: [] };
      }
    })(),
  ]);

  const schemaReady = _verifiedStage2SchemaReady || tableResults.every((t) => t.exists);
  if (schemaReady) _verifiedStage2SchemaReady = true;

  const clientsData = clientsResp?.data || [];
  let keyInfoMeta = null;
  let availableTabs = { master: [], recon: [], client: [] };
  let enrichedClients = clientsData;

  if (schemaReady) {
    const allKi = allKiResp?.data || [];
    const allGrids = allGridsResp?.data || [];
    const allScheds = allSchedsResp?.data || [];
    const allInts = allIntsResp?.data || [];
    const targetGrids = targetGridsResp?.data || [];

    const kiByClient = new Map();
    for (const k of allKi || []) {
      kiByClient.set(String(k.client_name || "").trim().toUpperCase(), k);
    }

    const schedByClient = new Map();
    for (const s of allScheds || []) {
      schedByClient.set(String(s.client_name || "").trim().toUpperCase(), s);
    }

    const intsByClientId = new Map();
    for (const row of allInts || []) {
      if (!row.client_id || row.status === "disconnected") continue;
      if (!intsByClientId.has(row.client_id)) intsByClientId.set(row.client_id, []);
      intsByClientId.get(row.client_id).push(String(row.tool || "").trim());
    }

    const execLogClientIds = new Set(
      (execLogClientsResp?.data || []).map((r) => r.client_id).filter(Boolean)
    );
    const blueprintsByClientId = new Map();
    for (const bp of bpTabRowsResp?.data || []) {
      if (!bp.client_id || !bp.tab_name) continue;
      if (!blueprintsByClientId.has(bp.client_id)) blueprintsByClientId.set(bp.client_id, []);
      blueprintsByClientId.get(bp.client_id).push(bp);
    }
    const gridStatsByClient = new Map();
    for (const g of allGrids || []) {
      const cKey = String(g.client_name || "").trim().toUpperCase();
      if (!gridStatsByClient.has(cKey)) {
        gridStatsByClient.set(cKey, {
          masterTabCount: 0,
          reconTabCount: 0,
          clientTabCount: 0,
          hasExecLogs: false,
          lastUpdatedAt: null,
        });
      }
      const st = gridStatsByClient.get(cKey);
      if (g.sheet_role === "recon") {
        st.reconTabCount++;
      } else if (g.sheet_role === "client" || String(g.tab_name || "").startsWith("Client::")) {
        st.clientTabCount++;
      } else if (g.tab_name === "GasExecLogs") {
        st.hasExecLogs = true;
      } else if (g.tab_name !== "GasScriptProps" && g.tab_name !== "SheetBridgeBaseline") {
        st.masterTabCount++;
      }
      if (g.updated_at && (!st.lastUpdatedAt || g.updated_at > st.lastUpdatedAt)) {
        st.lastUpdatedAt = g.updated_at;
      }
    }

    keyInfoMeta = kiByClient.get(String(targetClientName || "").trim().toUpperCase()) || null;
    for (const g of targetGrids || []) {
      if (g.sheet_role === "recon") {
        availableTabs.recon.push(g);
      } else if (g.sheet_role === "client" || String(g.tab_name || "").startsWith("Client::")) {
        availableTabs.client.push({
          ...g,
          sheet_role: "client",
          tab_name: String(g.tab_name || "").startsWith("Client::") ? g.tab_name.slice(8) : g.tab_name,
        });
      } else if (g.tab_name !== "GasExecLogs" && g.tab_name !== "GasScriptProps" && g.tab_name !== "SheetBridgeBaseline") {
        availableTabs.master.push(g);
      }
    }

    const targetClientRow = (clientsData || []).find(
      (c) => String(c.client_name || "").trim().toUpperCase() === String(targetClientName || "").trim().toUpperCase()
    );
    const targetSyncMode = String(
      targetClientRow?.sync_orchestrator_mode || targetClientRow?.metadata?.sync_orchestrator_mode || "grid_gas"
    ).trim().toLowerCase();
    if (targetClientRow && targetSyncMode === "native") {
      if (availableTabs.client.length === 0) {
        const bps = blueprintsByClientId.get(targetClientRow.id) || [];
        availableTabs.client = bps.map((bp) => ({
          sheet_role: "client",
          tab_name: bp.tab_name,
          row_count: null,
          col_count: null,
          updated_at: bp.updated_at || null,
        }));
      }
      if (availableTabs.master.length === 0) {
        availableTabs.master = CORE_MASTER_TABS
          .filter((t) => t !== "GasExecLogs" && t !== "GasScriptProps" && t !== "SheetBridgeBaseline")
          .map((tab_name) => ({
            sheet_role: "master",
            tab_name,
            row_count: null,
            col_count: null,
            updated_at: null,
          }));
      }
      if (availableTabs.recon.length === 0) {
        let rcData = null;
        try {
          const { data } = await supabase
            .from("pulse_recon_configs")
            .select("tab_list, updated_at")
            .eq("client_name", targetClientRow.client_name)
            .maybeSingle();
          rcData = data || null;
        } catch {
          rcData = null;
        }
        const rawTabList = Array.isArray(rcData?.tab_list) ? rcData.tab_list : [];
        const reconTabs = Array.from(
          new Set([
            "KeyInfo",
            "PLAdds",
            ...rawTabList
              .map((raw) => (typeof raw === "string" ? raw : raw?.tab_name))
              .filter(Boolean),
          ])
        );
        availableTabs.recon = reconTabs.map((tab_name) => ({
          sheet_role: "recon",
          tab_name,
          row_count: null,
          col_count: null,
          updated_at: rcData?.updated_at || null,
        }));
      }
    }

    enrichedClients = (clientsData || []).map((c) => {
      const cKey = String(c.client_name || "").trim().toUpperCase();
      const ki = kiByClient.get(cKey) || null;
      const sc = schedByClient.get(cKey) || null;
      const vaultTools = intsByClientId.get(c.id) || [];
      const fallbackAcc = vaultTools.find((t) => /^(xero|quickbooks|qbo)$/i.test(t)) || "";
      const fallbackCrm =
        vaultTools.find((t) => /^(capsule|pipedrive|hubspot|monday|clickup|close)$/i.test(t)) || "";
      const gs = gridStatsByClient.get(cKey) || {
        masterTabCount: 0,
        reconTabCount: 0,
        clientTabCount: 0,
        hasExecLogs: false,
        lastUpdatedAt: null,
      };
      return {
        ...c,
        hasRealClientSheet: Boolean(c.client_sheet_id && !isVirtualSupabaseSheetId(c.client_sheet_id)),
        hasRealMasterSheet: Boolean(c.master_sheet_id && !isVirtualSupabaseSheetId(c.master_sheet_id)),
        hasRealReconSheet: Boolean(c.recon_sheet_id && !isVirtualSupabaseSheetId(c.recon_sheet_id)),
        sheetBridgeMode: String(c.metadata?.sheet_bridge_mode || "off").trim().toLowerCase(),
        sheetBridgeState: c.metadata?.sheet_bridge_state || null,
        jobsMode: String(c.jobs_mode || c.metadata?.jobs_mode || "grid").trim().toLowerCase(),
        jobsReadMode: String(c.jobs_read_mode || c.metadata?.jobs_read_mode || "grid").trim().toLowerCase(),
        relationalJobsState: c.metadata?.relational_jobs_state || null,
        inputsMode: String(c.inputs_mode || c.metadata?.inputs_mode || "grid").trim().toLowerCase(),
        inputsReadMode: String(c.inputs_read_mode || c.metadata?.inputs_read_mode || "grid").trim().toLowerCase(),
        relationalInputsState: c.metadata?.relational_inputs_state || null,
        masterIngestionMode: String(c.master_ingestion_mode || c.metadata?.master_ingestion_mode || "grid").trim().toLowerCase(),
        masterReadMode: String(c.master_read_mode || c.metadata?.master_read_mode || "grid").trim().toLowerCase(),
        relationalMasterState: c.metadata?.relational_master_state || null,
        reconMode: String(c.recon_mode || c.metadata?.recon_mode || "grid").trim().toLowerCase(),
        reconReadMode: String(c.recon_read_mode || c.metadata?.recon_read_mode || "grid").trim().toLowerCase(),
        relationalReconState: c.metadata?.relational_recon_state || null,
        financialsMode: String(c.financials_mode || c.metadata?.financials_mode || "grid").trim().toLowerCase(),
        financialsReadMode: String(c.financials_read_mode || c.metadata?.financials_read_mode || "grid").trim().toLowerCase(),
        relationalFinancialsState: c.metadata?.relational_financials_state || null,
        clientComputeMode: String(c.client_compute_mode || c.metadata?.client_compute_mode || "grid_gas").trim().toLowerCase(),
        masterComputeMode: String(c.master_compute_mode || c.metadata?.master_compute_mode || "grid_gas").trim().toLowerCase(),
        connectorPullMode: String(c.connector_pull_mode || c.metadata?.connector_pull_mode || "grid_gas").trim().toLowerCase(),
        syncOrchestratorMode: String(c.sync_orchestrator_mode || c.metadata?.sync_orchestrator_mode || "grid_gas").trim().toLowerCase(),
        gridStorageRetired: Boolean(c.grid_storage_retired),
        gridRetiredAt: c.grid_retired_at || null,
        nativeClientCalcState: c.metadata?.native_client_calc_state || null,
        nativeMasterCompState: c.metadata?.native_master_comp_state || null,
        nativeConnectorsState: c.metadata?.native_connectors_state || null,
        nativeSyncState: c.metadata?.native_sync_state || null,
        masterTabCount: gs.masterTabCount || (String(c.sync_orchestrator_mode || "").toLowerCase() === "native" ? CORE_MASTER_TABS.length : 0),
        reconTabCount: gs.reconTabCount,
        clientTabCount: gs.clientTabCount || (blueprintsByClientId.get(c.id)?.length || 0),
        hasExecLogs: gs.hasExecLogs || execLogClientIds.has(c.id),
        lastGridUpdatedAt: gs.lastUpdatedAt,
        materializedAt: ki?.client_materialized_at || null,
        accountingTool: ki?.accounting_tool || fallbackAcc,
        crmTool: ki?.crm_tool || fallbackCrm,
        crmDrives: ki?.crm_drives || "",
        invFreq: sc?.inv_freq || "",
        crmFreq: sc?.crm_freq || "",
        expFreq: sc?.exp_freq || "",
        invLastRun: sc?.last_inv_run || null,
        crmLastRun: sc?.last_crm_run || null,
        expLastRun: sc?.last_exp_run || null,
      };
    });
  }

  const { migrationSql, clockMigrationSql } = readCachedMigrationSqlFiles_();

  let backfilledClientsCount = 0;
  let relationalModeClientsCount = 0;
  let relationalReadModeClientsCount = 0;
  let phase3BackfilledCount = 0;
  let inputsModeClientsCount = 0;
  let inputsReadModeClientsCount = 0;
  let phase4BackfilledCount = 0;
  let masterIngestionModeClientsCount = 0;
  let masterReadModeClientsCount = 0;
  let phase4ReconBackfilledCount = 0;
  let reconModeClientsCount = 0;
  let reconReadModeClientsCount = 0;
  let phase5BackfilledCount = 0;
  let financialsModeClientsCount = 0;
  let financialsReadModeClientsCount = 0;
  let phase6ClientBackfilledCount = 0;
  let phase6MasterBackfilledCount = 0;
  let clientComputeNativeCount = 0;
  let clientComputeShadowCount = 0;
  let masterComputeNativeCount = 0;
  let masterComputeShadowCount = 0;
  let connectorNativeCount = 0;
  let connectorShadowCount = 0;
  let phase6ConnectorsBackfilledCount = 0;
  let syncOrchestratorNativeCount = 0;
  let syncOrchestratorShadowCount = 0;
  let phase6SyncBackfilledCount = 0;
  for (const c of clientsData || []) {
    if (c?.metadata?.relational_jobs_state?.lastBackfilledAt) backfilledClientsCount++;
    if (String(c?.jobs_mode || c?.metadata?.jobs_mode || "").trim().toLowerCase() === "relational") relationalModeClientsCount++;
    if (String(c?.jobs_read_mode || c?.metadata?.jobs_read_mode || "").trim().toLowerCase() === "relational") relationalReadModeClientsCount++;
    if (c?.metadata?.relational_inputs_state?.lastBackfilledAt) phase3BackfilledCount++;
    if (String(c?.inputs_mode || c?.metadata?.inputs_mode || "").trim().toLowerCase() === "relational") inputsModeClientsCount++;
    if (String(c?.inputs_read_mode || c?.metadata?.inputs_read_mode || "").trim().toLowerCase() === "relational") inputsReadModeClientsCount++;
    if (c?.metadata?.relational_master_state?.lastBackfilledAt) phase4BackfilledCount++;
    if (String(c?.master_ingestion_mode || c?.metadata?.master_ingestion_mode || "").trim().toLowerCase() === "relational") masterIngestionModeClientsCount++;
    if (String(c?.master_read_mode || c?.metadata?.master_read_mode || "").trim().toLowerCase() === "relational") masterReadModeClientsCount++;
    if (c?.metadata?.relational_recon_state?.lastBackfilledAt) phase4ReconBackfilledCount++;
    if (String(c?.recon_mode || c?.metadata?.recon_mode || "").trim().toLowerCase() === "relational") reconModeClientsCount++;
    if (String(c?.recon_read_mode || c?.metadata?.recon_read_mode || "").trim().toLowerCase() === "relational") reconReadModeClientsCount++;
    if (c?.metadata?.relational_financials_state?.lastBackfilledAt) phase5BackfilledCount++;
    if (String(c?.financials_mode || c?.metadata?.financials_mode || "").trim().toLowerCase() === "relational") financialsModeClientsCount++;
    if (String(c?.financials_read_mode || c?.metadata?.financials_read_mode || "").trim().toLowerCase() === "relational") financialsReadModeClientsCount++;
    if (c?.metadata?.native_client_calc_state?.lastBackfilledAt) phase6ClientBackfilledCount++;
    if (c?.metadata?.native_master_comp_state?.lastBackfilledAt) phase6MasterBackfilledCount++;
    if (c?.metadata?.native_connectors_state?.lastBackfilledAt) phase6ConnectorsBackfilledCount++;
    if (c?.metadata?.native_sync_state?.lastBackfilledAt) phase6SyncBackfilledCount++;
    const cComp = String(c?.client_compute_mode || c?.metadata?.client_compute_mode || "").trim().toLowerCase();
    if (cComp === "native") clientComputeNativeCount++;
    else if (cComp === "shadow") clientComputeShadowCount++;
    const mComp = String(c?.master_compute_mode || c?.metadata?.master_compute_mode || "").trim().toLowerCase();
    if (mComp === "native") masterComputeNativeCount++;
    else if (mComp === "shadow") masterComputeShadowCount++;
    const cPull = String(c?.connector_pull_mode || c?.metadata?.connector_pull_mode || "").trim().toLowerCase();
    if (cPull === "native") connectorNativeCount++;
    else if (cPull === "shadow") connectorShadowCount++;
    const sOrch = String(c?.sync_orchestrator_mode || c?.metadata?.sync_orchestrator_mode || "").trim().toLowerCase();
    if (sOrch === "native") syncOrchestratorNativeCount++;
    else if (sOrch === "shadow") syncOrchestratorShadowCount++;
  }

  return {
    configured: true,
    schemaReady,
    targetClientName,
    tables: tableResults,
    keyInfoMeta,
    availableTabs,
    clients: enrichedClients,
    migrationSql,
    clockMigrationSql,
    clockStatus,
    phase2Jobs: phase2JobsStats
      ? {
        ...phase2JobsStats,
        backfilledClientsCount,
        relationalModeClientsCount,
        relationalReadModeClientsCount,
      }
      : {
        schemaReady: false,
        migrationSql: "",
        totalJobs: 0,
        totalSeries: 0,
        totalInvoices: 0,
        totalExpenses: 0,
        backfilledClientsCount,
        relationalModeClientsCount,
      },
    phase3Inputs: phase3InputsStats
      ? {
        ...phase3InputsStats,
        backfilledClientsCount: phase3BackfilledCount,
        inputsModeClientsCount,
        inputsReadModeClientsCount,
      }
      : {
        schemaReady: false,
        migrationSql: "",
        totalEmployees: 0,
        totalOutgoingItems: 0,
        totalContractorEntries: 0,
        totalNbClients: 0,
        totalBudgetItems: 0,
        totalCashAdjustments: 0,
        totalCashBankBalances: 0,
        backfilledClientsCount: phase3BackfilledCount,
        inputsModeClientsCount,
        inputsReadModeClientsCount,
      },
    phase4Master: phase4MasterStats
      ? {
        ...phase4MasterStats,
        backfilledClientsCount: phase4BackfilledCount,
        masterIngestionModeClientsCount,
        masterReadModeClientsCount,
      }
      : {
        schemaReady: false,
        migrationSql: "",
        totalInvoices: 0,
        totalDirectCosts: 0,
        totalPlLines: 0,
        totalCrmDeals: 0,
        totalTimeEntries: 0,
        totalConfigTabs: 0,
        backfilledClientsCount: phase4BackfilledCount,
        masterIngestionModeClientsCount,
        masterReadModeClientsCount,
      },
    phase4Recon: phase4ReconStats
      ? {
        ...phase4ReconStats,
        backfilledClientsCount: phase4ReconBackfilledCount,
        reconModeClientsCount,
        reconReadModeClientsCount,
      }
      : {
        schemaReady: false,
        migrationSql: "",
        totalPeriods: 0,
        completedPeriods: 0,
        totalReconciledItems: 0,
        totalUnreconciledItems: 0,
        totalLearningRules: 0,
        totalReconConfigs: 0,
        backfilledClientsCount: phase4ReconBackfilledCount,
        reconModeClientsCount,
        reconReadModeClientsCount,
      },
    phase5Financials: phase5FinancialsStats
      ? {
        ...phase5FinancialsStats,
        backfilledClientsCount: phase5BackfilledCount,
        financialsModeClientsCount,
        financialsReadModeClientsCount,
      }
      : {
        schemaReady: false,
        migrationSql: "",
        totalRollupMonths: 0,
        totalYear0Lines: 0,
        totalStatementLines: 0,
        totalVatRows: 0,
        totalCashflowLines: 0,
        totalFinancialConfigs: 0,
        backfilledClientsCount: phase5BackfilledCount,
        financialsModeClientsCount,
        financialsReadModeClientsCount,
      },
    phase6NativeCompute: phase6NativeStats
      ? {
        ...phase6NativeStats,
        clientBackfilledCount: phase6ClientBackfilledCount,
        masterBackfilledCount: phase6MasterBackfilledCount,
        clientComputeNativeCount,
        clientComputeShadowCount,
        masterComputeNativeCount,
        masterComputeShadowCount,
      }
      : {
        schemaReady: false,
        migrationSql: "",
        totalClientBlueprintTabs: 0,
        totalMasterComparisons: 0,
        clientsOnNativeClientCalc: clientComputeNativeCount,
        clientsOnShadowClientCalc: clientComputeShadowCount,
        clientsOnNativeMasterComp: masterComputeNativeCount,
        clientsOnShadowMasterComp: masterComputeShadowCount,
        clientBackfilledCount: phase6ClientBackfilledCount,
        masterBackfilledCount: phase6MasterBackfilledCount,
        clientComputeNativeCount,
        clientComputeShadowCount,
        masterComputeNativeCount,
        masterComputeShadowCount,
      },
    phase6NativeConnectors: phase6ConnectorsStats
      ? {
        ...phase6ConnectorsStats,
        backfilledCount: phase6ConnectorsBackfilledCount,
        connectorNativeCount,
        connectorShadowCount,
      }
      : {
        schemaReady: false,
        migrationSql: "",
        totalConfigs: 0,
        backfilledCount: phase6ConnectorsBackfilledCount,
        connectorNativeCount,
        connectorShadowCount,
      },
    phase6NativeSync: phase6SyncStats
      ? {
        ...phase6SyncStats,
        backfilledCount: phase6SyncBackfilledCount,
        syncOrchestratorNativeCount,
        syncOrchestratorShadowCount,
      }
      : {
        schemaReady: false,
        migrationSql: "",
        totalAutoLogs: 0,
        totalExecLogs: 0,
        totalBackfilledConfigs: 0,
        backfilledCount: phase6SyncBackfilledCount,
        syncOrchestratorNativeCount,
        syncOrchestratorShadowCount,
      },
    phase6GridRetirement: phase6RetirementStats
      ? phase6RetirementStats
      : {
        schemaReady: false,
        migrationSql: "",
        retiredClientsCount: 0,
        remainingGridRows: 0,
        migratedBaselinesCount: 0,
      },
  };
}

/**
 * Ensures the Supabase 30-minute clock config row exists in public.system_config
 * and queries pg_cron status via public.get_pulse_30m_clock_status().
 */
export async function getSupabaseClockStatusAndSyncConfig(updatedBy = "System") {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  const bypassToken = String(
    process.env.VERCEL_BYPASS_TOKEN || process.env.VERCEL_AUTOMATION_BYPASS_SECRET || ""
  ).trim();
  const defaultUrl = "https://app.pulsedashboard.co.uk/api/cron";

  const { data: cfgRow } = await supabase
    .from("system_config")
    .select("*")
    .eq("key", "supabase_cron_clock")
    .maybeSingle();

  let cfgVal = cfgRow?.value && typeof cfgRow.value === "object" ? { ...cfgRow.value } : null;

  let rpcSecretsSynced = false;
  if (cronSecret || bypassToken) {
    try {
      const { data: rpcSecRes, error: rpcSecErr } = await supabase.rpc("sync_pulse_clock_secrets", {
        p_target_url: cfgVal?.targetUrl || defaultUrl,
        p_cron_secret: cronSecret,
        p_bypass_token: bypassToken,
      });
      if (!rpcSecErr && rpcSecRes?.success) {
        rpcSecretsSynced = true;
      }
    } catch {
      // Migration 0010 not installed yet
    }
  }

  const needsSeedOrRefresh =
    !cfgVal ||
    !cfgVal.targetUrl ||
    Boolean(cfgVal.cronSecret || cfgVal.bypassToken);

  if (needsSeedOrRefresh) {
    cfgVal = {
      ...(cfgVal || {}),
      enabled: cfgVal?.enabled !== undefined ? Boolean(cfgVal.enabled) : true,
      targetUrl: cfgVal?.targetUrl || defaultUrl,
      hasSecretConfigured: Boolean(cronSecret || rpcSecretsSynced),
      updatedAt: new Date().toISOString(),
    };
    delete cfgVal.cronSecret;
    delete cfgVal.bypassToken;
    await supabase.from("system_config").upsert({
      key: "supabase_cron_clock",
      value: cfgVal,
      description: "Supabase pg_cron 30-minute wake-up clock configuration and telemetry",
      updated_by: updatedBy,
    });
  }

  let rpcStatus = null;
  try {
    const { data: rpcData, error: rpcErr } = await supabase.rpc("get_pulse_30m_clock_status");
    if (!rpcErr && rpcData) {
      rpcStatus = rpcData;
    }
  } catch {
    // RPC not installed yet until 0003_supabase_30m_cron_clock.sql is run
  }

  const rpcReady = Boolean(rpcStatus && rpcStatus.pgCronInstalled && rpcStatus.pgNetInstalled);
  const jobActive = Boolean(rpcStatus?.jobActive);
  const enabled = cfgVal?.enabled !== false;

  return {
    rpcReady,
    pgCronInstalled: Boolean(rpcStatus?.pgCronInstalled),
    pgNetInstalled: Boolean(rpcStatus?.pgNetInstalled),
    jobScheduled: Boolean(rpcStatus?.jobScheduled),
    jobActive,
    schedule: rpcStatus?.schedule || "*/30 * * * *",
    enabled,
    activeAndRunning: Boolean(rpcReady && jobActive && enabled),
    targetUrl: cfgVal?.targetUrl || defaultUrl,
    hasSecretConfigured: Boolean(rpcSecretsSynced || cfgVal?.hasSecretConfigured || cfgVal?.cronSecret),
    lastTriggeredAt: cfgVal?.lastTriggeredAt || null,
    lastTriggerSource: cfgVal?.lastTriggerSource || null,
    lastWebhookReceivedAt: cfgVal?.lastWebhookReceivedAt || null,
    lastWebhookSource: cfgVal?.lastWebhookSource || null,
  };
}

/**
 * Enables or pauses the Supabase 30-minute clock in public.system_config.
 */
export async function setSupabaseClockEnabled(enabled, updatedBy = "Admin") {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  await getSupabaseClockStatusAndSyncConfig(updatedBy);
  const { data: cfgRow, error: cfgReadErr } = await supabase
    .from("system_config")
    .select("*")
    .eq("key", "supabase_cron_clock")
    .maybeSingle();
  if (cfgReadErr) {
    throw new Error(`Failed reading system_config clock state: ${cfgReadErr.message}`);
  }

  const nextVal = {
    ...(cfgRow?.value || {}),
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString(),
  };

  const { error: cfgUpsertErr } = await supabase.from("system_config").upsert({
    key: "supabase_cron_clock",
    value: nextVal,
    description: "Supabase pg_cron 30-minute wake-up clock configuration and telemetry",
    updated_by: updatedBy,
  });
  if (cfgUpsertErr) {
    throw new Error(`Failed updating system_config clock state: ${cfgUpsertErr.message}`);
  }

  return getSupabaseClockStatusAndSyncConfig(updatedBy);
}

/**
 * Manually triggers public.run_pulse_30m_clock(true) inside Supabase via RPC.
 */
export async function triggerSupabaseClockNow(updatedBy = "Admin") {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  await getSupabaseClockStatusAndSyncConfig(updatedBy);
  const { data, error } = await supabase.rpc("run_pulse_30m_clock", { p_force: true });
  if (error) {
    throw new Error(
      error.message.includes("run_pulse_30m_clock")
        ? "Supabase function public.run_pulse_30m_clock() is not installed yet. Copy and run the 0003_supabase_30m_cron_clock.sql script in the Supabase SQL Editor first."
        : error.message
    );
  }
  return data;
}

/**
 * Updates the cron schedule for pulse-30m-wakeup-clock in Supabase via set_pulse_clock_schedule RPC.
 */
export async function setSupabaseClockSchedule(newSchedule = "*/10 * * * *", updatedBy = "Admin") {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const { data, error } = await supabase.rpc("set_pulse_clock_schedule", { p_schedule: newSchedule });
  if (error) {
    throw new Error(
      error.message.includes("set_pulse_clock_schedule")
        ? "Supabase function public.set_pulse_clock_schedule() is not installed yet. Copy and run the 0005_update_cron_frequency_to_10m.sql migration in the Supabase SQL Editor first."
        : error.message
    );
  }
  return getSupabaseClockStatusAndSyncConfig(updatedBy);
}

/**
 * Fetches a virtual tab grid for the Admin Workbook Inspector
 */
export async function getVirtualTabForInspector({
  clientName = "APPTEST",
  sheetRole = "master",
  tabName = "KeyInfo",
  maxRows = 300,
  maxCols = 500,
  includeFormulas = true,
  includeRawValues = false,
  includeNotes = false,
  trimTrailingEmptyRows = false,
  forceMasterSource = null,
  forceReconSource = null,
  forceFinancialsSource = null,
}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  let data = null;
  let error = null;
  let staleAgainstClientEdits = false;
  let usedRelationalMaster = false;
  let usedRelationalRecon = false;
  let usedRelationalFinancials = false;
  if (sheetRole === "client") {
    const clientSelectCols = includeFormulas
      ? "sheet_role, tab_name, row_count, col_count, values_grid, formulas_grid, notes_grid, updated_at"
      : "sheet_role, tab_name, row_count, col_count, values_grid, notes_grid, updated_at";
    const res = await supabase
      .from("master_sheet_grids")
      .select(clientSelectCols)
      .eq("client_name", clientName)
      .in("sheet_role", ["client", "master"])
      .in("tab_name", [String(tabName), `Client::${String(tabName)}`]);
    error = res.error;
    const rows = Array.isArray(res.data) ? res.data : [];
    data =
      rows.find((r) => r.sheet_role === "client" && r.tab_name === String(tabName)) ||
      rows.find((r) => r.sheet_role === "master" && r.tab_name === `Client::${String(tabName)}`) ||
      null;
    if (!error && data) {
      expandClientTabFromStorage_(data, tabName, { valuesOnly: !includeFormulas });
    }
    if (PHASE5_FINANCIAL_TAB_SET_.has(tabName) && forceFinancialsSource !== "grid") {
      try {
        const ctx = await resolveSupabaseSheetContext({ clientName });
        const shouldUseRelationalFin =
          forceFinancialsSource === "relational" || (ctx && ctx.financialsReadMode === "relational");
        if (shouldUseRelationalFin && ctx) {
          const {
            preloadClientRelationalFinancialsBundle,
            reconstructRelationalFinancialTabFromBundle,
          } = await import("./relationalFinancialsService.js");
          const bundle = await preloadClientRelationalFinancialsBundle(ctx, {
            source: "db",
            includeFormulas,
          });
          const finTabData = reconstructRelationalFinancialTabFromBundle(bundle, tabName, {
            includeFormulas,
          });
          if (finTabData && Array.isArray(finTabData.values_grid)) {
            data = {
              row_count: finTabData.row_count || finTabData.values_grid.length,
              col_count: finTabData.col_count || 0,
              values_grid: finTabData.values_grid,
              formulas_grid: includeFormulas
                ? finTabData.formulas_grid || data?.formulas_grid || finTabData.values_grid
                : undefined,
              notes_grid:
                finTabData.notes_grid && Object.keys(finTabData.notes_grid).length > 0
                  ? finTabData.notes_grid
                  : data?.notes_grid || {},
              updated_at: finTabData.updated_at || data?.updated_at || new Date().toISOString(),
            };
            error = null;
            usedRelationalFinancials = true;
          }
        }
      } catch (relErr) {
        console.warn(`[masterEngineService] Inspector relational financials fallback for ${clientName}/${tabName}:`, relErr?.message);
      }
    } else if (!PHASE5_FINANCIAL_TAB_SET_.has(tabName) && forceFinancialsSource !== "grid") {
      try {
        const ctx = await resolveSupabaseSheetContext({ clientName });
        const shouldUseNativeCalc =
          forceFinancialsSource === "relational" || (ctx && ctx.clientComputeMode === "native");
        if (shouldUseNativeCalc && ctx) {
          const { loadNativeClientTabRecord } = await import("./nativeClientCalcService.js");
          const natRec = await loadNativeClientTabRecord(ctx, tabName, {
            source: "db",
            valuesOnly: !includeFormulas,
            includeNotes,
          });
          if (natRec && Array.isArray(natRec.values_grid)) {
            data = {
              row_count: natRec.row_count || natRec.values_grid.length,
              col_count: natRec.col_count || 0,
              values_grid: natRec.values_grid,
              formulas_grid: includeFormulas
                ? natRec.formulas_grid || data?.formulas_grid || natRec.values_grid
                : undefined,
              notes_grid:
                natRec.notes_grid && Object.keys(natRec.notes_grid).length > 0
                  ? natRec.notes_grid
                  : data?.notes_grid || {},
              updated_at: natRec.updated_at || data?.updated_at || new Date().toISOString(),
            };
            error = null;
            usedRelationalFinancials = true;
          }
        }
      } catch (natErr) {
        console.warn(`[masterEngineService] Inspector native client calc fallback for ${clientName}/${tabName}:`, natErr?.message);
      }
    }
  } else {
    const selectCols = includeFormulas
      ? "row_count, col_count, values_grid, formulas_grid, notes_grid, updated_at"
      : "row_count, col_count, values_grid, notes_grid, updated_at";
    const isComparisonTab =
      sheetRole === "master" &&
      (tabName === "InvComp" || tabName === "DirComp" || tabName === "CRMComp");
    const [res, clientEditRes] = await Promise.all([
      supabase
        .from("master_sheet_grids")
        .select(selectCols)
        .eq("client_name", clientName)
        .eq("sheet_role", sheetRole)
        .eq("tab_name", tabName)
        .maybeSingle(),
      isComparisonTab
        ? supabase
          .from("master_sheet_grids")
          .select("updated_at")
          .eq("client_name", clientName)
          .in("tab_name", [
            "Confirmed",
            "Pipeline",
            "Outgoings",
            "Client::Confirmed",
            "Client::Pipeline",
            "Client::Outgoings",
          ])
          .order("updated_at", { ascending: false })
          .limit(1)
        : Promise.resolve({ data: null, error: null }),
    ]);
    data = res.data;
    error = res.error;
    try {
      if (
        isComparisonTab &&
        !clientEditRes?.error &&
        Array.isArray(clientEditRes?.data) &&
        clientEditRes.data[0]?.updated_at &&
        data?.updated_at
      ) {
        const latestClientMs = Date.parse(clientEditRes.data[0].updated_at);
        const masterUpdatedMs = Date.parse(data.updated_at);
        staleAgainstClientEdits = Boolean(
          Number.isFinite(latestClientMs) &&
          Number.isFinite(masterUpdatedMs) &&
          latestClientMs > masterUpdatedMs + 2000
        );
      }
    } catch (_) {
      staleAgainstClientEdits = false;
    }

    if (sheetRole === "master" && PHASE4_MASTER_TAB_SET_.has(tabName) && forceMasterSource !== "grid") {
      try {
        const ctx = await resolveSupabaseSheetContext({ clientName });
        const shouldUseRelational =
          forceMasterSource === "relational" || (ctx && ctx.masterReadMode === "relational");
        if (shouldUseRelational && ctx) {
          const {
            preloadClientRelationalMasterBundle,
            reconstructRelationalMasterTabFromBundle,
          } = await import("./relationalMasterService.js");
          const bundle = await preloadClientRelationalMasterBundle(ctx, {
            source: "db",
            tabs: [tabName],
          });
          const reconGrid = await reconstructRelationalMasterTabFromBundle(bundle, tabName, ctx);
          if (Array.isArray(reconGrid)) {
            const maxColsRecon = reconGrid.reduce((m, row) => Math.max(m, Array.isArray(row) ? row.length : 0), 0);
            data = {
              row_count: reconGrid.length,
              col_count: maxColsRecon,
              values_grid: reconGrid,
              formulas_grid: includeFormulas ? data?.formulas_grid || reconGrid : undefined,
              notes_grid: data?.notes_grid || {},
              updated_at: data?.updated_at || new Date().toISOString(),
            };
            error = null;
            usedRelationalMaster = true;
          }
        }
      } catch (relErr) {
        console.warn(`[masterEngineService] Inspector relational master fallback for ${clientName}/${tabName}:`, relErr?.message);
      }
    } else if (
      sheetRole === "master" &&
      !PHASE4_MASTER_TAB_SET_.has(tabName) &&
      (tabName === "KeyInfo" || tabName === "DataChgAlert" || tabName === "PLAdds" || tabName === "Outgoings") &&
      forceMasterSource !== "grid"
    ) {
      try {
        const ctx = await resolveSupabaseSheetContext({ clientName });
        const shouldUseNativeMaster =
          forceMasterSource === "relational" || (ctx && ctx.masterComputeMode === "native");
        if (shouldUseNativeMaster && ctx) {
          const {
            loadMasterContextTabFromConfig,
            loadPersistedOrEvaluateMasterComparisonTab,
          } = await import("./nativeMasterComparisonService.js");
          const nativeGrid =
            tabName === "Outgoings"
              ? await loadPersistedOrEvaluateMasterComparisonTab(ctx, "Outgoings")
              : await loadMasterContextTabFromConfig(ctx, tabName);
          if (Array.isArray(nativeGrid) && nativeGrid.length > 0) {
            const maxColsNat = nativeGrid.reduce((m, row) => Math.max(m, Array.isArray(row) ? row.length : 0), 0);
            data = {
              row_count: nativeGrid.length,
              col_count: maxColsNat,
              values_grid: nativeGrid,
              formulas_grid: includeFormulas ? data?.formulas_grid || nativeGrid : undefined,
              notes_grid: data?.notes_grid || {},
              updated_at: data?.updated_at || new Date().toISOString(),
            };
            error = null;
            usedRelationalMaster = true;
          }
        }
      } catch (natMasterErr) {
        console.warn(`[masterEngineService] Inspector native master context fallback for ${clientName}/${tabName}:`, natMasterErr?.message);
      }
    } else if (sheetRole === "master" && forceMasterSource !== "grid") {
      try {
        const ctx = await resolveSupabaseSheetContext({ clientName });
        const shouldUseNativeMaster =
          forceMasterSource === "relational" || (ctx && (ctx.masterComputeMode === "native" || ctx.syncOrchestratorMode === "native"));
        if (shouldUseNativeMaster && ctx) {
          const rec = await getOrLoadVirtualTabGrid_(ctx, "master", tabName, null).catch(() => null);
          if (rec && Array.isArray(rec.values_grid)) {
            data = {
              row_count: rec.row_count || rec.values_grid.length,
              col_count: rec.col_count || rec.values_grid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
              values_grid: rec.values_grid,
              formulas_grid: includeFormulas ? rec.formulas_grid || data?.formulas_grid || rec.values_grid : undefined,
              notes_grid: rec.notes_grid || data?.notes_grid || {},
              updated_at: rec.updated_at || data?.updated_at || new Date().toISOString(),
            };
            error = null;
            usedRelationalMaster = true;
          }
        }
      } catch (natFallbackErr) {
        console.warn(`[masterEngineService] Inspector native master fallback for ${clientName}/${tabName}:`, natFallbackErr?.message);
      }
    }

    if (sheetRole === "recon" && forceReconSource !== "grid") {
      try {
        const {
          isManagedReconTab,
          preloadClientRelationalReconBundle,
          reconstructRelationalReconTabFromBundle,
        } = await import("./relationalReconService.js");
        if (isManagedReconTab(tabName)) {
          const ctx = await resolveSupabaseSheetContext({ clientName });
          const shouldUseRelationalRecon =
            forceReconSource === "relational" || (ctx && ctx.reconReadMode === "relational");
          if (shouldUseRelationalRecon && ctx) {
            const bundle = await preloadClientRelationalReconBundle(ctx, { source: "db" });
            const reconTabData = reconstructRelationalReconTabFromBundle(bundle, tabName);
            if (reconTabData && Array.isArray(reconTabData.values_grid)) {
              data = {
                row_count: reconTabData.row_count || reconTabData.values_grid.length,
                col_count: reconTabData.col_count || 0,
                values_grid: reconTabData.values_grid,
                formulas_grid: includeFormulas
                  ? reconTabData.formulas_grid || reconTabData.values_grid
                  : undefined,
                notes_grid:
                  reconTabData.notes_grid && Object.keys(reconTabData.notes_grid).length > 0
                    ? reconTabData.notes_grid
                    : data?.notes_grid || {},
                updated_at: reconTabData.updated_at || data?.updated_at || new Date().toISOString(),
              };
              error = null;
              usedRelationalRecon = true;
            }
          }
        }
      } catch (relErr) {
        console.warn(`[masterEngineService] Inspector relational recon fallback for ${clientName}/${tabName}:`, relErr?.message);
      }
    }
  }

  if (error) throw new Error(error.message);
  if (!data) {
    return {
      clientName,
      sheetRole,
      tabName,
      rowCount: 0,
      colCount: 0,
      valuesGrid: [],
      ...(includeFormulas ? { formulasGrid: [] } : {}),
      ...(includeRawValues ? { rawValuesGrid: [] } : {}),
      ...(includeNotes ? { notesGrid: {} } : {}),
      staleAgainstClientEdits: false,
      updatedAt: null,
      readSource: usedRelationalMaster || usedRelationalRecon || usedRelationalFinancials ? "relational" : "grid",
    };
  }

  const allVals = data.values_grid || [];
  let effectiveMaxRows = maxRows;
  if (trimTrailingEmptyRows) {
    if (sheetRole === "client" && (tabName === "Confirmed" || tabName === "Pipeline")) {
      effectiveMaxRows = Math.min(maxRows, Math.max(30, findLastActiveClientJobRow_(allVals, 25) + 15));
    } else {
      const scanLimit = Math.min(allVals.length, maxRows);
      let lastMeaningfulRow = 20;
      for (let r = scanLimit - 1; r >= 5; r--) {
        const row = allVals[r];
        if (!Array.isArray(row)) continue;
        let hasContent = false;
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (v !== null && v !== undefined && v !== false) {
            const s = String(v).trim();
            if (s !== "" && s.toUpperCase() !== "FALSE") {
              hasContent = true;
              break;
            }
          }
        }
        if (hasContent) {
          lastMeaningfulRow = r;
          break;
        }
      }
      effectiveMaxRows = Math.min(maxRows, Math.max(26, lastMeaningfulRow + 6));
    }
  }

  const rawSlice = allVals
    .slice(0, effectiveMaxRows)
    .map((r) => (Array.isArray(r) ? r.slice(0, maxCols) : []));
  const vGrid =
    tabName === "GasExecLogs"
      ? rawSlice
      : formatGridForDisplay(
        sheetRole,
        tabName,
        rawSlice,
        0,
        0,
        allVals,
        data.notes_grid || {}
      );
  const fGrid = includeFormulas
    ? (data.formulas_grid || allVals)
      .slice(0, effectiveMaxRows)
      .map((r) => (Array.isArray(r) ? r.slice(0, maxCols) : []))
    : null;

  return {
    clientName,
    sheetRole,
    tabName,
    rowCount: data.row_count || allVals.length,
    colCount: data.col_count || 0,
    valuesGrid: vGrid,
    ...(includeFormulas ? { formulasGrid: fGrid } : {}),
    ...(includeRawValues ? { rawValuesGrid: rawSlice } : {}),
    ...(includeNotes ? { notesGrid: data.notes_grid || {} } : {}),
    staleAgainstClientEdits,
    updatedAt: data.updated_at,
    readSource: usedRelationalMaster || usedRelationalRecon || usedRelationalFinancials ? "relational" : "grid",
  };
}

/**
 * Updates one or more cells inside a virtual tab from the inspector/modal in a single batch
 * (with one save, one formula recompute pass, and optional Master->Client mirroring).
 */
export async function updateVirtualTabCellsFromInspector({
  sheets,
  clientName = "APPTEST",
  sheetRole = "master",
  tabName = "KeyInfo",
  updates = [],
}) {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error("At least one cell update is required.");
  }

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, tabName, null);
  const nextVals = Array.isArray(rec.values_grid) ? rec.values_grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];
  const baseForms = rec.formulas_grid || rec.values_grid || [];
  const nextForms = Array.isArray(baseForms) ? baseForms.map((r) => (Array.isArray(r) ? [...r] : [])) : [];

  const coords = [];
  const masterMirrorRanges = [];
  for (const item of updates) {
    const r = Number(item?.rowIndex0);
    const c = Number(item?.colIndex0);
    if (!Number.isInteger(r) || r < 0 || r >= 50000) {
      throw new Error(`Virtual sheet write row out of bounds (${item?.rowIndex0} in ${tabName})`);
    }
    if (!Number.isInteger(c) || c < 0 || c >= 600) {
      throw new Error(`Virtual sheet write column out of bounds (${item?.colIndex0} in ${tabName})`);
    }
    const rawVal = item?.value ?? "";
    while (nextVals.length <= r) nextVals.push([]);
    while (nextVals[r].length <= c) nextVals[r].push("");
    while (nextForms.length <= r) nextForms.push([]);
    while (nextForms[r].length <= c) nextForms[r].push("");

    nextVals[r][c] = normalizeCellForStorage(
      sheetRole,
      tabName,
      r,
      c,
      rawVal,
      "USER_ENTERED",
      nextVals,
      rec.notes_grid
    );
    nextForms[r][c] = rawVal === null || rawVal === undefined ? "" : rawVal;

    const colLetter = colIdx0ToLetter(c);
    const coord = `${colLetter}${r + 1}`;
    coords.push(coord);
    if (sheetRole === "master") {
      masterMirrorRanges.push({ range: `${tabName}!${coord}`, values: [[rawVal]] });
    }
  }

  await saveVirtualTabGrid_(ctx, sheetRole, tabName, nextVals, nextForms, rec.notes_grid);

  if (sheetRole === "master") {
    await recomputeMasterFormulasAfterVirtualWrite_(ctx, [tabName], sheets);
    await syncPhase4MasterIngestionIfEnabled_(ctx, [tabName]);
    if (sheets && masterMirrorRanges.length > 0) {
      await mirrorMasterWriteToClientSheetIfNeeded_(ctx, sheets, masterMirrorRanges);
    }
  } else if (sheetRole === "recon") {
    await syncPhase4ReconIfEnabled_(ctx, [tabName]);
  } else if (sheetRole === "client") {
    await recomputeClientFormulasAfterVirtualWrite_(ctx, [tabName], sheets);
  }

  return {
    success: true,
    clientName,
    sheetRole,
    tabName,
    cellCoord: coords[0],
    updatedCoords: coords,
    updatedCount: coords.length,
    value: updates.length === 1 ? updates[0]?.value ?? "" : undefined,
    clientSheetId: ctx.clientSheetId || "",
    masterSheetId: ctx.masterSheetId || "",
  };
}

/**
 * Updates a cell inside a virtual tab from the Admin Workbook Inspector (and mirrors to Client Sheet if KeyInfo/Budget)
 */
export async function updateVirtualTabCellFromInspector({
  sheets,
  clientName = "APPTEST",
  sheetRole = "master",
  tabName = "KeyInfo",
  rowIndex0,
  colIndex0,
  value,
}) {
  return updateVirtualTabCellsFromInspector({
    sheets,
    clientName,
    sheetRole,
    tabName,
    updates: [{ rowIndex0, colIndex0, value }],
  });
}

const TEMPLATE_SNAPSHOT_META_KEY = "template_snapshot_meta";
const TEMPLATE_SNAPSHOT_PREFIX = "template_snapshot::";
const LEGACY_MONOLITHIC_SNAPSHOT_KEYS = [
  "template_snapshot_master",
  "template_snapshot_recon",
  "template_snapshot_client",
];

function formatSupabaseErrMsg_(msg) {
  const s = String(msg || "Unknown Supabase error");
  if (/<!DOCTYPE|<html/i.test(s)) {
    const titleMatch = s.match(/<title>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : "Upstream Supabase/Cloudflare HTTP error";
  }
  return s;
}

function cloneGrid2D_(grid) {
  return Array.isArray(grid) ? grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];
}

async function runTemplateRead_(label, spreadsheetId, fn) {
  try {
    return await fn();
  } catch (err) {
    if (String(err?.message || "").toLowerCase().includes("permission") || err?.code === 403 || err?.status === 403) {
      throw new Error(
        `Permission denied reading ${label} (${spreadsheetId}). Please ensure this Google Sheet is shared as Viewer/Editor with the backend service accounts.`
      );
    }
    throw err;
  }
}

function buildCompactSnapshotRows_(role, snap, updatedBy = "System") {
  if (!snap || !Array.isArray(snap.tabs)) return [];
  const rows = [];
  for (const t of snap.tabs) {
    const key = `${TEMPLATE_SNAPSHOT_PREFIX}${role}::${t.tabName}`;
    if (role === "client") {
      const maxCols = Math.max(
        (t.valuesGrid || []).reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0),
        (t.formulasGrid || []).reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0)
      );
      const { storedValues, storedFormulas, storedNotes, totalRows } = compactClientTabForStorage_(
        t.tabName,
        t.valuesGrid,
        t.formulasGrid,
        {}
      );
      rows.push({
        key,
        value: {
          templateId: snap.templateId,
          tabName: t.tabName,
          values_grid: storedValues,
          formulas_grid: storedFormulas,
          notes_grid: storedNotes,
          row_count: totalRows,
          col_count: maxCols,
          syncedAt: snap.syncedAt,
        },
        description: `Client template snapshot tab: ${t.tabName}`,
        updated_by: updatedBy,
      });
    } else {
      const isMasterCalcs = role === "master" && (t.tabName === "ConfCalcs" || t.tabName === "PipeCalcs");
      const compactVals = isMasterCalcs
        ? trimMasterCalcsGrid_(t.valuesGrid || [])
        : compactGrid2D(t.valuesGrid || []);
      const rawForms = isMasterCalcs
        ? (t.formulasGrid || t.valuesGrid || []).slice(0, compactVals.length)
        : (t.formulasGrid || t.valuesGrid || []);
      const compactForms = compactFormulasGrid2D_(rawForms);
      rows.push({
        key,
        value: {
          templateId: snap.templateId,
          tabName: t.tabName,
          values_grid: compactVals,
          compact_formulas: compactForms,
          ...(t.formattedGrid ? { formatted_grid: compactGrid2D(t.formattedGrid) } : {}),
          syncedAt: snap.syncedAt,
        },
        description: `${role} template snapshot tab: ${t.tabName}`,
        updated_by: updatedBy,
      });
    }
  }
  return rows;
}

async function saveTemplateSnapshotRows_(supabase, role, snap, updatedBy = "System") {
  if (!supabase || !snap) return;
  const rows = buildCompactSnapshotRows_(role, snap, updatedBy);
  // Save 1-3 tabs per upsert to stay well below Cloudflare/PostgREST payload limits
  for (let i = 0; i < rows.length; i += 2) {
    const chunk = rows.slice(i, i + 2);
    const { error } = await supabase.from("system_config").upsert(chunk);
    if (error) {
      // Fallback: save individually if 2 tabs together were large
      if (chunk.length > 1) {
        for (const single of chunk) {
          const { error: singleErr } = await supabase.from("system_config").upsert(single);
          if (singleErr) {
            throw new Error(`Failed to save ${single.key}: ${formatSupabaseErrMsg_(singleErr.message)}`);
          }
        }
      } else {
        throw new Error(`Failed to save ${chunk[0].key}: ${formatSupabaseErrMsg_(error.message)}`);
      }
    }
  }
}

async function loadRoleSnapshotFromSystemConfig_(supabase, role, expectedTemplateId, meta = null) {
  if (!supabase || !expectedTemplateId) return null;
  try {
    const prefix = `${TEMPLATE_SNAPSHOT_PREFIX}${role}::`;
    const orderedNames =
      role === "master"
        ? meta?.masterTabs
        : role === "recon"
          ? meta?.reconTabs
          : meta?.clientTabs;

    let rows = [];
    if (Array.isArray(orderedNames) && orderedNames.length > 0) {
      const keys = orderedNames.map((n) => `${prefix}${n}`);
      for (let i = 0; i < keys.length; i += 8) {
        const chunkKeys = keys.slice(i, i + 8);
        const { data, error } = await supabase
          .from("system_config")
          .select("key, value")
          .in("key", chunkKeys);
        if (error) return null;
        if (Array.isArray(data)) rows.push(...data);
      }
    } else {
      const { data, error } = await supabase
        .from("system_config")
        .select("key, value")
        .like("key", `${prefix}%`);
      if (error) return null;
      if (Array.isArray(data)) rows = data;
    }
    if (rows.length === 0) return null;

    const matching = rows.filter((r) => r?.value?.templateId === expectedTemplateId);
    if (matching.length === 0) return null;

    // If meta lists expected tab count, ensure snapshot is complete
    const expectedCount =
      role === "master"
        ? Number(meta?.masterTabCount || 0)
        : role === "recon"
          ? Number(meta?.reconTabCount || 0)
          : Number(meta?.clientTabCount || 0);
    if (expectedCount > 0 && matching.length < expectedCount) {
      return null;
    }

    const orderIdx = Array.isArray(orderedNames)
      ? new Map(orderedNames.map((n, idx) => [n, idx]))
      : null;

    const tabs = matching
      .map((r) => {
        const val = r.value;
        const tabName = val.tabName || r.key.slice(prefix.length);
        if (role === "client") {
          const expanded = expandClientTabFromStorage_({ ...val }, tabName);
          return {
            tabName,
            valuesGrid: expanded.values_grid || [],
            formulasGrid: expanded.formulas_grid || expanded.values_grid || [],
          };
        }
        const valuesGrid = val.values_grid || [];
        const formulasGrid = Array.isArray(val.compact_formulas)
          ? expandFormulasGrid2D_(val.compact_formulas, valuesGrid)
          : (val.formulasGrid || valuesGrid);
        return {
          tabName,
          valuesGrid,
          formulasGrid,
          ...(val.formatted_grid ? { formattedGrid: val.formatted_grid } : {}),
        };
      })
      .sort((a, b) => {
        if (!orderIdx) return 0;
        return (orderIdx.get(a.tabName) ?? 9999) - (orderIdx.get(b.tabName) ?? 9999);
      });

    return {
      templateId: expectedTemplateId,
      tabs,
      ...(role === "client"
        ? {
          outNotesMap: meta?.clientOutNotesMap || {},
          anchorFormulas: meta?.clientAnchorFormulas || {},
        }
        : {}),
      syncedAt: matching[0]?.value?.syncedAt || meta?.syncedAt || "",
    };
  } catch (err) {
    console.warn(`[loadRoleSnapshotFromSystemConfig_] ${role} warning:`, err.message);
    return null;
  }
}

async function saveTemplateMeta_(supabase, meta, updatedBy = "System") {
  if (!supabase) return;
  const { error } = await supabase.from("system_config").upsert({
    key: TEMPLATE_SNAPSHOT_META_KEY,
    value: meta,
    description: "Metadata for Supabase provisioning template snapshots",
    updated_by: updatedBy,
  });
  if (error) {
    throw new Error(`Failed to save ${TEMPLATE_SNAPSHOT_META_KEY}: ${formatSupabaseErrMsg_(error.message)}`);
  }
}

async function fetchMasterTemplateSnapshotFromSheets_(sheets, masterTemplateId) {
  if (!sheets) throw new Error("Google Sheets client is required to read Master template.");
  const masterMeta = await runTemplateRead_("Master template", masterTemplateId, () =>
    sheets.spreadsheets.get({
      spreadsheetId: masterTemplateId,
      fields: "sheets.properties.title",
      _bypassSupabaseVirtualSheet: true,
      _usePrimaryAccount: true,
    })
  );
  const existingMasterTabs = new Set((masterMeta.data.sheets || []).map((s) => s.properties.title));
  const orderedCore = CORE_MASTER_TABS.filter((t) => existingMasterTabs.has(t));
  const extraTabs = [...existingMasterTabs].filter(
    (t) => !CORE_MASTER_TABS.includes(t) && t !== "GasExecLogs" && t !== "GasScriptProps"
  );
  const tabsToPull = [...orderedCore, ...extraTabs];
  const tabs = [];

  for (let i = 0; i < tabsToPull.length; i += 6) {
    const chunk = tabsToPull.slice(i, i + 6);
    const ranges = chunk.map((t) => `'${t}'`);
    const needsFormatted = chunk.filter((t) => t === "KeyInfo" || t === "Welcome" || /yrcalcs/i.test(t));

    const [valBatch, formBatch, dispBatch] = await Promise.all([
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: masterTemplateId,
        ranges,
        valueRenderOption: "UNFORMATTED_VALUE",
        _bypassSupabaseVirtualSheet: true,
        _usePrimaryAccount: true,
      }),
      sheets.spreadsheets.values
        .batchGet({
          spreadsheetId: masterTemplateId,
          ranges,
          valueRenderOption: "FORMULA",
          _bypassSupabaseVirtualSheet: true,
          _usePrimaryAccount: true,
        })
        .catch(() => ({ data: { valueRanges: [] } })),
      needsFormatted.length > 0
        ? sheets.spreadsheets.values
          .batchGet({
            spreadsheetId: masterTemplateId,
            ranges: needsFormatted.map((t) => `'${t}'`),
            valueRenderOption: "FORMATTED_VALUE",
            _bypassSupabaseVirtualSheet: true,
            _usePrimaryAccount: true,
          })
          .catch(() => ({ data: { valueRanges: [] } }))
        : Promise.resolve({ data: { valueRanges: [] } }),
    ]);

    const vList = valBatch.data.valueRanges || [];
    const fList = formBatch.data.valueRanges || [];
    const dList = dispBatch.data.valueRanges || [];

    for (let j = 0; j < chunk.length; j++) {
      const tabName = chunk[j];
      const rawV = vList[j]?.values || [];
      const isMasterCalcs = tabName === "ConfCalcs" || tabName === "PipeCalcs";
      const vGrid = isMasterCalcs ? trimMasterCalcsGrid_(rawV) : compactGrid2D(rawV);
      const rawF = fList[j]?.values || rawV;
      const fGrid = isMasterCalcs ? compactGrid2D(rawF.slice(0, vGrid.length)) : compactGrid2D(rawF);
      const dispIdx = needsFormatted.indexOf(tabName);
      const formattedGrid = dispIdx !== -1 && dList[dispIdx]?.values ? compactGrid2D(dList[dispIdx].values) : null;
      tabs.push({
        tabName,
        valuesGrid: vGrid,
        formulasGrid: fGrid,
        ...(formattedGrid ? { formattedGrid } : {}),
      });
    }
  }

  return {
    templateId: masterTemplateId,
    tabs,
    syncedAt: new Date().toISOString(),
  };
}

async function fetchReconTemplateSnapshotFromSheets_(sheets, reconTemplateId) {
  if (!sheets) throw new Error("Google Sheets client is required to read Recon template.");
  const reconMeta = await runTemplateRead_("Recon template", reconTemplateId, () =>
    sheets.spreadsheets.get({
      spreadsheetId: reconTemplateId,
      fields: "sheets.properties.title",
      _bypassSupabaseVirtualSheet: true,
      _usePrimaryAccount: true,
    })
  );
  const allReconTabs = (reconMeta.data.sheets || [])
    .map((s) => s.properties.title)
    .filter((t) => Boolean(t));
  const tabs = [];

  for (let i = 0; i < allReconTabs.length; i += 5) {
    const chunk = allReconTabs.slice(i, i + 5);
    const ranges = chunk.map((t) => `'${t}'`);
    const [valBatch, formBatch] = await Promise.all([
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: reconTemplateId,
        ranges,
        valueRenderOption: "UNFORMATTED_VALUE",
        _bypassSupabaseVirtualSheet: true,
        _usePrimaryAccount: true,
      }),
      sheets.spreadsheets.values
        .batchGet({
          spreadsheetId: reconTemplateId,
          ranges,
          valueRenderOption: "FORMULA",
          _bypassSupabaseVirtualSheet: true,
          _usePrimaryAccount: true,
        })
        .catch(() => ({ data: { valueRanges: [] } })),
    ]);

    const vList = valBatch.data.valueRanges || [];
    const fList = formBatch.data.valueRanges || [];

    for (let j = 0; j < chunk.length; j++) {
      const tabName = chunk[j];
      const vGrid = compactGrid2D(vList[j]?.values || []);
      const fGrid = compactGrid2D(fList[j]?.values || vGrid);
      tabs.push({
        tabName,
        valuesGrid: vGrid,
        formulasGrid: fGrid,
      });
    }
  }

  return {
    templateId: reconTemplateId,
    tabs,
    syncedAt: new Date().toISOString(),
  };
}

async function fetchClientTemplateSnapshotFromSheets_(sheets, clientTemplateId) {
  if (!sheets) throw new Error("Google Sheets client is required to read Client template.");
  const metaResp = await runTemplateRead_("Client template", clientTemplateId, () =>
    sheets.spreadsheets.get({
      spreadsheetId: clientTemplateId,
      fields: "sheets(properties(sheetId,title))",
      _bypassSupabaseVirtualSheet: true,
      _usePrimaryAccount: true,
    })
  );
  const existingTitles = new Set((metaResp.data.sheets || []).map((s) => s.properties.title));
  const tabsToFetch = CORE_CLIENT_TABS.filter((t) => existingTitles.has(t));

  const outNotesMap = {};
  if (existingTitles.has("Outgoings")) {
    try {
      const notesResp = await sheets.spreadsheets.get({
        spreadsheetId: clientTemplateId,
        ranges: ["Outgoings!G13:AV111"],
        fields: "sheets.data.rowData.values.note",
        _bypassSupabaseVirtualSheet: true,
        _usePrimaryAccount: true,
      });
      const rowData = notesResp.data.sheets?.[0]?.data?.[0]?.rowData || [];
      rowData.forEach((rObj, rOff) => {
        (rObj.values || []).forEach((vObj, cOff) => {
          if (vObj?.note) {
            outNotesMap[`${12 + rOff}:${6 + cOff}`] = String(vObj.note);
          }
        });
      });
    } catch (e) {
      console.warn("[fetchClientTemplateSnapshotFromSheets_] Outgoings notes warning:", e.message);
    }
  }

  const tabs = [];
  for (let i = 0; i < tabsToFetch.length; i += 8) {
    const batch = tabsToFetch.slice(i, i + 8);
    const ranges = batch.map((t) => `'${t}'`);
    const [valResp, formResp] = await Promise.all([
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: clientTemplateId,
        ranges,
        valueRenderOption: "UNFORMATTED_VALUE",
        _bypassSupabaseVirtualSheet: true,
        _usePrimaryAccount: true,
      }),
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: clientTemplateId,
        ranges,
        valueRenderOption: "FORMULA",
        _bypassSupabaseVirtualSheet: true,
        _usePrimaryAccount: true,
      }),
    ]);

    for (let j = 0; j < batch.length; j++) {
      const tabName = batch[j];
      const vGrid = compactGrid2D(valResp.data.valueRanges?.[j]?.values || []);
      const fGrid = compactGrid2D(formResp.data.valueRanges?.[j]?.values || vGrid);
      tabs.push({
        tabName,
        valuesGrid: vGrid,
        formulasGrid: fGrid,
      });
    }
  }

  const findFormulaCell = (tabName, r0, c0) => {
    const rec = tabs.find((t) => t.tabName === tabName);
    return String(rec?.formulasGrid?.[r0]?.[c0] || "");
  };

  const anchorFormulas = {
    "KeyInfo!A1": findFormulaCell("KeyInfo", 0, 0),
    "KeyInfo!A2": findFormulaCell("KeyInfo", 1, 0),
    "Welcome!B3": findFormulaCell("Welcome", 2, 1),
    "YrCalcs!A1": findFormulaCell("YrCalcs", 0, 0),
  };

  return {
    templateId: clientTemplateId,
    tabs,
    outNotesMap,
    anchorFormulas,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Returns metadata about the currently stored provisioning template snapshots in Supabase `system_config`.
 */
export async function getProvisioningTemplateSnapshotsMeta() {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("system_config")
      .select("value")
      .eq("key", TEMPLATE_SNAPSHOT_META_KEY)
      .maybeSingle();
    return data?.value || null;
  } catch {
    return null;
  }
}

/**
 * Fetches all 3 provisioning templates (Master, Recon, Client) from Google Sheets and stores
 * compacted snapshots in Supabase `system_config` so Supabase-only onboarding makes zero Google Sheets API calls.
 */
export async function syncProvisioningTemplateSnapshots(
  sheets,
  { clientTemplateId = "", masterTemplateId = "", reconTemplateId = "", userEmail = "Admin" } = {}
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");
  if (!sheets) throw new Error("Google Sheets client is required to sync templates.");

  let cId = extractSheetIdFromUrl(clientTemplateId) || String(clientTemplateId || "").trim();
  let mId = extractSheetIdFromUrl(masterTemplateId) || String(masterTemplateId || "").trim();
  let rId = extractSheetIdFromUrl(reconTemplateId) || String(reconTemplateId || "").trim();

  if (!cId || !mId || !rId) {
    const { data: cfgRow } = await supabase
      .from("system_config")
      .select("value")
      .eq("key", "client_provisioning_templates")
      .maybeSingle();
    const val = cfgRow?.value || {};
    cId = cId || extractSheetIdFromUrl(val.clientTemplateId || val.clientTemplateUrl) || String(val.clientTemplateId || "").trim();
    mId = mId || extractSheetIdFromUrl(val.masterTemplateId || val.masterTemplateUrl) || String(val.masterTemplateId || "").trim();
    rId = rId || extractSheetIdFromUrl(val.reconTemplateId || val.reconTemplateUrl) || String(val.reconTemplateId || "").trim();
  }

  if (!cId || !mId || !rId) {
    throw new Error("Missing Client, Master, or Recon template IDs in Provisioning template IDs.");
  }

  const [masterSnap, reconSnap, clientSnap] = await Promise.all([
    fetchMasterTemplateSnapshotFromSheets_(sheets, mId),
    fetchReconTemplateSnapshotFromSheets_(sheets, rId),
    fetchClientTemplateSnapshotFromSheets_(sheets, cId),
  ]);

  // Clean up any legacy monolithic snapshot keys if present
  try {
    await supabase.from("system_config").delete().in("key", LEGACY_MONOLITHIC_SNAPSHOT_KEYS);
  } catch (_) { }

  // Save per-tab compacted snapshots sequentially in small chunks to avoid Cloudflare 520 / PostgREST payload limits
  await saveTemplateSnapshotRows_(supabase, "master", masterSnap, userEmail);
  await saveTemplateSnapshotRows_(supabase, "recon", reconSnap, userEmail);
  await saveTemplateSnapshotRows_(supabase, "client", clientSnap, userEmail);

  const syncedAt = new Date().toISOString();
  const meta = {
    syncedAt,
    syncedBy: userEmail || "Admin",
    clientTemplateId: cId,
    masterTemplateId: mId,
    reconTemplateId: rId,
    clientTabCount: clientSnap.tabs.length,
    masterTabCount: masterSnap.tabs.length,
    reconTabCount: reconSnap.tabs.length,
    masterTabs: masterSnap.tabs.map((t) => t.tabName),
    reconTabs: reconSnap.tabs.map((t) => t.tabName),
    clientTabs: clientSnap.tabs.map((t) => t.tabName),
    clientOutNotesMap: clientSnap.outNotesMap || {},
    clientAnchorFormulas: clientSnap.anchorFormulas || {},
  };

  await saveTemplateMeta_(supabase, meta, userEmail);

  return { success: true, meta };
}

/**
 * Seeds virtual Supabase workbooks directly from Supabase template snapshots (falling back to Google Sheet
 * templates only if no matching snapshot exists yet, and warming the snapshot on fallback),
 * and materializes Client Google Sheet IMPORTRANGEs when Client is Google Sheets and Master is Supabase.
 */
export async function seedNewClientTemplatesToSupabase(
  sheets,
  {
    clientId,
    clientName,
    normalizedKey,
    clientMode = "supabase",
    masterMode = "supabase",
    clientSheetId = "",
    clientUrl = "",
    masterSheetId = "",
    masterUrl = "",
    reconSheetId = "",
    reconUrl = "",
    accountingTool = "None",
    crmTool = "None",
    crmDrives = "NA",
    clientTemplateId = "",
    masterTemplateId = "",
    reconTemplateId = "",
  }
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  _sheetContextCache.expiresAt = 0;
  invalidateMasterEngineCache(clientName);

  const ctx = {
    clientId,
    clientName,
    normalizedKey,
    masterMode,
    clientMode,
    clientSheetId,
    masterSheetId,
    reconSheetId,
  };

  const clientRef = clientUrl || clientSheetId;
  const masterRef = masterUrl || masterSheetId;
  const reconRef = reconUrl || reconSheetId;

  const patchMasterKeyInfoOverrides = (grid) => {
    let g = patchGridCell_(grid, 0, 1, clientName); // B1
    g = patchGridCell_(g, 0, 2, clientRef); // C1
    g = patchGridCell_(g, 0, 3, masterRef); // D1
    g = patchGridCell_(g, 0, 6, reconRef); // G1
    g = patchGridCell_(g, 27, 23, clientSheetId || clientRef); // X28
    g = patchGridCell_(g, 3, 16, accountingTool || "None"); // Q4
    g = patchGridCell_(g, 7, 16, crmTool || "None"); // Q8
    g = patchGridCell_(g, 8, 16, crmDrives || "NA"); // Q9
    return g;
  };

  // Load any needed snapshots from Supabase first (zero Google Sheets API calls when present)
  const needsMasterSnapshot = masterMode === "supabase";
  const needsReconSnapshot = masterMode === "supabase";
  const needsClientSnapshot = clientMode === "supabase";

  const existingMeta = (await getProvisioningTemplateSnapshotsMeta()) || {};

  let [masterSnap, reconSnap, clientSnap] = await Promise.all([
    needsMasterSnapshot ? loadRoleSnapshotFromSystemConfig_(supabase, "master", masterTemplateId, existingMeta) : Promise.resolve(null),
    needsReconSnapshot ? loadRoleSnapshotFromSystemConfig_(supabase, "recon", reconTemplateId, existingMeta) : Promise.resolve(null),
    needsClientSnapshot ? loadRoleSnapshotFromSystemConfig_(supabase, "client", clientTemplateId, existingMeta) : Promise.resolve(null),
  ]);

  // Self-warming fallback: if any required snapshot isn't cached in Supabase yet, fetch from Google Sheets once and persist it
  let snapshotWarmed = false;
  if (needsMasterSnapshot && !masterSnap && masterTemplateId) {
    masterSnap = await fetchMasterTemplateSnapshotFromSheets_(sheets, masterTemplateId);
    await saveTemplateSnapshotRows_(supabase, "master", masterSnap, "System (Auto-Warm)").catch(() => { });
    snapshotWarmed = true;
  }
  if (needsReconSnapshot && !reconSnap && reconTemplateId) {
    reconSnap = await fetchReconTemplateSnapshotFromSheets_(sheets, reconTemplateId);
    await saveTemplateSnapshotRows_(supabase, "recon", reconSnap, "System (Auto-Warm)").catch(() => { });
    snapshotWarmed = true;
  }
  if (needsClientSnapshot && !clientSnap && clientTemplateId) {
    clientSnap = await fetchClientTemplateSnapshotFromSheets_(sheets, clientTemplateId);
    await saveTemplateSnapshotRows_(supabase, "client", clientSnap, "System (Auto-Warm)").catch(() => { });
    snapshotWarmed = true;
  }
  if (snapshotWarmed) {
    await saveTemplateMeta_(
      supabase,
      {
        ...existingMeta,
        syncedAt: new Date().toISOString(),
        syncedBy: "System (Auto-Warm)",
        clientTemplateId: clientSnap?.templateId || existingMeta.clientTemplateId || clientTemplateId,
        masterTemplateId: masterSnap?.templateId || existingMeta.masterTemplateId || masterTemplateId,
        reconTemplateId: reconSnap?.templateId || existingMeta.reconTemplateId || reconTemplateId,
        clientTabCount: clientSnap?.tabs?.length || existingMeta.clientTabCount || 0,
        masterTabCount: masterSnap?.tabs?.length || existingMeta.masterTabCount || 0,
        reconTabCount: reconSnap?.tabs?.length || existingMeta.reconTabCount || 0,
        ...(masterSnap ? { masterTabs: masterSnap.tabs.map((t) => t.tabName) } : {}),
        ...(reconSnap ? { reconTabs: reconSnap.tabs.map((t) => t.tabName) } : {}),
        ...(clientSnap
          ? {
            clientTabs: clientSnap.tabs.map((t) => t.tabName),
            clientOutNotesMap: clientSnap.outNotesMap || {},
            clientAnchorFormulas: clientSnap.anchorFormulas || {},
          }
          : {}),
      },
      "System (Auto-Warm)"
    ).catch(() => { });
  }

  // 1. Seed Master & Recon virtual grids from snapshots if masterMode === 'supabase'
  if (masterMode === "supabase") {
    if (masterSnap) {
      let templateInvMode = "Whole";
      for (const tabRec of masterSnap.tabs) {
        const tabName = tabRec.tabName;
        let vGrid = cloneGrid2D_(tabRec.valuesGrid);
        let fGrid = cloneGrid2D_(tabRec.formulasGrid || tabRec.valuesGrid);

        if (tabName === "KeyInfo") {
          vGrid = patchMasterKeyInfoOverrides(vGrid);
          fGrid = patchMasterKeyInfoOverrides(fGrid);
          const rawMode = String(vGrid[7]?.[6] || "Whole").trim();
          if (rawMode) templateInvMode = rawMode;
          await syncStructuredKeyInfoFromGrid_(ctx, vGrid).catch((e) =>
            console.warn("[seedNewClientTemplatesToSupabase] tenant_key_info sync warning:", e.message)
          );
        } else if (tabName === "DataChgAlert") {
          const invFreq = String(vGrid[1]?.[24] || "").trim();
          const crmFreq = String(vGrid[2]?.[24] || "").trim();
          const expFreq = String(vGrid[3]?.[24] || "").trim();
          try {
            await supabase
              .from("sync_schedules")
              .upsert(
                {
                  client_id: clientId,
                  client_name: clientName,
                  inv_freq: invFreq || "Not Used",
                  crm_freq: crmFreq || "Not Used",
                  exp_freq: expFreq || "Not Used",
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "client_name" }
              );
          } catch (_) {
            // ignore non-critical sync_schedules seed warning
          }
        }

        await saveVirtualTabGrid_(ctx, "master", tabName, vGrid, fGrid, {});
      }

      const seedProps = [
        ["Key", "Value", "UpdatedAt"],
        ["INV_LAST_IMPORT_MODE", templateInvMode || "Whole", new Date().toISOString()],
        ["EXP_LAST_IMPORT_MODE", "Whole", new Date().toISOString()],
      ];
      await saveVirtualTabGrid_(ctx, "master", "GasScriptProps", seedProps, seedProps, {});
    }

    if (reconSnap) {
      for (const tabRec of reconSnap.tabs) {
        const tabName = tabRec.tabName;
        let vGrid = cloneGrid2D_(tabRec.valuesGrid);
        let fGrid = cloneGrid2D_(tabRec.formulasGrid || tabRec.valuesGrid);
        if (tabName === "KeyInfo") {
          vGrid = patchGridCell_(patchGridCell_(vGrid, 0, 2, clientRef), 0, 3, masterRef);
          fGrid = patchGridCell_(patchGridCell_(fGrid, 0, 2, clientRef), 0, 3, masterRef);
        }
        await saveVirtualTabGrid_(ctx, "recon", tabName, vGrid, fGrid, {});
      }
    }
  }

  // Helper to resolve Master -> Client materialized target ranges (KeyInfo, Welcome, YrCalcs)
  // Uses in-memory masterSnap when masterMode === 'supabase' (ZERO Google Sheets API calls).
  const buildMaterializedRangesFromMaster = async ({ useMasterSnapshot, sourceMasterId, applyOverrides, clientSourceId, useClientSnapshot }) => {
    let masterTabsSet = new Set();
    let masterTabMap = null;

    if (useMasterSnapshot && masterSnap) {
      masterTabMap = new Map(masterSnap.tabs.map((t) => [t.tabName, t]));
      masterTabsSet = new Set(masterSnap.tabs.map((t) => t.tabName));
    } else if (sourceMasterId) {
      const srcMasterMeta = await sheets.spreadsheets.get({
        spreadsheetId: sourceMasterId,
        fields: "sheets.properties.title",
        _bypassSupabaseVirtualSheet: true,
        _usePrimaryAccount: true,
      });
      masterTabsSet = new Set((srcMasterMeta.data.sheets || []).map((s) => s.properties.title));
    }

    let clientTabsSet = new Set();
    let yrFormula = "";
    let existingClientAnchors = null;

    if (useClientSnapshot && clientSnap) {
      clientTabsSet = new Set(clientSnap.tabs.map((t) => t.tabName));
      yrFormula = String(clientSnap.anchorFormulas?.["YrCalcs!A1"] || "");
      existingClientAnchors = clientSnap.anchorFormulas || {};
    } else if (clientSourceId) {
      const srcClientMeta = await sheets.spreadsheets.get({
        spreadsheetId: clientSourceId,
        fields: "sheets.properties.title",
        _bypassSupabaseVirtualSheet: true,
        _usePrimaryAccount: true,
      });
      clientTabsSet = new Set((srcClientMeta.data.sheets || []).map((s) => s.properties.title));
      if (clientTabsSet.has("YrCalcs")) {
        const yrAnchorResp = await sheets.spreadsheets.values
          .get({
            spreadsheetId: clientSourceId,
            range: "YrCalcs!A1",
            valueRenderOption: "FORMULA",
            _bypassSupabaseVirtualSheet: true,
            _usePrimaryAccount: true,
          })
          .catch(() => null);
        yrFormula = String(yrAnchorResp?.data?.values?.[0]?.[0] || "");
      }
    }

    const targets = [];
    if (clientTabsSet.has("KeyInfo") && masterTabsSet.has("KeyInfo")) {
      targets.push(
        { id: "keyinfo_header", clientRange: "KeyInfo!A1:B1", masterRange: "KeyInfo!A1:B1", mode: "VALUES_ONLY" },
        { id: "keyinfo_body", clientRange: "KeyInfo!A2:AZ150", masterRange: "KeyInfo!A2:AZ150", mode: "FORMULAS_NO_EXTERNAL" }
      );
    }
    if (clientTabsSet.has("Welcome") && masterTabsSet.has("Welcome")) {
      targets.push({ id: "welcome_block", clientRange: "Welcome!B3:D26", masterRange: "Welcome!B3:D26", mode: "VALUES_ONLY" });
    }
    if (clientTabsSet.has("YrCalcs") && /importrange/i.test(yrFormula)) {
      const rangeMatch = yrFormula.match(/["']([^"'!]+)!([A-Za-z0-9:$]+)["']/);
      if (rangeMatch) {
        const srcTab = rangeMatch[1].replace(/^'|'$/g, "");
        const srcCoords = rangeMatch[2].replace(/\$/g, "");
        if (masterTabsSet.has(srcTab)) {
          targets.push({
            id: "yrcalcs_block",
            clientRange: `YrCalcs!${srcCoords}`,
            masterRange: `${srcTab}!${srcCoords}`,
            mode: "FORMULAS_NO_EXTERNAL",
          });
        }
      }
    }

    if (targets.length === 0) return { targets: [], batchWriteData: [], backupMap: {} };

    const anchorRanges = targets.map((t) => {
      const tab = t.clientRange.split("!")[0];
      const startCoord = t.clientRange.split("!")[1].split(":")[0];
      return `${tab}!${startCoord}`;
    });

    const backupMap = {};
    if (existingClientAnchors) {
      targets.forEach((t, idx) => {
        backupMap[t.id] = {
          clientRange: t.clientRange,
          anchorRange: anchorRanges[idx],
          originalFormula: existingClientAnchors[anchorRanges[idx]] || "",
        };
      });
    } else if (clientSourceId) {
      const existingAnchorsResp = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: clientSourceId,
        ranges: anchorRanges,
        valueRenderOption: "FORMULA",
        _bypassSupabaseVirtualSheet: true,
        _usePrimaryAccount: true,
      });
      (existingAnchorsResp.data.valueRanges || []).forEach((vr, idx) => {
        const t = targets[idx];
        backupMap[t.id] = {
          clientRange: t.clientRange,
          anchorRange: anchorRanges[idx],
          originalFormula: vr.values?.[0]?.[0] || "",
        };
      });
    }

    let masterValueRanges = [];
    let masterFormulaRanges = [];
    if (masterTabMap) {
      masterValueRanges = targets.map((t) => {
        const parsed = parseA1Range(t.masterRange);
        const rec = masterTabMap.get(parsed.tabName);
        const srcGrid = rec?.formattedGrid || rec?.valuesGrid || [];
        return { values: sliceGrid2D_(srcGrid, parsed) };
      });
      masterFormulaRanges = targets.map((t) => {
        const parsed = parseA1Range(t.masterRange);
        const rec = masterTabMap.get(parsed.tabName);
        const srcGrid = rec?.formulasGrid || rec?.valuesGrid || [];
        return { values: sliceGrid2D_(srcGrid, parsed) };
      });
    } else {
      const [masterValResp, masterFormResp] = await Promise.all([
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: sourceMasterId,
          ranges: targets.map((t) => t.masterRange),
          valueRenderOption: "FORMATTED_VALUE",
          _bypassSupabaseVirtualSheet: true,
          _usePrimaryAccount: true,
        }),
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: sourceMasterId,
          ranges: targets.map((t) => t.masterRange),
          valueRenderOption: "FORMULA",
          _bypassSupabaseVirtualSheet: true,
          _usePrimaryAccount: true,
        }),
      ]);
      masterValueRanges = masterValResp.data.valueRanges || [];
      masterFormulaRanges = masterFormResp.data.valueRanges || [];
    }

    const batchWriteData = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const vals = masterValueRanges[i]?.values || [];
      const forms = masterFormulaRanges[i]?.values || [];
      const maxR = Math.max(vals.length, forms.length);
      const mergedRows = [];

      for (let r = 0; r < maxR; r++) {
        const vRow = vals[r] || [];
        const fRow = forms[r] || [];
        const maxC = Math.max(vRow.length, fRow.length);
        const outRow = [];
        for (let c = 0; c < maxC; c++) {
          const fCell = fRow[c];
          const vCell = vRow[c] ?? "";
          if (t.mode === "VALUES_ONLY") {
            outRow.push(vCell);
          } else if (
            typeof fCell === "string" &&
            /\b(importrange|CRMList!|PLFromApp!|Year0PLFromApp!|PLComp!|InvComp!|DirComp!|CRMComp!|DataFromCRM!)/i.test(fCell)
          ) {
            outRow.push(vCell);
          } else if (typeof fCell === "string" && fCell.startsWith("=")) {
            outRow.push(fCell);
          } else {
            outRow.push(vCell !== "" && vCell !== undefined ? vCell : fCell !== undefined ? fCell : "");
          }
        }
        mergedRows.push(outRow);
      }

      if (t.id === "keyinfo_body") {
        for (let r = 0; r < mergedRows.length; r++) {
          const vRow = vals[r] || [];
          for (let c = 0; c < Math.max(mergedRows[r].length, vRow.length); c++) {
            if ((mergedRows[r][c] === undefined || mergedRows[r][c] === "") && vRow[c] !== undefined && vRow[c] !== "") {
              mergedRows[r][c] = vRow[c];
            }
          }
        }
        if (applyOverrides) {
          // Rows in KeyInfo!A2:AZ150 start at sheet row 2 (r=0 -> row 2; Q4 -> r=2, Q8 -> r=6, Q9 -> r=7)
          while (mergedRows.length <= 7) mergedRows.push([]);
          for (const [rIdx, val] of [[2, accountingTool || "None"], [6, crmTool || "None"], [7, crmDrives || "NA"]]) {
            while (mergedRows[rIdx].length <= 16) mergedRows[rIdx].push("");
            mergedRows[rIdx][16] = val;
          }
        }
      } else if (t.id === "keyinfo_header" && applyOverrides) {
        while (mergedRows.length < 1) mergedRows.push([]);
        while (mergedRows[0].length < 2) mergedRows[0].push("");
        mergedRows[0][1] = clientName;
      }

      batchWriteData.push({ range: t.clientRange, values: mergedRows });
    }

    return { targets, batchWriteData, backupMap };
  };

  // 2. If Client is Google Sheets and Master is Supabase, materialize the Client Google Sheet from Master snapshot
  if (clientMode === "sheet" && masterMode === "supabase" && clientSheetId && !isVirtualSupabaseSheetId(clientSheetId)) {
    try {
      const { batchWriteData, backupMap } = await buildMaterializedRangesFromMaster({
        useMasterSnapshot: Boolean(masterSnap),
        sourceMasterId: masterTemplateId,
        applyOverrides: true,
        clientSourceId: clientSheetId,
        useClientSnapshot: false,
      });
      if (batchWriteData.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: clientSheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: batchWriteData,
          },
          _bypassSupabaseVirtualSheet: true,
        });
        await supabase
          .from("tenant_key_info")
          .update({
            client_importrange_backup: backupMap,
            client_materialized_at: new Date().toISOString(),
          })
          .eq("client_id", clientId);
      }
    } catch (matErr) {
      console.warn("[seedNewClientTemplatesToSupabase] Client sheet materialization warning:", matErr.message);
    }
  }

  // 3. Seed Client virtual grids from Supabase snapshot if clientMode === 'supabase'
  if (clientMode === "supabase" && clientSnap) {
    const useMasterSnap = masterMode === "supabase" && Boolean(masterSnap);
    const sourceMasterId = masterMode === "sheet" && masterSheetId && !isVirtualSupabaseSheetId(masterSheetId)
      ? masterSheetId
      : masterTemplateId;

    let materializedRanges = [];
    if (useMasterSnap || sourceMasterId) {
      try {
        const res = await buildMaterializedRangesFromMaster({
          useMasterSnapshot: useMasterSnap,
          sourceMasterId,
          applyOverrides: masterMode === "supabase",
          clientSourceId: clientTemplateId,
          useClientSnapshot: true,
        });
        materializedRanges = res.batchWriteData || [];
        if (masterMode === "supabase" && Object.keys(res.backupMap || {}).length > 0) {
          await supabase
            .from("tenant_key_info")
            .update({
              client_importrange_backup: res.backupMap,
              client_materialized_at: new Date().toISOString(),
            })
            .eq("client_id", clientId);
        }
      } catch (e) {
        console.warn("[seedNewClientTemplatesToSupabase] Virtual client materialize warning:", e.message);
      }
    }

    const outNotesMap = clientSnap.outNotesMap || {};
    const grids = Object.create(null);

    for (const tabRec of clientSnap.tabs) {
      const tabName = tabRec.tabName;
      let valuesGrid = cloneGrid2D_(tabRec.valuesGrid);
      let formulasGrid = cloneGrid2D_(tabRec.formulasGrid || tabRec.valuesGrid);
      const notesGrid = tabName === "Outgoings" ? outNotesMap : {};

      for (const mat of materializedRanges) {
        const parsedMat = parseA1Range(mat.range, tabName);
        if (parsedMat.tabName === tabName) {
          valuesGrid = applyWriteToGrid2D_(valuesGrid, parsedMat, mat.values, {
            sheetRole: "client",
            tabName,
            valueInputOption: "USER_ENTERED",
            notesGrid,
            isFormulaGrid: false,
          });
          formulasGrid = applyWriteToGrid2D_(formulasGrid, parsedMat, mat.values, {
            sheetRole: "client",
            tabName,
            valueInputOption: "USER_ENTERED",
            notesGrid,
            isFormulaGrid: true,
          });
        }
      }

      if (tabName === "KeyInfo") {
        valuesGrid = patchGridCell_(patchGridCell_(valuesGrid, 0, 2, clientRef), 0, 3, masterRef);
        formulasGrid = patchGridCell_(patchGridCell_(formulasGrid, 0, 2, clientRef), 0, 3, masterRef);
      }

      grids[tabName] = {
        values: valuesGrid,
        formulas: formulasGrid,
        notes: notesGrid,
      };
      await saveVirtualTabGrid_(ctx, "client", tabName, valuesGrid, formulasGrid, notesGrid);
    }

    if (shouldSyncNormalizedMirrorTables()) {
      await syncStructuredClientTablesFromGrids_(ctx, grids).catch((e) =>
        console.warn("[seedNewClientTemplatesToSupabase] Stage 4 relational sync warning:", e.message)
      );
    }
  }

  // Phase 6E: automatically promote newly seeded Supabase clients through relational + native backfill (independent Client vs Master domains)
  if (clientId && clientName && (clientMode === "supabase" || masterMode === "supabase")) {
    try {
      const [jobsMod, inputsMod, masterMod, reconMod, finMod, cCalcMod, mCompMod, connMod, syncMod] = await Promise.all([
        import("./relationalJobsService.js").catch(() => null),
        import("./relationalInputsService.js").catch(() => null),
        import("./relationalMasterService.js").catch(() => null),
        import("./relationalReconService.js").catch(() => null),
        import("./relationalFinancialsService.js").catch(() => null),
        import("./nativeClientCalcService.js").catch(() => null),
        import("./nativeMasterComparisonService.js").catch(() => null),
        import("./nativeConnectorsParityService.js").catch(() => null),
        import("./nativeSyncOrchestratorService.js").catch(() => null),
      ]);

      let allPromoted = clientMode === "supabase" && masterMode === "supabase";
      const runPromotePair_ = async (label, backfillFn, ...promoteFns) => {
        if (typeof backfillFn !== "function") {
          allPromoted = false;
          return;
        }
        try {
          await backfillFn(clientName);
          for (const pFn of promoteFns) {
            if (typeof pFn === "function") await pFn(clientName);
          }
        } catch (stepErr) {
          allPromoted = false;
          console.warn(`[seedNewClientTemplatesToSupabase] ${label} promotion deferred for ${clientName}:`, stepErr?.message);
        }
      };

      if (clientMode === "supabase") {
        await runPromotePair_("jobs", jobsMod?.backfillClientRelationalJobs, (c) => jobsMod?.setClientJobsMode?.(c, "relational"), (c) => jobsMod?.setClientJobsReadMode?.(c, "relational"));
        await runPromotePair_("inputs", inputsMod?.backfillClientOperatingInputs, (c) => inputsMod?.setClientInputsMode?.(c, "relational"), (c) => inputsMod?.setClientInputsReadMode?.(c, "relational"));
        await runPromotePair_("financials", finMod?.backfillClientFinancials, (c) => finMod?.setClientFinancialsMode?.(c, "relational"), (c) => finMod?.setClientFinancialsReadMode?.(c, "relational"));
        await runPromotePair_("client_compute", cCalcMod?.backfillClientNativeCalc, (c) => cCalcMod?.setClientComputeMode?.(c, "native"));
      }
      if (masterMode === "supabase") {
        await runPromotePair_("master_ingestion", masterMod?.backfillClientMasterIngestion, (c) => masterMod?.setClientMasterIngestionMode?.(c, "relational"), (c) => masterMod?.setClientMasterReadMode?.(c, "relational"));
        await runPromotePair_("recon", reconMod?.backfillClientRecon, (c) => reconMod?.setClientReconMode?.(c, "relational"), (c) => reconMod?.setClientReconReadMode?.(c, "relational"));
        await runPromotePair_("master_compute", mCompMod?.backfillClientNativeMasterComparisons, (c) => mCompMod?.setClientMasterComputeMode?.(c, "native"));
        await runPromotePair_("connectors", connMod?.backfillClientNativeConnectors, (c) => connMod?.setClientConnectorPullMode?.(c, "native"));
        await runPromotePair_("sync_orchestrator", syncMod?.backfillClientNativeSync, (c) => syncMod?.setClientSyncOrchestratorMode?.(c, "native"));
      }

      if (allPromoted) {
        const { retireClientGridStorage } = await import("./gridRetirementService.js");
        await retireClientGridStorage(clientName, {
          dryRun: false,
          createSafetyBackup: false,
          triggeredBy: "Onboarding",
        }).catch((retErr) => {
          console.warn(`[seedNewClientTemplatesToSupabase] Phase 6E retirement deferred for ${clientName}:`, retErr?.message);
        });
      }
    } catch (autoErr) {
      console.warn(`[seedNewClientTemplatesToSupabase] Phase 2-6D native promotion note for ${clientName}:`, autoErr?.message);
    }
  }

  invalidateMasterEngineCache(clientName);
  return { success: true };
}

/**
 * Resolves a tenant's authoritative Client Sheet / Workspace ID during onboarding & setup,
 * preferring the `clients` registry record and rejecting any template spreadsheet IDs
 * copied into `KeyInfo!X28`.
 */
export async function resolveClientSheetIdFromMaster({
  clientName = "",
  masterSheetId = "",
  rawKeyInfoX28 = "",
} = {}) {
  const cleanRaw = (val) => {
    const raw = String(val || "").trim();
    if (!raw) return "";
    const unwrapped = unwrapSheetId(raw);
    return extractSheetIdFromUrl(unwrapped) || unwrapped;
  };

  const blockedTemplateIds = new Set(
    [
      process.env.CLIENT_TEMPLATE_SHEET_ID || "",
      process.env.PULSE_CLIENT_TEMPLATE_SHEET_ID || "",
      "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M",
      "1s7aa2180754aH3238j112f79d7b64a3b52f5920e",
    ]
      .map(cleanRaw)
      .filter(Boolean)
  );

  let authoritativeId = "";
  try {
    const ctx = await resolveSupabaseSheetContext({
      clientName: String(clientName || "").trim(),
      spreadsheetId: cleanRaw(masterSheetId),
    });
    if (ctx?.clientSheetId) {
      const candidate = cleanRaw(ctx.clientSheetId);
      if (candidate && !blockedTemplateIds.has(candidate)) {
        authoritativeId = candidate;
      }
    }
  } catch (_) {
    // Non-fatal fallback to verified KeyInfo!X28 below
  }

  const meta = await getProvisioningTemplateSnapshotsMeta().catch(() => null);
  const dynamicTpl = cleanRaw(meta?.clientTemplateId || "");
  if (dynamicTpl) blockedTemplateIds.add(dynamicTpl);

  if (authoritativeId && !blockedTemplateIds.has(authoritativeId)) {
    return authoritativeId;
  }

  const x28Id = cleanRaw(rawKeyInfoX28);
  if (!x28Id) return "";
  if (blockedTemplateIds.has(x28Id)) {
    throw new Error("Client workspace sheet ID points to a template sheet and cannot be modified.");
  }
  return x28Id;
}
