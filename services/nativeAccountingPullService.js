/**
 * nativeAccountingPullService.js (Phase 6C)
 *
 * 100% verbatim Node.js replacement for GAS Accounting Pull Engines:
 *   - 1_Core_and_Xero.gs (Xero Invoices Whole/Lines + Net-of-Credit + Recharged R:S + Slot Reuse + Rolling P&L)
 *   - 3_QuickBooks_and_Starters.gs (QB Invoices Whole/Lines + Payment Dates + TaxCode VAT + CreditMemo + Rolling P&L + Year0 P&L)
 *   - 7_Cost_Sync.gs (Direct Costs 13m Sync, COA Refresh, Single-Month P&L)
 *
 * Persists directly into Phase 4 Postgres tables (`accounting_invoices`,
 * `accounting_direct_costs`, `accounting_pl_lines`, `pulse_master_sync_configs`)
 * and maintains DataChgAlert + ScriptProperties state without touching master_sheet_grids
 * when a tenant runs in `connector_pull_mode = 'native'`.
 */

import { getSupabaseAdmin } from "./supabaseClient.js";
import { resolveBrokerTokenInProcess, formatGasDate } from "./gasRuntime/gasEnvironment.js";
import { dateToSerial, serialToDate } from "./gasRuntime/sheetValueUtils.js";
import { compactGrid2D } from "./gasRuntime/masterFormulaEngine.js";
import {
  parseInvFromAppGrid,
  parseJnlsFromAppGrid,
  parsePLTabGrid,
  projectAccountingInvoicesToGrid,
  projectDirectCostsToGrid,
  projectPLLinesToGrid,
  preloadClientRelationalMasterBundle,
  invalidateClientRelationalMasterCache,
  reconcileClientMasterIngestionFromGrids,
} from "./relationalMasterService.js";
import {
  saveVirtualTabGrid_,
  getOrLoadVirtualTabGrid_,
} from "./masterEngineService.js";
import { computeAndPersistNativeMasterComparisons } from "./nativeMasterComparisonService.js";
import {
  sanitizeSheetCell_,
  sanitizeSheetMatrix_,
  normalizeDateToYmd_,
  formatLogDate_,
  formatLogAmount_,
  valuesAreDifferent_,
  assertValidQBRealmId,
  connectorFetch,
  fetchQuickBooksWithRetry_,
  fetchXeroWithRetry_,
  applySlotReuseDeltaGrid,
  patchGrid2DCell,
  readKeyInfoCellRaw,
  readKeyInfoDateCell,
  loadConnectorContextState,
  saveConnectorConfigPatch,
  persistConnectorScriptProperties,
  stampMasterCompTimestamp,
  normalizeVirtualMasterGrid,
  defaultSleepMs,
} from "./nativeConnectorUtils.js";

// ============================================================================
// SHARED CONSTANTS & HELPERS (100% VERBATIM 1_Core_and_Xero.gs & 7_Cost_Sync.gs)
// ============================================================================

export const NATIVE_INVOICE_DEFAULT_HEADERS = [
  "InvoiceID",
  "ContactName",
  "InvoiceNumber",
  "Reference",
  "Type",
  "Date",
  "DueDate",
  "Status",
  "AmountDue",
  "AmountPaid",
  "Total",
  "FullyPaidOnDate",
  "SentToContact",
  "SubTotal",
  "TotalTax",
  "CurrencyCode",
  "CurrencyRate",
  "RechargedAmount",
  "LineBreakdown",
];

export const INVOICE_LOG_HEADERS_MAP = [
  "Invoice ID",
  "Client Name",
  "Invoice Number",
  "Description",
  "Type",
  "Sent Date",
  "Due Date",
  "Status",
  "Amount Due",
  "Amount Paid",
  "Total",
  "Fully Paid Date",
  "Sent To Contact",
  "SubTotal (Excl VAT)",
  "Total Tax (VAT)",
  "Currency",
  "Currency Rate",
  "Recharged Amount",
  "Line Breakdown",
];

const INV_TEXT_COLS = new Set([0, 2, 3, 18]);

export const NATIVE_COST_CONFIG = {
  TARGET_SHEET_NAME: "JnlsFromApp",
  HISTORY_MONTHS: 13,
  HEADERS: [
    "Date",
    "Description",
    "Net (Excl VAT)",
    "VAT",
    "Gross (Incl VAT)",
    "Reference",
    "Account Name",
    "Status",
    "Transaction ID",
    "Date Paid",
    "Currency Code",
    "Currency Rate",
    "Amount Due",
    "Amount Paid",
    "Due Date",
  ],
};

const COST_TEXT_COLS = new Set([0, 1, 5, 6, 7, 8, 10]);

function normalizeAccountingToolName_(rawTool) {
  const s = String(rawTool || "").trim().toLowerCase();
  if (s === "quickbooks" || s === "qb" || s.includes("quickbook") || s === "qbo") {
    return "quickbooks";
  }
  if (s === "xero") return "xero";
  return s || "";
}

function round2_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseDateSafe_(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "number" && raw > 20000 && raw < 70000) {
    return serialToDate(raw);
  }
  const s = String(raw).trim();
  if (!s) return null;
  const xeroMatch = s.match(/\/Date\((-?\d+)/);
  if (xeroMatch) {
    const ms = parseInt(xeroMatch[1], 10);
    if (!isNaN(ms)) return new Date(ms);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateYmdTz_(dateObj, timeZone = "Europe/London") {
  if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(dateObj);
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}

function formatDateUtcYmd_(dateObj) {
  if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) return "";
  const y = dateObj.getUTCFullYear();
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDateLocalYmd_(dateObj) {
  if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) return "";
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeTextCompare_(v) {
  return String(v === null || v === undefined ? "" : v).trim().toLowerCase();
}

/**
 * 100% verbatim port of classifyInvoiceRechargedLine_ (`1_Core_and_Xero.gs:294-319`).
 */
export function classifyInvoiceRechargedLine_({
  description,
  accountCode,
  accountName,
  accountType,
  accountClass,
  itemName,
  isLinkedExpense,
} = {}) {
  if (isLinkedExpense) {
    return { isRecharged: true, reason: "linked_expense" };
  }
  const acctOrItemText = `${String(accountName || "").trim()} ${String(itemName || "").trim()}`.trim();
  if (
    acctOrItemText &&
    /\b(recharg\w*|disbursement\w*|billable\s+expense\w*|reimburs\w*|pass[- ]?through|client\s+expense\w*|expense\s+recover\w*)\b/i.test(
      acctOrItemText
    )
  ) {
    return { isRecharged: true, reason: "account" };
  }
  const normClass = String(accountClass || "").trim().toUpperCase();
  const normType = String(accountType || "").trim().toUpperCase();
  if (
    normClass === "EXPENSE" ||
    normType === "DIRECTCOSTS" ||
    normType === "EXPENSE" ||
    normType === "OVERHEADS" ||
    normType === "COST OF GOODS SOLD" ||
    normType === "OTHER EXPENSE"
  ) {
    return { isRecharged: true, reason: "expense_account" };
  }
  const descText = String(description || "").trim();
  if (
    descText &&
    /\b(recharg\w*|disbursement\w*|reimburs\w*|billable\s+expense\w*|client\s+expense\w*|out[- ]of[- ]pocket|pass[- ]?through|expenses?\s*[:\-]|travel\s*(?:&|and)?\s*(?:subsistence|hotel|accommodation|expenses?)|hotel\s+expenses?|mileage|flights?|train\s+(?:ticket|fare)s?|courier|postage|subsistence)\b/i.test(
      descText
    )
  ) {
    return { isRecharged: true, reason: "description" };
  }
  return { isRecharged: false, reason: "" };
}

/**
 * 100% verbatim port of summarizeInvoiceLineBreakdown_ (`1_Core_and_Xero.gs:325-350`).
 */
export function summarizeInvoiceLineBreakdown_(lineEntries = []) {
  if (!Array.isArray(lineEntries) || lineEntries.length === 0) {
    return { rechargedAmount: 0, lineBreakdownJson: "" };
  }
  let rechargedSum = 0;
  const compact = lineEntries.slice(0, 25).map((e) => {
    const netAmt = Math.round((Number(e?.netAmount) || 0) * 100) / 100;
    const isRech = Boolean(e?.isRecharged);
    if (isRech && netAmt > 0) {
      rechargedSum += netAmt;
    }
    const row = {
      d: String(e?.description || "").trim().slice(0, 120),
      a: netAmt,
      ac: String(e?.accountCode || "").trim().slice(0, 30),
      an: String(e?.accountName || "").trim().slice(0, 60),
      r: isRech ? 1 : 0,
    };
    if (e?.reason) row.rr = String(e.reason);
    return row;
  });
  return {
    rechargedAmount: Math.max(0, Math.round(rechargedSum * 100) / 100),
    lineBreakdownJson: JSON.stringify(compact),
  };
}

/**
 * 100% verbatim port of getLatestInvoicePaymentDate_ (`1_Core_and_Xero.gs:469-517`).
 */
function getLatestInvoicePaymentDate_(inv) {
  if (inv?.FullyPaidOnDate) return inv.FullyPaidOnDate;

  const parseEpoch = (raw) => {
    if (!raw) return 0;
    const match = String(raw).match(/\/Date\((\d+)/);
    if (match) return parseInt(match[1], 10);
    const d = new Date(raw);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  };

  let latestDateRaw = "";
  let latestMs = 0;

  if (Array.isArray(inv?.Payments)) {
    inv.Payments.forEach((p) => {
      if (p.Status === "DELETED") return;
      const ms = parseEpoch(p.Date);
      if (ms > latestMs) {
        latestMs = ms;
        latestDateRaw = p.Date;
      }
    });
  }

  if (Array.isArray(inv?.CreditNotes)) {
    inv.CreditNotes.forEach((cn) => {
      const ms = parseEpoch(cn.AppliedDate || cn.Date);
      if (ms > latestMs) {
        latestMs = ms;
        latestDateRaw = cn.AppliedDate || cn.Date;
      }
    });
  }

  const otherAllocations = [...(inv?.Prepayments || []), ...(inv?.Overpayments || [])];
  otherAllocations.forEach((alloc) => {
    const ms = parseEpoch(alloc.AppliedDate || alloc.Date);
    if (ms > latestMs) {
      latestMs = ms;
      latestDateRaw = alloc.AppliedDate || alloc.Date;
    }
  });

  return latestDateRaw;
}

// ============================================================================
// SUPABASE CHUNK UPSERT / STALE CLEANUP / AUTH HELPERS
// ============================================================================

async function upsertRowsInChunks_(supabase, table, rows, onConflict) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 250) {
    const chunk = rows.slice(i, i + 250);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) {
      throw new Error(`${table} upsert failed: ${error.message}`);
    }
  }
}

