/**
 * ============================================================================
 * ACCOUNTING SUGGESTIONS SERVICE (services/accountingSuggestionsService.js)
 * ============================================================================
 * 
 * Automates the initial setup of accounting settings and category mapping rules:
 * 1. suggestAccountingSettings:
 *    - Reads Organisation data from connected Xero or QuickBooks.
 *    - Computes 1st of current financial year formatted as d-Mmm-yy (KeyInfo!B2).
 *    - Identifies VAT payment scheme (KeyInfo!B8: Cash vs Accrual; flags unsupported Flat Rate).
 *    - Identifies VAT quarter cycle (KeyInfo!B6: 3 UK cycles).
 *    - Inspects recent PAYE/HMRC bank transactions to detect Monthly vs Quarterly cycle (KeyInfo!B12).
 * 2. suggestCategoryMappings:
 *    - Pulls 12-month P&L / Chart of Accounts from accounting tool or Master Sheet (KeyInfo!BE & AW).
 *    - Classifies categories into Pulse sections (KeyInfo!BA2:BA180):
 *      * Revenue (BA2:BA17)
 *      * CoS staff costs (BA19:BA28) -> Salaries, Wages, Employers NI, Staff Pension, Freelancers
 *      * Non-CoS staff costs (BA35:BA43)
 *      * Corporation tax (BA50:BA52)
 *      * Depreciation (BA54:BA56)
 *      * Other cost of sale (BA59:BA78)
 *      * Non-operating income (BA81:BA93)
 *      * Non-operating expenses (BA101:BA110)
 *      * Ignore (BA128:BA180) -> Category headers & zero-monetary subtotal rows
 * 3. applyAccountingSettings & applyCategoryMappings:
 *    - Writes confirmed suggestions directly to Master Sheet and invalidates cache.
 */

import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import { sanitizeSpreadsheetTerms } from "../utils/helpers.js";
import { getIntegrationTokens, updateRefreshedTokens, getSharedXeroGrant, updateSharedXeroGrantTokens } from "./vaultService.js";
import { refreshXeroTokens } from "./xeroService.js";
import { refreshQBTokens, assertValidQBRealmId } from "./quickbooksService.js";
import { saveClientSettings } from "./clientSettingsService.js";

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Formats a Date object as d-Mmm-yy (e.g. 1-Apr-26, 1-Nov-25)
 */
export function formatDMmmyy(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    return "";
  }
  const day = date.getDate();
  const month = MONTH_NAMES_SHORT[date.getMonth()];
  const yr = String(date.getFullYear()).slice(-2);
  return `${day}-${month}-${yr}`;
}

/**
 * Computes the 1st of the current financial year given the financial year end month.
 * @param {number} fyEndMonth 1-12 (e.g. 3 for March)
 * @param {Date} [referenceDate] defaults to current date
 * @returns {Date} Date object set to 1st of current financial year
 */
export function calculateCurrentFinancialYearStart(fyEndMonth, referenceDate = new Date()) {
  const safeEndMonth = Number(fyEndMonth) || 3; // Default March
  // Financial year start month: next month after year end (1-indexed)
  const fyStartMonth = (safeEndMonth % 12) + 1; // e.g. 3 -> 4 (April)

  const currentYear = referenceDate.getFullYear();
  const currentMonth = referenceDate.getMonth() + 1; // 1-indexed

  let fyStartYear = currentYear;
  if (currentMonth < fyStartMonth) {
    // Current month is before the start month of this calendar year, so the FY started last year
    fyStartYear = currentYear - 1;
  }

  // Create date: year, monthIndex (0-based = fyStartMonth - 1), day 1
  return new Date(fyStartYear, fyStartMonth - 1, 1);
}

/**
 * Derives the suggested VAT quarter cycle from financial year end month or detected end month.
 * Cycles:
 * 1: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec (End months 3, 6, 9, 12)
 * 2: Feb-Apr, May-Jul, Aug-Oct, Nov-Jan (End months 4, 7, 10, 1)
 * 3: Mar-May, Jun-Aug, Sep-Nov, Dec-Feb (End months 5, 8, 11, 2)
 */
export function deriveVatQuarterCycle(endMonth) {
  const m = Number(endMonth) || 3;
  const rem = m % 3;
  if (rem === 0) {
    return "Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec";
  } else if (rem === 1) {
    return "Feb-Apr, May-Jul, Aug-Oct, Nov-Jan";
  } else {
    return "Mar-May, Jun-Aug, Sep-Nov, Dec-Feb";
  }
}

/**
 * Resolves active accounting tool credentials from Vault for a client.
 */
export async function resolveAccountingToolAuth(clientName, masterSheetId) {
  const unwrappedId = masterSheetId ? unwrapSheetId(String(masterSheetId).trim()) : "";
  const cleanMasterId = unwrappedId ? (extractSheetIdFromUrl(unwrappedId) || unwrappedId) : "";
  const candidateTools = ["xero", "quickbooks"];

  for (const tool of candidateTools) {
    const record = await getIntegrationTokens({
      clientKey: clientName,
      masterSheetId: cleanMasterId,
      tool
    });

    if (record && record.tokens?.accessToken) {
      // Check expiration
      const now = Date.now();
      const expiresAt = record.expiresAt || 0;
      const isExpiringSoon = (expiresAt - now) < 300000;
      let accessToken = record.tokens.accessToken;

      if (tool === "xero" && isExpiringSoon && record.tokens.refreshToken) {
        try {
          const refreshed = await refreshXeroTokens(record.tokens.refreshToken);
          accessToken = refreshed.accessToken;
          if (record.isSharedGrant) {
            await updateSharedXeroGrantTokens(refreshed);
          } else {
            await updateRefreshedTokens({ clientKey: record.clientKey, tool: "xero", tokens: refreshed });
          }
        } catch (err) {
          console.warn("⚠️ SuggestionService: Failed to refresh Xero token:", err.message);
        }
      } else if (tool === "quickbooks" && isExpiringSoon && record.tokens.refreshToken) {
        try {
          const refreshed = await refreshQBTokens(record.tokens.refreshToken);
          accessToken = refreshed.accessToken;
          await updateRefreshedTokens({ clientKey: record.clientKey, tool: "quickbooks", tokens: refreshed });
        } catch (err) {
          console.warn("⚠️ SuggestionService: Failed to refresh QuickBooks token:", err.message);
        }
      }

      return {
        tool: tool === "xero" ? "Xero" : "QuickBooks",
        accessToken,
        tenantId: record.tenantId || record.realmId,
        realmId: record.realmId || record.tenantId,
        rawRecord: record
      };
    }
  }

  return null;
}

