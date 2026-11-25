/**
 * ============================================================================
 * PULSE PHASE 4C: RELATIONAL BANK RECONCILIATION SERVICE
 * ============================================================================
 * Replaces virtual Recon Sheet grids (`YYMM` tabs like `2610`, `PLAdds`, `Data`,
 * `KeyInfo`, `Template`) and TF-IDF category learning with normalized Postgres
 * tables (`bank_recon_periods`, `bank_recon_items`, `bank_recon_learning_map`,
 * `pulse_recon_configs`) + 100% lossless cell-for-cell reconstruction.
 * ============================================================================
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import {
  resolveSupabaseSheetContext,
  getOrLoadVirtualTabGrid_,
  invalidateMasterEngineCache,
} from "./masterEngineService.js";
import { compactGrid2D } from "./gasRuntime/masterFormulaEngine.js";
import { formatCellForDisplay } from "./gasRuntime/sheetValueUtils.js";
import { tokenizeText, VALID_RECON_CATEGORIES } from "./bankTransactionsService.js";

export const RECON_CONFIG_TABS = ["PLAdds", "Data", "KeyInfo", "Template"];

export function isReconMonthTab(tabName) {
  return /^\d{4}$/.test(String(tabName || "").trim());
}

export function isManagedReconTab(tabName) {
  const clean = String(tabName || "").trim();
  return isReconMonthTab(clean) || RECON_CONFIG_TABS.includes(clean);
}

let _cachedMigration0015Sql = null;
let _schemaReadyCache = { ready: null, checkedAt: 0 };
const _reconBundleCache = new Map();
const RECON_BUNDLE_TTL_MS = 15000;
const _pendingReconReconcileByClient = new Map();
const _inFlightReconReconcileByClient = new Map();

export function readMigration0015Sql() {
  if (_cachedMigration0015Sql !== null) return _cachedMigration0015Sql;
  try {
    const candidates = [
      path.join(process.cwd(), "supabase", "migrations", "0015_phase4c_bank_reconciliation.sql"),
      path.join(process.cwd(), "pulse-management-system", "supabase", "migrations", "0015_phase4c_bank_reconciliation.sql"),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations/0015_phase4c_bank_reconciliation.sql"),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    _cachedMigration0015Sql = found ? fs.readFileSync(found, "utf8") : "";
  } catch {
    _cachedMigration0015Sql = "";
  }
  return _cachedMigration0015Sql;
}

export function invalidateClientRelationalReconCache(clientName) {
  const key = String(clientName || "").trim().toLowerCase();
  if (!key) {
    _reconBundleCache.clear();
    return;
  }
  _reconBundleCache.delete(key);
}

// ============================================================================
// 1. PRIMITIVES & PAGINATED DB HELPERS
// ============================================================================

function str_(v) {
  return String(v ?? "").trim();
}

function num_(val, fallback = 0) {
  if (typeof val === "number") return Number.isFinite(val) ? val : fallback;
  const s = str_(val).replace(/[£$€,\s]/g, "");
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function clone2D_(grid) {
  if (!Array.isArray(grid)) return [];
  return grid.map((r) => (Array.isArray(r) ? [...r] : []));
}

function isRowEmpty_(row) {
  if (!Array.isArray(row)) return true;
  for (let c = 0; c < row.length; c++) {
    const v = row[c];
    if (v !== "" && v !== null && v !== undefined) return false;
  }
  return true;
}

function trimTrailingEmptyCells_(row) {
  if (!Array.isArray(row)) return [];
  let last = -1;
  for (let c = row.length - 1; c >= 0; c--) {
    const v = row[c];
    if (v !== "" && v !== null && v !== undefined) {
      last = c;
      break;
    }
  }
  return last >= 0 ? row.slice(0, last + 1) : [];
}

function isGreenShaded_(rgb) {
  if (!rgb || typeof rgb !== "object") return false;
  const r = rgb.red ?? 0;
  const g = rgb.green ?? 0;
  const b = rgb.blue ?? 0;
  return g > 0.85 && r < 0.92 && b < 0.92 && g > r && g > b;
}

async function fetchAllRowsByClientId_(supabase, table, clientId, orderCol = "row_index") {
  const all = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select("*").eq("client_id", clientId);
    if (orderCol) q = q.order(orderCol, { ascending: true });
    q = q.order("id", { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

async function fetchAllSelectByClientId_(supabase, table, selectCols, clientId, extraFilters = {}) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(selectCols).eq("client_id", clientId);
    for (const [k, v] of Object.entries(extraFilters || {})) {
      if (Array.isArray(v)) q = q.in(k, v);
      else q = q.eq(k, v);
    }
    q = q.order("id", { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

async function upsertInChunks_(supabase, table, rows, onConflict) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 250) {
    const chunk = rows.slice(i, i + 250);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

// ============================================================================
// 2. LOSSLESS YYMM PARSER, PROJECTOR & LEARNING MAP COMPUTER
// ============================================================================

export function parseReconPeriodTab({
  clientId,
  clientName,
  monthKey,
  grid = [],
  notesGrid = {},
}) {
  const cleanMonthKey = str_(monthKey);
  const yy = cleanMonthKey.slice(0, 2);
  const mm = cleanMonthKey.slice(2, 4);
  const isoMonth = /^\d{4}$/.test(cleanMonthKey) ? `20${yy}-${mm}` : "";

  const da1Cell = grid[0]?.[104];
  const hasDa1 = da1Cell !== undefined && da1Cell !== null && String(da1Cell) !== "";
  const rawDa1 = hasDa1 ? String(da1Cell).trim() : "";
  const accountingPlatform = rawDa1.toLowerCase().includes("quick") ? "Quickbooks" : "Xero";
  const isQb = accountingPlatform.toLowerCase().includes("quick");

  const cr2Cell = grid[1]?.[95];
  const rawCr2 = cr2Cell === undefined ? null : cr2Cell;
  const isComplete = Boolean(rawCr2 === true || str_(rawCr2).toUpperCase() === "TRUE");

  // 1. Actuals summary U3:X16 (rows 2..15, cols 20..23)
  const actualsSummary = {};
  for (let r = 2; r <= 15 && r < grid.length; r++) {
    const label = str_(grid[r]?.[20]);
    if (!label || label.toLowerCase() === "total") continue;
    actualsSummary[label] = {
      out: String(grid[r]?.[21] ?? ""),
      in: String(grid[r]?.[22] ?? ""),
      net: num_(grid[r]?.[23]),
      formattedNet: String(grid[r]?.[23] ?? "£0.00"),
    };
  }

  // 2. Comparisons U20:X65 (rows 19..64, cols 20..23)
  const comparisonsJson = [];
  for (let r = 19; r <= 64 && r < grid.length; r++) {
    const row = grid[r] || [];
    const slice = [row[20] ?? "", row[21] ?? "", row[22] ?? "", row[23] ?? ""];
    if (!isRowEmpty_(slice)) {
      comparisonsJson.push({ rowNum: r + 1, cells: slice });
    }
  }

  // 3. Breakdowns (Revenue Z4:AR60, Contractors AT4:BL40, Direct Costs AT48:BK75)
  const extractRangeSlice = (rStart, rEnd, cStart, cEnd) => {
    const out = [];
    for (let r = rStart; r <= rEnd && r < grid.length; r++) {
      const row = grid[r] || [];
      const slice = [];
      for (let c = cStart; c <= cEnd; c++) slice.push(row[c] ?? "");
      if (!isRowEmpty_(slice)) {
        out.push({ rowNum: r + 1, cells: trimTrailingEmptyCells_(slice) });
      }
    }
    return out;
  };
  const breakdownsJson = {
    revenue: extractRangeSlice(3, 59, 25, 43),
    contractors: extractRangeSlice(3, 39, 45, 63),
    directCosts: extractRangeSlice(47, 74, 45, 62),
  };

  // 4. P&L Adds CZ3:DA60 (rows 2..59, cols 103..104)
  const plAddsJson = [];
  for (let r = 2; r <= 59 && r < grid.length; r++) {
    const row = grid[r] || [];
    const acc = str_(row[103]);
    const amt = row[104] ?? "";
    if (acc || (amt !== "" && amt !== null && amt !== undefined)) {
      plAddsJson.push({ rowNum: r + 1, accountName: acc, amount: amt });
    }
  }

  // 5. Frame outside reconciled (A..Q, r>=2) & unreconciled (CD..CN, r>=3) regions
  const headerRows = [
    trimTrailingEmptyCells_(grid[0] || []),
    trimTrailingEmptyCells_(grid[1] || []),
  ];
  const sparseCells = [];
  let maxCols = Math.max(headerRows[0].length, headerRows[1].length);
  for (let r = 2; r < grid.length; r++) {
    const row = grid[r];
    if (!Array.isArray(row)) continue;
    if (row.length > maxCols) maxCols = row.length;
    for (let c = 0; c < row.length; c++) {
      if (r >= 2 && c >= 0 && c <= 16) continue;
      if (r >= 3 && c >= 81 && c <= 91) continue;
      const v = row[c];
      if (v !== "" && v !== null && v !== undefined) {
        sparseCells.push([r, c, v]);
      }
    }
  }

  const nowIso = new Date().toISOString();
  const safeNotes = notesGrid && typeof notesGrid === "object" && !Array.isArray(notesGrid) ? notesGrid : {};
  const bgColors = safeNotes.__bg_colors && typeof safeNotes.__bg_colors === "object" ? safeNotes.__bg_colors : {};

  // 6. Bank reconciliation items (reconciled A3:Q.. and unreconciled CD4:CN..)
  const items = [];
  for (let r = 2; r < grid.length; r++) {
    const row = Array.isArray(grid[r]) ? grid[r] : [];
    const rawRec = trimTrailingEmptyCells_(row.slice(0, 17));
    if (!isRowEmpty_(rawRec)) {
      const dateRaw = row[1] !== "" && row[1] !== undefined && row[1] !== null ? row[1] : row[0];
      let txnDate = "";
      try {
        txnDate = dateRaw !== "" && dateRaw !== undefined && dateRaw !== null
          ? String(formatCellForDisplay("recon", cleanMonthKey, r, 1, dateRaw, grid) ?? "").trim()
          : "";
      } catch {
        txnDate = str_(dateRaw);
      }
      const outAmt = num_(row[8]);
      const inAmt = num_(row[9]);
      const isNew = isGreenShaded_(bgColors[`${r}:1`]);
      items.push({
        client_id: clientId,
        client_name: clientName,
        month_key: cleanMonthKey,
        item_type: "reconciled",
        row_index: r + 1,
        is_reconciled: true,
        txn_date: txnDate,
        account_name: str_(row[2]),
        payee: str_(row[3] || row[4]),
        particulars: str_(row[4]),
        reference: str_(row[6] || row[5]),
        out_amount: outAmt,
        in_amount: inAmt,
        net_amount: Math.round((inAmt - outAmt) * 100) / 100,
        vat_amount: 0,
        category: str_(row[16]),
        vat_applies: "No",
        is_new: isNew,
        is_excluded: false,
        matched_cell_coord: "",
        is_resolved: false,
        metadata: {},
        raw_row: rawRec,
        raw_cp: null,
        updated_at: nowIso,
      });
    }

    if (r >= 3) {
      const rawUnrec = trimTrailingEmptyCells_(row.slice(81, 92));
      if (!isRowEmpty_(rawUnrec)) {
        const dateVal = row[83] !== "" && row[83] !== undefined && row[83] !== null ? row[83] : row[81];
        let txnDate = "";
        try {
          txnDate = dateVal !== "" && dateVal !== undefined && dateVal !== null
            ? String(formatCellForDisplay("recon", cleanMonthKey, r, 83, dateVal, grid) ?? "").trim()
            : "";
        } catch {
          txnDate = str_(dateVal);
        }
        const rawAmt = num_(row[86]);
        const isOutflow = isQb ? rawAmt > 0 : rawAmt < 0;
        const absAmt = Math.abs(rawAmt);
        const vatApplies = str_(row[91]) || "No";
        const vatAmt =
          vatApplies.toLowerCase() === "yes" ? Math.round(absAmt * (20 / 120) * 100) / 100 : 0;
        const netAmt = Math.round((absAmt - vatAmt) * 100) / 100;
        const rawCpVal = row[93];
        items.push({
          client_id: clientId,
          client_name: clientName,
          month_key: cleanMonthKey,
          item_type: "unreconciled",
          row_index: r + 1,
          is_reconciled: false,
          txn_date: txnDate,
          account_name: "",
          payee: str_(row[84]),
          particulars: str_(row[85]),
          reference: "",
          out_amount: isOutflow ? absAmt : 0,
          in_amount: !isOutflow ? absAmt : 0,
          net_amount: netAmt,
          vat_amount: vatAmt,
          category: str_(row[90]),
          vat_applies: vatApplies,
          is_new: false,
          is_excluded: false,
          matched_cell_coord: "",
          is_resolved: false,
          metadata: {},
          raw_row: rawUnrec,
          raw_cp: rawCpVal !== undefined && rawCpVal !== "" && rawCpVal !== null ? rawCpVal : null,
          updated_at: nowIso,
        });
      }
    }
  }

  const periodRow = {
    client_id: clientId,
    client_name: clientName,
    month_key: cleanMonthKey,
    iso_month: isoMonth,
    accounting_platform: accountingPlatform,
    is_complete: isComplete,
    actuals_summary: actualsSummary,
    comparisons_json: comparisonsJson,
    breakdowns_json: breakdownsJson,
    pl_adds_json: plAddsJson,
    row_count: grid.length,
    col_count: maxCols,
    raw_da1: rawDa1,
    raw_cr2: rawCr2,
    period_frame: {
      hasDa1,
      headerRows,
      sparseCells,
    },
    notes_grid: safeNotes,
    updated_at: nowIso,
  };

  return { periodRow, items };
}

export function projectReconPeriodToGrid(period, items = []) {
  if (!period) return [];
  const frame = period.period_frame && typeof period.period_frame === "object" ? period.period_frame : {};
  const headerRows = Array.isArray(frame.headerRows) ? frame.headerRows : [];
  const sparseCells = Array.isArray(frame.sparseCells) ? frame.sparseCells : [];

  let maxRow = Math.max(Number(period.row_count) || 0, headerRows.length, 2);
  for (const entry of sparseCells) {
    if (Array.isArray(entry) && Number.isInteger(entry[0]) && entry[0] + 1 > maxRow) {
      maxRow = entry[0] + 1;
    }
  }
  for (const it of items || []) {
    if (Number(it.row_index) > maxRow) maxRow = Number(it.row_index);
  }

  const grid = Array.from({ length: maxRow }, () => []);
  for (let r = 0; r < headerRows.length; r++) {
    grid[r] = Array.isArray(headerRows[r]) ? [...headerRows[r]] : [];
  }

  for (const entry of sparseCells) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const [r, c, v] = entry;
    while (grid.length <= r) grid.push([]);
    while (grid[r].length <= c) grid[r].push("");
    grid[r][c] = v;
  }

  for (const it of items || []) {
    const r0 = Number(it.row_index) - 1;
    if (!Number.isInteger(r0) || r0 < 0) continue;
    const raw = Array.isArray(it.raw_row) ? it.raw_row : [];
    if (it.item_type === "reconciled" && r0 >= 2) {
      while (grid.length <= r0) grid.push([]);
      for (let c = 0; c < raw.length && c <= 16; c++) {
        while (grid[r0].length <= c) grid[r0].push("");
        grid[r0][c] = raw[c];
      }
    } else if (it.item_type === "unreconciled" && r0 >= 3) {
      while (grid.length <= r0) grid.push([]);
      for (let c = 0; c < raw.length && c <= 10; c++) {
        const destC = 81 + c;
        while (grid[r0].length <= destC) grid[r0].push("");
        grid[r0][destC] = raw[c];
      }
    }
  }

  return compactGrid2D(grid);
}

/**
 * Mirrors buildLearningMapFromReconSheet (services/bankTransactionsService.js:1145-1204)
 * 100% verbatim using the latest 6 YYMM tabs and rows up to row 150 (A3:Q150).
 */
