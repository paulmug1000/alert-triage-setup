/**
 * ============================================================================
 * ACCOUNTING PRE-PULL CHANGE DETECTION SERVICE (services/accountingPreflightService.js)
 * ============================================================================
 * Performs lightweight, fail-open delta checks against Xero and QuickBooks Online
 * before spinning up full Invoice and Expense automation sequences.
 */

import crypto from "crypto";
import { resolveBrokerTokenInProcess } from "./gasRuntime/gasEnvironment.js";

const PREFLIGHT_TIMEOUT_MS = 8000;
const MAX_SKIP_WINDOW_MS = 6 * 3600 * 1000;
const BASELINE_OVERLAP_MS = 60 * 1000;
const QB_MAX_CDC_AGE_MS = 25 * 24 * 3600 * 1000;
const CONSECUTIVE_FAILURES_ALERT_THRESHOLD = 3;
const ALERT_DEDUP_WINDOW_MS = 24 * 3600 * 1000;

export function describeAccountingPreflightFailureReason(reason, rawTool = "Accounting", sequence = "invoice") {
  const r = String(reason || "").trim();
  const tool = String(rawTool || "Accounting").trim() || "Accounting";

  if (r === "missing_xero_tenant_id") {
    return "Missing Xero Tenant ID in KeyInfo!X2 and Vault token metadata";
  }
  if (r.startsWith("xero_inv_http_")) {
    return `Xero sales invoice delta check returned HTTP ${r.replace("xero_inv_http_", "")}`;
  }
  if (r.startsWith("xero_bills_http_")) {
    return `Xero bills delta check returned HTTP ${r.replace("xero_bills_http_", "")}`;
  }
  if (r.startsWith("xero_bank_http_")) {
    return `Xero bank transactions delta check returned HTTP ${r.replace("xero_bank_http_", "")}`;
  }
  if (r.startsWith("xero_jnl_http_")) {
    return `Xero manual journals delta check returned HTTP ${r.replace("xero_jnl_http_", "")}`;
  }
  if (r === "xero_inv_malformed") {
    return "Xero sales invoice delta response did not include an Invoices array";
  }
  if (r === "xero_exp_malformed") {
    return "Xero expense delta response returned a malformed payload";
  }
  if (r === "xero_delta_page_full") {
    return `Xero returned >=100 modified ${sequence === "invoice" ? "invoice" : "expense"} records on page 1`;
  }
  if (r === "invalid_qb_realm_id") {
    return "Missing or non-numeric QuickBooks Realm ID in KeyInfo!X3";
  }
  if (r.startsWith("qb_cdc_http_")) {
    return `QuickBooks Change Data Capture (CDC) preflight returned HTTP ${r.replace("qb_cdc_http_", "")}`;
  }
  if (r === "qb_since_too_old") {
    return "QuickBooks baseline timestamp exceeded the 25-day CDC window";
  }
  if (r.startsWith("token_unavailable_")) {
    const status = r.replace("token_unavailable_", "");
    return `OAuth token unavailable from Vault for ${tool} (status ${status})`;
  }
  if (r === "unsupported_accounting_tool") {
    return `Unrecognized accounting tool "${tool}" in KeyInfo!Q4`;
  }
  return `${tool} ${sequence} preflight check failed (${r || "unknown"})`;
}

