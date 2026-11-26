/**
 * ============================================================================
 * PULSE PHASE 4A+4B: RELATIONAL MASTER INGESTION & COMPARISON SERVICE
 * ============================================================================
 * Replaces virtual Master Sheet ingestion grids (`InvFromApp`, `RevFromApp`,
 * `JnlsFromApp`, `PLFromApp`, `Year0PLFromApp`, `DataFromCRM`, `DataFromTime`,
 * `ProjectsFromTime`) and comparison/config frames (`CRMList`, `CRMComp`,
 * `InvAppList`, `InvDashList`, `InvComp`, `JnlAppList`, `DirDashList`,
 * `DirComp`, `PLComp`, `TimeComp`) with normalized, UUID-keyed Postgres tables
 * + idempotent upserts + foreign-key linking + 100% verbatim formula parity.
 * ============================================================================
 */

import fs from "fs";
import path from "path";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import {
  resolveSupabaseSheetContext,
  getOrLoadVirtualTabGrid_,
  invalidateMasterEngineCache,
} from "./masterEngineService.js";
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
  compactGrid2D,
} from "./gasRuntime/masterFormulaEngine.js";

export const PHASE4_RAW_INGESTION_TABS = [
  "InvFromApp",
  "RevFromApp",
  "JnlsFromApp",
  "PLFromApp",
  "Year0PLFromApp",
  "DataFromCRM",
  "DataFromTime",
  "ProjectsFromTime",
];

export const PHASE4_CONFIG_AND_COMP_TABS = [
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
];

export const ALL_PHASE4_MASTER_TABS = [
  ...PHASE4_RAW_INGESTION_TABS,
  ...PHASE4_CONFIG_AND_COMP_TABS,
];

let _cachedMigration0014Sql = null;
let _schemaReadyCache = { ready: null, checkedAt: 0 };
const _masterBundleCache = new Map();
const MASTER_BUNDLE_TTL_MS = 15000;
const _pendingMasterReconcileByClient = new Map();
const _inFlightMasterReconcileByClient = new Map();

export function readMigration0014Sql() {
  if (_cachedMigration0014Sql !== null) return _cachedMigration0014Sql;
  try {
    const p = path.join(
      process.cwd(),
      "supabase",
      "migrations",
      "0014_phase4ab_master_ingestion.sql"
    );
    _cachedMigration0014Sql = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  } catch {
    _cachedMigration0014Sql = "";
  }
  return _cachedMigration0014Sql;
}

export function invalidateClientRelationalMasterCache(clientName) {
  const key = String(clientName || "").trim().toLowerCase();
  if (!key) {
    _masterBundleCache.clear();
    return;
  }
  _masterBundleCache.delete(key);
}

// ============================================================================
// 1. PRIMITIVE PARSING & SERIALIZATION HELPERS
// ============================================================================

function str_(v) {
  return String(v ?? "").trim();
}

