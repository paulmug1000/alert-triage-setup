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
        alerts.push({
          type: "expense",
          sheetName: "DirComp",
          rowNumber: 7 + rowIdx,
          data: {
            accounting: row.slice(0, 10), // A:J
            confirmed: row.slice(23, 34), // X:AH
            flags: row.slice(40, 48), // AO:AV
          },
          flagColumns: headers.slice(40, 48),
        });
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
      // Generate matching options for an alert using Confirmed tab data
      const { alert } = req.body;
      
      if (!alert) {
        res.status(400).json({ success: false, error: "Missing alert data" });
        return;
      }

      try {
        console.log(`\n🤖 Generating options for alert:`, alert.flagType);
        
        const sheets = await getSheetsClient();
        
        // CRITICAL: Fetch Confirmed tab from CLIENT SHEET, not Master Sheet
        console.log(`  Fetching Confirmed tab from CLIENT sheet ${alert.clientId.substring(0, 16)}...`);
        
        // OPTIMIZATION: Only fetch up to column CR (79) instead of DC
        // OPTIMIZATION: Estimate actual data range (usually 1-200 rows, not 5000)
        // Fetch in chunks: first check 1-500, then expand if needed
        const confirmedResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: alert.clientId,  // CLIENT Sheet (Column L)
          range: "Confirmed!A1:CR500",    // Only to CR (79), only 500 rows
        });
        
        let confirmedData = confirmedResponse.data.values || [];
        
        // If we hit the 500 row limit, fetch more (rarely needed)
        if (confirmedData.length === 500) {
          console.log(`  Detected 500 rows (likely more data), fetching full range...`);
          const fullResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Confirmed!A1:CR5000",
          });
          confirmedData = fullResponse.data.values || [];
        }
        
        console.log(`  📊 Loaded ${confirmedData.length} rows of job data`);
        
        // Find last non-blank row (checking A-E, AG-AM, AP-BH, BX-CR)
        let lastDataRow = 1;
        for (let row = confirmedData.length - 1; row > 0; row--) {
          const rowData = confirmedData[row] || [];
          
          // Check if row has data in key columns
          const colsToCheck = [0, 1, 2, 3, 4]; // A-E
          colsToCheck.push(...[32, 33, 34, 35, 36, 37, 38]); // AG-AM
          colsToCheck.push(...[41, 42, 43, 44, 45, 46, 47]); // AP-BH (approximate)
          colsToCheck.push(...[73, 74, 75, 76, 77, 78, 79]); // BX-CR (approximate)
          
          const hasData = colsToCheck.some(col => rowData[col]);
          
          if (hasData) {
            lastDataRow = row;
            console.log(`  ✓ Last non-blank row found at index ${lastDataRow} (row ${lastDataRow + 1})`);
            console.log(`    Data in this row: Client="${rowData[0]}", Job="${rowData[1]}", Revenue=${rowData[32]}`);
            console.log(`  DEBUG: ALL non-empty cells in row ${lastDataRow + 1}:`);
            for (let i = 0; i < rowData.length; i++) {
              if (rowData[i] !== undefined && rowData[i] !== null && rowData[i] !== '') {
                const val = String(rowData[i]).substring(0, 80);
                console.log(`    Col ${i}: ${val}`);
              }
            }
            break;
          }
        }
        
        console.log(`  Last data row: ${lastDataRow + 1}`);
        
        // Get the active data
        const activeData = confirmedData.slice(0, lastDataRow + 1);
        console.log(`  📊 Using ${activeData.length} non-blank rows for Claude analysis`);
        
        // Helper: Calculate remaining to invoice for a job row
        // CRITICAL: Only count invoices with valid references (not blank, not MANUAL-INV)
        function calculateRemainingToInvoice(jobRow, totalRevenue) {
          if (!jobRow || !totalRevenue) return totalRevenue;
          
          const jobRevenue = parseFloat(totalRevenue) || 0;
          
          // Invoice structure in Confirmed tab:
          // Inv 1: Amount at AP (41), Ref at AQ (42)
          // Inv 2: Amount at AW (48), Ref at AX (49)
          // Inv 3: Amount at BD (55), Ref at BE (56)
          // Pattern: amounts at [41, 48, 55, 62, 69, 76, 83, ...], refs at [42, 49, 56, 63, 70, 77, 84, ...]
          
          const invoiceAmountIndices = [41, 48, 55, 62, 69, 76, 83];
          const invoiceRefIndices = [42, 49, 56, 63, 70, 77, 84];
          
          let totalInvoiced = 0;
          
          // Sum amounts for invoices with VALID references (not blank, not MANUAL-INV)
          for (let i = 0; i < invoiceAmountIndices.length; i++) {
            const amountIdx = invoiceAmountIndices[i];
            const refIdx = invoiceRefIndices[i];
            
            const ref = String(jobRow[refIdx] || '').trim();
            const amount = parseFloat(jobRow[amountIdx]) || 0;
            
            // Only count invoices with valid references
            if (ref && ref !== '' && !ref.includes('MANUAL-INV') && amount > 0) {
              totalInvoiced += amount;
            }
          }
          
          return Math.max(0, jobRevenue - totalInvoiced);
        }
        
        // Extract invoice details from alert
        const invoiceAmount = parseFloat(alert.summary?.amount) || 0;
        const invoiceRef = alert.summary?.invoiceNo || '(unmatched)';
        const invoiceClient = alert.summary?.client || '';
        const invoiceJob = alert.summary?.job || '';
        const sentDate = alert.summary?.sentDate || '';
        
        // Build job details from ALL non-blank rows (not filtered by client)
        // Claude will understand parent/child structure and identify relevant jobs
        console.log(`  📊 Sending all ${activeData.length} non-blank rows to Claude for analysis`);
        
        const jobDetailsStr = activeData
          .map((row, idx) => {
            const client = row[0] || '';
            const jobName = row[1] || '';
            // Revenue is in AG (index 32)
            const totalRevenue = parseFloat(row[32]) || 0;
            
            // Get existing invoice references and amounts
            // Structure: Inv 1 at [41, 42], Inv 2 at [48, 49], Inv 3 at [55, 56], etc.
            const invoiceAmountIndices = [41, 48, 55, 62, 69, 76, 83];
            const invoiceRefIndices = [42, 49, 56, 63, 70, 77, 84];
            
            let invoiceDetails = '';
            for (let i = 0; i < invoiceAmountIndices.length; i++) {
              const amountIdx = invoiceAmountIndices[i];
              const refIdx = invoiceRefIndices[i];
              
              const ref = String(row[refIdx] || '').trim();
              const amount = parseFloat(row[amountIdx]) || 0;
              
              // Only show invoices with valid references (not blank, not MANUAL-INV)
              if (ref && ref !== '' && !ref.includes('MANUAL-INV') && amount > 0) {
                invoiceDetails += `\n    • ${ref}: £${amount.toFixed(2)}`;
              }
            }
            
            const remaining = calculateRemainingToInvoice(row, totalRevenue);
            const invoiced = totalRevenue - remaining;
            
            // Only log first few for debugging
            if (idx < 3) {
              console.log(`  DEBUG Row ${idx + 1}: Client="${client}", Job="${jobName}", Revenue=£${totalRevenue}`);
            }
            
            return `Row ${idx + 1}: ${client} | ${jobName}
    Revenue: £${totalRevenue.toFixed(2)}
    Already Invoiced: £${invoiced.toFixed(2)}${invoiceDetails}
    Remaining to Invoice: £${remaining.toFixed(2)}`;
          })
          .join('\n\n');
        
        console.log(`\n📊 Sending to Claude (first 800 chars):\n${jobDetailsStr.substring(0, 800)}...`);
        
        // Improved Claude prompt with better context
        const prompt = `You are a financial advisor helping to resolve an unmatched invoice. Analyze the invoice and suggest the MOST LIKELY matching options.

UNMATCHED INVOICE:
• Reference: ${invoiceRef}
• Amount: £${invoiceAmount.toFixed(2)}
• Client: ${invoiceClient}
• Description: ${invoiceJob}
• Sent: ${sentDate}

EXISTING JOBS FOR THIS CLIENT (with invoice history):
${jobDetailsStr}

CRITICAL INFORMATION ABOUT THE SHEET STRUCTURE:

**Understanding Parent and Child Rows:**

Each job in the Confirmed tab may have:
- ONE PARENT ROW: Contains the job's basic information (Client, Job name, Revenue, Start date, End date)
- ZERO OR MORE CHILD ROWS: Contain additional invoices. Child rows have the SAME Client name and Job name as their parent, but NO Revenue, Start date, or End date

To identify a parent row: Has Client name, Job name, Revenue amount, Start date, and End date
To identify a child row: Has the SAME Client name and Job name as a parent, but Revenue/Start date/End date are blank

**How Invoices Are Organized (by job type):**

PROJECT JOBS:
- Parent row contains invoices 1-3 (in slots: amount/ref at columns AP/AQ, AW/AX, BD/BE)
- Child row 1 (if exists) contains invoices 4-6
- Child row 2 (if exists) contains invoices 7-9
- Each row has 3 invoice slots

RETAINER JOBS:
- Mode A (1 invoice total): Parent row has 1 invoice in slot 1, no child rows
- Mode B (2+ invoices): Parent row has NO invoices, each child row has 1 invoice in slot 1 only

**How to Calculate Remaining to Invoice:**
1. Find the job's parent row (has Revenue)
2. Find all child rows with same Client, same Job name, but no Revenue
3. Sum all invoices from the parent AND all its children (ignore invoices with blank references or "MANUAL-INV" references)
4. Calculate: Remaining = Parent's Revenue - Total Invoiced Amount

**Analyzing This Invoice:**
When you analyze the invoice, identify which job it should match to by:
- Client name match (required)
- Job description similarity
- Amount matching the remaining-to-invoice gap (considering parent + all children together)
- Invoice reference pattern matching existing invoices
- Date patterns

For your chosen match, explain:
- Which job (parent row) it matches to
- Whether it's a project or retainer
- All existing invoices on that parent + its children
- The total remaining to invoice after summing all invoices across parent + children
- Whether this new invoice fits that gap
- Any discrepancies that need attention

**Do NOT suggest:**
- Changing job descriptions
- Creating jobs with £0.00 revenue
- Any actions that don't make business sense

**Suggest 2-3 realistic options:**
- Option 1: Best match to existing job (if applicable)
- Option 2: Alternative job or create new job
- Option 3: Only if truly ambiguous

Format as JSON array with ONLY these fields:
{
  "optionId": 1,
  "title": "Match to [Job Name] - [reason]",
  "jobRow": 5,
  "jobName": "Job Name",
  "businessLogic": "[Explain why this makes sense. Reference existing invoices on parent and children, total remaining to invoice, client match, etc.]",
  "recommendedActions": [
    "Action 1",
    "Action 2"
  ]
}

Return ONLY the JSON array, no other text.`;

        const message = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          messages: [
            { role: "user", content: prompt }
          ],
        });

        const responseText = message.content[0].type === "text" ? message.content[0].text : "";
        
        console.log(`  ✅ Options generated`);
        console.log(`\n📋 Claude was given this prompt:\n${prompt.substring(0, 1000)}...`);
        console.log(`\n📝 Claude responded with (first 500 chars):\n${responseText.substring(0, 500)}`);
        
        // Parse JSON response - Claude might wrap in ```json ... ```
        let options = [];
        let cleanedText = responseText
          .replace(/```json\n?/g, '')  // Remove ```json markers
          .replace(/```\n?/g, '')       // Remove ``` markers
          .trim();
        
        try {
          options = JSON.parse(cleanedText);
          if (!Array.isArray(options)) options = [options];
          console.log(`  ✅ Parsed ${options.length} options from Claude`);
        } catch (e) {
          console.error(`  ⚠️ Could not parse Claude response as JSON`);
          console.error(`  Raw text (first 200 chars): ${responseText.substring(0, 200)}`);
          console.error(`  Cleaned text (first 200 chars): ${cleanedText.substring(0, 200)}`);
          console.error(`  Parse error: ${e.message}`);
          // Fallback: return raw text
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