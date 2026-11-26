/**
 * Multi-tenant rollout migration script for:
 *   1. Clearing the obsolete KeyInfo!I9:P19 VAT stagger scratchpad (I9:I10 and J9:P19)
 *      across Master, Client, and Recon workbooks without touching Cash bank accounts (H11:I21).
 *   2. Fixing the 4-column-left prior-month offset bug in Client VAT!I5:AV5 (Accrual)
 *      and VAT!I19:AV19 (Cash) across FY1 (I:R), FY2 (W:AG), and FY3 (AL:AV).
 *
 * Usage (from pulse-management-system/):
 *   node --env-file=.env.local scripts/migrate-vat-and-keyinfo-cleanup.mjs --dry-run --templates
 *   node --env-file=.env.local scripts/migrate-vat-and-keyinfo-cleanup.mjs --dry-run --all
 *   node --env-file=.env.local scripts/migrate-vat-and-keyinfo-cleanup.mjs --apply --client="APPTEST"
 *   node --env-file=.env.local scripts/migrate-vat-and-keyinfo-cleanup.mjs --apply --templates
 *   node --env-file=.env.local scripts/migrate-vat-and-keyinfo-cleanup.mjs --apply --all
 */

import { google } from "googleapis";
import { getSupabaseAdmin, isSupabaseConfigured } from "../services/supabaseClient.js";
import { invalidateMasterEngineCache } from "../services/masterEngineService.js";
import { recalculateClientGrids } from "../services/gasRuntime/clientFormulaEngine.js";
import { invalidatePmaClientCache } from "../services/cacheService.js";

const TEMPLATE_IDS = {
  master: "1Kt0dRbMCd0jgTxBU5uwVMlVN75CIc7YtVJQHnYMR61w",
  client: "1KE0CRs8a92WMzyxy6rMZtr6d9D7cGMpUB3YLV89xjno",
  recon: "1GSIiQDGM26vZveD1WvZYAhQkyxJ8WOgb1eLsJcLekd0",
};

// Chronological 36 monthly columns (0-indexed) on Client VAT & Outgoings tabs:
//   FY1: G..R (6..17) | FY2: V..AG (21..32) | FY3: AK..AV (36..47)
const VAT_BROKEN_SEGMENTS = [
  { label: "FY1 (I..R)", startCol0: 8, endCol0: 17, prevStartCol0: 7 },
  { label: "FY2 (W..AG)", startCol0: 22, endCol0: 32, prevStartCol0: 21 },
  { label: "FY3 (AL..AV)", startCol0: 37, endCol0: 47, prevStartCol0: 36 },
];

const VAT_TARGET_ROWS = [
  { rowNum: 5, rowIdx0: 4, actualRow: 305, outgoingsFlagCol: "C", label: "Accrual" },
  { rowNum: 19, rowIdx0: 18, actualRow: 304, outgoingsFlagCol: "D", label: "Cash" },
];

function stripBypassParam(params = {}) {
  if (!params || typeof params !== "object") return params;
  const { _bypassSupabaseVirtualSheet, ...rest } = params;
  return rest;
}

function getPrimarySaSheetsClient() {
  const email = process.env.SERVICE_ACCOUNT_EMAIL;
  const key = process.env.SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !key) {
    throw new Error("Missing SERVICE_ACCOUNT_EMAIL or SERVICE_ACCOUNT_PRIVATE_KEY in environment.");
  }
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: email, private_key: key },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const base = google.sheets({ version: "v4", auth });
  return {
    spreadsheets: {
      get: (p, opts) => base.spreadsheets.get(stripBypassParam(p), opts),
      batchUpdate: (p, opts) => base.spreadsheets.batchUpdate(stripBypassParam(p), opts),
      values: {
        get: (p, opts) => base.spreadsheets.values.get(stripBypassParam(p), opts),
        batchGet: (p, opts) => base.spreadsheets.values.batchGet(stripBypassParam(p), opts),
        update: (p, opts) => base.spreadsheets.values.update(stripBypassParam(p), opts),
        batchUpdate: (p, opts) => base.spreadsheets.values.batchUpdate(stripBypassParam(p), opts),
      },
    },
  };
}

