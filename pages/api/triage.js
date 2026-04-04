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
  expenseDashboardDiscr: "GC",
  expenseAppDiscr: "GJ",
  expenseAdded: "GQ",
  expenseUnreconGaps: "GX",
  invoiceStaleUnsentChanges: "HE",
};

// Precomputed triage data — stored by cron job, consumed by frontend on Start
const PRECOMPUTED_KEY = "triage_precomputed";
const PRECOMPUTED_MAX_AGE_MS = 45 * 60 * 1000; // 45 minutes (GAS precompute runs every 30 min)

const NO_ACTION_FLAGS = [
  "invoiceAppDiscr",
  "crmPipeSkippedBlank",
  "crmConfSkippedBlank",
  "crmCopiedConfChecked",
  "crmCopiedConfUnchecked",
  "crmCopiedConfDelete",
  "retainerInvoicesCreated",
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
const ALERT_MEMORY_RANGE = `${ALERT_MEMORY_TAB}!A:I`;
const ALERT_MEMORY_MAX_AGE_MONTHS = 12;

/**
/**
 * Normalise a value for fingerprinting — ensures dates are always in DD-Mon-YY format
 * regardless of whether they came from the Sheets API (4-digit year) or GAS (2-digit year).
 */
function normaliseForFingerprint(val) {
  if (typeof val !== "string") return String(val ?? "");
  // Match DD-Mon-YYYY (4-digit year) → convert to DD-Mon-YY
  return val.replace(/^(\d{1,2}-[A-Za-z]{3}-)(\d{4})$/, (_, prefix, year) => prefix + year.slice(-2));
}

function normaliseArrayForFingerprint(arr) {
  return (arr || []).map(normaliseForFingerprint);
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
 * Returns the memory row object or null.
 */
function findMemoryRow(memoryRows, fingerprintHash) {
  return memoryRows.find(r => r.fingerprintHash === fingerprintHash) || null;
}

/**
 * Find any previous ignore reason for an alert that has since been superseded.
 * Matches superseded rows by client name + alert type + key identifier
 * (invoice number, reference, or job name from the dataSnapshot).
 * Returns the ignore reason string, or null if not found.
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

      // Try to match by invoice number or reference from dataSnapshot
      if (row.dataSnapshot) {
        try {
          const snap = JSON.parse(row.dataSnapshot);
          const snapInvNo = (snap.invoiceNo || "").trim();
          const snapRef   = (snap.reference || "").trim();
          if (alertInvNo && snapInvNo && snapInvNo === alertInvNo) return row.ignoreReason;
          if (alertRef   && snapRef   && snapRef   === alertRef)   return row.ignoreReason;
        } catch (e) { /* ignore parse errors */ }
      }

      // Fallback: match by alert summary substring
      if (alertInvNo && (row.alertSummary || "").includes(alertInvNo)) return row.ignoreReason;
      if (alertRef   && (row.alertSummary || "").includes(alertRef))   return row.ignoreReason;
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
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!E2`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[value]],
    },
  });

  // Ensure data is fresh
  await ensureFreshData(sheets, spreadsheetId, sheetName);
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
      range: "AutoUpdates!CW2:HE1000",
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
  
  // DEBUG: Log raw values
  console.log(`DEBUG buildDirCompSummary:`, {
    raw_accounting: accounting,
    index_0: accounting[0],
    index_1: accounting[1],
    index_2: accounting[2],
    index_3: accounting[3],
    index_4: accounting[4],
    index_5: accounting[5],
    index_6: accounting[6],
    index_7: accounting[7],
    index_8: accounting[8],
  });
  
  // DirComp columns (A:J) - CORRECTED MAPPING:
  // A: Date, B: Description, C: Amount, D: Reference, E: Account name, F: Status, G: Transaction ID, H: Date Paid, I: VAT
  const date = accounting[0] || '';
  const description = accounting[1] || '';
  const amount = parseFloat(String(accounting[2] || '0').replace(/,/g, '')) || 0; // Column C - Amount
  const reference = accounting[3] || '';
  const accountName = accounting[4] || '';
  const status = accounting[5] || ''; // Column F - Status
  const transactionId = accounting[6] || ''; // Column G - Transaction ID
  const datePaid = accounting[7] || ''; // Column H - Date Paid
  const vatAmount = accounting[8] || ''; // Column I - VAT
  
  console.log(`DEBUG after parsing:`, {
    date, description, amount, reference, accountName, status, transactionId, datePaid, vatAmount
  });
  
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
            accounting: row.slice(0, 11),
            confirmed: row.slice(12, 18),
            flags: row.slice(18, 25),
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
            accounting: row.slice(0, 10),
            confirmed: row.slice(23, 34),
            flags: row.slice(40, 48),
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

async function readCRMCompAlerts(sheets, spreadsheetId, mode, alertTypes) {
  try {
    console.log(`\n📖 Reading CRMComp alerts (${mode} mode) for ${alertTypes.join(", ")}...`);
    
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

      if (mode === "Pipeline") {
        if (alertType === "crmPipeDashDiscr") {
          // Left section: X:AJ (CRM), AO:AW (Pipeline), AY:BF (flags)
          dataRange = "CRMComp!X6:BF1000";
          crmDataCols = [0, 13]; // X:AJ (indices 0-12)
          sheetDataCols = [14, 24]; // AO:AW (indices 14-23)
          flagCols = [24, 32]; // AY:BF (indices 24-31)
          flagStartIdx = 24;
        } else if (alertType === "crmPipeAppDiscr") {
          // Right section: EF:EQ (Pipeline), EU:FD (CRM), FE:FL (flags)
          dataRange = "CRMComp!EF6:FL1000";
          sheetDataCols = [0, 12]; // EF:EQ (indices 0-11)
          crmDataCols = [13, 23]; // EU:FD (indices 13-23)
          flagCols = [24, 32]; // FE:FL (indices 24-31)
          flagStartIdx = 24;
        }
      } else if (mode === "Confirmed") {
        if (alertType === "crmConfDashDiscr") {
          // Left section: X:AJ (CRM), AO:AW (Confirmed), AY:BF (flags)
          dataRange = "CRMComp!X6:BF1000";
          crmDataCols = [0, 13]; // X:AJ (indices 0-12)
          sheetDataCols = [14, 24]; // AO:AW (indices 14-23)
          flagCols = [24, 32]; // AY:BF (indices 24-31)
          flagStartIdx = 24;
        } else if (alertType === "crmConfAppDiscr") {
          // Right section: EF:EQ (Confirmed), EU:FD (CRM), FE:FL (flags)
          dataRange = "CRMComp!EF6:FL1000";
          sheetDataCols = [0, 12]; // EF:EQ (indices 0-11)
          crmDataCols = [13, 23]; // EU:FD (indices 13-23)
          flagCols = [24, 32]; // FE:FL (indices 24-31)
          flagStartIdx = 24;
        }
      }

      if (!dataRange) continue;

      const dataResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: dataRange,
      });
      const rows = dataResponse.data.values || [];

      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (!row || row.length === 0) continue;

        // Check if any flag = "1"
        const hasDiscrepancy = [flagStartIdx, flagStartIdx + 1, flagStartIdx + 2,
          flagStartIdx + 3, flagStartIdx + 4, flagStartIdx + 5,
          flagStartIdx + 6, flagStartIdx + 7].some(
          (idx) => String(row[idx] || "").trim() === "1"
        );

        if (hasDiscrepancy) {
          alerts.push({
            type: "crm",
            alertType,
            mode,
            sheetName: "CRMComp",
            rowNumber: 7 + rowIdx,
            data: {
              crmData: row.slice(crmDataCols[0], crmDataCols[1]),
              sheetData: row.slice(sheetDataCols[0], sheetDataCols[1]),
              flags: row.slice(flagStartIdx, flagStartIdx + 8),
            },
          });
        }
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
  const newBlock = `{App ID: ${transactionId}}{Amt: ${amount}}{Status: ${status || ""}}{Rec date: ${recDate || ""}}{Pay date: ${payDate || ""}}{Description: ${description || ""}}`;

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

    if (action === "start_triage") {
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
              pipelineAlerts
            );
            crmAlerts.forEach((alert) => {
              alert.clientId = client.clientSheetId;
              alert.masterSheetId = client.masterSheetId;
              alert.clientName = client.clientName;
            });
            allAlerts.push(...crmAlerts);
          }

          if (confirmedAlerts.length > 0) {
            const crmAlerts = await readCRMCompAlerts(
              sheets,
              client.masterSheetId,
              "Confirmed",
              confirmedAlerts
            );
            crmAlerts.forEach((alert) => {
              alert.clientId = client.clientSheetId;
              alert.masterSheetId = client.masterSheetId;
              alert.clientName = client.clientName;
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

      // Build set of ignored fingerprints for fast lookup
      const ignoredHashes = new Set(
        memoryRows.filter(r => r.status === "ignored").map(r => r.fingerprintHash)
      );

      // Attach fingerprint to every alert and filter out ignored ones
      const filteredAlerts = [];
      let ignoredCount = 0;
      for (const alert of allAlerts) {
        alert.fingerprintHash = buildAlertFingerprint(alert);
        if (ignoredHashes.has(alert.fingerprintHash)) {
          ignoredCount++;
          console.log(`  ⏭ Skipping ignored alert: ${alert.fingerprintHash} (${alert.clientName})`);
        } else {
          filteredAlerts.push(alert);
        }
      }
      console.log(`  ✓ ${filteredAlerts.length} active alerts, ${ignoredCount} ignored alerts filtered out`);

      console.log(`💾 Storing session in Redis...`);

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
        const ignoredHashes = new Set(
          memoryRows.filter(r => r.status === "ignored").map(r => r.fingerprintHash)
        );

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
              noActionAnalysisResults } = req.body;

      if (secret !== process.env.CRON_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorised" });
      }

      try {
        const precomputedData = {
          computedAt: computedAt || Date.now(),
          totalAlerts: totalAlerts || 0,
          noActionCount: noActionCount || 0,
          alerts: alerts || [],
          noActionAlerts: noActionAlerts || [],
          clientsWithFlags: clientsWithFlags || [],
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
    } else if (action === "analyze_alert") {
      // Generate matching options for an alert
      const { alert } = req.body;
      
      if (!alert) {
        res.status(400).json({ success: false, error: "Missing alert data" });
        return;
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
              return res.status(200).json({
                success: true,
                options: validCachedOptions,
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
              // Confirmed tab expense — manual investigation required
              const options = [{
                optionId: 1,
                title: `MANUAL INVESTIGATION REQUIRED — VAT mismatch on Confirmed tab expense`,
                matchType: "info",
                matchAnalysis: {
                  matchConfidence: "N/A",
                  reasonForChoice: `This VAT mismatch is on a Confirmed tab expense (source: ${source}). The VAT setting is stored per expense slot and cannot be changed automatically. Please investigate manually.`,
                  discrepancies: `VAT mismatch on ${source} for "${vendorDesc}"`,
                },
                recommendedActions: [
                  `Check the VAT field for "${vendorDesc}" in ${source} of the Confirmed tab`,
                  `Correct the VAT value manually in the appropriate slot`,
                ],
              }];
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
              // Mixed VAT treatment — manual investigation
              const options = [{
                optionId: 1,
                title: `MANUAL INVESTIGATION REQUIRED — Mixed VAT treatment across items for "${vendorName}"`,
                matchType: "info",
                matchAnalysis: {
                  matchConfidence: "N/A",
                  reasonForChoice: `${vendorOGRows.length} Outgoings items found for "${vendorName}", but they have mixed VAT treatments (some with VAT, some without). Changing the row-level VAT setting would not resolve all discrepancies. Manual investigation required.`,
                  discrepancies: `VAT mismatch — ${vatTreatments.filter(v=>v==="yes").length} items with VAT, ${vatTreatments.filter(v=>v==="no").length} items without VAT`,
                },
                recommendedActions: [
                  `Review all expense items for "${vendorName}" in the Outgoings tab`,
                  `Determine the correct VAT treatment for each item individually`,
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
                    childSlots.push({ label: `Row ${childSheetRow} ExpSlot${s+1}`, descr, amt, date, appId, isAllocated, empty: false, sheetRow: childSheetRow, slotNum: s+1 });
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
                    slots.push({ label: `Row ${sheetRow} ExpSlot${s+1}`, descr, amt, date, appId, isAllocated, empty: false, sheetRow, slotNum: s+1 });
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

          const expenseConfirmedTabTable = candidateJobs.length > 0
            ? candidateJobs.map(job => {
                const filled = job.slots.filter(s => !s.empty)
                  .map(s => `${s.label}: ${s.descr} £${s.amt} ${s.date} (${s.isAllocated ? 'allocated' : 'NO App ID - placeholder'})`)
                  .join(' | ') || 'none';
                const empty = job.slots.filter(s => s.empty).map(s => s.label).join(', ') || 'none';
                if (job.isRetainer) {
                  const budgetLabel = job.periodMultiplier > 1
                    ? `£${job.budget} (${job.periodLabel}: £${job.budget / job.periodMultiplier}/month × ${job.periodMultiplier} months)`
                    : `£${job.budget} (monthly)`;
                  return `ChildRow ${job.childSheetRow} | ${job.parentClient} | ${job.parentJob} (retainer ${job.periodLabel}) | Code: ${job.projectCode} | PeriodBudget: ${budgetLabel} | Allocated: £${job.totalAllocated.toFixed(2)} | Remaining: £${job.remaining.toFixed(2)} | WRITE TARGET: Row ${job.childSheetRow} slots only\n  Filled slots: ${filled}\n  Empty write-target slots: ${empty}`;
                }
                return `ParentRow ${job.parentRow} | ${job.parentClient} | ${job.parentJob} | Code: ${job.projectCode} | Budget: £${job.budget} | Allocated: £${job.totalAllocated.toFixed(2)} | Remaining: £${job.remaining.toFixed(2)} | Type: ${job.projType} | ${job.startDate}→${job.endDate}\n  Filled slots: ${filled}\n  Empty write-target slots: ${empty}`;
              }).join('\n\n')
            : '(no jobs with DirectCostBudget > £0)'
          
          // Build expense prompt with flat Confirmed tab data (same approach as invoices)
          const expensePrompt = `You are analyzing an unmatched business expense and must suggest the best ways to record it.