async function fetchAllClientIdsRows_(supabase, table, selectCols, clientId, extraEq = {}) {
  const all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase
      .from(table)
      .select(selectCols)
      .eq("client_id", clientId)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    for (const [k, v] of Object.entries(extraEq)) {
      q = q.eq(k, v);
    }
    const { data, error } = await q;
    if (error) throw new Error(`${table} select failed: ${error.message}`);
    const batch = Array.isArray(data) ? data : [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function stampDataChgAlertInConfig_(ctx, cellA1Pair) {
  const state = await loadConnectorContextState(ctx);
  let alertGrid = state.dataChgAlertGrid.length > 0 ? state.dataChgAlertGrid : [[]];
  for (const { row1, col1, val } of cellA1Pair) {
    const writeVal = val instanceof Date ? dateToSerial(val) : val;
    alertGrid = patchGrid2DCell(alertGrid, row1, col1, writeVal);
  }
  await saveConnectorConfigPatch(ctx, { data_chg_alert_grid: alertGrid });
  if (ctx?.connectorPullMode !== "native") {
    await saveVirtualTabGrid_(ctx, "master", "DataChgAlert", alertGrid, alertGrid, {}).catch(() => { });
  }
}

async function resolveAccountingAuth_(ctx, keyInfoGrid, tool, tokenOverride = null) {
  const cellCoord = tool === "quickbooks" ? "X3" : "X2";
  const row1 = tool === "quickbooks" ? 3 : 2;
  const col1 = 24; // X = 24

  if (tokenOverride && typeof tokenOverride === "object" && tokenOverride.accessToken) {
    const rawId = String(readKeyInfoCellRaw(keyInfoGrid, cellCoord, "")).trim();
    const resolvedId = String(
      rawId ||
      (tool === "quickbooks"
        ? tokenOverride.realmId || tokenOverride.tenantId || ""
        : tokenOverride.tenantId || tokenOverride.realmId || "")
    ).trim();
    return {
      accessToken: tokenOverride.accessToken,
      tenantOrRealmId: resolvedId,
      healedCellCoord: !rawId && resolvedId ? { row1, col1, val: resolvedId } : null,
    };
  }

  const brokerRes = await resolveBrokerTokenInProcess(ctx, tool);
  if (!brokerRes || brokerRes.status !== 200 || !brokerRes.body?.accessToken) {
    const errMsg = brokerRes?.body?.error || `Failed to obtain ${tool} token from Pulse Vault.`;
    const err = new Error(errMsg);
    err.reconnectRequired = Boolean(brokerRes?.body?.reconnectRequired);
    throw err;
  }

  const rawId = String(readKeyInfoCellRaw(keyInfoGrid, cellCoord, "")).trim();
  const brokerId = String(
    tool === "quickbooks"
      ? brokerRes.body.realmId || brokerRes.body.tenantId || ""
      : brokerRes.body.tenantId || brokerRes.body.realmId || ""
  ).trim();
  const tenantOrRealmId = rawId || brokerId;

  return {
    accessToken: brokerRes.body.accessToken,
    tenantOrRealmId,
    healedCellCoord: !rawId && tenantOrRealmId ? { row1, col1, val: tenantOrRealmId } : null,
  };
}

// ============================================================================
// INVOICE DELTA LOG FORMATTING (100% VERBATIM 1_Core_and_Xero.gs:930-1005)
// ============================================================================

function formatNewInvoiceLogEntry_(row, tz = "Europe/London") {
  const invNum = String(row[2] || "N/A").trim();
  const clientName = String(row[1] || "Unknown Client").trim();
  const desc = String(row[3] || "No description").trim();
  const subTotal = parseFloat(row[13]) || 0;
  const tax = parseFloat(row[14]) || 0;
  const vatMark = tax > 0 ? " +VAT" : "";
  const sentDate = formatLogDate_(row[5], tz);
  const dueDate = formatLogDate_(row[6], tz);
  const amtStr = formatLogAmount_(subTotal);
  return `Inv #${invNum} (${clientName} | ${desc}) - Amount: £${amtStr}${vatMark} | Sent: ${sentDate || "N/A"} | Due: ${dueDate || "N/A"}`;
}

function getInvoiceFieldChanges_(oldRow, newRow, headersMap = INVOICE_LOG_HEADERS_MAP, tz = "Europe/London") {
  const changes = [];
  const maxCols = Math.max(oldRow.length, newRow.length);
  for (let c = 1; c < maxCols; c++) {
    // Skip LineBreakdown JSON metadata column (col 19 / index 18) from AutoLog noise
    if (c === 18) continue;
    const oldVal = oldRow[c];
    const newVal = newRow[c];

    // Dates: Sent Date (5), Due Date (6), Fully Paid Date (11)
    if (c === 5 || c === 6 || c === 11) {
      const oldYmd = normalizeDateToYmd_(oldVal, tz);
      const newYmd = normalizeDateToYmd_(newVal, tz);
      if (oldYmd === newYmd) continue;
      const headerName = headersMap[c] || `Col ${c}`;
      const oldFormatted = formatLogDate_(oldVal, tz) || (oldVal ? String(oldVal) : "Blank");
      const newFormatted = formatLogDate_(newVal, tz) || (newVal ? String(newVal) : "Blank");
      if (oldFormatted !== newFormatted) {
        changes.push(`${headerName}: '${oldFormatted}' -> '${newFormatted}'`);
      }
      continue;
    }

    // Amounts: Amount Due (8), Amount Paid (9), Total (10), SubTotal (13), Total Tax (14), Recharged Amount (17)
    if (c === 8 || c === 9 || c === 10 || c === 13 || c === 14 || c === 17) {
      let cleanOld = oldVal;
      if (cleanOld instanceof Date) {
        const epochZero = new Date(1899, 11, 30).getTime();
        cleanOld = Math.round(((cleanOld.getTime() - epochZero) / 86400000) * 100) / 100;
      }
      let cleanNew = newVal;
      if (cleanNew instanceof Date) {
        const epochZero = new Date(1899, 11, 30).getTime();
        cleanNew = Math.round(((cleanNew.getTime() - epochZero) / 86400000) * 100) / 100;
      }
      const n1 = cleanOld === null || cleanOld === undefined || cleanOld === "" ? 0 : Number(cleanOld);
      const n2 = cleanNew === null || cleanNew === undefined || cleanNew === "" ? 0 : Number(cleanNew);
      if (!isNaN(n1) && !isNaN(n2) && Math.abs(n1 - n2) < 0.005) continue;
      const headerName = headersMap[c] || `Col ${c}`;
      const oldFormatted = formatLogAmount_(cleanOld);
      const newFormatted = formatLogAmount_(cleanNew);
      if (oldFormatted !== newFormatted) {
        changes.push(`${headerName}: '${oldFormatted}' -> '${newFormatted}'`);
      }
      continue;
    }

    const stripFormulaEscape = (v) => (typeof v === "string" && /^'[=+\-@]/.test(v) ? v.slice(1) : v);
    const cmpOld = stripFormulaEscape(oldVal);
    const cmpNew = stripFormulaEscape(newVal);
    if (valuesAreDifferent_(cmpOld, cmpNew)) {
      const headerName = headersMap[c] || `Col ${c}`;
      const oldFormatted =
        cmpOld === null || cmpOld === undefined || String(cmpOld).trim() === "" ? "Blank" : String(cmpOld).trim();
      const newFormatted =
        cmpNew === null || cmpNew === undefined || String(cmpNew).trim() === "" ? "Blank" : String(cmpNew).trim();
      if (oldFormatted !== newFormatted) {
        changes.push(`${headerName}: '${oldFormatted}' -> '${newFormatted}'`);
      }
    }
  }
  return changes;
}

function compareInvoiceRowsEqual_(oldRowRead, newRowRaw) {
  const changes = getInvoiceFieldChanges_(oldRowRead, newRowRaw, INVOICE_LOG_HEADERS_MAP, "Europe/London");
  const oldBk = String(oldRowRead?.[18] || "").replace(/^'/, "").trim();
  const newBk = String(newRowRaw?.[18] || "").replace(/^'/, "").trim();
  return changes.length === 0 && oldBk === newBk;
}

// ============================================================================
// XERO & QUICKBOOKS INVOICE PULLS (100% VERBATIM)
// ============================================================================

async function fetchXeroInvoicesRows_({
  accessToken,
  tenantId,
  importMode,
  cutoffDate,
  fetchImpl,
  sleepImpl,
}) {
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const baseUrl = "https://api.xero.com/api.xro/2.0/Invoices?where=Type%3d%3d%22ACCREC%22&order=Date%20DESC";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "xero-tenant-id": tenantId,
    Accept: "application/json",
  };

  // Non-fatal Chart of Accounts fetch to classify recharged expense line items
  const xeroAccountMap = Object.create(null);
  try {
    const acctRes = await fetchXeroWithRetry_(
      "https://api.xero.com/api.xro/2.0/Accounts",
      { headers },
      { label: "Xero Chart of Accounts", fetchImpl, sleepImpl: sleeper }
    );
    if (acctRes.ok && Array.isArray(acctRes.json?.Accounts)) {
      for (const acc of acctRes.json.Accounts) {
        const code = String(acc?.Code || "").trim();
        if (code) {
          xeroAccountMap[code] = {
            name: acc.Name || "",
            type: String(acc.Type || "").toUpperCase(),
            class: String(acc.Class || "").toUpperCase(),
          };
        }
      }
    }
  } catch {
    // Non-fatal
  }

  let allInvoices = [];
  let page = 1;
  let keepFetching = true;
  while (keepFetching) {
    if (page > 1) await sleeper(350);
    const res = await fetchXeroWithRetry_(
      `${baseUrl}&page=${page}`,
      { headers },
      { label: `Xero ACCREC Invoices p${page}`, fetchImpl, sleepImpl: sleeper }
    );
    if (!res.ok) {
      throw new Error(`Xero API Error on Page ${page}: ${res.text || res.status}`);
    }
    const pageInvoices = Array.isArray(res.json?.Invoices) ? res.json.Invoices : [];
    if (pageInvoices.length > 0) {
      allInvoices = allInvoices.concat(pageInvoices);
      const last = pageInvoices[pageInvoices.length - 1];
      const lastInvDate = new Date(last.DateString || last.Date);
      if (lastInvDate < cutoffDate || pageInvoices.length < 100) keepFetching = false;
      else page++;
    } else {
      keepFetching = false;
    }
    if (keepFetching && page > 200) {
      throw new Error("Xero invoice pagination exceeded 200-page safety limit; aborting sync to prevent partial truncation.");
    }
  }

  const invoices = allInvoices.filter((inv) => {
    const invDate = new Date(inv.DateString || inv.Date);
    return !(invDate < cutoffDate);
  });

  const getEffectiveValues = (inv) => {
    const originalTotal = parseFloat(inv.Total) || 0;
    const credit = parseFloat(inv.AmountCredited) || 0;
    const effectiveTotal = originalTotal - credit;
    const ratio = originalTotal > 0 ? effectiveTotal / originalTotal : 1;
    return {
      total: effectiveTotal,
      subTotal: (parseFloat(inv.SubTotal) || 0) * ratio,
      tax: (parseFloat(inv.TotalTax) || 0) * ratio,
      ratio,
    };
  };

  const buildXeroLineEntries = (inv, eff) => {
    if (!Array.isArray(inv.LineItems) || inv.LineItems.length === 0) return [];
    const type = String(inv.LineAmountTypes || "Exclusive").toUpperCase();
    return inv.LineItems.map((line) => {
      const rawLineAmt = parseFloat(line.LineAmount) || 0;
      const rawLineTax = parseFloat(line.TaxAmount) || 0;
      const effectiveLineAmt = rawLineAmt * eff.ratio;
      const effectiveLineTax = rawLineTax * eff.ratio;
      const lineSubTotal = type === "INCLUSIVE" ? effectiveLineAmt - effectiveLineTax : effectiveLineAmt;
      const acctCode = String(line.AccountCode || "").trim();
      const acctMeta = acctCode ? xeroAccountMap[acctCode] : null;
      const cls = classifyInvoiceRechargedLine_({
        description: line.Description || "",
        accountCode: acctCode,
        accountName: acctMeta?.name || "",
        accountType: acctMeta?.type || "",
        accountClass: acctMeta?.class || "",
        itemName: line.Item?.Name || line.ItemCode || "",
        isLinkedExpense: false,
      });
      return {
        description: line.Description || "",
        netAmount: lineSubTotal,
        accountCode: acctCode,
        accountName: acctMeta?.name || "",
        isRecharged: cls.isRecharged,
        reason: cls.reason,
      };
    });
  };

  const mappedData = [];

  if (importMode === "Lines") {
    for (const inv of invoices) {
      const isPaid = inv.Status === "PAID";
      const parentRef = inv.Reference || "";
      const eff = getEffectiveValues(inv);
      const lineEntries = buildXeroLineEntries(inv, eff);
      const cashPaid = parseFloat(inv.AmountPaid) || 0;
      const currentBalance = Math.max(0, Math.round((eff.total - cashPaid) * 100) / 100);

      if (Array.isArray(inv.LineItems) && inv.LineItems.length > 0) {
        const type = String(inv.LineAmountTypes || "Exclusive").toUpperCase();
        const rawLineFinancials = inv.LineItems.map((line) => {
          const rawLineAmt = line.LineAmount || 0;
          const rawLineTax = line.TaxAmount || 0;
          const effectiveLineAmt = rawLineAmt * eff.ratio;
          const effectiveLineTax = rawLineTax * eff.ratio;
          let lineTotal = 0;
          let lineSubTotal = 0;
          if (type === "INCLUSIVE") {
            lineTotal = effectiveLineAmt;
            lineSubTotal = effectiveLineAmt - effectiveLineTax;
          } else {
            lineSubTotal = effectiveLineAmt;
            lineTotal = effectiveLineAmt + effectiveLineTax;
          }
          return {
            lineTotal: Math.round(lineTotal * 100) / 100,
            lineSubTotal,
            effectiveLineTax,
          };
        });

        const rawLinePaids = rawLineFinancials.map((fin) => {
          if (isPaid || currentBalance <= 0.005) return fin.lineTotal;
          if (cashPaid <= 0.005) return 0;
          const lineRatio = eff.total > 0 ? fin.lineTotal / eff.total : 1 / inv.LineItems.length;
          return Math.round(cashPaid * lineRatio * 100) / 100;
        });

        if (!isPaid && currentBalance > 0.005 && cashPaid > 0.005 && inv.LineItems.length > 0) {
          const sumLinePaids = rawLinePaids.reduce((s, p) => s + p, 0);
          const paidDiff = Math.round((cashPaid - sumLinePaids) * 100) / 100;
          if (Math.abs(paidDiff) > 0 && Math.abs(paidDiff) <= 0.05) {
            let maxIdx = 0;
            for (let li = 1; li < rawLinePaids.length; li++) {
              if (rawLinePaids[li] > rawLinePaids[maxIdx]) maxIdx = li;
            }
            if (rawLinePaids[maxIdx] + paidDiff >= 0) {
              rawLinePaids[maxIdx] = Math.round((rawLinePaids[maxIdx] + paidDiff) * 100) / 100;
            }
          }
        }

        inv.LineItems.forEach((line, index) => {
          const lineId = `${inv.InvoiceID}-${index + 1}`;
          const lineInvNumber = `${inv.InvoiceNumber}-${index + 1}`;
          const lineDesc = line.Description || "";
          const combinedRef = [parentRef, lineDesc].filter(Boolean).join(" - ");
          const fin = rawLineFinancials[index];
          const lineAmountPaid = rawLinePaids[index];
          const lineAmountDue = Math.max(0, Math.round((fin.lineTotal - lineAmountPaid) * 100) / 100);
          const linePaidDate = getLatestInvoicePaymentDate_(inv);
          const lineSummary = summarizeInvoiceLineBreakdown_(lineEntries[index] ? [lineEntries[index]] : []);

          mappedData.push([
            lineId,
            inv.Contact?.Name,
            lineInvNumber,
            combinedRef,
            inv.Type,
            inv.DateString,
            inv.DueDateString,
            inv.Status,
            lineAmountDue,
            lineAmountPaid,
            fin.lineTotal,
            linePaidDate,
            inv.SentToContact,
            fin.lineSubTotal,
            fin.effectiveLineTax,
            inv.CurrencyCode,
            inv.CurrencyRate,
            lineSummary.rechargedAmount,
            lineSummary.lineBreakdownJson,
          ]);
        });
      }
    }
  } else {
    for (const invoice of invoices) {
      const eff = getEffectiveValues(invoice);
      const lineSummary = summarizeInvoiceLineBreakdown_(buildXeroLineEntries(invoice, eff));
      const cashPaid = parseFloat(invoice.AmountPaid) || 0;
      const newBalance = eff.total - cashPaid;
      const invoicePaidDate = getLatestInvoicePaymentDate_(invoice);

      mappedData.push([
        invoice.InvoiceID,
        invoice.Contact?.Name,
        invoice.InvoiceNumber,
        invoice.Reference,
        invoice.Type,
        invoice.DateString,
        invoice.DueDateString,
        invoice.Status,
        newBalance,
        cashPaid,
        eff.total,
        invoicePaidDate,
        invoice.SentToContact,
        eff.subTotal,
        eff.tax,
        invoice.CurrencyCode,
        invoice.CurrencyRate,
        lineSummary.rechargedAmount,
        lineSummary.lineBreakdownJson,
      ]);
    }
  }

  return mappedData;
}

async function fetchQBTaxCodeRateMap_({ accessToken, realmId, fetchImpl }) {
  assertValidQBRealmId(realmId);
  const map = Object.create(null);
  const baseUrl = "https://quickbooks.api.intuit.com";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  try {
    const query = encodeURIComponent("SELECT * FROM TaxCode MAXRESULTS 100");
    const res = await connectorFetch(`${baseUrl}/v3/company/${realmId}/query?query=${query}`, {
      headers,
      fetchImpl,
    });
    if (res.ok) {
      const taxCodes = res.json?.QueryResponse?.TaxCode || [];
      for (const tc of taxCodes) {
        const id = String(tc?.Id || "").trim();
        const name = String(tc?.Name || "").trim().toLowerCase();
        const desc = String(tc?.Description || "").trim().toLowerCase();
        let rate = null;

        let searchString = `${tc?.Name || ""} ${desc}`;
        if (Array.isArray(tc?.SalesTaxRateList?.TaxRateDetail)) {
          for (const detail of tc.SalesTaxRateList.TaxRateDetail) {
            if (detail?.TaxRateRef?.name) searchString += ` ${detail.TaxRateRef.name}`;
          }
        }

        const pctMatch = searchString.match(/(\d+(?:\.\d+)?)%/);
        if (pctMatch) {
          rate = parseFloat(pctMatch[1]) / 100;
        } else if (
          tc?.Taxable === false ||
          name === "non" ||
          name === "no vat" ||
          name.includes("no vat") ||
          name.includes("exempt") ||
          name.includes("zero") ||
          desc.includes("exempt") ||
          desc.includes("no vat")
        ) {
          rate = 0;
        } else if (
          name === "tax" ||
          name === "standard" ||
          name === "standard rate" ||
          name === "standard vat" ||
          desc.includes("standard")
        ) {
          rate = 0.2;
        }

        if (id && rate !== null) {
          map[id] = rate;
        }
      }
    }
  } catch {
    // Non-fatal
  }
  return map;
}

async function fetchQuickBooksPaymentDates_({ paymentIds, accessToken, realmId, fetchImpl, sleepImpl }) {
  const dateMap = new Map();
  const uniqueIds = Array.from(new Set(paymentIds || []));
  if (uniqueIds.length === 0) return dateMap;
  const safeRealmId = assertValidQBRealmId(realmId);
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const baseUrl = "https://quickbooks.api.intuit.com";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  for (let i = 0; i < uniqueIds.length; i += 30) {
    const batch = uniqueIds.slice(i, i + 30);
    const idList = batch.map((id) => `'${String(id).replace(/[^0-9a-zA-Z_-]/g, "")}'`).join(",");
    const query = encodeURIComponent(`SELECT Id, TxnDate FROM Payment WHERE Id IN (${idList})`);
    const res = await fetchQuickBooksWithRetry_(
      `${baseUrl}/v3/company/${safeRealmId}/query?query=${query}`,
      { headers, fetchImpl, sleepImpl: sleeper },
      { label: "QB Invoices Query", fetchImpl, sleepImpl: sleeper }
    );
    if (res.ok) {
      const payments = res.json?.QueryResponse?.Payment || [];
      for (const p of payments) {
        if (p?.Id && p?.TxnDate) dateMap.set(p.Id, p.TxnDate);
      }
    }
    if (i + 30 < uniqueIds.length) await sleeper(100);
  }
  return dateMap;
}

async function fetchQuickBooksInvoicesRows_({
  accessToken,
  realmId,
  importMode,
  cutoffDate,
  nowDate,
  fetchImpl,
  sleepImpl,
}) {
  const safeRealmId = assertValidQBRealmId(realmId);
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const baseUrl = "https://quickbooks.api.intuit.com";
  const dateStr = formatDateUtcYmd_(cutoffDate);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  let allInvoices = [];
  let startPosition = 1;
  const pageSize = 500;
  while (true) {
    const query = encodeURIComponent(
      `SELECT * FROM Invoice WHERE TxnDate >= '${dateStr}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    const res = await fetchQuickBooksWithRetry_(
      `${baseUrl}/v3/company/${safeRealmId}/query?query=${query}`,
      { headers, fetchImpl, sleepImpl: sleeper },
      { label: "QB Invoices Query", fetchImpl, sleepImpl: sleeper }
    );
    if (!res.ok) {
      throw new Error(`API request failed: ${res.text || res.status}`);
    }
    const invoicesOnPage = res.json?.QueryResponse?.Invoice;
    if (Array.isArray(invoicesOnPage) && invoicesOnPage.length > 0) {
      allInvoices = allInvoices.concat(invoicesOnPage);
      startPosition += invoicesOnPage.length;
      if (invoicesOnPage.length < pageSize) break;
    } else {
      break;
    }
    await sleeper(200);
  }

  if (allInvoices.length === 0) {
    return [];
  }

  const paymentIdsToFetch = [];
  for (const inv of allInvoices) {
    if (Array.isArray(inv?.LinkedTxn)) {
      for (const txn of inv.LinkedTxn) {
        if (txn?.TxnType === "Payment" && txn?.TxnId) paymentIdsToFetch.push(txn.TxnId);
      }
    }
  }

  const paymentDateMap = await fetchQuickBooksPaymentDates_({
    paymentIds: paymentIdsToFetch,
    accessToken,
    realmId: safeRealmId,
    fetchImpl,
    sleepImpl: sleeper,
  });

  const taxCodeRateMap =
    importMode === "Lines"
      ? await fetchQBTaxCodeRateMap_({ accessToken, realmId: safeRealmId, fetchImpl })
      : {};

  const qbAccountMap = Object.create(null);
  const qbItemMap = Object.create(null);
  try {
    const acctRes = await connectorFetch(
      `${baseUrl}/v3/company/${safeRealmId}/query?query=${encodeURIComponent("SELECT * FROM Account MAXRESULTS 1000")}`,
      { headers, fetchImpl }
    );
    if (acctRes.ok) {
      for (const a of acctRes.json?.QueryResponse?.Account || []) {
        if (a?.Id) qbAccountMap[String(a.Id)] = a;
      }
    }
  } catch {
    // Non-fatal
  }
  try {
    const itemRes = await connectorFetch(
      `${baseUrl}/v3/company/${safeRealmId}/query?query=${encodeURIComponent("SELECT * FROM Item MAXRESULTS 1000")}`,
      { headers, fetchImpl }
    );
    if (itemRes.ok) {
      for (const it of itemRes.json?.QueryResponse?.Item || []) {
        if (it?.Id) qbItemMap[String(it.Id)] = it;
      }
    }
  } catch {
    // Non-fatal
  }

  const buildQBLineEntry = (line, ratioVal) => {
    const netAmount = Math.round((parseFloat(line.Amount) || 0) * ratioVal * 100) / 100;
    const itemRef = line.SalesItemLineDetail?.ItemRef || {};
    const itemObj = qbItemMap[String(itemRef.value || "")] || null;
    const acctId = String(line.SalesItemLineDetail?.ItemAccountRef?.value || itemObj?.IncomeAccountRef?.value || "");
    const acctObj = qbAccountMap[acctId] || null;
    const acctName =
      line.SalesItemLineDetail?.ItemAccountRef?.name || acctObj?.Name || itemObj?.IncomeAccountRef?.name || "";
    const isLinkedExpense =
      Array.isArray(line.LinkedTxn) &&
      line.LinkedTxn.some((t) => ["Purchase", "Bill", "Expense", "ReimburseCharge"].includes(String(t?.TxnType || "")));
    const descText = line.Description || itemRef.name || "";
    const cls = classifyInvoiceRechargedLine_({
      description: descText,
      accountCode: acctObj?.AcctNum || acctId,
      accountName: acctName,
      accountType: acctObj?.AccountType || "",
      accountClass: acctObj?.Classification || "",
      itemName: itemRef.name || "",
      isLinkedExpense,
    });
    return {
      description: descText,
      netAmount,
      accountCode: acctObj?.AcctNum || acctId,
      accountName: acctName,
      isRecharged: cls.isRecharged,
      reason: cls.reason,
    };
  };

  const todayMidnight = new Date(nowDate);
  todayMidnight.setHours(0, 0, 0, 0);

  const getStatus = (invoice) => {
    const balance = parseFloat(invoice.Balance);
    if (balance <= 0) return "PAID";
    const dueDate = new Date(invoice.DueDate);
    if (dueDate < todayMidnight) return "OVERDUE";
    return "AWAITING_PAYMENT";
  };

  const mappedData = [];

  for (const inv of allInvoices) {
    const originalTotal = parseFloat(inv.TotalAmt) || 0;
    let totalCredit = 0;
    if (Array.isArray(inv.LinkedTxn)) {
      for (const txn of inv.LinkedTxn) {
        if (txn.TxnType === "CreditMemo") totalCredit += parseFloat(txn.Amount) || 0;
      }
    }

    const effectiveTotal = originalTotal - totalCredit;
    const ratio = originalTotal > 0 ? effectiveTotal / originalTotal : 1;
    const originalTax = inv.TxnTaxDetail?.TotalTax || 0;
    const effectiveTax = originalTax * ratio;

    const status = getStatus(inv);
    const isPaid = status === "PAID";

    let fullyPaidDate = "";
    if (Array.isArray(inv.LinkedTxn)) {
      let latestDate = "";
      for (const txn of inv.LinkedTxn) {
        if (txn.TxnType === "Payment" && paymentDateMap.has(txn.TxnId)) {
          const pDate = paymentDateMap.get(txn.TxnId);
          if (pDate > latestDate) latestDate = pDate;
        }
      }
      fullyPaidDate = latestDate;
    }

    const currentBalance = Math.max(0, parseFloat(inv.Balance) || 0);
    const cashPaid = Math.max(0, Math.round((effectiveTotal - currentBalance) * 100) / 100);

    if (importMode === "Lines") {
      if (Array.isArray(inv.Line)) {
        const validLines = inv.Line.filter((l) => l.DetailType === "SalesItemLineDetail");
        const totalLineNet = validLines.reduce((sum, line) => sum + (line.Amount || 0), 0);

        let rawLineTaxes = validLines.map((line) => {
          if (effectiveTax === 0) return 0;
          const originalLineAmt = line.Amount || 0;
          const effectiveLineAmt = originalLineAmt * ratio;
          const taxCodeId = String(line.SalesItemLineDetail?.TaxCodeRef?.value || line.TaxCodeRef?.value || "").trim();
          if (taxCodeId && taxCodeRateMap && taxCodeRateMap[taxCodeId] !== undefined) {
            return Math.round(effectiveLineAmt * taxCodeRateMap[taxCodeId] * 100) / 100;
          }
          return totalLineNet > 0 ? (originalLineAmt / totalLineNet) * effectiveTax : 0;
        });

        const initialSum = rawLineTaxes.reduce((sum, t) => sum + t, 0);
        if (effectiveTax > 0 && initialSum === 0 && totalLineNet > 0) {
          rawLineTaxes = validLines.map((line) => ((line.Amount || 0) / totalLineNet) * effectiveTax);
        }

        const sumLineTaxes = rawLineTaxes.reduce((sum, t) => sum + t, 0);
        const taxDiff = Math.round((effectiveTax - sumLineTaxes) * 100) / 100;
        if (Math.abs(taxDiff) > 0 && Math.abs(taxDiff) <= 0.05 && validLines.length > 0) {
          let maxIdx = 0;
          for (let li = 1; li < rawLineTaxes.length; li++) {
            if (rawLineTaxes[li] > rawLineTaxes[maxIdx]) maxIdx = li;
          }
          if (rawLineTaxes[maxIdx] + taxDiff >= 0) {
            rawLineTaxes[maxIdx] = Math.round((rawLineTaxes[maxIdx] + taxDiff) * 100) / 100;
          }
        }

        const rawLineTotals = validLines.map((line, idx) => {
          const effectiveLineAmt = (line.Amount || 0) * ratio;
          const lineTax = rawLineTaxes[idx] || 0;
          return Math.round((effectiveLineAmt + lineTax) * 100) / 100;
        });

        const rawLinePaids = rawLineTotals.map((lineTotal) => {
          if (isPaid || currentBalance <= 0.005) return lineTotal;
          if (cashPaid <= 0.005) return 0;
          const lineRatio = effectiveTotal > 0 ? lineTotal / effectiveTotal : 1 / validLines.length;
          return Math.round(cashPaid * lineRatio * 100) / 100;
        });

        if (!isPaid && currentBalance > 0.005 && cashPaid > 0.005 && validLines.length > 0) {
          const sumLinePaids = rawLinePaids.reduce((sum, p) => sum + p, 0);
          const paidDiff = Math.round((cashPaid - sumLinePaids) * 100) / 100;
          if (Math.abs(paidDiff) > 0 && Math.abs(paidDiff) <= 0.05) {
            let maxIdx = 0;
            for (let li = 1; li < rawLinePaids.length; li++) {
              if (rawLinePaids[li] > rawLinePaids[maxIdx]) maxIdx = li;
            }
            if (rawLinePaids[maxIdx] + paidDiff >= 0) {
              rawLinePaids[maxIdx] = Math.round((rawLinePaids[maxIdx] + paidDiff) * 100) / 100;
            }
          }
        }

        validLines.forEach((line, index) => {
          const lineId = `${inv.Id}-${index + 1}`;
          const lineInvNumber = `${inv.DocNumber}-${index + 1}`;
          const parentRef = inv.PrivateNote || "";
          const lineDesc = line.Description || "";
          const combinedRef = [parentRef, lineDesc].filter(Boolean).join(" - ");
          const lineSubTotal = (line.Amount || 0) * ratio;
          const lineTax = rawLineTaxes[index] || 0;
          const lineTotal = rawLineTotals[index];
          const lineAmountPaid = rawLinePaids[index];
          const lineAmountDue = Math.max(0, Math.round((lineTotal - lineAmountPaid) * 100) / 100);
          const lineSummary = summarizeInvoiceLineBreakdown_([buildQBLineEntry(line, ratio)]);

          mappedData.push([
            lineId,
            inv.CustomerRef?.name || "N/A",
            lineInvNumber,
            combinedRef,
            "INVOICE",
            inv.TxnDate,
            inv.DueDate,
            status,
            lineAmountDue,
            lineAmountPaid,
            lineTotal,
            fullyPaidDate,
            inv.EmailStatus === "EmailSent",
            lineSubTotal,
            lineTax,
            inv.CurrencyRef?.value,
            inv.ExchangeRate || 1,
            lineSummary.rechargedAmount,
            lineSummary.lineBreakdownJson,
          ]);
        });
      }
    } else {
      const rawBal = parseFloat(inv.Balance) || 0;
      const wholeCashPaid = effectiveTotal - rawBal;
      const validWholeLines = Array.isArray(inv.Line)
        ? inv.Line.filter((l) => l.DetailType === "SalesItemLineDetail")
        : [];
      const wholeSummary = summarizeInvoiceLineBreakdown_(validWholeLines.map((l) => buildQBLineEntry(l, ratio)));

      mappedData.push([
        inv.Id,
        inv.CustomerRef?.name || "N/A",
        inv.DocNumber,
        inv.PrivateNote || "",
        "INVOICE",
        inv.TxnDate,
        inv.DueDate,
        status,
        rawBal,
        wholeCashPaid.toFixed(2),
        effectiveTotal,
        fullyPaidDate,
        inv.EmailStatus === "EmailSent",
        (effectiveTotal - effectiveTax).toFixed(2),
        effectiveTax,
        inv.CurrencyRef?.value,
        inv.ExchangeRate || 1,
        wholeSummary.rechargedAmount,
        wholeSummary.lineBreakdownJson,
      ]);
    }
  }

  return mappedData;
}

// ============================================================================
// PUBLIC ENGINE #1: NATIVE ACCOUNTING INVOICES PULL (`InvFromApp`)
// ============================================================================

export async function pullNativeAccountingInvoices(ctx, options = {}) {
  const {
    tokenOverride = null,
    fetchImpl = null,
    sleepImpl = null,
    persistToDb = true,
    keyInfoOverride = null,
    existingGridOverride = null,
    scriptPropsOverride = null,
    nowDate = new Date(),
  } = options;

  const state = await loadConnectorContextState(ctx, keyInfoOverride);
  let keyInfoGrid = state.keyInfoGrid;
  const scriptProps = scriptPropsOverride ? { ...scriptPropsOverride } : { ...state.scriptProps };

  const toolRaw = readKeyInfoCellRaw(keyInfoGrid, "Q4", "Xero");
  const tool = normalizeAccountingToolName_(toolRaw);
  const rawDate = readKeyInfoDateCell(keyInfoGrid, "B2");
  if (!rawDate) {
    return {
      success: false,
      newInvoices: [],
      updatedInvoices: [],
      dataChanged: false,
      lastError: "Cell B2 in KeyInfo must contain a valid date.",
    };
  }
  const cutoffDate = new Date(rawDate);
  cutoffDate.setMonth(cutoffDate.getMonth() - 12);

  const modeVal = readKeyInfoCellRaw(keyInfoGrid, "F8", "Whole");
  const importMode = String(modeVal).trim().toLowerCase() === "lines" ? "Lines" : "Whole";

  let auth;
  try {
    auth = await resolveAccountingAuth_(ctx, keyInfoGrid, tool, tokenOverride);
  } catch (err) {
    return {
      success: false,
      newInvoices: [],
      updatedInvoices: [],
      dataChanged: false,
      lastError: err.message || String(err),
      reconnectRequired: Boolean(err.reconnectRequired),
    };
  }

  if (!auth.tenantOrRealmId) {
    return {
      success: false,
      newInvoices: [],
      updatedInvoices: [],
      dataChanged: false,
      lastError: `Missing ${tool === "quickbooks" ? "Realm ID (KeyInfo!X3)" : "Tenant ID (KeyInfo!X2)"}.`,
    };
  }

  if (auth.healedCellCoord && persistToDb) {
    keyInfoGrid = patchGrid2DCell(
      keyInfoGrid,
      auth.healedCellCoord.row1,
      auth.healedCellCoord.col1,
      auth.healedCellCoord.val
    );
    await saveConnectorConfigPatch(ctx, { master_key_info_grid: keyInfoGrid });
  }

  let rawMappedData = [];
  if (tool === "quickbooks") {
    rawMappedData = await fetchQuickBooksInvoicesRows_({
      accessToken: auth.accessToken,
      realmId: auth.tenantOrRealmId,
      importMode,
      cutoffDate,
      nowDate,
      fetchImpl,
      sleepImpl,
    });
  } else {
    rawMappedData = await fetchXeroInvoicesRows_({
      accessToken: auth.accessToken,
      tenantId: auth.tenantOrRealmId,
      importMode,
      cutoffDate,
      fetchImpl,
      sleepImpl,
    });
  }

  // Matches writeToGoogleSheet (`1_Core_and_Xero.gs:747`)
  const finalData = sanitizeSheetMatrix_(rawMappedData);

  // Load existing InvFromApp virtual grid from Postgres (or override / virtual sheet)
  let existingGrid = Array.isArray(existingGridOverride) ? existingGridOverride : null;
  if (!existingGrid) {
    if (ctx?.connectorPullMode === "native") {
      const bundle = await preloadClientRelationalMasterBundle(ctx, { source: "db" }).catch(() => null);
      if (bundle) {
        const invRows = (bundle.accountingInvoices || []).filter(
          (r) => String(r.record_kind || "invoice") === "invoice"
        );
        const savedHeaders =
          Array.isArray(bundle.config?.inv_headers) &&
            bundle.config.inv_headers.length > 0
            ? bundle.config.inv_headers
            : NATIVE_INVOICE_DEFAULT_HEADERS;
        existingGrid = projectAccountingInvoicesToGrid({
          headers: savedHeaders,
          records: invRows,
          recordKind: "invoice",
        });
      }
    }
    if (!existingGrid) {
      const rec = await getOrLoadVirtualTabGrid_(ctx, "master", "InvFromApp", null).catch(() => null);
      existingGrid = Array.isArray(rec?.values_grid) ? rec.values_grid : [];
    }
  }

  const existingInvCount = Math.max(0, (Array.isArray(existingGrid) ? existingGrid.length : 0) - 1);
  if (existingInvCount >= 10 && finalData.length === 0 && !options.allowEmptyWipe) {
    throw new Error(
      `Accounting invoice pull returned 0 invoices against ${existingInvCount} existing rows; aborting to prevent wiping accounting_invoices.`
    );
  }

  const lastMode = scriptProps.INV_LAST_IMPORT_MODE ?? null;
  const lastRow = existingGrid.length;
  const needsModeOverwrite = lastMode !== importMode || lastRow <= 1;

  const newInvoices = [];
  const updatedInvoices = [];

  const headerSelfHealFn = (hdrRow) => {
    const out = [...hdrRow];
    while (out.length < 19) out.push("");
    if (!String(out[17] || "").trim() || !String(out[18] || "").trim()) {
      out[17] = "RechargedAmount";
      out[18] = "LineBreakdown";
    }
    return out;
  };

  const { nextGrid, dataChanged } = applySlotReuseDeltaGrid({
    existingGrid,
    headers: NATIVE_INVOICE_DEFAULT_HEADERS,
    incomingRows: finalData,
    textColsSet: INV_TEXT_COLS,
    tabName: "InvFromApp",
    idColIdx: 0,
    forceFullOverwrite: needsModeOverwrite,
    preserveExistingHeadersIfPresent: true,
    headerSelfHealFn,
    compareRowsEqualFn: compareInvoiceRowsEqual_,
    onNewRow: (row) => {
      newInvoices.push(formatNewInvoiceLogEntry_(row, state.timeZone));
    },
    onUpdatedRow: (oldRowRead, newRowRaw) => {
      const changes = getInvoiceFieldChanges_(oldRowRead, newRowRaw, INVOICE_LOG_HEADERS_MAP, state.timeZone);
      if (changes.length > 0) {
        const invNum = String(newRowRaw[2] || oldRowRead[2] || "N/A").trim();
        const cName = String(newRowRaw[1] || oldRowRead[1] || "Unknown Client").trim();
        const desc = String(newRowRaw[3] || oldRowRead[3] || "No description").trim();
        updatedInvoices.push(`Inv #${invNum} (${cName} | ${desc}) - ${changes.join(", ")}`);
      }
    },
  });

  if (persistToDb && ctx?.clientId) {
    const supabase = getSupabaseAdmin();
    if (supabase) {
      const parsedInv = parseInvFromAppGrid({
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        grid: nextGrid,
      });
      await upsertRowsInChunks_(
        supabase,
        "accounting_invoices",
        parsedInv.rows,
        "client_id,record_kind,sheet_row_num"
      );
      const keepNums = new Set(parsedInv.rows.map((r) => Number(r.sheet_row_num)));
      const existingRows = await fetchAllClientIdsRows_(
        supabase,
        "accounting_invoices",
        "id, sheet_row_num",
        ctx.clientId,
        { record_kind: "invoice" }
      );
      const staleIds = existingRows
        .filter((r) => !keepNums.has(Number(r.sheet_row_num)))
        .map((r) => r.id);
      for (let i = 0; i < staleIds.length; i += 200) {
        const { error: delErr } = await supabase.from("accounting_invoices").delete().in("id", staleIds.slice(i, i + 200));
        if (delErr) throw new Error(`accounting_invoices delete failed: ${delErr.message}`);
      }
      await saveConnectorConfigPatch(ctx, {
        inv_headers: nextGrid[0] || NATIVE_INVOICE_DEFAULT_HEADERS,
      });
    }

    if (lastMode !== importMode) {
      await persistConnectorScriptProperties(ctx, { INV_LAST_IMPORT_MODE: importMode });
    }
    if ((needsModeOverwrite && finalData.length > 0) || (!needsModeOverwrite && dataChanged)) {
      await stampDataChgAlertInConfig_(ctx, [
        { row1: 2, col1: 2, val: "Yes" },
        { row1: 2, col1: 3, val: nowDate },
      ]);
    }
    await stampMasterCompTimestamp(ctx, "InvComp", "L2", nowDate);

    if (ctx.connectorPullMode !== "native") {
      await saveVirtualTabGrid_(ctx, "master", "InvFromApp", nextGrid, nextGrid, {}).catch(() => { });
    }
    invalidateClientRelationalMasterCache(ctx.clientName);
    if (ctx.masterComputeMode === "native" || ctx.masterComputeMode === "shadow") {
      await computeAndPersistNativeMasterComparisons(ctx).catch(() => { });
    }
  }

  return {
    success: true,
    tool,
    importMode,
    newInvoices,
    updatedInvoices,
    dataChanged,
    rowsCount: Math.max(0, nextGrid.length - 1),
    headers: nextGrid[0] || NATIVE_INVOICE_DEFAULT_HEADERS,
    nextGrid,
    lastError: "",
  };
}

// ============================================================================
// DIRECT COSTS HELPERS (100% VERBATIM PORT OF 7_Cost_Sync.gs:316-420, 3269-3842)
// ============================================================================

function makeIdsUnique_(rows) {
  const idCounts = Object.create(null);
  const idIndex = 8;
  return rows.map((row) => {
    const out = [...row];
    const id = out[idIndex];
    if (idCounts[id]) {
      idCounts[id]++;
      out[idIndex] = `${id}-${idCounts[id]}`;
    } else {
      idCounts[id] = 1;
    }
    return out;
  });
}

function formatNewExpenseLogEntry_(row, tz = "Europe/London") {
  const id = String(row[8] || "N/A").trim();
  const desc = String(row[1] || "No description").trim();
  const net = parseFloat(row[2]) || 0;
  const vat = parseFloat(row[3]) || 0;
  const vatMark = vat > 0 ? " +VAT" : "";
  const netStr = formatLogAmount_(net);
  const dateStr = formatLogDate_(row[0], tz);
  const ref = String(row[5] || "").trim();
  const refStr = ref ? ` | Ref: ${ref}` : "";
  const account = String(row[6] || "").trim();
  const acctStr = account ? ` | Acct: ${account}` : "";
  const status = String(row[7] || "").trim();
  const statusStr = status ? ` | Status: ${status}` : "";
  const currCode = String(row[10] || "").trim();
  const currRate = parseFloat(row[11]);
  const currStr = currCode && currCode !== "GBP" ? ` | Curr: ${currCode} (Rate: ${currRate || 1})` : "";
  return `[ID: ${id}] ${desc} - Amount: £${netStr}${vatMark} | Date: ${dateStr || "N/A"}${refStr}${acctStr}${statusStr}${currStr}`;
}

function getExpenseFieldChanges_(oldRow, newRow, tz = "Europe/London") {
  const EXP_HEADERS_MAP = {
    0: "Date",
    1: "Description",
    2: "Net Amount",
    3: "VAT",
    4: "Gross Amount",
    5: "Reference",
    6: "Account",
    7: "Status",
    9: "Date Paid",
    10: "Currency Code",
    11: "Currency Rate",
  };
  const changes = [];
  const colsToCheck = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11];
  for (const c of colsToCheck) {
    const oldVal = oldRow[c];
    const newVal = newRow[c];

    if (c === 0 || c === 9) {
      const oldYmd = normalizeDateToYmd_(oldVal, tz);
      const newYmd = normalizeDateToYmd_(newVal, tz);
      if (oldYmd && newYmd && oldYmd === newYmd) continue;
      const header = EXP_HEADERS_MAP[c];
      const oldFormatted = formatLogDate_(oldVal, tz) || (oldVal ? String(oldVal) : "Blank");
      const newFormatted = formatLogDate_(newVal, tz) || (newVal ? String(newVal) : "Blank");
      if (oldFormatted !== newFormatted) {
        changes.push(`${header}: '${oldFormatted}' -> '${newFormatted}'`);
      }
      continue;
    }

    if (c === 2 || c === 3 || c === 4) {
      let cleanOld = oldVal;
      if (cleanOld instanceof Date) {
        const epochZero = new Date(1899, 11, 30).getTime();
        cleanOld = Math.round(((cleanOld.getTime() - epochZero) / 86400000) * 100) / 100;
      }
      let cleanNew = newVal;
      if (cleanNew instanceof Date) {
        const epochZero = new Date(1899, 11, 30).getTime();
        cleanNew = Math.round(((cleanNew.getTime() - epochZero) / 86400000) * 100) / 100;
      }
      const n1 = cleanOld === null || cleanOld === undefined || cleanOld === "" ? 0 : Number(cleanOld);
      const n2 = cleanNew === null || cleanNew === undefined || cleanNew === "" ? 0 : Number(cleanNew);
      if (!isNaN(n1) && !isNaN(n2) && Math.abs(n1 - n2) < 0.005) continue;
      const header = EXP_HEADERS_MAP[c];
      const oldFormatted = formatLogAmount_(cleanOld);
      const newFormatted = formatLogAmount_(cleanNew);
      if (oldFormatted !== newFormatted) {
        changes.push(`${header}: '${oldFormatted}' -> '${newFormatted}'`);
      }
      continue;
    }

    if (c === 11) {
      const n1 = oldVal === null || oldVal === undefined || oldVal === "" ? 0 : Number(oldVal);
      const n2 = newVal === null || newVal === undefined || newVal === "" ? 0 : Number(newVal);
      if (!isNaN(n1) && !isNaN(n2) && Math.abs(n1 - n2) < 0.0001) continue;
      const header = EXP_HEADERS_MAP[c];
      changes.push(`${header}: '${oldVal || "Blank"}' -> '${newVal || "Blank"}'`);
      continue;
    }

    if (valuesAreDifferent_(oldVal, newVal)) {
      const header = EXP_HEADERS_MAP[c] || `Col ${c}`;
      const oldFormatted = oldVal === null || oldVal === undefined || String(oldVal).trim() === "" ? "Blank" : String(oldVal).trim();
      const newFormatted = newVal === null || newVal === undefined || String(newVal).trim() === "" ? "Blank" : String(newVal).trim();
      if (oldFormatted !== newFormatted) {
        changes.push(`${header}: '${oldFormatted}' -> '${newFormatted}'`);
      }
    }
  }
  return changes;
}

async function fetchXeroExpenseAccountsList_({ accessToken, tenantId, fetchImpl, sleepImpl }) {
  const url =
    'https://api.xero.com/api.xro/2.0/Accounts?where=Class%3d%3d%22EXPENSE%22%20OR%20Class%3d%3d%22DIRECTCOSTS%22';
  const res = await fetchXeroWithRetry_(
    url,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    },
    { label: "Xero Expense Accounts", fetchImpl, sleepImpl }
  );
  if (!res.ok) {
    throw new Error(`Xero API Error: ${res.text || res.status}`);
  }
  return (res.json?.Accounts || []).map((a) => ({ code: a.Code, name: a.Name }));
}