function colIdxToA1(idx0) {
  let n = idx0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normFormula(val) {
  return String(val || "").replace(/\s+/g, "").toUpperCase();
}

function parseCliArgs(argv) {
  let sawApply = false;
  let sawDryRun = false;
  let all = false;
  let templates = false;
  let includeArchived = false;
  let client = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") sawApply = true;
    else if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--all") all = true;
    else if (arg === "--templates") templates = true;
    else if (arg === "--include-archived") includeArchived = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg.startsWith("--client=")) client = arg.slice("--client=".length).trim();
    else if (arg === "--client" && argv[i + 1]) client = String(argv[++i]).trim();
  }
  return { help: false, apply: sawApply && !sawDryRun, all, templates, includeArchived, client };
}

function printUsage() {
  console.log(
    "Usage:\n" +
      "  node --env-file=.env.local scripts/migrate-vat-and-keyinfo-cleanup.mjs --dry-run --templates\n" +
      "  node --env-file=.env.local scripts/migrate-vat-and-keyinfo-cleanup.mjs --dry-run --all\n" +
      '  node --env-file=.env.local scripts/migrate-vat-and-keyinfo-cleanup.mjs --apply --client="APPTEST"\n' +
      "  node --env-file=.env.local scripts/migrate-vat-and-keyinfo-cleanup.mjs --apply --templates\n" +
      "  node --env-file=.env.local scripts/migrate-vat-and-keyinfo-cleanup.mjs --apply --all\n"
  );
}

function isNonEmptyCell(val) {
  return val !== "" && val !== null && val !== undefined;
}

function validateAndBuildVatFormula(existingFormula, col, prevCol, rowSpec) {
  const raw = String(existingFormula || "").trim();
  if (!raw) {
    throw new Error(`Empty formula at ${col}${rowSpec.rowNum}`);
  }
  const normalized = normFormula(raw);
  const expectedPrefix = `=IF(OUTGOINGS!${col}${rowSpec.actualRow}<>"",OUTGOINGS!${col}${rowSpec.actualRow},SUMPRODUCT((OUTGOINGS!${col}125:`;
  if (!normalized.startsWith(expectedPrefix) || !normalized.includes(`SUMPRODUCT((OUTGOINGS!`)) {
    throw new Error(`Unexpected formula pattern at ${col}${rowSpec.rowNum}: ${raw}`);
  }
  const rEndMatch = raw.match(new RegExp(`Outgoings!${col}125:${col}(\\d+)`, "i"));
  const rEnd = rEndMatch ? parseInt(rEndMatch[1], 10) : 226;
  const { actualRow, outgoingsFlagCol } = rowSpec;
  return (
    `=if(Outgoings!${col}${actualRow}<>"",Outgoings!${col}${actualRow},` +
    `SUMPRODUCT((Outgoings!${col}125:${col}${rEnd})*(if(Outgoings!$B125:$B${rEnd}="Yes",KeyInfo!$B$9,0))*(if(Outgoings!$${outgoingsFlagCol}125:$${outgoingsFlagCol}${rEnd}="Curr",1,0)))+` +
    `SUMPRODUCT((Outgoings!${prevCol}125:${prevCol}${rEnd})*(if(Outgoings!$B125:$B${rEnd}="Yes",KeyInfo!$B$9,0))*(if(Outgoings!$${outgoingsFlagCol}125:$${outgoingsFlagCol}${rEnd}<>"Curr",1,0))))`
  );
}

function extractSheetGridErrors(rows = []) {
  const errors = [];
  const errRe = /^#(VALUE!|REF!|NAME\?|ERROR!|N\/A|DIV\/0!)/i;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const s = String(row[c] ?? "").trim();
      if (errRe.test(s)) {
        errors.push(`R${r + 1}C${c + 1}:${s}`);
      }
    }
  }
  return errors;
}

