/**
 * ============================================================================
 * STARTER PL SETUP SERVICE (services/starterPlService.js)
 * ============================================================================
 *
 * Powers the "Run StarterPL setup" (p3_starter_pl) onboarding workflow across
 * both Google Sheet and Supabase client workspaces:
 * 1. Pulls trailing 12m + current FY P&L (writing PLFromApp) and computes mapped
 *    categories (Other expenses, Depreciation, Non-operating income/expenses).
 * 2. Pulls historical contractor bills & bank spend (KeyInfo!AT4:AT40) into an
 *    interactive by-month allocation grid + forecasts regular contractors (£50).
 * 3. Estimates per-employee Salaries & historical tax/NIC/pension overrides using
 *    the client's KeyInfo!A77:T105 UK payroll tables (forecasting ongoing via
 *    blank End date in Salaries!A4:I53).
 * 4. Extracts Year 1 Dividends in lieu of salary (inheriting Year 0 setup when
 *    none recorded in current FY) and pushes all approved data to Outgoings,
 *    OutgNotes, and Salaries without double counting.
 */

import {
  getSheetsClient,
  withRetry,
  extractSheetIdFromUrl,
  colIndexToLetter,
  getSheetGid,
} from "./sheetsClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import { resolveAccountingToolAuth } from "./accountingSuggestionsService.js";
import { assertValidQBRealmId } from "./quickbooksService.js";
import {
  parseYear0Date,
  parseYear0Number,
  extractXeroDividendCandidates,
  extractQuickBooksDividendCandidates,
} from "./year0SetupService.js";
import {
  colIdxToLetter as salColIdxToLetter,
  parseHeaderMonthMeta_,
  invalidateSalariesCache,
} from "./salariesService.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes } from "./masterEngineService.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeFormulaInput } from "./userPermissions.js";
import { toSheetDateFormat } from "../utils/helpers.js";
import {
  roundToNearest10,
  roundToNearest50,
  getUkTaxYearPrefix,
  parseKeyInfoTaxTable,
  computePayrollFromGross,
  computeVendorForecastSchedule,
} from "../utils/starterPlCalc.js";

export {
  roundToNearest10,
  roundToNearest50,
  getUkTaxYearPrefix,
  parseKeyInfoTaxTable,
  computePayrollFromGross,
  computeVendorForecastSchedule,
};

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

function monthKeyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shortMonthLabel(d) {
  return `${SHORT_MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
}

function longMonthLabel(d) {
  return `${LONG_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDMmmYy(d) {
  return `${d.getDate()}-${SHORT_MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

function normalizeVendorKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\b(ltd|limited|inc|llc|gmbh|srl|plc|co|uk)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAccountCodePrefix(val) {
  const s = String(val || "").trim();
  const match = /^\d{2,6}\s*[-–:]\s*(.+)$/.exec(s);
  return match ? { code: s.split(/[-–:]/)[0].trim(), name: match[1].trim() } : { code: "", name: s };
}

function sanitizeNoteField(val) {
  return String(val == null ? "" : val).replace(/[{}\r\n]/g, " ").trim();
}

function buildExpenseNoteBlock(block) {
  const rec = sanitizeNoteField(block.recDate || "");
  const pay = sanitizeNoteField(block.payDate || "");
  const status = sanitizeNoteField(block.status || "");
  const desc = sanitizeNoteField(block.description || "");
  const appId = sanitizeNoteField(block.appId || "");
  const amt = round2(block.amount).toFixed(2);
  return `{App ID: ${appId}}{Amt: ${amt}}{Status: ${status}}{Rec date: ${rec}}{Pay date: ${pay}}{Description: ${desc}}`;
}

// ============================================================================
// UK TAX-YEAR PAYROLL ENGINE (Imported from utils/starterPlCalc.js)
// ============================================================================

/**
 * Solves for monthly Gross Salary matching targetNetPm using binary search
 * over computePayrollFromGross().
 */
export function solveGrossFromNetPay(targetNetPm, p, opts = {}) {
  const target = Number(targetNetPm) || 0;
  if (target <= 0) return 0;
  let lo = target;
  let hi = Math.max(target * 2.5, 5000);
  while (computePayrollFromGross(hi, p, opts).netPay < target && hi < 500000) {
    hi *= 2;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const net = computePayrollFromGross(mid, p, opts).netPay;
    if (net < target) lo = mid;
    else hi = mid;
  }
  return round2((lo + hi) / 2);
}

/**
 * Combines P&L payroll category totals with bank-detected payroll payees and
 * KeyInfo!A77:T105 UK payroll rules to build employee rows and historical monthly overrides.
 */
export function estimateSalariesFromPlAndBank({
  checkedMonths = [],
  plPayrollByMonth = {},
  bankPayrollTxns = [],
  taxTable,
  defaultDeliveryPct = 0,
  startDateFormatted = "",
}) {
  const hasAnyErPension = checkedMonths.some((m) => (plPayrollByMonth[m.monthKey]?.erPension || 0) > 0.01);

  // Aggregate unique bank payees (excluding HMRC, pension providers, DLA, etc.)
  // Prefer payees who were actually paid in checked current-FY months or the recent 3 months
  // so long-departed employees paid 10+ months ago do not dilute active staff estimates.
  const checkedKeySet = new Set(checkedMonths.map((m) => m.monthKey));
  const latestCheckedDate =
    checkedMonths.length > 0 ? checkedMonths[checkedMonths.length - 1].dateObj : new Date();
  const recentWindowStart = new Date(
    latestCheckedDate.getFullYear(),
    latestCheckedDate.getMonth() - 2,
    1
  );

  const allPayeeMap = new Map();
  const recentPayeeKeys = new Set();
  for (const txn of bankPayrollTxns) {
    const rawName = String(txn.payee || "").trim();
    if (!rawName) continue;
    const key = rawName.toLowerCase().replace(/\s+/g, " ");
    if (!allPayeeMap.has(key)) {
      allPayeeMap.set(key, { name: rawName, netByMonth: {} });
    }
    const entry = allPayeeMap.get(key);
    const prev = entry.netByMonth[txn.monthKey] || 0;
    entry.netByMonth[txn.monthKey] = round2(prev + (Number(txn.amount) || 0));
    if (
      checkedKeySet.has(txn.monthKey) ||
      (txn.dateObj && txn.dateObj >= recentWindowStart)
    ) {
      recentPayeeKeys.add(key);
    }
  }

  // Only include payees active in checked current-FY months or the recent 3 months (no 12-month fallback)
  const detectedPayees = [...allPayeeMap.entries()]
    .filter(([k]) => recentPayeeKeys.has(k))
    .map(([, v]) => v);
  const employees = [];

  if (detectedPayees.length > 0) {
    // Compute average/latest net weight per payee so months without bank txns still allocate consistently
    const totalAvgNetByPayee = detectedPayees.map((emp) => {
      const vals = Object.values(emp.netByMonth).filter((v) => v > 0);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    });
    const sumAvgNet = totalAvgNetByPayee.reduce((a, b) => a + b, 0) || 1;

    detectedPayees.forEach((emp, idx) => {
      employees.push({
        id: `emp-${idx + 1}`,
        name: emp.name,
        role: "Staff",
        fte: 1,
        startDate: startDateFormatted,
        endDate: "",
        deliveryPct: round2(defaultDeliveryPct),
        studentLoan: false,
        pension: hasAnyErPension,
        detectedNetByMonth: emp.netByMonth,
        fallbackShare: totalAvgNetByPayee[idx] / sumAvgNet,
        monthlyOverrides: {},
        fteSalary: 0,
      });
    });
  } else {
    employees.push({
      id: "emp-1",
      name: "Company payroll",
      role: "Combined payroll",
      fte: 1,
      startDate: startDateFormatted,
      endDate: "",
      deliveryPct: round2(defaultDeliveryPct),
      studentLoan: false,
      pension: hasAnyErPension,
      detectedNetByMonth: {},
      fallbackShare: 1,
      monthlyOverrides: {},
      fteSalary: 0,
    });
  }

  // Solve & allocate each checked month cleanly, reconciling exact totals to P&L Salaries, Er NIC, Er Pension
  for (const mc of checkedMonths) {
    const mk = mc.monthKey;
    const pl = plPayrollByMonth[mk] || { grossSalary: 0, erNic: 0, erPension: 0 };
    const taxParams = taxTable.getParamsForDate(mc.dateObj);

    const targetTotalGross = round2(pl.grossSalary);
    const targetErNic = round2(pl.erNic);
    const targetErPens = round2(pl.erPension);

    if (targetTotalGross <= 0.005) {
      for (const emp of employees) {
        emp.monthlyOverrides[mk] = {
          grossSalary: 0,
          eeNic: 0,
          erNic: 0,
          studentLoan: 0,
          eePension: 0,
          erPension: 0,
          paye: 0,
        };
      }
      continue;
    }

    // Solve implied gross per employee if this month has bank transactions for them, else use fallbackShare
    // When at least one active employee received bank net pay this month, non-paid employees default to 0.
    const monthHasBankNets = employees.some((e) => (e.detectedNetByMonth[mk] || 0) > 0);
    const rawGrosses = employees.map((emp) => {
      if (monthHasBankNets) {
        const net = emp.detectedNetByMonth[mk] || 0;
        if (net <= 0) return 0;
        return solveGrossFromNetPay(net, taxParams, {
          stLoan: emp.studentLoan,
          pension: emp.pension,
        });
      }
      return targetTotalGross * emp.fallbackShare;
    });
    const sumRawGross = rawGrosses.reduce((a, b) => a + b, 0) || 1;
    const grossScale = targetTotalGross / sumRawGross;

    const prelim = employees.map((emp, idx) => {
      const scaledGross =
        idx === employees.length - 1
          ? round2(
              targetTotalGross -
                rawGrosses
                  .slice(0, idx)
                  .reduce((s, g) => s + round2(g * grossScale), 0)
            )
          : round2(rawGrosses[idx] * grossScale);
      return computePayrollFromGross(scaledGross, taxParams, {
        stLoan: emp.studentLoan,
        pension: emp.pension,
      });
    });

    // Scale Er NIC & Er Pension proportionally to tie exactly to P&L Er NIC / Er Pension totals (e.g. Employment Allowance)
    const sumPrelimErNic = prelim.reduce((s, p) => s + p.erNic, 0);
    const sumPrelimErPens = prelim.reduce((s, p) => s + p.erPension, 0);

    employees.forEach((emp, idx) => {
      const pr = { ...prelim[idx] };
      if (employees.length === 1) {
        pr.erNic = targetErNic;
        pr.erPension = targetErPens;
      } else {
        if (targetErNic >= 0 && Math.abs(targetErNic - sumPrelimErNic) > 0.05) {
          const share = sumPrelimErNic > 0 ? pr.erNic / sumPrelimErNic : pr.grossSalary / (targetTotalGross || 1);
          pr.erNic = round2(targetErNic * share);
        }
        if (targetErPens >= 0 && Math.abs(targetErPens - sumPrelimErPens) > 0.05) {
          const share = sumPrelimErPens > 0 ? pr.erPension / sumPrelimErPens : pr.grossSalary / (targetTotalGross || 1);
          pr.erPension = round2(targetErPens * share);
        }
      }
      emp.monthlyOverrides[mk] = pr;
    });
  }

  // Derive annual FTE salary from latest non-zero checked month (so forecast reflects current run rate)
  for (const emp of employees) {
    let latestGross = 0;
    for (let i = checkedMonths.length - 1; i >= 0; i--) {
      const g = emp.monthlyOverrides[checkedMonths[i].monthKey]?.grossSalary || 0;
      if (g > 0) {
        latestGross = g;
        break;
      }
    }
    emp.fteSalary = round2(latestGross * 12);
  }

  return employees;
}

// ============================================================================
// P&L + EXPENSE + CONTRACTOR FORECAST ENGINES
// (computeVendorForecastSchedule imported from utils/starterPlCalc.js)
// ============================================================================

/**
 * Fetches monthly Xero Profit & Loss reports across monthList and builds PLFromApp matrix.
 */
async function fetchXeroMonthlyPlWindow(auth, monthList) {
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "xero-tenant-id": auth.tenantId,
    Accept: "application/json",
  };
  const monthlyResults = new Array(monthList.length).fill(null);
  const batchSize = 3;
  for (let start = 0; start < monthList.length; start += batchSize) {
    const slice = monthList.slice(start, start + batchSize);
    await Promise.all(
      slice.map(async (mc, offset) => {
        const url = `https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${mc.fromDateStr}&toDate=${mc.toDateStr}&standardLayout=false`;
        const res = await fetch(url, { headers, redirect: "manual" }).catch(() => null);
        if (!res || !res.ok) return;
        const json = await res.json().catch(() => null);
        if (json?.Reports?.[0]) monthlyResults[start + offset] = json.Reports[0];
      })
    );
  }

  const reportData = { headers: ["Description"], rowMap: new Map(), rowOrder: [] };
  for (let i = 0; i < monthList.length; i++) {
    const mc = monthList[i];
    reportData.headers.splice(1, 0, mc.monthHeader);
    const monthReport = monthlyResults[i];
    if (!monthReport) continue;

    const monthRowOrder = [];
    const walkOrder = (r) => {
      if (!r) return;
      if (r.RowType === "Section") {
        monthRowOrder.push({ title: String(r.Title || "").trim(), type: "Section" });
        if (Array.isArray(r.Rows)) r.Rows.forEach(walkOrder);
      } else if (r.RowType === "Row" || r.RowType === "SummaryRow") {
        monthRowOrder.push({ title: String(r.Cells?.[0]?.Value || "").trim(), type: r.RowType });
      }
    };
    (monthReport.Rows || []).forEach(walkOrder);

    if (reportData.rowOrder.length === 0) {
      reportData.rowOrder = monthRowOrder;
    } else {
      const masterTitles = new Set(reportData.rowOrder.map((r) => r.title));
      monthRowOrder.forEach((mr, idx) => {
        if (!masterTitles.has(mr.title)) {
          let predIdx = -1;
          for (let j = idx - 1; j >= 0; j--) {
            const fIdx = reportData.rowOrder.findIndex((r) => r.title === monthRowOrder[j].title);
            if (fIdx !== -1) {
              predIdx = fIdx;
              break;
            }
          }
          if (predIdx !== -1) reportData.rowOrder.splice(predIdx + 1, 0, mr);
          else reportData.rowOrder.push(mr);
          masterTitles.add(mr.title);
        }
      });
    }

    const collectVals = (row) => {
      if (!row) return;
      if (row.RowType === "Section" && Array.isArray(row.Rows)) {
        row.Rows.forEach(collectVals);
      } else if ((row.RowType === "Row" || row.RowType === "SummaryRow") && Array.isArray(row.Cells) && row.Cells.length > 1) {
        const title = String(row.Cells[0]?.Value || "").trim();
        const val = row.Cells[1]?.Value;
        if (!reportData.rowMap.has(title)) reportData.rowMap.set(title, {});
        reportData.rowMap.get(title)[mc.monthHeader] = val;
      }
    };
    (monthReport.Rows || []).forEach(collectVals);
  }
  return reportData;
}

/**
 * Fetches monthly QuickBooks Profit & Loss reports across monthList.
 */
async function fetchQuickBooksMonthlyPlWindow(auth, monthList) {
  const safeRealmId = assertValidQBRealmId(auth.realmId);
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
  };
  const monthlyResults = new Array(monthList.length).fill(null);
  const batchSize = 3;
  for (let start = 0; start < monthList.length; start += batchSize) {
    const slice = monthList.slice(start, start + batchSize);
    await Promise.all(
      slice.map(async (mc, offset) => {
        const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/reports/ProfitAndLoss?start_date=${mc.fromDateStr}&end_date=${mc.toDateStr}&minorversion=73`;
        const res = await fetch(url, { headers, redirect: "manual" }).catch(() => null);
        if (!res || !res.ok) return;
        const json = await res.json().catch(() => null);
        if (json?.Rows?.Row) monthlyResults[start + offset] = json;
      })
    );
  }

  const reportData = { headers: ["Description"], rowMap: new Map(), rowOrder: [] };
  for (let i = 0; i < monthList.length; i++) {
    const mc = monthList[i];
    reportData.headers.splice(1, 0, mc.monthHeader);
    const monthReport = monthlyResults[i];
    if (!monthReport) continue;

    const monthRowOrder = [];
    const walkOrder = (r) => {
      if (!r || (!r.Header && !r.Summary && !r.ColData)) return;
      if (r.type === "Section" && r.Header?.ColData) {
        monthRowOrder.push({ title: String(r.Header.ColData[0]?.value || "").trim(), type: "Section" });
        if (r.Rows?.Row) r.Rows.Row.forEach(walkOrder);
      } else if (r.Summary?.ColData) {
        monthRowOrder.push({ title: String(r.Summary.ColData[0]?.value || "").trim(), type: "SummaryRow" });
      } else if (r.ColData) {
        monthRowOrder.push({ title: String(r.ColData[0]?.value || "").trim(), type: "Row" });
      }
    };
    (monthReport.Rows?.Row || []).forEach(walkOrder);

    if (reportData.rowOrder.length === 0) {
      reportData.rowOrder = monthRowOrder;
    } else {
      const masterTitles = new Set(reportData.rowOrder.map((r) => r.title));
      monthRowOrder.forEach((mr, idx) => {
        if (!masterTitles.has(mr.title)) {
          let predIdx = -1;
          for (let j = idx - 1; j >= 0; j--) {
            const fIdx = reportData.rowOrder.findIndex((r) => r.title === monthRowOrder[j].title);
            if (fIdx !== -1) {
              predIdx = fIdx;
              break;
            }
          }
          if (predIdx !== -1) reportData.rowOrder.splice(predIdx + 1, 0, mr);
          else reportData.rowOrder.push(mr);
          masterTitles.add(mr.title);
        }
      });
    }

    const collectVals = (row) => {
      if (!row || (!row.Header && !row.Summary && !row.ColData)) return;
      if (row.type === "Section" && row.Rows?.Row) {
        row.Rows.Row.forEach(collectVals);
      } else if (row.Summary?.ColData) {
        const title = String(row.Summary.ColData[0]?.value || "").trim();
        const val = row.Summary.ColData[1]?.value;
        if (!reportData.rowMap.has(title)) reportData.rowMap.set(title, {});
        reportData.rowMap.get(title)[mc.monthHeader] = val;
      } else if (row.ColData) {
        const title = String(row.ColData[0]?.value || "").trim();
        const val = row.ColData[1]?.value;
        if (!reportData.rowMap.has(title)) reportData.rowMap.set(title, {});
        reportData.rowMap.get(title)[mc.monthHeader] = val;
      }
    };
    (monthReport.Rows?.Row || []).forEach(collectVals);
  }
  return reportData;
}

/**
 * Fetches Xero Accounts, Bills (ACCPAY), and BankTransactions (SPEND) from sinceDate
 * for Contractor allocation and Payroll employee net-pay detection.
 */
