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

async function writeOutgoingsExpense(sheets, clientSheetId, outgoingsData) {
  const { categoryName, expenseMonth, transactionId, amount, description, status, recDate, payDate, vatCharged } = outgoingsData;

  console.log(`  📝 Writing Outgoings expense: ${categoryName} / ${expenseMonth} / £${amount}`);

  // Read the full Outgoings sheet (values + notes) — wide enough to cover all monthly columns
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
  const headerRow = rows[0];
  let targetColIndex = -1;
  for (let c = 0; c < headerRow.length; c++) {
    const headerVal = headerRow[c];
    if (!headerVal) continue;
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

  // Find the vendor row in the contractor section (rows 12-112, 0-indexed 11-111)
  const categoryLower = categoryName.toLowerCase().trim();
  let targetRowIndex = -1;
  let firstBlankRowIndex = -1;

  for (let r = 11; r <= Math.min(111, rows.length - 1); r++) {
    const rowVendorName = String(rows[r][0] || "").toLowerCase().trim();
    if (rowVendorName === categoryLower) {
      targetRowIndex = r;
      break;
    }
    // Track first blank row (col A empty) as fallback for new vendors
    if (!rowVendorName && firstBlankRowIndex === -1) {
      firstBlankRowIndex = r;
    }
  }

  let isNewVendor = false;
  if (targetRowIndex === -1) {
    // Vendor not found — use first blank row
    if (firstBlankRowIndex === -1) {
      throw new Error(`No existing row for "${categoryName}" and no blank rows available in contractor section (rows 12-112)`);
    }
    targetRowIndex = firstBlankRowIndex;
    isNewVendor = true;
    console.log(`  New vendor — using blank row ${targetRowIndex + 1}`);
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

  // Write note
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
          rows: [{ values: [{ note: newNote }] }],
          fields: "note",
        },
      }],
    },
  });
  console.log(`  ✅ Note written`);

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

      // Build per-flag alert counts per client for the UI
      const alertCountsByClientAndFlag = {};
      for (const alert of filteredAlerts) {
        const key = alert.clientName;
        const flagKey = alert.flagType || alert.alertType || alert.type;
        if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
        alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;
      }

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
          alertCounts: alertCountsByClientAndFlag[client.clientName] || {},
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
        });
      } catch (err) {
        console.error("❌ Error retrieving precomputed data:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "store_precomputed") {
      // Called by the GAS precompute function to store assembled triage data in Redis.
      // Requires the cron secret to prevent unauthorised writes.
      const { secret, alerts, noActionAlerts, clientsWithFlags,
              totalAlerts, noActionCount, computedAt } = req.body;

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
        };

        await redisClient.set(
          PRECOMPUTED_KEY,
          JSON.stringify(precomputedData),
          { EX: 14400 } // 4 hour TTL
        );

        console.log(`✅ store_precomputed: ${precomputedData.totalAlerts} alerts saved to Redis`);
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
          console.log(`  📊 Fetching Outgoings tab for expense matching...`);
          
          const outgoingsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Outgoings!A1:F112",
          });
          const outgoingsRows = outgoingsResponse.data.values || [];
          console.log(`  ✓ Loaded ${outgoingsRows.length} rows from Outgoings (rows 1-112)`);

          // Build vendor list for Claude — rows 12-112 are the contractor section
          // Each row: A=vendorName, B=chargesVAT, C-F=defaults
          // Blank rows (col A empty) = available slots for new vendors
          const outgoingsVendorList = [];
          let firstBlankOutgoingsRow = null;
          for (let i = 11; i < Math.min(outgoingsRows.length, 112); i++) { // 0-indexed rows 11-111 = sheet rows 12-112
            const vendorName = String(outgoingsRows[i]?.[0] || '').trim();
            const chargesVAT = String(outgoingsRows[i]?.[1] || '').trim();
            if (vendorName) {
              outgoingsVendorList.push(`Row ${i + 1}: ${vendorName} (VAT: ${chargesVAT || 'unknown'})`);
            } else if (firstBlankOutgoingsRow === null) {
              firstBlankOutgoingsRow = i + 1; // 1-indexed sheet row
            }
          }
          console.log(`  ✓ Found ${outgoingsVendorList.length} existing vendors, first blank row: ${firstBlankOutgoingsRow}`);
          
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

              // Collect parent + child rows for this job
              const jobRows = [{ row, sheetRow: ci + 1 }];
              let cj = ci + 1;
              while (cj < activeConfirmedData.length) {
                const next = activeConfirmedData[cj] || [];
                const nc = String(next[0] || '').trim();
                const nj = String(next[1] || '').trim();
                const nb = String(next[33] || '').replace(/[£$€,\s]/g, '');
                if (nc === parentClient && nj === parentJob && !next[32] && !parseFloat(nb) && !next[37]) {
                  jobRows.push({ row: next, sheetRow: cj + 1 });
                  cj++;
                } else { break; }
              }
              ci = cj;

              let totalAllocated = 0;
              const slots = [];
              for (const { row: r, sheetRow } of jobRows) {
                for (let s = 0; s < slotColDefs.length; s++) {
                  const { d, a, dt, id } = slotColDefs[s];
                  const descr = String(r[d] || '').trim();
                  const amt = r[a] !== undefined ? r[a] : '';
                  const date = r[dt] || '';
                  const appId = String(r[id] || '').trim();
                  if (!descr && !amt) { slots.push({ label: `Row ${sheetRow} ExpSlot${s+1}`, empty: true, sheetRow, slotNum: s+1 }); continue; }
                  const amtNum = parseFloat(String(amt).replace(/[£$€,]/g, '')) || 0;
                  const isAllocated = !!(appId && !appId.toUpperCase().includes('MANUAL-ENTRY'));
                  if (isAllocated) totalAllocated += amtNum;
                  slots.push({ label: `Row ${sheetRow} ExpSlot${s+1}`, descr, amt, date, appId, isAllocated, empty: false, sheetRow, slotNum: s+1 });
                }
              }

              candidateJobs.push({
                parentRow: parentIdx + 1,
                parentClient, parentJob,
                projectCode: row[2] || '',
                revenue: row[32] !== undefined ? row[32] : '',
                projType: row[35] || '',
                startDate: row[37] || '',
                endDate: row[38] || '',
                budget, totalAllocated,
                remaining: budget - totalAllocated,
                slots,
              });
            } else { ci++; }
          }

          console.log(`  ✓ Found ${candidateJobs.length} jobs with DirectCostBudget > £0`);

          const expenseConfirmedTabTable = candidateJobs.length > 0
            ? candidateJobs.map(job => {
                const filled = job.slots.filter(s => !s.empty)
                  .map(s => `${s.label}: ${s.descr} £${s.amt} ${s.date} (${s.isAllocated ? 'allocated' : 'NO App ID - placeholder'})`)
                  .join(' | ') || 'none';
                const empty = job.slots.filter(s => s.empty).map(s => s.label).join(', ') || 'none';
                return `ParentRow ${job.parentRow} | ${job.parentClient} | ${job.parentJob} | Code: ${job.projectCode} | Budget: £${job.budget} | Allocated: £${job.totalAllocated.toFixed(2)} | Remaining: £${job.remaining.toFixed(2)} | Type: ${job.projType} | ${job.startDate}→${job.endDate}\n  Filled: ${filled}\n  Empty slots: ${empty}`;
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

Budget, Allocated, and Remaining are already calculated for you.
Empty slots show the exact row and slot number to write to (use those exact row numbers in cell writes).
Placeholders (NO App ID) = unconfirmed planned allocations. A placeholder whose description ≈ this vendor = PERFECT MATCH.

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
  Item 2: Exact cell writes — "Write [Desc] to [COL][ROW], write [Amt] to [COL][ROW], write [VAT] to [COL][ROW], write [Date] to [COL][ROW], write [DaysToPay] to [COL][ROW], write [Status] to [COL][ROW], write [TransactionID] to [COL][ROW]"

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
    "vatCharged": "Yes or No based on VAT amount"
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
        const invFlags = alert.data.flags || [];
        const discrepancyTypes = [];
        if (String(invFlags[0] || "").trim() === "1") discrepancyTypes.push("MISSING INVOICE — invoice exists in accounting but has no match in the Confirmed tab");
        if (String(invFlags[1] || "").trim() === "1") discrepancyTypes.push("CLIENT MISMATCH — the client name on the invoice differs from the job");
        if (String(invFlags[2] || "").trim() === "1") discrepancyTypes.push("AMOUNT MISMATCH — the invoice amount differs from what is recorded in the Confirmed tab");
        if (String(invFlags[3] || "").trim() === "1") discrepancyTypes.push("SENT DATE MISMATCH — the sent date differs from what is recorded in the Confirmed tab");
        if (String(invFlags[5] || "").trim() === "1") discrepancyTypes.push("DATE PAID MISMATCH — the date paid differs from what is recorded in the Confirmed tab");
        if (String(invFlags[6] || "").trim() === "1") discrepancyTypes.push("STATUS MISMATCH — the status differs from what is recorded in the Confirmed tab");
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
1. Find the job this invoice belongs to
2. Identify the correct empty or placeholder slot to place it in
3. After placing the invoice, calculate the new total invoiced across ALL slots (excluding [MANUAL ONLY])
4. Compare the new total to the job revenue:
   - If new total > revenue: you MUST clear blank-reference placeholder slots until the total equals revenue. Work through the slots systematically — clear the lowest-priority placeholders first (later slots first). Include the clear writes in recommendedActions.
   - If new total = revenue: clean — no further action needed
   - If new total < revenue: a gap remains — note it but do NOT create new placeholders (automation handles this)
5. ALWAYS show the full arithmetic in facts: slot-by-slot breakdown → current total → new total after placing invoice → new total after any clears → vs revenue
6. The goal is: after all writes are applied, total invoiced = revenue (or a documented gap remains for automation to fill)

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
                if (cell) {  // allow empty string values — needed to clear placeholder slots
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