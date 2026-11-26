/**
 * ============================================================================
 * INITIAL INVOICES SETUP SERVICE (services/initialInvoicesService.js)
 * ============================================================================
 *
 * Powers the "Initial invoice setup" onboarding step:
 * 1. Imports all sales invoices from the connected accounting tool (Xero or
 *    QuickBooks) for the 12 months leading up to the system start date (KeyInfo!B2).
 * 2. Analyses imported invoices per client & amount to detect recurring retainers
 *    (monthly, quarterly, or other periods) and suggests retainer jobs named
 *    "Retainer (Mmm-yy-)" with Start date >= B2 - 3 months and End date = "No end date".
 * 3. Creates confirmed retainer jobs (with relevant >= cutoff3m invoices assigned
 *    to child rows) and creates individual Project jobs for remaining invoices
 *    dated >= B2 - 3 months.
 */

import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import { resolveAccountingToolAuth } from "./accountingSuggestionsService.js";
import { assertValidQBRealmId } from "./quickbooksService.js";
import { parseYear0Date } from "./year0SetupService.js";
import { provisionRetainerChildRows_, retFindTrueLastRow } from "./retainers.js";
import { getToleranceValues } from "./sharedHelpers.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import {
  flushImmediateAndScheduleBackgroundClientRecomputes,
  resolveClientSheetIdFromMaster,
} from "./masterEngineService.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeFormulaInput } from "./userPermissions.js";
import {
  NO_END_DATE_SHEET_VALUE,
  toSheetDateFormat,
  formatInvoiceNumber,
  formatInvoiceRefForSheet,
  canonicalizeInvoiceStatus,
  isJobCostingStyle,
  getJobCostingRowFormulasMap,
} from "../utils/helpers.js";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function resolveCleanId(rawId) {
  if (!rawId) return "";
  const unwrapped = unwrapSheetId(String(rawId).trim());
  return extractSheetIdFromUrl(unwrapped) || unwrapped;
}

function addMonthsSafe(date, months) {
  const d = new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
  // Guard against end-of-month overflow (e.g. May 31 - 3 -> Feb 28)
  const expectedMonth = (((date.getMonth() + months) % 12) + 12) % 12;
  if (d.getMonth() !== expectedMonth) {
    return new Date(d.getFullYear(), d.getMonth(), 0);
  }
  return d;
}

