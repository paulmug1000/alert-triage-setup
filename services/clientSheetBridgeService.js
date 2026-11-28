/**
 * ============================================================================
 * PULSE CLIENT SHEET BIDIRECTIONAL BRIDGE SERVICE (Phase 1)
 * ============================================================================
 * Enables Supabase-primary execution (`client_mode = 'supabase'`) while keeping
 * an editable Google Client Sheet bidirectionally synchronized with:
 * - Zero synchronous Google Sheets latency on PMA / Triage / Sync saves
 * - 3-way cell & note merge against a per-revision baseline (human Sheet wins conflicts)
 * - Strict formula-cell & formula-column protection on outbound writes
 * - Echo-free Google Drive `version` tracking (no GAS trigger changes needed)
 * - Full `dry_run` preview mode & instant rollback to `sheet` mode
 * ============================================================================
 */

import { waitUntil } from "@vercel/functions";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import {
  withRetry,
  getSheetGid,
  sanitizeFormulaInput,
  getPrimaryRawGoogleClients,
} from "./sheetsClient.js";
import {
  resolveSupabaseSheetContext,
  invalidateMasterEngineCache,
  invalidateSheetContextCache,
  saveVirtualTabGrid_,
  getOrLoadVirtualTabGrid_,
  recomputeClientFormulasForBridge,
  flushPendingClientRecomputes,
  isVirtualSupabaseSheetId,
  colIdx0ToLetter,
  getTabWriteRevision_,
  getLastClientEditTimestamp,
  CORE_CLIENT_TABS,
} from "./masterEngineService.js";
import { isCashCellEditable } from "./cashEditService.js";
import { redisClient } from "./redisClient.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import { verifyRelationalJobsParity } from "./relationalJobsService.js";
import { verifyRelationalInputsParity } from "./relationalInputsService.js";
import { isJobCostingStyle, toSheetDateFormat } from "../utils/helpers.js";

export const BRIDGE_BIDIRECTIONAL_TABS = [
  "Confirmed",
  "Pipeline",
  "Outgoings",
  "Salaries",
  "Budget",
  "NBtoFind",
  "Cash",
];
export const BRIDGE_OUTBOUND_ONLY_TABS = ["KeyInfo", "Delivered"];
export const BRIDGE_ALL_SYNCED_TABS = [...BRIDGE_BIDIRECTIONAL_TABS, ...BRIDGE_OUTBOUND_ONLY_TABS];
export const BRIDGE_NOTE_TABS = new Set([
  "Confirmed",
  "Pipeline",
  "Outgoings",
  "Cash",
  "Salaries",
  "NBtoFind",
  "Budget",
]);

const BRIDGE_BIDIRECTIONAL_TAB_SET = new Set(BRIDGE_BIDIRECTIONAL_TABS);
const BRIDGE_OUTBOUND_ONLY_SET = new Set(BRIDGE_OUTBOUND_ONLY_TABS);
const BASELINE_TAB_NAME = "SheetBridgeBaseline";
const OUTBOUND_DEBOUNCE_MS = 1200;
const READ_CHECK_THROTTLE_MS = 15000;
const RECENT_LOG_LIMIT = 15;
const TEXT_ONLY_SLOT_COLS = new Set([42, 49, 56, 81, 88, 95]); // AQ, AX, BE, CD, CK, CR
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
let _baselinesTableCache = { checkedAt: 0, ready: null };
const _clearedLegacyBaselineClients = new Set();

function isMissingRelationErr_(err) {
  const msg = String(err?.message || err || "");
  const code = String(err?.code || "");
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /does not exist|schema cache|could not find the table/i.test(msg)
  );
}

export function resetSheetBridgeBaselinesTableCache() {
  _baselinesTableCache = { checkedAt: 0, ready: null };
}

async function isSheetBridgeBaselinesTableReady_(supabase) {
  if (!supabase) return false;
  const now = Date.now();
  const ttl = _baselinesTableCache.ready ? 300000 : 30000;
  if (_baselinesTableCache.ready !== null && now - _baselinesTableCache.checkedAt < ttl) {
    return _baselinesTableCache.ready;
  }
  try {
    const { error } = await supabase
      .from("pulse_sheet_bridge_baselines")
      .select("client_id")
      .limit(1);
    const ready = !error;
    _baselinesTableCache = { checkedAt: now, ready };
    return ready;
  } catch {
    _baselinesTableCache = { checkedAt: now, ready: false };
    return false;
  }
}
let _coreClientTabSet = null;
function getCoreClientTabSet_() {
  if (!_coreClientTabSet) {
    _coreClientTabSet = new Set([...CORE_CLIENT_TABS, "REF", "AppData", "FormCheck"]);
  }
  return _coreClientTabSet;
}

function getLastNonEmptyRowCount_(grid = []) {
  if (!Array.isArray(grid) || grid.length === 0) return 0;
  for (let r = grid.length - 1; r >= 0; r--) {
    const row = grid[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v !== "" && v !== null && v !== undefined) return r + 1;
    }
  }
  return 0;
}

const CURRENT_NOTE_BOUNDS_VERSION = 3;

function isNewlyAddedNoteCoordForMigration_(tabName, r0, c0, fromVer = 1) {
  const v = Number(fromVer || 1);
  if (v < 2) {
    if (tabName === "Outgoings" && r0 >= 112) return true;
    if (tabName === "Salaries" && c0 <= 8) return true;
    if (tabName === "NBtoFind" && r0 >= 2 && c0 >= 6 && c0 <= 47) return true;
    if (tabName === "Budget" && r0 <= 249 && c0 <= 47) return true;
  }
  if (v < 3) {
    if (tabName === "Confirmed" && (c0 === 0 || r0 >= 1000)) return true;
    if (tabName === "Pipeline" && (c0 === 0 || r0 >= 600)) return true;
    if (tabName === "Salaries" && c0 >= 9 && c0 <= 60) return true;
    if (tabName === "NBtoFind" && (r0 < 2 || c0 < 6 || (c0 >= 48 && c0 <= 49))) return true;
    if (tabName === "Budget" && (r0 === 250 || (c0 >= 48 && c0 <= 49))) return true;
  }
  return false;
}

function isCoordWithinFetchedNoteBounds_(tabName, r0, c0, fetchedNoteBounds = null) {
  const custom = fetchedNoteBounds && typeof fetchedNoteBounds === "object" ? fetchedNoteBounds[tabName] : null;
  if (custom) {
    const inRow = r0 >= Number(custom.startRow0 ?? 0) && r0 <= Number(custom.endRow0 ?? 100000);
    if (!inRow) return false;
    if (Array.isArray(custom.cols)) {
      return custom.cols.some(([sc, ec]) => c0 >= Number(sc) && c0 <= Number(ec));
    }
    return c0 >= Number(custom.startCol0 ?? 0) && c0 <= Number(custom.endCol0 ?? 1000);
  }
  if (tabName === "Outgoings") {
    return r0 >= 12 && r0 <= 239 && c0 >= 6 && c0 <= 47;
  }
  if (tabName === "Confirmed") {
    return r0 >= 1 && r0 <= 4999 && (c0 === 0 || (c0 >= 41 && c0 <= 95));
  }
  if (tabName === "Pipeline") {
    return r0 >= 1 && r0 <= 1499 && (c0 === 0 || (c0 >= 41 && c0 <= 95));
  }
  if (tabName === "Cash") {
    return r0 >= 0 && r0 <= 75 && c0 >= 1 && c0 <= 36;
  }
  if (tabName === "Salaries") {
    return r0 >= 3 && r0 <= 59 && c0 >= 0 && c0 <= 60;
  }
  if (tabName === "NBtoFind") {
    return r0 >= 0 && r0 <= 29 && c0 >= 0 && c0 <= 49;
  }
  if (tabName === "Budget") {
    return r0 >= 0 && r0 <= 250 && c0 >= 0 && c0 <= 49;
  }
  return true;
}

function formulaRefsExternalOrCustomTab_(formulaStr) {
  if (typeof formulaStr !== "string" || !formulaStr.startsWith("=")) return false;
  if (/IMPORTRANGE\s*\(/i.test(formulaStr)) return true;
  const stripped = formulaStr.replace(/"(?:""|[^"])*"/g, "");
  const coreTabs = getCoreClientTabSet_();
  const matches = stripped.matchAll(/(?:'([^']+)'|([A-Za-z0-9_]+))!/g);
  for (const m of matches) {
    const refTab = m[1] || m[2];
    if (refTab && !coreTabs.has(refTab)) return true;
  }
  return false;
}

function isOverridableJobCostingDefaultFormula_(tabName, col0, formulaStr, isJobCosting) {
  if (!isJobCosting || (tabName !== "Confirmed" && tabName !== "Pipeline") || col0 !== 10) {
    return false;
  }
  return (
    typeof formulaStr === "string" &&
    /^=\s*\$?M\$?\d+\s*\*\s*KeyInfo!\$?D\$?13\s*$/i.test(formulaStr.trim())
  );
}

const NOTE_FETCH_RANGES = {
  Outgoings: { range: "Outgoings!G13:AV240", startRow0: 12, endRow0: 239, startCol0: 6, endCol0: 47 },
  Confirmed: { range: "Confirmed!AP2:CR1000", startRow0: 1, endRow0: 999, cols: [[0, 0], [41, 95]] },
  Pipeline: { range: "Pipeline!AP2:CR600", startRow0: 1, endRow0: 599, cols: [[0, 0], [41, 95]] },
  Cash: { range: "Cash!B1:AK76", startRow0: 0, endRow0: 75, startCol0: 1, endCol0: 36 },
  Salaries: { range: "Salaries!A4:BI60", startRow0: 3, endRow0: 59, startCol0: 0, endCol0: 60 },
  NBtoFind: { range: "NBtoFind!A1:AX30", startRow0: 0, endRow0: 29, startCol0: 0, endCol0: 49 },
  Budget: { range: "Budget!A1:AX251", startRow0: 0, endRow0: 250, startCol0: 0, endCol0: 49 },
};

const _lastReadCheckByClient = new Map();
const _inFlightBridgeByClient = new Map();
const _pendingOutboundByClient = new Map();
const _pendingStructuralOpsByClient = new Map();
const _suppressOutboundByClient = new Set();
const STRUCT_OPS_REDIS_PREFIX = "pulse:sheet_bridge_struct_ops:";
const STRUCT_OPS_TTL_SECONDS = 86400;
const STRUCT_OPS_MAX_QUEUE = 500;