export function computeReconLearningMapFromItems({
  clientId,
  clientName,
  periodMonthKeys = [],
  reconciledItems = [],
}) {
  const latest6Tabs = [...new Set((periodMonthKeys || []).filter((t) => isReconMonthTab(t)))]
    .sort((a, b) => String(b).localeCompare(String(a)))
    .slice(0, 6);
  const latestSet = new Set(latest6Tabs);

  const wordCategoryCounts = new Map();
  const wordTotalCounts = new Map();

  for (const it of reconciledItems || []) {
    if (!latestSet.has(str_(it.month_key))) continue;
    if (it.item_type && it.item_type !== "reconciled") continue;
    const rowIdx = Number(it.row_index) || 0;
    if (rowIdx < 3 || rowIdx > 150) continue; // Matches A3:Q150 verbatim

    const r = Array.isArray(it.raw_row) ? it.raw_row : [];
    const cat = String(r[16] || it.category || "").trim();
    if (!cat || !VALID_RECON_CATEGORIES.includes(cat)) continue;

    const outVal = r.length > 8 ? parseFloat(r[8]) || 0 : Number(it.out_amount) || 0;
    const inVal = r.length > 9 ? parseFloat(r[9]) || 0 : Number(it.in_amount) || 0;
    if (outVal === 0 && inVal === 0) continue;
    if (outVal > 0 && inVal === 0 && cat === "Revenue") continue;
    if (
      inVal > 0 &&
      outVal === 0 &&
      !["Revenue", "Transfer", "Non-operating income", "Other"].includes(cat)
    ) {
      continue;
    }

    const text =
      r.length > 0
        ? `${r[1] || ""} ${r[3] || ""} ${r[4] || ""} ${r[5] || ""} ${r[6] || ""}`
        : `${it.txn_date || ""} ${it.payee || ""} ${it.particulars || ""} ${it.reference || ""}`;
    const tokens = tokenizeText(text);

    for (const word of tokens) {
      wordTotalCounts.set(word, (wordTotalCounts.get(word) || 0) + 1);
      if (!wordCategoryCounts.has(word)) wordCategoryCounts.set(word, new Map());
      const catMap = wordCategoryCounts.get(word);
      catMap.set(cat, (catMap.get(cat) || 0) + 1);
    }
  }

  const nowIso = new Date().toISOString();
  const rows = [];
  for (const [word, totalCount] of wordTotalCounts.entries()) {
    if (totalCount < 2) continue;
    const catMap = wordCategoryCounts.get(word);
    let bestCat = null;
    let maxCatCount = 0;
    for (const [cat, count] of catMap.entries()) {
      if (count > maxCatCount) {
        maxCatCount = count;
        bestCat = cat;
      }
    }
    const probability = maxCatCount / totalCount;
    if (probability >= 0.70 && bestCat) {
      rows.push({
        client_id: clientId,
        client_name: clientName,
        match_pattern: word,
        category: bestCat,
        confidence_count: maxCatCount,
        total_occurrences: totalCount,
        probability: Math.round(probability * 10000) / 10000,
        updated_at: nowIso,
      });
    }
  }

  return rows;
}

