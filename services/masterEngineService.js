import fs from "fs";
import path from "path";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import { extractSheetIdFromUrl } from "./sheetsClient.js";
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
  "AppData",
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
const GRID_CACHE_TTL_MS = 30000;

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
      tabName = unquoted;
      coordPart = "A1:ZZ2000";
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
    while (nextGrid.length <= targetR) nextGrid.push([]);
    const rowVals = Array.isArray(rows[rOffset]) ? rows[rOffset] : [rows[rOffset]];
    for (let cOffset = 0; cOffset < rowVals.length; cOffset++) {
      const targetC = sCol + cOffset;
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

export function invalidateMasterEngineCache(clientName = null) {
  _sheetContextCache.expiresAt = 0;
  if (!clientName) {
    _gridMemoryCache.clear();
    return;
  }
  const prefix = `${String(clientName).trim().toLowerCase()}::`;
  for (const key of _gridMemoryCache.keys()) {
    if (key.startsWith(prefix)) _gridMemoryCache.delete(key);
  }
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
          const { data, error } = await supabase
            .from("clients")
            .select("id, client_name, normalized_key, master_mode, client_mode, client_sheet_id, master_sheet_id, recon_sheet_id");
          if (!error && Array.isArray(data)) {
            const bySheetId = new Map();
            const byClientName = new Map();
            for (const row of data) {
              const cId = extractSheetIdFromUrl(row.client_sheet_id) || String(row.client_sheet_id || "").trim();
              const mId = extractSheetIdFromUrl(row.master_sheet_id) || String(row.master_sheet_id || "").trim();
              const rId = extractSheetIdFromUrl(row.recon_sheet_id) || String(row.recon_sheet_id || "").trim();
              const entry = {
                clientId: row.id,
                clientName: row.client_name,
                normalizedKey: row.normalized_key,
                masterMode: row.master_mode || "sheet",
                clientMode: row.client_mode || "sheet",
                clientSheetId: cId,
                masterSheetId: mId,
                reconSheetId: rId,
              };
              byClientName.set(String(row.client_name || "").trim().toLowerCase(), entry);
              if (row.normalized_key) byClientName.set(String(row.normalized_key).trim().toLowerCase(), entry);
              if (mId) bySheetId.set(mId, { ...entry, sheetRole: "master" });
              if (rId) bySheetId.set(rId, { ...entry, sheetRole: "recon" });
              if (cId) bySheetId.set(cId, { ...entry, sheetRole: "client" });
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
      (row[32] !== "" && row[32] !== null && row[32] !== undefined && row[32] !== 0) ||
      (row[35] !== "" && row[35] !== null && row[35] !== undefined) ||
      (row[41] !== "" && row[41] !== null && row[41] !== undefined && row[41] !== 0)
    ) {
      last = r;
    }
  }
  return Math.max(last, minDefault);
}

function shiftFormulaRowByDelta_(formula, delta) {
  if (!formula || typeof formula !== "string" || !formula.startsWith("=") || delta === 0) return formula;
  return formula.replace(/(?<![A-Za-z0-9_])(\$?[A-Za-z]{1,3})(\$?)(\d+)(?![0-9(])/g, (match, colPart, dollarRow, rowStr) => {
    if (dollarRow === "$") return match;
    if (/^PL$/i.test(colPart)) return match;
    const rNum = parseInt(rowStr, 10);
    return `${colPart}${rNum + delta}`;
  });
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
      cleanNotes.__formulas_grid = compactForms;
      return { storedValues: compactVals, storedNotes: cleanNotes, totalRows: vGrid.length };
    }
  }

  const compactVals = vGrid.map((r) => trimTrailingEmptyCells_(r));
  cleanNotes.__formulas_grid = compactFormulasGrid2D_(fGrid);
  return { storedValues: compactVals, storedNotes: cleanNotes, totalRows: vGrid.length };
}

