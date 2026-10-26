import { createHash } from "crypto";
import { extractSheetIdFromUrl, withRetry, getSheetsClient, getSheetId, colIndexToLetter, applySheetFontFormat } from "./sheetsClient.js";
import {
  buildAlertFingerprint, buildAlertFingerprintLegacy, ensureAlertMemoryTab, readAlertMemory,
  readHandledAlertHashes, findMemoryRow, appendAlertMemoryRow, updateAlertMemoryRow,
  deleteAlertMemoryRows, purgeOldAlertMemoryRows, compactAlertMemory, updateHandledAlertHash,
  getHandledFingerprintHashes_, findPreviousIgnoreReason,
  normaliseArrayForFingerprint
} from "./alertMemory.js";
import { handleFireOutgoingsPull, handleMarkExpenseAssigned, getAllClients } from "./workspaces.js";
import { applyAlertRemovalToTriageData } from "./alertState.js";
import {
  checkRetainerInvoices_, checkCRMWipe_, checkRevenueMismatch_, checkDirectCostsMismatch_,
  checkPipelineConfirmedOverlap_, checkRetainerShrinkBlocked_, checkUninvoicedNewJobs_,
  checkUninvoicedRevenue_, checkDeletedInvoices_, checkJobStructureErrors_,
  checkDeletedExpenses_, checkUnreceivedExpenses_, checkAutoLogErrors_, checkAutoLogInfiniteLoops_,
  checkStaleUnreconGapExpenses_, checkRetroactiveOutgoingsChanges_, checkQuarantinedPLCategories_,
  checkPartPaidBalances_
} from "./proactiveChecks.js";
import {
  checkAllGASLocks, setCRMMode, getToleranceValues,
  getCRMMatchingMode, fetchJobRowsForDisplay
} from "./sharedHelpers.js";
import { redisClient } from "./redisClient.js";
import { logPmaActivity } from "./pmaLogger.js";
import { logPrecomputeRun, logFlagSweepRun, logBuildOptionsRun } from "./systemLogs.js";
import { isPlaceholderInvoice, isPlaceholderExpense, parseYearMonth, parseStaleExpenseDetail, isPipelineJobSuppressed, toSheetDateFormat } from "../utils/helpers.js";
import { getSessionUser } from "./authService.js";
import { matchesClientName, getClientManagerClientMap } from "./userPermissions.js";

const ALERT_MEMORY_TAB = "AlertMemory";

export const PRECOMPUTED_KEY = "triage_precomputed";
export const PRECOMPUTED_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours 
export const PMA_TRIAGE_REFRESH_STATUS_KEY = "pulse:triage_refresh_status";

export async function getTriageRefreshStatus() {
  try {
    if (!redisClient?.isOpen) await redisClient.connect();
    const raw = await redisClient.get(PMA_TRIAGE_REFRESH_STATUS_KEY);
    if (!raw) return { status: "idle" };
    const parsed = JSON.parse(raw);
    // Auto-recover if marked as running but has not updated for > 3 minutes (180s)
    if (parsed.status === "running" && Date.now() - (parsed.updatedAt || 0) > 180000) {
      return { status: "stalled", error: "Previous refresh timed out", updatedAt: parsed.updatedAt };
    }
    return parsed;
  } catch (err) {
    console.error("Error reading triage refresh status:", err);
    return { status: "idle" };
  }
}

export async function setTriageRefreshStatus(statusObj, ttlSecs = 600) {
  try {
    if (!redisClient?.isOpen) await redisClient.connect();
    await redisClient.set(PMA_TRIAGE_REFRESH_STATUS_KEY, JSON.stringify(statusObj), { EX: ttlSecs });
  } catch (err) {
    console.error("Error setting triage refresh status:", err);
  }
}

export async function runBackgroundTriageRefresh({
  baseUrl,
  cronSecret,
  automationCommanderSheetId,
  forceProactive = true,
}) {
  const startTime = Date.now();
  console.log(`\n🔄 [Background Refresh] Starting triage pipeline (baseUrl: ${baseUrl})...`);

  try {
    await setTriageRefreshStatus({
      status: "running",
      step: "sweep",
      progress: "Scanning clients (batch 1)...",
      startedAt: startTime,
      updatedAt: Date.now(),
    });

    // Step 1: Sweep all clients in chunks
    let sweepHasMore = true;
    let sweepIdx = 0;
    while (sweepHasMore) {
      const batchNum = Math.floor(sweepIdx / 3) + 1;
      await setTriageRefreshStatus({
        status: "running",
        step: "sweep",
        progress: `Scanning clients (batch ${batchNum})...`,
        startedAt: startTime,
        updatedAt: Date.now(),
      });

      console.log(`  [Background Refresh] Sweep batch ${batchNum} from index ${sweepIdx}...`);
      const sweepResp = await fetch(`${baseUrl}/api/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run_flag_sweep",
          secret: cronSecret,
          automationCommanderSheetId,
          startIdx: sweepIdx,
          forceProactive,
          forceAll: true,
        }),
      });
      const sweepData = await sweepResp.json();
      if (!sweepResp.ok || !sweepData.success) {
        throw new Error(sweepData.error || `Sweep failed on batch ${batchNum}`);
      }
      sweepHasMore = sweepData.hasMore;
      sweepIdx = sweepData.nextIdx;
    }

    // Step 2: Build Options in chunks
    let hasMore = true;
    let buildCount = 1;
    while (hasMore) {
      await setTriageRefreshStatus({
        status: "running",
        step: "build",
        progress: `Generating options (batch ${buildCount})...`,
        startedAt: startTime,
        updatedAt: Date.now(),
      });

      console.log(`  [Background Refresh] Build batch ${buildCount}...`);
      const buildResp = await fetch(`${baseUrl}/api/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "build_cached_alert_options",
          baseUrl,
          secret: cronSecret,
          automationCommanderSheetId,
          isContinuation: buildCount > 1,
        }),
      });
      const buildData = await buildResp.json();
      if (!buildResp.ok || !buildData.success) {
        throw new Error(buildData.error || `Build options failed on batch ${buildCount}`);
      }
      hasMore = buildData.hasMore;
      buildCount++;
    }

    // Step 3: Store Precomputed Data
    await setTriageRefreshStatus({
      status: "running",
      step: "store",
      progress: "Finalizing data...",
      startedAt: startTime,
      updatedAt: Date.now(),
    });

    console.log(`  [Background Refresh] Finalizing precomputed data in Redis...`);
    let existingNoActionAnalysis = {};
    try {
      if (!redisClient?.isOpen) await redisClient.connect();
      const existingRaw = await redisClient.get(PRECOMPUTED_KEY);
      if (existingRaw) existingNoActionAnalysis = JSON.parse(existingRaw).noActionAnalysisResults || {};
    } catch (e) { /* fine */ }

    const storeResp = await fetch(`${baseUrl}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "store_precomputed",
        secret: cronSecret,
        automationCommanderSheetId,
        noActionAnalysisResults: existingNoActionAnalysis,
      }),
    });
    const storeData = await storeResp.json();
    if (!storeResp.ok || !storeData.success) {
      throw new Error(storeData.error || "Store precomputed failed");
    }

    const elapsedS = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ [Background Refresh] Complete in ${elapsedS}s`);

    await setTriageRefreshStatus({
      status: "completed",
      step: "complete",
      progress: "Refresh complete",
      startedAt: startTime,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    }, 300);

    return { success: true, elapsedSeconds: elapsedS };
  } catch (err) {
    console.error("❌ [Background Refresh] Pipeline error:", err);
    await setTriageRefreshStatus({
      status: "error",
      error: err.message || "Refresh failed",
      startedAt: startTime,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    }, 300);
    throw err;
  }
}

let _precomputedMemoryCache = null;
let _precomputedCachedAt = 0;

export const FLAG_NAMES = {
  invoiceDashboardDiscr: "Invoice dashboard discr",
  crmPipeDashDiscr: "CRM pipe dash discr",
  crmPipeAppDiscr: "CRM pipe app discr",
  crmConfDashDiscr: "CRM conf dash discr",
  crmConfAppDiscr: "CRM conf app discr",
  crmCopiedConfChecked: "CRM copied to conf box checked",
  crmCopiedConfUnchecked: "CRM copied to conf box UNchecked",
  crmCopiedConfDelete: "CRM copied to conf box DELETE",
  retainerInvoicesCreated: "Retainer invoices created",
  retainerInvoicesDeleted: "Retainer invoices deleted",
  expenseDashboardDiscr: "Expense dashboard discr",
  expenseAdded: "Expense added",
  expenseUnreconGaps: "Stale unreceived expense date changed",
  invoiceStaleUnsentChanges: "Stale unsent invoice send date changed",
};

export function parseAutomationTime_(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/([A-Za-z]{3})\s+(\d{1,2})-([A-Za-z]{3})\s+(\d{2}):(\d{2})/);
  if (!m) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  const day = parseInt(m[2], 10);
  const monthStr = m[3].toLowerCase();
  const hrs = parseInt(m[4], 10);
  const mins = parseInt(m[5], 10);
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const month = months[monthStr];
  if (month === undefined) return 0;

  const now = new Date();
  let year = now.getFullYear();
  if (month === 11 && now.getMonth() === 0) year--;
  else if (month === 0 && now.getMonth() === 11) year++;

  const guessedUtc = new Date(Date.UTC(year, month, day, hrs, mins, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/London',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  }).formatToParts(guessedUtc);

  const p = {};
  parts.forEach(part => { if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10); });
  const londonTimeMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  const offsetMs = londonTimeMs - guessedUtc.getTime();

  return guessedUtc.getTime() - offsetMs;
}

export function evaluateAutomationStatus_(alertType, category, clientMeta, detectedAtMs, firstSeenMs) {
  if (category !== "discrepancy" && category !== "proactive") return "cached";
  if (!clientMeta) return "cached";

  const baseTimeMs = detectedAtMs || firstSeenMs;
  const nowMs = Date.now();
  if ((nowMs - baseTimeMs) > 16 * 60 * 60 * 1000) return "cached";

  const invoiceDependent = ["revenue_mismatch", "retainer_invoice", "uninvoiced_revenue", "deleted_invoice"];
  const expenseDependent = ["direct_costs_mismatch", "deleted_expense", "unreceived_expenses", "stale_unrecon_gap"];

  let autoLastRun = 0;
  if (alertType.startsWith("invoice") || invoiceDependent.includes(alertType)) {
    autoLastRun = clientMeta.invAutoLastRunMs;
  } else if (alertType.startsWith("crm")) {
    autoLastRun = clientMeta.crmAutoLastRunMs;
  } else if (alertType.startsWith("expense") || expenseDependent.includes(alertType)) {
    autoLastRun = clientMeta.expAutoLastRunMs;
  } else {
    return "cached";
  }

  if (autoLastRun === 0) return "cached";
  if (autoLastRun >= (baseTimeMs - 60000)) return "cached";

  return "pending_automation";
}

export async function readAutoUpdatesClientRows_(sheets, automationCommanderSheetId) {
  const mainResponse = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: automationCommanderSheetId,
    range: "AutoUpdates!A2:AJ1000",
  }));
  const rows = mainResponse.data.values || [];
  console.log(`📊 Total rows: ${rows.length}`);

  const clientRows = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sheetRowNum = i + 2;

    if (!row || row.length < 13) continue;

    const clientName = String(row[0] || "").trim();
    const scriptId = String(row[10] || "").trim();
    const clientSheetUrl = row[11];
    const masterSheetUrl = row[12];
    const hasWebAppUrl = !!String(row[13] || "").trim();

    if (!clientName || !clientSheetUrl || !masterSheetUrl) continue;
    if (clientName.toLowerCase() === "client" || clientName.toLowerCase() === "client name") continue;

    const clientId = extractSheetIdFromUrl(clientSheetUrl);
    const masterId = extractSheetIdFromUrl(masterSheetUrl);
    if (!clientId || !masterId) continue;

    clientRows.push({
      rowIndex: i,
      sheetRowNum,
      clientName,
      clientSheetId: clientId,
      masterSheetId: masterId,
      clientSheetUrl: String(clientSheetUrl),
      masterSheetUrl: String(masterSheetUrl),
      scriptId,
      hasWebAppUrl,
      invAutoLastRunMs: parseAutomationTime_(row[24]),
      crmAutoLastRunMs: parseAutomationTime_(row[29]),
      expAutoLastRunMs: parseAutomationTime_(row[34]),
    });
  }
  return { rows, clientRows };
}

export function buildInvCompSummary(alert) {
  const accounting = alert.data.accounting || [];
  const client = accounting[0] || '(unknown)';
  const job = accounting[1] || '';

  const invoiceAmount = parseFloat(String(accounting[2] || '0').replace(/,/g, '')) || 0;
  const totalExclVAT = parseFloat(String(accounting[3] || '0').replace(/,/g, '')) || 0;
  const vatIncluded = parseFloat(String(accounting[4] || '0').replace(/,/g, '')) || 0;

  const invoiceNo = accounting[5] || '(no reference)';
  const sentDate = accounting[6] || '';
  const datePaid = accounting[8] || '';
  const status = accounting[9] || '';
  const currency = accounting[10] || 'GBP';

  const amount = totalExclVAT > 0 ? totalExclVAT : invoiceAmount;
  let vatSuffix = '';
  if (vatIncluded && vatIncluded > 0) vatSuffix = ' + VAT';

  const formattedAmount = amount > 0
    ? `${currency}${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${vatSuffix}`
    : 'unknown amount';

  let summary = `Invoice ${invoiceNo} • ${formattedAmount} • ${client}`;
  if (job) summary += ` • ${job}`;
  if (sentDate) summary += ` • Sent ${sentDate}`;
  if (status) summary += ` • ${status}`;

  return { invoiceNo, amount, vatIncluded, currency, client, job, sentDate, datePaid, status, summary };
}

export function buildDirCompSummary(alert) {
  const accounting = alert.data.accounting || [];
  const date = accounting[0] || '';
  const description = accounting[1] || '';
  const amount = parseFloat(String(accounting[2] || '0').replace(/,/g, '')) || 0;
  const reference = accounting[3] || '';
  const accountName = accounting[4] || '';
  const status = accounting[5] || '';
  const transactionId = accounting[6] || '';
  const datePaid = accounting[7] || '';
  const vatAmount = accounting[8] || '';

  const formattedAmount = amount > 0
    ? `£${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '£0.00';

  let summary = `Expense ${reference || date} • ${formattedAmount}`;
  if (description) summary += ` • ${description}`;
  if (accountName) summary += ` • ${accountName}`;
  if (date) summary += ` • ${date}`;

  return { reference, amount, description, date, accountName, status, transactionId, datePaid, vatAmount, summary };
}

export const AUTOLOG_TYPE_PATTERNS = {
  retainerInvoicesCreated: ["[Retainers - Confirmed] Added"],
  retainerInvoicesDeleted: ["[Retainers - Confirmed] Trimmed"],
  expenseUnreconGaps: [
    "Rec Date updated", "Updated stale placeholder date", "Updated stale Placeholder/Gap date", "Stale Expense - Row"
  ],
  expenseAdded: ["Created New Row:"],
  invoiceStaleUnsentChanges: ["Stale Invoice - Row"],
  crmCopiedConfChecked: [
    "Copied Pipeline Project to Confirmed:",
    "Copied Pipeline Project (with",
    "Converted Pipeline Job to Confirmed Retainer:",
  ],
  crmCopiedConfUnchecked: ["Copied Status: 'Yes' -> 'No' (Reverted by Source)"],
  crmCopiedConfDelete: ["Deleted Confirmed Job: Row"],
};

export async function readRecentAutoLogEntries_(sheets, masterSheetId, limit = 30, cachedData = null) {
  try {
    let rows = [];
    if (cachedData) {
      rows = cachedData.slice(0, limit);
    } else {
      const resp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: `AutoLog!A2:D${limit + 1}`,
      }));
      rows = resp.data.values || [];
    }
    return rows.map(row => ({
      timestamp: row[0] || "",
      category: row[1] || "",
      summary: row[2] || "",
      details: row[3] || "",
    }));
  } catch (err) {
    return [];
  }
}

export async function readInvCompAlerts(sheets, spreadsheetId, cachedData = null) {
  try {
    console.log(`\n📖 Reading InvComp alerts from ${spreadsheetId}...`);
    let allRows = [];
    if (cachedData && cachedData.length > 0) {
      allRows = cachedData;
      // If cachedData only had columns A to Y, fetch right-hand columns AT to BD
      if (allRows[0] && allRows[0].length < 51) {
        try {
          const rightResp = await withRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId, range: "InvComp!AT5:BD1000",
          }));
          const rightRows = rightResp.data.values || [];
          for (let i = 0; i < allRows.length; i++) {
            const rRow = rightRows[i] || [];
            while (allRows[i].length < 45) allRows[i].push("");
            for (let j = 0; j < rRow.length; j++) {
              allRows[i][45 + j] = rRow[j];
            }
          }
        } catch (e) {
          console.warn("Could not fetch right columns for InvComp cachedData:", e.message);
        }
      }
    } else {
      const dataResponse = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId, range: "InvComp!A5:BD1000",
      }));
      allRows = dataResponse.data.values || [];
    }
    const headers = allRows[0] || [];
    const rows = allRows.slice(1);

    // Index all spreadsheet items from columns AT through BD (col 45 to 55)
    // AT: Client (45), AU: Job (46), AV: Invoice amount gross (47), AW: Total excl VAT net (48),
    // AX: VAT included (49), AY: Invoice no (50), AZ: Sent date (51), BA: Pay date (52),
    // BB: Status (53), BC: InvSeq (54), BD: CellRef (55)
    const spreadsheetItemsByInv = {};
    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      if (!row || row.length <= 50) continue;
      const sInvNo = String(row[50] || "").trim();
      if (!sInvNo || sInvNo === "(blank)" || sInvNo === "-") continue;
      const key = sInvNo.toLowerCase();
      const strippedKey = key.replace(/^#/, "");
      const itemData = {
        invCompRow: 6 + rIdx,
        client: String(row[45] || "").trim(),
        job: String(row[46] || "").trim(),
        grossAmount: parseFloat(String(row[47] || "0").replace(/,/g, "")) || 0,
        netAmount: parseFloat(String(row[48] || "0").replace(/,/g, "")) || 0,
        vatAmount: parseFloat(String(row[49] || "0").replace(/,/g, "")) || 0,
        invoiceNo: sInvNo,
        sentDate: String(row[51] || "").trim(),
        payDate: String(row[52] || "").trim(),
        status: String(row[53] || "").trim(),
        invSeq: String(row[54] || "").trim(),
        cellRef: String(row[55] || "").trim(),
      };
      if (!spreadsheetItemsByInv[key]) spreadsheetItemsByInv[key] = [];
      spreadsheetItemsByInv[key].push(itemData);
      if (strippedKey !== key) {
        if (!spreadsheetItemsByInv[strippedKey]) spreadsheetItemsByInv[strippedKey] = [];
        spreadsheetItemsByInv[strippedKey].push(itemData);
      }
    }

    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;
      const hasDiscrepancy = [18, 19, 20, 21, 23, 24].some((idx) => String(row[idx] || "").trim() === "1");
      if (hasDiscrepancy) {
        const alert = {
          type: "invoice",
          sheetName: "InvComp",
          rowNumber: 6 + rowIdx,
          data: {
            accounting: (() => { const s = row.slice(0, 11); while (s.length < 11) s.push(""); return s; })(),
            confirmed: (() => { const s = row.slice(12, 18); while (s.length < 6) s.push(""); return s; })(),
            flags: (() => { const s = row.slice(18, 25); while (s.length < 7) s.push(""); return s; })(),
          },
          flagColumns: headers.slice(18, 25),
        };
        alert.summary = buildInvCompSummary(alert);

        const invNo = String(alert.summary?.invoiceNo || alert.data.accounting?.[5] || alert.data.confirmed?.[0] || "").trim();
        const cleanInvKey = invNo.toLowerCase().replace(/^#/, "");
        let items = (cleanInvKey && cleanInvKey !== "(no reference)" && cleanInvKey !== "(unknown)")
          ? (spreadsheetItemsByInv[cleanInvKey] || spreadsheetItemsByInv[invNo.toLowerCase()] || [])
          : [];
        if (items.length === 0 && alert.data.confirmed?.[0]) {
          const confKey = String(alert.data.confirmed[0]).trim().toLowerCase().replace(/^#/, "");
          if (confKey && confKey !== cleanInvKey) {
            items = spreadsheetItemsByInv[confKey] || spreadsheetItemsByInv[String(alert.data.confirmed[0]).trim().toLowerCase()] || [];
          }
        }
        alert.spreadsheetItems = items;
        if (items.length > 0) {
          alert.pulseAmounts = {
            gross: items.reduce((s, it) => s + (Number(it.grossAmount) || 0), 0),
            net: items.reduce((s, it) => s + (Number(it.netAmount) || 0), 0),
            vat: items.reduce((s, it) => s + (Number(it.vatAmount) || 0), 0),
          };
        }
        const isDuplicate = String(alert.data.flags[4] || "").trim() === "1" || items.length > 1;
        alert.isDuplicateInvoice = isDuplicate;

        alerts.push(alert);
      }
    }
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading InvComp alerts:`, error);
    throw error;
  }
}

export async function readDirCompAlerts(sheets, spreadsheetId, cachedData = null) {
  try {
    console.log(`\n📖 Reading DirComp alerts from ${spreadsheetId}...`);
    let allRows = [];
    if (cachedData) {
      allRows = cachedData;
    } else {
      const dataResponse = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId, range: "DirComp!A5:AV1000",
      }));
      allRows = dataResponse.data.values || [];
    }
    const headers = allRows[0] || [];
    const rows = allRows.slice(1);
    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;
      const hasDiscrepancy = [40, 42, 43, 44, 45, 46, 47].some((idx) => String(row[idx] || "").trim() === "1");
      if (hasDiscrepancy) {
        const alert = {
          type: "expense",
          sheetName: "DirComp",
          rowNumber: 7 + rowIdx,
          data: {
            accounting: (() => { const s = row.slice(0, 10); while (s.length < 10) s.push(""); return s; })(),
            confirmed: (() => { const s = row.slice(23, 34); while (s.length < 11) s.push(""); return s; })(),
            flags: (() => { const s = row.slice(40, 48); while (s.length < 8) s.push(""); return s; })(),
          },
          flagColumns: headers.slice(40, 48),
        };
        alert.summary = buildDirCompSummary(alert);
        alerts.push(alert);
      }
    }
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading DirComp alerts:`, error);
    throw error;
  }
}

export async function readCRMCompAlerts(sheets, spreadsheetId, mode, alertTypes, masterSheetId) {
  try {
    console.log(`\n📖 Reading CRMComp alerts (${mode} mode) for ${alertTypes.join(", ")}...`);
    let triageSettings = null;
    const dcaSheetId = masterSheetId || spreadsheetId;
    try {
      const batchResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
        spreadsheetId: dcaSheetId,
        ranges: ["DataChgAlert!C59:C66", "DataChgAlert!F59:F66", "DataChgAlert!C72:C79", "DataChgAlert!F72:F79"]
      }));
      const ranges = batchResp.data.valueRanges || [];
      const SETTING_ROWS = ["missing_job", "client_mismatch", "job_name_mismatch", "revenue_mismatch",
        "direct_costs_mismatch", "start_date_mismatch", "end_date_mismatch", "likelihood_mismatch"];
      const parseSettings = (vals) => {
        const s = {};
        SETTING_ROWS.forEach((k, i) => { const v = String((vals[i] || [])[0] || "").trim().toLowerCase(); s[k] = v !== "ignore"; });
        return s;
      };
      triageSettings = { dashPipe: parseSettings(ranges[0]?.values || []), dashConf: parseSettings(ranges[1]?.values || []), crmPipe: parseSettings(ranges[2]?.values || []), crmConf: parseSettings(ranges[3]?.values || []) };
    } catch (e) { }

    await setCRMMode(sheets, spreadsheetId, mode);
    const alerts = [];
    let dashData = [];
    let appData = [];
    let pipelineCalcsData = [];
    try {
      const rangesToFetch = ["CRMComp!X6:BF1000", "CRMComp!EF6:FL1000"];
      if (mode === "Pipeline") {
        rangesToFetch.push("CRMComp!DM6:DU1000");
      }
      const batchResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
        spreadsheetId, ranges: rangesToFetch, valueRenderOption: "FORMATTED_VALUE"
      }));
      dashData = batchResp.data.valueRanges[0]?.values || [];
      appData = batchResp.data.valueRanges[1]?.values || [];
      if (mode === "Pipeline") {
        pipelineCalcsData = batchResp.data.valueRanges[2]?.values || [];
      }
    } catch (e) { }

    const pipelineJobMap = new Map();
    if (mode === "Pipeline") {
      const addRowToMap = (row) => {
        if (!row || row.length === 0) return;
        const pClient = String(row[0] || "").trim().toLowerCase();
        const pJob = String(row[1] || "").trim().toLowerCase();
        const pCode = String(row[2] || "").trim().toLowerCase();
        const pLikely = row[7];
        const pCopied = row[8];
        const info = { likely: pLikely, copiedToConf: pCopied };
        if (pCode) pipelineJobMap.set(`code:${pCode}`, info);
        if (pClient && pJob) pipelineJobMap.set(`name:${pClient}|${pJob}`, info);
      };
      pipelineCalcsData.forEach(addRowToMap);
      appData.forEach(addRowToMap);
    }

    for (const alertType of alertTypes) {
      let dataRange, crmDataCols, sheetDataCols, flagCols, flagStartIdx;
      const isDash = alertType === "crmPipeDashDiscr" || alertType === "crmConfDashDiscr";
      const isPipe = alertType === "crmPipeDashDiscr" || alertType === "crmPipeAppDiscr";
      const settingsBlock = triageSettings ? (isDash ? (isPipe ? triageSettings.dashPipe : triageSettings.dashConf) : (isPipe ? triageSettings.crmPipe : triageSettings.crmConf)) : null;

      if (mode === "Pipeline") {
        if (alertType === "crmPipeDashDiscr") {
          dataRange = "CRMComp!X6:BF1000"; crmDataCols = [0, 13]; sheetDataCols = [17, 26]; flagCols = [27, 35]; flagStartIdx = 27;
        } else if (alertType === "crmPipeAppDiscr") {
          dataRange = "CRMComp!EF6:FL1000"; sheetDataCols = [0, 13]; crmDataCols = [15, 25]; flagCols = [25, 33]; flagStartIdx = 25;
        }
      } else if (mode === "Confirmed") {
        if (alertType === "crmConfDashDiscr") {
          dataRange = "CRMComp!X6:BF1000"; crmDataCols = [0, 13]; sheetDataCols = [17, 26]; flagCols = [27, 35]; flagStartIdx = 27;
        } else if (alertType === "crmConfAppDiscr") {
          dataRange = "CRMComp!EF6:FL1000"; sheetDataCols = [0, 13]; crmDataCols = [15, 25]; flagCols = [25, 33]; flagStartIdx = 25;
        }
      }

      if (!dataRange) continue;
      let rows = [];
      if (dataRange.includes("X6:BF")) rows = dashData;
      else if (dataRange.includes("EF6:FL")) rows = appData;

      if (rows.length === 0) {
        try {
          const dataResponse = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId, range: dataRange, valueRenderOption: "FORMATTED_VALUE" }));
          rows = dataResponse.data.values || [];
        } catch (e) { continue; }
      }

      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (!row || row.length === 0) continue;
        const flagValues = [0, 1, 2, 3, 4, 5, 6, 7].map(i => String(row[flagStartIdx + i] || "").trim());
        if (!flagValues.some(v => v === "1")) continue;
        const SETTING_KEYS = ["missing_job", "client_mismatch", "job_name_mismatch", "revenue_mismatch", "direct_costs_mismatch", "start_date_mismatch", "end_date_mismatch", "likelihood_mismatch"];
        const filteredFlags = settingsBlock ? flagValues.map((v, fi) => {
          if (v !== "1") return v;
          const sk = SETTING_KEYS[fi];
          return (sk && settingsBlock[sk] === false) ? "0" : v;
        }) : flagValues;
        // Confirmed mode suppression rule:
        // Confirmed jobs are already won and do not track likelihood in Confirmed tab
        if (mode === "Confirmed") {
          filteredFlags[7] = "0";
        }
        if (!filteredFlags.some(v => v === "1")) continue;

        // Pipeline CRM suppression rule:
        // Do not raise any alert if the job in the Pipeline tab has:
        // a) 0% likelihood, or
        // b) 100% likelihood AND "copied to confirmed tab" says "Yes"
        if (mode === "Pipeline") {
          if (alertType === "crmPipeAppDiscr") {
            const shtCode = String(row[2] || "").trim().toLowerCase();
            const shtClient = String(row[0] || "").trim().toLowerCase();
            const shtJob = String(row[1] || "").trim().toLowerCase();
            const meta = (shtCode ? pipelineJobMap.get(`code:${shtCode}`) : null)
              || (shtClient && shtJob ? pipelineJobMap.get(`name:${shtClient}|${shtJob}`) : null);
            const shtLikely = (row[7] !== undefined && String(row[7]).trim() !== "") ? row[7] : meta?.likely;
            const shtCopied = (row[8] !== undefined && String(row[8]).trim() !== "") ? row[8] : meta?.copiedToConf;
            if (isPipelineJobSuppressed(shtLikely, shtCopied)) {
              continue;
            }
          } else if (alertType === "crmPipeDashDiscr") {
            const shtCode = String(row[17] || "").trim().toLowerCase();
            const shtClient = String(row[18] || "").trim().toLowerCase();
            const shtJob = String(row[19] || "").trim().toLowerCase();
            const crmCode = String(row[2] || "").trim().toLowerCase();
            const crmClient = String(row[0] || "").trim().toLowerCase();
            const crmJob = String(row[1] || "").trim().toLowerCase();

            const meta = (shtCode ? pipelineJobMap.get(`code:${shtCode}`) : null)
              || (shtClient && shtJob ? pipelineJobMap.get(`name:${shtClient}|${shtJob}`) : null)
              || (crmCode ? pipelineJobMap.get(`code:${crmCode}`) : null)
              || (crmClient && crmJob ? pipelineJobMap.get(`name:${crmClient}|${crmJob}`) : null);

            const shtLikely = (row[24] !== undefined && String(row[24]).trim() !== "") ? row[24] : meta?.likely;
            const shtCopied = meta?.copiedToConf;
            if (isPipelineJobSuppressed(shtLikely, shtCopied)) {
              continue;
            }
          }
        }

        const isNotFound = filteredFlags[0] === "1";
        const mismatchFlags = filteredFlags.slice(1);
        const subType = isNotFound ? "not_found" : "field_mismatch";
        const MISMATCH_FIELD_NAMES = ["Client name", "Job name", "Revenue", "Direct costs", "Start date", "End date", "% Likelihood"];
        const mismatchFields = mismatchFlags.map((v, i) => v === "1" ? MISMATCH_FIELD_NAMES[i] : null).filter(Boolean);
        const padSlice = (arr, start, end) => {
          const slice = arr.slice(start, end);
          const len = end - start;
          while (slice.length < len) slice.push("");
          return slice;
        };
        alerts.push({
          type: "crm", alertType, subType, mismatchFields, mode, sheetName: "CRMComp", rowNumber: 7 + rowIdx,
          data: { crmData: padSlice(row, crmDataCols[0], crmDataCols[1]), sheetData: padSlice(row, sheetDataCols[0], sheetDataCols[1]), flags: filteredFlags },
        });
      }
    }

    const dashAlerts = alerts.filter(a => a.alertType.endsWith("DashDiscr"));
    const getIdentityKey = (a) => {
      let code = "", client = "", job = "";
      if (a.alertType.endsWith("DashDiscr")) {
        code = String(a.data?.crmData?.[2] || a.data?.sheetData?.[0] || "").trim().toLowerCase();
        client = String(a.data?.crmData?.[0] || a.data?.sheetData?.[1] || "").trim().toLowerCase();
        job = String(a.data?.crmData?.[1] || a.data?.sheetData?.[2] || "").trim().toLowerCase();
      } else {
        code = String(a.data?.crmData?.[0] || a.data?.sheetData?.[2] || "").trim().toLowerCase();
        client = String(a.data?.crmData?.[1] || a.data?.sheetData?.[0] || "").trim().toLowerCase();
        job = String(a.data?.crmData?.[2] || a.data?.sheetData?.[1] || "").trim().toLowerCase();
      }
      return code ? `code:${code}` : `name:${client}|${job}`;
    };

    const dashMismatchKeys = new Set(dashAlerts.filter(a => a.subType === "field_mismatch").map(getIdentityKey));
    const filteredAlerts = alerts.filter(a => {
      if (a.alertType.endsWith("AppDiscr") && a.subType === "field_mismatch") {
        if (dashMismatchKeys.has(getIdentityKey(a))) return false;
      }
      return true;
    });

    return filteredAlerts;
  } catch (error) {
    throw error;
  }
}

export async function handleDebugCompareTriage(req, res, sheets) {
  const { clientSheetId, masterSheetId, clientName: debugClientName, automationCommanderSheetId } = req.body;
  if (!clientSheetId || !masterSheetId || !debugClientName || !automationCommanderSheetId) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const debugSheetIdClean = extractSheetIdFromUrl(masterSheetId) || masterSheetId;
    const clientFlags = req.body.clientFlags || {};

    const invAlerts = clientFlags.invoiceDashboardDiscr
      ? await readInvCompAlerts(sheets, debugSheetIdClean).catch(e => { console.log(`  ⚠ InvComp read error: ${e.message}`); return []; })
      : [];
    const dirAlerts = clientFlags.expenseDashboardDiscr
      ? await readDirCompAlerts(sheets, debugSheetIdClean).catch(e => { console.log(`  ⚠ DirComp read error: ${e.message}`); return []; })
      : [];

    const pipeFlags = ["crmPipeDashDiscr", "crmPipeAppDiscr"].filter(f => clientFlags[f]);
    const crmPipeAlerts = pipeFlags.length > 0
      ? await readCRMCompAlerts(sheets, debugSheetIdClean, "Pipeline", pipeFlags, debugSheetIdClean)
        .catch(e => { console.log(`  ⚠ CRMComp Pipeline read error: ${e.message}`); return []; })
      : [];

    const confFlags = ["crmConfDashDiscr", "crmConfAppDiscr"].filter(f => clientFlags[f]);
    const crmConfAlerts = confFlags.length > 0
      ? await readCRMCompAlerts(sheets, debugSheetIdClean, "Confirmed", confFlags, debugSheetIdClean)
        .catch(e => { console.log(`  ⚠ CRMComp Confirmed read error: ${e.message}`); return []; })
      : [];

    invAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; a.flagType = a.flagType || "invoiceDashboardDiscr"; });
    dirAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; a.flagType = a.flagType || "expenseDashboardDiscr"; });
    crmPipeAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; if (!a.flagType) a.flagType = a.alertType || "crmPipeAppDiscr"; });
    crmConfAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; a.masterSheetId; if (!a.flagType) a.flagType = a.alertType || "crmConfAppDiscr"; });

    const allDebugAlerts = [...invAlerts, ...dirAlerts, ...crmPipeAlerts, ...crmConfAlerts];
    allDebugAlerts.forEach(a => { a.fingerprintHash = buildAlertFingerprint(a); });

    await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
    const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
    const clientMemory = memoryRows.filter(r => r.clientName === debugClientName);

    const handledStatuses = new Set(["ignored", "task", "superseded", "accepted"]);
    const handledHashes = new Set(clientMemory.filter(r => handledStatuses.has(r.status)).map(r => r.fingerprintHash).filter(Boolean));
    const cachedHashes = new Set(clientMemory.filter(r => r.status === "cached").map(r => r.fingerprintHash).filter(Boolean));

    const report = allDebugAlerts.map(a => {
      const fp = a.fingerprintHash;
      const memRow = clientMemory.find(r => r.fingerprintHash === fp);
      const parts = [a.type || "", a.flagType || a.alertType || ""];
      if (a.data?.accounting) parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.accounting)));
      if (a.data?.confirmed) parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.confirmed)));
      if (a.data?.crmData) parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.crmData)));
      if (a.data?.sheetData) parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.sheetData)));
      if (a.data?.flags) parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.flags)));
      const rawFp = parts.join("|");
      return {
        type: a.type,
        flagType: a.flagType || a.alertType,
        summary: a.summary?.summary || JSON.stringify(a.summary || {}).slice(0, 100),
        fingerprintHash: fp,
        amStatus: memRow ? memRow.status : "NOT_IN_AM",
        wouldBeFiltered: handledHashes.has(fp),
        rawFingerprint: rawFp.slice(0, 400),
      };
    });

    const generatedHashes = new Set(allDebugAlerts.map(a => a.fingerprintHash));
    const unmatchedMemory = clientMemory
      .filter(r => r.fingerprintHash && !generatedHashes.has(r.fingerprintHash))
      .map(r => ({
        fingerprintHash: r.fingerprintHash,
        status: r.status,
        alertType: r.alertType,
        alertSummary: (r.alertSummary || "").slice(0, 100),
      }));

    const allMemoryHashes = new Set(memoryRows.map(r => r.fingerprintHash).filter(Boolean));
    const notInAnyAM = allDebugAlerts
      .filter(a => !allMemoryHashes.has(a.fingerprintHash))
      .map(a => a.fingerprintHash);
    const inOtherClient = allDebugAlerts
      .filter(a => allMemoryHashes.has(a.fingerprintHash) && !clientMemory.find(r => r.fingerprintHash === a.fingerprintHash))
      .map(a => {
        const amRow = memoryRows.find(r => r.fingerprintHash === a.fingerprintHash);
        return { hash: a.fingerprintHash, flagType: a.flagType, storedClientName: amRow?.clientName, status: amRow?.status };
      });

    console.log(`  🔬 debug_compare_triage: ${allDebugAlerts.length} generated, ${clientMemory.length} in AM, ${unmatchedMemory.length} unmatched AM entries`);

    return res.status(200).json({
      success: true,
      clientName: debugClientName,
      summary: {
        generated: allDebugAlerts.length,
        inv: invAlerts.length,
        dir: dirAlerts.length,
        crmPipe: crmPipeAlerts.length,
        crmConf: crmConfAlerts.length,
        alertMemoryTotal: clientMemory.length,
        wouldBeFiltered: report.filter(r => r.wouldBeFiltered).length,
        wouldPassThrough: report.filter(r => !r.wouldBeFiltered).length,
        notInAlertMemory: report.filter(r => r.amStatus === "NOT_IN_AM").length,
        unmatchedAlertMemoryEntries: unmatchedMemory.length,
        notInAnyAlertMemory: notInAnyAM.length,
        foundUnderDifferentClient: inOtherClient.length,
      },
      generatedAlerts: report,
      unmatchedAlertMemoryEntries: unmatchedMemory,
      notInAnyAlertMemory: notInAnyAM,
      foundUnderDifferentClient: inOtherClient,
    });
  } catch (err) {
    console.error("❌ debug_compare_triage error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleDebugTriageState(req, res, sheets) {
  const { clientName, automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const allMemoryRows = await readAlertMemory(sheets, acId);
    const clientMemory = clientName ? allMemoryRows.filter(r => r.clientName === clientName) : allMemoryRows;
    const memorySummary = clientMemory
      .filter(r => r.alertType !== "flag_cleared")
      .map(r => ({
        hash: r.fingerprintHash,
        alertType: r.alertType,
        status: r.status,
        category: r.category || "MISSING",
        hasOptions: !!r.cachedOptionsJSON,
        summary: r.alertSummary?.slice(0, 60),
        ignoreReason: r.ignoreReason || "",
      }));

    const flagClearedRows = allMemoryRows
      .filter(r => r.alertType === "flag_cleared" && (!clientName || r.clientName === clientName))
      .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))
      .slice(0, 5)
      .map(r => {
        let snap = {};
        try { snap = JSON.parse(r.dataSnapshot || "{}"); } catch (e) { }
        return {
          clientName: r.clientName,
          clearedAt: snap.clearedAt || r.lastSeen,
          clearedGroups: snap.clearedGroups,
          clearedCols: snap.clearedCols,
        };
      });

    const preRaw = await redisClient.get(PRECOMPUTED_KEY);
    let precompSummary = null;
    if (preRaw) {
      const pre = JSON.parse(preRaw);
      const preAlerts = (pre.alerts || []).filter(a => !clientName || a.clientName === clientName);
      const preClients = (pre.clientsWithFlags || []).filter(c => !clientName || c.clientName === clientName);
      const preNoAction = (pre.noActionAlerts || []).filter(na => !clientName || na.clientName === clientName || na.clientId === preClients[0]?.masterSheetId);
      precompSummary = {
        computedAt: pre.computedAt,
        totalAlerts: pre.totalAlerts,
        clientAlerts: preAlerts.map(a => ({
          type: a.type,
          flagType: a.flagType || a.alertType,
          subType: a.subType,
          fingerprint: a.fingerprintHash,
          rowNumber: a.rowNumber,
        })),
        clientNoAction: preNoAction.map(na => ({
          flagType: na.flagType,
          hash: na.fingerprintHash,
          hasAnalysis: !!na.analysisResult,
        })),
        clientFlags: preClients.map(c => ({
          clientName: c.clientName,
          flags: Object.entries(c.flags || {}).filter(([, v]) => v).map(([k]) => k),
        })),
      };
    }

    console.log(`debug_triage_state: ${clientMemory.length} AlertMemory rows, precomp=${!!preRaw}`);
    return res.status(200).json({
      success: true,
      clientName,
      alertMemory: {
        totalRows: allMemoryRows.length,
        clientRows: memorySummary,
        flagClearedRecords: flagClearedRows,
        statusCounts: allMemoryRows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
      },
      precomputed: precompSummary,
    });
  } catch (err) {
    console.error("❌ debug_triage_state error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCleanupAlertMemory(req, res, sheets) {
  const { automationCommanderSheetId: acId, force = false } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    console.log(`cleanup_alert_memory: Triggering compactAlertMemory for ${acId} (force=${force})`);
    const result = await compactAlertMemory(sheets, acId, { force });
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error("❌ cleanup_alert_memory error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleRehashAlertMemory(req, res, sheets) {
  const { automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);

    const supersededWithReason = memoryRows.filter(r => r.status === "superseded" && r.ignoreReason);
    const sigKey = (r) => `${r.clientName}|${r.alertType}|${(r.alertSummary || "").slice(0, 40)}`;
    const now = new Date().toISOString();

    const reasonBySig = {};
    for (const sup of supersededWithReason) {
      const sig = sigKey(sup);
      if (!reasonBySig[sig]) reasonBySig[sig] = sup.ignoreReason;
    }

    const promotions = [];
    for (const row of memoryRows) {
      if (row.status !== "cached") continue;
      const sig = sigKey(row);
      if (reasonBySig[sig]) {
        promotions.push({ row, ignoreReason: reasonBySig[sig] });
      }
    }

    let promoted = 0;
    if (promotions.length > 0) {
      const acIdClean = extractSheetIdFromUrl(acId) || acId;
      const batchData = promotions.map(({ row, ignoreReason }) => ({
        range: `AlertMemory!A${row.rowIndex}:K${row.rowIndex}`,
        values: [[
          row.fingerprintHash, row.alertType, row.clientName, row.alertSummary,
          row.cachedOptionsJSON, "ignored", ignoreReason,
          row.firstSeen, now, row.lastRechecked || now, row.dataSnapshot || "",
        ]],
      }));
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: acIdClean,
        requestBody: { valueInputOption: "RAW", data: batchData },
      });
      promoted = promotions.length;
    }

    const priority = (status) => {
      if (status === "ignored" || status === "accepted" || status === "task") return 3;
      if (status === "cached") return 2;
      return 1;
    };
    const freshRows = await readAlertMemory(sheets, acId);
    const byHash = {};
    for (const row of freshRows) {
      if (!row.fingerprintHash) continue;
      if (!byHash[row.fingerprintHash]) byHash[row.fingerprintHash] = [];
      byHash[row.fingerprintHash].push(row);
    }
    const toDelete = [];
    for (const rows of Object.values(byHash)) {
      if (rows.length <= 1) continue;
      rows.sort((a, b) => {
        const pd = priority(b.status) - priority(a.status);
        if (pd !== 0) return pd;
        return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
      });
      for (let i = 1; i < rows.length; i++) toDelete.push(rows[i].rowIndex);
    }
    if (toDelete.length > 0) await deleteAlertMemoryRows(sheets, acId, toDelete);

    console.log(`rehash_alert_memory: promoted ${promoted} cached→ignored, deleted ${toDelete.length} duplicates`);
    return res.status(200).json({
      success: true,
      promoted,
      duplicatesRemoved: toDelete.length,
      totalRows: memoryRows.length,
    });
  } catch (err) {
    console.error("❌ rehash_alert_memory error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleRehashIgnoredAlerts(req, res, sheets) {
  const { automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    const memoryRows = await readAlertMemory(sheets, acId);
    const ignoredRows = memoryRows.filter(r => r.status === "ignored");
    if (ignoredRows.length === 0) return res.status(200).json({ success: true, updated: 0, message: "No ignored rows to update" });

    // Get all clients so we can read their comparison tabs
    const flagResp = await sheets.spreadsheets.values.get({
      spreadsheetId: acId,
      range: "AutoUpdates!A2:M100",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const clientRows = (flagResp.data.values || []).slice(1).filter(r => r[0] && r[11] && r[12]);

    // Build map of alertSummary → fresh fingerprint by reading each client's InvComp
    const freshHashByInvNo = {}; // invoiceNo → { hash, clientName }
    for (const cr of clientRows) {
      const clientName = String(cr[0] || "").trim();
      const clientSheetId = extractSheetIdFromUrl(String(cr[11] || "")) || String(cr[11] || "");
      if (!clientSheetId) continue;
      try {
        const alerts = await readInvCompAlerts(sheets, clientSheetId);
        for (const alert of alerts) {
          alert.fingerprintHash = buildAlertFingerprint(alert);
          const invNo = alert.summary?.invoiceNo || "";
          if (invNo) freshHashByInvNo[`${clientName}|${invNo}`] = alert.fingerprintHash;
        }
      } catch (e) { /* skip client on error */ }
    }

    // Match ignored rows to fresh hashes and update
    const writes = [];
    let updated = 0;
    for (const row of ignoredRows) {
      const invMatch = (row.alertSummary || "").match(/Invoice\s+#?(\S+)/i);
      if (!invMatch) continue;
      const key = `${row.clientName}|${invMatch[1]}`;
      const freshHash = freshHashByInvNo[key];
      if (freshHash && freshHash !== row.fingerprintHash) {
        console.log(`  Rehashing "${row.clientName}" inv ${invMatch[1]}: ${row.fingerprintHash} → ${freshHash}`);
        writes.push({ range: `AlertMemory!A${row.rowIndex}`, values: [[freshHash]] });
        updated++;
      }
    }

    if (writes.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: acId,
        requestBody: { data: writes, valueInputOption: "RAW" },
      });
    }
    console.log(`  ✅ rehash_ignored_alerts: ${updated} updated of ${ignoredRows.length} ignored rows`);
    return res.status(200).json({ success: true, updated, total: ignoredRows.length });
  } catch (err) {
    console.error("❌ rehash_ignored_alerts:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetPrecomputed(req, res, sheets) {
  const tStart = Date.now();
  const { automationCommanderSheetId } = req.body;
  try {
    let raw = null;
    let tRedis = 0;
    if (_precomputedMemoryCache && (Date.now() - _precomputedCachedAt < 60000)) {
      raw = _precomputedMemoryCache;
    } else if (redisClient?.isOpen) {
      const t0 = Date.now();
      raw = await redisClient.get(PRECOMPUTED_KEY);
      tRedis = Date.now() - t0;
      if (raw) {
        _precomputedMemoryCache = raw;
        _precomputedCachedAt = Date.now();
      }
    }
    if (!raw) {
      console.log(`  No precomputed data found (${tRedis}ms)`);
      return res.status(200).json({ success: true, available: false });
    }

    const data = JSON.parse(raw);
    const ageMs = Date.now() - (data.computedAt || 0);
    const isStale = ageMs > PRECOMPUTED_MAX_AGE_MS;
    if (isStale) {
      console.log(`  Precomputed data is ${Math.round(ageMs / 60000)} mins old (serving optimistically, background refresh needed)`);
    }

    const tMem0 = Date.now();
    // Pass allowFallback = false so we NEVER download the 8.5MB AlertMemory sheet during user page load
    const handledMap = await readHandledAlertHashes(sheets, automationCommanderSheetId, false);
    const tMem = Date.now() - tMem0;

    const tFilt0 = Date.now();
    const filteredAlerts = data.alerts.filter(alert => {
      const hash = alert.fingerprintHash || buildAlertFingerprint(alert);
      const status = handledMap[hash];
      if (!status) return true;
      return status === "cached" || status === "pending_automation";
    });

    const filteredProactive = (data.proactiveAlerts || []).filter(alert => {
      const hash = alert.fingerprintHash || createHash("sha256").update(alert.alertKey || "").digest("hex").substring(0, 16);
      let status = handledMap[hash];
      if (!status && alert.legacyAlertKey) {
        const legacyHash = createHash("sha256").update(alert.legacyAlertKey).digest("hex").substring(0, 16);
        status = handledMap[legacyHash];
      }
      if (!status) return true;
      return status === "cached" || status === "pending_automation";
    });
    const tFilt = Date.now() - tFilt0;

    const filteredNoAction = (data.noActionAlerts || []).filter(alert => {
      if (alert.flagType === "expenseUnreconGaps") {
        const detail = String(alert.flagDetail || alert.alertSummary || "");
        if (detail.includes("Manual Gap") || detail.includes("Placeholder Gap")) return false;
      }
      if (!alert.fingerprintHash) return true;
      let status = handledMap[alert.fingerprintHash];
      if (!status && alert.legacyFingerprint) {
        status = handledMap[alert.legacyFingerprint];
      }
      if (!status) return true;
      return status === "cached" || status === "pending_automation";
    });

    const sessionUser = getSessionUser(req);
    let scopedAlerts = filteredAlerts;
    let scopedProactive = filteredProactive;
    let scopedNoAction = filteredNoAction;

    if (sessionUser && !sessionUser.isAdmin && sessionUser.assignedClients !== "*") {
      const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      scopedAlerts = filteredAlerts.filter(a =>
        assignedList.some(assigned => matchesClientName(assigned, a.clientName))
      );
      scopedProactive = filteredProactive.filter(a =>
        assignedList.some(assigned => matchesClientName(assigned, a.clientName))
      );
      scopedNoAction = filteredNoAction.filter(a =>
        assignedList.some(assigned => matchesClientName(assigned, a.clientName))
      );
    }

    if (scopedAlerts.length < data.alerts.length || scopedProactive.length < (data.proactiveAlerts || []).length || scopedNoAction.length < (data.noActionAlerts || []).length) {
      console.log(`  Filtered alerts from precomputed data`);
    }

    const alertCountsByClientAndFlag = {};
    const activeExpenseIdsByClient = {};
    const activeInvoiceIdsByClient = {};

    for (const alert of scopedAlerts) {
      const key = alert.clientName;
      let flagKey = alert.flagType || alert.alertType || alert.type;

      if (flagKey === "invoice") flagKey = "invoiceDashboardDiscr";
      if (flagKey === "expense") flagKey = "expenseDashboardDiscr";
      if (flagKey === "crm") flagKey = alert.flagType || alert.alertType || "crmPipeAppDiscr";

      alert.flagType = flagKey;
      alert.alertType = flagKey;

      if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
      alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;

      if (flagKey === "expenseDashboardDiscr") {
        const txId = alert.summary?.transactionId || alert.summary?.appId || alert.summary?.reference || alert.summary?.id;
        if (txId !== undefined && txId !== null && txId !== "") {
          if (!activeExpenseIdsByClient[key]) activeExpenseIdsByClient[key] = [];
          const s = String(txId).trim();
          const clean = s.replace(/^#/, "");
          activeExpenseIdsByClient[key].push(s);
          if (clean !== s) activeExpenseIdsByClient[key].push(clean);
        }
      }
      if (flagKey === "invoiceDashboardDiscr") {
        const isMissing = alert.data?.flags?.[0] === "1" || (alert.flagColumns?.[0] === "Missing invoice?" && alert.data?.flags?.[0] === "1");
        if (isMissing) {
          const invNo = alert.summary?.invoiceNo || alert.summary?.reference || alert.summary?.id || alert.data?.accounting?.[5];
          if (invNo !== undefined && invNo !== null && invNo !== "") {
            if (!activeInvoiceIdsByClient[key]) activeInvoiceIdsByClient[key] = [];
            const s = String(invNo).trim();
            const clean = s.replace(/^#/, "");
            activeInvoiceIdsByClient[key].push(s);
            if (clean !== s) activeInvoiceIdsByClient[key].push(clean);
          }
        }
      }
    }

    for (const alert of scopedNoAction) {
      if (alert.flagType && FLAG_NAMES[alert.flagType]) {
        alert.flagName = FLAG_NAMES[alert.flagType];
      }
      const key = alert.clientName;
      const flagKey = alert.flagType;
      if (key && flagKey) {
        if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
        alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;
      }
    }

    let clientsSource = data.clientsWithFlags || [];
    if (sessionUser && !sessionUser.isAdmin && sessionUser.assignedClients !== "*") {
      const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      clientsSource = clientsSource.filter(c =>
        assignedList.some(assigned => matchesClientName(assigned, c.clientName))
      );
    }

    const tCm0 = Date.now();
    const cmMap = await getClientManagerClientMap(sheets, automationCommanderSheetId);
    const tCm = Date.now() - tCm0;

    const clientsWithUpdatedCounts = clientsSource.map(c => {
      const counts = alertCountsByClientAndFlag[c.clientName] || {};
      const updatedFlags = { ...(c.flags || {}) };
      for (const flagKey of Object.keys(updatedFlags)) {
        if (!counts[flagKey] || counts[flagKey] <= 0) {
          updatedFlags[flagKey] = false;
        }
      }
      return {
        ...c,
        hasClientManager: cmMap.hasManager(c.clientName),
        flags: updatedFlags,
        alertCounts: counts,
        activeExpenseIds: activeExpenseIdsByClient[c.clientName] || [],
        activeInvoiceIds: activeInvoiceIdsByClient[c.clientName] || [],
      };
    });

    let aggregatedNoActionResults = {};
    for (const na of scopedNoAction) {
      if (na.analysisResult && na.analysisResult.results) {
        if (na.fingerprintHash) {
          aggregatedNoActionResults[`${na.clientName}___${na.fingerprintHash}`] = na.analysisResult;
        }
        const key = `${na.clientName}___${na.flagType}`;
        if (!aggregatedNoActionResults[key]) {
          aggregatedNoActionResults[key] = { success: true, flagType: na.flagType, results: [], overallOk: true };
        }
        aggregatedNoActionResults[key].results.push(...na.analysisResult.results);
        if (na.analysisResult.overallOk === false) {
          aggregatedNoActionResults[key].overallOk = false;
        }
      }
    }

    const sessionId = Math.random().toString(36).substring(2, 15);
    if (redisClient?.isOpen) {
      redisClient.set(
        `triage_alerts:${sessionId}`,
        JSON.stringify({
          alerts: scopedAlerts,
          noActionAlerts: scopedNoAction,
          proactiveAlerts: scopedProactive,
          clientsWithFlags: clientsWithUpdatedCounts,
        }),
        { EX: 3600 }
      ).catch(e => console.error("Error saving triage session to Redis:", e));
    }
    const totalMs = Date.now() - tStart;

    console.log(`⏱️ [handleGetPrecomputed]: total=${totalMs}ms (redisGet=${tRedis}ms, mem=${tMem}ms, filt=${tFilt}ms, cm=${tCm}ms)`);

    return res.status(200).json({
      success: true,
      available: true,
      sessionId,
      totalAlerts: scopedAlerts.length,
      noActionCount: scopedNoAction.length,
      proactiveAlerts: scopedProactive,
      clientsWithFlags: clientsWithUpdatedCounts.map(c => ({
        clientName: c.clientName,
        clientSheetId: c.clientSheetId,
        masterSheetId: c.masterSheetId,
        hasClientManager: c.hasClientManager || false,
        flags: c.flags,
        alertCounts: c.alertCounts || {},
        activeExpenseIds: c.activeExpenseIds || [],
        activeInvoiceIds: c.activeInvoiceIds || [],
      })),
      computedAt: data.computedAt,
      computedMinutesAgo: Math.round(ageMs / 60000),
      isStale,
      noActionAnalysisResults: aggregatedNoActionResults,
      _timing: { totalMs, tRedis, tMem, tFilt, tCm },
    });
  } catch (err) {
    console.error("❌ Error retrieving precomputed data:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleStorePrecomputed(req, res, sheets) {
  const { secret, computedAt, noActionAnalysisResults, automationCommanderSheetId } = req.body;

  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorised" });
  }

  try {
    let mergedAlerts = [];
    let mergedNoActionAlerts = [];
    let reconciledClients = [];

    let finalAlerts = mergedAlerts;
    let finalClientsWithFlags = reconciledClients;
    let finalNoActionAlerts = mergedNoActionAlerts;
    let finalProactiveAlerts = [];

    const acIdForMerge = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;
    let memoryRowsForMerge = null;

    try {
      await ensureAlertMemoryTab(sheets, acIdForMerge);

      const currentMemoryRows = await readAlertMemory(sheets, acIdForMerge);
      if (currentMemoryRows.length > 2000) {
        console.log(`[store_precomputed] AlertMemory row count (${currentMemoryRows.length}) exceeds 2,000 threshold. Triggering compaction...`);
        await compactAlertMemory(sheets, acIdForMerge);
      }

      memoryRowsForMerge = await readAlertMemory(sheets, acIdForMerge);

      const oldPathFingerprints = new Set(mergedAlerts.map(a => buildAlertFingerprint(a)));
      const oldPathNoActionKeys = new Set(mergedNoActionAlerts.map(na => `${na.clientId}|||${na.flagType}`));

      const newAlertsFromMemory = [];
      const newNoActionFromMemory = [];
      const newProactiveFromMemory = [];
      const extraFlagsByClient = new Map();
      const newClientMeta = new Map();

      const { clientRows } = await readAutoUpdatesClientRows_(sheets, acIdForMerge);
      const clientNameToMeta = new Map(clientRows.map(c => [c.clientName, c]));

      for (const row of memoryRowsForMerge) {
        if (row.status !== "cached" && row.status !== "pending_automation") continue;

        if (Object.prototype.hasOwnProperty.call(AUTOLOG_TYPE_PATTERNS, row.alertType)) {
          row.category = "info";
        }

        if (row.category === "discrepancy") {
          if (!row.cachedOptionsJSON) continue;
          if (oldPathFingerprints.has(row.fingerprintHash)) continue;

          let alertObj = null;
          try { alertObj = JSON.parse(row.dataSnapshot); } catch (e) { continue; }

          const isPipeAlert = (alertObj?.mode === "Pipeline" || alertObj?.alertType === "crmPipeAppDiscr" || alertObj?.alertType === "crmPipeDashDiscr" || alertObj?.flagType === "crmPipeAppDiscr" || alertObj?.flagType === "crmPipeDashDiscr" || row.alertType === "crmPipeAppDiscr" || row.alertType === "crmPipeDashDiscr");
          if (isPipeAlert) {
            const sd = alertObj?.data?.sheetData || [];
            const shtLikely = sd[7];
            const shtCopied = sd[8] || sd[10];
            if (isPipelineJobSuppressed(shtLikely, shtCopied)) {
              continue;
            }
          }
          let options = [];
          try { options = JSON.parse(row.cachedOptionsJSON); } catch (e) { continue; }

          const sharedRows = {};
          for (const opt of options) {
            if (opt.jobRowsData) sharedRows[opt.jobRow] = opt.jobRowsData;
          }
          for (const opt of options) {
            if (!opt.jobRowsData && sharedRows[opt.jobRow]) {
              opt.jobRowsData = JSON.parse(JSON.stringify(sharedRows[opt.jobRow]));
              if (opt.targetSlotType && opt.targetSlotNum && opt.targetRowNum) {
                for (const r of opt.jobRowsData) {
                  if (r.rowNum === opt.targetRowNum) {
                    if (opt.targetSlotType === "invoice" && r.invoiceSlots) r.invoiceSlots.forEach(s => s.highlighted = (s.slotNum === opt.targetSlotNum));
                    else if (opt.targetSlotType === "expense" && r.expenseSlots) r.expenseSlots.forEach(s => s.highlighted = (s.slotNum === opt.targetSlotNum));
                  } else {
                    if (r.invoiceSlots) r.invoiceSlots.forEach(s => s.highlighted = false);
                    if (r.expenseSlots) r.expenseSlots.forEach(s => s.highlighted = false);
                  }
                }
              }
            }
          }

          const liveMeta = clientNameToMeta.get(row.clientName) || {};

          newAlertsFromMemory.push({
            ...alertObj,
            fingerprintHash: row.fingerprintHash,
            clientName: row.clientName,
            clientId: liveMeta.clientSheetId || alertObj.clientId || alertObj.clientSheetId || "",
            masterSheetId: liveMeta.masterSheetId || alertObj.masterSheetId || "",
            options,
            firstSeen: row.firstSeen,
            lastSeen: row.lastSeen
          });

          if (!extraFlagsByClient.has(row.clientName)) extraFlagsByClient.set(row.clientName, {});

          let mappedFlagType = row.alertType;
          if (mappedFlagType === "invoice") mappedFlagType = alertObj.flagType || "invoiceDashboardDiscr";
          if (mappedFlagType === "expense") mappedFlagType = alertObj.flagType || "expenseDashboardDiscr";
          if (mappedFlagType === "crm") mappedFlagType = alertObj.flagType || alertObj.alertType || "crmPipeAppDiscr";

          extraFlagsByClient.get(row.clientName)[mappedFlagType] = true;

          if (!finalClientsWithFlags.some(c => c.clientName === row.clientName) && !newClientMeta.has(row.clientName)) {
            newClientMeta.set(row.clientName, {
              clientSheetId: alertObj.clientId || alertObj.clientSheetId || "",
              masterSheetId: alertObj.masterSheetId || "",
            });
          }
        } else if (String(row.category).toLowerCase() === "info" || row.category === "proactive") {
          if (!Object.prototype.hasOwnProperty.call(AUTOLOG_TYPE_PATTERNS, row.alertType)) {
            if (row.category === "proactive") {
              let alertObj = {};
              try { alertObj = JSON.parse(row.dataSnapshot || "{}"); } catch (e) { alertObj = {}; }
              const metaFields = ["jobName", "endClientName", "confirmedRow", "revenue", "startDate", "endDate",
                "frequencyDays", "lastInvoiceDate", "expectedByDate", "timestamp", "sequenceType", "summary", "jobInfo", "detailsSnippet",
                "childRowNum", "clientJobStr", "pipelineRow", "likelihood", "copiedToConf", "jobType",
                "possibleMatchInvoiceNo", "possibleMatchAmount", "possibleMatchSentDate", "possibleMatchConfidence", "possibleMatchConfirmedRow", "possibleMatchVatAmount", "possibleMatchStatus", "possibleMatchCase",
                "uninvoicedAmount", "projectCode", "draftCount", "draftTotal", "stableJobKey", "isRetainer", "tab",
                "directCosts", "unreceivedAmount", "placeholderCount", "placeholderTotal",
                "errorSnippet", "occurrenceCount", "category", "entityKey", "fieldName", "transition1", "transition2", "conflictType", "suggestion", "rawLogSnippet", "invoiceNo", "rawSnippet"];
              const metadata = {};
              for (const f of metaFields) { if (alertObj[f] !== undefined) metadata[f] = alertObj[f]; }
              newProactiveFromMemory.push({
                ...alertObj, rowIndex: row.rowIndex, clientName: alertObj.clientName || row.clientName, alertType: alertObj.alertType || row.alertType, metadata, firstSeen: row.firstSeen, lastSeen: row.lastSeen
              });
              if (!finalClientsWithFlags.some(c => c.clientName === row.clientName) && !newClientMeta.has(row.clientName)) {
                newClientMeta.set(row.clientName, {
                  clientSheetId: alertObj.clientId || alertObj.clientSheetId || "",
                  masterSheetId: alertObj.masterSheetId || "",
                });
              }
            }
            continue;
          }

          const clientMeta = clientNameToMeta.get(row.clientName);
          if (!clientMeta) continue;

          if (oldPathNoActionKeys.has(`${clientMeta.masterSheetId}|||${row.alertType}`)) continue;
          if (row.alertType === "expenseUnreconGaps") {
            const summary = String(row.alertSummary || "");
            if (summary.includes("Manual Gap") || summary.includes("Placeholder Gap")) continue;
          }
          if (row.alertType === "crmCopiedConfChecked") {
            const summary = String(row.alertSummary || "");
            if (summary.includes("Skipped Copy: Job with Project Code") || summary.includes("already exists in Confirmed")) continue;
          }

          let analysisResult = null;
          if (row.cachedOptionsJSON) {
            try { analysisResult = JSON.parse(row.cachedOptionsJSON); } catch (e) { analysisResult = null; }
          }
          newNoActionFromMemory.push({
            clientId: clientMeta.masterSheetId,
            clientSheetId: clientMeta.clientSheetId,
            masterSheetId: clientMeta.masterSheetId,
            clientName: row.clientName,
            type: "info",
            alertType: row.alertType,
            id: row.fingerprintHash,
            flagType: row.alertType,
            flagName: FLAG_NAMES[row.alertType] || row.alertType,
            flagDetail: row.alertSummary,
            fingerprintHash: row.fingerprintHash,
            analysisResult,
            firstSeen: row.firstSeen,
            lastSeen: row.lastSeen,
          });

          if (!extraFlagsByClient.has(row.clientName)) extraFlagsByClient.set(row.clientName, {});
          extraFlagsByClient.get(row.clientName)[row.alertType] = true;

          if (!finalClientsWithFlags.some(c => c.clientName === row.clientName) && !newClientMeta.has(row.clientName)) {
            newClientMeta.set(row.clientName, {
              clientSheetId: clientMeta.clientSheetId,
              masterSheetId: clientMeta.masterSheetId,
            });
          }
        }
      }

      if (newAlertsFromMemory.length > 0 || newNoActionFromMemory.length > 0 || newProactiveFromMemory.length > 0) {
        finalAlerts = [...mergedAlerts, ...newAlertsFromMemory];
        finalNoActionAlerts = [...mergedNoActionAlerts, ...newNoActionFromMemory];

        // Precedence rule: "uninvoiced_revenue" takes precedence over "uninvoiced_new_job" for the same job
        const completedRevenueKeys = new Set(
          newProactiveFromMemory
            .filter(a => a.alertType === "uninvoiced_revenue")
            .map(a => `${a.clientName}:::${a.stableJobKey || a.metadata?.stableJobKey}`)
            .filter(k => !k.endsWith(":::undefined"))
        );
        finalProactiveAlerts = completedRevenueKeys.size > 0
          ? newProactiveFromMemory.filter(a => {
            if (a.alertType === "uninvoiced_new_job") {
              const k = `${a.clientName}:::${a.stableJobKey || a.metadata?.stableJobKey}`;
              if (completedRevenueKeys.has(k)) return false;
            }
            return true;
          })
          : newProactiveFromMemory;

        finalClientsWithFlags = reconciledClients.map(c => {
          const extra = extraFlagsByClient.get(c.clientName);
          return extra ? { ...c, flags: { ...c.flags, ...extra } } : c;
        });
        for (const [clientName, meta] of newClientMeta.entries()) {
          finalClientsWithFlags.push({
            clientName,
            clientSheetId: meta.clientSheetId,
            masterSheetId: meta.masterSheetId,
            flags: extraFlagsByClient.get(clientName) || {},
          });
        }
        console.log(`  store_precomputed: merged ${newAlertsFromMemory.length} discrepancy + ${newNoActionFromMemory.length} proactive AlertMemory-sourced item(s) across ${newClientMeta.size} new + ${extraFlagsByClient.size - newClientMeta.size} existing client(s)`);
      }
    } catch (mergeErr) {
      console.log(`  ⚠️ Could not merge AlertMemory-sourced alerts: ${mergeErr.message}`);
    }

    let aggregatedNoActionResults = { ...(noActionAnalysisResults || {}) };

    const keysToRebuild = new Set();
    for (const na of finalNoActionAlerts) {
      if (na.analysisResult && na.analysisResult.results) {
        keysToRebuild.add(`${na.clientName}___${na.flagType}`);
      }
    }
    for (const key of keysToRebuild) {
      aggregatedNoActionResults[key] = { success: true, flagType: key.split("___")[1], results: [], overallOk: true };
    }

    for (const na of finalNoActionAlerts) {
      if (na.analysisResult && na.analysisResult.results) {
        if (na.fingerprintHash) {
          aggregatedNoActionResults[`${na.clientName}___${na.fingerprintHash}`] = na.analysisResult;
        }
        const key = `${na.clientName}___${na.flagType}`;
        aggregatedNoActionResults[key].results.push(...na.analysisResult.results);
        if (na.analysisResult.overallOk === false) {
          aggregatedNoActionResults[key].overallOk = false;
        }
      }
    }

    const precomputedData = {
      computedAt: computedAt || Date.now(),
      totalAlerts: finalAlerts.length,
      noActionCount: finalNoActionAlerts.length,
      alerts: finalAlerts,
      noActionAlerts: finalNoActionAlerts,
      proactiveAlerts: finalProactiveAlerts,
      clientsWithFlags: finalClientsWithFlags,
      noActionAnalysisResults: aggregatedNoActionResults,
    };

    const serializedPrecomputed = JSON.stringify(precomputedData);
    await redisClient.set(
      PRECOMPUTED_KEY,
      serializedPrecomputed,
      { EX: 86400 * 7 } // 7-day TTL in Redis
    );
    _precomputedMemoryCache = serializedPrecomputed;
    _precomputedCachedAt = Date.now();

    // Warm up handled hashes map and tasks cache in Redis using rows already in memory!
    if (redisClient?.isOpen && acIdForMerge && memoryRowsForMerge) {
      try {
        const handledMap = {};
        for (const r of memoryRowsForMerge) {
          if (r.status && r.status !== "cached" && r.status !== "pending_automation") {
            handledMap[r.fingerprintHash] = r.status;
          }
        }
        await redisClient.set(`pulse:alert_memory_handled:${acIdForMerge}`, JSON.stringify(handledMap), { EX: 86400 * 7 });
        console.log(`  ✅ store_precomputed: warmed handledMap (${Object.keys(handledMap).length} hashes) in Redis`);

        const tasksList = memoryRowsForMerge.filter(r => r.status === "task" || r.status === "task_resolved");
        await redisClient.set("triage_tasks_cache", JSON.stringify(tasksList), { EX: 86400 * 7 });
        console.log(`  ✅ store_precomputed: warmed triage_tasks_cache (${tasksList.length} tasks) in Redis`);
      } catch (warmErr) {
        console.warn("⚠️ Error warming Redis caches in store_precomputed:", warmErr.message);
      }
    }

    const analysisCount = Object.keys(precomputedData.noActionAnalysisResults).length;
    console.log(`✅ store_precomputed: ${precomputedData.totalAlerts} alerts, ${analysisCount} pre-analysed flags saved to Redis`);

    try {
      const clientDetail = (finalClientsWithFlags || []).map(c => ({
        clientName: c.clientName,
        alertCount: finalAlerts.filter(a => a.clientName === c.clientName).length,
        noActionCount: finalNoActionAlerts.filter(na => {
          const naClient = (finalClientsWithFlags || []).find(rc => rc.masterSheetId === na.clientId);
          return naClient && naClient.clientName === c.clientName;
        }).length,
        proactiveCount: (precomputedData.proactiveAlerts || []).filter(pa => pa.clientName === c.clientName).length,
      })).filter(c => c.alertCount > 0 || c.noActionCount > 0 || c.proactiveCount > 0);

      await logPrecomputeRun(sheets, extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId, {
        clientsWithFlags: (finalClientsWithFlags || []).length,
        totalAlerts: precomputedData.totalAlerts,
        noActionCount: precomputedData.noActionCount,
        analysisCount,
        proactiveCount: (precomputedData.proactiveAlerts || []).length,
        clientDetail,
      });
    } catch (logErr) {
      console.log(`⚠️ Could not log precompute run: ${logErr.message}`);
    }

    return res.status(200).json({ success: true, stored: precomputedData.totalAlerts });
  } catch (err) {
    console.error("❌ Error storing precomputed data:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function isInvoicePlaceholderStillActive_(line, clientSheetId, sharedData, sheets) {
  if (!line || !clientSheetId) return true;

  if (line.includes("[Confirmed]")) {
    const cMatch = line.match(/\[Confirmed\]\s*(?:Stale Invoice\s*[-–]\s*)?(?:Row\s*(\d+),\s*)?([^|]+)\|\s*(.+?),\s*Slot\s*(\d+)/i);
    if (!cMatch) return true;
    const rowNum = cMatch[1] ? parseInt(cMatch[1], 10) : 0;
    const clientName = cMatch[2].trim().toLowerCase();
    const jobName = cMatch[3].trim().toLowerCase();
    const slotNum = parseInt(cMatch[4], 10);
    if (!slotNum || slotNum < 1 || slotNum > 3) return true;

    let confirmedRows = sharedData?.confirmedData || [];
    if (!confirmedRows || confirmedRows.length < 2) {
      try {
        const resp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId, range: "Confirmed!A1:CR5000", valueRenderOption: "UNFORMATTED_VALUE"
        }));
        confirmedRows = resp.data.values || [];
        if (sharedData) sharedData.confirmedData = confirmedRows;
      } catch (e) {
        return true;
      }
    }
    if (confirmedRows.length < 2) return true;

    let targetRow = null;
    if (rowNum > 0 && rowNum <= confirmedRows.length) {
      const r = confirmedRows[rowNum - 1] || [];
      if (String(r[0] || "").trim().toLowerCase() === clientName && (String(r[1] || "").trim().toLowerCase() === jobName || String(r[1] || "").trim().toLowerCase().includes(jobName))) {
        targetRow = r;
      }
    }
    if (!targetRow) {
      for (let i = 1; i < confirmedRows.length; i++) {
        const r = confirmedRows[i] || [];
        if (String(r[0] || "").trim().toLowerCase() === clientName && (String(r[1] || "").trim().toLowerCase() === jobName || String(r[1] || "").trim().toLowerCase().includes(jobName))) {
          targetRow = r;
          break;
        }
      }
    }
    if (!targetRow) return false; // Job gone from Confirmed -> resolved!

    const headers = (confirmedRows[0] || []).map(h => String(h || "").toLowerCase().trim());
    const findHeaderIdx = (patterns) => {
      for (const pat of patterns) {
        const idx = headers.indexOf(pat.toLowerCase().trim());
        if (idx !== -1) return idx;
      }
      return -1;
    };

    let colInvNo = findHeaderIdx([`inv ${slotNum} no`, `inv. ${slotNum} no`, `inv ${slotNum} ref`, `inv. ${slotNum} ref`, `invoice ${slotNum} no`, `invoice ${slotNum} ref`]);
    let colAmt = findHeaderIdx([`inv ${slotNum} amt`, `inv. ${slotNum} amt`, `inv ${slotNum} amount`, `invoice ${slotNum} amt`, `invoice ${slotNum} amount`]);
    let colStat = findHeaderIdx([`inv ${slotNum} status`, `inv. ${slotNum} status`, `invoice ${slotNum} status`]);

    const defaultCols = {
      1: { amt: 41, ref: 42, stat: 45 },
      2: { amt: 48, ref: 49, stat: 52 },
      3: { amt: 55, ref: 56, stat: 59 },
    }[slotNum];

    if (colInvNo === -1 && defaultCols) colInvNo = defaultCols.ref;
    if (colAmt === -1 && defaultCols) colAmt = defaultCols.amt;
    if (colStat === -1 && defaultCols) colStat = defaultCols.stat;

    const currentRef = colInvNo !== -1 ? String(targetRow[colInvNo] || "").trim() : "";
    const currentAmt = colAmt !== -1 ? String(targetRow[colAmt] || "").trim() : "";
    const currentStatus = colStat !== -1 ? String(targetRow[colStat] || "").trim().toLowerCase() : "";

    if (currentRef && !isPlaceholderInvoice(currentRef)) return false; // Real invoice matched -> resolved!
    if (currentStatus === "paid" || currentStatus === "sent") return false; // Marked sent or paid -> resolved!
    if (!currentRef && (!currentAmt || currentAmt === "0" || currentAmt === "£0.00")) return false; // Placeholder removed -> resolved!

    return true; // Still active placeholder
  }

  return true;
}

export async function isExpensePlaceholderStillActive_(line, clientSheetId, sharedData, sheets) {
  if (!line || !clientSheetId) return true;

  // 1. Confirmed tab check:
  if (line.includes("[Confirmed]")) {
    const cMatch = line.match(/\[Confirmed\]\s*(?:Stale Expense\s*[-–]\s*)?(?:Row\s*(\d+),\s*)?([^|]+)\|\s*(.+?),\s*Slot\s*(\d+)/i);
    if (!cMatch) return true;
    const rowNum = cMatch[1] ? parseInt(cMatch[1], 10) : 0;
    const clientName = cMatch[2].trim().toLowerCase();
    const jobName = cMatch[3].trim().toLowerCase();
    const slotNum = parseInt(cMatch[4], 10);
    if (!slotNum || slotNum < 1 || slotNum > 3) return true;

    let confirmedRows = sharedData?.confirmedData || [];
    if (!confirmedRows || confirmedRows.length < 2) {
      try {
        const resp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId, range: "Confirmed!A1:CR5000", valueRenderOption: "UNFORMATTED_VALUE"
        }));
        confirmedRows = resp.data.values || [];
        if (sharedData) sharedData.confirmedData = confirmedRows;
      } catch (e) {
        return true;
      }
    }
    if (confirmedRows.length < 2) return true;

    let targetRow = null;
    if (rowNum > 0 && rowNum <= confirmedRows.length) {
      const r = confirmedRows[rowNum - 1] || [];
      if (String(r[0] || "").trim().toLowerCase() === clientName && String(r[1] || "").trim().toLowerCase() === jobName) {
        targetRow = r;
      }
    }
    if (!targetRow) {
      for (let i = 1; i < confirmedRows.length; i++) {
        const r = confirmedRows[i] || [];
        if (String(r[0] || "").trim().toLowerCase() === clientName && String(r[1] || "").trim().toLowerCase() === jobName) {
          targetRow = r;
          break;
        }
      }
    }
    if (!targetRow) return false; // Job gone from Confirmed -> resolved!

    const headers = (confirmedRows[0] || []).map(h => String(h || "").toLowerCase().trim());
    const findHeaderIdx = (patterns) => {
      for (const pat of patterns) {
        const idx = headers.indexOf(pat.toLowerCase().trim());
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const colAppId = findHeaderIdx([`dir inv ${slotNum} app id`, `dir inv. ${slotNum} app id`, `direct inv ${slotNum} app id`]);
    const colAmt = findHeaderIdx([`direct inv ${slotNum} amt`, `direct inv ${slotNum} amount`, `dir inv ${slotNum} amt`]);
    const colStat = findHeaderIdx([`dir inv ${slotNum} status`, `direct inv ${slotNum} status`]);

    const currentId = colAppId !== -1 ? String(targetRow[colAppId] || "").trim() : "";
    const currentAmt = colAmt !== -1 ? String(targetRow[colAmt] || "").trim() : "";
    const currentStatus = colStat !== -1 ? String(targetRow[colStat] || "").trim().toLowerCase() : "";

    if (currentId && !isPlaceholderExpense(currentId)) return false; // Real expense received -> resolved!
    if (currentStatus === "received" || currentStatus === "paid") return false; // Marked received/paid -> resolved!
    if (!currentId && (!currentAmt || currentAmt === "0")) return false; // Placeholder removed -> resolved!

    return true; // Still active placeholder
  }

  // 2. Outgoings tab check:
  if (line.includes("[Outgoings]")) {
    const oMatch = line.match(/\[Outgoings\]\s*(?:(?:[A-Za-z]{3}\s*\d{2}\s*[-–]\s*)?(.+?)(?:\s*\((?:Row\s*)?(\d+)\))?:\s*(?:£[0-9.,]+\s*[-–]\s*)?Updated stale placeholder date|(?:Row\s*(\d+),\s*)?([^:]+):\s*Updated stale Placeholder\/Gap date)/i);
    if (!oMatch) return true;
    const contractor = (oMatch[1] || oMatch[4] || "").trim().toLowerCase();
    const rowNum = parseInt(oMatch[2] || oMatch[3] || "0", 10);
    if (!contractor) return true;

    try {
      let actualRowNum = rowNum;
      if (!actualRowNum) {
        const outResp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId, range: "Outgoings!A1:A300"
        }));
        const outRows = outResp.data.values || [];
        for (let i = 0; i < outRows.length; i++) {
          if (String(outRows[i]?.[0] || "").trim().toLowerCase() === contractor) {
            actualRowNum = i + 1;
            break;
          }
        }
      }
      if (!actualRowNum) return false; // Contractor no longer in Outgoings -> resolved!

      const noteResp = await withRetry(() => sheets.spreadsheets.get({
        spreadsheetId: clientSheetId,
        ranges: [`Outgoings!A${actualRowNum}:AZ${actualRowNum}`],
        fields: "sheets(data(rowData(values(note))))",
      }));
      const rowCells = noteResp?.data?.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || [];
      let hasUnresolved = false;
      for (const cell of rowCells) {
        const note = String(cell.note || "");
        if (note.includes("PLACE-EXP") || note.includes("MANUAL-ENTRY") || note.includes("UNRECON-GAP") || note.includes("PLACE-GAP") || note.includes("MANUAL-GAP")) {
          const statusMatch = note.match(/\{Status:\s*(.*?)\}/i);
          const st = statusMatch ? statusMatch[1].trim().toLowerCase() : "";
          if (st !== "paid" && st !== "complete") {
            hasUnresolved = true;
            break;
          }
        }
      }
      return hasUnresolved; // If no unresolved placeholders, it is resolved!
    } catch (e) {
      return true;
    }
  }

  return true;
}

export async function handleRunFlagSweep(req, res, sheets) {
  const { secret: sweepSecret, automationCommanderSheetId: acIdSweep, startIdx = 0 } = req.body;
  if (sweepSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorised" });
  }
  if (!acIdSweep) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });

  const sweepStart = Date.now();
  let clientsChecked = 0, flagsRaised = 0, errors = 0;
  let alertsDelayed = 0, alertsWoken = 0;
  let raisedDetail = [];
  let categoriesRunStr = "";
  try {
    const { clientRows } = await readAutoUpdatesClientRows_(sheets, acIdSweep);

    await ensureSweepScheduleTab(sheets, acIdSweep);
    const schedule = await readSweepSchedule_(sheets, acIdSweep);
    const isForced = req.body.forceProactive === true || req.body.forceAll === true;
    const actionableDue = isForced || isCategoryDue_(schedule.actionable);
    const infoDue = isForced || isCategoryDue_(schedule.info);
    const proactiveDue = isForced || isCategoryDue_(schedule.proactive);
    categoriesRunStr = [actionableDue ? "act" : "", infoDue ? "info" : "", proactiveDue ? "pro" : ""].filter(Boolean).join(",");
    console.log(`run_flag_sweep: actionableDue=${actionableDue}, infoDue=${infoDue}, proactiveDue=${proactiveDue}`);

    const CHUNK_SIZE = proactiveDue ? 1 : 3;
    const clientChunk = clientRows.slice(startIdx, startIdx + CHUNK_SIZE);
    const hasMore = startIdx + CHUNK_SIZE < clientRows.length;
    const nextIdx = startIdx + CHUNK_SIZE;

    console.log(`run_flag_sweep: processing clients ${startIdx + 1} to ${Math.min(startIdx + CHUNK_SIZE, clientRows.length)} of ${clientRows.length}`);

    const freqResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: acIdSweep,
      range: "AutoUpdates!O2:Q1000",
    });
    const freqRows = freqResponse.data.values || [];

    const sweepItems = [];

    for (const client of clientChunk) {
      try {
        const freqRow = freqRows[client.rowIndex] || [];
        const hasInvoice = !!freqRow[0];
        const hasCRM = !!freqRow[1];
        const hasExpense = !!freqRow[2];

        console.log(`  📦 Batch fetching static data for ${client.clientName}...`);
        let batchData = {};
        try {
          const batchResp = await sheets.spreadsheets.values.batchGet({
            spreadsheetId: client.masterSheetId,
            ranges: [
              "DataChgAlert!B4:I4",
              (hasInvoice && actionableDue) ? "InvComp!A5:BD1000" : "DataChgAlert!A1",
              (hasExpense && actionableDue) ? "DirComp!A5:AV1000" : "DataChgAlert!A1",
              (infoDue || proactiveDue) ? "AutoLog!A2:D200" : "DataChgAlert!A1"
            ]
          });
          const ranges = batchResp.data.valueRanges || [];
          batchData.gasLocks = ranges[0]?.values || [];
          batchData.invComp = ranges[1]?.values || [];
          batchData.dirComp = ranges[2]?.values || [];
          batchData.autoLog = ranges[3]?.values || [];
        } catch (e) {
          console.log(`  ⚠️ Batch fetch failed for ${client.clientName}: ${e.message}`);
        }

        const gasLocks = await checkAllGASLocks(sheets, client.masterSheetId, batchData.gasLocks);

        if (hasInvoice && actionableDue) {
          const invLock = gasLocks.invoice;
          if (!invLock.locked) {
            const invAlerts = await readInvCompAlerts(sheets, client.masterSheetId, batchData.invComp);
            invAlerts.forEach(a => {
              a.clientName = client.clientName;
              a.clientId = client.clientSheetId;
              a.masterSheetId = client.masterSheetId;
              a.flagType = "invoiceDashboardDiscr";
              a._fingerprint = buildAlertFingerprint(a);
              a._legacyFingerprint = buildAlertFingerprintLegacy(a);
            });
            sweepItems.push({
              clientName: client.clientName, alertType: "invoiceDashboardDiscr",
              alerts: invAlerts,
              autoUpdatesRow: client.sheetRowNum,
              category: "discrepancy",
            });
          }
        }

        console.log(`\n🔍 DIRCOMP GATES FOR ${client.clientName}: hasExpense=${hasExpense}, actionableDue=${actionableDue}, expLock=${gasLocks.expense?.locked}`);

        if (hasExpense && actionableDue) {
          const expLock = gasLocks.expense;
          if (!expLock.locked) {
            console.log(`  -> Passing to readDirCompAlerts for ${client.clientName}`);
            const expAlerts = await readDirCompAlerts(sheets, client.masterSheetId);
            expAlerts.forEach(a => {
              a.clientName = client.clientName;
              a.clientId = client.clientSheetId;
              a.masterSheetId = client.masterSheetId;
              a.flagType = "expenseDashboardDiscr";
              a._fingerprint = buildAlertFingerprint(a);
              a._legacyFingerprint = buildAlertFingerprintLegacy(a);
            });
            sweepItems.push({
              clientName: client.clientName, alertType: "expenseDashboardDiscr",
              alerts: expAlerts,
              autoUpdatesRow: client.sheetRowNum,
              category: "discrepancy",
            });
          }
        }

        if (hasCRM && actionableDue) {
          const crmLock = gasLocks.crm;
          if (!crmLock.locked) {
            for (const [mode, dashKey, appKey] of [["Pipeline", "crmPipeDashDiscr", "crmPipeAppDiscr"], ["Confirmed", "crmConfDashDiscr", "crmConfAppDiscr"]]) {
              const crmAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, mode, [dashKey, appKey], client.masterSheetId);
              crmAlerts.forEach(a => {
                a.clientName = client.clientName;
                a.clientId = client.clientSheetId;
                a.masterSheetId = client.masterSheetId;
                a._fingerprint = buildAlertFingerprint(a);
                a._legacyFingerprint = buildAlertFingerprintLegacy(a);
              });
              const dashAlerts = crmAlerts.filter(a => (a.flagType || a.alertType) === dashKey);
              const appAlerts = crmAlerts.filter(a => (a.flagType || a.alertType) === appKey);
              sweepItems.push({ clientName: client.clientName, alertType: dashKey, alerts: dashAlerts, autoUpdatesRow: client.sheetRowNum, category: "discrepancy" });
              sweepItems.push({ clientName: client.clientName, alertType: appKey, alerts: appAlerts, autoUpdatesRow: client.sheetRowNum, category: "discrepancy" });
            }
          }
        }

        if (infoDue) {
          const logEntries = await readRecentAutoLogEntries_(sheets, client.masterSheetId, 200, batchData.autoLog);
          for (const [autoLogType, patterns] of Object.entries(AUTOLOG_TYPE_PATTERNS)) {
            const matchedAlerts = [];
            for (const entry of logEntries) {
              const lines = (entry.details || "").split(/\n+/);
              const ts = entry.timestamp ? (entry.timestamp instanceof Date ? entry.timestamp.toISOString() : String(entry.timestamp).trim()) : "";
              for (const line of lines) {
                if (!patterns.some(p => line.includes(p))) continue;
                if (autoLogType === "crmCopiedConfChecked") {
                  if (line.includes("Skipped Copy: Job with Project Code") || line.includes("already exists in Confirmed")) continue;
                }
                if (autoLogType === "expenseUnreconGaps") {
                  const isActive = await isExpensePlaceholderStillActive_(line, client.clientSheetId, null, sheets);
                  if (!isActive) continue; // Skip: underlying expense already resolved in sheet
                }
                if (autoLogType === "invoiceStaleUnsentChanges") {
                  const isActive = await isInvoicePlaceholderStillActive_(line, client.clientSheetId, null, sheets);
                  if (!isActive) continue; // Skip: underlying invoice already resolved in sheet
                }
                const fingerprintInput = `${client.clientName}|${autoLogType}|${ts}|${line}`;
                const legacyFingerprintInput = `${client.clientName}|${autoLogType}|${line}`;
                matchedAlerts.push({
                  clientName: client.clientName,
                  alertType: autoLogType,
                  summary: line,
                  timestamp: ts,
                  _fingerprint: createHash("sha256").update(fingerprintInput).digest("hex").substring(0, 16),
                  _legacyFingerprint: createHash("sha256").update(legacyFingerprintInput).digest("hex").substring(0, 16),
                });
              }
            }
            if (matchedAlerts.length > 0 || autoLogType === "expenseUnreconGaps" || autoLogType === "invoiceStaleUnsentChanges") {
              sweepItems.push({ clientName: client.clientName, alertType: autoLogType, alerts: matchedAlerts, autoUpdatesRow: client.sheetRowNum, category: "info" });
            }
          }
        }

        if (proactiveDue) {
          console.log(`  🔍 Running proactive checks for ${client.clientName}...`);
          let sharedData = { confirmedData: null, pipelineData: null, autoLogData: batchData.autoLog || null };
          let fetchSuccess = false;

          try {
            const clientBatchResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
              spreadsheetId: client.clientSheetId,
              ranges: [
                "Confirmed!A1:CR5000",
                "Pipeline!A1:DD5000"
              ],
              valueRenderOption: "UNFORMATTED_VALUE"
            }));
            sharedData.confirmedData = clientBatchResp.data.valueRanges[0]?.values || [];
            sharedData.pipelineData = clientBatchResp.data.valueRanges[1]?.values || [];
            fetchSuccess = true;
          } catch (e) {
            console.log(`  ⚠️ Failed to fetch Confirmed/Pipeline for proactive checks: ${e.message}`);
          }

          if (fetchSuccess) {
            const proChecks = [
              checkRetainerInvoices_(client.clientName, client.clientSheetId, client.masterSheetId, sharedData, sheets),
              checkCRMWipe_(client.clientName, client.masterSheetId, sharedData),
              checkRevenueMismatch_(client.clientName, client.clientSheetId, sharedData),
              checkDirectCostsMismatch_(client.clientName, client.clientSheetId, sharedData),
              checkPipelineConfirmedOverlap_(client.clientName, client.clientSheetId, sharedData),
              checkRetainerShrinkBlocked_(client.clientName, client.masterSheetId, sharedData),
              checkUninvoicedNewJobs_(client.clientName, client.clientSheetId, sharedData),
              checkUninvoicedRevenue_(client.clientName, client.clientSheetId, sharedData),
              checkDeletedInvoices_(client.clientName, client.clientSheetId, client.masterSheetId, sharedData, sheets),
              checkJobStructureErrors_(client.clientName, client.clientSheetId, sharedData),
              checkDeletedExpenses_(client.clientName, client.clientSheetId, client.masterSheetId, sharedData, sheets),
              checkUnreceivedExpenses_(client.clientName, client.clientSheetId, sharedData),
              checkAutoLogErrors_(client.clientName, client.masterSheetId, sharedData),
              checkAutoLogInfiniteLoops_(client.clientName, client.masterSheetId, sharedData),
              checkStaleUnreconGapExpenses_(client.clientName, client.clientSheetId, sharedData, sheets),
              checkRetroactiveOutgoingsChanges_(client.clientName, client.masterSheetId, sharedData),
              checkQuarantinedPLCategories_(client.clientName, client.masterSheetId, sharedData, sheets),
              checkPartPaidBalances_(client.clientName, client.clientSheetId, client.masterSheetId, sharedData, sheets)
            ];

            const proResults = await Promise.all(proChecks);
            const proAlerts = proResults.flat();

            // Precedence rule: "uninvoiced_revenue" takes precedence over "uninvoiced_new_job" for the same job
            const completedJobKeys = new Set(
              proAlerts
                .filter(a => a.alertType === "uninvoiced_revenue" && a.stableJobKey)
                .map(a => a.stableJobKey)
            );
            const activeProAlerts = completedJobKeys.size > 0
              ? proAlerts.filter(a => {
                if (a.alertType === "uninvoiced_new_job" && a.stableJobKey && completedJobKeys.has(a.stableJobKey)) {
                  console.log(`  Superseding uninvoiced_new_job alert for ${client.clientName} [${a.stableJobKey}] in favour of uninvoiced_revenue`);
                  return false;
                }
                return true;
              })
              : proAlerts;

            const proactiveTypes = [
              "retainer_invoice", "crm_wipe", "revenue_mismatch", "direct_costs_mismatch",
              "pipeline_confirmed_overlap", "retainer_shrink_blocked", "uninvoiced_new_job", "uninvoiced_revenue",
              "deleted_invoice", "job_structure_error", "deleted_expense", "unreceived_expenses",
              "autolog_error", "infinite_loop", "stale_unrecon_gap", "retroactive_outgoings_update",
              "unmapped_pl_category", "part_paid_balance"
            ];

            const groupedProactive = {};
            proactiveTypes.forEach(t => groupedProactive[t] = []);

            activeProAlerts.forEach(a => {
              const fpInput = a.alertKey;
              a._fingerprint = createHash("sha256").update(fpInput).digest("hex").substring(0, 16);
              if (a.legacyAlertKey) {
                a._legacyFingerprint = createHash("sha256").update(a.legacyAlertKey).digest("hex").substring(0, 16);
              }
              a.summary = a.heading || a.detail || a.alertType;
              if (groupedProactive[a.alertType]) groupedProactive[a.alertType].push(a);
            });

            proactiveTypes.forEach(type => {
              sweepItems.push({
                clientName: client.clientName,
                alertType: type,
                alerts: groupedProactive[type],
                autoUpdatesRow: client.sheetRowNum,
                category: "proactive"
              });
            });

            if (activeProAlerts.length > 0) {
              console.log(`  ✓ Proactive checks found ${activeProAlerts.length} alerts for ${client.clientName}`);
            }
          } else {
            console.log(`  ⏭ Skipping proactive checks for ${client.clientName} due to fetch failure to prevent false auto-resolves.`);
          }
        }

        clientsChecked++;
      } catch (clientErr) {
        errors++;
        console.error(`  run_flag_sweep: error for ${client.clientName}: ${clientErr.message}`);
      }

      await new Promise(r => setTimeout(r, 1200));
    }

    if (sweepItems.length > 0) {
      await ensureAlertMemoryTab(sheets, acIdSweep);
      const memoryRows = await readAlertMemory(sheets, acIdSweep);
      const handledHashes = getHandledFingerprintHashes_(memoryRows);
      const existingHashes = new Set(memoryRows.map(r => r.fingerprintHash).filter(Boolean));
      console.log(`  run_flag_sweep: ${sweepItems.length} fingerprint items to resolve, ${handledHashes.size} handled hashes, ${existingHashes.size} existing hashes`);

      const clientMetaMap = new Map(clientChunk.map(c => [c.clientName, c]));

      // Auto-resolve any legacy/cached "crmCopiedConfChecked" rows triggered by skipped duplicate copies
      const invalidCrmRows = memoryRows.filter(r =>
        r.alertType === "crmCopiedConfChecked" &&
        (r.status === "cached" || r.status === "pending_automation") &&
        (String(r.alertSummary || "").includes("Skipped Copy: Job with Project Code") ||
          String(r.alertSummary || "").includes("already exists in Confirmed"))
      );
      for (const invRow of invalidCrmRows) {
        try {
          await updateAlertMemoryRow(sheets, acIdSweep, invRow.rowIndex, {
            ...invRow,
            status: "auto_resolved",
            lastRechecked: new Date().toISOString()
          });
          invRow.status = "auto_resolved";
          console.log(`  🩹 AUTO-RESOLVED skipped duplicate crmCopiedConfChecked row for ${invRow.clientName}: ${invRow.fingerprintHash}`);
        } catch (e) {
          console.log(`  ⚠️ Failed to auto-resolve invalid crmCopiedConfChecked row: ${e.message}`);
        }
      }

      // Auto-resolve any legacy/cached "uninvoiced_new_job" rows superseded by "uninvoiced_revenue" for the same job
      const revenueJobKeys = new Set();
      memoryRows.forEach(r => {
        if (r.alertType === "uninvoiced_revenue" && (r.status === "cached" || r.status === "task" || r.status === "accepted" || r.status === "pending_automation")) {
          try {
            const snap = JSON.parse(r.dataSnapshot || "{}");
            const jobKey = snap.stableJobKey || snap.metadata?.stableJobKey;
            if (jobKey) revenueJobKeys.add(`${r.clientName}:::${jobKey}`);
          } catch (e) { }
        }
      });
      sweepItems.forEach(item => {
        if (item.alertType === "uninvoiced_revenue") {
          (item.alerts || []).forEach(a => {
            const jobKey = a.stableJobKey || a.metadata?.stableJobKey;
            if (jobKey) revenueJobKeys.add(`${item.clientName}:::${jobKey}`);
          });
        }
      });

      if (revenueJobKeys.size > 0) {
        const supersededNewJobRows = memoryRows.filter(r =>
          r.alertType === "uninvoiced_new_job" &&
          (r.status === "cached" || r.status === "pending_automation") &&
          (() => {
            try {
              const snap = JSON.parse(r.dataSnapshot || "{}");
              const jobKey = snap.stableJobKey || snap.metadata?.stableJobKey;
              return jobKey && revenueJobKeys.has(`${r.clientName}:::${jobKey}`);
            } catch (e) { return false; }
          })()
        );
        for (const sRow of supersededNewJobRows) {
          try {
            let updatedSnapshot = sRow.dataSnapshot;
            try {
              const snap = JSON.parse(sRow.dataSnapshot || "{}");
              snap.autoResolvedReason = "Superseded by completed job uninvoiced revenue alert";
              updatedSnapshot = JSON.stringify(snap);
            } catch (e) { }
            await updateAlertMemoryRow(sheets, acIdSweep, sRow.rowIndex, {
              ...sRow,
              status: "auto_resolved",
              lastRechecked: new Date().toISOString(),
              dataSnapshot: updatedSnapshot
            });
            sRow.status = "auto_resolved";
            console.log(`  Auto-resolved superseded uninvoiced_new_job row for ${sRow.clientName} (Row ${sRow.rowIndex}) in favour of uninvoiced_revenue`);
          } catch (e) {
            console.log(`  Failed to auto-resolve superseded uninvoiced_new_job row: ${e.message}`);
          }
        }
      }

      for (const item of sweepItems) {
        if (item.category === "discrepancy" || item.category === "proactive" || item.alertType === "expenseUnreconGaps" || item.alertType === "invoiceStaleUnsentChanges") {
          const freshHashes = new Set();
          (item.alerts || []).forEach(a => {
            if (a._fingerprint) freshHashes.add(a._fingerprint);
            if (a._legacyFingerprint) freshHashes.add(a._legacyFingerprint);
            if (item.alertType === "autolog_error" || item.alertType === "infinite_loop") {
              memoryRows.forEach(r => {
                if (r.clientName === item.clientName && r.alertType === item.alertType) {
                  try {
                    const snap = JSON.parse(r.dataSnapshot || "{}");
                    if (snap.legacyAlertKey === a.alertKey || (snap.alertKey && snap.alertKey.startsWith(a.alertKey + "|"))) {
                      freshHashes.add(r.fingerprintHash);
                    }
                  } catch (e) { }
                }
              });
            }
          });
          const staleRows = memoryRows.filter(r =>
            r.clientName === item.clientName &&
            r.alertType === item.alertType &&
            (r.status === "cached" || r.status === "pending_automation" || (item.category === "proactive" && (r.status === "task" || r.status === "accepted"))) &&
            !freshHashes.has(r.fingerprintHash)
          );

          for (const stale of staleRows) {
            try {
              let updatedSnapshot = stale.dataSnapshot;
              let wasTask = false;
              if (stale.status === "task") {
                wasTask = true;
                try {
                  const snap = JSON.parse(stale.dataSnapshot || "{}");
                  snap.resolvedAt = new Date().toISOString();
                  snap.autoResolvedReason = "Underlying proactive alert condition no longer detected";
                  updatedSnapshot = JSON.stringify(snap);
                } catch (e) { }
              }

              const newStatus = stale.status === "task" ? "task_resolved" : "auto_resolved";

              await updateAlertMemoryRow(sheets, acIdSweep, stale.rowIndex, {
                ...stale,
                status: newStatus,
                lastRechecked: new Date().toISOString(),
                dataSnapshot: updatedSnapshot
              });
              console.log(`  🩹 AUTO-RESOLVED stale ${item.alertType} ${stale.status} for ${item.clientName}: ${stale.fingerprintHash} -> ${newStatus}`);
              stale.status = newStatus;

              if (wasTask) {
                await redisClient.del("triage_tasks_cache").catch(() => { });
              }
            } catch (e) {
              console.log(`  ⚠️ Failed to auto-resolve stale alert: ${e.message}`);
            }
          }

          const clientMeta = clientMetaMap.get(item.clientName);
          const pendingAutoRows = memoryRows.filter(r =>
            r.clientName === item.clientName &&
            r.alertType === item.alertType &&
            r.status === "pending_automation" &&
            freshHashes.has(r.fingerprintHash)
          );

          for (const pRow of pendingAutoRows) {
            let snap = {};
            try { snap = JSON.parse(pRow.dataSnapshot || "{}"); } catch (e) { }
            const detectedAt = snap.detectedAt ? new Date(snap.detectedAt).getTime() : Date.now();
            const firstSeen = pRow.firstSeen ? new Date(pRow.firstSeen).getTime() : null;
            const newStatus = evaluateAutomationStatus_(item.alertType, item.category, clientMeta, detectedAt, firstSeen);

            if (newStatus === "cached") {
              try {
                await updateAlertMemoryRow(sheets, acIdSweep, pRow.rowIndex, {
                  ...pRow,
                  status: "cached",
                  lastRechecked: new Date().toISOString()
                });
                console.log(`  ⏰ Woke up pending_automation alert for ${item.clientName}: ${pRow.fingerprintHash}`);
                pRow.status = "cached";
                alertsWoken++;
                raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "woken" });
              } catch (e) {
                console.log(`  ⚠️ Failed to wake up alert: ${e.message}`);
              }
            }
          }
        }

        if (!item.alerts || item.alerts.length === 0) continue;

        for (const alert of item.alerts) {
          try {
            let summary = alert.summary;
            if (typeof summary === "object" && summary !== null) {
              summary = summary.summary;
            }
            if (!summary && (item.alertType.startsWith("crmPipe") || item.alertType.startsWith("crmConf"))) {
              const crmArr = alert.data?.crmData || [];
              const shtArr = alert.data?.sheetData || [];
              const client = crmArr[0] || shtArr[1] || "";
              const job = crmArr[1] || shtArr[2] || "";
              const code = crmArr[2] || shtArr[0] || "";
              const jobDesc = [client, job, code].filter(Boolean).join(" - ");
              summary = `CRM ${item.alertType} ${jobDesc}`.trim();
            }
            summary = summary || `${item.alertType} - ${item.clientName} (row ${alert.rowNumber})`;

            // Priority candidate match: find all matching rows across modern hash, legacy hash, and snapshot alertKey
            const candidateMatches = memoryRows.filter(r => {
              if (r.clientName !== item.clientName) return false;
              if (r.fingerprintHash === alert._fingerprint) return true;
              if (alert._legacyFingerprint && r.fingerprintHash === alert._legacyFingerprint) return true;
              if (item.alertType === "autolog_error" || item.alertType === "infinite_loop") {
                if (r.alertType === item.alertType) {
                  try {
                    const snap = JSON.parse(r.dataSnapshot || "{}");
                    const k = snap.alertKey || snap.legacyAlertKey || "";
                    if (k === alert.alertKey || k === alert.legacyAlertKey) return true;
                    if (alert.alertKey && k.startsWith(alert.alertKey + "|")) return true;
                  } catch (e) { }
                }
              }
              return false;
            });

            // Priority: Handled (accepted/ignored/task/pending_automation) > Active (cached) > Inactive (auto_resolved/superseded/task_resolved)
            // Tie-break: highest rowIndex (most recent entry in sheet)
            const statusPriority = (s) => {
              if (s === "accepted" || s === "ignored" || s === "task" || s === "pending_automation") return 3;
              if (s === "cached") return 2;
              return 1;
            };
            candidateMatches.sort((a, b) => {
              const pd = statusPriority(b.status) - statusPriority(a.status);
              if (pd !== 0) return pd;
              return (b.rowIndex || 0) - (a.rowIndex || 0);
            });

            let exRow = candidateMatches[0] || null;

            // If there are duplicate rows and the winning row is handled, suppress any duplicate cached/pending rows so they don't appear in PMA or revive
            if (candidateMatches.length > 1 && exRow && (exRow.status === "accepted" || exRow.status === "ignored" || exRow.status === "task")) {
              for (const dup of candidateMatches.slice(1)) {
                if (dup.status === "cached" || dup.status === "pending_automation") {
                  try {
                    await updateAlertMemoryRow(sheets, acIdSweep, dup.rowIndex, {
                      ...dup,
                      status: "superseded",
                      lastRechecked: detectedAtIso
                    });
                    dup.status = "superseded";
                    console.log(`  🧹 SUPPRESSED duplicate cached row ${dup.rowIndex} for ${item.clientName} (authoritative row is ${exRow.rowIndex} ${exRow.status})`);
                  } catch (e) { }
                }
              }
            }

            const detectedAtIso = new Date().toISOString();
            const { _fingerprint, _legacyFingerprint, ...alertForSnapshot } = alert;
            alertForSnapshot.detectedAt = detectedAtIso;

            if (exRow) {
              // Case 1: Auto-resolved Task that returned
              if (exRow.status === "task_resolved") {
                let snap = {};
                try { snap = JSON.parse(exRow.dataSnapshot || "{}"); } catch (e) { }
                if (snap.autoResolvedReason) {
                  delete snap.resolvedAt;
                  delete snap.autoResolvedReason;
                  const furtherNotes = Array.isArray(snap.furtherNotes) ? snap.furtherNotes : [];
                  furtherNotes.push({
                    date: detectedAtIso,
                    note: "[Auto-Reopened] Underlying alert condition detected again on sheet"
                  });
                  snap.furtherNotes = furtherNotes;
                  snap.detectedAt = detectedAtIso;

                  await updateAlertMemoryRow(sheets, acIdSweep, exRow.rowIndex, {
                    ...exRow,
                    fingerprintHash: alert._fingerprint,
                    status: "task",
                    alertSummary: summary,
                    lastRechecked: detectedAtIso,
                    dataSnapshot: JSON.stringify(snap)
                  });
                  exRow.status = "task";
                  exRow.fingerprintHash = alert._fingerprint;
                  await redisClient.del("triage_tasks_cache").catch(() => { });
                  flagsRaised++;
                  console.log(`  🔄 REVIVED auto-resolved task for ${item.clientName}: ${summary}`);
                  raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "task_reopened" });
                  continue;
                }
              }

              // Case 2: Auto-resolved regular alert that returned (never revive alerts that have an ignore reason)
              if ((exRow.status === "auto_resolved" || exRow.status === "superseded") && !exRow.ignoreReason) {
                const clientMeta = clientMetaMap.get(item.clientName);
                const newStatus = evaluateAutomationStatus_(item.alertType, item.category, clientMeta, new Date(detectedAtIso).getTime(), null);

                await updateAlertMemoryRow(sheets, acIdSweep, exRow.rowIndex, {
                  ...exRow,
                  fingerprintHash: alert._fingerprint,
                  status: newStatus,
                  alertSummary: summary,
                  lastRechecked: detectedAtIso,
                  dataSnapshot: JSON.stringify(alertForSnapshot)
                });
                exRow.status = newStatus;
                exRow.fingerprintHash = alert._fingerprint;

                if (newStatus === "pending_automation") {
                  alertsDelayed++;
                  raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "delayed" });
                } else {
                  flagsRaised++;
                  raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "revived" });
                }
                console.log(`  🔄 REVIVED auto-resolved alert for ${item.clientName} (${item.alertType}): ${alert._fingerprint} -> ${newStatus}`);
                continue;
              }

              // Case 3: Previously ignored or accepted (including any alert that has an ignore reason)
              if (exRow.status === "ignored" || exRow.status === "accepted" || exRow.ignoreReason) {
                let oldSnap = {};
                try { oldSnap = JSON.parse(exRow.dataSnapshot || "{}"); } catch (e) { }

                // Determine whether the underlying situation has genuinely changed since acknowledgment:
                let situationChanged = false;
                const isLegacyMatch = exRow.fingerprintHash !== alert._fingerprint && exRow.fingerprintHash === alert._legacyFingerprint;

                // 1. autolog_error: newer timestamp or higher occurrence count (or unverified legacy snapshot)
                if (item.alertType === "autolog_error") {
                  if (isLegacyMatch && !oldSnap.timestamp && !oldSnap.occurrenceCount) {
                    situationChanged = true;
                  } else {
                    const hasNewTimestamp = alert.timestamp && oldSnap.timestamp && alert.timestamp !== oldSnap.timestamp;
                    const hasMoreOccurrences = alert.occurrenceCount && oldSnap.occurrenceCount && Number(alert.occurrenceCount) > Number(oldSnap.occurrenceCount);
                    if (hasNewTimestamp || hasMoreOccurrences) situationChanged = true;
                  }
                }
                // 2. infinite_loop: newer oscillation timestamp or higher count (or unverified legacy snapshot)
                else if (item.alertType === "infinite_loop") {
                  if (isLegacyMatch && !oldSnap.timestamp && !oldSnap.occurrenceCount) {
                    situationChanged = true;
                  } else {
                    if (alert.timestamp && oldSnap.timestamp && alert.timestamp !== oldSnap.timestamp) situationChanged = true;
                    if (alert.occurrenceCount && oldSnap.occurrenceCount && Number(alert.occurrenceCount) > Number(oldSnap.occurrenceCount)) situationChanged = true;
                  }
                }
                // 3. Informational alerts: new AutoLog entry timestamp (or unverified legacy snapshot)
                else if (item.category === "info") {
                  if (isLegacyMatch && !oldSnap.timestamp) {
                    situationChanged = true;
                  } else {
                    if (alert.timestamp && oldSnap.timestamp && alert.timestamp !== oldSnap.timestamp) situationChanged = true;
                  }
                }
                // 4. Proactive state alerts: key figures changed compared to acknowledged snapshot (evaluated for accepted state)
                else if (item.category === "proactive" && exRow.status === "accepted") {
                  const hasFiguresInSnapshot = oldSnap.revenue !== undefined ||
                    oldSnap.totalInvoiced !== undefined ||
                    oldSnap.directCosts !== undefined ||
                    oldSnap.totalExpenses !== undefined ||
                    oldSnap.uninvoicedAmount !== undefined ||
                    oldSnap.unreceivedAmount !== undefined ||
                    oldSnap.childExp !== undefined ||
                    oldSnap.expectedForRow !== undefined;

                  if (isLegacyMatch && !hasFiguresInSnapshot) {
                    // Safety-First: Legacy row has no snapshot figures to verify against.
                    // Revive so the user can verify rather than silently suppressing a potentially changed issue.
                    situationChanged = true;
                  } else {
                    if (alert.revenue !== undefined && oldSnap.revenue !== undefined && String(alert.revenue) !== String(oldSnap.revenue)) situationChanged = true;
                    if (alert.totalInvoiced !== undefined && oldSnap.totalInvoiced !== undefined && String(alert.totalInvoiced) !== String(oldSnap.totalInvoiced)) situationChanged = true;
                    if (alert.directCosts !== undefined && oldSnap.directCosts !== undefined && String(alert.directCosts) !== String(oldSnap.directCosts)) situationChanged = true;
                    if (alert.totalExpenses !== undefined && oldSnap.totalExpenses !== undefined && String(alert.totalExpenses) !== String(oldSnap.totalExpenses)) situationChanged = true;
                    if (alert.uninvoicedAmount !== undefined && oldSnap.uninvoicedAmount !== undefined && String(alert.uninvoicedAmount) !== String(oldSnap.uninvoicedAmount)) situationChanged = true;
                    if (alert.unreceivedAmount !== undefined && oldSnap.unreceivedAmount !== undefined && String(alert.unreceivedAmount) !== String(oldSnap.unreceivedAmount)) situationChanged = true;
                    if (alert.childExp !== undefined && oldSnap.childExp !== undefined && String(alert.childExp) !== String(oldSnap.childExp)) situationChanged = true;
                    if (alert.expectedForRow !== undefined && oldSnap.expectedForRow !== undefined && String(alert.expectedForRow) !== String(oldSnap.expectedForRow)) situationChanged = true;
                  }
                }

                if (situationChanged) {
                  const clientMeta = clientMetaMap.get(item.clientName);
                  const newStatus = evaluateAutomationStatus_(item.alertType, item.category, clientMeta, new Date(detectedAtIso).getTime(), null);
                  await updateAlertMemoryRow(sheets, acIdSweep, exRow.rowIndex, {
                    ...exRow,
                    fingerprintHash: alert._fingerprint,
                    status: newStatus,
                    alertSummary: summary,
                    lastRechecked: detectedAtIso,
                    dataSnapshot: JSON.stringify(alertForSnapshot)
                  });
                  exRow.status = newStatus;
                  exRow.fingerprintHash = alert._fingerprint;
                  flagsRaised++;
                  raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "revived" });
                  console.log(`  🔄 REVIVED accepted alert for ${item.clientName} (${item.alertType}) due to changed or unverified situation: ${alert._fingerprint} -> ${newStatus}`);
                  continue;
                }

                if (exRow.fingerprintHash !== alert._fingerprint) {
                  let mergedSnap = alertForSnapshot;
                  try {
                    const existingSnap = JSON.parse(exRow.dataSnapshot || "{}");
                    mergedSnap = { ...existingSnap, ...alertForSnapshot };
                  } catch (e) { }
                  await updateAlertMemoryRow(sheets, acIdSweep, exRow.rowIndex, {
                    ...exRow,
                    fingerprintHash: alert._fingerprint,
                    lastRechecked: detectedAtIso,
                    dataSnapshot: JSON.stringify(mergedSnap)
                  });
                  exRow.fingerprintHash = alert._fingerprint;
                  exRow.dataSnapshot = JSON.stringify(mergedSnap);
                  console.log(`  🏷️ Migrated ${exRow.status} alert hash for ${item.clientName}: ${alert._fingerprint}`);
                }
                continue;
              }

              // Case 4: Already active (cached, task, pending_automation)
              let oldSnap = {};
              try { oldSnap = JSON.parse(exRow.dataSnapshot || "{}"); } catch (e) { }
              const preservedDetectedAt = oldSnap.detectedAt || detectedAtIso;
              const snapshotToSave = { ...alertForSnapshot, detectedAt: preservedDetectedAt };

              let newSnapshotStr;
              if (exRow.status === "task") {
                newSnapshotStr = JSON.stringify({ ...oldSnap, ...snapshotToSave });
              } else {
                newSnapshotStr = JSON.stringify(snapshotToSave);
              }

              const hashNeedsMigration = exRow.fingerprintHash !== alert._fingerprint;
              if (exRow.dataSnapshot !== newSnapshotStr || exRow.alertSummary !== summary || hashNeedsMigration) {
                try {
                  await updateAlertMemoryRow(sheets, acIdSweep, exRow.rowIndex, {
                    ...exRow,
                    fingerprintHash: alert._fingerprint,
                    alertSummary: summary,
                    dataSnapshot: newSnapshotStr,
                    lastRechecked: detectedAtIso
                  });
                  exRow.fingerprintHash = alert._fingerprint;
                  exRow.dataSnapshot = newSnapshotStr;
                  console.log(`  🔄 Updated active alert for ${item.clientName}: ${exRow.fingerprintHash}`);
                } catch (e) {
                  console.log(`  ⚠️ Failed to update snapshot: ${e.message}`);
                }
              }
              continue;
            }

            // Case 5: Brand new alert!
            const clientMeta = clientMetaMap.get(item.clientName);
            const status = evaluateAutomationStatus_(item.alertType, item.category, clientMeta, new Date(detectedAtIso).getTime(), null);

            const newRow = {
              fingerprintHash: alert._fingerprint,
              alertType: item.alertType,
              clientName: item.clientName,
              alertSummary: summary,
              cachedOptionsJSON: "",
              status: status,
              category: item.category || "discrepancy",
              dataSnapshot: JSON.stringify(alertForSnapshot),
            };
            await appendAlertMemoryRow(sheets, acIdSweep, newRow);
            memoryRows.push(newRow);

            flagsRaised++;
            if (status === "pending_automation") {
              console.log(`  💤 Alert ${alert._fingerprint} is pending automation run`);
              alertsDelayed++;
              raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "delayed" });
            } else {
              raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "raised" });
            }
            console.log(`  ✅ NEW alert for ${item.clientName} / ${item.alertType}: ${alert._fingerprint}`);
          } catch (memErr) {
            console.log(`  ⚠️ Could not process AlertMemory row for ${item.clientName}/${item.alertType}: ${memErr.message}`);
          }
        }
      }
    }

    if (!hasMore) {
      try {
        if (!isForced) {
          if (actionableDue) await markCategoryChecked_(sheets, acIdSweep, "actionable", schedule);
          if (infoDue) await markCategoryChecked_(sheets, acIdSweep, "info", schedule);
          if (proactiveDue) await markCategoryChecked_(sheets, acIdSweep, "proactive", schedule);
        }
      } catch (scheduleErr) {
        console.log(`  ⚠️ Could not update SweepSchedule: ${scheduleErr.message}`);
      }
    }

    const elapsedS = Math.round((Date.now() - sweepStart) / 1000);
    console.log(`run_flag_sweep chunk complete in ${elapsedS}s: ${clientsChecked} clients checked, ${flagsRaised} flags raised, ${errors} errors, delayed: ${alertsDelayed}, woken: ${alertsWoken}, hasMore: ${hasMore}`);
    await logFlagSweepRun(sheets, acIdSweep, { clientsChecked, flagsRaised, errors, alertsDelayed, alertsWoken, elapsedSeconds: elapsedS, raisedDetail, isContinuation: startIdx > 0, categoriesRun: categoriesRunStr });
    return res.status(200).json({ success: true, clientsChecked, flagsRaised, errors, alertsDelayed, alertsWoken, elapsedSeconds: elapsedS, raisedDetail, hasMore, nextIdx });
  } catch (err) {
    console.error("❌ run_flag_sweep error:", err);
    const elapsedS = Math.round((Date.now() - sweepStart) / 1000);
    await logFlagSweepRun(sheets, acIdSweep, { clientsChecked: clientsChecked || 0, flagsRaised: flagsRaised || 0, errors: (errors || 0) + 1, alertsDelayed: alertsDelayed || 0, alertsWoken: alertsWoken || 0, elapsedSeconds: elapsedS, raisedDetail: raisedDetail || [], isContinuation: startIdx > 0, categoriesRun: categoriesRunStr || "" }).catch(() => { });
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleBuildCachedAlertOptions(req, res, sheets) {
  const { secret: buildSecret, automationCommanderSheetId: acIdBuild } = req.body;
  if (buildSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorised" });
  }
  if (!acIdBuild) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });

  const buildStart = Date.now();
  try {
    await ensureAlertMemoryTab(sheets, acIdBuild);
    const memoryRows = await readAlertMemory(sheets, acIdBuild);

    const pending = memoryRows.filter(r => {
      if ((r.status !== "cached" && r.status !== "pending_automation") || r.category !== "discrepancy") return false;
      if (Object.prototype.hasOwnProperty.call(AUTOLOG_TYPE_PATTERNS, r.alertType)) return false;
      if (!r.cachedOptionsJSON) return true;
      try {
        const parsed = JSON.parse(r.cachedOptionsJSON);
        if (!Array.isArray(parsed) || parsed.length === 0) return true;
        const isStale = parsed.some(opt => {
          const title = String(opt.title || "").toLowerCase();
          if (title.includes("no confident automatic match") || (title.includes("manual investigation") && (title.includes("no confident") || title.includes("automatic match")))) return true;
          const isInv = r.alertType?.startsWith("invoice") || r.alertType === "invoice";
          if (isInv && opt.title && opt.title.includes("CREATE NEW")) return true;
          if (opt.title && (title.includes("321 - subcontractors") || (title.includes("outgoings vendor") && (/"\s*\d+\s*-/.test(title) || /outgoings vendor "[^"]*[\(\[]/i.test(opt.title))))) return true;
          if (opt.matchType === "existing_job" || opt.matchType === "job") {
            if (opt.jobRowsData && opt.jobRowsData.length > 0) {
              const r0 = opt.jobRowsData[0] || {};
              const hasRev = r0.revenue && String(r0.revenue).trim() !== "" && String(r0.revenue).trim() !== "0";
              const hasDates = Boolean(r0.startDate || r0.endDate);
              const hasType = Boolean(r0.projectRetainer);
              if (!hasRev && !hasDates && !hasType) return true;
            }
          }
          return false;
        });
        return isStale;
      } catch (e) {
        return true;
      }
    });
    console.log(`build_cached_alert_options: ${pending.length} rows pending options`);

    const groups = new Map();
    for (const row of pending) {
      const key = `${row.clientName}::${row.alertType}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const { clientRows } = await readAutoUpdatesClientRows_(sheets, acIdBuild);
    const clientByName = new Map(clientRows.map(c => [c.clientName, c]));

    const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host || `127.0.0.1:${process.env.PORT || 3000}`;
    const protocol = req?.headers?.["x-forwarded-proto"] || (host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https");
    const prodUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
    const baseUrl = req?.body?.baseUrl || prodUrl || `${protocol}://${host}`;

    let built = 0, notFound = 0, errors = 0;
    let hasMore = false;
    let builtDetail = [];
    const TIME_LIMIT_MS = 220000;

    for (const [key, rows] of groups.entries()) {
      if (Date.now() - buildStart > TIME_LIMIT_MS) {
        console.log(`  ⏳ Time limit reached (${Math.round((Date.now() - buildStart) / 1000)}s). Exiting cleanly to avoid 300s timeout.`);
        hasMore = true;
        break;
      }

      const [clientName, alertType] = key.split("::");
      const client = clientByName.get(clientName);
      if (!client) {
        console.log(`  ⚠️ ${clientName}: not found in current client list - skipping ${rows.length} row(s)`);
        notFound += rows.length;
        continue;
      }

      try {
        console.log(`  📊 Fetching shared sheet data for ${clientName} to prevent 429 errors...`);
        let sharedData = {};
        try {
          const [confResp, pipeResp] = await Promise.all([
            withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: client.clientSheetId, range: "Confirmed!A1:CR5000", valueRenderOption: "FORMATTED_VALUE" })).catch(() => null),
            withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: client.clientSheetId, range: "Pipeline!A1:DD5000", valueRenderOption: "FORMATTED_VALUE" })).catch(() => null)
          ]);
          if (confResp) sharedData.confirmedDataWide = confResp.data.values || [];
          if (pipeResp) sharedData.pipelineData = pipeResp.data.values || [];
          console.log(`  ✓ Shared data loaded for ${clientName}`);
        } catch (e) {
          console.log(`  ⚠️ Failed to fetch shared data for ${clientName}: ${e.message}`);
        }

        let currentAlerts = [];
        if (alertType === "invoiceDashboardDiscr" || alertType === "invoice") {
          currentAlerts = await readInvCompAlerts(sheets, client.masterSheetId);
          currentAlerts.forEach(a => {
            a.clientName = client.clientName;
            a.flagType = "invoiceDashboardDiscr";
            a._fingerprint = buildAlertFingerprint(a);
            a._legacyFingerprint = buildAlertFingerprintLegacy(a);
          });
        } else if (alertType === "expenseDashboardDiscr" || alertType === "expense") {
          currentAlerts = await readDirCompAlerts(sheets, client.masterSheetId);
          currentAlerts.forEach(a => {
            a.clientName = client.clientName;
            a.flagType = "expenseDashboardDiscr";
            a._fingerprint = buildAlertFingerprint(a);
            a._legacyFingerprint = buildAlertFingerprintLegacy(a);
          });
        } else if (["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr", "crm"].includes(alertType)) {
          if (alertType === "crm") {
            const pipeAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, "Pipeline", ["crmPipeDashDiscr", "crmPipeAppDiscr"], client.masterSheetId);
            const confAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, "Confirmed", ["crmConfDashDiscr", "crmConfAppDiscr"], client.masterSheetId);
            currentAlerts = [...pipeAlerts, ...confAlerts];
            currentAlerts.forEach(a => {
              a.clientName = client.clientName;
              a._fingerprint = buildAlertFingerprint(a);
              a._legacyFingerprint = buildAlertFingerprintLegacy(a);
            });
          } else {
            const mode = alertType.startsWith("crmPipe") ? "Pipeline" : "Confirmed";
            const pairKey = alertType.endsWith("DashDiscr")
              ? [alertType, alertType.replace("DashDiscr", "AppDiscr")]
              : [alertType.replace("AppDiscr", "DashDiscr"), alertType];
            currentAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, mode, pairKey, client.masterSheetId);
            currentAlerts.forEach(a => {
              a.clientName = client.clientName;
              a._fingerprint = buildAlertFingerprint(a);
              a._legacyFingerprint = buildAlertFingerprintLegacy(a);
            });
            currentAlerts = currentAlerts.filter(a => (a.flagType || a.alertType) === alertType);
          }
        } else {
          console.log(`  ⚠️ Unknown alertType "${alertType}" for ${clientName} - skipping`);
          notFound += rows.length;
          continue;
        }

        for (const row of rows) {
          const match = currentAlerts.find(a => a._fingerprint === row.fingerprintHash || a._legacyFingerprint === row.fingerprintHash);
          if (!match) {
            console.log(`  ⏭ ${clientName}/${alertType}: fingerprint ${row.fingerprintHash.slice(0, 8)}… no longer found - marking auto_resolved`);
            try {
              await updateAlertMemoryRow(sheets, acIdBuild, row.rowIndex, {
                ...row, status: "auto_resolved"
              });
            } catch (e) {
              console.log(`  ⚠️ Failed to mark ghost row resolved: ${e.message}`);
            }
            notFound++;
            continue;
          }

          if (row.fingerprintHash !== match._fingerprint) {
            try {
              await updateAlertMemoryRow(sheets, acIdBuild, row.rowIndex, {
                ...row, fingerprintHash: match._fingerprint
              });
              row.fingerprintHash = match._fingerprint;
            } catch (e) { }
          }

          match.clientId = client.clientSheetId;
          match.masterSheetId = client.masterSheetId;
          match.clientName = client.clientName;
          match.flagType = match.flagType || alertType;
          match.fingerprintHash = row.fingerprintHash;

          try {
            const cronSecret = process.env.CRON_SECRET || "";
            const analyzeRes = await fetch(`${baseUrl}/api/triage`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${cronSecret}`,
                "x-cron-secret": cronSecret
              },
              body: JSON.stringify({ action: "analyze_alert", secret: cronSecret, alert: match, memoryRow: row, automationCommanderSheetId: acIdBuild, sharedData }),
            });
            const analyzeData = await analyzeRes.json();
            if (analyzeData.success) {
              if (analyzeData.options) {
                let updatedSnapshot = row.dataSnapshot;
                if (analyzeData.previousIgnoreReason) {
                  try {
                    const snapObj = JSON.parse(updatedSnapshot || "{}");
                    snapObj.previousIgnoreReason = analyzeData.previousIgnoreReason;
                    updatedSnapshot = JSON.stringify(snapObj);
                  } catch (e) { }
                }
                await updateAlertMemoryRow(sheets, acIdBuild, row.rowIndex, {
                  ...row,
                  cachedOptionsJSON: JSON.stringify(analyzeData.options),
                  dataSnapshot: updatedSnapshot
                });
              }
              built++;
              builtDetail.push({ clientName, flagKey: alertType, fromCache: !!analyzeData.fromCache });
              console.log(`  ✅ ${clientName}/${alertType}: options built`);
            } else {
              errors++;
              console.log(`  ❌ ${clientName}/${alertType}: analyze_alert failed - ${analyzeData.error || "unknown"}`);
            }
          } catch (fetchErr) {
            errors++;
            console.log(`  ❌ ${clientName}/${alertType}: analyze_alert call failed - ${fetchErr.message}`);
          }

          await new Promise(r => setTimeout(r, 1200));
        }
      } catch (groupErr) {
        errors += rows.length;
        console.log(`  ❌ ${clientName}/${alertType}: group processing failed - ${groupErr.message}`);
      }
    }

    const elapsedS = Math.round((Date.now() - buildStart) / 1000);
    console.log(`build_cached_alert_options complete in ${elapsedS}s: ${built} built, ${notFound} not found, ${errors} errors, hasMore: ${hasMore}`);

    const RICH_INFO_TYPES = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete",
      "retainerInvoicesCreated", "retainerInvoicesDeleted", "invoiceStaleUnsentChanges"];
    const pendingRich = memoryRows.filter(r =>
      r.status === "cached" && RICH_INFO_TYPES.includes(r.alertType) && !r.cachedOptionsJSON &&
      !(r.alertType === "crmCopiedConfChecked" && (
        String(r.alertSummary || "").includes("Skipped Copy: Job with Project Code") ||
        String(r.alertSummary || "").includes("already exists in Confirmed")
      ))
    );
    let richAnalyzed = 0, richErrors = 0;
    if (pendingRich.length > 0 && !hasMore) {
      console.log(`build_cached_alert_options: ${pendingRich.length} rich informational row(s) pending analysis`);
      for (const row of pendingRich) {
        if (Date.now() - buildStart > TIME_LIMIT_MS) {
          console.log(`  ⏳ Time limit reached during rich-type analysis - remaining rows will be picked up next run.`);
          hasMore = true;
          break;
        }
        const client = clientByName.get(row.clientName);
        if (!client) { richErrors++; continue; }
        try {
          const cronSecret = process.env.CRON_SECRET || "";
          const analyzeRes = await fetch(`${baseUrl}/api/triage`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${cronSecret}`,
              "x-cron-secret": cronSecret
            },
            body: JSON.stringify({
              action: "analyze_noaction_flag",
              secret: cronSecret,
              clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId,
              automationCommanderSheetId: acIdBuild, flagType: row.alertType, clientName: row.clientName,
              targetLine: row.alertSummary,
            }),
          });
          const analyzeData = await analyzeRes.json();
          if (analyzeData.success) {
            await updateAlertMemoryRow(sheets, acIdBuild, row.rowIndex, {
              ...row, cachedOptionsJSON: JSON.stringify(analyzeData),
            });
            richAnalyzed++;
            console.log(`  ✅ ${row.clientName}/${row.alertType}: targeted analysis stored`);
          } else {
            richErrors++;
            console.log(`  ❌ ${row.clientName}/${row.alertType}: analyze_noaction_flag failed - ${analyzeData.error || "unknown"}`);
          }
        } catch (richErr) {
          richErrors++;
          console.log(`  ❌ ${row.clientName}/${row.alertType}: analyze_noaction_flag call failed - ${richErr.message}`);
        }
        await new Promise(r => setTimeout(r, 1200));
      }
      console.log(`build_cached_alert_options: rich informational analysis - ${richAnalyzed} analyzed, ${richErrors} errors`);
    }

    await logBuildOptionsRun(sheets, acIdBuild, {
      processed: pending.length, built, notFound, errors, elapsedSeconds: elapsedS, builtDetail, isContinuation: req.body.isContinuation
    });

    return res.status(200).json({ success: true, processed: pending.length, built, notFound, errors, elapsedSeconds: elapsedS, hasMore, richAnalyzed, richErrors });
  } catch (err) {
    console.error("❌ build_cached_alert_options error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// Apply bold + italic formatting to a range of cells via batchUpdate
async function applyBoldItalic(sheets, spreadsheetId, sheetId, startRowIndex, endRowIndex, startColIndex, endColIndex) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId, startRowIndex, endRowIndex, startColumnIndex: startColIndex, endColumnIndex: endColIndex },
          cell: { userEnteredFormat: { textFormat: { bold: true, italic: true } } },
          fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.italic",
        },
      }],
    },
  });
}

async function writeOutgoingsExpense(sheets, clientSheetId, outgoingsData) {
  const { categoryName, expenseMonth, transactionId, amount, description, status, recDate, payDate, vatCharged, mode = "add_alongside" } = outgoingsData;

  console.log(`  📝 Writing Outgoings expense: ${categoryName} / ${expenseMonth} / £${amount} (mode: ${mode})`);

  const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const sheetRange = "Outgoings!A1:AX500";
  const valuesResp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetIdClean,
    range: sheetRange,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = valuesResp.data.values || [];
  if (rows.length === 0) throw new Error("Outgoings tab is empty");

  // Parse target month using robust parseYearMonth
  const ym = parseYearMonth(expenseMonth || recDate);
  if (!ym) throw new Error(`Could not parse month from "${expenseMonth || recDate}"`);
  const targetYear = ym.year;
  const targetMonth = ym.month;

  // Find the column index whose header date matches the target month.
  const headerRow = rows[0];
  let targetColIndex = -1;
  for (let c = 0; c < headerRow.length; c++) {
    const headerVal = headerRow[c];
    if (headerVal === null || headerVal === undefined || headerVal === "") continue;
    let parsedYM = null;
    if (typeof headerVal === "number") {
      const d = new Date((headerVal - 25569) * 86400 * 1000);
      if (!isNaN(d.getTime())) {
        parsedYM = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
      }
    } else {
      parsedYM = parseYearMonth(headerVal);
    }
    if (parsedYM && parsedYM.year === targetYear && parsedYM.month === targetMonth) {
      targetColIndex = c;
      break;
    }
  }

  if (targetColIndex === -1) {
    throw new Error(`Could not find column for month ${expenseMonth} in Outgoings header row`);
  }

  // Find the vendor row in the contractor section (rows 13-110, 0-indexed 12-109)
  const categoryLower = categoryName.toLowerCase().trim();
  let targetRowIndex = -1;
  let lastFilledRowIndex = -1; // track last row with a vendor name

  for (let r = 12; r <= Math.min(109, rows.length - 1); r++) {
    const rowVendorName = String(rows[r][0] || "").toLowerCase().trim();
    if (rowVendorName === categoryLower) {
      targetRowIndex = r;
      break;
    }
    if (rowVendorName) lastFilledRowIndex = r;
  }

  let isNewVendor = false;
  if (targetRowIndex === -1) {
    // Vendor not found - use the first blank row AFTER the last existing vendor
    const nextBlankIndex = lastFilledRowIndex + 1;
    if (lastFilledRowIndex === -1 || nextBlankIndex > 109) {
      throw new Error(`No existing row for "${categoryName}" and no blank rows available in contractor section (rows 13-110)`);
    }
    targetRowIndex = nextBlankIndex;
    isNewVendor = true;
    console.log(`  New vendor - using blank row ${targetRowIndex + 1} (after last vendor at row ${lastFilledRowIndex + 1})`);
  }

  const sheetRow = targetRowIndex + 1; // 1-indexed
  const sheetCol = targetColIndex + 1;

  // Convert column index to A1 letter notation
  const colLetter = (() => {
    let col = sheetCol;
    let letter = "";
    while (col > 0) {
      const r = (col - 1) % 26;
      letter = String.fromCharCode(65 + r) + letter;
      col = Math.floor((col - 1) / 26);
    }
    return letter;
  })();

  const cellA1 = `Outgoings!${colLetter}${sheetRow}`;
  console.log(`  Target: row ${sheetRow} ("${categoryName}"), col ${colLetter} (month ${expenseMonth}), newVendor=${isNewVendor}`);

  // If new vendor, write the fixed fields first (A=name, B=VAT, C=Next, D=Next, E=100%, F=100%)
  if (isNewVendor) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetIdClean,
      range: `Outgoings!A${sheetRow}:F${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[categoryName, vatCharged || "No", "Next", "Next", "100%", "100%"]] },
    });
    await applySheetFontFormat(sheets, sheetIdClean, "Outgoings", sheetRow - 1, sheetRow, 0, 50, "Arial", 9);
    console.log(`  ✅ New vendor row written: ${categoryName}`);
  }

  // Read existing cell value and note
  const cellResp = await sheets.spreadsheets.get({
    spreadsheetId: sheetIdClean,
    ranges: [cellA1],
    fields: "sheets(data(rowData(values(userEnteredValue,note))))",
  });

  const cellData = cellResp.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0];
  const existingValueRaw = cellData?.userEnteredValue?.numberValue
    ?? cellData?.userEnteredValue?.stringValue
    ?? 0;
  const existingNote = cellData?.note || "";
  const existingValue = parseFloat(existingValueRaw) || 0;

  console.log(`  Existing cell value: ${existingValue}, note length: ${existingNote.length}`);

  // Parse note parts
  const parseNoteParts = (note) => {
    if (!note) return { topNote: "", blocks: [] };
    const firstBlockIdx = note.indexOf("{App ID:");
    let topNote = "";
    let blockText = "";
    if (firstBlockIdx !== -1) {
      topNote = note.substring(0, firstBlockIdx).trim();
      blockText = note.substring(firstBlockIdx);
    } else if (note.includes("{") && note.includes("}")) {
      blockText = note;
    } else {
      topNote = note.trim();
    }

    const blocks = [];
    const blockRegex = /\{App ID:\s*([^}]+)\}\{Amt:\s*([^}]+)\}(?:\{Status:\s*([^}]*)\})?(?:\{Rec date:\s*([^}]*)\})?(?:\{Pay date:\s*([^}]*)\})?(?:\{Description:\s*([^}]*)\})?/g;
    let match;
    while ((match = blockRegex.exec(blockText)) !== null) {
      blocks.push({
        appId: match[1]?.trim() || "",
        amount: parseFloat(String(match[2] || "").replace(/[£$€,\s]/g, "")) || 0,
        status: match[3]?.trim() || "",
        recDate: match[4]?.trim() || "",
        payDate: match[5]?.trim() || "",
        description: match[6]?.trim() || "",
      });
    }
    return { topNote, blocks };
  };

  const { topNote, blocks: existingBlocks } = parseNoteParts(existingNote);
  const placeholderBlocks = existingBlocks.filter(b => isPlaceholderExpense(b.appId, b.description, b.status));
  const nonPlaceholderBlocks = existingBlocks.filter(b => !isPlaceholderExpense(b.appId, b.description, b.status));

  const placedAmount = parseFloat(amount) || 0;
  const newBlock = {
    appId: transactionId || `EXP-${Date.now()}`,
    amount: placedAmount,
    status: status ? String(status).trim() : "",
    recDate: recDate ? String(recDate).trim() : "",
    payDate: payDate ? String(payDate).trim() : "",
    description: description ? String(description).trim() : ""
  };

  let resultingBlocks = [];
  const placementMode = mode || "add_alongside";

  if (placementMode === "replace") {
    // Strip all placeholder blocks, keep real expense blocks, append new block
    resultingBlocks = [...nonPlaceholderBlocks, newBlock];
  } else if (placementMode === "use_up") {
    // Reduce placeholder blocks by placedAmount
    let remainingToDeduct = placedAmount;
    const reducedPlaceholders = [];
    for (const pb of placeholderBlocks) {
      const pbAmount = parseFloat(pb.amount) || 0;
      const used = Math.min(remainingToDeduct, pbAmount);
      const newAmount = Math.round((pbAmount - used) * 100) / 100;
      remainingToDeduct -= used;
      if (newAmount > 0.004) {
        reducedPlaceholders.push({ ...pb, amount: newAmount });
      }
    }
    resultingBlocks = [...nonPlaceholderBlocks, ...reducedPlaceholders, newBlock];
  } else {
    // "add_alongside": keep all existing blocks, append new block (or update if same appId)
    const existingIndex = existingBlocks.findIndex(b => b.appId && b.appId === newBlock.appId);
    if (existingIndex >= 0) {
      resultingBlocks = [...existingBlocks];
      resultingBlocks[existingIndex] = newBlock;
    } else {
      resultingBlocks = [...existingBlocks, newBlock];
    }
  }

  const newValue = Math.round(resultingBlocks.reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0) * 100) / 100;

  const blockStr = resultingBlocks.map(b =>
    `{App ID: ${b.appId}}{Amt: ${b.amount}}{Status:${b.status ? " " + b.status : ""}}{Rec date:${b.recDate ? " " + b.recDate : ""}}{Pay date:${b.payDate ? " " + b.payDate : ""}}{Description:${b.description ? " " + b.description : ""}}`
  ).join("\n");

  const newNote = topNote ? `${topNote}\n\n${blockStr}` : blockStr;

  // Write value
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetIdClean,
    range: cellA1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newValue]] },
  });
  console.log(`  ✅ Value written: ${existingValue} → ${newValue} (${placementMode})`);

  // Write note + apply bold/italic formatting in one batchUpdate
  const outgoingsSheetId = await getSheetId(sheets, sheetIdClean, "Outgoings");
  const formatRequests = [
    {
      repeatCell: {
        range: {
          sheetId: outgoingsSheetId,
          startRowIndex: sheetRow - 1, endRowIndex: sheetRow,
          startColumnIndex: sheetCol - 1, endColumnIndex: sheetCol,
        },
        cell: { userEnteredFormat: { textFormat: { bold: true, italic: true } } },
        fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.italic",
      },
    },
    {
      updateCells: {
        range: {
          sheetId: outgoingsSheetId,
          startRowIndex: sheetRow - 1, endRowIndex: sheetRow,
          startColumnIndex: sheetCol - 1, endColumnIndex: sheetCol,
        },
        rows: [{ values: [{ note: newNote }] }],
        fields: "note",
      },
    },
  ];

  if (isNewVendor) {
    formatRequests.push({
      repeatCell: {
        range: {
          sheetId: outgoingsSheetId,
          startRowIndex: sheetRow - 1, endRowIndex: sheetRow,
          startColumnIndex: 0, endColumnIndex: 6,
        },
        cell: { userEnteredFormat: { textFormat: { bold: true, italic: true } } },
        fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.italic",
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetIdClean,
    requestBody: { requests: formatRequests },
  });
  console.log(`  ✅ Note written and formatting applied`);

  return { sheetRow, colLetter, newValue, prevValue: existingValue, isNewVendor, mode: placementMode, resultingBlocks };
}

export async function handleAnalyzeAlert(req, res, sheets) {
  // Generate matching options for an alert
  const { alert, sharedData, automationCommanderSheetId = req.body.automationCommanderSheetId } = req.body;

  if (!alert) {
    res.status(400).json({ success: false, error: "Missing alert data" });
    return;
  }

  // Proactive alerts (revenue_mismatch, direct_costs_mismatch, retainer_invoice etc.)
  // don't have automation options to generate - they have heading/detail only.
  // Return empty options gracefully rather than crashing on missing alert.type/clientId.
  if (!alert.type && !alert.data && alert.alertKey) {
    return res.status(200).json({ success: true, options: [], isProactive: true });
  }

  try {
    console.log(`\n🤖 Generating options for ${alert.type || alert.flagType} alert (${alert.clientName})`);

    const sheets = await getSheetsClient();

    // ── AlertMemory cache check ──────────────────────────────────────────
    // Compute fingerprint (may already be set from start_triage, but
    // recompute here in case alert came from a stale Redis session)
    const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);
    await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
    const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);

    // CRITICAL FIX: Use the row passed directly from the builder to bypass Google Sheets read-after-write latency
    const memoryRow = req.body.memoryRow || findMemoryRow(memoryRows, fingerprintHash);

    if (memoryRow) {
      if (memoryRow.status === "ignored") {
        // Shouldn't reach here (filtered at start_triage), but handle gracefully
        console.log(`  ⏭ Alert is ignored - returning ignored status`);
        return res.status(200).json({ success: true, ignored: true });
      }
      if (!req.body.forceFresh && memoryRow.status === "cached" && memoryRow.cachedOptionsJSON) {
        console.log(`  ✅ Cache HIT for ${fingerprintHash} - returning stored options`);
        // Update lastSeen
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
          ...memoryRow,
        });
        let cachedOptions = [];
        try {
          cachedOptions = JSON.parse(memoryRow.cachedOptionsJSON);
        } catch (e) {
          console.log(`  ⚠️ Could not parse cached options JSON - will re-fetch from Claude`);
        }
        // Only use cache if options have valid structure (title field present)
        // If cached options are the fallback { summary: ... } format from a failed
        // Claude parse, discard them and re-call Claude for a fresh result
        const validCachedOptions = cachedOptions.filter(o => o.title);
        const isCacheStale = validCachedOptions.some(opt => {
          const title = String(opt.title || "").toLowerCase();
          if (title.includes("no confident automatic match") || (title.includes("manual investigation") && (title.includes("no confident") || title.includes("automatic match")))) return true;
          const isInvAlert = alert.type === "invoice" || alert.sheetName === "InvComp" || alert.flagType === "invoiceDashboardDiscr" || alert.alertType === "invoiceDashboardDiscr";
          const isInvMismatch = isInvAlert && String(alert.data?.flags?.[0] || "").trim() !== "1";
          const isDupInvoice = Boolean(alert.isDuplicateInvoice || String(alert.data?.flags?.[4] || "").trim() === "1" || (alert.spreadsheetItems && alert.spreadsheetItems.length > 1));
          if (isInvMismatch && (!opt.actionButtonText || String(opt.actionButtonText).includes("Mark as reviewed") || String(opt.actionButtonText).includes("Mark as resolved") || opt.matchType === "info")) return true;
          if (isInvMismatch && !isDupInvoice && (validCachedOptions.length !== 2 || !validCachedOptions.some(o => o.matchType === "ignore"))) return true;
          if (isDupInvoice && (!validCachedOptions.some(o => o.matchType === "delete" || String(o.title || "").includes("Clear invoice")) || !validCachedOptions.some(o => o.matchType === "ignore"))) return true;
          const isCrmAlert = alert.type === "crm" || alert.sheetName === "CRMComp" || Boolean(alert.alertType?.startsWith("crm")) || Boolean(alert.flagType?.startsWith("crm"));
          const isCrmMismatch = isCrmAlert && alert.subType === "field_mismatch";
          if (isCrmMismatch && (!opt.actionButtonText || validCachedOptions.length !== 2 || String(opt.actionButtonText).includes("Mark as reviewed") || opt.matchType === "info")) return true;
          const isExpAlert = alert.type === "expense" || alert.sheetName === "DirComp" || alert.flagType === "expenseDashboardDiscr" || alert.alertType === "expenseDashboardDiscr";
          const isExpMismatch = isExpAlert && String(alert.data?.flags?.[0] || "").trim() !== "1";
          if (isExpMismatch && (!opt.actionButtonText || String(opt.actionButtonText).includes("Mark as reviewed") || opt.matchType === "info" || validCachedOptions.length > 2)) return true;
          if (opt.matchType === "existing_job" || opt.matchType === "job") {
            if (opt.jobRowsData && opt.jobRowsData.length > 0) {
              const row0 = opt.jobRowsData[0] || {};
              const hasRev = row0.revenue && String(row0.revenue).trim() !== "" && String(row0.revenue).trim() !== "0";
              const hasDates = Boolean(row0.startDate || row0.endDate);
              const hasType = Boolean(row0.projectRetainer);
              if (!hasRev && !hasDates && !hasType) return true;
            }
          }
          return false;
        });

        if (validCachedOptions.length > 0 && !isCacheStale) {
          // For crmPipeAppDiscr Pipeline alerts, re-fetch copiedToConf live
          // since it can change in the sheet independently of the cached options
          let liveCopiedToConf = null;
          if ((alert.alertType === "crmPipeAppDiscr") && alert.clientId) {
            try {
              // Find jobRow from cached option
              const cachedJobRow = validCachedOptions[0]?.jobRow;
              if (cachedJobRow) {
                const ddResp = await sheets.spreadsheets.values.get({
                  spreadsheetId: alert.clientId,
                  range: `Pipeline!DD${cachedJobRow}`,
                });
                liveCopiedToConf = String(ddResp.data.values?.[0]?.[0] || "").trim();
                console.log(`  📋 Live copiedToConf for row ${cachedJobRow}: "${liveCopiedToConf}"`);
              }
            } catch (e) {
              console.log(`  copiedToConf live fetch failed: ${e.message}`);
            }
          }
          // Inject live copiedToConf into cached options if fetched
          let optionsToReturn = liveCopiedToConf !== null
            ? validCachedOptions.map(o => ({ ...o, copiedToConf: liveCopiedToConf }))
            : validCachedOptions;

          // Regenerate jobRowsData fresh for cached options - this data may be
          // missing entirely (cached before this feature existed) or stale (sheet
          // has changed since the options were cached). Determine the correct tab:
          // CRM alerts use Pipeline/Confirmed per their mode; invoice/expense options
          // always reference the Confirmed tab.
          try {
            const jrdTabName = (alert.type === "crm" || alert.sheetName === "CRMComp")
              ? (alert.mode === "Pipeline" || alert.alertType === "crmPipeAppDiscr" || alert.alertType === "crmPipeDashDiscr" ? "Pipeline" : "Confirmed")
              : "Confirmed";
            const jrdSheetId = alert.clientId;
            const jrdCache = new Map();
            optionsToReturn = await Promise.all(optionsToReturn.map(async (opt) => {
              if (!opt.jobRow || (opt.matchType !== "existing_job" && opt.matchType !== "job")) return opt;
              if (opt.jobRowsData && opt.jobRowsData.length > 0) return opt;
              // Prefer explicit target fields (set at generation time) over parsing
              // recommendedActions text - explicit fields can't be mismatched.
              let highlightSlot = null;
              if (opt.targetSlotType && opt.targetSlotNum && opt.targetRowNum) {
                highlightSlot = { type: opt.targetSlotType, rowNum: opt.targetRowNum, slotNum: opt.targetSlotNum };
              } else {
                // Fallback for options cached before explicit fields existed
                const actionsText = Array.isArray(opt.recommendedActions) ? opt.recommendedActions.join(" ") : "";
                const expSlotMatch = actionsText.match(/ExpSlot(\d)/i);
                const invSlotMatch = actionsText.match(/\bslot (\d)\b/i) || actionsText.match(/invoice slot (\d)/i);
                if (expSlotMatch) highlightSlot = { type: "expense", rowNum: opt.jobRow, slotNum: parseInt(expSlotMatch[1]) };
                else if (invSlotMatch) highlightSlot = { type: "invoice", rowNum: opt.jobRow, slotNum: parseInt(invSlotMatch[1]) };
              }
              const cacheKey = `${opt.jobRow}-${highlightSlot?.slotNum ?? "none"}`;
              if (!jrdCache.has(cacheKey)) {
                jrdCache.set(cacheKey, await fetchJobRowsForDisplay(sheets, jrdSheetId, jrdTabName, opt.jobRow, highlightSlot, sharedData));
              }
              return { ...opt, jobRowsData: jrdCache.get(cacheKey) };
            }));
          } catch (jrdErr) {
            console.log(`  ⚠ jobRowsData regeneration on cache hit failed (non-fatal): ${jrdErr.message}`);
          }

          return res.status(200).json({
            success: true,
            options: optionsToReturn,
            alertId: alert.rowNumber,
            fromCache: true,
            previousIgnoreReason: await findPreviousIgnoreReason(memoryRows, alert),
          });
        }
        console.log(`  ⚠️ Cached options have no valid title - treating as cache miss`);
      }
    }

    console.log(`  Cache MISS for ${fingerprintHash} - calling Claude`);

    // Check if this alert was previously ignored (superseded) - surface the old reason
    const previousIgnoreReason = await findPreviousIgnoreReason(memoryRows, alert);
    if (previousIgnoreReason) {
      console.log(`  ℹ️ Found previous ignore reason for this alert`);
      if (memoryRow) {
        try {
          const snapObj = JSON.parse(memoryRow.dataSnapshot || "{}");
          snapObj.previousIgnoreReason = previousIgnoreReason;
          memoryRow.dataSnapshot = JSON.stringify(snapObj);
        } catch (e) { }
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // Handle expense alerts (DirComp)
    if (alert.type === "expense" || alert.sheetName === "DirComp") {

      // ── Determine discrepancy type from flags ──────────────────────────
      // flags = alert.data.flags (AO:AV, indices 0-7)
      // 0=AO Missing cost, 1=AP Duplicate app ID, 2=AQ Descr mismatch,
      // 3=AR Amount mismatch, 4=AS VAT mismatch, 5=AT Rec date mismatch,
      // 6=AU Pay date mismatch, 7=AV Status mismatch
      const flags = alert.data?.flags || [];
      const isMissingCost = String(flags[0] || "").trim() === "1";
      const isVATMismatch = String(flags[4] || "").trim() === "1";
      const flagNames = ["Missing cost", "Duplicate app ID", "Description mismatch",
        "Amount mismatch", "VAT mismatch", "Rec date mismatch", "Pay date mismatch", "Status mismatch"];
      const activeFlags = flags.map((v, i) => String(v || "").trim() === "1" ? flagNames[i] : null).filter(Boolean);


      // Extract key fields from alert data
      // confirmed slice = cols X:AH (indices 23-33 of raw row), so:
      //   index 3 within confirmed = AA (vendor description)
      //   index 10 within confirmed = AH (source)
      // accounting slice = cols A:J (indices 0-9), index 8 = col I (VAT amount)
      const confirmed = alert.data?.confirmed || [];
      const accounting = alert.data?.accounting || [];
      const vendorDesc = String(confirmed[3] || "").trim();   // AA
      const source = String(confirmed[10] || "").trim();  // AH
      const vatAmount = parseFloat(String(accounting[8] || "0").replace(/[£$€,]/g, "")) || 0;
      const expDescription = String(accounting[1] || "").trim();
      const expAmount = parseFloat(String(accounting[2] || "0").replace(/[£$€,]/g, "")) || 0;
      const expDate = String(accounting[0] || "").trim();

      // Extract vendor name = part before first "(" in vendorDesc, trimmed
      const vendorName = (vendorDesc.includes("(")
        ? vendorDesc.slice(0, vendorDesc.indexOf("("))
        : vendorDesc).trim();

      console.log(`  Discrepancy type(s): ${activeFlags.join(", ") || "unknown"}`);
      console.log(`  Source: ${source}, Vendor: "${vendorName}", VAT amount: ${vatAmount}`);

      const expStatus = String(accounting[5] || "").trim() || "Paid";
      const expDatePaid = String(accounting[7] || "").trim();
      const transactionId = String(confirmed[0] || accounting[6] || "").trim();
      const jobName = String(confirmed[2] || "").trim();
      const clientName = String(confirmed[1] || "").trim();

      // ── Data mismatch handling (Amount, Description, VAT, Dates, Status) ──
      // For any expense data mismatch (!isMissingCost), strictly offer two options:
      // 1. Update Pulse (write updated values into Pulse)
      // 2. Ignore discrepancy (keep Pulse value)
      // NEVER offer "Mark as reviewed" for expense data mismatches.
      if (!isMissingCost) {
        console.log(`  📊 Expense data mismatch for "${vendorName || vendorDesc || expDescription}"`);
        console.log(`  Discrepancy type(s): ${activeFlags.join(", ") || "Data mismatch"}`);
        console.log(`  Source: ${source}, TransactionID: ${transactionId}, Job: ${jobName}`);

        const slotNum = source === "Slot1" ? 1 : source === "Slot2" ? 2 : source === "Slot3" ? 3 : null;
        const slotColMapExp = {
          1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
          2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
          3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
        };

        // ── Branch 1: Confirmed tab Slot expense ──────────────────────────
        if (slotNum) {
          const cols = slotColMapExp[slotNum];
          let confirmedRow = -1;

          // 1. Search Confirmed tab for transaction ID in this slot's ID column
          if (transactionId) {
            try {
              const confirmedResp = await sheets.spreadsheets.values.get({
                spreadsheetId: alert.clientId,
                range: `Confirmed!${cols.id}2:${cols.id}2000`,
              });
              const txRows = confirmedResp.data.values || [];
              for (let i = 0; i < txRows.length; i++) {
                if (String(txRows[i]?.[0] || "").trim() === transactionId) {
                  confirmedRow = i + 2; // 1-indexed, starts row 2
                  break;
                }
              }
              console.log(`  Confirmed slot txId search: row=${confirmedRow}`);
            } catch (e) {
              console.log(`  ⚠ Error searching Confirmed tab for txId: ${e.message}`);
            }
          }

          // 2. If not found by txId, search by job name + client name in Confirmed A:B
          if (confirmedRow === -1 && jobName) {
            try {
              const confJobResp = await sheets.spreadsheets.values.get({
                spreadsheetId: alert.clientId,
                range: `Confirmed!A2:B2000`,
              });
              const jobRows = confJobResp.data.values || [];
              const normJob = jobName.toLowerCase().trim();
              const normClient = clientName.toLowerCase().trim();
              for (let i = 0; i < jobRows.length; i++) {
                const rowClient = String(jobRows[i]?.[0] || "").toLowerCase().trim();
                const rowJob = String(jobRows[i]?.[1] || "").toLowerCase().trim();
                if (rowJob === normJob && (!normClient || rowClient === normClient)) {
                  confirmedRow = i + 2;
                  break;
                }
              }
              console.log(`  Confirmed slot jobName search: row=${confirmedRow}`);
            } catch (e) {
              console.log(`  ⚠ Error searching Confirmed tab for jobName: ${e.message}`);
            }
          }

          // 3. If still not found, search by vendor/description in this slot's description column
          if (confirmedRow === -1 && (vendorDesc || expDescription)) {
            try {
              const confDescResp = await sheets.spreadsheets.values.get({
                spreadsheetId: alert.clientId,
                range: `Confirmed!${cols.d}2:${cols.d}2000`,
              });
              const descRows = confDescResp.data.values || [];
              const searchDesc = (vendorDesc || expDescription).toLowerCase().trim();
              for (let i = 0; i < descRows.length; i++) {
                if (String(descRows[i]?.[0] || "").toLowerCase().trim() === searchDesc) {
                  confirmedRow = i + 2;
                  break;
                }
              }
              console.log(`  Confirmed slot description search: row=${confirmedRow}`);
            } catch (e) {
              console.log(`  ⚠ Error searching Confirmed tab for description: ${e.message}`);
            }
          }

          // Build write actions and explanation parts based on active flags
          const writeActions = [];
          const explanationParts = [];
          const mismatchNames = [];

          // Description mismatch (flag 2)
          if (String(flags[2] || "").trim() === "1") {
            if (expDescription) {
              mismatchNames.push("description");
              explanationParts.push(`Description: "${expDescription}"`);
              if (confirmedRow !== -1) writeActions.push(`write "${expDescription}" to ${cols.d}${confirmedRow}`);
            }
          }

          // Amount mismatch (flag 3)
          if (String(flags[3] || "").trim() === "1" || (!activeFlags.length && expAmount > 0)) {
            mismatchNames.push("amount");
            explanationParts.push(`Amount: £${expAmount.toFixed(2)}`);
            if (confirmedRow !== -1) writeActions.push(`write ${expAmount.toFixed(2)} to ${cols.a}${confirmedRow}`);
          }

          // VAT mismatch (flag 4)
          if (String(flags[4] || "").trim() === "1") {
            const newVATValue = vatAmount > 0 ? "Yes" : "No";
            mismatchNames.push("VAT setting");
            explanationParts.push(`VAT: "${newVATValue}" (accounting VAT: £${vatAmount.toFixed(2)})`);
            if (confirmedRow !== -1) writeActions.push(`write ${newVATValue} to ${cols.v}${confirmedRow}`);
          }

          // Rec date mismatch (flag 5)
          if (String(flags[5] || "").trim() === "1") {
            if (expDate) {
              mismatchNames.push("rec date");
              explanationParts.push(`Rec Date: ${expDate}`);
              if (confirmedRow !== -1) writeActions.push(`write ${expDate} to ${cols.dt}${confirmedRow}`);
            }
          }

          // Pay date mismatch (flag 6)
          if (String(flags[6] || "").trim() === "1") {
            const payDateVal = expDatePaid || expDate;
            if (payDateVal) {
              mismatchNames.push("pay date");
              explanationParts.push(`Pay Date: ${payDateVal}`);
              if (confirmedRow !== -1) writeActions.push(`write ${payDateVal} to ${cols.dp}${confirmedRow}`);
            }
          }

          // Status mismatch (flag 7)
          if (String(flags[7] || "").trim() === "1") {
            mismatchNames.push("status");
            explanationParts.push(`Status: ${expStatus}`);
            if (confirmedRow !== -1) writeActions.push(`write ${expStatus} to ${cols.st}${confirmedRow}`);
          }

          // If no specific flag matched but it's a data mismatch, update amount & description
          if (mismatchNames.length === 0) {
            mismatchNames.push("expense details");
            if (expAmount > 0) {
              explanationParts.push(`Amount: £${expAmount.toFixed(2)}`);
              if (confirmedRow !== -1) writeActions.push(`write ${expAmount.toFixed(2)} to ${cols.a}${confirmedRow}`);
            }
            if (expDescription) {
              explanationParts.push(`Description: "${expDescription}"`);
              if (confirmedRow !== -1) writeActions.push(`write "${expDescription}" to ${cols.d}${confirmedRow}`);
            }
          }

          const displayName = vendorDesc || jobName || expDescription || "expense";
          const titleSuffix = confirmedRow !== -1 ? ` in Confirmed tab ${source} (Row ${confirmedRow})` : ` in Confirmed tab ${source}`;

          const options = [
            {
              optionId: 1,
              title: `Update ${mismatchNames.join(", ")} to match accounting for "${displayName}"${titleSuffix}`,
              actionButtonText: `Update Pulse`,
              matchType: "existing_job",
              jobRow: confirmedRow !== -1 ? confirmedRow : alert.rowNumber,
              jobName: displayName,
              explanation: `Accounting system shows: ${explanationParts.join("; ")}. Updating Pulse to match.`,
              matchingDetails: {
                unmatchedJobSummary: {
                  clientName: clientName || alert.clientName,
                  jobName: displayName,
                  revenue: String(expAmount),
                  startDate: expDate,
                },
              },
              matchAnalysis: {
                matchConfidence: confirmedRow !== -1 ? "High" : "Medium",
                reasonForChoice: `Discrepancy: ${activeFlags.join(", ") || mismatchNames.join(", ")}. Accounting system: ${explanationParts.join("; ")}. Updating ${source}${confirmedRow !== -1 ? ` (Row ${confirmedRow})` : ""} to match.`,
                discrepancies: activeFlags.join(", ") || mismatchNames.join(", "),
              },
              recommendedActions: [
                `Update ${mismatchNames.join(", ")} for "${displayName}" in Confirmed tab ${source} to match accounting: ${explanationParts.join(", ")}`,
                ...writeActions
              ],
            },
            {
              optionId: 2,
              title: `Ignore discrepancy (keep Pulse value)`,
              actionButtonText: `Ignore discrepancy`,
              matchType: "ignore",
              jobRow: confirmedRow !== -1 ? confirmedRow : alert.rowNumber,
              jobName: displayName,
              explanation: `Mark this discrepancy as ignored. No changes will be made to either Pulse or the accounting system.`,
              recommendedActions: [
                `Mark this discrepancy as ignored - no changes will be made to either system`,
              ],
            }
          ];

          return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
        }

        // ── Branch 2: Outgoings tab expense (OG-) ──────────────────────────
        if (source.startsWith("OG-")) {
          const normalise = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
          const vendorNorm = normalise(vendorName);

          // Sub-case: VAT mismatch
          if (isVATMismatch) {
            const newVATValue = vatAmount > 0 ? "Yes" : "No";

            // Find vendor row in Outgoings (rows 13-110 = 0-indexed 12-109, col A)
            let outgoingsVendorRow = -1;
            try {
              const outgoingsResp = await sheets.spreadsheets.values.get({
                spreadsheetId: alert.clientId,
                range: "Outgoings!A13:B110",
              });
              const outgoingsRows2 = outgoingsResp.data.values || [];
              for (let i = 0; i < outgoingsRows2.length; i++) {
                const rowVendor = normalise(String(outgoingsRows2[i]?.[0] || ""));
                if (rowVendor === vendorNorm) {
                  outgoingsVendorRow = i + 13; // 1-indexed sheet row
                  break;
                }
              }
            } catch (e) {
              console.log(`  ⚠ Error reading Outgoings tab: ${e.message}`);
            }

            const writeActions = outgoingsVendorRow !== -1 ? [`write ${newVATValue} to B${outgoingsVendorRow}`] : [];
            const rowSuffix = outgoingsVendorRow !== -1 ? ` (Row ${outgoingsVendorRow})` : "";

            const options = [
              {
                optionId: 1,
                title: `Update VAT setting to "${newVATValue}" for "${vendorName}" in Outgoings tab${rowSuffix}`,
                actionButtonText: `Update Pulse`,
                matchType: "existing_job",
                jobRow: outgoingsVendorRow !== -1 ? outgoingsVendorRow : alert.rowNumber,
                jobName: vendorName,
                tabName: "Outgoings",
                explanation: `Accounting system shows VAT ${vatAmount > 0 ? `of £${vatAmount.toFixed(2)}` : "not applied"} for this expense. Updating vendor VAT setting in Outgoings tab to "${newVATValue}".`,
                matchingDetails: {
                  unmatchedJobSummary: {
                    clientName: alert.clientName,
                    jobName: vendorDesc,
                    revenue: String(expAmount),
                    startDate: expDate,
                  },
                },
                matchAnalysis: {
                  matchConfidence: outgoingsVendorRow !== -1 ? "High" : "Medium",
                  reasonForChoice: `Accounting system shows VAT ${vatAmount > 0 ? `of £${vatAmount.toFixed(2)}` : "not applied"}. Setting Outgoings column B to "${newVATValue}".`,
                  discrepancies: `VAT mismatch - accounting system has VAT ${vatAmount > 0 ? "applied" : "not applied"}, Pulse shows opposite`,
                },
                recommendedActions: [
                  `Update Outgoings VAT setting for "${vendorName}" to "${newVATValue}"`,
                  ...writeActions
                ],
              },
              {
                optionId: 2,
                title: `Ignore discrepancy (keep Pulse VAT setting)`,
                actionButtonText: `Ignore discrepancy`,
                matchType: "ignore",
                jobRow: outgoingsVendorRow !== -1 ? outgoingsVendorRow : alert.rowNumber,
                jobName: vendorName,
                explanation: `Mark this discrepancy as ignored. No changes will be made to either Pulse or the accounting system.`,
                recommendedActions: [
                  `Mark this discrepancy as ignored - no changes will be made to either system`,
                ],
              }
            ];

            return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
          }

          // Sub-case: Other Outgoings discrepancies (Amount, Date, Description, Status)
          const options = [
            {
              optionId: 1,
              title: `Update ${activeFlags.join(", ") || "expense details"} in Pulse for "${vendorName}" (${source})`,
              actionButtonText: `Update Pulse`,
              matchType: "existing_job",
              jobRow: alert.rowNumber,
              jobName: vendorName,
              tabName: "Outgoings",
              explanation: `Accounting system shows: Amount £${expAmount.toFixed(2)}, Date: ${expDate}, Description: "${expDescription}". Updating Outgoings entry in Pulse to match.`,
              matchingDetails: {
                unmatchedJobSummary: {
                  clientName: alert.clientName,
                  jobName: vendorDesc,
                  revenue: String(expAmount),
                  startDate: expDate,
                },
              },
              matchAnalysis: {
                matchConfidence: "Medium",
                reasonForChoice: `Discrepancy: ${activeFlags.join(", ") || "Data mismatch"}. Accounting system shows Amount: £${expAmount.toFixed(2)}, Date: ${expDate}. Updating Outgoings entry in Pulse to match.`,
                discrepancies: activeFlags.join(", ") || "Data mismatch",
              },
              recommendedActions: [
                `Update Outgoings ${source} entry for "${vendorName}" to match accounting: Amount £${expAmount.toFixed(2)}, Date ${expDate}`,
              ],
            },
            {
              optionId: 2,
              title: `Ignore discrepancy (keep Pulse value)`,
              actionButtonText: `Ignore discrepancy`,
              matchType: "ignore",
              jobRow: alert.rowNumber,
              jobName: vendorName,
              explanation: `Mark this discrepancy as ignored. No changes will be made to either Pulse or the accounting system.`,
              recommendedActions: [
                `Mark this discrepancy as ignored - no changes will be made to either system`,
              ],
            }
          ];

          return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
        }

        // ── Branch 3: Fallback for any other source when !isMissingCost ────
        const options = [
          {
            optionId: 1,
            title: `Update ${activeFlags.join(", ") || "expense details"} in Pulse for "${vendorDesc || expDescription}"`,
            actionButtonText: `Update Pulse`,
            matchType: "existing_job",
            jobRow: alert.rowNumber,
            jobName: vendorDesc || expDescription,
            explanation: `Accounting system shows: Amount £${expAmount.toFixed(2)}, Date: ${expDate}, Description: "${expDescription}". Updating Pulse to match.`,
            matchingDetails: {
              unmatchedJobSummary: {
                clientName: alert.clientName,
                jobName: vendorDesc || expDescription,
                revenue: String(expAmount),
                startDate: expDate,
              },
            },
            matchAnalysis: {
              matchConfidence: "Medium",
              reasonForChoice: `Discrepancy: ${activeFlags.join(", ") || "Data mismatch"}. Updating Pulse to match accounting data.`,
              discrepancies: activeFlags.join(", ") || "Data mismatch",
            },
            recommendedActions: [
              `Update ${activeFlags.join(", ") || "expense"} in Pulse to match accounting: Amount £${expAmount.toFixed(2)}, Date ${expDate}, Description "${expDescription}"`,
            ],
          },
          {
            optionId: 2,
            title: `Ignore discrepancy (keep Pulse value)`,
            actionButtonText: `Ignore discrepancy`,
            matchType: "ignore",
            jobRow: alert.rowNumber,
            jobName: vendorDesc || expDescription,
            explanation: `Mark this discrepancy as ignored. No changes will be made to either Pulse or the accounting system.`,
            recommendedActions: [
              `Mark this discrepancy as ignored - no changes will be made to either system`,
            ],
          }
        ];

        return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
      }

      // ── Missing cost - existing Claude path follows ────────────────────
      console.log(`  📊 Fetching Outgoings tab for expense matching...`);

      const outgoingsResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: alert.clientId,
        range: "Outgoings!A1:F112",
      });
      const outgoingsRows = outgoingsResponse.data.values || [];
      console.log(`  ✓ Loaded ${outgoingsRows.length} rows from Outgoings (rows 1-112)`);

      // Build vendor list for Claude - rows 13-110 are the contractor section
      // Each row: A=vendorName, B=chargesVAT, C-F=defaults
      // Find the LAST blank row after all existing vendors (i.e. next available slot at the bottom)
      const outgoingsVendorList = [];
      let lastVendorRowIndex = -1; // 0-indexed
      for (let i = 12; i <= Math.min(outgoingsRows.length - 1, 109); i++) { // 0-indexed rows 12-109 = sheet rows 13-110
        const vendorName = String(outgoingsRows[i]?.[0] || '').trim();
        const chargesVAT = String(outgoingsRows[i]?.[1] || '').trim();
        if (vendorName) {
          outgoingsVendorList.push(`Row ${i + 1}: ${vendorName} (VAT: ${chargesVAT || 'unknown'})`);
          lastVendorRowIndex = i;
        }
      }
      // First blank row after all existing vendors
      const firstBlankOutgoingsRow = lastVendorRowIndex < 109 ? lastVendorRowIndex + 2 : null; // +2: +1 for 0→1 index, +1 for next row
      console.log(`  ✓ Found ${outgoingsVendorList.length} existing vendors, next blank row: ${firstBlankOutgoingsRow}`);

      // ALSO fetch Confirmed tab for job-based expense matching
      console.log(`  📊 Fetching Confirmed tab for job-based expense matching...`);
      let confirmedData = [];
      if (sharedData && sharedData.confirmedDataWide) {
        confirmedData = sharedData.confirmedDataWide;
        console.log(`  ✓ Used cached Confirmed data (${confirmedData.length} rows)`);
      } else {
        const confirmedResponse = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: alert.clientId,
          range: "Confirmed!A1:CR5000",
        }));
        confirmedData = confirmedResponse.data.values || [];
      }

      console.log(`  ✓ Loaded ${confirmedData.length} rows from Confirmed`);

      // Find last non-blank row (checking all relevant columns)
      let lastDataRow = 1;
      for (let row = confirmedData.length - 1; row > 0; row--) {
        const rowData = confirmedData[row] || [];
        // A:G (0-6), AG:AM (32-38), AP:BH (41-59), BX:CR (75-94)
        const colsToCheck = [
          0, 1, 2, 3, 4, 5, 6,
          32, 33, 34, 35, 36, 37, 38,
          41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
          75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94
        ];
        const hasData = colsToCheck.some(col => rowData[col]);

        if (hasData) {
          lastDataRow = row;
          break;
        }
      }

      const activeConfirmedData = confirmedData.slice(0, lastDataRow + 1);
      console.log(`  ✓ Found ${activeConfirmedData.length} non-blank rows in Confirmed`);

      // Read tolerance values for expenses
      const tolerances = await getToleranceValues(sheets, alert.masterSheetId || alert.clientId);

      // Extract expense details
      const expenseAmount = parseFloat(alert.summary?.amount) || 0;
      const expenseRef = alert.summary?.reference || "(unknown)";
      const expenseDescription = alert.summary?.description || "";
      const expenseDate = alert.summary?.date || "";
      const expenseAccountName = alert.summary?.accountName || "";

      // Compute VAT flag from actual data - don't let Claude guess
      const vatAmountRaw = parseFloat(String(alert.summary?.vatAmount || '0').replace(/[£$€,]/g, '')) || 0;
      const vatYesNo = vatAmountRaw > 0 ? 'Yes' : 'No';
      console.log(`  VAT amount: ${vatAmountRaw}, vatYesNo: ${vatYesNo}`);

      // Backend pre-analysis: identify candidate jobs with DirectCostBudget > £0.
      // Claude cannot reliably scan 250 rows - we compute candidates in code
      // and pass only those to Claude for qualitative ranking.

      const slotColDefs = [
        { d: 75, a: 76, dt: 78, s: 80, id: 81 },
        { d: 82, a: 83, dt: 85, s: 87, id: 88 },
        { d: 89, a: 90, dt: 92, s: 94, id: 95 },
      ];

      const candidateJobs = [];
      let ci = 1;
      while (ci < activeConfirmedData.length) {
        const row = activeConfirmedData[ci] || [];
        const budgetRaw = String(row[33] || '').replace(/[£$€,\s]/g, '');
        const budget = parseFloat(budgetRaw) || 0;

        if (budget > 0) {
          const parentIdx = ci;
          const parentClient = String(row[0] || '').trim();
          const parentJob = String(row[1] || '').trim();
          const projType = String(row[35] || '').trim();
          const isRetainer = projType.toLowerCase().includes('retainer');

          // Collect parent + child rows for this job
          const jobRows = [{ row, sheetRow: ci + 1, isParent: true }];
          let cj = ci + 1;
          while (cj < activeConfirmedData.length) {
            const next = activeConfirmedData[cj] || [];
            const nc = String(next[0] || '').trim();
            const nj = String(next[1] || '').trim();
            const nb = String(next[33] || '').replace(/[£$€,\s]/g, '');
            if (nc === parentClient && nj === parentJob && !next[32] && !parseFloat(nb) && !next[37]) {
              jobRows.push({ row: next, sheetRow: cj + 1, isParent: false });
              cj++;
            } else { break; }
          }
          ci = cj;

          if (isRetainer) {
            // For retainers: each child row is an independent budget unit.
            // The period covered by each child row is determined by comparing
            // the child row's invoice amount to the parent's monthly revenue.
            // e.g. if monthly revenue = £3,456 and child invoice = £10,368 → quarterly (×3)
            const parentMonthlyRevenue = parseFloat(String(row[32] || '0').replace(/[£$€,\s]/g, '')) || 0;
            const parentMonthlyBudget = budget; // budget on parent row = per-month direct cost

            for (const { row: cr, sheetRow: childSheetRow } of jobRows.filter(r => !r.isParent)) {
              // Child invoice amount is in slot 1 amount column (index 41 = AP)
              const childInvoiceAmt = parseFloat(String(cr[41] || '0').replace(/[£$€,\s]/g, '')) || 0;
              // Determine period multiplier: how many months does this child row cover?
              let periodMultiplier = 1;
              if (parentMonthlyRevenue > 0 && childInvoiceAmt > 0) {
                const ratio = childInvoiceAmt / parentMonthlyRevenue;
                // Round to nearest integer - handles minor rounding differences
                periodMultiplier = Math.max(1, Math.round(ratio));
              }
              const childBudget = parentMonthlyBudget * periodMultiplier;
              const periodLabel = periodMultiplier === 1 ? 'monthly' :
                periodMultiplier === 3 ? 'quarterly' :
                  periodMultiplier === 6 ? 'bi-annual' :
                    periodMultiplier === 12 ? 'annual' :
                      `${periodMultiplier}-month`;

              let childAllocated = 0;
              const childSlots = [];
              for (let s = 0; s < slotColDefs.length; s++) {
                const { d, a, dt, id } = slotColDefs[s];
                const descr = String(cr[d] || '').trim();
                const amt = cr[a] !== undefined ? cr[a] : '';
                const date = cr[dt] || '';
                const appId = String(cr[id] || '').trim();
                if (!descr && !amt) {
                  // date was already read above but previously omitted
                  // here - fixed 20 Aug 2026, confirmed with Paul that
                  // empty expense placeholders do carry a real expected
                  // date the same way invoice placeholders do, needed
                  // for the date-tolerance check added below.
                  childSlots.push({ label: `Row ${childSheetRow} ExpSlot${s + 1}`, empty: true, date, sheetRow: childSheetRow, slotNum: s + 1 });
                  continue;
                }
                const amtNum = parseFloat(String(amt).replace(/[£$€,]/g, '')) || 0;
                const isAllocated = !!(appId && !isPlaceholderExpense(appId));
                if (isAllocated) childAllocated += amtNum;
                childSlots.push({ label: `Row ${childSheetRow} ExpSlot${s + 1}`, descr, amt, amtNum, date, appId, isAllocated, empty: false, sheetRow: childSheetRow, slotNum: s + 1 });
              }
              const remainingBudget = childBudget - childAllocated;
              // Universal gate: exclude jobs whose direct costs are already fully received
              if (remainingBudget <= 0.01) continue;

              candidateJobs.push({
                parentRow: parentIdx + 1, parentClient, parentJob,
                projectCode: row[2] || '',
                revenue: row[32] !== undefined ? row[32] : '',
                projType, isRetainer: true,
                startDate: row[37] || '', endDate: row[38] || '',
                budget: childBudget, totalBudget: childBudget,
                periodMultiplier, periodLabel,
                totalAllocated: childAllocated,
                remaining: remainingBudget,
                childSheetRow, slots: childSlots,
              });
            }
          } else {
            // Project jobs: pool all slots across parent + child rows
            let totalAllocated = 0;
            const slots = [];
            for (const { row: r, sheetRow } of jobRows) {
              for (let s = 0; s < slotColDefs.length; s++) {
                const { d, a, dt, id } = slotColDefs[s];
                const descr = String(r[d] || '').trim();
                const amt = r[a] !== undefined ? r[a] : '';
                const date = r[dt] || '';
                const appId = String(r[id] || '').trim();
                if (!descr && !amt) {
                  slots.push({ label: `Row ${sheetRow} ExpSlot${s + 1}`, empty: true, date, sheetRow, slotNum: s + 1 });
                  continue;
                }
                const amtNum = parseFloat(String(amt).replace(/[£$€,]/g, '')) || 0;
                const isAllocated = !!(appId && !isPlaceholderExpense(appId));
                if (isAllocated) totalAllocated += amtNum;
                slots.push({ label: `Row ${sheetRow} ExpSlot${s + 1}`, descr, amt, amtNum, date, appId, isAllocated, empty: false, sheetRow, slotNum: s + 1 });
              }
            }
            const remainingBudget = budget - totalAllocated;
            // Universal gate: exclude jobs whose direct costs are already fully received
            if (remainingBudget > 0.01) {
              candidateJobs.push({
                parentRow: parentIdx + 1, parentClient, parentJob,
                projectCode: row[2] || '',
                revenue: row[32] !== undefined ? row[32] : '',
                projType, isRetainer: false,
                startDate: row[37] || '', endDate: row[38] || '',
                budget, totalBudget: budget,
                totalAllocated, remaining: remainingBudget,
                slots,
              });
            }
          }
        } else { ci++; }
      }

      console.log(`  ✓ Found ${candidateJobs.length} jobs with unreceived DirectCostBudget > £0`);

      // ── TIER 1: Single job with exact amount placeholder match - skip Claude ──
      // If exactly one candidate job has a single unallocated placeholder slot whose
      // amount exactly matches the expense, generate the option directly.
      const exactMatches = candidateJobs.flatMap(job =>
        job.slots.filter(s => !s.empty && !s.isAllocated && s.amtNum === expenseAmount)
          .map(s => ({ job, slot: s }))
      );
      if (exactMatches.length === 1) {
        const { job: emJob, slot: emSlot } = exactMatches[0];
        const slotColMap = {
          1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
          2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
          3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
        };
        const cols = slotColMap[emSlot.slotNum];
        const parentRow = emJob.parentRow || row;
        console.log(`  ✅ Expense Tier 1 - exact placeholder match: ${emJob.parentJob} Row ${row} ExpSlot${emSlot.slotNum}`);
        const tier1ExpOption = {
          optionId: 1,
          title: `Allocate to ${emJob.parentJob} (Row ${row}, ExpSlot${emSlot.slotNum}) - exact amount match`,
          matchType: "job",
          jobRow: parentRow,
          targetRowNum: row,
          targetSlotType: "expense",
          targetSlotNum: emSlot.slotNum,
          jobName: emJob.parentJob,
          jobRevenue: emJob.revenue,
          jobDetails: {
            clientName: emJob.parentClient,
            jobName: emJob.parentJob,
            projectCode: emJob.projectCode,
            revenue: emJob.revenue,
            directCosts: emJob.budget || emJob.totalBudget || "£0",
            projectRetainer: emJob.projType,
            startDate: emJob.startDate,
            endDate: emJob.endDate,
            rowNum: parentRow,
          },
          matchAnalysis: {
            matchConfidence: "High",
            placeholderMatch: `YES - Row ${row} ExpSlot${emSlot.slotNum} has placeholder matching amount £${expenseAmount}`,
            budgetFit: "YES",
            reasonForChoice: `Exact amount match (£${expenseAmount}) with unallocated placeholder in ${emJob.parentJob}.`,
            discrepancies: "None",
          },
          recommendedActions: [
            `Allocate expense to ${emJob.parentJob} (Row ${row}), ExpSlot${emSlot.slotNum}`,
            `write ${expenseDescription} to ${cols.d}${row}, write ${expenseAmount} to ${cols.a}${row}, write ${vatYesNo} to ${cols.v}${row}, write ${expenseDate} to ${cols.dt}${row}, write 30 to ${cols.dp}${row}, write ${alert.summary?.status || ""} to ${cols.st}${row}`,
          ],
        };
        tier1ExpOption.jobRowsData = await fetchJobRowsForDisplay(
          sheets, alert.clientId, "Confirmed", parentRow,
          { type: "expense", rowNum: row, slotNum: emSlot.slotNum },
          sharedData
        );
        const expSummary1 = `Expense ${expenseDescription} £${expenseAmount} - ${alert.clientName}`;
        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const expMemRows1 = await readAlertMemory(sheets, automationCommanderSheetId);
        const expMemRow1 = findMemoryRow(expMemRows1, fingerprintHash);
        if (expMemRow1) {
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, expMemRow1.rowIndex, { ...expMemRow1, cachedOptionsJSON: JSON.stringify([tier1ExpOption]) });
        } else {
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: "expense", clientName: alert.clientName || "", alertSummary: expSummary1, cachedOptionsJSON: JSON.stringify([tier1ExpOption]), status: "cached" });
        }
        return res.status(200).json({ success: true, options: [tier1ExpOption], alertId: alert.rowNumber, previousIgnoreReason });
      }

      // ── TIER 2: System-generated options (ambiguous or no exact match) ──────
      // If forceAI flag is set, skip system options and use Claude directly.
      const forceAI = req.body.forceAI === true;
      if (forceAI) {
        console.log("  🤖 forceAI=true - using Claude for expense options");
        // Rebuild expense Claude prompt and call Claude
        const vatAmountRaw2 = parseFloat(String(alert.summary?.vatAmount || "0").replace(/[£$€,]/g, "")) || 0;
        const vatYesNo2 = vatAmountRaw2 > 0 ? "Yes" : "No";
        const expAmount2 = parseFloat(alert.summary?.amount) || 0;
        const expRef2 = alert.summary?.reference || "(unknown)";
        const expDesc2 = alert.summary?.description || "";
        const expDate2 = alert.summary?.date || "";
        const expAcctName2 = alert.summary?.accountName || "";
        const aiExpPrompt = `You are a financial reconciliation assistant. Match this expense to an Outgoings vendor or Confirmed job slot.
Expense: £${expAmount2} | Ref: ${expRef2} | Description: ${expDesc2} | Date: ${expDate2} | Account: ${expAcctName2} | VAT: ${vatYesNo2}
Client: ${alert.clientName}
Return a JSON array of options with fields: optionId, title, matchType (job|category|info), jobRow, jobName, matchAnalysis, outgoingsData (for category matches), recommendedActions.`;
        const aiMsg2 = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 3000, messages: [{ role: "user", content: aiExpPrompt }] });
        await logClaudeUsage_(sheets, automationCommanderSheetId, alert.clientName || "", "expense", aiMsg2.usage?.input_tokens || 0, aiMsg2.usage?.output_tokens || 0).catch(() => { });
        let aiExpOptions = [];
        try {
          const raw2 = aiMsg2.content[0].type === "text" ? aiMsg2.content[0].text : "";
          const clean2 = raw2.replace(/```json/g, "").replace(/```/g, "").trim();
          const arr2 = clean2.slice(clean2.indexOf("["), clean2.lastIndexOf("]") + 1);
          aiExpOptions = JSON.parse(arr2);
          if (!Array.isArray(aiExpOptions)) aiExpOptions = [aiExpOptions];
        } catch (e) { aiExpOptions = [{ optionId: 1, title: "AI response could not be parsed", matchType: "info", recommendedActions: [] }]; }
        const aiExpSummary = alert.summary?.summary || `Expense ${expRef2} £${expAmount2}`;
        if (memoryRow) { await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(aiExpOptions) }); }
        else { await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: "expense", clientName: alert.clientName || "", alertSummary: aiExpSummary, cachedOptionsJSON: JSON.stringify(aiExpOptions), status: "cached" }); }
        return res.status(200).json({ success: true, options: aiExpOptions, alertId: alert.rowNumber, previousIgnoreReason });
      }
      // Noise-word stripping for fuzzy matching
      const EXP_NOISE = new Set(["ltd", "limited", "plc", "inc", "llc", "llp", "the", "and", "&",
        "group", "co", "corp", "corporation", "holdings", "international", "uk", "us",
        "solutions", "services", "consulting", "consultancy"]);
      const normExpWords = s => String(s || "").toLowerCase()
        .replace(/['"\-.,()]/g, " ").replace(/\s+/g, " ").trim()
        .split(" ").filter(w => w.length > 1 && !EXP_NOISE.has(w));

      const expDescWords = normExpWords(expenseDescription || expenseRef);

      // Build job matches first (prioritised), then vendor matches, new vendor, fallback
      const jobSysOptions = [];
      const vendorSysOptions = [];

      // ── Option type A: Match to existing Outgoings vendor ────────────────
      // Fuzzy word overlap between expense description and vendor name
      const slotColMapExp = {
        1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
        2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
        3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
      };
      const outgoingsResp2 = await sheets.spreadsheets.values.get({
        spreadsheetId: alert.clientId,
        range: "Outgoings!A1:F112",
      });
      const ogRows2 = outgoingsResp2.data.values || [];
      const vendorMatches = [];
      let lastVendorRow2 = 12;
      for (let i = 12; i <= Math.min(ogRows2.length - 1, 109); i++) {
        const vName = String(ogRows2[i]?.[0] || "").trim();
        const vVAT = String(ogRows2[i]?.[1] || "").trim();
        if (!vName) continue;
        lastVendorRow2 = i;
        const vWords = normExpWords(vName);
        const overlap = expDescWords.some(w => vWords.includes(w)) || vWords.some(w => expDescWords.includes(w));
        if (overlap) vendorMatches.push({ sheetRow: i + 1, vendorName: vName, chargesVAT: vVAT });
      }
      const nextBlankOGRow2 = lastVendorRow2 < 109 ? lastVendorRow2 + 2 : null;
      console.log(`  Outgoings vendor matches: ${vendorMatches.length}`);

      for (const vm of vendorMatches.slice(0, 2)) {
        // Find the best available expense slot for this vendor across candidateJobs
        // For outgoings match, we use outgoingsData block - no slot write needed
        vendorSysOptions.push({
          optionId: vendorSysOptions.length + 1,
          title: `Assign to Outgoings vendor "${vm.vendorName}" (Row ${vm.sheetRow})`,
          matchType: "category",
          jobRow: vm.sheetRow,
          jobName: vm.vendorName,
          matchingDetails: {
            unmatchedJobSummary: {
              clientName: alert.clientName,
              jobName: expenseDescription || expenseRef,
              revenue: String(expenseAmount),
              startDate: expenseDate,
            },
          },
          matchAnalysis: {
            matchConfidence: "Medium",
            placeholderMatch: "N/A - Outgoings vendor assignment",
            budgetFit: "YES",
            reasonForChoice: `Vendor name "${vm.vendorName}" matches expense description word(s). VAT: ${vm.chargesVAT}.`,
            discrepancies: "None",
          },
          outgoingsData: {
            categoryName: vm.vendorName,
            expenseMonth: (() => {
              const ym = parseYearMonth(expenseDate);
              return ym ? `${ym.year}-${String(ym.month).padStart(2, "0")}` : (expenseDate ? expenseDate.slice(3) : "");
            })(),
            transactionId: alert.summary?.transactionId || "",
            amount: expenseAmount,
            description: expenseDescription || expenseRef,
            status: alert.summary?.status || "",
            recDate: expenseDate,
            payDate: "",
            vatCharged: vatYesNo,
          },
          recommendedActions: [`Assign expense to Outgoings vendor "${vm.vendorName}" (row ${vm.sheetRow})`],
        });
      }

      // ── Option type B: Match to Confirmed job (by description word overlap) ─
      const jobDescMatches = [];
      // Format is typically "Vendor name (outline of expense, may include end client name)".
      // Extract the bracketed portion to check for a client-name match - vendor name alone
      // (before the bracket) is not a reliable client signal.
      const expBracketMatch = (expenseDescription || "").match(/\(([^)]*)\)/);
      const expBracketWords = expBracketMatch ? normExpWords(expBracketMatch[1]) : [];

      // Date tolerance: ±expenseMonthsTolerance months from expense date -
      // added 20 Aug 2026, prompted by Paul after the invoice-side date
      // fix. expenseMonthsTolerance was already a configured tolerance
      // value (default 1 month) but was never actually used in this
      // matching logic at all - nothing here previously compared dates.
      // Confirmed with Paul that empty expense placeholder slots DO
      // carry a real expected date the same way invoice placeholders
      // do, which is what makes this comparison meaningful (the empty-
      // slot date was also being silently dropped before this same
      // change - see candidateJobs construction above). Reuses the
      // same parseSheetOrJsDate_/monthsWithinTolerance_ helpers as the
      // invoice side, not a second, separate definition.
      const expMonthsTol = Number(tolerances.expenseMonthsTolerance) || 1;
      const expDateParsed = parseSheetOrJsDate_(expenseDate);
      const dateWithinToleranceExp = (slotDateStr) => {
        if (!expDateParsed || !slotDateStr) return null; // null = unknown, not "false"
        const slotDate = parseSheetOrJsDate_(slotDateStr);
        if (!slotDate) return null;
        return monthsWithinTolerance_(expDateParsed, slotDate, expMonthsTol);
      };

      for (const job of candidateJobs) {
        const jobWords = normExpWords(job.parentJob);
        const clientWords = normExpWords(job.parentClient);
        const jobOverlap = expDescWords.some(w => jobWords.includes(w));
        // Client match: bracketed text overlaps with the job's client name
        const clientOverlap = expBracketWords.length > 0 &&
          (expBracketWords.some(w => clientWords.includes(w)) || clientWords.some(w => expBracketWords.includes(w)));
        if (!jobOverlap && !clientOverlap) continue;
        // Find only the FIRST available slot for this job (in slot-number order)
        const availSlot = job.slots.find(s => s.empty) || job.slots.find(s => !s.isAllocated);
        if (!availSlot) continue;
        const cols = slotColMapExp[availSlot.slotNum];
        const row = availSlot.sheetRow;
        // Total allocated (real only) + this expense
        const realAllocated = job.slots.filter(s => !s.empty && s.isAllocated).reduce((sum, s) => sum + s.amtNum, 0);
        const newTotal = realAllocated + expenseAmount;
        const budgetNum = parseFloat(String(job.totalBudget || "0").replace(/[£$€,]/g, "")) || 0;
        const budgetFit = budgetNum > 0 ? (newTotal <= budgetNum ? "YES" : `OVER by £${(newTotal - budgetNum).toFixed(2)}`) : "UNKNOWN";
        const budgetFits = budgetNum === 0 || newTotal <= budgetNum; // no known budget = don't penalise
        // Exact client match: bracketed text exactly equals the job's client name
        const bracketText = expBracketMatch ? expBracketMatch[1].trim().toLowerCase() : "";
        const isExactClient = !!bracketText && bracketText === String(job.parentClient || "").trim().toLowerCase();
        const dateMatch = dateWithinToleranceExp(availSlot.date);
        jobDescMatches.push({ job, availSlot, cols, row, realAllocated, newTotal, budgetFit, budgetFits, isExactClient, clientOverlap, dateMatch });
      }
      console.log(`  Confirmed job description matches: ${jobDescMatches.length}`);

      // Rank: budget fit → exact client match → partial client overlap → most recent job first
      const parseRankDateExp = (d) => {
        if (!d) return null;
        const MONTHS_MAP = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const mIdx = MONTHS_MAP[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1])).getTime();
      };
      jobDescMatches.sort((a, b) => {
        if (a.budgetFits !== b.budgetFits) return a.budgetFits ? -1 : 1;
        if (a.isExactClient !== b.isExactClient) return a.isExactClient ? -1 : 1;
        // clientOverlap (bracketed end-client text overlapping the job's
        // client name) was already computed per candidate above but
        // never actually used here - added 20 Aug 2026, prompted by
        // Paul asking whether partial client matches are considered on
        // the invoice side. This was sitting right there, unused.
        if (a.clientOverlap !== b.clientOverlap) return a.clientOverlap ? -1 : 1;
        // Expense date within tolerance of the slot's expected date -
        // added 20 Aug 2026, mirroring the same fix and priority
        // position on the invoice side (a direct match signal, ranked
        // above the much weaker/indirect job-recency tie-breaker below).
        const aDateMatch = a.dateMatch === true;
        const bDateMatch = b.dateMatch === true;
        if (aDateMatch !== bDateMatch) return aDateMatch ? -1 : 1;
        const da = parseRankDateExp(a.job.startDate);
        const db = parseRankDateExp(b.job.startDate);
        if (da === null && db === null) return 0;
        if (da === null) return 1;
        if (db === null) return -1;
        return db - da;
      });

      for (const jm of jobDescMatches.slice(0, 2)) {
        const { job, availSlot, cols, row, realAllocated, newTotal, budgetFit, dateMatch } = jm;
        const jobClientLabel = job.parentClient ? `${job.parentClient} - ${job.parentJob}` : job.parentJob;
        const parentRow = job.parentRow || row;
        jobSysOptions.push({
          optionId: jobSysOptions.length + 1,
          title: `Allocate to ${jobClientLabel} - job name match`,
          matchType: "job",
          jobRow: parentRow,
          jobName: job.parentJob,
          jobRevenue: job.revenue,
          targetRowNum: row,
          targetSlotType: "expense",
          targetSlotNum: availSlot.slotNum,
          jobDetails: {
            clientName: job.parentClient,
            jobName: job.parentJob,
            projectCode: job.projectCode,
            revenue: String(job.revenue || ""),
            directCosts: job.budget || job.totalBudget || "£0",
            projectRetainer: job.projType,
            startDate: job.startDate,
            endDate: job.endDate,
            rowNum: parentRow,
          },
          matchingDetails: {
            // Same bug as the invoice side (fixed 20 Aug 2026, confirmed
            // during Paul's review of expense-matching for parity) -
            // unmatchedJobSummary must hold the JOB's own true
            // revenue/start date for row-verification to work (it
            // compares this against what's actually in the sheet
            // before writing), not the expense's own amount/date. This
            // previously used expenseAmount/expenseDate here, which
            // structurally can never match the job row's actual
            // revenue/start date, silently blocking every write through
            // this path. job.revenue/job.startDate are the job's real
            // values (already correctly used below in matchedJobDetails,
            // which row-verification never reads).
            unmatchedJobSummary: {
              clientName: job.parentClient,
              jobName: job.parentJob,
              revenue: String(job.revenue || ""),
              startDate: job.startDate || "",
            },
            matchedJobDetails: {
              clientName: job.parentClient,
              jobName: job.parentJob,
              projectCode: job.projectCode,
              revenue: String(job.revenue || ""),
              startDate: job.startDate,
              endDate: job.endDate,
            },
          },
          matchAnalysis: {
            // Upgraded to High when the expense date falls within
            // tolerance of the slot's expected date - added 20 Aug
            // 2026, mirroring the invoice side's confidence logic
            // exactly (previously hardcoded "Medium" regardless of date
            // proximity, since no date comparison existed at all).
            matchConfidence: dateMatch ? "High" : "Medium",
            placeholderMatch: availSlot.empty ? `YES - Row ${row} ExpSlot${availSlot.slotNum} is empty` : `PARTIAL - unallocated slot available`,
            budgetFit,
            dateRangeMatch: dateMatch === null ? "UNKNOWN" : (dateMatch ? "YES" : "PARTIAL - outside date tolerance"),
            reasonForChoice: `Job name "${job.parentJob}" matches expense description word(s). Currently allocated: £${realAllocated.toFixed(2)}, this expense adds £${expenseAmount.toFixed(2)} → new total £${newTotal.toFixed(2)} vs budget £${job.totalBudget}.`,
            discrepancies: budgetFit.startsWith("OVER") ? `Budget would be exceeded by £${(newTotal - (parseFloat(String(job.totalBudget || "0").replace(/[£$€,]/g, "")) || 0)).toFixed(2)}` : "None",
          },
          recommendedActions: [
            `Allocate expense to "${job.parentJob}" (Row ${row}), ExpSlot${availSlot.slotNum}`,
            `write ${expenseDescription || expenseRef} to ${cols.d}${row}, write ${expenseAmount} to ${cols.a}${row}, write ${vatYesNo} to ${cols.v}${row}, write ${expenseDate} to ${cols.dt}${row}, write 30 to ${cols.dp}${row}, write ${alert.summary?.status || ""} to ${cols.st}${row}`,
          ],
        });
      }

      // ── Option type C: Create new Outgoings vendor ───────────────────────
      // Parse actual vendor name from expenseDescription (strip parenthetical notes like "(Design work)")
      // Falling back to expenseRef if description is absent. Never use expenseAccountName (GL category like "321 - Subcontractors").
      let extractedVendor = "";
      if (expenseDescription) {
        const parenIdx = expenseDescription.search(/[\(\[]/);
        if (parenIdx > 0) {
          extractedVendor = expenseDescription.slice(0, parenIdx).trim();
        } else {
          extractedVendor = expenseDescription.trim();
        }
      }
      if (!extractedVendor && expenseRef && expenseRef !== "(unknown)") {
        const refParenIdx = expenseRef.search(/[\(\[]/);
        if (refParenIdx > 0) {
          extractedVendor = expenseRef.slice(0, refParenIdx).trim();
        } else {
          extractedVendor = expenseRef.trim();
        }
      }
      const guessedVendorName = (extractedVendor || "Unknown vendor").trim();
      if (nextBlankOGRow2) {
        vendorSysOptions.push({
          optionId: vendorSysOptions.length + 1,
          title: `Create new Outgoings vendor "${guessedVendorName}" at row ${nextBlankOGRow2}`,
          matchType: "category",
          jobRow: nextBlankOGRow2,
          jobName: guessedVendorName,
          matchingDetails: {
            unmatchedJobSummary: {
              clientName: alert.clientName,
              jobName: expenseDescription || expenseRef,
              revenue: String(expenseAmount),
              startDate: expenseDate,
            },
          },
          matchAnalysis: {
            matchConfidence: "Low",
            placeholderMatch: "N/A - new vendor row",
            budgetFit: "YES",
            reasonForChoice: `No existing Outgoings vendor matched this expense. A new vendor row will be created at row ${nextBlankOGRow2} using the expense description as the vendor name. Review the vendor name before accepting.`,
            discrepancies: "New vendor - confirm name and VAT setting are correct",
          },
          outgoingsData: {
            categoryName: guessedVendorName,
            expenseMonth: (() => {
              const ym = parseYearMonth(expenseDate);
              return ym ? `${ym.year}-${String(ym.month).padStart(2, "0")}` : (expenseDate ? expenseDate.slice(3) : "");
            })(),
            transactionId: alert.summary?.transactionId || "",
            amount: expenseAmount,
            description: expenseDescription || expenseRef,
            status: alert.summary?.status || "",
            recDate: expenseDate,
            payDate: "",
            vatCharged: vatYesNo,
          },
          recommendedActions: [
            `Create new Outgoings vendor "${guessedVendorName}" at row ${nextBlankOGRow2} (cols A:D)`,
            `Assign this expense to the new vendor row`,
          ],
          isNewVendor: true,
          newVendorRow: nextBlankOGRow2,
          newVendorName: guessedVendorName,
        });
      }

      // ── Option type D: Manual investigation fallback removed: covered by Ignore button

      // Assemble: job matches first (1-2), vendor matches (1-2), new vendor, capped at up to 4 options
      const sysOptions = [...jobSysOptions, ...vendorSysOptions].slice(0, 4);
      // Renumber optionIds
      const options = sysOptions.map((o, i) => ({ ...o, optionId: i + 1 }));
      console.log(`  ✅ System-generated ${options.length} expense options`);

      // Attach jobRowsData for spreadsheet-style display - only for job matches
      // (Outgoings vendor/category matches don't have a Confirmed job row to show)
      const expJobRowCache = new Map();
      for (const opt of options) {
        if (opt.matchType !== "job" || !opt.jobRow) continue;
        const highlightSlot = (opt.targetSlotType && opt.targetSlotNum)
          ? { type: opt.targetSlotType, rowNum: opt.targetRowNum || opt.jobRow, slotNum: opt.targetSlotNum }
          : null;
        const cacheKey = `${opt.jobRow}-${highlightSlot?.rowNum ?? "same"}-${highlightSlot?.slotNum ?? "none"}`;
        if (!expJobRowCache.has(cacheKey)) {
          expJobRowCache.set(cacheKey, await fetchJobRowsForDisplay(sheets, alert.clientId, "Confirmed", opt.jobRow, highlightSlot, sharedData));
        }
        opt.jobRowsData = expJobRowCache.get(cacheKey);
      }

      // Cache in AlertMemory
      const alertSummary = alert.summary?.summary || `Expense ${alert.summary?.reference || ""} £${alert.summary?.amount || ""}`;
      if (memoryRow) {
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
          ...memoryRow,
          cachedOptionsJSON: JSON.stringify(options),
        });
      } else {
        await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
          fingerprintHash,
          alertType: "expense",
          clientName: alert.clientName || "",
          alertSummary,
          cachedOptionsJSON: JSON.stringify(options),
          status: "cached",
        });
      }
      console.log(`  💾 Options cached in AlertMemory`);

      return res.status(200).json({
        success: true,
        options,
        alertId: alert.rowNumber,
        previousIgnoreReason
      });
    }

    // Handle CRM alerts        // Handle CRM alerts
    if (alert.type === "crm" || alert.sheetName === "CRMComp") {
      console.log(`  📊 Analyzing CRM alert...`);

      const alertType = alert.alertType || alert.flagType || "";

      // App discrepancy: job exists in sheet (Confirmed/Pipeline) but not in CRM.
      // The only valid actions are: ignore the discrepancy, or delete the job from the sheet.
      // We never suggest creating a job - Claude is not needed here.
      if (alertType === "crmConfAppDiscr" || alertType === "crmPipeAppDiscr") {
        const tabName = alertType === "crmPipeAppDiscr" ? "Pipeline" : "Confirmed";
        const src = alert.data?.sheetData || [];
        // sheetData: EF=client[0], EG=job[1], EH=code[2], EI=revenue[3], EJ=dirCosts[4], EK=start[5], EL=end[6], EM=likelihood[7]
        const client = src[0] || alert.clientName || "";
        const jobName = src[1] || "";
        const projectCode = src[2] || "";
        const revenue = src[3] || "";
        const dirCosts = src[4] || "";
        const startDate = src[5] || "";
        const endDate = src[6] || "";
        const likelihood = src[7] || "";
        const jobDesc = [client, jobName, projectCode].filter(Boolean).join(" - ");

        let options = [];
        let jobRow = null;      // declared here so both branches can set it and the DD read below can use it
        let copiedToConf = "";

        if (alert.subType === "field_mismatch") {
          // Job exists in both sheet and CRM but fields differ
          // crmData: EU=code[0], EV=client[1], EW=job[2], EX=revenue[3], EY=dirCosts[4], EZ=start[5], FA=end[6], FB=likelihood[7]
          const crmSrc = alert.data?.crmData || [];
          const crmCode = crmSrc[0] || "";
          const crmClient = crmSrc[1] || "";
          const crmJob = crmSrc[2] || "";
          const crmRevenue = crmSrc[3] || "";
          const crmDirCosts = crmSrc[4] || "";
          const crmStart = crmSrc[5] || "";
          const crmEnd = crmSrc[6] || "";
          const crmLikely = crmSrc[7] || "";

          // Look up job row in tab for precise cell writes
          const tabStartRow = tabName === "Pipeline" ? 6 : 1;
          let tabRows = [];
          if (sharedData && tabName === "Confirmed" && sharedData.confirmedDataWide) {
            tabRows = sharedData.confirmedDataWide;
          } else if (sharedData && tabName === "Pipeline" && sharedData.pipelineData) {
            tabRows = sharedData.pipelineData;
          } else {
            const tabResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: `${tabName}!A1:AM5000`,
            });
            tabRows = tabResp.data.values || [];
          }
          const codeToFind = (projectCode || crmCode).toLowerCase();
          const clientToFind = (client || crmClient).toLowerCase();
          const jobToFind = (jobName || crmJob).toLowerCase();
          for (let tr = tabName === "Pipeline" ? 5 : 0; tr < tabRows.length; tr++) {
            const r = tabRows[tr] || [];
            const rCode = String(r[2] || "").trim().toLowerCase();
            const rClient = String(r[0] || "").trim().toLowerCase();
            const rJob = String(r[1] || "").trim().toLowerCase();
            if (codeToFind && rCode === codeToFind) { jobRow = tr + 1; break; }
            if (!codeToFind && rClient === clientToFind && rJob === jobToFind) { jobRow = tr + 1; break; }
          }

          const mismatchFields = alert.mismatchFields || [];
          const APP_FIELD_CONFIG = [
            { name: "Client name", sheet: client, crm: crmClient, col: "A", writable: true },
            { name: "Job name", sheet: jobName, crm: crmJob, col: "B", writable: true },
            { name: "Revenue", sheet: revenue, crm: crmRevenue, col: "AG", writable: true },
            { name: "Direct costs", sheet: dirCosts, crm: crmDirCosts, col: "AH", writable: true },
            { name: "Start date", sheet: startDate, crm: crmStart, col: "AL", writable: true },
            { name: "End date", sheet: endDate, crm: crmEnd, col: "AM", writable: true },
            { name: "% Likelihood", sheet: likelihood, crm: crmLikely, col: "AN", writable: tabName === "Pipeline" },
          ];

          if (jobRow) {
            // Collect child rows to safely batch structural updates (Client/Job names)
            const jobRowsToUpdate = [jobRow];
            for (let i = jobRow; i < tabRows.length; i++) {
              const r = tabRows[i] || [];
              const rClient = String(r[0] || "").trim().toLowerCase();
              const rJob = String(r[1] || "").trim().toLowerCase();
              if (rClient === clientToFind && rJob === jobToFind && !String(r[32] || "").trim() && !String(r[37] || "").trim()) {
                jobRowsToUpdate.push(i + 1);
              } else {
                break;
              }
            }

            const actions = [];
            const explanations = [];

            for (const fc of APP_FIELD_CONFIG) {
              if (!mismatchFields.includes(fc.name)) continue;
              if (fc.writable) {
                explanations.push(`${fc.name} (${tabName}: "${fc.sheet}" → CRM: "${fc.crm}")`);
                if (fc.name === "Client name" || fc.name === "Job name") {
                  jobRowsToUpdate.forEach(r => actions.push(`Write "${fc.crm}" to ${fc.col}${r}`));
                } else {
                  actions.push(`Write "${fc.crm}" to ${fc.col}${jobRow}`);
                }
              }
            }

            if (actions.length > 0) {
              let titleStr = "";
              let btnText = "";
              if (explanations.length === 1) {
                const singleField = mismatchFields[0] || "field";
                const fc = APP_FIELD_CONFIG.find(f => f.name === singleField);
                titleStr = `Update ${singleField.toLowerCase()} in Pulse to "${fc?.crm || ''}"`;
                btnText = `Update ${singleField.toLowerCase()} in Pulse`;
              } else {
                titleStr = `Update all ${explanations.length} mismatched fields in Pulse to match CRM`;
                btnText = `Update fields in Pulse`;
              }

              options.push({
                optionId: 1,
                title: titleStr,
                actionButtonText: btnText,
                matchType: "existing_job",
                jobRow,
                jobName: jobName || crmJob,
                explanation: `Update ${tabName} to match CRM data: ${explanations.join("; ")}`,
                matchingDetails: {
                  unmatchedJobSummary: { clientName: client || crmClient, jobName: jobName || crmJob, projectCode: projectCode || crmCode },
                },
                matchAnalysis: {
                  matchConfidence: "High",
                  reasonForChoice: `Mismatched fields: ${explanations.join("; ")}. Updating ${tabName} to match CRM data.`,
                  discrepancies: `Mismatch fields: ${mismatchFields.join(", ")}`,
                },
                recommendedActions: [
                  `Update all writable mismatched fields in ${tabName} tab to match CRM values`,
                  ...actions
                ],
              });
            }
          }

          // Always add Option 2: Ignore discrepancy
          options.push({
            optionId: options.length + 1,
            title: `Ignore discrepancy (keep Pulse value)`,
            actionButtonText: `Ignore discrepancy`,
            matchType: "ignore",
            jobRow: jobRow || alert.rowNumber,
            jobName: jobName || crmJob,
            matchingDetails: {
              unmatchedJobSummary: { clientName: client || crmClient, jobName: jobName || crmJob, projectCode: projectCode || crmCode },
            },
            explanation: `Mark this discrepancy as ignored. No changes will be made to either Pulse or CRM.`,
            recommendedActions: [`Mark this field mismatch as ignored - no changes will be made`],
          });

        } else {
          // not_found: job in sheet but not in CRM
          // Search the tab to find the actual Pipeline/Confirmed row number
          if (client || jobName || projectCode) {
            try {
              let tabSearchRows = [];
              if (sharedData && tabName === "Confirmed" && sharedData.confirmedDataWide) {
                tabSearchRows = sharedData.confirmedDataWide;
              } else if (sharedData && tabName === "Pipeline" && sharedData.pipelineData) {
                tabSearchRows = sharedData.pipelineData;
              } else {
                const tabSearchResp = await sheets.spreadsheets.values.get({
                  spreadsheetId: alert.clientId,
                  range: `${tabName}!A1:C5000`,
                });
                tabSearchRows = tabSearchResp.data.values || [];
              }
              const codeToFind2 = (projectCode || "").toLowerCase();
              const clientToFind2 = (client || "").toLowerCase();
              const jobToFind2 = (jobName || "").toLowerCase();
              for (let tr2 = tabName === "Pipeline" ? 5 : 0; tr2 < tabSearchRows.length; tr2++) {
                const r2 = tabSearchRows[tr2] || [];
                const rCode2 = String(r2[2] || "").trim().toLowerCase();
                const rClient2 = String(r2[0] || "").trim().toLowerCase();
                const rJob2 = String(r2[1] || "").trim().toLowerCase();
                if (codeToFind2 && rCode2 === codeToFind2) { jobRow = tr2 + 1; break; }
                if (!codeToFind2 && rClient2 === clientToFind2 && rJob2 === jobToFind2) { jobRow = tr2 + 1; break; }
              }
            } catch (e) { console.log("  not_found tab search failed:", e.message); }
          }

          options = [
            {
              optionId: 1,
              title: `Ignore discrepancy — "${jobDesc}" is legitimate and intentional`,
              actionButtonText: `Ignore discrepancy`,
              matchType: "ignore",
              jobRow: jobRow || alert.rowNumber,
              jobName,
              explanation: `Mark this CRM discrepancy as ignored to prevent it recurring. "${jobDesc}" will remain in the ${tabName} tab with no changes made to CRM.`,
              matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode, revenue, startDate, endDate, likelihood } },
              recommendedActions: [
                `Verify that "${jobDesc}" is intentionally absent from the CRM`,
                `If confirmed, mark this alert as ignored to prevent it recurring`,
              ],
            },
            {
              optionId: 2,
              title: `Delete "${jobDesc}" from ${tabName} tab`,
              actionButtonText: `Delete job from ${tabName}`,
              matchType: "delete",
              jobRow: jobRow || alert.rowNumber,
              jobName,
              explanation: `Remove "${jobDesc}" and all of its associated rows from the ${tabName} tab. Please verify that no real invoices or expenses are linked before accepting.`,
              matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode, revenue, startDate, endDate, likelihood } },
              recommendedActions: [
                `Blank all cells for "${jobDesc}" and its child rows in the ${tabName} tab`,
                `All columns A:G, AG:AM, AN, AP:BH, BX:CR, DD will be cleared across the parent row and all child rows`,
                `Verify no invoices or expenses are linked to this job before accepting`,
              ],
            },
          ];
        }

        // For Pipeline tab: fetch Copied to Confirmed? (col DD, index 107) for matched row
        if (tabName === "Pipeline" && jobRow) {
          try {
            const ddResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: `Pipeline!DD${jobRow}`,
            });
            copiedToConf = String(ddResp.data.values?.[0]?.[0] || "").trim();
          } catch (e) { console.log("  copiedToConf read failed:", e.message); }
        }

        console.log(`  ✅ App discr (${alert.subType || "not_found"}) - ${options.length} options for ${jobDesc}`);

        // Inject Pipeline-specific fields onto options
        if (tabName === "Pipeline" && copiedToConf !== undefined) {
          options = options.map(o => ({ ...o, copiedToConf }));
        }

        // Attach jobRowsData for spreadsheet-style display
        if (jobRow) {
          const notFoundJobRows = await fetchJobRowsForDisplay(sheets, alert.clientId, tabName, jobRow, null, sharedData);
          options = options.map(o => ({ ...o, jobRowsData: notFoundJobRows }));
        }

        // Cache these options
        const crmSummary = `CRM ${alertType} ${jobDesc}`.trim();
        if (memoryRow) {
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
            ...memoryRow,
            cachedOptionsJSON: JSON.stringify(options),
          });
        } else {
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
            fingerprintHash,
            alertType: "crm",
            clientName: alert.clientName || "",
            alertSummary: crmSummary,
            cachedOptionsJSON: JSON.stringify(options),
            status: "cached",
          });
        }

        return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
      }

      // ── Field mismatch handler (no Claude needed) ──────────────────────
      // subType === "field_mismatch": job exists in both CRM and sheet,
      // but one or more fields differ. Generate hardcoded options per field.
      if (alert.subType === "field_mismatch") {
        const tabName = alert.alertType === "crmPipeDashDiscr" ? "Pipeline" : "Confirmed";
        const crmArr = alert.data?.crmData || [];
        const shtArr = alert.data?.sheetData || [];

        // CRM layout: [0]=client, [1]=job, [2]=code, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
        // Sheet layout: [0]=code, [1]=client, [2]=job, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
        const crmClient = crmArr[0] || "";
        const crmJob = crmArr[1] || "";
        const crmCode = crmArr[2] || "";
        const crmRevenue = crmArr[3] || "";
        const crmDirCosts = crmArr[4] || "";
        const crmStart = crmArr[5] || "";
        const crmEnd = crmArr[6] || "";
        const crmLikely = crmArr[7] || "";

        const shtCode = shtArr[0] || "";
        const shtClient = shtArr[1] || "";
        const shtJob = shtArr[2] || "";
        const shtRevenue = shtArr[3] || "";
        const shtDirCosts = shtArr[4] || "";
        const shtStart = shtArr[5] || "";
        const shtEnd = shtArr[6] || "";
        const shtLikely = shtArr[7] || "";

        // Find the job row in Pipeline/Confirmed by project code (or client+job fallback)
        const tabStartRow = tabName === "Pipeline" ? 6 : 1;
        let tabRows = [];
        if (sharedData && tabName === "Confirmed" && sharedData.confirmedDataWide) {
          tabRows = sharedData.confirmedDataWide;
        } else if (sharedData && tabName === "Pipeline" && sharedData.pipelineData) {
          tabRows = sharedData.pipelineData;
        } else {
          const tabResp = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: `${tabName}!A1:AM5000`,
          });
          tabRows = tabResp.data.values || [];
        }
        let jobRow = null;
        let copiedToConf = "";
        const codeToFind = (shtCode || crmCode).toLowerCase();
        const clientToFind = (shtClient || crmClient).toLowerCase();
        const jobToFind = (shtJob || crmJob).toLowerCase();

        for (let tr = tabStartRow === 6 ? 5 : 0; tr < tabRows.length; tr++) {
          const r = tabRows[tr] || [];
          const rCode = String(r[2] || "").trim().toLowerCase();
          const rClient = String(r[0] || "").trim().toLowerCase();
          const rJob = String(r[1] || "").trim().toLowerCase();
          // Match by project code first, then client+job
          if (codeToFind && rCode === codeToFind) { jobRow = tr + 1; copiedToConf = String(r[107] || "").trim(); break; }
          if (!codeToFind && rClient === clientToFind && rJob === jobToFind) { jobRow = tr + 1; copiedToConf = String(r[107] || "").trim(); break; }
        }

        const rowRef = jobRow ? ` (${tabName} row ${jobRow})` : "";
        const jobLabel = `${shtClient || crmClient} - ${shtJob || crmJob}${crmCode ? ` (${crmCode})` : ""}`;

        // Consolidated mismatch handler
        const mismatchFields = alert.mismatchFields || [];
        let options = [];

        // Field config: [flagName, crmValue, sheetValue, tabCol, isWritable, note]
        const FIELD_CONFIG = [
          { name: "Client name", crm: crmClient, sheet: shtClient, col: "A", writable: true },
          { name: "Job name", crm: crmJob, sheet: shtJob, col: "B", writable: true },
          { name: "Revenue", crm: crmRevenue, sheet: shtRevenue, col: "AG", writable: true },
          { name: "Direct costs", crm: crmDirCosts, sheet: shtDirCosts, col: "AH", writable: true },
          { name: "Start date", crm: crmStart, sheet: shtStart, col: "AL", writable: true },
          { name: "End date", crm: crmEnd, sheet: shtEnd, col: "AM", writable: true },
          { name: "% Likelihood", crm: crmLikely, sheet: shtLikely, col: "AN", writable: tabName === "Pipeline" },
        ];

        if (jobRow) {
          // Collect child rows to safely batch structural updates (Client/Job names)
          const jobRowsToUpdate = [jobRow];
          for (let i = jobRow; i < tabRows.length; i++) { // jobRow is 1-indexed, so tabRows[jobRow] targets the next row down
            const r = tabRows[i] || [];
            const rClient = String(r[0] || "").trim().toLowerCase();
            const rJob = String(r[1] || "").trim().toLowerCase();
            // If it shares the identity but has no revenue/dates of its own, it's a child row
            if (rClient === clientToFind && rJob === jobToFind && !String(r[32] || "").trim() && !String(r[37] || "").trim()) {
              jobRowsToUpdate.push(i + 1);
            } else {
              break;
            }
          }

          const actions = [];
          const explanations = [];
          const unWritable = [];

          for (const fc of FIELD_CONFIG) {
            if (!mismatchFields.includes(fc.name)) continue;
            if (fc.writable) {
              explanations.push(`${fc.name} (${tabName}: "${fc.sheet}" → CRM: "${fc.crm}")`);
              // Structural fields map to every row in the block; scalar fields map only to the parent
              if (fc.name === "Client name" || fc.name === "Job name") {
                jobRowsToUpdate.forEach(r => actions.push(`Write "${fc.crm}" to ${fc.col}${r}`));
              } else {
                actions.push(`Write "${fc.crm}" to ${fc.col}${jobRow}`);
              }
            } else {
              unWritable.push(fc.name);
            }
          }

          if (actions.length > 0) {
            let titleStr = "";
            let btnText = "";
            if (explanations.length === 1) {
              const singleField = mismatchFields[0] || "field";
              const fc = FIELD_CONFIG.find(f => f.name === singleField);
              titleStr = `Update ${singleField.toLowerCase()} in Pulse to "${fc?.crm || ''}"`;
              btnText = `Update ${singleField.toLowerCase()} in Pulse`;
            } else {
              titleStr = unWritable.length > 0
                ? `Update writable fields (${explanations.length}) to match CRM`
                : `Update all ${explanations.length} mismatched fields in Pulse to match CRM`;
              btnText = `Update fields in Pulse`;
            }

            options.push({
              optionId: options.length + 1,
              title: titleStr,
              actionButtonText: btnText,
              matchType: "existing_job",
              jobRow,
              jobName: shtJob || crmJob,
              explanation: `Update ${tabName} to match CRM data: ${explanations.join("; ")}`,
              matchingDetails: {
                unmatchedJobSummary: { clientName: shtClient || crmClient, jobName: shtJob || crmJob, projectCode: shtCode || crmCode },
              },
              matchAnalysis: {
                matchConfidence: "High",
                reasonForChoice: `Mismatched fields: ${explanations.join("; ")}. Updating ${tabName} to match CRM data.`,
                discrepancies: `Mismatch fields: ${mismatchFields.join(", ")}`,
              },
              recommendedActions: [
                `Update all writable mismatched fields in ${tabName} tab to match CRM values`,
                ...actions
              ],
            });
          }

          // Catch un-writable fields (e.g., Likelihood mismatch on the Confirmed tab)
          if (unWritable.length > 0 && actions.length === 0) {
            options.push({
              optionId: options.length + 1,
              title: `Update ${mismatchFields.join(", ")} in Pulse`,
              actionButtonText: `Update Pulse`,
              matchType: "existing_job",
              jobName: shtJob || crmJob,
              explanation: `${unWritable.join(", ")} cannot be updated automatically in ${tabName} tab. Review and update manually.`,
              matchAnalysis: {
                matchConfidence: "Medium",
                reasonForChoice: `Mismatched fields (${unWritable.join(", ")}). Updating Pulse to match CRM data.`,
                discrepancies: `Mismatched fields: ${unWritable.join(", ")}`,
              },
              recommendedActions: [
                `Review and update ${unWritable.join(", ")} in ${tabName} tab manually to match CRM`,
              ],
            });
          }
        } else {
          // Fallback if the job row cannot be found
          options.push({
            optionId: options.length + 1,
            title: `Update ${mismatchFields.join(", ")} in Pulse (${shtJob || crmJob})`,
            actionButtonText: `Update Pulse`,
            matchType: "existing_job",
            jobName: shtJob || crmJob,
            explanation: `Job row could not be located automatically in ${tabName} tab. Update ${mismatchFields.join(", ")} to match CRM data.`,
            matchAnalysis: {
              matchConfidence: "Low",
              reasonForChoice: `Mismatch detected in ${mismatchFields.join(", ")}. Locate job in ${tabName} tab and update to match CRM.`,
              discrepancies: `Mismatched fields: ${mismatchFields.join(", ")}`,
            },
            recommendedActions: [
              `Locate job in ${tabName} tab and update ${mismatchFields.join(", ")} to match CRM`,
            ],
          });
        }

        // Always add an ignore option as option 2
        options.push({
          optionId: options.length + 1,
          title: `Ignore discrepancy (keep Pulse value)`,
          actionButtonText: `Ignore discrepancy`,
          matchType: "ignore",
          jobRow: jobRow || alert.rowNumber,
          jobName: shtJob || crmJob,
          explanation: `Mark this discrepancy as ignored. No changes will be made to either Pulse or CRM.`,
          matchingDetails: {
            unmatchedJobSummary: { clientName: shtClient || crmClient, jobName: shtJob || crmJob, projectCode: shtCode || crmCode },
          },
          recommendedActions: [
            `Mark this discrepancy as ignored - no changes will be made to either system`,
          ],
        });

        // For Pipeline tab: fetch Copied to Confirmed? (col DD, index 107) for matched row
        if (tabName === "Pipeline" && jobRow) {
          try {
            const ddResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: `Pipeline!DD${jobRow}`,
            });
            copiedToConf = String(ddResp.data.values?.[0]?.[0] || "").trim();
          } catch (e) { console.log("  copiedToConf read failed:", e.message); }
        }

        if (jobRow && alert.clientId) {
          try {
            const jrd = await fetchJobRowsForDisplay(sheets, alert.clientId, tabName, jobRow, null, sharedData);
            if (jrd && jrd.length > 0 && options[0]) {
              options[0].jobRowsData = jrd;
            }
          } catch (jrdErr) {
            console.log("  ⚠️ Failed to fetch jobRowsData for CRM field mismatch:", jrdErr.message);
          }
        }

        console.log(`  ✅ Field mismatch - ${mismatchFields.join(", ")} - returning ${options.length} options for ${jobLabel}`);

        // Inject Pipeline-specific fields onto options
        if (tabName === "Pipeline" && copiedToConf !== undefined) {
          options = options.map(o => ({ ...o, copiedToConf }));
        }

        const crmSummaryMismatch = `CRM mismatch ${jobLabel} [${mismatchFields.join(", ")}]`.trim();
        if (memoryRow) {
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
            ...memoryRow, cachedOptionsJSON: JSON.stringify(options),
          });
        } else {
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
            fingerprintHash, alertType: "crm", clientName: alert.clientName || "",
            alertSummary: crmSummaryMismatch, cachedOptionsJSON: JSON.stringify(options), status: "cached",
          });
        }

        return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
      }

      // ── System-generated options for CRM dashboard not_found ──────────────
      // If forceAI is set, skip system options - return a simple AI-generated response
      if (req.body.forceAI === true) {
        console.log("  🤖 forceAI=true - using Claude for CRM dashboard options");
        const crmModeAI = await getCRMMatchingMode(sheets, alert.masterSheetId || alert.clientId);
        const crmTabAI = crmModeAI === "Pipeline" ? "Pipeline" : "Confirmed";
        const crmSrcAI = alert.data?.crmData || [];
        const aiCrmPrompt = `You are a financial reconciliation assistant. A CRM job is missing from the ${crmTabAI} tab. Generate options: IGNORE or CREATE NEW job. CRM data: Client=${crmSrcAI[0] || ""}, Job=${crmSrcAI[1] || ""}, Code=${crmSrcAI[2] || ""}, Revenue=${crmSrcAI[3] || ""}, Start=${crmSrcAI[5] || ""}, End=${crmSrcAI[6] || ""}. Return JSON array with optionId, title, matchType (ignore|create_new), matchingDetails, newJobData (for create_new), recommendedActions.`;
        const aiCrmMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 2000, messages: [{ role: "user", content: aiCrmPrompt }] });
        await logClaudeUsage_(sheets, automationCommanderSheetId, alert.clientName || "", "crm", aiCrmMsg.usage?.input_tokens || 0, aiCrmMsg.usage?.output_tokens || 0).catch(() => { });
        let aiCrmOptions = [];
        try {
          const rawCrm = aiCrmMsg.content[0].type === "text" ? aiCrmMsg.content[0].text : "";
          const cleanCrm = rawCrm.replace(/```json/g, "").replace(/```/g, "").trim();
          const arrCrm = cleanCrm.slice(cleanCrm.indexOf("["), cleanCrm.lastIndexOf("]") + 1);
          aiCrmOptions = JSON.parse(arrCrm);
          if (!Array.isArray(aiCrmOptions)) aiCrmOptions = [aiCrmOptions];
        } catch (e) { aiCrmOptions = [{ optionId: 1, title: "AI response could not be parsed", matchType: "info", recommendedActions: [] }]; }
        const aiCrmSummary = `CRM ${alert.alertType || ""} ${crmSrcAI[0] || ""} ${crmSrcAI[1] || ""}`.trim();
        if (memoryRow) { await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(aiCrmOptions) }); }
        else { await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: alert.alertType || "crm", clientName: alert.clientName || "", alertSummary: aiCrmSummary, cachedOptionsJSON: JSON.stringify(aiCrmOptions), status: "cached" }); }
        return res.status(200).json({ success: true, options: aiCrmOptions, alertId: alert.rowNumber, previousIgnoreReason });
      }
      // A job exists in CRM but is absent from Pipeline/Confirmed.
      // Options: Ignore, or Create new job in the sheet.
      const crmMode = await getCRMMatchingMode(sheets, alert.masterSheetId || alert.clientId);
      console.log(`  Mode: ${crmMode}`);
      const dashTabName = crmMode === "Pipeline" ? "Pipeline" : "Confirmed";

      // Extract CRM data - layout: [0]=client,[1]=job,[2]=code,[3]=revenue,[4]=dirCosts,[5]=start,[6]=end,[7]=likelihood
      const dashCrmArr = alert.data?.crmData || [];
      const dashShtArr = alert.data?.sheetData || [];
      const dashClient = dashCrmArr[0] || dashShtArr[1] || "";
      const dashJob = dashCrmArr[1] || dashShtArr[2] || "";
      const dashCode = dashCrmArr[2] || dashShtArr[0] || "";
      const dashRevenue = dashCrmArr[3] || dashShtArr[3] || "";
      const dashDirCosts = dashCrmArr[4] || dashShtArr[4] || "";
      const dashStart = dashCrmArr[5] || dashShtArr[5] || "";
      const dashEnd = dashCrmArr[6] || dashShtArr[6] || "";
      const dashLikely = dashCrmArr[7] || dashShtArr[7] || "";
      const dashJobDesc = [dashClient, dashJob, dashCode].filter(Boolean).join(" - ");

      const dashOptions = [
        {
          optionId: 1,
          title: `Ignore discrepancy — "${dashJobDesc || "unknown"}" can be disregarded`,
          actionButtonText: `Ignore discrepancy`,
          matchType: "ignore",
          jobRow: alert.rowNumber,
          jobName: dashJob,
          explanation: `Mark this CRM discrepancy as ignored to prevent it recurring. "${dashJobDesc || "This job"}" will remain in CRM and will not be added to ${dashTabName}.`,
          matchingDetails: {
            unmatchedJobSummary: {
              clientName: dashClient,
              jobName: dashJob,
              projectCode: dashCode,
              revenue: dashRevenue,
              startDate: dashStart,
              endDate: dashEnd,
              likelihood: dashLikely,
            },
          },
          matchAnalysis: {
            matchConfidence: "N/A",
            reasonForChoice: `Job "${dashJobDesc}" exists in CRM but not in ${dashTabName}. If this is intentional, mark as ignored.`,
            discrepancies: `Job present in CRM but absent from ${dashTabName}`,
          },
          recommendedActions: [
            `Verify that "${dashJobDesc}" is intentionally absent from ${dashTabName}`,
            `If confirmed, mark this alert as ignored to prevent it recurring`,
          ],
        },
        {
          optionId: 2,
          title: `Create new job "${dashJobDesc || "unknown"}" in ${dashTabName} tab from CRM data`,
          actionButtonText: `Create job in ${dashTabName}`,
          matchType: "create_new",
          jobRow: null,
          jobName: dashJob,
          explanation: `Create a new job row in the ${dashTabName} tab using the pre-filled revenue, dates, and client information from CRM.`,
          matchingDetails: {
            unmatchedJobSummary: {
              clientName: dashClient,
              jobName: dashJob,
              projectCode: dashCode,
              revenue: dashRevenue,
              startDate: dashStart,
              endDate: dashEnd,
              likelihood: dashLikely,
            },
          },
          matchAnalysis: {
            matchConfidence: "Medium",
            reasonForChoice: `Create a new job row in ${dashTabName} using the CRM data. Review all fields before accepting.`,
            discrepancies: "New job - confirm all fields before accepting",
          },
          newJobData: {
            clientName: dashClient,
            jobName: dashJob,
            projectCode: dashCode,
            revenue: dashRevenue,
            directCostBudget: dashDirCosts,
            startDate: dashStart,
            endDate: dashEnd,
            likelihood: dashLikely,
            inv1Amount: "", inv1Ref: "", inv1SentDate: "", inv1DaysToPay: "", inv1Status: "",
            inv2Amount: "", inv2Ref: "", inv2SentDate: "", inv2DaysToPay: "", inv2Status: "",
            inv3Amount: "", inv3Ref: "", inv3SentDate: "", inv3DaysToPay: "", inv3Status: "",
          },
          recommendedActions: [
            `Create new job in ${dashTabName} tab: "${dashJobDesc}"`,
            `Write client name "${dashClient}" to col A, job name "${dashJob}" to col B, code "${dashCode}" to col C`,
            `Write revenue "${dashRevenue}" to col AG, direct costs "${dashDirCosts}" to col AH`,
            `Write start date "${dashStart}" to col AL, end date "${dashEnd}" to col AM`,
          ],
        },
      ];

      const dashSummary = `CRM ${alert.alertType || ""} ${dashJobDesc}`.trim();
      if (memoryRow) {
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
          ...memoryRow, cachedOptionsJSON: JSON.stringify(dashOptions),
        });
      } else {
        await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
          fingerprintHash, alertType: alert.alertType || "crm",
          clientName: alert.clientName || "", alertSummary: dashSummary,
          cachedOptionsJSON: JSON.stringify(dashOptions), status: "cached",
        });
      }
      console.log(`  💾 Options cached in AlertMemory`);

      return res.status(200).json({
        success: true,
        options: dashOptions,
        alertId: alert.rowNumber,
        previousIgnoreReason
      });
    }

    // Default: Handle invoice alerts        // Default: Handle invoice alerts with flag-based branching
    // flags slice = row.slice(18, 25) = cols S:Y (indices 0-6 within slice)
    // S(0)=Missing invoice, T(1)=Client mismatch, U(2)=Inv amt mismatch,
    // V(3)=Sent date mismatch, W(4)=Duplicate inv no (skip), X(5)=Fully paid on mismatch,
    // Y(6)=Status mismatch
    // flags slice = row.slice(18, 25) = cols S:Y (indices 0-6 within slice)
    // S(0)=Missing invoice, T(1)=Client mismatch, U(2)=Inv amt mismatch,
    // V(3)=Sent date mismatch, W(4)=Duplicate inv no, X(5)=Fully paid on mismatch,
    // Y(6)=Status mismatch
    const invFlags = alert.data?.flags || [];
    const isMissingInvoice = String(invFlags[0] || "").trim() === "1";
    const isDuplicateInvoice = Boolean(alert.isDuplicateInvoice || String(invFlags[4] || "").trim() === "1" || (alert.spreadsheetItems && alert.spreadsheetItems.length > 1));
    const isInvAmtMismatch = String(invFlags[2] || "").trim() === "1";
    const isSentDateMismatch = String(invFlags[3] || "").trim() === "1";
    const isPayDateMismatch = String(invFlags[5] || "").trim() === "1";
    const isStatusMismatch = String(invFlags[6] || "").trim() === "1";
    const isClientMismatch = String(invFlags[1] || "").trim() === "1";
    const invFlagNames = ["Missing invoice", "Client mismatch", "Inv amt mismatch",
      "Sent date mismatch", "Duplicate invoice in sheet", "Fully paid on mismatch", "Status mismatch"];
    const activeInvFlags = invFlags.map((v, i) => String(v || "").trim() === "1" && invFlagNames[i] ? invFlagNames[i] : null).filter(Boolean);

    // accounting slice = cols A:K (indices 0-10)
    const invAccounting = alert.data?.accounting || [];
    const invConfirmed = alert.data?.confirmed || [];
    const invoiceNo = String(invAccounting[5] || "").trim();   // F
    const grossAmount = parseFloat(String(invAccounting[2] || "0").replace(/[£$€,]/g, "")) || 0; // C
    const totalExclVAT = parseFloat(String(invAccounting[3] || "0").replace(/[£$€,]/g, "")) || 0; // D
    const vatIncluded = parseFloat(String(invAccounting[4] || "0").replace(/[£$€,]/g, "")) || 0; // E
    const invClient = String(invAccounting[0] || "").trim();   // A
    const invJob = String(invAccounting[1] || "").trim();   // B
    const invSentDate = String(invAccounting[6] || "").trim();   // G
    const invStatus = String(invAccounting[9] || "").trim();   // J
    const dashboardTotal = parseFloat(String(invConfirmed[2] || "0").replace(/[£$€,]/g, "")) || 0; // O

    console.log(`  Invoice flags: ${activeInvFlags.join(", ") || "unknown"}`);
    console.log(`  Invoice #${invoiceNo}, gross=£${grossAmount}, exclVAT=£${totalExclVAT}, VAT=£${vatIncluded}, dashboardTotal=£${dashboardTotal}`);

    // Helper to check for real invoice reference vs placeholders
    const isRealSlotRef = (ref) => {
      const r = String(ref || "").trim();
      return r && !isPlaceholderInvoice(r);
    };

    // ═════════════════════════════════════════════════════════════════════
    // DATA MISMATCH DISPATCHER (Invoice already exists in spreadsheet)
    // ═════════════════════════════════════════════════════════════════════
    if (!isMissingInvoice) {
      let invConfirmedRows = [];
      if (sharedData && sharedData.confirmedDataWide) {
        invConfirmedRows = sharedData.confirmedDataWide;
        console.log(`  ✓ Used cached Confirmed data (${invConfirmedRows.length} rows)`);
      } else {
        console.log(`  Fetching Confirmed tab to find invoice #${invoiceNo}...`);
        const invConfirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: alert.clientId,
          range: "Confirmed!A1:BH5000",
        }));
        invConfirmedRows = invConfirmedResp.data.values || [];
      }

      // ── Branch 1: Duplicate invoice in spreadsheet ──────────────────────
      if (isDuplicateInvoice) {
        console.log(`  ⚠️ Duplicate invoice in spreadsheet detected for invoice #${invoiceNo}`);
        const matchedJobs = [];
        for (let ri = 1; ri < invConfirmedRows.length; ri++) {
          const r = invConfirmedRows[ri] || [];
          const ref1 = String(r[42] || "").trim(); // AQ
          const ref2 = String(r[49] || "").trim(); // AX
          const ref3 = String(r[56] || "").trim(); // BE
          let slotNum = null;
          if (ref1 === invoiceNo) slotNum = 1;
          else if (ref2 === invoiceNo) slotNum = 2;
          else if (ref3 === invoiceNo) slotNum = 3;

          if (slotNum) {
            const rowNum = ri + 1;
            const jobName = String(r[1] || "").trim();
            const clientName = String(r[0] || "").trim();

            // Find parent row to check for other invoices across parent + child rows
            let parentRi = ri;
            if (!String(r[32] || "").trim() && !String(r[0] || "").trim()) {
              for (let pi = ri - 1; pi >= 1; pi--) {
                const pr = invConfirmedRows[pi] || [];
                if (String(pr[32] || "").trim() || String(pr[0] || "").trim()) { parentRi = pi; break; }
              }
            }

            let otherRealInvoicesCount = 0;
            const parentClient = String(invConfirmedRows[parentRi]?.[0] || "").trim().toLowerCase();
            const parentJob = String(invConfirmedRows[parentRi]?.[1] || "").trim().toLowerCase();
            for (let pi = parentRi; pi < invConfirmedRows.length; pi++) {
              const cr = invConfirmedRows[pi] || [];
              const crClient = String(cr[0] || "").trim().toLowerCase();
              const crJob = String(cr[1] || "").trim().toLowerCase();
              if (pi !== parentRi && (crClient || crJob) && (crClient !== parentClient || crJob !== parentJob)) break;
              if (pi !== parentRi && String(cr[32] || "").trim()) break;

              const crRefs = [
                { ref: String(cr[42] || "").trim(), rNum: pi + 1, sNum: 1 },
                { ref: String(cr[49] || "").trim(), rNum: pi + 1, sNum: 2 },
                { ref: String(cr[56] || "").trim(), rNum: pi + 1, sNum: 3 }
              ];
              for (const item of crRefs) {
                if (item.rNum === rowNum && item.sNum === slotNum) continue;
                if (isRealSlotRef(item.ref) && item.ref !== invoiceNo) otherRealInvoicesCount++;
              }
            }

            const parentSheetRow = parentRi + 1;
            const effectiveJobName = jobName || String(invConfirmedRows[parentRi]?.[1] || "").trim();
            const effectiveClientName = clientName || String(invConfirmedRows[parentRi]?.[0] || "").trim();

            matchedJobs.push({
              rowNum,
              parentRowNum: parentSheetRow,
              slotNum,
              jobName: effectiveJobName,
              clientName: effectiveClientName,
              isOnlyInvoiceOnJob: otherRealInvoicesCount === 0,
              slotCols: slotNum === 1
                ? { ref: `AQ${rowNum}`, amt: `AP${rowNum}`, sent: `AR${rowNum}`, days: `AS${rowNum}`, status: `AT${rowNum}` }
                : slotNum === 2
                  ? { ref: `AX${rowNum}`, amt: `AW${rowNum}`, sent: `AY${rowNum}`, days: `AZ${rowNum}`, status: `BA${rowNum}` }
                  : { ref: `BE${rowNum}`, amt: `BD${rowNum}`, sent: `BF${rowNum}`, days: `BG${rowNum}`, status: `BH${rowNum}` },
              slotAmt: slotNum === 1 ? String(r[41] || "0") : slotNum === 2 ? String(r[48] || "0") : String(r[55] || "0"),
            });
          }
        }

        const dupOptions = [];
        let optId = 1;

        // Check if Split Invoice: sum across spreadsheet jobs ≈ gross accounting amount
        const totalSheetGross = matchedJobs.reduce((sum, j) => sum + (parseFloat(String(j.slotAmt).replace(/[£$€,]/g, "")) || 0), 0);
        if (matchedJobs.length > 1 && Math.abs(totalSheetGross - grossAmount) < 0.1 && grossAmount > 0) {
          dupOptions.push({
            optionId: optId++,
            title: `Accept as split invoice across ${matchedJobs.length} jobs (£${totalSheetGross.toFixed(2)} total)`,
            matchType: "info",
            explanation: `The sum of invoice #${invoiceNo} across all ${matchedJobs.length} spreadsheet jobs (£${totalSheetGross.toFixed(2)}) matches the accounting total (£${grossAmount.toFixed(2)}). Accepting this marks the split as valid and resolved.`,
            actionButtonText: "Accept split invoice",
          });
        }

        // Options for each matched job
        for (const j of matchedJobs) {
          dupOptions.push({
            optionId: optId++,
            title: `Clear invoice #${invoiceNo} from "${j.jobName || 'Row ' + j.rowNum}" (Row ${j.rowNum})`,
            matchType: "existing_job",
            jobRow: j.rowNum,
            jobName: j.jobName,
            explanation: `Removes invoice #${invoiceNo} and its amount from slot ${j.slotNum} on "${j.jobName}". Use this if this invoice was assigned to this job in error.`,
            actionButtonText: `Clear invoice from "${j.jobName || 'Row ' + j.rowNum}"`,
            recommendedActions: [
              `write "" to ${j.slotCols.ref}`,
              `write "" to ${j.slotCols.amt}`,
              `write "" to ${j.slotCols.sent}`,
              `write "" to ${j.slotCols.days}`,
              `write "" to ${j.slotCols.status}`,
            ],
          });

          if (j.isOnlyInvoiceOnJob) {
            dupOptions.push({
              optionId: optId++,
              title: `Delete entire job "${j.jobName || 'Row ' + j.parentRowNum}" (Row ${j.parentRowNum})`,
              matchType: "delete",
              jobRow: j.parentRowNum,
              jobName: j.jobName,
              clientName: j.clientName,
              matchingDetails: { unmatchedJobSummary: { clientName: j.clientName, jobName: j.jobName } },
              explanation: `Invoice #${invoiceNo} is the ONLY invoice attached to "${j.jobName}". If this entire job was created by mistake or as an accidental duplicate, deleting it will completely remove the job from the Confirmed tab.`,
              actionButtonText: `Delete job "${j.jobName || 'Row ' + j.parentRowNum}"`,
            });
          }
        }

        // Always include Option: Ignore discrepancy
        dupOptions.push({
          optionId: optId++,
          title: "Ignore discrepancy (keep Pulse invoices as is)",
          matchType: "ignore",
          actionButtonText: "Ignore discrepancy",
          jobRow: matchedJobs[0]?.rowNum || alert.rowNumber,
          jobName: matchedJobs[0]?.jobName || alert.summary?.job || "",
          explanation: "Mark this duplicate invoice alert as ignored. Both entries will remain in Pulse and no changes will be made to either system.",
          recommendedActions: [
            "Mark this discrepancy as ignored - no changes will be made to either system",
          ],
        });

        const dupSummary = alert.summary?.summary || `Invoice ${invoiceNo} (Duplicate in sheet)`;
        if (memoryRow) {
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
            ...memoryRow, cachedOptionsJSON: JSON.stringify(dupOptions),
          });
        } else {
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
            fingerprintHash, alertType: "invoice", clientName: alert.clientName || "",
            alertSummary: dupSummary, cachedOptionsJSON: JSON.stringify(dupOptions), status: "cached",
          });
        }
        return res.status(200).json({ success: true, options: dupOptions, alertId: alert.rowNumber, previousIgnoreReason });
      }

      // ── Branch 2: Single job search for data mismatches (Amount, VAT, Dates, Status, Client) ──
      let matchedJob = null;
      let matchedSlot = null;
      let matchedRowNum = null; // 1-indexed sheet row

      for (let ri = 1; ri < invConfirmedRows.length; ri++) {
        const r = invConfirmedRows[ri] || [];
        const ref1 = String(r[42] || "").trim(); // AQ = Inv1 ref
        const ref2 = String(r[49] || "").trim(); // AX = Inv2 ref
        const ref3 = String(r[56] || "").trim(); // BE = Inv3 ref
        if (ref1 === invoiceNo) { matchedJob = r; matchedSlot = 1; matchedRowNum = ri + 1; break; }
        if (ref2 === invoiceNo) { matchedJob = r; matchedSlot = 2; matchedRowNum = ri + 1; break; }
        if (ref3 === invoiceNo) { matchedJob = r; matchedSlot = 3; matchedRowNum = ri + 1; break; }
      }

      // If not found by invoice number match in AQ/AX/BE, try finding via alert.spreadsheetItems
      if (!matchedJob && alert.spreadsheetItems && alert.spreadsheetItems.length > 0) {
        const firstItem = alert.spreadsheetItems[0];
        const cellRef = String(firstItem.cellRef || "").trim().toUpperCase();
        const m = cellRef.match(/^([A-Z]+)(\d+)$/);
        if (m) {
          const colLetter = m[1];
          const rNum = parseInt(m[2], 10);
          if (rNum > 0 && rNum <= invConfirmedRows.length) {
            matchedRowNum = rNum;
            matchedJob = invConfirmedRows[rNum - 1];
            if (colLetter === "AP" || colLetter === "AQ") matchedSlot = 1;
            else if (colLetter === "AW" || colLetter === "AX") matchedSlot = 2;
            else if (colLetter === "BD" || colLetter === "BE") matchedSlot = 3;
            else matchedSlot = 1;
          }
        }
      }

      if (matchedJob) {
        const parseAmt = (v) => parseFloat(String(v || "0").replace(/[£$€,\s]/g, "")) || 0;
        const jobClient = String(matchedJob[0] || "").trim();  // A
        const jobName = String(matchedJob[1] || "").trim();  // B
        const jobCode = String(matchedJob[2] || "").trim();  // C
        const jobRevenue = String(matchedJob[32] || "").trim();  // AG
        const jobVAT = String(matchedJob[34] || "").trim();  // AI - "Yes" or "No"
        const jobType = String(matchedJob[35] || "").trim();  // AJ - Project / Retainer
        const jobStart = String(matchedJob[37] || "").trim();  // AL
        const jobEnd = String(matchedJob[38] || "").trim();  // AM
        const jobVATYes = jobVAT.toLowerCase() === "yes";

        // Slot columns
        const slotCols = matchedSlot === 1
          ? { amt: "AP", ref: "AQ", sent: "AR", days: "AS", status: "AT" }
          : matchedSlot === 2
            ? { amt: "AW", ref: "AX", sent: "AY", days: "AZ", status: "BA" }
            : { amt: "BD", ref: "BE", sent: "BF", days: "BG", status: "BH" };

        const curSlotAmt = parseAmt(matchedSlot === 1 ? matchedJob[41] : matchedSlot === 2 ? matchedJob[48] : matchedJob[55]);
        const curSlotSent = String(matchedSlot === 1 ? matchedJob[43] : matchedSlot === 2 ? matchedJob[50] : matchedJob[57] || "").trim();
        const curSlotDays = String(matchedSlot === 1 ? matchedJob[44] : matchedSlot === 2 ? matchedJob[51] : matchedJob[58] || "").trim();
        const curSlotStatus = String(matchedSlot === 1 ? matchedJob[45] : matchedSlot === 2 ? matchedJob[52] : matchedJob[59] || "").trim();

        const correctAmount = totalExclVAT > 0 ? totalExclVAT : grossAmount;

        const writeActions = [];
        const mismatchNames = [];
        const explanationParts = [];

        // 1. VAT Mismatch scenario check
        const epsilon = 0.01;
        // Scenario A: Invoice sent WITH VAT, job marked NO VAT
        const isVatScenarioA = vatIncluded > 0 && !jobVATYes && Math.abs(totalExclVAT - dashboardTotal) < epsilon;
        // Scenario B: Invoice sent WITHOUT VAT, job marked YES VAT
        const isVatScenarioB = vatIncluded === 0 && jobVATYes && Math.abs(grossAmount * 1.2 - dashboardTotal) < epsilon;

        if (isVatScenarioA) {
          mismatchNames.push("VAT setting");
          explanationParts.push(`VAT setting: "Yes" (invoice sent with £${vatIncluded.toFixed(2)} VAT)`);
          // Update AI on all job rows
          const allJobRows = [{ row: matchedJob, rowNum: matchedRowNum }];
          const jcLower = jobClient.toLowerCase();
          const jnLower = jobName.toLowerCase();
          for (let ri = matchedRowNum; ri < invConfirmedRows.length; ri++) {
            const r = invConfirmedRows[ri] || [];
            const rClient = String(r[0] || "").trim().toLowerCase();
            const rJob = String(r[1] || "").trim().toLowerCase();
            if (!rClient && !rJob) break;
            if (rClient !== jcLower || rJob !== jnLower) break;
            if (String(r[32] || "").trim()) break;
            allJobRows.push({ row: r, rowNum: ri + 1 });
          }
          for (const { rowNum } of allJobRows) {
            writeActions.push(`write Yes to AI${rowNum}`);
          }
        } else if (isVatScenarioB) {
          mismatchNames.push("VAT setting");
          explanationParts.push(`VAT setting: "No" (invoice sent without VAT)`);
          const allJobRows = [{ row: matchedJob, rowNum: matchedRowNum }];
          const jcLower = jobClient.toLowerCase();
          const jnLower = jobName.toLowerCase();
          for (let ri = matchedRowNum; ri < invConfirmedRows.length; ri++) {
            const r = invConfirmedRows[ri] || [];
            const rClient = String(r[0] || "").trim().toLowerCase();
            const rJob = String(r[1] || "").trim().toLowerCase();
            if (!rClient && !rJob) break;
            if (rClient !== jcLower || rJob !== jnLower) break;
            if (String(r[32] || "").trim()) break;
            allJobRows.push({ row: r, rowNum: ri + 1 });
          }
          for (const { rowNum } of allJobRows) {
            writeActions.push(`write No to AI${rowNum}`);
          }
        }

        // 2. Amount mismatch check
        if (isInvAmtMismatch || Math.abs(curSlotAmt - correctAmount) >= 0.01) {
          if (Math.abs(curSlotAmt - correctAmount) >= 0.01) {
            mismatchNames.push("amount");
            explanationParts.push(`Amount: £${correctAmount.toFixed(2)} (excl VAT)`);
            writeActions.push(`write ${correctAmount.toFixed(2)} to ${slotCols.amt}${matchedRowNum}`);
          } else if (!isVatScenarioA && !isVatScenarioB) {
            explanationParts.push(`Amount: £${curSlotAmt.toFixed(2)} excl VAT matches accounting`);
          }
        }

        // 3. Sent date mismatch
        if ((isSentDateMismatch || (invSentDate && curSlotSent !== invSentDate)) && invSentDate) {
          mismatchNames.push("sent date");
          explanationParts.push(`Sent date: "${invSentDate}"`);
          writeActions.push(`write ${invSentDate} to ${slotCols.sent}${matchedRowNum}`);
        }

        // 4. Status mismatch
        if ((isStatusMismatch || (invStatus && curSlotStatus.toLowerCase() !== invStatus.toLowerCase())) && invStatus) {
          mismatchNames.push("status");
          explanationParts.push(`Status: "${invStatus}"`);
          writeActions.push(`write ${invStatus} to ${slotCols.status}${matchedRowNum}`);
        }

        // 5. Pay date mismatch
        const invPayDate = String(invAccounting[8] || "").trim();
        if ((isPayDateMismatch || (invPayDate && curSlotDays !== invPayDate)) && invPayDate) {
          mismatchNames.push("pay date");
          explanationParts.push(`Pay date: "${invPayDate}"`);
          writeActions.push(`write ${invPayDate} to ${slotCols.days}${matchedRowNum}`);
        }

        // 6. Client mismatch
        if ((isClientMismatch || (invClient && jobClient.toLowerCase() !== invClient.toLowerCase())) && invClient) {
          mismatchNames.push("client");
          explanationParts.push(`Client: "${invClient}"`);
          writeActions.push(`write "${invClient}" to A${matchedRowNum}`);
        }

        // Fallback if no specific fields identified but it's a data mismatch
        if (mismatchNames.length === 0) {
          mismatchNames.push("invoice details");
          if (correctAmount > 0) {
            explanationParts.push(`Amount: £${correctAmount.toFixed(2)}`);
            writeActions.push(`write ${correctAmount.toFixed(2)} to ${slotCols.amt}${matchedRowNum}`);
          }
          if (invSentDate) {
            explanationParts.push(`Sent date: "${invSentDate}"`);
            writeActions.push(`write ${invSentDate} to ${slotCols.sent}${matchedRowNum}`);
          }
          if (invStatus) {
            explanationParts.push(`Status: "${invStatus}"`);
            writeActions.push(`write ${invStatus} to ${slotCols.status}${matchedRowNum}`);
          }
        }

        const options = [
          {
            optionId: 1,
            title: `Update ${mismatchNames.join(", ")} in Pulse for invoice #${invoiceNo} on "${jobName}" (Row ${matchedRowNum})`,
            actionButtonText: "Update Pulse",
            matchType: "existing_job",
            jobRow: matchedRowNum,
            jobName,
            explanation: `Accounting system shows: ${explanationParts.join("; ")}. Updating Pulse to match.`,
            matchingDetails: {
              unmatchedJobSummary: {
                clientName: jobClient || invClient,
                jobName,
                revenue: jobRevenue,
                startDate: jobStart,
              },
            },
            matchAnalysis: {
              matchConfidence: "High",
              reasonForChoice: `Discrepancy: ${activeInvFlags.join(", ") || mismatchNames.join(", ")}. Accounting shows: ${explanationParts.join("; ")}. Updating Confirmed tab slot ${matchedSlot} (Row ${matchedRowNum}) to match.`,
              discrepancies: activeInvFlags.join(", ") || mismatchNames.join(", "),
            },
            recommendedActions: [
              `Update ${mismatchNames.join(", ")} for invoice #${invoiceNo} on "${jobName}" in Confirmed tab: ${explanationParts.join(", ")}`,
              ...writeActions,
            ],
          },
          {
            optionId: 2,
            title: "Ignore discrepancy (keep Pulse value)",
            actionButtonText: "Ignore discrepancy",
            matchType: "ignore",
            jobRow: matchedRowNum,
            jobName,
            explanation: "Mark this discrepancy as ignored. No changes will be made to either Pulse or the accounting system.",
            recommendedActions: [
              "Mark this discrepancy as ignored - no changes will be made to either system",
            ],
          },
        ];

        const mismatchSummary = alert.summary?.summary || `Invoice ${invoiceNo} (£${grossAmount.toFixed(2)})`;
        if (memoryRow) {
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
            ...memoryRow, cachedOptionsJSON: JSON.stringify(options),
          });
        } else {
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
            fingerprintHash, alertType: "invoice", clientName: alert.clientName || "",
            alertSummary: mismatchSummary, cachedOptionsJSON: JSON.stringify(options), status: "cached",
          });
        }
        return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
      }

      // ── Branch 3: Fallback when invoice row not found in Confirmed tab ──
      console.log(`  📊 Invoice #${invoiceNo} data mismatch without direct single-job resolution: ${activeInvFlags.join(", ")}`);
      const fallbackOptions = [
        {
          optionId: 1,
          title: `Update ${activeInvFlags.join(", ") || "invoice details"} in Pulse for invoice #${invoiceNo} (${invClient}${invJob ? " - " + invJob : ""})`,
          actionButtonText: "Update Pulse",
          matchType: "existing_job",
          jobRow: alert.rowNumber,
          jobName: invJob || invoiceNo,
          explanation: `Accounting system shows: Amount £${grossAmount.toFixed(2)}${vatIncluded > 0 ? ` (incl. £${vatIncluded.toFixed(2)} VAT)` : ""}, Sent: ${invSentDate || "(blank)"}, Status: ${invStatus || "(blank)"}. Updating Pulse to match.`,
          matchingDetails: {
            unmatchedJobSummary: {
              clientName: invClient,
              jobName: invJob || invoiceNo,
              revenue: String(grossAmount),
              startDate: invSentDate,
            },
          },
          matchAnalysis: {
            matchConfidence: "Medium",
            reasonForChoice: `Discrepancy: ${activeInvFlags.join(", ") || "Data mismatch"}. Accounting system shows Amount: £${grossAmount.toFixed(2)}, Sent: ${invSentDate}. Updating Pulse to match.`,
            discrepancies: activeInvFlags.join(", ") || "Data mismatch",
          },
          recommendedActions: [
            `Update invoice #${invoiceNo} in Pulse to match accounting: Amount £${grossAmount.toFixed(2)}, Sent ${invSentDate || "(blank)"}, Status ${invStatus || "(blank)"}`,
          ],
        },
        {
          optionId: 2,
          title: "Ignore discrepancy (keep Pulse value)",
          actionButtonText: "Ignore discrepancy",
          matchType: "ignore",
          jobRow: alert.rowNumber,
          jobName: invJob || invoiceNo,
          explanation: "Mark this discrepancy as ignored. No changes will be made to either Pulse or the accounting system.",
          recommendedActions: [
            "Mark this discrepancy as ignored - no changes will be made to either system",
          ],
        },
      ];

      const fallbackSummary = alert.summary?.summary || `Invoice ${invoiceNo} (£${grossAmount.toFixed(2)})`;
      if (memoryRow) {
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
          ...memoryRow, cachedOptionsJSON: JSON.stringify(fallbackOptions),
        });
      } else {
        await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
          fingerprintHash, alertType: "invoice", clientName: alert.clientName || "",
          alertSummary: fallbackSummary, cachedOptionsJSON: JSON.stringify(fallbackOptions), status: "cached",
        });
      }
      return res.status(200).json({ success: true, options: fallbackOptions, alertId: alert.rowNumber, previousIgnoreReason });
    }

    // ── Missing invoice - existing Claude path ─────────────────────────
    console.log(`  Fetching Confirmed tab from CLIENT sheet ${alert.clientId.substring(0, 16)}...`);

    let confirmedData = [];
    if (sharedData && sharedData.confirmedDataWide) {
      confirmedData = sharedData.confirmedDataWide;
      console.log(`  ✓ Used cached Confirmed data (${confirmedData.length} rows)`);
    } else {
      const confirmedResponse = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: alert.clientId,
        range: "Confirmed!A1:CR5000",
      }));
      confirmedData = confirmedResponse.data.values || [];
    }

    console.log(`  📊 Loaded ${confirmedData.length} rows of job data`);

    // Find last non-blank row
    let lastDataRow = 1;
    for (let row = confirmedData.length - 1; row > 0; row--) {
      const rowData = confirmedData[row] || [];
      // A:G (0-6), AG:AM (32-38), AP:BH (41-59), BX:CR (75-94)
      const colsToCheck = [
        0, 1, 2, 3, 4, 5, 6,
        32, 33, 34, 35, 36, 37, 38,
        41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
        75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94
      ];
      const hasData = colsToCheck.some(col => rowData[col]);

      if (hasData) {
        lastDataRow = row;
        break;
      }
    }

    const activeData = confirmedData.slice(0, lastDataRow + 1);
    console.log(`  📊 Using ${activeData.length} non-blank rows for Claude analysis`);

    // Fetch tolerances here - needed by both the pre-check and the prompt builder below
    const tolerances = await getToleranceValues(sheets, alert.masterSheetId || alert.clientId);

    // Extract invoice details - declared here so they're available to both the
    // pre-check block and the prompt builder below (avoids temporal dead zone in prod build)
    const invoiceAmount = parseFloat(alert.summary?.amount) || 0;
    const invoiceRef = alert.summary?.invoiceNo || '(unmatched)';
    const invoiceClient = alert.summary?.client || '';
    const invoiceJob = alert.summary?.job || '';
    const sentDate = alert.summary?.sentDate || '';
    const invoiceStatus = alert.summary?.status || '';
    // invoiceAmtForMatch declared here (uses totalExclVAT from Confirmed pre-check
    // if available, else falls back to invoiceAmount) so Tier 1/Tier 2 can access it
    // regardless of whether isMissingInvoice's block executes.
    let invoiceAmtForMatch = invoiceAmount;
    const datePaid = alert.summary?.datePaid || '';

    // Date tolerance: ±invoiceMonthsTolerance months from invoice sent date.
    // Same reasoning as invoiceAmtForMatch above - moved here 20 Aug 2026 from
    // inside the isMissingInvoice block below, which Tier 1/2 (further down,
    // a SIBLING scope, not a child of that block) also needs this for. The
    // original placement meant every accept-option call touching the
    // "name match" Tier 2 path threw a ReferenceError at runtime (confirmed via
    // Babel's own scope resolution during a full-codebase sweep, not just an
    // ESLint guess) - a plain syntax check can't catch an undefined-reference
    // error since it's runtime-only, so this had been silently broken since it
    // was first added.
    const invMonthsTol = Number(tolerances.invoiceMonthsTolerance) || 2;
    const invSentDateParsed = parseSheetOrJsDate_(sentDate);
    const dateWithinTolerance = (slotDateStr) => {
      if (!invSentDateParsed || !slotDateStr) return null; // null = unknown (no date to compare)
      const slotDate = parseSheetOrJsDate_(slotDateStr);
      if (!slotDate) return null;
      return monthsWithinTolerance_(invSentDateParsed, slotDate, invMonthsTol);
    };

    // Days to pay: if Paid, calculate from sentDate → datePaid; otherwise use DataChgAlert!B52
    let daysToPayValue = tolerances.defaultDaysToPay;
    if (invoiceStatus.toLowerCase() === 'paid' && sentDate && datePaid) {
      try {
        const parseDate = (d) => {
          const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
          const parts = d.split(/[-\/]/);
          if (parts.length === 3) {
            const monthNum = months[parts[1]?.toLowerCase()?.substring(0, 3)];
            if (monthNum !== undefined) {
              const year = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
              return new Date(year, monthNum, parseInt(parts[0]));
            }
            if (parts[0].length === 4) return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
          }
          return new Date(d);
        };
        const sent = parseDate(sentDate);
        const paid = parseDate(datePaid);
        const diffDays = Math.round((paid - sent) / (1000 * 60 * 60 * 24));
        if (diffDays > 0) daysToPayValue = diffDays;
      } catch (e) {
        console.log(`  ⚠️ Could not calculate days to pay from dates: ${e.message}`);
      }
    }

    // ── Pre-check: fuzzy client matching + amount/date slot sweep ─────────
    // Two independent matching signals are computed before sending to Claude:
    //
    // Signal A - Fuzzy client name match: checks whether any Confirmed tab client
    //   name is plausibly the same entity as the invoice client name, using:
    //   - noise-word stripping (ltd, limited, plc, inc, llc, the, and, &, group, co)
    //   - normalisation (punctuation, whitespace, case)
    //   - word-overlap: any single meaningful word shared between names
    //   - abbreviation detection: initials of one name spell the other
    //
    // Signal B - Amount + date sweep of non-real slots (blank ref OR MANUAL-INV):
    //   - Amount tolerance: 5p domestic, 10% foreign (mirrors GAS automation)
    //   - Date tolerance: ±invoiceMonthsTolerance months
    //   - Only considers slots with no real invoice reference (available placeholders)
    //
    // Outcomes:
    //   - Signal A found, Signal B found → Claude receives full table + slot match candidates
    //   - Signal A found only           → Claude receives full table (existing flow)
    //   - Signal A NOT found, Signal B found → Claude receives slot match candidates only
    //   - Neither found                 → hardcoded create_new (no Claude call)

    // Fetch primary currency from client KeyInfo!B17 to determine tolerance type
    let primaryCurrency = "GBP";
    try {
      const keyInfoResp = await sheets.spreadsheets.values.get({
        spreadsheetId: alert.clientId,
        range: "KeyInfo!B17",
      });
      primaryCurrency = String(keyInfoResp.data.values?.[0]?.[0] || "GBP").trim().toUpperCase();
    } catch (e) {
      console.log(`  ⚠️ Could not read KeyInfo!B17 - defaulting to GBP`);
    }

    const invoiceCurrency = String(alert.summary?.currency || "GBP").trim().toUpperCase();
    const isForeignCurrency = invoiceCurrency && invoiceCurrency !== primaryCurrency;
    console.log(`  Currency: invoice=${invoiceCurrency}, primary=${primaryCurrency}, foreign=${isForeignCurrency}`);

    // Amount tolerance: 5p domestic, 10% of invoice amount for foreign
    invoiceAmtForMatch = totalExclVAT > 0 ? totalExclVAT : invoiceAmount;
    const amtToleranceFn = (slotAmt) => {
      if (isForeignCurrency) {
        return Math.abs(slotAmt - invoiceAmtForMatch) <= invoiceAmtForMatch * 0.10;
      }
      // Domestic: 5p tolerance (compare in pennies to avoid float errors)
      return Math.abs(Math.round(slotAmt * 100) - Math.round(invoiceAmtForMatch * 100)) <= 5;
    };

    // Slot column definitions
    const INV_SLOT_DEFS = [
      { amtIdx: 41, refIdx: 42, sentIdx: 43, slotNum: 1, amtCol: "AP", refCol: "AQ", sentCol: "AR", daysCol: "AS", statusCol: "AT" },
      { amtIdx: 48, refIdx: 49, sentIdx: 50, slotNum: 2, amtCol: "AW", refCol: "AX", sentCol: "AY", daysCol: "AZ", statusCol: "BA" },
      { amtIdx: 55, refIdx: 56, sentIdx: 57, slotNum: 3, amtCol: "BD", refCol: "BE", sentCol: "BF", daysCol: "BG", statusCol: "BH" },
    ];

    // slotMatches and candidateJobs declared here so Tier 1 and Tier 2 can access them regardless of isMissingInvoice
    let slotMatches = [];
    let clientFound = false;
    let candidateJobs = [];

    if (isMissingInvoice) {

      const alertClientStr = alert.summary?.client || invoiceClient;
      clientFound = alertClientStr && activeData.some(row =>
        fuzzyClientMatch_(alertClientStr, String(row[0] || ""))
      );
      console.log(`  Fuzzy client match for "${alertClientStr}": ${clientFound}`);

      // Group activeData into candidate jobs with parent + child rows
      // Universal Gate: Exclude any job whose revenue is fully invoiced by real invoices
      let cji = 1;
      while (cji < activeData.length) {
        const row = activeData[cji] || [];
        const client = String(row[0] || "").trim();
        const jobName = String(row[1] || "").trim();
        const code = String(row[2] || "").trim();
        const revRaw = String(row[32] || "").trim();
        const directCostsRaw = String(row[33] || "").trim();
        const vatYesNo = String(row[34] || "").trim();
        const projType = String(row[35] || "").trim();
        const startDate = String(row[37] || "").trim();
        const endDate = String(row[38] || "").trim();

        if (!client && !jobName) {
          cji++;
          continue;
        }

        const parentIdx = cji;
        const isRetainer = projType.toLowerCase().includes("retainer");
        const jobRows = [{ row, sheetRow: cji + 1, isParent: true }];

        let cjNext = cji + 1;
        while (cjNext < activeData.length) {
          const nextRow = activeData[cjNext] || [];
          const nc = String(nextRow[0] || "").trim();
          const nj = String(nextRow[1] || "").trim();
          const nRev = String(nextRow[32] || "").trim();
          const nCode = String(nextRow[2] || "").trim();
          const nStart = String(nextRow[37] || "").trim();
          const nType = String(nextRow[35] || "").trim();

          const isExplicitChild = (nc.toLowerCase() === client.toLowerCase() && nj.toLowerCase() === jobName.toLowerCase()) && !nRev && !nCode && !nStart && !nType;
          const isInheritedChild = (!nc && !nj) && nextRow.some(cell => String(cell || "").trim() !== "");
          if (isExplicitChild || isInheritedChild) {
            jobRows.push({ row: nextRow, sheetRow: cjNext + 1, isParent: false });
            cjNext++;
          } else {
            break;
          }
        }
        cji = cjNext;

        let totalRealInvoiced = 0;
        let totalPlaceholderAmts = 0;
        const slots = [];
        const nonRealSlots = [];

        for (const { row: jr, sheetRow: rNum } of jobRows) {
          for (const sd of INV_SLOT_DEFS) {
            const ref = String(jr[sd.refIdx] || "").trim();
            const rawAmt = jr[sd.amtIdx];
            const slotDate = String(jr[sd.sentIdx] || "").trim();
            const amt = (rawAmt !== undefined && rawAmt !== "") ? (parseFloat(String(rawAmt).replace(/[£$€,\s]/g, "")) || 0) : 0;
            const isManual = isPlaceholderInvoice(ref);
            const isReal = !!(ref && !isManual);
            const isEmpty = !ref && amt === 0;

            if (isReal) {
              totalRealInvoiced += amt;
            } else {
              totalPlaceholderAmts += amt;
            }

            const slotObj = {
              sheetRow: rNum,
              slotNum: sd.slotNum,
              amtCol: sd.amtCol,
              refCol: sd.refCol,
              sentCol: sd.sentCol,
              daysCol: sd.daysCol,
              statusCol: sd.statusCol,
              rawAmt,
              amt,
              ref,
              slotDate,
              isManual,
              isReal,
              isEmpty,
            };
            slots.push(slotObj);
            if (!isReal) {
              nonRealSlots.push(slotObj);
            }
          }
        }

        const revParsed = parseFloat(revRaw.replace(/[£$€,\s]/g, "")) || 0;
        let jobRevenue = revParsed;
        if (isRetainer) {
          let contractMonths = jobRows.length;
          if (startDate && endDate) {
            const sDate = parseSheetOrJsDate_(startDate);
            const eDate = parseSheetOrJsDate_(endDate);
            if (sDate && eDate && eDate > sDate) {
              contractMonths = Math.max(1, Math.round((eDate.getTime() - sDate.getTime()) / (30.4375 * 24 * 60 * 60 * 1000)));
            }
          }
          jobRevenue = revParsed > 0 ? revParsed * contractMonths : 0;
        }
        if (jobRevenue === 0 && (totalRealInvoiced + totalPlaceholderAmts) > 0) {
          jobRevenue = totalRealInvoiced + totalPlaceholderAmts;
        }

        const uninvoicedRevenue = jobRevenue - totalRealInvoiced;

        // Universal gate: exclude any job that does not have uninvoiced revenue (real invoices fully cover revenue)
        if (uninvoicedRevenue <= 0.01) {
          continue;
        }

        // Must have at least one non-real slot available
        if (nonRealSlots.length === 0) {
          continue;
        }

        candidateJobs.push({
          parentRowNum: parentIdx + 1,
          client,
          jobName,
          projectCode: code,
          revenue: revRaw || String(jobRevenue),
          revenueNum: jobRevenue,
          totalRealInvoiced,
          uninvoicedRevenue,
          directCosts: directCostsRaw,
          vatYesNo,
          projectRetainer: projType,
          startDate,
          endDate,
          isRetainer,
          jobRows,
          slots,
          nonRealSlots,
          firstAvailSlot: nonRealSlots[0],
        });
      }

      console.log(`  ✓ Found ${candidateJobs.length} candidate job(s) with uninvoiced revenue > £0`);

      // Sweep amount-matched slots across candidateJobs (respects universal gate)
      for (const job of candidateJobs) {
        for (const slot of job.nonRealSlots) {
          if (slot.amt === 0) continue;
          const amtMatch = amtToleranceFn(slot.amt);
          if (!amtMatch) continue;
          const dateOk = dateWithinTolerance(slot.slotDate);
          slotMatches.push({
            rowNum: slot.sheetRow,
            parentRowNum: job.parentRowNum,
            client: job.client,
            jobName: job.jobName,
            projectCode: job.projectCode,
            revenue: job.revenue,
            directCosts: job.directCosts,
            projectRetainer: job.projectRetainer,
            startDate: job.startDate,
            endDate: job.endDate,
            slotNum: slot.slotNum,
            slotAmt: slot.amt,
            slotDate: slot.slotDate,
            amtMatch: true,
            dateMatch: dateOk,
            amtCol: slot.amtCol,
            refCol: slot.refCol,
            sentCol: slot.sentCol,
            daysCol: slot.daysCol,
            statusCol: slot.statusCol,
            isManual: slot.isManual,
          });
        }
      }

      // Check job-level MANUAL-INV total matches across candidateJobs
      for (const job of candidateJobs) {
        const manualSlots = job.nonRealSlots.filter(s => s.isManual && s.amt > 0);
        if (manualSlots.length > 1) {
          const totalManual = manualSlots.reduce((s, sl) => s + sl.amt, 0);
          if (amtToleranceFn(totalManual)) {
            const firstSlot = manualSlots[0];
            const alreadyMatched = slotMatches.some(m => m.rowNum === firstSlot.sheetRow && m.slotNum === firstSlot.slotNum);
            if (!alreadyMatched) {
              const dateOk = dateWithinTolerance(firstSlot.slotDate);
              slotMatches.push({
                rowNum: firstSlot.sheetRow,
                parentRowNum: job.parentRowNum,
                client: job.client,
                jobName: job.jobName,
                projectCode: job.projectCode,
                revenue: job.revenue,
                directCosts: job.directCosts,
                projectRetainer: job.projectRetainer,
                startDate: job.startDate,
                endDate: job.endDate,
                slotNum: firstSlot.slotNum,
                slotAmt: totalManual,
                slotDate: firstSlot.slotDate,
                amtMatch: true,
                dateMatch: dateOk,
                amtCol: firstSlot.amtCol,
                refCol: firstSlot.refCol,
                sentCol: firstSlot.sentCol,
                daysCol: firstSlot.daysCol,
                statusCol: firstSlot.statusCol,
                isManual: true,
                isJobTotalMatch: true,
                manualSlotsToClear: manualSlots.length,
              });
              console.log(`  Job-level MANUAL-INV total match: ${job.client} | ${job.jobName} - total £${totalManual} matches invoice £${invoiceAmtForMatch}`);
            }
          }
        }
      }

      const hasSlotMatches = slotMatches.length > 0;

      // ── Neither signal found → still send to Claude - it may find non-obvious matches
      // (e.g. different client name spelling, amount = fraction of job revenue, etc.)
      if (!clientFound && !hasSlotMatches) {
        console.log(`  No client match and no slot match - sending to Claude for non-obvious match detection`);
      }

      // ── Build slot match context block for Claude (if Signal B found) ──
      // Group matches by job (client + jobName) so Claude sees the COMPLETE picture
      // for each candidate job - all matching slots AND all other slots on the same job.
      // This prevents Claude treating parent and child rows as separate jobs.
      let slotMatchContext = "";
      if (hasSlotMatches) {
        // Group all slot matches by job key
        const jobGroups = new Map(); // key = "client||jobName"
        for (const m of slotMatches) {
          const key = `${m.client}||${m.jobName}`;
          if (!jobGroups.has(key)) {
            jobGroups.set(key, {
              client: m.client, jobName: m.jobName,
              projectCode: m.projectCode, revenue: m.revenue,
              matchingSlots: [], parentRow: null,
            });
          }
          jobGroups.get(key).matchingSlots.push(m);
        }

        // For each matched job, also collect ALL slots across ALL rows of that job
        // (parent + children) from activeData so Claude sees the full invoice picture
        const jobContextLines = [];
        for (const [key, group] of jobGroups) {
          const clientNorm = group.client.toLowerCase();
          const jobNorm = group.jobName.toLowerCase();

          // Find parent row (has revenue) and all child rows for this job
          const allJobRows = [];
          let parentRevenue = group.revenue;
          let parentStart = '', parentEnd = '', parentVAT = '', parentType = '';
          let parentRowNum = null;
          let lastCollectedRi = -1; // track last collected row index for contiguity check
          for (let ri = 1; ri < activeData.length; ri++) {
            const r = activeData[ri] || [];
            const rc = String(r[0] || "").trim().toLowerCase();
            const rj = String(r[1] || "").trim().toLowerCase();
            const directMatch = rc === clientNorm && rj === jobNorm;
            const hasAnyContent = r.some(cell => String(cell || "").trim() !== "");
            // Child row: blank client/job, has content, AND is contiguous with last collected row
            const childInherited = allJobRows.length > 0
              && !r[0] && !r[1]
              && hasAnyContent
              && ri === lastCollectedRi + 1; // must be immediately after last collected row
            if (!directMatch && !childInherited) {
              // If we've already found the parent and hit a non-matching, non-child row, stop
              if (parentRowNum !== null && !directMatch) break;
              continue;
            }
            const sheetRow = ri + 1; // activeData[0]=header=row1, ri=1→row2
            const hasRevenue = !!(String(r[32] || "").trim());
            if (directMatch && hasRevenue && parentRowNum === null) {
              parentRowNum = sheetRow;
              parentRevenue = String(r[32] || "").trim();
              parentStart = String(r[37] || "").trim();
              parentEnd = String(r[38] || "").trim();
              parentVAT = String(r[34] || "").trim();
              parentType = String(r[35] || "").trim();
            }
            allJobRows.push({ row: r, sheetRow, isParent: directMatch && hasRevenue });
            lastCollectedRi = ri;
          }

          // Build complete slot picture across all job rows
          const allSlotLines = [];
          for (const { row: r, sheetRow, isParent } of allJobRows) {
            const rowLabel = isParent ? "parent" : "child";
            const slotDefs = [
              { amtIdx: 41, refIdx: 42, sentIdx: 43, slotNum: 1 },
              { amtIdx: 48, refIdx: 49, sentIdx: 50, slotNum: 2 },
              { amtIdx: 55, refIdx: 56, sentIdx: 57, slotNum: 3 },
            ];
            for (const sd of slotDefs) {
              const ref = String(r[sd.refIdx] || "").trim();
              const rawAmt = r[sd.amtIdx];
              const slotDate = String(r[sd.sentIdx] || "").trim();
              const amt = rawAmt !== undefined && rawAmt !== "" ? parseFloat(String(rawAmt).replace(/[£$€,]/g, "")) || 0 : null;
              const isManual = isPlaceholderInvoice(ref);
              const isReal = ref && !isManual;
              const isEmpty = !ref && (amt === null || amt === 0);

              // Is this one of the backend-matched slots?
              const isMatched = group.matchingSlots.some(m => m.rowNum === sheetRow && m.slotNum === sd.slotNum);

              let slotDesc;
              if (isEmpty) {
                slotDesc = "(empty)";
              } else if (isReal) {
                slotDesc = `${ref} £${amt?.toFixed(2) || "?"} sent:${slotDate || "?"} [REAL - do not overwrite]`;
              } else if (isManual) {
                const manualAmtMatch = amt && Math.abs(amt - invoiceAmount) < 0.01;
                // Check if this is part of a job-total match (invoice covers full job revenue via multiple placeholder slots)
                const isJobTotalMatch = group.matchingSlots.some(m => m.isJobTotalMatch && m.rowNum === sheetRow && m.slotNum === sd.slotNum);
                const jobTotalNote = isJobTotalMatch ? ` ← INVOICE COVERS FULL JOB REVENUE - PLACE HERE AND CLEAR ALL OTHER PLACEHOLDER SLOTS` : (manualAmtMatch ? " ← AMOUNT MATCHES THIS INVOICE" : "");
                slotDesc = `${ref} £${amt?.toFixed(2) || "?"} sent:${slotDate || "?"} [placeholder${jobTotalNote}]`;
              } else {
                // Blank-ref placeholder - show explicit date comparison vs invoice sent date
                const dateResult = dateWithinTolerance(slotDate);
                let dateTag;
                if (!slotDate) {
                  dateTag = "no date recorded";
                } else if (invSentDateParsed && parseSheetOrJsDate_(slotDate)) {
                  const diffMonths = Math.abs((parseSheetOrJsDate_(slotDate) - invSentDateParsed) / (1000 * 60 * 60 * 24 * 30.4));
                  const direction = parseSheetOrJsDate_(slotDate) > invSentDateParsed ? "after" : "before";
                  if (diffMonths < 0.1) {
                    dateTag = `slot date ${slotDate} vs invoice ${sentDate} = EXACT MATCH`;
                  } else {
                    dateTag = `slot date ${slotDate} vs invoice ${sentDate} = ${diffMonths.toFixed(1)} months ${direction} invoice ${dateResult ? "✓ within tolerance" : "✗ outside tolerance"}`;
                  }
                } else {
                  dateTag = `slot date ${slotDate} (invoice sent: ${sentDate || "unknown"})`;
                }
                slotDesc = `[blank-ref placeholder] £${amt?.toFixed(2) || "?"} | ${dateTag}${isMatched ? " ← AMOUNT MATCHES THIS INVOICE" : ""}`;
              }
              allSlotLines.push(`    Row ${sheetRow} (${rowLabel}) Inv${sd.slotNum}: ${slotDesc}`);
            }
          }

          const matchCount = group.matchingSlots.length;
          const bestDateMatch = group.matchingSlots.some(m => m.dateMatch === true);
          const toleranceNote = isForeignCurrency
            ? `10% foreign currency tolerance`
            : `5p domestic tolerance`;

          jobContextLines.push(
            `JOB: ${group.client} | ${group.jobName}${group.projectCode ? ` (${group.projectCode})` : ""} | Revenue: ${parentRevenue}${parentType ? ` | Type: ${parentType}` : ""}${parentStart ? ` | ${parentStart}→${parentEnd}` : ""}
  Dashboard client name: "${group.client}" | Invoice client name: "${alertClientStr}"${group.client.toLowerCase() !== alertClientStr.toLowerCase() ? ` ← NAMES DIFFER - if you recommend this job, also write "${alertClientStr}" to col A of ALL rows for this job (rows: ${allJobRows.map(r => r.sheetRow).join(", ")})` : " ← names match"}
  ${matchCount} slot(s) with amount matching invoice £${invoiceAmtForMatch.toFixed(2)} (${toleranceNote}) - date ${bestDateMatch ? "✓ at least one slot within tolerance" : "✗ no slot within date tolerance"}
  ALL SLOTS FOR THIS JOB (${allJobRows.length} row${allJobRows.length > 1 ? "s" : ""} = ${allJobRows.length * 3} slots total - parent + child rows combined):
${allSlotLines.join("\n")}`
          );
        }

        const toleranceHeader = isForeignCurrency
          ? `(Foreign currency - ${invoiceCurrency} vs primary ${primaryCurrency} - amount tolerance 10%)`
          : `(Domestic currency - amount tolerance 5p, date tolerance ±${invMonthsTol} months)`;

        slotMatchContext = `
PLACEHOLDER SLOT MATCHES - PRE-COMPUTED BY BACKEND ${toleranceHeader}:
The backend found non-real invoice slots whose amounts match this invoice within tolerance.
CRITICAL: Parent and child rows below belong to the SAME JOB - treat them as a single unit with up to ${3 * (slotMatches[0] ? (jobGroups.get(`${slotMatches[0].client}||${slotMatches[0].jobName}`)?.matchingSlots?.length || 1) : 1)} slots total.
Invoice amount to place: £${invoiceAmtForMatch.toFixed(2)}, sent date: ${sentDate || "unknown"}

${jobContextLines.join("\n\n")}

INSTRUCTIONS FOR USING THESE MATCHES:
- Slots marked "← AMOUNT MATCHES THIS INVOICE" are the backend-confirmed candidates
- Slots marked "← INVOICE COVERS FULL JOB REVENUE - PLACE HERE AND CLEAR ALL OTHER PLACEHOLDER SLOTS" mean the invoice amount equals the total of all placeholders on this job. In this case: place the invoice in that slot (slot 1), write all 5 invoice fields to it, and clear ALL other placeholder slots on this job (write blank to all 5 fields of each remaining placeholder slot).
- A slot with both amount match AND date match (✓) is the most likely target
- A slot with amount match but date mismatch (✗) is still a valid option, with lower confidence - state the actual date difference
- NEVER describe a date-tolerance match as "exact" - state the actual difference in months
- The job's total revenue is split across ALL slots (parent + child rows combined)
- When recommending a slot, use the actual sheet row number shown (e.g. Row 263 or Row 264)
- CLIENT NAME MISMATCH: If the dashboard client name and invoice client name differ (marked "← NAMES DIFFER"), you MUST include writes of the invoice client name to column A of ALL rows for that job as part of recommendedActions - the accounting system name is authoritative`;
      }

      // Inject both signals into the prompt via a pre-analysis block that Claude receives
      // alongside (or instead of) the full confirmed tab table.
      // Store on a variable that the prompt builder below will pick up.
      // We set a flag so the prompt knows to include the slot match section.
      alert._preAnalysis = {
        clientFound,
        hasSlotMatches,
        slotMatchContext,
        isForeignCurrency,
        invoiceCurrency,
        primaryCurrency,
      };
    }

    // ── TIER 1: Single exact slot match - generate option without Claude ─
    // Conditions: exactly one slot match, amount exact (within 5p), date within
    // tolerance, not a job-total MANUAL-INV scenario (those need clearing logic).
    // Client name must match (clientFound). If any condition fails → Tier 2 (Claude).
    const tier1PreAnalysis = alert._preAnalysis || {};
    const tier1Eligible = (
      tier1PreAnalysis.hasSlotMatches &&
      tier1PreAnalysis.clientFound &&
      slotMatches.length === 1 &&
      slotMatches[0].dateMatch &&
      !slotMatches[0].isJobTotalMatch &&
      !tier1PreAnalysis.isForeignCurrency
    );

    if (tier1Eligible) {
      const m = slotMatches[0];
      const slotColLetter = m.amtCol; // e.g. "AP"
      const refColLetter = m.refCol;
      const sentColLetter = m.sentCol;
      const daysColLetter = m.daysCol;
      const statColLetter = m.statusCol;
      const rowNum = m.rowNum;
      const slotNum = m.slotNum;
      const isManual = m.isManual;
      const slotLabel = `${m.client} - ${m.jobName} (Row ${rowNum} Slot ${slotNum})`;
      const slotDesc = isManual ? "replacing placeholder" : "replacing the blank placeholder";
      console.log(`  ✅ Tier 1 match - generating option without Claude: ${slotLabel}`);

      const parentRow = m.parentRowNum || rowNum;
      const tier1Option = {
        optionId: 1,
        title: `Place in ${m.client} - ${m.jobName} - exact amount match, ${isManual ? "replacing placeholder" : "date match"}`,
        matchType: "existing_job",
        jobRow: parentRow,
        jobName: m.jobName,
        jobRevenue: m.revenue,
        targetRowNum: rowNum,
        targetSlotType: "invoice",
        targetSlotNum: slotNum,
        jobDetails: {
          clientName: m.client,
          jobName: m.jobName,
          projectCode: m.projectCode,
          revenue: m.revenue,
          directCosts: m.directCosts || "£0",
          projectRetainer: m.projectRetainer,
          startDate: m.startDate,
          endDate: m.endDate,
          rowNum: parentRow,
        },
        matchAnalysis: {
          matchConfidence: "High",
          reasonForChoice: `Amount exact match (£${invoiceAmtForMatch.toFixed(2)}). Client name match (${m.client}). Invoice sent ${sentDate} vs slot date ${m.slotDate} - within tolerance.`,
          discrepancies: "None",
        },
        recommendedActions: [
          `Place invoice ${invoiceRef} (£${invoiceAmtForMatch.toFixed(2)}) in invoice slot ${slotNum} of the ${m.client} ${m.jobName} ${isManual ? "project, " + slotDesc : "job"}`,
          [
            `write ${invoiceAmtForMatch.toFixed(2)} to ${slotColLetter}${rowNum} (invoice ${slotNum} amount)`,
            `write ${invoiceRef} to ${refColLetter}${rowNum} (invoice ${slotNum} reference)`,
            `write ${sentDate || ""} to ${sentColLetter}${rowNum} (invoice ${slotNum} sent date)`,
            `write ${daysToPayValue || 30} to ${daysColLetter}${rowNum} (invoice ${slotNum} days to pay)`,
            `write ${invoiceStatus || "Sent"} to ${statColLetter}${rowNum} (invoice ${slotNum} status)`,
          ].join(", "),
        ],
        slotBreakdown: { lines: [`Row ${rowNum} Slot ${slotNum}: ${invoiceRef} £${invoiceAmtForMatch.toFixed(2)} ← this invoice`], correctedTotal: `£${invoiceAmtForMatch.toFixed(2)}`, currentRevenue: `£${m.revenue || 0}` },
      };

      tier1Option.jobRowsData = await fetchJobRowsForDisplay(
        sheets, alert.clientId, "Confirmed", parentRow,
        { type: "invoice", rowNum, slotNum },
        sharedData
      );

      const tier1Summary = `Invoice ${invoiceRef} ${m.client} - ${m.jobName}`;
      await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
      const memRowsTier1 = await readAlertMemory(sheets, automationCommanderSheetId);
      const memRowTier1 = findMemoryRow(memRowsTier1, fingerprintHash);
      if (memRowTier1) {
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, memRowTier1.rowIndex, { ...memRowTier1, cachedOptionsJSON: JSON.stringify([tier1Option]) });
      } else {
        await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: "invoice", clientName: alert.clientName || "", alertSummary: tier1Summary, cachedOptionsJSON: JSON.stringify([tier1Option]), status: "cached" });
      }
      return res.status(200).json({ success: true, options: [tier1Option], alertId: alert.rowNumber, previousIgnoreReason });
    }

    // ── TIER 2: System-generated options (ambiguous, no match, or foreign currency) ─
    // If forceAI is set, send the full Confirmed tab to Claude as before.
    if (req.body.forceAI === true) {
      console.log("  🤖 forceAI=true - using Claude for invoice options");
      // Build compact confirmed tab summary for Claude
      const aiInvRows = activeData.slice(0, Math.min(activeData.length, 200)).map((row, ridx) => {
        const inv1 = `${row[42] || "(empty)"} £${row[41] || "?"} sent:${row[43] || "?"}`;
        const inv2 = `${row[49] || "(empty)"} £${row[48] || "?"} sent:${row[50] || "?"}`;
        const inv3 = `${row[56] || "(empty)"} £${row[55] || "?"} sent:${row[57] || "?"}`;
        return `Row ${ridx + 1} | ${row[0] || ""} | ${row[1] || ""} | Rev:${row[32] || ""} | Inv1:${inv1} | Inv2:${inv2} | Inv3:${inv3}`;
      }).join("\n");
      const aiInvPrompt = `You are a financial reconciliation assistant. Place this invoice into the correct slot in the Confirmed tab.
Invoice: #${invoiceNo}, Amount excl VAT: £${totalExclVAT}, Gross: £${grossAmount}, Sent: ${invSentDate}, Status: ${invStatus}
Client: ${invClient}, Job description: ${invJob}
${alert._preAnalysis?.slotMatchContext || "No pre-computed slot matches."}
Confirmed tab (first 200 rows):
${aiInvRows}
Return a JSON array of options. Each option: optionId, title, matchType (existing_job|info), jobRow, jobName, jobRevenue, matchAnalysis (matchConfidence, amountMatch, dateRangeMatch, reasonForChoice, discrepancies), recommendedActions (array of strings), slotBreakdown.`;
      const aiInvMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 4000, messages: [{ role: "user", content: aiInvPrompt }] });
      await logClaudeUsage_(sheets, automationCommanderSheetId, alert.clientName || "", "invoice", aiInvMsg.usage?.input_tokens || 0, aiInvMsg.usage?.output_tokens || 0).catch(() => { });
      let aiInvOptions = [];
      try {
        const rawInv = aiInvMsg.content[0].type === "text" ? aiInvMsg.content[0].text : "";
        const cleanInv = rawInv.replace(/```json/g, "").replace(/```/g, "").trim();
        const arrInv = cleanInv.slice(cleanInv.indexOf("["), cleanInv.lastIndexOf("]") + 1);
        aiInvOptions = JSON.parse(arrInv);
        if (!Array.isArray(aiInvOptions)) aiInvOptions = [aiInvOptions];
      } catch (e) { aiInvOptions = [{ optionId: 1, title: "AI response could not be parsed", matchType: "info", recommendedActions: [] }]; }
      const aiInvSummary = `Invoice ${invoiceRef} ${invClient} - ${invJob}`;
      if (memoryRow) { await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(aiInvOptions) }); }
      else { await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: "invoice", clientName: alert.clientName || "", alertSummary: aiInvSummary, cachedOptionsJSON: JSON.stringify(aiInvOptions), status: "cached" }); }
      return res.status(200).json({ success: true, options: aiInvOptions, alertId: alert.rowNumber, previousIgnoreReason });
    }
    // ── Tier 2 (System candidate ranking) ────────────────────────────────
    // Signals:
    // - Signal A: Client/job name fuzzy overlap, with amount-matched placeholder slots (or job-level total match)
    // - Signal B: Client name match for a job that has uninvoiced revenue (targeting the first available non-real slot)
    // - Signal C: Amount-matched placeholder slots (or job-level total match) without client/job name match
    // Priority order: Exact/partial client match -> Budget fit -> Date proximity -> Job recency
    // Limit: strictly top 2 options maximum

    // Noise-word stripping for job name matching
    const INV_NOISE = new Set(["ltd", "limited", "plc", "inc", "llc", "llp", "the", "and", "&",
      "group", "co", "corp", "corporation", "holdings", "international", "uk", "us",
      "solutions", "services", "consulting", "consultancy", "project", "projects"]);
    const normInvWords = s => String(s || "").toLowerCase()
      .replace(/['"\-.,()/#]/g, " ").replace(/\s+/g, " ").trim()
      .split(" ").filter(w => w.length > 1 && !INV_NOISE.has(w));

    const effectiveInvClient = alert.summary?.client || invoiceClient || invClient || "";
    const effectiveInvJob = alert.summary?.job || invoiceJob || invJob || "";

    const invJobWords = normInvWords(effectiveInvJob);
    const invClientWords = normInvWords(effectiveInvClient);

    const tier2Options = [];
    const seenJobKeys = new Set();

    for (const job of candidateJobs) {
      const jClientWords = normInvWords(job.client);
      const jJobWords = normInvWords(job.jobName);

      const isExactClient = !!(effectiveInvClient && job.client.toLowerCase() === effectiveInvClient.toLowerCase());
      const isPartialClient = !isExactClient && (
        fuzzyClientMatch_(effectiveInvClient, job.client) ||
        (invClientWords.length > 0 && invClientWords.some(w => jClientWords.includes(w)))
      );
      const hasClientMatch = isExactClient || isPartialClient;
      const isJobNameMatch = invJobWords.length > 0 && invJobWords.some(w => jJobWords.includes(w));
      const hasNameOverlap = hasClientMatch || isJobNameMatch;

      const clientRank = isExactClient ? 3 : (isPartialClient ? 2 : (isJobNameMatch ? 1 : 0));

      // Preference is ALWAYS given to the FIRST AVAILABLE non-real slot matching amount
      let matchingSlot = null;
      let isJobTotalMatch = false;

      for (const slot of job.nonRealSlots) {
        if (slot.amt > 0 && amtToleranceFn(slot.amt)) {
          matchingSlot = slot;
          break; // First available non-real slot matching amount
        }
      }

      if (!matchingSlot) {
        const manualSlots = job.nonRealSlots.filter(s => s.isManual && s.amt > 0);
        if (manualSlots.length > 1) {
          const totalManual = manualSlots.reduce((s, sl) => s + sl.amt, 0);
          if (amtToleranceFn(totalManual)) {
            matchingSlot = job.firstAvailSlot;
            isJobTotalMatch = true;
          }
        }
      }

      const isAmountMatch = !!matchingSlot;

      // Classify signal
      let signalType = null;
      let targetSlot = null;

      if (isAmountMatch && hasNameOverlap) {
        signalType = "Signal A";
        targetSlot = matchingSlot;
      } else if (!isAmountMatch && hasClientMatch) {
        signalType = "Signal B";
        targetSlot = job.firstAvailSlot; // First available non-real slot
      } else if (isAmountMatch && !hasNameOverlap) {
        signalType = "Signal C";
        targetSlot = matchingSlot;
      } else {
        // Disqualified: neither amount match nor client name match
        continue;
      }

      const jobKey = `${job.parentRowNum}-${job.client}-${job.jobName}`;
      if (seenJobKeys.has(jobKey)) continue;
      seenJobKeys.add(jobKey);

      // Budget fit check: new total <= job revenue
      const newTotal = job.totalRealInvoiced + invoiceAmtForMatch;
      const budgetFits = job.revenueNum === 0 || newTotal <= (job.revenueNum + 0.01);

      // Date proximity check
      const targetDate = targetSlot.slotDate;
      const dateMatch = dateWithinTolerance(targetDate);
      let dateDiffMs = null;
      if (invSentDateParsed && targetDate) {
        const parsedTargetDate = parseSheetOrJsDate_(targetDate);
        if (parsedTargetDate) {
          dateDiffMs = Math.abs(parsedTargetDate.getTime() - invSentDateParsed.getTime());
        }
      }

      const isManual = targetSlot.isManual;
      const slotDesc = isManual ? "replacing placeholder" : (targetSlot.isEmpty ? "empty slot" : "replacing blank placeholder");
      const dateNote = dateMatch === true
        ? `Invoice sent ${sentDate}, slot date ${targetDate} - within tolerance`
        : (targetDate ? `Invoice sent ${sentDate}, slot date ${targetDate} - outside date tolerance` : "No slot date recorded");

      let optTitle = "";
      let optExplanation = "";
      let confidence = "Medium";

      if (signalType === "Signal A") {
        confidence = dateMatch ? "High" : "Medium";
        if (isJobTotalMatch) {
          optTitle = `Place in ${job.client} - ${job.jobName} - covers full job revenue, replacing placeholders`;
          optExplanation = `Invoice amount (£${invoiceAmtForMatch.toFixed(2)}) matches total placeholder slots across job. Placing in slot ${targetSlot.slotNum} (Row ${targetSlot.sheetRow}) and clearing other placeholders.`;
        } else {
          optTitle = `Place in ${job.client} - ${job.jobName} - amount match, ${slotDesc}`;
          optExplanation = `Invoice amount £${invoiceAmtForMatch.toFixed(2)} matches slot £${targetSlot.amt.toFixed(2)}. ${dateNote}.`;
        }
      } else if (signalType === "Signal B") {
        confidence = dateMatch ? "Medium" : "Low";
        const amtDiffNote = targetSlot.amt > 0 ? `, slot is £${targetSlot.amt.toFixed(2)}` : "";
        optTitle = `Place in ${job.client} - ${job.jobName} - client match, ${targetSlot.isManual ? "placeholder" : "blank placeholder"}${amtDiffNote}`;
        optExplanation = `Client name matches invoice. Job has £${job.uninvoicedRevenue.toFixed(2)} uninvoiced revenue. Placing in first available slot ${targetSlot.slotNum} (Row ${targetSlot.sheetRow}).`;
      } else {
        // Signal C
        confidence = "Low";
        optTitle = `Place in ${job.client} - ${job.jobName} - amount match (unmatched client name), ${slotDesc}`;
        optExplanation = `Invoice amount £${invoiceAmtForMatch.toFixed(2)} matches slot £${targetSlot.amt.toFixed(2)}, but client name differs (${job.client} vs ${effectiveInvClient || "invoice client"}).`;
      }

      const slotLines = [`Row ${targetSlot.sheetRow} Slot ${targetSlot.slotNum}: ${invoiceRef} £${invoiceAmtForMatch.toFixed(2)} ← this invoice`];
      const revLine = job.revenueNum > 0
        ? `Revenue: £${job.revenueNum.toFixed(2)} | Invoiced to date (real): £${job.totalRealInvoiced.toFixed(2)} | New total: £${newTotal.toFixed(2)} | Remaining: £${(job.revenueNum - newTotal).toFixed(2)}`
        : `Revenue: unknown`;

      const recActions = [
        `Place invoice ${invoiceRef} (£${invoiceAmtForMatch.toFixed(2)}) in ${job.client} - ${job.jobName} slot ${targetSlot.slotNum} (Row ${targetSlot.sheetRow}), ${slotDesc}`,
        [
          `write ${invoiceAmtForMatch.toFixed(2)} to ${targetSlot.amtCol}${targetSlot.sheetRow}`,
          `write ${invoiceRef} to ${targetSlot.refCol}${targetSlot.sheetRow}`,
          `write ${sentDate || ""} to ${targetSlot.sentCol}${targetSlot.sheetRow}`,
          `write ${daysToPayValue || 30} to ${targetSlot.daysCol}${targetSlot.sheetRow}`,
          `write ${invoiceStatus || "Sent"} to ${targetSlot.statusCol}${targetSlot.sheetRow}`,
        ].join(", "),
      ];

      if (isJobTotalMatch) {
        for (const s of job.nonRealSlots) {
          if (s.sheetRow === targetSlot.sheetRow && s.slotNum === targetSlot.slotNum) continue;
          if (s.isManual || s.amt > 0) {
            recActions.push([
              `write "" to ${s.amtCol}${s.sheetRow}`,
              `write "" to ${s.refCol}${s.sheetRow}`,
              `write "" to ${s.sentCol}${s.sheetRow}`,
              `write "" to ${s.daysCol}${s.sheetRow}`,
              `write "" to ${s.statusCol}${s.sheetRow}`,
            ].join(", "));
          }
        }
      }

      tier2Options.push({
        optionId: tier2Options.length + 1,
        title: optTitle,
        actionButtonText: "Place invoice in job",
        matchType: "existing_job",
        jobRow: job.parentRowNum,
        jobName: job.jobName,
        jobRevenue: job.revenue,
        targetRowNum: targetSlot.sheetRow,
        targetSlotType: "invoice",
        targetSlotNum: targetSlot.slotNum,
        explanation: optExplanation,
        jobDetails: {
          clientName: job.client,
          jobName: job.jobName,
          projectCode: job.projectCode,
          revenue: job.revenue,
          directCosts: job.directCosts || "£0",
          projectRetainer: job.projectRetainer,
          startDate: job.startDate,
          endDate: job.endDate,
          rowNum: job.parentRowNum,
        },
        matchingDetails: {
          unmatchedJobSummary: {
            clientName: effectiveInvClient,
            jobName: job.jobName,
            projectCode: "",
            revenue: String(job.revenue || ""),
            startDate: job.startDate || "",
            endDate: "",
            likelihood: "",
          },
          matchedJobDetails: {
            clientName: job.client,
            jobName: job.jobName,
            projectCode: job.projectCode,
            revenue: job.revenue,
            startDate: job.startDate || "",
            endDate: "",
          },
        },
        matchAnalysis: {
          matchConfidence: confidence,
          amountMatch: isAmountMatch ? `YES - invoice £${invoiceAmtForMatch.toFixed(2)} matches slot £${targetSlot.amt.toFixed(2)} (within tolerance)` : `NO - invoice is £${invoiceAmtForMatch.toFixed(2)}${targetSlot.amt > 0 ? `, slot is £${targetSlot.amt.toFixed(2)}` : ""}`,
          dateRangeMatch: dateMatch === null ? (targetDate ? "UNKNOWN" : "N/A") : (dateMatch ? "YES" : "PARTIAL - outside date tolerance"),
          projectCodeMatch: "N/A",
          reasonForChoice: optExplanation,
          discrepancies: dateMatch ? "None" : `Date outside tolerance: ${dateNote}`,
          whyItDidntAutoMatch: "Multiple slot matches, client mismatch, or foreign currency - system presented candidate options",
        },
        recommendedActions: recActions,
        slotBreakdown: { lines: slotLines, correctedTotal: `£${newTotal.toFixed(2)}`, currentRevenue: `£${job.revenueNum.toFixed(2)}`, revLine },
        _signalType: signalType,
        _clientRank: clientRank,
        _rankStartDate: job.startDate || "",
        _rankBudgetFits: budgetFits,
        _rankDateMatch: dateMatch === true,
        _dateDiffMs: dateDiffMs,
      });
    }

    // Rank options: Exact/partial client match -> Budget fit -> Date proximity -> Job recency
    const parseRankDate = (d) => {
      if (!d) return null;
      const MONTHS_MAP = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (!m) return null;
      const mIdx = MONTHS_MAP[m[2].toLowerCase()];
      if (mIdx === undefined) return null;
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
      return new Date(yr, mIdx, parseInt(m[1])).getTime();
    };

    tier2Options.sort((a, b) => {
      // 1. Exact or partial client match (highest priority)
      if (a._clientRank !== b._clientRank) {
        return b._clientRank - a._clientRank;
      }
      // 2. Budget fit - options that don't exceed job revenue come first
      if (a._rankBudgetFits !== b._rankBudgetFits) {
        return a._rankBudgetFits ? -1 : 1;
      }
      // 3. Date proximity
      if (a._rankDateMatch !== b._rankDateMatch) {
        return a._rankDateMatch ? -1 : 1;
      }
      if (a._dateDiffMs !== null && b._dateDiffMs !== null && a._dateDiffMs !== b._dateDiffMs) {
        return a._dateDiffMs - b._dateDiffMs;
      }
      // 4. Job recency (more recent job start date first)
      const da = parseRankDate(a._rankStartDate);
      const db = parseRankDate(b._rankStartDate);
      if (da !== null && db !== null && da !== db) {
        return db - da;
      }
      if (da !== null && db === null) return -1;
      if (da === null && db !== null) return 1;

      // Tie-breaker: earlier row number
      return (a.jobRow || 0) - (b.jobRow || 0);
    });

    // Strictly top 2 options maximum
    const top2Tier2Options = tier2Options.slice(0, 2);

    // Renumber and cache
    let options = top2Tier2Options.map((o, i) => {
      const { _signalType, _clientRank, _rankStartDate, _rankBudgetFits, _rankDateMatch, _dateDiffMs, ...clean } = o;
      return { ...clean, optionId: i + 1 };
    });
    console.log(`  ✅ System-generated ${options.length} invoice options (capped at top 2)`);

    // Attach jobRowsData for spreadsheet-style display - cache by row+slot since
    // different options can target the same row with different slots highlighted
    const invJobRowCache = new Map();
    for (const opt of options) {
      if (!opt.jobRow) continue;
      const highlightSlot = (opt.targetSlotType && opt.targetSlotNum)
        ? { type: opt.targetSlotType, rowNum: opt.targetRowNum || opt.jobRow, slotNum: opt.targetSlotNum }
        : null;
      const cacheKey = `${opt.jobRow}-${highlightSlot?.rowNum ?? "same"}-${highlightSlot?.slotNum ?? "none"}`;
      if (!invJobRowCache.has(cacheKey)) {
        invJobRowCache.set(cacheKey, await fetchJobRowsForDisplay(sheets, alert.clientId, "Confirmed", opt.jobRow, highlightSlot, sharedData));
      }
      opt.jobRowsData = invJobRowCache.get(cacheKey);
    }

    const invSummary = `Invoice ${invoiceRef} ${effectiveInvClient} - ${effectiveInvJob}`;
    if (memoryRow) {
      await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(options) });
    } else {
      await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
        fingerprintHash, alertType: "invoice", clientName: alert.clientName || "",
        alertSummary: invSummary, cachedOptionsJSON: JSON.stringify(options), status: "cached",
      });
    }
    console.log(`  💾 Options cached in AlertMemory`);

    res.status(200).json({
      success: true,
      options,
      alertId: alert.rowNumber,
      previousIgnoreReason
    });
  } catch (err) {
    console.error("❌ Error generating options:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleAcceptOption(req, res, sheets) {
  const { alert, option, automationCommanderSheetId } = req.body;

  if (!alert || !option || !automationCommanderSheetId) {
    return res.status(400).json({
      success: false,
      error: "Missing alert, option, or automationCommanderSheetId"
    });
  }

  try {
    console.log(`\n✅ ACCEPTING OPTION for alert:`, alert.clientName);
    console.log(`   Option: ${option.title}, matchType: ${option.matchType}`);
    console.log(`   recommendedActions:`, JSON.stringify(option.recommendedActions));

    const sheets = await getSheetsClient();

    // ── IGNORE - mark alert as ignored in AlertMemory ────────────────────
    if (option.matchType === "ignore") {
      console.log(`  → Ignoring alert (${alert.clientName} - ${option.title || "discrepancy ignored"})`);
      await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
      const memRows = await readAlertMemory(sheets, automationCommanderSheetId);
      const fp = alert.fingerprintHash || buildAlertFingerprint(alert);
      const mr = findMemoryRow(memRows, fp);
      const alertSummary = alert.summary?.summary || alert.summary || mr?.alertSummary || `${alert.type || alert.flagType || "Alert"} - ${alert.clientName || ""}`.trim();
      const ignoreReason = option.title || "Accepted IGNORE option";
      
      let dataSnapshot = mr?.dataSnapshot || "";
      try {
        const existingSnap = JSON.parse(dataSnapshot || "{}");
        dataSnapshot = JSON.stringify({
          ...existingSnap,
          alertType: alert.type || alert.flagType || existingSnap.alertType || "",
          flagType: alert.flagType || existingSnap.flagType || "",
          masterSheetId: alert.masterSheetId || existingSnap.masterSheetId || "",
          ignoredAt: new Date().toISOString(),
          ignoreOptionTitle: option.title || ""
        });
      } catch (e) {
        dataSnapshot = JSON.stringify({ alertType: alert.type || alert.flagType || "", flagType: alert.flagType || "", masterSheetId: alert.masterSheetId || "" });
      }

      if (mr) {
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, mr.rowIndex, { ...mr, status: "ignored", ignoreReason, dataSnapshot });
      } else {
        await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
          fingerprintHash: fp, alertType: alert.type || alert.flagType || "discrepancy",
          clientName: alert.clientName || "", alertSummary,
          cachedOptionsJSON: "", status: "ignored",
          ignoreReason, dataSnapshot,
        });
      }
      await sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "TriageLog!A:H",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[new Date().toISOString(), alert.type || alert.flagType, `${alert.sheetName}-${alert.rowNumber}`, alert.clientName || "", "", JSON.stringify({ jobName: option.jobName }), "IGNORED", option.title]] },
      });

      // Synchronize removal from precomputed cache so it disappears immediately
      try {
        const targetIds = [fp, `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`].filter(Boolean);
        const preRaw = await redisClient?.get(PRECOMPUTED_KEY);
        if (preRaw) {
          const pre = JSON.parse(preRaw);
          applyAlertRemovalToTriageData(pre, targetIds);
          await redisClient?.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
        }
      } catch (rErr) { }

      return res.status(200).json({ success: true, message: "Alert marked as ignored", cellsWritten: 0 });
    }

    // ── DELETE - blank all cells for the job in Pipeline/Confirmed tab ──
    if (option.matchType === "delete") {
      const tabName = (alert.mode === "Pipeline" || alert.alertType === "crmPipeAppDiscr") ? "Pipeline" : "Confirmed";
      const jobRowNum = option.jobRow;
      if (!jobRowNum) return res.status(400).json({ success: false, error: "Cannot delete: job row number not found" });

      console.log(`  → Deleting job row(s) from ${tabName} tab, starting at row ${jobRowNum}`);
      const tabResp = await sheets.spreadsheets.values.get({
        spreadsheetId: alert.clientId,
        range: `${tabName}!A${jobRowNum}:CR${jobRowNum + 50}`,
      });
      const tabRows = tabResp.data.values || [];

      // Collect parent row + contiguous child rows (blank client/job)
      const rowsToClear = [jobRowNum];
      for (let ri = 1; ri < tabRows.length; ri++) {
        const r = tabRows[ri] || [];
        const hasContent = r.some(c => String(c || "").trim() !== "");
        const isChild = !r[0] && !r[1] && hasContent;
        if (!isChild) break;
        rowsToClear.push(jobRowNum + ri);
      }
      console.log(`  Clearing ${rowsToClear.length} rows: ${rowsToClear.join(", ")}`);

      // Column ranges to clear per the option description: A:G, AG:AM, AP:BH, BX:CR
      const CLEAR_RANGES = ["A", "B", "C", "D", "E", "F", "G"];
      const buildRangeList = (rows) => {
        const ranges = [];
        for (const row of rows) {
          ranges.push(`${tabName}!A${row}:G${row}`);
          ranges.push(`${tabName}!AG${row}:AM${row}`);
          ranges.push(`${tabName}!AN${row}`);
          ranges.push(`${tabName}!AP${row}:BH${row}`);
          ranges.push(`${tabName}!BX${row}:CR${row}`);
          ranges.push(`${tabName}!DD${row}`);
        }
        return ranges;
      };

      const clearRanges = buildRangeList(rowsToClear);
      await sheets.spreadsheets.values.batchClear({
        spreadsheetId: alert.clientId,
        requestBody: { ranges: clearRanges },
      });

      // Mark alert as accepted in AlertMemory
      await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
      const memRows2 = await readAlertMemory(sheets, automationCommanderSheetId);
      const fp2 = alert.fingerprintHash || buildAlertFingerprint(alert);
      const mr2 = findMemoryRow(memRows2, fp2);
      const summary2 = `CRM ${alert.alertType} ${alert.clientName} - ${option.jobName || ""}`.trim();
      if (mr2) {
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, mr2.rowIndex, { ...mr2, status: "accepted" });
      } else {
        await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
          fingerprintHash: fp2, alertType: alert.type || alert.flagType || "crm",
          clientName: alert.clientName || "", alertSummary: summary2,
          cachedOptionsJSON: "", status: "accepted", ignoreReason: "", dataSnapshot: "",
        });
      }
      await sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "TriageLog!A:H",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[new Date().toISOString(), alert.type || alert.flagType, `${alert.sheetName}-${alert.rowNumber}`, alert.clientName || "", "", JSON.stringify({ jobName: option.jobName, rowsCleared: rowsToClear }), "ACCEPTED", option.title]] },
      });

      return res.status(200).json({ success: true, message: `Cleared ${rowsToClear.length} row(s) from ${tabName} tab`, cellsWritten: clearRanges.length });
    }

    // ── OUTGOINGS WRITE (expense category match) ─────────────────────────
    // When an expense is matched to an Outgoings category (not a Confirmed job),
    // we use structured outgoingsData from the option rather than cell references.
    if (
      (alert.type === "expense" || alert.sheetName === "DirComp") &&
      option.matchType === "category" &&
      option.outgoingsData
    ) {
      console.log(`  → Outgoings category write`);

      const rawPayDate = option.outgoingsData.payDate
        || alert.summary?.datePaid
        || alert.summary?.payDate
        || alert.data?.accounting?.[7]
        || (option.outgoingsData.status === "Paid" ? (option.outgoingsData.recDate || alert.summary?.date) : "");
      const rawTxnId = option.outgoingsData.transactionId
        || alert.summary?.transactionId
        || alert.summary?.appId
        || alert.data?.accounting?.[6]
        || alert.data?.accounting?.[11]
        || "";

      const outgoingsData = {
        ...option.outgoingsData,
        payDate: rawPayDate ? String(rawPayDate).trim() : "",
        transactionId: rawTxnId ? String(rawTxnId).trim() : "",
        mode: req.body.mode || option.outgoingsData.mode || "add_alongside",
      };
      const result = await writeOutgoingsExpense(sheets, alert.clientId, outgoingsData);
      console.log(`  ✅ Outgoings write complete: row ${result.sheetRow}, col ${result.colLetter}, £${result.prevValue} → £${result.newValue} (mode: ${result.mode})`);

      // Mark alert as accepted in AlertMemory
      const fp = alert.fingerprintHash || buildAlertFingerprint(alert);
      const alertSummary = alert.summary?.summary || `Expense ${alert.summary?.date || outgoingsData.recDate || ""} • £${alert.summary?.amount || outgoingsData.amount || ""} • ${alert.summary?.description || outgoingsData.description || ""}`.trim();
      try {
        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const memRows = await readAlertMemory(sheets, automationCommanderSheetId);
        const mr = findMemoryRow(memRows, fp);
        if (mr) {
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, mr.rowIndex, { ...mr, status: "accepted" });
        } else {
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
            fingerprintHash: fp,
            alertType: alert.type || alert.flagType || "expenseDashboardDiscr",
            clientName: alert.clientName || "",
            alertSummary,
            cachedOptionsJSON: "",
            status: "accepted",
            ignoreReason: "",
            dataSnapshot: "",
          });
        }
        await updateHandledAlertHash(automationCommanderSheetId, fp, "accepted");
      } catch (memErr) {
        console.warn(`  ⚠️ Could not update AlertMemory on outgoings accept: ${memErr.message}`);
      }

      // Record as assigned expense to suppress on frontend by transactionId/appId
      if (rawTxnId && alert.clientName) {
        try {
          await handleMarkExpenseAssigned({
            body: {
              automationCommanderSheetId,
              clientName: alert.clientName,
              appId: String(rawTxnId).trim()
            }
          }, { status: () => ({ json: () => { } }) }, sheets);
        } catch (aeErr) {
          console.warn(`  ⚠️ Could not mark expense assigned: ${aeErr.message}`);
        }
      }

      // Remove alert from active Redis sessions & precomputed cache
      const alertId = `${alert.sheetName}-${alert.rowNumber}`;
      const targetIds = [alertId, fp, `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`, String(rawTxnId).trim()].filter(Boolean);
      try {
        const preRaw = await redisClient?.get(PRECOMPUTED_KEY);
        if (preRaw) {
          const pre = JSON.parse(preRaw);
          applyAlertRemovalToTriageData(pre, targetIds);
          await redisClient?.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
        }
        if (req.body.sessionId) {
          const sRaw = await redisClient?.get(`triage_alerts:${req.body.sessionId}`);
          if (sRaw) {
            const sData = JSON.parse(sRaw);
            applyAlertRemovalToTriageData(sData, targetIds);
            await redisClient?.set(`triage_alerts:${req.body.sessionId}`, JSON.stringify(sData), { EX: 86400 * 7 });
          }
        }
      } catch (rErr) {
        console.warn(`  ⚠️ Could not sync Redis on outgoings accept: ${rErr.message}`);
      }

      // Fire GAS outgoings pull non-blockingly so Master Sheet syncs notes and clears DirComp
      if (alert.masterSheetId) {
        handleFireOutgoingsPull({
          body: { clientSheetId: alert.clientId, masterSheetId: alert.masterSheetId }
        }, { status: () => ({ json: () => { } }) }, sheets).catch(() => { });
      }

      // Log to TriageLog
      const timestamp = new Date().toISOString();
      const logRow = [
        timestamp,
        alert.type || alert.flagType,
        `${alert.sheetName}-${alert.rowNumber}`,
        alert.clientName || "",
        alert.summary?.amount || "",
        JSON.stringify({ matchAnalysis: option.matchAnalysis, outgoingsData }),
        "ACCEPTED",
        `Option: ${option.title}`,
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId,
        range: "TriageLog!A:H",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [logRow] },
      });

      return res.status(200).json({
        success: true,
        message: `Outgoings write complete: £${result.newValue} in ${option.outgoingsData.categoryName} for ${option.outgoingsData.expenseMonth}`,
        cellsWritten: 1,
      });
    }

    // ── CREATE NEW JOB ────────────────────────────────────────────────────
    // Detect create_new either from matchType field OR from recommendedActions content
    // (Claude sometimes puts matchType inside the action string rather than as a JSON field)
    const isCreateNew = option.matchType === "create_new" ||
      (option.recommendedActions || []).some(a =>
        /create.new|new.row|new.job|add.new.row/i.test(a) || /matchType:\s*create_new/i.test(a)
      );

    if (isCreateNew) {
      console.log(`  → Create new job in Confirmed tab`);
      console.log(`  newJobData present: ${!!option.newJobData}`);
      console.log(`  option keys: ${Object.keys(option).join(", ")}`);
      if (option.newJobData) console.log(`  newJobData: ${JSON.stringify(option.newJobData)}`);

      // If Claude didn't return newJobData, reconstruct it from facts + alert summary
      if (!option.newJobData && option.facts) {
        const f = option.facts;
        const parseAmt = (v) => String(v ?? "").replace(/[£,]/g, "").trim();
        option.newJobData = {
          clientName: String(f.clientName || alert.summary?.client || "").trim(),
          jobName: String(f.jobName || f.jobDescription || option.jobName || "").trim(),
          projectCode: String(f.projectCode || "").trim(),
          revenue: parseAmt(f.totalRevenue || f.revenue || alert.summary?.amount || ""),
          directCosts: "0",
          vatYesNo: String(f.vatYesNo || f.vat || f.vatStatus || "No").trim(),
          projectType: String(f.jobType || f.projectType || "Project").trim(),
          startDate: String(f.startDate || alert.summary?.sentDate || "").trim(),
          endDate: String(f.endDate || "").trim(),
          inv1Ref: String(alert.summary?.invoiceNo || "").trim(),
          inv1Amount: parseAmt(alert.summary?.amount || ""),
          inv1SentDate: String(alert.summary?.sentDate || "").trim(),
          inv1DaysToPay: String(f.daysToPayValue || "30").trim(),
          inv1Status: String(alert.summary?.status || "").trim(),
        };
        console.log(`  Reconstructed newJobData from facts: ${JSON.stringify(option.newJobData)}`);
      }

      // Read client's default days to pay from DataChgAlert!B52 (Master Sheet)
      let clientDefaultDays = 30;
      let targetMasterId = alert.masterSheetId ? (extractSheetIdFromUrl(alert.masterSheetId) || alert.masterSheetId) : null;
      if (!targetMasterId && (alert.clientId || alert.clientName)) {
        try {
          const { clientsArray } = await getAllClients(sheets, { isAdmin: true }, false);
          const found = clientsArray?.find(c => 
            (alert.clientId && (extractSheetIdFromUrl(c.clientSheetId) === alert.clientId || extractSheetIdFromUrl(c.masterSheetId) === alert.clientId)) ||
            (alert.clientName && c.clientName?.toLowerCase() === alert.clientName.toLowerCase())
          );
          if (found?.masterSheetId) {
            targetMasterId = extractSheetIdFromUrl(found.masterSheetId) || found.masterSheetId;
          }
        } catch (e) {}
      }
      try {
        const tols = await getToleranceValues(sheets, targetMasterId || alert.clientId);
        const b52Val = parseInt(tols?.defaultDaysToPay, 10);
        if (!isNaN(b52Val) && b52Val >= 0 && b52Val <= 365) {
          clientDefaultDays = b52Val;
        }
      } catch (e) {}

      if (option.newJobData && (!option.newJobData.inv1DaysToPay || option.newJobData.inv1DaysToPay === "30")) {
        option.newJobData.inv1DaysToPay = String(clientDefaultDays);
      }

      const writeTab = (alert.type === "crm" || alert.sheetName === "CRMComp")
        ? (alert.mode === "Pipeline" ? "Pipeline" : "Confirmed")
        : "Confirmed";
      const startRow = writeTab === "Pipeline" ? 6 : 2;

      // Read target tab across full width A1:CR5000 to find next available row safely
      const tabResp = await sheets.spreadsheets.values.get({
        spreadsheetId: alert.clientId,
        range: `${writeTab}!A1:CR5000`,
      });
      const allRows = tabResp.data.values || [];

      // Step 1: Find the last row with active job or slot data
      let lastJobRow = startRow - 1;
      for (let i = startRow - 1; i < allRows.length; i++) {
        const row = allRows[i] || [];
        const hasA = row[0] !== undefined && String(row[0]).trim() !== "";
        const hasB = row[1] !== undefined && String(row[1]).trim() !== "";
        const hasRev = row[32] !== undefined && String(row[32]).trim() !== "";
        const hasDates = (row[37] !== undefined && String(row[37]).trim() !== "") || (row[38] !== undefined && String(row[38]).trim() !== "");
        
        let hasSlotData = false;
        for (let c = 41; c <= 60; c++) {
          if (row[c] !== undefined && String(row[c]).trim() !== "") { hasSlotData = true; break; }
        }
        if (!hasSlotData) {
          for (let c = 75; c <= 95; c++) {
            if (row[c] !== undefined && String(row[c]).trim() !== "") { hasSlotData = true; break; }
          }
        }

        if (hasA || hasB || hasRev || hasDates || hasSlotData) {
          lastJobRow = i + 1; // 1-indexed
        }
      }

      // Step 2: Find the FIRST blank row beneath all existing jobs
      let newRow = Math.max(startRow, lastJobRow + 1);
      for (let r = lastJobRow; r < allRows.length; r++) {
        const row = allRows[r] || [];
        const isBlank = [0, 1, 2, 3, 4, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42, 48, 55, 75, 82, 89].every(idx => {
          const v = row[idx];
          return v === undefined || v === null || String(v).trim() === "";
        });
        if (isBlank) {
          newRow = r + 1; // 1-indexed
          break;
        }
      }
      console.log(`  Next available row on ${writeTab}: ${newRow}`);

      // Days to pay resolution: strictly integer number (0 to 365), never a date string, defaults to DataChgAlert!B52
      const daysVal = (v) => {
        if (v === undefined || v === null || v === "") return String(clientDefaultDays);
        const s = String(v).trim();
        if (/^[0-9]{4}[-/]/.test(s) || /[A-Za-z]{3}/.test(s) || /^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}/.test(s)) {
          return String(clientDefaultDays);
        }
        const p = parseInt(s.replace(/[^\d-]/g, ""), 10);
        return !isNaN(p) && p >= 0 && p <= 365 ? String(p) : String(clientDefaultDays);
      };

      // Parse cell updates from newJobData (structured) or fall back to text parsing
      const createCellUpdates = [];

      if (option.newJobData && typeof option.newJobData === "object") {
        // Primary path: Claude returned structured newJobData - map fields to columns
        const d = option.newJobData;
        const strVal = (v) => String(v ?? "").trim();
        const numVal = (v) => String(v ?? "").replace(/[£,]/g, "").trim();

        const fieldMap = [
          ["A", strVal(d.clientName)],
          ["B", strVal(d.jobName)],
          ["C", strVal(d.projectCode)],
          ["D", toSheetDateFormat(new Date())],
          ["AG", numVal(d.revenue)],
          ["AH", numVal(d.directCosts || "0")],
          ["AI", strVal(d.vatYesNo || "No")],
          ["AJ", strVal(d.projectType || "Project")],
          ["AL", strVal(d.startDate)],
          ["AM", strVal(d.endDate)],
          // Inv1
          ["AP", numVal(d.inv1Amount)],
          ["AQ", strVal(d.inv1Ref)],
          ["AR", strVal(d.inv1SentDate)],
          ["AS", daysVal(d.inv1DaysToPay)],
          ["AT", strVal(d.inv1Status || (d.inv1Amount ? "Sent" : ""))],
          // Inv2 (if present)
          ["AW", numVal(d.inv2Amount || "")],
          ["AX", strVal(d.inv2Ref || "")],
          ["AY", strVal(d.inv2SentDate || "")],
          ["AZ", d.inv2Amount ? daysVal(d.inv2DaysToPay) : ""],
          ["BA", strVal(d.inv2Status || "")],
        ];

        for (const [col, val] of fieldMap) {
          if (val !== "") createCellUpdates.push({ cell: `${col}${newRow}`, value: val });
        }
        console.log(`  newJobData parsed: ${createCellUpdates.length} fields`);

      } else {
        // Fallback: try to parse from recommendedActions text
        for (const actionString of (option.recommendedActions || [])) {
          // Format 1: "write VALUE to Col X"
          const regex1 = /write\s+(.+?)\s+to\s+Col(?:umn)?\s+([A-Z]{1,3})(?:\s*[,.()\n]|$)/gi;
          let match1;
          while ((match1 = regex1.exec(actionString)) !== null) {
            const val1 = match1[1].trim().replace(/^["']|["']$/g, '').trim();
            if (val1 && !/[A-Z]{1,3}\d+/.test(val1)) createCellUpdates.push({ cell: `${match1[2]}${newRow}`, value: val1 });
          }
        }
        if (createCellUpdates.length === 0) {
          // Format 2: "write VALUE to A251"
          for (const actionString of (option.recommendedActions || [])) {
            const regex2 = /write\s+(.+?)\s+to\s+([A-Z]{1,3}\d+)(?:\s*[,(]|$)/gi;
            let match2;
            while ((match2 = regex2.exec(actionString)) !== null) {
              const val2 = match2[1].trim().replace(/^["']|["']$/g, '').trim();
              if (val2 && !/[A-Z]{1,3}\d+/.test(val2)) createCellUpdates.push({ cell: match2[2], value: val2 });
            }
          }
        }
        console.log(`  Text fallback parsed: ${createCellUpdates.length} fields`);
      }

      if (createCellUpdates.length === 0) {
        return res.status(400).json({ success: false, error: "Could not parse any cell writes from create_new recommendedActions. Check the Claude output format." });
      }

      // Sanitise and write
      const MONTHS_NEW = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const DAYS_TO_PAY_COLS = new Set(["AS", "AZ", "BG", "CB", "CI", "CP"]);

      const sanitiseNew = (cell, val) => {
        const colLetters = String(cell || "").replace(/[0-9]/g, "").toUpperCase();
        if (DAYS_TO_PAY_COLS.has(colLetters)) {
          return daysVal(val);
        }
        let v = String(val ?? "");
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        const jsDateMatch = v.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\w{3})\s+(\d{1,2})\s+(\d{4})/);
        if (jsDateMatch) {
          const day = jsDateMatch[2].padStart(2, "0");
          const yr = jsDateMatch[3].slice(-2);
          return `${day}-${jsDateMatch[1]}-${yr}`;
        }
        const isoMatch = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
        if (isoMatch) {
          const month = MONTHS_NEW[parseInt(isoMatch[2], 10) - 1] || isoMatch[2];
          return `${isoMatch[3]}-${month}-${isoMatch[1].slice(-2)}`;
        }
        return v;
      };

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: alert.clientId,
        requestBody: {
          data: createCellUpdates.map(({ cell, value }) => ({
            range: `${writeTab}!${cell}`,
            values: [[sanitiseNew(cell, value)]],
          })),
          valueInputOption: "USER_ENTERED",
        },
      });

      console.log(`  ✅ Created new job at row ${newRow} with ${createCellUpdates.length} fields`);

      // Log to TriageLog
      // Log to TriageLog and update AlertMemory - failures here don't affect the user
      try {
        const timestamp = new Date().toISOString();
        await sheets.spreadsheets.values.append({
          spreadsheetId: automationCommanderSheetId,
          range: "TriageLog!A:H",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[
              timestamp, alert.type || alert.flagType,
              `${alert.sheetName}-${alert.rowNumber}`,
              alert.clientName || "",
              alert.summary?.amount || "",
              JSON.stringify({ matchAnalysis: option.matchAnalysis }),
              "ACCEPTED", `Created new job at row ${newRow}: ${option.title}`,
            ]]
          },
        });

        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const memoryRows2 = await readAlertMemory(sheets, automationCommanderSheetId);
        const fingerprintHash2 = alert.fingerprintHash || buildAlertFingerprint(alert);
        const memoryRow2 = findMemoryRow(memoryRows2, fingerprintHash2);
        const alertSummary2 = alert.summary?.summary || `${alert.type} ${fingerprintHash2}`;
        if (memoryRow2) {
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow2.rowIndex, { ...memoryRow2, status: "accepted" });
        } else {
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
            fingerprintHash: fingerprintHash2, alertType: alert.type || alert.flagType || "unknown",
            clientName: alert.clientName || "", alertSummary: alertSummary2,
            cachedOptionsJSON: "", status: "accepted", ignoreReason: "",
          });
        }
      } catch (postWriteErr) {
        console.log(`  ⚠️ Post-write logging failed (job was still created): ${postWriteErr.message}`);
      }

      return res.status(200).json({
        success: true,
        message: `Created new job at row ${newRow} in ${writeTab} tab`,
        cellsWritten: createCellUpdates.length,
        newRow,
      });
    }
    const cellUpdates = [];
    if (option.recommendedActions && Array.isArray(option.recommendedActions)) {
      for (const actionString of option.recommendedActions) {
        if (actionString.includes("Write") || actionString.includes("write")) {
          const regex = /write\s+(.+?)\s+to\s+([A-Z]{1,3}\d+)(?:\s*[,(]|$)/gi;
          let match;
          while ((match = regex.exec(actionString)) !== null) {
            let value = match[1].trim();
            const cell = match[2];
            // Reject malformed captures where the value itself contains a cell reference
            // e.g. "to CI51, write Received" - this means the regex caught too much
            if (/[A-Z]{1,3}\d+/.test(value)) {
              console.log(`  ⚠ Skipping malformed write action - value "${value}" contains cell reference`);
              continue;
            }
            // Strip surrounding quotes if Claude wrapped the value in them
            value = value.replace(/^["']|["']$/g, '').trim();
            // Allow empty string writes - these are intentional slot clears (e.g. clearing a MANUAL-INV placeholder)
            if (cell && value !== undefined) cellUpdates.push({ cell, value });
          }
        }
      }
    }

    if (option.vatUpdate && Array.isArray(option.vatUpdate.cells)) {
      for (const cell of option.vatUpdate.cells) {
        if (!cellUpdates.some(u => u.cell === cell)) {
          cellUpdates.push({ cell, value: option.vatUpdate.newValue });
        }
      }
    }

    console.log(`  Parsed ${cellUpdates.length} cell updates`);

    // ── ROW RE-VERIFICATION ──────────────────────────────────────────────
    // Cell references were generated at analysis time pointing to Confirmed tab rows.
    // Before writing, verify the job is still at the expected row by matching
    // client + job name. If rows have shifted, remap all cell references.
    if (cellUpdates.length > 0) {
      const alertType = alert.type || alert.sheetName;

      if (alertType === "invoice" || alert.sheetName === "InvComp" ||
        alertType === "expense" || alert.sheetName === "DirComp" ||
        alertType === "crm" || alert.sheetName === "CRMComp") {

        // Determine which tab the cell references point to
        const verifyTab = option.tabName || ((alertType === "crm" || alert.sheetName === "CRMComp")
          ? (alert.mode === "Pipeline" ? "Pipeline" : "Confirmed")
          : "Confirmed");

        // Extract the expected row number from the first cell reference
        // e.g. "AP52" → row 52
        const firstCell = cellUpdates[0]?.cell || "";
        const firstRowMatch = firstCell.match(/^[A-Z]+(\d+)$/);
        if (firstRowMatch) {
          const expectedRow = parseInt(firstRowMatch[1], 10);

          // Determine the expected job name from the option
          const expectedJobName = (option.jobName || option.matchingDetails?.unmatchedJobSummary?.jobName || "").trim().toLowerCase();
          const expectedClient = (option.matchingDetails?.unmatchedJobSummary?.clientName || alert.clientName || "").trim().toLowerCase();

          if (verifyTab === "Outgoings") {
            try {
              const outgoingsResp = await sheets.spreadsheets.values.get({
                spreadsheetId: alert.clientId,
                range: "Outgoings!A13:B110",
              });
              const ogRows = outgoingsResp.data.values || [];
              const expectedVendor = expectedJobName.toLowerCase().trim();
              let foundRow = -1;
              for (let i = 0; i < ogRows.length; i++) {
                const v = String(ogRows[i]?.[0] || "").toLowerCase().trim();
                if (v === expectedVendor || (expectedVendor && v.includes(expectedVendor)) || (expectedVendor && expectedVendor.includes(v))) {
                  foundRow = i + 13;
                  break;
                }
              }
              if (foundRow !== -1 && foundRow !== expectedRow) {
                const rowShift = foundRow - expectedRow;
                console.log(`  ⚠️ Vendor row shift in Outgoings: was ${expectedRow}, now ${foundRow}`);
                for (const update of cellUpdates) {
                  update.cell = update.cell.replace(/^([A-Z]+)(\d+)$/, (_, col, row) =>
                    `${col}${parseInt(row, 10) + rowShift}`
                  );
                }
              }
            } catch (ogErr) {
              console.log(`  ⚠ Outgoings row verification error: ${ogErr.message}`);
            }
          } else if (expectedJobName) {
            // Re-read the Confirmed/Pipeline tab fresh - cols A:AM covers client, job, revenue (AG), start date (AL)
            const verifyResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: `${verifyTab}!A1:AM5000`,
            });
            const verifyRows = verifyResp.data.values || [];

            // Check if the expected row still has the right job
            const currentRow = verifyRows[expectedRow - 1] || [];
            const currentClient = String(currentRow[0] || "").trim().toLowerCase();
            const currentJob = String(currentRow[1] || "").trim().toLowerCase();
            const currentRevenue = String(currentRow[32] || "").trim(); // AG = index 32
            const currentStart = String(currentRow[37] || "").trim(); // AL = index 37

            // Expected revenue and start date from the option
            const expectedRevenue = String(option.matchingDetails?.unmatchedJobSummary?.revenue || "").trim();
            const expectedStart = String(option.matchingDetails?.unmatchedJobSummary?.startDate || "").trim();

            const jobMatches = (r) => {
              const rJob = String(r[1] || "").trim().toLowerCase();
              const rRevenue = String(r[32] || "").trim();
              const rStart = String(r[37] || "").trim();
              if (rJob !== expectedJobName) return false;
              if (expectedRevenue && rRevenue && rRevenue !== expectedRevenue) return false;
              if (expectedStart && rStart && rStart !== expectedStart) return false;
              return true;
            };

            if (!jobMatches(currentRow)) {
              // Row has shifted - find the job by name + revenue + start date
              console.log(`  ⚠️ Job not at expected row ${expectedRow}.`);
              console.log(`  Expected: job="${expectedJobName}" revenue="${expectedRevenue}" start="${expectedStart}"`);
              console.log(`  Found at row ${expectedRow}: job="${String(currentRow[1] || "").trim()}" revenue="${String(currentRow[32] || "").trim()}" start="${String(currentRow[37] || "").trim()}"`);
              let foundRow = -1;
              for (let i = 0; i < verifyRows.length; i++) {
                if (jobMatches(verifyRows[i])) {
                  foundRow = i + 1; // 1-indexed
                  break;
                }
              }
              if (foundRow === -1) {
                // Log nearby rows to help diagnose format mismatches
                for (let i = Math.max(0, expectedRow - 3); i < Math.min(verifyRows.length, expectedRow + 3); i++) {
                  const r = verifyRows[i] || [];
                  console.log(`  Nearby row ${i + 1}: client="${String(r[0] || "").trim()}" job="${String(r[1] || "").trim()}" revenue="${String(r[32] || "").trim()}" start="${String(r[37] || "").trim()}"`);
                }
                return res.status(409).json({
                  success: false,
                  error: `Job "${option.jobName || expectedJobName}" could not be found in the ${verifyTab} tab. Please go back to the alert list and click this alert again to refresh the analysis before accepting.`,
                });
              }
              const rowShift = foundRow - expectedRow;
              console.log(`  ⚠️ Row shift detected for "${expectedJobName}": was row ${expectedRow}, now row ${foundRow} (shift: ${rowShift > 0 ? "+" : ""}${rowShift})`);
              for (const update of cellUpdates) {
                update.cell = update.cell.replace(/^([A-Z]+)(\d+)$/, (_, col, row) =>
                  `${col}${parseInt(row, 10) + rowShift}`
                );
              }
            } else {
              console.log(`  ✓ Job "${expectedJobName}" confirmed at row ${expectedRow} in ${verifyTab}`);
            }
          }
        }
      }
    }

    // Determine which tab to write to based on alert type
    const writeTab = option.tabName || ((alert.type === "crm" || alert.sheetName === "CRMComp")
      ? (alert.mode === "Pipeline" ? "Pipeline" : "Confirmed")
      : "Confirmed");

    // Batch write all cells, always prefixed with the tab name
    if (cellUpdates.length > 0) {

      // Sanitise values before writing:
      // 1. Strip surrounding quotes - Claude sometimes writes "" for empty, which would
      //    appear as literal quote characters in the sheet rather than a blank cell.
      // 2. Reformat JS date strings (e.g. "Mon Mar 23 2026 00:00:00 GMT+0000") to "23-Mar-26"
      const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const sanitiseValue = (val) => {
        let v = String(val ?? "");
        // Strip surrounding double quotes (e.g. "" → empty, "foo" → foo)
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        // Strip leading currency symbols so numbers are stored as numeric values
        v = v.replace(/^[£$€]/, "");
        // Detect JS Date toString format: "Mon Mar 23 2026 00:00:00 GMT..."
        const jsDateMatch = v.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\w{3})\s+(\d{1,2})\s+(\d{4})/);
        if (jsDateMatch) {
          const month = jsDateMatch[1];
          const day = jsDateMatch[2].padStart(2, "0");
          const year = jsDateMatch[3].slice(-2);
          return `${day}-${month}-${year}`;
        }
        // Also handle ISO date strings (e.g. "2026-03-23T00:00:00.000Z")
        const isoDateMatch = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
        if (isoDateMatch) {
          const year = isoDateMatch[1].slice(-2);
          const month = MONTHS[parseInt(isoDateMatch[2], 10) - 1] || isoDateMatch[2];
          const day = isoDateMatch[3];
          return `${day}-${month}-${year}`;
        }
        return v;
      };

      // Columns that must always be stored as text, never as numbers.
      // Invoice references (AQ/AX/BE), App IDs (BX/CF/CN), project codes (AC),
      // client name (A), job name (B), VAT setting (AI).
      const TEXT_ONLY_COLS = new Set(["A", "B", "AC", "AI", "AQ", "AX", "BE", "BX", "CF", "CN"]);
      const forceText = (cell, val) => {
        // Extract column letters from cell reference e.g. "AQ65" → "AQ"
        const colMatch = cell.match(/^([A-Z]+)/);
        const col = colMatch ? colMatch[1] : "";
        if (TEXT_ONLY_COLS.has(col) && /^\d+$/.test(String(val).trim())) {
          // Prefix with apostrophe to force Sheets to treat as text
          return `'${val}`;
        }
        return val;
      };

      const batchRequest = {
        data: cellUpdates.map(({ cell, value }) => ({
          range: `${writeTab}!${cell}`,
          values: [[forceText(cell, sanitiseValue(value))]],
        })),
        valueInputOption: "USER_ENTERED",
      };

      console.log(`  Writing ${cellUpdates.length} cells to ${writeTab} tab of Client Sheet...`);
      console.log(`  Cell updates: ${cellUpdates.map(u => `${u.cell}=${JSON.stringify(u.value)}`).join(", ")}`);
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: alert.clientId,
        requestBody: batchRequest,
      });
      console.log(`  ✅ Cells written successfully`);

      // Apply bold + italic formatting to all written cells
      const writeTabSheetId = await getSheetId(sheets, alert.clientId, writeTab);
      const formatReqs = cellUpdates.map(({ cell }) => {
        // Parse cell reference e.g. "B23" → row 22, col 1 (0-indexed)
        const colMatch = cell.match(/^([A-Z]+)(\d+)$/);
        if (!colMatch) return null;
        const colNum = colMatch[1].split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
        const rowNum = parseInt(colMatch[2], 10) - 1;
        return {
          repeatCell: {
            range: { sheetId: writeTabSheetId, startRowIndex: rowNum, endRowIndex: rowNum + 1, startColumnIndex: colNum, endColumnIndex: colNum + 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true, italic: true } } },
            fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.italic",
          },
        };
      }).filter(Boolean);

      if (formatReqs.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: alert.clientId,
          requestBody: { requests: formatReqs },
        });
        console.log(`  ✅ Formatting applied (bold+italic) to ${formatReqs.length} cells`);
      }
    }

    // Record decision to TriageLog
    const timestamp = new Date().toISOString();
    const alertAmount = alert.summary?.amount || alert.data?.amount || alert.data?.revenue || "";

    const logRow = [
      timestamp,
      alert.type || alert.flagType,
      `${alert.sheetName}-${alert.rowNumber}`,
      alert.clientName || "",
      alertAmount,
      JSON.stringify({
        matchAnalysis: option.matchAnalysis,
        allocationBreakdown: option.allocationBreakdown,
      }),
      "ACCEPTED",
      `Option: ${option.title}`,
    ];

    console.log(`  Writing to TriageLog...`);
    await sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: "TriageLog!A:H",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [logRow],
      },
    });
    console.log(`  ✅ Decision logged to TriageLog`);

    // Update AlertMemory to "accepted" so runFullSweep doesn't re-raise this flag
    try {
      await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
      const memoryRowsFinal = await readAlertMemory(sheets, automationCommanderSheetId);
      const fpHash = alert.fingerprintHash || buildAlertFingerprint(alert);
      const memRowFinal = findMemoryRow(memoryRowsFinal, fpHash);
      const alertSummaryFinal = alert.summary?.summary || `${alert.type || alert.flagType} ${fpHash}`;
      if (memRowFinal) {
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, memRowFinal.rowIndex, {
          ...memRowFinal, status: "accepted",
        });
      } else {
        await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
          fingerprintHash: fpHash,
          alertType: alert.type || alert.flagType || "unknown",
          clientName: alert.clientName || "",
          alertSummary: alertSummaryFinal,
          cachedOptionsJSON: "", status: "accepted", ignoreReason: "",
        });
      }
      console.log(`  ✅ AlertMemory updated to accepted`);
    } catch (memErr) {
      console.log(`  ⚠ AlertMemory update failed (non-fatal): ${memErr.message}`);
    }

    const alertCat = (() => {
      const t = String(alert.type || alert.alertType || alert.flagType || "").toLowerCase();
      if (t.includes("inv")) return "INVOICES";
      if (t.includes("exp") || t.includes("dir") || t.includes("cost") || t.includes("vendor")) return "EXPENSES";
      if (t.includes("crm")) return "CRM";
      if (t.includes("ret")) return "RETAINER";
      return "TRIAGE";
    })();

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: alert.clientName || "",
      category: alertCat,
      action: "Alert Option Accepted",
      summary: `Accepted option for ${alert.clientName || "Client"} (${alert.type || alert.flagType || "alert"}): "${option.title || option.label || "Option"}"`,
      details: {
        alertType: alert.type || alert.alertType || alert.flagType,
        optionTitle: option.title || option.label,
        matchType: option.matchType,
        clientName: alert.clientName,
        cellsWritten: cellUpdates.length
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({
      success: true,
      message: "Option accepted and written to sheet",
      cellsWritten: cellUpdates.length,
    });
  } catch (err) {
    console.error(`❌ Error accepting option:`, err);
    return res.status(500).json({
      success: false,
      error: `Failed to write to sheet: ${err.message}`,
      details: err.toString(),
    });
  }
}

export async function handleDeleteJob(req, res, sheets) {
  // Blank out all cells for a job (parent + child rows) in the Confirmed or Pipeline tab.
  // NEVER deletes rows - only clears cell content.
  // Child rows: same client (col A) + same job name (col B) + no revenue (AG=32) + no direct costs (AH=33) + no start date (AL=37)
  // Blanked columns: A:G (0-6), AG:AM (32-38), AP:BH (41-59), BX:CR (75-94)
  const { alert, option, automationCommanderSheetId } = req.body;
  if (!alert || !option || !automationCommanderSheetId) {
    return res.status(400).json({ success: false, error: "Missing alert, option, or automationCommanderSheetId" });
  }

  try {
    console.log(`\n🗑️ DELETE_JOB for ${alert.clientName}: ${option.jobName}`);
    const sheets = await getSheetsClient();

    const tabName = (alert.alertType || alert.flagType || "") === "crmPipeAppDiscr" ? "Pipeline" : "Confirmed";
    const clientSheetId = alert.clientId;

    if (!clientSheetId) {
      console.error("  ❌ clientSheetId missing from alert");
      return res.status(400).json({ success: false, error: "Cannot delete: clientSheetId missing from alert - please re-analyse this alert and try again." });
    }

    // Only read cols A:B (client, job) and AG (revenue - to identify parent vs child)
    // This is much faster than reading A1:CR2000
    const tabResp = await sheets.spreadsheets.values.get({
      spreadsheetId: clientSheetId,
      range: `${tabName}!A1:AG2000`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const tabRows = tabResp.data.values || [];
    console.log(`  Tab read complete, ${tabRows.length} rows`);

    const targetClient = (option.clientName || option.matchingDetails?.unmatchedJobSummary?.clientName || "").trim().toLowerCase();
    const targetJob = (option.jobName || "").trim().toLowerCase();
    const targetCode = (option.matchingDetails?.unmatchedJobSummary?.projectCode || "").trim().toLowerCase();

    // Pipeline / Confirmed tab: check option.jobRow first
    let parentRowIdx = -1;
    if (option.jobRow && tabRows[option.jobRow - 1]) {
      parentRowIdx = option.jobRow - 1;
      console.log(`  Found parent directly from option.jobRow: ${option.jobRow}`);
    } else {
      let lastSeenClient = "";
      for (let i = 1; i < tabRows.length; i++) {
        const r = tabRows[i] || [];
        const rClientRaw = String(r[0] || "").trim();
        const rJob = String(r[1] || "").trim().toLowerCase();
        const rCode = String(r[2] || "").trim().toLowerCase();
        if (rClientRaw) lastSeenClient = rClientRaw.toLowerCase();
        const effectiveClient = rClientRaw ? rClientRaw.toLowerCase() : lastSeenClient;
        const clientMatch = effectiveClient === targetClient;
        const jobMatch = rJob === targetJob;
        const codeMatch = targetCode && rCode === targetCode;
        if ((codeMatch || (clientMatch && jobMatch))) {
          parentRowIdx = i;
          break;
        }
      }
    }

    if (parentRowIdx === -1) {
      const sample = tabRows.slice(1, 4).map(r => `"${r[0] || ""}/${r[1] || ""}"`).join(", ");
      return res.status(404).json({
        success: false,
        error: `Job "${option.jobName}" not found in ${tabName} tab - client name or job name may not match exactly. Nearby rows: ${sample}`,
      });
    }

    const parentSheetRow = parentRowIdx + 1;
    console.log(`  Found parent at row ${parentSheetRow}`);

    // Collect child rows: same client + job, no revenue (32) + no direct costs (33) + no start date (37)
    const rowsToBlank = [parentRowIdx];
    let ci = parentRowIdx + 1;
    while (ci < tabRows.length) {
      const next = tabRows[ci] || [];
      const nc = String(next[0] || "").trim().toLowerCase();
      const nj = String(next[1] || "").trim().toLowerCase();
      const hasContent = next.some(c => String(c || "").trim() !== "");
      const isChild = (!nc && !nj && hasContent) || (targetClient && nc === targetClient && nj === targetJob);
      if (isChild && !next[32] && !next[33] && !next[37]) {
        rowsToBlank.push(ci);
        ci++;
      } else { break; }
    }
    console.log(`  Rows to blank: ${rowsToBlank.map(r => r + 1).join(", ")} (${rowsToBlank.length} rows)`);

    // Build column ranges to blank: A:G (1-7), AE (31), AG:AM (33-39), AN (40), AP:BH (42-60), BX:CR (76-96), DD (108)
    // AN = likelihood (40), DD = "Copied to Confirmed?" (108) - Pipeline-specific fields
    // In A1 notation: colNum is 1-indexed
    const colRanges = [
      [1, 7],    // A:G
      [31, 31],  // AE (Uneven revenue splits)
      [33, 39],  // AG:AM
      [40, 40],  // AN (likelihood)
      [42, 60],  // AP:BH
      [76, 96],  // BX:CR
      [108, 108], // DD (Copied to Confirmed?)
    ];

    const clearRanges = [];
    for (const rowIdx of rowsToBlank) {
      const sheetRow = rowIdx + 1;
      for (const [startCol, endCol] of colRanges) {
        const startColLetter = colIndexToLetter(startCol);
        const endColLetter = colIndexToLetter(endCol);
        clearRanges.push(`${tabName}!${startColLetter}${sheetRow}:${endColLetter}${sheetRow}`);
      }
    }

    // Use batchClear (not batchUpdate with "") - batchClear truly empties cells,
    // preserving formatting and not leaving empty-string values that would
    // trigger conditional formatting rules checking <>0 or <>"".
    await sheets.spreadsheets.values.batchClear({
      spreadsheetId: clientSheetId,
      requestBody: { ranges: clearRanges },
    });
    console.log(`  ✅ Cleared ${rowsToBlank.length} rows (${clearRanges.length} ranges)`);

    // Log to TriageLog
    await sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: "TriageLog!A:H",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          new Date().toISOString(),
          alert.alertType || alert.type || "crm",
          `${alert.sheetName}-${alert.rowNumber}`,
          alert.clientName || "",
          "",
          JSON.stringify({ deletedJob: option.jobName, tabName, rowsBlank: rowsToBlank.map(r => r + 1) }),
          "ACCEPTED",
          `Deleted job: ${option.jobName} from ${tabName} tab`,
        ]],
      },
    });

    // Update AlertMemory so runFullSweep doesn't re-raise this flag
    try {
      await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
      const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
      const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);
      const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
      if (memoryRow) {
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
          ...memoryRow, status: "accepted",
        });
      } else {
        await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
          fingerprintHash,
          alertType: alert.alertType || alert.type || "crm",
          clientName: alert.clientName || "",
          alertSummary: `Deleted: ${option.jobName}`,
          cachedOptionsJSON: "", status: "accepted", ignoreReason: "",
        });
      }
    } catch (memErr) {
      console.log(`  ⚠ AlertMemory update failed (non-fatal): ${memErr.message}`);
    }

    logPmaActivity(sheets, {
      automationCommanderSheetId,
      clientName: alert.clientName || "",
      category: "JOB",
      action: "Job Deleted via Triage",
      summary: `Deleted job '${option.jobName || "Job"}' for ${alert.clientName || "Client"} from ${tabName}`,
      details: {
        jobName: option.jobName,
        tabName,
        clientName: alert.clientName,
        rowsBlanked: rowsToBlank.length
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({
      success: true,
      message: `Job "${option.jobName}" blanked across ${rowsToBlank.length} row(s) in ${tabName} tab`,
      rowsBlank: rowsToBlank.map(r => r + 1),
    });
  } catch (err) {
    console.error(`❌ Error in delete_job:`, err);
    return res.status(500).json({ success: false, error: `Failed to delete job: ${err.message}` });
  }
}

export async function handleAnalyzeNoActionFlag(req, res, initialSheets) {
  // Analyze a non-actionable flag by reading the client's AutoLog tab (master sheet)
  // to identify exactly which jobs were affected, then verify them.
  // Supported flagTypes: crmCopiedConfChecked, crmCopiedConfUnchecked, retainerInvoicesCreated
  //
  // targetLine (26 Aug 2026, Paul's direction - proposal 2): when provided
  // (the exact AutoLog line text, already stored as the AlertMemory row's
  // alertSummary since that's how detection fingerprinted it), restricts
  // analysis to that one specific instance instead of scanning the whole
  // window for every possibly-relevant entry. Every one of the 6 rich
  // types' parsing/verification logic below is completely unchanged -
  // each already naturally produces a single-job result when only one
  // line is present to match, so narrowing the input alone is sufficient
  // and carries none of the risk a rewrite of that logic would.
  let { clientSheetId, masterSheetId, automationCommanderSheetId: acId, flagType, clientName, targetLine } = req.body;

  if (!acId) {
    acId = process.env.AUTOMATION_COMMANDER_SHEET_ID || "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
  }
  if (!flagType) {
    flagType = req.body.alertType;
  }
  if (!targetLine) {
    targetLine = req.body.flagDetail || req.body.detail || req.body.alertSummary;
  }

  try {
    const sheets = initialSheets || await getSheetsClient();
    let masterSheetIdClean = extractSheetIdFromUrl(masterSheetId) || masterSheetId;
    let clientSheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const acIdClean = extractSheetIdFromUrl(acId) || acId;

    // Auto-resolve missing sheet IDs using clientName from Automation Commander
    if ((!masterSheetIdClean || !clientSheetIdClean) && (clientName || acIdClean)) {
      try {
        const { clientRows } = await readAutoUpdatesClientRows_(sheets, acIdClean);
        let matchedClient = null;
        if (clientName) {
          matchedClient = clientRows.find(c => c.clientName?.toLowerCase().trim() === clientName.toLowerCase().trim());
        }
        if (!matchedClient && masterSheetIdClean) {
          matchedClient = clientRows.find(c => c.masterSheetId === masterSheetIdClean);
        }
        if (!matchedClient && clientSheetIdClean) {
          matchedClient = clientRows.find(c => c.clientSheetId === clientSheetIdClean);
        }
        if (matchedClient) {
          if (!clientSheetIdClean) clientSheetIdClean = matchedClient.clientSheetId;
          if (!masterSheetIdClean) masterSheetIdClean = matchedClient.masterSheetId;
          if (!clientName) clientName = matchedClient.clientName;
        }
      } catch (lookupErr) {
        console.warn("⚠️ Failed to lookup client sheet IDs in handleAnalyzeNoActionFlag:", lookupErr.message);
      }
    }

    if (!clientSheetIdClean || !masterSheetIdClean || !acIdClean || !flagType) {
      const missing = [
        !clientSheetIdClean && "clientSheetId",
        !masterSheetIdClean && "masterSheetId",
        !acIdClean && "automationCommanderSheetId",
        !flagType && "flagType"
      ].filter(Boolean);
      return res.status(400).json({ success: false, error: `Missing required fields: ${missing.join(", ")}` });
    }

    console.log(`\n🔍 Analyzing non-actionable flag: ${flagType} for ${clientName}${targetLine ? " (targeted instance)" : ""}`);

    // ── Step 1: Find when this flag type was last resolved for this client ────
    // Skipped entirely when targetLine is provided - a lookback window is
    // meaningless once we're targeting one already-known, specific line;
    // it either exists in AutoLog or it doesn't. Saves the extra
    // AlertMemory read too.
    let windowStart = new Date(0); // epoch - no-op filter, overridden below when not targeted

    if (!targetLine) {
      windowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // default: 90 days ago
      let foundClear = false;

      try {
        const memoryRows = await readAlertMemory(sheets, acIdClean);
        const resolvedRows = memoryRows
          .filter(r => r.clientName === clientName && r.alertType === flagType && r.status !== "cached")
          .sort((a, b) => new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime());
        if (resolvedRows.length > 0) {
          const resolvedAt = new Date(resolvedRows[0].lastSeen || resolvedRows[0].firstSeen);
          if (!isNaN(resolvedAt.getTime())) {
            windowStart = resolvedAt;
            foundClear = true;
            console.log(`  ✓ ${flagType} last resolved for ${clientName} at ${resolvedAt.toISOString()} (AlertMemory)`);
          }
        }
      } catch (e) {
        console.log(`  ⚠ Could not read AlertMemory for last-resolved timestamp: ${e.message}`);
      }

      if (!foundClear) {
        console.log(`  ℹ No prior resolution found in AlertMemory - using 90-day window from ${windowStart.toISOString()}`);
      }
    }

    // ── Step 2: Read AutoLog and filter to entries after windowStart ──────────
    // AutoLog col A=Timestamp, B=Category, C=Summary, D=Details
    console.log(`  📖 Reading AutoLog from master sheet...`);
    const autoLogResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetIdClean,
      range: "AutoLog!A2:D5000",
      valueRenderOption: "UNFORMATTED_VALUE",
    }));
    const allAutoLogRows = autoLogResp.data.values || [];
    // Convert serial numbers to JS Dates (same approach as log tab reading)
    const autoLogSerialToDate = (val) => {
      if (!val) return null;
      if (typeof val === "number") return new Date((val - 25569) * 86400 * 1000);
      // Fallback: try direct parse for string timestamps
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    };
    // Filter to entries after windowStart
    let autoLogRows = allAutoLogRows.filter(row => {
      const ts = autoLogSerialToDate(row[0]);
      return ts && ts > windowStart;
    });
    console.log(`  ✓ ${autoLogRows.length} AutoLog entries after window start (${allAutoLogRows.length} total)`);

    // Narrow to the one specific instance (26 Aug 2026, proposal 2) - every
    // branch below still scans/matches within autoLogRows exactly as
    // before, but now only one row (at most) is ever present to match,
    // since only rows whose Details genuinely contain this exact line
    // survive this filter. This is the entire mechanism that turns a
    // whole-window scan into a single-instance check, without touching
    // any of that per-type logic itself.
    if (targetLine) {
      autoLogRows = allAutoLogRows
        .filter(row => String(row[3] || "").includes(targetLine));
      console.log(`  ✓ Narrowed to ${autoLogRows.length} AutoLog row(s) containing the target line`);
    }

    const results = [];

    if (flagType === "crmCopiedConfChecked" || flagType === "crmCopiedConfUnchecked") {
      const expectCopied = flagType === "crmCopiedConfChecked";

      // Read all CRM AutoLog entries - the Details field contains the full structured log
      // The flag is raised when Pipeline col DD changes to 'Yes'.
      // The GAS code writes this at line 293: "Copied Status: 'X' -> 'Yes'"
      // as part of an "Updated Pipeline: Row N, Client | Job - ... Copied Status: ..." entry.
      // "Copied Pipeline Project to Confirmed:" is only written if B82="yes" (auto-copy enabled).
      // "Created New Confirmed Job:" is a direct Confirmed creation, unrelated to this flag.
      const allCRMEntries = autoLogRows.filter(row => {
        const cat = String(row[1] || "").toLowerCase();
        return cat.includes("crm") || cat.includes("pipeline") || cat.includes("confirmed");
      });
      console.log(`  ✓ ${allCRMEntries.length} CRM AutoLog entries total`);

      const relevantEntries = allCRMEntries.filter(row => {
        const details = String(row[3] || "");
        if (expectCopied) {
          // Pipeline DD changed to Yes
          return details.includes("Copied Status:") && (
            details.includes("-> 'Yes'") || details.includes("-> \"Yes\"")
          );
        } else {
          // Pipeline DD changed away from Yes
          return details.includes("Copied Status:") && (
            details.includes("-> 'No'") || details.includes("-> \"No\"") ||
            details.includes("Removed Confirmed Job:") || details.includes("Deleted Confirmed Job:")
          );
        }
      });
      console.log(`  ✓ Found ${relevantEntries.length} relevant entries for ${flagType}`);

      const affectedJobs = [];

      if (expectCopied) {
        for (const entry of relevantEntries) {
          const details = String(entry[3] || "");
          // Format: "Updated Pipeline: Row N, ClientName | JobName - ... Copied Status: 'X' -> 'Yes'"
          // We need to match the line that contains BOTH the job info AND the Copied Status change
          const lines = details.split('\n');
          for (const line of lines) {
            if (line.includes("Skipped Copy: Job with Project Code") || line.includes("already exists in Confirmed")) {
              continue;
            }
            if (!line.includes("Copied Status:")) continue;
            if (!line.includes("-> 'Yes'") && !line.includes("-> \"Yes\"")) continue;
            // Extract client | job from: "Updated Pipeline: Row N, ClientName | JobName - FieldName: ..."
            // Job names can contain " - " (e.g. "Grace & Co (Delta) - Prototype"), so we can't
            // simply stop at the first " - ". Instead, find the first known change-field keyword
            // (Start date:, End date:, Copied Status:, etc.) then take the last " - " before it.
            const pipeIdx = line.indexOf("|");
            if (pipeIdx !== -1) {
              const rowMatch = line.match(/Row\s*(\d+),\s*([^|]*)/);
              const pipelineRowFromLog = rowMatch ? parseInt(rowMatch[1], 10) : null;
              const clientParsed = rowMatch ? rowMatch[2].trim() : "";
              const afterPipe = line.slice(pipeIdx + 1).trim();
              const knownFields = ["Start date:", "End date:", "Job name:", "Date originally",
                "Direct costs:", "Prod. line:", "% likel.", "Copied Status:", "Revenue:", "Type:", "VAT"];
              let firstFieldPos = afterPipe.length;
              for (const field of knownFields) {
                const idx = afterPipe.indexOf(field);
                if (idx !== -1 && idx < firstFieldPos) firstFieldPos = idx;
              }
              const chunk = afterPipe.slice(0, firstFieldPos);
              const lastSep = chunk.lastIndexOf(" - ");
              const jobName = (lastSep !== -1 ? chunk.slice(0, lastSep) : chunk).trim();
              if (jobName) affectedJobs.push({ jobName, clientParsed, pipelineRowFromLog, logTimestamp: String(entry[0] || "") });
            }
          }
        }
        // Deduplicate by clientParsed + jobName or projectCodeFromLog
        const seen = new Set();
        const deduped = affectedJobs.filter(j => {
          const key = `${j.clientParsed}|||${j.jobName}|||${j.projectCodeFromLog || ""}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        affectedJobs.length = 0;
        affectedJobs.push(...deduped);
        console.log(`  ✓ Parsed ${affectedJobs.length} affected jobs: ${JSON.stringify(affectedJobs)}`);
      } else {
        // UNchecked: parse all relevant entries, same line-by-line approach as checked branch.
        // Only match lines that are genuine Pipeline field update entries:
        // Format: "Updated Pipeline: Row N, ClientName | JobName - ... Copied Status: 'Yes' -> 'No'"
        for (const entry of relevantEntries) {
          const details = String(entry[3] || "");
          const lines = details.split('\n');
          for (const line of lines) {
            // Must be a Pipeline update line
            if (!line.includes("Updated Pipeline:")) continue;
            if (!line.includes("Copied Status:")) continue;
            if (!line.includes("-> 'No'") && !line.includes("-> \"No\"")) continue;
            const pipeIdx = line.indexOf("|");
            if (pipeIdx !== -1) {
              const rowMatch = line.match(/Row\s*(\d+),\s*([^|]*)/);
              const pipelineRowFromLog = rowMatch ? parseInt(rowMatch[1], 10) : null;
              const clientParsed = rowMatch ? rowMatch[2].trim() : "";
              const afterPipe = line.slice(pipeIdx + 1).trim();
              const knownFields = ["Start date:", "End date:", "Job name:", "Date originally",
                "Direct costs:", "Prod. line:", "% likel.", "Copied Status:", "Revenue:", "Type:", "VAT"];
              let firstFieldPos = afterPipe.length;
              for (const field of knownFields) {
                const idx = afterPipe.indexOf(field);
                if (idx !== -1 && idx < firstFieldPos) firstFieldPos = idx;
              }
              const chunk = afterPipe.slice(0, firstFieldPos);
              const lastSep = chunk.lastIndexOf(" - ");
              const jobName = (lastSep !== -1 ? chunk.slice(0, lastSep) : chunk).trim();
              affectedJobs.push({ jobName: jobName || "-", clientParsed, pipelineRowFromLog, logTimestamp: String(entry[0] || "") });
            }
          }
        }
        // Deduplicate by clientParsed + jobName
        const seenU = new Set();
        const dedupedU = affectedJobs.filter(j => {
          const k = `${j.clientParsed}|||${j.jobName}`;
          if (seenU.has(k)) return false;
          seenU.add(k); return true;
        });
        affectedJobs.length = 0;
        affectedJobs.push(...dedupedU);
      }

      console.log(`  ✓ Parsed ${affectedJobs.length} affected jobs: ${JSON.stringify(affectedJobs)}`);

      if (affectedJobs.length === 0) {
        const recentDetails = allCRMEntries.slice(0, 3).map(r => `[${r[0]}] ${String(r[3] || "").slice(0, 200)}`).join("\n");
        results.push({
          status: "info",
          message: `No specific jobs identified in AutoLog for this flag. ${relevantEntries.length} potentially relevant CRM entries found.`,
          detail: recentDetails || "No CRM entries in AutoLog.",
        });
      } else {
        // Read Pipeline and Confirmed tabs to verify
        const pipelineResp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetIdClean,
          range: "Pipeline!A6:DE5000",
        }));
        const pipelineRows = pipelineResp.data.values || [];

        const confirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetIdClean,
          range: "Confirmed!A1:C5000",
        }));
        const confirmedRows = confirmedResp.data.values || [];

        for (const job of affectedJobs) {
          const checks = [];
          let allOk = true;
          let pipelineJob = null;    // hoisted so accessible at results.push
          let confirmedMatch = null; // hoisted so accessible at results.push

          if (expectCopied) {
            // CRITICAL CHECK: Pipeline col DD must be "Yes"
            // Pipeline data: col A(0)=Client, B(1)=JobName, C(2)=ProjectCode, DD(107)=CopiedToConf?
            // Pipeline rows start at row 6 in the sheet; our slice starts at A6 so index 0 = row 6
            const jobNameLower = job.jobName.toLowerCase();
            const clientParsedLower = job.clientParsed ? job.clientParsed.toLowerCase() : "";

            // Primary: use the row number from the AutoLog (most reliable)
            if (job.pipelineRowFromLog) {
              const prIdx = job.pipelineRowFromLog - 6; // Pipeline data starts at row 6, index 0 = row 6
              const pr = prIdx >= 0 ? pipelineRows[prIdx] : null;
              if (pr) {
                const prJobName = String(pr[1] || "").trim();
                const prClientName = String(pr[0] || "").trim();
                // When job name is blank or a placeholder "-", skip name validation and trust the row number
                const jobNameIsBlank = !jobNameLower || jobNameLower === "-";
                const jobNameMatches = jobNameIsBlank || prJobName.toLowerCase() === jobNameLower;
                const clientNameMatches = !clientParsedLower || !prClientName ||
                  prClientName.toLowerCase().includes(clientParsedLower) ||
                  clientParsedLower.includes(prClientName.toLowerCase());
                if (jobNameMatches && clientNameMatches) {
                  pipelineJob = {
                    clientName: prClientName,
                    jobName: prJobName,
                    projectCode: String(pr[2] || "").trim(),
                    copiedToConf: String(pr[107] || "").trim(),
                    rowNumber: job.pipelineRowFromLog,
                  };
                } else {
                  console.log(`  ⚠️ Pipeline row ${job.pipelineRowFromLog} has "${prJobName}" / "${prClientName}" - expected "${job.jobName}" / "${job.clientParsed}". Row may have shifted - falling back to name search.`);
                }
              }
            }

            // Fallback: search by job name + client name (skipped when job name is blank/placeholder)
            if (!pipelineJob) {
              const jobNameIsBlank = !jobNameLower || jobNameLower === "-";
              for (let pri = 0; pri < pipelineRows.length; pri++) {
                const pr = pipelineRows[pri];
                const pJobName = String(pr[1] || "").trim();
                const pClientName = String(pr[0] || "").trim();
                const pProjectCode = String(pr[2] || "").trim();

                if (job.projectCodeFromLog && pProjectCode.toLowerCase() === job.projectCodeFromLog.toLowerCase()) {
                  pipelineJob = {
                    clientName: pClientName,
                    jobName: pJobName,
                    projectCode: pProjectCode,
                    copiedToConf: String(pr[107] || "").trim(),
                    rowNumber: pri + 6,
                  };
                  break;
                }
                if (job.projectCodeFromLog) continue; // If looking strictly by code, don't fallback to name check for this iteration

                // If job name is blank/placeholder, match on client name only (less reliable - only use as last resort)
                if (!jobNameIsBlank && (!pJobName || pJobName.toLowerCase() !== jobNameLower)) continue;
                if (jobNameIsBlank && clientParsedLower && pClientName && !pClientName.toLowerCase().includes(clientParsedLower) && !clientParsedLower.includes(pClientName.toLowerCase())) continue;
                if (!jobNameIsBlank && clientParsedLower && pClientName && !pClientName.toLowerCase().includes(clientParsedLower) && !clientParsedLower.includes(pClientName.toLowerCase())) continue;
                pipelineJob = {
                  clientName: pClientName,
                  jobName: pJobName,
                  projectCode: String(pr[2] || "").trim(),
                  copiedToConf: String(pr[107] || "").trim(),
                  rowNumber: pri + 6,
                };
                break;
              }
            }

            if (!pipelineJob) {
              checks.push({ ok: false, message: `✗ CRITICAL: Job "${job.jobName}" not found in Pipeline - cannot verify DD was set to Yes` });
              allOk = false;
            } else {
              const ddVal = pipelineJob.copiedToConf.toLowerCase();
              const ddOk = ddVal === "yes" || ddVal === "true";
              const pRowStr = pipelineJob.rowNumber ? ` (Pipeline row ${pipelineJob.rowNumber})` : "";
              const cliStr = pipelineJob.clientName ? ` - ${pipelineJob.clientName}` : "";
              checks.push({
                ok: ddOk,
                message: ddOk
                  ? `✓ Pipeline col DD ("Copied to confirmed?"): Yes${pRowStr}${cliStr}`
                  : `✗ CRITICAL: Pipeline col DD is "${pipelineJob.copiedToConf}" - expected Yes${pRowStr}${cliStr}. The copy may not have registered correctly.`,
              });
              if (!ddOk) allOk = false;
            }

            // Secondary check: job exists in Confirmed - search by project code first, then job+client name
            // Row numbers are unreliable (rows can shift), so we match on col C (project code) or cols A+B
            const pipelineProjectCode = pipelineJob?.projectCode || job.projectCodeFromLog || "";
            // Use the resolved client name from pipelineJob (more reliable than AutoLog-parsed clientParsed)
            const resolvedClientLower = (pipelineJob?.clientName || "").toLowerCase() || clientParsedLower;
            for (let cri = 0; cri < confirmedRows.length; cri++) {
              const cr = confirmedRows[cri];
              const crJobName = String(cr[1] || "").trim();
              const crClientName = String(cr[0] || "").trim();
              const crProjectCode = String(cr[2] || "").trim();
              // Primary match: project code (most reliable, unique per job)
              if (pipelineProjectCode && crProjectCode && crProjectCode.toLowerCase() === pipelineProjectCode.toLowerCase()) {
                confirmedMatch = { jobName: crJobName, projectCode: crProjectCode, clientName: crClientName, rowNumber: cri + 1 };
                break;
              }
              // Fallback: job name + client name (skip if job name is blank/placeholder)
              const jobNameIsBlankConf = !jobNameLower || jobNameLower === "-";
              if (jobNameIsBlankConf) continue; // can't match on blank name - project code is the only key
              if (crJobName.toLowerCase() !== jobNameLower) continue;
              // Use resolvedClientLower (from pipelineJob) for a more accurate client match
              if (resolvedClientLower && crClientName && !crClientName.toLowerCase().includes(resolvedClientLower) && !resolvedClientLower.includes(crClientName.toLowerCase())) continue;
              confirmedMatch = { jobName: crJobName, projectCode: crProjectCode, clientName: crClientName, rowNumber: cri + 1 };
              break;
            }
            const confExists = confirmedMatch !== null;

            // Include client name and row numbers in check messages
            const pipelineRowStr = pipelineJob?.rowNumber ? ` (Pipeline row ${pipelineJob.rowNumber})` : "";
            const confirmedRowStr = confirmedMatch?.rowNumber ? ` (Confirmed row ${confirmedMatch.rowNumber})` : "";
            const clientStr = pipelineJob?.clientName ? ` - ${pipelineJob.clientName}` : "";

            checks.push({
              ok: confExists,
              message: confExists
                ? `✓ Confirmed tab: "${confirmedMatch.jobName}"${confirmedMatch.projectCode ? ` (${confirmedMatch.projectCode})` : ""}${confirmedRowStr}${pipelineRowStr}${clientStr} found`
                : pipelineProjectCode
                  ? `✗ Confirmed tab: job "${job.jobName}" not found by project code (${pipelineProjectCode}) or name - Confirmed col C may be blank for this job, or copy may have failed`
                  : `✗ Confirmed tab: job "${job.jobName}" not found - copy may have failed`,
            });
            if (!confExists) allOk = false;

          } else {
            // UNchecked: Pipeline DD should be No/blank, job should NOT be in Confirmed
            const jobNameLower = job.jobName ? job.jobName.toLowerCase() : "";
            const clientParsedLower = job.clientParsed ? job.clientParsed.toLowerCase() : "";
            const jobNameIsBlank = !jobNameLower || jobNameLower === "-";

            // Look up Pipeline row - use log row number first, then name search
            if (job.pipelineRowFromLog) {
              const prIdx = job.pipelineRowFromLog - 6;
              const pr = prIdx >= 0 ? pipelineRows[prIdx] : null;
              if (pr) {
                const prJobName = String(pr[1] || "").trim();
                const prClientName = String(pr[0] || "").trim();
                const nameOk = jobNameIsBlank || prJobName.toLowerCase() === jobNameLower;
                const clientOk = !clientParsedLower || !prClientName ||
                  prClientName.toLowerCase().includes(clientParsedLower) ||
                  clientParsedLower.includes(prClientName.toLowerCase());
                if (nameOk && clientOk) {
                  pipelineJob = {
                    copiedToConf: String(pr[107] || "").trim(),
                    rowNumber: job.pipelineRowFromLog,
                    clientName: prClientName,
                    jobName: prJobName,
                    projectCode: String(pr[2] || "").trim(),
                  };
                }
              }
            }
            if (!pipelineJob) {
              for (let pri = 0; pri < pipelineRows.length; pri++) {
                const pr = pipelineRows[pri];
                const pJobName = String(pr[1] || "").trim();
                const pClientName = String(pr[0] || "").trim();
                if (!jobNameIsBlank && (!pJobName || pJobName.toLowerCase() !== jobNameLower)) continue;
                if (clientParsedLower && pClientName &&
                  !pClientName.toLowerCase().includes(clientParsedLower) &&
                  !clientParsedLower.includes(pClientName.toLowerCase())) continue;
                pipelineJob = {
                  copiedToConf: String(pr[107] || "").trim(),
                  rowNumber: pri + 6,
                  clientName: pClientName,
                  jobName: pJobName,
                  projectCode: String(pr[2] || "").trim(),
                };
                break;
              }
            }

            if (pipelineJob) {
              const ddVal = pipelineJob.copiedToConf.toLowerCase();
              const ddOk = ddVal === "no" || ddVal === "" || ddVal === "false";
              const pRowStr = pipelineJob.rowNumber ? ` (Pipeline row ${pipelineJob.rowNumber})` : "";
              const cliStr = pipelineJob.clientName ? ` - ${pipelineJob.clientName}` : "";
              checks.push({
                ok: ddOk,
                message: ddOk
                  ? `✓ Pipeline col DD: "${pipelineJob.copiedToConf || "blank"}" - No/blank (correct)${pRowStr}${cliStr}`
                  : `✗ CRITICAL: Pipeline col DD is "${pipelineJob.copiedToConf}" - expected No or blank${pRowStr}${cliStr}`,
              });
              if (!ddOk) allOk = false;
            } else {
              checks.push({ ok: false, message: `✗ Job "${job.jobName}" not found in Pipeline tab` });
              allOk = false;
            }

            // Check Confirmed - search by project code first, then job+client name
            const uncheckedProjectCode = pipelineJob?.projectCode || "";
            for (let cri = 0; cri < confirmedRows.length; cri++) {
              const cr = confirmedRows[cri];
              const crJobName = String(cr[1] || "").trim();
              const crClientName = String(cr[0] || "").trim();
              const crProjectCode = String(cr[2] || "").trim();
              if (uncheckedProjectCode && crProjectCode &&
                crProjectCode.toLowerCase() === uncheckedProjectCode.toLowerCase()) {
                confirmedMatch = { jobName: crJobName, projectCode: crProjectCode, clientName: crClientName, rowNumber: cri + 1 };
                break;
              }
              if (!jobNameIsBlank && crJobName.toLowerCase() === jobNameLower) {
                const clientOk = !clientParsedLower || !crClientName ||
                  crClientName.toLowerCase().includes(clientParsedLower) ||
                  clientParsedLower.includes(crClientName.toLowerCase());
                if (clientOk) {
                  confirmedMatch = { jobName: crJobName, projectCode: crProjectCode, clientName: crClientName, rowNumber: cri + 1 };
                  break;
                }
              }
            }
            const inConfirmed = confirmedMatch !== null;
            const confRowStr = confirmedMatch?.rowNumber ? ` (Confirmed row ${confirmedMatch.rowNumber})` : "";
            const confCliStr = confirmedMatch?.clientName ? ` - ${confirmedMatch.clientName}` : "";
            checks.push({
              ok: !inConfirmed,
              message: !inConfirmed
                ? `✓ Confirmed tab: job not present (correct)`
                : `✗ "${confirmedMatch.jobName || job.jobName}"${confirmedMatch.projectCode ? ` (${confirmedMatch.projectCode})` : ""}${confRowStr}${confCliStr} still exists in Confirmed - should have been removed`,
            });
            if (inConfirmed) allOk = false;
          }

          results.push({
            jobName: (job.jobName && job.jobName !== "-") ? job.jobName
              : pipelineJob?.jobName || confirmedMatch?.jobName || "-",
            projectCode: pipelineJob?.projectCode || confirmedMatch?.projectCode || "",
            clientName: job.clientParsed || pipelineJob?.clientName || confirmedMatch?.clientName || "",
            pipelineRow: pipelineJob?.rowNumber || null,
            confirmedRow: confirmedMatch?.rowNumber || null,
            clientParsed: job.clientParsed,
            logTimestamp: job.logTimestamp,
            status: allOk ? "ok" : "issue",
            checks,
          });
        }
      }

    } else if (flagType === "retainerInvoicesCreated") {
      // All retainer creation entries in the window since the flag was last cleared
      const retainerLogEntries = autoLogRows.filter(row => {
        const details = String(row[3] || "");
        return details.includes("Retainer") && details.includes("Added") &&
          (details.includes("child row") || details.includes("invoice rows"));
      });
      console.log(`  ✓ Found ${retainerLogEntries.length} retainer creation entries in window`);

      // If nothing found in window, fall back to full AutoLog (last 90 days)
      // This handles timing edge cases where the automation ran just before the window start
      const retainerLogEntriesToUse = retainerLogEntries.length > 0 ? retainerLogEntries :
        allAutoLogRows.filter(row => {
          const details = String(row[3] || "");
          return details.includes("Retainer") && details.includes("Added") &&
            (details.includes("child row") || details.includes("invoice rows"));
        });
      if (retainerLogEntries.length === 0 && retainerLogEntriesToUse.length > 0) {
        console.log(`  ↩ Fell back to full AutoLog - found ${retainerLogEntriesToUse.length} entries`);
      }
      for (const entry of retainerLogEntriesToUse) {
        console.log(`    [${entry[0]}] Details="${String(entry[3] || "").slice(0, 400)}"`);
      }

      if (retainerLogEntriesToUse.length === 0) {
        results.push({
          status: "info",
          message: `No retainer invoice creation entries found in AutoLog since flag was last cleared. If invoices were recently created, click Re-run to refresh.`,
        });
      } else {
        // Parse all entries in the window
        const affectedRetainerJobs = [];
        for (const entry of retainerLogEntriesToUse) {
          const details = String(entry[3] || "");

          // Format A (new): "[Retainers - Confirmed] Added N child row(s) (Parent Row: N) for CLIENT | JOB"
          //                 "[Retainers - Pipeline] Added N child row(s) (Parent Row: N) for CLIENT | JOB"
          const newPattern = /\[Retainers\s*-\s*(Confirmed|Pipeline)\]\s*Added\s+(\d+)\s+child\s+rows?\(s?\)\s*\(Parent\s+Row:\s*(\d+)\)\s+for\s+([^|]+)\s*\|\s*([^\[\n]+)/gi;
          let m;
          while ((m = newPattern.exec(details)) !== null) {
            if (targetLine) {
              const normMatch = m[0].replace(/\s+/g, " ").trim().toLowerCase();
              const normTarget = targetLine.replace(/\s+/g, " ").trim().toLowerCase();
              const clientLower = m[4].trim().toLowerCase();
              const jobLower = m[5].trim().toLowerCase();
              const isMatch = normMatch.includes(normTarget) || normTarget.includes(normMatch) ||
                (normTarget.includes(jobLower) && (normTarget.includes(clientLower) || !clientLower));
              if (!isMatch) continue;
            }
            affectedRetainerJobs.push({
              tab: m[1].trim(),   // "Confirmed" or "Pipeline"
              childRowsCreated: parseInt(m[2], 10),
              logSheetRow: parseInt(m[3], 10),
              clientNameFromLog: m[4].trim(),
              jobName: m[5].trim(),
              logTimestamp: String(entry[0] || "")
            });
          }

          // Format B (old): "Row N, ClientName, JobName: Added N invoice rows"
          if (affectedRetainerJobs.length === 0) {
            const oldPattern = /Row\s+(\d+),\s+([^,]+),\s+([^:]+):\s+Added\s+\d+\s+invoice rows/gi;
            while ((m = oldPattern.exec(details)) !== null) {
              if (targetLine) {
                const normMatch = m[0].replace(/\s+/g, " ").trim().toLowerCase();
                const normTarget = targetLine.replace(/\s+/g, " ").trim().toLowerCase();
                const clientLower = m[2].trim().toLowerCase();
                const jobLower = m[3].trim().toLowerCase();
                const isMatch = normMatch.includes(normTarget) || normTarget.includes(normMatch) ||
                  (normTarget.includes(jobLower) && (normTarget.includes(clientLower) || !clientLower));
                if (!isMatch) continue;
              }
              affectedRetainerJobs.push({
                logSheetRow: parseInt(m[1], 10),
                clientNameFromLog: m[2].trim(),
                jobName: m[3].trim(),
                logTimestamp: String(entry[0] || "")
              });
            }
          }
        }

        if (affectedRetainerJobs.length === 0 && targetLine) {
          const targetNewPattern = /\[Retainers\s*-\s*(Confirmed|Pipeline)\]\s*Added\s+(\d+)\s+child\s+rows?\(s?\)\s*(?:\(Parent\s+Row:\s*(\d+)\)\s*)?for\s+([^|]+)\s*\|\s*([^\[\n]+)/i;
          const tm = targetNewPattern.exec(targetLine);
          if (tm) {
            affectedRetainerJobs.push({
              tab: tm[1].trim(),
              childRowsCreated: parseInt(tm[2], 10),
              logSheetRow: tm[3] ? parseInt(tm[3], 10) : null,
              clientNameFromLog: tm[4].trim(),
              jobName: tm[5].trim(),
              logTimestamp: "",
            });
          } else {
            const targetOldPattern = /Row\s+(\d+),\s+([^,]+),\s+([^:]+):\s+Added\s+(\d+)\s+invoice rows/i;
            const om = targetOldPattern.exec(targetLine);
            if (om) {
              affectedRetainerJobs.push({
                logSheetRow: parseInt(om[1], 10),
                clientNameFromLog: om[2].trim(),
                jobName: om[3].trim(),
                logTimestamp: "",
              });
            }
          }
        }

        // Deduplicate by jobName (row numbers are unreliable after row shifts)
        const seenJobs = new Set();
        let dedupedJobs = affectedRetainerJobs.filter(j => {
          const key = `${j.clientNameFromLog}___${j.jobName}`;
          if (seenJobs.has(key)) return false;
          seenJobs.add(key);
          return true;
        });

        if (targetLine && dedupedJobs.length > 1) {
          const normTarget = targetLine.replace(/\s+/g, " ").trim().toLowerCase();
          const matched = dedupedJobs.filter(j => {
            const jobLower = (j.jobName || "").trim().toLowerCase();
            const clientLower = (j.clientNameFromLog || "").trim().toLowerCase();
            return normTarget.includes(jobLower) && (normTarget.includes(clientLower) || !clientLower);
          });
          if (matched.length > 0) dedupedJobs = matched;
        }
        console.log(`  ✓ Parsed ${dedupedJobs.length} affected retainer jobs: ${JSON.stringify(dedupedJobs)}`);

        // Read Confirmed tab
        const retConfirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetIdClean,
          range: "Confirmed!A1:BH5000",
        }));
        const retConfirmedRows = retConfirmedResp.data.values || [];

        const retPipelineResp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetIdClean,
          range: "Pipeline!A6:BH5000",
        }));
        const retPipelineRows = retPipelineResp.data.values || [];

        const retainerChecks = [];

        for (const job of dedupedJobs) {
          const targetTab = job.tab || "Confirmed"; // default to Confirmed for old-format entries
          const tabRows = targetTab === "Pipeline" ? retPipelineRows : retConfirmedRows;
          const tabStartRow = targetTab === "Pipeline" ? 6 : 1; // Pipeline data starts at row 6

          // Find the parent row by matching client name AND job name.
          // If the AutoLog has a row number, try that first (most reliable).
          // If multiple rows match the same client+job name, warn rather than
          // silently picking the wrong one.
          const jobNameLower = job.jobName.toLowerCase();
          const clientLower = job.clientNameFromLog.toLowerCase();
          let parentRowIdx = -1;
          const allMatchingIdxs = [];

          // First try: use row number from AutoLog if available
          if (job.logSheetRow) {
            const logIdx = job.logSheetRow - tabStartRow;
            if (logIdx >= 0 && logIdx < tabRows.length) {
              const r = tabRows[logIdx];
              const rClient = String(r[0] || "").trim().toLowerCase();
              const rJob = String(r[1] || "").trim().toLowerCase();
              if (rClient === clientLower && rJob === jobNameLower) {
                parentRowIdx = logIdx;
                console.log(`  ✓ Matched by row number: ${job.logSheetRow}`);
              } else {
                console.log(`  ⚠ Row ${job.logSheetRow} has "${r[1]}"/"${r[0]}" - expected "${job.jobName}"/"${job.clientNameFromLog}" - row may have shifted, falling back to name search`);
              }
            }
          }

          // Second: name search - collect ALL matches to detect duplicates
          if (parentRowIdx === -1) {
            for (let ri = 0; ri < tabRows.length; ri++) {
              const r = tabRows[ri];
              const rClient = String(r[0] || "").trim().toLowerCase();
              const rJob = String(r[1] || "").trim().toLowerCase();
              const hasRevenue = !!(r[32]);
              if (rClient === clientLower && rJob === jobNameLower && hasRevenue) {
                allMatchingIdxs.push(ri);
              }
            }
            if (allMatchingIdxs.length === 1) {
              parentRowIdx = allMatchingIdxs[0];
            } else if (allMatchingIdxs.length > 1) {
              retainerChecks.push({
                jobName: job.jobName,
                clientName: job.clientNameFromLog,
                status: "issue",
                checks: [{
                  ok: false,
                  message: `✗ Found ${allMatchingIdxs.length} rows matching "${job.clientNameFromLog} | ${job.jobName}" in ${targetTab} (rows ${allMatchingIdxs.map(i => i + tabStartRow).join(", ")}) - cannot reliably identify which row the automation acted on. Ensure jobs have unique names within the same client.`,
                }],
              });
              continue;
            }
          }

          if (parentRowIdx === -1) {
            // Not found in target tab - check the other tab as fallback
            const fallbackTab = targetTab === "Pipeline" ? "Confirmed" : "Pipeline";
            const fallbackRows = targetTab === "Pipeline" ? retConfirmedRows : retPipelineRows;
            let fallbackIdx = -1;
            for (let ri = 0; ri < fallbackRows.length; ri++) {
              const r = fallbackRows[ri];
              const rClient = String(r[0] || "").trim().toLowerCase();
              const rJob = String(r[1] || "").trim().toLowerCase();
              if (rClient === clientLower && rJob === jobNameLower) {
                fallbackIdx = ri;
                break;
              }
            }
            if (fallbackIdx !== -1) {
              const fallbackStartRow = fallbackTab === "Pipeline" ? 6 : 1;
              retainerChecks.push({
                jobName: job.jobName,
                clientName: job.clientNameFromLog,
                status: "info",
                checks: [{ ok: true, message: `✓ Job "${job.jobName}" (${job.clientNameFromLog}) moved to ${fallbackTab} tab (row ${fallbackIdx + fallbackStartRow}) - originally created in ${targetTab}` }],
              });
            } else {
              retainerChecks.push({
                jobName: job.jobName,
                clientName: job.clientNameFromLog,
                status: "issue",
                checks: [{ ok: false, message: `✗ Job "${job.jobName}" (${job.clientNameFromLog}) not found in ${targetTab} or ${targetTab === "Pipeline" ? "Confirmed" : "Pipeline"} tabs` }],
              });
            }
            continue;
          }

          const parentRow = tabRows[parentRowIdx];
          const clientN = String(parentRow[0] || "").trim();
          const jobName = String(parentRow[1] || "").trim();
          const projectCode = String(parentRow[2] || "").trim();
          const revenue = parentRow[32];
          const startRaw = parentRow[37];
          const endRaw = parentRow[38];
          const confirmedSheetRow = parentRowIdx + tabStartRow;
          console.log(`  Found "${jobName}" (${clientN}) at ${targetTab} row ${confirmedSheetRow}: start="${startRaw}", end="${endRaw}"`);

          // Collect child rows - same tab, immediately after parent
          // Child row: same client+job, no revenue, no start date
          const childRows = [];
          let ci = parentRowIdx + 1;
          while (ci < tabRows.length) {
            const next = tabRows[ci] || [];
            const nClient = String(next[0] || "").trim().toLowerCase();
            const nJob = String(next[1] || "").trim().toLowerCase();
            if (nClient !== clientLower || nJob !== jobNameLower) break;
            if (next[32] || next[37] || next[38]) break; // has revenue/start/end = another parent
            childRows.push({ row: next, sheetRow: ci + tabStartRow });
            ci++;
          }

          const monthlyRevenue = parseFloat(String(revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
          const parseDate = (v) => {
            if (!v) return null;
            if (v instanceof Date) {
              if (isNaN(v.getTime())) return null;
              // JS Date treats 2-digit years as 1900s - correct to 2000s for years < 100
              if (v.getFullYear() < 100) v.setFullYear(v.getFullYear() + 2000);
              return v;
            }
            // Handle DD-Mon-YY or DD-Mon-YYYY strings e.g. "31-Jul-50", "1-May-2026"
            const monMap = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
            const monMatch = String(v).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
            if (monMatch) {
              const yr = monMatch[3].length === 2 ? 2000 + parseInt(monMatch[3], 10) : parseInt(monMatch[3], 10);
              return new Date(yr, monMap[monMatch[2]], parseInt(monMatch[1], 10));
            }
            const d = new Date(v);
            if (!isNaN(d.getTime())) {
              if (d.getFullYear() < 100) d.setFullYear(d.getFullYear() + 2000);
              return d;
            }
            const serial = parseFloat(v);
            if (!isNaN(serial)) return new Date((serial - 25569) * 86400 * 1000);
            return null;
          };
          const startDate = parseDate(startRaw);
          const endDate = parseDate(endRaw);
          const checks = [];

          if (!startDate || !endDate) {
            retainerChecks.push({
              jobName, clientName: clientN, projectCode, status: "info",
              message: `No start/end dates set on this retainer - cannot verify invoice coverage`,
              checks: [],
            });
            continue;
          }

          let periodMonths = 1;
          let periodLabel = "monthly";
          if (childRows.length > 0 && monthlyRevenue > 0) {
            const firstInv = parseFloat(String(childRows[0].row[41] || "").replace(/[£$€,\s]/g, "")) || 0;
            if (firstInv > 0) {
              const ratio = Math.round(firstInv / monthlyRevenue);
              if (ratio >= 2) {
                periodMonths = ratio;
                if (ratio === 3) periodLabel = "quarterly";
                else if (ratio === 6) periodLabel = "6-monthly";
                else if (ratio === 12) periodLabel = "annual";
                else periodLabel = `every ${ratio} months`;
              }
            }
          }

          // ── Single-row retainer check ────────────────────────────────────
          let isSingleMonth = false;
          if (startDate && endDate) {
            const diffTime = endDate.getTime() - startDate.getTime();
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
            const monthsDiff = Math.max(1, Math.round(diffDays / 30.4375));
            isSingleMonth = (monthsDiff === 1);
          }

          const parentInvAmt = parseFloat(String(parentRow[41] || "").replace(/[£$€,\s]/g, "")) || 0;
          const parentInvRef = String(parentRow[42] || "").trim();

          if (childRows.length === 0 && (parentInvAmt > 0 || parentInvRef)) {
            if (isSingleMonth) {
              const hasInvoice = parentInvAmt > 0;
              const fmt = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
              checks.push({ ok: true, message: `Duration: ${fmt(startDate)} → ${fmt(endDate)} (1 month total, single invoice)` });
              checks.push({ ok: true, message: `Single-row retainer (1-month exception) - invoice sits on parent row, no child rows expected` });
              if (hasInvoice) {
                checks.push({ ok: true, message: `✓ Parent row slot 1 has invoice amount £${parentInvAmt.toFixed(2)}${parentInvRef ? ` (ref: ${parentInvRef})` : ""}` });
              } else {
                checks.push({ ok: false, message: `✗ Parent row slot 1 has no invoice amount - invoice not yet created` });
              }
              retainerChecks.push({
                jobName, clientName: clientN, projectCode,
                parentSheetRow: confirmedSheetRow,
                tab: targetTab,
                status: hasInvoice ? "ok" : "issue",
                periodLabel: "single invoice", checks,
              });
              continue;
            } else {
              checks.push({ ok: false, message: `✗ Parent row has an invoice (amount/ref) but no child rows exist - single-row retainers are not allowed for multi-month jobs` });
            }
          }

          // Count child rows whose scheduled invoice date (Inv1 sent-date slot) falls
          // in or before the current calendar month - these are "past + current" rows.
          // Expected = that count + 18 future rows (adjusted for period frequency).
          const parseConfirmedDate = (val) => {
            if (!val) return null;
            if (val instanceof Date) return val;
            const s = String(val).trim();
            // Handle DD-Mon-YY format e.g. "1-Apr-26"
            const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
            if (m) {
              const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
              const yr = 2000 + parseInt(m[3], 10);
              return new Date(yr, months[m[2]], parseInt(m[1], 10));
            }
            const d = new Date(val);
            return isNaN(d.getTime()) ? null : d;
          };

          const today = new Date();
          const endOfCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
          endOfCurrentMonth.setHours(23, 59, 59, 999);

          const pastAndCurrentRows = childRows.filter(({ row: cr }) => {
            const sentDate = parseConfirmedDate(cr[43]); // AR = Inv1 sent date
            return sentDate && sentDate <= endOfCurrentMonth;
          }).length;

          const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
          const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
          const monthsDiff = Math.max(1, Math.round(diffDays / 30.4375));

          const totalPeriods = Math.ceil(monthsDiff / periodMonths);
          const futurePeriodsInContract = Math.max(0, totalPeriods - pastAndCurrentRows);
          const futureRows = Math.min(18 / periodMonths, futurePeriodsInContract);
          const expectedChildRows = pastAndCurrentRows + futureRows;

          const actualChildRows = childRows.length;
          const fmt = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
          const durationOk = actualChildRows >= expectedChildRows;
          checks.push({ ok: true, message: `Duration: ${fmt(startDate)} → ${fmt(endDate)} (${monthsDiff} months total, ${periodLabel})` });
          checks.push({
            ok: durationOk,
            message: `Child rows: ${actualChildRows} found, ${expectedChildRows} expected (${pastAndCurrentRows} past/current + ${futureRows} forward) - ` + (durationOk ? "✓ full coverage" : `✗ ${expectedChildRows - actualChildRows} row(s) missing`),
          });

          let allHaveInvoice = true;
          for (const { row: cr, sheetRow: sr } of childRows) {
            if (!cr[41]) {
              checks.push({ ok: false, message: `✗ Row ${sr}: invoice slot 1 is empty` });
              allHaveInvoice = false;
            }
          }
          if (allHaveInvoice && childRows.length > 0) {
            checks.push({ ok: true, message: `✓ All ${childRows.length} child rows have invoice amounts` });
          }

          retainerChecks.push({
            jobName, clientName: clientN, projectCode,
            parentSheetRow: confirmedSheetRow,
            tab: targetTab,
            status: durationOk && allHaveInvoice ? "ok" : "issue",
            periodLabel, checks,
          });
        }

        results.push(...retainerChecks);
      }

    } else if (flagType === "retainerInvoicesDeleted") {

      // Find AutoLog entries where retainer child rows were trimmed
      const deletedLogEntries = autoLogRows.filter(row => {
        const details = String(row[3] || "");
        return details.includes("Retainer") && details.includes("Trimmed") &&
          (details.includes("child row") || details.includes("excess"));
      });
      console.log(`  ✓ Found ${deletedLogEntries.length} retainer deletion entries in window`);

      // Fall back to full AutoLog if nothing found in window
      const deletedLogEntriesToUse = deletedLogEntries.length > 0 ? deletedLogEntries :
        allAutoLogRows.filter(row => {
          const details = String(row[3] || "");
          return details.includes("Retainer") && details.includes("Trimmed") &&
            (details.includes("child row") || details.includes("excess"));
        });
      if (deletedLogEntries.length === 0 && deletedLogEntriesToUse.length > 0) {
        console.log(`  ↩ Fell back to full AutoLog - found ${deletedLogEntriesToUse.length} entries`);
      }
      for (const entry of deletedLogEntriesToUse) {
        console.log(`    [${entry[0]}] Details="${String(entry[3] || "").slice(0, 400)}"`);
      }

      if (deletedLogEntriesToUse.length === 0) {
        results.push({
          status: "info",
          message: `No retainer invoice deletion entries found in AutoLog since flag was last cleared. If invoices were recently deleted, click Re-run to refresh.`,
        });
      } else {
        const affectedRetainerJobs = [];
        for (const entry of deletedLogEntriesToUse) {
          const details = String(entry[3] || "");
          // Format: "[Retainers] Trimmed N excess child row(s) (Parent Row: N) for CLIENT | JOB"
          const pattern = /Trimmed\s+\d+\s+excess\s+child\s+rows?\(s?\)(?:\s*\(Parent\s+Row:\s*\d+\))?\s*for\s+([^|]+)\s*\|\s*([^\[\n]+)/gi;
          let m;
          while ((m = pattern.exec(details)) !== null) {
            if (targetLine) {
              const normMatch = m[0].replace(/\s+/g, " ").trim().toLowerCase();
              const normTarget = targetLine.replace(/\s+/g, " ").trim().toLowerCase();
              const clientLower = m[1].trim().toLowerCase();
              const jobLower = m[2].trim().toLowerCase();
              const isMatch = normMatch.includes(normTarget) || normTarget.includes(normMatch) ||
                (normTarget.includes(jobLower) && (normTarget.includes(clientLower) || !clientLower));
              if (!isMatch) continue;
            }
            affectedRetainerJobs.push({
              clientNameFromLog: m[1].trim(),
              jobName: m[2].trim(),
              logTimestamp: String(entry[0] || "")
            });
          }
        }

        if (affectedRetainerJobs.length === 0 && targetLine) {
          const targetPattern = /Trimmed\s+\d+\s+excess\s+child\s+rows?\(s?\)(?:\s*\(Parent\s+Row:\s*\d+\))?\s*for\s+([^|]+)\s*\|\s*([^\[\n]+)/i;
          const tm = targetPattern.exec(targetLine);
          if (tm) {
            affectedRetainerJobs.push({
              clientNameFromLog: tm[1].trim(),
              jobName: tm[2].trim(),
              logTimestamp: "",
            });
          }
        }

        // Deduplicate by client + job
        const seenJobs = new Set();
        let dedupedJobs = affectedRetainerJobs.filter(j => {
          const key = `${j.clientNameFromLog}|||${j.jobName}`;
          if (seenJobs.has(key)) return false;
          seenJobs.add(key);
          return true;
        });

        if (targetLine && dedupedJobs.length > 1) {
          const normTarget = targetLine.replace(/\s+/g, " ").trim().toLowerCase();
          const matched = dedupedJobs.filter(j => {
            const jobLower = (j.jobName || "").trim().toLowerCase();
            const clientLower = (j.clientNameFromLog || "").trim().toLowerCase();
            return normTarget.includes(jobLower) && (normTarget.includes(clientLower) || !clientLower);
          });
          if (matched.length > 0) dedupedJobs = matched;
        }
        console.log(`  ✓ Parsed ${dedupedJobs.length} affected retainer jobs: ${JSON.stringify(dedupedJobs)}`);

        // Read Confirmed tab
        const delConfirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetIdClean,
          range: "Confirmed!A1:BH5000",
        }));
        const delConfirmedRows = delConfirmedResp.data.values || [];
        const retainerChecks = [];

        for (const job of dedupedJobs) {
          const jobNameLower = job.jobName.toLowerCase();
          const clientLower = job.clientNameFromLog.toLowerCase();

          // Find parent row by client + job name
          let parentRowIdx = -1;
          for (let ri = 0; ri < delConfirmedRows.length; ri++) {
            const r = delConfirmedRows[ri];
            const rClient = String(r[0] || "").trim().toLowerCase();
            const rJob = String(r[1] || "").trim().toLowerCase();
            if (rClient === clientLower && rJob === jobNameLower) {
              parentRowIdx = ri;
              break;
            }
          }

          if (parentRowIdx === -1) {
            retainerChecks.push({
              jobName: job.jobName,
              clientName: job.clientNameFromLog,
              status: "issue",
              message: `✗ Job "${job.jobName}" (${job.clientNameFromLog}) not found in Confirmed tab`,
              checks: [],
            });
            continue;
          }

          const parentRow = delConfirmedRows[parentRowIdx];
          const parentSheetRow = parentRowIdx + 1;
          const jobClient = String(parentRow[0] || "").trim();
          const jobName2 = String(parentRow[1] || "").trim();
          const projectCode = String(parentRow[2] || "").trim();
          const monthlyRevenue = parseFloat(String(parentRow[32] || "0").replace(/[£$€,\s]/g, "")) || 0;
          const jobStart = String(parentRow[37] || "").trim();
          const jobEnd = String(parentRow[38] || "").trim();

          console.log(`  Found "${job.jobName}" (${job.clientNameFromLog}) at Confirmed row ${parentSheetRow}: start="${jobStart}", end="${jobEnd}"`);

          // Collect child rows (same client + job, no revenue/start/end)
          const childRows = [];
          for (let ri = parentRowIdx + 1; ri < delConfirmedRows.length; ri++) {
            const r = delConfirmedRows[ri];
            const rClient = String(r[0] || "").trim().toLowerCase();
            const rJob = String(r[1] || "").trim().toLowerCase();
            if (rClient !== clientLower || rJob !== jobNameLower) break;
            if (r[32] || r[37] || r[38]) break; // has revenue/start/end = another parent
            childRows.push({ row: r, sheetRow: ri + 1 });
          }

          const checks = [];

          // Parse dates
          const parseDate = (s) => {
            if (!s) return null;
            const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
            const m2 = String(s).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
            if (m2) {
              const yr = m2[3].length === 2 ? 2000 + parseInt(m2[3], 10) : parseInt(m2[3], 10);
              return new Date(yr, months[m2[2]], parseInt(m2[1], 10));
            }
            if (s instanceof Date) {
              if (isNaN(s.getTime())) return null;
              if (s.getFullYear() < 100) s.setFullYear(s.getFullYear() + 2000);
              return s;
            }
            const d = new Date(s);
            if (!isNaN(d.getTime())) {
              if (d.getFullYear() < 100) d.setFullYear(d.getFullYear() + 2000);
              return d;
            }
            return null;
          };

          const startDate = parseDate(jobStart);
          const endDate = parseDate(jobEnd);

          if (!startDate || !endDate) {
            retainerChecks.push({
              jobName: jobName2, clientName: jobClient, projectCode,
              parentSheetRow, status: "info",
              message: `No start/end dates set on this retainer - cannot verify row coverage`,
              checks: [],
            });
            continue;
          }

          // Determine period (monthly by default, infer from child row amounts)
          let periodMonths = 1;
          let periodLabel = "monthly";
          if (childRows.length > 0 && monthlyRevenue > 0) {
            const firstInv = parseFloat(String(childRows[0].row[41] || "").replace(/[£$€,\s]/g, "")) || 0;
            if (firstInv > 0) {
              const ratio = Math.round(firstInv / monthlyRevenue);
              if (ratio >= 2) {
                periodMonths = ratio;
                if (ratio === 3) periodLabel = "quarterly";
                else if (ratio === 6) periodLabel = "6-monthly";
                else if (ratio === 12) periodLabel = "annual";
                else periodLabel = `every ${ratio} months`;
              }
            }
          }

          const parentInvAmt2 = parseFloat(String(parentRow[41] || "").replace(/[£$€,\s]/g, "")) || 0;

          // Rolling 18-month runway: count rows with scheduled date ≤ end of current month
          const parseConfDate = (val) => {
            if (!val) return null;
            if (val instanceof Date) return val;
            const s2 = String(val).trim();
            const months2 = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
            const m3 = s2.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
            if (m3) return new Date(2000 + parseInt(m3[3], 10), months2[m3[2]], parseInt(m3[1], 10));
            const d = new Date(val); return isNaN(d.getTime()) ? null : d;
          };
          const today2 = new Date();
          const endOfCurrentMonth = new Date(today2.getFullYear(), today2.getMonth() + 1, 0);
          endOfCurrentMonth.setHours(23, 59, 59, 999);
          const pastAndCurrentRows = childRows.filter(({ row: cr }) => {
            const sentDate = parseConfDate(cr[43]);
            return sentDate && sentDate <= endOfCurrentMonth;
          }).length;
          const diffTime2 = Math.abs(endDate.getTime() - startDate.getTime());
          const diffDays2 = Math.round(diffTime2 / (1000 * 60 * 60 * 24));
          const monthsDiff = Math.max(1, Math.round(diffDays2 / 30.4375));

          const totalPeriods = Math.ceil(monthsDiff / periodMonths);
          const futurePeriodsInContract = Math.max(0, totalPeriods - pastAndCurrentRows);
          const futureRows = Math.min(18 / periodMonths, futurePeriodsInContract);
          const expectedChildRows = pastAndCurrentRows + futureRows;

          const actualChildRows = childRows.length;
          const fmt = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });

          const durationOk = actualChildRows === expectedChildRows;
          checks.push({ ok: true, message: `Duration: ${fmt(startDate)} → ${fmt(endDate)} (${monthsDiff} months total, ${periodLabel})` });
          checks.push({
            ok: durationOk,
            message: durationOk
              ? `✓ Child rows: ${actualChildRows} found, ${expectedChildRows} expected (${pastAndCurrentRows} past/current + ${futureRows} forward) - correct count`
              : `${actualChildRows > expectedChildRows ? "✗ Too many" : "✗ Too few"} child rows: ${actualChildRows} found, ${expectedChildRows} expected (${pastAndCurrentRows} past/current + ${futureRows} forward)`,
          });

          retainerChecks.push({
            jobName: jobName2, clientName: jobClient, projectCode,
            parentSheetRow, status: durationOk ? "ok" : "issue",
            periodLabel, checks,
          });
        }

        results.push(...retainerChecks);
      }

    } // end retainerInvoicesDeleted

    // ── invoiceStaleUnsentChanges ──────────────────────────────────────
    // Parse AutoLog entries where GAS moved stale unsent invoice dates.
    // Format: "[Confirmed] Stale Invoice - Row N, CLIENT | JOB, Slot N: Date moved X -> Y"
    // Returns one result per stale invoice entry found in the window.
    if (flagType === "invoiceStaleUnsentChanges") {

      const staleLogEntries = autoLogRows.filter(row => {
        const details = String(row[3] || "");
        return details.includes("Stale Invoice");
      });
      console.log(`  ✓ Found ${staleLogEntries.length} stale invoice entries in window`);

      // Fall back to full AutoLog if nothing found in window
      const staleEntriesToUse = staleLogEntries.length > 0 ? staleLogEntries :
        allAutoLogRows.filter(row => String(row[3] || "").includes("Stale Invoice"));
      if (staleLogEntries.length === 0 && staleEntriesToUse.length > 0) {
        console.log(`  ↩ Fell back to full AutoLog - found ${staleEntriesToUse.length} stale entries`);
      }

      if (staleEntriesToUse.length === 0) {
        results.push({
          status: "info",
          message: "No stale invoice entries found in AutoLog since flag was last cleared.",
        });
      } else {
        // Read Confirmed tab for live sheet verification
        const confirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetIdClean,
          range: "Confirmed!A1:CR5000",
        }));
        const confirmedRows = confirmedResp.data.values || [];

        // Each AutoLog row may contain multiple stale invoice lines in col D (details)
        // Parse each line of the form:
        // "[Confirmed] Stale Invoice - Row N, CLIENT | JOB, Slot N: Date moved DD-Mon-YY -> DD-Mon-YY"
        const stalePattern = /\[([^\]]+)\]\s*Stale Invoice\s*[-–]\s*Row\s*(\d+),\s*([^|]+)\|\s*(.+?),\s*Slot\s*(\d+):\s*Date moved\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+)/gi;

        for (const entry of staleEntriesToUse) {
          const details = String(entry[3] || "");
          const timestamp = String(entry[0] || "");
          let match;
          while ((match = stalePattern.exec(details)) !== null) {
            if (targetLine) {
              const normMatch = match[0].replace(/\s+/g, " ").trim();
              const normTarget = targetLine.replace(/\s+/g, " ").trim();
              if (!normMatch.includes(normTarget) && !normTarget.includes(normMatch)) continue;
            }

            const tab = match[1].trim();   // "Confirmed"
            const rowNum = parseInt(match[2].trim(), 10);
            const jobClient = match[3].trim();
            const jobName = match[4].trim();
            const slotNum = parseInt(match[5].trim(), 10);
            const oldDate = match[6].trim();
            const newDate = match[7].trim();

            let isResolved = false;
            let resolutionMsg = "Slot is empty or contains a placeholder.";
            const checks = [];
            let targetSheetRow = null;
            let actualRowNum = rowNum;

            const targetClient = jobClient.trim().toLowerCase();
            const targetJob = jobName.trim().toLowerCase();

            // 1. Try original row
            if (tab === "Confirmed" && rowNum > 0 && rowNum <= confirmedRows.length) {
              const r = confirmedRows[rowNum - 1] || [];
              const rClient = String(r[0] || "").trim().toLowerCase();
              const rJob = String(r[1] || "").trim().toLowerCase();
              if (rClient === targetClient && (rJob === targetJob || rJob.includes(targetJob))) {
                targetSheetRow = r;
              }
            }

            // 2. Fallback search (job moved)
            if (!targetSheetRow && tab === "Confirmed") {
              const matchingRows = [];
              for (let i = 0; i < confirmedRows.length; i++) {
                const r = confirmedRows[i] || [];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob = String(r[1] || "").trim().toLowerCase();
                if (rClient === targetClient && (rJob === targetJob || rJob.includes(targetJob))) {
                  matchingRows.push({ row: r, index: i + 1 });
                }
              }

              if (matchingRows.length === 1) {
                targetSheetRow = matchingRows[0].row;
                actualRowNum = matchingRows[0].index;
              } else if (matchingRows.length > 1) {
                // For multi-row retainers, find the specific child row by checking the date
                const slotCols = { 1: { sent: 43 }, 2: { sent: 50 }, 3: { sent: 57 } }[slotNum];
                let found = false;
                if (slotCols) {
                  const dateMatch = matchingRows.find(m => {
                    const d = String(m.row[slotCols.sent] || "").trim();
                    return d === oldDate || d === newDate;
                  });
                  if (dateMatch) {
                    targetSheetRow = dateMatch.row;
                    actualRowNum = dateMatch.index;
                    found = true;
                  }
                }
                if (!found) {
                  targetSheetRow = matchingRows[0].row;
                  actualRowNum = matchingRows[0].index;
                }
              }
            }

            if (targetSheetRow) {
              const slotCols = {
                1: { ref: 42, sent: 43, status: 45, amt: 41 },
                2: { ref: 49, sent: 50, status: 52, amt: 48 },
                3: { ref: 56, sent: 57, status: 59, amt: 55 },
              }[slotNum];

              if (slotCols) {
                const currentRef = String(targetSheetRow[slotCols.ref] || "").trim();
                const currentSent = String(targetSheetRow[slotCols.sent] || "").trim();
                const currentStatus = String(targetSheetRow[slotCols.status] || "").trim();
                const currentAmt = String(targetSheetRow[slotCols.amt] || "").trim();

                if (currentRef && !isPlaceholderInvoice(currentRef)) {
                  isResolved = true;
                  resolutionMsg = `Slot ${slotNum} now contains a real invoice: #${currentRef} (Sent: ${currentSent || "unknown"}, Status: ${currentStatus || "unknown"}).`;
                  checks.push({ ok: true, message: `✓ Resolved: ${resolutionMsg}` });
                } else if (!currentRef && !currentAmt) {
                  isResolved = true;
                  resolutionMsg = `Slot ${slotNum} is now completely empty (stale placeholder was removed).`;
                  checks.push({ ok: true, message: `✓ Resolved: ${resolutionMsg}` });

                  const otherInvoices = [];
                  [{ s: 1, ref: 42 }, { s: 2, ref: 49 }, { s: 3, ref: 56 }].forEach(idx => {
                    if (idx.s !== slotNum) {
                      const r = String(targetSheetRow[idx.ref] || "").trim();
                      if (r && !isPlaceholderInvoice(r)) {
                        otherInvoices.push(`Slot ${idx.s} (#${r})`);
                      }
                    }
                  });
                  if (otherInvoices.length > 0) {
                    checks.push({ ok: true, message: `ℹ️ Note: Real invoice(s) found in ${otherInvoices.join(" and ")}.` });
                  }
                } else {
                  checks.push({ ok: false, message: `✗ Slot ${slotNum} still contains a placeholder (Ref: ${currentRef || "(blank)"}, Amount: ${currentAmt || "(blank)"}).` });
                }
              } else {
                checks.push({ ok: false, message: `✗ Invalid slot number parsed from log: ${slotNum}` });
              }

              if (actualRowNum !== rowNum) {
                checks.push({ ok: true, message: `ℹ️ Job safely located at row ${actualRowNum} (moved from original row ${rowNum})` });
              }
            } else {
              checks.push({ ok: false, message: `✗ Could not locate job "${jobClient} | ${jobName}" anywhere in the Confirmed tab.` });
            }

            results.push({
              status: isResolved ? "ok" : "issue",
              stale: true,
              tab,
              rowNum: actualRowNum,
              jobClient,
              jobName,
              slotNum: slotNum,
              oldDate,
              newDate,
              logTimestamp: timestamp,
              checks,
              message: isResolved
                ? `[${tab}] Row ${actualRowNum} - ${jobClient} | ${jobName}, Slot ${slotNum}: Alert resolved.`
                : `[${tab}] Row ${actualRowNum} - ${jobClient} | ${jobName}, Slot ${slotNum}: date moved ${oldDate} → ${newDate}.`,
            });
          }
        }

        if (results.length === 0) {
          results.push({
            status: "info",
            message: "Stale invoice entries found in AutoLog but could not be parsed. Check the AutoLog tab manually.",
          });
        } else {
          console.log(`  ✓ Parsed ${results.length} stale invoice entries`);
        }
      }

    } // end invoiceStaleUnsentChanges

    // ── expenseAdded ───────────────────────────────────────────────────
    else if (flagType === "expenseAdded") {
      const addedLogEntries = autoLogRows.filter(row => String(row[3] || "").includes("Created New Row:"));
      const entriesToUse = addedLogEntries.length > 0 ? addedLogEntries : allAutoLogRows.filter(row => String(row[3] || "").includes("Created New Row:"));

      if (entriesToUse.length === 0) {
        results.push({ status: "info", message: "No expense added entries found in AutoLog." });
      } else {
        const outgoingsResp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetIdClean,
          range: "Outgoings!A13:A110",
        }));
        const outgoingsVendors = (outgoingsResp.data.values || []).map(r => String(r[0] || "").trim().toLowerCase());

        // Regex matches: [Outgoings] Created New Row: {Vendor Name} (£{Amount})
        const pattern = /\[Outgoings\] Created New Row:\s+(.+?)\s+\(£([0-9.,]+)\)/gi;

        for (const entry of entriesToUse) {
          const details = String(entry[3] || "");
          const timestamp = String(entry[0] || "");
          let match;
          while ((match = pattern.exec(details)) !== null) {
            if (targetLine) {
              const normMatch = match[0].replace(/\s+/g, " ").trim();
              const normTarget = targetLine.replace(/\s+/g, " ").trim();
              if (!normMatch.includes(normTarget) && !normTarget.includes(normMatch)) continue;
            }

            const desc = match[1].trim();
            const amt = match[2].trim();
            const descLower = desc.toLowerCase();

            const isStillPresent = outgoingsVendors.includes(descLower);
            const isResolved = !isStillPresent;

            results.push({
              status: isResolved ? "ok" : "issue",
              logTimestamp: timestamp,
              checks: [
                {
                  ok: isResolved,
                  message: isResolved
                    ? `✓ Resolved: The vendor "${desc}" is no longer present in the Outgoings tab (Rows 13-110).`
                    : `✗ Issue: The vendor "${desc}" is still present in the Outgoings tab.`
                }
              ],
              message: isResolved
                ? `Vendor "${desc}" no longer exists in Outgoings.`
                : `Vendor "${desc}" remains in Outgoings.`
            });
          }
        }
      }

    } // end expenseAdded

    // ── expenseUnreconGaps ─────────────────────────────────────────────
    // "Stale unreceived expense received date changed"
    // Equivalent to invoiceStaleUnsentChanges, but for expenses.
    // Alerted when stale unreceived expense dates are moved forward by automation.
    // Handles both:
    //   1. Confirmed tab direct expenses:
    //      "[Confirmed] (Stale Expense - )?Row N, CLIENT | JOB, Slot N: Rec Date updated DD-Mon-YY -> DD-Mon-YY"
    //   2. Outgoings tab expenses:
    //      "[Outgoings] (Stale Expense - )?Row N, CONTRACTOR: Updated stale Placeholder/Gap date (Rec: X->Y, Pay: A->B)"
    else if (flagType === "expenseUnreconGaps") {
      const staleLogEntries = autoLogRows.filter(row => {
        const d = String(row[3] || "");
        return d.includes("Rec Date updated") || d.includes("Updated stale Placeholder/Gap date") || d.includes("Stale Expense");
      });

      const entriesToUse = staleLogEntries.length > 0 ? staleLogEntries : allAutoLogRows.filter(row => {
        const d = String(row[3] || "");
        return d.includes("Rec Date updated") || d.includes("Updated stale Placeholder/Gap date") || d.includes("Stale Expense");
      });

      if (entriesToUse.length === 0) {
        results.push({
          status: "info",
          message: "No stale unreceived expense date change entries found in AutoLog.",
        });
      } else {
        let confirmedRows = null;
        let outgoingsRows = null;

        // Pattern for Confirmed direct expenses:
        // "[Confirmed] Row 15, Client | Job, Slot 1: Rec Date updated 05-Jan-26 -> 05-Feb-26"
        // or "[Confirmed] Stale Expense - Row 15, Client | Job, Slot 1: Rec Date updated 05-Jan-26 -> 05-Feb-26"
        const confirmedPattern = /\[Confirmed\]\s*(?:Stale Expense\s*[-–]\s*)?(?:Row\s*(\d+),\s*)?([^|]+)\|\s*([^,\n]+),\s*Slot\s*(\d+):\s*(?:£[0-9.,]+\s*[-–]\s*)?Rec Date updated\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+)/gi;

        // Pattern for Outgoings tab expenses:
        const outgoingsPattern = /\[Outgoings\]\s*(?:(?:[A-Za-z]{3}\s*\d{2}\s*[-–]\s*)?([^:(]+?)(?:\s*\((?:Row\s*)?(\d+)\))?:\s*(?:£[0-9.,]+\s*[-–]\s*)?Updated stale placeholder date(?:\s*[-–]\s*(.+))?|(?:Stale Expense\s*[-–]\s*)?Row\s*(\d+),\s*([^:]+):\s*Updated stale Placeholder\/Gap date\s*\(Rec:\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+),\s*Pay:\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+)\))/gi;

        for (const entry of entriesToUse) {
          const details = String(entry[3] || "");
          const timestamp = String(entry[0] || "");

          // Check Confirmed matches
          let cMatch;
          while ((cMatch = confirmedPattern.exec(details)) !== null) {
            if (targetLine) {
              const normMatch = cMatch[0].replace(/\s+/g, " ").trim();
              const normTarget = targetLine.replace(/\s+/g, " ").trim();
              if (!normMatch.includes(normTarget) && !normTarget.includes(normMatch)) continue;
            }

            const tab = "Confirmed";
            const rowNum = parseInt(cMatch[1].trim(), 10);
            const jobClient = cMatch[2].trim();
            const jobName = cMatch[3].trim();
            const slotNum = parseInt(cMatch[4].trim(), 10);
            const oldDate = cMatch[5].trim();
            const newDate = cMatch[6].trim();

            if (!confirmedRows) {
              const confirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
                spreadsheetId: clientSheetIdClean,
                range: "Confirmed!A1:CR5000",
              }));
              confirmedRows = confirmedResp.data.values || [];
            }

            let isResolved = false;
            let resolutionMsg = "Slot is empty or contains an unreceived placeholder.";
            const checks = [];
            let targetSheetRow = null;
            let actualRowNum = rowNum;

            // 1. Try original row
            if (rowNum > 0 && rowNum <= confirmedRows.length) {
              const r = confirmedRows[rowNum - 1] || [];
              if (String(r[0] || "").trim().toLowerCase() === jobClient.toLowerCase() &&
                String(r[1] || "").trim().toLowerCase() === jobName.toLowerCase()) {
                targetSheetRow = r;
              }
            }

            // 2. Fallback search (job moved)
            if (!targetSheetRow) {
              const matchingRows = [];
              for (let i = 0; i < confirmedRows.length; i++) {
                const r = confirmedRows[i] || [];
                if (String(r[0] || "").trim().toLowerCase() === jobClient.toLowerCase() &&
                  String(r[1] || "").trim().toLowerCase() === jobName.toLowerCase()) {
                  matchingRows.push({ row: r, index: i + 1 });
                }
              }
              if (matchingRows.length === 1) {
                targetSheetRow = matchingRows[0].row;
                actualRowNum = matchingRows[0].index;
              } else if (matchingRows.length > 1) {
                targetSheetRow = matchingRows[0].row;
                actualRowNum = matchingRows[0].index;
              }
            }

            if (targetSheetRow) {
              const headers = (confirmedRows[0] || []).map(h => String(h || "").toLowerCase().trim());
              const findHeaderIdx = (patterns) => {
                for (const pat of patterns) {
                  const idx = headers.indexOf(pat.toLowerCase().trim());
                  if (idx !== -1) return idx;
                }
                return -1;
              };

              const colAppId = findHeaderIdx([`dir inv ${slotNum} app id`, `dir inv. ${slotNum} app id`, `direct inv ${slotNum} app id`]);
              const colAmt = findHeaderIdx([`direct inv ${slotNum} amt`, `direct inv ${slotNum} amount`, `dir inv ${slotNum} amt`]);
              const colRec = findHeaderIdx([`direct inv ${slotNum} rec date`, `dir inv. ${slotNum} rec date`, `dir inv ${slotNum} rec date`]);
              const colStat = findHeaderIdx([`dir inv ${slotNum} status`, `direct inv ${slotNum} status`]);

              const currentId = colAppId !== -1 ? String(targetSheetRow[colAppId] || "").trim() : "";
              const currentAmt = colAmt !== -1 ? String(targetSheetRow[colAmt] || "").trim() : "";
              const currentRec = colRec !== -1 ? String(targetSheetRow[colRec] || "").trim() : "";
              const currentStatus = colStat !== -1 ? String(targetSheetRow[colStat] || "").trim() : "";

              if (currentId && !isPlaceholderExpense(currentId)) {
                isResolved = true;
                resolutionMsg = `Slot ${slotNum} now contains a real expense reference (App ID: ${currentId}${currentStatus ? `, Status: ${currentStatus}` : ""}).`;
                checks.push({ ok: true, message: `✓ Resolved: ${resolutionMsg}` });
              } else if (currentStatus.toLowerCase() === "received" || currentStatus.toLowerCase() === "paid") {
                isResolved = true;
                resolutionMsg = `Slot ${slotNum} is now marked as ${currentStatus}.`;
                checks.push({ ok: true, message: `✓ Resolved: ${resolutionMsg}` });
              } else if (!currentId && !currentAmt) {
                isResolved = true;
                resolutionMsg = `Slot ${slotNum} is now completely empty (stale placeholder was removed).`;
                checks.push({ ok: true, message: `✓ Resolved: ${resolutionMsg}` });
              } else {
                checks.push({
                  ok: false,
                  message: `✗ Slot ${slotNum} still contains an unreceived expense placeholder (Amount: £${currentAmt || "0"}, Rec Date: ${currentRec || newDate}${currentStatus ? `, Status: ${currentStatus}` : ""}).`
                });
              }

              if (actualRowNum !== rowNum) {
                checks.push({ ok: true, message: `ℹ️ Job safely located at row ${actualRowNum} (moved from original row ${rowNum})` });
              }
            } else {
              checks.push({ ok: false, message: `✗ Could not locate job "${jobClient} | ${jobName}" in the Confirmed tab.` });
            }

            results.push({
              status: isResolved ? "ok" : "issue",
              stale: true,
              tab,
              rowNum: actualRowNum,
              jobClient,
              jobName,
              slotNum,
              oldDate,
              newDate,
              logTimestamp: timestamp,
              checks,
              message: isResolved
                ? `[${tab}] Row ${actualRowNum} - ${jobClient} | ${jobName}, Slot ${slotNum}: Alert resolved.`
                : `[${tab}] Row ${actualRowNum} - ${jobClient} | ${jobName}, Slot ${slotNum}: receive date moved ${oldDate} → ${newDate}.`
            });
          }

          // Check Outgoings matches
          let oMatch;
          while ((oMatch = outgoingsPattern.exec(details)) !== null) {
            if (targetLine) {
              const normMatch = oMatch[0].replace(/\s+/g, " ").trim();
              const normTarget = targetLine.replace(/\s+/g, " ").trim();
              if (!normMatch.includes(normTarget) && !normTarget.includes(normMatch)) continue;
            }

            const tab = "Outgoings";
            const parsed = parseStaleExpenseDetail(oMatch[0]);
            const contractor = parsed?.contractor || oMatch[2]?.trim() || "";
            const rowNum = parsed?.rowNum || (oMatch[1] ? parseInt(oMatch[1], 10) : 0);
            let oldRec = "";
            let newRec = "";
            let oldPay = "";
            let newPay = "";
            const changeText = parsed?.changeText || "";
            const recM = changeText.match(/Rec:\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+)/i);
            if (recM) {
              oldRec = recM[1].trim();
              newRec = recM[2].trim();
            }
            const payM = changeText.match(/Pay:\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+)/i);
            if (payM) {
              oldPay = payM[1].trim();
              newPay = payM[2].trim();
            }

            if (!outgoingsRows) {
              const outgoingsResp = await withRetry(() => sheets.spreadsheets.values.get({
                spreadsheetId: clientSheetIdClean,
                range: "Outgoings!A1:AZ300",
              }));
              outgoingsRows = outgoingsResp.data.values || [];
            }

            let isResolved = false;
            const checks = [];
            let actualRowNum = rowNum;
            let targetRow = null;

            // 1. Try original row
            if (rowNum > 0 && rowNum <= outgoingsRows.length) {
              const r = outgoingsRows[rowNum - 1] || [];
              if (String(r[0] || "").trim().toLowerCase() === contractor.toLowerCase()) {
                targetRow = r;
              }
            }

            // 2. Fallback search (contractor moved)
            if (!targetRow) {
              for (let i = 0; i < outgoingsRows.length; i++) {
                const r = outgoingsRows[i] || [];
                if (String(r[0] || "").trim().toLowerCase() === contractor.toLowerCase()) {
                  targetRow = r;
                  actualRowNum = i + 1;
                  break;
                }
              }
            }

            if (targetRow) {
              // Inspect cell notes in that row to check if placeholder is still active
              try {
                const noteResp = await withRetry(() => sheets.spreadsheets.get({
                  spreadsheetId: clientSheetIdClean,
                  ranges: [`Outgoings!A${actualRowNum}:AZ${actualRowNum}`],
                  fields: "sheets(data(rowData(values(note,formattedValue))))",
                }));
                const rowData = noteResp?.data?.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || [];
                let hasUnresolvedPlaceholder = false;
                let foundPlaceholderCount = 0;

                for (const cell of rowData) {
                  const note = String(cell.note || "");
                  if (note.includes("PLACE-EXP") || note.includes("MANUAL-ENTRY") || note.includes("UNRECON-GAP") || note.includes("PLACE-GAP") || note.includes("MANUAL-GAP")) {
                    foundPlaceholderCount++;
                    const statusMatch = note.match(/\{Status:\s*(.*?)\}/i);
                    const status = statusMatch ? statusMatch[1].trim().toLowerCase() : "";
                    if (status !== "paid" && status !== "complete") {
                      hasUnresolvedPlaceholder = true;
                    }
                  }
                }

                if (foundPlaceholderCount === 0) {
                  isResolved = true;
                  checks.push({ ok: true, message: `✓ Resolved: Placeholder was replaced with a real expense or removed.` });
                } else if (!hasUnresolvedPlaceholder) {
                  isResolved = true;
                  checks.push({ ok: true, message: `✓ Resolved: All expense entries for ${contractor} are marked as Paid/Complete.` });
                } else {
                  checks.push({
                    ok: false,
                    message: `✗ Row ${actualRowNum} (${contractor}) still contains unreceived placeholder expense(s) (Rec date moved to ${newRec}, Pay date to ${newPay}).`
                  });
                }
              } catch (e) {
                // Fallback if cell notes call failed
                checks.push({
                  ok: false,
                  message: `ℹ️ Stale date moved: Rec date ${oldRec} → ${newRec}, Pay date ${oldPay} → ${newPay}.`
                });
              }

              if (actualRowNum !== rowNum) {
                checks.push({ ok: true, message: `ℹ️ Contractor located at row ${actualRowNum} (moved from original row ${rowNum})` });
              }
            } else {
              checks.push({ ok: false, message: `✗ Could not locate contractor "${contractor}" in the Outgoings tab.` });
            }

            let msgDates = "";
            if (oldRec && newRec && oldPay && newPay) {
              msgDates = `dates moved (Rec: ${oldRec} → ${newRec}, Pay: ${oldPay} → ${newPay})`;
            } else if (oldRec && newRec) {
              msgDates = `receive date moved ${oldRec} → ${newRec}`;
            } else if (oldPay && newPay) {
              msgDates = `pay date moved ${oldPay} → ${newPay}`;
            } else {
              msgDates = `dates updated`;
            }

            results.push({
              status: isResolved ? "ok" : "issue",
              stale: true,
              tab,
              rowNum: actualRowNum,
              contractor,
              oldRec,
              newRec,
              oldPay,
              newPay,
              logTimestamp: timestamp,
              checks,
              message: isResolved
                ? `[${tab}] Row ${actualRowNum} - ${contractor}: Alert resolved.`
                : `[${tab}] Row ${actualRowNum} - ${contractor}: ${msgDates}.`
            });
          }
        }

        if (results.length === 0) {
          results.push({
            status: "info",
            message: "Stale expense date change entries found in AutoLog but could not be parsed.",
          });
        } else {
          console.log(`  ✓ Parsed ${results.length} stale expense entries`);
        }
      }

    } // end expenseUnreconGaps

    // ── crmCopiedConfDelete ────────────────────────────────────────────────
    // Parse AutoLog entries where jobs were deleted from Confirmed via the
    // "copied to conf box DELETE" action. Then verify:
    //   1. Job is no longer present in Confirmed tab (by project code)
    //   2. Job status in Pipeline tab (% likelihood, copied-to-conf column)
    if (flagType === "crmCopiedConfDelete") {

      // Find AutoLog entries containing deletion records
      const deleteLogEntries = autoLogRows.filter(row => {
        const details = String(row[3] || "");
        return details.includes("Deleted Job:") && details.includes("[Confirmed]");
      });
      console.log(`  ✓ Found ${deleteLogEntries.length} delete log entries in window`);

      // Fall back to full AutoLog if nothing in window
      const deleteEntriesToUse = deleteLogEntries.length > 0 ? deleteLogEntries :
        allAutoLogRows.filter(row => {
          const details = String(row[3] || "");
          return details.includes("Deleted Job:") && details.includes("[Confirmed]");
        });
      if (deleteLogEntries.length === 0 && deleteEntriesToUse.length > 0) {
        console.log(`  ↩ Fell back to full AutoLog - found ${deleteEntriesToUse.length} entries`);
      }

      if (deleteEntriesToUse.length === 0) {
        results.push({
          status: "info",
          message: "No deletion entries found in AutoLog since flag was last cleared.",
        });
      } else {
        // Parse each deletion entry
        // Format: "[Confirmed] Deleted Job: Row N, CLIENT | JOB (ID: CRM-XXXX)"
        const deletedJobs = [];
        const deletePattern = /\[Confirmed\]\s*Deleted Job:\s*Row\s*(\d+),\s*([^|]+)\|\s*([^(\n]+)\(ID:\s*([^)]+)\)/gi;

        for (const entry of deleteEntriesToUse) {
          const details = String(entry[3] || "");
          const timestamp = String(entry[0] || "");
          let match;
          while ((match = deletePattern.exec(details)) !== null) {
            const rowNum = match[1].trim();
            const clientName = match[2].trim();
            const jobName = match[3].trim();
            const projectCode = match[4].trim(); // e.g. "CRM-1576"
            // Deduplicate by project code
            if (!deletedJobs.find(j => j.projectCode === projectCode)) {
              deletedJobs.push({ rowNum, clientName, jobName, projectCode, logTimestamp: timestamp });
            }
          }
        }

        if (deletedJobs.length === 0) {
          results.push({
            status: "info",
            message: "Deletion entries found in AutoLog but could not be parsed. Check the AutoLog tab manually.",
          });
        } else {
          console.log(`  ✓ Parsed ${deletedJobs.length} deleted job(s): ${JSON.stringify(deletedJobs.map(j => j.projectCode))}`);

          // Read Confirmed tab (cols A:C = client, job, project code)
          const confirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId: clientSheetIdClean,
            range: "Confirmed!A1:C5000",
          }));
          const confirmedRows = confirmedResp.data.values || [];

          // Read Pipeline tab (cols A:C for lookup, AN for % likelihood, DD for copied status)
          // DD = col 110 (0-indexed), AN = col 39 (0-indexed)
          const pipelineResp = await withRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId: clientSheetIdClean,
            range: "Pipeline!A1:DD5000",
          }));
          const pipelineRows = pipelineResp.data.values || [];

          for (const job of deletedJobs) {
            const checks = [];
            const jobClientLower = job.clientName.toLowerCase();
            const jobNameLower = job.jobName.toLowerCase();
            const projectCodeLower = job.projectCode.toLowerCase();

            // ── Check 1: Confirmed tab ──────────────────────────────────
            // Search by project code (col C = index 2), fallback client+job (cols A+B)
            let confirmedRowIdx = -1;
            for (let ri = 1; ri < confirmedRows.length; ri++) {
              const r = confirmedRows[ri] || [];
              const pc = String(r[2] || "").trim().toLowerCase();
              if (pc === projectCodeLower) { confirmedRowIdx = ri; break; }
            }
            // Fallback: client + job name
            if (confirmedRowIdx === -1) {
              for (let ri = 1; ri < confirmedRows.length; ri++) {
                const r = confirmedRows[ri] || [];
                const rc = String(r[0] || "").trim().toLowerCase();
                const rj = String(r[1] || "").trim().toLowerCase();
                if (rc === jobClientLower && rj === jobNameLower) { confirmedRowIdx = ri; break; }
              }
            }

            if (confirmedRowIdx === -1) {
              checks.push({ ok: true, message: `✓ Not found in Confirmed tab - job successfully removed` });
            } else {
              checks.push({ ok: false, message: `✗ Job still exists in Confirmed tab at row ${confirmedRowIdx + 1} - deletion may have failed` });
            }

            // ── Check 2: Pipeline tab ───────────────────────────────────
            // Search by project code (col C = index 2), fallback client+job
            let pipelineRowIdx = -1;
            for (let ri = 1; ri < pipelineRows.length; ri++) {
              const r = pipelineRows[ri] || [];
              const pc = String(r[2] || "").trim().toLowerCase();
              if (pc === projectCodeLower) { pipelineRowIdx = ri; break; }
            }
            if (pipelineRowIdx === -1) {
              for (let ri = 1; ri < pipelineRows.length; ri++) {
                const r = pipelineRows[ri] || [];
                const rc = String(r[0] || "").trim().toLowerCase();
                const rj = String(r[1] || "").trim().toLowerCase();
                if (rc === jobClientLower && rj === jobNameLower) { pipelineRowIdx = ri; break; }
              }
            }

            if (pipelineRowIdx === -1) {
              checks.push({ ok: false, message: `⚠ Job not found in Pipeline tab - notable, as deleted Confirmed jobs are usually still in Pipeline` });
            } else {
              const pipeRow = pipelineRows[pipelineRowIdx];
              // AN = col 39 (0-indexed), DD = col 109 (0-indexed)
              // DD is col 110 in 1-indexed: D=4, D=4 → 4*26+4=108? Let me recalculate:
              // A=1...Z=26, AA=27...AZ=52, BA=53...DD=?
              // D=4, D=4: (4-1)*26 + 4 = 82? No: col letter to number:
              // DD: first D=4, second D=4 → (4)*26 + 4 = 108 (1-indexed) → index 107
              // AN: A=1, N=14 → 1*26+14 = 40 (1-indexed) → index 39
              const likelihood = String(pipeRow[39] || "").trim();   // AN
              const copiedStatus = String(pipeRow[107] || "").trim(); // DD
              checks.push({
                ok: true,
                message: `Job found in Pipeline tab at row ${pipelineRowIdx + 1}` +
                  ` - likelihood: ${likelihood || "(blank)"}` +
                  `, "Copied to conf?" = ${copiedStatus || "(blank)"}`,
              });
            }

            results.push({
              status: checks.every(c => c.ok) ? "ok" : "issue",
              jobName: job.jobName,
              clientName: job.clientName,
              projectCode: job.projectCode,
              confirmedRow: parseInt(job.rowNum, 10),
              logTimestamp: job.logTimestamp,
              checks,
              message: `${job.clientName} | ${job.jobName} (${job.projectCode}) - deleted from Confirmed row ${job.rowNum}`,
            });
          }
        }
      }

    } // end crmCopiedConfDelete

    const overallOk = results.every(r => r.status === "ok" || r.status === "info");
    console.log(`  ✅ Analysis complete: ${results.length} items, overall ${overallOk ? "OK" : "ISSUES FOUND"}`);
    return res.status(200).json({ success: true, flagType, results, overallOk });

  } catch (err) {
    console.error(`❌ Error analyzing non-actionable flag:`, err);
    return res.status(500).json({ success: false, error: `Analysis failed: ${err.message}` });
  }
}

// ============================================================================
// LOCAL HELPER FUNCTIONS
// ============================================================================

export function fuzzyClientMatch_(nameA, nameB) {
  if (!nameA || !nameB) return false;
  const clean = s => String(s).toLowerCase().replace(/['"\-.,()/#]/g, " ").replace(/\s+/g, " ").trim();
  const a = clean(nameA);
  const b = clean(nameB);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const NOISE = new Set(["ltd", "limited", "plc", "inc", "llc", "llp", "the", "and", "&", "group", "co", "corp", "corporation"]);
  const wordsA = a.split(" ").filter(w => w.length > 1 && !NOISE.has(w));
  const wordsB = b.split(" ").filter(w => w.length > 1 && !NOISE.has(w));

  if (wordsA.length === 0 || wordsB.length === 0) return false;
  return wordsA.some(w => wordsB.includes(w)) || wordsB.some(w => wordsA.includes(w));
}

export function parseSheetOrJsDate_(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const s = String(val).trim();

  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mIdx = months[m[2].toLowerCase()];
    if (mIdx === undefined) return null;
    const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    return new Date(yr, mIdx, parseInt(m[1], 10));
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function monthsWithinTolerance_(date1, date2, toleranceMonths) {
  if (!date1 || !date2) return false;
  const m1 = date1.getFullYear() * 12 + date1.getMonth();
  const m2 = date2.getFullYear() * 12 + date2.getMonth();
  return Math.abs(m1 - m2) <= Math.max(0, toleranceMonths);
}

// ============================================================================
// SWEEP & LOGGING HELPER FUNCTIONS
// ============================================================================

const SWEEP_SCHEDULE_TAB = "SweepSchedule";
const SWEEP_SCHEDULE_DEFAULTS = { actionable: 30, info: 60, proactive: 1440 };

async function ensureSweepScheduleTab(sheets, automationCommanderSheetId) {
  return;
}

// Returns { actionable: { rowIndex, frequencyMinutes, lastCheckedAt }, info: {...}, proactive: {...} }
// Missing categories (e.g. a row deleted by hand) fall back to defaults with
// no rowIndex - isCategoryDue_ below treats that as "always due" rather than
// throwing, and the caller can decide whether to also re-create the row.
async function readSweepSchedule_(sheets, automationCommanderSheetId) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: automationCommanderSheetId,
    range: `${SWEEP_SCHEDULE_TAB}!A2:C10`,
  });
  const rows = resp.data.values || [];
  const schedule = {};
  rows.forEach((row, i) => {
    const category = String(row[0] || "").trim().toLowerCase();
    if (!category) return;
    schedule[category] = {
      rowIndex: i + 2,
      frequencyMinutes: parseInt(row[1], 10) || SWEEP_SCHEDULE_DEFAULTS[category] || 30,
      lastCheckedAt: row[2] || "",
    };
  });
  for (const category of Object.keys(SWEEP_SCHEDULE_DEFAULTS)) {
    if (!schedule[category]) {
      schedule[category] = { rowIndex: null, frequencyMinutes: SWEEP_SCHEDULE_DEFAULTS[category], lastCheckedAt: "" };
    }
  }
  return schedule;
}

// True if this category's configured interval has elapsed since it was last
// checked (or has never been checked at all). A missing/unparseable
// lastCheckedAt is treated as "always due" - safer than silently never
// running a category because of a malformed timestamp.
function isCategoryDue_(categoryEntry) {
  if (!categoryEntry.lastCheckedAt) return true;
  const last = new Date(categoryEntry.lastCheckedAt);
  if (isNaN(last.getTime())) return true;
  const elapsedMinutes = (Date.now() - last.getTime()) / 60000;
  return elapsedMinutes >= categoryEntry.frequencyMinutes;
}

// Updates lastCheckedAt for one category - creates the row if it doesn't
// exist yet (e.g. schedule tab was just created, or a row was deleted by
// hand), rather than silently failing to persist the timestamp.
async function markCategoryChecked_(sheets, automationCommanderSheetId, category, schedule) {
  const nowISO = new Date().toISOString();
  const entry = schedule[category];
  if (entry && entry.rowIndex) {
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: automationCommanderSheetId,
      range: `${SWEEP_SCHEDULE_TAB}!C${entry.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[nowISO]] },
    }));
  } else {
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${SWEEP_SCHEDULE_TAB}!A:C`,
      valueInputOption: "RAW",
      requestBody: { values: [[category, (entry && entry.frequencyMinutes) || SWEEP_SCHEDULE_DEFAULTS[category] || 30, nowISO]] },
    }));
  }
}

async function ensureClaudeUsageTab_(sheets, automationCommanderSheetId) {
  return; // Safe stub to prevent crashes if this was also orphaned
}

// Log a Claude API call directly to ClaudeUsage tab
export async function logClaudeUsage_(sheets, automationCommanderSheetId, clientName, alertType, inputTokens, outputTokens, source) {
  if (!automationCommanderSheetId) return;
  const acIdClean = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;
  await ensureClaudeUsageTab_(sheets, acIdClean);
  const costUsd = ((inputTokens || 0) / 1000000 * 3) + ((outputTokens || 0) / 1000000 * 15);
  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: acIdClean,
    range: "ClaudeUsage!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        new Date().toISOString(),
        source || "precompute",
        clientName || "",
        alertType || "",
        (inputTokens || 0) + (outputTokens || 0),
        costUsd.toFixed(6),
      ]],
    },
  }));
  console.log(`  📊 Logged Claude usage: ${clientName} ${alertType} - ${inputTokens}+${outputTokens} tokens, $${costUsd.toFixed(4)}`);
}

export async function handleCheckOutgoingsCell(req, res, sheets) {
  const { clientSheetId, categoryName, expenseMonth, expenseDate, amount } = req.body;
  if (!clientSheetId || !categoryName) {
    return res.status(400).json({ success: false, error: "Missing clientSheetId or categoryName" });
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const ym = parseYearMonth(expenseMonth || expenseDate);
    if (!ym) {
      return res.status(400).json({ success: false, error: `Could not parse expense month: "${expenseMonth || expenseDate}"` });
    }

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Outgoings!A1:AX115",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    if (rows.length === 0) return res.status(200).json({ success: false, error: "Outgoings tab is empty" });

    const headerRow = rows[0] || [];
    let targetColIndex = -1;
    for (let c = 0; c < headerRow.length; c++) {
      const headerVal = headerRow[c];
      if (headerVal === null || headerVal === undefined || headerVal === "") continue;
      let parsedYM = null;
      if (typeof headerVal === "number") {
        const d = new Date((headerVal - 25569) * 86400 * 1000);
        if (!isNaN(d.getTime())) {
          parsedYM = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
        }
      } else {
        parsedYM = parseYearMonth(headerVal);
      }
      if (parsedYM && parsedYM.year === ym.year && parsedYM.month === ym.month) {
        targetColIndex = c;
        break;
      }
    }

    if (targetColIndex === -1) {
      return res.status(200).json({ success: true, found: false, error: `Month column not found for ${ym.year}-${String(ym.month).padStart(2, "0")}` });
    }

    const categoryLower = categoryName.toLowerCase().trim();
    let targetRowIndex = -1;
    for (let r = 12; r <= Math.min(109, rows.length - 1); r++) {
      const rowVendorName = String(rows[r][0] || "").toLowerCase().trim();
      if (rowVendorName === categoryLower) {
        targetRowIndex = r;
        break;
      }
    }

    if (targetRowIndex === -1) {
      return res.status(200).json({ success: true, found: false, isNewVendor: true });
    }

    const sheetRow = targetRowIndex + 1;
    const sheetCol = targetColIndex + 1;
    const colLetter = (() => {
      let col = sheetCol;
      let letter = "";
      while (col > 0) {
        const r = (col - 1) % 26;
        letter = String.fromCharCode(65 + r) + letter;
        col = Math.floor((col - 1) / 26);
      }
      return letter;
    })();

    const cellA1 = `Outgoings!${colLetter}${sheetRow}`;
    const cellResp = await sheets.spreadsheets.get({
      spreadsheetId: sheetIdClean,
      ranges: [cellA1],
      fields: "sheets(data(rowData(values(userEnteredValue,note))))",
    });

    const cellData = cellResp.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0];
    const existingValueRaw = cellData?.userEnteredValue?.numberValue
      ?? cellData?.userEnteredValue?.stringValue
      ?? 0;
    const existingNote = cellData?.note || "";
    const existingValue = parseFloat(existingValueRaw) || 0;

    const parseNoteParts = (note) => {
      if (!note) return { topNote: "", blocks: [] };
      const firstBlockIdx = note.indexOf("{App ID:");
      let topNote = "";
      let blockText = "";
      if (firstBlockIdx !== -1) {
        topNote = note.substring(0, firstBlockIdx).trim();
        blockText = note.substring(firstBlockIdx);
      } else if (note.includes("{") && note.includes("}")) {
        blockText = note;
      } else {
        topNote = note.trim();
      }

      const blocks = [];
      const blockRegex = /\{App ID:\s*([^}]+)\}\{Amt:\s*([^}]+)\}(?:\{Status:\s*([^}]*)\})?(?:\{Rec date:\s*([^}]*)\})?(?:\{Pay date:\s*([^}]*)\})?(?:\{Description:\s*([^}]*)\})?/g;
      let match;
      while ((match = blockRegex.exec(blockText)) !== null) {
        blocks.push({
          appId: match[1]?.trim() || "",
          amount: parseFloat(String(match[2] || "").replace(/[£$€,\s]/g, "")) || 0,
          status: match[3]?.trim() || "",
          recDate: match[4]?.trim() || "",
          payDate: match[5]?.trim() || "",
          description: match[6]?.trim() || "",
        });
      }
      return { topNote, blocks };
    };

    const { topNote, blocks } = parseNoteParts(existingNote);
    const placeholderBlocks = blocks.filter(b => isPlaceholderExpense(b.appId, b.description, b.status));
    const totalManual = placeholderBlocks.reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);
    const expenseAmt = parseFloat(amount) || 0;
    const canUseUp = totalManual > 0 && expenseAmt <= totalManual + 0.001;

    const monthDateObj = new Date(ym.year, ym.month - 1, 1);
    const monthLabel = monthDateObj.toLocaleString("en-GB", { month: "short", year: "2-digit" });

    return res.status(200).json({
      success: true,
      found: true,
      sheetRow,
      colLetter,
      monthLabel,
      existingValue,
      topNote,
      allBlocks: blocks,
      placeholderBlocks,
      totalManual,
      canUseUp
    });
  } catch (err) {
    console.error("❌ check_outgoings_cell error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}