/**
 * ============================================================================
 * INITIAL TAX SETUP SERVICE (services/taxSetupService.js)
 * ============================================================================
 *
 * Powers the "Update initial tax payment amounts" Step 2 onboarding stage
 * (`p3_initial_tax_payments`, visible when KeyInfo!B10 !== "Transfers"):
 * - Estimates the initial Corporation Tax payment (Year 0 liability due Month 9,
 *   Cash!J19 & Cash!J61) from Balance Sheet provision + Year 0 P&L using
 *   editable UK tiered Corporation Tax rates.
 * - Estimates the initial VAT payment(s) (VAT!G32:J35 -> Cash!B21:E21 &
 *   Cash!B63:E63) according to KeyInfo!F6 stagger cycle (1, 2, or 3),
 *   combining Xero/QuickBooks transaction VAT, Balance Sheet VAT control,
 *   Year0Data P&L estimates, and VAT! tab monthly calculations.
 */

import {
  getSheetsClient,
  withRetry,
  extractSheetIdFromUrl,
} from "./sheetsClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import { resolveAccountingToolAuth } from "./accountingSuggestionsService.js";
import { assertValidQBRealmId } from "./quickbooksService.js";
import {
  getYear0SetupData,
  parseYear0Date,
  parseYear0Number,
} from "./year0SetupService.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import {
  flushImmediateAndScheduleBackgroundClientRecomputes,
  resolveClientSheetIdFromMaster,
} from "./masterEngineService.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeFormulaInput } from "./userPermissions.js";
import { calculateUkTieredCorpTax } from "../utils/helpers.js";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function resolveCleanId(rawId) {
  if (!rawId) return "";
  const unwrapped = unwrapSheetId(String(rawId).trim());
  return extractSheetIdFromUrl(unwrapped) || unwrapped;
}

function fmtIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthKeyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addDaysToIso(isoStr, days) {
  const [y, m, d] = String(isoStr || "").split("-").map(Number);
  if (!y || !m || !d) return "";
  return fmtIso(new Date(y, m - 1, d + days));
}