/**
 * Parses a QuickBooks YYYY-MM-DD TxnDate string into a local Date without UTC shift.
 */
function parseIsoDateLocal(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ""));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Parses Xero date values ("/Date(1774915200000+0000)/" or ISO strings).
 */
function parseXeroDate(val) {
  const raw = String(val || "").trim();
  if (!raw) return null;
  if (raw.startsWith("/Date(")) {
    const ms = parseInt(raw.slice(6), 10);
    if (!isNaN(ms)) {
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
  }
  return parseIsoDateLocal(raw);
}

/**
 * Returns true if the given Date falls on the last day of its calendar month.
 */
function isMonthEndDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return false;
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return next.getDate() === 1;
}

/**
 * Classifies whether a transaction belongs to HMRC PAYE or HMRC VAT settlements.
 * Avoids false-matching regular supplier invoices/purchases that mention 20% VAT,
 * and avoids counting explicit HMRC VAT payments toward PAYE frequency.
 */
export function classifyHmrcTransaction({ text, partyName = "" }) {
  const lower = String(text || "").toLowerCase();
  const partyLower = String(partyName || "").toLowerCase();

  // Strip phrases indicating absence/exclusion of VAT so they never misclassify PAYE/HMRC lines as VAT
  const sanitizedForVat = lower.replace(
    /\b(no vat|zero vat|0%\s*vat|exempt from vat|vat exempt|out of scope of vat|outside scope of vat|non[- ]vat|excl\.?\s*vat|ex\.?\s*vat)\b/g,
    " "
  );

  const hasPayeKeyword =
    lower.includes("paye") ||
    lower.includes("national insurance") ||
    /\b(nic|sdds|cis)\b/i.test(lower);
  const hasCorpTaxKeyword = /\b(corporation tax|corp tax|ct600)\b/i.test(lower);
  const hasHmrcParty =
    partyLower.includes("hmrc") ||
    partyLower.includes("hm revenue") ||
    partyLower.includes("inland revenue") ||
    /\bcustoms\b/i.test(partyLower);
  const hasHmrcAny =
    hasHmrcParty ||
    lower.includes("hmrc") ||
    lower.includes("hm revenue") ||
    lower.includes("inland revenue") ||
    lower.includes("accounts office");
  const hasVatWord = /\b(vat|value added tax)\b/i.test(sanitizedForVat);
  const hasExplicitVatPhrase = /\b(hmrc vat|vat return|vat payment|vat repayment|vat refund|vat liability|vat control|vat payable|vat owed|vat dd|e-vat)\b/i.test(sanitizedForVat);

  const isVat =
    !hasPayeKeyword &&
    !hasCorpTaxKeyword &&
    (hasExplicitVatPhrase || (hasHmrcAny && hasVatWord));

  const isPaye =
    hasPayeKeyword ||
    (hasHmrcAny && !isVat && !hasCorpTaxKeyword);

  return { isPaye, isVat };
}

/**
 * Derives Monthly vs Quarterly PAYE cycle from matched transaction dates.
 */
export function derivePayeCycleFromDates(dates) {
  if (!Array.isArray(dates) || dates.length === 0) {
    return {
      cycle: "Monthly",
      evidence: "No distinct HMRC PAYE bank transactions detected in trailing 12 months. Defaulting to Monthly."
    };
  }

  const distinctMonths = new Set();
  for (const d of dates) {
    if (d instanceof Date && !isNaN(d.getTime())) {
      distinctMonths.add(`${d.getFullYear()}-${d.getMonth() + 1}`);
    }
  }

  if (distinctMonths.size >= 5) {
    return {
      cycle: "Monthly",
      evidence: `Detected ${dates.length} HMRC/PAYE transaction(s) across ${distinctMonths.size} month(s) in trailing 12 months. Suggesting Monthly.`
    };
  }
  if (distinctMonths.size >= 2 && distinctMonths.size <= 4) {
    return {
      cycle: "Quarterly",
      evidence: `Detected ${dates.length} HMRC/PAYE transaction(s) across ${distinctMonths.size} quarter/month intervals in trailing 12 months. Suggesting Quarterly.`
    };
  }
  return {
    cycle: "Monthly",
    evidence: `Detected ${dates.length} HMRC/PAYE payment transaction(s). Suggesting Monthly.`
  };
}

/**
 * Infers the UK VAT quarter stagger cycle from HMRC VAT payment/refund dates.
 * UK VAT payments are typically collected ~1 month + 7 days after quarter end:
 * - Days 1..18 of month M -> quarter ended 2 months earlier (M - 2)
 * - Days 19..31 of month M -> manual payment for quarter ended 1 month earlier (M - 1)
 */
export function deriveVatQuarterFromDates(dates) {
  if (!Array.isArray(dates) || dates.length === 0) {
    return null;
  }

  const votes = new Map();
  const distinctMonths = new Set();
  const monthLabels = [];

  for (const d of dates) {
    if (!(d instanceof Date) || isNaN(d.getTime())) continue;
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const offset = day <= 18 ? 2 : 1;
    const inferredEndMonth = ((month - 1 - offset + 12) % 12) + 1;
    const cycle = deriveVatQuarterCycle(inferredEndMonth);

    votes.set(cycle, (votes.get(cycle) || 0) + 1);
    const key = `${d.getFullYear()}-${month}`;
    if (!distinctMonths.has(key)) {
      distinctMonths.add(key);
      monthLabels.push(`${MONTH_NAMES_SHORT[month - 1]} ${d.getFullYear()}`);
    }
  }

  if (votes.size === 0) return null;

  if (distinctMonths.size >= 8) {
    return {
      cycle: null,
      isMonthlyVat: true,
      evidence: `Detected ${dates.length} HMRC VAT transaction(s) across ${distinctMonths.size} months (appears to be monthly VAT filing).`
    };
  }

  const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [topCycle, topVotes] = sorted[0];
  const secondVotes = sorted[1]?.[1] || 0;

  if (topVotes === secondVotes) {
    return {
      cycle: null,
      isMonthlyVat: false,
      evidence: `Detected ${dates.length} HMRC VAT transaction(s) (${monthLabels.join(", ")}), but stagger votes were tied.`
    };
  }

  return {
    cycle: topCycle,
    isMonthlyVat: false,
    evidence: `Inferred from ${dates.length} HMRC VAT transaction(s) in ${monthLabels.join(", ")}.`
  };
}