The expense could be either:
1. A DIRECT COST for a specific client job — written into an expense slot on the Confirmed tab
2. A CONTRACTOR EXPENSE recorded in the Outgoings tab — added to the vendor's row for the correct month

⚠️ CRITICAL — READ BEFORE ANALYSING:
1. The expense description may contain a CLIENT name in brackets (e.g. "Design FC Ltd (Marmoris designs)"). The part in brackets is the CLIENT this work was done FOR — it is NOT a match signal. Match only on the VENDOR name (the part before the brackets).
2. NEVER suggest a job with DirectCostBudget = £0 or blank. Only jobs with DirectCostBudget > £0 are candidates for direct cost allocation.
3. A job with DirectCostBudget > £0 is a candidate even if no placeholder matches the vendor — remaining budget and job scope are sufficient for a STRONG MATCH.

UNMATCHED EXPENSE:
• Reference: ${expenseRef}
• Vendor/Description: ${expenseDescription}
• Amount: £${expenseAmount.toFixed(2)}
• Date: ${expenseDate}
• Account Category: ${expenseAccountName}
• VAT Amount: ${alert.summary?.vatAmount || '£0'}
• VAT field to write (BZ/CG/CN): ${vatYesNo} ← use this exact value, do not recalculate
• Status: ${alert.summary?.status || '(unknown)'}
• Transaction ID: ${alert.summary?.transactionId || '(unknown)'}

OUTGOINGS TAB — CONTRACTOR SECTION (rows 12-112):
The Outgoings tab tracks contractor expenses by vendor. Each row is one vendor.
Column A = vendor name. The monthly columns accumulate the running total for that vendor.
Writing to Outgoings means: find the vendor's row (or use first blank row for new vendors), add the amount to the correct month column, and append a note block.

EXISTING VENDORS IN OUTGOINGS (rows 12-112, col A):
${outgoingsVendorList.length > 0 ? outgoingsVendorList.join('\n') : '(none found)'}
${firstBlankOutgoingsRow ? `First available blank row for new vendor: Row ${firstBlankOutgoingsRow}` : '(no blank rows available)'}

JOBS WITH DIRECT COST BUDGET (pre-analysed — only jobs with DirectCostBudget > £0):
${expenseConfirmedTabTable}

Budget, Allocated, and Remaining are already calculated.
Empty slots show the exact row and slot number to write to — use those exact row numbers in cell writes.
Placeholders (NO App ID) = unconfirmed planned spend — a placeholder whose description ≈ this vendor = PERFECT MATCH.

IMPORTANT — RETAINER ENTRIES: Lines starting with "ChildRow" are individual monthly retainer entries.
Each is independent — its budget applies only to that specific row. Treat each ChildRow as a completely separate job.
The jobRow in your JSON response for a ChildRow entry must be the ChildRow number, NOT the parent row number.

EXPENSE SLOT COLUMNS (same letters for all rows):
- ExpSlot1: BX(Desc) BY(Amt) BZ(VAT?) CA(Date) CB(DaysToPay) CC(Status) CD(TransactionID)
- ExpSlot2: CE(Desc) CF(Amt) CG(VAT?) CH(Date) CI(DaysToPay) CJ(Status) CK(TransactionID)
- ExpSlot3: CL(Desc) CM(Amt) CN(VAT?) CO(Date) CP(DaysToPay) CQ(Status) CR(TransactionID)

MATCHING RULES:
${kbRules || "- Default matching rules apply"}

YOUR TASK — suggest 3 GENUINELY DIFFERENT options:

Option 1 (best job match): Pick the job from the list above where:
  - Remaining >= £${expenseAmount.toFixed(2)} OR a placeholder matches the vendor
  - Prefer: exact placeholder match > largest remaining budget > most relevant job scope
  - Write to the first empty slot for that job (use the exact row number shown)

Option 2 (Outgoings entry): Record in the Outgoings tab.
  - Vendor "${expenseDescription.split('(')[0].trim()}" — use existing row if listed above, else Row ${firstBlankOutgoingsRow || "next blank"}
  - Account category "${expenseAccountName}" confirms this is a subcontractor expense

Option 3 (second-best job OR alternative): Next best job match, or if only one qualifies, explain why Outgoings is better

CRITICAL — recommendedActions MUST be specific and actionable:
For Confirmed tab job matches, provide EXACTLY 2 items:
  Item 1: Plain English — "Allocate expense to [Job Name] (Row [N]), [ExpSlotX]"
  Item 2: Exact cell writes — "Write [Desc] to [COL][ROW], write [Amt] to [COL][ROW], write ${vatYesNo} to [COL][ROW], write [Date] to [COL][ROW], write [DaysToPay] to [COL][ROW], write [Status] to [COL][ROW], write [TransactionID] to [COL][ROW]"
  Note: The VAT field (BZ/CG/CN) must always be "${vatYesNo}" — this is pre-computed from the actual VAT amount.

For Outgoings tab entries, provide EXACTLY 1 item:
  "Add £[amount] to [VendorName] row (Row [N]) in Outgoings tab for [Mon-YY]"
  (The backend handles the actual cell write using outgoingsData)

Format as JSON array:
[{
  "optionId": 1,
  "title": "Concise title",
  "matchType": "job" or "category",
  "jobRow": 85,
  "jobName": "Job name (parent row — job matches only)",
  "category": "Exact vendor name for Outgoings (category matches only)",
  "allocationBreakdown": {
    "parentRow": 85,
    "jobDirectCostBudget": "£20,607",
    "allocatedExpenses": ["Vendor A £1,050 (Row 86 ExpSlot1 — valid App ID)", "Vendor B £6,737.50 (Row 86 ExpSlot2 — valid App ID)"],
    "placeholderExpenses": ["Design FC Ltd £700 (Row 86 ExpSlot3 — NO App ID, placeholder)"],
    "totalAllocated": "£7,787.50",
    "remainingBudget": "£12,819.50",
    "expenseCanFit": "YES — £${expenseAmount.toFixed(2)} fits within remaining £12,819.50"
  },
  "matchAnalysis": {
    "matchConfidence": "High/Medium/Low",
    "vendorAnalysis": "brief factual note",
    "placeholderMatch": "YES — Row 86 ExpSlot3 has placeholder matching vendor / NO",
    "budgetFit": "YES / NO",
    "reasonForChoice": "one sentence",
    "discrepancies": "any concerns, or None"
  },
  "outgoingsData": {
    "NOTE": "ONLY include for category matches. Omit entirely for job matches.",
    "categoryName": "exact vendor name — must match Outgoings col A or be a new vendor name",
    "expenseMonth": "YYYY-MM",
    "transactionId": "${alert.summary?.transactionId || ''}",
    "amount": ${expenseAmount},
    "description": "${expenseDescription}",
    "status": "${alert.summary?.status || ''}",
    "recDate": "${expenseDate}",
    "payDate": "",
    "vatCharged": "${vatYesNo}"
  },
  "recommendedActions": ["..."]
}]