export function formatDMmmYyyy(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return "";
  return `${date.getDate()}-${SHORT_MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

export function formatRetainerJobName(startDate, detail = "") {
  if (!startDate || !(startDate instanceof Date) || isNaN(startDate.getTime())) {
    return detail ? `${detail} retainer` : "Retainer";
  }
  const mmm = SHORT_MONTHS[startDate.getMonth()];
  const yy = String(startDate.getFullYear()).slice(-2);
  const cleanDetail = String(detail || "").trim();
  if (cleanDetail) {
    return `${cleanDetail} retainer (${mmm} ${yy}-)`;
  }
  return `Retainer (${mmm}-${yy}-)`;
}

const FULL_AND_SHORT_MONTH_RE = /\b(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)(?:\s*[-/]?\s*\d{2,4})?\b/gi;
const YEAR_TOKEN_RE = /\b20\d{2}\b/g;

/**
 * Strips month/year tokens, generic cadence/retainer filler words, and redundant client name
 * from an invoice Reference or Line Description to yield a clean retainer label.
 */
export function cleanRetainerDetailText(rawText, clientName = "") {
  let s = String(rawText || "").trim();
  if (!s) return "";

  // Strip glued month+year like "November2026"
  s = s.replace(/\b(january|february|march|april|may|june|july|august|september|sept|october|november|december)\d{2,4}\b/gi, " ");
  s = s.replace(FULL_AND_SHORT_MONTH_RE, " ");
  s = s.replace(YEAR_TOKEN_RE, " ");
  s = s.replace(/\b(monthly|quarterly|bi-?monthly|annual|annually|retainer|retianer)\b/gi, " ");

  // Remove exact client name or significant client name prefix words if repeated inside ref/desc
  const clientTokens = String(clientName || "")
    .replace(/\b(ltd|limited|inc|llc|gmbh|srl|plc|co|uk)\b/gi, " ")
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/gi, ""))
    .filter((t) => t.length >= 3);
  if (clientTokens.length > 0) {
    const escapedFull = clientTokens.join("\\s+");
    s = s.replace(new RegExp(`\\b${escapedFull}\\b`, "gi"), " ");
  }

  s = s
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:,/&|]+|[\s\-–—:,/&|]+$/g, "")
    .replace(/^(?:for|re|the)\s+/i, "")
    .replace(/\s+(?:for|re|the)$/i, "")
    .replace(/^[\s\-–—:,/&|]+|[\s\-–—:,/&|]+$/g, "")
    .trim();

  if (!s || /^\d+$/.test(s)) return "";
  return s.slice(0, 50).trim();
}

/**
 * Extracts representative raw and cleaned invoice Reference and Line Description
 * candidates across a retainer's matched invoices.
 */
export function extractRetainerDetailCandidates(matchedInvoices = [], clientName = "") {
  const ordered = [...matchedInvoices].reverse(); // newest first
  let sampleReference = "";
  let sampleDescription = "";
  let referenceDetail = "";
  let descriptionDetail = "";

  for (const inv of ordered) {
    if (!sampleReference && inv.reference) sampleReference = String(inv.reference).trim();
    if (!sampleDescription && inv.description) sampleDescription = String(inv.description).trim();
    if (!referenceDetail && inv.reference) {
      const cleaned = cleanRetainerDetailText(inv.reference, clientName);
      if (cleaned) referenceDetail = cleaned;
    }
    if (!descriptionDetail && inv.description) {
      // Take primary line snippet before multi-line joiner " - " if long
      const primaryDesc = String(inv.description).split(" - ")[0].trim();
      const cleaned =
        cleanRetainerDetailText(primaryDesc, clientName) ||
        cleanRetainerDetailText(inv.description, clientName);
      if (cleaned) descriptionDetail = cleaned;
    }
    if (referenceDetail && descriptionDetail) break;
  }

  const preferredDetail = referenceDetail || descriptionDetail || "";
  return {
    sampleReference,
    sampleDescription,
    referenceDetail,
    descriptionDetail,
    preferredDetail,
  };
}

function getFrequencyLabel(periodMonths) {
  if (periodMonths === 1) return "Monthly";
  if (periodMonths === 2) return "Bi-monthly";
  if (periodMonths === 3) return "Quarterly";
  if (periodMonths === 4) return "Every 4 months";
  if (periodMonths === 6) return "Semi-annual";
  if (periodMonths === 12) return "Annual";
  return `Every ${periodMonths} months`;
}

function normalizeClientKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\s+/g, " ");
}

function resolveImportMode(rawMode) {
  return String(rawMode || "").trim().toLowerCase() === "lines" ? "Lines" : "Whole";
}

function resolveInvFormatRule(rawRule) {
  return String(rawRule || "Full").trim() || "Full";
}

function applyInvFormat(rawInvNo, invFormatRule = "Full") {
  const raw = String(rawInvNo || "").trim();
  if (!raw) return "";
  return formatInvoiceNumber(raw, invFormatRule) || raw;
}

function resolveXeroInvoiceStatus(inv, isPaid) {
  if (isPaid) return "Paid";
  const statusUpper = String(inv?.Status || "").toUpperCase();
  const sentToContact =
    inv?.SentToContact === true || String(inv?.SentToContact || "").toUpperCase() === "TRUE";
  if (
    (statusUpper === "AUTHORISED" || statusUpper === "AWAITING_PAYMENT" || statusUpper === "OVERDUE") &&
    sentToContact
  ) {
    return "Sent";
  }
  if (statusUpper === "AUTHORISED") return "Draft";
  return "Sent";
}

/**
 * Extracts latest payment date from a Xero invoice object (1:1 with getXeroInvoices).
 */
function getLatestXeroPaymentDate(inv) {
  if (inv.FullyPaidOnDate) return inv.FullyPaidOnDate;
  const parseEpoch = (raw) => {
    if (!raw) return 0;
    const match = String(raw).match(/\/Date\((\d+)/);
    if (match) return parseInt(match[1], 10);
    const d = new Date(raw);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  };
  let latestRaw = "";
  let latestMs = 0;
  for (const p of inv.Payments || []) {
    if (p.Status === "DELETED") continue;
    const ms = parseEpoch(p.Date);
    if (ms > latestMs) {
      latestMs = ms;
      latestRaw = p.Date;
    }
  }
  for (const cn of inv.CreditNotes || []) {
    const ms = parseEpoch(cn.AppliedDate || cn.Date);
    if (ms > latestMs) {
      latestMs = ms;
      latestRaw = cn.AppliedDate || cn.Date;
    }
  }
  for (const alloc of [...(inv.Prepayments || []), ...(inv.Overpayments || [])]) {
    const ms = parseEpoch(alloc.AppliedDate || alloc.Date);
    if (ms > latestMs) {
      latestMs = ms;
      latestRaw = alloc.AppliedDate || alloc.Date;
    }
  }
  return latestRaw;
}

/**
 * Fetches ACCREC invoices from Xero on or after cutoff12m (1:1 with getXeroInvoices + evaluateInvAppList).
 */
async function fetchXeroInvoicesForWindow(
  auth,
  cutoff12m,
  defaultDaysToPay = 30,
  { importMode = "Whole", invFormatRule = "Full" } = {}
) {
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "xero-tenant-id": auth.tenantId,
    Accept: "application/json",
  };
  const baseUrl = 'https://api.xero.com/api.xro/2.0/Invoices?where=Type%3d%3d%22ACCREC%22&order=Date%20DESC';
  const allInvoices = [];
  let page = 1;
  let keepFetching = true;

  while (keepFetching && page <= 50) {
    if (page > 1) await new Promise((r) => setTimeout(r, 250));
    const res = await fetch(`${baseUrl}&page=${page}`, { headers, redirect: "manual" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Xero invoices request failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    const pageInvoices = json?.Invoices || [];
    if (pageInvoices.length === 0) break;

    allInvoices.push(...pageInvoices);
    const lastInv = pageInvoices[pageInvoices.length - 1];
    const lastDate = parseYear0Date(lastInv.DateString || lastInv.Date);
    if (lastDate && lastDate < cutoff12m) {
      keepFetching = false;
    } else {
      page++;
    }
  }

  const normalized = [];
  for (const inv of allInvoices) {
    const statusUpper = String(inv.Status || "").toUpperCase();
    if (statusUpper === "VOIDED" || statusUpper === "DELETED" || statusUpper === "DRAFT") continue;

    const sendDate = parseYear0Date(inv.DateString || inv.Date);
    if (!sendDate || sendDate < cutoff12m) continue;

    const baseInvNo = String(inv.InvoiceNumber || inv.InvoiceID || "").trim();
    if (!baseInvNo) continue;

    const originalTotal = Number(inv.Total) || 0;
    const credit = Number(inv.AmountCredited) || 0;
    const effectiveTotal = round2(originalTotal - credit);
    const ratio = originalTotal > 0 ? effectiveTotal / originalTotal : 1;
    const currencyRate = Number(inv.CurrencyRate) > 0 ? Number(inv.CurrencyRate) : 1;
    const amountPaid = Number(inv.AmountPaid) || 0;
    const paidDate = parseYear0Date(getLatestXeroPaymentDate(inv));
    const dueDate = parseYear0Date(inv.DueDateString || inv.DueDate);

    let daysToPay = defaultDaysToPay;
    if (paidDate && sendDate) {
      daysToPay = Math.max(0, Math.round((paidDate.getTime() - sendDate.getTime()) / 86400000));
    } else if (dueDate && sendDate) {
      daysToPay = Math.max(0, Math.round((dueDate.getTime() - sendDate.getTime()) / 86400000));
    }

    const isPaid = statusUpper === "PAID" || (effectiveTotal > 0 && amountPaid >= effectiveTotal - 0.01);
    const status = resolveXeroInvoiceStatus(inv, isPaid);
    const sendDateIso = `${sendDate.getFullYear()}-${String(sendDate.getMonth() + 1).padStart(2, "0")}-${String(sendDate.getDate()).padStart(2, "0")}`;
    const sendDateFormatted = formatDMmmYyyy(sendDate);
    const client = String(inv.Contact?.Name || "").trim() || "Unknown client";
    const contactId = String(inv.Contact?.ContactID || "").trim();
    const clampedDays = Math.min(365, Math.max(0, daysToPay));

    if (importMode === "Lines") {
      if (!Array.isArray(inv.LineItems) || inv.LineItems.length === 0) continue;
      const lineAmountType = String(inv.LineAmountTypes || "Exclusive").toUpperCase();
      const parentRef = String(inv.Reference || "").trim();

      inv.LineItems.forEach((line, index) => {
        const rawLineAmt = Number(line.LineAmount) || 0;
        const rawLineTax = Number(line.TaxAmount) || 0;
        const effectiveLineAmt = rawLineAmt * ratio;
        const effectiveLineTax = rawLineTax * ratio;
        const lineSubTotalRaw =
          lineAmountType === "INCLUSIVE" ? effectiveLineAmt - effectiveLineTax : effectiveLineAmt;
        const lineTotalRaw =
          lineAmountType === "INCLUSIVE" ? effectiveLineAmt : effectiveLineAmt + effectiveLineTax;

        const subTotal = round2(lineSubTotalRaw / currencyRate);
        const tax = round2(effectiveLineTax / currencyRate);
        const total = round2(lineTotalRaw / currencyRate);

        const rawInvoiceNo = `${baseInvNo}-${index + 1}`;
        const invoiceNo = applyInvFormat(rawInvoiceNo, invFormatRule);
        const lineDesc = String(line.Description || "").trim();
        const combinedRef = [parentRef, lineDesc].filter(Boolean).join(" - ");
        const description = (lineDesc || parentRef || `Invoice ${invoiceNo}`).slice(0, 120);

        normalized.push({
          id: `${inv.InvoiceID || baseInvNo}-${index + 1}`,
          rawInvoiceNo,
          invoiceNo,
          invoiceNoKey: invoiceNo.toLowerCase(),
          isFormatted: true,
          client,
          contactId,
          description,
          reference: combinedRef,
          sendDateIso,
          sendDateFormatted,
          subTotal,
          tax,
          total,
          vat: tax > 0.005 ? "Yes" : "No",
          daysToPay: clampedDays,
          status,
        });
      });
    } else {
      const subTotal = round2(((Number(inv.SubTotal) || 0) * ratio) / currencyRate);
      const tax = round2(((Number(inv.TotalTax) || 0) * ratio) / currencyRate);
      const total = round2(effectiveTotal / currencyRate);
      const rawInvoiceNo = baseInvNo;
      const invoiceNo = applyInvFormat(rawInvoiceNo, invFormatRule);
      const lineDescs = (inv.LineItems || [])
        .map((l) => String(l.Description || "").trim())
        .filter(Boolean);
      const description =
        lineDescs.slice(0, 2).join(" - ") ||
        String(inv.Reference || "").trim() ||
        `Invoice ${invoiceNo}`.trim();

      normalized.push({
        id: String(inv.InvoiceID || rawInvoiceNo),
        rawInvoiceNo,
        invoiceNo,
        invoiceNoKey: invoiceNo.toLowerCase(),
        isFormatted: true,
        client,
        contactId,
        description: description.slice(0, 120),
        reference: String(inv.Reference || "").trim(),
        sendDateIso,
        sendDateFormatted,
        subTotal,
        tax,
        total,
        vat: tax > 0.005 ? "Yes" : "No",
        daysToPay: clampedDays,
        status,
      });
    }
  }

  return normalized;
}

/**
 * Fetches QuickBooks TaxCodes and maps taxCodeId -> decimal rate (1:1 with fetchQBTaxCodeRateMap_).
 */
async function fetchQBTaxCodeRateMap(auth) {
  const map = {};
  try {
    const safeRealmId = assertValidQBRealmId(auth.realmId);
    const query = encodeURIComponent("SELECT * FROM TaxCode MAXRESULTS 100");
    const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/query?query=${query}&minorversion=73`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: "application/json",
      },
      redirect: "manual",
    });
    if (!res.ok) return map;
    const json = await res.json();
    const taxCodes = json?.QueryResponse?.TaxCode || [];
    for (const tc of taxCodes) {
      const id = String(tc.Id || "").trim();
      const name = String(tc.Name || "").trim().toLowerCase();
      const desc = String(tc.Description || "").trim().toLowerCase();
      let rate = null;

      let searchString = `${tc.Name || ""} ${desc}`;
      if (tc.SalesTaxRateList?.TaxRateDetail) {
        for (const detail of tc.SalesTaxRateList.TaxRateDetail) {
          if (detail.TaxRateRef?.name) searchString += ` ${detail.TaxRateRef.name}`;
        }
      }

      const pctMatch = searchString.match(/(\d+(?:\.\d+)?)%/);
      if (pctMatch) {
        rate = parseFloat(pctMatch[1]) / 100;
      } else if (
        tc.Taxable === false ||
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
  } catch (err) {
    console.warn("Could not pre-fetch QB TaxCodes:", err.message);
  }
  return map;
}

