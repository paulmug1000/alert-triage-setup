/**
 * ============================================================================
 * BANK TRANSACTIONS SERVICE (services/bankTransactionsService.js)
 * ============================================================================
 * 
 * Orchestrates:
 * 1. Fetching reconciled bank transactions from accounting tool APIs (Xero, QBO)
 *    for the accounts tracked for cash in KeyInfo!H12:H21 and non-cash in KeyInfo!H23:I28.
 * 2. Parsing and month-boundary validation of user-pasted / uploaded unreconciled
 *    statement lines.
 * 3. Intelligent auto-categorization model (TF-IDF word probabilities + rule fallbacks).
 * 4. Merging and writing the complete monthly transaction register back to the
 *    client's Google Recon Sheet (columns A:J, Q, CD:CI, CM:CN).
 */

import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { getIntegrationTokens, updateRefreshedTokens, getSharedXeroGrant, updateSharedXeroGrantTokens } from "./vaultService.js";
import { fetchXeroBankAccounts, fetchXeroAccountTransactions, refreshXeroTokens } from "./xeroService.js";
import { fetchQuickBooksBankAccounts, fetchQuickBooksAccountTransactions, refreshQBTokens } from "./quickbooksService.js";
import { syncReconBankTransactions, syncReconUnreconciledItems } from "./cashflowReconService.js";
import { logPmaActivity } from "./pmaLogger.js";

/**
 * Standard category set matching the Recon Sheet U3:U16 range
 */
export const VALID_RECON_CATEGORIES = [
  "Revenue",
  "Outgoings",
  "Contractors",
  "Direct costs",
  "Dividends",
  "Salaries",
  "PAYE",
  "Pension",
  "Transfer",
  "Corp tax",
  "VAT",
  "Other"
];

const STOP_WORDS = new Set([
  "debit", "credit", "ref", "inv", "payment", "expense", "fee", "fees",
  "bank", "transfer", "ltd", "limited", "inc", "the", "and", "to", "for", "from"
]);

/**
 * Helper to compute first and last day of a month string (e.g. "2026-10")
 */
export function getMonthDateRange(monthKey) {
  let year, month; // 1-indexed
  if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) {
    const parts = monthKey.split("-").map(Number);
    year = parts[0];
    month = parts[1];
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  }

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDayNum = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;

  return { year, month, startDate, endDate, lastDayNum };
}

/**
 * Normalizes text for keyword tokenization
 */
export function tokenizeText(text = "") {
  const clean = String(text || "")
    .toLowerCase()
    .replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\b\d+\b/g, " ");

  return clean.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Fetches reconciled bank transactions from connected accounting tool (Xero or QuickBooks)
 * for the tracked bank accounts configured in Master Sheet KeyInfo!H12:H21 (Cash) and KeyInfo!H23:I28 (Non-Cash).
 */
export async function fetchClientReconciledBankTransactions({
  clientName,
  masterSheetId,
  reconSheetId,
  monthKey // "YYYY-MM"
}) {
  if (!clientName || !masterSheetId) {
    throw new Error("Missing clientName or masterSheetId");
  }

  const sheets = await getSheetsClient();
  const cleanMasterId = extractSheetIdFromUrl(masterSheetId) || masterSheetId;
  const { startDate, endDate } = getMonthDateRange(monthKey);

  // 1. Read tracked bank accounts from KeyInfo!H12:H21 (Cash) and KeyInfo!H23:I28 (Non-Cash)
  const [cashKeyResp, nonCashKeyResp] = await Promise.all([
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "KeyInfo!H12:H21"
    })),
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "KeyInfo!H23:I28"
    })).catch(() => ({ data: { values: [] } }))
  ]);

  const trackedAccountNames = (cashKeyResp.data.values || [])
    .map(r => String(r[0] || "").trim())
    .filter(name => name && !name.toLowerCase().includes("non-cash") && !name.endsWith(":"));

  const trackedNonCashAccountNames = (nonCashKeyResp.data.values || [])
    .map(r => String(r[0] || "").trim())
    .filter(name => name && !name.toLowerCase().includes("non-cash bank accounts") && !name.endsWith(":"));

  if (trackedAccountNames.length === 0 && trackedNonCashAccountNames.length === 0) {
    return {
      success: true,
      hasTrackedAccounts: false,
      message: "No bank accounts currently configured in Client Settings > Bank Accounts (KeyInfo!H12:H28).",
      trackedAccountNames: [],
      trackedNonCashAccountNames: [],
      transactions: [],
      nonCashTransactions: []
    };
  }

  // 2. Resolve Accounting Tool Tokens (Xero priority, then QuickBooks)
  let activeTool = null;
  let activeTokens = null;

  for (const candidateTool of ["xero", "quickbooks"]) {
    const record = await getIntegrationTokens({ clientKey: clientName, masterSheetId: cleanMasterId, tool: candidateTool });
    if (record && record.tokens?.accessToken) {
      activeTool = candidateTool;
      activeTokens = record;
      break;
    }
  }

  if (!activeTool) {
    return {
      success: true,
      hasTrackedAccounts: true,
      hasIntegration: false,
      message: `No connected accounting tool found for ${clientName}. Please connect Xero or QuickBooks in PMA > Integrations.`,
      trackedAccountNames,
      transactions: []
    };
  }

  let transactions = [];
  let nonCashTransactions = [];

  // 3. Ingestion: Xero
  if (activeTool === "xero") {
    let accessToken = activeTokens.tokens?.accessToken;
    let tenantId = activeTokens.tenantId;
    const isShared = Boolean(activeTokens.isSharedGrant);

    const doRefreshXero = async () => {
      const refreshToken = activeTokens.tokens?.refreshToken;
      if (!refreshToken) throw new Error("No refresh token available to refresh Xero connection.");
      console.log(`🔄 Bank Recon: Refreshing Xero access token for ${clientName}...`);
      const refreshed = await refreshXeroTokens(refreshToken);
      accessToken = refreshed.accessToken;
      activeTokens.tokens = refreshed;
      if (isShared) {
        await updateSharedXeroGrantTokens(refreshed);
      } else {
        await updateRefreshedTokens({ clientKey: clientName, masterSheetId: cleanMasterId, tool: "xero", tokens: refreshed });
      }
      return refreshed.accessToken;
    };

    // Check expiration timestamp
    const nowMs = Date.now();
    let expiresAtMs = activeTokens.expiresAt || 0;
    if (!expiresAtMs && activeTokens.tokens?.expiresAt) {
      expiresAtMs = activeTokens.tokens.expiresAt < 10000000000 ? activeTokens.tokens.expiresAt * 1000 : activeTokens.tokens.expiresAt;
    }
    const isExpiringSoon = !expiresAtMs || (expiresAtMs - nowMs) < 300000;

    if (isExpiringSoon && activeTokens.tokens?.refreshToken) {
      try {
        await doRefreshXero();
      } catch (refErr) {
        console.warn("⚠️ Xero proactive refresh warning:", refErr.message);
      }
    }

    // Wrap API calls with auto-refresh retry if 401 / TokenExpired is returned
    const withXeroRetry = async (fn) => {
      try {
        return await fn(accessToken);
      } catch (err) {
        const msg = String(err.message || "");
        if ((msg.includes("401") || msg.includes("TokenExpired") || msg.includes("Unauthorized")) && activeTokens.tokens?.refreshToken) {
          console.log(`🔄 Xero 401 TokenExpired caught. Refreshing token and retrying request...`);
          const newTok = await doRefreshXero();
          return await fn(newTok);
        }
        throw err;
      }
    };

    // Fetch tenant accounts
    const allXeroAccounts = await withXeroRetry((tok) => fetchXeroBankAccounts(tok, tenantId));

    // Match tracked cash account names
    const matchedAccounts = allXeroAccounts.filter(acc => {
      return trackedAccountNames.some(tracked => {
        const tLower = tracked.toLowerCase();
        const aLower = (acc.name || "").toLowerCase();
        return aLower.includes(tLower) || tLower.includes(aLower);
      });
    });

    // Match tracked non-cash account names
    const matchedNonCashAccounts = allXeroAccounts.filter(acc => {
      return trackedNonCashAccountNames.some(tracked => {
        const tLower = tracked.toLowerCase();
        const aLower = (acc.name || "").toLowerCase();
        return aLower.includes(tLower) || tLower.includes(aLower);
      });
    });

    // Query transactions for each matched cash account
    for (const acc of matchedAccounts) {
      const accTxns = await withXeroRetry((tok) => fetchXeroAccountTransactions({
        accessToken: tok,
        tenantId,
        accountId: acc.id,
        startDate,
        endDate
      }));

      accTxns.forEach(tx => {
        transactions.push({
          ...tx,
          accountName: acc.name,
          accountCode: acc.code,
          isReconciled: true,
          isNonCash: false,
          source: "xero"
        });
      });
    }

    // Query transactions for each matched non-cash account
    for (const acc of matchedNonCashAccounts) {
      const accTxns = await withXeroRetry((tok) => fetchXeroAccountTransactions({
        accessToken: tok,
        tenantId,
        accountId: acc.id,
        startDate,
        endDate
      }));

      accTxns.forEach(tx => {
        nonCashTransactions.push({
          ...tx,
          accountName: acc.name,
          accountCode: acc.code,
          isReconciled: true,
          isNonCash: true,
          source: "xero"
        });
      });
    }
  }

  // 4. Ingestion: QuickBooks Online
  if (activeTool === "quickbooks") {
    let accessToken = activeTokens.tokens?.accessToken;
    const realmId = activeTokens.realmId;

    const doRefreshQB = async () => {
      const refreshToken = activeTokens.tokens?.refreshToken;
      if (!refreshToken) throw new Error("No refresh token available to refresh QuickBooks connection.");
      console.log(`🔄 Bank Recon: Refreshing QuickBooks access token for ${clientName}...`);
      const refreshed = await refreshQBTokens(refreshToken);
      accessToken = refreshed.accessToken;
      activeTokens.tokens = refreshed;
      await updateRefreshedTokens({ clientKey: clientName, masterSheetId: cleanMasterId, tool: "quickbooks", tokens: refreshed });
      return refreshed.accessToken;
    };

    const nowMs = Date.now();
    let expiresAtMs = activeTokens.expiresAt || 0;
    if (!expiresAtMs && activeTokens.tokens?.expiresAt) {
      expiresAtMs = activeTokens.tokens.expiresAt < 10000000000 ? activeTokens.tokens.expiresAt * 1000 : activeTokens.tokens.expiresAt;
    }
    const isExpiringSoon = !expiresAtMs || (expiresAtMs - nowMs) < 300000;

    if (isExpiringSoon && activeTokens.tokens?.refreshToken) {
      try {
        await doRefreshQB();
      } catch (refErr) {
        console.warn("⚠️ QuickBooks proactive refresh warning:", refErr.message);
      }
    }

    const withQBRetry = async (fn) => {
      try {
        return await fn(accessToken);
      } catch (err) {
        const msg = String(err.message || "");
        if ((msg.includes("401") || msg.includes("TokenExpired") || msg.includes("Unauthorized")) && activeTokens.tokens?.refreshToken) {
          console.log(`🔄 QuickBooks 401 caught. Refreshing token and retrying request...`);
          const newTok = await doRefreshQB();
          return await fn(newTok);
        }
        throw err;
      }
    };

    const allQBAccounts = await withQBRetry((tok) => fetchQuickBooksBankAccounts(tok, realmId));
    const matchedAccounts = allQBAccounts.filter(acc => {
      return trackedAccountNames.some(tracked => {
        const tLower = tracked.toLowerCase();
        const aLower = (acc.name || "").toLowerCase();
        return aLower.includes(tLower) || tLower.includes(aLower);
      });
    });

    const matchedNonCashAccounts = allQBAccounts.filter(acc => {
      return trackedNonCashAccountNames.some(tracked => {
        const tLower = tracked.toLowerCase();
        const aLower = (acc.name || "").toLowerCase();
        return aLower.includes(tLower) || tLower.includes(aLower);
      });
    });

    for (const acc of matchedAccounts) {
      const accTxns = await withQBRetry((tok) => fetchQuickBooksAccountTransactions({
        accessToken: tok,
        realmId,
        accountId: acc.id,
        startDate,
        endDate
      }));

      accTxns.forEach(tx => {
        transactions.push({
          ...tx,
          accountName: acc.name,
          accountCode: acc.code,
          isReconciled: true,
          isNonCash: false,
          source: "quickbooks"
        });
      });
    }

    for (const acc of matchedNonCashAccounts) {
      const accTxns = await withQBRetry((tok) => fetchQuickBooksAccountTransactions({
        accessToken: tok,
        realmId,
        accountId: acc.id,
        startDate,
        endDate
      }));

      accTxns.forEach(tx => {
        nonCashTransactions.push({
          ...tx,
          accountName: acc.name,
          accountCode: acc.code,
          isReconciled: true,
          isNonCash: true,
          source: "quickbooks"
        });
      });
    }
  }

  // Sort by date ascending
  transactions.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  nonCashTransactions.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  // Strictly filter transactions to target month date range
  const filteredTxns = transactions.filter(tx => {
    if (!tx.date) return false;
    return tx.date >= startDate && tx.date <= endDate;
  });

  const filteredNonCashTxns = nonCashTransactions.filter(tx => {
    if (!tx.date) return false;
    return tx.date >= startDate && tx.date <= endDate;
  });

  // Train learning map from historical recon tabs if reconSheetId provided
  let learningMap = new Map();
  if (reconSheetId) {
    try {
      const cleanReconId = extractSheetIdFromUrl(reconSheetId) || reconSheetId;
      learningMap = await buildLearningMapFromReconSheet(cleanReconId, sheets);
    } catch (learnErr) {
      console.warn("⚠️ Could not build historical learning map:", learnErr.message);
    }
  }

  // Assign unique IDs and predict categories for every transaction
  const categorizedTxns = filteredTxns.map((tx, idx) => {
    const prediction = autoCategorizeTransaction(tx, learningMap);
    return {
      ...tx,
      id: tx.id || `api_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
      category: prediction.category,
      suggestedCategory: prediction.category,
      confidence: prediction.confidence,
      reason: prediction.reason
    };
  });

  const categorizedNonCashTxns = filteredNonCashTxns.map((tx, idx) => {
    const prediction = autoCategorizeTransaction(tx, learningMap);
    return {
      ...tx,
      id: tx.id || `api_nc_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
      category: prediction.category,
      suggestedCategory: prediction.category,
      confidence: prediction.confidence,
      reason: prediction.reason
    };
  });

  return {
    success: true,
    hasTrackedAccounts: true,
    hasIntegration: true,
    tool: activeTool,
    trackedAccountNames,
    trackedNonCashAccountNames,
    totalTransactions: categorizedTxns.length,
    totalNonCashTransactions: categorizedNonCashTxns.length,
    startDate,
    endDate,
    transactions: categorizedTxns,
    nonCashTransactions: categorizedNonCashTxns
  };
}