function normKey_(v) {
  return str_(v).toLowerCase();
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

function findColByHeader_(headers, candidates, fallbackIdx = -1) {
  const list = Array.isArray(headers) ? headers : [];
  const candSet = candidates.map((c) => c.toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (let i = 0; i < list.length; i++) {
    const clean = String(list[i] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (clean && candSet.includes(clean)) return i;
  }
  return fallbackIdx;
}

function extractSparseCellsOutside_(grid, startRow0, isClearedCellFn) {
  const out = [];
  if (!Array.isArray(grid)) return out;
  for (let r = startRow0; r < grid.length; r++) {
    const row = grid[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      if (isClearedCellFn(r, c)) continue;
      const v = row[c];
      if (v !== "" && v !== null && v !== undefined) {
        out.push([r, c, v]);
      }
    }
  }
  return out;
}

function applySparseCells_(grid, sparseCells) {
  if (!Array.isArray(sparseCells)) return;
  for (const entry of sparseCells) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const [r, c, v] = entry;
    while (grid.length <= r) grid.push([]);
    while (grid[r].length <= c) grid[r].push("");
    grid[r][c] = v;
  }
}

function parseJsonArraySafe_(val) {
  if (Array.isArray(val)) return val;
  if (typeof val !== "string") return [];
  const s = val.trim();
  if (!s.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchAllRowsByClientId_(supabase, table, clientId, orderCol = "sheet_row_num") {
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
// 2. LOSSLESS PARSERS & PROJECTORS (PHASE 4A: ACCOUNTING)
// ============================================================================

export function parseInvFromAppGrid({ clientId, clientName, grid = [] }) {
  const headers = Array.isArray(grid[0]) ? trimTrailingEmptyCells_(grid[0]) : [];
  const cId = findColByHeader_(headers, ["invoiceid", "id"], 0);
  const cContact = findColByHeader_(headers, ["contactname", "client", "customer"], 1);
  const cInvNo = findColByHeader_(headers, ["invoicenumber", "invoiceno"], 2);
  const cRef = findColByHeader_(headers, ["reference", "ref"], 3);
  const cType = findColByHeader_(headers, ["type", "invoicetype"], 4);
  const cDate = findColByHeader_(headers, ["date", "issuedate"], 5);
  const cDue = findColByHeader_(headers, ["duedate"], 6);
  const cStatus = findColByHeader_(headers, ["status"], 7);
  const cAmtDue = findColByHeader_(headers, ["amountdue"], 8);
  const cAmtPaid = findColByHeader_(headers, ["amountpaid"], 9);
  const cTotal = findColByHeader_(headers, ["total", "gross"], 10);
  const cPaidDate = findColByHeader_(headers, ["fullypaidondate", "paiddate"], 11);
  const cSent = findColByHeader_(headers, ["senttocontact"], 12);
  const cSub = findColByHeader_(headers, ["subtotal", "net"], 13);
  const cTax = findColByHeader_(headers, ["totaltax", "taxtotal", "vat"], 14);
  const cCurr = findColByHeader_(headers, ["currencycode", "currency"], 15);
  const cRate = findColByHeader_(headers, ["currencyrate", "rate"], 16);
  const cRech = findColByHeader_(headers, ["rechargedamount"], 17);
  const cLines = findColByHeader_(headers, ["linebreakdown"], 18);

  const nowIso = new Date().toISOString();
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const raw = Array.isArray(grid[r]) ? trimTrailingEmptyCells_(grid[r]) : [];
    if (isRowEmpty_(raw)) continue;
    const extId = str_(raw[cId]);
    const invNo = str_(raw[cInvNo]);
    const desc = str_(raw[cRef]);
    rows.push({
      client_id: clientId,
      client_name: clientName,
      record_kind: "invoice",
      sheet_row_num: r + 1,
      external_id: extId || `row_${r + 1}`,
      invoice_number: invNo,
      contact_name: str_(raw[cContact]),
      description: desc,
      reference: desc,
      account_code: "",
      tax_type: "",
      tracking_category: "",
      issue_date: str_(raw[cDate]),
      due_date: str_(raw[cDue]),
      fully_paid_date: str_(raw[cPaidDate]),
      sent_to_contact: str_(raw[cSent]),
      status: str_(raw[cStatus]),
      invoice_type: str_(raw[cType]) || "ACCREC",
      sub_total: num_(raw[cSub]),
      tax_total: num_(raw[cTax]),
      total: num_(raw[cTotal]),
      amount_paid: num_(raw[cAmtPaid]),
      amount_due: num_(raw[cAmtDue]),
      currency_code: str_(raw[cCurr]) || "GBP",
      currency_rate: num_(raw[cRate], 1) || 1,
      recharged_amount: cRech >= 0 ? num_(raw[cRech]) : 0,
      draft_amount: 0,
      line_items: cLines >= 0 ? parseJsonArraySafe_(raw[cLines]) : [],
      raw_row: raw,
      synced_at: nowIso,
    });
  }
  return { headers, rowCount: grid.length, rows };
}

export function parseRevFromAppGrid({ clientId, clientName, grid = [] }) {
  const headers = Array.isArray(grid[0]) ? trimTrailingEmptyCells_(grid[0]) : [];
  const cId = findColByHeader_(headers, ["lineid", "id"], 0);
  const cClient = findColByHeader_(headers, ["clientname", "contactname"], 1);
  const cInvNo = findColByHeader_(headers, ["invoicenumber", "invoiceno"], 2);
  const cDesc = findColByHeader_(headers, ["description"], 3);
  const cEffRev = findColByHeader_(headers, ["effectiverevenue", "revenue"], 4);
  const cDate = findColByHeader_(headers, ["date"], 5);
  const cStatus = findColByHeader_(headers, ["status"], 6);
  const cDraft = findColByHeader_(headers, ["draftamount"], 7);

  const nowIso = new Date().toISOString();
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const raw = Array.isArray(grid[r]) ? trimTrailingEmptyCells_(grid[r]) : [];
    if (isRowEmpty_(raw)) continue;
    const eff = num_(raw[cEffRev]);
    rows.push({
      client_id: clientId,
      client_name: clientName,
      record_kind: "revenue_line",
      sheet_row_num: r + 1,
      external_id: str_(raw[cId]) || `rev_${r + 1}`,
      invoice_number: str_(raw[cInvNo]),
      contact_name: str_(raw[cClient]),
      description: str_(raw[cDesc]),
      reference: "",
      account_code: "",
      tax_type: "",
      tracking_category: "",
      issue_date: str_(raw[cDate]),
      due_date: "",
      fully_paid_date: "",
      sent_to_contact: "",
      status: str_(raw[cStatus]),
      invoice_type: "REV_LINE",
      sub_total: eff,
      tax_total: 0,
      total: eff,
      amount_paid: 0,
      amount_due: 0,
      currency_code: "GBP",
      currency_rate: 1,
      recharged_amount: 0,
      draft_amount: cDraft >= 0 ? num_(raw[cDraft]) : 0,
      line_items: [],
      raw_row: raw,
      synced_at: nowIso,
    });
  }
  return { headers, rowCount: grid.length, rows };
}

export function projectAccountingInvoicesToGrid({
  headers = [],
  records = [],
  recordKind = "invoice",
  minRows = 0,
}) {
  const filtered = (records || []).filter((r) => (r.record_kind || "invoice") === recordKind);
  let maxRow = Math.max(minRows, headers.length > 0 ? 1 : 0);
  for (const r of filtered) {
    if (Number(r.sheet_row_num) > maxRow) maxRow = Number(r.sheet_row_num);
  }
  if (maxRow === 0 && headers.length === 0) return [];
  const grid = Array.from({ length: maxRow }, () => []);
  if (headers.length > 0) grid[0] = [...headers];
  for (const rec of filtered) {
    const r0 = Number(rec.sheet_row_num) - 1;
    if (r0 >= 1) {
      grid[r0] = Array.isArray(rec.raw_row) ? [...rec.raw_row] : [];
    }
  }
  return compactGrid2D(grid);
}

export function parseJnlsFromAppGrid({
  clientId,
  clientName,
  grid = [],
  keyInfoGrid = null,
}) {
  const headers = Array.isArray(grid[0]) ? trimTrailingEmptyCells_(grid[0]) : [];
  const cDate = findColByHeader_(headers, ["date", "txndate"], 0);
  const cDesc = findColByHeader_(headers, ["description", "supplier", "suppliername"], 1);
  const cNet = findColByHeader_(headers, ["netexclvat", "netamount", "net"], 2);
  const cVat = findColByHeader_(headers, ["vat", "vatamount"], 3);
  const cGross = findColByHeader_(headers, ["grossinclvat", "grossamount", "gross"], 4);
  const cRef = findColByHeader_(headers, ["reference", "ref"], 5);
  const cAcc = findColByHeader_(headers, ["accountname"], 6);
  const cStatus = findColByHeader_(headers, ["status"], 7);
  const cTxnId = findColByHeader_(headers, ["transactionid", "externalid", "id"], 8);
  const cPaidDate = findColByHeader_(headers, ["datepaid", "paiddate"], 9);
  const cCurr = findColByHeader_(headers, ["currencycode", "currency"], 10);
  const cRate = findColByHeader_(headers, ["currencyrate", "rate"], 11);
  const cSrcType = findColByHeader_(headers, ["sourcetype"], -1);
  const cSrcId = findColByHeader_(headers, ["sourceid"], -1);
  const cAmtDue = findColByHeader_(headers, ["amountdue"], 12);
  const cAmtPaid = findColByHeader_(headers, ["amountpaid"], 13);
  const cDueDate = findColByHeader_(headers, ["duedate"], 14);

  const passthroughAccs = new Set();
  if (Array.isArray(keyInfoGrid)) {
    for (let r = 23; r <= 39 && r < keyInfoGrid.length; r++) {
      const a = normKey_(keyInfoGrid[r]?.[45]); // AT24:AT40
      if (a) passthroughAccs.add(a);
    }
  }

  const nowIso = new Date().toISOString();
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const raw = Array.isArray(grid[r]) ? trimTrailingEmptyCells_(grid[r]) : [];
    if (isRowEmpty_(raw)) continue;
    const accName = str_(raw[cAcc]);
    const desc = str_(raw[cDesc]);
    const costType = passthroughAccs.has(normKey_(accName)) ? "pass_through" : "contractor";
    rows.push({
      client_id: clientId,
      client_name: clientName,
      sheet_row_num: r + 1,
      external_id: str_(raw[cTxnId]) || `jnl_${r + 1}`,
      cost_type: costType,
      supplier_name: desc,
      description: desc,
      account_code: "",
      account_name: accName,
      txn_date: str_(raw[cDate]),
      due_date: cDueDate >= 0 ? str_(raw[cDueDate]) : "",
      paid_date: cPaidDate >= 0 ? str_(raw[cPaidDate]) : "",
      net_amount: num_(raw[cNet]),
      vat_amount: num_(raw[cVat]),
      gross_amount: num_(raw[cGross]),
      amount_due: cAmtDue >= 0 && cAmtDue !== cSrcType ? num_(raw[cAmtDue]) : 0,
      amount_paid: cAmtPaid >= 0 && cAmtPaid !== cSrcId ? num_(raw[cAmtPaid]) : 0,
      status: str_(raw[cStatus]),
      reference: str_(raw[cRef]),
      currency_code: cCurr >= 0 ? str_(raw[cCurr]) || "GBP" : "GBP",
      currency_rate: cRate >= 0 ? num_(raw[cRate], 1) || 1 : 1,
      source_type: cSrcType >= 0 ? str_(raw[cSrcType]) : "",
      source_id: cSrcId >= 0 ? str_(raw[cSrcId]) : "",
      raw_row: raw,
      synced_at: nowIso,
    });
  }
  return { headers, rowCount: grid.length, rows };
}

export function projectDirectCostsToGrid({ headers = [], records = [], minRows = 0 }) {
  let maxRow = Math.max(minRows, headers.length > 0 ? 1 : 0);
  for (const r of records || []) {
    if (Number(r.sheet_row_num) > maxRow) maxRow = Number(r.sheet_row_num);
  }
  if (maxRow === 0 && headers.length === 0) return [];
  const grid = Array.from({ length: maxRow }, () => []);
  if (headers.length > 0) grid[0] = [...headers];
  for (const rec of records || []) {
    const r0 = Number(rec.sheet_row_num) - 1;
    if (r0 >= 1) {
      grid[r0] = Array.isArray(rec.raw_row) ? [...rec.raw_row] : [];
    }
  }
  return compactGrid2D(grid);
}

export function parsePLTabGrid({
  clientId,
  clientName,
  sourceTab = "PLFromApp",
  grid = [],
}) {
  const headers = Array.isArray(grid[0]) ? trimTrailingEmptyCells_(grid[0]) : [];
  const monthHeaders = headers.slice(1).map((h) => String(h ?? ""));
  const nowIso = new Date().toISOString();
  const rows = [];
  let currentSection = "overheads";

  for (let r = 1; r < grid.length; r++) {
    const raw = Array.isArray(grid[r]) ? trimTrailingEmptyCells_(grid[r]) : [];
    if (isRowEmpty_(raw)) continue;

    const label = str_(raw[0]);
    const rest = raw.slice(1);
    const hasNumericRest = rest.some((v) => v !== "" && v !== null && v !== undefined);
    let rowKind = "account";
    if (!label && hasNumericRest) {
      rowKind = "account";
    } else if (!hasNumericRest && label) {
      rowKind = "section";
      currentSection = label;
    } else if (normKey_(label).startsWith("total ")) {
      rowKind = "total";
    }

    let netSum = 0;
    for (const v of rest) netSum += num_(v, 0);

    rows.push({
      client_id: clientId,
      client_name: clientName,
      source_tab: sourceTab,
      sheet_row_num: r + 1,
      month_date: monthHeaders[0] || "",
      section: currentSection,
      account_name: str_(raw[0]),
      row_kind: rowKind,
      basis: "accrual",
      net_amount: Math.round(netSum * 100) / 100,
      vat_amount: 0,
      monthly_amounts: rest,
      transactions_json: [],
      raw_row: raw,
      synced_at: nowIso,
    });
  }
  return { headers, rowCount: grid.length, rows };
}

export function projectPLLinesToGrid({
  headers = [],
  records = [],
  sourceTab = "PLFromApp",
  minRows = 0,
}) {
  const filtered = (records || []).filter((r) => (r.source_tab || "PLFromApp") === sourceTab);
  let maxRow = Math.max(minRows, headers.length > 0 ? 1 : 0);
  for (const r of filtered) {
    if (Number(r.sheet_row_num) > maxRow) maxRow = Number(r.sheet_row_num);
  }
  if (maxRow === 0 && headers.length === 0) return [];
  const grid = Array.from({ length: maxRow }, () => []);
  if (headers.length > 0) grid[0] = [...headers];
  for (const rec of filtered) {
    const r0 = Number(rec.sheet_row_num) - 1;
    if (r0 >= 1) {
      grid[r0] = Array.isArray(rec.raw_row) ? [...rec.raw_row] : [];
    }
  }
  return compactGrid2D(grid);
}

// ============================================================================
// 3. LOSSLESS PARSERS & PROJECTORS (PHASE 4B: CRM & TIME)
// ============================================================================

export function parseCrmDealsFromGrids({
  clientId,
  clientName,
  dataFromCrmGrid = [],
  crmListGrid = [],
}) {
  const rawHeaders = Array.isArray(dataFromCrmGrid[0])
    ? trimTrailingEmptyCells_(dataFromCrmGrid[0])
    : [];
  const nowIso = new Date().toISOString();
  const rows = [];

  for (let r = 1; r < dataFromCrmGrid.length; r++) {
    const raw = Array.isArray(dataFromCrmGrid[r]) ? trimTrailingEmptyCells_(dataFromCrmGrid[r]) : [];
    if (isRowEmpty_(raw)) continue;

    const rawObj = {};
    for (let c = 0; c < Math.max(rawHeaders.length, raw.length); c++) {
      const h = str_(rawHeaders[c]) || `Col_${c + 1}`;
      if (raw[c] !== undefined && raw[c] !== "") rawObj[h] = raw[c];
    }

    const listIdx = r + 2; // CRMList rows start at r0=3 (row 4) for DataFromCRM row r0=1 (row 2)
    const listRow = Array.isArray(crmListGrid[listIdx])
      ? crmListGrid[listIdx].slice(0, 15)
      : [];

    const companyName = str_(listRow[0] ?? raw[3] ?? raw[1]);
    const dealName = str_(listRow[1] ?? raw[1] ?? raw[2]);
    const projectCode = str_(listRow[2] ?? raw[0]);
    const revenue = num_(listRow[3] ?? raw[5]);
    const directCosts = num_(listRow[4]);
    const startDate = str_(listRow[5]);
    const endDate = str_(listRow[6]);
    const likelihood = str_(listRow[7]);
    const status = str_(listRow[8] ?? raw[4]);
    const dealType = str_(listRow[9]) || "Project";
    const leadSource = str_(listRow[10]);
    const dateAdded = str_(listRow[11]);
    const productLine = str_(listRow[12]);

    const extId =
      str_(raw[0]) || projectCode || `crm_row_${r + 1}`;

    rows.push({
      client_id: clientId,
      client_name: clientName,
      sheet_row_num: r + 1,
      external_id: extId,
      deal_name: dealName,
      company_name: companyName,
      project_code: projectCode,
      revenue,
      direct_costs: directCosts,
      start_date: startDate,
      end_date: endDate,
      date_confirmed: dateAdded,
      date_added: dateAdded,
      likelihood,
      status,
      deal_type: dealType,
      product_line: productLine,
      lead_source: leadSource,
      raw_payload: rawObj,
      raw_row: raw,
      crm_list_row: listRow,
      synced_at: nowIso,
    });
  }

  return { rawHeaders, rowCount: dataFromCrmGrid.length, rows };
}

export function projectCrmDealsToDataFromCrmGrid({ headers = [], records = [], minRows = 0 }) {
  let maxRow = Math.max(minRows, headers.length > 0 ? 1 : 0);
  for (const r of records || []) {
    if (Number(r.sheet_row_num) > maxRow) maxRow = Number(r.sheet_row_num);
  }
  if (maxRow === 0 && headers.length === 0) return [];
  const grid = Array.from({ length: maxRow }, () => []);
  if (headers.length > 0) grid[0] = [...headers];
  for (const rec of records || []) {
    const r0 = Number(rec.sheet_row_num) - 1;
    if (r0 >= 1) {
      grid[r0] = Array.isArray(rec.raw_row) ? [...rec.raw_row] : [];
    }
  }
  return compactGrid2D(grid);
}

export function parseTimeTablesFromGrids({
  clientId,
  clientName,
  dataFromTimeGrid = [],
  projectsFromTimeGrid = [],
  timeCompGrid = [],
}) {
  const dataHeaders = Array.isArray(dataFromTimeGrid[0])
    ? trimTrailingEmptyCells_(dataFromTimeGrid[0])
    : [];
  const projHeaders = Array.isArray(projectsFromTimeGrid[0])
    ? trimTrailingEmptyCells_(projectsFromTimeGrid[0])
    : [];
  const nowIso = new Date().toISOString();
  const rows = [];

  // 1. DataFromTime -> entry_kind = 'staff_month'
  const cMonthD = findColByHeader_(dataHeaders, ["month", "monthdate"], 0);
  const cEmpD = findColByHeader_(dataHeaders, ["employeename", "staffname", "name"], 1);
  const cTotHrsD = findColByHeader_(dataHeaders, ["totalhours"], 2);
  const cBillHrsD = findColByHeader_(dataHeaders, ["billablehours"], 3);
  const cBillCostD = findColByHeader_(dataHeaders, ["costbillable"], 4);
  const cNonBillCostD = findColByHeader_(dataHeaders, ["costnonbillable"], 5);
  for (let r = 1; r < dataFromTimeGrid.length; r++) {
    const raw = Array.isArray(dataFromTimeGrid[r]) ? trimTrailingEmptyCells_(dataFromTimeGrid[r]) : [];
    if (isRowEmpty_(raw)) continue;
    rows.push({
      client_id: clientId,
      client_name: clientName,
      entry_kind: "staff_month",
      sheet_row_num: r + 1,
      month_date: str_(raw[cMonthD]),
      staff_name: str_(raw[cEmpD]),
      client_label: "",
      job_label: "Staff month",
      total_hours: num_(raw[cTotHrsD]),
      hours_logged: num_(raw[cBillHrsD]),
      billable_amount: 0,
      cost_amount: num_(raw[cBillCostD]) + num_(raw[cNonBillCostD]),
      billable_cost: num_(raw[cBillCostD]),
      non_billable_cost: num_(raw[cNonBillCostD]),
      budget_hours: 0,
      budget_amount: 0,
      status: "",
      visibility: "",
      fte: 1,
      util_target_pct: 0,
      days_pattern: "",
      is_included: true,
      raw_row: raw,
      synced_at: nowIso,
    });
  }

  // 2. ProjectsFromTime -> entry_kind = 'project_month'
  const cMonthP = findColByHeader_(projHeaders, ["month"], 0);
  const cProjP = findColByHeader_(projHeaders, ["projectname", "job"], 1);
  const cCliP = findColByHeader_(projHeaders, ["client"], 2);
  const cStatusP = findColByHeader_(projHeaders, ["status"], 3);
  const cHrsP = findColByHeader_(projHeaders, ["hourslogged"], 4);
  const cBudHrsP = findColByHeader_(projHeaders, ["budgethours"], 5);
  const cValP = findColByHeader_(projHeaders, ["valuelogged"], 6);
  const cBudAmtP = findColByHeader_(projHeaders, ["budget"], 7);
  const cVisP = findColByHeader_(projHeaders, ["visibility"], 8);
  const cBillCostP = findColByHeader_(projHeaders, ["costbillable"], 9);
  const cNonBillCostP = findColByHeader_(projHeaders, ["costnonbillable"], 10);
  for (let r = 1; r < projectsFromTimeGrid.length; r++) {
    const raw = Array.isArray(projectsFromTimeGrid[r])
      ? trimTrailingEmptyCells_(projectsFromTimeGrid[r])
      : [];
    if (isRowEmpty_(raw)) continue;
    rows.push({
      client_id: clientId,
      client_name: clientName,
      entry_kind: "project_month",
      sheet_row_num: r + 1,
      month_date: str_(raw[cMonthP]),
      staff_name: "",
      client_label: str_(raw[cCliP]),
      job_label: str_(raw[cProjP]),
      total_hours: num_(raw[cHrsP]),
      hours_logged: num_(raw[cHrsP]),
      billable_amount: num_(raw[cValP]),
      cost_amount: num_(raw[cBillCostP]) + num_(raw[cNonBillCostP]),
      billable_cost: num_(raw[cBillCostP]),
      non_billable_cost: num_(raw[cNonBillCostP]),
      budget_hours: num_(raw[cBudHrsP]),
      budget_amount: num_(raw[cBudAmtP]),
      status: str_(raw[cStatusP]),
      visibility: str_(raw[cVisP]),
      fte: 1,
      util_target_pct: 0,
      days_pattern: "",
      is_included: true,
      raw_row: raw,
      synced_at: nowIso,
    });
  }

  // 3. TimeComp rows 12..62 (r0 = 11..61) -> entry_kind = 'staff_config'
  // Capture non-formula input columns inside TimeComp monthly 13-col blocks (offsets 0,1,3,9..12) + cols 0..11
  for (let r = 11; r < Math.min(timeCompGrid.length, 62); r++) {
    const row = Array.isArray(timeCompGrid[r]) ? trimTrailingEmptyCells_(timeCompGrid[r]) : [];
    if (isRowEmpty_(row)) continue;
    const isInc = row[4] !== false && normKey_(row[4]) !== "false";
    rows.push({
      client_id: clientId,
      client_name: clientName,
      entry_kind: "staff_config",
      sheet_row_num: r + 1,
      month_date: "",
      staff_name: str_(row[0]),
      client_label: "",
      job_label: "Staff config",
      total_hours: 0,
      hours_logged: 0,
      billable_amount: 0,
      cost_amount: 0,
      billable_cost: 0,
      non_billable_cost: 0,
      budget_hours: 0,
      budget_amount: 0,
      status: "",
      visibility: "",
      fte: num_(row[1], 1),
      util_target_pct: num_(row[2], 0),
      days_pattern: str_(row[3]),
      is_included: isInc,
      raw_row: row,
      synced_at: nowIso,
    });
  }

  return {
    dataHeaders,
    projHeaders,
    dataRowCount: dataFromTimeGrid.length,
    projRowCount: projectsFromTimeGrid.length,
    rows,
  };
}

export function projectTimeDataToGrid({
  headers = [],
  records = [],
  entryKind = "staff_month",
  minRows = 0,
}) {
  const filtered = (records || []).filter((r) => r.entry_kind === entryKind);
  let maxRow = Math.max(minRows, headers.length > 0 ? 1 : 0);
  for (const r of filtered) {
    if (Number(r.sheet_row_num) > maxRow) maxRow = Number(r.sheet_row_num);
  }
  if (maxRow === 0 && headers.length === 0) return [];
  const grid = Array.from({ length: maxRow }, () => []);
  if (headers.length > 0) grid[0] = [...headers];
  for (const rec of filtered) {
    const r0 = Number(rec.sheet_row_num) - 1;
    if (r0 >= 1) {
      grid[r0] = Array.isArray(rec.raw_row) ? [...rec.raw_row] : [];
    }
  }
  return compactGrid2D(grid);
}

// ============================================================================
// 4. MASTER CONFIG & SEED FRAME EXTRACTORS / RESTORERS
// ============================================================================

export function extractMasterSyncConfigFromGrids(clientId, clientName, gridsMap = {}) {
  const invG = gridsMap.InvFromApp || [];
  const revG = gridsMap.RevFromApp || [];
  const jnlG = gridsMap.JnlsFromApp || [];
  const plG = gridsMap.PLFromApp || [];
  const y0PlG = gridsMap.Year0PLFromApp || [];
  const crmRawG = gridsMap.DataFromCRM || [];
  const dtG = gridsMap.DataFromTime || [];
  const ptG = gridsMap.ProjectsFromTime || [];

  const invAppListG = gridsMap.InvAppList || [];
  const invDashListG = gridsMap.InvDashList || [];
  const invCompG = gridsMap.InvComp || [];
  const jnlAppListG = gridsMap.JnlAppList || [];
  const dirDashListG = gridsMap.DirDashList || [];
  const dirCompG = gridsMap.DirComp || [];
  const crmListG = gridsMap.CRMList || [];
  const crmCompG = gridsMap.CRMComp || [];
  const plCompG = gridsMap.PLComp || [];
  const timeCompG = gridsMap.TimeComp || [];

  return {
    client_id: clientId,
    client_name: clientName,
    inv_headers: trimTrailingEmptyCells_(invG[0] || []),
    rev_headers: trimTrailingEmptyCells_(revG[0] || []),
    jnl_headers: trimTrailingEmptyCells_(jnlG[0] || []),
    pl_headers: trimTrailingEmptyCells_(plG[0] || []),
    year0_pl_headers: trimTrailingEmptyCells_(y0PlG[0] || []),
    crm_raw_headers: trimTrailingEmptyCells_(crmRawG[0] || []),
    time_data_headers: trimTrailingEmptyCells_(dtG[0] || []),
    time_projects_headers: trimTrailingEmptyCells_(ptG[0] || []),
    inv_app_list_meta: {
      rowCount: invAppListG.length,
      headerRows: invAppListG.slice(0, 3).map(trimTrailingEmptyCells_),
      extraCells: extractSparseCellsOutside_(
        invAppListG,
        3,
        (_r, c) => (c >= 0 && c <= 23) || (c >= 72 && c <= 84)
      ),
      dashRowCount: invDashListG.length,
      dashHeaderRows: invDashListG.slice(0, 2).map(trimTrailingEmptyCells_),
    },
    jnl_app_list_meta: {
      rowCount: jnlAppListG.length,
      headerRows: jnlAppListG.slice(0, 3).map(trimTrailingEmptyCells_),
      extraCells: extractSparseCellsOutside_(
        jnlAppListG,
        3,
        (_r, c) => (c >= 0 && c <= 14) || (c >= 27 && c <= 41) || (c >= 78 && c <= 92)
      ),
      dashRowCount: dirDashListG.length,
      dashHeaderRows: dirDashListG.slice(0, 2).map(trimTrailingEmptyCells_),
    },
    inv_comp_controls: {
      rowCount: invCompG.length,
      headerRows: invCompG.slice(0, 5).map(trimTrailingEmptyCells_),
      extraCells: extractSparseCellsOutside_(
        invCompG,
        5,
        (_r, c) =>
          (c >= 0 && c <= 24) ||
          (c >= 29 && c <= 31) ||
          (c >= 45 && c <= 70) ||
          (c >= 74 && c <= 76)
      ),
    },
    dir_comp_controls: {
      rowCount: dirCompG.length,
      headerRows: dirCompG.slice(0, 5).map(trimTrailingEmptyCells_),
      extraCells: extractSparseCellsOutside_(
        dirCompG,
        5,
        (_r, c) =>
          (c >= 0 && c <= 13) ||
          (c >= 23 && c <= 33) ||
          (c >= 40 && c <= 47) ||
          (c >= 110 && c <= 120) ||
          (c >= 145 && c <= 154) ||
          (c >= 165 && c <= 172)
      ),
    },
    crm_list_config: {
      rowCount: crmListG.length,
      headerRows: crmListG.slice(0, 3).map(trimTrailingEmptyCells_),
      extraCells: extractSparseCellsOutside_(
        crmListG,
        3,
        (_r, c) =>
          (c >= 0 && c <= 14) ||
          (c >= 27 && c <= 41) ||
          (c >= 78 && c <= 92) ||
          (c >= 103 && c <= 117) ||
          (c >= 124 && c <= 138)
      ),
    },
    crm_comp_controls: {
      rowCount: crmCompG.length,
      headerRows: crmCompG.slice(0, 5).map(trimTrailingEmptyCells_),
      extraCells: extractSparseCellsOutside_(
        crmCompG,
        5,
        (_r, c) =>
          (c >= 0 && c <= 57) ||
          (c >= 61 && c <= 101) ||
          (c >= 116 && c <= 167) ||
          (c >= 170 && c <= 210)
      ),
    },
    pl_comp_meta: {
      rowCount: plCompG.length,
      colCount: plCompG.reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0),
      headerRow: trimTrailingEmptyCells_(plCompG[0] || []),
      seedColsAtoE: plCompG.slice(0, 220).map((r) => trimTrailingEmptyCells_((r || []).slice(0, 5))),
      extraCells: extractSparseCellsOutside_(
        plCompG,
        1,
        (r, c) => {
          if (r < 220 && c <= 4) return true;
          if (r >= 88 && c === 4) return true;
          const inFtoK = c >= 5 && c <= 10;
          const inMtoR = c >= 12 && c <= 17;
          const inTtoY = c >= 19 && c <= 24;
          const inDualCols = inFtoK || inMtoR || inTtoY;
          if (((r >= 1 && r <= 24) || (r >= 51 && r <= 61) || (r >= 64 && r <= 74)) && inFtoK) return true;
          if (((r >= 25 && r <= 49) || (r >= 82 && r <= 83) || r >= 88) && inDualCols) return true;
          if (r === 84 && inMtoR) return true;
          return false;
        }
      ),
    },
    time_comp_controls: {
      rowCount: timeCompG.length,
      headerRows: timeCompG.slice(0, 11).map(trimTrailingEmptyCells_),
      extraRowsAfter62: timeCompG.length > 62 ? clone2D_(timeCompG.slice(62)) : [],
    },
    updated_at: new Date().toISOString(),
  };
}

function buildSeedGridFromMeta_(headerRows = [], minRows = 0, extraCells = []) {
  const grid = Array.from({ length: Math.max(minRows, headerRows.length) }, () => []);
  for (let r = 0; r < headerRows.length; r++) {
    grid[r] = Array.isArray(headerRows[r]) ? [...headerRows[r]] : [];
  }
  applySparseCells_(grid, extraCells);
  return grid;
}

function seedPLCompFromMeta_(meta = {}) {
  const colsAtoE = Array.isArray(meta.seedColsAtoE) ? meta.seedColsAtoE : [];
  const totalRows = Math.max(colsAtoE.length, meta.rowCount || 0, 1);
  const grid = Array.from({ length: totalRows }, () => []);
  for (let r = 0; r < colsAtoE.length; r++) {
    const row = Array.isArray(colsAtoE[r]) ? colsAtoE[r] : [];
    for (let c = 0; c < row.length; c++) {
      grid[r][c] = row[c];
    }
  }
  if (Array.isArray(meta.headerRow)) {
    for (let c = 0; c < meta.headerRow.length; c++) {
      grid[0][c] = meta.headerRow[c];
    }
  }
  applySparseCells_(grid, meta.extraCells);
  return grid;
}

function seedTimeCompFromMeta_(meta = {}, timeEntries = []) {
  const headerRows = Array.isArray(meta.headerRows) ? meta.headerRows : [];
  const staffRows = (timeEntries || []).filter((e) => e.entry_kind === "staff_config");
  const extraTail = Array.isArray(meta.extraRowsAfter62) ? meta.extraRowsAfter62 : [];
  let maxRow = Math.max(headerRows.length, 11, meta.rowCount || 0);
  for (const sr of staffRows) {
    if (Number(sr.sheet_row_num) > maxRow) maxRow = Number(sr.sheet_row_num);
  }
  const grid = Array.from({ length: maxRow }, () => []);
  for (let r = 0; r < headerRows.length; r++) {
    grid[r] = Array.isArray(headerRows[r]) ? [...headerRows[r]] : [];
  }
  for (const sr of staffRows) {
    const r0 = Number(sr.sheet_row_num) - 1;
    if (r0 >= 11 && r0 <= 61) {
      grid[r0] = Array.isArray(sr.raw_row) ? [...sr.raw_row] : [];
    }
  }
  for (let i = 0; i < extraTail.length; i++) {
    const r0 = 62 + i;
    if (r0 < grid.length && Array.isArray(extraTail[i]) && extraTail[i].length > 0) {
      grid[r0] = [...extraTail[i]];
    }
  }
  return grid;
}

// ============================================================================
// 5. SCHEMA STATUS & OVERVIEW TELEMETRY
// ============================================================================

export async function checkPhase4MasterSchemaStatus({ forceRefresh = false } = {}) {
  if (!isSupabaseConfigured()) {
    return { schemaReady: false, reason: "Supabase not configured" };
  }
  if (!forceRefresh && _schemaReadyCache.ready && Date.now() - _schemaReadyCache.checkedAt < 60000) {
    return { schemaReady: true };
  }
  const supabase = getSupabaseAdmin();
  try {
    const checks = await Promise.all([
      supabase.from("clients").select("master_ingestion_mode, master_read_mode").limit(1),
      supabase.from("pulse_master_sync_configs").select("client_id").limit(1),
      supabase.from("accounting_invoices").select("record_kind, sheet_row_num, recharged_amount").limit(1),
      supabase.from("accounting_direct_costs").select("sheet_row_num, source_type").limit(1),
      supabase.from("accounting_pl_lines").select("source_tab, sheet_row_num, row_kind, monthly_amounts").limit(1),
      supabase.from("crm_deals_raw").select("sheet_row_num, matched_job_id, crm_list_row").limit(1),
      supabase.from("time_entries_raw").select("entry_kind, sheet_row_num, employee_id").limit(1),
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

export async function getPhase4MasterOverviewStats() {
  const migrationSql = readMigration0014Sql();
  const status = await checkPhase4MasterSchemaStatus();
  if (!status.schemaReady) {
    return {
      schemaReady: false,
      migrationSql,
      reason: status.reason || "Migration 0014 required",
      totalInvoices: 0,
      totalDirectCosts: 0,
      totalPlLines: 0,
      totalCrmDeals: 0,
      totalTimeEntries: 0,
      totalConfigTabs: 0,
      linkedJobInvoices: 0,
      linkedJobExpenses: 0,
      linkedContractorEntries: 0,
      linkedCrmDeals: 0,
    };
  }
  const supabase = getSupabaseAdmin();
  const [
    invCnt,
    dirCnt,
    plCnt,
    crmCnt,
    timeCnt,
    cfgCnt,
    linkJobInv,
    linkJobExp,
    linkContr,
    linkCrm,
  ] = await Promise.all([
    supabase.from("accounting_invoices").select("id", { count: "exact", head: true }),
    supabase.from("accounting_direct_costs").select("id", { count: "exact", head: true }),
    supabase.from("accounting_pl_lines").select("id", { count: "exact", head: true }),
    supabase.from("crm_deals_raw").select("id", { count: "exact", head: true }),
    supabase.from("time_entries_raw").select("id", { count: "exact", head: true }),
    supabase.from("pulse_master_sync_configs").select("client_id", { count: "exact", head: true }),
    supabase.from("pulse_job_invoices").select("id", { count: "exact", head: true }).not("accounting_invoice_id", "is", null),
    supabase.from("pulse_job_expenses").select("id", { count: "exact", head: true }).not("accounting_direct_cost_id", "is", null),
    supabase.from("pulse_contractor_entries").select("id", { count: "exact", head: true }).not("accounting_direct_cost_id", "is", null),
    supabase.from("crm_deals_raw").select("id", { count: "exact", head: true }).not("matched_job_id", "is", null),
  ]);

  return {
    schemaReady: true,
    migrationSql,
    totalInvoices: invCnt.count || 0,
    totalDirectCosts: dirCnt.count || 0,
    totalPlLines: plCnt.count || 0,
    totalCrmDeals: crmCnt.count || 0,
    totalTimeEntries: timeCnt.count || 0,
    totalConfigTabs: cfgCnt.count || 0,
    linkedJobInvoices: linkJobInv.count || 0,
    linkedJobExpenses: linkJobExp.count || 0,
    linkedContractorEntries: linkContr.count || 0,
    linkedCrmDeals: linkCrm.count || 0,
  };
}

// ============================================================================
// 6. FK AUTO-LINKER & IDEMPOTENT RECONCILE ENGINE
// ============================================================================

async function linkRelationalMasterForeignKeys_(supabase, clientId) {
  const [invRows, dirRows, crmRows, timeRows, jobInvRows, jobExpRows, contrRows, jobsRows, empRows] =
    await Promise.all([
      fetchAllSelectByClientId_(supabase, "accounting_invoices", "id, invoice_number", clientId, {
        record_kind: "invoice",
      }),
      fetchAllSelectByClientId_(supabase, "accounting_direct_costs", "id, external_id", clientId),
      fetchAllSelectByClientId_(supabase, "crm_deals_raw", "id, project_code, matched_job_id", clientId),
      fetchAllSelectByClientId_(supabase, "time_entries_raw", "id, staff_name, employee_id", clientId, {
        entry_kind: ["staff_config", "staff_month"],
      }),
      fetchAllSelectByClientId_(supabase, "pulse_job_invoices", "id, invoice_ref, accounting_invoice_id", clientId),
      fetchAllSelectByClientId_(supabase, "pulse_job_expenses", "id, external_app_id, accounting_direct_cost_id", clientId),
      fetchAllSelectByClientId_(supabase, "pulse_contractor_entries", "id, external_app_id, accounting_direct_cost_id", clientId),
      fetchAllSelectByClientId_(supabase, "pulse_jobs", "id, project_code, tab_type", clientId),
      fetchAllSelectByClientId_(supabase, "pulse_employees", "id, employee_name", clientId),
    ]);

  const invByRef = new Map();
  for (const r of invRows) {
    const k = normKey_(r.invoice_number);
    if (k && !invByRef.has(k)) invByRef.set(k, r.id);
  }
  const dirByExt = new Map();
  for (const r of dirRows) {
    const k = normKey_(r.external_id);
    if (k && !dirByExt.has(k)) dirByExt.set(k, r.id);
  }
  const jobByCode = new Map();
  for (const j of jobsRows) {
    const k = normKey_(j.project_code);
    if (!k) continue;
    // Prefer Confirmed over Pipeline if both exist with same code
    if (!jobByCode.has(k) || j.tab_type === "confirmed") {
      jobByCode.set(k, j.id);
    }
  }
  const empByName = new Map();
  for (const e of empRows) {
    const k = normKey_(e.employee_name);
    if (k && !empByName.has(k)) empByName.set(k, e.id);
  }

  let linkedJobInvoices = 0;
  let linkedJobExpenses = 0;
  let linkedContractorEntries = 0;
  let linkedCrmDeals = 0;
  let linkedTimeEntries = 0;

  const updatePromises = [];
  for (const ji of jobInvRows) {
    const targetId = invByRef.get(normKey_(ji.invoice_ref)) || null;
    if (targetId && ji.accounting_invoice_id !== targetId) {
      linkedJobInvoices++;
      updatePromises.push(
        supabase
          .from("pulse_job_invoices")
          .update({ accounting_invoice_id: targetId })
          .eq("id", ji.id)
      );
    } else if (ji.accounting_invoice_id) {
      linkedJobInvoices++;
    }
  }
  for (const je of jobExpRows) {
    const targetId = dirByExt.get(normKey_(je.external_app_id)) || null;
    if (targetId && je.accounting_direct_cost_id !== targetId) {
      linkedJobExpenses++;
      updatePromises.push(
        supabase
          .from("pulse_job_expenses")
          .update({ accounting_direct_cost_id: targetId })
          .eq("id", je.id)
      );
    } else if (je.accounting_direct_cost_id) {
      linkedJobExpenses++;
    }
  }
  for (const ce of contrRows) {
    const targetId = dirByExt.get(normKey_(ce.external_app_id)) || null;
    if (targetId && ce.accounting_direct_cost_id !== targetId) {
      linkedContractorEntries++;
      updatePromises.push(
        supabase
          .from("pulse_contractor_entries")
          .update({ accounting_direct_cost_id: targetId })
          .eq("id", ce.id)
      );
    } else if (ce.accounting_direct_cost_id) {
      linkedContractorEntries++;
    }
  }
  for (const cd of crmRows) {
    const targetId = jobByCode.get(normKey_(cd.project_code)) || null;
    if (targetId !== (cd.matched_job_id || null)) {
      if (targetId) linkedCrmDeals++;
      updatePromises.push(
        supabase.from("crm_deals_raw").update({ matched_job_id: targetId }).eq("id", cd.id)
      );
    } else if (cd.matched_job_id) {
      linkedCrmDeals++;
    }
  }
  for (const te of timeRows) {
    const targetId = empByName.get(normKey_(te.staff_name)) || null;
    if (targetId !== (te.employee_id || null)) {
      if (targetId) linkedTimeEntries++;
      updatePromises.push(
        supabase.from("time_entries_raw").update({ employee_id: targetId }).eq("id", te.id)
      );
    } else if (te.employee_id) {
      linkedTimeEntries++;
    }
  }

  for (let i = 0; i < updatePromises.length; i += 25) {
    await Promise.all(updatePromises.slice(i, i + 25));
  }

  return {
    linkedJobInvoices,
    linkedJobExpenses,
    linkedContractorEntries,
    linkedCrmDeals,
    linkedTimeEntries,
  };
}

async function runSingleMasterReconcilePass_(ctx, tabNames = ALL_PHASE4_MASTER_TABS, options = {}) {
  const schema = await checkPhase4MasterSchemaStatus();
  if (!schema.schemaReady) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const tabsSet = new Set(tabNames);
  const needsInv = tabsSet.has("InvFromApp") || Boolean(options.forceFullUpsert);
  const needsRev = tabsSet.has("RevFromApp") || Boolean(options.forceFullUpsert);
  const needsDir = tabsSet.has("JnlsFromApp") || Boolean(options.forceFullUpsert);
  const needsPl =
    tabsSet.has("PLFromApp") || tabsSet.has("Year0PLFromApp") || Boolean(options.forceFullUpsert);
  const needsCrm =
    tabsSet.has("DataFromCRM") || tabsSet.has("CRMList") || Boolean(options.forceFullUpsert);
  const needsTime =
    tabsSet.has("DataFromTime") ||
    tabsSet.has("ProjectsFromTime") ||
    tabsSet.has("TimeComp") ||
    Boolean(options.forceFullUpsert);
  const needsConfig =
    !options?.skipConfigUpsert &&
    (Boolean(options.forceFullUpsert) || [...tabsSet].some((t) => ALL_PHASE4_MASTER_TABS.includes(t)));

  const tabsToLoad = new Set(needsConfig ? [...ALL_PHASE4_MASTER_TABS, "KeyInfo"] : []);
  if (needsInv) tabsToLoad.add("InvFromApp");
  if (needsRev) tabsToLoad.add("RevFromApp");
  if (needsDir) {
    tabsToLoad.add("JnlsFromApp");
    tabsToLoad.add("KeyInfo");
  }
  if (needsPl) {
    tabsToLoad.add("PLFromApp");
    tabsToLoad.add("Year0PLFromApp");
  }
  if (needsCrm) {
    tabsToLoad.add("DataFromCRM");
    tabsToLoad.add("CRMList");
  }
  if (needsTime) {
    tabsToLoad.add("DataFromTime");
    tabsToLoad.add("ProjectsFromTime");
    tabsToLoad.add("TimeComp");
  }

  const gridsMap = {};
  const gridsOverride = options?.gridsOverride && typeof options.gridsOverride === "object" ? options.gridsOverride : null;
  await Promise.all(
    [...tabsToLoad].map(async (t) => {
      if (gridsOverride && Array.isArray(gridsOverride[t])) {
        gridsMap[t] = gridsOverride[t];
        return;
      }
      const strictNative = Boolean(ctx.gridStorageRetired || ctx.connectorPullMode === "native");
      let rec = null;
      try {
        rec = await getOrLoadVirtualTabGrid_(ctx, "master", t, null);
      } catch (err) {
        if (strictNative) throw err;
        rec = null;
      }
      gridsMap[t] = Array.isArray(rec?.values_grid) ? rec.values_grid : [];
    })
  );

  const summary = {
    clientName: ctx.clientName,
    invoicesCount: 0,
    revenueLinesCount: 0,
    directCostsCount: 0,
    plLinesCount: 0,
    crmDealsCount: 0,
    timeEntriesCount: 0,
  };

  if (needsConfig && !options?.skipConfigUpsert) {
    const cfg = extractMasterSyncConfigFromGrids(ctx.clientId, ctx.clientName, gridsMap);
    const { error: cfgErr } = await supabase
      .from("pulse_master_sync_configs")
      .upsert(cfg, { onConflict: "client_id" });
    if (cfgErr) throw new Error(`pulse_master_sync_configs upsert failed: ${cfgErr.message}`);
  }

  if (needsInv) {
    const parsedInv = parseInvFromAppGrid({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      grid: gridsMap.InvFromApp || [],
    });
    await upsertInChunks_(
      supabase,
      "accounting_invoices",
      parsedInv.rows,
      "client_id,record_kind,sheet_row_num"
    );
    const keepInvNums = new Set(parsedInv.rows.map((r) => r.sheet_row_num));
    const existingInv = await fetchAllSelectByClientId_(
      supabase,
      "accounting_invoices",
      "id, sheet_row_num",
      ctx.clientId,
      { record_kind: "invoice" }
    );
    const staleIds = existingInv
      .filter((r) => !keepInvNums.has(Number(r.sheet_row_num)))
      .map((r) => r.id);
    for (let i = 0; i < staleIds.length; i += 200) {
      const { error: delErr } = await supabase
        .from("accounting_invoices")
        .delete()
        .in("id", staleIds.slice(i, i + 200));
      if (delErr) throw new Error(`accounting_invoices delete failed: ${delErr.message}`);
    }
    summary.invoicesCount = parsedInv.rows.length;
  }

  if (needsRev) {
    const parsedRev = parseRevFromAppGrid({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      grid: gridsMap.RevFromApp || [],
    });
    await upsertInChunks_(
      supabase,
      "accounting_invoices",
      parsedRev.rows,
      "client_id,record_kind,sheet_row_num"
    );
    const keepRevNums = new Set(parsedRev.rows.map((r) => r.sheet_row_num));
    const existingRev = await fetchAllSelectByClientId_(
      supabase,
      "accounting_invoices",
      "id, sheet_row_num",
      clientIdOrCtx_(ctx),
      { record_kind: "revenue_line" }
    );
    const staleRevIds = existingRev
      .filter((r) => !keepRevNums.has(Number(r.sheet_row_num)))
      .map((r) => r.id);
    for (let i = 0; i < staleRevIds.length; i += 200) {
      const { error: delErr } = await supabase
        .from("accounting_invoices")
        .delete()
        .in("id", staleRevIds.slice(i, i + 200));
      if (delErr) throw new Error(`accounting_invoices revenue_line delete failed: ${delErr.message}`);
    }
    summary.revenueLinesCount = parsedRev.rows.length;
  }

  if (needsDir) {
    const parsedDir = parseJnlsFromAppGrid({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      grid: gridsMap.JnlsFromApp || [],
      keyInfoGrid: gridsMap.KeyInfo || [],
    });
    await upsertInChunks_(
      supabase,
      "accounting_direct_costs",
      parsedDir.rows,
      "client_id,sheet_row_num"
    );
    const keepDirNums = new Set(parsedDir.rows.map((r) => r.sheet_row_num));
    const existingDir = await fetchAllSelectByClientId_(
      supabase,
      "accounting_direct_costs",
      "id, sheet_row_num",
      ctx.clientId
    );
    const staleDirIds = existingDir
      .filter((r) => !keepDirNums.has(Number(r.sheet_row_num)))
      .map((r) => r.id);
    for (let i = 0; i < staleDirIds.length; i += 200) {
      const { error: delErr } = await supabase
        .from("accounting_direct_costs")
        .delete()
        .in("id", staleDirIds.slice(i, i + 200));
      if (delErr) throw new Error(`accounting_direct_costs delete failed: ${delErr.message}`);
    }
    summary.directCostsCount = parsedDir.rows.length;
  }

  if (needsPl) {
    const plMain = parsePLTabGrid({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      sourceTab: "PLFromApp",
      grid: gridsMap.PLFromApp || [],
    });
    const plYear0 = parsePLTabGrid({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      sourceTab: "Year0PLFromApp",
      grid: gridsMap.Year0PLFromApp || [],
    });
    const allPlRows = [...plMain.rows, ...plYear0.rows];
    await upsertInChunks_(
      supabase,
      "accounting_pl_lines",
      allPlRows,
      "client_id,source_tab,sheet_row_num"
    );
    const keepPlKeys = new Set(allPlRows.map((r) => `${r.source_tab}::${r.sheet_row_num}`));
    const existingPl = await fetchAllSelectByClientId_(
      supabase,
      "accounting_pl_lines",
      "id, source_tab, sheet_row_num",
      ctx.clientId
    );
    const stalePlIds = existingPl
      .filter((r) => !keepPlKeys.has(`${r.source_tab}::${r.sheet_row_num}`))
      .map((r) => r.id);
    for (let i = 0; i < stalePlIds.length; i += 200) {
      const { error: delErr } = await supabase
        .from("accounting_pl_lines")
        .delete()
        .in("id", stalePlIds.slice(i, i + 200));
      if (delErr) throw new Error(`accounting_pl_lines delete failed: ${delErr.message}`);
    }
    summary.plLinesCount = allPlRows.length;
  }

  if (needsCrm) {
    const parsedCrm = parseCrmDealsFromGrids({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      dataFromCrmGrid: gridsMap.DataFromCRM || [],
      crmListGrid: gridsMap.CRMList || [],
    });
    await upsertInChunks_(
      supabase,
      "crm_deals_raw",
      parsedCrm.rows,
      "client_id,sheet_row_num"
    );
    const keepCrmNums = new Set(parsedCrm.rows.map((r) => r.sheet_row_num));
    const existingCrm = await fetchAllSelectByClientId_(
      supabase,
      "crm_deals_raw",
      "id, sheet_row_num",
      ctx.clientId
    );
    const staleCrmIds = existingCrm
      .filter((r) => !keepCrmNums.has(Number(r.sheet_row_num)))
      .map((r) => r.id);
    for (let i = 0; i < staleCrmIds.length; i += 200) {
      const { error: delErr } = await supabase
        .from("crm_deals_raw")
        .delete()
        .in("id", staleCrmIds.slice(i, i + 200));
      if (delErr) throw new Error(`crm_deals_raw delete failed: ${delErr.message}`);
    }
    summary.crmDealsCount = parsedCrm.rows.length;
  }

  if (needsTime) {
    const parsedTime = parseTimeTablesFromGrids({
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      dataFromTimeGrid: gridsMap.DataFromTime || [],
      projectsFromTimeGrid: gridsMap.ProjectsFromTime || [],
      timeCompGrid: gridsMap.TimeComp || [],
    });
    await upsertInChunks_(
      supabase,
      "time_entries_raw",
      parsedTime.rows,
      "client_id,entry_kind,sheet_row_num"
    );
    const keepTimeKeys = new Set(parsedTime.rows.map((r) => `${r.entry_kind}::${r.sheet_row_num}`));
    const existingTime = await fetchAllSelectByClientId_(
      supabase,
      "time_entries_raw",
      "id, entry_kind, sheet_row_num",
      ctx.clientId
    );
    const staleTimeIds = existingTime
      .filter((r) => !keepTimeKeys.has(`${r.entry_kind}::${r.sheet_row_num}`))
      .map((r) => r.id);
    for (let i = 0; i < staleTimeIds.length; i += 200) {
      const { error: delErr } = await supabase
        .from("time_entries_raw")
        .delete()
        .in("id", staleTimeIds.slice(i, i + 200));
      if (delErr) throw new Error(`time_entries_raw delete failed: ${delErr.message}`);
    }
    summary.timeEntriesCount = parsedTime.rows.length;
  }

  const fkLinks = await linkRelationalMasterForeignKeys_(supabase, ctx.clientId);
  invalidateClientRelationalMasterCache(ctx.clientName);

  if (options.updateBackfillTimestamp) {
    const { data: cRow, error: cErr } = await supabase
      .from("clients")
      .select("metadata")
      .eq("id", ctx.clientId)
      .maybeSingle();
    if (!cErr && cRow) {
      const nextMeta = {
        ...(cRow.metadata || {}),
        relational_master_state: {
          lastBackfilledAt: new Date().toISOString(),
          ...summary,
          ...fkLinks,
        },
      };
      await supabase.from("clients").update({ metadata: nextMeta }).eq("id", ctx.clientId);
    }
  }

  return {
    ...summary,
    ...fkLinks,
    counts: {
      invoices: summary.invoicesCount,
      revenueLines: summary.revenueLinesCount,
      directCosts: summary.directCostsCount,
      plLines: summary.plLinesCount,
      crmDeals: summary.crmDealsCount,
      timeEntries: summary.timeEntriesCount,
    },
  };
}

function clientIdOrCtx_(ctx) {
  return ctx.clientId;
}

export async function reconcileClientMasterIngestionFromGrids(
  ctxOrClientName,
  tabNames = ALL_PHASE4_MASTER_TABS,
  options = {}
) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  const targetTabs = [
    ...new Set((Array.isArray(tabNames) ? tabNames : []).filter((t) => ALL_PHASE4_MASTER_TABS.includes(t))),
  ];
  if (targetTabs.length === 0 && !options.forceFullUpsert) return null;

  const key = String(ctx.clientName || ctx.clientId).trim().toLowerCase();
  const pendingEntry = _pendingMasterReconcileByClient.get(key) || { tabs: new Set(), opts: {} };
  for (const t of targetTabs) pendingEntry.tabs.add(t);
  const prevOpts = pendingEntry.opts || {};
  const mergedGridsOverride =
    prevOpts.gridsOverride || options?.gridsOverride
      ? { ...(prevOpts.gridsOverride || {}), ...(options?.gridsOverride || {}) }
      : undefined;
  pendingEntry.opts = {
    ...prevOpts,
    ...options,
    forceFullUpsert: Boolean(prevOpts.forceFullUpsert || options?.forceFullUpsert),
    updateBackfillTimestamp: Boolean(prevOpts.updateBackfillTimestamp || options?.updateBackfillTimestamp),
    skipConfigUpsert: Boolean(prevOpts.skipConfigUpsert && (options?.skipConfigUpsert ?? true)),
    ...(mergedGridsOverride ? { gridsOverride: mergedGridsOverride } : {}),
  };
  _pendingMasterReconcileByClient.set(key, pendingEntry);

  if (_inFlightMasterReconcileByClient.has(key)) {
    return _inFlightMasterReconcileByClient.get(key);
  }

  const runner = (async () => {
    let lastSummary = null;
    while (_pendingMasterReconcileByClient.has(key)) {
      const next = _pendingMasterReconcileByClient.get(key);
      _pendingMasterReconcileByClient.delete(key);
      lastSummary = await runSingleMasterReconcilePass_(ctx, [...next.tabs], next.opts);
    }
    return lastSummary;
  })();

  _inFlightMasterReconcileByClient.set(key, runner);
  try {
    return await runner;
  } finally {
    if (_inFlightMasterReconcileByClient.get(key) === runner) {
      _inFlightMasterReconcileByClient.delete(key);
    }
  }
}

export async function backfillClientMasterIngestion(clientName) {
  const schema = await checkPhase4MasterSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0014 must be applied in Supabase SQL Editor before backfilling master ingestion.");
  }
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientId) {
    throw new Error(`Client "${clientName}" was not found in Supabase.`);
  }
  if (ctx.gridStorageRetired) {
    return {
      clientName: ctx.clientName,
      skippedRetired: true,
      invoicesCount: 0,
      revenueLinesCount: 0,
      directCostsCount: 0,
      plLinesCount: 0,
      crmDealsCount: 0,
      timeEntriesCount: 0,
    };
  }
  return reconcileClientMasterIngestionFromGrids(ctx, ALL_PHASE4_MASTER_TABS, {
    forceFullUpsert: true,
    updateBackfillTimestamp: true,
  });
}

export async function backfillAllClientsMasterIngestion() {
  const schema = await checkPhase4MasterSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0014 must be applied in Supabase SQL Editor before backfilling master ingestion.");
  }
  const supabase = getSupabaseAdmin();
  const { data: clients, error } = await supabase.from("clients").select("client_name").order("client_name");
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    try {
      const s = await backfillClientMasterIngestion(cl.client_name);
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
    invoicesCount: results.reduce((a, r) => a + (r.invoicesCount || 0), 0),
    revenueLinesCount: results.reduce((a, r) => a + (r.revenueLinesCount || 0), 0),
    directCostsCount: results.reduce((a, r) => a + (r.directCostsCount || 0), 0),
    plLinesCount: results.reduce((a, r) => a + (r.plLinesCount || 0), 0),
    crmDealsCount: results.reduce((a, r) => a + (r.crmDealsCount || 0), 0),
    timeEntriesCount: results.reduce((a, r) => a + (r.timeEntriesCount || 0), 0),
    results,
  };
}

// ============================================================================
// 7. RELATIONAL MASTER BUNDLE LOADER & COMPARISON TAB RECONSTRUCTOR
// ============================================================================

async function loadInMemoryBundleForClient_(ctx, gridsOverride = null) {
  const gridsMap = {};
  const tabsToLoad = [...ALL_PHASE4_MASTER_TABS, "KeyInfo", "DataChgAlert", "PLAdds", "ConfCalcs", "PipeCalcs", "Outgoings", "OutgNotes"];
  if (gridsOverride && typeof gridsOverride === "object") {
    for (const t of tabsToLoad) {
      gridsMap[t] = clone2D_(gridsOverride[t] || []);
    }
  } else {
    await Promise.all(
      tabsToLoad.map(async (t) => {
        const rec = await getOrLoadVirtualTabGrid_(ctx, "master", t, null).catch(() => null);
        gridsMap[t] = clone2D_(rec?.values_grid || []);
      })
    );
  }
  const config = extractMasterSyncConfigFromGrids(ctx.clientId, ctx.clientName, gridsMap);
  const invParsed = parseInvFromAppGrid({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    grid: gridsMap.InvFromApp || [],
  });
  const revParsed = parseRevFromAppGrid({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    grid: gridsMap.RevFromApp || [],
  });
  const dirParsed = parseJnlsFromAppGrid({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    grid: gridsMap.JnlsFromApp || [],
    keyInfoGrid: gridsMap.KeyInfo || [],
  });
  const plMain = parsePLTabGrid({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    sourceTab: "PLFromApp",
    grid: gridsMap.PLFromApp || [],
  });
  const plYear0 = parsePLTabGrid({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    sourceTab: "Year0PLFromApp",
    grid: gridsMap.Year0PLFromApp || [],
  });
  const crmParsed = parseCrmDealsFromGrids({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    dataFromCrmGrid: gridsMap.DataFromCRM || [],
    crmListGrid: gridsMap.CRMList || [],
  });
  const timeParsed = parseTimeTablesFromGrids({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    dataFromTimeGrid: gridsMap.DataFromTime || [],
    projectsFromTimeGrid: gridsMap.ProjectsFromTime || [],
    timeCompGrid: gridsMap.TimeComp || [],
  });

  return {
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    source: "in_memory",
    config,
    accountingInvoices: [...invParsed.rows, ...revParsed.rows],
    accountingDirectCosts: dirParsed.rows,
    accountingPlLines: [...plMain.rows, ...plYear0.rows],
    crmDeals: crmParsed.rows,
    timeEntries: timeParsed.rows,
    evaluatedTabsCache: new Map(),
    rawGridsOverride: gridsMap,
  };
}

export async function preloadClientRelationalMasterBundle(ctxOrClientName, { source = "db", gridsOverride = null } = {}) {
  const ctx =
    ctxOrClientName && typeof ctxOrClientName === "object" && ctxOrClientName.clientId
      ? ctxOrClientName
      : await resolveSupabaseSheetContext({ clientName: String(ctxOrClientName || "") });
  if (!ctx?.clientId) return null;

  if (source === "in_memory") {
    return loadInMemoryBundleForClient_(ctx, gridsOverride);
  }

  const cacheKey = String(ctx.clientName || ctx.clientId).trim().toLowerCase();
  const cached = _masterBundleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.bundle;
  }

  const supabase = getSupabaseAdmin();
  const [cfgRes, invRows, dirRows, plRows, crmRows, timeRows] = await Promise.all([
    supabase
      .from("pulse_master_sync_configs")
      .select("*")
      .eq("client_id", ctx.clientId)
      .maybeSingle(),
    fetchAllRowsByClientId_(supabase, "accounting_invoices", ctx.clientId, "sheet_row_num"),
    fetchAllRowsByClientId_(supabase, "accounting_direct_costs", ctx.clientId, "sheet_row_num"),
    fetchAllRowsByClientId_(supabase, "accounting_pl_lines", ctx.clientId, "sheet_row_num"),
    fetchAllRowsByClientId_(supabase, "crm_deals_raw", ctx.clientId, "sheet_row_num"),
    fetchAllRowsByClientId_(supabase, "time_entries_raw", ctx.clientId, "sheet_row_num"),
  ]);
  if (cfgRes.error) {
    throw new Error(`pulse_master_sync_configs load failed (${ctx.clientName}): ${cfgRes.error.message}`);
  }

  const bundle = {
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    source: "db",
    config: cfgRes.data || {},
    accountingInvoices: invRows,
    accountingDirectCosts: dirRows,
    accountingPlLines: plRows,
    crmDeals: crmRows,
    timeEntries: timeRows,
    evaluatedTabsCache: new Map(),
  };

  _masterBundleCache.set(cacheKey, {
    bundle,
    expiresAt: Date.now() + MASTER_BUNDLE_TTL_MS,
  });
  return bundle;
}

