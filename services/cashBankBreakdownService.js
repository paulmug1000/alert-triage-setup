/**
 * ============================================================================
 * CASH BANK BREAKDOWN SERVICE (services/cashBankBreakdownService.js)
 * ============================================================================
 * Stores, parses, and resolves per-bank-account balance breakdowns for the
 * "Actual closing balance" row (Row 36 on Client Cash) per client and month.
 * ============================================================================
 */

import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";

if (typeof window !== "undefined") {
  throw new Error("SECURITY VIOLATION: services/cashBankBreakdownService.js must never be imported in client-side browser code.");
}

export const CONFIG_KEY_PREFIX = "cash_bank_breakdowns:";
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_ACCOUNTS_PER_MONTH = 30;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

export function normalizeClientKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

export function getBreakdownConfigKey(clientName) {
  const norm = normalizeClientKey(clientName);
  if (!norm || FORBIDDEN_KEYS.has(norm)) return "";
  return `${CONFIG_KEY_PREFIX}${norm}`;
}

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function createSafeMap_() {
  return Object.create(null);
}

function escapeIlikeLocal_(value) {
  return String(value || "").replace(/[\\%_]/g, "\\$&");
}

async function resolveClientBankBalanceMeta_(sb, cleanName) {
  const safeName = String(cleanName || "").trim();
  if (!sb || !safeName) return null;
  try {
    let { data, error } = await sb
      .from("clients")
      .select("id, client_name, inputs_mode, inputs_read_mode, metadata")
      .ilike("client_name", escapeIlikeLocal_(safeName))
      .limit(1)
      .maybeSingle();
    if (error && String(error.message || "").includes("inputs_read_mode")) {
      ({ data, error } = await sb
        .from("clients")
        .select("id, client_name, metadata")
        .ilike("client_name", escapeIlikeLocal_(safeName))
        .limit(1)
        .maybeSingle());
    }
    if (error || !data?.id) return null;
    const inputsMode = String(data.inputs_mode || data.metadata?.inputs_mode || "grid").trim().toLowerCase();
    const inputsReadMode = String(data.inputs_read_mode || data.metadata?.inputs_read_mode || "grid").trim().toLowerCase();
    return {
      id: data.id,
      client_name: data.client_name || safeName,
      inputsMode: inputsMode === "relational" ? "relational" : "grid",
      inputsReadMode: inputsReadMode === "relational" ? "relational" : "grid",
    };
  } catch {
    return null;
  }
}

/**
 * Sanitizes and normalizes an array of per-bank balance entries.
 */
export function sanitizeBreakdownAccounts(accounts = []) {
  if (!Array.isArray(accounts)) return [];
  const clean = [];
  for (const raw of accounts) {
    if (clean.length >= MAX_ACCOUNTS_PER_MONTH) break;
    if (!raw || typeof raw !== "object") continue;
    const name = String(raw.name ?? raw.accountName ?? "").trim().slice(0, 160);
    if (!name || FORBIDDEN_KEYS.has(name) || FORBIDDEN_KEYS.has(name.toLowerCase())) continue;
    const rawAmt = typeof raw.amount === "string"
      ? raw.amount.replace(/[£$€,\s]/g, "")
      : raw.amount;
    const num = Number(rawAmt);
    if (!Number.isFinite(num)) continue;
    const accountId = String(raw.accountId ?? raw.id ?? "").trim().slice(0, 120);
    clean.push({
      name,
      accountId,
      amount: round2(num),
    });
  }
  return clean;
}

/**
 * Builds the sheet cell value or additive formula for Client!Cash Row 36.
 * Returns "" when no accounts exist, 0 when all accounts are zero, a numeric
 * scalar for a single non-zero account, or "=a+b-c" for >= 2 non-zero accounts.
 */
