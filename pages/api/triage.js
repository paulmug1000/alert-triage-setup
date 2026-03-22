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
  // Wait for Google Sheets to process
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Dummy read to trigger calculation
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1`,
    });
  } catch (e) {
    // Ignore errors on dummy read
  }

  // Wait a bit more
  await new Promise((resolve) => setTimeout(resolve, 1000));
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
    // Read AutoUpdates columns L, M and all flag columns
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!L:HE",
    });

    const rows = response.data.values || [];
    const clients = [];

    // Start from row 3 (row 1 = headers, row 2 = first client data)
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 2) continue;

      const clientSheetUrl = row[0]; // Column L
      const masterSheetUrl = row[1]; // Column M

      if (!clientSheetUrl || !masterSheetUrl) continue;

      const clientId = extractSheetIdFromUrl(clientSheetUrl);
      const masterId = extractSheetIdFromUrl(masterSheetUrl);

      if (!clientId || !masterId) continue;

      // Extract flags for this client
      const flags = {};
      let hasFlags = false;

      // CW = invoiceDashboardDiscr (column index 102 from A)
      flags.invoiceDashboardDiscr =
        String(row[102] || "").toUpperCase() === "TRUE";
      if (flags.invoiceDashboardDiscr) hasFlags = true;

      // DD = invoiceAppDiscr (column index 109)
      flags.invoiceAppDiscr =
        String(row[109] || "").toUpperCase() === "TRUE";
      if (flags.invoiceAppDiscr) hasFlags = true;

      // DK = crmPipeDashDiscr (column index 116)
      flags.crmPipeDashDiscr =
        String(row[116] || "").toUpperCase() === "TRUE";
      if (flags.crmPipeDashDiscr) hasFlags = true;

      // DR = crmPipeAppDiscr (column index 123)
      flags.crmPipeAppDiscr = String(row[123] || "").toUpperCase() === "TRUE";
      if (flags.crmPipeAppDiscr) hasFlags = true;

      // DY = crmConfDashDiscr (column index 130)
      flags.crmConfDashDiscr =
        String(row[130] || "").toUpperCase() === "TRUE";
      if (flags.crmConfDashDiscr) hasFlags = true;

      // EF = crmConfAppDiscr (column index 137)
      flags.crmConfAppDiscr = String(row[137] || "").toUpperCase() === "TRUE";
      if (flags.crmConfAppDiscr) hasFlags = true;

      // EM = crmPipeSkippedBlank (column index 144)
      flags.crmPipeSkippedBlank =
        String(row[144] || "").toUpperCase() === "TRUE";
      if (flags.crmPipeSkippedBlank) hasFlags = true;

      // ET = crmConfSkippedBlank (column index 151)
      flags.crmConfSkippedBlank =
        String(row[151] || "").toUpperCase() === "TRUE";
      if (flags.crmConfSkippedBlank) hasFlags = true;

      // FA = crmCopiedConfChecked (column index 158)
      flags.crmCopiedConfChecked =
        String(row[158] || "").toUpperCase() === "TRUE";
      if (flags.crmCopiedConfChecked) hasFlags = true;

      // FH = crmCopiedConfUnchecked (column index 165)
      flags.crmCopiedConfUnchecked =
        String(row[165] || "").toUpperCase() === "TRUE";
      if (flags.crmCopiedConfUnchecked) hasFlags = true;

      // FO = crmCopiedConfDelete (column index 172)
      flags.crmCopiedConfDelete =
        String(row[172] || "").toUpperCase() === "TRUE";
      if (flags.crmCopiedConfDelete) hasFlags = true;

      // FV = retainerInvoicesCreated (column index 179)
      flags.retainerInvoicesCreated =
        String(row[179] || "").toUpperCase() === "TRUE";
      if (flags.retainerInvoicesCreated) hasFlags = true;

      // GC = expenseDashboardDiscr (column index 186)
      flags.expenseDashboardDiscr =
        String(row[186] || "").toUpperCase() === "TRUE";
      if (flags.expenseDashboardDiscr) hasFlags = true;

      // GJ = expenseAppDiscr (column index 193)
      flags.expenseAppDiscr = String(row[193] || "").toUpperCase() === "TRUE";
      if (flags.expenseAppDiscr) hasFlags = true;

      // GQ = expenseAdded (column index 200)
      flags.expenseAdded = String(row[200] || "").toUpperCase() === "TRUE";
      if (flags.expenseAdded) hasFlags = true;

      // GX = expenseUnreconGaps (column index 207)
      flags.expenseUnreconGaps =
        String(row[207] || "").toUpperCase() === "TRUE";
      if (flags.expenseUnreconGaps) hasFlags = true;

      // HE = invoiceStaleUnsentChanges (column index 214)
      flags.invoiceStaleUnsentChanges =
        String(row[214] || "").toUpperCase() === "TRUE";
      if (flags.invoiceStaleUnsentChanges) hasFlags = true;

      if (hasFlags) {
        clients.push({
          clientSheetId: clientId,
          masterSheetId: masterId,
          clientSheetUrl,
          masterSheetUrl,
          flags,
        });
      }
    }

    console.log(
      `Found ${clients.length} clients with flags in Automation Commander`
    );
    return clients;
  } catch (error) {
    console.error("Error getting client flags:", error);
    throw error; // Throw instead of silently returning empty
  }
}

// ============================================================================
// COMPARISON SHEET DATA READING
// ============================================================================

async function readInvCompAlerts(sheets, spreadsheetId) {
  try {
    // Activate master switch
    await setMasterSwitch(sheets, spreadsheetId, "InvComp", true);

    // Read header row (row 5)
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "InvComp!A5:Y5",
    });
    const headers = (headerResponse.data.values || [[]])[0] || [];

    // Read data rows (row 6 onwards)
    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "InvComp!A6:Y1000",
    });
    const rows = dataResponse.data.values || [];

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

    console.log(`Found ${alerts.length} invoice alerts in InvComp`);
    return alerts;
  } catch (error) {
    console.error("Error reading InvComp alerts:", error);
    return [];
  }
}

async function readDirCompAlerts(sheets, spreadsheetId) {
  try {
    // Activate master switch
    await setMasterSwitch(sheets, spreadsheetId, "DirComp", true);

    // Read header row (row 5)
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "DirComp!A5:AV5",
    });
    const headers = (headerResponse.data.values || [[]])[0] || [];

    // Read data rows (row 6 onwards)
    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "DirComp!A6:AV1000",
    });
    const rows = dataResponse.data.values || [];

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

    console.log(`Found ${alerts.length} expense alerts in DirComp`);
    return alerts;
  } catch (error) {
    console.error("Error reading DirComp alerts:", error);
    return [];
  }
}

async function readCRMCompAlerts(sheets, spreadsheetId, mode, alertTypes) {
  try {
    // Set CRM mode
    await setCRMMode(sheets, spreadsheetId, mode);

    // Activate master switch
    await setMasterSwitch(sheets, spreadsheetId, "CRMComp", true);

    const alerts = [];

    for (const alertType of alertTypes) {
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

    console.log(
      `Found ${alerts.length} CRM alerts in ${mode} mode for ${alertTypes.join(", ")}`
    );
    return alerts;
  } catch (error) {
    console.error(`Error reading CRMComp alerts:`, error);
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
    const { action, automationCommanderSheetId } = req.body;
    const sheets = await getSheetsClient();

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
        // Check which actionable flags exist
        const actionableFlags = Object.entries(client.flags)
          .filter(([key, value]) => value && !NO_ACTION_FLAGS.includes(key))
          .map(([key]) => key);

        const noActionFlags = Object.entries(client.flags)
          .filter(([key, value]) => value && NO_ACTION_FLAGS.includes(key))
          .map(([key]) => key);

        // Read actionable alerts
        if (actionableFlags.includes("invoiceDashboardDiscr")) {
          const invoiceAlerts = await readInvCompAlerts(
            sheets,
            client.masterSheetId
          );
          invoiceAlerts.forEach((alert) => {
            alert.clientId = client.masterSheetId;
            alert.flagType = "invoiceDashboardDiscr";
          });
          allAlerts.push(...invoiceAlerts);
        }

        if (actionableFlags.includes("expenseDashboardDiscr")) {
          const expenseAlerts = await readDirCompAlerts(
            sheets,
            client.masterSheetId
          );
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
      }

      // Store session data in Redis
      const sessionId = Math.random().toString(36).substring(2, 15);
      await redisClient.set(
        `triage_alerts:${sessionId}`,
        JSON.stringify({
          alerts: allAlerts,
          noActionAlerts,
          clientsWithFlags,
        }),
        { EX: 86400 }
      );

      res.status(200).json({
        success: true,
        sessionId,
        totalAlerts: allAlerts.length,
        noActionCount: noActionAlerts.length,
      });
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