Return ONLY JSON, no other text.`;

          console.log(`\n📤 EXPENSE PROMPT TO CLAUDE: ${expenseDescription} £${expenseAmount}`);
          console.log(`\n📊 CONFIRMED TAB DATA SENT TO CLAUDE (full):\n${expenseConfirmedTabTable}`);
          const message = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 3000,
            messages: [{ role: "user", content: expensePrompt }],
          });

          let options = [];
          const responseText = message.content[0].type === "text" ? message.content[0].text : "";
          const cleanedText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();

          try {
            options = JSON.parse(cleanedText);
            if (!Array.isArray(options)) options = [options];
            console.log(`  ✅ Parsed ${options.length} expense options from Claude`);
          } catch (e) {
            console.error(`  ⚠️ Could not parse Claude response as JSON: ${e.message}`);
            options = [{ summary: responseText }];
          }

          // Write to AlertMemory cache
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
        
        // Handle CRM alerts
        if (alert.type === "crm" || alert.sheetName === "CRMComp") {
          console.log(`  📊 Analyzing CRM alert...`);

          const alertType = alert.alertType || alert.flagType || "";

          // App discrepancy: job exists in sheet (Confirmed/Pipeline) but not in CRM.
          // The only valid actions are: ignore the discrepancy, or delete the job from the sheet.
          // We never suggest creating a job — Claude is not needed here.
          if (alertType === "crmConfAppDiscr" || alertType === "crmPipeAppDiscr") {
            const tabName = alertType === "crmPipeAppDiscr" ? "Pipeline" : "Confirmed";
            const src = alert.data?.sheetData || [];
            const client     = src[0] || alert.clientName || "";
            const jobName    = src[1] || "";
            const projectCode = src[2] || "";
            const revenue    = src[3] || "";
            const startDate  = src[5] || "";
            const endDate    = src[6] || "";
            const jobDesc = [client, jobName, projectCode].filter(Boolean).join(" — ");

            const options = [
              {
                optionId: 1,
                title: `IGNORE — Job "${jobName || projectCode || "unknown"}" is legitimate and CRM discrepancy can be disregarded`,
                matchType: "ignore",
                jobRow: alert.rowNumber,
                jobName,
                matchingDetails: {
                  unmatchedJobSummary: {
                    clientName: client,
                    jobName,
                    projectCode,
                    revenue,
                    startDate,
                    endDate,
                  },
                },
                recommendedActions: [
                  `Verify that "${jobDesc}" is intentionally absent from the CRM`,
                  `If confirmed, mark this alert as ignored to prevent it recurring`,
                ],
              },
              {
                optionId: 2,
                title: `DELETE — Remove job "${jobName || projectCode || "unknown"}" from ${tabName} tab as it should not exist`,
                matchType: "delete",
                jobRow: alert.rowNumber,
                jobName,
                matchingDetails: {
                  unmatchedJobSummary: {
                    clientName: client,
                    jobName,
                    projectCode,
                    revenue,
                    startDate,
                    endDate,
                  },
                },
                recommendedActions: [
                  `Blank all cells for "${jobDesc}" and its child rows in the ${tabName} tab`,
                  `All columns A:G, AG:AM, AP:BH, BX:CR will be cleared across the parent row and all child rows`,
                  `Verify no invoices or expenses are linked to this job before accepting`,
                ],
              },
            ];

            console.log(`  ✅ App discr — returning 2 hardcoded options (ignore/delete) for ${jobDesc}`);

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
          
          // Determine which tab to match against (Pipeline or Confirmed)
          const crmMode = await getCRMMatchingMode(sheets, alert.masterSheetId || alert.clientId);
          console.log(`  Mode: ${crmMode}`);
          
          const tabName = crmMode === "Pipeline" ? "Pipeline" : "Confirmed";
          
          const jobsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: `${tabName}!A1:BH500`,
          });
          
          let jobsData = jobsResponse.data.values || [];
          
          // If we hit the 500 row limit, fetch more
          if (jobsData.length === 500) {
            console.log(`  Detected 500 rows, fetching full range...`);
            const fullResponse = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: `${tabName}!A1:BH5000`,
            });
            jobsData = fullResponse.data.values || [];
          }
          
          console.log(`  ✓ Loaded ${jobsData.length} rows from ${tabName}`);
          
          // Find last non-blank row (checking relevant columns)
          let lastDataRow = 1;
          for (let row = jobsData.length - 1; row > 0; row--) {
            const rowData = jobsData[row] || [];
            // Check columns that indicate a job exists: A-E (client/job), AG-AM (revenue/dates)
            const colsToCheck = [0, 1, 2, 3, 4, 32, 33, 34, 35, 36, 37, 38];
            const hasData = colsToCheck.some(col => rowData[col]);
            
            if (hasData) {
              lastDataRow = row;
              break;
            }
          }
          
          const activeJobsData = jobsData.slice(0, lastDataRow + 1);
          console.log(`  ✓ Found ${activeJobsData.length} non-blank rows in ${tabName}`);
          
          // Build list of ALL existing jobs for Claude reference
          const existingJobs = [];
          for (let i = 1; i < activeJobsData.length; i++) {
            const row = activeJobsData[i] || [];
            const client = row[0] || '';
            const jobName = row[1] || '';
            const revenue = row[32] !== undefined ? row[32] : '';
            const startDate = row[37] || '';
            const endDate = row[38] || '';
            
            if (client && jobName) {
              existingJobs.push(`Row ${i + 1}: ${client} | ${jobName} | Revenue: ${revenue} | Dates: ${startDate} to ${endDate}`);
            }
          }
          
          console.log(`  ✓ Built reference list of ${existingJobs.length} jobs`);
          
          // Read AIKnowledgeBase for CRM rules
          console.log(`  📚 Reading AIKnowledgeBase...`);
          let knowledgeBase = [];
          if (req.body.automationCommanderSheetId) {
            knowledgeBase = await readAIKnowledgeBase(sheets, req.body.automationCommanderSheetId);
          } else {
            console.log(`  ⚠️ No automationCommanderSheetId in request body, skipping AIKnowledgeBase`);
          }
          
          let kbRules = "";
          if (knowledgeBase && knowledgeBase.length > 0) {
            kbRules = knowledgeBase
              .filter(row => row[0] === "CRM_MATCHING")
              .map(row => `- **${row[2]}** (${row[1]}): ${row[3]}`)
              .join("\n");
            console.log(`  ✓ Found ${knowledgeBase.filter(row => row[0] === "CRM_MATCHING").length} CRM_MATCHING rules`);
          } else {
            console.log(`  ⚠️ No AIKnowledgeBase rules found`);
          }
          
          // Extract CRM details
          const crmProjectCode = alert.summary?.projectCode || alert.data?.projectCode || "(unknown)";
          const crmJobName = alert.summary?.jobName || alert.data?.jobName || "";
          const crmRevenue = parseFloat(alert.summary?.revenue) || parseFloat(alert.data?.revenue) || 0;
          const crmStartDate = alert.summary?.startDate || alert.data?.startDate || "";
          const crmEndDate = alert.summary?.endDate || alert.data?.endDate || "";
          
          // Build CRM prompt with detailed matching analysis
          const crmPrompt = `You are analyzing a CRM discrepancy between the Dashboard and CRM system.

UNMATCHED CRM JOB:
• Project Code: ${crmProjectCode}
• Client: ${alert.clientName || ""}
• Job Name: ${crmJobName}
• Revenue: £${crmRevenue.toFixed(2)}
• Start Date: ${crmStartDate}
• End Date: ${crmEndDate}
• Matching Mode: ${tabName}

EXISTING JOBS IN ${tabName.toUpperCase()} TAB:
${existingJobs.join("\n")}
${SHEET_STRUCTURE_BLOCK}

MATCHING RULES & KNOWLEDGE BASE:
${kbRules || "- Default matching rules apply"}

YOUR TASK:
1. Find the best matches in the ${tabName} tab for this CRM job
2. For EACH option, analyze: Client name, Job name similarity, Revenue match, Date range match, Project code
3. For recommendedActions: Generate EXACT cell update instructions for creating/matching the job
4. Suggest 3 options: BEST MATCH, ALTERNATIVE, CREATE NEW JOB

For each option, provide detailed matching analysis showing:
- Why this matches (or why CREATE NEW if no match)
- Confidence level based on matching criteria
- Specific details from the matched job
- Any concerns or discrepancies
- Recommended actions with EXACT cell coordinates

**CRITICAL: For recommendedActions, provide exact cell coordinates and values:**

Example format for existing job match:
"Update existing job in Row 52 - ${tabName} tab: Verify Client = ABC Ltd (Col A), Job name = New Project (Col B), Project Code = PRJ-001 (Col C), Revenue = £5,000 (Col AG), Start Date = 1-Apr-26 (Col AL), End Date = 30-Jun-26 (Col AM)"

Example format for creating new job:
"Create new job in ${tabName} tab, next available row: write ABC Ltd to Col A, write New Project to Col B, write PRJ-001 to Col C, write 5000 to Col AG, write 1-Apr-26 to Col AL, write 30-Jun-26 to Col AM, write 265.67 to Col AP, write 2111-1 to Col AQ, write 28-Mar-26 to Col AR, write 30 to Col AS, write Sent to Col AT"

