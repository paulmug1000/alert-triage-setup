/**
 * Multi-tenant rollout migration script for fixing Outgoings Row 111 (Making up CoS)
 * so that Revenue + Contractors mode direct costs (Outgoings Row 9, `G9`/`V9`/`AK9`)
 * are subtracted in Making up CoS formulas across:
 *   1. Client Template Google Sheet (`1KE0CRs8a92WMzyxy6rMZtr6d9D7cGMpUB3YLV89xjno`)
 *   2. Every client's physical Google Client Sheet (`Outgoings!G111:R111`, `V111:AG111`, `AK111:AV111`)
 *   3. Supabase `pulse_client_tab_blueprints` (`Outgoings`), `pulse_outgoing_items` (row 111),
 *      and `master_sheet_grids` (if not retired), followed by native recalculation & cache invalidation.
 *
 * Usage (from pulse-management-system/):
 *   node --env-file=.env.local scripts/migrate-making-up-cos-g9.mjs --dry-run --templates --all
 *   node --env-file=.env.local scripts/migrate-making-up-cos-g9.mjs --apply --client="APPTEST"
 *   node --env-file=.env.local scripts/migrate-making-up-cos-g9.mjs --apply --templates --all --include-archived
 */

import { google } from "googleapis";
import { getSupabaseAdmin, isSupabaseConfigured } from "../services/supabaseClient.js";
import {
  invalidateMasterEngineCache,
  recomputeClientFormulasForBridge,
  resolveSupabaseSheetContext,
} from "../services/masterEngineService.js";
import {
  invalidateClientNativeCalcCache,
  saveNativeClientTabBlueprint,
  loadNativeClientTabRecordsBatch,
} from "../services/nativeClientCalcService.js";
import { invalidateClientRelationalFinancialsCache } from "../services/relationalFinancialsService.js";
import { invalidatePmaClientCache } from "../services/cacheService.js";

const CLIENT_TEMPLATE_SHEET_ID = "1KE0CRs8a92WMzyxy6rMZtr6d9D7cGMpUB3YLV89xjno";

// Chronological 36 monthly columns (0-indexed) on Outgoings Row 111 (0-indexed 110):
//   FY1: G..R (6..17) | FY2: V..AG (21..32) | FY3: AK..AV (36..47)
const OUTGOINGS_SEGMENTS = [
  { label: "FY1 (G111:R111)", startCol0: 6, endCol0: 17 },
  { label: "FY2 (V111:AG111)", startCol0: 21, endCol0: 32 },
  { label: "FY3 (AK111:AV111)", startCol0: 36, endCol0: 47 },
];

const MONTHLY_COL_INDICES = [];
for (const seg of OUTGOINGS_SEGMENTS) {
  for (let c = seg.startCol0; c <= seg.endCol0; c++) MONTHLY_COL_INDICES.push(c);
}

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
      "  node --env-file=.env.local scripts/migrate-making-up-cos-g9.mjs --dry-run --templates --all\n" +
      '  node --env-file=.env.local scripts/migrate-making-up-cos-g9.mjs --apply --client="APPTEST"\n' +
      "  node --env-file=.env.local scripts/migrate-making-up-cos-g9.mjs --apply --templates --all --include-archived\n"
  );
}

/**
 * Validates and transforms an Outgoings Row 111 cell formula so it subtracts `-${col}$9`
 * (Direct costs as delivery contractor costs) immediately after `-${col}$6`.
 * Idempotent: returns `{ changed: false, formula }` if `-${col}9` or `-${col}$9` is already present.
 */
