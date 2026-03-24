/**
 * /api/cron.js
 * Background pre-computation endpoint for the Alert Triage System.
 *
 * Called by a Google Apps Script time trigger every 2 hours.
 * Runs the full triage pipeline (flag reading + sheet reads + Claude analysis)
 * and stores the result in Redis under the key "triage_precomputed".
 *
 * Claude is only called for alerts whose fingerprint is NOT already in
 * AlertMemory — so after the first run, only genuinely new/changed alerts
 * trigger a Claude call. All others return from cache instantly.
 */

import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { createClient } from "redis";
import { createHash } from "crypto";

// ── Shared imports from triage.js ──────────────────────────────────────────
// We re-import the helpers we need rather than trying to import from triage.js
// (Next.js API routes don't support cross-file imports of default exports).
// The key functions are duplicated here — any changes to the matching logic
// in triage.js should also be reflected here.

const anthropic = new Anthropic();

const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

const PRECOMPUTED_KEY = "triage_precomputed";
const PRECOMPUTED_MAX_AGE_MS = 3 * 60 * 60 * 1000; // 3 hours
const AUTOMATION_COMMANDER_SHEET_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
const ALERT_MEMORY_TAB = "AlertMemory";

const NO_ACTION_FLAGS = [
  "invoiceAppDiscr", "crmPipeSkippedBlank", "crmConfSkippedBlank",
  "crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete",
  "retainerInvoicesCreated", "expenseAppDiscr", "expenseAdded",
  "expenseUnreconGaps", "invoiceStaleUnsentChanges",
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

const FLAG_COLUMNS = {
  invoiceDashboardDiscr: "CW", invoiceAppDiscr: "DD",
  crmPipeDashDiscr: "DK", crmPipeAppDiscr: "DR",
  crmConfDashDiscr: "DY", crmConfAppDiscr: "EF",
  crmPipeSkippedBlank: "EM", crmConfSkippedBlank: "ET",
  crmCopiedConfChecked: "FA", crmCopiedConfUnchecked: "FH",
  crmCopiedConfDelete: "FO", retainerInvoicesCreated: "FV",
  expenseDashboardDiscr: "GC", expenseAppDiscr: "GJ",
  expenseAdded: "GQ", expenseUnreconGaps: "GX",
  invoiceStaleUnsentChanges: "HE",
};

// ── Google Sheets auth ──────────────────────────────────────────────────────

function getGoogleAuth() {
  let privateKey = process.env.SERVICE_ACCOUNT_PRIVATE_KEY || "";
  privateKey = privateKey.replace(/\\n/g, "\n");
  return new google.auth.GoogleAuth({
    credentials: {
      type: "service_account",
      project_id: process.env.SERVICE_ACCOUNT_PROJECT_ID,
      private_key_id: process.env.SERVICE_ACCOUNT_PRIVATE_KEY_ID,
      private_key: privateKey,
      client_email: process.env.SERVICE_ACCOUNT_EMAIL,
      client_id: process.env.SERVICE_ACCOUNT_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getGoogleAuth() });
}

// ── Fingerprint ─────────────────────────────────────────────────────────────

function buildAlertFingerprint(alert) {
  const parts = [alert.type || "", alert.flagType || alert.alertType || ""];
  if (alert.data) {
    if (alert.data.accounting) parts.push(JSON.stringify(alert.data.accounting));
    if (alert.data.confirmed)  parts.push(JSON.stringify(alert.data.confirmed));
    if (alert.data.crmData)    parts.push(JSON.stringify(alert.data.crmData));
    if (alert.data.sheetData)  parts.push(JSON.stringify(alert.data.sheetData));
    if (alert.data.flags)      parts.push(JSON.stringify(alert.data.flags));
  }
  return createHash("sha256").update(parts.join("|")).digest("hex").substring(0, 16);
}

// ── AlertMemory helpers ─────────────────────────────────────────────────────

async function readAlertMemory(sheets) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: AUTOMATION_COMMANDER_SHEET_ID,
      range: `${ALERT_MEMORY_TAB}!A:I`,
    });
    const rows = response.data.values || [];
    if (rows.length < 2) return [];
    return rows.slice(1).map((row, i) => ({
      rowIndex: i + 2,
      fingerprintHash:   row[0] || "",
      alertType:         row[1] || "",
      clientName:        row[2] || "",
      alertSummary:      row[3] || "",
      cachedOptionsJSON: row[4] || "",
      status:            row[5] || "cached",
      ignoreReason:      row[6] || "",
      firstSeen:         row[7] || "",
      lastSeen:          row[8] || "",
    }));
  } catch (err) {
    console.log(`⚠️ Could not read AlertMemory: ${err.message}`);
    return [];
  }
}