/**
 * Queries paginated QuickBooks entities up to a safe page cap.
 */
async function fetchQuickBooksQueryAll({ accessToken, realmId, entity, whereClause, maxPages = 5 }) {
  const pageSize = 1000;
  const rows = [];

  for (let page = 0; page < maxPages; page++) {
    const startPosition = page * pageSize + 1;
    const query = `SELECT * FROM ${entity} WHERE ${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`;
    const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}/query?query=${encodeURIComponent(query)}&minorversion=73`;

    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json"
      },
      redirect: "manual"
    });

    if (!res.ok) {
      throw new Error(`QuickBooks ${entity} query returned status ${res.status}`);
    }

    const data = await res.json();
    const batch = data?.QueryResponse?.[entity] || [];
    rows.push(...batch);

    if (batch.length < pageSize) break;
  }

  return rows;
}

/**
 * Inspects QuickBooks Purchase, BillPayment, and Transfer records for trailing 12-month HMRC PAYE & VAT payments.
 */
async function inspectQuickBooksHmrcDates({ accessToken, realmId, startIso, endIso }) {
  const whereClause = `TxnDate >= '${startIso}' AND TxnDate <= '${endIso}'`;
  const sources = [
    {
      entity: "Purchase",
      extract: (p) => {
        const lineText = (p.Line || [])
          .map(l => `${l.Description || ""} ${l.AccountBasedExpenseLineDetail?.AccountRef?.name || ""} ${l.ItemBasedExpenseLineDetail?.ItemRef?.name || ""}`)
          .join(" ");
        const partyName = p.EntityRef?.name || "";
        return {
          partyName,
          text: `${partyName} ${p.PrivateNote || ""} ${p.DocNumber || ""} ${lineText}`
        };
      }
    },
    {
      entity: "BillPayment",
      extract: (bp) => {
        const partyName = bp.VendorRef?.name || "";
        return {
          partyName,
          text: `${partyName} ${bp.PrivateNote || ""} ${bp.DocNumber || ""}`
        };
      }
    },
    {
      entity: "Transfer",
      extract: (t) => ({
        partyName: `${t.FromAccountRef?.name || ""} ${t.ToAccountRef?.name || ""}`,
        text: `${t.FromAccountRef?.name || ""} ${t.ToAccountRef?.name || ""} ${t.PrivateNote || ""}`
      })
    }
  ];

  const results = await Promise.allSettled(
    sources.map(src => fetchQuickBooksQueryAll({ accessToken, realmId, entity: src.entity, whereClause }))
  );

  const payeDates = [];
  const vatDates = [];
  let succeededCount = 0;

  results.forEach((result, idx) => {
    if (result.status !== "fulfilled") {
      console.warn(`⚠️ QuickBooks ${sources[idx].entity} HMRC query failed:`, result.reason?.message);
      return;
    }
    succeededCount++;
    for (const row of result.value) {
      const { isPaye, isVat } = classifyHmrcTransaction(sources[idx].extract(row));
      if (!isPaye && !isVat) continue;
      const d = parseIsoDateLocal(row.TxnDate);
      if (d && !isNaN(d.getTime())) {
        if (isPaye) payeDates.push(d);
        if (isVat) vatDates.push(d);
      }
    }
  });

  if (succeededCount === 0) {
    throw new Error("All QuickBooks transaction queries failed.");
  }

  return { payeDates, vatDates };
}

/**
 * Suggests initial accounting settings for KeyInfo (Start date, VAT quarters, VAT scheme, PAYE cycle).
 */
export async function suggestAccountingSettings({ clientName, masterSheetId, isAdmin = true }) {
  if (!clientName) throw new Error("Missing clientName parameter.");
  const unwrappedId = masterSheetId ? unwrapSheetId(String(masterSheetId).trim()) : "";
  const cleanMasterId = unwrappedId ? (extractSheetIdFromUrl(unwrappedId) || unwrappedId) : "";

  const auth = await resolveAccountingToolAuth(clientName, cleanMasterId);
  const sheets = await getSheetsClient();

  // Read existing KeyInfo!B1:B20 for context
  let currentKeyInfo = {};
  if (cleanMasterId) {
    try {
      const res = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: cleanMasterId,
          range: "KeyInfo!A1:B20"
        })
      );
      const rows = res.data.values || [];
      rows.forEach(r => {
        const label = String(r[0] || "").trim();
        const val = String(r[1] || "").trim();
        if (label) currentKeyInfo[label] = val;
      });
    } catch (err) {
      console.warn("⚠️ Could not read current KeyInfo settings:", err.message);
    }
  }

  let detectedTool = auth ? auth.tool : "None";
  let financialYearEndMonth = 3; // Default March
  let financialYearEndDay = 31;
  let rawTaxBasis = "";
  let rawTaxPeriod = "";
  let xeroPeriodLockDate = null;
  let baseCurrency = "GBP";
  let inspectionNotes = [];
  let flatRateWarning = null;
  let vatSchemeNotice = null;

  if (auth && auth.tool === "Xero") {
    try {
      const orgRes = await fetch("https://api.xero.com/api.xro/2.0/Organisation", {
        headers: {
          "Authorization": `Bearer ${auth.accessToken}`,
          "Xero-tenant-id": auth.tenantId,
          "Accept": "application/json"
        }
      });

      if (orgRes.ok) {
        const orgData = await orgRes.json();
        const org = orgData?.Organisations?.[0] || {};
        financialYearEndDay = org.FinancialYearEndDay || 31;
        financialYearEndMonth = org.FinancialYearEndMonth || 3;
        rawTaxBasis = String(org.SalesTaxBasis || "").toUpperCase();
        rawTaxPeriod = String(org.SalesTaxPeriod || "").toUpperCase();
        xeroPeriodLockDate = parseXeroDate(org.PeriodLockDate);
        baseCurrency = org.BaseCurrency || org.DefaultCurrency || "GBP";

        inspectionNotes.push(`Connected to Xero organisation: "${org.Name || clientName}".`);
        inspectionNotes.push(`Financial year end: ${financialYearEndDay} ${MONTH_NAMES_SHORT[financialYearEndMonth - 1] || financialYearEndMonth}.`);
        if (rawTaxPeriod === "MONTHLY" || rawTaxPeriod === "YEARLY") {
          inspectionNotes.push(`Xero VAT filing period is set to ${rawTaxPeriod.toLowerCase()}. Pulse tracks VAT on a quarterly cycle — please confirm the closest quarterly stagger.`);
        }
      } else {
        inspectionNotes.push(`Xero Organisation API returned status ${orgRes.status}.`);
      }
    } catch (err) {
      console.warn("⚠️ Error fetching Xero Organisation:", err.message);
      inspectionNotes.push(`Could not query Xero Organisation API: ${err.message}.`);
    }
  } else if (auth && auth.tool === "QuickBooks") {
    try {
      const safeRealmId = assertValidQBRealmId(auth.realmId);
      const prefUrl = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/preferences?minorversion=73`;
      const prefRes = await fetch(prefUrl, {
        headers: {
          "Authorization": `Bearer ${auth.accessToken}`,
          "Accept": "application/json"
        },
        redirect: "manual"
      });
      if (prefRes.ok) {
        const prefData = await prefRes.json();
        const prefs = prefData?.Preferences || {};
        const firstMonthStr = prefs.AccountingInfoPrefs?.FirstMonthOfFiscalYear || "April";
        const monthMap = {
          january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
          july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
        };
        const startM = monthMap[firstMonthStr.toLowerCase()] || 4;
        // End month is month before start month
        financialYearEndMonth = startM === 1 ? 12 : startM - 1;

        const homeCurrency = prefs.CurrencyPrefs?.HomeCurrency?.value;
        if (homeCurrency) {
          baseCurrency = String(homeCurrency).toUpperCase();
        }

        const reportBasis = prefs.ReportPrefs?.ReportBasis;
        inspectionNotes.push(`Connected to QuickBooks company. First fiscal month: ${firstMonthStr}.`);
        if (reportBasis) {
          inspectionNotes.push(`QuickBooks default report basis: ${reportBasis}.`);
        }

        vatSchemeNotice = `QuickBooks does not expose the HMRC VAT accounting scheme via its API${reportBasis ? ` (default report basis is ${reportBasis}, which may differ from VAT scheme)` : ""}. Defaulted to Accrual — please confirm Cash vs Accrual and check whether the client uses the Flat Rate scheme.`;
      } else {
        inspectionNotes.push(`QuickBooks Preferences API returned status ${prefRes.status}.`);
        vatSchemeNotice = "Could not inspect QuickBooks preferences. Defaulted VAT scheme to Accrual — please confirm Cash vs Accrual with the client.";
      }
    } catch (err) {
      console.warn("⚠️ Error fetching QuickBooks Preferences:", err.message);
      inspectionNotes.push(`Could not query QuickBooks Preferences API: ${err.message}.`);
      vatSchemeNotice = "Could not inspect QuickBooks preferences. Defaulted VAT scheme to Accrual — please confirm Cash vs Accrual with the client.";
    }
  } else {
    inspectionNotes.push("No accounting tool connected in Pulse Vault yet. Using standard defaults.");
  }

  // 1. Calculate 1st of current financial year (formatted d-Mmm-yy)
  const fyStartDate = calculateCurrentFinancialYearStart(financialYearEndMonth);
  const suggestedStartDate = formatDMmmyy(fyStartDate);

  // 2. VAT Scheme mapping
  let suggestedVatScheme = "Accrual";
  if (rawTaxBasis.includes("CASH")) {
    suggestedVatScheme = "Cash";
  } else if (rawTaxBasis.includes("ACCRUAL") || rawTaxBasis.includes("INVOICE")) {
    suggestedVatScheme = "Accrual";
  }

  // Check for Flat Rate Scheme (unsupported in Pulse)
  if (rawTaxBasis.includes("FLAT")) {
    flatRateWarning = `Flat rate scheme (${rawTaxBasis}) detected in ${detectedTool}. Pulse does not support the Flat Rate VAT scheme. Please choose Cash or Accrual or consult the client.`;
    inspectionNotes.push(flatRateWarning);
  }

  // 3. Trailing 12-month HMRC transaction inspection (shared pass for both PAYE cycle and VAT quarters)
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const startIso = oneYearAgo.toISOString().split("T")[0];
  const endIso = new Date().toISOString().split("T")[0];

  let payeResult = {
    cycle: "Monthly",
    evidence: "Defaulted to monthly cycle."
  };
  let vatDates = [];
  let transactionFetchError = null;

  if (auth && auth.tool === "Xero") {
    try {
      const [startY, startM, startD] = startIso.split("-").map(Number);
      const [endY, endM, endD] = endIso.split("-").map(Number);
      const whereClause = `Date>=DateTime(${startY},${startM},${startD}) AND Date<=DateTime(${endY},${endM},${endD})`;
      const btUrl = `https://api.xero.com/api.xro/2.0/BankTransactions?where=${encodeURIComponent(whereClause)}`;

      const btRes = await fetch(btUrl, {
        headers: {
          "Authorization": `Bearer ${auth.accessToken}`,
          "Xero-tenant-id": auth.tenantId,
          "Accept": "application/json"
        }
      });

      if (btRes.ok) {
        const btData = await btRes.json();
        const txs = btData?.BankTransactions || [];
        const payeDates = [];
        for (const tx of txs) {
          if (tx.Status === "DELETED") continue;
          const partyName = tx.Contact?.Name || "";
          const text = `${partyName} ${tx.Reference || ""} ${(tx.LineItems || []).map(l => l.Description).join(" ")}`;
          const { isPaye, isVat } = classifyHmrcTransaction({ text, partyName });
          if (!isPaye && !isVat) continue;
          const d = parseXeroDate(tx.Date);
          if (d && !isNaN(d.getTime())) {
            if (isPaye) payeDates.push(d);
            if (isVat) vatDates.push(d);
          }
        }
        payeResult = derivePayeCycleFromDates(payeDates);
      } else {
        transactionFetchError = `Xero bank transactions API returned status ${btRes.status}.`;
        payeResult.evidence = `${transactionFetchError} Defaulting to Monthly.`;
      }
    } catch (txErr) {
      console.warn("⚠️ Error inspecting Xero HMRC bank transactions:", txErr.message);
      transactionFetchError = "Could not inspect Xero bank transactions.";
      payeResult.evidence = "Could not inspect Xero bank transactions for PAYE. Defaulting to Monthly.";
    }
  } else if (auth && auth.tool === "QuickBooks") {
    try {
      const safeRealmId = assertValidQBRealmId(auth.realmId);
      const { payeDates, vatDates: qbVatDates } = await inspectQuickBooksHmrcDates({
        accessToken: auth.accessToken,
        realmId: safeRealmId,
        startIso,
        endIso
      });
      vatDates = qbVatDates;
      payeResult = derivePayeCycleFromDates(payeDates);
    } catch (txErr) {
      console.warn("⚠️ Error inspecting QuickBooks HMRC transactions:", txErr.message);
      transactionFetchError = "Could not inspect QuickBooks transactions.";
      payeResult.evidence = "Could not inspect QuickBooks transactions for PAYE. Defaulting to Monthly.";
    }
  }

  // 4. Layered VAT Quarters Detection
  // Layer 1: HMRC VAT payment/refund transaction history
  let suggestedVatQuarters = null;
  let vatQuartersEvidence = "";
  const vatFromTx = deriveVatQuarterFromDates(vatDates);

  if (vatFromTx?.cycle) {
    suggestedVatQuarters = vatFromTx.cycle;
    vatQuartersEvidence = vatFromTx.evidence;
  } else if (xeroPeriodLockDate && isMonthEndDate(xeroPeriodLockDate)) {
    // Layer 2: Xero PeriodLockDate (if set to a calendar month-end)
    const lockMonth = xeroPeriodLockDate.getMonth() + 1;
    suggestedVatQuarters = deriveVatQuarterCycle(lockMonth);
    const lockLabel = `${MONTH_NAMES_SHORT[lockMonth - 1]} ${xeroPeriodLockDate.getFullYear()}`;
    vatQuartersEvidence = vatFromTx?.evidence
      ? `${vatFromTx.evidence} Used Xero period lock date (${lockLabel}) as tie-breaker.`
      : `No distinct HMRC VAT transactions detected; inferred from Xero period lock date (${lockLabel}).`;
  } else {
    // Layer 3: Fallback to Financial Year End month
    suggestedVatQuarters = deriveVatQuarterCycle(financialYearEndMonth);
    const fyEndName = MONTH_NAMES_SHORT[financialYearEndMonth - 1] || financialYearEndMonth;
    if (vatFromTx?.evidence) {
      vatQuartersEvidence = `${vatFromTx.evidence} Fell back to financial year end (${fyEndName}).`;
    } else if (transactionFetchError) {
      vatQuartersEvidence = `${transactionFetchError} Estimated VAT quarters from financial year end (${fyEndName}).`;
    } else {
      vatQuartersEvidence = `No distinct HMRC VAT transactions detected in trailing 12 months; estimated from financial year end (${fyEndName}). Please verify against HMRC VAT stagger.`;
    }
  }

  const suggestedPayeCycle = payeResult.cycle;
  const payeInspectionEvidence = payeResult.evidence;

  const safeNotes = isAdmin ? inspectionNotes : inspectionNotes.map((n) => sanitizeSpreadsheetTerms(n));
  const safeEvidence = isAdmin ? payeInspectionEvidence : sanitizeSpreadsheetTerms(payeInspectionEvidence);
  const safeVatQuartersEvidence = isAdmin ? vatQuartersEvidence : sanitizeSpreadsheetTerms(vatQuartersEvidence);
  const safeVatNotice = vatSchemeNotice
    ? (isAdmin ? vatSchemeNotice : sanitizeSpreadsheetTerms(vatSchemeNotice))
    : null;

  return {
    success: true,
    detectedTool,
    financialYearEndMonth,
    financialYearEndDay,
    currentKeyInfoValues: {
      startDate: currentKeyInfo["Pulse tracker start date:"] || currentKeyInfo["Tracker start date:"] || "",
      vatQuarters: currentKeyInfo["VAT quarters:"] || "",
      vatScheme: currentKeyInfo["VAT payment scheme:"] || "",
      payeCycle: currentKeyInfo["PAYE cycle:"] || "",
      primaryCurrency: currentKeyInfo["Primary currency:"] || "GBP"
    },
    suggestions: {
      startDate: suggestedStartDate,
      vatQuarters: suggestedVatQuarters,
      vatScheme: suggestedVatScheme,
      vatRate: "20%",
      payeCycle: suggestedPayeCycle,
      primaryCurrency: baseCurrency
    },
    flatRateWarning: isAdmin ? flatRateWarning : (flatRateWarning ? sanitizeSpreadsheetTerms(flatRateWarning) : null),
    vatSchemeNotice: safeVatNotice,
    inspectionNotes: safeNotes,
    payeInspectionEvidence: safeEvidence,
    vatQuartersEvidence: safeVatQuartersEvidence
  };
}

