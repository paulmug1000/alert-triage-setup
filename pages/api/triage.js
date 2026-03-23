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
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "DataChgAlert!F39,J111",
    });
    const values = response.data.values || [];
    return {
      invoiceMonthsTolerance: values[0]?.[0] || 2,
      expenseMonthsTolerance: values[1]?.[0] || 1,
    };
  } catch (err) {
    console.log("⚠️ Using default tolerance values");
    return {
      invoiceMonthsTolerance: 2,
      expenseMonthsTolerance: 1,
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
// ENRICHMENT: Fetch client data for matching context
// ============================================================================

async function enrichAlertWithClientData(sheets, alert, clientSheetId) {
  try {
    console.log(`  📊 Enriching alert with client data from ${clientSheetId.substring(0, 16)}...`);
    
    // Fetch Confirmed tab to get job list and existing invoices
    const confirmedResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: clientSheetId,
      range: "Confirmed!A2:G1000",
    });
    
    const confirmedRows = confirmedResponse.data.values || [];
    
    // Extract job context - look for matching jobs
    const matchingJobs = confirmedRows.filter(row => {
      if (!row || row.length < 3) return false;
      const jobName = row[0] || "";
      const jobAmount = row[2] || "";
      // Simple match: if alert mentions this job in description
      return true; // We'll enhance this with Claude later
    });
    
    alert.enrichment = {
      clientSheetId,
      potentialJobs: matchingJobs.slice(0, 5), // Top 5 potential matching jobs
      timestamp: new Date().toISOString(),
    };
    
    console.log(`  ✓ Enriched with ${matchingJobs.length} potential jobs`);
    return alert;
  } catch (error) {
    console.error(`  ⚠️ Could not enrich alert:`, error.message);
    // Return alert without enrichment - don't fail the whole process
    alert.enrichment = { error: error.message };
    return alert;
  }
}

// ============================================================================
// ALERT SUMMARY BUILDING
// ============================================================================