async function appendAlertMemoryRow(sheets, { fingerprintHash, alertType, clientName, alertSummary, cachedOptionsJSON, status }) {
  const now = new Date().toISOString().split("T")[0];
  await sheets.spreadsheets.values.append({
    spreadsheetId: AUTOMATION_COMMANDER_SHEET_ID,
    range: `${ALERT_MEMORY_TAB}!A:I`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[fingerprintHash, alertType, clientName, alertSummary, cachedOptionsJSON, status, "", now, now]],
    },
  });
}

async function updateAlertMemoryRow(sheets, rowIndex, updates) {
  const now = new Date().toISOString().split("T")[0];
  await sheets.spreadsheets.values.update({
    spreadsheetId: AUTOMATION_COMMANDER_SHEET_ID,
    range: `${ALERT_MEMORY_TAB}!A${rowIndex}:I${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        updates.fingerprintHash, updates.alertType, updates.clientName,
        updates.alertSummary, updates.cachedOptionsJSON, updates.status,
        updates.ignoreReason || "", updates.firstSeen, now,
      ]],
    },
  });
}

// ── Sheet reading helpers (copied from triage.js) ──────────────────────────

function extractSheetIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

async function ensureFreshData(sheets, spreadsheetId, sheetName) {
  await new Promise(r => setTimeout(r, 500));
  try { await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A1` }); } catch (e) {}
  await new Promise(r => setTimeout(r, 500));
}

async function setMasterSwitch(sheets, spreadsheetId, sheetName, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${sheetName}!E2`,
    valueInputOption: "RAW", requestBody: { values: [[value]] },
  });
  await ensureFreshData(sheets, spreadsheetId, sheetName);
}

async function setCRMMode(sheets, spreadsheetId, mode) {
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: "CRMComp!B2",
    valueInputOption: "RAW", requestBody: { values: [[mode]] },
  });
  await ensureFreshData(sheets, spreadsheetId, "CRMComp");
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
    return { invoiceMonthsTolerance: 2, expenseMonthsTolerance: 1, defaultDaysToPay: 30 };
  }
}

async function readAIKnowledgeBase(sheets) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: AUTOMATION_COMMANDER_SHEET_ID,
      range: "AIKnowledgeBase!A2:E1000",
    });
    return response.data.values || [];
  } catch (err) {
    return [];
  }
}

// ── Flag & alert reading (copied from triage.js) ───────────────────────────

async function getClientFlags(sheets) {
  const mainResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: AUTOMATION_COMMANDER_SHEET_ID,
    range: "AutoUpdates!A2:M1000",
  });
  const rows = mainResponse.data.values || [];
  if (rows.length === 0) throw new Error("AutoUpdates sheet appears empty");

  const flagsResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: AUTOMATION_COMMANDER_SHEET_ID,
    range: "AutoUpdates!CW2:HE1000",
  });
  const flagRows = flagsResponse.data.values || [];
  const clients = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 13) continue;
    const clientName = String(row[0] || "").trim();
    const clientSheetUrl = row[11];
    const masterSheetUrl = row[12];
    if (!clientName || !clientSheetUrl || !masterSheetUrl) continue;

    const clientId = extractSheetIdFromUrl(clientSheetUrl);
    const masterId = extractSheetIdFromUrl(masterSheetUrl);
    if (!clientId || !masterId) continue;

    const flagRow = flagRows[i] || [];
    const flags = {
      invoiceDashboardDiscr:   String(flagRow[0]   || "").toUpperCase() === "TRUE",
      invoiceAppDiscr:         String(flagRow[7]   || "").toUpperCase() === "TRUE",
      crmPipeDashDiscr:        String(flagRow[14]  || "").toUpperCase() === "TRUE",
      crmPipeAppDiscr:         String(flagRow[21]  || "").toUpperCase() === "TRUE",
      crmConfDashDiscr:        String(flagRow[28]  || "").toUpperCase() === "TRUE",
      crmConfAppDiscr:         String(flagRow[35]  || "").toUpperCase() === "TRUE",
      crmPipeSkippedBlank:     String(flagRow[42]  || "").toUpperCase() === "TRUE",
      crmConfSkippedBlank:     String(flagRow[49]  || "").toUpperCase() === "TRUE",
      crmCopiedConfChecked:    String(flagRow[56]  || "").toUpperCase() === "TRUE",
      crmCopiedConfUnchecked:  String(flagRow[63]  || "").toUpperCase() === "TRUE",
      crmCopiedConfDelete:     String(flagRow[70]  || "").toUpperCase() === "TRUE",
      retainerInvoicesCreated: String(flagRow[77]  || "").toUpperCase() === "TRUE",
      expenseDashboardDiscr:   String(flagRow[84]  || "").toUpperCase() === "TRUE",
      expenseAppDiscr:         String(flagRow[91]  || "").toUpperCase() === "TRUE",
      expenseAdded:            String(flagRow[98]  || "").toUpperCase() === "TRUE",
      expenseUnreconGaps:      String(flagRow[105] || "").toUpperCase() === "TRUE",
      invoiceStaleUnsentChanges: String(flagRow[112] || "").toUpperCase() === "TRUE",
    };

    if (Object.values(flags).some(v => v)) {
      clients.push({ clientName, clientSheetId: clientId, masterSheetId: masterId, clientSheetUrl, masterSheetUrl, flags });
    }
  }
  return clients;
}

function buildInvCompSummary(alert) {
  const accounting = alert.data.accounting || [];
  const invoiceAmount = parseFloat(String(accounting[2] || "0").replace(/,/g, "")) || 0;
  const totalExclVAT = parseFloat(String(accounting[3] || "0").replace(/,/g, "")) || 0;
  const vatIncluded  = parseFloat(String(accounting[4] || "0").replace(/,/g, "")) || 0;
  const invoiceNo = accounting[5] || "(no reference)";
  const sentDate  = accounting[6] || "";
  const datePaid  = accounting[8] || "";
  const status    = accounting[9] || "";
  const currency  = accounting[10] || "GBP";
  const client    = accounting[0] || "";
  const job       = accounting[1] || "";
  const amount = totalExclVAT > 0 ? totalExclVAT : invoiceAmount;
  const vatSuffix = vatIncluded > 0 ? " + VAT" : "";
  const formattedAmount = amount > 0
    ? `${currency}${amount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${vatSuffix}`
    : "unknown amount";
  let summary = `Invoice ${invoiceNo} • ${formattedAmount} • ${client}`;
  if (job) summary += ` • ${job}`;
  if (sentDate) summary += ` • Sent ${sentDate}`;
  if (status) summary += ` • ${status}`;
  return { invoiceNo, amount, vatIncluded, currency, client, job, sentDate, datePaid, status, summary };
}

function buildDirCompSummary(alert) {
  const accounting = alert.data.accounting || [];
  const amount = parseFloat(String(accounting[2] || "0").replace(/,/g, "")) || 0;
  const reference   = accounting[3] || "";
  const description = accounting[1] || "";
  const date        = accounting[0] || "";
  const accountName = accounting[4] || "";
  const status      = accounting[5] || "";
  const transactionId = accounting[6] || "";
  const datePaid    = accounting[7] || "";
  const vatAmount   = accounting[8] || "";
  let summary = `Expense ${reference || date} • £${amount.toFixed(2)}`;
  if (description) summary += ` • ${description}`;
  return { reference, amount, description, date, accountName, status, transactionId, datePaid, vatAmount, summary };
}

async function readInvCompAlerts(sheets, spreadsheetId) {
  try {
    await setMasterSwitch(sheets, spreadsheetId, "InvComp", true);
    const headerResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: "InvComp!A5:Y5" });
    const headers = (headerResponse.data.values || [[]])[0] || [];
    const dataResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: "InvComp!A6:Y1000" });
    const rows = dataResponse.data.values || [];
    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;
      const hasDiscrepancy = [18, 19, 20, 21, 23, 24].some(idx => String(row[idx] || "").trim() === "1");
      if (hasDiscrepancy) {
        const alert = {
          type: "invoice", sheetName: "InvComp", rowNumber: 6 + rowIdx,
          data: { accounting: row.slice(0, 11), confirmed: row.slice(12, 18), flags: row.slice(18, 25) },
          flagColumns: headers.slice(18, 25),
        };
        alert.summary = buildInvCompSummary(alert);
        alerts.push(alert);
      }
    }
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading InvComp:`, error.message);
    return [];
  }
}

