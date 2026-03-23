import { google } from "googleapis";
import * as Redis from "redis";
import Anthropic from "@anthropic-ai/sdk";

const sheets = google.sheets("v4");
const redis = Redis.createClient({
  url: process.env.REDIS_URL,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const auth = new google.auth.GoogleAuth({
  projectId: process.env.SERVICE_ACCOUNT_PROJECT_ID,
  credentials: {
    type: "service_account",
    project_id: process.env.SERVICE_ACCOUNT_PROJECT_ID,
    private_key_id: process.env.SERVICE_ACCOUNT_PRIVATE_KEY_ID,
    private_key: process.env.SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    client_email: process.env.SERVICE_ACCOUNT_EMAIL,
    client_id: process.env.SERVICE_ACCOUNT_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  },
});

// ============================================================================
// HELPER: Extract sheet ID from Google Sheets URL
// ============================================================================
function extractSheetId(url) {
  if (!url) return null;
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

// ============================================================================
// HELPER: Read a sheet range
// ============================================================================
async function readSheetRange(spreadsheetId, range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      auth,
      spreadsheetId,
      range,
    });
    return response.data.values || [];
  } catch (err) {
    console.error(`❌ Error reading ${range}:`, err.message);
    throw err;
  }
}

// ============================================================================
// HELPER: Write to sheet (append)
// ============================================================================
async function appendToSheet(spreadsheetId, range, values) {
  try {
    await sheets.spreadsheets.values.append({
      auth,
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [values],
      },
    });
  } catch (err) {
    console.error(`❌ Error writing to ${range}:`, err.message);
  }
}

// ============================================================================
// HELPER: Read tolerance values from DataChgAlert
// ============================================================================
async function getToleranceValues(masterSheetId) {
  try {
    const data = await readSheetRange(masterSheetId, "DataChgAlert!F39,J111");
    return {
      invoiceMonthsTolerance: data[0]?.[0] || 2,
      expenseMonthsTolerance: data[1]?.[0] || 1,
    };
  } catch (err) {
    console.log("⚠️ Using default tolerance values");
    return {
      invoiceMonthsTolerance: 2,
      expenseMonthsTolerance: 1,
    };
  }
}

// ============================================================================
// HELPER: Get CRM matching target tab (Pipeline or Confirmed)
// ============================================================================
async function getCRMMatchingMode(masterSheetId) {
  try {
    // CRMComp cell B2 contains the mode switch (Confirmed or Pipeline)
    const data = await readSheetRange(masterSheetId, "CRMComp!B2:B2");
    const mode = data[0]?.[0];
    return mode === "Confirmed" ? "Confirmed" : "Pipeline";
  } catch (err) {
    return "Confirmed"; // Default to Confirmed
  }
}

// ============================================================================
// HELPER: Read Confirmed/Pipeline tab for CRM matching
// ============================================================================
async function readJobsForCRMMatching(clientSheetId, tab) {
  try {
    // Read key columns from Confirmed or Pipeline tab
    const data = await readSheetRange(clientSheetId, `${tab}!A2:BH1000`);
    return data;
  } catch (err) {
    console.error(`Error reading ${tab}:`, err.message);
    return [];
  }
}