function transformRow111Formula(existingFormula, col) {
  const raw = String(existingFormula ?? "").trim();
  if (!raw || !raw.startsWith("=")) {
    throw new Error(`Cell ${col}111 is empty or not a formula: ${JSON.stringify(raw)}`);
  }

  const hasAlreadyRegex = new RegExp(`-\\s*\\$?${col}\\$?9(?![0-9])`, "i");
  if (hasAlreadyRegex.test(raw)) {
    return { changed: false, formula: raw };
  }

  // Verify expected Making up CoS pattern
  if (!/\$A\$112/i.test(raw) || !new RegExp(`-${col}\\$?6\\s*-\\s*${col}\\$?235`, "i").test(raw)) {
    throw new Error(`Unexpected Making up CoS formula pattern at ${col}111: ${raw.replace(/\s+/g, " ")}`);
  }

  const targetRegex = new RegExp(`(-${col}\\$?6)(\\s*-\\s*${col}\\$?235)`, "gi");
  let matchCount = 0;
  const updated = raw.replace(targetRegex, (_, p1, p2) => {
    matchCount++;
    return `${p1}-${col}$9${p2}`;
  });

  if (matchCount < 2) {
    throw new Error(`Expected 2 occurrences of -${col}$6-${col}$235 in ${col}111, found ${matchCount}`);
  }

  return { changed: true, formula: updated };
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

async function migrateGoogleSheetRow111(sheets, spreadsheetId, label, apply) {
  const formulaRanges = OUTGOINGS_SEGMENTS.map(
    (seg) => `Outgoings!${colIdxToA1(seg.startCol0)}111:${colIdxToA1(seg.endCol0)}111`
  );

  const [fmsRes, preValRes] = await Promise.all([
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: formulaRanges,
      valueRenderOption: "FORMULA",
    }),
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ["Outgoings!G111:AV111", "Dashboard!G16:AV16"],
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const fmsVr = fmsRes.data.valueRanges || [];
  const updates = [];
  let changedCells = 0;

  for (let sIdx = 0; sIdx < OUTGOINGS_SEGMENTS.length; sIdx++) {
    const seg = OUTGOINGS_SEGMENTS[sIdx];
    const existingRow = fmsVr[sIdx]?.values?.[0] || [];
    const newRow = [];
    let segDirty = false;
    for (let c = seg.startCol0; c <= seg.endCol0; c++) {
      const offset = c - seg.startCol0;
      const col = colIdxToA1(c);
      const { changed, formula } = transformRow111Formula(existingRow[offset], col);
      if (changed) {
        segDirty = true;
        changedCells++;
      }
      newRow.push(formula);
    }
    if (segDirty) {
      updates.push({ range: formulaRanges[sIdx], values: [newRow] });
    }
  }

  console.log(`  [${label} Google Sheet] Row 111 cells needing update=${changedCells} across ${updates.length} range block(s)`);
  if (!apply || updates.length === 0) {
    return { applied: false, changedCells };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data: updates },
  });

  const [postValRes, postFmtRes] = await Promise.all([
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ["Outgoings!G111:AV111", "Dashboard!G16:AV16"],
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ["Outgoings!G111:AX123", "Dashboard!G1:AX34", "Performance!G1:AX34"],
      valueRenderOption: "FORMATTED_VALUE",
    }),
  ]);

  const errs = [];
  for (const r of postFmtRes.data.valueRanges || []) {
    errs.push(...extractSheetGridErrors(r.values || []));
  }
  if (errs.length > 0) {
    throw new Error(`Formula errors detected on ${label} after Row 111 update: ${errs.slice(0, 10).join(", ")}`);
  }

  const pre111 = preValRes.data.valueRanges?.[0]?.values?.[0] || [];
  const post111 = postValRes.data.valueRanges?.[0]?.values?.[0] || [];
  let maxDelta = 0;
  let valueDiffCount = 0;
  for (let i = 0; i < Math.max(pre111.length, post111.length); i++) {
    const a = typeof pre111[i] === "number" ? pre111[i] : 0;
    const b = typeof post111[i] === "number" ? post111[i] : 0;
    const d = Math.abs(b - a);
    if (d > 1e-4) {
      valueDiffCount++;
      if (d > maxDelta) maxDelta = d;
    }
  }
  console.log(`  [${label} Google Sheet Verify] 0 formula errors; Row 111 values changed in ${valueDiffCount} col(s) (maxDelta=${maxDelta.toFixed(2)})`);
  return { applied: true, changedCells, valueDiffCount, maxDelta };
}