function shortMonthLabel(d) {
  return `${SHORT_MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
}

function longMonthLabel(d) {
  return `${LONG_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function parseXeroDateObj(val) {
  const raw = String(val || "").trim();
  if (!raw) return null;
  if (raw.startsWith("/Date(")) {
    const ms = parseInt(raw.slice(6), 10);
    if (!Number.isNaN(ms)) {
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Mirrors KeyInfo!F6 formula:
 *   E2 = month(B2)
 *   F2 = if(E2<=3, E2, if(E2-3<=3, E2-3, if(E2-6<=3, E2-6, E2-9)))
 *   E6 = 1 (Jan-Mar), 2 (Feb-Apr), 3 (Mar-May)
 *   F6 = if(F2-E6=0, 2, if(F2-E6=-1, 3, if(F2-E6=2, 3, 1)))
 */
export function computeVatCycleIndexF6(startDate, vatQuarters = "") {
  const e2 = startDate.getMonth() + 1;
  const f2 = ((e2 - 1) % 3) + 1;
  const q = String(vatQuarters || "").toLowerCase();
  let e6 = 1;
  if (q.includes("feb-apr")) e6 = 2;
  else if (q.includes("mar-may")) e6 = 3;
  const diff = f2 - e6;
  if (diff === 0) return 2;
  if (diff === -1 || diff === 2) return 3;
  return 1;
}

/**
 * Parses the initial value stored inside Cash!J19 (`=if(KeyInfo!$B$10="Transfers",-Performance!N63,-1000000)`)
 * or VAT!G32 (`=if(KeyInfo!$F$6=1,50000,0)`). Returns `{ amountOwed, isPlaceholder }`.
 */
function parseSavedFormulaOrValue(raw, placeholderNum) {
  if (raw === undefined || raw === null || raw === "") {
    return { hasValue: false, isPlaceholder: true, savedPositiveOwed: null };
  }
  if (typeof raw === "number") {
    const isPh = Math.abs(raw - placeholderNum) < 0.01;
    return {
      hasValue: !isPh,
      isPlaceholder: isPh,
      savedPositiveOwed: isPh ? null : round2(-raw),
    };
  }
  const str = String(raw).trim();
  if (!str.startsWith("=")) {
    const n = parseYear0Number(str);
    const isPh = Math.abs(n - placeholderNum) < 0.01;
    return {
      hasValue: !isPh,
      isPlaceholder: isPh,
      savedPositiveOwed: isPh ? null : round2(-n),
    };
  }
  // Match last numeric argument in top-level IF(..., trueBranch, falseBranch) or IF(..., trueBranch, 0)
  const corpMatch = /=\s*if\s*\([^,]+,\s*[^,]+,\s*([-+]?\d+(?:\.\d+)?)\s*\)/i.exec(str);
  if (corpMatch && placeholderNum < 0) {
    const num = parseFloat(corpMatch[1]);
    const isPh = Math.abs(num - placeholderNum) < 0.01;
    return {
      hasValue: !isPh,
      isPlaceholder: isPh,
      savedPositiveOwed: isPh ? null : round2(-num),
    };
  }
  const vatMatch = /=\s*if\s*\([^,]+,\s*([-+]?\d+(?:\.\d+)?)\s*,\s*0\s*\)/i.exec(str);
  if (vatMatch && placeholderNum > 0) {
    const num = parseFloat(vatMatch[1]);
    const isPh = Math.abs(num - placeholderNum) < 0.01;
    return {
      hasValue: !isPh,
      isPlaceholder: isPh,
      savedPositiveOwed: isPh ? null : round2(-num),
    };
  }
  return { hasValue: false, isPlaceholder: false, savedPositiveOwed: null };
}

/**
 * Returns the initial VAT payment slot definitions based on KeyInfo!F6 (1, 2, or 3).
 * UK VAT is settled ~1 month + 7 days after quarter end:
 *   F6 = 2 -> M2 (Cash!C21 / VAT!H32:35) covering [M-3, M-2, M-1]
 *   F6 = 3 -> M3 (Cash!D21 / VAT!I32:35) covering [M-2, M-1, M1]
 *   F6 = 1 -> M1 (Cash!B21 / VAT!G32:35) covering [M-4, M-3, M-2] AND M4 (Cash!E21 / VAT!J32:35) covering [M-1, M1, M2]
 */
function buildInitialVatSlotSpecs(f6, startDate) {
  const addMonths = (offset) => new Date(startDate.getFullYear(), startDate.getMonth() + offset, 1);
  const makeSlot = (slotKey, cashCol, vatCol, f6Num, payOffset, monthOffsets) => {
    const payDate = addMonths(payOffset);
    const coveredMonths = monthOffsets.map((off) => {
      const d = addMonths(off);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      return {
        offset: off,
        isYear0: off < 0,
        year0Index: off < 0 ? 12 + off : null, // 0..11 inside Year0Data
        fy1Index: off >= 0 ? off : null,       // 0..11 inside VAT!G..R
        monthKey: monthKeyFromDate(d),
        shortLabel: shortMonthLabel(d),
        fromDateStr: fmtIso(d),
        toDateStr: fmtIso(end),
      };
    });
    const windowFromStr = addDaysToIso(coveredMonths[2].toDateStr, 1);
    const windowEndDate = new Date(payDate.getFullYear(), payDate.getMonth() + 2, 15);
    return {
      slotKey,
      cashCol,
      vatCol,
      f6Num,
      paymentMonthIndex: payOffset + 1, // 1-based FY1 month
      paymentMonthKey: monthKeyFromDate(payDate),
      paymentMonthLabel: longMonthLabel(payDate),
      paymentMonthShort: shortMonthLabel(payDate),
      windowFromStr,
      windowToStr: fmtIso(windowEndDate),
      coveredMonths,
      periodLabel: `${coveredMonths[0].shortLabel} – ${coveredMonths[2].shortLabel}`,
    };
  };

  if (f6 === 2) {
    return [makeSlot("m2", "C", "H", 2, 1, [-3, -2, -1])];
  }
  if (f6 === 3) {
    return [makeSlot("m3", "D", "I", 3, 2, [-2, -1, 0])];
  }
  // F6 === 1: both Month 1 (B/G) and Month 4 (E/J) hold initial non-auto VAT schedules
  return [
    makeSlot("m1", "B", "G", 1, 0, [-4, -3, -2]),
    makeSlot("m4", "E", "J", 1, 3, [-1, 0, 1]),
  ];
}

/**
 * Walks Xero BalanceSheet report JSON matching account name patterns.
 */
function extractXeroBalanceSheetMatches(bsJson, includeRe, excludeRe = /deferred/i) {
  const matches = [];
  const walk = (node, sectionTitle = "") => {
    if (!node) return;
    if (node.RowType === "Section") {
      const nextSec = String(node.Title || sectionTitle || "").trim();
      (node.Rows || []).forEach((child) => walk(child, nextSec));
      return;
    }
    if (node.RowType === "Row") {
      const cells = node.Cells || [];
      const name = String(cells[0]?.Value || "").trim();
      if (!name || /^total\b/i.test(name)) return;
      if (includeRe.test(name) && !(excludeRe && excludeRe.test(name))) {
        const val = parseYear0Number(cells[1]?.Value);
        matches.push({ name, section: sectionTitle, balance: round2(val) });
      }
    }
  };
  (bsJson?.Reports?.[0]?.Rows || []).forEach((r) => walk(r, ""));
  return matches;
}

/**
 * Walks QuickBooks BalanceSheet report JSON matching account name patterns.
 */
function extractQbBalanceSheetMatches(reportJson, includeRe, excludeRe = /deferred/i) {
  const matches = [];
  const walk = (row, sectionTitle = "") => {
    if (!row) return;
    const hdrTitle = String(row.Header?.ColData?.[0]?.value || sectionTitle || "").trim();
    if (row.type === "Section" && Array.isArray(row.Rows?.Row)) {
      row.Rows.Row.forEach((child) => walk(child, hdrTitle));
      return;
    }
    if (Array.isArray(row.ColData) && row.ColData.length >= 2) {
      const name = String(row.ColData[0]?.value || "").trim();
      if (!name || /^total\b/i.test(name)) return;
      if (includeRe.test(name) && !(excludeRe && excludeRe.test(name))) {
        const val = parseYear0Number(row.ColData[row.ColData.length - 1]?.value);
        matches.push({ name, section: sectionTitle, balance: round2(val) });
      }
    }
  };
  (reportJson?.Rows?.Row || []).forEach((r) => walk(r, ""));
  return matches;
}

/**
 * Fetches Balance Sheet matches at a specific ISO date from connected Xero or QuickBooks.
 */
async function fetchAccountingBalanceSheetTaxes(auth, asOfDateStr, accountingMethod = "Accrual") {
  if (!auth || !asOfDateStr) return null;
  const corpRe = /corp(?:oration)?\s*tax|income\s*tax\s*payable/i;
  const vatRe = /\bvat\b|\bsales\s*tax\b|hmrc.*vat|value\s*added/i;

  if (auth.tool === "Xero") {
    const headers = {
      Authorization: `Bearer ${auth.accessToken}`,
      "xero-tenant-id": auth.tenantId,
      Accept: "application/json",
    };
    const res = await fetch(
      `https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?date=${encodeURIComponent(asOfDateStr)}`,
      { headers, redirect: "manual" }
    ).catch(() => null);
    if (!res?.ok) return null;
    const json = await res.json().catch(() => null);
    const corpMatches = extractXeroBalanceSheetMatches(json, corpRe);
    const vatMatches = extractXeroBalanceSheetMatches(json, vatRe);
    return {
      asOfDateStr,
      corpMatches,
      corpTaxTotal: round2(corpMatches.reduce((s, m) => s + m.balance, 0)),
      vatMatches,
      vatControlTotal: round2(vatMatches.reduce((s, m) => s + m.balance, 0)),
    };
  }

  if (auth.tool === "QuickBooks") {
    const realmId = assertValidQBRealmId(auth.realmId);
    const method = accountingMethod === "Cash" ? "Cash" : "Accrual";
    const res = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}/reports/BalanceSheet?end_date=${encodeURIComponent(asOfDateStr)}&accounting_method=${method}`,
      {
        headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
        redirect: "manual",
      }
    ).catch(() => null);
    if (!res?.ok) return null;
    const json = await res.json().catch(() => null);
    const corpMatches = extractQbBalanceSheetMatches(json, corpRe);
    const vatMatches = extractQbBalanceSheetMatches(json, vatRe);
    return {
      asOfDateStr,
      corpMatches,
      corpTaxTotal: round2(corpMatches.reduce((s, m) => s + m.balance, 0)),
      vatMatches,
      vatControlTotal: round2(vatMatches.reduce((s, m) => s + m.balance, 0)),
    };
  }

  return null;
}

/**
 * Fetches net VAT (Output VAT - Input VAT) by YYYY-MM month key from Xero or QuickBooks
 * for historical months inside the initial VAT quarter(s).
 */
async function fetchAccountingMonthlyNetVat(auth, fromDateStr, toDateStr, vatScheme = "Accrual") {
  if (!auth || !fromDateStr || !toDateStr || fromDateStr > toDateStr) return null;
  const byMonth = {}; // { 'YYYY-MM': { outputVat, inputVat, netVat, txnCount } }
  const addVat = (dateObj, isOutput, amt) => {
    if (!dateObj) return;
    const mk = monthKeyFromDate(dateObj);
    if (!byMonth[mk]) byMonth[mk] = { outputVat: 0, inputVat: 0, netVat: 0, txnCount: 0 };
    if (isOutput) byMonth[mk].outputVat = round2(byMonth[mk].outputVat + amt);
    else byMonth[mk].inputVat = round2(byMonth[mk].inputVat + amt);
    byMonth[mk].netVat = round2(byMonth[mk].outputVat - byMonth[mk].inputVat);
    byMonth[mk].txnCount += 1;
  };

  const [y1, m1, d1] = fromDateStr.split("-").map(Number);
  const [y2, m2, d2] = toDateStr.split("-").map(Number);

  if (auth.tool === "Xero") {
    const headers = {
      Authorization: `Bearer ${auth.accessToken}`,
      "xero-tenant-id": auth.tenantId,
      Accept: "application/json",
    };
    const isCash = String(vatScheme || "").toLowerCase() === "cash";
    const dateField = isCash ? "FullyPaidOnDate" : "Date";
    const invWhere = `${dateField}>=DateTime(${y1},${m1},${d1}) AND ${dateField}<=DateTime(${y2},${m2},${d2})`;
    const bankWhere = `Date>=DateTime(${y1},${m1},${d1}) AND Date<=DateTime(${y2},${m2},${d2})`;

    let totalFetched = 0;
    for (let page = 1; page <= 4; page++) {
      const url = `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent(invWhere)}&page=${page}`;
      const res = await fetch(url, { headers, redirect: "manual" }).catch(() => null);
      if (!res?.ok) break;
      const json = await res.json().catch(() => null);
      const invs = json?.Invoices || [];
      for (const inv of invs) {
        const st = String(inv.Status || "").toUpperCase();
        if (["DRAFT", "DELETED", "VOIDED"].includes(st)) continue;
        const tax = Number(inv.TotalTax) || 0;
        if (tax === 0) continue;
        const dt = parseXeroDateObj(isCash ? inv.FullyPaidOnDate : inv.Date);
        if (!dt) continue;
        const rate = Number(inv.CurrencyRate) || 1;
        const taxGbp = rate !== 1 && rate > 0 ? tax / rate : tax;
        const t = String(inv.Type || "").toUpperCase();
        if (t === "ACCREC") addVat(dt, true, taxGbp);
        else if (t === "ACCRECCREDIT") addVat(dt, true, -taxGbp);
        else if (t === "ACCPAY") addVat(dt, false, taxGbp);
        else if (t === "ACCPAYCREDIT") addVat(dt, false, -taxGbp);
      }
      totalFetched += invs.length;
      if (invs.length < 100) break;
    }

    for (let page = 1; page <= 4; page++) {
      const url = `https://api.xero.com/api.xro/2.0/BankTransactions?where=${encodeURIComponent(bankWhere)}&page=${page}`;
      const res = await fetch(url, { headers, redirect: "manual" }).catch(() => null);
      if (!res?.ok) break;
      const json = await res.json().catch(() => null);
      const txns = json?.BankTransactions || [];
      for (const bt of txns) {
        if (String(bt.Status || "").toUpperCase() === "DELETED") continue;
        const tax = Number(bt.TotalTax) || 0;
        if (tax === 0) continue;
        const dt = parseXeroDateObj(bt.Date);
        if (!dt) continue;
        const rate = Number(bt.CurrencyRate) || 1;
        const taxGbp = rate !== 1 && rate > 0 ? tax / rate : tax;
        const t = String(bt.Type || "").toUpperCase();
        if (t.startsWith("RECEIVE")) addVat(dt, true, taxGbp);
        else if (t.startsWith("SPEND")) addVat(dt, false, taxGbp);
      }
      totalFetched += txns.length;
      if (txns.length < 100) break;
    }

    return { source: "Xero transactions", totalFetched, byMonth };
  }

  if (auth.tool === "QuickBooks") {
    const realmId = assertValidQBRealmId(auth.realmId);
    const headers = { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" };
    const runQbQuery = async (entity, isOutput, signMultiplier = 1) => {
      const q = `SELECT * FROM ${entity} WHERE TxnDate >= '${fromDateStr}' AND TxnDate <= '${toDateStr}' MAXRESULTS 1000`;
      const res = await fetch(
        `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}/query?query=${encodeURIComponent(q)}`,
        { headers, redirect: "manual" }
      ).catch(() => null);
      if (!res?.ok) return 0;
      const json = await res.json().catch(() => null);
      const rows = json?.QueryResponse?.[entity] || [];
      for (const row of rows) {
        const tax = Number(row?.TxnTaxDetail?.TotalTax) || 0;
        if (tax === 0) continue;
        const dt = parseXeroDateObj(row.TxnDate);
        if (dt) addVat(dt, isOutput, tax * signMultiplier);
      }
      return rows.length;
    };
    const counts = await Promise.all([
      runQbQuery("Invoice", true, 1),
      runQbQuery("SalesReceipt", true, 1),
      runQbQuery("CreditMemo", true, -1),
      runQbQuery("Bill", false, 1),
      runQbQuery("Purchase", false, 1),
      runQbQuery("VendorCredit", false, -1),
    ]);
    return {
      source: "QuickBooks transactions",
      totalFetched: counts.reduce((s, n) => s + n, 0),
      byMonth,
    };
  }

  return null;
}

const STRONG_VAT_PAY_RE = /\bhmrc\b.*\bvat\b|\bvat\b.*\bhmrc\b|\bvat\s*(?:payment|return|dd|direct\s*debit|settlement|refund)\b|\bvalue\s*added\b/i;
const HMRC_AMBIGUOUS_RE = /\bhmrc\b|\bhm\s*revenue\b|\binland\s*revenue\b/i;
const NON_VAT_TAX_RE = /\bpaye\b|\bnic\b|\bnational\s*insurance\b|\bcorp(?:oration)?\s*tax\b|\bcis\b|\bp11d\b/i;

/**
 * Looks for actual HMRC VAT payments (or refunds) already settled in Xero / QuickBooks
 * for initial VAT slots whose return period has ended on or before today.
 */
async function fetchAccountingActualVatPayments(auth, slotSpecs, todayStr) {
  if (!auth || !Array.isArray(slotSpecs) || slotSpecs.length === 0) return {};
  const activeSlots = slotSpecs.filter((s) => s.windowFromStr && s.windowFromStr <= todayStr);
  if (activeSlots.length === 0) return {};

  const minFromStr = activeSlots.map((s) => s.windowFromStr).sort()[0];
  const maxToStr = activeSlots
    .map((s) => (s.windowToStr < todayStr ? s.windowToStr : todayStr))
    .sort()
    .slice(-1)[0];
  if (!minFromStr || !maxToStr || minFromStr > maxToStr) return {};

  const candidates = []; // { id, dateStr, monthKey, amountOwed, contactName, reference, accountCode, accountName, isExplicitVat, source }

  if (auth.tool === "Xero") {
    const headers = {
      Authorization: `Bearer ${auth.accessToken}`,
      "xero-tenant-id": auth.tenantId,
      Accept: "application/json",
    };

    // Resolve VAT control liability account code(s) (e.g. 820 "VAT", SystemAccount === "GST")
    const vatAccountMap = new Map(); // code -> name
    const acctRes = await fetch("https://api.xero.com/api.xro/2.0/Accounts", { headers, redirect: "manual" }).catch(() => null);
    if (acctRes?.ok) {
      const acctJson = await acctRes.json().catch(() => null);
      for (const acct of acctJson?.Accounts || []) {
        const typ = String(acct.Type || "").toUpperCase();
        const isLiab = ["CURRLIAB", "LIABILITY", "TERMLIAB"].includes(typ);
        const isGst = String(acct.SystemAccount || "").toUpperCase() === "GST";
        if (isGst || (isLiab && /\bvat\b|value\s*added|sales\s*tax|gst/i.test(acct.Name || ""))) {
          if (acct.Code) vatAccountMap.set(String(acct.Code), String(acct.Name || "VAT"));
        }
      }
    }

    const [y1, m1, d1] = minFromStr.split("-").map(Number);
    const [y2, m2, d2] = maxToStr.split("-").map(Number);
    const btWhere = `Date>=DateTime(${y1},${m1},${d1}) AND Date<=DateTime(${y2},${m2},${d2})`;

    const rawBtMatches = [];
    for (let page = 1; page <= 10; page++) {
      const url = `https://api.xero.com/api.xro/2.0/BankTransactions?where=${encodeURIComponent(btWhere)}&page=${page}`;
      const res = await fetch(url, { headers, redirect: "manual" }).catch(() => null);
      if (!res?.ok) break;
      const json = await res.json().catch(() => null);
      const bts = json?.BankTransactions || [];
      for (const bt of bts) {
        const st = String(bt.Status || "").toUpperCase();
        const typ = String(bt.Type || "").toUpperCase();
        if (["DELETED", "VOIDED"].includes(st)) continue;
        if (typ.includes("TRANSFER")) continue;
        if (!typ.startsWith("SPEND") && !typ.startsWith("RECEIVE")) continue;

        const contactName = String(bt.Contact?.Name || "").trim();
        const reference = String(bt.Reference || "").trim();
        const text = `${contactName} ${reference}`.trim();
        if (NON_VAT_TAX_RE.test(text)) continue;

        const isExplicitVat = STRONG_VAT_PAY_RE.test(text);
        const isAmbiguousHmrc = !isExplicitVat && HMRC_AMBIGUOUS_RE.test(text);
        if (!isExplicitVat && !isAmbiguousHmrc) continue;

        rawBtMatches.push({ bt, isExplicitVat, contactName, reference, typ });
      }
      if (bts.length < 100) break;
    }

    // Fetch line-item account details for candidate HMRC/VAT bank transactions (typically 0-5 rows)
    await Promise.all(
      rawBtMatches.slice(0, 12).map(async (item) => {
        const { bt, isExplicitVat, contactName, reference, typ } = item;
        const dt = parseXeroDateObj(bt.Date);
        if (!dt) return;
        const dateStr = fmtIso(dt);
        const rate = Number(bt.CurrencyRate) || 1;
        const rawTotal = Number(bt.Total) || 0;
        const gbpTotal = rate !== 1 && rate > 0 ? rawTotal / rate : rawTotal;
        const sign = typ.startsWith("RECEIVE") ? -1 : 1; // RECEIVE from HMRC = VAT refund (negative owed)

        let lines = Array.isArray(bt.LineItems) && bt.LineItems.length > 0 ? bt.LineItems : null;
        if (!lines && bt.BankTransactionID) {
          const detRes = await fetch(
            `https://api.xero.com/api.xro/2.0/BankTransactions/${encodeURIComponent(bt.BankTransactionID)}`,
            { headers, redirect: "manual" }
          ).catch(() => null);
          if (detRes?.ok) {
            const detJson = await detRes.json().catch(() => null);
            lines = detJson?.BankTransactions?.[0]?.LineItems || null;
          }
        }

        let vatLineAmt = 0;
        let matchedAcctCode = "";
        let matchedAcctName = "";
        let hasNonVatAcctLine = false;
        if (lines && lines.length > 0) {
          for (const li of lines) {
            const code = String(li.AccountCode || "");
            const lineDesc = String(li.Description || "");
            if (vatAccountMap.size > 0 && vatAccountMap.has(code)) {
              const lAmt = Number(li.LineAmount) || 0;
              vatLineAmt += rate !== 1 && rate > 0 ? lAmt / rate : lAmt;
              matchedAcctCode = code;
              matchedAcctName = vatAccountMap.get(code) || "VAT";
            } else if (NON_VAT_TAX_RE.test(lineDesc) || (code && vatAccountMap.size > 0 && !vatAccountMap.has(code))) {
              hasNonVatAcctLine = true;
            }
          }
        }

        // Reject ambiguous "HMRC" entries if line items show a non-VAT account (e.g. 825 PAYE or 835)
        if (!isExplicitVat && vatLineAmt === 0 && (hasNonVatAcctLine || vatAccountMap.size > 0)) {
          return;
        }

        const effectiveAmt = vatLineAmt !== 0 ? vatLineAmt : gbpTotal;
        if (Math.abs(effectiveAmt) < 0.01) return;

        candidates.push({
          id: bt.BankTransactionID || `${dateStr}_${effectiveAmt}`,
          dateStr,
          monthKey: monthKeyFromDate(dt),
          amountOwed: round2(sign * Math.abs(effectiveAmt)),
          contactName: contactName || "HMRC VAT",
          reference,
          accountCode: matchedAcctCode,
          accountName: matchedAcctName,
          isExplicitVat: isExplicitVat || Boolean(matchedAcctCode),
          source: "Xero bank transaction",
        });
      })
    );

    // Also inspect Bill Payments (ACCPAY paid to HMRC VAT) in case the client entered a Bill rather than Spend Money
    const payWhere = `Date>=DateTime(${y1},${m1},${d1}) AND Date<=DateTime(${y2},${m2},${d2})`;
    const payRes = await fetch(
      `https://api.xero.com/api.xro/2.0/Payments?where=${encodeURIComponent(payWhere)}`,
      { headers, redirect: "manual" }
    ).catch(() => null);
    if (payRes?.ok) {
      const payJson = await payRes.json().catch(() => null);
      for (const p of payJson?.Payments || []) {
        if (String(p.Status || "").toUpperCase() === "DELETED") continue;
        const cName = String(p.Invoice?.Contact?.Name || "").trim();
        const ref = String(p.Reference || p.Invoice?.Reference || "").trim();
        const text = `${cName} ${ref}`.trim();
        if (!text || NON_VAT_TAX_RE.test(text) || !STRONG_VAT_PAY_RE.test(text)) continue;
        const dt = parseXeroDateObj(p.Date);
        if (!dt) continue;
        const amt = Number(p.Amount) || 0;
        if (amt <= 0) continue;
        const invType = String(p.Invoice?.Type || "").toUpperCase();
        const sign = invType === "ACCREC" || invType === "ACCPAYCREDIT" ? -1 : 1;
        candidates.push({
          id: p.PaymentID || `${fmtIso(dt)}_${amt}`,
          dateStr: fmtIso(dt),
          monthKey: monthKeyFromDate(dt),
          amountOwed: round2(sign * amt),
          contactName: cName || "HMRC VAT",
          reference: ref,
          accountCode: "",
          accountName: "",
          isExplicitVat: true,
          source: "Xero bill payment",
        });
      }
    }
  } else if (auth.tool === "QuickBooks") {
    const realmId = assertValidQBRealmId(auth.realmId);
    const headers = { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" };

    const vatAcctIds = new Map();
    const acctQuery = "SELECT Id, Name, AccountType, Classification FROM Account WHERE Classification = 'Liability' MAXRESULTS 200";
    const acctRes = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}/query?query=${encodeURIComponent(acctQuery)}`,
      { headers, redirect: "manual" }
    ).catch(() => null);
    if (acctRes?.ok) {
      const acctJson = await acctRes.json().catch(() => null);
      for (const a of acctJson?.QueryResponse?.Account || []) {
        if (/\bvat\b|value\s*added|sales\s*tax|gst/i.test(a.Name || "")) {
          vatAcctIds.set(String(a.Id), String(a.Name));
        }
      }
    }

    const qPurchase = `SELECT * FROM Purchase WHERE TxnDate >= '${minFromStr}' AND TxnDate <= '${maxToStr}' MAXRESULTS 500`;
    const pRes = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}/query?query=${encodeURIComponent(qPurchase)}`,
      { headers, redirect: "manual" }
    ).catch(() => null);
    if (pRes?.ok) {
      const pJson = await pRes.json().catch(() => null);
      for (const pur of pJson?.QueryResponse?.Purchase || []) {
        const contactName = String(pur.EntityRef?.name || "").trim();
        const ref = String(pur.PrivateNote || pur.DocNumber || "").trim();
        const text = `${contactName} ${ref}`.trim();
        if (NON_VAT_TAX_RE.test(text)) continue;

        let vatLineAmt = 0;
        let matchedAcct = "";
        for (const li of pur.Line || []) {
          const acctId = String(li.AccountBasedExpenseLineDetail?.AccountRef?.value || "");
          if (acctId && vatAcctIds.has(acctId)) {
            vatLineAmt += Number(li.Amount) || 0;
            matchedAcct = vatAcctIds.get(acctId) || "VAT";
          }
        }
        const isExplicitVat = STRONG_VAT_PAY_RE.test(text) || vatLineAmt !== 0;
        if (!isExplicitVat && !HMRC_AMBIGUOUS_RE.test(text)) continue;
        if (!isExplicitVat && vatAcctIds.size > 0 && vatLineAmt === 0) continue;

        const dt = parseXeroDateObj(pur.TxnDate);
        if (!dt) continue;
        const total = vatLineAmt !== 0 ? vatLineAmt : Number(pur.TotalAmt) || 0;
        if (Math.abs(total) < 0.01) continue;
        const isRefund = Boolean(pur.Credit);
        candidates.push({
          id: `qb_${pur.Id}`,
          dateStr: fmtIso(dt),
          monthKey: monthKeyFromDate(dt),
          amountOwed: round2((isRefund ? -1 : 1) * Math.abs(total)),
          contactName: contactName || "HMRC VAT",
          reference: ref,
          accountCode: "",
          accountName: matchedAcct,
          isExplicitVat,
          source: "QuickBooks expense",
        });
      }
    }
  }

  // Assign best matching actual payment per active slot
  const bySlotKey = {};
  for (const slot of activeSlots) {
    const slotEnd = slot.windowToStr < todayStr ? slot.windowToStr : todayStr;
    const inWindow = candidates.filter((c) => c.dateStr >= slot.windowFromStr && c.dateStr <= slotEnd);
    if (inWindow.length === 0) continue;

    inWindow.sort((a, b) => {
      const aInExpected = a.monthKey === slot.paymentMonthKey ? 1 : 0;
      const bInExpected = b.monthKey === slot.paymentMonthKey ? 1 : 0;
      if (aInExpected !== bInExpected) return bInExpected - aInExpected;

      const aExplicitContact = STRONG_VAT_PAY_RE.test(`${a.contactName} ${a.reference}`) ? 1 : 0;
      const bExplicitContact = STRONG_VAT_PAY_RE.test(`${b.contactName} ${b.reference}`) ? 1 : 0;
      if (aExplicitContact !== bExplicitContact) return bExplicitContact - aExplicitContact;

      return Math.abs(b.amountOwed) - Math.abs(a.amountOwed);
    });

    const best = inWindow[0];
    bySlotKey[slot.slotKey] = {
      amount: best.amountOwed,
      date: best.dateStr,
      contactName: best.contactName,
      reference: best.reference,
      accountCode: best.accountCode,
      accountName: best.accountName,
      source: best.source,
      inExpectedMonth: best.monthKey === slot.paymentMonthKey,
    };
  }

  return bySlotKey;
}

/**
 * Loads initial Corporation Tax & initial VAT payment estimates for Step 2 Setup.
 */
export async function loadInitialTaxSetupData({ clientName, masterSheetId }) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const kiResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: [
        "KeyInfo!B2",   // [0] Start date
        "KeyInfo!B4",   // [1] Corp tax deadline formula/val
        "KeyInfo!B6:B10", // [2] B6 quarters, B7 months, B8 scheme, B9 rate, B10 tax payment method
        "KeyInfo!F6",   // [3] VAT stagger 1|2|3
        "KeyInfo!X28",  // [4] Client sheet ID
        "KeyInfo!D4",   // [5] Currency symbol
      ],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );

  const mvr = kiResp.data?.valueRanges || [];
  const startDate = parseYear0Date(mvr[0]?.values?.[0]?.[0]);
  if (!startDate) throw new Error("A valid start date is required in KeyInfo!B2.");

  const b6to10 = mvr[2]?.values || [];
  const vatQuarters = String(b6to10[0]?.[0] || "Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec").trim();
  const vatMonths = String(b6to10[1]?.[0] || "").trim();
  const vatScheme = String(b6to10[2]?.[0] || "Accrual").trim();
  const rawVatRate = parseYear0Number(b6to10[3]?.[0]);
  const vatRate = rawVatRate > 1 ? rawVatRate / 100 : rawVatRate > 0 ? rawVatRate : 0.2;
  const taxPaymentMethod = String(b6to10[4]?.[0] || "Standard").trim() || "Standard";
  const rawF6 = parseInt(mvr[3]?.values?.[0]?.[0], 10);
  const f6 = [1, 2, 3].includes(rawF6) ? rawF6 : computeVatCycleIndexF6(startDate, vatQuarters);
  const cleanClientId = await resolveClientSheetIdFromMaster({
    clientName,
    masterSheetId: cleanMasterId,
    rawKeyInfoX28: mvr[4]?.values?.[0]?.[0] || "",
  });
  if (!cleanClientId) throw new Error("Client workspace sheet ID is not configured.");
  const currencySymbol = String(mvr[5]?.values?.[0]?.[0] || "£").trim() || "£";
  const currency = currencySymbol === "$" ? "USD" : currencySymbol === "€" ? "EUR" : "GBP";

  const [clientResp, year0Data, auth] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: cleanClientId,
        ranges: [
          "Cash!A19:R22",   // [0] R19 Corp tax, R21 VAT
          "Cash!A61:R64",   // [1] R61 Corp tax incl pipe, R63 VAT incl pipe
          "VAT!A8:I8",      // [2] Confirmed accrual net VAT (M1..M3 = G..I)
          "VAT!A22:I22",    // [3] Confirmed cash net VAT (M1..M3 = G..I)
          "VAT!G32:J35",    // [4] Initial VAT payment schedule cells
          "Performance!G55" // [5] Corp tax rate
        ],
        valueRenderOption: "FORMULA",
      })
    ),
    getYear0SetupData({ clientName, masterSheetId: cleanMasterId }).catch(() => null),
    resolveAccountingToolAuth(clientName, cleanMasterId).catch(() => null),
  ]);

  const cvr = clientResp.data?.valueRanges || [];
  const cashJ19Raw = cvr[0]?.values?.[0]?.[9]; // Col J = index 9
  const cashB21toE21 = (cvr[0]?.values?.[2] || []).slice(1, 5); // Cols B..E = idx 1..4
  const vatG8toI8 = (cvr[2]?.values?.[0] || []).slice(6, 9);
  const vatG22toI22 = (cvr[3]?.values?.[0] || []).slice(6, 9);
  const vatScheduleGrid = cvr[4]?.values || [];

  // ── 1. CORPORATION TAX ESTIMATION ──────────────────────────────────────────
  const year0EndDate = new Date(startDate.getFullYear(), startDate.getMonth(), 0);
  const year0EndStr = fmtIso(year0EndDate);
  const corpTaxMonthDate = new Date(startDate.getFullYear(), startDate.getMonth() + 8, 1);

  let year0Revenue = 0;
  let year0NonStaffCosts = 0;
  let year0StaffCosts = 0;
  let year0DividendsAddedBack = 0;
  let year0TaxableProfit = 0;
  const year0MonthlyRev = Array(12).fill(0);
  const year0MonthlyNonStaff = Array(12).fill(0);
  const year0MonthlyVatPnl = Array(12).fill(0);

  if (year0Data) {
    for (let m = 0; m < 12; m++) {
      const rev =
        parseYear0Number(year0Data.baseData?.revenue?.[m]) +
        parseYear0Number(year0Data.adjustments?.revenue?.[m]);
      const cosStaff = parseYear0Number(year0Data.baseData?.cosStaff?.[m]);
      const cosOther =
        parseYear0Number(year0Data.baseData?.cosOther?.[m]) +
        parseYear0Number(year0Data.adjustments?.costOfSales?.[m]);
      const nonCosStaff = parseYear0Number(year0Data.baseData?.nonCosStaff?.[m]);
      const ohOther =
        parseYear0Number(year0Data.baseData?.overheadsOther?.[m]) +
        parseYear0Number(year0Data.adjustments?.overheads?.[m]);
      const divM = parseYear0Number(year0Data.dividends?.monthly?.[m]);

      year0Revenue += rev;
      year0StaffCosts += cosStaff + nonCosStaff;
      year0NonStaffCosts += cosOther + ohOther;
      year0DividendsAddedBack += divM;
      year0MonthlyRev[m] = round2(rev);
      year0MonthlyNonStaff[m] = round2(cosOther + ohOther);
      year0MonthlyVatPnl[m] = round2((rev - (cosOther + ohOther)) * vatRate);
    }
    year0Revenue = round2(year0Revenue);
    year0StaffCosts = round2(year0StaffCosts);
    year0NonStaffCosts = round2(year0NonStaffCosts);
    year0DividendsAddedBack = round2(year0DividendsAddedBack);
    year0TaxableProfit = round2(year0Revenue - year0StaffCosts - year0NonStaffCosts);
  }

  const ukTieredEstimate = calculateUkTieredCorpTax(year0TaxableProfit, {
    smallRatePct: 19,
    mainRatePct: 25,
    lowerLimit: 50000,
    upperLimit: 250000,
  });

  // ── 2. INITIAL VAT SLOTS & ACCOUNTING PULLS ────────────────────────────────
  const slotSpecs = buildInitialVatSlotSpecs(f6, startDate);
  const today = new Date();
  const todayStr = fmtIso(today);

  // Earliest Year 0 month needed across all slots, up to min(latest end, today)
  const allFromDates = slotSpecs.flatMap((s) => s.coveredMonths.map((cm) => cm.fromDateStr)).sort();
  const allHistoricalEnds = slotSpecs
    .flatMap((s) => s.coveredMonths.map((cm) => cm.toDateStr))
    .filter((dStr) => dStr <= todayStr)
    .sort();
  const txnFromStr = allFromDates[0] || "";
  const txnToStr = allHistoricalEnds[allHistoricalEnds.length - 1] || "";

  // Fetch Balance Sheet at Year 0 end (and per-quarter end if needed) + transaction VAT
  const distinctBsDates = Array.from(
    new Set([
      year0EndStr,
      ...slotSpecs.map((s) => {
        const lastHist = [...s.coveredMonths].reverse().find((cm) => cm.toDateStr <= todayStr);
        return lastHist?.toDateStr || year0EndStr;
      }),
    ])
  );

  const [bsResults, acctVatTxns, actualVatPaymentsBySlot] = await Promise.all([
    Promise.all(distinctBsDates.map((dt) => fetchAccountingBalanceSheetTaxes(auth, dt, vatScheme).catch(() => null))),
    fetchAccountingMonthlyNetVat(auth, txnFromStr, txnToStr, vatScheme).catch(() => null),
    fetchAccountingActualVatPayments(auth, slotSpecs, todayStr).catch(() => ({})),
  ]);

  const bsByDate = new Map();
  distinctBsDates.forEach((dt, i) => bsByDate.set(dt, bsResults[i]));
  const year0Bs = bsByDate.get(year0EndStr) || null;
  const bsCorpTaxBalance = round2(year0Bs?.corpTaxTotal || 0);

  const parsedJ19 = parseSavedFormulaOrValue(cashJ19Raw, -1000000);
  const suggestedCorpTax = parsedJ19.hasValue
    ? parsedJ19.savedPositiveOwed
    : bsCorpTaxBalance > 0
      ? bsCorpTaxBalance
      : ukTieredEstimate.tax;

  // Read client VAT! tab monthly values (if non-formula static/evaluated or read UNFORMATTED_VALUE too)
  let vatTabMonthlyNet = [0, 0, 0];
  try {
    const vatValResp = await withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: cleanClientId,
        ranges: [vatScheme === "Cash" ? "VAT!G22:I22" : "VAT!G8:I8"],
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    );
    const rowVals = vatValResp.data?.valueRanges?.[0]?.values?.[0] || [];
    vatTabMonthlyNet = [0, 1, 2].map((idx) => round2(parseYear0Number(rowVals[idx])));
  } catch {
    vatTabMonthlyNet = [0, 1, 2].map((idx) => {
      const rawCell = vatScheme === "Cash" ? vatG22toI22[idx] : vatG8toI8[idx];
      return typeof rawCell === "number" ? round2(rawCell) : 0;
    });
  }

  const vatSlots = slotSpecs.map((spec, idx) => {
    const schedRowIdx = vatScheme === "Cash" ? 2 : 0; // row 32 (0) or row 34 (2)
    const vatColOffset = ["G", "H", "I", "J"].indexOf(spec.vatCol);
    const rawSchedFormula = vatScheduleGrid[schedRowIdx]?.[vatColOffset];
    const parsedSched = parseSavedFormulaOrValue(rawSchedFormula, 50000);

    const cashColOffset = ["B", "C", "D", "E"].indexOf(spec.cashCol);
    const rawCashCell = cashB21toE21[cashColOffset];
    const parsedCashStatic =
      typeof rawCashCell === "number" || (typeof rawCashCell === "string" && !rawCashCell.trim().startsWith("="))
        ? { hasValue: true, savedPositiveOwed: round2(-parseYear0Number(rawCashCell)) }
        : { hasValue: false, savedPositiveOwed: null };

    const existingAmount = parsedCashStatic.hasValue
      ? parsedCashStatic.savedPositiveOwed
      : parsedSched.hasValue
        ? parsedSched.savedPositiveOwed
        : null;

    // Quarter-end Balance Sheet VAT control balance
    const lastHist = [...spec.coveredMonths].reverse().find((cm) => cm.toDateStr <= todayStr);
    const slotBs = bsByDate.get(lastHist?.toDateStr || year0EndStr) || year0Bs;
    const bsVatControlBalance = slotBs ? round2(slotBs.vatControlTotal || 0) : null;

    // Month-by-month estimate combining accounting transactions + VAT! tab (for future FY1 months) & P&L fallback
    let txnAvailableCount = 0;
    let txnCombinedTotal = 0;
    let pnlCombinedTotal = 0;
    let pnlRevTotal = 0;
    let pnlCostTotal = 0;
    const monthBreakdown = spec.coveredMonths.map((cm) => {
      const txnRow = acctVatTxns?.byMonth?.[cm.monthKey] || null;
      const vatTabAmt = cm.fy1Index !== null && cm.fy1Index >= 0 && cm.fy1Index <= 2 ? vatTabMonthlyNet[cm.fy1Index] : 0;
      const pnlYear0Amt = cm.year0Index !== null && cm.year0Index >= 0 && cm.year0Index < 12 ? year0MonthlyVatPnl[cm.year0Index] : 0;
      if (cm.year0Index !== null && cm.year0Index >= 0 && cm.year0Index < 12) {
        pnlRevTotal = round2(pnlRevTotal + year0MonthlyRev[cm.year0Index]);
        pnlCostTotal = round2(pnlCostTotal + year0MonthlyNonStaff[cm.year0Index]);
      }
      const fallbackAmt = cm.isYear0 ? pnlYear0Amt : vatTabAmt;

      let txnOrSheetAmt = fallbackAmt;
      let sourceLabel = cm.isYear0 ? "Year 0 P&L × VAT rate" : "Projected VAT forecast";
      if (txnRow && cm.toDateStr <= todayStr) {
        txnOrSheetAmt = txnRow.netVat;
        sourceLabel = `${acctVatTxns.source} (${txnRow.txnCount})`;
        txnAvailableCount += 1;
      } else if (!cm.isYear0 && vatTabAmt !== 0) {
        txnOrSheetAmt = vatTabAmt;
        sourceLabel = "FY1 VAT forecast";
      }

      txnCombinedTotal = round2(txnCombinedTotal + txnOrSheetAmt);
      pnlCombinedTotal = round2(pnlCombinedTotal + fallbackAmt);
      return {
        ...cm,
        txnNetVat: txnRow ? txnRow.netVat : null,
        vatTabAmt,
        pnlFallbackAmt: pnlYear0Amt,
        estimatedNetVat: round2(txnOrSheetAmt),
        sourceLabel,
      };
    });

    const actualPayment = actualVatPaymentsBySlot?.[spec.slotKey] || null;
    const hasTxnEstimate = Boolean(acctVatTxns && txnAvailableCount > 0);
    const defaultAmount =
      existingAmount !== null
        ? existingAmount
        : actualPayment
          ? actualPayment.amount
          : hasTxnEstimate
            ? txnCombinedTotal
            : bsVatControlBalance && bsVatControlBalance > 0
              ? bsVatControlBalance
              : pnlCombinedTotal;

    return {
      slotKey: spec.slotKey,
      slotNumber: idx + 1,
      cashCol: spec.cashCol,
      vatCol: spec.vatCol,
      f6Num: spec.f6Num,
      paymentMonthIndex: spec.paymentMonthIndex,
      paymentMonthLabel: spec.paymentMonthLabel,
      paymentMonthShort: spec.paymentMonthShort,
      periodLabel: spec.periodLabel,
      existingAmount,
      hasExistingCustomValue: existingAmount !== null,
      actualPayment,
      txnEstimate: hasTxnEstimate ? txnCombinedTotal : null,
      bsEstimate: bsVatControlBalance,
      bsAsOfDate: slotBs?.asOfDateStr || year0EndStr,
      bsMatchedAccounts: slotBs?.vatMatches || [],
      pnlEstimate: pnlCombinedTotal,
      pnlBreakdown: {
        revenue: pnlRevTotal,
        nonStaffCosts: pnlCostTotal,
      },
      recommendedAmount: round2(defaultAmount),
      monthBreakdown,
    };
  });

  return {
    clientName: clientName || "",
    currency,
    currencySymbol,
    accountingTool: auth?.tool || year0Data?.accountingTool || "",
    hasAccountingConnection: Boolean(auth),
    taxPaymentMethod,
    vatScheme,
    vatRate,
    vatQuarters,
    vatMonths,
    f6,
    corpTax: {
      paymentMonthLabel: longMonthLabel(corpTaxMonthDate),
      paymentMonthShort: shortMonthLabel(corpTaxMonthDate),
      deadlineLabel: (() => {
        const dl = new Date(startDate.getFullYear(), startDate.getMonth() + 9, 1);
        return `1 ${SHORT_MONTHS[dl.getMonth()]} ${dl.getFullYear()}`;
      })(),
      existingAmount: parsedJ19.hasValue ? parsedJ19.savedPositiveOwed : null,
      hasExistingCustomValue: parsedJ19.hasValue,
      bsProvision: year0Bs ? bsCorpTaxBalance : null,
      bsAsOfDate: year0EndStr,
      bsMatchedAccounts: year0Bs?.corpMatches || [],
      year0: {
        hasYear0PL: Boolean(year0Data?.hasYear0PL),
        revenue: year0Revenue,
        staffCosts: year0StaffCosts,
        nonStaffCosts: year0NonStaffCosts,
        dividendsAddedBack: year0DividendsAddedBack,
        taxableProfit: year0TaxableProfit,
        ukTieredEstimate,
      },
      recommendedAmount: round2(suggestedCorpTax),
    },
    vatSlots,
  };
}