/**
 * Fetches QuickBooks Invoice entities on or after cutoff12m (1:1 with getQuickbooksInvoices + evaluateInvAppList).
 */
async function fetchQuickBooksInvoicesForWindow(
  auth,
  cutoff12m,
  defaultDaysToPay = 30,
  { importMode = "Whole", invFormatRule = "Full" } = {}
) {
  const safeRealmId = assertValidQBRealmId(auth.realmId);
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
  };
  const dateStr = `${cutoff12m.getFullYear()}-${String(cutoff12m.getMonth() + 1).padStart(2, "0")}-${String(cutoff12m.getDate()).padStart(2, "0")}`;

  const allInvoices = [];
  let startPosition = 1;
  const pageSize = 500;
  while (true) {
    const query = encodeURIComponent(
      `SELECT * FROM Invoice WHERE TxnDate >= '${dateStr}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/query?query=${query}&minorversion=73`;
    const res = await fetch(url, { headers, redirect: "manual" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`QuickBooks invoices request failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    const pageInvoices = json?.QueryResponse?.Invoice || [];
    if (pageInvoices.length === 0) break;
    allInvoices.push(...pageInvoices);
    startPosition += pageInvoices.length;
    if (pageInvoices.length < pageSize) break;
  }

  const taxCodeRateMap = importMode === "Lines" ? await fetchQBTaxCodeRateMap(auth) : {};

  const normalized = [];
  for (const inv of allInvoices) {
    const sendDate = parseYear0Date(inv.TxnDate);
    if (!sendDate || sendDate < cutoff12m) continue;

    const baseInvNo = String(inv.DocNumber || inv.Id || "").trim();
    if (!baseInvNo) continue;

    const originalTotal = Number(inv.TotalAmt) || 0;
    let totalCredit = 0;
    for (const txn of inv.LinkedTxn || []) {
      if (txn.TxnType === "CreditMemo") totalCredit += Number(txn.Amount) || 0;
    }
    const effectiveTotal = round2(originalTotal - totalCredit);
    const ratio = originalTotal > 0 ? effectiveTotal / originalTotal : 1;
    const rawTax = Number(inv.TxnTaxDetail?.TotalTax) || 0;
    const effectiveTax = rawTax * ratio;
    const currencyRate = Number(inv.ExchangeRate) > 0 ? Number(inv.ExchangeRate) : 1;

    const dueDate = parseYear0Date(inv.DueDate);
    let daysToPay = defaultDaysToPay;
    if (dueDate && sendDate) {
      daysToPay = Math.max(0, Math.round((dueDate.getTime() - sendDate.getTime()) / 86400000));
    }

    const isPaid = (Number(inv.Balance) || 0) <= 0.01 && effectiveTotal > 0;
    const emailSent = inv.EmailStatus === "EmailSent";
    const status = isPaid ? "Paid" : emailSent ? "Sent" : "Draft";
    const sendDateIso = `${sendDate.getFullYear()}-${String(sendDate.getMonth() + 1).padStart(2, "0")}-${String(sendDate.getDate()).padStart(2, "0")}`;
    const sendDateFormatted = formatDMmmYyyy(sendDate);
    const client = String(inv.CustomerRef?.name || "").trim() || "Unknown client";
    const contactId = String(inv.CustomerRef?.value || "").trim();
    const clampedDays = Math.min(365, Math.max(0, daysToPay));

    if (importMode === "Lines") {
      const validLines = (inv.Line || []).filter((l) => l.DetailType === "SalesItemLineDetail");
      if (validLines.length === 0) continue;

      const totalLineNet = validLines.reduce((sum, line) => sum + (Number(line.Amount) || 0), 0);
      let rawLineTaxes = validLines.map((line) => {
        if (effectiveTax === 0) return 0;
        const originalLineAmt = Number(line.Amount) || 0;
        const effectiveLineAmt = originalLineAmt * ratio;
        const taxCodeId = String(
          line.SalesItemLineDetail?.TaxCodeRef?.value || line.TaxCodeRef?.value || ""
        ).trim();
        if (taxCodeId && taxCodeRateMap[taxCodeId] !== undefined) {
          return Math.round(effectiveLineAmt * taxCodeRateMap[taxCodeId] * 100) / 100;
        }
        return totalLineNet > 0 ? (originalLineAmt / totalLineNet) * effectiveTax : 0;
      });

      const initialSum = rawLineTaxes.reduce((sum, t) => sum + t, 0);
      if (effectiveTax > 0 && initialSum === 0 && totalLineNet > 0) {
        rawLineTaxes = validLines.map((line) => {
          const originalLineAmt = Number(line.Amount) || 0;
          return (originalLineAmt / totalLineNet) * effectiveTax;
        });
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

      const parentRef = String(inv.PrivateNote || "").trim();
      validLines.forEach((line, index) => {
        const effectiveLineAmt = (Number(line.Amount) || 0) * ratio;
        const lineTaxRaw = rawLineTaxes[index] || 0;
        const subTotal = round2(effectiveLineAmt / currencyRate);
        const tax = round2(lineTaxRaw / currencyRate);
        const total = round2((effectiveLineAmt + lineTaxRaw) / currencyRate);

        const rawInvoiceNo = `${baseInvNo}-${index + 1}`;
        const invoiceNo = applyInvFormat(rawInvoiceNo, invFormatRule);
        const lineDesc = String(line.Description || "").trim();
        const combinedRef = [parentRef, lineDesc].filter(Boolean).join(" - ");
        const description = (lineDesc || parentRef || `Invoice ${invoiceNo}`).slice(0, 120);

        normalized.push({
          id: `${inv.Id || baseInvNo}-${index + 1}`,
          rawInvoiceNo,
          invoiceNo,
          invoiceNoKey: invoiceNo.toLowerCase(),
          isFormatted: true,
          client,
          contactId,
          description,
          reference: combinedRef,
          sendDateIso,
          sendDateFormatted,
          subTotal,
          tax,
          total,
          vat: tax > 0.005 ? "Yes" : "No",
          daysToPay: clampedDays,
          status,
        });
      });
    } else {
      const tax = round2(effectiveTax / currencyRate);
      const total = round2(effectiveTotal / currencyRate);
      const subTotal = round2((effectiveTotal - effectiveTax) / currencyRate);
      const rawInvoiceNo = baseInvNo;
      const invoiceNo = applyInvFormat(rawInvoiceNo, invFormatRule);
      const lineDescs = (inv.Line || [])
        .filter((l) => l.DetailType === "SalesItemLineDetail" && l.Description)
        .map((l) => String(l.Description).trim());
      const description =
        lineDescs.slice(0, 2).join(" - ") ||
        String(inv.PrivateNote || "").trim() ||
        `Invoice ${invoiceNo}`.trim();

      normalized.push({
        id: String(inv.Id || rawInvoiceNo),
        rawInvoiceNo,
        invoiceNo,
        invoiceNoKey: invoiceNo.toLowerCase(),
        isFormatted: true,
        client,
        contactId,
        description: description.slice(0, 120),
        reference: String(inv.CustomerMemo?.value || "").trim(),
        sendDateIso,
        sendDateFormatted,
        subTotal,
        tax,
        total,
        vat: tax > 0.005 ? "Yes" : "No",
        daysToPay: clampedDays,
        status,
      });
    }
  }

  return normalized;
}

/**
 * Pure detector: scans imported 12-month invoices and proposes Retainer jobs
 * wherever a client has recurring invoices of the same net amount at a
 * consistent monthly, quarterly, or other multi-month interval.
 */
export function detectRetainerSuggestions(invoices = [], { cutoff3m } = {}) {
  const cutoffDate = cutoff3m instanceof Date ? cutoff3m : parseYear0Date(cutoff3m);
  const cutoffTime = cutoffDate ? new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), cutoffDate.getDate()).getTime() : 0;

  // Group eligible non-zero invoices by (normalizedClient, exactSubTotalCents)
  const groups = new Map();
  for (const inv of invoices) {
    if (!inv || inv.alreadyOnConfirmed) continue;
    const sub = round2(inv.subTotal);
    if (sub <= 0.005) continue;
    const clientNorm = normalizeClientKey(inv.client);
    if (!clientNorm) continue;
    const amountKey = Math.round(sub * 100);
    const groupKey = `${clientNorm}::${amountKey}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(inv);
  }

  const rawSuggestions = [];

  for (const groupInvoices of groups.values()) {
    // Require at least 2 invoices in distinct calendar months
    const sorted = [...groupInvoices].sort((a, b) => a.sendDateIso.localeCompare(b.sendDateIso));
    const byMonth = new Map();
    for (const inv of sorted) {
      const d = parseYear0Date(inv.sendDateIso);
      if (!d) continue;
      const ym = d.getFullYear() * 12 + d.getMonth();
      if (!byMonth.has(ym)) byMonth.set(ym, { ym, date: d, inv });
    }
    const uniqueMonthEntries = [...byMonth.values()].sort((a, b) => a.ym - b.ym);
    if (uniqueMonthEntries.length < 2) continue;

    // Require at least one recent invoice in or near the active window (>= cutoff3m - 1 month)
    const recentThreshold = cutoffDate
      ? addMonthsSafe(cutoffDate, -1).getTime()
      : 0;
    const hasRecentOrActive = sorted.some((inv) => {
      const d = parseYear0Date(inv.sendDateIso);
      return d && d.getTime() >= recentThreshold;
    });
    if (!hasRecentOrActive) continue;

    // Analyse consecutive month intervals
    const deltas = [];
    for (let i = 1; i < uniqueMonthEntries.length; i++) {
      deltas.push(uniqueMonthEntries[i].ym - uniqueMonthEntries[i - 1].ym);
    }
    const sortedDeltas = [...deltas].sort((a, b) => a - b);
    const medianDelta = sortedDeltas[Math.floor(sortedDeltas.length / 2)];
    if (medianDelta < 1 || medianDelta > 12) continue;

    // Validate consistency across deltas
    const matchingDeltas = deltas.filter((d) => Math.abs(d - medianDelta) <= (medianDelta >= 3 ? 1 : 0));
    if (uniqueMonthEntries.length === 2) {
      const firstDay = uniqueMonthEntries[0].date.getDate();
      const secondDay = uniqueMonthEntries[1].date.getDate();
      const sameDayish = Math.abs(firstDay - secondDay) <= 5 || (firstDay >= 27 && secondDay >= 27);
      const standardCadence = [1, 2, 3, 4, 6].includes(medianDelta);
      if (!standardCadence && !sameDayish) continue;
    } else if (matchingDeltas.length / deltas.length < 0.65) {
      continue;
    }

    const periodMonths = medianDelta;
    const perInvoiceAmount = round2(sorted[0].subTotal);
    const monthlyFee = round2(perInvoiceAmount / periodMonths);

    const earliestDate = parseYear0Date(sorted[0].sendDateIso);
    const earliestMonthFirst = new Date(earliestDate.getFullYear(), earliestDate.getMonth(), 1);
    const effectiveStartDate =
      cutoffDate && earliestMonthFirst.getTime() < cutoffTime
        ? new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), cutoffDate.getDate())
        : earliestMonthFirst;

    const latestInv = sorted[sorted.length - 1];
    const latestDate = parseYear0Date(latestInv.sendDateIso);
    const invoiceSendDay = latestDate ? latestDate.getDate() : 28;

    const relevantInvoices = sorted.filter((inv) => {
      const d = parseYear0Date(inv.sendDateIso);
      return d && d.getTime() >= cutoffTime;
    });

    // Calculate modal VAT and average days to pay
    const yesVatCount = sorted.filter((i) => i.vat === "Yes").length;
    const vat = yesVatCount >= sorted.length / 2 ? "Yes" : "No";
    const avgDays = Math.round(
      sorted.reduce((sum, i) => sum + (Number(i.daysToPay) || 30), 0) / sorted.length
    );

    const baseJobName = formatRetainerJobName(earliestMonthFirst);
    const clientDisplay = sorted[0].client;
    const contactId = sorted.find((i) => i.contactId)?.contactId || "";
    const detailInfo = extractRetainerDetailCandidates(sorted, clientDisplay);
    const detailedJobName = detailInfo.preferredDetail
      ? formatRetainerJobName(earliestMonthFirst, detailInfo.preferredDetail)
      : baseJobName;
    const refJobName = detailInfo.referenceDetail
      ? formatRetainerJobName(earliestMonthFirst, detailInfo.referenceDetail)
      : "";
    const descJobName = detailInfo.descriptionDetail
      ? formatRetainerJobName(earliestMonthFirst, detailInfo.descriptionDetail)
      : "";
    const rateStartMonthLabel = `${SHORT_MONTHS[earliestMonthFirst.getMonth()]} ${String(earliestMonthFirst.getFullYear()).slice(-2)}`;

    rawSuggestions.push({
      id: `ret-${normalizeClientKey(clientDisplay)}-${Math.round(perInvoiceAmount * 100)}-${periodMonths}`,
      client: clientDisplay,
      contactId,
      baseJobName,
      detailedJobName,
      refJobName,
      descJobName,
      detailLabel: detailInfo.preferredDetail,
      referenceDetail: detailInfo.referenceDetail,
      descriptionDetail: detailInfo.descriptionDetail,
      sampleReference: detailInfo.sampleReference,
      sampleDescription: detailInfo.sampleDescription,
      jobName: baseJobName,
      perInvoiceAmount,
      monthlyFee,
      periodMonths,
      frequencyLabel: getFrequencyLabel(periodMonths),
      vat,
      daysToPay: avgDays,
      invoiceSendDay,
      earliestInWindowIso: `${earliestMonthFirst.getFullYear()}-${String(earliestMonthFirst.getMonth() + 1).padStart(2, "0")}-01`,
      rateStartIso: `${earliestMonthFirst.getFullYear()}-${String(earliestMonthFirst.getMonth() + 1).padStart(2, "0")}-01`,
      rateStartMonthLabel,
      startDateIso: `${effectiveStartDate.getFullYear()}-${String(effectiveStartDate.getMonth() + 1).padStart(2, "0")}-${String(effectiveStartDate.getDate()).padStart(2, "0")}`,
      startDateFormatted: formatDMmmYyyy(effectiveStartDate),
      endDate: NO_END_DATE_SHEET_VALUE,
      matchedCount: sorted.length,
      matchedInvoices: sorted,
      relevantInvoices,
    });
  }

  // Count retainers per client so multiple retainers from the same client automatically
  // use the detailed job name format ("<Detail> retainer (Mmm yy-)") when available
  const clientRetainerCounts = new Map();
  for (const s of rawSuggestions) {
    const ck = normalizeClientKey(s.client);
    clientRetainerCounts.set(ck, (clientRetainerCounts.get(ck) || 0) + 1);
  }
  for (const s of rawSuggestions) {
    const count = clientRetainerCounts.get(normalizeClientKey(s.client)) || 1;
    s.hasMultipleForClient = count > 1;
    if (s.hasMultipleForClient && s.detailedJobName) {
      s.jobName = s.detailedJobName;
    }
  }

  // Final disambiguation safety check if two retainers on the same client still share an identical title
  const nameCounts = new Map();
  for (const s of rawSuggestions) {
    const key = `${normalizeClientKey(s.client)}::${s.jobName.toLowerCase()}`;
    const nextCount = (nameCounts.get(key) || 0) + 1;
    nameCounts.set(key, nextCount);
    if (nextCount > 1) {
      s.jobName = `${s.jobName} ${nextCount}`;
    }
  }

  return rawSuggestions.sort((a, b) => a.client.localeCompare(b.client) || b.perInvoiceAmount - a.perInvoiceAmount);
}