/**
 * Normalizes an account or category name for regex matching.
 */
function cleanCategoryName(name) {
  return String(name || "").trim().toLowerCase();
}

function normalizeAccountTypeBucket(rawType) {
  const t = String(rawType || "").trim().toUpperCase();
  if (t === "REVENUE" || t === "INCOME" || t === "SALES") return "REVENUE";
  if (t === "OTHERINCOME" || t === "OTHER INCOME") return "OTHERINCOME";
  if (t === "DIRECTCOSTS" || t === "COST OF GOODS SOLD") return "DIRECTCOSTS";
  if (t === "EXPENSE" || t === "OVERHEADS" || t === "OTHER EXPENSE") return "EXPENSE";
  return "";
}

/**
 * Fetches a 4-year P&L report (including section headers & summary rows) and active P&L Chart of Accounts from Xero.
 */
async function fetchXeroPlAndAccounts(auth) {
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const fromStr = oneYearAgo.toISOString().split("T")[0];
  const toStr = new Date().toISOString().split("T")[0];

  const headers = {
    "Authorization": `Bearer ${auth.accessToken}`,
    "Xero-tenant-id": auth.tenantId,
    "Accept": "application/json"
  };

  const [plRes, accRes] = await Promise.all([
    fetch(`https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${fromStr}&toDate=${toStr}&periods=4&timeframe=YEAR&standardLayout=false`, { headers }).catch(() => null),
    fetch("https://api.xero.com/api.xro/2.0/Accounts", { headers }).catch(() => null)
  ]);

  const accountTypeMap = new Map();
  const activePlAccounts = [];
  if (accRes && accRes.ok) {
    const accData = await accRes.json();
    for (const a of (accData.Accounts || [])) {
      const bucket = normalizeAccountTypeBucket(a.Type);
      const name = String(a.Name || "").trim();
      if (!bucket || !name) continue;
      accountTypeMap.set(name.toLowerCase(), bucket);
      if (String(a.Status || "").toUpperCase() === "ACTIVE") {
        activePlAccounts.push({ name, accountType: bucket });
      }
    }
  }

  const plRows = [];
  if (plRes && plRes.ok) {
    const plData = await plRes.json();
    const walk = (node, sectionHint = "") => {
      if (!node) return;
      if (node.RowType === "Section") {
        const title = String(node.Title || "").trim();
        const nextSection = title || sectionHint;
        if (title) {
          plRows.push({ name: title, isStructural: true, sectionHint: nextSection, accountType: "" });
        }
        (node.Rows || []).forEach(child => walk(child, nextSection));
      } else if (node.RowType === "SummaryRow") {
        const title = String(node.Cells?.[0]?.Value || "").trim();
        if (title) {
          plRows.push({ name: title, isStructural: true, sectionHint, accountType: "" });
        }
      } else if (node.RowType === "Row") {
        const title = String(node.Cells?.[0]?.Value || "").trim();
        if (!title) return;
        const attrs = node.Cells?.[0]?.Attributes || [];
        const hasAccountAttr = attrs.some(a => String(a.Id || "").toLowerCase() === "account");
        const acctType = accountTypeMap.get(title.toLowerCase()) || "";
        plRows.push({
          name: title,
          isStructural: !hasAccountAttr && !acctType,
          sectionHint,
          accountType: acctType
        });
      }
    };
    (plData?.Reports?.[0]?.Rows || []).forEach(r => walk(r, ""));
  }

  return { plRows, activePlAccounts, accountTypeMap };
}

