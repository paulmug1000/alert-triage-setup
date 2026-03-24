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
const PRECOMPUTED_MAX_AGE_MS = 3 * 60 * 60 * 1000; // 3 hours

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
    // Invoice: accounting (A:K) + confirmed (M:R) + flags (S:Y)
    // Expense: accounting (A:J) + confirmed (X:AH) + flags (AO:AV)
    // CRM: crmData + sheetData + flags
    if (alert.data.accounting) parts.push(JSON.stringify(alert.data.accounting));
    if (alert.data.confirmed)  parts.push(JSON.stringify(alert.data.confirmed));
    if (alert.data.crmData)    parts.push(JSON.stringify(alert.data.crmData));
    if (alert.data.sheetData)  parts.push(JSON.stringify(alert.data.sheetData));
    if (alert.data.flags)      parts.push(JSON.stringify(alert.data.flags));
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
        range: `${ALERT_MEMORY_TAB}!A1:I1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            "fingerprintHash", "alertType", "clientName", "alertSummary",
            "cachedOptionsJSON", "status", "ignoreReason", "firstSeen", "lastSeen",
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
 * Write a new row to AlertMemory (append).
 */
async function appendAlertMemoryRow(sheets, automationCommanderSheetId, {
  fingerprintHash, alertType, clientName, alertSummary,
  cachedOptionsJSON, status, ignoreReason,
}) {
  const now = new Date().toISOString().split("T")[0];
  await sheets.spreadsheets.values.append({
    spreadsheetId: automationCommanderSheetId,
    range: `${ALERT_MEMORY_TAB}!A:I`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        fingerprintHash, alertType, clientName, alertSummary,
        cachedOptionsJSON, status, ignoreReason || "", now, now,
      ]],
    },
  });
}

/**
 * Update an existing AlertMemory row by its 1-indexed sheet row number.
 */
async function updateAlertMemoryRow(sheets, automationCommanderSheetId, rowIndex, updates) {
  const now = new Date().toISOString().split("T")[0];
  // Build the full row from updates (we overwrite the entire row for simplicity)
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
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: automationCommanderSheetId,
    range: `${ALERT_MEMORY_TAB}!A${rowIndex}:I${rowIndex}`,
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

async function readInvCompAlerts(sheets, spreadsheetId) {
  try {
    console.log(`\n📖 Reading InvComp alerts from ${spreadsheetId}...`);
    
    // Activate master switch
    console.log(`  Setting E2 = TRUE in InvComp...`);
    await setMasterSwitch(sheets, spreadsheetId, "InvComp", true);
    console.log(`  ✓ Master switch set, waiting for calculations...`);

    // Read header row (row 5)
    console.log(`  Reading headers (row 5)...`);
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "InvComp!A5:Y5",
    });
    const headers = (headerResponse.data.values || [[]])[0] || [];
    console.log(`  ✓ Headers read: ${headers.length} columns`);
    
    // DEBUG: Log header row to understand column mapping
    console.log(`  DEBUG InvComp Headers (A:K should be Client, Job, Inv Amount, Total excl VAT, VAT, Inv No, Sent, Due, Paid, Status, Currency):`);
    for (let i = 0; i < Math.min(11, headers.length); i++) {
      console.log(`    [${i}] = "${headers[i]}"`);
    }
    console.log(`  DEBUG InvComp Flags (S:Y columns 18-24):`);
    for (let i = 18; i < Math.min(25, headers.length); i++) {
      console.log(`    [${i}] = "${headers[i]}"`);
    }

    // Read data rows (row 6 onwards)
    console.log(`  Reading data (rows 6-1000)...`);
    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "InvComp!A6:Y1000",
    });
    const rows = dataResponse.data.values || [];
    console.log(`  ✓ Data read: ${rows.length} rows`);
    
    // DEBUG: Log first few rows completely
    if (rows.length > 0) {
      console.log(`  DEBUG First 3 data rows from InvComp (columns A:K):`);
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        const row = rows[i];
        console.log(`    Row ${6 + i}:`);
        for (let j = 0; j < Math.min(11, row.length); j++) {
          console.log(`      [${j}] = "${row[j]}"`);
        }
        // Also show flag columns
        console.log(`    Row ${6 + i} Flags (S:Y):`);
        for (let j = 18; j < Math.min(25, row.length); j++) {
          console.log(`      [${j}] = "${row[j]}"`);
        }
      }
    }

    // Columns S-Y are discrepancy flags (indices 18-24)
    // IGNORE column W (22) which is "Duplicate inv no ?" - only count other discrepancies
    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;

      // Check if ANY discrepancy flag (EXCEPT W/22 which is "Duplicate inv no ?") = "1"
      const hasDiscrepancy = [18, 19, 20, 21, 23, 24].some(
        (idx) => String(row[idx] || "").trim() === "1"
      );

      if (hasDiscrepancy) {
        // Include columns A:K (accounting data), M:R (confirmed data), S:Y (flags)
        const alert = {
          type: "invoice",
          sheetName: "InvComp",
          rowNumber: 6 + rowIdx, // Row 6 is first data row
          data: {
            accounting: row.slice(0, 11), // A:K
            confirmed: row.slice(12, 18), // M:R
            flags: row.slice(18, 25), // S:Y
          },
          flagColumns: headers.slice(18, 25),
        };
        
        // Add summary for display
        alert.summary = buildInvCompSummary(alert);
        
        console.log(`  📤 Alert prepared for frontend:`);
        console.log(`     Type: ${alert.type}`);
        console.log(`     Summary object: ${JSON.stringify(alert.summary)}`);
        
        alerts.push(alert);
      }
    }

    console.log(`  ✓ Processing complete: Found ${alerts.length} invoice alerts`);
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading InvComp alerts:`, error);
    return [];
  }
}

