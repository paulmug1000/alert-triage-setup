/**
 * ============================================================================
 * CASH OPENING FIGURE SERVICE (services/cashOpeningService.js)
 * ============================================================================
 *
 * Automatically detects month-end bank balances for the previous and current
 * calendar months' opening figures (handling Xero Statement vs Ledger balance
 * for unreconciled items, and QuickBooks Balance Sheet cash accounts), and
 * writes confirmed figures directly into Client!Cash Row 36 (Actual closing balance).
 */

import {
  getSheetsClient,
  withRetry,
  extractSheetIdFromUrl,
  colIndexToLetter,
} from "./sheetsClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import { resolveAccountingToolAuth } from "./accountingSuggestionsService.js";
import {
  fetchXeroBankAccounts,
  fetchXeroBankSummaryReport,
  parseXeroBankSummaryReport,
} from "./xeroService.js";
import { assertValidQBRealmId, fetchQuickBooksBankAccounts } from "./quickbooksService.js";
import { parseYear0Date, parseYear0Number } from "./year0SetupService.js";
import { parseHeaderMonthMeta_ } from "./salariesService.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import {
  flushImmediateAndScheduleBackgroundClientRecomputes,
  resolveClientSheetIdFromMaster,
  resolveSupabaseSheetContext,
} from "./masterEngineService.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeFormulaInput } from "./userPermissions.js";
import { redisClient } from "./redisClient.js";
import { getSettingsRedisKey } from "./clientSettingsService.js";
import {
  saveClientCashBankBreakdownMonth,
  sanitizeBreakdownAccounts,
  buildRow36FormulaFromAccounts,
} from "./cashBankBreakdownService.js";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