/**
 * Pure filter returning remaining invoices dated >= cutoff3m not covered by selected retainers.
 */
export function computeRemainingInvoices(invoices = [], { assignedRetainerInvoiceNos = new Set(), cutoff3m } = {}) {
  const cutoffDate = cutoff3m instanceof Date ? cutoff3m : parseYear0Date(cutoff3m);
  const cutoffTime = cutoffDate ? new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), cutoffDate.getDate()).getTime() : 0;

  return invoices
    .filter((inv) => {
      if (!inv || inv.alreadyOnConfirmed) return false;
      if (round2(inv.subTotal) <= 0.005) return false;
      if (assignedRetainerInvoiceNos.has(String(inv.invoiceNoKey || inv.invoiceNo || "").toLowerCase())) return false;
      const d = parseYear0Date(inv.sendDateIso);
      return Boolean(d && d.getTime() >= cutoffTime);
    })
    .sort((a, b) => a.sendDateIso.localeCompare(b.sendDateIso) || a.client.localeCompare(b.client));
}

/**
 * Scans Confirmed sheet rows to catalogue existing Retainer & Project jobs and
 * map every recorded invoice reference back to its job type and name.
 */
export function summarizeExistingConfirmedJobs(rows = [], refColIndices = [42, 49, 56]) {
  const existingRefs = new Set();
  const existingRefInfo = new Map();
  const existingRetainers = [];
  let existingProjectJobsCount = 0;

  let currentRetainer = null;
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i] || [];
    const client = String(row[0] || "").trim();
    const jobName = String(row[1] || "").trim();
    const type = String(row[35] || "").trim();
    const startCell = String(row[37] || row[5] || "").trim();
    const revCell = row[32] ?? row[9];
    const hasRev = revCell !== "" && revCell !== undefined && revCell !== null;
    const isParentRow = Boolean((client || jobName) && (type || startCell || hasRev));

    const rowRefs = [];
    for (const c of refColIndices) {
      const val = row[c];
      if (val !== undefined && val !== null) {
        const raw = String(val).trim();
        const cleaned = raw.toLowerCase();
        if (cleaned && !cleaned.startsWith("#") && cleaned !== "pending") {
          rowRefs.push({ raw, key: cleaned });
        }
      }
    }

    let jobType = "";
    let ownerClient = client;
    let ownerJobName = jobName;

    if (isParentRow) {
      const isRet = type.toLowerCase().includes("retainer");
      if (isRet) {
        const monthlyFee = round2(parseFloat(String(revCell ?? 0).replace(/[£$€,\s]/g, "")) || 0);
        const startParsed = parseYear0Date(row[37] || row[5]);
        currentRetainer = {
          client,
          jobName,
          monthlyFee,
          startDateFormatted: startParsed ? formatDMmmYyyy(startParsed) : startCell,
          assignedInvoiceRefs: [],
        };
        existingRetainers.push(currentRetainer);
        jobType = "Retainer";
      } else {
        currentRetainer = null;
        existingProjectJobsCount++;
        jobType = "Project";
      }
    } else if (currentRetainer && (client === currentRetainer.client || !client) && (!jobName || jobName === currentRetainer.jobName)) {
      jobType = "Retainer";
      ownerClient = currentRetainer.client;
      ownerJobName = currentRetainer.jobName;
    } else if (rowRefs.length > 0) {
      currentRetainer = null;
      jobType = type.toLowerCase().includes("retainer") ? "Retainer" : "Project";
    }

    for (const r of rowRefs) {
      existingRefs.add(r.key);
      existingRefInfo.set(r.key, {
        jobType: jobType || "Project",
        client: ownerClient,
        jobName: ownerJobName,
      });
      if (jobType === "Retainer" && currentRetainer) {
        currentRetainer.assignedInvoiceRefs.push(r.raw);
      }
    }
  }

  return {
    existingRefs,
    existingRefInfo,
    existingRetainers,
    existingProjectJobsCount,
  };
}