async function fetchQBExpenseAccountsList_({ accessToken, realmId, fetchImpl }) {
  const safeRealmId = assertValidQBRealmId(realmId);
  const query =
    "SELECT Id, Name, AcctNum FROM Account WHERE AccountType IN ('Expense', 'Cost of Goods Sold', 'Other Expense') AND Active = true MAXRESULTS 1000";
  const url = `https://quickbooks.api.intuit.com/v3/company/${safeRealmId}/query?query=${encodeURIComponent(query)}`;
  const res = await connectorFetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    fetchImpl,
  });
  if (!res.ok) {
    throw new Error(`QB API Error: ${res.text || res.status}`);
  }
  return (res.json?.QueryResponse?.Account || []).map((a) => ({
    code: a.AcctNum ? a.AcctNum : a.Name,
    name: a.Name,
    id: a.Id,
  }));
}

async function fetchXeroCostTransactions_({
  targetCodes,
  accessToken,
  tenantId,
  timeZone,
  fetchImpl,
  sleepImpl,
}) {
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const allRows = [];
  const accountList = await fetchXeroExpenseAccountsList_({
    accessToken,
    tenantId,
    fetchImpl,
    sleepImpl: sleeper,
  });
  const accountNameMap = new Map();
  accountList.forEach((acc) => accountNameMap.set(acc.code, acc.name));

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "xero-tenant-id": tenantId,
    Accept: "application/json",
  };

  const parseXeroAmounts = (line, typeString) => {
    const rawAmt = line.LineAmount || 0;
    const taxAmt = line.TaxAmount || 0;
    let net = 0;
    const vat = taxAmt;
    let gross = 0;
    const type = String(typeString || "Exclusive").toUpperCase();
    if (type === "INCLUSIVE") {
      gross = rawAmt;
      net = rawAmt - taxAmt;
    } else {
      net = rawAmt;
      gross = rawAmt + taxAmt;
    }
    return { net, vat, gross };
  };

  const fetchAllExpenses = true;

  // 1. ACCPAY Bills
  let page = 1;
  let keepFetching = true;
  while (keepFetching) {
    const invUrl = `https://api.xero.com/api.xro/2.0/Invoices?where=Type%3d%3d%22ACCPAY%22%20AND%20Status!%3d%22DELETED%22&statuses=AUTHORISED,PAID,SUBMITTED&page=${page}`;
    await sleeper(350);
    const invResp = await fetchXeroWithRetry_(
      invUrl,
      { headers },
      { label: `Xero Bills p${page}`, fetchImpl, sleepImpl: sleeper }
    );
    if (!invResp.ok) {
      throw new Error(`Xero Bills API Error (HTTP ${invResp.status}) on page ${page}: ${invResp.text?.slice(0, 300) || ""}`);
    }
    const invoices = invResp.json?.Invoices || [];
    if (invoices.length > 0) {
      for (const inv of invoices) {
        for (const line of inv.LineItems || []) {
          const shouldInclude = fetchAllExpenses
            ? accountNameMap.has(line.AccountCode)
            : targetCodes && targetCodes.includes(line.AccountCode);
          if (!shouldInclude) continue;

          const accName = line.AccountName || accountNameMap.get(line.AccountCode) || "";
          const rawDue = parseFloat(inv.AmountDue) || 0;
          const rawPaid = parseFloat(inv.AmountPaid) || 0;
          const rawCredit = parseFloat(inv.AmountCredited) || 0;
          const originalTotal = parseFloat(inv.Total) || rawDue + rawPaid + rawCredit;
          const effectiveTotal = Math.max(0, originalTotal - rawCredit);
          const creditRatio = originalTotal > 0 ? effectiveTotal / originalTotal : 1;

          let datePaid = "";
          let maxPaymentMs = 0;
          if (rawPaid > 0 && Array.isArray(inv.Payments) && inv.Payments.length > 0) {
            for (const p of inv.Payments) {
              if (p.Status && String(p.Status).toUpperCase() === "DELETED") continue;
              const rawD = p.DateString || p.Date;
              if (rawD) {
                const match = String(rawD).match(/\/Date\((\d+)/);
                const ms = match ? parseInt(match[1], 10) : parseDateSafe_(rawD)?.getTime() || 0;
                if (ms > maxPaymentMs) {
                  maxPaymentMs = ms;
                  datePaid = formatDateYmdTz_(new Date(ms), timeZone);
                }
              }
            }
          }
          if (!datePaid && inv.FullyPaidOnDate && (rawCredit <= 0 || rawPaid > 0)) {
            const match = String(inv.FullyPaidOnDate).match(/\d+/);
            if (match) {
              datePaid = formatDateYmdTz_(new Date(parseInt(match[0], 10)), timeZone);
            }
          }

          let dueDateStr = "";
          const rawDueD = inv.DueDateString || inv.DueDate;
          if (rawDueD) {
            if (typeof rawDueD === "string" && rawDueD.includes("-")) {
              dueDateStr = rawDueD.split("T")[0].split(" ")[0];
            } else if (String(rawDueD).includes("/Date(")) {
              const dMatch = String(rawDueD).match(/\d+/);
              if (dMatch) dueDateStr = formatDateYmdTz_(new Date(parseInt(dMatch[0], 10)), timeZone);
            } else {
              const parsedDue = parseDateSafe_(rawDueD);
              if (parsedDue) dueDateStr = formatDateYmdTz_(parsedDue, timeZone);
            }
          }

          const { net: rawLineNet, vat: rawLineVat, gross: rawLineGross } = parseXeroAmounts(line, inv.LineAmountTypes);
          const lineNet = rawLineNet * creditRatio;
          const lineVat = rawLineVat * creditRatio;
          const lineGross = rawLineGross * creditRatio;

          const rawDesc = String(line.Description || "No Desc").replace(/[\r\n]+/g, " - ").trim();
          const supplier = (inv.Contact?.Name || "").trim();
          const desc =
            supplier && rawDesc.toLowerCase().startsWith(supplier.toLowerCase())
              ? rawDesc
              : supplier
                ? `${supplier} (${rawDesc})`
                : rawDesc;

          const currencyCode = inv.CurrencyCode || "";
          const currencyRate = parseFloat(inv.CurrencyRate) || 1;
          const convFactor = currencyRate > 0 && currencyRate !== 1 ? 1 / currencyRate : 1;
          const baseNet = Math.round(lineNet * convFactor * 100) / 100;
          const baseVat = Math.round(lineVat * convFactor * 100) / 100;
          const baseGross = Math.round(lineGross * convFactor * 100) / 100;

          const lineRatio = effectiveTotal > 0 && Math.abs(baseGross - effectiveTotal) > 0.01 ? baseGross / effectiveTotal : 1;
          const baseDue = Math.round(rawDue * lineRatio * convFactor * 100) / 100;
          const basePaid = Math.round(rawPaid * lineRatio * convFactor * 100) / 100;

          allRows.push([
            inv.DateString || inv.Date,
            desc,
            baseNet,
            baseVat,
            baseGross,
            inv.Reference || inv.InvoiceNumber || "",
            `${line.AccountCode} - ${accName}`,
            inv.Status,
            inv.InvoiceID,
            datePaid,
            currencyCode,
            currencyRate,
            baseDue,
            basePaid,
            dueDateStr,
          ]);
        }
      }
      page++;
    } else {
      keepFetching = false;
    }
  }

  // 2. SPEND BankTransactions
  page = 1;
  keepFetching = true;
  while (keepFetching) {
    const bankUrl = `https://api.xero.com/api.xro/2.0/BankTransactions?where=Type%3d%3d%22SPEND%22%20AND%20Status!%3d%22DELETED%22&page=${page}`;
    await sleeper(350);
    const bankResp = await fetchXeroWithRetry_(
      bankUrl,
      { headers },
      { label: `Xero BankTransactions p${page}`, fetchImpl, sleepImpl: sleeper }
    );
    if (!bankResp.ok) {
      throw new Error(
        `Xero BankTransactions API Error (HTTP ${bankResp.status}) on page ${page}: ${bankResp.text?.slice(0, 300) || ""}`
      );
    }
    const bankTxns = bankResp.json?.BankTransactions || [];
    if (bankTxns.length > 0) {
      for (const txn of bankTxns) {
        for (const line of txn.LineItems || []) {
          const shouldInclude = fetchAllExpenses
            ? accountNameMap.has(line.AccountCode)
            : targetCodes && targetCodes.includes(line.AccountCode);
          if (!shouldInclude) continue;

          const accName = line.AccountName || accountNameMap.get(line.AccountCode) || "";
          const datePaid = txn.DateString || txn.Date || "";
          const { net, vat, gross } = parseXeroAmounts(line, txn.LineAmountTypes);

          const rawDesc = String(line.Description || "Direct Spend").replace(/[\r\n]+/g, " - ").trim();
          const supplier = (txn.Contact?.Name || "").trim();
          const desc =
            supplier && rawDesc.toLowerCase().startsWith(supplier.toLowerCase())
              ? rawDesc
              : supplier
                ? `${supplier} (${rawDesc})`
                : rawDesc;

          const currencyCode = txn.CurrencyCode || "";
          const currencyRate = parseFloat(txn.CurrencyRate) || 1;
          const convFactor = currencyRate > 0 && currencyRate !== 1 ? 1 / currencyRate : 1;
          const baseNet = Math.round(net * convFactor * 100) / 100;
          const baseVat = Math.round(vat * convFactor * 100) / 100;
          const baseGross = Math.round(gross * convFactor * 100) / 100;

          allRows.push([
            txn.DateString || txn.Date,
            desc,
            baseNet,
            baseVat,
            baseGross,
            txn.Reference || "",
            `${line.AccountCode} - ${accName}`,
            "PAID",
            txn.BankTransactionID,
            datePaid,
            currencyCode,
            currencyRate,
            0,
            baseGross,
            datePaid,
          ]);
        }
      }
      page++;
    } else {
      keepFetching = false;
    }
  }

  // 3. POSTED ManualJournals (401/403-safe)
  page = 1;
  keepFetching = true;
  while (keepFetching) {
    const jnlUrl = `https://api.xero.com/api.xro/2.0/ManualJournals?where=Status%3d%3d%22POSTED%22&page=${page}`;
    await sleeper(350);
    const jnlResp = await fetchXeroWithRetry_(
      jnlUrl,
      { headers },
      { label: `Xero ManualJournals p${page}`, fetchImpl, sleepImpl: sleeper }
    );
    const statusCode = jnlResp.status;
    if (statusCode === 200) {
      const journals = jnlResp.json?.ManualJournals || [];
      if (journals.length > 0) {
        const firstLines = journals[0].JournalLines || journals[0].Lines;
        if (!firstLines || firstLines.length === 0) {
          keepFetching = false;
        } else {
          for (const mj of journals) {
            const jLines = mj.JournalLines || mj.Lines || [];
            for (const line of jLines) {
              const shouldInclude = fetchAllExpenses
                ? accountNameMap.has(line.AccountCode)
                : targetCodes && targetCodes.includes(line.AccountCode);
              if (!shouldInclude) continue;

              const accName = accountNameMap.get(line.AccountCode) || "";
              const lineAmt = parseFloat(line.LineAmount) || 0;
              if (Math.abs(lineAmt) > 0.001) {
                const taxAmt = parseFloat(line.TaxAmount) || 0;
                const net = lineAmt;
                const vat = taxAmt;
                const gross = net + vat;

                const rawDesc = String(line.Description || mj.Narration || "Manual Journal").replace(/[\r\n]+/g, " - ").trim();
                const narration = String(mj.Narration || "").trim();
                const desc =
                  narration && rawDesc.toLowerCase() !== narration.toLowerCase()
                    ? `${narration} (${rawDesc})`
                    : rawDesc;

                let mjDateStr = "";
                if (mj.Date) {
                  const dateMatch = String(mj.Date).match(/\d+/);
                  if (dateMatch) {
                    mjDateStr = new Date(parseInt(dateMatch[0], 10)).toISOString().split("T")[0];
                  }
                }
                if (!mjDateStr) mjDateStr = mj.DateString || mj.Date || "";

                allRows.push([
                  mjDateStr,
                  desc,
                  net,
                  vat,
                  gross,
                  "Manual Journal",
                  `${line.AccountCode} - ${accName}`,
                  mj.Status || "POSTED",
                  mj.ManualJournalID,
                  mjDateStr,
                  "",
                  1,
                  0,
                  gross,
                  mjDateStr,
                ]);
              }
            }
          }
          page++;
        }
      } else {
        keepFetching = false;
      }
    } else if (statusCode === 401 || statusCode === 403) {
      keepFetching = false;
    } else {
      throw new Error(`Xero ManualJournals API Error (HTTP ${statusCode}) on page ${page}: ${jnlResp.text?.slice(0, 300) || ""}`);
    }
  }

  return makeIdsUnique_(allRows);
}

