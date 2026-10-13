/**
 * ============================================================================
 * BANK TRANSACTIONS SERVICE (services/bankTransactionsService.js)
 * ============================================================================
 * 
 * Orchestrates:
 * 1. Fetching reconciled bank transactions from accounting tool APIs (Xero, QBO)
 *    for the accounts tracked for cash in KeyInfo!H12:H22.
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
 * for the tracked bank accounts configured in Master Sheet KeyInfo!H12:H22.
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

  // 1. Read tracked bank accounts from KeyInfo!H12:H22
  const keyInfoResp = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: cleanMasterId,
    range: "KeyInfo!H12:H22"
  }));

  const trackedAccountNames = (keyInfoResp.data.values || [])
    .map(r => String(r[0] || "").trim())
    .filter(Boolean);

  if (trackedAccountNames.length === 0) {
    return {
      success: true,
      hasTrackedAccounts: false,
      message: "No bank accounts currently configured in Client Settings > Bank Accounts (KeyInfo!H12:H22).",
      trackedAccountNames: [],
      transactions: []
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

    // Match tracked account names
    const matchedAccounts = allXeroAccounts.filter(acc => {
      return trackedAccountNames.some(tracked => {
        const tLower = tracked.toLowerCase();
        const aLower = (acc.name || "").toLowerCase();
        return aLower.includes(tLower) || tLower.includes(aLower);
      });
    });

    // Query transactions for each matched account
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
          source: "quickbooks"
        });
      });
    }
  }

  // Sort by date ascending
  transactions.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  // Strictly filter transactions to target month date range
  const filteredTxns = transactions.filter(tx => {
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

  return {
    success: true,
    hasTrackedAccounts: true,
    hasIntegration: true,
    tool: activeTool,
    trackedAccountNames,
    totalTransactions: categorizedTxns.length,
    startDate,
    endDate,
    transactions: categorizedTxns
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
        return line.split(/,/).map(c => c.trim().replace(/^["']|["']$/g, ""));
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
      totalLinesProcessed: 0,
      inMonthCount: 0,
      otherMonthCount: 0,
      skippedSummaryCount: 0,
      skippedLines: [],
      targetMonth: { year: targetYear, month: targetMonth, label: targetMonthLabel }
    };
  }

  const isStructuredReport = inputRows.some(r => {
    const txt = (Array.isArray(r) ? r.join(" ") : String(r)).toLowerCase();
    return txt.includes("reconciliation summary") ||
           txt.includes("totals summary") ||
           txt.includes("statement balances") ||
           txt.includes("plus outstanding") ||
           txt.includes("balance in xero");
  });

  const SUMMARY_REGEX = /\b(statement balance|balance in xero|balance as per|calculated balance out by|imported statement balance|total outstanding|total payments|total receipts|total unreconciled|closing balance|opening balance|bank account:|account number:|page \d+ of \d+|reconciliation summary|reconciliation report|bank reconciliation|totals summary)\b/i;

  let currentSection = null;
  const items = [];
  const skippedLines = [];

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

    // Skip table header rows
    if (lower.startsWith("date") || lower.startsWith("cheque no") || lower.startsWith("description") || lower.startsWith("reference") || lower.startsWith("status")) {
      skippedLines.push({ line: joinedLine, reason: "Column headers" });
      return;
    }

    // Filter out columns that are empty
    const cleanCols = cols.filter(c => c !== "");
    if (cleanCols.length < 2) {
      skippedLines.push({ line: joinedLine, reason: "Not enough columns" });
      return;
    }

    // Find date column anywhere in the first 5 columns
    let dateObj = null;
    let dateColIdx = -1;
    for (let c = 0; c < Math.min(cleanCols.length, 5); c++) {
      const d = parseBankDate(cleanCols[c]);
      if (d) {
        dateObj = d;
        dateColIdx = c;
        break;
      }
    }

    if (!dateObj) {
      skippedLines.push({ line: joinedLine, reason: "No date found" });
      return;
    }

    // Find amount column (search from end backwards)
    let amount = 0;
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

    // Remaining text columns between date and amount are payee/particulars/ref
    const textCols = cleanCols.filter((_, cIdx) => cIdx !== dateColIdx && cIdx !== amountColIdx);
    let payee = textCols[0] || "Unreconciled item";
    let particulars = textCols.length >= 2 ? textCols[1] : payee;
    let reference = textCols.length >= 3 ? textCols[2] : "";

    // Determine direction (in vs out)
    let isNegative = amount < 0 || isParenNeg;
    if (currentSection === "payments") isNegative = true;
    else if (currentSection === "receipts") isNegative = false;

    const absAmt = Math.abs(amount);

    // Month boundary check
    const isInTargetMonth = Boolean(targetYear && targetMonth && dateObj.year === targetYear && dateObj.month === targetMonth);
    const rowMonthLabel = new Date(dateObj.year, dateObj.month - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });

    items.push({
      id: `unrecon_${Date.now()}_${idx}`,
      date: dateObj.iso,
      displayDate: cleanCols[dateColIdx],
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
      selected: isInTargetMonth,
      isReconciled: false,
      source: "unreconciled_pasted",
      suggestedCategory: isNegative ? "Outgoings" : "Revenue",
      vatApplies: "No",
      category: "",
      rawLine: joinedLine
    });
  });

  // Sort items: checked items for the month FIRST, then unchecked items, sorted by date within groups
  items.sort((a, b) => {
    if (a.selected !== b.selected) {
      return b.selected ? 1 : -1;
    }
    return (a.date || "").localeCompare(b.date || "");
  });

  return {
    success: true,
    items,
    validItems: items.filter(it => it.isInTargetMonth),
    totalLinesProcessed: inputRows.length,
    inMonthCount: items.filter(it => it.isInTargetMonth).length,
    otherMonthCount: items.filter(it => !it.isInTargetMonth).length,
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