function cleanCell_(v) {
  return String(v ?? "").trim().replace(/^'+/, "");
}

function sliceGridRect_(grid, rStart, rEnd, cStart, cEnd) {
  if (!Array.isArray(grid)) return [];
  const out = [];
  for (let r = rStart; r <= rEnd; r++) {
    const row = Array.isArray(grid[r]) ? grid[r] : [];
    const slice = [];
    for (let c = cStart; c <= cEnd; c++) {
      slice.push(row[c] ?? "");
    }
    out.push(slice);
  }
  return out;
}

function formatUkYmd_(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}${get("month")}${get("day")}`;
}

function formatXeroIfModifiedSince_(sinceMs) {
  return new Date(sinceMs).toISOString().slice(0, 19);
}

function normalizeAccountingToolKey_(rawTool) {
  const s = String(rawTool || "").trim().toLowerCase();
  if (!s || s === "none" || s === "na") return "";
  if (s.includes("xero")) return "xero";
  if (s.includes("quickbook") || s === "qb") return "quickbooks";
  return s;
}

async function fetchWithTimeout_(url, options = {}, timeoutMs = PREFLIGHT_TIMEOUT_MS) {
  const res = await fetch(url, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = res.status === 304 ? null : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function sha256Hex_(val, len = 16) {
  return crypto.createHash("sha256").update(JSON.stringify(val)).digest("hex").slice(0, len);
}

/**
 * Deterministic hash of Invoice-sequence configuration across KeyInfo and DataChgAlert
 * so any mapping/rule edit invalidates the skip baseline immediately.
 */
export function computeInvoiceSettingsHash({ keyInfoGrid = [], dcaGrid = [] } = {}) {
  const payload = {
    keyInfoB2: keyInfoGrid?.[1]?.[1] ?? "", // B2
    keyInfoModes: [
      keyInfoGrid?.[14]?.[1] ?? "", // B15
      keyInfoGrid?.[16]?.[1] ?? "", // B17
      keyInfoGrid?.[7]?.[5] ?? "",  // F8 (Whole / Lines)
    ],
    keyInfoD: sliceGridRect_(keyInfoGrid, 10, 15, 3, 3),   // D11:D16
    keyInfoQ4: keyInfoGrid?.[3]?.[16] ?? "",               // Q4
    keyInfoX: sliceGridRect_(keyInfoGrid, 1, 4, 23, 23),   // X2:X5
    dcaInvRules: sliceGridRect_(dcaGrid, 37, 44, 0, 8),    // A38:I45
    dcaInvOpts: sliceGridRect_(dcaGrid, 46, 52, 1, 1),     // B47:B53
  };
  return sha256Hex_(payload, 16);
}

/**
 * Deterministic hash of Expense-sequence configuration across KeyInfo and DataChgAlert
 * so any category, mapping, or rule edit invalidates the skip baseline immediately.
 */
export function computeExpenseSettingsHash({ keyInfoGrid = [], dcaGrid = [] } = {}) {
  const payload = {
    keyInfoB2: keyInfoGrid?.[1]?.[1] ?? "", // B2
    keyInfoModes: [
      keyInfoGrid?.[14]?.[1] ?? "", // B15
      keyInfoGrid?.[16]?.[1] ?? "", // B17
      keyInfoGrid?.[19]?.[1] ?? "", // B20
      keyInfoGrid?.[7]?.[3] ?? "",  // D8
      keyInfoGrid?.[0]?.[6] ?? "",  // G1
    ],
    keyInfoQ4: keyInfoGrid?.[3]?.[16] ?? "",               // Q4
    keyInfoX: sliceGridRect_(keyInfoGrid, 1, 4, 23, 23),   // X2:X5
    keyInfoAT: sliceGridRect_(keyInfoGrid, 3, 39, 45, 45), // AT4:AT40
    dcaSharedOpts: sliceGridRect_(dcaGrid, 46, 52, 1, 1),  // B47:B53
    dcaExpModes: sliceGridRect_(dcaGrid, 100, 106, 1, 1),  // B101:B107
    dcaExpRules: sliceGridRect_(dcaGrid, 109, 118, 0, 10), // A110:K119
  };
  return sha256Hex_(payload, 16);
}

/**
 * Probes Xero or QuickBooks Online for invoice or expense changes since `sinceIso`.
 * Always fails open ({ ok: false, reason }) on errors or ambiguous results.
 */
export async function probeExternalAccountingFingerprint({
  ctx,
  keyInfoGrid,
  sequence = "invoice",
  sinceIso = null,
}) {
  try {
    const rawTool = cleanCell_(keyInfoGrid?.[3]?.[16]); // KeyInfo!Q4
    const lowerTool = rawTool.toLowerCase();
    if (!rawTool || lowerTool === "none" || lowerTool === "na") {
      return { ok: false, reason: "no_accounting_tool" };
    }

    const toolKey = normalizeAccountingToolKey_(rawTool);
    if (toolKey !== "xero" && toolKey !== "quickbooks") {
      return { ok: false, reason: "unsupported_accounting_tool" };
    }

    const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
    if (!Number.isFinite(sinceMs)) {
      return { ok: false, reason: "no_since_baseline" };
    }

    const tokenRes = await resolveBrokerTokenInProcess(ctx, toolKey);
    const accessToken = tokenRes?.status === 200 ? tokenRes?.body?.accessToken : null;
    if (!accessToken) {
      return { ok: false, reason: `token_unavailable_${tokenRes?.status || "err"}` };
    }

    if (toolKey === "xero") {
      const tenantId = cleanCell_(keyInfoGrid?.[1]?.[23]) || String(tokenRes?.body?.tenantId || "").trim();
      if (!tenantId) {
        return { ok: false, reason: "missing_xero_tenant_id" };
      }

      const imsHeader = formatXeroIfModifiedSince_(sinceMs);
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        "If-Modified-Since": imsHeader,
        Accept: "application/json",
      };

      if (sequence === "invoice") {
        const url =
          "https://api.xero.com/api.xro/2.0/Invoices?where=Type%3d%3d%22ACCREC%22&page=1&order=UpdatedDateUTC%20DESC";
        const res = await fetchWithTimeout_(url, { method: "GET", headers });
        if (!res.ok && res.status !== 304) {
          return { ok: false, reason: `xero_inv_http_${res.status}` };
        }
        const invs = res.status === 304 ? [] : res.data?.Invoices;
        if (!Array.isArray(invs)) {
          return { ok: false, reason: "xero_inv_malformed" };
        }
        if (invs.length >= 100) {
          return { ok: false, reason: "xero_delta_page_full" };
        }
        const items = invs
          .map(
            (x) =>
              `${x.InvoiceID || ""}@${x.UpdatedDateUTC || ""}:${x.Status || ""}:${x.AmountPaid ?? ""}:${x.AmountDue ?? ""}:${x.SentToContact ?? ""}`
          )
          .sort();
        const sigHash = items.length === 0 ? "empty" : sha256Hex_(items, 20);
        return {
          ok: true,
          tool: "Xero",
          fingerprint: `xero:inv:${tenantId}:since=${imsHeader}:n=${invs.length}:h=${sigHash}`,
        };
      }

      const [billsRes, bankRes, jnlRes] = await Promise.all([
        fetchWithTimeout_(
          "https://api.xero.com/api.xro/2.0/Invoices?where=Type%3d%3d%22ACCPAY%22&page=1&order=UpdatedDateUTC%20DESC",
          { method: "GET", headers }
        ),
        fetchWithTimeout_(
          "https://api.xero.com/api.xro/2.0/BankTransactions?where=Type%3d%3d%22SPEND%22&page=1&order=UpdatedDateUTC%20DESC",
          { method: "GET", headers }
        ),
        fetchWithTimeout_(
          "https://api.xero.com/api.xro/2.0/ManualJournals?where=Status%3d%3d%22POSTED%22&page=1&order=UpdatedDateUTC%20DESC",
          { method: "GET", headers }
        ),
      ]);

      if (!billsRes.ok && billsRes.status !== 304) {
        return { ok: false, reason: `xero_bills_http_${billsRes.status}` };
      }
      if (!bankRes.ok && bankRes.status !== 304) {
        return { ok: false, reason: `xero_bank_http_${bankRes.status}` };
      }

      let jnls = [];
      let jnlTag = null;
      if (jnlRes.status === 401 || jnlRes.status === 403) {
        jnlTag = "noscope";
      } else if (!jnlRes.ok && jnlRes.status !== 304) {
        return { ok: false, reason: `xero_jnl_http_${jnlRes.status}` };
      } else if (jnlRes.status !== 304) {
        jnls = jnlRes.data?.ManualJournals;
      }

      const bills = billsRes.status === 304 ? [] : billsRes.data?.Invoices;
      const banks = bankRes.status === 304 ? [] : bankRes.data?.BankTransactions;
      if (!Array.isArray(bills) || !Array.isArray(banks) || !Array.isArray(jnls)) {
        return { ok: false, reason: "xero_exp_malformed" };
      }
      if (bills.length >= 100 || banks.length >= 100 || jnls.length >= 100) {
        return { ok: false, reason: "xero_delta_page_full" };
      }

      const items = [
        ...bills.map(
          (b) =>
            `bill:${b.InvoiceID || ""}@${b.UpdatedDateUTC || ""}:${b.Status || ""}:${b.AmountPaid ?? ""}:${b.AmountDue ?? ""}`
        ),
        ...banks.map(
          (t) =>
            `bank:${t.BankTransactionID || ""}@${t.UpdatedDateUTC || ""}:${t.Status || ""}:${t.Total ?? ""}`
        ),
        ...jnls.map(
          (j) => `jnl:${j.ManualJournalID || ""}@${j.UpdatedDateUTC || ""}:${j.Status || ""}`
        ),
      ].sort();
      const sigHash = items.length === 0 ? "empty" : sha256Hex_(items, 20);
      return {
        ok: true,
        tool: "Xero",
        fingerprint: `xero:exp:${tenantId}:since=${imsHeader}:b=${bills.length}:t=${banks.length}:j=${jnlTag || jnls.length}:h=${sigHash}`,
      };
    }

    // QuickBooks Online CDC endpoint
    const realmId =
      cleanCell_(keyInfoGrid?.[2]?.[23]) ||
      String(tokenRes?.body?.realmId || tokenRes?.body?.tenantId || "").trim();
    if (!/^\d{1,30}$/.test(realmId)) {
      return { ok: false, reason: "invalid_qb_realm_id" };
    }
    if (Date.now() - sinceMs > QB_MAX_CDC_AGE_MS) {
      return { ok: false, reason: "qb_since_too_old" };
    }

    const changedSinceIso = new Date(sinceMs).toISOString();
    const entities =
      sequence === "invoice"
        ? "Invoice,CreditMemo,Payment"
        : "Bill,Purchase,VendorCredit,BillPayment,JournalEntry";
    const cdcUrl = `https://quickbooks.api.intuit.com/v3/company/${realmId}/cdc?entities=${encodeURIComponent(entities)}&changedSince=${encodeURIComponent(changedSinceIso)}`;

    const res = await fetchWithTimeout_(cdcUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok || !res.data || res.data.Fault) {
      return { ok: false, reason: `qb_cdc_http_${res.status}` };
    }

    const items = [];
    const cdcResponses = Array.isArray(res.data?.CDCResponse) ? res.data.CDCResponse : [];
    for (const block of cdcResponses) {
      const qrList = Array.isArray(block?.QueryResponse) ? block.QueryResponse : [];
      for (const qr of qrList) {
        if (!qr || typeof qr !== "object") continue;
        for (const [entityKey, arr] of Object.entries(qr)) {
          if (!Array.isArray(arr)) continue;
          for (const it of arr) {
            items.push(
              `${entityKey}:${it?.Id || ""}@${it?.status || ""}:${it?.MetaData?.LastUpdatedTime || ""}:${it?.Balance ?? ""}`
            );
          }
        }
      }
    }
    items.sort();
    const seqCode = sequence === "invoice" ? "inv" : "exp";
    const sigHash = items.length === 0 ? "empty" : sha256Hex_(items, 20);
    return {
      ok: true,
      tool: "QuickBooks",
      fingerprint: `qb:${seqCode}:${realmId}:since=${changedSinceIso}:n=${items.length}:h=${sigHash}`,
    };
  } catch (err) {
    return { ok: false, reason: `exception:${err?.message || "unknown"}` };
  }
}