async function fetchQBBillPaymentDates_({ paymentIds, accessToken, realmId, fetchImpl, sleepImpl }) {
  const dateMap = new Map();
  const safeRealmId = assertValidQBRealmId(realmId);
  const uniqueIds = Array.from(new Set(paymentIds || []));
  if (uniqueIds.length === 0) return dateMap;
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const baseUrl = "https://quickbooks.api.intuit.com";
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

  for (let i = 0; i < uniqueIds.length; i += 30) {
    const batch = uniqueIds.slice(i, i + 30);
    const idList = batch.map((id) => `'${String(id).replace(/[^0-9a-zA-Z_-]/g, "")}'`).join(",");
    const query = encodeURIComponent(`SELECT Id, TxnDate FROM BillPayment WHERE Id IN (${idList})`);
    const res = await fetchQuickBooksWithRetry_(
      `${baseUrl}/v3/company/${safeRealmId}/query?query=${query}`,
      { headers, fetchImpl, sleepImpl: sleeper },
      { label: "QB Invoices Query", fetchImpl, sleepImpl: sleeper }
    );
    if (res.ok) {
      for (const p of res.json?.QueryResponse?.BillPayment || []) {
        if (p?.Id && p?.TxnDate) dateMap.set(p.Id, p.TxnDate);
      }
    }
    if (i + 30 < uniqueIds.length) await sleeper(50);
  }
  return dateMap;
}