function lastDayStr(d) {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return {
    fromDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`,
    toDate: `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`,
    asOfLabel: `${last.getDate()} ${SHORT_MONTHS[last.getMonth()]} ${last.getFullYear()}`,
  };
}

function normalizeStr(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Extracts cash/bank account rows from a QuickBooks BalanceSheet report JSON.
 */
function parseQuickBooksBalanceSheetBankAccounts(reportJson) {
  const accounts = [];
  const rootRows = reportJson?.Rows?.Row || [];

  const walk = (row, inBankSection = false) => {
    if (!row) return;
    const hdrTitle = String(row.Header?.ColData?.[0]?.value || "").trim().toLowerCase();
    const isBankGroup =
      inBankSection ||
      row.group === "BankAccounts" ||
      /\bbank\b|\bcash\b|\bcash at bank\b|\bchecking\b|\bsavings\b/i.test(hdrTitle);

    if (row.type === "Section" && Array.isArray(row.Rows?.Row)) {
      row.Rows.Row.forEach((child) => walk(child, isBankGroup));
      return;
    }

    if (inBankSection && Array.isArray(row.ColData) && row.ColData.length >= 2) {
      const name = String(row.ColData[0]?.value || "").trim();
      const id = String(row.ColData[0]?.id || "").trim();
      const rawVal = row.ColData[row.ColData.length - 1]?.value;
      const num = parseFloat(String(rawVal ?? "").replace(/,/g, ""));
      if (name && !/^total\b/i.test(name) && Number.isFinite(num)) {
        accounts.push({
          accountId: id || normalizeStr(name),
          accountName: name,
          statementBalance: null,
          closingXeroBalance: round2(num),
          difference: 0,
          hasStatementBalance: false,
          isReconciled: false,
          included: true,
        });
      }
    }
  };

  rootRows.forEach((r) => walk(r, false));
  return accounts;
}

/**
 * Detects Cash opening balances for the previous and current calendar months
 * (mapped to their prior month's Row 36 Actual closing balance cell on Client!Cash).
 */
export async function detectCashOpeningBalances({ clientName, masterSheetId }) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const kiResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: [
        "KeyInfo!B2",
        "KeyInfo!B17",
        "KeyInfo!X28",
        "KeyInfo!H12:I21",
        "KeyInfo!H23:I29",
      ],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const vr = kiResp.data?.valueRanges || [];
  const startDate = parseYear0Date(vr[0]?.values?.[0]?.[0]);
  const currency = String(vr[1]?.values?.[0]?.[0] || "GBP").trim() || "GBP";
  const cleanClientId = await resolveClientSheetIdFromMaster({
    clientName,
    masterSheetId: cleanMasterId,
    rawKeyInfoX28: vr[2]?.values?.[0]?.[0] || "",
  });
  if (!cleanClientId) throw new Error("Client workspace sheet ID is not configured.");

  const cashAcctPairs = (vr[3]?.values || [])
    .map((r) => ({ name: String(r?.[0] || "").trim(), id: String(r?.[1] || "").trim() }))
    .filter((p) => p.name || p.id);
  const nonCashAcctPairs = (vr[4]?.values || [])
    .map((r) => ({ name: String(r?.[0] || "").trim(), id: String(r?.[1] || "").trim() }))
    .filter((p) => p.name || p.id);

  // Read Client!Cash headers (Row 1), Opening row (Row 4), and Actual closing row (Row 36)
  const cashResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanClientId,
      ranges: ["Cash!A1:AK1", "Cash!A4:AK4", "Cash!A36:AK36"],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const cashHdrRow = cashResp.data?.valueRanges?.[0]?.values?.[0] || [];
  const cashRow4 = cashResp.data?.valueRanges?.[1]?.values?.[0] || [];
  const cashRow36 = cashResp.data?.valueRanges?.[2]?.values?.[0] || [];

  const cashColsByKey = new Map();
  for (let c = 1; c < cashHdrRow.length; c++) {
    const parsed = parseHeaderMonthMeta_(cashHdrRow[c]);
    if (!parsed) continue;
    const dObj = new Date(parsed.year, parsed.monthIdx, 1);
    cashColsByKey.set(monthKeyFromDate(dObj), {
      col0: c,
      colLetter: colIndexToLetter(c + 1),
      monthKey: monthKeyFromDate(dObj),
      shortLabel: shortMonthLabel(dObj),
      dateObj: dObj,
      existingRow4: cashRow4[c] === "" || cashRow4[c] === undefined ? null : round2(parseYear0Number(cashRow4[c])),
      existingRow36: cashRow36[c] === "" || cashRow36[c] === undefined ? null : round2(parseYear0Number(cashRow36[c])),
    });
  }

  // Build target opening months: previous calendar month & current calendar month
  const now = new Date();
  const prevCalMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const currCalMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const rawTargets = [
    { role: "previous_month", title: `Previous month (${shortMonthLabel(prevCalMonth)})`, openingMonthDate: prevCalMonth },
    { role: "current_month", title: `Current month (${shortMonthLabel(currCalMonth)})`, openingMonthDate: currCalMonth },
  ];

  // For each opening month M, its opening balance comes from the closing balance of M-1 (written in M-1 Row 36)
  // If M happens to be Month 1 (Col B, no prior column in Cash), map to B4 Opening balance cleanly.
  const entries = rawTargets.map((t) => {
    const openKey = monthKeyFromDate(t.openingMonthDate);
    const prevDate = new Date(t.openingMonthDate.getFullYear(), t.openingMonthDate.getMonth() - 1, 1);
    const prevKey = monthKeyFromDate(prevDate);
    const prevColInfo = cashColsByKey.get(prevKey);
    const openColInfo = cashColsByKey.get(openKey);
    const dates = lastDayStr(prevDate);

    if (prevColInfo) {
      return {
        role: t.role,
        title: t.title,
        openingMonthKey: openKey,
        openingMonthLabel: shortMonthLabel(t.openingMonthDate),
        closingMonthKey: prevKey,
        closingMonthLabel: shortMonthLabel(prevDate),
        asOfLabel: dates.asOfLabel,
        fromDate: dates.fromDate,
        toDate: dates.toDate,
        targetRow: 36,
        targetCol0: prevColInfo.col0,
        targetColLetter: prevColInfo.colLetter,
        targetCellRef: `Cash!${prevColInfo.colLetter}36`,
        existingValue: prevColInfo.existingRow36,
      };
    }

    return {
      role: t.role,
      title: t.title,
      openingMonthKey: openKey,
      openingMonthLabel: shortMonthLabel(t.openingMonthDate),
      closingMonthKey: prevKey,
      closingMonthLabel: shortMonthLabel(prevDate),
      asOfLabel: dates.asOfLabel,
      fromDate: dates.fromDate,
      toDate: dates.toDate,
      targetRow: 4,
      targetCol0: openColInfo ? openColInfo.col0 : 1,
      targetColLetter: openColInfo ? openColInfo.colLetter : "B",
      targetCellRef: `Cash!${openColInfo ? openColInfo.colLetter : "B"}4`,
      existingValue: openColInfo?.existingRow4 ?? null,
    };
  });

  // Fetch balances from connected accounting tool (Xero BankSummary or QBO BalanceSheet)
  let auth = null;
  try {
    auth = await resolveAccountingToolAuth(clientName, cleanMasterId);
  } catch {
    auth = null;
  }

  let accountingTool = auth?.tool || "None";
  let integrationNote = "";
  let bankAccountsMeta = [];

  if (auth?.tool === "Xero") {
    bankAccountsMeta = await fetchXeroBankAccounts(auth.accessToken, auth.tenantId).catch(() => []);
  }

  const nonCashIds = new Set(nonCashAcctPairs.map((p) => p.id.toLowerCase()).filter(Boolean));
  const nonCashNames = new Set(nonCashAcctPairs.map((p) => normalizeStr(p.name)).filter(Boolean));
  const cashIds = new Set(cashAcctPairs.map((p) => p.id.toLowerCase()).filter(Boolean));
  const cashNames = new Set(cashAcctPairs.map((p) => normalizeStr(p.name)).filter(Boolean));

  const isAccountIncludedByDefault = (acc) => {
    const idL = String(acc.accountId || "").trim().toLowerCase();
    const nameN = normalizeStr(acc.accountName);
    if ((idL && nonCashIds.has(idL)) || (nameN && nonCashNames.has(nameN))) return false;
    if (cashIds.size > 0 || cashNames.size > 0) {
      return (idL && cashIds.has(idL)) || (nameN && cashNames.has(nameN));
    }
    return true;
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (i > 0 && auth) await new Promise((r) => setTimeout(r, 250));

    let accounts = [];
    if (auth?.tool === "Xero") {
      try {
        const rep = await fetchXeroBankSummaryReport({
          accessToken: auth.accessToken,
          tenantId: auth.tenantId,
          fromDate: entry.fromDate,
          toDate: entry.toDate,
        });
        const parsed = parseXeroBankSummaryReport(rep);
        accounts = parsed.map((a) => {
          const metaMatch = bankAccountsMeta.find(
            (m) =>
              (a.accountId && m.id === a.accountId) ||
              normalizeStr(m.name) === normalizeStr(a.accountName)
          );
          const isArchived = String(metaMatch?.status || "").toUpperCase() === "ARCHIVED";
          const included = !isArchived && isAccountIncludedByDefault(a);
          return {
            accountId: a.accountId || normalizeStr(a.accountName),
            accountName: a.accountName,
            statementBalance: a.statementBalance,
            closingXeroBalance: a.closingXeroBalance,
            difference: a.difference,
            hasStatementBalance: a.hasStatementBalance,
            isReconciled: a.isReconciled,
            included,
          };
        });
      } catch (err) {
        integrationNote = err?.message || "Could not fetch Xero Bank Summary.";
      }
    } else if (auth?.tool === "QuickBooks") {
      try {
        const safeRealmId = assertValidQBRealmId(auth.realmId);
        const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/reports/BalanceSheet?start_date=${encodeURIComponent(entry.fromDate)}&end_date=${encodeURIComponent(entry.toDate)}&minorversion=73`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
          redirect: "manual",
        });
        if (res.ok) {
          const json = await res.json();
          const parsed = parseQuickBooksBalanceSheetBankAccounts(json);
          accounts = parsed.map((a) => ({
            ...a,
            included: isAccountIncludedByDefault(a),
          }));
        }
      } catch (err) {
        integrationNote = err?.message || "Could not fetch QuickBooks Balance Sheet.";
      }
    }

    const activeAccounts = accounts.filter((a) => a.included);
    const hasAnyStatement = activeAccounts.some((a) => a.hasStatementBalance);
    const statementTotal = round2(
      activeAccounts.reduce(
        (s, a) => s + (a.hasStatementBalance ? Number(a.statementBalance || 0) : Number(a.closingXeroBalance || 0)),
        0
      )
    );
    const ledgerTotal = round2(
      activeAccounts.reduce((s, a) => s + Number(a.closingXeroBalance || 0), 0)
    );
    const unreconciledTotal = round2(statementTotal - ledgerTotal);

    entry.accounts = accounts;
    entry.preferredBasis = auth?.tool === "Xero" && hasAnyStatement ? "statement" : "ledger";
    entry.statementTotal = statementTotal;
    entry.ledgerTotal = ledgerTotal;
    entry.unreconciledTotal = unreconciledTotal;
    entry.suggestedAmount =
      activeAccounts.length > 0
        ? (entry.preferredBasis === "statement" ? statementTotal : ledgerTotal)
        : (entry.existingValue ?? 0);
  }

  return {
    clientName: clientName || "",
    currency,
    accountingTool,
    integrationNote,
    hasConfiguredCashAccounts: cashAcctPairs.length > 0,
    configuredCashAccountNames: cashAcctPairs.map((p) => p.name).filter(Boolean),
    startDateFormatted: startDate ? shortMonthLabel(startDate) : "",
    entries,
  };
}