/**
 * Fetches a 4-year P&L report (including section headers & summary rows) and active P&L Chart of Accounts from QuickBooks.
 */
async function fetchQuickBooksPlAndAccounts(auth) {
  const safeRealmId = assertValidQBRealmId(auth.realmId);
  const fourYearsAgo = new Date();
  fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
  const startStr = fourYearsAgo.toISOString().split("T")[0];
  const endStr = new Date().toISOString().split("T")[0];

  const headers = {
    "Authorization": `Bearer ${auth.accessToken}`,
    "Accept": "application/json"
  };

  const accQuery = "SELECT Id, Name, AccountType, Active FROM Account WHERE AccountType IN ('Income', 'Other Income', 'Cost of Goods Sold', 'Expense', 'Other Expense') AND Active = true MAXRESULTS 1000";
  const [plRes, accRes] = await Promise.all([
    fetch(`https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/reports/ProfitAndLoss?start_date=${startStr}&end_date=${endStr}&minorversion=73`, { headers, redirect: "manual" }).catch(() => null),
    fetch(`https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/query?query=${encodeURIComponent(accQuery)}&minorversion=73`, { headers, redirect: "manual" }).catch(() => null)
  ]);

  const accountTypeMap = new Map();
  const activePlAccounts = [];
  if (accRes && accRes.ok) {
    const accData = await accRes.json();
    for (const a of (accData?.QueryResponse?.Account || [])) {
      const bucket = normalizeAccountTypeBucket(a.AccountType);
      const name = String(a.Name || "").trim();
      if (!bucket || !name) continue;
      accountTypeMap.set(name.toLowerCase(), bucket);
      activePlAccounts.push({ name, accountType: bucket });
    }
  }

  const plRows = [];
  if (plRes && plRes.ok) {
    const plData = await plRes.json();
    const walk = (node, sectionHint = "") => {
      if (!node || (!node.Header && !node.Summary && !node.ColData)) return;
      if (node.type === "Section" && node.Header?.ColData?.length > 0) {
        const headerCol = node.Header.ColData[0];
        const title = String(headerCol?.value || "").trim();
        const nextSection = title || sectionHint;
        if (title) {
          const isParentAccount = Boolean(headerCol?.id);
          plRows.push({
            name: title,
            isStructural: !isParentAccount,
            sectionHint: nextSection,
            accountType: isParentAccount ? (accountTypeMap.get(title.toLowerCase()) || "") : ""
          });
        }
        if (node.Rows?.Row) {
          node.Rows.Row.forEach(child => walk(child, nextSection));
        }
        if (node.Summary?.ColData?.length > 0) {
          const sumTitle = String(node.Summary.ColData[0]?.value || "").trim();
          if (sumTitle) {
            plRows.push({ name: sumTitle, isStructural: true, sectionHint: nextSection, accountType: "" });
          }
        }
      } else if (node.Summary?.ColData?.length > 0) {
        const title = String(node.Summary.ColData[0]?.value || "").trim();
        if (title) {
          plRows.push({ name: title, isStructural: true, sectionHint, accountType: "" });
        }
      } else if (node.ColData?.length > 0) {
        const title = String(node.ColData[0]?.value || "").trim();
        if (title) {
          plRows.push({
            name: title,
            isStructural: false,
            sectionHint,
            accountType: accountTypeMap.get(title.toLowerCase()) || ""
          });
        }
      }
    };
    (plData?.Rows?.Row || []).forEach(r => walk(r, ""));
  }

  return { plRows, activePlAccounts, accountTypeMap };
}