export function expandClientTabFromStorage_(data, tabName) {
  const hadNotesGridFromDb = Boolean(data.notes_grid && typeof data.notes_grid === "object");
  const rawNotes = hadNotesGridFromDb ? { ...data.notes_grid } : {};
  const storedVals = Array.isArray(data.values_grid) ? data.values_grid : [];
  const minCols = Number(data.col_count) || 0;
  let meta = rawNotes.__compact_meta;
  if (
    !meta &&
    data.row_count > storedVals.length &&
    storedVals.length >= 2 &&
    (tabName === "Confirmed" || tabName === "ConfCalcs" || tabName === "Pipeline" || tabName === "PipeCalcs")
  ) {
    meta = { totalRows: data.row_count, templateRowIdx: storedVals.length - 2 };
  }
  const storedForms = Array.isArray(rawNotes.__formulas_grid)
    ? rawNotes.__formulas_grid
    : Array.isArray(data.formulas_grid) && data.formulas_grid.length > 0
      ? data.formulas_grid
      : storedVals;

  delete rawNotes.__formulas_grid;
  delete rawNotes.__compact_meta;

  if (meta && meta.totalRows > storedVals.length && storedVals.length >= 2) {
    const { totalRows, templateRowIdx } = meta;
    const uncompactedForms = expandFormulasGrid2D_(storedForms, storedVals, minCols);
    const expandedVals = [];
    const expandedForms = [];
    const tplValRow = storedVals[templateRowIdx] || [];
    const tplFormRow = uncompactedForms[templateRowIdx] || [];
    const tailValRow = storedVals[storedVals.length - 1] || [];
    const tailFormRow = uncompactedForms[uncompactedForms.length - 1] || [];

    for (let r = 0; r <= templateRowIdx; r++) {
      const rowCopy = Array.isArray(storedVals[r]) ? [...storedVals[r]] : [];
      if (r === 0 && minCols > rowCopy.length) {
        while (rowCopy.length < minCols) rowCopy.push("");
      }
      expandedVals.push(rowCopy);
      expandedForms.push(Array.isArray(uncompactedForms[r]) ? [...uncompactedForms[r]] : []);
    }
    const sharedInactiveValRow = [...tplValRow];
    for (let r = templateRowIdx + 1; r < totalRows - 1; r++) {
      expandedVals.push(sharedInactiveValRow);
      expandedForms.push(tplFormRow);
    }
    expandedVals.push([...tailValRow]);
    expandedForms.push([...tailFormRow]);

    data.values_grid = expandedVals;
    data.formulas_grid = expandedForms;
    data.notes_grid = rawNotes;
    data.tab_name = tabName;
    data.sheet_role = "client";
    data._storedTemplateRowIdx = templateRowIdx;
    if (hadNotesGridFromDb) {
      const { storedNotes: initNotes } = compactClientTabForStorage_(tabName, expandedVals, expandedForms, rawNotes);
      data._dbNotesJson = JSON.stringify(initNotes);
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
  const expandedForms = expandFormulasGrid2D_(storedForms, expandedVals, minCols);

  data.values_grid = expandedVals;
  data.formulas_grid = expandedForms;
  data.notes_grid = rawNotes;
  data.tab_name = tabName;
  data.sheet_role = "client";
  if (hadNotesGridFromDb) {
    const { storedNotes: initNotes } = compactClientTabForStorage_(tabName, expandedVals, expandedForms, rawNotes);
    data._dbNotesJson = JSON.stringify(initNotes);
  }
  return data;
}

async function getOrLoadVirtualTabGrid_(ctx, sheetRole, tabName, rawSheetsApi = null) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { values_grid: [], formulas_grid: [], notes_grid: {} };

  const cacheKey = `${ctx.clientName.toLowerCase()}::${sheetRole}::${tabName}`;
  const cached = _gridMemoryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && !cached.record._valuesOnlyLoaded) {
    return cached.record;
  }

  let data = null;
  let error = null;

  if (sheetRole === "client") {
    const res = await supabase
      .from("master_sheet_grids")
      .select("id, client_id, client_name, sheet_role, tab_name, values_grid, notes_grid, row_count, col_count")
      .eq("client_name", ctx.clientName)
      .or(`and(sheet_role.eq.client,tab_name.eq.${tabName}),and(sheet_role.eq.master,tab_name.eq.Client::${tabName})`)
      .limit(1)
      .maybeSingle();
    data = res.data;
    error = res.error;
    if (!error && data) {
      expandClientTabFromStorage_(data, tabName);
      _gridMemoryCache.set(cacheKey, { record: data, expiresAt: Date.now() + GRID_CACHE_TTL_MS });
      return data;
    }
  } else {
    const res = await supabase
      .from("master_sheet_grids")
      .select("id, client_id, client_name, sheet_role, tab_name, values_grid, notes_grid, row_count, col_count")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", sheetRole)
      .eq("tab_name", tabName)
      .maybeSingle();
    data = res.data;
    error = res.error;
    if (!error && data) {
      data.values_grid = compactGrid2D(data.values_grid || []);
      data.formulas_grid = data.values_grid;
      _gridMemoryCache.set(cacheKey, { record: data, expiresAt: Date.now() + GRID_CACHE_TTL_MS });
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
}

async function saveVirtualTabGrid_(
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

    const { storedValues, storedNotes, totalRows } = compactClientTabForStorage_(
      tabName,
      fullValues,
      fullFormulas,
      baseNotes
    );
    const nextTplIdx = storedNotes.__compact_meta?.templateRowIdx;
    const nextNotesJson = options.memoryOnly ? null : JSON.stringify(storedNotes);
    const canSkipNotesUpload =
      !options.memoryOnly &&
      !_useClientRoleFallback &&
      ((Boolean(options.valuesOnly) &&
        (nextTplIdx === undefined || nextTplIdx === existing._storedTemplateRowIdx)) ||
        Boolean(existing._dbNotesJson && nextNotesJson === existing._dbNotesJson));

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
      _dbNotesJson: options.memoryOnly ? existing._dbNotesJson : nextNotesJson,
    };
    delete inMemoryRecord.notes_grid.__formulas_grid;
    delete inMemoryRecord.notes_grid.__compact_meta;

    _gridMemoryCache.set(cacheKey, {
      record: inMemoryRecord,
      expiresAt: Date.now() + GRID_CACHE_TTL_MS,
    });

    if (options.memoryOnly) return;

    const dbSheetRole = _useClientRoleFallback ? "master" : "client";
    const dbTabName = _useClientRoleFallback ? `Client::${tabName}` : tabName;

    if (canSkipNotesUpload) {
      const { error: updErr } = await supabase
        .from("master_sheet_grids")
        .update({
          values_grid: storedValues,
          row_count: totalRows,
          col_count: maxCols,
          updated_at: inMemoryRecord.updated_at,
        })
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

  const compactedValues = compactGrid2D(valuesGrid || []);
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
  };

  _gridMemoryCache.set(cacheKey, {
    record: { ...payload, formulas_grid: formulasGrid || existing.formulas_grid || compactedValues },
    expiresAt: Date.now() + GRID_CACHE_TTL_MS,
  });

  const { error: upsertErr } = await supabase.from("master_sheet_grids").upsert(payload, {
    onConflict: "client_name,sheet_role,tab_name",
  });
  if (upsertErr) {
    throw new Error(`Supabase master_sheet_grids upsert failed (${tabName}): ${upsertErr.message}`);
  }

  // Keep structured relational tables synchronized when KeyInfo or Recon tabs change
  if (sheetRole === "master" && tabName === "KeyInfo") {
    await syncStructuredKeyInfoFromGrid_(ctx, valuesGrid).catch((e) =>
      console.warn("[masterEngineService] KeyInfo relational sync warning:", e.message)
    );
  } else if (sheetRole === "recon" && /^\d{4}$/.test(tabName)) {
    await syncReconPeriodAndItemsFromGrid_(ctx, tabName, valuesGrid).catch((e) =>
      console.warn("[masterEngineService] Recon relational sync warning:", e.message)
    );
  }
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
            memoryOnly: !["Sessions", "AppLog", "Welcome", "OutgNotes"].includes(u.parsed.tabName),
          });
          updatedTabs.add(u.parsed.tabName);
        }
      }
      if (updatedTabs.size > 0) {
        await recomputeClientFormulasAfterVirtualWrite_(ctx, [...updatedTabs], rawSheetsApi);
      }
    } catch (err) {
      console.warn(`[masterEngineService] Virtual Client Sheet mirror warning (${ctx.clientName}):`, err.message);
    }
  }
}