async function fetchQBCostTransactions_({
  targetCodes,
  accessToken,
  realmId,
  cutoffDate = null,
  fetchImpl,
  sleepImpl,
}) {
  const safeRealmId = assertValidQBRealmId(realmId);
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const taxCodeRateMap = await fetchQBTaxCodeRateMap_({ accessToken, realmId: safeRealmId, fetchImpl });
  const allRows = [];

  const accountList = await fetchQBExpenseAccountsList_({ accessToken, realmId: safeRealmId, fetchImpl });
  const accountMap = new Map();
  accountList.forEach((acc) => accountMap.set(acc.id, acc.code));

  const itemExpenseAccountMap = new Map();
  try {
    const qItems = "SELECT Id, Name, ExpenseAccountRef FROM Item MAXRESULTS 1000";
    const rItems = await fetchQuickBooksWithRetry_(
      `https://quickbooks.api.intuit.com/v3/company/${safeRealmId}/query?query=${encodeURIComponent(qItems)}`,
      { headers, fetchImpl },
      { label: "QB Items Query", fetchImpl, sleepImpl: sleeper }
    );
    if (rItems.ok) {
      for (const it of rItems.json?.QueryResponse?.Item || []) {
        if (it?.Id && it?.ExpenseAccountRef?.value) {
          itemExpenseAccountMap.set(String(it.Id), {
            value: String(it.ExpenseAccountRef.value),
            name: it.ExpenseAccountRef.name || it.Name || "",
          });
        }
      }
    }
  } catch {
    // Non-fatal
  }

  const paymentDatesMap = new Map();
  const fetchAllExpenses = true;

  const getPaymentIdsFromBills = (bills) => {
    const ids = [];
    for (const bill of bills || []) {
      for (const txn of bill.LinkedTxn || []) {
        if (txn?.TxnType && txn.TxnType.startsWith("BillPayment")) ids.push(txn.TxnId);
      }
    }
    return ids;
  };

  const processQBLines = (items, type) => {
    for (const item of items || []) {
      let status = "PAID";
      let datePaid = "";
      if (type === "Bill") {
        status = parseFloat(item.Balance) === 0 ? "PAID" : "UNPAID";
        if (Array.isArray(item.LinkedTxn)) {
          let latestDate = "";
          for (const txn of item.LinkedTxn) {
            if (txn.TxnType && txn.TxnType.startsWith("BillPayment")) {
              const pDate = paymentDatesMap.get(txn.TxnId);
              if (pDate && (!latestDate || pDate > latestDate)) latestDate = pDate;
            }
          }
          datePaid = latestDate;
        }
      } else {
        datePaid = item.TxnDate;
      }

      const vendorName = item.VendorRef?.name || item.EntityRef?.name || "";
      const totalTax = item.TxnTaxDetail?.TotalTax || 0;
      let totalLineNet = 0;
      for (const l of item.Line || []) {
        if (
          l.DetailType === "AccountBasedExpenseLineDetail" ||
          l.DetailType === "ItemBasedExpenseLineDetail" ||
          l.DetailType === "JournalEntryLineDetail"
        ) {
          totalLineNet += l.Amount || 0;
        }
      }

      let totalCredit = 0;
      if (type === "Bill" && Array.isArray(item.LinkedTxn)) {
        for (const txn of item.LinkedTxn) {
          if (txn.TxnType === "VendorCredit") totalCredit += parseFloat(txn.Amount) || 0;
        }
      }
      const rawTotal = parseFloat(item.TotalAmt) || totalLineNet + totalTax;
      const effectiveTotal = Math.max(0, rawTotal - totalCredit);
      const creditRatio = rawTotal > 0 ? effectiveTotal / rawTotal : 1;
      const rawDue = type === "Bill" ? parseFloat(item.Balance) || 0 : 0;
      const rawPaid = type === "Bill" ? Math.max(0, effectiveTotal - rawDue) : totalLineNet + totalTax;
      const dueDateStr = type === "Bill" && item.DueDate ? String(item.DueDate).split("T")[0] : item.TxnDate || "";
      const baseDue = Math.round(rawDue * 100) / 100;
      const basePaid = Math.round(rawPaid * 100) / 100;

      for (const line of item.Line || []) {
        let acctRef = null;
        let isItemBased = false;

        const rawDesc = String(line.Description || item.PrivateNote || type || "Direct Spend")
          .replace(/[\r\n]+/g, " - ")
          .trim();
        const supplier = (vendorName || "").trim();
        const fullDesc =
          supplier && rawDesc.toLowerCase().startsWith(supplier.toLowerCase())
            ? rawDesc
            : supplier
              ? `${supplier} (${rawDesc})`
              : rawDesc;

        if (line.DetailType === "AccountBasedExpenseLineDetail") {
          acctRef = line.AccountBasedExpenseLineDetail.AccountRef;
        } else if (line.DetailType === "JournalEntryLineDetail") {
          acctRef = line.JournalEntryLineDetail.AccountRef;
        } else if (line.DetailType === "ItemBasedExpenseLineDetail") {
          const itemId = String(line.ItemBasedExpenseLineDetail.ItemRef?.value || "");
          const mappedExpenseAcct = itemId ? itemExpenseAccountMap.get(itemId) : null;
          if (mappedExpenseAcct && mappedExpenseAcct.value) {
            acctRef = mappedExpenseAcct;
          } else {
            acctRef = {
              value: line.ItemBasedExpenseLineDetail.ItemRef.value,
              name: line.ItemBasedExpenseLineDetail.ItemRef.name,
            };
            isItemBased = true;
          }
        }

        if (acctRef && acctRef.value) {
          const matchedCode = accountMap.get(acctRef.value) || acctRef.name;
          const shouldInclude = fetchAllExpenses || (targetCodes && targetCodes.includes(matchedCode)) || isItemBased;
          if (!shouldInclude) continue;

          const rawLineNet = line.Amount || 0;
          const net = Math.round(rawLineNet * creditRatio * 100) / 100;
          const lineTaxCodeId = String(
            line.AccountBasedExpenseLineDetail?.TaxCodeRef?.value ||
            line.ItemBasedExpenseLineDetail?.TaxCodeRef?.value ||
            line.TaxCodeRef?.value ||
            ""
          ).trim();

          let vat = 0;
          if (totalTax === 0) {
            vat = 0;
          } else if (lineTaxCodeId && taxCodeRateMap && taxCodeRateMap[lineTaxCodeId] !== undefined) {
            vat = Math.round(net * taxCodeRateMap[lineTaxCodeId] * 100) / 100;
            if (vat === 0 && totalTax > 0 && (item.Line || []).filter((l) => (l.Amount || 0) > 0).length === 1) {
              vat = Math.round(totalTax * creditRatio * 100) / 100;
            }
          } else if (totalLineNet > 0) {
            vat = Math.round((net / totalLineNet) * totalTax * 100) / 100;
          } else if (totalTax > 0) {
            const validLines = (item.Line || []).filter((l) => l.Amount > 0).length || 1;
            vat = Math.round(((totalTax * creditRatio) / validLines) * 100) / 100;
          }
          const gross = Math.round((net + vat) * 100) / 100;
          const displayAccName = isItemBased ? `[Item] ${acctRef.name}` : acctRef.name;
          const qbCurrencyCode = item.CurrencyRef?.value || "";
          const qbCurrencyRate = parseFloat(item.ExchangeRate) || 1;
          const qbRef =
            type === "Journal"
              ? item.DocNumber
                ? `Manual Journal - ${item.DocNumber}`
                : "Manual Journal"
              : item.DocNumber || "";

          allRows.push([
            item.TxnDate,
            fullDesc,
            net,
            vat,
            gross,
            qbRef,
            displayAccName,
            status,
            item.Id,
            datePaid,
            qbCurrencyCode,
            qbCurrencyRate,
            baseDue,
            basePaid,
            dueDateStr,
          ]);
        }
      }
    }
  };

  const effectiveCutoffDate =
    cutoffDate instanceof Date && !isNaN(cutoffDate.getTime())
      ? cutoffDate
      : new Date(new Date().getFullYear(), new Date().getMonth() - NATIVE_COST_CONFIG.HISTORY_MONTHS, 1);
  const cutoffYmd = formatDateUtcYmd_(effectiveCutoffDate);
  const queryPaginatedQbEntity = async (entityName) => {
    const collected = [];
    let startPos = 1;
    const pageSize = 500;
    const maxPages = 40;
    for (let page = 1; page <= maxPages; page++) {
      const q = `SELECT * FROM ${entityName} WHERE TxnDate >= '${cutoffYmd}' STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`;
      const resp = await fetchQuickBooksWithRetry_(
        `https://quickbooks.api.intuit.com/v3/company/${safeRealmId}/query?query=${encodeURIComponent(q)}`,
        { headers, fetchImpl },
        { label: `QB ${entityName} p${page}`, fetchImpl, sleepImpl: sleeper }
      );
      if (!resp.ok) {
        throw new Error(`QuickBooks ${entityName} query failed (HTTP ${resp.status}): ${resp.text?.slice(0, 200) || ""}`);
      }
      const pageItems = resp.json?.QueryResponse?.[entityName];
      if (!Array.isArray(pageItems) || pageItems.length === 0) break;
      collected.push(...pageItems);
      if (pageItems.length < pageSize) break;
      if (page === maxPages) {
        throw new Error(`QuickBooks ${entityName} pagination exceeded ${maxPages * pageSize} rows safety cap.`);
      }
      startPos += pageItems.length;
      await sleeper(150);
    }
    return collected;
  };

  const bills = await queryPaginatedQbEntity("Bill");
  const paymentIds = getPaymentIdsFromBills(bills);
  const fetchedMap = await fetchQBBillPaymentDates_({
    paymentIds,
    accessToken,
    realmId: safeRealmId,
    fetchImpl,
    sleepImpl: sleeper,
  });
  fetchedMap.forEach((v, k) => paymentDatesMap.set(k, v));
  processQBLines(bills, "Bill");

  const purchases = await queryPaginatedQbEntity("Purchase");
  processQBLines(purchases, "Purchase");

  const journals = await queryPaginatedQbEntity("JournalEntry");
  processQBLines(journals, "Journal");

  return makeIdsUnique_(allRows);
}

// ============================================================================
// PUBLIC ENGINE #2: NATIVE DIRECT COSTS SYNC (`JnlsFromApp`)
// ============================================================================

