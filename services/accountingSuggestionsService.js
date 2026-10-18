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
import { getIntegrationTokens, updateRefreshedTokens, getSharedXeroGrant, updateSharedXeroGrantTokens } from "./vaultService.js";
import { refreshXeroTokens } from "./xeroService.js";
import { refreshQBTokens } from "./quickbooksService.js";
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
async function resolveAccountingToolAuth(clientName, masterSheetId) {
  const cleanMasterId = extractSheetIdFromUrl(masterSheetId) || masterSheetId;
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
 * Suggests initial accounting settings for KeyInfo (Start date, VAT quarters, VAT scheme, PAYE cycle).
 */
export async function suggestAccountingSettings({ clientName, masterSheetId }) {
  if (!clientName) throw new Error("Missing clientName parameter.");
  const cleanMasterId = extractSheetIdFromUrl(masterSheetId) || masterSheetId;

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
  let baseCurrency = "GBP";
  let inspectionNotes = [];
  let flatRateWarning = null;

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
        baseCurrency = org.BaseCurrency || org.DefaultCurrency || "GBP";

        inspectionNotes.push(`Connected to Xero organisation: "${org.Name || clientName}".`);
        inspectionNotes.push(`Financial year end: ${financialYearEndDay} ${MONTH_NAMES_SHORT[financialYearEndMonth - 1] || financialYearEndMonth}.`);
      } else {
        inspectionNotes.push(`Xero Organisation API returned status ${orgRes.status}.`);
      }
    } catch (err) {
      console.warn("⚠️ Error fetching Xero Organisation:", err.message);
      inspectionNotes.push(`Could not query Xero Organisation API: ${err.message}.`);
    }
  } else if (auth && auth.tool === "QuickBooks") {
    try {
      const prefUrl = `https://quickbooks.api.intuit.com/v3/company/${auth.realmId}/preferences`;
      const prefRes = await fetch(prefUrl, {
        headers: {
          "Authorization": `Bearer ${auth.accessToken}`,
          "Accept": "application/json"
        }
      });
      if (prefRes.ok) {
        const prefData = await prefRes.json();
        const firstMonthStr = prefData?.Preferences?.AccountingInfoPrefs?.FirstMonthOfFiscalYear || "April";
        const monthMap = {
          january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
          july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
        };
        const startM = monthMap[firstMonthStr.toLowerCase()] || 4;
        // End month is month before start month
        financialYearEndMonth = startM === 1 ? 12 : startM - 1;
        inspectionNotes.push(`Connected to QuickBooks company. First fiscal month: ${firstMonthStr}.`);
      }
    } catch (err) {
      console.warn("⚠️ Error fetching QuickBooks Preferences:", err.message);
      inspectionNotes.push(`Could not query QuickBooks Preferences API: ${err.message}.`);
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
    inspectionNotes.push(`⚠️ ${flatRateWarning}`);
  }

  // 3. VAT Quarters
  const suggestedVatQuarters = deriveVatQuarterCycle(financialYearEndMonth);

  // 4. PAYE Cycle Inspection
  // Look for PAYE / HMRC payments in bank transactions or journals
  let suggestedPayeCycle = "Monthly";
  let payeInspectionEvidence = "Defaulted to monthly cycle.";

  if (auth && auth.tool === "Xero") {
    try {
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const startIso = oneYearAgo.toISOString().split("T")[0];
      const endIso = new Date().toISOString().split("T")[0];

      // Query bank transactions containing HMRC or PAYE
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
        const payeTxs = txs.filter(tx => {
          if (tx.Status === "DELETED") return false;
          const text = `${tx.Contact?.Name || ""} ${tx.Reference || ""} ${(tx.LineItems || []).map(l => l.Description).join(" ")}`.toLowerCase();
          return text.includes("paye") || text.includes("hmrc") || text.includes("inland revenue");
        });

        if (payeTxs.length > 0) {
          // Count distinct payment months
          const distinctMonths = new Set();
          payeTxs.forEach(tx => {
            const dateStr = String(tx.Date || "").replace("/Date(", "").replace(")/", "");
            const d = new Date(parseInt(dateStr, 10));
            if (!isNaN(d.getTime())) {
              distinctMonths.add(`${d.getFullYear()}-${d.getMonth() + 1}`);
            }
          });

          if (distinctMonths.size >= 5) {
            suggestedPayeCycle = "Monthly";
            payeInspectionEvidence = `Detected ${payeTxs.length} HMRC/PAYE transaction(s) across ${distinctMonths.size} month(s) in trailing 12 months. Suggesting Monthly.`;
          } else if (distinctMonths.size >= 2 && distinctMonths.size <= 4) {
            suggestedPayeCycle = "Quarterly";
            payeInspectionEvidence = `Detected ${payeTxs.length} HMRC/PAYE transaction(s) across ${distinctMonths.size} quarter/month intervals in trailing 12 months. Suggesting Quarterly.`;
          } else {
            payeInspectionEvidence = `Detected ${payeTxs.length} HMRC/PAYE payment transaction(s). Suggesting Monthly.`;
          }
        } else {
          payeInspectionEvidence = "No distinct HMRC PAYE bank transactions detected in trailing 12 months. Defaulting to Monthly.";
        }
      }
    } catch (payeErr) {
      console.warn("⚠️ Error inspecting PAYE bank transactions:", payeErr.message);
      payeInspectionEvidence = "Could not inspect bank transactions for PAYE. Defaulting to Monthly.";
    }
  }

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
    flatRateWarning,
    inspectionNotes,
    payeInspectionEvidence
  };
}