export function buildRow36FormulaFromAccounts(accounts = []) {
  const clean = sanitizeBreakdownAccounts(accounts);
  if (clean.length === 0) return "";

  const nonZero = clean.filter((a) => Math.abs(a.amount) > 0.0001);
  if (nonZero.length === 0) return 0;
  if (nonZero.length === 1) return round2(nonZero[0].amount);

  let expr = "";
  nonZero.forEach((a, idx) => {
    const val = round2(a.amount);
    if (idx === 0) {
      expr += String(val);
    } else if (val < 0) {
      expr += `-${Math.abs(val)}`;
    } else {
      expr += `+${val}`;
    }
  });
  return `=${expr}`;
}

/**
 * Reads all stored monthly bank breakdowns for a client.
 * Reads `pulse_cash_bank_balances` when `inputs_read_mode = 'relational'` (or forced),
 * otherwise reads from `public.system_config` (`cash_bank_breakdowns:*`).
 */
export async function getClientCashBankBreakdowns(clientName, options = {}) {
  const cleanName = String(clientName || "").trim();
  const empty = { clientName: cleanName, months: createSafeMap_() };
  const throwOnError = Boolean(options?.throwOnError);
  if (!cleanName || !isSupabaseConfigured()) {
    if (throwOnError && !isSupabaseConfigured()) throw new Error("Supabase is not configured.");
    return empty;
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    if (throwOnError) throw new Error("Supabase admin client unavailable.");
    return empty;
  }

  const forceSource = options?.forceSource || null; // "system_config" | "relational" | null
  const forceMode = options?._forceInputsReadMode || null; // "grid" | "relational" | null

  try {
    let useRelational = false;
    let clRow = null;
    if (forceSource === "relational" || forceMode === "relational") {
      clRow = await resolveClientBankBalanceMeta_(sb, cleanName);
      useRelational = Boolean(clRow?.id);
    } else if (!forceSource && forceMode !== "grid") {
      clRow = await resolveClientBankBalanceMeta_(sb, cleanName);
      useRelational = Boolean(clRow?.id && clRow.inputsMode === "relational" && clRow.inputsReadMode === "relational");
    }

    if (useRelational && clRow?.id) {
      const { data: relRows, error: relErr } = await sb
        .from("pulse_cash_bank_balances")
        .select("period_ym, source, basis, total_balance, accounts, updated_at, updated_by")
        .eq("client_id", clRow.id);

      if (relErr && throwOnError) {
        throw new Error(`pulse_cash_bank_balances read failed: ${relErr.message}`);
      }
      if (!relErr && Array.isArray(relRows)) {
        const months = createSafeMap_();
        for (const row of relRows) {
          const mKey = String(row?.period_ym || "").trim();
          if (!mKey || FORBIDDEN_KEYS.has(mKey) || !MONTH_KEY_RE.test(mKey)) continue;
          const cleanAccounts = sanitizeBreakdownAccounts(row.accounts);
          if (cleanAccounts.length === 0) continue;
          const computedTotal = round2(cleanAccounts.reduce((s, a) => s + a.amount, 0));
          months[mKey] = {
            monthKey: mKey,
            source: String(row.source || "manual"),
            basis: String(row.basis || "manual"),
            total: Number.isFinite(Number(row.total_balance)) ? round2(row.total_balance) : computedTotal,
            accounts: cleanAccounts,
            updatedAt: row.updated_at || null,
            updatedBy: row.updated_by || "",
          };
        }
        return {
          clientName: String(clRow.client_name || cleanName),
          months,
        };
      }
    }

    const configKey = getBreakdownConfigKey(cleanName);
    if (!configKey) return empty;

    const { data, error } = await sb
      .from("system_config")
      .select("value")
      .eq("key", configKey)
      .maybeSingle();

    if (error) {
      if (throwOnError) {
        throw new Error(`system_config cash breakdown load failed (${cleanName}): ${error.message}`);
      }
      return empty;
    }
    if (!data?.value || typeof data.value !== "object") {
      return empty;
    }

    const months = createSafeMap_();
    const rawMonths = data.value.months;
    if (rawMonths && typeof rawMonths === "object" && !Array.isArray(rawMonths)) {
      for (const [mKey, entry] of Object.entries(rawMonths)) {
        if (FORBIDDEN_KEYS.has(mKey) || !MONTH_KEY_RE.test(mKey)) continue;
        if (!entry || typeof entry !== "object") continue;
        const cleanAccounts = sanitizeBreakdownAccounts(entry.accounts);
        if (cleanAccounts.length === 0) continue;
        const computedTotal = round2(cleanAccounts.reduce((s, a) => s + a.amount, 0));
        months[mKey] = {
          monthKey: mKey,
          source: String(entry.source || "manual"),
          basis: String(entry.basis || "manual"),
          total: Number.isFinite(Number(entry.total)) ? round2(entry.total) : computedTotal,
          accounts: cleanAccounts,
          updatedAt: entry.updatedAt || null,
          updatedBy: entry.updatedBy || "",
        };
      }
    }

    return {
      clientName: String(data.value.clientName || cleanName),
      months,
    };
  } catch (err) {
    if (throwOnError) throw err;
    console.warn("[cashBankBreakdownService] Read warning:", err.message);
    return empty;
  }
}