async function readDirCompAlerts(sheets, spreadsheetId) {
  try {
    console.log(`\n📖 Reading DirComp alerts from ${spreadsheetId}...`);
    
    // Activate master switch
    console.log(`  Setting E2 = TRUE in DirComp...`);
    await setMasterSwitch(sheets, spreadsheetId, "DirComp", true);
    console.log(`  ✓ Master switch set, waiting for calculations...`);

    // Read header row (row 5)
    console.log(`  Reading headers (row 5)...`);
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "DirComp!A5:AV5",
    });
    const headers = (headerResponse.data.values || [[]])[0] || [];
    console.log(`  ✓ Headers read: ${headers.length} columns`);

    // Read data rows (row 6 onwards)
    console.log(`  Reading data (rows 6-1000)...`);
    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "DirComp!A6:AV1000",
    });
    const rows = dataResponse.data.values || [];
    console.log(`  ✓ Data read: ${rows.length} rows`);

    // Columns AO-AV are discrepancy flags (indices 40-47)
    // IGNORE column AP (41) which is "Duplicate app ID ?" - only count other discrepancies
    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;

      // Check if ANY discrepancy flag (EXCEPT AP/41 which is "Duplicate app ID ?") = "1"
      const hasDiscrepancy = [40, 42, 43, 44, 45, 46, 47].some(
        (idx) => String(row[idx] || "").trim() === "1"
      );

      if (hasDiscrepancy) {
        // Include columns A:J (accounting data), X:AH (confirmed/outgoings data), AO:AV (flags)
        const alert = {
          type: "expense",
          sheetName: "DirComp",
          rowNumber: 7 + rowIdx,
          data: {
            accounting: row.slice(0, 10), // A:J
            confirmed: row.slice(23, 34), // X:AH
            flags: row.slice(40, 48), // AO:AV
          },
          flagColumns: headers.slice(40, 48),
        };
        
        // Add summary for display
        alert.summary = buildDirCompSummary(alert);
        
        console.log(`  📤 Alert prepared for frontend:`);
        console.log(`     Type: ${alert.type}`);
        console.log(`     Summary object: ${JSON.stringify(alert.summary)}`);
        
        alerts.push(alert);
      }
    }

    console.log(`  ✓ Processing complete: Found ${alerts.length} expense alerts`);
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading DirComp alerts:`, error);
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

    console.log(`  ✓ Processing complete: Found ${alerts.length} CRM alerts in ${mode} mode`);
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading CRMComp alerts:`, error);
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

async function writeOutgoingsExpense(sheets, clientSheetId, outgoingsData) {
  const { categoryName, expenseMonth, transactionId, amount, description, status, recDate, payDate } = outgoingsData;

  console.log(`  📝 Writing Outgoings expense: ${categoryName} / ${expenseMonth} / £${amount}`);

  // Read the full Outgoings sheet (values + notes)
  const sheetRange = "Outgoings!A1:AX500";
  const valuesResp = await sheets.spreadsheets.values.get({
    spreadsheetId: clientSheetId,
    range: sheetRange,
  });
  const rows = valuesResp.data.values || [];
  if (rows.length === 0) throw new Error("Outgoings tab is empty");

  // Parse the target month from "YYYY-MM"
  const [targetYear, targetMonth] = expenseMonth.split("-").map(Number);

  // Find the column index whose header date matches the target month
  // Header row is row 0 (1-indexed row 1). Dates are stored as strings from Sheets.
  const headerRow = rows[0];
  let targetColIndex = -1;
  for (let c = 0; c < headerRow.length; c++) {
    const headerVal = headerRow[c];
    if (!headerVal) continue;
    // Sheets returns dates as strings like "2026-03-01T00:00:00.000Z" or "3/1/2026" etc.
    // Try parsing as a date
    const parsed = new Date(headerVal);
    if (!isNaN(parsed.getTime())) {
      if (parsed.getFullYear() === targetYear && parsed.getMonth() + 1 === targetMonth) {
        targetColIndex = c;
        break;
      }
    }
  }

  if (targetColIndex === -1) {
    throw new Error(`Could not find column for month ${expenseMonth} in Outgoings header row`);
  }

  // Find the row whose col A matches the category name (case-insensitive trim)
  const categoryLower = categoryName.toLowerCase().trim();
  let targetRowIndex = -1;
  for (let r = 1; r < rows.length; r++) {
    const rowCategoryName = String(rows[r][0] || "").toLowerCase().trim();
    if (rowCategoryName === categoryLower) {
      targetRowIndex = r;
      break;
    }
  }

  if (targetRowIndex === -1) {
    throw new Error(`Could not find category row "${categoryName}" in Outgoings tab`);
  }

  // Sheet row number and column letter (1-indexed)
  const sheetRow = targetRowIndex + 1;
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

  console.log(`  Found: row ${sheetRow} ("${categoryName}"), col ${colLetter} (month ${expenseMonth})`);

  // Read existing cell value and note via batchGet so we get both
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

  // Calculate new total value: add expense amount to existing
  const newValue = Math.round((existingValue + amount) * 100) / 100;

  // Build the new App ID block in GAS format
  const newBlock = `{App ID: ${transactionId}}{Amt: ${amount}}{Status: ${status || ""}}{Rec date: ${recDate || ""}}{Pay date: ${payDate || ""}}{Description: ${description || ""}}`;

  // Check if this transaction ID already exists in the note (idempotency)
  let newNote;
  if (existingNote.includes(`{App ID: ${transactionId}}`)) {
    // Update existing block
    const escapedId = transactionId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    newNote = existingNote.replace(
      new RegExp(`\\{App ID: ${escapedId}\\}.*?(\\n|$)`, "s"),
      newBlock + "\n"
    ).trim();
    console.log(`  Updating existing App ID block for ${transactionId}`);
  } else {
    // Append new block
    newNote = existingNote
      ? `${existingNote}\n\n${newBlock}`
      : newBlock;
    console.log(`  Appending new App ID block for ${transactionId}`);
  }

  // Write value and note in one batchUpdate
  await sheets.spreadsheets.values.update({
    spreadsheetId: clientSheetId,
    range: cellA1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newValue]] },
  });
  console.log(`  ✅ Value written: ${existingValue} → ${newValue}`);

  // Notes require the batchUpdate spreadsheets (not values) API
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: clientSheetId,
    requestBody: {
      requests: [{
        updateCells: {
          range: {
            sheetId: await getSheetId(sheets, clientSheetId, "Outgoings"),
            startRowIndex: sheetRow - 1,
            endRowIndex: sheetRow,
            startColumnIndex: sheetCol - 1,
            endColumnIndex: sheetCol,
          },
          rows: [{
            values: [{
              note: newNote,
            }],
          }],
          fields: "note",
        },
      }],
    },
  });
  console.log(`  ✅ Note written`);

  return { sheetRow, colLetter, newValue, prevValue: existingValue };
}