/**
 * Reads existing Confirmed sheet structure + already-present invoice references.
 */
async function readConfirmedMetadataAndExistingRefs(sheets, cleanClientId) {
  const [valResp, metaResp] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: cleanClientId,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    ),
    cleanClientId.startsWith("sb-")
      ? Promise.resolve({ data: { sheets: [] } })
      : withRetry(() =>
        sheets.spreadsheets.get({
          spreadsheetId: cleanClientId,
          fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
        })
      ),
  ]);

  const rows = valResp.data?.values || [];
  const headers = rows[0] || [];
  const isJobCosting = isJobCostingStyle({ headers });

  // Locate invoice ref columns verbatim with StarterPushInvToConfirmed
  const refColIndices = [];
  headers.forEach((h, idx) => {
    const str = String(h || "").trim().toLowerCase();
    if (/^inv\s*\d*\s*ref$/i.test(str)) refColIndices.push(idx);
  });
  if (refColIndices.length === 0) refColIndices.push(42, 49, 56);

  const trueLastRow = await retFindTrueLastRow(null, null, rows);
  const { existingRefs, existingRefInfo, existingRetainers, existingProjectJobsCount } =
    summarizeExistingConfirmedJobs(rows, refColIndices);

  const allMetaSheets = metaResp.data?.sheets || [];
  const confirmedSheetMeta =
    allMetaSheets.find((s) => s.properties?.title === "Confirmed") ||
    allMetaSheets.find((s) => s.properties?.title === "ConfCalcs");

  return {
    rows,
    headers,
    isJobCosting,
    existingRefs,
    existingRefInfo,
    existingRetainers,
    existingProjectJobsCount,
    trueLastRow,
    sheetId: confirmedSheetMeta?.properties?.sheetId ?? null,
    maxRows: confirmedSheetMeta?.properties?.gridProperties?.rowCount ?? 5000,
  };
}

/**
 * Ensures enough blank rows exist on a Google Sheet Confirmed tab before writing.
 */
async function ensureConfirmedRowCapacity(sheets, cleanClientId, sheetMeta, targetEndRow) {
  if (cleanClientId.startsWith("sb-") || !sheetMeta?.sheetId) return;
  if (targetEndRow <= sheetMeta.maxRows) return;
  const toAdd = targetEndRow - sheetMeta.maxRows + 15;
  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: cleanClientId,
      requestBody: {
        requests: [
          {
            appendDimension: {
              sheetId: sheetMeta.sheetId,
              dimension: "ROWS",
              length: toAdd,
            },
          },
        ],
      },
    })
  );
  sheetMeta.maxRows += toAdd;
}

/**
 * Builds Confirmed row segmented write operations matching save-job.js column schema 100%.
 */
function buildConfirmedParentWriteSlices(rowNum, job, isJobCosting) {
  const rowArray = new Array(96).fill("");
  const endRaw = String(job.endDate || "").trim();
  const startRaw = String(job.startDate || "").trim();
  const endDateVal =
    String(job.projectRetainer || "").toLowerCase() === "retainer"
      ? NO_END_DATE_SHEET_VALUE
      : (endRaw ? (toSheetDateFormat(endRaw) || sanitizeFormulaInput(endRaw)) : "");
  const startDateVal = startRaw ? (toSheetDateFormat(startRaw) || sanitizeFormulaInput(startRaw)) : "";

  rowArray[0] = sanitizeFormulaInput(String(job.client || "").trim());
  rowArray[1] = sanitizeFormulaInput(String(job.jobName || "").trim());
  // Leave Date conf (col D / index 3) blank for Initial Invoice Setup imports
  rowArray[34] = job.vat === "No" ? "No" : "Yes"; // AI: VAT?
  rowArray[35] = sanitizeFormulaInput(String(job.projectRetainer || "Project")); // AJ: Project / retainer
  rowArray[39] = 1; // AN: 100% likelihood

  if (isJobCosting) {
    rowArray[5] = startDateVal; // F: Date job will start
    rowArray[6] = endDateVal;   // G: Date job will end
    rowArray[8] = "Fixed";      // I: Fixed / variable
    rowArray[9] = round2(job.revenue); // J: Job revenue
    rowArray[10] = 0;           // K: Contractor costs = 0
    rowArray[11] = 0;           // L: External costs = 0
    const fMap = getJobCostingRowFormulasMap("Confirmed", rowNum);
    for (const [colStr, formula] of Object.entries(fMap)) {
      const c = Number(colStr);
      if (c === 10 || c === 11) continue;
      rowArray[c] = formula;
    }
  } else {
    rowArray[32] = round2(job.revenue); // AG: Revenue (excl VAT)
    rowArray[33] = 0;                   // AH: Direct costs = 0
    rowArray[37] = startDateVal;        // AL: Start date
    rowArray[38] = endDateVal;          // AM: End date
  }

  // Project invoices sit on parent row Slot 1; Retainer parent row slots stay empty
  if (job.inv1 && String(job.projectRetainer || "").toLowerCase() !== "retainer") {
    rowArray[41] = round2(job.inv1.amount);
    rowArray[42] = formatInvoiceRefForSheet(job.inv1.ref);
    rowArray[43] = toSheetDateFormat(job.inv1.sendDate) || sanitizeFormulaInput(String(job.inv1.sendDate || "").trim());
    rowArray[44] = Number(job.inv1.daysToPay) || 30;
    rowArray[45] = canonicalizeInvoiceStatus(job.inv1.status || "Sent") || "Sent";
  }

  return [
    { range: `Confirmed!A${rowNum}:AM${rowNum}`, values: [rowArray.slice(0, 39)] },
    { range: `Confirmed!AN${rowNum}`, values: [[rowArray[39]]] },
    { range: `Confirmed!AP${rowNum}:BJ${rowNum}`, values: [rowArray.slice(41, 62)] },
  ];
}