export function buildBaseRawMasterTabsFromBundle(bundle) {
  const cfg = bundle.config || {};
  return {
    InvFromApp: projectAccountingInvoicesToGrid({
      headers: cfg.inv_headers || [],
      records: bundle.accountingInvoices,
      recordKind: "invoice",
    }),
    RevFromApp: projectAccountingInvoicesToGrid({
      headers: cfg.rev_headers || [],
      records: bundle.accountingInvoices,
      recordKind: "revenue_line",
    }),
    JnlsFromApp: projectDirectCostsToGrid({
      headers: cfg.jnl_headers || [],
      records: bundle.accountingDirectCosts,
    }),
    PLFromApp: projectPLLinesToGrid({
      headers: cfg.pl_headers || [],
      records: bundle.accountingPlLines,
      sourceTab: "PLFromApp",
    }),
    Year0PLFromApp: projectPLLinesToGrid({
      headers: cfg.year0_pl_headers || [],
      records: bundle.accountingPlLines,
      sourceTab: "Year0PLFromApp",
    }),
    DataFromCRM: projectCrmDealsToDataFromCrmGrid({
      headers: cfg.crm_raw_headers || [],
      records: bundle.crmDeals,
    }),
    DataFromTime: projectTimeDataToGrid({
      headers: cfg.time_data_headers || [],
      records: bundle.timeEntries,
      entryKind: "staff_month",
    }),
    ProjectsFromTime: projectTimeDataToGrid({
      headers: cfg.time_projects_headers || [],
      records: bundle.timeEntries,
      entryKind: "project_month",
    }),
  };
}