// Helper: get the numeric sheetId for a named tab
async function getSheetId(sheets, spreadsheetId, tabName) {
  const resp = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = resp.data.sheets?.find(s => s.properties.title === tabName);
  if (!sheet) throw new Error(`Tab "${tabName}" not found in spreadsheet`);
  return sheet.properties.sheetId;
}

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

    console.log(`\n📍 API Request: method=${req.method}, action=${action}`);

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

        if (actionableFlags.includes("expenseDashboardDiscr")) {
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

        // Handle CRM alerts based on which modes are needed
        const pipelineAlerts = actionableFlags.filter((f) =>
          ["crmPipeDashDiscr", "crmPipeAppDiscr"].includes(f)
        );
        const confirmedAlerts = actionableFlags.filter((f) =>
          ["crmConfDashDiscr", "crmConfAppDiscr"].includes(f)
        );

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
      res.status(200).json({
        success: true,
        sessionId,
        totalAlerts: filteredAlerts.length,
        noActionCount: noActionAlerts.length,
        clientsWithFlags: clientsWithFlags.map(client => ({
          clientName: client.clientName,
          clientSheetId: client.clientSheetId,
          masterSheetId: client.masterSheetId,
          flags: client.flags,
        })),
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

        const { alerts, noActionAlerts, clientsWithFlags } = JSON.parse(sessionData);
        console.log(`✅ Retrieved ${alerts.length} alerts from Redis for session ${sessionId}`);
        
        res.status(200).json({
          success: true,
          alerts,
          noActionAlerts,
          clientsWithFlags,
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

        // Promote the precomputed data into a regular session so the existing
        // get_alerts flow works unchanged
        const sessionId = Math.random().toString(36).substring(2, 15);
        await redisClient.set(
          `triage_alerts:${sessionId}`,
          JSON.stringify({
            alerts: data.alerts,
            noActionAlerts: data.noActionAlerts,
            clientsWithFlags: data.clientsWithFlags,
          }),
          { EX: 86400 }
        );

        return res.status(200).json({
          success: true,
          available: true,
          sessionId,
          totalAlerts: data.totalAlerts,
          noActionCount: data.noActionCount,
          clientsWithFlags: data.clientsWithFlags.map(c => ({
            clientName: c.clientName,
            clientSheetId: c.clientSheetId,
            masterSheetId: c.masterSheetId,
            flags: c.flags,
          })),
          computedAt: data.computedAt,
          computedMinutesAgo: Math.round(ageMs / 60000),
        });
      } catch (err) {
        console.error("❌ Error retrieving precomputed data:", err);
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
            if (cachedOptions.length > 0) {
              return res.status(200).json({
                success: true,
                options: cachedOptions,
                alertId: alert.rowNumber,
                fromCache: true,
              });
            }
          }
        }

        console.log(`  Cache MISS for ${fingerprintHash} — calling Claude`);
        // ────────────────────────────────────────────────────────────────────
        
        // Handle expense alerts (DirComp)
        if (alert.type === "expense" || alert.sheetName === "DirComp") {
          console.log(`  📊 Fetching Outgoings tab for expense matching...`);
          
          const outgoingsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Outgoings!A1:Z500",
          });
          
          let outgoingsData = outgoingsResponse.data.values || [];
          
          // If we hit the 500 row limit, fetch more
          if (outgoingsData.length === 500) {
            console.log(`  Detected 500 rows, fetching full range...`);
            const fullResponse = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: "Outgoings!A1:Z5000",
            });
            outgoingsData = fullResponse.data.values || [];
          }
          
          console.log(`  ✓ Loaded ${outgoingsData.length} rows from Outgoings`);
          
          // Find non-blank categories (skip header and empty rows)
          const categories = [];
          for (let i = 1; i < Math.min(outgoingsData.length, 100); i++) {
            const row = outgoingsData[i] || [];
            const category = String(row[0] || '').trim();
            if (category && !category.includes('=') && category.length > 0) {
              categories.push(category);
            }
          }
          
          console.log(`  ✓ Found ${categories.length} Outgoings categories`);
          
          // ALSO fetch Confirmed tab for job-based expense matching
          console.log(`  📊 Fetching Confirmed tab for job-based expense matching...`);
          const confirmedResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Confirmed!A1:CR500",
          });
          
          let confirmedData = confirmedResponse.data.values || [];
          
          if (confirmedData.length === 500) {
            const fullResponse = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: "Confirmed!A1:CR5000",
            });
            confirmedData = fullResponse.data.values || [];
          }
          
          console.log(`  ✓ Loaded ${confirmedData.length} rows from Confirmed`);
          
          // Find last non-blank row (checking all relevant columns)
          let lastDataRow = 1;
          for (let row = confirmedData.length - 1; row > 0; row--) {
            const rowData = confirmedData[row] || [];
            // Check columns that indicate a job exists: A-E (client/job), AG-AM (revenue/dates), AP-BH (invoices), BX-CR (more invoices)
            const colsToCheck = [0, 1, 2, 3, 4, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59];
            const hasData = colsToCheck.some(col => rowData[col]);
            
            if (hasData) {
              lastDataRow = row;
              break;
            }
          }
          
          const activeConfirmedData = confirmedData.slice(0, lastDataRow + 1);
          console.log(`  ✓ Found ${activeConfirmedData.length} non-blank rows in Confirmed`);
          
          // Build list of ALL jobs (for reference)
          const confirmedJobsAll = [];
          let diagnosticRowsLogged = 0;
          for (let i = 1; i < activeConfirmedData.length; i++) {
            const row = activeConfirmedData[i] || [];
            const client = row[0] || '';
            const jobName = row[1] || '';
            const revenue = row[32] !== undefined ? row[32] : '';
            const directCosts = row[33] !== undefined ? row[33] : '';
            
            // DEBUG: Log first 3 rows with client + jobName to see what's in columns 32 and 33
            if (client && jobName && diagnosticRowsLogged < 3) {
              console.log(`\n  DIAGNOSTIC Row ${i + 1}: Client="${client}", JobName="${jobName}", Revenue="${revenue}", DirectCosts="${directCosts}"`);
              diagnosticRowsLogged++;
            }
            
            if (client && jobName) {
              confirmedJobsAll.push({
                row: i + 1,
                client,
                jobName,
                revenue,
                directCosts: parseFloat(String(directCosts).replace(/[£$€,]/g, '')) || 0,
                text: `Row ${i + 1}: ${client} | ${jobName} | Revenue: ${revenue} | Direct Costs: ${directCosts}`
              });
            }
          }
          
          // Filter to jobs with direct costs > 0 for expense matching
          const confirmedJobs = confirmedJobsAll
            .filter(job => job.directCosts > 0)
            .map(job => job.text);
          
          console.log(`  ✓ Built reference list of ${confirmedJobsAll.length} jobs total, ${confirmedJobs.length} with direct costs > £0`);
          
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
          
          console.log(`  📋 Expense details: Ref=${expenseRef}, Amount=${expenseAmount}, Description=${expenseDescription}, Account=${expenseAccountName}`);

          // Build detailed Confirmed tab table for expenses (matching invoice approach)
          // CRITICAL: Calculate remaining direct cost budget for each job
          const expenseConfirmedTabTable = activeConfirmedData
            .map((row, idx) => {
              const client = row[0] || '';
              const jobName = row[1] || '';
              const projectCode = row[2] || '';
              const revenue = row[32] !== undefined ? row[32] : '';
              const directCostsBudget = row[33] !== undefined ? row[33] : '';
              const projType = row[35] || '';
              const startDate = row[37] || '';
              const endDate = row[38] || '';
              
              // Read the three direct cost expense slots
              // Slot 1: BX(75), BY(76), CA(78), CC(80), CD(81)
              const exp1Descr = row[75] || '';
              const exp1Amt = row[76] !== undefined ? row[76] : '';
              const exp1RecDate = row[78] || '';
              const exp1Status = row[80] || '';
              const exp1AppId = row[81] || '';
              
              // Slot 2: CE(82), CF(83), CH(85), CJ(87), CK(88)
              const exp2Descr = row[82] || '';
              const exp2Amt = row[83] !== undefined ? row[83] : '';
              const exp2RecDate = row[85] || '';
              const exp2Status = row[87] || '';
              const exp2AppId = row[88] || '';
              
              // Slot 3: CL(89), CM(90), CO(92), CQ(94), CR(95)
              const exp3Descr = row[89] || '';
              const exp3Amt = row[90] !== undefined ? row[90] : '';
              const exp3RecDate = row[92] || '';
              const exp3Status = row[94] || '';
              const exp3AppId = row[95] || '';
              
              // CRITICAL: Only count as allocated if App ID exists and is NOT blank and does NOT contain "MANUAL-ENTRY"
              // But ALWAYS show descriptions to Claude (even for placeholders)
              let totalAllocated = 0;
              let allocatedExpenses = [];
              let placeholderExpenses = [];
              let allThreeSlots = [];  // For detailed Claude output
              
              // Slot 1
              if (exp1Descr && exp1Amt) {
                if (exp1AppId && !exp1AppId.toString().toUpperCase().includes('MANUAL-ENTRY')) {
                  const amt1 = parseFloat(String(exp1Amt).replace(/[£$€,]/g, '')) || 0;
                  totalAllocated += amt1;
                  allocatedExpenses.push(`${exp1Descr} £${amt1}`);
                  allThreeSlots.push(`Slot 1: ${exp1Descr} - ${String(exp1Amt)} - ${exp1RecDate} - (has valid App ID: yes)`);
                } else {
                  placeholderExpenses.push(`${exp1Descr} (pending) £${exp1Amt}`);
                  allThreeSlots.push(`Slot 1: ${exp1Descr} - ${String(exp1Amt)} - ${exp1RecDate} - (NO App ID - placeholder)`);
                }
              } else {
                allThreeSlots.push(`Slot 1: (empty)`);
              }
              
              // Slot 2
              if (exp2Descr && exp2Amt) {
                if (exp2AppId && !exp2AppId.toString().toUpperCase().includes('MANUAL-ENTRY')) {
                  const amt2 = parseFloat(String(exp2Amt).replace(/[£$€,]/g, '')) || 0;
                  totalAllocated += amt2;
                  allocatedExpenses.push(`${exp2Descr} £${amt2}`);
                  allThreeSlots.push(`Slot 2: ${exp2Descr} - ${String(exp2Amt)} - ${exp2RecDate} - (has valid App ID: yes)`);
                } else {
                  placeholderExpenses.push(`${exp2Descr} (pending) £${exp2Amt}`);
                  allThreeSlots.push(`Slot 2: ${exp2Descr} - ${String(exp2Amt)} - ${exp2RecDate} - (NO App ID - placeholder)`);
                }
              } else {
                allThreeSlots.push(`Slot 2: (empty)`);
              }
              
              // Slot 3
              if (exp3Descr && exp3Amt) {
                if (exp3AppId && !exp3AppId.toString().toUpperCase().includes('MANUAL-ENTRY')) {
                  const amt3 = parseFloat(String(exp3Amt).replace(/[£$€,]/g, '')) || 0;
                  totalAllocated += amt3;
                  allocatedExpenses.push(`${exp3Descr} £${amt3}`);
                  allThreeSlots.push(`Slot 3: ${exp3Descr} - ${String(exp3Amt)} - ${exp3RecDate} - (has valid App ID: yes)`);
                } else {
                  placeholderExpenses.push(`${exp3Descr} (pending) £${exp3Amt}`);
                  allThreeSlots.push(`Slot 3: ${exp3Descr} - ${String(exp3Amt)} - ${exp3RecDate} - (NO App ID - placeholder)`);
                }
              } else {
                allThreeSlots.push(`Slot 3: (empty)`);
              }
              
              // Calculate remaining
              const budgetNum = parseFloat(String(directCostsBudget).replace(/[£$€,]/g, '')) || 0;
              const remaining = budgetNum - totalAllocated;
              
              const allocatedStr = allocatedExpenses.length > 0 
                ? allocatedExpenses.join(' + ')
                : '(none allocated)';
              
              const placeholderStr = placeholderExpenses.length > 0
                ? ` | Placeholders (pending): ${placeholderExpenses.join(' + ')}`
                : '';
              
              // Store all three slots for detailed Claude analysis
              const detailedBreakdown = allThreeSlots.join('\n  ');
              
              return `Row ${idx + 1} | ${client} | ${jobName} | Code: ${projectCode} | DirectCostBudget: ${directCostsBudget} | Allocated: ${allocatedStr} | Remaining: £${remaining.toFixed(2)} | Type: ${projType} | Start: ${startDate} | End: ${endDate}${placeholderStr}\n  Expense Slots:\n  ${detailedBreakdown}`;
            })
            .join('\n');
          
          // Build expense prompt with FULL Confirmed tab data (like invoices do)
          // DO NOT try to match by client name (client is YOUR agency, not the end-client in jobs)
          // Instead match by: vendor name, amount, and account category
          const expensePrompt = `You are analyzing an unmatched business expense. This expense could match either:
1. An Outgoings budget category (for indirect/operational costs like office supplies, software, insurance)
2. A Confirmed job's direct costs (for job-specific vendor expenses like contractors, subcontractors, freelancers, materials)

⚠️ CRITICAL: The "Client" field in the job list refers to END-CLIENTS (like "AH Technology", "National Renal Complement"), NOT the agency. The expense vendor/description will NOT match a client name.

UNMATCHED EXPENSE:
• Reference: ${expenseRef}
• Vendor/Description: ${expenseDescription}
• Amount: £${expenseAmount.toFixed(2)}
• Date: ${expenseDate}
• Account Category: ${expenseAccountName}
• VAT Amount: ${alert.summary?.vatAmount || '£0'}
• Status: ${alert.summary?.status || '(unknown)'}
• Transaction ID: ${alert.summary?.transactionId || '(unknown)'}

OUTGOINGS CATEGORIES (For General/Operational Expenses):
${categories.slice(0, 30).map((cat, idx) => `${idx + 1}. ${cat}`).join("\n")}

CONFIRMED TAB DATA (All non-blank rows - shows jobs, their direct cost budgets, and what's allocated):
${expenseConfirmedTabTable}

CRITICAL INFORMATION ABOUT DIRECT COSTS:

**Understanding Job Direct Costs:**
- Each job in Confirmed tab has a "DirectCosts" budget (column AH)
- This is the TOTAL budgeted direct cost for the entire job
- The Confirmed tab ALSO shows direct cost expenses in three slots per job (Slot 1, 2, 3)
- Each slot has: Description, Amount, Rec Date, Status, App ID
- IMPORTANT DISTINCTION:
  * **Allocated expenses**: Have both Amount AND a valid App ID (NOT blank, NOT "MANUAL-ENTRY")
  * **Placeholder expenses**: Have Description/Amount but App ID is blank or "MANUAL-ENTRY" - these are pending assignment
- Remaining Budget = Total DirectCosts Budget - Sum of ALLOCATED Expenses (do NOT subtract placeholders)

**How to Evaluate Job Matches for Expenses:**
The Confirmed tab above shows for each job:
- DirectCostBudget: The total budget allocated to this job
- Allocated: Expenses with confirmed App IDs (already assigned and finalized)
- Placeholders (pending): Expenses waiting to be assigned (description indicates what work they represent)
- Remaining: How much budget is still available AFTER allocated expenses

**RANKING PRIORITY (most important first):**
1. **PERFECT MATCH (TOP)**: Job has a PLACEHOLDER that matches this expense
   - Placeholder vendor name ≈ Expense vendor name? = HIGH confidence match
   - Example: PHIZZ has placeholder "Craig Niven" £995, expense is "Craig Niven T/A FILDI" £995 = PERFECT
2. **STRONG MATCH**: Job has sufficient REMAINING budget + matching vendor type + matching job scope
3. **MEDIUM MATCH**: Job has remaining budget + vendor/scope is less certain
4. **FALLBACK (LOW)**: Category match if no job matches

**When matching this £${expenseAmount.toFixed(2)} expense:**

1. Expense details to match:
   - Vendor: "${expenseDescription}"
   - Category: "${expenseAccountName}"
   - Amount: £${expenseAmount.toFixed(2)}

2. For EACH job in Confirmed tab:
   - Check for PLACEHOLDER matching this vendor (strongest signal)
   - Check for REMAINING budget >= £${expenseAmount.toFixed(2)} (must fit)
   - Check if job type matches vendor type
   - Report: Budget → Allocated → Remaining calculation

3. IMPORTANT: Only subtract ALLOCATED expenses when calculating remaining budget
   - Placeholder expenses don't count against remaining (they're pending)
   - But a matching placeholder = PERFECT MATCH signal

**Your Task:**
1. Determine: JOB-SPECIFIC EXPENSE (direct costs) or GENERAL OPERATIONAL expense?
2. Find jobs that match PLACEHOLDER vendors, or have sufficient remaining budget + vendor match
3. For EACH option you suggest: Show Budget → Allocated → Remaining in facts
4. For recommendedActions: Generate EXACT cell update instructions for the allocation
5. RANK BY: (1) Placeholder match + remaining budget, (2) Vendor match + remaining budget, (3) Category fallback
6. Suggest 3 GENUINELY DIFFERENT options, properly ranked

**CRITICAL: For recommendedActions, provide exact cell coordinates and values for job allocations:**

**Cell Column Reference for Direct Cost Expense Slots:**
- Slot 1: BX-CD (columns 75-81)
  * BX (75): Description
  * BY (76): Amount
  * BZ (77): VAT? (Write "Yes" if VAT amount from DirComp column I > 0, write "No" if VAT amount is 0 or blank)
  * CA (78): Date (Rec Date from DirComp column A)
  * CB (79): Days to pay (calculated as: if "Date Paid" exists in DirComp column H, use Date Paid - Rec Date; otherwise default to 30)
  * CC (80): Status (from DirComp column F - Status)
  * CD (81): Transaction ID (from DirComp column G - Transaction ID)

- Slot 2: CE-CK (columns 82-88)
  * CE (82): Description
  * CF (83): Amount
  * CG (84): VAT? (Write "Yes" if VAT amount > 0, write "No" if VAT amount is 0 or blank)
  * CH (85): Date (Rec Date from DirComp column A)
  * CI (86): Days to pay (calculated from DirComp columns A and H)
  * CJ (87): Status (from DirComp column F)
  * CK (88): Transaction ID (from DirComp column G)

- Slot 3: CL-CR (columns 89-95)
  * CL (89): Description
  * CM (90): Amount
  * CN (91): VAT? (Write "Yes" if VAT amount > 0, write "No" if VAT amount is 0 or blank)
  * CO (92): Date (Rec Date from DirComp column A)
  * CP (93): Days to pay (calculated from DirComp columns A and H)
  * CQ (94): Status (from DirComp column F)
  * CR (95): Transaction ID (from DirComp column G)

**Example format:**
"Insert expense into Slot 1, Row 232, PHIZZ LTD Development Project (Confirmed tab): Write Craig Niven T/A FILDI to BX232, write 995 to BY232, write Yes to BZ232 (VAT amount is £199, so Yes), write 10-Mar-26 to CA232, write 14 to CB232 (days between 10-Mar and 24-Mar), write Paid to CC232, write 415e873d-23fd-48f5-8a80-d671d6315eae to CD232"

Format as JSON array. FOR EACH OPTION, you MUST show complete allocation details:

[{
  "optionId": 1,
  "title": "Match to [Job Name or Category] - [reason]",
  "matchType": "job" or "category",
  "jobRow": 52,
  "jobName": "Job Name (if job match)",
  "category": "Category Name (if category match — must exactly match the category name in the Outgoings tab)",
  "allocationBreakdown": {
    "jobDirectCostBudget": "£1,995",
    "allocatedExpenses": [
      "Slot 2: Onelink Media Ltd - £1,000.00 - 23-Jan-26 - (has valid App ID: yes)"
    ],
    "totalAllocated": "£1,000.00",
    "placeholderExpenses": [
      "Slot 1: Craig Niven - £995.00 - 10-Mar-26 - (NO App ID - placeholder)"
    ],
    "remainingBudget": "£995.00",
    "expenseCanFit": "YES - £995.00 matches remaining budget"
  },
  "matchAnalysis": {
    "matchConfidence": "High/Medium/Low",
    "vendorAnalysis": "Craig Niven T/A FILDI matches placeholder 'Craig Niven'",
    "placeholderMatch": "YES - Row 232 has placeholder 'Craig Niven - £995.00'",
    "budgetFit": "YES - £995.00 fits in remaining £995.00",
    "reasonForChoice": "Exact placeholder match on vendor, amount, and remaining budget",
    "discrepancies": "None"
  },
  "outgoingsData": {
    "ONLY INCLUDE THIS FIELD if matchType is 'category'. Leave out entirely for job matches.",
    "categoryName": "Exact category name from Outgoings col A (e.g. 'Accountancy fees')",
    "expenseMonth": "YYYY-MM (e.g. '2026-03') — derived from the expense date",
    "transactionId": "Transaction ID from DirComp column G",
    "amount": 995,
    "description": "Full vendor/description string",
    "status": "Status value from DirComp column F",
    "recDate": "dd-Mon-yy (e.g. '10-Mar-26') — Rec date from DirComp column A",
    "payDate": "dd-Mon-yy (e.g. '24-Mar-26') — Date Paid from DirComp column H, or blank if not paid"
  },
  "recommendedActions": [
    "For job match: 'Insert expense into Slot X, Row Y, Job Name (Confirmed tab)'",
    "For category match: 'Add expense to [Category Name] row in Outgoings tab for [Month]'",
    "For job match only — second line with exact cell writes: 'Write Craig Niven T/A FILDI to BX232, write 995 to BY232...'"
  ]
}]

CRITICAL REQUIREMENTS FOR EVERY OPTION:
1. ALWAYS include complete allocationBreakdown
2. In matchAnalysis, keep descriptions SHORT and factual only
3. For job matches (matchType: "job"):
   - recommendedActions must have EXACTLY 2 items: plain English summary, then exact cell writes
   - Use the Confirmed tab column reference above for exact cell coordinates
4. For category matches (matchType: "category"):
   - MUST include the "outgoingsData" field with ALL sub-fields populated
   - recommendedActions needs only 1 item: plain English summary (e.g. "Add £995 to Accountancy fees in Outgoings for Mar-26")
   - The backend will handle the actual cell write using outgoingsData — do NOT provide cell coordinates
   - "categoryName" must exactly match a category from the OUTGOINGS CATEGORIES list above
5. For VAT?: Write "Yes" if DirComp column I (VAT amount) > 0, write "No" if DirComp column I is 0 or blank
6. For Status: Use value from DirComp column F (Status column)
7. For Transaction ID: Use DirComp column G (Transaction ID column, NOT Reference column D)
8. Rank options by: (1) Perfect placeholder match, (2) Sufficient budget + vendor match, (3) Category fallback

Return ONLY JSON, no other text.`;

          // Log prompt summary before sending to Claude
          console.log(`\n📤 EXPENSE PROMPT TO CLAUDE:`);
          console.log(`  Vendor/Description: ${expenseDescription}`);
          console.log(`  Amount: £${expenseAmount}`);
          console.log(`  Account Category: ${expenseAccountName}`);
          console.log(`  Confirmed jobs with direct costs: ${confirmedJobs.length}`);
          const message = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1500,
            messages: [
              { role: "user", content: expensePrompt }
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
"Create new job in ${tabName} tab, next available row: Write ABC Ltd to Col A, write New Project to Col B, write PRJ-001 to Col C, write 5000 to Col AG, write 1-Apr-26 to Col AL, write 30-Jun-26 to Col AM"

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
    "Create new job in ${tabName} tab, next available row: Write ABC Ltd to Col A, write New Project to Col B, write PRJ-001 to Col C, write 5000 to Col AG, write 1-Apr-26 to Col AL, write 30-Jun-26 to Col AM",
    "Verify project code PRJ-001 is unique in the system",
    "Confirm with stakeholder that this job scope is accurate"
  ]
}]