/**
 * Suggests classification of P&L categories into Pulse Master Sheet sections (KeyInfo!BA2:BA180).
 */
export async function suggestCategoryMappings({ clientName, masterSheetId, isAdmin = true }) {
  if (!clientName) throw new Error("Missing clientName parameter.");
  const unwrappedId = masterSheetId ? unwrapSheetId(String(masterSheetId).trim()) : "";
  const cleanMasterId = unwrappedId ? (extractSheetIdFromUrl(unwrappedId) || unwrappedId) : "";
  const sheets = await getSheetsClient();

  // Read existing categories and current mappings from Master Sheet
  const [beResp, bgResp, baResp] = await Promise.all([
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "KeyInfo!BE2:BE"
    })).catch(() => ({ data: { values: [] } })),
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "KeyInfo!BG2:BG"
    })).catch(() => ({ data: { values: [] } })),
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "KeyInfo!BA2:BA180"
    })).catch(() => ({ data: { values: [] } }))
  ]);

  const rawPlCategories = (beResp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
  const remainingCategories = (bgResp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);

  // Pull 4-year P&L (for all historical categories + section headers/subtotals) & full Chart of Accounts
  const candidateEntries = [];
  const seenLower = new Set();
  const addCandidate = ({ name, isStructural = false, sectionHint = "", accountType = "" }) => {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    const key = cleanName.toLowerCase();
    if (seenLower.has(key)) return;
    seenLower.add(key);
    candidateEntries.push({ name: cleanName, isStructural, sectionHint, accountType });
  };

  let sourceOrigin = isAdmin ? "Master Sheet P&L (KeyInfo!BE)" : "Saved P&L categories";
  let liveAccountTypeMap = new Map();

  const auth = await resolveAccountingToolAuth(clientName, cleanMasterId);
  if (auth && auth.tool === "Xero") {
    try {
      const { plRows, activePlAccounts, accountTypeMap } = await fetchXeroPlAndAccounts(auth);
      liveAccountTypeMap = accountTypeMap;
      plRows.forEach(addCandidate);
      rawPlCategories.forEach(name => addCandidate({ name, accountType: liveAccountTypeMap.get(name.toLowerCase()) || "" }));
      activePlAccounts.forEach(acc => addCandidate({ name: acc.name, accountType: acc.accountType }));

      if (plRows.length > 0 && activePlAccounts.length > 0) {
        sourceOrigin = "4-year Xero P&L & full Chart of Accounts";
      } else if (plRows.length > 0) {
        sourceOrigin = "4-year Xero P&L";
      } else if (activePlAccounts.length > 0) {
        sourceOrigin = "Xero Chart of Accounts";
      }
    } catch (err) {
      console.warn("⚠️ Could not fetch Xero P&L & accounts:", err.message);
    }
  } else if (auth && auth.tool === "QuickBooks") {
    try {
      const { plRows, activePlAccounts, accountTypeMap } = await fetchQuickBooksPlAndAccounts(auth);
      liveAccountTypeMap = accountTypeMap;
      plRows.forEach(addCandidate);
      rawPlCategories.forEach(name => addCandidate({ name, accountType: liveAccountTypeMap.get(name.toLowerCase()) || "" }));
      activePlAccounts.forEach(acc => addCandidate({ name: acc.name, accountType: acc.accountType }));

      if (plRows.length > 0 && activePlAccounts.length > 0) {
        sourceOrigin = "4-year QuickBooks P&L & full Chart of Accounts";
      } else if (plRows.length > 0) {
        sourceOrigin = "4-year QuickBooks P&L";
      } else if (activePlAccounts.length > 0) {
        sourceOrigin = "QuickBooks Chart of Accounts";
      }
    } catch (err) {
      console.warn("⚠️ Could not fetch QuickBooks P&L & accounts:", err.message);
    }
  }

  // Ensure any existing KeyInfo!BE2:BE categories are included (e.g. if no tool connected or live fetch failed)
  rawPlCategories.forEach(name => addCandidate({ name, accountType: liveAccountTypeMap.get(name.toLowerCase()) || "" }));

  // Current BA mappings (BA2:BA180)
  const baValues = baResp.data.values || [];
  const getSliceValues = (startRow, endRow) => {
    const list = [];
    for (let r = startRow; r <= endRow; r++) {
      const idx = r - 2;
      const v = String(baValues[idx]?.[0] || "").trim();
      if (v) list.push(v);
    }
    return list;
  };

  const currentMappings = {
    revenue: getSliceValues(2, 17),
    cosStaffCosts: getSliceValues(19, 28),
    nonCosStaffCosts: getSliceValues(35, 43),
    corporationTax: getSliceValues(50, 52),
    depreciation: getSliceValues(54, 56),
    otherCostOfSale: getSliceValues(59, 78),
    nonOperatingIncome: getSliceValues(81, 93),
    nonOperatingExpenses: getSliceValues(101, 110),
    ignore: getSliceValues(128, 180)
  };

  // Rule-based classification buckets
  const suggested = {
    revenue: [],
    cosStaffCosts: [],
    nonCosStaffCosts: [],
    corporationTax: [],
    depreciation: [],
    otherCostOfSale: [],
    nonOperatingIncome: [],
    nonOperatingExpenses: [],
    ignore: [],
    overheads: [] // Remaining accounts treated as general overheads
  };

  // Compile regex patterns
  // 1. Ignore headers and subtotal summary rows
  const ignorePattern = /^(description|income|total income|trading income|total trading income|turnover|total turnover|revenue|total revenue|cost of sales|less cost of sales|total cost of sales|total less cost of sales|cost of goods sold|total cost of goods sold|cogs|total cogs|gross profit|operating expenses|less operating expenses|total operating expenses|total less operating expenses|total expenses|expenses|administrative expenses|total administrative expenses|administrative costs|total administrative costs|operating profit|net operating income|net profit|net income|net loss|net profit \/ \(loss\)|profit \/ \(loss\)|profit before tax|profit after tax|profit for the year|non-operating income|total non-operating income|non-operating expenses|total non-operating expenses|other income|total other income|other expenses|total other expenses|net other income|total overheads|overheads)$/i;

  // 2. CoS staff costs (Crucially includes Salaries, Wages, Employers NI, Staff Pension, Freelancers)
  const cosStaffPattern = /\b(salaries|salary|wages|direct wages|employers ni|employer ni|employer's ni|employers nic|employer's nic|employers national insurance|national insurance|staff pension|pension contributions?|pensions?(?:\s+costs?)?|subcontractors?|sub-contractors?|freelancers?|freelance(?:\s+work)?|contractor wages|direct labour|direct labor)\b/i;

  // 3. Non-CoS staff costs (Overhead staff expenses: training, welfare, directors remuneration)
  const nonCosStaffPattern = /\b(staff training|staff welfare|staff entertainment|recruitment|recruitment fees|directors'? remuneration|directors'? salaries|director salaries)\b/i;

  // 4. Revenue (excludes bare "fees" so Bank Fees / Stripe Fees / Accountancy fees don't false-match)
  const revenuePattern = /\b(sales|revenue|fee income|turnover|client fees?|retainer fees?|consulting fees?|service fees?|management fees?|agency fees?|billable revenue|subscription income|retainers?)\b/i;

  // 5. Corporation Tax
  const corpTaxPattern = /\b(corporation tax|provision for corporation tax|corp tax|tax on profit|ct provision)\b/i;

  // 6. Depreciation & Amortisation
  const depreciationPattern = /\b(depreciation|amortisation|amortization)\b/i;

  // 7. Other Cost of Sale (materials, hosting, disbursements, direct expenses)
  const otherCosPattern = /(?:\bdirect\s*-|\b(?:cost of goods sold|direct costs?|direct expenses?|materials?|hosting|server hosting|domain|production|disbursements?|client expenses|rechargeable|sub-contracts?)\b)/i;

  // 8. Non-operating income
  const nonOpIncomePattern = /\b(interest income|interest received|bank interest received|grant income|other income|r&d tax credit|gain on disposal)\b/i;

  // 9. Non-operating expenses
  const nonOpExpensePattern = /\b(bank interest paid|interest expense|interest paid|loan interest|finance costs?|penalties|fines|fines and penalties|loss on disposal)\b/i;

  candidateEntries.forEach(entry => {
    const cat = entry.name;
    const clean = cleanCategoryName(cat);
    // Strip nominal code prefix if present for matching (e.g. "200 - Sales" -> "sales")
    const withoutCode = clean.replace(/^\d+[\s\-_:]+/, "").trim();
    const sectionLower = cleanCategoryName(entry.sectionHint);
    const acctType = entry.accountType;

    const inCosSection = /\b(cost of sales|cost of goods sold)\b/i.test(sectionLower);
    const inOtherIncomeSection = /\b(non-operating income|other income)\b/i.test(sectionLower);
    const inIncomeSection =
      !inCosSection &&
      !inOtherIncomeSection &&
      !/\b(non-operating|operating expenses|administrative)\b/i.test(sectionLower) &&
      /\b(income|turnover|revenue|sales)\b/i.test(sectionLower);

    const isIgnoredByName =
      !acctType && (ignorePattern.test(withoutCode) || ignorePattern.test(clean));

    if (entry.isStructural || isIgnoredByName) {
      suggested.ignore.push(cat);
    } else if (cosStaffPattern.test(withoutCode) || cosStaffPattern.test(clean)) {
      suggested.cosStaffCosts.push(cat);
    } else if (nonCosStaffPattern.test(withoutCode) || nonCosStaffPattern.test(clean)) {
      suggested.nonCosStaffCosts.push(cat);
    } else if (corpTaxPattern.test(withoutCode) || corpTaxPattern.test(clean)) {
      suggested.corporationTax.push(cat);
    } else if (depreciationPattern.test(withoutCode) || depreciationPattern.test(clean)) {
      suggested.depreciation.push(cat);
    } else if (otherCosPattern.test(withoutCode) || otherCosPattern.test(clean)) {
      suggested.otherCostOfSale.push(cat);
    } else if (nonOpIncomePattern.test(withoutCode) || nonOpIncomePattern.test(clean) || acctType === "OTHERINCOME" || inOtherIncomeSection) {
      suggested.nonOperatingIncome.push(cat);
    } else if (nonOpExpensePattern.test(withoutCode) || nonOpExpensePattern.test(clean)) {
      suggested.nonOperatingExpenses.push(cat);
    } else if (acctType === "REVENUE" || inIncomeSection || (acctType !== "EXPENSE" && (revenuePattern.test(withoutCode) || revenuePattern.test(clean)))) {
      suggested.revenue.push(cat);
    } else if (acctType === "DIRECTCOSTS" || inCosSection) {
      suggested.otherCostOfSale.push(cat);
    } else {
      // General overheads (Rent, Software, Travel, Legal, Audit, Bank/Stripe fees, etc.)
      suggested.overheads.push(cat);
    }
  });

  return {
    success: true,
    sourceOrigin,
    totalCandidateCategories: candidateEntries.length,
    currentMappings,
    suggested,
    remainingCategories
  };
}