async function migrateSupabaseRow111(sb, clientName, gridStorageRetired, apply) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) {
    console.log(`  [${clientName} Supabase] Client context not found, skipping.`);
    return { skipped: true };
  }

  // 1. Inspect Outgoings blueprint + pulse_outgoing_items row 111
  const [{ data: bpRow, error: bpErr }, { data: itemRow, error: itemErr }] = await Promise.all([
    sb
      .from("pulse_client_tab_blueprints")
      .select("id, client_id, tab_name")
      .eq("client_id", ctx.clientId)
      .eq("tab_name", "Outgoings")
      .maybeSingle(),
    sb
      .from("pulse_outgoing_items")
      .select("id, sheet_row_num, section, custom_formulas")
      .eq("client_id", ctx.clientId)
      .eq("sheet_row_num", 111)
      .maybeSingle(),
  ]);
  if (bpErr) throw new Error(`Blueprint lookup error (${clientName}): ${bpErr.message}`);
  if (itemErr) throw new Error(`pulse_outgoing_items lookup error (${clientName}): ${itemErr.message}`);

  let bpChangedCount = 0;
  let loadedOut = null;
  if (bpRow) {
    const loadedMap = await loadNativeClientTabRecordsBatch(ctx, ["Outgoings"], {
      source: "db",
      valuesOnly: false,
      includeNotes: true,
    });
    loadedOut = loadedMap?.Outgoings || null;
    const fGrid = loadedOut?.formulas_grid || [];
    if (Array.isArray(fGrid[110])) {
      for (const c of MONTHLY_COL_INDICES) {
        const col = colIdxToA1(c);
        const { changed, formula } = transformRow111Formula(fGrid[110][c], col);
        if (changed) {
          fGrid[110][c] = formula;
          bpChangedCount++;
        }
      }
    }
  }

  let itemChangedCount = 0;
  let updatedCustomFormulas = null;
  if (itemRow) {
    const cf = { ...(itemRow.custom_formulas && typeof itemRow.custom_formulas === "object" ? itemRow.custom_formulas : {}) };
    for (const c of MONTHLY_COL_INDICES) {
      const k = String(c);
      const col = colIdxToA1(c);
      if (cf[k]) {
        const { changed, formula } = transformRow111Formula(cf[k], col);
        if (changed) {
          cf[k] = formula;
          itemChangedCount++;
        }
      }
    }
    if (itemChangedCount > 0) updatedCustomFormulas = cf;
  }

  let legacyGridChangedCount = 0;
  let legacyGridRows = [];
  if (!gridStorageRetired) {
    const { data: gRows } = await sb
      .from("master_sheet_grids")
      .select("id, sheet_role, tab_name, formulas_grid")
      .eq("client_name", ctx.clientName)
      .in("tab_name", ["Outgoings", "Client::Outgoings"]);
    for (const gr of gRows || []) {
      const fg = Array.isArray(gr.formulas_grid) ? gr.formulas_grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [];
      if (Array.isArray(fg[110])) {
        let dirty = false;
        for (const c of MONTHLY_COL_INDICES) {
          const col = colIdxToA1(c);
          const { changed, formula } = transformRow111Formula(fg[110][c], col);
          if (changed) {
            fg[110][c] = formula;
            legacyGridChangedCount++;
            dirty = true;
          }
        }
        if (dirty) legacyGridRows.push({ id: gr.id, formulas_grid: fg });
      }
    }
  }

  console.log(
    `  [${clientName} Supabase] blueprintCells=${bpChangedCount}, outgoingItemCells=${itemChangedCount}, legacyGridCells=${legacyGridChangedCount}`
  );

  const totalSupaChanges = bpChangedCount + itemChangedCount + legacyGridChangedCount;
  if (!apply || totalSupaChanges === 0) {
    return { applied: false, bpChangedCount, itemChangedCount, legacyGridChangedCount };
  }

  const nowIso = new Date().toISOString();

  if (bpChangedCount > 0 && loadedOut) {
    await saveNativeClientTabBlueprint(
      ctx,
      "Outgoings",
      loadedOut.values_grid,
      loadedOut.formulas_grid,
      loadedOut.notes_grid
    );
  }

  if (itemChangedCount > 0 && itemRow && updatedCustomFormulas) {
    const { error: uErr } = await sb
      .from("pulse_outgoing_items")
      .update({ custom_formulas: updatedCustomFormulas, updated_at: nowIso })
      .eq("id", itemRow.id);
    if (uErr) throw new Error(`Failed updating pulse_outgoing_items row 111 for ${clientName}: ${uErr.message}`);
  }

  for (const lg of legacyGridRows) {
    const { error: lErr } = await sb
      .from("master_sheet_grids")
      .update({ formulas_grid: lg.formulas_grid, updated_at: nowIso })
      .eq("id", lg.id);
    if (lErr) throw new Error(`Failed updating master_sheet_grids for ${clientName}: ${lErr.message}`);
  }

  invalidateClientNativeCalcCache(ctx.clientName);
  invalidateClientRelationalFinancialsCache(ctx.clientName);
  invalidateMasterEngineCache(ctx.clientName);

  await recomputeClientFormulasForBridge(ctx.clientName, ["Outgoings"]);
  console.log(`  [${clientName} Supabase] Recalculated & persisted Outgoings + dependent financial tabs.`);

  return { applied: true, bpChangedCount, itemChangedCount, legacyGridChangedCount };
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
    console.log("\n=== Target: Client Template ===");
    await migrateGoogleSheetRow111(sheets, CLIENT_TEMPLATE_SHEET_ID, "Client Template", args.apply);
  }

  if (args.client || args.all) {
    if (!sb) throw new Error("Supabase is required to enumerate clients.");
    const { data: rows, error } = await sb
      .from("clients")
      .select("client_name, master_sheet_id, client_sheet_id, status, grid_storage_retired")
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
        if (c.client_sheet_id && !String(c.client_sheet_id).startsWith("sb-")) {
          await migrateGoogleSheetRow111(sheets, c.client_sheet_id, name, args.apply);
        } else {
          console.log(`  [${name}] No physical Google client_sheet_id (${c.client_sheet_id || "none"}), skipping Google Sheet.`);
        }

        await migrateSupabaseRow111(sb, name, Boolean(c.grid_storage_retired), args.apply);

        if (args.apply) {
          invalidateMasterEngineCache(name);
          await invalidatePmaClientCache(c.client_sheet_id, c.master_sheet_id, ["all"]).catch(() => {});
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
