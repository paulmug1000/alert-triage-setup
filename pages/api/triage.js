/**
 * PHASE 2: ALERT TRIAGE SYSTEM
 * Backend API for analyzing financial automation alerts
 * 
 * Handles:
 * 1. Reading discrepancy flags from Automation Commander
 * 2. Fetching alert data from client comparison sheets
 * 3. Passing alerts to Claude for analysis
 * 4. Logging decisions to TriageLog
 * 5. Presenting recommendations to user
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

const ALERT_TYPES = {
  INVOICE: "invoice",
  EXPENSE: "expense",
  CRM: "crm",
};

const DISCREPANCY_COLUMNS = {
  invoice: {
    // InvComp: columns S-Y
    range: "S5:Y5",
    flags: [
      "Missing invoice?",
      "Client mismatch?",
      "Inv amt mismatch?",
      "Sent date mismatch?",
      "Duplicate inv no?",
      "Fully paid on mismatch?",
      "Status mismatch?",
    ],
  },
  expense: {
    // DirComp: columns AO-AV
    range: "AO5:AV5",
    flags: [
      "Missing cost?",
      "Duplicate app ID?",
      "Descr. mismatch?",
      "Amount mismatch?",
      "VAT mismatch?",
      "Rec date mismatch?",
      "Pay date mismatch?",
      "Status mismatch?",
    ],
  },
  crm_left: {
    // CRMComp left section: columns AY-BF
    range: "AY5:BF5",
    flags: [
      "Missing job?",
      "Client mismatch?",
      "Job name mismatch?",
      "Revenue mismatch?",
      "Direct costs mismatch?",
      "Start date mismatch?",
      "End date mismatch?",
      "% likel. mismatch?",
    ],
  },
  crm_right: {
    // CRMComp right section: columns FE-FL
    range: "FE5:FL5",
    flags: [
      "Missing job?",
      "Client mismatch?",
      "Job name mismatch?",
      "Revenue mismatch?",
      "Direct costs mismatch?",
      "Start date mismatch?",
      "End date mismatch?",
      "% likel. mismatch?",
    ],
  },
};

// ============================================================================
// GOOGLE SHEETS INTEGRATION
// ============================================================================

/**
 * Get Google Sheets auth with service account credentials
 */
function getGoogleAuth() {
  const credentials = {
    type: "service_account",
    project_id: process.env.SERVICE_ACCOUNT_PROJECT_ID,
    private_key_id: process.env.SERVICE_ACCOUNT_PRIVATE_KEY_ID,
    private_key: (process.env.SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(
      /\\n/g,
      "\n"
    ),
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

/**
 * Get Sheets API client
 */
async function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: "v4", auth });
}

/**
 * Apply double flush pattern to ensure calculations complete
 * Since we can't call SpreadsheetApp.flush() from Node.js,
 * we wait and then read a cell to trigger calculation
 */
async function ensureFreshData(sheets, spreadsheetId, sheetName) {
  // Wait 2 seconds for Google Sheets to process
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

/**
 * Set master switch (E2) to TRUE to trigger calculations
 */
async function activateMasterSwitch(sheets, spreadsheetId, sheetName) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!E2`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[true]],
    },
  });

  // Wait and ensure data is fresh
  await ensureFreshData(sheets, spreadsheetId, sheetName);
}

/**
 * Check if a discrepancy flag is TRUE for a given type
 */
function hasDiscrepancy(flagRow, discrepancyType) {
  if (!flagRow || flagRow.length === 0) return false;

  return flagRow.some((cell) => {
    const val = String(cell).toUpperCase().trim();
    return val === "TRUE" || val === 1 || val === "1";
  });
}

/**
 * Read alerts from a comparison sheet
 */
async function readAlertsFromSheet(sheets, spreadsheetId, sheetName, type) {
  try {
    // Activate master switch
    await activateMasterSwitch(sheets, spreadsheetId, sheetName);

    // Get discrepancy column configuration
    const config = DISCREPANCY_COLUMNS[type];
    if (!config) return [];

    // Read flag columns
    const flagResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!${config.range}`,
    });

    const flagRow = (flagResponse.data.values || [[]])[0];

    // If no discrepancies, return empty
    if (!hasDiscrepancy(flagRow, type)) {
      console.log(`No ${type} discrepancies found in ${sheetName}`);
      return [];
    }

    // Read all data rows
    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A6:Z1000`, // Start from row 6 (after headers)
    });

    const rows = dataResponse.data.values || [];

    // Get column headers
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z5`,
    });

    const headers = (headerResponse.data.values || [])[0] || [];

    // Build alerts array
    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;

      // Check if this row has any discrepancies
      const rowFlagStart = config.range.split(":")[0].charCodeAt(0) - "A".charCodeAt(0);
      const hasRowDiscrepancy = config.flags.some((flagName, flagIdx) => {
        const cellValue = String(row[rowFlagStart + flagIdx] || "").toUpperCase().trim();
        return cellValue === "TRUE" || cellValue === "1";
      });

      if (hasRowDiscrepancy) {
        alerts.push({
          type,
          sheetName,
          rowNumber: 7 + rowIdx, // Row 6 is first data row in sheet
          data: row,
          headers,
          discrepancyFlags: config.flags,
          discrepancies: config.flags.filter((flagName, flagIdx) => {
            const cellValue = String(row[rowFlagStart + flagIdx] || "").toUpperCase().trim();
            return cellValue === "TRUE" || cellValue === "1";
          }),
        });
      }
    }

    console.log(`Found ${alerts.length} ${type} alerts in ${sheetName}`);
    return alerts;
  } catch (error) {
    console.error(`Error reading ${type} alerts from ${sheetName}:`, error);
    return [];
  }
}