/**
 * Writes approved initial accounting settings to Master Sheet (KeyInfo!B2, B6, B8, B9, B12, B17).
 */
export async function applyAccountingSettings({ clientName, masterSheetId, settings }) {
  if (!clientName || !masterSheetId) {
    throw new Error("Missing clientName or masterSheetId parameter.");
  }
  const unwrappedId = unwrapSheetId(String(masterSheetId).trim());
  const cleanMasterId = extractSheetIdFromUrl(unwrappedId) || unwrappedId;

  // Use saveClientSettings to write to Google Sheets and invalidate Redis cache
  await saveClientSettings({
    clientName,
    masterSheetId: cleanMasterId,
    settings: {
      main: {
        pulseStartDate: settings.startDate,
        vatQuarters: settings.vatQuarters,
        vatPaymentScheme: settings.vatScheme,
        vatRate: settings.vatRate || "20%",
        payeCycle: settings.payeCycle,
        primaryCurrency: settings.primaryCurrency || "GBP"
      }
    }
  });

  return { success: true, message: "Accounting settings successfully applied to Master Sheet." };
}

/**
 * Writes approved category mapping rules to Master Sheet KeyInfo!BA2:BA180.
 */
export async function applyCategoryMappings({ clientName, masterSheetId, mappings }) {
  if (!clientName || !masterSheetId) {
    throw new Error("Missing clientName or masterSheetId parameter.");
  }
  const unwrappedId = unwrapSheetId(String(masterSheetId).trim());
  const cleanMasterId = extractSheetIdFromUrl(unwrappedId) || unwrappedId;

  // Strip empty/duplicate values and truncate to max slice lengths
  const cleanSlice = (arr, maxLen) => {
    const list = Array.isArray(arr) ? arr.map(v => String(v || "").trim()).filter(Boolean) : [];
    return list.slice(0, maxLen);
  };

  const payloadMappings = {
    revenue: cleanSlice(mappings.revenue, 16),
    cosStaffCosts: cleanSlice(mappings.cosStaffCosts, 10),
    nonCosStaffCosts: cleanSlice(mappings.nonCosStaffCosts, 9),
    corporationTax: cleanSlice(mappings.corporationTax, 3),
    depreciation: cleanSlice(mappings.depreciation, 3),
    otherCostOfSale: cleanSlice(mappings.otherCostOfSale, 20),
    nonOperatingIncome: cleanSlice(mappings.nonOperatingIncome, 13),
    nonOperatingExpenses: cleanSlice(mappings.nonOperatingExpenses, 10),
    ignore: cleanSlice(mappings.ignore, 53)
  };

  await saveClientSettings({
    clientName,
    masterSheetId: cleanMasterId,
    settings: {
      accounting: {
        mappings: payloadMappings
      }
    }
  });

  return { success: true, message: "Category mapping rules successfully applied to Master Sheet." };
}