/**
 * Persists a single month's named bank balance breakdown for a client
 * (writes system_config and dual-writes public.pulse_cash_bank_balances).
 */
export async function saveClientCashBankBreakdownMonth({
  clientName,
  monthKey,
  accounts = [],
  total = null,
  source = "manual",
  basis = "manual",
  updatedBy = "System",
}) {
  const cleanName = String(clientName || "").trim();
  const cleanMonth = String(monthKey || "").trim();
  if (!cleanName) throw new Error("Client name is required to save bank breakdown.");
  if (!MONTH_KEY_RE.test(cleanMonth)) {
    throw new Error("Invalid monthKey: expected YYYY-MM format.");
  }

  const configKey = getBreakdownConfigKey(cleanName);
  if (!configKey) throw new Error("Invalid client name for bank breakdown key.");

  const cleanAccounts = sanitizeBreakdownAccounts(accounts);
  if (cleanAccounts.length === 0) {
    throw new Error("At least one valid bank account balance is required.");
  }

  const computedTotal = round2(cleanAccounts.reduce((s, a) => s + a.amount, 0));
  const finalTotal =
    total !== null && total !== undefined && total !== "" && Number.isFinite(Number(total))
      ? round2(total)
      : computedTotal;

  const sb = getSupabaseAdmin();
  if (!sb) {
    throw new Error("Supabase is not configured.");
  }

  const existing = await getClientCashBankBreakdowns(cleanName, { forceSource: "system_config" });
  const nextMonths = {};
  for (const [k, v] of Object.entries(existing.months || {})) {
    if (FORBIDDEN_KEYS.has(k) || !MONTH_KEY_RE.test(k)) continue;
    nextMonths[k] = v;
  }

  const nowIso = new Date().toISOString();
  const entry = {
    monthKey: cleanMonth,
    source: String(source || "manual").slice(0, 60),
    basis: String(basis || "manual").slice(0, 40),
    total: finalTotal,
    accounts: cleanAccounts,
    updatedAt: nowIso,
    updatedBy: String(updatedBy || "System").slice(0, 160),
  };
  nextMonths[cleanMonth] = entry;

  const [{ error }, clRow] = await Promise.all([
    sb.from("system_config").upsert({
      key: configKey,
      value: {
        clientName: cleanName,
        updatedAt: nowIso,
        months: nextMonths,
      },
      description: "Per-month bank balance breakdowns for Cash Row 36",
      updated_by: String(updatedBy || "System").slice(0, 160),
    }),
    resolveClientBankBalanceMeta_(sb, cleanName),
  ]);

  if (error) {
    throw new Error(`Failed to save cash bank breakdown: ${error.message}`);
  }

  if (clRow?.id) {
    try {
      const { error: relErr } = await sb
        .from("pulse_cash_bank_balances")
        .upsert(
          {
            client_id: clRow.id,
            client_name: clRow.client_name,
            period_ym: cleanMonth,
            source: entry.source,
            basis: entry.basis,
            total_balance: finalTotal,
            accounts: cleanAccounts,
            updated_by: entry.updatedBy,
          },
          { onConflict: "client_id,period_ym" }
        );
      if (relErr) {
        console.warn("[cashBankBreakdownService] Relational upsert warning:", relErr.message);
      }
    } catch (relEx) {
      console.warn("[cashBankBreakdownService] Relational upsert exception:", relEx?.message);
    }
  }

  return entry;
}