export function buildMasterComparisonSeedGridsFromBundle(bundle) {
  const cfg = bundle?.config || {};
  return {
    InvAppList: buildSeedGridFromMeta_(
      cfg.inv_app_list_meta?.headerRows,
      cfg.inv_app_list_meta?.rowCount || 3,
      cfg.inv_app_list_meta?.extraCells
    ),
    InvDashList: buildSeedGridFromMeta_(
      cfg.inv_app_list_meta?.dashHeaderRows,
      cfg.inv_app_list_meta?.dashRowCount || 2
    ),
    InvComp: buildSeedGridFromMeta_(
      cfg.inv_comp_controls?.headerRows,
      cfg.inv_comp_controls?.rowCount || 5,
      cfg.inv_comp_controls?.extraCells
    ),
    JnlAppList: buildSeedGridFromMeta_(
      cfg.jnl_app_list_meta?.headerRows,
      cfg.jnl_app_list_meta?.rowCount || 3,
      cfg.jnl_app_list_meta?.extraCells
    ),
    DirDashList: buildSeedGridFromMeta_(
      cfg.jnl_app_list_meta?.dashHeaderRows,
      cfg.jnl_app_list_meta?.dashRowCount || 2
    ),
    DirComp: buildSeedGridFromMeta_(
      cfg.dir_comp_controls?.headerRows,
      cfg.dir_comp_controls?.rowCount || 5,
      cfg.dir_comp_controls?.extraCells
    ),
    CRMList: buildSeedGridFromMeta_(
      cfg.crm_list_config?.headerRows,
      cfg.crm_list_config?.rowCount || 3,
      cfg.crm_list_config?.extraCells
    ),
    CRMComp: buildSeedGridFromMeta_(
      cfg.crm_comp_controls?.headerRows,
      cfg.crm_comp_controls?.rowCount || 5,
      cfg.crm_comp_controls?.extraCells
    ),
    PLComp: seedPLCompFromMeta_(cfg.pl_comp_meta || {}),
    TimeComp: seedTimeCompFromMeta_(cfg.time_comp_controls || {}, bundle?.timeEntries || []),
  };
}