// ============================================================================
// HELPER: Read Outgoings tab for expense matching
// ============================================================================
async function readOutgoingsForExpenseMatching(clientSheetId) {
  try {
    // Outgoings: Column A has categories, columns G+ have months
    const data = await readSheetRange(clientSheetId, "Outgoings!A2:Z1000");
    return data;
  } catch (err) {
    console.error(`Error reading Outgoings:`, err.message);
    return [];
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================
export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const action = req.body?.action || req.query?.action;

  console.log(`📍 API Request: method=${req.method}, action=${action}`);

  if (action === "start_triage") {
    return await startTriage(req, res);
  } else if (action === "get_alerts") {
    return await getAlerts(req, res);
  } else if (action === "analyze_alert") {
    return await analyzeAlert(req, res);
  } else if (action === "record_decision") {
    return await recordDecision(req, res);
  } else {
    return res.status(400).json({ error: "Unknown action" });
  }
}

// ============================================================================
// ACTION: START TRIAGE
// ============================================================================
async function startTriage(req, res) {
  try {
    const { automationCommanderSheetId } = req.body;

    if (!automationCommanderSheetId) {
      return res.status(400).json({ error: "Missing automationCommanderSheetId" });
    }

    console.log(`🔍 Reading AutoUpdates...`);

    // Read AutoUpdates
    const autoUpdates = await readSheetRange(
      automationCommanderSheetId,
      "AutoUpdates!A2:M1000"
    );

    // Read all flags (CW:HE)
    console.log(`⏱️ Fetching flags...`);
    const flagsData = await readSheetRange(
      automationCommanderSheetId,
      "AutoUpdates!CW2:HE1000"
    );

    // Read AIKnowledgeBase
    console.log(`📚 Reading AIKnowledgeBase...`);
    const knowledgeBase = await readSheetRange(
      automationCommanderSheetId,
      "AIKnowledgeBase!A2:E1000"
    );

    const allAlerts = [];

    // Process each client
    for (let i = 0; i < autoUpdates.length; i++) {
      const row = autoUpdates[i];
      const clientName = row[0];
      const masterSheetUrl = row[12]; // M
      const clientSheetUrl = row[11]; // L

      if (!clientName || !masterSheetUrl || !clientSheetUrl) continue;

      console.log(`\n🔹 Processing client: ${clientName}`);

      const masterSheetId = extractSheetId(masterSheetUrl);
      const clientSheetId = extractSheetId(clientSheetUrl);

      if (!masterSheetId || !clientSheetId) continue;

      const clientFlags = flagsData[i] || [];

      // Check flags (relative to CW which is column 76)
      const hasInvoiceAlerts = clientFlags[0]; // CW (76)
      const hasExpenseAlerts = clientFlags[84 - 76]; // GC (84)
      const hasCRMAlerts = clientFlags[14 - 0]; // DK (90)

      console.log(`  Invoice: ${!!hasInvoiceAlerts}, Expense: ${!!hasExpenseAlerts}, CRM: ${!!hasCRMAlerts}`);

      // Get tolerances
      const tolerances = await getToleranceValues(masterSheetId);

      // Read matching targets
      const crmMode = await getCRMMatchingMode(masterSheetId);
      const confirmedJobs = await readJobsForCRMMatching(clientSheetId, "Confirmed");
      const pipelineJobs = await readJobsForCRMMatching(clientSheetId, "Pipeline");
      const outgoings = await readOutgoingsForExpenseMatching(clientSheetId);

      // Process each alert type
      if (hasInvoiceAlerts) {
        const invAlerts = await readInvoiceAlerts(
          masterSheetId,
          clientName,
          confirmedJobs,
          tolerances
        );
        allAlerts.push(...invAlerts);
      }

      if (hasExpenseAlerts) {
        const expAlerts = await readExpenseAlerts(
          masterSheetId,
          clientName,
          outgoings,
          tolerances
        );
        allAlerts.push(...expAlerts);
      }

      if (hasCRMAlerts) {
        const targetJobs = crmMode === "Confirmed" ? confirmedJobs : pipelineJobs;
        const crmAlerts = await readCRMAlerts(
          masterSheetId,
          clientName,
          targetJobs,
          crmMode
        );
        allAlerts.push(...crmAlerts);
      }
    }

    console.log(`\n📊 Total alerts: ${allAlerts.length}`);

    // Store in Redis
    const sessionId = Math.random().toString(36).substr(2, 9);
    const sessionData = {
      alerts: allAlerts,
      knowledgeBase,
      automationCommanderSheetId,
      createdAt: new Date().toISOString(),
    };

    await redis.setEx(
      `triage_session:${sessionId}`,
      86400,
      JSON.stringify(sessionData)
    );

    console.log(`✅ Session: ${sessionId}`);

    return res.status(200).json({
      success: true,
      sessionId,
      totalAlerts: allAlerts.length,
      alertSummary: {
        invoices: allAlerts.filter((a) => a.type === "INVOICE").length,
        expenses: allAlerts.filter((a) => a.type === "EXPENSE").length,
        crm: allAlerts.filter((a) => a.type === "CRM").length,
      },
    });
  } catch (err) {
    console.error(`❌ Error:`, err);
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================================
// Read Invoice Alerts from InvComp
// ============================================================================
async function readInvoiceAlerts(masterSheetId, clientName, confirmedJobs, tolerances) {
  try {
    const data = await readSheetRange(masterSheetId, "InvComp!A6:Y1000");
    const alerts = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      // Discrepancy flags in S-Y (columns 18-24)
      const hasDisc = [18, 19, 20, 21, 22, 23, 24].some((col) => row[col]);

      if (hasDisc) {
        alerts.push({
          type: "INVOICE",
          clientName,
          sheetName: "InvComp",
          rowIndex: i + 6,
          data: {
            client: row[0],
            job: row[1],
            invoiceAmount: parseFloat(String(row[2] || 0).replace(/,/g, "")),
            totalExclVAT: parseFloat(String(row[3] || 0).replace(/,/g, "")),
            vatIncluded: parseFloat(String(row[4] || 0).replace(/,/g, "")),
            invoiceNo: row[5],
            sentDate: row[6],
            dueDate: row[7],
            fullyPaidOn: row[8],
            status: row[9],
            currency: row[10],
          },
          discrepancies: getInvoiceDiscrepancies(row),
          matchingContext: {
            confirmedJobs,
            monthsTolerance: tolerances.invoiceMonthsTolerance,
          },
        });
      }
    }

    console.log(`  ✓ Invoice alerts: ${alerts.length}`);
    return alerts;
  } catch (err) {
    console.error(`  ❌ Error reading InvComp:`, err.message);
    return [];
  }
}

// ============================================================================
// Read Expense Alerts from DirComp
// ============================================================================
async function readExpenseAlerts(masterSheetId, clientName, outgoings, tolerances) {
  try {
    const data = await readSheetRange(masterSheetId, "DirComp!A6:AV1000");
    const alerts = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      // Discrepancy flags in AO-AV (columns 40-47)
      const hasDisc = [40, 41, 42, 43, 44, 45, 46, 47].some((col) => row[col]);

      if (hasDisc) {
        alerts.push({
          type: "EXPENSE",
          clientName,
          sheetName: "DirComp",
          rowIndex: i + 6,
          data: {
            expenseRef: row[0],
            client: row[1],
            vendor: row[2],
            amount: parseFloat(String(row[3] || 0).replace(/,/g, "")),
            date: row[4],
            category: row[5],
            status: row[6],
            appId: row[7],
          },
          discrepancies: getExpenseDiscrepancies(row),
          matchingContext: {
            outgoings,
            monthsTolerance: tolerances.expenseMonthsTolerance,
          },
        });
      }
    }

    console.log(`  ✓ Expense alerts: ${alerts.length}`);
    return alerts;
  } catch (err) {
    console.error(`  ❌ Error reading DirComp:`, err.message);
    return [];
  }
}

// ============================================================================
// Read CRM Alerts from CRMComp
// ============================================================================
async function readCRMAlerts(masterSheetId, clientName, targetJobs, mode) {
  try {
    const data = await readSheetRange(masterSheetId, "CRMComp!A6:FL1000");
    const alerts = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      // Left section: AY-BF (50-57), Right section: FE-FL (158-165)
      const leftDisc = [50, 51, 52, 53, 54, 55, 56, 57].some((col) => row[col]);
      const rightDisc = [158, 159, 160, 161, 162, 163, 164, 165].some((col) => row[col]);

      if (leftDisc || rightDisc) {
        alerts.push({
          type: "CRM",
          clientName,
          sheetName: "CRMComp",
          rowIndex: i + 6,
          section: leftDisc ? "dashboard_to_crm" : "crm_to_dashboard",
          mode,
          data: {
            projectCode: row[0],
            client: row[1],
            jobName: row[2],
            revenue: parseFloat(String(row[3] || 0).replace(/,/g, "")),
            directCosts: parseFloat(String(row[4] || 0).replace(/,/g, "")),
            startDate: row[5],
            endDate: row[6],
          },
          discrepancies: getCRMDiscrepancies(row, leftDisc),
          matchingContext: {
            targetJobs,
            mode,
          },
        });
      }
    }

    console.log(`  ✓ CRM alerts: ${alerts.length}`);
    return alerts;
  } catch (err) {
    console.error(`  ❌ Error reading CRMComp:`, err.message);
    return [];
  }
}