function computeRowDrift(beforeRow = [], afterRow = []) {
  let maxDiff = 0;
  const changedCols = [];
  const len = Math.max(beforeRow.length, afterRow.length);
  for (let c = 0; c < len; c++) {
    const b = typeof beforeRow[c] === "number" ? beforeRow[c] : parseFloat(String(beforeRow[c] ?? "").replace(/[£$€,\s]/g, ""));
    const a = typeof afterRow[c] === "number" ? afterRow[c] : parseFloat(String(afterRow[c] ?? "").replace(/[£$€,\s]/g, ""));
    const bNum = Number.isFinite(b) ? b : 0;
    const aNum = Number.isFinite(a) ? a : 0;
    const diff = Math.abs(bNum - aNum);
    if (diff > 1e-6) {
      if (diff > maxDiff) maxDiff = diff;
      changedCols.push({ idx: c, before: bNum, after: aNum });
    }
  }
  return { maxDiff, changedCols };
}

/**
 * Item 1 (Google Sheet): Clear obsolete KeyInfo!I9:I10 and KeyInfo!J9:P19
 * while leaving H11:I21 (Cash bank accounts) untouched.
 */
async function cleanupGoogleSheetKeyInfo(sheets, spreadsheetId, label, apply) {
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: ["KeyInfo!A2", "KeyInfo!I9:I10", "KeyInfo!J9:P19", "KeyInfo!H11:I21"],
    valueRenderOption: "FORMULA",
  });
  const vr = res.data.valueRanges || [];
  const a2Val = String(vr[0]?.values?.[0]?.[0] ?? "").trim();
  if (a2Val.startsWith("=") && /importrange/i.test(a2Val)) {
    console.log(`  [${label} KeyInfo Sheet] Skipped (KeyInfo!A2 uses IMPORTRANGE: ${a2Val})`);
    return { skipped: true, cellsToClear: 0 };
  }

  const i9i10 = vr[1]?.values || [];
  const j9p19 = vr[2]?.values || [];
  const h11i21Before = vr[3]?.values || [];

  let i9i10Count = 0;
  for (let r = 0; r < 2; r++) {
    if (isNonEmptyCell(i9i10[r]?.[0])) i9i10Count++;
  }
  let j9p19Count = 0;
  for (let r = 0; r < 11; r++) {
    for (let c = 0; c < 7; c++) {
      if (isNonEmptyCell(j9p19[r]?.[c])) j9p19Count++;
    }
  }

  const totalToClear = i9i10Count + j9p19Count;
  console.log(
    `  [${label} KeyInfo Sheet] I9:I10 non-empty=${i9i10Count}, J9:P19 non-empty=${j9p19Count}, H11:I21 rows=${h11i21Before.length}`
  );

  if (!apply || totalToClear === 0) {
    return { applied: false, cellsToClear: totalToClear };
  }

  const updates = [];
  if (i9i10Count > 0) {
    updates.push({
      range: "KeyInfo!I9:I10",
      values: [[""], [""]],
    });
  }
  if (j9p19Count > 0) {
    updates.push({
      range: "KeyInfo!J9:P19",
      values: Array.from({ length: 11 }, () => Array(7).fill("")),
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "RAW", data: updates },
  });

  // Verify H11:I21 intact and I9:I10 + J9:P19 cleared
  const verifyRes = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: ["KeyInfo!I9:I10", "KeyInfo!J9:P19", "KeyInfo!H11:I21"],
    valueRenderOption: "FORMULA",
  });
  const vVr = verifyRes.data.valueRanges || [];
  const h11i21After = vVr[2]?.values || [];
  if (JSON.stringify(h11i21Before) !== JSON.stringify(h11i21After)) {
    throw new Error(`SAFETY CHECK FAILED on ${label}: KeyInfo!H11:I21 changed during KeyInfo cleanup!`);
  }
  const remaining = [...(vVr[0]?.values || []), ...(vVr[1]?.values || [])]
    .flat()
    .filter((v) => isNonEmptyCell(v));
  if (remaining.length > 0) {
    throw new Error(`Verification failed on ${label}: ${remaining.length} non-empty cells remain in KeyInfo!I9:P19`);
  }

  return { applied: true, cellsToClear: totalToClear };
}