export async function reconstructRelationalMasterTabFromBundle(bundle, tabName, ctxOverride = null) {
  if (!bundle) return null;
  if (bundle.evaluatedTabsCache?.has(tabName)) {
    return clone2D_(bundle.evaluatedTabsCache.get(tabName));
  }

  const rawTabs = buildBaseRawMasterTabsFromBundle(bundle);
  if (Object.prototype.hasOwnProperty.call(rawTabs, tabName)) {
    const out = rawTabs[tabName];
    bundle.evaluatedTabsCache?.set(tabName, out);
    return clone2D_(out);
  }

  const ctx = ctxOverride || (await resolveSupabaseSheetContext({ clientName: bundle.clientName }));
  if (ctx?.masterComputeMode === "native" && PHASE4_CONFIG_AND_COMP_TABS.includes(tabName)) {
    try {
      const { loadPersistedOrEvaluateMasterComparisonTab } = await import("./nativeMasterComparisonService.js");
      const grid = await loadPersistedOrEvaluateMasterComparisonTab(ctx, tabName);
      if (Array.isArray(grid)) {
        bundle.evaluatedTabsCache?.set(tabName, grid);
        return clone2D_(grid);
      }
    } catch (natErr) {
      console.warn(`[relationalMasterService] Native comparison fallback (${bundle.clientName}/${tabName}):`, natErr?.message);
    }
  }

  const loadMasterContextGrid_ = async (t) => {
    if (bundle.rawGridsOverride && bundle.rawGridsOverride[t]) {
      return clone2D_(bundle.rawGridsOverride[t]);
    }
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", t, null).catch(() => null);
    return clone2D_(rec?.values_grid || []);
  };

  const grids = {
    ...rawTabs,
    ...buildMasterComparisonSeedGridsFromBundle(bundle),
  };

  const needsCrm = tabName === "CRMList" || tabName === "CRMComp";
  const needsInv = tabName === "InvAppList" || tabName === "InvDashList" || tabName === "InvComp";
  const needsDir = tabName === "JnlAppList" || tabName === "DirDashList" || tabName === "DirComp";
  const needsPl = tabName === "PLComp";
  const needsTime = tabName === "TimeComp";

  grids.KeyInfo = await loadMasterContextGrid_("KeyInfo");

  if (needsCrm) {
    const [da, cc, pc] = await Promise.all([
      loadMasterContextGrid_("DataChgAlert"),
      loadMasterContextGrid_("ConfCalcs"),
      loadMasterContextGrid_("PipeCalcs"),
    ]);
    grids.DataChgAlert = da;
    grids.ConfCalcs = cc;
    grids.PipeCalcs = pc;
    evaluateCRMList(grids);
    evaluateCRMComp(grids);
    bundle.evaluatedTabsCache?.set("CRMList", grids.CRMList);
    bundle.evaluatedTabsCache?.set("CRMComp", grids.CRMComp);
  }
  if (needsInv) {
    grids.ConfCalcs = await loadMasterContextGrid_("ConfCalcs");
    evaluateInvAppList(grids);
    evaluateInvDashList(grids);
    evaluateInvComp(grids);
    bundle.evaluatedTabsCache?.set("InvAppList", grids.InvAppList);
    bundle.evaluatedTabsCache?.set("InvDashList", grids.InvDashList);
    bundle.evaluatedTabsCache?.set("InvComp", grids.InvComp);
  }
  if (needsDir) {
    const [cc, outG, outNg] = await Promise.all([
      loadMasterContextGrid_("ConfCalcs"),
      loadMasterContextGrid_("Outgoings"),
      loadMasterContextGrid_("OutgNotes"),
    ]);
    grids.ConfCalcs = cc;
    grids.Outgoings = outG;
    grids.OutgNotes = outNg;
    evaluateJnlAppList(grids);
    evaluateDirDashList(grids);
    evaluateDirComp(grids);
    bundle.evaluatedTabsCache?.set("JnlAppList", grids.JnlAppList);
    bundle.evaluatedTabsCache?.set("DirDashList", grids.DirDashList);
    bundle.evaluatedTabsCache?.set("DirComp", grids.DirComp);
  }
  if (needsPl) {
    const [outG, plAddsG, reconPlAddsRec] = await Promise.all([
      loadMasterContextGrid_("Outgoings"),
      loadMasterContextGrid_("PLAdds"),
      ctx?.reconSheetId
        ? getOrLoadVirtualTabGrid_(ctx, "recon", "PLAdds", null).catch(() => null)
        : Promise.resolve(null),
    ]);
    grids.Outgoings = outG;
    grids.PLAdds = plAddsG;
    if (Array.isArray(reconPlAddsRec?.values_grid) && reconPlAddsRec.values_grid.length > 0) {
      grids.ReconPLAdds = clone2D_(reconPlAddsRec.values_grid);
    }
    evaluateOutgoingsMasterTab(grids);
    evaluateKeyInfoAndPLComp(grids, { clientSheetId: ctx?.clientSheetId || "" });
    bundle.evaluatedTabsCache?.set("PLComp", grids.PLComp);
  }
  if (needsTime) {
    evaluateTimeComp(grids);
    bundle.evaluatedTabsCache?.set("TimeComp", grids.TimeComp);
  }

  return clone2D_(grids[tabName] || []);
}

