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
  CORE_CLIENT_TABS,
} from "./masterEngineService.js";
import { isCashCellEditable } from "./cashEditService.js";
import { redisClient } from "./redisClient.js";
import { invalidatePmaClientCache } from "./cacheService.js";
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
export const BRIDGE_OUTBOUND_ONLY_TABS = ["KeyInfo"];
export const BRIDGE_ALL_SYNCED_TABS = [...BRIDGE_BIDIRECTIONAL_TABS, ...BRIDGE_OUTBOUND_ONLY_TABS];
export const BRIDGE_NOTE_TABS = new Set(["Confirmed", "Pipeline", "Outgoings", "Cash"]);

const BRIDGE_BIDIRECTIONAL_TAB_SET = new Set(BRIDGE_BIDIRECTIONAL_TABS);
const BRIDGE_OUTBOUND_ONLY_SET = new Set(BRIDGE_OUTBOUND_ONLY_TABS);
const BASELINE_TAB_NAME = "SheetBridgeBaseline";
const OUTBOUND_DEBOUNCE_MS = 1200;
const READ_CHECK_THROTTLE_MS = 15000;
const RECENT_LOG_LIMIT = 15;
const TEXT_ONLY_SLOT_COLS = new Set([42, 49, 56, 81, 88, 95]); // AQ, AX, BE, CD, CK, CR
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CORE_CLIENT_TAB_SET = new Set([...CORE_CLIENT_TABS, "REF", "AppData", "FormCheck"]);