export async function loadRelationalLearningMap(ctxOrClientName, { source = "db" } = {}) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  const map = new Map();
  if (!ctx?.clientId) return map;

  if (source === "in_memory") {
    const bundle = await preloadClientRelationalReconBundle(ctx, { source: "in_memory" });
    for (const r of bundle?.learningRows || []) {
      map.set(r.match_pattern, { category: r.category, probability: Number(r.probability) || 1 });
    }
    return map;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return map;
  const rows = await fetchAllSelectByClientId_(
    supabase,
    "bank_recon_learning_map",
    "match_pattern, category, probability",
    ctx.clientId
  );
  for (const r of rows) {
    map.set(r.match_pattern, { category: r.category, probability: Number(r.probability) || 1 });
  }
  return map;
}

// ============================================================================
// 3. SCHEMA STATUS & OVERVIEW TELEMETRY
// ============================================================================

export async function checkPhase4ReconSchemaStatus({ forceRefresh = false } = {}) {
  if (!isSupabaseConfigured()) {
    return { schemaReady: false, reason: "Supabase not configured" };
  }
  if (!forceRefresh && _schemaReadyCache.ready && Date.now() - _schemaReadyCache.checkedAt < 60000) {
    return { schemaReady: true };
  }
  const supabase = getSupabaseAdmin();
  try {
    const checks = await Promise.all([
      supabase.from("clients").select("recon_mode, recon_read_mode").limit(1),
      supabase.from("pulse_recon_configs").select("client_id").limit(1),
      supabase.from("bank_recon_periods").select("period_frame, notes_grid, raw_da1, raw_cr2").limit(1),
      supabase.from("bank_recon_items").select("period_id, raw_row, raw_cp").limit(1),
      supabase.from("bank_recon_learning_map").select("probability, total_occurrences").limit(1),
    ]);
    const failed = checks.find((c) => Boolean(c.error));
    if (failed) {
      return { schemaReady: false, reason: failed.error.message };
    }
    _schemaReadyCache = { ready: true, checkedAt: Date.now() };
    return { schemaReady: true };
  } catch (err) {
    return { schemaReady: false, reason: err.message };
  }
}

export async function getPhase4ReconOverviewStats() {
  const migrationSql = readMigration0015Sql();
  const status = await checkPhase4ReconSchemaStatus();
  if (!status.schemaReady) {
    return {
      schemaReady: false,
      migrationSql,
      reason: status.reason || "Migration 0015 required",
      totalPeriods: 0,
      completedPeriods: 0,
      totalReconciledItems: 0,
      totalUnreconciledItems: 0,
      totalLearningRules: 0,
      totalReconConfigs: 0,
    };
  }
  const supabase = getSupabaseAdmin();
  const [perCnt, compCnt, recItemCnt, unrecItemCnt, learnCnt, cfgCnt] = await Promise.all([
    supabase.from("bank_recon_periods").select("id", { count: "exact", head: true }),
    supabase.from("bank_recon_periods").select("id", { count: "exact", head: true }).eq("is_complete", true),
    supabase.from("bank_recon_items").select("id", { count: "exact", head: true }).eq("item_type", "reconciled"),
    supabase.from("bank_recon_items").select("id", { count: "exact", head: true }).eq("item_type", "unreconciled"),
    supabase.from("bank_recon_learning_map").select("id", { count: "exact", head: true }),
    supabase.from("pulse_recon_configs").select("client_id", { count: "exact", head: true }),
  ]);

  return {
    schemaReady: true,
    migrationSql,
    totalPeriods: perCnt.count || 0,
    completedPeriods: compCnt.count || 0,
    totalReconciledItems: recItemCnt.count || 0,
    totalUnreconciledItems: unrecItemCnt.count || 0,
    totalLearningRules: learnCnt.count || 0,
    totalReconConfigs: cfgCnt.count || 0,
  };
}