/**
 * Walks backwards chronologically through a single client's historical invoices at the
 * retainer's current net amount and cadence to find the earliest contiguous month at that rate.
 */
export function findContiguousRateStartDate(
  clientHistory = [],
  targetAmount = 0,
  earliestDateInWindow = null,
  periodMonths = 1
) {
  const anchorDate =
    earliestDateInWindow instanceof Date
      ? earliestDateInWindow
      : parseYear0Date(earliestDateInWindow);
  if (!anchorDate) return null;

  const targetCents = Math.round(Number(targetAmount) * 100);
  if (targetCents <= 0) return anchorDate;

  // Deduplicate historical invoices at matching net amount by year-month
  const byYm = new Map();
  for (const inv of clientHistory) {
    const subCents = Math.round(round2(inv.subTotal) * 100);
    if (Math.abs(subCents - targetCents) > 1) continue;
    const d = parseYear0Date(inv.sendDateIso || inv.sendDate);
    if (!d) continue;
    const ym = d.getFullYear() * 12 + d.getMonth();
    if (!byYm.has(ym)) byYm.set(ym, d);
  }

  const anchorYm = anchorDate.getFullYear() * 12 + anchorDate.getMonth();
  const olderYms = [...byYm.keys()].filter((ym) => ym <= anchorYm).sort((a, b) => b - a);
  if (olderYms.length === 0) return new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);

  const maxAllowedGap = periodMonths <= 1 ? 1 : periodMonths + 1;
  let oldestYm = anchorYm;
  for (const ym of olderYms) {
    if (ym === oldestYm) continue;
    const gap = oldestYm - ym;
    if (gap <= maxAllowedGap) {
      oldestYm = ym;
    } else {
      break;
    }
  }

  const yr = Math.floor(oldestYm / 12);
  const mon = oldestYm % 12;
  return new Date(yr, mon, 1);
}

/**
 * Targeted historical ACCREC invoice fetch for a single Xero contact (up to 500 invoices).
 */
async function fetchXeroContactHistory(auth, contactId, { importMode = "Whole" } = {}) {
  if (!contactId) return [];
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "xero-tenant-id": auth.tenantId,
    Accept: "application/json",
  };
  const results = [];
  for (let page = 1; page <= 5; page++) {
    if (page > 1) await new Promise((r) => setTimeout(r, 200));
    const url = `https://api.xero.com/api.xro/2.0/Invoices?ContactIDs=${encodeURIComponent(contactId)}&order=Date%20DESC&page=${page}`;
    const res = await fetch(url, { headers, redirect: "manual" }).catch(() => null);
    if (!res?.ok) break;
    const json = await res.json().catch(() => null);
    const invs = json?.Invoices || [];
    for (const inv of invs) {
      if (String(inv.Type || "").toUpperCase() !== "ACCREC") continue;
      const st = String(inv.Status || "").toUpperCase();
      if (st === "VOIDED" || st === "DELETED" || st === "DRAFT") continue;
      const d = parseYear0Date(inv.DateString || inv.Date);
      if (!d) continue;
      const sendDateIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const originalTotal = Number(inv.Total) || 0;
      const credit = Number(inv.AmountCredited) || 0;
      const ratio = originalTotal > 0 ? round2(originalTotal - credit) / originalTotal : 1;
      const currencyRate = Number(inv.CurrencyRate) > 0 ? Number(inv.CurrencyRate) : 1;

      if (importMode === "Lines") {
        if (!Array.isArray(inv.LineItems) || inv.LineItems.length === 0) continue;
        const lineAmountType = String(inv.LineAmountTypes || "Exclusive").toUpperCase();
        for (const line of inv.LineItems) {
          const effectiveLineAmt = (Number(line.LineAmount) || 0) * ratio;
          const effectiveLineTax = (Number(line.TaxAmount) || 0) * ratio;
          const lineSubTotalRaw =
            lineAmountType === "INCLUSIVE" ? effectiveLineAmt - effectiveLineTax : effectiveLineAmt;
          results.push({
            sendDateIso,
            subTotal: round2(lineSubTotalRaw / currencyRate),
          });
        }
      } else {
        const subTotal = round2(((Number(inv.SubTotal) || 0) * ratio) / currencyRate);
        results.push({
          sendDateIso,
          subTotal,
        });
      }
    }
    if (invs.length < 100) break;
  }
  return results;
}

/**
 * Targeted historical invoice fetch for a single QuickBooks customer.
 */
async function fetchQuickBooksContactHistory(auth, customerId, { importMode = "Whole" } = {}) {
  if (!customerId || !/^\d+$/.test(String(customerId))) return [];
  const safeRealmId = assertValidQBRealmId(auth.realmId);
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
  };
  const results = [];
  let startPosition = 1;
  const pageSize = 500;
  for (let p = 0; p < 3; p++) {
    const query = encodeURIComponent(
      `SELECT Id, TxnDate, TotalAmt, TxnTaxDetail, LinkedTxn, ExchangeRate, Line FROM Invoice WHERE CustomerRef = '${String(customerId)}' ORDERBY TxnDate DESC STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/query?query=${query}&minorversion=73`;
    const res = await fetch(url, { headers, redirect: "manual" }).catch(() => null);
    if (!res?.ok) break;
    const json = await res.json().catch(() => null);
    const invs = json?.QueryResponse?.Invoice || [];
    for (const inv of invs) {
      const d = parseYear0Date(inv.TxnDate);
      if (!d) continue;
      const sendDateIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const originalTotal = Number(inv.TotalAmt) || 0;
      let totalCredit = 0;
      for (const txn of inv.LinkedTxn || []) {
        if (txn.TxnType === "CreditMemo") totalCredit += Number(txn.Amount) || 0;
      }
      const effectiveTotal = round2(originalTotal - totalCredit);
      const ratio = originalTotal > 0 ? effectiveTotal / originalTotal : 1;
      const currencyRate = Number(inv.ExchangeRate) > 0 ? Number(inv.ExchangeRate) : 1;

      if (importMode === "Lines") {
        const validLines = (inv.Line || []).filter((l) => l.DetailType === "SalesItemLineDetail");
        for (const line of validLines) {
          const effectiveLineAmt = (Number(line.Amount) || 0) * ratio;
          results.push({
            sendDateIso,
            subTotal: round2(effectiveLineAmt / currencyRate),
          });
        }
      } else {
        const rawTax = Number(inv.TxnTaxDetail?.TotalTax) || 0;
        const subTotal = round2((effectiveTotal - rawTax * ratio) / currencyRate);
        results.push({
          sendDateIso,
          subTotal,
        });
      }
    }
    if (invs.length < pageSize) break;
    startPosition += invs.length;
  }
  return results;
}

/**
 * Step 1 helper: imports 12 months of invoices prior to startDate and returns
 * suggested retainer jobs plus all imported invoices so Step 2 can filter dynamically.
 */