async function readDirCompAlerts(sheets, spreadsheetId) {
  try {
    await setMasterSwitch(sheets, spreadsheetId, "DirComp", true);
    const headerResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: "DirComp!A5:AV5" });
    const headers = (headerResponse.data.values || [[]])[0] || [];
    const dataResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: "DirComp!A6:AV1000" });
    const rows = dataResponse.data.values || [];
    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;
      const hasDiscrepancy = [40, 42, 43, 44, 45, 46, 47].some(idx => String(row[idx] || "").trim() === "1");
      if (hasDiscrepancy) {
        const alert = {
          type: "expense", sheetName: "DirComp", rowNumber: 7 + rowIdx,
          data: { accounting: row.slice(0, 10), confirmed: row.slice(23, 34), flags: row.slice(40, 48) },
          flagColumns: headers.slice(40, 48),
        };
        alert.summary = buildDirCompSummary(alert);
        alerts.push(alert);
      }
    }
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading DirComp:`, error.message);
    return [];
  }
}

async function readCRMCompAlerts(sheets, spreadsheetId, mode, alertTypes) {
  try {
    await setCRMMode(sheets, spreadsheetId, mode);
    await setMasterSwitch(sheets, spreadsheetId, "CRMComp", true);
    const alerts = [];
    for (const alertType of alertTypes) {
      let dataRange, crmDataCols, sheetDataCols, flagStartIdx;
      if (mode === "Pipeline" && alertType === "crmPipeDashDiscr") {
        dataRange = "CRMComp!X6:BF1000"; crmDataCols = [0, 13]; sheetDataCols = [14, 24]; flagStartIdx = 24;
      } else if (mode === "Pipeline" && alertType === "crmPipeAppDiscr") {
        dataRange = "CRMComp!EF6:FL1000"; sheetDataCols = [0, 12]; crmDataCols = [13, 23]; flagStartIdx = 24;
      } else if (mode === "Confirmed" && alertType === "crmConfDashDiscr") {
        dataRange = "CRMComp!X6:BF1000"; crmDataCols = [0, 13]; sheetDataCols = [14, 24]; flagStartIdx = 24;
      } else if (mode === "Confirmed" && alertType === "crmConfAppDiscr") {
        dataRange = "CRMComp!EF6:FL1000"; sheetDataCols = [0, 12]; crmDataCols = [13, 23]; flagStartIdx = 24;
      } else { continue; }

      const dataResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: dataRange });
      const rows = dataResponse.data.values || [];
      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (!row || row.length === 0) continue;
        const hasDiscrepancy = [0,1,2,3,4,5,6,7].map(n => flagStartIdx + n).some(idx => String(row[idx] || "").trim() === "1");
        if (hasDiscrepancy) {
          alerts.push({
            type: "crm", alertType, mode, sheetName: "CRMComp", rowNumber: 7 + rowIdx,
            data: {
              crmData: row.slice(crmDataCols[0], crmDataCols[1]),
              sheetData: row.slice(sheetDataCols[0], sheetDataCols[1]),
              flags: row.slice(flagStartIdx, flagStartIdx + 8),
            },
          });
        }
      }
    }
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading CRMComp:`, error.message);
    return [];
  }
}