// ============================================================================
// 8. MODE TOGGLES
// ============================================================================

export async function setClientMasterIngestionMode(clientName, mode) {
  const cleanMode = String(mode || "").trim().toLowerCase();
  if (cleanMode !== "grid" && cleanMode !== "relational") {
    throw new Error("Invalid masterIngestionMode. Expected 'grid' or 'relational'.");
  }
  const schema = await checkPhase4MasterSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0014 must be applied in Supabase SQL Editor first.");
  }
  const supabase = getSupabaseAdmin();
  const { data: cl, error: fErr } = await supabase
    .from("clients")
    .select("id, client_name, grid_storage_retired, metadata")
    .eq("client_name", clientName)
    .maybeSingle();
  if (fErr || !cl) throw new Error(fErr?.message || `Client "${clientName}" not found.`);
  if (cl.grid_storage_retired && cleanMode !== "relational") {
    throw new Error(
      `Client "${clientName}" has retired grid storage and cannot be downgraded from 'relational' master_ingestion_mode.`
    );
  }

  if (cleanMode === "relational" && !cl.grid_storage_retired) {
    await backfillClientMasterIngestion(clientName);
  }

  const nextMeta = { ...(cl.metadata || {}), master_ingestion_mode: cleanMode };
  const { data: upd, error: uErr } = await supabase
    .from("clients")
    .update({ master_ingestion_mode: cleanMode, metadata: nextMeta })
    .eq("id", cl.id)
    .select("id, client_name, master_ingestion_mode, master_read_mode")
    .single();
  if (uErr) throw new Error(`Failed updating master_ingestion_mode: ${uErr.message}`);
  invalidateMasterEngineCache(clientName, "master", ALL_PHASE4_MASTER_TABS, {
    invalidateSheetContext: true,
  });
  invalidateClientRelationalMasterCache(clientName);
  return upd;
}

