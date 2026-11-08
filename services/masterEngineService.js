import fs from "fs";
import path from "path";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import { extractSheetIdFromUrl } from "./sheetsClient.js";

const STAGE2_TABLES = [
  { name: "tenant_key_info", label: "Tenant KeyInfo & settings" },
  { name: "master_sheet_grids", label: "Virtual Master & Recon grids" },
  { name: "accounting_invoices", label: "Accounting invoices (InvFromApp)" },
  { name: "accounting_direct_costs", label: "Direct costs & bills (JnlsFromApp)" },
  { name: "accounting_pl_lines", label: "P&L monthly lines (PLFromApp)" },
  { name: "crm_deals_raw", label: "CRM deals (DataFromCRM)" },
  { name: "time_entries_raw", label: "Time entries (TimeComp)" },
  { name: "bank_recon_periods", label: "Bank recon periods (YYMM)" },
  { name: "bank_recon_items", label: "Bank recon transactions & items" },
  { name: "bank_recon_learning_map", label: "Bank recon category learning map" },
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
  "OutgNotes",
  "AutoLog",
  "MgmtRep",
  "Year0Data",
  "RevComp",
  "RevFromApp",
  "Outgoings",
  "Welcome",
];

let _sheetContextCache = {
  bySheetId: new Map(),
  byClientName: new Map(),
  expiresAt: 0,
};

const _gridMemoryCache = new Map();
const GRID_CACHE_TTL_MS = 4000;

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
    tabName = raw.replace(/^'+|'+$/g, "");
    coordPart = "A1:ZZ2000";
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

function applyWriteToGrid2D_(grid, parsed, incomingValues) {
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
      nextGrid[targetR][targetC] = val === null || val === undefined ? "" : val;
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
          expiresAt: now + 5000,
        };
      }
    } catch (err) {
      console.warn("[masterEngineService] Context lookup warning:", err.message);
      return null;
    }
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

