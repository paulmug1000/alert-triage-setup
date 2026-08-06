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

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const FLAG_COLUMNS = {
  invoiceDashboardDiscr: "CW",
  invoiceAppDiscr: "DD",
  crmPipeDashDiscr: "DK",
  crmPipeAppDiscr: "DR",
  crmConfDashDiscr: "DY",
  crmConfAppDiscr: "EF",
  crmPipeSkippedBlank: "EM",
  crmConfSkippedBlank: "ET",
  crmCopiedConfChecked: "FA",
  crmCopiedConfUnchecked: "FH",
  crmCopiedConfDelete: "FO",
  retainerInvoicesCreated: "FV",
  retainerInvoicesDeleted: "HL",
  expenseDashboardDiscr: "GC",
  expenseAppDiscr: "GJ",
  expenseAdded: "GQ",
  expenseUnreconGaps: "GX",
  invoiceStaleUnsentChanges: "HE",
};

// Precomputed triage data — stored by cron job, consumed by frontend on Start
const PRECOMPUTED_KEY = "triage_precomputed";
const PRECOMPUTED_MAX_AGE_MS = 90 * 60 * 1000; // 90 minutes (GAS precompute runs every 60 min)

const NO_ACTION_FLAGS = [
  "invoiceAppDiscr",
  "crmPipeSkippedBlank",
  "crmConfSkippedBlank",
  "crmCopiedConfChecked",
  "crmCopiedConfUnchecked",
  "crmCopiedConfDelete",
  "retainerInvoicesCreated",
  "retainerInvoicesDeleted",
  "expenseAppDiscr",
  "expenseAdded",
  "expenseUnreconGaps",
  "invoiceStaleUnsentChanges",
];

const FLAG_NAMES = {
  invoiceDashboardDiscr: "Invoice dashboard discr",
  invoiceAppDiscr: "Invoice app discr",
  crmPipeDashDiscr: "CRM pipe dash discr",
  crmPipeAppDiscr: "CRM pipe app discr",
  crmConfDashDiscr: "CRM conf dash discr",
  crmConfAppDiscr: "CRM conf app discr",
  crmPipeSkippedBlank: "CRM pipe skipped with blank",
  crmConfSkippedBlank: "CRM conf skipped with blank",
  crmCopiedConfChecked: "CRM copied to conf box checked",
  crmCopiedConfUnchecked: "CRM copied to conf box UNchecked",
  crmCopiedConfDelete: "CRM copied to conf box DELETE",
  retainerInvoicesCreated: "Retainer invoices created",
  retainerInvoicesDeleted: "Retainer invoices deleted",
  expenseDashboardDiscr: "Expense dashboard discr",
  expenseAppDiscr: "Expense app discr",
  expenseAdded: "Expense added",
  expenseUnreconGaps: "Expense unrecon gaps",
  invoiceStaleUnsentChanges: "Invoice stale unsent changes",
};

// ============================================================================
// ALERT MEMORY — fingerprinting, caching, ignore management
// ============================================================================

const ALERT_MEMORY_TAB = "AlertMemory";
const ALERT_MEMORY_RANGE = `${ALERT_MEMORY_TAB}!A:K`;
const ALERT_MEMORY_MAX_AGE_MONTHS = 12;
const PROACTIVE_ALERTS_TAB = "ProactiveAlerts";

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
    }));
  } catch (err) {
    console.log(`⚠️ Could not read AlertMemory tab: ${err.message}`);
    return [];
  }
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
        range: `${ALERT_MEMORY_TAB}!A1:K1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            "fingerprintHash", "alertType", "clientName", "alertSummary",
            "cachedOptionsJSON", "status", "ignoreReason", "firstSeen", "lastSeen",
            "lastRechecked", "dataSnapshot",
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
 * Find any previous ignore reason for an alert that has since been superseded.
 * Matches superseded rows by client name + alert type + key identifier
 * (invoice number, reference, or job name from the dataSnapshot).
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

          // For CRM alerts — summary/description change
          const snapSummary    = (snap.alertSummary || "").trim();
          const currentSummary = (alert.summary?.summary || "").trim();
          if (snapSummary && currentSummary && snapSummary !== currentSummary && alertType.includes("crm")) {
            changes.push(`discrepancy details changed`);
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
 * Write a new row to AlertMemory (append).
 */
async function appendAlertMemoryRow(sheets, automationCommanderSheetId, {
  fingerprintHash, alertType, clientName, alertSummary,
  cachedOptionsJSON, status, ignoreReason, dataSnapshot,
}) {
  const now = new Date().toISOString().split("T")[0];
  await sheets.spreadsheets.values.append({
    spreadsheetId: automationCommanderSheetId,
    range: `${ALERT_MEMORY_TAB}!A:K`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        fingerprintHash, alertType, clientName, alertSummary,
        cachedOptionsJSON, status, ignoreReason || "", now, now,
        now, // lastRechecked = now on creation
        dataSnapshot || "",
      ]],
    },
  });
}

/**
 * Update an existing AlertMemory row by its 1-indexed sheet row number.
 */
async function updateAlertMemoryRow(sheets, automationCommanderSheetId, rowIndex, updates) {
  const now = new Date().toISOString().split("T")[0];
  const values = [
    updates.fingerprintHash,
    updates.alertType,
    updates.clientName,
    updates.alertSummary,
    updates.cachedOptionsJSON,
    updates.status,
    updates.ignoreReason || "",
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

async function readAIKnowledgeBase(sheets, automationCommanderSheetId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AIKnowledgeBase!A2:E1000",
    });
    return response.data.values || [];
  } catch (err) {
    console.log("⚠️ Could not read AIKnowledgeBase");
    return [];
  }
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
async function logClaudeUsage_(sheets, automationCommanderSheetId, clientName, alertType, inputTokens, outputTokens) {
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
        "precompute",
        clientName || "",
        alertType || "",
        (inputTokens || 0) + (outputTokens || 0),
        costUsd.toFixed(6),
      ]],
    },
  });
  console.log(`  📊 Logged Claude usage: ${clientName} ${alertType} — ${inputTokens}+${outputTokens} tokens, $${costUsd.toFixed(4)}`);
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

async function getClientFlags(sheets, automationCommanderSheetId) {
  try {
    console.log("🔍 Reading AutoUpdates: Clients from A, URLs from L:M, flags from CW:HE...");
    
    // Fetch client names and sheet URLs (A:M)
    const mainResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!A2:M1000",
    });

    const rows = mainResponse.data.values || [];
    console.log(`📊 Total rows: ${rows.length}`);
    
    if (rows.length === 0) {
      console.error("❌ No data in AutoUpdates!");
      throw new Error("AutoUpdates sheet appears empty");
    }

    // OPTIMIZATION: Fetch ALL flag columns at once (CW2:HE1000) instead of per-row
    // This reduces 99 API calls to just 1!
    console.log(`⏱️ Fetching all flags at once (CW:HE)...`);
    const flagsResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!CW2:HL1000",
    });
    const flagRows = flagsResponse.data.values || [];
    console.log(`  ✓ Got ${flagRows.length} flag rows`);

    // Also fetch clear-command columns (BI:BN) to suppress flags that are pending clearance.
    // If a clear command has been sent, the flag is in-progress of being cleared — don't show it.
    // BI(0)=Clear invoice, BJ(1)=Clear CRM, BK(2)=Clear copied-to-conf, BL(3)=Clear expense, BN(5)=Clear all
    const clearResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!BI2:BN1000",
    });
    const clearRows = clearResponse.data.values || [];
    console.log(`  ✓ Got ${clearRows.length} clear-command rows`);

    const clients = [];

    // rows are from A2:M, so:
    // A (0) = Client name
    // L (11) = Client sheet URL  
    // M (12) = Master sheet URL
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sheetRowNum = i + 2; // Row 2 is i=0, so sheet row = i + 2
      
      if (!row || row.length < 13) {
        continue;
      }

      const clientName = String(row[0] || "").trim(); // Column A - ACTUAL CLIENT NAME
      const scriptId    = String(row[10] || "").trim(); // Column K - GAS Script ID
      const clientSheetUrl = row[11]; // Column L
      const masterSheetUrl = row[12]; // Column M

      // OPTIMIZATION: Skip rows with no client name - no need to check flags
      if (!clientName || !clientSheetUrl || !masterSheetUrl) {
        continue;
      }

      console.log(`  Row ${sheetRowNum}: ${clientName}`);

      // Extract sheet IDs
      const clientId = extractSheetIdFromUrl(clientSheetUrl);
      const masterId = extractSheetIdFromUrl(masterSheetUrl);

      if (!clientId || !masterId) {
        continue;
      }

      // Get flags for this row from the pre-fetched data
      // flagRows array index = i (because we fetched starting from row 2)
      const flagRow = flagRows[i] || [];
      
      const flags = {
        invoiceDashboardDiscr: String(flagRow[0] || "").toUpperCase() === "TRUE", // CW
        invoiceAppDiscr: String(flagRow[7] || "").toUpperCase() === "TRUE", // DD
        crmPipeDashDiscr: String(flagRow[14] || "").toUpperCase() === "TRUE", // DK
        crmPipeAppDiscr: String(flagRow[21] || "").toUpperCase() === "TRUE", // DR
        crmConfDashDiscr: String(flagRow[28] || "").toUpperCase() === "TRUE", // DY
        crmConfAppDiscr: String(flagRow[35] || "").toUpperCase() === "TRUE", // EF
        crmPipeSkippedBlank: String(flagRow[42] || "").toUpperCase() === "TRUE", // EM
        crmConfSkippedBlank: String(flagRow[49] || "").toUpperCase() === "TRUE", // ET
        crmCopiedConfChecked: String(flagRow[56] || "").toUpperCase() === "TRUE", // FA
        crmCopiedConfUnchecked: String(flagRow[63] || "").toUpperCase() === "TRUE", // FH
        crmCopiedConfDelete: String(flagRow[70] || "").toUpperCase() === "TRUE", // FO
        retainerInvoicesCreated: String(flagRow[77] || "").toUpperCase() === "TRUE", // FV
        retainerInvoicesDeleted: String(flagRow[119] || "").toUpperCase() === "TRUE", // HL
        expenseDashboardDiscr: String(flagRow[84] || "").toUpperCase() === "TRUE", // GC
        expenseAppDiscr: String(flagRow[91] || "").toUpperCase() === "TRUE", // GJ
        expenseAdded: String(flagRow[98] || "").toUpperCase() === "TRUE", // GQ
        expenseUnreconGaps: String(flagRow[105] || "").toUpperCase() === "TRUE", // GX
        invoiceStaleUnsentChanges: String(flagRow[112] || "").toUpperCase() === "TRUE", // HE
      };

      // Suppress flags that have a pending clear command (BI:BN)
      // Clear command = TRUE means the user already sent a clear — flag is being processed
      const clearRow = clearRows[i] || [];
      const isTrue = (v) => String(v || "").toUpperCase() === "TRUE";
      const clearInvoice  = isTrue(clearRow[0]); // BI
      const clearCRM      = isTrue(clearRow[1]); // BJ
      const clearCopied   = isTrue(clearRow[2]); // BK
      const clearExpense  = isTrue(clearRow[3]); // BL
      const clearAll      = isTrue(clearRow[5]); // BN

      if (clearAll || clearInvoice) {
        flags.invoiceDashboardDiscr = false;
        flags.invoiceAppDiscr = false;
        flags.invoiceStaleUnsentChanges = false;
        flags.retainerInvoicesCreated = false;
        flags.retainerInvoicesDeleted = false;
      }
      if (clearAll || clearCRM) {
        flags.crmPipeDashDiscr = false;
        flags.crmPipeAppDiscr = false;
        flags.crmConfDashDiscr = false;
        flags.crmConfAppDiscr = false;
        flags.crmPipeSkippedBlank = false;
        flags.crmConfSkippedBlank = false;
      }
      if (clearAll || clearCopied) {
        flags.crmCopiedConfChecked = false;
        flags.crmCopiedConfUnchecked = false;
        flags.crmCopiedConfDelete = false;
      }
      if (clearAll || clearExpense) {
        flags.expenseDashboardDiscr = false;
        flags.expenseAppDiscr = false;
        flags.expenseAdded = false;
        flags.expenseUnreconGaps = false;
      }

      if (clearInvoice || clearCRM || clearCopied || clearExpense || clearAll) {
        console.log(`    ⏭ Clear pending for ${clientName}: inv=${clearInvoice} crm=${clearCRM} copied=${clearCopied} exp=${clearExpense} all=${clearAll} — suppressing affected flags`);
      }

      const hasFlags = Object.values(flags).some(v => v);

      if (hasFlags) {
        const flagsFound = Object.entries(flags)
          .filter(([_, value]) => value)
          .map(([key, _]) => key);
        
        console.log(`    ✅ ${flagsFound.join(", ")}`);
        clients.push({
          clientName,
          clientSheetId: clientId,
          masterSheetId: masterId,
          clientSheetUrl,
          masterSheetUrl,
          scriptId,
          flags,
        });
      }
    }

    console.log(`✅ Found ${clients.length} clients with flags`);
    return clients;
  } catch (error) {
    console.error("❌ Error getting client flags:", error);
    throw error;
  }
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
// Reads DataChgAlert tab of the master sheet:
//   Invoices: B4 (flag), C4 (timestamp)
//   Expenses: F4 (flag), G4 (timestamp)
//   CRM:      H4 (flag), I4 (timestamp)
// Returns { locked: false } if safe to proceed, or { locked: true, message: "..." } if GAS is running.
// Flags older than 30 minutes are treated as stale and ignored.
const GAS_LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

async function checkGASLock(sheets, masterSheetId, sequenceType) {
  const cellMap = {
    invoice: { flag: "B4", timestamp: "C4" },
    expense: { flag: "F4", timestamp: "G4" },
    crm:     { flag: "H4", timestamp: "I4" },
  };
  const cells = cellMap[sequenceType];
  if (!cells || !masterSheetId) return { locked: false };

  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: `DataChgAlert!${cells.flag}:${cells.timestamp}`,
    });
    const row = (resp.data.values || [[]])[0] || [];
    const flagValue = String(row[0] || "").trim().toUpperCase();
    const tsRaw = row[1];

    if (flagValue !== "YES") return { locked: false };

    // Check for stale flag
    if (tsRaw) {
      const tsDate = new Date(tsRaw);
      if (!isNaN(tsDate) && (Date.now() - tsDate.getTime()) > GAS_LOCK_STALE_MS) {
        console.log(`  ⚠️ GAS lock for ${sequenceType} is stale (set at ${tsDate.toISOString()}) — clearing and proceeding`);
        try {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: masterSheetId,
            requestBody: {
              data: [
                { range: `DataChgAlert!${cells.flag}`, values: [["NO"]] },
                { range: `DataChgAlert!${cells.timestamp}`, values: [[""]] },
              ],
              valueInputOption: "RAW",
            },
          });
        } catch (clearErr) {
          console.log(`  ⚠️ Could not clear stale GAS lock: ${clearErr.message}`);
        }
        return { locked: false };
      }
    }

    const since = tsRaw ? ` (started ${new Date(tsRaw).toLocaleTimeString("en-GB")})` : "";
    return {
      locked: true,
      message: `The ${sequenceType} automation sequence is currently running for this client${since}. Please try again in a few minutes.`,
    };
  } catch (e) {
    console.log(`  ⚠️ Could not read GAS lock for ${sequenceType}: ${e.message} — proceeding anyway`);
    return { locked: false };
  }
}

// ============================================================================
// PROACTIVE ALERTS — storage helpers
// ============================================================================

async function ensureProactiveAlertsTab(sheets, automationCommanderSheetId) {
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PROACTIVE_ALERTS_TAB}!A1`,
    });
  } catch (err) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: automationCommanderSheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: PROACTIVE_ALERTS_TAB } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: automationCommanderSheetId,
        range: `${PROACTIVE_ALERTS_TAB}!A1:J1`,
        valueInputOption: "RAW",
        requestBody: { values: [[
          "alertKey", "alertType", "clientName", "heading", "detail",
          "status", "firstSeen", "lastSeen", "acknowledgedAt", "metadata",
        ]] },
      });
      console.log(`✅ Created ${PROACTIVE_ALERTS_TAB} tab`);
    } catch (createErr) {
      console.log(`⚠️ Could not create ${PROACTIVE_ALERTS_TAB} tab: ${createErr.message}`);
    }
  }
}