async function fetchXeroCostAndPayrollTransactions(
  auth,
  sinceDate,
  trackedCategoryEntries = [],
  baseCurrency = "GBP"
) {
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "xero-tenant-id": auth.tenantId,
    Accept: "application/json",
  };
  const homeCurrency = String(baseCurrency || "GBP").trim().toUpperCase();

  const accRes = await fetch("https://api.xero.com/api.xro/2.0/Accounts", { headers, redirect: "manual" }).catch(() => null);
  const accJson = accRes?.ok ? await accRes.json().catch(() => ({})) : {};
  const accounts = accJson?.Accounts || [];

  const trackedCodeSet = new Set();
  const trackedNameSet = new Set();
  for (const raw of trackedCategoryEntries) {
    const { code, name } = stripAccountCodePrefix(raw);
    if (code) trackedCodeSet.add(code.toLowerCase());
    if (name) trackedNameSet.add(name.toLowerCase());
    trackedNameSet.add(String(raw || "").trim().toLowerCase());
  }
  for (const a of accounts) {
    const c = String(a.Code || "").trim().toLowerCase();
    const n = String(a.Name || "").trim().toLowerCase();
    if (trackedNameSet.has(n) && c) trackedCodeSet.add(c);
    if (trackedCodeSet.has(c) && n) trackedNameSet.add(n);
  }

  // Build Payroll / Wages account code set (exclude Contractors, DLA, HMRC VAT/PAYE, Pensions)
  const payrollAccountCodes = new Set();
  for (const a of accounts) {
    const nameLower = String(a.Name || "").toLowerCase();
    const code = String(a.Code || "").trim();
    if (
      /wages payable|payroll|net wages|\bsalaries\b|direct wages/i.test(nameLower) &&
      !/director|loan|hmrc|vat|paye|pension|ni\b|national insurance|freelance|contractor/i.test(nameLower)
    ) {
      if (code) payrollAccountCodes.add(code);
    }
  }
  if (payrollAccountCodes.size === 0) payrollAccountCodes.add("814"); // Standard Xero Wages Payable fallback

  const y = sinceDate.getFullYear();
  const m = String(sinceDate.getMonth() + 1).padStart(2, "0");
  const d = String(sinceDate.getDate()).padStart(2, "0");
  const whereDate = `Date>=DateTime(${y},${Number(m)},${Number(d)})`;

  const fetchPaged = async (endpoint, arrayKey, extraWhere = "") => {
    const items = [];
    const whereClause = extraWhere ? `${extraWhere}&&${whereDate}` : whereDate;
    for (let page = 1; page <= 20; page++) {
      if (page > 1) await new Promise((r) => setTimeout(r, 220));
      let res = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(
          `https://api.xero.com/api.xro/2.0/${endpoint}?where=${encodeURIComponent(whereClause)}&order=Date%20DESC&page=${page}`,
          { headers, redirect: "manual" }
        ).catch(() => null);
        if (res && res.status === 429) {
          const waitSec = Math.min(10, parseInt(res.headers.get("retry-after") || "2", 10) || 2);
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          continue;
        }
        break;
      }
      if (!res?.ok) break;
      const j = await res.json().catch(() => null);
      const pageItems = j?.[arrayKey] || [];
      items.push(...pageItems);
      if (pageItems.length < 100) break;
    }
    return items;
  };

  const [bills, bankTxns] = await Promise.all([
    fetchPaged("Invoices", "Invoices", 'Type=="ACCPAY"'),
    fetchPaged("BankTransactions", "BankTransactions"),
  ]);

  const toBaseCurrency = (amt, docCurrency, docRate) => {
    const raw = Number(amt) || 0;
    const dc = String(docCurrency || "").trim().toUpperCase();
    const rate = Number(docRate);
    if (dc && dc !== homeCurrency && Number.isFinite(rate) && rate > 0) {
      return round2(raw / rate);
    }
    return round2(raw);
  };

  const contractorTxns = [];
  const bankPayrollTxns = [];

  for (const b of bills) {
    const st = String(b.Status || "").toUpperCase();
    if (st === "VOIDED" || st === "DELETED" || st === "DRAFT") continue;
    const invDate = parseYear0Date(b.DateString || b.Date);
    if (!invDate || invDate < sinceDate) continue;

    const matchingLines = (b.LineItems || []).filter((li) => {
      const code = String(li.AccountCode || "").trim().toLowerCase();
      return code && trackedCodeSet.has(code);
    });
    if (matchingLines.length === 0) continue;

    const netAmt = toBaseCurrency(
      matchingLines.reduce((s, li) => s + (Number(li.LineAmount) || 0), 0),
      b.CurrencyCode,
      b.CurrencyRate
    );
    const taxAmt = toBaseCurrency(
      matchingLines.reduce((s, li) => s + (Number(li.TaxAmount) || 0), 0),
      b.CurrencyCode,
      b.CurrencyRate
    );
    if (Math.abs(netAmt) < 0.01) continue;

    const paidDate = parseYear0Date(b.FullyPaidOnDate) || parseYear0Date(b.Payments?.[0]?.Date);
    const dueDate = parseYear0Date(b.DueDateString || b.DueDate);
    const vendor = String(b.Contact?.Name || "Unknown vendor").trim();
    const firstDesc = matchingLines.map((l) => String(l.Description || "").trim()).filter(Boolean).join(" - ");

    contractorTxns.push({
      id: `bill-${b.InvoiceID || b.InvoiceNumber}`,
      appId: String(b.InvoiceID || b.InvoiceNumber || "").trim(),
      source: "Bill",
      vendor,
      vendorKey: normalizeVendorKey(vendor),
      ref: String(b.InvoiceNumber || b.Reference || "").trim(),
      description: firstDesc || `Bill ${b.InvoiceNumber || ""}`.trim(),
      amountNet: netAmt,
      vatSetting: taxAmt > 0.005 ? "Yes" : "No",
      recDate: formatDMmmYy(invDate),
      payDate: formatDMmmYy(paidDate || dueDate || invDate),
      status: st === "PAID" ? "Paid" : "Approved",
      dateObj: invDate,
      monthKey: monthKeyFromDate(invDate),
    });
  }

  for (const bt of bankTxns) {
    if (String(bt.Status || "").toUpperCase() === "DELETED") continue;
    if (!String(bt.Type || "").toUpperCase().startsWith("SPEND")) continue;
    const txDate = parseYear0Date(bt.DateString || bt.Date);
    if (!txDate || txDate < sinceDate) continue;

    const vendor = String(bt.Contact?.Name || "").trim();
    const lines = bt.LineItems || [];

    // Check contractor tracked accounts
    const matchingConLines = lines.filter((li) => trackedCodeSet.has(String(li.AccountCode || "").trim().toLowerCase()));
    if (matchingConLines.length > 0) {
      const netAmt = toBaseCurrency(
        matchingConLines.reduce((s, li) => s + (Number(li.LineAmount) || 0), 0),
        bt.CurrencyCode,
        bt.CurrencyRate
      );
      const taxAmt = toBaseCurrency(
        matchingConLines.reduce((s, li) => s + (Number(li.TaxAmount) || 0), 0),
        bt.CurrencyCode,
        bt.CurrencyRate
      );
      if (Math.abs(netAmt) >= 0.01) {
        const desc = matchingConLines.map((l) => String(l.Description || "").trim()).filter(Boolean).join(" - ");
        contractorTxns.push({
          id: `bank-${bt.BankTransactionID}`,
          appId: String(bt.BankTransactionID || "").trim(),
          source: "Bank spend",
          vendor: vendor || "Bank spend contractor",
          vendorKey: normalizeVendorKey(vendor || "Bank spend contractor"),
          ref: String(bt.Reference || "").trim(),
          description: desc || String(bt.Reference || "Bank spend").trim(),
          amountNet: netAmt,
          vatSetting: taxAmt > 0.005 ? "Yes" : "No",
          recDate: formatDMmmYy(txDate),
          payDate: formatDMmmYy(txDate),
          status: "Paid",
          dateObj: txDate,
          monthKey: monthKeyFromDate(txDate),
        });
      }
      continue;
    }

    // Check Payroll / Wages bank payments for employee estimation
    const hasPayrollLine = lines.some((li) => {
      const code = String(li.AccountCode || "").trim();
      const dStr = String(li.Description || "").toLowerCase();
      return payrollAccountCodes.has(code) || /\bpayroll\b|\bnet wages?\b|\bsalary\b/.test(dStr);
    });
    const isExcludedParty = /hmrc|nest|pension|director'?s?\s*loan|vat/i.test(vendor);
    if (hasPayrollLine && vendor && !isExcludedParty) {
      const amt = round2(Number(bt.Total) || 0);
      if (amt > 0.01) {
        bankPayrollTxns.push({
          payee: vendor,
          amount: amt,
          monthKey: monthKeyFromDate(txDate),
          dateObj: txDate,
        });
      }
    }
  }

  return { contractorTxns, bankPayrollTxns };
}

/**
 * Fetches QuickBooks Accounts, Bills, Purchases (Bank Spend) from sinceDate.
 */
async function fetchQuickBooksCostAndPayrollTransactions(
  auth,
  sinceDate,
  trackedCategoryEntries = [],
  baseCurrency = "GBP"
) {
  const safeRealmId = assertValidQBRealmId(auth.realmId);
  const homeCurrency = String(baseCurrency || "GBP").trim().toUpperCase();
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
  };
  const dateStr = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, "0")}-${String(sinceDate.getDate()).padStart(2, "0")}`;

  const trackedLower = new Set();
  for (const raw of trackedCategoryEntries) {
    const { name } = stripAccountCodePrefix(raw);
    if (name) trackedLower.add(name.toLowerCase());
    trackedLower.add(String(raw || "").trim().toLowerCase());
  }

  const qbQuery = async (sql) => {
    const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/query?query=${encodeURIComponent(sql)}&minorversion=73`;
    const res = await fetch(url, { headers, redirect: "manual" }).catch(() => null);
    if (!res?.ok) return null;
    return res.json().catch(() => null);
  };

  const [billsJson, purchasesJson] = await Promise.all([
    qbQuery(`SELECT * FROM Bill WHERE TxnDate >= '${dateStr}' MAXRESULTS 1000`),
    qbQuery(`SELECT * FROM Purchase WHERE TxnDate >= '${dateStr}' MAXRESULTS 1000`),
  ]);

  const contractorTxns = [];
  const bankPayrollTxns = [];

  const qbToBase = (amt, docCur, exRate) => {
    const raw = Number(amt) || 0;
    const dc = String(docCur || "").trim().toUpperCase();
    const rate = Number(exRate);
    if (dc && dc !== homeCurrency && Number.isFinite(rate) && rate > 0) {
      return round2(raw * rate);
    }
    return round2(raw);
  };

  for (const b of billsJson?.QueryResponse?.Bill || []) {
    const txDate = parseYear0Date(b.TxnDate);
    if (!txDate || txDate < sinceDate) continue;
    const matchLines = (b.Line || []).filter((l) => {
      const acctName = String(l.AccountBasedExpenseLineDetail?.AccountRef?.name || "").trim().toLowerCase();
      return acctName && trackedLower.has(acctName);
    });
    if (matchLines.length === 0) continue;
    const netAmt = qbToBase(
      matchLines.reduce((s, l) => s + (Number(l.Amount) || 0), 0),
      b.CurrencyRef?.value,
      b.ExchangeRate
    );
    if (Math.abs(netAmt) < 0.01) continue;
    const vendor = String(b.VendorRef?.name || "Unknown vendor").trim();
    const dueDate = parseYear0Date(b.DueDate) || txDate;
    contractorTxns.push({
      id: `qbbill-${b.Id}`,
      appId: String(b.Id || b.DocNumber || ""),
      source: "Bill",
      vendor,
      vendorKey: normalizeVendorKey(vendor),
      ref: String(b.DocNumber || "").trim(),
      description: matchLines.map((l) => l.Description).filter(Boolean).join(" - ") || "Contractor bill",
      amountNet: netAmt,
      vatSetting: Number(b.TxnTaxDetail?.TotalTax || 0) > 0.005 ? "Yes" : "No",
      recDate: formatDMmmYy(txDate),
      payDate: formatDMmmYy(dueDate),
      status: Number(b.Balance || 0) <= 0.01 ? "Paid" : "Approved",
      dateObj: txDate,
      monthKey: monthKeyFromDate(txDate),
    });
  }

  for (const p of purchasesJson?.QueryResponse?.Purchase || []) {
    const txDate = parseYear0Date(p.TxnDate);
    if (!txDate || txDate < sinceDate) continue;
    const payee = String(p.EntityRef?.name || "").trim();
    const lines = p.Line || [];
    const matchConLines = lines.filter((l) => {
      const acctName = String(l.AccountBasedExpenseLineDetail?.AccountRef?.name || "").trim().toLowerCase();
      return acctName && trackedLower.has(acctName);
    });
    if (matchConLines.length > 0) {
      const netAmt = qbToBase(
        matchConLines.reduce((s, l) => s + (Number(l.Amount) || 0), 0),
        p.CurrencyRef?.value,
        p.ExchangeRate
      );
      if (Math.abs(netAmt) >= 0.01) {
        contractorTxns.push({
          id: `qbpurch-${p.Id}`,
          appId: String(p.Id || ""),
          source: "Bank spend",
          vendor: payee || "Bank spend contractor",
          vendorKey: normalizeVendorKey(payee || "Bank spend contractor"),
          ref: String(p.DocNumber || "").trim(),
          description: matchConLines.map((l) => l.Description).filter(Boolean).join(" - ") || "Contractor spend",
          amountNet: netAmt,
          vatSetting: Number(p.TxnTaxDetail?.TotalTax || 0) > 0.005 ? "Yes" : "No",
          recDate: formatDMmmYy(txDate),
          payDate: formatDMmmYy(txDate),
          status: "Paid",
          dateObj: txDate,
          monthKey: monthKeyFromDate(txDate),
        });
      }
      continue;
    }

    const isPayroll = lines.some((l) =>
      /wages|payroll|net pay|salaries/i.test(String(l.AccountBasedExpenseLineDetail?.AccountRef?.name || "") + " " + String(l.Description || ""))
    );
    if (isPayroll && payee && !/hmrc|pension|director/i.test(payee)) {
      const amt = round2(Number(p.TotalAmt) || 0);
      if (amt > 0.01) {
        bankPayrollTxns.push({ payee, amount: amt, monthKey: monthKeyFromDate(txDate), dateObj: txDate });
      }
    }
  }

  return { contractorTxns, bankPayrollTxns };
}