/**
 * Evaluates whether a scheduled Invoice or Expense run can be safely skipped
 * when neither external accounting data nor local Pulse sheets/settings changed.
 */
export async function evaluateScheduledAccountingPreflight({
  ctx,
  sequence = "invoice",
  schedRow,
  keyInfoGrid,
  dcaGrid,
  maxLocalUpdatedMs = 0,
}) {
  const preflightKey = sequence === "invoice" ? "inv_preflight" : "exp_preflight";
  const statusKey = sequence === "invoice" ? "inv_status" : "exp_status";
  const prevPreflight = schedRow?.flags?.[preflightKey] || null;

  if (!prevPreflight?.fingerprint || !prevPreflight?.fullSyncedAt || !prevPreflight?.baselineSinceIso) {
    return { decision: "sync", reason: "no_baseline" };
  }

  if (String(schedRow?.[statusKey] || "").trim().toLowerCase().startsWith("error")) {
    return { decision: "sync", reason: "retry_error_status" };
  }

  const fullSyncedMs = new Date(prevPreflight.fullSyncedAt).getTime();
  if (!Number.isFinite(fullSyncedMs) || Date.now() - fullSyncedMs >= MAX_SKIP_WINDOW_MS) {
    return { decision: "sync", reason: "periodic_6h_reconcile" };
  }

  if (formatUkYmd_(fullSyncedMs) !== formatUkYmd_(Date.now())) {
    return { decision: "sync", reason: "daily_uk_rollover" };
  }

  const currentSettingsHash =
    sequence === "invoice"
      ? computeInvoiceSettingsHash({ keyInfoGrid, dcaGrid })
      : computeExpenseSettingsHash({ keyInfoGrid, dcaGrid });
  if (prevPreflight.settingsHash && currentSettingsHash !== prevPreflight.settingsHash) {
    return { decision: "sync", reason: `${sequence}_settings_changed` };
  }

  const completedMs = new Date(prevPreflight.completedAt || prevPreflight.fullSyncedAt).getTime();
  if (maxLocalUpdatedMs > 0 && Number.isFinite(completedMs) && maxLocalUpdatedMs > completedMs + 5000) {
    return { decision: "sync", reason: "local_sheets_edited" };
  }

  const probe = await probeExternalAccountingFingerprint({
    ctx,
    keyInfoGrid,
    sequence,
    sinceIso: prevPreflight.baselineSinceIso,
  });

  if (!probe.ok) {
    return { decision: "sync", reason: `probe_inconclusive:${probe.reason}` };
  }

  if (probe.fingerprint !== prevPreflight.fingerprint) {
    return { decision: "sync", reason: `${sequence}_changed`, probe };
  }

  return {
    decision: "skip_unchanged",
    reason: "unchanged",
    probe,
    currentSettingsHash,
  };
}

