/**
 * PHASE 2: ALERT TRIAGE SYSTEM
 * Backend API for analyzing financial automation alerts
 * 
 * Correctly implements:
 * - Flag columns in row 2 of AutoUpdates (CW, DD, DK, etc.)
 * - Client URLs in columns L & M (row 3 onwards)
 * - Comparison sheet data starts at row 6
 * - CRMComp mode toggle based on which flags are raised
 * - Proper column ranges for each alert type
 */

import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { createClient } from "redis";
import { createHash } from "crypto";

const anthropic = new Anthropic();

// Create Redis client for session storage
const redisClient = createClient({
  url: process.env.REDIS_URL,
});

redisClient.connect().catch(console.error);

// Caches whether ensureEomTabs_ has already verified the EoM tabs exist on
// this warm serverless instance — once true, it can never become false
// again (nothing in this app deletes these tabs or un-patches the header),
// so re-checking on every single EoM action call was pure wasted quota.
// Reset naturally on cold start, which is exactly the one case where a
// fresh check is actually needed. See conversation 19 Aug 2026 — this was
// contributing meaningfully to hitting Google's 60-reads/minute-per-user
// quota during normal EoM screen use.
let eomTabsVerified = false;

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================
// FLAG_COLUMNS/NO_ACTION_FLAGS retired 24 Aug 2026 — both were only used by
// the old start_triage implementation (AutoUpdates sticky-column-based),
// which has been fully replaced by a thin orchestrator that reuses
// run_flag_sweep/build_cached_alert_options/store_precomputed instead.

// Precomputed triage data — stored by cron job, consumed by frontend on Start
const PRECOMPUTED_KEY = "triage_precomputed";
const PRECOMPUTED_MAX_AGE_MS = 240 * 60 * 1000; // 4 hours - prevents frontend from auto-triggering timeouts

const FLAG_NAMES = {
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
  expenseUnreconGaps: "Expense unrecon gaps",
  invoiceStaleUnsentChanges: "Invoice stale unsent changes",
};

// Column offsets within a DataChgAlert!AF2:BG2 read (0 = column AF), per
// Paul's exact cell list (21 Aug 2026) — computed programmatically, not
// ============================================================================
// API RETRY WRAPPER
// ============================================================================
async function withRetry(operation, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (error.code === 429 && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 2000 + Math.random() * 1000;
        console.log(`  ⏳ 429 Quota Exceeded. Retrying in ${Math.round(delay/1000)}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
}

// ============================================================================
// ALERT MEMORY — fingerprinting, caching, ignore management
// ============================================================================
const ALERT_MEMORY_TAB = "AlertMemory";
const ALERT_MEMORY_RANGE = `${ALERT_MEMORY_TAB}!A:L`;
const ALERT_MEMORY_MAX_AGE_MONTHS = 12;
const PROACTIVE_CHECK_LOG_TAB = "ProactiveCheckLog";
const FLAG_SWEEP_LOG_TAB = "FlagSweepLog";
const PRECOMPUTE_LOG_TAB = "PrecomputeLog";
const BUILD_OPTIONS_LOG_TAB = "BuildOptionsLog";

/**
/**
 * Normalise a value for fingerprinting — ensures dates are always in DD-Mon-YY format
 * regardless of whether they came from the Sheets API (4-digit year) or GAS (2-digit year).
 */
function normaliseForFingerprint(val) {
  if (typeof val !== "string") return String(val ?? "");
  // Match D-Mon-YY or DD-Mon-YY (with or without zero-padded day, 2 or 4-digit year)
  const m = val.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (m) {
    const day  = m[1].padStart(2, "0");
    const mon  = m[2];
    const year = m[3].length === 4 ? m[3].slice(-2) : m[3];
    return `${day}-${mon}-${year}`;
  }
  // Normalise percentage strings to match what GAS produces via String(rawNumber).
  // FORMATTED_VALUE returns "100%", "0%", "75%" etc. while GAS getValues() returns
  // the raw decimal (1, 0, 0.75) which String() converts to "1", "0", "0.75".
  if (/^\d+(\.\d+)?%$/.test(val)) {
    return String(Number(val.slice(0, -1)) / 100);
  }
  // Normalise formatted numeric strings to match what GAS produces via String(rawNumber).
  // The Sheets REST API with FORMATTED_VALUE returns numbers with currency symbols and
  // thousand-separator commas (e.g. "£0.00", "13,325.00") while GAS getValues() returns
  // raw JS numbers which String() converts without either (e.g. "0", "13325").
  // Strip currency prefix and commas, then parse and re-stringify to canonical form.
  const stripped = val.replace(/^[£$€]/, "").replace(/,/g, "").trim();
  if (stripped !== "" && !isNaN(Number(stripped))) {
    return String(Number(stripped));
  }
  return val;
}

function normaliseArrayForFingerprint(arr) {
  return (arr || []).map(v => normaliseForFingerprint(String(v ?? "")));
}

/**
 * Build a stable 16-char hex fingerprint from an alert's data fields.
 * Includes accounting data, comparison data, flags, and alert type so that
 * ANY change in source, comparison, or discrepancy flags produces a new hash.
 */
function buildAlertFingerprint(alert) {
  const parts = [];

  // Always include the alert type to namespace CRM variants
  parts.push(alert.type || "");
  parts.push(alert.flagType || alert.alertType || "");

  if (alert.data) {
    // Normalise all arrays before hashing to ensure date format consistency.
    // The Sheets API returns dates as DD-Mon-YYYY (4-digit year) but GAS
    // valuesToStrings_ returns DD-Mon-YY (2-digit year). Without normalisation,
    // the same alert produces different fingerprints depending on which path
    // built it, breaking the ignore/supersede logic.
    if (alert.data.accounting) parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.accounting)));
    if (alert.data.confirmed)  parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.confirmed)));
    if (alert.data.crmData)    parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.crmData)));
    if (alert.data.sheetData)  parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.sheetData)));
    if (alert.data.flags)      parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.flags)));
  }

  const raw = parts.join("|");
  return createHash("sha256").update(raw).digest("hex").substring(0, 16);
}

/**
 * Read all rows from AlertMemory tab.
 * Returns array of objects with all column fields.
 */
async function readAlertMemory(sheets, automationCommanderSheetId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: ALERT_MEMORY_RANGE,
    });
    const rows = response.data.values || [];
    if (rows.length < 2) return []; // header only or empty

    return rows.slice(1).map((row, i) => ({
      rowIndex: i + 2, // 1-indexed sheet row (row 1 = header)
      fingerprintHash:  row[0] || "",
      alertType:        row[1] || "",
      clientName:       row[2] || "",
      alertSummary:     row[3] || "",
      cachedOptionsJSON:row[4] || "",
      status:           row[5] || "cached",
      ignoreReason:     row[6] || "",
      firstSeen:        row[7] || "",
      lastSeen:         row[8] || "",
      lastRechecked:    row[9] || "",
      dataSnapshot:     row[10] || "",
      // Added 22 Aug 2026 for the unified alert-system redesign — every row
      // written before this column existed genuinely is a "discrepancy"
      // type (invoice/expense/CRM), so that's the correct default rather
      // than an empty/unknown value.
      category:         row[11] || "discrepancy",
    }));
  } catch (err) {
    console.log(`⚠️ Could not read AlertMemory tab: ${err.message}`);
    return [];
  }
}

/**
 * Set of fingerprint hashes already "handled" in AlertMemory — ignored,
 * task, superseded, or accepted. "Cached" is deliberately NOT handled: it
 * means the alert exists but hasn't been triaged yet, so it should still
 * count as new. Extracted from the check_new_fingerprints action (21 Aug
 * 2026) so run_flag_sweep can reuse the exact same definition of "handled"
 * directly, in-process, rather than a third copy or a wasteful self-call.
 */
function getHandledFingerprintHashes_(memoryRows) {
  return new Set(
    memoryRows
      .filter(r => r.status === "ignored" || r.status === "task" || r.status === "superseded" || r.status === "accepted" || r.status === "pending_automation")
      .map(r => r.fingerprintHash)
      .filter(Boolean)
  );
}

/**
 * Ensure the AlertMemory tab exists with a header row.
 * Safe to call on every run — does nothing if tab already exists.
 */
async function ensureAlertMemoryTab(sheets, automationCommanderSheetId) {
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${ALERT_MEMORY_TAB}!A1`,
    });
    // Tab exists — but may predate the "category" column (added 22 Aug 2026
    // as part of the unified alert-system redesign, appended at the end so
    // existing column positions for Paul's already-live tab aren't
    // disturbed). Check L1 specifically and backfill the header if missing.
    try {
      const l1 = await sheets.spreadsheets.values.get({
        spreadsheetId: automationCommanderSheetId,
        range: `${ALERT_MEMORY_TAB}!L1`,
      });
      const hasCategoryHeader = (l1.data.values || [])[0]?.[0];
      if (!hasCategoryHeader) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: automationCommanderSheetId,
          range: `${ALERT_MEMORY_TAB}!L1`,
          valueInputOption: "RAW",
          requestBody: { values: [["category"]] },
        });
        console.log(`✅ Backfilled "category" header on existing AlertMemory tab`);
      }
    } catch (backfillErr) {
      console.log(`⚠️ Could not check/backfill category header: ${backfillErr.message}`);
    }
  } catch (err) {
    // Tab doesn't exist — create it
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: automationCommanderSheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: ALERT_MEMORY_TAB } } }],
        },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId,
        range: `${ALERT_MEMORY_TAB}!A1:L1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            "fingerprintHash", "alertType", "clientName", "alertSummary",
            "cachedOptionsJSON", "status", "ignoreReason", "firstSeen", "lastSeen",
            "lastRechecked", "dataSnapshot", "category",
          ]],
        },
      });
      console.log(`✅ Created AlertMemory tab`);
    } catch (createErr) {
      console.log(`⚠️ Could not create AlertMemory tab: ${createErr.message}`);
    }
  }
}

/**
 * Look up a single alert in the memory by fingerprint hash.
 * Returns the MOST RECENTLY SEEN row if multiple rows share the same hash.
 */
function findMemoryRow(memoryRows, fingerprintHash) {
  const matches = memoryRows.filter(r => r.fingerprintHash === fingerprintHash);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Multiple rows with same fingerprint — prefer by status priority:
  // handled statuses (ignored, accepted, task) > cached > superseded
  // Within same priority tier, prefer most recent lastSeen
  const priority = (status) => {
    if (status === "ignored" || status === "accepted" || status === "task") return 3;
    if (status === "cached") return 2;
    return 1; // superseded
  };
  return matches.sort((a, b) => {
    const pd = priority(b.status) - priority(a.status);
    if (pd !== 0) return pd;
    return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
  })[0];
}

/**
 * Extract identity + comparable field values from a CRM discrepancy alert's raw
 * comparison data. Column layout (confirmed against the live CRMComp tab, 11 Aug 2026):
 *   Dash discrepancy (crmPipeDashDiscr / crmConfDashDiscr):
 *     crmData starts at X:    Client=0, Job=1, ProjectCode=2, Revenue=3, DirectCosts=4,
 *                              StartDate=5, EndDate=6, Likelihood=7
 *     sheetData starts at AO: ProjectCode=0, Client=1, Job=2, Revenue=3, DirectCosts=4,
 *                              StartDate=5, EndDate=6, Likelihood=7
 *   App discrepancy (crmPipeAppDiscr / crmConfAppDiscr):
 *     sheetData starts at EF: Client=0, Job=1, ProjectCode=2, Revenue=3, DirectCosts=4,
 *                              StartDate=5, EndDate=6, Likelihood=7
 *     crmData starts at EU:   ProjectCode=0, Client=1, Job=2, Revenue=3, DirectCosts=4,
 *                              StartDate=5, EndDate=6, Likelihood=7
 * Revenue/DirectCosts/StartDate/EndDate/Likelihood sit at the same relative indices
 * (3-7) on both sides, in both variants — only Client/Job/ProjectCode order differs.
 * Falls back to the other side's Client/Job when the primary side is blank — this is
 * the "not_found" case, where the job genuinely doesn't exist on one side.
 * Returns { clientName, jobName, fields } or null (end client, not the agency client).
 * fields is keyed by field name, each holding raw { crm, dashboard } values.
 */
function extractCrmComparisonSnapshot(alert) {
  if (!alert || alert.type !== "crm" || !alert.data) return null;
  const { crmData, sheetData } = alert.data;
  if (!crmData || !sheetData) return null;

  const variant = alert.alertType || alert.flagType || "";
  const isDash = variant === "crmPipeDashDiscr" || variant === "crmConfDashDiscr";
  const isApp  = variant === "crmPipeAppDiscr"  || variant === "crmConfAppDiscr";
  if (!isDash && !isApp) return null;

  const clean = v => (v === null || v === undefined ? "" : String(v)).trim();

  let primaryClient, primaryJob, fallbackClient, fallbackJob;
  if (isDash) {
    primaryClient  = clean(crmData[0]);   primaryJob  = clean(crmData[1]);
    fallbackClient = clean(sheetData[1]); fallbackJob = clean(sheetData[2]);
  } else {
    primaryClient  = clean(sheetData[0]); primaryJob  = clean(sheetData[1]);
    fallbackClient = clean(crmData[1]);   fallbackJob = clean(crmData[2]);
  }

  const jobName    = primaryJob || fallbackJob;
  const clientName = primaryClient || fallbackClient;
  if (!jobName) return null;

  // Revenue/DirectCosts/StartDate/EndDate/Likelihood sit at the same relative
  // indices (3-7) on both sides, for both Dash and App variants.
  const FIELD_INDEX = [
    { key: "revenue",     idx: 3 },
    { key: "directCosts", idx: 4 },
    { key: "startDate",   idx: 5 },
    { key: "endDate",     idx: 6 },
    { key: "likelihood",  idx: 7 },
  ];
  const fields = {};
  for (const f of FIELD_INDEX) {
    fields[f.key] = { crm: clean(crmData[f.idx]), dashboard: clean(sheetData[f.idx]) };
  }

  return { clientName, jobName, fields };
}

/**
 * Find any previous ignore reason for an alert that has since been superseded.
 * Matches superseded rows by client name + alert type + key identifier —
 * invoice number/reference for invoice/expense alerts, or discrepancy variant
 * (flagType) + end-client/job name for CRM alerts, which have neither.
 * Returns { ignoreReason, changeReason } or null if not found.
 * changeReason explains WHY the alert resurfaced (what changed vs what was ignored).
 */
async function findPreviousIgnoreReason(memoryRows, alert) {
  try {
    const supersededRows = memoryRows
      .filter(r => r.status === "superseded" && r.ignoreReason)
      .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
    if (supersededRows.length === 0) return null;

    const alertClient = (alert.clientName || "").toLowerCase().trim();
    const alertType   = (alert.type || alert.flagType || "").toLowerCase();
    const alertInvNo  = (alert.summary?.invoiceNo || "").trim();
    const alertRef    = (alert.summary?.reference || "").trim();

    // CRM alerts have no invoice number/reference — build the job-identity match key instead.
    const alertFlagType = (alert.flagType || alert.alertType || "").trim();
    const crmIdentity    = alertType === "crm" ? extractCrmComparisonSnapshot(alert) : null;

    for (const row of supersededRows) {
      if ((row.clientName || "").toLowerCase().trim() !== alertClient) continue;
      if ((row.alertType || "").toLowerCase() !== alertType) continue;

      let matched = false;
      let snap = null;

      // Try to match by invoice number or reference from dataSnapshot
      if (row.dataSnapshot) {
        try {
          snap = JSON.parse(row.dataSnapshot);
          const snapInvNo = (snap.invoiceNo || "").trim();
          const snapRef   = (snap.reference || "").trim();
          if (alertInvNo && snapInvNo && snapInvNo === alertInvNo) matched = true;
          if (alertRef   && snapRef   && snapRef   === alertRef)   matched = true;

          // CRM alerts: match on the specific discrepancy variant (flagType) plus job
          // identity (end client + job name extracted from the raw comparison data).
          if (!matched && alertType === "crm" && crmIdentity && crmIdentity.jobName) {
            const snapFlagType  = (snap.flagType || "").trim();
            const snapJobName   = (snap.crmJobName || "").toLowerCase().trim();
            const snapEndClient = (snap.crmEndClient || "").toLowerCase().trim();
            const jobMatches    = snapJobName && snapJobName === crmIdentity.jobName.toLowerCase().trim();
            const clientMatches = !crmIdentity.clientName || !snapEndClient
              || snapEndClient === crmIdentity.clientName.toLowerCase().trim();
            if (alertFlagType && snapFlagType && alertFlagType === snapFlagType && jobMatches && clientMatches) {
              matched = true;
            }
          }
        } catch (e) { /* ignore parse errors */ }
      }

      // Fallback: match by alert summary substring
      if (!matched) {
        if (alertInvNo && (row.alertSummary || "").includes(alertInvNo)) matched = true;
        if (alertRef   && (row.alertSummary || "").includes(alertRef))   matched = true;
      }

      if (!matched) continue;

      // Build changeReason by comparing snapshot values to current alert values
      let changeReason = null;
      try {
        if (snap && Object.keys(snap).length > 0) {
          const changes = [];

          // Amount comparison
          const snapAmt    = parseFloat(String(snap.amount || "").replace(/[£$€,]/g, "")) || null;
          const currentAmt = parseFloat(String(alert.summary?.amount || "").replace(/[£$€,]/g, "")) || null;
          if (snapAmt !== null && currentAmt !== null && Math.abs(snapAmt - currentAmt) > 0.005) {
            changes.push(`amount changed from £${snapAmt.toFixed(2)} to £${currentAmt.toFixed(2)}`);
          }

          // VAT amount comparison
          const snapVAT    = parseFloat(String(snap.vatIncluded || "").replace(/[£$€,]/g, "")) || null;
          const currentVAT = parseFloat(String(alert.summary?.vatIncluded || "").replace(/[£$€,]/g, "")) || null;
          if (snapVAT !== null && currentVAT !== null && Math.abs(snapVAT - currentVAT) > 0.005) {
            changes.push(`VAT changed from £${snapVAT.toFixed(2)} to £${currentVAT.toFixed(2)}`);
          }

          // Status comparison
          const snapStatus    = (snap.status || "").trim();
          const currentStatus = (alert.summary?.status || "").trim();
          if (snapStatus && currentStatus && snapStatus !== currentStatus) {
            changes.push(`status changed from "${snapStatus}" to "${currentStatus}"`);
          }

          // Sent date comparison
          const snapSent    = (snap.sentDate || "").trim();
          const currentSent = (alert.summary?.sentDate || "").trim();
          if (snapSent && currentSent && snapSent !== currentSent) {
            changes.push(`sent date changed from "${snapSent}" to "${currentSent}"`);
          }

          // Date paid comparison
          const snapPaid    = (snap.datePaid || "").trim();
          const currentPaid = (alert.summary?.datePaid || "").trim();
          if (snapPaid && currentPaid && snapPaid !== currentPaid) {
            changes.push(`date paid changed from "${snapPaid}" to "${currentPaid}"`);
          }

          // Client comparison
          const snapClient    = (snap.client || "").trim();
          const currentClient = (alert.summary?.client || "").trim();
          if (snapClient && currentClient && snapClient !== currentClient) {
            changes.push(`client changed from "${snapClient}" to "${currentClient}"`);
          }

          // Job comparison
          const snapJob    = (snap.job || "").trim();
          const currentJob = (alert.summary?.job || "").trim();
          if (snapJob && currentJob && snapJob !== currentJob) {
            changes.push(`job changed from "${snapJob}" to "${currentJob}"`);
          }

          // CRM alerts: compare each comparable field's value now vs at ignore time,
          // on whichever side(s) actually moved.
          if (alertType === "crm" && snap.crmFields && crmIdentity && crmIdentity.fields) {
            const FIELD_LABELS = {
              revenue: "Revenue", directCosts: "Direct costs", startDate: "Start date",
              endDate: "End date", likelihood: "% Likelihood",
            };
            for (const key of Object.keys(FIELD_LABELS)) {
              const before = snap.crmFields[key];
              const after  = crmIdentity.fields[key];
              if (!before || !after) continue;
              if (before.crm && after.crm && before.crm !== after.crm) {
                changes.push(`${FIELD_LABELS[key]} (CRM) changed from "${before.crm}" to "${after.crm}"`);
              }
              if (before.dashboard && after.dashboard && before.dashboard !== after.dashboard) {
                changes.push(`${FIELD_LABELS[key]} (dashboard) changed from "${before.dashboard}" to "${after.dashboard}"`);
              }
            }
          }

          if (changes.length > 0) {
            changeReason = changes.join("; ");
          } else {
            // No measurable data change found — likely a fingerprint normalisation migration
            changeReason = "underlying data may have been updated (no specific field change detected)";
          }
        } else {
          // No snapshot stored — alert was ignored before snapshot tracking was added
          changeReason = "alert was re-raised (no previous snapshot to compare against)";
        }
      } catch (e) { /* ignore diff errors */ }

      return { ignoreReason: row.ignoreReason, changeReason };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Helper to compress options JSON before saving to Sheets
 * Bypasses the 50,000 character limit by deduplicating jobRowsData & stripping empty fields
 */
function compressOptionsJSON_(jsonStr) {
  if (!jsonStr) return jsonStr;
  try {
    const options = JSON.parse(jsonStr);
    if (!Array.isArray(options)) return jsonStr;
    
    const seenJobs = new Set();
    const compressed = options.map(opt => {
      if (!opt.jobRow || !opt.jobRowsData) return opt;
      if (seenJobs.has(opt.jobRow)) {
        const { jobRowsData, ...rest } = opt;
        return rest;
      }
      seenJobs.add(opt.jobRow);
      return opt;
    });
    
    return JSON.stringify(compressed, (k, v) => (v === "" || v === null) ? undefined : v);
  } catch (e) {
    return jsonStr;
  }
}

/**
 * Write a new row to AlertMemory (append).
 */
async function appendAlertMemoryRow(sheets, automationCommanderSheetId, payload) {
  let {
    fingerprintHash, alertType, clientName, alertSummary,
    cachedOptionsJSON, status, ignoreReason, dataSnapshot, category,
  } = payload;

  cachedOptionsJSON = compressOptionsJSON_(cachedOptionsJSON);

  // Intercept any legacy code attempting to write old alertType taxonomy  if (alertType === "invoice") alertType = "invoiceDashboardDiscr";
  if (alertType === "expense") alertType = "expenseDashboardDiscr";
  if (alertType === "crm") alertType = "crmPipeAppDiscr";

  const now = new Date().toISOString().split("T")[0];
  await sheets.spreadsheets.values.append({
    spreadsheetId: automationCommanderSheetId,
    range: `${ALERT_MEMORY_TAB}!A:L`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        fingerprintHash, alertType, clientName, alertSummary,
        cachedOptionsJSON, status, ignoreReason || "", now, now,
        now, // lastRechecked = now on creation
        dataSnapshot || "",
        category || "discrepancy",
      ]],
    },
  });
}
/**
 * Update an existing AlertMemory row by its 1-indexed sheet row number.
 */
async function updateAlertMemoryRow(sheets, automationCommanderSheetId, rowIndex, updates) {
  const compressedOptions = compressOptionsJSON_(updates.cachedOptionsJSON);
  const now = new Date().toISOString().split("T")[0];
  const values = [
    updates.fingerprintHash,
    updates.alertType,
    updates.clientName,
    updates.alertSummary,
    compressedOptions,
    updates.status,    updates.ignoreReason || "",
    updates.firstSeen,
    now, // lastSeen always updated
    updates.lastRechecked || now,
    updates.dataSnapshot || "",
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: automationCommanderSheetId,
    range: `${ALERT_MEMORY_TAB}!A${rowIndex}:K${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

/**
 * Delete rows from AlertMemory by their 1-indexed sheet row numbers.
 * Deletes in reverse order to preserve row indices during deletion.
 */
async function deleteAlertMemoryRows(sheets, automationCommanderSheetId, rowIndices) {
  if (rowIndices.length === 0) return;

  // Get spreadsheet to find the AlertMemory sheet ID
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: automationCommanderSheetId,
  });
  const sheet = spreadsheet.data.sheets.find(
    s => s.properties.title === ALERT_MEMORY_TAB
  );
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  // Sort descending so deletions don't shift earlier rows
  const sorted = [...rowIndices].sort((a, b) => b - a);

  const requests = sorted.map(rowIndex => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: rowIndex - 1, // 0-indexed
        endIndex: rowIndex,       // exclusive
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: automationCommanderSheetId,
    requestBody: { requests },
  });
  console.log(`  🗑️ Deleted ${rowIndices.length} stale AlertMemory row(s)`);
}

/**
 * Purge AlertMemory rows older than ALERT_MEMORY_MAX_AGE_MONTHS.
 * Uses the lastSeen date for the cutoff check.
 */
async function purgeOldAlertMemoryRows(sheets, automationCommanderSheetId, memoryRows) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - ALERT_MEMORY_MAX_AGE_MONTHS);

  const toDelete = memoryRows
    .filter(row => {
      if (!row.lastSeen) return false;
      const lastSeen = new Date(row.lastSeen);
      return lastSeen < cutoff;
    })
    .map(row => row.rowIndex);

  if (toDelete.length > 0) {
    console.log(`🧹 Purging ${toDelete.length} AlertMemory row(s) older than ${ALERT_MEMORY_MAX_AGE_MONTHS} months`);
    await deleteAlertMemoryRows(sheets, automationCommanderSheetId, toDelete);
  }
}

// ============================================================================
// GOOGLE SHEETS INTEGRATION
// ============================================================================

function getGoogleAuth() {
  // Fix private key encoding - handle multiple formats
  let privateKey = process.env.SERVICE_ACCOUNT_PRIVATE_KEY || "";
  
  if (!privateKey) {
    console.error("SERVICE_ACCOUNT_PRIVATE_KEY is not set");
    throw new Error("SERVICE_ACCOUNT_PRIVATE_KEY environment variable not set");
  }
  
  // Replace escaped newlines with actual newlines
  privateKey = privateKey.replace(/\\n/g, "\n");
  
  const credentials = {
    type: "service_account",
    project_id: process.env.SERVICE_ACCOUNT_PROJECT_ID,
    private_key_id: process.env.SERVICE_ACCOUNT_PRIVATE_KEY_ID,
    private_key: privateKey,
    client_email: process.env.SERVICE_ACCOUNT_EMAIL,
    client_id: process.env.SERVICE_ACCOUNT_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url:
      "https://www.googleapis.com/oauth2/v1/certs",
  };

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: "v4", auth });
}

async function ensureFreshData(sheets, spreadsheetId, sheetName) {
  // Wait for Google Sheets to process (reduced from 2s to 0.5s)
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Dummy read to trigger calculation
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1`,
    });
  } catch (e) {
    // Ignore errors on dummy read
  }

  // Wait a bit more (reduced from 1s to 0.5s)
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function getToleranceValues(sheets, masterSheetId) {
  try {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: masterSheetId,
      ranges: ["DataChgAlert!F39", "DataChgAlert!J111", "DataChgAlert!B52"],
    });
    const ranges = response.data.valueRanges || [];
    return {
      invoiceMonthsTolerance: ranges[0]?.values?.[0]?.[0] || 2,
      expenseMonthsTolerance: ranges[1]?.values?.[0]?.[0] || 1,
      defaultDaysToPay:       ranges[2]?.values?.[0]?.[0] || 30,
    };
  } catch (err) {
    console.log("⚠️ Using default tolerance values");
    return {
      invoiceMonthsTolerance: 2,
      expenseMonthsTolerance: 1,
      defaultDaysToPay: 30,
    };
  }
}

async function getCRMMatchingMode(sheets, masterSheetId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "CRMComp!B2:B2",
    });
    const mode = response.data.values?.[0]?.[0];
    return mode === "Confirmed" ? "Confirmed" : "Pipeline";
  } catch (err) {
    console.log("⚠️ Defaulting CRM mode to Confirmed");
    return "Confirmed";
  }
}

async function setMasterSwitch(sheets, spreadsheetId, sheetName, value) {
  // If turning ON: check current state first — if already on, skip write and delay
  if (value === true) {
    try {
      const currentResp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!E2`,
      });
      const currentVal = currentResp.data.values?.[0]?.[0];
      const alreadyOn = (currentVal === true || String(currentVal).toUpperCase() === "TRUE");
      if (alreadyOn) {
        console.log(`  ✅ ${sheetName} switch already ON — skipping write and delay`);
        return;
      }
    } catch(e) {
      console.log(`  ⚠ Could not check ${sheetName} switch state: ${e.message} — proceeding with write`);
    }
    // Switch was off — turn it on and wait for data to populate
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!E2`,
      valueInputOption: "RAW",
      requestBody: { values: [[true]] },
    });
    await ensureFreshData(sheets, spreadsheetId, sheetName);
    return;
  }

  // value === false: switches are now left permanently ON — do nothing
  console.log(`  ⏭ ${sheetName} switch left ON (permanent mode — not turning off)`);
}

async function setCRMMode(sheets, spreadsheetId, mode) {
  // Set B2 in CRMComp to "Pipeline" or "Confirmed"
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "CRMComp!B2",
    valueInputOption: "RAW",
    requestBody: {
      values: [[mode]],
    },
  });

  // Ensure calculations complete
  await ensureFreshData(sheets, spreadsheetId, "CRMComp");
}

function extractSheetIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

// ══════════════════════════════════════════════════════════════════════════
// RETAINER MANAGEMENT HELPERS
// These replicate the proven logic from 5_AGENT_RECEIVER.gs's
// processRetainerAudit / runRetainerSheetAudit_ so the Retainers screen's
// manual edits stay consistent with what the nightly retainer audit expects
// and produces (rolling 18-month future window, quarterly-aware intervals,
// move-based row insertion/trimming with row grouping).
// ══════════════════════════════════════════════════════════════════════════

const RET_MONTHS_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function retParseSheetDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mi = RET_MONTHS_MAP[m[2].toLowerCase()];
    if (mi === undefined) return null;
    // Pivot-aware century guess for a 2-digit year: 00-69 -> 20XX, 70-99 -> 19XX.
    let yr;
    if (m[3].length === 2) {
      const twoDigit = parseInt(m[3], 10);
      yr = (twoDigit <= 69 ? 2000 : 1900) + twoDigit;
    } else {
      yr = parseInt(m[3], 10);
    }
    return new Date(yr, mi, parseInt(m[1]));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function retFmtDate(d) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  // IMPORTANT: always write the FULL 4-digit year. Writing a 2-digit year (e.g.
  // "31-Jul-50") via USER_ENTERED forces Sheets to guess the century using its own
  // pivot rule, which reads "50" as 1950 rather than 2050 for a future date — this
  // silently corrupted end dates that were decades in the future. The affected
  // cells already carry a 2-digit-year NUMBER FORMAT, so writing a full 4-digit
  // year here doesn't change how it's displayed — Sheets still shows "31-Jul-50",
  // it just stores the correct underlying date (2050, not 1950).
  return d.getDate() + "-" + months[d.getMonth()] + "-" + d.getFullYear();
}

function retParseMoney(val) {
  if (typeof val === "number") return val;
  if (!val) return 0;
  const clean = String(val).replace(/[^0-9.-]/g, "");
  return parseFloat(clean) || 0;
}

// Finds the true last row with any real data on Confirmed, using the same
// four-zone check used throughout the codebase.
async function retFindTrueLastRow(sheets, spreadsheetId, allRows) {
  let trueLastRow = 0;
  for (let r = allRows.length - 1; r >= 0; r--) {
    const row = allRows[r] || [];
    const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
    const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
    const z3 = row.slice(41, 60).some(c => c !== "" && c != null);
    const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
    if (z1 || z2 || z3 || z4) { trueLastRow = r + 1; break; }
  }
  return trueLastRow;
}

// Detects the invoice interval in months for a retainer job by comparing the
// last two child rows' invoice-1 send dates (mirrors detectPeriodMultiplier_ /
// the intervalMonths logic in runRetainerSheetAudit_). Defaults to 1 (monthly).
function retDetectIntervalMonths(childDates) {
  if (childDates.length < 2) return 1;
  const d1 = childDates[childDates.length - 2];
  const d2 = childDates[childDates.length - 1];
  const diffDays = Math.ceil(Math.abs(d2.getTime() - d1.getTime()) / 86400000);
  const calc = Math.round(diffDays / 30);
  return calc > 0 ? calc : 1;
}

// ── Detects whether this retainer's invoices are sent BEFORE the month/period
// they cover (e.g. sent 28-May for a June period) or DURING it (e.g. sent
// 3-Jun for June) — inferred from the job's own actual invoice history rather
// than assumed, since different clients/jobs follow different conventions and
// getting this wrong causes the trim/grow/split logic to pick the wrong row.
//
// Returns "before" or "during".
//
// allInvoiceDates: every known invoice sent-date for this job, in chronological
//   order (parent row's invoice first, if it has one, then each child row's).
// jobStartDate: the job's Start date (Confirmed col AL).
// intervalMonths: the already-detected spacing between invoices (1 = monthly,
//   3 = quarterly, etc.) — used to test each date against the right cadence.
//
// Logic:
//  - Zero dates: nothing to learn from — default to "during".
//  - One date: per the job's own single data point — if that invoice was sent
//    before the job's start date, assume "before" for all future invoices;
//    otherwise assume "during". No averaging needed with only one sample.
//  - Two or more dates: test both hypotheses against every date and pick
//    whichever fits better (smaller total deviation from a consistent
//    days-before/days-after pattern). Falls back to "during" on a tie or if
//    neither hypothesis fits at all consistently.
function retDetectInvoiceTimingOffset_(allInvoiceDates, jobStartDate, intervalMonths) {
  const dates = (allInvoiceDates || []).filter(Boolean);
  if (dates.length === 0) return "during";

  if (dates.length === 1) {
    if (jobStartDate && dates[0].getTime() < jobStartDate.getTime()) return "before";
    return "during";
  }

  if (!jobStartDate) return "during"; // can't anchor periods without a start date

  const interval = intervalMonths || 1;
  const addMonths = (y, m, n) => {
    const total = (y * 12 + m) + n; // m is 0-indexed here
    return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
  };

  // For each invoice at sequence position i, its OWN period should start at
  // jobStart + i*interval months. Compare the actual sent date to that period
  // start: sent BEFORE it -> "before" pattern; sent ON/AFTER it -> "during".
  // This anchors to the contract's own period boundaries (derived from its
  // start date and detected interval), not to guessing from the sent date
  // itself — which is what made the previous version misclassify on-time
  // invoices sent late in the month as "before".
  let beforeVotes = 0, duringVotes = 0;
  dates.forEach((sent, i) => {
    const { y, m } = addMonths(jobStartDate.getFullYear(), jobStartDate.getMonth(), i * interval);
    const periodStart = new Date(y, m, 1);
    if (sent.getTime() < periodStart.getTime()) beforeVotes++;
    else duringVotes++;
  });

  // Require a clean, consistent majority (all-or-nearly-all agreeing) — if the
  // history is genuinely mixed/noisy, that's not a reliable pattern to trust,
  // so fall back to the "during" default per spec.
  const total = beforeVotes + duringVotes;
  if (beforeVotes === total) return "before";
  if (duringVotes === total) return "during";
  // Mixed signal — pick whichever is the clear majority (>= 2/3), else default.
  if (beforeVotes / total >= 2 / 3) return "before";
  return "during";
}

// Groups a set of already-read Confirmed rows (1-indexed row -> row array) into
// { client, jobName, projectCode, revenue, vat, projectRetainer, startDate, endDate,
//   parentRowNum, childRows: [{ rowNum, row }] } for every retainer job found.
function retFindRetainerJobs(rows, options) {
  options = options || {};
  const onlyActiveOrRecentlyEnded = !!options.onlyActiveOrRecentlyEnded;
  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

  const jobs = [];
  let ri = 1;
  while (ri < rows.length) {
    const row = rows[ri] || [];
    const client = String(row[0] || "").trim();
    const jobName = String(row[1] || "").trim();
    const revenue = String(row[32] || "").trim();
    const type = String(row[35] || "").trim();
    if (!client && !jobName) { ri++; continue; }
    const isRetainer = type.toLowerCase().includes("retainer");
    if (!isRetainer || !revenue) { ri++; continue; }

    const parentRowNum = ri + 1;
    const endDate = retParseSheetDate(row[38]);
    if (onlyActiveOrRecentlyEnded && endDate && endDate < twoMonthsAgo) {
      // Skip this job but still need to walk past its child rows
      let cj2 = ri + 1;
      while (cj2 < rows.length) {
        const nx = rows[cj2] || [];
        if (String(nx[0]||"").trim() === client && String(nx[1]||"").trim() === jobName &&
            !String(nx[32]||"").trim() && !String(nx[37]||"").trim()) { cj2++; } else break;
      }
      ri = cj2;
      continue;
    }

    const childRows = [];
    let cj = ri + 1;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      const nc = String(next[0] || "").trim();
      const nj = String(next[1] || "").trim();
      const nRevenue = String(next[32] || "").trim();
      const nStart = String(next[37] || "").trim();
      if (nc === client && nj === jobName && !nRevenue && !nStart) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }
    jobs.push({
      client, jobName, projectCode: String(row[2] || "").trim(),
      revenue, vat: String(row[34] || "").trim(), projectRetainer: type,
      startDate: retParseSheetDate(row[37]), endDate,
      parentRow: row, parentRowNum, childRows,
    });
    ri = cj;
  }
  return jobs;
}

// Slot column layout for invoice slots 1-3 (0-indexed).
const RET_INV_SLOTS = [
  { amt: 41, ref: 42, sent: 43, days: 44, status: 45 },
  { amt: 48, ref: 49, sent: 50, days: 51, status: 52 },
  { amt: 55, ref: 56, sent: 57, days: 58, status: 59 },
];

// Fetch the parent row + any child rows for a job, formatted for spreadsheet-style
// display in the UI. Returns raw sheet values (no currency formatting) so the
// frontend can render them exactly as they appear in the sheet.
// tabName: "Pipeline" or "Confirmed". highlightSlot: { type: "invoice"|"expense", slotNum } | null
async function fetchJobRowsForDisplay(sheets, spreadsheetId, tabName, parentRowNum, highlightSlot, sharedData = null) {
  if (!spreadsheetId || !parentRowNum) return null;
  try {
    let rows = [];
    if (sharedData && tabName === "Confirmed" && sharedData.confirmedDataWide) {
      rows = sharedData.confirmedDataWide;
    } else if (sharedData && tabName === "Pipeline" && sharedData.pipelineData) {
      rows = sharedData.pipelineData;
    } else {
      // A:CR covers client through expense slot 3 (col CR = 96)
      const resp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${tabName}!A1:CR${parentRowNum + 30}`,
        valueRenderOption: "FORMATTED_VALUE",
      }));
      rows = resp.data.values || [];
    }
    const parentRow = rows[parentRowNum - 1] || [];
    const parentClient = String(parentRow[0] || "").trim();
    const parentJob    = String(parentRow[1] || "").trim();
    if (!parentClient && !parentJob) return null;

    const allRows = [{ rowNum: parentRowNum, row: parentRow, isParent: true }];
    // Walk forward collecting child rows: same client+job name repeated (not blank),
    // with no revenue/budget/start date of their own — matches the pattern used
    // throughout the rest of the codebase (see candidateJobs in generate_options).
    for (let i = parentRowNum; i < rows.length; i++) {
      const r = rows[i] || [];
      const rc = String(r[0] || "").trim();
      const rj = String(r[1] || "").trim();
      const rRevenue = String(r[32] || "").trim();
      const rBudget = parseFloat(String(r[33] || "").replace(/[£$€,\s]/g, "")) || 0;
      const rStart = String(r[37] || "").trim();
      if (rc === parentClient && rj === parentJob && !rRevenue && !rBudget && !rStart) {
        allRows.push({ rowNum: i + 1, row: r, isParent: false });
      } else {
        break;
      }
    }

    const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
    const buildRowData = ({ rowNum, row, isParent }) => ({
      rowNum,
      isParent,
      client:        colVal(row, 0),
      jobName:       colVal(row, 1),
      projectCode:   colVal(row, 2),
      revenue:       colVal(row, 32), // AG
      directCosts:   colVal(row, 33), // AH
      vat:           colVal(row, 34), // AI
      projectRetainer: colVal(row, 35), // AJ
      startDate:     colVal(row, 37), // AL
      endDate:       colVal(row, 38), // AM
      likelihood:    tabName === "Pipeline" ? colVal(row, 39) : null, // AN
      copiedToConf:  tabName === "Pipeline" ? colVal(row, 107) : null, // DD
      invoiceSlots: [
        { slotNum: 1, amount: colVal(row,41), ref: colVal(row,42), sentDate: colVal(row,43), daysToPay: colVal(row,44), status: colVal(row,45),
          highlighted: highlightSlot?.type === "invoice" && highlightSlot.slotNum === 1 && highlightSlot.rowNum === rowNum },
        { slotNum: 2, amount: colVal(row,48), ref: colVal(row,49), sentDate: colVal(row,50), daysToPay: colVal(row,51), status: colVal(row,52),
          highlighted: highlightSlot?.type === "invoice" && highlightSlot.slotNum === 2 && highlightSlot.rowNum === rowNum },
        { slotNum: 3, amount: colVal(row,55), ref: colVal(row,56), sentDate: colVal(row,57), daysToPay: colVal(row,58), status: colVal(row,59),
          highlighted: highlightSlot?.type === "invoice" && highlightSlot.slotNum === 3 && highlightSlot.rowNum === rowNum },
      ],
      expenseSlots: [
        { slotNum: 1, description: colVal(row,75), amount: colVal(row,76), vat: colVal(row,77), date: colVal(row,78), daysToPay: colVal(row,79), status: colVal(row,80), transactionId: colVal(row,81),
          highlighted: highlightSlot?.type === "expense" && highlightSlot.slotNum === 1 && highlightSlot.rowNum === rowNum },
        { slotNum: 2, description: colVal(row,82), amount: colVal(row,83), vat: colVal(row,84), date: colVal(row,85), daysToPay: colVal(row,86), status: colVal(row,87), transactionId: colVal(row,88),
          highlighted: highlightSlot?.type === "expense" && highlightSlot.slotNum === 2 && highlightSlot.rowNum === rowNum },
        { slotNum: 3, description: colVal(row,89), amount: colVal(row,90), vat: colVal(row,91), date: colVal(row,92), daysToPay: colVal(row,93), status: colVal(row,94), transactionId: colVal(row,95),
          highlighted: highlightSlot?.type === "expense" && highlightSlot.slotNum === 3 && highlightSlot.rowNum === rowNum },
      ],
    });

    let resultData = allRows.map(buildRowData);
    
    // Truncate massive jobs (like multi-year retainers) to stay well under the 50,000 char Google Sheets cell limit
    if (resultData.length > 8) {
      const parent = resultData[0]; // Always keep the parent row
      const targetIdx = resultData.findIndex(r => 
        r.invoiceSlots.some(s => s.highlighted) || r.expenseSlots.some(s => s.highlighted)
      );
      
      if (targetIdx > 0) {
        // Keep up to 2 rows before and 2 rows after the target
        const start = Math.max(1, targetIdx - 2);
        const end = Math.min(resultData.length, targetIdx + 3);
        const subset = resultData.slice(start, end);
        
        // Recombine and remove duplicates (if subset overlaps parent)
        const combined = [parent, ...subset];
        resultData = Array.from(new Map(combined.map(item => [item.rowNum, item])).values());
      } else {
        // If no specific target, just keep the first 8 rows
        resultData = resultData.slice(0, 8);
      }
    }

    return resultData;
  } catch (e) {
    console.log(`  ⚠ fetchJobRowsForDisplay error: ${e.message}`);
    return null;
  }
}

// Convert 1-indexed column number to A1 letter notation (e.g. 1→A, 27→AA)
function colIndexToLetter(colNum) {
  let letter = "";
  let n = colNum;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// Convert column letter(s) to 1-based number. E.g. A→1, AA→27
/** Log a Claude API call directly to ClaudeUsage tab */
async function logClaudeUsage_(sheets, automationCommanderSheetId, clientName, alertType, inputTokens, outputTokens, source) {
  if (!automationCommanderSheetId) return;
  const acIdClean = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;
  await ensureClaudeUsageTab_(sheets, acIdClean);
  const costUsd = ((inputTokens || 0) / 1000000 * 3) + ((outputTokens || 0) / 1000000 * 15);
  await sheets.spreadsheets.values.append({
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
  });
  console.log(`  📊 Logged Claude usage: ${clientName} ${alertType} — ${inputTokens}+${outputTokens} tokens, $${costUsd.toFixed(4)}`);
}

// ── Payroll import tool (Tools menu, in progress) — helper functions ────────

/**
 * Writes extracted payroll data to a client's Salaries tab and computes the
 * totals reconciliation. Mirrors writePayrollData() from 8_AI_Features.gs,
 * with two differences: no KeyInfo redirect (triage.js already has
 * clientSheetId directly), and returns structured data instead of a text
 * log, since this feeds a proper review UI rather than a sidebar textbox.
 */
async function writePayrollDataToSheet_(sheets, clientSheetId, extractedData, targetMonthStr, validEmployeeNames) {
  const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Salaries!1:1" });
  const headers = (headerResp.data.values && headerResp.data.values[0]) || [];
  let startColIdx0 = -1; // 0-indexed
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] && isDateMatchJs_(headers[i], targetMonthStr)) { startColIdx0 = i; break; }
  }
  if (startColIdx0 === -1) {
    return { writeSuccess: false, error: `Could not find column for '${targetMonthStr}' in the Salaries header row.` };
  }
  const startColLetter = columnIndexToLetter_(startColIdx0 + 1);
  const endColLetter = columnIndexToLetter_(startColIdx0 + 7);

  const sheetNames = validEmployeeNames; // already read by the caller from Salaries!A4:A53

  const namesFoundInDoc = extractedData.employees.filter(e => e.mappedName !== "NEW_STARTER").map(e => e.mappedName);
  const missingFromDoc = sheetNames.filter(n => n && !namesFoundInDoc.includes(n));
  const newStarters = extractedData.employees.filter(e => e.mappedName === "NEW_STARTER").map(e => e.originalName);
  const unmatched = [];

  const writeData = [];
  const writtenTotals = { grossPay: 0, eeNic: 0, erNic: 0, studLoan: 0, eePension: 0, erPension: 0, paye: 0 };
  let updateCount = 0;

  for (const emp of extractedData.employees) {
    if (emp.mappedName === "NEW_STARTER") continue;
    const rowIdx = sheetNames.indexOf(emp.mappedName);
    if (rowIdx === -1) { unmatched.push(emp.originalName); continue; }
    const sheetRow = rowIdx + 4;
    const vals = [emp.grossPay||0, emp.eeNic||0, emp.erNic||0, emp.studLoan||0, emp.eePension||0, emp.erPension||0, emp.paye||0];
    writeData.push({ range: `Salaries!${startColLetter}${sheetRow}:${endColLetter}${sheetRow}`, values: [vals] });
    writtenTotals.grossPay += vals[0]; writtenTotals.eeNic += vals[1]; writtenTotals.erNic += vals[2];
    writtenTotals.studLoan += vals[3]; writtenTotals.eePension += vals[4]; writtenTotals.erPension += vals[5]; writtenTotals.paye += vals[6];
    updateCount++;
  }

  if (writeData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: clientSheetId, requestBody: { data: writeData, valueInputOption: "RAW" } });
  }

  // Totals reconciliation — documentTotal's meaning depends on totalsSource:
  // "document" = read directly off a totals row (independent evidence);
  // "calculated" = AI's own sum of the employee lines it extracted (mainly
  // catches write-step errors, not read-step errors — see conversation 18 Aug 2026).
  const docTotals = extractedData.totals || {};
  const totalsSource = extractedData.totalsSource === "document" ? "document" : "calculated";
  const TOLERANCE = 1.00;
  const categories = ["grossPay","eeNic","erNic","studLoan","eePension","erPension","paye"];
  const totalsCheck = categories.map(cat => {
    const docVal = parseFloat(docTotals[cat]) || 0;
    const writtenVal = Math.round(writtenTotals[cat] * 100) / 100;
    const diff = Math.round(Math.abs(docVal - writtenVal) * 100) / 100;
    return { category: cat, documentTotal: docVal, writtenTotal: writtenVal, diff, reconciled: diff <= TOLERANCE };
  });

  return {
    writeSuccess: true, updateCount, targetMonthStr, startCol: startColLetter,
    missingFromDoc, newStarters, unmatched, totalsSource, totalsCheck,
  };
}

/**
 * Time-report equivalent of writePayrollDataToSheet_ above — same overall
 * shape, with the structural differences confirmed directly against the
 * original GAS script (8_AI_Features.gs, writeTimeData) rather than
 * assumed: header row is row 4 (not row 1), employee names start at row
 * 12 (not row 4), and only two adjacent columns are written per employee
 * (billableHrs, totalHrs) rather than seven. The original script also has
 * no totals-reconciliation concept for time at all, unlike payroll, so
 * none is added here either.
 */
async function writeTimeDataToSheet_(sheets, masterSheetId, extractedData, targetMonthStr, validEmployeeNames) {
  const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "TimeComp!4:4" });
  const headers = (headerResp.data.values && headerResp.data.values[0]) || [];
  let startColIdx0 = -1; // 0-indexed
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] && isDateMatchJs_(headers[i], targetMonthStr)) { startColIdx0 = i; break; }
  }
  if (startColIdx0 === -1) {
    return { writeSuccess: false, error: `Could not find column for '${targetMonthStr}' in the TimeComp row 4 header.` };
  }
  const startColLetter = columnIndexToLetter_(startColIdx0 + 1);
  const endColLetter = columnIndexToLetter_(startColIdx0 + 2);

  const sheetNames = validEmployeeNames; // already read by the caller from TimeComp!A12:A62

  const namesFoundInDoc = extractedData.employees.filter(e => e.mappedName !== "NEW_STARTER").map(e => e.mappedName);
  const missingFromDoc = sheetNames.filter(n => n && !namesFoundInDoc.includes(n));
  const newStarters = extractedData.employees.filter(e => e.mappedName === "NEW_STARTER").map(e => e.originalName);
  const unmatched = [];

  const writeData = [];
  let updateCount = 0;

  for (const emp of extractedData.employees) {
    if (emp.mappedName === "NEW_STARTER") continue;
    const rowIdx = sheetNames.indexOf(emp.mappedName);
    if (rowIdx === -1) { unmatched.push(emp.originalName); continue; }
    const sheetRow = rowIdx + 12;
    const vals = [emp.billableHrs || 0, emp.totalHrs || 0];
    writeData.push({ range: `TimeComp!${startColLetter}${sheetRow}:${endColLetter}${sheetRow}`, values: [vals] });
    updateCount++;
  }

  if (writeData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: masterSheetId, requestBody: { data: writeData, valueInputOption: "RAW" } });
  }

  return {
    writeSuccess: true, updateCount, targetMonthStr, startCol: startColLetter,
    missingFromDoc, newStarters, unmatched,
  };
}

/**
 * Parses a date string in either the sheet's own "DD-MMM-YY" convention
 * (e.g. "15-Aug-26") or a full JS Date.toString() string (e.g. "Thu Aug 20
 * 2026 00:00:00 GMT+0100 (British Summer Time)" — confirmed 20 Aug 2026:
 * alert.summary.sentDate/date arrive in this format, not the sheet's own).
 * Shared by both invoice and expense matching's date-tolerance checks so a
 * future fix to date parsing only needs to happen once, not twice.
 */
function parseSheetOrJsDate_(d) {
  if (!d) return null;
  const MONTHS_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const parts = String(d).split(/[-\/]/);
  if (parts.length === 3) {
    const mNum = MONTHS_MAP[parts[1]?.toLowerCase()?.substring(0,3)];
    if (mNum !== undefined) {
      const yr = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
      return new Date(yr, mNum, parseInt(parts[0]));
    }
  }
  const nativeParsed = new Date(d);
  if (!isNaN(nativeParsed.getTime())) return nativeParsed;
  return null;
}

/** Whole-calendar-months difference between two already-parsed Dates, within tolerance. Null = unknown (a date was missing/unparseable), not a value the caller should treat as "false". */
function monthsWithinTolerance_(dateA, dateB, tolMonths) {
  if (!dateA || !dateB) return null;
  const diffMonths = (dateB.getFullYear() - dateA.getFullYear()) * 12 + (dateB.getMonth() - dateA.getMonth());
  return Math.abs(diffMonths) <= tolMonths;
}

/** Words to strip when fuzzy-comparing client/company names — legal suffixes and generic terms that don't help distinguish one company from another. */
const CLIENT_NAME_NOISE_WORDS_ = new Set([
  "ltd","limited","plc","inc","llc","llp","the","and","&",
  "group","co","corp","corporation","holdings","international",
  "uk","us","solutions","services","consulting","consultancy",
]);
function normClientWords_(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['\-.,()]/g, " ")   // punctuation → space
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(w => w.length > 1 && !CLIENT_NAME_NOISE_WORDS_.has(w));
}
// Check if words in name A form the abbreviation of name B (or vice versa)
function isAbbreviationOf_(abbrev, full) {
  const abbrevClean = abbrev.replace(/\./g, "").toLowerCase();
  const fullWords = normClientWords_(full);
  if (fullWords.length < 2 || abbrevClean.length < 2) return false;
  // Initials of full words should spell the abbreviation
  const initials = fullWords.map(w => w[0]).join("");
  return initials === abbrevClean || initials.startsWith(abbrevClean);
}
/**
 * Fuzzy client/company name match — word overlap, substring containment, or
 * abbreviation in either direction. Extracted to module level 20 Aug 2026:
 * originally a local function scoped inside the invoice isMissingInvoice
 * pre-analysis block, but Tier 1/2 option-generation (which the date-match
 * and partial-client-match ranking fixes needed this for) is a SIBLING
 * scope outside that block, not a child of it — the local version was never
 * actually reachable from there, confirmed via Babel's own scope resolution
 * (not just an ESLint guess) after a full-codebase sweep turned it up. That
 * meant every accept-option call touching Tier 2 ranking would have thrown
 * a ReferenceError at runtime despite passing a plain syntax check, since
 * no-undef-style errors are a runtime-only failure JS syntax checking can't
 * catch. Moving it here — not just widening the local scope — also lets
 * expense matching's client comparisons reuse the exact same logic if
 * needed later, rather than a second, separate definition.
 */
function fuzzyClientMatch_(clientStrA, clientStrB) {
  const wordsA = normClientWords_(clientStrA);
  const wordsB = normClientWords_(clientStrB);
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  // Any single meaningful word overlap
  if (wordsA.some(w => wordsB.includes(w))) return true;
  // Substring containment after noise-stripping (catches "Peoples Health" vs "Peoples Health Trust")
  const joinedA = wordsA.join(" ");
  const joinedB = wordsB.join(" ");
  if (joinedB.includes(joinedA) || joinedA.includes(joinedB)) return true;
  // Abbreviation: one client string is an abbreviation of the other
  if (isAbbreviationOf_(joinedA.replace(/\s/g,""), clientStrB)) return true;
  if (isAbbreviationOf_(joinedB.replace(/\s/g,""), clientStrA))  return true;
  return false;
}

function isDateMatchJs_(sheetHeader, aiDate) {
  if (!sheetHeader || !aiDate) return false;
  const s1 = String(sheetHeader).toLowerCase();
  const s2 = String(aiDate).toLowerCase();
  if (s1 === s2) return true;
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const m1 = months.find(m => s1.includes(m));
  const m2 = months.find(m => s2.includes(m));
  const y1 = s1.match(/\d{2,4}/);
  const y2 = s2.match(/\d{2,4}/);
  if (m1 && m2 && m1 === m2) {
    if (!y1 || !y2) return true;
    const year1 = y1[0].length === 2 ? "20" + y1[0] : y1[0];
    const year2 = y2[0].length === 2 ? "20" + y2[0] : y2[0];
    return year1 === year2;
  }
  return false;
}

function columnIndexToLetter_(colNum1Indexed) {
  let s = "";
  let n = colNum1Indexed;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Minimal CSV parser (handles quoted fields with embedded commas/newlines) —
 * written inline rather than adding a new npm dependency for this one use.
 */
function parseCsvSimple_(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ""; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Ports the dynamic-header-detection + vertical key-value transform from
 * executeGeminiRequest() in 8_AI_Features.gs — same technique, same reason
 * (keeps token usage down, keeps columns aligned for the AI regardless of
 * which row the real header sits on in an exported CSV/Excel sheet).
 */
function buildVerticalCsvText_(csvText) {
  let cleanData = "";
  try {
    const rows = parseCsvSimple_(csvText);
    if (rows.length > 1) {
      let headerIndex = 0;
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const populatedCols = rows[i].filter(c => c && c.trim() !== "");
        if (populatedCols.length > 2) { headerIndex = i; break; }
      }
      const headers = rows[headerIndex].map(h => (h || "").trim());
      for (let i = headerIndex + 1; i < rows.length; i++) {
        const row = rows[i];
        let rowText = "---\n";
        for (let j = 0; j < headers.length; j++) {
          let val = row[j] ? row[j].trim() : "";
          if (val === "" || val === "NaN") val = "0";
          rowText += `${headers[j]}: ${val}\n`;
        }
        cleanData += rowText;
      }
    }
  } catch (e) { /* fall through with whatever was built so far */ }
  return cleanData;
}

/**
 * Normalizes a name for fuzzy matching: lowercase, strips common corporate
 * suffixes (Ltd/Limited/LLP/etc.) and punctuation, collapses whitespace.
 */
function normalizeForMatch_(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b(ltd|limited|llp|plc|inc|group)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tries to match a piece of text (a filename or an employer name extracted
 * from a document) against the client list. Requires the shorter of the two
 * normalized strings to be at least 4 characters, to avoid matching on tiny
 * or generic words. Returns matched=null (not confident) if zero or more
 * than one client match — an ambiguous multi-match is exactly as unhelpful
 * as no match at all here.
 */
function findClientByNameMatch_(candidateText, allClients) {
  const norm = normalizeForMatch_(candidateText);
  if (!norm || norm.length < 3) return { matched: null, candidates: [] };
  const matches = [];
  for (const client of allClients) {
    const clientNorm = normalizeForMatch_(client.clientName);
    if (!clientNorm || clientNorm.length < 4) continue;
    if (norm.includes(clientNorm) || clientNorm.includes(norm)) {
      matches.push(client.clientName);
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length === 1) return { matched: unique[0], candidates: unique };
  return { matched: null, candidates: unique };
}

/**
 * Tier-2 fallback for client auto-detection: cross-references extracted
 * employee names against every client's own Salaries tab employee list,
 * scoring overlap. Only used when filename/employer-name matching (tier 1)
 * fails to find a confident match — this is the more expensive path (reads
 * every client's employee list), and the fuzzy signal, not the direct one.
 *
 * Confidence thresholds here are a first-pass starting point, not a final
 * tuned value — see conversation 18 Aug 2026. Expect these to need
 * adjusting once run against real documents.
 */
// sheetIdField: "clientSheetId" (payroll, Salaries lives on the client
// sheet) or "masterSheetId" (time, TimeComp lives on the master sheet —
// see conversation 19 Aug 2026, confirmed directly against the original
// GAS script rather than assumed).
async function scoreClientsByEmployeeOverlap_(sheets, allClients, extractedEmployeeNames, sheetIdField = "clientSheetId", range = "Salaries!A4:A53") {
  const normalizedExtracted = extractedEmployeeNames.map(n => normalizeForMatch_(n)).filter(Boolean);
  if (normalizedExtracted.length === 0) return { matched: null, scores: [] };

  const scores = [];
  for (const client of allClients) {
    const sheetId = client[sheetIdField];
    if (!sheetId) continue;
    try {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId, range,
      });
      const sheetNames = (resp.data.values || []).map(r => normalizeForMatch_(r[0])).filter(Boolean);
      if (sheetNames.length === 0) continue;
      let overlap = 0;
      for (const en of normalizedExtracted) {
        if (sheetNames.some(sn => sn === en)) overlap++;
      }
      if (overlap > 0) scores.push({ clientName: client.clientName, overlap });
    } catch (e) { /* sheet may have no matching tab at all — skip it */ }
  }
  scores.sort((a, b) => b.overlap - a.overlap);
  if (scores.length === 0) return { matched: null, scores: [] };

  const top = scores[0];
  const second = scores[1];
  const minAbsolute = Math.min(2, normalizedExtracted.length);
  const clearsMinimum = top.overlap >= minAbsolute && top.overlap >= normalizedExtracted.length * 0.4;
  const beatsRunnerUp = !second || top.overlap > second.overlap * 1.5 || (top.overlap - (second?.overlap || 0)) >= 2;
  const confident = clearsMinimum && beatsRunnerUp;

  return { matched: confident ? top.clientName : null, scores: scores.slice(0, 5) };
}

/** Ensure ClaudeUsage tab exists in Automation Commander with correct headers and config */
async function ensureClaudeUsageTab_(sheets, spreadsheetId) {
  try {
    // Check if tab exists
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
    const exists = meta.data.sheets.some(s => s.properties.title === "ClaudeUsage");
    if (!exists) {
      // Create the tab
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: "ClaudeUsage" } } }] },
      });
      // Write config section and headers
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: [
            { range: "ClaudeUsage!A1:B6", values: [
              ["Claude API Usage & Settings", ""],
              ["hourly_limit", 10],
              ["daily_limit", 30],
              ["anomaly_threshold", 15],
              ["Pricing: Sonnet 4 ($/1M tokens)", "input: $3, output: $15"],
              ["", ""],
            ]},
            { range: "ClaudeUsage!A7:F7", values: [
              ["Timestamp", "Source", "Client", "Alert Type", "Tokens", "Cost (USD)"],
            ]},
          ],
        },
      });
    }
  } catch(e) {
    console.error("ensureClaudeUsageTab_ error:", e.message);
  }
}

/**
 * Creates the three EoM (End of Month) tracking tabs on the Automation
 * Commander sheet if they don't already exist — same pattern as
 * ensureClaudeUsageTab_ above. Checks all three existence flags in one
 * metadata call before creating anything.
 *   EomTemplates:    A=templateId B=name C=defaultNotes D=linkedFunction E=active F=createdAt
 *   EomClientTasks:  A=taskId B=clientName C=templateId D=taskName E=clientNotes F=active G=createdAt
 *   EomMonthlyStatus: A=clientName B=taskId C=monthKey D=status E=completedAt
 */
// Extracted and consolidated from CFO_task_checklist.xlsx (18 Aug 2026).
// Keys under 'clients'/'customTasks' are the SHORT client names as they
// appeared in that spreadsheet — matched against the live, full client
// list at seed time (see eom_seed_from_checklist below), not assumed
// to be exact matches.
const EOM_SEED_DATA = {
  "templates": [
    {
      "name": "Check and sort invoice discrepancies (InvComp)",
      "clients": {
        "Thrive": "Check and sort invoice discrepancies (InvComp)",
        "Eleven": "Check and sort invoice discrepancies (InvComp)",
        "Orinoco": "Check and sort invoice discrepancies (InvComp)",
        "Rascal": "Check and sort invoice discrepancies (InvComp)",
        "Base Three": "Check and sort invoice discrepancies (InvComp)",
        "Incredibble": "Check and sort any invoice discrepancies (InvComp)",
        "Get Better": "Check and sort any invoice discrepancies (InvComp)",
        "Starlight": "Check and sort any invoice discrepancies (InvComp)",
        "GeoBrand": "Check and sort any invoice discrepancies (InvComp)",
        "Seen": "Check and sort any invoice discrepancies (InvComp)"
      }
    },
    {
      "name": "Add actuals to salaries",
      "clients": {
        "Thrive": "Add actuals to salaries",
        "Eleven": "Add actuals to salaries",
        "Orinoco": "Add actuals to salaries",
        "Advance Online": "Add actuals to salaries",
        "Incredibble": "Add actuals to salaries",
        "ANRPR": "Add actuals to salaries",
        "Starlight": "Import salaries info AND check employee list is accurate",
        "GeoBrand": "Import salaries info AND check employee list is accurate",
        "Seen": "Import salaries info AND check employee list is accurate"
      }
    },
    {
      "name": "Use PLComp to add actual outgoings for current and prev month",
      "clients": {
        "Thrive": "Use PLComp to add actual outgoings for current and prev month",
        "Eleven": "Use PLComp to add actual outgoings for current and prev month",
        "Orinoco": "Use PLComp to add actual outgoings for current and prev month",
        "Advance Online": "Use PLComp to add actual outgoings for current and prev month",
        "Beyond the Blueprint": "Use PLComp to add actual outgoings for current and prev month",
        "Rascal": "Use PLComp to add actual outgoings for current and prev month",
        "ANRPR": "Use PLComp to add actual outgoings for current and prev month",
        "Hancock & Rowe": "Use PLComp to add actual outgoings for current and prev month",
        "Base Three": "Use PLComp to add actual outgoings for current and prev month",
        "Incredibble": "Use recon tab and PLComp to add actual outgoings for current and prev month",
        "Get Better": "Use recon tab and PLComp to add actual outgoings for current and prev month",
        "Starlight": "Use recon tab and PLComp to add actual outgoings for current and prev month",
        "GeoBrand": "Use recon tab and PLComp to add actual outgoings for current and prev month",
        "Seen": "Use recon tab and PLComp to add actual outgoings for current and prev month"
      }
    },
    {
      "name": "Send end of month data request email",
      "clients": {
        "Thrive": "Send end of month data request email (payslips, leave tracker, conf + pipe)",
        "Eleven": "Send end of month data request email (payslips, contr)",
        "Orinoco": "Send end of month data request email (payslips, contr, pipe)",
        "Advance Online": "Send end of month data request email (payslips)",
        "ANRPR": "Send end of month data request email (payslips)",
        "Hancock & Rowe": "Send end of month data request email"
      }
    },
    {
      "name": "Add bank account closing balance",
      "clients": {
        "Thrive": "Add bank account closing balance",
        "Eleven": "Add bank account closing balance",
        "Orinoco": "Add bank account closing balance",
        "Advance Online": "Add bank account closing balance",
        "Incredibble": "Add bank account closing balance",
        "ANRPR": "Add bank account closing balance",
        "Starlight": "Add bank account closing balance",
        "GeoBrand": "Add bank account closing balance",
        "Seen": "Add bank account closing balance"
      }
    },
    {
      "name": "Reconcile cashflow forecast against actual",
      "clients": {
        "Thrive": "Reconcile cashflow forecast against actual (use bank recon sheet)",
        "Eleven": "Reconcile cashflow forecast against actual (use bank recon sheet)",
        "Orinoco": "Reconcile cashflow forecast against actual",
        "Advance Online": "Reconcile cashflow forecast against actual (use bank recon sheet)",
        "Incredibble": "Reconcile cashflow forecast against actual",
        "Rascal": "Reconcile cashflow forecast against actual",
        "Get Better": "Reconcile cashflow forecast against actual",
        "ANRPR": "Reconcile cashflow forecast against actual (use bank recon sheet)",
        "Starlight": "Reconcile cashflow forecast against actual",
        "GeoBrand": "Reconcile cashflow forecast against actual",
        "Seen": "Reconcile cashflow forecast against actual",
        "Hancock & Rowe": "Reconcile cashflow forecast against actual"
      }
    },
    {
      "name": "Change \"forecast\" to \"actual\" in Master Performance tab",
      "clients": {
        "Thrive": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Eleven": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Orinoco": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Advance Online": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Incredibble": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Beyond the Blueprint": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Get Better": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "ANRPR": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Starlight": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "GeoBrand": "Change \"forecast\" to \"actual\" in Master Performance tab",
        "Seen": "Change \"forecast\" to \"actual\" in Master Performance tab"
      }
    },
    {
      "name": "Create backup of dashboard in static sheet",
      "clients": {
        "Thrive": "Create backup of dashboard in static sheet",
        "Eleven": "Create backup of dashboard in static sheet",
        "Orinoco": "Create backup of dashboard in static sheet",
        "Advance Online": "Create backup of dashboard in static sheet",
        "Beyond the Blueprint": "Create backup of dashboard in static sheet",
        "Rascal": "Create backup of dashboard in static sheet",
        "Get Better": "Create backup of dashboard in static sheet",
        "ANRPR": "Create backup of dashboard in static sheet",
        "Base Three": "Create backup of dashboard in static sheet"
      }
    },
    {
      "name": "Create and send monthly management report",
      "clients": {
        "Thrive": "Create and send monthly management report",
        "Eleven": "Create and send monthly management report",
        "Orinoco": "Create and send monthly management report",
        "Advance Online": "Create and send monthly management report",
        "ANRPR": "Create and send monthly management report"
      }
    },
    {
      "name": "Check tracker against Xero re corp tax",
      "clients": {
        "Eleven": "Check tracker against Xero re corp tax",
        "Orinoco": "Check tracker against Xero re corp tax",
        "Hancock & Rowe": "Check tracker against Xero re corp tax"
      }
    },
    {
      "name": "Send tax transfer amounts",
      "clients": {
        "Eleven": "Send tax transfer amounts",
        "Orinoco": "Send tax transfer amounts",
        "Hancock & Rowe": "Send tax transfer amounts"
      }
    },
    {
      "name": "Check and sort expense discrepancies (DirComp)",
      "clients": {
        "Incredibble": "Check and sort expense discrepancies (DirComp)",
        "Get Better": "Check and sort expense discrepancies (DirComp)",
        "GeoBrand": "Check and sort expense discrepancies (DirComp)",
        "Seen": "Check and sort expense discrepancies (DirComp)"
      }
    },
    {
      "name": "Check and sort confirmed and pipeline discrepancies (CRMComp)",
      "clients": {
        "Rascal": "Check and sort confirmed and pipeline discrepancies (CRMComp)",
        "Starlight": "Check and sort confirmed and pipeline discrepancies (CRMComp)",
        "GeoBrand": "Check and sort confirmed and pipeline discrepancies (CRMComp)",
        "Seen": "Check and sort confirmed and pipeline discrepancies (CRMComp)"
      }
    },
    {
      "name": "Check retainer jobs all have invoices",
      "clients": {
        "Get Better": "Check retainer jobs all have invoices (i.e. check they haven't finished without us being told)",
        "Starlight": "Check retainer jobs all have invoices (i.e. check they haven't finished without us being told)",
        "GeoBrand": "Check retainer jobs all have invoices (i.e. check they haven't finished without us being told)",
        "Seen": "Check retainer jobs all have invoices (i.e. check they haven't finished without us being told)"
      }
    },
    {
      "name": "Compare dashboard month to Xero month and make changes as required",
      "clients": {
        "Get Better": "Compare dashboard month to Xero month and make changes as required (if revenue doesn't match, look for phasing differences. Also have the \"revenue comparison\" sheet available - download all revenue items from Xero, compile, then get Gemini to compare with revenue items from dashboard)",
        "Starlight": "Compare dashboard month to Xero month and make changes as required (if revenue doesn't match, look for phasing differences. Also have the \"revenue comparison\" sheet available - download all revenue items from Xero, compile, then get Gemini to compare with revenue items from dashboard)",
        "GeoBrand": "Compare dashboard month to Xero month and make changes as required (if revenue doesn't match, look for phasing differences. Also have the \"revenue comparison\" sheet available - download all revenue items from Xero, compile, then get Gemini to compare with revenue items from dashboard)",
        "Seen": "Compare dashboard month to Xero month and make changes as required (if revenue doesn't match, look for phasing differences. Also have the \"revenue comparison\" sheet available - download all revenue items from Xero, compile, then get Gemini to compare with revenue items from dashboard)"
      }
    }
  ],
  "customTasks": {
    "Thrive": [
      "Update NB to find figures (incl remove any from \"current month\")",
      "Add actuals to leave",
      "Send email requesting closing bank account balance",
      "Update utilisation numbers (WMJ: Reports - Billable Summary - Hours)",
      "Update project overservicing numbers (Resource Manager - Traffic Calendar - Task Date (make it \"Due\") - custom - enter previous month's dates - click Completed Tasks - click Search - Print ) ... copy into \"Thrive project analysis\" FIRST sheet",
      "Time breakdown (WMJ: Reports - Proj Fin Reports - Time Detail Data (no costs)) - might need to search for it!"
    ],
    "Eleven": [
      "Check pipeline is updated",
      "Update contractors based on actual bills and Ben's forecast",
      "Zero \"making up CoS\" row",
      "Add extra invoices for prev month once Ben replies",
      "Check and update third party pass-through costs",
      "Check N&O commissions against tracker (N&O x Eleven \u2013 Introduction & Referral Tracker)",
      "Update tax tracker tab",
      "Send dividend certificate"
    ],
    "Orinoco": [
      "Check confirmed job dates - do any need changing? (During monthly finance meeting)",
      "Check pipeline is updated (no need for this as Capsule link created)",
      "Update contractors based on actual bills and Bianca's forecast",
      "Zero \"making up CoS\" row",
      "Check and update third party pass-through costs"
    ],
    "Advance Online": [
      "Request closing bank account balances",
      "Update revenue based on figure from Quickbooks",
      "Manualy add contractor costs into Outgoings tab (EXCLUDING EMMERL)",
      "Manualy add total Emmerl costs into Outgoings tab (go into Emmerl in Quickbooks and get \"total expenses\" figure)",
      "Ensure loan costs are correctly captured in cashflow"
    ],
    "Incredibble": [
      "Send email requesting closing bank account balance",
      "Move expenses in Outgoings to correct months if required, and split out any Incredibble own marketing to separate 0% delivery row",
      "Calculate corp tax and VAT amounts to transfer and tell Helen",
      "Email Helen to say it's ready"
    ],
    "Beyond the Blueprint": [
      "Check and update confirmed tab",
      "Check and update pipeline tab",
      "Check and update partner invoices",
      "Add recharged expenses to column R of Confirmed tab (only include things that have actually been recharged on an invoice)",
      "Update partner win fees in dashboard",
      "Send partners emails telling them the win fee amounts",
      "Create partner win fee accruals bills",
      "Update partner dashboard tab",
      "Tell Patrick and Gareth dashboard is updated",
      "Review transactions for VAT return"
    ],
    "Rascal": [
      "Complete Xero reconciliations (make list of invoices needed first)",
      "Check all cont. dir. costs updated and captured in conf & pipe for cash",
      "Create monthly management report",
      "Check balance sheet accounts (including wages payable, NICs, PAYE, stud. loan)",
      "Payroll prep",
      "Update BrightPay PAYE paid figure for prev month",
      "Download coding notices",
      "Payroll submission",
      "Payroll journal",
      "Ensure FPS submitted in BrightPay",
      "Pension contributions in Aviva portal",
      "Schedule salary payments"
    ],
    "Get Better": [
      "Import salaries info AND check employee list is accurate (Rippling - Reports - FY Salaries & Deductions (PAUL) - Change \"Date as of\" and \"Pay Run Name\" Filter Date - Download - IMPORT AS-IS (I FIXED THIS 18/8/26) ... OLD APPROACH WAS: CHANGE COLUMN HEADER NAMES TO REFLECT SHEET - DELETE EXTRANEOUS COLUMNS - SAVE AS JPEG AND IMPORT INTO AMD)",
      "Check and sort pipeline discrepancies (CRMComp)",
      "Check depreciation has been captured correctly - enter in Outgoings if not",
      "Send Patrick any queries and update dashboard accordingly",
      "Email Rich and Patrick to say it's ready"
    ],
    "ANRPR": [
      "Request closing bank account balances",
      "Check InvComp and DirComp",
      "Calculate corp tax and VAT amounts to transfer"
    ],
    "Starlight": [
      "Email Steve asking for payroll summary",
      "Send Steve any queries and update dashboard accordingly",
      "Email Steve to say Pulse is updated and ready"
    ],
    "GeoBrand": [
      "Email asking for payroll summary",
      "Send queries and update dashboard accordingly",
      "Email to say Pulse is updated and ready"
    ],
    "Seen": [
      "Email asking for payroll summary",
      "Send queries and update dashboard accordingly",
      "Calculate \"what salaries + divs should be\" figure",
      "Email to say Pulse is updated and ready, and provide salaries figure"
    ],
    "Hancock & Rowe": [
      "Use InvComp to make dashboard invoices match Xero",
      "Check confirmed income for prev month",
      "Update salaries",
      "Update contractors",
      "Update third party pass-through costs",
      "Create backup of dashboard in extension"
    ],
    "Astra": [
      "Check income for prev month - have we recognised income for all projects - particularly those working from prepayments?",
      "Review contractor costs for prev month - i.e. compare tracker to QB and flag any discrepancies",
      "Update outgoings based on QB and flag any issues with bookkeeping",
      "Overwrite dollar amounts with actuals on Rev and Cont tabs",
      "Finalise accounts in dashboard"
    ],
    "TaxWatch": [
      "Reconcile tracker against statements etc"
    ],
    "Meee": [
      "Approve bills in Xero"
    ],
    "Base Three": [
      "Check with Dania that pipeline is updated",
      "Update contractors based on QB numbers",
      "Update partner payments for previous month from QB + Dania",
      "Tell Dania dashboard is updated"
    ]
  }
};

// Converts a payroll period like "Aug 2026" (the format targetMonthStr uses
// throughout the payroll import flow) into the "YYYY-MM" format EoM's
// monthKey uses. Returns null if it can't confidently parse it — callers
// should treat that as "skip the auto-complete", not an error.
function monthStrToEomKey_(monthStr) {
  const monthAbbrs = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const parts = String(monthStr || "").trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const monthNum = monthAbbrs[parts[0].slice(0, 3).toLowerCase()];
  const year = parseInt(parts[1], 10);
  if (!monthNum || !year) return null;
  return `${year}-${String(monthNum).padStart(2, "0")}`;
}

// Inverse of the above — "2026-07" -> "Jul 2026". Used when a monthKey needs
// to be matched against a sheet header via isDateMatchJs_, which requires a
// 3-letter month abbreviation on both sides to compare, not a plain "YYYY-MM".
function eomKeyToMonthStr_(monthKey) {
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const parts = String(monthKey || "").split("-");
  if (parts.length !== 2) return null;
  const year = parseInt(parts[0], 10);
  const monthNum = parseInt(parts[1], 10);
  if (!year || !monthNum || monthNum < 1 || monthNum > 12) return null;
  return `${monthNames[monthNum - 1]} ${year}`;
}

// ============================================================================
// EoM WORK MONTH vs TARGET MONTH — the model every EoM tool must follow.
//
// The EoM checklist always shows the CURRENT calendar month as the "work
// month" — e.g. the checklist shows August while August is in progress.
// But the actual data being finalised during that work is always the
// month before it — the "target month" — e.g. July's books get finalised
// during August. This offset is FIXED (always exactly one month) and
// applies to every EoM tool without exception: payroll, cash balance,
// mark-actual, and anything built after this comment.
//
// The rule that matters: task DONE/PENDING status is always tracked
// against the WORK month. Real data (Performance tab, Cash tab, Salaries
// tab) is always written to the TARGET month. A tool only ever knows one
// of the two directly — it must derive the other using the functions
// below, NEVER by independently computing "today" or "today minus one".
// That independent-computation pattern is exactly what caused work month
// and target month to silently drift apart and stay wrong for two
// separate tools before this was fixed (19 Aug 2026) — each tool's own
// "today minus one" logic agreed with the others only by coincidence,
// and broke the moment one of them changed without the others.
function eomWorkMonthToTargetMonth_(workMonthKey) {
  const [y, m] = String(workMonthKey || "").split("-").map(Number);
  if (!y || !m) return null;
  const d = new Date(y, m - 1 - 1, 1); // one month before the work month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function eomTargetMonthToWorkMonth_(targetMonthKey) {
  const [y, m] = String(targetMonthKey || "").split("-").map(Number);
  if (!y || !m) return null;
  const d = new Date(y, m - 1 + 1, 1); // one month after the target month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
// ============================================================================

/**
 * Marks a client's EoM task done for a given WORK month, if that client
 * has an active task assigned from a template with the given
 * linkedFunction value (e.g. "salaries", "cash_balance", "mark_actual").
 * Extracted from the original inline salaries auto-complete (conversation
 * 18 Aug 2026) so every linked tool shares the exact same mechanism
 * rather than duplicating it.
 *
 * IMPORTANT: workMonthKey must be a WORK month, not a target month — if
 * the caller only has a target month (e.g. a payroll document's own
 * extracted period, or cash balance's target-month selector), it must
 * convert with eomTargetMonthToWorkMonth_ before calling this. Passing a
 * target month directly here is the exact bug fixed on 19 Aug 2026 — the
 * parameter name is deliberately explicit about this so it can't happen
 * by accident again.
 *
 * Deliberately swallows its own errors — callers wrap this so a failure
 * here never affects the actual action (payroll write, balance write) that
 * triggered it. Returns true if a task was found and marked, false
 * otherwise (including on error) — purely informational for logging.
 */
async function autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, clientName, linkedFunctionValue, workMonthKey) {
  try {
    if (!workMonthKey) return false;
    const [templatesR, clientTasksR] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:F1000" }),
      sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" }),
    ]);
    const linkedTemplateIds = new Set((templatesR.data.values || []).filter(r => r[0] && r[3] === linkedFunctionValue).map(r => r[0]));
    const linkedTask = (clientTasksR.data.values || []).find(r =>
      r[0] && r[1] === clientName && linkedTemplateIds.has(r[2]) && (r[5] !== "FALSE" && r[5] !== false)
    );
    if (!linkedTask) return false;

    const statusResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:E200000" });
    const statusRows = statusResp.data.values || [];
    const existingIdx = statusRows.findIndex(r => r[0] === clientName && r[1] === linkedTask[0] && r[2] === workMonthKey);
    if (existingIdx === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A:E", valueInputOption: "RAW",
        requestBody: { values: [[clientName, linkedTask[0], workMonthKey, "done", new Date().toISOString()]] },
      });
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `EomMonthlyStatus!D${existingIdx + 2}:E${existingIdx + 2}`,
        valueInputOption: "RAW", requestBody: { values: [["done", new Date().toISOString()]] },
      });
    }
    return true;
  } catch (e) {
    console.error("  autoCompleteLinkedEomTask_ error (non-fatal):", e.message);
    return false;
  }
}

async function ensureEomTabs_(sheets, spreadsheetId) {
  if (eomTabsVerified) return; // already confirmed on this warm instance — nothing can have changed
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
    const existingTitles = new Set(meta.data.sheets.map(s => s.properties.title));
    const toCreate = ["EomTemplates", "EomClientTasks", "EomMonthlyStatus", "EomBankAccounts", "EomExcludedClients"].filter(t => !existingTitles.has(t));

    if (toCreate.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: toCreate.map(title => ({ addSheet: { properties: { title } } })) },
      });

      const headerWrites = [];
      if (toCreate.includes("EomTemplates")) {
        headerWrites.push({ range: "EomTemplates!A1:H1", values: [["templateId", "name", "defaultNotes", "linkedFunction", "active", "createdAt", "alertCategories", "sortOrder"]] });
      }
      if (toCreate.includes("EomClientTasks")) {
        headerWrites.push({ range: "EomClientTasks!A1:H1", values: [["taskId", "clientName", "templateId", "taskName", "clientNotes", "active", "createdAt", "sortOrder"]] });
      }
      if (toCreate.includes("EomMonthlyStatus")) {
        headerWrites.push({ range: "EomMonthlyStatus!A1:E1", values: [["clientName", "taskId", "monthKey", "status", "completedAt"]] });
      }
      if (toCreate.includes("EomBankAccounts")) {
        headerWrites.push({ range: "EomBankAccounts!A1:C1", values: [["clientName", "accountName", "loadedAt"]] });
      }
      if (toCreate.includes("EomExcludedClients")) {
        headerWrites.push({ range: "EomExcludedClients!A1:C1", values: [["clientName", "excluded", "sortOrder"]] });
      }
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: "RAW", data: headerWrites },
      });
    }

    // sortOrder (column H) was added to EomClientTasks after that tab may
    // already have been created on a live sheet — patch the header label in
    // if it's missing, without disturbing anything else already there.
    if (!toCreate.includes("EomClientTasks")) {
      const h1 = await sheets.spreadsheets.values.get({ spreadsheetId, range: "EomClientTasks!H1" });
      if (!h1.data.values || !h1.data.values[0] || !h1.data.values[0][0]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId, range: "EomClientTasks!H1", valueInputOption: "RAW", requestBody: { values: [["sortOrder"]] },
        });
      }
    }
    // alertCategories (column G) was added to EomTemplates after that tab
    // may already have been created — same patch pattern as sortOrder above.
    if (!toCreate.includes("EomTemplates")) {
      const g1 = await sheets.spreadsheets.values.get({ spreadsheetId, range: "EomTemplates!G1" });
      if (!g1.data.values || !g1.data.values[0] || !g1.data.values[0][0]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId, range: "EomTemplates!G1", valueInputOption: "RAW", requestBody: { values: [["alertCategories"]] },
        });
      }
      const th1 = await sheets.spreadsheets.values.get({ spreadsheetId, range: "EomTemplates!H1" });
      if (!th1.data.values || !th1.data.values[0] || !th1.data.values[0][0]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId, range: "EomTemplates!H1", valueInputOption: "RAW", requestBody: { values: [["sortOrder"]] },
        });
      }
    }
    // EomExcludedClients gained "excluded" and "sortOrder" columns after
    // that tab may already have been created and populated (19 Aug 2026) —
    // under the old schema, a row's mere presence meant "excluded". Patch
    // the header in, and for any existing row with no explicit "excluded"
    // value yet, set it to TRUE — otherwise those clients would silently
    // stop being excluded the moment this ran, since the new read logic
    // checks the column explicitly rather than just row presence.
    if (!toCreate.includes("EomExcludedClients")) {
      const b1 = await sheets.spreadsheets.values.get({ spreadsheetId, range: "EomExcludedClients!B1" });
      if (!b1.data.values || !b1.data.values[0] || !b1.data.values[0][0]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId, range: "EomExcludedClients!B1:C1", valueInputOption: "RAW", requestBody: { values: [["excluded", "sortOrder"]] },
        });
        const existingRows = await sheets.spreadsheets.values.get({ spreadsheetId, range: "EomExcludedClients!A2:C1000" });
        const rows = existingRows.data.values || [];
        const migrateWrites = [];
        rows.forEach((r, i) => {
          if (r[0] && (r[1] === undefined || r[1] === "")) {
            migrateWrites.push({ range: `EomExcludedClients!B${i + 2}`, values: [[true]] });
          }
        });
        if (migrateWrites.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId, requestBody: { valueInputOption: "RAW", data: migrateWrites },
          });
        }
      }
    }
    eomTabsVerified = true;
  } catch (e) {
    console.error("ensureEomTabs_ error:", e.message);
  }
}

// Same warm-instance caching pattern as eomTabsVerified above — once
// confirmed on this instance, never needs re-checking.
let assignedExpensesTabVerified = false;

/**
 * Server-side replacement for the old localStorage-only "assigned expense"
 * tracking (conversation 19 Aug 2026) — one row per clientName+appId,
 * shared across devices/sessions rather than trapped in one browser.
 * AssignedExpenses columns: A=clientName, B=appId, C=assignedAt.
 */
async function ensureAssignedExpensesTab_(sheets, spreadsheetId) {
  if (assignedExpensesTabVerified) return;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
    const exists = meta.data.sheets.some(s => s.properties.title === "AssignedExpenses");
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: "AssignedExpenses" } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: "AssignedExpenses!A1:C1", valueInputOption: "RAW",
        requestBody: { values: [["clientName", "appId", "assignedAt"]] },
      });
    }
    assignedExpensesTabVerified = true;
  } catch (e) {
    console.error("ensureAssignedExpensesTab_ error:", e.message);
  }
}

function colLetterToNum(col) {
  return String(col).toUpperCase().split("").reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0);
}

// Get the sheetId (gid) for a named sheet tab
async function getSheetGid(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
  const sheet = meta.data.sheets?.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  return sheet.properties.sheetId;
}

// ============================================================================
// FLAG READING
// ============================================================================
// readFlagRules_ retired 23 Aug 2026 (Paul's direction) — the FlagRules
// sheet's comparison rules (increase/decrease/if true/if changed) only ever
// applied to the old count-based DataChgAlert comparison, which was removed
// once every remaining flag type had proper discrete detection instead.
// Nothing reads FlagRules any more; the sheet itself is left untouched.

/**
 * Reads the client list (name + sheet IDs) from AutoUpdates!A2:M — shared by
 * getClientFlags and run_flag_sweep, extracted 21 Aug 2026 so both use the
 * exact same list-building logic (including the header-row skip) rather
 * than two copies that could drift apart. rowIndex is the 0-based index
 * into the original A2:M read (row 2 = index 0) — needed by callers that
 * also bulk-read a parallel range (like flagRows in getClientFlags) and
 * must index into it the same way.
 */
function parseAutomationTime_(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/([A-Za-z]{3})\s+(\d{1,2})-([A-Za-z]{3})\s+(\d{2}):(\d{2})/);
  if (!m) return 0;
  const day = parseInt(m[2], 10);
  const monthStr = m[3].toLowerCase();
  const hrs = parseInt(m[4], 10);
  const mins = parseInt(m[5], 10);
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const month = months[monthStr];
  if (month === undefined) return 0;
  
  const now = new Date();
  let year = now.getFullYear();
  if (month === 11 && now.getMonth() === 0) year--;
  else if (month === 0 && now.getMonth() === 11) year++;
  
  // Calculate exact UTC time by neutralizing Vercel's UTC assumption vs the sheet's London time
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

function evaluateAutomationStatus_(alertType, category, clientMeta, detectedAtMs, firstSeenMs) {
  if (category !== "discrepancy") return "cached";
  if (!clientMeta) return "cached";
  
  // Failsafe: Use firstSeen if available to prevent an infinite 16-hour lock
  const baseTimeMs = firstSeenMs || detectedAtMs;
  
  const nowMs = Date.now();
  if ((nowMs - baseTimeMs) > 16 * 60 * 60 * 1000) return "cached"; // 16 hour failsafe

  let autoLastRun = 0;
  if (alertType.startsWith("invoice")) autoLastRun = clientMeta.invAutoLastRunMs;
  else if (alertType.startsWith("crm")) autoLastRun = clientMeta.crmAutoLastRunMs;
  else if (alertType.startsWith("expense")) autoLastRun = clientMeta.expAutoLastRunMs;
  else return "cached"; 

  if (autoLastRun === 0) return "cached"; // No run history recorded
  
  // Allow 60s leeway for exact matching
  if (autoLastRun >= (baseTimeMs - 60000)) return "cached";

  return "pending_automation";
}

async function readAutoUpdatesClientRows_(sheets, automationCommanderSheetId) {  const mainResponse = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: automationCommanderSheetId,
    range: "AutoUpdates!A2:AH1000",
  }));
  const rows = mainResponse.data.values || [];
  console.log(`📊 Total rows: ${rows.length}`);

  const clientRows = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sheetRowNum = i + 2;

    if (!row || row.length < 13) continue;

    const clientName = String(row[0] || "").trim();
    const scriptId    = String(row[10] || "").trim();
    const clientSheetUrl = row[11];
    const masterSheetUrl = row[12];
    const hasWebAppUrl = !!String(row[13] || "").trim(); // col N = Agent Web App URL

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
      invAutoLastRunMs: parseAutomationTime_(row[24]), // Col Y (Index 24)
      crmAutoLastRunMs: parseAutomationTime_(row[28]), // Col AC (Index 28)
      expAutoLastRunMs: parseAutomationTime_(row[32]), // Col AG (Index 32)
    });
  }
  return { rows, clientRows };
}

// ============================================================================
// ALERT SUMMARY BUILDING
// ============================================================================

// Build alert summary from InvComp data for display to user
function buildInvCompSummary(alert) {
  const accounting = alert.data.accounting || [];
  
  // DEBUG: Log raw values with ALL indices
  console.log(`\n🔍 buildInvCompSummary called`);
  console.log(`  accounting array length: ${accounting.length}`);
  console.log(`  accounting array contents:`);
  for (let i = 0; i < accounting.length; i++) {
    console.log(`    [${i}] = "${accounting[i]}"`);
  }
  
  // InvComp columns (A:K) - CORRECT MAPPING:
  // A: Client, B: Job, C: Invoice amount, D: Total excl VAT, E: VAT included,
  // F: Invoice no, G: Sent date, H: Due date, I: Fully paid on, J: Status, K: Currency
  const client = accounting[0] || '(unknown)';
  const job = accounting[1] || '';
  
  // CRITICAL FIX: Remove commas from number strings before parsing
  const invoiceAmount = parseFloat(String(accounting[2] || '0').replace(/,/g, '')) || 0; // Column C
  const totalExclVAT = parseFloat(String(accounting[3] || '0').replace(/,/g, '')) || 0; // Column D
  const vatIncluded = parseFloat(String(accounting[4] || '0').replace(/,/g, '')) || 0; // Column E
  
  const invoiceNo = accounting[5] || '(no reference)'; // Column F - Invoice no
  const sentDate = accounting[6] || ''; // Column G - Sent date
  const datePaid = accounting[8] || ''; // Column I - Fully paid on
  const status = accounting[9] || ''; // Column J - Status
  const currency = accounting[10] || 'GBP'; // Column K - Currency

  console.log(`  InvComp: invoiceNo="${invoiceNo}", amount=${totalExclVAT || invoiceAmount}, status="${status}", datePaid="${datePaid}"`);
  
  // Use Total excl VAT (Column D) as the primary amount
  const amount = totalExclVAT > 0 ? totalExclVAT : invoiceAmount;
  
  // Determine VAT indicator
  let vatSuffix = '';
  if (vatIncluded && vatIncluded > 0) {
    vatSuffix = ' + VAT';
  }
  
  const formattedAmount = amount > 0 
    ? `${currency}${amount.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2})}${vatSuffix}`
    : 'unknown amount';
  
  let summary = `Invoice ${invoiceNo} • ${formattedAmount} • ${client}`;
  if (job) summary += ` • ${job}`;
  if (sentDate) summary += ` • Sent ${sentDate}`;
  if (status) summary += ` • ${status}`;
  
  return {
    invoiceNo,
    amount,
    vatIncluded,
    currency,
    client,
    job,
    sentDate,
    datePaid,
    status,
    summary
  };
}

function buildDirCompSummary(alert) {
  const accounting = alert.data.accounting || [];

  // DirComp columns A:J (indices 0-9):
  // A=Date, B=Description, C=Amount, D=Reference, E=Account name,
  // F=Status, G=Transaction ID, H=Date Paid, I=VAT
  const date          = accounting[0] || '';
  const description   = accounting[1] || '';
  const amount        = parseFloat(String(accounting[2] || '0').replace(/,/g, '')) || 0;
  const reference     = accounting[3] || '';
  const accountName   = accounting[4] || '';
  const status        = accounting[5] || '';
  const transactionId = accounting[6] || '';
  const datePaid      = accounting[7] || '';
  const vatAmount     = accounting[8] || '';
  
  // Format the amount
  const formattedAmount = amount > 0 
    ? `£${amount.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`
    : '£0.00';
  
  // Build the summary string
  let summary = `Expense ${reference || date} • ${formattedAmount}`;
  if (description) {
    summary += ` • ${description}`;
  }
  if (accountName) {
    summary += ` • ${accountName}`;
  }
  if (date) {
    summary += ` • ${date}`;
  }
  
  return {
    reference,
    amount,
    description,
    date,
    accountName,
    status,
    transactionId,
    datePaid,
    vatAmount,
    summary
  };
}

// ============================================================================
// COMPARISON SHEET DATA READING
// ============================================================================

// Check if GAS automation is currently running for a given sequence type.
// AutoLog line prefixes for the 8 confirmed informational types (22 Aug
// 2026) — traced against the actual GAS source for 5 of them
// (1_Core_and_Xero.gs, 7_Cost_Sync.gs, 2_Internal_Sheet_Logic.gs); the
// three crmCopiedConf* patterns were supplied directly by Paul from his own
// tracing of runAgencyAutomator/_copyPipelineJobToConfirmed, not derived
// independently. Matched via .includes() rather than .startsWith() since
// some lines carry a "[SheetName]" prefix before the pattern and some
// don't. crmPipeSkippedBlank/crmConfSkippedBlank removed entirely per
// Paul's explicit confirmation (22 Aug 2026) — no longer tracked as flag
// types at all, not merely unmatched here.
const AUTOLOG_TYPE_PATTERNS = {
  // Fixed 23 Aug 2026 — the original patterns here ("Created Manual
  // Invoice:"/"Removed Manual Invoice") turned out to fire for BOTH
  // retainer AND project jobs: auditInvoiceGaps/runInvoiceSheetAudit_ reads
  // a "Project / retainer" type column but never actually used it to
  // distinguish its own logging, so every general invoice-gap-filling
  // event (any job type) matched here too — confirmed by Paul finding a
  // genuine project-side "invoice gap" event mislabelled as a retainer
  // alert. Paul confirmed he only wants retainer-specific events and
  // updated the GAS source (5_Agent_Receiver.gs) to genuinely distinguish
  // them via isRetainer/rowType checks — these patterns now match that
  // exact, new wording, not the old, ambiguous one.
  retainerInvoicesCreated:   ["Created Retainer Invoice", "Adjusted Retainer Invoice"],
  retainerInvoicesDeleted:   ["Removed Retainer Invoice"],
  expenseUnreconGaps:        ["Created Manual Gap:", "Changed Manual Gap:", "Removed Manual Gap"],
  expenseAdded:              ["Created New Row:"],
  invoiceStaleUnsentChanges: ["Stale Invoice - Row"],
  // AN2 — job copied Pipeline -> Confirmed. Includes the fail-safe
  // duplicate-skip line at Paul's explicit request (22 Aug 2026) — a
  // detected-duplicate skip is still a "checked" event worth surfacing,
  // even though no actual copy happened.
  crmCopiedConfChecked:      [
    "Copied Pipeline Project to Confirmed:",
    "Copied Pipeline Project (with",
    "Converted Pipeline Job to Confirmed Retainer:",
    "Skipped Copy: Job with Project Code",
  ],
  // AO2 — source CRM reverted a job's copied status from Yes back to No.
  // Matched on the row-level log line (one per job), not the summary line
  // at the bottom of the AutoLog entry that lists multiple IDs together —
  // the row-level line is what gives each reversion its own discrete
  // identity to fingerprint.
  crmCopiedConfUnchecked:    ["Copied Status: 'Yes' -> 'No' (Reverted by Source)"],
  // AP2 — CRM passed a DELETE command for a Confirmed job. Same reasoning
  // as above: row-level line, not either of the two summary lines.
  crmCopiedConfDelete:       ["Deleted Confirmed Job: Row"],
};

/**
 * Reads the most recent AutoLog rows for a client's master sheet — newest
 * always at row 2, per the actual writeToAutoLog implementation (confirmed
 * 22 Aug 2026, 1_Core_and_Xero.gs), not assumed. Each row's Details text
 * can bundle multiple distinct log lines from one automation run
 * (joined with "\n\n"), so this returns the raw rows for the caller to
 * split and match against known patterns — matching isn't this function's
 * job, since different callers may want different patterns.
 */
async function readRecentAutoLogEntries_(sheets, masterSheetId, limit = 30, cachedData = null) {
  try {
    let rows = [];
    if (cachedData) {
      rows = cachedData.slice(0, limit);
    } else {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: `AutoLog!A2:D${limit + 1}`,
      });
      rows = resp.data.values || [];
    }
    return rows.map(row => ({
      timestamp: row[0] || "",
      category: row[1] || "",
      summary: row[2] || "",
      details: row[3] || "",
    }));
  } catch (err) {
    // Tab may not exist yet for a client with no automation runs logged —
    // not an error worth surfacing per-client, just no entries to check.
    return [];
  }
}

// Reads DataChgAlert tab of the master sheet:
//   Invoices: B4 (flag), C4 (timestamp)
//   Expenses: F4 (flag), G4 (timestamp)
//   CRM:      H4 (flag), I4 (timestamp)
// Returns { locked: false } if safe to proceed, or { locked: true, message: "..." } if GAS is running.
// Flags older than 30 minutes are treated as stale and ignored.
const GAS_LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

async function checkAllGASLocks(sheets, masterSheetId, cachedData = null) {
  const result = { invoice: { locked: false }, expense: { locked: false }, crm: { locked: false } };
  if (!masterSheetId) return result;
  try {
    let row = [];
    if (cachedData) {
      row = cachedData[0] || [];
    } else {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: "DataChgAlert!B4:I4",
      });
      row = (resp.data.values || [[]])[0] || [];
    }
    const check = async (fIdx, tIdx, name, fCell, tCell) => {
      const flag = String(row[fIdx] || "").trim().toUpperCase();
      const tsRaw = row[tIdx];
      if (flag !== "YES") return { locked: false };
      if (tsRaw) {
        const tsDate = new Date(tsRaw);
        if (!isNaN(tsDate) && (Date.now() - tsDate.getTime()) > GAS_LOCK_STALE_MS) {
          console.log(`  ⚠️ GAS lock for ${name} is stale — clearing`);
          try {
            await sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: masterSheetId,
              requestBody: {
                data: [
                  { range: `DataChgAlert!${fCell}`, values: [["NO"]] },
                  { range: `DataChgAlert!${tCell}`, values: [[""]] },
                ],
                valueInputOption: "RAW"
              }
            });
          } catch (e) {}
          return { locked: false };
        }
      }
      return { locked: true, message: `The ${name} automation sequence is currently running for this client.` };
    };
    result.invoice = await check(0, 1, "invoice", "B4", "C4");
    result.expense = await check(4, 5, "expense", "F4", "G4");
    result.crm = await check(6, 7, "crm", "H4", "I4");
  } catch (e) {
    console.log(`  ⚠️ Could not read GAS locks: ${e.message} — proceeding anyway`);
  }
  return result;
}

// ============================================================================
// PROACTIVE ALERTS — storage helpers
// ============================================================================
// ensureProactiveAlertsTab/readProactiveAlerts retired 23 Aug 2026 (Paul's
// explicit direction) — every action that used them (store_proactive_alerts,
// get_proactive_alerts, acknowledge/bulk_acknowledge_proactive_alerts,
// resolve_proactive_alert, create_task) now reads and writes AlertMemory
// exclusively. The ProactiveAlerts tab itself is left untouched — this only
// retires the code path, not the sheet data, which is Paul's own call.

const SWEEP_SCHEDULE_TAB = "SweepSchedule";
// Defaults preserve exactly today's behaviour until Paul changes them via
// the Settings page — actionable/info both currently run every 30 minutes
// (the same run_flag_sweep call), proactive currently runs once daily.
const SWEEP_SCHEDULE_DEFAULTS = {
  actionable: 30,
  info: 30,
  proactive: 1440,
};

async function ensureSweepScheduleTab(sheets, automationCommanderSheetId) {
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${SWEEP_SCHEDULE_TAB}!A1`,
    });
  } catch (err) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: automationCommanderSheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: SWEEP_SCHEDULE_TAB } } }] },
      });
      // lastCheckedAt starts blank for all three default rows — no timestamp needed here.
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId,
        range: `${SWEEP_SCHEDULE_TAB}!A1:C4`,
        valueInputOption: "RAW",
        requestBody: { values: [
          ["category", "frequencyMinutes", "lastCheckedAt"],
          ["actionable", SWEEP_SCHEDULE_DEFAULTS.actionable, ""],
          ["info", SWEEP_SCHEDULE_DEFAULTS.info, ""],
          ["proactive", SWEEP_SCHEDULE_DEFAULTS.proactive, ""],
        ] },
      });
      console.log(`✅ Created ${SWEEP_SCHEDULE_TAB} tab with default frequencies`);
    } catch (createErr) {
      console.log(`⚠️ Could not create ${SWEEP_SCHEDULE_TAB} tab: ${createErr.message}`);
    }
  }
}

// Returns { actionable: { rowIndex, frequencyMinutes, lastCheckedAt }, info: {...}, proactive: {...} }
// Missing categories (e.g. a row deleted by hand) fall back to defaults with
// no rowIndex — isCategoryDue_ below treats that as "always due" rather than
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
// lastCheckedAt is treated as "always due" — safer than silently never
// running a category because of a malformed timestamp.
function isCategoryDue_(categoryEntry) {
  if (!categoryEntry.lastCheckedAt) return true;
  const last = new Date(categoryEntry.lastCheckedAt);
  if (isNaN(last.getTime())) return true;
  const elapsedMinutes = (Date.now() - last.getTime()) / 60000;
  return elapsedMinutes >= categoryEntry.frequencyMinutes;
}

// Updates lastCheckedAt for one category — creates the row if it doesn't
// exist yet (e.g. schedule tab was just created, or a row was deleted by
// hand), rather than silently failing to persist the timestamp.
async function markCategoryChecked_(sheets, automationCommanderSheetId, category, schedule) {
  const nowISO = new Date().toISOString();
  const entry = schedule[category];
  if (entry && entry.rowIndex) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: automationCommanderSheetId,
      range: `${SWEEP_SCHEDULE_TAB}!C${entry.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[nowISO]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${SWEEP_SCHEDULE_TAB}!A:C`,
      valueInputOption: "RAW",
      requestBody: { values: [[category, (entry && entry.frequencyMinutes) || SWEEP_SCHEDULE_DEFAULTS[category] || 30, nowISO]] },
    });
  }
}

async function ensureProactiveCheckLogTab(sheets, automationCommanderSheetId) {
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PROACTIVE_CHECK_LOG_TAB}!A1`,
    });
  } catch (err) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: automationCommanderSheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: PROACTIVE_CHECK_LOG_TAB } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId,
        range: `${PROACTIVE_CHECK_LOG_TAB}!A1:E1`,
        valueInputOption: "RAW",
        requestBody: { values: [[
          "runAt", "clientsChecked", "newAlerts", "updatedAlerts", "dismissedAlerts",
        ]] },
      });
      console.log(`✅ Created ${PROACTIVE_CHECK_LOG_TAB} tab`);
    } catch (createErr) {
      console.log(`⚠️ Could not create ${PROACTIVE_CHECK_LOG_TAB} tab: ${createErr.message}`);
    }
  }
}

// Appends one run-summary row and trims the log to the most recent 30 entries,
// so this tab stays small (nightly runs = ~1 row/day, capped at ~1 month).
async function logProactiveCheckRun(sheets, automationCommanderSheetId, { clientsChecked, newAlerts, updatedAlerts, dismissedAlerts }) {
  try {
    await ensureProactiveCheckLogTab(sheets, automationCommanderSheetId);
    const nowISO = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${PROACTIVE_CHECK_LOG_TAB}!A:E`,
      valueInputOption: "RAW",
      requestBody: { values: [[nowISO, clientsChecked || 0, newAlerts || 0, updatedAlerts || 0, dismissedAlerts || 0]] },
    });
    // Trim to most recent 30 rows (plus header)
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PROACTIVE_CHECK_LOG_TAB}!A:A`,
    });
    const rowCount = (resp.data.values || []).length;
    if (rowCount > 31) {
      const deleteCount = rowCount - 31;
      const meta = await sheets.spreadsheets.get({ spreadsheetId: automationCommanderSheetId, fields: "sheets.properties" });
      const sheetMeta = meta.data.sheets.find(s => s.properties.title === PROACTIVE_CHECK_LOG_TAB);
      if (sheetMeta) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: automationCommanderSheetId,
          requestBody: { requests: [{
            deleteDimension: { range: { sheetId: sheetMeta.properties.sheetId, dimension: "ROWS", startIndex: 1, endIndex: 1 + deleteCount } },
          }] },
        });
      }
    }
  } catch (err) {
    console.log(`⚠️ Could not log proactive check run: ${err.message}`);
  }
}

async function readProactiveCheckLog(sheets, automationCommanderSheetId, limit = 10) {
  try {
    await ensureProactiveCheckLogTab(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PROACTIVE_CHECK_LOG_TAB}!A:E`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return [];
    return rows.slice(1).map(row => ({
      runAt: row[0] || "",
      clientsChecked: parseInt(row[1]) || 0,
      newAlerts: parseInt(row[2]) || 0,
      updatedAlerts: parseInt(row[3]) || 0,
      dismissedAlerts: parseInt(row[4]) || 0,
    })).reverse().slice(0, limit); // most recent first
  } catch (err) {
    console.log(`⚠️ Could not read ${PROACTIVE_CHECK_LOG_TAB}: ${err.message}`);
    return [];
  }
}

async function ensureFlagSweepLogTab(sheets, automationCommanderSheetId) {
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${FLAG_SWEEP_LOG_TAB}!A1`,
    });
    // Ensure headers H and I exist for alertsDelayed and alertsWoken
    const i1 = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: `${FLAG_SWEEP_LOG_TAB}!I1` });
    if (!i1.data.values || !i1.data.values[0] || !i1.data.values[0][0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `${FLAG_SWEEP_LOG_TAB}!G1:I1`,
        valueInputOption: "RAW", requestBody: { values: [["categoriesRun", "alertsDelayed", "alertsWoken"]] },
      });
    }
  } catch (err) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: automationCommanderSheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: FLAG_SWEEP_LOG_TAB } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId,
        range: `${FLAG_SWEEP_LOG_TAB}!A1:I1`,
        valueInputOption: "RAW",
        requestBody: { values: [[
          "runAt", "clientsChecked", "flagsRaised", "errors", "elapsedSeconds", "raisedDetailJSON", "categoriesRun", "alertsDelayed", "alertsWoken"
        ]] },
      });
      console.log(`✅ Created ${FLAG_SWEEP_LOG_TAB} tab`);
    } catch (createErr) {
      console.log(`⚠️ Could not create ${FLAG_SWEEP_LOG_TAB} tab: ${createErr.message}`);
    }
  }
}

// Appends one run-summary row and trims the log to the most recent 200
// entries. Same pattern as logProactiveCheckRun, but a larger cap — this
// runs every 30 min (not nightly), so 200 entries covers roughly 4 days,
// comparable real-world coverage to the proactive log's 30 nightly runs.
// raisedDetail is an array of { clientName, flagKey } — Paul specifically
// asked to see which flags were raised, not just a count (21 Aug 2026).
async function logFlagSweepRun(sheets, automationCommanderSheetId, { clientsChecked, flagsRaised, errors, alertsDelayed, alertsWoken, elapsedSeconds, raisedDetail, isContinuation, categoriesRun }) {
  try {
    await ensureFlagSweepLogTab(sheets, automationCommanderSheetId);

    if (isContinuation) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: automationCommanderSheetId,
        range: `${FLAG_SWEEP_LOG_TAB}!A:I`,
      });
      const rows = resp.data.values || [];
      if (rows.length > 1) {
        const lastRowIdx = rows.length; // 1-indexed (e.g., if array length is 2, the last row is sheet row 2)
        const lastRow = rows[rows.length - 1];

        const prevChecked = parseInt(lastRow[1], 10) || 0;
        const prevRaised = parseInt(lastRow[2], 10) || 0;
        const prevErrors = parseInt(lastRow[3], 10) || 0;
        const prevElapsed = parseInt(lastRow[4], 10) || 0;
        let prevDetail = [];
        try { prevDetail = JSON.parse(lastRow[5] || "[]"); } catch (e) {}
        
        const prevDelayed = parseInt(lastRow[7], 10) || 0;
        const prevWoken = parseInt(lastRow[8], 10) || 0;

        await sheets.spreadsheets.values.update({
          spreadsheetId: automationCommanderSheetId,
          range: `${FLAG_SWEEP_LOG_TAB}!B${lastRowIdx}:I${lastRowIdx}`,
          valueInputOption: "RAW",
          requestBody: { values: [[
            prevChecked + (clientsChecked || 0),
            prevRaised + (flagsRaised || 0),
            prevErrors + (errors || 0),
            prevElapsed + (elapsedSeconds || 0),
            JSON.stringify(prevDetail.concat(raisedDetail || [])),
            categoriesRun || lastRow[6] || "",
            prevDelayed + (alertsDelayed || 0),
            prevWoken + (alertsWoken || 0)
          ]] },
        });
        return; // Exit here; we updated the existing log row
      }
    }

    const nowISO = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${FLAG_SWEEP_LOG_TAB}!A:I`,
      valueInputOption: "RAW",
      requestBody: { values: [[
        nowISO, clientsChecked || 0, flagsRaised || 0, errors || 0, elapsedSeconds || 0,
        JSON.stringify(raisedDetail || []), categoriesRun || "", alertsDelayed || 0, alertsWoken || 0
      ]] },
    });
    // Trim to most recent 200 rows (plus header)
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${FLAG_SWEEP_LOG_TAB}!A:A`,
    });
    const rowCount = (resp.data.values || []).length;
    if (rowCount > 201) {
      const deleteCount = rowCount - 201;
      const meta = await sheets.spreadsheets.get({ spreadsheetId: automationCommanderSheetId, fields: "sheets.properties" });
      const sheetMeta = meta.data.sheets.find(s => s.properties.title === FLAG_SWEEP_LOG_TAB);
      if (sheetMeta) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: automationCommanderSheetId,
          requestBody: { requests: [{
            deleteDimension: { range: { sheetId: sheetMeta.properties.sheetId, dimension: "ROWS", startIndex: 1, endIndex: 1 + deleteCount } },
          }] },
        });
      }
    }
  } catch (err) {
    console.log(`⚠️ Could not log flag sweep run: ${err.message}`);
  }
}

async function readFlagSweepLog(sheets, automationCommanderSheetId, limit = 20) {
  try {
    await ensureFlagSweepLogTab(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${FLAG_SWEEP_LOG_TAB}!A:I`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return [];
    return rows.slice(1).map(row => {
      let raisedDetail = [];
      try { raisedDetail = JSON.parse(row[5] || "[]"); } catch (e) { /* malformed row, treat as empty */ }
      return {
        runAt: row[0] || "",
        clientsChecked: parseInt(row[1]) || 0,
        flagsRaised: parseInt(row[2]) || 0,
        errors: parseInt(row[3]) || 0,
        elapsedSeconds: parseInt(row[4]) || 0,
        raisedDetail,
        categoriesRun: row[6] || "",
        alertsDelayed: parseInt(row[7]) || 0,
        alertsWoken: parseInt(row[8]) || 0,
      };
    }).reverse().slice(0, limit); // most recent first
  } catch (err) {
    console.log(`⚠️ Could not read ${FLAG_SWEEP_LOG_TAB}: ${err.message}`);
    return [];
  }
}

async function ensurePrecomputeLogTab(sheets, automationCommanderSheetId) {
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PRECOMPUTE_LOG_TAB}!A1`,
    });
    // Ensure header F and G exist for the new proactiveCount
    const f1 = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: `${PRECOMPUTE_LOG_TAB}!F1` });
    if (!f1.data.values || !f1.data.values[0] || f1.data.values[0][0] !== "proactiveCount") {
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `${PRECOMPUTE_LOG_TAB}!F1:G1`,
        valueInputOption: "RAW", requestBody: { values: [["proactiveCount", "clientDetailJSON"]] },
      });
    }
  } catch (err) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: automationCommanderSheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: PRECOMPUTE_LOG_TAB } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId,
        range: `${PRECOMPUTE_LOG_TAB}!A1:G1`,
        valueInputOption: "RAW",
        requestBody: { values: [[
          "runAt", "clientsWithFlags", "totalAlerts", "noActionCount", "analysisCount", "proactiveCount", "clientDetailJSON",
        ]] },
      });
      console.log(`✅ Created ${PRECOMPUTE_LOG_TAB} tab`);
    } catch (createErr) {
      console.log(`⚠️ Could not create ${PRECOMPUTE_LOG_TAB} tab: ${createErr.message}`);
    }
  }
}

// Logs each store_precomputed run — the other end of the pipeline from
// FlagSweepLog: run_flag_sweep raises flags, this records what the
// precompute stage then built from them and cached for the app to load.
// Added 21 Aug 2026 at Paul's request, so the two logs together show the
// whole pipeline end to end rather than just the flag-raising half.
// clientDetail is an array of { clientName, alertCount, noActionCount } —
// logged post-merge (after the clientId/clientName reconciliation this
// action already does), so this reflects what actually got cached, not the
// raw input from the GAS side.
async function logPrecomputeRun(sheets, automationCommanderSheetId, { clientsWithFlags, totalAlerts, noActionCount, analysisCount, proactiveCount, clientDetail }) {
  try {
    await ensurePrecomputeLogTab(sheets, automationCommanderSheetId);
    const nowISO = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${PRECOMPUTE_LOG_TAB}!A:G`,
      valueInputOption: "RAW",
      requestBody: { values: [[
        nowISO, clientsWithFlags || 0, totalAlerts || 0, noActionCount || 0, analysisCount || 0, proactiveCount || 0,
        JSON.stringify(clientDetail || []),
      ]] },
    });
    // Trim to most recent 200 rows (plus header) — same cadence reasoning as
    // FlagSweepLog: this runs on the same schedule as run_flag_sweep once
    // the GAS side calls it that often, so a comparable cap.
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PRECOMPUTE_LOG_TAB}!A:A`,
    });
    const rowCount = (resp.data.values || []).length;
    if (rowCount > 201) {
      const deleteCount = rowCount - 201;
      const meta = await sheets.spreadsheets.get({ spreadsheetId: automationCommanderSheetId, fields: "sheets.properties" });
      const sheetMeta = meta.data.sheets.find(s => s.properties.title === PRECOMPUTE_LOG_TAB);
      if (sheetMeta) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: automationCommanderSheetId,
          requestBody: { requests: [{
            deleteDimension: { range: { sheetId: sheetMeta.properties.sheetId, dimension: "ROWS", startIndex: 1, endIndex: 1 + deleteCount } },
          }] },
        });
      }
    }
  } catch (err) {
    console.log(`⚠️ Could not log precompute run: ${err.message}`);
  }
}

async function readPrecomputeLog(sheets, automationCommanderSheetId, limit = 20) {
  try {
    await ensurePrecomputeLogTab(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PRECOMPUTE_LOG_TAB}!A:G`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return [];
    return rows.slice(1).map(row => {
      // Backward compatibility: if row[5] is JSON, it's the old format without proactiveCount
      let isOldFormat = false;
      try { if (row[5] && (row[5].startsWith("[") || row[5].startsWith("{"))) isOldFormat = true; } catch(e){}
      
      let clientDetail = [];
      try { clientDetail = JSON.parse(isOldFormat ? (row[5] || "[]") : (row[6] || "[]")); } catch (e) { /* malformed */ }
      
      return {
        runAt: row[0] || "",
        clientsWithFlags: parseInt(row[1]) || 0,
        totalAlerts: parseInt(row[2]) || 0,
        noActionCount: parseInt(row[3]) || 0,
        analysisCount: parseInt(row[4]) || 0,
        proactiveCount: isOldFormat ? 0 : (parseInt(row[5]) || 0),
        clientDetail,
      };
    }).reverse().slice(0, limit); // most recent first
  } catch (err) {
    console.log(`⚠️ Could not read ${PRECOMPUTE_LOG_TAB}: ${err.message}`);
    return [];
  }
}

async function ensureBuildOptionsLogTab(sheets, automationCommanderSheetId) {
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${BUILD_OPTIONS_LOG_TAB}!A1`,
    });
    // Ensure header G exists for the new detail JSON
    const g1 = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: `${BUILD_OPTIONS_LOG_TAB}!G1` });
    if (!g1.data.values || !g1.data.values[0] || !g1.data.values[0][0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId, range: `${BUILD_OPTIONS_LOG_TAB}!G1`,
        valueInputOption: "RAW", requestBody: { values: [["builtDetailJSON"]] },
      });
    }
  } catch (err) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: automationCommanderSheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: BUILD_OPTIONS_LOG_TAB } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId,
        range: `${BUILD_OPTIONS_LOG_TAB}!A1:G1`,
        valueInputOption: "RAW",
        requestBody: { values: [[
          "runAt", "processed", "built", "notFound", "errors", "elapsedSeconds", "builtDetailJSON"
        ]] },
      });
      console.log(`✅ Created ${BUILD_OPTIONS_LOG_TAB} tab`);
    } catch (createErr) {
      console.log(`⚠️ Could not create ${BUILD_OPTIONS_LOG_TAB} tab: ${createErr.message}`);
    }
  }
}

async function logBuildOptionsRun(sheets, automationCommanderSheetId, { processed, built, notFound, errors, elapsedSeconds, builtDetail, isContinuation }) {
  try {
    await ensureBuildOptionsLogTab(sheets, automationCommanderSheetId);

    if (isContinuation) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: automationCommanderSheetId,
        range: `${BUILD_OPTIONS_LOG_TAB}!A:G`,
      });
      const rows = resp.data.values || [];
      if (rows.length > 1) {
        const lastRowIdx = rows.length; // 1-indexed
        const lastRow = rows[rows.length - 1];

        const prevProcessed = parseInt(lastRow[1], 10) || 0;
        const prevBuilt = parseInt(lastRow[2], 10) || 0;
        const prevNotFound = parseInt(lastRow[3], 10) || 0;
        const prevErrors = parseInt(lastRow[4], 10) || 0;
        const prevElapsed = parseInt(lastRow[5], 10) || 0;
        let prevDetail = [];
        try { prevDetail = JSON.parse(lastRow[6] || "[]"); } catch (e) {}

        await sheets.spreadsheets.values.update({
          spreadsheetId: automationCommanderSheetId,
          range: `${BUILD_OPTIONS_LOG_TAB}!B${lastRowIdx}:G${lastRowIdx}`,
          valueInputOption: "RAW",
          requestBody: { values: [[
            Math.max(prevProcessed, processed || 0),
            prevBuilt + (built || 0),
            prevNotFound + (notFound || 0),
            prevErrors + (errors || 0),
            prevElapsed + (elapsedSeconds || 0),
            JSON.stringify(prevDetail.concat(builtDetail || []))
          ]] },
        });
        return; // Exit here; we updated the existing log row
      }
    }

    const nowISO = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${BUILD_OPTIONS_LOG_TAB}!A:G`,
      valueInputOption: "RAW",
      requestBody: { values: [[
        nowISO, processed || 0, built || 0, notFound || 0, errors || 0, elapsedSeconds || 0, JSON.stringify(builtDetail || [])
      ]] },
    });
    // Trim to most recent 200 rows (plus header)
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${BUILD_OPTIONS_LOG_TAB}!A:A`,
    });
    const rowCount = (resp.data.values || []).length;
    if (rowCount > 201) {
      const deleteCount = rowCount - 201;
      const meta = await sheets.spreadsheets.get({ spreadsheetId: automationCommanderSheetId, fields: "sheets.properties" });
      const sheetMeta = meta.data.sheets.find(s => s.properties.title === BUILD_OPTIONS_LOG_TAB);
      if (sheetMeta) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: automationCommanderSheetId,
          requestBody: { requests: [{
            deleteDimension: { range: { sheetId: sheetMeta.properties.sheetId, dimension: "ROWS", startIndex: 1, endIndex: 1 + deleteCount } },
          }] },
        });
      }
    }
  } catch (err) {
    console.log(`⚠️ Could not log build options run: ${err.message}`);
  }
}

async function readBuildOptionsLog(sheets, automationCommanderSheetId, limit = 20) {
  try {
    await ensureBuildOptionsLogTab(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${BUILD_OPTIONS_LOG_TAB}!A:G`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return [];
    return rows.slice(1).map(row => {
      let builtDetail = [];
      try { builtDetail = JSON.parse(row[6] || "[]"); } catch (e) { }
      return {
        runAt: row[0] || "",
        processed: parseInt(row[1]) || 0,
        built: parseInt(row[2]) || 0,
        notFound: parseInt(row[3]) || 0,
        errors: parseInt(row[4]) || 0,
        elapsedSeconds: parseInt(row[5]) || 0,
        builtDetail,
      };
    }).reverse().slice(0, limit); // most recent first
  } catch (err) {
    console.log(`⚠️ Could not read ${BUILD_OPTIONS_LOG_TAB}: ${err.message}`);
    return [];
  }
}
async function readInvCompAlerts(sheets, spreadsheetId, cachedData = null) {
  try {
    console.log(`\n📖 Reading InvComp alerts from ${spreadsheetId}...`);
    
    let allRows = [];
    if (cachedData) {
      allRows = cachedData;
      console.log(`  ✓ Used batched InvComp data`);
    } else {
      // Switch is permanent; removed setMasterSwitch to save quota
      const dataResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "InvComp!A5:Y1000",
      });
      allRows = dataResponse.data.values || [];
    }
    const headers = allRows[0] || [];
    const rows = allRows.slice(1);
    console.log(`  InvComp: ${rows.length} rows read`);

    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;

      const hasDiscrepancy = [18, 19, 20, 21, 23, 24].some(
        (idx) => String(row[idx] || "").trim() === "1"
      );

      if (hasDiscrepancy) {
        const alert = {
          type: "invoice",
          sheetName: "InvComp",
          rowNumber: 6 + rowIdx,
          data: {
            accounting: (() => { const s = row.slice(0, 11); while (s.length < 11) s.push(""); return s; })(),
            confirmed:  (() => { const s = row.slice(12, 18); while (s.length < 6) s.push(""); return s; })(),
            flags: (() => { const s = row.slice(18, 25); while (s.length < 7) s.push(""); return s; })(),
          },
          flagColumns: headers.slice(18, 25),
        };
        alert.summary = buildInvCompSummary(alert);
        alerts.push(alert);
      }
    }

    console.log(`  ✓ InvComp: ${alerts.length} alerts`);
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading InvComp alerts:`, error);
    throw error;
  }
}

async function readDirCompAlerts(sheets, spreadsheetId, cachedData = null) {
  try {
    console.log(`\n📖 Reading DirComp alerts from ${spreadsheetId}...`);
    
    let allRows = [];
    if (cachedData) {
      allRows = cachedData;
      console.log(`  ✓ Used batched DirComp data`);
    } else {
      // Switch is permanent; removed setMasterSwitch to save quota
      const dataResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "DirComp!A5:AV1000",
      });
      allRows = dataResponse.data.values || [];
    }
    const headers = allRows[0] || [];
    const rows = allRows.slice(1);
    console.log(`  DirComp: ${rows.length} rows read`);

    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;

      const hasDiscrepancy = [40, 42, 43, 44, 45, 46, 47].some(
        (idx) => String(row[idx] || "").trim() === "1"
      );

      if (hasDiscrepancy) {
        const alert = {
          type: "expense",
          sheetName: "DirComp",
          rowNumber: 7 + rowIdx,
          data: {
            accounting: (() => { const s = row.slice(0, 10); while (s.length < 10) s.push(""); return s; })(),
            confirmed:  (() => { const s = row.slice(23, 34); while (s.length < 11) s.push(""); return s; })(),
            flags: (() => { const s = row.slice(40, 48); while (s.length < 8) s.push(""); return s; })(),
          },
          flagColumns: headers.slice(40, 48),
        };
        alert.summary = buildDirCompSummary(alert);
        alerts.push(alert);
      }
    }

    console.log(`  ✓ DirComp: ${alerts.length} alerts`);
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading DirComp alerts:`, error);
    throw error;
  }
}

async function readCRMCompAlerts(sheets, spreadsheetId, mode, alertTypes, masterSheetId) {
  try {
    console.log(`\n📖 Reading CRMComp alerts (${mode} mode) for ${alertTypes.join(", ")}...`);

    // Read DataChgAlert triage settings once per client
    // Rows 59-66 = dashboard (col C = pipeline, col F = confirmed)
    // Rows 72-79 = CRM compare (col C = pipeline, col F = confirmed)
    let triageSettings = null;
    const dcaSheetId = masterSheetId || spreadsheetId;
    try {
      const batchResp = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: dcaSheetId,
        ranges: [
          "DataChgAlert!C59:C66",
          "DataChgAlert!F59:F66",
          "DataChgAlert!C72:C79",
          "DataChgAlert!F72:F79"
        ]
      });
      const ranges = batchResp.data.valueRanges || [];
      const SETTING_ROWS = ["missing_job","client_mismatch","job_name_mismatch","revenue_mismatch",
                            "direct_costs_mismatch","start_date_mismatch","end_date_mismatch","likelihood_mismatch"];
      const parseSettings = (vals) => {
        const s = {};
        SETTING_ROWS.forEach((k, i) => {
          const v = String((vals[i] || [])[0] || "").trim().toLowerCase();
          s[k] = v !== "ignore";
        });
        return s;
      };
      triageSettings = {
        dashPipe: parseSettings(ranges[0]?.values || []),
        dashConf: parseSettings(ranges[1]?.values || []),
        crmPipe:  parseSettings(ranges[2]?.values || []),
        crmConf:  parseSettings(ranges[3]?.values || []),
      };
      console.log(`  ✓ DataChgAlert settings loaded`);
    } catch(e) {
      console.log(`  ⚠ Could not read DataChgAlert settings: ${e.message} — including all discrepancy types`);
    }

    // Set CRM mode
    console.log(`  Setting B2 = "${mode}" in CRMComp...`);
    await setCRMMode(sheets, spreadsheetId, mode);
    console.log(`  ✓ Mode set`);

    // Switch is permanently on; removed setMasterSwitch to save quota

    const alerts = [];
    
    // Batch read both Dash and App ranges to save quota
    let dashData = [];
    let appData = [];
    try {
      const batchResp = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: ["CRMComp!X6:BF1000", "CRMComp!EF6:FL1000"],
        valueRenderOption: "FORMATTED_VALUE"
      });
      dashData = batchResp.data.valueRanges[0].values || [];
      appData = batchResp.data.valueRanges[1].values || [];
    } catch(e) {
      console.log(`  ⚠️ Failed to batchGet CRMComp: ${e.message}`);
    }

    for (const alertType of alertTypes) {
      console.log(`  Processing ${alertType}...`);
      let dataRange, crmDataCols, sheetDataCols, flagCols, flagStartIdx;

      // Select settings block for this alert type
      const isDash = alertType === "crmPipeDashDiscr" || alertType === "crmConfDashDiscr";
      const isPipe = alertType === "crmPipeDashDiscr" || alertType === "crmPipeAppDiscr";
      const settingsBlock = triageSettings
        ? (isDash ? (isPipe ? triageSettings.dashPipe : triageSettings.dashConf)
                  : (isPipe ? triageSettings.crmPipe  : triageSettings.crmConf))
        : null;

      if (mode === "Pipeline") {
        if (alertType === "crmPipeDashDiscr") {
          // Left section: X:AJ (CRM data, 13 cols), AK:AN gap (4 cols), AO:AW (sheet data, 9 cols), AX gap, AY:BF (flags, 8 cols)
          // Relative to X (col 24): CRM=0-12, gap=13-16, sheetData=17-25, gap=26, flags=27-34
          dataRange = "CRMComp!X6:BF1000";
          crmDataCols   = [0, 13];  // X:AJ  (indices 0-12)
          sheetDataCols = [17, 26]; // AO:AW (indices 17-25)
          flagCols      = [27, 35]; // AY:BF (indices 27-34)
          flagStartIdx  = 27;
        } else if (alertType === "crmPipeAppDiscr") {
          // EF:ER = sheet data (13 cols, indices 0-12), ES:ET = gap (2), EU:FD = CRM data (10, indices 15-24)
          // FE = missing job flag (index 25), FF:FL = field mismatch flags (indices 26-32)
          dataRange = "CRMComp!EF6:FL1000";
          sheetDataCols = [0, 13];  // EF:ER (indices 0-12)
          crmDataCols   = [15, 25]; // EU:FD (indices 15-24)
          flagCols      = [25, 33]; // FE:FL (indices 25-32)
          flagStartIdx  = 25;
        }
      } else if (mode === "Confirmed") {
        if (alertType === "crmConfDashDiscr") {
          // Same layout as Pipeline dash discrepancy
          dataRange = "CRMComp!X6:BF1000";
          crmDataCols   = [0, 13];  // X:AJ  (indices 0-12)
          sheetDataCols = [17, 26]; // AO:AW (indices 17-25)
          flagCols      = [27, 35]; // AY:BF (indices 27-34)
          flagStartIdx  = 27;
        } else if (alertType === "crmConfAppDiscr") {
          // Same layout as Pipeline app discrepancy
          dataRange = "CRMComp!EF6:FL1000";
          sheetDataCols = [0, 13];  // EF:ER (indices 0-12)
          crmDataCols   = [15, 25]; // EU:FD (indices 15-24)
          flagCols      = [25, 33]; // FE:FL (indices 25-32)
          flagStartIdx  = 25;
        }
      }

      if (!dataRange) continue;

      let rows = [];
      if (dataRange.includes("X6:BF")) rows = dashData;
      else if (dataRange.includes("EF6:FL")) rows = appData;

      // Fallback if batchGet failed
      if (rows.length === 0) {
        try {
          const dataResponse = await sheets.spreadsheets.values.get({
            spreadsheetId, range: dataRange, valueRenderOption: "FORMATTED_VALUE",
          });
          rows = dataResponse.data.values || [];
        } catch(e) { continue; }
      }

      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (!row || row.length === 0) continue;

        const flagValues = [0,1,2,3,4,5,6,7].map(i => String(row[flagStartIdx + i] || "").trim());
        const hasDiscrepancy = flagValues.some(v => v === "1");
        if (!hasDiscrepancy) continue;

        // Apply DataChgAlert settings filtering if provided
        const SETTING_KEYS = ["missing_job","client_mismatch","job_name_mismatch","revenue_mismatch",
                              "direct_costs_mismatch","start_date_mismatch","end_date_mismatch","likelihood_mismatch"];
        const filteredFlags = settingsBlock
          ? flagValues.map((v, fi) => {
              if (v !== "1") return v;
              const sk = SETTING_KEYS[fi];
              return (sk && settingsBlock[sk] === false) ? "0" : v;
            })
          : flagValues;
        if (!filteredFlags.some(v => v === "1")) continue;

        // Split: flag[0] = not found / missing job; flags[1-7] = field mismatches
        const isNotFound    = filteredFlags[0] === "1";
        const mismatchFlags = filteredFlags.slice(1);
        const hasMismatch   = mismatchFlags.some(v => v === "1");
        const subType       = isNotFound ? "not_found" : "field_mismatch";

        const MISMATCH_FIELD_NAMES = ["Client name", "Job name", "Revenue", "Direct costs", "Start date", "End date", "% Likelihood"];
        const mismatchFields = mismatchFlags.map((v, i) => v === "1" ? MISMATCH_FIELD_NAMES[i] : null).filter(Boolean);

        // Pad slices to expected length — Sheets API truncates trailing empty cells
        // but GAS getValues() returns a fixed rectangle. Without padding, fingerprints
        // computed here won't match fingerprints computed by GAS.
        const padSlice = (arr, start, end) => {
          const slice = arr.slice(start, end);
          const len = end - start;
          while (slice.length < len) slice.push("");
          return slice;
        };
        alerts.push({
          type: "crm",
          alertType,
          subType,
          mismatchFields,
          mode,
          sheetName: "CRMComp",
          rowNumber: 7 + rowIdx,
          data: {
            crmData:   padSlice(row, crmDataCols[0], crmDataCols[1]),
            sheetData: padSlice(row, sheetDataCols[0], sheetDataCols[1]),
            flags:     filteredFlags,
          },
        });
      }
    }

    console.log(`  ✓ CRMComp (${mode}): ${alerts.length} alerts`);
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading CRMComp alerts:`, error);
    throw error;
  }
}

// ============================================================================
// OUTGOINGS TAB WRITE HELPER
// Mirrors the logic of the GAS updateOutgoingsExpense_ function.
// Finds the correct category row and month column, then:
//   - Adds the expense amount to the existing cell value
//   - Appends a structured {App ID:...} block to the cell note
// ============================================================================

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
  const { categoryName, expenseMonth, transactionId, amount, description, status, recDate, payDate, vatCharged } = outgoingsData;

  console.log(`  📝 Writing Outgoings expense: ${categoryName} / ${expenseMonth} / £${amount}`);

  // Read the full Outgoings sheet — use UNFORMATTED_VALUE so header dates come back
  // as serial numbers (e.g. 46083.0) rather than locale-dependent strings like "1/3/2026"
  const sheetRange = "Outgoings!A1:AX500";
  const valuesResp = await sheets.spreadsheets.values.get({
    spreadsheetId: clientSheetId,
    range: sheetRange,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = valuesResp.data.values || [];
  if (rows.length === 0) throw new Error("Outgoings tab is empty");

  // Parse the target month from "YYYY-MM"
  const [targetYear, targetMonth] = expenseMonth.split("-").map(Number);

  // Find the column index whose header date matches the target month.
  // Header cells are date serials (days since 30-Dec-1899). Convert to JS Date and compare.
  const headerRow = rows[0];
  let targetColIndex = -1;
  for (let c = 0; c < headerRow.length; c++) {
    const headerVal = headerRow[c];
    if (!headerVal) continue;
    let parsed = null;
    if (typeof headerVal === "number") {
      // Sheets serial → JS Date (UTC)
      parsed = new Date((headerVal - 25569) * 86400 * 1000);
    } else {
      // Fallback: try direct parse for ISO-format strings
      const d = new Date(headerVal);
      if (!isNaN(d.getTime())) parsed = d;
    }
    if (parsed && parsed.getUTCFullYear() === targetYear && parsed.getUTCMonth() + 1 === targetMonth) {
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
    // Vendor not found — use the first blank row AFTER the last existing vendor
    const nextBlankIndex = lastFilledRowIndex + 1;
    if (lastFilledRowIndex === -1 || nextBlankIndex > 109) {
      throw new Error(`No existing row for "${categoryName}" and no blank rows available in contractor section (rows 13-110)`);
    }
    targetRowIndex = nextBlankIndex;
    isNewVendor = true;
    console.log(`  New vendor — using blank row ${targetRowIndex + 1} (after last vendor at row ${lastFilledRowIndex + 1})`);
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
      spreadsheetId: clientSheetId,
      range: `Outgoings!A${sheetRow}:F${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[categoryName, vatCharged || "No", "Next", "Next", "100%", "100%"]] },
    });
    console.log(`  ✅ New vendor row written: ${categoryName}`);
  }

  // Read existing cell value and note
  const cellResp = await sheets.spreadsheets.get({
    spreadsheetId: clientSheetId,
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

  const newValue = Math.round((existingValue + amount) * 100) / 100;
  const newBlock = `{App ID: ${transactionId}}{Amt: ${amount}}{Status:${status ? " " + status : ""}}{Rec date:${recDate ? " " + recDate : ""}}{Pay date:${payDate ? " " + payDate : ""}}{Description:${description ? " " + description : ""}}`;

  let newNote;
  if (existingNote.includes(`{App ID: ${transactionId}}`)) {
    const escapedId = transactionId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    newNote = existingNote.replace(
      new RegExp(`\\{App ID: ${escapedId}\\}.*?(\\n|$)`, "s"),
      newBlock + "\n"
    ).trim();
    console.log(`  Updating existing App ID block for ${transactionId}`);
  } else {
    newNote = existingNote ? `${existingNote}\n\n${newBlock}` : newBlock;
    console.log(`  Appending new App ID block for ${transactionId}`);
  }

  // Write value
  await sheets.spreadsheets.values.update({
    spreadsheetId: clientSheetId,
    range: cellA1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newValue]] },
  });
  console.log(`  ✅ Value written: ${existingValue} → ${newValue}`);

  // Write note + apply bold/italic formatting in one batchUpdate
  const outgoingsSheetId = await getSheetId(sheets, clientSheetId, "Outgoings");
  const formatRequests = [
    // Format the value cell (bold + italic)
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
    // Write the note
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

  // If new vendor row, also format cols A:F bold+italic
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
    spreadsheetId: clientSheetId,
    requestBody: { requests: formatRequests },
  });
  console.log(`  ✅ Note written and formatting applied`);

  return { sheetRow, colLetter, newValue, prevValue: existingValue, isNewVendor };
}

// Helper: get the numeric sheetId for a named tab
async function getSheetId(sheets, spreadsheetId, tabName) {
  const resp = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = resp.data.sheets?.find(s => s.properties.title === tabName);
  if (!sheet) throw new Error(`Tab "${tabName}" not found in spreadsheet`);
  return sheet.properties.sheetId;
}

// Increase body size limit — store_precomputed sends the full alert list
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

// ============================================================================
// MAIN HANDLER
// ============================================================================

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://project-shj9n.vercel.app"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    // Handle both POST (req.body) and GET (req.query) requests
    const action = req.method === "GET" ? req.query.action : req.body.action;
    const automationCommanderSheetId = req.body.automationCommanderSheetId;
    const sheets = await getSheetsClient();

    console.log(`\n📍 API Request: method=${req.method}, action=${action}, bodyKeys=${Object.keys(req.body || {}).join(",")}, bodySize=${JSON.stringify(req.body || {}).length}`);

    if (action === "emergency_flush_redis") {
      // Temporary endpoint to clear OOM errors
      await redisClient.flushDb();
      return res.status(200).json({ success: true, message: "Redis database flushed successfully. You can now use the app normally." });
      
    } else if (action === "get_all_clients") {
      // Returns all clients from AutoUpdates as an array.
      // Used by the frontend for the Outgoings client selector, the Settings
      // "Run Client Automation" panel, and when clientsWithFlags is empty.
      const { automationCommanderSheetId } = req.body;
      if (!automationCommanderSheetId) {
        return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      }
      try {
        const sheets = await getSheetsClient();
        const resp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: automationCommanderSheetId,
          range: "AutoUpdates!A2:N500",
        }));
        const rows = resp.data.values || [];
        // Build both array (for outgoings selector) and object (for proactive alerts compat)
        const clientsArray = [];
        const clientsObj = {};
        for (const row of rows) {
          const clientName = String(row[0] || "").trim();
          const scriptId   = String(row[10] || "").trim(); // col K = GAS script ID
          const clientSheetUrl = row[11];
          const masterSheetUrl = row[12];
          const hasWebAppUrl = !!String(row[13] || "").trim(); // col N = Agent Web App URL
          // Skip header row and any row where name looks like a header
          if (!clientName || !clientSheetUrl) continue;
          if (clientName.toLowerCase() === "client" || clientName.toLowerCase() === "client name") continue;
          const clientSheetId = extractSheetIdFromUrl(clientSheetUrl) || String(clientSheetUrl).trim();
          const masterSheetId = extractSheetIdFromUrl(masterSheetUrl) || String(masterSheetUrl || "").trim();
          clientsArray.push({ clientName, clientSheetId, masterSheetId, scriptId, hasWebAppUrl });
          if (clientSheetId && masterSheetId) clientsObj[clientName] = { clientSheetId, masterSheetId, scriptId, hasWebAppUrl };
        }
        clientsArray.sort((a, b) => a.clientName.localeCompare(b.clientName));
        return res.status(200).json({ success: true, clients: clientsArray, clientsMap: clientsObj });
      } catch (err) {
        console.error("❌ get_all_clients error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_assigned_expenses") {
      // Server-side replacement for the old localStorage-only assigned-expense
      // tracking (conversation 19 Aug 2026) — reads the full AssignedExpenses
      // table and groups it by client, matching the shape the frontend's
      // assignedByClient state already expects.
      const { automationCommanderSheetId: aeAcId } = req.body;
      if (!aeAcId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        await ensureAssignedExpensesTab_(sheets, aeAcId);
        const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: aeAcId, range: "AssignedExpenses!A2:C50000" }));
        const assignedByClient = {};
        (resp.data.values || []).forEach(r => {
          if (!r[0] || !r[1]) return;
          if (!assignedByClient[r[0]]) assignedByClient[r[0]] = [];
          assignedByClient[r[0]].push(r[1]);
        });
        return res.status(200).json({ success: true, assignedByClient });
      } catch (err) {
        console.error("❌ get_assigned_expenses error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "mark_expense_assigned") {
      // Records that an expense has been assigned, server-side — shared
      // across devices/sessions rather than trapped in one browser's
      // localStorage. No duplicate check on write: the frontend already
      // treats this as a Set, and pruning (below) periodically cleans up
      // the table anyway, so a rare duplicate row is harmless.
      const { automationCommanderSheetId: aeAcId, clientName: aeClientName, appId: aeAppId } = req.body;
      if (!aeAcId || !aeClientName || !aeAppId) {
        return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId, clientName, or appId" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureAssignedExpensesTab_(sheets, aeAcId);
        await sheets.spreadsheets.values.append({
          spreadsheetId: aeAcId, range: "AssignedExpenses!A:C", valueInputOption: "RAW",
          requestBody: { values: [[aeClientName, aeAppId, new Date().toISOString()]] },
        });
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ mark_expense_assigned error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "prune_assigned_expenses") {
      // Removes assigned-expense rows for one client whose appId is no
      // longer present in that client's current inbox — meaning the real
      // underlying data has caught up and the suppression is no longer
      // needed. Mirrors the pruning the old localStorage version did on
      // every Outgoings load, now applied to the shared server-side table.
      const { automationCommanderSheetId: aeAcId, clientName: aeClientName, validAppIds } = req.body;
      if (!aeAcId || !aeClientName || !Array.isArray(validAppIds)) {
        return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId, clientName, or validAppIds" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureAssignedExpensesTab_(sheets, aeAcId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: aeAcId, range: "AssignedExpenses!A2:C50000" });
        const rows = resp.data.values || [];
        const validSet = new Set(validAppIds);
        const keptRows = rows.filter(r => !(r[0] === aeClientName) || validSet.has(r[1]));
        if (keptRows.length !== rows.length) {
          await sheets.spreadsheets.values.clear({ spreadsheetId: aeAcId, range: `AssignedExpenses!A2:C${rows.length + 1}` });
          if (keptRows.length > 0) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: aeAcId, range: "AssignedExpenses!A2", valueInputOption: "RAW", requestBody: { values: keptRows },
            });
          }
        }
        return res.status(200).json({ success: true, removed: rows.length - keptRows.length });
      } catch (err) {
        console.error("❌ prune_assigned_expenses error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_outgoings_inbox") {
      // Reads DirComp for unmatched expenses (Missing cost flag = col AO index 40).
      // DirComp lives on the master sheet, not the client sheet.
      const { masterSheetId, clientSheetId } = req.body;
      const sheetId = masterSheetId || clientSheetId;
      if (!sheetId) return res.status(400).json({ success: false, error: "Missing masterSheetId or clientSheetId" });
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(sheetId) || sheetId;
        console.log(`  🔍 get_outgoings_inbox: sheetId=${sheetIdClean.slice(0,20)}...`);

        // Check GAS expense lock first — if GAS is writing to DirComp, wait or abort
        const allLocks = await checkAllGASLocks(sheets, sheetIdClean);
        const expLock = allLocks.expense;
        if (expLock.locked) {
          console.log(`  ⚠ get_outgoings_inbox: GAS expense lock active — returning empty inbox to avoid stale data`);
          return res.status(200).json({ success: true, inbox: [], locked: true, lockMessage: "Expense automation is currently running — try again in a moment" });
        }
        console.log(`  ✓ No GAS lock`);

        await setMasterSwitch(sheets, sheetIdClean, "DirComp", true);
        const dataResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "DirComp!A6:AV1000",
        });
        await setMasterSwitch(sheets, sheetIdClean, "DirComp", false);

        const rows = dataResp.data.values || [];
        console.log(`  📊 DirComp rows read: ${rows.length}`);

        const inbox = [];
        let skippedNoFlag = 0, skippedNoAppId = 0;
        for (const row of rows) {
          if (!row || row.length === 0) continue;
          // col AO (index 40) = "Missing cost?" flag
          const rawFlag = String(row[40] || "").trim();
          const isMissing = rawFlag === "1";
          if (!isMissing) { skippedNoFlag++; continue; }

          // Accounting cols A-J (indices 0-9)
          const date        = String(row[0] || "").trim();
          const description = String(row[1] || "").trim();
          const amount      = parseFloat(String(row[2] || "0").replace(/,/g, "")) || 0;
          const reference   = String(row[3] || "").trim();
          const accountName = String(row[4] || "").trim();
          const status      = String(row[5] || "").trim();
          const appId       = String(row[6] || "").trim();
          const datePaid    = String(row[7] || "").trim();
          const vatAmount   = parseFloat(String(row[8] || "0").replace(/[£$€,]/g, "")) || 0;

          console.log(`  🔎 Flag=1 row: appId="${appId}" desc="${description.slice(0,30)}" amt=${amount} date=${date}`);

          if (!appId) { skippedNoAppId++; console.log(`    ⚠ Skipped — no appId`); continue; }
          inbox.push({ appId, amount, date, description, reference, accountName, status, datePaid, vatAmount });
        }

        console.log(`  ✅ get_outgoings_inbox: ${inbox.length} unmatched expenses (skipped: ${skippedNoFlag} no-flag, ${skippedNoAppId} no-appId)`);
        return res.status(200).json({ success: true, inbox });
      } catch (err) {
        try { await setMasterSwitch(sheets, extractSheetIdFromUrl(sheetId) || sheetId, "DirComp", false); } catch(e) {}
        console.error("❌ get_outgoings_inbox error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_invoices_inbox") {
      // Reads InvComp for unmatched invoices (Missing invoice flag = col S index 18).
      // InvComp lives on the master sheet, not the client sheet.
      const { masterSheetId, clientSheetId } = req.body;
      const sheetId = masterSheetId || clientSheetId;
      if (!sheetId) return res.status(400).json({ success: false, error: "Missing masterSheetId or clientSheetId" });
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(sheetId) || sheetId;

        const allLocks = await checkAllGASLocks(sheets, sheetIdClean);
        const invLock = allLocks.invoice;
        if (invLock.locked) {
          return res.status(200).json({ success: true, inbox: [], locked: true, lockMessage: "Invoice automation is currently running — try again in a moment" });
        }

        await setMasterSwitch(sheets, sheetIdClean, "InvComp", true);
        const dataResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "InvComp!A6:Y1000",
        });
        await setMasterSwitch(sheets, sheetIdClean, "InvComp", false);

        const rows = dataResp.data.values || [];
        const inbox = [];
        let skippedNoFlag = 0, skippedNoInvNo = 0;
        for (const row of rows) {
          if (!row || row.length === 0) continue;
          // col S (index 18) = "Missing invoice?" flag
          const isMissing = String(row[18] || "").trim() === "1";
          if (!isMissing) { skippedNoFlag++; continue; }

          // Accounting cols A-K (indices 0-10)
          const client       = String(row[0] || "").trim();
          const job          = String(row[1] || "").trim();
          const invoiceAmt   = parseFloat(String(row[2] || "0").replace(/,/g, "")) || 0;
          const totalExclVAT = parseFloat(String(row[3] || "0").replace(/,/g, "")) || 0;
          const vatIncluded  = parseFloat(String(row[4] || "0").replace(/,/g, "")) || 0;
          const invoiceNo    = String(row[5] || "").trim();
          
          const fmtDate = (dStr) => {
            if (!dStr) return "";
            const d = parseSheetOrJsDate_(dStr);
            if (!d) return String(dStr).trim();
            const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
          };
          
          const sentDate     = fmtDate(row[6]);
          const dueDate      = fmtDate(row[7]);
          const fullyPaidOn  = fmtDate(row[8]);
          const status       = String(row[9] || "").trim();
          const currency     = String(row[10] || "").trim() || "GBP";

          if (!invoiceNo) { skippedNoInvNo++; continue; }
          inbox.push({
            invoiceNo, client, job, currency, sentDate, dueDate, fullyPaidOn, status,
            amount: totalExclVAT > 0 ? totalExclVAT : invoiceAmt,
            grossAmount: invoiceAmt, vatAmount: vatIncluded,
          });
        }

        console.log(`  ✅ get_invoices_inbox: ${inbox.length} unmatched invoices (skipped: ${skippedNoFlag} no-flag, ${skippedNoInvNo} no-invoiceNo)`);
        return res.status(200).json({ success: true, inbox });
      } catch (err) {
        try { await setMasterSwitch(sheets, extractSheetIdFromUrl(sheetId) || sheetId, "InvComp", false); } catch(e) {}
        console.error("❌ get_invoices_inbox error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "create_outgoings_vendor") {
      // Inserts a new vendor row at the end of the Contractors section (row 110) in the Outgoings tab.
      // Cols: A=vendorName, B=vatFlag, C=invTiming, D=payTiming, E=deliveryPct
      const { clientSheetId, vendorName, vatFlag, invTiming, payTiming, deliveryPct } = req.body;
      if (!clientSheetId || !vendorName) return res.status(400).json({ success: false, error: "Missing clientSheetId or vendorName" });
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        // Find the last used row in the contractors section (rows 13-110)
        const checkResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Outgoings!A13:A110",
        });
        const rows = checkResp.data.values || [];
        // Find last non-empty row
        let lastRow = 12; // 0-indexed, row 13
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]?.[0]) { lastRow = 12 + i; break; }
        }
        const newRow = lastRow + 2; // one row after last, 1-indexed
        if (newRow > 110) return res.status(400).json({ success: false, error: "Contractors section is full (max row 110)" });

        // Ensure deliveryPct is formatted correctly as a percentage string (e.g. "100%")
        // This ensures Sheets interprets it as a percentage and avoids inheriting a currency format.
        // It also handles "0" correctly, which the previous || operator broke.
        const pctValue = deliveryPct !== undefined && deliveryPct !== "" ? String(deliveryPct).replace(/%/g, "") : "100";
        const pctString = `${pctValue}%`;

        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `Outgoings!A${newRow}:E${newRow}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[vendorName, vatFlag || "Yes", invTiming || "Next", payTiming || "Next", pctString]] },
        });

        console.log(`  ✅ Created new Outgoings vendor "${vendorName}" at row ${newRow} with Delivery ${pctString}`);
        return res.status(200).json({ success: true, sheetRow: newRow });
      } catch (err) {
        console.error("❌ create_outgoings_vendor error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_outgoings") {
      // Reads the Outgoings tab from the client sheet.
      // Returns contractor rows (rows 13-110), month columns (G+), and parsed note blocks.
      const { clientSheetId } = req.body;
      if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        // Use spreadsheets.get with includeGridData to get both values AND notes in one call.
        // FORMATTED_VALUE gives us the rendered date string for month headers.
        const gridResp = await sheets.spreadsheets.get({
          spreadsheetId: sheetIdClean,
          ranges: ["Outgoings!A1:BG1", "Outgoings!A13:BG110"],
          includeGridData: true,
          fields: "sheets.data.rowData.values(formattedValue,note,effectiveValue)",
          // Don't use startRow/startColumn as fields — they're properties of data, not values
        });

        const sheetGrids = gridResp.data.sheets?.[0]?.data || [];
        // sheetGrids[0] = row 1 (header), sheetGrids[1] = rows 13-110 (contractors)
        const headerGridData = sheetGrids[0];
        const contractorGridData = sheetGrids[1];

        const headerCells = headerGridData?.rowData?.[0]?.values || [];
        const contractorRows = contractorGridData?.rowData || [];

        // Find month columns from header (col G = index 6 onwards).
        // The header contains date formula results — they come back as effectiveValue.numberValue
        // (Sheets serial date) and formattedValue (e.g. "01/04/2026" or "Apr-26").
        // We accept any col G+ that has a numeric effectiveValue (date serial) or
        // a formattedValue that looks like a date.
        const SHEET_EPOCH = new Date(1899, 11, 30); // Sheets serial date epoch
        const months = [];
        for (let i = 6; i < headerCells.length; i++) {
          const cell = headerCells[i];
          if (!cell) continue;
          const fv = cell.formattedValue || "";
          const ev = cell.effectiveValue;

          // Skip total columns (contain "total" in formatted value)
          if (fv.toLowerCase().includes("total") || fv.toLowerCase().includes("fy")) continue;

          let dateObj = null;
          if (ev?.numberValue) {
            // Sheets serial date → JS Date
            const d = new Date(SHEET_EPOCH.getTime() + ev.numberValue * 86400000);
            if (!isNaN(d.getTime()) && d.getFullYear() > 2020) dateObj = d;
          }
          if (!dateObj && fv) {
            const d = new Date(fv);
            if (!isNaN(d.getTime()) && d.getFullYear() > 2020) dateObj = d;
          }

          if (dateObj) {
            const label = dateObj.toLocaleString("en-GB", { month: "short", year: "2-digit" });
            const isoMonth = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}`;
            months.push({ colIndex: i, colLetter: colIndexToLetter(i + 1), label, isoMonth, dateObj: dateObj.toISOString() });
          }
        }

        // Helper: parse note blocks
        const parseNoteBlocks = (note) => {
          if (!note) return [];
          const blocks = [];
          const blockRegex = /\{App ID:\s*([^}]+)\}\{Amt:\s*([^}]+)\}(?:\{Status:\s*([^}]*)\})?(?:\{Rec date:\s*([^}]*)\})?(?:\{Pay date:\s*([^}]*)\})?(?:\{Description:\s*([^}]*)\})?/g;
          let match;
          while ((match = blockRegex.exec(note)) !== null) {
            blocks.push({
              appId:       match[1]?.trim() || "",
              amount:      parseFloat(String(match[2] || "").replace(/[£$€,\s]/g, "")) || 0,
              status:      match[3]?.trim() || "",
              recDate:     match[4]?.trim() || "",
              payDate:     match[5]?.trim() || "",
              description: match[6]?.trim() || "",
            });
          }
          return blocks;
        };

        // Build contractor rows
        const contractors = [];
        for (let r = 0; r < contractorRows.length; r++) {
          const rowCells = contractorRows[r]?.values || [];
          const name = String(rowCells[0]?.formattedValue || "").trim();
          if (!name) continue;
          // Skip section header rows (e.g. "Contractors", totals)
          if (name.toLowerCase() === "contractors" || name.startsWith("Total") || name.startsWith("=")) continue;

          const vatFlag   = String(rowCells[1]?.formattedValue || "").trim();
          const invTiming = String(rowCells[2]?.formattedValue || "").trim();
          const payTiming = String(rowCells[3]?.formattedValue || "").trim();

          const cells = {};
          for (const month of months) {
            const cellData = rowCells[month.colIndex];
            const note = cellData?.note || "";
            const value = cellData?.formattedValue || "";
            cells[month.colLetter] = { value, note, blocks: parseNoteBlocks(note) };
          }

          contractors.push({ sheetRow: 13 + r, name, vatFlag, invTiming, payTiming, cells });
        }

        console.log(`  ✅ get_outgoings: ${contractors.length} contractors, ${months.length} months`);
        return res.status(200).json({ success: true, contractors, months });
      } catch (err) {
        console.error("❌ get_outgoings error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_direct_costs_jobs") {
      // Reads the Confirmed tab and returns all jobs (parent + child rows grouped) in
      // spreadsheet-style format, for the Vendors → Direct Costs tab.
      // By default: only jobs with DirectCostBudget > £0 and a start date within the
      // last 6 months. showAll=true returns every job regardless of budget/date.
      const { clientSheetId, showAll } = req.body;
      if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rows = resp.data.values || [];

        const parseSheetDate = (d) => {
          if (!d) return null;
          const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
          if (!m) return null;
          const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
          const mIdx = months[m[2].toLowerCase()];
          if (mIdx === undefined) return null;
          const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
          return new Date(yr, mIdx, parseInt(m[1]));
        };
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
        const buildRowData = (rowNum, row, isParent) => ({
          rowNum, isParent,
          client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
          revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
          projectRetainer: colVal(row, 35), startDate: colVal(row, 37), endDate: colVal(row, 38),
          likelihood: null, copiedToConf: null,
          invoiceSlots: [1,2,3].map(n => {
            const base = n === 1 ? 41 : n === 2 ? 48 : 55;
            return { slotNum: n, amount: colVal(row,base), ref: colVal(row,base+1), sentDate: colVal(row,base+2),
              daysToPay: colVal(row,base+3), status: colVal(row,base+4), highlighted: false };
          }),
          expenseSlots: [1,2,3].map(n => {
            const base = n === 1 ? 75 : n === 2 ? 82 : 89;
            return { slotNum: n, description: colVal(row,base), amount: colVal(row,base+1), vat: colVal(row,base+2),
              date: colVal(row,base+3), daysToPay: colVal(row,base+4), status: colVal(row,base+5),
              transactionId: colVal(row,base+6), highlighted: false };
          }),
        });

        const jobs = [];
        let ri = 1;
        while (ri < rows.length) {
          const row = rows[ri] || [];
          const client = String(row[0] || "").trim();
          const jobName = String(row[1] || "").trim();
          const budgetNum = parseFloat(String(row[33]||"").replace(/[£$€,\s]/g,"")) || 0;
          if (!client && !jobName) { ri++; continue; }

          const parentRowNum = ri + 1;
          const jobRows = [buildRowData(parentRowNum, row, true)];
          let cj = ri + 1;
          while (cj < rows.length) {
            const next = rows[cj] || [];
            const nc = String(next[0]||"").trim();
            const nj = String(next[1]||"").trim();
            const nRevenue = String(next[32]||"").trim();
            const nBudget = parseFloat(String(next[33]||"").replace(/[£$€,\s]/g,"")) || 0;
            const nStart = String(next[37]||"").trim();
            // Child row: same client+job name repeated, no revenue/budget/start date of its own
            if (nc === client && nj === jobName && !nRevenue && !nBudget && !nStart) {
              jobRows.push(buildRowData(cj + 1, next, false));
              cj++;
            } else {
              break;
            }
          }
          ri = cj;

          const startDate = parseSheetDate(row[37]);
          const passesFilter = showAll || (budgetNum > 0 && startDate && startDate >= sixMonthsAgo);
          if (passesFilter) {
            jobs.push({ client, jobName, projectCode: row[2] || "", rows: jobRows });
          }
        }

        // Sort newest first by start date (jobs with no parseable date sort last)
        jobs.sort((a, b) => {
          const da = parseSheetDate(a.rows[0]?.startDate);
          const db = parseSheetDate(b.rows[0]?.startDate);
          if (!da && !db) return 0;
          if (!da) return 1;
          if (!db) return -1;
          return db - da;
        });

        console.log(`  ✅ get_direct_costs_jobs: ${jobs.length} jobs (showAll=${!!showAll})`);
        return res.status(200).json({ success: true, jobs });
      } catch (err) {
        console.error("❌ get_direct_costs_jobs error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_invoice_jobs") {
      // Reads the Confirmed tab and returns all jobs (parent + child rows grouped) in
      // spreadsheet-style format, for the Invoices screen.
      // By default: only jobs with an uninvoiced amount > £0 — i.e. revenue minus the
      // sum of REAL invoice slot amounts (excluding blank/MANUAL-INV placeholders)
      // across all rows in the job. showAll=true returns every job regardless.
      const { clientSheetId, showAll } = req.body;
      if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rows = resp.data.values || [];

        const parseSheetDate = (d) => {
          if (!d) return null;
          const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
          if (!m) return null;
          const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
          const mIdx = months[m[2].toLowerCase()];
          if (mIdx === undefined) return null;
          const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
          return new Date(yr, mIdx, parseInt(m[1]));
        };

        const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
        const buildRowData = (rowNum, row, isParent) => ({
          rowNum, isParent,
          client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
          revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
          projectRetainer: colVal(row, 35), startDate: colVal(row, 37), endDate: colVal(row, 38),
          likelihood: null, copiedToConf: null,
          invoiceSlots: [1,2,3].map(n => {
            const base = n === 1 ? 41 : n === 2 ? 48 : 55;
            return { slotNum: n, amount: colVal(row,base), ref: colVal(row,base+1), sentDate: colVal(row,base+2),
              daysToPay: colVal(row,base+3), status: colVal(row,base+4), highlighted: false };
          }),
          expenseSlots: [1,2,3].map(n => {
            const base = n === 1 ? 75 : n === 2 ? 82 : 89;
            return { slotNum: n, description: colVal(row,base), amount: colVal(row,base+1), vat: colVal(row,base+2),
              date: colVal(row,base+3), daysToPay: colVal(row,base+4), status: colVal(row,base+5),
              transactionId: colVal(row,base+6), highlighted: false };
          }),
        });

        const jobs = [];
        let ri = 1;
        while (ri < rows.length) {
          const row = rows[ri] || [];
          const client = String(row[0] || "").trim();
          const jobName = String(row[1] || "").trim();
          const revenueNum = parseFloat(String(row[32]||"").replace(/[£$€,\s]/g,"")) || 0;
          if (!client && !jobName) { ri++; continue; }

          const parentRowNum = ri + 1;
          const jobRows = [buildRowData(parentRowNum, row, true)];
          let cj = ri + 1;
          while (cj < rows.length) {
            const next = rows[cj] || [];
            const nc = String(next[0]||"").trim();
            const nj = String(next[1]||"").trim();
            const nRevenue = String(next[32]||"").trim();
            const nBudget = parseFloat(String(next[33]||"").replace(/[£$€,\s]/g,"")) || 0;
            const nStart = String(next[37]||"").trim();
            // Child row: same client+job name repeated, no revenue/budget/start date of its own
            if (nc === client && nj === jobName && !nRevenue && !nBudget && !nStart) {
              jobRows.push(buildRowData(cj + 1, next, false));
              cj++;
            } else {
              break;
            }
          }
          ri = cj;

          // Sum REAL invoice slot amounts (non-blank ref, not MANUAL-INV) across all rows
          let realInvoicedTotal = 0;
          for (const jr of jobRows) {
            for (const slot of jr.invoiceSlots) {
              const ref = String(slot.ref || "").trim();
              const isReal = ref && !ref.toUpperCase().startsWith("MANUAL-INV");
              if (isReal) realInvoicedTotal += parseFloat(String(slot.amount||"").replace(/[£$€,\s]/g,"")) || 0;
            }
          }
          const uninvoicedAmount = revenueNum - realInvoicedTotal;
          const passesFilter = showAll || uninvoicedAmount > 0;
          if (passesFilter) {
            jobs.push({ client, jobName, projectCode: row[2] || "", rows: jobRows, uninvoicedAmount });
          }
        }

        // Sort newest first by start date (jobs with no parseable date sort last)
        jobs.sort((a, b) => {
          const da = parseSheetDate(a.rows[0]?.startDate);
          const db = parseSheetDate(b.rows[0]?.startDate);
          if (!da && !db) return 0;
          if (!da) return 1;
          if (!db) return -1;
          return db - da;
        });

        console.log(`  ✅ get_invoice_jobs: ${jobs.length} jobs (showAll=${!!showAll})`);
        return res.status(200).json({ success: true, jobs });
      } catch (err) {
        console.error("❌ get_invoice_jobs error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_retainer_jobs") {
      // Reads Confirmed and returns all retainer jobs (active, or ended within the
      // last 2 months) in spreadsheet-style format for the Retainers screen.
      const { clientSheetId } = req.body;
      if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rows = resp.data.values || [];
        const retainerJobs = retFindRetainerJobs(rows, { onlyActiveOrRecentlyEnded: true });

        const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
        const buildRowData = (rowNum, row, isParent) => ({
          rowNum, isParent,
          client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
          revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
          projectRetainer: colVal(row, 35), startDate: colVal(row, 37), endDate: colVal(row, 38),
          invoiceSlots: [1,2,3].map(n => {
            const base = n === 1 ? 41 : n === 2 ? 48 : 55;
            return { slotNum: n, amount: colVal(row,base), ref: colVal(row,base+1), sentDate: colVal(row,base+2),
              daysToPay: colVal(row,base+3), status: colVal(row,base+4) };
          }),
        });

        const jobs = retainerJobs.map(job => ({
          client: job.client, jobName: job.jobName, projectCode: job.projectCode,
          revenue: job.revenue, vat: job.vat, projectRetainer: job.projectRetainer,
          parentRowNum: job.parentRowNum,
          rows: [buildRowData(job.parentRowNum, job.parentRow, true)]
            .concat(job.childRows.map(cr => buildRowData(cr.rowNum, cr.row, false))),
        }));

        // Sort newest start-date first
        jobs.sort((a, b) => {
          const da = retParseSheetDate(a.rows[0]?.startDate);
          const db = retParseSheetDate(b.rows[0]?.startDate);
          if (!da && !db) return 0;
          if (!da) return 1;
          if (!db) return -1;
          return db - da;
        });

        console.log(`  ✅ get_retainer_jobs: ${jobs.length} retainer jobs`);
        return res.status(200).json({ success: true, jobs });
      } catch (err) {
        console.error("❌ get_retainer_jobs error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "assign_expense_to_job") {
      // Writes an inbox expense directly into a specific expense slot on the Confirmed tab.
      // If rowNum/slotNum are provided, writes directly into that existing slot.
      // If createNewRow is true instead, inserts a new child row for the job (replicating
      // the move-based row insertion from 7_Cost_Sync.gs: finds/creates a blank row at the
      // sheet's tail and MOVES it to sit directly after the job's last row, rather than
      // inserting fresh cells — this avoids disturbing formulas/formatting elsewhere that
      // reference fixed row ranges) and writes the expense into slot 1 of that new row.
      const { clientSheetId, masterSheetId, rowNum, slotNum, expense, createNewRow, jobLastRow, jobClient, jobName } = req.body;
      if (!clientSheetId || !expense) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId or expense" });
      }
      if (!createNewRow && (!rowNum || !slotNum)) {
        return res.status(400).json({ success: false, error: "Missing rowNum or slotNum" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const slotCols = {
          1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
          2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
          3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
        };

        const vatAmountRaw = parseFloat(String(expense.vatAmount || "0").replace(/[£$€,]/g, "")) || 0;
        const vatYesNo = vatAmountRaw > 0 ? "Yes" : "No";

        let targetRowNum = rowNum;
        let targetSlotNum = slotNum;

        if (createNewRow) {
          if (!jobLastRow) return res.status(400).json({ success: false, error: "Missing jobLastRow for createNewRow" });

          // Get the Confirmed sheet's grid metadata (sheetId, current row count, existing
          // row groups — needed to extend/match the group depth for the new row).
          const metaResp = await sheets.spreadsheets.get({
            spreadsheetId: sheetIdClean,
            fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
          });
          const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
          if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });
          const gridSheetId = confirmedSheet.properties.sheetId;
          const currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;
          const existingRowGroups = confirmedSheet.rowGroups || [];

          // Find the true last row with any real data — same zone check as GAS:
          // A:E (0-4), AG:AM (32-38), AP:BH (41-59), BX:CR (75-95)
          const fullResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: "Confirmed!A1:CR" + currentMaxRows,
            valueRenderOption: "UNFORMATTED_VALUE",
          });
          const allRows = fullResp.data.values || [];
          let trueLastRow = 0;
          for (let r = allRows.length - 1; r >= 0; r--) {
            const row = allRows[r] || [];
            const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
            const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
            const z3 = row.slice(41, 60).some(c => c !== "" && c != null);
            const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
            if (z1 || z2 || z3 || z4) { trueLastRow = r + 1; break; }
          }

          // Read VAT (col AI, index 34) from the job's last existing row — the value to
          // copy onto the new child row, matching 7_Cost_Sync.gs's behaviour.
          const jobVAT = allRows[jobLastRow - 1]?.[34] ?? "";

          // Ensure at least one blank row exists below trueLastRow — insert 5 if not
          if (currentMaxRows - (trueLastRow + 1) < 1) {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: {
                requests: [{
                  insertDimension: {
                    range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 },
                    inheritFromBefore: true,
                  },
                }],
              },
            });
          }

          // Move the first blank row (at trueLastRow + 1, 0-indexed) to sit directly
          // after the job's last existing row (jobLastRow, 1-indexed sheet row).
          const sourceRowIndex0 = trueLastRow; // 0-indexed: row (trueLastRow+1) is the first blank row
          const destRowIndex0 = jobLastRow;    // moveDimension destinationIndex is 0-indexed position to insert before

          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: {
              requests: [{
                moveDimension: {
                  source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: sourceRowIndex0, endIndex: sourceRowIndex0 + 1 },
                  destinationIndex: destRowIndex0,
                },
              }],
            },
          });

          targetRowNum = jobLastRow + 1; // the new child row's 1-indexed sheet row after the move
          targetSlotNum = 1; // always write into slot 1 of the brand new (empty) row

          // Group the new row with the job's existing rows — replicates GAS's
          // shiftRowGroupDepth(1). If a row group already covers the job's last row,
          // extend that group's range by one row to include the new row. Otherwise,
          // create a fresh one-row group at depth 1 so the new row is at least
          // collapsible alongside its parent.
          try {
            const destRowIndex1based0 = jobLastRow; // 0-indexed position of the row directly above the new row
            const coveringGroup = existingRowGroups.find(g =>
              g.range?.startIndex <= destRowIndex1based0 - 1 && g.range?.endIndex >= destRowIndex1based0
            );
            if (coveringGroup) {
              await sheets.spreadsheets.batchUpdate({
                spreadsheetId: sheetIdClean,
                requestBody: {
                  requests: [
                    { deleteDimensionGroup: { range: {
                        sheetId: gridSheetId, dimension: "ROWS",
                        startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex,
                      } } },
                    { addDimensionGroup: { range: {
                        sheetId: gridSheetId, dimension: "ROWS",
                        startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex + 1,
                      } } },
                  ],
                },
              });
            } else {
              await sheets.spreadsheets.batchUpdate({
                spreadsheetId: sheetIdClean,
                requestBody: {
                  requests: [{
                    addDimensionGroup: {
                      range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: destRowIndex1based0, endIndex: destRowIndex1based0 + 1 },
                    },
                  }],
                },
              });
            }
          } catch (groupErr) {
            console.log(`  ⚠ Row grouping for new child row failed (non-fatal): ${groupErr.message}`);
          }

          // Populate client name and job name on the new child row so it correctly
          // continues the job group (child rows repeat client/job name, not blank).
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: {
              valueInputOption: "RAW",
              data: [
                { range: `Confirmed!A${targetRowNum}`, values: [[jobClient || ""]] },
                { range: `Confirmed!B${targetRowNum}`, values: [[jobName || ""]] },
                { range: `Confirmed!AI${targetRowNum}`, values: [[jobVAT]] },
              ],
            },
          });
          console.log(`  ✅ assign_expense_to_job: created new child row ${targetRowNum} for "${jobClient} — ${jobName}"`);
        }

        const slotColsForSlot = slotCols[targetSlotNum];
        if (!slotColsForSlot) return res.status(400).json({ success: false, error: "Invalid slotNum" });

        // The "received date" (dt) must go via USER_ENTERED — writing it in the same
        // RAW batch as the text/numeric fields below stores it as literal text
        // (visible as a leading apostrophe in the sheet) rather than a real date,
        // the same issue fixed for retainer dates elsewhere in this file.
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            valueInputOption: "RAW",
            data: [
              { range: `Confirmed!${slotColsForSlot.d}${targetRowNum}`,  values: [[expense.description || expense.accountName || ""]] },
              { range: `Confirmed!${slotColsForSlot.a}${targetRowNum}`,  values: [[expense.amount || 0]] },
              { range: `Confirmed!${slotColsForSlot.v}${targetRowNum}`,  values: [[vatYesNo]] },
              { range: `Confirmed!${slotColsForSlot.dp}${targetRowNum}`, values: [[30]] },
              { range: `Confirmed!${slotColsForSlot.st}${targetRowNum}`, values: [[expense.status || ""]] },
              { range: `Confirmed!${slotColsForSlot.id}${targetRowNum}`, values: [[expense.appId || ""]] },
            ],
          },
        });

        console.log(`  ✅ assign_expense_to_job: expense ${expense.appId} → Confirmed row ${targetRowNum} slot ${targetSlotNum}`);

        // Write the received date separately via USER_ENTERED, parsed and
        // re-formatted with a full 4-digit year (same approach used for retainer
        // dates) so Sheets stores it as a real date rather than literal text, and
        // isn't left to guess the century from a 2-digit year.
        if (expense.date) {
          const parsedExpenseDate = retParseSheetDate(expense.date);
          if (parsedExpenseDate) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean,
              range: `Confirmed!${slotColsForSlot.dt}${targetRowNum}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[retFmtDate(parsedExpenseDate)]] },
            });
          } else {
            console.log(`  ⚠ assign_expense_to_job: could not parse expense date "${expense.date}" — left blank`);
          }
        }

        return res.status(200).json({ success: true, newRowNum: createNewRow ? targetRowNum : undefined });
      } catch (err) {
        console.error("❌ assign_expense_to_job error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "update_expense_slot") {
      // Edits or clears an existing expense slot on the Confirmed tab (Vendors → Direct Costs).
      // Pass `expense` with the 7 fields to write, or `deleteSlot: true` to clear all 7 cells.
      const { clientSheetId, rowNum, slotNum, expense, deleteSlot } = req.body;
      if (!clientSheetId || !rowNum || !slotNum) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId, rowNum, or slotNum" });
      }
      if (!deleteSlot && !expense) {
        return res.status(400).json({ success: false, error: "Missing expense (or set deleteSlot: true)" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const slotCols = {
          1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
          2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
          3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
        }[slotNum];
        if (!slotCols) return res.status(400).json({ success: false, error: "Invalid slotNum" });

        const values = deleteSlot
          ? ["", "", "", "", "", "", ""]
          : [
              expense.description || "",
              expense.amount || 0,
              expense.vat || "No",
              expense.date || "",
              expense.daysToPay || 30,
              expense.status || "",
              expense.transactionId || "",
            ];

        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            valueInputOption: "RAW",
            data: [
              { range: `Confirmed!${slotCols.d}${rowNum}`,  values: [[values[0]]] },
              { range: `Confirmed!${slotCols.a}${rowNum}`,  values: [[values[1]]] },
              { range: `Confirmed!${slotCols.v}${rowNum}`,  values: [[values[2]]] },
              { range: `Confirmed!${slotCols.dp}${rowNum}`, values: [[values[4]]] },
              { range: `Confirmed!${slotCols.st}${rowNum}`, values: [[values[5]]] },
              { range: `Confirmed!${slotCols.id}${rowNum}`, values: [[values[6]]] },
            ],
          },
        });

        // Received date via USER_ENTERED (or cleared via RAW empty string if
        // deleteSlot), same reasoning as assign_expense_to_job — writing it in the
        // RAW batch above stores it as literal text instead of a real date.
        if (deleteSlot) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetIdClean,
            range: `Confirmed!${slotCols.dt}${rowNum}`,
            valueInputOption: "RAW",
            requestBody: { values: [[""]] },
          });
        } else if (expense.date) {
          const parsedExpenseDate = retParseSheetDate(expense.date);
          if (parsedExpenseDate) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean,
              range: `Confirmed!${slotCols.dt}${rowNum}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[retFmtDate(parsedExpenseDate)]] },
            });
          } else {
            console.log(`  ⚠ update_expense_slot: could not parse expense date "${expense.date}" — left unchanged`);
          }
        }

        console.log(`  ✅ update_expense_slot: ${deleteSlot ? "deleted" : "updated"} row ${rowNum} slot ${slotNum}`);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ update_expense_slot error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "assign_invoice_to_job") {
      // Writes an inbox invoice directly into a specific invoice slot on the Confirmed tab.
      const { clientSheetId, rowNum, slotNum, invoice } = req.body;
      if (!clientSheetId || !rowNum || !slotNum || !invoice) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId, rowNum, slotNum, or invoice" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const slotCols = {
          1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
          2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
          3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
        }[slotNum];
        if (!slotCols) return res.status(400).json({ success: false, error: "Invalid slotNum" });

        // Days to pay: derive from sent → due date if both present, else default 30
        let daysToPay = 30;
        if (invoice.sentDate && invoice.dueDate) {
          const parseD = (d) => {
            const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
            if (!m) return null;
            const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
            const mIdx = months[m[2].toLowerCase()];
            if (mIdx === undefined) return null;
            const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
            return new Date(yr, mIdx, parseInt(m[1]));
          };
          const sent = parseD(invoice.sentDate), due = parseD(invoice.dueDate);
          if (sent && due) daysToPay = Math.round((due - sent) / 86400000);
        }

        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            valueInputOption: "RAW",
            data: [
              { range: `Confirmed!${slotCols.a}${rowNum}`,    values: [[invoice.amount || 0]] },
              { range: `Confirmed!${slotCols.ref}${rowNum}`,  values: [[invoice.invoiceNo || ""]] },
              { range: `Confirmed!${slotCols.days}${rowNum}`, values: [[daysToPay]] },
              { range: `Confirmed!${slotCols.st}${rowNum}`,   values: [[invoice.status || "Sent"]] },
            ],
          },
        });

        // Sent date via USER_ENTERED — same reasoning as the expense date fixes:
        // writing it in the RAW batch above stores it as literal text.
        if (invoice.sentDate) {
          const parsedSentDate = retParseSheetDate(invoice.sentDate);
          if (parsedSentDate) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean,
              range: `Confirmed!${slotCols.sent}${rowNum}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[retFmtDate(parsedSentDate)]] },
            });
          } else {
            console.log(`  ⚠ assign_invoice_to_job: could not parse sent date "${invoice.sentDate}" — left blank`);
          }
        }

        console.log(`  ✅ assign_invoice_to_job: invoice ${invoice.invoiceNo} → Confirmed row ${rowNum} slot ${slotNum}`);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ assign_invoice_to_job error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "update_invoice_slot") {
      // Edits or clears an existing invoice slot on the Confirmed tab (Invoices screen).
      // Pass `invoice` with the 5 fields to write, or `deleteSlot: true` to clear all 5 cells.
      const { clientSheetId, rowNum, slotNum, invoice, deleteSlot } = req.body;
      if (!clientSheetId || !rowNum || !slotNum) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId, rowNum, or slotNum" });
      }
      if (!deleteSlot && !invoice) {
        return res.status(400).json({ success: false, error: "Missing invoice (or set deleteSlot: true)" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const slotCols = {
          1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
          2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
          3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
        }[slotNum];
        if (!slotCols) return res.status(400).json({ success: false, error: "Invalid slotNum" });

        const values = deleteSlot
          ? ["", "", "", "", ""]
          : [
              invoice.amount || 0,
              invoice.invoiceNo || "",
              invoice.sentDate || "",
              invoice.daysToPay || 30,
              invoice.status || "",
            ];

        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            valueInputOption: "RAW",
            data: [
              { range: `Confirmed!${slotCols.a}${rowNum}`,    values: [[values[0]]] },
              { range: `Confirmed!${slotCols.ref}${rowNum}`,  values: [[values[1]]] },
              { range: `Confirmed!${slotCols.days}${rowNum}`, values: [[values[3]]] },
              { range: `Confirmed!${slotCols.st}${rowNum}`,   values: [[values[4]]] },
            ],
          },
        });

        // Sent date via USER_ENTERED (or cleared via RAW empty string if
        // deleteSlot) — same reasoning as the other invoice/expense slot fixes.
        if (deleteSlot) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetIdClean,
            range: `Confirmed!${slotCols.sent}${rowNum}`,
            valueInputOption: "RAW",
            requestBody: { values: [[""]] },
          });
        } else if (invoice.sentDate) {
          const parsedSentDate = retParseSheetDate(invoice.sentDate);
          if (parsedSentDate) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean,
              range: `Confirmed!${slotCols.sent}${rowNum}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[retFmtDate(parsedSentDate)]] },
            });
          } else {
            console.log(`  ⚠ update_invoice_slot: could not parse sent date "${invoice.sentDate}" — left unchanged`);
          }
        }

        console.log(`  ✅ update_invoice_slot: ${deleteSlot ? "deleted" : "updated"} row ${rowNum} slot ${slotNum}`);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ update_invoice_slot error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "create_job_from_invoice") {
      // Creates a new job row at the end of the Confirmed tab, populated from an
      // unmatched invoice, with the invoice itself written into slot 1.
      const { clientSheetId, jobName, projectCode, revenue, directCosts, vatYesNo,
        projectType, startDate, endDate, invoice } = req.body;
      if (!clientSheetId || !invoice) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId or invoice" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        // Find the last row with any data in key columns (A, B, AG, AL) — same
        // approach used by the create_new job handler in accept_option.
        const confirmedResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:AM5000",
          valueRenderOption: "UNFORMATTED_VALUE",
        });
        const confirmedRows = confirmedResp.data.values || [];
        let lastDataRow = 1;
        for (let i = confirmedRows.length - 1; i >= 1; i--) {
          const r = confirmedRows[i] || [];
          if (r[0] || r[1] || r[32] || r[37]) { lastDataRow = i + 1; break; }
        }
        const newRow = lastDataRow + 1;

        // Days to pay: derive from sent → due date if both present, else default 30
        let daysToPay = 30;
        if (invoice.sentDate && invoice.dueDate) {
          const parseD = (d) => {
            const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
            if (!m) return null;
            const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
            const mIdx = months[m[2].toLowerCase()];
            if (mIdx === undefined) return null;
            const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
            return new Date(yr, mIdx, parseInt(m[1]));
          };
          const sent = parseD(invoice.sentDate), due = parseD(invoice.dueDate);
          if (sent && due) daysToPay = Math.round((due - sent) / 86400000);
        }

        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            valueInputOption: "RAW",
            data: [
              { range: `Confirmed!A${newRow}`,  values: [[invoice.client || ""]] },
              { range: `Confirmed!B${newRow}`,  values: [[jobName || invoice.job || ""]] },
              { range: `Confirmed!C${newRow}`,  values: [[projectCode || ""]] },
              { range: `Confirmed!AG${newRow}`, values: [[revenue || invoice.amount || 0]] },
              { range: `Confirmed!AH${newRow}`, values: [[directCosts || 0]] },
              { range: `Confirmed!AI${newRow}`, values: [[vatYesNo || (invoice.vatAmount > 0 ? "Yes" : "No")]] },
              { range: `Confirmed!AJ${newRow}`, values: [[projectType || "Project"]] },
              // Write the invoice into slot 1
              { range: `Confirmed!AP${newRow}`, values: [[invoice.amount || 0]] },
              { range: `Confirmed!AQ${newRow}`, values: [[invoice.invoiceNo || ""]] },
              { range: `Confirmed!AS${newRow}`, values: [[daysToPay]] },
              { range: `Confirmed!AT${newRow}`, values: [[invoice.status || "Sent"]] },
            ],
          },
        });

        // Start date, end date, and invoice sent date all go via USER_ENTERED —
        // writing them in the RAW batch above stores them as literal text (visible
        // as a leading apostrophe) instead of real dates.
        const dateFieldsToWrite = [
          { col: "AL", raw: startDate || invoice.sentDate },
          { col: "AM", raw: endDate || invoice.dueDate },
          { col: "AR", raw: invoice.sentDate },
        ];
        const dateWriteData = [];
        for (const f of dateFieldsToWrite) {
          if (!f.raw) continue;
          const parsed = retParseSheetDate(f.raw);
          if (parsed) {
            dateWriteData.push({ range: `Confirmed!${f.col}${newRow}`, values: [[retFmtDate(parsed)]] });
          } else {
            console.log(`  ⚠ create_job_from_invoice: could not parse date "${f.raw}" for column ${f.col} — left blank`);
          }
        }
        if (dateWriteData.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
          });
        }

        console.log(`  ✅ create_job_from_invoice: new job at row ${newRow}, invoice ${invoice.invoiceNo} in slot 1`);
        return res.status(200).json({ success: true, newRowNum: newRow });
      } catch (err) {
        console.error("❌ create_job_from_invoice error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "rename_retainer_job") {
      // Renames a retainer job on its parent row and all child rows.
      const { clientSheetId, oldClient, oldJobName, newJobName, parentRowNum } = req.body;
      if (!clientSheetId || !oldJobName || !newJobName || !parentRowNum) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rows = resp.data.values || [];
        const parentRow = rows[parentRowNum - 1] || [];
        if (String(parentRow[0]||"").trim() !== oldClient || String(parentRow[1]||"").trim() !== oldJobName) {
          return res.status(400).json({ success: false, error: "Row mismatch — job may have moved. Please refresh and try again." });
        }

        // Collect parent + child rows matching old name
        const targetRows = [parentRowNum];
        let cj = parentRowNum; // 0-indexed next row = parentRowNum (since parentRowNum is 1-indexed)
        while (cj < rows.length) {
          const next = rows[cj] || [];
          if (String(next[0]||"").trim() === oldClient && String(next[1]||"").trim() === oldJobName &&
              !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
            targetRows.push(cj + 1);
            cj++;
          } else break;
        }

        const data = targetRows.map(rn => ({ range: `Confirmed!B${rn}`, values: [[newJobName]] }));
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { valueInputOption: "RAW", data },
        });

        console.log(`  ✅ rename_retainer_job: "${oldJobName}" → "${newJobName}" on ${targetRows.length} row(s)`);
        return res.status(200).json({ success: true, rowsUpdated: targetRows.length });
      } catch (err) {
        console.error("❌ rename_retainer_job error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "change_retainer_end_date") {
      // Changes a retainer job's end date, then either:
      //  - TRIMS excess child rows (end date brought forward) — ungroups first, then
      //    clears content and moves each fully-cleared row to the bottom of the sheet.
      //    Aborts entirely (no changes) if any row-to-be-cleared has a real invoice or
      //    expense already recorded.
      //  - GROWS new child rows (end date pushed later) — recomputes the rolling
      //    "pastCount + 18 future months" target and creates rows via the same
      //    move-blank-row-into-position mechanism used by the nightly retainer audit,
      //    stepping by the job's detected invoice interval (supports quarterly etc.)
      //    and capped by the new end date and remaining contract value.
      const { clientSheetId, masterSheetId, client, jobName, parentRowNum, newEndDate } = req.body;
      if (!clientSheetId || !jobName || !parentRowNum || !newEndDate) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rows = resp.data.values || [];
        const parentRow = rows[parentRowNum - 1] || [];
        if (String(parentRow[0]||"").trim() !== client || String(parentRow[1]||"").trim() !== jobName) {
          return res.status(400).json({ success: false, error: "Row mismatch — job may have moved. Please refresh and try again." });
        }

        const oldEndDate = retParseSheetDate(parentRow[38]);
        const newEnd = retParseSheetDate(newEndDate);
        if (!newEnd) return res.status(400).json({ success: false, error: "Invalid new end date" });

        const revenue = retParseMoney(parentRow[32]);
        const vat = parentRow[34];
        const startDate = retParseSheetDate(parentRow[37]);

        // Collect current child rows + their invoice-1 dates
        const childRows = [];
        let cj = parentRowNum;
        while (cj < rows.length) {
          const next = rows[cj] || [];
          if (String(next[0]||"").trim() === client && String(next[1]||"").trim() === jobName &&
              !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
            childRows.push({ rowNum: cj + 1, row: next });
            cj++;
          } else break;
        }
        const childDates = childRows.map(cr => retParseSheetDate(cr.row[43])).filter(Boolean); // AR = invoice 1 sent date

        // Detect whether this job's invoices are sent BEFORE the period they cover
        // (e.g. 28-May for June) or DURING it (e.g. 3-Jun for June) — inferred from
        // the job's own invoice history. This affects which calendar month a given
        // invoice row is actually "for", which the trim/grow/split logic below all
        // depend on getting right.
        const intervalMonthsForOffset = retDetectIntervalMonths(childDates);
        const invoiceTimingOffset = retDetectInvoiceTimingOffset_(childDates, startDate, intervalMonthsForOffset);
        const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : 0; // months to ADD to a sent-date to get its true covered-period month

        const isGrowing = !oldEndDate || newEnd > oldEndDate;

        if (!isGrowing) {
          // ── TRIM PATH ──────────────────────────────────────────────────
          const newEndVal = newEnd.getFullYear() * 12 + newEnd.getMonth();

          // Find rows to trim: child rows whose invoice date falls beyond the new end month
          const toTrim = [];
          for (let c = childRows.length - 1; c >= 0; c--) {
            const cr = childRows[c];
            const invDate = retParseSheetDate(cr.row[43]);
            const rowMonthVal = invDate ? (invDate.getFullYear() * 12 + invDate.getMonth() + timingMonthAdjust) : null;
            if (rowMonthVal !== null && rowMonthVal > newEndVal) {
              toTrim.push(cr);
            } else {
              break; // rows are in chronological order — stop at the first row within range
            }
          }

          // Check every row-to-trim for real invoice/expense data — abort if any found
          const hasRealData = (row) => {
            for (const s of RET_INV_SLOTS) {
              const ref = String(row[s.ref] || "").trim().toUpperCase();
              if (ref && !ref.startsWith("MANUAL-INV")) return true;
            }
            const expSlots = [{ id: 81 }, { id: 88 }, { id: 95 }]; // CD, CK, CR — transaction ID cols
            for (const s of expSlots) {
              const id = String(row[s.id] || "").trim().toUpperCase();
              if (id && !id.startsWith("MANUAL-ENTRY") && !id.startsWith("UNRECON-GAP")) return true;
            }
            return false;
          };
          const blockedRow = toTrim.find(cr => hasRealData(cr.row));
          if (blockedRow) {
            return res.status(200).json({
              success: false,
              blocked: true,
              error: `Cannot shorten this retainer — row ${blockedRow.rowNum} already has a real invoice or expense recorded. ` +
                `Please resolve or move that data manually before shortening the end date.`,
            });
          }

          if (toTrim.length === 0) {
            // No rows to clear, just update the end date
            await sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean, range: `Confirmed!AM${parentRowNum}`,
              valueInputOption: "USER_ENTERED", requestBody: { values: [[newEndDate]] },
            });
            return res.status(200).json({ success: true, trimmed: 0, grown: 0 });
          }

          // Get sheet metadata for grouping/moving
          const metaResp = await sheets.spreadsheets.get({
            spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
          });
          const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
          const gridSheetId = confirmedSheet.properties.sheetId;
          const rowGroups = confirmedSheet.rowGroups || [];
          const currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

          // toTrim is in reverse chronological order (last row first).
          // For grouping purposes, figure out — per distinct group — how many of its
          // TRAILING rows are being trimmed in total, then issue exactly ONE shrink
          // (or delete) request per affected group. Issuing multiple incremental
          // shrink requests against the same group in one batch is unreliable: the
          // Sheets API validates each request in a batch against the pre-batch state,
          // not against the result of earlier requests in the same batch, so a second
          // shrink targeting "the group after the first shrink" gets rejected.
          const groupTrimCounts = new Map(); // group object -> count of trailing rows being removed
          for (const cr of toTrim) {
            const rowIdx0 = cr.rowNum - 1;
            const coveringGroup = rowGroups.find(g => g.range?.startIndex <= rowIdx0 && g.range?.endIndex > rowIdx0);
            if (!coveringGroup) continue;
            // Only count it if this row is within the trailing N rows currently
            // accounted for — i.e. rowIdx0 is (endIndex - 1 - alreadyCounted)
            const alreadyCounted = groupTrimCounts.get(coveringGroup) || 0;
            if (rowIdx0 === coveringGroup.range.endIndex - 1 - alreadyCounted) {
              groupTrimCounts.set(coveringGroup, alreadyCounted + 1);
            }
          }

          const requests = [];
          // NOTE: updateDimensionGroup cannot resize a group's row span — the API
          // requires a group that ALREADY spans exactly the target range and only
          // lets you change its collapsed state. To actually shrink a group, delete
          // the existing one and add a new one at the smaller range instead.
          for (const [group, trimCount] of groupTrimCounts.entries()) {
            const groupSize = group.range.endIndex - group.range.startIndex;
            requests.push({ deleteDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: group.range.endIndex } } });
            if (trimCount < groupSize) {
              const newEnd = group.range.endIndex - trimCount;
              requests.push({
                addDimensionGroup: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: newEnd },
                },
              });
            }
          }
          if (requests.length > 0) {
            await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetIdClean, requestBody: { requests } });
          }

          // 2. Clear content on all rows-to-trim in one batch, then move the whole
          // contiguous block to the bottom in one operation. The old version did
          // this one row at a time AND re-read the entire sheet before every single
          // move to recompute trueLastRow — that combination was the main cause of
          // very slow saves. toTrim rows are always contiguous (consecutive trailing
          // child rows), so a single block clear + single block move is equivalent.
          const trimRowNums = toTrim.map(cr => cr.rowNum).sort((a, b) => a - b); // ascending order
          const clearRanges = [];
          for (const rn of trimRowNums) {
            clearRanges.push(`Confirmed!A${rn}:AM${rn}`, `Confirmed!AP${rn}:BH${rn}`, `Confirmed!BX${rn}:CR${rn}`);
          }
          await sheets.spreadsheets.values.batchClear({
            spreadsheetId: sheetIdClean, requestBody: { ranges: clearRanges },
          });

          // Re-fetch true last row ONCE, after clearing, then move the whole
          // now-blank contiguous block to sit right after it in a single call.
          const freshResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR" + currentMaxRows, valueRenderOption: "UNFORMATTED_VALUE",
          });
          const trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshResp.data.values || []);

          const blockStartIdx0 = trimRowNums[0] - 1;
          const blockEndIdx0 = trimRowNums[trimRowNums.length - 1]; // exclusive end
          if (blockStartIdx0 <= trueLastRow) {
            // Rows are somewhere within/before the "true data" region — move the
            // block to sit immediately after trueLastRow (i.e. to the very bottom).
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: { requests: [{
                moveDimension: {
                  source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: blockStartIdx0, endIndex: blockEndIdx0 },
                  destinationIndex: trueLastRow + 1,
                },
              }] },
            });
          }
          const trimmedCount = trimRowNums.length;

          // Update the end date on the parent row
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetIdClean, range: `Confirmed!AM${parentRowNum}`,
            valueInputOption: "USER_ENTERED", requestBody: { values: [[newEndDate]] },
          });

          console.log(`  ✅ change_retainer_end_date: trimmed ${trimmedCount} row(s) for ${client} — ${jobName}`);
          return res.status(200).json({ success: true, trimmed: trimmedCount, grown: 0 });

        } else {
          // ── GROW PATH ──────────────────────────────────────────────────
          const today = new Date(); today.setHours(0,0,0,0);
          const currentMonthVal = today.getFullYear() * 12 + today.getMonth();
          const pastCount = childDates.filter(d => (d.getFullYear()*12 + d.getMonth() + timingMonthAdjust) <= currentMonthVal).length;
          const targetCount = pastCount + 18;

          if (childRows.length >= targetCount) {
            // Already enough rows for the rolling window — just update the end date
            await sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean, range: `Confirmed!AM${parentRowNum}`,
              valueInputOption: "USER_ENTERED", requestBody: { values: [[newEndDate]] },
            });
            return res.status(200).json({ success: true, trimmed: 0, grown: 0 });
          }

          const intervalMonths = retDetectIntervalMonths(childDates);
          const totalInvoiced = childRows.reduce((sum, cr) => sum + retParseMoney(cr.row[41]), 0) + retParseMoney(parentRow[41]);
          const diffDays = Math.round(Math.abs(newEnd.getTime() - (startDate || newEnd).getTime()) / 86400000);
          const durationMonths = Math.max(1, Math.round(diffDays / 30.4375));
          const totalContractValue = durationMonths * revenue;

          // Read the client's configured default "days to pay" from DataChgAlert!B52
          // on the master sheet (same source the nightly retainer audit uses), rather
          // than assuming 30 — falls back to 30 only if that cell is genuinely blank.
          // getToleranceValues reads via FORMATTED_VALUE, so coerce to a real number —
          // otherwise Sheets stores it as text (left-justified) instead of a number.
          const { defaultDaysToPay: rawDefaultDaysToPay } = await getToleranceValues(sheets, masterSheetId || sheetIdClean);
          const defaultDaysToPay = parseInt(String(rawDefaultDaysToPay).replace(/[^\d.-]/g, ""), 10) || 30;

          let lastDate = childDates.length > 0 ? childDates[childDates.length - 1] : new Date(startDate || newEnd);
          if (childDates.length === 0) lastDate.setMonth(lastDate.getMonth() - 1);

          const rowsNeeded = targetCount - childRows.length;
          const newRowDates = [];
          let simulatedTotal = totalInvoiced;
          let nextTestDate = new Date(lastDate);
          for (let k = 0; k < rowsNeeded; k++) {
            nextTestDate = new Date(nextTestDate);
            nextTestDate.setMonth(nextTestDate.getMonth() + intervalMonths);
            const testVal = nextTestDate.getFullYear() * 12 + nextTestDate.getMonth();
            const endVal = newEnd.getFullYear() * 12 + newEnd.getMonth();
            if (testVal > endVal) break;
            if ((simulatedTotal + revenue) > (totalContractValue + 1.00)) break;
            simulatedTotal += revenue;
            newRowDates.push(new Date(nextTestDate));
          }

          if (newRowDates.length === 0) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: sheetIdClean, range: `Confirmed!AM${parentRowNum}`,
              valueInputOption: "USER_ENTERED", requestBody: { values: [[newEndDate]] },
            });
            return res.status(200).json({ success: true, trimmed: 0, grown: 0 });
          }

          const metaResp = await sheets.spreadsheets.get({
            spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
          });
          const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
          const gridSheetId = confirmedSheet.properties.sheetId;
          let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

          const freshResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR" + currentMaxRows, valueRenderOption: "UNFORMATTED_VALUE",
          });
          let trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshResp.data.values || []);

          const insertAfterRowNum = childRows.length > 0 ? childRows[childRows.length-1].rowNum : parentRowNum;

          if ((currentMaxRows - (trueLastRow + 1)) < newRowDates.length) {
            const toAdd = newRowDates.length - (currentMaxRows - (trueLastRow + 1)) + 5;
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: { requests: [{
                insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + toAdd }, inheritFromBefore: true },
              }] },
            });
            currentMaxRows += toAdd;
          }

          // Move all the new blank rows into position in ONE operation. The blank
          // rows at the tail (trueLastRow onward) are contiguous with each other, so
          // rather than moving them one at a time (which was extremely slow — each
          // moveDimension call is a full round-trip), move the whole N-row block in
          // a single request straight to its destination.
          if (newRowDates.length > 0) {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: { requests: [{
                moveDimension: {
                  source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: trueLastRow, endIndex: trueLastRow + newRowDates.length },
                  destinationIndex: insertAfterRowNum,
                },
              }] },
            });
            trueLastRow += newRowDates.length;
          }

          // Write client/job/vat/invoice data into the new rows
          const writeData = [];
          const dateWriteData = [];
          for (let m = 0; m < newRowDates.length; m++) {
            const rn = insertAfterRowNum + 1 + m;
            writeData.push(
              { range: `Confirmed!A${rn}`, values: [[client]] },
              { range: `Confirmed!B${rn}`, values: [[jobName]] },
              { range: `Confirmed!AI${rn}`, values: [[vat || ""]] },
              { range: `Confirmed!AP${rn}`, values: [[revenue]] },
              { range: `Confirmed!AS${rn}`, values: [[defaultDaysToPay]] },
            );
            dateWriteData.push({ range: `Confirmed!AR${rn}`, values: [[retFmtDate(newRowDates[m])]] });
          }
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: writeData },
          });
          if (dateWriteData.length > 0) {
            await sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
            });
          }

          // Group the new rows with the job (extend existing group if present, else create one)
          try {
            const metaResp2 = await sheets.spreadsheets.get({ spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)" });
            const cs2 = metaResp2.data.sheets.find(s => s.properties.title === "Confirmed");
            const groups2 = cs2.rowGroups || [];
            const anchorIdx0 = insertAfterRowNum - 1;
            const coveringGroup = groups2.find(g => g.range?.startIndex <= anchorIdx0 && g.range?.endIndex > anchorIdx0);
            const newRangeEnd = insertAfterRowNum + newRowDates.length;
            if (coveringGroup) {
              await sheets.spreadsheets.batchUpdate({
                spreadsheetId: sheetIdClean,
                requestBody: { requests: [
                  { deleteDimensionGroup: { range: {
                      sheetId: gridSheetId, dimension: "ROWS",
                      startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex,
                    } } },
                  { addDimensionGroup: { range: {
                      sheetId: gridSheetId, dimension: "ROWS",
                      startIndex: coveringGroup.range.startIndex, endIndex: newRangeEnd,
                    } } },
                ] },
              });
            } else {
              await sheets.spreadsheets.batchUpdate({
                spreadsheetId: sheetIdClean,
                requestBody: { requests: [{
                  addDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: insertAfterRowNum, endIndex: newRangeEnd } },
                }] },
              });
            }
          } catch (groupErr) {
            console.log(`  ⚠ Row grouping for grown retainer rows failed (non-fatal): ${groupErr.message}`);
          }

          // Finally, update the parent row's end date
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetIdClean, range: `Confirmed!AM${parentRowNum}`,
            valueInputOption: "USER_ENTERED", requestBody: { values: [[newEndDate]] },
          });

          console.log(`  ✅ change_retainer_end_date: grew ${newRowDates.length} row(s) for ${client} — ${jobName}`);
          return res.status(200).json({ success: true, trimmed: 0, grown: newRowDates.length });
        }
      } catch (err) {
        console.error("❌ change_retainer_end_date error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "change_retainer_monthly_amount") {
      // Splits a retainer job into two at a given month: the existing job ends the
      // month before, and a new job (same name + " (Mon Year-)" suffix) begins with
      // the new monthly amount from that month onward. Existing rows from the
      // matched month onward are relabelled to the new job and given the new
      // invoice amount (revenue itself is a parent-row-only field, never on children).
      //
      // Optional fields (used when this split is triggered by a retainer alert's
      // "Change retainer amount" action, where the new rate was inferred from a
      // REAL invoice found elsewhere):
      //   sourceInvoiceRef / sourceInvoiceSentDate / sourceInvoiceDaysToPay /
      //   sourceInvoiceStatus — if provided, these overwrite the new job's first
      //   invoice slot (on matchedRow) instead of leaving whatever was already
      //   there, so the real invoice reference/dates/status carry over correctly.
      //   sourceConfirmedRow — if the alternative invoice was itself sitting on
      //   ANOTHER row in Confirmed (e.g. an orphan project job that never matched
      //   its real retainer), that row is fully cleared afterward — columns A:E,
      //   AG:AM, all three invoice slots, all three expense slots — since its
      //   data has now been relocated onto the retainer. No safety check on prior
      //   contents: the caller (the alert resolution flow) is responsible for
      //   confirming this is the correct row before calling.
      const {
        clientSheetId, client, jobName, parentRowNum, changeMonth, changeYear, newMonthlyAmount,
        sourceInvoiceRef, sourceInvoiceSentDate, sourceInvoiceDaysToPay, sourceInvoiceStatus, sourceConfirmedRow,
      } = req.body;
      if (!clientSheetId || !jobName || !parentRowNum || changeMonth === undefined || !changeYear || !newMonthlyAmount) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rows = resp.data.values || [];
        const parentRow = rows[parentRowNum - 1] || [];
        if (String(parentRow[0]||"").trim() !== client || String(parentRow[1]||"").trim() !== jobName) {
          return res.status(400).json({ success: false, error: "Row mismatch — job may have moved. Please refresh and try again." });
        }

        const oldRevenue = retParseMoney(parentRow[32]);
        const oldEndDate = retParseSheetDate(parentRow[38]);
        const changeMonthVal = changeYear * 12 + changeMonth; // changeMonth: 0-indexed

        // Collect child rows with their invoice dates
        const childRows = [];
        let cj = parentRowNum;
        while (cj < rows.length) {
          const next = rows[cj] || [];
          if (String(next[0]||"").trim() === client && String(next[1]||"").trim() === jobName &&
              !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
            childRows.push({ rowNum: cj + 1, row: next });
            cj++;
          } else break;
        }
        const allRows = [{ rowNum: parentRowNum, row: parentRow, isParent: true }].concat(childRows);
        const datedRows = allRows.map(r => ({ ...r, invDate: retParseSheetDate(r.row[43]) })).filter(r => r.invDate);
        const intervalMonths = retDetectIntervalMonths(datedRows.map(r => r.invDate));

        // Detect whether this job's invoices are sent BEFORE the period they cover
        // (e.g. 28-Nov for December) or DURING it (e.g. 3-Dec for December) —
        // inferred from the job's own invoice history. Without this, selecting
        // "December" as the change month when December's invoice was actually sent
        // in November would incorrectly match the FOLLOWING month's row instead.
        const jobStartDateForOffset = retParseSheetDate(parentRow[37]);
        const invoiceTimingOffset = retDetectInvoiceTimingOffset_(datedRows.map(r => r.invDate), jobStartDateForOffset, intervalMonths);
        const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : 0; // months to ADD to a sent-date to get its true covered-period month

        // Find the row whose invoice COVERS the change month — i.e. the row with the
        // latest invoice date that is <= the change month (accounts for quarterly
        // invoices, where a single row's invoice date might be 1-2 months before the
        // target month but still "covers" it via the detected interval).
        let matchedRow = null;
        let matchedRowPeriodStartVal = null;
        for (let i = datedRows.length - 1; i >= 0; i--) {
          const rowMonthVal = datedRows[i].invDate.getFullYear() * 12 + datedRows[i].invDate.getMonth() + timingMonthAdjust;
          if (rowMonthVal <= changeMonthVal) { matchedRow = datedRows[i]; matchedRowPeriodStartVal = rowMonthVal; break; }
        }
        if (!matchedRow) {
          return res.status(400).json({ success: false, error: "Could not find a row covering that month — check the selected month against the job's invoice schedule." });
        }
        if (matchedRow.isParent) {
          return res.status(400).json({ success: false, error: "The change month falls within the job's very first invoice period, which is on the parent row — please choose a later month, or edit the job directly." });
        }
        // The matched row's invoice covers [matchedRowPeriodStartVal,
        // matchedRowPeriodStartVal + intervalMonths - 1]. Two distinct problem cases
        // can arise here, and need different messages:
        //  1. TRUE MID-PERIOD: the requested month falls WITHIN that period but isn't
        //     its first month (e.g. period is May-Jul, requested month is June) —
        //     splitting here would leave one invoice's amount/dates spanning across
        //     both the old and new jobs incoherently.
        //  2. GAP / ROW NOT YET CREATED: the requested month falls AFTER that period
        //     entirely (e.g. matched row is the last one on file, covering May-Jul,
        //     but the user asked for November) — there's simply no invoice row for
        //     the requested month yet, so matching the last available row would be
        //     wrong, not just imprecise. This can happen if the rolling 18-month
        //     window hasn't generated that row yet, or the end date needs extending
        //     first.
        const matchedRowPeriodEndVal = matchedRowPeriodStartVal + intervalMonths - 1;
        if (changeMonthVal > matchedRowPeriodEndVal) {
          const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const lastPeriodStartLabel = `${months[matchedRowPeriodStartVal % 12]} ${Math.floor(matchedRowPeriodStartVal / 12)}`;
          const lastPeriodEndLabel = `${months[matchedRowPeriodEndVal % 12]} ${Math.floor(matchedRowPeriodEndVal / 12)}`;
          const requestedLabel = `${months[changeMonthVal % 12]} ${Math.floor(changeMonthVal / 12)}`;
          return res.status(200).json({
            success: false,
            blocked: true,
            error: `The requested month (${requestedLabel}) doesn't have an invoice row yet — the last invoice on file covers ${lastPeriodStartLabel} to ${lastPeriodEndLabel}. This can happen if future invoice rows haven't been generated yet; please try extending the job's end date first (which will create the missing rows), then retry the amount change.`,
          });
        }
        if (intervalMonths > 1 && changeMonthVal !== matchedRowPeriodStartVal) {
          const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const periodStartLabel = `${months[matchedRowPeriodStartVal % 12]} ${Math.floor(matchedRowPeriodStartVal / 12)}`;
          const periodEndLabel = `${months[matchedRowPeriodEndVal % 12]} ${Math.floor(matchedRowPeriodEndVal / 12)}`;
          return res.status(200).json({
            success: false,
            blocked: true,
            error: `This change falls in the middle of an invoicing period (${periodStartLabel} to ${periodEndLabel}, invoiced together as one ${intervalMonths}-month invoice) — this will need to be handled manually. Please choose ${periodStartLabel} instead, or edit the job directly.`,
          });
        }

        // Get sheet metadata for grouping/moving
        const metaResp = await sheets.spreadsheets.get({
          spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
        });
        const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
        const gridSheetId = confirmedSheet.properties.sheetId;
        const rowGroups = confirmedSheet.rowGroups || [];
        let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

        const freshValsResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR" + currentMaxRows, valueRenderOption: "UNFORMATTED_VALUE",
        });
        let trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshValsResp.data.values || []);

        // Ensure headroom, then move a blank row to sit directly above matchedRow.rowNum
        if ((currentMaxRows - (trueLastRow + 1)) < 1) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: { requests: [{
              insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 }, inheritFromBefore: true },
            }] },
          });
          currentMaxRows += 5;
        }
        const newParentDestIdx0 = matchedRow.rowNum - 1; // 0-indexed position just above matchedRow (inserting here pushes matchedRow down by 1)
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: [{
            moveDimension: {
              source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: trueLastRow, endIndex: trueLastRow + 1 },
              destinationIndex: newParentDestIdx0,
            },
          }] },
        });
        const newParentRowNum = matchedRow.rowNum; // the moved row now occupies what was matchedRow's position; matchedRow shifted to +1

        // Determine the new job name — detect and replace an existing "(Mon Year-)" suffix
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const changeMonthLabel = `${months[changeMonth]} ${changeYear}`;
        const suffixPattern = /\s*\(\w{3} \d{4}-\)\s*$/;
        const baseJobName = jobName.replace(suffixPattern, "").trim();
        const newJobName = `${baseJobName} (${changeMonthLabel}-)`;

        // Old job's new end date = last day of the month BEFORE the change month
        const oldJobNewEndDate = new Date(changeYear, changeMonth, 0); // day 0 of changeMonth = last day of prior month
        const newJobStartDate = new Date(changeYear, changeMonth, 1);

        // Copy A:E and AG:AM from old parent onto the new parent row, then override
        const copiedAE = parentRow.slice(0, 5); // A:E (client, job, code, and whatever else lives in D/E)
        const copiedAGtoAM = parentRow.slice(32, 39); // AG:AM (revenue, dirCosts, vat, type, blank, start, end)

        const writeData = [];
        const dateWriteData = [
          // Old job: end date shortened
          { range: `Confirmed!AM${parentRowNum}`, values: [[retFmtDate(oldJobNewEndDate)]] },
        ];
        // New parent row: A:E copied verbatim except job name overridden
        for (let i = 0; i < copiedAE.length; i++) {
          const colLetter = ["A","B","C","D","E"][i];
          const val = (colLetter === "B") ? newJobName : (copiedAE[i] !== undefined ? copiedAE[i] : "");
          writeData.push({ range: `Confirmed!${colLetter}${newParentRowNum}`, values: [[val]] });
        }
        // AG:AM copied verbatim except revenue (AG) and start date (AL) — AL and AM are dates
        const agToAmCols = ["AG","AH","AI","AJ","AK","AL","AM"];
        for (let i = 0; i < agToAmCols.length; i++) {
          const colLetter = agToAmCols[i];
          let val = copiedAGtoAM[i] !== undefined ? copiedAGtoAM[i] : "";
          if (colLetter === "AG") val = newMonthlyAmount;
          // AH (direct costs) was read via FORMATTED_VALUE, so it arrives as a
          // display string like "£0.00" — write it back as a real number, or
          // Sheets stores the copy as literal text (visible as a leading '£0.00
          // apostrophe) instead of a usable numeric value.
          if (colLetter === "AH") val = retParseMoney(val);
          if (colLetter === "AL") val = retFmtDate(newJobStartDate);
          // AM (end date) stays as the OLD job's original end date, per spec
          if (colLetter === "AM") val = oldEndDate ? retFmtDate(oldEndDate) : (copiedAGtoAM[i] || "");
          const target = (colLetter === "AL" || colLetter === "AM") ? dateWriteData : writeData;
          target.push({ range: `Confirmed!${colLetter}${newParentRowNum}`, values: [[val]] });
        }

        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: writeData },
        });
        if (dateWriteData.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
          });
        }

        // Relabel all rows from matchedRow onward (now shifted down by 1) to the new
        // job name, and update their invoice slot amount to the new amount. Each
        // relabelled row's invoice covers `intervalMonths` months (e.g. 3 for a
        // quarterly retainer), so the amount written must be the NEW MONTHLY RATE
        // multiplied by that interval — writing the bare monthly figure into a
        // quarterly invoice slot would understate it by a factor of 3.
        // matchedRow.rowNum was matchedRow's row BEFORE the insert; after the move it's +1.
        const relabelStartRow = matchedRow.rowNum + 1;
        const relabelRows = childRows.filter(cr => cr.rowNum >= matchedRow.rowNum).map(cr => cr.rowNum + 1);
        const newPerInvoiceAmount = newMonthlyAmount * (intervalMonths || 1);
        const relabelData = [];
        const relabelDateData = [];
        for (const rn of relabelRows) {
          relabelData.push({ range: `Confirmed!B${rn}`, values: [[newJobName]] });
          // Update whichever invoice slot has data on this row to the new amount —
          // find it by checking which slot has a non-blank amount (child rows only ever use slot 1 for retainers)
          relabelData.push({ range: `Confirmed!AP${rn}`, values: [[newPerInvoiceAmount]] });
        }
        // If this split was triggered from a retainer alert with a REAL alternative
        // invoice, carry its reference/dates/status onto the new job's first child
        // row (matchedRow, now shifted to relabelStartRow) so the genuine invoice
        // record — not a placeholder — represents that first period.
        if (sourceInvoiceRef || sourceInvoiceSentDate) {
          relabelData.push({ range: `Confirmed!AQ${relabelStartRow}`, values: [[sourceInvoiceRef || ""]] });
          const parsedDaysToPay = parseInt(String(sourceInvoiceDaysToPay || "").replace(/[^\d.-]/g, ""), 10);
          relabelData.push({ range: `Confirmed!AS${relabelStartRow}`, values: [[!isNaN(parsedDaysToPay) && parsedDaysToPay > 0 ? parsedDaysToPay : 30]] });
          relabelData.push({ range: `Confirmed!AT${relabelStartRow}`, values: [[sourceInvoiceStatus || ""]] });
          if (sourceInvoiceSentDate) {
            const parsedSourceSent = retParseSheetDate(sourceInvoiceSentDate);
            if (parsedSourceSent) relabelDateData.push({ range: `Confirmed!AR${relabelStartRow}`, values: [[retFmtDate(parsedSourceSent)]] });
          }
        }
        if (relabelData.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: relabelData },
          });
        }
        if (relabelDateData.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: relabelDateData },
          });
        }

        // If the alternative invoice was itself attached to ANOTHER job elsewhere
        // in Confirmed (an orphan that never matched its real retainer), fully
        // clear that job's row(s) now — its data has been relocated onto the
        // retainer above. The orphan job may itself be a parent+children job (not
        // just a single row) — find any child rows using the same client+jobName
        // matching pattern used everywhere else in this codebase, BEFORE the move
        // above renumbers anything, then clear every one of them.
        // IMPORTANT: sourceConfirmedRow (and any child rows found below it) were
        // identified from `rows`, read BEFORE the moveDimension above inserted the
        // new parent row. Any row at or after the insertion point
        // (newParentDestIdx0, 0-indexed) shifted down by one as a result of that
        // move — so every row number must be adjusted here, or the clear silently
        // hits the wrong row while the real source data goes untouched.
        if (sourceConfirmedRow) {
          const srcRowNumOriginal = parseInt(sourceConfirmedRow, 10);
          if (srcRowNumOriginal && srcRowNumOriginal > 0) {
            const srcParentRowOriginal = rows[srcRowNumOriginal - 1] || [];
            const srcClient = String(srcParentRowOriginal[0] || "").trim();
            const srcJobName = String(srcParentRowOriginal[1] || "").trim();
            const srcRowsToClearOriginal = [srcRowNumOriginal];
            let srcChildIdx = srcRowNumOriginal; // 0-indexed next row = srcRowNumOriginal (1-indexed)
            while (srcChildIdx < rows.length) {
              const next = rows[srcChildIdx] || [];
              if (String(next[0]||"").trim() === srcClient && String(next[1]||"").trim() === srcJobName &&
                  !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
                srcRowsToClearOriginal.push(srcChildIdx + 1);
                srcChildIdx++;
              } else break;
            }

            const clearRanges = [];
            const clearedRowNums = [];
            for (const originalRowNum of srcRowsToClearOriginal) {
              let adjustedRow = originalRowNum;
              const idx0Original = originalRowNum - 1;
              if (idx0Original >= newParentDestIdx0) adjustedRow += 1; // shifted down by the insert
              clearedRowNums.push(adjustedRow);
              clearRanges.push(
                `Confirmed!A${adjustedRow}:E${adjustedRow}`,
                `Confirmed!AG${adjustedRow}:AM${adjustedRow}`,
                `Confirmed!AP${adjustedRow}:BH${adjustedRow}`,
                `Confirmed!BX${adjustedRow}:CR${adjustedRow}`,
              );
            }
            await sheets.spreadsheets.values.batchClear({
              spreadsheetId: sheetIdClean,
              requestBody: { ranges: clearRanges },
            });
            console.log(`  🧹 change_retainer_monthly_amount: cleared source job "${srcJobName}" (${srcClient}) — ${clearedRowNums.length} row(s): [${clearedRowNums.join(", ")}] (originally [${srcRowsToClearOriginal.join(", ")}] before the retainer split shifted them — data relocated to new retainer)`);
          }
        }

        // Regroup: split into two separate groups — old job's rows, and new job's rows.
        try {
          const oldJobLastChildBeforeSplit = childRows.filter(cr => cr.rowNum < matchedRow.rowNum);
          const oldGroupEnd = oldJobLastChildBeforeSplit.length > 0
            ? oldJobLastChildBeforeSplit[oldJobLastChildBeforeSplit.length - 1].rowNum
            : parentRowNum;
          // The group covers CHILD rows only, starting from the new job's first
          // child — never the parent row itself (matches how every existing
          // retainer group on this sheet is structured: parent row stays outside
          // any group, only its children are grouped/collapsible underneath it).
          const newGroupStart = relabelRows.length > 0 ? relabelRows[0] : null;
          const newGroupEnd = relabelRows.length > 0 ? relabelRows[relabelRows.length - 1] : null;

          // Re-fetch rowGroups AFTER the row move above — the group boundaries we
          // read at the very start of this action are now stale, since inserting
          // the new parent row shifted every row below it down by one. Using that
          // stale snapshot here was the cause of a duplicate/incorrect sub-group
          // appearing after a monthly-amount split.
          const freshGroupsResp = await sheets.spreadsheets.get({
            spreadsheetId: sheetIdClean, fields: "sheets(properties.title,rowGroups)",
          });
          const freshConfirmedSheet = (freshGroupsResp.data.sheets || []).find(s => s.properties?.title === "Confirmed");
          const currentRowGroups = freshConfirmedSheet?.rowGroups || [];

          // IMPORTANT: retainer parent rows are NOT themselves part of a row group —
          // only the child rows underneath are grouped/collapsible. So the group we
          // need to shrink or remove isn't found by anchoring on parentRowNum; it's
          // whichever group(s) overlap the ORIGINAL child-row range that's now being
          // split into "old job's remaining children" + "new job's children" (the
          // new job's PARENT row sits outside any group, same as every other
          // retainer parent). Find every group whose range overlaps
          // [oldFirstChildRowNum, newGroupEnd] (0-indexed, inclusive-exclusive) and
          // handle each: if it falls entirely within the old job's portion, leave
          // it; if it falls entirely within the new portion, leave it (the new
          // addDimensionGroup below will cover that span); if it SPANS the split
          // point (covers rows from both the old job's tail and the new job's
          // children), delete it and re-add only the old-job portion, since the
          // new-job portion is covered by the fresh group we add afterwards.
          if (newGroupStart === null) {
            console.log(`  ⚠ Retainer split produced no child rows for the new job — skipping regrouping (nothing to group).`);
          } else {
          const oldFirstChildRowNum = childRows.length > 0 ? childRows[0].rowNum : parentRowNum;
          const scanStartIdx0 = oldFirstChildRowNum - 1;
          const scanEndIdx0 = newGroupEnd; // exclusive
          const overlappingGroups = currentRowGroups.filter(g =>
            g.range && g.range.startIndex < scanEndIdx0 && g.range.endIndex > scanStartIdx0
          );

          // IMPORTANT: Google Sheets silently MERGES adjacent same-depth groups
          // when they're added in the same batchUpdate call — confirmed by testing:
          // adding group A (239:243) then group B (243:258) in one batch produced a
          // single merged 239:258 group, undoing the split entirely, even though
          // each add request looked correct individually. The two groups here are
          // necessarily adjacent (they meet exactly at the new job's parent row,
          // which sits outside both groups), so they MUST be sent as separate,
          // sequential batchUpdate calls — never combined into one — or Sheets
          // reconciles them back into a single group.
          const deleteRequests = [];
          const addRequestsSequential = [];
          for (const g of overlappingGroups) {
            const spansSplitPoint = g.range.startIndex < (newParentRowNum - 1) && g.range.endIndex > (newParentRowNum - 1);
            if (!spansSplitPoint) continue; // doesn't cross the split boundary — leave it alone
            deleteRequests.push({ deleteDimensionGroup: { range: {
              sheetId: gridSheetId, dimension: "ROWS",
              startIndex: g.range.startIndex, endIndex: g.range.endIndex,
            } } });
            // Re-add only the portion of this group that belongs to the OLD job —
            // up to (but excluding) the new job's PARENT row, which must never be
            // inside any group. Using newGroupStart-1 here was wrong: newGroupStart
            // is the new job's first CHILD row, one row too far — it included the
            // parent row (newParentRowNum) in the old job's group. The correct
            // boundary is newParentRowNum-1 (0-indexed, exclusive), which stops
            // right before the parent row.
            const keepEnd = Math.min(g.range.endIndex, newParentRowNum - 1);
            if (keepEnd > g.range.startIndex) {
              addRequestsSequential.push({ startIndex: g.range.startIndex, endIndex: keepEnd });
            }
          }
          // The new job's group, covering its CHILD rows only (not its parent).
          addRequestsSequential.push({ startIndex: newGroupStart - 1, endIndex: newGroupEnd });

          if (deleteRequests.length > 0) {
            await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetIdClean, requestBody: { requests: deleteRequests } });
          }
          // Send each addDimensionGroup in its OWN batchUpdate call, sequentially,
          // so Sheets commits each group before the next is added — this is what
          // actually prevents the auto-merge.
          for (const r of addRequestsSequential) {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: { requests: [{ addDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: r.startIndex, endIndex: r.endIndex } } }] },
            });
          }
          } // end of newGroupStart !== null guard
        } catch (groupErr) {
          console.log(`  ⚠ Row grouping for retainer split failed (non-fatal): ${groupErr.message}`);
          console.log(`  🔬 REGROUP full error: ${JSON.stringify(groupErr.response?.data || groupErr.errors || { message: groupErr.message, stack: groupErr.stack }, null, 2)}`);
        }

        console.log(`  ✅ change_retainer_monthly_amount: split "${jobName}" at ${changeMonthLabel} — new job "${newJobName}" at row ${newParentRowNum}`);
        return res.status(200).json({ success: true, newParentRowNum, newJobName, relabelledRows: relabelRows.length });
      } catch (err) {
        console.error("❌ change_retainer_monthly_amount error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "create_retainer_job") {
      // Creates a brand-new retainer job: a parent row plus a rolling window of
      // child rows (same "pastCount + 18 future months" window the nightly
      // retainer audit maintains), placed at the first genuinely-blank row at the
      // bottom of the sheet's real data (found by scanning UP from the sheet's
      // tail, same mechanism the grow/trim logic already uses — no rows are moved
      // "up" into a gap; a blank row is simply relocated FROM the tail).
      const {
        clientSheetId, masterSheetId, client, jobName, monthlyRevenue, monthlyDirectCosts,
        vat, startDate, endDate, invoiceFrequency, invoiceSendDay,
      } = req.body;
      if (!clientSheetId || !client || !jobName || !monthlyRevenue || !startDate || !endDate || !invoiceFrequency || !invoiceSendDay) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const intervalMonths = invoiceFrequency === "quarterly" ? 3 : 1;
        const start = retParseSheetDate(startDate);
        const end = retParseSheetDate(endDate);
        if (!start || !end) return res.status(400).json({ success: false, error: "Invalid start or end date" });
        if (end < start) return res.status(400).json({ success: false, error: "End date can't be before start date" });

        const sendDay = parseInt(invoiceSendDay, 10);
        if (!sendDay || sendDay < 1 || sendDay > 31) {
          return res.status(400).json({ success: false, error: "Invoice send day must be between 1 and 31" });
        }

        const revenue = parseFloat(monthlyRevenue) || 0;
        const directCosts = parseFloat(monthlyDirectCosts) || 0;
        const perInvoiceAmount = revenue * intervalMonths;

        // Read the client's configured default "days to pay" from the master sheet
        // (same source the nightly retainer audit and grow-path use).
        const { defaultDaysToPay: rawDefaultDaysToPay } = await getToleranceValues(sheets, masterSheetId || sheetIdClean);
        const defaultDaysToPay = parseInt(String(rawDefaultDaysToPay).replace(/[^\d.-]/g, ""), 10) || 30;

        // Work out how many child rows to create — the same rolling 18-month
        // FUTURE window the nightly audit maintains: pastCount (periods already
        // elapsed relative to today) + 18, capped by the end date and total
        // contract value. For a brand-new job, pastCount will typically be 0
        // unless the start date is already in the past.
        const today = new Date(); today.setHours(0,0,0,0);
        const currentMonthVal = today.getFullYear() * 12 + today.getMonth();

        // Build the full list of period start dates (one per invoice) from the
        // job's start date, stepping by intervalMonths, capped by the end date.
        const periodStarts = [];
        let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
        const endMonthVal = end.getFullYear() * 12 + end.getMonth();
        while (true) {
          const cursorMonthVal = cursor.getFullYear() * 12 + cursor.getMonth();
          if (cursorMonthVal > endMonthVal) break;
          periodStarts.push(new Date(cursor));
          cursor = new Date(cursor.getFullYear(), cursor.getMonth() + intervalMonths, 1);
        }
        const pastCount = periodStarts.filter(d => (d.getFullYear()*12 + d.getMonth()) <= currentMonthVal).length;
        const targetPeriodCount = Math.min(periodStarts.length, pastCount + 18);

        if (targetPeriodCount === 0) {
          return res.status(400).json({ success: false, error: "No invoice periods fall within the given start and end dates." });
        }

        // Retainer invoices only ever go on CHILD rows — the parent row carries
        // the job's own details (client, name, revenue, dates) but never an
        // invoice itself. So every period becomes a child row.
        const childSendDates = periodStarts.slice(0, targetPeriodCount).map(p => new Date(p.getFullYear(), p.getMonth(), sendDay));

        // Find the true last row with real data, and ensure enough headroom below
        // it to move the parent + child blank rows into position.
        const metaResp = await sheets.spreadsheets.get({
          spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
        });
        const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
        const gridSheetId = confirmedSheet.properties.sheetId;
        let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

        const freshResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR" + currentMaxRows, valueRenderOption: "UNFORMATTED_VALUE",
        });
        let trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshResp.data.values || []);

        const rowsNeeded = 1 + childSendDates.length; // parent + children
        if ((currentMaxRows - (trueLastRow + 1)) < rowsNeeded) {
          const toAdd = rowsNeeded - (currentMaxRows - (trueLastRow + 1)) + 5;
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: { requests: [{
              insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + toAdd }, inheritFromBefore: true },
            }] },
          });
          currentMaxRows += toAdd;
        }

        // Since we're placing the new job directly at the tail (right after the
        // true last row), the target rows are already exactly where they need to
        // be — no moveDimension is needed at all, unlike the grow/trim paths which
        // relocate rows from elsewhere. We just write directly into place.
        const newParentRowNum = trueLastRow + 1;

        // Write parent row: client, job name, revenue, direct costs, VAT, type,
        // and start/end dates. NO invoice data here — retainer invoices only ever
        // go on child rows, never the parent.
        const writeData = [
          { range: `Confirmed!A${newParentRowNum}`, values: [[client]] },
          { range: `Confirmed!B${newParentRowNum}`, values: [[jobName]] },
          { range: `Confirmed!AG${newParentRowNum}`, values: [[revenue]] },
          { range: `Confirmed!AH${newParentRowNum}`, values: [[directCosts]] },
          { range: `Confirmed!AI${newParentRowNum}`, values: [[vat || "No"]] },
          { range: `Confirmed!AJ${newParentRowNum}`, values: [["Retainer"]] },
        ];
        const dateWriteData = [
          { range: `Confirmed!AL${newParentRowNum}`, values: [[retFmtDate(start)]] },
          { range: `Confirmed!AM${newParentRowNum}`, values: [[retFmtDate(end)]] },
        ];

        for (let i = 0; i < childSendDates.length; i++) {
          const rn = newParentRowNum + 1 + i;
          writeData.push(
            { range: `Confirmed!A${rn}`, values: [[client]] },
            { range: `Confirmed!B${rn}`, values: [[jobName]] },
            { range: `Confirmed!AP${rn}`, values: [[perInvoiceAmount]] },
            { range: `Confirmed!AS${rn}`, values: [[defaultDaysToPay]] },
          );
          dateWriteData.push({ range: `Confirmed!AR${rn}`, values: [[retFmtDate(childSendDates[i])]] });
        }

        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: writeData },
        });
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
        });

        // Group the child rows only (parent row stays outside any group, matching
        // every other retainer job on this sheet).
        if (childSendDates.length > 0) {
          try {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: { requests: [{
                addDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: newParentRowNum, endIndex: newParentRowNum + childSendDates.length } },
              }] },
            });
          } catch (groupErr) {
            console.log(`  ⚠ Row grouping for new retainer failed (non-fatal): ${groupErr.message}`);
          }
        }

        console.log(`  ✅ create_retainer_job: created "${jobName}" for ${client} at row ${newParentRowNum} with ${childSendDates.length} child row(s)`);
        return res.status(200).json({ success: true, parentRowNum: newParentRowNum, childRowCount: childSendDates.length });
      } catch (err) {
        console.error("❌ create_retainer_job error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "compute_retainer_alert_resolution") {
      // Given a retainer_invoice proactive alert's own data, computes what an
      // "End retainer" or "Change retainer amount" resolution WOULD do, without
      // making any changes — used to populate the confirmation screen on the
      // alert card before the user confirms. resolutionType: "end" | "changeAmount".
      const { clientSheetId, masterSheetId, client, jobName, parentRowNum, resolutionType,
        lastInvoiceDate, possibleMatchSentDate, possibleMatchAmount, possibleMatchInvoiceNo, possibleMatchConfirmedRow } = req.body;
      if (!clientSheetId || !jobName || !parentRowNum || !resolutionType) {
        console.log(`  🔬 MISSING-FIELDS DIAG req.body=${JSON.stringify(req.body)}`);
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rows = resp.data.values || [];
        const parentRow = rows[parentRowNum - 1] || [];
        if (String(parentRow[0]||"").trim() !== client || String(parentRow[1]||"").trim() !== jobName) {
          return res.status(400).json({ success: false, error: "Row mismatch — this job may have moved since the alert was raised. Please check the Retainers screen directly." });
        }

        const jobStartDate = retParseSheetDate(parentRow[37]);

        // Collect child rows + their invoice dates, same as the other retainer actions
        const childRows = [];
        let cj = parentRowNum;
        while (cj < rows.length) {
          const next = rows[cj] || [];
          if (String(next[0]||"").trim() === client && String(next[1]||"").trim() === jobName &&
              !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
            childRows.push({ rowNum: cj + 1, row: next });
            cj++;
          } else break;
        }
        const parentInvDate = retParseSheetDate(parentRow[43]);
        const allInvoiceDates = (parentInvDate ? [parentInvDate] : []).concat(
          childRows.map(cr => retParseSheetDate(cr.row[43])).filter(Boolean)
        );
        const intervalMonths = retDetectIntervalMonths(allInvoiceDates);
        const invoiceTimingOffset = retDetectInvoiceTimingOffset_(allInvoiceDates, jobStartDate, intervalMonths);
        const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : 0;

        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

        if (resolutionType === "end") {
          // Determine which period the LAST SENT invoice actually covers (using the
          // detected timing pattern), then set the end date to the LAST calendar
          // day of that period.
          const lastSent = retParseSheetDate(lastInvoiceDate);
          if (!lastSent) {
            return res.status(400).json({ success: false, error: "Could not determine the last invoice's sent date from this alert." });
          }
          const coveredPeriodStartVal = lastSent.getFullYear() * 12 + lastSent.getMonth() + timingMonthAdjust;
          const coveredPeriodEndVal = coveredPeriodStartVal + intervalMonths - 1;
          const endYear = Math.floor(coveredPeriodEndVal / 12);
          const endMonth0 = coveredPeriodEndVal % 12;
          const lastDayOfMonth = new Date(endYear, endMonth0 + 1, 0).getDate();
          const computedEndDate = new Date(endYear, endMonth0, lastDayOfMonth);

          return res.status(200).json({
            success: true,
            resolutionType: "end",
            computedEndDate: retFmtDate(computedEndDate),
            computedEndDateLabel: `${lastDayOfMonth}-${months[endMonth0]}-${endYear}`,
            coveredPeriodLabel: intervalMonths > 1
              ? `${months[coveredPeriodStartVal % 12]} ${Math.floor(coveredPeriodStartVal/12)} to ${months[coveredPeriodEndVal % 12]} ${endYear}`
              : `${months[coveredPeriodStartVal % 12]} ${Math.floor(coveredPeriodStartVal/12)}`,
            lastInvoiceSentDate: retFmtDate(lastSent),
          });

        } else if (resolutionType === "changeAmount") {
          // Determine which period the ALTERNATIVE invoice (found by the alert)
          // covers, then express its amount as a MONTHLY rate (dividing by the
          // job's detected interval, since change_retainer_monthly_amount always
          // takes a monthly figure and multiplies it back up internally).
          const altSent = retParseSheetDate(possibleMatchSentDate);
          const altAmount = parseFloat(possibleMatchAmount);
          if (!altSent || isNaN(altAmount)) {
            return res.status(400).json({ success: false, error: "Could not determine the alternative invoice's date or amount from this alert." });
          }
          const coveredPeriodStartVal = altSent.getFullYear() * 12 + altSent.getMonth() + timingMonthAdjust;
          const endYear = Math.floor(coveredPeriodStartVal / 12);
          const endMonth0 = coveredPeriodStartVal % 12;
          const newMonthlyAmount = altAmount / (intervalMonths || 1);

          // If the alternative invoice is already attached to another job on
          // Confirmed, look up that row's exact invoice slot so we can carry over
          // its precise reference/days-to-pay/status (not just amount and date,
          // which is all the alert itself captured) — and confirm which slot and
          // job it actually belongs to, for the confirmation screen to show.
          let sourceRowInfo = null;
          if (possibleMatchConfirmedRow) {
            const srcRowNum = parseInt(possibleMatchConfirmedRow, 10);
            const srcRow = rows[srcRowNum - 1];
            if (srcRow) {
              const slotDefs = [
                { amt: 41, ref: 42, sent: 43, days: 44, status: 45 },
                { amt: 48, ref: 49, sent: 50, days: 51, status: 52 },
                { amt: 55, ref: 56, sent: 57, days: 58, status: 59 },
              ];
              const matchedSlot = slotDefs.find(s => String(srcRow[s.ref] || "").trim() === String(possibleMatchInvoiceNo || "").trim());
              if (matchedSlot) {
                // Count any child rows this source job has (same client+jobName,
                // no revenue/dates of its own) so the confirmation screen can
                // accurately tell the user how many rows will actually be cleared.
                let srcChildCount = 0;
                let srcChildIdx = srcRowNum;
                while (srcChildIdx < rows.length) {
                  const next = rows[srcChildIdx] || [];
                  if (String(next[0]||"").trim() === String(srcRow[0]||"").trim() && String(next[1]||"").trim() === String(srcRow[1]||"").trim() &&
                      !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
                    srcChildCount++;
                    srcChildIdx++;
                  } else break;
                }
                sourceRowInfo = {
                  confirmedRow: srcRowNum,
                  client: String(srcRow[0] || "").trim(),
                  jobName: String(srcRow[1] || "").trim(),
                  ref: String(srcRow[matchedSlot.ref] || "").trim(),
                  sentDate: String(srcRow[matchedSlot.sent] || "").trim(),
                  daysToPay: String(srcRow[matchedSlot.days] || "").trim(),
                  status: String(srcRow[matchedSlot.status] || "").trim(),
                  totalRowsToClear: 1 + srcChildCount,
                };
              }
            }
          }

          return res.status(200).json({
            success: true,
            resolutionType: "changeAmount",
            changeMonth: endMonth0,
            changeYear: endYear,
            changeMonthLabel: `${months[endMonth0]} ${endYear}`,
            newMonthlyAmount: Math.round(newMonthlyAmount * 100) / 100,
            newPerInvoiceAmount: altAmount,
            intervalMonths,
            sourceInvoiceRef: possibleMatchInvoiceNo || "",
            sourceInvoiceSentDate: possibleMatchSentDate || "",
            sourceRowInfo, // null if the alternative invoice isn't attached to another Confirmed row
          });
        }

        return res.status(400).json({ success: false, error: "Unknown resolutionType" });
      } catch (err) {
        console.error("❌ compute_retainer_alert_resolution error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "compute_retainer_split_invoice_preview") {
      // Given a retainer_invoice alert with a possibleMatch present (at any amount,
      // higher or lower than expected), computes what "Split invoice" WOULD do,
      // without making any changes:
      //  1. Locates the retainer's own child row for the missing period (the exact
      //     row the alert flagged), to apply the STANDARD monthly amount there.
      //  2. Computes the difference between the alternative invoice's actual amount
      //     and the standard monthly amount (positive or negative).
      //  3. Checks whether the alternative invoice is already attached to another
      //     Confirmed row (possibleMatchConfirmedRow) — if so, that job would be
      //     converted in place; if not, a new standalone job would be created.
      const { clientSheetId, client, jobName, parentRowNum,
        lastInvoiceDate, possibleMatchSentDate, possibleMatchAmount, possibleMatchInvoiceNo,
        possibleMatchVatAmount, possibleMatchStatus, possibleMatchConfirmedRow } = req.body;
      if (!clientSheetId || !jobName || !parentRowNum || !lastInvoiceDate || !possibleMatchSentDate || possibleMatchAmount === undefined) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rows = resp.data.values || [];
        const parentRow = rows[parentRowNum - 1] || [];
        if (String(parentRow[0]||"").trim() !== client || String(parentRow[1]||"").trim() !== jobName) {
          return res.status(400).json({ success: false, error: "Row mismatch — this job may have moved since the alert was raised. Please check the Retainers screen directly." });
        }

        const standardMonthlyAmount = retParseMoney(parentRow[32]); // AG
        const altAmount = parseFloat(possibleMatchAmount) || 0;
        const altSentDate = retParseSheetDate(possibleMatchSentDate);
        const lastSent = retParseSheetDate(lastInvoiceDate);
        if (!altSentDate || !lastSent) {
          return res.status(400).json({ success: false, error: "Could not parse the invoice dates from this alert." });
        }

        // Collect child rows to find the missing period's own row — the first
        // child row with an invoice date AFTER lastInvoiceDate (i.e. the row the
        // alert is actually flagging as missing).
        const childRows = [];
        let cj = parentRowNum;
        while (cj < rows.length) {
          const next = rows[cj] || [];
          if (String(next[0]||"").trim() === client && String(next[1]||"").trim() === jobName &&
              !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
            childRows.push({ rowNum: cj + 1, row: next });
            cj++;
          } else break;
        }
        const missingRow = childRows
          .map(cr => ({ ...cr, invDate: retParseSheetDate(cr.row[43]) }))
          .filter(cr => cr.invDate && cr.invDate.getTime() > lastSent.getTime())
          .sort((a, b) => a.invDate.getTime() - b.invDate.getTime())[0];

        if (!missingRow) {
          return res.status(400).json({ success: false, error: "Could not find the missing invoice's row on this retainer job — it may already have been resolved, or the schedule has changed since the alert was raised." });
        }

        const difference = altAmount - standardMonthlyAmount;
        const vatAmount = parseFloat(possibleMatchVatAmount) || 0;

        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const extraJobName = `${months[altSentDate.getMonth()]} ${String(altSentDate.getFullYear()).slice(-2)} retainer extra revenue`;

        // Check whether the alternative invoice is already attached elsewhere
        let existingJobInfo = null;
        if (possibleMatchConfirmedRow) {
          const srcRowNum = parseInt(possibleMatchConfirmedRow, 10);
          const srcRow = rows[srcRowNum - 1];
          if (srcRow) {
            existingJobInfo = {
              confirmedRow: srcRowNum,
              client: String(srcRow[0] || "").trim(),
              jobName: String(srcRow[1] || "").trim(),
              currentRevenue: String(srcRow[32] || "").trim(),
            };
          }
        }

        return res.status(200).json({
          success: true,
          missingRowNum: missingRow.rowNum,
          missingRowPeriodLabel: `${months[missingRow.invDate.getMonth()]} ${missingRow.invDate.getFullYear()}`,
          standardMonthlyAmount,
          altAmount,
          altSentDate: possibleMatchSentDate,
          altInvoiceNo: possibleMatchInvoiceNo || "",
          altStatus: possibleMatchStatus || "",
          vatAmount,
          difference: Math.round(difference * 100) / 100,
          extraJobName,
          extraJobMonth: altSentDate.getMonth(),
          extraJobYear: altSentDate.getFullYear(),
          existingJobInfo, // null if no orphan job exists — a new one will be created
        });
      } catch (err) {
        console.error("❌ compute_retainer_split_invoice_preview error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "apply_retainer_split_invoice") {
      // Applies the "Split invoice" resolution:
      //  1. Writes the STANDARD monthly amount into the retainer's own missing-period
      //     child row (slot 1), with the alternative invoice's reference/sent date.
      //  2. Either updates an existing orphan job in place (revenue, invoice slot 1
      //     amount, job name, type, and Date conf/Lead src/Prod line copied from the
      //     retainer's parent row) or creates a brand-new standalone single-row job,
      //     to hold the DIFFERENCE between the actual and standard amounts (which may
      //     be negative).
      const {
        clientSheetId, masterSheetId, client, jobName, parentRowNum, missingRowNum,
        standardMonthlyAmount, altAmount, altSentDate, altInvoiceNo, altStatus, vatAmount, difference,
        extraJobName, extraJobMonth, extraJobYear, existingConfirmedRow,
      } = req.body;
      if (!clientSheetId || !jobName || !parentRowNum || !missingRowNum || difference === undefined) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rows = resp.data.values || [];
        const parentRow = rows[parentRowNum - 1] || [];
        if (String(parentRow[0]||"").trim() !== client || String(parentRow[1]||"").trim() !== jobName) {
          return res.status(400).json({ success: false, error: "Row mismatch — this job may have moved since the preview was computed. Please refresh and try again." });
        }
        const missingRow = rows[missingRowNum - 1] || [];
        if (String(missingRow[0]||"").trim() !== client || String(missingRow[1]||"").trim() !== jobName) {
          return res.status(400).json({ success: false, error: "The retainer's row layout has changed since the preview was computed. Please refresh and try again." });
        }

        const { defaultDaysToPay: rawDefaultDaysToPay } = await getToleranceValues(sheets, masterSheetId || sheetIdClean);
        const defaultDaysToPay = parseInt(String(rawDefaultDaysToPay).replace(/[^\d.-]/g, ""), 10) || 30;

        // ── STEP 1: write the standard amount into the retainer's own missing-period row ──
        const writeData = [
          { range: `Confirmed!AP${missingRowNum}`, values: [[standardMonthlyAmount]] },
          { range: `Confirmed!AQ${missingRowNum}`, values: [[altInvoiceNo || ""]] },
          { range: `Confirmed!AS${missingRowNum}`, values: [[defaultDaysToPay]] },
          { range: `Confirmed!AT${missingRowNum}`, values: [[altStatus || ""]] },
        ];
        const dateWriteData = [];
        const parsedAltSentDate = retParseSheetDate(altSentDate);
        if (parsedAltSentDate) dateWriteData.push({ range: `Confirmed!AR${missingRowNum}`, values: [[retFmtDate(parsedAltSentDate)]] });

        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: writeData },
        });
        if (dateWriteData.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
          });
        }

        // ── STEP 2: apply the difference to an existing or new "extra revenue" job ──
        const monthStart = new Date(extraJobYear, extraJobMonth, 1);
        const monthEnd = new Date(extraJobYear, extraJobMonth + 1, 0);
        const vatYesNo = (parseFloat(vatAmount) || 0) > 0 ? "Yes" : "No";

        if (existingConfirmedRow) {
          // Convert the existing orphan job in place — only revenue, invoice amount,
          // job name, type, and the three copied fields change; everything else
          // (client, dates, VAT, invoice ref/sent date) stays as-is since this job
          // already has its own real invoice attached.
          const extraWriteData = [
            { range: `Confirmed!B${existingConfirmedRow}`, values: [[extraJobName]] },
            { range: `Confirmed!D${existingConfirmedRow}`, values: [[parentRow[3] || ""]] },   // Date conf
            { range: `Confirmed!E${existingConfirmedRow}`, values: [[parentRow[4] || ""]] },   // Lead src
            { range: `Confirmed!AG${existingConfirmedRow}`, values: [[difference]] },
            { range: `Confirmed!AJ${existingConfirmedRow}`, values: [["Retainer"]] },
            { range: `Confirmed!AK${existingConfirmedRow}`, values: [[parentRow[36] || ""]] },  // Prod. line
            { range: `Confirmed!AP${existingConfirmedRow}`, values: [[difference]] },
          ];
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: extraWriteData },
          });
          console.log(`  ✅ apply_retainer_split_invoice: applied standard amount to row ${missingRowNum}, converted existing job at row ${existingConfirmedRow} to "${extraJobName}" (£${difference})`);
          return res.status(200).json({ success: true, mode: "converted", extraJobRow: existingConfirmedRow });
        } else {
          // Create a brand-new standalone single-row job — no children, no group.
          const metaResp = await sheets.spreadsheets.get({
            spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
          });
          const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
          const gridSheetId = confirmedSheet.properties.sheetId;
          let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

          const freshResp = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR" + currentMaxRows, valueRenderOption: "UNFORMATTED_VALUE",
          });
          const trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshResp.data.values || []);
          const newRowNum = trueLastRow + 1;

          if ((currentMaxRows - (trueLastRow + 1)) < 1) {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: { requests: [{
                insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 }, inheritFromBefore: true },
              }] },
            });
          }

          const newWriteData = [
            { range: `Confirmed!A${newRowNum}`, values: [[client]] },
            { range: `Confirmed!B${newRowNum}`, values: [[extraJobName]] },
            { range: `Confirmed!D${newRowNum}`, values: [[parentRow[3] || ""]] },   // Date conf
            { range: `Confirmed!E${newRowNum}`, values: [[parentRow[4] || ""]] },   // Lead src
            { range: `Confirmed!AG${newRowNum}`, values: [[difference]] },
            { range: `Confirmed!AI${newRowNum}`, values: [[vatYesNo]] },
            { range: `Confirmed!AJ${newRowNum}`, values: [["Retainer"]] },
            { range: `Confirmed!AK${newRowNum}`, values: [[parentRow[36] || ""]] },  // Prod. line
            { range: `Confirmed!AP${newRowNum}`, values: [[difference]] },
            { range: `Confirmed!AQ${newRowNum}`, values: [[altInvoiceNo || ""]] },
            { range: `Confirmed!AS${newRowNum}`, values: [[defaultDaysToPay]] },
            { range: `Confirmed!AT${newRowNum}`, values: [[altStatus || ""]] },
          ];
          const newDateWriteData = [
            { range: `Confirmed!AL${newRowNum}`, values: [[retFmtDate(monthStart)]] },
            { range: `Confirmed!AM${newRowNum}`, values: [[retFmtDate(monthEnd)]] },
          ];
          if (parsedAltSentDate) newDateWriteData.push({ range: `Confirmed!AR${newRowNum}`, values: [[retFmtDate(parsedAltSentDate)]] });

          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: newWriteData },
          });
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: newDateWriteData },
          });
          console.log(`  ✅ apply_retainer_split_invoice: applied standard amount to row ${missingRowNum}, created new job "${extraJobName}" at row ${newRowNum} (£${difference})`);
          return res.status(200).json({ success: true, mode: "created", extraJobRow: newRowNum });
        }
      } catch (err) {
        console.error("❌ apply_retainer_split_invoice error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "update_outgoing_note") {
      // Writes a new note to a specific Outgoings cell.
      // blocks: array of { appId, amount, status, recDate, payDate, description }
      // Also updates the cell value to the sum of non-UNRECON-GAP amounts.
      const { clientSheetId, sheetRow, colLetter, blocks } = req.body;
      if (!clientSheetId || !sheetRow || !colLetter) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId, sheetRow, or colLetter" });
      }
      try {
        const sheets = await getSheetsClient();
        const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

        // Build note string from blocks
        const noteStr = (blocks || []).map(b =>
          `{App ID: ${b.appId}}{Amt: ${b.amount}}{Status:${b.status ? " " + b.status : ""}}{Rec date:${b.recDate ? " " + b.recDate : ""}}{Pay date:${b.payDate ? " " + b.payDate : ""}}{Description:${b.description ? " " + b.description : ""}}`
        ).join("\n");

        // Calculate cell value = sum of non-UNRECON-GAP amounts
        const cellTotal = (blocks || [])
          .filter(b => !b.appId.startsWith("UNRECON-GAP"))
          .reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);

        const cellRef = `Outgoings!${colLetter}${sheetRow}`;

        // Write value and note separately
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: cellRef,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[cellTotal || ""]] },
        });

        // Write note using batchUpdate
        const colIndex = colLetterToNum(colLetter) - 1; // 0-indexed
        const rowIndex = sheetRow - 1; // 0-indexed
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            requests: [{
              updateCells: {
                range: {
                  sheetId: await getSheetGid(sheets, sheetIdClean, "Outgoings"),
                  startRowIndex: rowIndex,
                  endRowIndex: rowIndex + 1,
                  startColumnIndex: colIndex,
                  endColumnIndex: colIndex + 1,
                },
                rows: [{ values: [{ note: noteStr }] }],
                fields: "note",
              },
            }],
          },
        });

        console.log(`  ✅ Outgoings note updated: ${cellRef}`);

        // GAS outgoings notes pull is now deferred — fired by fire_outgoings_pull
        // action when the user navigates away from the Outgoings tab, so multiple
        // assignments in one session only trigger a single pull.

        return res.status(200).json({ success: true, cellRef, blockCount: (blocks || []).length, cellTotal });
      } catch (err) {
        console.error("❌ update_outgoing_note error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_claude_settings") {
      // Read config and usage from ClaudeUsage tab
      const { automationCommanderSheetId: acId } = req.body;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        const acIdClean = extractSheetIdFromUrl(acId) || acId;
        await ensureClaudeUsageTab_(sheets, acIdClean);

        // Read config (A1:B5) and all usage rows (A8 onwards)
        const [cfgResp, usageResp] = await Promise.all([
          sheets.spreadsheets.values.get({ spreadsheetId: acIdClean, range: "ClaudeUsage!A1:B6" }),
          sheets.spreadsheets.values.get({ spreadsheetId: acIdClean, range: "ClaudeUsage!A8:F2000" }),
        ]);
        const cfg = cfgResp.data.values || [];
        const cfgMap = {};
        for (const row of cfg) { if (row[0] && row[1] !== undefined) cfgMap[String(row[0]).trim()] = String(row[1]).trim(); }

        const hourlyLimit = parseInt(cfgMap["hourly_limit"] || "10");
        const dailyLimit  = parseInt(cfgMap["daily_limit"]  || "30");
        const anomalyThreshold = parseInt(cfgMap["anomaly_threshold"] || "15");

        // Parse usage rows
        const usageRows = (usageResp.data.values || []).filter(r => r[0]);
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const curHour = now.getUTCHours();

        let todayCalls = 0, todayCost = 0, hourCalls = 0, hourCost = 0, weeklyCalls = 0, weeklyCost = 0;
        const weekAgo = new Date(now.getTime() - 7 * 86400000);
        const recentRows = [];

        for (const row of usageRows) {
          const ts = row[0] ? new Date(row[0]) : null;
          if (!ts || isNaN(ts)) continue;
          const cost = parseFloat(row[5] || "0") || 0;
          if (ts >= weekAgo) { weeklyCalls++; weeklyCost += cost; }
          if (ts.toISOString().slice(0, 10) === todayStr) {
            todayCalls++; todayCost += cost;
            if (ts.getUTCHours() === curHour) { hourCalls++; hourCost += cost; }
          }
          recentRows.push({ ts: row[0], action: row[1], client: row[2], alertType: row[3], tokens: row[4], cost: row[5] });
        }
        // Return most recent 50 rows for display
        recentRows.sort((a, b) => new Date(b.ts) - new Date(a.ts));

        return res.status(200).json({
          success: true,
          config: { hourlyLimit, dailyLimit, anomalyThreshold },
          usage: {
            today: { calls: todayCalls, cost: todayCost.toFixed(4) },
            thisHour: { calls: hourCalls, cost: hourCost.toFixed(4) },
            week: { calls: weeklyCalls, cost: weeklyCost.toFixed(4) },
          },
          recentRows: recentRows.slice(0, 50),
        });
      } catch(err) {
        console.error("❌ get_claude_settings error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "save_claude_settings") {
      const { automationCommanderSheetId: acId, hourlyLimit, dailyLimit, anomalyThreshold } = req.body;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        const acIdClean = extractSheetIdFromUrl(acId) || acId;
        await ensureClaudeUsageTab_(sheets, acIdClean);
        await sheets.spreadsheets.values.update({
          spreadsheetId: acIdClean,
          range: "ClaudeUsage!B2:B4",
          valueInputOption: "RAW",
          requestBody: { values: [[parseInt(hourlyLimit) || 10], [parseInt(dailyLimit) || 30], [parseInt(anomalyThreshold) || 15]] },
        });
        return res.status(200).json({ success: true });
      } catch(err) {
        console.error("❌ save_claude_settings error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "check_claude_budget") {
      // Called by GAS Stage 2 before each Claude-requiring alert
      // Returns { allowed: true/false, reason: string }
      const { automationCommanderSheetId: acId } = req.body;
      if (!acId) return res.status(200).json({ allowed: true }); // fail open
      try {
        const sheets = await getSheetsClient();
        const acIdClean = extractSheetIdFromUrl(acId) || acId;
        await ensureClaudeUsageTab_(sheets, acIdClean);

        const [cfgResp, usageResp] = await Promise.all([
          sheets.spreadsheets.values.get({ spreadsheetId: acIdClean, range: "ClaudeUsage!B2:B4" }),
          sheets.spreadsheets.values.get({ spreadsheetId: acIdClean, range: "ClaudeUsage!A8:A2000" }),
        ]);
        const cfgVals = cfgResp.data.values || [];
        const hourlyLimit = parseInt(cfgVals[0]?.[0] || "10");
        const dailyLimit  = parseInt(cfgVals[1]?.[0] || "30");

        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const curHour = now.getUTCHours();
        let hourCalls = 0, dayCalls = 0;

        for (const row of (usageResp.data.values || [])) {
          const ts = row[0] ? new Date(row[0]) : null;
          if (!ts || isNaN(ts)) continue;
          if (ts.toISOString().slice(0, 10) === todayStr) {
            dayCalls++;
            if (ts.getUTCHours() === curHour) hourCalls++;
          }
        }

        if (dayCalls >= dailyLimit)  return res.status(200).json({ allowed: false, reason: `Daily limit reached (${dayCalls}/${dailyLimit})` });
        if (hourCalls >= hourlyLimit) return res.status(200).json({ allowed: false, reason: `Hourly limit reached (${hourCalls}/${hourlyLimit})` });
        return res.status(200).json({ allowed: true, hourCalls, dayCalls, hourlyLimit, dailyLimit });
      } catch(err) {
        console.error("❌ check_claude_budget error:", err);
        return res.status(200).json({ allowed: true }); // fail open
      }

    } else if (action === "log_claude_usage") {
      // Log a Claude API call to ClaudeUsage tab
      const { automationCommanderSheetId: acId, source, clientName, alertType, inputTokens, outputTokens } = req.body;
      if (!acId) return res.status(200).json({ success: true }); // non-critical
      try {
        const sheets = await getSheetsClient();
        const acIdClean = extractSheetIdFromUrl(acId) || acId;
        await ensureClaudeUsageTab_(sheets, acIdClean);

        // Sonnet 4 pricing: $3/M input, $15/M output
        const costUsd = ((inputTokens || 0) / 1000000 * 3) + ((outputTokens || 0) / 1000000 * 15);
        const totalTokens = (inputTokens || 0) + (outputTokens || 0);

        await sheets.spreadsheets.values.append({
          spreadsheetId: acIdClean,
          range: "ClaudeUsage!A:F",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[
              new Date().toISOString(),
              source || "precompute",
              clientName || "",
              alertType || "",
              totalTokens,
              costUsd.toFixed(6),
            ]],
          },
        });
        return res.status(200).json({ success: true });
      } catch(err) {
        console.error("❌ log_claude_usage error:", err);
        return res.status(200).json({ success: false }); // non-critical
      }

    } else if (action === "get_app_log") {
      // Read AppLogPull tab from the App Log sheet (cols A:V).
      // Only returns rows where at least one cell in the row is non-empty.
      const APP_LOG_SHEET_ID = "1v1N5ymNkcUCSPfzEGJxE43ylgGN95iyZmhKgnz62OQQ";
      try {
        const sheets = await getSheetsClient();
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: APP_LOG_SHEET_ID,
          range: "AppLogPull!A1:V1000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rawRows = resp.data.values || [];
        // Filter out rows where every cell is empty/blank
        const rows = rawRows.filter(row =>
          row.some(cell => String(cell ?? "").trim() !== "")
        );
        console.log(`  ✅ App Log: ${rows.length} non-empty rows loaded`);
        return res.status(200).json({ success: true, rows });
      } catch (err) {
        console.error("❌ get_app_log error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "start_triage") {
      // Proxy orchestrator for frontend chunking. Protects CRON_SECRET.
      try {
        const { step } = req.body;
        const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `https://${process.env.VERCEL_URL}`;
        const cronSecret = process.env.CRON_SECRET;

        // Step 1: Sweep
        if (step === "sweep") {
          console.log(`🔄 start_triage (sweep): running fresh detection pass from index ${req.body.startIdx || 0}...`);
          const sweepResp = await fetch(`${baseUrl}/api/triage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "run_flag_sweep", secret: cronSecret, automationCommanderSheetId, startIdx: req.body.startIdx || 0, forceProactive: req.body.forceProactive }),
          });
          const sweepData = await sweepResp.json();
          return res.status(200).json({ success: true, hasMore: sweepData.hasMore, nextIdx: sweepData.nextIdx });
        }

        // Step 2: Build Options (Can be looped by frontend)
        if (step === "build") {
          console.log(`🔄 start_triage (build): building options...`);
          const buildResp = await fetch(`${baseUrl}/api/triage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "build_cached_alert_options", secret: cronSecret, automationCommanderSheetId, isContinuation: req.body.isContinuation }),
          });
          const buildData = await buildResp.json();
          return res.status(200).json({ success: true, hasMore: buildData.hasMore });
        }

        // Step 3: Store and Generate Session
        if (step === "store") {
          console.log(`🔄 start_triage (store): rebuilding precomputed cache...`);
          let existingNoActionAnalysis = {};
          try {
            const existingRaw = await redisClient.get(PRECOMPUTED_KEY);
            if (existingRaw) existingNoActionAnalysis = JSON.parse(existingRaw).noActionAnalysisResults || {};
          } catch (e) { /* fine to proceed with {} */ }

          const storeResp = await fetch(`${baseUrl}/api/triage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "store_precomputed", secret: cronSecret, automationCommanderSheetId,
              noActionAnalysisResults: existingNoActionAnalysis,
            }),
          });
          if (!storeResp.ok) throw new Error(`store_precomputed failed (${storeResp.status})`);

          const freshRaw = await redisClient.get(PRECOMPUTED_KEY);
          if (!freshRaw) return res.status(500).json({ success: false, error: "No precomputed data was found afterwards" });
          const fresh = JSON.parse(freshRaw);

          const alertCountsByClientAndFlag = {};
          const activeExpenseIdsByClient = {};
          for (const alert of (fresh.alerts || [])) {
            const key = alert.clientName;
            let flagKey = alert.flagType || alert.alertType || alert.type;
            
            // Upgrade legacy database labels
            if (flagKey === "invoice") flagKey = "invoiceDashboardDiscr";
            if (flagKey === "expense") flagKey = "expenseDashboardDiscr";
            if (flagKey === "crm") flagKey = alert.flagType || alert.alertType || "crmPipeAppDiscr";

            // CRITICAL FIX: Actually apply the upgraded label to the alert object!
            alert.flagType = flagKey;
            alert.alertType = flagKey;

            if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
            alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;
            
            if (flagKey === "expenseDashboardDiscr") {
               const txId = alert.summary?.transactionId || alert.summary?.appId;
               if (txId) {
                  if (!activeExpenseIdsByClient[key]) activeExpenseIdsByClient[key] = [];
                  activeExpenseIdsByClient[key].push(txId);
               }
            }
          }

          const clientsWithUpdatedCounts = (fresh.clientsWithFlags || []).map(c => ({
            ...c, alertCounts: alertCountsByClientAndFlag[c.clientName] || {},
            activeExpenseIds: activeExpenseIdsByClient[c.clientName] || [],
          }));

          const sessionId = Math.random().toString(36).substring(2, 15);
          await redisClient.set(
            `triage_alerts:${sessionId}`,
            JSON.stringify({ alerts: fresh.alerts || [], noActionAlerts: fresh.noActionAlerts || [], proactiveAlerts: fresh.proactiveAlerts || [], clientsWithFlags: clientsWithUpdatedCounts }),
            { EX: 3600 } // Reduced from 24h to 1h to prevent Redis OOM
          );

          console.log(`✅ start_triage: refresh complete`);
          return res.status(200).json({
            success: true, sessionId, totalAlerts: (fresh.alerts || []).length,
            noActionCount: (fresh.noActionAlerts || []).length, proactiveAlerts: fresh.proactiveAlerts || [], clientsWithFlags: clientsWithUpdatedCounts,
          });
        }

        return res.status(400).json({ success: false, error: "Invalid step parameter" });
      } catch (err) {
        console.error("❌ start_triage error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "fire_outgoings_pull") {
      // Deferred GAS outgoings notes pull — fired when the user navigates away from
      // the Outgoings tab after making one or more assignments. Fire-and-forget from
      // the frontend; we still await here so Vercel doesn't kill the function early.
      const { clientSheetId: pullClientSheetId, masterSheetId: pullMasterSheetId } = req.body;
      if (!pullClientSheetId || !pullMasterSheetId) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId or masterSheetId" });
      }
      try {
        const pullClientIdClean = extractSheetIdFromUrl(pullClientSheetId) || pullClientSheetId;
        const pullMasterIdClean = extractSheetIdFromUrl(pullMasterSheetId) || pullMasterSheetId;
        const gasResp = await fetch("https://script.google.com/macros/s/AKfycbzVvLSDtqWj3aHcn0UV9VPCybNm82sBNWynMo1-bMpvs3NzerPZXWkrpPJvVHaqDwwy/exec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "refreshOutgoings", clientSheetId: pullClientIdClean, masterSheetId: pullMasterIdClean }),
        });
        const gasData = await gasResp.json().catch(() => ({}));
        console.log(`  📋 fire_outgoings_pull GAS call: ${gasData.success ? "OK" : gasData.error || "no response"}`);
        return res.status(200).json({ success: true });
      } catch(err) {
        console.log(`  ⚠ fire_outgoings_pull GAS call failed (non-fatal): ${err.message}`);
        return res.status(200).json({ success: false, error: err.message });
      }

    } else if (action === "trigger_proactive_checks") {
      // Triggers the overnight checks manually on demand
      try {
        const gasUrl = "https://script.google.com/macros/s/AKfycbzVvLSDtqWj3aHcn0UV9VPCybNm82sBNWynMo1-bMpvs3NzerPZXWkrpPJvVHaqDwwy/exec";
        const gasResp = await fetch(gasUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "run_proactive_checks" }),
        });
        const gasData = await gasResp.json().catch(() => ({}));
        if (!gasData.success) throw new Error(gasData.error || "Failed to trigger Apps Script");
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ trigger_proactive_checks error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_sweep_schedule") {
      // Returns the current per-category (actionable/info/proactive) sweep
      // frequencies and last-checked timestamps, for the Settings page's
      // frequency controls (26 Aug 2026, Paul's direction).
      const { automationCommanderSheetId: acIdGetSchedule } = req.body;
      if (!acIdGetSchedule) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        await ensureSweepScheduleTab(sheets, acIdGetSchedule);
        const schedule = await readSweepSchedule_(sheets, acIdGetSchedule);
        return res.status(200).json({ success: true, schedule });
      } catch (err) {
        console.error("❌ get_sweep_schedule error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "save_sweep_frequency") {
      // Immediate-save from the Settings page — writes a single category's
      // frequency back to SweepSchedule. Deliberately does not touch
      // lastCheckedAt, so changing the frequency doesn't reset the "due"
      // countdown already in progress.
      const { automationCommanderSheetId: acIdSaveFreq, category, frequencyMinutes } = req.body;
      if (!acIdSaveFreq) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      const normalisedCategory = String(category || "").trim().toLowerCase();
      if (!SWEEP_SCHEDULE_DEFAULTS[normalisedCategory]) {
        return res.status(400).json({ success: false, error: `Unknown category: ${category}` });
      }
      const freqNum = parseInt(frequencyMinutes, 10);
      if (!freqNum || freqNum < 1) {
        return res.status(400).json({ success: false, error: `Invalid frequencyMinutes: ${frequencyMinutes}` });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureSweepScheduleTab(sheets, acIdSaveFreq);
        const schedule = await readSweepSchedule_(sheets, acIdSaveFreq);
        const entry = schedule[normalisedCategory];
        if (entry && entry.rowIndex) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: acIdSaveFreq,
            range: `${SWEEP_SCHEDULE_TAB}!B${entry.rowIndex}`,
            valueInputOption: "RAW",
            requestBody: { values: [[freqNum]] },
          });
        } else {
          await sheets.spreadsheets.values.append({
            spreadsheetId: acIdSaveFreq,
            range: `${SWEEP_SCHEDULE_TAB}!A:C`,
            valueInputOption: "RAW",
            requestBody: { values: [[normalisedCategory, freqNum, ""]] },
          });
        }
        console.log(`✅ save_sweep_frequency: ${normalisedCategory} → ${freqNum} min`);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ save_sweep_frequency error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "trigger_agent_run") {
      // Calls a client's own Web App deployment (5_Agent_Receiver.gs doPost) to run
      // its invoice/CRM/expense automation on demand, instead of the 30-min poll or
      // a manual run inside that client's own Apps Script editor.
      const { automationCommanderSheetId: acSheetId, clientName: targetClientName, types } = req.body;
      if (!acSheetId || !targetClientName || !Array.isArray(types) || types.length === 0) {
        return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId, clientName, or types" });
      }
      const agentSecret = process.env.AGENT_TRIGGER_SECRET;
      if (!agentSecret) {
        return res.status(500).json({ success: false, error: "AGENT_TRIGGER_SECRET not configured on the server" });
      }
      try {
        // Fresh lookup rather than trusting a cached client list — this is a
        // low-frequency, user-initiated action, so the extra read is cheap
        // and guarantees the URL used is whatever's currently in column N.
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: acSheetId,
          range: "AutoUpdates!A2:N1000",
        });
        const rows = resp.data.values || [];
        const row = rows.find(r => String(r[0] || "").trim() === targetClientName);
        if (!row) {
          return res.status(404).json({ success: false, error: `Client "${targetClientName}" not found in AutoUpdates` });
        }
        const webAppUrl = String(row[13] || "").trim(); // col N
        if (!webAppUrl) {
          return res.status(400).json({ success: false, error: `No Web App URL configured for "${targetClientName}" (column N) — deploy and add it first` });
        }

        const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const gasResp = await fetch(webAppUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: agentSecret, types, clientName: targetClientName, runId }),
        });
        // Apps Script Web Apps always return HTTP 200 regardless of outcome —
        // success/failure lives in the JSON body's "success" field, not gasResp.ok.
        const gasData = await gasResp.json().catch(() => null);
        if (!gasData) {
          return res.status(502).json({ success: false, error: "No valid response from the client's Web App — check the deployment URL and that it's still active" });
        }
        if (!gasData.success) {
          return res.status(200).json({ success: false, error: gasData.error || "Client Web App reported failure" });
        }
        return res.status(200).json({ success: true, triggered: gasData.triggered || types, runId });
      } catch (err) {
        console.error(`❌ trigger_agent_run error for "${targetClientName}":`, err);
        return res.status(500).json({ success: false, error: `Failed to reach client Web App: ${err.message}` });
      }

    } else if (action === "agent_progress") {
      // Receives progress updates posted by 5_Agent_Receiver.gs (postAgentProgress_)
      // as a triggered run actually executes, and accumulates them in Redis for
      // the frontend to poll. Called by GAS, not the triage frontend — auth is
      // the shared secret, same as trigger_agent_run's outbound call uses.
      const { secret: progressSecret, clientName: progressClientName, runId: progressRunId, stage, message, done } = req.body;
      if (progressSecret !== process.env.AGENT_TRIGGER_SECRET) {
        return res.status(200).json({ success: false, error: "Invalid secret" });
      }
      if (!progressClientName || !progressRunId) {
        return res.status(400).json({ success: false, error: "Missing clientName or runId" });
      }
      try {
        const progressKey = `agent_run:${progressClientName}:${progressRunId}`;
        const existingRaw = await redisClient.get(progressKey);
        const existing = existingRaw ? JSON.parse(existingRaw) : { entries: [], done: false };
        existing.entries.push({ stage: stage || "", message: message || "", at: new Date().toISOString() });
        if (done) existing.done = true;
        // 30 min TTL — generous enough to cover a long automation run plus a
        // bit of buffer for the user to view the final result afterward.
        await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 });
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error(`❌ agent_progress error for "${progressClientName}"/"${progressRunId}":`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_agent_run_progress") {
      // Polled by the frontend while a Run Client Automation panel is open.
      const { clientName: pollClientName, runId: pollRunId } = req.body;
      if (!pollClientName || !pollRunId) {
        return res.status(400).json({ success: false, error: "Missing clientName or runId" });
      }
      try {
        const progressKey = `agent_run:${pollClientName}:${pollRunId}`;
        const raw = await redisClient.get(progressKey);
        const data = raw ? JSON.parse(raw) : { entries: [], done: false };
        return res.status(200).json({ success: true, entries: data.entries, done: data.done });
      } catch (err) {
        console.error(`❌ get_agent_run_progress error for "${pollClientName}"/"${pollRunId}":`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "debug_compare_triage") {
      // Diagnostic action: for a given client, reads all comp sheets using the same
      // logic as start_triage, builds fingerprints, then compares against AlertMemory.
      // Returns a structured report showing mismatches between what start_triage generates
      // and what AlertMemory has stored (from the GAS precompute).
      const { clientSheetId, masterSheetId, clientName: debugClientName } = req.body;
      if (!clientSheetId || !masterSheetId || !debugClientName) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId, masterSheetId, or clientName" });
      }
      try {
        const debugSheetIdClean = extractSheetIdFromUrl(masterSheetId) || masterSheetId;

        // Read comp sheets only for flags that are actually set — mirrors start_triage exactly
        // so the diagnostic doesn't generate alerts that start_triage would never produce.
        const clientFlags = req.body.clientFlags || {};

        const invAlerts = clientFlags.invoiceDashboardDiscr
          ? await readInvCompAlerts(sheets, debugSheetIdClean).catch(e => { console.log(`  ⚠ InvComp read error: ${e.message}`); return []; })
          : [];
        const dirAlerts = clientFlags.expenseDashboardDiscr
          ? await readDirCompAlerts(sheets, debugSheetIdClean).catch(e => { console.log(`  ⚠ DirComp read error: ${e.message}`); return []; })
          : [];

        // CRM Pipeline — only if crmPipeDashDiscr or crmPipeAppDiscr is set
        const pipeFlags = ["crmPipeDashDiscr","crmPipeAppDiscr"].filter(f => clientFlags[f]);
        const crmPipeAlerts = pipeFlags.length > 0
          ? await readCRMCompAlerts(sheets, debugSheetIdClean, "Pipeline", pipeFlags, debugSheetIdClean)
              .catch(e => { console.log(`  ⚠ CRMComp Pipeline read error: ${e.message}`); return []; })
          : [];

        // CRM Confirmed — only if crmConfDashDiscr or crmConfAppDiscr is set
        const confFlags = ["crmConfDashDiscr","crmConfAppDiscr"].filter(f => clientFlags[f]);
        const crmConfAlerts = confFlags.length > 0
          ? await readCRMCompAlerts(sheets, debugSheetIdClean, "Confirmed", confFlags, debugSheetIdClean)
              .catch(e => { console.log(`  ⚠ CRMComp Confirmed read error: ${e.message}`); return []; })
          : [];

        // Tag all alerts with client info and flagType (mirrors start_triage)
        invAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; a.flagType = a.flagType || "invoiceDashboardDiscr"; });
        dirAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; a.flagType = a.flagType || "expenseDashboardDiscr"; });
        crmPipeAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; if (!a.flagType) a.flagType = a.alertType || "crmPipeAppDiscr"; });
        crmConfAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; a.masterSheetId; if (!a.flagType) a.flagType = a.alertType || "crmConfAppDiscr"; });

        const allDebugAlerts = [...invAlerts, ...dirAlerts, ...crmPipeAlerts, ...crmConfAlerts];

        // Build fingerprints for all generated alerts
        allDebugAlerts.forEach(a => { a.fingerprintHash = buildAlertFingerprint(a); });

        // Read AlertMemory and filter to this client
        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
        const clientMemory = memoryRows.filter(r => r.clientName === debugClientName);

        const handledStatuses = new Set(["ignored", "task", "superseded", "accepted"]);
        const handledHashes = new Set(clientMemory.filter(r => handledStatuses.has(r.status)).map(r => r.fingerprintHash).filter(Boolean));
        const cachedHashes  = new Set(clientMemory.filter(r => r.status === "cached").map(r => r.fingerprintHash).filter(Boolean));

        // For each generated alert: categorise it
        const report = allDebugAlerts.map(a => {
          const fp = a.fingerprintHash;
          const memRow = clientMemory.find(r => r.fingerprintHash === fp);
          // Build the raw fingerprint string for inspection
          const parts = [a.type || "", a.flagType || a.alertType || ""];
          if (a.data?.accounting) parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.accounting)));
          if (a.data?.confirmed)  parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.confirmed)));
          if (a.data?.crmData)    parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.crmData)));
          if (a.data?.sheetData)  parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.sheetData)));
          if (a.data?.flags)      parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.flags)));
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

        // Also find AlertMemory hashes for this client that don't match any generated alert
        const generatedHashes = new Set(allDebugAlerts.map(a => a.fingerprintHash));
        const unmatchedMemory = clientMemory
          .filter(r => r.fingerprintHash && !generatedHashes.has(r.fingerprintHash))
          .map(r => ({
            fingerprintHash: r.fingerprintHash,
            status: r.status,
            alertType: r.alertType,
            alertSummary: (r.alertSummary || "").slice(0, 100),
          }));

        // Check whether Node-generated hashes exist ANYWHERE in AlertMemory (not just this client)
        // This reveals if GAS stored the same alert under a different clientName
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

    } else if (action === "get_alerts") {
      // Get alerts for a session from Redis
      const { sessionId } = req.query;
      
      console.log(`\n🔍 get_alerts request: sessionId=${sessionId}`);
      
      if (!sessionId) {
        console.error("❌ Missing sessionId in query params");
        res.status(400).json({ success: false, error: "Missing sessionId" });
        return;
      }

      try {
        console.log(`  Looking up triage_alerts:${sessionId} in Redis...`);
        const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
        
        if (!sessionData) {
          console.error(`❌ Session not found: triage_alerts:${sessionId}`);
          res.status(404).json({ success: false, error: "Session not found" });
          return;
        }

        const { alerts, noActionAlerts, proactiveAlerts, clientsWithFlags, resolvedNoActionFlags } = JSON.parse(sessionData);
        console.log(`✅ Retrieved ${alerts.length} alerts from Redis for session ${sessionId}`);
        
        res.status(200).json({
          success: true,
          alerts,
          noActionAlerts,
          proactiveAlerts: proactiveAlerts || [],
          clientsWithFlags,
          resolvedNoActionFlags: resolvedNoActionFlags || [],
        });
      } catch (err) {
        console.error("❌ Error retrieving alerts:", err);
        res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "debug_triage_state") {
      // Diagnostic action — dumps full triage state for a client to help debug
      // alert reappearance and clearing issues.
      const { clientName, automationCommanderSheetId: acId } = req.body;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();

        // 1. Read AlertMemory
        await ensureAlertMemoryTab(sheets, acId);
        const allMemoryRows = await readAlertMemory(sheets, acId);
        const clientMemory = clientName
          ? allMemoryRows.filter(r => r.clientName === clientName)
          : allMemoryRows;
        const memorySummary = clientMemory
          .filter(r => r.alertType !== "flag_cleared")
          .map(r => ({
            hash:        r.fingerprintHash,
            alertType:   r.alertType,
            status:      r.status,
            summary:     r.alertSummary?.slice(0, 60),
            ignoreReason: r.ignoreReason || "",
          }));

        // Also show flag_cleared records for this client (or recent ones if no client filter)
        const flagClearedRows = allMemoryRows
          .filter(r => r.alertType === "flag_cleared" && (!clientName || r.clientName === clientName))
          .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))
          .slice(0, 5)
          .map(r => {
            let snap = {};
            try { snap = JSON.parse(r.dataSnapshot || "{}"); } catch(e) {}
            return {
              clientName: r.clientName,
              clearedAt: snap.clearedAt || r.lastSeen,
              clearedGroups: snap.clearedGroups,
              clearedCols: snap.clearedCols,
            };
          });

        // 2. Read precomputed blob from Redis
        const preRaw = await redisClient.get(PRECOMPUTED_KEY);
        let precompSummary = null;
        if (preRaw) {
          const pre = JSON.parse(preRaw);
          const preAlerts = (pre.alerts || []).filter(a => !clientName || a.clientName === clientName);
          const preClients = (pre.clientsWithFlags || []).filter(c => !clientName || c.clientName === clientName);
          precompSummary = {
            computedAt:    pre.computedAt,
            totalAlerts:   pre.totalAlerts,
            clientAlerts:  preAlerts.map(a => ({
              type:          a.type,
              flagType:      a.flagType || a.alertType,
              subType:       a.subType,
              fingerprint:   a.fingerprintHash,
              rowNumber:     a.rowNumber,
            })),
            clientFlags:   preClients.map(c => ({
              clientName: c.clientName,
              flags:      Object.entries(c.flags || {}).filter(([,v]) => v).map(([k]) => k),
            })),
          };
        }

        // AutoUpdates sticky-flag comparison retired 24 Aug 2026 — those
        // columns (CW:HL) are permanently empty now (nothing has written
        // them since compareAutoResults/runFullSweep were disabled), so
        // comparing against them no longer has any diagnostic value.
        // Removing this read also fully clears the way for Paul to safely
        // delete AutoUpdates columns CR:HM, since this was the last
        // remaining reader of that range in triage.js.

        console.log(`debug_triage_state: ${clientMemory.length} AlertMemory rows, precomp=${!!preRaw}`);
        return res.status(200).json({
          success: true,
          clientName,
          alertMemory: {
            totalRows: allMemoryRows.length,
            clientRows: memorySummary,
            flagClearedRecords: flagClearedRows,
            statusCounts: allMemoryRows.reduce((acc, r) => { acc[r.status] = (acc[r.status]||0)+1; return acc; }, {}),
          },
          precomputed: precompSummary,
        });
      } catch (err) {
        console.error("❌ debug_triage_state error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "cleanup_alert_memory") {
      // Deduplicates AlertMemory by removing lower-priority duplicate rows.
      // For each fingerprint hash, keeps the highest-priority row (ignored/accepted/task > cached > superseded).
      // Should be run once after deploying the findMemoryRow fix.
      const { automationCommanderSheetId: acId } = req.body;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);
        console.log(`cleanup_alert_memory: ${memoryRows.length} total rows`);

        const priority = (status) => {
          if (status === "ignored" || status === "accepted" || status === "task") return 3;
          if (status === "cached") return 2;
          return 1;
        };

        // Group by fingerprint
        const byHash = {};
        for (const row of memoryRows) {
          if (!row.fingerprintHash) continue;
          if (!byHash[row.fingerprintHash]) byHash[row.fingerprintHash] = [];
          byHash[row.fingerprintHash].push(row);
        }

        // Find rows to delete (all but the best per hash)
        const rowsToDelete = [];
        for (const [hash, rows] of Object.entries(byHash)) {
          if (rows.length <= 1) continue;
          // Sort by priority desc, then lastSeen desc
          rows.sort((a, b) => {
            const pd = priority(b.status) - priority(a.status);
            if (pd !== 0) return pd;
            return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
          });
          // Keep rows[0], delete the rest
          for (let i = 1; i < rows.length; i++) {
            rowsToDelete.push(rows[i].rowIndex);
          }
        }

        console.log(`cleanup_alert_memory: ${rowsToDelete.length} duplicate rows to delete`);
        if (rowsToDelete.length > 0) {
          await deleteAlertMemoryRows(sheets, acId, rowsToDelete);
        }

        return res.status(200).json({
          success: true,
          totalRows: memoryRows.length,
          duplicatesRemoved: rowsToDelete.length,
          uniqueHashes: Object.keys(byHash).length,
        });
      } catch (err) {
        console.error("❌ cleanup_alert_memory error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "rehash_alert_memory") {
      // One-time migration: recomputes fingerprints for all AlertMemory rows using the
      // current normalisation (DD-Mon-YY with zero-padded day). Rows whose hash changes
      // are updated in-place. Run once after deploying the normalisation fix.
      // Uses the stored alertDataJSON or reconstructs from alertSummary — but since
      // we don't have raw alert data in AlertMemory, we instead look for rows that
      // have a corresponding new-hash row and mark the old one superseded.
      // 
      // Simpler approach: scan AlertMemory for rows where fingerprintHash appears in
      // the current precomputed blob under a DIFFERENT hash for the same alert summary.
      // For rows that are superseded/cached with an ignoreReason, copy the ignoreReason
      // to any newer cached row with the same alertSummary + clientName + alertType.
      const { automationCommanderSheetId: acId } = req.body;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);

        // Find all superseded rows that have an ignoreReason
        const supersededWithReason = memoryRows.filter(r =>
          r.status === "superseded" && r.ignoreReason
        );

        // For each superseded+ignored row, find cached rows with same signature and promote them.
        // All updates are batched into a single Sheets API call to avoid quota errors.
        const sigKey = (r) => `${r.clientName}|${r.alertType}|${(r.alertSummary || "").slice(0, 40)}`;
        const now = new Date().toISOString().split("T")[0];

        // Build map: signature → ignoreReason from superseded rows
        const reasonBySig = {};
        for (const sup of supersededWithReason) {
          const sig = sigKey(sup);
          if (!reasonBySig[sig]) reasonBySig[sig] = sup.ignoreReason;
        }

        // Find cached rows that match a superseded signature
        const promotions = []; // { row, ignoreReason }
        for (const row of memoryRows) {
          if (row.status !== "cached") continue;
          const sig = sigKey(row);
          if (reasonBySig[sig]) {
            promotions.push({ row, ignoreReason: reasonBySig[sig] });
          }
        }

        // Batch all promotions in one batchUpdate call
        let promoted = 0;
        if (promotions.length > 0) {
          const acIdClean = extractSheetIdFromUrl(acId) || acId;
          const batchData = promotions.map(({ row, ignoreReason }) => ({
            range: `${ALERT_MEMORY_TAB}!A${row.rowIndex}:K${row.rowIndex}`,
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

        // Deduplicate: keep highest-priority row per hash, delete the rest
        const priority = (status) => {
          if (status === "ignored" || status === "accepted" || status === "task") return 3;
          if (status === "cached") return 2;
          return 1;
        };
        // Re-read after promotions to get current statuses
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

    } else if (action === "get_precomputed") {
      // Return the latest precomputed triage data if it exists and is fresh enough
      try {
        const raw = await redisClient.get(PRECOMPUTED_KEY);
        if (!raw) {
          console.log(`  No precomputed data found`);
          return res.status(200).json({ success: true, available: false });
        }

        const data = JSON.parse(raw);
        const ageMs = Date.now() - (data.computedAt || 0);

        if (ageMs > PRECOMPUTED_MAX_AGE_MS) {
          console.log(`  Precomputed data is stale (${Math.round(ageMs / 60000)} mins old)`);
          return res.status(200).json({ success: true, available: false, staleMinutes: Math.round(ageMs / 60000) });
        }

        console.log(`  ✅ Returning precomputed data (${Math.round(ageMs / 60000)} mins old, ${data.totalAlerts} alerts)`);

        // Filter out any alerts that have been ignored since the precompute ran.
        // AlertMemory is the source of truth — read it fresh every time.
        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
        const ignoredStatusesPC = new Set(
          memoryRows.filter(r => r.status === "ignored").map(r => r.fingerprintHash)
        );
        const supersededIgnoredHashesPC = new Set(
          memoryRows
            .filter(r => r.status === "superseded" && r.ignoreReason)
            .map(r => r.fingerprintHash)
            .filter(hash => !ignoredStatusesPC.has(hash))
        );
        const ignoredHashes = new Set([...ignoredStatusesPC, ...supersededIgnoredHashesPC]);

        const filteredAlerts = data.alerts.filter(alert => {
          const hash = alert.fingerprintHash || buildAlertFingerprint(alert);
          return !ignoredHashes.has(hash);
        });
        
        const filteredProactive = (data.proactiveAlerts || []).filter(alert => {
          const hash = alert.fingerprintHash || createHash("sha256").update(alert.alertKey || "").digest("hex").substring(0, 16);
          return !ignoredHashes.has(hash);
        });

        if (filteredAlerts.length < data.alerts.length || filteredProactive.length < (data.proactiveAlerts || []).length) {
          console.log(`  Filtered ignored alert(s) from precomputed data`);
        }

        // Rebuild alertCounts after filtering
        const alertCountsByClientAndFlag = {};
        const activeExpenseIdsByClient = {};
        for (const alert of filteredAlerts) {
          const key = alert.clientName;
          let flagKey = alert.flagType || alert.alertType || alert.type;
          
          // Upgrade legacy database labels
          if (flagKey === "invoice") flagKey = "invoiceDashboardDiscr";
          if (flagKey === "expense") flagKey = "expenseDashboardDiscr";
          if (flagKey === "crm") flagKey = alert.flagType || alert.alertType || "crmPipeAppDiscr";

          // CRITICAL FIX: Actually apply the upgraded label to the alert object!
          alert.flagType = flagKey;
          alert.alertType = flagKey;

          if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
          alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;
          
          if (flagKey === "expenseDashboardDiscr") {
             const txId = alert.summary?.transactionId || alert.summary?.appId;
             if (txId) {
                if (!activeExpenseIdsByClient[key]) activeExpenseIdsByClient[key] = [];
                activeExpenseIdsByClient[key].push(txId);
             }
          }
        }

        const clientsWithUpdatedCounts = data.clientsWithFlags.map(c => ({
          ...c,
          alertCounts: alertCountsByClientAndFlag[c.clientName] || {},
          activeExpenseIds: activeExpenseIdsByClient[c.clientName] || [],
        }));

        // Promote into a regular session so the existing get_alerts flow works unchanged
        const sessionId = Math.random().toString(36).substring(2, 15);
        await redisClient.set(
          `triage_alerts:${sessionId}`,
          JSON.stringify({
            alerts: filteredAlerts,
            noActionAlerts: data.noActionAlerts,
            proactiveAlerts: filteredProactive,
            clientsWithFlags: clientsWithUpdatedCounts,
          }),
          { EX: 3600 } // Reduced from 24h to 1h to prevent Redis OOM
        );

        return res.status(200).json({
          success: true,
          available: true,
          sessionId,
          totalAlerts: filteredAlerts.length,
          noActionCount: data.noActionCount,
          proactiveAlerts: filteredProactive,
          clientsWithFlags: clientsWithUpdatedCounts.map(c => ({
            clientName: c.clientName,
            clientSheetId: c.clientSheetId,
            masterSheetId: c.masterSheetId,
            flags: c.flags,
            alertCounts: c.alertCounts || {},
            activeExpenseIds: c.activeExpenseIds || [],
          })),
          computedAt: data.computedAt,
          computedMinutesAgo: Math.round(ageMs / 60000),
          noActionAnalysisResults: data.noActionAnalysisResults || {},
        });
      } catch (err) {
        console.error("❌ Error retrieving precomputed data:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "store_precomputed") {
      const { secret, computedAt, noActionAnalysisResults, automationCommanderSheetId } = req.body;

      if (secret !== process.env.CRON_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorised" });
      }

      try {
        // Old-path reconciliation retired 23 Aug 2026 (Paul's direction,
        // confirmed the old compareAutoResults/runFullSweep GAS triggers
        // are now disabled) — clientsWithFlags/alerts/noActionAlerts were
        // GAS-provided inputs that nothing populates any more, since
        // AutoUpdates' sticky flag columns never get set to TRUE by
        // anything now (removed from this action's destructured inputs
        // entirely, since nothing here reads them any more either). The
        // removed logic (dashboard-type reconciliation, zeroing stale
        // flags, clearing AutoUpdates) always produced empty results
        // against empty input — these plain initializations are exactly
        // equivalent, just without the dead machinery. The AlertMemory
        // merge below (unchanged) still builds on these same variable names.
        let mergedAlerts = [];
        let mergedNoActionAlerts = [];
        let reconciledClients = [];

        // ── Merge in AlertMemory-sourced alerts (unified alert-system
        // redesign, 22 Aug 2026, Paul's explicit direction) ─────────────
        // The 6 dashboard types are now ALSO detected via run_flag_sweep,
        // writing directly to AlertMemory, with options built separately
        // by build_cached_alert_options. This merges those in here,
        // deduplicated against the old GAS-provided path by fingerprint —
        // both paths can be active simultaneously during this transition
        // (run_flag_sweep still also writes AutoUpdates for now), so
        // without this dedup the same discrepancy could show twice.
        // Deliberately done as a separate, additive step after all the
        // existing reconciliation/zeroing logic above, rather than
        // threaded through it — that logic is specifically shaped around
        // the old clientsWithFlags-sourced input and forcing the new
        // source through it risked incorrectly dropping alerts whose
        // client was never flagged via the old path at all.
        let finalAlerts = mergedAlerts;
        let finalClientsWithFlags = reconciledClients;
        let finalNoActionAlerts = mergedNoActionAlerts;
        let finalProactiveAlerts = [];
        try {
          const sheetsForMerge = await getSheetsClient();
          const acIdForMerge = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;
          await ensureAlertMemoryTab(sheetsForMerge, acIdForMerge);

          // Relocated here 24 Aug 2026 — this only ran via start_triage
          // before, which has been silently broken (returning early, before
          // ever reaching this step) since the old compareAutoResults/
          // runFullSweep GAS triggers were disabled. store_precomputed's
          // hourly cron run is a far more reliable home for this recurring
          // maintenance than a manual refresh button. Purge first, then
          // re-read fresh — deleting rows shifts every subsequent row
          // index, so using the pre-purge read's rowIndex values for the
          // merge logic below would target the wrong rows.
          const rowsBeforePurge = await readAlertMemory(sheetsForMerge, acIdForMerge);
          await purgeOldAlertMemoryRows(sheetsForMerge, acIdForMerge, rowsBeforePurge);

          const memoryRowsForMerge = await readAlertMemory(sheetsForMerge, acIdForMerge);

          // Recomputed rather than trusted from a possible existing field —
          // not confirmed present on every alert reaching this action, and
          // recomputing via the one, single fingerprint function is the
          // safer, consistent choice either way.
          const oldPathFingerprints = new Set(mergedAlerts.map(a => buildAlertFingerprint(a)));
          // Proactive-category rows aren't individually fingerprinted the
          // way discrepancy alerts are — clientId+flagType is the
          // equivalent "already covered by the old NO_ACTION_FLAGS path"
          // check for this side.
          const oldPathNoActionKeys = new Set(mergedNoActionAlerts.map(na => `${na.clientId}|||${na.flagType}`));

          const newAlertsFromMemory = [];
            const newNoActionFromMemory = [];
            const newProactiveFromMemory = [];
            const extraFlagsByClient = new Map(); // clientName -> { flagKey: true, ... }
            const newClientMeta = new Map(); 

          // Authoritative lookup for ALL clients directly from AutoUpdates
          // This bypasses broken or old dataSnapshots in AlertMemory.
          const { clientRows } = await readAutoUpdatesClientRows_(sheetsForMerge, acIdForMerge);
          const clientNameToMeta = new Map(clientRows.map(c => [c.clientName, c]));

          for (const row of memoryRowsForMerge) {
            if (row.status !== "cached") continue;

            if (row.category === "discrepancy") {
              if (!row.cachedOptionsJSON) continue;
              if (oldPathFingerprints.has(row.fingerprintHash)) continue; 

              let alertObj = null;
              try { alertObj = JSON.parse(row.dataSnapshot); } catch (e) { continue; } 
              let options = [];
              try { options = JSON.parse(row.cachedOptionsJSON); } catch (e) { continue; } 

              // --- DECOMPRESS JOB ROWS ---
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
              // ---------------------------

              const liveMeta = clientNameToMeta.get(row.clientName) || {};

              // Crucial Fix: Force inject the correct clientName and IDs
              // overriding whatever broken data was trapped in the old snapshot
              newAlertsFromMemory.push({
                ...alertObj, 
                fingerprintHash: row.fingerprintHash, 
                clientName: row.clientName,
                clientId: liveMeta.clientSheetId || alertObj.clientId || alertObj.clientSheetId || "",
                masterSheetId: liveMeta.masterSheetId || alertObj.masterSheetId || "",
                options 
              });

              if (!extraFlagsByClient.has(row.clientName)) extraFlagsByClient.set(row.clientName, {});
              
              // Upgrade legacy database labels to the new strict taxonomy
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
              // Process info flags (or legacy proactive-tagged info flags during transition)
              if (!Object.prototype.hasOwnProperty.call(AUTOLOG_TYPE_PATTERNS, row.alertType)) {
                if (row.category === "proactive") {
                  let alertObj = {};
                  try { alertObj = JSON.parse(row.dataSnapshot || "{}"); } catch (e) { alertObj = {}; }
                  const metaFields = ["jobName","endClientName","confirmedRow","revenue","startDate","endDate",
                    "frequencyDays","lastInvoiceDate","expectedByDate","timestamp","sequenceType","summary","jobInfo","detailsSnippet",
                    "childRowNum","clientJobStr","pipelineRow","likelihood","copiedToConf","jobType",
                    "possibleMatchInvoiceNo","possibleMatchAmount","possibleMatchSentDate","possibleMatchConfidence","possibleMatchConfirmedRow","possibleMatchVatAmount","possibleMatchStatus","possibleMatchCase",
                    "uninvoicedAmount","projectCode","draftCount","draftTotal","stableJobKey","isRetainer","tab",
                    "directCosts","unreceivedAmount","placeholderCount","placeholderTotal"];
                  const metadata = {};
                  for (const f of metaFields) { if (alertObj[f] !== undefined) metadata[f] = alertObj[f]; }
                  newProactiveFromMemory.push({
                    ...alertObj, rowIndex: row.rowIndex, clientName: alertObj.clientName || row.clientName, alertType: alertObj.alertType || row.alertType, metadata
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

              let analysisResult = null;
              if (row.cachedOptionsJSON) {
                try { analysisResult = JSON.parse(row.cachedOptionsJSON); } catch (e) { analysisResult = null; }
              }
              newNoActionFromMemory.push({
                clientId: clientMeta.masterSheetId,
                flagType: row.alertType,
                flagName: FLAG_NAMES[row.alertType] || row.alertType,
                flagDetail: row.alertSummary, // Pass the raw text so the UI can display it
                fingerprintHash: row.fingerprintHash,
                // Pre-computed at build_cached_alert_options time (26 Aug
                // 2026, proposal 2) for the 6 rich informational types —
                // the exact {success, flagType, results, overallOk} shape
                // analyzeNoActionFlag has always returned on manual re-run,
                // just already sitting here rather than requiring a live,
                // on-demand call.
                analysisResult,
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
            finalProactiveAlerts = newProactiveFromMemory;

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

        const precomputedData = {
          computedAt: computedAt || Date.now(),
          totalAlerts: finalAlerts.length,
          noActionCount: finalNoActionAlerts.length,
          alerts: finalAlerts,
          noActionAlerts: finalNoActionAlerts,
          proactiveAlerts: finalProactiveAlerts,
          clientsWithFlags: finalClientsWithFlags,
          noActionAnalysisResults: noActionAnalysisResults || {},
        };

        await redisClient.set(
          PRECOMPUTED_KEY,
          JSON.stringify(precomputedData),
          { EX: 3600 } // 1 hour TTL
        );

        const analysisCount = Object.keys(precomputedData.noActionAnalysisResults).length;
        console.log(`✅ store_precomputed: ${precomputedData.totalAlerts} alerts, ${analysisCount} pre-analysed flags saved to Redis`);

        // Log this run — the other end of the pipeline from FlagSweepLog,
        // so Paul can see what the precompute stage actually built from
        // whatever flags run_flag_sweep raised. Per-client counts computed
        // from the final, already-merged result (not raw GAS input), so
        // this reflects what actually got cached.
        try {
          const sheetsForLog = await getSheetsClient();
          const clientDetail = (finalClientsWithFlags || []).map(c => ({
            clientName: c.clientName,
            alertCount: finalAlerts.filter(a => a.clientName === c.clientName).length,
            noActionCount: finalNoActionAlerts.filter(na => {
              const naClient = (finalClientsWithFlags || []).find(rc => rc.masterSheetId === na.clientId);
              return naClient && naClient.clientName === c.clientName;
            }).length,
            proactiveCount: (precomputedData.proactiveAlerts || []).filter(pa => pa.clientName === c.clientName).length,
          })).filter(c => c.alertCount > 0 || c.noActionCount > 0 || c.proactiveCount > 0);
          
          await logPrecomputeRun(sheetsForLog, extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId, {
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
    } else if (action === "run_flag_sweep") {
      // Detects the 14 remaining flag types by reading InvComp/DirComp/
      // CRMComp (6 dashboard types, fingerprint-based) and AutoLog (8
      // informational types, matched on structured log lines) directly —
      // replaces compareAutoResults, runFullSweep, and the AutoUpdates
      // IMPORTRANGE layer entirely. The old count-based DataChgAlert
      // comparison this action originally also did for the 8 AutoLog types
      // was removed once every remaining type had proper discrete
      // detection (confirmed programmatically, 23 Aug 2026) — no type is
      // left relying on it. Writes directly to AlertMemory now, not
      // AutoUpdates (unified alert-system redesign).
      const { secret: sweepSecret, automationCommanderSheetId: acIdSweep, startIdx = 0 } = req.body;
      if (sweepSecret !== process.env.CRON_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorised" });
      }
      if (!acIdSweep) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });

      const sweepStart = Date.now();
      // Declared here, before the try block, rather than inside it —
      // needed in the catch block below too (for error logging), and
      // let/const declared inside try are not visible in a sibling catch.
      let clientsChecked = 0, flagsRaised = 0, errors = 0;
      let alertsDelayed = 0, alertsWoken = 0;
      let raisedDetail = [];
      let categoriesRunStr = "";
      try {
        const sheets = await getSheetsClient();

        const { clientRows } = await readAutoUpdatesClientRows_(sheets, acIdSweep);

        // Per-category scheduling (26 Aug 2026, Paul's direction) — actionable
        // and info detection now each respect their own configurable
        // frequency instead of both always running on every 30-min tick.
        // Computed once per sweep call (not per client) since frequency is
        // global, not per-client — every chunk within one full sweep cycle
        // sees the same due/not-due decision, since lastCheckedAt is only
        // updated once the whole cycle finishes (see the end of this action).
        await ensureSweepScheduleTab(sheets, acIdSweep);
        const schedule = await readSweepSchedule_(sheets, acIdSweep);
        const actionableDue = isCategoryDue_(schedule.actionable);
        const infoDue = isCategoryDue_(schedule.info);
        const proactiveDue = req.body.forceProactive === true || isCategoryDue_(schedule.proactive);
        categoriesRunStr = [actionableDue ? "act" : "", infoDue ? "info" : "", proactiveDue ? "pro" : ""].filter(Boolean).join(",");
        console.log(`run_flag_sweep: actionableDue=${actionableDue}, infoDue=${infoDue}, proactiveDue=${proactiveDue}`);
        
        // Chunking architecture: process a strict subset of clients to avoid Vercel timeouts
        // Proactive checks require reading entire sheets, so we drop chunk size to 1 to stay safely under the 10s limit
        const CHUNK_SIZE = proactiveDue ? 1 : 3;
        const clientChunk = clientRows.slice(startIdx, startIdx + CHUNK_SIZE);
        const hasMore = startIdx + CHUNK_SIZE < clientRows.length;
        const nextIdx = startIdx + CHUNK_SIZE;

        console.log(`run_flag_sweep: processing clients ${startIdx + 1} to ${Math.min(startIdx + CHUNK_SIZE, clientRows.length)} of ${clientRows.length}`);

        // Invoice/CRM/expense automation frequency (columns O/P/Q) — needed
        // to know which of the 6 fingerprint-based checks actually apply to
        // each client, same as runFullSweep_stage1_'s hasInvoice/hasCRM/
        // hasExpense gating (GAS), so a client with no invoice automation
        // active doesn't get an InvComp read it doesn't need.
        const freqResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: acIdSweep,
          range: "AutoUpdates!O2:Q1000",
        });
        const freqRows = freqResponse.data.values || [];

        const sweepItems = []; // { clientName, alertType, fingerprints } — fingerprint-based flags, checked once against AlertMemory after the main loop
        // raisedDetail: { clientName, flagKey } — for the FlagSweepLog, so Paul can see exactly what was raised, not just a count
        // (clientsChecked/flagsRaised/errors/raisedDetail themselves are declared before the try block, above)

        for (const client of clientChunk) {
          try {
            const freqRow = freqRows[client.rowIndex] || [];
            const hasInvoice = !!freqRow[0];
            const hasCRM     = !!freqRow[1];
            const hasExpense = !!freqRow[2];

            console.log(`  📦 Batch fetching static data for ${client.clientName}...`);
            let batchData = {};
            try {
              const batchResp = await sheets.spreadsheets.values.batchGet({
                spreadsheetId: client.masterSheetId,
                ranges: [
                  "DataChgAlert!B4:I4",
                  (hasInvoice && actionableDue) ? "InvComp!A5:Y1000" : "DataChgAlert!A1",
                  (hasExpense && actionableDue) ? "DirComp!A5:AV1000" : "DataChgAlert!A1",
                  (infoDue || proactiveDue) ? "AutoLog!A2:D200" : "DataChgAlert!A1"
                ]
              });
              const ranges = batchResp.data.valueRanges || [];
              batchData.gasLocks = ranges[0]?.values || [];
              batchData.invComp = ranges[1]?.values || [];
              batchData.dirComp = ranges[2]?.values || [];
              batchData.autoLog = ranges[3]?.values || [];
            } catch(e) {
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
                });
                sweepItems.push({
                  clientName: client.clientName, alertType: "invoiceDashboardDiscr",
                  alerts: invAlerts,
                  autoUpdatesRow: client.sheetRowNum,
                  category: "discrepancy",
                });
              }
            }

            if (hasExpense && actionableDue) {
              const expLock = gasLocks.expense;
              if (!expLock.locked) {
                const expAlerts = await readDirCompAlerts(sheets, client.masterSheetId);
                expAlerts.forEach(a => { 
                  a.clientName = client.clientName;
                  a.clientId = client.clientSheetId;
                  a.masterSheetId = client.masterSheetId;
                  a.flagType = "expenseDashboardDiscr"; 
                  a._fingerprint = buildAlertFingerprint(a); 
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
                  });
                  const dashAlerts = crmAlerts.filter(a => (a.flagType || a.alertType) === dashKey);
              const appAlerts  = crmAlerts.filter(a => (a.flagType || a.alertType) === appKey);
              // Push unconditionally so the auto-resolve logic knows we checked and found 0 if fixed
              sweepItems.push({ clientName: client.clientName, alertType: dashKey, alerts: dashAlerts, autoUpdatesRow: client.sheetRowNum, category: "discrepancy" });
              sweepItems.push({ clientName: client.clientName, alertType: appKey, alerts: appAlerts, autoUpdatesRow: client.sheetRowNum, category: "discrepancy" });
                }
              }
            }

            // AutoLog-derived informational types (22 Aug 2026) — the 5
            // confirmed ones only (see AUTOLOG_TYPE_PATTERNS). Each
            // matched line becomes its own synthetic "alert" — the line
            // text itself already contains everything (row/client/job/
            // amount) that makes it a discrete, fingerprintable event, so
            // no field-by-field parsing is needed, just matching which
            // pattern a line contains and hashing the whole line. Gated on
            // infoDue (26 Aug 2026) — this category now has its own
            // configurable frequency, independent of actionable.
            if (infoDue) {
              const logEntries = await readRecentAutoLogEntries_(sheets, client.masterSheetId, 30, batchData.autoLog);
              for (const [autoLogType, patterns] of Object.entries(AUTOLOG_TYPE_PATTERNS)) {
                const matchedAlerts = [];
                for (const entry of logEntries) {
                  const lines = (entry.details || "").split(/\n+/);
                  for (const line of lines) {
                    if (!patterns.some(p => line.includes(p))) continue;
                    const fingerprintInput = `${client.clientName}|${autoLogType}|${line}`;
                    matchedAlerts.push({
                      clientName: client.clientName,
                      alertType: autoLogType,
                      summary: line,
                      _fingerprint: createHash("sha256").update(fingerprintInput).digest("hex").substring(0, 16),
                    });
                  }
                }
                if (matchedAlerts.length > 0) {
                  sweepItems.push({ clientName: client.clientName, alertType: autoLogType, alerts: matchedAlerts, autoUpdatesRow: client.sheetRowNum, category: "info" });
                }
              }
            }

            // ── Proactive Checks (11 Overnight Checks) ────────────────────────
            if (proactiveDue) {
              console.log(`  🔍 Running proactive checks for ${client.clientName}...`);
              let sharedData = { confirmedData: null, pipelineData: null, autoLogData: batchData.autoLog || null };
              
              try {
                // Fetch Confirmed and Pipeline in one batch from the client sheet
                // UNFORMATTED_VALUE drastically reduces payload size to prevent Vercel memory/timeout crashes
                const clientBatchResp = await sheets.spreadsheets.values.batchGet({
                  spreadsheetId: client.clientSheetId,
                  ranges: [
                    "Confirmed!A1:CR5000",
                    "Pipeline!A1:DD5000"
                  ],
                  valueRenderOption: "UNFORMATTED_VALUE"
                });
                sharedData.confirmedData = clientBatchResp.data.valueRanges[0]?.values || [];
                sharedData.pipelineData = clientBatchResp.data.valueRanges[1]?.values || [];
              } catch (e) {
                console.log(`  ⚠️ Failed to fetch Confirmed/Pipeline for proactive checks: ${e.message}`);
              }

              // Run all 11 checks
              const proChecks = [
                checkRetainerInvoices_(client.clientName, client.clientSheetId, client.masterSheetId, sharedData, sheets),
                checkCRMWipe_(client.clientName, client.masterSheetId, sharedData),
                checkRevenueMismatch_(client.clientName, client.clientSheetId, sharedData),
                checkDirectCostsMismatch_(client.clientName, client.clientSheetId, sharedData),
                checkPipelineConfirmedOverlap_(client.clientName, client.clientSheetId, sharedData),
                checkRetainerShrinkBlocked_(client.clientName, client.masterSheetId, sharedData),
                checkUninvoicedRevenue_(client.clientName, client.clientSheetId, sharedData),
                checkDeletedInvoices_(client.clientName, client.clientSheetId, client.masterSheetId, sharedData, sheets),
                checkJobStructureErrors_(client.clientName, client.clientSheetId, sharedData),
                checkDeletedExpenses_(client.clientName, client.clientSheetId, client.masterSheetId, sharedData, sheets),
                checkUnreceivedExpenses_(client.clientName, client.clientSheetId, sharedData)
              ];

              const proResults = await Promise.all(proChecks);
              const proAlerts = proResults.flat();
              
              // We must push an entry to sweepItems for EVERY proactive type, even if 0 were found,
              // so the auto-resolve logic knows we checked them and can safely clear stale ones.
              const proactiveTypes = [
                "retainer_invoice", "crm_wipe", "revenue_mismatch", "direct_costs_mismatch",
                "pipeline_confirmed_overlap", "retainer_shrink_blocked", "uninvoiced_revenue",
                "deleted_invoice", "job_structure_error", "deleted_expense", "unreceived_expenses"
              ];
              
              const groupedProactive = {};
              proactiveTypes.forEach(t => groupedProactive[t] = []);
              
              proAlerts.forEach(a => {
                const fpInput = a.alertKey;
                a._fingerprint = createHash("sha256").update(fpInput).digest("hex").substring(0, 16);
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
              
              if (proAlerts.length > 0) {
                console.log(`  ✓ Proactive checks found ${proAlerts.length} alerts for ${client.clientName}`);
              }
            }
            // ──────────────────────────────────────────────────────────────────

            clientsChecked++;
          } catch (clientErr) {
            errors++;
            console.error(`  run_flag_sweep: error for ${client.clientName}: ${clientErr.message}`);
          }

          // Increased delay between clients — pacing limits to avoid tripping 
          // the 60-reads-per-minute per-user quota from Google Sheets API.

        await new Promise(r => setTimeout(r, 1200)); // 1.2s delay mathematically guarantees < 60 requests/min
        }

        // Resolve fingerprint-based sweepItems against AlertMemory — one
        // read, not per-client, same batching approach runFullSweep used.
        if (sweepItems.length > 0) {
          await ensureAlertMemoryTab(sheets, acIdSweep);
          const memoryRows = await readAlertMemory(sheets, acIdSweep);
          const handledHashes = getHandledFingerprintHashes_(memoryRows);
          // Fixed 23 Aug 2026 — Paul found multiple AlertMemory rows with
          // the exact same fingerprint. Root cause: handledHashes only
          // covers resolved/ignored/task/superseded/accepted rows (by
          // design, for its original purpose elsewhere) — it does NOT
          // cover "cached" rows still sitting there unresolved. Using it
          // alone as the "should I append a new row" check meant every
          // still-outstanding discrepancy got re-appended as a fresh
          // duplicate on every single 30-min sweep, since its fingerprint
          // never became "handled" until Paul actually resolved it.
          // existingHashes covers every fingerprint already in AlertMemory
          // at all, any status — the correct check for "don't duplicate
          // a row that's already there".
          const existingHashes = new Set(memoryRows.map(r => r.fingerprintHash).filter(Boolean));
          console.log(`  run_flag_sweep: ${sweepItems.length} fingerprint items to resolve, ${handledHashes.size} handled hashes, ${existingHashes.size} existing hashes`);

          const clientMetaMap = new Map(clientChunk.map(c => [c.clientName, c]));

          for (const item of sweepItems) {
            // AUTO-RESOLVE STALE DISCREPANCIES, PROACTIVE ALERTS & IGNORED ALERTS
            if (item.category === "discrepancy" || item.category === "proactive") {
              const freshHashes = new Set((item.alerts || []).map(a => a._fingerprint).filter(Boolean));
              const staleRows = memoryRows.filter(r => 
                r.clientName === item.clientName && 
                r.alertType === item.alertType && 
                (r.status === "cached" || r.status === "pending_automation" || r.status === "ignored" || (item.category === "proactive" && r.status === "task")) && 
                r.category === item.category &&
                !freshHashes.has(r.fingerprintHash)
              );

              for (const stale of staleRows) {
                try {
                  let updatedSnapshot = stale.dataSnapshot;
                  if (stale.status === "task") {
                    try {
                      const snap = JSON.parse(stale.dataSnapshot || "{}");
                      snap.resolvedAt = new Date().toISOString();
                      snap.autoResolvedReason = "Underlying proactive alert condition no longer detected";
                      updatedSnapshot = JSON.stringify(snap);
                    } catch(e) {}
                  }

                  let newStatus;
                  if (stale.status === "task") newStatus = "task_resolved";
                  else if (stale.status === "ignored") newStatus = "superseded";
                  else newStatus = "auto_resolved";

                  await updateAlertMemoryRow(sheets, acIdSweep, stale.rowIndex, { 
                    ...stale, 
                    status: newStatus,
                    lastRechecked: new Date().toISOString(),
                    dataSnapshot: updatedSnapshot
                  });
                  console.log(`  🩹 AUTO-RESOLVED stale ${item.alertType} ${stale.status} for ${item.clientName}: ${stale.fingerprintHash} -> ${newStatus}`);
                  stale.status = newStatus;
                  existingHashes.add(stale.fingerprintHash);
                } catch(e) {
                  console.log(`  ⚠️ Failed to auto-resolve stale alert: ${e.message}`);
                }
              }

              // WAKE UP PENDING AUTOMATION ALERTS
              const clientMeta = clientMetaMap.get(item.clientName);
              const pendingAutoRows = memoryRows.filter(r => 
                r.clientName === item.clientName && 
                r.alertType === item.alertType && 
                r.status === "pending_automation" &&
                freshHashes.has(r.fingerprintHash)
              );

              for (const pRow of pendingAutoRows) {
                let snap = {};
                try { snap = JSON.parse(pRow.dataSnapshot || "{}"); } catch(e){}
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
                  } catch(e) {
                    console.log(`  ⚠️ Failed to wake up alert: ${e.message}`);
                  }
                }
              }
            }

            if (!item.alerts || item.alerts.length === 0) continue;
            const newAlerts = item.alerts.filter(a => a._fingerprint && !existingHashes.has(a._fingerprint));
            if (newAlerts.length === 0) continue;
            flagsRaised++;
            console.log(`  ✅ ${item.clientName} / ${item.alertType} → TRUE (fingerprint: ${newAlerts.length} of ${item.alerts.length} new)`);

            // AlertMemory is now the only place a detected item gets
            // recorded (unified alert-system redesign) — the AutoUpdates
            // write this action used to also make alongside this has been
            // fully retired now that nothing reads it any more.
            const clientMeta = clientMetaMap.get(item.clientName);

            for (const alert of newAlerts) {
              try {
                // Extract the text string if the summary is an object (applies to invoices and expenses)
                let summary = alert.summary;
                if (typeof summary === "object" && summary !== null) {
                  summary = summary.summary;
                }

                if (!summary && (item.alertType.startsWith("crmPipe") || item.alertType.startsWith("crmConf"))) {
                  const crmArr = alert.data?.crmData || [];
                  const shtArr = alert.data?.sheetData || [];
                  const client = crmArr[0] || shtArr[1] || "";
                  const job    = crmArr[1] || shtArr[2] || "";
                  const code   = crmArr[2] || shtArr[0] || "";
                  const jobDesc = [client, job, code].filter(Boolean).join(" — ");
                  summary = `CRM ${item.alertType} ${jobDesc}`.trim();
                }
                summary = summary || `${item.alertType} — ${item.clientName} (row ${alert.rowNumber})`;
                // Store the full alert object (minus the internal _fingerprint
                // field, redundant with the fingerprintHash column) so the
                // eventual read-path can display it without a third re-read
                // of the underlying sheet. build_cached_alert_options
                // deliberately still re-derives fresh from the sheet itself
                // (options-building benefits from the most current data) —
                // this snapshot is for display only, not re-analysis.
                const { _fingerprint, ...alertForSnapshot } = alert;
                
                const detectedAtIso = new Date().toISOString();
                alertForSnapshot.detectedAt = detectedAtIso;
                
                const clientMeta = clientMetaMap.get(item.clientName);
                const status = evaluateAutomationStatus_(item.alertType, item.category, clientMeta, new Date(detectedAtIso).getTime(), null);

                await appendAlertMemoryRow(sheets, acIdSweep, {
                  fingerprintHash: alert._fingerprint,
                  alertType: item.alertType,
                  clientName: item.clientName,
                  alertSummary: summary,
                  cachedOptionsJSON: "",
                  status: status,
                  category: item.category || "discrepancy",
                  dataSnapshot: JSON.stringify(alertForSnapshot),
                });
                
                if (status === "pending_automation") {
                  console.log(`  💤 Alert ${alert._fingerprint} is pending automation run`);
                  alertsDelayed++;
                  raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "delayed" });
                } else {
                  raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "raised" });
                }
              } catch (memErr) {
                console.log(`  ⚠️ Could not write AlertMemory row for ${item.clientName}/${item.alertType}: ${memErr.message}`);
              }
            }
          }
        }

        // Only mark categories checked once the full sweep cycle completes
        // (not per chunk) — updating lastCheckedAt mid-cycle would let later
        // chunks in the same cycle see a different due/not-due decision
        // than earlier ones did.
        if (!hasMore) {
          try {
            if (actionableDue) await markCategoryChecked_(sheets, acIdSweep, "actionable", schedule);
            if (infoDue) await markCategoryChecked_(sheets, acIdSweep, "info", schedule);
            // Only update the proactive timer if it wasn't a forced manual run
            if (proactiveDue && !req.body.forceProactive) await markCategoryChecked_(sheets, acIdSweep, "proactive", schedule);
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
        await logFlagSweepRun(sheets, acIdSweep, { clientsChecked: clientsChecked || 0, flagsRaised: flagsRaised || 0, errors: (errors || 0) + 1, alertsDelayed: alertsDelayed || 0, alertsWoken: alertsWoken || 0, elapsedSeconds: elapsedS, raisedDetail: raisedDetail || [], isContinuation: startIdx > 0, categoriesRun: categoriesRunStr || "" }).catch(() => {});
        return res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "build_cached_alert_options") {
      // Second stage of the unified alert-system redesign (22 Aug 2026,
      // Paul's explicit direction). run_flag_sweep now writes a "cached"
      // AlertMemory row directly for each new discrepancy (6 dashboard
      // types so far), with no options yet — that's detection's job, not
      // this one. This action finds those rows and builds options for them.
      //
      // Deliberately reuses analyze_alert's existing, unchanged logic via a
      // genuine internal HTTP call, rather than extracting it — that block
      // is ~3000 lines of the most carefully-debugged matching logic in
      // this file (Tier 1/2, several real bugs already found and fixed
      // there this session), and extracting it wholesale would be a far
      // larger risk than one more HTTP round-trip. analyze_alert already
      // reads AlertMemory, builds options, and writes them back — this
      // action's only job is finding the right rows and re-deriving the
      // full alert object each one needs, the same shape start_triage
      // already prepares before calling analyze_alert live.
      const { secret: buildSecret, automationCommanderSheetId: acIdBuild } = req.body;
      if (buildSecret !== process.env.CRON_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorised" });
      }
      if (!acIdBuild) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });

      const buildStart = Date.now();
      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acIdBuild);
        const memoryRows = await readAlertMemory(sheets, acIdBuild);

        const pending = memoryRows.filter(r =>
          r.status === "cached" && r.category === "discrepancy" && !r.cachedOptionsJSON
        );
        console.log(`build_cached_alert_options: ${pending.length} rows pending options`);

        // Group by client+alertType so each client+type combination is
        // only re-read once, regardless of how many individual rows within
        // it need options.
        const groups = new Map(); // key: `${clientName}::${alertType}` -> AlertMemory rows
        for (const row of pending) {
          const key = `${row.clientName}::${row.alertType}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(row);
        }

        const { clientRows } = await readAutoUpdatesClientRows_(sheets, acIdBuild);
        const clientByName = new Map(clientRows.map(c => [c.clientName, c]));

        const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
          ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
          : `https://${process.env.VERCEL_URL}`;

        let built = 0, notFound = 0, errors = 0;
        let hasMore = false;
        let builtDetail = [];
        const TIME_LIMIT_MS = 220000; // 3.6 minutes (leaves a safe buffer before Vercel's 300s kill)

        for (const [key, rows] of groups.entries()) {
          // Time-Based Chunking Eject
          if (Date.now() - buildStart > TIME_LIMIT_MS) {
            console.log(`  ⏳ Time limit reached (${Math.round((Date.now() - buildStart)/1000)}s). Exiting cleanly to avoid 300s timeout.`);
            hasMore = true;
            break;
          }

          const [clientName, alertType] = key.split("::");
            const client = clientByName.get(clientName);
            if (!client) {
              console.log(`  ⚠️ ${clientName}: not found in current client list — skipping ${rows.length} row(s)`);
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
              } catch(e) {
                console.log(`  ⚠️ Failed to fetch shared data for ${clientName}: ${e.message}`);
              }

              let currentAlerts = [];
            if (alertType === "invoiceDashboardDiscr" || alertType === "invoice") {
              currentAlerts = await readInvCompAlerts(sheets, client.masterSheetId);
              currentAlerts.forEach(a => { a.flagType = "invoiceDashboardDiscr"; a._fingerprint = buildAlertFingerprint(a); });
            } else if (alertType === "expenseDashboardDiscr" || alertType === "expense") {
              currentAlerts = await readDirCompAlerts(sheets, client.masterSheetId);
              currentAlerts.forEach(a => { a.flagType = "expenseDashboardDiscr"; a._fingerprint = buildAlertFingerprint(a); });
            } else if (["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr", "crm"].includes(alertType)) {
              if (alertType === "crm") {
                const pipeAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, "Pipeline", ["crmPipeDashDiscr", "crmPipeAppDiscr"], client.masterSheetId);
                const confAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, "Confirmed", ["crmConfDashDiscr", "crmConfAppDiscr"], client.masterSheetId);
                currentAlerts = [...pipeAlerts, ...confAlerts];
                currentAlerts.forEach(a => { a._fingerprint = buildAlertFingerprint(a); });
              } else {
                const mode = alertType.startsWith("crmPipe") ? "Pipeline" : "Confirmed";
                const pairKey = alertType.endsWith("DashDiscr")
                  ? [alertType, alertType.replace("DashDiscr", "AppDiscr")]
                  : [alertType.replace("AppDiscr", "DashDiscr"), alertType];
                currentAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, mode, pairKey, client.masterSheetId);
                currentAlerts.forEach(a => { a._fingerprint = buildAlertFingerprint(a); });
                currentAlerts = currentAlerts.filter(a => (a.flagType || a.alertType) === alertType);
              }
            } else {
              console.log(`  ⚠️ Unknown alertType "${alertType}" for ${clientName} — skipping`);
              notFound += rows.length;
              continue;
            }

            for (const row of rows) {
              const match = currentAlerts.find(a => a._fingerprint === row.fingerprintHash);
              if (!match) {
                console.log(`  ⏭ ${clientName}/${alertType}: fingerprint ${row.fingerprintHash.slice(0, 8)}… no longer found — marking auto_resolved`);
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

              match.clientId = client.clientSheetId;
              match.masterSheetId = client.masterSheetId;
              match.clientName = client.clientName;
              match.flagType = match.flagType || alertType;
              match.fingerprintHash = row.fingerprintHash;

              try {
                const analyzeRes = await fetch(`${baseUrl}/api/triage`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "analyze_alert", alert: match, memoryRow: row, automationCommanderSheetId: acIdBuild, sharedData }),
                });
                const analyzeData = await analyzeRes.json();
                if (analyzeData.success) {
                  // Catch-All Fix: Guarantee the options are saved to the database, even if a fast-path forgot to save them.
                  if (analyzeData.options) {
                    await updateAlertMemoryRow(sheets, acIdBuild, row.rowIndex, {
                      ...row,
                      cachedOptionsJSON: JSON.stringify(analyzeData.options)
                    });
                  }
                  built++;
                  builtDetail.push({ clientName, flagKey: alertType, fromCache: !!analyzeData.fromCache });
                  console.log(`  ✅ ${clientName}/${alertType}: options built`);
                } else {
                  errors++;
                  console.log(`  ❌ ${clientName}/${alertType}: analyze_alert failed — ${analyzeData.error || "unknown"}`);
                }
              } catch (fetchErr) {
                errors++;
                console.log(`  ❌ ${clientName}/${alertType}: analyze_alert call failed — ${fetchErr.message}`);
              }

              // Generous delay to prevent 429 quota errors during intensive analysis phase
              await new Promise(r => setTimeout(r, 1200)); // 1.2s delay mathematically guarantees < 60 requests/min
            }
          } catch (groupErr) {
            errors += rows.length;
            console.log(`  ❌ ${clientName}/${alertType}: group processing failed — ${groupErr.message}`);
          }
        }

        const elapsedS = Math.round((Date.now() - buildStart) / 1000);
        console.log(`build_cached_alert_options complete in ${elapsedS}s: ${built} built, ${notFound} not found, ${errors} errors, hasMore: ${hasMore}`);

        // Second pass: the 6 rich informational types (26 Aug 2026, proposal
        // 2, Paul's direction) — runs the newly-targeted analyze_noaction_flag
        // once here, at build time, rather than within run_flag_sweep itself,
        // for the same reason this whole action already exists separately
        // from detection: keeps detection fast, and an occasional slow
        // Pipeline/Confirmed read here can't block the next sweep. Reuses
        // cachedOptionsJSON to store the result — same "pre-computed result
        // for this row" role it already plays for discrepancy-type rows,
        // just holding an analysis result instead of Tier1/2 options here.
        const RICH_INFO_TYPES = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete",
          "retainerInvoicesCreated", "retainerInvoicesDeleted", "invoiceStaleUnsentChanges"];
        const pendingRich = memoryRows.filter(r =>
          r.status === "cached" && r.category === "info" && RICH_INFO_TYPES.includes(r.alertType) && !r.cachedOptionsJSON
        );
        let richAnalyzed = 0, richErrors = 0;
        if (pendingRich.length > 0 && !hasMore) {
          console.log(`build_cached_alert_options: ${pendingRich.length} rich informational row(s) pending analysis`);
          for (const row of pendingRich) {
            if (Date.now() - buildStart > TIME_LIMIT_MS) {
              console.log(`  ⏳ Time limit reached during rich-type analysis — remaining rows will be picked up next run.`);
              hasMore = true;
              break;
            }
            const client = clientByName.get(row.clientName);
            if (!client) { richErrors++; continue; }
            try {
              const analyzeRes = await fetch(`${baseUrl}/api/triage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "analyze_noaction_flag",
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
                console.log(`  ❌ ${row.clientName}/${row.alertType}: analyze_noaction_flag failed — ${analyzeData.error || "unknown"}`);
              }
            } catch (richErr) {
              richErrors++;
              console.log(`  ❌ ${row.clientName}/${row.alertType}: analyze_noaction_flag call failed — ${richErr.message}`);
            }
            await new Promise(r => setTimeout(r, 1200)); // same 429-avoidance delay as the discrepancy loop above
          }
          console.log(`build_cached_alert_options: rich informational analysis — ${richAnalyzed} analyzed, ${richErrors} errors`);
        }

        await logBuildOptionsRun(sheets, acIdBuild, { 
          processed: pending.length, built, notFound, errors, elapsedSeconds: elapsedS, builtDetail, isContinuation: req.body.isContinuation
        });

        return res.status(200).json({ success: true, processed: pending.length, built, notFound, errors, elapsedSeconds: elapsedS, hasMore, richAnalyzed, richErrors });
      } catch (err) {
        console.error("❌ build_cached_alert_options error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "bust_cache") {
      // Clears cachedOptionsJSON for a specific alert, forcing a fresh Claude analysis.
      // Accepts fingerprintHash directly, or rowNumber+sheetName to look up the hash.
      const { fingerprintHash, rowNumber, sheetName, automationCommanderSheetId: acId } = req.body;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        const memoryRows = await readAlertMemory(sheets, acId);
        let row = null;
        if (fingerprintHash) {
          row = findMemoryRow(memoryRows, fingerprintHash);
        } else if (rowNumber && sheetName) {
          // Find by matching alertSummary rowNumber — look for cached rows where summary contains the rowNumber
          row = memoryRows.find(r =>
            r.status === "cached" &&
            r.cachedOptionsJSON &&
            r.alertSummary?.includes(String(rowNumber))
          );
        }
        if (!row) return res.status(404).json({ success: false, error: "Alert not found in AlertMemory" });
        await updateAlertMemoryRow(sheets, acId, row.rowIndex, { ...row, cachedOptionsJSON: "" });
        console.log(`  ✅ Cache cleared for row ${row.rowIndex} (${row.fingerprintHash})`);
        return res.status(200).json({ success: true, fingerprintHash: row.fingerprintHash });
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "analyze_alert_ai") {
      // Force Claude AI path for an alert — called when user clicks "Use AI" button.
      // Re-uses analyze_alert but sets a flag to bypass system-generated options and go straight to Claude.
      req.body.action = "analyze_alert";
      req.body.forceAI = true;
      // Fall through to analyze_alert handler below
      // (re-dispatch via internal call is complex — instead we duplicate the entry point)
      // NOTE: This simply re-routes the action name and falls through.
      // The forceAI flag is checked within the handler.
    } else if (action === "analyze_alert") {
      // Generate matching options for an alert
      const { alert, sharedData } = req.body;
      
      if (!alert) {
        res.status(400).json({ success: false, error: "Missing alert data" });
        return;
      }

      // Proactive alerts (revenue_mismatch, direct_costs_mismatch, retainer_invoice etc.)
      // don't have automation options to generate — they have heading/detail only.
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
            console.log(`  ⏭ Alert is ignored — returning ignored status`);
            return res.status(200).json({ success: true, ignored: true });
          }
          if (memoryRow.status === "cached" && memoryRow.cachedOptionsJSON) {
            console.log(`  ✅ Cache HIT for ${fingerprintHash} — returning stored options`);
            // Update lastSeen
            await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
              ...memoryRow,
            });
            let cachedOptions = [];
            try {
              cachedOptions = JSON.parse(memoryRow.cachedOptionsJSON);
            } catch (e) {
              console.log(`  ⚠️ Could not parse cached options JSON — will re-fetch from Claude`);
            }
            // Only use cache if options have valid structure (title field present)
            // If cached options are the fallback { summary: ... } format from a failed
            // Claude parse, discard them and re-call Claude for a fresh result
            const validCachedOptions = cachedOptions.filter(o => o.title);
            if (validCachedOptions.length > 0) {
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
                } catch(e) {
                  console.log(`  copiedToConf live fetch failed: ${e.message}`);
                }
              }
              // Inject live copiedToConf into cached options if fetched
              let optionsToReturn = liveCopiedToConf !== null
                ? validCachedOptions.map(o => ({ ...o, copiedToConf: liveCopiedToConf }))
                : validCachedOptions;

              // Regenerate jobRowsData fresh for cached options — this data may be
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
                  // Prefer explicit target fields (set at generation time) over parsing
                  // recommendedActions text — explicit fields can't be mismatched.
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
            console.log(`  ⚠️ Cached options have no valid title — treating as cache miss`);
          }
        }

        console.log(`  Cache MISS for ${fingerprintHash} — calling Claude`);

        // Check if this alert was previously ignored (superseded) — surface the old reason
        const previousIgnoreReason = await findPreviousIgnoreReason(memoryRows, alert);
        if (previousIgnoreReason) {
          console.log(`  ℹ️ Found previous ignore reason for this alert`);
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
          const flagNames = ["Missing cost","Duplicate app ID","Description mismatch",
            "Amount mismatch","VAT mismatch","Rec date mismatch","Pay date mismatch","Status mismatch"];
          const activeFlags = flags.map((v, i) => String(v||"").trim()==="1" ? flagNames[i] : null).filter(Boolean);


          // Extract key fields from alert data
          // confirmed slice = cols X:AH (indices 23-33 of raw row), so:
          //   index 3 within confirmed = AA (vendor description)
          //   index 10 within confirmed = AH (source)
          // accounting slice = cols A:J (indices 0-9), index 8 = col I (VAT amount)
          const confirmed  = alert.data?.confirmed  || [];
          const accounting = alert.data?.accounting || [];
          const vendorDesc = String(confirmed[3] || "").trim();   // AA
          const source     = String(confirmed[10] || "").trim();  // AH
          const vatAmount  = parseFloat(String(accounting[8] || "0").replace(/[£$€,]/g, "")) || 0;
          const expDescription = String(accounting[1] || "").trim();
          const expAmount      = parseFloat(String(accounting[2] || "0").replace(/[£$€,]/g, "")) || 0;
          const expDate        = String(accounting[0] || "").trim();

          // Extract vendor name = part before first "(" in vendorDesc, trimmed
          const vendorName = (vendorDesc.includes("(")
            ? vendorDesc.slice(0, vendorDesc.indexOf("("))
            : vendorDesc).trim();

          console.log(`  Discrepancy type(s): ${activeFlags.join(", ") || "unknown"}`);
          console.log(`  Source: ${source}, Vendor: "${vendorName}", VAT amount: ${vatAmount}`);

          // ── VAT mismatch handling ──────────────────────────────────────────
          if (isVATMismatch && !isMissingCost) {
            console.log(`  📊 VAT mismatch — analysing...`);

            // Step 1: Is this a Confirmed tab or Outgoings tab expense?
            if (source.startsWith("Slot")) {
              // Confirmed tab expense — find the row by TransactionID and update the VAT field
              const slotNum = source === "Slot1" ? 1 : source === "Slot2" ? 2 : source === "Slot3" ? 3 : null;
              const slotColMap = {
                1: { vat: "BZ", txId: "CD" },
                2: { vat: "CG", txId: "CK" },
                3: { vat: "CN", txId: "CR" },
              };
              const transactionId = String(accounting[6] || "").trim();
              const newVATValue = vatAmount > 0 ? "Yes" : "No";
              console.log(`  📊 Slot VAT mismatch: source=${source}, transactionId=${transactionId}, newVAT=${newVATValue}`);

              if (!slotNum || !transactionId) {
                const options = [{
                  optionId: 1,
                  title: `MANUAL INVESTIGATION REQUIRED — Could not identify slot or transaction ID`,
                  matchType: "info",
                  matchAnalysis: {
                    matchConfidence: "N/A",
                    reasonForChoice: `Source: ${source}, TransactionID: "${transactionId || "(blank)"}"`,
                    discrepancies: `VAT mismatch on ${source} for "${vendorDesc}"`,
                  },
                  recommendedActions: [
                    `Check the VAT field for "${vendorDesc}" in ${source} of the Confirmed tab`,
                  ],
                }];
                return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
              }

              const cols = slotColMap[slotNum];
              // Search the Confirmed tab for the row containing this TransactionID
              const confirmedResp = await sheets.spreadsheets.values.get({
                spreadsheetId: alert.clientId,
                range: `Confirmed!${cols.txId}2:${cols.txId}2000`,
              });
              const txRows = confirmedResp.data.values || [];
              let confirmedRow = -1;
              for (let i = 0; i < txRows.length; i++) {
                if (String(txRows[i]?.[0] || "").trim() === transactionId) {
                  confirmedRow = i + 2; // 1-indexed, data starts row 2
                  break;
                }
              }
              console.log(`  Confirmed tab row search for txId=${transactionId}: row=${confirmedRow}`);

              if (confirmedRow === -1) {
                const options = [{
                  optionId: 1,
                  title: `MANUAL INVESTIGATION REQUIRED — Transaction not found in Confirmed tab`,
                  matchType: "info",
                  matchAnalysis: {
                    matchConfidence: "N/A",
                    reasonForChoice: `Could not find transaction ID "${transactionId}" in ${source} of the Confirmed tab. Manual investigation required.`,
                    discrepancies: `VAT mismatch for "${vendorDesc}"`,
                  },
                  recommendedActions: [
                    `Search the Confirmed tab for transaction "${transactionId}" and correct the VAT field in ${source}`,
                  ],
                }];
                return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
              }

              const options = [{
                optionId: 1,
                title: `Update VAT setting to "${newVATValue}" for "${vendorDesc}" in Confirmed tab ${source} (Row ${confirmedRow})`,
                matchType: "existing_job",
                jobRow: confirmedRow,
                jobName: vendorDesc,
                matchAnalysis: {
                  matchConfidence: "High",
                  reasonForChoice: `Accounting system shows VAT ${vatAmount > 0 ? `of £${vatAmount.toFixed(2)}` : "not applied"} for this expense. The Confirmed tab ${source} VAT field should be "${newVATValue}".`,
                  discrepancies: `VAT mismatch — accounting system has VAT ${vatAmount > 0 ? "applied" : "not applied"}, Confirmed tab has the opposite`,
                },
                recommendedActions: [
                  `Update VAT setting for "${vendorDesc}" in Confirmed tab ${source} to "${newVATValue}"`,
                  `write ${newVATValue} to ${cols.vat}${confirmedRow} (${source} VAT field)`,
                ],
              }];
              console.log(`  ✅ Slot VAT fix: write "${newVATValue}" to ${cols.vat}${confirmedRow}`);
              return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
            }

            if (!source.startsWith("OG-")) {
              // Unknown source — manual investigation
              const options = [{
                optionId: 1,
                title: `MANUAL INVESTIGATION REQUIRED — Cannot determine expense location`,
                matchType: "info",
                matchAnalysis: {
                  matchConfidence: "N/A",
                  reasonForChoice: `The source field "${source}" is not recognised. Manual investigation required.`,
                  discrepancies: `VAT mismatch, unrecognised source: "${source}"`,
                },
                recommendedActions: [`Investigate the expense "${vendorDesc}" manually`],
              }];
              return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
            }

            // Step 2: Outgoings tab expense — re-read full DirComp to find all items for this vendor
            console.log(`  Re-reading DirComp to find all Outgoings items for vendor "${vendorName}"...`);
            const dirCompResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.masterSheetId || alert.clientId,
              range: "DirComp!A6:AV2000",
            });
            const dirCompRows = dirCompResp.data.values || [];

            // Filter to rows with data in A:J (indices 0-9)
            const populatedRows = dirCompRows.filter(r =>
              r && r.slice(0, 10).some(v => String(v || "").trim() !== "")
            );

            // Find all rows for the same vendor that are Outgoings tab expenses
            const normalise = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
            const vendorNorm = normalise(vendorName);

            const vendorOGRows = populatedRows.filter(r => {
              const rowVendorDesc = String(r[26] || "").trim(); // AA = index 26
              const rowVendor = normalise(rowVendorDesc.includes("(")
                ? rowVendorDesc.slice(0, rowVendorDesc.indexOf("("))
                : rowVendorDesc);
              const rowSource = String(r[33] || "").trim(); // AH = index 33
              return rowVendor === vendorNorm && rowSource.startsWith("OG-");
            });

            console.log(`  Found ${vendorOGRows.length} Outgoings items for vendor "${vendorName}"`);

            if (vendorOGRows.length === 0) {
              // Shouldn't happen since the triggering row should be in there, but handle gracefully
              const options = [{
                optionId: 1,
                title: `MANUAL INVESTIGATION REQUIRED — Could not find vendor items in DirComp`,
                matchType: "info",
                matchAnalysis: {
                  matchConfidence: "N/A",
                  reasonForChoice: `No Outgoings tab items found for vendor "${vendorName}" in DirComp. Manual investigation required.`,
                  discrepancies: `VAT mismatch for "${vendorDesc}" (source: ${source})`,
                },
                recommendedActions: [`Investigate the VAT setting for "${vendorName}" in the Outgoings tab manually`],
              }];
              return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
            }

            // Step 3: Check VAT treatment across all vendor OG items
            // col I = index 8 in raw DirComp row (accounting section A:J)
            const vatTreatments = vendorOGRows.map(r => {
              const vat = parseFloat(String(r[8] || "0").replace(/[£$€,]/g, "")) || 0;
              return vat > 0 ? "yes" : "no";
            });
            const allSameVAT = vatTreatments.every(v => v === vatTreatments[0]);
            const unanimousVAT = allSameVAT ? vatTreatments[0] : null; // "yes" or "no"

            console.log(`  VAT treatments across ${vendorOGRows.length} items: ${vatTreatments.join(", ")} — unanimous: ${unanimousVAT || "NO"}`);

            if (!allSameVAT) {
              // Mixed VAT treatment — vendor has some items with VAT and some without.
              // Changing col B would break the other items, so we offer per-item fix only.
              // This specific expense has vatAmount, so we know what THIS item should be.
              const thisVAT = vatAmount > 0 ? "Yes" : "No";
              const options = [{
                optionId: 1,
                title: `VAT mismatch on this item only — vendor "${vendorName}" has mixed VAT treatment`,
                matchType: "info",
                matchAnalysis: {
                  matchConfidence: "Medium",
                  reasonForChoice: `${vendorOGRows.length} Outgoings items exist for "${vendorName}" with mixed VAT treatments (${vatTreatments.filter(v=>v==="yes").length} with VAT, ${vatTreatments.filter(v=>v==="no").length} without). Changing the vendor-level VAT setting (Outgoings col B) would affect all items. The discrepancy on this specific item suggests the accounting system recorded VAT ${vatAmount > 0 ? `of £${vatAmount.toFixed(2)}` : "not applied"} but the Outgoings tab shows the opposite. Please review this item individually in the Outgoings tab for ${source}.`,
                  discrepancies: `VAT mismatch on this item — accounting: VAT ${vatAmount > 0 ? "applied" : "not applied"}, Outgoings: opposite`,
                },
                recommendedActions: [
                  `Review the ${source} entry for "${expDescription}" in the Outgoings tab`,
                  `The accounting system shows VAT ${vatAmount > 0 ? `of £${vatAmount.toFixed(2)} (gross: £${(expAmount + vatAmount).toFixed(2)})` : "not applied"}. Check whether the Outgoings note VAT field is set correctly for this item.`,
                ],
              }];
              return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
            }

            // Step 4: All items agree — find vendor row in Outgoings and recommend VAT change
            const newVATValue = unanimousVAT === "yes" ? "Yes" : "No";
            const isSingleItem = vendorOGRows.length === 1;

            // Find vendor row in Outgoings (rows 13-110 = 0-indexed 12-109, col A)
            const outgoingsResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: "Outgoings!A13:B110",
            });
            const outgoingsRows2 = outgoingsResp.data.values || [];
            let outgoingsVendorRow = -1;
            for (let i = 0; i < outgoingsRows2.length; i++) {
              const rowVendor = normalise(String(outgoingsRows2[i]?.[0] || ""));
              if (rowVendor === vendorNorm) {
                outgoingsVendorRow = i + 13; // 1-indexed sheet row
                break;
              }
            }

            if (outgoingsVendorRow === -1) {
              const options = [{
                optionId: 1,
                title: `MANUAL INVESTIGATION REQUIRED — Vendor "${vendorName}" not found in Outgoings tab`,
                matchType: "info",
                matchAnalysis: {
                  matchConfidence: "N/A",
                  reasonForChoice: `All ${vendorOGRows.length} items for "${vendorName}" agree on VAT treatment (${newVATValue}), but the vendor could not be found in the Outgoings tab rows 13-110. Manual investigation required.`,
                  discrepancies: `VAT mismatch for "${vendorName}"`,
                },
                recommendedActions: [`Find "${vendorName}" in the Outgoings tab and set column B to "${newVATValue}"`],
              }];
              return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
            }

            const rationale = isSingleItem
              ? `This is the only Outgoings tab expense for "${vendorName}". Changing the VAT setting to "${newVATValue}" will resolve the discrepancy.`
              : `All ${vendorOGRows.length} Outgoings tab expenses for "${vendorName}" have the same VAT treatment (${newVATValue}). Changing the row-level VAT setting will resolve all discrepancies at once.`;

            const options = [{
              optionId: 1,
              title: `CHANGE VAT SETTING to "${newVATValue}" for "${vendorName}" in Outgoings tab (Row ${outgoingsVendorRow})`,
              matchType: "existing_job",
              jobRow: outgoingsVendorRow,
              jobName: vendorName,
              matchingDetails: {
                unmatchedJobSummary: {
                  clientName: alert.clientName,
                  jobName: vendorDesc,
                  revenue: String(expAmount),
                  startDate: expDate,
                },
              },
              matchAnalysis: {
                matchConfidence: "High",
                reasonForChoice: rationale,
                discrepancies: `Current VAT setting does not match expense items (all ${vatTreatments.length} items have VAT ${unanimousVAT === "yes" ? "applied" : "not applied"})`,
              },
              recommendedActions: [
                `write ${newVATValue} to B${outgoingsVendorRow}`,
              ],
            }];

            console.log(`  ✅ VAT mismatch resolved: recommend writing "${newVATValue}" to B${outgoingsVendorRow} for "${vendorName}"`);
            return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
          }

          // ── Other discrepancy types (not Missing cost, not VAT mismatch) ──
          if (!isMissingCost) {
            console.log(`  📊 Non-standard discrepancy type: ${activeFlags.join(", ")} — returning info message`);
            const options = [{
              optionId: 1,
              title: `MANUAL INVESTIGATION REQUIRED — ${activeFlags.join(", ")}`,
              matchType: "info",
              matchAnalysis: {
                matchConfidence: "N/A",
                reasonForChoice: `This type of discrepancy (${activeFlags.join(", ")}) requires manual investigation. The triage system handles "Missing cost" and "VAT mismatch" automatically — other discrepancy types should be reviewed directly in the sheet.`,
                discrepancies: activeFlags.join(", "),
              },
              recommendedActions: [
                `Review the expense directly in DirComp: ${expDescription || vendorDesc}`,
                `Amount: £${expAmount.toFixed(2)}, Date: ${expDate}, Source: ${source}`,
                `Discrepancy type(s): ${activeFlags.join(", ")}`,
              ],
            }];
            return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
          }

          // ── Missing cost — existing Claude path follows ────────────────────
          console.log(`  📊 Fetching Outgoings tab for expense matching...`);
          
          const outgoingsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Outgoings!A1:F112",
          });
          const outgoingsRows = outgoingsResponse.data.values || [];
          console.log(`  ✓ Loaded ${outgoingsRows.length} rows from Outgoings (rows 1-112)`);

          // Build vendor list for Claude — rows 13-110 are the contractor section
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
              0,1,2,3,4,5,6,
              32,33,34,35,36,37,38,
              41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,
              75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94
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
          
          // Compute VAT flag from actual data — don't let Claude guess
          const vatAmountRaw = parseFloat(String(alert.summary?.vatAmount || '0').replace(/[£$€,]/g, '')) || 0;
          const vatYesNo = vatAmountRaw > 0 ? 'Yes' : 'No';
          console.log(`  VAT amount: ${vatAmountRaw}, vatYesNo: ${vatYesNo}`);

          // Backend pre-analysis: identify candidate jobs with DirectCostBudget > £0.
          // Claude cannot reliably scan 250 rows — we compute candidates in code
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
                    // Round to nearest integer — handles minor rounding differences
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
                      // here — fixed 20 Aug 2026, confirmed with Paul that
                      // empty expense placeholders do carry a real expected
                      // date the same way invoice placeholders do, needed
                      // for the date-tolerance check added below.
                      childSlots.push({ label: `Row ${childSheetRow} ExpSlot${s+1}`, empty: true, date, sheetRow: childSheetRow, slotNum: s+1 });
                      continue;
                    }
                    const amtNum = parseFloat(String(amt).replace(/[£$€,]/g, '')) || 0;
                    const isAllocated = !!(appId && !appId.toUpperCase().includes('MANUAL-ENTRY'));
                    if (isAllocated) childAllocated += amtNum;
                    childSlots.push({ label: `Row ${childSheetRow} ExpSlot${s+1}`, descr, amt, amtNum, date, appId, isAllocated, empty: false, sheetRow: childSheetRow, slotNum: s+1 });
                  }
                  candidateJobs.push({
                    parentRow: parentIdx + 1, parentClient, parentJob,
                    projectCode: row[2] || '',
                    revenue: cr[32] !== undefined ? cr[32] : '',
                    projType, isRetainer: true,
                    startDate: row[37] || '', endDate: row[38] || '',
                    budget: childBudget, totalBudget: childBudget,
                    periodMultiplier, periodLabel,
                    totalAllocated: childAllocated,
                    remaining: childBudget - childAllocated,
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
                      // Same fix as the retainer branch above (20 Aug 2026).
                      slots.push({ label: `Row ${sheetRow} ExpSlot${s+1}`, empty: true, date, sheetRow, slotNum: s+1 });
                      continue;
                    }
                    const amtNum = parseFloat(String(amt).replace(/[£$€,]/g, '')) || 0;
                    const isAllocated = !!(appId && !appId.toUpperCase().includes('MANUAL-ENTRY'));
                    if (isAllocated) totalAllocated += amtNum;
                    slots.push({ label: `Row ${sheetRow} ExpSlot${s+1}`, descr, amt, amtNum, date, appId, isAllocated, empty: false, sheetRow, slotNum: s+1 });
                  }
                }
                candidateJobs.push({
                  parentRow: parentIdx + 1, parentClient, parentJob,
                  projectCode: row[2] || '',
                  revenue: row[32] !== undefined ? row[32] : '',
                  projType, isRetainer: false,
                  startDate: row[37] || '', endDate: row[38] || '',
                  budget, totalBudget: budget,
                  totalAllocated, remaining: budget - totalAllocated,
                  slots,
                });
              }
            } else { ci++; }
          }

          console.log(`  ✓ Found ${candidateJobs.length} jobs with DirectCostBudget > £0`);

          // ── TIER 1: Single job with exact amount placeholder match — skip Claude ──
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
            const row = emSlot.sheetRow;
            console.log(`  ✅ Expense Tier 1 — exact placeholder match: ${emJob.parentJob} Row ${row} ExpSlot${emSlot.slotNum}`);
            const tier1ExpOption = {
              optionId: 1,
              title: `Allocate to ${emJob.parentJob} (Row ${row}, ExpSlot${emSlot.slotNum}) — exact amount match`,
              matchType: "job",
              jobRow: row,
              jobName: emJob.parentJob,
              matchAnalysis: {
                matchConfidence: "High",
                placeholderMatch: `YES — Row ${row} ExpSlot${emSlot.slotNum} has placeholder matching amount £${expenseAmount}`,
                budgetFit: "YES",
                reasonForChoice: `Exact amount match (£${expenseAmount}) with unallocated placeholder in ${emJob.parentJob}.`,
                discrepancies: "None",
              },
              recommendedActions: [
                `Allocate expense to ${emJob.parentJob} (Row ${row}), ExpSlot${emSlot.slotNum}`,
                `write ${expenseDescription} to ${cols.d}${row}, write ${expenseAmount} to ${cols.a}${row}, write ${vatYesNo} to ${cols.v}${row}, write ${expenseDate} to ${cols.dt}${row}, write 30 to ${cols.dp}${row}, write ${alert.summary?.status || ""} to ${cols.st}${row}`,
              ],
            };
            const expSummary1 = `Expense ${expenseDescription} £${expenseAmount} — ${alert.clientName}`;
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
            console.log("  🤖 forceAI=true — using Claude for expense options");
            // Rebuild expense Claude prompt and call Claude
            const vatAmountRaw2 = parseFloat(String(alert.summary?.vatAmount || "0").replace(/[£$€,]/g, "")) || 0;
            const vatYesNo2     = vatAmountRaw2 > 0 ? "Yes" : "No";
            const expAmount2    = parseFloat(alert.summary?.amount) || 0;
            const expRef2       = alert.summary?.reference || "(unknown)";
            const expDesc2      = alert.summary?.description || "";
            const expDate2      = alert.summary?.date || "";
            const expAcctName2  = alert.summary?.accountName || "";
            const aiExpPrompt   = `You are a financial reconciliation assistant. Match this expense to an Outgoings vendor or Confirmed job slot.
Expense: £${expAmount2} | Ref: ${expRef2} | Description: ${expDesc2} | Date: ${expDate2} | Account: ${expAcctName2} | VAT: ${vatYesNo2}
Client: ${alert.clientName}
Return a JSON array of options with fields: optionId, title, matchType (job|category|info), jobRow, jobName, matchAnalysis, outgoingsData (for category matches), recommendedActions.`;
            const aiMsg2 = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 3000, messages: [{ role: "user", content: aiExpPrompt }] });
            await logClaudeUsage_(sheets, automationCommanderSheetId, alert.clientName || "", "expense", aiMsg2.usage?.input_tokens || 0, aiMsg2.usage?.output_tokens || 0).catch(() => {});
            let aiExpOptions = [];
            try {
              const raw2 = aiMsg2.content[0].type === "text" ? aiMsg2.content[0].text : "";
              const clean2 = raw2.replace(/```json/g, "").replace(/```/g, "").trim();
              const arr2 = clean2.slice(clean2.indexOf("["), clean2.lastIndexOf("]") + 1);
              aiExpOptions = JSON.parse(arr2);
              if (!Array.isArray(aiExpOptions)) aiExpOptions = [aiExpOptions];
            } catch(e) { aiExpOptions = [{ optionId: 1, title: "AI response could not be parsed", matchType: "info", recommendedActions: [] }]; }
            const aiExpSummary = alert.summary?.summary || `Expense ${expRef2} £${expAmount2}`;
            if (memoryRow) { await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(aiExpOptions) }); }
            else { await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: "expense", clientName: alert.clientName || "", alertSummary: aiExpSummary, cachedOptionsJSON: JSON.stringify(aiExpOptions), status: "cached" }); }
            return res.status(200).json({ success: true, options: aiExpOptions, alertId: alert.rowNumber });
          }
          // Noise-word stripping for fuzzy matching
          const EXP_NOISE = new Set(["ltd","limited","plc","inc","llc","llp","the","and","&",
            "group","co","corp","corporation","holdings","international","uk","us",
            "solutions","services","consulting","consultancy"]);
          const normExpWords = s => String(s||"").toLowerCase()
            .replace(/['"\-.,()]/g," ").replace(/\s+/g," ").trim()
            .split(" ").filter(w => w.length > 1 && !EXP_NOISE.has(w));

          const expDescWords = normExpWords(expenseDescription || expenseRef);

          // Build job matches first (prioritised), then vendor matches, new vendor, fallback
          const jobSysOptions = [];
          const vendorSysOptions = [];

          // ── Option type A: Match to existing Outgoings vendor ────────────────
          // Fuzzy word overlap between expense description and vendor name
          const slotColMapExp = {
            1: { d:"BX",a:"BY",v:"BZ",dt:"CA",dp:"CB",st:"CC",id:"CD" },
            2: { d:"CE",a:"CF",v:"CG",dt:"CH",dp:"CI",st:"CJ",id:"CK" },
            3: { d:"CL",a:"CM",v:"CN",dt:"CO",dp:"CP",st:"CQ",id:"CR" },
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
            const vVAT  = String(ogRows2[i]?.[1] || "").trim();
            if (!vName) continue;
            lastVendorRow2 = i;
            const vWords = normExpWords(vName);
            const overlap = expDescWords.some(w => vWords.includes(w)) || vWords.some(w => expDescWords.includes(w));
            if (overlap) vendorMatches.push({ sheetRow: i + 1, vendorName: vName, chargesVAT: vVAT });
          }
          const nextBlankOGRow2 = lastVendorRow2 < 109 ? lastVendorRow2 + 2 : null;
          console.log(`  Outgoings vendor matches: ${vendorMatches.length}`);

          for (const vm of vendorMatches.slice(0, 3)) {
            // Find the best available expense slot for this vendor across candidateJobs
            // For outgoings match, we use outgoingsData block — no slot write needed
            vendorSysOptions.push({
              optionId: vendorSysOptions.length + 1,
              title: `Assign to OUTGOINGS vendor "${vm.vendorName}" (Row ${vm.sheetRow})`,
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
                placeholderMatch: "N/A — Outgoings vendor assignment",
                budgetFit: "YES",
                reasonForChoice: `Vendor name "${vm.vendorName}" matches expense description word(s). VAT: ${vm.chargesVAT}.`,
                discrepancies: "None",
              },
              outgoingsData: {
                categoryName: vm.vendorName,
                expenseMonth: expenseDate ? expenseDate.slice(3) : "",
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
          // Extract the bracketed portion to check for a client-name match — vendor name alone
          // (before the bracket) is not a reliable client signal.
          const expBracketMatch = (expenseDescription || "").match(/\(([^)]*)\)/);
          const expBracketWords = expBracketMatch ? normExpWords(expBracketMatch[1]) : [];

          // Date tolerance: ±expenseMonthsTolerance months from expense date —
          // added 20 Aug 2026, prompted by Paul after the invoice-side date
          // fix. expenseMonthsTolerance was already a configured tolerance
          // value (default 1 month) but was never actually used in this
          // matching logic at all — nothing here previously compared dates.
          // Confirmed with Paul that empty expense placeholder slots DO
          // carry a real expected date the same way invoice placeholders
          // do, which is what makes this comparison meaningful (the empty-
          // slot date was also being silently dropped before this same
          // change — see candidateJobs construction above). Reuses the
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
            const row  = availSlot.sheetRow;
            // Total allocated (real only) + this expense
            const realAllocated = job.slots.filter(s => !s.empty && s.isAllocated).reduce((sum, s) => sum + s.amtNum, 0);
            const newTotal = realAllocated + expenseAmount;
            const budgetNum = parseFloat(String(job.totalBudget||"0").replace(/[£$€,]/g,"")) || 0;
            const budgetFit = budgetNum > 0 ? (newTotal <= budgetNum ? "YES" : `OVER by £${(newTotal-budgetNum).toFixed(2)}`) : "UNKNOWN";
            const budgetFits = budgetNum === 0 || newTotal <= budgetNum; // no known budget = don't penalise
            // Exact client match: bracketed text exactly equals the job's client name
            const bracketText = expBracketMatch ? expBracketMatch[1].trim().toLowerCase() : "";
            const isExactClient = !!bracketText && bracketText === String(job.parentClient||"").trim().toLowerCase();
            const dateMatch = dateWithinToleranceExp(availSlot.date);
            jobDescMatches.push({ job, availSlot, cols, row, realAllocated, newTotal, budgetFit, budgetFits, isExactClient, clientOverlap, dateMatch });
          }
          console.log(`  Confirmed job description matches: ${jobDescMatches.length}`);

          // Rank: budget fit → exact client match → partial client overlap → most recent job first
          const parseRankDateExp = (d) => {
            if (!d) return null;
            const MONTHS_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
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
            // never actually used here — added 20 Aug 2026, prompted by
            // Paul asking whether partial client matches are considered on
            // the invoice side. This was sitting right there, unused.
            if (a.clientOverlap !== b.clientOverlap) return a.clientOverlap ? -1 : 1;
            // Expense date within tolerance of the slot's expected date —
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

          for (const jm of jobDescMatches.slice(0, 3)) {
            const { job, availSlot, cols, row, realAllocated, newTotal, budgetFit, dateMatch } = jm;
            const jobClientLabel = job.parentClient ? `${job.parentClient} — ${job.parentJob}` : job.parentJob;
            jobSysOptions.push({
              optionId: jobSysOptions.length + 1,
              title: `Allocate to ${jobClientLabel} slot ${availSlot.slotNum} (Row ${row}) — job name match`,
              matchType: "job",
              jobRow: row,
              jobName: job.parentJob,
              targetRowNum: row,
              targetSlotType: "expense",
              targetSlotNum: availSlot.slotNum,
              matchingDetails: {
                // Same bug as the invoice side (fixed 20 Aug 2026, confirmed
                // during Paul's review of expense-matching for parity) —
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
                // tolerance of the slot's expected date — added 20 Aug
                // 2026, mirroring the invoice side's confidence logic
                // exactly (previously hardcoded "Medium" regardless of date
                // proximity, since no date comparison existed at all).
                matchConfidence: dateMatch ? "High" : "Medium",
                placeholderMatch: availSlot.empty ? `YES — Row ${row} ExpSlot${availSlot.slotNum} is empty` : `PARTIAL — unallocated slot available`,
                budgetFit,
                dateRangeMatch: dateMatch === null ? "UNKNOWN" : (dateMatch ? "YES" : "PARTIAL — outside date tolerance"),
                reasonForChoice: `Job name "${job.parentJob}" matches expense description word(s). Currently allocated: £${realAllocated.toFixed(2)}, this expense adds £${expenseAmount.toFixed(2)} → new total £${newTotal.toFixed(2)} vs budget £${job.totalBudget}.`,
                discrepancies: budgetFit.startsWith("OVER") ? `Budget would be exceeded by £${(newTotal-(parseFloat(String(job.totalBudget||"0").replace(/[£$€,]/g,""))||0)).toFixed(2)}` : "None",
              },
              recommendedActions: [
                `Allocate expense to "${job.parentJob}" (Row ${row}), ExpSlot${availSlot.slotNum}`,
                `write ${expenseDescription || expenseRef} to ${cols.d}${row}, write ${expenseAmount} to ${cols.a}${row}, write ${vatYesNo} to ${cols.v}${row}, write ${expenseDate} to ${cols.dt}${row}, write 30 to ${cols.dp}${row}, write ${alert.summary?.status || ""} to ${cols.st}${row}`,
              ],
            });
          }

          // ── Option type C: Create new Outgoings vendor ───────────────────────
          const guessedVendorName = (expenseAccountName || expenseDescription || expenseRef || "Unknown vendor").trim();
          if (nextBlankOGRow2) {
            vendorSysOptions.push({
              optionId: vendorSysOptions.length + 1,
              title: `CREATE NEW Outgoings vendor "${guessedVendorName}" at row ${nextBlankOGRow2}`,
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
                placeholderMatch: "N/A — new vendor row",
                budgetFit: "YES",
                reasonForChoice: `No existing Outgoings vendor matched this expense. A new vendor row will be created at row ${nextBlankOGRow2} using the expense account name/description as the vendor name. Review the vendor name before accepting.`,
                discrepancies: "New vendor — confirm name and VAT setting are correct",
              },
              outgoingsData: {
                categoryName: guessedVendorName,
                expenseMonth: expenseDate ? expenseDate.slice(3) : "",
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

          // ── Option type D: Manual investigation fallback ─────────────────────
          vendorSysOptions.push({
            optionId: vendorSysOptions.length + 1,
            title: "MANUAL INVESTIGATION REQUIRED — no confident automatic match found",
            matchType: "info",
            matchAnalysis: {
              matchConfidence: "N/A",
              placeholderMatch: "N/A",
              budgetFit: "N/A",
              reasonForChoice: "The system could not identify a high-confidence match for this expense. Review manually.",
              discrepancies: `Expense: £${expenseAmount}, date: ${expenseDate}, description: ${expenseDescription || expenseRef}`,
            },
            recommendedActions: [
              `Review expense manually: £${expenseAmount} | ${expenseDate} | ${expenseDescription || expenseRef}`,
              "Assign to an appropriate Outgoings vendor or Confirmed job slot",
            ],
          });

          // Assemble: job matches first (prioritised), then outgoings vendor matches, then new vendor, then fallback
          const sysOptions = [...jobSysOptions, ...vendorSysOptions];
          // Renumber optionIds
          const options = sysOptions.map((o, i) => ({ ...o, optionId: i + 1 }));
          console.log(`  ✅ System-generated ${options.length} expense options`);

          // Attach jobRowsData for spreadsheet-style display — only for job matches
          // (Outgoings vendor/category matches don't have a Confirmed job row to show)
          const expJobRowCache = new Map();
          for (const opt of options) {
            if (opt.matchType !== "job" || !opt.jobRow) continue;
            if (!expJobRowCache.has(opt.jobRow)) {
              const highlightSlot = (opt.targetSlotType && opt.targetSlotNum)
                ? { type: opt.targetSlotType, rowNum: opt.targetRowNum || opt.jobRow, slotNum: opt.targetSlotNum }
                : null;
              expJobRowCache.set(opt.jobRow, await fetchJobRowsForDisplay(sheets, alert.clientId, "Confirmed", opt.jobRow, highlightSlot, sharedData));
            }
            opt.jobRowsData = expJobRowCache.get(opt.jobRow);
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
          });
        }
        
        // Handle CRM alerts        // Handle CRM alerts
        if (alert.type === "crm" || alert.sheetName === "CRMComp") {
          console.log(`  📊 Analyzing CRM alert...`);

          const alertType = alert.alertType || alert.flagType || "";

          // App discrepancy: job exists in sheet (Confirmed/Pipeline) but not in CRM.
          // The only valid actions are: ignore the discrepancy, or delete the job from the sheet.
          // We never suggest creating a job — Claude is not needed here.
          if (alertType === "crmConfAppDiscr" || alertType === "crmPipeAppDiscr") {
            const tabName = alertType === "crmPipeAppDiscr" ? "Pipeline" : "Confirmed";
            const src = alert.data?.sheetData || [];
            // sheetData: EF=client[0], EG=job[1], EH=code[2], EI=revenue[3], EJ=dirCosts[4], EK=start[5], EL=end[6], EM=likelihood[7]
            const client      = src[0] || alert.clientName || "";
            const jobName     = src[1] || "";
            const projectCode = src[2] || "";
            const revenue     = src[3] || "";
            const dirCosts    = src[4] || "";
            const startDate   = src[5] || "";
            const endDate     = src[6] || "";
            const likelihood  = src[7] || "";
            const jobDesc = [client, jobName, projectCode].filter(Boolean).join(" — ");

            let options = [];
            let jobRow = null;      // declared here so both branches can set it and the DD read below can use it
            let copiedToConf = "";

            if (alert.subType === "field_mismatch") {
              // Job exists in both sheet and CRM but fields differ
              // crmData: EU=code[0], EV=client[1], EW=job[2], EX=revenue[3], EY=dirCosts[4], EZ=start[5], FA=end[6], FB=likelihood[7]
              const crmSrc = alert.data?.crmData || [];
              const crmCode      = crmSrc[0] || "";
              const crmClient    = crmSrc[1] || "";
              const crmJob       = crmSrc[2] || "";
              const crmRevenue   = crmSrc[3] || "";
              const crmDirCosts  = crmSrc[4] || "";
              const crmStart     = crmSrc[5] || "";
              const crmEnd       = crmSrc[6] || "";
              const crmLikely    = crmSrc[7] || "";

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
              const codeToFind   = (projectCode || crmCode).toLowerCase();
              const clientToFind = (client || crmClient).toLowerCase();
              const jobToFind    = (jobName || crmJob).toLowerCase();
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
                { name: "Client name",  sheet: client,    crm: crmClient,   col: "A",  writable: false },
                { name: "Job name",     sheet: jobName,   crm: crmJob,      col: "B",  writable: false },
                { name: "Revenue",      sheet: revenue,   crm: crmRevenue,  col: "AG", writable: true  },
                { name: "Direct costs", sheet: dirCosts,  crm: crmDirCosts, col: "AH", writable: true  },
                { name: "Start date",   sheet: startDate, crm: crmStart,    col: "AL", writable: true  },
                { name: "End date",     sheet: endDate,   crm: crmEnd,      col: "AM", writable: true  },
                { name: "% Likelihood", sheet: likelihood,crm: crmLikely,   col: "AN", writable: tabName === "Pipeline" },
              ];

              for (const fc of APP_FIELD_CONFIG) {
                if (!mismatchFields.includes(fc.name)) continue;
                if (fc.writable && jobRow) {
                  options.push({
                    optionId: options.length + 1,
                    title: `UPDATE ${client} — ${jobName} — ${fc.name} to match CRM: "${fc.crm}"`,
                    matchType: "existing_job", jobRow, jobName,
                    matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode, revenue, startDate, endDate, likelihood } },
                    matchAnalysis: {
                      matchConfidence: "High",
                      reasonForChoice: `${fc.name} mismatch. ${tabName}: "${fc.sheet}" vs CRM: "${fc.crm}"`,
                      discrepancies: `${fc.name}: ${tabName}="${fc.sheet}" vs CRM="${fc.crm}"`,
                    },
                    recommendedActions: [
                      `Update ${fc.name} in ${tabName} tab (row ${jobRow}) to match CRM value "${fc.crm}"`,
                      `Write "${fc.crm}" to ${fc.col}${jobRow}`,
                    ],
                  });
                } else {
                  options.push({
                    optionId: options.length + 1,
                    title: `REVIEW ${client} — ${jobName} — ${fc.name} mismatch — manual update required`,
                    matchType: "info", jobName,
                    matchAnalysis: {
                      matchConfidence: "N/A",
                      reasonForChoice: `${fc.name} differs: ${tabName}="${fc.sheet}" vs CRM="${fc.crm}". Cannot update automatically.`,
                    },
                    recommendedActions: [ `Review and correct ${fc.name} manually — ${tabName}: "${fc.sheet}", CRM: "${fc.crm}"` ],
                  });
                }
              }
              options.push({
                optionId: options.length + 1,
                title: `IGNORE — ${client} — ${jobName} — CRM data is wrong or discrepancy can be disregarded`,
                matchType: "ignore", jobRow: jobRow || alert.rowNumber, jobName,
                matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode, revenue, startDate, endDate, likelihood } },
                recommendedActions: [ `Mark this field mismatch as ignored — no changes will be made` ],
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
                  const codeToFind2   = (projectCode || "").toLowerCase();
                  const clientToFind2 = (client || "").toLowerCase();
                  const jobToFind2    = (jobName || "").toLowerCase();
                  for (let tr2 = tabName === "Pipeline" ? 5 : 0; tr2 < tabSearchRows.length; tr2++) {
                    const r2 = tabSearchRows[tr2] || [];
                    const rCode2   = String(r2[2] || "").trim().toLowerCase();
                    const rClient2 = String(r2[0] || "").trim().toLowerCase();
                    const rJob2    = String(r2[1] || "").trim().toLowerCase();
                    if (codeToFind2 && rCode2 === codeToFind2) { jobRow = tr2 + 1; break; }
                    if (!codeToFind2 && rClient2 === clientToFind2 && rJob2 === jobToFind2) { jobRow = tr2 + 1; break; }
                  }
                } catch(e) { console.log("  not_found tab search failed:", e.message); }
              }

              options = [
                {
                  optionId: 1,
                  title: `IGNORE — "${jobDesc}" is legitimate and CRM discrepancy can be disregarded`,
                  matchType: "ignore",
                  jobRow: jobRow || alert.rowNumber, jobName,
                  matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode, revenue, startDate, endDate, likelihood } },
                  recommendedActions: [
                    `Verify that "${jobDesc}" is intentionally absent from the CRM`,
                    `If confirmed, mark this alert as ignored to prevent it recurring`,
                  ],
                },
                {
                  optionId: 2,
                  title: `DELETE — Remove "${jobDesc}" from ${tabName} tab as it should not exist`,
                  matchType: "delete",
                  jobRow: jobRow || alert.rowNumber, jobName,
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
              } catch(e) { console.log("  copiedToConf read failed:", e.message); }
            }

            console.log(`  ✅ App discr (${alert.subType || "not_found"}) — ${options.length} options for ${jobDesc}`);

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
            const crmArr  = alert.data?.crmData  || [];
            const shtArr  = alert.data?.sheetData || [];

            // CRM layout: [0]=client, [1]=job, [2]=code, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
            // Sheet layout: [0]=code, [1]=client, [2]=job, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
            const crmClient    = crmArr[0] || "";
            const crmJob       = crmArr[1] || "";
            const crmCode      = crmArr[2] || "";
            const crmRevenue   = crmArr[3] || "";
            const crmDirCosts  = crmArr[4] || "";
            const crmStart     = crmArr[5] || "";
            const crmEnd       = crmArr[6] || "";
            const crmLikely    = crmArr[7] || "";

            const shtCode      = shtArr[0] || "";
            const shtClient    = shtArr[1] || "";
            const shtJob       = shtArr[2] || "";
            const shtRevenue   = shtArr[3] || "";
            const shtDirCosts  = shtArr[4] || "";
            const shtStart     = shtArr[5] || "";
            const shtEnd       = shtArr[6] || "";
            const shtLikely    = shtArr[7] || "";

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
            const jobToFind    = (shtJob    || crmJob).toLowerCase();

            for (let tr = tabStartRow === 6 ? 5 : 0; tr < tabRows.length; tr++) {
              const r = tabRows[tr] || [];
              const rCode   = String(r[2]  || "").trim().toLowerCase();
              const rClient = String(r[0]  || "").trim().toLowerCase();
              const rJob    = String(r[1]  || "").trim().toLowerCase();
              // Match by project code first, then client+job
              if (codeToFind && rCode === codeToFind) { jobRow = tr + 1; copiedToConf = String(r[107] || "").trim(); break; }
              if (!codeToFind && rClient === clientToFind && rJob === jobToFind) { jobRow = tr + 1; copiedToConf = String(r[107] || "").trim(); break; }
            }

            const rowRef = jobRow ? ` (${tabName} row ${jobRow})` : "";
            const jobLabel = `${shtClient || crmClient} — ${shtJob || crmJob}${crmCode ? ` (${crmCode})` : ""}`;

            // Build one option per mismatched field
            const mismatchFields = alert.mismatchFields || [];
            let options = [];

            // Field config: [flagName, crmValue, sheetValue, tabCol, isWritable, note]
            const FIELD_CONFIG = [
              { name: "Client name",    crm: crmClient,   sheet: shtClient,   col: "A",  writable: false },
              { name: "Job name",       crm: crmJob,      sheet: shtJob,      col: "B",  writable: false },
              { name: "Revenue",        crm: crmRevenue,  sheet: shtRevenue,  col: "AG", writable: true  },
              { name: "Direct costs",   crm: crmDirCosts, sheet: shtDirCosts, col: "AH", writable: true  },
              { name: "Start date",     crm: crmStart,    sheet: shtStart,    col: "AL", writable: true  },
              { name: "End date",       crm: crmEnd,      sheet: shtEnd,      col: "AM", writable: true  },
              { name: "% Likelihood",   crm: crmLikely,   sheet: shtLikely,   col: "AN", writable: tabName === "Pipeline" },
            ];

            for (let fi = 0; fi < FIELD_CONFIG.length; fi++) {
              const fc = FIELD_CONFIG[fi];
              if (!mismatchFields.includes(fc.name)) continue;

              if (fc.writable && jobRow) {
                options.push({
                  optionId: options.length + 1,
                  title: `UPDATE ${shtClient || crmClient} — ${shtJob || crmJob} — ${fc.name} to match CRM: "${fc.crm}"`,
                  matchType: "existing_job",
                  jobRow,
                  jobName: shtJob || crmJob,
                  matchingDetails: {
                    unmatchedJobSummary: { clientName: shtClient || crmClient, jobName: shtJob || crmJob, projectCode: shtCode || crmCode },
                  },
                  matchAnalysis: {
                    matchConfidence: "High",
                    reasonForChoice: `${fc.name} differs between CRM and ${tabName} tab. CRM value: "${fc.crm}". ${tabName} value: "${fc.sheet}". Updating ${tabName} to match CRM.`,
                    discrepancies: `${fc.name} mismatch: CRM="${fc.crm}" vs ${tabName}="${fc.sheet}"`,
                  },
                  recommendedActions: [
                    `Update ${fc.name} in ${tabName} tab${rowRef} to match CRM value "${fc.crm}"`,
                    `Write "${fc.crm}" to ${fc.col}${jobRow} (${fc.name})`,
                  ],
                });
              } else if (!fc.writable) {
                options.push({
                  optionId: options.length + 1,
                  title: `REVIEW ${shtClient || crmClient} — ${shtJob || crmJob} — ${fc.name} mismatch — manual update required`,
                  matchType: "info",
                  jobName: shtJob || crmJob,
                  matchAnalysis: {
                    matchConfidence: "N/A",
                    reasonForChoice: `${fc.name} differs between CRM and ${tabName} tab but cannot be updated automatically. CRM: "${fc.crm}". ${tabName}: "${fc.sheet}". Review both systems and correct the one that is wrong.`,
                    discrepancies: `${fc.name} mismatch: CRM="${fc.crm}" vs ${tabName}="${fc.sheet}"`,
                  },
                  recommendedActions: [
                    `Review ${fc.name}: CRM has "${fc.crm}", ${tabName} tab has "${fc.sheet}"`,
                    `Correct the wrong value in whichever system is out of date`,
                  ],
                  explanation: `${fc.name} cannot be updated automatically — review both systems and correct manually.`,
                });
              } else if (fc.writable && !jobRow) {
                options.push({
                  optionId: options.length + 1,
                  title: `REVIEW ${shtClient || crmClient} — ${shtJob || crmJob} — ${fc.name} mismatch — job row not found in ${tabName}`,
                  matchType: "info",
                  jobName: shtJob || crmJob,
                  matchAnalysis: {
                    matchConfidence: "Low",
                    reasonForChoice: `${fc.name} mismatch detected but could not locate the job row in ${tabName} tab by project code or client+job name. Manual review required.`,
                    discrepancies: `${fc.name}: CRM="${fc.crm}" vs ${tabName}="${fc.sheet}"`,
                  },
                  recommendedActions: [
                    `Locate "${jobLabel}" in ${tabName} tab and update ${fc.name} from "${fc.sheet}" to "${fc.crm}"`,
                  ],
                  explanation: `Job row could not be located automatically — update manually.`,
                });
              }
            }

            // Always add an ignore option at the end
            options.push({
              optionId: options.length + 1,
              title: `IGNORE — ${shtClient || crmClient} — ${shtJob || crmJob} — CRM data is wrong or discrepancy can be disregarded`,
              matchType: "ignore",
              jobRow: jobRow || alert.rowNumber,
              jobName: shtJob || crmJob,
              matchingDetails: {
                unmatchedJobSummary: { clientName: shtClient || crmClient, jobName: shtJob || crmJob, projectCode: shtCode || crmCode },
              },
              recommendedActions: [
                `Mark this discrepancy as ignored — no changes will be made to either system`,
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
              } catch(e) { console.log("  copiedToConf read failed:", e.message); }
            }

            console.log(`  ✅ Field mismatch — ${mismatchFields.join(", ")} — returning ${options.length} options for ${jobLabel}`);

            // Inject Pipeline-specific fields onto options
            if (tabName === "Pipeline" && copiedToConf !== undefined) {
              options = options.map(o => ({ ...o, copiedToConf }));
            }

            // Attach jobRowsData for spreadsheet-style display
            if (jobRow) {
              const mismatchJobRows = await fetchJobRowsForDisplay(sheets, alert.clientId, tabName, jobRow, null, sharedData);
              options = options.map(o => ({ ...o, jobRowsData: mismatchJobRows }));
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
          // If forceAI is set, skip system options — return a simple AI-generated response
          if (req.body.forceAI === true) {
            console.log("  🤖 forceAI=true — using Claude for CRM dashboard options");
            const crmModeAI = await getCRMMatchingMode(sheets, alert.masterSheetId || alert.clientId);
            const crmTabAI  = crmModeAI === "Pipeline" ? "Pipeline" : "Confirmed";
            const crmSrcAI  = alert.data?.crmData || [];
            const aiCrmPrompt = `You are a financial reconciliation assistant. A CRM job is missing from the ${crmTabAI} tab. Generate options: IGNORE or CREATE NEW job. CRM data: Client=${crmSrcAI[0]||""}, Job=${crmSrcAI[1]||""}, Code=${crmSrcAI[2]||""}, Revenue=${crmSrcAI[3]||""}, Start=${crmSrcAI[5]||""}, End=${crmSrcAI[6]||""}. Return JSON array with optionId, title, matchType (ignore|create_new), matchingDetails, newJobData (for create_new), recommendedActions.`;
            const aiCrmMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 2000, messages: [{ role: "user", content: aiCrmPrompt }] });
            await logClaudeUsage_(sheets, automationCommanderSheetId, alert.clientName || "", "crm", aiCrmMsg.usage?.input_tokens || 0, aiCrmMsg.usage?.output_tokens || 0).catch(() => {});
            let aiCrmOptions = [];
            try {
              const rawCrm = aiCrmMsg.content[0].type === "text" ? aiCrmMsg.content[0].text : "";
              const cleanCrm = rawCrm.replace(/```json/g,"").replace(/```/g,"").trim();
              const arrCrm = cleanCrm.slice(cleanCrm.indexOf("["), cleanCrm.lastIndexOf("]")+1);
              aiCrmOptions = JSON.parse(arrCrm);
              if (!Array.isArray(aiCrmOptions)) aiCrmOptions = [aiCrmOptions];
            } catch(e) { aiCrmOptions = [{ optionId:1, title:"AI response could not be parsed", matchType:"info", recommendedActions:[] }]; }
            const aiCrmSummary = `CRM ${alert.alertType||""} ${crmSrcAI[0]||""} ${crmSrcAI[1]||""}`.trim();
            if (memoryRow) { await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(aiCrmOptions) }); }
            else { await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: alert.alertType||"crm", clientName: alert.clientName||"", alertSummary: aiCrmSummary, cachedOptionsJSON: JSON.stringify(aiCrmOptions), status:"cached" }); }
            return res.status(200).json({ success: true, options: aiCrmOptions, alertId: alert.rowNumber });
          }
          // A job exists in CRM but is absent from Pipeline/Confirmed.
          // Options: Ignore, or Create new job in the sheet.
          const crmMode = await getCRMMatchingMode(sheets, alert.masterSheetId || alert.clientId);
          console.log(`  Mode: ${crmMode}`);
          const dashTabName = crmMode === "Pipeline" ? "Pipeline" : "Confirmed";

          // Extract CRM data — layout: [0]=client,[1]=job,[2]=code,[3]=revenue,[4]=dirCosts,[5]=start,[6]=end,[7]=likelihood
          const dashCrmArr = alert.data?.crmData || [];
          const dashShtArr = alert.data?.sheetData || [];
          const dashClient   = dashCrmArr[0] || dashShtArr[1] || "";
          const dashJob      = dashCrmArr[1] || dashShtArr[2] || "";
          const dashCode     = dashCrmArr[2] || dashShtArr[0] || "";
          const dashRevenue  = dashCrmArr[3] || dashShtArr[3] || "";
          const dashDirCosts = dashCrmArr[4] || dashShtArr[4] || "";
          const dashStart    = dashCrmArr[5] || dashShtArr[5] || "";
          const dashEnd      = dashCrmArr[6] || dashShtArr[6] || "";
          const dashLikely   = dashCrmArr[7] || dashShtArr[7] || "";
          const dashJobDesc  = [dashClient, dashJob, dashCode].filter(Boolean).join(" — ");

          const dashOptions = [
            {
              optionId: 1,
              title: `IGNORE — discrepancy for "${dashJobDesc || "unknown"}" can be disregarded`,
              matchType: "ignore",
              jobRow: alert.rowNumber,
              jobName: dashJob,
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
              title: `CREATE NEW job "${dashJobDesc || "unknown"}" in ${dashTabName} tab from CRM data`,
              matchType: "create_new",
              jobRow: null,
              jobName: dashJob,
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
                discrepancies: "New job — confirm all fields before accepting",
              },
              newJobData: {
                clientName:      dashClient,
                jobName:         dashJob,
                projectCode:     dashCode,
                revenue:         dashRevenue,
                directCostBudget: dashDirCosts,
                startDate:       dashStart,
                endDate:         dashEnd,
                likelihood:      dashLikely,
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
          });
        }
        
        // Default: Handle invoice alerts        // Default: Handle invoice alerts with flag-based branching
        // flags slice = row.slice(18, 25) = cols S:Y (indices 0-6 within slice)
        // S(0)=Missing invoice, T(1)=Client mismatch, U(2)=Inv amt mismatch,
        // V(3)=Sent date mismatch, W(4)=Duplicate inv no (skip), X(5)=Fully paid on mismatch,
        // Y(6)=Status mismatch
        const invFlags = alert.data?.flags || [];
        const isMissingInvoice  = String(invFlags[0] || "").trim() === "1";
        const isInvAmtMismatch  = String(invFlags[2] || "").trim() === "1";
        const invFlagNames = ["Missing invoice","Client mismatch","Inv amt mismatch",
          "Sent date mismatch",null,"Fully paid on mismatch","Status mismatch"];
        const activeInvFlags = invFlags.map((v,i) => String(v||"").trim()==="1" && invFlagNames[i] ? invFlagNames[i] : null).filter(Boolean);

        // accounting slice = cols A:K (indices 0-10)
        const invAccounting = alert.data?.accounting || [];
        const invConfirmed  = alert.data?.confirmed  || [];
        const invoiceNo      = String(invAccounting[5] || "").trim();   // F
        const grossAmount    = parseFloat(String(invAccounting[2] || "0").replace(/[£$€,]/g, "")) || 0; // C
        const totalExclVAT   = parseFloat(String(invAccounting[3] || "0").replace(/[£$€,]/g, "")) || 0; // D
        const vatIncluded    = parseFloat(String(invAccounting[4] || "0").replace(/[£$€,]/g, "")) || 0; // E
        const invClient      = String(invAccounting[0] || "").trim();   // A
        const invJob         = String(invAccounting[1] || "").trim();   // B
        const invSentDate    = String(invAccounting[6] || "").trim();   // G
        const invStatus      = String(invAccounting[9] || "").trim();   // J
        const dashboardTotal = parseFloat(String(invConfirmed[2] || "0").replace(/[£$€,]/g, "")) || 0; // O

        console.log(`  Invoice flags: ${activeInvFlags.join(", ") || "unknown"}`);
        console.log(`  Invoice #${invoiceNo}, gross=£${grossAmount}, exclVAT=£${totalExclVAT}, VAT=£${vatIncluded}, dashboardTotal=£${dashboardTotal}`);

        // ── "Inv amt mismatch" handling ────────────────────────────────────
        if (isInvAmtMismatch && !isMissingInvoice) {
          console.log(`  📊 Invoice amount mismatch — analysing...`);

          // Step 1: Find the job in Confirmed tab by invoice number
          // Search AQ(42), AX(49), BE(56) for the invoice number
          let invConfirmedRows = [];
          if (sharedData && sharedData.confirmedDataWide) {
            invConfirmedRows = sharedData.confirmedDataWide;
            console.log(`  ✓ Used cached Confirmed data to find invoice #${invoiceNo}`);
          } else {
            console.log(`  Fetching Confirmed tab to find invoice #${invoiceNo}...`);
            const invConfirmedResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: "Confirmed!A1:BH5000",
            });
            invConfirmedRows = invConfirmedResp.data.values || [];
          }

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

          if (!matchedJob) {
            // Invoice not found in Confirmed — pass to Claude with just what we know
            console.log(`  Invoice #${invoiceNo} not found in Confirmed tab — falling through to Claude`);
          } else {
            const jobClient     = String(matchedJob[0]  || "").trim();  // A
            const jobName       = String(matchedJob[1]  || "").trim();  // B
            const jobCode       = String(matchedJob[2]  || "").trim();  // C
            const jobRevenue    = String(matchedJob[32] || "").trim();  // AG
            const jobVAT        = String(matchedJob[34] || "").trim();  // AI — "Yes" or "No"
            const jobType       = String(matchedJob[35] || "").trim();  // AJ — Project / Retainer
            const jobStart      = String(matchedJob[37] || "").trim();  // AL
            const jobEnd        = String(matchedJob[38] || "").trim();  // AM
            const jobVATYes     = jobVAT.toLowerCase() === "yes";
            const isRetainer    = jobType.toLowerCase().includes("retainer");

            // Existing invoice slots
            const slot1 = { ref: String(matchedJob[42]||""), amt: String(matchedJob[41]||""), sent: String(matchedJob[43]||""), status: String(matchedJob[45]||"") };
            const slot2 = { ref: String(matchedJob[49]||""), amt: String(matchedJob[48]||""), sent: String(matchedJob[50]||""), status: String(matchedJob[52]||"") };
            const slot3 = { ref: String(matchedJob[56]||""), amt: String(matchedJob[55]||""), sent: String(matchedJob[57]||""), status: String(matchedJob[59]||"") };

            console.log(`  Found invoice in Confirmed at slot ${matchedSlot}: ${jobClient} — ${jobName}, VAT=${jobVAT}, type=${jobType}`);

            // Step 2: VAT scenario detection
            const epsilon = 0.01;

            // Scenario A: Invoice sent WITH VAT, job marked as NO VAT
            // Evidence: VAT > 0 AND total excl VAT ≈ dashboard total
            let vatMismatchOptions = null;
            let vatMismatchNewValue = null;
            if (vatIncluded > 0 && !jobVATYes && Math.abs(totalExclVAT - dashboardTotal) < epsilon) {
              console.log(`  VAT scenario A: invoice sent WITH VAT (£${vatIncluded}) but job marked NO VAT`);
              const vatColA = `AI${matchedRowNum}`;
              const options = [
                {
                  optionId: 1,
                  title: `Update job VAT setting to "Yes" — invoice was sent WITH VAT (£${vatIncluded.toFixed(2)})`,
                  matchType: "existing_job",
                  discrepancyType: "inv_vat_mismatch",
                  jobRow: matchedRowNum,
                  jobName,
                  explanation: `Invoice #${invoiceNo} was sent including VAT (£${vatIncluded.toFixed(2)}), confirming the job should be marked "Yes VAT". The dashboard total (£${dashboardTotal.toFixed(2)}) matches the invoice amount excluding VAT (£${totalExclVAT.toFixed(2)}), confirming the mismatch.`,
                  jobDetails: {
                    clientName: jobClient, jobName, projectCode: jobCode, revenue: jobRevenue,
                    vatSetting: jobVAT, jobType: isRetainer ? "Retainer" : "Project",
                    startDate: jobStart, endDate: jobEnd,
                    slot1: `${slot1.ref||"(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}`.trim(),
                    slot2: `${slot2.ref||"(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}`.trim(),
                    slot3: `${slot3.ref||"(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`.trim(),
                  },
                  vatUpdate: { cell: vatColA, newValue: "Yes", currentValue: jobVAT },
                  recommendedActions: [`write Yes to ${vatColA}`], // will be replaced below with all-rows update
                },
                {
                  optionId: 2,
                  title: `MANUAL INVESTIGATION — invoice was sent incorrectly and needs re-issuing without VAT`,
                  matchType: "info",
                  discrepancyType: "inv_vat_mismatch",
                  explanation: `If the invoice was sent in error with VAT and should have been sent without VAT, the invoice needs to be re-issued excluding VAT and the job VAT setting should remain "No".`,
                  jobDetails: {
                    clientName: jobClient, jobName, projectCode: jobCode, revenue: jobRevenue,
                    vatSetting: jobVAT, startDate: jobStart, endDate: jobEnd,
                    slot1: `${slot1.ref||"(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}`.trim(),
                    slot2: `${slot2.ref||"(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}`.trim(),
                    slot3: `${slot3.ref||"(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`.trim(),
                  },
                  recommendedActions: [`Re-issue invoice #${invoiceNo} excluding VAT, then mark as resolved`],
                },
              ];
              vatMismatchOptions = options; vatMismatchNewValue = "Yes";
            }

            // Scenario B: Invoice sent WITHOUT VAT, job marked to INCLUDE VAT
            // Evidence: VAT = 0 AND gross amount × 1.2 ≈ dashboard total
            // (InvComp calculates dashboard total as slot amount × 1.2 when job VAT = Yes)
            if (vatIncluded === 0 && jobVATYes && Math.abs(grossAmount * 1.2 - dashboardTotal) < epsilon) {
              console.log(`  VAT scenario B: invoice sent WITHOUT VAT (£${grossAmount}) but job marked YES VAT — dashboard shows £${dashboardTotal} (= £${grossAmount} × 1.2)`);
              const vatColB = `AI${matchedRowNum}`;
              const options = [
                {
                  optionId: 1,
                  title: `Update job VAT setting to "No" — invoice was sent WITHOUT VAT (£${grossAmount.toFixed(2)})`,
                  matchType: "existing_job",
                  discrepancyType: "inv_vat_mismatch",
                  jobRow: matchedRowNum,
                  jobName,
                  explanation: `Invoice #${invoiceNo} was sent without VAT (VAT = £0.00), but the job is marked "Yes VAT". The dashboard shows £${dashboardTotal.toFixed(2)} (= £${grossAmount.toFixed(2)} × 1.2), but the invoice was sent for £${grossAmount.toFixed(2)} with no VAT. Updating the job VAT setting to "No" will resolve the discrepancy.`,
                  jobDetails: {
                    clientName: jobClient, jobName, projectCode: jobCode, revenue: jobRevenue,
                    vatSetting: jobVAT, jobType: isRetainer ? "Retainer" : "Project",
                    startDate: jobStart, endDate: jobEnd,
                    slot1: `${slot1.ref||"(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}`.trim(),
                    slot2: `${slot2.ref||"(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}`.trim(),
                    slot3: `${slot3.ref||"(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`.trim(),
                  },
                  vatUpdate: { cell: vatColB, newValue: "No", currentValue: jobVAT },
                  recommendedActions: [`write No to ${vatColB}`], // will be replaced below with all-rows update
                },
                {
                  optionId: 2,
                  title: `MANUAL INVESTIGATION — invoice was sent incorrectly and needs re-issuing with VAT`,
                  matchType: "info",
                  discrepancyType: "inv_vat_mismatch",
                  explanation: `If the invoice was sent in error without VAT and should have been sent with VAT, the invoice needs to be re-issued including VAT (£${(grossAmount * 1.2).toFixed(2)} total) and the job VAT setting should remain "Yes".`,
                  jobDetails: {
                    clientName: jobClient, jobName, projectCode: jobCode, revenue: jobRevenue,
                    vatSetting: jobVAT, startDate: jobStart, endDate: jobEnd,
                    slot1: `${slot1.ref||"(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}`.trim(),
                    slot2: `${slot2.ref||"(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}`.trim(),
                    slot3: `${slot3.ref||"(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`.trim(),
                  },
                  recommendedActions: [`Re-issue invoice #${invoiceNo} including VAT (total £${(grossAmount * 1.2).toFixed(2)}), then mark as resolved`],
                },
              ];
              vatMismatchOptions = options; vatMismatchNewValue = "No";
            }

            // Step 3: Not a VAT scenario — check for rounding difference first
            const amtDiff = Math.abs(grossAmount - dashboardTotal);
            console.log(`  Amount diff: £${amtDiff.toFixed(2)}, isRetainer: ${isRetainer}`);

            // If difference < £1.00, it's almost certainly a rounding issue — no need for Claude
            if (amtDiff < 1.00 && amtDiff > 0) {
              // Amount to write = total excl VAT (Confirmed tab always stores excl-VAT amounts)
              const correctAmount = totalExclVAT > 0 ? totalExclVAT : grossAmount;
              // Slot amount column: Slot 1 = AP, Slot 2 = AW, Slot 3 = BD
              const slotAmtCol = matchedSlot === 1 ? "AP" : matchedSlot === 2 ? "AW" : "BD";
              const cellRef = `${slotAmtCol}${matchedRowNum}`;
              const currentSlotAmt = matchedSlot === 1 ? slot1.amt : matchedSlot === 2 ? slot2.amt : slot3.amt;
              const options = [{
                optionId: 1,
                title: `ROUNDING DIFFERENCE — Correct invoice #${invoiceNo} amount from £${currentSlotAmt}${vatIncluded > 0 ? " +VAT" : ""} to £${correctAmount.toFixed(2)}${vatIncluded > 0 ? " +VAT" : ""}`,
                matchType: "existing_job",
                jobRow: matchedRowNum,
                jobName,
                recommendedActions: [
                  `write ${correctAmount.toFixed(2)} to ${cellRef}`,
                ],
              }];
              console.log(`  ✅ Rounding difference (£${amtDiff.toFixed(2)}) — writing ${correctAmount.toFixed(2)} to ${cellRef}`);
              return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
            }

            // Send to Claude with job details and retainer context
            console.log(`  No VAT scenario, diff £${amtDiff.toFixed(2)} — sending to Claude with job details`);
            const slotAmtCol = matchedSlot === 1 ? "AP" : matchedSlot === 2 ? "AW" : "BD";
            const currentSlotAmt = matchedSlot === 1 ? slot1.amt : matchedSlot === 2 ? slot2.amt : slot3.amt;
            const correctAmount = totalExclVAT > 0 ? totalExclVAT : grossAmount;

            // Detect if this is a multi-row retainer (has child rows = Mode B retainer)
            // Child rows: same client + job name as parent, but no revenue (AG/index 32), no start (AL/index 37)
            const jobClientLower = jobClient.toLowerCase();
            const jobNameLower   = jobName.toLowerCase();
            const isMultiRowRetainer = isRetainer && (() => {
              for (let ri = matchedRowNum; ri < invConfirmedRows.length; ri++) {
                const r = invConfirmedRows[ri] || [];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob    = String(r[1] || "").trim().toLowerCase();
                if (!rClient && !rJob) break;
                if (rClient !== jobClientLower || rJob !== jobNameLower) break;
                if (!String(r[32] || "").trim() && !String(r[37] || "").trim()) return true;
              }
              return false;
            })();

            // Find parent row for this job (the row with revenue in AG)
            // The matched row may be a child row — scan upwards to find the parent
            const isRealSlot = (ref) => {
              const r = String(ref || "").trim();
              return r && !r.toUpperCase().startsWith("MANUAL-INV");
            };
            const parseSlotAmt = (v) => parseFloat(String(v || "0").replace(/[£$€,]/g, "")) || 0;

            let parentRowNum = matchedRowNum; // default: matched row is parent
            let parentRevenue = parseSlotAmt(jobRevenue);
            if (!String(matchedJob[32] || "").trim()) {
              // Matched row has no revenue — scan upwards for parent
              for (let ri = matchedRowNum - 2; ri >= 0; ri--) { // ri is 0-indexed in invConfirmedRows
                const r = invConfirmedRows[ri] || [];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob    = String(r[1] || "").trim().toLowerCase();
                if (rClient !== jobClientLower || rJob !== jobNameLower) break;
                if (String(r[32] || "").trim()) { // has revenue
                  parentRowNum = ri + 1; // 1-indexed
                  parentRevenue = parseSlotAmt(String(r[32] || "").replace(/[£$€,]/g, ""));
                  console.log(`  Found parent row at ${parentRowNum} for matched child row ${matchedRowNum}`);
                  break;
                }
              }
            }

            // Sum ALL real invoice slots across ALL rows of this job (parent + children)
            // replacing the matched slot with the correct amount
            let newTotalInvoiced = 0;
            let realInvoiceCount = 0;
            // Collect all rows belonging to this job
            const allJobRows = [];
            // Find parent row index (0-indexed)
            const parentIdx = parentRowNum - 1;
            // Add parent row
            if (invConfirmedRows[parentIdx]) allJobRows.push({ row: invConfirmedRows[parentIdx], rowNum: parentRowNum });
            // Add child rows (scan downward from parent)
            for (let ri = parentIdx + 1; ri < invConfirmedRows.length; ri++) {
              const r = invConfirmedRows[ri] || [];
              const rClient = String(r[0] || "").trim().toLowerCase();
              const rJob    = String(r[1] || "").trim().toLowerCase();
              if (!rClient && !rJob) break;
              if (rClient !== jobClientLower || rJob !== jobNameLower) break;
              if (String(r[32] || "").trim()) break; // another parent row
              allJobRows.push({ row: r, rowNum: ri + 1 });
            }

            // ── VAT mismatch: update ALL rows and return ──────────────────
            if (vatMismatchOptions && vatMismatchNewValue) {
              const jobType = isRetainer ? "Retainer" : "Project";
              // Build write list: AI column for every row in the job
              const vatWrites = allJobRows.map(({ rowNum }) => `AI${rowNum}`);
              vatMismatchOptions = vatMismatchOptions.map(opt => {
                if (opt.matchType !== "existing_job") return opt;
                return {
                  ...opt,
                  jobDetails: {
                    ...(opt.jobDetails || {}),
                    jobType,
                  },
                  vatUpdate: { cells: vatWrites, newValue: vatMismatchNewValue, currentValue: jobVAT },
                  recommendedActions: [
                    vatWrites.length > 1
                      ? `Update VAT setting to "${vatMismatchNewValue}" on all ${vatWrites.length} rows of this job (${vatWrites.join(", ")})`
                      : `Update VAT setting to "${vatMismatchNewValue}" on row ${allJobRows[0]?.rowNum}`,
                    vatWrites.map(cell => `write ${vatMismatchNewValue} to ${cell}`).join(", "),
                  ],
                };
              });
              return res.status(200).json({ success: true, options: vatMismatchOptions, alertId: alert.rowNumber, previousIgnoreReason });
            }

            // Slot indices: Inv1 ref=42, amt=41; Inv2 ref=49, amt=48; Inv3 ref=56, amt=55
            const INV_SLOTS = [
              { refIdx: 42, amtIdx: 41, slotNum: 1, col: "AP" },
              { refIdx: 49, amtIdx: 48, slotNum: 2, col: "AW" },
              { refIdx: 56, amtIdx: 55, slotNum: 3, col: "BD" },
            ];
            for (const { row, rowNum } of allJobRows) {
              for (const { refIdx, amtIdx, slotNum, col } of INV_SLOTS) {
                const ref = String(row[refIdx] || "").trim();
                if (!isRealSlot(ref)) continue;
                // Use correct amount for the matched slot on the matched row
                const amt = (rowNum === matchedRowNum && slotNum === matchedSlot)
                  ? correctAmount
                  : parseSlotAmt(row[amtIdx]);
                newTotalInvoiced += amt;
                realInvoiceCount++;
              }
            }

            const revenueRatio = parentRevenue > 0 ? (newTotalInvoiced / parentRevenue) * 100 : 0;
            console.log(`  Parent row: ${parentRowNum}, isMultiRowRetainer: ${isMultiRowRetainer}, realInvoices: ${realInvoiceCount}, newTotal: £${newTotalInvoiced.toFixed(2)}, revenue: £${parentRevenue.toFixed(2)}, ratio: ${revenueRatio.toFixed(1)}%`);

            // ── Invoice amount mismatch: fully pre-computed — no Claude needed ──
            // All data required for both options is already calculated above.
            console.log(`  ✅ Generating invAmtMismatch options from pre-computed data (no Claude)`);
            const confidenceFromRatio = (() => {
              if (revenueRatio > 110) return "High"; // over-invoiced
              if (revenueRatio >= 90) return "High";
              if (revenueRatio >= 75) return "Medium";
              return "Low";
            })();
            const revenueImpactStr = `New total invoiced = £${newTotalInvoiced.toFixed(2)}. Job revenue = £${parentRevenue.toFixed(2)}. ${
              revenueRatio > 110 ? "Job is over-invoiced — revenue likely needs updating." :
              revenueRatio >= 90 ? "Total invoiced is close to revenue — revenue adjustment likely correct." :
              revenueRatio >= 75 ? "Total invoiced is below revenue — further invoices may be expected." :
              "Total invoiced is well below revenue — revenue adjustment is uncertain."
            }`;

            let invAmtOptions = [
              {
                optionId: 1,
                title: `Update slot amount only — accounting system reflects actual invoice sent`,
                matchType: "existing_job",
                jobRow: matchedRowNum,
                confidence: "High",
                explanation: `Dashboard incorrectly shows £${currentSlotAmt} for invoice #${invoiceNo}, but accounting system shows the actual sent amount of £${correctAmount.toFixed(2)} (excl VAT). Job revenue may represent the original quote or scope.`,
                revenueImpact: revenueImpactStr,
                recommendedActions: [
                  `Update invoice #${invoiceNo} amount from £${currentSlotAmt} to £${correctAmount.toFixed(2)} in the dashboard`,
                  `write ${correctAmount.toFixed(2)} to ${slotAmtCol}${matchedRowNum} (slot ${matchedSlot} amount)`,
                ],
              },
              isMultiRowRetainer
                ? {
                    optionId: 2,
                    title: `Revenue adjustment not applicable for multi-row retainer`,
                    matchType: "info",
                    jobRow: matchedRowNum,
                    confidence: "N/A",
                    explanation: `For multi-row retainers, the revenue figure represents the monthly amount and should not be adjusted to match total invoiced.`,
                    revenueImpact: revenueImpactStr,
                    recommendedActions: [
                      `Review revenue for this retainer job manually`,
                      ``,
                    ],
                  }
                : {
                    optionId: 2,
                    title: `Update slot amount and adjust revenue to £${newTotalInvoiced.toFixed(2)}`,
                    matchType: "existing_job",
                    jobRow: matchedRowNum,
                    confidence: confidenceFromRatio,
                    explanation: `Update the invoice slot amount to match the accounting system, and update job revenue to reflect the corrected total invoiced (${revenueRatio.toFixed(1)}% of current revenue).`,
                    revenueImpact: revenueImpactStr,
                    recommendedActions: [
                      `Update invoice #${invoiceNo} amount and adjust job revenue to £${newTotalInvoiced.toFixed(2)}`,
                      `write ${correctAmount.toFixed(2)} to ${slotAmtCol}${matchedRowNum} (slot ${matchedSlot} amount), write ${newTotalInvoiced.toFixed(2)} to AG${parentRowNum} (job revenue)`,
                    ],
                  },
            ];

                        // Build slotBreakdown from pre-calculated allJobRows data — injected onto both options
            // so the frontend can display the full invoice context without relying on Claude to enumerate it.
            const slotBreakdownLines = [];
            for (const { row, rowNum } of allJobRows) {
              for (const { refIdx, amtIdx, slotNum, col } of INV_SLOTS) {
                const ref = String(row[refIdx] || "").trim();
                const rawAmt = row[amtIdx];
                if (!ref && (rawAmt === undefined || rawAmt === "")) continue;
                const isManual = ref.toUpperCase().startsWith("MANUAL-INV");
                const isMatched = rowNum === matchedRowNum && slotNum === matchedSlot;
                const amt = isMatched
                  ? `£${correctAmount.toFixed(2)} (corrected from £${currentSlotAmt})`
                  : rawAmt !== undefined && rawAmt !== ""
                    ? `£${parseSlotAmt(rawAmt).toFixed(2)}`
                    : "(no amount)";
                const label = isManual ? `[MANUAL-INV]` : ref || "(blank ref)";
                const tag = isMatched ? " ← this invoice" : "";
                slotBreakdownLines.push(`Row ${rowNum} Inv${slotNum}: ${label} ${amt}${tag}`);
              }
            }
            const slotBreakdown = {
              lines: slotBreakdownLines,
              correctedTotal: `£${newTotalInvoiced.toFixed(2)}`,
              currentRevenue: `£${parentRevenue.toFixed(2)}`,
              revenueRatio: `${revenueRatio.toFixed(1)}%`,
            };

            // Inject jobName and slotBreakdown onto each option so the row re-verifier can find
            // the job if rows shift, and the frontend can display full invoice context.
            invAmtOptions = invAmtOptions.map(opt => ({
              ...opt,
              jobName: opt.jobName || jobName,
              jobRevenue: opt.jobRevenue || jobRevenue,
              slotBreakdown,
              jobDetails: opt.jobDetails || {
                clientName: jobClient,
                jobName,
                projectCode: jobCode,
                revenue: jobRevenue,
                vatSetting: jobVAT,
                jobType: isRetainer ? "Retainer" : "Project",
                startDate: jobStart,
                endDate: jobEnd,
              },
              rowContext: {
                matchedRow: matchedRowNum,
                parentRow: parentRowNum,
                isChildRow: matchedRowNum !== parentRowNum,
                matchedSlot,
              },
            }));
            // Write to AlertMemory cache
            const invAmtSummary = alert.summary?.summary || `Invoice ${invoiceNo} £${grossAmount.toFixed(2)}`;
            if (memoryRow) {
              await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
                ...memoryRow, cachedOptionsJSON: JSON.stringify(invAmtOptions),
              });
            } else {
              await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
                fingerprintHash, alertType: "invoice", clientName: alert.clientName || "",
                alertSummary: invAmtSummary, cachedOptionsJSON: JSON.stringify(invAmtOptions), status: "cached",
              });
            }
            console.log(`  💾 Inv amt mismatch options cached in AlertMemory`);
            return res.status(200).json({ success: true, options: invAmtOptions, alertId: alert.rowNumber, previousIgnoreReason });
          }
        }

        // ── Non-standard invoice discrepancy types ─────────────────────────
        if (!isMissingInvoice && activeInvFlags.length > 0) {
          console.log(`  📊 Non-standard invoice discrepancy: ${activeInvFlags.join(", ")} — returning info message`);
          const options = [{
            optionId: 1,
            title: `MANUAL INVESTIGATION REQUIRED — ${activeInvFlags.join(", ")}`,
            matchType: "info",
            matchAnalysis: {
              matchConfidence: "N/A",
              reasonForChoice: `This type of invoice discrepancy (${activeInvFlags.join(", ")}) requires manual investigation.`,
              discrepancies: activeInvFlags.join(", "),
            },
            recommendedActions: [
              `Invoice #${invoiceNo} — ${invClient}${invJob ? " | " + invJob : ""}`,
              `Amount: £${grossAmount.toFixed(2)}${vatIncluded > 0 ? ` (incl. £${vatIncluded.toFixed(2)} VAT)` : ""}, Sent: ${invSentDate}, Status: ${invStatus}`,
              `Discrepancy type(s): ${activeInvFlags.join(", ")}`,
              `Please review this invoice directly in InvComp`,
            ],
          }];
          return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
        }

        // ── Missing invoice — existing Claude path ─────────────────────────
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
            0,1,2,3,4,5,6,
            32,33,34,35,36,37,38,
            41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,
            75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94
          ];
          const hasData = colsToCheck.some(col => rowData[col]);
          
          if (hasData) {
            lastDataRow = row;
            break;
          }
        }
        
        const activeData = confirmedData.slice(0, lastDataRow + 1);
        console.log(`  📊 Using ${activeData.length} non-blank rows for Claude analysis`);

        // Fetch tolerances here — needed by both the pre-check and the prompt builder below
        const tolerances = await getToleranceValues(sheets, alert.masterSheetId || alert.clientId);

        // Extract invoice details — declared here so they're available to both the
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
        // Same reasoning as invoiceAmtForMatch above — moved here 20 Aug 2026 from
        // inside the isMissingInvoice block below, which Tier 1/2 (further down,
        // a SIBLING scope, not a child of that block) also needs this for. The
        // original placement meant every accept-option call touching the
        // "name match" Tier 2 path threw a ReferenceError at runtime (confirmed via
        // Babel's own scope resolution during a full-codebase sweep, not just an
        // ESLint guess) — a plain syntax check can't catch an undefined-reference
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
              const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
              const parts = d.split(/[-\/]/);
              if (parts.length === 3) {
                const monthNum = months[parts[1]?.toLowerCase()?.substring(0,3)];
                if (monthNum !== undefined) {
                  const year = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
                  return new Date(year, monthNum, parseInt(parts[0]));
                }
                if (parts[0].length === 4) return new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
                return new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
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
        // Signal A — Fuzzy client name match: checks whether any Confirmed tab client
        //   name is plausibly the same entity as the invoice client name, using:
        //   - noise-word stripping (ltd, limited, plc, inc, llc, the, and, &, group, co)
        //   - normalisation (punctuation, whitespace, case)
        //   - word-overlap: any single meaningful word shared between names
        //   - abbreviation detection: initials of one name spell the other
        //
        // Signal B — Amount + date sweep of non-real slots (blank ref OR MANUAL-INV):
        //   - Amount tolerance: 5p domestic, 10% foreign (mirrors GAS automation)
        //   - Date tolerance: ±invoiceMonthsTolerance months
        //   - Only considers slots with no real invoice reference (available placeholders)
        //
        // Outcomes:
        //   - Signal A found, Signal B found → Claude receives full table + slot match candidates
        //   - Signal A found only           → Claude receives full table (existing flow)
        //   - Signal A NOT found, Signal B found → Claude receives slot match candidates only
        //   - Neither found                 → hardcoded create_new (no Claude call)

        // slotMatches declared here so Tier 1 and Tier 2 can access it regardless of isMissingInvoice
        let slotMatches = [];
        let clientFound = false;

        if (isMissingInvoice) {

          const alertClientStr = alert.summary?.client || invoiceClient;
          clientFound = alertClientStr && activeData.some(row =>
            fuzzyClientMatch_(alertClientStr, String(row[0] || ""))
          );
          console.log(`  Fuzzy client match for "${alertClientStr}": ${clientFound}`);

          // ── Amount + date sweep of non-real slots ─────────────────────────
          // Fetch primary currency from client KeyInfo!B17 to determine tolerance type
          let primaryCurrency = "GBP";
          try {
            const keyInfoResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: "KeyInfo!B17",
            });
            primaryCurrency = String(keyInfoResp.data.values?.[0]?.[0] || "GBP").trim().toUpperCase();
          } catch (e) {
            console.log(`  ⚠️ Could not read KeyInfo!B17 — defaulting to GBP`);
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

          // Sweep all non-real slots across all active Confirmed rows
          // Non-real = no ref, OR ref starts with MANUAL-INV
          const INV_SLOT_DEFS = [
            { amtIdx: 41, refIdx: 42, sentIdx: 43, slotNum: 1, amtCol: "AP", refCol: "AQ", sentCol: "AR", daysCol: "AS", statusCol: "AT" },
            { amtIdx: 48, refIdx: 49, sentIdx: 50, slotNum: 2, amtCol: "AW", refCol: "AX", sentCol: "AY", daysCol: "AZ", statusCol: "BA" },
            { amtIdx: 55, refIdx: 56, sentIdx: 57, slotNum: 3, amtCol: "BD", refCol: "BE", sentCol: "BF", daysCol: "BG", statusCol: "BH" },
          ];

          // slotMatches declared outside this block so Tier 1/Tier 2 can access it
          for (let ri = 1; ri < activeData.length; ri++) {
            const row = activeData[ri] || [];
            const rowClient  = String(row[0] || "").trim();
            const rowJob     = String(row[1] || "").trim();
            const rowCode    = String(row[2] || "").trim();
            const rowRevenue = String(row[32] || "").trim();
            if (!rowClient && !rowJob) continue;

            for (const sd of INV_SLOT_DEFS) {
              const ref    = String(row[sd.refIdx] || "").trim();
              const rawAmt = row[sd.amtIdx];
              const slotDate = String(row[sd.sentIdx] || "").trim();

              // Non-real: blank ref OR MANUAL-INV prefix
              const isManual = ref.toUpperCase().startsWith("MANUAL-INV");
              const isNonReal = !ref || isManual;
              if (!isNonReal) continue;

              // Must have an amount to match against
              const slotAmt = parseFloat(String(rawAmt || "").replace(/[£$€,]/g, "")) || 0;
              if (slotAmt === 0) continue;

              const amtMatch  = amtToleranceFn(slotAmt);
              if (!amtMatch) continue; // amount must match — date is supporting evidence only

              const dateOk = dateWithinTolerance(slotDate); // true / false / null
              slotMatches.push({
                rowNum: ri + 1, // 1-indexed sheet row (activeData[0] = header, ri=1 → sheet row 2)
                client: rowClient, jobName: rowJob, projectCode: rowCode, revenue: rowRevenue,
                startDate: String(row[37] || "").trim(), // AL — for recency ranking
                slotNum: sd.slotNum, slotAmt, slotDate, amtMatch, dateMatch: dateOk,
                amtCol: sd.amtCol, refCol: sd.refCol, sentCol: sd.sentCol,
                daysCol: sd.daysCol, statusCol: sd.statusCol, isManual,
              });
            }
          }
          console.log(`  Amount/date slot sweep: ${slotMatches.length} non-real slot(s) with matching amount`);

          // ── Secondary sweep: job-level MANUAL-INV total match ──────────────
          // If no individual slot matched, check whether the invoice amount equals the
          // TOTAL of all MANUAL-INV slots across a job. This handles the common case
          // where automation splits a job's revenue across multiple MANUAL-INV placeholders
          // (e.g. £435 + £435 = £870) but the real invoice covers the full amount.
          if (!slotMatches.some(m => !m.isManual || true)) { // always run this check
            // Group MANUAL-INV slots by job (client+jobName)
            const jobManualSlots = new Map(); // key → { slots: [], client, jobName, projectCode, revenue, startDate }
            for (let ri = 1; ri < activeData.length; ri++) {
              const row = activeData[ri] || [];
              const rowClient  = String(row[0] || "").trim();
              const rowJob     = String(row[1] || "").trim();
              const rowCode    = String(row[2] || "").trim();
              const rowRevenue = String(row[32] || "").trim();
              const rowStart   = String(row[37] || "").trim();
              if (!rowClient && !rowJob) continue;
              const key = `${rowClient}||${rowJob}`;
              for (const sd of INV_SLOT_DEFS) {
                const ref = String(row[sd.refIdx] || "").trim();
                if (!ref.toUpperCase().startsWith("MANUAL-INV")) continue;
                const rawAmt = row[sd.amtIdx];
                const slotAmt = parseFloat(String(rawAmt || "").replace(/[£$€,]/g, "")) || 0;
                if (slotAmt === 0) continue;
                const slotDate = String(row[sd.sentIdx] || "").trim();
                if (!jobManualSlots.has(key)) {
                  jobManualSlots.set(key, { slots: [], client: rowClient, jobName: rowJob, projectCode: rowCode, revenue: rowRevenue, startDate: rowStart });
                }
                jobManualSlots.get(key).slots.push({ rowNum: ri + 1, slotNum: sd.slotNum, slotAmt, slotDate, ref, ...sd });
              }
            }
            // Check each job's total MANUAL-INV amount against invoice
            for (const [, job] of jobManualSlots) {
              const totalManual = job.slots.reduce((s, sl) => s + sl.slotAmt, 0);
              if (amtToleranceFn(totalManual)) {
                // Total matches — flag slot 1 (first slot) as the target
                const firstSlot = job.slots.sort((a, b) => a.rowNum - b.rowNum || a.slotNum - b.slotNum)[0];
                // Only add if not already in slotMatches
                const alreadyMatched = slotMatches.some(m => m.rowNum === firstSlot.rowNum && m.slotNum === firstSlot.slotNum);
                if (!alreadyMatched) {
                  const dateOk = dateWithinTolerance(firstSlot.slotDate);
                  slotMatches.push({
                    rowNum: firstSlot.rowNum,
                    client: job.client, jobName: job.jobName, projectCode: job.projectCode, revenue: job.revenue,
                    startDate: job.startDate, // AL — for recency ranking
                    slotNum: firstSlot.slotNum, slotAmt: totalManual, slotDate: firstSlot.slotDate,
                    amtMatch: true, dateMatch: dateOk,
                    amtCol: firstSlot.amtCol, refCol: firstSlot.refCol, sentCol: firstSlot.sentCol,
                    daysCol: firstSlot.daysCol, statusCol: firstSlot.statusCol, isManual: true,
                    isJobTotalMatch: true, // flag so Claude knows this is a total-match scenario
                    manualSlotsToClear: job.slots.length, // how many MANUAL-INV slots exist
                  });
                  console.log(`  Job-level MANUAL-INV total match: ${job.client} | ${job.jobName} — total £${totalManual} matches invoice £${invoiceAmtForMatch}`);
                }
              }
            }
          }

          const hasSlotMatches = slotMatches.length > 0;

          // ── Neither signal found → still send to Claude — it may find non-obvious matches
          // (e.g. different client name spelling, amount = fraction of job revenue, etc.)
          if (!clientFound && !hasSlotMatches) {
            console.log(`  No client match and no slot match — sending to Claude for non-obvious match detection`);
          }

          // ── Build slot match context block for Claude (if Signal B found) ──
          // Group matches by job (client + jobName) so Claude sees the COMPLETE picture
          // for each candidate job — all matching slots AND all other slots on the same job.
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
              const jobNorm    = group.jobName.toLowerCase();

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
                  parentStart   = String(r[37] || "").trim();
                  parentEnd     = String(r[38] || "").trim();
                  parentVAT     = String(r[34] || "").trim();
                  parentType    = String(r[35] || "").trim();
                }
                allJobRows.push({ row: r, sheetRow, isParent: directMatch && hasRevenue });
                lastCollectedRi = ri;
              }

              // Build complete slot picture across all job rows
              const allSlotLines = [];
              for (const { row: r, sheetRow, isParent } of allJobRows) {
                const rowLabel = isParent ? "parent" : "child";
                const slotDefs = [
                  { amtIdx:41, refIdx:42, sentIdx:43, slotNum:1 },
                  { amtIdx:48, refIdx:49, sentIdx:50, slotNum:2 },
                  { amtIdx:55, refIdx:56, sentIdx:57, slotNum:3 },
                ];
                for (const sd of slotDefs) {
                  const ref    = String(r[sd.refIdx] || "").trim();
                  const rawAmt = r[sd.amtIdx];
                  const slotDate = String(r[sd.sentIdx] || "").trim();
                  const amt    = rawAmt !== undefined && rawAmt !== "" ? parseFloat(String(rawAmt).replace(/[£$€,]/g,"")) || 0 : null;
                  const isManual  = ref.toUpperCase().startsWith("MANUAL-INV");
                  const isReal    = ref && !isManual;
                  const isEmpty   = !ref && (amt === null || amt === 0);

                  // Is this one of the backend-matched slots?
                  const isMatched = group.matchingSlots.some(m => m.rowNum === sheetRow && m.slotNum === sd.slotNum);

                  let slotDesc;
                  if (isEmpty) {
                    slotDesc = "(empty)";
                  } else if (isReal) {
                    slotDesc = `${ref} £${amt?.toFixed(2) || "?"} sent:${slotDate || "?"} [REAL — do not overwrite]`;
                  } else if (isManual) {
                    const manualAmtMatch = amt && Math.abs(amt - invoiceAmount) < 0.01;
                    // Check if this is part of a job-total match (invoice covers full job revenue via multiple MANUAL-INV slots)
                    const isJobTotalMatch = group.matchingSlots.some(m => m.isJobTotalMatch && m.rowNum === sheetRow && m.slotNum === sd.slotNum);
                    const jobTotalNote = isJobTotalMatch ? ` ← INVOICE COVERS FULL JOB REVENUE — PLACE HERE AND CLEAR ALL OTHER MANUAL-INV SLOTS` : (manualAmtMatch ? " ← AMOUNT MATCHES THIS INVOICE" : "");
                    slotDesc = `${ref} £${amt?.toFixed(2) || "?"} sent:${slotDate || "?"} [MANUAL-INV placeholder${jobTotalNote}]`;
                  } else {
                    // Blank-ref placeholder — show explicit date comparison vs invoice sent date
                    const dateResult = dateWithinTolerance(slotDate);
                    let dateTag;
                    if (!slotDate) {
                      dateTag = "no date recorded";
                    } else if (invSentDateParsed && parseSheetOrJsDate_(slotDate)) {
                      const diffMonths = Math.abs((parseSheetOrJsDate_(slotDate) - invSentDateParsed) / (1000*60*60*24*30.4));
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
  Dashboard client name: "${group.client}" | Invoice client name: "${alertClientStr}"${group.client.toLowerCase() !== alertClientStr.toLowerCase() ? ` ← NAMES DIFFER — if you recommend this job, also write "${alertClientStr}" to col A of ALL rows for this job (rows: ${allJobRows.map(r => r.sheetRow).join(", ")})` : " ← names match"}
  ${matchCount} slot(s) with amount matching invoice £${invoiceAmtForMatch.toFixed(2)} (${toleranceNote}) — date ${bestDateMatch ? "✓ at least one slot within tolerance" : "✗ no slot within date tolerance"}
  ALL SLOTS FOR THIS JOB (${allJobRows.length} row${allJobRows.length > 1 ? "s" : ""} = ${allJobRows.length * 3} slots total — parent + child rows combined):
${allSlotLines.join("\n")}`
              );
            }

            const toleranceHeader = isForeignCurrency
              ? `(Foreign currency — ${invoiceCurrency} vs primary ${primaryCurrency} — amount tolerance 10%)`
              : `(Domestic currency — amount tolerance 5p, date tolerance ±${invMonthsTol} months)`;

            slotMatchContext = `
PLACEHOLDER SLOT MATCHES — PRE-COMPUTED BY BACKEND ${toleranceHeader}:
The backend found non-real invoice slots whose amounts match this invoice within tolerance.
CRITICAL: Parent and child rows below belong to the SAME JOB — treat them as a single unit with up to ${3 * (slotMatches[0] ? (jobGroups.get(`${slotMatches[0].client}||${slotMatches[0].jobName}`)?.matchingSlots?.length || 1) : 1)} slots total.
Invoice amount to place: £${invoiceAmtForMatch.toFixed(2)}, sent date: ${sentDate || "unknown"}

${jobContextLines.join("\n\n")}

INSTRUCTIONS FOR USING THESE MATCHES:
- Slots marked "← AMOUNT MATCHES THIS INVOICE" are the backend-confirmed candidates
- Slots marked "← INVOICE COVERS FULL JOB REVENUE — PLACE HERE AND CLEAR ALL OTHER MANUAL-INV SLOTS" mean the invoice amount equals the total of all MANUAL-INV placeholders on this job. In this case: place the invoice in that slot (slot 1), write all 5 invoice fields to it, and clear ALL other MANUAL-INV slots on this job (write blank to all 5 fields of each remaining MANUAL-INV slot).
- A slot with both amount match AND date match (✓) is the most likely target
- A slot with amount match but date mismatch (✗) is still a valid option, with lower confidence — state the actual date difference
- NEVER describe a date-tolerance match as "exact" — state the actual difference in months
- The job's total revenue is split across ALL slots (parent + child rows combined)
- When recommending a slot, use the actual sheet row number shown (e.g. Row 263 or Row 264)
- CLIENT NAME MISMATCH: If the dashboard client name and invoice client name differ (marked "← NAMES DIFFER"), you MUST include writes of the invoice client name to column A of ALL rows for that job as part of recommendedActions — the accounting system name is authoritative`;
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

        // ── TIER 1: Single exact slot match — generate option without Claude ─
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
          const refColLetter  = m.refCol;
          const sentColLetter = m.sentCol;
          const daysColLetter = m.daysCol;
          const statColLetter = m.statusCol;
          const rowNum = m.rowNum;
          const slotNum = m.slotNum;
          const isManual = m.isManual;
          const slotLabel = `${m.client} — ${m.jobName} (Row ${rowNum} Slot ${slotNum})`;
          const slotDesc = isManual ? "replacing the MANUAL-INV placeholder" : "replacing the blank placeholder";
          console.log(`  ✅ Tier 1 match — generating option without Claude: ${slotLabel}`);

          const tier1Option = {
            optionId: 1,
            title: `Place in ${m.client} — ${m.jobName} slot ${slotNum} (Row ${rowNum}) — exact amount match, ${isManual ? "replacing MANUAL-INV placeholder" : "slot date match"}`,
            matchType: "existing_job",
            jobRow: rowNum,
            jobName: m.jobName,
            jobRevenue: m.revenue,
            targetRowNum: rowNum,
            targetSlotType: "invoice",
            targetSlotNum: slotNum,
            matchAnalysis: {
              matchConfidence: "High",
              reasonForChoice: `Amount exact match (£${invoiceAmtForMatch.toFixed(2)}). Client name match (${m.client}). Invoice sent ${sentDate} vs slot date ${m.slotDate} — within tolerance.`,
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
            sheets, alert.clientId, "Confirmed", rowNum,
            { type: "invoice", rowNum, slotNum },
            sharedData
          );

          const tier1Summary = `Invoice ${invoiceRef} ${m.client} — ${m.jobName}`;
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
          console.log("  🤖 forceAI=true — using Claude for invoice options");
          // Build compact confirmed tab summary for Claude
          const aiInvRows = activeData.slice(0, Math.min(activeData.length, 200)).map((row, ridx) => {
            const inv1 = `${row[42]||"(empty)"} £${row[41]||"?"} sent:${row[43]||"?"}`;
            const inv2 = `${row[49]||"(empty)"} £${row[48]||"?"} sent:${row[50]||"?"}`;
            const inv3 = `${row[56]||"(empty)"} £${row[55]||"?"} sent:${row[57]||"?"}`;
            return `Row ${ridx+1} | ${row[0]||""} | ${row[1]||""} | Rev:${row[32]||""} | Inv1:${inv1} | Inv2:${inv2} | Inv3:${inv3}`;
          }).join("\n");
          const aiInvPrompt = `You are a financial reconciliation assistant. Place this invoice into the correct slot in the Confirmed tab.
Invoice: #${invoiceNo}, Amount excl VAT: £${totalExclVAT}, Gross: £${grossAmount}, Sent: ${invSentDate}, Status: ${invStatus}
Client: ${invClient}, Job description: ${invJob}
${alert._preAnalysis?.slotMatchContext || "No pre-computed slot matches."}
Confirmed tab (first 200 rows):
${aiInvRows}
Return a JSON array of options. Each option: optionId, title, matchType (existing_job|info), jobRow, jobName, jobRevenue, matchAnalysis (matchConfidence, amountMatch, dateRangeMatch, reasonForChoice, discrepancies), recommendedActions (array of strings), slotBreakdown.`;
          const aiInvMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 4000, messages: [{ role: "user", content: aiInvPrompt }] });
          await logClaudeUsage_(sheets, automationCommanderSheetId, alert.clientName || "", "invoice", aiInvMsg.usage?.input_tokens || 0, aiInvMsg.usage?.output_tokens || 0).catch(() => {});
          let aiInvOptions = [];
          try {
            const rawInv = aiInvMsg.content[0].type === "text" ? aiInvMsg.content[0].text : "";
            const cleanInv = rawInv.replace(/```json/g,"").replace(/```/g,"").trim();
            const arrInv = cleanInv.slice(cleanInv.indexOf("["), cleanInv.lastIndexOf("]")+1);
            aiInvOptions = JSON.parse(arrInv);
            if (!Array.isArray(aiInvOptions)) aiInvOptions = [aiInvOptions];
          } catch(e) { aiInvOptions = [{ optionId:1, title:"AI response could not be parsed", matchType:"info", recommendedActions:[] }]; }
          const aiInvSummary = `Invoice ${invoiceRef} ${invClient} — ${invJob}`;
          if (memoryRow) { await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(aiInvOptions) }); }
          else { await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType:"invoice", clientName: alert.clientName||"", alertSummary: aiInvSummary, cachedOptionsJSON: JSON.stringify(aiInvOptions), status:"cached" }); }
          return res.status(200).json({ success: true, options: aiInvOptions, alertId: alert.rowNumber });
        }
        // Strategy:
        // A) Amount-matched slots (already found in slotMatches) → high-confidence options
        // B) Client+job name fuzzy matched slots (any amount, non-real slot) → lower-confidence
        // C) Manual investigation fallback

        const INV_SLOT_DEFS2 = [
          { amtIdx:41, refIdx:42, sentIdx:43, slotNum:1, amtCol:"AP", refCol:"AQ", sentCol:"AR", daysCol:"AS", statusCol:"AT" },
          { amtIdx:48, refIdx:49, sentIdx:50, slotNum:2, amtCol:"AW", refCol:"AX", sentCol:"AY", daysCol:"AZ", statusCol:"BA" },
          { amtIdx:55, refIdx:56, sentIdx:57, slotNum:3, amtCol:"BD", refCol:"BE", sentCol:"BF", daysCol:"BG", statusCol:"BH" },
        ];

        // Noise-word stripping for job name matching
        const INV_NOISE = new Set(["ltd","limited","plc","inc","llc","llp","the","and","&",
          "group","co","corp","corporation","holdings","international","uk","us",
          "solutions","services","consulting","consultancy","project","projects"]);
        const normInvWords = s => String(s||"").toLowerCase()
          .replace(/['"\-.,()/#]/g," ").replace(/\s+/g," ").trim()
          .split(" ").filter(w => w.length > 1 && !INV_NOISE.has(w));

        const invJobWords    = normInvWords(invJob);
        const invClientWords = normInvWords(invClient);

        const tier2Options = [];
        const seenSlotKeys = new Set(); // avoid duplicate options for same slot

        // ── Signal A: Amount-matched slots ───────────────────────────────────
        // slotMatches was already computed in the pre-check sweep above.
        // Group by job so each job appears at most once.
        const amtMatchedJobs = new Map();
        for (const m of (slotMatches || [])) {
          const key = `${m.client}||${m.jobName}`;
          if (!amtMatchedJobs.has(key)) amtMatchedJobs.set(key, []);
          amtMatchedJobs.get(key).push(m);
        }

        for (const [, matches] of amtMatchedJobs) {
          // Pick the best slot: prefer date match, then lowest slot number
          const best = matches.sort((a,b) => {
            if (a.dateMatch && !b.dateMatch) return -1;
            if (!a.dateMatch && b.dateMatch) return 1;
            return a.slotNum - b.slotNum;
          })[0];
          const slotKey = `${best.rowNum}-${best.slotNum}`;
          seenSlotKeys.add(slotKey);

          // Calculate total invoiced (real slots only, excluding MANUAL-INV/blank)
          let realTotal = 0;
          for (let ri = 1; ri < activeData.length; ri++) {
            const r = activeData[ri] || [];
            const rc = String(r[0]||"").trim().toLowerCase();
            const rj = String(r[1]||"").trim().toLowerCase();
            const clientNorm = best.client.toLowerCase();
            const jobNorm    = best.jobName.toLowerCase();
            const isJobRow   = (rc === clientNorm && rj === jobNorm) ||
              (!r[0] && !r[1] && ri > 1 && realTotal > 0); // child row
            if (!isJobRow) { if (realTotal > 0 && rc && rc !== clientNorm) break; continue; }
            for (const sd of INV_SLOT_DEFS2) {
              const ref = String(r[sd.refIdx]||"").trim();
              const amt = parseFloat(String(r[sd.amtIdx]||"").replace(/[£$€,]/g,"")) || 0;
              const isReal = ref && !ref.toUpperCase().startsWith("MANUAL-INV");
              if (isReal) realTotal += amt;
            }
          }
          const newTotal = realTotal + invoiceAmtForMatch;
          const revNum   = parseFloat(String(best.revenue||"0").replace(/[£$€,]/g,"")) || 0;
          const remaining = revNum > 0 ? revNum - newTotal : null;
          const budgetFits = revNum === 0 || newTotal <= revNum; // no known revenue = don't penalise
          const isExactClient = String(best.client||"").trim().toLowerCase() === String(invClient||"").trim().toLowerCase();
          const confidence = best.dateMatch ? "High" : "Medium";
          const slotDesc   = best.isManual ? "replacing MANUAL-INV placeholder" : "replacing blank placeholder";
          const dateNote   = best.dateMatch
            ? `Invoice sent ${sentDate}, slot date ${best.slotDate} — within tolerance`
            : `Invoice sent ${sentDate}, slot date ${best.slotDate} — outside date tolerance`;

          const slotLines = [`Row ${best.rowNum} Slot ${best.slotNum}: ${invoiceRef} £${invoiceAmtForMatch.toFixed(2)} ← this invoice`];
          const revLine = revNum > 0
            ? `Revenue: £${revNum.toFixed(2)} | Previously invoiced (real only): £${realTotal.toFixed(2)} | New total: £${newTotal.toFixed(2)} | ${remaining !== null ? `Remaining: £${remaining.toFixed(2)}` : ""}`
            : `Revenue: unknown`;

          tier2Options.push({
            optionId: tier2Options.length + 1,
            title: `Place in ${best.client} — ${best.jobName} slot ${best.slotNum} (Row ${best.rowNum}) — amount match, ${slotDesc}`,
            matchType: "existing_job",
            jobRow: best.rowNum,
            jobName: best.jobName,
            jobRevenue: best.revenue,
            targetRowNum: best.rowNum,
            targetSlotType: "invoice",
            targetSlotNum: best.slotNum,
            matchingDetails: {
              // revenue/startDate here must be the JOB's own true values — the
              // row-re-verification check before writing (a few hundred lines
              // down) reads this field expecting the target row's expected
              // state, to confirm cell references haven't gone stale. This
              // previously held the INVOICE's own amount/sent-date instead
              // (invoiceAmtForMatch/sentDate) — which never matches the job
              // row's actual revenue/start date, so verification failed on
              // every single write through this path. Fixed 20 Aug 2026,
              // confirmed via a live example (Orinoco Communications →
              // Oxford Health NHS Foundation Trust). best.revenue is the
              // job's real revenue (already used correctly elsewhere in this
              // same option, in matchedJobDetails below); the job's true
              // start date isn't reliably available here, so it's left empty
              // rather than populated with another wrong value — the
              // verification guard already skips its date check cleanly when
              // the expected value is empty.
              unmatchedJobSummary: {
                clientName: invClient,
                jobName: best.jobName,
                projectCode: "",
                revenue: String(best.revenue || ""),
                startDate: "",
                endDate: "",
                likelihood: "",
              },
              matchedJobDetails: {
                clientName: best.client,
                jobName: best.jobName,
                projectCode: best.projectCode,
                revenue: best.revenue,
                startDate: "",
                endDate: "",
              },
            },
            matchAnalysis: {
              matchConfidence: confidence,
              amountMatch: `YES — invoice £${invoiceAmtForMatch.toFixed(2)} matches slot £${best.slotAmt.toFixed(2)} (within tolerance)`,
              dateRangeMatch: best.dateMatch ? "YES" : "PARTIAL — outside date tolerance",
              projectCodeMatch: "N/A",
              reasonForChoice: `Amount match on ${best.jobName} Row ${best.rowNum} Slot ${best.slotNum}. ${dateNote}.`,
              discrepancies: best.dateMatch ? "None" : `Date outside tolerance: ${dateNote}`,
              whyItDidntAutoMatch: "Multiple slot matches or foreign currency — system presented all options",
            },
            recommendedActions: [
              `Place invoice ${invoiceRef} (£${invoiceAmtForMatch.toFixed(2)}) in ${best.client} — ${best.jobName} slot ${best.slotNum}, ${slotDesc}`,
              [`write ${invoiceAmtForMatch.toFixed(2)} to ${best.amtCol}${best.rowNum}`,
               `write ${invoiceRef} to ${best.refCol}${best.rowNum}`,
               `write ${sentDate||""} to ${best.sentCol}${best.rowNum}`,
               `write ${daysToPayValue||30} to ${best.daysCol}${best.rowNum}`,
               `write ${invoiceStatus||"Sent"} to ${best.statusCol}${best.rowNum}`].join(", "),
            ],
            slotBreakdown: { lines: slotLines, correctedTotal: `£${newTotal.toFixed(2)}`, currentRevenue: `£${revNum.toFixed(2)}`, revLine },
            _rankStartDate: best.startDate || "",
            _rankBudgetFits: budgetFits,
            _rankExactClient: isExactClient,
            _rankDateMatch: best.dateMatch === true,
            _rankPartialClient: fuzzyClientMatch_(invClient, best.client),
          });
        }

        // ── Signal B: Job-name fuzzy matched slots (first non-real slot only) ──
        // Requires a client name match (exact or close overlap) — job name alone is not
        // sufficient, since job names can coincidentally share words across clients.
        // Only the FIRST available placeholder/MANUAL-INV slot per job is offered — if a
        // job already has later slots filled behind an earlier gap, presenting every
        // remaining slot as a separate option is misleading (the gap should be filled
        // in order).
        if (invClientWords.length > 0) {
          const jobNameMatches = new Map(); // key → { client, jobName, rows, bestSlot }
          for (let ri = 1; ri < activeData.length; ri++) {
            const r = activeData[ri] || [];
            const rc = String(r[0]||"").trim();
            const rj = String(r[1]||"").trim();
            const rev = String(r[32]||"").trim();
            if (!rc && !rj) continue;
            const rcWords = normInvWords(rc);
            const rjWords = normInvWords(rj);
            const clientOverlap = invClientWords.some(w => rcWords.includes(w)) || rcWords.some(w => invClientWords.includes(w));
            if (!clientOverlap) continue; // client match required — job name alone is not enough

            // Find only the FIRST non-real slot on this row (in slot-number order)
            let sd = null, ref = "", rawAmt = "", isManual = false;
            for (const cand of INV_SLOT_DEFS2) {
              const candRef = String(r[cand.refIdx]||"").trim();
              const candIsManual = candRef.toUpperCase().startsWith("MANUAL-INV");
              const candIsNonReal = !candRef || candIsManual;
              if (!candIsNonReal) continue;
              const candKey = `${ri+1}-${cand.slotNum}`;
              if (seenSlotKeys.has(candKey)) continue; // already in Signal A
              sd = cand; ref = candRef; rawAmt = r[cand.amtIdx]; isManual = candIsManual;
              break; // first match only
            }
            if (!sd) continue;

            {
              const slotAmt = parseFloat(String(rawAmt||"").replace(/[£$€,]/g,"")) || 0;
              const slotKey = `${ri+1}-${sd.slotNum}`;
              seenSlotKeys.add(slotKey);
              const slotDate = String(r[sd.sentIdx]||"").trim();

              // Calculate real total for this job
              let bRealTotal = 0;
              let bRev = rev;
              for (let rj2 = 1; rj2 < activeData.length; rj2++) {
                const r2 = activeData[rj2] || [];
                const rc2 = String(r2[0]||"").trim();
                const rj2n = String(r2[1]||"").trim();
                if (rc2 !== rc || rj2n !== rj) continue;
                if (String(r2[32]||"").trim()) bRev = String(r2[32]||"").trim();
                for (const sd2 of INV_SLOT_DEFS2) {
                  const ref2 = String(r2[sd2.refIdx]||"").trim();
                  const amt2 = parseFloat(String(r2[sd2.amtIdx]||"").replace(/[£$€,]/g,"")) || 0;
                  if (ref2 && !ref2.toUpperCase().startsWith("MANUAL-INV")) bRealTotal += amt2;
                }
              }
              const bNewTotal = bRealTotal + invoiceAmtForMatch;
              const bRevNum   = parseFloat(String(bRev||"0").replace(/[£$€,]/g,"")) || 0;
              const bBudgetFits = bRevNum === 0 || bNewTotal <= bRevNum;
              const bIsExactClient = String(rc||"").trim().toLowerCase() === String(invClient||"").trim().toLowerCase();
              const bStartDate = String(r[37]||"").trim(); // AL
              const amtDiff   = slotAmt > 0 ? (invoiceAmtForMatch - slotAmt) : null;
              const amtNote   = slotAmt > 0
                ? (Math.abs(invoiceAmtForMatch - slotAmt) < 0.01
                  ? "exact amount match"
                  : `slot is £${slotAmt.toFixed(2)}, invoice is £${invoiceAmtForMatch.toFixed(2)} — diff £${Math.abs(amtDiff||0).toFixed(2)}`)
                : "slot amount unknown";
              const overUnder = bRevNum > 0 ? (bNewTotal > bRevNum ? ` (over budget by £${(bNewTotal-bRevNum).toFixed(2)})` : ` (£${(bRevNum-bNewTotal).toFixed(2)} remaining)`) : "";
              const slotLabel = isManual ? "MANUAL-INV placeholder" : "blank placeholder";
              // This path had slotDate available but never actually checked
              // it against the invoice's sent date — dateRangeMatch was
              // hardcoded to "UNKNOWN"/"N/A" regardless of actual
              // proximity. Fixed 20 Aug 2026 alongside the ranking fix below.
              const bDateMatch = dateWithinTolerance(slotDate);

              tier2Options.push({
                optionId: tier2Options.length + 1,
                title: `Place in ${rc} — ${rj||rc} slot ${sd.slotNum} (Row ${ri+1}) — name match, ${slotLabel}, ${amtNote}`,
                matchType: "existing_job",
                jobRow: ri + 1,
                jobName: rj || rc,
                jobRevenue: bRev,
                targetRowNum: ri + 1,
                targetSlotType: "invoice",
                targetSlotNum: sd.slotNum,
                matchingDetails: {
                  // Same fix as the amount-match Tier 2 path above (20 Aug
                  // 2026) — unmatchedJobSummary must hold the job's own true
                  // revenue/start date for row-verification to work, not the
                  // invoice's. bStartDate is available here (read from the
                  // sheet just above), so it's populated correctly rather
                  // than left empty.
                  unmatchedJobSummary: {
                    clientName: invClient, jobName: rj || rc, projectCode: "",
                    revenue: String(bRev || ""), startDate: bStartDate, endDate: "",
                  },
                  matchedJobDetails: {
                    clientName: rc, jobName: rj, projectCode: String(r[2]||""), revenue: bRev, startDate: "", endDate: "",
                  },
                },
                matchAnalysis: {
                  matchConfidence: bDateMatch ? "Medium" : "Low",
                  amountMatch: slotAmt > 0 ? (Math.abs(invoiceAmtForMatch-slotAmt)<0.01 ? "YES" : `PARTIAL — ${amtNote}`) : "UNKNOWN",
                  dateRangeMatch: bDateMatch === null ? (slotDate ? "UNKNOWN" : "N/A") : (bDateMatch ? "YES" : "PARTIAL — outside date tolerance"),
                  projectCodeMatch: "N/A",
                  reasonForChoice: `Job/client name has word overlap with invoice. ${amtNote}. Current real invoiced: £${bRealTotal.toFixed(2)}, new total would be £${bNewTotal.toFixed(2)}${overUnder}.`,
                  discrepancies: amtDiff && Math.abs(amtDiff) > 0.01 ? `Amount mismatch: slot £${slotAmt.toFixed(2)} vs invoice £${invoiceAmtForMatch.toFixed(2)}` : "None",
                  whyItDidntAutoMatch: "Amount does not match within tolerance — presented as lower-confidence option",
                },
                recommendedActions: [
                  `Place invoice ${invoiceRef} (£${invoiceAmtForMatch.toFixed(2)}) in ${rc} — ${rj} slot ${sd.slotNum} (Row ${ri+1}), ${slotLabel}`,
                  [`write ${invoiceAmtForMatch.toFixed(2)} to ${sd.amtCol}${ri+1}`,
                   `write ${invoiceRef} to ${sd.refCol}${ri+1}`,
                   `write ${sentDate||""} to ${sd.sentCol}${ri+1}`,
                   `write ${daysToPayValue||30} to ${sd.daysCol}${ri+1}`,
                   `write ${invoiceStatus||"Sent"} to ${sd.statusCol}${ri+1}`].join(", "),
                ],
                slotBreakdown: {
                  lines: [`Row ${ri+1} Slot ${sd.slotNum}: ${invoiceRef} £${invoiceAmtForMatch.toFixed(2)} ← this invoice (${amtNote})`],
                  correctedTotal: `£${bNewTotal.toFixed(2)}`,
                  currentRevenue: `£${bRevNum.toFixed(2)}`,
                },
                _rankStartDate: bStartDate,
                _rankBudgetFits: bBudgetFits,
                _rankExactClient: bIsExactClient,
                _rankDateMatch: bDateMatch === true,
                _rankPartialClient: fuzzyClientMatch_(invClient, rc),
              });
              if (tier2Options.length >= 5) break; // cap at 5 options total
            }
            if (tier2Options.length >= 5) break;
          }
        }

        // ── Rank options: budget fit → exact client match → most recent job first ──
        const parseRankDate = (d) => {
          if (!d) return null;
          const MONTHS_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
          const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
          if (!m) return null;
          const mIdx = MONTHS_MAP[m[2].toLowerCase()];
          if (mIdx === undefined) return null;
          const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
          return new Date(yr, mIdx, parseInt(m[1])).getTime();
        };
        tier2Options.sort((a, b) => {
          // 1. Budget fit — options that don't exceed job revenue come first
          if (a._rankBudgetFits !== b._rankBudgetFits) return a._rankBudgetFits ? -1 : 1;
          // 2. Exact client name match comes first
          if (a._rankExactClient !== b._rankExactClient) return a._rankExactClient ? -1 : 1;
          // 3. Partial client name match (word overlap, e.g. "Oxford" in
          // both) comes next — added 20 Aug 2026, prompted by Paul asking
          // whether this was considered at all (it wasn't). Uses the shared
          // module-level fuzzyClientMatch_ (also used to decide
          // clientFound above) rather than a second, separate definition —
          // originally a local reuse here, but that turned out to be
          // unreachable from this scope; see fuzzyClientMatch_'s own
          // comment. A completely unrelated client is a stronger
          // disqualifier than a date mismatch, so this ranks above
          // date-match below — mirrors the equivalent fix just made to the
          // expense-matching side's clientOverlap, which was being computed
          // but never actually used in its own ranking either.
          if (a._rankPartialClient !== b._rankPartialClient) return a._rankPartialClient ? -1 : 1;
          // 4. Invoice sent date within tolerance of the slot's expected
          // date comes first — added 20 Aug 2026, confirmed via a live
          // example (Orinoco Communications) where an option with the
          // invoice date 4 months from the slot's expected date outranked
          // one only 5 days off, because date proximity was never
          // considered here at all — only the unrelated signal of which
          // JOB itself started more recently (step 5 below). This is a
          // direct, strong signal of whether the invoice actually belongs
          // to this slot; job recency is a much weaker, indirect one and
          // now only decides remaining ties.
          if (a._rankDateMatch !== b._rankDateMatch) return a._rankDateMatch ? -1 : 1;
          // 5. More recent job (later start date) comes first
          const da = parseRankDate(a._rankStartDate);
          const db = parseRankDate(b._rankStartDate);
          if (da === null && db === null) return 0;
          if (da === null) return 1;
          if (db === null) return -1;
          return db - da;
        });

        // ── Fallback: Manual investigation ────────────────────────────────────
        tier2Options.push({
          optionId: tier2Options.length + 1,
          title: "MANUAL INVESTIGATION REQUIRED — no confident automatic match found",
          matchType: "info",
          matchAnalysis: {
            matchConfidence: "N/A",
            amountMatch: "N/A",
            dateRangeMatch: "N/A",
            projectCodeMatch: "N/A",
            reasonForChoice: "The system could not identify a high-confidence slot match for this invoice. Review manually.",
            discrepancies: `Invoice #${invoiceNo} £${invoiceAmtForMatch.toFixed(2)} sent ${sentDate} for client "${invClient}" job "${invJob}"`,
          },
          recommendedActions: [
            `Review invoice #${invoiceNo} (£${invoiceAmtForMatch.toFixed(2)}, sent ${sentDate}) manually`,
            `Find the matching job in the Confirmed tab and place into the appropriate invoice slot`,
          ],
        });

        // Renumber and cache
        let options = tier2Options.map((o, i) => {
          const { _rankStartDate, _rankBudgetFits, _rankExactClient, _rankDateMatch, _rankPartialClient, ...clean } = o;
          return { ...clean, optionId: i + 1 };
        });
        console.log(`  ✅ System-generated ${options.length} invoice options`);

        // Attach jobRowsData for spreadsheet-style display — cache by row+slot since
        // different options can target the same row with different slots highlighted
        const invJobRowCache = new Map();
        for (const opt of options) {
          if (!opt.jobRow) continue;
          const highlightSlot = (opt.targetSlotType && opt.targetSlotNum)
            ? { type: opt.targetSlotType, rowNum: opt.targetRowNum || opt.jobRow, slotNum: opt.targetSlotNum }
            : null;
          const cacheKey = `${opt.jobRow}-${highlightSlot?.slotNum ?? "none"}`;
          if (!invJobRowCache.has(cacheKey)) {
            invJobRowCache.set(cacheKey, await fetchJobRowsForDisplay(sheets, alert.clientId, "Confirmed", opt.jobRow, highlightSlot, sharedData));
          }
          opt.jobRowsData = invJobRowCache.get(cacheKey);
        }

        const invSummary = `Invoice ${invoiceRef} ${invClient} — ${invJob}`;
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
        });
      } catch (err) {
        console.error("❌ Error generating options:", err);
        res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "accept_option") {
      // Accept an option and write changes to the client sheet
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

        // ── IGNORE — mark alert as ignored in AlertMemory ────────────────────
        if (option.matchType === "ignore") {
          console.log(`  → Ignoring alert (CRM not_found — job is legitimate)`);
          await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
          const memRows = await readAlertMemory(sheets, automationCommanderSheetId);
          const fp = alert.fingerprintHash || buildAlertFingerprint(alert);
          const mr = findMemoryRow(memRows, fp);
          const alertSummary = `CRM ${alert.alertType} ${alert.clientName} — ${option.jobName || ""}`.trim();
          const dataSnapshot = JSON.stringify({ alertType: alert.type || alert.flagType || "", flagType: alert.flagType || "", masterSheetId: alert.masterSheetId || "" });
          if (mr) {
            await updateAlertMemoryRow(sheets, automationCommanderSheetId, mr.rowIndex, { ...mr, status: "ignored", ignoreReason: "Accepted IGNORE option — job is legitimate", dataSnapshot });
          } else {
            await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
              fingerprintHash: fp, alertType: alert.type || alert.flagType || "crm",
              clientName: alert.clientName || "", alertSummary,
              cachedOptionsJSON: "", status: "ignored",
              ignoreReason: "Accepted IGNORE option — job is legitimate", dataSnapshot,
            });
          }
          await sheets.spreadsheets.values.append({
            spreadsheetId: automationCommanderSheetId, range: "TriageLog!A:H",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[new Date().toISOString(), alert.type || alert.flagType, `${alert.sheetName}-${alert.rowNumber}`, alert.clientName || "", "", JSON.stringify({ jobName: option.jobName }), "IGNORED", option.title]] },
          });
          return res.status(200).json({ success: true, message: "Alert marked as ignored", cellsWritten: 0 });
        }

        // ── DELETE — blank all cells for the job in Pipeline/Confirmed tab ──
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
          const summary2 = `CRM ${alert.alertType} ${alert.clientName} — ${option.jobName || ""}`.trim();
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

          const result = await writeOutgoingsExpense(sheets, alert.clientId, option.outgoingsData);
          console.log(`  ✅ Outgoings write complete: row ${result.sheetRow}, col ${result.colLetter}, £${result.prevValue} → £${result.newValue}`);

          // Log to TriageLog
          const timestamp = new Date().toISOString();
          const logRow = [
            timestamp,
            alert.type || alert.flagType,
            `${alert.sheetName}-${alert.rowNumber}`,
            alert.clientName || "",
            alert.summary?.amount || "",
            JSON.stringify({ matchAnalysis: option.matchAnalysis, outgoingsData: option.outgoingsData }),
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
              clientName:    String(f.clientName || alert.summary?.client || "").trim(),
              jobName:       String(f.jobName || f.jobDescription || option.jobName || "").trim(),
              projectCode:   String(f.projectCode || "").trim(),
              revenue:       parseAmt(f.totalRevenue || f.revenue || alert.summary?.amount || ""),
              directCosts:   "0",
              vatYesNo:      String(f.vatYesNo || f.vat || f.vatStatus || "No").trim(),
              projectType:   String(f.jobType || f.projectType || "Project").trim(),
              startDate:     String(f.startDate || alert.summary?.sentDate || "").trim(),
              endDate:       String(f.endDate || "").trim(),
              inv1Ref:       String(alert.summary?.invoiceNo || "").trim(),
              inv1Amount:    parseAmt(alert.summary?.amount || ""),
              inv1SentDate:  String(alert.summary?.sentDate || "").trim(),
              inv1DaysToPay: String(f.daysToPayValue || "30").trim(),
              inv1Status:    String(alert.summary?.status || "").trim(),
            };
            console.log(`  Reconstructed newJobData from facts: ${JSON.stringify(option.newJobData)}`);
          }

          // Read Confirmed tab to find next available row
          const confirmedResp = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Confirmed!A1:AM5000",
          });
          const confirmedRows = confirmedResp.data.values || [];

          // Find the last row with any data in key columns (A, B, AG, AL)
          let lastDataRow = 1;
          for (let i = confirmedRows.length - 1; i >= 1; i--) {
            const r = confirmedRows[i] || [];
            if (r[0] || r[1] || r[32] || r[37]) {
              lastDataRow = i + 1; // 1-indexed
              break;
            }
          }
          const newRow = lastDataRow + 1;
          console.log(`  Next available row: ${newRow}`);

          // Parse cell updates from newJobData (structured) or fall back to text parsing
          const createCellUpdates = [];

          if (option.newJobData && typeof option.newJobData === "object") {
            // Primary path: Claude returned structured newJobData — map fields to columns
            const d = option.newJobData;
            const strVal = (v) => String(v ?? "").trim();
            const numVal = (v) => String(v ?? "").replace(/[£,]/g, "").trim();

            const fieldMap = [
              ["A",  strVal(d.clientName)],
              ["B",  strVal(d.jobName)],
              ["C",  strVal(d.projectCode)],
              ["AG", numVal(d.revenue)],
              ["AH", numVal(d.directCosts || "0")],
              ["AI", strVal(d.vatYesNo)],
              ["AJ", strVal(d.projectType)],
              ["AL", strVal(d.startDate)],
              ["AM", strVal(d.endDate)],
              // Inv1
              ["AP", numVal(d.inv1Amount)],
              ["AQ", strVal(d.inv1Ref)],
              ["AR", strVal(d.inv1SentDate)],
              ["AS", strVal(d.inv1DaysToPay)],
              ["AT", strVal(d.inv1Status)],
              // Inv2 (if present)
              ["AW", numVal(d.inv2Amount || "")],
              ["AX", strVal(d.inv2Ref || "")],
              ["AY", strVal(d.inv2SentDate || "")],
              ["AZ", strVal(d.inv2DaysToPay || "")],
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
          const MONTHS_NEW = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const sanitiseNew = (val) => {
            let v = String(val ?? "");
            if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
            const jsDateMatch = v.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\w{3})\s+(\d{1,2})\s+(\d{4})/);
            if (jsDateMatch) {
              const day = jsDateMatch[2].padStart(2, "0");
              const yr  = jsDateMatch[3].slice(-2);
              return `${day}-${jsDateMatch[1]}-${yr}`;
            }
            const isoMatch = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
            if (isoMatch) {
              const month = MONTHS_NEW[parseInt(isoMatch[2], 10) - 1] || isoMatch[2];
              return `${isoMatch[3]}-${month}-${isoMatch[1].slice(-2)}`;
            }
            return v;
          };

          const writeTab = (alert.type === "crm" || alert.sheetName === "CRMComp")
            ? (alert.mode === "Pipeline" ? "Pipeline" : "Confirmed")
            : "Confirmed";

          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: alert.clientId,
            requestBody: {
              data: createCellUpdates.map(({ cell, value }) => ({
                range: `${writeTab}!${cell}`,
                values: [[sanitiseNew(value)]],
              })),
              valueInputOption: "USER_ENTERED",
            },
          });

          console.log(`  ✅ Created new job at row ${newRow} with ${createCellUpdates.length} fields`);

          // Log to TriageLog
          // Log to TriageLog and update AlertMemory — failures here don't affect the user
          try {
            const timestamp = new Date().toISOString();
            await sheets.spreadsheets.values.append({
              spreadsheetId: automationCommanderSheetId,
              range: "TriageLog!A:H",
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[
                timestamp, alert.type || alert.flagType,
                `${alert.sheetName}-${alert.rowNumber}`,
                alert.clientName || "",
                alert.summary?.amount || "",
                JSON.stringify({ matchAnalysis: option.matchAnalysis }),
                "ACCEPTED", `Created new job at row ${newRow}: ${option.title}`,
              ]] },
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
                // e.g. "to CI51, write Received" — this means the regex caught too much
                if (/[A-Z]{1,3}\d+/.test(value)) {
                  console.log(`  ⚠ Skipping malformed write action — value "${value}" contains cell reference`);
                  continue;
                }
                // Strip surrounding quotes if Claude wrapped the value in them
                value = value.replace(/^["']|["']$/g, '').trim();
                // Allow empty string writes — these are intentional slot clears (e.g. clearing a MANUAL-INV placeholder)
                if (cell && value !== undefined) cellUpdates.push({ cell, value });
              }
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
              alertType === "crm"    || alert.sheetName === "CRMComp") {

            // Determine which tab the cell references point to
            const verifyTab = (alertType === "crm" || alert.sheetName === "CRMComp")
              ? (alert.mode === "Pipeline" ? "Pipeline" : "Confirmed")
              : "Confirmed";

            // Extract the expected row number from the first cell reference
            // e.g. "AP52" → row 52
            const firstCell = cellUpdates[0]?.cell || "";
            const firstRowMatch = firstCell.match(/^[A-Z]+(\d+)$/);
            if (firstRowMatch) {
              const expectedRow = parseInt(firstRowMatch[1], 10);

              // Determine the expected job name from the option
              const expectedJobName = (option.jobName || option.matchingDetails?.unmatchedJobSummary?.jobName || "").trim().toLowerCase();
              const expectedClient  = (option.matchingDetails?.unmatchedJobSummary?.clientName || alert.clientName || "").trim().toLowerCase();

              if (expectedJobName) {
                // Re-read the Confirmed/Pipeline tab fresh — cols A:AM covers client, job, revenue (AG), start date (AL)
                const verifyResp = await sheets.spreadsheets.values.get({
                  spreadsheetId: alert.clientId,
                  range: `${verifyTab}!A1:AM5000`,
                });
                const verifyRows = verifyResp.data.values || [];

                // Check if the expected row still has the right job
                const currentRow = verifyRows[expectedRow - 1] || [];
                const currentClient  = String(currentRow[0] || "").trim().toLowerCase();
                const currentJob     = String(currentRow[1] || "").trim().toLowerCase();
                const currentRevenue = String(currentRow[32] || "").trim(); // AG = index 32
                const currentStart   = String(currentRow[37] || "").trim(); // AL = index 37

                // Expected revenue and start date from the option
                const expectedRevenue = String(option.matchingDetails?.unmatchedJobSummary?.revenue || "").trim();
                const expectedStart   = String(option.matchingDetails?.unmatchedJobSummary?.startDate || "").trim();

                const jobMatches = (r) => {
                  const rJob     = String(r[1] || "").trim().toLowerCase();
                  const rRevenue = String(r[32] || "").trim();
                  const rStart   = String(r[37] || "").trim();
                  if (rJob !== expectedJobName) return false;
                  if (expectedRevenue && rRevenue && rRevenue !== expectedRevenue) return false;
                  if (expectedStart   && rStart   && rStart   !== expectedStart)   return false;
                  return true;
                };

                if (!jobMatches(currentRow)) {
                  // Row has shifted — find the job by name + revenue + start date
                  console.log(`  ⚠️ Job not at expected row ${expectedRow}.`);
                  console.log(`  Expected: job="${expectedJobName}" revenue="${expectedRevenue}" start="${expectedStart}"`);
                  console.log(`  Found at row ${expectedRow}: job="${String(currentRow[1]||"").trim()}" revenue="${String(currentRow[32]||"").trim()}" start="${String(currentRow[37]||"").trim()}"`);
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
                      console.log(`  Nearby row ${i+1}: client="${String(r[0]||"").trim()}" job="${String(r[1]||"").trim()}" revenue="${String(r[32]||"").trim()}" start="${String(r[37]||"").trim()}"`);
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
        const writeTab = (alert.type === "crm" || alert.sheetName === "CRMComp")
          ? (alert.mode === "Pipeline" ? "Pipeline" : "Confirmed")
          : "Confirmed";
        
        // Batch write all cells, always prefixed with the tab name
        if (cellUpdates.length > 0) {

          // Sanitise values before writing:
          // 1. Strip surrounding quotes — Claude sometimes writes "" for empty, which would
          //    appear as literal quote characters in the sheet rather than a blank cell.
          // 2. Reformat JS date strings (e.g. "Mon Mar 23 2026 00:00:00 GMT+0000") to "23-Mar-26"
          const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
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
              const day   = jsDateMatch[2].padStart(2, "0");
              const year  = jsDateMatch[3].slice(-2);
              return `${day}-${month}-${year}`;
            }
            // Also handle ISO date strings (e.g. "2026-03-23T00:00:00.000Z")
            const isoDateMatch = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
            if (isoDateMatch) {
              const year  = isoDateMatch[1].slice(-2);
              const month = MONTHS[parseInt(isoDateMatch[2], 10) - 1] || isoDateMatch[2];
              const day   = isoDateMatch[3];
              return `${day}-${month}-${year}`;
            }
            return v;
          };

          // Columns that must always be stored as text, never as numbers.
          // Invoice references (AQ/AX/BE), App IDs (BX/CF/CN), project codes (AC),
          // client name (A), job name (B), VAT setting (AI).
          const TEXT_ONLY_COLS = new Set(["A","B","AC","AI","AQ","AX","BE","BX","CF","CN"]);
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
    } else if (action === "delete_job") {
      // Blank out all cells for a job (parent + child rows) in the Confirmed or Pipeline tab.
      // NEVER deletes rows — only clears cell content.
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
          return res.status(400).json({ success: false, error: "Cannot delete: clientSheetId missing from alert — please re-analyse this alert and try again." });
        }

        // Only read cols A:B (client, job) and AG (revenue — to identify parent vs child)
        // This is much faster than reading A1:CR2000
        const tabResp = await sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${tabName}!A1:AG2000`,
          valueRenderOption: "UNFORMATTED_VALUE",
        });
        const tabRows = tabResp.data.values || [];
        console.log(`  Tab read complete, ${tabRows.length} rows`);

        const targetClient = (option.matchingDetails?.unmatchedJobSummary?.clientName || "").trim().toLowerCase();
        const targetJob = (option.jobName || "").trim().toLowerCase();
        const targetCode = (option.matchingDetails?.unmatchedJobSummary?.projectCode || "").trim().toLowerCase();

        // Pipeline tab: client name only appears on parent rows — propagate to child rows
        let parentRowIdx = -1;
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

        if (parentRowIdx === -1) {
          const sample = tabRows.slice(1,4).map(r => `"${r[0]||""}/${r[1]||""}"`).join(", ");
          return res.status(404).json({
            success: false,
            error: `Job "${option.jobName}" not found in ${tabName} tab — client name or job name may not match exactly. Nearby rows: ${sample}`,
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
          if (nc === targetClient && nj === targetJob && !next[32] && !next[33] && !next[37]) {
            rowsToBlank.push(ci);
            ci++;
          } else { break; }
        }
        console.log(`  Rows to blank: ${rowsToBlank.map(r => r + 1).join(", ")} (${rowsToBlank.length} rows)`);

        // Build column ranges to blank: A:G (1-7), AG:AM (33-39), AN (40), AP:BH (42-60), BX:CR (76-96), DD (108)
        // AN = likelihood (40), DD = "Copied to Confirmed?" (108) — Pipeline-specific fields
        // In A1 notation: colNum is 1-indexed
        const colRanges = [
          [1, 7],    // A:G
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

        // Use batchClear (not batchUpdate with "") — batchClear truly empties cells,
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

        return res.status(200).json({
          success: true,
          message: `Job "${option.jobName}" blanked across ${rowsToBlank.length} row(s) in ${tabName} tab`,
          rowsBlank: rowsToBlank.map(r => r + 1),
        });
      } catch (err) {
        console.error(`❌ Error in delete_job:`, err);
        return res.status(500).json({ success: false, error: `Failed to delete job: ${err.message}` });
      }

    } else if (action === "analyze_noaction_flag") {
      // Analyze a non-actionable flag by reading the client's AutoLog tab (master sheet)
      // to identify exactly which jobs were affected, then verify them.
      // Supported flagTypes: crmCopiedConfChecked, crmCopiedConfUnchecked, retainerInvoicesCreated
      //
      // targetLine (26 Aug 2026, Paul's direction — proposal 2): when provided
      // (the exact AutoLog line text, already stored as the AlertMemory row's
      // alertSummary since that's how detection fingerprinted it), restricts
      // analysis to that one specific instance instead of scanning the whole
      // window for every possibly-relevant entry. Every one of the 6 rich
      // types' parsing/verification logic below is completely unchanged —
      // each already naturally produces a single-job result when only one
      // line is present to match, so narrowing the input alone is sufficient
      // and carries none of the risk a rewrite of that logic would.
      const { clientSheetId, masterSheetId, automationCommanderSheetId: acId, flagType, clientName, targetLine } = req.body;

      if (!clientSheetId || !masterSheetId || !acId || !flagType) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }

      try {
        console.log(`\n🔍 Analyzing non-actionable flag: ${flagType} for ${clientName}${targetLine ? " (targeted instance)" : ""}`);
        const sheets = await getSheetsClient();
        const masterSheetIdClean = extractSheetIdFromUrl(masterSheetId) || masterSheetId;
        const clientSheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
        const acIdClean = extractSheetIdFromUrl(acId) || acId;

        // ── Step 1: Find when this flag type was last resolved for this client ────
        // Skipped entirely when targetLine is provided — a lookback window is
        // meaningless once we're targeting one already-known, specific line;
        // it either exists in AutoLog or it doesn't. Saves the extra
        // AlertMemory read too.
        let windowStart = new Date(0); // epoch — no-op filter, overridden below when not targeted

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
            console.log(`  ℹ No prior resolution found in AlertMemory — using 90-day window from ${windowStart.toISOString()}`);
          }
        }

        // ── Step 2: Read AutoLog and filter to entries after windowStart ──────────
        // AutoLog col A=Timestamp, B=Category, C=Summary, D=Details
        console.log(`  📖 Reading AutoLog from master sheet...`);
        const autoLogResp = await sheets.spreadsheets.values.get({
          spreadsheetId: masterSheetIdClean,
          range: "AutoLog!A2:D5000",
          valueRenderOption: "UNFORMATTED_VALUE",
        });
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

        // Narrow to the one specific instance (26 Aug 2026, proposal 2) — every
        // branch below still scans/matches within autoLogRows exactly as
        // before, but now only one row (at most) is ever present to match,
        // since only rows whose Details genuinely contain this exact line
        // survive this filter. This is the entire mechanism that turns a
        // whole-window scan into a single-instance check, without touching
        // any of that per-type logic itself.
        if (targetLine) {
          autoLogRows = allAutoLogRows
            .filter(row => String(row[3] || "").includes(targetLine))
            .map(row => {
              // Replace Details with just the target line — a row's Details
              // can bundle several distinct lines from one automation run
              // (joined with "\n\n"), so filtering by row alone isn't
              // precise enough if the same row happens to contain more than
              // one line matching a given type's pattern (e.g. two jobs
              // copied in the same run). This guarantees every branch's
              // internal line-splitting logic below sees exactly this one
              // line, whatever else was originally bundled alongside it.
              const copy = row.slice();
              copy[3] = targetLine;
              return copy;
            });
          console.log(`  ✓ Narrowed to ${autoLogRows.length} AutoLog row(s) containing the target line`);
        }

        const results = [];

        if (flagType === "crmCopiedConfChecked" || flagType === "crmCopiedConfUnchecked") {
          const expectCopied = flagType === "crmCopiedConfChecked";

          // Read all CRM AutoLog entries — the Details field contains the full structured log
          // The flag is raised when Pipeline col DD changes to 'Yes'.
          // The GAS code writes this at line 293: "Copied Status: 'X' -> 'Yes'"
          // as part of an "Updated Pipeline: Row N, Client | Job - ... Copied Status: ..." entry.
          // "Copied Pipeline Project to Confirmed:" is only written if B82="yes" (auto-copy enabled).
          // "Created New Confirmed Job:" is a direct Confirmed creation, unrelated to this flag.
          const allCRMEntries = autoLogRows.filter(row => String(row[1] || "").toLowerCase().includes("crm"));
          console.log(`  ✓ ${allCRMEntries.length} CRM AutoLog entries total`);

          const relevantEntries = allCRMEntries.filter(row => {
            const details = String(row[3] || "");
            if (expectCopied) {
              // Pipeline DD changed to Yes — the direct trigger for this flag
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
            // Deduplicate by clientParsed + jobName
            const seen = new Set();
            const deduped = affectedJobs.filter(j => {
              const key = `${j.clientParsed}|||${j.jobName}`;
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
            const recentDetails = allCRMEntries.slice(0, 3).map(r => `[${r[0]}] ${String(r[3]||"").slice(0,200)}`).join("\n");
            results.push({
              status: "info",
              message: `No specific jobs identified in AutoLog for this flag. ${relevantEntries.length} potentially relevant CRM entries found.`,
              detail: recentDetails || "No CRM entries in AutoLog.",
            });
          } else {
            // Read Pipeline and Confirmed tabs to verify
            const pipelineResp = await sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Pipeline!A6:DE5000",
            });
            const pipelineRows = pipelineResp.data.values || [];

            const confirmedResp = await sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Confirmed!A1:C5000",
            });
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
                const jobNameLower   = job.jobName.toLowerCase();
                const clientParsedLower = job.clientParsed ? job.clientParsed.toLowerCase() : "";

                // Primary: use the row number from the AutoLog (most reliable)
                if (job.pipelineRowFromLog) {
                  const prIdx = job.pipelineRowFromLog - 6; // Pipeline data starts at row 6, index 0 = row 6
                  const pr = prIdx >= 0 ? pipelineRows[prIdx] : null;
                  if (pr) {
                    const prJobName    = String(pr[1] || "").trim();
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
                      console.log(`  ⚠️ Pipeline row ${job.pipelineRowFromLog} has "${prJobName}" / "${prClientName}" — expected "${job.jobName}" / "${job.clientParsed}". Row may have shifted — falling back to name search.`);
                    }
                  }
                }

                // Fallback: search by job name + client name (skipped when job name is blank/placeholder)
                if (!pipelineJob) {
                  const jobNameIsBlank = !jobNameLower || jobNameLower === "-";
                  for (let pri = 0; pri < pipelineRows.length; pri++) {
                    const pr = pipelineRows[pri];
                    const pJobName    = String(pr[1] || "").trim();
                    const pClientName = String(pr[0] || "").trim();
                    // If job name is blank/placeholder, match on client name only (less reliable — only use as last resort)
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
                  checks.push({ ok: false, message: `✗ CRITICAL: Job "${job.jobName}" not found in Pipeline — cannot verify DD was set to Yes` });
                  allOk = false;
                } else {
                  const ddVal = pipelineJob.copiedToConf.toLowerCase();
                  const ddOk = ddVal === "yes" || ddVal === "true";
                  const pRowStr = pipelineJob.rowNumber ? ` (Pipeline row ${pipelineJob.rowNumber})` : "";
                  const cliStr = pipelineJob.clientName ? ` — ${pipelineJob.clientName}` : "";
                  checks.push({
                    ok: ddOk,
                    message: ddOk
                      ? `✓ Pipeline col DD ("Copied to confirmed?"): Yes${pRowStr}${cliStr}`
                      : `✗ CRITICAL: Pipeline col DD is "${pipelineJob.copiedToConf}" — expected Yes${pRowStr}${cliStr}. The copy may not have registered correctly.`,
                  });
                  if (!ddOk) allOk = false;
                }

                // Secondary check: job exists in Confirmed — search by project code first, then job+client name
                // Row numbers are unreliable (rows can shift), so we match on col C (project code) or cols A+B
                const pipelineProjectCode = pipelineJob?.projectCode || "";
                // Use the resolved client name from pipelineJob (more reliable than AutoLog-parsed clientParsed)
                const resolvedClientLower = (pipelineJob?.clientName || "").toLowerCase() || clientParsedLower;
                for (let cri = 0; cri < confirmedRows.length; cri++) {
                  const cr = confirmedRows[cri];
                  const crJobName     = String(cr[1] || "").trim();
                  const crClientName  = String(cr[0] || "").trim();
                  const crProjectCode = String(cr[2] || "").trim();
                  // Primary match: project code (most reliable, unique per job)
                  if (pipelineProjectCode && crProjectCode && crProjectCode.toLowerCase() === pipelineProjectCode.toLowerCase()) {
                    confirmedMatch = { jobName: crJobName, projectCode: crProjectCode, clientName: crClientName, rowNumber: cri + 1 };
                    break;
                  }
                  // Fallback: job name + client name (skip if job name is blank/placeholder)
                  const jobNameIsBlankConf = !jobNameLower || jobNameLower === "-";
                  if (jobNameIsBlankConf) continue; // can't match on blank name — project code is the only key
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
                const clientStr = pipelineJob?.clientName ? ` — ${pipelineJob.clientName}` : "";

                checks.push({
                  ok: confExists,
                  message: confExists
                    ? `✓ Confirmed tab: "${confirmedMatch.jobName}"${confirmedMatch.projectCode ? ` (${confirmedMatch.projectCode})` : ""}${confirmedRowStr}${pipelineRowStr}${clientStr} found`
                    : pipelineProjectCode
                      ? `✗ Confirmed tab: job "${job.jobName}" not found by project code (${pipelineProjectCode}) or name — Confirmed col C may be blank for this job, or copy may have failed`
                      : `✗ Confirmed tab: job "${job.jobName}" not found — copy may have failed`,
                });
                if (!confExists) allOk = false;

              } else {
                // UNchecked: Pipeline DD should be No/blank, job should NOT be in Confirmed
                const jobNameLower = job.jobName ? job.jobName.toLowerCase() : "";
                const clientParsedLower = job.clientParsed ? job.clientParsed.toLowerCase() : "";
                const jobNameIsBlank = !jobNameLower || jobNameLower === "-";

                // Look up Pipeline row — use log row number first, then name search
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
                  const cliStr = pipelineJob.clientName ? ` — ${pipelineJob.clientName}` : "";
                  checks.push({
                    ok: ddOk,
                    message: ddOk
                      ? `✓ Pipeline col DD: "${pipelineJob.copiedToConf || "blank"}" — No/blank (correct)${pRowStr}${cliStr}`
                      : `✗ CRITICAL: Pipeline col DD is "${pipelineJob.copiedToConf}" — expected No or blank${pRowStr}${cliStr}`,
                  });
                  if (!ddOk) allOk = false;
                } else {
                  checks.push({ ok: false, message: `✗ Job "${job.jobName}" not found in Pipeline tab` });
                  allOk = false;
                }

                // Check Confirmed — search by project code first, then job+client name
                const uncheckedProjectCode = pipelineJob?.projectCode || "";
                for (let cri = 0; cri < confirmedRows.length; cri++) {
                  const cr = confirmedRows[cri];
                  const crJobName    = String(cr[1] || "").trim();
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
                const confCliStr = confirmedMatch?.clientName ? ` — ${confirmedMatch.clientName}` : "";
                checks.push({
                  ok: !inConfirmed,
                  message: !inConfirmed
                    ? `✓ Confirmed tab: job not present (correct)`
                    : `✗ "${confirmedMatch.jobName || job.jobName}"${confirmedMatch.projectCode ? ` (${confirmedMatch.projectCode})` : ""}${confRowStr}${confCliStr} still exists in Confirmed — should have been removed`,
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
            console.log(`  ↩ Fell back to full AutoLog — found ${retainerLogEntriesToUse.length} entries`);
          }
          for (const entry of retainerLogEntriesToUse) {
            console.log(`    [${entry[0]}] Details="${String(entry[3]||"").slice(0, 400)}"`);
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
                affectedRetainerJobs.push({
                  tab:               m[1].trim(),   // "Confirmed" or "Pipeline"
                  childRowsCreated:  parseInt(m[2], 10),
                  logSheetRow:       parseInt(m[3], 10),
                  clientNameFromLog: m[4].trim(),
                  jobName:           m[5].trim(),
                  logTimestamp:      String(entry[0] || "")
                });
              }

              // Format B (old): "Row N, ClientName, JobName: Added N invoice rows"
              if (affectedRetainerJobs.length === 0) {
                const oldPattern = /Row\s+(\d+),\s+([^,]+),\s+([^:]+):\s+Added\s+\d+\s+invoice rows/gi;
                while ((m = oldPattern.exec(details)) !== null) {
                  affectedRetainerJobs.push({
                    logSheetRow: parseInt(m[1], 10),
                    clientNameFromLog: m[2].trim(),
                    jobName: m[3].trim(),
                    logTimestamp: String(entry[0] || "")
                  });
                }
              }
            }
            // Deduplicate by jobName (row numbers are unreliable after row shifts)
            const seenJobs = new Set();
            const dedupedJobs = affectedRetainerJobs.filter(j => {
              const key = `${j.clientNameFromLog}___${j.jobName}`;
              if (seenJobs.has(key)) return false;
              seenJobs.add(key);
              return true;
            });
            console.log(`  ✓ Parsed ${dedupedJobs.length} affected retainer jobs: ${JSON.stringify(dedupedJobs)}`);

            // Read Confirmed tab
            const retConfirmedResp = await sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Confirmed!A1:BH5000",
            });
            const retConfirmedRows = retConfirmedResp.data.values || [];

            const retPipelineResp = await sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Pipeline!A6:BH5000",
            });
            const retPipelineRows = retPipelineResp.data.values || [];

            const retainerChecks = [];

            for (const job of dedupedJobs) {
              const targetTab   = job.tab || "Confirmed"; // default to Confirmed for old-format entries
              const tabRows     = targetTab === "Pipeline" ? retPipelineRows : retConfirmedRows;
              const tabStartRow = targetTab === "Pipeline" ? 6 : 1; // Pipeline data starts at row 6

              // Find the parent row by matching client name AND job name.
              // If the AutoLog has a row number, try that first (most reliable).
              // If multiple rows match the same client+job name, warn rather than
              // silently picking the wrong one.
              const jobNameLower = job.jobName.toLowerCase();
              const clientLower  = job.clientNameFromLog.toLowerCase();
              let parentRowIdx   = -1;
              const allMatchingIdxs = [];

              // First try: use row number from AutoLog if available
              if (job.logSheetRow) {
                const logIdx = job.logSheetRow - tabStartRow;
                if (logIdx >= 0 && logIdx < tabRows.length) {
                  const r = tabRows[logIdx];
                  const rClient = String(r[0] || "").trim().toLowerCase();
                  const rJob    = String(r[1] || "").trim().toLowerCase();
                  if (rClient === clientLower && rJob === jobNameLower) {
                    parentRowIdx = logIdx;
                    console.log(`  ✓ Matched by row number: ${job.logSheetRow}`);
                  } else {
                    console.log(`  ⚠ Row ${job.logSheetRow} has "${r[1]}"/"${r[0]}" — expected "${job.jobName}"/"${job.clientNameFromLog}" — row may have shifted, falling back to name search`);
                  }
                }
              }

              // Second: name search — collect ALL matches to detect duplicates
              if (parentRowIdx === -1) {
                for (let ri = 0; ri < tabRows.length; ri++) {
                  const r       = tabRows[ri];
                  const rClient = String(r[0] || "").trim().toLowerCase();
                  const rJob    = String(r[1] || "").trim().toLowerCase();
                  const hasRevenue = !!(r[32]);
                  if (rClient === clientLower && rJob === jobNameLower && hasRevenue) {
                    allMatchingIdxs.push(ri);
                  }
                }
                if (allMatchingIdxs.length === 1) {
                  parentRowIdx = allMatchingIdxs[0];
                } else if (allMatchingIdxs.length > 1) {
                  retainerChecks.push({
                    jobName:    job.jobName,
                    clientName: job.clientNameFromLog,
                    status:     "issue",
                    checks:     [{
                      ok: false,
                      message: `✗ Found ${allMatchingIdxs.length} rows matching "${job.clientNameFromLog} | ${job.jobName}" in ${targetTab} (rows ${allMatchingIdxs.map(i => i + tabStartRow).join(", ")}) — cannot reliably identify which row the automation acted on. Ensure jobs have unique names within the same client.`,
                    }],
                  });
                  continue;
                }
              }

              if (parentRowIdx === -1) {
                // Not found in target tab — check the other tab as fallback
                const fallbackTab  = targetTab === "Pipeline" ? "Confirmed" : "Pipeline";
                const fallbackRows = targetTab === "Pipeline" ? retConfirmedRows : retPipelineRows;
                let fallbackIdx    = -1;
                for (let ri = 0; ri < fallbackRows.length; ri++) {
                  const r       = fallbackRows[ri];
                  const rClient = String(r[0] || "").trim().toLowerCase();
                  const rJob    = String(r[1] || "").trim().toLowerCase();
                  if (rClient === clientLower && rJob === jobNameLower) {
                    fallbackIdx = ri;
                    break;
                  }
                }
                if (fallbackIdx !== -1) {
                  const fallbackStartRow = fallbackTab === "Pipeline" ? 6 : 1;
                  retainerChecks.push({
                    jobName:    job.jobName,
                    clientName: job.clientNameFromLog,
                    status:     "info",
                    checks:     [{ ok: true, message: `✓ Job "${job.jobName}" (${job.clientNameFromLog}) moved to ${fallbackTab} tab (row ${fallbackIdx + fallbackStartRow}) — originally created in ${targetTab}` }],
                  });
                } else {
                  retainerChecks.push({
                    jobName:    job.jobName,
                    clientName: job.clientNameFromLog,
                    status:     "issue",
                    checks:     [{ ok: false, message: `✗ Job "${job.jobName}" (${job.clientNameFromLog}) not found in ${targetTab} or ${targetTab === "Pipeline" ? "Confirmed" : "Pipeline"} tabs` }],
                  });
                }
                continue;
              }

              const parentRow    = tabRows[parentRowIdx];
              const clientN      = String(parentRow[0] || "").trim();
              const jobName      = String(parentRow[1] || "").trim();
              const projectCode  = String(parentRow[2] || "").trim();
              const revenue      = parentRow[32];
              const startRaw     = parentRow[37];
              const endRaw       = parentRow[38];
              const confirmedSheetRow = parentRowIdx + tabStartRow;
              console.log(`  Found "${jobName}" (${clientN}) at ${targetTab} row ${confirmedSheetRow}: start="${startRaw}", end="${endRaw}"`);

              // Collect child rows — same tab, immediately after parent
              // Child row: same client+job, no revenue, no start date
              const childRows = [];
              let ci = parentRowIdx + 1;
              while (ci < tabRows.length) {
                const next    = tabRows[ci] || [];
                const nClient = String(next[0] || "").trim().toLowerCase();
                const nJob    = String(next[1] || "").trim().toLowerCase();
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
                  // JS Date treats 2-digit years as 1900s — correct to 2000s for years < 100
                  if (v.getFullYear() < 100) v.setFullYear(v.getFullYear() + 2000);
                  return v;
                }
                // Handle DD-Mon-YY or DD-Mon-YYYY strings e.g. "31-Jul-50", "1-May-2026"
                const monMap = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
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
                  message: `No start/end dates set on this retainer — cannot verify invoice coverage`,
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

              // ── Single-row retainer detection ────────────────────────────────
              // Mode A: parent row has invoice in slot 1 (col AP = index 41), no child rows needed.
              // This is a single-invoice retainer — check the parent's own slot 1.
              const parentInvAmt = parseFloat(String(parentRow[41] || "").replace(/[£$€,\s]/g, "")) || 0;
              const parentInvRef = String(parentRow[42] || "").trim();
              const isSingleRowRetainer = childRows.length === 0 && (parentInvAmt > 0 || parentInvRef);

              if (isSingleRowRetainer) {
                const hasInvoice = parentInvAmt > 0;
                const fmt = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
                const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
                const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
                const monthsDiff = Math.max(1, Math.round(diffDays / 30.4375));
                checks.push({ ok: true, message: `Duration: ${fmt(startDate)} → ${fmt(endDate)} (${monthsDiff} months total, single invoice)` });
                checks.push({ ok: true, message: `Single-row retainer (Mode A) — invoice sits on parent row, no child rows expected` });
                if (hasInvoice) {
                  checks.push({ ok: true, message: `✓ Parent row slot 1 has invoice amount £${parentInvAmt.toFixed(2)}${parentInvRef ? ` (ref: ${parentInvRef})` : ""}` });
                } else {
                  checks.push({ ok: false, message: `✗ Parent row slot 1 has no invoice amount — invoice not yet created` });
                }
                retainerChecks.push({
                  jobName, clientName: clientN, projectCode,
                  parentSheetRow: confirmedSheetRow,
                  tab: targetTab,
                  status: hasInvoice ? "ok" : "issue",
                  periodLabel: "single invoice", checks,
                });
                continue;
              }

              // Count child rows whose scheduled invoice date (Inv1 sent-date slot) falls
              // in or before the current calendar month — these are "past + current" rows.
              // Expected = that count + 18 future rows (adjusted for period frequency).
              const parseConfirmedDate = (val) => {
                if (!val) return null;
                if (val instanceof Date) return val;
                const s = String(val).trim();
                // Handle DD-Mon-YY format e.g. "1-Apr-26"
                const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
                if (m) {
                  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
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

              const remainingTime = Math.max(0, endDate.getTime() - today.getTime());
              const remainingDays = Math.round(remainingTime / (1000 * 60 * 60 * 24));
              const monthsRemainingInContract = Math.round(remainingDays / 30.4375);

              const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
              const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
              const monthsDiff = Math.max(1, Math.round(diffDays / 30.4375));

              // futureRows = months remaining from today, but capped at total contract months.
              // Without the cap, a future-starting contract counts months before its start date.
              const futureRows = Math.min(18 / periodMonths, Math.ceil(Math.min(monthsRemainingInContract, monthsDiff) / periodMonths));
              const expectedChildRows = pastAndCurrentRows + Math.ceil(futureRows);
              const actualChildRows = childRows.length;
              const fmt = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
              const durationOk = actualChildRows >= expectedChildRows;
              checks.push({ ok: true, message: `Duration: ${fmt(startDate)} → ${fmt(endDate)} (${monthsDiff} months total, ${periodLabel})` });
              checks.push({
                ok: durationOk,
                message: `Child rows: ${actualChildRows} found, ${expectedChildRows} expected (${pastAndCurrentRows} past/current + ${Math.ceil(futureRows)} forward) — ` + (durationOk ? "✓ full coverage" : `✗ ${Math.ceil(expectedChildRows - actualChildRows)} row(s) missing`),
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
            console.log(`  ↩ Fell back to full AutoLog — found ${deletedLogEntriesToUse.length} entries`);
          }
          for (const entry of deletedLogEntriesToUse) {
            console.log(`    [${entry[0]}] Details="${String(entry[3]||"").slice(0, 400)}"`);
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
              // Format: "[Retainers] Trimmed N excess child row(s) for CLIENT | JOB"
              const pattern = /Trimmed\s+\d+\s+excess\s+child\s+rows?\([^)]*\)\s*for\s+([^|]+)\s*\|\s*([^\[\n]+)/gi;
              let m;
              while ((m = pattern.exec(details)) !== null) {
                affectedRetainerJobs.push({
                  clientNameFromLog: m[1].trim(),
                  jobName: m[2].trim(),
                  logTimestamp: String(entry[0] || "")
                });
              }
            }

            // Deduplicate by client + job
            const seenJobs = new Set();
            const dedupedJobs = affectedRetainerJobs.filter(j => {
              const key = `${j.clientNameFromLog}|||${j.jobName}`;
              if (seenJobs.has(key)) return false;
              seenJobs.add(key);
              return true;
            });
            console.log(`  ✓ Parsed ${dedupedJobs.length} affected retainer jobs: ${JSON.stringify(dedupedJobs)}`);

            // Read Confirmed tab
            const delConfirmedResp = await sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Confirmed!A1:BH5000",
            });
            const delConfirmedRows = delConfirmedResp.data.values || [];
            const retainerChecks = [];

            for (const job of dedupedJobs) {
              const jobNameLower = job.jobName.toLowerCase();
              const clientLower  = job.clientNameFromLog.toLowerCase();

              // Find parent row by client + job name
              let parentRowIdx = -1;
              for (let ri = 0; ri < delConfirmedRows.length; ri++) {
                const r = delConfirmedRows[ri];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob    = String(r[1] || "").trim().toLowerCase();
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

              const parentRow    = delConfirmedRows[parentRowIdx];
              const parentSheetRow = parentRowIdx + 1;
              const jobClient    = String(parentRow[0] || "").trim();
              const jobName2     = String(parentRow[1] || "").trim();
              const projectCode  = String(parentRow[2] || "").trim();
              const monthlyRevenue = parseFloat(String(parentRow[32] || "0").replace(/[£$€,\s]/g, "")) || 0;
              const jobStart     = String(parentRow[37] || "").trim();
              const jobEnd       = String(parentRow[38] || "").trim();

              console.log(`  Found "${job.jobName}" (${job.clientNameFromLog}) at Confirmed row ${parentSheetRow}: start="${jobStart}", end="${jobEnd}"`);

              // Collect child rows (same client + job, no revenue/start/end)
              const childRows = [];
              for (let ri = parentRowIdx + 1; ri < delConfirmedRows.length; ri++) {
                const r = delConfirmedRows[ri];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob    = String(r[1] || "").trim().toLowerCase();
                if (rClient !== clientLower || rJob !== jobNameLower) break;
                if (r[32] || r[37] || r[38]) break; // has revenue/start/end = another parent
                childRows.push({ row: r, sheetRow: ri + 1 });
              }

              const checks = [];

              // Parse dates
              const parseDate = (s) => {
                if (!s) return null;
                const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
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
              const endDate   = parseDate(jobEnd);

              if (!startDate || !endDate) {
                retainerChecks.push({
                  jobName: jobName2, clientName: jobClient, projectCode,
                  parentSheetRow, status: "info",
                  message: `No start/end dates set on this retainer — cannot verify row coverage`,
                  checks: [],
                });
                continue;
              }

              // Determine period (monthly by default, infer from child row amounts)
              let periodMonths = 1;
              let periodLabel  = "monthly";
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

              // ── Single-row retainer detection ────────────────────────────────
              const parentInvAmt2 = parseFloat(String(parentRow[41] || "").replace(/[£$€,\s]/g, "")) || 0;
              const parentInvRef2 = String(parentRow[42] || "").trim();
              const isSingleRowRetainer2 = childRows.length === 0 && (parentInvAmt2 > 0 || parentInvRef2);

              if (isSingleRowRetainer2) {
                const hasInvoice2 = parentInvAmt2 > 0;
                const fmt2 = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
                const diffTime2b = Math.abs(endDate.getTime() - startDate.getTime());
                const monthsDiff2b = Math.max(1, Math.round(diffTime2b / (1000 * 60 * 60 * 24) / 30.4375));
                checks.push({ ok: true, message: `Duration: ${fmt2(startDate)} → ${fmt2(endDate)} (${monthsDiff2b} months total, single invoice)` });
                checks.push({ ok: true, message: `Single-row retainer (Mode A) — invoice sits on parent row, no child rows expected` });
                if (hasInvoice2) {
                  checks.push({ ok: true, message: `✓ Parent row slot 1 has invoice amount £${parentInvAmt2.toFixed(2)}${parentInvRef2 ? ` (ref: ${parentInvRef2})` : ""}` });
                } else {
                  checks.push({ ok: false, message: `✗ Parent row slot 1 has no invoice amount — invoice not yet created` });
                }
                retainerChecks.push({
                  jobName: jobName2, clientName: jobClient, projectCode,
                  parentSheetRow, status: hasInvoice2 ? "ok" : "issue",
                  periodLabel: "single invoice", checks,
                });
                continue;
              }

              // Rolling 18-month runway: count rows with scheduled date ≤ end of current month
              const parseConfDate = (val) => {
                if (!val) return null;
                if (val instanceof Date) return val;
                const s2 = String(val).trim();
                const months2 = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
                const m3 = s2.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
                if (m3) return new Date(2000 + parseInt(m3[3],10), months2[m3[2]], parseInt(m3[1],10));
                const d = new Date(val); return isNaN(d.getTime()) ? null : d;
              };
              const today2 = new Date();
              const endOfCurrentMonth = new Date(today2.getFullYear(), today2.getMonth() + 1, 0);
              endOfCurrentMonth.setHours(23, 59, 59, 999);
              const pastAndCurrentRows = childRows.filter(({ row: cr }) => {
                const sentDate = parseConfDate(cr[43]);
                return sentDate && sentDate <= endOfCurrentMonth;
              }).length;
              const remainingTime2 = Math.max(0, endDate.getTime() - today2.getTime());
              const remainingDays2 = Math.round(remainingTime2 / (1000 * 60 * 60 * 24));
              const monthsRemaining = Math.round(remainingDays2 / 30.4375);
              const diffTime2 = Math.abs(endDate.getTime() - startDate.getTime());
              const diffDays2 = Math.round(diffTime2 / (1000 * 60 * 60 * 24));
              const monthsDiff = Math.max(1, Math.round(diffDays2 / 30.4375));
              // Cap at total contract months to avoid over-counting for future-starting retainers
              const futureRows = Math.min(18 / periodMonths, Math.ceil(Math.min(monthsRemaining, monthsDiff) / periodMonths));
              const expectedChildRows = pastAndCurrentRows + Math.ceil(futureRows);
              const actualChildRows   = childRows.length;
              const fmt = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });

              const durationOk = actualChildRows === expectedChildRows;
              checks.push({ ok: true, message: `Duration: ${fmt(startDate)} → ${fmt(endDate)} (${monthsDiff} months total, ${periodLabel})` });
              checks.push({
                ok: durationOk,
                message: durationOk
                  ? `✓ Child rows: ${actualChildRows} found, ${expectedChildRows} expected (${pastAndCurrentRows} past/current + ${Math.ceil(futureRows)} forward) — correct count`
                  : `${actualChildRows > expectedChildRows ? "✗ Too many" : "✗ Too few"} child rows: ${actualChildRows} found, ${expectedChildRows} expected (${pastAndCurrentRows} past/current + ${Math.ceil(futureRows)} forward)`,
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
            console.log(`  ↩ Fell back to full AutoLog — found ${staleEntriesToUse.length} stale entries`);
          }

          if (staleEntriesToUse.length === 0) {
            results.push({
              status: "info",
              message: "No stale invoice entries found in AutoLog since flag was last cleared.",
            });
          } else {
            // Each AutoLog row may contain multiple stale invoice lines in col D (details)
            // Parse each line of the form:
            // "[Confirmed] Stale Invoice - Row N, CLIENT | JOB, Slot N: Date moved DD-Mon-YY -> DD-Mon-YY"
            const stalePattern = /\[([^\]]+)\]\s*Stale Invoice\s*[-–]\s*Row\s*(\d+),\s*([^|]+)\|\s*([^,\n]+),\s*Slot\s*(\d+):\s*Date moved\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+)/gi;

            for (const entry of staleEntriesToUse) {
              const details = String(entry[3] || "");
              const timestamp = String(entry[0] || "");
              let match;
              while ((match = stalePattern.exec(details)) !== null) {
                const tab       = match[1].trim();   // "Confirmed"
                const rowNum    = match[2].trim();   // "118"
                const jobClient = match[3].trim();   // "Shopify"
                const jobName   = match[4].trim();   // "Mar 26 sales commission"
                const slotNum   = match[5].trim();   // "1"
                const oldDate   = match[6].trim();   // "28-Mar-26"
                const newDate   = match[7].trim();   // "28-Apr-26"

                results.push({
                  status: "info",
                  stale: true,
                  tab,
                  rowNum: parseInt(rowNum, 10),
                  jobClient,
                  jobName,
                  slotNum: parseInt(slotNum, 10),
                  oldDate,
                  newDate,
                  logTimestamp: timestamp,
                  message: `[${tab}] Row ${rowNum} — ${jobClient} | ${jobName}, Slot ${slotNum}: date moved ${oldDate} → ${newDate}`,
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
            console.log(`  ↩ Fell back to full AutoLog — found ${deleteEntriesToUse.length} entries`);
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
                const rowNum     = match[1].trim();
                const clientName = match[2].trim();
                const jobName    = match[3].trim();
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
              const confirmedResp = await sheets.spreadsheets.values.get({
                spreadsheetId: clientSheetIdClean,
                range: "Confirmed!A1:C5000",
              });
              const confirmedRows = confirmedResp.data.values || [];

              // Read Pipeline tab (cols A:C for lookup, AN for % likelihood, DD for copied status)
              // DD = col 110 (0-indexed), AN = col 39 (0-indexed)
              const pipelineResp = await sheets.spreadsheets.values.get({
                spreadsheetId: clientSheetIdClean,
                range: "Pipeline!A1:DD5000",
              });
              const pipelineRows = pipelineResp.data.values || [];

              for (const job of deletedJobs) {
                const checks = [];
                const jobClientLower = job.clientName.toLowerCase();
                const jobNameLower   = job.jobName.toLowerCase();
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
                  checks.push({ ok: true,  message: `✓ Not found in Confirmed tab — job successfully removed` });
                } else {
                  checks.push({ ok: false, message: `✗ Job still exists in Confirmed tab at row ${confirmedRowIdx + 1} — deletion may have failed` });
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
                  checks.push({ ok: false, message: `⚠ Job not found in Pipeline tab — notable, as deleted Confirmed jobs are usually still in Pipeline` });
                } else {
                  const pipeRow = pipelineRows[pipelineRowIdx];
                  // AN = col 39 (0-indexed), DD = col 109 (0-indexed)
                  // DD is col 110 in 1-indexed: D=4, D=4 → 4*26+4=108? Let me recalculate:
                  // A=1...Z=26, AA=27...AZ=52, BA=53...DD=?
                  // D=4, D=4: (4-1)*26 + 4 = 82? No: col letter to number:
                  // DD: first D=4, second D=4 → (4)*26 + 4 = 108 (1-indexed) → index 107
                  // AN: A=1, N=14 → 1*26+14 = 40 (1-indexed) → index 39
                  const likelihood  = String(pipeRow[39] || "").trim();   // AN
                  const copiedStatus = String(pipeRow[107] || "").trim(); // DD
                  checks.push({
                    ok: true,
                    message: `Job found in Pipeline tab at row ${pipelineRowIdx + 1}` +
                      ` — likelihood: ${likelihood || "(blank)"}` +
                      `, "Copied to conf?" = ${copiedStatus || "(blank)"}`,
                  });
                }

                results.push({
                  status: checks.every(c => c.ok) ? "ok" : "issue",
                  jobName:      job.jobName,
                  clientName:   job.clientName,
                  projectCode:  job.projectCode,
                  confirmedRow: parseInt(job.rowNum, 10),
                  logTimestamp: job.logTimestamp,
                  checks,
                  message: `${job.clientName} | ${job.jobName} (${job.projectCode}) — deleted from Confirmed row ${job.rowNum}`,
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

    } else if (action === "remove_alert") {
      // Remove a specific alert from the Redis session after it's been accepted/ignored.
      const { sessionId, alertId } = req.body;
      if (!sessionId || !alertId) {
        return res.status(400).json({ success: false, error: "Missing sessionId or alertId" });
      }
      try {
        const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
        if (!sessionData) return res.status(200).json({ success: true, notFound: true });
        const parsed = JSON.parse(sessionData);
        const before = parsed.alerts.length + (parsed.proactiveAlerts?.length || 0);
        
        // Sync the Home Screen counts before removing the alert
        const alertToRemove = parsed.alerts.find(a => `${a.sheetName}-${a.rowNumber}` === alertId) 
                           || (parsed.proactiveAlerts || []).find(a => a.alertKey === alertId || a.fingerprintHash === alertId);
                           
        if (alertToRemove && parsed.clientsWithFlags) {
          let flagKey = alertToRemove.flagType || alertToRemove.alertType || alertToRemove.type;
          if (flagKey === "invoice") flagKey = "invoiceDashboardDiscr";
          if (flagKey === "expense") flagKey = "expenseDashboardDiscr";
          if (flagKey === "crm") flagKey = alertToRemove.alertType || "crmPipeAppDiscr";

          parsed.clientsWithFlags = parsed.clientsWithFlags.map(c => {
            if (c.clientName === alertToRemove.clientName && c.alertCounts && c.alertCounts[flagKey]) {
              c.alertCounts[flagKey] = Math.max(0, c.alertCounts[flagKey] - 1);
            }
            return c;
          });
        }

        parsed.alerts = parsed.alerts.filter(a => `${a.sheetName}-${a.rowNumber}` !== alertId);
        if (parsed.proactiveAlerts) {
          parsed.proactiveAlerts = parsed.proactiveAlerts.filter(a => a.alertKey !== alertId && a.fingerprintHash !== alertId);
        }
        
        const removed = before - (parsed.alerts.length + (parsed.proactiveAlerts?.length || 0));
        await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 3600 });
        console.log(`  remove_alert: removed ${removed} alert(s) matching "${alertId}" from session`);
        return res.status(200).json({ success: true, removed });
      } catch (err) {
        console.error("❌ Error removing alert from session:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "update_session_flags") {
      // After clearing flags for a client, update both the session and precomputed cache
      // so that reloads reflect the cleared state without needing a full re-triage.
      const { sessionId, clientName, clearedFlagKeys } = req.body;
      if (!sessionId || !clientName || !clearedFlagKeys) {
        return res.status(400).json({ success: false, error: "Missing sessionId, clientName, or clearedFlagKeys" });
      }
      try {
        const keysToZero = new Set(clearedFlagKeys);

        // Update session
        const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
        if (sessionData) {
          const parsed = JSON.parse(sessionData);
          // Remove alerts for this client that belong to cleared flag groups
          parsed.alerts = parsed.alerts.filter(a => {
            if (a.clientName !== clientName) return true;
            return !keysToZero.has(a.flagType || a.type);
          });
          // Look up this client's masterSheetId — noActionAlerts are keyed by
          // clientId (=masterSheetId), never by clientName directly.
          const targetClientId = (parsed.clientsWithFlags || []).find(c => c.clientName === clientName)?.masterSheetId;
          // Remove noAction alerts for this client that belong to cleared flag groups
          if (parsed.noActionAlerts) {
            parsed.noActionAlerts = parsed.noActionAlerts.filter(na => {
              // Fixed 21 Aug 2026: previously compared na.clientId (a sheet ID)
              // directly against clientName (a human-readable name) — always a type
              // mismatch, so the "keep if can't determine" branch never actually
              // fired, and every noAction alert fell through to being matched purely
              // by flagType regardless of which client it belonged to — meaning
              // clearing one client's flags could silently clear another client's
              // matching informational flag too. Found while tracing the same
              // clientId/clientName confusion pattern in the store_precomputed fix
              // just above.
              if (na.clientId !== targetClientId) return true; // different client, keep untouched
              return !keysToZero.has(na.flagType);
            });
          }
          // Zero out the client's cleared flags in clientsWithFlags
          if (parsed.clientsWithFlags) {
            parsed.clientsWithFlags = parsed.clientsWithFlags.map(c => {
              if (c.clientName !== clientName) return c;
              const updatedFlags = { ...c.flags };
              keysToZero.forEach(k => { updatedFlags[k] = false; });
              return { ...c, flags: updatedFlags };
            });
          }
          await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 3600 });
          console.log(`  update_session_flags: session updated for ${clientName}`);
        }

        // Update precomputed cache
        const precomputed = await redisClient.get(PRECOMPUTED_KEY);
        if (precomputed) {
          const parsed = JSON.parse(precomputed);
          parsed.alerts = (parsed.alerts || []).filter(a => {
            if (a.clientName !== clientName) return true;
            return !keysToZero.has(a.flagType || a.type);
          });
          if (parsed.noActionAlerts) {
            // Fixed 21 Aug 2026 — same clientId/clientName type-mismatch bug as the
            // session-update block above, but here it made the filter completely
            // inert instead: na.clientId !== clientName was always true (different
            // types never equal), so `!keysToZero.has(...) || true` was always true
            // and nothing was ever actually removed from the precomputed cache.
            const precompTargetClientId = (parsed.clientsWithFlags || []).find(c => c.clientName === clientName)?.masterSheetId;
            parsed.noActionAlerts = parsed.noActionAlerts.filter(na => {
              if (na.clientId !== precompTargetClientId) return true;
              return !keysToZero.has(na.flagType);
            });
          }
          if (parsed.clientsWithFlags) {
            parsed.clientsWithFlags = parsed.clientsWithFlags.map(c => {
              if (c.clientName !== clientName) return c;
              const updatedFlags = { ...c.flags };
              keysToZero.forEach(k => { updatedFlags[k] = false; });
              return { ...c, flags: updatedFlags };
            });
          }
          parsed.totalAlerts = (parsed.alerts || []).length;
          parsed.noActionCount = (parsed.noActionAlerts || []).length;
          // Remove stale noAction analysis results for this client's cleared flags
          // so the next load forces a fresh Analyse rather than showing outdated results
          if (parsed.noActionAnalysisResults) {
            const richFlags = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "retainerInvoicesCreated", "retainerInvoicesDeleted"];
            richFlags.forEach(flagType => {
              if (keysToZero.has(flagType)) {
                delete parsed.noActionAnalysisResults[`${clientName}___${flagType}`];
              }
            });
          }
          await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(parsed), { EX: 3600 });
          console.log(`  update_session_flags: precomputed cache updated for ${clientName}`);
        }

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ Error updating session flags:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "resolve_noaction_flag") {
      // Mark a noAction flag as resolved in the Redis session so it persists
      // across reloads, AND (23 Aug 2026, replacing the old group-level
      // flag_cleared marker) mark every currently-cached AlertMemory row for
      // this client+flagType as "accepted" — giving analyze_noaction_flag a
      // genuine, per-event timestamp to compute its lookback window from,
      // rather than a separate group-clear record. automationCommanderSheetId
      // was already being sent by the frontend for this call but previously
      // unused here.
      const { sessionId, clientName, flagType, automationCommanderSheetId: acIdResolve } = req.body;
      if (!sessionId || !clientName || !flagType) {
        return res.status(400).json({ success: false, error: "Missing sessionId, clientName, or flagType" });
      }
      try {
        // Persist resolution in Redis session
        const sessionData = await redisClient.get(`triage_alerts:${sessionId}`);
        if (!sessionData) return res.status(200).json({ success: true, notFound: true });
        const parsed = JSON.parse(sessionData);
        if (!parsed.resolvedNoActionFlags) parsed.resolvedNoActionFlags = [];
        const key = `${clientName}___${flagType}`;
        if (!parsed.resolvedNoActionFlags.includes(key)) {
          parsed.resolvedNoActionFlags.push(key);
        }
        await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 3600 });
        console.log(`  resolve_noaction_flag: marked "${key}" as resolved`);

        if (acIdResolve) {
          try {
            const sheets = await getSheetsClient();
            const acIdClean = extractSheetIdFromUrl(acIdResolve) || acIdResolve;
            const memoryRows = await readAlertMemory(sheets, acIdClean);
            const toAccept = memoryRows.filter(r =>
              r.clientName === clientName && r.alertType === flagType && r.status === "cached");
            for (const row of toAccept) {
              await updateAlertMemoryRow(sheets, acIdClean, row.rowIndex, {
                fingerprintHash: row.fingerprintHash, alertType: row.alertType, clientName: row.clientName,
                alertSummary: row.alertSummary, cachedOptionsJSON: row.cachedOptionsJSON,
                status: "accepted", firstSeen: row.firstSeen, dataSnapshot: row.dataSnapshot,
              });
            }
            if (toAccept.length > 0) {
              console.log(`  resolve_noaction_flag: marked ${toAccept.length} AlertMemory row(s) accepted for ${clientName}/${flagType}`);
            }
          } catch (amErr) {
            console.log(`  ⚠️ resolve_noaction_flag: could not update AlertMemory (non-fatal): ${amErr.message}`);
          }
        }

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ Error resolving noAction flag:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "record_decision") {
      // Log user's decision to TriageLog
      const { alert, decision, automationCommanderSheetId } = req.body;
      
      if (!alert || !decision || !automationCommanderSheetId) {
        return res.status(400).json({ 
          success: false, 
          error: "Missing alert, decision, or automationCommanderSheetId" 
        });
      }

      try {
        console.log(`\n📝 Recording decision for alert: ${decision.action}`);
        
        const sheets = await getSheetsClient();
        
        // Log to TriageLog sheet
        const timestamp = new Date().toISOString();
        const alertAmount = alert.summary?.amount || alert.data?.amount || alert.data?.revenue || "";
        
        const logRow = [
          timestamp,
          alert.type || alert.flagType,
          `${alert.sheetName}-${alert.rowNumber}`,
          alert.clientName || "",
          alertAmount,
          JSON.stringify(decision.claudeRecommendation || {}),
          decision.action,
          decision.notes || "",
        ];
        
        console.log(`  Writing to TriageLog: ${logRow.join(" | ")}`);
        
        await sheets.spreadsheets.values.append({
          spreadsheetId: automationCommanderSheetId,
          range: "TriageLog!A:H",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [logRow],
          },
        });
        
        console.log(`  ✅ Decision logged to TriageLog`);
        
        return res.status(200).json({
          success: true,
          message: "Decision recorded",
        });
      } catch (err) {
        console.error(`❌ Error recording decision:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "bulk_ignore_alerts") {
      // Bulk ignore multiple alerts in one call — same logic as ignore_alert but batched.
      const { alerts: alertsToIgnore, ignoreReason, automationCommanderSheetId: acId } = req.body;
      if (!alertsToIgnore?.length || !acId) {
        return res.status(400).json({ success: false, error: "Missing alerts or automationCommanderSheetId" });
      }
      try {
        console.log(`\n🚫 Bulk ignoring ${alertsToIgnore.length} alerts`);
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);
        const rowsToAppend = [];
        const rowsToUpdate = [];

        for (const alert of alertsToIgnore) {
          const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);
          const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
          const alertSummary = alert.summary?.summary
            || `${alert.type || "alert"} ${alert.summary?.invoiceNo || ""} £${alert.summary?.amount || ""}`.trim();
          const crmIdentitySnap = alert.type === "crm" ? extractCrmComparisonSnapshot(alert) : null;
          const dataSnapshot = JSON.stringify({
            alertType:  alert.type || alert.flagType || "",
            invoiceNo:  alert.summary?.invoiceNo || "",
            amount:     String(alert.summary?.amount || ""),
            vatIncluded: String(alert.summary?.vatIncluded || ""),
            status:     String(alert.summary?.status || ""),
            sentDate:   String(alert.summary?.sentDate || ""),
            datePaid:   String(alert.summary?.datePaid || ""),
            client:     String(alert.summary?.client || ""),
            job:        String(alert.summary?.job || ""),
            flagType:   alert.flagType || "",
            masterSheetId: alert.masterSheetId || "",
            crmJobName:    crmIdentitySnap?.jobName    || "",
            crmEndClient:  crmIdentitySnap?.clientName || "",
            crmFields:     crmIdentitySnap?.fields     || null,
          });
          if (memoryRow) {
            rowsToUpdate.push({ rowIndex: memoryRow.rowIndex, row: { ...memoryRow, status: "ignored", ignoreReason: ignoreReason || "", dataSnapshot } });
          } else {
            rowsToAppend.push({ fingerprintHash, alertType: alert.type || alert.flagType || "unknown",
              clientName: alert.clientName || "", alertSummary, cachedOptionsJSON: "",
              status: "ignored", ignoreReason: ignoreReason || "", dataSnapshot });
          }
        }

        // Apply updates and appends
        for (const u of rowsToUpdate) {
          await updateAlertMemoryRow(sheets, acId, u.rowIndex, u.row);
        }
        for (const a of rowsToAppend) {
          await appendAlertMemoryRow(sheets, acId, a);
        }

        console.log(`  ✅ Bulk ignored: ${rowsToUpdate.length} updated, ${rowsToAppend.length} appended`);
        return res.status(200).json({ success: true, count: alertsToIgnore.length });
      } catch (err) {
        console.error("❌ Error in bulk_ignore_alerts:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "bulk_create_tasks") {
      // Bulk create tasks for multiple alerts — same logic as create_task but batched.
      // Returns array of { fingerprintHash } so the caller can snooze all if needed.
      const { alerts: alertsToTask, taskNote, snoozedUntil, automationCommanderSheetId: acId } = req.body;
      if (!alertsToTask?.length || !acId) {
        return res.status(400).json({ success: false, error: "Missing alerts or automationCommanderSheetId" });
      }
      try {
        console.log(`\n📋 Bulk creating ${alertsToTask.length} tasks`);
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);
        const results = [];

        for (const alert of alertsToTask) {
          try {
            const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);
            const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
            const taskRef = `TASK-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
            const taskKey = `${alert.clientName}||${alert.type || alert.flagType || "alert"}||${taskRef}`;
            const alertSummary = alert.summary?.summary
              || `${alert.type || "alert"} ${alert.summary?.invoiceNo || ""} £${alert.summary?.amount || ""}`.trim();

            const taskRow = {
              fingerprintHash, alertType: alert.type || alert.flagType || "unknown",
              clientName: alert.clientName || "", alertSummary,
              cachedOptionsJSON: memoryRow?.cachedOptionsJSON || "",
              status: "task", taskNote: taskNote || "", taskKey,
              dataSnapshot: JSON.stringify({ alertType: alert.type || alert.flagType || "",
                flagType: alert.flagType || "", masterSheetId: alert.masterSheetId || "" }),
            };

            if (memoryRow) {
              await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, taskRow);
            } else {
              await appendAlertMemoryRow(sheets, acId, taskRow);
            }

            // Snooze if requested
            if (snoozedUntil) {
              const freshRows = await readAlertMemory(sheets, acId);
              const taskMemRow = findMemoryRow(freshRows, fingerprintHash);
              if (taskMemRow) {
                await updateAlertMemoryRow(sheets, acId, taskMemRow.rowIndex, { ...taskMemRow, snoozedUntil });
              }
            }

            results.push({ fingerprintHash, taskKey });
          } catch (alertErr) {
            console.error(`  ⚠ Error creating task for ${alert.clientName}: ${alertErr.message}`);
            results.push({ fingerprintHash: null, error: alertErr.message });
          }
        }

        console.log(`  ✅ Bulk tasks created: ${results.filter(r => !r.error).length}/${alertsToTask.length}`);
        return res.status(200).json({ success: true, results });
      } catch (err) {
        console.error("❌ Error in bulk_create_tasks:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "ignore_alert") {
      // Permanently ignore an alert by fingerprint — removes it from future triage runs
      const { alert, ignoreReason, automationCommanderSheetId } = req.body;

      if (!alert || !automationCommanderSheetId) {
        return res.status(400).json({ success: false, error: "Missing alert or automationCommanderSheetId" });
      }

      try {
        console.log(`\n🚫 Ignoring alert for ${alert.clientName}`);
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);

        const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);
        const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
        const alertSummary = alert.summary?.summary
          || `${alert.type || "alert"} ${alert.summary?.invoiceNo || alert.summary?.reference || ""} £${alert.summary?.amount || ""}`.trim();

        // Build data snapshot for re-check comparison
        const crmIdentitySnap = alert.type === "crm" ? extractCrmComparisonSnapshot(alert) : null;
        const dataSnapshot = JSON.stringify({
          alertType: alert.type || alert.flagType || "",
          invoiceNo:     alert.summary?.invoiceNo     || "",
          reference:     alert.summary?.reference     || "",
          amount:        String(alert.summary?.amount || ""),
          status:        alert.summary?.status        || "",
          flagType:      alert.flagType               || "",
          masterSheetId: alert.masterSheetId          || "",
          crmJobName:    crmIdentitySnap?.jobName      || "",
          crmEndClient:  crmIdentitySnap?.clientName   || "",
          crmFields:     crmIdentitySnap?.fields       || null,
        });

        if (memoryRow) {
          // Update existing row to ignored
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
            ...memoryRow,
            status: "ignored",
            ignoreReason: ignoreReason || "",
            dataSnapshot,
          });
        } else {
          // Create new row directly as ignored (no cached options needed)
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
            fingerprintHash,
            alertType: alert.type || alert.flagType || "unknown",
            clientName: alert.clientName || "",
            alertSummary,
            cachedOptionsJSON: "",
            status: "ignored",
            ignoreReason: ignoreReason || "",
            dataSnapshot,
          });
        }

        console.log(`  ✅ Alert ignored: ${fingerprintHash}`);
        return res.status(200).json({ success: true, message: "Alert ignored" });
      } catch (err) {
        console.error(`❌ Error ignoring alert:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "unignore_alert") {
      // Restore an ignored alert so it appears again in future triage runs
      const { fingerprintHash, automationCommanderSheetId } = req.body;

      if (!fingerprintHash || !automationCommanderSheetId) {
        return res.status(400).json({ success: false, error: "Missing fingerprintHash or automationCommanderSheetId" });
      }

      try {
        console.log(`\n♻️ Un-ignoring alert: ${fingerprintHash}`);
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
        const memoryRow = findMemoryRow(memoryRows, fingerprintHash);

        if (!memoryRow) {
          return res.status(404).json({ success: false, error: "Alert not found in memory" });
        }

        if (memoryRow.cachedOptionsJSON) {
          // Has cached options — restore to cached status so it appears with options pre-loaded
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
            ...memoryRow,
            status: "cached",
            ignoreReason: "",
          });
          console.log(`  ✅ Restored to cached status`);
        } else {
          // No cached options — delete the row entirely so Claude is called fresh
          await deleteAlertMemoryRows(sheets, automationCommanderSheetId, [memoryRow.rowIndex]);
          console.log(`  ✅ Row deleted — will get fresh Claude analysis on next triage`);
        }

        return res.status(200).json({ success: true, message: "Alert un-ignored" });
      } catch (err) {
        console.error(`❌ Error un-ignoring alert:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "rehash_ignored_alerts") {
      // Rebuilds fingerprint hashes for all "ignored" AlertMemory rows by reading
      // fresh alerts from the comparison tabs and matching by alert summary.
      // Use after fingerprint algorithm changes invalidate stored hashes.
      const { automationCommanderSheetId: acId } = req.body;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
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

    } else if (action === "get_ignored_alerts") {
      // Return all ignored alerts for display on the Ignored Alerts screen
      const automationCommanderSheetId = req.body.automationCommanderSheetId || req.query.automationCommanderSheetId;

      if (!automationCommanderSheetId) {
        return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      }

      try {
        console.log(`\n📋 Fetching ignored alerts`);
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
        const ignoredAlerts = memoryRows
          .filter(r => r.status === "ignored" || (r.status === "superseded" && r.ignoreReason))
          .map(r => ({
            fingerprintHash: r.fingerprintHash,
            alertType:       r.alertType,
            clientName:      r.clientName,
            alertSummary:    r.alertSummary,
            ignoreReason:    r.ignoreReason,
            firstSeen:       r.firstSeen,
            lastSeen:        r.lastSeen,
            status:          r.status, // include so UI can show "superseded" differently if needed
          }));

        console.log(`  ✅ Found ${ignoredAlerts.length} ignored alerts`);
        return res.status(200).json({ success: true, ignoredAlerts });
      } catch (err) {
        console.error(`❌ Error fetching ignored alerts:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_handled_fingerprints") {
      // Called by GAS precompute Stage 1 to get the set of already-handled fingerprints.
      // Returns hashes with status ignored, task, or superseded — these can be skipped
      // entirely during the alert-building loop, avoiding unnecessary Vercel API calls.
      const { automationCommanderSheetId: acId } = req.body;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);
        const handledHashes = memoryRows
          .filter(r => r.status === "ignored" || r.status === "task" || r.status === "superseded" || r.status === "accepted")
          .map(r => r.fingerprintHash)
          .filter(Boolean);
        console.log(`  get_handled_fingerprints: ${handledHashes.length} handled of ${memoryRows.length} total`);
        return res.status(200).json({ success: true, handledHashes });
      } catch (err) {
        console.error("❌ Error in get_handled_fingerprints:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "check_new_fingerprints") {
      // Called by the full sweep GAS function to determine which client/alertType
      // combinations have at least one fingerprint not already handled in AlertMemory.
      // "Handled" means status is ignored, task, or superseded.
      // "Cached" is NOT handled — it means the alert exists but has not been triaged yet.
      const { automationCommanderSheetId: acId, sweepItems } = req.body;
      if (!acId || !sweepItems) {
        return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId or sweepItems" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);

        const handledHashes = getHandledFingerprintHashes_(memoryRows);

        console.log(`  check_new_fingerprints: ${memoryRows.length} AlertMemory rows, ${handledHashes.size} handled hashes`);

        const newItems = [];
        for (const item of sweepItems) {
          if (!item.fingerprints || item.fingerprints.length === 0) continue;
          const hasNew = item.fingerprints.some(hash => hash && !handledHashes.has(hash));
          if (hasNew) {
            newItems.push({ clientName: item.clientName, alertType: item.alertType });
            console.log(`  New fingerprint(s) found: ${item.clientName} / ${item.alertType}`);
          }
        }

        console.log(`  check_new_fingerprints: ${newItems.length} items need flag raising`);
        return res.status(200).json({ success: true, newItems });
      } catch (err) {
        console.error("Error in check_new_fingerprints:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "store_proactive_alerts") {
      // Called by GAS overnight checks. Writes exclusively to AlertMemory
      // now (unified alert-system redesign, 23 Aug 2026, Paul's explicit
      // direction to fully retire the ProactiveAlerts tab) — this action
      // no longer touches ProactiveAlerts at all. Every category="proactive"
      // AlertMemory row is the single source of truth for these alerts.
      const { alerts: incomingAlerts, automationCommanderSheetId: acId } = req.body;
      if (!incomingAlerts || !acId) {
        return res.status(400).json({ success: false, error: "Missing alerts or automationCommanderSheetId" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const existing = (await readAlertMemory(sheets, acId)).filter(r => r.category === "proactive");

        const fingerprintFor = (alertKey) => createHash("sha256").update(alertKey).digest("hex").substring(0, 16);

        // Parsed once per row — dataSnapshot is the full original alert
        // object (JSON), which carries alertKey/stableJobKey/confirmedRow
        // etc. AlertMemory has no dedicated metadata column the way
        // ProactiveAlerts did, so signature fields and the original
        // alertKey (needed for the task auto-resolve step below, since
        // AlertMemory only stores the hashed fingerprint) both come from
        // here instead.
        const parsedSnapshots = new Map(); // rowIndex -> parsed dataSnapshot, or {}
        for (const row of existing) {
          try { parsedSnapshots.set(row.rowIndex, JSON.parse(row.dataSnapshot || "{}")); }
          catch (e) { parsedSnapshots.set(row.rowIndex, {}); }
        }

        // Same two-tier matching ProactiveAlerts used: exact fingerprint
        // first, then a stable signature fallback (survives alertKey
        // format changes and row shifts) — preferring stableJobKey
        // (client+job+code, or client+job+dates) when the alert type
        // provides it, falling back to client+type+confirmedRow.
        const buildSig = (row) => {
          const snap = parsedSnapshots.get(row.rowIndex) || {};
          const meta = snap.metadata || {};
          const stableJobKey = snap.stableJobKey || meta.stableJobKey || "";
          if (stableJobKey) return `${row.clientName}|||${row.alertType}|||stable:${stableJobKey}`;
          const confirmedRow = snap.confirmedRow || meta.confirmedRow || "";
          return `${row.clientName}|||${row.alertType}|||${confirmedRow}`;
        };
        const buildSigForIncoming = (alert) => {
          const meta = alert.metadata || {};
          const stableJobKey = alert.stableJobKey || meta.stableJobKey || "";
          if (stableJobKey) return `${alert.clientName}|||${alert.alertType}|||stable:${stableJobKey}`;
          const cr = alert.confirmedRow || meta.confirmedRow || "";
          return `${alert.clientName}|||${alert.alertType}|||${cr}`;
        };

        const existingByFingerprint = {};
        const existingBySignature = {};
        for (const row of existing) {
          existingByFingerprint[row.fingerprintHash] = row;
          const sig = buildSig(row);
          // Keep the most recent row per signature (last writer wins) —
          // same rule as before; higher rowIndex means written more
          // recently, since AlertMemory is append-only like ProactiveAlerts was.
          if (!existingBySignature[sig] || row.rowIndex > existingBySignature[sig].rowIndex) {
            existingBySignature[sig] = row;
          }
        }

        let stored = 0, updated = 0, dismissed = 0;

        // Auto-dismiss: an existing cached/task row whose alertType is
        // present in this run but whose specific alert is no longer in the
        // incoming list — its underlying condition resolved on its own.
        // "ignored" rows (explicit user dismissal) are deliberately left
        // alone; "auto_resolved" rows are already terminal. Considers
        // "task" status too (same fix as before, 19 Aug 2026 — an alert
        // converted to a task must still be auto-dismissable once its
        // condition genuinely clears, or the task auto-resolve step below
        // would never fire for any task-linked alert).
        const incomingAlertTypes = new Set(incomingAlerts.map(a => a.alertType));
        const incomingFingerprints = new Set(incomingAlerts.map(a => fingerprintFor(a.alertKey)));
        const incomingSignatures = new Set(incomingAlerts.map(buildSigForIncoming));
        const autoDismissedKeys = []; // original alertKeys, for the task auto-resolve step below

        for (const row of existing) {
          if (row.status !== "cached" && row.status !== "task") continue;
          if (!incomingAlertTypes.has(row.alertType)) continue;
          const sig = buildSig(row);
          if (incomingFingerprints.has(row.fingerprintHash) || incomingSignatures.has(sig)) continue;
          const snap = parsedSnapshots.get(row.rowIndex) || {};
          await updateAlertMemoryRow(sheets, acId, row.rowIndex, {
            fingerprintHash: row.fingerprintHash, alertType: row.alertType, clientName: row.clientName,
            alertSummary: row.alertSummary, cachedOptionsJSON: row.cachedOptionsJSON,
            status: "auto_resolved", firstSeen: row.firstSeen, dataSnapshot: row.dataSnapshot,
          });
          dismissed++;
          if (snap.alertKey) autoDismissedKeys.push(snap.alertKey);
          console.log(`  Auto-resolved stale ${row.alertType} alert for ${row.clientName}: ${row.fingerprintHash}`);
        }

        for (const alert of incomingAlerts) {
          const fp = fingerprintFor(alert.alertKey);
          const sig = buildSigForIncoming(alert);
          const ex = existingByFingerprint[fp] || existingBySignature[sig];
          const summary = alert.heading || alert.detail || alert.alertType;

          if (ex) {
            if (ex.status === "ignored") { dismissed++; continue; }
            if (ex.status === "auto_resolved") {
              // Condition was previously marked gone but has been detected
              // again — reactivate rather than leaving it permanently
              // suppressed. Only "ignored" (an explicit user dismissal)
              // stays suppressed.
              await updateAlertMemoryRow(sheets, acId, ex.rowIndex, {
                fingerprintHash: fp, alertType: alert.alertType, clientName: alert.clientName,
                alertSummary: summary, cachedOptionsJSON: "", status: "cached",
                firstSeen: ex.firstSeen, dataSnapshot: JSON.stringify(alert),
              });
              updated++;
              console.log(`  Reactivated ${alert.alertType} alert for ${alert.clientName}: condition detected again`);
              continue;
            }
            // "cached" or "task" — refresh summary/snapshot from this run
            // (the alert's condition can still be true while its details
            // drift — a row number shifts, an amount changes), keeping
            // status as-is so a task-linked alert doesn't revert to
            // "cached" just because its condition is still true.
            let updatedSnapshot = JSON.stringify(alert);
            if (ex.status === "task") {
              try {
                const oldSnap = JSON.parse(ex.dataSnapshot || "{}");
                // Keep the task metadata intact, overwrite the raw alert fields
                updatedSnapshot = JSON.stringify({ ...oldSnap, ...alert });
              } catch (e) {}
            }

            await updateAlertMemoryRow(sheets, acId, ex.rowIndex, {
              fingerprintHash: fp, alertType: alert.alertType, clientName: alert.clientName,
              alertSummary: summary, cachedOptionsJSON: ex.cachedOptionsJSON, status: ex.status,
              firstSeen: ex.firstSeen, dataSnapshot: updatedSnapshot,
            });
            updated++;
          } else {
            try {
              await appendAlertMemoryRow(sheets, acId, {
                fingerprintHash: fp, alertType: alert.alertType, clientName: alert.clientName,
                alertSummary: summary, cachedOptionsJSON: "", status: "cached",
                category: "proactive", dataSnapshot: JSON.stringify(alert),
              });
              stored++;
            } catch (memErr) {
              console.log(`  ⚠️ Could not write AlertMemory row for proactive alert ${alert.alertKey}: ${memErr.message}`);
            }
          }
        }

        // Auto-resolve any task whose linked proactive alert just got
        // auto-resolved — the alert's condition is gone, so a task about
        // it is stale too. Only touches tasks still in status "task"
        // (won't reopen or override anything a person has already
        // resolved manually). Unchanged from before — already operated
        // on AlertMemory directly, just now fed alertKeys extracted from
        // dataSnapshot above instead of from ProactiveAlerts rows.
        let tasksAutoResolved = 0;
        if (autoDismissedKeys.length > 0) {
          try {
            const memoryRows = await readAlertMemory(sheets, acId);
            const dismissedKeySet = new Set(autoDismissedKeys);
            const taskWrites = [];
            for (const row of memoryRows) {
              if (row.status !== "task") continue;
              let taskMeta = {};
              try { taskMeta = JSON.parse(row.dataSnapshot || "{}"); } catch (e) { continue; }
              if (!taskMeta.proactiveAlertKey || !dismissedKeySet.has(taskMeta.proactiveAlertKey)) continue;
              taskMeta.resolvedAt = new Date().toISOString();
              taskMeta.autoResolvedReason = "Underlying proactive alert condition no longer detected";
              taskWrites.push({ range: `AlertMemory!F${row.rowIndex}`, values: [["task_resolved"]] });
              taskWrites.push({ range: `AlertMemory!K${row.rowIndex}`, values: [[JSON.stringify(taskMeta)]] });
              tasksAutoResolved++;
            }
            if (taskWrites.length > 0) {
              await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: acId,
                requestBody: { data: taskWrites, valueInputOption: "RAW" },
              });
              await redisClient.del("triage_tasks_cache").catch(() => {});
              console.log(`  ✅ Auto-resolved ${tasksAutoResolved} task(s) whose linked alert cleared`);
            }
          } catch (taskErr) {
            console.log(`  ⚠️ Task auto-resolve step failed (non-fatal): ${taskErr.message}`);
          }
        }

        console.log(`  ✅ Proactive alerts: ${stored} stored, ${updated} updated, ${dismissed} dismissed`);
        await logProactiveCheckRun(sheets, acId, {
          clientsChecked: req.body.clientsChecked || undefined,
          newAlerts: stored, updatedAlerts: updated, dismissedAlerts: dismissed,
        });
        return res.status(200).json({ success: true, stored, updated, dismissed });
      } catch (err) {
        console.error(`❌ Error in store_proactive_alerts:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "resolve_proactive_alert") {
      // Marks a proactive alert's AlertMemory row as resolved, so it stops
      // appearing in the merged alert list. Used after an alert-driven fix
      // action (e.g. "End Retainer" / "Change retainer amount") has
      // actually fixed the underlying condition — the alert itself is a
      // persisted row, not a live check, so fixing the sheet doesn't
      // automatically remove it; this call does. Migrated 23 Aug 2026
      // (ProactiveAlerts retirement) from a direct rowIndex reference to
      // alertKey, since AlertMemory rows are looked up by fingerprintHash
      // (a hash of alertKey), not a row number into a tab this action no
      // longer touches.
      const { automationCommanderSheetId: acId2, alertKey, resolution } = req.body;
      if (!acId2 || !alertKey) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }
      try {
        const sheets = await getSheetsClient();
        const fp = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
        const memoryRows = await readAlertMemory(sheets, acId2);
        const row = memoryRows.find(r => r.fingerprintHash === fp && r.category === "proactive");
        if (!row) return res.status(404).json({ success: false, error: "Alert not found" });
        await updateAlertMemoryRow(sheets, acId2, row.rowIndex, {
          fingerprintHash: row.fingerprintHash, alertType: row.alertType, clientName: row.clientName,
          alertSummary: row.alertSummary, cachedOptionsJSON: row.cachedOptionsJSON,
          status: "resolved", firstSeen: row.firstSeen, dataSnapshot: row.dataSnapshot,
        });
        console.log(`  ✅ resolve_proactive_alert: alertKey ${alertKey} marked resolved (${resolution || "no reason given"})`);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ resolve_proactive_alert error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "mark_pipeline_copied") {
      // Fix action for the pipeline_confirmed_overlap alert — writes "Yes" to
      // Pipeline column DD ("Copied to confirmed?") for the given row, which is
      // one of the two conditions (the other being 0% likelihood) that closes
      // the Pipeline row out and stops the overlap being flagged.
      const { clientSheetId: pipeClientSheetId, pipelineRow } = req.body;
      if (!pipeClientSheetId || !pipelineRow) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId or pipelineRow" });
      }
      try {
        const sheets = await getSheetsClient();
        await sheets.spreadsheets.values.update({
          spreadsheetId: pipeClientSheetId,
          range: `Pipeline!DD${pipelineRow}`,
          valueInputOption: "RAW",
          requestBody: { values: [["Yes"]] },
        });
        console.log(`  ✅ mark_pipeline_copied: wrote Yes to Pipeline!DD${pipelineRow}`);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ mark_pipeline_copied error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_proactive_alerts") {
      // Returns all active proactive alerts, optionally filtered by
      // clientName. Migrated 23 Aug 2026 (ProactiveAlerts retirement) to
      // read from AlertMemory instead — each alert's original shape
      // (heading/detail/metadata/alertKey etc.) is reconstructed from its
      // stored dataSnapshot, which is exactly the original incoming alert
      // object from the GAS overnight check. rowIndex here is AlertMemory's
      // own row number, not a ProactiveAlerts reference — used only for
      // frontend bulk-select tracking now, since both resolve_proactive_alert
      // and acknowledge_proactive_alert key off alertKey, not a row number.
      const acId = req.body.automationCommanderSheetId || req.query.automationCommanderSheetId;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const all = await readAlertMemory(sheets, acId);
        // Same field whitelist the old ProactiveAlerts-based metadata used
        // — needed here so the frontend's alert.metadata.jobName-style
        // access (built around that nested shape, e.g. the retainer_invoice/
        // uninvoiced_revenue/crm_wipe detail panels) keeps working, even
        // though dataSnapshot stores these fields at the alert's top level.
        const metaFields = ["jobName","endClientName","confirmedRow","revenue","startDate","endDate",
          "frequencyDays","lastInvoiceDate","expectedByDate","timestamp","sequenceType","summary","jobInfo","detailsSnippet",
          "childRowNum","clientJobStr","pipelineRow","likelihood","copiedToConf","jobType",
          "possibleMatchInvoiceNo","possibleMatchAmount","possibleMatchSentDate","possibleMatchConfidence","possibleMatchConfirmedRow","possibleMatchVatAmount","possibleMatchStatus","possibleMatchCase",
          "uninvoicedAmount","projectCode","draftCount","draftTotal","stableJobKey","isRetainer","tab",
          "directCosts","unreceivedAmount","placeholderCount","placeholderTotal"];
          
        const active = all
          .filter(r => r.category === "proactive" && r.status === "cached")
          .map(r => {
            let alert = {};
            try { alert = JSON.parse(r.dataSnapshot || "{}"); } catch (e) { alert = {}; }
            const metadata = {};
            for (const f of metaFields) { if (alert[f] !== undefined) metadata[f] = alert[f]; }
            return { ...alert, rowIndex: r.rowIndex, clientName: alert.clientName || r.clientName, alertType: alert.alertType || r.alertType, metadata };
          });
        // Group by clientName for count display
        const countsByClient = {};
        for (const a of active) {
          countsByClient[a.clientName] = (countsByClient[a.clientName] || 0) + 1;
        }
        const clientFilter = req.body.clientName;
        const alerts = clientFilter ? active.filter(a => a.clientName === clientFilter) : active;
        return res.status(200).json({ success: true, alerts, countsByClient });
      } catch (err) {
        console.error(`❌ Error in get_proactive_alerts:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_proactive_check_log") {
      // Returns the most recent overnight proactive-check run summaries, for the
      // Settings screen — reassurance that the checks are actually running.
      const acId = req.body.automationCommanderSheetId || req.query.automationCommanderSheetId;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        const runs = await readProactiveCheckLog(sheets, acId, 10);
        return res.status(200).json({ success: true, runs });
      } catch (err) {
        console.error(`❌ Error in get_proactive_check_log:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_flag_sweep_log") {
      // Returns the most recent flag-sweep run summaries, for the Settings
      // screen — same purpose as get_proactive_check_log, but for
      // run_flag_sweep (21 Aug 2026, Paul's explicit request for visibility
      // into how the new sweep is behaving).
      const acIdFlagLog = req.body.automationCommanderSheetId || req.query.automationCommanderSheetId;
      if (!acIdFlagLog) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        const runs = await readFlagSweepLog(sheets, acIdFlagLog, 20);
        return res.status(200).json({ success: true, runs });
      } catch (err) {
        console.error(`❌ Error in get_flag_sweep_log:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_precompute_log") {
      // Returns the most recent precompute-stage run summaries — the other
      // end of the pipeline from get_flag_sweep_log. Added 21 Aug 2026 at
      // Paul's request, so both logs together show the whole flow end to
      // end: run_flag_sweep raises flags, this shows what the precompute
      // stage then built from them and cached for the app to load.
      const acIdPrecomputeLog = req.body.automationCommanderSheetId || req.query.automationCommanderSheetId;
      if (!acIdPrecomputeLog) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        const runs = await readPrecomputeLog(sheets, acIdPrecomputeLog, 20);
        return res.status(200).json({ success: true, runs });
      } catch (err) {
        console.error(`❌ Error in get_precompute_log:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_build_options_log") {
      // Returns the most recent build-options-stage run summaries — the middle
      // of the pipeline, sitting between Flag Sweep and Precompute.
      const acIdBuildLog = req.body.automationCommanderSheetId || req.query.automationCommanderSheetId;
      if (!acIdBuildLog) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        const runs = await readBuildOptionsLog(sheets, acIdBuildLog, 20);
        return res.status(200).json({ success: true, runs });
      } catch (err) {
        console.error(`❌ Error in get_build_options_log:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "acknowledge_proactive_alert") {
      const { alertKey, automationCommanderSheetId: acId, sessionId } = req.body;
      if (!alertKey || !acId) return res.status(400).json({ success: false, error: "Missing alertKey or automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        const fp = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
        const all = await readAlertMemory(sheets, acId);
        const matchingRows = all.filter(r => r.fingerprintHash === fp && r.category === "proactive");
        if (matchingRows.length === 0) return res.status(404).json({ success: false, error: "Alert not found" });
        for (const row of matchingRows) {
          await updateAlertMemoryRow(sheets, acId, row.rowIndex, {
            fingerprintHash: row.fingerprintHash, alertType: row.alertType, clientName: row.clientName,
            alertSummary: row.alertSummary, cachedOptionsJSON: row.cachedOptionsJSON,
            status: "ignored", firstSeen: row.firstSeen, dataSnapshot: row.dataSnapshot,
          });
        }
        
        if (sessionId) {
          try {
            const sessionRaw = await redisClient.get(`triage_alerts:${sessionId}`);
            if (sessionRaw) {
              const sessionParsed = JSON.parse(sessionRaw);
              if (sessionParsed.proactiveAlerts) {
                sessionParsed.proactiveAlerts = sessionParsed.proactiveAlerts.filter(a => a.alertKey !== alertKey);
              }
              await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(sessionParsed), { EX: 3600 });
            }
          } catch (e) {}
        }
        
        console.log(`  ✅ Acknowledged ${matchingRows.length} row(s) for alertKey: ${alertKey}`);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error(`❌ Error in acknowledge_proactive_alert:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "bulk_acknowledge_proactive_alerts") {
      // Same as acknowledge_proactive_alert, but for several alerts
      // (identified by their alertKey) in one pass. Migrated 23 Aug 2026
      // alongside the single-alert version above, same reasoning.
      const { alertKeys, automationCommanderSheetId: bulkAckAcId, sessionId } = req.body;
      if (!Array.isArray(alertKeys) || alertKeys.length === 0 || !bulkAckAcId) {
        return res.status(400).json({ success: false, error: "Missing alertKeys or automationCommanderSheetId" });
      }
      try {
        const sheets = await getSheetsClient();
        const fpSet = new Set(alertKeys.map(k => createHash("sha256").update(k).digest("hex").substring(0, 16)));
        const all = await readAlertMemory(sheets, bulkAckAcId);
        const matchingRows = all.filter(r => fpSet.has(r.fingerprintHash) && r.category === "proactive");
        if (matchingRows.length === 0) return res.status(404).json({ success: false, error: "No matching alerts found" });
        for (const row of matchingRows) {
          await updateAlertMemoryRow(sheets, bulkAckAcId, row.rowIndex, {
            fingerprintHash: row.fingerprintHash, alertType: row.alertType, clientName: row.clientName,
            alertSummary: row.alertSummary, cachedOptionsJSON: row.cachedOptionsJSON,
            status: "ignored", firstSeen: row.firstSeen, dataSnapshot: row.dataSnapshot,
          });
        }
        
        // Remove from the active Redis session and cache so they disappear from UI immediately
        if (sessionId) {
          try {
            const keysToRemove = new Set(alertKeys);
            const hashesToRemove = new Set(matchingRows.map(r => r.fingerprintHash));
            
            // 1. Session
            const sessionRaw = await redisClient.get(`triage_alerts:${sessionId}`);
            if (sessionRaw) {
              const sessionParsed = JSON.parse(sessionRaw);
              if (sessionParsed.proactiveAlerts) {
                sessionParsed.proactiveAlerts = sessionParsed.proactiveAlerts.filter(a => 
                  !keysToRemove.has(a.alertKey) && !hashesToRemove.has(a.fingerprintHash)
                );
              }
              if (sessionParsed.clientsWithFlags) {
                sessionParsed.clientsWithFlags = sessionParsed.clientsWithFlags.map(c => {
                  const toDeduct = matchingRows.filter(r => r.clientName === c.clientName);
                  if (toDeduct.length > 0 && c.alertCounts) {
                    toDeduct.forEach(td => {
                      const fk = td.alertType;
                      if (c.alertCounts[fk]) c.alertCounts[fk] = Math.max(0, c.alertCounts[fk] - 1);
                    });
                  }
                  return c;
                });
              }
              await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(sessionParsed), { EX: 3600 });
            }
            
            // 2. Precomputed Cache
            const preRaw = await redisClient.get(PRECOMPUTED_KEY);
            if (preRaw) {
              const preParsed = JSON.parse(preRaw);
              if (preParsed.proactiveAlerts) {
                preParsed.proactiveAlerts = preParsed.proactiveAlerts.filter(a => 
                  !keysToRemove.has(a.alertKey) && !hashesToRemove.has(a.fingerprintHash)
                );
              }
              await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(preParsed), { EX: 3600 });
            }
          } catch (redisErr) {
            console.error("Failed to update Redis cache on bulk acknowledge:", redisErr.message);
          }
        }

        console.log(`  ✅ Bulk acknowledged ${matchingRows.length} row(s) across ${alertKeys.length} alertKey(s)`);
        return res.status(200).json({ success: true, count: matchingRows.length });
      } catch (err) {
        console.error(`❌ Error in bulk_acknowledge_proactive_alerts:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "create_task") {
      // Create a task from an alert (automation or proactive).
      // Stores in AlertMemory with status="task", copies proactive alerts into AlertMemory.
      // Also checks for existing task with same clientName+alertType+ref to prevent duplicates.
      const { alert, taskNote, automationCommanderSheetId: acId, isProactive, proactiveAlertKey } = req.body;
      if (!alert || !acId) return res.status(400).json({ success: false, error: "Missing alert or automationCommanderSheetId" });

      try {
        console.log(`\n📋 Creating task for ${alert.clientName}`);
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);

        // For proactive alerts, use alertKey as the fingerprint basis so each
        // alert gets a unique hash. Automation alerts already carry fingerprintHash.
        const fingerprintHash = alert.fingerprintHash
          || (alert.alertKey ? createHash("sha256").update(alert.alertKey).digest("hex").substring(0, 16) : null)
          || buildAlertFingerprint(alert);
        const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
        const now = new Date().toISOString();
        const today = now.split("T")[0];

        // Build stable task key: clientName + alertType + ref (invoice/job/alertKey)
        const taskRef = alert.summary?.invoiceNo || alert.summary?.reference
          || alert.summary?.jobName || alert.alertKey || fingerprintHash.slice(0, 8);
        const taskKey = `${alert.clientName}||${alert.type || alert.flagType || "alert"}||${taskRef}`;

        // Check for existing task with same key (different hash = data changed)
        const existingTask = memoryRows.find(r =>
          r.status === "task" && r.taskKey === taskKey
        );
        if (existingTask) {
          return res.status(409).json({
            success: false,
            error: "A task already exists for this alert",
            existingTaskHash: existingTask.fingerprintHash,
          });
        }

        const alertSummary = alert.summary?.summary
          || alert.heading
          || `${alert.type || alert.flagType || alert.alertType || "alert"} ${alert.summary?.invoiceNo || alert.summary?.reference || ""} ${alert.summary?.amount ? "£" + alert.summary.amount : ""}`.trim();

        // Kept as a plain object (not stringified here) so it can be merged
        // into both branches below — previously this was JSON.stringify'd
        // immediately and then never actually used in either branch, so
        // invoiceNo/reference/amount/status/flagType/masterSheetId were
        // silently never stored at the top level of a task's dataSnapshot.
        // Found via a full-codebase sweep (20 Aug 2026): findPreviousIgnoreReason
        // (used to surface "you previously handled this" context for a new,
        // recurring alert) reads exactly these fields directly off the parsed
        // dataSnapshot (snap.invoiceNo/snap.reference) — so any alert that was
        // ever turned into a task, later superseded, and then recurred would
        // silently fail that match, since the fields it needed were never
        // there for a task-derived row.
        const alertFieldsSnapshot = {
          alertType:     alert.type || alert.flagType || "",
          invoiceNo:     alert.summary?.invoiceNo     || "",
          reference:     alert.summary?.reference     || "",
          amount:        String(alert.summary?.amount || ""),
          status:        alert.summary?.status        || "",
          flagType:      alert.flagType               || "",
          masterSheetId: alert.masterSheetId          || "",
          taskKey,
        };

        // Get cached options if available
        let cachedOptionsJSON = "";
        if (memoryRow?.cachedOptionsJSON) {
          cachedOptionsJSON = memoryRow.cachedOptionsJSON;
        }

        // Task-specific extra columns (L-O) encoded as JSON in col K (dataSnapshot extended)
        // We reuse the existing 11-column schema and pack task fields into dataSnapshot
        const taskMeta = {
          taskNote:      taskNote || "",
          taskCreatedAt: now,
          snoozedUntil:  "",
          furtherNotes:  [], // [{text, timestamp}]
          taskKey,
          isProactive:   !!isProactive,
          proactiveAlertKey: proactiveAlertKey || "",
          alertData:     JSON.stringify(alert), // full alert for replaying options
        };

        if (memoryRow) {
          await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, {
            ...memoryRow,
            status: "task",
            ignoreReason: "",
            cachedOptionsJSON,
            dataSnapshot: JSON.stringify({ ...JSON.parse(memoryRow.dataSnapshot || "{}"), ...alertFieldsSnapshot, ...taskMeta }),
          });
        } else {
          await appendAlertMemoryRow(sheets, acId, {
            fingerprintHash,
            alertType: alert.type || alert.flagType || alert.alertType || "alert",
            clientName: alert.clientName || "",
            alertSummary,
            cachedOptionsJSON,
            status: "task",
            ignoreReason: "",
            category: isProactive ? "proactive" : "discrepancy",
            dataSnapshot: JSON.stringify({ ...alertFieldsSnapshot, ...taskMeta }),
          });
        }

        // Invalidate task cache
        await redisClient.del("triage_tasks_cache").catch(() => {});

        console.log(`  ✅ Task created: ${taskKey}`);
        return res.status(200).json({ success: true, taskKey, fingerprintHash });
      } catch (err) {
        console.error(`❌ Error in create_task:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_tasks") {
      // Returns all tasks from AlertMemory, with Redis caching.
      // Filter: active | snoozed | resolved
      const { automationCommanderSheetId: acId, filter, bypassCache } = req.body;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });

      const TASK_CACHE_KEY = "triage_tasks_cache";
      const TASK_CACHE_TTL_S = 300; // 5 minutes

      try {
        // Try cache first (unless bypassed)
        let allTasks = null;
        if (!bypassCache) {
          try {
            const cached = await redisClient.get(TASK_CACHE_KEY);
            if (cached) {
              allTasks = JSON.parse(cached);
              console.log(`  ✅ Tasks from Redis cache (${allTasks.length} rows)`);
            }
          } catch (e) { /* cache miss */ }
        }

        if (!allTasks) {
          const sheets = await getSheetsClient();
          await ensureAlertMemoryTab(sheets, acId);
          const rows = await readAlertMemory(sheets, acId);
          allTasks = rows.filter(r => r.status === "task" || r.status === "task_resolved");
          await redisClient.set(TASK_CACHE_KEY, JSON.stringify(allTasks), { EX: TASK_CACHE_TTL_S });
          console.log(`  ✅ Tasks from sheet (${allTasks.length} rows), cached`);
        }

        const now = new Date();
        const parsed = allTasks.map(r => {
          let taskMeta = {};
          try { taskMeta = JSON.parse(r.dataSnapshot || "{}"); } catch (e) {}
          const snoozedUntil = taskMeta.snoozedUntil ? new Date(taskMeta.snoozedUntil) : null;
          const isSnoozed = snoozedUntil && snoozedUntil > now;
          const isResolved = r.status === "task_resolved";
          return {
            fingerprintHash:   r.fingerprintHash,
            alertType:         r.alertType,
            clientName:        r.clientName,
            alertSummary:      r.alertSummary,
            firstSeen:         r.firstSeen,
            lastSeen:          r.lastSeen,
            taskNote:          taskMeta.taskNote || "",
            taskCreatedAt:     taskMeta.taskCreatedAt || r.firstSeen || "",
            snoozedUntil:      taskMeta.snoozedUntil || "",
            isSnoozed,
            isResolved,
            furtherNotes:      taskMeta.furtherNotes || [],
            taskKey:           taskMeta.taskKey || "",
            isProactive:       !!taskMeta.isProactive,
            cachedOptionsJSON: r.cachedOptionsJSON || "",
            alertDataJSON:     taskMeta.alertData || "",
            resolvedAt:        taskMeta.resolvedAt || "",
          };
        });

        // Apply filter
        const requestedFilter = filter || "active";
        let filtered;
        if (requestedFilter === "snoozed") {
          filtered = parsed.filter(t => t.isSnoozed && !t.isResolved);
        } else if (requestedFilter === "resolved") {
          filtered = parsed.filter(t => t.isResolved);
        } else {
          // active = not snoozed, not resolved
          filtered = parsed.filter(t => !t.isSnoozed && !t.isResolved);
        }

        // Sort oldest first (by taskCreatedAt)
        filtered.sort((a, b) => new Date(a.taskCreatedAt || 0) - new Date(b.taskCreatedAt || 0));

        return res.status(200).json({ success: true, tasks: filtered, filter: requestedFilter });
      } catch (err) {
        console.error(`❌ Error in get_tasks:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "add_task_note") {
      // Append a timestamped note to a task's furtherNotes log
      const { fingerprintHash, noteText, automationCommanderSheetId: acId } = req.body;
      if (!fingerprintHash || !noteText || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });

      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);
        const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
        if (!memoryRow) return res.status(404).json({ success: false, error: "Task not found" });

        let taskMeta = {};
        try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
        const notes = Array.isArray(taskMeta.furtherNotes) ? taskMeta.furtherNotes : [];
        notes.push({ text: noteText, timestamp: new Date().toISOString() });
        taskMeta.furtherNotes = notes;

        await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, {
          ...memoryRow,
          dataSnapshot: JSON.stringify(taskMeta),
        });
        await redisClient.del("triage_tasks_cache").catch(() => {});
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error(`❌ Error in add_task_note:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "snooze_task") {
      // Snooze a task until a given datetime, optionally also update with new analysis
      const { fingerprintHash, snoozedUntil, automationCommanderSheetId: acId,
              unsnooze, // if true: clear snooze (unsnooze)
              updateCachedOptions, newCachedOptionsJSON, alertData } = req.body;
      if (!fingerprintHash || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });

      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);
        const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
        if (!memoryRow) return res.status(404).json({ success: false, error: "Task not found" });

        let taskMeta = {};
        try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
        if (unsnooze) {
          taskMeta.snoozedUntil = "";
        } else {
          taskMeta.snoozedUntil = snoozedUntil || "";
        }
        // Optional: update cached options and alert data (for "update and unsnooze" flow)
        if (updateCachedOptions && newCachedOptionsJSON) {
          taskMeta.furtherNotes = [
            ...(taskMeta.furtherNotes || []),
            { text: `Alert data changed — analysis updated${unsnooze ? " and task unsnoozed" : ""}`, timestamp: new Date().toISOString(), system: true },
          ];
          if (alertData) taskMeta.alertData = alertData;
        }

        await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, {
          ...memoryRow,
          cachedOptionsJSON: updateCachedOptions && newCachedOptionsJSON ? newCachedOptionsJSON : memoryRow.cachedOptionsJSON,
          dataSnapshot: JSON.stringify(taskMeta),
        });
        await redisClient.del("triage_tasks_cache").catch(() => {});
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error(`❌ Error in snooze_task:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "resolve_task") {
      // Mark a task as resolved (moves to completed archive)
      const { fingerprintHash, automationCommanderSheetId: acId } = req.body;
      if (!fingerprintHash || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });

      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);
        const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
        if (!memoryRow) return res.status(404).json({ success: false, error: "Task not found" });

        let taskMeta = {};
        try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
        taskMeta.resolvedAt = new Date().toISOString();

        await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, {
          ...memoryRow,
          status: "task_resolved",
          dataSnapshot: JSON.stringify(taskMeta),
        });
        await redisClient.del("triage_tasks_cache").catch(() => {});
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error(`❌ Error in resolve_task:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "update_task") {
      // Update a task with new analysis (when underlying data has changed).
      // Optionally unsnooze. Appends a system note to the furtherNotes log.
      const { fingerprintHash, newCachedOptionsJSON, newAlertData,
              unsnooze, automationCommanderSheetId: acId } = req.body;
      if (!fingerprintHash || !acId) return res.status(400).json({ success: false, error: "Missing required fields" });

      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);
        const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
        if (!memoryRow) return res.status(404).json({ success: false, error: "Task not found" });

        let taskMeta = {};
        try { taskMeta = JSON.parse(memoryRow.dataSnapshot || "{}"); } catch (e) {}
        taskMeta.furtherNotes = [
          ...(taskMeta.furtherNotes || []),
          {
            text: `Alert data changed — analysis updated${unsnooze ? " and task unsnoozed" : ""}`,
            timestamp: new Date().toISOString(),
            system: true,
          },
        ];
        if (unsnooze) taskMeta.snoozedUntil = "";
        if (newAlertData) taskMeta.alertData = newAlertData;

        await updateAlertMemoryRow(sheets, acId, memoryRow.rowIndex, {
          ...memoryRow,
          cachedOptionsJSON: newCachedOptionsJSON || memoryRow.cachedOptionsJSON,
          dataSnapshot: JSON.stringify(taskMeta),
        });
        await redisClient.del("triage_tasks_cache").catch(() => {});
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error(`❌ Error in update_task:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "check_existing_task") {
      // Check if an incoming alert matches an existing task (by clientName + alertType + ref).
      // Returns the existing task if found, so the frontend can show the "existing task" banner.
      const { alert, automationCommanderSheetId: acId } = req.body;
      if (!alert || !acId) return res.status(400).json({ success: false, error: "Missing alert or automationCommanderSheetId" });

      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, acId);
        const memoryRows = await readAlertMemory(sheets, acId);

        const taskRef = alert.summary?.invoiceNo || alert.summary?.reference
          || alert.summary?.jobName || alert.alertKey || "";
        const taskKey = `${alert.clientName}||${alert.type || alert.flagType || "alert"}||${taskRef}`;

        // Find active (non-resolved) task with same key
        const match = memoryRows.find(r =>
          (r.status === "task") &&
          (() => { try { return JSON.parse(r.dataSnapshot || "{}").taskKey === taskKey; } catch(e) { return false; } })()
        );

        if (!match) return res.status(200).json({ success: true, found: false });

        let taskMeta = {};
        try { taskMeta = JSON.parse(match.dataSnapshot || "{}"); } catch (e) {}
        const snoozedUntil = taskMeta.snoozedUntil ? new Date(taskMeta.snoozedUntil) : null;

        return res.status(200).json({
          success: true,
          found: true,
          task: {
            fingerprintHash: match.fingerprintHash,
            taskKey,
            taskNote: taskMeta.taskNote || "",
            taskCreatedAt: taskMeta.taskCreatedAt || match.firstSeen || "",
            isSnoozed: !!(snoozedUntil && snoozedUntil > new Date()),
            snoozedUntil: taskMeta.snoozedUntil || "",
            furtherNotes: taskMeta.furtherNotes || [],
            dataChanged: match.fingerprintHash !== (alert.fingerprintHash || buildAlertFingerprint(alert)),
          },
        });
      } catch (err) {
        console.error(`❌ Error in check_existing_task:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "upload_payroll_chunk") {
      // Chunked upload — replaces the earlier Vercel Blob direct-upload
      // approach. That approach hit a genuine, currently-unresolved bug on
      // Vercel's own infrastructure: their client-upload token/proxy
      // endpoint (vercel.com/api/blob) doesn't return a CORS header,
      // independently confirmed by another developer hitting the identical
      // symptom on the same package version — not something fixable in
      // this codebase. See conversation 18 Aug 2026.
      //
      // The frontend JSON-stringifies the whole {data, type} payload once,
      // splits that string into chunks safely under Vercel's 4.5MB request
      // body limit, and POSTs them sequentially, awaiting each before
      // sending the next — so a plain ordered Redis APPEND is sufficient
      // for reassembly; no need to track individual chunk indices here,
      // only for the frontend's own progress display.
      const { uploadId, chunkData, isFirstChunk } = req.body;
      if (!uploadId || chunkData === undefined) {
        return res.status(400).json({ success: false, error: "Missing uploadId or chunkData" });
      }
      try {
        const key = `payroll_upload:${uploadId}`;
        if (isFirstChunk) {
          await redisClient.set(key, chunkData, { EX: 3600 }); // 1hr safety-net TTL
        } else {
          await redisClient.append(key, chunkData);
          await redisClient.expire(key, 3600); // refresh TTL on each chunk
        }
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ upload_payroll_chunk error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "identify_payroll_client") {
      // Stage 2 of the payroll import tool — automatic client detection.
      // Tries, in order: filename match, employer-name-on-document match
      // (both cheap, direct evidence), then employee-name overlap scoring
      // across every client as a fallback (more expensive, fuzzier signal).
      //
      // uploadId identifies a payload assembled in Redis via repeated
      // upload_payroll_chunk calls above.
      const { uploadId, fileName, automationCommanderSheetId: idAcId } = req.body;
      if (!uploadId || !idAcId) {
        return res.status(400).json({ success: false, error: "Missing uploadId or automationCommanderSheetId" });
      }
      let fileData;
      try {
        const raw = await redisClient.get(`payroll_upload:${uploadId}`);
        if (!raw) throw new Error("Upload not found or expired — please try uploading again");
        fileData = JSON.parse(raw);
        if (!fileData || !fileData.data || !fileData.type) throw new Error("Uploaded file payload was malformed");
      } catch (fetchErr) {
        return res.status(400).json({ success: false, error: "Could not read uploaded file: " + fetchErr.message });
      }
      try {
        const sheets = await getSheetsClient();

        const clientResp = await sheets.spreadsheets.values.get({ spreadsheetId: idAcId, range: "AutoUpdates!A2:N500" });
        const clientRows = clientResp.data.values || [];
        const allClients = [];
        for (const row of clientRows) {
          const cName = String(row[0] || "").trim();
          const cSheetUrl = row[11];
          if (!cName || !cSheetUrl) continue;
          if (cName.toLowerCase() === "client" || cName.toLowerCase() === "client name") continue;
          const cSheetId = extractSheetIdFromUrl(cSheetUrl) || String(cSheetUrl).trim();
          allClients.push({ clientName: cName, clientSheetId: cSheetId });
        }

        // Tier 1a: filename — cheapest, no AI call needed
        if (fileName) {
          const fnMatch = findClientByNameMatch_(fileName, allClients);
          if (fnMatch.matched) {
            return res.status(200).json({ success: true, status: "MATCHED", clientName: fnMatch.matched, method: "filename" });
          }
        }

        // Lightweight identify-only pass: employer name + raw employee names,
        // no fuzzy-matching against any specific list yet (we don't know
        // which client's list to use until we know the client).
        const identifyPrompt = `Look at this document. Extract:
1. Any employer/company name that appears on it (the business the payroll is FOR), if visible. If not visible, use "".
2. Every employee/person name visible on the document, exactly as written — do not try to match them to anything, just list them as they appear.
Return ONLY valid JSON, no other text: { "employerName": "", "employeeNames": ["..."] }`;

        let idContent;
        if (fileData.type === "text") {
          idContent = identifyPrompt + "\n\nDOCUMENT DATA:\n" + buildVerticalCsvText_(fileData.data);
        } else {
          idContent = [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: fileData.data } },
            { type: "text", text: identifyPrompt },
          ];
        }
        const idMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, messages: [{ role: "user", content: idContent }] });
        await logClaudeUsage_(sheets, idAcId, "", "payroll_identify", idMsg.usage?.input_tokens || 0, idMsg.usage?.output_tokens || 0, "payroll_tool").catch(() => {});

        const idRaw = idMsg.content[0].type === "text" ? idMsg.content[0].text : "";
        const idClean = idRaw.replace(/```json/g, "").replace(/```/g, "").trim();
        const idJsonStart = idClean.indexOf("{");
        const idJsonEnd = idClean.lastIndexOf("}");
        let idData;
        try {
          idData = JSON.parse(idClean.slice(idJsonStart, idJsonEnd + 1));
        } catch (e) {
          idData = { employerName: "", employeeNames: [] };
        }

        // Tier 1b: employer name as it appears on the document
        if (idData.employerName) {
          const empMatch = findClientByNameMatch_(idData.employerName, allClients);
          if (empMatch.matched) {
            return res.status(200).json({ success: true, status: "MATCHED", clientName: empMatch.matched, method: "document_name" });
          }
        }

        // Tier 2: employee-name overlap across every client's Salaries tab
        const employeeNames = Array.isArray(idData.employeeNames) ? idData.employeeNames : [];
        if (employeeNames.length > 0) {
          const overlapResult = await scoreClientsByEmployeeOverlap_(sheets, allClients, employeeNames);
          if (overlapResult.matched) {
            return res.status(200).json({ success: true, status: "MATCHED", clientName: overlapResult.matched, method: "employee_overlap", scores: overlapResult.scores });
          }
          return res.status(200).json({ success: true, status: "AMBIGUOUS", employerName: idData.employerName, employeeNames, candidateScores: overlapResult.scores });
        }

        return res.status(200).json({ success: true, status: "AMBIGUOUS", employerName: idData.employerName || "", employeeNames: [], candidateScores: [] });
      } catch (err) {
        console.error("❌ identify_payroll_client error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "identify_time_client") {
      // Time report client detection — mirrors identify_payroll_client
      // closely, with one structural difference confirmed directly against
      // the original GAS script (8_AI_Features.gs) rather than assumed:
      // TimeComp lives on the client's MASTER sheet, not the client sheet
      // itself (unlike Salaries), so allClients here carries masterSheetId
      // and the overlap scoring targets that instead.
      const { uploadId, fileName, automationCommanderSheetId: idAcId } = req.body;
      if (!uploadId || !idAcId) {
        return res.status(400).json({ success: false, error: "Missing uploadId or automationCommanderSheetId" });
      }
      let fileData;
      try {
        const raw = await redisClient.get(`payroll_upload:${uploadId}`);
        if (!raw) throw new Error("Upload not found or expired — please try uploading again");
        fileData = JSON.parse(raw);
        if (!fileData || !fileData.data || !fileData.type) throw new Error("Uploaded file payload was malformed");
      } catch (fetchErr) {
        return res.status(400).json({ success: false, error: "Could not read uploaded file: " + fetchErr.message });
      }
      try {
        const sheets = await getSheetsClient();

        const clientResp = await sheets.spreadsheets.values.get({ spreadsheetId: idAcId, range: "AutoUpdates!A2:N500" });
        const clientRows = clientResp.data.values || [];
        const allClients = [];
        for (const row of clientRows) {
          const cName = String(row[0] || "").trim();
          const cMasterUrl = row[12];
          if (!cName || !cMasterUrl) continue;
          if (cName.toLowerCase() === "client" || cName.toLowerCase() === "client name") continue;
          const cMasterSheetId = extractSheetIdFromUrl(cMasterUrl) || String(cMasterUrl).trim();
          allClients.push({ clientName: cName, masterSheetId: cMasterSheetId });
        }

        if (fileName) {
          const fnMatch = findClientByNameMatch_(fileName, allClients);
          if (fnMatch.matched) {
            return res.status(200).json({ success: true, status: "MATCHED", clientName: fnMatch.matched, method: "filename" });
          }
        }

        const identifyPrompt = `Look at this document. Extract:
1. Any employer/company name that appears on it (the business the time report is FOR), if visible. If not visible, use "".
2. Every employee/person name visible on the document, exactly as written — do not try to match them to anything, just list them as they appear.
Return ONLY valid JSON, no other text: { "employerName": "", "employeeNames": ["..."] }`;

        let idContent;
        if (fileData.type === "text") {
          idContent = identifyPrompt + "\n\nDOCUMENT DATA:\n" + buildVerticalCsvText_(fileData.data);
        } else {
          idContent = [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: fileData.data } },
            { type: "text", text: identifyPrompt },
          ];
        }
        const idMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, messages: [{ role: "user", content: idContent }] });
        await logClaudeUsage_(sheets, idAcId, "", "time_identify", idMsg.usage?.input_tokens || 0, idMsg.usage?.output_tokens || 0, "time_tool").catch(() => {});

        const idRaw = idMsg.content[0].type === "text" ? idMsg.content[0].text : "";
        const idClean = idRaw.replace(/```json/g, "").replace(/```/g, "").trim();
        const idJsonStart = idClean.indexOf("{");
        const idJsonEnd = idClean.lastIndexOf("}");
        let idData;
        try {
          idData = JSON.parse(idClean.slice(idJsonStart, idJsonEnd + 1));
        } catch (e) {
          idData = { employerName: "", employeeNames: [] };
        }

        if (idData.employerName) {
          const empMatch = findClientByNameMatch_(idData.employerName, allClients);
          if (empMatch.matched) {
            return res.status(200).json({ success: true, status: "MATCHED", clientName: empMatch.matched, method: "document_name" });
          }
        }

        const employeeNames = Array.isArray(idData.employeeNames) ? idData.employeeNames : [];
        if (employeeNames.length > 0) {
          const overlapResult = await scoreClientsByEmployeeOverlap_(sheets, allClients, employeeNames, "masterSheetId", "TimeComp!A12:A62");
          if (overlapResult.matched) {
            return res.status(200).json({ success: true, status: "MATCHED", clientName: overlapResult.matched, method: "employee_overlap", scores: overlapResult.scores });
          }
          return res.status(200).json({ success: true, status: "AMBIGUOUS", employerName: idData.employerName, employeeNames, candidateScores: overlapResult.scores });
        }

        return res.status(200).json({ success: true, status: "AMBIGUOUS", employerName: idData.employerName || "", employeeNames: [], candidateScores: [] });
      } catch (err) {
        console.error("❌ identify_time_client error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "process_payroll_document") {
      // Stage 1 of the payroll import tool — takes a single already-identified
      // client + an uploaded file and runs the full extraction + write.
      //
      // uploadId identifies a payload assembled in Redis via repeated
      // upload_payroll_chunk calls (see that action above). The Redis key is
      // cleaned up once this file reaches a final outcome (complete or
      // genuinely failed) — NOT on CONFIRM_PERIOD, since that path expects
      // a follow-up call against the same uploadId.
      const { clientSheetId: payrollClientSheetId, clientName: payrollClientName,
        uploadId, confirmedMonth } = req.body;
      if (!payrollClientSheetId || !uploadId) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId or uploadId" });
      }
      let fileData;
      try {
        const raw = await redisClient.get(`payroll_upload:${uploadId}`);
        if (!raw) throw new Error("Upload not found or expired — please try uploading again");
        fileData = JSON.parse(raw);
        if (!fileData || !fileData.data || !fileData.type) throw new Error("Uploaded file payload was malformed");
      } catch (fetchErr) {
        return res.status(400).json({ success: false, error: "Could not read uploaded file: " + fetchErr.message });
      }
      try {
        const sheets = await getSheetsClient();

        const empResp = await sheets.spreadsheets.values.get({
          spreadsheetId: payrollClientSheetId, range: "Salaries!A4:A53",
        });
        const validEmployeeNames = (empResp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
        const namesString = JSON.stringify(validEmployeeNames);
        const currentDateContext = new Date().toLocaleDateString("en-GB", { month: "short", year: "numeric" });

        const promptText = `You are a payroll data extraction assistant. Analyze this payroll document.

TASK 1: Identify the Period. Find the "Ending Date", "Process Date", or "Tax Point". Output format: "MMM YYYY" (e.g. "Jan 2026").
- CRITICAL DATE HANDLING: The current real-world date context is ${currentDateContext}. If the document explicitly states a month but does NOT provide a year, calculate and output the most recent instance of that month relative to this context date (e.g. if context is Jun 2026 and doc says May, output "May 2026"; if doc says Dec, output "Dec 2025"). If no period info is found at all, output "Unknown".

TASK 2: Extract Employee Data visible ON THE DOCUMENT.
- Go through the document row by row. Extract each person exactly ONCE.
- Match each name on the document to the closest name in this list: ${namesString}.
- If a name on the document has NO MATCH in the list, set mappedName to "NEW_STARTER".
- CRITICAL: Do NOT create entries for names in the list if they do not physically appear on the document.
- STRICT EXTRACTION RULE: Do NOT perform any math or calculations. Extract the exact numbers as they appear.
- STRICT FIELD MAPPING: map values to output fields based strictly on explicit key names (e.g. 'PAYE' -> 'paye', 'Er NICs' -> 'erNic', 'Employee gross pay' -> 'grossPay').
- Extract data for THIS PERIOD ONLY (no YTD).

TASK 3: Totals. Look for a totals/summary row or section on the document covering all employees (e.g. "Total Gross Pay", "Total PAYE").
- If found, extract those totals exactly as printed, and set totalsSource to "document".
- If NOT found, calculate the totals yourself by summing the individual employee figures from Task 2, and set totalsSource to "calculated".

Return ONLY valid JSON, no other text, matching exactly this structure:
{
  "period": "MMM YYYY or Unknown",
  "employees": [{ "originalName": "", "mappedName": "", "grossPay": 0, "eeNic": 0, "erNic": 0, "studLoan": 0, "eePension": 0, "erPension": 0, "paye": 0 }],
  "totalsSource": "document or calculated",
  "totals": { "grossPay": 0, "eeNic": 0, "erNic": 0, "studLoan": 0, "eePension": 0, "erPension": 0, "paye": 0 }
}`;

        let content;
        if (fileData.type === "text") {
          const verticalText = buildVerticalCsvText_(fileData.data);
          content = promptText + "\n\nDOCUMENT DATA (Vertical List):\n" + verticalText;
        } else {
          content = [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: fileData.data } },
            { type: "text", text: promptText },
          ];
        }

        const aiMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 6000, messages: [{ role: "user", content }] });
        await logClaudeUsage_(sheets, automationCommanderSheetId, payrollClientName || "", "payroll_extract", aiMsg.usage?.input_tokens || 0, aiMsg.usage?.output_tokens || 0, "payroll_tool").catch(() => {});

        const rawText = aiMsg.content[0].type === "text" ? aiMsg.content[0].text : "";
        const cleanText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
        const jsonStart = cleanText.indexOf("{");
        const jsonEnd = cleanText.lastIndexOf("}");
        let extractedData;
        try {
          extractedData = JSON.parse(cleanText.slice(jsonStart, jsonEnd + 1));
        } catch (parseErr) {
          console.error("=== BROKEN AI JSON OUTPUT (payroll) ===\n" + rawText);
          return res.status(500).json({ success: false, error: "AI generated malformed JSON: " + parseErr.message });
        }
        if (!extractedData || !Array.isArray(extractedData.employees)) {
          return res.status(500).json({ success: false, error: "AI extracted data but 'employees' list was missing or invalid" });
        }

        const targetMonthStr = confirmedMonth || extractedData.period;
        if (!targetMonthStr || String(targetMonthStr).toLowerCase() === "unknown" || String(targetMonthStr).toLowerCase() === "null") {
          const d = new Date(); d.setMonth(d.getMonth() - 1);
          const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const fallback = months[d.getMonth()] + " " + d.getFullYear();
          // Not a final outcome — do NOT delete the Redis key, the follow-up
          // call with confirmedMonth still needs it.
          return res.status(200).json({ success: true, status: "CONFIRM_PERIOD", extractedData, fallback });
        }

        const writeResult = await writePayrollDataToSheet_(sheets, payrollClientSheetId, extractedData, targetMonthStr, validEmployeeNames);
        await redisClient.del(`payroll_upload:${uploadId}`).catch(e => console.error("  Upload cleanup failed (non-fatal):", e.message));

        // Auto-complete the linked EoM "salaries" task for this client, if
        // one is active — Option B, conversation 18 Aug 2026: a successful
        // import IS the task being done, not a separate manual step.
        // targetMonthStr is the TARGET month (the month the payroll data
        // is actually for, e.g. July) — task status is tracked by WORK
        // month (August), so it must be derived before completing (see
        // the EoM WORK MONTH vs TARGET MONTH block above; this was
        // marking the target month done directly until fixed 19 Aug 2026,
        // same bug as cash balance and mark-actual).
        if (writeResult.writeSuccess) {
          const payrollTargetMonthKey = monthStrToEomKey_(targetMonthStr);
          const payrollWorkMonthKey = eomTargetMonthToWorkMonth_(payrollTargetMonthKey);
          await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, payrollClientName, "salaries", payrollWorkMonthKey);
        }

        return res.status(200).json({ success: true, status: "COMPLETE", extractedData, ...writeResult });
      } catch (err) {
        console.error("❌ process_payroll_document error:", err);
        await redisClient.del(`payroll_upload:${uploadId}`).catch(e => console.error("  Upload cleanup failed (non-fatal):", e.message));
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "process_time_document") {
      // Time-report equivalent of process_payroll_document — same overall
      // flow, targeting TimeComp on the client's MASTER sheet instead of
      // Salaries on the client sheet, confirmed directly against the
      // original GAS script rather than assumed.
      const { masterSheetId: timeMasterSheetId, clientName: timeClientName,
        uploadId, confirmedMonth } = req.body;
      if (!timeMasterSheetId || !uploadId) {
        return res.status(400).json({ success: false, error: "Missing masterSheetId or uploadId" });
      }
      let fileData;
      try {
        const raw = await redisClient.get(`payroll_upload:${uploadId}`);
        if (!raw) throw new Error("Upload not found or expired — please try uploading again");
        fileData = JSON.parse(raw);
        if (!fileData || !fileData.data || !fileData.type) throw new Error("Uploaded file payload was malformed");
      } catch (fetchErr) {
        return res.status(400).json({ success: false, error: "Could not read uploaded file: " + fetchErr.message });
      }
      try {
        const sheets = await getSheetsClient();

        const empResp = await sheets.spreadsheets.values.get({
          spreadsheetId: timeMasterSheetId, range: "TimeComp!A12:A62",
        });
        const validEmployeeNames = (empResp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
        const namesString = JSON.stringify(validEmployeeNames);
        const currentDateContext = new Date().toLocaleDateString("en-GB", { month: "short", year: "numeric" });

        const promptText = `You are a time-tracking data extraction assistant. Analyze this time tracking document.

TASK 1: Identify the Period (Month/Year). Output format: "MMM YYYY" (e.g. "Jan 2026").
- CRITICAL DATE HANDLING: The current real-world date context is ${currentDateContext}. If the document explicitly states a month but does NOT provide a year, calculate and output the most recent instance of that month relative to this context date (e.g. if context is Jun 2026 and doc says May, output "May 2026"; if doc says Dec, output "Dec 2025"). If no period info is found at all, output "Unknown".

TASK 2: Extract Employee Data visible ON THE DOCUMENT.
- Go through the document row by row. Extract each person exactly ONCE.
- Match each name on the document to the closest name in this list: ${namesString}.
- If a name on the document has NO MATCH in the list, set mappedName to "NEW_STARTER".
- CRITICAL: Do NOT create entries for names in the list if they do not physically appear on the document.

TASK 3: Extract Hours.
- SEMANTIC FIELD MAPPING FOR HOURS: Document headers vary by client. Map the document's keys to output fields based on these concepts:
  * 'billableHrs': Billable, chargeable, or client hours (e.g. Billable Hours, Actual Billable, Charged Time).
  * 'totalHrs': Total, logged, worked, or overall hours (e.g. Total Hours, Total Logged, Hours Worked, Gross Hours).

Return ONLY valid JSON, no other text, matching exactly this structure:
{
  "period": "MMM YYYY or Unknown",
  "employees": [{ "originalName": "", "mappedName": "", "billableHrs": 0, "totalHrs": 0 }]
}`;

        let content;
        if (fileData.type === "text") {
          const verticalText = buildVerticalCsvText_(fileData.data);
          content = promptText + "\n\nDOCUMENT DATA (Vertical List):\n" + verticalText;
        } else {
          content = [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: fileData.data } },
            { type: "text", text: promptText },
          ];
        }

        const aiMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 6000, messages: [{ role: "user", content }] });
        await logClaudeUsage_(sheets, automationCommanderSheetId, timeClientName || "", "time_extract", aiMsg.usage?.input_tokens || 0, aiMsg.usage?.output_tokens || 0, "time_tool").catch(() => {});

        const rawText = aiMsg.content[0].type === "text" ? aiMsg.content[0].text : "";
        const cleanText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
        const jsonStart = cleanText.indexOf("{");
        const jsonEnd = cleanText.lastIndexOf("}");
        let extractedData;
        try {
          extractedData = JSON.parse(cleanText.slice(jsonStart, jsonEnd + 1));
        } catch (parseErr) {
          console.error("=== BROKEN AI JSON OUTPUT (time) ===\n" + rawText);
          return res.status(500).json({ success: false, error: "AI generated malformed JSON: " + parseErr.message });
        }
        if (!extractedData || !Array.isArray(extractedData.employees)) {
          return res.status(500).json({ success: false, error: "AI extracted data but 'employees' list was missing or invalid" });
        }

        const targetMonthStr = confirmedMonth || extractedData.period;
        if (!targetMonthStr || String(targetMonthStr).toLowerCase() === "unknown" || String(targetMonthStr).toLowerCase() === "null") {
          const d = new Date(); d.setMonth(d.getMonth() - 1);
          const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const fallback = months[d.getMonth()] + " " + d.getFullYear();
          // Not a final outcome — do NOT delete the Redis key, the follow-up
          // call with confirmedMonth still needs it.
          return res.status(200).json({ success: true, status: "CONFIRM_PERIOD", extractedData, fallback });
        }

        const writeResult = await writeTimeDataToSheet_(sheets, timeMasterSheetId, extractedData, targetMonthStr, validEmployeeNames);
        await redisClient.del(`payroll_upload:${uploadId}`).catch(e => console.error("  Upload cleanup failed (non-fatal):", e.message));

        // Auto-complete the linked EoM "time_import" task for this client,
        // same Option B pattern as payroll/cash/mark-actual — targetMonthStr
        // is the TARGET month, task status is tracked by WORK month, so it
        // must be derived before completing.
        if (writeResult.writeSuccess) {
          const timeTargetMonthKey = monthStrToEomKey_(targetMonthStr);
          const timeWorkMonthKey = eomTargetMonthToWorkMonth_(timeTargetMonthKey);
          await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, timeClientName, "time_import", timeWorkMonthKey);
        }

        return res.status(200).json({ success: true, status: "COMPLETE", extractedData, ...writeResult });
      } catch (err) {
        console.error("❌ process_time_document error:", err);
        await redisClient.del(`payroll_upload:${uploadId}`).catch(e => console.error("  Upload cleanup failed (non-fatal):", e.message));
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_get_templates") {
      // EoM (End of Month) tracking — Stage 1a: shared task template library.
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:H1000" });
        const rows = resp.data.values || [];
        const templates = rows.filter(r => r[0]).map((r, i) => ({
          templateId: r[0], name: r[1] || "", defaultNotes: r[2] || "", linkedFunction: r[3] || "",
          active: r[4] !== "FALSE" && r[4] !== false, createdAt: r[5] || "", alertCategories: r[6] || "",
          // Templates created before sortOrder existed have no value here —
          // fall back to row position, same pattern as EomClientTasks.
          sortOrder: r[7] !== undefined && r[7] !== "" ? Number(r[7]) : 1000000 + i,
        })).sort((a, b) => a.sortOrder - b.sortOrder);
        return res.status(200).json({ success: true, templates });
      } catch (err) {
        console.error("❌ eom_get_templates error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_get_excluded_clients") {
      // Renamed conceptually to "Manage Clients" on the frontend (19 Aug
      // 2026) — now tracks BOTH exclusion and display order for every
      // client, not just excluded ones. A client with no row here simply
      // isn't excluded and has no explicit order yet (frontend falls back
      // to alphabetical for those, matching the pre-existing default so
      // nothing shuffles until Paul actually drags something).
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomExcludedClients!A2:C1000" });
        const clients = (resp.data.values || []).filter(r => r[0]).map(r => ({
          clientName: r[0], excluded: r[1] === "TRUE" || r[1] === true,
          sortOrder: r[2] !== undefined && r[2] !== "" ? Number(r[2]) : null,
        }));
        return res.status(200).json({ success: true, clients });
      } catch (err) {
        console.error("❌ eom_get_excluded_clients error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_toggle_client_excluded") {
      // Creates a row (excluded=true, no sortOrder yet) or updates the
      // excluded flag on an existing row — never touches sortOrder here,
      // that's eom_reorder_clients' job.
      const { clientName: exClientName, excluded } = req.body;
      if (!exClientName) return res.status(400).json({ success: false, error: "Missing clientName" });
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomExcludedClients!A2:C1000" });
        const rows = resp.data.values || [];
        const rowIdx = rows.findIndex(r => r[0] === exClientName);

        if (rowIdx === -1) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: automationCommanderSheetId, range: "EomExcludedClients!A:C", valueInputOption: "RAW",
            requestBody: { values: [[exClientName, excluded, ""]] },
          });
        } else {
          await sheets.spreadsheets.values.update({
            spreadsheetId: automationCommanderSheetId, range: `EomExcludedClients!B${rowIdx + 2}`,
            valueInputOption: "RAW", requestBody: { values: [[excluded]] },
          });
        }
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ eom_toggle_client_excluded error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_reorder_clients") {
      // Persists a new display order for every client on the EoM screen.
      // Takes the FULL desired order — same full-list-rewrite approach as
      // the other reorder actions. Creates a row (excluded=false) for any
      // client that doesn't have one yet, since sortOrder needs to live
      // somewhere and this tab is already the place client-level EoM
      // settings live.
      const { orderedClientNames } = req.body;
      if (!Array.isArray(orderedClientNames) || orderedClientNames.length === 0) {
        return res.status(400).json({ success: false, error: "Missing orderedClientNames" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomExcludedClients!A2:C1000" });
        const rows = resp.data.values || [];
        const rowIdxByClient = {};
        rows.forEach((r, i) => { if (r[0]) rowIdxByClient[r[0]] = i; });

        const writes = [];
        const newRows = [];
        orderedClientNames.forEach((clientName, index) => {
          const sortOrder = (index + 1) * 10;
          if (clientName in rowIdxByClient) {
            const sheetRow = rowIdxByClient[clientName] + 2;
            writes.push({ range: `EomExcludedClients!C${sheetRow}`, values: [[sortOrder]] });
          } else {
            newRows.push([clientName, false, sortOrder]);
          }
        });
        if (writes.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: automationCommanderSheetId, requestBody: { valueInputOption: "RAW", data: writes },
          });
        }
        if (newRows.length > 0) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: automationCommanderSheetId, range: "EomExcludedClients!A:C", valueInputOption: "RAW",
            requestBody: { values: newRows },
          });
        }
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ eom_reorder_clients error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_save_template") {
      // Create (no templateId given) or update (templateId given) a shared
      // task template. Templates are never hard-deleted — set active:false
      // to retire one without breaking existing client assignments that
      // still reference it. alertCategories only applies when
      // linkedFunction === "alert_check" — a comma-separated subset of
      // "invoice,expense,crm" picking which live discrepancy categories
      // this template checks (see conversation 19 Aug 2026).
      const { templateId, name, defaultNotes, linkedFunction, active, alertCategories } = req.body;
      if (!name) return res.status(400).json({ success: false, error: "Missing name" });
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:H1000" });
        const rows = resp.data.values || [];

        if (templateId) {
          const rowIdx = rows.findIndex(r => r[0] === templateId);
          if (rowIdx === -1) return res.status(404).json({ success: false, error: "Template not found" });
          const sheetRow = rowIdx + 2;
          await sheets.spreadsheets.values.update({
            spreadsheetId: automationCommanderSheetId, range: `EomTemplates!B${sheetRow}:E${sheetRow}`,
            valueInputOption: "RAW", requestBody: { values: [[name, defaultNotes || "", linkedFunction || "", active !== false]] },
          });
          await sheets.spreadsheets.values.update({
            spreadsheetId: automationCommanderSheetId, range: `EomTemplates!G${sheetRow}`,
            valueInputOption: "RAW", requestBody: { values: [[alertCategories || ""]] },
          });
          return res.status(200).json({ success: true, templateId });
        }

        // Default sortOrder is "now" — large enough to always sort after
        // any explicitly-ordered template, so a new one lands at the end
        // of the picker by default; reorder afterward if it needs to move.
        const newId = `tmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await sheets.spreadsheets.values.append({
          spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A:H", valueInputOption: "RAW",
          requestBody: { values: [[newId, name, defaultNotes || "", linkedFunction || "", true, new Date().toISOString(), alertCategories || "", Date.now()]] },
        });
        return res.status(200).json({ success: true, templateId: newId });
      } catch (err) {
        console.error("❌ eom_save_template error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_get_client_tasks") {
      // Stage 1b: per-client task assignments — either a reference to a
      // shared template (templateId set) or a one-off task unique to that
      // client (templateId blank, taskName set directly). Resolves the
      // effective task name server-side so the frontend doesn't need to
      // separately fetch templates just to display a list.
      const { clientName: filterClient } = req.body;
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const [tasksResp, templatesResp] = await Promise.all([
          sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" }),
          sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:G1000" }),
        ]);
        const templateNameById = {};
        const templateLinkedFunctionById = {};
        const templateAlertCategoriesById = {};
        (templatesResp.data.values || []).forEach(r => {
          if (r[0]) { templateNameById[r[0]] = r[1] || ""; templateLinkedFunctionById[r[0]] = r[3] || ""; templateAlertCategoriesById[r[0]] = r[6] || ""; }
        });

        const rows = (tasksResp.data.values || []).filter(r => r[0]);
        const tasks = rows
          .filter(r => !filterClient || r[1] === filterClient)
          .map((r, i) => ({
            taskId: r[0], clientName: r[1], templateId: r[2] || "",
            name: r[2] ? (templateNameById[r[2]] || "(template deleted)") : (r[3] || ""),
            linkedFunction: r[2] ? (templateLinkedFunctionById[r[2]] || "") : "",
            alertCategories: r[2] ? (templateAlertCategoriesById[r[2]] || "") : "",
            clientNotes: r[4] || "", active: r[5] !== "FALSE" && r[5] !== false, createdAt: r[6] || "",
            // Tasks created before sortOrder existed have no value here —
            // fall back to their row position so they still sort sensibly
            // (in whatever order they were originally created) rather than
            // all collapsing to the same rank.
            sortOrder: r[7] !== undefined && r[7] !== "" ? Number(r[7]) : 1000000 + i,
          }))
          .sort((a, b) => a.sortOrder - b.sortOrder);
        return res.status(200).json({ success: true, tasks });
      } catch (err) {
        console.error("❌ eom_get_client_tasks error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_get_client_detail") {
      // Combines eom_get_client_tasks + eom_get_month_status (scoped to one
      // client) into a single call — these two always fire together
      // whenever the detail screen opens or its month changes, and were
      // separately reading EomClientTasks each time, doubling that read
      // for no reason. Added 19 Aug 2026 to reduce load on Google's
      // per-user read quota, alongside caching ensureEomTabs_'s own check.
      // Other callers that only need the task list refreshed (saving
      // notes, toggling active, adding a task — none of which touch
      // status) still use the lighter eom_get_client_tasks on its own.
      const { clientName: detailClient, monthKey: detailMonthKey } = req.body;
      if (!detailClient || !detailMonthKey) {
        return res.status(400).json({ success: false, error: "Missing clientName or monthKey" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const [tasksResp, templatesResp, statusResp] = await Promise.all([
          sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" }),
          sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:G1000" }),
          sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:E200000" }),
        ]);
        const templateNameById = {};
        const templateLinkedFunctionById = {};
        const templateAlertCategoriesById = {};
        (templatesResp.data.values || []).forEach(r => {
          if (r[0]) { templateNameById[r[0]] = r[1] || ""; templateLinkedFunctionById[r[0]] = r[3] || ""; templateAlertCategoriesById[r[0]] = r[6] || ""; }
        });

        const rows = (tasksResp.data.values || []).filter(r => r[0]);
        const tasks = rows
          .filter(r => r[1] === detailClient)
          .map((r, i) => ({
            taskId: r[0], clientName: r[1], templateId: r[2] || "",
            name: r[2] ? (templateNameById[r[2]] || "(template deleted)") : (r[3] || ""),
            linkedFunction: r[2] ? (templateLinkedFunctionById[r[2]] || "") : "",
            alertCategories: r[2] ? (templateAlertCategoriesById[r[2]] || "") : "",
            clientNotes: r[4] || "", active: r[5] !== "FALSE" && r[5] !== false, createdAt: r[6] || "",
            sortOrder: r[7] !== undefined && r[7] !== "" ? Number(r[7]) : 1000000 + i,
          }))
          .sort((a, b) => a.sortOrder - b.sortOrder);

        const statusOverrides = (statusResp.data.values || [])
          .filter(r => r[0] === detailClient && r[2] === detailMonthKey)
          .map(r => ({ clientName: r[0], taskId: r[1], status: r[3] || "pending" }));

        return res.status(200).json({ success: true, tasks, statusOverrides });
      } catch (err) {
        console.error("❌ eom_get_client_detail error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_save_client_task") {
      // Create/update a client's task assignment. Either templateId (pulls
      // from the shared library) or taskName (a one-off custom task) must
      // be given — not both. clientNotes sit alongside a template
      // assignment without altering the shared template itself.
      const { taskId, clientName: taskClientName, templateId: taskTemplateId, taskName, clientNotes, active: taskActive } = req.body;
      if (!taskClientName) return res.status(400).json({ success: false, error: "Missing clientName" });
      if (!taskTemplateId && !taskName) return res.status(400).json({ success: false, error: "Must provide either templateId or taskName" });
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" });
        const rows = resp.data.values || [];

        if (taskId) {
          const rowIdx = rows.findIndex(r => r[0] === taskId);
          if (rowIdx === -1) return res.status(404).json({ success: false, error: "Task assignment not found" });
          const sheetRow = rowIdx + 2;
          await sheets.spreadsheets.values.update({
            spreadsheetId: automationCommanderSheetId, range: `EomClientTasks!B${sheetRow}:F${sheetRow}`,
            valueInputOption: "RAW", requestBody: { values: [[taskClientName, taskTemplateId || "", taskName || "", clientNotes || "", taskActive !== false]] },
          });
          return res.status(200).json({ success: true, taskId });
        }

        const newId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // Default sortOrder is "now" — large enough to always sort after any
        // explicitly-ordered task, so a new task lands at the end of the
        // list by default; reorder afterward if it needs to move.
        await sheets.spreadsheets.values.append({
          spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A:H", valueInputOption: "RAW",
          requestBody: { values: [[newId, taskClientName, taskTemplateId || "", taskName || "", clientNotes || "", true, new Date().toISOString(), Date.now()]] },
        });
        return res.status(200).json({ success: true, taskId: newId });
      } catch (err) {
        console.error("❌ eom_save_client_task error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_get_month_status") {
      // Stage 2: monthly status for a given month (all clients, or one).
      // Strictly READ-ONLY — an earlier version lazily wrote "pending"
      // rows here for any task without one yet, which raced against a
      // user's own status-change click landing at the same moment
      // (opening the detail screen and clicking "Done" almost
      // immediately could see the click's write silently overwritten by
      // the lazy-generation's own, slightly slower batch write). Fixed
      // 18 Aug 2026 by removing all writes from this action.
      //
      // Returns activeTasks (every currently-active task, regardless of
      // whether a status row exists) alongside statusOverrides (only the
      // EXPLICIT rows that exist for this month). Callers combine the
      // two: an override of "done" wins; "not_applicable" means excluded
      // from the count entirely; no override at all defaults to "pending".
      //
      // activeTasks also carries linkedFunction/alertCategories (added 19
      // Aug 2026) — "alert_check" tasks never write status overrides at
      // all, by design (their status is always computed live from current
      // alert state, never persisted — see conversation 19 Aug 2026), so
      // any caller aggregating counts (the Overview screen) needs these
      // fields to compute their live status itself, rather than always
      // defaulting them to "pending" the way a genuinely-unset task would.
      const { monthKey, clientName: statusClient } = req.body;
      if (!monthKey) return res.status(400).json({ success: false, error: "Missing monthKey (e.g. 2026-08)" });
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);

        const [tasksResp, templatesResp] = await Promise.all([
          sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:G5000" }),
          sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:G1000" }),
        ]);
        const templateLinkedFunctionById = {};
        const templateAlertCategoriesById = {};
        (templatesResp.data.values || []).forEach(r => {
          if (r[0]) { templateLinkedFunctionById[r[0]] = r[3] || ""; templateAlertCategoriesById[r[0]] = r[6] || ""; }
        });

        const activeTasks = (tasksResp.data.values || [])
          .filter(r => r[0] && (r[5] !== "FALSE" && r[5] !== false))
          .filter(r => !statusClient || r[1] === statusClient)
          .map(r => ({
            taskId: r[0], clientName: r[1],
            linkedFunction: r[2] ? (templateLinkedFunctionById[r[2]] || "") : "",
            alertCategories: r[2] ? (templateAlertCategoriesById[r[2]] || "") : "",
          }));

        const statusResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:E200000" });
        const statusOverrides = (statusResp.data.values || [])
          .filter(r => r[0] && r[2] === monthKey)
          .map(r => ({ clientName: r[0], taskId: r[1], status: r[3] || "pending" }));

        return res.status(200).json({ success: true, monthKey, activeTasks, statusOverrides });
      } catch (err) {
        console.error("❌ eom_get_month_status error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_update_task_status") {
      // Sets a client+task's status for a given month: "done", "pending",
      // or "not_applicable" (see the note on eom_get_month_status above for
      // why not_applicable is stored, not just deleted).
      const { clientName: uClientName, taskId: uTaskId, monthKey: uMonthKey, status: uStatus } = req.body;
      if (!uClientName || !uTaskId || !uMonthKey || !uStatus) {
        return res.status(400).json({ success: false, error: "Missing clientName, taskId, monthKey, or status" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:E200000" });
        const rows = resp.data.values || [];
        const rowIdx = rows.findIndex(r => r[0] === uClientName && r[1] === uTaskId && r[2] === uMonthKey);
        const completedAt = uStatus === "done" ? new Date().toISOString() : "";

        if (rowIdx === -1) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A:E", valueInputOption: "RAW",
            requestBody: { values: [[uClientName, uTaskId, uMonthKey, uStatus, completedAt]] },
          });
        } else {
          const sheetRow = rowIdx + 2;
          await sheets.spreadsheets.values.update({
            spreadsheetId: automationCommanderSheetId, range: `EomMonthlyStatus!D${sheetRow}:E${sheetRow}`,
            valueInputOption: "RAW", requestBody: { values: [[uStatus, completedAt]] },
          });
        }
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ eom_update_task_status error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_reorder_tasks") {
      // Persists a new task order for one client. Takes the FULL desired
      // order (a list of taskIds), not just a single move — the frontend
      // computes the swap locally and sends the complete resulting list,
      // which this simply rewrites as sequential sortOrder values. Simpler
      // and more robust than a "move up/down by one" server-side operation,
      // since it can never end up ambiguous about what order things were in.
      const { clientName: rClientName, orderedTaskIds } = req.body;
      if (!rClientName || !Array.isArray(orderedTaskIds) || orderedTaskIds.length === 0) {
        return res.status(400).json({ success: false, error: "Missing clientName or orderedTaskIds" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" });
        const rows = resp.data.values || [];
        const rowIndexByTaskId = {};
        rows.forEach((r, i) => { if (r[0]) rowIndexByTaskId[r[0]] = i + 2; });

        const writes = [];
        orderedTaskIds.forEach((taskId, index) => {
          const sheetRow = rowIndexByTaskId[taskId];
          if (!sheetRow) return; // unknown taskId — skip rather than fail the whole reorder
          writes.push({ range: `EomClientTasks!H${sheetRow}`, values: [[(index + 1) * 10]] });
        });
        if (writes.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: automationCommanderSheetId, requestBody: { valueInputOption: "RAW", data: writes },
          });
        }
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ eom_reorder_tasks error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_reorder_templates") {
      // Persists a new order for the whole template library — controls the
      // order templates appear in the "add task" picker dropdown. Same
      // full-list-rewrite approach as eom_reorder_tasks above, for the
      // same reason: never ambiguous about what order things were in.
      const { orderedTemplateIds } = req.body;
      if (!Array.isArray(orderedTemplateIds) || orderedTemplateIds.length === 0) {
        return res.status(400).json({ success: false, error: "Missing orderedTemplateIds" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:H1000" });
        const rows = resp.data.values || [];
        const rowIndexByTemplateId = {};
        rows.forEach((r, i) => { if (r[0]) rowIndexByTemplateId[r[0]] = i + 2; });

        const writes = [];
        orderedTemplateIds.forEach((templateId, index) => {
          const sheetRow = rowIndexByTemplateId[templateId];
          if (!sheetRow) return; // unknown templateId — skip rather than fail the whole reorder
          writes.push({ range: `EomTemplates!H${sheetRow}`, values: [[(index + 1) * 10]] });
        });
        if (writes.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: automationCommanderSheetId, requestBody: { valueInputOption: "RAW", data: writes },
          });
        }
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("❌ eom_reorder_templates error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_load_bank_accounts") {
      // Refreshes the cached bank-account list for every client, reading
      // KeyInfo!H12:H22 on each client's own sheet (confirmed mirrored
      // identically between client and master sheets, so client sheet is
      // used, consistent with where the Cash tab write also happens).
      // A per-client failure doesn't abort the whole load — reported back
      // so it's clear which clients need a manual look. Wholesale refresh:
      // clears whatever was cached before, then writes the fresh set —
      // deliberately manual/on-demand (a button), not run automatically,
      // since account names change rarely and this reads every client's
      // sheet in one pass.
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);

        const clientResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "AutoUpdates!A2:N500" });
        const clients = (clientResp.data.values || [])
          .map(r => ({ clientName: String(r[0] || "").trim(), clientSheetUrl: r[11] }))
          .filter(c => c.clientName && c.clientSheetUrl)
          .filter(c => c.clientName.toLowerCase() !== "client" && c.clientName.toLowerCase() !== "client name");

        const loadedAt = new Date().toISOString();
        const newRows = [];
        const failedClients = [];
        for (const c of clients) {
          try {
            const clientSheetId = extractSheetIdFromUrl(c.clientSheetUrl) || String(c.clientSheetUrl).trim();
            const resp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "KeyInfo!H12:H22" });
            const accountNames = (resp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
            accountNames.forEach(name => newRows.push([c.clientName, name, loadedAt]));
          } catch (clientErr) {
            failedClients.push(c.clientName);
          }
        }

        const existingResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomBankAccounts!A2:C50000" });
        const existingRowCount = (existingResp.data.values || []).length;
        if (existingRowCount > 0) {
          await sheets.spreadsheets.values.clear({
            spreadsheetId: automationCommanderSheetId, range: `EomBankAccounts!A2:C${existingRowCount + 1}`,
          });
        }
        if (newRows.length > 0) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: automationCommanderSheetId, range: "EomBankAccounts!A2", valueInputOption: "RAW",
            requestBody: { values: newRows },
          });
        }

        return res.status(200).json({ success: true, clientsProcessed: clients.length, accountsLoaded: newRows.length, failedClients });
      } catch (err) {
        console.error("❌ eom_load_bank_accounts error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_get_bank_accounts") {
      // Reads the cached bank-account list (populated by eom_load_bank_accounts)
      // — never touches live client sheets, that's the whole point of caching.
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomBankAccounts!A2:C50000" });
        const rows = (resp.data.values || []).filter(r => r[0] && r[1]);
        const accountsByClient = {};
        let loadedAt = "";
        rows.forEach(r => {
          if (!accountsByClient[r[0]]) accountsByClient[r[0]] = [];
          accountsByClient[r[0]].push(r[1]);
          if (r[2]) loadedAt = r[2]; // every row from the same load shares this — any one is representative
        });
        return res.status(200).json({ success: true, accountsByClient, loadedAt });
      } catch (err) {
        console.error("❌ eom_get_bank_accounts error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_get_cash_balance_progress") {
      // Returns which clients already have their "cash_balance"-linked
      // task marked done for the given TARGET month — used to filter the
      // sequential entry flow down to only clients not yet completed.
      // monthKey here is the target month (the screen's own selector,
      // "which month's closing balance") — task status is tracked by WORK
      // month, so it must be derived before checking (see the EoM WORK
      // MONTH vs TARGET MONTH block above).
      const { monthKey: progressTargetMonthKey } = req.body;
      if (!progressTargetMonthKey) return res.status(400).json({ success: false, error: "Missing monthKey" });
      const progressWorkMonthKey = eomTargetMonthToWorkMonth_(progressTargetMonthKey);
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);
        const [templatesR, clientTasksR, statusR] = await Promise.all([
          sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:F1000" }),
          sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:H5000" }),
          sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomMonthlyStatus!A2:E200000" }),
        ]);
        const cashTemplateIds = new Set((templatesR.data.values || []).filter(r => r[0] && r[3] === "cash_balance").map(r => r[0]));
        const cashTaskIdByClient = {};
        (clientTasksR.data.values || []).forEach(r => {
          if (r[0] && cashTemplateIds.has(r[2]) && (r[5] !== "FALSE" && r[5] !== false)) cashTaskIdByClient[r[1]] = r[0];
        });
        const statusRows = statusR.data.values || [];
        const completedClients = Object.keys(cashTaskIdByClient).filter(clientName => {
          const taskId = cashTaskIdByClient[clientName];
          return statusRows.some(r => r[0] === clientName && r[1] === taskId && r[2] === progressWorkMonthKey && r[3] === "done");
        });
        return res.status(200).json({ success: true, completedClients, hasLinkedTemplate: cashTemplateIds.size > 0 });
      } catch (err) {
        console.error("❌ eom_get_cash_balance_progress error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_save_cash_balance") {
      // Writes a client's closing cash balance as a formula (sum of each
      // account's amount, e.g. =1045.45+105.67+4109.07) into the Cash
      // tab's "Actual closing balance" row, in the column matching the
      // given TARGET month. Auto-completes the linked "cash_balance" EoM
      // task for the derived WORK month (target + 1) — never the target
      // month itself, which was the bug fixed 19 Aug 2026.
      const { clientSheetId: cashClientSheetId, clientName: cashClientName, monthKey: cashTargetMonthKey, amounts } = req.body;
      if (!cashClientSheetId || !cashClientName || !cashTargetMonthKey || !Array.isArray(amounts) || amounts.length === 0) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId, clientName, monthKey, or amounts" });
      }
      const numericAmounts = amounts.map(a => parseFloat(a)).filter(a => !isNaN(a) && a !== 0);
      if (numericAmounts.length === 0) {
        return res.status(400).json({ success: false, error: "No valid, non-zero amounts provided" });
      }
      try {
        const sheets = await getSheetsClient();
        const monthLabel = eomKeyToMonthStr_(cashTargetMonthKey);
        const [headerResp, colAResp] = await Promise.all([
          sheets.spreadsheets.values.get({ spreadsheetId: cashClientSheetId, range: "Cash!1:1" }),
          sheets.spreadsheets.values.get({ spreadsheetId: cashClientSheetId, range: "Cash!A1:A200" }),
        ]);
        const headers = headerResp.data.values?.[0] || [];
        let targetColIdx0 = -1;
        for (let i = 0; i < headers.length; i++) {
          if (headers[i] && isDateMatchJs_(headers[i], monthLabel)) { targetColIdx0 = i; break; }
        }
        if (targetColIdx0 === -1) {
          return res.status(400).json({ success: false, error: `Could not find a column for ${monthLabel} on the Cash tab.` });
        }
        const colAValues = colAResp.data.values || [];
        const targetRowIdx = colAValues.findIndex(r => String(r[0] || "").trim().toLowerCase() === "actual closing balance");
        if (targetRowIdx === -1) {
          return res.status(400).json({ success: false, error: `Could not find a row labelled "Actual closing balance" on the Cash tab.` });
        }
        const targetColLetter = columnIndexToLetter_(targetColIdx0 + 1);
        const targetRow = targetRowIdx + 1;
        const formula = "=" + numericAmounts.join("+");

        await sheets.spreadsheets.values.update({
          spreadsheetId: cashClientSheetId, range: `Cash!${targetColLetter}${targetRow}`,
          valueInputOption: "USER_ENTERED", requestBody: { values: [[formula]] },
        });

        const cashWorkMonthKey = eomTargetMonthToWorkMonth_(cashTargetMonthKey);
        await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, cashClientName, "cash_balance", cashWorkMonthKey);

        return res.status(200).json({ success: true, formula, targetCol: targetColLetter, targetRow });
      } catch (err) {
        console.error("❌ eom_save_cash_balance error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_mark_month_actual") {
      // Simple, single-client EoM function called directly from a task
      // row (not a batch tool with its own sub-tab, unlike payroll/cash
      // balance — Paul was explicit this is always per-client, triggered
      // from the checklist itself). Writes "Actual" into row 2 of the
      // client's Performance tab, in the TARGET month's column, derived
      // from the WORK month the checklist screen was actually showing
      // when this was called — never computed independently from "today"
      // (see the EoM WORK MONTH vs TARGET MONTH block above; that
      // independent-computation pattern is what caused this to mark the
      // wrong checklist item done on 19 Aug 2026). Auto-completes the
      // linked "mark_actual" EoM task for the WORK month.
      const { clientSheetId: perfClientSheetId, clientName: perfClientName, workMonthKey: perfWorkMonthKey } = req.body;
      if (!perfClientSheetId || !perfClientName || !perfWorkMonthKey) {
        return res.status(400).json({ success: false, error: "Missing clientSheetId, clientName, or workMonthKey" });
      }
      try {
        const sheets = await getSheetsClient();
        const targetMonthKey = eomWorkMonthToTargetMonth_(perfWorkMonthKey);
        const monthLabel = eomKeyToMonthStr_(targetMonthKey);

        const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId: perfClientSheetId, range: "Performance!1:1" });
        const headers = headerResp.data.values?.[0] || [];
        let targetColIdx0 = -1;
        for (let i = 0; i < headers.length; i++) {
          if (headers[i] && isDateMatchJs_(headers[i], monthLabel)) { targetColIdx0 = i; break; }
        }
        if (targetColIdx0 === -1) {
          return res.status(400).json({ success: false, error: `Could not find a column for ${monthLabel} on the Performance tab.` });
        }
        const targetColLetter = columnIndexToLetter_(targetColIdx0 + 1);

        await sheets.spreadsheets.values.update({
          spreadsheetId: perfClientSheetId, range: `Performance!${targetColLetter}2`,
          valueInputOption: "USER_ENTERED", requestBody: { values: [["Actual"]] },
        });

        await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, perfClientName, "mark_actual", perfWorkMonthKey);

        return res.status(200).json({ success: true, monthLabel, targetCol: targetColLetter });
      } catch (err) {
        console.error("❌ eom_mark_month_actual error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "eom_seed_from_checklist") {
      // One-time migration from Paul's original CFO_task_checklist.xlsx —
      // see conversation 18 Aug 2026. EOM_SEED_DATA uses the SHORT client
      // names as they appeared in that spreadsheet; matched here against
      // the live, full client list rather than trusted as exact. Idempotent:
      // safe to re-run — checks for existing templates/assignments by name
      // before creating anything, so a partial or repeated run won't create
      // duplicates.
      try {
        const sheets = await getSheetsClient();
        await ensureEomTabs_(sheets, automationCommanderSheetId);

        const clientResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "AutoUpdates!A2:N500" });
        const liveClients = (clientResp.data.values || [])
          .map(r => String(r[0] || "").trim())
          .filter(Boolean)
          .filter(n => n.toLowerCase() !== "client" && n.toLowerCase() !== "client name");

        const matchShortName = (shortName) => {
          const norm = shortName.trim().toLowerCase();
          const matches = liveClients.filter(full => full.toLowerCase().startsWith(norm) || full.toLowerCase().includes(norm));
          return matches.length === 1 ? matches[0] : null;
        };

        const unmatched = new Set();
        const shortNamesUsed = new Set();
        EOM_SEED_DATA.templates.forEach(t => Object.keys(t.clients).forEach(c => shortNamesUsed.add(c)));
        Object.keys(EOM_SEED_DATA.customTasks).forEach(c => shortNamesUsed.add(c));
        const shortToFull = {};
        shortNamesUsed.forEach(s => {
          const full = matchShortName(s);
          if (full) shortToFull[s] = full; else unmatched.add(s);
        });

        const existingTemplatesResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A2:F1000" });
        const existingTemplateByName = {};
        (existingTemplatesResp.data.values || []).forEach(r => { if (r[0]) existingTemplateByName[r[1]] = r[0]; });

        const newTemplateRows = [];
        const templateIdByName = { ...existingTemplateByName };
        for (const t of EOM_SEED_DATA.templates) {
          if (templateIdByName[t.name]) continue;
          const newId = `tmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const linkedFunction = t.name.toLowerCase().includes("salaries") ? "salaries" : "";
          newTemplateRows.push([newId, t.name, "", linkedFunction, true, new Date().toISOString()]);
          templateIdByName[t.name] = newId;
        }
        if (newTemplateRows.length > 0) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: automationCommanderSheetId, range: "EomTemplates!A:F", valueInputOption: "RAW",
            requestBody: { values: newTemplateRows },
          });
        }

        const existingTasksResp = await sheets.spreadsheets.values.get({ spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A2:G5000" });
        const existingTaskKeys = new Set();
        (existingTasksResp.data.values || []).forEach(r => {
          if (r[0]) existingTaskKeys.add(`${r[1]}|||${r[2] || ""}|||${r[3] || ""}`);
        });

        const newTaskRows = [];
        let assignmentsCreated = 0;
        const orderCounter = {}; // per-client counter, so each client's seeded tasks get a sensible sequential order
        const nextOrder = (client) => { orderCounter[client] = (orderCounter[client] || 0) + 1; return orderCounter[client]; };

        for (const t of EOM_SEED_DATA.templates) {
          const templateId = templateIdByName[t.name];
          for (const [shortName, originalText] of Object.entries(t.clients)) {
            const fullName = shortToFull[shortName];
            if (!fullName) continue;
            const key = `${fullName}|||${templateId}|||`;
            if (existingTaskKeys.has(key)) continue;
            const newId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            newTaskRows.push([newId, fullName, templateId, "", originalText, true, new Date().toISOString(), nextOrder(fullName)]);
            existingTaskKeys.add(key);
            assignmentsCreated++;
          }
        }
        for (const [shortName, taskList] of Object.entries(EOM_SEED_DATA.customTasks)) {
          const fullName = shortToFull[shortName];
          if (!fullName) continue;
          for (const taskName of taskList) {
            const key = `${fullName}|||${""}|||${taskName}`;
            if (existingTaskKeys.has(key)) continue;
            const newId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            newTaskRows.push([newId, fullName, "", taskName, "", true, new Date().toISOString(), nextOrder(fullName)]);
            existingTaskKeys.add(key);
            assignmentsCreated++;
          }
        }
        if (newTaskRows.length > 0) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: automationCommanderSheetId, range: "EomClientTasks!A:H", valueInputOption: "RAW",
            requestBody: { values: newTaskRows },
          });
        }

        return res.status(200).json({
          success: true,
          templatesCreated: newTemplateRows.length,
          assignmentsCreated,
          matchedClients: Object.keys(shortToFull).length,
          unmatchedClients: Array.from(unmatched),
        });
      } catch (err) {
        console.error("❌ eom_seed_from_checklist error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else {
      res.status(400).json({ error: "Invalid action" });
    }
  } catch (error) {
    console.error("Triage API error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}


// ============================================================================
// PROACTIVE CHECKS (Translated from Google Apps Script)
// ============================================================================

function parseConfirmedDate_(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  
  // Handle Google Sheets serial dates (from UNFORMATTED_VALUE)
  if (typeof val === "number") {
    return new Date((val - 25569) * 86400 * 1000);
  }
  
  const s = String(val).trim();
  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    return new Date(yr, months[m[2]], parseInt(m[1], 10));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function detectPeriodMultiplier_(childRow, monthlyRevenue) {
  if (!monthlyRevenue || monthlyRevenue <= 0) return 1;
  const inv1Amt = parseFloat(String(childRow[41] || "0").replace(/[£$€,\s]/g, "")) || 0;
  if (inv1Amt <= 0) return 1;
  return Math.max(1, Math.round(inv1Amt / monthlyRevenue));
}

function sumInvSlotAmounts_(row) {
  let total = 0;
  const slotAmtIdxs = [41, 48, 55];
  for (let s = 0; s < slotAmtIdxs.length; s++) {
    const raw = row[slotAmtIdxs[s]];
    if (raw === "" || raw === null || raw === undefined) continue;
    total += parseFloat(String(raw).replace(/[£$€,\s]/g, "")) || 0;
  }
  return total;
}

function sumRealInvSlotAmounts_(row) {
  let total = 0, draftCount = 0, draftTotal = 0;
  const slots = [
    { amtIdx: 41, refIdx: 42, statusIdx: 45 },
    { amtIdx: 48, refIdx: 49, statusIdx: 52 },
    { amtIdx: 55, refIdx: 56, statusIdx: 59 },
  ];
  for (let s = 0; s < slots.length; s++) {
    const ref = String(row[slots[s].refIdx] || "").trim();
    if (!ref || ref.toUpperCase().indexOf("MANUAL-INV") === 0) continue;
    const raw = row[slots[s].amtIdx];
    if (raw === "" || raw === null || raw === undefined) continue;
    const amt = parseFloat(String(raw).replace(/[£$€,\s]/g, "")) || 0;
    const status = String(row[slots[s].statusIdx] || "").trim().toLowerCase();
    if (status.indexOf("sent") !== -1 || status.indexOf("paid") !== -1) {
      total += amt;
    } else {
      draftCount++;
      draftTotal += amt;
    }
  }
  return { total, draftCount, draftTotal };
}

function sumExpSlotAmounts_(row) {
  let total = 0;
  const slotAmtIdxs = [76, 83, 90];
  for (let s = 0; s < slotAmtIdxs.length; s++) {
    const raw = row[slotAmtIdxs[s]];
    if (raw === "" || raw === null || raw === undefined) continue;
    total += parseFloat(String(raw).replace(/[£$€,\s]/g, "")) || 0;
  }
  return total;
}

function collectJobRows_(data, parentIdx) {
  const rows = [];
  const parentClient = String(data[parentIdx][0] || "").trim().toLowerCase();
  const parentJob    = String(data[parentIdx][1] || "").trim().toLowerCase();
  rows.push({ row: data[parentIdx], sheetRow: parentIdx + 1, isParent: true });
  for (let ri = parentIdx + 1; ri < data.length; ri++) {
    const r = data[ri];
    const rc = String(r[0] || "").trim().toLowerCase();
    const rj = String(r[1] || "").trim().toLowerCase();
    if (!rc || !rj) break;
    if (rc !== parentClient || rj !== parentJob) break;
    if (r[32] || r[37] || r[38]) break;
    rows.push({ row: r, sheetRow: ri + 1, isParent: false });
  }
  return rows;
}

function buildStableJobKey_(clientNameRow, jobName, projectCode, startVal, endVal) {
  const base = String(clientNameRow || "").trim().toLowerCase() + "|" + String(jobName || "").trim().toLowerCase();
  const code = String(projectCode || "").trim();
  if (code) return base + "|code:" + code.toLowerCase();
  const fmtPart = (v) => {
    if (!v) return "";
    const d = v instanceof Date ? v : parseConfirmedDate_(v);
    if (!d) return String(v).trim().toLowerCase();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  return base + "|dates:" + fmtPart(startVal) + ":" + fmtPart(endVal);
}

function collectSentInvoices_(row, sentInvoices) {
  const slots = [{ statusIdx: 45, sentIdx: 43 }, { statusIdx: 52, sentIdx: 50 }, { statusIdx: 59, sentIdx: 57 }];
  for (let s = 0; s < slots.length; s++) {
    const status = String(row[slots[s].statusIdx] || "").trim().toLowerCase();
        if (status !== "sent" && status !== "paid") continue;
        const sentVal = row[slots[s].sentIdx];
        if (!sentVal) continue;
        const sentDate = parseConfirmedDate_(sentVal);
        if (sentDate) sentInvoices.push(sentDate);
      }
    }

function inferFrequency_(sortedDates) {
  if (sortedDates.length < 2) return 30;
  const gaps = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gaps.push(Math.round((sortedDates[i].getTime() - sortedDates[i-1].getTime()) / 86400000));
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const standards = [30, 60, 90, 180, 365];
  let closest = standards[0];
  let minDiff = Math.abs(median - standards[0]);
  for (let j = 1; j < standards.length; j++) {
    const diff = Math.abs(median - standards[j]);
    if (diff < minDiff) { minDiff = diff; closest = standards[j]; }
  }
  return closest;
}

async function findPossibleRetainerInvoice_(masterSheetId, clientSheetId, endClientName, expectedDate, sharedData, sheets) {
  try {
    let invData = [];
    try {
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "InvComp!A6:K5000" });
      invData = resp.data.values || [];
    } catch(e) { return null; }

    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const expectedTime = expectedDate.getTime();
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    const candidates = [];
    for (let r = 0; r < invData.length; r++) {
      const row = invData[r];
      const invClient = String(row[0] || "").trim();
      if (invClient.toLowerCase() !== endClientName.toLowerCase()) continue;

      const sentVal = row[6];
      if (!sentVal) continue;
      const sentDate = sentVal instanceof Date ? sentVal : new Date(sentVal);
      if (isNaN(sentDate.getTime())) continue;
      if (Math.abs(sentDate.getTime() - expectedTime) > windowMs) continue;

      const invoiceNo    = String(row[5] || "").trim();
      const invoiceAmt   = parseFloat(String(row[2] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const totalExclVAT = parseFloat(String(row[3] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const vatAmount    = parseFloat(String(row[4] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const status       = String(row[9] || "").trim();
      candidates.push({ invoiceNo, amount: totalExclVAT > 0 ? totalExclVAT : invoiceAmt, sentDate, vatAmount, status });
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const aReal = (String(a.status||"").toLowerCase() === "sent" || String(a.status||"").toLowerCase() === "paid");
      const bReal = (String(b.status||"").toLowerCase() === "sent" || String(b.status||"").toLowerCase() === "paid");
      if (aReal !== bReal) return aReal ? -1 : 1;
      return Math.abs(a.sentDate.getTime() - expectedTime) - Math.abs(b.sentDate.getTime() - expectedTime);
    });
    const best = candidates[0];

    const result = {
      invoiceNo: best.invoiceNo, amount: best.amount, sentDate: fmtDate(best.sentDate),
      vatAmount: best.vatAmount || 0, status: best.status || "", confidence: "medium", attachedToRow: null,
    };

    let confData = sharedData?.confirmedData;
    if (!confData) {
      try {
        const confResp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Confirmed!A1:BH5000" });
        confData = confResp.data.values || [];
      } catch(e) { confData = []; }
    }

    if (confData && confData.length > 0) {
      const refCols = [42, 49, 56];
      let attachedRow = null, attachedJobStart = null, attachedJobEnd = null, attachedJobInvCount = 0;
      
      for (let cr = 1; cr < confData.length; cr++) {
        const crow = confData[cr];
        for (let rc = 0; rc < refCols.length; rc++) {
          const ref = String(crow[refCols[rc]] || "").trim();
          if (ref && best.invoiceNo && ref === best.invoiceNo) {
            attachedRow = cr + 1;
            let parentIdx = cr;
            while (parentIdx > 0 && !(confData[parentIdx][32] && confData[parentIdx][37] && confData[parentIdx][38])) parentIdx--;
            const parentRow = confData[parentIdx];
            attachedJobStart = parentRow[37];
            attachedJobEnd   = parentRow[38];
            attachedJobInvCount = 0;
            for (let jr = parentIdx; jr < confData.length; jr++) {
              const jrow = confData[jr];
              if (jr > parentIdx && String(jrow[0]||"").trim() !== String(parentRow[0]||"").trim()) break;
              if (jr > parentIdx && String(jrow[1]||"").trim() !== String(parentRow[1]||"").trim()) break;
              for (let jc = 0; jc < refCols.length; jc++) {
                if (String(jrow[refCols[jc]] || "").trim()) attachedJobInvCount++;
              }
            }
            break;
          }
        }
        if (attachedRow) break;
      }

      if (!attachedRow) {
        result.confidence = "high";
      } else {
        result.attachedToRow = attachedRow;
        if (attachedJobInvCount === 1 && attachedJobStart && attachedJobEnd) {
          const jStart = attachedJobStart instanceof Date ? attachedJobStart : new Date(attachedJobStart);
          const jEnd   = attachedJobEnd instanceof Date ? attachedJobEnd : new Date(attachedJobEnd);
          const sendMonth = best.sentDate.getMonth(), sendYear = best.sentDate.getFullYear();
          const lastDayOfMonth = new Date(sendYear, sendMonth + 1, 0).getDate();
          if (jStart.getDate() === 1 && jStart.getMonth() === sendMonth && jStart.getFullYear() === sendYear &&
              jEnd.getDate() === lastDayOfMonth && jEnd.getMonth() === sendMonth && jEnd.getFullYear() === sendYear) {
            result.confidence = "high";
          }
        }
      }
    }
    return result;
  } catch (e) {
    return null;
  }
}

async function checkRetainerInvoices_(clientName, clientSheetId, masterSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      const jobType  = String(row[35] || "").toLowerCase();
      if (!jobType.includes("retainer")) continue;

      const revenue  = row[32];
      const startVal = row[37];
      const endVal   = row[38];
      if (!revenue || !startVal || !endVal) continue;

      const clientNameRow = String(row[0] || "").trim();
      const jobName       = String(row[1] || "").trim();
      if (!jobName) continue;

      const endDate = parseConfirmedDate_(endVal);
      if (!endDate) continue;
      const startDate = parseConfirmedDate_(startVal);

      const sentInvoices = [];
      collectSentInvoices_(row, sentInvoices);

      let childRowCount = 0;
      for (let cr = r + 1; cr < data.length; cr++) {
        const childRow = data[cr];
        const childClient  = String(childRow[0] || "").trim();
        const childJob     = String(childRow[1] || "").trim();
        if ((childRow[32] || childRow[37] || childRow[38]) && (childClient !== clientNameRow || childJob !== jobName)) break;
        if (childClient !== clientNameRow || childJob !== jobName) break;
        collectSentInvoices_(childRow, sentInvoices);
        childRowCount++;
      }

      if (sentInvoices.length === 0) {
        let hasUnsentScheduled = false;
        let unsentSendDate = null;
        for (let checkRow2 = r + 1; checkRow2 < data.length; checkRow2++) {
          const cr2 = data[checkRow2];
          if ((cr2[32] || cr2[37] || cr2[38]) && (String(cr2[0]||"").trim() !== clientNameRow || String(cr2[1]||"").trim() !== jobName)) break;
          if (String(cr2[0]||"").trim() !== clientNameRow || String(cr2[1]||"").trim() !== jobName) break;
          const slots2 = [{ sentIdx: 43, refIdx: 42 }, { sentIdx: 50, refIdx: 49 }, { sentIdx: 57, refIdx: 56 }];
          for (let s2 = 0; s2 < slots2.length; s2++) {
            const sentVal2 = cr2[slots2[s2].sentIdx];
            const refVal2  = String(cr2[slots2[s2].refIdx] || "").trim();
            if (!sentVal2) continue;
            const sentDate2 = parseConfirmedDate_(sentVal2);
            if (!sentDate2) continue;
            if (sentDate2 < today && !refVal2) { hasUnsentScheduled = true; unsentSendDate = sentDate2; }
          }
        }
        if (!hasUnsentScheduled) continue;
        const possibleMatch1 = await findPossibleRetainerInvoice_(masterSheetId, clientSheetId, clientNameRow, unsentSendDate, sharedData, sheets);
        let detail1 = `${clientNameRow} - ${jobName}: invoice was scheduled for ${fmtDate(unsentSendDate)} but has no reference number — it may not have been sent yet.`;
        if (possibleMatch1) {
          detail1 += `\nPossible match: invoice ${possibleMatch1.invoiceNo} for £${possibleMatch1.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch1.sentDate} (confidence: ${possibleMatch1.confidence})${possibleMatch1.attachedToRow ? ` — already attached to Confirmed row ${possibleMatch1.attachedToRow}` : " — not yet attached to any job in Confirmed"}. This may mean the retainer value has changed.`;
        }
        alerts.push({
          alertType: "retainer_invoice",
          alertKey: `retainer_invoice|${clientName}|${clientNameRow}|${jobName}`,
          heading: "Retainer invoice not sent",
          detail: detail1, jobName, endClientName: clientNameRow, confirmedRow: r + 1,
          stableJobKey: `${clientNameRow}|${jobName}`, revenue: String(revenue || ""),
          startDate: startDate ? fmtDate(startDate) : "",
          endDate: fmtDate(endDate), lastInvoiceDate: fmtDate(unsentSendDate), expectedByDate: fmtDate(unsentSendDate),
          possibleMatchInvoiceNo: possibleMatch1?.invoiceNo || "", possibleMatchAmount: String(possibleMatch1?.amount || ""),
          possibleMatchSentDate: possibleMatch1?.sentDate || "", possibleMatchVatAmount: String(possibleMatch1?.vatAmount || 0),
          possibleMatchStatus: possibleMatch1?.status || "", possibleMatchConfidence: possibleMatch1?.confidence || "",
          possibleMatchConfirmedRow: possibleMatch1?.attachedToRow ? String(possibleMatch1.attachedToRow) : "",
        });
        continue;
      }

      sentInvoices.sort((a, b) => a.getTime() - b.getTime());
      const lastInvoice = sentInvoices[sentInvoices.length - 1];
      const contractMonths = Math.max(1, Math.round((endDate.getTime() - (startDate ? startDate.getTime() : endDate.getTime())) / (30.4375 * 24 * 60 * 60 * 1000)));
      const monthlyRevenue = parseFloat(String(revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
      const totalContractValue = monthlyRevenue * contractMonths;

      let totalInvoiced = 0;
      const allJobRows = [row];
      for (let ar = r + 1; ar < data.length; ar++) {
        if (String(data[ar][0]||"").trim() !== clientNameRow || String(data[ar][1]||"").trim() !== jobName) break;
        allJobRows.push(data[ar]);
      }
      for (let aj = 0; aj < allJobRows.length; aj++) {
        totalInvoiced += sumRealInvSlotAmounts_(allJobRows[aj]).total;
      }

      if (totalContractValue > 0 && totalInvoiced >= totalContractValue * 0.95) continue;

      let frequencyDays = 30;
      if (sentInvoices.length >= 2) {
        frequencyDays = inferFrequency_(sentInvoices);
      } else if (monthlyRevenue > 0) {
        let firstInvAmt = 0;
        for (let fj = 0; fj < allJobRows.length; fj++) {
          const fjReal = sumRealInvSlotAmounts_(allJobRows[fj]).total;
          if (fjReal > 0) { firstInvAmt = fjReal; break; }
        }
        if (firstInvAmt > 0) {
          const ratio = Math.round(firstInvAmt / monthlyRevenue);
          if (ratio >= 2) {
            const standards = [30, 60, 90, 180, 365];
            const targetDays = ratio * 30;
            let closest2 = standards[0], minDiff2 = Math.abs(targetDays - standards[0]);
            for (let si = 1; si < standards.length; si++) {
              const diff2 = Math.abs(targetDays - standards[si]);
              if (diff2 < minDiff2) { minDiff2 = diff2; closest2 = standards[si]; }
            }
            frequencyDays = closest2;
          }
        }
      }

      const expectedBy = new Date(lastInvoice.getTime() + (frequencyDays + 5) * 24 * 60 * 60 * 1000);
      expectedBy.setHours(0, 0, 0, 0);
      const nextPeriodStart = new Date(lastInvoice.getTime() + frequencyDays * 24 * 60 * 60 * 1000);

      if (today > expectedBy && endDate > nextPeriodStart) {
        const possibleMatch2 = await findPossibleRetainerInvoice_(masterSheetId, clientSheetId, clientNameRow, expectedBy, sharedData, sheets);
        let detail2 = `${clientNameRow} - ${jobName}, last invoice sent ${fmtDate(lastInvoice)}, next one had been expected by ${fmtDate(expectedBy)}. Check whether retainer has ended.`;
        let possibleMatchCase = "";
        if (possibleMatch2) {
          const match2Status = String(possibleMatch2.status || "").toLowerCase();
          const match2IsReal = (match2Status === "sent" || match2Status === "paid");
          if (match2IsReal) {
            const match2Differs = Math.abs(possibleMatch2.amount - monthlyRevenue) > 0.01;
            possibleMatchCase = match2Differs ? "changed" : "matches";
            if (match2Differs) {
              detail2 += `\nPossible match: invoice ${possibleMatch2.invoiceNo} for £${possibleMatch2.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch2.sentDate} (confidence: ${possibleMatch2.confidence})${possibleMatch2.attachedToRow ? ` — already attached to Confirmed row ${possibleMatch2.attachedToRow}` : " — not yet attached to any job in Confirmed"}. This may mean the retainer value has changed.`;
            } else {
              detail2 += `\nInvoice ${possibleMatch2.invoiceNo} for £${possibleMatch2.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch2.sentDate}, matching the expected retainer amount${possibleMatch2.attachedToRow ? ` — already attached to Confirmed row ${possibleMatch2.attachedToRow}.` : ", but not yet attached to this job in Confirmed."}`;
            }
          } else {
            possibleMatchCase = "draft";
            detail2 += `\nNote: invoice ${possibleMatch2.invoiceNo} for £${possibleMatch2.amount.toFixed(2)}${possibleMatch2.attachedToRow ? ` already exists on Confirmed row ${possibleMatch2.attachedToRow}` : " already exists"} but is still marked "${possibleMatch2.status || "unsent"}" — it likely just needs sending.`;
          }
        }
        alerts.push({
          alertType: "retainer_invoice",
          alertKey: `retainer_invoice|${clientName}|${clientNameRow}|${jobName}`,
          heading: "Retainer job expected invoice not sent",
          detail: detail2, jobName, endClientName: clientNameRow, confirmedRow: r + 1,
          stableJobKey: `${clientNameRow}|${jobName}`, revenue: String(revenue || ""),
          startDate: startDate ? fmtDate(startDate) : "",
          endDate: fmtDate(endDate), frequencyDays, lastInvoiceDate: fmtDate(lastInvoice), expectedByDate: fmtDate(expectedBy),
          possibleMatchInvoiceNo: possibleMatch2?.invoiceNo || "", possibleMatchAmount: String(possibleMatch2?.amount || ""),
          possibleMatchSentDate: possibleMatch2?.sentDate || "", possibleMatchVatAmount: String(possibleMatch2?.vatAmount || 0),
          possibleMatchStatus: possibleMatch2?.status || "", possibleMatchConfidence: possibleMatch2?.confidence || "",
          possibleMatchConfirmedRow: possibleMatch2?.attachedToRow ? String(possibleMatch2.attachedToRow) : "",
          possibleMatchCase,
        });
      }
    }
  } catch(e) { }
  return alerts;
}

async function checkCRMWipe_(clientName, masterSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.autoLogData || [];
    const WARNING_TEXT = "WARNING: CRM wiped data blank!";
    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      const timestamp = row[0];
      const details   = String(row[3] || "");
      if (!details.includes(WARNING_TEXT)) continue;

      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");
      const sequenceType = String(row[1] || "");
      const summary      = String(row[2] || "");
      const jobMatch = details.match(/Job[:\s]+([^\n,]+)/i);
      const jobInfo = jobMatch ? jobMatch[1].trim() : "";

      alerts.push({
        alertType: "crm_wipe", alertKey: `crm_wipe|${clientName}|${tsStr}`,
        heading: "CRM data wipe warning",
        detail: `AutoLog entry at ${tsStr} contains: "${WARNING_TEXT}". Review CRM data for ${clientName}.`,
        timestamp: tsStr, sequenceType, summary, jobInfo, detailsSnippet: details.slice(0, 300),
      });
    }
  } catch(e) {}
  return alerts;
}

async function checkRevenueMismatch_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const TOLERANCE = 1.00;

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const revenue  = row[32];
      const jobType  = String(row[35] || "").toLowerCase();
      const startVal = row[37];
      const endVal   = row[38];

      if (!revenue || !startVal || !endVal) { r++; continue; }

      const revenueAmt = parseFloat(String(revenue).replace(/[£$€,\s]/g, "")) || 0;

      if (revenueAmt <= 0) {
        const jobRows0 = collectJobRows_(data, r);
        let totalInvoiced0 = 0;
        for (let jr0 = 0; jr0 < jobRows0.length; jr0++) totalInvoiced0 += sumInvSlotAmounts_(jobRows0[jr0].row);
        if (totalInvoiced0 > 0) {
          const jobClient0  = String(row[0] || "").trim();
          const jobName0    = String(row[1] || "").trim();
          const projectCode0 = String(row[2] || "").trim();
          alerts.push({
            alertType: "revenue_mismatch", alertKey: `revenue_mismatch|${clientName}|${jobClient0}|${jobName0}${projectCode0 ? `|${projectCode0}` : ""}`,
            heading: "Revenue / total invoiced mismatch",
            detail: `${jobClient0} | ${jobName0} (Row ${r + 1})${projectCode0 ? ` [${projectCode0}]` : ""}: revenue = £0.00 but total invoiced (incl. placeholders) = £${totalInvoiced0.toFixed(2)} — job revenue appears to be missing or not yet set.`,
            jobName: jobName0, endClientName: jobClient0, projectCode: projectCode0, confirmedRow: r + 1, isRetainer: false,
          });
        }
        r += jobRows0.length;
        continue;
      }

      const startDate = parseConfirmedDate_(startVal);
      if (startDate && startDate > today) { r++; continue; }

      const jobClient   = String(row[0] || "").trim();
      const jobName     = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      if (!jobName) { r++; continue; }

      const isRetainer = jobType.includes("retainer");
      const jobRows    = collectJobRows_(data, r);

      let mismatch = false, detail = "";

      if (!isRetainer) {
        let totalInvoiced = 0;
        for (let jr = 0; jr < jobRows.length; jr++) totalInvoiced += sumInvSlotAmounts_(jobRows[jr].row);
        if (totalInvoiced === 0) { r += jobRows.length; continue; }

        const diff = Math.abs(totalInvoiced - revenueAmt);
        if (diff > TOLERANCE) {
          mismatch = true;
          detail = `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: revenue = £${revenueAmt.toFixed(2)}, total invoiced (incl. placeholders) = £${totalInvoiced.toFixed(2)} — difference of £${diff.toFixed(2)}`;
        }
      } else {
          const childRows = jobRows.filter(jr => !jr.isParent);
          if (childRows.length === 0) {
            const parentTotal = sumInvSlotAmounts_(row);
            if (parentTotal === 0) { r += jobRows.length; continue; }
            const diffA = Math.abs(parentTotal - revenueAmt);
            if (diffA > TOLERANCE) {
              mismatch = true;
              detail = `${jobClient} | ${jobName} (Row ${r + 1}) [retainer, single-row]: monthly revenue = £${revenueAmt.toFixed(2)}, total invoiced on parent = £${parentTotal.toFixed(2)} — difference of £${diffA.toFixed(2)}`;
            }
          } else {
            for (let ci = 0; ci < childRows.length; ci++) {
              const cr = childRows[ci];
              const childTotal = sumInvSlotAmounts_(cr.row);
              if (childTotal === 0) continue;
              const mult = detectPeriodMultiplier_(cr.row, revenueAmt);
              const expectedForRow = revenueAmt * mult;
              const diffC = Math.abs(childTotal - expectedForRow);
              if (diffC > TOLERANCE) {
                // Build stable unique suffix for child row
                const ref = String(cr.row[42] || "").trim();
                const sentDate = String(cr.row[43] || "").trim();
                const suffix = ref || sentDate || `child-${ci}`;
                
                alerts.push({
                  alertType: "revenue_mismatch", 
                  alertKey: `revenue_mismatch|${clientName}|${jobClient}|${jobName}|${suffix}${projectCode ? `|${projectCode}` : ""}`,
                  heading: "Revenue / total invoiced mismatch", 
                  detail: `${jobClient} | ${jobName} (Row ${cr.sheetRow}) [retainer, multi-row]: £${childTotal.toFixed(2)} invoiced, expected £${expectedForRow.toFixed(2)} (${mult}× monthly revenue of £${revenueAmt.toFixed(2)}) — diff £${diffC.toFixed(2)}`, 
                  jobName, endClientName: jobClient, projectCode, confirmedRow: cr.sheetRow, isRetainer,
                });
              }
            }
          }
        }

        if (mismatch) {
          alerts.push({
            alertType: "revenue_mismatch", alertKey: `revenue_mismatch|${clientName}|${jobClient}|${jobName}${projectCode ? `|${projectCode}` : ""}`,
            heading: "Revenue / total invoiced mismatch", detail, jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, isRetainer,
          });
        }
        r += jobRows.length;
    }
  } catch(e) {}
  return alerts;
}

async function checkDirectCostsMismatch_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  const TAB_CONFIGS = [{ tabName: "Confirmed", startRow: 2 }, { tabName: "Pipeline", startRow: 2 }];
  for (let tc = 0; tc < TAB_CONFIGS.length; tc++) {
    const tabName  = TAB_CONFIGS[tc].tabName;
    const startRow = TAB_CONFIGS[tc].startRow;
    try {
      let data = [];
      if (tabName === "Confirmed" && sharedData?.confirmedData) {
        data = sharedData.confirmedData.slice(startRow - 1);
      } else if (tabName === "Pipeline" && sharedData?.pipelineData) {
        data = sharedData.pipelineData.slice(startRow - 1);
      } else { continue; }

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const TOLERANCE = 1.00;
      let r = 0;
      while (r < data.length) {
        const row = data[r];
        const revenue      = row[32];
        const directCosts  = row[33];
        const jobType      = String(row[35] || "").toLowerCase();
        const startVal     = row[37];
        const endVal       = row[38];

        if (!revenue || !startVal || !endVal) { r++; continue; }

        const directCostsAmt = parseFloat(String(directCosts || "0").replace(/[£$€,\s]/g, "")) || 0;
        if (directCostsAmt <= 0) {
          const skipRows = collectJobRows_(data, r);
          r += skipRows.length;
          continue;
        }

        const startDate = parseConfirmedDate_(startVal);
        if (startDate && startDate > today) { r++; continue; }

        const revenueAmt  = parseFloat(String(revenue).replace(/[£$€,\s]/g, "")) || 0;
        const jobClient   = String(row[0] || "").trim();
        const jobName     = String(row[1] || "").trim();
        const projectCode = String(row[2] || "").trim();
        if (!jobName) { r++; continue; }

        const isRetainer = jobType.includes("retainer");
        const jobRows    = collectJobRows_(data, r);
        const sheetRow   = startRow + r;

        let mismatch = false, detail = "";

        if (!isRetainer) {
          let totalExpenses = 0;
          for (let jr = 0; jr < jobRows.length; jr++) totalExpenses += sumExpSlotAmounts_(jobRows[jr].row);
          if (totalExpenses === 0) { r += jobRows.length; continue; }

          const diff = Math.abs(totalExpenses - directCostsAmt);
          if (diff > TOLERANCE) {
            mismatch = true;
            detail = `${jobClient} | ${jobName} (Row ${sheetRow})${projectCode ? ` [${projectCode}]` : ""} [${tabName} tab]: direct cost budget = £${directCostsAmt.toFixed(2)}, total expenses (incl. placeholders) = £${totalExpenses.toFixed(2)} — difference of £${diff.toFixed(2)}`;
          }
        } else {
          const childRows = jobRows.filter(jr => !jr.isParent);
          if (childRows.length === 0) {
            const parentExp = sumExpSlotAmounts_(row);
            if (parentExp === 0) { r += jobRows.length; continue; }
            const diffA = Math.abs(parentExp - directCostsAmt);
            if (diffA > TOLERANCE) {
              mismatch = true;
              detail = `${jobClient} | ${jobName} (Row ${sheetRow}) [retainer, single-row] [${tabName} tab]: direct cost budget = £${directCostsAmt.toFixed(2)}, total expenses on parent = £${parentExp.toFixed(2)} — difference of £${diffA.toFixed(2)}`;
            }
          } else {
            for (let ci = 0; ci < childRows.length; ci++) {
              const cr = childRows[ci];
              const childExp = sumExpSlotAmounts_(cr.row);
              if (childExp === 0) continue;
              const mult = detectPeriodMultiplier_(cr.row, revenueAmt);
              const expectedForRow = directCostsAmt * mult;
              const diffC = Math.abs(childExp - expectedForRow);
              if (diffC > TOLERANCE) {
                // Build stable unique suffix for child row based on Expense Slot 1
                const txId = String(cr.row[81] || "").trim();
                const expDate = String(cr.row[78] || "").trim();
                const suffix = txId || expDate || `child-${ci}`;
                const childSheetRow = cr.sheetRow + startRow - 1;
                
                alerts.push({
                  alertType: "direct_costs_mismatch", 
                  alertKey: `direct_costs_mismatch|${clientName}|${jobClient}|${jobName}|${tabName}|${suffix}${projectCode ? `|${projectCode}` : ""}`,
                  heading: "Direct costs / total expenses mismatch", 
                  detail: `${jobClient} | ${jobName} (Row ${childSheetRow}) [retainer, multi-row] [${tabName} tab]: £${childExp.toFixed(2)} expenses, expected £${expectedForRow.toFixed(2)} (${mult}× monthly budget of £${directCostsAmt.toFixed(2)}) — diff £${diffC.toFixed(2)}`, 
                  jobName, endClientName: jobClient, projectCode, confirmedRow: childSheetRow, isRetainer, tab: tabName,
                });
              }
            }
          }
        }

        if (mismatch) {
          alerts.push({
            alertType: "direct_costs_mismatch", alertKey: `direct_costs_mismatch|${clientName}|${jobClient}|${jobName}|${tabName}${projectCode ? `|${projectCode}` : ""}`,
            heading: "Direct costs / total expenses mismatch", detail, jobName, endClientName: jobClient, projectCode, confirmedRow: sheetRow, isRetainer, tab: tabName,
          });
        }
        r += jobRows.length;
      }
    } catch(e) {}
  }
  return alerts;
}

async function checkPipelineConfirmedOverlap_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const confData = sharedData?.confirmedData || [];
    const pipeData = sharedData?.pipelineData || [];
    if (confData.length < 2 || pipeData.length < 6) return alerts;

    const pipeByCode = {}, pipeByJob = {};
    for (let p = 1; p < pipeData.length; p++) {
      const pr = pipeData[p];
      const pClient = String(pr[0] || "").trim();
      const pJob    = String(pr[1] || "").trim();
      const pCode   = String(pr[2] || "").trim();
      const pLikelihood = String(pr[39] || "").trim();
      const pCopied = String(pr[107] || "").trim();
      if (!pClient && !pJob && !pCode) continue;

      const pipeInfo = { sheetRow: p + 1, likelihood: pLikelihood, copiedToConf: pCopied, jobName: pJob, clientName: pClient, projectCode: pCode };
      if (pCode) pipeByCode[pCode.toLowerCase()] = pipeInfo;
      if (pClient && pJob) pipeByJob[`${pClient.toLowerCase()}|||${pJob.toLowerCase()}`] = pipeInfo;
    }

    for (let r = 1; r < confData.length; r++) {
      const row = confData[r];
      const confClient  = String(row[0] || "").trim();
      const confJob     = String(row[1] || "").trim();
      const confCode    = String(row[2] || "").trim();
      const confRevenue = row[32];
      const confStart   = row[37];
      const confJobType = String(row[35] || "").trim();

      if (!confRevenue || !confStart || !confJob) continue;

      let pipeMatch = null;
      if (confCode) pipeMatch = pipeByCode[confCode.toLowerCase()] || null;
      if (!pipeMatch && confClient && confJob) pipeMatch = pipeByJob[`${confClient.toLowerCase()}|||${confJob.toLowerCase()}`] || null;

      if (!pipeMatch) continue;

      const likelihoodIs0 = (pipeMatch.likelihood === "0%" || pipeMatch.likelihood === "0");
      const copiedIsYes = (pipeMatch.copiedToConf.toLowerCase() === "yes");
      if (likelihoodIs0 || copiedIsYes) continue;

      const confRevenueAmt = parseFloat(String(confRevenue).replace(/[£$€,\s]/g, "")) || 0;
      const detail = `Job found in both Confirmed and Pipeline tabs but Pipeline row is not closed out.\nConfirmed: row ${r + 1}, client: ${confClient}, job: ${confJob}${confCode ? `, project code: ${confCode}` : ""}${confJobType ? `, type: ${confJobType}` : ""}${confRevenueAmt > 0 ? `, revenue: £${confRevenueAmt.toFixed(2)}` : ""}.\nPipeline: row ${pipeMatch.sheetRow}, likelihood: ${pipeMatch.likelihood || "(blank)"}, "Copied to confirmed?": ${pipeMatch.copiedToConf || "(blank)"}.\nExpected fix: set Pipeline likelihood to 0% OR mark "Copied to confirmed?" as Yes.`;

      alerts.push({
        alertType: "pipeline_confirmed_overlap", alertKey: `pipeline_confirmed_overlap|${clientName}|${confClient}|${confCode || confJob}`,
        heading: "Job in both Pipeline and Confirmed — Pipeline not closed out", detail, jobName: confJob, endClientName: confClient,
        projectCode: confCode, confirmedRow: r + 1, pipelineRow: pipeMatch.sheetRow, likelihood: pipeMatch.likelihood, copiedToConf: pipeMatch.copiedToConf, jobType: confJobType,
      });
    }
  } catch(e) {}
  return alerts;
}

async function checkRetainerShrinkBlocked_(clientName, masterSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.autoLogData || [];
    const WARNING_FRAGMENT = "unable to trim excess child row";
    const seenRowNums = {};

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      const details = String(row[3] || "");
      if (!details.includes(WARNING_FRAGMENT)) continue;

      const rowMatch = details.match(/excess child row\s+(\d+)\s+for/i);
      const childRowNum = rowMatch ? parseInt(rowMatch[1], 10) : null;
      if (!childRowNum || seenRowNums[childRowNum]) continue;
      seenRowNums[childRowNum] = true;

      const jobMatch = details.match(/excess child row\s+\d+\s+for\s+([^.]+?)\s+due to actuals/i);
      const clientJobStr = jobMatch ? jobMatch[1].trim() : "";
      let endClientStr = "", jobName = "";
      if (clientJobStr.includes(" | ")) {
        endClientStr = clientJobStr.slice(0, clientJobStr.indexOf(" | ")).trim();
        jobName = clientJobStr.slice(clientJobStr.indexOf(" | ") + 3).trim();
      } else { jobName = clientJobStr; }

      const timestamp = row[0];
      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");

      alerts.push({
        alertType: "retainer_shrink_blocked", alertKey: `retainer_shrink_blocked|${clientName}|${endClientStr || "unknown"}|${jobName || clientJobStr}|row${childRowNum}`,
        heading: "Retainer child row blocked from trimming — manual review needed",
        detail: `Retainer contract shrunk but the system was unable to automatically trim child row ${childRowNum} because the row contains actuals (expenses or invoices already recorded).\nJob: ${clientJobStr || clientName}.\nChild row ${childRowNum} is now an excess row that falls outside the new contract period but cannot be removed automatically.\nAction required: manually review row ${childRowNum} in the Confirmed tab and decide whether to keep, adjust, or remove it.\nFirst detected: ${tsStr ? tsStr.slice(0, 10) : "(unknown date)"}.`,
        jobName, endClientName: endClientStr, childRowNum, clientJobStr, timestamp: tsStr, confirmedRow: childRowNum,
      });
    }
  } catch(e) {}
  return alerts;
}

async function checkUninvoicedRevenue_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
    const TOLERANCE = 1.00;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const revenue = row[32];
      const jobType = String(row[35] || "").toLowerCase();
      const startVal = row[37];
      const endVal   = row[38];

      if (!revenue || !startVal || !endVal) { r++; continue; }
      if (jobType.includes("retainer")) { r += collectJobRows_(data, r).length; continue; }

      const endDate = parseConfirmedDate_(endVal);
      if (!endDate || (today.getTime() - endDate.getTime()) <= TWO_WEEKS_MS) { r += collectJobRows_(data, r).length; continue; }

      const jobClient   = String(row[0] || "").trim();
      const jobName     = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      if (!jobName) { r++; continue; }

      const revenueAmt = parseFloat(String(revenue).replace(/[£$€,\s]/g, "")) || 0;
      const jobRows = collectJobRows_(data, r);

      let totalRealInvoiced = 0, draftCount = 0, draftTotal = 0;
      for (let jr = 0; jr < jobRows.length; jr++) {
        const slotResult = sumRealInvSlotAmounts_(jobRows[jr].row);
        totalRealInvoiced += slotResult.total;
        draftCount += slotResult.draftCount;
        draftTotal += slotResult.draftTotal;
      }

      const uninvoiced = revenueAmt - totalRealInvoiced;
      if (uninvoiced > TOLERANCE) {
        const stableKey = buildStableJobKey_(jobClient, jobName, projectCode, startVal, endVal);
        const draftNote = draftCount > 0 ? ` Note: ${draftCount} invoice(s) totalling £${draftTotal.toFixed(2)} have a reference but are still Draft (not yet sent) — these are not counted as invoiced.` : "";
        alerts.push({
          alertType: "uninvoiced_revenue", alertKey: `uninvoiced_revenue|${stableKey}`, stableJobKey: stableKey,
          heading: "Completed job has uninvoiced revenue",
          detail: `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: job ended ${fmtDate(endDate)}, revenue = £${revenueAmt.toFixed(2)}, real sent/paid invoiced (excl. placeholders and drafts) = £${totalRealInvoiced.toFixed(2)} — £${uninvoiced.toFixed(2)} uninvoiced.${draftNote}`,
          jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, revenue: String(revenueAmt), endDate: fmtDate(endDate), uninvoicedAmount: String(uninvoiced.toFixed(2)), draftCount: String(draftCount), draftTotal: String(draftTotal.toFixed(2)),
          metadata: { jobClient, jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, revenue: String(revenueAmt), endDate: fmtDate(endDate), uninvoicedAmount: String(uninvoiced.toFixed(2)), draftCount: String(draftCount), draftTotal: String(draftTotal.toFixed(2)), stableJobKey: stableKey },
        });
      }
      r += jobRows.length;
    }
  } catch(e) {}
  return alerts;
}

async function checkDeletedInvoices_(clientName, clientSheetId, masterSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    let rightData = [];
    try {
      const invCompResp = await sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "InvComp!AT6:BS5000" });
      rightData = invCompResp.data.values || [];
    } catch(e) { return alerts; }

    const candidateRefs = [];
    for (let r = 0; r < rightData.length; r++) {
      const ref = String(rightData[r][5] || "").trim();
      const missingFlag = String(rightData[r][21] || "").trim();
      if (!ref || ref.toUpperCase().indexOf("MANUAL-INV") === 0 || missingFlag !== "1") continue;
      candidateRefs.push(ref);
    }
    if (candidateRefs.length === 0) return alerts;

    let confData = sharedData?.confirmedData;
    if (!confData) {
      try {
        const confResp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Confirmed!A1:BH5000" });
        confData = confResp.data.values || [];
      } catch(e) { return alerts; }
    }

    const slotDefs = [{ ref: 42, amt: 41, sent: 43 }, { ref: 49, amt: 48, sent: 50 }, { ref: 56, amt: 55, sent: 57 }];
    const now = new Date();
    const bufferMs = 2 * 24 * 60 * 60 * 1000;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    for (let c = 0; c < candidateRefs.length; c++) {
      const candidateRef = candidateRefs[c];
      let found = null;
      for (let cr = 1; cr < confData.length && !found; cr++) {
        const crow = confData[cr];
        for (let s = 0; s < slotDefs.length; s++) {
          if (String(crow[slotDefs[s].ref] || "").trim() === candidateRef) {
            found = { rowNum: cr + 1, foundClientName: String(crow[0] || "").trim(), jobName: String(crow[1] || "").trim(), projectCode: String(crow[2] || "").trim(), amount: crow[slotDefs[s].amt], sentDate: crow[slotDefs[s].sent], slotNum: s + 1 };
            break;
          }
        }
      }
      if (!found) continue;

        const sentDateObj = parseConfirmedDate_(found.sentDate);
        const sentDateValid = sentDateObj !== null;
        if (sentDateValid && (now.getTime() - sentDateObj.getTime() < bufferMs)) continue;

        const amountNum = parseFloat(String(found.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
        const sentDateStr = sentDateValid ? `${String(sentDateObj.getDate()).padStart(2,'0')}-${months[sentDateObj.getMonth()]}-${String(sentDateObj.getFullYear()).slice(-2)}` : String(found.sentDate || "(unknown)");

      alerts.push({
        alertType: "deleted_invoice", alertKey: `deleted_invoice|${clientName}|${candidateRef}`,
        heading: "Invoice reference no longer found in accounting system",
        detail: `Invoice ${candidateRef} (${found.foundClientName}${found.jobName ? ` - ${found.jobName}` : ""}), sent ${sentDateStr}${amountNum > 0 ? `, £${amountNum.toFixed(2)}` : ""}, has a real reference on the Confirmed tab (row ${found.rowNum}, invoice slot ${found.slotNum}) but no longer appears in the accounting system. It may have been deleted or voided — check Xero directly.`,
        jobName: found.jobName, endClientName: found.foundClientName, projectCode: found.projectCode, confirmedRow: found.rowNum, stableJobKey: candidateRef,
      });
    }
  } catch(e) {}
  return alerts;
}

async function checkJobStructureErrors_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedDataWide || sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;

    const invAmtIdx = [41, 48, 55], expAmtIdx = [76, 83, 90];
    const hasVal = (v) => v !== "" && v !== null && v !== undefined;

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const jobClient   = String(row[0] || "").trim();
      const jobNameV    = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      const revenue = row[32], jobType = String(row[35] || "").toLowerCase(), startVal = row[37], endVal = row[38];

      if (!jobClient || !jobNameV || !revenue || !startVal || !endVal) { r++; continue; }

      const isRetainer = jobType.includes("retainer");
      const jobRows = collectJobRows_(data, r);
      const hasChildren = jobRows.length > 1;
      const problems = [];

      for (let jr = 0; jr < jobRows.length; jr++) {
        const jRow = jobRows[jr].row, jSheetRow = jobRows[jr].sheetRow;
        const rowLabel = `Row ${jSheetRow} (${jobRows[jr].isParent ? "parent" : "child"})`;

        if (isRetainer && (hasVal(jRow[invAmtIdx[1]]) || hasVal(jRow[invAmtIdx[2]]))) {
          problems.push(`${rowLabel}: retainer has data in invoice slot 2 or 3 — retainers should only ever use slot 1 per row`);
        }
        if (isRetainer && hasChildren && jobRows[jr].isParent && hasVal(jRow[invAmtIdx[0]])) {
          problems.push(`${rowLabel}: retainer has child rows but the parent row also holds an invoice — once child rows exist, the parent should stay empty`);
        }
        if (hasVal(jRow[invAmtIdx[1]]) && !hasVal(jRow[invAmtIdx[0]])) problems.push(`${rowLabel}: invoice slot 2 has data but slot 1 is empty`);
        if (hasVal(jRow[invAmtIdx[2]]) && (!hasVal(jRow[invAmtIdx[0]]) || !hasVal(jRow[invAmtIdx[1]]))) problems.push(`${rowLabel}: invoice slot 3 has data but slot 1 or 2 is empty`);
        if (hasVal(jRow[expAmtIdx[1]]) && !hasVal(jRow[expAmtIdx[0]])) problems.push(`${rowLabel}: expense slot 2 has data but slot 1 is empty`);
        if (hasVal(jRow[expAmtIdx[2]]) && (!hasVal(jRow[expAmtIdx[0]]) || !hasVal(jRow[expAmtIdx[1]]))) problems.push(`${rowLabel}: expense slot 3 has data but slot 1 or 2 is empty`);
      }

      if (problems.length > 0) {
        alerts.push({
          alertType: "job_structure_error", alertKey: `job_structure_error|${clientName}|${jobClient}|${jobNameV}${projectCode ? `|${projectCode}` : ""}`,
          heading: "Job structure doesn't match expected invoice/expense layout",
          detail: `${jobClient} | ${jobNameV}${projectCode ? ` [${projectCode}]` : ""} (${isRetainer ? "Retainer" : "Project"}): ${problems.join("; ")}`,
          jobName: jobNameV, endClientName: jobClient, projectCode, confirmedRow: r + 1, isRetainer,
        });
      }
      r += jobRows.length;
    }
  } catch(e) {}
  return alerts;
}

async function checkDeletedExpenses_(clientName, clientSheetId, masterSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    let wideData = [];
    try {
      const dirCompResp = await sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "DirComp!DG6:FQ5000" });
      wideData = dirCompResp.data.values || [];
    } catch(e) { return alerts; }

    const now = new Date();
    const bufferMs = 2 * 24 * 60 * 60 * 1000;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let confData = sharedData?.confirmedDataWide || sharedData?.confirmedData || null;

    const expSlotDefs = [{ ref: 81, amt: 76 }, { ref: 88, amt: 83 }, { ref: 95, amt: 90 }];

    for (let r = 0; r < wideData.length; r++) {
      const row = wideData[r];
      const appId = String(row[9] || "").trim();
      const missingFlag = String(row[55] || "").trim();
      if (!appId || appId.toUpperCase().indexOf("MANUAL-ENTRY") === 0 || appId.toUpperCase().indexOf("UNRECON-GAP") === 0 || missingFlag !== "1") continue;

      const recDateRaw = row[6];
      const recDateObj = recDateRaw instanceof Date ? recDateRaw : new Date(recDateRaw);
      const recDateValid = !isNaN(recDateObj.getTime());
      if (recDateValid && (now.getTime() - recDateObj.getTime() < bufferMs)) continue;

      const jobClientD = String(row[0] || "").trim(), jobNameD = String(row[1] || "").trim(), description = String(row[2] || "").trim();
      const grossAmount = parseFloat(String(row[3] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const recDateStr = recDateValid ? `${String(recDateObj.getDate()).padStart(2,'0')}-${months[recDateObj.getMonth()]}-${String(recDateObj.getFullYear()).slice(-2)}` : String(recDateRaw || "(unknown)");

      let foundRow = null, foundSlot = null;
      if (confData === null) {
        try {
          const confResp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Confirmed!A1:CR5000" });
          confData = confResp.data.values || [];
        } catch(e) { confData = []; }
      }
      for (let cr = 1; cr < confData.length && !foundRow; cr++) {
        const crow = confData[cr];
        for (let s = 0; s < expSlotDefs.length; s++) {
          if (String(crow[expSlotDefs[s].ref] || "").trim() === appId) {
            foundRow = cr + 1; foundSlot = s + 1; break;
          }
        }
      }

      alerts.push({
        alertType: "deleted_expense", alertKey: `deleted_expense|${clientName}|${appId}`,
        heading: "Expense reference no longer found in accounting system",
        detail: `Expense ${appId} (${jobClientD}${jobNameD ? ` - ${jobNameD}` : ""})${description ? `, ${description}` : ""}, received ${recDateStr}${grossAmount > 0 ? `, £${grossAmount.toFixed(2)}` : ""}${foundRow ? ` (Confirmed row ${foundRow}, expense slot ${foundSlot})` : ""} but no longer appears in the accounting system. It may have been deleted or voided — check Xero directly.`,
        jobName: jobNameD, endClientName: jobClientD, confirmedRow: foundRow || "", stableJobKey: appId,
      });
    }
  } catch(e) {}
  return alerts;
}

async function checkUnreceivedExpenses_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedDataWide || sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
    const TOLERANCE = 1.00;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
    const expSlots = [{ amt: 76, ref: 81 }, { amt: 83, ref: 88 }, { amt: 90, ref: 95 }];

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const revenue = row[32], directCosts = row[33], jobType = String(row[35] || "").toLowerCase(), startVal = row[37], endVal = row[38];

      if (!revenue || !startVal || !endVal) { r++; continue; }
      if (jobType.indexOf("retainer") !== -1) { r += collectJobRows_(data, r).length; continue; }

      const directCostsAmt = parseFloat(String(directCosts || "0").replace(/[£$€,\s]/g, "")) || 0;
      if (directCostsAmt <= 0) { r += collectJobRows_(data, r).length; continue; }

      const endDate = parseConfirmedDate_(endVal);
      if (!endDate || (today.getTime() - endDate.getTime()) <= TWO_WEEKS_MS) { r += collectJobRows_(data, r).length; continue; }

      const jobClient = String(row[0] || "").trim(), jobName = String(row[1] || "").trim(), projectCode = String(row[2] || "").trim();
      if (!jobName) { r++; continue; }

      const jobRows = collectJobRows_(data, r);
      let totalRealReceived = 0, placeholderCount = 0, placeholderTotal = 0;

      for (let jr = 0; jr < jobRows.length; jr++) {
        const jRow = jobRows[jr].row;
        for (let s = 0; s < expSlots.length; s++) {
          const amtRaw = jRow[expSlots[s].amt];
          if (amtRaw === "" || amtRaw === null || amtRaw === undefined) continue;
          const amtNum = parseFloat(String(amtRaw).replace(/[£$€,\s]/g, "")) || 0;
          if (amtNum === 0) continue;
          const refVal = String(jRow[expSlots[s].ref] || "").trim().toUpperCase();
          if (refVal.indexOf("MANUAL-ENTRY") === 0 || refVal.indexOf("UNRECON-GAP") === 0) {
            placeholderCount++; placeholderTotal += amtNum;
          } else { totalRealReceived += amtNum; }
        }
      }

      const unreceived = directCostsAmt - totalRealReceived;
      if (unreceived > TOLERANCE) {
        const placeholderNote = placeholderCount > 0 ? ` Note: ${placeholderCount} expense(s) totalling £${placeholderTotal.toFixed(2)} are manual estimates or unreconciled-gap placeholders — these are not counted as received.` : "";
        const stableKey = buildStableJobKey_(jobClient, jobName, projectCode, startVal, endVal);
        alerts.push({
          alertType: "unreceived_expenses", alertKey: `unreceived_expenses|${stableKey}`, stableJobKey: stableKey,
          heading: "Completed job has unreceived expenses",
          detail: `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: job ended ${fmtDate(endDate)}, direct cost budget = £${directCostsAmt.toFixed(2)}, real received expenses (excl. estimates/gaps) = £${totalRealReceived.toFixed(2)} — £${unreceived.toFixed(2)} unreceived.${placeholderNote}`,
          jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, directCosts: String(directCostsAmt), endDate: fmtDate(endDate), unreceivedAmount: String(unreceived.toFixed(2)), placeholderCount: String(placeholderCount), placeholderTotal: String(placeholderTotal.toFixed(2)),
        });
      }
      r += jobRows.length;
    }
  } catch(e) {}
  return alerts;
}