export async function pullNativeAccountingDirectCosts(ctx, options = {}) {
  const {
    tokenOverride = null,
    fetchImpl = null,
    sleepImpl = null,
    persistToDb = true,
    keyInfoOverride = null,
    existingGridOverride = null,
    nowDate = new Date(),
  } = options;

  const state = await loadConnectorContextState(ctx, keyInfoOverride);
  let keyInfoGrid = state.keyInfoGrid;

  // Exact KeyInfo!AT4:AT40 (rows 3..39 0-idx, col AT = idx 45)
  const rawTargets = [];
  for (let r = 3; r <= 39; r++) {
    const val = keyInfoGrid?.[r]?.[45];
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      rawTargets.push(String(val));
    }
  }
  const targetCodes = rawTargets
    .filter(String)
    .map((s) => s.split(" - ")[0].trim());

  if (targetCodes.length === 0) {
    return {
      success: true,
      newExpenses: [],
      updatedExpenses: [],
      allExpenseData: [],
      dataChanged: false,
      lastError: "",
    };
  }

  const rawToolName = readKeyInfoCellRaw(keyInfoGrid, "Q4", "");
  const tool = normalizeAccountingToolName_(rawToolName);
  if (tool !== "xero" && tool !== "quickbooks") {
    return {
      success: false,
      newExpenses: [],
      updatedExpenses: [],
      allExpenseData: [],
      dataChanged: false,
      lastError: `Accounting Tool (Q4) is set to "${rawToolName}".`,
    };
  }

  let auth;
  try {
    auth = await resolveAccountingAuth_(ctx, keyInfoGrid, tool, tokenOverride);
  } catch (err) {
    return {
      success: false,
      newExpenses: [],
      updatedExpenses: [],
      allExpenseData: [],
      dataChanged: false,
      lastError: err.message || String(err),
      reconnectRequired: Boolean(err.reconnectRequired),
    };
  }

  if (!auth.tenantOrRealmId) {
    return {
      success: false,
      newExpenses: [],
      updatedExpenses: [],
      allExpenseData: [],
      dataChanged: false,
      lastError: `Missing ${tool === "quickbooks" ? "Realm ID (KeyInfo!X3)" : "Tenant ID (KeyInfo!X2)"}.`,
    };
  }

  if (auth.healedCellCoord && persistToDb) {
    keyInfoGrid = patchGrid2DCell(
      keyInfoGrid,
      auth.healedCellCoord.row1,
      auth.healedCellCoord.col1,
      auth.healedCellCoord.val
    );
    await saveConnectorConfigPatch(ctx, { master_key_info_grid: keyInfoGrid });
  }

  const costCutoffDate = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth() - NATIVE_COST_CONFIG.HISTORY_MONTHS,
    1
  );
  const allExpenseData =
    tool === "quickbooks"
      ? await fetchQBCostTransactions_({
        targetCodes,
        accessToken: auth.accessToken,
        realmId: auth.tenantOrRealmId,
        cutoffDate: costCutoffDate,
        fetchImpl,
        sleepImpl,
      })
      : await fetchXeroCostTransactions_({
        targetCodes,
        accessToken: auth.accessToken,
        tenantId: auth.tenantOrRealmId,
        timeZone: state.timeZone,
        fetchImpl,
        sleepImpl,
      });

  const transactionData = allExpenseData.filter((row) => {
    const ref = String(row[5] || "").trim().toLowerCase();
    if (ref === "manual journal" || ref.startsWith("manual journal")) return false;
    const rawAccount = String(row[6] || "").trim();
    if (rawAccount.startsWith("[Item]")) return true;
    const code = rawAccount.split(" - ")[0].trim();
    return targetCodes.includes(code);
  });

  const cutoffDate = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth() - NATIVE_COST_CONFIG.HISTORY_MONTHS,
    1
  );
  const recentData = transactionData.filter((row) => new Date(row[0]) >= cutoffDate);

  if (recentData.length === 0) {
    return {
      success: true,
      tool,
      newExpenses: [],
      updatedExpenses: [],
      allExpenseData,
      dataChanged: false,
      rowsCount: 0,
      nextGrid: [NATIVE_COST_CONFIG.HEADERS],
      lastError: "",
    };
  }

  // Load existing JnlsFromApp grid for PRE-SYNC DELTA SNAPSHOT
  let existingGrid = Array.isArray(existingGridOverride) ? existingGridOverride : null;
  if (!existingGrid) {
    if (ctx?.connectorPullMode === "native") {
      const bundle = await preloadClientRelationalMasterBundle(ctx, { source: "db" }).catch(() => null);
      if (bundle) {
        existingGrid = projectDirectCostsToGrid({
          headers: NATIVE_COST_CONFIG.HEADERS,
          records: bundle.accountingDirectCosts || [],
        });
      }
    }
    if (!existingGrid) {
      const rec = await getOrLoadVirtualTabGrid_(ctx, "master", NATIVE_COST_CONFIG.TARGET_SHEET_NAME, null).catch(() => null);
      existingGrid = Array.isArray(rec?.values_grid) ? rec.values_grid : [];
    }
  }

  const oldMap = new Map();
  for (let r = 1; r < existingGrid.length; r++) {
    const row = existingGrid[r] || [];
    const id = String(row[8] || "").trim();
    if (id) oldMap.set(id, row);
  }

  recentData.sort((a, b) => new Date(b[0]) - new Date(a[0]));
  const safeRecentData = sanitizeSheetMatrix_(recentData);

  const newExpenses = [];
  const updatedExpenses = [];
  for (const newRow of recentData) {
    const id = String(newRow[8] || "").trim();
    if (!id) continue;
    if (!oldMap.has(id)) {
      newExpenses.push(formatNewExpenseLogEntry_(newRow, state.timeZone));
    } else {
      const oldRow = oldMap.get(id);
      const changes = getExpenseFieldChanges_(oldRow, newRow, state.timeZone);
      if (changes.length > 0) {
        const desc = String(newRow[1] || oldRow[1] || "No description").trim();
        const ref = String(newRow[5] || oldRow[5] || "").trim();
        const refStr = ref ? ` (${ref})` : "";
        updatedExpenses.push(`[ID: ${id}] ${desc}${refStr} - ${changes.join(", ")}`);
      }
    }
  }

  const nextGrid = normalizeVirtualMasterGrid(
    NATIVE_COST_CONFIG.TARGET_SHEET_NAME,
    [NATIVE_COST_CONFIG.HEADERS, ...safeRecentData],
    COST_TEXT_COLS
  );

  if (persistToDb && ctx?.clientId) {
    const supabase = getSupabaseAdmin();
    if (supabase) {
      const parsedDir = parseJnlsFromAppGrid({
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        grid: nextGrid,
        keyInfoGrid,
      });
      await upsertRowsInChunks_(
        supabase,
        "accounting_direct_costs",
        parsedDir.rows,
        "client_id,sheet_row_num"
      );
      const keepNums = new Set(parsedDir.rows.map((r) => Number(r.sheet_row_num)));
      const existingRows = await fetchAllClientIdsRows_(
        supabase,
        "accounting_direct_costs",
        "id, sheet_row_num",
        ctx.clientId
      );
      const staleIds = existingRows
        .filter((r) => !keepNums.has(Number(r.sheet_row_num)))
        .map((r) => r.id);
      for (let i = 0; i < staleIds.length; i += 200) {
        const { error: delErr } = await supabase.from("accounting_direct_costs").delete().in("id", staleIds.slice(i, i + 200));
        if (delErr) throw new Error(`accounting_direct_costs delete failed: ${delErr.message}`);
      }
    }

    await stampMasterCompTimestamp(ctx, "DirComp", "K2", nowDate);

    if (ctx.connectorPullMode !== "native") {
      await saveVirtualTabGrid_(
        ctx,
        "master",
        NATIVE_COST_CONFIG.TARGET_SHEET_NAME,
        nextGrid,
        nextGrid,
        {}
      ).catch(() => { });
    }
    invalidateClientRelationalMasterCache(ctx.clientName);
    if (ctx.masterComputeMode === "native" || ctx.masterComputeMode === "shadow") {
      await computeAndPersistNativeMasterComparisons(ctx).catch(() => { });
    }
  }

  return {
    success: true,
    tool,
    newExpenses,
    updatedExpenses,
    allExpenseData,
    dataChanged: newExpenses.length > 0 || updatedExpenses.length > 0,
    rowsCount: safeRecentData.length,
    nextGrid,
    lastError: "",
  };
}

// ============================================================================
// P&L MERGE + FETCH HELPERS (100% VERBATIM 1_Core_and_Xero.gs & 3_QuickBooks)
// ============================================================================

function mergeMonthRowOrder_(masterOrder, monthRowOrder) {
  if (masterOrder.length === 0) return [...monthRowOrder];
  const out = [...masterOrder];
  const masterTitles = new Set(out.map((r) => r.title));
  monthRowOrder.forEach((monthRow, index) => {
    if (!masterTitles.has(monthRow.title)) {
      let predecessorIndex = -1;
      for (let j = index - 1; j >= 0; j--) {
        const predTitle = monthRowOrder[j].title;
        const idx = out.findIndex((r) => r.title === predTitle);
        if (idx !== -1) {
          predecessorIndex = idx;
          break;
        }
      }
      if (predecessorIndex !== -1) {
        out.splice(predecessorIndex + 1, 0, monthRow);
      } else {
        let successorIndex = -1;
        for (let j = index + 1; j < monthRowOrder.length; j++) {
          const succTitle = monthRowOrder[j].title;
          const idx = out.findIndex((r) => r.title === succTitle);
          if (idx !== -1) {
            successorIndex = idx;
            break;
          }
        }
        if (successorIndex !== -1) {
          out.splice(successorIndex, 0, monthRow);
        } else {
          out.push(monthRow);
        }
      }
      masterTitles.add(monthRow.title);
    }
  });
  return out;
}

function getXeroReportStructure_(report) {
  const structure = [];
  if (!report || !Array.isArray(report.Rows)) return structure;
  const processNode = (r) => {
    if (r.RowType === "Section") {
      structure.push({ title: r.Title, type: r.RowType });
      if (Array.isArray(r.Rows)) r.Rows.forEach(processNode);
    } else if (r.RowType === "Row" || r.RowType === "SummaryRow") {
      structure.push({ title: r.Cells?.[0]?.Value, type: r.RowType });
    }
  };
  report.Rows.forEach(processNode);
  return structure;
}

function getQBReportStructure_(report) {
  const structure = [];
  if (!report?.Rows?.Row) return structure;
  const processNode = (r) => {
    if (!r.Header && !r.Summary && !r.ColData) return;
    if (r.type === "Section" && Array.isArray(r.Header?.ColData) && r.Header.ColData.length > 0) {
      structure.push({ title: String(r.Header.ColData[0].value || "").trim(), type: "Section" });
      if (Array.isArray(r.Rows?.Row)) r.Rows.Row.forEach(processNode);
    } else if (Array.isArray(r.Summary?.ColData) && r.Summary.ColData.length > 0) {
      structure.push({ title: String(r.Summary.ColData[0].value || "").trim(), type: "SummaryRow" });
    } else if (Array.isArray(r.ColData) && r.ColData.length > 0) {
      structure.push({ title: String(r.ColData[0].value || "").trim(), type: "Row" });
    }
  };
  report.Rows.Row.forEach(processNode);
  return structure;
}

function buildPLMatrixFromReportData_(reportData, sourceTab = "PLFromApp") {
  const dataToWrite = [reportData.headers];
  for (const rowInfo of reportData.rowOrder) {
    const newRow = [rowInfo.title];
    if (rowInfo.type === "Section") {
      for (let i = 1; i < reportData.headers.length; i++) newRow.push("");
    } else {
      const rowData = reportData.rowMap.get(rowInfo.title) || {};
      for (let i = 1; i < reportData.headers.length; i++) {
        const monthHeader = reportData.headers[i];
        newRow.push(rowData[monthHeader] || "0.00");
      }
    }
    dataToWrite.push(newRow);
  }
  const sanitized = sanitizeSheetMatrix_(dataToWrite);
  return normalizeVirtualMasterGrid(sourceTab, sanitized);
}

async function fetchMonthlyPLReportData_({
  tool,
  accessToken,
  tenantOrRealmId,
  monthStartDates,
  fetchImpl,
  sleepImpl,
}) {
  const reportData = {
    headers: ["Description"],
    rowMap: new Map(),
    rowOrder: [],
  };

  for (const fromDate of monthStartDates) {
    const endDate = new Date(fromDate.getFullYear(), fromDate.getMonth() + 1, 0);
    const fromStr = formatDateLocalYmd_(fromDate);
    const toStr = formatDateLocalYmd_(endDate);
    const monthHeader = fromDate.toLocaleString("default", { month: "long", year: "numeric" });

    if (tool === "quickbooks") {
      const safeRealmId = assertValidQBRealmId(tenantOrRealmId);
      const url = `https://quickbooks.api.intuit.com/v3/company/${safeRealmId}/reports/ProfitAndLoss?start_date=${fromStr}&end_date=${toStr}`;
      const res = await fetchQuickBooksWithRetry_(
        url,
        {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        },
        { label: `QB P&L (${monthHeader})`, fetchImpl, sleepImpl }
      );
      if (!res.ok) {
        throw new Error(`QuickBooks ProfitAndLoss report failed for ${monthHeader} (HTTP ${res.status}): ${res.text?.slice(0, 200) || ""}`);
      }
      reportData.headers.splice(1, 0, monthHeader);
      const monthReport = res.json;
      const monthRowOrder = getQBReportStructure_(monthReport);
      reportData.rowOrder = mergeMonthRowOrder_(reportData.rowOrder, monthRowOrder);

      const processQBRow = (row) => {
        if (!row.Header && !row.Summary && !row.ColData) return;
        if (row.type === "Section" && Array.isArray(row.Rows?.Row)) {
          row.Rows.Row.forEach(processQBRow);
        } else if (Array.isArray(row.Summary?.ColData) && row.Summary.ColData.length > 1) {
          const title = String(row.Summary.ColData[0].value || "").trim();
          const value = row.Summary.ColData[1].value || "0.00";
          if (!reportData.rowMap.has(title)) reportData.rowMap.set(title, {});
          reportData.rowMap.get(title)[monthHeader] = value;
        } else if (Array.isArray(row.ColData) && row.ColData.length > 1) {
          const title = String(row.ColData[0].value || "").trim();
          const value = row.ColData[1].value || "0.00";
          if (!reportData.rowMap.has(title)) reportData.rowMap.set(title, {});
          reportData.rowMap.get(title)[monthHeader] = value;
        }
      };
      if (Array.isArray(monthReport?.Rows?.Row)) monthReport.Rows.Row.forEach(processQBRow);
    } else {
      const url = `https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${fromStr}&toDate=${toStr}&standardLayout=false`;
      const res = await fetchXeroWithRetry_(
        url,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "xero-tenant-id": tenantOrRealmId,
            Accept: "application/json",
          },
        },
        { label: `Xero P&L (${monthHeader})`, fetchImpl, sleepImpl }
      );
      if (!res.ok) {
        throw new Error(`Xero ProfitAndLoss report failed for ${monthHeader} (HTTP ${res.status}): ${res.text?.slice(0, 200) || ""}`);
      }
      reportData.headers.splice(1, 0, monthHeader);
      const monthReport = res.json?.Reports?.[0];
      const monthRowOrder = getXeroReportStructure_(monthReport);
      reportData.rowOrder = mergeMonthRowOrder_(reportData.rowOrder, monthRowOrder);

      const processXeroRow = (row) => {
        if (row.RowType === "Section" && Array.isArray(row.Rows)) {
          row.Rows.forEach(processXeroRow);
        } else if ((row.RowType === "Row" || row.RowType === "SummaryRow") && row.Cells?.length > 1) {
          const title = row.Cells[0].Value;
          const value = row.Cells[1].Value;
          if (!reportData.rowMap.has(title)) reportData.rowMap.set(title, {});
          reportData.rowMap.get(title)[monthHeader] = value;
        }
      };
      if (Array.isArray(monthReport?.Rows)) monthReport.Rows.forEach(processXeroRow);
    }
  }

  return reportData;
}

async function persistPlGridToRelationalTable_(ctx, sourceTab, nextGrid) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientId) return;

  const parsedPl = parsePLTabGrid({
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    sourceTab,
    grid: nextGrid,
  });

  await upsertRowsInChunks_(
    supabase,
    "accounting_pl_lines",
    parsedPl.rows,
    "client_id,source_tab,sheet_row_num"
  );

  const keepNums = new Set(parsedPl.rows.map((r) => Number(r.sheet_row_num)));
  const existingRows = await fetchAllClientIdsRows_(
    supabase,
    "accounting_pl_lines",
    "id, sheet_row_num",
    ctx.clientId,
    { source_tab: sourceTab }
  );
  const staleIds = existingRows
    .filter((r) => !keepNums.has(Number(r.sheet_row_num)))
    .map((r) => r.id);
  for (let i = 0; i < staleIds.length; i += 200) {
    const { error: delErr } = await supabase.from("accounting_pl_lines").delete().in("id", staleIds.slice(i, i + 200));
    if (delErr) throw new Error(`accounting_pl_lines delete failed: ${delErr.message}`);
  }

  if (sourceTab === "PLFromApp") {
    await saveConnectorConfigPatch(ctx, { pl_headers: nextGrid[0] || [] });
  }
  if (ctx.connectorPullMode !== "native") {
    await saveVirtualTabGrid_(ctx, "master", sourceTab, nextGrid, nextGrid, {}).catch(() => { });
  }
  invalidateClientRelationalMasterCache(ctx.clientName);
}

// ============================================================================
// PUBLIC ENGINE #3: NATIVE ROLLING P&L PULL (`PLFromApp`)
// ============================================================================

export async function pullNativeProfitAndLoss(ctx, options = {}) {
  const {
    tokenOverride = null,
    fetchImpl = null,
    sleepImpl = null,
    persistToDb = true,
    keyInfoOverride = null,
    nowDate = new Date(),
  } = options;

  const state = await loadConnectorContextState(ctx, keyInfoOverride);
  let keyInfoGrid = state.keyInfoGrid;
  const tool = normalizeAccountingToolName_(readKeyInfoCellRaw(keyInfoGrid, "Q4", "Xero"));

  let auth;
  try {
    auth = await resolveAccountingAuth_(ctx, keyInfoGrid, tool, tokenOverride);
  } catch (err) {
    return {
      success: false,
      lastError: err.message || String(err),
      reconnectRequired: Boolean(err.reconnectRequired),
    };
  }

  if (auth.healedCellCoord && persistToDb) {
    keyInfoGrid = patchGrid2DCell(keyInfoGrid, auth.healedCellCoord.row1, auth.healedCellCoord.col1, auth.healedCellCoord.val);
    await saveConnectorConfigPatch(ctx, { master_key_info_grid: keyInfoGrid });
  }

  // Matches 1_Core_and_Xero.gs:1144 & 3_QuickBooks_and_Starters.gs:748 (i = 0..11)
  const monthStartDates = [];
  for (let i = 0; i < 12; i++) {
    monthStartDates.push(new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1));
  }

  const reportData = await fetchMonthlyPLReportData_({
    tool,
    accessToken: auth.accessToken,
    tenantOrRealmId: auth.tenantOrRealmId,
    monthStartDates,
    fetchImpl,
    sleepImpl,
  });

  if (reportData.rowOrder.length === 0) {
    return {
      success: false,
      tool,
      rowsCount: 0,
      nextGrid: [reportData.headers],
      lastError: "Failed to fetch any P&L report data across 12 months.",
    };
  }

  const nextGrid = buildPLMatrixFromReportData_(reportData, "PLFromApp");

  if (persistToDb) {
    await persistPlGridToRelationalTable_(ctx, "PLFromApp", nextGrid);
    await stampMasterCompTimestamp(ctx, "PLComp", "C1", nowDate);
    if (ctx.masterComputeMode === "native" || ctx.masterComputeMode === "shadow") {
      await computeAndPersistNativeMasterComparisons(ctx).catch(() => { });
    }
  }

  return {
    success: true,
    tool,
    rowsCount: Math.max(0, nextGrid.length - 1),
    headers: nextGrid[0] || [],
    nextGrid,
    lastError: "",
  };
}