/**
 * Pulls P&L + Contractors + Salaries + Dividends data for the StarterPL modal.
 */
export async function pullAndBuildStarterPlData({ clientName, masterSheetId }) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const auth = await resolveAccountingToolAuth(clientName, cleanMasterId);
  if (!auth) {
    throw new Error("No active Xero or QuickBooks connection found for this client.");
  }

  const sheets = await getSheetsClient();
  const kiResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: [
        "KeyInfo!B2",
        "KeyInfo!B15:B17",
        "KeyInfo!X28",
        "KeyInfo!AT4:AT40",
        "KeyInfo!BA2:BA180",
        "KeyInfo!BE2:BE502",
        "Year0Data!BD35:BP35",
        "Year0Data!BD49:BP49",
      ],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const vr = kiResp.data?.valueRanges || [];
  const startDate = parseYear0Date(vr[0]?.values?.[0]?.[0]);
  if (!startDate) throw new Error("A valid start date is required in KeyInfo!B2.");
  const b15to17 = vr[1]?.values || [];
  const splitDelivery = String(b15to17[1]?.[0] || "Yes").trim().toLowerCase() !== "no";
  const currency = String(b15to17[2]?.[0] || "GBP").trim() || "GBP";
  const cleanClientId = resolveCleanId(vr[2]?.values?.[0]?.[0] || "");
  if (!cleanClientId) throw new Error("Client workspace sheet ID is not configured.");

  const trackedRawList = (vr[3]?.values || []).map((r) => String(r[0] || "").trim()).filter(Boolean);
  const trackedNameSet = new Set();
  for (const t of trackedRawList) {
    trackedNameSet.add(t.toLowerCase());
    trackedNameSet.add(stripAccountCodePrefix(t).name.toLowerCase());
  }

  const baGrid = vr[4]?.values || [];
  const readBaSeg = (rStart, rEnd) => {
    const out = [];
    for (let r = rStart; r <= rEnd; r++) {
      const val = String(baGrid[r - 2]?.[0] || "").trim();
      if (val) out.push(val);
    }
    return out;
  };
  const mappedSections = {
    revenue: readBaSeg(2, 17),
    cosStaff: readBaSeg(19, 28),
    nonCosStaff: readBaSeg(35, 43),
    corpTax: readBaSeg(50, 52),
    depreciation: readBaSeg(54, 56),
    otherCos: readBaSeg(59, 78),
    nonOpIncome: readBaSeg(81, 93),
    nonOpExpenses: readBaSeg(101, 110),
    ignore: readBaSeg(128, 180),
  };

  const allMappedLower = new Set(Object.values(mappedSections).flat().map((x) => x.toLowerCase()));
  const beList = (vr[5]?.values || []).map((r) => String(r[0] || "").trim()).filter(Boolean);
  const overheadsCats = [];
  for (const cat of beList) {
    if (!allMappedLower.has(cat.toLowerCase()) && !overheadsCats.includes(cat)) {
      overheadsCats.push(cat);
    }
  }

  // Year 0 dividends (for inheritance if Year 1 dividends = 0)
  const y0CosDiv = (vr[6]?.values?.[0] || []).slice(1, 13).map((v) => parseYear0Number(v));
  const y0NonDiv = (vr[7]?.values?.[0] || []).slice(1, 13).map((v) => parseYear0Number(v));
  const y0CosSum = y0CosDiv.reduce((a, b) => a + b, 0);
  const y0NonSum = y0NonDiv.reduce((a, b) => a + b, 0);
  const y0TotalDiv = y0CosSum + y0NonSum;
  const y0DeliveryPct = y0TotalDiv > 0.01 ? round2((y0CosSum / y0TotalDiv) * 100) : 0;
  const y0MonthlyAvg = y0TotalDiv > 0.01 ? round2(y0TotalDiv / 12) : 0;

  // Read Client Sheet headers (Outgoings FY1+FY2, KeyInfo tax table, existing data flags, Dashboard revenue)
  const clientResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanClientId,
      ranges: [
        "Outgoings!A1:BF1",
        "Outgoings!A13:D30",
        "Outgoings!A126:D145",
        "Salaries!A4:A10",
        "KeyInfo!A77:T105",
        "Dashboard!A1:BF12",
      ],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const cvr = clientResp.data?.valueRanges || [];
  const outgoingsHdrs = cvr[0]?.values?.[0] || [];
  const hasExistingOutgoings =
    (cvr[1]?.values || []).some((r) => String(r?.[0] || "").trim() !== "") ||
    (cvr[2]?.values || []).some((r) => String(r?.[0] || "").trim() !== "");
  const hasExistingSalaries = (cvr[3]?.values || []).some((r) => String(r?.[0] || "").trim() !== "");
  const keyInfoTaxGrid = cvr[4]?.values || [];
  const taxTable = parseKeyInfoTaxTable(keyInfoTaxGrid);

  // Parse Dashboard forecast revenue (Confirmed + Pipeline + NBtoFind / Total revenue)
  const dashRows = cvr[5]?.values || [];
  const dashHdr = dashRows[0] || [];
  const totalRevRowIdx = dashRows.findIndex((r) =>
    /^total\s+revenue$/i.test(String(r?.[0] || "").trim())
  );
  const confRevRowIdx = dashRows.findIndex((r) =>
    /^confirmed\s+revenue$/i.test(String(r?.[0] || "").trim())
  );
  const pipeRevRowIdx = dashRows.findIndex((r) =>
    /^pipeline\s+revenue$/i.test(String(r?.[0] || "").trim())
  );
  const nbRevRowIdx = dashRows.findIndex((r) =>
    /^new\s+business\s+to\s+find/i.test(String(r?.[0] || "").trim())
  );
  const forecastRevenueByKey = {};
  for (let c = 0; c < dashHdr.length; c++) {
    const parsed = parseHeaderMonthMeta_(dashHdr[c]);
    if (!parsed) continue;
    const mk = monthKeyFromDate(new Date(parsed.year, parsed.monthIdx, 1));
    let revVal = 0;
    if (totalRevRowIdx !== -1) {
      revVal = parseYear0Number(dashRows[totalRevRowIdx]?.[c]);
    } else {
      revVal =
        (confRevRowIdx !== -1 ? parseYear0Number(dashRows[confRevRowIdx]?.[c]) : 0) +
        (pipeRevRowIdx !== -1 ? parseYear0Number(dashRows[pipeRevRowIdx]?.[c]) : 0) +
        (nbRevRowIdx !== -1 ? parseYear0Number(dashRows[nbRevRowIdx]?.[c]) : 0);
    }
    forecastRevenueByKey[mk] = round2(revVal);
  }

  // Build Outgoings month descriptors (FY1 12m + FY2 12m = first 24 monthly columns)
  const outgoingsMonths = [];
  for (let c0 = 0; c0 < outgoingsHdrs.length; c0++) {
    const parsed = parseHeaderMonthMeta_(outgoingsHdrs[c0]);
    if (!parsed) continue;
    const dObj = new Date(parsed.year, parsed.monthIdx, 1);
    outgoingsMonths.push({
      col0: c0,
      colLetter: colIndexToLetter(c0 + 1),
      fyIndex: outgoingsMonths.length < 12 ? 1 : 2,
      monthKey: monthKeyFromDate(dObj),
      shortLabel: shortMonthLabel(dObj),
      monthHeader: longMonthLabel(dObj),
      dateObj: dObj,
    });
    if (outgoingsMonths.length >= 24) break;
  }

  // Fallback if Outgoings headers missing
  if (outgoingsMonths.length === 0) {
    for (let i = 0; i < 24; i++) {
      const dObj = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
      const c0 = i < 12 ? 6 + i : 21 + (i - 12);
      outgoingsMonths.push({
        col0: c0,
        colLetter: colIndexToLetter(c0 + 1),
        fyIndex: i < 12 ? 1 : 2,
        monthKey: monthKeyFromDate(dObj),
        shortLabel: shortMonthLabel(dObj),
        monthHeader: longMonthLabel(dObj),
        dateObj: dObj,
      });
    }
  }

  // Previous calendar month boundary (user rule: pre-check up to and including previous calendar month)
  const now = new Date();
  const prevCalMonthFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const currentCalMonthFirst = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevCalYm = prevCalMonthFirst.getFullYear() * 12 + prevCalMonthFirst.getMonth();

  const fy1Months = outgoingsMonths.filter((m) => m.fyIndex === 1);
  const defaultCheckedMonthKeys = fy1Months
    .filter((m) => m.dateObj.getFullYear() * 12 + m.dateObj.getMonth() <= prevCalYm)
    .map((m) => m.monthKey);

  // Build 13-month pull window: [prevCalMonthFirst - 11m .. currentCalMonthFirst] + any missing FY1 checked months
  const trailing12Months = [];
  for (let i = 0; i < 12; i++) {
    const dObj = new Date(prevCalMonthFirst.getFullYear(), prevCalMonthFirst.getMonth() - 11 + i, 1);
    const lastD = new Date(dObj.getFullYear(), dObj.getMonth() + 1, 0);
    trailing12Months.push({
      monthKey: monthKeyFromDate(dObj),
      shortLabel: shortMonthLabel(dObj),
      monthHeader: longMonthLabel(dObj),
      dateObj: dObj,
      fromDateStr: `${dObj.getFullYear()}-${String(dObj.getMonth() + 1).padStart(2, "0")}-01`,
      toDateStr: `${lastD.getFullYear()}-${String(lastD.getMonth() + 1).padStart(2, "0")}-${String(lastD.getDate()).padStart(2, "0")}`,
    });
  }

  // Fetch P&L window (trailing12 + current calendar month so PLFromApp covers current month too)
  const currLast = new Date(currentCalMonthFirst.getFullYear(), currentCalMonthFirst.getMonth() + 1, 0);
  const plPullList = [
    ...trailing12Months,
    {
      monthKey: monthKeyFromDate(currentCalMonthFirst),
      shortLabel: shortMonthLabel(currentCalMonthFirst),
      monthHeader: longMonthLabel(currentCalMonthFirst),
      dateObj: currentCalMonthFirst,
      fromDateStr: `${currentCalMonthFirst.getFullYear()}-${String(currentCalMonthFirst.getMonth() + 1).padStart(2, "0")}-01`,
      toDateStr: `${currLast.getFullYear()}-${String(currLast.getMonth() + 1).padStart(2, "0")}-${String(currLast.getDate()).padStart(2, "0")}`,
    },
  ];
  const trailing12Start = trailing12Months[0].dateObj;

  // Fetch sequentially so we stay strictly within Xero's max-5-concurrent-calls-per-tenant rate limit
  const reportData =
    auth.tool === "Xero"
      ? await fetchXeroMonthlyPlWindow(auth, plPullList)
      : await fetchQuickBooksMonthlyPlWindow(auth, plPullList);

  const txnsResult =
    auth.tool === "Xero"
      ? await fetchXeroCostAndPayrollTransactions(auth, trailing12Start, trackedRawList, currency)
      : await fetchQuickBooksCostAndPayrollTransactions(auth, trailing12Start, trackedRawList, currency);

  const dividendCandidates = await (auth.tool === "Xero"
    ? extractXeroDividendCandidates(auth, trailing12Months)
    : extractQuickBooksDividendCandidates(auth, trailing12Months)
  ).catch((err) => {
    console.warn("Dividend candidate scan fallback to Year 0:", err?.message || err);
    return [];
  });

  // Write PLFromApp cleanly (all pulled months, explicit A1:EndColEndRow)
  if (reportData?.rowOrder?.length > 0) {
    const matrix = [reportData.headers];
    for (const rInfo of reportData.rowOrder) {
      const row = [sanitizeFormulaInput(String(rInfo.title || ""))];
      if (rInfo.type === "Section") {
        for (let i = 1; i < reportData.headers.length; i++) row.push("");
      } else {
        const vals = reportData.rowMap.get(rInfo.title) || {};
        for (let i = 1; i < reportData.headers.length; i++) {
          const raw = vals[reportData.headers[i]];
          const num = parseFloat(String(raw ?? "").replace(/,/g, ""));
          row.push(Number.isFinite(num) ? num : 0);
        }
      }
      matrix.push(row);
    }
    const colCount = Math.max(...matrix.map((r) => r.length), 1);
    const plRange = `PLFromApp!A1:${colIndexToLetter(colCount)}${matrix.length}`;
    await withRetry(() =>
      sheets.spreadsheets.values.clear({ spreadsheetId: cleanMasterId, range: "PLFromApp!A1:Z600" })
    ).catch(() => {});
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: cleanMasterId,
        range: plRange,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: matrix },
      })
    );
  }

  // Helper reading a category's monthly value from pulled reportData
  const getPlCatValue = (catName, monthHeader) => {
    const entry = reportData?.rowMap?.get(catName);
    if (!entry) return 0;
    const raw = entry[monthHeader];
    const n = parseFloat(String(raw ?? "0").replace(/,/g, ""));
    return Number.isFinite(n) ? round2(n) : 0;
  };

  // Build Expense & Non-Operating rows with BOTH trailing12mAvg & currentFyAvg (rounded to £10)
  const buildCategoryItem = (cat, sectionType) => {
    const trailingVals = trailing12Months.map((tm) => getPlCatValue(cat, tm.monthHeader));
    const fyVals = fy1Months
      .filter((fm) => defaultCheckedMonthKeys.includes(fm.monthKey))
      .map((fm) => getPlCatValue(cat, fm.monthHeader));
    const monthlyByKey = {};
    for (const m of [...trailing12Months, ...fy1Months]) {
      monthlyByKey[m.monthKey] = getPlCatValue(cat, m.monthHeader);
    }
    const trailingSum = trailingVals.reduce((a, b) => a + b, 0);
    const fySum = fyVals.reduce((a, b) => a + b, 0);
    return {
      name: cat,
      sectionType, // "CoS" | "Overhead" | "Depreciation" | "NonOpIncome" | "NonOpExpense"
      monthlyByKey,
      trailing12mAvg: roundToNearest10(trailingSum / 12),
      currentFyAvg: fyVals.length > 0 ? roundToNearest10(fySum / fyVals.length) : 0,
    };
  };

  const expenseCategories = [
    ...mappedSections.otherCos.filter((c) => !trackedNameSet.has(c.toLowerCase())).map((c) => buildCategoryItem(c, "CoS")),
    ...overheadsCats.filter((c) => !trackedNameSet.has(c.toLowerCase())).map((c) => buildCategoryItem(c, "Overhead")),
  ];
  const depreciationItem =
    mappedSections.depreciation.length > 0 ? buildCategoryItem(mappedSections.depreciation[0], "Depreciation") : null;
  const nonOpIncomeCategories = mappedSections.nonOpIncome.map((c) => buildCategoryItem(c, "NonOpIncome"));
  const nonOpExpenseCategories = mappedSections.nonOpExpenses.map((c) => buildCategoryItem(c, "NonOpExpense"));

  // Build Contractors historical allocations & forecasts (nearest £50)
  const { contractorTxns, bankPayrollTxns } = txnsResult;
  const checkedSet = new Set(defaultCheckedMonthKeys);
  const futureForecastMonths = outgoingsMonths.filter((m) => !checkedSet.has(m.monthKey));
  const checkedYear1Months = outgoingsMonths.filter((m) => checkedSet.has(m.monthKey));

  const vendorGroups = new Map();
  for (const tx of contractorTxns) {
    if (!vendorGroups.has(tx.vendorKey)) {
      vendorGroups.set(tx.vendorKey, {
        vendorKey: tx.vendorKey,
        name: tx.vendor,
        txns: [],
      });
    }
    vendorGroups.get(tx.vendorKey).txns.push(tx);
  }

  const contractors = [];
  for (const vg of vendorGroups.values()) {
    const trailingAmounts = trailing12Months.map((tm) =>
      round2(vg.txns.filter((t) => t.monthKey === tm.monthKey).reduce((s, t) => s + t.amountNet, 0))
    );
    const hasRecentOrChecked =
      vg.txns.some((t) => checkedSet.has(t.monthKey)) || trailingAmounts.some((v) => v > 0.005);
    if (!hasRecentOrChecked) continue;

    const vatYesCount = vg.txns.filter((t) => t.vatSetting === "Yes").length;
    const vatSetting = vatYesCount >= vg.txns.length / 2 ? "Yes" : "No";
    const schedule = computeVendorForecastSchedule(
      trailingAmounts,
      trailing12Months.map((tm) => tm.dateObj),
      futureForecastMonths
    );

    const historicalTransactions = vg.txns
      .filter((t) => checkedSet.has(t.monthKey))
      .map((t) => ({ ...t, assignedMonthKey: t.monthKey }));

    const trailingMonthlyByKey = {};
    const trailingHistory = trailing12Months.map((tm, idx) => {
      trailingMonthlyByKey[tm.monthKey] = trailingAmounts[idx];
      const monthTxns = vg.txns
        .filter((t) => t.monthKey === tm.monthKey)
        .map((t) => ({
          id: t.id,
          recDate: t.recDate,
          source: t.source,
          amountNet: t.amountNet,
          ref: t.ref,
          description: t.description,
        }));
      return {
        monthKey: tm.monthKey,
        shortLabel: tm.shortLabel,
        totalNet: trailingAmounts[idx],
        txns: monthTxns,
      };
    });

    contractors.push({
      id: `con-${vg.vendorKey.replace(/[^a-z0-9]/g, "-")}`,
      name: vg.name,
      vatSetting,
      deliveryPct: 100,
      pattern: schedule.pattern,
      trailingPattern: schedule.pattern,
      suggestedMonthlyAmount: schedule.roundedAmount,
      trailingMonthlyByKey,
      trailingHistory,
      forecastByMonth: schedule.forecastByMonth,
      historicalTransactions,
    });
  }
  contractors.sort((a, b) => a.name.localeCompare(b.name));

  // Contractor P&L totals per checked month (sum of tracked contractor categories in PLFromApp)
  const contractorPlTotalsByMonth = {};
  for (const cm of checkedYear1Months) {
    let sum = 0;
    for (const raw of trackedRawList) {
      const stripped = stripAccountCodePrefix(raw).name;
      const val = getPlCatValue(stripped, cm.monthHeader) || getPlCatValue(raw, cm.monthHeader);
      sum += val;
    }
    contractorPlTotalsByMonth[cm.monthKey] = round2(sum);
  }

  // Build Salaries estimates from P&L payroll categories (excl. tracked contractor categories) + Bank txns
  const classifyPayrollAccount = (catName) => {
    const l = String(catName || "").toLowerCase();
    if (/employer'?s?\s*ni|\ber\s*ni|\bnational insurance/i.test(l)) return "erNic";
    if (/pension/i.test(l)) return "erPension";
    return "grossSalary";
  };

  const plPayrollByMonth = {};
  let totalCosPay = 0;
  let totalNonCosPay = 0;
  for (const cm of checkedYear1Months) {
    let grossSalary = 0;
    let erNic = 0;
    let erPension = 0;
    for (const cat of mappedSections.cosStaff) {
      if (trackedNameSet.has(cat.toLowerCase())) continue;
      const v = getPlCatValue(cat, cm.monthHeader);
      totalCosPay += v;
      const kind = classifyPayrollAccount(cat);
      if (kind === "erNic") erNic += v;
      else if (kind === "erPension") erPension += v;
      else grossSalary += v;
    }
    for (const cat of mappedSections.nonCosStaff) {
      if (trackedNameSet.has(cat.toLowerCase())) continue;
      const v = getPlCatValue(cat, cm.monthHeader);
      totalNonCosPay += v;
      const kind = classifyPayrollAccount(cat);
      if (kind === "erNic") erNic += v;
      else if (kind === "erPension") erPension += v;
      else grossSalary += v;
    }
    plPayrollByMonth[cm.monthKey] = {
      grossSalary: round2(grossSalary),
      erNic: round2(erNic),
      erPension: round2(erPension),
    };
  }

  const defaultDeliveryPct =
    totalCosPay + totalNonCosPay > 0.01
      ? round2((totalCosPay / (totalCosPay + totalNonCosPay)) * 100)
      : splitDelivery
        ? 0
        : 0;

  const startFormatted = formatDMmmYy(startDate);
  const salaryEmployees = estimateSalariesFromPlAndBank({
    checkedMonths: checkedYear1Months,
    plPayrollByMonth,
    bankPayrollTxns,
    taxTable,
    defaultDeliveryPct,
    startDateFormatted: startFormatted,
  });

  // Dividends in lieu of salary: check current FY checked months from accounting tool, else inherit Year 0
  const divAccounts = (dividendCandidates || []).filter((c) => Math.abs(c.annualTotal) > 0.01);
  // Prefer Equity Dividend account with Year 1 movement over DLA if present
  const preferredDivCand =
    divAccounts.find((c) => c.kind === "dividend" && checkedYear1Months.some((cm) => Math.abs(c.monthly[trailing12Months.findIndex((tm) => tm.monthKey === cm.monthKey)] || 0) > 0.01)) ||
    divAccounts.find((c) => checkedYear1Months.some((cm) => Math.abs(c.monthly[trailing12Months.findIndex((tm) => tm.monthKey === cm.monthKey)] || 0) > 0.01)) ||
    null;

  const divMonthlyByKey = {};
  let hasCurrentFyDividends = false;
  let currentFyDivSum = 0;

  if (preferredDivCand) {
    for (const cm of checkedYear1Months) {
      const idx = trailing12Months.findIndex((tm) => tm.monthKey === cm.monthKey);
      const val = idx >= 0 ? round2(Math.max(0, preferredDivCand.monthly[idx] || 0)) : 0;
      divMonthlyByKey[cm.monthKey] = val;
      currentFyDivSum += val;
      if (val > 0.01) hasCurrentFyDividends = true;
    }
  } else {
    for (const cm of checkedYear1Months) divMonthlyByKey[cm.monthKey] = 0;
  }

  const inheritedFromYear0 = !hasCurrentFyDividends && y0MonthlyAvg > 0;
  const divForecastVal = hasCurrentFyDividends
    ? round2(currentFyDivSum / Math.max(1, checkedYear1Months.length))
    : y0MonthlyAvg;

  if (inheritedFromYear0) {
    for (const cm of checkedYear1Months) divMonthlyByKey[cm.monthKey] = y0MonthlyAvg;
  }
  for (const fm of futureForecastMonths) {
    divMonthlyByKey[fm.monthKey] = divForecastVal;
  }

  // Actual monthly revenue from pulled PLFromApp (mappedSections.revenue)
  const actualRevenueByKey = {};
  for (const m of [...trailing12Months, ...fy1Months]) {
    let revSum = 0;
    for (const rCat of mappedSections.revenue) {
      revSum += getPlCatValue(rCat, m.monthHeader);
    }
    actualRevenueByKey[m.monthKey] = round2(revSum);
  }

  return {
    clientName: clientName || "",
    currency,
    startDateFormatted: startFormatted,
    prevCalendarMonthLabel: shortMonthLabel(prevCalMonthFirst),
    accountingTool: auth.tool,
    hasExistingOutgoings,
    hasExistingSalaries,
    keyInfoTaxGrid,
    actualRevenueByKey,
    forecastRevenueByKey,
    trailing12MonthKeys: trailing12Months.map((tm) => tm.monthKey),
    outgoingsMonths: outgoingsMonths.map((m) => ({
      col0: m.col0,
      colLetter: m.colLetter,
      fyIndex: m.fyIndex,
      monthKey: m.monthKey,
      shortLabel: m.shortLabel,
      monthHeader: m.monthHeader,
      isCheckedByDefault: checkedSet.has(m.monthKey),
    })),
    defaultCheckedMonthKeys,
    expenseCategories,
    depreciationItem,
    nonOpIncomeCategories,
    nonOpExpenseCategories,
    contractors,
    contractorPlTotalsByMonth,
    trackedContractorCategories: trackedRawList,
    salaryEmployees,
    plPayrollByMonth,
    dividends: {
      deliveryPct: y0DeliveryPct,
      inheritedFromYear0,
      sourceAccountName: preferredDivCand?.name || "",
      year0MonthlyAvg: y0MonthlyAvg,
      monthlyByKey: divMonthlyByKey,
      forecastDefaultAmount: divForecastVal,
    },
  };
}