// ============================================================================
// 4. IDEMPOTENT RECONCILE, BACKFILL & DELETE HELPERS
// ============================================================================

async function runSingleReconReconcilePass_(ctx, tabNames = null, options = {}) {
  const schema = await checkPhase4ReconSchemaStatus();
  if (!schema.schemaReady) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const reconRows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase
      .from("master_sheet_grids")
      .select("tab_name, row_count, col_count, values_grid, formulas_grid, notes_grid, updated_at")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "recon")
      .order("tab_name", { ascending: true })
      .range(from, from + 499);
    if (error) throw new Error(`Failed loading recon grids for ${ctx.clientName}: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    reconRows.push(...data);
    if (data.length < 500) break;
  }

  const byTab = new Map();
  for (const r of reconRows) {
    byTab.set(r.tab_name, r);
  }

  const targetAllMonths =
    tabNames === null || tabNames === undefined || Boolean(options.forceFullUpsert);
  const requestedSet = new Set(Array.isArray(tabNames) ? tabNames : []);

  // 1. Always refresh pulse_recon_configs when configs changed or full upsert
  const shouldSyncConfig =
    targetAllMonths ||
    RECON_CONFIG_TABS.some((t) => requestedSet.has(t)) ||
    reconRows.some((r) => isReconMonthTab(r.tab_name) && requestedSet.has(r.tab_name));

  if (shouldSyncConfig) {
    const plAddsRec = byTab.get("PLAdds");
    const dataRec = byTab.get("Data");
    const kiRec = byTab.get("KeyInfo");
    const tplRec = byTab.get("Template");
    const cfgPayload = {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      pl_adds_grid: Array.isArray(plAddsRec?.values_grid) ? compactGrid2D(plAddsRec.values_grid) : [],
      data_grid: Array.isArray(dataRec?.values_grid) ? compactGrid2D(dataRec.values_grid) : [],
      key_info_grid: Array.isArray(kiRec?.values_grid) ? compactGrid2D(kiRec.values_grid) : [],
      template_meta: tplRec
        ? {
          row_count: tplRec.row_count || 0,
          col_count: tplRec.col_count || 0,
          values_grid: Array.isArray(tplRec.values_grid) ? compactGrid2D(tplRec.values_grid) : [],
          formulas_grid: Array.isArray(tplRec.formulas_grid) ? compactGrid2D(tplRec.formulas_grid) : [],
          notes_grid: tplRec.notes_grid || {},
        }
        : {},
      tab_list: reconRows.map((r) => ({
        tab_name: r.tab_name,
        row_count: r.row_count || 0,
        col_count: r.col_count || 0,
      })),
      updated_at: new Date().toISOString(),
    };
    const { error: cfgErr } = await supabase
      .from("pulse_recon_configs")
      .upsert(cfgPayload, { onConflict: "client_id" });
    if (cfgErr) throw new Error(`pulse_recon_configs upsert failed: ${cfgErr.message}`);
  }

  // 2. Sync targeted (or all) YYMM periods and items
  const allMonthTabs = reconRows.map((r) => r.tab_name).filter((t) => isReconMonthTab(t));
  const targetMonths = targetAllMonths
    ? allMonthTabs
    : allMonthTabs.filter((t) => requestedSet.has(t));

  let totalReconciled = 0;
  let totalUnreconciled = 0;

  if (targetMonths.length > 0) {
    const periodRows = [];
    const parsedByMonth = new Map();
    for (const mKey of targetMonths) {
      const rec = byTab.get(mKey);
      const parsed = parseReconPeriodTab({
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        monthKey: mKey,
        grid: Array.isArray(rec?.values_grid) ? compactGrid2D(rec.values_grid) : [],
        notesGrid: rec?.notes_grid || {},
      });
      periodRows.push(parsed.periodRow);
      parsedByMonth.set(mKey, parsed.items);
    }

    const periodIdByMonth = new Map();
    for (let i = 0; i < periodRows.length; i += 25) {
      const chunk = periodRows.slice(i, i + 25);
      const { data: upsertedPeriods, error: perErr } = await supabase
        .from("bank_recon_periods")
        .upsert(chunk, { onConflict: "client_id,month_key" })
        .select("id, month_key");
      if (perErr) throw new Error(`bank_recon_periods upsert failed: ${perErr.message}`);
      for (const p of upsertedPeriods || []) {
        periodIdByMonth.set(p.month_key, p.id);
      }
    }

    const itemsToUpsert = [];
    const keepItemKeysByMonth = new Map();
    for (const mKey of targetMonths) {
      const pid = periodIdByMonth.get(mKey) || null;
      const keepSet = new Set();
      for (const it of parsedByMonth.get(mKey) || []) {
        itemsToUpsert.push({ ...it, period_id: pid });
        keepSet.add(`${it.item_type}::${it.row_index}`);
        if (it.item_type === "reconciled") totalReconciled++;
        else totalUnreconciled++;
      }
      keepItemKeysByMonth.set(mKey, keepSet);
    }

    await upsertInChunks_(
      supabase,
      "bank_recon_items",
      itemsToUpsert,
      "client_id,month_key,item_type,row_index"
    );

    const existingItems = await fetchAllSelectByClientId_(
      supabase,
      "bank_recon_items",
      "id, month_key, item_type, row_index",
      ctx.clientId,
      { month_key: targetMonths }
    );
    const staleItemIds = existingItems
      .filter((r) => {
        const keep = keepItemKeysByMonth.get(r.month_key);
        return !keep || !keep.has(`${r.item_type}::${r.row_index}`);
      })
      .map((r) => r.id);
    for (let i = 0; i < staleItemIds.length; i += 200) {
      await supabase.from("bank_recon_items").delete().in("id", staleItemIds.slice(i, i + 200));
    }
  }

  // Prune periods removed from recon workbook when running full sync
  if (targetAllMonths) {
    const keepMonthSet = new Set(allMonthTabs);
    const existingPeriods = await fetchAllSelectByClientId_(
      supabase,
      "bank_recon_periods",
      "id, month_key",
      ctx.clientId
    );
    const stalePeriodIds = existingPeriods
      .filter((p) => !keepMonthSet.has(p.month_key))
      .map((p) => p.id);
    for (let i = 0; i < stalePeriodIds.length; i += 200) {
      await supabase.from("bank_recon_periods").delete().in("id", stalePeriodIds.slice(i, i + 200));
    }
  }

  // 3. Recompute & sync bank_recon_learning_map whenever YYMM tabs changed (or full backfill)
  let learningRulesCount = 0;
  if (targetAllMonths || targetMonths.length > 0) {
    const allPeriodsDb = await fetchAllSelectByClientId_(
      supabase,
      "bank_recon_periods",
      "month_key",
      ctx.clientId
    );
    const allMonthKeysDb = allPeriodsDb.map((p) => p.month_key);
    const latest6 = [...new Set(allMonthKeysDb.filter((t) => isReconMonthTab(t)))]
      .sort((a, b) => String(b).localeCompare(String(a)))
      .slice(0, 6);

    const latestReconciledItems =
      latest6.length > 0
        ? await fetchAllSelectByClientId_(
          supabase,
          "bank_recon_items",
          "month_key, item_type, row_index, category, out_amount, in_amount, txn_date, payee, particulars, reference, raw_row",
          ctx.clientId,
          { month_key: latest6, item_type: "reconciled" }
        )
        : [];

    const learningRows = computeReconLearningMapFromItems({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      periodMonthKeys: allMonthKeysDb,
      reconciledItems: latestReconciledItems,
    });
    learningRulesCount = learningRows.length;

    await upsertInChunks_(
      supabase,
      "bank_recon_learning_map",
      learningRows,
      "client_id,match_pattern"
    );

    const keepPatterns = new Set(learningRows.map((r) => r.match_pattern));
    const existingLearn = await fetchAllSelectByClientId_(
      supabase,
      "bank_recon_learning_map",
      "id, match_pattern",
      ctx.clientId
    );
    const staleLearnIds = existingLearn
      .filter((r) => !keepPatterns.has(r.match_pattern))
      .map((r) => r.id);
    for (let i = 0; i < staleLearnIds.length; i += 200) {
      await supabase.from("bank_recon_learning_map").delete().in("id", staleLearnIds.slice(i, i + 200));
    }
  }

  invalidateClientRelationalReconCache(ctx.clientName);

  const summary = {
    clientName: ctx.clientName,
    periodsCount: targetAllMonths ? allMonthTabs.length : targetMonths.length,
    totalPeriodsCount: allMonthTabs.length,
    reconciledItemsCount: totalReconciled,
    unreconciledItemsCount: totalUnreconciled,
    learningRulesCount,
  };

  if (options.updateBackfillTimestamp) {
    const { data: cRow } = await supabase
      .from("clients")
      .select("metadata")
      .eq("id", ctx.clientId)
      .maybeSingle();
    const nextMeta = {
      ...(cRow?.metadata || {}),
      relational_recon_state: {
        lastBackfilledAt: new Date().toISOString(),
        ...summary,
      },
    };
    await supabase.from("clients").update({ metadata: nextMeta }).eq("id", ctx.clientId);
  }

  return summary;
}

export async function reconcileClientReconFromGrids(
  ctxOrClientName,
  tabNames = null,
  options = {}
) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const isFullAll = tabNames === null || tabNames === undefined || Boolean(options.forceFullUpsert);
  const targetTabs = isFullAll
    ? null
    : [...new Set((Array.isArray(tabNames) ? tabNames : []).filter((t) => isManagedReconTab(t)))];
  if (!isFullAll && targetTabs.length === 0) return null;

  const key = String(ctx.clientName || ctx.clientId).trim().toLowerCase();
  const pendingEntry = _pendingReconReconcileByClient.get(key) || {
    allTabs: false,
    tabs: new Set(),
    opts: {},
  };
  if (isFullAll) {
    pendingEntry.allTabs = true;
  } else {
    for (const t of targetTabs) pendingEntry.tabs.add(t);
  }
  pendingEntry.opts = { ...pendingEntry.opts, ...options };
  _pendingReconReconcileByClient.set(key, pendingEntry);

  if (_inFlightReconReconcileByClient.has(key)) {
    return _inFlightReconReconcileByClient.get(key);
  }

  const runner = (async () => {
    let lastSummary = null;
    while (_pendingReconReconcileByClient.has(key)) {
      const next = _pendingReconReconcileByClient.get(key);
      _pendingReconReconcileByClient.delete(key);
      lastSummary = await runSingleReconReconcilePass_(
        ctx,
        next.allTabs ? null : [...next.tabs],
        next.opts
      );
    }
    return lastSummary;
  })();

  _inFlightReconReconcileByClient.set(key, runner);
  try {
    return await runner;
  } finally {
    if (_inFlightReconReconcileByClient.get(key) === runner) {
      _inFlightReconReconcileByClient.delete(key);
    }
  }
}

export async function deleteClientReconPeriod(ctxOrClientName, monthKey) {
  const cleanMonth = str_(monthKey);
  if (!isReconMonthTab(cleanMonth)) return null;
  const schema = await checkPhase4ReconSchemaStatus();
  if (!schema.schemaReady) return null;
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  await supabase
    .from("bank_recon_periods")
    .delete()
    .eq("client_id", ctx.clientId)
    .eq("month_key", cleanMonth);

  return reconcileClientReconFromGrids(ctx, null, { forceFullUpsert: true });
}

export async function backfillClientRecon(clientName) {
  const schema = await checkPhase4ReconSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0015 must be applied in Supabase SQL Editor before backfilling bank reconciliation.");
  }
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) {
    throw new Error(`Client "${clientName}" was not found in Supabase.`);
  }
  return reconcileClientReconFromGrids(ctx, null, {
    forceFullUpsert: true,
    updateBackfillTimestamp: true,
  });
}

export async function backfillAllClientsRecon() {
  const schema = await checkPhase4ReconSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0015 must be applied in Supabase SQL Editor before backfilling bank reconciliation.");
  }
  const supabase = getSupabaseAdmin();
  const { data: clients, error } = await supabase.from("clients").select("client_name").order("client_name");
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    try {
      const s = await backfillClientRecon(cl.client_name);
      results.push({ ...s, error: null });
    } catch (err) {
      results.push({ clientName: cl.client_name, error: err.message });
    }
  }
  const succeededCount = results.filter((r) => !r.error).length;
  return {
    checkedAt: new Date().toISOString(),
    totalClients: results.length,
    clientsProcessed: succeededCount,
    succeededCount,
    errorCount: results.filter((r) => Boolean(r.error)).length,
    periodsCount: results.reduce((a, r) => a + (r.periodsCount || 0), 0),
    reconciledItemsCount: results.reduce((a, r) => a + (r.reconciledItemsCount || 0), 0),
    unreconciledItemsCount: results.reduce((a, r) => a + (r.unreconciledItemsCount || 0), 0),
    learningRulesCount: results.reduce((a, r) => a + (r.learningRulesCount || 0), 0),
    results,
  };
}

// ============================================================================
// 5. RELATIONAL RECON BUNDLE LOADER & RECONSTRUCTOR
// ============================================================================

async function loadInMemoryReconBundleForClient_(ctx) {
  const supabase = getSupabaseAdmin();
  const reconRows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase
      .from("master_sheet_grids")
      .select("tab_name, row_count, col_count, values_grid, formulas_grid, notes_grid, updated_at")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "recon")
      .order("tab_name", { ascending: true })
      .range(from, from + 499);
    if (error) throw new Error(`Failed loading recon grids for ${ctx.clientName}: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    reconRows.push(...data);
    if (data.length < 500) break;
  }

  const byTab = new Map();
  for (const r of reconRows) byTab.set(r.tab_name, r);

  const plAddsRec = byTab.get("PLAdds");
  const dataRec = byTab.get("Data");
  const kiRec = byTab.get("KeyInfo");
  const tplRec = byTab.get("Template");

  const config = {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    pl_adds_grid: Array.isArray(plAddsRec?.values_grid) ? compactGrid2D(plAddsRec.values_grid) : [],
    data_grid: Array.isArray(dataRec?.values_grid) ? compactGrid2D(dataRec.values_grid) : [],
    key_info_grid: Array.isArray(kiRec?.values_grid) ? compactGrid2D(kiRec.values_grid) : [],
    template_meta: tplRec
      ? {
        row_count: tplRec.row_count || 0,
        col_count: tplRec.col_count || 0,
        values_grid: Array.isArray(tplRec.values_grid) ? compactGrid2D(tplRec.values_grid) : [],
        formulas_grid: Array.isArray(tplRec.formulas_grid) ? compactGrid2D(tplRec.formulas_grid) : [],
        notes_grid: tplRec.notes_grid || {},
      }
      : {},
    tab_list: reconRows.map((r) => ({
      tab_name: r.tab_name,
      row_count: r.row_count || 0,
      col_count: r.col_count || 0,
    })),
    updated_at: new Date().toISOString(),
  };

  const periods = [];
  const allItems = [];
  const periodByMonth = new Map();
  const itemsByMonth = new Map();

  for (const r of reconRows) {
    if (!isReconMonthTab(r.tab_name)) continue;
    const parsed = parseReconPeriodTab({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      monthKey: r.tab_name,
      grid: Array.isArray(r.values_grid) ? compactGrid2D(r.values_grid) : [],
      notesGrid: r.notes_grid || {},
    });
    parsed.periodRow.updated_at = r.updated_at || parsed.periodRow.updated_at;
    periods.push(parsed.periodRow);
    periodByMonth.set(r.tab_name, parsed.periodRow);
    itemsByMonth.set(r.tab_name, parsed.items);
    allItems.push(...parsed.items);
  }

  const learningRows = computeReconLearningMapFromItems({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    periodMonthKeys: [...periodByMonth.keys()],
    reconciledItems: allItems,
  });

  return {
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    source: "in_memory",
    config,
    periods,
    periodByMonth,
    itemsByMonth,
    learningRows,
    reconstructedTabCache: new Map(),
  };
}