async function readProactiveAlerts(sheets, automationCommanderSheetId) {
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PROACTIVE_ALERTS_TAB}!A:J`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return [];
    return rows.slice(1).map((row, i) => ({
      rowIndex:       i + 2,
      alertKey:       row[0] || "",
      alertType:      row[1] || "",
      clientName:     row[2] || "",
      heading:        row[3] || "",
      detail:         row[4] || "",
      status:         row[5] || "active",
      firstSeen:      row[6] || "",
      lastSeen:       row[7] || "",
      acknowledgedAt: row[8] || "",
      metadata:       row[9] ? (() => { try { return JSON.parse(row[9]); } catch(e) { return {}; } })() : {},
    }));
  } catch (err) {
    console.log(`⚠️ Could not read ${PROACTIVE_ALERTS_TAB}: ${err.message}`);
    return [];
  }
}

async function readInvCompAlerts(sheets, spreadsheetId) {
  try {
    console.log(`\n📖 Reading InvComp alerts from ${spreadsheetId}...`);
    
    await setMasterSwitch(sheets, spreadsheetId, "InvComp", true);

    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "InvComp!A5:Y5",
    });
    const headers = (headerResponse.data.values || [[]])[0] || [];

    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "InvComp!A6:Y1000",
    });
    const rows = dataResponse.data.values || [];
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
    await setMasterSwitch(sheets, spreadsheetId, "InvComp", false);
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading InvComp alerts:`, error);
    try { await setMasterSwitch(sheets, spreadsheetId, "InvComp", false); } catch (e) {}
    return [];
  }
}