/**
 * Captures a fresh preflight baseline immediately after a completed Invoice or Expense sync
 * and emits a deduplicated AutoLog error payload after 3 consecutive preflight failures.
 */
export async function captureAccountingPreflightBaseline({
  ctx,
  sequence = "invoice",
  keyInfoGrid,
  dcaGrid,
  runStartedIso,
  completedAtIso,
  prevPreflight = null,
}) {
  const parsedStart = runStartedIso ? Date.parse(runStartedIso) : NaN;
  const runStartedMs = Number.isFinite(parsedStart) ? parsedStart : Date.now();
  const baselineSinceIso = new Date(runStartedMs - BASELINE_OVERLAP_MS).toISOString();
  const settingsHash =
    sequence === "invoice"
      ? computeInvoiceSettingsHash({ keyInfoGrid, dcaGrid })
      : computeExpenseSettingsHash({ keyInfoGrid, dcaGrid });

  const probe = await probeExternalAccountingFingerprint({
    ctx,
    keyInfoGrid,
    sequence,
    sinceIso: baselineSinceIso,
  });

  if (probe.ok) {
    const nowIso = new Date().toISOString();
    return {
      state: {
        tool: probe.tool,
        fingerprint: probe.fingerprint,
        baselineSinceIso,
        settingsHash,
        fullSyncedAt: runStartedIso,
        completedAt: completedAtIso || nowIso,
        lastCheckedAt: nowIso,
        lastOutcome: "full_sync",
        consecutiveFailures: 0,
        lastFailureReason: null,
        lastAlertedReason: null,
        lastAlertedAt: null,
      },
      autoLogError: null,
    };
  }

  if (probe.reason === "no_accounting_tool") {
    return { state: null, autoLogError: null };
  }

  const rawTool = cleanCell_(keyInfoGrid?.[3]?.[16]) || "Accounting";
  const prevFailures = Number(prevPreflight?.consecutiveFailures || 0);
  const consecutiveFailures = Number.isFinite(prevFailures) ? prevFailures + 1 : 1;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const prevAlertedAtMs = prevPreflight?.lastAlertedAt ? Date.parse(prevPreflight.lastAlertedAt) : NaN;
  const alreadyAlertedRecently =
    prevPreflight?.lastAlertedReason === probe.reason &&
    Number.isFinite(prevAlertedAtMs) &&
    nowMs - prevAlertedAtMs < ALERT_DEDUP_WINDOW_MS;
  const shouldWriteAutoLog =
    consecutiveFailures >= CONSECUTIVE_FAILURES_ALERT_THRESHOLD && !alreadyAlertedRecently;
  const humanReason = describeAccountingPreflightFailureReason(probe.reason, rawTool, sequence);
  const isInv = sequence === "invoice";
  const seqTitle = isInv ? "Invoice" : "Expense";

  return {
    state: {
      ...(prevPreflight && typeof prevPreflight === "object" ? prevPreflight : {}),
      tool: rawTool,
      fingerprint: null,
      baselineSinceIso,
      settingsHash,
      fullSyncedAt: runStartedIso,
      completedAt: completedAtIso || nowIso,
      lastCheckedAt: nowIso,
      lastOutcome: "preflight_failed",
      consecutiveFailures,
      lastFailureReason: probe.reason,
      lastAlertedReason: shouldWriteAutoLog ? probe.reason : (prevPreflight?.lastAlertedReason || null),
      lastAlertedAt: shouldWriteAutoLog ? nowIso : (prevPreflight?.lastAlertedAt || null),
    },
    autoLogError: shouldWriteAutoLog
      ? {
          category: isInv ? "INVOICES" : "EXPENSES",
          summary: `Error: ${seqTitle} Preflight Check`,
          details: `Error: ${seqTitle} Preflight Check - Pre-pull change detection failed ${consecutiveFailures} consecutive times: ${humanReason}. Full ${sequence} sync still succeeded, so accounting data is up to date, but fast-skip optimization is inactive until resolved.`,
        }
      : null,
  };
}