/**
 * Finds section row landmarks on Client Outgoings tab.
 */
function findOutgoingsLandmarks(colA = []) {
  const findIdx = (patterns) =>
    colA.findIndex((val) => {
      const s = String(val || "").trim().toLowerCase();
      return patterns.some((p) => (p instanceof RegExp ? p.test(s) : s === p));
    });

  const contractorsHeaderIdx = findIdx(["contractors"]);
  const totalContractorIdx = findIdx(["total contractor cost", "total contr. cost - delivery"]);
  const otherExpHeaderIdx = findIdx(["other expenses"]);
  const totalOtherExpIdx = findIdx(["total other expenses", "total other expenses - delivery"]);
  const nonOpIncHeaderIdx = findIdx(["non-operating income"]);
  const totalNonOpIncIdx = findIdx(["total non-operating income"]);
  const nonOpExpHeaderIdx = findIdx(["non-operating expenses"]);
  const totalNonOpExpIdx = findIdx(["total non-operating expenses"]);
  const divRowIdx = findIdx(["div in lieu of salary"]);

  // Detect Recharged expenses protected rows so we never overwrite them
  const rechargedIdx = findIdx([/^recharged expenses/i]);

  // Contractor writeable range: header + 3 (1-based) up to row before "Making up CoS" / "ZERO?"
  const contractorStartRow = contractorsHeaderIdx !== -1 ? contractorsHeaderIdx + 3 : 13;
  const contractorEndRow = totalContractorIdx !== -1 ? Math.min(totalContractorIdx - 2, 110) : 110;

  const expenseStartRow = otherExpHeaderIdx !== -1 ? otherExpHeaderIdx + 3 : 126;
  let expenseEndRow = totalOtherExpIdx !== -1 ? totalOtherExpIdx : 224;
  if (rechargedIdx !== -1 && rechargedIdx + 1 <= expenseEndRow) {
    expenseEndRow = rechargedIdx; // 1-based row strictly before Recharged expenses
  } else {
    expenseEndRow = expenseEndRow - 1;
  }

  return {
    contractorStartRow,
    contractorEndRow,
    expenseStartRow,
    expenseEndRow,
    nonOpIncStartRow: nonOpIncHeaderIdx !== -1 ? nonOpIncHeaderIdx + 3 : 262,
    nonOpIncEndRow: totalNonOpIncIdx !== -1 ? totalNonOpIncIdx : 271,
    nonOpExpStartRow: nonOpExpHeaderIdx !== -1 ? nonOpExpHeaderIdx + 3 : 282,
    nonOpExpEndRow: totalNonOpExpIdx !== -1 ? totalNonOpExpIdx : 291,
    divRowNum: divRowIdx !== -1 ? divRowIdx + 1 : 118,
  };
}