async function readDirCompAlerts(sheets, spreadsheetId) {
  try {
    console.log(`\n📖 Reading DirComp alerts from ${spreadsheetId}...`);
    
    await setMasterSwitch(sheets, spreadsheetId, "DirComp", true);

    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "DirComp!A5:AV5",
    });
    const headers = (headerResponse.data.values || [[]])[0] || [];

    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "DirComp!A6:AV1000",
    });
    const rows = dataResponse.data.values || [];
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
    await setMasterSwitch(sheets, spreadsheetId, "DirComp", false);
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading DirComp alerts:`, error);
    try { await setMasterSwitch(sheets, spreadsheetId, "DirComp", false); } catch (e) {}
    return [];
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
      const [dashPipeResp, dashConfResp, crmPipeResp, crmConfResp] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId: dcaSheetId, range: "DataChgAlert!C59:C66" }),
        sheets.spreadsheets.values.get({ spreadsheetId: dcaSheetId, range: "DataChgAlert!F59:F66" }),
        sheets.spreadsheets.values.get({ spreadsheetId: dcaSheetId, range: "DataChgAlert!C72:C79" }),
        sheets.spreadsheets.values.get({ spreadsheetId: dcaSheetId, range: "DataChgAlert!F72:F79" }),
      ]);
      const SETTING_ROWS = ["missing_job","client_mismatch","job_name_mismatch","revenue_mismatch",
                            "direct_costs_mismatch","start_date_mismatch","end_date_mismatch","likelihood_mismatch"];
      const parseSettings = (resp) => {
        const vals = resp.data.values || [];
        const s = {};
        SETTING_ROWS.forEach((k, i) => {
          const v = String((vals[i] || [])[0] || "").trim().toLowerCase();
          s[k] = v !== "ignore";
        });
        return s;
      };
      triageSettings = {
        dashPipe: parseSettings(dashPipeResp),
        dashConf: parseSettings(dashConfResp),
        crmPipe:  parseSettings(crmPipeResp),
        crmConf:  parseSettings(crmConfResp),
      };
      console.log(`  ✓ DataChgAlert settings loaded`);
    } catch(e) {
      console.log(`  ⚠ Could not read DataChgAlert settings: ${e.message} — including all discrepancy types`);
    }

    // Set CRM mode
    console.log(`  Setting B2 = "${mode}" in CRMComp...`);
    await setCRMMode(sheets, spreadsheetId, mode);
    console.log(`  ✓ Mode set`);

    // Activate master switch
    console.log(`  Setting E2 = TRUE in CRMComp...`);
    await setMasterSwitch(sheets, spreadsheetId, "CRMComp", true);
    console.log(`  ✓ Master switch set`);

    const alerts = [];

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

      const dataResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: dataRange,
        valueRenderOption: "FORMATTED_VALUE",
      });
      const rows = dataResponse.data.values || [];

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
    await setMasterSwitch(sheets, spreadsheetId, "CRMComp", false);
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading CRMComp alerts:`, error);
    try { await setMasterSwitch(sheets, spreadsheetId, "CRMComp", false); } catch (e) {}
    return [];
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

    if (action === "get_all_clients") {
      // Returns all clients from AutoUpdates as an array.
      // Used by the frontend for the Outgoings client selector and when clientsWithFlags is empty.
      const { automationCommanderSheetId } = req.body;
      if (!automationCommanderSheetId) {
        return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      }
      try {
        const sheets = await getSheetsClient();
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: automationCommanderSheetId,
          range: "AutoUpdates!A2:M500",
        });
        const rows = resp.data.values || [];
        // Build both array (for outgoings selector) and object (for proactive alerts compat)
        const clientsArray = [];
        const clientsObj = {};
        for (const row of rows) {
          const clientName = String(row[0] || "").trim();
          const scriptId   = String(row[10] || "").trim(); // col K = GAS script ID
          const clientSheetUrl = row[11];
          const masterSheetUrl = row[12];
          // Skip header row and any row where name looks like a header
          if (!clientName || !clientSheetUrl) continue;
          if (clientName.toLowerCase() === "client" || clientName.toLowerCase() === "client name") continue;
          const clientSheetId = extractSheetIdFromUrl(clientSheetUrl) || String(clientSheetUrl).trim();
          const masterSheetId = extractSheetIdFromUrl(masterSheetUrl) || String(masterSheetUrl || "").trim();
          clientsArray.push({ clientName, clientSheetId, masterSheetId, scriptId });
          if (clientSheetId && masterSheetId) clientsObj[clientName] = { clientSheetId, masterSheetId, scriptId };
        }
        clientsArray.sort((a, b) => a.clientName.localeCompare(b.clientName));
        return res.status(200).json({ success: true, clients: clientsArray, clientsMap: clientsObj });
      } catch (err) {
        console.error("❌ get_all_clients error:", err);
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
        const expLock = await checkGASLock(sheets, sheetIdClean, "expense");
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

          console.log(`  🔎 Flag=1 row: appId="${appId}" desc="${description.slice(0,30)}" amt=${amount} date=${date}`);

          if (!appId) { skippedNoAppId++; console.log(`    ⚠ Skipped — no appId`); continue; }
          inbox.push({ appId, amount, date, description, reference, accountName, status, datePaid });
        }

        console.log(`  ✅ get_outgoings_inbox: ${inbox.length} unmatched expenses (skipped: ${skippedNoFlag} no-flag, ${skippedNoAppId} no-appId)`);
        return res.status(200).json({ success: true, inbox });
      } catch (err) {
        try { await setMasterSwitch(sheets, extractSheetIdFromUrl(sheetId) || sheetId, "DirComp", false); } catch(e) {}
        console.error("❌ get_outgoings_inbox error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "create_outgoings_vendor") {
      // Inserts a new vendor row at the end of the Contractors section (row 110) in the Outgoings tab.
      // Cols: A=vendorName, B=vatFlag, C=invTiming, D=payTiming
      const { clientSheetId, vendorName, vatFlag, invTiming, payTiming } = req.body;
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

        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `Outgoings!A${newRow}:D${newRow}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[vendorName, vatFlag || "Yes", invTiming || "Curr", payTiming || "Curr"]] },
        });

        console.log(`  ✅ Created new Outgoings vendor "${vendorName}" at row ${newRow}`);
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
              amount:      parseFloat(match[2]) || 0,
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

    } else if (action === "get_overview") {
      // Read AutoUpdates tab fresh for the Overview screen.
      // Returns per-client run times, feedback summaries, and flag text.
      const { automationCommanderSheetId } = req.body;
      if (!automationCommanderSheetId) {
        return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      }
      try {
        const sheets = await getSheetsClient();
        // Read cols A through BG (cols 1-59) starting at row 2 (header) through row 100
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: automationCommanderSheetId,
          range: "AutoUpdates!A2:BG100",
          valueRenderOption: "UNFORMATTED_VALUE",
        });
        const rows = resp.data.values || [];
        if (rows.length < 2) return res.status(200).json({ success: true, clients: [] });

        // Row 2 (index 0) = headers, rows 3+ (index 1+) = clients
        const serialToDate = (val) => {
          if (!val) return null;
          if (typeof val === "number") {
            const d = new Date((val - 25569) * 86400 * 1000);
            return isNaN(d.getTime()) ? null : d;
          }
          if (typeof val === "string" && val.trim()) {
            const d = new Date(val);
            return isNaN(d.getTime()) ? null : d;
          }
          return null;
        };

        const formatRunTime = (val) => {
          const d = serialToDate(val);
          if (!d) return null;
          const now = new Date();
          const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const yesterday = new Date(today.getTime() - 86400000);
          const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
          const hh = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          const time = `${hh}:${mm}`;
          if (dayStart.getTime() === today.getTime()) return `Today ${time}`;
          if (dayStart.getTime() === yesterday.getTime()) return `Yesterday ${time}`;
          const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)} ${time}`;
        };

        const parseFeedback = (raw) => {
          if (!raw) return null;
          const s = String(raw).trim();
          // Format: "L: 0 D: 6 W: 103 | OK" or "L: 1 D: 2 W: 11 | OK"
          const m = s.match(/L\s*:\s*(\d+)\s+D\s*:\s*(\d+)\s+W\s*:\s*(\d+)\s*\|\s*(\w+)/i);
          if (m) return { last: parseInt(m[1]), day: parseInt(m[2]), week: parseInt(m[3]), outcome: m[4] };
          return { raw: s };
        };

        const clients = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i] || [];
          const clientName = String(r[0] || "").trim();
          if (!clientName) continue;

          // Column indices (0-based): A=0, W=22, Y=24, Z=25, AB=27, AD=29, AE=30, AG=32, AI=34, AJ=35, BG=58
          clients.push({
            clientName,
            inv: {
              lastRunTime: formatRunTime(r[24]),  // Y = Inv last run end time
              feedback:    parseFeedback(r[25]),   // Z = Inv feedback summary
            },
            crm: {
              lastRunTime: formatRunTime(r[29]),  // AD = CRM last run end time
              feedback:    parseFeedback(r[30]),   // AE = CRM feedback summary
            },
            exp: {
              lastRunTime: formatRunTime(r[34]),  // AI = Exp last run end time
              feedback:    parseFeedback(r[35]),   // AJ = Exp feedback summary
            },
            flagsText: String(r[58] || "").trim(), // BG = flags text
          });
        }

        console.log(`  ✅ Overview: ${clients.length} clients loaded`);
        return res.status(200).json({ success: true, clients });
      } catch (err) {
        console.error("❌ get_overview error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "start_triage") {
      // Get all clients with flags
      let clientsWithFlags;
      try {
        clientsWithFlags = await getClientFlags(
          sheets,
          automationCommanderSheetId
        );
      } catch (err) {
        console.error("Fatal error reading client flags:", err);
        return res.status(500).json({
          success: false,
          error: `Failed to read automation commander: ${err.message}. Check credentials and sheet access.`,
        });
      }

      if (clientsWithFlags.length === 0) {
        return res.status(200).json({
          success: true,
          sessionId: "no-alerts",
          totalAlerts: 0,
          noActionAlerts: [],
          actionableAlerts: [],
        });
      }

      const allAlerts = [];
      const noActionAlerts = [];

      // Process each client
      for (const client of clientsWithFlags) {
        console.log(`\n🔹 Processing client: ${client.masterSheetId}`);
        
        // Check which actionable flags exist
        const actionableFlags = Object.entries(client.flags)
          .filter(([key, value]) => value && !NO_ACTION_FLAGS.includes(key))
          .map(([key]) => key);

        const noActionFlags = Object.entries(client.flags)
          .filter(([key, value]) => value && NO_ACTION_FLAGS.includes(key))
          .map(([key]) => key);

        console.log(`  Actionable flags: ${actionableFlags.join(", ") || "none"}`);
        console.log(`  No-action flags: ${noActionFlags.join(", ") || "none"}`);

        // Read actionable alerts
        if (actionableFlags.includes("invoiceDashboardDiscr")) {
          const invLock = await checkGASLock(sheets, client.masterSheetId, "invoice");
          if (invLock.locked) {
            console.log(`  🔒 Invoice GAS lock active for ${client.clientName} — skipping InvComp`);
            // Add a synthetic locked alert so the user is informed
            allAlerts.push({
              type: "locked", sheetName: "InvComp", clientName: client.clientName,
              clientId: client.clientSheetId, masterSheetId: client.masterSheetId,
              flagType: "invoiceDashboardDiscr",
              summary: { lockedMessage: invLock.message },
            });
          } else {
            console.log(`  Reading InvComp...`);
            // IMPORTANT: readInvCompAlerts uses masterSheetId (Master Sheet with InvComp tab)
            const invoiceAlerts = await readInvCompAlerts(
              sheets,
              client.masterSheetId  // Master Sheet - Column M
            );
            console.log(`  ✓ InvComp done, found ${invoiceAlerts.length} alerts`);
            // CRITICAL: Set clientId to client.clientSheetId for later analysis
            // This is the Client Sheet (Confirmed tab) where we'll look for job matches
            invoiceAlerts.forEach((alert) => {
              alert.clientId = client.clientSheetId;  // Client Sheet - Column L
              alert.masterSheetId = client.masterSheetId; // Master Sheet - Column M
              alert.clientName = client.clientName;   // Client name for display
              alert.flagType = "invoiceDashboardDiscr";
            });
            allAlerts.push(...invoiceAlerts);
          }
        }

        if (actionableFlags.includes("expenseDashboardDiscr")) {
          const expLock = await checkGASLock(sheets, client.masterSheetId, "expense");
          if (expLock.locked) {
            console.log(`  🔒 Expense GAS lock active for ${client.clientName} — skipping DirComp`);
            allAlerts.push({
              type: "locked", sheetName: "DirComp", clientName: client.clientName,
              clientId: client.clientSheetId, masterSheetId: client.masterSheetId,
              flagType: "expenseDashboardDiscr",
              summary: { lockedMessage: expLock.message },
            });
          } else {
            console.log(`  Reading DirComp...`);
            const expenseAlerts = await readDirCompAlerts(
              sheets,
              client.masterSheetId
            );
            console.log(`  ✓ DirComp done, found ${expenseAlerts.length} alerts`);
            expenseAlerts.forEach((alert) => {
              alert.clientId = client.clientSheetId;
              alert.masterSheetId = client.masterSheetId;
              alert.clientName = client.clientName;
              alert.flagType = "expenseDashboardDiscr";
            });
            allAlerts.push(...expenseAlerts);
          }
        }

        // Handle CRM alerts based on which modes are needed
        const pipelineAlerts = actionableFlags.filter((f) =>
          ["crmPipeDashDiscr", "crmPipeAppDiscr"].includes(f)
        );
        const confirmedAlerts = actionableFlags.filter((f) =>
          ["crmConfDashDiscr", "crmConfAppDiscr"].includes(f)
        );

        // Single CRM lock check covers both Pipeline and Confirmed reads
        const crmLock = (pipelineAlerts.length > 0 || confirmedAlerts.length > 0)
          ? await checkGASLock(sheets, client.masterSheetId, "crm")
          : { locked: false };

        if (crmLock.locked) {
          console.log(`  🔒 CRM GAS lock active for ${client.clientName} — skipping CRMComp`);
          allAlerts.push({
            type: "locked", sheetName: "CRMComp", clientName: client.clientName,
            clientId: client.clientSheetId, masterSheetId: client.masterSheetId,
            flagType: "crmPipeDashDiscr",
            summary: { lockedMessage: crmLock.message },
          });
        } else {
          if (pipelineAlerts.length > 0) {
            const crmAlerts = await readCRMCompAlerts(
              sheets,
              client.masterSheetId,
              "Pipeline",
              pipelineAlerts,
              client.masterSheetId
            );
            crmAlerts.forEach((alert) => {
              alert.clientId = client.clientSheetId;
              alert.masterSheetId = client.masterSheetId;
              alert.clientName = client.clientName;
              if (!alert.flagType) alert.flagType = alert.alertType || pipelineAlerts[0];
            });
            allAlerts.push(...crmAlerts);
          }

          if (confirmedAlerts.length > 0) {
            const crmAlerts = await readCRMCompAlerts(
              sheets,
              client.masterSheetId,
              "Confirmed",
              confirmedAlerts,
              client.masterSheetId
            );
            crmAlerts.forEach((alert) => {
              alert.clientId = client.clientSheetId;
              alert.masterSheetId = client.masterSheetId;
              alert.clientName = client.clientName;
              if (!alert.flagType) alert.flagType = alert.alertType || confirmedAlerts[0];
            });
            allAlerts.push(...crmAlerts);
          }
        }

        // Collect "no action" alerts for acknowledgement
        for (const flagKey of noActionFlags) {
          noActionAlerts.push({
            clientId: client.masterSheetId,
            flagType: flagKey,
            flagName: FLAG_NAMES[flagKey],
            flagColumn: FLAG_COLUMNS[flagKey],
          });
        }
        
        console.log(`  ✓ Client processing complete\n`);
      }

      console.log(`📊 All clients processed. Total alerts: ${allAlerts.length}, No-action alerts: ${noActionAlerts.length}`);

      // Read AlertMemory once — purge stale rows, then filter out ignored alerts
      console.log(`📚 Reading AlertMemory...`);
      await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
      const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
      console.log(`  ✓ Found ${memoryRows.length} AlertMemory records`);

      // Purge rows older than 12 months
      await purgeOldAlertMemoryRows(sheets, automationCommanderSheetId, memoryRows);

      // Build set of ignored fingerprints for fast lookup.
      const ignoredHashes = new Set(
        memoryRows
          .filter(r => r.status === "ignored" || r.status === "task" ||
                       r.status === "superseded" || r.status === "accepted")
          .map(r => r.fingerprintHash)
          .filter(Boolean)
      );

      // Attach fingerprint to every alert and filter out ignored ones
      const filteredAlerts = [];
      let ignoredCount = 0;
      for (const alert of allAlerts) {
        alert.fingerprintHash = buildAlertFingerprint(alert);
        if (ignoredHashes.has(alert.fingerprintHash)) {
          ignoredCount++;
        } else {
          filteredAlerts.push(alert);
        }
      }
      console.log(`  ✓ ${filteredAlerts.length} active alerts, ${ignoredCount} ignored alerts filtered out`);

      // Store session data in Redis
      const sessionId = Math.random().toString(36).substring(2, 15);
      console.log(`  Storing ${filteredAlerts.length} alerts in Redis (session: ${sessionId})...`);
      await redisClient.set(
        `triage_alerts:${sessionId}`,
        JSON.stringify({
          alerts: filteredAlerts,
          noActionAlerts,
          clientsWithFlags,
        }),
        { EX: 86400 }
      );
      console.log(`  ✓ Redis store complete`);

      console.log(`\n✅ Sending response to frontend...`);

      // Build per-flag alert counts per client for the UI
      const alertCountsByClientAndFlag = {};
      for (const alert of filteredAlerts) {
        const key = alert.clientName;
        const flagKey = alert.flagType || alert.alertType || alert.type;
        if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
        alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;
      }

      const clientsWithFlagsSlim = clientsWithFlags.map(client => ({
        clientName: client.clientName,
        clientSheetId: client.clientSheetId,
        masterSheetId: client.masterSheetId,
        scriptId: client.scriptId,
        flags: client.flags,
        alertCounts: alertCountsByClientAndFlag[client.clientName] || {},
      }));

      // Also update the precomputed cache so a full page reload shows fresh data.
      // Preserve any existing noActionAnalysisResults from the previous precompute run.
      try {
        const existingRaw = await redisClient.get(PRECOMPUTED_KEY);
        const existingNoActionAnalysis = existingRaw
          ? (JSON.parse(existingRaw).noActionAnalysisResults || {})
          : {};
        await redisClient.set(
          PRECOMPUTED_KEY,
          JSON.stringify({
            computedAt: Date.now(),
            totalAlerts: filteredAlerts.length,
            noActionCount: noActionAlerts.length,
            alerts: filteredAlerts,
            noActionAlerts,
            clientsWithFlags: clientsWithFlagsSlim,
            noActionAnalysisResults: existingNoActionAnalysis,
          }),
          { EX: 3600 }
        );
        console.log(`  ✓ Precomputed cache updated (${filteredAlerts.length} alerts)`);
      } catch (cacheErr) {
        console.error(`  ⚠ Failed to update precomputed cache: ${cacheErr.message}`);
        // Non-fatal — session still works
      }

      res.status(200).json({
        success: true,
        sessionId,
        totalAlerts: filteredAlerts.length,
        noActionCount: noActionAlerts.length,
        clientsWithFlags: clientsWithFlagsSlim,
      });
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

        const { alerts, noActionAlerts, clientsWithFlags, resolvedNoActionFlags } = JSON.parse(sessionData);
        console.log(`✅ Retrieved ${alerts.length} alerts from Redis for session ${sessionId}`);
        
        res.status(200).json({
          success: true,
          alerts,
          noActionAlerts,
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

        // 3. Read AutoUpdates flag columns for this client
        const acIdClean = extractSheetIdFromUrl(acId) || acId;
        const namesResp = await sheets.spreadsheets.values.get({
          spreadsheetId: acIdClean,
          range: "AutoUpdates!A2:A1000",
        });
        const nameRows = namesResp.data.values || [];
        let autoUpdatesRow = -1;
        for (let i = 0; i < nameRows.length; i++) {
          if (!clientName || String(nameRows[i]?.[0] || "").trim() === clientName.trim()) {
            autoUpdatesRow = i + 2;
            break;
          }
        }

        let autoUpdatesFlags = null;
        if (autoUpdatesRow !== -1) {
          // Read CW:HL (cols 101-220 = 120 cols) — the flag columns
          const flagResp = await sheets.spreadsheets.values.get({
            spreadsheetId: acIdClean,
            range: `AutoUpdates!CW${autoUpdatesRow}:HL${autoUpdatesRow}`,
          });
          const flagRow = flagResp.data.values?.[0] || [];
          const FLAG_COL_NAMES = {
            0:  "invoiceDashboardDiscr (CW)",
            7:  "invoiceAppDiscr (DD)",
            14: "crmPipeDashDiscr (DK)",
            21: "crmPipeAppDiscr (DR)",
            28: "crmConfDashDiscr (DY)",
            35: "crmConfAppDiscr (EF)",
            42: "crmPipeSkippedBlank (EM)",
            49: "crmConfSkippedBlank (ET)",
            56: "crmCopiedConfChecked (FA)",
            63: "crmCopiedConfUnchecked (FH)",
            70: "crmCopiedConfDelete (FO)",
            77: "retainerInvoicesCreated (FV)",
            84: "expenseDashboardDiscr (GC)",
            91: "expenseAppDiscr (GJ)",
            98: "expenseAdded (GQ)",
            105:"expenseUnreconGaps (GX)",
            112:"invoiceStaleUnsentChanges (HE)",
            119:"retainerInvoicesDeleted (HL)",
          };
          autoUpdatesFlags = {};
          Object.entries(FLAG_COL_NAMES).forEach(([idx, name]) => {
            const val = String(flagRow[parseInt(idx)] || "").trim().toUpperCase();
            autoUpdatesFlags[name] = val === "TRUE" || val === "1";
          });
        }

        // 4. Read DataChgAlert clear cells for this client (if masterSheetId provided)
        // (skip — requires masterSheetId which we don't have here)

        console.log(`debug_triage_state: ${clientMemory.length} AlertMemory rows, precomp=${!!preRaw}, autoUpdatesRow=${autoUpdatesRow}`);
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
          autoUpdates: { row: autoUpdatesRow, flags: autoUpdatesFlags },
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

        if (filteredAlerts.length < data.alerts.length) {
          console.log(`  Filtered ${data.alerts.length - filteredAlerts.length} ignored alert(s) from precomputed data`);
        }

        // Rebuild alertCounts after filtering
        const alertCountsByClientAndFlag = {};
        for (const alert of filteredAlerts) {
          const key = alert.clientName;
          const flagKey = alert.flagType || alert.alertType || alert.type;
          if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
          alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;
        }

        const clientsWithUpdatedCounts = data.clientsWithFlags.map(c => ({
          ...c,
          alertCounts: alertCountsByClientAndFlag[c.clientName] || {},
        }));

        // Promote into a regular session so the existing get_alerts flow works unchanged
        const sessionId = Math.random().toString(36).substring(2, 15);
        await redisClient.set(
          `triage_alerts:${sessionId}`,
          JSON.stringify({
            alerts: filteredAlerts,
            noActionAlerts: data.noActionAlerts,
            clientsWithFlags: clientsWithUpdatedCounts,
          }),
          { EX: 86400 }
        );

        return res.status(200).json({
          success: true,
          available: true,
          sessionId,
          totalAlerts: filteredAlerts.length,
          noActionCount: data.noActionCount,
          clientsWithFlags: clientsWithUpdatedCounts.map(c => ({
            clientName: c.clientName,
            clientSheetId: c.clientSheetId,
            masterSheetId: c.masterSheetId,
            flags: c.flags,
            alertCounts: c.alertCounts || {},
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
      const { secret, alerts, noActionAlerts, clientsWithFlags,
              totalAlerts, noActionCount, computedAt,
              noActionAnalysisResults, automationCommanderSheetId } = req.body;

      if (secret !== process.env.CRON_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorised" });
      }

      try {
        let mergedClientsWithFlags = clientsWithFlags || [];

        // Recount alerts after applying preserved clears
        const ACTIONABLE_FLAG_KEYS = new Set([
          "invoiceDashboardDiscr", "expenseDashboardDiscr",
          "crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
        ]);
        const NO_ACTION_FLAG_KEYS = new Set([
          "invoiceAppDiscr", "crmPipeSkippedBlank", "crmConfSkippedBlank",
          "crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete",
          "retainerInvoicesCreated", "retainerInvoicesDeleted", "expenseAppDiscr",
          "expenseAdded", "expenseUnreconGaps", "invoiceStaleUnsentChanges",
        ]);
        const mergedAlerts = (alerts || []).filter(a => {
          const client = mergedClientsWithFlags.find(c => c.clientName === a.clientName);
          if (!client) return false; // client has no active flags — drop their alerts
          const flagType = a.flagType || a.type;
          return client.flags[flagType] !== false;
        });
        const mergedNoActionAlerts = (noActionAlerts || []).filter(na => {
          const client = mergedClientsWithFlags.find(c => c.clientName === na.clientName);
          if (!client) return false; // client has no active flags — drop their noAction alerts
          return client.flags[na.flagType] !== false;
        });

        // Zero out actionable flags in clientsWithFlags where no alerts exist in the blob.
        // This prevents client cards appearing with no actionable items — which happens when
        // recheckIgnoredAlerts_ raises a flag but get_handled_fingerprints correctly skips
        // all those alerts (they're already handled). Without this, the flag stays TRUE in
        // AutoUpdates and the client appears in the UI with an empty alert list.
        const ACTIONABLE_FLAG_TO_ALERT_TYPE = {
          invoiceDashboardDiscr: ["invoice"],
          invoiceAppDiscr:       ["invoice"],
          invoiceStaleUnsentChanges: ["invoice"],
          crmPipeDashDiscr:      ["crm"],
          crmPipeAppDiscr:       ["crm"],
          crmConfDashDiscr:      ["crm"],
          crmConfAppDiscr:       ["crm"],
          crmPipeSkippedBlank:   ["crm"],
          crmConfSkippedBlank:   ["crm"],
          crmCopiedConfChecked:  ["crm"],
          crmCopiedConfUnchecked: ["crm"],
          crmCopiedConfDelete:   ["crm"],
          expenseDashboardDiscr: ["expense"],
          expenseAppDiscr:       ["expense"],
          expenseAdded:          ["expense"],
          expenseUnreconGaps:    ["expense"],
          retainerInvoicesCreated: ["retainerInvoicesCreated"],
          retainerInvoicesDeleted: ["retainerInvoicesDeleted"],
        };

        // Build set of clientName+flagType combinations that have at least one alert OR noAction alert
        const alertPresence = new Set();
        for (const a of mergedAlerts) {
          alertPresence.add(`${a.clientName}|||${a.flagType || a.type}`);
        }
        for (const na of mergedNoActionAlerts) {
          alertPresence.add(`${na.clientName}|||${na.flagType}`);
        }

        const ACTIONABLE_FLAG_TO_STICKY_COL = {
          invoiceDashboardDiscr: "CW",
          invoiceAppDiscr:       "DD",
          invoiceStaleUnsentChanges: "HE",
          crmPipeDashDiscr:      "DK",
          crmPipeAppDiscr:       "DR",
          crmConfDashDiscr:      "DY",
          crmConfAppDiscr:       "EF",
          crmPipeSkippedBlank:   "EM",
          crmConfSkippedBlank:   "ET",
          crmCopiedConfChecked:  "FA",
          crmCopiedConfUnchecked: "FH",
          crmCopiedConfDelete:   "FO",
          expenseDashboardDiscr: "GC",
          expenseAppDiscr:       "GJ",
          expenseAdded:          "GQ",
          expenseUnreconGaps:    "GX",
          retainerInvoicesCreated: "FV",
          retainerInvoicesDeleted: "HL",
        };

        // Track which flags need to be cleared in AutoUpdates
        const flagsToClearInAutoUpdates = []; // { clientName, col, rowNum }

        const reconciledClients = mergedClientsWithFlags.map(c => {
          const reconciledFlags = { ...c.flags };
          for (const [flagKey, alertTypes] of Object.entries(ACTIONABLE_FLAG_TO_ALERT_TYPE)) {
            if (!reconciledFlags[flagKey]) continue;
            // Flag is TRUE — check if any alert in the blob matches this client + flag
            const hasAlert = alertPresence.has(`${c.clientName}|||${flagKey}`)
              || alertTypes.some(at => alertPresence.has(`${c.clientName}|||${at}`));
            if (!hasAlert) {
              reconciledFlags[flagKey] = false;
              console.log(`  store_precomputed: zeroing ${flagKey} for ${c.clientName} — no alerts in blob`);
              const stickyCol = ACTIONABLE_FLAG_TO_STICKY_COL[flagKey];
              if (stickyCol && c.autoUpdatesRow) {
                flagsToClearInAutoUpdates.push({ col: stickyCol, rowNum: c.autoUpdatesRow });
              }
            }
          }
          return { ...c, flags: reconciledFlags };
        }).filter(c => Object.values(c.flags).some(v => v));
        // Remove clients where all flags were zeroed out

        // Second pass: catch clients that were in the incoming clientsWithFlags (from GAS)
        // but are NOT in reconciledClients — they've been fully reconciled away in a previous
        // cycle and are no longer in mergedClientsWithFlags at all. Their AutoUpdates flags
        // were never written FALSE because the reconciliation loop never reached them.
        const reconciledClientNames = new Set(reconciledClients.map(c => c.clientName));
        console.log(`  store_precomputed: ${(clientsWithFlags||[]).length} incoming clients, ${reconciledClients.length} after reconciliation`);
        for (const c of (clientsWithFlags || [])) {
          if (reconciledClientNames.has(c.clientName)) continue;
          for (const [flagKey, stickyCol] of Object.entries(ACTIONABLE_FLAG_TO_STICKY_COL)) {
            if (c.flags?.[flagKey] && c.autoUpdatesRow) {
              flagsToClearInAutoUpdates.push({ col: stickyCol, rowNum: c.autoUpdatesRow });
              console.log(`  store_precomputed: clearing ${flagKey} (${stickyCol}) for removed client ${c.clientName}`);
            }
          }
        }

        // Write FALSE to AutoUpdates for any zeroed flags — triage system owns flag clearing
        if (flagsToClearInAutoUpdates.length > 0) {
          try {
            const sheets = await getSheetsClient();
            const acIdClean = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;
            await sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: acIdClean,
              requestBody: {
                valueInputOption: "RAW",
                data: flagsToClearInAutoUpdates.map(({ col, rowNum }) => ({
                  range: `AutoUpdates!${col}${rowNum}`,
                  values: [["FALSE"]],
                })),
              },
            });
            console.log(`  store_precomputed: cleared ${flagsToClearInAutoUpdates.length} zeroed flag(s) in AutoUpdates`);
          } catch (auErr) {
            console.error(`  store_precomputed: failed to clear AutoUpdates flags: ${auErr.message}`);
          }
        }

        const precomputedData = {
          computedAt: computedAt || Date.now(),
          totalAlerts: mergedAlerts.length,
          noActionCount: mergedNoActionAlerts.length,
          alerts: mergedAlerts,
          noActionAlerts: mergedNoActionAlerts,
          clientsWithFlags: reconciledClients,
          noActionAnalysisResults: noActionAnalysisResults || {},
        };

        await redisClient.set(
          PRECOMPUTED_KEY,
          JSON.stringify(precomputedData),
          { EX: 3600 } // 1 hour TTL
        );

        const analysisCount = Object.keys(precomputedData.noActionAnalysisResults).length;
        console.log(`✅ store_precomputed: ${precomputedData.totalAlerts} alerts, ${analysisCount} pre-analysed flags saved to Redis`);
        return res.status(200).json({ success: true, stored: precomputedData.totalAlerts });
      } catch (err) {
        console.error("❌ Error storing precomputed data:", err);
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
      const { alert } = req.body;
      
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
        const memoryRow = findMemoryRow(memoryRows, fingerprintHash);

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
              const optionsToReturn = liveCopiedToConf !== null
                ? validCachedOptions.map(o => ({ ...o, copiedToConf: liveCopiedToConf }))
                : validCachedOptions;
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

        // Shared structure explanation used across all three prompt types
        const SHEET_STRUCTURE_BLOCK = `
CRITICAL: CONFIRMED TAB STRUCTURE — READ THIS CAREFULLY BEFORE ANALYSING

Each job consists of ONE PARENT ROW plus ZERO OR MORE CHILD ROWS:

PARENT ROW — identified by having Revenue, DirectCostBudget, Start date, End date values.
CHILD ROW — has the same Client name and Job name as its parent, but Revenue/Start date/End date are BLANK.
Child rows inherit Client name and Job name from their parent (this is how you identify them).
The DirectCostBudget and Revenue for a job ALWAYS come from the parent row — child rows never have their own budget.

Each row (parent or child) has 3 invoice slots (Inv1-3) and 3 direct cost expense slots (ExpSlot1-3).

PROJECT JOBS:
  Parent row:  Inv1, Inv2, Inv3  /  ExpSlot1, ExpSlot2, ExpSlot3  (invoices/expenses 1-3)
  Child row 1: Inv1, Inv2, Inv3  /  ExpSlot1, ExpSlot2, ExpSlot3  (invoices/expenses 4-6)
  Child row 2: Inv1, Inv2, Inv3  /  ExpSlot1, ExpSlot2, ExpSlot3  (invoices/expenses 7-9)

RETAINER JOBS — TWO MODES:
  Mode A (1 invoice total): Parent row has Inv1 only. No child rows needed.
  Mode B (2+ invoices):     Parent row has NO invoices (all invoice slots empty).
                             Each child row has exactly 1 invoice in Inv1 slot only.

IDENTIFYING PARENT vs CHILD:
  Parent: has Revenue value AND/OR Start date AND/OR End date
  Child:  same Client + same Job name as the parent row directly above it, but Revenue/Start/End are ALL blank

BUDGET AND REVENUE:
  Revenue and DirectCostBudget live on the parent row only.
  To calculate total invoiced or total expenses: sum ALL relevant slot amounts across the parent AND all its child rows.
  Allocated expenses = has a valid App ID (not blank, not MANUAL-ENTRY).
  Placeholder expenses = blank App ID or MANUAL-ENTRY — do NOT subtract these from remaining budget.`;

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
          const confirmedResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Confirmed!A1:CR300",
          });
          
          let confirmedData = confirmedResponse.data.values || [];
          
          if (confirmedData.length === 300) {
            console.log(`  Hit 300-row limit, fetching full range...`);
            const fullResponse = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: "Confirmed!A1:CR1000",
            });
            confirmedData = fullResponse.data.values || [];
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
          
          // Read AIKnowledgeBase for expense rules
          console.log(`  📚 Reading AIKnowledgeBase...`);
          let knowledgeBase = [];
          if (req.body.automationCommanderSheetId) {
            console.log(`  Using automationCommanderSheetId from request body`);
            knowledgeBase = await readAIKnowledgeBase(sheets, req.body.automationCommanderSheetId);
          } else {
            console.log(`  ⚠️ No automationCommanderSheetId in request body, skipping AIKnowledgeBase`);
          }
          
          let kbRules = "";
          if (knowledgeBase && knowledgeBase.length > 0) {
            kbRules = knowledgeBase
              .filter(row => row[0] === "EXPENSE_MATCHING")
              .map(row => `- **${row[2]}** (${row[1]}): ${row[3]}`)
              .join("\n");
            console.log(`  ✓ Found ${knowledgeBase.filter(row => row[0] === "EXPENSE_MATCHING").length} EXPENSE_MATCHING rules`);
          } else {
            console.log(`  ⚠️ No AIKnowledgeBase rules found`);
          }
          
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
                      childSlots.push({ label: `Row ${childSheetRow} ExpSlot${s+1}`, empty: true, sheetRow: childSheetRow, slotNum: s+1 });
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
                      slots.push({ label: `Row ${sheetRow} ExpSlot${s+1}`, empty: true, sheetRow, slotNum: s+1 });
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
              optionId: sysOptions.length + 1,
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
          for (const job of candidateJobs) {
            const jobWords = normExpWords(job.parentJob);
            const clientWords = normExpWords(job.parentClient);
            const overlap = expDescWords.some(w => jobWords.includes(w) || clientWords.includes(w));
            if (!overlap) continue;
            // Find best empty slot for this job
            const emptySlot = job.slots.find(s => s.empty);
            const availSlot = emptySlot || job.slots.find(s => !s.isAllocated);
            if (!availSlot) continue;
            const cols = slotColMapExp[availSlot.slotNum];
            const row  = availSlot.sheetRow;
            // Total allocated (real only) + this expense
            const realAllocated = job.slots.filter(s => !s.empty && s.isAllocated).reduce((sum, s) => sum + s.amtNum, 0);
            const newTotal = realAllocated + expenseAmount;
            const budgetNum = parseFloat(String(job.totalBudget||"0").replace(/[£$€,]/g,"")) || 0;
            const budgetFit = budgetNum > 0 ? (newTotal <= budgetNum ? "YES" : `OVER by £${(newTotal-budgetNum).toFixed(2)}`) : "UNKNOWN";
            jobDescMatches.push({ job, availSlot, cols, row, realAllocated, newTotal, budgetFit });
          }
          console.log(`  Confirmed job description matches: ${jobDescMatches.length}`);

          for (const jm of jobDescMatches.slice(0, 3)) {
            const { job, availSlot, cols, row, realAllocated, newTotal, budgetFit } = jm;
            const jobClientLabel = job.parentClient ? `${job.parentClient} — ${job.parentJob}` : job.parentJob;
            jobSysOptions.push({
              optionId: jobSysOptions.length + 1,
              title: `Allocate to "${jobClientLabel}" (Row ${row}, ExpSlot${availSlot.slotNum}) — job name match`,
              matchType: "job",
              jobRow: row,
              jobName: job.parentJob,
              matchingDetails: {
                unmatchedJobSummary: {
                  clientName: alert.clientName,
                  jobName: expenseDescription || expenseRef,
                  revenue: String(expenseAmount),
                  startDate: expenseDate,
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
                matchConfidence: "Medium",
                placeholderMatch: availSlot.empty ? `YES — Row ${row} ExpSlot${availSlot.slotNum} is empty` : `PARTIAL — unallocated slot available`,
                budgetFit,
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
              optionId: sysOptions.length + 1,
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
            optionId: sysOptions.length + 1,
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
              const tabResp = await sheets.spreadsheets.values.get({
                spreadsheetId: alert.clientId,
                range: `${tabName}!A1:AM5000`,
              });
              const tabRows = tabResp.data.values || [];
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
                    title: `UPDATE ${tabName} ${fc.name} to match CRM: "${fc.crm}"`,
                    matchType: "existing_job", jobRow, jobName,
                    matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode } },
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
                    title: `REVIEW ${fc.name} mismatch — manual update required`,
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
                title: `IGNORE — CRM data is wrong or discrepancy can be disregarded`,
                matchType: "ignore", jobRow: jobRow || alert.rowNumber, jobName,
                matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode } },
                recommendedActions: [ `Mark this field mismatch as ignored — no changes will be made` ],
              });

            } else {
              // not_found: job in sheet but not in CRM
              // Search the tab to find the actual Pipeline/Confirmed row number
              if (client || jobName || projectCode) {
                try {
                  const tabSearchResp = await sheets.spreadsheets.values.get({
                    spreadsheetId: alert.clientId,
                    range: `${tabName}!A1:C5000`,
                  });
                  const tabSearchRows = tabSearchResp.data.values || [];
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
                  title: `IGNORE — Job "${jobName || projectCode || "unknown"}" is legitimate and CRM discrepancy can be disregarded`,
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
                  title: `DELETE — Remove job "${jobName || projectCode || "unknown"}" from ${tabName} tab as it should not exist`,
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
            const tabResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: `${tabName}!A1:AM5000`,
            });
            const tabRows = tabResp.data.values || [];
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
                  title: `UPDATE ${tabName} ${fc.name} to match CRM: "${fc.crm}"`,
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
                  title: `REVIEW ${fc.name} mismatch — manual update required`,
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
                  title: `REVIEW ${fc.name} mismatch — job row not found in ${tabName}`,
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
              title: `IGNORE — CRM data is wrong or discrepancy can be disregarded`,
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
              title: `IGNORE — discrepancy for "${dashJob || dashCode || "unknown"}" can be disregarded`,
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
              title: `CREATE NEW job "${dashJob || dashCode || "unknown"}" in ${dashTabName} tab from CRM data`,
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
          console.log(`  Fetching Confirmed tab to find invoice #${invoiceNo}...`);
          const invConfirmedResp = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Confirmed!A1:BH5000",
          });
          const invConfirmedRows = invConfirmedResp.data.values || [];

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

            const jobSummary = `Client: ${jobClient} | Job: ${jobName}${jobCode ? ` (${jobCode})` : ""} | Revenue: ${jobRevenue} | VAT: ${jobVAT} | Type: ${jobType} | Start: ${jobStart} | End: ${jobEnd}
Inv1: ${slot1.ref || "(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}
Inv2: ${slot2.ref || "(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}
Inv3: ${slot3.ref || "(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`;

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

            // Build retainer revenue context for Claude if applicable
            let retainerContext = "";
            if (isRetainer) {
              const monthlyRevNum = parseFloat(String(jobRevenue || "0").replace(/[£$€,]/g, "")) || 0;
              // Calculate total months from start to end date
              const parseJobDate = (d) => {
                if (!d) return null;
                const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
                const parts = d.split(/[-\/]/);
                if (parts.length === 3) {
                  const mNum = months[parts[1]?.toLowerCase()?.substring(0,3)];
                  if (mNum !== undefined) {
                    const yr = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
                    return new Date(yr, mNum, parseInt(parts[0]));
                  }
                }
                return null;
              };
              const startD = parseJobDate(jobStart);
              const endD   = parseJobDate(jobEnd);
              let totalMonths = null;
              let totalRevenue = null;
              if (startD && endD) {
                totalMonths = (endD.getFullYear() - startD.getFullYear()) * 12 + (endD.getMonth() - startD.getMonth()) + 1;
                // Child rows cover past periods + up to 18 months into the future from today
                const today = new Date();
                const futureEndD = new Date(today.getFullYear(), today.getMonth() + 18, 1);
                const effectiveEnd = endD < futureEndD ? endD : futureEndD;
                const effectiveMonths = (effectiveEnd.getFullYear() - startD.getFullYear()) * 12 + (effectiveEnd.getMonth() - startD.getMonth()) + 1;
                totalRevenue = monthlyRevNum * Math.max(effectiveMonths, 1);
              }
              retainerContext = `
RETAINER JOB CONTEXT (IMPORTANT):
- The revenue figure (${jobRevenue}) is the MONTHLY amount, NOT the total contract value
- Start: ${jobStart}, End: ${jobEnd}${totalMonths ? `, Duration: ${totalMonths} months` : ""}
- Child rows cover past periods + up to 18 months into the future from today (no fixed maximum)
${totalRevenue ? `- EFFECTIVE CONTRACT REVENUE (to date + 18 months forward) = £${monthlyRevNum.toFixed(2)} × months = £${totalRevenue.toFixed(2)}` : ""}
- When comparing "total invoiced" to revenue, use the EFFECTIVE CONTRACT REVENUE above, not the monthly figure
- Do NOT include placeholder slots (blank reference or MANUAL-INV) in the "total invoiced" calculation`;
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
        
        // OPTIMIZATION: Only fetch up to column CR (79) instead of DC
        const confirmedResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: alert.clientId,
          range: "Confirmed!A1:CR500",
        });
        
        let confirmedData = confirmedResponse.data.values || [];
        
        // If we hit the 500 row limit, fetch more
        if (confirmedData.length === 500) {
          console.log(`  Detected 500 rows (likely more data), fetching full range...`);
          const fullResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Confirmed!A1:CR5000",
          });
          confirmedData = fullResponse.data.values || [];
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
        const datePaid = alert.summary?.datePaid || '';

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

          // ── Noise-word stripping & normalisation ──────────────────────────
          const NOISE_WORDS = new Set([
            "ltd","limited","plc","inc","llc","llp","the","and","&",
            "group","co","corp","corporation","holdings","international",
            "uk","us","solutions","services","consulting","consultancy",
          ]);
          const normClientWords = (s) => {
            return String(s || "")
              .toLowerCase()
              .replace(/['\-.,()]/g, " ")   // punctuation → space
              .replace(/\s+/g, " ")
              .trim()
              .split(" ")
              .filter(w => w.length > 1 && !NOISE_WORDS.has(w));
          };

          // Check if words in name A form the abbreviation of name B (or vice versa)
          const isAbbreviationOf = (abbrev, full) => {
            const abbrevClean = abbrev.replace(/\./g, "").toLowerCase();
            const fullWords = normClientWords(full);
            if (fullWords.length < 2 || abbrevClean.length < 2) return false;
            // Initials of full words should spell the abbreviation
            const initials = fullWords.map(w => w[0]).join("");
            return initials === abbrevClean || initials.startsWith(abbrevClean);
          };

          const fuzzyClientMatch = (invoiceClientStr, confirmedClientStr) => {
            const invWords  = normClientWords(invoiceClientStr);
            const confWords = normClientWords(confirmedClientStr);
            if (invWords.length === 0 || confWords.length === 0) return false;
            // Any single meaningful word overlap
            if (invWords.some(w => confWords.includes(w))) return true;
            // Substring containment after noise-stripping (catches "Peoples Health" vs "Peoples Health Trust")
            const invJoined  = invWords.join(" ");
            const confJoined = confWords.join(" ");
            if (confJoined.includes(invJoined) || invJoined.includes(confJoined)) return true;
            // Abbreviation: invoice client is abbreviation of confirmed client or vice versa
            if (isAbbreviationOf(invJoined.replace(/\s/g,""), confirmedClientStr)) return true;
            if (isAbbreviationOf(confJoined.replace(/\s/g,""), invoiceClientStr))  return true;
            return false;
          };

          const alertClientStr = alert.summary?.client || invoiceClient;
          clientFound = alertClientStr && activeData.some(row =>
            fuzzyClientMatch(alertClientStr, String(row[0] || ""))
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
          const invoiceAmtForMatch = totalExclVAT > 0 ? totalExclVAT : invoiceAmount;
          const amtToleranceFn = (slotAmt) => {
            if (isForeignCurrency) {
              return Math.abs(slotAmt - invoiceAmtForMatch) <= invoiceAmtForMatch * 0.10;
            }
            // Domestic: 5p tolerance (compare in pennies to avoid float errors)
            return Math.abs(Math.round(slotAmt * 100) - Math.round(invoiceAmtForMatch * 100)) <= 5;
          };

          // Date tolerance: ±invoiceMonthsTolerance months from invoice sent date
          const invMonthsTol = Number(tolerances.invoiceMonthsTolerance) || 2;
          const parseConfirmedDate = (d) => {
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
            return null;
          };
          const invSentDateParsed = parseConfirmedDate(sentDate);
          const dateWithinTolerance = (slotDateStr) => {
            if (!invSentDateParsed || !slotDateStr) return null; // null = unknown (no date to compare)
            const slotDate = parseConfirmedDate(slotDateStr);
            if (!slotDate) return null;
            const diffMonths = (slotDate.getFullYear() - invSentDateParsed.getFullYear()) * 12
              + (slotDate.getMonth() - invSentDateParsed.getMonth());
            return Math.abs(diffMonths) <= invMonthsTol;
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
            const jobManualSlots = new Map(); // key → { slots: [], client, jobName, projectCode, revenue }
            for (let ri = 1; ri < activeData.length; ri++) {
              const row = activeData[ri] || [];
              const rowClient  = String(row[0] || "").trim();
              const rowJob     = String(row[1] || "").trim();
              const rowCode    = String(row[2] || "").trim();
              const rowRevenue = String(row[32] || "").trim();
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
                  jobManualSlots.set(key, { slots: [], client: rowClient, jobName: rowJob, projectCode: rowCode, revenue: rowRevenue });
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
                    } else if (invSentDateParsed && parseConfirmedDate(slotDate)) {
                      const diffMonths = Math.abs((parseConfirmedDate(slotDate) - invSentDateParsed) / (1000*60*60*24*30.4));
                      const direction = parseConfirmedDate(slotDate) > invSentDateParsed ? "after" : "before";
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
            title: `Place in ${m.jobName} invoice position ${slotNum} (Row ${rowNum} Slot ${slotNum}) — exact amount match, ${isManual ? "replacing MANUAL-INV placeholder" : "slot date match"}`,
            matchType: "existing_job",
            jobRow: rowNum,
            jobName: m.jobName,
            jobRevenue: m.revenue,
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
            title: `Place in ${best.jobName} slot ${best.slotNum} (Row ${best.rowNum}) — amount match, ${slotDesc}`,
            matchType: "existing_job",
            jobRow: best.rowNum,
            jobName: best.jobName,
            jobRevenue: best.revenue,
            matchingDetails: {
              unmatchedJobSummary: {
                clientName: invClient,
                jobName: invJob,
                projectCode: "",
                revenue: String(invoiceAmtForMatch),
                startDate: sentDate,
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
          });
        }

        // ── Signal B: Job-name fuzzy matched slots (any non-real slot) ────────
        // Separate pass: find jobs where client OR job name has word overlap with the invoice,
        // regardless of slot amount. Surface these as lower-confidence options.
        if (invJobWords.length > 0 || invClientWords.length > 0) {
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
            const jobOverlap    = invJobWords.some(w => rjWords.includes(w))    || rjWords.some(w => invJobWords.includes(w));
            if (!clientOverlap && !jobOverlap) continue;

            for (const sd of INV_SLOT_DEFS2) {
              const ref = String(r[sd.refIdx]||"").trim();
              const rawAmt = r[sd.amtIdx];
              const isManual = ref.toUpperCase().startsWith("MANUAL-INV");
              const isNonReal = !ref || isManual;
              if (!isNonReal) continue;
              const slotAmt = parseFloat(String(rawAmt||"").replace(/[£$€,]/g,"")) || 0;
              const slotKey = `${ri+1}-${sd.slotNum}`;
              if (seenSlotKeys.has(slotKey)) continue; // already in Signal A
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
              const amtDiff   = slotAmt > 0 ? (invoiceAmtForMatch - slotAmt) : null;
              const amtNote   = slotAmt > 0
                ? (Math.abs(invoiceAmtForMatch - slotAmt) < 0.01
                  ? "exact amount match"
                  : `slot is £${slotAmt.toFixed(2)}, invoice is £${invoiceAmtForMatch.toFixed(2)} — diff £${Math.abs(amtDiff||0).toFixed(2)}`)
                : "slot amount unknown";
              const overUnder = bRevNum > 0 ? (bNewTotal > bRevNum ? ` (over budget by £${(bNewTotal-bRevNum).toFixed(2)})` : ` (£${(bRevNum-bNewTotal).toFixed(2)} remaining)`) : "";
              const slotLabel = isManual ? "MANUAL-INV placeholder" : "blank placeholder";

              tier2Options.push({
                optionId: tier2Options.length + 1,
                title: `Place in ${rj||rc} slot ${sd.slotNum} (Row ${ri+1}) — name match, ${slotLabel}, ${amtNote}`,
                matchType: "existing_job",
                jobRow: ri + 1,
                jobName: rj || rc,
                jobRevenue: bRev,
                matchingDetails: {
                  unmatchedJobSummary: {
                    clientName: invClient, jobName: invJob, projectCode: "",
                    revenue: String(invoiceAmtForMatch), startDate: sentDate, endDate: "",
                  },
                  matchedJobDetails: {
                    clientName: rc, jobName: rj, projectCode: String(r[2]||""), revenue: bRev, startDate: "", endDate: "",
                  },
                },
                matchAnalysis: {
                  matchConfidence: "Low",
                  amountMatch: slotAmt > 0 ? (Math.abs(invoiceAmtForMatch-slotAmt)<0.01 ? "YES" : `PARTIAL — ${amtNote}`) : "UNKNOWN",
                  dateRangeMatch: slotDate ? "UNKNOWN" : "N/A",
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
              });
              if (tier2Options.length >= 5) break; // cap at 5 options total
            }
            if (tier2Options.length >= 5) break;
          }
        }

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
        const options = tier2Options.map((o, i) => ({ ...o, optionId: i + 1 }));
        console.log(`  ✅ System-generated ${options.length} invoice options`);

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
            error: `Job "${option.jobName}" not found in ${tabName} tab — client name or job name may not match exactly.`,
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
      const { clientSheetId, masterSheetId, automationCommanderSheetId: acId, flagType, clientName } = req.body;

      if (!clientSheetId || !masterSheetId || !acId || !flagType) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }

      try {
        console.log(`\n🔍 Analyzing non-actionable flag: ${flagType} for ${clientName}`);
        const sheets = await getSheetsClient();
        const masterSheetIdClean = extractSheetIdFromUrl(masterSheetId) || masterSheetId;
        const clientSheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
        const acIdClean = extractSheetIdFromUrl(acId) || acId;

        // ── Step 1: Find when the flag was last cleared ──────────────────────────
        // Read AlertMemory for the most recent flag_cleared record for this client.
        // Written by clear_flags whenever the triage system clears flags.

        const now = new Date();
        let windowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); // default: 90 days ago
        let foundClear = false;

        try {
          const memoryRows = await readAlertMemory(sheets, acIdClean);
          const clearRows = memoryRows
            .filter(r => r.alertType === "flag_cleared" && r.clientName === clientName)
            .sort((a, b) => {
              // Sort by clearedAt from dataSnapshot for precision (has time component)
              const getTs = (row) => {
                try {
                  const snap = JSON.parse(row.dataSnapshot || "{}");
                  if (snap.clearedAt) return new Date(snap.clearedAt).getTime();
                } catch(e) { /* ignore */ }
                return new Date(row.lastSeen || 0).getTime();
              };
              return getTs(b) - getTs(a);
            });
          if (clearRows.length > 0) {
            // Use dataSnapshot.clearedAt for precision (has time component), fall back to lastSeen date
            let clearedAt = null;
            try {
              const snap = JSON.parse(clearRows[0].dataSnapshot || "{}");
              if (snap.clearedAt) clearedAt = new Date(snap.clearedAt);
            } catch(e) { /* ignore */ }
            if (!clearedAt || isNaN(clearedAt.getTime())) {
              clearedAt = new Date(clearRows[0].lastSeen || clearRows[0].firstSeen);
            }
            if (!isNaN(clearedAt.getTime())) {
              windowStart = clearedAt;
              foundClear = true;
              console.log(`  ✓ Flag last cleared at ${clearedAt.toISOString()} (AlertMemory flag_cleared)`);
            }
          }
        } catch (e) {
          console.log(`  ⚠ Could not read AlertMemory for clear timestamp: ${e.message}`);
        }

        if (!foundClear) {
          console.log(`  ℹ No clear record found in AlertMemory — using 90-day window from ${windowStart.toISOString()}`);
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
        const autoLogRows = allAutoLogRows.filter(row => {
          const ts = autoLogSerialToDate(row[0]);
          return ts && ts > windowStart;
        });
        console.log(`  ✓ ${autoLogRows.length} AutoLog entries after window start (${allAutoLogRows.length} total)`);

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
                    ? `✓ Confirmed tab: "${confirmedMatch.jobName}"${confirmedMatch.projectCode ? ` (${confirmedMatch.projectCode})` : ""}${confirmedRowStr}${clientStr} found`
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

    } else if (action === "clear_flags") {

      // Clear flags by writing FALSE directly to the sticky flag columns in AutoUpdates.
      // The triage system is the sole owner of clearing flags — no DataChgAlert intermediary.
      // flagsToClear is an array of: "invoice", "crm", "expense" (any combination).
      const { automationCommanderSheetId, flagsToClear, clientName } = req.body;

      if (!automationCommanderSheetId || !flagsToClear || flagsToClear.length === 0 || !clientName) {
        return res.status(400).json({
          success: false,
          error: "Missing automationCommanderSheetId, clientName, or flagsToClear",
        });
      }

      try {
        console.log(`\n🔄 Clearing flags for client: ${clientName}`);
        console.log(`   Flag groups to clear: ${flagsToClear.join(", ")}`);

        const sheets = await getSheetsClient();
        const acIdClean = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;

        // Map flag groups to their AutoUpdates sticky columns
        const FLAG_GROUP_COLUMNS = {
          invoice: ["CW", "DD", "FV", "HL", "HE"], // invoiceDashboardDiscr, invoiceAppDiscr, retainerInvoicesCreated, retainerInvoicesDeleted, invoiceStaleUnsentChanges
          crm:     ["DK", "DR", "DY", "EF", "EM", "ET", "FA", "FH", "FO"], // all CRM flags
          expense: ["GC", "GJ", "GQ", "GX"], // all expense flags
        };

        // Find the client row in AutoUpdates
        const namesResp = await sheets.spreadsheets.values.get({
          spreadsheetId: acIdClean,
          range: "AutoUpdates!A2:A1000",
        });
        const nameRows = namesResp.data.values || [];
        let clientRowNum = -1;
        for (let i = 0; i < nameRows.length; i++) {
          if (String(nameRows[i]?.[0] || "").trim() === clientName.trim()) {
            clientRowNum = i + 2; // 1-indexed, starts at row 2
            break;
          }
        }
        if (clientRowNum === -1) {
          return res.status(404).json({ success: false, error: `Client "${clientName}" not found in AutoUpdates` });
        }

        const colsToZero = flagsToClear.flatMap(group => FLAG_GROUP_COLUMNS[group] || []);
        if (colsToZero.length === 0) {
          return res.status(400).json({ success: false, error: "No valid flag groups specified" });
        }

        // Write FALSE to all sticky columns for this client in one batch
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: acIdClean,
          requestBody: {
            valueInputOption: "RAW",
            data: colsToZero.map(col => ({
              range: `AutoUpdates!${col}${clientRowNum}`,
              values: [["FALSE"]],
            })),
          },
        });

        console.log(`  ✅ AutoUpdates cleared for ${clientName} row ${clientRowNum}: ${colsToZero.join(", ")}`);

        // Write a flag_cleared record to AlertMemory so analyze_noaction_flag can
        // determine the windowStart for AutoLog lookback without needing a separate tab.
        try {
          const nowISO = new Date().toISOString();
          const nowDate = nowISO.split("T")[0];
          const clearHash = `flag_cleared_${clientName.replace(/\s+/g, "_").toLowerCase()}_${Date.now()}`;
          await sheets.spreadsheets.values.append({
            spreadsheetId: acIdClean,
            range: `${ALERT_MEMORY_TAB}!A:K`,
            valueInputOption: "RAW",
            requestBody: {
              values: [[
                clearHash,
                "flag_cleared",
                clientName,
                `Flags cleared: ${flagsToClear.join(", ")}`,
                "", // cachedOptionsJSON
                "accepted",
                "", // ignoreReason
                nowDate, // firstSeen
                nowDate, // lastSeen
                nowDate, // lastRechecked
                JSON.stringify({ clearedGroups: flagsToClear, clearedCols: colsToZero, clearedAt: nowISO }),
              ]],
            },
          });
          console.log(`  ✅ AlertMemory flag_cleared record written for ${clientName}`);
        } catch (amErr) {
          console.error(`  ⚠ Could not write flag_cleared to AlertMemory: ${amErr.message}`);
        }

        return res.status(200).json({
          success: true,
          message: `Cleared: ${flagsToClear.join(", ")}`,
          colsCleared: colsToZero,
        });
      } catch (err) {
        console.error(`❌ Error clearing flags:`, err);
        return res.status(500).json({
          success: false,
          error: `Failed to clear flags: ${err.message}`,
        });
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
        const before = parsed.alerts.length;
        parsed.alerts = parsed.alerts.filter(a => `${a.sheetName}-${a.rowNumber}` !== alertId);
        const removed = before - parsed.alerts.length;
        await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 });
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
          // Remove noAction alerts for this client that belong to cleared flag groups
          if (parsed.noActionAlerts) {
            parsed.noActionAlerts = parsed.noActionAlerts.filter(na => {
              if (na.clientId !== clientName && !na.flagType) return true; // keep if can't determine
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
          await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 });
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
            parsed.noActionAlerts = parsed.noActionAlerts.filter(na => {
              return !keysToZero.has(na.flagType) || na.clientId !== clientName;
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
      // Mark a noAction flag as resolved in the Redis session so it persists across reloads.
      const { sessionId, clientName, flagType } = req.body;
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
        await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 });
        console.log(`  resolve_noaction_flag: marked "${key}" as resolved`);

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
        const dataSnapshot = JSON.stringify({
          alertType: alert.type || alert.flagType || "",
          invoiceNo:     alert.summary?.invoiceNo     || "",
          reference:     alert.summary?.reference     || "",
          amount:        String(alert.summary?.amount || ""),
          status:        alert.summary?.status        || "",
          flagType:      alert.flagType               || "",
          masterSheetId: alert.masterSheetId          || "",
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

    } else if (action === "get_ignored_for_recheck") {
      // Reads all "ignored" AlertMemory rows older than 4 hours, re-reads the live comparison
      // tabs for each client, builds fresh fingerprints using the same Node.js logic that
      // created the original fingerprints, and returns which rows have changed vs unchanged.
      // GAS uses this to mark superseded rows and raise flags — no fingerprint logic in GAS.
      const automationCommanderSheetId = req.body.automationCommanderSheetId || req.query.automationCommanderSheetId;
      // masterSheetIds map: clientName → masterSheetId, passed by GAS from AutoUpdates
      const clientMasterSheetIds = req.body.clientMasterSheetIds || {};

      if (!automationCommanderSheetId) {
        return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
        const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
        const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
        const cutoff = Date.now() - FOUR_HOURS_MS;

        const dueRows = memoryRows.filter(r => {
          if (r.status !== "ignored") return false;
          const ts = r.lastRechecked ? new Date(r.lastRechecked).getTime() : 0;
          return isNaN(ts) || ts < cutoff;
        });

        console.log(`  ${dueRows.length} ignored alerts due for recheck`);
        if (dueRows.length === 0) {
          return res.status(200).json({ success: true, changed: [], unchanged: [] });
        }

        const changed = [];
        const unchanged = [];

        // Group by clientName + alertType to minimise tab reads
        const groups = {};
        for (const row of dueRows) {
          const snap = row.dataSnapshot ? (() => { try { return JSON.parse(row.dataSnapshot); } catch(e) { return {}; } })() : {};
          const masterSheetId = snap.masterSheetId || clientMasterSheetIds[row.clientName] || null;
          // If no dataSnapshot at all, we have nothing to compare against — treat as unchanged
          // (these are rows promoted by rehash that never had a snapshot set)
          if (!row.dataSnapshot) {
            unchanged.push(row.rowIndex);
            continue;
          }
          const key = `${row.clientName}|||${row.alertType}|||${masterSheetId || ""}`;
          if (!groups[key]) groups[key] = { masterSheetId, alertType: row.alertType, rows: [] };
          groups[key].rows.push(row);
        }

        for (const [key, group] of Object.entries(groups)) {
          const { masterSheetId, alertType, rows } = group;
          if (!masterSheetId) {
            console.log(`  No masterSheetId for group ${key} — treating as unchanged`);
            unchanged.push(...rows.map(r => r.rowIndex));
            continue;
          }

          // Read fresh alerts from the comparison tab
          let freshAlerts = [];
          try {
            if (alertType === "invoice") {
              freshAlerts = await readInvCompAlerts(sheets, masterSheetId);
            } else if (alertType === "expense") {
              freshAlerts = await readDirCompAlerts(sheets, masterSheetId);
            } else if (alertType === "crm") {
              const pipe = await readCRMCompAlerts(sheets, masterSheetId, "Pipeline", ["crmPipeDashDiscr"], masterSheetId);
              const conf = await readCRMCompAlerts(sheets, masterSheetId, "Confirmed", ["crmConfDashDiscr"], masterSheetId);
              freshAlerts = [...pipe, ...conf];
            }
          } catch (e) {
            console.log(`  Error reading fresh data for ${key}: ${e.message} — treating as unchanged`);
            unchanged.push(...rows.map(r => r.rowIndex));
            continue;
          }

          // Build map of current fingerprints → alert from fresh data
          const freshHashToAlert = new Map(freshAlerts.map(a => [buildAlertFingerprint(a), a]));
          const freshHashes = new Set(freshHashToAlert.keys());

          // Also build a summary-based lookup for migration: if the stored hash doesn't
          // match any fresh hash but a fresh alert has the same summary prefix, it means
          // the hash format changed (normalisation migration) rather than the data changing.
          // In that case, update the stored fingerprint rather than superseding the row.
          const freshBySummaryPrefix = new Map();
          for (const [hash, alert] of freshHashToAlert) {
            const summaryKey = (alert.summary?.summary || JSON.stringify(alert.data || {}).slice(0, 60));
            freshBySummaryPrefix.set(summaryKey, hash);
          }

          const rowsToUpdateHash = []; // { rowIndex, newHash } — hash migration
          for (const row of rows) {
            if (freshHashes.has(row.fingerprintHash)) {
              unchanged.push(row.rowIndex);
            } else {
              // Check if a fresh alert matches by alertSummary prefix (normalisation migration)
              const summaryKey = (row.alertSummary || "").slice(0, 60);
              const matchingFreshHash = freshBySummaryPrefix.get(summaryKey);
              if (matchingFreshHash) {
                // Same alert, hash format changed — update stored hash, treat as unchanged
                console.log(`  HASH MIGRATION: ${row.fingerprintHash} → ${matchingFreshHash} (${row.clientName})`);
                rowsToUpdateHash.push({ rowIndex: row.rowIndex, newHash: matchingFreshHash });
                unchanged.push(row.rowIndex);
              } else {
                console.log(`  CHANGED: ${row.fingerprintHash} (${row.clientName} / ${alertType})`);
                changed.push({ rowIndex: row.rowIndex, fingerprintHash: row.fingerprintHash, clientName: row.clientName, alertType });
              }
            }
          }

          // Batch update migrated hashes
          if (rowsToUpdateHash.length > 0) {
            const acIdClean = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;
            await sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: acIdClean,
              requestBody: {
                valueInputOption: "RAW",
                data: rowsToUpdateHash.map(({ rowIndex, newHash }) => ({
                  range: `${ALERT_MEMORY_TAB}!A${rowIndex}`,
                  values: [[newHash]],
                })),
              },
            }).catch(e => console.log(`  ⚠ Hash migration write failed: ${e.message}`));
          }
        }

        console.log(`  ✅ Recheck complete: ${changed.length} changed, ${unchanged.length} unchanged`);
        return res.status(200).json({ success: true, changed, unchanged });
      } catch (err) {
        console.error(`❌ Error in get_ignored_for_recheck:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "mark_superseded") {
      // Marks an AlertMemory row as "superseded" (data has changed since it was ignored).
      // Accepts either rowIndex (legacy) or fingerprintHash (preferred — robust to row shifts).
      const { rowIndex, fingerprintHash: fpHash, automationCommanderSheetId } = req.body;
      if (!automationCommanderSheetId) {
        return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      }
      try {
        const sheets = await getSheetsClient();
        const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
        // Prefer hash lookup (stable), fall back to rowIndex
        const memoryRow = fpHash
          ? findMemoryRow(memoryRows, fpHash)
          : memoryRows.find(r => r.rowIndex === rowIndex);
        if (!memoryRow) {
          // Row may have been deleted by dedupe — treat as non-fatal
          console.log(`  ⚠ mark_superseded: row not found (hash=${fpHash}, idx=${rowIndex}) — skipping`);
          return res.status(200).json({ success: true, skipped: true });
        }
        const nowISO = new Date().toISOString();
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
          ...memoryRow,
          status: "superseded",
          lastRechecked: nowISO,
        });
        console.log(`  ✅ Marked row ${memoryRow.rowIndex} as superseded (${memoryRow.fingerprintHash})`);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error(`❌ Error in mark_superseded:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "update_recheck_timestamp") {
      // Updates lastRechecked on a batch of AlertMemory rows without changing their status.
      // Called by GAS precompute after re-checking alerts that have NOT changed.
      const { rowIndexes, automationCommanderSheetId } = req.body;
      if (!rowIndexes?.length || !automationCommanderSheetId) {
        return res.status(400).json({ success: false, error: "Missing rowIndexes or automationCommanderSheetId" });
      }
      try {
        const sheets = await getSheetsClient();
        const nowISO = new Date().toISOString();
        // Batch update just col J (lastRechecked = col 10, index 9) for each row
        const data = rowIndexes.map(ri => ({
          range: `${ALERT_MEMORY_TAB}!J${ri}`,
          values: [[nowISO]],
        }));
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: automationCommanderSheetId,
          requestBody: { data, valueInputOption: "RAW" },
        });
        console.log(`  ✅ Updated lastRechecked for ${rowIndexes.length} rows`);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error(`❌ Error in update_recheck_timestamp:`, err);
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

        // Build set of handled fingerprints — ignored, task, superseded, or accepted
        const handledHashes = new Set(
          memoryRows
            .filter(r => r.status === "ignored" || r.status === "task" || r.status === "superseded" || r.status === "accepted")
            .map(r => r.fingerprintHash)
            .filter(Boolean)
        );

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
      // Called by GAS overnight checks to store/update alerts in ProactiveAlerts tab.
      const { alerts: incomingAlerts, automationCommanderSheetId: acId } = req.body;
      if (!incomingAlerts || !acId) {
        return res.status(400).json({ success: false, error: "Missing alerts or automationCommanderSheetId" });
      }
      try {
        const sheets = await getSheetsClient();
        await ensureProactiveAlertsTab(sheets, acId);
        const existing = await readProactiveAlerts(sheets, acId);

        // Build two lookup maps:
        // 1. By exact alertKey (primary)
        // 2. By clientName+alertType+confirmedRow (fallback — handles key format changes between GAS runs)
        const existingByKey = {};
        const existingBySignature = {};
        for (const row of existing) {
          existingByKey[row.alertKey] = row;
          const confirmedRow = (row.metadata && row.metadata.confirmedRow) ? row.metadata.confirmedRow : "";
          const sig = `${row.clientName}|||${row.alertType}|||${confirmedRow}`;
          // Keep the most recent row per signature (last writer wins)
          if (!existingBySignature[sig] || row.rowIndex > existingBySignature[sig].rowIndex) {
            existingBySignature[sig] = row;
          }
        }

        const nowISO = new Date().toISOString().split("T")[0];
        let stored = 0, updated = 0, dismissed = 0;
        const writes = [];

        // Auto-dismiss active alerts of the same alertType(s) that are NOT in the incoming list.
        // This handles cases where a previously-valid alert is no longer triggered (e.g. invoice
        // was sent, retainer was fully invoiced, etc.) — without this, stale alerts persist forever.
        const incomingAlertTypes = new Set(incomingAlerts.map(a => a.alertType));
        const incomingKeys = new Set(incomingAlerts.map(a => a.alertKey));
        const incomingSignatures = new Set(incomingAlerts.map(a => {
          const cr = a.confirmedRow || (a.metadata && a.metadata.confirmedRow) || "";
          return `${a.clientName}|||${a.alertType}|||${cr}`;
        }));
        for (const row of existing) {
          if (row.status !== "active") continue;
          if (!incomingAlertTypes.has(row.alertType)) continue; // different type — don't touch
          const cr = (row.metadata && row.metadata.confirmedRow) ? row.metadata.confirmedRow : "";
          const sig = `${row.clientName}|||${row.alertType}|||${cr}`;
          if (!incomingKeys.has(row.alertKey) && !incomingSignatures.has(sig)) {
            // This alert was active but not in the incoming run — auto-dismiss
            writes.push({ range: `${PROACTIVE_ALERTS_TAB}!F${row.rowIndex}`, values: [["auto_dismissed"]] });
            writes.push({ range: `${PROACTIVE_ALERTS_TAB}!I${row.rowIndex}`, values: [[nowISO]] });
            dismissed++;
            console.log(`  Auto-dismissed stale ${row.alertType} alert for ${row.clientName}: ${row.alertKey}`);
          }
        }

        for (const alert of incomingAlerts) {
          // Build the signature for this incoming alert
          const incomingConfirmedRow = alert.confirmedRow || (alert.metadata && alert.metadata.confirmedRow) || "";
          const sig = `${alert.clientName}|||${alert.alertType}|||${incomingConfirmedRow}`;

          // Look up by exact key first, then by signature
          const ex = existingByKey[alert.alertKey] || existingBySignature[sig];

          if (ex) {
            if (ex.status === "acknowledged" || ex.status === "auto_dismissed") { dismissed++; continue; }
            // Active match found — update lastSeen and alertKey (in case key format changed)
            writes.push({ range: `${PROACTIVE_ALERTS_TAB}!A${ex.rowIndex}`, values: [[alert.alertKey]] });
            writes.push({ range: `${PROACTIVE_ALERTS_TAB}!H${ex.rowIndex}`, values: [[nowISO]] });
            updated++;
          } else {
            // No match — append new row
            const metadata = {};
            const metaFields = ["jobName","endClientName","confirmedRow","revenue","startDate","endDate",
              "frequencyDays","lastInvoiceDate","expectedByDate","timestamp","sequenceType","summary","jobInfo","detailsSnippet",
              "childRowNum","clientJobStr","pipelineRow","likelihood","copiedToConf","jobType"];
            for (const f of metaFields) { if (alert[f] !== undefined) metadata[f] = alert[f]; }

            await sheets.spreadsheets.values.append({
              spreadsheetId: acId,
              range: `${PROACTIVE_ALERTS_TAB}!A:J`,
              valueInputOption: "RAW",
              requestBody: { values: [[
                alert.alertKey, alert.alertType, alert.clientName,
                alert.heading, alert.detail, "active", nowISO, nowISO, "",
                JSON.stringify(metadata),
              ]] },
            });
            stored++;
          }
        }
        if (writes.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: acId,
            requestBody: { data: writes, valueInputOption: "RAW" },
          });
        }
        console.log(`  ✅ Proactive alerts: ${stored} stored, ${updated} updated, ${dismissed} dismissed`);
        return res.status(200).json({ success: true, stored, updated, dismissed });
      } catch (err) {
        console.error(`❌ Error in store_proactive_alerts:`, err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_proactive_alerts") {
      // Returns all active proactive alerts, optionally filtered by clientName.
      const acId = req.body.automationCommanderSheetId || req.query.automationCommanderSheetId;
      if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        await ensureProactiveAlertsTab(sheets, acId);
        const all = await readProactiveAlerts(sheets, acId);
        const active = all.filter(r => r.status === "active");
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

    } else if (action === "acknowledge_proactive_alert") {
      // Marks a proactive alert as acknowledged so it won't reappear.
      // Updates ALL rows with the matching alertKey (handles duplicates from repeated GAS runs).
      const { alertKey, automationCommanderSheetId: acId } = req.body;
      if (!alertKey || !acId) return res.status(400).json({ success: false, error: "Missing alertKey or automationCommanderSheetId" });
      try {
        const sheets = await getSheetsClient();
        const all = await readProactiveAlerts(sheets, acId);
        const matchingRows = all.filter(r => r.alertKey === alertKey);
        if (matchingRows.length === 0) return res.status(404).json({ success: false, error: "Alert not found" });
        const nowISO = new Date().toISOString();
        const writeData = [];
        for (const row of matchingRows) {
          writeData.push({ range: `${PROACTIVE_ALERTS_TAB}!F${row.rowIndex}`, values: [["acknowledged"]] });
          writeData.push({ range: `${PROACTIVE_ALERTS_TAB}!I${row.rowIndex}`, values: [[nowISO]] });
        }
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: acId,
          requestBody: { data: writeData, valueInputOption: "RAW" },
        });
        console.log(`  ✅ Acknowledged ${matchingRows.length} row(s) for alertKey: ${alertKey}`);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error(`❌ Error in acknowledge_proactive_alert:`, err);
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

        const dataSnapshot = JSON.stringify({
          alertType:     alert.type || alert.flagType || "",
          invoiceNo:     alert.summary?.invoiceNo     || "",
          reference:     alert.summary?.reference     || "",
          amount:        String(alert.summary?.amount || ""),
          status:        alert.summary?.status        || "",
          flagType:      alert.flagType               || "",
          masterSheetId: alert.masterSheetId          || "",
          taskKey,
        });

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
            dataSnapshot: JSON.stringify({ ...JSON.parse(memoryRow.dataSnapshot || "{}"), ...taskMeta }),
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
            dataSnapshot: JSON.stringify(taskMeta),
          });
        }

        // If from ProactiveAlerts tab, mark it as "task" there too
        if (isProactive && proactiveAlertKey) {
          try {
            const all = await readProactiveAlerts(sheets, acId);
            const proRow = all.find(r => r.alertKey === proactiveAlertKey);
            if (proRow) {
              await sheets.spreadsheets.values.update({
                spreadsheetId: acId,
                range: `${PROACTIVE_ALERTS_TAB}!F${proRow.rowIndex}`,
                valueInputOption: "RAW",
                requestBody: { values: [["task"]] },
              });
            }
          } catch (e) {
            console.log(`  ⚠️ Could not update ProactiveAlerts tab: ${e.message}`);
          }
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