// ============================================================================
// Get Discrepancy Details
// ============================================================================
function getInvoiceDiscrepancies(row) {
  const flags = [
    "Missing invoice?",
    "Client mismatch?",
    "Invoice amount mismatch?",
    "Sent date mismatch?",
    "Duplicate invoice no?",
    "Fully paid on mismatch?",
    "Status mismatch?",
  ];
  return flags
    .map((flag, idx) => (row[18 + idx] ? flag : null))
    .filter(Boolean);
}

function getExpenseDiscrepancies(row) {
  const flags = [
    "Missing cost?",
    "Duplicate app ID?",
    "Description mismatch?",
    "Amount mismatch?",
    "VAT mismatch?",
    "Reconciliation date mismatch?",
    "Payment date mismatch?",
    "Status mismatch?",
  ];
  return flags
    .map((flag, idx) => (row[40 + idx] ? flag : null))
    .filter(Boolean);
}

function getCRMDiscrepancies(row, isLeftSection) {
  const flags = [
    "Missing job?",
    "Client mismatch?",
    "Job name mismatch?",
    "Revenue mismatch?",
    "Direct costs mismatch?",
    "Start date mismatch?",
    "End date mismatch?",
    "Likelihood % mismatch?",
  ];
  const baseCol = isLeftSection ? 50 : 158;
  return flags
    .map((flag, idx) => (row[baseCol + idx] ? flag : null))
    .filter(Boolean);
}