/**
 * Item 2 (Google Sheet): Repair VAT!I5:R5, W5:AG5, AL5:AV5 and I19:R19, W19:AG19, AL19:AV19.
 */
async function fixGoogleSheetVat(sheets, spreadsheetId, label, apply) {
  const formulaRanges = [];
  for (const rowSpec of VAT_TARGET_ROWS) {
    for (const seg of VAT_BROKEN_SEGMENTS) {
      formulaRanges.push(`VAT!${colIdxToA1(seg.startCol0)}${rowSpec.rowNum}:${colIdxToA1(seg.endCol0)}${rowSpec.rowNum}`);
    }
  }

  const [fmsRes, preUnfmtRes] = await Promise.all([
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: formulaRanges,
      valueRenderOption: "FORMULA",
    }),
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ["VAT!G5:AV5", "VAT!G8:AV8", "VAT!G19:AV19", "VAT!G22:AV22", "Cash!B21:AK21"],
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const fmsVr = fmsRes.data.valueRanges || [];
  const valueUpdates = [];
  let formulaDiffCount = 0;

  let rangeCursor = 0;
  for (const rowSpec of VAT_TARGET_ROWS) {
    for (const seg of VAT_BROKEN_SEGMENTS) {
      const rangeStr = formulaRanges[rangeCursor];
      const existingRow = fmsVr[rangeCursor]?.values?.[0] || [];
      rangeCursor++;

      const newRow = [];
      let segDirty = false;
      for (let c = seg.startCol0; c <= seg.endCol0; c++) {
        const offset = c - seg.startCol0;
        const col = colIdxToA1(c);
        const prevCol = colIdxToA1(seg.prevStartCol0 + offset);
        const existing = existingRow[offset] ?? "";
        const target = validateAndBuildVatFormula(existing, col, prevCol, rowSpec);
        if (normFormula(existing) !== normFormula(target)) {
          segDirty = true;
          formulaDiffCount++;
        }
        newRow.push(target);
      }
      if (segDirty) {
        valueUpdates.push({ range: rangeStr, values: [newRow] });
      }
    }
  }

  console.log(`  [${label} VAT Sheet] Formula cells needing fix=${formulaDiffCount} across ${valueUpdates.length} range blocks`);

  if (!apply || valueUpdates.length === 0) {
    return { applied: false, formulaDiffCount };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data: valueUpdates },
  });

  const [postUnfmtRes, postFmtRes] = await Promise.all([
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ["VAT!G5:AV5", "VAT!G8:AV8", "VAT!G19:AV19", "VAT!G22:AV22", "Cash!B21:AK21"],
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ["VAT!G1:AX35", "Cash!B21:AK21", "Cash!B63:AK63"],
      valueRenderOption: "FORMATTED_VALUE",
    }),
  ]);

  const preVr = preUnfmtRes.data.valueRanges || [];
  const postVr = postUnfmtRes.data.valueRanges || [];
  const watchLabels = ["VAT!G5:AV5", "VAT!G8:AV8", "VAT!G19:AV19", "VAT!G22:AV22", "Cash!B21:AK21"];
  for (let i = 0; i < watchLabels.length; i++) {
    const { maxDiff, changedCols } = computeRowDrift(preVr[i]?.values?.[0] || [], postVr[i]?.values?.[0] || []);
    if (changedCols.length > 0) {
      console.log(`  [${label} VAT Verify] ${watchLabels[i]} changed ${changedCols.length} cells (maxDelta=${maxDiff.toFixed(2)})`);
    } else {
      console.log(`  [${label} VAT Verify] ${watchLabels[i]} unchanged (0.00 delta)`);
    }
  }

  const fmtErrors = [];
  for (const r of postFmtRes.data.valueRanges || []) {
    fmtErrors.push(...extractSheetGridErrors(r.values || []));
  }
  if (fmtErrors.length > 0) {
    throw new Error(`Formula errors detected on ${label} after VAT update: ${fmtErrors.slice(0, 10).join(", ")}`);
  }

  return { applied: true, formulaDiffCount };
}