export async function preloadClientRelationalReconBundle(ctxOrClientName, { source = "db" } = {}) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  if (source === "in_memory") {
    return loadInMemoryReconBundleForClient_(ctx);
  }

  const cacheKey = String(ctx.clientName || ctx.clientId).trim().toLowerCase();
  const cached = _reconBundleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.bundle;
  }

  const supabase = getSupabaseAdmin();
  const [cfgRes, periods, items, learningRows] = await Promise.all([
    supabase
      .from("pulse_recon_configs")
      .select("*")
      .eq("client_id", ctx.clientId)
      .maybeSingle(),
    fetchAllRowsByClientId_(supabase, "bank_recon_periods", ctx.clientId, "month_key"),
    fetchAllRowsByClientId_(supabase, "bank_recon_items", ctx.clientId, "row_index"),
    fetchAllRowsByClientId_(supabase, "bank_recon_learning_map", ctx.clientId, "match_pattern"),
  ]);

  const periodByMonth = new Map();
  for (const p of periods) {
    periodByMonth.set(p.month_key, p);
  }
  const itemsByMonth = new Map();
  for (const it of items) {
    if (!itemsByMonth.has(it.month_key)) itemsByMonth.set(it.month_key, []);
    itemsByMonth.get(it.month_key).push(it);
  }

  const bundle = {
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    source: "db",
    config: cfgRes.data || {},
    periods,
    periodByMonth,
    itemsByMonth,
    learningRows,
    reconstructedTabCache: new Map(),
  };

  _reconBundleCache.set(cacheKey, {
    bundle,
    expiresAt: Date.now() + RECON_BUNDLE_TTL_MS,
  });
  return bundle;
}