/**
 * Get list of clients from Automation Commander
 */
async function getClientList(sheets, automationCommanderSheetId) {
  try {
    // Read AutoUpdates tab column L (client sheet URL) and column M (master sheet URL)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!L:M",
    });

    const rows = response.data.values || [];
    const clients = [];

    for (let i = 1; i < rows.length; i++) {
      const [clientSheetUrl, masterSheetUrl] = rows[i] || [];
      if (clientSheetUrl && masterSheetUrl) {
        // Extract sheet IDs from URLs
        const clientId = extractSheetIdFromUrl(clientSheetUrl);
        const masterId = extractSheetIdFromUrl(masterSheetUrl);

        if (clientId && masterId) {
          clients.push({
            clientSheetId: clientId,
            masterSheetId: masterId,
            clientSheetUrl,
            masterSheetUrl,
          });
        }
      }
    }

    return clients;
  } catch (error) {
    console.error("Error getting client list:", error);
    return [];
  }
}

/**
 * Extract sheet ID from Google Sheets URL
 */
function extractSheetIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

/**
 * Get discrepancy flags from Automation Commander
 */
async function getDiscrepancyFlags(sheets, automationCommanderSheetId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!BN2:BQ2", // Assuming flags are in these columns
    });

    const [flags] = response.data.values || [[]];
    return {
      invoiceDiscrepancies: String(flags[0] || "").toUpperCase() === "TRUE",
      expenseDiscrepancies: String(flags[1] || "").toUpperCase() === "TRUE",
      crmDiscrepancies: String(flags[2] || "").toUpperCase() === "TRUE",
    };
  } catch (error) {
    console.error("Error getting discrepancy flags:", error);
    return {
      invoiceDiscrepancies: false,
      expenseDiscrepancies: false,
      crmDiscrepancies: false,
    };
  }
}

/**
 * Log decision to TriageLog sheet
 */
async function logDecision(sheets, spreadsheetId, decision) {
  try {
    const timestamp = new Date().toISOString();
    const row = [
      timestamp,
      decision.alertType,
      decision.alertId,
      decision.client,
      decision.amount || "",
      JSON.stringify(decision.claudeRecommendation),
      decision.userAction || "",
      decision.userCorrection || "",
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "TriageLog!A:H",
      valueInputOption: "RAW",
      requestBody: {
        values: [row],
      },
    });
  } catch (error) {
    console.error("Error logging decision:", error);
  }
}

// ============================================================================
// CLAUDE INTEGRATION
// ============================================================================

/**
 * Fetch AIKnowledgeBase from Automation Commander
 */
async function getKnowledgeBase(sheets, automationCommanderSheetId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AIKnowledgeBase!A2:E1000",
    });

    const rows = response.data.values || [];
    const knowledgeBase = {};

    for (const row of rows) {
      const [category, subcategory, concept, description] = row;
      if (!category) continue;

      if (!knowledgeBase[category]) {
        knowledgeBase[category] = {};
      }
      if (!knowledgeBase[category][subcategory]) {
        knowledgeBase[category][subcategory] = [];
      }

      knowledgeBase[category][subcategory].push({
        concept,
        description,
      });
    }

    return knowledgeBase;
  } catch (error) {
    console.error("Error fetching knowledge base:", error);
    return {};
  }
}

/**
 * Analyze alert using Claude
 */