export async function setClientMasterReadMode(clientName, mode) {
  const cleanMode = String(mode || "").trim().toLowerCase();
  if (cleanMode !== "grid" && cleanMode !== "relational") {
    throw new Error("Invalid masterReadMode. Expected 'grid' or 'relational'.");
  }
  const schema = await checkPhase4MasterSchemaStatus({ forceRefresh: true });
  if (!schema.schemaReady) {
    throw new Error("Migration 0014 must be applied in Supabase SQL Editor first.");
  }
  const supabase = getSupabaseAdmin();
  const { data: cl, error: fErr } = await supabase
    .from("clients")
    .select("id, client_name, master_ingestion_mode, grid_storage_retired, metadata")
    .eq("client_name", clientName)
    .maybeSingle();
  if (fErr || !cl) throw new Error(fErr?.message || `Client "${clientName}" not found.`);
  if (cl.grid_storage_retired && cleanMode !== "relational") {
    throw new Error(
      `Client "${clientName}" has retired grid storage and cannot be downgraded from 'relational' master_read_mode.`
    );
  }

  if (cleanMode === "relational" && cl.master_ingestion_mode !== "relational") {
    throw new Error(`Switch ${clientName} to relational master ingestion before enabling direct relational reads.`);
  }

  const nextMeta = { ...(cl.metadata || {}), master_read_mode: cleanMode };
  const { data: upd, error: uErr } = await supabase
    .from("clients")
    .update({ master_read_mode: cleanMode, metadata: nextMeta })
    .eq("id", cl.id)
    .select("id, client_name, master_ingestion_mode, master_read_mode")
    .single();
  if (uErr) throw new Error(`Failed updating master_read_mode: ${uErr.message}`);
  invalidateMasterEngineCache(clientName, "master", ALL_PHASE4_MASTER_TABS, {
    invalidateSheetContext: true,
  });
  invalidateClientRelationalMasterCache(clientName);
  return upd;
}