function normalizeKey_(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

function createSafeMap_() {
  return Object.create(null);
}

function parseNoteKey_(key) {
  if (!key || typeof key !== "string" || key.startsWith("__") || PROTOTYPE_KEYS.has(key)) {
    return null;
  }
  const colonIdx = key.indexOf(":");
  if (colonIdx <= 0) return null;
  const r0 = parseInt(key.slice(0, colonIdx), 10);
  const c0 = parseInt(key.slice(colonIdx + 1), 10);
  if (!Number.isFinite(r0) || !Number.isFinite(c0) || r0 < 0 || c0 < 0) return null;
  return { r0, c0 };
}

function trimRowTrailing_(row) {
  if (!Array.isArray(row)) return [];
  let end = row.length;
  while (end > 0) {
    const v = row[end - 1];
    if (v !== undefined && v !== null && v !== "") break;
    end--;
  }
  return row.slice(0, end);
}

function cloneSafeNotes_(notesObj) {
  const out = createSafeMap_();
  if (!notesObj || typeof notesObj !== "object") return out;
  for (const [k, v] of Object.entries(notesObj)) {
    const parsed = parseNoteKey_(k);
    if (!parsed) continue;
    const str = String(v ?? "");
    if (str) out[k] = str;
  }
  return out;
}

function clone2DGrid_(grid) {
  if (!Array.isArray(grid)) return [];
  return grid.map((r) => (Array.isArray(r) ? [...r] : []));
}

function compactBaselineTab_(valuesGrid, notesGrid) {
  const vals = Array.isArray(valuesGrid) ? valuesGrid : [];
  let lastNonEmptyRow = 0;
  const trimmedRows = new Array(vals.length);
  for (let r = 0; r < vals.length; r++) {
    const tr = trimRowTrailing_(vals[r]);
    trimmedRows[r] = tr;
    if (tr.length > 0) lastNonEmptyRow = r + 1;
  }
  return {
    values: trimmedRows.slice(0, lastNonEmptyRow),
    notes: cloneSafeNotes_(notesGrid),
  };
}

function normalizeSheetDateForCompare_(s) {
  const m = String(s || "")
    .trim()
    .match(/^0?(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const yr = m[3].length === 4 ? m[3].slice(-2) : m[3];
  return `${parseInt(m[1], 10)}-${m[2].toLowerCase()}-${yr}`;
}

function parseComparableNumber_(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (typeof val !== "string") return null;
  const s = val.trim();
  if (!s || s.startsWith("'")) return null;
  if (!/^[-+]?[£$€]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s)) return null;
  const cleaned = s.replace(/[£$€,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function areBridgeCellsEquivalent(a, b) {
  const normA = a === null || a === undefined ? "" : a;
  const normB = b === null || b === undefined ? "" : b;
  if (normA === normB) return true;
  if (normA === "" && normB === "") return true;

  const numA = parseComparableNumber_(normA);
  const numB = parseComparableNumber_(normB);
  if (numA !== null && numB !== null) {
    return Math.abs(numA - numB) < 1e-6;
  }

  // Serial Excel/Sheets date number vs formatted d-mmm-yy string
  if (typeof normA === "number" && normA >= 25000 && normA <= 80000 && typeof normB === "string") {
    const dStr = normalizeSheetDateForCompare_(toSheetDateFormat(normA));
    const bStr = normalizeSheetDateForCompare_(normB);
    if (dStr && bStr && dStr === bStr) return true;
  }
  if (typeof normB === "number" && normB >= 25000 && normB <= 80000 && typeof normA === "string") {
    const dStr = normalizeSheetDateForCompare_(toSheetDateFormat(normB));
    const aStr = normalizeSheetDateForCompare_(normA);
    if (dStr && aStr && dStr === aStr) return true;
  }
  if (typeof normA === "string" && typeof normB === "string") {
    const aDate = normalizeSheetDateForCompare_(normA);
    const bDate = normalizeSheetDateForCompare_(normB);
    if (aDate && bDate) return aDate === bDate;
  }

  return String(normA) === String(normB);
}

/**
 * Checks whether a cell coordinate is an editable user-input / Pulse-writable position
 * (independent of whether the Google Sheet currently holds a custom formula there).
 */
export function isCellInEditableBridgePosition(tabName, row0, col0, options = {}) {
  if (!Number.isInteger(row0) || !Number.isInteger(col0) || row0 < 0 || col0 < 0) {
    return false;
  }

  if (BRIDGE_BIDIRECTIONAL_TAB_SET.has(tabName) && row0 <= 0) {
    return false;
  }

  if (tabName === "Confirmed" || tabName === "Pipeline") {
    const revStart = tabName === "Confirmed" ? 62 : 60;
    if ((col0 >= revStart && col0 <= 74) || (col0 >= 96 && col0 <= 106) || col0 === 40) {
      return false;
    }
    const isJc = Boolean(
      options.isJobCosting !== undefined
        ? options.isJobCosting
        : options.headerRow
          ? isJobCostingStyle({ headers: options.headerRow })
          : false
    );
    if (isJc) {
      if (
        (col0 >= 12 && col0 <= 14) ||
        col0 === 20 ||
        (tabName === "Pipeline" && col0 === 24) ||
        col0 === 32 ||
        col0 === 33 ||
        col0 === 37 ||
        col0 === 38
      ) {
        return false;
      }
    } else {
      if ((col0 >= 5 && col0 <= 29 && !(tabName === "Confirmed" && col0 === 17)) || col0 === 31) {
        return false;
      }
    }
    return true;
  }

  if (tabName === "Outgoings") {
    // Master-pushed actual transaction JSON (Row 300 -> idx 299) and VAT actuals (Rows 304–305 -> idx 303..304)
    if (row0 === 299 || row0 === 303 || row0 === 304) {
      return col0 >= 0 && col0 <= 60;
    }
    // Never write Making up CoS formula row (111 -> idx 110), summary/total formula rows (115-116, 120-123, 233-237), or Recharged expenses system rows (225-226)
    if (
      row0 === 110 ||
      row0 === 114 ||
      row0 === 115 ||
      (row0 >= 119 && row0 <= 122) ||
      row0 === 224 ||
      row0 === 225 ||
      (row0 >= 232 && row0 <= 236)
    ) {
      return false;
    }
    const isAllowedRow =
      (row0 >= 12 && row0 <= 109) ||
      row0 === 111 ||
      row0 === 117 ||
      (row0 >= 125 && row0 <= 223);
    const isAllowedCol =
      (col0 >= 0 && col0 <= 5) ||
      (col0 >= 6 && col0 <= 17) ||
      (col0 >= 21 && col0 <= 32) ||
      (col0 >= 36 && col0 <= 47);
    return isAllowedRow && isAllowedCol;
  }

  if (tabName === "Cash") {
    return isCashCellEditable(row0 + 1, col0);
  }

  if (tabName === "KeyInfo") {
    if (row0 < 0 || row0 > 149 || col0 < 0 || col0 > 51) return false;
    if (row0 === 0 && col0 >= 2 && col0 <= 6) return false; // Preserve C1:G1 sheet pointers
    return true;
  }

  if (tabName === "OutgNotes") {
    // Only sync A1:AV111; never touch parser formula columns CH:HG
    return row0 >= 0 && row0 <= 110 && col0 >= 0 && col0 <= 47;
  }

  if (tabName === "Salaries") {
    // Only employee metadata (A4:I53 -> cols 0..8) and monthly actual payroll overrides (L4:JD53 -> cols 11..263) are editable.
    // Never touch summary formula rows (55..77), Forecast spill block (154..208, A154=={A4:I53}), or Effective spill block (304..362, A304=={A4:I53}, I360=={I73:JC75}).
    return row0 >= 3 && row0 <= 52 && ((col0 >= 0 && col0 <= 8) || (col0 >= 11 && col0 <= 263));
  }

  const isThreeYearMonthCol =
    (col0 >= 6 && col0 <= 17) || (col0 >= 21 && col0 <= 32) || (col0 >= 36 && col0 <= 47);

  if (tabName === "NBtoFind") {
    if (col0 === 0 && (row0 === 8 || row0 === 11 || row0 === 20)) return true;
    return isThreeYearMonthCol && (row0 === 2 || row0 === 4 || row0 === 9 || row0 === 24);
  }

  if (tabName === "Budget") {
    if ((row0 >= 4 && row0 <= 8) || (row0 >= 12 && row0 <= 16)) {
      return isThreeYearMonthCol;
    }
    if (row0 >= 58 && row0 <= 111) {
      return (col0 >= 0 && col0 <= 4) || isThreeYearMonthCol;
    }
    if (row0 === 118) {
      return col0 === 0 || col0 === 4 || isThreeYearMonthCol;
    }
    if (row0 >= 126 && row0 <= 140) {
      return col0 === 0 || col0 === 4 || isThreeYearMonthCol;
    }
    if (row0 === 141) {
      return col0 === 1;
    }
    if (row0 === 142) {
      return isThreeYearMonthCol;
    }
    if (row0 >= 149 && row0 <= 250) {
      return col0 === 0 || col0 === 4 || isThreeYearMonthCol;
    }
    return false;
  }

  if (tabName === "Delivered") {
    return row0 === 80 && col0 === 3;
  }

  return false;
}

/**
 * Hard cell-level and tab-level safety boundary ensuring outbound bridge writes
 * NEVER overwrite live Google Sheet formulas or calculated columns/rows.
 */
export function isCellAllowedForOutboundBridgeWrite(
  tabName,
  row0,
  col0,
  sheetFormulaCell,
  nextFormulaOrVal,
  options = {}
) {
  if (!isCellInEditableBridgePosition(tabName, row0, col0, options)) {
    return false;
  }

  const isSheetFormula = typeof sheetFormulaCell === "string" && sheetFormulaCell.trim().startsWith("=");
  const isNextFormula = typeof nextFormulaOrVal === "string" && nextFormulaOrVal.trim().startsWith("=");
  if (isSheetFormula && !isNextFormula && !options.allowOverrideEditableFormula) {
    const isJc = Boolean(
      options.isJobCosting !== undefined
        ? options.isJobCosting
        : options.headerRow
          ? isJobCostingStyle({ headers: options.headerRow })
          : false
    );
    if (!isOverridableJobCostingDefaultFormula_(tabName, col0, sheetFormulaCell, isJc)) {
      return false;
    }
  }

  return true;
}

function formatBridgeCellValueForSheet_(tabName, col0, val, { isFormula = false } = {}) {
  if (val === undefined || val === null) return "";
  if (isFormula && typeof val === "string" && val.trim().startsWith("=")) {
    return val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  const s = String(val);
  const isTextSlotTab = tabName === "Confirmed" || tabName === "Pipeline";
  if (isTextSlotTab && TEXT_ONLY_SLOT_COLS.has(col0)) {
    const trimmed = s.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("'")) return trimmed;
    const safe = sanitizeFormulaInput(trimmed);
    if (typeof safe === "string" && safe.startsWith("'")) return safe;
    if (/^\d+$/.test(String(safe))) return `'${safe}`;
    return safe;
  }
  return sanitizeFormulaInput(s);
}

/**
 * Groups dirty cells on the same row and adjacent columns into contiguous
 * Google Sheets A1 batchUpdate ranges so recalculations stay minimal.
 */
export function coalesceRowChangesToBatchRanges(tabName, cellChanges = []) {
  if (!Array.isArray(cellChanges) || cellChanges.length === 0) return [];
  const byRow = new Map();
  for (const ch of cellChanges) {
    if (!ch || !Number.isInteger(ch.row0) || !Number.isInteger(ch.col0)) continue;
    if (!byRow.has(ch.row0)) byRow.set(ch.row0, []);
    byRow.get(ch.row0).push(ch);
  }

  const rowNums = [...byRow.keys()].sort((a, b) => a - b);
  const ranges = [];
  for (const r0 of rowNums) {
    const rowChanges = byRow.get(r0).sort((a, b) => a.col0 - b.col0);
    let idx = 0;
    while (idx < rowChanges.length) {
      let endIdx = idx;
      while (
        endIdx + 1 < rowChanges.length &&
        rowChanges[endIdx + 1].col0 === rowChanges[endIdx].col0 + 1
      ) {
        endIdx++;
      }
      const startCol0 = rowChanges[idx].col0;
      const endCol0 = rowChanges[endIdx].col0;
      const rowValues = [];
      for (let p = idx; p <= endIdx; p++) {
        rowValues.push(
          formatBridgeCellValueForSheet_(tabName, rowChanges[p].col0, rowChanges[p].to, {
            isFormula: Boolean(rowChanges[p].isFormula),
          })
        );
      }
      const r1 = r0 + 1;
      const range =
        startCol0 === endCol0
          ? `${tabName}!${colIdx0ToLetter(startCol0)}${r1}`
          : `${tabName}!${colIdx0ToLetter(startCol0)}${r1}:${colIdx0ToLetter(endCol0)}${r1}`;
      ranges.push({ range, values: [rowValues] });
      idx = endIdx + 1;
    }
  }
  return ranges;
}

/**
 * Computes a 3-way cell & note merge between Google Sheet (human edits),
 * Supabase virtual grids (PMA/Triage/Sync edits), and the last-synced baseline.
 * On same-cell conflicts where both changed differently, human Sheet wins.
 */
export function computeThreeWayTabMerge({
  tabName,
  baselineValues = [],
  baselineNotes = {},
  sheetValues = [],
  sheetFormulas = [],
  sheetNotes = {},
  supaValues = [],
  supaFormulas = [],
  supaNotes = {},
  applyOutboundToBaseline = true,
  allowInbound = true,
  forceHealSheetDrift = false,
  supportsNotesOverride = null,
  fetchedNoteBounds = null,
  maxRowBound = null,
  baselineNoteBoundsVersion = CURRENT_NOTE_BOUNDS_VERSION,
}) {
  const isOutboundOnly = !allowInbound || BRIDGE_OUTBOUND_ONLY_SET.has(tabName);
  const effectiveForceHeal =
    Boolean(forceHealSheetDrift) && !allowInbound && !BRIDGE_OUTBOUND_ONLY_SET.has(tabName);
  const supportsNotes =
    supportsNotesOverride !== null && supportsNotesOverride !== undefined
      ? Boolean(supportsNotesOverride) && BRIDGE_NOTE_TABS.has(tabName)
      : BRIDGE_NOTE_TABS.has(tabName);

  const headerRow =
    (Array.isArray(sheetFormulas?.[0]) && sheetFormulas[0].length > 0 ? sheetFormulas[0] : null) ||
    (Array.isArray(sheetValues?.[0]) && sheetValues[0].length > 0 ? sheetValues[0] : null) ||
    supaValues?.[0] ||
    [];
  const isJobCosting =
    tabName === "Confirmed" || tabName === "Pipeline"
      ? isJobCostingStyle({ headers: headerRow })
      : false;

  const maxRows = Math.max(baselineValues.length, sheetValues.length, supaValues.length);
  const supaActiveRows = getLastNonEmptyRowCount_(supaValues);
  const effectiveBound =
    Number.isInteger(maxRowBound) && maxRowBound > 0 ? Math.max(maxRowBound, supaActiveRows) : maxRows;
  const scanRows = Number.isInteger(effectiveBound) && effectiveBound > 0 ? Math.min(maxRows, effectiveBound) : maxRows;
  const mergedValues = clone2DGrid_(supaValues);
  const mergedFormulas = clone2DGrid_(supaFormulas?.length ? supaFormulas : supaValues);
  while (mergedValues.length < scanRows) mergedValues.push([]);
  while (mergedFormulas.length < scanRows) mergedFormulas.push([]);

  const nextBaselineValues = [];
  const inboundCellChanges = [];
  const outboundCellChanges = [];
  const conflicts = [];
  let formulaCellsProtectedCount = 0;

  for (let r = 0; r < scanRows; r++) {
    const bRow = Array.isArray(baselineValues[r]) ? baselineValues[r] : [];
    const sRow = Array.isArray(sheetValues[r]) ? sheetValues[r] : [];
    const sfRow = Array.isArray(sheetFormulas[r]) ? sheetFormulas[r] : [];
    const uRow = Array.isArray(supaValues[r]) ? supaValues[r] : [];
    const ufRow = Array.isArray(supaFormulas[r]) ? supaFormulas[r] : [];
    const maxCols = Math.max(bRow.length, sRow.length, sfRow.length, uRow.length, ufRow.length);

    if (!mergedValues[r]) mergedValues[r] = [];
    if (!mergedFormulas[r]) mergedFormulas[r] = [];
    const nextBaseRow = new Array(maxCols).fill("");

    for (let c = 0; c < maxCols; c++) {
      const baseVal = bRow[c] ?? "";
      const sheetVal = sRow[c] ?? "";
      const sheetForm = sfRow[c] ?? "";
      const supaVal = uRow[c] ?? "";
      const supaForm = ufRow[c] ?? "";

      const isSheetFormula = typeof sheetForm === "string" && sheetForm.trim().startsWith("=");
      const isSupaFormula = typeof supaForm === "string" && supaForm.trim().startsWith("=");
      const isEditablePos = isCellInEditableBridgePosition(tabName, r, c, {
        isJobCosting,
        headerRow,
      });
      const isSystemFormulaCell = isSheetFormula && !isEditablePos;
      const isExternalSheetFormula = isSheetFormula && formulaRefsExternalOrCustomTab_(sheetForm);
      const isSheetErrorVal = typeof sheetVal === "string" && sheetVal.trim().startsWith("#");
      const isSupaErrorVal = typeof supaVal === "string" && supaVal.trim().startsWith("#");

      const isPureFormulaRecalcDrift =
        isSheetFormula &&
        String(sheetForm) === String(supaForm || "") &&
        (isSystemFormulaCell ||
          (!isExternalSheetFormula &&
            (areBridgeCellsEquivalent(sheetVal, supaVal) || (isSheetErrorVal && isSupaErrorVal))));

      const didSupaEditFormula =
        isEditablePos &&
        isSupaFormula &&
        String(supaForm) !== String(sheetForm || "") &&
        !areBridgeCellsEquivalent(supaVal, baseVal) &&
        areBridgeCellsEquivalent(sheetVal, baseVal);

      const didSupaOverrideDefaultFormula =
        isEditablePos &&
        !isSupaFormula &&
        isOverridableJobCostingDefaultFormula_(tabName, c, sheetForm, isJobCosting) &&
        !areBridgeCellsEquivalent(supaVal, baseVal) &&
        areBridgeCellsEquivalent(sheetVal, baseVal);

      const didSupaOverrideEditableFormula =
        isEditablePos &&
        isSheetFormula &&
        !isExternalSheetFormula &&
        !isSupaFormula &&
        !areBridgeCellsEquivalent(supaVal, baseVal) &&
        areBridgeCellsEquivalent(sheetVal, baseVal);

      const isIdenticalLocalFormulaRecalc =
        isEditablePos &&
        isSheetFormula &&
        isSupaFormula &&
        !isExternalSheetFormula &&
        String(sheetForm) === String(supaForm || "") &&
        areBridgeCellsEquivalent(sheetVal, baseVal);

      const editableSheetFormulaNeedsPull =
        !isOutboundOnly &&
        isEditablePos &&
        isSheetFormula &&
        !isSheetErrorVal &&
        !didSupaEditFormula &&
        !didSupaOverrideDefaultFormula &&
        !didSupaOverrideEditableFormula &&
        !isIdenticalLocalFormulaRecalc &&
        (!areBridgeCellsEquivalent(sheetVal, supaVal) || String(sheetForm) !== String(supaForm || ""));

      const editableSheetClearedFormula =
        !isOutboundOnly &&
        isEditablePos &&
        !isSheetFormula &&
        isSupaFormula &&
        !didSupaEditFormula &&
        areBridgeCellsEquivalent(sheetVal, baseVal);

      const inChanged =
        !isOutboundOnly &&
        isEditablePos &&
        (editableSheetFormulaNeedsPull ||
          editableSheetClearedFormula ||
          (!isPureFormulaRecalcDrift && !areBridgeCellsEquivalent(sheetVal, baseVal)));

      const unpulledHumanSheetEdit =
        !allowInbound &&
        !BRIDGE_OUTBOUND_ONLY_SET.has(tabName) &&
        isEditablePos &&
        !areBridgeCellsEquivalent(sheetVal, baseVal) &&
        areBridgeCellsEquivalent(supaVal, baseVal);

      const outChanged =
        !isPureFormulaRecalcDrift &&
        !unpulledHumanSheetEdit &&
        !(
          isEditablePos &&
          isSheetFormula &&
          !didSupaEditFormula &&
          !didSupaOverrideDefaultFormula &&
          !didSupaOverrideEditableFormula
        ) &&
        (!areBridgeCellsEquivalent(supaVal, baseVal) ||
          (effectiveForceHeal && !areBridgeCellsEquivalent(supaVal, sheetVal)));

      if (inChanged && outChanged) {
        if (areBridgeCellsEquivalent(sheetVal, supaVal)) {
          nextBaseRow[c] = sheetVal;
          continue;
        }
        // Conflict on the exact same cell -> human Google Sheet edit wins
        conflicts.push({
          tabName,
          cellA1: `${colIdx0ToLetter(c)}${r + 1}`,
          row0: r,
          col0: c,
          sheetVal,
          supaVal,
        });
        mergedValues[r][c] = sheetVal;
        mergedFormulas[r][c] = isSheetFormula ? sheetForm : sheetVal;
        nextBaseRow[c] = sheetVal;
        inboundCellChanges.push({
          tabName,
          row0: r,
          col0: c,
          cellA1: `${colIdx0ToLetter(c)}${r + 1}`,
          from: supaVal,
          to: sheetVal,
          conflictWinner: "sheet",
        });
      } else if (inChanged) {
        mergedValues[r][c] = sheetVal;
        mergedFormulas[r][c] = isSheetFormula ? sheetForm : sheetVal;
        nextBaseRow[c] = sheetVal;
        inboundCellChanges.push({
          tabName,
          row0: r,
          col0: c,
          cellA1: `${colIdx0ToLetter(c)}${r + 1}`,
          from: baseVal,
          to: sheetVal,
        });
      } else if (outChanged) {
        const nextCandidate =
          typeof supaForm === "string" && supaForm.trim().startsWith("=") ? supaForm : supaVal;
        const allowed = isCellAllowedForOutboundBridgeWrite(tabName, r, c, sheetForm, nextCandidate, {
          isJobCosting,
          headerRow,
          allowOverrideEditableFormula: didSupaOverrideEditableFormula,
        });
        if (!allowed) {
          if (isSheetFormula) formulaCellsProtectedCount++;
          // Keep Google Sheet formula cell intact in baseline
          nextBaseRow[c] = baseVal;
        } else {
          const isAllowedFormula =
            typeof supaForm === "string" && supaForm.trim().startsWith("=");
          outboundCellChanges.push({
            tabName,
            row0: r,
            col0: c,
            cellA1: `${colIdx0ToLetter(c)}${r + 1}`,
            from: sheetVal,
            to: isAllowedFormula ? supaForm : supaVal,
            isFormula: isAllowedFormula,
          });
          nextBaseRow[c] = applyOutboundToBaseline ? supaVal : baseVal;
        }
      } else {
        nextBaseRow[c] = baseVal;
      }
    }

    const trimmedBase = trimRowTrailing_(nextBaseRow);
    nextBaselineValues.push(trimmedBase);
  }

  // 3-way Note diffing for note-bearing tabs
  const safeBaseNotes = supportsNotes ? cloneSafeNotes_(baselineNotes) : createSafeMap_();
  const safeSheetNotes = supportsNotes ? cloneSafeNotes_(sheetNotes) : createSafeMap_();
  const safeSupaNotes = supportsNotes ? cloneSafeNotes_(supaNotes) : createSafeMap_();
  const mergedNotes = cloneSafeNotes_(supaNotes);
  const nextBaselineNotes = supportsNotes ? createSafeMap_() : cloneSafeNotes_(baselineNotes);
  const inboundNoteChanges = [];
  const outboundNoteChanges = [];

  if (supportsNotes) {
    const allNoteKeys = new Set([
      ...Object.keys(safeBaseNotes),
      ...Object.keys(safeSheetNotes),
      ...Object.keys(safeSupaNotes),
    ]);
    for (const k of allNoteKeys) {
      const coords = parseNoteKey_(k);
      if (!coords) continue;
      // Preserve untouched notes outside fetched Sheet ranges (e.g. Confirmed/Pipeline cols A:AO)
      if (!isCoordWithinFetchedNoteBounds_(tabName, coords.r0, coords.c0, fetchedNoteBounds)) {
        if (safeSupaNotes[k]) nextBaselineNotes[k] = safeSupaNotes[k];
        continue;
      }
      // One-time note-bounds migration (v1 -> v2 -> v3): treat previously un-fetched note ranges as blank baseline so existing PMA notes push outbound without false deletions, while preserving genuine deletions when baseline already matches sheet
      const rawBaseNote = safeBaseNotes[k] || "";
      const sN = safeSheetNotes[k] || "";
      const uN = safeSupaNotes[k] || "";
      const isMigCoord =
        baselineNoteBoundsVersion < CURRENT_NOTE_BOUNDS_VERSION &&
        isNewlyAddedNoteCoordForMigration_(tabName, coords.r0, coords.c0, baselineNoteBoundsVersion);
      const bN =
        isMigCoord && (rawBaseNote === "" || (sN === "" && uN !== ""))
          ? ""
          : rawBaseNote;
      const unpulledNoteEdit = !allowInbound && sN !== bN && uN === bN;
      const inNoteChanged = !isOutboundOnly && sN !== bN;
      const outNoteChanged =
        !unpulledNoteEdit && (effectiveForceHeal ? uN !== bN || uN !== sN : uN !== bN);
      const cellA1 = `${colIdx0ToLetter(coords.c0)}${coords.r0 + 1}`;

      if (inNoteChanged && outNoteChanged) {
        if (sN === uN) {
          if (sN) nextBaselineNotes[k] = sN;
        } else {
          conflicts.push({ tabName, cellA1, row0: coords.r0, col0: coords.c0, isNote: true, sheetVal: sN, supaVal: uN });
          if (sN) mergedNotes[k] = sN;
          else delete mergedNotes[k];
          if (sN) nextBaselineNotes[k] = sN;
          inboundNoteChanges.push({ tabName, row0: coords.r0, col0: coords.c0, cellA1, from: uN, to: sN, conflictWinner: "sheet" });
        }
      } else if (inNoteChanged) {
        if (sN) mergedNotes[k] = sN;
        else delete mergedNotes[k];
        if (sN) nextBaselineNotes[k] = sN;
        inboundNoteChanges.push({ tabName, row0: coords.r0, col0: coords.c0, cellA1, from: bN, to: sN });
      } else if (outNoteChanged) {
        if (uN === sN) {
          const keptNote = applyOutboundToBaseline ? uN : bN;
          if (keptNote) nextBaselineNotes[k] = keptNote;
        } else {
          outboundNoteChanges.push({ tabName, row0: coords.r0, col0: coords.c0, cellA1, from: sN, to: uN });
          const keptNote = applyOutboundToBaseline ? uN : bN;
          if (keptNote) nextBaselineNotes[k] = keptNote;
        }
      } else if (bN) {
        nextBaselineNotes[k] = bN;
      }
    }
  }

  // Copy non-coordinate metadata keys from supaNotes (if any) back safely without touching __proto__
  if (supaNotes && typeof supaNotes === "object") {
    for (const [k, v] of Object.entries(supaNotes)) {
      if (k.startsWith("__") && !PROTOTYPE_KEYS.has(k) && k !== "__formulas_grid" && k !== "__compact_meta") {
        mergedNotes[k] = v;
      }
    }
  }

  return {
    tabName,
    mergedValues,
    mergedFormulas,
    mergedNotes,
    nextBaselineValues,
    nextBaselineNotes,
    inboundCellChanges,
    outboundCellChanges,
    inboundNoteChanges,
    outboundNoteChanges,
    conflicts,
    formulaCellsProtectedCount,
  };
}

const DATE_COL_INDICES_CONF_PIPE = new Set([3, 37, 38, 43, 50, 57, 76, 83, 90]);
const MONEY_COL_INDICES_CONF_PIPE = new Set([17, 32, 33, 41, 48, 55, 75, 82, 89]);
const SHORT_HEADER_MAP = [
  [/^revenue\b/i, "Revenue"],
  [/^direct costs\b/i, "Direct costs"],
  [/\bsent date\b|\bsend date\b/i, "Sent date"],
  [/\bstart date\b/i, "Start date"],
  [/\bend date\b/i, "End date"],
  [/likelihood/i, "Likelihood"],
  [/date added/i, "Date added"],
  [/crm id|deal id/i, "CRM ID"],
];

function getColumnFieldLabel_(tabName, col0, supaValues = [], sheetValues = [], isNote = false) {
  let hdr = "";
  const candidateRows =
    tabName === "Outgoings"
      ? [11, 0]
      : tabName === "Cash"
        ? [2, 0]
        : [0];
  for (const rIdx of candidateRows) {
    const raw = supaValues?.[rIdx]?.[col0] ?? sheetValues?.[rIdx]?.[col0] ?? "";
    if (raw !== "" && raw !== null && raw !== undefined) {
      hdr = raw;
      break;
    }
  }

  let label = "";
  if (typeof hdr === "number" && hdr >= 30000 && hdr <= 75000) {
    const d = toSheetDateFormat(hdr);
    const m = String(d || "").match(/^\d{1,2}-([A-Za-z]{3}-\d{2})$/);
    label = m ? m[1] : String(d || `Col ${colIdx0ToLetter(col0)}`);
  } else {
    const clean = String(hdr || "").replace(/\s+/g, " ").trim();
    if (clean) {
      const matched = SHORT_HEADER_MAP.find(([rx]) => rx.test(clean));
      label = matched ? matched[1] : clean.length > 26 ? `${clean.slice(0, 24).trimEnd()}…` : clean;
    } else {
      label = `Col ${colIdx0ToLetter(col0)}`;
    }
  }
  return isNote ? `${label} (note)` : label;
}

function getRowContextLabel_(tabName, row0, supaValues = [], sheetValues = []) {
  const sRow = Array.isArray(supaValues?.[row0]) ? supaValues[row0] : [];
  const gRow = Array.isArray(sheetValues?.[row0]) ? sheetValues[row0] : [];
  if (tabName === "Confirmed" || tabName === "Pipeline") {
    const client = String(sRow[0] || gRow[0] || "").trim();
    const job = String(sRow[1] || gRow[1] || "").trim();
    if (client && job) return `Row ${row0 + 1} (${client} — ${job})`;
    if (client || job) return `Row ${row0 + 1} (${client || job})`;
    return `Row ${row0 + 1}`;
  }
  if (
    tabName === "Outgoings" ||
    tabName === "Salaries" ||
    tabName === "Budget" ||
    tabName === "NBtoFind"
  ) {
    for (let c = 0; c <= 4; c++) {
      const v = String(sRow[c] || gRow[c] || "").trim();
      if (v && Number.isNaN(Number(v))) {
        return `Row ${row0 + 1} (${v.length > 34 ? `${v.slice(0, 32)}…` : v})`;
      }
    }
    return `Row ${row0 + 1}`;
  }
  if (tabName === "Cash") {
    const lbl = String(sRow[1] || gRow[1] || sRow[0] || gRow[0] || "").trim();
    return lbl ? `Row ${row0 + 1} (${lbl})` : `Row ${row0 + 1}`;
  }
  if (tabName === "KeyInfo") {
    const lbl = String(sRow[0] || gRow[0] || "").trim();
    return lbl ? `Row ${row0 + 1} (${lbl})` : `Row ${row0 + 1}`;
  }
  return `Row ${row0 + 1}`;
}

function formatHumanDiffVal_(val, { tabName, col0, fieldLabel = "", isNote = false } = {}) {
  if (val === "" || val === null || val === undefined) return "blank";

  const isConfPipe = tabName === "Confirmed" || tabName === "Pipeline";
  if ((isConfPipe && col0 === 39) || /likelihood/i.test(fieldLabel)) {
    const num = typeof val === "number" ? val : Number(val);
    if (Number.isFinite(num) && num >= 0 && num <= 1) {
      return `${Math.round(num * 100)}%`;
    }
  }

  if ((isConfPipe && DATE_COL_INDICES_CONF_PIPE.has(col0)) || /date/i.test(fieldLabel)) {
    if (typeof val === "number" && val >= 25000 && val <= 80000) {
      return toSheetDateFormat(val);
    }
  }

  const isMoneyCol =
    (isConfPipe && MONEY_COL_INDICES_CONF_PIPE.has(col0)) ||
    ((tabName === "Outgoings" ||
      tabName === "Budget" ||
      tabName === "Salaries" ||
      tabName === "NBtoFind") &&
      col0 >= 6) ||
    (tabName === "Cash" && col0 >= 2);
  if (!isNote && isMoneyCol && typeof val === "number" && Number.isFinite(val)) {
    const sign = val < 0 ? "-" : "";
    const abs = Math.abs(val);
    return `${sign}£${abs.toLocaleString("en-GB", {
      minimumFractionDigits: Number.isInteger(abs) ? 0 : 2,
      maximumFractionDigits: 2,
    })}`;
  }

  const s = String(val).replace(/\s+/g, " ").trim();
  if (!s) return "blank";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) {
    return `${s.slice(0, 8)}…`;
  }
  if (s.length > 36) {
    return `${s.slice(0, 34).trimEnd()}…`;
  }
  return s;
}

/**
 * Formats raw cell/note bridge diffs into grouped, human-readable per-row
 * summaries (translating column letters, Excel serial dates, likelihoods, and GBP amounts).
 */
export function buildHumanReadableBridgeRows(diffs = [], tabGridsMap = {}, directionLabel = "Supabase → Sheet", maxRows = 10) {
  if (!Array.isArray(diffs) || diffs.length === 0) {
    return { totalRowsChanged: 0, items: [] };
  }

  const rowGroups = new Map();
  for (const d of diffs) {
    if (!d || !d.tabName || !Number.isInteger(d.row0) || !Number.isInteger(d.col0)) continue;
    const gKey = `${d.tabName}::${d.row0}`;
    if (!rowGroups.has(gKey)) {
      rowGroups.set(gKey, { tabName: d.tabName, row0: d.row0, diffs: [] });
    }
    rowGroups.get(gKey).diffs.push(d);
  }

  const items = [];
  for (const group of rowGroups.values()) {
    if (items.length >= maxRows) break;
    const grids = tabGridsMap?.[group.tabName] || {};
    const supaValues = grids.supaValues || [];
    const sheetValues = grids.sheetValues || [];
    const rowLabel = getRowContextLabel_(group.tabName, group.row0, supaValues, sheetValues);

    const enriched = group.diffs.map((d) => {
      const isNote = d.isNote !== undefined ? Boolean(d.isNote) : d.from === undefined && d.to === undefined ? false : false;
      const fieldLabel = getColumnFieldLabel_(group.tabName, d.col0, supaValues, sheetValues, isNote);
      const isCrmId = (group.tabName === "Confirmed" || group.tabName === "Pipeline") && d.col0 === 2;
      return {
        d,
        fieldLabel,
        isNote,
        isCrmId,
      };
    });

    enriched.sort((a, b) => {
      if (a.isCrmId !== b.isCrmId) return a.isCrmId ? 1 : -1;
      return a.d.col0 - b.d.col0;
    });

    const shown = enriched.slice(0, 5).map(({ d, fieldLabel, isNote }) => {
      const fromStr = formatHumanDiffVal_(d.from, { tabName: group.tabName, col0: d.col0, fieldLabel, isNote });
      const toStr = formatHumanDiffVal_(d.to, { tabName: group.tabName, col0: d.col0, fieldLabel, isNote });
      return `${fieldLabel}: ${fromStr} → ${toStr}`;
    });

    items.push({
      directionLabel,
      tab: group.tabName,
      rowLabel,
      changesText: shown.join(", "),
      moreCount: Math.max(0, enriched.length - 5),
    });
  }

  return {
    totalRowsChanged: rowGroups.size,
    items,
  };
}

/**
 * Mirrors Outgoings outbound note updates into OutgNotes!A1:AV111 with the exact
 * formula escaping used in client-GAS-scripts/Code.gs (line 575), leaving parser
 * columns OutgNotes!CH:HG completely untouched.
 */
export function buildOutgNotesMirrorUpdates(outboundOutgoingsNoteChanges = [], currentOutgNotesValues = []) {
  const cellChanges = [];
  for (const ch of outboundOutgoingsNoteChanges) {
    if (!ch || !Number.isInteger(ch.row0) || !Number.isInteger(ch.col0)) continue;
    if (ch.row0 < 0 || ch.row0 > 110 || ch.col0 < 0 || ch.col0 > 47) continue;
    const rawNote = String(ch.to ?? "");
    const safeNote = rawNote
      ? (/^[\s'’]*[=+\-@]/.test(rawNote) ? `'${rawNote.replace(/^[\s'’]+/, "")}` : rawNote)
      : "";
    const curVal = String(currentOutgNotesValues?.[ch.row0]?.[ch.col0] ?? "");
    if (safeNote !== curVal) {
      cellChanges.push({
        tabName: "OutgNotes",
        row0: ch.row0,
        col0: ch.col0,
        cellA1: `${colIdx0ToLetter(ch.col0)}${ch.row0 + 1}`,
        from: curVal,
        to: safeNote,
        isFormula: false,
      });
    }
  }
  return coalesceRowChangesToBatchRanges("OutgNotes", cellChanges);
}

function buildUpdateCellsNoteRequests_(gid, noteChanges = []) {
  if (gid === null || gid === undefined || !Array.isArray(noteChanges) || noteChanges.length === 0) {
    return [];
  }
  const byRow = new Map();
  for (const n of noteChanges) {
    if (!n || !Number.isInteger(n.row0) || !Number.isInteger(n.col0)) continue;
    if (!byRow.has(n.row0)) byRow.set(n.row0, []);
    byRow.get(n.row0).push(n);
  }
  const requests = [];
  const sortedRows = [...byRow.keys()].sort((a, b) => a - b);
  for (const r0 of sortedRows) {
    const rowItems = byRow.get(r0).sort((a, b) => a.col0 - b.col0);
    let runStartCol = null;
    let runEndCol = null;
    let runNotes = [];
    const flushRun = () => {
      if (runStartCol === null) return;
      requests.push({
        updateCells: {
          range: {
            sheetId: gid,
            startRowIndex: r0,
            endRowIndex: r0 + 1,
            startColumnIndex: runStartCol,
            endColumnIndex: runEndCol,
          },
          rows: [{ values: runNotes.map((txt) => ({ note: txt })) }],
          fields: "note",
        },
      });
      runStartCol = null;
      runEndCol = null;
      runNotes = [];
    };
    for (const item of rowItems) {
      const txt = String(item.to ?? "");
      if (runStartCol === null) {
        runStartCol = item.col0;
        runEndCol = item.col0 + 1;
        runNotes = [txt];
      } else if (item.col0 === runEndCol) {
        runEndCol = item.col0 + 1;
        runNotes.push(txt);
      } else {
        flushRun();
        runStartCol = item.col0;
        runEndCol = item.col0 + 1;
        runNotes = [txt];
      }
    }
    flushRun();
  }
  return requests;
}

async function fetchDriveVersionMeta_(rawDrive, spreadsheetId) {
  const resp = await withRetry(() =>
    rawDrive.files.get({
      fileId: spreadsheetId,
      fields: "version,modifiedTime,lastModifyingUser(emailAddress,displayName)",
      supportsAllDrives: true,
    })
  );
  const d = resp?.data || {};
  return {
    version: d.version !== undefined && d.version !== null ? String(d.version) : "",
    modifiedTime: String(d.modifiedTime || ""),
    lastModifyingEmail: String(d.lastModifyingUser?.emailAddress || "").trim().toLowerCase(),
    lastModifyingName: String(d.lastModifyingUser?.displayName || "").trim(),
  };
}

async function loadBaselineRecord_(supabase, ctx) {
  if (!supabase || !ctx?.clientName) return { driveVersion: "", updatedAt: null, tabs: createSafeMap_() };

  let baselinePayload = null;
  let updatedAt = null;
  const dedicatedReady = ctx.clientId ? await isSheetBridgeBaselinesTableReady_(supabase) : false;

  if (ctx.clientId && dedicatedReady) {
    try {
      const { data: dedData, error: dedErr } = await supabase
        .from("pulse_sheet_bridge_baselines")
        .select("drive_version, note_bounds_version, tabs, updated_at")
        .eq("client_id", ctx.clientId)
        .maybeSingle();
      if (!dedErr && dedData && typeof dedData.tabs === "object" && dedData.tabs !== null) {
        baselinePayload = {
          driveVersion: dedData.drive_version || "",
          noteBoundsVersion: dedData.note_bounds_version || CURRENT_NOTE_BOUNDS_VERSION,
          tabs: dedData.tabs,
          updatedAt: dedData.updated_at || null,
        };
        updatedAt = dedData.updated_at || null;
      } else if (dedErr && isMissingRelationErr_(dedErr)) {
        _baselinesTableCache = { checkedAt: Date.now(), ready: false };
      }
    } catch (_) { }
  }

  if (!baselinePayload && ctx.clientId) {
    try {
      const { data: cfgData, error: cfgErr } = await supabase
        .from("pulse_master_sync_configs")
        .select("sheet_bridge_baseline, updated_at")
        .eq("client_id", ctx.clientId)
        .maybeSingle();
      if (!cfgErr && cfgData?.sheet_bridge_baseline && typeof cfgData.sheet_bridge_baseline === "object") {
        baselinePayload = cfgData.sheet_bridge_baseline;
        updatedAt = cfgData.updated_at || null;
      }
    } catch (_) { }
  }

  if (!baselinePayload && !ctx.gridStorageRetired) {
    const { data } = await supabase
      .from("master_sheet_grids")
      .select("notes_grid, updated_at")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .eq("tab_name", BASELINE_TAB_NAME)
      .maybeSingle();
    if (data?.notes_grid && typeof data.notes_grid === "object") {
      baselinePayload = data.notes_grid;
      updatedAt = data.updated_at || null;
    }
  }

  const ng = baselinePayload && typeof baselinePayload === "object" ? baselinePayload : {};
  const topNoteBoundsVer = Number(ng.noteBoundsVersion || 1);
  const tabsOut = createSafeMap_();
  if (ng.tabs && typeof ng.tabs === "object") {
    for (const [k, v] of Object.entries(ng.tabs)) {
      if (PROTOTYPE_KEYS.has(k) || !v || typeof v !== "object") continue;
      tabsOut[k] = {
        values: Array.isArray(v.values) ? v.values : [],
        notes: cloneSafeNotes_(v.notes),
        noteBoundsVersion: Number(v.noteBoundsVersion || topNoteBoundsVer),
      };
    }
  }
  return {
    driveVersion: String(ng.driveVersion || ""),
    updatedAt: ng.updatedAt || updatedAt || null,
    noteBoundsVersion: topNoteBoundsVer,
    tabs: tabsOut,
  };
}

async function saveBaselineRecord_(
  supabase,
  ctx,
  { driveVersion = "", tabs = {}, noteBoundsVersion = CURRENT_NOTE_BOUNDS_VERSION }
) {
  if (!supabase || !ctx?.clientName) return;
  const compactedTabs = createSafeMap_();
  for (const [tName, tObj] of Object.entries(tabs || {})) {
    if (PROTOTYPE_KEYS.has(tName) || !tObj) continue;
    const compacted = compactBaselineTab_(tObj.values || [], tObj.notes || {});
    compacted.noteBoundsVersion = Number(tObj.noteBoundsVersion || noteBoundsVersion || CURRENT_NOTE_BOUNDS_VERSION);
    compactedTabs[tName] = compacted;
  }

  const nowIso = new Date().toISOString();
  const cleanDriveVer = String(driveVersion || "");
  const cleanBoundsVer = Number(noteBoundsVersion || CURRENT_NOTE_BOUNDS_VERSION);

  if (ctx.clientId && (await isSheetBridgeBaselinesTableReady_(supabase))) {
    const { error: dedErr } = await supabase
      .from("pulse_sheet_bridge_baselines")
      .upsert(
        {
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          drive_version: cleanDriveVer,
          note_bounds_version: cleanBoundsVer,
          tabs: compactedTabs,
          updated_at: nowIso,
        },
        { onConflict: "client_id" }
      );
    if (!dedErr) {
      // Opportunistically clear legacy pulse_master_sync_configs JSONB blob once per client
      if (!_clearedLegacyBaselineClients.has(ctx.clientId)) {
        _clearedLegacyBaselineClients.add(ctx.clientId);
        try {
          await supabase
            .from("pulse_master_sync_configs")
            .update({ sheet_bridge_baseline: null })
            .eq("client_id", ctx.clientId)
            .not("sheet_bridge_baseline", "is", null);
        } catch (_) { }
      }
      return;
    }
    if (!isMissingRelationErr_(dedErr)) {
      throw new Error(`pulse_sheet_bridge_baselines upsert failed: ${dedErr.message}`);
    }
    _baselinesTableCache = { checkedAt: Date.now(), ready: false };
  }

  let prevMasterUpdatedAt = null;
  if (ctx.clientId) {
    const { data: curSyncMeta } = await supabase
      .from("pulse_master_sync_configs")
      .select("updated_at, baseline_at:sheet_bridge_baseline->>updatedAt, prev_master_at:sheet_bridge_baseline->>prevMasterUpdatedAt")
      .eq("client_id", ctx.clientId)
      .maybeSingle();
    if (curSyncMeta?.updated_at) {
      const uMs = Date.parse(curSyncMeta.updated_at) || 0;
      const bMs = curSyncMeta.baseline_at ? (Date.parse(curSyncMeta.baseline_at) || 0) : 0;
      if (!bMs || Math.abs(uMs - bMs) >= 10000) {
        prevMasterUpdatedAt = curSyncMeta.updated_at;
      } else {
        prevMasterUpdatedAt = curSyncMeta.prev_master_at || null;
      }
    }
  }

  const payload = {
    driveVersion: cleanDriveVer,
    updatedAt: nowIso,
    ...(prevMasterUpdatedAt ? { prevMasterUpdatedAt } : {}),
    noteBoundsVersion: cleanBoundsVer,
    tabs: compactedTabs,
  };

  if (ctx.clientId) {
    const { error: cfgErr } = await supabase
      .from("pulse_master_sync_configs")
      .upsert(
        {
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          sheet_bridge_baseline: payload,
        },
        { onConflict: "client_id" }
      );
    if (!cfgErr) return;
    if (ctx.gridStorageRetired) {
      throw new Error(`pulse_master_sync_configs baseline upsert failed: ${cfgErr.message}`);
    }
  }

  await supabase.from("master_sheet_grids").upsert(
    {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      sheet_role: "master",
      tab_name: BASELINE_TAB_NAME,
      values_grid: [],
      formulas_grid: [],
      notes_grid: payload,
      row_count: 0,
      col_count: 0,
      updated_at: payload.updatedAt,
    },
    { onConflict: "client_name,sheet_role,tab_name" }
  );
}

async function updateClientBridgeState_(supabase, clientName, patchState = {}, newLogEntry = null, overrideMode = undefined) {
  if (!supabase || !clientName) return null;
  const { data: curRow } = await supabase
    .from("clients")
    .select("id, metadata, client_mode")
    .eq("client_name", clientName)
    .maybeSingle();
  if (!curRow) return null;

  const curMeta = curRow.metadata && typeof curRow.metadata === "object" ? { ...curRow.metadata } : {};
  const curState =
    curMeta.sheet_bridge_state && typeof curMeta.sheet_bridge_state === "object"
      ? { ...curMeta.sheet_bridge_state }
      : {};

  let nextLogs = Array.isArray(curState.recentLogs) ? [...curState.recentLogs] : [];
  if (newLogEntry) {
    nextLogs = [newLogEntry, ...nextLogs].slice(0, RECENT_LOG_LIMIT);
  }

  const nextState = {
    ...curState,
    ...patchState,
    recentLogs: nextLogs,
  };
  const nextMeta = {
    ...curMeta,
    sheet_bridge_state: nextState,
  };
  if (overrideMode !== undefined) {
    nextMeta.sheet_bridge_mode = overrideMode;
  }

  await supabase
    .from("clients")
    .update({ metadata: nextMeta, updated_at: new Date().toISOString() })
    .eq("id", curRow.id);

  invalidateSheetContextCache();
  return nextMeta;
}

function findLastActiveJobRowCount_(grid = []) {
  if (!Array.isArray(grid) || grid.length === 0) return 0;
  for (let i = grid.length - 1; i >= 0; i--) {
    const r = grid[i];
    if (!r) continue;
    // Skip bottom summary/totals row (around row 1000 or row 5002 where A/B/C job metadata are empty)
    if (i >= 350 && !r[0] && !r[1] && !r[2]) continue;
    if (r[0] || r[1] || r[2] || r[17] || r[32] || r[33] || r[41] || r[42] || r[48] || r[55] || r[75] || r[82] || r[89]) {
      return i + 1;
    }
  }
  return 0;
}

async function fetchRealSheetTabsAndNotes_(
  rawSheets,
  spreadsheetId,
  tabNames,
  { minRowHorizonByTab = {} } = {}
) {
  const uniqueTabs = [...new Set(tabNames)].filter(Boolean);
  const probeConfigs = [];
  if (uniqueTabs.includes("Confirmed")) {
    probeConfigs.push(
      { tab: "Confirmed", kind: "main", range: "Confirmed!A1:C5000" },
      { tab: "Confirmed", kind: "slot", range: "Confirmed!AP1:AQ5000" },
      { tab: "Confirmed", kind: "slot", range: "Confirmed!BX1:BY5000" }
    );
  }
  if (uniqueTabs.includes("Pipeline")) {
    probeConfigs.push(
      { tab: "Pipeline", kind: "main", range: "Pipeline!A1:C1500" },
      { tab: "Pipeline", kind: "slot", range: "Pipeline!AP1:AQ1500" }
    );
  }

  const [metaResp, probeResp] = await Promise.all([
    withRetry(() =>
      rawSheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
      })
    ),
    probeConfigs.length > 0
      ? withRetry(() =>
        rawSheets.spreadsheets.values.batchGet({
          spreadsheetId,
          ranges: probeConfigs.map((p) => p.range),
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      ).catch(() => null)
      : Promise.resolve(null),
  ]);

  const sheetPropsByTitle = createSafeMap_();
  for (const s of metaResp?.data?.sheets || []) {
    const title = s?.properties?.title;
    if (title && !PROTOTYPE_KEYS.has(title)) {
      sheetPropsByTitle[title] = {
        sheetId: s.properties.sheetId,
        rowCount: Number(s.properties?.gridProperties?.rowCount || 1000),
        columnCount: Number(s.properties?.gridProperties?.columnCount || 120),
      };
    }
  }

  const probedLastByTab = createSafeMap_();
  if (probeResp?.data?.valueRanges) {
    const mainRowsByTab = createSafeMap_();
    probeConfigs.forEach((cfg, idx) => {
      if (cfg.kind === "main") {
        mainRowsByTab[cfg.tab] = probeResp.data.valueRanges[idx]?.values || [];
      }
    });
    probeConfigs.forEach((cfg, idx) => {
      const vals = probeResp.data.valueRanges[idx]?.values || [];
      const mainVals = mainRowsByTab[cfg.tab] || [];
      for (let i = vals.length - 1; i >= 0; i--) {
        const r = vals[i];
        if (!r || (!r[0] && !r[1] && !r[2])) continue;
        const mRow = mainVals[i] || [];
        if (i >= 350 && !mRow[0] && !mRow[1] && !mRow[2]) continue;
        probedLastByTab[cfg.tab] = Math.max(probedLastByTab[cfg.tab] || 0, i + 1);
        break;
      }
    });
  }

  const existingTabs = uniqueTabs.filter((t) => Boolean(sheetPropsByTitle[t]));
  const resultByTab = createSafeMap_();
  const boundedLimitByTab = createSafeMap_();
  const fetchRangeByTab = createSafeMap_();

  for (const tName of existingTabs) {
    if (tName === "Confirmed" || tName === "Pipeline") {
      const sheetRowCount = sheetPropsByTitle[tName].rowCount;
      const defaultFloor = tName === "Confirmed" ? 340 : 150;
      const boundedMaxRow = Math.min(
        sheetRowCount,
        Math.max(probedLastByTab[tName] || 0, Number(minRowHorizonByTab?.[tName] || 0), defaultFloor) + 30
      );
      boundedLimitByTab[tName] = boundedMaxRow;
      fetchRangeByTab[tName] = `'${tName}'!A1:DF${boundedMaxRow}`;
    } else {
      boundedLimitByTab[tName] = null;
      fetchRangeByTab[tName] = `'${tName}'`;
    }
  }

  const chunkSize = 8;
  const batches = [];
  for (let i = 0; i < existingTabs.length; i += chunkSize) {
    batches.push(existingTabs.slice(i, i + chunkSize));
  }

  const noteTabsPresent = existingTabs.filter((t) => Boolean(NOTE_FETCH_RANGES[t]));
  const fetchedNoteBoundsByTab = createSafeMap_();
  const noteRangesToFetch = [];
  for (const t of noteTabsPresent) {
    const rowCap = Number(sheetPropsByTitle[t]?.rowCount || 0) || 10000;
    if (t === "Confirmed") {
      const endRow1 = Math.min(boundedLimitByTab.Confirmed || 1000, rowCap);
      fetchedNoteBoundsByTab.Confirmed = {
        startRow0: 1,
        endRow0: endRow1 - 1,
        cols: [[0, 0], [41, 95]],
      };
      noteRangesToFetch.push(`'Confirmed'!A2:A${endRow1}`, `'Confirmed'!AP2:CR${endRow1}`);
    } else if (t === "Pipeline") {
      const endRow1 = Math.min(boundedLimitByTab.Pipeline || 600, rowCap);
      fetchedNoteBoundsByTab.Pipeline = {
        startRow0: 1,
        endRow0: endRow1 - 1,
        cols: [[0, 0], [41, 95]],
      };
      noteRangesToFetch.push(`'Pipeline'!A2:A${endRow1}`, `'Pipeline'!AP2:CR${endRow1}`);
    } else if (t === "Outgoings") {
      const endRow1 = Math.min(240, rowCap);
      fetchedNoteBoundsByTab.Outgoings = { startRow0: 12, endRow0: endRow1 - 1, startCol0: 6, endCol0: 47 };
      noteRangesToFetch.push(`'Outgoings'!G13:AV${endRow1}`);
    } else if (t === "Cash") {
      const endRow1 = Math.min(76, rowCap);
      fetchedNoteBoundsByTab.Cash = { startRow0: 0, endRow0: endRow1 - 1, startCol0: 1, endCol0: 36 };
      noteRangesToFetch.push(`'Cash'!B1:AK${endRow1}`);
    } else if (t === "Salaries") {
      const endRow1 = Math.min(60, rowCap);
      fetchedNoteBoundsByTab.Salaries = { startRow0: 3, endRow0: endRow1 - 1, startCol0: 0, endCol0: 60 };
      noteRangesToFetch.push(`'Salaries'!A4:BI${endRow1}`);
    } else if (t === "NBtoFind") {
      const endRow1 = Math.min(30, rowCap);
      fetchedNoteBoundsByTab.NBtoFind = { startRow0: 0, endRow0: endRow1 - 1, startCol0: 0, endCol0: 49 };
      noteRangesToFetch.push(`'NBtoFind'!A1:AX${endRow1}`);
    } else if (t === "Budget") {
      const endRow1 = Math.min(251, rowCap);
      fetchedNoteBoundsByTab.Budget = { startRow0: 0, endRow0: endRow1 - 1, startCol0: 0, endCol0: 49 };
      noteRangesToFetch.push(`'Budget'!A1:AX${endRow1}`);
    } else {
      noteRangesToFetch.push(NOTE_FETCH_RANGES[t].range);
    }
  }

  let notesFetchFailed = false;
  const [batchPairResults, noteResp] = await Promise.all([
    Promise.all(
      batches.map(async (batch) => {
        const ranges = batch.map((t) => fetchRangeByTab[t]);
        const [valResp, formResp] = await Promise.all([
          withRetry(() =>
            rawSheets.spreadsheets.values.batchGet({
              spreadsheetId,
              ranges,
              valueRenderOption: "UNFORMATTED_VALUE",
            })
          ),
          withRetry(() =>
            rawSheets.spreadsheets.values.batchGet({
              spreadsheetId,
              ranges,
              valueRenderOption: "FORMULA",
            })
          ),
        ]);
        return { batch, valResp, formResp };
      })
    ),
    noteRangesToFetch.length > 0
      ? withRetry(() =>
        rawSheets.spreadsheets.get({
          spreadsheetId,
          ranges: noteRangesToFetch,
          fields: "sheets(properties.title,data(startRow,startColumn,rowData.values.note))",
        })
      ).catch((noteErr) => {
        notesFetchFailed = true;
        console.warn("[clientSheetBridge] Note batch read warning:", noteErr.message);
        return null;
      })
      : Promise.resolve(null),
  ]);

  for (const { batch, valResp, formResp } of batchPairResults) {
    for (let j = 0; j < batch.length; j++) {
      const tName = batch[j];
      resultByTab[tName] = {
        sheetId: sheetPropsByTitle[tName].sheetId,
        rowCount: sheetPropsByTitle[tName].rowCount,
        scannedRowLimit: boundedLimitByTab[tName],
        values: valResp?.data?.valueRanges?.[j]?.values || [],
        formulas: formResp?.data?.valueRanges?.[j]?.values || [],
        notes: createSafeMap_(),
      };
    }
  }

  for (const sheetObj of noteResp?.data?.sheets || []) {
    const tName = sheetObj?.properties?.title;
    const cfg = NOTE_FETCH_RANGES[tName];
    if (!tName || !cfg || !resultByTab[tName]) continue;
    const notesOut = resultByTab[tName].notes || createSafeMap_();
    for (const gridData of sheetObj?.data || []) {
      const sR = Number(gridData?.startRow ?? cfg.startRow0 ?? 0);
      const sC = Number(gridData?.startColumn ?? cfg.startCol0 ?? 0);
      (gridData?.rowData || []).forEach((rowObj, rOff) => {
        (rowObj?.values || []).forEach((cellObj, cOff) => {
          if (cellObj?.note) {
            notesOut[`${sR + rOff}:${sC + cOff}`] = String(cellObj.note);
          }
        });
      });
    }
    resultByTab[tName].notes = notesOut;
  }

  return { sheetPropsByTitle, resultByTab, fetchedNoteBoundsByTab, notesFetchFailed };
}

/**
 * Seeds `SheetBridgeBaseline` right after `seedClientSheetToSupabase` so the
 * bridge always has an exact initial baseline matching the Google Sheet.
 */
export async function seedSheetBridgeBaselineFromSheetSeed(ctx, gridsByTab = {}) {
  try {
    if (!ctx?.clientName || !ctx?.clientSheetId || isVirtualSupabaseSheetId(ctx.clientSheetId)) return null;
    const supabase = getSupabaseAdmin();
    if (!supabase) return null;
    const { rawDrive } = getPrimaryRawGoogleClients();
    let driveVersion = "";
    let modifiedTime = "";
    if (rawDrive) {
      const meta = await fetchDriveVersionMeta_(rawDrive, ctx.clientSheetId).catch(() => null);
      if (meta) {
        driveVersion = meta.version;
        modifiedTime = meta.modifiedTime;
      }
    }
    const baselineTabs = createSafeMap_();
    for (const tName of BRIDGE_ALL_SYNCED_TABS) {
      const g = gridsByTab?.[tName];
      if (!g) continue;
      baselineTabs[tName] = {
        values: g.values || [],
        notes: g.notes || {},
        noteBoundsVersion: CURRENT_NOTE_BOUNDS_VERSION,
      };
    }
    await saveBaselineRecord_(supabase, ctx, {
      driveVersion,
      tabs: baselineTabs,
      noteBoundsVersion: CURRENT_NOTE_BOUNDS_VERSION,
    });
    await updateClientBridgeState_(supabase, ctx.clientName, {
      lastSyncedDriveVersion: driveVersion,
      lastSyncedModifiedTime: modifiedTime,
      lastError: "",
      lastSummary: `Baseline seeded (${Object.keys(baselineTabs).length} tabs${driveVersion ? `, Drive v${driveVersion}` : ""})`,
    });
    return { driveVersion, tabsCount: Object.keys(baselineTabs).length };
  } catch (err) {
    console.warn(`[clientSheetBridge] Baseline seed warning (${ctx?.clientName}):`, err.message);
    return null;
  }
}

/**
 * Records structural row/group batchUpdate requests executed on virtual client tabs
 * in process memory + Redis so cross-instance bridge flushes can replay them reliably.
 */
export async function recordBridgeStructuralRequests(clientName, requests = [], metaBySheetId = new Map()) {
  const key = normalizeKey_(clientName);
  if (!key || _suppressOutboundByClient.has(key) || !Array.isArray(requests) || requests.length === 0) {
    return;
  }
  const structuralOps = [];
  for (const req of requests) {
    if (!req || typeof req !== "object") continue;
    let srcSheetId = null;
    if (req.moveDimension?.source?.dimension === "ROWS") srcSheetId = req.moveDimension.source.sheetId;
    else if (req.insertDimension?.range?.dimension === "ROWS") srcSheetId = req.insertDimension.range.sheetId;
    else if (req.deleteDimension?.range?.dimension === "ROWS") srcSheetId = req.deleteDimension.range.sheetId;
    else if (req.addDimensionGroup?.range?.dimension === "ROWS") srcSheetId = req.addDimensionGroup.range.sheetId;
    else if (req.deleteDimensionGroup?.range?.dimension === "ROWS") srcSheetId = req.deleteDimensionGroup.range.sheetId;
    else if (req.updateDimensionGroup?.dimensionGroup?.range?.dimension === "ROWS") {
      srcSheetId = req.updateDimensionGroup.dimensionGroup.range.sheetId;
    } else if (req.updateDimensionProperties?.range?.dimension === "ROWS") {
      srcSheetId = req.updateDimensionProperties.range.sheetId;
    }
    if (srcSheetId === null) continue;
    const meta = metaBySheetId.get(srcSheetId);
    const tabName = meta?.tab_name;
    if (!tabName || (!BRIDGE_BIDIRECTIONAL_TAB_SET.has(tabName) && tabName !== "OutgNotes")) continue;
    structuralOps.push({
      opId: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      tabName,
      req: structuredClone(req),
    });
  }
  if (structuralOps.length > 0) {
    const memOps = structuralOps.map((op) => ({ ...op, persistedToRedis: false }));
    const prev = _pendingStructuralOpsByClient.get(key) || [];
    const merged = [...prev, ...memOps].slice(-STRUCT_OPS_MAX_QUEUE);
    _pendingStructuralOpsByClient.set(key, merged);
    if (redisClient?.isOpen) {
      try {
        let redisPrev = [];
        const raw = await redisClient.get(`${STRUCT_OPS_REDIS_PREFIX}${key}`).catch(() => null);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) redisPrev = parsed;
        }
        const seenIds = new Set(redisPrev.map((op) => op?.opId).filter(Boolean));
        const combined = [...redisPrev, ...structuralOps.filter((op) => !seenIds.has(op.opId))].slice(
          -STRUCT_OPS_MAX_QUEUE
        );
        await redisClient.set(`${STRUCT_OPS_REDIS_PREFIX}${key}`, JSON.stringify(combined), {
          EX: STRUCT_OPS_TTL_SECONDS,
        });
        for (const op of memOps) op.persistedToRedis = true;
      } catch { }
    }
  }
}

export async function loadPendingStructuralOps_(key) {
  let mem = _pendingStructuralOpsByClient.get(key) || [];
  let redisOps = [];
  let redisReadOk = false;
  if (redisClient?.isOpen) {
    try {
      const raw = await redisClient.get(`${STRUCT_OPS_REDIS_PREFIX}${key}`);
      redisReadOk = true;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) redisOps = parsed;
      }
    } catch { }
  }
  if (redisReadOk) {
    const redisIds = new Set(redisOps.map((op) => op?.opId).filter(Boolean));
    mem = mem.filter((op) => !op?.persistedToRedis || (op?.opId && redisIds.has(op.opId)));
    if (mem.length > 0) _pendingStructuralOpsByClient.set(key, mem);
    else _pendingStructuralOpsByClient.delete(key);
  }
  const seen = new Set();
  const combined = [];
  for (const op of [...redisOps, ...mem]) {
    if (!op || !op.req) continue;
    if (op.opId) {
      if (seen.has(op.opId)) continue;
      seen.add(op.opId);
    }
    combined.push(op);
  }
  return combined.slice(-STRUCT_OPS_MAX_QUEUE);
}

export async function clearPendingStructuralOpsById_(key, idsToRemove = null) {
  if (!idsToRemove) {
    _pendingStructuralOpsByClient.delete(key);
    if (redisClient?.isOpen) {
      await redisClient.del(`${STRUCT_OPS_REDIS_PREFIX}${key}`).catch(() => { });
    }
    return;
  }
  const removeSet = idsToRemove instanceof Set ? idsToRemove : new Set(idsToRemove);
  const filterFn = (list) => (Array.isArray(list) ? list.filter((op) => op?.opId && !removeSet.has(op.opId)) : []);
  const nextMem = filterFn(_pendingStructuralOpsByClient.get(key));
  if (nextMem.length > 0) _pendingStructuralOpsByClient.set(key, nextMem);
  else _pendingStructuralOpsByClient.delete(key);

  if (redisClient?.isOpen) {
    try {
      const raw = await redisClient.get(`${STRUCT_OPS_REDIS_PREFIX}${key}`).catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        const nextRedis = filterFn(parsed);
        if (nextRedis.length > 0) {
          await redisClient
            .set(`${STRUCT_OPS_REDIS_PREFIX}${key}`, JSON.stringify(nextRedis), { EX: STRUCT_OPS_TTL_SECONDS })
            .catch(() => { });
        } else {
          await redisClient.del(`${STRUCT_OPS_REDIS_PREFIX}${key}`).catch(() => { });
        }
      }
    } catch { }
  }
}

export function reconcileCosmeticGroupRequestsAgainstLiveGroups(requests = [], liveRowGroupsBySheetId = new Map()) {
  const simBySheet = new Map();
  const mergeIntervals = (arr) => {
    const sorted = [...arr]
      .filter((g) => Number.isInteger(g.startIndex) && Number.isInteger(g.endIndex) && g.endIndex > g.startIndex)
      .sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
    const out = [];
    for (const g of sorted) {
      const prev = out[out.length - 1];
      if (prev && g.startIndex <= prev.endIndex) {
        prev.endIndex = Math.max(prev.endIndex, g.endIndex);
        prev.collapsed = Boolean(prev.collapsed && g.collapsed);
      } else {
        out.push({ startIndex: g.startIndex, endIndex: g.endIndex, collapsed: Boolean(g.collapsed) });
      }
    }
    return out;
  };
  const getSim = (sheetId) => {
    if (!simBySheet.has(sheetId)) {
      const raw = liveRowGroupsBySheetId.get(sheetId) || [];
      const depth1 = raw
        .filter((g) => (g.depth ?? 1) === 1 && g.range?.dimension !== "COLUMNS")
        .map((g) => ({
          startIndex: Number(g.range?.startIndex ?? 0),
          endIndex: Number(g.range?.endIndex ?? 0),
          collapsed: Boolean(g.collapsed),
        }));
      simBySheet.set(sheetId, mergeIntervals(depth1));
    }
    return simBySheet.get(sheetId);
  };

  const out = [];
  for (const req of requests || []) {
    if (!req || typeof req !== "object") continue;
    if (req.updateDimensionProperties) {
      out.push(req);
      continue;
    }
    if (req.deleteDimensionGroup?.range?.dimension === "ROWS") {
      const sId = req.deleteDimensionGroup.range.sheetId;
      const s = Number(req.deleteDimensionGroup.range.startIndex ?? 0);
      const e = Number(req.deleteDimensionGroup.range.endIndex ?? s);
      if (e <= s) continue;
      const sim = getSim(sId);
      const overlapping = sim.filter((g) => g.startIndex < e && g.endIndex > s);
      if (overlapping.length === 0) continue;
      const nextSim = sim.filter((g) => !(g.startIndex < e && g.endIndex > s));
      const remainders = [];
      for (const g of overlapping) {
        out.push({
          deleteDimensionGroup: {
            range: { sheetId: sId, dimension: "ROWS", startIndex: g.startIndex, endIndex: g.endIndex },
          },
        });
        if (g.startIndex < s) remainders.push({ startIndex: g.startIndex, endIndex: s, collapsed: g.collapsed });
        if (g.endIndex > e) remainders.push({ startIndex: e, endIndex: g.endIndex, collapsed: g.collapsed });
      }
      for (const rem of remainders) {
        out.push({
          addDimensionGroup: {
            range: { sheetId: sId, dimension: "ROWS", startIndex: rem.startIndex, endIndex: rem.endIndex },
          },
        });
        if (rem.collapsed) {
          out.push({
            updateDimensionGroup: {
              dimensionGroup: {
                range: { sheetId: sId, dimension: "ROWS", startIndex: rem.startIndex, endIndex: rem.endIndex },
                depth: 1,
                collapsed: true,
              },
              fields: "collapsed",
            },
          });
        }
        nextSim.push(rem);
      }
      simBySheet.set(sId, mergeIntervals(nextSim));
    } else if (req.addDimensionGroup?.range?.dimension === "ROWS") {
      const sId = req.addDimensionGroup.range.sheetId;
      const s = Number(req.addDimensionGroup.range.startIndex ?? 0);
      const e = Number(req.addDimensionGroup.range.endIndex ?? s);
      if (e <= s) continue;
      const sim = getSim(sId);
      let gaps = [{ startIndex: s, endIndex: e }];
      for (const g of sim) {
        const nextGaps = [];
        for (const gap of gaps) {
          if (g.endIndex <= gap.startIndex || g.startIndex >= gap.endIndex) {
            nextGaps.push(gap);
          } else {
            if (gap.startIndex < g.startIndex) nextGaps.push({ startIndex: gap.startIndex, endIndex: g.startIndex });
            if (g.endIndex < gap.endIndex) nextGaps.push({ startIndex: g.endIndex, endIndex: gap.endIndex });
          }
        }
        gaps = nextGaps;
      }
      for (const gap of gaps) {
        if (gap.endIndex > gap.startIndex) {
          out.push({
            addDimensionGroup: {
              range: { sheetId: sId, dimension: "ROWS", startIndex: gap.startIndex, endIndex: gap.endIndex },
            },
          });
          sim.push({ startIndex: gap.startIndex, endIndex: gap.endIndex, collapsed: false });
        }
      }
      simBySheet.set(sId, mergeIntervals(sim));
    } else if (req.updateDimensionGroup?.dimensionGroup?.range?.dimension === "ROWS") {
      const dg = req.updateDimensionGroup.dimensionGroup;
      const sId = dg.range.sheetId;
      const s = Number(dg.range.startIndex ?? 0);
      const e = Number(dg.range.endIndex ?? s);
      const sim = getSim(sId);
      const matched =
        sim.find((g) => g.startIndex <= s && g.endIndex >= e) || sim.find((g) => g.startIndex < e && g.endIndex > s);
      if (!matched) continue;
      const collapsed = Boolean(dg.collapsed);
      matched.collapsed = collapsed;
      out.push({
        updateDimensionGroup: {
          dimensionGroup: {
            range: {
              sheetId: sId,
              dimension: "ROWS",
              startIndex: matched.startIndex,
              endIndex: matched.endIndex,
            },
            depth: 1,
            collapsed,
          },
          fields: req.updateDimensionGroup.fields || "collapsed",
        },
      });
    }
  }
  return out;
}

function rewriteStructuralRequestSheetId_(req, realGid) {
  const cloned = structuredClone(req);
  if (cloned.moveDimension?.source) cloned.moveDimension.source.sheetId = realGid;
  if (cloned.insertDimension?.range) cloned.insertDimension.range.sheetId = realGid;
  if (cloned.deleteDimension?.range) cloned.deleteDimension.range.sheetId = realGid;
  if (cloned.addDimensionGroup?.range) cloned.addDimensionGroup.range.sheetId = realGid;
  if (cloned.deleteDimensionGroup?.range) cloned.deleteDimensionGroup.range.sheetId = realGid;
  if (cloned.updateDimensionGroup?.dimensionGroup?.range) {
    cloned.updateDimensionGroup.dimensionGroup.range.sheetId = realGid;
  }
  if (cloned.updateDimensionProperties?.range) cloned.updateDimensionProperties.range.sheetId = realGid;
  return cloned;
}

async function acquireRedisBridgeLock_(normKey, ttlSecs = 90) {
  if (!redisClient?.isOpen) return "no-redis";
  try {
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const res = await redisClient.set(`pulse:sheet_bridge_lock:${normKey}`, token, {
      NX: true,
      EX: ttlSecs,
    });
    return res === "OK" ? token : null;
  } catch {
    return "no-redis";
  }
}

async function releaseRedisBridgeLock_(normKey, token) {
  if (!redisClient?.isOpen || !token || token === "no-redis") return;
  const lockKey = `pulse:sheet_bridge_lock:${normKey}`;
  try {
    const cur = await redisClient.get(lockKey);
    if (cur === token) {
      await redisClient.del(lockKey);
    }
  } catch { }
}

/**
 * Throttled read-time check: if `sheet_bridge_mode === 'live'`, runs a ~60 ms Drive
 * `version` check (at most once per 10s per tenant) and pulls any human sheet edits
 * into Supabase before returning data to PMA / Portal / Proactive checks.
 */
export async function ensureClientSheetBridgeFreshOnRead(
  ctx,
  { throttleMs = READ_CHECK_THROTTLE_MS, background = false, force = false } = {}
) {
  if (
    !ctx ||
    ctx.clientMode !== "supabase" ||
    ctx.sheetBridgeMode !== "live" ||
    !ctx.clientSheetId ||
    isVirtualSupabaseSheetId(ctx.clientSheetId)
  ) {
    return null;
  }
  const key = normalizeKey_(ctx.clientName);
  if (
    !key ||
    _suppressOutboundByClient.has(key) ||
    _inFlightBridgeByClient.has(key) ||
    _pendingOutboundByClient.has(key)
  ) {
    return null;
  }

  const now = Date.now();
  if (!force) {
    const lastEditMs = getLastClientEditTimestamp(ctx.clientName);
    if (lastEditMs && now - lastEditMs < 10000) {
      return null;
    }
    if (now - (_lastReadCheckByClient.get(key) || 0) < throttleMs) {
      return null;
    }
  }
  _lastReadCheckByClient.set(key, now);

  const runCheckPromise = (async () => {
    if (!force && redisClient?.isOpen) {
      try {
        const ok = await redisClient.set(`pulse:sheet_bridge_read_check:${key}`, String(now), {
          NX: true,
          EX: Math.max(3, Math.ceil(throttleMs / 1000)),
        });
        if (ok !== "OK") return null;
      } catch { }
    }

    try {
      return await checkAndSyncClientSheetBridge(ctx.clientName, { direction: "inbound_check" }).catch((err) => {
        console.warn(`[clientSheetBridge] Read freshness check warning (${ctx.clientName}):`, err.message);
        return null;
      });
    } finally {
      _lastReadCheckByClient.set(key, Date.now());
    }
  })();

  if (background && !force) {
    try {
      waitUntil(runCheckPromise);
    } catch { }
    return null;
  }

  return await runCheckPromise;
}

/**
 * Schedules a 3-second debounced outbound bridge flush using Vercel `waitUntil`
 * so rapid edits (e.g. multiple triage placements) coalesce into one minimal
 * Google Sheets batchUpdate without blocking interactive HTTP responses.
 */
export function scheduleOutboundSheetBridgeSync(clientName, dirtyTabs = []) {
  const cleanName = String(clientName || "").trim();
  const key = normalizeKey_(cleanName);
  if (!key || _suppressOutboundByClient.has(key)) return null;

  const relevantTabs = (Array.isArray(dirtyTabs) ? dirtyTabs : []).filter(
    (t) => BRIDGE_BIDIRECTIONAL_TAB_SET.has(t) || BRIDGE_OUTBOUND_ONLY_SET.has(t)
  );
  if (relevantTabs.length === 0) return null;

  if (redisClient?.isOpen) {
    redisClient.sAdd(`pulse:sheet_bridge_dirty:${key}`, relevantTabs).catch(() => { });
    redisClient.expire(`pulse:sheet_bridge_dirty:${key}`, 3600).catch(() => { });
  }

  let entry = _pendingOutboundByClient.get(key);
  if (!entry) {
    let resolveFlush;
    const promise = new Promise((resolve) => {
      resolveFlush = resolve;
    });
    entry = {
      clientName: cleanName,
      dirtyTabs: new Set(relevantTabs),
      timer: null,
      promise,
      resolveFlush,
    };
    _pendingOutboundByClient.set(key, entry);
    try {
      waitUntil(promise);
    } catch { }
  } else {
    for (const t of relevantTabs) entry.dirtyTabs.add(t);
    if (entry.timer) clearTimeout(entry.timer);
  }

  entry.timer = setTimeout(async () => {
    const current = _pendingOutboundByClient.get(key);
    if (current) _pendingOutboundByClient.delete(key);
    try {
      await checkAndSyncClientSheetBridge(cleanName, {
        direction: "both",
        dirtyTabsHint: current ? [...current.dirtyTabs] : relevantTabs,
      });
    } catch (err) {
      console.warn(`[clientSheetBridge] Debounced flush warning (${cleanName}):`, err.message);
    } finally {
      if (current?.resolveFlush) current.resolveFlush();
    }
  }, OUTBOUND_DEBOUNCE_MS);

  return entry.promise;
}

export async function waitForPendingOutboundSheetBridge(clientName) {
  const key = normalizeKey_(clientName);
  if (!key) return;
  const pending = _pendingOutboundByClient.get(key);
  if (pending?.promise) {
    await pending.promise.catch(() => { });
  }
  const inFlight = _inFlightBridgeByClient.get(key);
  if (inFlight) {
    await inFlight.catch(() => { });
  }
}

export function applyCoreRowShiftOpsToTabBaseline_(baseTab, opsForTab = []) {
  const nextVals = Array.isArray(baseTab?.values)
    ? baseTab.values.map((r) => (Array.isArray(r) ? [...r] : []))
    : [];
  let nextNotes = cloneSafeNotes_(baseTab?.notes);

  const remapNotes = (mapRowFn) => {
    const out = createSafeMap_();
    for (const [k, v] of Object.entries(nextNotes || {})) {
      if (k === "__hidden_rows" || k === "__row_groups") {
        out[k] = v;
        continue;
      }
      const m = k.match(/^(\d+):(\d+)$/);
      if (!m) {
        out[k] = v;
        continue;
      }
      const oldR0 = Number(m[1]);
      const newR0 = mapRowFn(oldR0);
      if (newR0 === null || newR0 === undefined || newR0 < 0) continue;
      out[`${newR0}:${m[2]}`] = v;
    }
    nextNotes = out;
  };

  for (const item of opsForTab || []) {
    const req = item?.req || item;
    if (!req) continue;
    if (req.insertDimension?.range?.dimension === "ROWS") {
      const rng = req.insertDimension.range;
      const s = Math.max(0, Number(rng.startIndex ?? 0));
      const e = Math.max(s, Number(rng.endIndex ?? s + 1));
      const count = e - s;
      if (count <= 0) continue;
      while (nextVals.length < s) nextVals.push([]);
      const blanks = Array.from({ length: count }, () => []);
      nextVals.splice(s, 0, ...blanks);
      remapNotes((oldR0) => (oldR0 >= s ? oldR0 + count : oldR0));
    } else if (req.deleteDimension?.range?.dimension === "ROWS") {
      const rng = req.deleteDimension.range;
      const s = Math.max(0, Number(rng.startIndex ?? 0));
      const e = Math.max(s, Number(rng.endIndex ?? s + 1));
      const count = e - s;
      if (count <= 0 || s >= nextVals.length) continue;
      nextVals.splice(s, count);
      remapNotes((oldR0) => {
        if (oldR0 >= s && oldR0 < s + count) return -1;
        if (oldR0 >= s + count) return oldR0 - count;
        return oldR0;
      });
    } else if (req.moveDimension?.source?.dimension === "ROWS") {
      const src = req.moveDimension.source;
      const s = Math.max(0, Number(src.startIndex ?? 0));
      const e = Math.max(s, Number(src.endIndex ?? s + 1));
      const count = e - s;
      const d = Math.max(0, Number(req.moveDimension.destinationIndex ?? 0));
      const minLen = Math.max(s + count, d);
      if (count <= 0 || d === s || minLen > 50000) continue;
      while (nextVals.length < minLen) nextVals.push([]);
      const movedV = nextVals.splice(s, count);
      const insertAt = d <= s ? d : Math.max(0, d - count);
      nextVals.splice(insertAt, 0, ...movedV);
      remapNotes((oldR0) => {
        if (oldR0 >= s && oldR0 < s + count) return insertAt + (oldR0 - s);
        if (s < insertAt && oldR0 >= s + count && oldR0 < insertAt + count) return oldR0 - count;
        if (insertAt < s && oldR0 >= insertAt && oldR0 < s) return oldR0 + count;
        return oldR0;
      });
    }
  }

  return {
    ...(baseTab || {}),
    values: nextVals,
    notes: nextNotes,
  };
}

/**
 * Main bidirectional synchronization routine for a single client.
 * - `direction`: `"inbound_check"` | `"inbound"` | `"outbound"` | `"both"`
 */
export async function checkAndSyncClientSheetBridge(
  clientName,
  { direction = "both", force = false, allowDryRunApplyInbound = false, dirtyTabsHint = null } = {}
) {
  if (!isSupabaseConfigured()) throw new Error("Supabase is not configured.");
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);
  if (ctx.clientMode !== "supabase") {
    return { skipped: true, reason: `Client portal mode is "${ctx.clientMode}", expected "supabase".` };
  }
  if (!ctx.clientSheetId || isVirtualSupabaseSheetId(ctx.clientSheetId)) {
    return { skipped: true, reason: "No Google Client Sheet linked for this tenant." };
  }

  const mode = String(ctx.sheetBridgeMode || "off").toLowerCase();
  if (mode === "off" && !force) {
    return { skipped: true, reason: "Sheet bridge mode is off." };
  }
  const effectiveMode = mode === "live" ? "live" : "dry_run";
  const key = normalizeKey_(ctx.clientName);

  if (_inFlightBridgeByClient.has(key)) {
    return await _inFlightBridgeByClient.get(key);
  }

  const runPromise = (async () => {
    const lockToken = await acquireRedisBridgeLock_(key, 90);
    if (!lockToken && !force) {
      return { skipped: true, reason: "Another bridge sync is already in progress." };
    }

    const supabase = getSupabaseAdmin();
    try {
      const { rawDrive, rawSheets, serviceAccountEmails } = getPrimaryRawGoogleClients();
      if (!rawDrive || !rawSheets) {
        throw new Error("Primary Google Service Account Drive/Sheets clients unavailable.");
      }

      const [clientRowRes, baseline, driveMeta] = await Promise.all([
        supabase
          .from("clients")
          .select("metadata")
          .eq("client_name", ctx.clientName)
          .maybeSingle(),
        loadBaselineRecord_(supabase, ctx),
        fetchDriveVersionMeta_(rawDrive, ctx.clientSheetId),
      ]);

      const curMeta = clientRowRes?.data?.metadata || {};
      const curState = curMeta.sheet_bridge_state || {};
      const lastSyncedVersion = String(baseline.driveVersion || curState.lastSyncedDriveVersion || "");
      const lastPulseWrittenVersion = String(curState.lastPulseWrittenVersion || "");

      const lastOutboundMs = curState.lastOutboundAt ? new Date(curState.lastOutboundAt).getTime() : 0;
      const isRecentSaWrite =
        Boolean(driveMeta.lastModifyingEmail && serviceAccountEmails.includes(driveMeta.lastModifyingEmail)) &&
        Date.now() - lastOutboundMs < 20000;

      const driveVersionChanged = Boolean(
        driveMeta.version &&
        driveMeta.version !== lastSyncedVersion &&
        driveMeta.version !== lastPulseWrittenVersion &&
        !isRecentSaWrite
      );

      const hasUnmigratedNoteTabs = BRIDGE_BIDIRECTIONAL_TABS.some(
        (t) =>
          BRIDGE_NOTE_TABS.has(t) &&
          Number(baseline.tabs?.[t]?.noteBoundsVersion || baseline.noteBoundsVersion || 1) <
          CURRENT_NOTE_BOUNDS_VERSION
      );
      const wantsInbound =
        direction === "inbound" ||
        direction === "inbound_check" ||
        direction === "both";
      const wantsOutbound = direction === "outbound" || direction === "both";
      const forceInboundFetch = direction === "inbound" || force;
      const canPullInbound = Boolean(
        wantsInbound && (driveVersionChanged || forceInboundFetch || (direction !== "inbound_check" && hasUnmigratedNoteTabs))
      );

      // Fast-path exit on pure inbound read check (~60ms Drive metadata check only!)
      if (direction === "inbound_check" && !driveVersionChanged && !force) {
        return {
          success: true,
          mode: effectiveMode,
          checked: true,
          driveVersion: driveMeta.version,
          inboundChanged: false,
          outboundChanged: false,
        };
      }

      let redisDirtyTabs = [];
      if (redisClient?.isOpen) {
        try {
          redisDirtyTabs = await redisClient.sMembers(`pulse:sheet_bridge_dirty:${key}`);
        } catch { }
      }

      const queuedStructOps = await loadPendingStructuralOps_(key);
      const isCoreRowShift_ = (req) =>
        Boolean(
          req?.moveDimension?.source?.dimension === "ROWS" ||
          req?.insertDimension?.range?.dimension === "ROWS" ||
          req?.deleteDimension?.range?.dimension === "ROWS"
        );
      const coreRowShiftOps = queuedStructOps.filter((op) => isCoreRowShift_(op.req));
      const cosmeticGroupOps = queuedStructOps.filter((op) => !isCoreRowShift_(op.req));
      let executedPreDiffCoreCount = 0;

      // Phase 1 FIRST (before reading Google Sheet or computing diffs):
      // Execute queued structural row shifts on the live Google Sheet AND mirror them onto baseline
      // so computeThreeWayTabMerge compares identical post-shift row coordinates.
      if (wantsOutbound && effectiveMode === "live" && coreRowShiftOps.length > 0) {
        const preShiftMeta = await withRetry(() =>
          rawSheets.spreadsheets.get({
            spreadsheetId: ctx.clientSheetId,
            fields: "sheets(properties(sheetId,title,gridProperties))",
          })
        );
        const preShiftPropsByTitle = createSafeMap_();
        const preRowCountByTab = createSafeMap_();
        for (const sh of preShiftMeta?.data?.sheets || []) {
          const tName = sh.properties?.title;
          if (!tName || PROTOTYPE_KEYS.has(tName)) continue;
          const sId = sh.properties?.sheetId;
          const rCount = Math.max(1, Number(sh.properties?.gridProperties?.rowCount || 0));
          preShiftPropsByTitle[tName] = { sheetId: sId, rowCount: rCount };
          preRowCountByTab[tName] = rCount;
        }
        const preDiffCoreBatch = [];
        const executedPreDiffIds = new Set();
        const opsByTabForBaseline = createSafeMap_();

        for (const op of coreRowShiftOps) {
          let realGid = preShiftPropsByTitle[op.tabName]?.sheetId;
          if (realGid === null || realGid === undefined) {
            realGid = await getSheetGid(rawSheets, ctx.clientSheetId, op.tabName).catch(() => null);
          }
          if (realGid === null || realGid === undefined) continue;
          if (op.opId) executedPreDiffIds.add(op.opId);
          executedPreDiffCoreCount++;
          if (op.tabName) {
            if (!opsByTabForBaseline[op.tabName]) opsByTabForBaseline[op.tabName] = [];
            opsByTabForBaseline[op.tabName].push(op);
          }

          const rewritten = rewriteStructuralRequestSheetId_(op.req, realGid);
          const delRange = op.req?.deleteDimension?.range;
          const insRange = op.req?.insertDimension?.range;
          const mov = op.req?.moveDimension;
          if (mov?.source?.dimension === "ROWS" && op.tabName) {
            const neededMax = Math.max(Number(mov.source.endIndex || 0), Number(mov.destinationIndex || 0));
            const curRows = preRowCountByTab[op.tabName] || 0;
            if (curRows > 0 && neededMax > curRows) {
              preDiffCoreBatch.push({
                insertDimension: {
                  range: {
                    sheetId: realGid,
                    dimension: "ROWS",
                    startIndex: curRows,
                    endIndex: neededMax + 15,
                  },
                  inheritFromBefore: true,
                },
              });
              preRowCountByTab[op.tabName] = neededMax + 15;
            }
            if (Number(mov.destinationIndex || 0) > Number(mov.source.endIndex || 0)) {
              preDiffCoreBatch.push({
                updateDimensionProperties: {
                  range: {
                    sheetId: realGid,
                    dimension: "ROWS",
                    startIndex: Number(mov.source.startIndex || 0),
                    endIndex: Number(mov.source.endIndex || 0),
                  },
                  properties: { hiddenByUser: false },
                  fields: "hiddenByUser",
                },
              });
            }
          }
          preDiffCoreBatch.push(rewritten);
          if (op.tabName) {
            if (delRange?.dimension === "ROWS") {
              preRowCountByTab[op.tabName] = Math.max(
                1,
                (preRowCountByTab[op.tabName] || 1) -
                Math.max(0, Number(delRange.endIndex) - Number(delRange.startIndex))
              );
            } else if (insRange?.dimension === "ROWS") {
              preRowCountByTab[op.tabName] =
                (preRowCountByTab[op.tabName] || 0) +
                Math.max(0, Number(insRange.endIndex) - Number(insRange.startIndex));
            }
          }
        }

        if (preDiffCoreBatch.length > 0) {
          await withRetry(() =>
            rawSheets.spreadsheets.batchUpdate({
              spreadsheetId: ctx.clientSheetId,
              requestBody: { requests: preDiffCoreBatch },
            })
          );
          if (executedPreDiffIds.size > 0) {
            await clearPendingStructuralOpsById_(key, executedPreDiffIds);
          }
          for (const [tName, tOps] of Object.entries(opsByTabForBaseline)) {
            if (PROTOTYPE_KEYS.has(tName)) continue;
            baseline.tabs[tName] = applyCoreRowShiftOpsToTabBaseline_(
              baseline.tabs?.[tName] || { values: [], notes: createSafeMap_(), noteBoundsVersion: baseline.noteBoundsVersion || 1 },
              tOps
            );
          }
          const postShiftDriveMeta = await fetchDriveVersionMeta_(rawDrive, ctx.clientSheetId).catch(() => null);
          if (postShiftDriveMeta?.version) {
            driveMeta.version = postShiftDriveMeta.version;
            driveMeta.modifiedTime = postShiftDriveMeta.modifiedTime || driveMeta.modifiedTime;
          }
          await saveBaselineRecord_(supabase, ctx, {
            driveVersion: driveMeta.version || baseline.driveVersion,
            tabs: baseline.tabs,
            noteBoundsVersion: baseline.noteBoundsVersion || 1,
          });
        }
      }

      const needRealSheetFetch = canPullInbound || wantsOutbound;

      const structDirtyTabs = queuedStructOps.map((op) => op.tabName).filter(Boolean);
      const scopedDirtyTabs = [
        ...new Set([
          ...(Array.isArray(dirtyTabsHint) ? dirtyTabsHint : []),
          ...redisDirtyTabs,
          ...structDirtyTabs,
        ]),
      ].filter((t) => BRIDGE_ALL_SYNCED_TABS.includes(t));

      const canScopeToDirtyTabsOnly =
        wantsOutbound &&
        !force &&
        !canPullInbound &&
        scopedDirtyTabs.length > 0;

      let sheetBundle = null;
      const preloadedSupaByTab = createSafeMap_();
      const preloadedRevByTab = createSafeMap_();
      if (needRealSheetFetch) {
        const tabsToLoad = canScopeToDirtyTabsOnly
          ? [...scopedDirtyTabs, ...(scopedDirtyTabs.includes("Outgoings") ? ["OutgNotes"] : [])]
          : canPullInbound
            ? [...BRIDGE_BIDIRECTIONAL_TABS, "KeyInfo", "OutgNotes"]
            : [...BRIDGE_ALL_SYNCED_TABS, "OutgNotes"];
        const minRowHorizonByTab = createSafeMap_();
        await Promise.all(
          ["Confirmed", "Pipeline"].map(async (tName) => {
            if (!tabsToLoad.includes(tName)) return;
            preloadedRevByTab[tName] = getTabWriteRevision_(ctx.clientName, "client", tName);
            const supaRec = await getOrLoadVirtualTabGrid_(ctx, "client", tName, rawSheets, {
              includeNotes: true,
            }).catch(() => null);
            if (supaRec) preloadedSupaByTab[tName] = supaRec;
            const supaLast = findLastActiveJobRowCount_(supaRec?.values_grid || []);
            const baseLast = findLastActiveJobRowCount_(baseline.tabs?.[tName]?.values || []);
            minRowHorizonByTab[tName] = Math.max(supaLast, baseLast);
          })
        );
        sheetBundle = await fetchRealSheetTabsAndNotes_(rawSheets, ctx.clientSheetId, tabsToLoad, {
          minRowHorizonByTab,
        });
      }

      const mergeResults = [];
      const tabGridsMap = createSafeMap_();
      const inboundAppliedTabs = [];
      const allInboundDiffs = [];
      const allOutboundDiffs = [];
      const allConflicts = [];
      let totalFormulaProtected = 0;
      const outboundValueRanges = [];
      const outboundNoteRequests = [];
      let outboundOutgoingsNoteChanges = [];
      let inboundOutgoingsNoteChanges = [];
      const nextBaselineTabs = { ...baseline.tabs };
      const maxTargetRowByTab = createSafeMap_();
      const mergedRevByTab = createSafeMap_();

      const tabsToProcess = canScopeToDirtyTabsOnly
        ? scopedDirtyTabs
        : wantsOutbound
          ? BRIDGE_ALL_SYNCED_TABS
          : BRIDGE_BIDIRECTIONAL_TABS;

      for (const tabName of tabsToProcess) {
        const sheetTab = sheetBundle?.resultByTab?.[tabName];
        if (!sheetTab) continue;

        const curRev = getTabWriteRevision_(ctx.clientName, "client", tabName);
        const hasFreshPreload = Boolean(preloadedSupaByTab[tabName]) && preloadedRevByTab[tabName] === curRev;
        const supaRec = hasFreshPreload
          ? preloadedSupaByTab[tabName]
          : (await getOrLoadVirtualTabGrid_(ctx, "client", tabName, rawSheets, {
            includeNotes: true,
          }).catch(() => null));
        if (!supaRec) continue;
        mergedRevByTab[tabName] = hasFreshPreload
          ? curRev
          : getTabWriteRevision_(ctx.clientName, "client", tabName);

        tabGridsMap[tabName] = {
          supaValues: supaRec.values_grid || [],
          sheetValues: sheetTab.values || [],
        };

        const baseTab = baseline.tabs?.[tabName] || { values: [], notes: createSafeMap_(), noteBoundsVersion: baseline.noteBoundsVersion || 1 };
        const tabNoteBoundsVer = Number(baseTab.noteBoundsVersion || baseline.noteBoundsVersion || 1);
        const merge = computeThreeWayTabMerge({
          tabName,
          baselineValues: baseTab.values,
          baselineNotes: baseTab.notes,
          sheetValues: sheetTab.values,
          sheetFormulas: sheetTab.formulas,
          sheetNotes: sheetTab.notes,
          supaValues: supaRec.values_grid || [],
          supaFormulas: supaRec.formulas_grid || supaRec.values_grid || [],
          supaNotes: supaRec.notes_grid || {},
          applyOutboundToBaseline: Boolean(wantsOutbound && effectiveMode === "live"),
          allowInbound: canPullInbound,
          supportsNotesOverride: sheetBundle?.notesFetchFailed ? false : null,
          fetchedNoteBounds: sheetBundle?.fetchedNoteBoundsByTab || null,
          maxRowBound: sheetTab.scannedRowLimit || null,
          baselineNoteBoundsVersion: tabNoteBoundsVer,
        });
        mergeResults.push({ tabName, merge, supaRec, sheetTab });

        if (merge.inboundCellChanges.length > 0 || merge.inboundNoteChanges.length > 0) {
          allInboundDiffs.push(
            ...merge.inboundCellChanges,
            ...merge.inboundNoteChanges.map((n) => ({ ...n, isNote: true }))
          );
          inboundAppliedTabs.push(tabName);
          if (tabName === "Outgoings" && merge.inboundNoteChanges.length > 0) {
            inboundOutgoingsNoteChanges = merge.inboundNoteChanges;
          }
        }
        if (merge.outboundCellChanges.length > 0 || merge.outboundNoteChanges.length > 0) {
          allOutboundDiffs.push(
            ...merge.outboundCellChanges,
            ...merge.outboundNoteChanges.map((n) => ({ ...n, isNote: true }))
          );
        }
        if (merge.conflicts.length > 0) {
          allConflicts.push(...merge.conflicts);
        }
        totalFormulaProtected += merge.formulaCellsProtectedCount;

        if (wantsOutbound && merge.outboundCellChanges.length > 0) {
          for (const ch of merge.outboundCellChanges) {
            const curMax = maxTargetRowByTab[tabName] || 0;
            if (ch.row0 + 1 > curMax) maxTargetRowByTab[tabName] = ch.row0 + 1;
          }
          outboundValueRanges.push(...coalesceRowChangesToBatchRanges(tabName, merge.outboundCellChanges));
        }
        if (wantsOutbound && merge.outboundNoteChanges.length > 0) {
          for (const n of merge.outboundNoteChanges) {
            const curMax = maxTargetRowByTab[tabName] || 0;
            if (n.row0 + 1 > curMax) maxTargetRowByTab[tabName] = n.row0 + 1;
          }
          outboundNoteRequests.push(...buildUpdateCellsNoteRequests_(sheetTab.sheetId, merge.outboundNoteChanges));
          if (tabName === "Outgoings") {
            outboundOutgoingsNoteChanges = merge.outboundNoteChanges;
          }
        }

        const tabUpgradedNotes =
          BRIDGE_NOTE_TABS.has(tabName) &&
          !sheetBundle?.notesFetchFailed &&
          (canPullInbound || (wantsOutbound && effectiveMode === "live"));
        nextBaselineTabs[tabName] = {
          values: merge.nextBaselineValues,
          notes: merge.nextBaselineNotes,
          noteBoundsVersion: tabUpgradedNotes
            ? CURRENT_NOTE_BOUNDS_VERSION
            : Number(baseTab.noteBoundsVersion || baseline.noteBoundsVersion || 1),
        };
      }

      const shouldApplyInboundNow =
        inboundAppliedTabs.length > 0 &&
        wantsInbound &&
        (effectiveMode === "live" || allowDryRunApplyInbound);

      // Mirror Outgoings notes (outbound AND applied inbound edits) into OutgNotes!A1:AV111 on Google Sheet
      const combinedOutgNoteChangesForSheet = [
        ...outboundOutgoingsNoteChanges,
        ...(shouldApplyInboundNow ? inboundOutgoingsNoteChanges : []),
      ];
      if (wantsOutbound && combinedOutgNoteChangesForSheet.length > 0 && sheetBundle?.resultByTab?.OutgNotes) {
        const outgNotesRanges = buildOutgNotesMirrorUpdates(
          combinedOutgNoteChangesForSheet,
          sheetBundle.resultByTab.OutgNotes.values || []
        );
        outboundValueRanges.push(...outgNotesRanges);
      }

      if (shouldApplyInboundNow) {
        _suppressOutboundByClient.add(key);
        try {
          const allowClearAllNotesTabs = [];
          for (const item of mergeResults) {
            if (!inboundAppliedTabs.includes(item.tabName)) continue;
            const allowClearAllNotes =
              BRIDGE_NOTE_TABS.has(item.tabName) &&
              item.merge.inboundNoteChanges.length > 0 &&
              !sheetBundle?.notesFetchFailed;
            if (allowClearAllNotes) allowClearAllNotesTabs.push(item.tabName);
            await saveVirtualTabGrid_(
              ctx,
              "client",
              item.tabName,
              item.merge.mergedValues,
              item.merge.mergedFormulas,
              item.merge.mergedNotes,
              { markPersistedImmediate: true, markPersistedToDbImmediate: true, allowClearAllNotes }
            );
          }
          await recomputeClientFormulasForBridge(ctx.clientName, inboundAppliedTabs, {
            allowClearAllNotesTabs,
          }).catch((e) =>
            console.warn(`[clientSheetBridge] Post-inbound recompute warning (${ctx.clientName}):`, e.message)
          );
          invalidateMasterEngineCache(ctx.clientName, "client");
          await invalidatePmaClientCache(ctx.clientSheetId, ctx.masterSheetId).catch(() => { });
          try {
            const { invalidatePrecomputedMemoryCache } = await import("./triageEngine.js");
            invalidatePrecomputedMemoryCache();
          } catch { }
        } finally {
          _suppressOutboundByClient.delete(key);
        }
      }

      let finalDriveVersion = driveMeta.version;
      let finalModifiedTime = driveMeta.modifiedTime;
      const effectiveStructuralCount = executedPreDiffCoreCount + cosmeticGroupOps.length;
      const hasOutboundWork = outboundValueRanges.length > 0 || outboundNoteRequests.length > 0 || effectiveStructuralCount > 0;

      if (wantsOutbound && effectiveMode === "live" && hasOutboundWork) {
        const resolveRealGid_ = async (tabName) => {
          const cached = sheetBundle?.sheetPropsByTitle?.[tabName]?.sheetId;
          if (cached !== null && cached !== undefined) return cached;
          return await getSheetGid(rawSheets, ctx.clientSheetId, tabName).catch(() => null);
        };

        const effectiveRowCountByTab = createSafeMap_();
        for (const [tName, props] of Object.entries(sheetBundle?.sheetPropsByTitle || {})) {
          if (PROTOTYPE_KEYS.has(tName)) continue;
          effectiveRowCountByTab[tName] = Math.max(1, Number(props.rowCount || 0));
        }

        // Expand sheet height if Supabase grew beyond live Google Sheet rowCount during post-shift writes
        const postShiftExpandBatch = [];
        for (const [tName, props] of Object.entries(sheetBundle?.sheetPropsByTitle || {})) {
          if (PROTOTYPE_KEYS.has(tName)) continue;
          const postRows = effectiveRowCountByTab[tName] || Math.max(1, Number(props.rowCount || 0));
          const reqMaxRow = maxTargetRowByTab[tName] || 0;
          if (reqMaxRow > postRows) {
            postShiftExpandBatch.push({
              insertDimension: {
                range: {
                  sheetId: props.sheetId,
                  dimension: "ROWS",
                  startIndex: postRows,
                  endIndex: reqMaxRow + 15,
                },
                inheritFromBefore: true,
              },
            });
            effectiveRowCountByTab[tName] = reqMaxRow + 15;
          }
        }
        if (postShiftExpandBatch.length > 0) {
          await withRetry(() =>
            rawSheets.spreadsheets.batchUpdate({
              spreadsheetId: ctx.clientSheetId,
              requestBody: { requests: postShiftExpandBatch },
            })
          );
        }

        // Filter out any trailing blank clear ranges/notes beyond post-delete sheet bounds
        const safeOutboundValueRanges = outboundValueRanges.filter((vr) => {
          const m = String(vr?.range || "").match(/^([^!]+)![A-Z]+(\d+)/);
          if (!m) return true;
          const maxR = effectiveRowCountByTab[m[1]];
          if (!maxR || Number(m[2]) <= maxR) return true;
          const hasNonEmpty = (vr.values?.[0] || []).some((v) => v !== "" && v !== null && v !== undefined);
          return hasNonEmpty;
        });
        const safeOutboundNoteRequests = outboundNoteRequests.filter((nr) => {
          const rng = nr?.updateCells?.range;
          if (!rng) return true;
          const tEntry = Object.entries(sheetBundle?.sheetPropsByTitle || {}).find(([, p]) => p.sheetId === rng.sheetId);
          if (!tEntry) return true;
          const maxR = effectiveRowCountByTab[tEntry[0]];
          return !maxR || Number(rng.endRowIndex || 0) <= maxR;
        });

        // Phase 2: Write minimal coalesced cell-diff values & notes FIRST so data always persists
        if (safeOutboundValueRanges.length > 0) {
          for (let i = 0; i < safeOutboundValueRanges.length; i += 200) {
            const valChunk = safeOutboundValueRanges.slice(i, i + 200);
            await withRetry(() =>
              rawSheets.spreadsheets.values.batchUpdate({
                spreadsheetId: ctx.clientSheetId,
                requestBody: {
                  valueInputOption: "USER_ENTERED",
                  data: valChunk,
                },
              })
            );
          }
        }

        if (safeOutboundNoteRequests.length > 0) {
          for (let i = 0; i < safeOutboundNoteRequests.length; i += 50) {
            const noteChunk = safeOutboundNoteRequests.slice(i, i + 50);
            await withRetry(() =>
              rawSheets.spreadsheets.batchUpdate({
                spreadsheetId: ctx.clientSheetId,
                requestBody: { requests: noteChunk },
              })
            );
          }
        }

        // Phase 3: Reconcile cosmetic row-group / hide requests against live Google Sheet rowGroups (non-fatal)
        if (cosmeticGroupOps.length > 0) {
          const executedCosIds = new Set(cosmeticGroupOps.map((op) => op.opId).filter(Boolean));
          try {
            const rewrittenCosReqs = [];
            for (const op of cosmeticGroupOps) {
              const realGid = await resolveRealGid_(op.tabName);
              if (realGid !== null && realGid !== undefined) {
                rewrittenCosReqs.push(rewriteStructuralRequestSheetId_(op.req, realGid));
              }
            }
            if (rewrittenCosReqs.length > 0) {
              const liveMeta = await withRetry(() =>
                rawSheets.spreadsheets.get({
                  spreadsheetId: ctx.clientSheetId,
                  fields: "sheets(properties.sheetId,properties.title,rowGroups)",
                })
              );
              const liveGroupsMap = new Map();
              for (const sh of liveMeta?.data?.sheets || []) {
                const sId = sh.properties?.sheetId;
                if (sId !== undefined && sId !== null) {
                  liveGroupsMap.set(sId, sh.rowGroups || []);
                }
              }
              const reconciledCosBatch = reconcileCosmeticGroupRequestsAgainstLiveGroups(
                rewrittenCosReqs,
                liveGroupsMap
              );
              if (reconciledCosBatch.length > 0) {
                await withRetry(() =>
                  rawSheets.spreadsheets.batchUpdate({
                    spreadsheetId: ctx.clientSheetId,
                    requestBody: { requests: reconciledCosBatch },
                  })
                );
              }
            }
          } catch (cosErr) {
            console.warn(
              `[clientSheetBridge] Non-fatal cosmetic row-group sync warning (${ctx.clientName}):`,
              cosErr.message
            );
          } finally {
            if (executedCosIds.size > 0) {
              await clearPendingStructuralOpsById_(key, executedCosIds);
            }
          }
        }

        const postMeta = await fetchDriveVersionMeta_(rawDrive, ctx.clientSheetId).catch(() => null);
        if (postMeta?.version) {
          finalDriveVersion = postMeta.version;
          finalModifiedTime = postMeta.modifiedTime;
        }
      }

      const cleanSyncedTabs = tabsToProcess.filter(
        (t) => getTabWriteRevision_(ctx.clientName, "client", t) === mergedRevByTab[t]
      );
      const dirtiedMidFlightTabs = tabsToProcess.filter(
        (t) => getTabWriteRevision_(ctx.clientName, "client", t) !== mergedRevByTab[t]
      );

      if (redisClient?.isOpen && wantsOutbound && (effectiveMode === "live" || !hasOutboundWork) && cleanSyncedTabs.length > 0) {
        redisClient.sRem(`pulse:sheet_bridge_dirty:${key}`, cleanSyncedTabs).catch(() => { });
      }

      const tabsMigratedNotesThisPass =
        !sheetBundle?.notesFetchFailed &&
        tabsToProcess.some(
          (t) =>
            BRIDGE_NOTE_TABS.has(t) &&
            Number(baseline.tabs?.[t]?.noteBoundsVersion || baseline.noteBoundsVersion || 1) <
            CURRENT_NOTE_BOUNDS_VERSION &&
            Number(nextBaselineTabs[t]?.noteBoundsVersion || 1) >= CURRENT_NOTE_BOUNDS_VERSION
        );

      // Persist updated baseline whenever inbound applied in live/manual mode, outbound committed in live mode, note bounds migrated, or baseline was missing
      const shouldSaveBaseline =
        !baseline.driveVersion ||
        shouldApplyInboundNow ||
        (wantsOutbound && effectiveMode === "live" && hasOutboundWork) ||
        (effectiveMode === "live" && (driveVersionChanged || tabsMigratedNotesThisPass));

      if (shouldSaveBaseline) {
        const minBidirectionalNoteVer = Math.min(
          ...BRIDGE_BIDIRECTIONAL_TABS.filter((t) => BRIDGE_NOTE_TABS.has(t)).map((t) =>
            Number(nextBaselineTabs?.[t]?.noteBoundsVersion || baseline.noteBoundsVersion || 1)
          )
        );
        const nextNoteBoundsVer = Number.isFinite(minBidirectionalNoteVer)
          ? minBidirectionalNoteVer
          : CURRENT_NOTE_BOUNDS_VERSION;
        // In dry_run when inbound wasn't forced, avoid overwriting baseline with un-applied outbound changes
        if (effectiveMode === "dry_run" && !allowDryRunApplyInbound) {
          await saveBaselineRecord_(supabase, ctx, {
            driveVersion: baseline.driveVersion || finalDriveVersion,
            tabs: baseline.tabs,
            noteBoundsVersion: baseline.noteBoundsVersion || 1,
          });
        } else {
          await saveBaselineRecord_(supabase, ctx, {
            driveVersion: finalDriveVersion,
            tabs: nextBaselineTabs,
            noteBoundsVersion: nextNoteBoundsVer,
          });
        }
      }

      const sampleDiffs = [
        ...allInboundDiffs.slice(0, 10).map((d) => ({ direction: "in", tab: d.tabName, cell: d.cellA1, from: d.from, to: d.to })),
        ...allOutboundDiffs.slice(0, 15).map((d) => ({ direction: "out", tab: d.tabName, cell: d.cellA1, from: d.from, to: d.to })),
      ].slice(0, 20);

      const inReadable = buildHumanReadableBridgeRows(allInboundDiffs, tabGridsMap, "Sheet → Supabase", 10);
      const outReadable = buildHumanReadableBridgeRows(allOutboundDiffs, tabGridsMap, "Supabase → Sheet", 10);
      const outboundTabsChanged = [...new Set(allOutboundDiffs.map((d) => d.tabName).filter(Boolean))];
      const readableRows = [...inReadable.items, ...outReadable.items].slice(0, 12);

      const summaryParts = [];
      if (allInboundDiffs.length > 0) {
        summaryParts.push(
          `${shouldApplyInboundNow ? "Pulled" : "Would pull"} ${allInboundDiffs.length} field(s) across ${inReadable.totalRowsChanged} row(s) (${inboundAppliedTabs.join(", ")})`
        );
      }
      if (allOutboundDiffs.length > 0 || effectiveStructuralCount > 0) {
        summaryParts.push(
          `${effectiveMode === "live" && wantsOutbound ? "Pushed" : "Would push"} ${allOutboundDiffs.length} field(s) across ${outReadable.totalRowsChanged} row(s)${outboundTabsChanged.length > 0 ? ` (${outboundTabsChanged.join(", ")})` : ""
          }${effectiveStructuralCount > 0 ? ` + ${effectiveStructuralCount} row layout change(s)` : ""}`
        );
      }
      if (allConflicts.length > 0) {
        summaryParts.push(`${allConflicts.length} same-cell conflict(s) (Sheet kept)`);
      }
      if (summaryParts.length === 0) {
        summaryParts.push(`In sync — no differences found (Drive v${finalDriveVersion || "?"})`);
      }

      const nowIso = new Date().toISOString();
      const summaryText = summaryParts.join("; ");
      const shouldLog =
        force ||
        allInboundDiffs.length > 0 ||
        allOutboundDiffs.length > 0 ||
        allConflicts.length > 0 ||
        effectiveStructuralCount > 0;

      const logEntry = shouldLog
        ? {
          timestamp: nowIso,
          mode: effectiveMode,
          direction,
          driveVersion: finalDriveVersion,
          inboundCount: allInboundDiffs.length,
          outboundCount: allOutboundDiffs.length,
          rangeCount: outboundValueRanges.length,
          structuralCount: effectiveStructuralCount,
          conflictCount: allConflicts.length,
          formulaProtectedCount: totalFormulaProtected,
          summary: summaryText,
          readableRows,
          sampleDiffs,
        }
        : null;

      const statePatch = {
        lastSyncedDriveVersion: shouldSaveBaseline ? finalDriveVersion : (baseline.driveVersion || finalDriveVersion),
        lastSyncedModifiedTime: finalModifiedTime || driveMeta.modifiedTime,
        lastError: "",
        lastSummary: summaryText,
        ...(shouldApplyInboundNow ? { lastInboundAt: nowIso } : {}),
        ...(wantsOutbound && effectiveMode === "live" && hasOutboundWork
          ? { lastOutboundAt: nowIso, lastPulseWrittenVersion: finalDriveVersion }
          : {}),
        ...(effectiveMode === "dry_run" ? { lastDryRunAt: nowIso } : {}),
      };
      await updateClientBridgeState_(supabase, ctx.clientName, statePatch, logEntry);

      if (wantsOutbound && effectiveMode === "live" && dirtiedMidFlightTabs.length > 0) {
        scheduleOutboundSheetBridgeSync(ctx.clientName, dirtiedMidFlightTabs);
      }

      return {
        success: true,
        mode: effectiveMode,
        direction,
        driveVersion: finalDriveVersion,
        inboundChanged: allInboundDiffs.length > 0,
        inboundCount: allInboundDiffs.length,
        outboundChanged: allOutboundDiffs.length > 0 || effectiveStructuralCount > 0,
        outboundCount: allOutboundDiffs.length,
        outboundRangesCount: outboundValueRanges.length,
        structuralCount: effectiveStructuralCount,
        conflictCount: allConflicts.length,
        formulaCellsProtectedCount: totalFormulaProtected,
        summary: summaryText,
        readableRows,
        sampleDiffs,
      };
    } catch (err) {
      await updateClientBridgeState_(
        supabase,
        ctx.clientName,
        { lastError: err.message },
        {
          timestamp: new Date().toISOString(),
          mode: effectiveMode,
          direction,
          summary: `Bridge error: ${err.message}`,
          error: true,
        }
      ).catch(() => { });
      throw err;
    } finally {
      if (lockToken && lockToken !== "no-redis") await releaseRedisBridgeLock_(key, lockToken);
    }
  })();

  _inFlightBridgeByClient.set(key, runPromise);
  try {
    return await runPromise;
  } finally {
    if (_inFlightBridgeByClient.get(key) === runPromise) {
      _inFlightBridgeByClient.delete(key);
    }
  }
}

/**
 * Admin toggle for a tenant's `sheet_bridge_mode` (`"off"` | `"dry_run"` | `"live"`).
 * Automatically initializes `SheetBridgeBaseline` when enabling if one does not exist yet.
 */
export async function setClientSheetBridgeMode(sheets, clientName, targetMode) {
  const cleanMode = String(targetMode || "off").trim().toLowerCase();
  if (!["off", "dry_run", "live"].includes(cleanMode)) {
    throw new Error(`Invalid sheet_bridge_mode "${targetMode}". Expected "off", "dry_run", or "live".`);
  }
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  let { data: clientRow, error } = await supabase
    .from("clients")
    .select("id, client_name, client_mode, client_compute_mode, client_sheet_id, grid_storage_retired, metadata")
    .eq("client_name", clientName)
    .maybeSingle();
  if (error && String(error.message || "").includes("client_compute_mode")) {
    ({ data: clientRow, error } = await supabase
      .from("clients")
      .select("id, client_name, client_mode, client_sheet_id, grid_storage_retired, metadata")
      .eq("client_name", clientName)
      .maybeSingle());
  }
  if (error || !clientRow) throw new Error(`Client "${clientName}" not found.`);

  if (cleanMode !== "off") {
    if (clientRow.client_mode !== "supabase") {
      throw new Error(`Enable Client Portal Supabase engine (Step 5) for "${clientName}" before enabling the Google Sheet bridge.`);
    }
    if (!clientRow.client_sheet_id || isVirtualSupabaseSheetId(clientRow.client_sheet_id)) {
      throw new Error(`"${clientName}" has no Google Client Sheet linked for bidirectional syncing.`);
    }
    const { count: blueprintTabCount } = await supabase
      .from("pulse_client_tab_blueprints")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientRow.id)
      .then((r) => r)
      .catch(() => ({ count: 0 }));
    let effectiveClientTabCount = blueprintTabCount || 0;
    if (!effectiveClientTabCount && !clientRow.grid_storage_retired) {
      const { count: clientTabCount } = await supabase
        .from("master_sheet_grids")
        .select("id", { count: "exact", head: true })
        .eq("client_name", clientRow.client_name)
        .or("sheet_role.eq.client,and(sheet_role.eq.master,tab_name.like.Client::%)");
      effectiveClientTabCount = clientTabCount || 0;
    }
    if (!effectiveClientTabCount) {
      throw new Error(`Run "Push sheet data to Supabase" (Step 4) for "${clientName}" before enabling the Google Sheet bridge.`);
    }

    const ctx =
      (await resolveSupabaseSheetContext({ clientName: clientRow.client_name }).catch(() => null)) || {
        clientId: clientRow.id,
        clientName: clientRow.client_name,
        clientSheetId: clientRow.client_sheet_id,
        clientMode: clientRow.client_mode,
        gridStorageRetired: Boolean(clientRow.grid_storage_retired),
        clientComputeMode: String(clientRow.client_compute_mode || clientRow.metadata?.client_compute_mode || "grid_gas").trim().toLowerCase(),
      };
    const prevBridgeMode = String(clientRow.metadata?.sheet_bridge_mode || "off").trim().toLowerCase();
    const existingBase = await loadBaselineRecord_(supabase, ctx);
    if (prevBridgeMode === "off" || !existingBase.driveVersion || Object.keys(existingBase.tabs || {}).length === 0) {
      const { rawDrive } = getPrimaryRawGoogleClients();
      let driveVersion = "";
      let modifiedTime = "";
      if (rawDrive) {
        const meta = await fetchDriveVersionMeta_(rawDrive, clientRow.client_sheet_id).catch(() => null);
        if (meta) {
          driveVersion = meta.version;
          modifiedTime = meta.modifiedTime;
        }
      }
      const tabs = createSafeMap_();
      for (const tName of BRIDGE_ALL_SYNCED_TABS) {
        const rec = await getOrLoadVirtualTabGrid_(ctx, "client", tName, sheets, {
          includeNotes: true,
        }).catch(() => null);
        if (rec) {
          tabs[tName] = { values: rec.values_grid || [], notes: rec.notes_grid || {}, noteBoundsVersion: 1 };
        }
      }
      // Leave driveVersion empty and noteBoundsVersion=1 so the first bridge run pulls any pre-existing sheet edits instead of masking them
      await saveBaselineRecord_(supabase, ctx, { driveVersion: "", tabs, noteBoundsVersion: 1 });
      await updateClientBridgeState_(
        supabase,
        clientRow.client_name,
        {
          lastSyncedDriveVersion: "",
          lastSyncedModifiedTime: modifiedTime,
          lastSummary: `Bridge enabled (${cleanMode}); baseline captured (current Drive v${driveVersion || "?"})`,
          lastError: "",
        },
        {
          timestamp: new Date().toISOString(),
          mode: cleanMode,
          direction: "mode_change",
          driveVersion,
          summary: `Switched bridge mode to "${cleanMode}" (Drive v${driveVersion || "?"})`,
        },
        cleanMode
      );
      return { clientName: clientRow.client_name, sheetBridgeMode: cleanMode, driveVersion };
    }
  }

  await updateClientBridgeState_(
    supabase,
    clientRow.client_name,
    {
      lastSummary: cleanMode === "off" ? "Sheet bridge turned off" : `Switched bridge mode to "${cleanMode}"`,
      lastError: "",
    },
    {
      timestamp: new Date().toISOString(),
      mode: cleanMode,
      direction: "mode_change",
      summary: `Switched bridge mode to "${cleanMode}"`,
    },
    cleanMode
  );
  return { clientName: clientRow.client_name, sheetBridgeMode: cleanMode };
}

/**
 * Runs a sequential sweep across all live `supabase` clients with
 * `sheet_bridge_mode` set to `'dry_run'` or `'live'`.
 */
export async function runScheduledSheetBridgeSweep() {
  if (!isSupabaseConfigured()) return { checked: 0, synced: 0 };
  const supabase = getSupabaseAdmin();
  if (!supabase) return { checked: 0, synced: 0 };

  const { data: clients, error } = await supabase
    .from("clients")
    .select("client_name, status, client_mode, client_sheet_id, metadata")
    .eq("status", "live")
    .eq("client_mode", "supabase");
  if (error || !Array.isArray(clients) || clients.length === 0) {
    return { checked: 0, synced: 0 };
  }

  const activeBridgeClients = clients.filter((c) => {
    const mode = String(c.metadata?.sheet_bridge_mode || "off").toLowerCase();
    return (
      (mode === "dry_run" || mode === "live") &&
      c.client_sheet_id &&
      !isVirtualSupabaseSheetId(c.client_sheet_id)
    );
  });

  if (activeBridgeClients.length === 0) {
    return { checked: 0, synced: 0 };
  }

  let synced = 0;
  const errors = [];
  for (const c of activeBridgeClients) {
    try {
      const res = await checkAndSyncClientSheetBridge(c.client_name, { direction: "both" });
      if (res?.inboundChanged || res?.outboundChanged) synced++;
    } catch (err) {
      errors.push({ clientName: c.client_name, error: err.message });
    }
  }

  return {
    checked: activeBridgeClients.length,
    synced,
    errors,
  };
}

/**
 * Overwrites editable cells & notes on the live Google Client Sheet to match
 * Supabase virtual client grids while preserving 100% of Google Sheet formulas,
 * and re-anchors `SheetBridgeBaseline` at the resulting Drive version.
 */
export async function pushSupabaseClientToSheet(clientName) {
  if (!isSupabaseConfigured()) throw new Error("Supabase is not configured.");
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);
  if (!ctx.clientSheetId || isVirtualSupabaseSheetId(ctx.clientSheetId)) {
    throw new Error(`Client "${ctx.clientName}" has no Google Client Sheet linked.`);
  }

  await flushPendingClientRecomputes(null, ctx.clientName).catch(() => { });

  const key = normalizeKey_(ctx.clientName);
  const supabase = getSupabaseAdmin();
  const lockOk = await acquireRedisBridgeLock_(key, 60);
  if (!lockOk) {
    throw new Error(`Another sheet bridge operation is currently running for "${ctx.clientName}". Please retry in a moment.`);
  }

  try {
    const { rawDrive, rawSheets } = getPrimaryRawGoogleClients();
    if (!rawDrive || !rawSheets) {
      throw new Error("Primary Google Service Account Drive/Sheets clients unavailable.");
    }

    const [confirmedRec, pipelineRec] = await Promise.all([
      getOrLoadVirtualTabGrid_(ctx, "client", "Confirmed", rawSheets, { includeNotes: true }).catch(() => null),
      getOrLoadVirtualTabGrid_(ctx, "client", "Pipeline", rawSheets, { includeNotes: true }).catch(() => null),
    ]);
    if (!confirmedRec || !Array.isArray(confirmedRec.values_grid) || confirmedRec.values_grid.length === 0) {
      throw new Error(`"${ctx.clientName}" has no Client Sheet data in Supabase yet. Run "Push sheet data to Supabase" first.`);
    }

    const sheetBundle = await fetchRealSheetTabsAndNotes_(
      rawSheets,
      ctx.clientSheetId,
      [...BRIDGE_ALL_SYNCED_TABS, "OutgNotes"],
      {
        minRowHorizonByTab: {
          Confirmed: findLastActiveJobRowCount_(confirmedRec.values_grid || []),
          Pipeline: findLastActiveJobRowCount_(pipelineRec?.values_grid || []),
        },
      }
    );

    const allOutboundDiffs = [];
    const tabGridsMap = createSafeMap_();
    const outboundValueRanges = [];
    const outboundNoteRequests = [];
    const maxTargetRowByTab = createSafeMap_();
    const nextBaselineTabs = createSafeMap_();
    let totalFormulaProtected = 0;
    let tabsSyncedCount = 0;

    for (const tabName of BRIDGE_ALL_SYNCED_TABS) {
      const sheetTab = sheetBundle?.resultByTab?.[tabName];
      if (!sheetTab) continue;

      const supaRec =
        tabName === "Confirmed"
          ? confirmedRec
          : tabName === "Pipeline"
            ? pipelineRec
            : await getOrLoadVirtualTabGrid_(ctx, "client", tabName, rawSheets, {
              includeNotes: true,
            }).catch(() => null);
      if (!supaRec || !Array.isArray(supaRec.values_grid) || supaRec.values_grid.length === 0) {
        continue;
      }

      tabsSyncedCount++;
      tabGridsMap[tabName] = {
        supaValues: supaRec.values_grid || [],
        sheetValues: sheetTab.values || [],
      };

      // Baseline = live Sheet so computeThreeWayTabMerge emits every allowed Supabase -> Sheet diff (including clears)
      const merge = computeThreeWayTabMerge({
        tabName,
        baselineValues: sheetTab.values,
        baselineNotes: sheetTab.notes,
        sheetValues: sheetTab.values,
        sheetFormulas: sheetTab.formulas,
        sheetNotes: sheetTab.notes,
        supaValues: supaRec.values_grid || [],
        supaFormulas: supaRec.formulas_grid || supaRec.values_grid || [],
        supaNotes: supaRec.notes_grid || {},
        applyOutboundToBaseline: true,
        supportsNotesOverride: sheetBundle?.notesFetchFailed ? false : null,
        fetchedNoteBounds: sheetBundle?.fetchedNoteBoundsByTab || null,
        maxRowBound: sheetTab.scannedRowLimit || null,
      });

      totalFormulaProtected += merge.formulaCellsProtectedCount;
      if (merge.outboundCellChanges.length > 0) {
        allOutboundDiffs.push(...merge.outboundCellChanges);
        for (const ch of merge.outboundCellChanges) {
          const curMax = maxTargetRowByTab[tabName] || 0;
          if (ch.row0 + 1 > curMax) maxTargetRowByTab[tabName] = ch.row0 + 1;
        }
        outboundValueRanges.push(...coalesceRowChangesToBatchRanges(tabName, merge.outboundCellChanges));
      }
      if (merge.outboundNoteChanges.length > 0) {
        allOutboundDiffs.push(...merge.outboundNoteChanges.map((n) => ({ ...n, isNote: true })));
        for (const n of merge.outboundNoteChanges) {
          const curMax = maxTargetRowByTab[tabName] || 0;
          if (n.row0 + 1 > curMax) maxTargetRowByTab[tabName] = n.row0 + 1;
        }
        outboundNoteRequests.push(...buildUpdateCellsNoteRequests_(sheetTab.sheetId, merge.outboundNoteChanges));
      }

      if (tabName === "Outgoings" && sheetBundle?.resultByTab?.OutgNotes) {
        const supaOutNotes = cloneSafeNotes_(supaRec.notes_grid);
        const fullOutgMirrorChanges = [];
        for (let r0 = 12; r0 <= 110; r0++) {
          for (let c0 = 6; c0 <= 47; c0++) {
            fullOutgMirrorChanges.push({
              row0: r0,
              col0: c0,
              to: supaOutNotes[`${r0}:${c0}`] || "",
            });
          }
        }
        const outgNotesRanges = buildOutgNotesMirrorUpdates(
          fullOutgMirrorChanges,
          sheetBundle.resultByTab.OutgNotes.values || []
        );
        outboundValueRanges.push(...outgNotesRanges);
      }

      nextBaselineTabs[tabName] = {
        values: merge.nextBaselineValues,
        notes: merge.nextBaselineNotes,
        noteBoundsVersion: sheetBundle?.notesFetchFailed ? 1 : CURRENT_NOTE_BOUNDS_VERSION,
      };
    }

    if (redisClient?.isOpen) {
      redisClient.del(`pulse:sheet_bridge_dirty:${key}`).catch(() => { });
    }

    // Expand grid rows where Supabase grew beyond the Google Sheet grid height
    const structuralBatch = [];
    for (const [tName, reqMaxRow] of Object.entries(maxTargetRowByTab)) {
      if (PROTOTYPE_KEYS.has(tName)) continue;
      const props = sheetBundle?.sheetPropsByTitle?.[tName];
      if (props && reqMaxRow > props.rowCount) {
        structuralBatch.push({
          insertDimension: {
            range: {
              sheetId: props.sheetId,
              dimension: "ROWS",
              startIndex: props.rowCount,
              endIndex: reqMaxRow + 15,
            },
            inheritFromBefore: true,
          },
        });
      }
    }
    if (structuralBatch.length > 0) {
      await withRetry(() =>
        rawSheets.spreadsheets.batchUpdate({
          spreadsheetId: ctx.clientSheetId,
          requestBody: { requests: structuralBatch },
        })
      );
    }

    for (let i = 0; i < outboundValueRanges.length; i += 250) {
      const chunk = outboundValueRanges.slice(i, i + 250);
      await withRetry(() =>
        rawSheets.spreadsheets.values.batchUpdate({
          spreadsheetId: ctx.clientSheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: chunk,
          },
        })
      );
    }

    for (let i = 0; i < outboundNoteRequests.length; i += 400) {
      const chunk = outboundNoteRequests.slice(i, i + 400);
      await withRetry(() =>
        rawSheets.spreadsheets.batchUpdate({
          spreadsheetId: ctx.clientSheetId,
          requestBody: { requests: chunk },
        })
      );
    }

    await clearPendingStructuralOpsById_(key, null);

    const finalDriveMeta = await fetchDriveVersionMeta_(rawDrive, ctx.clientSheetId).catch(() => ({
      version: "",
      modifiedTime: "",
    }));

    await saveBaselineRecord_(supabase, ctx, {
      driveVersion: finalDriveMeta.version,
      tabs: nextBaselineTabs,
      noteBoundsVersion: sheetBundle?.notesFetchFailed ? 1 : CURRENT_NOTE_BOUNDS_VERSION,
    });

    const nowIso = new Date().toISOString();
    const outReadable = buildHumanReadableBridgeRows(allOutboundDiffs, tabGridsMap, "Supabase → Sheet", 10);
    const readableRows = outReadable.items.slice(0, 12);
    const outboundTabsChanged = [...new Set(allOutboundDiffs.map((d) => d.tabName).filter(Boolean))];
    const summaryText =
      outboundValueRanges.length > 0 || outboundNoteRequests.length > 0
        ? `Pushed Supabase data to Google Sheet: ${allOutboundDiffs.length} field(s) across ${outReadable.totalRowsChanged} row(s) (${outboundTabsChanged.join(", ")}) (Drive v${finalDriveMeta.version || "?"})`
        : `Google Sheet already matches Supabase across ${tabsSyncedCount} tab(s) (Drive v${finalDriveMeta.version || "?"})`;

    const sampleDiffs = allOutboundDiffs.slice(0, 20).map((d) => ({
      direction: "out",
      tab: d.tabName,
      cell: d.cellA1,
      from: d.from,
      to: d.to,
    }));

    await updateClientBridgeState_(
      supabase,
      ctx.clientName,
      {
        lastSyncedDriveVersion: finalDriveMeta.version,
        lastSyncedModifiedTime: finalDriveMeta.modifiedTime,
        lastPulseWrittenVersion: finalDriveMeta.version,
        lastOutboundAt: nowIso,
        lastError: "",
        lastSummary: summaryText,
      },
      {
        timestamp: nowIso,
        mode: ctx.sheetBridgeMode || "off",
        direction: "full_push_to_sheet",
        driveVersion: finalDriveMeta.version,
        inboundCount: 0,
        outboundCount: allOutboundDiffs.length,
        rangeCount: outboundValueRanges.length,
        structuralCount: structuralBatch.length,
        conflictCount: 0,
        formulaProtectedCount: totalFormulaProtected,
        summary: summaryText,
        readableRows,
        sampleDiffs,
      }
    );

    return {
      success: true,
      clientName: ctx.clientName,
      clientSheetId: ctx.clientSheetId,
      masterSheetId: ctx.masterSheetId,
      tabsSyncedCount,
      updatedCellsCount: allOutboundDiffs.length,
      updatedRangesCount: outboundValueRanges.length,
      updatedNotesCount: outboundNoteRequests.length,
      formulaCellsProtectedCount: totalFormulaProtected,
      driveVersion: finalDriveMeta.version,
      summary: summaryText,
      readableRows,
    };
  } catch (err) {
    await updateClientBridgeState_(
      supabase,
      ctx.clientName,
      { lastError: err.message },
      {
        timestamp: new Date().toISOString(),
        mode: ctx.sheetBridgeMode || "off",
        direction: "full_push_to_sheet",
        summary: `Full push error: ${err.message}`,
        error: true,
      }
    ).catch(() => { });
    throw err;
  } finally {
    if (lockOk) await releaseRedisBridgeLock_(key, lockOk);
  }
}