/**
 * Pushes approved StarterPL setup (Other expenses, Non-operating, Contractors + notes/OutgNotes,
 * Dividends in lieu of salary, and Salaries) to Client Outgoings & Salaries tabs.
 */
export async function pushStarterPlSetup({
  clientName,
  masterSheetId,
  checkedMonthKeys = [],
  outgoingsMonths = [],
  expenseItems = [],
  depreciationItem = null,
  nonOpIncomeItems = [],
  nonOpExpenseItems = [],
  contractors = [],
  salaryEmployees = [],
  dividends = {},
  combineSalariesAsSingleRow = false,
}) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const kiResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: ["KeyInfo!B2", "KeyInfo!X28"],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const startDate = parseYear0Date(kiResp.data?.valueRanges?.[0]?.values?.[0]?.[0]);
  const cleanClientId = resolveCleanId(kiResp.data?.valueRanges?.[1]?.values?.[0]?.[0] || "");
  if (!cleanClientId) throw new Error("Client workspace sheet ID is not configured.");

  // Read Client Outgoings landmarks, existing formulas, Salaries headers, and sheet GIDs
  const [outgResp, salHdrResp, metaResp] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: cleanClientId,
        range: undefined,
        ranges: ["Outgoings!A1:A300", "Outgoings!A126:BF293"],
        valueRenderOption: "FORMULA",
      })
    ),
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: cleanClientId,
        range: "Salaries!A1:JC1",
        valueRenderOption: "FORMATTED_VALUE",
      })
    ),
    withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: cleanClientId,
        fields: "sheets(properties.sheetId,properties.title)",
      })
    ),
  ]);

  const colA = (outgResp.data?.valueRanges?.[0]?.values || []).map((r) => r?.[0] ?? "");
  const existingExpFormulas = outgResp.data?.valueRanges?.[1]?.values || [];
  const landmarks = findOutgoingsLandmarks(colA);
  const checkedSet = new Set(checkedMonthKeys);

  const outgoingsGid =
    (metaResp.data?.sheets || []).find((s) => s.properties?.title === "Outgoings")?.properties?.sheetId ?? 0;

  const valueWrites = [];
  const noteRequests = [];
  const outgNotesGridRows = {}; // row1 -> map col0 -> noteStr

  const setOutgNote = (row1, col0, noteStr) => {
    if (!outgNotesGridRows[row1]) outgNotesGridRows[row1] = {};
    outgNotesGridRows[row1][col0] = noteStr;
    noteRequests.push({
      updateCells: {
        range: {
          sheetId: outgoingsGid,
          startRowIndex: row1 - 1,
          endRowIndex: row1,
          startColumnIndex: col0,
          endColumnIndex: col0 + 1,
        },
        rows: [{ values: [{ note: noteStr }] }],
        fields: "note",
      },
    });
  };

  // Helper to check if a month is checked (actual) or future (forecast)
  const activeMonths = outgoingsMonths.filter(
    (m) => checkedSet.has(m.monthKey) || Number(m.fyIndex) === 1 || Number(m.fyIndex) === 2
  );

  // --- 1. CONTRACTORS SECTION (Rows 13 .. contractorEndRow) ---
  const conHeight = Math.max(0, landmarks.contractorEndRow - landmarks.contractorStartRow + 1);
  const conNameRows = Array.from({ length: conHeight }, () => ["", "", "", "", ""]);
  const conMonthCols = {}; // col0 -> Array(conHeight).fill(0)
  for (const m of activeMonths) {
    conMonthCols[m.col0] = Array.from({ length: conHeight }, () => "");
  }

  const activeContractors = (contractors || []).slice(0, conHeight);
  activeContractors.forEach((con, rIdx) => {
    const row1 = landmarks.contractorStartRow + rIdx;
    const delRatio = Math.max(0, Math.min(100, parseYear0Number(con.deliveryPct ?? 100))) / 100;
    conNameRows[rIdx] = [
      sanitizeFormulaInput(String(con.name || "").trim()),
      con.vatSetting === "No" ? "No" : "Yes",
      "Curr",
      "Curr",
      delRatio,
    ];

    for (const m of activeMonths) {
      const isHistorical = checkedSet.has(m.monthKey);
      if (isHistorical) {
        const txnsInMonth = (con.historicalTransactions || []).filter((t) => t.assignedMonthKey === m.monthKey);
        if (txnsInMonth.length > 0) {
          const sum = round2(txnsInMonth.reduce((s, t) => s + (Number(t.amountNet) || 0), 0));
          conMonthCols[m.col0][rIdx] = sum;
          const noteStr = txnsInMonth
            .map((t) =>
              buildExpenseNoteBlock({
                appId: t.appId || t.id,
                amount: t.amountNet,
                status: t.status || "Approved",
                recDate: t.recDate,
                payDate: t.payDate,
                description: t.description,
              })
            )
            .join("\n\n");
          setOutgNote(row1, m.col0, noteStr);
        } else {
          conMonthCols[m.col0][rIdx] = "";
          setOutgNote(row1, m.col0, "");
        }
      } else {
        // Forecast month: write amount & PLACE-EXP metadata note block
        const fVal = round2(parseYear0Number(con.forecastByMonth?.[m.monthKey]));
        if (fVal > 0.005) {
          conMonthCols[m.col0][rIdx] = fVal;
          const mTag = m.shortLabel.replace(/\s+/g, "-");
          const cleanShort = String(con.name || "Vend").replace(/[^a-zA-Z0-9]/g, "").slice(0, 5) || "Vend";
          const rand = Math.floor(1000 + Math.random() * 9000);
          const noteStr = buildExpenseNoteBlock({
            appId: `PLACE-EXP-${mTag}-${cleanShort}-${rand}`,
            amount: fVal,
            status: "",
            recDate: `5-${mTag}`,
            payDate: `28-${mTag}`,
            description: `Placeholder Entry - ${con.name}`,
          });
          setOutgNote(row1, m.col0, noteStr);
        } else {
          conMonthCols[m.col0][rIdx] = "";
          setOutgNote(row1, m.col0, "");
        }
      }
    }
  });

  if (conHeight > 0) {
    valueWrites.push({
      range: `Outgoings!A${landmarks.contractorStartRow}:E${landmarks.contractorEndRow}`,
      values: conNameRows,
    });
    for (const m of activeMonths) {
      valueWrites.push({
        range: `Outgoings!${m.colLetter}${landmarks.contractorStartRow}:${m.colLetter}${landmarks.contractorEndRow}`,
        values: conMonthCols[m.col0].map((v) => [v]),
      });
    }
  }

  // --- 2. OTHER EXPENSES + DEPRECIATION (Rows 126 .. expenseEndRow, safely above Recharged expenses) ---
  const expHeight = Math.max(0, landmarks.expenseEndRow - landmarks.expenseStartRow + 1);
  const combinedExpenses = [
    ...(expenseItems || []),
    ...(depreciationItem ? [{ ...depreciationItem, sectionType: "Depreciation" }] : []),
  ].slice(0, expHeight);

  const expMetaRows = [];
  for (let rIdx = 0; rIdx < expHeight; rIdx++) {
    const row1 = landmarks.expenseStartRow + rIdx;
    const relFormulaIdx = row1 - 126;
    const fRow = existingExpFormulas[relFormulaIdx] || [];
    const hasFormulaName = typeof fRow[0] === "string" && fRow[0].startsWith("=");
    const item = combinedExpenses[rIdx];
    if (hasFormulaName) {
      expMetaRows.push([fRow[0], fRow[1] ?? "", fRow[2] ?? "", fRow[3] ?? "", fRow[4] ?? ""]);
    } else if (item) {
      const isCos = item.sectionType === "CoS";
      expMetaRows.push([
        sanitizeFormulaInput(String(item.name || "").trim()),
        isCos ? "No" : "Yes",
        "Curr",
        "Curr",
        isCos ? 1 : 0,
      ]);
    } else {
      expMetaRows.push(["", "", "", "", 0]);
    }
  }

  if (expHeight > 0) {
    valueWrites.push({
      range: `Outgoings!A${landmarks.expenseStartRow}:E${landmarks.expenseEndRow}`,
      values: expMetaRows,
    });
    for (const m of activeMonths) {
      const colVals = [];
      for (let rIdx = 0; rIdx < expHeight; rIdx++) {
        const row1 = landmarks.expenseStartRow + rIdx;
        const fCell = existingExpFormulas[row1 - 126]?.[m.col0];
        if (typeof fCell === "string" && fCell.startsWith("=")) {
          colVals.push([fCell]);
          continue;
        }
        const item = combinedExpenses[rIdx];
        if (!item) {
          colVals.push([""]);
          continue;
        }
        const isHistorical = checkedSet.has(m.monthKey);
        const val = isHistorical
          ? round2(parseYear0Number(item.monthlyByKey?.[m.monthKey]))
          : round2(parseYear0Number(item.forecastMonthlyByKey?.[m.monthKey] ?? item.forecastAmount));
        colVals.push([val === 0 ? "" : val]);
      }
      valueWrites.push({
        range: `Outgoings!${m.colLetter}${landmarks.expenseStartRow}:${m.colLetter}${landmarks.expenseEndRow}`,
        values: colVals,
      });
    }
  }

  // --- 3. NON-OPERATING INCOME & EXPENSES ---
  const writeNonOpSection = (items, startRow, endRow) => {
    const height = Math.max(0, endRow - startRow + 1);
    if (height <= 0) return;
    const list = (items || []).slice(0, height);
    const metaRows = Array.from({ length: height }, (_, idx) => {
      const it = list[idx];
      return it
        ? [sanitizeFormulaInput(String(it.name || "").trim()), "No", "Curr", "Curr", "-"]
        : ["", "No", "Curr", "Curr", "-"];
    });
    valueWrites.push({ range: `Outgoings!A${startRow}:E${endRow}`, values: metaRows });
    for (const m of activeMonths) {
      const colVals = Array.from({ length: height }, (_, idx) => {
        const it = list[idx];
        if (!it) return [""];
        const isHist = checkedSet.has(m.monthKey);
        const v = isHist
          ? round2(parseYear0Number(it.monthlyByKey?.[m.monthKey]))
          : round2(parseYear0Number(it.forecastMonthlyByKey?.[m.monthKey] ?? it.forecastAmount));
        return [v === 0 ? "" : v];
      });
      valueWrites.push({
        range: `Outgoings!${m.colLetter}${startRow}:${m.colLetter}${endRow}`,
        values: colVals,
      });
    }
  };

  writeNonOpSection(nonOpIncomeItems, landmarks.nonOpIncStartRow, landmarks.nonOpIncEndRow);
  writeNonOpSection(nonOpExpenseItems, landmarks.nonOpExpStartRow, landmarks.nonOpExpEndRow);

  // --- 4. DIVIDENDS IN LIEU OF SALARY (Outgoings Row 118) ---
  const divDelRatio = Math.max(0, Math.min(100, parseYear0Number(dividends.deliveryPct))) / 100;
  valueWrites.push({ range: `Outgoings!E${landmarks.divRowNum}`, values: [[divDelRatio]] });
  for (const m of activeMonths) {
    const val = round2(parseYear0Number(dividends.monthlyByKey?.[m.monthKey]));
    valueWrites.push({
      range: `Outgoings!${m.colLetter}${landmarks.divRowNum}`,
      values: [[val === 0 ? "" : val]],
    });
  }

  // --- 5. SALARIES TAB (Employees A4:I53 + Historical Actuals L4:JC53) ---
  const finalEmps = (salaryEmployees || []).slice(0, 50);
  const empMetaGrid = Array.from({ length: 50 }, (_, idx) => {
    const emp = finalEmps[idx];
    if (!emp) return ["", "", "", "", "", "", "", "", ""];
    return [
      sanitizeFormulaInput(String(emp.name || "").trim()),
      sanitizeFormulaInput(String(emp.role || "").trim()),
      round2(parseYear0Number(emp.fteSalary)),
      Number(emp.fte) > 0 ? Number(emp.fte) : 1,
      toSheetDateFormat(emp.startDate) || emp.startDate || formatDMmmYy(startDate),
      emp.endDate ? (toSheetDateFormat(emp.endDate) || String(emp.endDate).trim()) : "",
      Math.max(0, Math.min(100, parseYear0Number(emp.deliveryPct))) / 100,
      emp.studentLoan ? "Yes" : "No",
      emp.pension ? "Yes" : "No",
    ];
  });
  valueWrites.push({ range: "Salaries!A4:I53", values: empMetaGrid });

  // Match Salaries!L1:JC1 headers and write checked historical months only
  const salHdrRow1 = salHdrResp.data?.values?.[0] || [];
  for (let c = 11; c < salHdrRow1.length; c += 7) {
    const parsedHdr = parseHeaderMonthMeta_(salHdrRow1[c]);
    if (!parsedHdr) continue;
    const dObj = new Date(parsedHdr.year, parsedHdr.monthIdx, 1);
    const mKey = monthKeyFromDate(dObj);
    const startColLetter = salColIdxToLetter(c);
    const endColLetter = salColIdxToLetter(c + 6);

    if (checkedSet.has(mKey)) {
      const monthRows = Array.from({ length: 50 }, (_, idx) => {
        const emp = finalEmps[idx];
        const ov = emp?.monthlyOverrides?.[mKey];
        if (!emp || !ov) return ["", "", "", "", "", "", ""];
        return [
          round2(ov.grossSalary),
          round2(ov.eeNic),
          round2(ov.erNic),
          round2(ov.studentLoan),
          round2(ov.eePension),
          round2(ov.erPension),
          round2(ov.paye),
        ];
      });
      valueWrites.push({
        range: `Salaries!${startColLetter}4:${endColLetter}53`,
        values: monthRows,
      });
    }
  }

  // Execute Client value writes
  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cleanClientId,
      _deferBackgroundRecompute: true,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: valueWrites,
      },
    })
  );

  // Execute Client Outgoings cell notes + mirror to OutgNotes tab (Client & Master)
  if (noteRequests.length > 0) {
    const BATCH_MAX = 400;
    for (let i = 0; i < noteRequests.length; i += BATCH_MAX) {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: cleanClientId,
          _skipFormulaRecompute: true,
          requestBody: { requests: noteRequests.slice(i, i + BATCH_MAX) },
        })
      ).catch((e) => console.warn("StarterPL Outgoings note write warning:", e.message));
    }

    // Build OutgNotes tab updates cleanly (A1:AV110 for contractor rows 13..contractorEndRow)
    const outgNotesData = [];
    for (let row1 = landmarks.contractorStartRow; row1 <= landmarks.contractorEndRow; row1++) {
      const mapRow = outgNotesGridRows[row1];
      if (!mapRow) continue;
      for (const m of activeMonths) {
        if (m.col0 <= 47 && mapRow[m.col0] !== undefined) {
          outgNotesData.push({
            range: `OutgNotes!${m.colLetter}${row1}`,
            values: [[mapRow[m.col0]]],
          });
        }
      }
    }
    if (outgNotesData.length > 0) {
      await Promise.allSettled([
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: cleanClientId,
          _skipFormulaRecompute: true,
          requestBody: { valueInputOption: "RAW", data: outgNotesData },
        }),
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: cleanMasterId,
          _skipFormulaRecompute: true,
          requestBody: { valueInputOption: "RAW", data: outgNotesData },
        }),
      ]);
    }
  }

  // Update Master StarterPL row 82 checkboxes for audit parity
  const masterChkVals = Array.from({ length: 12 }, (_, i) => {
    const fm = outgoingsMonths[i];
    return Boolean(fm && checkedSet.has(fm.monthKey));
  });
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: cleanMasterId,
      range: "StarterPL!Q82:AB82",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [masterChkVals] },
    })
  ).catch(() => {});

  if (cleanClientId.startsWith("sb-") || cleanMasterId.startsWith("sb-")) {
    await flushImmediateAndScheduleBackgroundClientRecomputes(clientName || cleanMasterId).catch(() => {});
  }
  await Promise.allSettled([
    invalidateSalariesCache(cleanMasterId, cleanClientId),
    invalidatePmaClientCache(cleanClientId, clientName, ["outgoings", "budget", "cash", "dashboard", "expenses", "views", "all"]),
  ]);

  await logPmaActivity(sheets, {
    clientName: clientName || "",
    category: "SETUP",
    action: "STARTER_PL_PUSHED",
    summary: `Applied StarterPL setup (${checkedMonthKeys.length} actual month(s), ${activeContractors.length} contractor(s), ${finalEmps.length} salary row(s), ${combinedExpenses.length} expense line(s))`,
    details: { combineSalariesAsSingleRow },
  }).catch(() => {});

  return {
    success: true,
    contractorsWritten: activeContractors.length,
    expensesWritten: combinedExpenses.length,
    nonOpIncomeWritten: nonOpIncomeItems.length,
    nonOpExpensesWritten: nonOpExpenseItems.length,
    salaryEmployeesWritten: finalEmps.length,
  };
}

