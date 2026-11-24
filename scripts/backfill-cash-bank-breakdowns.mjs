/**
 * One-off backfill script to gather and store per-bank-account closing balance
 * breakdowns for Cash Row 36 ("Actual closing balance") across active clients.
 *
 * Defaults to --dry-run. Pass --apply to persist to Supabase system_config.
 *
 * Usage (from pulse-management-system/):
 *   node --env-file=.env.local scripts/backfill-cash-bank-breakdowns.mjs --dry-run
 *   node --env-file=.env.local scripts/backfill-cash-bank-breakdowns.mjs --dry-run --client="Eleven"
 *   node --env-file=.env.local scripts/backfill-cash-bank-breakdowns.mjs --apply
 */

import { getSupabaseAdmin, isSupabaseConfigured } from "../services/supabaseClient.js";
import { getSheetsClient, withRetry } from "../services/sheetsClient.js";
import { resolveAccountingToolAuth } from "../services/accountingSuggestionsService.js";
import {
  fetchXeroBankAccounts,
  fetchXeroBankSummaryReport,
  parseXeroBankSummaryReport,
} from "../services/xeroService.js";
import { assertValidQBRealmId } from "../services/quickbooksService.js";
import { parseMonthHeader } from "../services/cashEditService.js";
import { parseYear0Date, parseYear0Number } from "../services/year0SetupService.js";
import { invalidatePmaClientCache } from "../services/cacheService.js";
import {
  getClientCashBankBreakdowns,
  saveClientCashBankBreakdownMonth,
  parseRow36FormulaBreakdown,
  round2,
} from "../services/cashBankBreakdownService.js";

function normalizeStr(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getDefaultTargetMonths() {
  const now = new Date();
  const months = [];
  for (let offset = 0; offset <= 3; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

function parseArgs(argv) {
  let apply = false;
  let force = false;
  let client = "";
  let monthsArg = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--force") force = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg.startsWith("--client=")) client = arg.slice("--client=".length).trim();
    else if (arg === "--client" && argv[i + 1]) client = String(argv[++i]).trim();
    else if (arg.startsWith("--months=")) monthsArg = arg.slice("--months=".length).trim();
    else if (arg === "--months" && argv[i + 1]) monthsArg = String(argv[++i]).trim();
  }
  const targetMonths = monthsArg
    ? monthsArg.split(",").map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}$/.test(s))
    : getDefaultTargetMonths();
  return { help: false, apply, force, client, targetMonths };
}

function monthBounds(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const last = new Date(y, m, 0);
  return {
    fromDate: `${y}-${String(m).padStart(2, "0")}-01`,
    toDate: `${y}-${String(m).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`,
  };
}

function parseCellMonthKey(rawHdr) {
  if (rawHdr === "" || rawHdr === null || rawHdr === undefined) return null;
  if (typeof rawHdr === "number") {
    const d = parseYear0Date(rawHdr);
    if (d) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  const parsed = parseMonthHeader(String(rawHdr).trim());
  if (parsed) {
    return `${parsed.year}-${String(parsed.monthIdx + 1).padStart(2, "0")}`;
  }
  const d = parseYear0Date(rawHdr);
  if (d) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return null;
}

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
          hasStatementBalance: false,
        });
      }
    }
  };

  rootRows.forEach((r) => walk(r, false));
  return accounts;
}

async function fetchClientCashAndKeyInfo(sb, sheets, clientRow) {
  const mode = String(clientRow.client_mode || "sheet").toLowerCase();
  if (mode === "supabase") {
    const { data: grids } = await sb
      .from("master_sheet_grids")
      .select("tab_name, values_grid, formulas_grid")
      .eq("client_name", clientRow.client_name)
      .eq("sheet_role", "client")
      .in("tab_name", ["Cash", "KeyInfo"]);
    const byTab = {};
    for (const g of grids || []) byTab[g.tab_name] = g;
    return {
      cashVals: byTab.Cash?.values_grid || [],
      cashForms: byTab.Cash?.formulas_grid || [],
      kiVals: byTab.KeyInfo?.values_grid || [],
    };
  }

  const sheetId = clientRow.client_sheet_id;
  if (!sheetId) return { cashVals: [], cashForms: [], kiVals: [] };
  const [valResp, formResp] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: sheetId,
        ranges: ["Cash!A1:AK36", "KeyInfo!A1:I29"],
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    ),
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: "Cash!A36:AK36",
        valueRenderOption: "FORMULA",
      })
    ),
  ]);
  const cashVals = valResp.data?.valueRanges?.[0]?.values || [];
  const kiVals = valResp.data?.valueRanges?.[1]?.values || [];
  const formRow36 = formResp.data?.values?.[0] || [];
  const cashForms = [];
  cashForms[35] = formRow36;
  return { cashVals, cashForms, kiVals };
}