// ============================================================================
// 9. 100% CELL-FOR-CELL PARITY VERIFIERS (RAW INGESTION + COMPARISON READS)
// ============================================================================

function normCellForCompare_(v) {
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
      const va = normCellForCompare_(rowA[c]);
      const vb = normCellForCompare_(rowB[c]);
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

export async function verifyRelationalMasterParity({
  clientName = null,
  source = "auto",
  onlyIngestionEnabled = false,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase4MasterSchemaStatus();
  const cols = schema.schemaReady
    ? "id, client_name, master_ingestion_mode, connector_pull_mode, metadata"
    : "id, client_name, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  let { data: clients, error } = await query;
  if (error && /connector_pull_mode|42703/i.test(String(error.message || ""))) {
    let fb = supabase
      .from("clients")
      .select(schema.schemaReady ? "id, client_name, master_ingestion_mode, metadata" : "id, client_name, metadata")
      .order("client_name");
    if (clientName) fb = fb.eq("client_name", clientName);
    ({ data: clients, error } = await fb);
  }
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const results = [];
  for (const cl of clients || []) {
    if (onlyIngestionEnabled && cl.master_ingestion_mode !== "relational") continue;
    try {
      const ctx = { clientId: cl.id, clientName: cl.client_name };
      const connMode = String(cl.connector_pull_mode || cl.metadata?.connector_pull_mode || "grid_gas").toLowerCase();
      const canUseDb =
        schema.schemaReady &&
        (source === "db" ||
          (source === "auto" && Boolean(cl.metadata?.relational_master_state?.lastBackfilledAt)));

      const bundle = await preloadClientRelationalMasterBundle(ctx, {
        source: canUseDb ? "db" : "in_memory",
      });
      const relRawTabs = buildBaseRawMasterTabsFromBundle(bundle);
      let referenceTabs = null;
      if (connMode === "native") {
        // Phase 6E zero-grid: round-trip SQL bundle -> raw tabs -> in-memory model -> raw tabs (zero master_sheet_grids reads)
        const roundTripBundle = await preloadClientRelationalMasterBundle(
          { ...ctx, connectorPullMode: "native" },
          {
            source: "in_memory",
            gridsOverride: {
              ...relRawTabs,
              KeyInfo: bundle.config?.master_key_info_grid || [],
            },
          }
        ).catch(() => null);
        referenceTabs = roundTripBundle ? buildBaseRawMasterTabsFromBundle(roundTripBundle) : relRawTabs;
      } else {
        referenceTabs = {};
        await Promise.all(
          PHASE4_RAW_INGESTION_TABS.map(async (t) => {
            const rec = await getOrLoadVirtualTabGrid_(ctx, "master", t, null).catch(() => null);
            referenceTabs[t] = rec?.values_grid || [];
          })
        );
      }

      let totalMismatchCount = 0;
      const sampleMismatches = [];
      for (const t of PHASE4_RAW_INGESTION_TABS) {
        const { mismatchCount, diffs } = diff2DGrids_(t, referenceTabs[t], relRawTabs[t], 4);
        totalMismatchCount += mismatchCount;
        if (sampleMismatches.length < 10) sampleMismatches.push(...diffs);
      }

      results.push({
        clientName: cl.client_name,
        source: bundle.source,
        masterIngestionMode: cl.master_ingestion_mode || "grid",
        invoicesCount: bundle.accountingInvoices.length,
        directCostsCount: bundle.accountingDirectCosts.length,
        plLinesCount: bundle.accountingPlLines.length,
        crmDealsCount: bundle.crmDeals.length,
        timeEntriesCount: bundle.timeEntries.length,
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

export async function verifyRelationalMasterReadParity({
  clientName = null,
  source = "auto",
  onlyReadEnabled = false,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const schema = await checkPhase4MasterSchemaStatus();
  const cols = schema.schemaReady
    ? "id, client_name, master_ingestion_mode, master_read_mode, master_compute_mode, recon_sheet_id, metadata"
    : "id, client_name, recon_sheet_id, metadata";
  let query = supabase.from("clients").select(cols).order("client_name");
  if (clientName) query = query.eq("client_name", clientName);
  let { data: clients, error } = await query;
  if (error && String(error.message || "").includes("master_compute_mode")) {
    let fbQuery = supabase
      .from("clients")
      .select(
        schema.schemaReady
          ? "id, client_name, master_ingestion_mode, master_read_mode, recon_sheet_id, metadata"
          : "id, client_name, recon_sheet_id, metadata"
      )
      .order("client_name");
    if (clientName) fbQuery = fbQuery.eq("client_name", clientName);
    ({ data: clients, error } = await fbQuery);
  }
  if (error) throw new Error(`Failed loading clients: ${error.message}`);

  const READ_PARITY_TABS = ["InvComp", "DirComp", "PLComp", "CRMList", "CRMComp", "TimeComp"];
  const results = [];

  for (const cl of clients || []) {
    if (onlyReadEnabled && cl.master_read_mode !== "relational") continue;
    try {
      const masterComputeMode = String(cl.master_compute_mode || cl.metadata?.master_compute_mode || "grid_gas");
      const ctx = {
        clientId: cl.id,
        clientName: cl.client_name,
        masterComputeMode,
        reconSheetId: cl.recon_sheet_id || `sb-recon-${String(cl.client_name).toLowerCase()}`,
      };
      const canUseDb =
        schema.schemaReady &&
        (source === "db" ||
          (source === "auto" && Boolean(cl.metadata?.relational_master_state?.lastBackfilledAt)));

      const bundle = await preloadClientRelationalMasterBundle(ctx, {
        source: canUseDb ? "db" : "in_memory",
      });

      let baseGridsA = {};
      if (masterComputeMode === "native") {
        const { evaluateNativeMasterComparisonsInMemory } = await import("./nativeMasterComparisonService.js");
        const nat = await evaluateNativeMasterComparisonsInMemory(ctx, { source: "db" });
        baseGridsA = nat?.grids || {};
      } else {
        const baseContextTabs = [
          "KeyInfo",
          "DataChgAlert",
          "ConfCalcs",
          "PipeCalcs",
          "Outgoings",
          "OutgNotes",
          "PLAdds",
          ...ALL_PHASE4_MASTER_TABS,
        ];
        await Promise.all(
          baseContextTabs.map(async (t) => {
            const rec = await getOrLoadVirtualTabGrid_(ctx, "master", t, null).catch(() => null);
            baseGridsA[t] = clone2D_(rec?.values_grid || []);
          })
        );
        if (ctx.reconSheetId) {
          const rPa = await getOrLoadVirtualTabGrid_(ctx, "recon", "PLAdds", null).catch(() => null);
          if (Array.isArray(rPa?.values_grid) && rPa.values_grid.length > 0) {
            baseGridsA.ReconPLAdds = clone2D_(rPa.values_grid);
          }
        }

        evaluateOutgoingsMasterTab(baseGridsA);
        evaluateInvAppList(baseGridsA);
        evaluateInvDashList(baseGridsA);
        evaluateInvComp(baseGridsA);
        evaluateJnlAppList(baseGridsA);
        evaluateDirDashList(baseGridsA);
        evaluateDirComp(baseGridsA);
        evaluateCRMList(baseGridsA);
        evaluateCRMComp(baseGridsA);
        evaluateKeyInfoAndPLComp(baseGridsA);
        evaluateTimeComp(baseGridsA);
      }

      let mismatchCount = 0;
      const sampleMismatches = [];
      for (const t of READ_PARITY_TABS) {
        const relGrid = await reconstructRelationalMasterTabFromBundle(bundle, t, ctx);
        const { mismatchCount: mCnt, diffs } = diff2DGrids_(t, baseGridsA[t], relGrid, 4);
        mismatchCount += mCnt;
        if (sampleMismatches.length < 10) sampleMismatches.push(...diffs);
      }

      results.push({
        clientName: cl.client_name,
        source: bundle.source,
        masterIngestionMode: cl.master_ingestion_mode || "grid",
        masterReadMode: cl.master_read_mode || "grid",
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
    clientsChecked: results.length,
    matchedClientsCount: results.filter((r) => !r.error && r.matched).length,
    mismatchClientsCount: results.filter((r) => !r.error && !r.matched).length,
    errorClientsCount: results.filter((r) => Boolean(r.error)).length,
    results,
  };
}