export const STARTER_PL_MAPPING_SECTIONS = {
  cos_staff: { label: "CoS staff costs", fallbackStart: 19, fallbackEnd: 28 },
  non_cos_staff: { label: "Non-CoS staff costs", fallbackStart: 35, fallbackEnd: 43 },
  other_cos: { label: "Other costs of sale", fallbackStart: 59, fallbackEnd: 78 },
  depreciation: { label: "Depreciation", fallbackStart: 54, fallbackEnd: 56 },
  non_op_income: { label: "Non-operating income", fallbackStart: 81, fallbackEnd: 93 },
  non_op_expenses: { label: "Non-operating expenses", fallbackStart: 101, fallbackEnd: 110 },
  corp_tax: { label: "Corporation tax", fallbackStart: 50, fallbackEnd: 52 },
  revenue: { label: "Revenue", fallbackStart: 2, fallbackEnd: 17 },
  ignore: { label: "Ignore", fallbackStart: 128, fallbackEnd: 180 },
};

/**
 * Writes an accounting category to the first blank cell in the chosen mapping section
 * of Column BA on Master KeyInfo tab (KeyInfo!AZ1:BA185), clearing any previous BA slot
 * if the category was moved from another section.
 */
export async function assignStarterPlCategoryMapping({
  clientName,
  masterSheetId,
  categoryName,
  targetSection,
}) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const rawCat = String(categoryName || "").trim();
  if (!rawCat) throw new Error("Category name is required.");

  const targetConfig = STARTER_PL_MAPPING_SECTIONS[targetSection];
  if (!targetConfig) throw new Error(`Unknown mapping section: "${targetSection}"`);

  const cleanCat = stripAccountCodePrefix(rawCat).name || rawCat;
  const cleanLower = cleanCat.toLowerCase();
  const rawLower = rawCat.toLowerCase();

  const sheets = await getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "KeyInfo!AZ1:BA185",
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const azBaRows = res.data?.values || [];

  // Resolve section row bounds verbatim from KeyInfo!AZ labels (fallback to fixed template rows)
  let sectionStartRow = -1;
  let sectionEndRow = 185;
  for (let i = 0; i < azBaRows.length; i++) {
    const azVal = String(azBaRows[i]?.[0] || "").trim().toLowerCase();
    if (azVal === targetConfig.label.toLowerCase()) {
      sectionStartRow = i + 1;
      for (let j = i + 1; j < azBaRows.length; j++) {
        const nextAz = String(azBaRows[j]?.[0] || "").trim();
        if (nextAz) {
          sectionEndRow = j;
          break;
        }
      }
      break;
    }
  }
  if (sectionStartRow === -1) {
    sectionStartRow = targetConfig.fallbackStart;
    sectionEndRow = targetConfig.fallbackEnd;
  }

  // Check if category already lives in BA (either already in target section or moved from another section)
  let existingRowInTarget = -1;
  const oldRowsToClear = [];
  for (let r = 2; r <= Math.min(180, azBaRows.length); r++) {
    const baVal = String(azBaRows[r - 1]?.[1] || "").trim();
    if (!baVal) continue;
    const baLower = baVal.toLowerCase();
    if (baLower === cleanLower || baLower === rawLower) {
      if (r >= sectionStartRow && r <= sectionEndRow) {
        existingRowInTarget = r;
      } else {
        oldRowsToClear.push(r);
      }
    }
  }

  let targetBaRow = existingRowInTarget;
  if (targetBaRow === -1) {
    for (let r = sectionStartRow; r <= sectionEndRow; r++) {
      const baVal = String(azBaRows[r - 1]?.[1] || "").trim();
      if (!baVal) {
        targetBaRow = r;
        break;
      }
    }
  }

  if (targetBaRow === -1) {
    throw new Error(`No blank cell available in "${targetConfig.label}".`);
  }

  const batchData = [];
  for (const oldR of oldRowsToClear) {
    batchData.push({ range: `KeyInfo!BA${oldR}`, values: [[""]] });
  }
  if (existingRowInTarget === -1) {
    batchData.push({
      range: `KeyInfo!BA${targetBaRow}`,
      values: [[sanitizeFormulaInput(cleanCat)]],
    });
  }

  if (batchData.length > 0) {
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: cleanMasterId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: batchData,
        },
      })
    );
  }

  await invalidatePmaClientCache(cleanMasterId, clientName, ["setup", "all"]).catch(() => {});
  await logPmaActivity(sheets, {
    clientName: clientName || "",
    category: "SETUP",
    action: "STARTER_PL_CATEGORY_MAPPED",
    summary: `Mapped category "${cleanCat}" to ${targetConfig.label} (KeyInfo!BA${targetBaRow})`,
    details: { categoryName: cleanCat, targetSection, targetBaRow, clearedOldRows: oldRowsToClear },
  }).catch(() => {});

  return {
    success: true,
    categoryName: cleanCat,
    targetSection,
    sectionLabel: targetConfig.label,
    targetBaRow,
    clearedOldRows: oldRowsToClear,
  };
}