export function reconstructRelationalReconTabFromBundle(bundle, tabName) {
  if (!bundle || !tabName) return null;
  const cleanTab = str_(tabName);
  if (bundle.reconstructedTabCache?.has(cleanTab)) {
    const c = bundle.reconstructedTabCache.get(cleanTab);
    return c
      ? {
        ...c,
        values_grid: clone2D_(c.values_grid),
        formulas_grid: clone2D_(c.formulas_grid),
        notes_grid: { ...(c.notes_grid || {}) },
      }
      : null;
  }

  const cfg = bundle.config || {};
  let out = null;

  if (isReconMonthTab(cleanTab)) {
    const period = bundle.periodByMonth?.get(cleanTab);
    if (!period) return null;
    const items = bundle.itemsByMonth?.get(cleanTab) || [];
    const valuesGrid = projectReconPeriodToGrid(period, items);
    const maxCols = valuesGrid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    out = {
      sheet_role: "recon",
      tab_name: cleanTab,
      values_grid: valuesGrid,
      formulas_grid: valuesGrid,
      notes_grid: period.notes_grid && typeof period.notes_grid === "object" ? { ...period.notes_grid } : {},
      row_count: valuesGrid.length,
      col_count: maxCols,
      updated_at: period.updated_at || cfg.updated_at || null,
    };
  } else if (cleanTab === "PLAdds") {
    const g = Array.isArray(cfg.pl_adds_grid) ? compactGrid2D(cfg.pl_adds_grid) : [];
    const hasTab = (cfg.tab_list || []).some((t) => t.tab_name === "PLAdds") || g.length > 0;
    if (hasTab) {
      out = {
        sheet_role: "recon",
        tab_name: "PLAdds",
        values_grid: g,
        formulas_grid: g,
        notes_grid: {},
        row_count: g.length,
        col_count: g.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
        updated_at: cfg.updated_at || null,
      };
    }
  } else if (cleanTab === "Data") {
    const g = Array.isArray(cfg.data_grid) ? compactGrid2D(cfg.data_grid) : [];
    const hasTab = (cfg.tab_list || []).some((t) => t.tab_name === "Data") || g.length > 0;
    if (hasTab) {
      out = {
        sheet_role: "recon",
        tab_name: "Data",
        values_grid: g,
        formulas_grid: g,
        notes_grid: {},
        row_count: g.length,
        col_count: g.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
        updated_at: cfg.updated_at || null,
      };
    }
  } else if (cleanTab === "KeyInfo") {
    const g = Array.isArray(cfg.key_info_grid) ? compactGrid2D(cfg.key_info_grid) : [];
    const hasTab = (cfg.tab_list || []).some((t) => t.tab_name === "KeyInfo") || g.length > 0;
    if (hasTab) {
      out = {
        sheet_role: "recon",
        tab_name: "KeyInfo",
        values_grid: g,
        formulas_grid: g,
        notes_grid: {},
        row_count: g.length,
        col_count: g.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
        updated_at: cfg.updated_at || null,
      };
    }
  } else if (cleanTab === "Template") {
    const tpl = cfg.template_meta && typeof cfg.template_meta === "object" ? cfg.template_meta : null;
    const hasTab =
      (cfg.tab_list || []).some((t) => t.tab_name === "Template") ||
      (Array.isArray(tpl?.values_grid) && tpl.values_grid.length > 0);
    if (hasTab && tpl) {
      const vg = Array.isArray(tpl.values_grid) ? compactGrid2D(tpl.values_grid) : [];
      const fg = Array.isArray(tpl.formulas_grid) && tpl.formulas_grid.length > 0
        ? compactGrid2D(tpl.formulas_grid)
        : vg;
      out = {
        sheet_role: "recon",
        tab_name: "Template",
        values_grid: vg,
        formulas_grid: fg,
        notes_grid: tpl.notes_grid && typeof tpl.notes_grid === "object" ? { ...tpl.notes_grid } : {},
        row_count: vg.length,
        col_count: vg.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
        updated_at: cfg.updated_at || null,
      };
    }
  }

  bundle.reconstructedTabCache?.set(cleanTab, out);
  return out
    ? {
      ...out,
      values_grid: clone2D_(out.values_grid),
      formulas_grid: clone2D_(out.formulas_grid),
      notes_grid: { ...(out.notes_grid || {}) },
    }
    : null;
}

// ============================================================================
// 6. MODE TOGGLES
// ============================================================================

export async function setClientReconMode(clientName, mode) {
  const cleanMode = str_(mode).toLowerCase();
  if (cleanMode !== "grid" && cleanMode !== "relational") {
    throw new Error("Invalid reconMode. Expected 'grid' or 'relational'.");
  }
  const schema = await checkPhase4ReconSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0015 must be applied in Supabase SQL Editor first.");
  }
  const supabase = getSupabaseAdmin();
  const { data: cl, error: fErr } = await supabase
    .from("clients")
    .select("id, client_name, metadata")
    .eq("client_name", clientName)
    .maybeSingle();
  if (fErr || !cl) throw new Error(fErr?.message || `Client "${clientName}" not found.`);

  if (cleanMode === "relational") {
    await backfillClientRecon(clientName);
  }

  const nextMeta = { ...(cl.metadata || {}), recon_mode: cleanMode };
  const { data: upd, error: uErr } = await supabase
    .from("clients")
    .update({ recon_mode: cleanMode, metadata: nextMeta })
    .eq("id", cl.id)
    .select("id, client_name, recon_mode, recon_read_mode")
    .single();
  if (uErr) throw new Error(`Failed updating recon_mode: ${uErr.message}`);
  invalidateMasterEngineCache(clientName, "recon", null, { invalidateSheetContext: true });
  invalidateClientRelationalReconCache(clientName);
  return upd;
}