function formulaRefsExternalOrCustomTab_(formulaStr) {
  if (typeof formulaStr !== "string" || !formulaStr.startsWith("=")) return false;
  if (/IMPORTRANGE\s*\(/i.test(formulaStr)) return true;
  const stripped = formulaStr.replace(/"(?:""|[^"])*"/g, "");
  const matches = stripped.matchAll(/(?:'([^']+)'|([A-Za-z0-9_]+))!/g);
  for (const m of matches) {
    const refTab = m[1] || m[2];
    if (refTab && !CORE_CLIENT_TAB_SET.has(refTab)) return true;
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
  Outgoings: { range: "Outgoings!G13:AV112", startRow0: 12, startCol0: 6 },
  Confirmed: { range: "Confirmed!AP2:CR500", startRow0: 1, startCol0: 41 },
  Pipeline: { range: "Pipeline!AP2:CR300", startRow0: 1, startCol0: 41 },
  Cash: { range: "Cash!B1:AK76", startRow0: 0, startCol0: 1 },
};

const _lastReadCheckByClient = new Map();
const _inFlightBridgeByClient = new Map();
const _pendingOutboundByClient = new Map();
const _pendingStructuralOpsByClient = new Map();
const _suppressOutboundByClient = new Set();

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
  if (isSheetFormula && !isNextFormula) {
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

function formatBridgeCellValueForSheet_(col0, val, { isFormula = false } = {}) {
  if (val === undefined || val === null) return "";
  if (isFormula && typeof val === "string" && val.trim().startsWith("=")) {
    return val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  const s = String(val);
  if (TEXT_ONLY_SLOT_COLS.has(col0)) {
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
          formatBridgeCellValueForSheet_(rowChanges[p].col0, rowChanges[p].to, {
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
  maxRowBound = null,
}) {
  const isOutboundOnly = BRIDGE_OUTBOUND_ONLY_SET.has(tabName);
  const supportsNotes = BRIDGE_NOTE_TABS.has(tabName);

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
  const scanRows = Number.isInteger(maxRowBound) && maxRowBound > 0 ? Math.min(maxRows, maxRowBound) : maxRows;
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

      const editableSheetFormulaNeedsPull =
        !isOutboundOnly &&
        isEditablePos &&
        isSheetFormula &&
        !isSheetErrorVal &&
        !didSupaEditFormula &&
        !didSupaOverrideDefaultFormula &&
        (!areBridgeCellsEquivalent(sheetVal, supaVal) || String(sheetForm) !== String(supaForm || ""));

      const inChanged =
        !isOutboundOnly &&
        !isSystemFormulaCell &&
        (editableSheetFormulaNeedsPull ||
          (!isPureFormulaRecalcDrift && !areBridgeCellsEquivalent(sheetVal, baseVal)));

      const outChanged =
        !isPureFormulaRecalcDrift &&
        !(isEditablePos && isSheetFormula && !didSupaEditFormula && !didSupaOverrideDefaultFormula) &&
        !areBridgeCellsEquivalent(supaVal, baseVal);

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
  const nextBaselineNotes = createSafeMap_();
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
      // Preserve untouched non-fetched Outgoings note rows (only sync G13:AV112 on Sheet)
      if (tabName === "Outgoings" && (coords.r0 < 12 || coords.r0 > 111 || coords.c0 < 6 || coords.c0 > 47)) {
        if (safeSupaNotes[k]) nextBaselineNotes[k] = safeSupaNotes[k];
        continue;
      }
      const bN = safeBaseNotes[k] || "";
      const sN = safeSheetNotes[k] || "";
      const uN = safeSupaNotes[k] || "";
      const inNoteChanged = !isOutboundOnly && sN !== bN;
      const outNoteChanged = uN !== bN;
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
        outboundNoteChanges.push({ tabName, row0: coords.r0, col0: coords.c0, cellA1, from: sN, to: uN });
        const keptNote = applyOutboundToBaseline ? uN : bN;
        if (keptNote) nextBaselineNotes[k] = keptNote;
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
  return noteChanges.map((n) => ({
    updateCells: {
      range: {
        sheetId: gid,
        startRowIndex: n.row0,
        endRowIndex: n.row0 + 1,
        startColumnIndex: n.col0,
        endColumnIndex: n.col0 + 1,
      },
      rows: [{ values: [{ note: String(n.to ?? "") }] }],
      fields: "note",
    },
  }));
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
  const { data } = await supabase
    .from("master_sheet_grids")
    .select("notes_grid, updated_at")
    .eq("client_name", ctx.clientName)
    .eq("sheet_role", "master")
    .eq("tab_name", BASELINE_TAB_NAME)
    .maybeSingle();

  const ng = data?.notes_grid && typeof data.notes_grid === "object" ? data.notes_grid : {};
  const tabsOut = createSafeMap_();
  if (ng.tabs && typeof ng.tabs === "object") {
    for (const [k, v] of Object.entries(ng.tabs)) {
      if (PROTOTYPE_KEYS.has(k) || !v || typeof v !== "object") continue;
      tabsOut[k] = {
        values: Array.isArray(v.values) ? v.values : [],
        notes: cloneSafeNotes_(v.notes),
      };
    }
  }
  return {
    driveVersion: String(ng.driveVersion || ""),
    updatedAt: ng.updatedAt || data?.updated_at || null,
    tabs: tabsOut,
  };
}

async function saveBaselineRecord_(supabase, ctx, { driveVersion = "", tabs = {} }) {
  if (!supabase || !ctx?.clientName) return;
  const compactedTabs = createSafeMap_();
  for (const [tName, tObj] of Object.entries(tabs || {})) {
    if (PROTOTYPE_KEYS.has(tName) || !tObj) continue;
    compactedTabs[tName] = compactBaselineTab_(tObj.values || [], tObj.notes || {});
  }
  const payload = {
    driveVersion: String(driveVersion || ""),
    updatedAt: new Date().toISOString(),
    tabs: compactedTabs,
  };
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
  const noteRangesToFetch = noteTabsPresent.map((t) => {
    if (t === "Confirmed" && boundedLimitByTab.Confirmed) {
      return `Confirmed!AP2:CR${Math.min(boundedLimitByTab.Confirmed, 1000)}`;
    }
    if (t === "Pipeline" && boundedLimitByTab.Pipeline) {
      return `Pipeline!AP2:CR${Math.min(boundedLimitByTab.Pipeline, 600)}`;
    }
    return NOTE_FETCH_RANGES[t].range;
  });

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
    const gridData = sheetObj?.data?.[0];
    const sR = Number(gridData?.startRow ?? cfg.startRow0);
    const sC = Number(gridData?.startColumn ?? cfg.startCol0);
    const notesOut = createSafeMap_();
    (gridData?.rowData || []).forEach((rowObj, rOff) => {
      (rowObj?.values || []).forEach((cellObj, cOff) => {
        if (cellObj?.note) {
          notesOut[`${sR + rOff}:${sC + cOff}`] = String(cellObj.note);
        }
      });
    });
    resultByTab[tName].notes = notesOut;
  }

  return { sheetPropsByTitle, resultByTab };
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
      };
    }
    await saveBaselineRecord_(supabase, ctx, { driveVersion, tabs: baselineTabs });
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
 * so they can be replayed to the paired Google Sheet on the next bridge flush.
 */
export function recordBridgeStructuralRequests(clientName, requests = [], metaBySheetId = new Map()) {
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
    structuralOps.push({ tabName, req: structuredClone(req) });
  }
  if (structuralOps.length > 0) {
    const prev = _pendingStructuralOpsByClient.get(key) || [];
    prev.push(...structuralOps);
    _pendingStructuralOpsByClient.set(key, prev);
  }
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

async function acquireRedisBridgeLock_(normKey, ttlSecs = 30) {
  if (!redisClient?.isOpen) return true;
  try {
    const res = await redisClient.set(`pulse:sheet_bridge_lock:${normKey}`, String(Date.now()), {
      NX: true,
      EX: ttlSecs,
    });
    return res === "OK";
  } catch {
    return true;
  }
}

async function releaseRedisBridgeLock_(normKey) {
  if (!redisClient?.isOpen) return;
  try {
    await redisClient.del(`pulse:sheet_bridge_lock:${normKey}`);
  } catch { }
}

/**
 * Throttled read-time check: if `sheet_bridge_mode === 'live'`, runs a ~60 ms Drive
 * `version` check (at most once per 10s per tenant) and pulls any human sheet edits
 * into Supabase before returning data to PMA / Portal / Proactive checks.
 */
export async function ensureClientSheetBridgeFreshOnRead(ctx, { throttleMs = READ_CHECK_THROTTLE_MS } = {}) {
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
  if (!key || _suppressOutboundByClient.has(key)) return null;

  const now = Date.now();
  if (now - (_lastReadCheckByClient.get(key) || 0) < throttleMs) {
    return null;
  }
  _lastReadCheckByClient.set(key, now);

  if (redisClient?.isOpen) {
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
    const lockOk = await acquireRedisBridgeLock_(key, 30);
    if (!lockOk && !force) {
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

      const wantsInbound =
        direction === "inbound" ||
        direction === "inbound_check" ||
        direction === "both";
      const wantsOutbound = direction === "outbound" || direction === "both";
      const forceInboundFetch = direction === "inbound" || force;

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

      const queuedStructOps = _pendingStructuralOpsByClient.get(key) || [];
      const needRealSheetFetch =
        (wantsInbound && (driveVersionChanged || forceInboundFetch)) ||
        wantsOutbound;

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
        !(wantsInbound && (driveVersionChanged || forceInboundFetch)) &&
        scopedDirtyTabs.length > 0;

      let sheetBundle = null;
      const preloadedSupaByTab = createSafeMap_();
      if (needRealSheetFetch) {
        const tabsToLoad = canScopeToDirtyTabsOnly
          ? [...scopedDirtyTabs, ...(scopedDirtyTabs.includes("Outgoings") ? ["OutgNotes"] : [])]
          : wantsInbound && (driveVersionChanged || forceInboundFetch)
            ? [...BRIDGE_BIDIRECTIONAL_TABS, "KeyInfo", "OutgNotes"]
            : [...BRIDGE_ALL_SYNCED_TABS, "OutgNotes"];
        const minRowHorizonByTab = createSafeMap_();
        await Promise.all(
          ["Confirmed", "Pipeline"].map(async (tName) => {
            if (!tabsToLoad.includes(tName)) return;
            const supaRec = await getOrLoadVirtualTabGrid_(ctx, "client", tName, rawSheets, {
              includeNotes: BRIDGE_NOTE_TABS.has(tName),
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
      const nextBaselineTabs = { ...baseline.tabs };
      const maxTargetRowByTab = createSafeMap_();

      const tabsToProcess = canScopeToDirtyTabsOnly
        ? scopedDirtyTabs
        : wantsOutbound
          ? BRIDGE_ALL_SYNCED_TABS
          : BRIDGE_BIDIRECTIONAL_TABS;

      for (const tabName of tabsToProcess) {
        const sheetTab = sheetBundle?.resultByTab?.[tabName];
        if (!sheetTab) continue;

        const supaRec =
          preloadedSupaByTab[tabName] ||
          (await getOrLoadVirtualTabGrid_(ctx, "client", tabName, rawSheets, {
            includeNotes: BRIDGE_NOTE_TABS.has(tabName),
          }).catch(() => null));
        if (!supaRec) continue;

        tabGridsMap[tabName] = {
          supaValues: supaRec.values_grid || [],
          sheetValues: sheetTab.values || [],
        };

        const baseTab = baseline.tabs?.[tabName] || { values: [], notes: createSafeMap_() };
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
          maxRowBound: sheetTab.scannedRowLimit || null,
        });
        mergeResults.push({ tabName, merge, supaRec, sheetTab });

        if (merge.inboundCellChanges.length > 0 || merge.inboundNoteChanges.length > 0) {
          allInboundDiffs.push(
            ...merge.inboundCellChanges,
            ...merge.inboundNoteChanges.map((n) => ({ ...n, isNote: true }))
          );
          inboundAppliedTabs.push(tabName);
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

        nextBaselineTabs[tabName] = {
          values: merge.nextBaselineValues,
          notes: merge.nextBaselineNotes,
        };
      }

      // Mirror outbound Outgoings notes into OutgNotes!A1:AV111 on Google Sheet
      if (wantsOutbound && outboundOutgoingsNoteChanges.length > 0 && sheetBundle?.resultByTab?.OutgNotes) {
        const outgNotesRanges = buildOutgNotesMirrorUpdates(
          outboundOutgoingsNoteChanges,
          sheetBundle.resultByTab.OutgNotes.values || []
        );
        outboundValueRanges.push(...outgNotesRanges);
      }

      const shouldApplyInboundNow =
        inboundAppliedTabs.length > 0 &&
        wantsInbound &&
        (effectiveMode === "live" || allowDryRunApplyInbound);

      if (shouldApplyInboundNow) {
        _suppressOutboundByClient.add(key);
        try {
          for (const item of mergeResults) {
            if (!inboundAppliedTabs.includes(item.tabName)) continue;
            await saveVirtualTabGrid_(
              ctx,
              "client",
              item.tabName,
              item.merge.mergedValues,
              item.merge.mergedFormulas,
              item.merge.mergedNotes,
              { markPersistedImmediate: true, markPersistedToDbImmediate: true }
            );
          }
          await recomputeClientFormulasForBridge(ctx.clientName, inboundAppliedTabs).catch((e) =>
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
      const hasOutboundWork = outboundValueRanges.length > 0 || outboundNoteRequests.length > 0 || queuedStructOps.length > 0;

      if (wantsOutbound && effectiveMode === "live" && hasOutboundWork) {
        // 1. Expand target tabs if rows grew beyond current Google Sheet grid rowCount + replay structural ops
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
        if (queuedStructOps.length > 0) {
          for (const op of queuedStructOps) {
            const realGid =
              sheetBundle?.sheetPropsByTitle?.[op.tabName]?.sheetId ??
              (await getSheetGid(rawSheets, ctx.clientSheetId, op.tabName).catch(() => null));
            if (realGid !== null && realGid !== undefined) {
              structuralBatch.push(rewriteStructuralRequestSheetId_(op.req, realGid));
            }
          }
          _pendingStructuralOpsByClient.delete(key);
        }
        if (structuralBatch.length > 0) {
          await withRetry(() =>
            rawSheets.spreadsheets.batchUpdate({
              spreadsheetId: ctx.clientSheetId,
              requestBody: { requests: structuralBatch },
            })
          );
        }

        // 2. Write minimal coalesced cell-diff batch
        if (outboundValueRanges.length > 0) {
          await withRetry(() =>
            rawSheets.spreadsheets.values.batchUpdate({
              spreadsheetId: ctx.clientSheetId,
              requestBody: {
                valueInputOption: "USER_ENTERED",
                data: outboundValueRanges,
              },
            })
          );
        }

        // 3. Apply note updates
        if (outboundNoteRequests.length > 0) {
          await withRetry(() =>
            rawSheets.spreadsheets.batchUpdate({
              spreadsheetId: ctx.clientSheetId,
              requestBody: { requests: outboundNoteRequests },
            })
          );
        }

        const postMeta = await fetchDriveVersionMeta_(rawDrive, ctx.clientSheetId).catch(() => null);
        if (postMeta?.version) {
          finalDriveVersion = postMeta.version;
          finalModifiedTime = postMeta.modifiedTime;
        }
      } else if (wantsOutbound && queuedStructOps.length > 0 && effectiveMode === "dry_run") {
        _pendingStructuralOpsByClient.delete(key);
      }

      if (redisClient?.isOpen && wantsOutbound && (effectiveMode === "live" || !hasOutboundWork) && tabsToProcess.length > 0) {
        redisClient.sRem(`pulse:sheet_bridge_dirty:${key}`, tabsToProcess).catch(() => { });
      }

      // Persist updated baseline whenever inbound applied in live/manual mode, outbound committed in live mode, or baseline was missing
      const shouldSaveBaseline =
        !baseline.driveVersion ||
        shouldApplyInboundNow ||
        (wantsOutbound && effectiveMode === "live" && hasOutboundWork) ||
        (effectiveMode === "live" && driveVersionChanged);

      if (shouldSaveBaseline) {
        // In dry_run when inbound wasn't forced, avoid overwriting baseline with un-applied outbound changes
        if (effectiveMode === "dry_run" && !allowDryRunApplyInbound) {
          await saveBaselineRecord_(supabase, ctx, {
            driveVersion: baseline.driveVersion || finalDriveVersion,
            tabs: baseline.tabs,
          });
        } else {
          await saveBaselineRecord_(supabase, ctx, {
            driveVersion: finalDriveVersion,
            tabs: nextBaselineTabs,
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
      if (allOutboundDiffs.length > 0 || queuedStructOps.length > 0) {
        summaryParts.push(
          `${effectiveMode === "live" && wantsOutbound ? "Pushed" : "Would push"} ${allOutboundDiffs.length} field(s) across ${outReadable.totalRowsChanged} row(s)${outboundTabsChanged.length > 0 ? ` (${outboundTabsChanged.join(", ")})` : ""
          }${queuedStructOps.length > 0 ? ` + ${queuedStructOps.length} row layout change(s)` : ""}`
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
        queuedStructOps.length > 0;

      const logEntry = shouldLog
        ? {
          timestamp: nowIso,
          mode: effectiveMode,
          direction,
          driveVersion: finalDriveVersion,
          inboundCount: allInboundDiffs.length,
          outboundCount: allOutboundDiffs.length,
          rangeCount: outboundValueRanges.length,
          structuralCount: queuedStructOps.length,
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

      return {
        success: true,
        mode: effectiveMode,
        direction,
        driveVersion: finalDriveVersion,
        inboundChanged: allInboundDiffs.length > 0,
        inboundCount: allInboundDiffs.length,
        outboundChanged: allOutboundDiffs.length > 0 || queuedStructOps.length > 0,
        outboundCount: allOutboundDiffs.length,
        outboundRangesCount: outboundValueRanges.length,
        structuralCount: queuedStructOps.length,
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
      if (lockOk) await releaseRedisBridgeLock_(key);
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

  const { data: clientRow, error } = await supabase
    .from("clients")
    .select("id, client_name, client_mode, client_sheet_id, metadata")
    .eq("client_name", clientName)
    .maybeSingle();
  if (error || !clientRow) throw new Error(`Client "${clientName}" not found.`);

  if (cleanMode !== "off") {
    if (clientRow.client_mode !== "supabase") {
      throw new Error(`Enable Client Portal Supabase engine (Step 5) for "${clientName}" before enabling the Google Sheet bridge.`);
    }
    if (!clientRow.client_sheet_id || isVirtualSupabaseSheetId(clientRow.client_sheet_id)) {
      throw new Error(`"${clientName}" has no Google Client Sheet linked for bidirectional syncing.`);
    }
    const { count: clientTabCount } = await supabase
      .from("master_sheet_grids")
      .select("id", { count: "exact", head: true })
      .eq("client_name", clientRow.client_name)
      .or("sheet_role.eq.client,and(sheet_role.eq.master,tab_name.like.Client::%)");
    if (!clientTabCount) {
      throw new Error(`Run "Push sheet data to Supabase" (Step 4) for "${clientName}" before enabling the Google Sheet bridge.`);
    }

    const ctx = {
      clientId: clientRow.id,
      clientName: clientRow.client_name,
      clientSheetId: clientRow.client_sheet_id,
      clientMode: clientRow.client_mode,
    };
    const existingBase = await loadBaselineRecord_(supabase, ctx);
    if (!existingBase.driveVersion || Object.keys(existingBase.tabs || {}).length === 0) {
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
          includeNotes: BRIDGE_NOTE_TABS.has(tName),
        }).catch(() => null);
        if (rec) {
          tabs[tName] = { values: rec.values_grid || [], notes: rec.notes_grid || {} };
        }
      }
      await saveBaselineRecord_(supabase, ctx, { driveVersion, tabs });
      await updateClientBridgeState_(
        supabase,
        clientRow.client_name,
        {
          lastSyncedDriveVersion: driveVersion,
          lastSyncedModifiedTime: modifiedTime,
          lastSummary: `Bridge enabled (${cleanMode}); baseline captured at Drive v${driveVersion || "?"}`,
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
              includeNotes: BRIDGE_NOTE_TABS.has(tabName),
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
      };
    }

    _pendingStructuralOpsByClient.delete(key);
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

    const finalDriveMeta = await fetchDriveVersionMeta_(rawDrive, ctx.clientSheetId).catch(() => ({
      version: "",
      modifiedTime: "",
    }));

    await saveBaselineRecord_(supabase, ctx, {
      driveVersion: finalDriveMeta.version,
      tabs: nextBaselineTabs,
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
    if (lockOk) await releaseRedisBridgeLock_(key);
  }
}

function formatParityMonthHeader_(rawHdr, col0) {
  if (typeof rawHdr === "number" && rawHdr >= 30000 && rawHdr <= 75000) {
    const dStr = toSheetDateFormat(rawHdr);
    const m = String(dStr || "").match(/^\d{1,2}-([A-Za-z]{3}-\d{2})$/);
    if (m) return m[1];
    if (dStr) return String(dStr);
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

function compareHeadlineTabGrid_(
  tabName,
  sheetVals = [],
  supaVals = [],
  { maxRows = 45, maxCols = 20, headerRowIdx = 3, minDataRowIdx = 4 } = {}
) {
  const mismatches = [];
  const limitRows = Math.min(maxRows, Math.max(sheetVals.length, supaVals.length));
  const hdrRowSupa = Array.isArray(supaVals[headerRowIdx]) ? supaVals[headerRowIdx] : [];
  const hdrRowSheet = Array.isArray(sheetVals[headerRowIdx]) ? sheetVals[headerRowIdx] : [];

  for (let r = minDataRowIdx; r < limitRows; r++) {
    const gR = Array.isArray(sheetVals[r]) ? sheetVals[r] : [];
    const sR = Array.isArray(supaVals[r]) ? supaVals[r] : [];
    const rowLabel = extractParityRowLabel_(sR, gR, r);

    for (let c = 2; c < maxCols; c++) {
      const gV = gR[c] ?? "";
      const sV = sR[c] ?? "";
      if ((gV === "" && sV === 0) || (gV === 0 && sV === "") || (gV === "" && sV === "")) {
        continue;
      }

      const nG = parseComparableNumber_(gV);
      const nS = parseComparableNumber_(sV);
      if (nG !== null && nS !== null) {
        if (Math.abs(nG - nS) <= 1.0) continue;
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

      const strG = String(gV).trim();
      const strS = String(sV).trim();
      if (strG === strS) continue;
      if (strG.startsWith("#") && strS.startsWith("#")) continue;

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

/**
 * Verifies live Google Sheet `Dashboard` and `Cash` parity against Supabase
 * across all bridged live clients (or a single specified client).
 */
export async function verifyBridgedClientsParity({ clientName = null } = {}) {
  if (!isSupabaseConfigured()) throw new Error("Supabase is not configured.");
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase admin client unavailable.");

  const { rawDrive, rawSheets } = getPrimaryRawGoogleClients();
  if (!rawDrive || !rawSheets) {
    throw new Error("Primary Google Service Account Drive/Sheets clients unavailable.");
  }

  let query = supabase
    .from("clients")
    .select("id, client_name, status, master_mode, client_mode, client_sheet_id, master_sheet_id, metadata")
    .eq("status", "live")
    .eq("client_mode", "supabase")
    .order("client_name", { ascending: true });

  if (clientName) {
    query = query.eq("client_name", String(clientName).trim());
  }

  const { data: rows, error } = await query;
  if (error) throw new Error(`Could not query clients: ${error.message}`);

  const targets = (rows || []).filter((c) => {
    const bMode = String(c.metadata?.sheet_bridge_mode || "off").toLowerCase();
    return (
      (bMode === "live" || bMode === "dry_run") &&
      c.client_sheet_id &&
      !isVirtualSupabaseSheetId(c.client_sheet_id)
    );
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
        const ctx = {
          clientId: c.id,
          clientName: c.client_name,
          clientSheetId: c.client_sheet_id,
          masterSheetId: c.master_sheet_id,
          clientMode: c.client_mode,
          masterMode: c.master_mode,
        };

        try {
          const [driveMeta, sheetResp, supaDash, supaCash] = await Promise.all([
            fetchDriveVersionMeta_(rawDrive, c.client_sheet_id).catch(() => null),
            withRetry(() =>
              rawSheets.spreadsheets.values.batchGet({
                spreadsheetId: c.client_sheet_id,
                ranges: ["Dashboard!A1:Z45", "Cash!A1:Z58"],
                valueRenderOption: "UNFORMATTED_VALUE",
              })
            ),
            getOrLoadVirtualTabGrid_(ctx, "client", "Dashboard", rawSheets, { valuesOnly: true }).catch(() => null),
            getOrLoadVirtualTabGrid_(ctx, "client", "Cash", rawSheets, { valuesOnly: true }).catch(() => null),
          ]);

          const gDashVals = sheetResp?.data?.valueRanges?.[0]?.values || [];
          const gCashVals = sheetResp?.data?.valueRanges?.[1]?.values || [];
          const sDashVals = supaDash?.values_grid || [];
          const sCashVals = supaCash?.values_grid || [];

          const dashDiffs = compareHeadlineTabGrid_("Dashboard", gDashVals, sDashVals, {
            maxRows: 45,
            maxCols: 20,
            headerRowIdx: 3,
            minDataRowIdx: 4,
          });
          const cashDiffs = compareHeadlineTabGrid_("Cash", gCashVals, sCashVals, {
            maxRows: 58,
            maxCols: 20,
            headerRowIdx: 2,
            minDataRowIdx: 3,
          });

          const liveVer = String(driveMeta?.version || "");
          const driveInSync = Boolean(!liveVer || liveVer === lastSynced || liveVer === lastPulse);
          const totalMismatchCount = dashDiffs.length + cashDiffs.length;

          return {
            clientName: c.client_name,
            bridgeMode,
            driveVersion: liveVer,
            lastSyncedDriveVersion: lastSynced,
            driveInSync,
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