// ============================================================================
// PUBLIC ENGINE #4: NATIVE YEAR 0 P&L PULL (`Year0PLFromApp`)
// ============================================================================

export async function pullNativeYear0ProfitAndLoss(ctx, options = {}) {
  const {
    tokenOverride = null,
    fetchImpl = null,
    sleepImpl = null,
    persistToDb = true,
    keyInfoOverride = null,
    periodStartDateOverride = null,
  } = options;

  const state = await loadConnectorContextState(ctx, keyInfoOverride);
  let keyInfoGrid = state.keyInfoGrid;
  const tool = normalizeAccountingToolName_(readKeyInfoCellRaw(keyInfoGrid, "Q4", "Xero"));

  // Year0Data!AM1 (col 39 / idx 38, row 0), fallback to KeyInfo!B2 - 12m
  let periodStartDate = periodStartDateOverride ? parseDateSafe_(periodStartDateOverride) : null;
  if (!periodStartDate) {
    const y0Rec = await getOrLoadVirtualTabGrid_(ctx, "master", "Year0Data", null).catch(() => null);
    const am1Raw = y0Rec?.values_grid?.[0]?.[38];
    if (am1Raw) periodStartDate = parseDateSafe_(am1Raw);
  }
  if (!periodStartDate) {
    const b2Date = readKeyInfoDateCell(keyInfoGrid, "B2");
    if (b2Date) {
      periodStartDate = new Date(b2Date.getFullYear() - 1, b2Date.getMonth(), 1);
    }
  }
  if (!periodStartDate) {
    return {
      success: false,
      lastError: "Missing Year 0 start date in Year0Data!AM1 or KeyInfo!B2.",
    };
  }

  let auth;
  try {
    auth = await resolveAccountingAuth_(ctx, keyInfoGrid, tool, tokenOverride);
  } catch (err) {
    return {
      success: false,
      lastError: err.message || String(err),
      reconnectRequired: Boolean(err.reconnectRequired),
    };
  }

  const monthStartDates = [];
  for (let i = 0; i < 12; i++) {
    monthStartDates.push(new Date(periodStartDate.getFullYear(), periodStartDate.getMonth() + i, 1));
  }

  const reportData = await fetchMonthlyPLReportData_({
    tool,
    accessToken: auth.accessToken,
    tenantOrRealmId: auth.tenantOrRealmId,
    monthStartDates,
    fetchImpl,
    sleepImpl,
  });

  if (reportData.rowOrder.length === 0) {
    return {
      success: false,
      tool,
      rowsCount: 0,
      lastError: "No Year 0 data found.",
    };
  }

  const nextGrid = buildPLMatrixFromReportData_(reportData, "Year0PLFromApp");

  if (persistToDb) {
    await persistPlGridToRelationalTable_(ctx, "Year0PLFromApp", nextGrid);
    if (ctx.masterComputeMode === "native" || ctx.masterComputeMode === "shadow") {
      await computeAndPersistNativeMasterComparisons(ctx).catch(() => { });
    }
  }

  return {
    success: true,
    tool,
    rowsCount: Math.max(0, nextGrid.length - 1),
    nextGrid,
    lastError: "",
  };
}

// ============================================================================
// PUBLIC ENGINE #5: SINGLE-MONTH P&L REPORT + PATCH (`7_Cost_Sync.gs:5826-6010`)
// ============================================================================

export async function fetchNativeSingleMonthPLReport(ctx, fromDateStr, toDateStr, options = {}) {
  const state = await loadConnectorContextState(ctx, options.keyInfoOverride || null);
  const tool = normalizeAccountingToolName_(readKeyInfoCellRaw(state.keyInfoGrid, "Q4", "Xero"));
  const auth = await resolveAccountingAuth_(ctx, state.keyInfoGrid, tool, options.tokenOverride || null);

  const plMap = new Map();
  let depreciationVal = 0;

  if (tool === "xero") {
    const url = `https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${fromDateStr}&toDate=${toDateStr}&standardLayout=false`;
    const res = await fetchXeroWithRetry_(
      url,
      {
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          "xero-tenant-id": auth.tenantOrRealmId,
          Accept: "application/json",
        },
      },
      { label: `Xero Single P&L (${fromDateStr})`, fetchImpl: options.fetchImpl, sleepImpl: options.sleepImpl }
    );
    if (!res.ok) return null;
    const report = res.json?.Reports?.[0];
    if (!report || !Array.isArray(report.Rows)) return null;

    const processXeroRow = (r) => {
      if (r.RowType === "Section" && Array.isArray(r.Rows)) {
        r.Rows.forEach(processXeroRow);
      } else if ((r.RowType === "Row" || r.RowType === "SummaryRow") && r.Cells?.length > 1) {
        const rawTitle = String(r.Cells[0]?.Value || "").trim();
        const rawVal = r.Cells[1]?.Value;
        if (!rawTitle) return;
        const numVal = parseFloat(String(rawVal || "0").replace(/[£$€,\s]/g, "")) || 0;
        const norm = rawTitle.replace(/^\d+\s*[-–]\s*/, "").toLowerCase().trim();
        if (norm.includes("depreciation")) depreciationVal = numVal;
        if (r.RowType === "Row") plMap.set(norm, { originalTitle: rawTitle, amount: numVal });
      }
    };
    report.Rows.forEach(processXeroRow);
  } else if (tool === "quickbooks") {
    const safeRealmId = assertValidQBRealmId(auth.tenantOrRealmId);
    const url = `https://quickbooks.api.intuit.com/v3/company/${safeRealmId}/reports/ProfitAndLoss?start_date=${fromDateStr}&end_date=${toDateStr}`;
    const res = await connectorFetch(url, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
      fetchImpl: options.fetchImpl,
    });
    if (!res.ok) return null;
    const processQBRow = (r) => {
      if (r.type === "Section" && Array.isArray(r.Rows?.Row)) r.Rows.Row.forEach(processQBRow);
      const colData =
        r.ColData?.length > 1 ? r.ColData : r.Summary?.ColData?.length > 1 ? r.Summary.ColData : null;
      if (colData) {
        const rawTitle = String(colData[0]?.value || "").trim();
        const rawVal = colData[1]?.value;
        if (!rawTitle) return;
        const numVal = parseFloat(String(rawVal || "0").replace(/[£$€,\s]/g, "")) || 0;
        const norm = rawTitle.replace(/^\d+\s*[-–]\s*/, "").toLowerCase().trim();
        if (norm.includes("depreciation")) depreciationVal = numVal;
        plMap.set(norm, { originalTitle: rawTitle, amount: numVal });
      }
    };
    if (Array.isArray(res.json?.Rows?.Row)) res.json.Rows.Row.forEach(processQBRow);
  }

  return { categories: plMap, depreciation: depreciationVal };
}

export async function updateNativeSingleMonthPL(ctx, targetYear, targetMonth, freshPl, options = {}) {
  if (!freshPl || !freshPl.categories) return { success: false };

  let existingGrid = null;
  if (ctx?.connectorPullMode === "native") {
    const bundle = await preloadClientRelationalMasterBundle(ctx, { source: "db" }).catch(() => null);
    if (bundle) {
      const plRows = (bundle.accountingPlLines || []).filter(
        (r) => String(r.source_tab || "PLFromApp") === "PLFromApp"
      );
      let hdrs =
        Array.isArray(bundle.config?.pl_headers) && bundle.config.pl_headers.length > 0
          ? bundle.config.pl_headers
          : [];
      if (hdrs.length === 0 && plRows.length > 0) {
        const sampleAmounts = plRows.find((r) => r?.monthly_amounts && typeof r.monthly_amounts === "object")?.monthly_amounts || {};
        const monthKeys = Object.keys(sampleAmounts);
        hdrs = monthKeys.length > 0 ? ["Description", ...monthKeys] : ["Description"];
      } else if (hdrs.length === 0) {
        hdrs = ["Description"];
      }
      existingGrid = projectPLLinesToGrid({ headers: hdrs, records: plRows, sourceTab: "PLFromApp" });
    }
  }
  if (!existingGrid) {
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", "PLFromApp", null).catch(() => null);
    existingGrid = Array.isArray(rec?.values_grid) ? compactGrid2D(rec.values_grid) : [["Description"]];
  }

  const nextGrid = existingGrid.map((r) => [...(r || [])]);
  const headers = nextGrid[0] || ["Description"];
  let targetCol0 = -1;
  for (let c = 1; c < headers.length; c++) {
    const hd = parseDateSafe_(headers[c]);
    if (hd && hd.getFullYear() === targetYear && hd.getMonth() === targetMonth) {
      targetCol0 = c;
      break;
    }
  }
  if (targetCol0 === -1) {
    targetCol0 = headers.length;
    const monthDate = new Date(targetYear, targetMonth, 1);
    headers.push(monthDate.toLocaleString("default", { month: "long", year: "numeric" }));
    nextGrid[0] = headers;
  }

  const existingRowMap = new Map();
  for (let r = 1; r < nextGrid.length; r++) {
    const rawTitle = String(nextGrid[r]?.[0] || "").trim();
    if (!rawTitle) continue;
    const norm = rawTitle.replace(/^\d+\s*[-–]\s*/, "").toLowerCase().trim();
    if (!existingRowMap.has(norm)) existingRowMap.set(norm, r);
  }

  freshPl.categories.forEach((item, norm) => {
    let r0 = existingRowMap.get(norm);
    if (r0 === undefined) {
      r0 = nextGrid.length;
      nextGrid.push([sanitizeSheetCell_(item.originalTitle)]);
      existingRowMap.set(norm, r0);
    }
    while (nextGrid[r0].length <= targetCol0) nextGrid[r0].push("");
    nextGrid[r0][targetCol0] = item.amount;
  });

  if (freshPl.depreciation > 0) {
    for (const [norm, r0] of existingRowMap.entries()) {
      if (norm.includes("depreciation")) {
        while (nextGrid[r0].length <= targetCol0) nextGrid[r0].push("");
        nextGrid[r0][targetCol0] = freshPl.depreciation;
        break;
      }
    }
  }

  if (options.persistToDb !== false) {
    await persistPlGridToRelationalTable_(ctx, "PLFromApp", nextGrid);
    if (ctx.masterComputeMode === "native" || ctx.masterComputeMode === "shadow") {
      await computeAndPersistNativeMasterComparisons(ctx).catch(() => { });
    }
  }

  return { success: true, targetColIdx: targetCol0 + 1, nextGrid };
}

// ============================================================================
// PUBLIC ENGINE #6: CHART OF ACCOUNTS REFRESH (`7_Cost_Sync.gs:113-149`)
// ============================================================================

export async function refreshNativeChartOfAccountsDirect(ctx, options = {}) {
  const {
    tokenOverride = null,
    fetchImpl = null,
    sleepImpl = null,
    persistToDb = true,
    keyInfoOverride = null,
  } = options;

  const state = await loadConnectorContextState(ctx, keyInfoOverride);
  let keyInfoGrid = state.keyInfoGrid;
  const rawToolName = readKeyInfoCellRaw(keyInfoGrid, "Q4", "");
  const tool = normalizeAccountingToolName_(rawToolName);

  if (tool !== "xero" && tool !== "quickbooks") {
    return {
      success: false,
      categories: [],
      lastError: `Accounting Tool (Q4) is set to "${rawToolName}". Please select Xero or QuickBooks.`,
    };
  }

  const auth = await resolveAccountingAuth_(ctx, keyInfoGrid, tool, tokenOverride);
  if (!auth.tenantOrRealmId) {
    return {
      success: false,
      categories: [],
      lastError: `Missing ${tool === "quickbooks" ? "Realm ID (KeyInfo!X3)" : "Tenant ID (KeyInfo!X2)"}.`,
    };
  }

  if (auth.healedCellCoord && persistToDb) {
    keyInfoGrid = patchGrid2DCell(keyInfoGrid, auth.healedCellCoord.row1, auth.healedCellCoord.col1, auth.healedCellCoord.val);
  }

  const accounts =
    tool === "quickbooks"
      ? await fetchQBExpenseAccountsList_({
        accessToken: auth.accessToken,
        realmId: auth.tenantOrRealmId,
        fetchImpl,
      })
      : await fetchXeroExpenseAccountsList_({
        accessToken: auth.accessToken,
        tenantId: auth.tenantOrRealmId,
        fetchImpl,
        sleepImpl,
      });

  if (!accounts.length) {
    throw new Error("No expense accounts found.");
  }

  // Matches 7_Cost_Sync.gs:134 verbatim (preserves API order without re-sorting)
  const sanitizedCategories = accounts.map((acc) => sanitizeSheetCell_(`${acc.code} - ${acc.name}`));

  // Clear col AW (49) from row 2 downwards & populate
  const maxClearRows = Math.max(keyInfoGrid.length, sanitizedCategories.length + 1, 500);
  for (let row1 = 2; row1 <= maxClearRows; row1++) {
    const idx = row1 - 2;
    const val = idx < sanitizedCategories.length ? sanitizedCategories[idx] : "";
    keyInfoGrid = patchGrid2DCell(keyInfoGrid, row1, 49, val);
  }

  if (persistToDb && ctx?.clientId) {
    await saveConnectorConfigPatch(ctx, {
      master_key_info_grid: keyInfoGrid,
      accounting_coa_categories: sanitizedCategories,
    });
    if (ctx.connectorPullMode !== "native") {
      await saveVirtualTabGrid_(ctx, "master", "KeyInfo", keyInfoGrid, keyInfoGrid, {}).catch(() => { });
    }
  }

  return {
    success: true,
    tool,
    accountsCount: sanitizedCategories.length,
    categories: sanitizedCategories,
    keyInfoGrid,
  };
}

// ============================================================================
// 5. REVENUE COMPARISON ENGINE (PHASE 6D VERBATIM 2_Internal_Sheet_Logic.gs)
// ============================================================================