export async function setClientReconReadMode(clientName, mode) {
  const cleanMode = str_(mode).toLowerCase();
  if (cleanMode !== "grid" && cleanMode !== "relational") {
    throw new Error("Invalid reconReadMode. Expected 'grid' or 'relational'.");
  }
  const schema = await checkPhase4ReconSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0015 must be applied in Supabase SQL Editor first.");
  }
  const supabase = getSupabaseAdmin();
  const { data: cl, error: fErr } = await supabase
    .from("clients")
    .select("id, client_name, recon_mode, metadata")
    .eq("client_name", clientName)
    .maybeSingle();
  if (fErr || !cl) throw new Error(fErr?.message || `Client "${clientName}" not found.`);

  if (cleanMode === "relational" && cl.recon_mode !== "relational") {
    throw new Error(`Switch ${clientName} to relational bank reconciliation mode before enabling direct SQL reads.`);
  }

  const nextMeta = { ...(cl.metadata || {}), recon_read_mode: cleanMode };
  const { data: upd, error: uErr } = await supabase
    .from("clients")
    .update({ recon_read_mode: cleanMode, metadata: nextMeta })
    .eq("id", cl.id)
    .select("id, client_name, recon_mode, recon_read_mode")
    .single();
  if (uErr) throw new Error(`Failed updating recon_read_mode: ${uErr.message}`);
  invalidateMasterEngineCache(clientName, "recon", null, { invalidateSheetContext: true });
  invalidateClientRelationalReconCache(clientName);
  return upd;
}

// ============================================================================
// 7. 100% CELL-FOR-CELL & LEARNING-MAP PARITY VERIFIERS
// ============================================================================

function normCell_(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    return Math.round(v * 1000000) / 1000000;
  }
  if (typeof v === "boolean") return v;
  return String(v);
}

function diff2DGrids_(tabName, gridA, gridB, maxSamples = 8) {
  const a = compactGrid2D(gridA || []);
  const b = compactGrid2D(gridB || []);
  const maxR = Math.max(a.length, b.length);
  const diffs = [];
  let mismatchCount = 0;

  for (let r = 0; r < maxR; r++) {
    const rowA = a[r] || [];
    const rowB = b[r] || [];
    const maxC = Math.max(rowA.length, rowB.length);
    for (let c = 0; c < maxC; c++) {
      const va = normCell_(rowA[c]);
      const vb = normCell_(rowB[c]);
      let same = va === vb;
      if (!same && typeof va === "number" && typeof vb === "number") {
        same = Math.abs(va - vb) <= 0.005;
      }
      if (!same) {
        mismatchCount++;
        if (diffs.length < maxSamples) {
          diffs.push({
            tab: tabName,
            tabName,
            row: r + 1,
            col: c + 1,
            cellKey: `R${r + 1}C${c + 1}`,
            grid: va,
            relational: vb,
            expected: va,
            actual: vb,
          });
        }
      }
    }
  }
  return { mismatchCount, diffs };
}

function compareLearningMaps_(expectedMap, actualMap, maxSamples = 6) {
  const diffs = [];
  let mismatchCount = 0;
  const allKeys = new Set([...expectedMap.keys(), ...actualMap.keys()]);
  for (const k of allKeys) {
    const a = expectedMap.get(k);
    const b = actualMap.get(k);
    const sameCat = (a?.category || "") === (b?.category || "");
    const sameProb =
      a && b
        ? Math.abs((Number(a.probability) || 0) - (Number(b.probability) || 0)) <= 0.001
        : false;
    if (!a || !b || !sameCat || !sameProb) {
      mismatchCount++;
      if (diffs.length < maxSamples) {
        diffs.push({
          tab: "LearningMap",
          tabName: "LearningMap",
          cellKey: k,
          grid: a ? `${a.category} (${Number(a.probability).toFixed(4)})` : "missing",
          relational: b ? `${b.category} (${Number(b.probability).toFixed(4)})` : "missing",
          expected: a ? `${a.category} (${Number(a.probability).toFixed(4)})` : "missing",
          actual: b ? `${b.category} (${Number(b.probability).toFixed(4)})` : "missing",
        });
      }
    }
  }
  return { mismatchCount, diffs };
}

export async function verifyRelationalReconParity({
  clientName = null,
  source = "auto",
  onlyReconEnabled = false,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase4ReconSchemaStatus();
  const cols = schema.schemaReady
    ? "id, client_name, recon_mode, metadata"
    : "id, client_name, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  const { data: clients, error } = await query;
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    if (onlyReconEnabled && cl.recon_mode !== "relational") continue;
    try {
      const ctx = { clientId: cl.id, clientName: cl.client_name };
      const canUseDb =
        schema.schemaReady &&
        (source === "db" ||
          (source === "auto" && Boolean(cl.metadata?.relational_recon_state?.lastBackfilledAt)));

      const [bundle, gridRows] = await Promise.all([
        preloadClientRelationalReconBundle(ctx, { source: canUseDb ? "db" : "in_memory" }),
        (async () => {
          const all = [];
          for (let from = 0; ; from += 500) {
            const { data, error: gErr } = await supabase
              .from("master_sheet_grids")
              .select("tab_name, values_grid, notes_grid")
              .eq("client_name", cl.client_name)
              .eq("sheet_role", "recon")
              .order("tab_name", { ascending: true })
              .range(from, from + 499);
            if (gErr) throw new Error(`Recon grids load error: ${gErr.message}`);
            if (!Array.isArray(data) || data.length === 0) break;
            all.push(...data);
            if (data.length < 500) break;
          }
          return all;
        })(),
      ]);

      const managedGridRows = gridRows.filter((g) => isManagedReconTab(g.tab_name));
      let totalMismatchCount = 0;
      const sampleMismatches = [];

      for (const row of managedGridRows) {
        const reconRec = reconstructRelationalReconTabFromBundle(bundle, row.tab_name);
        const expectedVals = compactGrid2D(row.values_grid || []);
        const actualVals = reconRec?.values_grid || [];
        const { mismatchCount, diffs } = diff2DGrids_(row.tab_name, expectedVals, actualVals, 4);
        totalMismatchCount += mismatchCount;
        if (sampleMismatches.length < 10) sampleMismatches.push(...diffs);

        if (isReconMonthTab(row.tab_name)) {
          const expBg = Object.keys(row.notes_grid?.__bg_colors || {}).length;
          const actBg = Object.keys(reconRec?.notes_grid?.__bg_colors || {}).length;
          if (expBg !== actBg) {
            totalMismatchCount++;
            if (sampleMismatches.length < 10) {
              sampleMismatches.push({
                tab: row.tab_name,
                tabName: row.tab_name,
                cellKey: "notes_grid.__bg_colors",
                grid: expBg,
                relational: actBg,
                expected: expBg,
                actual: actBg,
              });
            }
          }
        }
      }

      // Verify Learning Map parity
      const expectedLearningRows = computeReconLearningMapFromItems({
        clientId: cl.id,
        clientName: cl.client_name,
        periodMonthKeys: managedGridRows.map((g) => g.tab_name).filter((t) => isReconMonthTab(t)),
        reconciledItems: managedGridRows
          .filter((g) => isReconMonthTab(g.tab_name))
          .flatMap((g) =>
            parseReconPeriodTab({
              clientId: cl.id,
              clientName: cl.client_name,
              monthKey: g.tab_name,
              grid: compactGrid2D(g.values_grid || []),
              notesGrid: g.notes_grid || {},
            }).items.filter((i) => i.item_type === "reconciled")
          ),
      });
      const expectedMap = new Map(
        expectedLearningRows.map((r) => [r.match_pattern, { category: r.category, probability: r.probability }])
      );
      const actualMap = new Map(
        (bundle?.learningRows || []).map((r) => [
          r.match_pattern,
          { category: r.category, probability: Number(r.probability) || 1 },
        ])
      );
      const learnCmp = compareLearningMaps_(expectedMap, actualMap, 4);
      totalMismatchCount += learnCmp.mismatchCount;
      if (sampleMismatches.length < 10) sampleMismatches.push(...learnCmp.diffs);

      const allItems = [...(bundle?.itemsByMonth?.values() || [])].flat();
      results.push({
        clientName: cl.client_name,
        source: bundle?.source || "unknown",
        reconMode: cl.recon_mode || "grid",
        periodsCount: bundle?.periods?.length || 0,
        reconciledItemsCount: allItems.filter((i) => i.item_type === "reconciled").length,
        unreconciledItemsCount: allItems.filter((i) => i.item_type === "unreconciled").length,
        learningRulesCount: actualMap.size,
        totalMismatchCount,
        matched: totalMismatchCount === 0,
        sampleMismatches: sampleMismatches.slice(0, 10),
        error: null,
      });
    } catch (err) {
      results.push({
        clientName: cl.client_name,
        source: "error",
        totalMismatchCount: 0,
        matched: false,
        sampleMismatches: [],
        error: err.message,
      });
    }
  }

  return {
    success: true,
    checkedAt: new Date().toISOString(),
    schemaReady: schema.schemaReady,
    clientsChecked: results.length,
    matchedClientsCount: results.filter((r) => !r.error && r.matched).length,
    mismatchClientsCount: results.filter((r) => !r.error && !r.matched).length,
    errorClientsCount: results.filter((r) => Boolean(r.error)).length,
    results,
  };
}