Format as JSON array:
[{
  "optionId": 1,
  "title": "Match to [Job Name] in ${tabName} - [reason]",
  "matchType": "existing_job" or "create_new",
  "jobRow": 52,
  "jobName": "Job Name (if matching existing)",
  "matchingDetails": {
    "unmatchedJobSummary": {
      "projectCode": "${crmProjectCode}",
      "clientName": "${alert.clientName || ""}",
      "jobName": "${crmJobName}",
      "revenue": "£${crmRevenue.toFixed(2)}",
      "startDate": "${crmStartDate}",
      "endDate": "${crmEndDate}"
    },
    "matchedJobDetails": {
      "row": 52,
      "clientName": "Client Name from matched job",
      "jobName": "Job name from matched job",
      "revenue": "Revenue from matched job",
      "startDate": "Start date from matched job",
      "endDate": "End date from matched job",
      "projectCode": "Project code from matched job (if any)"
    }
  },
  "matchAnalysis": {
    "matchConfidence": "High/Medium/Low",
    "clientNameMatch": "YES/NO/PARTIAL - explain similarity",
    "jobNameMatch": "YES/NO/PARTIAL - explain similarity",
    "revenueMatch": "YES/NO - amounts and variance",
    "dateRangeMatch": "YES/NO/PARTIAL - explain date overlap or differences",
    "projectCodeMatch": "YES/NO - are codes similar or identical",
    "reasonForChoice": "Detailed explanation of why this is the best match",
    "discrepancies": "Any concerns about this match",
    "whyItDidntAutoMatch": "Why the system didn't find this automatically (if applicable)"
  },
  "recommendedActions": [
    "Create new job in ${tabName} tab: [one sentence plain English summary of what will be created]",
    "write ABC Ltd to Col A, write New Project to Col B, write PRJ-001 to Col C, write 5000 to Col AG, write No to Col AI, write Project to Col AJ, write 1-Apr-26 to Col AL, write 30-Jun-26 to Col AM, write 265.67 to Col AP, write 2111-1 to Col AQ, write 28-Mar-26 to Col AR, write 30 to Col AS, write Sent to Col AT"
  ]
}]

CRITICAL REQUIREMENTS:
- Include matchingDetails with BOTH unmatchedJobSummary and matchedJobDetails for comparison
- Include full matchAnalysis with all matching criteria
- For CREATE NEW option: matchType MUST be "create_new". recommendedActions item 2 MUST contain ALL cell writes in exact format "write VALUE to Col X" for every field — client (Col A), job name (Col B), project code (Col C), revenue (Col AG), VAT (Col AI), type (Col AJ), start date (Col AL), end date (Col AM), and ALL invoice slot fields (amount, reference, sent date, days to pay, status). Never say a new row is "beyond scope" — always provide the full write instructions.
- For existing job match: Verify key fields match
- For recommendedActions, include EXACT cell coordinates (Col letter + row number) and values to write