/**
 * Deletes a single month's stored bank balance breakdown for a client
 * across both system_config and public.pulse_cash_bank_balances.
 */
export async function deleteClientCashBankBreakdownMonth({
  clientName,
  monthKey,
  updatedBy = "System",
}) {
  const cleanName = String(clientName || "").trim();
  const cleanMonth = String(monthKey || "").trim();
  if (!cleanName || !MONTH_KEY_RE.test(cleanMonth)) return { deleted: false };

  const configKey = getBreakdownConfigKey(cleanName);
  if (!configKey || !isSupabaseConfigured()) return { deleted: false };

  const sb = getSupabaseAdmin();
  if (!sb) return { deleted: false };

  const [existing, clRow] = await Promise.all([
    getClientCashBankBreakdowns(cleanName, { forceSource: "system_config" }),
    resolveClientBankBalanceMeta_(sb, cleanName),
  ]);

  let relDeleted = false;
  if (clRow?.id) {
    try {
      const { error: delRelErr, count } = await sb
        .from("pulse_cash_bank_balances")
        .delete({ count: "exact" })
        .eq("client_id", clRow.id)
        .eq("period_ym", cleanMonth);
      if (!delRelErr && (count || 0) > 0) relDeleted = true;
    } catch { }
  }

  if (!existing.months || !Object.prototype.hasOwnProperty.call(existing.months, cleanMonth)) {
    return { deleted: relDeleted };
  }

  const nextMonths = {};
  for (const [k, v] of Object.entries(existing.months)) {
    if (FORBIDDEN_KEYS.has(k) || !MONTH_KEY_RE.test(k) || k === cleanMonth) continue;
    nextMonths[k] = v;
  }

  const nowIso = new Date().toISOString();
  const { error } = await sb.from("system_config").upsert({
    key: configKey,
    value: {
      clientName: cleanName,
      updatedAt: nowIso,
      months: nextMonths,
    },
    description: "Per-month bank balance breakdowns for Cash Row 36",
    updated_by: String(updatedBy || "System").slice(0, 160),
  });

  if (error) {
    throw new Error(`Failed to clear cash bank breakdown: ${error.message}`);
  }

  return { deleted: true };
}

/**
 * Parses simple literal additive/subtractive Row 36 formulas (e.g. "=45389.63+12876.42+30000"
 * or "=SUM(100,200)") without allowing cell refs or complex expressions.
 */