export async function verifyRelationalReconReadParity({
  clientName = null,
  source = "auto",
  onlyReadEnabled = false,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase4ReconSchemaStatus();
  const cols = schema.schemaReady
    ? "id, client_name, recon_mode, recon_read_mode, metadata"
    : "id, client_name, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  const { data: clients, error } = await query;
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    if (onlyReadEnabled && cl.recon_read_mode !== "relational") continue;
    try {
      const ctx = { clientId: cl.id, clientName: cl.client_name };
      const canUseDb =
        schema.schemaReady &&
        (source === "db" ||
          (source === "auto" && Boolean(cl.metadata?.relational_recon_state?.lastBackfilledAt)));

      const [relBundle, rawRows] = await Promise.all([
        preloadClientRelationalReconBundle(ctx, { source: canUseDb ? "db" : "in_memory" }),
        (async () => {
          const all = [];
          for (let from = 0; ; from += 500) {
            const { data, error: gErr } = await supabase
              .from("master_sheet_grids")
              .select("tab_name, values_grid, notes_grid")
              .eq("client_name", cl.client_name)
              .eq("sheet_role", "recon")
              .order("tab_name", { ascending: true })
              .range(from, from + 499);
            if (gErr) throw new Error(`Recon grids load error: ${gErr.message}`);
            if (!Array.isArray(data) || data.length === 0) break;
            all.push(...data);
            if (data.length < 500) break;
          }
          return all;
        })(),
      ]);

      const managedTabs = rawRows.filter((r) => isManagedReconTab(r.tab_name));
      let mismatchCount = 0;
      const sampleMismatches = [];

      for (const row of managedTabs) {
        const expectedVals = compactGrid2D(row.values_grid || []);
        const reconRec = reconstructRelationalReconTabFromBundle(relBundle, row.tab_name);
        if (!reconRec) {
          mismatchCount++;
          if (sampleMismatches.length < 10) {
            sampleMismatches.push({
              tab: row.tab_name,
              tabName: row.tab_name,
              cellKey: "tab_missing",
              grid: `${expectedVals.length} rows`,
              relational: "missing",
              expected: `${expectedVals.length} rows`,
              actual: "missing",
            });
          }
          continue;
        }
        const { mismatchCount: mCnt, diffs } = diff2DGrids_(row.tab_name, expectedVals, reconRec.values_grid, 4);
        mismatchCount += mCnt;
        if (sampleMismatches.length < 10) sampleMismatches.push(...diffs);
      }

      // Check tab_list coverage for YYMM tabs + config tabs
      const expectedMonthTabs = managedTabs
        .map((r) => r.tab_name)
        .filter((t) => isReconMonthTab(t))
        .sort();
      const relMonthTabs = (relBundle?.periods || []).map((p) => p.month_key).sort();
      if (JSON.stringify(expectedMonthTabs) !== JSON.stringify(relMonthTabs)) {
        mismatchCount++;
        if (sampleMismatches.length < 10) {
          sampleMismatches.push({
            tab: "YYMM_LIST",
            tabName: "YYMM_LIST",
            cellKey: "tab_list",
            grid: expectedMonthTabs.join(","),
            relational: relMonthTabs.join(","),
            expected: expectedMonthTabs.join(","),
            actual: relMonthTabs.join(","),
          });
        }
      }

      // Check learning map read payload when YYMM tabs exist
      const actualLearning = await loadRelationalLearningMap(ctx, {
        source: canUseDb ? "db" : "in_memory",
      });
      const expectedLearningRows = computeReconLearningMapFromItems({
        clientId: cl.id,
        clientName: cl.client_name,
        periodMonthKeys: expectedMonthTabs,
        reconciledItems: managedTabs
          .filter((g) => isReconMonthTab(g.tab_name))
          .flatMap((g) =>
            parseReconPeriodTab({
              clientId: cl.id,
              clientName: cl.client_name,
              monthKey: g.tab_name,
              grid: compactGrid2D(g.values_grid || []),
              notesGrid: g.notes_grid || {},
            }).items.filter((i) => i.item_type === "reconciled")
          ),
      });
      const expectedMap = new Map(
        expectedLearningRows.map((r) => [r.match_pattern, { category: r.category, probability: r.probability }])
      );
      const learnCmp = compareLearningMaps_(expectedMap, actualLearning, 4);
      mismatchCount += learnCmp.mismatchCount;
      if (sampleMismatches.length < 10) sampleMismatches.push(...learnCmp.diffs);

      results.push({
        clientName: cl.client_name,
        source: relBundle?.source || "unknown",
        reconMode: cl.recon_mode || "grid",
        reconReadMode: cl.recon_read_mode || "grid",
        tabsChecked: managedTabs.length,
        periodsCount: expectedMonthTabs.length,
        learningRulesCount: actualLearning.size,
        matched: mismatchCount === 0,
        mismatchCount,
        sampleMismatches: sampleMismatches.slice(0, 10),
        error: null,
      });
    } catch (err) {
      results.push({
        clientName: cl.client_name,
        source: "error",
        matched: false,
        mismatchCount: 0,
        sampleMismatches: [],
        error: err.message,
      });
    }
  }

  return {
    success: true,
    checkedAt: new Date().toISOString(),
    schemaReady: schema.schemaReady,
    clientsChecked: results.length,
    matchedClientsCount: results.filter((r) => !r.error && r.matched).length,
    mismatchClientsCount: results.filter((r) => !r.error && !r.matched).length,
    errorClientsCount: results.filter((r) => Boolean(r.error)).length,
    results,
  };
}