function parseRevCompDateCell_(cellVal) {
  if (cellVal instanceof Date && !isNaN(cellVal.getTime())) {
    return new Date(cellVal.getFullYear(), cellVal.getMonth(), 1);
  }
  if (typeof cellVal === "number" && cellVal > 25000 && cellVal < 90000) {
    const d = serialToDate(cellVal);
    if (d && !isNaN(d.getTime())) {
      return new Date(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
  }
  if (typeof cellVal === "string" && cellVal.trim()) {
    const d = new Date(cellVal.trim());
    if (!isNaN(d.getTime())) {
      return new Date(d.getFullYear(), d.getMonth(), 1);
    }
  }
  return null;
}

function extractDashboardRevenueDataFromMonthlyGrid_(monthlyGrid = [], targetDate) {
  const limit = Math.min(Array.isArray(monthlyGrid) ? monthlyGrid.length : 0, 3000);
  const targetYear = targetDate.getFullYear();
  const targetMonth = targetDate.getMonth();

  const isMatchDate = (cellVal) => {
    if (cellVal instanceof Date && !isNaN(cellVal.getTime())) {
      return cellVal.getFullYear() === targetYear && cellVal.getMonth() === targetMonth;
    }
    if (typeof cellVal === "number" && cellVal > 30000 && cellVal < 60000) {
      const d = new Date(Math.round((cellVal - 25569) * 86400 * 1000));
      return d.getUTCFullYear() === targetYear && d.getUTCMonth() === targetMonth;
    }
    return false;
  };

  const isAnyDate = (cellVal) => {
    if (cellVal instanceof Date && !isNaN(cellVal.getTime())) return true;
    if (typeof cellVal === "number" && cellVal > 30000 && cellVal < 60000) return true;
    return false;
  };

  let startRowMatch = -1;
  let nextDateRow = limit;

  for (let i = 0; i < limit; i++) {
    const cellVal = monthlyGrid[i]?.[0];
    if (isMatchDate(cellVal)) {
      startRowMatch = i;
      break;
    }
  }

  if (startRowMatch === -1) {
    throw new Error(
      `Target date (${targetYear}-${String(targetMonth + 1).padStart(2, "0")}) not found in Monthly Tab.`
    );
  }

  for (let i = startRowMatch + 1; i < limit; i++) {
    const cellVal = monthlyGrid[i]?.[0];
    if (isAnyDate(cellVal)) {
      nextDateRow = i;
      break;
    }
  }

  const dataStart = startRowMatch + 4;
  const dataEnd = nextDateRow - 3;
  if (dataStart > dataEnd) return [];

  const extractedBlock = [];
  for (let i = dataStart; i <= dataEnd; i++) {
    const rowArr = Array.isArray(monthlyGrid[i]) ? monthlyGrid[i] : [];
    const rowSlice = [];
    for (let c = 2; c < 8; c++) {
      rowSlice.push(rowArr[c] ?? "");
    }
    if (rowSlice.some((cell) => String(cell).trim() !== "")) {
      extractedBlock.push(rowSlice);
    }
  }

  return extractedBlock;
}

async function fetchXeroRevenueByDateDirect_({
  accessToken,
  xeroTenantId,
  startDate,
  endDate,
  fetchImpl = null,
  sleepImpl = defaultSleepMs,
}) {
  let allInvoices = [];
  let page = 1;
  let keepFetching = true;

  const startY = startDate.getFullYear();
  const startM = startDate.getMonth() + 1;
  const startD = startDate.getDate();
  const endY = endDate.getFullYear();
  const endM = endDate.getMonth() + 1;
  const endD = endDate.getDate();

  const whereClause = `Type=="ACCREC" AND Status!="DELETED" AND Status!="VOIDED" AND Date>=DateTime(${startY},${startM},${startD}) AND Date<=DateTime(${endY},${endM},${endD})`;
  const baseUrl = `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent(
    whereClause
  )}&statuses=AUTHORISED,PAID,DRAFT,SUBMITTED&order=Date%20DESC`;

  while (keepFetching) {
    const res = await fetchXeroWithRetry_(
      `${baseUrl}&page=${page}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "xero-tenant-id": xeroTenantId,
          Accept: "application/json",
        },
      },
      { label: `Xero Revenue Invoices p${page}`, fetchImpl, sleepImpl }
    );
    if (!res.ok) {
      throw new Error(`Xero API Error on Page ${page}: ${res.text}`);
    }
    const pageInvoices = res.json?.Invoices || [];
    if (pageInvoices.length > 0) {
      allInvoices = allInvoices.concat(pageInvoices);
      if (pageInvoices.length < 100) {
        keepFetching = false;
      } else {
        page++;
      }
    } else {
      keepFetching = false;
    }
    if (page > 20) keepFetching = false;
  }

  const mappedData = [];
  for (const inv of allInvoices) {
    const invDate = parseDateSafe_(inv.DateString || inv.Date);
    const rawStatus = String(inv.Status || "").toUpperCase();
    const isApproved = rawStatus === "AUTHORISED" || rawStatus === "PAID";
    const isDraft = rawStatus === "DRAFT" || rawStatus === "SUBMITTED";

    if (invDate && invDate >= startDate && invDate <= endDate && (isApproved || isDraft)) {
      const originalTotal = parseFloat(inv.Total) || 0;
      const credit = parseFloat(inv.AmountCredited) || 0;
      const effectiveTotal = originalTotal - credit;
      const ratio = originalTotal > 0 ? effectiveTotal / originalTotal : 1;
      const fxRate = parseFloat(inv.CurrencyRate) || 1;
      const lineAmtType = String(inv.LineAmountTypes || "Exclusive").toUpperCase();

      const statusLabel = isDraft
        ? rawStatus === "SUBMITTED"
          ? "Awaiting Approval"
          : "Draft"
        : rawStatus === "PAID"
          ? "Paid"
          : "Authorised";

      if (Array.isArray(inv.LineItems)) {
        inv.LineItems.forEach((line, index) => {
          const lineId = `${inv.InvoiceID}-${index + 1}`;
          let rawLineAmt = parseFloat(line.LineAmount) || 0;
          if (lineAmtType === "INCLUSIVE") {
            rawLineAmt -= parseFloat(line.TaxAmount) || 0;
          }
          const effectiveLineAmtForeign = rawLineAmt * ratio;
          const calculatedBaseAmt = effectiveLineAmtForeign / fxRate;
          const effectiveLineAmtBase = isApproved ? calculatedBaseAmt : 0;
          const draftAmount = isDraft ? calculatedBaseAmt : 0;
          const invNumber = inv.InvoiceNumber || (isDraft ? "[Draft]" : "");

          mappedData.push([
            lineId,
            inv.Contact?.Name || "Unknown",
            invNumber,
            line.Description || (isDraft ? "Draft invoice" : "No Description"),
            effectiveLineAmtBase,
            inv.DateString || formatGasDate(invDate, "UTC", "yyyy-MM-dd HH:mm:ss"),
            statusLabel,
            draftAmount,
          ]);
        });
      }
    }
  }

  return mappedData;
}

async function fetchQBRevenueByDateDirect_({
  accessToken,
  realmId,
  startDate,
  endDate,
  fetchImpl = null,
  sleepImpl = defaultSleepMs,
}) {
  const cleanRealmId = assertValidQBRealmId(realmId);
  const startStr = formatGasDate(startDate, "UTC", "yyyy-MM-dd");
  const endStr = formatGasDate(endDate, "UTC", "yyyy-MM-dd");
  const baseUrl = "https://quickbooks.api.intuit.com";

  let allInvoices = [];
  let startPosition = 1;
  const pageSize = 500;

  while (true) {
    const query = encodeURIComponent(
      `SELECT * FROM Invoice WHERE TxnDate >= '${startStr}' AND TxnDate <= '${endStr}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    const url = `${baseUrl}/v3/company/${cleanRealmId}/query?query=${query}`;
    const res = await connectorFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      fetchImpl,
    });
    if (!res.ok) {
      throw new Error(`QB API request failed: ${res.text}`);
    }
    const invoicesOnPage = res.json?.QueryResponse?.Invoice || [];
    if (Array.isArray(invoicesOnPage) && invoicesOnPage.length > 0) {
      allInvoices = allInvoices.concat(invoicesOnPage);
      startPosition += invoicesOnPage.length;
      if (invoicesOnPage.length < pageSize) break;
    } else {
      break;
    }
    if (typeof sleepImpl === "function") await sleepImpl(200);
  }

  const mappedData = [];
  for (const inv of allInvoices) {
    const originalTotal = parseFloat(inv.TotalAmt) || 0;
    let totalCredit = 0;
    if (Array.isArray(inv.LinkedTxn)) {
      for (const txn of inv.LinkedTxn) {
        if (txn.TxnType === "CreditMemo") {
          totalCredit += parseFloat(txn.Amount) || 0;
        }
      }
    }
    const effectiveTotal = originalTotal - totalCredit;
    const ratio = originalTotal > 0 ? effectiveTotal / originalTotal : 1;
    const fxRate = parseFloat(inv.ExchangeRate) || 1;

    if (Array.isArray(inv.Line)) {
      const validLines = inv.Line.filter((l) => l.DetailType === "SalesItemLineDetail");
      validLines.forEach((line, index) => {
        const lineId = `${inv.Id}-${index + 1}`;
        const originalLineAmtForeign = line.Amount || 0;
        const effectiveLineAmtForeign = originalLineAmtForeign * ratio;
        const effectiveLineAmtBase = effectiveLineAmtForeign * fxRate;

        mappedData.push([
          lineId,
          inv.CustomerRef?.name || "Unknown",
          inv.DocNumber,
          line.Description || "No Description",
          effectiveLineAmtBase,
          inv.TxnDate,
          "Authorised",
          0,
        ]);
      });
    }
  }

  return mappedData;
}

function buildRevCompGridVerbatim_({
  existingRevCompGrid = [],
  targetDate,
  dashboardData = [],
  appData = [],
  timeZone = "Europe/London",
}) {
  const nextGrid = Array.isArray(existingRevCompGrid)
    ? existingRevCompGrid.slice(0, 4).map((r) => (Array.isArray(r) ? [...r] : []))
    : [];
  while (nextGrid.length < 4) nextGrid.push([]);

  const appTotal = appData.reduce((sum, row) => sum + (parseFloat(row[4]) || 0), 0);
  const dashTotal = dashboardData.reduce((sum, row) => sum + (parseFloat(row[3]) || 0), 0);
  const variance = Math.abs(dashTotal - appTotal);

  const summaryBlock = [
    ["Target Month", formatGasDate(targetDate, timeZone, "MMMM yyyy")],
    ["Dashboard Revenue", dashTotal],
    ["Accounting App Revenue", appTotal],
    ["Variance", variance],
  ];
  for (let i = 0; i < summaryBlock.length; i++) {
    const rIdx = 4 + i;
    while (nextGrid.length <= rIdx) nextGrid.push([]);
    nextGrid[rIdx] = [summaryBlock[i][0], summaryBlock[i][1]];
  }
  while (nextGrid.length < 9) nextGrid.push([]);

  const clientMap = new Map();
  const findFuzzyKey = (newClient) => {
    if (!newClient || String(newClient).trim() === "") return "Unknown Client";
    const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    const s1 = clean(newClient);
    for (const existingClient of clientMap.keys()) {
      const s2 = clean(existingClient);
      if (s1.includes(s2) || s2.includes(s1)) return existingClient;
      const stripSuffixes = (s) => s.replace(/(ltd|limited|inc|llc|corp|company)$/g, "");
      if (stripSuffixes(s1) === stripSuffixes(s2)) return existingClient;
    }
    return String(newClient).trim();
  };

  for (const row of dashboardData) {
    const rawClient = row[0];
    const revenue = parseFloat(row[3]) || 0;
    const matchedClient = findFuzzyKey(rawClient);
    if (!clientMap.has(matchedClient)) clientMap.set(matchedClient, { dashRev: 0, appRev: 0 });
    clientMap.get(matchedClient).dashRev += revenue;
  }

  for (const row of appData) {
    const rawClient = row[1];
    const revenue = parseFloat(row[4]) || 0;
    const matchedClient = findFuzzyKey(rawClient);
    if (!clientMap.has(matchedClient)) clientMap.set(matchedClient, { dashRev: 0, appRev: 0 });
    clientMap.get(matchedClient).appRev += revenue;
  }

  const comparisonOutput = [["Client", "Dashboard Revenue", "App Revenue", "Difference"]];
  clientMap.forEach((data, client) => {
    comparisonOutput.push([client, data.dashRev, data.appRev, data.dashRev - data.appRev]);
  });

  const sortedOutput = [comparisonOutput[0]].concat(
    comparisonOutput.slice(1).sort((a, b) => Math.abs(b[3]) - Math.abs(a[3]))
  );

  if (sortedOutput.length > 1) {
    const sanitized = sanitizeSheetMatrix_(sortedOutput);
    for (let i = 0; i < sanitized.length; i++) {
      nextGrid[9 + i] = sanitized[i];
    }
  } else {
    nextGrid[9] = comparisonOutput[0];
  }

  return {
    nextRevCompGrid: normalizeVirtualMasterGrid("RevComp", nextGrid),
    dashTotal,
    appTotal,
    variance,
  };
}

/**
 * Verbatim Phase 6D port of GAS `runRevenueComparison(isHeadless, customTargetMonth)`
 */
export async function runNativeRevenueComparisonDirect(ctx, options = {}) {
  const {
    sheets = null,
    customTargetMonth = null,
    persistToDb = true,
    fetchImpl = null,
    sleepImpl = defaultSleepMs,
    tokenOverride = null,
    keyInfoOverride = null,
    monthlyGridOverride = null,
    revCompGridOverride = null,
    isHeadless = true,
    timeZone = "Europe/London",
  } = options;

  const { keyInfoGrid, cfgRow } = await loadConnectorContextState(ctx, keyInfoOverride);

  let revCompGrid = Array.isArray(revCompGridOverride) ? revCompGridOverride.map((r) => [...r]) : null;
  if (!Array.isArray(revCompGrid)) {
    if (ctx?.syncOrchestratorMode === "native" && Array.isArray(cfgRow?.master_rev_comp_grid)) {
      revCompGrid = cfgRow.master_rev_comp_grid.map((r) => [...r]);
    } else {
      const rcRec = await getOrLoadVirtualTabGrid_(ctx, "master", "RevComp", sheets).catch(() => null);
      revCompGrid = Array.isArray(rcRec?.values_grid) ? rcRec.values_grid.map((r) => [...r]) : [];
    }
  }

  let targetDate = null;
  if (customTargetMonth) {
    if (customTargetMonth instanceof Date && !isNaN(customTargetMonth.getTime())) {
      targetDate = new Date(customTargetMonth.getFullYear(), customTargetMonth.getMonth(), 1);
    } else if (typeof customTargetMonth === "string") {
      const parts = customTargetMonth.trim().split(/[-/]/);
      if (parts.length >= 2) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        if (!isNaN(y) && !isNaN(m)) {
          targetDate = new Date(y, m, 1);
        }
      }
    }
    if (targetDate && !isNaN(targetDate.getTime())) {
      revCompGrid = patchGrid2DCell(revCompGrid, 2, 3, dateToSerial(targetDate)); // C2
    }
  }

  if (!targetDate) {
    targetDate =
      parseRevCompDateCell_(revCompGrid[1]?.[2]) || // C2
      parseRevCompDateCell_(revCompGrid[0]?.[2]) || // C1
      null;
  }

  if (!targetDate) {
    const msg = "Please enter a valid date in C1 or C2 of RevComp.";
    if (isHeadless) throw new Error(msg);
    return { success: false, error: msg };
  }

  targetDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
  const endOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);

  let monthlyGrid = Array.isArray(monthlyGridOverride) ? monthlyGridOverride : null;
  if (!Array.isArray(monthlyGrid)) {
    if (ctx?.clientComputeMode === "native") {
      try {
        const { loadNativeClientTabRecordsBatch } = await import("./nativeClientCalcService.js");
        const loaded = await loadNativeClientTabRecordsBatch(ctx, ["Monthly"], { source: "db", valuesOnly: true });
        if (Array.isArray(loaded?.Monthly?.values_grid)) {
          monthlyGrid = loaded.Monthly.values_grid;
        }
      } catch (_) { }
    }
    if (!Array.isArray(monthlyGrid)) {
      if (ctx?.clientMode === "supabase") {
        const mRec = await getOrLoadVirtualTabGrid_(ctx, "client", "Monthly", sheets, { valuesOnly: true }).catch(() => null);
        monthlyGrid = Array.isArray(mRec?.values_grid) ? mRec.values_grid : null;
      }
      if (!Array.isArray(monthlyGrid) && sheets && ctx?.clientSheetId) {
        const mResp = await sheets.spreadsheets.values.get({
          spreadsheetId: ctx.clientSheetId,
          range: "Monthly!A1:H3000",
          valueRenderOption: "UNFORMATTED_VALUE",
          _bypassSupabaseVirtualSheet: ctx.clientMode !== "supabase",
        });
        monthlyGrid = mResp?.data?.values || [];
      }
    }
  }
  if (!Array.isArray(monthlyGrid)) {
    throw new Error("Sheet 'Monthly' not found on Client Sheet.");
  }

  const dashboardData = extractDashboardRevenueDataFromMonthlyGrid_(monthlyGrid, targetDate);

  const rawToolName = readKeyInfoCellRaw(keyInfoGrid, "Q4"); // Q4
  const tool = normalizeAccountingToolName_(rawToolName);
  if (tool !== "xero" && tool !== "quickbooks") {
    throw new Error(`Accounting Tool (Q4) is set to "${rawToolName}". Unsupported for revenue sync.`);
  }

  const auth = await resolveAccountingAuth_(ctx, keyInfoGrid, tool, tokenOverride);
  if (!auth.tenantOrRealmId) {
    throw new Error(`Missing ${tool === "quickbooks" ? "Realm ID (KeyInfo!X3)" : "Tenant ID (KeyInfo!X2)"}.`);
  }

  const appData =
    tool === "quickbooks"
      ? await fetchQBRevenueByDateDirect_({
        accessToken: auth.accessToken,
        realmId: auth.tenantOrRealmId,
        startDate: targetDate,
        endDate: endOfMonth,
        fetchImpl,
        sleepImpl,
      })
      : await fetchXeroRevenueByDateDirect_({
        accessToken: auth.accessToken,
        xeroTenantId: auth.tenantOrRealmId,
        startDate: targetDate,
        endDate: endOfMonth,
        fetchImpl,
        sleepImpl,
      });

  const revHeaders = [
    "Line ID",
    "Client Name",
    "Invoice Number",
    "Description",
    "Effective Revenue",
    "Date",
    "Status",
    "Draft Amount",
  ];
  const rawRevFromApp =
    appData.length > 0 ? [revHeaders, ...sanitizeSheetMatrix_(appData)] : [revHeaders];
  const revFromAppGrid = normalizeVirtualMasterGrid("RevFromApp", rawRevFromApp);

  const { nextRevCompGrid, dashTotal, appTotal, variance } = buildRevCompGridVerbatim_({
    existingRevCompGrid: revCompGrid,
    targetDate,
    dashboardData,
    appData,
    timeZone,
  });

  if (persistToDb && ctx?.clientId) {
    if (ctx.masterIngestionMode === "relational") {
      await reconcileClientMasterIngestionFromGrids(ctx, ["RevFromApp"], {
        gridsOverride: { RevFromApp: revFromAppGrid },
        skipConfigUpsert: true,
      });
    }
    if (ctx.connectorPullMode !== "native") {
      await saveVirtualTabGrid_(ctx, "master", "RevFromApp", revFromAppGrid, revFromAppGrid, {}).catch(() => { });
    }
    if (ctx.syncOrchestratorMode === "native") {
      await saveConnectorConfigPatch(ctx, { master_rev_comp_grid: nextRevCompGrid });
    } else {
      await saveVirtualTabGrid_(ctx, "master", "RevComp", nextRevCompGrid, nextRevCompGrid, {}).catch(() => { });
    }
  }

  return {
    success: true,
    targetMonth: formatGasDate(targetDate, timeZone, "yyyy-MM"),
    targetMonthLabel: formatGasDate(targetDate, timeZone, "MMMM yyyy"),
    dashboardTotal: dashTotal,
    accountingTotal: appTotal,
    variance,
    revFromAppGrid,
    revCompGrid: nextRevCompGrid,
    appRowsCount: appData.length,
  };
}