// ============================================================================
// ACTION: GET ALERTS
// ============================================================================
async function getAlerts(req, res) {
  try {
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({ error: "Missing sessionId" });
    }

    const sessionData = await redis.get(`triage_session:${sessionId}`);
    if (!sessionData) {
      return res.status(404).json({ error: "Session not found" });
    }

    const parsed = JSON.parse(sessionData);

    return res.status(200).json({
      success: true,
      alerts: parsed.alerts,
    });
  } catch (err) {
    console.error(`❌ Error:`, err);
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================================
// ACTION: ANALYZE ALERT with Claude
// ============================================================================
async function analyzeAlert(req, res) {
  try {
    const { sessionId, alertIndex } = req.body;

    const sessionData = await redis.get(`triage_session:${sessionId}`);
    if (!sessionData) {
      return res.status(404).json({ error: "Session not found" });
    }

    const parsed = JSON.parse(sessionData);
    const alert = parsed.alerts[alertIndex];
    const knowledgeBase = parsed.knowledgeBase;

    if (!alert) {
      return res.status(404).json({ error: "Alert not found" });
    }

    console.log(`🤖 Analyzing ${alert.type} alert`);

    let prompt = "";
    if (alert.type === "INVOICE") {
      prompt = buildInvoicePrompt(alert, knowledgeBase);
    } else if (alert.type === "EXPENSE") {
      prompt = buildExpensePrompt(alert, knowledgeBase);
    } else if (alert.type === "CRM") {
      prompt = buildCRMPrompt(alert, knowledgeBase);
    }

    console.log(`📋 Prompt length: ${prompt.length} chars`);

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const responseText =
      message.content[0].type === "text" ? message.content[0].text : "";

    const options = JSON.parse(responseText);

    console.log(`✅ Generated ${options.length} options`);

    return res.status(200).json({
      success: true,
      alert,
      options,
      progress: {
        current: alertIndex + 1,
        total: parsed.alerts.length,
      },
    });
  } catch (err) {
    console.error(`❌ Error:`, err);
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================================
// PROMPT BUILDERS
// ============================================================================

function buildInvoicePrompt(alert, knowledgeBase) {
  const kb = knowledgeBase
    .filter((row) => row[0] === "INVOICE_MATCHING")
    .map((row) => `- **${row[2]}**: ${row[3]}`)
    .join("\n");

  return `You are analyzing an unmatched invoice that the automation system couldn't match to a planned job.

UNMATCHED INVOICE:
- Reference: ${alert.data.invoiceNo}
- Amount: £${(alert.data.totalExclVAT || alert.data.invoiceAmount).toFixed(2)}
- Client: ${alert.data.client}
- Description: ${alert.data.job}
- Sent: ${alert.data.sentDate}
- Status: ${alert.data.status}
- Currency: ${alert.data.currency}

WHY AUTOMATION COULDN'T MATCH IT:
${alert.discrepancies.map((d) => `- ${d}`).join("\n")}

AVAILABLE RULES & TOLERANCES:
${kb}
- Date tolerance: ±${alert.matchingContext.monthsTolerance} months

YOUR TASK:
1. Analyze the discrepancies and suggest 2-3 realistic resolution options
2. For each option, provide structured facts about the match
3. Return ONLY a JSON array with fields: optionId, title, jobName, facts (object), recommendedActions (array)

Example facts object:
{ "totalRevenue": 15950, "startDate": "3-Mar-26", "endDate": "31-Aug-26", "existingInvoices": "0820 £7,975 + 0821 £5,725 = £13,700", "remainingToInvoice": 2250, "matchStatus": "EXACT MATCH", "discrepancies": "Invoice date within tolerance" }

Return ONLY JSON, no other text.`;
}

function buildExpensePrompt(alert, knowledgeBase) {
  const kb = knowledgeBase
    .filter((row) => row[0] === "EXPENSE_MATCHING")
    .map((row) => `- **${row[2]}**: ${row[3]}`)
    .join("\n");

  return `You are analyzing an unmatched expense that needs reconciliation.

UNMATCHED EXPENSE:
- Reference: ${alert.data.expenseRef}
- Amount: £${alert.data.amount.toFixed(2)}
- Client: ${alert.data.client}
- Vendor: ${alert.data.vendor}
- Category: ${alert.data.category}
- Date: ${alert.data.date}
- Status: ${alert.data.status}

WHY AUTOMATION COULDN'T MATCH IT:
${alert.discrepancies.map((d) => `- ${d}`).join("\n")}

AVAILABLE RULES & TOLERANCES:
${kb}
- Date tolerance: ±${alert.matchingContext.monthsTolerance} months

YOUR TASK:
1. Suggest which Outgoings category this should match to
2. Provide 2-3 realistic reconciliation options
3. Return ONLY a JSON array with fields: optionId, title, category, facts, recommendedActions

Return ONLY JSON, no other text.`;
}

function buildCRMPrompt(alert, knowledgeBase) {
  const kb = knowledgeBase
    .filter((row) => row[0] === "CRM_MATCHING")
    .map((row) => `- **${row[2]}**: ${row[3]}`)
    .join("\n");

  const direction =
    alert.section === "dashboard_to_crm"
      ? "Dashboard job not found in CRM"
      : "CRM job not found in Dashboard";

  return `You are analyzing a CRM sync discrepancy between Dashboard and CRM system.

CRM MISMATCH (${direction}):
- Project Code: ${alert.data.projectCode}
- Client: ${alert.data.client}
- Job Name: ${alert.data.jobName}
- Revenue: £${alert.data.revenue.toFixed(2)}
- Start Date: ${alert.data.startDate}
- End Date: ${alert.data.endDate}
- Matching to: ${alert.mode} tab

DISCREPANCIES:
${alert.discrepancies.map((d) => `- ${d}`).join("\n")}

AVAILABLE RULES:
${kb}

YOUR TASK:
1. Determine if this is a legitimate mismatch or sync issue
2. Suggest 2-3 resolution options
3. Return ONLY a JSON array with fields: optionId, title, jobName, facts, recommendedActions

Return ONLY JSON, no other text.`;
}

// ============================================================================
// ACTION: RECORD DECISION
// ============================================================================
async function recordDecision(req, res) {
  try {
    const { sessionId, alertIndex, decision } = req.body;

    const sessionData = await redis.get(`triage_session:${sessionId}`);
    if (!sessionData) {
      return res.status(404).json({ error: "Session not found" });
    }

    const parsed = JSON.parse(sessionData);
    const alert = parsed.alerts[alertIndex];
    const automationCommanderSheetId = parsed.automationCommanderSheetId;

    console.log(`📝 Recording decision: ${decision.action}`);

    // Log to TriageLog
    const timestamp = new Date().toISOString();
    const logRow = [
      timestamp,
      alert.type,
      `${alert.sheetName}-${alert.rowIndex}`,
      alert.clientName,
      alert.data.amount || alert.data.invoiceAmount || alert.data.revenue || "",
      JSON.stringify(decision.claudeRecommendation || {}),
      decision.action,
      decision.notes || "",
    ];

    await appendToSheet(automationCommanderSheetId, "TriageLog!A2:H2", logRow);

    console.log(`✅ Decision logged`);

    return res.status(200).json({
      success: true,
      message: "Decision recorded",
    });
  } catch (err) {
    console.error(`❌ Error:`, err);
    return res.status(500).json({ error: err.message });
  }
}