async function getOrLoadVirtualTabGrid_(ctx, sheetRole, tabName, rawSheetsApi = null) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { values_grid: [], formulas_grid: [], notes_grid: {} };

  const cacheKey = `${ctx.clientName.toLowerCase()}::${sheetRole}::${tabName}`;
  const cached = _gridMemoryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.record;
  }

  const { data, error } = await supabase
    .from("master_sheet_grids")
    .select("*")
    .eq("client_name", ctx.clientName)
    .eq("sheet_role", sheetRole)
    .eq("tab_name", tabName)
    .maybeSingle();

  if (!error && data) {
    _gridMemoryCache.set(cacheKey, { record: data, expiresAt: Date.now() + GRID_CACHE_TTL_MS });
    return data;
  }

  // Lazy-seed from underlying Google Sheet if not yet in master_sheet_grids
  const sourceSheetId = sheetRole === "recon" ? ctx.reconSheetId : ctx.masterSheetId;
  if (rawSheetsApi && sourceSheetId) {
    try {
      const [valResp, formResp] = await Promise.all([
        rawSheetsApi.spreadsheets.values.get({
          spreadsheetId: sourceSheetId,
          range: `'${tabName}'!A1:ZZ1200`,
          valueRenderOption: "FORMATTED_VALUE",
        }),
        rawSheetsApi.spreadsheets.values
          .get({
            spreadsheetId: sourceSheetId,
            range: `'${tabName}'!A1:ZZ1200`,
            valueRenderOption: "FORMULA",
          })
          .catch(() => ({ data: { values: [] } })),
      ]);
      const valuesGrid = valResp?.data?.values || [];
      const formulasGrid = formResp?.data?.values || valuesGrid;
      const maxCols = valuesGrid.reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0);

      const newRecord = {
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
      await supabase.from("master_sheet_grids").upsert(newRecord, {
        onConflict: "client_name,sheet_role,tab_name",
      });
      _gridMemoryCache.set(cacheKey, { record: newRecord, expiresAt: Date.now() + GRID_CACHE_TTL_MS });
      return newRecord;
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

async function saveVirtualTabGrid_(ctx, sheetRole, tabName, valuesGrid, formulasGrid = null, notesGrid = null) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const cacheKey = `${ctx.clientName.toLowerCase()}::${sheetRole}::${tabName}`;
  const existing = _gridMemoryCache.get(cacheKey)?.record || {};
  const finalFormulas = formulasGrid || existing.formulas_grid || valuesGrid;
  const finalNotes = notesGrid || existing.notes_grid || {};
  const maxCols = (valuesGrid || []).reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0);

  const payload = {
    client_id: ctx.clientId,
    client_name: ctx.clientName,
    sheet_role: sheetRole,
    tab_name: tabName,
    values_grid: valuesGrid,
    formulas_grid: finalFormulas,
    notes_grid: finalNotes,
    row_count: (valuesGrid || []).length,
    col_count: maxCols,
    updated_at: new Date().toISOString(),
  };

  _gridMemoryCache.set(cacheKey, { record: payload, expiresAt: Date.now() + GRID_CACHE_TTL_MS });

  await supabase.from("master_sheet_grids").upsert(payload, {
    onConflict: "client_name,sheet_role,tab_name",
  });

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
 * Mirrors Master KeyInfo or Budget cell writes directly onto the Client Sheet
 * when a client is in master_mode = 'supabase' and client_mode = 'sheet'.
 */
async function mirrorMasterWriteToClientSheetIfNeeded_(ctx, rawSheetsApi, rangeUpdates) {
  if (!rawSheetsApi || !ctx?.clientSheetId || ctx.clientMode !== "sheet") return;
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
        });
      }
    } else if (parsed.tabName === "Budget") {
      clientDataUpdates.push({
        range: item.range,
        values: item.values,
      });
    }
  }

  if (clientDataUpdates.length > 0) {
    try {
      await rawSheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId: ctx.clientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: clientDataUpdates,
        },
      });
    } catch (err) {
      console.warn(`[masterEngineService] Direct Client Sheet mirror warning (${ctx.clientName}):`, err.message);
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

/**
 * Intercepts Google Sheets v4 API calls from sheetsClient.js when a client's
 * master_mode === 'supabase' and the target spreadsheetId is their Master or Recon sheet.
 */
export async function handleVirtualSheetsCall({
  namespace,
  method,
  params,
  ctx,
  rawSheetsApi,
}) {
  const supabase = getSupabaseAdmin();
  const sheetRole = ctx.sheetRole; // 'master' | 'recon'
  const spreadsheetId = params?.spreadsheetId || "";

  // 1. values.get
  if (namespace === "values" && method === "get") {
    const rangeStr = params.range || "KeyInfo!A1:Z100";
    const parsed = parseA1Range(rangeStr);
    const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, parsed.tabName, rawSheetsApi);
    const sourceGrid =
      params.valueRenderOption === "FORMULA" && Array.isArray(rec.formulas_grid) && rec.formulas_grid.length > 0
        ? rec.formulas_grid
        : rec.values_grid || [];
    const values = sliceGrid2D_(sourceGrid, parsed);
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
    const uniqueTabs = [...new Set(parsedList.map((p) => p.parsed.tabName))];

    const { data: rows } = await supabase
      .from("master_sheet_grids")
      .select("*")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", sheetRole)
      .in("tab_name", uniqueTabs);

    const byTab = new Map();
    for (const r of rows || []) {
      byTab.set(r.tab_name, r);
      _gridMemoryCache.set(`${ctx.clientName.toLowerCase()}::${sheetRole}::${r.tab_name}`, {
        record: r,
        expiresAt: Date.now() + GRID_CACHE_TTL_MS,
      });
    }

    const valueRanges = [];
    for (const item of parsedList) {
      let rec = byTab.get(item.parsed.tabName);
      if (!rec) {
        rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, item.parsed.tabName, rawSheetsApi);
        byTab.set(item.parsed.tabName, rec);
      }
      const sourceGrid =
        params.valueRenderOption === "FORMULA" && Array.isArray(rec.formulas_grid) && rec.formulas_grid.length > 0
          ? rec.formulas_grid
          : rec.values_grid || [];
      valueRanges.push({
        range: item.raw,
        majorDimension: "ROWS",
        values: sliceGrid2D_(sourceGrid, item.parsed),
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
    const parsed = parseA1Range(rangeStr);
    const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, parsed.tabName, rawSheetsApi);
    const updatedValues = applyWriteToGrid2D_(rec.values_grid || [], parsed, incomingValues);
    const updatedFormulas = applyWriteToGrid2D_(rec.formulas_grid || rec.values_grid || [], parsed, incomingValues);
    await saveVirtualTabGrid_(ctx, sheetRole, parsed.tabName, updatedValues, updatedFormulas, rec.notes_grid);

    if (sheetRole === "master") {
      await mirrorMasterWriteToClientSheetIfNeeded_(ctx, rawSheetsApi, [{ range: rangeStr, values: incomingValues }]);
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
    const byTabUpdates = new Map();
    for (const d of dataItems) {
      if (!d || !d.range) continue;
      const parsed = parseA1Range(d.range);
      if (!byTabUpdates.has(parsed.tabName)) byTabUpdates.set(parsed.tabName, []);
      byTabUpdates.get(parsed.tabName).push({ parsed, values: d.values || [], rawRange: d.range });
    }

    for (const [tabName, updates] of byTabUpdates.entries()) {
      const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, tabName, rawSheetsApi);
      let nextVals = rec.values_grid || [];
      let nextForms = rec.formulas_grid || rec.values_grid || [];
      for (const u of updates) {
        nextVals = applyWriteToGrid2D_(nextVals, u.parsed, u.values);
        nextForms = applyWriteToGrid2D_(nextForms, u.parsed, u.values);
      }
      await saveVirtualTabGrid_(ctx, sheetRole, tabName, nextVals, nextForms, rec.notes_grid);
    }

    if (sheetRole === "master") {
      await mirrorMasterWriteToClientSheetIfNeeded_(ctx, rawSheetsApi, dataItems);
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
    const parsed = parseA1Range(rangeStr);
    const rec = await getOrLoadVirtualTabGrid_(ctx, sheetRole, parsed.tabName, rawSheetsApi);
    const nextVals = Array.isArray(rec.values_grid) ? [...rec.values_grid, ...incomingValues] : [...incomingValues];
    const nextForms = Array.isArray(rec.formulas_grid) ? [...rec.formulas_grid, ...incomingValues] : [...incomingValues];
    await saveVirtualTabGrid_(ctx, sheetRole, parsed.tabName, nextVals, nextForms, rec.notes_grid);

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
      await saveVirtualTabGrid_(ctx, sheetRole, tabName, nextVals, nextForms, rec.notes_grid);
    }

    return {
      status: 200,
      data: { spreadsheetId, clearedRanges: ranges },
    };
  }

  // 7. spreadsheets.get
  if (namespace === "spreadsheets" && method === "get") {
    const { data: tabRows } = await supabase
      .from("master_sheet_grids")
      .select("tab_name, row_count, col_count, values_grid, formulas_grid, notes_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", sheetRole)
      .order("tab_name", { ascending: true });

    const allTabs = tabRows && tabRows.length > 0 ? tabRows : [];
    const requestedRanges = Array.isArray(params.ranges) ? params.ranges : params.ranges ? [params.ranges] : [];
    const includeGridData = Boolean(params.includeGridData || requestedRanges.length > 0);

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
            const rowData = slicedVals.map((rArr, rOffset) => {
              const absR = (mr.startRow0 ?? 0) + rOffset;
              const fArr = slicedForms[rOffset] || [];
              return {
                values: rArr.map((cellVal, cOffset) => {
                  const absC = (mr.startCol0 ?? 0) + cOffset;
                  const strVal = cellVal == null ? "" : String(cellVal);
                  const formVal = fArr[cOffset] == null ? strVal : String(fArr[cOffset]);
                  const numClean = parseFloat(strVal.replace(/[£$€,\s]/g, ""));
                  const isNumeric = strVal !== "" && !isNaN(numClean) && /^[-+]?[£$€]?\s*[\d,]+(\.\d+)?%?$/.test(strVal.trim());
                  const noteKey = `${absR}:${absC}`;
                  const noteStr = t.notes_grid?.[noteKey] || "";
                  return {
                    formattedValue: strVal,
                    effectiveValue: isNumeric ? { numberValue: numClean } : { stringValue: strVal },
                    userEnteredValue: formVal.startsWith("=")
                      ? { formulaValue: formVal }
                      : isNumeric
                      ? { numberValue: numClean }
                      : { stringValue: strVal },
                    note: noteStr,
                    effectiveFormat: {
                      backgroundColor: { red: 1, green: 1, blue: 1 },
                    },
                  };
                }),
              };
            });
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

    if (requestedRanges.length > 0) {
      const targetTabNames = new Set(requestedRanges.map((r) => parseA1Range(r).tabName));
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

  // 8. spreadsheets.batchUpdate (handles updateSheetProperties, updateCells, etc.)
  if (namespace === "spreadsheets" && method === "batchUpdate") {
    const requests = params.requestBody?.requests || params.resource?.requests || [];
    const { data: tabRows } = await supabase
      .from("master_sheet_grids")
      .select("*")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", sheetRole);

    const bySheetId = new Map();
    (tabRows || []).forEach((t, idx) => {
      bySheetId.set(hashTabNameToSheetId_(t.tab_name, idx), t);
    });

    for (const req of requests) {
      if (req.updateSheetProperties?.properties) {
        const props = req.updateSheetProperties.properties;
        const target = bySheetId.get(props.sheetId);
        if (target && props.title && props.title !== target.tab_name) {
          await supabase
            .from("master_sheet_grids")
            .update({ tab_name: props.title })
            .eq("id", target.id);
          target.tab_name = props.title;
        }
      } else if (req.updateCells?.range) {
        const rng = req.updateCells.range;
        const target = bySheetId.get(rng.sheetId);
        if (target && Array.isArray(req.updateCells.rows)) {
          const incoming = req.updateCells.rows.map((r) =>
            (r.values || []).map((v) => {
              const uev = v.userEnteredValue || {};
              return uev.stringValue ?? uev.numberValue ?? uev.boolValue ?? uev.formulaValue ?? "";
            })
          );
          const parsed = {
            tabName: target.tab_name,
            startRow0: rng.startRowIndex ?? 0,
            startCol0: rng.startColumnIndex ?? 0,
          };
          const nextVals = applyWriteToGrid2D_(target.values_grid || [], parsed, incoming);
          await saveVirtualTabGrid_(ctx, sheetRole, target.tab_name, nextVals, nextVals, target.notes_grid);
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
  for (let r = 1; r < Math.min(keyInfoGrid.length, 180); r++) {
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
    fy_start_date: cell(2, "B"),
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
    const txnDate = String(row[1] || row[0] || "").trim();
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
    const txnDate = String(row[colCD] || "").trim();
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
    const tabsToPull = CORE_MASTER_TABS.filter((t) => existingMasterTabs.has(t));

    for (let i = 0; i < tabsToPull.length; i += 6) {
      const chunk = tabsToPull.slice(i, i + 6);
      const ranges = chunk.map((t) => `'${t}'!A1:ZZ1200`);
      const [valBatch, formBatch] = await Promise.all([
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: ctx.masterSheetId,
          ranges,
          valueRenderOption: "FORMATTED_VALUE",
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

        if (tabName === "InvFromApp") {
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
      .filter((t) => /^\d{4}$/.test(t) || ["Template", "KeyInfo", "PLAdds", "Data"].includes(t));

    const learningPatterns = new Map();

    for (let i = 0; i < allReconTabs.length; i += 5) {
      const chunk = allReconTabs.slice(i, i + 5);
      const ranges = chunk.map((t) => `'${t}'!A1:DA220`);
      const [valBatch, formBatch] = await Promise.all([
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: ctx.reconSheetId,
          ranges,
          valueRenderOption: "FORMATTED_VALUE",
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

  // Known IMPORTRANGE locations on Client Sheets that pull from Master Sheet ($D$1 / $E$1)
  const targets = [
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
    },
    {
      id: "welcome_block",
      clientRange: "Welcome!B3:D26",
      masterRange: "Welcome!B3:D26",
      mode: "VALUES_ONLY",
    },
  ];

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

  // Preserve previous backup if already materialized so we never overwrite original IMPORTRANGE formulas with materialized values
  const { data: existingKi } = await supabase
    .from("tenant_key_info")
    .select("client_importrange_backup")
    .eq("client_id", ctx.clientId)
    .maybeSingle();

  const hasExistingImportrangeBackup =
    existingKi?.client_importrange_backup &&
    Object.values(existingKi.client_importrange_backup).some((b) =>
      /importrange/i.test(String(b?.originalFormula || ""))
    );

  const finalBackupToSave = hasExistingImportrangeBackup ? existingKi.client_importrange_backup : backupMap;

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
          // If formula contains IMPORTRANGE (e.g. KeyInfo $E$1 template lookups), fall back to evaluated value
          if (typeof fCell === "string" && /importrange/i.test(fCell)) {
            outRow.push(vCell);
          } else {
            outRow.push(fCell !== undefined ? fCell : vCell);
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
  invalidateMasterEngineCache();
  return data;
}

/**
 * Returns Stage 2 table counts, client master_mode status, and virtual tabs for PMA Settings & Workbook Inspector
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
          .select("*", { count: "exact", head: true })
          .eq("client_name", targetClientName);
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
  let availableTabs = { master: [], recon: [] };
  if (schemaReady) {
    const [{ data: ki }, { data: grids }] = await Promise.all([
      supabase
        .from("tenant_key_info")
        .select("client_name, accounting_tool, crm_tool, crm_drives, client_materialized_at, updated_at")
        .eq("client_name", targetClientName)
        .maybeSingle(),
      supabase
        .from("master_sheet_grids")
        .select("sheet_role, tab_name, row_count, col_count, updated_at")
        .eq("client_name", targetClientName)
        .order("tab_name", { ascending: true }),
    ]);
    keyInfoMeta = ki || null;
    for (const g of grids || []) {
      if (g.sheet_role === "recon") availableTabs.recon.push(g);
      else availableTabs.master.push(g);
    }
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

  return {
    configured: true,
    schemaReady,
    targetClientName,
    tables: tableResults,
    keyInfoMeta,
    availableTabs,
    clients: clientsData || [],
    migrationSql,
  };
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

  const { data, error } = await supabase
    .from("master_sheet_grids")
    .select("*")
    .eq("client_name", clientName)
    .eq("sheet_role", sheetRole)
    .eq("tab_name", tabName)
    .maybeSingle();

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

  const vGrid = (data.values_grid || []).slice(0, maxRows).map((r) => (Array.isArray(r) ? r.slice(0, maxCols) : []));
  const fGrid = (data.formulas_grid || []).slice(0, maxRows).map((r) => (Array.isArray(r) ? r.slice(0, maxCols) : []));

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
  const nextForms = applyWriteToGrid2D_(rec.formulas_grid || rec.values_grid || [], parsed, [[value]]);
  await saveVirtualTabGrid_(ctx, sheetRole, tabName, nextVals, nextForms, rec.notes_grid);

  if (sheetRole === "master" && sheets) {
    await mirrorMasterWriteToClientSheetIfNeeded_(ctx, sheets, [{ range: `${tabName}!${colLetter}${Number(rowIndex0) + 1}`, values: [[value]] }]);
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