CRITICAL REQUIREMENTS:
- Include matchingDetails with BOTH unmatchedJobSummary and matchedJobDetails for comparison
- Include full matchAnalysis with all matching criteria
- For CREATE NEW option: Include EXACT cell coordinates (column letters + values) for all required fields
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
        
        // Default: Handle invoice alerts (EXISTING WORKING LOGIC)
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
          const colsToCheck = [0, 1, 2, 3, 4, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59];
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
              const label = ref.toString().toUpperCase().includes('MANUAL-INV')
                ? `${ref} [MANUAL ONLY]` : ref;
              if (!ref && !amt) return '(empty)';
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

        // Build Claude prompt with knowledge base and tolerances
        const prompt = `You are a financial advisor helping to resolve an unmatched invoice. Analyze the invoice against the Confirmed tab data and suggest matching options.

UNMATCHED INVOICE:
• Reference: ${invoiceRef}
• Amount: £${invoiceAmount.toFixed(2)}
• Client: ${invoiceClient}
• Job Description: ${invoiceJob}
• Sent: ${sentDate}
• Status: ${invoiceStatus}${datePaid ? `\n• Date Paid: ${datePaid}` : ''}

CONFIRMED TAB DATA (All non-blank rows):
${confirmedTabTable}

MATCHING RULES & TOLERANCES:
${kbRules || "- Default matching rules apply"}
- Date tolerance: ±${tolerances.invoiceMonthsTolerance} months

CRITICAL INFORMATION ABOUT THE SHEET STRUCTURE:

**Understanding Parent and Child Rows:**

Each job in the Confirmed tab may have:
- ONE PARENT ROW: Contains the job's basic information (Client, Job name, Revenue, Start date, End date)
- ZERO OR MORE CHILD ROWS: Contain additional invoices. Child rows have the SAME Client name and Job name as their parent, but NO Revenue, Start date, or End date

**How Invoices Are Organized (by job type):**

PROJECT JOBS:
- Parent row contains invoices 1-3 (Inv1-Inv3 columns)
- Child row 1 (if exists) contains invoices 4-6
- Child row 2 (if exists) contains invoices 7-9
- Each row has 3 invoice slots

RETAINER JOBS:
- Mode A (1 invoice total): Parent row has 1 invoice in slot 1, no child rows
- Mode B (2+ invoices): Parent row has NO invoices, each child row has 1 invoice in slot 1 only

**Invoice Slot Column Reference (Confirmed tab):**
Each slot has 5 fields — use THESE EXACT column letters:

| Slot | Amount | Reference | Sent Date | Days to Pay | Status |
|------|--------|-----------|-----------|-------------|--------|
|  1   |   AP   |    AQ     |    AR     |     AS      |   AT   |
|  2   |   AW   |    AX     |    AY     |     AZ      |   BA   |
|  3   |   BD   |    BE     |    BF     |     BG      |   BH   |

**How to Calculate Remaining to Invoice:**
1. Find the job's parent row (has Revenue)
2. Find all child rows with same Client, same Job name, but no Revenue
3. Sum all invoices from the parent AND all its children
4. ONLY include invoices with real references (NOT marked [MANUAL ONLY])
5. Invoices marked [MANUAL ONLY] are planned but not yet issued — exclude from totals
6. Calculate: Remaining = Parent's Revenue - Total Invoiced Amount (excluding [MANUAL ONLY])

**Days to Pay value to use:** ${daysToPayValue}
(${invoiceStatus.toLowerCase() === 'paid' && datePaid ? `Calculated from sent date ${sentDate} to paid date ${datePaid}` : `Default from DataChgAlert!B52`})

**Your Task:**
1. Identify which job (parent row) this invoice should match to
2. For EACH option, provide facts: parent row, job name, type, revenue, dates, existing invoices, total invoiced, remaining, match status
3. Suggest 3 GENUINELY DIFFERENT options: BEST MATCH, ALTERNATIVE MATCH, CREATE NEW JOB

**CRITICAL: recommendedActions must contain EXACTLY 2 items:**

Item 1 — Plain English summary (one sentence):
"Insert invoice [ref] to slot [N] of the [Job Name] job (row [R])"

Item 2 — Exact cell writes only, nothing else:
"Write [amount] to [col][R] (amount), write [ref] to [col][R] (ref), write [sentDate] to [col][R] (sent date), write ${daysToPayValue} to [col][R] (days to pay), write [status] to [col][R] (status)"

Replace [col] with the correct column letter from the table above for the chosen slot.
Do NOT include any other bullet points such as "Update project status" or "Mark as processed".

Format as JSON array:
[{
  "optionId": 1,
  "title": "Match to [Job Name] - [reason]",
  "jobRow": 52,
  "jobName": "Job Name",
  "facts": {
    "jobType": "Project",
    "totalRevenue": 15950,
    "startDate": "3-Mar-26",
    "endDate": "31-Aug-26",
    "existingInvoices": "0820 £7,975 (sent 12-Mar-26) + 0821 £5,725 (sent 20-Mar-26) = £13,700 (excludes any [MANUAL ONLY] invoices)",
    "remainingToInvoice": 2250,
    "invoiceMatchStatus": "EXACT MATCH",
    "discrepancies": "Why it didn't auto-match"
  },
  "recommendedActions": [
    "Insert invoice 0822 to slot 3 of the Natasha Allergy Research Foundation video job (row 52)",
    "Write 2250 to BD52 (amount), write 0822 to BE52 (ref), write 20-Mar-26 to BF52 (sent date), write ${daysToPayValue} to BG52 (days to pay), write Sent to BH52 (status)"
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

        // ── CONFIRMED / PIPELINE / CRM WRITE (cell-reference based) ─────────
        // Parse recommendedActions to extract cell writes
        const cellUpdates = [];
        if (option.recommendedActions && Array.isArray(option.recommendedActions)) {
          for (const actionString of option.recommendedActions) {
            if (actionString.includes("Write") || actionString.includes("write")) {
              // Match: write <value> to <CELL> — value may contain any characters including 't'
              // Use a global regex with a proper non-greedy lookahead stop
              const regex = /write\s+(.+?)\s+to\s+([A-Z]{1,3}\d+)(?:\s*[,(]|$)/gi;
              let match;
              while ((match = regex.exec(actionString)) !== null) {
                const value = match[1].trim();
                const cell = match[2];
                if (value && cell) {
                  cellUpdates.push({ cell, value });
                }
              }
            }
          }
        }
        
        console.log(`  Parsed ${cellUpdates.length} cell updates`);

        // Determine which tab to write to based on alert type
        const writeTab = (alert.type === "crm" || alert.sheetName === "CRMComp")
          ? (alert.mode === "Pipeline" ? "Pipeline" : "Confirmed")
          : "Confirmed";
        
        // Batch write all cells, always prefixed with the tab name
        if (cellUpdates.length > 0) {
          const batchRequest = {
            data: cellUpdates.map(({ cell, value }) => ({
              range: `${writeTab}!${cell}`,
              values: [[value]],
            })),
            valueInputOption: "USER_ENTERED",
          };
          
          console.log(`  Writing ${cellUpdates.length} cells to ${writeTab} tab of Client Sheet...`);
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: alert.clientId,
            requestBody: batchRequest,
          });
          console.log(`  ✅ Cells written successfully`);
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
    } else if (action === "clear_flags") {
      // Clear flags by writing directly to DataChgAlert in the client's Master Sheet.
      // flagsToClear is an array of: "invoice", "crm", "expense" (any combination).
      // Each maps to a specific cell in DataChgAlert:
      //   invoice → AS2
      //   crm     → AT2 + AU2
      //   expense → AV2
      const { masterSheetId, automationCommanderSheetId, flagsToClear } = req.body;
      
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

        // Build the list of cells to write TRUE to
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

        if (memoryRow) {
          // Update existing row to ignored
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
            ...memoryRow,
            status: "ignored",
            ignoreReason: ignoreReason || "",
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