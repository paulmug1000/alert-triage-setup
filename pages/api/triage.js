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
    console.log("🔍 Reading AutoUpdates sheet columns L:HE...");
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!L:HE",
    });

    const rows = response.data.values || [];
    console.log(`📊 Total rows returned: ${rows.length}`);
    
    if (rows.length === 0) {
      console.error("❌ No data in AutoUpdates!");
      throw new Error("AutoUpdates sheet appears empty");
    }

    const clients = [];
    console.log(`🔄 Checking rows for flags (starting at index 2 = sheet row 3)...`);

    // Start from row 3 (row 1 = headers, row 2 = first client data)
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      const sheetRowNum = i + 1; // Convert array index to sheet row number
      
      if (!row || row.length < 2) {
        console.log(`  Row ${sheetRowNum}: Empty/too short, skipping`);
        continue;
      }

      const clientSheetUrl = row[0]; // Column L
      const masterSheetUrl = row[1]; // Column M

      console.log(`  Row ${sheetRowNum}: URLs=${(clientSheetUrl || "(empty)").substring(0, 40)}, ${(masterSheetUrl || "(empty)").substring(0, 40)}, row has ${row.length} cols`);

      if (!clientSheetUrl || !masterSheetUrl) {
        console.log(`    → Skipped: Missing URL`);
        continue;
      }

      const clientId = extractSheetIdFromUrl(clientSheetUrl);
      const masterId = extractSheetIdFromUrl(masterSheetUrl);

      if (!clientId || !masterId) {
        console.log(`    → Skipped: Could not extract sheet IDs`);
        continue;
      }

      console.log(`    ✓ Valid URLs found`);

      // Extract flags for this client - optimized for speed
      const flags = {
        invoiceDashboardDiscr: String(row[89] || "").toUpperCase() === "TRUE",
        invoiceAppDiscr: String(row[96] || "").toUpperCase() === "TRUE",
        crmPipeDashDiscr: String(row[103] || "").toUpperCase() === "TRUE",
        crmPipeAppDiscr: String(row[110] || "").toUpperCase() === "TRUE",
        crmConfDashDiscr: String(row[117] || "").toUpperCase() === "TRUE",
        crmConfAppDiscr: String(row[124] || "").toUpperCase() === "TRUE",
        crmPipeSkippedBlank: String(row[131] || "").toUpperCase() === "TRUE",
        crmConfSkippedBlank: String(row[138] || "").toUpperCase() === "TRUE",
        crmCopiedConfChecked: String(row[145] || "").toUpperCase() === "TRUE",
        crmCopiedConfUnchecked: String(row[152] || "").toUpperCase() === "TRUE",
        crmCopiedConfDelete: String(row[159] || "").toUpperCase() === "TRUE",
        retainerInvoicesCreated: String(row[166] || "").toUpperCase() === "TRUE",
        expenseDashboardDiscr: String(row[173] || "").toUpperCase() === "TRUE",
        expenseAppDiscr: String(row[180] || "").toUpperCase() === "TRUE",
        expenseAdded: String(row[187] || "").toUpperCase() === "TRUE",
        expenseUnreconGaps: String(row[194] || "").toUpperCase() === "TRUE",
        invoiceStaleUnsentChanges: String(row[201] || "").toUpperCase() === "TRUE",
      };

      const hasFlags = Object.values(flags).some(v => v);

      if (hasFlags) {
        const flagsFound = Object.entries(flags)
          .filter(([_, value]) => value)
          .map(([key, _]) => key);
        console.log(`    ✅ Row ${sheetRowNum}: ${flagsFound.join(", ")}`);
        clients.push({
          clientSheetId: clientId,
          masterSheetId: masterId,
          clientSheetUrl,
          masterSheetUrl,
          flags,
        });
      }
    }

    console.log(`✅ Flag reading complete: Found ${clients.length} clients with flags`);
    return clients;
  } catch (error) {
    console.error("❌ Error getting client flags:", error);
    throw error;
  }
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
        alerts.push({
          type: "invoice",
          sheetName: "InvComp",
          rowNumber: 7 + rowIdx, // Row 6 is first data row
          data: {
            accounting: row.slice(0, 11), // A:K
            confirmed: row.slice(12, 18), // M:R
            flags: row.slice(18, 25), // S:Y
          },
          flagColumns: headers.slice(18, 25),
        });
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
          const invoiceAlerts = await readInvCompAlerts(
            sheets,
            client.masterSheetId
          );
          console.log(`  ✓ InvComp done, found ${invoiceAlerts.length} alerts`);
          invoiceAlerts.forEach((alert) => {
            alert.clientId = client.masterSheetId;
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
            alert.clientId = client.masterSheetId;
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
            alert.clientId = client.masterSheetId;
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
            alert.clientId = client.masterSheetId;
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
      // Get Claude's analysis for an alert
      const { alert } = req.body;
      
      if (!alert) {
        res.status(400).json({ success: false, error: "Missing alert data" });
        return;
      }

      try {
        console.log(`🤖 Getting Claude analysis for alert:`, alert.type);
        
        // Build a prompt for Claude to analyze this alert
        const prompt = `You are an AI assistant helping to triage financial automation alerts. Analyze the following alert and provide a concise recommendation.

Alert Type: ${alert.type}
Flag Type: ${alert.flagType || 'Unknown'}
${alert.data ? `Alert Data: ${JSON.stringify(alert.data, null, 2)}` : ''}
${alert.flagColumns ? `Flag Columns: ${alert.flagColumns.join(', ')}` : ''}

Provide:
1. A brief summary of what this alert indicates (2-3 sentences)
2. Potential impact if not addressed
3. Recommended action

Keep your response concise and actionable.`;

        const message = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 500,
          messages: [
            { role: "user", content: prompt }
          ],
        });

        const analysis = message.content[0].type === "text" ? message.content[0].text : "";
        
        console.log(`✅ Claude analysis complete`);
        
        res.status(200).json({
          success: true,
          analysis,
        });
      } catch (err) {
        console.error("Error analyzing alert:", err);
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