/**
 * Item 1 (Supabase master_sheet_grids): Clear KeyInfo!I9:I10 and KeyInfo!J9:P19
 * across all sheet_roles for this client while asserting H11:I21 is untouched.
 */
async function cleanupSupabaseKeyInfo(sb, clientName, apply) {
  const { data: rows, error } = await sb
    .from("master_sheet_grids")
    .select("id, sheet_role, values_grid, formulas_grid")
    .eq("client_name", clientName)
    .eq("tab_name", "KeyInfo");

  if (error) throw new Error(`Supabase KeyInfo query error for ${clientName}: ${error.message}`);
  if (!rows || rows.length === 0) return { skipped: true, cellsToClear: 0 };

  let totalCells = 0;
  for (const row of rows) {
    const vg = Array.isArray(row.values_grid) ? row.values_grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];
    const fg = Array.isArray(row.formulas_grid) ? row.formulas_grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];

    const snapH11I21 = (grid) => {
      const out = [];
      for (let r = 10; r <= 20; r++) out.push([grid[r]?.[7] ?? "", grid[r]?.[8] ?? ""]);
      return JSON.stringify(out);
    };
    const h11VBefore = snapH11I21(vg);
    const h11FBefore = snapH11I21(fg);

    let roleChanges = 0;
    const clearCell = (r, c) => {
      if (vg[r] && isNonEmptyCell(vg[r][c])) {
        vg[r][c] = "";
        roleChanges++;
      }
      if (fg[r] && isNonEmptyCell(fg[r][c])) {
        fg[r][c] = "";
        roleChanges++;
      }
    };

    // I9:I10 -> rows 8..9, col 8
    for (let r = 8; r <= 9; r++) clearCell(r, 8);
    // J9:P19 -> rows 8..18, cols 9..15
    for (let r = 8; r <= 18; r++) {
      for (let c = 9; c <= 15; c++) clearCell(r, c);
    }

    if (snapH11I21(vg) !== h11VBefore || snapH11I21(fg) !== h11FBefore) {
      throw new Error(`SAFETY CHECK FAILED on ${clientName} [${row.sheet_role}] KeyInfo!H11:I21 changed!`);
    }

    if (roleChanges > 0) {
      console.log(`  [${clientName} Supabase KeyInfo:${row.sheet_role}] Cells to clear=${roleChanges}`);
      totalCells += roleChanges;
      if (apply) {
        const { error: upErr } = await sb
          .from("master_sheet_grids")
          .update({ values_grid: vg, formulas_grid: fg, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (upErr) throw new Error(`Supabase KeyInfo update error for ${clientName}: ${upErr.message}`);
      }
    }
  }

  return { applied: apply && totalCells > 0, cellsToClear: totalCells };
}

/**
 * Item 2 (Supabase master_sheet_grids): Fix VAT Row 5 & Row 19 formulas, recalculate client grids,
 * and persist changed values_grid tabs (plus mirrored Cash if changed).
 */