/**
 * Writes confirmed Cash opening / Row 36 Actual closing balances to Client!Cash.
 */
export async function saveCashOpeningBalances({ clientName, masterSheetId, updates = [] }) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const kiResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "KeyInfo!X28",
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const cleanClientId = await resolveClientSheetIdFromMaster({
    clientName,
    masterSheetId: cleanMasterId,
    rawKeyInfoX28: kiResp.data?.values?.[0]?.[0] || "",
  });
  if (!cleanClientId) throw new Error("Client workspace sheet ID is not configured.");

  // Resolve valid monthly column letters strictly server-side from Client!Cash row 1 headers
  const cashHdrResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: cleanClientId,
      range: "Cash!A1:AK1",
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const cashHdrRow = cashHdrResp.data?.values?.[0] || [];
  const cashColsByOpenKey = new Map();
  const cashColsByCloseKey = new Map();
  const cashColsByColLetter = new Map();
  for (let c = 1; c < cashHdrRow.length && c <= 36; c++) {
    const parsed = parseHeaderMonthMeta_(cashHdrRow[c]);
    if (!parsed) continue;
    const dObj = new Date(parsed.year, parsed.monthIdx, 1);
    const colLetter = colIndexToLetter(c + 1);
    const mKey = monthKeyFromDate(dObj);
    cashColsByOpenKey.set(mKey, { col0: c, colLetter, rowNum: c === 1 ? 4 : 36, monthKey: mKey });
    const nextD = new Date(dObj.getFullYear(), dObj.getMonth() + 1, 1);
    cashColsByCloseKey.set(monthKeyFromDate(nextD), { col0: c, colLetter, rowNum: 36, monthKey: mKey });
    cashColsByColLetter.set(colLetter, mKey);
  }

  const batchData = [];
  const breakdownSaves = [];
  for (const item of updates || []) {
    if (!item || item.amount === "" || item.amount === null || item.amount === undefined) continue;
    let colLet = "";
    let rowNum = 36;
    let resolvedClosingMonthKey = "";

    const openKey = String(item.openingMonthKey || "").trim();
    if (/^\d{4}-\d{2}$/.test(openKey) && cashColsByCloseKey.has(openKey)) {
      const resolved = cashColsByCloseKey.get(openKey);
      colLet = resolved.colLetter;
      rowNum = 36;
      resolvedClosingMonthKey = resolved.monthKey;
    } else if (/^\d{4}-\d{2}$/.test(openKey) && cashColsByOpenKey.has(openKey)) {
      const resolved = cashColsByOpenKey.get(openKey);
      colLet = resolved.colLetter;
      rowNum = resolved.rowNum;
      resolvedClosingMonthKey = resolved.monthKey;
    } else {
      colLet = String(item.targetColLetter || "").trim().toUpperCase();
      rowNum = Number(item.targetRow) === 4 ? 4 : 36;
      if (rowNum === 4) {
        if (colLet !== "B") continue;
      } else if (!/^([B-Z]|A[A-K])$/.test(colLet)) {
        continue;
      }
      resolvedClosingMonthKey = cashColsByColLetter.get(colLet) || "";
    }

    const val = round2(parseYear0Number(item.amount));
    let sheetCellVal = val;
    if (rowNum === 36 && resolvedClosingMonthKey && Array.isArray(item.accounts) && item.accounts.length > 0) {
      const cleanAccounts = sanitizeBreakdownAccounts(item.accounts);
      if (cleanAccounts.length > 0) {
        const accountsSum = round2(cleanAccounts.reduce((s, a) => s + a.amount, 0));
        if (Math.abs(accountsSum - val) <= 0.02) {
          const nonZeroCount = cleanAccounts.filter((a) => Math.abs(a.amount) > 0.0001).length;
          if (nonZeroCount >= 2) {
            sheetCellVal = buildRow36FormulaFromAccounts(cleanAccounts);
          }
          breakdownSaves.push({
            clientName: clientName || "",
            monthKey: resolvedClosingMonthKey,
            accounts: cleanAccounts,
            total: val,
            source: "setup_cash_opening",
            basis: item.basis || "statement",
            updatedBy: "Setup",
          });
        }
      }
    }

    batchData.push({
      range: `Cash!${colLet}${rowNum}`,
      values: [[sheetCellVal]],
    });
  }

  if (batchData.length === 0) {
    throw new Error("No valid cash opening balances supplied to save.");
  }

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cleanClientId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: batchData,
      },
    })
  );

  for (const bd of breakdownSaves) {
    if (bd.clientName) {
      await saveClientCashBankBreakdownMonth(bd).catch((err) =>
        console.warn("Failed to persist setup cash bank breakdown:", err.message)
      );
    }
  }

  const flushCtx = await resolveSupabaseSheetContext({
    clientName: clientName || "",
    spreadsheetId: cleanClientId || cleanMasterId,
  }).catch(() => null);
  const flushTargetClient = flushCtx?.clientName || clientName || "";
  if (flushTargetClient) {
    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, flushTargetClient).catch(() => { });
  }
  await invalidatePmaClientCache(cleanClientId, cleanMasterId, ["cash", "dashboard", "views", "all"]).catch(() => { });

  await logPmaActivity(sheets, {
    clientName: clientName || "",
    category: "SETUP",
    action: "CASH_OPENING_SAVED",
    summary: `Updated Cash opening figures (${batchData.map((b) => `${b.range}=${b.values[0][0]}`).join(", ")})`,
    details: { updates: batchData },
  }).catch(() => { });

  return {
    success: true,
    writtenCount: batchData.length,
    rangesWritten: batchData.map((b) => b.range),
  };
}