// ── Claude analysis for a single alert ─────────────────────────────────────
// Returns options array (from cache or fresh Claude call).

async function analyseAlertWithClaude(sheets, alert, memoryRows) {
  const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);

  // Check cache first
  const memoryRow = memoryRows.find(r => r.fingerprintHash === fingerprintHash);
  if (memoryRow && memoryRow.status === "cached" && memoryRow.cachedOptionsJSON) {
    try {
      const cached = JSON.parse(memoryRow.cachedOptionsJSON);
      if (cached.length > 0) {
        console.log(`    ⚡ Cache hit: ${fingerprintHash}`);
        // Update lastSeen
        await updateAlertMemoryRow(sheets, memoryRow.rowIndex, { ...memoryRow });
        return { options: cached, fromCache: true };
      }
    } catch (e) { /* fall through to Claude */ }
  }

  console.log(`    🤖 Calling Claude: ${fingerprintHash} (${alert.type} / ${alert.clientName})`);

  const knowledgeBase = await readAIKnowledgeBase(sheets);
  const tolerances = await getToleranceValues(sheets, alert.masterSheetId || alert.clientId);

  let options = [];
  let alertSummary = "";
  let alertType = alert.type || "unknown";

  // ── Invoice ────────────────────────────────────────────────────────────
  if (alert.type === "invoice" || alert.sheetName === "InvComp") {
    alertType = "invoice";
    const confirmedResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: alert.clientId,
      range: "Confirmed!A1:CR500",
    });
    let confirmedData = confirmedResponse.data.values || [];
    if (confirmedData.length === 500) {
      const full = await sheets.spreadsheets.values.get({ spreadsheetId: alert.clientId, range: "Confirmed!A1:CR5000" });
      confirmedData = full.data.values || [];
    }

    let lastDataRow = 1;
    for (let row = confirmedData.length - 1; row > 0; row--) {
      const rowData = confirmedData[row] || [];
      const cols = [0,1,2,3,4,32,33,34,35,36,37,38,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59];
      if (cols.some(col => rowData[col])) { lastDataRow = row; break; }
    }
    const activeData = confirmedData.slice(0, lastDataRow + 1);

    const confirmedTabTable = activeData.map((row, idx) => {
      const formatSlot = (amtIdx, refIdx, sentIdx, daysIdx, statusIdx) => {
        const ref = row[refIdx] || "";
        const amt = row[amtIdx] !== undefined ? row[amtIdx] : "";
        const sent = row[sentIdx] || "";
        const days = row[daysIdx] !== undefined ? row[daysIdx] : "";
        const stat = row[statusIdx] || "";
        const label = ref.toString().toUpperCase().includes("MANUAL-INV") ? `${ref} [MANUAL ONLY]` : ref;
        if (!ref && !amt) return "(empty)";
        return `${label} £${amt}${sent ? " sent:" + sent : ""}${days ? " days:" + days : ""}${stat ? " status:" + stat : ""}`;
      };
      return `Row ${idx+1} | ${row[0]||""} | ${row[1]||""} | Code: ${row[2]||""} | Revenue: ${row[32]||""} | VAT: ${row[34]||""} | Type: ${row[35]||""} | Start: ${row[37]||""} | End: ${row[38]||""} | Inv1: ${formatSlot(41,42,43,44,45)} | Inv2: ${formatSlot(48,49,50,51,52)} | Inv3: ${formatSlot(55,56,57,58,59)}`;
    }).join("\n");

    const kbRules = knowledgeBase.filter(r => r[0] === "INVOICE_MATCHING").map(r => `- **${r[2]}** (${r[1]}): ${r[3]}`).join("\n");
    const invoiceAmount = parseFloat(alert.summary?.amount) || 0;
    const invoiceRef = alert.summary?.invoiceNo || "(unmatched)";
    const invoiceClient = alert.summary?.client || "";
    const invoiceJob = alert.summary?.job || "";
    const sentDate = alert.summary?.sentDate || "";
    const invoiceStatus = alert.summary?.status || "";
    const datePaid = alert.summary?.datePaid || "";

    let daysToPayValue = tolerances.defaultDaysToPay;
    if (invoiceStatus.toLowerCase() === "paid" && sentDate && datePaid) {
      try {
        const parseDate = d => {
          const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
          const parts = d.split(/[-\/]/);
          if (parts.length === 3) {
            const mNum = months[parts[1]?.toLowerCase()?.substring(0,3)];
            if (mNum !== undefined) {
              const yr = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
              return new Date(yr, mNum, parseInt(parts[0]));
            }
            if (parts[0].length === 4) return new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
            return new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
          }
          return new Date(d);
        };
        const diff = Math.round((parseDate(datePaid) - parseDate(sentDate)) / (1000*60*60*24));
        if (diff > 0) daysToPayValue = diff;
      } catch (e) {}
    }

    alertSummary = alert.summary?.summary || `Invoice ${invoiceRef} £${invoiceAmount}`;

    const prompt = `You are a financial advisor helping to resolve an unmatched invoice.

UNMATCHED INVOICE:
• Reference: ${invoiceRef}
• Amount: £${invoiceAmount.toFixed(2)}
• Client: ${invoiceClient}
• Job Description: ${invoiceJob}
• Sent: ${sentDate}
• Status: ${invoiceStatus}${datePaid ? `\n• Date Paid: ${datePaid}` : ""}

CONFIRMED TAB DATA:
${confirmedTabTable}

MATCHING RULES & TOLERANCES:
${kbRules || "- Default matching rules apply"}
- Date tolerance: ±${tolerances.invoiceMonthsTolerance} months

Invoice Slot Column Reference:
| Slot | Amount | Reference | Sent Date | Days to Pay | Status |
|------|--------|-----------|-----------|-------------|--------|
|  1   |   AP   |    AQ     |    AR     |     AS      |   AT   |
|  2   |   AW   |    AX     |    AY     |     AZ      |   BA   |
|  3   |   BD   |    BE     |    BF     |     BG      |   BH   |

Days to Pay value to use: ${daysToPayValue}

**recommendedActions must contain EXACTLY 2 items:**
Item 1: Plain English: "Insert invoice [ref] to slot [N] of the [Job Name] job (row [R])"
Item 2: Exact cell writes: "Write [amount] to [col][R] (amount), write [ref] to [col][R] (ref), write [sentDate] to [col][R] (sent date), write ${daysToPayValue} to [col][R] (days to pay), write [status] to [col][R] (status)"

Do NOT include any other bullet points.

Format as JSON array:
[{"optionId":1,"title":"...","jobRow":52,"jobName":"...","facts":{"jobType":"...","totalRevenue":0,"startDate":"...","endDate":"...","existingInvoices":"...","remainingToInvoice":0,"invoiceMatchStatus":"...","discrepancies":"..."},"recommendedActions":["...","..."]}]

Return ONLY JSON.`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (message.content[0].type === "text" ? message.content[0].text : "").replace(/```json|```/g, "").trim();
    try { options = JSON.parse(text); if (!Array.isArray(options)) options = [options]; } catch (e) { options = [{ summary: text }]; }
  }

  // ── Expense ────────────────────────────────────────────────────────────
  else if (alert.type === "expense" || alert.sheetName === "DirComp") {
    alertType = "expense";

    const [outgoingsResp, confirmedResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: alert.clientId, range: "Outgoings!A1:Z500" }),
      sheets.spreadsheets.values.get({ spreadsheetId: alert.clientId, range: "Confirmed!A1:CR500" }),
    ]);
    const outgoingsData = outgoingsResp.data.values || [];
    let confirmedData = confirmedResp.data.values || [];
    if (confirmedData.length === 500) {
      const full = await sheets.spreadsheets.values.get({ spreadsheetId: alert.clientId, range: "Confirmed!A1:CR5000" });
      confirmedData = full.data.values || [];
    }

    const categories = [];
    for (let i = 1; i < Math.min(outgoingsData.length, 100); i++) {
      const cat = String((outgoingsData[i] || [])[0] || "").trim();
      if (cat && !cat.includes("=")) categories.push(cat);
    }

    let lastDataRow = 1;
    for (let row = confirmedData.length - 1; row > 0; row--) {
      const rowData = confirmedData[row] || [];
      const cols = [0,1,2,3,4,32,33,34,35,36,37,38,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95];
      if (cols.some(col => rowData[col])) { lastDataRow = row; break; }
    }
    const activeConfirmedData = confirmedData.slice(0, lastDataRow + 1);

    const expenseConfirmedTabTable = activeConfirmedData.map((row, idx) => {
      const client = row[0]||""; const jobName = row[1]||""; const projectCode = row[2]||"";
      const revenue = row[32]||""; const directCostsBudget = row[33]||"";
      const projType = row[35]||""; const startDate = row[37]||""; const endDate = row[38]||"";
      const slotData = (dIdx, aIdx, rIdx, sIdx, idIdx) => {
        const d=row[dIdx]||""; const a=row[aIdx]||""; const r=row[rIdx]||""; const s=row[sIdx]||""; const id=row[idIdx]||"";
        if (!d && !a) return "Slot: (empty)";
        const hasId = id && !id.toString().toUpperCase().includes("MANUAL-ENTRY");
        return `${d} - ${a} - ${r} - (${hasId ? "has valid App ID: yes" : "NO App ID - placeholder"})`;
      };
      let totalAllocated = 0;
      [[75,76,81],[82,83,88],[89,90,95]].forEach(([d,a,id]) => {
        const idVal = String(row[id]||"");
        if (row[d] && row[a] && idVal && !idVal.toUpperCase().includes("MANUAL-ENTRY")) {
          totalAllocated += parseFloat(String(row[a]).replace(/[£$€,]/g,"")) || 0;
        }
      });
      const budgetNum = parseFloat(String(directCostsBudget).replace(/[£$€,]/g,"")) || 0;
      const remaining = budgetNum - totalAllocated;
      return `Row ${idx+1} | ${client} | ${jobName} | Code: ${projectCode} | DirectCostBudget: ${directCostsBudget} | Allocated: £${totalAllocated.toFixed(2)} | Remaining: £${remaining.toFixed(2)} | Type: ${projType} | Start: ${startDate} | End: ${endDate}\n  Expense Slots:\n  ${slotData(75,76,78,80,81)}\n  ${slotData(82,83,85,87,88)}\n  ${slotData(89,90,92,94,95)}`;
    }).join("\n");

    const kbRules = knowledgeBase.filter(r => r[0] === "EXPENSE_MATCHING").map(r => `- **${r[2]}** (${r[1]}): ${r[3]}`).join("\n");
    const expenseAmount = parseFloat(alert.summary?.amount) || 0;
    const expenseRef = alert.summary?.reference || "(unknown)";
    const expenseDescription = alert.summary?.description || "";
    const expenseDate = alert.summary?.date || "";
    const expenseAccountName = alert.summary?.accountName || "";

    alertSummary = alert.summary?.summary || `Expense ${expenseRef} £${expenseAmount}`;

    const prompt = `You are analyzing an unmatched business expense.

UNMATCHED EXPENSE:
• Reference: ${expenseRef}
• Vendor/Description: ${expenseDescription}
• Amount: £${expenseAmount.toFixed(2)}
• Date: ${expenseDate}
• Account Category: ${expenseAccountName}
• VAT Amount: ${alert.summary?.vatAmount || "£0"}
• Status: ${alert.summary?.status || "(unknown)"}
• Transaction ID: ${alert.summary?.transactionId || "(unknown)"}

OUTGOINGS CATEGORIES:
${categories.slice(0, 30).map((c, i) => `${i+1}. ${c}`).join("\n")}

CONFIRMED TAB DATA:
${expenseConfirmedTabTable}

MATCHING RULES:
${kbRules || "- Default matching rules apply"}

Direct Cost Expense Slot Columns:
Slot 1: BX(75)Description, BY(76)Amount, BZ(77)VAT?, CA(78)Date, CB(79)DaysToPay, CC(80)Status, CD(81)TransactionID
Slot 2: CE(82)Description, CF(83)Amount, CG(84)VAT?, CH(85)Date, CI(86)DaysToPay, CJ(87)Status, CK(88)TransactionID
Slot 3: CL(89)Description, CM(90)Amount, CN(91)VAT?, CO(92)Date, CP(93)DaysToPay, CQ(94)Status, CR(95)TransactionID

For category matches include outgoingsData field. For job matches use cell references.

Format as JSON array:
[{"optionId":1,"title":"...","matchType":"job|category","jobRow":0,"jobName":"","category":"","allocationBreakdown":{},"matchAnalysis":{},"outgoingsData":{"categoryName":"","expenseMonth":"YYYY-MM","transactionId":"","amount":0,"description":"","status":"","recDate":"","payDate":""},"recommendedActions":[]}]

Return ONLY JSON.`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (message.content[0].type === "text" ? message.content[0].text : "").replace(/```json|```/g, "").trim();
    try { options = JSON.parse(text); if (!Array.isArray(options)) options = [options]; } catch (e) { options = [{ summary: text }]; }
  }

  // ── CRM ────────────────────────────────────────────────────────────────
  else if (alert.type === "crm" || alert.sheetName === "CRMComp") {
    alertType = alert.alertType || "crm";
    const tabName = alert.mode === "Pipeline" ? "Pipeline" : "Confirmed";

    const jobsResp = await sheets.spreadsheets.values.get({ spreadsheetId: alert.clientId, range: `${tabName}!A1:BH500` });
    let jobsData = jobsResp.data.values || [];
    if (jobsData.length === 500) {
      const full = await sheets.spreadsheets.values.get({ spreadsheetId: alert.clientId, range: `${tabName}!A1:BH5000` });
      jobsData = full.data.values || [];
    }

    let lastDataRow = 1;
    for (let row = jobsData.length - 1; row > 0; row--) {
      const rowData = jobsData[row] || [];
      if ([0,1,2,3,4,32,33,34,35,36,37,38].some(col => rowData[col])) { lastDataRow = row; break; }
    }
    const existingJobs = jobsData.slice(0, lastDataRow + 1).slice(1)
      .filter(row => row[0] && row[1])
      .map((row, i) => `Row ${i+2}: ${row[0]} | ${row[1]} | Revenue: ${row[32]||""} | Dates: ${row[37]||""} to ${row[38]||""}`);

    const kbRules = knowledgeBase.filter(r => r[0] === "CRM_MATCHING").map(r => `- **${r[2]}** (${r[1]}): ${r[3]}`).join("\n");
    const crmProjectCode = alert.summary?.projectCode || alert.data?.crmData?.[0] || "(unknown)";
    const crmJobName = alert.summary?.jobName || "";
    const crmRevenue = parseFloat(alert.summary?.revenue) || 0;

    alertSummary = `CRM ${alertType} ${crmProjectCode} ${crmJobName}`.trim();

    const prompt = `You are analyzing a CRM discrepancy.

UNMATCHED CRM JOB:
• Project Code: ${crmProjectCode}
• Client: ${alert.clientName || ""}
• Job Name: ${crmJobName}
• Revenue: £${crmRevenue.toFixed(2)}
• Matching Mode: ${tabName}

EXISTING JOBS IN ${tabName.toUpperCase()} TAB:
${existingJobs.join("\n")}

MATCHING RULES:
${kbRules || "- Default matching rules apply"}

Format as JSON array with optionId, title, matchType, jobRow, matchAnalysis, recommendedActions.
Return ONLY JSON.`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (message.content[0].type === "text" ? message.content[0].text : "").replace(/```json|```/g, "").trim();
    try { options = JSON.parse(text); if (!Array.isArray(options)) options = [options]; } catch (e) { options = [{ summary: text }]; }
  }

  // Store in AlertMemory
  if (options.length > 0) {
    const cachedOptionsJSON = JSON.stringify(options);
    if (memoryRow) {
      await updateAlertMemoryRow(sheets, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON });
    } else {
      await appendAlertMemoryRow(sheets, {
        fingerprintHash, alertType, clientName: alert.clientName || "",
        alertSummary, cachedOptionsJSON, status: "cached",
      });
    }
  }

  return { options, fromCache: false };
}