async function fixSupabaseVat(sb, clientName, apply) {
  const { data: vatRow, error } = await sb
    .from("master_sheet_grids")
    .select("id, values_grid, formulas_grid")
    .eq("client_name", clientName)
    .eq("sheet_role", "client")
    .eq("tab_name", "VAT")
    .maybeSingle();

  if (error) throw new Error(`Supabase VAT query error for ${clientName}: ${error.message}`);
  if (!vatRow) return { skipped: true, formulaDiffCount: 0 };

  const formulasGrid = Array.isArray(vatRow.formulas_grid)
    ? vatRow.formulas_grid.map((r) => (Array.isArray(r) ? [...r] : []))
    : [];

  let formulaDiffCount = 0;
  for (const rowSpec of VAT_TARGET_ROWS) {
    if (!Array.isArray(formulasGrid[rowSpec.rowIdx0])) formulasGrid[rowSpec.rowIdx0] = [];
    for (const seg of VAT_BROKEN_SEGMENTS) {
      for (let c = seg.startCol0; c <= seg.endCol0; c++) {
        const offset = c - seg.startCol0;
        const col = colIdxToA1(c);
        const prevCol = colIdxToA1(seg.prevStartCol0 + offset);
        const existing = formulasGrid[rowSpec.rowIdx0][c] ?? "";
        const target = validateAndBuildVatFormula(existing, col, prevCol, rowSpec);
        if (normFormula(existing) !== normFormula(target)) {
          formulasGrid[rowSpec.rowIdx0][c] = target;
          formulaDiffCount++;
        }
      }
    }
  }

  console.log(`  [${clientName} Supabase VAT] Formula cells needing fix=${formulaDiffCount}`);
  if (!apply || formulaDiffCount === 0) {
    return { applied: false, formulaDiffCount };
  }

  const nowIso = new Date().toISOString();
  const { error: upVatErr } = await sb
    .from("master_sheet_grids")
    .update({ formulas_grid: formulasGrid, updated_at: nowIso })
    .eq("id", vatRow.id);
  if (upVatErr) throw new Error(`Supabase VAT formula update error for ${clientName}: ${upVatErr.message}`);

  const { data: allClientGrids, error: loadErr } = await sb
    .from("master_sheet_grids")
    .select("id, tab_name, values_grid, formulas_grid, notes_grid")
    .eq("client_name", clientName)
    .eq("sheet_role", "client");
  if (loadErr) throw new Error(`Supabase client grids reload error for ${clientName}: ${loadErr.message}`);

  const preSnaps = new Map();
  const rowIdsByTab = new Map();
  const grids = {};
  for (const row of allClientGrids || []) {
    rowIdsByTab.set(row.tab_name, row.id);
    preSnaps.set(row.tab_name, JSON.stringify(row.values_grid || []));
    grids[row.tab_name] = {
      values: Array.isArray(row.values_grid) ? row.values_grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [],
      formulas: row.formulas_grid || [],
      notes: row.notes_grid || {},
    };
  }

  const preCashR21 = [...(grids.Cash?.values?.[20] || [])];
  const preVatR5 = [...(grids.VAT?.values?.[4] || [])];
  const preVatR19 = [...(grids.VAT?.values?.[18] || [])];

  recalculateClientGrids(grids, { changedTabs: ["VAT"] });

  const vatErrors = [
    ...extractSheetGridErrors(grids.VAT?.values || []),
    ...extractSheetGridErrors((grids.Cash?.values || []).slice(20, 22)),
    ...extractSheetGridErrors((grids.Cash?.values || []).slice(62, 64)),
  ];
  if (vatErrors.length > 0) {
    throw new Error(`Supabase formula errors after VAT recalc on ${clientName}: ${vatErrors.slice(0, 10).join(", ")}`);
  }

  const changedTabs = [];
  for (const [tabName, gridObj] of Object.entries(grids)) {
    const nextJson = JSON.stringify(gridObj.values || []);
    if (nextJson !== preSnaps.get(tabName)) {
      const id = rowIdsByTab.get(tabName);
      if (!id) continue;
      const { error: tabErr } = await sb
        .from("master_sheet_grids")
        .update({ values_grid: gridObj.values, updated_at: nowIso })
        .eq("id", id);
      if (tabErr) throw new Error(`Failed saving recalculated ${tabName} for ${clientName}: ${tabErr.message}`);
      changedTabs.push(tabName);
    }
  }

  const r5Drift = computeRowDrift(preVatR5, grids.VAT?.values?.[4] || []);
  const r19Drift = computeRowDrift(preVatR19, grids.VAT?.values?.[18] || []);
  const cashDrift = computeRowDrift(preCashR21, grids.Cash?.values?.[20] || []);
  console.log(
    `  [${clientName} Supabase Recalc] Changed tabs=${JSON.stringify(changedTabs)} | ` +
      `VAT R5 delta=${r5Drift.maxDiff.toFixed(2)}, VAT R19 delta=${r19Drift.maxDiff.toFixed(2)}, Cash R21 delta=${cashDrift.maxDiff.toFixed(2)}`
  );

  // If client Cash changed, keep mirrored master/recon Cash values_grid aligned if present
  if (changedTabs.includes("Cash") && grids.Cash?.values) {
    const { data: mirroredCashRows } = await sb
      .from("master_sheet_grids")
      .select("id, sheet_role")
      .eq("client_name", clientName)
      .in("sheet_role", ["master", "recon"])
      .eq("tab_name", "Cash");
    for (const mr of mirroredCashRows || []) {
      await sb
        .from("master_sheet_grids")
        .update({ values_grid: grids.Cash.values, updated_at: nowIso })
        .eq("id", mr.id);
    }
  }

  return { applied: true, formulaDiffCount, changedTabs };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help || (!args.all && !args.templates && !args.client)) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const sheets = getPrimarySaSheetsClient();
  const sb = isSupabaseConfigured() ? getSupabaseAdmin() : null;
  console.log(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);

  if (args.templates) {
    console.log("\n=== Target: Master Template ===");
    await cleanupGoogleSheetKeyInfo(sheets, TEMPLATE_IDS.master, "Master Template", args.apply);

    console.log("\n=== Target: Client Template ===");
    await cleanupGoogleSheetKeyInfo(sheets, TEMPLATE_IDS.client, "Client Template", args.apply);
    await fixGoogleSheetVat(sheets, TEMPLATE_IDS.client, "Client Template", args.apply);

    console.log("\n=== Target: Recon Template ===");
    await cleanupGoogleSheetKeyInfo(sheets, TEMPLATE_IDS.recon, "Recon Template", args.apply);
  }

  if (args.client || args.all) {
    if (!sb) throw new Error("Supabase is required to enumerate clients.");
    const { data: rows, error } = await sb
      .from("clients")
      .select("client_name, master_sheet_id, client_sheet_id, recon_sheet_id, status, grid_storage_retired")
      .order("client_name");
    if (error) throw new Error(`Failed loading clients: ${error.message}`);

    const allClients = rows || [];
    const targets = args.client
      ? allClients.filter((c) => String(c.client_name || "").toLowerCase() === args.client.toLowerCase())
      : allClients.filter((c) => args.includeArchived || String(c.status || "live").toLowerCase() !== "archived");

    if (targets.length === 0) {
      console.error(`No matching clients found for filter: "${args.client || "all"}"`);
      process.exit(1);
    }

    for (const c of targets) {
      const name = c.client_name;
      console.log(`\n=== Target: ${name} (status=${c.status || "live"}) ===`);
      try {
        // Google Sheets (Master, Client, Recon)
        if (c.master_sheet_id && !String(c.master_sheet_id).startsWith("sb-")) {
          await cleanupGoogleSheetKeyInfo(sheets, c.master_sheet_id, `${name} Master`, args.apply);
        }
        if (c.client_sheet_id && !String(c.client_sheet_id).startsWith("sb-")) {
          await cleanupGoogleSheetKeyInfo(sheets, c.client_sheet_id, `${name} Client`, args.apply);
          await fixGoogleSheetVat(sheets, c.client_sheet_id, `${name} Client`, args.apply);
        } else {
          console.log(`  [${name}] No real Google client_sheet_id (${c.client_sheet_id || "none"}), skipping Google Client Sheet.`);
        }
        if (c.recon_sheet_id && !String(c.recon_sheet_id).startsWith("sb-")) {
          await cleanupGoogleSheetKeyInfo(sheets, c.recon_sheet_id, `${name} Recon`, args.apply);
        }

        // Supabase virtual workbooks (skip retired master_sheet_grids)
        if (!c.grid_storage_retired) {
          await cleanupSupabaseKeyInfo(sb, name, args.apply);
          await fixSupabaseVat(sb, name, args.apply);
        } else {
          console.log(`  [${name}] grid_storage_retired=true — skipping retired master_sheet_grids cleanup/VAT recalc.`);
        }

        if (args.apply) {
          invalidateMasterEngineCache(name);
          await invalidatePmaClientCache(c.client_sheet_id, c.master_sheet_id, ["vat", "cash", "views", "dashboard", "all"]).catch(() => {});
        }
      } catch (err) {
        console.error(`  [${name} ERROR]: ${err.message}`);
      }
    }
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