/**
 * Normalizes an account or category name for regex matching.
 */
function cleanCategoryName(name) {
  return String(name || "").trim().toLowerCase();
}

/**
 * Suggests classification of P&L categories into Pulse Master Sheet sections (KeyInfo!BA2:BA180).
 */
export async function suggestCategoryMappings({ clientName, masterSheetId }) {
  if (!clientName) throw new Error("Missing clientName parameter.");
  const cleanMasterId = extractSheetIdFromUrl(masterSheetId) || masterSheetId;
  const sheets = await getSheetsClient();

  // Read existing categories from Master Sheet
  const [beResp, bgResp, awResp, baResp] = await Promise.all([
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
      range: "KeyInfo!AW2:AW"
    })).catch(() => ({ data: { values: [] } })),
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "KeyInfo!BA2:BA180"
    })).catch(() => ({ data: { values: [] } }))
  ]);

  const rawPlCategories = (beResp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
  const remainingCategories = (bgResp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
  const chartOfAccounts = (awResp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);

  // If KeyInfo!BE has categories, use those; otherwise use Chart of Accounts from AW
  let candidateCategories = rawPlCategories.length > 0 ? rawPlCategories : chartOfAccounts;

  // Also check if we can query fresh Chart of Accounts from Xero/QBO if candidateCategories is empty
  let sourceOrigin = rawPlCategories.length > 0 ? "Master Sheet P&L (KeyInfo!BE)" : "Master Sheet Chart of Accounts (KeyInfo!AW)";

  if (candidateCategories.length === 0) {
    const auth = await resolveAccountingToolAuth(clientName, cleanMasterId);
    if (auth && auth.tool === "Xero") {
      try {
        const accRes = await fetch("https://api.xero.com/api.xro/2.0/Accounts", {
          headers: {
            "Authorization": `Bearer ${auth.accessToken}`,
            "Xero-tenant-id": auth.tenantId,
            "Accept": "application/json"
          }
        });
        if (accRes.ok) {
          const accData = await accRes.json();
          candidateCategories = (accData.Accounts || [])
            .filter(a => ["REVENUE", "DIRECTCOSTS", "EXPENSE", "OVERHEADS", "OTHERINCOME"].includes(String(a.Type || "").toUpperCase()))
            .map(a => `${a.Code ? `${a.Code} - ` : ""}${a.Name}`);
          sourceOrigin = "Live Xero Accounts API";
        }
      } catch (err) {
        console.warn("⚠️ Could not fetch Xero accounts:", err.message);
      }
    }
  }

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
  const ignorePattern = /^(description|income|total income|turnover|total turnover|cost of sales|total cost of sales|cost of goods sold|gross profit|operating expenses|total operating expenses|total expenses|expenses|administrative expenses|total administrative expenses|operating profit|net profit|net income|net loss|net profit \/ \(loss\)|net operating income|non-operating income|non-operating expenses|total overheads|overheads)$/i;

  // 2. CoS staff costs (Crucially includes Salaries, Wages, Employers NI, Staff Pension, Direct Wages, Subcontractors)
  const cosStaffPattern = /\b(salaries|salary|wages|direct wages|employers ni|employer ni|employer's ni|employers nic|employer's nic|national insurance|staff pension|pension contributions?|pension|subcontractors?|sub-contractors?|freelancers?|contractor wages|direct labour|direct labor)\b/i;

  // 3. Non-CoS staff costs (Overhead staff expenses: training, welfare, directors remuneration)
  const nonCosStaffPattern = /\b(staff training|staff welfare|staff entertainment|recruitment|recruitment fees|directors remuneration|directors salaries|director salaries)\b/i;

  // 4. Revenue
  const revenuePattern = /\b(sales|fee income|turnover|fees|services|consulting income|client fees?|billable revenue|subscription income|retainers?)\b/i;

  // 5. Corporation Tax
  const corpTaxPattern = /\b(corporation tax|provision for corporation tax|corp tax|tax on profit|ct provision)\b/i;

  // 6. Depreciation & Amortisation
  const depreciationPattern = /\b(depreciation|amortisation|amortization)\b/i;

  // 7. Other Cost of Sale (materials, hosting, disbursements, direct expenses)
  const otherCosPattern = /\b(direct costs?|materials?|hosting|server hosting|domain|production|disbursements?|client expenses|rechargeable|sub-contracts?|freight|print|printing)\b/i;

  // 8. Non-operating income
  const nonOpIncomePattern = /\b(interest income|interest received|bank interest received|grant income|other income|r&d tax credit|gain on disposal)\b/i;

  // 9. Non-operating expenses
  const nonOpExpensePattern = /\b(bank interest paid|interest expense|loan interest|finance costs?|penalties|fines|loss on disposal)\b/i;

  candidateCategories.forEach(cat => {
    const clean = cleanCategoryName(cat);
    // Strip nominal code prefix if present for matching (e.g. "200 - Sales" -> "sales")
    const withoutCode = clean.replace(/^\d+[\s\-_:]+/, "").trim();

    if (ignorePattern.test(withoutCode) || ignorePattern.test(clean)) {
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
    } else if (nonOpIncomePattern.test(withoutCode) || nonOpIncomePattern.test(clean)) {
      suggested.nonOperatingIncome.push(cat);
    } else if (nonOpExpensePattern.test(withoutCode) || nonOpExpensePattern.test(clean)) {
      suggested.nonOperatingExpenses.push(cat);
    } else if (revenuePattern.test(withoutCode) || revenuePattern.test(clean)) {
      suggested.revenue.push(cat);
    } else {
      // General overheads (Rent, Software, Travel, Legal, Audit, etc.)
      suggested.overheads.push(cat);
    }
  });

  return {
    success: true,
    sourceOrigin,
    totalCandidateCategories: candidateCategories.length,
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
  const cleanMasterId = extractSheetIdFromUrl(masterSheetId) || masterSheetId;

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
  const cleanMasterId = extractSheetIdFromUrl(masterSheetId) || masterSheetId;

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