// ── Main cron handler ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify secret
  const { secret, automationCommanderSheetId: sheetIdFromBody } = req.body;
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    console.error("❌ Cron: invalid or missing secret");
    return res.status(401).json({ error: "Unauthorised" });
  }

  // Respond immediately so GAS doesn't time out — cron work runs async
  res.status(200).json({ success: true, message: "Cron job started" });

  // Run the full pre-computation in background (after response sent)
  setImmediate(async () => {
    const startTime = Date.now();
    console.log(`\n🕐 CRON: Starting background triage pre-computation`);

    try {
      const sheets = await getSheetsClient();
      const commanderSheetId = sheetIdFromBody || AUTOMATION_COMMANDER_SHEET_ID;

      // 1. Read all client flags
      console.log(`  Reading client flags...`);
      const clientsWithFlags = await getClientFlags(sheets);
      console.log(`  Found ${clientsWithFlags.length} clients with flags`);

      if (clientsWithFlags.length === 0) {
        await redisClient.set(PRECOMPUTED_KEY, JSON.stringify({
          computedAt: Date.now(), totalAlerts: 0, noActionCount: 0,
          alerts: [], noActionAlerts: [], clientsWithFlags: [],
        }), { EX: 14400 });
        console.log(`  ✅ No alerts — stored empty precomputed result`);
        return;
      }

      // 2. Read AlertMemory once for the whole run
      console.log(`  Reading AlertMemory...`);
      const memoryRows = await readAlertMemory(sheets);
      const ignoredHashes = new Set(memoryRows.filter(r => r.status === "ignored").map(r => r.fingerprintHash));
      console.log(`  ${memoryRows.length} memory rows, ${ignoredHashes.size} ignored`);

      // 3. Process each client — read sheets and extract alerts
      const allAlerts = [];
      const noActionAlerts = [];

      for (const client of clientsWithFlags) {
        console.log(`\n  🔹 ${client.clientName}`);

        const actionableFlags = Object.entries(client.flags)
          .filter(([k, v]) => v && !NO_ACTION_FLAGS.includes(k)).map(([k]) => k);
        const noActionFlags = Object.entries(client.flags)
          .filter(([k, v]) => v && NO_ACTION_FLAGS.includes(k)).map(([k]) => k);

        if (actionableFlags.includes("invoiceDashboardDiscr")) {
          const alerts = await readInvCompAlerts(sheets, client.masterSheetId);
          alerts.forEach(a => { a.clientId = client.clientSheetId; a.masterSheetId = client.masterSheetId; a.clientName = client.clientName; a.flagType = "invoiceDashboardDiscr"; });
          allAlerts.push(...alerts);
          console.log(`    InvComp: ${alerts.length} alerts`);
        }
        if (actionableFlags.includes("expenseDashboardDiscr")) {
          const alerts = await readDirCompAlerts(sheets, client.masterSheetId);
          alerts.forEach(a => { a.clientId = client.clientSheetId; a.masterSheetId = client.masterSheetId; a.clientName = client.clientName; a.flagType = "expenseDashboardDiscr"; });
          allAlerts.push(...alerts);
          console.log(`    DirComp: ${alerts.length} alerts`);
        }
        const pipeFlags = actionableFlags.filter(f => ["crmPipeDashDiscr","crmPipeAppDiscr"].includes(f));
        const confFlags = actionableFlags.filter(f => ["crmConfDashDiscr","crmConfAppDiscr"].includes(f));
        if (pipeFlags.length > 0) {
          const alerts = await readCRMCompAlerts(sheets, client.masterSheetId, "Pipeline", pipeFlags);
          alerts.forEach(a => { a.clientId = client.clientSheetId; a.masterSheetId = client.masterSheetId; a.clientName = client.clientName; });
          allAlerts.push(...alerts);
        }
        if (confFlags.length > 0) {
          const alerts = await readCRMCompAlerts(sheets, client.masterSheetId, "Confirmed", confFlags);
          alerts.forEach(a => { a.clientId = client.clientSheetId; a.masterSheetId = client.masterSheetId; a.clientName = client.clientName; });
          allAlerts.push(...alerts);
        }
        for (const flagKey of noActionFlags) {
          noActionAlerts.push({ clientId: client.masterSheetId, flagType: flagKey, flagName: FLAG_NAMES[flagKey], flagColumn: FLAG_COLUMNS[flagKey] });
        }
      }

      // 4. Fingerprint, filter ignored, run Claude for each
      const filteredAlerts = [];
      let cacheHits = 0, claudeCalls = 0, ignoredCount = 0;

      for (const alert of allAlerts) {
        alert.fingerprintHash = buildAlertFingerprint(alert);
        if (ignoredHashes.has(alert.fingerprintHash)) { ignoredCount++; continue; }

        // Run Claude analysis (uses cache where available)
        try {
          const { options, fromCache } = await analyseAlertWithClaude(sheets, alert, memoryRows);
          alert.precomputedOptions = options;
          if (fromCache) cacheHits++; else claudeCalls++;
        } catch (err) {
          console.error(`    ⚠️ Analysis failed for ${alert.fingerprintHash}: ${err.message}`);
        }

        filteredAlerts.push(alert);
      }

      console.log(`\n  📊 Summary: ${filteredAlerts.length} alerts, ${cacheHits} cache hits, ${claudeCalls} Claude calls, ${ignoredCount} ignored`);

      // 5. Store in Redis
      const precomputedData = {
        computedAt: Date.now(),
        totalAlerts: filteredAlerts.length,
        noActionCount: noActionAlerts.length,
        alerts: filteredAlerts,
        noActionAlerts,
        clientsWithFlags,
      };

      await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(precomputedData), { EX: 14400 }); // 4 hour TTL
      console.log(`  ✅ Stored precomputed data in Redis (TTL 4h)`);
      console.log(`  ⏱️ Total time: ${Math.round((Date.now() - startTime) / 1000)}s`);

    } catch (err) {
      console.error(`❌ CRON failed: ${err.message}`, err);
    }
  });
}