Return ONLY JSON, no other text.`;

          const message = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1500,
            messages: [
              { role: "user", content: crmPrompt }
            ],
          });

          let options = [];
          const responseText = message.content[0].type === "text" ? message.content[0].text : "";
          const cleanedText = responseText
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
          
          try {
            options = JSON.parse(cleanedText);
            if (!Array.isArray(options)) options = [options];
            console.log(`  ✅ Parsed ${options.length} CRM options from Claude`);
          } catch (e) {
            console.error(`  ⚠️ Could not parse Claude response as JSON`);
            console.error(`  Raw Claude response (first 500 chars): ${responseText.slice(0, 500)}`);
            options = [{ summary: responseText }];
          }

          // Write to AlertMemory cache
          const crmSummary = `CRM ${alert.alertType || ""} ${alert.data?.crmData?.[0] || ""} ${alert.data?.crmData?.[1] || ""}`.trim();
          if (memoryRow) {
            await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
              ...memoryRow,
              cachedOptionsJSON: JSON.stringify(options),
            });
          } else {
            await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
              fingerprintHash,
              alertType: alert.alertType || "crm",
              clientName: alert.clientName || "",
              alertSummary: crmSummary,
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
        
        // Default: Handle invoice alerts with flag-based branching
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
            if (vatIncluded > 0 && !jobVATYes && Math.abs(totalExclVAT - dashboardTotal) < epsilon) {
              console.log(`  VAT scenario A: invoice sent WITH VAT (£${vatIncluded}) but job marked NO VAT`);
              const options = [{
                optionId: 1,
                title: `MANUAL INVESTIGATION — Invoice sent WITH VAT but job is marked NO VAT`,
                matchType: "info",
                discrepancyType: "inv_amt_mismatch",
                explanation: `Invoice #${invoiceNo} was sent including VAT (£${vatIncluded.toFixed(2)}), but the job in the Confirmed tab is marked as "No VAT". The dashboard total (£${dashboardTotal.toFixed(2)}) matches the invoice amount excluding VAT (£${totalExclVAT.toFixed(2)}), confirming the mismatch. Either the job's VAT setting needs updating to "Yes", or the invoice needs to be re-issued excluding VAT.`,
                jobDetails: {
                  clientName: jobClient, jobName, projectCode: jobCode, revenue: jobRevenue,
                  vatSetting: jobVAT, startDate: jobStart, endDate: jobEnd,
                  slot1: `${slot1.ref||"(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}`.trim(),
                  slot2: `${slot2.ref||"(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}`.trim(),
                  slot3: `${slot3.ref||"(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`.trim(),
                },
                recommendedActions: [],
              }];
              return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
            }

            // Scenario B: Invoice sent WITHOUT VAT, job marked to INCLUDE VAT
            // Evidence: VAT = 0 AND gross amount ≈ dashboard total (excl VAT portion)
            if (vatIncluded === 0 && jobVATYes && Math.abs(grossAmount - dashboardTotal) < epsilon) {
              console.log(`  VAT scenario B: invoice sent WITHOUT VAT but job marked YES VAT`);
              const options = [{
                optionId: 1,
                title: `MANUAL INVESTIGATION — Invoice sent WITHOUT VAT but job is marked YES VAT`,
                matchType: "info",
                discrepancyType: "inv_amt_mismatch",
                explanation: `Invoice #${invoiceNo} was sent without VAT (VAT = £0.00), but the job in the Confirmed tab is marked as "Yes VAT". The dashboard total (£${dashboardTotal.toFixed(2)}) matches the gross invoice amount (£${grossAmount.toFixed(2)}), but the expected total including VAT would be higher. Either the job's VAT setting needs updating to "No", or the invoice needs to be re-issued including VAT.`,
                jobDetails: {
                  clientName: jobClient, jobName, projectCode: jobCode, revenue: jobRevenue,
                  vatSetting: jobVAT, startDate: jobStart, endDate: jobEnd,
                  slot1: `${slot1.ref||"(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}`.trim(),
                  slot2: `${slot2.ref||"(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}`.trim(),
                  slot3: `${slot3.ref||"(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`.trim(),
                },
                recommendedActions: [],
              }];
              return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
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
              let cappedMonths = null;
              if (startD && endD) {
                totalMonths = (endD.getFullYear() - startD.getFullYear()) * 12 + (endD.getMonth() - startD.getMonth()) + 1;
                cappedMonths = Math.min(totalMonths, 18);
                totalRevenue = monthlyRevNum * cappedMonths;
              }
              retainerContext = `
RETAINER JOB CONTEXT (IMPORTANT):
- The revenue figure (${jobRevenue}) is the MONTHLY amount, NOT the total contract value
- Start: ${jobStart}, End: ${jobEnd}${totalMonths ? `, Duration: ${totalMonths} months` : ""}
- Maximum 18 invoice slots per job (system limit)${cappedMonths ? `, so effective period = ${cappedMonths} months` : ""}
${totalRevenue ? `- TOTAL CONTRACT REVENUE = £${monthlyRevNum.toFixed(2)} × ${cappedMonths} months = £${totalRevenue.toFixed(2)}` : ""}
- When comparing "total invoiced" to revenue, use the TOTAL CONTRACT REVENUE above, not the monthly figure
- Do NOT include placeholder slots (blank reference or MANUAL-INV) in the "total invoiced" calculation`;
            }

            // Send to Claude with job details and retainer context
            console.log(`  No VAT scenario, diff £${amtDiff.toFixed(2)} — sending to Claude with job details`);
            const invAmtPrompt = `You are analysing an invoice amount mismatch between the accounting system and the dashboard.

INVOICE FROM ACCOUNTING SYSTEM:
• Invoice #: ${invoiceNo}
• Client: ${invClient}
• Job: ${invJob}
• Gross amount (incl VAT): £${grossAmount.toFixed(2)}
• Total excl VAT: £${totalExclVAT.toFixed(2)}
• VAT included: £${vatIncluded.toFixed(2)}
• Sent date: ${invSentDate}
• Status: ${invStatus}
• Dashboard shows total: £${dashboardTotal.toFixed(2)}

MATCHED JOB IN CONFIRMED TAB (Slot ${matchedSlot}):
${jobSummary}
${retainerContext}
The VAT scenarios (invoice with VAT/job no VAT, and invoice without VAT/job with VAT) have already been checked and ruled out.
Rounding differences (< £1.00) have also been ruled out — this is a genuine amount discrepancy of £${amtDiff.toFixed(2)}.

YOUR TASK:
Identify the most likely cause of the amount mismatch and suggest what action to take. Consider:
- Partial payments
- Currency issues
- Incorrect invoice amount entered in dashboard
- Revenue amount needs updating
${isRetainer ? "- For retainers: use the TOTAL CONTRACT REVENUE (monthly × capped months) when assessing over/under-invoicing. Do NOT include placeholder slots in the total invoiced figure." : ""}

Format as JSON array:
[{
  "optionId": 1,
  "title": "Brief description of the issue and recommended action",
  "matchType": "info",
  "explanation": "Detailed explanation for the user",
  "recommendedActions": ["Action 1", "Action 2"]
}]

Return ONLY JSON, no other text.`;

            const invAmtMessage = await anthropic.messages.create({
              model: "claude-sonnet-4-20250514",
              max_tokens: 1000,
              messages: [{ role: "user", content: invAmtPrompt }],
            });

            let invAmtOptions = [];
            const invAmtText = invAmtMessage.content[0]?.type === "text" ? invAmtMessage.content[0].text : "";
            const invAmtCleaned = invAmtText.replace(/```json/g, "").replace(/```/g, "").trim();
            try {
              invAmtOptions = JSON.parse(invAmtCleaned);
              if (!Array.isArray(invAmtOptions)) invAmtOptions = [invAmtOptions];
            } catch (e) {
              console.error(`  ⚠️ Could not parse Claude response for inv amt mismatch`);
              invAmtOptions = [{ optionId: 1, title: "MANUAL INVESTIGATION REQUIRED", matchType: "info",
                matchAnalysis: { matchConfidence: "N/A", reasonForChoice: invAmtText, discrepancies: `Invoice #${invoiceNo} amount mismatch` },
                recommendedActions: [`Review invoice #${invoiceNo} manually`] }];
            }
            return res.status(200).json({ success: true, options: invAmtOptions, alertId: alert.rowNumber });
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
        
        // Build table for Claude
        const confirmedTabTable = activeData
          .map((row, idx) => {
            const client = row[0] || '';
            const jobName = row[1] || '';
            const projectCode = row[2] || '';
            const revenue = row[32] !== undefined ? row[32] : '';
            const vat = row[34] || '';
            const projType = row[35] || '';
            const startDate = row[37] || '';
            const endDate = row[38] || '';
            
            // Invoice slot column layout (0-indexed):
            // Slot 1: Amount=AP(41), Ref=AQ(42), SentDate=AR(43), DaysToPay=AS(44), Status=AT(45)
            // Slot 2: Amount=AW(48), Ref=AX(49), SentDate=AY(50), DaysToPay=AZ(51), Status=BA(52)
            // Slot 3: Amount=BD(55), Ref=BE(56), SentDate=BF(57), DaysToPay=BG(58), Status=BH(59)

            const formatSlot = (amtIdx, refIdx, sentIdx, daysIdx, statusIdx) => {
              const ref = row[refIdx] || '';
              const amt = row[amtIdx] !== undefined ? row[amtIdx] : '';
              const sent = row[sentIdx] || '';
              const days = row[daysIdx] !== undefined ? row[daysIdx] : '';
              const stat = row[statusIdx] || '';
              if (!ref && !amt) return '(empty)';
              let label;
              if (ref.toString().toUpperCase().includes('MANUAL-INV')) {
                label = `${ref} [MANUAL ONLY]`;
              } else if (!ref && amt) {
                label = `[PLACEHOLDER — blank ref]`;
              } else {
                label = ref;
              }
              return `${label} £${amt}${sent ? ' sent:' + sent : ''}${days ? ' days:' + days : ''}${stat ? ' status:' + stat : ''}`;
            };

            const inv1 = formatSlot(41, 42, 43, 44, 45);
            const inv2 = formatSlot(48, 49, 50, 51, 52);
            const inv3 = formatSlot(55, 56, 57, 58, 59);
            
            return `Row ${idx + 1} | ${client} | ${jobName} | Code: ${projectCode} | Revenue: ${revenue} | VAT: ${vat} | Type: ${projType} | Start: ${startDate} | End: ${endDate} | Inv1: ${inv1} | Inv2: ${inv2} | Inv3: ${inv3}`;
          })
          .join('\n');
        
        console.log(`\n📊 Confirmed Tab Data (first 1000 chars):\n${confirmedTabTable.substring(0, 1000)}...`);
        
        // Read AIKnowledgeBase for context
        console.log(`  📚 Reading AIKnowledgeBase...`);
        let knowledgeBase = [];
        if (req.body.automationCommanderSheetId) {
          knowledgeBase = await readAIKnowledgeBase(sheets, req.body.automationCommanderSheetId);
        } else {
          console.log(`  ⚠️ No automationCommanderSheetId in request body, skipping AIKnowledgeBase`);
        }
        
        // Get tolerance values from DataChgAlert
        const tolerances = await getToleranceValues(sheets, alert.masterSheetId || alert.clientId);
        
        // Build knowledge base context for Claude
        let kbRules = "";
        if (knowledgeBase && knowledgeBase.length > 0) {
          kbRules = knowledgeBase
            .filter(row => row[0] === "INVOICE_MATCHING")
            .map(row => `- **${row[2]}** (${row[1]}): ${row[3]}`)
            .join("\n");
          console.log(`  ✓ Found ${knowledgeBase.filter(row => row[0] === "INVOICE_MATCHING").length} INVOICE_MATCHING rules`);
        } else {
          console.log(`  ⚠️ No AIKnowledgeBase rules found`);
        }
        
        // Extract invoice details
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
              // Handle formats like "20-Mar-26", "20/03/2026", "2026-03-20"
              const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
              const parts = d.split(/[-\/]/);
              if (parts.length === 3) {
                // dd-Mon-yy or dd-Mon-yyyy
                const monthNum = months[parts[1]?.toLowerCase()?.substring(0,3)];
                if (monthNum !== undefined) {
                  const year = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
                  return new Date(year, monthNum, parseInt(parts[0]));
                }
                // yyyy-mm-dd
                if (parts[0].length === 4) return new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
                // dd/mm/yyyy
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

        // Determine which discrepancy types are present from InvComp flags (S:Y, indices 0-6)
        // S(0)=missing invoice, T(1)=client mismatch, U(2)=amount mismatch,
        // V(3)=sent date mismatch, X(5)=date paid mismatch, Y(6)=status mismatch
        const invFlagsForPrompt = alert.data.flags || [];
        const discrepancyTypes = [];
        if (String(invFlagsForPrompt[0] || "").trim() === "1") discrepancyTypes.push("MISSING INVOICE — invoice exists in accounting but has no match in the Confirmed tab");
        if (String(invFlagsForPrompt[1] || "").trim() === "1") discrepancyTypes.push("CLIENT MISMATCH — the client name on the invoice differs from the job");
        if (String(invFlagsForPrompt[2] || "").trim() === "1") discrepancyTypes.push("AMOUNT MISMATCH — the invoice amount differs from what is recorded in the Confirmed tab");
        if (String(invFlagsForPrompt[3] || "").trim() === "1") discrepancyTypes.push("SENT DATE MISMATCH — the sent date differs from what is recorded in the Confirmed tab");
        if (String(invFlagsForPrompt[5] || "").trim() === "1") discrepancyTypes.push("DATE PAID MISMATCH — the date paid differs from what is recorded in the Confirmed tab");
        if (String(invFlagsForPrompt[6] || "").trim() === "1") discrepancyTypes.push("STATUS MISMATCH — the status differs from what is recorded in the Confirmed tab");
        const discrepancySummary = discrepancyTypes.length > 0
          ? discrepancyTypes.join("\n• ")
          : "UNSPECIFIED DISCREPANCY";

        // Build Claude prompt with knowledge base and tolerances
        const prompt = `You are a financial advisor helping to resolve an invoice discrepancy. Analyze the invoice against the Confirmed tab data and suggest the best course of action.

INVOICE DETAILS (from accounting system):
• Reference: ${invoiceRef}
• Amount: £${invoiceAmount.toFixed(2)}
• Client: ${invoiceClient}
• Job Description: ${invoiceJob}
• Sent: ${sentDate}
• Status: ${invoiceStatus}${datePaid ? `\n• Date Paid: ${datePaid}` : ''}

DISCREPANCY TYPE(S) FLAGGED:
• ${discrepancySummary}

CONFIRMED TAB DATA (All non-blank rows):
${confirmedTabTable}

MATCHING RULES & TOLERANCES:
${kbRules || "- Default matching rules apply"}
- Date tolerance: ±${tolerances.invoiceMonthsTolerance} months
${SHEET_STRUCTURE_BLOCK}

**Invoice Slot Column Reference (Confirmed tab):**
| Slot | Amount | Reference | Sent Date | Days to Pay | Status |
|------|--------|-----------|-----------|-------------|--------|
|  1   |   AP   |    AQ     |    AR     |     AS      |   AT   |
|  2   |   AW   |    AX     |    AY     |     AZ      |   BA   |
|  3   |   BD   |    BE     |    BF     |     BG      |   BH   |

**Placeholder invoices:**
A placeholder slot has an AMOUNT set but a BLANK reference (or a reference beginning with MANUAL-INV).
- Blank-reference placeholders: Claude CAN adjust or clear these as part of recommendations
- MANUAL-INV references (shown as [MANUAL ONLY]): These are managed by automation elsewhere — do NOT modify them
- CRITICAL RULE: After all recommended writes are applied, the total invoiced (sum of all non-MANUAL-ONLY slot amounts) must equal the job revenue, OR a documented gap must remain for automation to fill. It must NEVER exceed revenue.
- "Clear a slot" means writing "" to all 5 fields of that slot (Amount, Reference, Sent Date, Days to Pay, Status)
- When placing a new invoice causes the total to exceed revenue, clear blank-reference placeholder slots (starting from the last slot and working backwards) until the total balances

**How to Calculate Total Invoiced and Remaining:**
1. Find the job's parent row (has Revenue value)
2. Find all child rows (same Client + Job name, no Revenue)
3. Sum amounts across ALL slots on parent AND child rows
4. EXCLUDE [MANUAL ONLY] slots from the total (they're planned but automation-managed)
5. INCLUDE blank-reference placeholder amounts in the total (they represent planned invoices)
6. Remaining to Invoice = Revenue − (sum of all non-MANUAL-ONLY invoice amounts)

**Days to Pay value to use:** ${daysToPayValue}
(${invoiceStatus.toLowerCase() === 'paid' && datePaid ? `Calculated from sent date ${sentDate} to paid date ${datePaid}` : `Default from DataChgAlert!B52`})

---

**YOUR TASK — depends on the discrepancy type(s) flagged above:**

**IF MISSING INVOICE:**
1. Search the Confirmed tab for a job matching this invoice by client name and/or job description
2. TWO OUTCOMES — one of these MUST always be suggested:
   a) **Job found**: Place the invoice in the correct slot (see slot rules below)
   b) **No job found**: Suggest creating a new job row (matchType: "create_new") — this is ALWAYS a valid option when no match exists. Never say "no action possible" — creating a new job IS the action.
3. For slot placement (when job found):
   - A "real" invoice slot = has a reference that does NOT start with MANUAL-INV and is not blank
   - A "non-real" slot = empty OR has a MANUAL-INV reference (automation-managed placeholder)
   - ALWAYS place the new invoice in the FIRST non-real slot (slot 1 > slot 2 > slot 3)
   - Do NOT skip a MANUAL-INV slot in favour of an empty slot — MANUAL-INV slots are available for real invoices
   - Example: if slot 1 = real invoice, slot 2 = MANUAL-INV, slot 3 = empty → place in slot 2
   - Example: if slot 1 = MANUAL-INV, slot 2 = MANUAL-INV, slot 3 = empty → place in slot 1
   - Only write to the target slot — leave other MANUAL-INV slots for automation to adjust
4. After placing the invoice, calculate the new total invoiced:
   - Count all REAL invoice slots (non-MANUAL-INV, non-blank) including the new one
   - EXCLUDE all [MANUAL ONLY] slots — automation will adjust these to cover any remaining gap
   - EXCLUDE blank slots
   - A remaining gap covered by MANUAL-INV slots is NOT a problem — do NOT suggest a revenue change for this reason
   - Only suggest a revenue change if the real invoices ALONE exceed the current job revenue
5. Compare the new total (real invoices only) to the job revenue:
   - If new total > revenue: revenue needs updating — suggest updating revenue to match
   - If new total ≤ revenue: clean — automation will handle remaining MANUAL-INV slots, no revenue change needed
6. ALWAYS show the full arithmetic in facts: real invoice slot breakdown → new real total → vs revenue

**IF AMOUNT MISMATCH:**
1. Find the existing slot containing this invoice reference (${invoiceRef}) in the Confirmed tab
2. Calculate what the NEW amount (£${invoiceAmount.toFixed(2)}) does to the total invoiced vs revenue:
   - New total invoiced = (sum of all other slots) + £${invoiceAmount.toFixed(2)}
   - Compare to job revenue
3. If new total > revenue: This is the final invoice and the revenue needs updating. Suggest updating the amount AND flag a revenue increase. If another option exists, also suggest it.
4. If new total < revenue: A gap is created. If blank-reference placeholders exist, suggest adjusting one to cover the gap. If no placeholders exist, note that the automation will handle creating a new placeholder — do NOT propose any placeholder creation yourself.
5. If new total = revenue: Clean solution — just update the amount.
6. Simply updating the amount: write the new amount to the correct cell (same slot, same row, just update the amount column)
7. For the revenue increase option: also write the new revenue to column AG of the parent row

**FOR ALL DISCREPANCY TYPES:**
- Suggest 3 GENUINELY DIFFERENT options where possible
- If only 1-2 meaningful options exist, don't invent extras
- Always show the full arithmetic: current total invoiced → new total → vs revenue

**CRITICAL: recommendedActions format:**

Item 1 — Plain English summary (one sentence describing what will happen)
   - For missing invoice placements: MUST state the slot number explicitly, e.g. "Place invoice 1162 (£3,078.70) in invoice slot 1 of the Peoples Health Trust project, replacing the MANUAL-INV placeholder"
   - For amount updates: state the slot number and old/new amounts

Item 2 — Exact cell writes only:
"Write [value] to [COL][ROW] ([field name]), write [value] to [COL][ROW] ([field name]), ..."
- To CLEAR a slot field: write "" to [COL][ROW]
- Include ALL writes including clears for superseded placeholders
- For revenue updates: write [amount] to AG[parentRow] (revenue)

Use EXACT column letters from the slot reference table above.

Format as JSON array:
[{
  "optionId": 1,
  "title": "Brief descriptive title",
  "jobRow": 52,
  "jobName": "Job Name",
  "facts": {
    "jobType": "Project or Retainer",
    "totalRevenue": 15950,
    "startDate": "3-Mar-26",
    "endDate": "31-Aug-26",
    "existingInvoices": "Description of all existing invoice slots including placeholders",
    "currentTotalInvoiced": 13700,
    "newTotalIfAccepted": 15950,
    "remainingAfterAccepting": 0,
    "invoiceMatchStatus": "EXACT MATCH / AMOUNT MISMATCH / etc",
    "placeholderImpact": "Description of any placeholder slots being cleared or adjusted",
    "revenueImpact": "No change / Suggest increasing revenue to X / Gap created — automation will handle"
  },
  "recommendedActions": [
    "Plain English summary",
    "Write [value] to [CELL] ([field]), write [value] to [CELL] ([field]), ..."
  ]
}]

Return ONLY JSON, no other text.`;

        const message = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          messages: [
            { role: "user", content: prompt }
          ],
        });

        let options = [];
        const responseText = message.content[0].type === "text" ? message.content[0].text : "";
        const cleanedText = responseText
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();
        
        try {
          options = JSON.parse(cleanedText);
          if (!Array.isArray(options)) options = [options];
          console.log(`  ✅ Parsed ${options.length} options from Claude`);
        } catch (e) {
          console.error(`  ⚠️ Could not parse Claude response as JSON`);
          options = [{ summary: responseText }];
        }

        // Write to AlertMemory cache
        const invSummary = alert.summary?.summary || `Invoice ${alert.summary?.invoiceNo || ""} £${alert.summary?.amount || ""}`;
        if (memoryRow) {
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
            ...memoryRow,
            cachedOptionsJSON: JSON.stringify(options),
          });
        } else {
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
            fingerprintHash,
            alertType: "invoice",
            clientName: alert.clientName || "",
            alertSummary: invSummary,
            cachedOptionsJSON: JSON.stringify(options),
            status: "cached",
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
        // For create_new, Claude specifies column letters but no row number (since
        // the next available row is unknown at analysis time). Find the next blank
        // row in the Confirmed tab and write to it.
        if (option.matchType === "create_new") {
          console.log(`  → Create new job in Confirmed tab`);

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

          // Parse "write VALUE to Col X" from recommendedActions
          const createCellUpdates = [];
          for (const actionString of (option.recommendedActions || [])) {
            const regex = /write\s+(.+?)\s+to\s+Col\s+([A-Z]{1,3})(?:\s*[,(]|$)/gi;
            let match;
            while ((match = regex.exec(actionString)) !== null) {
              const value = match[1].trim();
              const col   = match[2].trim();
              createCellUpdates.push({ cell: `${col}${newRow}`, value });
            }
          }

          console.log(`  Create new job cell updates: ${JSON.stringify(createCellUpdates)}`);

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

          // Update AlertMemory
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
                const value = match[1].trim();
                const cell = match[2];
                if (cell) cellUpdates.push({ cell, value });
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

          const batchRequest = {
            data: cellUpdates.map(({ cell, value }) => ({
              range: `${writeTab}!${cell}`,
              values: [[sanitiseValue(value)]],
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

        // Fresh read of the tab
        const tabResp = await sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${tabName}!A1:CR2000`,
          valueRenderOption: "UNFORMATTED_VALUE",
        });
        const tabRows = tabResp.data.values || [];

        // Find parent row by client + job name match (never by cached row number)
        const targetClient = (option.matchingDetails?.unmatchedJobSummary?.clientName || "").trim().toLowerCase();
        const targetJob = (option.jobName || "").trim().toLowerCase();

        let parentRowIdx = -1;
        for (let i = 1; i < tabRows.length; i++) {
          const r = tabRows[i] || [];
          const rClient = String(r[0] || "").trim().toLowerCase();
          const rJob = String(r[1] || "").trim().toLowerCase();
          if (rClient === targetClient && rJob === targetJob) {
            parentRowIdx = i;
            break;
          }
        }

        if (parentRowIdx === -1) {
          return res.status(404).json({
            success: false,
            error: `Job "${option.jobName}" not found in ${tabName} tab — it may have already been deleted or the sheet has changed.`,
          });
        }

        const parentSheetRow = parentRowIdx + 1; // 1-indexed
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

        // Build column ranges to blank: A:G (1-7), AG:AM (33-39), AP:BH (42-60), BX:CR (76-96)
        // In A1 notation: colNum is 1-indexed
        const colRanges = [
          [1, 7],    // A:G
          [33, 39],  // AG:AM
          [42, 60],  // AP:BH
          [76, 96],  // BX:CR
        ];

        const blankData = [];
        for (const rowIdx of rowsToBlank) {
          const sheetRow = rowIdx + 1;
          for (const [startCol, endCol] of colRanges) {
            const startColLetter = colIndexToLetter(startCol);
            const endColLetter = colIndexToLetter(endCol);
            const numCols = endCol - startCol + 1;
            blankData.push({
              range: `${tabName}!${startColLetter}${sheetRow}:${endColLetter}${sheetRow}`,
              values: [Array(numCols).fill("")],
            });
          }
        }

        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: clientSheetId,
          requestBody: { valueInputOption: "RAW", data: blankData },
        });
        console.log(`  ✅ Blanked ${rowsToBlank.length} rows (${blankData.length} ranges)`);

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
        // Search the monthly Log tabs in the Automation Commander sheet (back 90 days max).
        // Each row: col A=timestamp, col B=client name, clear columns:
        //   BJ(61) = clear invoice flags (also clears retainerInvoicesCreated)
        //   BL(63) = clear copied-to-confirmed flags
        //   BO(66) = clear ALL flags
        // Find the most recent row for this client where the relevant clear column = TRUE.

        const clearColForFlag = {
          crmCopiedConfChecked:   [63, 66], // BL or BO
          crmCopiedConfUnchecked: [63, 66], // BL or BO
          retainerInvoicesCreated: [61, 66], // BJ or BO
        };
        const clearCols = clearColForFlag[flagType] || [66];

        // Generate monthly tab names for the last 90 days
        const monthTabNames = [];
        const now = new Date();
        for (let m = 0; m < 4; m++) { // up to 4 months covers 90 days
          const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
          const mon = d.toLocaleString("en-GB", { month: "short" }); // "Mar", "Feb" etc.
          const yr = String(d.getFullYear()).slice(2); // "26"
          monthTabNames.push(`Log-${mon}${yr}`);
        }
        console.log(`  📅 Checking log tabs: ${monthTabNames.join(", ")}`);

        let windowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); // default: 90 days ago
        let foundClear = false;

        for (const tabName of monthTabNames) {
          if (foundClear) break;
          try {
            // Use UNFORMATTED_VALUE to get raw serial numbers for dates (col A)
            // This avoids locale-dependent date string parsing (e.g. "8/1/2026" being
            // ambiguous between Jan 8 and Aug 1 depending on locale)
            const logResp = await sheets.spreadsheets.values.get({
              spreadsheetId: acIdClean,
              range: `${tabName}!A3:BP30000`,
              valueRenderOption: "UNFORMATTED_VALUE",
            });
            const logRows = logResp.data.values || [];
            // Helper: convert Sheets serial number to JS Date
            // Sheets epoch: Dec 30 1899. Serial 1 = Jan 1 1900.
            const serialToDate = (serial) => {
              if (!serial || typeof serial !== 'number') return null;
              return new Date((serial - 25569) * 86400 * 1000);
            };
            // Search newest-first
            for (let i = logRows.length - 1; i >= 0; i--) {
              const row = logRows[i];
              const rowClient = String(row[1] || "").trim(); // col B = client name
              if (rowClient !== clientName.trim()) continue;
              const wasCleared = clearCols.some(colIdx => {
                const val = row[colIdx];
                return val && String(val).toUpperCase() === "TRUE";
              });
              if (wasCleared) {
                const ts = serialToDate(row[0]);
                if (ts && !isNaN(ts.getTime())) {
                  windowStart = ts;
                  foundClear = true;
                  console.log(`  ✓ Flag last cleared at ${ts.toISOString()} (${tabName})`);
                  break;
                }
              }
            }
          } catch (e) {
            console.log(`  ⚠ Could not read tab ${tabName}: ${e.message}`);
          }
        }
        if (!foundClear) {
          console.log(`  ℹ No clear event found — using 90-day window from ${windowStart.toISOString()}`);
        }

        // ── Step 2: Read AutoLog and filter to entries after windowStart ──────────
        // AutoLog col A=Timestamp, B=Category, C=Summary, D=Details
        console.log(`  📖 Reading AutoLog from master sheet...`);
        const autoLogResp = await sheets.spreadsheets.values.get({
          spreadsheetId: masterSheetIdClean,
          range: "AutoLog!A2:D2000",
        });
        const allAutoLogRows = autoLogResp.data.values || [];
        // Filter to entries after windowStart
        const autoLogRows = allAutoLogRows.filter(row => {
          const ts = row[0] ? new Date(row[0]) : null;
          return ts && !isNaN(ts.getTime()) && ts > windowStart;
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
                  const rowMatch = line.match(/Row\s*\d+,\s*([^|]*)/);
                  const clientParsed = rowMatch ? rowMatch[1].trim() : "";
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
                  if (jobName) affectedJobs.push({ jobName, clientParsed, logTimestamp: String(entry[0] || "") });
                }
              }
            }
            // Deduplicate by jobName
            const seen = new Set();
            const deduped = affectedJobs.filter(j => {
              if (seen.has(j.jobName)) return false;
              seen.add(j.jobName);
              return true;
            });
            affectedJobs.length = 0;
            affectedJobs.push(...deduped);
            console.log(`  ✓ Parsed ${affectedJobs.length} affected jobs: ${JSON.stringify(affectedJobs)}`);
          } else {
            // UNchecked: look at most recent entry only (same logic as before)
            if (relevantEntries.length > 0) {
              const mostRecent = relevantEntries[0];
              const details = String(mostRecent[3] || "");
              const uncheckedPattern = new RegExp("Row\\s*(\\d+),\\s*[^|]*\\|\\s*([^-\\n]+).*?Copied Status:.*?->\\s*['\"]?No['\"]?", "gi");
              let m;
              while ((m = uncheckedPattern.exec(details)) !== null) {
                affectedJobs.push({ pipelineRow: parseInt(m[1], 10), jobName: m[2].trim(), logTimestamp: String(mostRecent[0] || "") });
              }
            }
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
              range: "Pipeline!A6:DE500",
            });
            const pipelineRows = pipelineResp.data.values || [];

            const confirmedResp = await sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Confirmed!A1:E500",
            });
            const confirmedRows = confirmedResp.data.values || [];

            for (const job of affectedJobs) {
              const checks = [];
              let allOk = true;

              if (expectCopied) {
                // CRITICAL CHECK: Pipeline col DD must be "Yes"
                // Pipeline data: col A(0)=Client, B(1)=JobName, C(2)=ProjectCode, DD(107)=CopiedToConf?
                // Pipeline rows start at row 6 in the sheet; our slice starts at A6 so index 0 = row 6
                let pipelineJob = null;
                const jobNameLower = job.jobName.toLowerCase();
                for (const pr of pipelineRows) {
                  const pJobName = String(pr[1] || "").trim(); // col B = job name
                  if (pJobName && pJobName.toLowerCase() === jobNameLower) {
                    pipelineJob = {
                      clientName: String(pr[0] || "").trim(),
                      jobName: pJobName,
                      projectCode: String(pr[2] || "").trim(),
                      copiedToConf: String(pr[107] || "").trim(),
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
                  checks.push({
                    ok: ddOk,
                    message: ddOk
                      ? `✓ Pipeline col DD ("Copied to confirmed?"): Yes`
                      : `✗ CRITICAL: Pipeline col DD is "${pipelineJob.copiedToConf}" — expected Yes. The copy may not have registered correctly.`,
                  });
                  if (!ddOk) allOk = false;
                }

                // Secondary check: job exists in Confirmed — search by job name (and project code if available)
                // Row numbers are unreliable (rows can shift), so we match on col B (job name) and optionally col C (project code)
                const pipelineProjectCode = pipelineJob?.projectCode || "";
                let confirmedMatch = null;
                for (const cr of confirmedRows) {
                  const crJobName = String(cr[1] || "").trim();
                  const crProjectCode = String(cr[2] || "").trim();
                  if (crJobName.toLowerCase() === jobNameLower) {
                    if (pipelineProjectCode && crProjectCode && crProjectCode !== pipelineProjectCode) continue;
                    confirmedMatch = { jobName: crJobName, projectCode: crProjectCode, clientName: String(cr[0] || "").trim() };
                    break;
                  }
                }
                const confExists = confirmedMatch !== null;
                checks.push({
                  ok: confExists,
                  message: confExists
                    ? `✓ Confirmed tab: "${confirmedMatch.jobName}"${confirmedMatch.projectCode ? ` (${confirmedMatch.projectCode})` : ""} found`
                    : `✗ Confirmed tab: job "${job.jobName}" not found — copy may have failed`,
                });
                if (!confExists) allOk = false;

              } else {
                // UNchecked: Pipeline DD should be No/blank, job should NOT be in Confirmed
                let pipelineJob = null;
                for (const pr of pipelineRows) {
                  const pJobName = String(pr[1] || "").trim(); // col B
                  if (pJobName && pJobName.toLowerCase() === job.jobName.toLowerCase()) {
                    pipelineJob = { copiedToConf: String(pr[107] || "").trim() };
                    break;
                  }
                }
                if (pipelineJob) {
                  const ddVal = pipelineJob.copiedToConf.toLowerCase();
                  const ddOk = ddVal === "no" || ddVal === "" || ddVal === "false";
                  checks.push({
                    ok: ddOk,
                    message: ddOk
                      ? `✓ Pipeline col DD: "${pipelineJob.copiedToConf}" — No/blank (correct)`
                      : `✗ CRITICAL: Pipeline col DD is "${pipelineJob.copiedToConf}" — expected No or blank`,
                  });
                  if (!ddOk) allOk = false;
                }

                const inConfirmed = confirmedRows.some(cr => String(cr[1] || "").trim() === job.jobName);
                checks.push({
                  ok: !inConfirmed,
                  message: !inConfirmed
                    ? `✓ Confirmed tab: job not present (correct)`
                    : `✗ "${job.jobName}" still exists in Confirmed — should have been removed`,
                });
                if (inConfirmed) allOk = false;
              }

              results.push({
                jobName: job.jobName || `(${job.clientParsed} — job name not in log)`,
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
            return details.includes("Retainer") && details.includes("Added") && details.includes("invoice rows");
          });
          console.log(`  ✓ Found ${retainerLogEntries.length} retainer creation entries in window`);
          for (const entry of retainerLogEntries) {
            console.log(`    [${entry[0]}] Details="${String(entry[3]||"").slice(0, 400)}"`);
          }

          if (retainerLogEntries.length === 0) {
            results.push({
              status: "info",
              message: `No retainer invoice creation entries found in AutoLog since flag was last cleared.`,
            });
          } else {
            // Parse all entries in the window
            const affectedRetainerJobs = [];
            for (const entry of retainerLogEntries) {
              const details = String(entry[3] || "");
              // Capture client name from the log as well as job name — sheetRow is NOT used for lookup
              // since rows in Confirmed can shift after the log was written
              const retainerJobPattern = /Row\s+(\d+),\s+([^,]+),\s+([^:]+):\s+Added\s+\d+\s+invoice rows/gi;
              let m;
              while ((m = retainerJobPattern.exec(details)) !== null) {
                affectedRetainerJobs.push({
                  logSheetRow: parseInt(m[1], 10), // kept for display only, not for lookup
                  clientNameFromLog: m[2].trim(),
                  jobName: m[3].trim(),
                  logTimestamp: String(entry[0] || "")
                });
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
              range: "Confirmed!A1:BH1000",
            });
            const retConfirmedRows = retConfirmedResp.data.values || [];
            const retainerChecks = [];

            for (const job of dedupedJobs) {
              // Find the parent row by matching client name AND job name — never by row number
              const jobNameLower = job.jobName.toLowerCase();
              const clientLower = job.clientNameFromLog.toLowerCase();
              let parentRowIdx = -1;
              for (let ri = 0; ri < retConfirmedRows.length; ri++) {
                const r = retConfirmedRows[ri];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob = String(r[1] || "").trim().toLowerCase();
                if (rClient === clientLower && rJob === jobNameLower) {
                  parentRowIdx = ri;
                  break;
                }
              }

              if (parentRowIdx === -1) {
                // Not found by name — report clearly
                retainerChecks.push({
                  jobName: job.jobName,
                  clientName: job.clientNameFromLog,
                  status: "issue",
                  checks: [{ ok: false, message: `✗ Job "${job.jobName}" (${job.clientNameFromLog}) not found in Confirmed tab` }],
                });
                continue;
              }

              const parentRow = retConfirmedRows[parentRowIdx];
              const clientN = String(parentRow[0] || "").trim();
              const jobName = String(parentRow[1] || "").trim();
              const projectCode = String(parentRow[2] || "").trim();
              const revenue = parentRow[32];
              const startRaw = parentRow[37];
              const endRaw = parentRow[38];
              const confirmedSheetRow = parentRowIdx + 1; // 1-indexed for display
              console.log(`  Found "${jobName}" (${clientN}) at Confirmed row ${confirmedSheetRow}: start="${startRaw}", end="${endRaw}"`);

              // Collect child rows — start immediately after the parent row we found by name
              // Child row: same client (col A), same job name (col B), no revenue (col AG=32),
              // no direct costs (col AH=33), no start date (col AL=37)
              const childRows = [];
              let ci = parentRowIdx + 1;
              while (ci < retConfirmedRows.length) {
                const next = retConfirmedRows[ci] || [];
                const nc = String(next[0] || "").trim();
                const nj = String(next[1] || "").trim();
                if (nc === clientN && nj === jobName && !next[32] && !next[33] && !next[37]) {
                  childRows.push({ row: next, sheetRow: ci + 1 });
                  ci++;
                } else { break; }
              }

              const monthlyRevenue = parseFloat(String(revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
              const parseDate = (v) => {
                if (!v) return null;
                if (v instanceof Date) return v;
                const d = new Date(v);
                if (!isNaN(d.getTime())) return d;
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

              const monthsDiff = (endDate.getFullYear() - startDate.getFullYear()) * 12
                + (endDate.getMonth() - startDate.getMonth()) + 1;
              const expectedChildRows = Math.min(Math.ceil(monthsDiff / periodMonths), 18);
              const actualChildRows = childRows.length;
              const fmt = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });

              const durationOk = actualChildRows >= expectedChildRows;
              checks.push({ ok: true, message: `Duration: ${fmt(startDate)} → ${fmt(endDate)} (${monthsDiff} months, ${periodLabel})` });
              checks.push({
                ok: durationOk,
                message: `Child rows: ${actualChildRows} found, ${expectedChildRows} expected — ` + (durationOk ? "✓ full coverage" : `✗ ${expectedChildRows - actualChildRows} row(s) missing`),
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
                status: durationOk && allHaveInvoice ? "ok" : "issue",
                periodLabel, checks,
              });
            }

            results.push(...retainerChecks);
          }

        } // end retainerInvoicesCreated

        const overallOk = results.every(r => r.status === "ok" || r.status === "info");
        console.log(`  ✅ Analysis complete: ${results.length} items, overall ${overallOk ? "OK" : "ISSUES FOUND"}`);
        return res.status(200).json({ success: true, flagType, results, overallOk });

      } catch (err) {
        console.error(`❌ Error analyzing non-actionable flag:`, err);
        return res.status(500).json({ success: false, error: `Analysis failed: ${err.message}` });
      }

    } else if (action === "clear_flags") {

      // Clear flags by writing directly to DataChgAlert in the client's Master Sheet.
      // flagsToClear is an array of: "invoice", "crm", "expense" (any combination).
      // Each maps to a specific cell in DataChgAlert:
      //   invoice → AS2
      //   crm     → AT2 + AU2
      //   expense → AV2
      const { masterSheetId, automationCommanderSheetId, flagsToClear, clientName } = req.body;
      
      if (!masterSheetId || !automationCommanderSheetId || !flagsToClear || flagsToClear.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: "Missing masterSheetId, automationCommanderSheetId, or flagsToClear" 
        });
      }

      try {
        console.log(`\n🔄 Clearing flags for client: ${masterSheetId}`);
        console.log(`   Flag groups to clear: ${flagsToClear.join(", ")}`);
        
        const sheets = await getSheetsClient();

        // Open the Master Sheet and find the DataChgAlert tab
        // masterSheetId may be a full URL or a bare sheet ID
        const masterSheetIdClean = extractSheetIdFromUrl(masterSheetId) || masterSheetId;

        const masterSS = await sheets.spreadsheets.get({
          spreadsheetId: masterSheetIdClean,
        });

        // Find the DataChgAlert sheet
        const dataChgAlertSheet = masterSS.data.sheets?.find(
          s => s.properties.title === "DataChgAlert"
        );
        if (!dataChgAlertSheet) {
          return res.status(400).json({
            success: false,
            error: "DataChgAlert tab not found in Master Sheet",
          });
        }

        // Build the list of cells to write TRUE to in DataChgAlert
        const cellsToWrite = [];
        if (flagsToClear.includes("invoice")) {
          cellsToWrite.push("DataChgAlert!AS2");
        }
        if (flagsToClear.includes("crm")) {
          cellsToWrite.push("DataChgAlert!AT2");
          cellsToWrite.push("DataChgAlert!AU2");
        }
        if (flagsToClear.includes("expense")) {
          cellsToWrite.push("DataChgAlert!AV2");
        }

        if (cellsToWrite.length === 0) {
          return res.status(400).json({ success: false, error: "No valid flag groups specified" });
        }

        // Batch write TRUE to all required cells
        console.log(`  Writing TRUE to: ${cellsToWrite.join(", ")}`);
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: masterSheetIdClean,
          requestBody: {
            valueInputOption: "RAW",
            data: cellsToWrite.map(range => ({
              range,
              values: [["TRUE"]],
            })),
          },
        });

        console.log(`  ✅ Flags cleared successfully`);

        // Also zero out the flag columns in AutoUpdates (Automation Commander) immediately.
        // clear_flags writes to DataChgAlert which signals the GAS to clear AutoUpdates,
        // but GAS only runs every 30 mins. If the user clicks Refresh before then,
        // start_triage re-reads AutoUpdates and sees the flags as still active.
        // Writing FALSE directly here ensures Refresh sees the correct state immediately.
        if (clientName && automationCommanderSheetId) {
          try {
            const acIdClean = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;
            // Map flag groups to their AutoUpdates columns (A=1, CW=101, FA=157, etc.)
            const FLAG_GROUP_COLUMNS = {
              invoice: ["CW", "DD", "HE"],   // invoiceDashboardDiscr, invoiceAppDiscr, invoiceStaleUnsentChanges
              crm:     ["DK", "DR", "DY", "EF", "EM", "ET", "FA", "FH", "FO"], // all CRM flags
              expense: ["GC", "GJ", "GQ", "GX"], // all expense flags
            };
            // Find the client row in AutoUpdates (col A = client name, starting row 2)
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
            if (clientRowNum !== -1) {
              const colsToZero = flagsToClear.flatMap(group => FLAG_GROUP_COLUMNS[group] || []);
              if (colsToZero.length > 0) {
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
                console.log(`  ✅ AutoUpdates zeroed for ${clientName} row ${clientRowNum}: ${colsToZero.join(", ")}`);
              }
            } else {
              console.log(`  ⚠ Client "${clientName}" not found in AutoUpdates — skipping AutoUpdates zero`);
            }
          } catch (auErr) {
            console.error(`  ⚠ Failed to zero AutoUpdates: ${auErr.message}`);
            // Non-fatal — DataChgAlert write was the important part
          }
        }
        
        return res.status(200).json({
          success: true,
          message: `Cleared: ${flagsToClear.join(", ")}`,
          cellsWritten: cellsToWrite,
        });
      } catch (err) {
        console.error(`❌ Error clearing flags:`, err);
        return res.status(500).json({ 
          success: false, 
          error: `Failed to clear flags: ${err.message}` 
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
            const richFlags = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "retainerInvoicesCreated"];
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
      // resolvedNoActionFlags is stored as a set of "clientName___flagType" strings.
      const { sessionId, clientName, flagType } = req.body;
      if (!sessionId || !clientName || !flagType) {
        return res.status(400).json({ success: false, error: "Missing sessionId, clientName, or flagType" });
      }
      try {
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

        // Group by clientName + alertType to minimise tab reads
        const groups = {};
        for (const row of dueRows) {
          const snap = row.dataSnapshot ? (() => { try { return JSON.parse(row.dataSnapshot); } catch(e) { return {}; } })() : {};
          const masterSheetId = snap.masterSheetId || clientMasterSheetIds[row.clientName] || null;
          const key = `${row.clientName}|||${row.alertType}|||${masterSheetId || ""}`;
          if (!groups[key]) groups[key] = { masterSheetId, alertType: row.alertType, rows: [] };
          groups[key].rows.push(row);
        }

        const changed = [];
        const unchanged = [];

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
              const pipe = await readCRMCompAlerts(sheets, masterSheetId, "Pipeline", ["crmPipeDashDiscr"]);
              const conf = await readCRMCompAlerts(sheets, masterSheetId, "Confirmed", ["crmConfDashDiscr"]);
              freshAlerts = [...pipe, ...conf];
            }
          } catch (e) {
            console.log(`  Error reading fresh data for ${key}: ${e.message} — treating as unchanged`);
            unchanged.push(...rows.map(r => r.rowIndex));
            continue;
          }

          // Build set of current fingerprints from fresh data
          const freshHashes = new Set(freshAlerts.map(a => buildAlertFingerprint(a)));

          for (const row of rows) {
            if (freshHashes.has(row.fingerprintHash)) {
              unchanged.push(row.rowIndex);
            } else {
              console.log(`  CHANGED: ${row.fingerprintHash} (${row.clientName} / ${alertType})`);
              changed.push({ rowIndex: row.rowIndex, clientName: row.clientName, alertType });
            }
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
      // Also updates lastRechecked. Called by GAS precompute when a re-check detects changed data.
      const { rowIndex, automationCommanderSheetId } = req.body;
      if (!rowIndex || !automationCommanderSheetId) {
        return res.status(400).json({ success: false, error: "Missing rowIndex or automationCommanderSheetId" });
      }
      try {
        const sheets = await getSheetsClient();
        const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
        const memoryRow = memoryRows.find(r => r.rowIndex === rowIndex);
        if (!memoryRow) {
          return res.status(404).json({ success: false, error: `No AlertMemory row at index ${rowIndex}` });
        }
        const nowISO = new Date().toISOString();
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, rowIndex, {
          ...memoryRow,
          status: "superseded",
          lastRechecked: nowISO,
        });
        console.log(`  ✅ Marked row ${rowIndex} as superseded (${memoryRow.fingerprintHash})`);
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
          .filter(r => r.status === "ignored")
          .map(r => ({
            fingerprintHash: r.fingerprintHash,
            alertType:       r.alertType,
            clientName:      r.clientName,
            alertSummary:    r.alertSummary,
            ignoreReason:    r.ignoreReason,
            firstSeen:       r.firstSeen,
            lastSeen:        r.lastSeen,
          }));

        console.log(`  ✅ Found ${ignoredAlerts.length} ignored alerts`);
        return res.status(200).json({ success: true, ignoredAlerts });
      } catch (err) {
        console.error(`❌ Error fetching ignored alerts:`, err);
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