export const forceOverwriteSheetFromSupabase = pushSupabaseClientToSheet;

function formatParityMonthHeader_(rawHdr, col0) {
  const numHdr = typeof rawHdr === "number"
    ? rawHdr
    : (/^\d{5}(?:\.\d+)?$/.test(String(rawHdr ?? "").trim()) ? Number(rawHdr) : NaN);
  if (Number.isFinite(numHdr) && numHdr >= 35000 && numHdr <= 70000) {
    const dt = new Date(Math.round((numHdr - 25569) * 86400 * 1000));
    if (!Number.isNaN(dt.getTime())) {
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${months[dt.getUTCMonth()]}-${String(dt.getUTCFullYear()).slice(-2)}`;
    }
  }
  const s = String(rawHdr ?? "").replace(/\s+/g, " ").trim();
  if (s) return s.length > 18 ? `${s.slice(0, 16).trimEnd()}…` : s;
  return `Col ${colIdx0ToLetter(col0)}`;
}

function extractParityRowLabel_(sRow = [], gRow = [], r0 = 0) {
  for (const colIdx of [0, 1]) {
    const raw = sRow[colIdx] !== undefined && sRow[colIdx] !== "" ? sRow[colIdx] : gRow[colIdx];
    const clean = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (clean && parseComparableNumber_(clean) === null) {
      return clean.length > 34 ? `${clean.slice(0, 32).trimEnd()}…` : clean;
    }
  }
  return `Row ${r0 + 1}`;
}

const SPREADSHEET_ERROR_TOKEN_RE = /^#(REF!|VALUE!|NAME\?|ERROR!|N\/A|NUM!|DIV\/0!)/i;

function compareHeadlineTabGrid_(
  tabName,
  sheetVals = [],
  supaVals = [],
  { maxRows = 45, minColIdx = 2, maxCols = 20, headerRowIdx = 3, minDataRowIdx = 4, tolerance = 1.0 } = {}
) {
  const mismatches = [];
  const limitRows = Math.min(maxRows, Math.max(sheetVals.length, supaVals.length));
  const hdrRowSupa = Array.isArray(supaVals[headerRowIdx]) ? supaVals[headerRowIdx] : [];
  const hdrRowSheet = Array.isArray(sheetVals[headerRowIdx]) ? sheetVals[headerRowIdx] : [];

  for (let r = minDataRowIdx; r < limitRows; r++) {
    const gR = Array.isArray(sheetVals[r]) ? sheetVals[r] : [];
    const sR = Array.isArray(supaVals[r]) ? supaVals[r] : [];
    const rowLabel = extractParityRowLabel_(sR, gR, r);

    for (let c = minColIdx; c < maxCols; c++) {
      const gV = gR[c] ?? "";
      const sV = sR[c] ?? "";
      const strG = String(gV).trim();
      const strS = String(sV).trim();

      if (SPREADSHEET_ERROR_TOKEN_RE.test(strG) || SPREADSHEET_ERROR_TOKEN_RE.test(strS)) {
        mismatches.push({
          tab: tabName,
          cell: `${colIdx0ToLetter(c)}${r + 1}`,
          rowLabel,
          colLabel: formatParityMonthHeader_(hdrRowSupa[c] ?? hdrRowSheet[c], c),
          sheetValue: strG || "—",
          supabaseValue: strS || "—",
        });
        continue;
      }

      if ((gV === "" && sV === 0) || (gV === 0 && sV === "") || (gV === "" && sV === "")) {
        continue;
      }

      const nG = parseComparableNumber_(gV);
      const nS = parseComparableNumber_(sV);
      if (nG !== null && nS !== null) {
        if (Math.abs(nG - nS) <= tolerance) continue;
        mismatches.push({
          tab: tabName,
          cell: `${colIdx0ToLetter(c)}${r + 1}`,
          rowLabel,
          colLabel: formatParityMonthHeader_(hdrRowSupa[c] ?? hdrRowSheet[c], c),
          sheetValue: Math.round(nG * 100) / 100,
          supabaseValue: Math.round(nS * 100) / 100,
        });
        continue;
      }

      if (strG === strS) continue;

      mismatches.push({
        tab: tabName,
        cell: `${colIdx0ToLetter(c)}${r + 1}`,
        rowLabel,
        colLabel: formatParityMonthHeader_(hdrRowSupa[c] ?? hdrRowSheet[c], c),
        sheetValue: nG !== null ? Math.round(nG * 100) / 100 : strG,
        supabaseValue: nS !== null ? Math.round(nS * 100) / 100 : strS,
      });
    }
  }
  return mismatches;
}

function scanPureSupabaseHeadlineTabs_(dashVals = [], year0Vals = [], cashVals = []) {
  const dashDiffs = [];
  const cashDiffs = [];

  const scanErrorTokens = (tabName, grid, maxR, minC, maxC, hdrRowIdx, out) => {
    const hdrRow = Array.isArray(grid[hdrRowIdx]) ? grid[hdrRowIdx] : [];
    for (let r = 0; r < Math.min(maxR, grid.length); r++) {
      const row = Array.isArray(grid[r]) ? grid[r] : [];
      const rowLabel = extractParityRowLabel_(row, [], r);
      for (let c = minC; c < maxC; c++) {
        const s = String(row[c] ?? "").trim();
        if (SPREADSHEET_ERROR_TOKEN_RE.test(s)) {
          out.push({
            tab: tabName,
            cell: `${colIdx0ToLetter(c)}${r + 1}`,
            rowLabel,
            colLabel: formatParityMonthHeader_(hdrRow[c], c),
            sheetValue: "No formula error",
            supabaseValue: s,
          });
        }
      }
    }
  };

  scanErrorTokens("Dashboard", dashVals, 34, 6, 50, 0, dashDiffs);
  scanErrorTokens("Year0Data", year0Vals, 34, 6, 20, 0, dashDiffs);
  scanErrorTokens("Cash", cashVals, 76, 1, 37, 0, cashDiffs);

  // Verify internal P&L identity equations on Dashboard
  const findDashRow = (regex) => {
    for (let r = 2; r < Math.min(34, dashVals.length); r++) {
      const lbl = String(dashVals[r]?.[0] ?? "").trim();
      if (regex.test(lbl)) return r;
    }
    return -1;
  };
  const rConf = findDashRow(/^confirmed\s+(revenue|income)/i);
  const rPipe = findDashRow(/^pipeline\s+(revenue|income)/i);
  const rNb = findDashRow(/^new business.*(revenue|income)/i);
  const rTotRev = findDashRow(/^total\s+(revenue|income)/i);
  const rTotCos = findDashRow(/^total\s+costs\s+of\s+sale/i);
  const rGp = findDashRow(/^gross\s+profit$/i);
  const rTotOh = findDashRow(/^total\s+overheads$/i);
  const rOp = findDashRow(/^operating\s+profit$/i);

  const dashHdr = Array.isArray(dashVals[0]) ? dashVals[0] : [];
  for (let c = 6; c < 50; c++) {
    if (c === 18 || c === 20 || c === 33 || c === 35 || c === 48) continue;
    const nTotRev = rTotRev >= 0 ? parseComparableNumber_(dashVals[rTotRev]?.[c]) : null;
    if (nTotRev === null) continue;
    const colLabel = formatParityMonthHeader_(dashHdr[c], c);
    if (rConf >= 0 && rPipe >= 0 && rNb >= 0) {
      const sumRev =
        (parseComparableNumber_(dashVals[rConf]?.[c]) || 0) +
        (parseComparableNumber_(dashVals[rPipe]?.[c]) || 0) +
        (parseComparableNumber_(dashVals[rNb]?.[c]) || 0);
      if (Math.abs(nTotRev - sumRev) > 1.0) {
        dashDiffs.push({
          tab: "Dashboard",
          cell: `${colIdx0ToLetter(c)}${rTotRev + 1}`,
          rowLabel: extractParityRowLabel_(dashVals[rTotRev], [], rTotRev),
          colLabel,
          sheetValue: Math.round(sumRev * 100) / 100,
          supabaseValue: Math.round(nTotRev * 100) / 100,
        });
      }
    }
    const nGp = rGp >= 0 ? parseComparableNumber_(dashVals[rGp]?.[c]) : null;
    const nCos = rTotCos >= 0 ? parseComparableNumber_(dashVals[rTotCos]?.[c]) : null;
    if (nGp !== null && nCos !== null && Math.abs(nGp - (nTotRev - nCos)) > 1.0) {
      dashDiffs.push({
        tab: "Dashboard",
        cell: `${colIdx0ToLetter(c)}${rGp + 1}`,
        rowLabel: extractParityRowLabel_(dashVals[rGp], [], rGp),
        colLabel,
        sheetValue: Math.round((nTotRev - nCos) * 100) / 100,
        supabaseValue: Math.round(nGp * 100) / 100,
      });
    }
    const nOp = rOp >= 0 ? parseComparableNumber_(dashVals[rOp]?.[c]) : null;
    const nOh = rTotOh >= 0 ? parseComparableNumber_(dashVals[rTotOh]?.[c]) : null;
    if (nOp !== null && nGp !== null && nOh !== null && Math.abs(nOp - (nGp - nOh)) > 1.0) {
      dashDiffs.push({
        tab: "Dashboard",
        cell: `${colIdx0ToLetter(c)}${rOp + 1}`,
        rowLabel: extractParityRowLabel_(dashVals[rOp], [], rOp),
        colLabel,
        sheetValue: Math.round((nGp - nOh) * 100) / 100,
        supabaseValue: Math.round(nOp * 100) / 100,
      });
    }
  }

  // Verify Cash Closing balance === Opening balance + Net cash movement for each section
  const findCashRowsByLabel = (regex) => {
    const out = [];
    for (let r = 0; r < Math.min(76, cashVals.length); r++) {
      const lbl = String(cashVals[r]?.[0] ?? "").trim();
      if (regex.test(lbl)) out.push(r);
    }
    return out;
  };
  const openRows = findCashRowsByLabel(/^opening\s+balance/i);
  const netRows = findCashRowsByLabel(/^net\s+cash\s+movement/i);
  const closeRows = findCashRowsByLabel(/^closing\s+balance/i);
  const cashHdr = Array.isArray(cashVals[0]) ? cashVals[0] : [];
  const sectionCount = Math.min(openRows.length, netRows.length, closeRows.length);
  for (let s = 0; s < sectionCount; s++) {
    const rOpen = openRows[s];
    const rNet = netRows[s];
    const rClose = closeRows[s];
    for (let c = 1; c < 37; c++) {
      const nOpen = parseComparableNumber_(cashVals[rOpen]?.[c]);
      const nNet = parseComparableNumber_(cashVals[rNet]?.[c]);
      const nClose = parseComparableNumber_(cashVals[rClose]?.[c]);
      if (nOpen === null || nNet === null || nClose === null) continue;
      if (Math.abs(nClose - (nOpen + nNet)) > 1.0) {
        cashDiffs.push({
          tab: "Cash",
          cell: `${colIdx0ToLetter(c)}${rClose + 1}`,
          rowLabel: extractParityRowLabel_(cashVals[rClose], [], rClose),
          colLabel: formatParityMonthHeader_(cashHdr[c], c),
          sheetValue: Math.round((nOpen + nNet) * 100) / 100,
          supabaseValue: Math.round(nClose * 100) / 100,
        });
      }
    }
  }

  return { dashDiffs, cashDiffs };
}

/**
 * Verifies live Google Sheet `Dashboard`, `Year0Data`, and `Cash` parity against Supabase
 * across active bridged clients (and internal consistency for pure-Supabase clients when requested).
 */
export async function verifyBridgedClientsParity({
  clientName = null,
  includePureSupabase = false,
  settleOnMismatch = false,
  skipRelationalSummary = false,
} = {}) {
  if (!isSupabaseConfigured()) throw new Error("Supabase is not configured.");
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase admin client unavailable.");

  const { rawDrive, rawSheets } = getPrimaryRawGoogleClients();
  if (!rawDrive || !rawSheets) {
    throw new Error("Primary Google Service Account Drive/Sheets clients unavailable.");
  }

  let query = supabase
    .from("clients")
    .select("id, client_name, status, master_mode, client_mode, jobs_mode, inputs_mode, client_compute_mode, master_compute_mode, client_sheet_id, master_sheet_id, metadata")
    .order("client_name", { ascending: true });

  if (clientName) {
    query = query.eq("client_name", String(clientName).trim());
  }

  let { data: rows, error } = await query;
  if (error && (String(error.message || "").includes("client_compute_mode") || String(error.message || "").includes("master_compute_mode"))) {
    let fbQuery = supabase
      .from("clients")
      .select("id, client_name, status, master_mode, client_mode, jobs_mode, inputs_mode, client_sheet_id, master_sheet_id, metadata")
      .order("client_name", { ascending: true });
    if (clientName) {
      fbQuery = fbQuery.eq("client_name", String(clientName).trim());
    }
    ({ data: rows, error } = await fbQuery);
  }
  if (error) throw new Error(`Could not query clients: ${error.message}`);

  const targets = (rows || []).filter((c) => {
    const effStatus = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
    if (!c.client_name || ["inactive", "archived", "suspended"].includes(effStatus)) return false;
    const bMode = String(c.metadata?.sheet_bridge_mode || "off").toLowerCase();
    const hasRealSheet = Boolean(c.client_sheet_id && !isVirtualSupabaseSheetId(c.client_sheet_id));
    if ((bMode === "live" || bMode === "dry_run") && hasRealSheet) return true;
    return Boolean(includePureSupabase);
  });

  const results = [];
  for (let i = 0; i < targets.length; i += 4) {
    const batch = targets.slice(i, i + 4);
    const batchRes = await Promise.all(
      batch.map(async (c) => {
        const bridgeMode = String(c.metadata?.sheet_bridge_mode || "off").toLowerCase();
        const st = c.metadata?.sheet_bridge_state || {};
        const lastSynced = String(st.lastSyncedDriveVersion || "");
        const lastPulse = String(st.lastPulseWrittenVersion || "");
        const recentConflictCount = Number(st.recentLogs?.[0]?.conflictCount || 0);
        const hasRealSheet = Boolean(c.client_sheet_id && !isVirtualSupabaseSheetId(c.client_sheet_id));
        const isBridgedTarget = (bridgeMode === "live" || bridgeMode === "dry_run") && hasRealSheet;
        const ctx =
          (await resolveSupabaseSheetContext({ clientName: c.client_name }).catch(() => null)) || {
            clientId: c.id,
            clientName: c.client_name,
            clientSheetId: c.client_sheet_id,
            masterSheetId: c.master_sheet_id,
            clientMode: c.client_mode,
            masterMode: c.master_mode,
            clientComputeMode: String(c.client_compute_mode || c.metadata?.client_compute_mode || "grid_gas").trim().toLowerCase(),
            masterComputeMode: String(c.master_compute_mode || c.metadata?.master_compute_mode || "grid_gas").trim().toLowerCase(),
          };

        try {
          if (!isBridgedTarget) {
            const relJobsMode = String(c.jobs_mode || c.metadata?.jobs_mode || "grid").toLowerCase();
            const relInputsMode = String(c.inputs_mode || c.metadata?.inputs_mode || "grid").toLowerCase();
            const [supaDash, supaYear0, supaCash, relParity, relInputsParity] = await Promise.all([
              getOrLoadVirtualTabGrid_(ctx, "client", "Dashboard", rawSheets, { valuesOnly: true }).catch(() => null),
              getOrLoadVirtualTabGrid_(ctx, "client", "Year0Data", rawSheets, { valuesOnly: true }).catch(() => null),
              getOrLoadVirtualTabGrid_(ctx, "client", "Cash", rawSheets, { valuesOnly: true }).catch(() => null),
              !skipRelationalSummary && relJobsMode === "relational"
                ? verifyRelationalJobsParity({ clientName: c.client_name, source: "db" }).catch(() => null)
                : Promise.resolve(null),
              !skipRelationalSummary && relInputsMode === "relational"
                ? verifyRelationalInputsParity({ clientName: c.client_name, source: "db" }).catch(() => null)
                : Promise.resolve(null),
            ]);

            const { dashDiffs, cashDiffs } = scanPureSupabaseHeadlineTabs_(
              supaDash?.values_grid || [],
              supaYear0?.values_grid || [],
              supaCash?.values_grid || []
            );

            const jobRec = relParity?.results?.[0];
            if (jobRec && (jobRec.error || !jobRec.matched)) {
              dashDiffs.push({
                tab: "Relational jobs",
                cell: "pulse_jobs",
                rowLabel: "Relational job parity",
                colLabel: "DB",
                sheetValue: "0 mismatches",
                supabaseValue: jobRec.error ? String(jobRec.error) : `${jobRec.totalMismatchCount || 1} diff(s)`,
              });
            }

            const inRec = relInputsParity?.results?.[0];
            if (inRec && (inRec.error || !inRec.matched)) {
              dashDiffs.push({
                tab: "Relational inputs",
                cell: "pulse_inputs",
                rowLabel: "Relational inputs parity",
                colLabel: "DB",
                sheetValue: "0 mismatches",
                supabaseValue: inRec.error ? String(inRec.error) : `${inRec.totalMismatchCount || 1} diff(s)`,
              });
            }

            const totalMismatchCount = dashDiffs.length + cashDiffs.length;
            return {
              clientName: c.client_name,
              bridgeMode: "pure_supabase",
              driveVersion: "",
              lastSyncedDriveVersion: "",
              driveInSync: true,
              matched: !st.lastError && totalMismatchCount === 0,
              lastError: String(st.lastError || ""),
              lastSummary: String(st.lastSummary || ""),
              recentConflictCount: 0,
              dashboardMismatchCount: dashDiffs.length,
              cashMismatchCount: cashDiffs.length,
              totalMismatchCount,
              sampleMismatches: [...dashDiffs.slice(0, 6), ...cashDiffs.slice(0, 6)].slice(0, 10),
              error: null,
            };
          }

          const fetchLivePair = async () => {
            const [driveMeta, sheetResp, supaDash, supaYear0, supaCash] = await Promise.all([
              fetchDriveVersionMeta_(rawDrive, c.client_sheet_id).catch(() => null),
              withRetry(() =>
                rawSheets.spreadsheets.values.batchGet({
                  spreadsheetId: c.client_sheet_id,
                  ranges: ["Dashboard!A1:AX34", "Year0Data!A1:T34", "Cash!A1:AK76"],
                  valueRenderOption: "UNFORMATTED_VALUE",
                })
              ),
              getOrLoadVirtualTabGrid_(ctx, "client", "Dashboard", rawSheets, { valuesOnly: true }).catch(() => null),
              getOrLoadVirtualTabGrid_(ctx, "client", "Year0Data", rawSheets, { valuesOnly: true }).catch(() => null),
              getOrLoadVirtualTabGrid_(ctx, "client", "Cash", rawSheets, { valuesOnly: true }).catch(() => null),
            ]);

            const gDashVals = sheetResp?.data?.valueRanges?.[0]?.values || [];
            const gYear0Vals = sheetResp?.data?.valueRanges?.[1]?.values || [];
            const gCashVals = sheetResp?.data?.valueRanges?.[2]?.values || [];
            const sDashVals = supaDash?.values_grid || [];
            const sYear0Vals = supaYear0?.values_grid || [];
            const sCashVals = supaCash?.values_grid || [];

            const mainDashDiffs = compareHeadlineTabGrid_("Dashboard", gDashVals, sDashVals, {
              maxRows: 34,
              minColIdx: 6,
              maxCols: 50,
              headerRowIdx: 0,
              minDataRowIdx: 3,
              tolerance: 0.5,
            });
            const y0Diffs = compareHeadlineTabGrid_("Year0Data", gYear0Vals, sYear0Vals, {
              maxRows: 34,
              minColIdx: 6,
              maxCols: 20,
              headerRowIdx: 0,
              minDataRowIdx: 3,
              tolerance: 0.5,
            });
            const cashDiffs = compareHeadlineTabGrid_("Cash", gCashVals, sCashVals, {
              maxRows: 76,
              minColIdx: 1,
              maxCols: 37,
              headerRowIdx: 0,
              minDataRowIdx: 3,
              tolerance: 0.5,
            });

            return {
              driveMeta,
              dashDiffs: [...mainDashDiffs, ...y0Diffs],
              cashDiffs,
            };
          };

          let pair = await fetchLivePair();
          if (settleOnMismatch && (pair.dashDiffs.length + pair.cashDiffs.length) > 0) {
            await new Promise((resolve) => setTimeout(resolve, 2500));
            invalidateMasterEngineCache(c.client_name, "client", ["Dashboard", "Year0Data", "Cash"]);
            pair = await fetchLivePair();
          }

          const { driveMeta, dashDiffs, cashDiffs } = pair;
          const liveVer = String(driveMeta?.version || "");
          const driveInSync = Boolean(!liveVer || liveVer === lastSynced || liveVer === lastPulse);
          const totalMismatchCount = dashDiffs.length + cashDiffs.length;

          return {
            clientName: c.client_name,
            bridgeMode,
            driveVersion: liveVer,
            lastSyncedDriveVersion: lastSynced,
            driveInSync,
            matched: !st.lastError && totalMismatchCount === 0,
            lastError: String(st.lastError || ""),
            lastSummary: String(st.lastSummary || ""),
            recentConflictCount,
            dashboardMismatchCount: dashDiffs.length,
            cashMismatchCount: cashDiffs.length,
            totalMismatchCount,
            sampleMismatches: [...dashDiffs.slice(0, 6), ...cashDiffs.slice(0, 6)].slice(0, 10),
            error: null,
          };
        } catch (clientErr) {
          return {
            clientName: c.client_name,
            bridgeMode,
            driveVersion: "",
            lastSyncedDriveVersion: lastSynced,
            driveInSync: false,
            matched: false,
            lastError: String(st.lastError || ""),
            lastSummary: String(st.lastSummary || ""),
            recentConflictCount,
            dashboardMismatchCount: 0,
            cashMismatchCount: 0,
            totalMismatchCount: 0,
            sampleMismatches: [],
            error: clientErr.message || "Parity check failed.",
          };
        }
      })
    );
    results.push(...batchRes);
  }

  const errorClientsCount = results.filter((r) => Boolean(r.error || r.lastError)).length;
  const mismatchClientsCount = results.filter((r) => !r.error && r.totalMismatchCount > 0).length;
  const matchedClientsCount = results.filter((r) => !r.error && !r.lastError && r.totalMismatchCount === 0).length;

  return {
    success: true,
    checkedAt: new Date().toISOString(),
    clientsChecked: results.length,
    matchedClientsCount,
    mismatchClientsCount,
    errorClientsCount,
    results,
  };
}