function extractKeyInfoBankConfig(kiVals) {
  const cashAccounts = [];
  for (let r = 11; r <= 20; r++) {
    const row = kiVals?.[r] || [];
    const name = String(row[7] ?? "").trim();
    const accountId = String(row[8] ?? "").trim();
    if (!name || name.endsWith(":") || name.toLowerCase().includes("non-cash")) continue;
    cashAccounts.push({ name, accountId });
  }
  const nonCashAccounts = [];
  for (let r = 22; r <= 28; r++) {
    const row = kiVals?.[r] || [];
    const name = String(row[7] ?? "").trim();
    const accountId = String(row[8] ?? "").trim();
    if (!name || name.endsWith(":") || name.toLowerCase().includes("non-cash")) continue;
    nonCashAccounts.push({ name, accountId });
  }
  return { cashAccounts, nonCashAccounts };
}

async function fetchAccountingMonthAccounts({ auth, bankAccountsMeta, bounds, cashAccounts, nonCashAccounts }) {
  const nonCashIds = new Set(nonCashAccounts.map((p) => p.accountId.toLowerCase()).filter(Boolean));
  const nonCashNames = new Set(nonCashAccounts.map((p) => normalizeStr(p.name)).filter(Boolean));
  const cashIds = new Set(cashAccounts.map((p) => p.accountId.toLowerCase()).filter(Boolean));
  const cashNames = new Set(cashAccounts.map((p) => normalizeStr(p.name)).filter(Boolean));

  const isIncluded = (acc) => {
    const idL = String(acc.accountId || "").trim().toLowerCase();
    const nameN = normalizeStr(acc.accountName);
    if ((idL && nonCashIds.has(idL)) || (nameN && nonCashNames.has(nameN))) return false;
    if (cashIds.size > 0 || cashNames.size > 0) {
      return (idL && cashIds.has(idL)) || (nameN && cashNames.has(nameN));
    }
    return true;
  };

  if (auth.tool === "Xero") {
    const rep = await fetchXeroBankSummaryReport({
      accessToken: auth.accessToken,
      tenantId: auth.tenantId,
      fromDate: bounds.fromDate,
      toDate: bounds.toDate,
    });
    const parsed = parseXeroBankSummaryReport(rep);
    return parsed
      .map((a) => {
        const metaMatch = (bankAccountsMeta || []).find(
          (m) => (a.accountId && m.id === a.accountId) || normalizeStr(m.name) === normalizeStr(a.accountName)
        );
        const isArchived = String(metaMatch?.status || "").toUpperCase() === "ARCHIVED";
        return {
          accountId: a.accountId || "",
          accountName: a.accountName,
          statementBalance: a.hasStatementBalance ? round2(a.statementBalance) : null,
          closingXeroBalance: round2(a.closingXeroBalance),
          hasStatementBalance: Boolean(a.hasStatementBalance),
          included: !isArchived && isIncluded(a),
        };
      })
      .filter((a) => a.included);
  }

  if (auth.tool === "QuickBooks") {
    const safeRealmId = assertValidQBRealmId(auth.realmId);
    const url = `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(safeRealmId)}/reports/BalanceSheet?start_date=${encodeURIComponent(bounds.fromDate)}&end_date=${encodeURIComponent(bounds.toDate)}&minorversion=73`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
      redirect: "manual",
    });
    if (!res.ok) {
      throw new Error(`QuickBooks BalanceSheet HTTP ${res.status}`);
    }
    const json = await res.json();
    return parseQuickBooksBalanceSheetBankAccounts(json).filter(isIncluded);
  }

  return [];
}