export function parseRow36FormulaBreakdown(formula, configuredBankAccounts = []) {
  if (typeof formula !== "string") return null;
  const trimmed = formula.trim();
  if (!trimmed.startsWith("=") || trimmed.length > 500) return null;

  let body = trimmed.slice(1).trim();
  if (!body) return null;

  // Reject any cell references, sheet qualifiers, quotes, or non-SUM functions
  const sumMatch = body.match(/^SUM\s*\(\s*([^()]+)\s*\)$/i);
  let terms = [];
  if (sumMatch) {
    const inner = sumMatch[1];
    if (!/^[+-]?\d+(?:\.\d+)?(?:\s*,\s*[+-]?\d+(?:\.\d+)?)*$/.test(inner.trim())) {
      return null;
    }
    terms = inner.split(",").map((part) => Number(part.trim()));
  } else {
    // Only allow literal numbers joined by + or - (no spaces/cell refs/operators like * or /)
    const compact = body.replace(/\s+/g, "");
    if (!/^[+-]?\d+(?:\.\d+)?(?:[+-]{1,2}\d+(?:\.\d+)?)*$/.test(compact)) {
      return null;
    }
    // Tokenize sequentially so "+-" or "--" or "-" signs attach to the following number
    let idx = 0;
    while (idx < compact.length) {
      let sign = 1;
      while (idx < compact.length && (compact[idx] === "+" || compact[idx] === "-")) {
        if (compact[idx] === "-") sign *= -1;
        idx += 1;
      }
      const start = idx;
      while (idx < compact.length && /[\d.]/.test(compact[idx])) {
        idx += 1;
      }
      if (idx === start) return null;
      const num = Number(compact.slice(start, idx));
      if (!Number.isFinite(num)) return null;
      terms.push(round2(sign * num));
    }
  }

  if (terms.length === 0 || terms.some((n) => !Number.isFinite(n))) {
    return null;
  }

  const configured = Array.isArray(configuredBankAccounts)
    ? configuredBankAccounts.filter((a) => a && String(a.name || "").trim())
    : [];

  const total = round2(terms.reduce((s, n) => s + n, 0));

  if (configured.length > 0 && terms.length === configured.length) {
    return {
      source: "formula_matched",
      basis: "manual",
      labelsInferred: true,
      total,
      accounts: terms.map((amt, idx) => ({
        name: String(configured[idx].name).trim(),
        accountId: String(configured[idx].accountId || "").trim(),
        amount: round2(amt),
      })),
    };
  }

  if (terms.length >= 2) {
    return {
      source: "formula_unlabelled",
      basis: "manual",
      labelsInferred: true,
      total,
      accounts: terms.map((amt, idx) => ({
        name: `Account ${idx + 1}`,
        accountId: "",
        amount: round2(amt),
      })),
    };
  }

  return null;
}

function matchesAmount_(a, b) {
  return typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.05;
}

/**
 * Resolves the effective bank balance breakdown for a Row 36 cell.
 * Priority:
 *   1. Explicitly stored breakdown in Supabase system_config
 *   2. Parsed multi-term or matched Row 36 formula
 *   3. Single configured bank account fallback
 */
export function resolveMonthlyBankBreakdown({
  monthKey,
  cellNumericValue,
  hasCellValue,
  formula,
  storedEntry,
  configuredBankAccounts = [],
}) {
  if (!hasCellValue) return null;

  const cleanNumeric =
    typeof cellNumericValue === "number" && Number.isFinite(cellNumericValue)
      ? round2(cellNumericValue)
      : null;

  if (storedEntry && Array.isArray(storedEntry.accounts) && storedEntry.accounts.length > 0) {
    const cleanAccounts = sanitizeBreakdownAccounts(storedEntry.accounts);
    if (cleanAccounts.length > 0) {
      const storedTotal = round2(cleanAccounts.reduce((s, a) => s + a.amount, 0));
      const matchesCell = cleanNumeric === null ? true : matchesAmount_(storedTotal, cleanNumeric);
      return {
        monthKey: monthKey || storedEntry.monthKey || null,
        source: storedEntry.source || "saved",
        basis: storedEntry.basis || "manual",
        accounts: cleanAccounts,
        total: storedTotal,
        matchesCell,
        cellTotal: cleanNumeric,
        labelsInferred: false,
        updatedAt: storedEntry.updatedAt || null,
      };
    }
  }

  const parsed = parseRow36FormulaBreakdown(formula, configuredBankAccounts);
  if (parsed) {
    return {
      monthKey: monthKey || null,
      ...parsed,
      matchesCell: cleanNumeric === null ? true : matchesAmount_(parsed.total, cleanNumeric),
      cellTotal: cleanNumeric,
      updatedAt: null,
    };
  }

  const configured = Array.isArray(configuredBankAccounts)
    ? configuredBankAccounts.filter((a) => a && String(a.name || "").trim())
    : [];
  if (configured.length === 1 && cleanNumeric !== null) {
    return {
      monthKey: monthKey || null,
      source: "single_account",
      basis: "manual",
      accounts: [
        {
          name: String(configured[0].name).trim(),
          accountId: String(configured[0].accountId || "").trim(),
          amount: cleanNumeric,
        },
      ],
      total: cleanNumeric,
      matchesCell: true,
      cellTotal: cleanNumeric,
      labelsInferred: false,
      updatedAt: null,
    };
  }

  return null;
}