/**
 * Loads all bank accounts from the connected accounting tool alongside currently
 * saved Cash (KeyInfo!H12:I21) and Non-cash (KeyInfo!H23:I28) selections.
 */
export async function getSetupBankAccounts({ clientName, masterSheetId }) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const [auth, kiResp] = await Promise.all([
    resolveAccountingToolAuth(clientName, cleanMasterId),
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: cleanMasterId,
        ranges: ["KeyInfo!B17", "KeyInfo!H12:I21", "KeyInfo!H23:I28"],
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    ),
  ]);

  if (!auth) {
    throw new Error("No active Xero or QuickBooks connection found for this client.");
  }

  const currency = String(kiResp.data?.valueRanges?.[0]?.values?.[0]?.[0] || "GBP").trim() || "GBP";
  const cashRows = kiResp.data?.valueRanges?.[1]?.values || [];
  const nonCashRows = kiResp.data?.valueRanges?.[2]?.values || [];

  const rawAccounts =
    auth.tool === "Xero"
      ? await fetchXeroBankAccounts(auth.accessToken, auth.tenantId)
      : await fetchQuickBooksBankAccounts(auth.accessToken, auth.realmId);

  // Compute previous 2 calendar months (m2 = 2 months ago, m1 = previous calendar month)
  const now = new Date();
  const m2Date = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const m1Date = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const m2Bounds = lastDayStr(m2Date);
  const m1Bounds = lastDayStr(m1Date);
  const prev2Label = shortMonthLabel(m2Date);
  const prev1Label = shortMonthLabel(m1Date);

  const m2Balances = new Map(); // normalizedName or id -> number
  const m1Balances = new Map();
  const m1TxnCounts = new Map(); // id or normalizedName -> count

  if (auth.tool === "Xero") {
    const headers = {
      Authorization: `Bearer ${auth.accessToken}`,
      "xero-tenant-id": auth.tenantId,
      Accept: "application/json",
    };

    const [repM2, repM1] = await Promise.all([
      fetchXeroBankSummaryReport({
        accessToken: auth.accessToken,
        tenantId: auth.tenantId,
        fromDate: m2Bounds.fromDate,
        toDate: m2Bounds.toDate,
      }).catch(() => null),
      fetchXeroBankSummaryReport({
        accessToken: auth.accessToken,
        tenantId: auth.tenantId,
        fromDate: m1Bounds.fromDate,
        toDate: m1Bounds.toDate,
      }).catch(() => null),
    ]);

    const recordBalances = (repJson, targetMap) => {
      if (!repJson) return;
      for (const a of parseXeroBankSummaryReport(repJson)) {
        const val = a.hasStatementBalance ? Number(a.statementBalance || 0) : Number(a.closingXeroBalance || 0);
        if (a.accountId) targetMap.set(a.accountId.toLowerCase(), round2(val));
        if (a.accountName) targetMap.set(normalizeStr(a.accountName), round2(val));
      }
    };
    recordBalances(repM2, m2Balances);
    recordBalances(repM1, m1Balances);

    // Count past calendar month transactions across BankTransactions, Payments, and BankTransfers
    const m1StartY = m1Date.getFullYear();
    const m1StartM = m1Date.getMonth() + 1;
    const m1EndD = new Date(m1StartY, m1StartM, 0).getDate();
    const whereClause = `Date>=DateTime(${m1StartY},${m1StartM},1)&&Date<=DateTime(${m1StartY},${m1StartM},${m1EndD})`;

    const fetchXeroPagedCount = async (endpoint, arrKey) => {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        if (page > 1) await new Promise((r) => setTimeout(r, 200));
        let res = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          res = await fetch(
            `https://api.xero.com/api.xro/2.0/${endpoint}?where=${encodeURIComponent(whereClause)}&page=${page}`,
            { headers, redirect: "manual" }
          ).catch(() => null);
          if (res?.status === 429) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          break;
        }
        if (!res?.ok) break;
        const j = await res.json().catch(() => null);
        const rows = j?.[arrKey] || [];
        all.push(...rows);
        if (rows.length < 100) break;
      }
      return all;
    };

    const [m1BankTxns, m1Payments, m1Transfers] = await Promise.all([
      fetchXeroPagedCount("BankTransactions", "BankTransactions"),
      fetchXeroPagedCount("Payments", "Payments"),
      fetchXeroPagedCount("BankTransfers", "BankTransfers"),
    ]);

    const incCount = (id, name) => {
      if (id) {
        const k = String(id).toLowerCase();
        m1TxnCounts.set(k, (m1TxnCounts.get(k) || 0) + 1);
      }
      if (name) {
        const nk = normalizeStr(name);
        m1TxnCounts.set(nk, (m1TxnCounts.get(nk) || 0) + 1);
      }
    };

    for (const bt of m1BankTxns) {
      if (String(bt.Status || "").toUpperCase() === "DELETED") continue;
      incCount(bt.BankAccount?.AccountID, bt.BankAccount?.Name);
    }
    for (const p of m1Payments) {
      if (String(p.Status || "").toUpperCase() === "DELETED") continue;
      incCount(p.Account?.AccountID, p.Account?.Name);
    }
    for (const tr of m1Transfers) {
      incCount(tr.FromBankAccount?.AccountID, tr.FromBankAccount?.Name);
      incCount(tr.ToBankAccount?.AccountID, tr.ToBankAccount?.Name);
    }
  } else if (auth.tool === "QuickBooks") {
    const safeRealmId = assertValidQBRealmId(auth.realmId);
    const qbFetchBs = async (bounds) => {
      const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/reports/BalanceSheet?start_date=${encodeURIComponent(bounds.fromDate)}&end_date=${encodeURIComponent(bounds.toDate)}&minorversion=73`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
        redirect: "manual",
      }).catch(() => null);
      if (!res?.ok) return [];
      const j = await res.json().catch(() => null);
      return j ? parseQuickBooksBalanceSheetBankAccounts(j) : [];
    };

    const [bsM2, bsM1] = await Promise.all([qbFetchBs(m2Bounds), qbFetchBs(m1Bounds)]);
    bsM2.forEach((a) => {
      if (a.accountId) m2Balances.set(String(a.accountId).toLowerCase(), round2(a.closingXeroBalance));
      if (a.accountName) m2Balances.set(normalizeStr(a.accountName), round2(a.closingXeroBalance));
    });
    bsM1.forEach((a) => {
      if (a.accountId) m1Balances.set(String(a.accountId).toLowerCase(), round2(a.closingXeroBalance));
      if (a.accountName) m1Balances.set(normalizeStr(a.accountName), round2(a.closingXeroBalance));
    });

    // Count past-month Purchases + Deposits per AccountRef in QuickBooks
    const qbQuery = async (sql) => {
      const u = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/query?query=${encodeURIComponent(sql)}&minorversion=73`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" }, redirect: "manual" }).catch(() => null);
      return r?.ok ? r.json().catch(() => null) : null;
    };
    const [purchJ, depJ] = await Promise.all([
      qbQuery(`SELECT AccountRef FROM Purchase WHERE TxnDate >= '${m1Bounds.fromDate}' AND TxnDate <= '${m1Bounds.toDate}' MAXRESULTS 1000`),
      qbQuery(`SELECT DepositToAccountRef FROM Deposit WHERE TxnDate >= '${m1Bounds.fromDate}' AND TxnDate <= '${m1Bounds.toDate}' MAXRESULTS 1000`),
    ]);
    for (const p of purchJ?.QueryResponse?.Purchase || []) {
      const aid = p.AccountRef?.value;
      const aname = p.AccountRef?.name;
      if (aid) m1TxnCounts.set(String(aid).toLowerCase(), (m1TxnCounts.get(String(aid).toLowerCase()) || 0) + 1);
      if (aname) m1TxnCounts.set(normalizeStr(aname), (m1TxnCounts.get(normalizeStr(aname)) || 0) + 1);
    }
    for (const d of depJ?.QueryResponse?.Deposit || []) {
      const aid = d.DepositToAccountRef?.value;
      const aname = d.DepositToAccountRef?.name;
      if (aid) m1TxnCounts.set(String(aid).toLowerCase(), (m1TxnCounts.get(String(aid).toLowerCase()) || 0) + 1);
      if (aname) m1TxnCounts.set(normalizeStr(aname), (m1TxnCounts.get(normalizeStr(aname)) || 0) + 1);
    }
  }

  const enrichedAccounts = (rawAccounts || []).map((acc) => {
    const idKey = String(acc.id || "").toLowerCase();
    const nameKey = normalizeStr(acc.name);
    const closingPrev2 =
      (idKey && m2Balances.has(idKey) ? m2Balances.get(idKey) : undefined) ??
      (nameKey && m2Balances.has(nameKey) ? m2Balances.get(nameKey) : 0);
    const closingPrev1 =
      (idKey && m1Balances.has(idKey) ? m1Balances.get(idKey) : undefined) ??
      (nameKey && m1Balances.has(nameKey) ? m1Balances.get(nameKey) : 0);
    const lastMonthTxnCount =
      (idKey && m1TxnCounts.has(idKey) ? m1TxnCounts.get(idKey) : undefined) ??
      (nameKey && m1TxnCounts.has(nameKey) ? m1TxnCounts.get(nameKey) : 0);

    return {
      ...acc,
      closingPrev2: round2(closingPrev2),
      closingPrev1: round2(closingPrev1),
      lastMonthTxnCount,
    };
  });

  // Sort active accounts first (by past-month txns desc, then non-zero balances, then name), archived last
  enrichedAccounts.sort((a, b) => {
    const archA = String(a.status || "").toUpperCase() === "ARCHIVED" ? 1 : 0;
    const archB = String(b.status || "").toUpperCase() === "ARCHIVED" ? 1 : 0;
    if (archA !== archB) return archA - archB;
    if (b.lastMonthTxnCount !== a.lastMonthTxnCount) return b.lastMonthTxnCount - a.lastMonthTxnCount;
    const balA = Math.abs(a.closingPrev1) + Math.abs(a.closingPrev2);
    const balB = Math.abs(b.closingPrev1) + Math.abs(b.closingPrev2);
    if ((balB > 0.01) !== (balA > 0.01)) return balB > 0.01 ? 1 : -1;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  const parsePairList = (rows) =>
    rows
      .map((r) => ({ name: String(r?.[0] || "").trim(), id: String(r?.[1] || "").trim() }))
      .filter((p) => p.name && !p.name.endsWith(":"));

  const selectedCashAccounts = parsePairList(cashRows);
  const selectedNonCashAccounts = parsePairList(nonCashRows);

  return {
    clientName: clientName || "",
    currency,
    accountingTool: auth.tool,
    prev2Label,
    prev1Label,
    accounts: enrichedAccounts,
    selectedCashAccounts,
    selectedNonCashAccounts,
  };
}

/**
 * Saves Cash (KeyInfo!H12:I21, max 10) and Non-cash (KeyInfo!H23:I28, max 6) bank accounts
 * to Master KeyInfo matching clientSettingsService.js conventions.
 */
export async function saveSetupBankAccounts({
  clientName,
  masterSheetId,
  cashAccounts = [],
  nonCashAccounts = [],
}) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const cashRows = [];
  for (let i = 0; i < 10; i++) {
    const item = cashAccounts[i];
    cashRows.push(
      item?.name
        ? [sanitizeFormulaInput(String(item.name).trim()), sanitizeFormulaInput(String(item.id || "").trim())]
        : ["", ""]
    );
  }

  const nonCashRows = [];
  for (let i = 0; i < 6; i++) {
    const item = nonCashAccounts[i];
    nonCashRows.push(
      item?.name
        ? [sanitizeFormulaInput(String(item.name).trim()), sanitizeFormulaInput(String(item.id || "").trim())]
        : ["", ""]
    );
  }

  const sheets = await getSheetsClient();
  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cleanMasterId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range: "KeyInfo!H12:I21", values: cashRows },
          { range: "KeyInfo!H23:I28", values: nonCashRows },
        ],
      },
    })
  );

  const flushCtx = await resolveSupabaseSheetContext({
    clientName: clientName || "",
    spreadsheetId: cleanMasterId,
  }).catch(() => null);
  const flushTargetClient = flushCtx?.clientName || clientName || "";
  if (flushTargetClient) {
    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, flushTargetClient).catch(() => { });
  }
  await invalidatePmaClientCache(flushCtx?.clientSheetId || null, cleanMasterId, ["setup", "settings", "cash", "all"]).catch(() => { });
  if (redisClient?.isOpen && clientName) {
    await redisClient.del(getSettingsRedisKey(clientName)).catch(() => { });
  }

  const cashCount = cashAccounts.filter((a) => a?.name).length;
  const nonCashCount = nonCashAccounts.filter((a) => a?.name).length;

  await logPmaActivity(sheets, {
    clientName: clientName || "",
    category: "SETUP",
    action: "BANK_ACCOUNTS_CONFIGURED",
    summary: `Configured ${cashCount} cash bank account(s) and ${nonCashCount} non-cash bank account(s)`,
    details: { cashAccounts, nonCashAccounts },
  }).catch(() => { });

  return {
    success: true,
    cashCount,
    nonCashCount,
  };
}