/**
 * Robust date parser supporting Excel serial numbers, UK formats (DD/MM/YYYY, DD-MM-YYYY),
 * ISO (YYYY-MM-DD), and textual dates ("14 Oct 2026", "Oct 14, 2026").
 * Stricter parser: never evaluates unstructured arbitrary sentences with native Date().
 */
export function parseBankDate(dateStr) {
  if (dateStr == null || dateStr === "") return null;

  // 1. Excel serial number: e.g. 46308, 45280
  if (typeof dateStr === "number" || (/^\d{5}$/.test(String(dateStr).trim()))) {
    const num = Number(dateStr);
    if (num >= 35000 && num <= 60000) {
      const utcDays = num - 25569;
      const date = new Date(utcDays * 86400 * 1000);
      const y = date.getUTCFullYear();
      const m = date.getUTCMonth() + 1;
      const d = date.getUTCDate();
      return {
        year: y,
        month: m,
        day: d,
        iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      };
    }
  }

  const s = String(dateStr).trim();

  // 2. UK format: DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const ukMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (ukMatch) {
    const d = parseInt(ukMatch[1], 10);
    const m = parseInt(ukMatch[2], 10);
    let y = parseInt(ukMatch[3], 10);
    if (y < 100) y += 2000;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return {
        year: y,
        month: m,
        day: d,
        iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      };
    }
  }

  // 3. ISO format: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return {
        year: y,
        month: m,
        day: d,
        iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      };
    }
  }

  // 4. Textual month format: "15 Oct 2026", "5 October 2026", "15-Oct-26", "Oct 15, 2026"
  const textMonthMatch = s.match(/^(\d{1,2})[\s\-/.]([a-zA-Z]{3,})[\s\-/.](?:'?)(\d{2,4})$/);
  if (textMonthMatch) {
    const d = parseInt(textMonthMatch[1], 10);
    const monthStr = textMonthMatch[2].toLowerCase();
    let y = parseInt(textMonthMatch[3], 10);
    if (y < 100) y += 2000;
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mIdx = monthNames.findIndex(mn => monthStr.startsWith(mn));
    if (mIdx !== -1 && d >= 1 && d <= 31) {
      const m = mIdx + 1;
      return {
        year: y,
        month: m,
        day: d,
        iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      };
    }
  }

  return null;
}

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Formats a parsed bank date object into strict d-Mmm-yy format (e.g. "24-Oct-26", "4-Nov-26").
 */
export function formatBankDateDMmmYy(dateObj) {
  if (!dateObj || !dateObj.year || !dateObj.month || !dateObj.day) return "";
  const d = dateObj.day;
  const m = MONTH_NAMES_SHORT[dateObj.month - 1] || "";
  const yy = String(dateObj.year).slice(-2);
  return `${d}-${m}-${yy}`;
}

/**
 * Splits a CSV line while respecting double-quoted fields (e.g. "£2,000.00")
 */
function splitCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result.map(c => c.replace(/^["']|["']$/g, "").trim());
}

/**
 * Parses a numeric currency cell string (returns null if empty or non-numeric)
 */
function parseCellNumber(rawCell) {
  if (rawCell == null) return null;
  const str = String(rawCell).trim();
  if (!str) return null;
  const withoutCurr = str.replace(/^[£$€\s]+|[£$€\s]+$/g, "");
  const isParenNeg = /^\(.*\)$/.test(withoutCurr);
  const numStr = withoutCurr.replace(/[()£$€,\s]/g, "");
  if (numStr === "" || isNaN(Number(numStr))) return null;
  const val = parseFloat(numStr);
  return isParenNeg ? -Math.abs(val) : val;
}

/**
 * Determines whether a VAT column cell indicates VAT applies ("Yes" vs "No")
 */
function parseVatAppliesCell(rawVat) {
  if (!rawVat) return "No";
  const v = String(rawVat).trim().toLowerCase();
  if (!v || v.includes("no vat") || v.includes("exempt") || v.includes("zero") || /^0(?:\.0+)?%/.test(v) || v === "no" || v === "none") {
    return "No";
  }
  if (v === "yes" || v.includes("20%") || v.includes("20.0%") || v.includes("standard") || /[1-9]\d*(?:\.\d+)?%/.test(v)) {
    return "Yes";
  }
  return "No";
}

/**
 * Parses user-pasted text (tab-separated from Xero/QB reports) or CSV/Excel rows
 * and applies strict month-boundary filtering.
 */
export function parseUnreconciledItems({
  rawText = "",
  rows = null, // Optional 2D array of strings from Excel
  monthKey = "" // "YYYY-MM", "YYMM", etc.
}) {
  let targetYear = null;
  let targetMonth = null;
  if (monthKey) {
    const mk = String(monthKey).trim();
    if (/^\d{4}-\d{2}$/.test(mk)) {
      const [y, m] = mk.split("-").map(Number);
      targetYear = y; targetMonth = m;
    } else if (/^\d{2}\d{2}$/.test(mk)) {
      targetYear = 2000 + parseInt(mk.slice(0, 2), 10);
      targetMonth = parseInt(mk.slice(2, 4), 10);
    } else if (/^\d{4}\/\d{2}$/.test(mk)) {
      const [y, m] = mk.split("/").map(Number);
      targetYear = y; targetMonth = m;
    } else if (/^\d{6}$/.test(mk)) {
      targetYear = parseInt(mk.slice(0, 4), 10);
      targetMonth = parseInt(mk.slice(4, 6), 10);
    }
  }

  const targetMonthLabel = targetYear && targetMonth
    ? new Date(targetYear, targetMonth - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
    : (monthKey || "Target Month");

  let inputRows = [];
  if (Array.isArray(rows) && rows.length > 0) {
    inputRows = rows.map(r => Array.isArray(r) ? r.map(c => String(c ?? "").trim()) : [String(r)]);
  } else if (rawText && typeof rawText === "string") {
    const rawLines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    inputRows = rawLines.map(line => {
      if (line.includes("\t")) {
        return line.split(/\t/).map(c => c.trim());
      } else if (line.includes(",")) {
        return splitCsvLine(line);
      } else if (/\s{2,}/.test(line)) {
        return line.split(/\s{2,}/).map(c => c.trim());
      } else {
        const m = line.match(/^(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})\s+(.+?)\s+([£$€]?\(?-?\d[\d,.]*\)?)$/);
        if (m) {
          return [m[1], m[2], m[3]];
        }
        return [line];
      }
    });
  }

  if (inputRows.length === 0) {
    return {
      success: true,
      items: [],
      validItems: [],
      hasUnreconSection: false,
      unreconSectionCount: 0,
      otherSectionCount: 0,
      totalLinesProcessed: 0,
      inMonthCount: 0,
      otherMonthCount: 0,
      skippedSummaryCount: 0,
      skippedLines: [],
      targetMonth: { year: targetYear, month: targetMonth, label: targetMonthLabel }
    };
  }

  const hasUnreconSection = inputRows.some(r => {
    const txt = (Array.isArray(r) ? r.join(" ") : String(r)).toLowerCase();
    return (txt.includes("unreconciled statement lines") || txt.includes("unreconciled bank statement lines")) && !txt.includes("total");
  });

  const isStructuredReport = inputRows.some(r => {
    const txt = (Array.isArray(r) ? r.join(" ") : String(r)).toLowerCase();
    return txt.includes("reconciliation summary") ||
      txt.includes("totals summary") ||
      txt.includes("statement balances") ||
      txt.includes("plus outstanding") ||
      txt.includes("plus unreconciled") ||
      txt.includes("balance in xero");
  });

  const SUMMARY_REGEX = /\b(statement balance|balance in xero|balance as per|calculated balance out by|imported statement balance|total outstanding|total payments|total receipts|total unreconciled|closing balance|opening balance|bank account:|account number:|page \d+ of \d+|reconciliation summary|reconciliation report|bank reconciliation|totals summary)\b/i;

  let currentSection = null;
  let activeColumnMap = null;
  const items = [];
  const skippedLines = [];

  // Detect if headerless 7-column QuickBooks format (Date, DESCRIPTION, Payee, Categorise, VAT, SPENT, RECEIVED)
  const firstRowLower = (inputRows[0] || []).join(" ").toLowerCase();
  if (!firstRowLower.startsWith("date") && inputRows.some(r => r.length === 7 && parseBankDate(r[0]))) {
    const looksLikeQb7Col = inputRows.every(r => {
      if (!r.join("").trim()) return true;
      if (r.length !== 7 || !parseBankDate(r[0])) return false;
      const col5Num = parseCellNumber(r[5]);
      const col6Num = parseCellNumber(r[6]);
      return (col5Num !== null && col6Num === null) || (col5Num === null && col6Num !== null);
    });
    if (looksLikeQb7Col) {
      activeColumnMap = {
        dateCol: 0,
        descCol: 1,
        payeeCol: 2,
        refCol: -1,
        vatCol: 4,
        spentCol: 5,
        receivedCol: 6,
        amountCol: -1
      };
    }
  }

  inputRows.forEach((cols, idx) => {
    const joinedLine = cols.join(" ").trim();
    if (!joinedLine) return;

    const lower = joinedLine.toLowerCase();

    // Section headings in Xero statement
    if (lower.includes("outstanding payments") && !lower.includes("total")) {
      currentSection = "payments";
      skippedLines.push({ line: joinedLine, reason: "Section heading (Payments)" });
      return;
    }
    if ((lower.includes("outstanding receipts") || lower.includes("outstanding deposits")) && !lower.includes("total")) {
      currentSection = "receipts";
      skippedLines.push({ line: joinedLine, reason: "Section heading (Receipts)" });
      return;
    }
    if (lower.includes("unreconciled statement lines") && !lower.includes("total")) {
      currentSection = "unreconciled";
      skippedLines.push({ line: joinedLine, reason: "Section heading (Unreconciled statement lines)" });
      return;
    }
    if (lower.includes("statement lines") && !lower.includes("total") && !lower.includes("unreconciled")) {
      currentSection = "statement_lines";
      skippedLines.push({ line: joinedLine, reason: "Section heading (Statement lines)" });
      return;
    }

    // Section end boundaries / summary footers
    if (lower.includes("total outstanding") ||
      lower.includes("total unreconciled") ||
      lower.includes("statement balance") ||
      lower.includes("totals summary") ||
      lower.includes("balance in xero") ||
      lower.includes("statement balances") ||
      lower.includes("calculated balance out by") ||
      lower.includes("imported statement balance") ||
      lower.includes("closing balance") ||
      lower.includes("opening balance")) {
      currentSection = null;
      skippedLines.push({ line: joinedLine, reason: "Summary/Balance boundary row" });
      return;
    }

    // In a structured report, ignore any lines outside active transaction sections
    if (isStructuredReport && !currentSection) {
      skippedLines.push({ line: joinedLine, reason: "Outside transaction sections" });
      return;
    }

    // Skip summary, totals, and report metadata lines
    if (SUMMARY_REGEX.test(lower)) {
      skippedLines.push({ line: joinedLine, reason: "Summary/Balance row" });
      return;
    }

    // Detect and record table column headers before skipping header row
    if (lower.startsWith("date") || lower.startsWith("cheque no") || lower.startsWith("description") || lower.startsWith("reference") || lower.startsWith("status")) {
      const colMap = {
        dateCol: -1,
        descCol: -1,
        payeeCol: -1,
        refCol: -1,
        vatCol: -1,
        spentCol: -1,
        receivedCol: -1,
        amountCol: -1
      };
      cols.forEach((h, cIdx) => {
        const hl = String(h || "").trim().toLowerCase();
        if (!hl) return;
        if (colMap.dateCol === -1 && (hl === "date" || hl.includes("transaction date") || hl.includes("statement date"))) colMap.dateCol = cIdx;
        else if (colMap.descCol === -1 && (hl === "description" || hl === "particulars" || hl === "details" || hl === "memo")) colMap.descCol = cIdx;
        else if (colMap.payeeCol === -1 && (hl === "payee" || hl === "contact" || hl === "name")) colMap.payeeCol = cIdx;
        else if (colMap.refCol === -1 && (hl === "reference" || hl === "ref" || hl.includes("cheque") || hl.includes("check no"))) colMap.refCol = cIdx;
        else if (colMap.vatCol === -1 && (hl === "vat" || hl === "tax" || hl === "tax rate")) colMap.vatCol = cIdx;
        else if (colMap.spentCol === -1 && (hl === "spent" || hl === "out" || hl === "money out" || hl === "debit" || hl === "payment" || hl === "payments" || hl.startsWith("spent "))) colMap.spentCol = cIdx;
        else if (colMap.receivedCol === -1 && (hl === "received" || hl === "in" || hl === "money in" || hl === "credit" || hl === "deposit" || hl === "deposits" || hl === "receipt" || hl === "receipts" || hl.startsWith("received "))) colMap.receivedCol = cIdx;
        else if (colMap.amountCol === -1 && (hl === "amount" || hl === "total" || hl === "value")) colMap.amountCol = cIdx;
      });
      if (colMap.spentCol !== -1 || colMap.receivedCol !== -1) {
        activeColumnMap = colMap;
      }
      skippedLines.push({ line: joinedLine, reason: "Column headers" });
      return;
    }

    let dateObj = null;
    let displayDateFallback = "";
    let amount = 0;
    let isNegative = false;
    let payee = "Unreconciled item";
    let particulars = "";
    let reference = "";
    let vatApplies = "No";
    let hasExplicitVat = false;

    // Path A: Header-mapped dual-column format (e.g. QuickBooks CSV with SPENT and RECEIVED columns)
    if (activeColumnMap && (activeColumnMap.spentCol !== -1 || activeColumnMap.receivedCol !== -1)) {
      if (activeColumnMap.dateCol !== -1 && cols[activeColumnMap.dateCol]) {
        dateObj = parseBankDate(cols[activeColumnMap.dateCol]);
        displayDateFallback = cols[activeColumnMap.dateCol];
      }
      if (!dateObj) {
        for (let c = 0; c < Math.min(cols.length, 5); c++) {
          const d = parseBankDate(cols[c]);
          if (d) {
            dateObj = d;
            displayDateFallback = cols[c];
            break;
          }
        }
      }
      if (!dateObj) {
        skippedLines.push({ line: joinedLine, reason: "No date found" });
        return;
      }

      const spentVal = activeColumnMap.spentCol !== -1 ? parseCellNumber(cols[activeColumnMap.spentCol]) : null;
      const receivedVal = activeColumnMap.receivedCol !== -1 ? parseCellNumber(cols[activeColumnMap.receivedCol]) : null;
      const singleAmtVal = activeColumnMap.amountCol !== -1 ? parseCellNumber(cols[activeColumnMap.amountCol]) : null;

      if (spentVal !== null && Math.abs(spentVal) > 0) {
        amount = Math.abs(spentVal);
        isNegative = true;
      } else if (receivedVal !== null && Math.abs(receivedVal) > 0) {
        amount = Math.abs(receivedVal);
        isNegative = false;
      } else if (singleAmtVal !== null && Math.abs(singleAmtVal) > 0) {
        amount = Math.abs(singleAmtVal);
        isNegative = singleAmtVal < 0;
      } else {
        skippedLines.push({ line: joinedLine, reason: "No amount found" });
        return;
      }

      const rawDesc = activeColumnMap.descCol !== -1 ? String(cols[activeColumnMap.descCol] || "").trim() : "";
      const rawPayee = activeColumnMap.payeeCol !== -1 ? String(cols[activeColumnMap.payeeCol] || "").trim() : "";
      payee = rawPayee || rawDesc || "Unreconciled item";
      particulars = rawDesc || rawPayee || payee;
      reference = activeColumnMap.refCol !== -1 ? String(cols[activeColumnMap.refCol] || "").trim() : "";

      if (activeColumnMap.vatCol !== -1 && String(cols[activeColumnMap.vatCol] || "").trim() !== "") {
        vatApplies = parseVatAppliesCell(cols[activeColumnMap.vatCol]);
        hasExplicitVat = true;
      }
    } else {
      // Path B: Standard single-amount format (e.g. Xero Reconciliation Summary or generic CSV/paste)
      const cleanCols = cols.filter(c => c !== "");
      if (cleanCols.length < 2) {
        skippedLines.push({ line: joinedLine, reason: "Not enough columns" });
        return;
      }

      let dateColIdx = -1;
      for (let c = 0; c < Math.min(cleanCols.length, 5); c++) {
        const d = parseBankDate(cleanCols[c]);
        if (d) {
          dateObj = d;
          dateColIdx = c;
          displayDateFallback = cleanCols[c];
          break;
        }
      }

      if (!dateObj) {
        skippedLines.push({ line: joinedLine, reason: "No date found" });
        return;
      }

      let amountColIdx = -1;
      let isParenNeg = false;
      for (let c = cleanCols.length - 1; c > dateColIdx; c--) {
        const raw = cleanCols[c].replace(/^[£$€]/, "").trim();
        isParenNeg = /^\(.*\)$/.test(raw);
        const numStr = raw.replace(/[()£$€,\s]/g, "");
        if (numStr !== "" && !isNaN(Number(numStr))) {
          amount = parseFloat(numStr);
          if (isParenNeg) amount = -Math.abs(amount);
          amountColIdx = c;
          break;
        }
      }

      if (amountColIdx === -1) {
        skippedLines.push({ line: joinedLine, reason: "No amount found" });
        return;
      }

      const rawTextCols = cleanCols.filter((_, cIdx) => cIdx !== dateColIdx && cIdx !== amountColIdx);
      const textCols = [];
      rawTextCols.forEach(tc => {
        if (/^(20(?:\.0)?%\s*[a-z]*|no\s*vat|0(?:\.0)?%\s*[a-z]*|exempt)$/i.test(tc.trim())) {
          vatApplies = parseVatAppliesCell(tc);
          hasExplicitVat = true;
        } else {
          textCols.push(tc);
        }
      });

      payee = textCols[0] || "Unreconciled item";
      particulars = textCols.length >= 2 ? textCols[1] : payee;
      reference = textCols.length >= 3 ? textCols[2] : "";

      isNegative = amount < 0 || isParenNeg;
      if (currentSection === "payments") isNegative = true;
      else if (currentSection === "receipts") isNegative = false;
    }

    const absAmt = Math.abs(amount);

    // Month boundary check
    const isInTargetMonth = Boolean(targetYear && targetMonth && dateObj.year === targetYear && dateObj.month === targetMonth);
    const rowMonthLabel = new Date(dateObj.year, dateObj.month - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });

    const formattedDate = formatBankDateDMmmYy(dateObj);
    const isUnreconSection = hasUnreconSection ? currentSection === "unreconciled" : true;

    items.push({
      id: `unrecon_${Date.now()}_${idx}`,
      date: formattedDate || dateObj.iso,
      displayDate: formattedDate || displayDateFallback,
      isoDate: dateObj.iso,
      payee,
      particulars: particulars || payee,
      reference,
      outAmount: isNegative ? absAmt : 0,
      inAmount: !isNegative ? absAmt : 0,
      amount: absAmt,
      isNegative,
      isInTargetMonth,
      rowMonthLabel,
      targetMonthLabel,
      section: currentSection || "unreconciled",
      sectionLabel: currentSection === "payments" ? "Outstanding Payments" : (currentSection === "receipts" ? "Outstanding Receipts" : "Plus Unreconciled Statement Lines"),
      isUnreconSection,
      selected: isInTargetMonth && isUnreconSection,
      isReconciled: false,
      source: "unreconciled_pasted",
      suggestedCategory: isNegative ? "Outgoings" : "Revenue",
      vatApplies,
      hasExplicitVat,
      plCategory: "",
      category: "",
      rawLine: joinedLine
    });
  });

  // Sort items: checked items for the month FIRST, then unchecked items, sorted by date within groups
  items.sort((a, b) => {
    if (a.selected !== b.selected) {
      return b.selected ? 1 : -1;
    }
    return (a.isoDate || a.date || "").localeCompare(b.isoDate || b.date || "");
  });

  return {
    success: true,
    items,
    validItems: items.filter(it => it.isInTargetMonth && it.isUnreconSection !== false),
    hasUnreconSection,
    unreconSectionCount: items.filter(i => i.isUnreconSection).length,
    otherSectionCount: items.filter(i => !i.isUnreconSection).length,
    totalLinesProcessed: inputRows.length,
    inMonthCount: items.filter(it => it.isInTargetMonth && (!hasUnreconSection || it.isUnreconSection)).length,
    otherMonthCount: items.filter(it => !it.isInTargetMonth && (!hasUnreconSection || it.isUnreconSection)).length,
    skippedSummaryCount: skippedLines.length,
    skippedLines,
    targetMonth: { year: targetYear, month: targetMonth, label: targetMonthLabel }
  };
}

/**
 * Intelligent categorization algorithm mirroring recon-script TF-IDF word frequency
 * and hardcoded rules.
 */
export function autoCategorizeTransaction(tx, learningMap = new Map()) {
  // If already tagged with high confidence (e.g. Sales invoice payment or Transfer)
  if (tx.suggestedCategory && (tx.suggestedCategory === "Revenue" || tx.suggestedCategory === "Transfer")) {
    return { category: tx.suggestedCategory, confidence: 1.0, reason: "GL Mapped" };
  }

  const combinedText = `${tx.payee || ""} ${tx.particulars || ""} ${tx.reference || ""}`.toLowerCase();
  const outAmount = parseFloat(tx.outAmount) || 0;
  const inAmount = parseFloat(tx.inAmount) || 0;

  // 1. Hardcoded high-confidence regex rules
  if (/\b(sdds|hmrc paye|paye|hmrc Cumbernauld)\b/i.test(combinedText)) {
    return { category: "PAYE", confidence: 0.99, reason: "Rule: PAYE/SDDS" };
  }
  if (/\b(dividend|dividends)\b/i.test(combinedText)) {
    return { category: "Dividends", confidence: 0.99, reason: "Rule: Dividend" };
  }
  if (/\b(salary|salaries|payroll|wage|wages)\b/i.test(combinedText)) {
    return { category: "Salaries", confidence: 0.98, reason: "Rule: Salary" };
  }
  if (/\b(nest|nest pension|pension|peoples pension)\b/i.test(combinedText)) {
    return { category: "Pension", confidence: 0.98, reason: "Rule: Pension" };
  }
  if (/\b(vat|hmrc vat)\b/i.test(combinedText)) {
    return { category: "VAT", confidence: 0.98, reason: "Rule: VAT" };
  }
  if (/\b(corp tax|corporation tax|hmrc ct)\b/i.test(combinedText)) {
    return { category: "Corp tax", confidence: 0.98, reason: "Rule: Corp Tax" };
  }

  // 2. Learned Word Probability Match
  const tokens = tokenizeText(combinedText);
  let bestLearnedCat = null;
  let highestProb = 0;

  tokens.forEach(word => {
    if (learningMap.has(word)) {
      const match = learningMap.get(word);
      if (match.probability > highestProb && match.probability >= 0.70) {
        highestProb = match.probability;
        bestLearnedCat = match.category;
      }
    }
  });

  if (bestLearnedCat && highestProb >= 0.70) {
    return { category: bestLearnedCat, confidence: highestProb, reason: `Learned (${Math.round(highestProb * 100)}%)` };
  }

  // 3. Fallback based on cash direction
  if (inAmount > 0) {
    return { category: "Revenue", confidence: 0.60, reason: "Direction: Inflow" };
  }
  if (outAmount > 0) {
    return { category: "Outgoings", confidence: 0.60, reason: "Direction: Outflow" };
  }

  return { category: "Outgoings", confidence: 0.50, reason: "Default" };
}

/**
 * Builds learning maps from historical monthly tabs in the Recon Sheet
 */
export async function buildLearningMapFromReconSheet(reconSheetId, sheetsClient) {
  const learningMap = new Map();
  if (!reconSheetId) return learningMap;

  try {
    const meta = await withRetry(() => sheetsClient.spreadsheets.get({
      spreadsheetId: reconSheetId,
      fields: "sheets.properties.title"
    }));

    const validTabs = (meta.data.sheets || [])
      .map(s => s.properties.title)
      .filter(t => /^\d{4}$/.test(t))
      .slice(0, 6); // Take the latest 6 historical tabs

    if (validTabs.length === 0) return learningMap;

    const ranges = validTabs.map(t => `'${t}'!A3:Q150`);
    const batchResp = await withRetry(() => sheetsClient.spreadsheets.values.batchGet({
      spreadsheetId: reconSheetId,
      ranges,
      valueRenderOption: "UNFORMATTED_VALUE"
    }));

    const wordCategoryCounts = new Map();
    const wordTotalCounts = new Map();

    (batchResp.data.valueRanges || []).forEach(vr => {
      const rows = vr.values || [];
      rows.forEach(r => {
        const cat = String(r[16] || "").trim(); // Col Q is index 16
        if (!cat || !VALID_RECON_CATEGORIES.includes(cat)) return;

        const text = `${r[1] || ""} ${r[3] || ""} ${r[4] || ""} ${r[6] || ""}`;
        const tokens = tokenizeText(text);

        tokens.forEach(word => {
          wordTotalCounts.set(word, (wordTotalCounts.get(word) || 0) + 1);
          if (!wordCategoryCounts.has(word)) wordCategoryCounts.set(word, new Map());
          const catMap = wordCategoryCounts.get(word);
          catMap.set(cat, (catMap.get(cat) || 0) + 1);
        });
      });
    });

    for (const [word, totalCount] of wordTotalCounts.entries()) {
      if (totalCount < 2) continue; // Minimum occurrence
      const catMap = wordCategoryCounts.get(word);
      let bestCat = null;
      let maxCatCount = 0;

      for (const [cat, count] of catMap.entries()) {
        if (count > maxCatCount) {
          maxCatCount = count;
          bestCat = cat;
        }
      }

      const probability = maxCatCount / totalCount;
      if (probability >= 0.70) {
        learningMap.set(word, { category: bestCat, probability });
      }
    }
  } catch (err) {
    console.warn("⚠️ Failed to build learning map from recon sheet:", err.message);
  }

  return learningMap;
}

/**
 * Re-categorizes a list of bank transactions using historical learning from past Recon Sheet tabs
 * and rule-based heuristics.
 */
export async function recategoriseTransactions({
  reconSheetId,
  transactions = []
}) {
  const sheets = await getSheetsClient();
  let learningMap = new Map();
  if (reconSheetId) {
    try {
      const cleanReconId = extractSheetIdFromUrl(reconSheetId) || reconSheetId;
      learningMap = await buildLearningMapFromReconSheet(cleanReconId, sheets);
    } catch (e) {
      console.warn("⚠️ Could not build learning map for recategorisation:", e.message);
    }
  }

  const updated = transactions.map((tx, idx) => {
    // Clear suggestedCategory so autoCategorizeTransaction doesn't skip re-evaluation
    const txForEval = { ...tx, suggestedCategory: "" };
    const prediction = autoCategorizeTransaction(txForEval, learningMap);
    return {
      ...tx,
      id: tx.id || `recat_${Date.now()}_${idx}`,
      category: prediction.category,
      suggestedCategory: prediction.category,
      confidence: prediction.confidence,
      reason: prediction.reason
    };
  });

  return {
    success: true,
    total: updated.length,
    transactions: updated
  };
}

/**
 * Enriches parsed unreconciled items with intelligent predictions for:
 * 1. Primary cashflow category (Outgoings, Salaries, PAYE, Pension, Contractors, Direct costs, VAT, Corp tax, Transfer, Revenue, Other)
 * 2. Secondary P&L category (when Primary is "Outgoings") & VAT status ("Yes" / "No"),
 *    learned from the last 6 months of Recon Sheet tabs (A3:Q150 & CD4:CN60),
 *    current month's reconciled transactions, and Client Sheet Outgoings Row 300 JSON breakdown.
 */
export async function enrichUnreconciledItemPredictions({
  items = [],
  reconSheetId = "",
  clientSheetId = "",
  plAccountOptions = [],
  existingTransactions = [],
  knownContractors = [],
  knownCustomers = []
}) {
  if (!Array.isArray(items) || items.length === 0) return items;

  const normalizeKey = (s) => String(s || "")
    .toLowerCase()
    .replace(/\b(ltd|limited|inc|plc|llp|uk|co|company|corp|corporation|the)\b/g, " ")
    .replace(/[^a-z0-9]/g, "")
    .trim();

  const normalizePlCat = (s) => String(s || "")
    .replace(/^\d+\s*[-–:]\s*/, "")
    .toLowerCase()
    .trim();

  // Build map of valid P&L options for canonical resolution
  const validPlMap = new Map();
  validPlMap.set("not an expense", "Not an expense");
  (plAccountOptions || []).forEach(opt => {
    const clean = String(opt || "").trim();
    if (!clean || clean.toLowerCase().includes("p&l account") || clean.toLowerCase() === "outgoings") return;
    validPlMap.set(clean.toLowerCase(), clean);
    validPlMap.set(normalizePlCat(clean), clean);
  });

  const resolveCanonicalPlCategory = (rawCat) => {
    if (!rawCat) return "";
    const trimmed = String(rawCat).trim();
    if (!trimmed || trimmed.toLowerCase() === "outgoings" || trimmed.toLowerCase().includes("p&l account")) return "";
    const lower = trimmed.toLowerCase();
    if (validPlMap.has(lower)) return validPlMap.get(lower);
    const norm = normalizePlCat(trimmed);
    if (validPlMap.has(norm)) return validPlMap.get(norm);
    // If plAccountOptions wasn't provided yet, still allow valid non-generic strings
    if (!plAccountOptions || plAccountOptions.length === 0) return trimmed;
    return "";
  };

  // Primary category maps: exact payee -> Map<cat, count>, word -> Map<cat, count>
  const payeePrimaryCounts = new Map();
  const wordPrimaryCounts = new Map();
  const wordPrimaryTotals = new Map();

  // Secondary P&L category maps: exact supplier -> Map<plCat, { count, vatYes, vatNo }>
  const supplierPlCounts = new Map();
  const wordPlCounts = new Map();
  const wordPlTotals = new Map();

  const recordPrimaryObservation = (payeeStr, descStr, refStr, cat, weight = 1) => {
    const cleanCat = String(cat || "").trim();
    if (!cleanCat || !VALID_RECON_CATEGORIES.includes(cleanCat)) return;
    const pKey = normalizeKey(payeeStr || descStr);
    if (pKey && pKey.length >= 3) {
      if (!payeePrimaryCounts.has(pKey)) payeePrimaryCounts.set(pKey, new Map());
      const m = payeePrimaryCounts.get(pKey);
      m.set(cleanCat, (m.get(cleanCat) || 0) + weight);
    }
    const tokens = tokenizeText(`${payeeStr || ""} ${descStr || ""} ${refStr || ""}`);
    tokens.forEach(w => {
      wordPrimaryTotals.set(w, (wordPrimaryTotals.get(w) || 0) + weight);
      if (!wordPrimaryCounts.has(w)) wordPrimaryCounts.set(w, new Map());
      const cm = wordPrimaryCounts.get(w);
      cm.set(cleanCat, (cm.get(cleanCat) || 0) + weight);
    });
  };

  const recordPlObservation = (supplierStr, descStr, rawPlCat, vatBool, weight = 1) => {
    const canonicalPl = resolveCanonicalPlCategory(rawPlCat);
    if (!canonicalPl) return;
    const sKey = normalizeKey(supplierStr || descStr);
    if (sKey && sKey.length >= 3) {
      if (!supplierPlCounts.has(sKey)) supplierPlCounts.set(sKey, new Map());
      const m = supplierPlCounts.get(sKey);
      const cur = m.get(canonicalPl) || { count: 0, vatYes: 0, vatNo: 0 };
      cur.count += weight;
      if (vatBool === true) cur.vatYes += weight;
      else if (vatBool === false) cur.vatNo += weight;
      m.set(canonicalPl, cur);
    }
    const tokens = tokenizeText(`${supplierStr || ""} ${descStr || ""}`);
    tokens.forEach(w => {
      wordPlTotals.set(w, (wordPlTotals.get(w) || 0) + weight);
      if (!wordPlCounts.has(w)) wordPlCounts.set(w, new Map());
      const cm = wordPlCounts.get(w);
      const cur = cm.get(canonicalPl) || { count: 0, vatYes: 0, vatNo: 0 };
      cur.count += weight;
      if (vatBool === true) cur.vatYes += weight;
      else if (vatBool === false) cur.vatNo += weight;
      cm.set(canonicalPl, cur);
    });
  };

  // 1. Seed from current month's existing reconciled transactions & known contractors/customers
  (existingTransactions || []).forEach(tx => {
    const cat = tx.category || tx.suggestedCategory;
    if (cat) {
      recordPrimaryObservation(tx.payee, tx.particulars, tx.reference, cat, 2);
    }
    if (tx.plCategory) {
      recordPlObservation(tx.payee, tx.particulars, tx.plCategory, tx.vatApplies === "Yes", 2);
    }
  });

  (knownContractors || []).forEach(c => {
    const name = typeof c === "string" ? c : (c?.client || c?.job || c?.description || "");
    if (name) recordPrimaryObservation(name, "", "", "Contractors", 3);
  });

  (knownCustomers || []).forEach(c => {
    const name = typeof c === "string" ? c : (c?.client || "");
    if (name) recordPrimaryObservation(name, "", "", "Revenue", 3);
  });

  let sheets = null;
  try {
    if (reconSheetId || clientSheetId) {
      sheets = await getSheetsClient();
    }
  } catch (e) {
    console.warn("⚠️ Could not init sheets client for unreconciled predictions:", e.message);
  }

  // 2. Fetch last 6 monthly tabs from Recon Sheet (A3:Q150 + CD4:CN60) and Client Sheet Outgoings Row 300 in parallel
  if (sheets) {
    const tasks = [];

    if (reconSheetId) {
      const cleanReconId = extractSheetIdFromUrl(reconSheetId) || reconSheetId;
      tasks.push((async () => {
        try {
          const meta = await withRetry(() => sheets.spreadsheets.get({
            spreadsheetId: cleanReconId,
            fields: "sheets.properties.title"
          }));
          const validTabs = (meta.data.sheets || [])
            .map(s => s.properties.title)
            .filter(t => /^\d{4}$/.test(t))
            .slice(0, 6);

          if (validTabs.length === 0) return;

          const ranges = [
            ...validTabs.map(t => `'${t}'!A3:Q150`),
            ...validTabs.map(t => `'${t}'!CD4:CN60`)
          ];
          const batchResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
            spreadsheetId: cleanReconId,
            ranges,
            valueRenderOption: "UNFORMATTED_VALUE"
          }));
          const vRanges = batchResp.data.valueRanges || [];
          const tabCount = validTabs.length;

          // Process A3:Q150
          for (let i = 0; i < tabCount; i++) {
            const rows = vRanges[i]?.values || [];
            rows.forEach(r => {
              const cat = String(r[16] || "").trim();
              if (!cat || !VALID_RECON_CATEGORIES.includes(cat)) return;
              recordPrimaryObservation(r[3], r[4], r[6], cat, 1);
            });
          }

          // Process CD4:CN60 (historical unreconciled items -> Col CM is r[9], Col CN is r[10])
          for (let i = 0; i < tabCount; i++) {
            const rows = vRanges[tabCount + i]?.values || [];
            rows.forEach(r => {
              const payee = String(r[3] || "").trim();
              const particulars = String(r[4] || "").trim();
              const plCat = String(r[9] || "").trim();
              const vatStr = String(r[10] || "").trim().toLowerCase();
              if (plCat) {
                const vatBool = vatStr === "yes" ? true : (vatStr === "no" ? false : null);
                recordPlObservation(payee, particulars, plCat, vatBool, 2);
              }
            });
          }
        } catch (err) {
          console.warn("⚠️ Recon sheet history lookup warning:", err.message);
        }
      })());
    }

    if (clientSheetId) {
      const cleanClientId = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
      tasks.push((async () => {
        try {
          const outResp = await withRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId: cleanClientSheetIdSafe(cleanClientId),
            range: "Outgoings!G300:AZ300",
            valueRenderOption: "UNFORMATTED_VALUE"
          }));
          const row300 = outResp.data.values?.[0] || [];
          // Parse the most recent 8 populated month columns
          const populatedCells = row300.filter(cell => typeof cell === "string" && cell.trim().startsWith("[")).slice(-8);
          populatedCells.forEach(cellStr => {
            try {
              const txList = JSON.parse(cellStr);
              if (!Array.isArray(txList)) return;
              txList.forEach(entry => {
                const supplier = String(entry?.s || "").trim();
                const catName = String(entry?.c || "").trim();
                if (!supplier || !catName || supplier.toLowerCase().includes("journal / adjustment")) return;
                const vatAmt = parseFloat(entry?.v) || 0;
                const hasVat = Math.abs(vatAmt) > 0.005;
                recordPlObservation(supplier, entry?.r || "", catName, hasVat, 1.5);
              });
            } catch (_) { }
          });
        } catch (err) {
          console.warn("⚠️ Outgoings Row 300 lookup warning:", err.message);
        }
      })());
    }

    await Promise.all(tasks);
  }

  function cleanClientSheetIdSafe(id) {
    return id;
  }

  // Build word learningMap compatible with autoCategorizeTransaction
  const learningMap = new Map();
  for (const [word, totalCount] of wordPrimaryTotals.entries()) {
    if (totalCount < 2) continue;
    const catMap = wordPrimaryCounts.get(word);
    let bestCat = null;
    let maxCatCount = 0;
    for (const [cat, count] of catMap.entries()) {
      if (count > maxCatCount) {
        maxCatCount = count;
        bestCat = cat;
      }
    }
    const probability = maxCatCount / totalCount;
    if (probability >= 0.65) {
      learningMap.set(word, { category: bestCat, probability });
    }
  }

  // Helper to predict Primary Category for an item
  const predictPrimary = (it) => {
    const isOutflow = (parseFloat(it.outAmount) || 0) > 0 || Boolean(it.isNegative);
    const isInflow = (parseFloat(it.inAmount) || 0) > 0 && !isOutflow;

    // 1. Check high-confidence regex rules & token learningMap via autoCategorizeTransaction
    const evalTx = {
      payee: it.payee,
      particulars: it.particulars,
      reference: it.reference,
      outAmount: it.outAmount,
      inAmount: it.inAmount,
      suggestedCategory: ""
    };
    const ruleOrWordPred = autoCategorizeTransaction(evalTx, learningMap);
    if (ruleOrWordPred.reason && ruleOrWordPred.reason.startsWith("Rule:")) {
      return { category: ruleOrWordPred.category, confidence: ruleOrWordPred.confidence, reason: ruleOrWordPred.reason, isSuggested: true };
    }

    // 2. Check exact or substring Payee match in payeePrimaryCounts
    const pKey = normalizeKey(it.payee || it.particulars);
    if (pKey && pKey.length >= 3) {
      let matchedMap = payeePrimaryCounts.get(pKey);
      if (!matchedMap) {
        for (const [knownKey, m] of payeePrimaryCounts.entries()) {
          if (knownKey.length >= 4 && (pKey.includes(knownKey) || knownKey.includes(pKey))) {
            matchedMap = m;
            break;
          }
        }
      }
      if (matchedMap) {
        let bestCat = null;
        let bestScore = 0;
        let totalScore = 0;
        for (const [cat, score] of matchedMap.entries()) {
          // Ensure direction compatibility (don't categorize an outflow as Revenue unless negative revenue refund, or inflow as Salaries)
          if (isInflow && !["Revenue", "Transfer", "Other"].includes(cat)) continue;
          totalScore += score;
          if (score > bestScore) {
            bestScore = score;
            bestCat = cat;
          }
        }
        if (bestCat && totalScore > 0 && (bestScore / totalScore) >= 0.60) {
          return {
            category: bestCat,
            confidence: Math.min(0.95, bestScore / totalScore),
            reason: "Payee history",
            isSuggested: true
          };
        }
      }
    }

    // 3. Token-level learned match
    if (ruleOrWordPred.confidence >= 0.70) {
      if (!isInflow || ["Revenue", "Transfer", "Other"].includes(ruleOrWordPred.category)) {
        return {
          category: ruleOrWordPred.category,
          confidence: ruleOrWordPred.confidence,
          reason: ruleOrWordPred.reason,
          isSuggested: true
        };
      }
    }

    // 4. Default direction fallback
    return {
      category: isOutflow ? "Outgoings" : "Revenue",
      confidence: 0.55,
      reason: isOutflow ? "Direction: Outflow" : "Direction: Inflow",
      isSuggested: false
    };
  };

  // Helper to predict Secondary P&L Category & VAT for "Outgoings" items
  const predictPlAndVat = (it) => {
    const sKey = normalizeKey(it.payee || it.particulars);
    let bestPl = "";
    let bestStats = null;
    let bestConfidence = 0;

    // 1. Exact or substring supplier match
    if (sKey && sKey.length >= 3) {
      let matchedMap = supplierPlCounts.get(sKey);
      if (!matchedMap) {
        for (const [knownKey, m] of supplierPlCounts.entries()) {
          if (knownKey.length >= 4 && (sKey.includes(knownKey) || knownKey.includes(sKey))) {
            matchedMap = m;
            break;
          }
        }
      }
      if (matchedMap) {
        let total = 0;
        let topCount = 0;
        for (const [plCat, stats] of matchedMap.entries()) {
          total += stats.count;
          if (stats.count > topCount) {
            topCount = stats.count;
            bestPl = plCat;
            bestStats = stats;
          }
        }
        if (bestPl && total > 0) {
          bestConfidence = topCount / total;
        }
      }
    }

    // 2. Fallback to token-level P&L category match
    if (!bestPl || bestConfidence < 0.60) {
      const tokens = tokenizeText(`${it.payee || ""} ${it.particulars || ""}`);
      let bestWordPl = "";
      let bestWordProb = 0;
      let bestWordStats = null;

      tokens.forEach(w => {
        const total = wordPlTotals.get(w) || 0;
        if (total < 1.5) return;
        const cm = wordPlCounts.get(w);
        if (!cm) return;
        for (const [plCat, stats] of cm.entries()) {
          const prob = stats.count / total;
          if (prob >= 0.70 && prob > bestWordProb) {
            bestWordProb = prob;
            bestWordPl = plCat;
            bestWordStats = stats;
          }
        }
      });

      if (bestWordPl && bestWordProb >= 0.70) {
        bestPl = bestWordPl;
        bestStats = bestWordStats;
        bestConfidence = bestWordProb;
      }
    }

    if (!bestPl || bestConfidence < 0.60) {
      return { plCategory: "", vatApplies: null, isPlSuggested: false };
    }

    let learnedVat = null;
    if (bestPl === "Not an expense") {
      learnedVat = "No";
    } else if (bestStats) {
      if (bestStats.vatYes > bestStats.vatNo) learnedVat = "Yes";
      else if (bestStats.vatNo > bestStats.vatYes) learnedVat = "No";
    }

    return {
      plCategory: bestPl,
      vatApplies: learnedVat,
      isPlSuggested: true,
      plConfidence: bestConfidence
    };
  };

  return items.map(it => {
    const primary = predictPrimary(it);
    const assignedCat = primary.category;
    let plCategory = it.plCategory || "";
    let vatApplies = it.vatApplies || "No";
    let isPlSuggested = false;

    if (assignedCat === "Outgoings") {
      const plPred = predictPlAndVat(it);
      if (plPred.plCategory) {
        plCategory = plPred.plCategory;
        isPlSuggested = true;
        if (!it.hasExplicitVat && plPred.vatApplies) {
          vatApplies = plPred.vatApplies;
        }
      }
    }

    return {
      ...it,
      category: assignedCat,
      suggestedCategory: assignedCat,
      isCategorySuggested: Boolean(primary.isSuggested),
      categoryReason: primary.reason || "",
      plCategory,
      suggestedPlCategory: plCategory,
      isPlSuggested,
      vatApplies
    };
  });
}