async function analyzeAlertWithClaude(alert, knowledgeBase) {
  const systemPrompt = `You are an expert financial automation analyst. Your job is to review financial alerts and recommend actions.

The existing automation system has ALREADY attempted to match this item but failed. Your job is to find patterns and exceptions it missed.

You have access to a knowledge base of matching rules and patterns. Use this to make intelligent recommendations.

When making recommendations, ALWAYS provide:
1. Your confidence level (0-100%)
2. Specific recommendation (AUTO_MATCH, REQUEST_CLARIFICATION, NEW_WORK, DATA_ERROR)
3. Exact reasoning
4. What the system would need to do if approved

Format your response as JSON.`;

  const userPrompt = `
Alert Type: ${alert.type}
Sheet: ${alert.sheetName}
Row: ${alert.rowNumber}

Discrepancies Detected:
${alert.discrepancies.join("\n")}

Alert Data:
${JSON.stringify(alert.data.slice(0, 30))} // First 30 columns

Knowledge Base:
${JSON.stringify(knowledgeBase)}

Please analyze this alert and provide a recommendation in JSON format with:
{
  "confidence": 0-100,
  "recommendation": "AUTO_MATCH|REQUEST_CLARIFICATION|NEW_WORK|DATA_ERROR|INVESTIGATE",
  "reasoning": "...",
  "suggestedAction": "...",
  "questionsForUser": ["..."],
  "potentialMatches": [...],
  "whyAutomationMissed": "..."
}
`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
      ],
      system: systemPrompt,
    });

    const responseText = message.content[0].text;

    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return {
      confidence: 50,
      recommendation: "INVESTIGATE",
      reasoning: responseText,
    };
  } catch (error) {
    console.error("Error analyzing alert with Claude:", error);
    return {
      confidence: 0,
      recommendation: "INVESTIGATE",
      reasoning: `Error: ${error.message}`,
    };
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
      // 1. Get discrepancy flags
      const flags = await getDiscrepancyFlags(sheets, automationCommanderSheetId);

      // 2. Get client list
      const clients = await getClientList(sheets, automationCommanderSheetId);

      // 3. Get knowledge base
      const knowledgeBase = await getKnowledgeBase(
        sheets,
        automationCommanderSheetId
      );

      // 4. Fetch alerts from all clients
      const allAlerts = [];

      for (const client of clients) {
        if (flags.invoiceDiscrepancies) {
          const invoiceAlerts = await readAlertsFromSheet(
            sheets,
            client.masterSheetId,
            "InvComp",
            "invoice"
          );
          allAlerts.push(...invoiceAlerts);
        }

        if (flags.expenseDiscrepancies) {
          const expenseAlerts = await readAlertsFromSheet(
            sheets,
            client.masterSheetId,
            "DirComp",
            "expense"
          );
          allAlerts.push(...expenseAlerts);
        }

        if (flags.crmDiscrepancies) {
          const crmAlertsLeft = await readAlertsFromSheet(
            sheets,
            client.masterSheetId,
            "CRMComp",
            "crm_left"
          );
          const crmAlertsRight = await readAlertsFromSheet(
            sheets,
            client.masterSheetId,
            "CRMComp",
            "crm_right"
          );
          allAlerts.push(...crmAlertsLeft, ...crmAlertsRight);
        }
      }

      // Store alerts in Redis session
      const sessionId = Math.random().toString(36).substring(2, 15);
      await redisClient.set(
        `triage_alerts:${sessionId}`,
        JSON.stringify(allAlerts),
        { EX: 86400 }
      );
      await redisClient.set(
        `triage_kb:${sessionId}`,
        JSON.stringify(knowledgeBase),
        { EX: 86400 }
      );

      res.status(200).json({
        success: true,
        sessionId,
        totalAlerts: allAlerts.length,
        alertSummary: {
          invoices: allAlerts.filter((a) => a.type === "invoice").length,
          expenses: allAlerts.filter((a) => a.type === "expense").length,
          crm: allAlerts.filter((a) => a.type.includes("crm")).length,
        },
      });
    } else if (action === "get_next_alert") {
      // Get next alert for review
      const { sessionId, alertIndex } = req.body;

      const alertsJson = await redisClient.get(`triage_alerts:${sessionId}`);
      const kbJson = await redisClient.get(`triage_kb:${sessionId}`);

      if (!alertsJson || !kbJson) {
        return res.status(404).json({ error: "Session not found" });
      }

      const alerts = JSON.parse(alertsJson);
      const knowledgeBase = JSON.parse(kbJson);

      if (alertIndex >= alerts.length) {
        return res.status(200).json({
          success: true,
          complete: true,
          message: "All alerts reviewed",
        });
      }

      const alert = alerts[alertIndex];

      // Analyze with Claude
      const analysis = await analyzeAlertWithClaude(alert, knowledgeBase);

      res.status(200).json({
        success: true,
        alert,
        analysis,
        progress: {
          current: alertIndex + 1,
          total: alerts.length,
        },
      });
    } else if (action === "record_decision") {
      // Record user's decision
      const { sessionId, alertIndex, decision } = req.body;

      const alertsJson = await redisClient.get(`triage_alerts:${sessionId}`);
      if (!alertsJson) {
        return res.status(404).json({ error: "Session not found" });
      }

      const alerts = JSON.parse(alertsJson);
      const alert = alerts[alertIndex];

      // Log to TriageLog
      await logDecision(sheets, automationCommanderSheetId, {
        alertType: alert.type,
        alertId: `${alert.sheetName}-${alert.rowNumber}`,
        client: alert.data[0] || "Unknown",
        amount: alert.data[4] || "",
        claudeRecommendation: alert.analysis,
        userAction: decision.action,
        userCorrection: decision.correction || "",
      });

      res.status(200).json({
        success: true,
        message: "Decision recorded",
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