/**
 * Saves confirmed Corporation Tax (Cash!J19 & Cash!J61) and initial VAT payment(s)
 * (VAT!G32:J35 & Cash!B21:E21 / Cash!B63:E63) back to the Client sheet.
 */
export async function saveInitialTaxSetupData({
  clientName,
  masterSheetId,
  corpTaxAmount = 0,
  vatSlots = [],
}) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const kiResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: ["KeyInfo!B2", "KeyInfo!B6", "KeyInfo!F6", "KeyInfo!X28"],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const svr = kiResp.data?.valueRanges || [];
  const startDate = parseYear0Date(svr[0]?.values?.[0]?.[0]);
  const vatQuarters = String(svr[1]?.values?.[0]?.[0] || "Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec").trim();
  const rawF6 = parseInt(svr[2]?.values?.[0]?.[0], 10);
  const f6 = [1, 2, 3].includes(rawF6) ? rawF6 : (startDate ? computeVatCycleIndexF6(startDate, vatQuarters) : 1);
  const cleanClientId = await resolveClientSheetIdFromMaster({
    clientName,
    masterSheetId: cleanMasterId,
    rawKeyInfoX28: svr[3]?.values?.[0]?.[0] || "",
  });
  if (!cleanClientId) throw new Error("Client workspace sheet ID is not configured.");

  const authoritativeSpecs = startDate ? buildInitialVatSlotSpecs(f6, startDate) : null;
  const specByKey = new Map((authoritativeSpecs || []).map((s) => [s.slotKey, s]));

  const ctSigned = round2(-parseYear0Number(corpTaxAmount));
  const dataWrites = [
    {
      range: "Cash!J19",
      values: [[`=if(KeyInfo!$B$10="Transfers",-Performance!N63,${ctSigned})`]],
    },
    {
      range: "Cash!J61",
      values: [[`=if(KeyInfo!$B$10="Transfers",-Performance!N58,${ctSigned})`]],
    },
    // Ensure Cash!B21:E21 & Cash!B63:E63 cleanly point to VAT!G32:J35 (fixes B63=0 template bug and any manual overwrites)
    {
      range: "Cash!B21:E21",
      values: [[
        '=if(KeyInfo!$B$10="Transfers",0,if(KeyInfo!$B$8="Accrual",VAT!G$32,VAT!G$34))',
        '=if(KeyInfo!$B$10="Transfers",if(KeyInfo!$B$8="Accrual",-VAT!G$8,-VAT!G$22),if(KeyInfo!$B$8="Accrual",VAT!H$32,VAT!H$34))',
        '=if(KeyInfo!$B$10="Transfers",if(KeyInfo!$B$8="Accrual",-VAT!H$8,-VAT!H$22),if(KeyInfo!$B$8="Accrual",VAT!I$32,VAT!I$34))',
        '=if(KeyInfo!$B$10="Transfers",if(KeyInfo!$B$8="Accrual",-VAT!I$8,-VAT!I$22),if(KeyInfo!$B$8="Accrual",VAT!J$32,VAT!J$34))',
      ]],
    },
    {
      range: "Cash!B63:E63",
      values: [[
        '=if(KeyInfo!$B$10="Transfers",0,if(KeyInfo!$B$8="Accrual",VAT!G$33,VAT!G$35))',
        '=if(KeyInfo!$B$10="Transfers",if(KeyInfo!$B$8="Accrual",-VAT!G$15,-VAT!G$29),if(KeyInfo!$B$8="Accrual",VAT!H$33,VAT!H$35))',
        '=if(KeyInfo!$B$10="Transfers",if(KeyInfo!$B$8="Accrual",-VAT!H$15,-VAT!H$29),if(KeyInfo!$B$8="Accrual",VAT!I$33,VAT!I$35))',
        '=if(KeyInfo!$B$10="Transfers",if(KeyInfo!$B$8="Accrual",-VAT!I$15,-VAT!I$29),if(KeyInfo!$B$8="Accrual",VAT!J$33,VAT!J$35))',
      ]],
    },
  ];

  const validCols = new Set(["G", "H", "I", "J"]);
  const savedVatSummary = [];
  for (const slot of vatSlots || []) {
    const slotKey = String(slot?.slotKey || "").trim().toLowerCase();
    const authSpec = slotKey ? specByKey.get(slotKey) : null;
    const vatCol = authSpec ? authSpec.vatCol : String(slot?.vatCol || "").trim().toUpperCase();
    const f6Num = authSpec ? authSpec.f6Num : Number(slot?.f6Num);
    if (!validCols.has(vatCol) || ![1, 2, 3].includes(f6Num)) continue;
    if (authoritativeSpecs && !authoritativeSpecs.some((s) => s.vatCol === vatCol && s.f6Num === f6Num)) continue;
    const vatSigned = round2(-parseYear0Number(slot.amount));
    const formula = `=if(KeyInfo!$F$6=${f6Num},${vatSigned},0)`;
    dataWrites.push({
      range: `VAT!${vatCol}32:${vatCol}35`,
      values: [[formula], [formula], [formula], [formula]],
    });
    savedVatSummary.push(`${authSpec?.paymentMonthShort || slot.paymentMonthShort || vatCol}: ${round2(parseYear0Number(slot.amount))}`);
  }

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cleanClientId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: dataWrites,
      },
    })
  );

  if (cleanClientId.startsWith("sb-") || cleanMasterId.startsWith("sb-")) {
    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, clientName || cleanMasterId).catch(() => {});
  }
  await invalidatePmaClientCache(cleanClientId, cleanMasterId, ["cash", "views", "dashboard", "all"]).catch(() => {});

  await logPmaActivity(sheets, {
    clientName: clientName || "",
    category: "SETUP",
    action: "INITIAL_TAX_ESTIMATES_UPDATED",
    summary: `Updated initial tax estimates (Corp Tax: ${round2(parseYear0Number(corpTaxAmount))}; VAT: ${savedVatSummary.join(", ") || "none"})`,
    details: { corpTaxAmount: round2(parseYear0Number(corpTaxAmount)), vatSlots },
  }).catch(() => {});

  return {
    success: true,
    corpTaxAmount: round2(parseYear0Number(corpTaxAmount)),
    vatSlotsSaved: savedVatSummary.length,
  };
}