export async function importAndAnalyseInitialInvoices({ clientName, masterSheetId }) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const auth = await resolveAccountingToolAuth(clientName, cleanMasterId);
  if (!auth) {
    throw new Error("No active Xero or QuickBooks connection found for this client.");
  }

  const sheets = await getSheetsClient();
  const [keyResp, tolerance] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: cleanMasterId,
        ranges: ["KeyInfo!B2", "KeyInfo!B17", "KeyInfo!X28", "KeyInfo!F8", "InvAppList!F1"],
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    ),
    getToleranceValues(sheets, cleanMasterId).catch(() => ({})),
  ]);

  const vr = keyResp.data?.valueRanges || [];
  const startDate = parseYear0Date(vr[0]?.values?.[0]?.[0]);
  if (!startDate) {
    throw new Error("A valid start date is required in company settings before importing invoices.");
  }
  const currency = String(vr[1]?.values?.[0]?.[0] || "GBP").trim() || "GBP";
  const cleanClientId = await resolveClientSheetIdFromMaster({
    clientName,
    masterSheetId: cleanMasterId,
    rawKeyInfoX28: vr[2]?.values?.[0]?.[0] || "",
  });
  if (!cleanClientId) {
    throw new Error("Client workspace sheet ID is not configured in settings.");
  }

  const importMode = resolveImportMode(vr[3]?.values?.[0]?.[0]);
  const invFormatRule = resolveInvFormatRule(vr[4]?.values?.[0]?.[0]);

  const cutoff12m = addMonthsSafe(startDate, -12);
  const cutoff3m = addMonthsSafe(startDate, -3);
  const defaultDaysToPay =
    parseInt(String(tolerance?.defaultDaysToPay || "").replace(/[^\d.-]/g, ""), 10) || 30;

  const [rawInvoices, confirmedMeta] = await Promise.all([
    auth.tool === "Xero"
      ? fetchXeroInvoicesForWindow(auth, cutoff12m, defaultDaysToPay, { importMode, invFormatRule })
      : fetchQuickBooksInvoicesForWindow(auth, cutoff12m, defaultDaysToPay, { importMode, invFormatRule }),
    readConfirmedMetadataAndExistingRefs(sheets, cleanClientId),
  ]);

  const annotatedInvoices = rawInvoices.map((inv) => {
    const refMeta = confirmedMeta.existingRefInfo?.get(inv.invoiceNoKey);
    return {
      ...inv,
      alreadyOnConfirmed: confirmedMeta.existingRefs.has(inv.invoiceNoKey),
      existingJobType: refMeta?.jobType || "",
      existingJobName: refMeta?.jobName || "",
    };
  });

  const detectedRetainers = detectRetainerSuggestions(annotatedInvoices, {
    startDate,
    cutoff3m,
  });

  // Avoid suggesting a duplicate Retainer job if Confirmed already has a Retainer
  // for the same client at the same monthly fee
  const existingRetainers = confirmedMeta.existingRetainers || [];
  const skippedAlreadyCreatedRetainers = [];
  const suggestedRetainers = [];
  for (const ret of detectedRetainers) {
    const matchingExisting = existingRetainers.find(
      (ex) =>
        normalizeClientKey(ex.client) === normalizeClientKey(ret.client) &&
        (Math.abs((Number(ex.monthlyFee) || 0) - (Number(ret.monthlyFee) || 0)) <= 1 ||
          String(ex.jobName || "").trim().toLowerCase() === String(ret.jobName || "").trim().toLowerCase())
    );
    if (matchingExisting) {
      skippedAlreadyCreatedRetainers.push(matchingExisting);
    } else {
      suggestedRetainers.push(ret);
    }
  }

  // Targeted per-client lookback for retainers whose current-rate streak reaches near cutoff12m
  // so job titles reflect the true start month at the current rate while job Start Date remains >= cutoff3m
  const lookbackContactIds = new Set();
  for (const ret of suggestedRetainers) {
    const earliest = parseYear0Date(ret.earliestInWindowIso);
    if (!earliest || !ret.contactId) continue;
    const boundaryCheck = addMonthsSafe(cutoff12m, (ret.periodMonths || 1) + 1);
    if (earliest.getTime() <= boundaryCheck.getTime()) {
      lookbackContactIds.add(ret.contactId);
    }
  }

  if (lookbackContactIds.size > 0) {
    const historyByContact = new Map();
    const contactList = [...lookbackContactIds];
    const batchSize = 3;
    for (let i = 0; i < contactList.length; i += batchSize) {
      const slice = contactList.slice(i, i + batchSize);
      await Promise.all(
        slice.map(async (cid) => {
          const hist =
            auth.tool === "Xero"
              ? await fetchXeroContactHistory(auth, cid, { importMode })
              : await fetchQuickBooksContactHistory(auth, cid, { importMode });
          historyByContact.set(cid, hist);
        })
      );
    }

    for (const ret of suggestedRetainers) {
      const hist = ret.contactId ? historyByContact.get(ret.contactId) : null;
      if (!hist || hist.length === 0) continue;
      const trueStart = findContiguousRateStartDate(
        hist,
        ret.perInvoiceAmount,
        ret.earliestInWindowIso,
        ret.periodMonths
      );
      if (!trueStart) continue;

      ret.rateStartIso = `${trueStart.getFullYear()}-${String(trueStart.getMonth() + 1).padStart(2, "0")}-01`;
      ret.rateStartMonthLabel = `${SHORT_MONTHS[trueStart.getMonth()]} ${String(trueStart.getFullYear()).slice(-2)}`;
      ret.baseJobName = formatRetainerJobName(trueStart);
      ret.detailedJobName = ret.detailLabel
        ? formatRetainerJobName(trueStart, ret.detailLabel)
        : ret.baseJobName;
      ret.refJobName = ret.referenceDetail
        ? formatRetainerJobName(trueStart, ret.referenceDetail)
        : "";
      ret.descJobName = ret.descriptionDetail
        ? formatRetainerJobName(trueStart, ret.descriptionDetail)
        : "";
      ret.jobName =
        ret.hasMultipleForClient && ret.detailedJobName
          ? ret.detailedJobName
          : ret.baseJobName;
    }

    // Re-check uniqueness if two retainers for the same client still share an identical title
    const postLookbackCounts = new Map();
    for (const ret of suggestedRetainers) {
      const k = `${normalizeClientKey(ret.client)}::${ret.jobName.toLowerCase()}`;
      const c = (postLookbackCounts.get(k) || 0) + 1;
      postLookbackCounts.set(k, c);
      if (c > 1) ret.jobName = `${ret.jobName} ${c}`;
    }
  }

  const cutoff3mIso = `${cutoff3m.getFullYear()}-${String(cutoff3m.getMonth() + 1).padStart(2, "0")}-${String(cutoff3m.getDate()).padStart(2, "0")}`;
  const alreadyRecordedInvoices = annotatedInvoices.filter((i) => i.alreadyOnConfirmed);
  const recentAlreadyRecorded = alreadyRecordedInvoices.filter((i) => i.sendDateIso >= cutoff3mIso);

  return {
    clientName: clientName || "",
    accountingTool: auth.tool,
    importMode,
    invFormatRule,
    currency,
    startDateFormatted: formatDMmmYyyy(startDate),
    cutoff12mFormatted: formatDMmmYyyy(cutoff12m),
    cutoff3mFormatted: formatDMmmYyyy(cutoff3m),
    cutoff3mIso,
    totalImportedCount: annotatedInvoices.length,
    alreadyOnConfirmedCount: alreadyRecordedInvoices.length,
    existingRetainers,
    existingRetainerInvoicesCount: alreadyRecordedInvoices.filter((i) => i.existingJobType === "Retainer").length,
    existingProjectInvoicesCount: alreadyRecordedInvoices.filter((i) => i.existingJobType === "Project").length,
    existingProjectJobsCount: confirmedMeta.existingProjectJobsCount || 0,
    recentAlreadyRecordedRetainerCount: recentAlreadyRecorded.filter((i) => i.existingJobType === "Retainer").length,
    recentAlreadyRecordedProjectCount: recentAlreadyRecorded.filter((i) => i.existingJobType === "Project").length,
    invoices: annotatedInvoices,
    suggestedRetainers,
  };
}

/**
 * Creates confirmed Retainer jobs on Confirmed (parent row + provisioned child rows
 * containing the retainer's assigned >= cutoff3m invoices and future schedule).
 */