function hashTabNameToSheetId_(tabName, idx = 0) {
  let h = 1000 + idx;
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
    tabsSet.has("ConfCalcs");
  const needsDir =
    tabsSet.has("JnlsFromApp") ||
    tabsSet.has("JnlAppList") ||
    tabsSet.has("DirDashList") ||
    tabsSet.has("DirComp") ||
    tabsSet.has("ConfCalcs") ||
    tabsSet.has("Outgoings") ||
    tabsSet.has("OutgNotes");

  if (!needsCrm && !needsPl && !needsInv && !needsDir) return;

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

  const grids = {};
  const recordsByTab = {};
  const clientKey = String(ctx.clientName || "").toLowerCase();
  const missingMasterTabs = [];
  for (const t of masterTabsNeeded) {
    const cached = _gridMemoryCache.get(`${clientKey}::master::${t}`);
    if (cached && cached.expiresAt > Date.now() && !cached.record._valuesOnlyLoaded) {
      recordsByTab[t] = cached.record;
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
      _gridMemoryCache.set(`${clientKey}::master::${r.tab_name}`, {
        record: r,
        expiresAt: Date.now() + GRID_CACHE_TTL_MS,
      });
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

  const prevE21 = grids.KeyInfo?.[20]?.[4] ?? "";
  const prevI29 = grids.KeyInfo?.[28]?.[8] ?? "";

  const dirtyOut = new Set();
  if (needsCrm) {
    evaluateCRMList(grids);
    evaluateCRMComp(grids);
    dirtyOut.add("CRMList");
    dirtyOut.add("CRMComp");
  }
  if (needsPl || needsCrm) {
    if (tabsSet.has("KeyInfo") || tabsSet.has("Outgoings")) {
      evaluateOutgoingsMasterTab(grids);
      dirtyOut.add("Outgoings");
    }
    evaluateKeyInfoAndPLComp(grids);
    dirtyOut.add("KeyInfo");
    if (needsPl) dirtyOut.add("PLComp");
  }
  if (needsInv) {
    evaluateInvAppList(grids);
    evaluateInvDashList(grids);
    evaluateInvComp(grids);
    dirtyOut.add("InvAppList");
    dirtyOut.add("InvDashList");
    dirtyOut.add("InvComp");
  }
  if (needsDir) {
    evaluateJnlAppList(grids);
    evaluateDirDashList(grids);
    evaluateDirComp(grids);
    dirtyOut.add("JnlAppList");
    dirtyOut.add("DirDashList");
    dirtyOut.add("DirComp");
  }

  await Promise.all(
    [...dirtyOut].map((t) => {
      const origRec = recordsByTab[t] || {};
      return saveVirtualTabGrid_(ctx, "master", t, grids[t] || [], origRec.formulas_grid, origRec.notes_grid);
    })
  );

  const nextE21 = grids.KeyInfo?.[20]?.[4] ?? "";
  const nextI29 = grids.KeyInfo?.[28]?.[8] ?? "";
  if (nextE21 !== prevE21 || nextI29 !== prevI29) {
    await mirrorMasterWriteToClientSheetIfNeeded_(ctx, rawSheetsApi, [
      { range: "KeyInfo!E21", values: [[nextE21]] },
      { range: "KeyInfo!I29", values: [[nextI29]] },
    ]);
  }
}

const _pendingClientTabsByClient = new Map();
const _pendingClientCtxByClient = new Map();

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

  function queuePendingClientTabs_(clientNameOrCtx, tabNames) {
    const clientName = typeof clientNameOrCtx === "object" ? clientNameOrCtx?.clientName : clientNameOrCtx;
    const key = String(clientName || "").toLowerCase();
    if (!key) return;
    if (typeof clientNameOrCtx === "object" && clientNameOrCtx) {
      _pendingClientCtxByClient.set(key, clientNameOrCtx);
    }
    let set = _pendingClientTabsByClient.get(key);
    if (!set) {
      set = new Set();
      _pendingClientTabsByClient.set(key, set);
    }
    for (const t of tabNames) {
      if (t) set.add(t);
    }
  }

  export async function flushPendingClientRecomputes(rawSheetsApi = null, clientName = null) {
    const keys = clientName
      ? [String(clientName).toLowerCase()]
      : [..._pendingClientTabsByClient.keys()];
    for (const key of keys) {
      const pendingSet = _pendingClientTabsByClient.get(key);
      const ctx = _pendingClientCtxByClient.get(key);
      if (pendingSet && pendingSet.size > 0 && ctx) {
        await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Deferred client formula recompute warning:", e.message)
        );
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

  function doesClientRangeNeedFormulaFlush_(parsed) {
    if (!parsed || !parsed.tabName) return false;
    if (DIRECT_INPUT_CLIENT_TABS.has(parsed.tabName)) return false;
    if (parsed.tabName === "Outgoings") {
      const sR = parsed.startRow0 ?? 0;
      const eR = parsed.endRow0 ?? 999;
      // Outgoings rows 1..110 (0-indexed 0..109) are direct inputs; row 111+ (0-indexed >= 110) includes Making up CoS & summaries
      return eR >= 110 || sR >= 110;
    }
    if (parsed.tabName === "Salaries") {
      const sR = parsed.startRow0 ?? 0;
      const eR = parsed.endRow0 ?? 999;
      // Salaries rows 4..53 (0-indexed 3..52) are direct inputs; row 55+ (0-indexed >= 54) are totals
      return eR >= 54 || sR >= 54;
    }
    return true;
  }

  function remapNotesGridRows_(notesGrid, mapRowFn) {
    if (!notesGrid || typeof notesGrid !== "object") return {};
    const next = {};
    for (const [k, v] of Object.entries(notesGrid)) {
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

  async function recomputeClientFormulasAfterVirtualWrite_(ctx, updatedTabNames, rawSheetsApi) {
    const clientKey = String(ctx.clientName || "").toLowerCase();
    _lastClientEditTimestampMap.set(clientKey, Date.now());
    queuePendingClientTabs_(ctx.clientName, updatedTabNames);
    queuePendingClientTabs_(ctx, updatedTabNames);
    const pendingSet = _pendingClientTabsByClient.get(clientKey);
    const allUpdatedTabs = pendingSet ? [...pendingSet] : [...updatedTabNames];
    if (pendingSet) pendingSet.clear();

    const nonFormulaTabs = new Set(["Sessions", "AppLog", "Welcome", "OutgNotes"]);
    const nonFormulaTabs = new Set(["Sessions", "AppLog", "Welcome"]);
    const hasCalcRelevantChange = allUpdatedTabs.some((t) => !nonFormulaTabs.has(t));
    if (!hasCalcRelevantChange) {
      return;
    }

    const changedSet = new Set(allUpdatedTabs);
    const unaffectedTabs = new Set();
    if (!changedSet.has("KeyInfo")) {
      unaffectedTabs.add("KeyInfo");
      if (!changedSet.has("Salaries")) {
        unaffectedTabs.add("Salaries");
      }
      if (!changedSet.has("Outgoings") && !changedSet.has("OutgNotes")) {
        unaffectedTabs.add("OutgNotes");
      }
      if (!changedSet.has("Confirmed") && !changedSet.has("ConfCalcs") && !changedSet.has("RevenueConf")) {
        unaffectedTabs.add("Confirmed");
        unaffectedTabs.add("ConfCalcs");
        unaffectedTabs.add("RevenueConf");
      }
      if (!changedSet.has("Pipeline") && !changedSet.has("PipeCalcs") && !changedSet.has("RevenuePipe")) {
        unaffectedTabs.add("Pipeline");
        unaffectedTabs.add("PipeCalcs");
        unaffectedTabs.add("RevenuePipe");
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

    const supabase = getSupabaseAdmin();
    const recordsByTab = {};
    const prevSnapshots = {};
    const grids = {};

    // 1. Check in-memory cache first; batch-load any uncached tabs
    //    For unaffectedTabs, only load values_grid (skipping multi-MB notes_grid like Salaries 7.3MB!)
    const missingAffectedTabs = [];
    const missingUnaffectedTabs = [];
    for (const tabName of CORE_CLIENT_TABS) {
      if (nonFormulaTabs.has(tabName)) continue;
      const cacheKey = `${clientKey}::client::${tabName}`;
      const cached = _gridMemoryCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() && (!cached.record._valuesOnlyLoaded || unaffectedTabs.has(tabName))) {
        recordsByTab[tabName] = cached.record;
      } else if (unaffectedTabs.has(tabName)) {
        missingUnaffectedTabs.push(tabName);
      } else {
        missingAffectedTabs.push(tabName);
      }
    }

    if ((missingAffectedTabs.length > 0 || missingUnaffectedTabs.length > 0) && supabase) {
      const dbRole = _useClientRoleFallback ? "master" : "client";
      const queries = [];
      if (missingAffectedTabs.length > 0) {
        const targetNames = _useClientRoleFallback
          ? missingAffectedTabs.map((t) => `Client::${t}`)
          : missingAffectedTabs;
        const CHUNK_SIZE = 5;
        for (let i = 0; i < targetNames.length; i += CHUNK_SIZE) {
          const chunk = targetNames.slice(i, i + CHUNK_SIZE);
          queries.push(
            supabase
              .from("master_sheet_grids")
              .select("id, client_id, client_name, sheet_role, tab_name, values_grid, notes_grid, row_count, col_count")
              .eq("client_name", ctx.clientName)
              .eq("sheet_role", dbRole)
              .in("tab_name", chunk)
              .then(({ data }) => ({ rows: data || [], valuesOnly: false }))
          );
        }
      }
      if (missingUnaffectedTabs.length > 0) {
        const targetNames = _useClientRoleFallback
          ? missingUnaffectedTabs.map((t) => `Client::${t}`)
          : missingUnaffectedTabs;
        queries.push(
          supabase
            .from("master_sheet_grids")
            .select("id, client_id, client_name, sheet_role, tab_name, values_grid, row_count, col_count")
            .eq("client_name", ctx.clientName)
            .eq("sheet_role", dbRole)
            .in("tab_name", targetNames)
            .then(({ data }) => ({ rows: data || [], valuesOnly: true }))
        );
      }
      const queryResults = await Promise.all(queries);
      for (const { rows, valuesOnly } of queryResults) {
        for (const r of rows) {
          const cleanTab = r.tab_name.startsWith("Client::") ? r.tab_name.slice(8) : r.tab_name;
          if (!recordsByTab[cleanTab]) {
            expandClientTabFromStorage_(r, cleanTab);
            if (valuesOnly) r._valuesOnlyLoaded = true;
            recordsByTab[cleanTab] = r;
            _gridMemoryCache.set(`${clientKey}::client::${cleanTab}`, {
              record: r,
              expiresAt: Date.now() + GRID_CACHE_TTL_MS,
            });
          }
        }
      }
    }

    for (const tabName of CORE_CLIENT_TABS) {
      if (nonFormulaTabs.has(tabName)) continue;
      let rec = recordsByTab[tabName];
      if (!rec) {
        rec = await getOrLoadVirtualTabGrid_(ctx, "client", tabName, rawSheetsApi);
        recordsByTab[tabName] = rec;
      }
      const origVals = Array.isArray(rec.values_grid) ? rec.values_grid : [];
      const isUnaffected = unaffectedTabs.has(tabName);

      if (isUnaffected) {
        grids[tabName] = {
          values: origVals,
          formulas: rec.formulas_grid || [],
          notes: rec.notes_grid || {},
        };
        continue;
      }

      prevSnapshots[tabName] = snapshotClientValuesForDiff_(tabName, origVals);

      const vGrid = origVals.map((r, rIdx) => (rIdx > 0 && r === origVals[rIdx - 1] ? r : Array.isArray(r) ? [...r] : []));
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
            const curV = vGrid[r]?.[c];
            if (typeof curV === "string" && curV.startsWith("#REF! (Array result was not expanded")) {
              continue;
            }
            if (tabName === "DataForReport" && (c === 6 || r === 2)) {
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

    recalculateClientGrids(grids, { changedTabs: allUpdatedTabs });

    // 2. Persist all directly updated tabs plus any downstream tabs whose evaluated values changed
    const dirtyTabs = CORE_CLIENT_TABS.filter((t) => {
      if (nonFormulaTabs.has(t) || unaffectedTabs.has(t) || !grids[t]?.values?.length) return false;
      if (changedSet.has(t)) return true;
      return snapshotClientValuesForDiff_(t, grids[t].values) !== prevSnapshots[t];
    });

    await Promise.all(
      dirtyTabs.map((t) =>
        saveVirtualTabGrid_(
          ctx,
          "client",
          t,
          grids[t].values,
          grids[t].formulas,
          recordsByTab[t]?.notes_grid || {},
          { valuesOnly: !changedSet.has(t) }
        )
      )
    );

    // Refresh memory cache TTL for all loaded tabs of this client so consecutive operations stay warm
    const refreshedExpiry = Date.now() + GRID_CACHE_TTL_MS;
    for (const tabName of CORE_CLIENT_TABS) {
      const cacheKey = `${clientKey}::client::${tabName}`;
      const entry = _gridMemoryCache.get(cacheKey);
      if (entry) {
        entry.expiresAt = refreshedExpiry;
      }
    }

    // Sync Stage 4 relational tables non-blockingly in the background once master_sheet_grids is saved
    const changedTabList = [...new Set([...allUpdatedTabs, ...dirtyTabs])];
    syncStructuredClientTablesFromGrids_(ctx, grids, changedTabList).catch((e) =>
      console.warn("[masterEngineService] Stage 4 relational sync warning:", e.message)
    );
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
      if (
        sheetRole === "client" &&
        params.valueRenderOption !== "FORMULA" &&
        doesClientRangeNeedFormulaFlush_(parsed)
      ) {
        const pendingSet = _pendingClientTabsByClient.get(String(ctx.clientName || "").toLowerCase());
        if (pendingSet && pendingSet.size > 0) {
          await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
            console.warn("[masterEngineService] Read-barrier formula recompute warning:", e.message)
          );
        }
      }
      const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, parsed.tabName, rawSheetsApi);
      const isFormula =
        params.valueRenderOption === "FORMULA" && Array.isArray(rec.formulas_grid) && rec.formulas_grid.length > 0;
      const isUnformatted = params.valueRenderOption === "UNFORMATTED_VALUE";
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
      if (
        sheetRole === "client" &&
        params.valueRenderOption !== "FORMULA" &&
        parsedList.some((p) => doesClientRangeNeedFormulaFlush_(p.parsed))
      ) {
        const pendingSet = _pendingClientTabsByClient.get(String(ctx.clientName || "").toLowerCase());
        if (pendingSet && pendingSet.size > 0) {
          await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
            console.warn("[masterEngineService] Read-barrier formula recompute warning:", e.message)
          );
        }
      }
      const uniqueTabs = [...new Set(parsedList.map((p) => p.parsed.tabName))];

      const byTab = new Map();
      if (sheetRole === "client") {
        for (let i = 0; i < uniqueTabs.length; i += 3) {
          const chunk = uniqueTabs.slice(i, i + 3);
          await Promise.all(
            chunk.map(async (tabName) => {
              const rec = await getOrLoadVirtualTabGrid_(ctx, "client", tabName, rawSheetsApi);
              byTab.set(tabName, rec);
            })
          );
        }
      } else {
        const { data: rows } = await supabase
          .from("master_sheet_grids")
          .select("*")
          .eq("client_name", ctx.clientName)
          .eq("sheet_role", sheetRole)
          .in("tab_name", uniqueTabs);

        for (const r of rows || []) {
          byTab.set(r.tab_name, r);
          _gridMemoryCache.set(`${ctx.clientName.toLowerCase()}::${sheetRole}::${r.tab_name}`, {
            record: r,
            expiresAt: Date.now() + GRID_CACHE_TTL_MS,
          });
        }
      }

      const isFormulaReq = params.valueRenderOption === "FORMULA";
      const isUnformattedReq = params.valueRenderOption === "UNFORMATTED_VALUE";

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
      const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, parsed.tabName, rawSheetsApi);
      const prevValSnap =
        sheetRole === "client" ? snapshotClientValuesForDiff_(parsed.tabName, rec.values_grid) : null;
      const prevFormSnap =
        sheetRole === "client"
          ? snapshotClientValuesForDiff_(parsed.tabName, rec.formulas_grid || rec.values_grid)
          : null;
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
            await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
              console.warn("[masterEngineService] Client formula recompute warning:", e.message)
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
      const isDeferredClientSave =
        sheetRole === "client" && !["Sessions", "AppLog", "Welcome", "OutgNotes"].includes(parsed.tabName);
      sheetRole === "client" && !["Sessions", "AppLog", "Welcome"].includes(parsed.tabName);
      await saveVirtualTabGrid_(ctx, sheetRole, parsed.tabName, updatedValues, updatedFormulas, rec.notes_grid, {
        memoryOnly: isDeferredClientSave,
      });

      if (sheetRole === "master") {
        await recomputeMasterFormulasAfterVirtualWrite_(ctx, [parsed.tabName], rawSheetsApi).catch((e) =>
          console.warn("[masterEngineService] Formula recompute warning:", e.message)
        );
        await mirrorMasterWriteToClientSheetIfNeeded_(ctx, rawSheetsApi, [{ range: rangeStr, values: incomingValues }]);
      } else if (sheetRole === "client") {
        if (params._skipFormulaRecompute) {
          queuePendingClientTabs_(ctx.clientName, [parsed.tabName]);
          queuePendingClientTabs_(ctx, [parsed.tabName]);
        } else {
          await recomputeClientFormulasAfterVirtualWrite_(ctx, [parsed.tabName], rawSheetsApi).catch((e) =>
            console.warn("[masterEngineService] Client formula recompute warning:", e.message)
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
      for (const [tabName, updates] of byTabUpdates.entries()) {
        const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, tabName, rawSheetsApi);
        const prevOutgSnap =
          sheetRole === "client" && tabName === "OutgNotes"
            ? snapshotClientValuesForDiff_("OutgNotes", rec.values_grid)
            : null;
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
          prevOutgSnap !== null &&
          snapshotClientValuesForDiff_("OutgNotes", nextVals) === prevOutgSnap
        ) {
          continue;
        }
        actuallyChangedTabs.push(tabName);
        const isDeferredClientSave =
          sheetRole === "client" && !["Sessions", "AppLog", "Welcome", "OutgNotes"].includes(tabName);
        sheetRole === "client" && !["Sessions", "AppLog", "Welcome"].includes(tabName);
        await saveVirtualTabGrid_(ctx, sheetRole, tabName, nextVals, nextForms, rec.notes_grid, {
          memoryOnly: isDeferredClientSave,
        });
      }

      if (sheetRole === "master") {
        await recomputeMasterFormulasAfterVirtualWrite_(ctx, [...byTabUpdates.keys()], rawSheetsApi).catch((e) =>
    if (sheetRole === "master" && actuallyChangedTabs.length > 0) {
          await recomputeMasterFormulasAfterVirtualWrite_(ctx, actuallyChangedTabs, rawSheetsApi).catch((e) =>
            console.warn("[masterEngineService] Formula recompute warning:", e.message)
          );
          await mirrorMasterWriteToClientSheetIfNeeded_(ctx, rawSheetsApi, dataItems);
        } else if (sheetRole === "client") {
          if (params._skipFormulaRecompute) {
            queuePendingClientTabs_(ctx.clientName, [...byTabUpdates.keys()]);
            if (actuallyChangedTabs.length > 0) {
              queuePendingClientTabs_(ctx, actuallyChangedTabs);
            }
          } else {
            await recomputeClientFormulasAfterVirtualWrite_(ctx, [...byTabUpdates.keys()], rawSheetsApi).catch((e) =>
              console.warn("[masterEngineService] Client formula recompute warning:", e.message)
            );
            const pendingSet = _pendingClientTabsByClient.get(String(ctx.clientName || "").toLowerCase());
            if (actuallyChangedTabs.length > 0 || (pendingSet && pendingSet.size > 0)) {
              await recomputeClientFormulasAfterVirtualWrite_(ctx, actuallyChangedTabs, rawSheetsApi).catch((e) =>
                console.warn("[masterEngineService] Client formula recompute warning:", e.message)
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
          const valueInputOption = params.valueInputOption || "USER_ENTERED";
          const parsed = parseA1Range(rangeStr);
          const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, parsed.tabName, rawSheetsApi);
          const baseRow0 = Array.isArray(rec.values_grid) ? rec.values_grid.length : 0;
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
          await saveVirtualTabGrid_(ctx, sheetRole, parsed.tabName, nextVals, nextForms, rec.notes_grid);

          if (sheetRole === "client") {
            await recomputeClientFormulasAfterVirtualWrite_(ctx, [parsed.tabName], rawSheetsApi).catch((e) =>
              console.warn("[masterEngineService] Client formula recompute warning:", e.message)
            );
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

          for (const [tabName, clears] of byTabClears.entries()) {
            const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, tabName, rawSheetsApi);
            let nextVals = rec.values_grid || [];
            let nextForms = rec.formulas_grid || rec.values_grid || [];
            for (const c of clears) {
              nextVals = clearRangeInGrid2D_(nextVals, c);
              nextForms = clearRangeInGrid2D_(nextForms, c);
            }
            const isDeferredClientSave =
              sheetRole === "client" && !["Sessions", "AppLog", "Welcome", "OutgNotes"].includes(tabName);
            Boolean(params._skipFormulaRecompute) ||
              (sheetRole === "client" && !["Sessions", "AppLog", "Welcome"].includes(tabName));
            await saveVirtualTabGrid_(ctx, sheetRole, tabName, nextVals, nextForms, rec.notes_grid, {
              memoryOnly: isDeferredClientSave,
            });
          }

          if (sheetRole === "client") {
            if (params._skipFormulaRecompute) {
              queuePendingClientTabs_(ctx.clientName, [...byTabClears.keys()]);
              queuePendingClientTabs_(ctx, [...byTabClears.keys()]);
            } else {
              await recomputeClientFormulasAfterVirtualWrite_(ctx, [...byTabClears.keys()], rawSheetsApi).catch((e) =>
                console.warn("[masterEngineService] Client formula recompute warning:", e.message)
              );
            }
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
          if (
            sheetRole === "client" &&
            includeGridData &&
            (requestedRanges.length === 0 || requestedRanges.some((r) => doesClientRangeNeedFormulaFlush_(parseA1Range(r))))
          ) {
            const pendingSet = _pendingClientTabsByClient.get(String(ctx.clientName || "").toLowerCase());
            if (pendingSet && pendingSet.size > 0) {
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
            } else if (targetTabNames && targetTabNames.size > 0) {
              for (const tName of targetTabNames) {
                const rec = await getOrLoadVirtualTabGrid_(ctx, "client", tName, rawSheetsApi);
                allTabs.push(rec);
              }
            } else {
              const { data: tabRows } = await supabase
                .from("master_sheet_grids")
                .select("tab_name, sheet_role, row_count, col_count, values_grid, notes_grid")
                .eq("client_name", ctx.clientName)
                .or("sheet_role.eq.client,and(sheet_role.eq.master,tab_name.like.Client::%)")
                .order("tab_name", { ascending: true });
              const seen = new Set();
              for (const r of tabRows || []) {
                const cleanTab = r.tab_name.startsWith("Client::") ? r.tab_name.slice(8) : r.tab_name;
                if (seen.has(cleanTab)) continue;
                seen.add(cleanTab);
                expandClientTabFromStorage_(r, cleanTab);
                allTabs.push(r);
              }
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

          const sheetsPayload = allTabs.map((t, idx) => {
            const sId = hashTabNameToSheetId_(t.tab_name, idx);
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

            if (includeGridData) {
              const matchingRanges =
                requestedRanges.length > 0
                  ? requestedRanges.map((r) => parseA1Range(r, t.tab_name)).filter((p) => p.tabName === t.tab_name)
                  : [{ tabName: t.tab_name, startRow0: 0, endRow0: (t.row_count || 1) - 1, startCol0: 0, endCol0: (t.col_count || 1) - 1 }];

              if (matchingRanges.length > 0) {
                sheetObj.data = matchingRanges.map((mr) => {
                  const slicedVals = sliceGrid2D_(t.values_grid || [], mr);
                  const slicedForms = sliceGrid2D_(t.formulas_grid || t.values_grid || [], mr);
                  const rowCount = Math.max(
                    slicedVals.length,
                    slicedForms.length,
                    t.tab_name === "Cash" && mr.endRow0 != null ? Math.min(76, mr.endRow0 + 1) - (mr.startRow0 ?? 0) : 0
                  );
                  const rowData = [];
                  for (let rOffset = 0; rOffset < rowCount; rOffset++) {
                    const absR = (mr.startRow0 ?? 0) + rOffset;
                    const rArr = slicedVals[rOffset] || [];
                    const fArr = slicedForms[rOffset] || [];
                    const colCount = Math.max(
                      rArr.length,
                      fArr.length,
                      t.tab_name === "Cash" && mr.endCol0 != null ? Math.min(37, mr.endCol0 + 1) - (mr.startCol0 ?? 0) : 0
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
                      const effFmt =
                        t.tab_name === "Cash"
                          ? getCashEffectiveFormat_(absR, absC)
                          : { backgroundColor: { red: 1, green: 1, blue: 1 } };
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

        // 8. spreadsheets.batchUpdate (handles updateSheetProperties, updateCells, moveDimension, insertDimension, deleteDimension)
        if (namespace === "spreadsheets" && method === "batchUpdate") {
          const requests = params.requestBody?.requests || params.resource?.requests || [];
          const hasDataOrSheetUpdates = requests.some(
            (req) =>
              req.updateSheetProperties?.properties ||
              req.updateCells?.range ||
              (req.moveDimension?.source && req.moveDimension.source.dimension === "ROWS") ||
              (req.insertDimension?.range && req.insertDimension.range.dimension === "ROWS") ||
              (req.deleteDimension?.range && req.deleteDimension.range.dimension === "ROWS")
          );
          if (!hasDataOrSheetUpdates) {
            // Visual-only operations (row grouping, hiddenByUser, repeatCell formatting) require zero DB queries
            if (sheetRole === "client" && !params._skipFormulaRecompute) {
              // and must NOT prematurely flush pending formula recomputes in the middle of a multi-step operation
              // unless explicitly requested via _flushPendingRecompute.
              if (sheetRole === "client" && params._flushPendingRecompute) {
                const pendingSet = _pendingClientTabsByClient.get(String(ctx.clientName || "").toLowerCase());
                if (pendingSet && pendingSet.size > 0) {
                  await recomputeClientFormulasAfterVirtualWrite_(ctx, [], rawSheetsApi).catch((e) =>
                    console.warn("[masterEngineService] Client formula recompute warning:", e.message)
                  );
                }
              }
              return {
                status: 200,
                data: { spreadsheetId, replies: requests.map(() => ({})) },
              };
            }

            let tabMetaRows = [];
            if (sheetRole === "client") {
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
            tabMetaRows.forEach((t, idx) => {
              metaBySheetId.set(hashTabNameToSheetId_(t.tab_name, idx), t);
            });

            const loadedTargetBySheetId = new Map();
            const getTargetTabRecord = async (sId) => {
              if (loadedTargetBySheetId.has(sId)) return loadedTargetBySheetId.get(sId);
              const meta = metaBySheetId.get(sId);
              if (!meta) return null;
              const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, meta.tab_name, rawSheetsApi);
              rec.id = meta.id;
              loadedTargetBySheetId.set(sId, rec);
              return rec;
            };

            const dirtyTargets = new Map();
            const valueChangedClientTabs = new Set();
            const noteOnlyClientTabs = new Set();

            for (const req of requests) {
              if (req.updateSheetProperties?.properties) {
                const props = req.updateSheetProperties.properties;
                const meta = metaBySheetId.get(props.sheetId);
                if (meta && props.title && props.title !== meta.tab_name) {
                  await supabase
                    .from("master_sheet_grids")
                    .update({ tab_name: props.title })
                    .eq("id", meta.id);
                  meta.tab_name = props.title;
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
                        else delete nextNotes[key];
                      }
                    });
                  });

                  if (isNoteOnly) {
                    target.notes_grid = nextNotes;
                    dirtyTargets.set(target.tab_name, target);
                    if (sheetRole === "client") noteOnlyClientTabs.add(target.tab_name);
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
                    const finalForms = nextForms.map((fObj, newR0) => {
                      const newR1 = newR0 + 1;
                      if (fObj.oldR1 === newR1) return fObj.cells;
                      const re = new RegExp(`(?<![A-Z0-9_$])(\\$?[A-Z]{1,3})${fObj.oldR1}(?!\\d)`, "g");
                      return fObj.cells.map((cell) =>
                        typeof cell === "string" && cell.startsWith("=") ? cell.replace(re, `$1${newR1}`) : cell
                      );
                    });
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
                    const nextVals = (target.values_grid || []).map((r) => (Array.isArray(r) ? [...r] : []));
                    const nextForms = (target.formulas_grid || target.values_grid || []).map((r, r0) => ({
                      oldR1: r0 + 1,
                      cells: Array.isArray(r) ? [...r] : [],
                    }));
                    while (nextVals.length < s) nextVals.push([]);
                    while (nextForms.length < s) nextForms.push({ oldR1: nextForms.length + 1, cells: [] });

                    const inherit = Boolean(req.insertDimension.inheritFromBefore) && s > 0;
                    const tplFormCells = inherit && nextForms[s - 1]
                      ? nextForms[s - 1].cells.map((c) => (typeof c === "string" && c.startsWith("=") ? c : ""))
                      : [];
                    const tplOldR1 = inherit ? s : -1;

                    const insertedV = Array.from({ length: count }, () => []);
                    const insertedF = Array.from({ length: count }, () => ({
                      oldR1: tplOldR1,
                      cells: [...tplFormCells],
                    }));
                    nextVals.splice(s, 0, ...insertedV);
                    nextForms.splice(s, 0, ...insertedF);

                    const finalForms = nextForms.map((fObj, newR0) => {
                      const newR1 = newR0 + 1;
                      if (fObj.oldR1 <= 0 || fObj.oldR1 === newR1) return fObj.cells;
                      const re = new RegExp(`(?<![A-Z0-9_$])(\\$?[A-Z]{1,3})${fObj.oldR1}(?!\\d)`, "g");
                      return fObj.cells.map((cell) =>
                        typeof cell === "string" && cell.startsWith("=") ? cell.replace(re, `$1${newR1}`) : cell
                      );
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
                    const finalForms = nextForms.map((fObj, newR0) => {
                      const newR1 = newR0 + 1;
                      if (fObj.oldR1 === newR1) return fObj.cells;
                      const re = new RegExp(`(?<![A-Z0-9_$])(\\$?[A-Z]{1,3})${fObj.oldR1}(?!\\d)`, "g");
                      return fObj.cells.map((cell) =>
                        typeof cell === "string" && cell.startsWith("=") ? cell.replace(re, `$1${newR1}`) : cell
                      );
                    });
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
              const isDeferredClientSave =
                sheetRole === "client" &&
                !["Sessions", "AppLog", "Welcome", "OutgNotes"].includes(tabName) &&
                !["Sessions", "AppLog", "Welcome"].includes(tabName) &&
                (params._skipFormulaRecompute || willRunClientFormulaRecompute) &&
                valueChangedClientTabs.has(tabName);
              await saveVirtualTabGrid_(
                ctx,
                sheetRole,
                tabName,
                target.values_grid || [],
                target.formulas_grid || [],
                target.notes_grid || {},
                { memoryOnly: isDeferredClientSave }
              );
            }

            if (sheetRole === "client") {
              if (params._skipFormulaRecompute) {
                if (valueChangedClientTabs.size > 0) {
                  queuePendingClientTabs_(ctx.clientName, [...valueChangedClientTabs]);
                  queuePendingClientTabs_(ctx, [...valueChangedClientTabs]);
                }
              } else if (willRunClientFormulaRecompute) {
                await recomputeClientFormulasAfterVirtualWrite_(ctx, [...valueChangedClientTabs], rawSheetsApi).catch((e) =>
                  console.warn("[masterEngineService] Client formula recompute warning:", e.message)
                );
              } else if (noteOnlyClientTabs.size > 0) {
                syncStructuredClientTablesFromGrids_(ctx, {}, [...noteOnlyClientTabs]).catch((e) =>
                  console.warn("[masterEngineService] Stage 4 relational note sync warning:", e.message)
                );
              }
            }

            return {
              status: 200,
              data: { spreadsheetId, replies: requests.map(() => ({})) },
            };
          }

          // 9. spreadsheets.sheets.copyTo (used by reconTabService when duplicating Template -> YYMM)
          if (namespace === "sheets" && method === "copyTo") {
            const templateRec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, "Template", rawSheetsApi);
            const tempTitle = `Copy of Template ${Date.now().toString().slice(-4)}`;
            await saveVirtualTabGrid_(
              ctx,
              sheetRole,
              tempTitle,
              templateRec.values_grid || [],
              templateRec.formulas_grid || [],
              templateRec.notes_grid || {}
            );
            const { data: tabRows } = await supabase
              .from("master_sheet_grids")
              .select("tab_name")
              .eq("client_name", ctx.clientName)
              .eq("sheet_role", sheetRole)
              .order("tab_name", { ascending: true });
            const idx = (tabRows || []).findIndex((t) => t.tab_name === tempTitle);
            const newSheetId = hashTabNameToSheetId_(tempTitle, idx >= 0 ? idx : 0);
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
            { onConflict: "client_name,month_key" }
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
            const txnDate = formatCellForDisplay("recon", monthKey, r, colCD, row[colCD], grid);
            const payee = String(row[colCD + 3] || "").trim(); // CG
            const grossAmt = parseNumericVal_(row[colCD + 4]); // CH
            const netAmt = parseNumericVal_(row[colCD + 5]); // CI
            const cat = String(row[colCD + 6] || "").trim(); // CJ
            const vatApplies = String(row[colCD + 7] || "No").trim(); // CK
            const vatAmt = parseNumericVal_(row[colCD + 8]); // CL
            const isExclRaw = row[colCD + 10]; // CN
            const isExcluded = Boolean(isExclRaw === true || String(isExclRaw || "").toUpperCase() === "TRUE");
            if (!txnDate && !payee && !grossAmt && !netAmt) continue;
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
              particulars: String(row[colCD + 2] || "").trim(),
              reference: String(row[colCD + 1] || "").trim(),
              out_amount: grossAmt < 0 ? Math.abs(grossAmt) : 0,
              in_amount: grossAmt > 0 ? grossAmt : 0,
              net_amount: netAmt,
              vat_amount: vatAmt,
              category: cat,
              vat_applies: vatApplies,
              is_excluded: isExcluded,
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

          invalidateMasterEngineCache();
          const ctx = await resolveSupabaseSheetContext({ clientName });
          if (!ctx) throw new Error(`Client "${clientName}" not found in Supabase clients registry.`);

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
          if (ctx.masterSheetId) {
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
                } else if (tabName === "InvFromApp") {
                  summary.invoicesCount = await syncInvoicesTableFromGrid_(ctx, vGrid);
                } else if (tabName === "JnlsFromApp") {
                  summary.directCostsCount = await syncDirectCostsTableFromGrid_(ctx, vGrid);
                } else if (tabName === "PLFromApp") {
                  summary.plLinesCount = await syncPLLinesTableFromGrid_(ctx, vGrid);
                } else if (tabName === "DataFromCRM") {
                  summary.crmDealsCount = await syncCrmDealsTableFromGrid_(ctx, vGrid);
                } else if (tabName === "TimeComp") {
                  summary.timeEntriesCount = await syncTimeEntriesTableFromGrid_(ctx, vGrid);
                }
              }
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
          if (ctx.reconSheetId) {
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
                await saveVirtualTabGrid_(ctx, "recon", tabName, vGrid, fGrid, {});
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

          const { data, error } = await supabase
            .from("clients")
            .update({ client_mode: cleanMode, updated_at: new Date().toISOString() })
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

        async function syncStructuredClientTablesFromGrids_(ctx, grids, changedTabs = null) {
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
            const vGrid = grids[tabName]?.values || [];
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
            await supabase.from("client_jobs").delete().eq("client_name", ctx.clientName).eq("tab_type", tabType);
            for (let i = 0; i < jobRows.length; i += 200) {
              await supabase.from("client_jobs").insert(jobRows.slice(i, i + 200));
            }
          }

          // 2. client_outgoings (Outgoings)
          if (!tabSet || tabSet.has("Outgoings")) {
            const outGrid = grids.Outgoings?.values || [];
            const outNotes = grids.Outgoings?.notes || {};
            const mHeaders = (outGrid[0] || []).slice(6, 48).map((v, i) => formatCellForDisplay("client", "Outgoings", 0, 6 + i, v, outGrid));
            const outRows = [];
            for (let r = 11; r < Math.min(outGrid.length, 230); r++) {
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
            await supabase.from("client_outgoings").delete().eq("client_name", ctx.clientName);
            for (let i = 0; i < outRows.length; i += 200) {
              await supabase.from("client_outgoings").insert(outRows.slice(i, i + 200));
            }
          }

          // 3. client_salaries (Salaries)
          if (!tabSet || tabSet.has("Salaries")) {
            const salGrid = grids.Salaries?.values || [];
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
                likelihood_pct: parseNumericVal_(row[9] ?? 1),
                raw_row: row.slice(0, 60),
                updated_at: nowIso,
              });
            }
            await supabase.from("client_salaries").delete().eq("client_name", ctx.clientName);
            if (salRows.length > 0) {
              await supabase.from("client_salaries").insert(salRows);
            }
          }

          // 4. client_budgets_and_targets (Budget & NBtoFind)
          for (const [tabName, modelType] of [
            ["Budget", "budget"],
            ["NBtoFind", "nb_to_find"],
          ]) {
            if (tabSet && !tabSet.has(tabName)) continue;
            const bGrid = grids[tabName]?.values || [];
            const bRows = [];
            for (let r = 1; r < Math.min(bGrid.length, 100); r++) {
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
            await supabase.from("client_budgets_and_targets").delete().eq("client_name", ctx.clientName).eq("model_type", modelType);
            if (bRows.length > 0) {
              await supabase.from("client_budgets_and_targets").insert(bRows);
            }
          }

          // 5. client_cash_balances (Cash)
          if (!tabSet || tabSet.has("Cash") || tabSet.has("Outgoings") || tabSet.has("Confirmed")) {
            const cashGrid = grids.Cash?.values || [];
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
            await supabase.from("client_cash_balances").delete().eq("client_name", ctx.clientName);
            if (cashRows.length > 0) {
              await supabase.from("client_cash_balances").insert(cashRows);
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

          invalidateMasterEngineCache();
          const ctx = await resolveSupabaseSheetContext({ clientName });
          if (!ctx || !ctx.clientSheetId) {
            throw new Error(`Client "${clientName}" not found or missing clientSheetId.`);
          }

          const metaResp = await sheets.spreadsheets.get({
            spreadsheetId: ctx.clientSheetId,
            fields: "sheets(properties(sheetId,title))",
            _bypassSupabaseVirtualSheet: true,
          });
          const existingTitles = new Set((metaResp.data.sheets || []).map((s) => s.properties.title));
          const tabsToFetch = CORE_CLIENT_TABS.filter((t) => existingTitles.has(t));

          // Fetch Outgoings notes (G13:AV111)
          const outNotesMap = {};
          if (existingTitles.has("Outgoings")) {
            try {
              const notesResp = await sheets.spreadsheets.get({
                spreadsheetId: ctx.clientSheetId,
                ranges: ["Outgoings!G13:AV111"],
                fields: "sheets.data.rowData.values.note",
                _bypassSupabaseVirtualSheet: true,
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
              console.warn(`[masterEngineService] Outgoings notes fetch warning (${clientName}):`, e.message);
            }
          }

          const grids = {};
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
              const notesGrid = tabName === "Outgoings" ? outNotesMap : {};
              grids[tabName] = {
                values: valuesGrid,
                formulas: formulasGrid,
                notes: notesGrid,
              };
              await saveVirtualTabGrid_(ctx, "client", tabName, valuesGrid, formulasGrid, notesGrid);
            }
          }

          await syncStructuredClientTablesFromGrids_(ctx, grids).catch((e) =>
            console.warn("[masterEngineService] Stage 4 relational sync warning:", e.message)
          );

          invalidateMasterEngineCache(ctx.clientName);

          return {
            success: true,
            clientName: ctx.clientName,
            clientTabsSynced: tabsToFetch.length,
            outgoingsNotesCount: Object.keys(outNotesMap).length,
            usedRoleFallback: _useClientRoleFallback,
          };
        }

        /**
         * Returns Stage 2 & Stage 4 table counts, client master_mode / client_mode status, and virtual tabs for PMA Settings & Workbook Inspector
         */
        export async function getStage2Status(targetClientName = "APPTEST") {
          if (!isSupabaseConfigured()) {
            return { configured: false, schemaReady: false, tables: [], clients: [] };
          }
          const supabase = getSupabaseAdmin();
          const tableResults = await Promise.all(
            STAGE2_TABLES.map(async (t) => {
              try {
                const { count, error } = await supabase
                  .from(t.name)
                  .select("client_name", { count: "exact" })
                  .eq("client_name", targetClientName)
                  .limit(1);
                if (error) {
                  return { ...t, exists: false, count: 0, error: error.message };
                }
                return { ...t, exists: true, count: count ?? 0 };
              } catch (err) {
                return { ...t, exists: false, count: 0, error: err.message };
              }
            })
          );

          const schemaReady = tableResults.every((t) => t.exists);

          const { data: clientsData } = await supabase
            .from("clients")
            .select("id, client_name, normalized_key, status, master_mode, client_mode, client_sheet_id, master_sheet_id, recon_sheet_id")
            .order("client_name", { ascending: true });

          let keyInfoMeta = null;
          let availableTabs = { master: [], recon: [], client: [] };
          let enrichedClients = clientsData || [];

          if (schemaReady) {
            const [{ data: allKi }, { data: allGrids }, { data: allScheds }, { data: allInts }, { data: targetGrids }] =
              await Promise.all([
                supabase
                  .from("tenant_key_info")
                  .select("client_name, accounting_tool, crm_tool, crm_drives, client_materialized_at, updated_at"),
                supabase
                  .from("master_sheet_grids")
                  .select("client_name, sheet_role, tab_name, updated_at"),
                supabase
                  .from("sync_schedules")
                  .select("client_name, inv_freq, crm_freq, exp_freq, last_inv_run, last_crm_run, last_exp_run"),
                supabase
                  .from("tenant_integrations")
                  .select("client_id, tool, status"),
                supabase
                  .from("master_sheet_grids")
                  .select("sheet_role, tab_name, row_count, col_count, updated_at")
                  .eq("client_name", targetClientName)
                  .order("tab_name", { ascending: true }),
              ]);

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
              } else if (g.tab_name !== "GasScriptProps") {
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
              } else if (g.tab_name !== "GasExecLogs" && g.tab_name !== "GasScriptProps") {
                availableTabs.master.push(g);
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
                masterTabCount: gs.masterTabCount,
                reconTabCount: gs.reconTabCount,
                clientTabCount: gs.clientTabCount,
                hasExecLogs: gs.hasExecLogs,
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

          let migrationSql = "";
          try {
            const sqlPath = path.join(process.cwd(), "supabase", "migrations", "0002_stage2_master_and_recon.sql");
            if (fs.existsSync(sqlPath)) {
              migrationSql = fs.readFileSync(sqlPath, "utf8");
            }
          } catch {
            // ignore
          }

          let clockMigrationSql = "";
          try {
            const clockSqlPath = path.join(process.cwd(), "supabase", "migrations", "0003_supabase_30m_cron_clock.sql");
            if (fs.existsSync(clockSqlPath)) {
              clockMigrationSql = fs.readFileSync(clockSqlPath, "utf8");
            }
          } catch {
            // ignore
          }

          let stage4MigrationSql = "";
          try {
            const stage4SqlPath = path.join(process.cwd(), "supabase", "migrations", "0004_stage4_client_sheet_engine.sql");
            if (fs.existsSync(stage4SqlPath)) {
              stage4MigrationSql = fs.readFileSync(stage4SqlPath, "utf8");
            }
          } catch {
            // ignore
          }

          const clockStatus = await getSupabaseClockStatusAndSyncConfig().catch(() => null);

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
            stage4MigrationSql,
            clockStatus,
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

          const needsSeedOrRefresh =
            !cfgVal ||
            (cronSecret && cfgVal.cronSecret !== cronSecret) ||
            (bypassToken && cfgVal.bypassToken !== bypassToken) ||
            !cfgVal.targetUrl;

          if (needsSeedOrRefresh) {
            cfgVal = {
              ...(cfgVal || {}),
              enabled: cfgVal?.enabled !== undefined ? Boolean(cfgVal.enabled) : true,
              targetUrl: cfgVal?.targetUrl || defaultUrl,
              cronSecret,
              bypassToken,
              updatedAt: new Date().toISOString(),
            };
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
            hasSecretConfigured: Boolean(cfgVal?.cronSecret),
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
          const { data: cfgRow } = await supabase
            .from("system_config")
            .select("*")
            .eq("key", "supabase_cron_clock")
            .maybeSingle();

          const nextVal = {
            ...(cfgRow?.value || {}),
            enabled: Boolean(enabled),
            updatedAt: new Date().toISOString(),
          };

          await supabase.from("system_config").upsert({
            key: "supabase_cron_clock",
            value: nextVal,
            description: "Supabase pg_cron 30-minute wake-up clock configuration and telemetry",
            updated_by: updatedBy,
          });

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
         * Fetches a virtual tab grid for the Admin Workbook Inspector
         */
        export async function getVirtualTabForInspector({
          clientName = "APPTEST",
          sheetRole = "master",
          tabName = "KeyInfo",
          maxRows = 300,
          maxCols = 60,
        }) {
          const supabase = getSupabaseAdmin();
          if (!supabase) throw new Error("Supabase is not configured.");

          let data = null;
          let error = null;
          if (sheetRole === "client") {
            const res = await supabase
              .from("master_sheet_grids")
              .select("*")
              .eq("client_name", clientName)
              .or(`and(sheet_role.eq.client,tab_name.eq.${tabName}),and(sheet_role.eq.master,tab_name.eq.Client::${tabName})`)
              .limit(1)
              .maybeSingle();
            data = res.data;
            error = res.error;
            if (!error && data) {
              expandClientTabFromStorage_(data, tabName);
            }
          } else {
            const res = await supabase
              .from("master_sheet_grids")
              .select("*")
              .eq("client_name", clientName)
              .eq("sheet_role", sheetRole)
              .eq("tab_name", tabName)
              .maybeSingle();
            data = res.data;
            error = res.error;
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
              formulasGrid: [],
              updatedAt: null,
            };
          }

          const rawSlice = (data.values_grid || [])
            .slice(0, maxRows)
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
                data.values_grid || [],
                data.notes_grid || {}
              );
          const fGrid = (data.formulas_grid || data.values_grid || [])
            .slice(0, maxRows)
            .map((r) => (Array.isArray(r) ? r.slice(0, maxCols) : []));

          return {
            clientName,
            sheetRole,
            tabName,
            rowCount: data.row_count || (data.values_grid || []).length,
            colCount: data.col_count || 0,
            valuesGrid: vGrid,
            formulasGrid: fGrid,
            updatedAt: data.updated_at,
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
          const ctx = await resolveSupabaseSheetContext({ clientName });
          if (!ctx) throw new Error(`Client "${clientName}" not found.`);

          const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, tabName, null);
          const colLetter = colIdx0ToLetter(colIndex0);
          const a1Coord = `'${tabName}'!${colLetter}${Number(rowIndex0) + 1}`;
          const parsed = parseA1Range(a1Coord, tabName);

          const nextVals = applyWriteToGrid2D_(rec.values_grid || [], parsed, [[value]]);
          const nextForms = applyWriteToGrid2D_(rec.formulas_grid || rec.values_grid || [], parsed, [[value]], {
            isFormulaGrid: true,
          });
          await saveVirtualTabGrid_(ctx, sheetRole, tabName, nextVals, nextForms, rec.notes_grid);

          if (sheetRole === "master") {
            await recomputeMasterFormulasAfterVirtualWrite_(ctx, [tabName], sheets);
            if (sheets) {
              await mirrorMasterWriteToClientSheetIfNeeded_(ctx, sheets, [
                { range: `${tabName}!${colLetter}${Number(rowIndex0) + 1}`, values: [[value]] },
              ]);
            }
          } else if (sheetRole === "client") {
            await recomputeClientFormulasAfterVirtualWrite_(ctx, [tabName], sheets);
          }

          return {
            success: true,
            clientName,
            sheetRole,
            tabName,
            cellCoord: `${colLetter}${Number(rowIndex0) + 1}`,
            value,
          };
        }