/**
 * Cross-matches formula numeric terms to configured cashAccounts using accounting API balances
 * when both exist (preventing order mismatches like Eleven where KeyInfo order != formula order).
 */
function matchFormulaTermsWithAccounting(terms = [], cashAccounts = [], acctList = []) {
  if (!Array.isArray(terms) || terms.length === 0 || terms.length !== cashAccounts.length) {
    return null;
  }

  // Pair each configured cashAccount with its accounting balance (if present in acctList)
  const cfgEntries = cashAccounts.map((cfg, cfgIdx) => {
    const cfgId = String(cfg.accountId || "").trim().toLowerCase();
    const cfgNorm = normalizeStr(cfg.name);
    const match = (acctList || []).find((a) => {
      const aId = String(a.accountId || "").trim().toLowerCase();
      const aNorm = normalizeStr(a.accountName);
      return (cfgId && aId && cfgId === aId) || (cfgNorm && aNorm && cfgNorm === aNorm);
    });
    const refAmounts = [];
    if (match) {
      if (match.hasStatementBalance && Number.isFinite(Number(match.statementBalance))) {
        refAmounts.push(round2(match.statementBalance));
      }
      if (Number.isFinite(Number(match.closingXeroBalance))) {
        refAmounts.push(round2(match.closingXeroBalance));
      }
    }
    return { cfgIdx, cfg, refAmounts };
  });

  const assignedByCfgIdx = new Map();
  const usedTermIndices = new Set();

  // Pass 1: exact matches (<= 0.05) against accounting statement or ledger balance
  for (const entry of cfgEntries) {
    if (entry.refAmounts.length === 0) continue;
    let bestTermIdx = -1;
    let bestDiff = Infinity;
    for (let tIdx = 0; tIdx < terms.length; tIdx++) {
      if (usedTermIndices.has(tIdx)) continue;
      for (const ref of entry.refAmounts) {
        const diff = Math.abs(terms[tIdx] - ref);
        if (diff <= 0.05 && diff < bestDiff) {
          bestDiff = diff;
          bestTermIdx = tIdx;
        }
      }
    }
    if (bestTermIdx !== -1) {
      usedTermIndices.add(bestTermIdx);
      assignedByCfgIdx.set(entry.cfgIdx, round2(terms[bestTermIdx]));
    }
  }

  // Pass 2: close matches (<= max(500, 5%)) via greedy minimum difference
  const candidates = [];
  for (const entry of cfgEntries) {
    if (assignedByCfgIdx.has(entry.cfgIdx) || entry.refAmounts.length === 0) continue;
    for (let tIdx = 0; tIdx < terms.length; tIdx++) {
      if (usedTermIndices.has(tIdx)) continue;
      for (const ref of entry.refAmounts) {
        const diff = Math.abs(terms[tIdx] - ref);
        const tol = Math.max(500, 0.05 * Math.abs(terms[tIdx]));
        if (diff <= tol) {
          candidates.push({ cfgIdx: entry.cfgIdx, tIdx, diff });
        }
      }
    }
  }
  candidates.sort((a, b) => a.diff - b.diff);
  for (const cand of candidates) {
    if (assignedByCfgIdx.has(cand.cfgIdx) || usedTermIndices.has(cand.tIdx)) continue;
    usedTermIndices.add(cand.tIdx);
    assignedByCfgIdx.set(cand.cfgIdx, round2(terms[cand.tIdx]));
  }

  // Pass 3: remaining unmatched terms -> remaining configured accounts (e.g. off-Xero TAX Bank account)
  const remainingTerms = [];
  for (let tIdx = 0; tIdx < terms.length; tIdx++) {
    if (!usedTermIndices.has(tIdx)) remainingTerms.push(round2(terms[tIdx]));
  }
  let rPtr = 0;
  for (const entry of cfgEntries) {
    if (assignedByCfgIdx.has(entry.cfgIdx) && assignedByCfgIdx.get(entry.cfgIdx) !== undefined) continue;
    if (rPtr < remainingTerms.length) {
      assignedByCfgIdx.set(entry.cfgIdx, remainingTerms[rPtr++]);
    }
  }

  return cashAccounts.map((cfg, cfgIdx) => ({
    name: cfg.name,
    accountId: cfg.accountId || "",
    amount: assignedByCfgIdx.get(cfgIdx) ?? 0,
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage:\n" +
        "  node --env-file=.env.local scripts/backfill-cash-bank-breakdowns.mjs --dry-run\n" +
        '  node --env-file=.env.local scripts/backfill-cash-bank-breakdowns.mjs --dry-run --client="Eleven"\n' +
        "  node --env-file=.env.local scripts/backfill-cash-bank-breakdowns.mjs --apply\n"
    );
    return;
  }

  if (!isSupabaseConfigured()) {
    throw new Error("Supabase environment variables are not configured.");
  }
  const sb = getSupabaseAdmin();
  const sheets = await getSheetsClient();

  console.log(`Mode: ${args.apply ? "APPLY (writing to Supabase)" : "DRY-RUN (no writes)"}`);
  console.log(`Target months: ${args.targetMonths.join(", ")}`);

  const { data: allClients, error } = await sb
    .from("clients")
    .select("client_name, status, client_mode, master_sheet_id, client_sheet_id, metadata")
    .order("client_name", { ascending: true });

  if (error) throw new Error(`Failed to fetch clients: ${error.message}`);

  const activeClients = (allClients || []).filter((c) => {
    const st = String(c.metadata?.statusOverride || c.status || "live").trim().toLowerCase();
    if (["inactive", "archived", "suspended"].includes(st)) return false;
    if (args.client && c.client_name.toLowerCase() !== args.client.toLowerCase()) return false;
    return true;
  });

  const targetSet = new Set(args.targetMonths);
  let totalProcessed = 0;
  let totalSkippedExisting = 0;
  let totalMismatches = 0;

  for (const clientRow of activeClients) {
    const clientName = clientRow.client_name;
    const { cashVals, cashForms, kiVals } = await fetchClientCashAndKeyInfo(sb, sheets, clientRow);
    const { cashAccounts, nonCashAccounts } = extractKeyInfoBankConfig(kiVals);

    const hdrRow = cashVals[0] || [];
    const row36Vals = cashVals[35] || [];
    const row36Forms = cashForms[35] || [];

    const populatedMonths = [];
    for (let c = 1; c < hdrRow.length; c++) {
      const mKey = parseCellMonthKey(hdrRow[c]);
      if (!mKey || !targetSet.has(mKey)) continue;
      const rawVal = row36Vals[c];
      if (rawVal === "" || rawVal === null || rawVal === undefined) continue;
      const numVal = round2(parseYear0Number(rawVal));
      const formula = typeof row36Forms[c] === "string" ? row36Forms[c] : "";
      populatedMonths.push({ colIdx: c, monthKey: mKey, numVal, formula });
    }

    if (populatedMonths.length === 0) {
      console.log(`\n[${clientName}] No populated Row 36 cells in target months.`);
      continue;
    }

    const existing = await getClientCashBankBreakdowns(clientName);
    let auth = null;
    try {
      const mId = clientRow.master_sheet_id || `sb-master-${normalizeStr(clientName)}`;
      auth = await resolveAccountingToolAuth(clientName, mId);
    } catch {
      auth = null;
    }

    let bankAccountsMeta = [];
    if (auth?.tool === "Xero") {
      bankAccountsMeta = await fetchXeroBankAccounts(auth.accessToken, auth.tenantId).catch(() => []);
    }

    console.log(`\n[${clientName}] tool=${auth?.tool || "None"}, configuredCashAccounts=${cashAccounts.length}`);

    let clientUpdated = false;
    for (const pm of populatedMonths) {
      if (!args.force && existing.months?.[pm.monthKey]) {
        totalSkippedExisting += 1;
        console.log(`  - ${pm.monthKey}: already stored (${existing.months[pm.monthKey].accounts.length} acct(s)) -> skipping`);
        continue;
      }

      let chosen = null;
      let fetchedAcctList = [];

      // 1. Try accounting API first
      if (auth) {
        try {
          await new Promise((r) => setTimeout(r, 250));
          fetchedAcctList = await fetchAccountingMonthAccounts({
            auth,
            bankAccountsMeta,
            bounds: monthBounds(pm.monthKey),
            cashAccounts,
            nonCashAccounts,
          });
          if (fetchedAcctList.length > 0) {
            const stmtTotal = round2(
              fetchedAcctList.reduce(
                (s, a) => s + (a.hasStatementBalance ? Number(a.statementBalance || 0) : Number(a.closingXeroBalance || 0)),
                0
              )
            );
            const ledgTotal = round2(
              fetchedAcctList.reduce((s, a) => s + Number(a.closingXeroBalance || 0), 0)
            );
            if (Math.abs(stmtTotal - pm.numVal) <= 0.05) {
              chosen = {
                source: "accounting_backfill",
                basis: "statement",
                total: pm.numVal,
                accounts: fetchedAcctList.map((a) => ({
                  name: a.accountName,
                  accountId: a.accountId || "",
                  amount: a.hasStatementBalance ? round2(a.statementBalance) : round2(a.closingXeroBalance),
                })),
              };
            } else if (Math.abs(ledgTotal - pm.numVal) <= 0.05) {
              chosen = {
                source: "accounting_backfill",
                basis: "ledger",
                total: pm.numVal,
                accounts: fetchedAcctList.map((a) => ({
                  name: a.accountName,
                  accountId: a.accountId || "",
                  amount: round2(a.closingXeroBalance),
                })),
              };
            } else {
              console.log(
                `  ! ${pm.monthKey}: Row36=${pm.numVal}, ${auth.tool} stmt=${stmtTotal}, ledg=${ledgTotal} (accts: ${fetchedAcctList.map((a) => `${a.accountName}=${a.hasStatementBalance ? a.statementBalance : a.closingXeroBalance}`).join("; ")})`
              );
            }
          }
        } catch (apiErr) {
          console.log(`  ! ${pm.monthKey}: ${auth.tool} fetch failed (${apiErr.message})`);
        }
      }

      // 2. Fallback: exact Row 36 formula match (cross-matched against accounting balances when available)
      if (!chosen && pm.formula) {
        const parsed = parseRow36FormulaBreakdown(pm.formula, cashAccounts);
        if (parsed && parsed.source === "formula_matched" && Math.abs(parsed.total - pm.numVal) <= 0.05) {
          const termAmounts = parsed.accounts.map((a) => a.amount);
          const crossMatched = fetchedAcctList.length > 0
            ? matchFormulaTermsWithAccounting(termAmounts, cashAccounts, fetchedAcctList)
            : null;
          chosen = {
            source: crossMatched ? "formula_accounting_matched" : "formula_backfill",
            basis: "manual",
            total: pm.numVal,
            accounts: crossMatched || parsed.accounts,
          };
        }
      }

      // 3. Fallback: single configured cash account
      if (!chosen && cashAccounts.length === 1) {
        chosen = {
          source: "single_account_backfill",
          basis: "manual",
          total: pm.numVal,
          accounts: [
            {
              name: cashAccounts[0].name,
              accountId: cashAccounts[0].accountId || "",
              amount: pm.numVal,
            },
          ],
        };
      }

      if (!chosen) {
        totalMismatches += 1;
        console.log(`  x ${pm.monthKey}: UNRESOLVED (Row36=${pm.numVal}, formula="${pm.formula}")`);
        continue;
      }

      const summaryStr = chosen.accounts.map((a) => `${a.name}: ${a.amount}`).join(", ");
      console.log(`  + ${pm.monthKey}: [${chosen.source}/${chosen.basis}] total=${chosen.total} -> { ${summaryStr} }`);
      totalProcessed += 1;

      if (args.apply) {
        await saveClientCashBankBreakdownMonth({
          clientName,
          monthKey: pm.monthKey,
          accounts: chosen.accounts,
          total: chosen.total,
          source: chosen.source,
          basis: chosen.basis,
          updatedBy: "BackfillScript",
        });
        clientUpdated = true;
      }
    }

    if (args.apply && clientUpdated && clientRow.client_sheet_id) {
      await invalidatePmaClientCache(clientRow.client_sheet_id, clientName, ["cash"]).catch(() => {});
    }
  }

  console.log(
    `\nDone. ${args.apply ? "Saved" : "Ready"}: ${totalProcessed}, Skipped existing: ${totalSkippedExisting}, Unresolved/Mismatched: ${totalMismatches}`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