export async function createInitialRetainerJobs({
  clientName,
  masterSheetId,
  retainers = [],
}) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const keyResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: ["KeyInfo!B2", "KeyInfo!X28", "InvAppList!F1"],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const startDate = parseYear0Date(keyResp.data?.valueRanges?.[0]?.values?.[0]?.[0]);
  const cleanClientId = await resolveClientSheetIdFromMaster({
    clientName,
    masterSheetId: cleanMasterId,
    rawKeyInfoX28: keyResp.data?.valueRanges?.[1]?.values?.[0]?.[0] || "",
  });
  if (!cleanClientId) throw new Error("Client workspace sheet ID is not configured.");
  const invFormatRule = resolveInvFormatRule(keyResp.data?.valueRanges?.[2]?.values?.[0]?.[0]);

  const cutoff3m = startDate ? addMonthsSafe(startDate, -3) : null;
  const meta = await readConfirmedMetadataAndExistingRefs(sheets, cleanClientId);

  if (!Array.isArray(retainers) || retainers.length === 0) {
    return { createdCount: 0, assignedInvoiceCount: 0, assignedInvoiceRefs: [] };
  }

  let nextRow = Math.max(2, meta.trueLastRow + 1);
  const targetEndRow = nextRow + retainers.length + 5;
  await ensureConfirmedRowCapacity(sheets, cleanClientId, meta, targetEndRow);

  const batchSlices = [];
  const provisionedJobs = [];

  for (const ret of retainers) {
    const rawStart = parseYear0Date(ret.startDateIso || ret.startDateFormatted) || cutoff3m || new Date();
    const clampedStart =
      cutoff3m && rawStart.getTime() < cutoff3m.getTime()
        ? new Date(cutoff3m.getFullYear(), cutoff3m.getMonth(), cutoff3m.getDate())
        : rawStart;
    const jobName = String(ret.jobName || formatRetainerJobName(clampedStart)).trim();
    const monthlyFee = round2(ret.monthlyFee);
    const vat = ret.vat === "No" ? "No" : "Yes";
    const rowNum = nextRow++;

    batchSlices.push(
      ...buildConfirmedParentWriteSlices(
        rowNum,
        {
          client: ret.client,
          jobName,
          revenue: monthlyFee,
          vat,
          projectRetainer: "Retainer",
          startDate: formatDMmmYyyy(clampedStart),
          endDate: NO_END_DATE_SHEET_VALUE,
        },
        meta.isJobCosting
      )
    );

    const assignedInvoices = (ret.relevantInvoices || [])
      .map((inv) => {
        if (!inv) return null;
        const resolvedRef = inv.isFormatted
          ? String(inv.invoiceNo || "").trim()
          : applyInvFormat(inv.rawInvoiceNo || inv.invoiceNo, invFormatRule);
        return { ...inv, resolvedRef };
      })
      .filter((inv) => inv && inv.resolvedRef && !meta.existingRefs.has(inv.resolvedRef.toLowerCase()));

    provisionedJobs.push({
      parentRowNum: rowNum,
      client: ret.client,
      jobName,
      monthlyRevenue: monthlyFee,
      vat,
      startDate: formatDMmmYyyy(clampedStart),
      endDate: NO_END_DATE_SHEET_VALUE,
      invoiceFrequency: Number(ret.periodMonths) === 3 ? "quarterly" : "monthly",
      invoiceIntervalMonths: Math.max(1, Number(ret.periodMonths) || 1),
      invoiceSendDay: ret.invoiceSendDay || 28,
      initialInvoices: assignedInvoices.map((inv) => ({
        amount: round2(inv.subTotal),
        ref: inv.resolvedRef,
        sendDate: inv.sendDateFormatted,
        days: inv.daysToPay || 30,
        status: inv.status || "Sent",
      })),
    });
  }

  // Write all parent rows first so consecutive child row insertions never shift unplaced parents
  // Wait: provisioning child rows shifts rows below that parent, so provision from BOTTOM to TOP!
  if (batchSlices.length > 0) {
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: cleanClientId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: batchSlices,
        },
      })
    );
  }

  // Provision child rows from bottom-most parent up to top-most parent so earlier parentRowNums stay exact!
  let totalAssigned = 0;
  const assignedRefs = [];
  for (let i = provisionedJobs.length - 1; i >= 0; i--) {
    const job = provisionedJobs[i];
    const provRes = await provisionRetainerChildRows_(sheets, {
      clientSheetId: cleanClientId,
      masterSheetId: cleanMasterId,
      clientName,
      ...job,
    });
    if (!provRes?.success) {
      throw new Error(
        `Failed to provision child schedule for retainer "${job.client} - ${job.jobName}": ${provRes?.error || "Unknown error"}`
      );
    }
    for (const inv of job.initialInvoices) {
      totalAssigned++;
      assignedRefs.push(inv.ref);
    }
  }

  if (cleanClientId.startsWith("sb-") || cleanMasterId.startsWith("sb-")) {
    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, clientName || cleanMasterId).catch(() => { });
  }
  await invalidatePmaClientCache(cleanClientId, cleanMasterId, ["jobs", "invoices", "retainers", "cash", "dashboard"]).catch(() => { });

  await logPmaActivity(sheets, {
    clientName: clientName || "",
    category: "SETUP",
    action: "INITIAL_RETAINERS_CREATED",
    summary: `Created ${provisionedJobs.length} retainer job(s) with ${totalAssigned} assigned invoice(s)`,
  }).catch(() => { });

  return {
    createdCount: provisionedJobs.length,
    assignedInvoiceCount: totalAssigned,
    assignedInvoiceRefs: assignedRefs,
  };
}

/**
 * Creates one Project job row on Confirmed per remaining invoice dated >= cutoff3m.
 */
export async function createInitialProjectJobs({
  clientName,
  masterSheetId,
  invoices = [],
}) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const keyResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: ["KeyInfo!X28", "InvAppList!F1"],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const cleanClientId = await resolveClientSheetIdFromMaster({
    clientName,
    masterSheetId: cleanMasterId,
    rawKeyInfoX28: keyResp.data?.valueRanges?.[0]?.values?.[0]?.[0] || "",
  });
  if (!cleanClientId) throw new Error("Client workspace sheet ID is not configured.");
  const invFormatRule = resolveInvFormatRule(keyResp.data?.valueRanges?.[1]?.values?.[0]?.[0]);

  const meta = await readConfirmedMetadataAndExistingRefs(sheets, cleanClientId);
  const pending = (invoices || [])
    .map((inv) => {
      if (!inv) return null;
      const resolvedRef = inv.isFormatted
        ? String(inv.invoiceNo || "").trim()
        : applyInvFormat(inv.rawInvoiceNo || inv.invoiceNo, invFormatRule);
      return { ...inv, resolvedRef };
    })
    .filter(
      (inv) =>
        inv &&
        round2(inv.subTotal) > 0.005 &&
        inv.resolvedRef &&
        !meta.existingRefs.has(inv.resolvedRef.toLowerCase())
    );

  if (pending.length === 0) {
    return { createdCount: 0, createdInvoiceRefs: [] };
  }

  let nextRow = Math.max(2, meta.trueLastRow + 1);
  await ensureConfirmedRowCapacity(sheets, cleanClientId, meta, nextRow + pending.length + 5);

  const batchSlices = [];
  const createdRefs = [];

  for (const inv of pending) {
    const sendDateObj = parseYear0Date(inv.sendDateIso || inv.sendDateFormatted) || new Date();
    const monthStart = new Date(sendDateObj.getFullYear(), sendDateObj.getMonth(), 1);
    const monthEnd = new Date(sendDateObj.getFullYear(), sendDateObj.getMonth() + 1, 0);
    const jobStartObj = parseYear0Date(inv.startDateIso || inv.startDate) || monthStart;
    const jobEndObj = parseYear0Date(inv.endDateIso || inv.endDate) || monthEnd;
    const rowNum = nextRow++;

    const jobName =
      String(inv.jobName || inv.description || "").trim() ||
      `Invoice ${inv.resolvedRef}`;

    batchSlices.push(
      ...buildConfirmedParentWriteSlices(
        rowNum,
        {
          client: inv.client,
          jobName,
          revenue: round2(inv.subTotal),
          vat: inv.vat === "No" ? "No" : "Yes",
          projectRetainer: "Project",
          startDate: formatDMmmYyyy(jobStartObj),
          endDate: formatDMmmYyyy(jobEndObj),
          inv1: {
            amount: round2(inv.subTotal),
            ref: inv.resolvedRef,
            sendDate: formatDMmmYyyy(sendDateObj),
            daysToPay: inv.daysToPay || 30,
            status: inv.status || "Sent",
          },
        },
        meta.isJobCosting
      )
    );
    createdRefs.push(inv.resolvedRef);
  }

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cleanClientId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: batchSlices,
      },
    })
  );

  if (cleanClientId.startsWith("sb-") || cleanMasterId.startsWith("sb-")) {
    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, clientName || cleanMasterId).catch(() => { });
  }
  await invalidatePmaClientCache(cleanClientId, cleanMasterId, ["jobs", "invoices", "retainers", "cash", "dashboard"]).catch(() => { });

  await logPmaActivity(sheets, {
    clientName: clientName || "",
    category: "SETUP",
    action: "INITIAL_PROJECT_JOBS_CREATED",
    summary: `Created ${createdRefs.length} initial project job(s) from remaining invoices`,
  }).catch(() => { });

  return {
    createdCount: createdRefs.length,
    createdInvoiceRefs: createdRefs,
  };
}
