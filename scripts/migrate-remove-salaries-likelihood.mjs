/**
 * Multi-tenant rollout migration script to remove Salaries Column J ("% likel.")
 * functionality and all formula references to it (Option A: in-place removal keeping
 * monthly columns anchored at Column L / index 11).
 *
 * Usage (from pulse-management-system/):
 *   node --env-file=.env.local scripts/migrate-remove-salaries-likelihood.mjs --dry-run --client="Eleven"
 *   node --env-file=.env.local scripts/migrate-remove-salaries-likelihood.mjs --apply --client="Eleven"
 *   node --env-file=.env.local scripts/migrate-remove-salaries-likelihood.mjs --dry-run --templates
 *   node --env-file=.env.local scripts/migrate-remove-salaries-likelihood.mjs --apply --templates
 *   node --env-file=.env.local scripts/migrate-remove-salaries-likelihood.mjs --dry-run --all
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { google } from "googleapis";
import { getAllClients } from "../services/workspaces.js";
import { getSupabaseAdmin, isSupabaseConfigured } from "../services/supabaseClient.js";
import { invalidateMasterEngineCache } from "../services/masterEngineService.js";
import { recalculateClientGrids } from "../services/gasRuntime/clientFormulaEngine.js";
import { invalidateSalariesCache } from "../services/salariesService.js";

const TEMPLATE_CLIENT_SHEET_ID = "1KE0CRs8a92WMzyxy6rMZtr6d9D7cGMpUB3YLV89xjno";

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

function parseCliArgs(argv) {
  let sawApply = false;
  let sawDryRun = false;
  let all = false;
  let templates = false;
  let client = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") sawApply = true;
    else if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--all") all = true;
    else if (arg === "--templates") templates = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg.startsWith("--client=")) client = arg.slice("--client=".length).trim();
    else if (arg === "--client" && argv[i + 1]) client = String(argv[++i]).trim();
  }
  return { help: false, apply: sawApply && !sawDryRun, all, templates, client };
}

function printUsage() {
  console.log(
    "Usage:\n" +
      '  node --env-file=.env.local scripts/migrate-remove-salaries-likelihood.mjs --dry-run --client="Eleven"\n' +
      '  node --env-file=.env.local scripts/migrate-remove-salaries-likelihood.mjs --apply --client="Eleven"\n' +
      "  node --env-file=.env.local scripts/migrate-remove-salaries-likelihood.mjs --dry-run --templates\n" +
      "  node --env-file=.env.local scripts/migrate-remove-salaries-likelihood.mjs --apply --templates\n" +
      "  node --env-file=.env.local scripts/migrate-remove-salaries-likelihood.mjs --dry-run --all\n"
  );
}

const TARGET_TOTAL_ROWS = [
  { rowNum: 55, buildFormula: (col) => `=SUM(${col}4:${col}53)` },
  { rowNum: 57, buildFormula: (col) => `=SUMPRODUCT(${col}4:${col}53,$G4:$G53)` },
  { rowNum: 205, buildFormula: (col) => `=SUM(${col}154:${col}203)` },
  { rowNum: 207, buildFormula: (col) => `=SUMPRODUCT(${col}154:${col}203,$G154:$G203)` },
  { rowNum: 355, buildFormula: (col) => `=SUM(${col}304:${col}353)` },
  { rowNum: 357, buildFormula: (col) => `=SUMPRODUCT(${col}304:${col}353,$G304:$G353)` },
];

function isLikelihoodCfRule(cf) {
  const cond = cf?.booleanRule?.condition;
  if (!cond || cond.type !== "NUMBER_LESS") return false;
  const vals = (cond.values || []).map((v) => String(v?.userEnteredValue || "").trim());
  if (!vals.includes("100%") && !vals.includes("1")) return false;
  const ranges = cf?.ranges || [];
  return ranges.some(
    (r) =>
      r.startColumnIndex <= 10 &&
      r.endColumnIndex >= 10 &&
      (r.startRowIndex === 3 || r.startRowIndex === 153 || r.startRowIndex === 303)
  );
}

function normFormula(val) {
  return String(val || "").replace(/\s+/g, "").toUpperCase();
}

function maxNumericDrift(beforeRows = [], afterRows = []) {
  let maxDiff = 0;
  const rowCount = Math.max(beforeRows.length, afterRows.length);
  for (let r = 0; r < rowCount; r++) {
    const bRow = beforeRows[r] || [];
    const aRow = afterRows[r] || [];
    const colCount = Math.max(bRow.length, aRow.length);
    for (let c = 0; c < colCount; c++) {
      const bVal = typeof bRow[c] === "number" ? bRow[c] : parseFloat(String(bRow[c] ?? "").replace(/[£$€,\s]/g, ""));
      const aVal = typeof aRow[c] === "number" ? aRow[c] : parseFloat(String(aRow[c] ?? "").replace(/[£$€,\s]/g, ""));
      if (Number.isFinite(bVal) || Number.isFinite(aVal)) {
        const diff = Math.abs((Number.isFinite(bVal) ? bVal : 0) - (Number.isFinite(aVal) ? aVal : 0));
        if (diff > maxDiff) maxDiff = diff;
      }
    }
  }
  return maxDiff;
}

async function migrateGoogleSheet(sheets, spreadsheetId, label, apply) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title,gridProperties),conditionalFormats)",
  });
  const salSheet = (meta.data.sheets || []).find((s) => s.properties?.title === "Salaries");
  if (!salSheet) {
    console.log(`  [${label}] No 'Salaries' tab found in sheet ${spreadsheetId}, skipping sheet.`);
    return { skipped: true };
  }
  const sheetId = salSheet.properties.sheetId;
  const colCount = salSheet.properties.gridProperties?.columnCount || 284;
  const frozenCols = salSheet.properties.gridProperties?.frozenColumnCount;

  const colMetaResp = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: ["Salaries!J1:K1"],
    fields: "sheets.data.columnMetadata",
  });
  const colMeta = colMetaResp.data.sheets?.[0]?.data?.[0]?.columnMetadata || [];
  const jHidden = Boolean(colMeta[0]?.hiddenByUser);
  const kHidden = Boolean(colMeta[1]?.hiddenByUser);

  const [fmsRes, preValsRes] = await Promise.all([
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [
        "Salaries!J1:J53",
        "Salaries!A154:A154",
        "Salaries!A304:A304",
        "Salaries!L55:JC55",
        "Salaries!L57:JC57",
        "Salaries!L205:JC205",
        "Salaries!L207:JC207",
        "Salaries!L355:JC355",
        "Salaries!L357:JC357",
        "Salaries!I55:J77",
        "Salaries!I205:J208",
        "Salaries!I355:J360",
      ],
      valueRenderOption: "FORMULA",
    }),
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [
        "Salaries!L55:JC58",
        "Salaries!L60:JC77",
        "Salaries!L205:JC208",
        "Salaries!L355:JC362",
        "Outgoings!G6:AW8",
      ],
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const vr = fmsRes.data.valueRanges || [];
  const jColRows = vr[0]?.values || [];
  const a154Val = vr[1]?.values?.[0]?.[0] ?? "";
  const a304Val = vr[2]?.values?.[0]?.[0] ?? "";
  const rowFormulaMap = new Map([
    [55, vr[3]?.values?.[0] || []],
    [57, vr[4]?.values?.[0] || []],
    [205, vr[5]?.values?.[0] || []],
    [207, vr[6]?.values?.[0] || []],
    [355, vr[7]?.values?.[0] || []],
    [357, vr[8]?.values?.[0] || []],
  ]);
  const ij55_77 = vr[9]?.values || [];
  const ij205_208 = vr[10]?.values || [];
  const ij355_360 = vr[11]?.values || [];

  const valueUpdates = [];
  const clearRanges = [];

  if (String(jColRows[0]?.[0] ?? "").trim() !== "") {
    clearRanges.push("Salaries!J1");
  }
  const j4to53HasValues = jColRows.slice(3, 53).some((r) => String(r?.[0] ?? "").trim() !== "");
  if (j4to53HasValues) {
    clearRanges.push("Salaries!J4:J53");
  }
  if (clearRanges.length > 0) {
    for (const r of clearRanges) {
      valueUpdates.push({
        range: r,
        values: r === "Salaries!J1" ? [[""]] : Array.from({ length: 50 }, () => [""]),
      });
    }
  }

  if (normFormula(a154Val) === "={A4:J53}") {
    valueUpdates.push({ range: "Salaries!A154", values: [["={A4:I53}"]] });
  }
  if (normFormula(a304Val) === "={A4:J53}") {
    valueUpdates.push({ range: "Salaries!A304", values: [["={A4:I53}"]] });
  }

  // Move any summary/totals labels sitting in Column J -> Column I
  const labelCutPasteBlocks = [];
  const blockDefs = [
    { name: "55:77", rows: ij55_77, startRow0: 54, endRow0: 77 },
    { name: "205:208", rows: ij205_208, startRow0: 204, endRow0: 208 },
    { name: "355:358", rows: ij355_360.slice(0, 4), startRow0: 354, endRow0: 358 },
  ];
  for (const blk of blockDefs) {
    const jHasLabels = blk.rows.some((r) => String(r?.[1] ?? "").trim() !== "");
    const iHasLabels = blk.rows.some((r) => String(r?.[0] ?? "").trim() !== "");
    if (jHasLabels && !iHasLabels) {
      labelCutPasteBlocks.push(blk);
    }
  }

  const i360Val = ij355_360[5]?.[0] ?? "";
  const j360Val = ij355_360[5]?.[1] ?? "";
  const moveRow360Mirror = normFormula(j360Val) === "={J73:JC75}" || (normFormula(j360Val) !== "" && normFormula(i360Val) !== "={I73:JC75}");
  if (moveRow360Mirror) {
    valueUpdates.push({ range: "Salaries!J360", values: [[""]] });
    valueUpdates.push({ range: "Salaries!I360", values: [["={I73:JC75}"]] });
  }

  let totalFormulaUpdates = 0;
  for (const { rowNum, buildFormula } of TARGET_TOTAL_ROWS) {
    const existingRow = rowFormulaMap.get(rowNum) || [];
    const maxColIdx = Math.min(262, colCount - 1);
    const newRow = [];
    let rowNeedsUpdate = false;
    for (let c = 11; c <= maxColIdx; c++) {
      const colLetter = colIdxToA1(c);
      const targetFormula = buildFormula(colLetter);
      const currentVal = existingRow[c - 11] ?? "";
      if (normFormula(currentVal) !== normFormula(targetFormula)) {
        rowNeedsUpdate = true;
        totalFormulaUpdates++;
      }
      newRow.push(targetFormula);
    }
    if (rowNeedsUpdate) {
      const endColLetter = colIdxToA1(maxColIdx);
      valueUpdates.push({
        range: `Salaries!L${rowNum}:${endColLetter}${rowNum}`,
        values: [newRow],
      });
    }
  }

  // Structural batchUpdate requests: clear J4:J53 validation, hide J if needed, remove CF[0], freeze A:I
  const batchRequests = [
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 3, endRowIndex: 53, startColumnIndex: 9, endColumnIndex: 10 },
        rule: null,
      },
    },
  ];
  if (!jHidden) {
    batchRequests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 10 },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    });
  }
  if (!kHidden) {
    batchRequests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 10, endIndex: 11 },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    });
  }
  if (frozenCols === 10) {
    batchRequests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenColumnCount: 9 } },
        fields: "gridProperties.frozenColumnCount",
      },
    });
  }

  const cfRules = salSheet.conditionalFormats || [];
  const cfIndicesToDelete = [];
  cfRules.forEach((cf, idx) => {
    if (isLikelihoodCfRule(cf)) cfIndicesToDelete.push(idx);
  });
  // Delete in descending order so indices remain valid
  for (let i = cfIndicesToDelete.length - 1; i >= 0; i--) {
    batchRequests.push({
      deleteConditionalFormatRule: { sheetId, index: cfIndicesToDelete[i] },
    });
  }

  for (const blk of labelCutPasteBlocks) {
    batchRequests.push({
      cutPaste: {
        source: {
          sheetId,
          startRowIndex: blk.startRow0,
          endRowIndex: blk.endRow0,
          startColumnIndex: 9,
          endColumnIndex: 10,
        },
        destination: {
          sheetId,
          rowIndex: blk.startRow0,
          columnIndex: 8,
        },
        pasteType: "PASTE_NORMAL",
      },
    });
  }

  if (moveRow360Mirror) {
    batchRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 359, endRowIndex: 362, startColumnIndex: 8, endColumnIndex: 9 },
        cell: { userEnteredFormat: { horizontalAlignment: "RIGHT", wrapStrategy: "OVERFLOW_CELL" } },
        fields: "userEnteredFormat(horizontalAlignment,wrapStrategy)",
      },
    });
  }

  console.log(
    `  [${label} Sheet] clearRanges=${JSON.stringify(clearRanges)}, ` +
      `a154=${normFormula(a154Val) === "={A4:J53}"}, a304=${normFormula(a304Val) === "={A4:J53}"}, ` +
      `moveLabelsJtoI=${JSON.stringify(labelCutPasteBlocks.map((b) => b.name))}, moveRow360Mirror=${moveRow360Mirror}, ` +
      `totalFormulaCellsToUpdate=${totalFormulaUpdates}, cfRulesToDelete=${cfIndicesToDelete.length}, ` +
      `freeze9=${frozenCols === 10}, hideJ=${!jHidden}, hideK=${!kHidden}`
  );

  if (!apply) {
    return { applied: false, valueUpdates: valueUpdates.length, totalFormulaUpdates };
  }

  if (batchRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: batchRequests },
    });
  }
  if (valueUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: valueUpdates },
    });
  }

  // Post-migration verification
  const postValsRes = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [
      "Salaries!L55:JC58",
      "Salaries!L60:JC77",
      "Salaries!L205:JC208",
      "Salaries!L355:JC362",
      "Outgoings!G6:AW8",
    ],
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const preRanges = preValsRes.data.valueRanges || [];
  const postRanges = postValsRes.data.valueRanges || [];
  const labels = ["Salaries!L55:JC58", "Salaries!L60:JC77", "Salaries!L205:JC208", "Salaries!L355:JC362", "Outgoings!G6:AW8"];
  for (let i = 0; i < labels.length; i++) {
    const drift = maxNumericDrift(preRanges[i]?.values || [], postRanges[i]?.values || []);
    console.log(`  [${label} Verify] ${labels[i]} max numeric drift = ${drift.toFixed(6)}`);
  }

  return { applied: true, valueUpdates: valueUpdates.length, totalFormulaUpdates };
}

async function migrateSupabaseGrid(sb, clientName, apply) {
  const { data: gridRow, error } = await sb
    .from("master_sheet_grids")
    .select("id, client_name, values_grid, formulas_grid")
    .eq("client_name", clientName)
    .eq("sheet_role", "client")
    .eq("tab_name", "Salaries")
    .maybeSingle();

  if (error) {
    console.warn(`  [${clientName} Supabase] Query error: ${error.message}`);
    return { skipped: true };
  }
  if (!gridRow) {
    console.log(`  [${clientName} Supabase] No client Salaries grid in master_sheet_grids.`);
    return { skipped: true };
  }

  const valuesGrid = Array.isArray(gridRow.values_grid) ? gridRow.values_grid.map((r) => [...(r || [])]) : [];
  const formulasGrid = Array.isArray(gridRow.formulas_grid) ? gridRow.formulas_grid.map((r) => [...(r || [])]) : [];
  let changes = 0;

  // Clear J1 and J4:J53 in both values_grid and formulas_grid
  if (valuesGrid[0]?.[9] !== undefined && valuesGrid[0][9] !== "") {
    valuesGrid[0][9] = "";
    changes++;
  }
  if (formulasGrid[0]?.[9] !== undefined && formulasGrid[0][9] !== "") {
    formulasGrid[0][9] = "";
    changes++;
  }
  for (let r = 3; r <= 52; r++) {
    if (valuesGrid[r]?.[9] !== undefined && valuesGrid[r][9] !== "") {
      valuesGrid[r][9] = "";
      changes++;
    }
    if (formulasGrid[r]?.[9] !== undefined && formulasGrid[r][9] !== "") {
      formulasGrid[r][9] = "";
      changes++;
    }
  }

  // Update A154 and A304, and clear stale spilled Col J values in 154..203 & 304..353
  for (const rIdx of [153, 303]) {
    if (formulasGrid[rIdx] && normFormula(formulasGrid[rIdx][0]) === "={A4:J53}") {
      formulasGrid[rIdx][0] = "={A4:I53}";
      changes++;
    }
  }
  for (const [startR, endR] of [[153, 202], [303, 352]]) {
    for (let r = startR; r <= endR; r++) {
      if (valuesGrid[r]?.[9] !== undefined && valuesGrid[r][9] !== "") {
        valuesGrid[r][9] = "";
        changes++;
      }
      if (formulasGrid[r]?.[9] !== undefined && formulasGrid[r][9] !== "") {
        formulasGrid[r][9] = "";
        changes++;
      }
    }
  }

  // Move any summary/totals labels in Col J (idx 9) -> Col I (idx 8)
  for (const [startR, endR] of [[54, 76], [204, 207], [354, 357]]) {
    let jHas = false;
    let iHas = false;
    for (let r = startR; r <= endR; r++) {
      if (String(valuesGrid[r]?.[9] ?? "").trim() !== "") jHas = true;
      if (String(valuesGrid[r]?.[8] ?? "").trim() !== "") iHas = true;
    }
    if (jHas && !iHas) {
      for (let r = startR; r <= endR; r++) {
        if (!valuesGrid[r]) valuesGrid[r] = [];
        if (!formulasGrid[r]) formulasGrid[r] = [];
        if (String(valuesGrid[r][9] ?? "").trim() !== "") {
          valuesGrid[r][8] = valuesGrid[r][9];
          valuesGrid[r][9] = "";
          formulasGrid[r][8] = formulasGrid[r][9] || valuesGrid[r][8];
          formulasGrid[r][9] = "";
          changes++;
        }
      }
    }
  }
  if (formulasGrid[359] && normFormula(formulasGrid[359][9]) === "={J73:JC75}") {
    formulasGrid[359][8] = "={I73:JC75}";
    formulasGrid[359][9] = "";
    if (valuesGrid[359]) valuesGrid[359][9] = "";
    changes++;
  }

  // Update Totals rows 55, 57, 205, 207, 355, 357
  for (const { rowNum, buildFormula } of TARGET_TOTAL_ROWS) {
    const rIdx = rowNum - 1;
    if (!formulasGrid[rIdx]) formulasGrid[rIdx] = [];
    for (let c = 11; c <= 262; c++) {
      const target = buildFormula(colIdxToA1(c));
      if (normFormula(formulasGrid[rIdx][c]) !== normFormula(target)) {
        formulasGrid[rIdx][c] = target;
        changes++;
      }
    }
  }

  console.log(`  [${clientName} Supabase] Planned grid cell updates: ${changes}`);
  if (!apply || changes === 0) return { applied: false, changes };

  const { error: upErr } = await sb
    .from("master_sheet_grids")
    .update({ values_grid: valuesGrid, formulas_grid: formulasGrid, updated_at: new Date().toISOString() })
    .eq("id", gridRow.id);
  if (upErr) throw new Error(`Failed updating master_sheet_grids for ${clientName}: ${upErr.message}`);

  const { data: allClientGrids } = await sb
    .from("master_sheet_grids")
    .select("tab_name, values_grid, formulas_grid, notes_grid")
    .eq("client_name", clientName)
    .eq("sheet_role", "client");
  if (Array.isArray(allClientGrids) && allClientGrids.length > 0) {
    const grids = {};
    for (const row of allClientGrids) {
      grids[row.tab_name] = {
        values: row.values_grid || [],
        formulas: row.formulas_grid || [],
        notes: row.notes_grid || {},
      };
    }
    recalculateClientGrids(grids, { changedTabs: ["Salaries"] });
    await sb
      .from("master_sheet_grids")
      .update({ values_grid: grids.Salaries.values, updated_at: new Date().toISOString() })
      .eq("id", gridRow.id);
  }
  invalidateMasterEngineCache(clientName);
  return { applied: true, changes };
}

async function migrateSupabaseReconGrid(sb, clientName, apply) {
  const { data: reconRow, error } = await sb
    .from("master_sheet_grids")
    .select("id, values_grid")
    .eq("client_name", clientName)
    .eq("sheet_role", "recon")
    .eq("tab_name", "Salaries")
    .maybeSingle();

  if (error || !reconRow) return { skipped: true };

  const valuesGrid = Array.isArray(reconRow.values_grid) ? reconRow.values_grid.map((r) => [...(r || [])]) : [];
  let changes = 0;

  if (valuesGrid[0]?.[9] !== undefined && valuesGrid[0][9] !== "") {
    valuesGrid[0][9] = "";
    changes++;
  }
  for (let r = 3; r < valuesGrid.length; r++) {
    if (!valuesGrid[r]) continue;
    const jVal = String(valuesGrid[r][9] ?? "").trim();
    const iVal = String(valuesGrid[r][8] ?? "").trim();
    if (r >= 53 && jVal !== "" && iVal === "") {
      valuesGrid[r][8] = valuesGrid[r][9];
      valuesGrid[r][9] = "";
      changes++;
    } else if (jVal !== "") {
      valuesGrid[r][9] = "";
      changes++;
    }
  }

  if (changes > 0) {
    console.log(`  [${clientName} Supabase Recon] Planned cell updates: ${changes}`);
  }
  if (!apply || changes === 0) return { applied: false, changes };

  const { error: upErr } = await sb
    .from("master_sheet_grids")
    .update({ values_grid: valuesGrid, updated_at: new Date().toISOString() })
    .eq("id", reconRow.id);
  if (upErr) throw new Error(`Failed updating recon master_sheet_grids for ${clientName}: ${upErr.message}`);
  return { applied: true, changes };
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
    console.log("\n=== Target: Client Sheet Template ===");
    await migrateGoogleSheet(sheets, TEMPLATE_CLIENT_SHEET_ID, "Template", args.apply);
  }

  if (args.client || args.all) {
    const { clientsArray } = await getAllClients(sheets, { isAdmin: true }, true);
    const allClients = clientsArray || [];
    const targets = args.client
      ? allClients.filter((c) => String(c.clientName || "").toLowerCase() === args.client.toLowerCase())
      : allClients;

    if (targets.length === 0) {
      console.error(`No matching clients found for filter: "${args.client || "all"}"`);
      process.exit(1);
    }

    for (const c of targets) {
      console.log(`\n=== Target: ${c.clientName} (status=${c.status || "live"}, client_mode=${c.clientMode || "sheet"}) ===`);
      try {
        if (c.clientSheetId && !String(c.clientSheetId).startsWith("sb-")) {
          await migrateGoogleSheet(sheets, c.clientSheetId, c.clientName, args.apply);
        } else {
          console.log(`  [${c.clientName}] Synthetic/no Google clientSheetId (${c.clientSheetId || "none"}), skipping Google Sheet.`);
        }
        if (sb && !c.gridStorageRetired) {
          await migrateSupabaseGrid(sb, c.clientName, args.apply);
          await migrateSupabaseReconGrid(sb, c.clientName, args.apply);
        } else if (c.gridStorageRetired) {
          console.log(`  [${c.clientName} Supabase] grid_storage_retired=true — skipping retired master_sheet_grids cleanup.`);
        }
        if (args.apply && (c.clientSheetId || c.masterSheetId)) {
          await invalidateSalariesCache(c.masterSheetId, c.clientSheetId);
        }
      } catch (err) {
        console.error(`  [${c.clientName} ERROR]: ${err.message}`);
      }
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