// Build alert summary from InvComp data for display to user
function buildInvCompSummary(alert) {
  const accounting = alert.data.accounting || [];
  
  // DEBUG: Log raw values to understand what we're getting
  console.log(`DEBUG buildInvCompSummary:`, {
    raw_accounting: accounting,
    index_0: accounting[0],
    index_1: accounting[1],
    index_2: accounting[2],
    index_3: accounting[3],
    index_4: accounting[4],
    index_5: accounting[5],
  });
  
  // InvComp columns (A:K) - CORRECT MAPPING:
  // A: Client, B: Job, C: Invoice amount, D: Total excl VAT, E: VAT included,
  // F: Invoice no, G: Sent date, H: Due date, I: Fully paid on, J: Status, K: Currency
  const client = accounting[0] || '(unknown)';
  const job = accounting[1] || '';
  
  // CRITICAL FIX: Remove commas from number strings before parsing
  // Google Sheets returns '2,700.00' but parseFloat('2,700.00') = 2 (stops at comma)
  const invoiceAmount = parseFloat(String(accounting[2] || '0').replace(/,/g, '')) || 0; // Column C
  const totalExclVAT = parseFloat(String(accounting[3] || '0').replace(/,/g, '')) || 0; // Column D
  const vatIncluded = parseFloat(String(accounting[4] || '0').replace(/,/g, '')) || 0; // Column E
  
  const invoiceNo = accounting[5] || '(no reference)'; // Column F - Invoice no
  const sentDate = accounting[6] || ''; // Column G - Sent date
  const status = accounting[9] || ''; // Column J - Status
  const currency = accounting[10] || 'GBP'; // Column K - Currency
  
  console.log(`DEBUG after parsing:`, {
    client, job, invoiceAmount, totalExclVAT, vatIncluded, invoiceNo, sentDate, status, currency
  });
  
  // Use Total excl VAT (Column D) as the primary amount
  // This is what the user specified
  const amount = totalExclVAT > 0 ? totalExclVAT : invoiceAmount;
  console.log(`DEBUG amount decision: totalExclVAT(${totalExclVAT}) > 0 ? totalExclVAT : invoiceAmount = ${amount}`);
  
  // Determine VAT indicator
  let vatSuffix = '';
  if (vatIncluded && vatIncluded > 0) {
    vatSuffix = ' + VAT';
  }
  
  // Format the amount with currency and VAT indicator
  const formattedAmount = amount > 0 
    ? `${currency}${amount.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2})}${vatSuffix}`
    : 'unknown amount';
  
  // Build the summary string
  let summary = `Invoice ${invoiceNo} • ${formattedAmount} • ${client}`;
  if (job) {
    summary += ` • ${job}`;
  }
  if (sentDate) {
    summary += ` • Sent ${sentDate}`;
  }
  if (status) {
    summary += ` • ${status}`;
  }
  
  return {
    invoiceNo,
    amount,
    vatIncluded,
    currency,
    client,
    job,
    sentDate,
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
  });
  
  // DirComp columns (A:J) - CORRECTED MAPPING:
  // A: Date, B: Description, C: Amount, D: Reference, E: Account name, F: Status, G: Transaction ID, H: ?, I: ?, J: ?
  const date = accounting[0] || '';
  const description = accounting[1] || '';
  const amount = parseFloat(String(accounting[2] || '0').replace(/,/g, '')) || 0; // Column C - Amount
  const reference = accounting[3] || '';
  const accountName = accounting[4] || '';
  const status = accounting[5] || '';
  const transactionId = accounting[6] || '';
  
  console.log(`DEBUG after parsing:`, {
    date, description, amount, reference, accountName, status, transactionId
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
      console.log(`  DEBUG First 3 data rows (A:Y):`);
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        console.log(`    Row ${6 + i}: [${rows[i].slice(0, 11).map((v, idx) => `[${idx}]=${v}`).join(', ')}]`);
        console.log(`             [Cols S-Y flags]: ${rows[i].slice(18, 25).map((v, idx) => `[${18 + idx}]=${v}`).join(', ')}`);
      }
    }

    // Columns S-Y are discrepancy flags (indices 18-24)
    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;

      // Check if any discrepancy flag = "1"
      const hasDiscrepancy = [18, 19, 20, 21, 22, 23, 24].some(
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
    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;

      // Check if any discrepancy flag = "1"
      const hasDiscrepancy = [40, 41, 42, 43, 44, 45, 46, 47].some(
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
      console.log(`💾 Storing session in Redis...`);

      // Store session data in Redis
      const sessionId = Math.random().toString(36).substring(2, 15);
      console.log(`  Storing ${allAlerts.length} alerts in Redis (session: ${sessionId})...`);
      await redisClient.set(
        `triage_alerts:${sessionId}`,
        JSON.stringify({
          alerts: allAlerts,
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
        totalAlerts: allAlerts.length,
        noActionCount: noActionAlerts.length,
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
    } else if (action === "analyze_alert") {
      // Generate matching options for an alert
      const { alert } = req.body;
      
      if (!alert) {
        res.status(400).json({ success: false, error: "Missing alert data" });
        return;
      }

      try {
        console.log(`\n🤖 Generating options for ${alert.type || alert.flagType} alert`);
        
        const sheets = await getSheetsClient();
        
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
              console.log(`\n  DIAGNOSTIC Row ${i + 1}:`);
              console.log(`    Client (col A): "${client}"`);
              console.log(`    JobName (col B): "${jobName}"`);
              console.log(`    Revenue raw (col 32/AG): "${revenue}" (type: ${typeof revenue})`);
              console.log(`    DirectCosts raw (col 33/AH): "${directCosts}" (type: ${typeof directCosts})`);
              const parsed = parseFloat(String(directCosts).replace(/,/g, '')) || 0;
              console.log(`    DirectCosts parsed: ${parsed}`);
              diagnosticRowsLogged++;
            }
            
            // SPECIAL: Log row 232 (PHIZZ LTD job) if it exists
            if (i === 231) {  // i is 0-indexed, so row 232 = index 231
              console.log(`\n  *** CHECKING ROW 232 (PHIZZ LTD) ***`);
              console.log(`    Client (col A): "${client}"`);
              console.log(`    JobName (col B): "${jobName}"`);
              console.log(`    Revenue raw (col 32/AG): "${revenue}"`);
              console.log(`    DirectCosts raw (col 33/AH): "${directCosts}"`);
              const parsed = parseFloat(String(directCosts).replace(/[£$€,]/g, '')) || 0;
              console.log(`    DirectCosts parsed: ${parsed}`);
              console.log(`    Will be included in job list? ${parsed > 0 ? 'YES ✓' : 'NO ✗'}`);
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
          
          // DIAGNOSTIC: Show expense allocation details for row 232 PHIZZ LTD
          const phizzJob = activeConfirmedData[231];
          if (phizzJob && phizzJob[0] === 'PHIZZ LTD') {
            console.log(`\n  *** PHIZZ LTD ROW 232 - EXPENSE ALLOCATION DETAILS ***`);
            console.log(`    DirectCosts Budget (col AH/33): £${phizzJob[33]}`);
            console.log(`    Slot 1 - Descr(75): "${phizzJob[75]}" | Amt(76): "${phizzJob[76]}" | AppID(81): "${phizzJob[81]}"`);
            console.log(`    Slot 2 - Descr(82): "${phizzJob[82]}" | Amt(83): "${phizzJob[83]}" | AppID(88): "${phizzJob[88]}"`);
            console.log(`    Slot 3 - Descr(89): "${phizzJob[89]}" | Amt(90): "${phizzJob[90]}" | AppID(95): "${phizzJob[95]}"`);
            
            // Calculate allocated (only if AppID exists and is NOT blank/MANUAL-ENTRY)
            let totalAllocated = 0;
            if (phizzJob[75] && phizzJob[76] && phizzJob[81] && !phizzJob[81].toString().toUpperCase().includes('MANUAL-ENTRY')) {
              const amt1 = parseFloat(String(phizzJob[76]).replace(/[£$€,]/g, '')) || 0;
              totalAllocated += amt1;
              console.log(`    Slot 1: ALLOCATED £${amt1} (AppID: ${phizzJob[81]})`);
            } else if (phizzJob[75] && phizzJob[76]) {
              console.log(`    Slot 1: PLACEHOLDER "${phizzJob[75]}" (AppID blank or MANUAL-ENTRY)`);
            }
            if (phizzJob[82] && phizzJob[83] && phizzJob[88] && !phizzJob[88].toString().toUpperCase().includes('MANUAL-ENTRY')) {
              const amt2 = parseFloat(String(phizzJob[83]).replace(/[£$€,]/g, '')) || 0;
              totalAllocated += amt2;
              console.log(`    Slot 2: ALLOCATED £${amt2} (AppID: ${phizzJob[88]})`);
            } else if (phizzJob[82] && phizzJob[83]) {
              console.log(`    Slot 2: PLACEHOLDER "${phizzJob[82]}" (AppID blank or MANUAL-ENTRY)`);
            }
            if (phizzJob[89] && phizzJob[90] && phizzJob[95] && !phizzJob[95].toString().toUpperCase().includes('MANUAL-ENTRY')) {
              const amt3 = parseFloat(String(phizzJob[90]).replace(/[£$€,]/g, '')) || 0;
              totalAllocated += amt3;
              console.log(`    Slot 3: ALLOCATED £${amt3} (AppID: ${phizzJob[95]})`);
            } else if (phizzJob[89] && phizzJob[90]) {
              console.log(`    Slot 3: PLACEHOLDER "${phizzJob[89]}" (AppID blank or MANUAL-ENTRY)`);
            }
            
            const budgetNum = parseFloat(String(phizzJob[33]).replace(/[£$€,]/g, '')) || 0;
            const remaining = budgetNum - totalAllocated;
            console.log(`    Total Allocated (not counting placeholders): £${totalAllocated.toFixed(2)}`);
            console.log(`    Remaining Budget: £${remaining.toFixed(2)}`);
            console.log(`    Can accommodate £995 expense? ${remaining >= 995 ? 'YES ✓' : 'NO ✗'}`);
          }
          
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
4. RANK BY: (1) Placeholder match + remaining budget, (2) Vendor match + remaining budget, (3) Category fallback
5. Suggest 3 GENUINELY DIFFERENT options, properly ranked

Format as JSON array. FOR EACH OPTION, you MUST show complete allocation details:

[{
  "optionId": 1,
  "title": "Match to [Job Name] - [reason]",
  "matchType": "job" or "category",
  "jobRow": 52,
  "jobName": "Job Name (if job match)",
  "category": "Category Name (if category match)",
  "allocationBreakdown": {
    "jobDirectCostBudget": "£1,995 (the job's TOTAL allocated budget)",
    "allocatedExpenses": [
      "Slot 1: Vendor Name - £amount - date - (has valid App ID: yes/no)",
      "Slot 2: Onelink Media Ltd (Press Tech Audit - Jan 26) - £1,000.00 - 23-Jan-26 - (has valid App ID: yes)",
      "Slot 3: (empty)"
    ],
    "totalAllocated": "£1,000.00",
    "placeholderExpenses": [
      "Slot 1: Craig Niven - £995.00 - 10-Mar-26 - (NO App ID - placeholder)"
    ],
    "remainingBudget": "£995.00 (£1,995 - £1,000 allocated)",
    "expenseCanFit": "YES - this £${expenseAmount.toFixed(2)} matches exactly to remaining budget"
  },
  "matchAnalysis": {
    "matchConfidence": "High/Medium/Low",
    "vendorAnalysis": "Why this vendor matches this work type",
    "placeholderMatch": "Is there a placeholder matching this vendor? YES/NO - explain",
    "budgetFit": "Does the expense fit in remaining budget? YES/NO with amounts",
    "reasonForChoice": "Why this is the best match",
    "discrepancies": "Any concerns or issues"
  },
  "recommendedActions": ["Action 1", "Action 2"]
}]

CRITICAL REQUIREMENTS FOR EVERY OPTION:
1. ALWAYS include complete allocationBreakdown with jobDirectCostBudget, allocatedExpenses list, totalAllocated, placeholderExpenses list, remainingBudget
2. Show EVERY expense slot (1, 2, 3) - whether allocated, placeholder, or empty
3. Include vendor name, amount, date, and slot number for EACH expense
4. Clearly state YES/NO for "has valid App ID" for each expense
5. Rank options by: (1) Perfect placeholder match (vendor name + remaining budget), (2) Sufficient remaining budget + vendor match, (3) Category fallback

Return ONLY JSON, no other text.`;

          // DEBUG: Log the FULL prompt being sent to Claude (first 500 chars)
          console.log(`\n📤 EXPENSE PROMPT TO CLAUDE:`);
          console.log(`  Vendor/Description: ${expenseDescription}`);
          console.log(`  Amount: £${expenseAmount}`);
          console.log(`  Account Category: ${expenseAccountName}`);
          console.log(`  Confirmed jobs list has ${confirmedJobs.length} entries`);
          console.log(`  Matching strategy: vendor type + amount + account category (NOT client name)`);
          console.log(`  ALL JOBS WITH DIRECT COSTS > £0 (complete list of ${confirmedJobs.length}):`);
          confirmedJobs.forEach((job, idx) => {
            console.log(`    ${idx + 1}. ${job}`);
          });
          
          // Log the first part of the prompt itself
          const promptPreview = expensePrompt.substring(0, 300);
          console.log(`\n  Prompt starts with: "${promptPreview}..."`);
          
          // CRITICAL: Check if "Eleven" appears in any of the job names
          const elevenJobs = confirmedJobs.filter(job => job.toLowerCase().includes('eleven'));
          if (elevenJobs.length > 0) {
            console.log(`\n  🔍 FOUND ${elevenJobs.length} JOB(S) MENTIONING 'ELEVEN':`);
            elevenJobs.forEach(job => console.log(`     - ${job}`));
          } else {
            console.log(`\n  ⚠️ NO JOBS MENTIONING 'ELEVEN' IN THE CONFIRMED JOBS LIST`);
          }
          const message = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1500,
            messages: [
              { role: "user", content: expensePrompt }
            ],
          });

          let options = [];
          const responseText = message.content[0].type === "text" ? message.content[0].text : "";
          
          // Log Claude's RAW response before parsing
          console.log(`\n📥 CLAUDE'S RAW RESPONSE:`);
          console.log(`  First 500 chars: "${responseText.substring(0, 500)}"`);
          console.log(`  Total response length: ${responseText.length} chars`);
          
          const cleanedText = responseText
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
          
          try {
            options = JSON.parse(cleanedText);
            if (!Array.isArray(options)) options = [options];
            console.log(`  ✅ Parsed ${options.length} expense options from Claude`);
            
            // DEBUG: Log all three options Claude returned
            if (options.length > 0) {
              console.log(`\n📥 ALL OPTIONS FROM CLAUDE:`);
              options.forEach((opt, idx) => {
                console.log(`\n  Option ${idx + 1}: ${opt.title}`);
                console.log(`    Match Type: ${opt.matchType}`);
                if (opt.matchType === "job") {
                  console.log(`    Job Row: ${opt.jobRow}`);
                  console.log(`    Job Name: ${opt.jobName}`);
                } else {
                  console.log(`    Category: ${opt.category}`);
                }
                console.log(`    Confidence: ${opt.facts?.matchConfidence || "?"}`);
                console.log(`    Reasoning: ${opt.facts?.reasonForChoice || opt.facts?.reasoning || "?"}`);
              });
            }
          } catch (e) {
            console.error(`  ⚠️ Could not parse Claude response as JSON`);
            options = [{ summary: responseText }];
          }
          
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
3. Suggest 3 options: BEST MATCH, ALTERNATIVE, CREATE NEW JOB

For each option, provide detailed matching analysis showing:
- Why this matches (or why CREATE NEW if no match)
- Confidence level based on matching criteria
- Specific details from the matched job
- Any concerns or discrepancies
- Recommended actions

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
  "recommendedActions": ["Action 1", "Action 2", "Action 3"]
}]

CRITICAL REQUIREMENTS:
- Include matchingDetails with BOTH unmatchedJobSummary and matchedJobDetails for comparison
- Include full matchAnalysis with all matching criteria
- For CREATE NEW option, explain why no existing job matches
- Show the specific discrepancies that would need resolving

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
            const inv1Amount = row[41] !== undefined ? row[41] : '';
            const inv1Ref = row[42] || '';
            const inv2Amount = row[48] !== undefined ? row[48] : '';
            const inv2Ref = row[49] || '';
            const inv3Amount = row[55] !== undefined ? row[55] : '';
            const inv3Ref = row[56] || '';
            
            return `Row ${idx + 1} | ${client} | ${jobName} | Code: ${projectCode} | Revenue: ${revenue} | VAT: ${vat} | Type: ${projType} | Start: ${startDate} | End: ${endDate} | Inv1: ${inv1Ref} £${inv1Amount} | Inv2: ${inv2Ref} £${inv2Amount} | Inv3: ${inv3Ref} £${inv3Amount}`;
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
        
        // Build Claude prompt with knowledge base and tolerances
        const prompt = `You are a financial advisor helping to resolve an unmatched invoice. Analyze the invoice against the Confirmed tab data and suggest matching options.

UNMATCHED INVOICE:
• Reference: ${invoiceRef}
• Amount: £${invoiceAmount.toFixed(2)}
• Client: ${invoiceClient}
• Job Description: ${invoiceJob}
• Sent: ${sentDate}

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

To identify a parent row: Has Client name, Job name, Revenue amount, Start date, and End date
To identify a child row: Has the SAME Client name and Job name as a parent, but Revenue/Start date/End date are blank

**How Invoices Are Organized (by job type):**

PROJECT JOBS:
- Parent row contains invoices 1-3 (Inv1-Inv3 columns)
- Child row 1 (if exists) contains invoices 4-6
- Child row 2 (if exists) contains invoices 7-9
- Each row has 3 invoice slots (amount and reference)

RETAINER JOBS:
- Mode A (1 invoice total): Parent row has 1 invoice in slot 1, no child rows
- Mode B (2+ invoices): Parent row has NO invoices, each child row has 1 invoice in slot 1 only

**How to Calculate Remaining to Invoice:**
1. Find the job's parent row (has Revenue)
2. Find all child rows with same Client, same Job name, but no Revenue
3. Sum all invoices from the parent AND all its children (ignore invoices with blank references)
4. Calculate: Remaining = Parent's Revenue - Total Invoiced Amount

**Your Task:**
1. Identify which job (parent row) this invoice should match to, considering client name, job similarity, amount, reference pattern, and dates
2. For EACH option, provide ONLY these facts: parent row, job name, type, revenue, dates, existing invoices with sent dates, total invoiced, remaining, match status, and WHY it didn't auto-match
3. Suggested actions: data corrections or matching decisions only
4. Suggest 3 GENUINELY DIFFERENT options: BEST MATCH, ALTERNATIVE MATCH, CREATE NEW JOB

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
    "existingInvoices": "0820 £7,975 (sent 12-Mar-26) + 0821 £5,725 (sent 20-Mar-26) = £13,700",
    "remainingToInvoice": 2250,
    "invoiceMatchStatus": "EXACT MATCH",
    "discrepancies": "Why it didn't auto-match"
  },
  "recommendedActions": ["Action 1", "Action 2"]
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
        
        res.status(200).json({
          success: true,
          options,
          alertId: alert.rowNumber,
        });
      } catch (err) {
        console.error("❌ Error generating options:", err);
        res.status(500).json({ success: false, error: err.message });
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