import {
  parseAmount,
  normalizeDateStr,
  matchAndRemoveFromUnreconPool,
  performTransactionsUpdate
} from "./reconTransactionsMerge.js";

export {
  parseAmount,
  normalizeDateStr,
  matchAndRemoveFromUnreconPool,
  performTransactionsUpdate
};


/**
 * Automatically reconciles client bank transactions against the Recon Sheet:
 * 1. Resolves Master Sheet and Recon Sheet IDs.
 * 2. Identifies target month tabs (e.g. "2609").
 * 3. Fetches reconciled bank transactions from QuickBooks or Xero.
 * 4. Reads existing transactions (A3:Q) and unreconciled items (CD4:CN) for each target month.
 * 5. Executes performTransactionsUpdate to gradually clear reconciled items from CD4:CN.
 * 6. Saves updated bank transactions and updated unreconciled items back to the Recon Sheet.
 */
export async function autoReconcileClientBankTransactions({
  clientName,
  masterSheetId,
  reconSheetId,
  monthKey, // optional: "YYYY-MM" or array of monthKeys
  automationCommanderSheetId
}) {
  if (!clientName && !masterSheetId) {
    throw new Error("Missing clientName or masterSheetId");
  }

  const sheets = await getSheetsClient();
  let cleanMasterId = masterSheetId ? (extractSheetIdFromUrl(masterSheetId) || masterSheetId) : null;
  let cleanReconId = reconSheetId ? (extractSheetIdFromUrl(reconSheetId) || reconSheetId) : null;
  let resolvedClient = clientName || "";

  // 1. Resolve missing clientName, masterSheetId, or reconSheetId
  if ((!cleanMasterId || !cleanReconId) && (resolvedClient || cleanMasterId)) {
    try {
      const acId = automationCommanderSheetId || process.env.AUTOMATION_COMMANDER_SHEET_ID || "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
      const resp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: "AutoUpdates!A2:M500"
      }));
      const rows = resp.data.values || [];
      const match = rows.find(r => {
        const cName = String(r[0] || "").trim().toLowerCase();
        const mUrl = String(r[12] || "").trim();
        const mId = extractSheetIdFromUrl(mUrl) || mUrl;
        if (cleanMasterId && mId === cleanMasterId) return true;
        if (resolvedClient && cName.includes(resolvedClient.toLowerCase().trim())) return true;
        return false;
      });
      if (match) {
        if (!resolvedClient) resolvedClient = String(match[0] || "").trim();
        if (!cleanMasterId) cleanMasterId = extractSheetIdFromUrl(match[12]) || String(match[12] || "").trim();
        if (!cleanReconId && match[9]) cleanReconId = extractSheetIdFromUrl(match[9]) || String(match[9] || "").trim();
      }
    } catch (e) {
      console.warn("⚠️ Could not lookup client in AutoUpdates:", e.message);
    }
  }

  // Fallback: Read Recon Sheet URL from KeyInfo!G1 on Master Sheet
  if (!cleanReconId && cleanMasterId) {
    try {
      const g1Resp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: cleanMasterId,
        range: "KeyInfo!G1"
      }));
      const g1Val = g1Resp.data.values?.[0]?.[0];
      if (g1Val) cleanReconId = extractSheetIdFromUrl(g1Val) || g1Val;
    } catch (e) {
      console.warn("⚠️ Could not read KeyInfo!G1 from master sheet:", e.message);
    }
  }

  if (!cleanReconId) {
    throw new Error(`Recon Sheet ID not configured for client: ${resolvedClient || masterSheetId}`);
  }

  // 2. Determine target tabs in the Recon Sheet
  const reconMeta = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: cleanReconId,
    fields: "sheets.properties.title"
  }));
  const allTabs = (reconMeta.data.sheets || []).map(s => s.properties.title);
  const monthlyTabs = allTabs.filter(t => /^\d{4}$/.test(t));

  let targetTabs = [];

  if (monthKey) {
    const keys = Array.isArray(monthKey) ? monthKey : [monthKey];
    keys.forEach(k => {
      if (/^\d{4}-\d{2}$/.test(k)) {
        const tab = `${k.slice(2, 4)}${k.slice(5, 7)}`;
        if (monthlyTabs.includes(tab) && !targetTabs.includes(tab)) {
          targetTabs.push(tab);
        }
      } else if (/^\d{4}$/.test(k)) {
        if (monthlyTabs.includes(k) && !targetTabs.includes(k)) {
          targetTabs.push(k);
        }
      }
    });
  } else {
    // Auto-detect: inspect which tabs have unreconciled items in CD4:CN, plus the latest 2 monthly tabs
    const checkRanges = monthlyTabs.map(t => `'${t}'!CD4:CI10`);
    const tabsWithUnrecon = new Set();
    if (checkRanges.length > 0) {
      try {
        const batchCheck = await withRetry(() => sheets.spreadsheets.values.batchGet({
          spreadsheetId: cleanReconId,
          ranges: checkRanges,
          valueRenderOption: "FORMATTED_VALUE"
        }));
        (batchCheck.data.valueRanges || []).forEach((vr, idx) => {
          const tabName = monthlyTabs[idx];
          const hasRows = (vr.values || []).some(row => (row[2] || row[3] || row[5]));
          if (hasRows) {
            tabsWithUnrecon.add(tabName);
          }
        });
      } catch (err) {
        console.warn("⚠️ Could not batch check unreconciled ranges:", err.message);
      }
    }

    // Always include any tab with unreconciled items, plus the latest 2 monthly tabs
    monthlyTabs.forEach((t, idx) => {
      if (tabsWithUnrecon.has(t) || idx < 2) {
        if (!targetTabs.includes(t)) targetTabs.push(t);
      }
    });
  }

  if (targetTabs.length === 0) {
    return {
      success: true,
      clientName: resolvedClient,
      message: "No active monthly tabs found to reconcile",
      reconciledMonths: []
    };
  }

  const results = [];

  for (const tabName of targetTabs) {
    const yy = parseInt(tabName.slice(0, 2), 10);
    const mm = parseInt(tabName.slice(2, 4), 10);
    const fullYear = yy < 100 ? 2000 + yy : yy;
    const tabMonthKey = `${fullYear}-${String(mm).padStart(2, "0")}`;

    // Read existing bank transactions, unreconciled items, tracked bank accounts, and DA1 platform
    const rangesToFetch = [
      `'${tabName}'!A3:Q200`,
      `'${tabName}'!CD4:CN60`,
      `'KeyInfo'!H12:H21`,
      `'${tabName}'!DA1`
    ];

    const batchRes = await withRetry(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanReconId,
      ranges: rangesToFetch,
      valueRenderOption: "FORMATTED_VALUE"
    }));

    const rawTx = batchRes.data.valueRanges?.[0]?.values || [];
    const rawUnrecon = batchRes.data.valueRanges?.[1]?.values || [];
    const rawAccounts = batchRes.data.valueRanges?.[2]?.values || [];
    const da1Raw = String(batchRes.data.valueRanges?.[3]?.values?.[0]?.[0] || "").trim();
    const isQbDa1 = da1Raw.toLowerCase().includes("quick");

    const trackedBankAccounts = rawAccounts
      .map(r => String(r[0] || "").trim())
      .filter(acc => acc && !acc.toLowerCase().includes("non-cash") && !acc.endsWith(":"));

    const defaultAccount = trackedBankAccounts[0] || "";

    const currentBankTxns = rawTx.map((r, i) => {
      const date = r[1] || r[0] || "";
      const accountName = String(r[2] || "").trim();
      const payee = r[3] || r[4] || "";
      const particulars = r[4] || "";
      const ref = r[6] || r[5] || "";
      const outAmt = r[8] || "";
      const inAmt = r[9] || "";
      const category = String(r[16] || "").trim();
      return {
        rowNum: i + 3,
        date,
        accountName: accountName || defaultAccount,
        payee,
        particulars,
        reference: ref,
        outAmount: outAmt,
        inAmount: inAmt,
        category,
        suggestedCategory: category
      };
    }).filter(t => t.date || t.payee || t.outAmount || t.inAmount);

    const currentUnreconItems = rawUnrecon.map((r, i) => {
      const date = r[2] || "";
      const payee = r[3] || "";
      const particulars = r[4] || "";
      const amount = r[5] || "";
      const category = String(r[9] || "").trim();
      const vatApplies = String(r[10] || "").trim() || "No";
      const numAmt = parseCellNumber(amount) ?? 0;
      const absAmt = Math.abs(numAmt);
      const isNegative = isQbDa1 ? numAmt > 0 : numAmt < 0;
      return {
        rowNum: i + 4,
        date,
        payee,
        particulars,
        amount: absAmt || amount,
        outAmount: isNegative ? absAmt : 0,
        inAmount: !isNegative ? absAmt : 0,
        isNegative,
        category,
        vatApplies
      };
    }).filter(u => u.date || u.payee || u.amount);

    // Fetch live API transactions
    let apiData = null;
    try {
      apiData = await fetchClientReconciledBankTransactions({
        clientName: resolvedClient,
        masterSheetId: cleanMasterId,
        reconSheetId: cleanReconId,
        monthKey: tabMonthKey
      });
    } catch (apiErr) {
      console.warn(`⚠️ Failed to fetch API bank transactions for ${resolvedClient} (${tabMonthKey}):`, apiErr.message);
      results.push({
        tabName,
        monthKey: tabMonthKey,
        success: false,
        error: apiErr.message
      });
      continue;
    }

    const incomingApiTxns = apiData.transactions || [];
    const incomingNonCashTxns = apiData.nonCashTransactions || [];

    // Perform intelligent delta reconciliation update
    const updateResult = performTransactionsUpdate({
      currentBankTxns,
      currentUnreconItems,
      incomingApiTxns,
      incomingNonCashTxns,
      defaultAccount
    });

    // Save updated transactions and unreconciled items back to the Recon Sheet
    await Promise.all([
      syncReconBankTransactions({
        reconSheetId: cleanReconId,
        tabName,
        transactions: updateResult.nextBankTxns
      }),
      syncReconUnreconciledItems({
        reconSheetId: cleanReconId,
        tabName,
        unreconciledItems: updateResult.nextUnreconItems
      })
    ]);

    results.push({
      tabName,
      monthKey: tabMonthKey,
      success: true,
      matchedFromUnreconCount: updateResult.matchedFromUnreconCount,
      matchedNonCashCount: updateResult.matchedNonCashCount,
      newAddedCount: updateResult.newAddedCount,
      updatedCount: updateResult.updatedCount,
      deletedCount: updateResult.deletedCount,
      remainingUnreconCount: updateResult.nextUnreconItems.length
    });

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: resolvedClient,
      category: "CASH_RECON",
      action: "Auto Reconcile Bank Feeds",
      summary: `Auto-reconciled ${tabName}: ${updateResult.matchedFromUnreconCount} cash unreconciled cleared, ${updateResult.matchedNonCashCount} non-cash cleared, ${updateResult.newAddedCount} new added`,
      details: {
        tabName,
        monthKey: tabMonthKey,
        matchedFromUnrecon: updateResult.matchedFromUnreconCount,
        matchedNonCash: updateResult.matchedNonCashCount,
        remainingUnrecon: updateResult.nextUnreconItems.length,
        fallbackAddedCount: (updateResult.fallbackAddedTxns || []).length,
        clientName: resolvedClient
      }
    }).catch(e => console.error("PMA log failed:", e));

    // If transactions were added via the high-bar safety fallback, log to Master Sheet AutoLog to raise PMA alert
    if (updateResult.fallbackAddedTxns && updateResult.fallbackAddedTxns.length > 0 && cleanMasterId) {
      try {
        const nowStr = new Date().toISOString().replace("T", " ").substring(0, 19);
        const txListStr = updateResult.fallbackAddedTxns.map(t =>
          `• ${t.date || ""} ${t.payee || t.unreconPayee || "Transaction"} (£${t.outAmount || t.inAmount || t.unreconAmount || "0"}) -> Added to bank transactions as ${t.category}`
        ).join("\n");

        const summary = `P&L Outgoings updated: Bank transaction added from unreconciled item (${tabName})`;
        const details = `Added ${updateResult.fallbackAddedTxns.length} transaction(s) to bank transactions list from unreconciled items as a fallback:\n${txListStr}\nCleared from unreconciled list to prevent double counting.`;

        await withRetry(() =>
          sheets.spreadsheets.values.append({
            spreadsheetId: cleanMasterId,
            range: "AutoLog!A:D",
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: {
              values: [[nowStr, "EXPENSES", summary, details]]
            }
          })
        );
        console.log(`[Bank Recon] Logged fallback bank transaction alert to Master AutoLog for ${resolvedClient} (${tabName})`);
      } catch (logErr) {
        console.warn("⚠️ Could not write fallback bank transaction to AutoLog:", logErr.message);
      }
    }
  }

  return {
    success: true,
    clientName: resolvedClient,
    reconciledMonths: results
  };
}
