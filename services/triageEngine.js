import { createHash } from "crypto";
import { extractSheetIdFromUrl, withRetry, getSheetsClient, getSheetId, colIndexToLetter } from "./sheetsClient";
import { 
  buildAlertFingerprint, buildAlertFingerprintLegacy, ensureAlertMemoryTab, readAlertMemory, 
  findMemoryRow, appendAlertMemoryRow, updateAlertMemoryRow, 
  deleteAlertMemoryRows, purgeOldAlertMemoryRows,
  getHandledFingerprintHashes_, findPreviousIgnoreReason,
  normaliseArrayForFingerprint
} from "./alertMemory";
import {
  checkRetainerInvoices_, checkCRMWipe_, checkRevenueMismatch_, checkDirectCostsMismatch_,
  checkPipelineConfirmedOverlap_, checkRetainerShrinkBlocked_, checkUninvoicedNewJobs_,
  checkUninvoicedRevenue_, checkDeletedInvoices_, checkJobStructureErrors_,
  checkDeletedExpenses_, checkUnreceivedExpenses_, checkAutoLogErrors_, checkAutoLogInfiniteLoops_
} from "./proactiveChecks";
import { 
  checkAllGASLocks, setCRMMode, getToleranceValues, 
  getCRMMatchingMode, fetchJobRowsForDisplay 
} from "./sharedHelpers";
import { redisClient } from "./redisClient";
import { logPrecomputeRun, logFlagSweepRun, logBuildOptionsRun } from "./systemLogs";
import { anthropic } from "./claudeClient";

const ALERT_MEMORY_TAB = "AlertMemory";

export const PRECOMPUTED_KEY = "triage_precomputed";
export const PRECOMPUTED_MAX_AGE_MS = 240 * 60 * 1000; 

export const FLAG_NAMES = {
  invoiceDashboardDiscr: "Invoice dashboard discr",
  crmPipeDashDiscr: "CRM pipe dash discr",
  crmPipeAppDiscr: "CRM pipe app discr",
  crmConfDashDiscr: "CRM conf dash discr",
  crmConfAppDiscr: "CRM conf app discr",
  crmCopiedConfChecked: "CRM copied to conf box checked",
  crmCopiedConfUnchecked: "CRM copied to conf box UNchecked",
  crmCopiedConfDelete: "CRM copied to conf box DELETE",
  retainerInvoicesCreated: "Retainer invoices created",
  retainerInvoicesDeleted: "Retainer invoices deleted",
  expenseDashboardDiscr: "Expense dashboard discr",
  expenseAdded: "Expense added",
  expenseUnreconGaps: "Expense unrecon gaps",
  invoiceStaleUnsentChanges: "Stale unsent invoice send date changed",
};

export function parseAutomationTime_(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/([A-Za-z]{3})\s+(\d{1,2})-([A-Za-z]{3})\s+(\d{2}):(\d{2})/);
  if (!m) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  const day = parseInt(m[2], 10);
  const monthStr = m[3].toLowerCase();
  const hrs = parseInt(m[4], 10);
  const mins = parseInt(m[5], 10);
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const month = months[monthStr];
  if (month === undefined) return 0;
  
  const now = new Date();
  let year = now.getFullYear();
  if (month === 11 && now.getMonth() === 0) year--;
  else if (month === 0 && now.getMonth() === 11) year++;
  
  const guessedUtc = new Date(Date.UTC(year, month, day, hrs, mins, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/London',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  }).formatToParts(guessedUtc);
  
  const p = {};
  parts.forEach(part => { if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10); });
  const londonTimeMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  const offsetMs = londonTimeMs - guessedUtc.getTime();
  
  return guessedUtc.getTime() - offsetMs;
}

export function evaluateAutomationStatus_(alertType, category, clientMeta, detectedAtMs, firstSeenMs) {
  if (category !== "discrepancy" && category !== "proactive") return "cached";
  if (!clientMeta) return "cached";
  
  const baseTimeMs = detectedAtMs || firstSeenMs;
  const nowMs = Date.now();
  if ((nowMs - baseTimeMs) > 16 * 60 * 60 * 1000) return "cached"; 

  const invoiceDependent = ["revenue_mismatch", "retainer_invoice", "uninvoiced_revenue", "deleted_invoice"];
  const expenseDependent = ["direct_costs_mismatch", "deleted_expense", "unreceived_expenses"];

  let autoLastRun = 0;
  if (alertType.startsWith("invoice") || invoiceDependent.includes(alertType)) {
    autoLastRun = clientMeta.invAutoLastRunMs;
  } else if (alertType.startsWith("crm")) {
    autoLastRun = clientMeta.crmAutoLastRunMs;
  } else if (alertType.startsWith("expense") || expenseDependent.includes(alertType)) {
    autoLastRun = clientMeta.expAutoLastRunMs;
  } else {
    return "cached"; 
  }

  if (autoLastRun === 0) return "cached"; 
  if (autoLastRun >= (baseTimeMs - 60000)) return "cached";

  return "pending_automation";
}

export async function readAutoUpdatesClientRows_(sheets, automationCommanderSheetId) {
  const mainResponse = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: automationCommanderSheetId,
    range: "AutoUpdates!A2:AJ1000",
  }));
  const rows = mainResponse.data.values || [];
  console.log(`📊 Total rows: ${rows.length}`);

  const clientRows = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sheetRowNum = i + 2;

    if (!row || row.length < 13) continue;

    const clientName = String(row[0] || "").trim();
    const scriptId    = String(row[10] || "").trim();
    const clientSheetUrl = row[11];
    const masterSheetUrl = row[12];
    const hasWebAppUrl = !!String(row[13] || "").trim(); 

    if (!clientName || !clientSheetUrl || !masterSheetUrl) continue;
    if (clientName.toLowerCase() === "client" || clientName.toLowerCase() === "client name") continue;

    const clientId = extractSheetIdFromUrl(clientSheetUrl);
    const masterId = extractSheetIdFromUrl(masterSheetUrl);
    if (!clientId || !masterId) continue;

    clientRows.push({
      rowIndex: i,
      sheetRowNum,
      clientName,
      clientSheetId: clientId,
      masterSheetId: masterId,
      clientSheetUrl: String(clientSheetUrl),
      masterSheetUrl: String(masterSheetUrl),
      scriptId,
      hasWebAppUrl,
      invAutoLastRunMs: parseAutomationTime_(row[24]), 
      crmAutoLastRunMs: parseAutomationTime_(row[29]), 
      expAutoLastRunMs: parseAutomationTime_(row[34]), 
    });
  }
  return { rows, clientRows };
}

export function buildInvCompSummary(alert) {
  const accounting = alert.data.accounting || [];
  const client = accounting[0] || '(unknown)';
  const job = accounting[1] || '';
  
  const invoiceAmount = parseFloat(String(accounting[2] || '0').replace(/,/g, '')) || 0; 
  const totalExclVAT = parseFloat(String(accounting[3] || '0').replace(/,/g, '')) || 0; 
  const vatIncluded = parseFloat(String(accounting[4] || '0').replace(/,/g, '')) || 0; 
  
  const invoiceNo = accounting[5] || '(no reference)'; 
  const sentDate = accounting[6] || ''; 
  const datePaid = accounting[8] || ''; 
  const status = accounting[9] || ''; 
  const currency = accounting[10] || 'GBP'; 

  const amount = totalExclVAT > 0 ? totalExclVAT : invoiceAmount;
  let vatSuffix = '';
  if (vatIncluded && vatIncluded > 0) vatSuffix = ' + VAT';
  
  const formattedAmount = amount > 0 
    ? `${currency}${amount.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2})}${vatSuffix}`
    : 'unknown amount';
  
  let summary = `Invoice ${invoiceNo} • ${formattedAmount} • ${client}`;
  if (job) summary += ` • ${job}`;
  if (sentDate) summary += ` • Sent ${sentDate}`;
  if (status) summary += ` • ${status}`;
  
  return { invoiceNo, amount, vatIncluded, currency, client, job, sentDate, datePaid, status, summary };
}

export function buildDirCompSummary(alert) {
  const accounting = alert.data.accounting || [];
  const date          = accounting[0] || '';
  const description   = accounting[1] || '';
  const amount        = parseFloat(String(accounting[2] || '0').replace(/,/g, '')) || 0;
  const reference     = accounting[3] || '';
  const accountName   = accounting[4] || '';
  const status        = accounting[5] || '';
  const transactionId = accounting[6] || '';
  const datePaid      = accounting[7] || '';
  const vatAmount     = accounting[8] || '';
  
  const formattedAmount = amount > 0 
    ? `£${amount.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`
    : '£0.00';
  
  let summary = `Expense ${reference || date} • ${formattedAmount}`;
  if (description) summary += ` • ${description}`;
  if (accountName) summary += ` • ${accountName}`;
  if (date) summary += ` • ${date}`;
  
  return { reference, amount, description, date, accountName, status, transactionId, datePaid, vatAmount, summary };
}

export const AUTOLOG_TYPE_PATTERNS = {
  retainerInvoicesCreated:   ["[Retainers - Confirmed] Added"],
  retainerInvoicesDeleted:   ["[Retainers - Confirmed] Trimmed"],
  expenseUnreconGaps:        ["[Confirmed] Created Manual Gap:", "[Confirmed] Changed Manual Gap:", "[Confirmed] Removed Manual Gap"],
  expenseAdded:              ["Created New Row:"],
  invoiceStaleUnsentChanges: ["Stale Invoice - Row"],
  crmCopiedConfChecked:      [
    "Copied Pipeline Project to Confirmed:",
    "Copied Pipeline Project (with",
    "Converted Pipeline Job to Confirmed Retainer:",
    "Skipped Copy: Job with Project Code",
  ],
  crmCopiedConfUnchecked:    ["Copied Status: 'Yes' -> 'No' (Reverted by Source)"],
  crmCopiedConfDelete:       ["Deleted Confirmed Job: Row"],
};

export async function readRecentAutoLogEntries_(sheets, masterSheetId, limit = 30, cachedData = null) {
  try {
    let rows = [];
    if (cachedData) {
      rows = cachedData.slice(0, limit);
    } else {
      const resp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: `AutoLog!A2:D${limit + 1}`,
      }));
      rows = resp.data.values || [];
    }
    return rows.map(row => ({
      timestamp: row[0] || "",
      category: row[1] || "",
      summary: row[2] || "",
      details: row[3] || "",
    }));
  } catch (err) {
    return [];
  }
}

export async function readInvCompAlerts(sheets, spreadsheetId, cachedData = null) {
  try {
    console.log(`\n📖 Reading InvComp alerts from ${spreadsheetId}...`);
    let allRows = [];
    if (cachedData && cachedData.length > 0) {
      allRows = cachedData;
      // If cachedData only had columns A to Y, fetch right-hand columns AT to BD
      if (allRows[0] && allRows[0].length < 51) {
        try {
          const rightResp = await withRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId, range: "InvComp!AT5:BD1000",
          }));
          const rightRows = rightResp.data.values || [];
          for (let i = 0; i < allRows.length; i++) {
            const rRow = rightRows[i] || [];
            while (allRows[i].length < 45) allRows[i].push("");
            for (let j = 0; j < rRow.length; j++) {
              allRows[i][45 + j] = rRow[j];
            }
          }
        } catch (e) {
          console.warn("Could not fetch right columns for InvComp cachedData:", e.message);
        }
      }
    } else {
      const dataResponse = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId, range: "InvComp!A5:BD1000",
      }));
      allRows = dataResponse.data.values || [];
    }
    const headers = allRows[0] || [];
    const rows = allRows.slice(1);

    // Index all spreadsheet items from columns AT through BD (col 45 to 55)
    // AT: Client (45), AU: Job (46), AV: Invoice amount gross (47), AW: Total excl VAT net (48),
    // AX: VAT included (49), AY: Invoice no (50), AZ: Sent date (51), BA: Pay date (52),
    // BB: Status (53), BC: InvSeq (54), BD: CellRef (55)
    const spreadsheetItemsByInv = {};
    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      if (!row || row.length <= 50) continue;
      const sInvNo = String(row[50] || "").trim();
      if (!sInvNo || sInvNo === "(blank)" || sInvNo === "-") continue;
      const key = sInvNo.toLowerCase();
      if (!spreadsheetItemsByInv[key]) spreadsheetItemsByInv[key] = [];
      spreadsheetItemsByInv[key].push({
        invCompRow: 6 + rIdx,
        client: String(row[45] || "").trim(),
        job: String(row[46] || "").trim(),
        grossAmount: parseFloat(String(row[47] || "0").replace(/,/g, "")) || 0,
        netAmount: parseFloat(String(row[48] || "0").replace(/,/g, "")) || 0,
        vatAmount: parseFloat(String(row[49] || "0").replace(/,/g, "")) || 0,
        invoiceNo: sInvNo,
        sentDate: String(row[51] || "").trim(),
        payDate: String(row[52] || "").trim(),
        status: String(row[53] || "").trim(),
        invSeq: String(row[54] || "").trim(),
        cellRef: String(row[55] || "").trim(),
      });
    }

    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;
      const hasDiscrepancy = [18, 19, 20, 21, 23, 24].some((idx) => String(row[idx] || "").trim() === "1");
      if (hasDiscrepancy) {
        const alert = {
          type: "invoice",
          sheetName: "InvComp",
          rowNumber: 6 + rowIdx,
          data: {
            accounting: (() => { const s = row.slice(0, 11); while (s.length < 11) s.push(""); return s; })(),
            confirmed:  (() => { const s = row.slice(12, 18); while (s.length < 6) s.push(""); return s; })(),
            flags: (() => { const s = row.slice(18, 25); while (s.length < 7) s.push(""); return s; })(),
          },
          flagColumns: headers.slice(18, 25),
        };
        alert.summary = buildInvCompSummary(alert);

        const invNo = String(alert.summary?.invoiceNo || alert.data.accounting?.[5] || alert.data.confirmed?.[0] || "").trim();
        const items = (invNo && invNo !== "(no reference)" && invNo !== "(unknown)")
          ? (spreadsheetItemsByInv[invNo.toLowerCase()] || [])
          : [];
        alert.spreadsheetItems = items;
        const isDuplicate = String(alert.data.flags[4] || "").trim() === "1" || items.length > 1;
        alert.isDuplicateInvoice = isDuplicate;

        alerts.push(alert);
      }
    }
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading InvComp alerts:`, error);
    throw error;
  }
}

export async function readDirCompAlerts(sheets, spreadsheetId, cachedData = null) {
  try {
    console.log(`\n📖 Reading DirComp alerts from ${spreadsheetId}...`);
    let allRows = [];
    if (cachedData) {
      allRows = cachedData;
    } else {
      const dataResponse = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId, range: "DirComp!A5:AV1000",
      }));
      allRows = dataResponse.data.values || [];
    }
    const headers = allRows[0] || [];
    const rows = allRows.slice(1);
    const alerts = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!row || row.length === 0) continue;
      const hasDiscrepancy = [40, 42, 43, 44, 45, 46, 47].some((idx) => String(row[idx] || "").trim() === "1");
      if (hasDiscrepancy) {
        const alert = {
          type: "expense",
          sheetName: "DirComp",
          rowNumber: 7 + rowIdx,
          data: {
            accounting: (() => { const s = row.slice(0, 10); while (s.length < 10) s.push(""); return s; })(),
            confirmed:  (() => { const s = row.slice(23, 34); while (s.length < 11) s.push(""); return s; })(),
            flags: (() => { const s = row.slice(40, 48); while (s.length < 8) s.push(""); return s; })(),
          },
          flagColumns: headers.slice(40, 48),
        };
        alert.summary = buildDirCompSummary(alert);
        alerts.push(alert);
      }
    }
    return alerts;
  } catch (error) {
    console.error(`❌ Error reading DirComp alerts:`, error);
    throw error;
  }
}

export async function readCRMCompAlerts(sheets, spreadsheetId, mode, alertTypes, masterSheetId) {
  try {
    console.log(`\n📖 Reading CRMComp alerts (${mode} mode) for ${alertTypes.join(", ")}...`);
    let triageSettings = null;
    const dcaSheetId = masterSheetId || spreadsheetId;
    try {
      const batchResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
        spreadsheetId: dcaSheetId,
        ranges: ["DataChgAlert!C59:C66", "DataChgAlert!F59:F66", "DataChgAlert!C72:C79", "DataChgAlert!F72:F79"]
      }));
      const ranges = batchResp.data.valueRanges || [];
      const SETTING_ROWS = ["missing_job","client_mismatch","job_name_mismatch","revenue_mismatch",
                            "direct_costs_mismatch","start_date_mismatch","end_date_mismatch","likelihood_mismatch"];
      const parseSettings = (vals) => {
        const s = {};
        SETTING_ROWS.forEach((k, i) => { const v = String((vals[i] || [])[0] || "").trim().toLowerCase(); s[k] = v !== "ignore"; });
        return s;
      };
      triageSettings = { dashPipe: parseSettings(ranges[0]?.values || []), dashConf: parseSettings(ranges[1]?.values || []), crmPipe: parseSettings(ranges[2]?.values || []), crmConf: parseSettings(ranges[3]?.values || []) };
    } catch(e) { }

    await setCRMMode(sheets, spreadsheetId, mode);
    const alerts = [];
    let dashData = [];
    let appData = [];
    try {
      const batchResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
        spreadsheetId, ranges: ["CRMComp!X6:BF1000", "CRMComp!EF6:FL1000"], valueRenderOption: "FORMATTED_VALUE"
      }));
      dashData = batchResp.data.valueRanges[0].values || [];
      appData = batchResp.data.valueRanges[1].values || [];
    } catch(e) { }

    for (const alertType of alertTypes) {
      let dataRange, crmDataCols, sheetDataCols, flagCols, flagStartIdx;
      const isDash = alertType === "crmPipeDashDiscr" || alertType === "crmConfDashDiscr";
      const isPipe = alertType === "crmPipeDashDiscr" || alertType === "crmPipeAppDiscr";
      const settingsBlock = triageSettings ? (isDash ? (isPipe ? triageSettings.dashPipe : triageSettings.dashConf) : (isPipe ? triageSettings.crmPipe  : triageSettings.crmConf)) : null;

      if (mode === "Pipeline") {
        if (alertType === "crmPipeDashDiscr") {
          dataRange = "CRMComp!X6:BF1000"; crmDataCols = [0, 13]; sheetDataCols = [17, 26]; flagCols = [27, 35]; flagStartIdx = 27;
        } else if (alertType === "crmPipeAppDiscr") {
          dataRange = "CRMComp!EF6:FL1000"; sheetDataCols = [0, 13]; crmDataCols = [15, 25]; flagCols = [25, 33]; flagStartIdx = 25;
        }
      } else if (mode === "Confirmed") {
        if (alertType === "crmConfDashDiscr") {
          dataRange = "CRMComp!X6:BF1000"; crmDataCols = [0, 13]; sheetDataCols = [17, 26]; flagCols = [27, 35]; flagStartIdx = 27;
        } else if (alertType === "crmConfAppDiscr") {
          dataRange = "CRMComp!EF6:FL1000"; sheetDataCols = [0, 13]; crmDataCols = [15, 25]; flagCols = [25, 33]; flagStartIdx = 25;
        }
      }

      if (!dataRange) continue;
      let rows = [];
      if (dataRange.includes("X6:BF")) rows = dashData;
      else if (dataRange.includes("EF6:FL")) rows = appData;

      if (rows.length === 0) {
        try {
          const dataResponse = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId, range: dataRange, valueRenderOption: "FORMATTED_VALUE" }));
          rows = dataResponse.data.values || [];
        } catch(e) { continue; }
      }

      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (!row || row.length === 0) continue;
        const flagValues = [0,1,2,3,4,5,6,7].map(i => String(row[flagStartIdx + i] || "").trim());
        if (!flagValues.some(v => v === "1")) continue;
        const SETTING_KEYS = ["missing_job","client_mismatch","job_name_mismatch","revenue_mismatch","direct_costs_mismatch","start_date_mismatch","end_date_mismatch","likelihood_mismatch"];
        const filteredFlags = settingsBlock ? flagValues.map((v, fi) => {
          if (v !== "1") return v;
          const sk = SETTING_KEYS[fi];
          return (sk && settingsBlock[sk] === false) ? "0" : v;
        }) : flagValues;
        if (!filteredFlags.some(v => v === "1")) continue;

        const isNotFound = filteredFlags[0] === "1";
        const mismatchFlags = filteredFlags.slice(1);
        const subType = isNotFound ? "not_found" : "field_mismatch";
        const MISMATCH_FIELD_NAMES = ["Client name", "Job name", "Revenue", "Direct costs", "Start date", "End date", "% Likelihood"];
        const mismatchFields = mismatchFlags.map((v, i) => v === "1" ? MISMATCH_FIELD_NAMES[i] : null).filter(Boolean);
        const padSlice = (arr, start, end) => {
          const slice = arr.slice(start, end);
          const len = end - start;
          while (slice.length < len) slice.push("");
          return slice;
        };
        alerts.push({
          type: "crm", alertType, subType, mismatchFields, mode, sheetName: "CRMComp", rowNumber: 7 + rowIdx,
          data: { crmData: padSlice(row, crmDataCols[0], crmDataCols[1]), sheetData: padSlice(row, sheetDataCols[0], sheetDataCols[1]), flags: filteredFlags },
        });
      }
    }

    const dashAlerts = alerts.filter(a => a.alertType.endsWith("DashDiscr"));
    const getIdentityKey = (a) => {
      let code = "", client = "", job = "";
      if (a.alertType.endsWith("DashDiscr")) {
        code = String(a.data?.crmData?.[2] || a.data?.sheetData?.[0] || "").trim().toLowerCase();
        client = String(a.data?.crmData?.[0] || a.data?.sheetData?.[1] || "").trim().toLowerCase();
        job = String(a.data?.crmData?.[1] || a.data?.sheetData?.[2] || "").trim().toLowerCase();
      } else {
        code = String(a.data?.crmData?.[0] || a.data?.sheetData?.[2] || "").trim().toLowerCase();
        client = String(a.data?.crmData?.[1] || a.data?.sheetData?.[0] || "").trim().toLowerCase();
        job = String(a.data?.crmData?.[2] || a.data?.sheetData?.[1] || "").trim().toLowerCase();
      }
      return code ? `code:${code}` : `name:${client}|${job}`;
    };

    const dashMismatchKeys = new Set(dashAlerts.filter(a => a.subType === "field_mismatch").map(getIdentityKey));
    const filteredAlerts = alerts.filter(a => {
      if (a.alertType.endsWith("AppDiscr") && a.subType === "field_mismatch") {
        if (dashMismatchKeys.has(getIdentityKey(a))) return false;
      }
      return true;
    });

    return filteredAlerts;
  } catch (error) {
    throw error;
  }
}

export async function handleDebugCompareTriage(req, res, sheets) {
  const { clientSheetId, masterSheetId, clientName: debugClientName, automationCommanderSheetId } = req.body;
  if (!clientSheetId || !masterSheetId || !debugClientName || !automationCommanderSheetId) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const debugSheetIdClean = extractSheetIdFromUrl(masterSheetId) || masterSheetId;
    const clientFlags = req.body.clientFlags || {};

    const invAlerts = clientFlags.invoiceDashboardDiscr
      ? await readInvCompAlerts(sheets, debugSheetIdClean).catch(e => { console.log(`  ⚠ InvComp read error: ${e.message}`); return []; })
      : [];
    const dirAlerts = clientFlags.expenseDashboardDiscr
      ? await readDirCompAlerts(sheets, debugSheetIdClean).catch(e => { console.log(`  ⚠ DirComp read error: ${e.message}`); return []; })
      : [];

    const pipeFlags = ["crmPipeDashDiscr","crmPipeAppDiscr"].filter(f => clientFlags[f]);
    const crmPipeAlerts = pipeFlags.length > 0
      ? await readCRMCompAlerts(sheets, debugSheetIdClean, "Pipeline", pipeFlags, debugSheetIdClean)
          .catch(e => { console.log(`  ⚠ CRMComp Pipeline read error: ${e.message}`); return []; })
      : [];

    const confFlags = ["crmConfDashDiscr","crmConfAppDiscr"].filter(f => clientFlags[f]);
    const crmConfAlerts = confFlags.length > 0
      ? await readCRMCompAlerts(sheets, debugSheetIdClean, "Confirmed", confFlags, debugSheetIdClean)
          .catch(e => { console.log(`  ⚠ CRMComp Confirmed read error: ${e.message}`); return []; })
      : [];

    invAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; a.flagType = a.flagType || "invoiceDashboardDiscr"; });
    dirAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; a.flagType = a.flagType || "expenseDashboardDiscr"; });
    crmPipeAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; if (!a.flagType) a.flagType = a.alertType || "crmPipeAppDiscr"; });
    crmConfAlerts.forEach(a => { a.clientName = debugClientName; a.clientId = clientSheetId; a.masterSheetId; if (!a.flagType) a.flagType = a.alertType || "crmConfAppDiscr"; });

    const allDebugAlerts = [...invAlerts, ...dirAlerts, ...crmPipeAlerts, ...crmConfAlerts];
    allDebugAlerts.forEach(a => { a.fingerprintHash = buildAlertFingerprint(a); });

    await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
    const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
    const clientMemory = memoryRows.filter(r => r.clientName === debugClientName);

    const handledStatuses = new Set(["ignored", "task", "superseded", "accepted"]);
    const handledHashes = new Set(clientMemory.filter(r => handledStatuses.has(r.status)).map(r => r.fingerprintHash).filter(Boolean));
    const cachedHashes  = new Set(clientMemory.filter(r => r.status === "cached").map(r => r.fingerprintHash).filter(Boolean));

    const report = allDebugAlerts.map(a => {
      const fp = a.fingerprintHash;
      const memRow = clientMemory.find(r => r.fingerprintHash === fp);
      const parts = [a.type || "", a.flagType || a.alertType || ""];
      if (a.data?.accounting) parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.accounting)));
      if (a.data?.confirmed)  parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.confirmed)));
      if (a.data?.crmData)    parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.crmData)));
      if (a.data?.sheetData)  parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.sheetData)));
      if (a.data?.flags)      parts.push(JSON.stringify(normaliseArrayForFingerprint(a.data.flags)));
      const rawFp = parts.join("|");
      return {
        type: a.type,
        flagType: a.flagType || a.alertType,
        summary: a.summary?.summary || JSON.stringify(a.summary || {}).slice(0, 100),
        fingerprintHash: fp,
        amStatus: memRow ? memRow.status : "NOT_IN_AM",
        wouldBeFiltered: handledHashes.has(fp),
        rawFingerprint: rawFp.slice(0, 400),
      };
    });

    const generatedHashes = new Set(allDebugAlerts.map(a => a.fingerprintHash));
    const unmatchedMemory = clientMemory
      .filter(r => r.fingerprintHash && !generatedHashes.has(r.fingerprintHash))
      .map(r => ({
        fingerprintHash: r.fingerprintHash,
        status: r.status,
        alertType: r.alertType,
        alertSummary: (r.alertSummary || "").slice(0, 100),
      }));

    const allMemoryHashes = new Set(memoryRows.map(r => r.fingerprintHash).filter(Boolean));
    const notInAnyAM = allDebugAlerts
      .filter(a => !allMemoryHashes.has(a.fingerprintHash))
      .map(a => a.fingerprintHash);
    const inOtherClient = allDebugAlerts
      .filter(a => allMemoryHashes.has(a.fingerprintHash) && !clientMemory.find(r => r.fingerprintHash === a.fingerprintHash))
      .map(a => {
        const amRow = memoryRows.find(r => r.fingerprintHash === a.fingerprintHash);
        return { hash: a.fingerprintHash, flagType: a.flagType, storedClientName: amRow?.clientName, status: amRow?.status };
      });

    console.log(`  🔬 debug_compare_triage: ${allDebugAlerts.length} generated, ${clientMemory.length} in AM, ${unmatchedMemory.length} unmatched AM entries`);

    return res.status(200).json({
      success: true,
      clientName: debugClientName,
      summary: {
        generated: allDebugAlerts.length,
        inv: invAlerts.length,
        dir: dirAlerts.length,
        crmPipe: crmPipeAlerts.length,
        crmConf: crmConfAlerts.length,
        alertMemoryTotal: clientMemory.length,
        wouldBeFiltered: report.filter(r => r.wouldBeFiltered).length,
        wouldPassThrough: report.filter(r => !r.wouldBeFiltered).length,
        notInAlertMemory: report.filter(r => r.amStatus === "NOT_IN_AM").length,
        unmatchedAlertMemoryEntries: unmatchedMemory.length,
        notInAnyAlertMemory: notInAnyAM.length,
        foundUnderDifferentClient: inOtherClient.length,
      },
      generatedAlerts: report,
      unmatchedAlertMemoryEntries: unmatchedMemory,
      notInAnyAlertMemory: notInAnyAM,
      foundUnderDifferentClient: inOtherClient,
    });
  } catch (err) {
    console.error("❌ debug_compare_triage error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleDebugTriageState(req, res, sheets) {
  const { clientName, automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const allMemoryRows = await readAlertMemory(sheets, acId);
    const clientMemory = clientName ? allMemoryRows.filter(r => r.clientName === clientName) : allMemoryRows;
    const memorySummary = clientMemory
      .filter(r => r.alertType !== "flag_cleared")
      .map(r => ({
        hash:        r.fingerprintHash,
        alertType:   r.alertType,
        status:      r.status,
        category:    r.category || "MISSING",
        hasOptions:  !!r.cachedOptionsJSON,
        summary:     r.alertSummary?.slice(0, 60),
        ignoreReason: r.ignoreReason || "",
      }));

    const flagClearedRows = allMemoryRows
      .filter(r => r.alertType === "flag_cleared" && (!clientName || r.clientName === clientName))
      .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))
      .slice(0, 5)
      .map(r => {
        let snap = {};
        try { snap = JSON.parse(r.dataSnapshot || "{}"); } catch(e) {}
        return {
          clientName: r.clientName,
          clearedAt: snap.clearedAt || r.lastSeen,
          clearedGroups: snap.clearedGroups,
          clearedCols: snap.clearedCols,
        };
      });

    const preRaw = await redisClient.get(PRECOMPUTED_KEY);
    let precompSummary = null;
    if (preRaw) {
      const pre = JSON.parse(preRaw);
      const preAlerts = (pre.alerts || []).filter(a => !clientName || a.clientName === clientName);
      const preClients = (pre.clientsWithFlags || []).filter(c => !clientName || c.clientName === clientName);
      const preNoAction = (pre.noActionAlerts || []).filter(na => !clientName || na.clientName === clientName || na.clientId === preClients[0]?.masterSheetId);
      precompSummary = {
        computedAt:    pre.computedAt,
        totalAlerts:   pre.totalAlerts,
        clientAlerts:  preAlerts.map(a => ({
          type:          a.type,
          flagType:      a.flagType || a.alertType,
          subType:       a.subType,
          fingerprint:   a.fingerprintHash,
          rowNumber:     a.rowNumber,
        })),
        clientNoAction: preNoAction.map(na => ({
          flagType:    na.flagType,
          hash:        na.fingerprintHash,
          hasAnalysis: !!na.analysisResult,
        })),
        clientFlags:   preClients.map(c => ({
          clientName: c.clientName,
          flags:      Object.entries(c.flags || {}).filter(([,v]) => v).map(([k]) => k),
        })),
      };
    }

    console.log(`debug_triage_state: ${clientMemory.length} AlertMemory rows, precomp=${!!preRaw}`);
    return res.status(200).json({
      success: true,
      clientName,
      alertMemory: {
        totalRows: allMemoryRows.length,
        clientRows: memorySummary,
        flagClearedRecords: flagClearedRows,
        statusCounts: allMemoryRows.reduce((acc, r) => { acc[r.status] = (acc[r.status]||0)+1; return acc; }, {}),
      },
      precomputed: precompSummary,
    });
  } catch (err) {
    console.error("❌ debug_triage_state error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCleanupAlertMemory(req, res, sheets) {
  const { automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);
    console.log(`cleanup_alert_memory: ${memoryRows.length} total rows`);

    const priority = (status) => {
      if (status === "ignored" || status === "accepted" || status === "task") return 3;
      if (status === "cached") return 2;
      return 1;
    };

    const byHash = {};
    for (const row of memoryRows) {
      if (!row.fingerprintHash) continue;
      if (!byHash[row.fingerprintHash]) byHash[row.fingerprintHash] = [];
      byHash[row.fingerprintHash].push(row);
    }

    const rowsToDelete = [];
    for (const [hash, rows] of Object.entries(byHash)) {
      if (rows.length <= 1) continue;
      rows.sort((a, b) => {
        const pd = priority(b.status) - priority(a.status);
        if (pd !== 0) return pd;
        return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
      });
      for (let i = 1; i < rows.length; i++) {
        rowsToDelete.push(rows[i].rowIndex);
      }
    }

    console.log(`cleanup_alert_memory: ${rowsToDelete.length} duplicate rows to delete`);
    if (rowsToDelete.length > 0) {
      await deleteAlertMemoryRows(sheets, acId, rowsToDelete);
    }

    return res.status(200).json({
      success: true,
      totalRows: memoryRows.length,
      duplicatesRemoved: rowsToDelete.length,
      uniqueHashes: Object.keys(byHash).length,
    });
  } catch (err) {
    console.error("❌ cleanup_alert_memory error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleRehashAlertMemory(req, res, sheets) {
  const { automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureAlertMemoryTab(sheets, acId);
    const memoryRows = await readAlertMemory(sheets, acId);

    const supersededWithReason = memoryRows.filter(r => r.status === "superseded" && r.ignoreReason);
    const sigKey = (r) => `${r.clientName}|${r.alertType}|${(r.alertSummary || "").slice(0, 40)}`;
    const now = new Date().toISOString().split("T")[0];

    const reasonBySig = {};
    for (const sup of supersededWithReason) {
      const sig = sigKey(sup);
      if (!reasonBySig[sig]) reasonBySig[sig] = sup.ignoreReason;
    }

    const promotions = []; 
    for (const row of memoryRows) {
      if (row.status !== "cached") continue;
      const sig = sigKey(row);
      if (reasonBySig[sig]) {
        promotions.push({ row, ignoreReason: reasonBySig[sig] });
      }
    }

    let promoted = 0;
    if (promotions.length > 0) {
      const acIdClean = extractSheetIdFromUrl(acId) || acId;
      const batchData = promotions.map(({ row, ignoreReason }) => ({
        range: `AlertMemory!A${row.rowIndex}:K${row.rowIndex}`,
        values: [[
          row.fingerprintHash, row.alertType, row.clientName, row.alertSummary,
          row.cachedOptionsJSON, "ignored", ignoreReason,
          row.firstSeen, now, row.lastRechecked || now, row.dataSnapshot || "",
        ]],
      }));
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: acIdClean,
        requestBody: { valueInputOption: "RAW", data: batchData },
      });
      promoted = promotions.length;
    }

    const priority = (status) => {
      if (status === "ignored" || status === "accepted" || status === "task") return 3;
      if (status === "cached") return 2;
      return 1;
    };
    const freshRows = await readAlertMemory(sheets, acId);
    const byHash = {};
    for (const row of freshRows) {
      if (!row.fingerprintHash) continue;
      if (!byHash[row.fingerprintHash]) byHash[row.fingerprintHash] = [];
      byHash[row.fingerprintHash].push(row);
    }
    const toDelete = [];
    for (const rows of Object.values(byHash)) {
      if (rows.length <= 1) continue;
      rows.sort((a, b) => {
        const pd = priority(b.status) - priority(a.status);
        if (pd !== 0) return pd;
        return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
      });
      for (let i = 1; i < rows.length; i++) toDelete.push(rows[i].rowIndex);
    }
    if (toDelete.length > 0) await deleteAlertMemoryRows(sheets, acId, toDelete);

    console.log(`rehash_alert_memory: promoted ${promoted} cached→ignored, deleted ${toDelete.length} duplicates`);
    return res.status(200).json({
      success: true,
      promoted,
      duplicatesRemoved: toDelete.length,
      totalRows: memoryRows.length,
    });
  } catch (err) {
    console.error("❌ rehash_alert_memory error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleRehashIgnoredAlerts(req, res, sheets) {
  const { automationCommanderSheetId: acId } = req.body;
  if (!acId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    const memoryRows = await readAlertMemory(sheets, acId);
    const ignoredRows = memoryRows.filter(r => r.status === "ignored");
    if (ignoredRows.length === 0) return res.status(200).json({ success: true, updated: 0, message: "No ignored rows to update" });

    // Get all clients so we can read their comparison tabs
    const flagResp = await sheets.spreadsheets.values.get({
      spreadsheetId: acId,
      range: "AutoUpdates!A2:M100",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const clientRows = (flagResp.data.values || []).slice(1).filter(r => r[0] && r[11] && r[12]);

    // Build map of alertSummary → fresh fingerprint by reading each client's InvComp
    const freshHashByInvNo = {}; // invoiceNo → { hash, clientName }
    for (const cr of clientRows) {
      const clientName = String(cr[0] || "").trim();
      const clientSheetId = extractSheetIdFromUrl(String(cr[11] || "")) || String(cr[11] || "");
      if (!clientSheetId) continue;
      try {
        const alerts = await readInvCompAlerts(sheets, clientSheetId);
        for (const alert of alerts) {
          alert.fingerprintHash = buildAlertFingerprint(alert);
          const invNo = alert.summary?.invoiceNo || "";
          if (invNo) freshHashByInvNo[`${clientName}|${invNo}`] = alert.fingerprintHash;
        }
      } catch (e) { /* skip client on error */ }
    }

    // Match ignored rows to fresh hashes and update
    const writes = [];
    let updated = 0;
    for (const row of ignoredRows) {
      const invMatch = (row.alertSummary || "").match(/Invoice\s+#?(\S+)/i);
      if (!invMatch) continue;
      const key = `${row.clientName}|${invMatch[1]}`;
      const freshHash = freshHashByInvNo[key];
      if (freshHash && freshHash !== row.fingerprintHash) {
        console.log(`  Rehashing "${row.clientName}" inv ${invMatch[1]}: ${row.fingerprintHash} → ${freshHash}`);
        writes.push({ range: `AlertMemory!A${row.rowIndex}`, values: [[freshHash]] });
        updated++;
      }
    }

    if (writes.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: acId,
        requestBody: { data: writes, valueInputOption: "RAW" },
      });
    }
    console.log(`  ✅ rehash_ignored_alerts: ${updated} updated of ${ignoredRows.length} ignored rows`);
    return res.status(200).json({ success: true, updated, total: ignoredRows.length });
  } catch (err) {
    console.error("❌ rehash_ignored_alerts:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetPrecomputed(req, res, sheets) {
  const { automationCommanderSheetId } = req.body;
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

    await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
    const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);

    const filteredAlerts = data.alerts.filter(alert => {
      const hash = alert.fingerprintHash || buildAlertFingerprint(alert);
      const memRow = findMemoryRow(memoryRows, hash);
      if (!memRow) return true;
      return memRow.status === "cached" || memRow.status === "pending_automation";
    });
    
    const filteredProactive = (data.proactiveAlerts || []).filter(alert => {
      const hash = alert.fingerprintHash || createHash("sha256").update(alert.alertKey || "").digest("hex").substring(0, 16);
      const memRow = findMemoryRow(memoryRows, hash);
      if (!memRow) return true;
      return memRow.status === "cached" || memRow.status === "pending_automation";
    });

    const filteredNoAction = (data.noActionAlerts || []).filter(alert => {
      if (!alert.fingerprintHash) return true;
      const memRow = findMemoryRow(memoryRows, alert.fingerprintHash);
      if (!memRow) return true;
      return memRow.status === "cached" || memRow.status === "pending_automation";
    });

    if (filteredAlerts.length < data.alerts.length || filteredProactive.length < (data.proactiveAlerts || []).length || filteredNoAction.length < (data.noActionAlerts || []).length) {
      console.log(`  Filtered ignored alert(s) from precomputed data`);
    }

    const alertCountsByClientAndFlag = {};
    const activeExpenseIdsByClient = {};
    const activeInvoiceIdsByClient = {};
    
    for (const alert of filteredAlerts) {
      const key = alert.clientName;
      let flagKey = alert.flagType || alert.alertType || alert.type;
      
      if (flagKey === "invoice") flagKey = "invoiceDashboardDiscr";
      if (flagKey === "expense") flagKey = "expenseDashboardDiscr";
      if (flagKey === "crm") flagKey = alert.flagType || alert.alertType || "crmPipeAppDiscr";

      alert.flagType = flagKey;
      alert.alertType = flagKey;

      if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
      alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;
      
      if (flagKey === "expenseDashboardDiscr") {
         const txId = alert.summary?.transactionId || alert.summary?.appId;
         if (txId) {
            if (!activeExpenseIdsByClient[key]) activeExpenseIdsByClient[key] = [];
            activeExpenseIdsByClient[key].push(txId);
         }
      }
      if (flagKey === "invoiceDashboardDiscr") {
         const invNo = alert.summary?.invoiceNo;
         if (invNo) {
            if (!activeInvoiceIdsByClient[key]) activeInvoiceIdsByClient[key] = [];
            activeInvoiceIdsByClient[key].push(invNo);
         }
      }
    }

    for (const alert of filteredNoAction) {
      const key = alert.clientName;
      const flagKey = alert.flagType;
      if (key && flagKey) {
        if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
        alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;
      }
    }

    const clientsWithUpdatedCounts = data.clientsWithFlags.map(c => {
      const counts = alertCountsByClientAndFlag[c.clientName] || {};
      const updatedFlags = { ...(c.flags || {}) };
      for (const flagKey of Object.keys(updatedFlags)) {
        if (!counts[flagKey] || counts[flagKey] <= 0) {
          updatedFlags[flagKey] = false;
        }
      }
      return {
        ...c,
        flags: updatedFlags,
        alertCounts: counts,
        activeExpenseIds: activeExpenseIdsByClient[c.clientName] || [],
        activeInvoiceIds: activeInvoiceIdsByClient[c.clientName] || [],
      };
    });

    let aggregatedNoActionResults = {};
    for (const na of filteredNoAction) {
      if (na.analysisResult && na.analysisResult.results) {
        const key = `${na.clientName}___${na.flagType}`;
        if (!aggregatedNoActionResults[key]) {
          aggregatedNoActionResults[key] = { success: true, flagType: na.flagType, results: [], overallOk: true };
        }
        aggregatedNoActionResults[key].results.push(...na.analysisResult.results);
        if (na.analysisResult.overallOk === false) {
          aggregatedNoActionResults[key].overallOk = false;
        }
      }
    }

    const sessionId = Math.random().toString(36).substring(2, 15);
    await redisClient.set(
      `triage_alerts:${sessionId}`,
      JSON.stringify({
        alerts: filteredAlerts,
        noActionAlerts: filteredNoAction,
        proactiveAlerts: filteredProactive,
        clientsWithFlags: clientsWithUpdatedCounts,
      }),
      { EX: 3600 } 
    );

    return res.status(200).json({
      success: true,
      available: true,
      sessionId,
      totalAlerts: filteredAlerts.length,
      noActionCount: filteredNoAction.length,
      proactiveAlerts: filteredProactive,
      clientsWithFlags: clientsWithUpdatedCounts.map(c => ({
        clientName: c.clientName,
        clientSheetId: c.clientSheetId,
        masterSheetId: c.masterSheetId,
        flags: c.flags,
        alertCounts: c.alertCounts || {},
        activeExpenseIds: c.activeExpenseIds || [],
      })),
      computedAt: data.computedAt,
      computedMinutesAgo: Math.round(ageMs / 60000),
      noActionAnalysisResults: aggregatedNoActionResults,
    });
  } catch (err) {
    console.error("❌ Error retrieving precomputed data:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleStorePrecomputed(req, res, sheets) {
  const { secret, computedAt, noActionAnalysisResults, automationCommanderSheetId } = req.body;

  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorised" });
  }

  try {
    let mergedAlerts = [];
    let mergedNoActionAlerts = [];
    let reconciledClients = [];

    let finalAlerts = mergedAlerts;
    let finalClientsWithFlags = reconciledClients;
    let finalNoActionAlerts = mergedNoActionAlerts;
    let finalProactiveAlerts = [];
    
    try {
      const acIdForMerge = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;
      await ensureAlertMemoryTab(sheets, acIdForMerge);

      const rowsBeforePurge = await readAlertMemory(sheets, acIdForMerge);
      await purgeOldAlertMemoryRows(sheets, acIdForMerge, rowsBeforePurge);

      const memoryRowsForMerge = await readAlertMemory(sheets, acIdForMerge);

      const oldPathFingerprints = new Set(mergedAlerts.map(a => buildAlertFingerprint(a)));
      const oldPathNoActionKeys = new Set(mergedNoActionAlerts.map(na => `${na.clientId}|||${na.flagType}`));

      const newAlertsFromMemory = [];
      const newNoActionFromMemory = [];
      const newProactiveFromMemory = [];
      const extraFlagsByClient = new Map();
      const newClientMeta = new Map(); 

      const { clientRows } = await readAutoUpdatesClientRows_(sheets, acIdForMerge);
      const clientNameToMeta = new Map(clientRows.map(c => [c.clientName, c]));

      for (const row of memoryRowsForMerge) {
        if (row.status !== "cached") continue;

        if (Object.prototype.hasOwnProperty.call(AUTOLOG_TYPE_PATTERNS, row.alertType)) {
          row.category = "info";
        }

        if (row.category === "discrepancy") {
          if (!row.cachedOptionsJSON) continue;
          if (oldPathFingerprints.has(row.fingerprintHash)) continue; 

          let alertObj = null;
          try { alertObj = JSON.parse(row.dataSnapshot); } catch (e) { continue; } 
          let options = [];
          try { options = JSON.parse(row.cachedOptionsJSON); } catch (e) { continue; } 

          const sharedRows = {};
          for (const opt of options) {
            if (opt.jobRowsData) sharedRows[opt.jobRow] = opt.jobRowsData;
          }
          for (const opt of options) {
            if (!opt.jobRowsData && sharedRows[opt.jobRow]) {
              opt.jobRowsData = JSON.parse(JSON.stringify(sharedRows[opt.jobRow]));
              if (opt.targetSlotType && opt.targetSlotNum && opt.targetRowNum) {
                for (const r of opt.jobRowsData) {
                  if (r.rowNum === opt.targetRowNum) {
                     if (opt.targetSlotType === "invoice" && r.invoiceSlots) r.invoiceSlots.forEach(s => s.highlighted = (s.slotNum === opt.targetSlotNum));
                     else if (opt.targetSlotType === "expense" && r.expenseSlots) r.expenseSlots.forEach(s => s.highlighted = (s.slotNum === opt.targetSlotNum));
                  } else {
                     if (r.invoiceSlots) r.invoiceSlots.forEach(s => s.highlighted = false);
                     if (r.expenseSlots) r.expenseSlots.forEach(s => s.highlighted = false);
                  }
                }
              }
            }
          }

          const liveMeta = clientNameToMeta.get(row.clientName) || {};

          newAlertsFromMemory.push({
            ...alertObj, 
            fingerprintHash: row.fingerprintHash, 
            clientName: row.clientName,
            clientId: liveMeta.clientSheetId || alertObj.clientId || alertObj.clientSheetId || "",
            masterSheetId: liveMeta.masterSheetId || alertObj.masterSheetId || "",
            options,
            firstSeen: row.firstSeen,
            lastSeen: row.lastSeen
          });

          if (!extraFlagsByClient.has(row.clientName)) extraFlagsByClient.set(row.clientName, {});
          
          let mappedFlagType = row.alertType;
          if (mappedFlagType === "invoice") mappedFlagType = alertObj.flagType || "invoiceDashboardDiscr";
          if (mappedFlagType === "expense") mappedFlagType = alertObj.flagType || "expenseDashboardDiscr";
          if (mappedFlagType === "crm") mappedFlagType = alertObj.flagType || alertObj.alertType || "crmPipeAppDiscr";
          
          extraFlagsByClient.get(row.clientName)[mappedFlagType] = true;

          if (!finalClientsWithFlags.some(c => c.clientName === row.clientName) && !newClientMeta.has(row.clientName)) {
            newClientMeta.set(row.clientName, {
              clientSheetId: alertObj.clientId || alertObj.clientSheetId || "",
              masterSheetId: alertObj.masterSheetId || "",
            });
          }
        } else if (String(row.category).toLowerCase() === "info" || row.category === "proactive") {
          if (!Object.prototype.hasOwnProperty.call(AUTOLOG_TYPE_PATTERNS, row.alertType)) {
            if (row.category === "proactive") {
              let alertObj = {};
              try { alertObj = JSON.parse(row.dataSnapshot || "{}"); } catch (e) { alertObj = {}; }
              const metaFields = ["jobName","endClientName","confirmedRow","revenue","startDate","endDate",
                "frequencyDays","lastInvoiceDate","expectedByDate","timestamp","sequenceType","summary","jobInfo","detailsSnippet",
                "childRowNum","clientJobStr","pipelineRow","likelihood","copiedToConf","jobType",
                "possibleMatchInvoiceNo","possibleMatchAmount","possibleMatchSentDate","possibleMatchConfidence","possibleMatchConfirmedRow","possibleMatchVatAmount","possibleMatchStatus","possibleMatchCase",
                "uninvoicedAmount","projectCode","draftCount","draftTotal","stableJobKey","isRetainer","tab",
                "directCosts","unreceivedAmount","placeholderCount","placeholderTotal",
                "errorSnippet","occurrenceCount","category","entityKey","fieldName","transition1","transition2","conflictType","suggestion","rawLogSnippet","invoiceNo"];
              const metadata = {};
              for (const f of metaFields) { if (alertObj[f] !== undefined) metadata[f] = alertObj[f]; }
              newProactiveFromMemory.push({
                ...alertObj, rowIndex: row.rowIndex, clientName: alertObj.clientName || row.clientName, alertType: alertObj.alertType || row.alertType, metadata, firstSeen: row.firstSeen, lastSeen: row.lastSeen
              });
              if (!finalClientsWithFlags.some(c => c.clientName === row.clientName) && !newClientMeta.has(row.clientName)) {
                newClientMeta.set(row.clientName, {
                  clientSheetId: alertObj.clientId || alertObj.clientSheetId || "",
                  masterSheetId: alertObj.masterSheetId || "",
                });
              }
            }
            continue;
          }

          const clientMeta = clientNameToMeta.get(row.clientName);
          if (!clientMeta) continue; 

          if (oldPathNoActionKeys.has(`${clientMeta.masterSheetId}|||${row.alertType}`)) continue; 

          let analysisResult = null;
          if (row.cachedOptionsJSON) {
            try { analysisResult = JSON.parse(row.cachedOptionsJSON); } catch (e) { analysisResult = null; }
          }
          newNoActionFromMemory.push({
            clientId: clientMeta.masterSheetId,
            clientName: row.clientName,
            type: "info",
            alertType: row.alertType,
            id: row.fingerprintHash,
            flagType: row.alertType,
            flagName: FLAG_NAMES[row.alertType] || row.alertType,
            flagDetail: row.alertSummary,
            fingerprintHash: row.fingerprintHash,
            analysisResult,
            firstSeen: row.firstSeen,
            lastSeen: row.lastSeen,
          });

          if (!extraFlagsByClient.has(row.clientName)) extraFlagsByClient.set(row.clientName, {});
          extraFlagsByClient.get(row.clientName)[row.alertType] = true;

          if (!finalClientsWithFlags.some(c => c.clientName === row.clientName) && !newClientMeta.has(row.clientName)) {
            newClientMeta.set(row.clientName, {
              clientSheetId: clientMeta.clientSheetId,
              masterSheetId: clientMeta.masterSheetId,
            });
          }
        }
      }

      if (newAlertsFromMemory.length > 0 || newNoActionFromMemory.length > 0 || newProactiveFromMemory.length > 0) {
        finalAlerts = [...mergedAlerts, ...newAlertsFromMemory];
        finalNoActionAlerts = [...mergedNoActionAlerts, ...newNoActionFromMemory];
        finalProactiveAlerts = newProactiveFromMemory;

        finalClientsWithFlags = reconciledClients.map(c => {
          const extra = extraFlagsByClient.get(c.clientName);
          return extra ? { ...c, flags: { ...c.flags, ...extra } } : c;
        });
        for (const [clientName, meta] of newClientMeta.entries()) {
          finalClientsWithFlags.push({
            clientName,
            clientSheetId: meta.clientSheetId,
            masterSheetId: meta.masterSheetId,
            flags: extraFlagsByClient.get(clientName) || {},
          });
        }
        console.log(`  store_precomputed: merged ${newAlertsFromMemory.length} discrepancy + ${newNoActionFromMemory.length} proactive AlertMemory-sourced item(s) across ${newClientMeta.size} new + ${extraFlagsByClient.size - newClientMeta.size} existing client(s)`);
      }
    } catch (mergeErr) {
      console.log(`  ⚠️ Could not merge AlertMemory-sourced alerts: ${mergeErr.message}`);
    }

    let aggregatedNoActionResults = { ...(noActionAnalysisResults || {}) };
    
    const keysToRebuild = new Set();
    for (const na of finalNoActionAlerts) {
      if (na.analysisResult && na.analysisResult.results) {
        keysToRebuild.add(`${na.clientName}___${na.flagType}`);
      }
    }
    for (const key of keysToRebuild) {
      aggregatedNoActionResults[key] = { success: true, flagType: key.split("___")[1], results: [], overallOk: true };
    }

    for (const na of finalNoActionAlerts) {
      if (na.analysisResult && na.analysisResult.results) {
        const key = `${na.clientName}___${na.flagType}`;
        aggregatedNoActionResults[key].results.push(...na.analysisResult.results);
        if (na.analysisResult.overallOk === false) {
          aggregatedNoActionResults[key].overallOk = false;
        }
      }
    }

    const precomputedData = {
      computedAt: computedAt || Date.now(),
      totalAlerts: finalAlerts.length,
      noActionCount: finalNoActionAlerts.length,
      alerts: finalAlerts,
      noActionAlerts: finalNoActionAlerts,
      proactiveAlerts: finalProactiveAlerts,
      clientsWithFlags: finalClientsWithFlags,
      noActionAnalysisResults: aggregatedNoActionResults,
    };

    await redisClient.set(
      PRECOMPUTED_KEY,
      JSON.stringify(precomputedData),
      { EX: 3600 } 
    );

    const analysisCount = Object.keys(precomputedData.noActionAnalysisResults).length;
    console.log(`✅ store_precomputed: ${precomputedData.totalAlerts} alerts, ${analysisCount} pre-analysed flags saved to Redis`);

    try {
      const clientDetail = (finalClientsWithFlags || []).map(c => ({
        clientName: c.clientName,
        alertCount: finalAlerts.filter(a => a.clientName === c.clientName).length,
        noActionCount: finalNoActionAlerts.filter(na => {
          const naClient = (finalClientsWithFlags || []).find(rc => rc.masterSheetId === na.clientId);
          return naClient && naClient.clientName === c.clientName;
        }).length,
        proactiveCount: (precomputedData.proactiveAlerts || []).filter(pa => pa.clientName === c.clientName).length,
      })).filter(c => c.alertCount > 0 || c.noActionCount > 0 || c.proactiveCount > 0);
      
      await logPrecomputeRun(sheets, extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId, {
        clientsWithFlags: (finalClientsWithFlags || []).length,
        totalAlerts: precomputedData.totalAlerts,
        noActionCount: precomputedData.noActionCount,
        analysisCount,
        proactiveCount: (precomputedData.proactiveAlerts || []).length,
        clientDetail,
      });
    } catch (logErr) {
      console.log(`⚠️ Could not log precompute run: ${logErr.message}`);
    }

    return res.status(200).json({ success: true, stored: precomputedData.totalAlerts });
  } catch (err) {
    console.error("❌ Error storing precomputed data:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleRunFlagSweep(req, res, sheets) {
  const { secret: sweepSecret, automationCommanderSheetId: acIdSweep, startIdx = 0 } = req.body;
  if (sweepSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorised" });
  }
  if (!acIdSweep) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });

  const sweepStart = Date.now();
  let clientsChecked = 0, flagsRaised = 0, errors = 0;
  let alertsDelayed = 0, alertsWoken = 0;
  let raisedDetail = [];
  let categoriesRunStr = "";
  try {
    const { clientRows } = await readAutoUpdatesClientRows_(sheets, acIdSweep);

    await ensureSweepScheduleTab(sheets, acIdSweep);
    const schedule = await readSweepSchedule_(sheets, acIdSweep);
    const isForced = req.body.forceProactive === true || req.body.forceAll === true;
    const actionableDue = isForced || isCategoryDue_(schedule.actionable);
    const infoDue = isForced || isCategoryDue_(schedule.info);
    const proactiveDue = isForced || isCategoryDue_(schedule.proactive);
    categoriesRunStr = [actionableDue ? "act" : "", infoDue ? "info" : "", proactiveDue ? "pro" : ""].filter(Boolean).join(",");
    console.log(`run_flag_sweep: actionableDue=${actionableDue}, infoDue=${infoDue}, proactiveDue=${proactiveDue}`);
    
    const CHUNK_SIZE = proactiveDue ? 1 : 3;
    const clientChunk = clientRows.slice(startIdx, startIdx + CHUNK_SIZE);
    const hasMore = startIdx + CHUNK_SIZE < clientRows.length;
    const nextIdx = startIdx + CHUNK_SIZE;

    console.log(`run_flag_sweep: processing clients ${startIdx + 1} to ${Math.min(startIdx + CHUNK_SIZE, clientRows.length)} of ${clientRows.length}`);

    const freqResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: acIdSweep,
      range: "AutoUpdates!O2:Q1000",
    });
    const freqRows = freqResponse.data.values || [];

    const sweepItems = []; 

    for (const client of clientChunk) {
      try {
        const freqRow = freqRows[client.rowIndex] || [];
        const hasInvoice = !!freqRow[0];
        const hasCRM     = !!freqRow[1];
        const hasExpense = !!freqRow[2];

        console.log(`  📦 Batch fetching static data for ${client.clientName}...`);
        let batchData = {};
        try {
          const batchResp = await sheets.spreadsheets.values.batchGet({
            spreadsheetId: client.masterSheetId,
            ranges: [
              "DataChgAlert!B4:I4",
              (hasInvoice && actionableDue) ? "InvComp!A5:BD1000" : "DataChgAlert!A1",
              (hasExpense && actionableDue) ? "DirComp!A5:AV1000" : "DataChgAlert!A1",
              (infoDue || proactiveDue) ? "AutoLog!A2:D200" : "DataChgAlert!A1"
            ]
          });
          const ranges = batchResp.data.valueRanges || [];
          batchData.gasLocks = ranges[0]?.values || [];
          batchData.invComp = ranges[1]?.values || [];
          batchData.dirComp = ranges[2]?.values || [];
          batchData.autoLog = ranges[3]?.values || [];
        } catch(e) {
          console.log(`  ⚠️ Batch fetch failed for ${client.clientName}: ${e.message}`);
        }

        const gasLocks = await checkAllGASLocks(sheets, client.masterSheetId, batchData.gasLocks);

        if (hasInvoice && actionableDue) {
          const invLock = gasLocks.invoice;
          if (!invLock.locked) {
            const invAlerts = await readInvCompAlerts(sheets, client.masterSheetId, batchData.invComp);
            invAlerts.forEach(a => {
              a.clientName = client.clientName;
              a.clientId = client.clientSheetId;
              a.masterSheetId = client.masterSheetId;
              a.flagType = "invoiceDashboardDiscr"; 
              a._fingerprint = buildAlertFingerprint(a); 
              a._legacyFingerprint = buildAlertFingerprintLegacy(a);
            });
            sweepItems.push({
              clientName: client.clientName, alertType: "invoiceDashboardDiscr",
              alerts: invAlerts,
              autoUpdatesRow: client.sheetRowNum,
              category: "discrepancy",
            });
          }
        }

        console.log(`\n🔍 DIRCOMP GATES FOR ${client.clientName}: hasExpense=${hasExpense}, actionableDue=${actionableDue}, expLock=${gasLocks.expense?.locked}`);

        if (hasExpense && actionableDue) {
          const expLock = gasLocks.expense;
          if (!expLock.locked) {
            console.log(`  -> Passing to readDirCompAlerts for ${client.clientName}`);
            const expAlerts = await readDirCompAlerts(sheets, client.masterSheetId);
            expAlerts.forEach(a => {
              a.clientName = client.clientName;
              a.clientId = client.clientSheetId;
              a.masterSheetId = client.masterSheetId;
              a.flagType = "expenseDashboardDiscr"; 
              a._fingerprint = buildAlertFingerprint(a); 
              a._legacyFingerprint = buildAlertFingerprintLegacy(a);
            });
            sweepItems.push({
              clientName: client.clientName, alertType: "expenseDashboardDiscr",
              alerts: expAlerts,
              autoUpdatesRow: client.sheetRowNum,
              category: "discrepancy",
            });
          }
        }

        if (hasCRM && actionableDue) {
          const crmLock = gasLocks.crm;
          if (!crmLock.locked) {
            for (const [mode, dashKey, appKey] of [["Pipeline", "crmPipeDashDiscr", "crmPipeAppDiscr"], ["Confirmed", "crmConfDashDiscr", "crmConfAppDiscr"]]) {
              const crmAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, mode, [dashKey, appKey], client.masterSheetId);
              crmAlerts.forEach(a => { 
                a.clientName = client.clientName;
                a.clientId = client.clientSheetId;
                a.masterSheetId = client.masterSheetId;
                a._fingerprint = buildAlertFingerprint(a); 
                a._legacyFingerprint = buildAlertFingerprintLegacy(a);
              });
              const dashAlerts = crmAlerts.filter(a => (a.flagType || a.alertType) === dashKey);
              const appAlerts  = crmAlerts.filter(a => (a.flagType || a.alertType) === appKey);
              sweepItems.push({ clientName: client.clientName, alertType: dashKey, alerts: dashAlerts, autoUpdatesRow: client.sheetRowNum, category: "discrepancy" });
              sweepItems.push({ clientName: client.clientName, alertType: appKey, alerts: appAlerts, autoUpdatesRow: client.sheetRowNum, category: "discrepancy" });
            }
          }
        }

        if (infoDue) {
          const logEntries = await readRecentAutoLogEntries_(sheets, client.masterSheetId, 200, batchData.autoLog);
          for (const [autoLogType, patterns] of Object.entries(AUTOLOG_TYPE_PATTERNS)) {
            const matchedAlerts = [];
            for (const entry of logEntries) {
              const lines = (entry.details || "").split(/\n+/);
              for (const line of lines) {
                if (!patterns.some(p => line.includes(p))) continue;
                const fingerprintInput = `${client.clientName}|${autoLogType}|${line}`;
                matchedAlerts.push({
                  clientName: client.clientName,
                  alertType: autoLogType,
                  summary: line,
                  _fingerprint: createHash("sha256").update(fingerprintInput).digest("hex").substring(0, 16),
                });
              }
            }
            if (matchedAlerts.length > 0) {
              sweepItems.push({ clientName: client.clientName, alertType: autoLogType, alerts: matchedAlerts, autoUpdatesRow: client.sheetRowNum, category: "info" });
            }
          }
        }

        if (proactiveDue) {
          console.log(`  🔍 Running proactive checks for ${client.clientName}...`);
          let sharedData = { confirmedData: null, pipelineData: null, autoLogData: batchData.autoLog || null };
          let fetchSuccess = false;
          
          try {
            const clientBatchResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
              spreadsheetId: client.clientSheetId,
              ranges: [
                "Confirmed!A1:CR5000",
                "Pipeline!A1:DD5000"
              ],
              valueRenderOption: "UNFORMATTED_VALUE"
            }));
            sharedData.confirmedData = clientBatchResp.data.valueRanges[0]?.values || [];
            sharedData.pipelineData = clientBatchResp.data.valueRanges[1]?.values || [];
            fetchSuccess = true;
          } catch (e) {
            console.log(`  ⚠️ Failed to fetch Confirmed/Pipeline for proactive checks: ${e.message}`);
          }

          if (fetchSuccess) {
            const proChecks = [
              checkRetainerInvoices_(client.clientName, client.clientSheetId, client.masterSheetId, sharedData, sheets),
              checkCRMWipe_(client.clientName, client.masterSheetId, sharedData),
              checkRevenueMismatch_(client.clientName, client.clientSheetId, sharedData),
              checkDirectCostsMismatch_(client.clientName, client.clientSheetId, sharedData),
              checkPipelineConfirmedOverlap_(client.clientName, client.clientSheetId, sharedData),
              checkRetainerShrinkBlocked_(client.clientName, client.masterSheetId, sharedData),
              checkUninvoicedNewJobs_(client.clientName, client.clientSheetId, sharedData),
              checkUninvoicedRevenue_(client.clientName, client.clientSheetId, sharedData),
              checkDeletedInvoices_(client.clientName, client.clientSheetId, client.masterSheetId, sharedData, sheets),
              checkJobStructureErrors_(client.clientName, client.clientSheetId, sharedData),
              checkDeletedExpenses_(client.clientName, client.clientSheetId, client.masterSheetId, sharedData, sheets),
              checkUnreceivedExpenses_(client.clientName, client.clientSheetId, sharedData),
              checkAutoLogErrors_(client.clientName, client.masterSheetId, sharedData),
              checkAutoLogInfiniteLoops_(client.clientName, client.masterSheetId, sharedData)
            ];

            const proResults = await Promise.all(proChecks);
            const proAlerts = proResults.flat();
            
            const proactiveTypes = [
              "retainer_invoice", "crm_wipe", "revenue_mismatch", "direct_costs_mismatch",
              "pipeline_confirmed_overlap", "retainer_shrink_blocked", "uninvoiced_new_job", "uninvoiced_revenue",
              "deleted_invoice", "job_structure_error", "deleted_expense", "unreceived_expenses",
              "autolog_error", "infinite_loop"
            ];
            
            const groupedProactive = {};
            proactiveTypes.forEach(t => groupedProactive[t] = []);
            
            proAlerts.forEach(a => {
              const fpInput = a.alertKey;
              a._fingerprint = createHash("sha256").update(fpInput).digest("hex").substring(0, 16);
              if (a.legacyAlertKey) {
                a._legacyFingerprint = createHash("sha256").update(a.legacyAlertKey).digest("hex").substring(0, 16);
              }
              a.summary = a.heading || a.detail || a.alertType;
              if (groupedProactive[a.alertType]) groupedProactive[a.alertType].push(a);
            });

            proactiveTypes.forEach(type => {
              sweepItems.push({
                clientName: client.clientName,
                alertType: type,
                alerts: groupedProactive[type],
                autoUpdatesRow: client.sheetRowNum,
                category: "proactive"
              });
            });
            
            if (proAlerts.length > 0) {
              console.log(`  ✓ Proactive checks found ${proAlerts.length} alerts for ${client.clientName}`);
            }
          } else {
            console.log(`  ⏭ Skipping proactive checks for ${client.clientName} due to fetch failure to prevent false auto-resolves.`);
          }
        }

        clientsChecked++;
      } catch (clientErr) {
        errors++;
        console.error(`  run_flag_sweep: error for ${client.clientName}: ${clientErr.message}`);
      }

      await new Promise(r => setTimeout(r, 1200));
    }

    if (sweepItems.length > 0) {
      await ensureAlertMemoryTab(sheets, acIdSweep);
      const memoryRows = await readAlertMemory(sheets, acIdSweep);
      const handledHashes = getHandledFingerprintHashes_(memoryRows);
      const existingHashes = new Set(memoryRows.map(r => r.fingerprintHash).filter(Boolean));
      console.log(`  run_flag_sweep: ${sweepItems.length} fingerprint items to resolve, ${handledHashes.size} handled hashes, ${existingHashes.size} existing hashes`);

      const clientMetaMap = new Map(clientChunk.map(c => [c.clientName, c]));

      for (const item of sweepItems) {
        if (item.category === "discrepancy" || item.category === "proactive") {
          const freshHashes = new Set();
          (item.alerts || []).forEach(a => {
            if (a._fingerprint) freshHashes.add(a._fingerprint);
            if (a._legacyFingerprint) freshHashes.add(a._legacyFingerprint);
          });
          const staleRows = memoryRows.filter(r => 
            r.clientName === item.clientName && 
            r.alertType === item.alertType && 
            (r.status === "cached" || r.status === "pending_automation" || r.status === "ignored" || (item.category === "proactive" && r.status === "task")) && 
            !freshHashes.has(r.fingerprintHash)
          );

          for (const stale of staleRows) {
            try {
              let updatedSnapshot = stale.dataSnapshot;
              let wasTask = false;
              if (stale.status === "task") {
                wasTask = true;
                try {
                  const snap = JSON.parse(stale.dataSnapshot || "{}");
                  snap.resolvedAt = new Date().toISOString();
                  snap.autoResolvedReason = "Underlying proactive alert condition no longer detected";
                  updatedSnapshot = JSON.stringify(snap);
                } catch(e) {}
              }

              let newStatus;
              if (stale.status === "task") newStatus = "task_resolved";
              else if (stale.status === "ignored") newStatus = "superseded";
              else newStatus = "auto_resolved";

              await updateAlertMemoryRow(sheets, acIdSweep, stale.rowIndex, { 
                ...stale, 
                status: newStatus,
                lastRechecked: new Date().toISOString(),
                dataSnapshot: updatedSnapshot
              });
              console.log(`  🩹 AUTO-RESOLVED stale ${item.alertType} ${stale.status} for ${item.clientName}: ${stale.fingerprintHash} -> ${newStatus}`);
              stale.status = newStatus;
              
              if (wasTask) {
                await redisClient.del("triage_tasks_cache").catch(() => {});
              }
            } catch(e) {
              console.log(`  ⚠️ Failed to auto-resolve stale alert: ${e.message}`);
            }
          }

          const clientMeta = clientMetaMap.get(item.clientName);
          const pendingAutoRows = memoryRows.filter(r => 
            r.clientName === item.clientName && 
            r.alertType === item.alertType && 
            r.status === "pending_automation" &&
            freshHashes.has(r.fingerprintHash)
          );

          for (const pRow of pendingAutoRows) {
            let snap = {};
            try { snap = JSON.parse(pRow.dataSnapshot || "{}"); } catch(e){}
            const detectedAt = snap.detectedAt ? new Date(snap.detectedAt).getTime() : Date.now();
            const firstSeen = pRow.firstSeen ? new Date(pRow.firstSeen).getTime() : null;
            const newStatus = evaluateAutomationStatus_(item.alertType, item.category, clientMeta, detectedAt, firstSeen);
            
            if (newStatus === "cached") {
              try {
                await updateAlertMemoryRow(sheets, acIdSweep, pRow.rowIndex, { 
                  ...pRow, 
                  status: "cached",
                  lastRechecked: new Date().toISOString()
                });
                console.log(`  ⏰ Woke up pending_automation alert for ${item.clientName}: ${pRow.fingerprintHash}`);
                pRow.status = "cached";
                alertsWoken++;
                raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "woken" });
              } catch(e) {
                console.log(`  ⚠️ Failed to wake up alert: ${e.message}`);
              }
            }
          }
        }

        if (!item.alerts || item.alerts.length === 0) continue;

        for (const alert of item.alerts) {
          try {
            let summary = alert.summary;
            if (typeof summary === "object" && summary !== null) {
              summary = summary.summary;
            }
            if (!summary && (item.alertType.startsWith("crmPipe") || item.alertType.startsWith("crmConf"))) {
              const crmArr = alert.data?.crmData || [];
              const shtArr = alert.data?.sheetData || [];
              const client = crmArr[0] || shtArr[1] || "";
              const job    = crmArr[1] || shtArr[2] || "";
              const code   = crmArr[2] || shtArr[0] || "";
              const jobDesc = [client, job, code].filter(Boolean).join(" — ");
              summary = `CRM ${item.alertType} ${jobDesc}`.trim();
            }
            summary = summary || `${item.alertType} — ${item.clientName} (row ${alert.rowNumber})`;

            // Dual-hash match: check modern hash first, then legacy hash
            let exRow = memoryRows.find(r => r.clientName === item.clientName && r.fingerprintHash === alert._fingerprint);
            if (!exRow && alert._legacyFingerprint) {
              exRow = memoryRows.find(r => r.clientName === item.clientName && r.fingerprintHash === alert._legacyFingerprint);
            }

            const detectedAtIso = new Date().toISOString();
            const { _fingerprint, _legacyFingerprint, ...alertForSnapshot } = alert;
            alertForSnapshot.detectedAt = detectedAtIso;

            if (exRow) {
              // Case 1: Auto-resolved Task that returned
              if (exRow.status === "task_resolved") {
                let snap = {};
                try { snap = JSON.parse(exRow.dataSnapshot || "{}"); } catch(e) {}
                if (snap.autoResolvedReason) {
                  delete snap.resolvedAt;
                  delete snap.autoResolvedReason;
                  const furtherNotes = Array.isArray(snap.furtherNotes) ? snap.furtherNotes : [];
                  furtherNotes.push({
                    date: detectedAtIso,
                    note: "[Auto-Reopened] Underlying alert condition detected again on sheet"
                  });
                  snap.furtherNotes = furtherNotes;
                  snap.detectedAt = detectedAtIso;

                  await updateAlertMemoryRow(sheets, acIdSweep, exRow.rowIndex, {
                    ...exRow,
                    fingerprintHash: alert._fingerprint,
                    status: "task",
                    alertSummary: summary,
                    lastRechecked: detectedAtIso,
                    dataSnapshot: JSON.stringify(snap)
                  });
                  exRow.status = "task";
                  exRow.fingerprintHash = alert._fingerprint;
                  await redisClient.del("triage_tasks_cache").catch(() => {});
                  flagsRaised++;
                  console.log(`  🔄 REVIVED auto-resolved task for ${item.clientName}: ${summary}`);
                  raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "task_reopened" });
                  continue;
                }
              }

              // Case 2: Auto-resolved regular alert that returned
              if (exRow.status === "auto_resolved" || exRow.status === "superseded") {
                const clientMeta = clientMetaMap.get(item.clientName);
                const newStatus = evaluateAutomationStatus_(item.alertType, item.category, clientMeta, new Date(detectedAtIso).getTime(), null);

                await updateAlertMemoryRow(sheets, acIdSweep, exRow.rowIndex, {
                  ...exRow,
                  fingerprintHash: alert._fingerprint,
                  status: newStatus,
                  alertSummary: summary,
                  lastRechecked: detectedAtIso,
                  dataSnapshot: JSON.stringify(alertForSnapshot)
                });
                exRow.status = newStatus;
                exRow.fingerprintHash = alert._fingerprint;

                if (newStatus === "pending_automation") {
                  alertsDelayed++;
                  raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "delayed" });
                } else {
                  flagsRaised++;
                  raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "revived" });
                }
                console.log(`  🔄 REVIVED auto-resolved alert for ${item.clientName} (${item.alertType}): ${alert._fingerprint} -> ${newStatus}`);
                continue;
              }

              // Case 3: Previously ignored or accepted
              if (exRow.status === "ignored" || exRow.status === "accepted") {
                if (exRow.fingerprintHash !== alert._fingerprint) {
                  await updateAlertMemoryRow(sheets, acIdSweep, exRow.rowIndex, {
                    ...exRow,
                    fingerprintHash: alert._fingerprint,
                    lastRechecked: detectedAtIso
                  });
                  exRow.fingerprintHash = alert._fingerprint;
                  console.log(`  🏷️ Migrated ${exRow.status} alert hash for ${item.clientName}: ${alert._fingerprint}`);
                }
                continue;
              }

              // Case 4: Already active (cached, task, pending_automation)
              let newSnapshotStr;
              if (exRow.status === "task") {
                try {
                  const oldSnap = JSON.parse(exRow.dataSnapshot || "{}");
                  newSnapshotStr = JSON.stringify({ ...oldSnap, ...alertForSnapshot });
                } catch(e) { newSnapshotStr = JSON.stringify(alertForSnapshot); }
              } else {
                newSnapshotStr = JSON.stringify(alertForSnapshot);
              }

              const hashNeedsMigration = exRow.fingerprintHash !== alert._fingerprint;
              if (exRow.dataSnapshot !== newSnapshotStr || exRow.alertSummary !== summary || hashNeedsMigration) {
                try {
                  await updateAlertMemoryRow(sheets, acIdSweep, exRow.rowIndex, {
                    ...exRow,
                    fingerprintHash: alert._fingerprint,
                    alertSummary: summary,
                    dataSnapshot: newSnapshotStr,
                    lastRechecked: detectedAtIso
                  });
                  exRow.fingerprintHash = alert._fingerprint;
                  exRow.dataSnapshot = newSnapshotStr;
                  console.log(`  🔄 Updated active alert for ${item.clientName}: ${exRow.fingerprintHash}`);
                } catch(e) {
                  console.log(`  ⚠️ Failed to update snapshot: ${e.message}`);
                }
              }
              continue;
            }

            // Case 5: Brand new alert!
            const clientMeta = clientMetaMap.get(item.clientName);
            const status = evaluateAutomationStatus_(item.alertType, item.category, clientMeta, new Date(detectedAtIso).getTime(), null);

            const newRow = {
              fingerprintHash: alert._fingerprint,
              alertType: item.alertType,
              clientName: item.clientName,
              alertSummary: summary,
              cachedOptionsJSON: "",
              status: status,
              category: item.category || "discrepancy",
              dataSnapshot: JSON.stringify(alertForSnapshot),
            };
            await appendAlertMemoryRow(sheets, acIdSweep, newRow);
            memoryRows.push(newRow);

            flagsRaised++;
            if (status === "pending_automation") {
              console.log(`  💤 Alert ${alert._fingerprint} is pending automation run`);
              alertsDelayed++;
              raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "delayed" });
            } else {
              raisedDetail.push({ clientName: item.clientName, flagKey: item.alertType, status: "raised" });
            }
            console.log(`  ✅ NEW alert for ${item.clientName} / ${item.alertType}: ${alert._fingerprint}`);
          } catch (memErr) {
            console.log(`  ⚠️ Could not process AlertMemory row for ${item.clientName}/${item.alertType}: ${memErr.message}`);
          }
        }
      }
    }

    if (!hasMore) {
      try {
        if (!isForced) {
          if (actionableDue) await markCategoryChecked_(sheets, acIdSweep, "actionable", schedule);
          if (infoDue) await markCategoryChecked_(sheets, acIdSweep, "info", schedule);
          if (proactiveDue) await markCategoryChecked_(sheets, acIdSweep, "proactive", schedule);
        }
      } catch (scheduleErr) {
        console.log(`  ⚠️ Could not update SweepSchedule: ${scheduleErr.message}`);
      }
    }

    const elapsedS = Math.round((Date.now() - sweepStart) / 1000);
    console.log(`run_flag_sweep chunk complete in ${elapsedS}s: ${clientsChecked} clients checked, ${flagsRaised} flags raised, ${errors} errors, delayed: ${alertsDelayed}, woken: ${alertsWoken}, hasMore: ${hasMore}`);
    await logFlagSweepRun(sheets, acIdSweep, { clientsChecked, flagsRaised, errors, alertsDelayed, alertsWoken, elapsedSeconds: elapsedS, raisedDetail, isContinuation: startIdx > 0, categoriesRun: categoriesRunStr });
    return res.status(200).json({ success: true, clientsChecked, flagsRaised, errors, alertsDelayed, alertsWoken, elapsedSeconds: elapsedS, raisedDetail, hasMore, nextIdx });
  } catch (err) {
    console.error("❌ run_flag_sweep error:", err);
    const elapsedS = Math.round((Date.now() - sweepStart) / 1000);
    await logFlagSweepRun(sheets, acIdSweep, { clientsChecked: clientsChecked || 0, flagsRaised: flagsRaised || 0, errors: (errors || 0) + 1, alertsDelayed: alertsDelayed || 0, alertsWoken: alertsWoken || 0, elapsedSeconds: elapsedS, raisedDetail: raisedDetail || [], isContinuation: startIdx > 0, categoriesRun: categoriesRunStr || "" }).catch(() => {});
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleBuildCachedAlertOptions(req, res, sheets) {
  const { secret: buildSecret, automationCommanderSheetId: acIdBuild } = req.body;
  if (buildSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorised" });
  }
  if (!acIdBuild) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });

  const buildStart = Date.now();
  try {
    await ensureAlertMemoryTab(sheets, acIdBuild);
    const memoryRows = await readAlertMemory(sheets, acIdBuild);

    const pending = memoryRows.filter(r =>
      r.status === "cached" && 
      r.category === "discrepancy" && 
      !Object.prototype.hasOwnProperty.call(AUTOLOG_TYPE_PATTERNS, r.alertType) && 
      !r.cachedOptionsJSON
    );
    console.log(`build_cached_alert_options: ${pending.length} rows pending options`);

    const groups = new Map();
    for (const row of pending) {
      const key = `${row.clientName}::${row.alertType}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const { clientRows } = await readAutoUpdatesClientRows_(sheets, acIdBuild);
    const clientByName = new Map(clientRows.map(c => [c.clientName, c]));

    const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : `https://${process.env.VERCEL_URL}`;

    let built = 0, notFound = 0, errors = 0;
    let hasMore = false;
    let builtDetail = [];
    const TIME_LIMIT_MS = 220000;

    for (const [key, rows] of groups.entries()) {
      if (Date.now() - buildStart > TIME_LIMIT_MS) {
        console.log(`  ⏳ Time limit reached (${Math.round((Date.now() - buildStart)/1000)}s). Exiting cleanly to avoid 300s timeout.`);
        hasMore = true;
        break;
      }

      const [clientName, alertType] = key.split("::");
        const client = clientByName.get(clientName);
        if (!client) {
          console.log(`  ⚠️ ${clientName}: not found in current client list — skipping ${rows.length} row(s)`);
          notFound += rows.length;
          continue;
        }

        try {
          console.log(`  📊 Fetching shared sheet data for ${clientName} to prevent 429 errors...`);
          let sharedData = {};
          try {
            const [confResp, pipeResp] = await Promise.all([
              withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: client.clientSheetId, range: "Confirmed!A1:CR5000", valueRenderOption: "FORMATTED_VALUE" })).catch(() => null),
              withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: client.clientSheetId, range: "Pipeline!A1:DD5000", valueRenderOption: "FORMATTED_VALUE" })).catch(() => null)
            ]);
            if (confResp) sharedData.confirmedDataWide = confResp.data.values || [];
            if (pipeResp) sharedData.pipelineData = pipeResp.data.values || [];
            console.log(`  ✓ Shared data loaded for ${clientName}`);
          } catch(e) {
            console.log(`  ⚠️ Failed to fetch shared data for ${clientName}: ${e.message}`);
          }

        let currentAlerts = [];
        if (alertType === "invoiceDashboardDiscr" || alertType === "invoice") {
          currentAlerts = await readInvCompAlerts(sheets, client.masterSheetId);
          currentAlerts.forEach(a => { 
            a.clientName = client.clientName;
            a.flagType = "invoiceDashboardDiscr"; 
            a._fingerprint = buildAlertFingerprint(a); 
            a._legacyFingerprint = buildAlertFingerprintLegacy(a);
          });
        } else if (alertType === "expenseDashboardDiscr" || alertType === "expense") {
          currentAlerts = await readDirCompAlerts(sheets, client.masterSheetId);
          currentAlerts.forEach(a => { 
            a.clientName = client.clientName;
            a.flagType = "expenseDashboardDiscr"; 
            a._fingerprint = buildAlertFingerprint(a); 
            a._legacyFingerprint = buildAlertFingerprintLegacy(a);
          });
        } else if (["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr", "crm"].includes(alertType)) {
          if (alertType === "crm") {
            const pipeAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, "Pipeline", ["crmPipeDashDiscr", "crmPipeAppDiscr"], client.masterSheetId);
            const confAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, "Confirmed", ["crmConfDashDiscr", "crmConfAppDiscr"], client.masterSheetId);
            currentAlerts = [...pipeAlerts, ...confAlerts];
            currentAlerts.forEach(a => { 
              a.clientName = client.clientName;
              a._fingerprint = buildAlertFingerprint(a); 
              a._legacyFingerprint = buildAlertFingerprintLegacy(a);
            });
          } else {
            const mode = alertType.startsWith("crmPipe") ? "Pipeline" : "Confirmed";
            const pairKey = alertType.endsWith("DashDiscr")
              ? [alertType, alertType.replace("DashDiscr", "AppDiscr")]
              : [alertType.replace("AppDiscr", "DashDiscr"), alertType];
            currentAlerts = await readCRMCompAlerts(sheets, client.masterSheetId, mode, pairKey, client.masterSheetId);
            currentAlerts.forEach(a => { 
              a.clientName = client.clientName;
              a._fingerprint = buildAlertFingerprint(a); 
              a._legacyFingerprint = buildAlertFingerprintLegacy(a);
            });
            currentAlerts = currentAlerts.filter(a => (a.flagType || a.alertType) === alertType);
          }
        } else {
          console.log(`  ⚠️ Unknown alertType "${alertType}" for ${clientName} — skipping`);
          notFound += rows.length;
          continue;
        }

        for (const row of rows) {
          const match = currentAlerts.find(a => a._fingerprint === row.fingerprintHash || a._legacyFingerprint === row.fingerprintHash);
          if (!match) {
            console.log(`  ⏭ ${clientName}/${alertType}: fingerprint ${row.fingerprintHash.slice(0, 8)}… no longer found — marking auto_resolved`);
            try {
              await updateAlertMemoryRow(sheets, acIdBuild, row.rowIndex, {
                ...row, status: "auto_resolved"
              });
            } catch (e) {
              console.log(`  ⚠️ Failed to mark ghost row resolved: ${e.message}`);
            }
            notFound++;
            continue;
          }

          if (row.fingerprintHash !== match._fingerprint) {
            try {
              await updateAlertMemoryRow(sheets, acIdBuild, row.rowIndex, {
                ...row, fingerprintHash: match._fingerprint
              });
              row.fingerprintHash = match._fingerprint;
            } catch(e) {}
          }

          match.clientId = client.clientSheetId;
          match.masterSheetId = client.masterSheetId;
          match.clientName = client.clientName;
          match.flagType = match.flagType || alertType;
          match.fingerprintHash = row.fingerprintHash;

          try {
            const analyzeRes = await fetch(`${baseUrl}/api/triage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "analyze_alert", alert: match, memoryRow: row, automationCommanderSheetId: acIdBuild, sharedData }),
            });
            const analyzeData = await analyzeRes.json();
            if (analyzeData.success) {
              if (analyzeData.options) {
                let updatedSnapshot = row.dataSnapshot;
                if (analyzeData.previousIgnoreReason) {
                  try {
                    const snapObj = JSON.parse(updatedSnapshot || "{}");
                    snapObj.previousIgnoreReason = analyzeData.previousIgnoreReason;
                    updatedSnapshot = JSON.stringify(snapObj);
                  } catch (e) {}
                }
                await updateAlertMemoryRow(sheets, acIdBuild, row.rowIndex, {
                  ...row,
                  cachedOptionsJSON: JSON.stringify(analyzeData.options),
                  dataSnapshot: updatedSnapshot
                });
              }
              built++;
              builtDetail.push({ clientName, flagKey: alertType, fromCache: !!analyzeData.fromCache });
              console.log(`  ✅ ${clientName}/${alertType}: options built`);
            } else {
              errors++;
              console.log(`  ❌ ${clientName}/${alertType}: analyze_alert failed — ${analyzeData.error || "unknown"}`);
            }
          } catch (fetchErr) {
            errors++;
            console.log(`  ❌ ${clientName}/${alertType}: analyze_alert call failed — ${fetchErr.message}`);
          }

          await new Promise(r => setTimeout(r, 1200));
        }
      } catch (groupErr) {
        errors += rows.length;
        console.log(`  ❌ ${clientName}/${alertType}: group processing failed — ${groupErr.message}`);
      }
    }

    const elapsedS = Math.round((Date.now() - buildStart) / 1000);
    console.log(`build_cached_alert_options complete in ${elapsedS}s: ${built} built, ${notFound} not found, ${errors} errors, hasMore: ${hasMore}`);

    const RICH_INFO_TYPES = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete",
      "retainerInvoicesCreated", "retainerInvoicesDeleted", "invoiceStaleUnsentChanges"];
    const pendingRich = memoryRows.filter(r =>
      r.status === "cached" && RICH_INFO_TYPES.includes(r.alertType) && !r.cachedOptionsJSON
    );
    let richAnalyzed = 0, richErrors = 0;
    if (pendingRich.length > 0 && !hasMore) {
      console.log(`build_cached_alert_options: ${pendingRich.length} rich informational row(s) pending analysis`);
      for (const row of pendingRich) {
        if (Date.now() - buildStart > TIME_LIMIT_MS) {
          console.log(`  ⏳ Time limit reached during rich-type analysis — remaining rows will be picked up next run.`);
          hasMore = true;
          break;
        }
        const client = clientByName.get(row.clientName);
        if (!client) { richErrors++; continue; }
        try {
          const analyzeRes = await fetch(`${baseUrl}/api/triage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "analyze_noaction_flag",
              clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId,
              automationCommanderSheetId: acIdBuild, flagType: row.alertType, clientName: row.clientName,
              targetLine: row.alertSummary,
            }),
          });
          const analyzeData = await analyzeRes.json();
          if (analyzeData.success) {
            await updateAlertMemoryRow(sheets, acIdBuild, row.rowIndex, {
              ...row, cachedOptionsJSON: JSON.stringify(analyzeData),
            });
            richAnalyzed++;
            console.log(`  ✅ ${row.clientName}/${row.alertType}: targeted analysis stored`);
          } else {
            richErrors++;
            console.log(`  ❌ ${row.clientName}/${row.alertType}: analyze_noaction_flag failed — ${analyzeData.error || "unknown"}`);
          }
        } catch (richErr) {
          richErrors++;
          console.log(`  ❌ ${row.clientName}/${row.alertType}: analyze_noaction_flag call failed — ${richErr.message}`);
        }
        await new Promise(r => setTimeout(r, 1200)); 
      }
      console.log(`build_cached_alert_options: rich informational analysis — ${richAnalyzed} analyzed, ${richErrors} errors`);
    }

    await logBuildOptionsRun(sheets, acIdBuild, { 
      processed: pending.length, built, notFound, errors, elapsedSeconds: elapsedS, builtDetail, isContinuation: req.body.isContinuation
    });

    return res.status(200).json({ success: true, processed: pending.length, built, notFound, errors, elapsedSeconds: elapsedS, hasMore, richAnalyzed, richErrors });
  } catch (err) {
    console.error("❌ build_cached_alert_options error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

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
  const newBlock = `{App ID: ${transactionId}}{Amt: ${amount}}{Status:${status ? " " + status : ""}}{Rec date:${recDate ? " " + recDate : ""}}{Pay date:${payDate ? " " + payDate : ""}}{Description:${description ? " " + description : ""}}`;

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

export async function handleAnalyzeAlert(req, res, sheets) {
// Generate matching options for an alert
      const { alert, sharedData, automationCommanderSheetId = req.body.automationCommanderSheetId } = req.body;
      
      if (!alert) {
        res.status(400).json({ success: false, error: "Missing alert data" });
        return;
      }

      // Proactive alerts (revenue_mismatch, direct_costs_mismatch, retainer_invoice etc.)
      // don't have automation options to generate — they have heading/detail only.
      // Return empty options gracefully rather than crashing on missing alert.type/clientId.
      if (!alert.type && !alert.data && alert.alertKey) {
        return res.status(200).json({ success: true, options: [], isProactive: true });
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
        
        // CRITICAL FIX: Use the row passed directly from the builder to bypass Google Sheets read-after-write latency
        const memoryRow = req.body.memoryRow || findMemoryRow(memoryRows, fingerprintHash);

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
              // For crmPipeAppDiscr Pipeline alerts, re-fetch copiedToConf live
              // since it can change in the sheet independently of the cached options
              let liveCopiedToConf = null;
              if ((alert.alertType === "crmPipeAppDiscr") && alert.clientId) {
                try {
                  // Find jobRow from cached option
                  const cachedJobRow = validCachedOptions[0]?.jobRow;
                  if (cachedJobRow) {
                    const ddResp = await sheets.spreadsheets.values.get({
                      spreadsheetId: alert.clientId,
                      range: `Pipeline!DD${cachedJobRow}`,
                    });
                    liveCopiedToConf = String(ddResp.data.values?.[0]?.[0] || "").trim();
                    console.log(`  📋 Live copiedToConf for row ${cachedJobRow}: "${liveCopiedToConf}"`);
                  }
                } catch(e) {
                  console.log(`  copiedToConf live fetch failed: ${e.message}`);
                }
              }
              // Inject live copiedToConf into cached options if fetched
              let optionsToReturn = liveCopiedToConf !== null
                ? validCachedOptions.map(o => ({ ...o, copiedToConf: liveCopiedToConf }))
                : validCachedOptions;

              // Regenerate jobRowsData fresh for cached options — this data may be
              // missing entirely (cached before this feature existed) or stale (sheet
              // has changed since the options were cached). Determine the correct tab:
              // CRM alerts use Pipeline/Confirmed per their mode; invoice/expense options
              // always reference the Confirmed tab.
              try {
                const jrdTabName = (alert.type === "crm" || alert.sheetName === "CRMComp")
                  ? (alert.mode === "Pipeline" || alert.alertType === "crmPipeAppDiscr" || alert.alertType === "crmPipeDashDiscr" ? "Pipeline" : "Confirmed")
                  : "Confirmed";
                const jrdSheetId = alert.clientId;
                const jrdCache = new Map();
                optionsToReturn = await Promise.all(optionsToReturn.map(async (opt) => {
                  if (!opt.jobRow || (opt.matchType !== "existing_job" && opt.matchType !== "job")) return opt;
                  // Prefer explicit target fields (set at generation time) over parsing
                  // recommendedActions text — explicit fields can't be mismatched.
                  let highlightSlot = null;
                  if (opt.targetSlotType && opt.targetSlotNum && opt.targetRowNum) {
                    highlightSlot = { type: opt.targetSlotType, rowNum: opt.targetRowNum, slotNum: opt.targetSlotNum };
                  } else {
                    // Fallback for options cached before explicit fields existed
                    const actionsText = Array.isArray(opt.recommendedActions) ? opt.recommendedActions.join(" ") : "";
                    const expSlotMatch = actionsText.match(/ExpSlot(\d)/i);
                    const invSlotMatch = actionsText.match(/\bslot (\d)\b/i) || actionsText.match(/invoice slot (\d)/i);
                    if (expSlotMatch) highlightSlot = { type: "expense", rowNum: opt.jobRow, slotNum: parseInt(expSlotMatch[1]) };
                    else if (invSlotMatch) highlightSlot = { type: "invoice", rowNum: opt.jobRow, slotNum: parseInt(invSlotMatch[1]) };
                  }
                  const cacheKey = `${opt.jobRow}-${highlightSlot?.slotNum ?? "none"}`;
                  if (!jrdCache.has(cacheKey)) {
                    jrdCache.set(cacheKey, await fetchJobRowsForDisplay(sheets, jrdSheetId, jrdTabName, opt.jobRow, highlightSlot, sharedData));
                  }
                  return { ...opt, jobRowsData: jrdCache.get(cacheKey) };
                }));
              } catch (jrdErr) {
                console.log(`  ⚠ jobRowsData regeneration on cache hit failed (non-fatal): ${jrdErr.message}`);
              }

              return res.status(200).json({
                success: true,
                options: optionsToReturn,
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
          if (memoryRow) {
            try {
              const snapObj = JSON.parse(memoryRow.dataSnapshot || "{}");
              snapObj.previousIgnoreReason = previousIgnoreReason;
              memoryRow.dataSnapshot = JSON.stringify(snapObj);
            } catch(e){}
          }
        }
        // ────────────────────────────────────────────────────────────────────

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
              // Confirmed tab expense — find the row by TransactionID and update the VAT field
              const slotNum = source === "Slot1" ? 1 : source === "Slot2" ? 2 : source === "Slot3" ? 3 : null;
              const slotColMap = {
                1: { vat: "BZ", txId: "CD" },
                2: { vat: "CG", txId: "CK" },
                3: { vat: "CN", txId: "CR" },
              };
              const transactionId = String(accounting[6] || "").trim();
              const newVATValue = vatAmount > 0 ? "Yes" : "No";
              console.log(`  📊 Slot VAT mismatch: source=${source}, transactionId=${transactionId}, newVAT=${newVATValue}`);

              if (!slotNum || !transactionId) {
                const options = [{
                  optionId: 1,
                  title: `MANUAL INVESTIGATION REQUIRED — Could not identify slot or transaction ID`,
                  matchType: "info",
                  matchAnalysis: {
                    matchConfidence: "N/A",
                    reasonForChoice: `Source: ${source}, TransactionID: "${transactionId || "(blank)"}"`,
                    discrepancies: `VAT mismatch on ${source} for "${vendorDesc}"`,
                  },
                  recommendedActions: [
                    `Check the VAT field for "${vendorDesc}" in ${source} of the Confirmed tab`,
                  ],
                }];
                return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
              }

              const cols = slotColMap[slotNum];
              // Search the Confirmed tab for the row containing this TransactionID
              const confirmedResp = await sheets.spreadsheets.values.get({
                spreadsheetId: alert.clientId,
                range: `Confirmed!${cols.txId}2:${cols.txId}2000`,
              });
              const txRows = confirmedResp.data.values || [];
              let confirmedRow = -1;
              for (let i = 0; i < txRows.length; i++) {
                if (String(txRows[i]?.[0] || "").trim() === transactionId) {
                  confirmedRow = i + 2; // 1-indexed, data starts row 2
                  break;
                }
              }
              console.log(`  Confirmed tab row search for txId=${transactionId}: row=${confirmedRow}`);

              if (confirmedRow === -1) {
                const options = [{
                  optionId: 1,
                  title: `MANUAL INVESTIGATION REQUIRED — Transaction not found in Confirmed tab`,
                  matchType: "info",
                  matchAnalysis: {
                    matchConfidence: "N/A",
                    reasonForChoice: `Could not find transaction ID "${transactionId}" in ${source} of the Confirmed tab. Manual investigation required.`,
                    discrepancies: `VAT mismatch for "${vendorDesc}"`,
                  },
                  recommendedActions: [
                    `Search the Confirmed tab for transaction "${transactionId}" and correct the VAT field in ${source}`,
                  ],
                }];
                return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
              }

              const options = [{
                optionId: 1,
                title: `Update VAT setting to "${newVATValue}" for "${vendorDesc}" in Confirmed tab ${source} (Row ${confirmedRow})`,
                matchType: "existing_job",
                jobRow: confirmedRow,
                jobName: vendorDesc,
                matchAnalysis: {
                  matchConfidence: "High",
                  reasonForChoice: `Accounting system shows VAT ${vatAmount > 0 ? `of £${vatAmount.toFixed(2)}` : "not applied"} for this expense. The Confirmed tab ${source} VAT field should be "${newVATValue}".`,
                  discrepancies: `VAT mismatch — accounting system has VAT ${vatAmount > 0 ? "applied" : "not applied"}, Confirmed tab has the opposite`,
                },
                recommendedActions: [
                  `Update VAT setting for "${vendorDesc}" in Confirmed tab ${source} to "${newVATValue}"`,
                  `write ${newVATValue} to ${cols.vat}${confirmedRow} (${source} VAT field)`,
                ],
              }];
              console.log(`  ✅ Slot VAT fix: write "${newVATValue}" to ${cols.vat}${confirmedRow}`);
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
              // Mixed VAT treatment — vendor has some items with VAT and some without.
              // Changing col B would break the other items, so we offer per-item fix only.
              // This specific expense has vatAmount, so we know what THIS item should be.
              const thisVAT = vatAmount > 0 ? "Yes" : "No";
              const options = [{
                optionId: 1,
                title: `VAT mismatch on this item only — vendor "${vendorName}" has mixed VAT treatment`,
                matchType: "info",
                matchAnalysis: {
                  matchConfidence: "Medium",
                  reasonForChoice: `${vendorOGRows.length} Outgoings items exist for "${vendorName}" with mixed VAT treatments (${vatTreatments.filter(v=>v==="yes").length} with VAT, ${vatTreatments.filter(v=>v==="no").length} without). Changing the vendor-level VAT setting (Outgoings col B) would affect all items. The discrepancy on this specific item suggests the accounting system recorded VAT ${vatAmount > 0 ? `of £${vatAmount.toFixed(2)}` : "not applied"} but the Outgoings tab shows the opposite. Please review this item individually in the Outgoings tab for ${source}.`,
                  discrepancies: `VAT mismatch on this item — accounting: VAT ${vatAmount > 0 ? "applied" : "not applied"}, Outgoings: opposite`,
                },
                recommendedActions: [
                  `Review the ${source} entry for "${expDescription}" in the Outgoings tab`,
                  `The accounting system shows VAT ${vatAmount > 0 ? `of £${vatAmount.toFixed(2)} (gross: £${(expAmount + vatAmount).toFixed(2)})` : "not applied"}. Check whether the Outgoings note VAT field is set correctly for this item.`,
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
          let confirmedData = [];
          if (sharedData && sharedData.confirmedDataWide) {
            confirmedData = sharedData.confirmedDataWide;
            console.log(`  ✓ Used cached Confirmed data (${confirmedData.length} rows)`);
          } else {
            const confirmedResponse = await withRetry(() => sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: "Confirmed!A1:CR5000",
            }));
            confirmedData = confirmedResponse.data.values || [];
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
                      // date was already read above but previously omitted
                      // here — fixed 20 Aug 2026, confirmed with Paul that
                      // empty expense placeholders do carry a real expected
                      // date the same way invoice placeholders do, needed
                      // for the date-tolerance check added below.
                      childSlots.push({ label: `Row ${childSheetRow} ExpSlot${s+1}`, empty: true, date, sheetRow: childSheetRow, slotNum: s+1 });
                      continue;
                    }
                    const amtNum = parseFloat(String(amt).replace(/[£$€,]/g, '')) || 0;
                    const isAllocated = !!(appId && !appId.toUpperCase().includes('MANUAL-ENTRY'));
                    if (isAllocated) childAllocated += amtNum;
                    childSlots.push({ label: `Row ${childSheetRow} ExpSlot${s+1}`, descr, amt, amtNum, date, appId, isAllocated, empty: false, sheetRow: childSheetRow, slotNum: s+1 });
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
                      // Same fix as the retainer branch above (20 Aug 2026).
                      slots.push({ label: `Row ${sheetRow} ExpSlot${s+1}`, empty: true, date, sheetRow, slotNum: s+1 });
                      continue;
                    }
                    const amtNum = parseFloat(String(amt).replace(/[£$€,]/g, '')) || 0;
                    const isAllocated = !!(appId && !appId.toUpperCase().includes('MANUAL-ENTRY'));
                    if (isAllocated) totalAllocated += amtNum;
                    slots.push({ label: `Row ${sheetRow} ExpSlot${s+1}`, descr, amt, amtNum, date, appId, isAllocated, empty: false, sheetRow, slotNum: s+1 });
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

          // ── TIER 1: Single job with exact amount placeholder match — skip Claude ──
          // If exactly one candidate job has a single unallocated placeholder slot whose
          // amount exactly matches the expense, generate the option directly.
          const exactMatches = candidateJobs.flatMap(job =>
            job.slots.filter(s => !s.empty && !s.isAllocated && s.amtNum === expenseAmount)
              .map(s => ({ job, slot: s }))
          );
          if (exactMatches.length === 1) {
            const { job: emJob, slot: emSlot } = exactMatches[0];
            const slotColMap = {
              1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
              2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
              3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
            };
            const cols = slotColMap[emSlot.slotNum];
            const row = emSlot.sheetRow;
            console.log(`  ✅ Expense Tier 1 — exact placeholder match: ${emJob.parentJob} Row ${row} ExpSlot${emSlot.slotNum}`);
            const tier1ExpOption = {
              optionId: 1,
              title: `Allocate to ${emJob.parentJob} (Row ${row}, ExpSlot${emSlot.slotNum}) — exact amount match`,
              matchType: "job",
              jobRow: row,
              jobName: emJob.parentJob,
              matchAnalysis: {
                matchConfidence: "High",
                placeholderMatch: `YES — Row ${row} ExpSlot${emSlot.slotNum} has placeholder matching amount £${expenseAmount}`,
                budgetFit: "YES",
                reasonForChoice: `Exact amount match (£${expenseAmount}) with unallocated placeholder in ${emJob.parentJob}.`,
                discrepancies: "None",
              },
              recommendedActions: [
                `Allocate expense to ${emJob.parentJob} (Row ${row}), ExpSlot${emSlot.slotNum}`,
                `write ${expenseDescription} to ${cols.d}${row}, write ${expenseAmount} to ${cols.a}${row}, write ${vatYesNo} to ${cols.v}${row}, write ${expenseDate} to ${cols.dt}${row}, write 30 to ${cols.dp}${row}, write ${alert.summary?.status || ""} to ${cols.st}${row}`,
              ],
            };
            const expSummary1 = `Expense ${expenseDescription} £${expenseAmount} — ${alert.clientName}`;
            await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
            const expMemRows1 = await readAlertMemory(sheets, automationCommanderSheetId);
            const expMemRow1 = findMemoryRow(expMemRows1, fingerprintHash);
            if (expMemRow1) {
              await updateAlertMemoryRow(sheets, automationCommanderSheetId, expMemRow1.rowIndex, { ...expMemRow1, cachedOptionsJSON: JSON.stringify([tier1ExpOption]) });
            } else {
              await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: "expense", clientName: alert.clientName || "", alertSummary: expSummary1, cachedOptionsJSON: JSON.stringify([tier1ExpOption]), status: "cached" });
            }
            return res.status(200).json({ success: true, options: [tier1ExpOption], alertId: alert.rowNumber, previousIgnoreReason });
          }

          // ── TIER 2: System-generated options (ambiguous or no exact match) ──────
          // If forceAI flag is set, skip system options and use Claude directly.
          const forceAI = req.body.forceAI === true;
          if (forceAI) {
            console.log("  🤖 forceAI=true — using Claude for expense options");
            // Rebuild expense Claude prompt and call Claude
            const vatAmountRaw2 = parseFloat(String(alert.summary?.vatAmount || "0").replace(/[£$€,]/g, "")) || 0;
            const vatYesNo2     = vatAmountRaw2 > 0 ? "Yes" : "No";
            const expAmount2    = parseFloat(alert.summary?.amount) || 0;
            const expRef2       = alert.summary?.reference || "(unknown)";
            const expDesc2      = alert.summary?.description || "";
            const expDate2      = alert.summary?.date || "";
            const expAcctName2  = alert.summary?.accountName || "";
            const aiExpPrompt   = `You are a financial reconciliation assistant. Match this expense to an Outgoings vendor or Confirmed job slot.
Expense: £${expAmount2} | Ref: ${expRef2} | Description: ${expDesc2} | Date: ${expDate2} | Account: ${expAcctName2} | VAT: ${vatYesNo2}
Client: ${alert.clientName}
Return a JSON array of options with fields: optionId, title, matchType (job|category|info), jobRow, jobName, matchAnalysis, outgoingsData (for category matches), recommendedActions.`;
            const aiMsg2 = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 3000, messages: [{ role: "user", content: aiExpPrompt }] });
            await logClaudeUsage_(sheets, automationCommanderSheetId, alert.clientName || "", "expense", aiMsg2.usage?.input_tokens || 0, aiMsg2.usage?.output_tokens || 0).catch(() => {});
            let aiExpOptions = [];
            try {
              const raw2 = aiMsg2.content[0].type === "text" ? aiMsg2.content[0].text : "";
              const clean2 = raw2.replace(/```json/g, "").replace(/```/g, "").trim();
              const arr2 = clean2.slice(clean2.indexOf("["), clean2.lastIndexOf("]") + 1);
              aiExpOptions = JSON.parse(arr2);
              if (!Array.isArray(aiExpOptions)) aiExpOptions = [aiExpOptions];
            } catch(e) { aiExpOptions = [{ optionId: 1, title: "AI response could not be parsed", matchType: "info", recommendedActions: [] }]; }
            const aiExpSummary = alert.summary?.summary || `Expense ${expRef2} £${expAmount2}`;
            if (memoryRow) { await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(aiExpOptions) }); }
            else { await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: "expense", clientName: alert.clientName || "", alertSummary: aiExpSummary, cachedOptionsJSON: JSON.stringify(aiExpOptions), status: "cached" }); }
            return res.status(200).json({ success: true, options: aiExpOptions, alertId: alert.rowNumber, previousIgnoreReason });
          }
          // Noise-word stripping for fuzzy matching
          const EXP_NOISE = new Set(["ltd","limited","plc","inc","llc","llp","the","and","&",
            "group","co","corp","corporation","holdings","international","uk","us",
            "solutions","services","consulting","consultancy"]);
          const normExpWords = s => String(s||"").toLowerCase()
            .replace(/['"\-.,()]/g," ").replace(/\s+/g," ").trim()
            .split(" ").filter(w => w.length > 1 && !EXP_NOISE.has(w));

          const expDescWords = normExpWords(expenseDescription || expenseRef);

          // Build job matches first (prioritised), then vendor matches, new vendor, fallback
          const jobSysOptions = [];
          const vendorSysOptions = [];

          // ── Option type A: Match to existing Outgoings vendor ────────────────
          // Fuzzy word overlap between expense description and vendor name
          const slotColMapExp = {
            1: { d:"BX",a:"BY",v:"BZ",dt:"CA",dp:"CB",st:"CC",id:"CD" },
            2: { d:"CE",a:"CF",v:"CG",dt:"CH",dp:"CI",st:"CJ",id:"CK" },
            3: { d:"CL",a:"CM",v:"CN",dt:"CO",dp:"CP",st:"CQ",id:"CR" },
          };
          const outgoingsResp2 = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Outgoings!A1:F112",
          });
          const ogRows2 = outgoingsResp2.data.values || [];
          const vendorMatches = [];
          let lastVendorRow2 = 12;
          for (let i = 12; i <= Math.min(ogRows2.length - 1, 109); i++) {
            const vName = String(ogRows2[i]?.[0] || "").trim();
            const vVAT  = String(ogRows2[i]?.[1] || "").trim();
            if (!vName) continue;
            lastVendorRow2 = i;
            const vWords = normExpWords(vName);
            const overlap = expDescWords.some(w => vWords.includes(w)) || vWords.some(w => expDescWords.includes(w));
            if (overlap) vendorMatches.push({ sheetRow: i + 1, vendorName: vName, chargesVAT: vVAT });
          }
          const nextBlankOGRow2 = lastVendorRow2 < 109 ? lastVendorRow2 + 2 : null;
          console.log(`  Outgoings vendor matches: ${vendorMatches.length}`);

          for (const vm of vendorMatches.slice(0, 3)) {
            // Find the best available expense slot for this vendor across candidateJobs
            // For outgoings match, we use outgoingsData block — no slot write needed
            vendorSysOptions.push({
              optionId: vendorSysOptions.length + 1,
              title: `Assign to OUTGOINGS vendor "${vm.vendorName}" (Row ${vm.sheetRow})`,
              matchType: "category",
              jobRow: vm.sheetRow,
              jobName: vm.vendorName,
              matchingDetails: {
                unmatchedJobSummary: {
                  clientName: alert.clientName,
                  jobName: expenseDescription || expenseRef,
                  revenue: String(expenseAmount),
                  startDate: expenseDate,
                },
              },
              matchAnalysis: {
                matchConfidence: "Medium",
                placeholderMatch: "N/A — Outgoings vendor assignment",
                budgetFit: "YES",
                reasonForChoice: `Vendor name "${vm.vendorName}" matches expense description word(s). VAT: ${vm.chargesVAT}.`,
                discrepancies: "None",
              },
              outgoingsData: {
                categoryName: vm.vendorName,
                expenseMonth: expenseDate ? expenseDate.slice(3) : "",
                transactionId: alert.summary?.transactionId || "",
                amount: expenseAmount,
                description: expenseDescription || expenseRef,
                status: alert.summary?.status || "",
                recDate: expenseDate,
                payDate: "",
                vatCharged: vatYesNo,
              },
              recommendedActions: [`Assign expense to Outgoings vendor "${vm.vendorName}" (row ${vm.sheetRow})`],
            });
          }

          // ── Option type B: Match to Confirmed job (by description word overlap) ─
          const jobDescMatches = [];
          // Format is typically "Vendor name (outline of expense, may include end client name)".
          // Extract the bracketed portion to check for a client-name match — vendor name alone
          // (before the bracket) is not a reliable client signal.
          const expBracketMatch = (expenseDescription || "").match(/\(([^)]*)\)/);
          const expBracketWords = expBracketMatch ? normExpWords(expBracketMatch[1]) : [];

          // Date tolerance: ±expenseMonthsTolerance months from expense date —
          // added 20 Aug 2026, prompted by Paul after the invoice-side date
          // fix. expenseMonthsTolerance was already a configured tolerance
          // value (default 1 month) but was never actually used in this
          // matching logic at all — nothing here previously compared dates.
          // Confirmed with Paul that empty expense placeholder slots DO
          // carry a real expected date the same way invoice placeholders
          // do, which is what makes this comparison meaningful (the empty-
          // slot date was also being silently dropped before this same
          // change — see candidateJobs construction above). Reuses the
          // same parseSheetOrJsDate_/monthsWithinTolerance_ helpers as the
          // invoice side, not a second, separate definition.
          const expMonthsTol = Number(tolerances.expenseMonthsTolerance) || 1;
          const expDateParsed = parseSheetOrJsDate_(expenseDate);
          const dateWithinToleranceExp = (slotDateStr) => {
            if (!expDateParsed || !slotDateStr) return null; // null = unknown, not "false"
            const slotDate = parseSheetOrJsDate_(slotDateStr);
            if (!slotDate) return null;
            return monthsWithinTolerance_(expDateParsed, slotDate, expMonthsTol);
          };

          for (const job of candidateJobs) {
            const jobWords = normExpWords(job.parentJob);
            const clientWords = normExpWords(job.parentClient);
            const jobOverlap = expDescWords.some(w => jobWords.includes(w));
            // Client match: bracketed text overlaps with the job's client name
            const clientOverlap = expBracketWords.length > 0 &&
              (expBracketWords.some(w => clientWords.includes(w)) || clientWords.some(w => expBracketWords.includes(w)));
            if (!jobOverlap && !clientOverlap) continue;
            // Find only the FIRST available slot for this job (in slot-number order)
            const availSlot = job.slots.find(s => s.empty) || job.slots.find(s => !s.isAllocated);
            if (!availSlot) continue;
            const cols = slotColMapExp[availSlot.slotNum];
            const row  = availSlot.sheetRow;
            // Total allocated (real only) + this expense
            const realAllocated = job.slots.filter(s => !s.empty && s.isAllocated).reduce((sum, s) => sum + s.amtNum, 0);
            const newTotal = realAllocated + expenseAmount;
            const budgetNum = parseFloat(String(job.totalBudget||"0").replace(/[£$€,]/g,"")) || 0;
            const budgetFit = budgetNum > 0 ? (newTotal <= budgetNum ? "YES" : `OVER by £${(newTotal-budgetNum).toFixed(2)}`) : "UNKNOWN";
            const budgetFits = budgetNum === 0 || newTotal <= budgetNum; // no known budget = don't penalise
            // Exact client match: bracketed text exactly equals the job's client name
            const bracketText = expBracketMatch ? expBracketMatch[1].trim().toLowerCase() : "";
            const isExactClient = !!bracketText && bracketText === String(job.parentClient||"").trim().toLowerCase();
            const dateMatch = dateWithinToleranceExp(availSlot.date);
            jobDescMatches.push({ job, availSlot, cols, row, realAllocated, newTotal, budgetFit, budgetFits, isExactClient, clientOverlap, dateMatch });
          }
          console.log(`  Confirmed job description matches: ${jobDescMatches.length}`);

          // Rank: budget fit → exact client match → partial client overlap → most recent job first
          const parseRankDateExp = (d) => {
            if (!d) return null;
            const MONTHS_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
            const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
            if (!m) return null;
            const mIdx = MONTHS_MAP[m[2].toLowerCase()];
            if (mIdx === undefined) return null;
            const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
            return new Date(yr, mIdx, parseInt(m[1])).getTime();
          };
          jobDescMatches.sort((a, b) => {
            if (a.budgetFits !== b.budgetFits) return a.budgetFits ? -1 : 1;
            if (a.isExactClient !== b.isExactClient) return a.isExactClient ? -1 : 1;
            // clientOverlap (bracketed end-client text overlapping the job's
            // client name) was already computed per candidate above but
            // never actually used here — added 20 Aug 2026, prompted by
            // Paul asking whether partial client matches are considered on
            // the invoice side. This was sitting right there, unused.
            if (a.clientOverlap !== b.clientOverlap) return a.clientOverlap ? -1 : 1;
            // Expense date within tolerance of the slot's expected date —
            // added 20 Aug 2026, mirroring the same fix and priority
            // position on the invoice side (a direct match signal, ranked
            // above the much weaker/indirect job-recency tie-breaker below).
            const aDateMatch = a.dateMatch === true;
            const bDateMatch = b.dateMatch === true;
            if (aDateMatch !== bDateMatch) return aDateMatch ? -1 : 1;
            const da = parseRankDateExp(a.job.startDate);
            const db = parseRankDateExp(b.job.startDate);
            if (da === null && db === null) return 0;
            if (da === null) return 1;
            if (db === null) return -1;
            return db - da;
          });

          for (const jm of jobDescMatches.slice(0, 3)) {
            const { job, availSlot, cols, row, realAllocated, newTotal, budgetFit, dateMatch } = jm;
            const jobClientLabel = job.parentClient ? `${job.parentClient} — ${job.parentJob}` : job.parentJob;
            jobSysOptions.push({
              optionId: jobSysOptions.length + 1,
              title: `Allocate to ${jobClientLabel} slot ${availSlot.slotNum} (Row ${row}) — job name match`,
              matchType: "job",
              jobRow: row,
              jobName: job.parentJob,
              targetRowNum: row,
              targetSlotType: "expense",
              targetSlotNum: availSlot.slotNum,
              matchingDetails: {
                // Same bug as the invoice side (fixed 20 Aug 2026, confirmed
                // during Paul's review of expense-matching for parity) —
                // unmatchedJobSummary must hold the JOB's own true
                // revenue/start date for row-verification to work (it
                // compares this against what's actually in the sheet
                // before writing), not the expense's own amount/date. This
                // previously used expenseAmount/expenseDate here, which
                // structurally can never match the job row's actual
                // revenue/start date, silently blocking every write through
                // this path. job.revenue/job.startDate are the job's real
                // values (already correctly used below in matchedJobDetails,
                // which row-verification never reads).
                unmatchedJobSummary: {
                  clientName: job.parentClient,
                  jobName: job.parentJob,
                  revenue: String(job.revenue || ""),
                  startDate: job.startDate || "",
                },
                matchedJobDetails: {
                  clientName: job.parentClient,
                  jobName: job.parentJob,
                  projectCode: job.projectCode,
                  revenue: String(job.revenue || ""),
                  startDate: job.startDate,
                  endDate: job.endDate,
                },
              },
              matchAnalysis: {
                // Upgraded to High when the expense date falls within
                // tolerance of the slot's expected date — added 20 Aug
                // 2026, mirroring the invoice side's confidence logic
                // exactly (previously hardcoded "Medium" regardless of date
                // proximity, since no date comparison existed at all).
                matchConfidence: dateMatch ? "High" : "Medium",
                placeholderMatch: availSlot.empty ? `YES — Row ${row} ExpSlot${availSlot.slotNum} is empty` : `PARTIAL — unallocated slot available`,
                budgetFit,
                dateRangeMatch: dateMatch === null ? "UNKNOWN" : (dateMatch ? "YES" : "PARTIAL — outside date tolerance"),
                reasonForChoice: `Job name "${job.parentJob}" matches expense description word(s). Currently allocated: £${realAllocated.toFixed(2)}, this expense adds £${expenseAmount.toFixed(2)} → new total £${newTotal.toFixed(2)} vs budget £${job.totalBudget}.`,
                discrepancies: budgetFit.startsWith("OVER") ? `Budget would be exceeded by £${(newTotal-(parseFloat(String(job.totalBudget||"0").replace(/[£$€,]/g,""))||0)).toFixed(2)}` : "None",
              },
              recommendedActions: [
                `Allocate expense to "${job.parentJob}" (Row ${row}), ExpSlot${availSlot.slotNum}`,
                `write ${expenseDescription || expenseRef} to ${cols.d}${row}, write ${expenseAmount} to ${cols.a}${row}, write ${vatYesNo} to ${cols.v}${row}, write ${expenseDate} to ${cols.dt}${row}, write 30 to ${cols.dp}${row}, write ${alert.summary?.status || ""} to ${cols.st}${row}`,
              ],
            });
          }

          // ── Option type C: Create new Outgoings vendor ───────────────────────
          const guessedVendorName = (expenseAccountName || expenseDescription || expenseRef || "Unknown vendor").trim();
          if (nextBlankOGRow2) {
            vendorSysOptions.push({
              optionId: vendorSysOptions.length + 1,
              title: `CREATE NEW Outgoings vendor "${guessedVendorName}" at row ${nextBlankOGRow2}`,
              matchType: "category",
              jobRow: nextBlankOGRow2,
              jobName: guessedVendorName,
              matchingDetails: {
                unmatchedJobSummary: {
                  clientName: alert.clientName,
                  jobName: expenseDescription || expenseRef,
                  revenue: String(expenseAmount),
                  startDate: expenseDate,
                },
              },
              matchAnalysis: {
                matchConfidence: "Low",
                placeholderMatch: "N/A — new vendor row",
                budgetFit: "YES",
                reasonForChoice: `No existing Outgoings vendor matched this expense. A new vendor row will be created at row ${nextBlankOGRow2} using the expense account name/description as the vendor name. Review the vendor name before accepting.`,
                discrepancies: "New vendor — confirm name and VAT setting are correct",
              },
              outgoingsData: {
                categoryName: guessedVendorName,
                expenseMonth: expenseDate ? expenseDate.slice(3) : "",
                transactionId: alert.summary?.transactionId || "",
                amount: expenseAmount,
                description: expenseDescription || expenseRef,
                status: alert.summary?.status || "",
                recDate: expenseDate,
                payDate: "",
                vatCharged: vatYesNo,
              },
              recommendedActions: [
                `Create new Outgoings vendor "${guessedVendorName}" at row ${nextBlankOGRow2} (cols A:D)`,
                `Assign this expense to the new vendor row`,
              ],
              isNewVendor: true,
              newVendorRow: nextBlankOGRow2,
              newVendorName: guessedVendorName,
            });
          }

          // ── Option type D: Manual investigation fallback ─────────────────────
          vendorSysOptions.push({
            optionId: vendorSysOptions.length + 1,
            title: "MANUAL INVESTIGATION REQUIRED — no confident automatic match found",
            matchType: "info",
            matchAnalysis: {
              matchConfidence: "N/A",
              placeholderMatch: "N/A",
              budgetFit: "N/A",
              reasonForChoice: "The system could not identify a high-confidence match for this expense. Review manually.",
              discrepancies: `Expense: £${expenseAmount}, date: ${expenseDate}, description: ${expenseDescription || expenseRef}`,
            },
            recommendedActions: [
              `Review expense manually: £${expenseAmount} | ${expenseDate} | ${expenseDescription || expenseRef}`,
              "Assign to an appropriate Outgoings vendor or Confirmed job slot",
            ],
          });

          // Assemble: job matches first (prioritised), then outgoings vendor matches, then new vendor, then fallback
          const sysOptions = [...jobSysOptions, ...vendorSysOptions];
          // Renumber optionIds
          const options = sysOptions.map((o, i) => ({ ...o, optionId: i + 1 }));
          console.log(`  ✅ System-generated ${options.length} expense options`);

          // Attach jobRowsData for spreadsheet-style display — only for job matches
          // (Outgoings vendor/category matches don't have a Confirmed job row to show)
          const expJobRowCache = new Map();
          for (const opt of options) {
            if (opt.matchType !== "job" || !opt.jobRow) continue;
            if (!expJobRowCache.has(opt.jobRow)) {
              const highlightSlot = (opt.targetSlotType && opt.targetSlotNum)
                ? { type: opt.targetSlotType, rowNum: opt.targetRowNum || opt.jobRow, slotNum: opt.targetSlotNum }
                : null;
              expJobRowCache.set(opt.jobRow, await fetchJobRowsForDisplay(sheets, alert.clientId, "Confirmed", opt.jobRow, highlightSlot, sharedData));
            }
            opt.jobRowsData = expJobRowCache.get(opt.jobRow);
          }

          // Cache in AlertMemory
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
            previousIgnoreReason
          });
        }
        
        // Handle CRM alerts        // Handle CRM alerts
        if (alert.type === "crm" || alert.sheetName === "CRMComp") {
          console.log(`  📊 Analyzing CRM alert...`);

          const alertType = alert.alertType || alert.flagType || "";

          // App discrepancy: job exists in sheet (Confirmed/Pipeline) but not in CRM.
          // The only valid actions are: ignore the discrepancy, or delete the job from the sheet.
          // We never suggest creating a job — Claude is not needed here.
          if (alertType === "crmConfAppDiscr" || alertType === "crmPipeAppDiscr") {
            const tabName = alertType === "crmPipeAppDiscr" ? "Pipeline" : "Confirmed";
            const src = alert.data?.sheetData || [];
            // sheetData: EF=client[0], EG=job[1], EH=code[2], EI=revenue[3], EJ=dirCosts[4], EK=start[5], EL=end[6], EM=likelihood[7]
            const client      = src[0] || alert.clientName || "";
            const jobName     = src[1] || "";
            const projectCode = src[2] || "";
            const revenue     = src[3] || "";
            const dirCosts    = src[4] || "";
            const startDate   = src[5] || "";
            const endDate     = src[6] || "";
            const likelihood  = src[7] || "";
            const jobDesc = [client, jobName, projectCode].filter(Boolean).join(" — ");

            let options = [];
            let jobRow = null;      // declared here so both branches can set it and the DD read below can use it
            let copiedToConf = "";

            if (alert.subType === "field_mismatch") {
              // Job exists in both sheet and CRM but fields differ
              // crmData: EU=code[0], EV=client[1], EW=job[2], EX=revenue[3], EY=dirCosts[4], EZ=start[5], FA=end[6], FB=likelihood[7]
              const crmSrc = alert.data?.crmData || [];
              const crmCode      = crmSrc[0] || "";
              const crmClient    = crmSrc[1] || "";
              const crmJob       = crmSrc[2] || "";
              const crmRevenue   = crmSrc[3] || "";
              const crmDirCosts  = crmSrc[4] || "";
              const crmStart     = crmSrc[5] || "";
              const crmEnd       = crmSrc[6] || "";
              const crmLikely    = crmSrc[7] || "";

              // Look up job row in tab for precise cell writes
              const tabStartRow = tabName === "Pipeline" ? 6 : 1;
              let tabRows = [];
              if (sharedData && tabName === "Confirmed" && sharedData.confirmedDataWide) {
                tabRows = sharedData.confirmedDataWide;
              } else if (sharedData && tabName === "Pipeline" && sharedData.pipelineData) {
                tabRows = sharedData.pipelineData;
              } else {
                const tabResp = await sheets.spreadsheets.values.get({
                  spreadsheetId: alert.clientId,
                  range: `${tabName}!A1:AM5000`,
                });
                tabRows = tabResp.data.values || [];
              }
              const codeToFind   = (projectCode || crmCode).toLowerCase();
              const clientToFind = (client || crmClient).toLowerCase();
              const jobToFind    = (jobName || crmJob).toLowerCase();
              for (let tr = tabName === "Pipeline" ? 5 : 0; tr < tabRows.length; tr++) {
                const r = tabRows[tr] || [];
                const rCode = String(r[2] || "").trim().toLowerCase();
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob = String(r[1] || "").trim().toLowerCase();
                if (codeToFind && rCode === codeToFind) { jobRow = tr + 1; break; }
                if (!codeToFind && rClient === clientToFind && rJob === jobToFind) { jobRow = tr + 1; break; }
              }

              const mismatchFields = alert.mismatchFields || [];
              const APP_FIELD_CONFIG = [
                { name: "Client name",  sheet: client,    crm: crmClient,   col: "A",  writable: false },
                { name: "Job name",     sheet: jobName,   crm: crmJob,      col: "B",  writable: false },
                { name: "Revenue",      sheet: revenue,   crm: crmRevenue,  col: "AG", writable: true  },
                { name: "Direct costs", sheet: dirCosts,  crm: crmDirCosts, col: "AH", writable: true  },
                { name: "Start date",   sheet: startDate, crm: crmStart,    col: "AL", writable: true  },
                { name: "End date",     sheet: endDate,   crm: crmEnd,      col: "AM", writable: true  },
                { name: "% Likelihood", sheet: likelihood,crm: crmLikely,   col: "AN", writable: tabName === "Pipeline" },
              ];

              for (const fc of APP_FIELD_CONFIG) {
                if (!mismatchFields.includes(fc.name)) continue;
                if (fc.writable && jobRow) {
                  options.push({
                    optionId: options.length + 1,
                    title: `UPDATE ${client} — ${jobName} — ${fc.name} to match CRM: "${fc.crm}"`,
                    matchType: "existing_job", jobRow, jobName,
                    matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode, revenue, startDate, endDate, likelihood } },
                    matchAnalysis: {
                      matchConfidence: "High",
                      reasonForChoice: `${fc.name} mismatch. ${tabName}: "${fc.sheet}" vs CRM: "${fc.crm}"`,
                      discrepancies: `${fc.name}: ${tabName}="${fc.sheet}" vs CRM="${fc.crm}"`,
                    },
                    recommendedActions: [
                      `Update ${fc.name} in ${tabName} tab (row ${jobRow}) to match CRM value "${fc.crm}"`,
                      `Write "${fc.crm}" to ${fc.col}${jobRow}`,
                    ],
                  });
                } else {
                  options.push({
                    optionId: options.length + 1,
                    title: `REVIEW ${client} — ${jobName} — ${fc.name} mismatch — manual update required`,
                    matchType: "info", jobName,
                    matchAnalysis: {
                      matchConfidence: "N/A",
                      reasonForChoice: `${fc.name} differs: ${tabName}="${fc.sheet}" vs CRM="${fc.crm}". Cannot update automatically.`,
                    },
                    recommendedActions: [ `Review and correct ${fc.name} manually — ${tabName}: "${fc.sheet}", CRM: "${fc.crm}"` ],
                  });
                }
              }
              options.push({
                optionId: options.length + 1,
                title: `IGNORE — ${client} — ${jobName} — CRM data is wrong or discrepancy can be disregarded`,
                matchType: "ignore", jobRow: jobRow || alert.rowNumber, jobName,
                matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode, revenue, startDate, endDate, likelihood } },
                recommendedActions: [ `Mark this field mismatch as ignored — no changes will be made` ],
              });

            } else {
              // not_found: job in sheet but not in CRM
              // Search the tab to find the actual Pipeline/Confirmed row number
              if (client || jobName || projectCode) {
                try {
                  let tabSearchRows = [];
                  if (sharedData && tabName === "Confirmed" && sharedData.confirmedDataWide) {
                    tabSearchRows = sharedData.confirmedDataWide;
                  } else if (sharedData && tabName === "Pipeline" && sharedData.pipelineData) {
                    tabSearchRows = sharedData.pipelineData;
                  } else {
                    const tabSearchResp = await sheets.spreadsheets.values.get({
                      spreadsheetId: alert.clientId,
                      range: `${tabName}!A1:C5000`,
                    });
                    tabSearchRows = tabSearchResp.data.values || [];
                  }
                  const codeToFind2   = (projectCode || "").toLowerCase();
                  const clientToFind2 = (client || "").toLowerCase();
                  const jobToFind2    = (jobName || "").toLowerCase();
                  for (let tr2 = tabName === "Pipeline" ? 5 : 0; tr2 < tabSearchRows.length; tr2++) {
                    const r2 = tabSearchRows[tr2] || [];
                    const rCode2   = String(r2[2] || "").trim().toLowerCase();
                    const rClient2 = String(r2[0] || "").trim().toLowerCase();
                    const rJob2    = String(r2[1] || "").trim().toLowerCase();
                    if (codeToFind2 && rCode2 === codeToFind2) { jobRow = tr2 + 1; break; }
                    if (!codeToFind2 && rClient2 === clientToFind2 && rJob2 === jobToFind2) { jobRow = tr2 + 1; break; }
                  }
                } catch(e) { console.log("  not_found tab search failed:", e.message); }
              }

              options = [
                {
                  optionId: 1,
                  title: `IGNORE — "${jobDesc}" is legitimate and CRM discrepancy can be disregarded`,
                  matchType: "ignore",
                  jobRow: jobRow || alert.rowNumber, jobName,
                  matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode, revenue, startDate, endDate, likelihood } },
                  recommendedActions: [
                    `Verify that "${jobDesc}" is intentionally absent from the CRM`,
                    `If confirmed, mark this alert as ignored to prevent it recurring`,
                  ],
                },
                {
                  optionId: 2,
                  title: `DELETE — Remove "${jobDesc}" from ${tabName} tab as it should not exist`,
                  matchType: "delete",
                  jobRow: jobRow || alert.rowNumber, jobName,
                  matchingDetails: { unmatchedJobSummary: { clientName: client, jobName, projectCode, revenue, startDate, endDate, likelihood } },
                  recommendedActions: [
                    `Blank all cells for "${jobDesc}" and its child rows in the ${tabName} tab`,
                    `All columns A:G, AG:AM, AN, AP:BH, BX:CR, DD will be cleared across the parent row and all child rows`,
                    `Verify no invoices or expenses are linked to this job before accepting`,
                  ],
                },
              ];
            }

            // For Pipeline tab: fetch Copied to Confirmed? (col DD, index 107) for matched row
            if (tabName === "Pipeline" && jobRow) {
              try {
                const ddResp = await sheets.spreadsheets.values.get({
                  spreadsheetId: alert.clientId,
                  range: `Pipeline!DD${jobRow}`,
                });
                copiedToConf = String(ddResp.data.values?.[0]?.[0] || "").trim();
              } catch(e) { console.log("  copiedToConf read failed:", e.message); }
            }

            console.log(`  ✅ App discr (${alert.subType || "not_found"}) — ${options.length} options for ${jobDesc}`);

            // Inject Pipeline-specific fields onto options
            if (tabName === "Pipeline" && copiedToConf !== undefined) {
              options = options.map(o => ({ ...o, copiedToConf }));
            }

            // Attach jobRowsData for spreadsheet-style display
            if (jobRow) {
              const notFoundJobRows = await fetchJobRowsForDisplay(sheets, alert.clientId, tabName, jobRow, null, sharedData);
              options = options.map(o => ({ ...o, jobRowsData: notFoundJobRows }));
            }

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

          // ── Field mismatch handler (no Claude needed) ──────────────────────
          // subType === "field_mismatch": job exists in both CRM and sheet,
          // but one or more fields differ. Generate hardcoded options per field.
          if (alert.subType === "field_mismatch") {
            const tabName = alert.alertType === "crmPipeDashDiscr" ? "Pipeline" : "Confirmed";
            const crmArr  = alert.data?.crmData  || [];
            const shtArr  = alert.data?.sheetData || [];

            // CRM layout: [0]=client, [1]=job, [2]=code, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
            // Sheet layout: [0]=code, [1]=client, [2]=job, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
            const crmClient    = crmArr[0] || "";
            const crmJob       = crmArr[1] || "";
            const crmCode      = crmArr[2] || "";
            const crmRevenue   = crmArr[3] || "";
            const crmDirCosts  = crmArr[4] || "";
            const crmStart     = crmArr[5] || "";
            const crmEnd       = crmArr[6] || "";
            const crmLikely    = crmArr[7] || "";

            const shtCode      = shtArr[0] || "";
            const shtClient    = shtArr[1] || "";
            const shtJob       = shtArr[2] || "";
            const shtRevenue   = shtArr[3] || "";
            const shtDirCosts  = shtArr[4] || "";
            const shtStart     = shtArr[5] || "";
            const shtEnd       = shtArr[6] || "";
            const shtLikely    = shtArr[7] || "";

            // Find the job row in Pipeline/Confirmed by project code (or client+job fallback)
            const tabStartRow = tabName === "Pipeline" ? 6 : 1;
            let tabRows = [];
            if (sharedData && tabName === "Confirmed" && sharedData.confirmedDataWide) {
              tabRows = sharedData.confirmedDataWide;
            } else if (sharedData && tabName === "Pipeline" && sharedData.pipelineData) {
              tabRows = sharedData.pipelineData;
            } else {
              const tabResp = await sheets.spreadsheets.values.get({
                spreadsheetId: alert.clientId,
                range: `${tabName}!A1:AM5000`,
              });
              tabRows = tabResp.data.values || [];
            }
            let jobRow = null;
            let copiedToConf = "";
            const codeToFind = (shtCode || crmCode).toLowerCase();
            const clientToFind = (shtClient || crmClient).toLowerCase();
            const jobToFind    = (shtJob    || crmJob).toLowerCase();

            for (let tr = tabStartRow === 6 ? 5 : 0; tr < tabRows.length; tr++) {
              const r = tabRows[tr] || [];
              const rCode   = String(r[2]  || "").trim().toLowerCase();
              const rClient = String(r[0]  || "").trim().toLowerCase();
              const rJob    = String(r[1]  || "").trim().toLowerCase();
              // Match by project code first, then client+job
              if (codeToFind && rCode === codeToFind) { jobRow = tr + 1; copiedToConf = String(r[107] || "").trim(); break; }
              if (!codeToFind && rClient === clientToFind && rJob === jobToFind) { jobRow = tr + 1; copiedToConf = String(r[107] || "").trim(); break; }
            }

            const rowRef = jobRow ? ` (${tabName} row ${jobRow})` : "";
            const jobLabel = `${shtClient || crmClient} — ${shtJob || crmJob}${crmCode ? ` (${crmCode})` : ""}`;

            // Consolidated mismatch handler
            const mismatchFields = alert.mismatchFields || [];
            let options = [];

            // Field config: [flagName, crmValue, sheetValue, tabCol, isWritable, note]
            const FIELD_CONFIG = [
              { name: "Client name",    crm: crmClient,   sheet: shtClient,   col: "A",  writable: true  },
              { name: "Job name",       crm: crmJob,      sheet: shtJob,      col: "B",  writable: true  },
              { name: "Revenue",        crm: crmRevenue,  sheet: shtRevenue,  col: "AG", writable: true  },
              { name: "Direct costs",   crm: crmDirCosts, sheet: shtDirCosts, col: "AH", writable: true  },
              { name: "Start date",     crm: crmStart,    sheet: shtStart,    col: "AL", writable: true  },
              { name: "End date",       crm: crmEnd,      sheet: shtEnd,      col: "AM", writable: true  },
              { name: "% Likelihood",   crm: crmLikely,   sheet: shtLikely,   col: "AN", writable: tabName === "Pipeline" },
            ];

            if (jobRow) {
              // Collect child rows to safely batch structural updates (Client/Job names)
              const jobRowsToUpdate = [jobRow];
              for (let i = jobRow; i < tabRows.length; i++) { // jobRow is 1-indexed, so tabRows[jobRow] targets the next row down
                const r = tabRows[i] || [];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob    = String(r[1] || "").trim().toLowerCase();
                // If it shares the identity but has no revenue/dates of its own, it's a child row
                if (rClient === clientToFind && rJob === jobToFind && !String(r[32] || "").trim() && !String(r[37] || "").trim()) {
                  jobRowsToUpdate.push(i + 1);
                } else {
                  break;
                }
              }

              const actions = [];
              const explanations = [];
              const unWritable = [];

              for (const fc of FIELD_CONFIG) {
                if (!mismatchFields.includes(fc.name)) continue;
                if (fc.writable) {
                  explanations.push(`${fc.name} (${tabName}: "${fc.sheet}" → CRM: "${fc.crm}")`);
                  // Structural fields map to every row in the block; scalar fields map only to the parent
                  if (fc.name === "Client name" || fc.name === "Job name") {
                    jobRowsToUpdate.forEach(r => actions.push(`Write "${fc.crm}" to ${fc.col}${r}`));
                  } else {
                    actions.push(`Write "${fc.crm}" to ${fc.col}${jobRow}`);
                  }
                } else {
                  unWritable.push(fc.name);
                }
              }

              if (actions.length > 0) {
                const titleStr = unWritable.length > 0 
                  ? `UPDATE all writable fields (${explanations.length}) to match CRM, review others manually`
                  : `UPDATE all ${explanations.length} mismatched fields to match CRM`;
                  
                options.push({
                  optionId: options.length + 1,
                  title: titleStr,
                  matchType: "existing_job",
                  jobRow,
                  jobName: shtJob || crmJob,
                  matchingDetails: {
                    unmatchedJobSummary: { clientName: shtClient || crmClient, jobName: shtJob || crmJob, projectCode: shtCode || crmCode },
                  },
                  matchAnalysis: {
                    matchConfidence: "High",
                    reasonForChoice: `Mismatched fields: ${explanations.join("; ")}. Updating ${tabName} to match CRM data perfectly.`,
                    discrepancies: `Mismatch fields: ${mismatchFields.join(", ")}`,
                  },
                  recommendedActions: [
                    `Update all writable mismatched fields in ${tabName} tab to match CRM values`,
                    ...actions
                  ],
                });
              }

              // Catch un-writable fields (e.g., Likelihood mismatch on the Confirmed tab)
              if (unWritable.length > 0 && actions.length === 0) {
                options.push({
                  optionId: options.length + 1,
                  title: `REVIEW ${shtClient || crmClient} — ${shtJob || crmJob} — manual update required`,
                  matchType: "info",
                  jobName: shtJob || crmJob,
                  matchAnalysis: {
                    matchConfidence: "N/A",
                    reasonForChoice: `Mismatched fields (${unWritable.join(", ")}) cannot be updated automatically. Review both systems manually.`,
                    discrepancies: `Mismatched fields: ${unWritable.join(", ")}`,
                  },
                  recommendedActions: [
                    `Review and correct ${unWritable.join(", ")} manually`,
                  ],
                  explanation: `${unWritable.join(", ")} cannot be updated automatically.`,
                });
              }
            } else {
              // Fallback if the job row cannot be found
              options.push({
                optionId: options.length + 1,
                title: `REVIEW ${shtClient || crmClient} — ${shtJob || crmJob} — job row not found in ${tabName}`,
                matchType: "info",
                jobName: shtJob || crmJob,
                matchAnalysis: {
                  matchConfidence: "Low",
                  reasonForChoice: `Mismatch detected but could not locate the job row in ${tabName} tab by project code or client+job name.`,
                  discrepancies: `Mismatched fields: ${mismatchFields.join(", ")}`,
                },
                recommendedActions: [
                  `Locate job manually in ${tabName} tab and update mismatched fields`,
                ],
                explanation: `Job row could not be located automatically — update manually.`,
              });
            }

            // Always add an ignore option at the end
            options.push({
              optionId: options.length + 1,
              title: `IGNORE — ${shtClient || crmClient} — ${shtJob || crmJob} — CRM data is wrong or discrepancy can be disregarded`,
              matchType: "ignore",
              jobRow: jobRow || alert.rowNumber,
              jobName: shtJob || crmJob,
              matchingDetails: {
                unmatchedJobSummary: { clientName: shtClient || crmClient, jobName: shtJob || crmJob, projectCode: shtCode || crmCode },
              },
              recommendedActions: [
                `Mark this discrepancy as ignored — no changes will be made to either system`,
              ],
            });

            // For Pipeline tab: fetch Copied to Confirmed? (col DD, index 107) for matched row
            if (tabName === "Pipeline" && jobRow) {
              try {
                const ddResp = await sheets.spreadsheets.values.get({
                  spreadsheetId: alert.clientId,
                  range: `Pipeline!DD${jobRow}`,
                });
                copiedToConf = String(ddResp.data.values?.[0]?.[0] || "").trim();
              } catch(e) { console.log("  copiedToConf read failed:", e.message); }
            }

            console.log(`  ✅ Field mismatch — ${mismatchFields.join(", ")} — returning ${options.length} options for ${jobLabel}`);

            // Inject Pipeline-specific fields onto options
            if (tabName === "Pipeline" && copiedToConf !== undefined) {
              options = options.map(o => ({ ...o, copiedToConf }));
            }

            // Attach jobRowsData for spreadsheet-style display
            if (jobRow) {
              const mismatchJobRows = await fetchJobRowsForDisplay(sheets, alert.clientId, tabName, jobRow, null, sharedData);
              options = options.map(o => ({ ...o, jobRowsData: mismatchJobRows }));
            }

            const crmSummaryMismatch = `CRM mismatch ${jobLabel} [${mismatchFields.join(", ")}]`.trim();
            if (memoryRow) {
              await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
                ...memoryRow, cachedOptionsJSON: JSON.stringify(options),
              });
            } else {
              await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
                fingerprintHash, alertType: "crm", clientName: alert.clientName || "",
                alertSummary: crmSummaryMismatch, cachedOptionsJSON: JSON.stringify(options), status: "cached",
              });
            }

            return res.status(200).json({ success: true, options, alertId: alert.rowNumber, previousIgnoreReason });
          }

          // ── System-generated options for CRM dashboard not_found ──────────────
          // If forceAI is set, skip system options — return a simple AI-generated response
          if (req.body.forceAI === true) {
            console.log("  🤖 forceAI=true — using Claude for CRM dashboard options");
            const crmModeAI = await getCRMMatchingMode(sheets, alert.masterSheetId || alert.clientId);
            const crmTabAI  = crmModeAI === "Pipeline" ? "Pipeline" : "Confirmed";
            const crmSrcAI  = alert.data?.crmData || [];
            const aiCrmPrompt = `You are a financial reconciliation assistant. A CRM job is missing from the ${crmTabAI} tab. Generate options: IGNORE or CREATE NEW job. CRM data: Client=${crmSrcAI[0]||""}, Job=${crmSrcAI[1]||""}, Code=${crmSrcAI[2]||""}, Revenue=${crmSrcAI[3]||""}, Start=${crmSrcAI[5]||""}, End=${crmSrcAI[6]||""}. Return JSON array with optionId, title, matchType (ignore|create_new), matchingDetails, newJobData (for create_new), recommendedActions.`;
            const aiCrmMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 2000, messages: [{ role: "user", content: aiCrmPrompt }] });
            await logClaudeUsage_(sheets, automationCommanderSheetId, alert.clientName || "", "crm", aiCrmMsg.usage?.input_tokens || 0, aiCrmMsg.usage?.output_tokens || 0).catch(() => {});
            let aiCrmOptions = [];
            try {
              const rawCrm = aiCrmMsg.content[0].type === "text" ? aiCrmMsg.content[0].text : "";
              const cleanCrm = rawCrm.replace(/```json/g,"").replace(/```/g,"").trim();
              const arrCrm = cleanCrm.slice(cleanCrm.indexOf("["), cleanCrm.lastIndexOf("]")+1);
              aiCrmOptions = JSON.parse(arrCrm);
              if (!Array.isArray(aiCrmOptions)) aiCrmOptions = [aiCrmOptions];
            } catch(e) { aiCrmOptions = [{ optionId:1, title:"AI response could not be parsed", matchType:"info", recommendedActions:[] }]; }
            const aiCrmSummary = `CRM ${alert.alertType||""} ${crmSrcAI[0]||""} ${crmSrcAI[1]||""}`.trim();
            if (memoryRow) { await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(aiCrmOptions) }); }
            else { await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: alert.alertType||"crm", clientName: alert.clientName||"", alertSummary: aiCrmSummary, cachedOptionsJSON: JSON.stringify(aiCrmOptions), status:"cached" }); }
            return res.status(200).json({ success: true, options: aiCrmOptions, alertId: alert.rowNumber, previousIgnoreReason });
          }
          // A job exists in CRM but is absent from Pipeline/Confirmed.
          // Options: Ignore, or Create new job in the sheet.
          const crmMode = await getCRMMatchingMode(sheets, alert.masterSheetId || alert.clientId);
          console.log(`  Mode: ${crmMode}`);
          const dashTabName = crmMode === "Pipeline" ? "Pipeline" : "Confirmed";

          // Extract CRM data — layout: [0]=client,[1]=job,[2]=code,[3]=revenue,[4]=dirCosts,[5]=start,[6]=end,[7]=likelihood
          const dashCrmArr = alert.data?.crmData || [];
          const dashShtArr = alert.data?.sheetData || [];
          const dashClient   = dashCrmArr[0] || dashShtArr[1] || "";
          const dashJob      = dashCrmArr[1] || dashShtArr[2] || "";
          const dashCode     = dashCrmArr[2] || dashShtArr[0] || "";
          const dashRevenue  = dashCrmArr[3] || dashShtArr[3] || "";
          const dashDirCosts = dashCrmArr[4] || dashShtArr[4] || "";
          const dashStart    = dashCrmArr[5] || dashShtArr[5] || "";
          const dashEnd      = dashCrmArr[6] || dashShtArr[6] || "";
          const dashLikely   = dashCrmArr[7] || dashShtArr[7] || "";
          const dashJobDesc  = [dashClient, dashJob, dashCode].filter(Boolean).join(" — ");

          const dashOptions = [
            {
              optionId: 1,
              title: `IGNORE — discrepancy for "${dashJobDesc || "unknown"}" can be disregarded`,
              matchType: "ignore",
              jobRow: alert.rowNumber,
              jobName: dashJob,
              matchingDetails: {
                unmatchedJobSummary: {
                  clientName: dashClient,
                  jobName: dashJob,
                  projectCode: dashCode,
                  revenue: dashRevenue,
                  startDate: dashStart,
                  endDate: dashEnd,
                  likelihood: dashLikely,
                },
              },
              matchAnalysis: {
                matchConfidence: "N/A",
                reasonForChoice: `Job "${dashJobDesc}" exists in CRM but not in ${dashTabName}. If this is intentional, mark as ignored.`,
                discrepancies: `Job present in CRM but absent from ${dashTabName}`,
              },
              recommendedActions: [
                `Verify that "${dashJobDesc}" is intentionally absent from ${dashTabName}`,
                `If confirmed, mark this alert as ignored to prevent it recurring`,
              ],
            },
            {
              optionId: 2,
              title: `CREATE NEW job "${dashJobDesc || "unknown"}" in ${dashTabName} tab from CRM data`,
              matchType: "create_new",
              jobRow: null,
              jobName: dashJob,
              matchingDetails: {
                unmatchedJobSummary: {
                  clientName: dashClient,
                  jobName: dashJob,
                  projectCode: dashCode,
                  revenue: dashRevenue,
                  startDate: dashStart,
                  endDate: dashEnd,
                  likelihood: dashLikely,
                },
              },
              matchAnalysis: {
                matchConfidence: "Medium",
                reasonForChoice: `Create a new job row in ${dashTabName} using the CRM data. Review all fields before accepting.`,
                discrepancies: "New job — confirm all fields before accepting",
              },
              newJobData: {
                clientName:      dashClient,
                jobName:         dashJob,
                projectCode:     dashCode,
                revenue:         dashRevenue,
                directCostBudget: dashDirCosts,
                startDate:       dashStart,
                endDate:         dashEnd,
                likelihood:      dashLikely,
                inv1Amount: "", inv1Ref: "", inv1SentDate: "", inv1DaysToPay: "", inv1Status: "",
                inv2Amount: "", inv2Ref: "", inv2SentDate: "", inv2DaysToPay: "", inv2Status: "",
                inv3Amount: "", inv3Ref: "", inv3SentDate: "", inv3DaysToPay: "", inv3Status: "",
              },
              recommendedActions: [
                `Create new job in ${dashTabName} tab: "${dashJobDesc}"`,
                `Write client name "${dashClient}" to col A, job name "${dashJob}" to col B, code "${dashCode}" to col C`,
                `Write revenue "${dashRevenue}" to col AG, direct costs "${dashDirCosts}" to col AH`,
                `Write start date "${dashStart}" to col AL, end date "${dashEnd}" to col AM`,
              ],
            },
          ];

          const dashSummary = `CRM ${alert.alertType || ""} ${dashJobDesc}`.trim();
          if (memoryRow) {
            await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
              ...memoryRow, cachedOptionsJSON: JSON.stringify(dashOptions),
            });
          } else {
            await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
              fingerprintHash, alertType: alert.alertType || "crm",
              clientName: alert.clientName || "", alertSummary: dashSummary,
              cachedOptionsJSON: JSON.stringify(dashOptions), status: "cached",
            });
          }
          console.log(`  💾 Options cached in AlertMemory`);
          
          return res.status(200).json({
                success: true,
                options: dashOptions,
                alertId: alert.rowNumber,
                previousIgnoreReason
              });
        }
        
        // Default: Handle invoice alerts        // Default: Handle invoice alerts with flag-based branching
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
          let invConfirmedRows = [];
          if (sharedData && sharedData.confirmedDataWide) {
            invConfirmedRows = sharedData.confirmedDataWide;
            console.log(`  ✓ Used cached Confirmed data to find invoice #${invoiceNo}`);
          } else {
            console.log(`  Fetching Confirmed tab to find invoice #${invoiceNo}...`);
            const invConfirmedResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: "Confirmed!A1:BH5000",
            });
            invConfirmedRows = invConfirmedResp.data.values || [];
          }

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

            console.log(`  Found invoice in Confirmed at slot ${matchedSlot}: ${jobClient} — ${jobName}, VAT=${jobVAT}, type=${jobType}`);

            // Step 2: VAT scenario detection
            const epsilon = 0.01;

            // Scenario A: Invoice sent WITH VAT, job marked as NO VAT
            // Evidence: VAT > 0 AND total excl VAT ≈ dashboard total
            let vatMismatchOptions = null;
            let vatMismatchNewValue = null;
            if (vatIncluded > 0 && !jobVATYes && Math.abs(totalExclVAT - dashboardTotal) < epsilon) {
              console.log(`  VAT scenario A: invoice sent WITH VAT (£${vatIncluded}) but job marked NO VAT`);
              const vatColA = `AI${matchedRowNum}`;
              const options = [
                {
                  optionId: 1,
                  title: `Update job VAT setting to "Yes" — invoice was sent WITH VAT (£${vatIncluded.toFixed(2)})`,
                  matchType: "existing_job",
                  discrepancyType: "inv_vat_mismatch",
                  jobRow: matchedRowNum,
                  jobName,
                  explanation: `Invoice #${invoiceNo} was sent including VAT (£${vatIncluded.toFixed(2)}), confirming the job should be marked "Yes VAT". The dashboard total (£${dashboardTotal.toFixed(2)}) matches the invoice amount excluding VAT (£${totalExclVAT.toFixed(2)}), confirming the mismatch.`,
                  jobDetails: {
                    clientName: jobClient, jobName, projectCode: jobCode, revenue: jobRevenue,
                    vatSetting: jobVAT, jobType: isRetainer ? "Retainer" : "Project",
                    startDate: jobStart, endDate: jobEnd,
                    slot1: `${slot1.ref||"(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}`.trim(),
                    slot2: `${slot2.ref||"(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}`.trim(),
                    slot3: `${slot3.ref||"(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`.trim(),
                  },
                  vatUpdate: { cell: vatColA, newValue: "Yes", currentValue: jobVAT },
                  recommendedActions: [`write Yes to ${vatColA}`], // will be replaced below with all-rows update
                },
                {
                  optionId: 2,
                  title: `MANUAL INVESTIGATION — invoice was sent incorrectly and needs re-issuing without VAT`,
                  matchType: "info",
                  discrepancyType: "inv_vat_mismatch",
                  explanation: `If the invoice was sent in error with VAT and should have been sent without VAT, the invoice needs to be re-issued excluding VAT and the job VAT setting should remain "No".`,
                  jobDetails: {
                    clientName: jobClient, jobName, projectCode: jobCode, revenue: jobRevenue,
                    vatSetting: jobVAT, startDate: jobStart, endDate: jobEnd,
                    slot1: `${slot1.ref||"(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}`.trim(),
                    slot2: `${slot2.ref||"(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}`.trim(),
                    slot3: `${slot3.ref||"(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`.trim(),
                  },
                  recommendedActions: [`Re-issue invoice #${invoiceNo} excluding VAT, then mark as resolved`],
                },
              ];
              vatMismatchOptions = options; vatMismatchNewValue = "Yes";
            }

            // Scenario B: Invoice sent WITHOUT VAT, job marked to INCLUDE VAT
            // Evidence: VAT = 0 AND gross amount × 1.2 ≈ dashboard total
            // (InvComp calculates dashboard total as slot amount × 1.2 when job VAT = Yes)
            if (vatIncluded === 0 && jobVATYes && Math.abs(grossAmount * 1.2 - dashboardTotal) < epsilon) {
              console.log(`  VAT scenario B: invoice sent WITHOUT VAT (£${grossAmount}) but job marked YES VAT — dashboard shows £${dashboardTotal} (= £${grossAmount} × 1.2)`);
              const vatColB = `AI${matchedRowNum}`;
              const options = [
                {
                  optionId: 1,
                  title: `Update job VAT setting to "No" — invoice was sent WITHOUT VAT (£${grossAmount.toFixed(2)})`,
                  matchType: "existing_job",
                  discrepancyType: "inv_vat_mismatch",
                  jobRow: matchedRowNum,
                  jobName,
                  explanation: `Invoice #${invoiceNo} was sent without VAT (VAT = £0.00), but the job is marked "Yes VAT". The dashboard shows £${dashboardTotal.toFixed(2)} (= £${grossAmount.toFixed(2)} × 1.2), but the invoice was sent for £${grossAmount.toFixed(2)} with no VAT. Updating the job VAT setting to "No" will resolve the discrepancy.`,
                  jobDetails: {
                    clientName: jobClient, jobName, projectCode: jobCode, revenue: jobRevenue,
                    vatSetting: jobVAT, jobType: isRetainer ? "Retainer" : "Project",
                    startDate: jobStart, endDate: jobEnd,
                    slot1: `${slot1.ref||"(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}`.trim(),
                    slot2: `${slot2.ref||"(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}`.trim(),
                    slot3: `${slot3.ref||"(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`.trim(),
                  },
                  vatUpdate: { cell: vatColB, newValue: "No", currentValue: jobVAT },
                  recommendedActions: [`write No to ${vatColB}`], // will be replaced below with all-rows update
                },
                {
                  optionId: 2,
                  title: `MANUAL INVESTIGATION — invoice was sent incorrectly and needs re-issuing with VAT`,
                  matchType: "info",
                  discrepancyType: "inv_vat_mismatch",
                  explanation: `If the invoice was sent in error without VAT and should have been sent with VAT, the invoice needs to be re-issued including VAT (£${(grossAmount * 1.2).toFixed(2)} total) and the job VAT setting should remain "Yes".`,
                  jobDetails: {
                    clientName: jobClient, jobName, projectCode: jobCode, revenue: jobRevenue,
                    vatSetting: jobVAT, startDate: jobStart, endDate: jobEnd,
                    slot1: `${slot1.ref||"(empty)"} £${slot1.amt} ${slot1.sent} ${slot1.status}`.trim(),
                    slot2: `${slot2.ref||"(empty)"} £${slot2.amt} ${slot2.sent} ${slot2.status}`.trim(),
                    slot3: `${slot3.ref||"(empty)"} £${slot3.amt} ${slot3.sent} ${slot3.status}`.trim(),
                  },
                  recommendedActions: [`Re-issue invoice #${invoiceNo} including VAT (total £${(grossAmount * 1.2).toFixed(2)}), then mark as resolved`],
                },
              ];
              vatMismatchOptions = options; vatMismatchNewValue = "No";
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

            // Send to Claude with job details and retainer context
            console.log(`  No VAT scenario, diff £${amtDiff.toFixed(2)} — sending to Claude with job details`);
            const slotAmtCol = matchedSlot === 1 ? "AP" : matchedSlot === 2 ? "AW" : "BD";
            const currentSlotAmt = matchedSlot === 1 ? slot1.amt : matchedSlot === 2 ? slot2.amt : slot3.amt;
            const correctAmount = totalExclVAT > 0 ? totalExclVAT : grossAmount;

            // Detect if this is a multi-row retainer (has child rows = Mode B retainer)
            // Child rows: same client + job name as parent, but no revenue (AG/index 32), no start (AL/index 37)
            const jobClientLower = jobClient.toLowerCase();
            const jobNameLower   = jobName.toLowerCase();
            const isMultiRowRetainer = isRetainer && (() => {
              for (let ri = matchedRowNum; ri < invConfirmedRows.length; ri++) {
                const r = invConfirmedRows[ri] || [];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob    = String(r[1] || "").trim().toLowerCase();
                if (!rClient && !rJob) break;
                if (rClient !== jobClientLower || rJob !== jobNameLower) break;
                if (!String(r[32] || "").trim() && !String(r[37] || "").trim()) return true;
              }
              return false;
            })();

            // Find parent row for this job (the row with revenue in AG)
            // The matched row may be a child row — scan upwards to find the parent
            const isRealSlot = (ref) => {
              const r = String(ref || "").trim();
              return r && !r.toUpperCase().startsWith("MANUAL-INV");
            };
            const parseSlotAmt = (v) => parseFloat(String(v || "0").replace(/[£$€,]/g, "")) || 0;

            let parentRowNum = matchedRowNum; // default: matched row is parent
            let parentRevenue = parseSlotAmt(jobRevenue);
            if (!String(matchedJob[32] || "").trim()) {
              // Matched row has no revenue — scan upwards for parent
              for (let ri = matchedRowNum - 2; ri >= 0; ri--) { // ri is 0-indexed in invConfirmedRows
                const r = invConfirmedRows[ri] || [];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob    = String(r[1] || "").trim().toLowerCase();
                if (rClient !== jobClientLower || rJob !== jobNameLower) break;
                if (String(r[32] || "").trim()) { // has revenue
                  parentRowNum = ri + 1; // 1-indexed
                  parentRevenue = parseSlotAmt(String(r[32] || "").replace(/[£$€,]/g, ""));
                  console.log(`  Found parent row at ${parentRowNum} for matched child row ${matchedRowNum}`);
                  break;
                }
              }
            }

            // Sum ALL real invoice slots across ALL rows of this job (parent + children)
            // replacing the matched slot with the correct amount
            let newTotalInvoiced = 0;
            let realInvoiceCount = 0;
            // Collect all rows belonging to this job
            const allJobRows = [];
            // Find parent row index (0-indexed)
            const parentIdx = parentRowNum - 1;
            // Add parent row
            if (invConfirmedRows[parentIdx]) allJobRows.push({ row: invConfirmedRows[parentIdx], rowNum: parentRowNum });
            // Add child rows (scan downward from parent)
            for (let ri = parentIdx + 1; ri < invConfirmedRows.length; ri++) {
              const r = invConfirmedRows[ri] || [];
              const rClient = String(r[0] || "").trim().toLowerCase();
              const rJob    = String(r[1] || "").trim().toLowerCase();
              if (!rClient && !rJob) break;
              if (rClient !== jobClientLower || rJob !== jobNameLower) break;
              if (String(r[32] || "").trim()) break; // another parent row
              allJobRows.push({ row: r, rowNum: ri + 1 });
            }

            // ── VAT mismatch: update ALL rows and return ──────────────────
            if (vatMismatchOptions && vatMismatchNewValue) {
              const jobType = isRetainer ? "Retainer" : "Project";
              // Build write list: AI column for every row in the job
              const vatWrites = allJobRows.map(({ rowNum }) => `AI${rowNum}`);
              vatMismatchOptions = vatMismatchOptions.map(opt => {
                if (opt.matchType !== "existing_job") return opt;
                return {
                  ...opt,
                  jobDetails: {
                    ...(opt.jobDetails || {}),
                    jobType,
                  },
                  vatUpdate: { cells: vatWrites, newValue: vatMismatchNewValue, currentValue: jobVAT },
                  recommendedActions: [
                    vatWrites.length > 1
                      ? `Update VAT setting to "${vatMismatchNewValue}" on all ${vatWrites.length} rows of this job (${vatWrites.join(", ")})`
                      : `Update VAT setting to "${vatMismatchNewValue}" on row ${allJobRows[0]?.rowNum}`,
                    vatWrites.map(cell => `write ${vatMismatchNewValue} to ${cell}`).join(", "),
                  ],
                };
              });
              return res.status(200).json({ success: true, options: vatMismatchOptions, alertId: alert.rowNumber, previousIgnoreReason });
            }

            // Slot indices: Inv1 ref=42, amt=41; Inv2 ref=49, amt=48; Inv3 ref=56, amt=55
            const INV_SLOTS = [
              { refIdx: 42, amtIdx: 41, slotNum: 1, col: "AP" },
              { refIdx: 49, amtIdx: 48, slotNum: 2, col: "AW" },
              { refIdx: 56, amtIdx: 55, slotNum: 3, col: "BD" },
            ];
            for (const { row, rowNum } of allJobRows) {
              for (const { refIdx, amtIdx, slotNum, col } of INV_SLOTS) {
                const ref = String(row[refIdx] || "").trim();
                if (!isRealSlot(ref)) continue;
                // Use correct amount for the matched slot on the matched row
                const amt = (rowNum === matchedRowNum && slotNum === matchedSlot)
                  ? correctAmount
                  : parseSlotAmt(row[amtIdx]);
                newTotalInvoiced += amt;
                realInvoiceCount++;
              }
            }

            const revenueRatio = parentRevenue > 0 ? (newTotalInvoiced / parentRevenue) * 100 : 0;
            console.log(`  Parent row: ${parentRowNum}, isMultiRowRetainer: ${isMultiRowRetainer}, realInvoices: ${realInvoiceCount}, newTotal: £${newTotalInvoiced.toFixed(2)}, revenue: £${parentRevenue.toFixed(2)}, ratio: ${revenueRatio.toFixed(1)}%`);

            // ── Invoice amount mismatch: fully pre-computed — no Claude needed ──
            // All data required for both options is already calculated above.
            console.log(`  ✅ Generating invAmtMismatch options from pre-computed data (no Claude)`);
            const confidenceFromRatio = (() => {
              if (revenueRatio > 110) return "High"; // over-invoiced
              if (revenueRatio >= 90) return "High";
              if (revenueRatio >= 75) return "Medium";
              return "Low";
            })();
            const revenueImpactStr = `New total invoiced = £${newTotalInvoiced.toFixed(2)}. Job revenue = £${parentRevenue.toFixed(2)}. ${
              revenueRatio > 110 ? "Job is over-invoiced — revenue likely needs updating." :
              revenueRatio >= 90 ? "Total invoiced is close to revenue — revenue adjustment likely correct." :
              revenueRatio >= 75 ? "Total invoiced is below revenue — further invoices may be expected." :
              "Total invoiced is well below revenue — revenue adjustment is uncertain."
            }`;

            let invAmtOptions = [
              {
                optionId: 1,
                title: `Update slot amount only — accounting system reflects actual invoice sent`,
                matchType: "existing_job",
                jobRow: matchedRowNum,
                confidence: "High",
                explanation: `Dashboard incorrectly shows £${currentSlotAmt} for invoice #${invoiceNo}, but accounting system shows the actual sent amount of £${correctAmount.toFixed(2)} (excl VAT). Job revenue may represent the original quote or scope.`,
                revenueImpact: revenueImpactStr,
                recommendedActions: [
                  `Update invoice #${invoiceNo} amount from £${currentSlotAmt} to £${correctAmount.toFixed(2)} in the dashboard`,
                  `write ${correctAmount.toFixed(2)} to ${slotAmtCol}${matchedRowNum} (slot ${matchedSlot} amount)`,
                ],
              },
              isMultiRowRetainer
                ? {
                    optionId: 2,
                    title: `Revenue adjustment not applicable for multi-row retainer`,
                    matchType: "info",
                    jobRow: matchedRowNum,
                    confidence: "N/A",
                    explanation: `For multi-row retainers, the revenue figure represents the monthly amount and should not be adjusted to match total invoiced.`,
                    revenueImpact: revenueImpactStr,
                    recommendedActions: [
                      `Review revenue for this retainer job manually`,
                      ``,
                    ],
                  }
                : {
                    optionId: 2,
                    title: `Update slot amount and adjust revenue to £${newTotalInvoiced.toFixed(2)}`,
                    matchType: "existing_job",
                    jobRow: matchedRowNum,
                    confidence: confidenceFromRatio,
                    explanation: `Update the invoice slot amount to match the accounting system, and update job revenue to reflect the corrected total invoiced (${revenueRatio.toFixed(1)}% of current revenue).`,
                    revenueImpact: revenueImpactStr,
                    recommendedActions: [
                      `Update invoice #${invoiceNo} amount and adjust job revenue to £${newTotalInvoiced.toFixed(2)}`,
                      `write ${correctAmount.toFixed(2)} to ${slotAmtCol}${matchedRowNum} (slot ${matchedSlot} amount), write ${newTotalInvoiced.toFixed(2)} to AG${parentRowNum} (job revenue)`,
                    ],
                  },
            ];

                        // Build slotBreakdown from pre-calculated allJobRows data — injected onto both options
            // so the frontend can display the full invoice context without relying on Claude to enumerate it.
            const slotBreakdownLines = [];
            for (const { row, rowNum } of allJobRows) {
              for (const { refIdx, amtIdx, slotNum, col } of INV_SLOTS) {
                const ref = String(row[refIdx] || "").trim();
                const rawAmt = row[amtIdx];
                if (!ref && (rawAmt === undefined || rawAmt === "")) continue;
                const isManual = ref.toUpperCase().startsWith("MANUAL-INV");
                const isMatched = rowNum === matchedRowNum && slotNum === matchedSlot;
                const amt = isMatched
                  ? `£${correctAmount.toFixed(2)} (corrected from £${currentSlotAmt})`
                  : rawAmt !== undefined && rawAmt !== ""
                    ? `£${parseSlotAmt(rawAmt).toFixed(2)}`
                    : "(no amount)";
                const label = isManual ? `[MANUAL-INV]` : ref || "(blank ref)";
                const tag = isMatched ? " ← this invoice" : "";
                slotBreakdownLines.push(`Row ${rowNum} Inv${slotNum}: ${label} ${amt}${tag}`);
              }
            }
            const slotBreakdown = {
              lines: slotBreakdownLines,
              correctedTotal: `£${newTotalInvoiced.toFixed(2)}`,
              currentRevenue: `£${parentRevenue.toFixed(2)}`,
              revenueRatio: `${revenueRatio.toFixed(1)}%`,
            };

            // Inject jobName and slotBreakdown onto each option so the row re-verifier can find
            // the job if rows shift, and the frontend can display full invoice context.
            invAmtOptions = invAmtOptions.map(opt => ({
              ...opt,
              jobName: opt.jobName || jobName,
              jobRevenue: opt.jobRevenue || jobRevenue,
              slotBreakdown,
              jobDetails: opt.jobDetails || {
                clientName: jobClient,
                jobName,
                projectCode: jobCode,
                revenue: jobRevenue,
                vatSetting: jobVAT,
                jobType: isRetainer ? "Retainer" : "Project",
                startDate: jobStart,
                endDate: jobEnd,
              },
              rowContext: {
                matchedRow: matchedRowNum,
                parentRow: parentRowNum,
                isChildRow: matchedRowNum !== parentRowNum,
                matchedSlot,
              },
            }));
            // Write to AlertMemory cache
            const invAmtSummary = alert.summary?.summary || `Invoice ${invoiceNo} £${grossAmount.toFixed(2)}`;
            if (memoryRow) {
              await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
                ...memoryRow, cachedOptionsJSON: JSON.stringify(invAmtOptions),
              });
            } else {
              await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
                fingerprintHash, alertType: "invoice", clientName: alert.clientName || "",
                alertSummary: invAmtSummary, cachedOptionsJSON: JSON.stringify(invAmtOptions), status: "cached",
              });
            }
            console.log(`  💾 Inv amt mismatch options cached in AlertMemory`);
            return res.status(200).json({ success: true, options: invAmtOptions, alertId: alert.rowNumber, previousIgnoreReason });
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
        
        let confirmedData = [];
        if (sharedData && sharedData.confirmedDataWide) {
          confirmedData = sharedData.confirmedDataWide;
          console.log(`  ✓ Used cached Confirmed data (${confirmedData.length} rows)`);
        } else {
          const confirmedResponse = await withRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: "Confirmed!A1:CR5000",
          }));
          confirmedData = confirmedResponse.data.values || [];
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

        // Fetch tolerances here — needed by both the pre-check and the prompt builder below
        const tolerances = await getToleranceValues(sheets, alert.masterSheetId || alert.clientId);

        // Extract invoice details — declared here so they're available to both the
        // pre-check block and the prompt builder below (avoids temporal dead zone in prod build)
        const invoiceAmount = parseFloat(alert.summary?.amount) || 0;
        const invoiceRef = alert.summary?.invoiceNo || '(unmatched)';
        const invoiceClient = alert.summary?.client || '';
        const invoiceJob = alert.summary?.job || '';
        const sentDate = alert.summary?.sentDate || '';
        const invoiceStatus = alert.summary?.status || '';
        // invoiceAmtForMatch declared here (uses totalExclVAT from Confirmed pre-check
        // if available, else falls back to invoiceAmount) so Tier 1/Tier 2 can access it
        // regardless of whether isMissingInvoice's block executes.
        let invoiceAmtForMatch = invoiceAmount;
        const datePaid = alert.summary?.datePaid || '';

        // Date tolerance: ±invoiceMonthsTolerance months from invoice sent date.
        // Same reasoning as invoiceAmtForMatch above — moved here 20 Aug 2026 from
        // inside the isMissingInvoice block below, which Tier 1/2 (further down,
        // a SIBLING scope, not a child of that block) also needs this for. The
        // original placement meant every accept-option call touching the
        // "name match" Tier 2 path threw a ReferenceError at runtime (confirmed via
        // Babel's own scope resolution during a full-codebase sweep, not just an
        // ESLint guess) — a plain syntax check can't catch an undefined-reference
        // error since it's runtime-only, so this had been silently broken since it
        // was first added.
        const invMonthsTol = Number(tolerances.invoiceMonthsTolerance) || 2;
        const invSentDateParsed = parseSheetOrJsDate_(sentDate);
        const dateWithinTolerance = (slotDateStr) => {
          if (!invSentDateParsed || !slotDateStr) return null; // null = unknown (no date to compare)
          const slotDate = parseSheetOrJsDate_(slotDateStr);
          if (!slotDate) return null;
          return monthsWithinTolerance_(invSentDateParsed, slotDate, invMonthsTol);
        };

        // Days to pay: if Paid, calculate from sentDate → datePaid; otherwise use DataChgAlert!B52
        let daysToPayValue = tolerances.defaultDaysToPay;
        if (invoiceStatus.toLowerCase() === 'paid' && sentDate && datePaid) {
          try {
            const parseDate = (d) => {
              const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
              const parts = d.split(/[-\/]/);
              if (parts.length === 3) {
                const monthNum = months[parts[1]?.toLowerCase()?.substring(0,3)];
                if (monthNum !== undefined) {
                  const year = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
                  return new Date(year, monthNum, parseInt(parts[0]));
                }
                if (parts[0].length === 4) return new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
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

        // ── Pre-check: fuzzy client matching + amount/date slot sweep ─────────
        // Two independent matching signals are computed before sending to Claude:
        //
        // Signal A — Fuzzy client name match: checks whether any Confirmed tab client
        //   name is plausibly the same entity as the invoice client name, using:
        //   - noise-word stripping (ltd, limited, plc, inc, llc, the, and, &, group, co)
        //   - normalisation (punctuation, whitespace, case)
        //   - word-overlap: any single meaningful word shared between names
        //   - abbreviation detection: initials of one name spell the other
        //
        // Signal B — Amount + date sweep of non-real slots (blank ref OR MANUAL-INV):
        //   - Amount tolerance: 5p domestic, 10% foreign (mirrors GAS automation)
        //   - Date tolerance: ±invoiceMonthsTolerance months
        //   - Only considers slots with no real invoice reference (available placeholders)
        //
        // Outcomes:
        //   - Signal A found, Signal B found → Claude receives full table + slot match candidates
        //   - Signal A found only           → Claude receives full table (existing flow)
        //   - Signal A NOT found, Signal B found → Claude receives slot match candidates only
        //   - Neither found                 → hardcoded create_new (no Claude call)

        // slotMatches declared here so Tier 1 and Tier 2 can access it regardless of isMissingInvoice
        let slotMatches = [];
        let clientFound = false;

        if (isMissingInvoice) {

          const alertClientStr = alert.summary?.client || invoiceClient;
          clientFound = alertClientStr && activeData.some(row =>
            fuzzyClientMatch_(alertClientStr, String(row[0] || ""))
          );
          console.log(`  Fuzzy client match for "${alertClientStr}": ${clientFound}`);

          // ── Amount + date sweep of non-real slots ─────────────────────────
          // Fetch primary currency from client KeyInfo!B17 to determine tolerance type
          let primaryCurrency = "GBP";
          try {
            const keyInfoResp = await sheets.spreadsheets.values.get({
              spreadsheetId: alert.clientId,
              range: "KeyInfo!B17",
            });
            primaryCurrency = String(keyInfoResp.data.values?.[0]?.[0] || "GBP").trim().toUpperCase();
          } catch (e) {
            console.log(`  ⚠️ Could not read KeyInfo!B17 — defaulting to GBP`);
          }

          const invoiceCurrency = String(alert.summary?.currency || "GBP").trim().toUpperCase();
          const isForeignCurrency = invoiceCurrency && invoiceCurrency !== primaryCurrency;
          console.log(`  Currency: invoice=${invoiceCurrency}, primary=${primaryCurrency}, foreign=${isForeignCurrency}`);

          // Amount tolerance: 5p domestic, 10% of invoice amount for foreign
          invoiceAmtForMatch = totalExclVAT > 0 ? totalExclVAT : invoiceAmount;
          const amtToleranceFn = (slotAmt) => {
            if (isForeignCurrency) {
              return Math.abs(slotAmt - invoiceAmtForMatch) <= invoiceAmtForMatch * 0.10;
            }
            // Domestic: 5p tolerance (compare in pennies to avoid float errors)
            return Math.abs(Math.round(slotAmt * 100) - Math.round(invoiceAmtForMatch * 100)) <= 5;
          };

          // Sweep all non-real slots across all active Confirmed rows
          // Non-real = no ref, OR ref starts with MANUAL-INV
          const INV_SLOT_DEFS = [
            { amtIdx: 41, refIdx: 42, sentIdx: 43, slotNum: 1, amtCol: "AP", refCol: "AQ", sentCol: "AR", daysCol: "AS", statusCol: "AT" },
            { amtIdx: 48, refIdx: 49, sentIdx: 50, slotNum: 2, amtCol: "AW", refCol: "AX", sentCol: "AY", daysCol: "AZ", statusCol: "BA" },
            { amtIdx: 55, refIdx: 56, sentIdx: 57, slotNum: 3, amtCol: "BD", refCol: "BE", sentCol: "BF", daysCol: "BG", statusCol: "BH" },
          ];

          // slotMatches declared outside this block so Tier 1/Tier 2 can access it
          for (let ri = 1; ri < activeData.length; ri++) {
            const row = activeData[ri] || [];
            const rowClient  = String(row[0] || "").trim();
            const rowJob     = String(row[1] || "").trim();
            const rowCode    = String(row[2] || "").trim();
            const rowRevenue = String(row[32] || "").trim();
            if (!rowClient && !rowJob) continue;

            for (const sd of INV_SLOT_DEFS) {
              const ref    = String(row[sd.refIdx] || "").trim();
              const rawAmt = row[sd.amtIdx];
              const slotDate = String(row[sd.sentIdx] || "").trim();

              // Non-real: blank ref OR MANUAL-INV prefix
              const isManual = ref.toUpperCase().startsWith("MANUAL-INV");
              const isNonReal = !ref || isManual;
              if (!isNonReal) continue;

              // Must have an amount to match against
              const slotAmt = parseFloat(String(rawAmt || "").replace(/[£$€,]/g, "")) || 0;
              if (slotAmt === 0) continue;

              const amtMatch  = amtToleranceFn(slotAmt);
              if (!amtMatch) continue; // amount must match — date is supporting evidence only

              const dateOk = dateWithinTolerance(slotDate); // true / false / null
              slotMatches.push({
                rowNum: ri + 1, // 1-indexed sheet row (activeData[0] = header, ri=1 → sheet row 2)
                client: rowClient, jobName: rowJob, projectCode: rowCode, revenue: rowRevenue,
                startDate: String(row[37] || "").trim(), // AL — for recency ranking
                slotNum: sd.slotNum, slotAmt, slotDate, amtMatch, dateMatch: dateOk,
                amtCol: sd.amtCol, refCol: sd.refCol, sentCol: sd.sentCol,
                daysCol: sd.daysCol, statusCol: sd.statusCol, isManual,
              });
            }
          }
          console.log(`  Amount/date slot sweep: ${slotMatches.length} non-real slot(s) with matching amount`);

          // ── Secondary sweep: job-level MANUAL-INV total match ──────────────
          // If no individual slot matched, check whether the invoice amount equals the
          // TOTAL of all MANUAL-INV slots across a job. This handles the common case
          // where automation splits a job's revenue across multiple MANUAL-INV placeholders
          // (e.g. £435 + £435 = £870) but the real invoice covers the full amount.
          if (!slotMatches.some(m => !m.isManual || true)) { // always run this check
            // Group MANUAL-INV slots by job (client+jobName)
            const jobManualSlots = new Map(); // key → { slots: [], client, jobName, projectCode, revenue, startDate }
            for (let ri = 1; ri < activeData.length; ri++) {
              const row = activeData[ri] || [];
              const rowClient  = String(row[0] || "").trim();
              const rowJob     = String(row[1] || "").trim();
              const rowCode    = String(row[2] || "").trim();
              const rowRevenue = String(row[32] || "").trim();
              const rowStart   = String(row[37] || "").trim();
              if (!rowClient && !rowJob) continue;
              const key = `${rowClient}||${rowJob}`;
              for (const sd of INV_SLOT_DEFS) {
                const ref = String(row[sd.refIdx] || "").trim();
                if (!ref.toUpperCase().startsWith("MANUAL-INV")) continue;
                const rawAmt = row[sd.amtIdx];
                const slotAmt = parseFloat(String(rawAmt || "").replace(/[£$€,]/g, "")) || 0;
                if (slotAmt === 0) continue;
                const slotDate = String(row[sd.sentIdx] || "").trim();
                if (!jobManualSlots.has(key)) {
                  jobManualSlots.set(key, { slots: [], client: rowClient, jobName: rowJob, projectCode: rowCode, revenue: rowRevenue, startDate: rowStart });
                }
                jobManualSlots.get(key).slots.push({ rowNum: ri + 1, slotNum: sd.slotNum, slotAmt, slotDate, ref, ...sd });
              }
            }
            // Check each job's total MANUAL-INV amount against invoice
            for (const [, job] of jobManualSlots) {
              const totalManual = job.slots.reduce((s, sl) => s + sl.slotAmt, 0);
              if (amtToleranceFn(totalManual)) {
                // Total matches — flag slot 1 (first slot) as the target
                const firstSlot = job.slots.sort((a, b) => a.rowNum - b.rowNum || a.slotNum - b.slotNum)[0];
                // Only add if not already in slotMatches
                const alreadyMatched = slotMatches.some(m => m.rowNum === firstSlot.rowNum && m.slotNum === firstSlot.slotNum);
                if (!alreadyMatched) {
                  const dateOk = dateWithinTolerance(firstSlot.slotDate);
                  slotMatches.push({
                    rowNum: firstSlot.rowNum,
                    client: job.client, jobName: job.jobName, projectCode: job.projectCode, revenue: job.revenue,
                    startDate: job.startDate, // AL — for recency ranking
                    slotNum: firstSlot.slotNum, slotAmt: totalManual, slotDate: firstSlot.slotDate,
                    amtMatch: true, dateMatch: dateOk,
                    amtCol: firstSlot.amtCol, refCol: firstSlot.refCol, sentCol: firstSlot.sentCol,
                    daysCol: firstSlot.daysCol, statusCol: firstSlot.statusCol, isManual: true,
                    isJobTotalMatch: true, // flag so Claude knows this is a total-match scenario
                    manualSlotsToClear: job.slots.length, // how many MANUAL-INV slots exist
                  });
                  console.log(`  Job-level MANUAL-INV total match: ${job.client} | ${job.jobName} — total £${totalManual} matches invoice £${invoiceAmtForMatch}`);
                }
              }
            }
          }

          const hasSlotMatches = slotMatches.length > 0;

          // ── Neither signal found → still send to Claude — it may find non-obvious matches
          // (e.g. different client name spelling, amount = fraction of job revenue, etc.)
          if (!clientFound && !hasSlotMatches) {
            console.log(`  No client match and no slot match — sending to Claude for non-obvious match detection`);
          }

          // ── Build slot match context block for Claude (if Signal B found) ──
          // Group matches by job (client + jobName) so Claude sees the COMPLETE picture
          // for each candidate job — all matching slots AND all other slots on the same job.
          // This prevents Claude treating parent and child rows as separate jobs.
          let slotMatchContext = "";
          if (hasSlotMatches) {
            // Group all slot matches by job key
            const jobGroups = new Map(); // key = "client||jobName"
            for (const m of slotMatches) {
              const key = `${m.client}||${m.jobName}`;
              if (!jobGroups.has(key)) {
                jobGroups.set(key, {
                  client: m.client, jobName: m.jobName,
                  projectCode: m.projectCode, revenue: m.revenue,
                  matchingSlots: [], parentRow: null,
                });
              }
              jobGroups.get(key).matchingSlots.push(m);
            }

            // For each matched job, also collect ALL slots across ALL rows of that job
            // (parent + children) from activeData so Claude sees the full invoice picture
            const jobContextLines = [];
            for (const [key, group] of jobGroups) {
              const clientNorm = group.client.toLowerCase();
              const jobNorm    = group.jobName.toLowerCase();

              // Find parent row (has revenue) and all child rows for this job
              const allJobRows = [];
              let parentRevenue = group.revenue;
              let parentStart = '', parentEnd = '', parentVAT = '', parentType = '';
              let parentRowNum = null;
              let lastCollectedRi = -1; // track last collected row index for contiguity check
              for (let ri = 1; ri < activeData.length; ri++) {
                const r = activeData[ri] || [];
                const rc = String(r[0] || "").trim().toLowerCase();
                const rj = String(r[1] || "").trim().toLowerCase();
                const directMatch = rc === clientNorm && rj === jobNorm;
                const hasAnyContent = r.some(cell => String(cell || "").trim() !== "");
                // Child row: blank client/job, has content, AND is contiguous with last collected row
                const childInherited = allJobRows.length > 0
                  && !r[0] && !r[1]
                  && hasAnyContent
                  && ri === lastCollectedRi + 1; // must be immediately after last collected row
                if (!directMatch && !childInherited) {
                  // If we've already found the parent and hit a non-matching, non-child row, stop
                  if (parentRowNum !== null && !directMatch) break;
                  continue;
                }
                const sheetRow = ri + 1; // activeData[0]=header=row1, ri=1→row2
                const hasRevenue = !!(String(r[32] || "").trim());
                if (directMatch && hasRevenue && parentRowNum === null) {
                  parentRowNum = sheetRow;
                  parentRevenue = String(r[32] || "").trim();
                  parentStart   = String(r[37] || "").trim();
                  parentEnd     = String(r[38] || "").trim();
                  parentVAT     = String(r[34] || "").trim();
                  parentType    = String(r[35] || "").trim();
                }
                allJobRows.push({ row: r, sheetRow, isParent: directMatch && hasRevenue });
                lastCollectedRi = ri;
              }

              // Build complete slot picture across all job rows
              const allSlotLines = [];
              for (const { row: r, sheetRow, isParent } of allJobRows) {
                const rowLabel = isParent ? "parent" : "child";
                const slotDefs = [
                  { amtIdx:41, refIdx:42, sentIdx:43, slotNum:1 },
                  { amtIdx:48, refIdx:49, sentIdx:50, slotNum:2 },
                  { amtIdx:55, refIdx:56, sentIdx:57, slotNum:3 },
                ];
                for (const sd of slotDefs) {
                  const ref    = String(r[sd.refIdx] || "").trim();
                  const rawAmt = r[sd.amtIdx];
                  const slotDate = String(r[sd.sentIdx] || "").trim();
                  const amt    = rawAmt !== undefined && rawAmt !== "" ? parseFloat(String(rawAmt).replace(/[£$€,]/g,"")) || 0 : null;
                  const isManual  = ref.toUpperCase().startsWith("MANUAL-INV");
                  const isReal    = ref && !isManual;
                  const isEmpty   = !ref && (amt === null || amt === 0);

                  // Is this one of the backend-matched slots?
                  const isMatched = group.matchingSlots.some(m => m.rowNum === sheetRow && m.slotNum === sd.slotNum);

                  let slotDesc;
                  if (isEmpty) {
                    slotDesc = "(empty)";
                  } else if (isReal) {
                    slotDesc = `${ref} £${amt?.toFixed(2) || "?"} sent:${slotDate || "?"} [REAL — do not overwrite]`;
                  } else if (isManual) {
                    const manualAmtMatch = amt && Math.abs(amt - invoiceAmount) < 0.01;
                    // Check if this is part of a job-total match (invoice covers full job revenue via multiple MANUAL-INV slots)
                    const isJobTotalMatch = group.matchingSlots.some(m => m.isJobTotalMatch && m.rowNum === sheetRow && m.slotNum === sd.slotNum);
                    const jobTotalNote = isJobTotalMatch ? ` ← INVOICE COVERS FULL JOB REVENUE — PLACE HERE AND CLEAR ALL OTHER MANUAL-INV SLOTS` : (manualAmtMatch ? " ← AMOUNT MATCHES THIS INVOICE" : "");
                    slotDesc = `${ref} £${amt?.toFixed(2) || "?"} sent:${slotDate || "?"} [MANUAL-INV placeholder${jobTotalNote}]`;
                  } else {
                    // Blank-ref placeholder — show explicit date comparison vs invoice sent date
                    const dateResult = dateWithinTolerance(slotDate);
                    let dateTag;
                    if (!slotDate) {
                      dateTag = "no date recorded";
                    } else if (invSentDateParsed && parseSheetOrJsDate_(slotDate)) {
                      const diffMonths = Math.abs((parseSheetOrJsDate_(slotDate) - invSentDateParsed) / (1000*60*60*24*30.4));
                      const direction = parseSheetOrJsDate_(slotDate) > invSentDateParsed ? "after" : "before";
                      if (diffMonths < 0.1) {
                        dateTag = `slot date ${slotDate} vs invoice ${sentDate} = EXACT MATCH`;
                      } else {
                        dateTag = `slot date ${slotDate} vs invoice ${sentDate} = ${diffMonths.toFixed(1)} months ${direction} invoice ${dateResult ? "✓ within tolerance" : "✗ outside tolerance"}`;
                      }
                    } else {
                      dateTag = `slot date ${slotDate} (invoice sent: ${sentDate || "unknown"})`;
                    }
                    slotDesc = `[blank-ref placeholder] £${amt?.toFixed(2) || "?"} | ${dateTag}${isMatched ? " ← AMOUNT MATCHES THIS INVOICE" : ""}`;
                  }
                  allSlotLines.push(`    Row ${sheetRow} (${rowLabel}) Inv${sd.slotNum}: ${slotDesc}`);
                }
              }

              const matchCount = group.matchingSlots.length;
              const bestDateMatch = group.matchingSlots.some(m => m.dateMatch === true);
              const toleranceNote = isForeignCurrency
                ? `10% foreign currency tolerance`
                : `5p domestic tolerance`;

              jobContextLines.push(
                `JOB: ${group.client} | ${group.jobName}${group.projectCode ? ` (${group.projectCode})` : ""} | Revenue: ${parentRevenue}${parentType ? ` | Type: ${parentType}` : ""}${parentStart ? ` | ${parentStart}→${parentEnd}` : ""}
  Dashboard client name: "${group.client}" | Invoice client name: "${alertClientStr}"${group.client.toLowerCase() !== alertClientStr.toLowerCase() ? ` ← NAMES DIFFER — if you recommend this job, also write "${alertClientStr}" to col A of ALL rows for this job (rows: ${allJobRows.map(r => r.sheetRow).join(", ")})` : " ← names match"}
  ${matchCount} slot(s) with amount matching invoice £${invoiceAmtForMatch.toFixed(2)} (${toleranceNote}) — date ${bestDateMatch ? "✓ at least one slot within tolerance" : "✗ no slot within date tolerance"}
  ALL SLOTS FOR THIS JOB (${allJobRows.length} row${allJobRows.length > 1 ? "s" : ""} = ${allJobRows.length * 3} slots total — parent + child rows combined):
${allSlotLines.join("\n")}`
              );
            }

            const toleranceHeader = isForeignCurrency
              ? `(Foreign currency — ${invoiceCurrency} vs primary ${primaryCurrency} — amount tolerance 10%)`
              : `(Domestic currency — amount tolerance 5p, date tolerance ±${invMonthsTol} months)`;

            slotMatchContext = `
PLACEHOLDER SLOT MATCHES — PRE-COMPUTED BY BACKEND ${toleranceHeader}:
The backend found non-real invoice slots whose amounts match this invoice within tolerance.
CRITICAL: Parent and child rows below belong to the SAME JOB — treat them as a single unit with up to ${3 * (slotMatches[0] ? (jobGroups.get(`${slotMatches[0].client}||${slotMatches[0].jobName}`)?.matchingSlots?.length || 1) : 1)} slots total.
Invoice amount to place: £${invoiceAmtForMatch.toFixed(2)}, sent date: ${sentDate || "unknown"}

${jobContextLines.join("\n\n")}

INSTRUCTIONS FOR USING THESE MATCHES:
- Slots marked "← AMOUNT MATCHES THIS INVOICE" are the backend-confirmed candidates
- Slots marked "← INVOICE COVERS FULL JOB REVENUE — PLACE HERE AND CLEAR ALL OTHER MANUAL-INV SLOTS" mean the invoice amount equals the total of all MANUAL-INV placeholders on this job. In this case: place the invoice in that slot (slot 1), write all 5 invoice fields to it, and clear ALL other MANUAL-INV slots on this job (write blank to all 5 fields of each remaining MANUAL-INV slot).
- A slot with both amount match AND date match (✓) is the most likely target
- A slot with amount match but date mismatch (✗) is still a valid option, with lower confidence — state the actual date difference
- NEVER describe a date-tolerance match as "exact" — state the actual difference in months
- The job's total revenue is split across ALL slots (parent + child rows combined)
- When recommending a slot, use the actual sheet row number shown (e.g. Row 263 or Row 264)
- CLIENT NAME MISMATCH: If the dashboard client name and invoice client name differ (marked "← NAMES DIFFER"), you MUST include writes of the invoice client name to column A of ALL rows for that job as part of recommendedActions — the accounting system name is authoritative`;
          }

          // Inject both signals into the prompt via a pre-analysis block that Claude receives
          // alongside (or instead of) the full confirmed tab table.
          // Store on a variable that the prompt builder below will pick up.
          // We set a flag so the prompt knows to include the slot match section.
          alert._preAnalysis = {
            clientFound,
            hasSlotMatches,
            slotMatchContext,
            isForeignCurrency,
            invoiceCurrency,
            primaryCurrency,
          };
        }

        // ── TIER 1: Single exact slot match — generate option without Claude ─
        // Conditions: exactly one slot match, amount exact (within 5p), date within
        // tolerance, not a job-total MANUAL-INV scenario (those need clearing logic).
        // Client name must match (clientFound). If any condition fails → Tier 2 (Claude).
        const tier1PreAnalysis = alert._preAnalysis || {};
        const tier1Eligible = (
          tier1PreAnalysis.hasSlotMatches &&
          tier1PreAnalysis.clientFound &&
          slotMatches.length === 1 &&
          slotMatches[0].dateMatch &&
          !slotMatches[0].isJobTotalMatch &&
          !tier1PreAnalysis.isForeignCurrency
        );

        if (tier1Eligible) {
          const m = slotMatches[0];
          const slotColLetter = m.amtCol; // e.g. "AP"
          const refColLetter  = m.refCol;
          const sentColLetter = m.sentCol;
          const daysColLetter = m.daysCol;
          const statColLetter = m.statusCol;
          const rowNum = m.rowNum;
          const slotNum = m.slotNum;
          const isManual = m.isManual;
          const slotLabel = `${m.client} — ${m.jobName} (Row ${rowNum} Slot ${slotNum})`;
          const slotDesc = isManual ? "replacing the MANUAL-INV placeholder" : "replacing the blank placeholder";
          console.log(`  ✅ Tier 1 match — generating option without Claude: ${slotLabel}`);

          const tier1Option = {
            optionId: 1,
            title: `Place in ${m.client} — ${m.jobName} slot ${slotNum} (Row ${rowNum}) — exact amount match, ${isManual ? "replacing MANUAL-INV placeholder" : "slot date match"}`,
            matchType: "existing_job",
            jobRow: rowNum,
            jobName: m.jobName,
            jobRevenue: m.revenue,
            targetRowNum: rowNum,
            targetSlotType: "invoice",
            targetSlotNum: slotNum,
            matchAnalysis: {
              matchConfidence: "High",
              reasonForChoice: `Amount exact match (£${invoiceAmtForMatch.toFixed(2)}). Client name match (${m.client}). Invoice sent ${sentDate} vs slot date ${m.slotDate} — within tolerance.`,
              discrepancies: "None",
            },
            recommendedActions: [
              `Place invoice ${invoiceRef} (£${invoiceAmtForMatch.toFixed(2)}) in invoice slot ${slotNum} of the ${m.client} ${m.jobName} ${isManual ? "project, " + slotDesc : "job"}`,
              [
                `write ${invoiceAmtForMatch.toFixed(2)} to ${slotColLetter}${rowNum} (invoice ${slotNum} amount)`,
                `write ${invoiceRef} to ${refColLetter}${rowNum} (invoice ${slotNum} reference)`,
                `write ${sentDate || ""} to ${sentColLetter}${rowNum} (invoice ${slotNum} sent date)`,
                `write ${daysToPayValue || 30} to ${daysColLetter}${rowNum} (invoice ${slotNum} days to pay)`,
                `write ${invoiceStatus || "Sent"} to ${statColLetter}${rowNum} (invoice ${slotNum} status)`,
              ].join(", "),
            ],
            slotBreakdown: { lines: [`Row ${rowNum} Slot ${slotNum}: ${invoiceRef} £${invoiceAmtForMatch.toFixed(2)} ← this invoice`], correctedTotal: `£${invoiceAmtForMatch.toFixed(2)}`, currentRevenue: `£${m.revenue || 0}` },
          };

          tier1Option.jobRowsData = await fetchJobRowsForDisplay(
            sheets, alert.clientId, "Confirmed", rowNum,
            { type: "invoice", rowNum, slotNum },
            sharedData
          );

          const tier1Summary = `Invoice ${invoiceRef} ${m.client} — ${m.jobName}`;
          await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
          const memRowsTier1 = await readAlertMemory(sheets, automationCommanderSheetId);
          const memRowTier1 = findMemoryRow(memRowsTier1, fingerprintHash);
          if (memRowTier1) {
            await updateAlertMemoryRow(sheets, automationCommanderSheetId, memRowTier1.rowIndex, { ...memRowTier1, cachedOptionsJSON: JSON.stringify([tier1Option]) });
          } else {
            await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType: "invoice", clientName: alert.clientName || "", alertSummary: tier1Summary, cachedOptionsJSON: JSON.stringify([tier1Option]), status: "cached" });
          }
          return res.status(200).json({ success: true, options: [tier1Option], alertId: alert.rowNumber, previousIgnoreReason });
        }

        // ── TIER 2: System-generated options (ambiguous, no match, or foreign currency) ─
        // If forceAI is set, send the full Confirmed tab to Claude as before.
        if (req.body.forceAI === true) {
          console.log("  🤖 forceAI=true — using Claude for invoice options");
          // Build compact confirmed tab summary for Claude
          const aiInvRows = activeData.slice(0, Math.min(activeData.length, 200)).map((row, ridx) => {
            const inv1 = `${row[42]||"(empty)"} £${row[41]||"?"} sent:${row[43]||"?"}`;
            const inv2 = `${row[49]||"(empty)"} £${row[48]||"?"} sent:${row[50]||"?"}`;
            const inv3 = `${row[56]||"(empty)"} £${row[55]||"?"} sent:${row[57]||"?"}`;
            return `Row ${ridx+1} | ${row[0]||""} | ${row[1]||""} | Rev:${row[32]||""} | Inv1:${inv1} | Inv2:${inv2} | Inv3:${inv3}`;
          }).join("\n");
          const aiInvPrompt = `You are a financial reconciliation assistant. Place this invoice into the correct slot in the Confirmed tab.
Invoice: #${invoiceNo}, Amount excl VAT: £${totalExclVAT}, Gross: £${grossAmount}, Sent: ${invSentDate}, Status: ${invStatus}
Client: ${invClient}, Job description: ${invJob}
${alert._preAnalysis?.slotMatchContext || "No pre-computed slot matches."}
Confirmed tab (first 200 rows):
${aiInvRows}
Return a JSON array of options. Each option: optionId, title, matchType (existing_job|info), jobRow, jobName, jobRevenue, matchAnalysis (matchConfidence, amountMatch, dateRangeMatch, reasonForChoice, discrepancies), recommendedActions (array of strings), slotBreakdown.`;
          const aiInvMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 4000, messages: [{ role: "user", content: aiInvPrompt }] });
          await logClaudeUsage_(sheets, automationCommanderSheetId, alert.clientName || "", "invoice", aiInvMsg.usage?.input_tokens || 0, aiInvMsg.usage?.output_tokens || 0).catch(() => {});
          let aiInvOptions = [];
          try {
            const rawInv = aiInvMsg.content[0].type === "text" ? aiInvMsg.content[0].text : "";
            const cleanInv = rawInv.replace(/```json/g,"").replace(/```/g,"").trim();
            const arrInv = cleanInv.slice(cleanInv.indexOf("["), cleanInv.lastIndexOf("]")+1);
            aiInvOptions = JSON.parse(arrInv);
            if (!Array.isArray(aiInvOptions)) aiInvOptions = [aiInvOptions];
          } catch(e) { aiInvOptions = [{ optionId:1, title:"AI response could not be parsed", matchType:"info", recommendedActions:[] }]; }
          const aiInvSummary = `Invoice ${invoiceRef} ${invClient} — ${invJob}`;
          if (memoryRow) { await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(aiInvOptions) }); }
          else { await appendAlertMemoryRow(sheets, automationCommanderSheetId, { fingerprintHash, alertType:"invoice", clientName: alert.clientName||"", alertSummary: aiInvSummary, cachedOptionsJSON: JSON.stringify(aiInvOptions), status:"cached" }); }
          return res.status(200).json({ success: true, options: aiInvOptions, alertId: alert.rowNumber, previousIgnoreReason });
        }
        // Strategy:
        // A) Amount-matched slots (already found in slotMatches) → high-confidence options
        // B) Client+job name fuzzy matched slots (any amount, non-real slot) → lower-confidence
        // C) Manual investigation fallback

        const INV_SLOT_DEFS2 = [
          { amtIdx:41, refIdx:42, sentIdx:43, slotNum:1, amtCol:"AP", refCol:"AQ", sentCol:"AR", daysCol:"AS", statusCol:"AT" },
          { amtIdx:48, refIdx:49, sentIdx:50, slotNum:2, amtCol:"AW", refCol:"AX", sentCol:"AY", daysCol:"AZ", statusCol:"BA" },
          { amtIdx:55, refIdx:56, sentIdx:57, slotNum:3, amtCol:"BD", refCol:"BE", sentCol:"BF", daysCol:"BG", statusCol:"BH" },
        ];

        // Noise-word stripping for job name matching
        const INV_NOISE = new Set(["ltd","limited","plc","inc","llc","llp","the","and","&",
          "group","co","corp","corporation","holdings","international","uk","us",
          "solutions","services","consulting","consultancy","project","projects"]);
        const normInvWords = s => String(s||"").toLowerCase()
          .replace(/['"\-.,()/#]/g," ").replace(/\s+/g," ").trim()
          .split(" ").filter(w => w.length > 1 && !INV_NOISE.has(w));

        const invJobWords    = normInvWords(invJob);
        const invClientWords = normInvWords(invClient);

        const tier2Options = [];
        const seenSlotKeys = new Set(); // avoid duplicate options for same slot

        // ── Signal A: Amount-matched slots ───────────────────────────────────
        // slotMatches was already computed in the pre-check sweep above.
        // Group by job so each job appears at most once.
        const amtMatchedJobs = new Map();
        for (const m of (slotMatches || [])) {
          const key = `${m.client}||${m.jobName}`;
          if (!amtMatchedJobs.has(key)) amtMatchedJobs.set(key, []);
          amtMatchedJobs.get(key).push(m);
        }

        for (const [, matches] of amtMatchedJobs) {
          // Pick the best slot: prefer date match, then lowest slot number
          const best = matches.sort((a,b) => {
            if (a.dateMatch && !b.dateMatch) return -1;
            if (!a.dateMatch && b.dateMatch) return 1;
            return a.slotNum - b.slotNum;
          })[0];
          const slotKey = `${best.rowNum}-${best.slotNum}`;
          seenSlotKeys.add(slotKey);

          // Calculate total invoiced (real slots only, excluding MANUAL-INV/blank)
          let realTotal = 0;
          for (let ri = 1; ri < activeData.length; ri++) {
            const r = activeData[ri] || [];
            const rc = String(r[0]||"").trim().toLowerCase();
            const rj = String(r[1]||"").trim().toLowerCase();
            const clientNorm = best.client.toLowerCase();
            const jobNorm    = best.jobName.toLowerCase();
            const isJobRow   = (rc === clientNorm && rj === jobNorm) ||
              (!r[0] && !r[1] && ri > 1 && realTotal > 0); // child row
            if (!isJobRow) { if (realTotal > 0 && rc && rc !== clientNorm) break; continue; }
            for (const sd of INV_SLOT_DEFS2) {
              const ref = String(r[sd.refIdx]||"").trim();
              const amt = parseFloat(String(r[sd.amtIdx]||"").replace(/[£$€,]/g,"")) || 0;
              const isReal = ref && !ref.toUpperCase().startsWith("MANUAL-INV");
              if (isReal) realTotal += amt;
            }
          }
          const newTotal = realTotal + invoiceAmtForMatch;
          const revNum   = parseFloat(String(best.revenue||"0").replace(/[£$€,]/g,"")) || 0;
          const remaining = revNum > 0 ? revNum - newTotal : null;
          const budgetFits = revNum === 0 || newTotal <= revNum; // no known revenue = don't penalise
          const isExactClient = String(best.client||"").trim().toLowerCase() === String(invClient||"").trim().toLowerCase();
          const confidence = best.dateMatch ? "High" : "Medium";
          const slotDesc   = best.isManual ? "replacing MANUAL-INV placeholder" : "replacing blank placeholder";
          const dateNote   = best.dateMatch
            ? `Invoice sent ${sentDate}, slot date ${best.slotDate} — within tolerance`
            : `Invoice sent ${sentDate}, slot date ${best.slotDate} — outside date tolerance`;

          const slotLines = [`Row ${best.rowNum} Slot ${best.slotNum}: ${invoiceRef} £${invoiceAmtForMatch.toFixed(2)} ← this invoice`];
          const revLine = revNum > 0
            ? `Revenue: £${revNum.toFixed(2)} | Previously invoiced (real only): £${realTotal.toFixed(2)} | New total: £${newTotal.toFixed(2)} | ${remaining !== null ? `Remaining: £${remaining.toFixed(2)}` : ""}`
            : `Revenue: unknown`;

          tier2Options.push({
            optionId: tier2Options.length + 1,
            title: `Place in ${best.client} — ${best.jobName} slot ${best.slotNum} (Row ${best.rowNum}) — amount match, ${slotDesc}`,
            matchType: "existing_job",
            jobRow: best.rowNum,
            jobName: best.jobName,
            jobRevenue: best.revenue,
            targetRowNum: best.rowNum,
            targetSlotType: "invoice",
            targetSlotNum: best.slotNum,
            matchingDetails: {
              // revenue/startDate here must be the JOB's own true values — the
              // row-re-verification check before writing (a few hundred lines
              // down) reads this field expecting the target row's expected
              // state, to confirm cell references haven't gone stale. This
              // previously held the INVOICE's own amount/sent-date instead
              // (invoiceAmtForMatch/sentDate) — which never matches the job
              // row's actual revenue/start date, so verification failed on
              // every single write through this path. Fixed 20 Aug 2026,
              // confirmed via a live example (Orinoco Communications →
              // Oxford Health NHS Foundation Trust). best.revenue is the
              // job's real revenue (already used correctly elsewhere in this
              // same option, in matchedJobDetails below); the job's true
              // start date isn't reliably available here, so it's left empty
              // rather than populated with another wrong value — the
              // verification guard already skips its date check cleanly when
              // the expected value is empty.
              unmatchedJobSummary: {
                clientName: invClient,
                jobName: best.jobName,
                projectCode: "",
                revenue: String(best.revenue || ""),
                startDate: "",
                endDate: "",
                likelihood: "",
              },
              matchedJobDetails: {
                clientName: best.client,
                jobName: best.jobName,
                projectCode: best.projectCode,
                revenue: best.revenue,
                startDate: "",
                endDate: "",
              },
            },
            matchAnalysis: {
              matchConfidence: confidence,
              amountMatch: `YES — invoice £${invoiceAmtForMatch.toFixed(2)} matches slot £${best.slotAmt.toFixed(2)} (within tolerance)`,
              dateRangeMatch: best.dateMatch ? "YES" : "PARTIAL — outside date tolerance",
              projectCodeMatch: "N/A",
              reasonForChoice: `Amount match on ${best.jobName} Row ${best.rowNum} Slot ${best.slotNum}. ${dateNote}.`,
              discrepancies: best.dateMatch ? "None" : `Date outside tolerance: ${dateNote}`,
              whyItDidntAutoMatch: "Multiple slot matches or foreign currency — system presented all options",
            },
            recommendedActions: [
              `Place invoice ${invoiceRef} (£${invoiceAmtForMatch.toFixed(2)}) in ${best.client} — ${best.jobName} slot ${best.slotNum}, ${slotDesc}`,
              [`write ${invoiceAmtForMatch.toFixed(2)} to ${best.amtCol}${best.rowNum}`,
               `write ${invoiceRef} to ${best.refCol}${best.rowNum}`,
               `write ${sentDate||""} to ${best.sentCol}${best.rowNum}`,
               `write ${daysToPayValue||30} to ${best.daysCol}${best.rowNum}`,
               `write ${invoiceStatus||"Sent"} to ${best.statusCol}${best.rowNum}`].join(", "),
            ],
            slotBreakdown: { lines: slotLines, correctedTotal: `£${newTotal.toFixed(2)}`, currentRevenue: `£${revNum.toFixed(2)}`, revLine },
            _rankStartDate: best.startDate || "",
            _rankBudgetFits: budgetFits,
            _rankExactClient: isExactClient,
            _rankDateMatch: best.dateMatch === true,
            _rankPartialClient: fuzzyClientMatch_(invClient, best.client),
          });
        }

        // ── Signal B: Job-name fuzzy matched slots (first non-real slot only) ──
        // Requires a client name match (exact or close overlap) — job name alone is not
        // sufficient, since job names can coincidentally share words across clients.
        // Only the FIRST available placeholder/MANUAL-INV slot per job is offered — if a
        // job already has later slots filled behind an earlier gap, presenting every
        // remaining slot as a separate option is misleading (the gap should be filled
        // in order).
        if (invClientWords.length > 0) {
          const jobNameMatches = new Map(); // key → { client, jobName, rows, bestSlot }
          for (let ri = 1; ri < activeData.length; ri++) {
            const r = activeData[ri] || [];
            const rc = String(r[0]||"").trim();
            const rj = String(r[1]||"").trim();
            const rev = String(r[32]||"").trim();
            if (!rc && !rj) continue;
            const rcWords = normInvWords(rc);
            const rjWords = normInvWords(rj);
            const clientOverlap = invClientWords.some(w => rcWords.includes(w)) || rcWords.some(w => invClientWords.includes(w));
            if (!clientOverlap) continue; // client match required — job name alone is not enough

            // Find only the FIRST non-real slot on this row (in slot-number order)
            let sd = null, ref = "", rawAmt = "", isManual = false;
            for (const cand of INV_SLOT_DEFS2) {
              const candRef = String(r[cand.refIdx]||"").trim();
              const candIsManual = candRef.toUpperCase().startsWith("MANUAL-INV");
              const candIsNonReal = !candRef || candIsManual;
              if (!candIsNonReal) continue;
              const candKey = `${ri+1}-${cand.slotNum}`;
              if (seenSlotKeys.has(candKey)) continue; // already in Signal A
              sd = cand; ref = candRef; rawAmt = r[cand.amtIdx]; isManual = candIsManual;
              break; // first match only
            }
            if (!sd) continue;

            {
              const slotAmt = parseFloat(String(rawAmt||"").replace(/[£$€,]/g,"")) || 0;
              const slotKey = `${ri+1}-${sd.slotNum}`;
              seenSlotKeys.add(slotKey);
              const slotDate = String(r[sd.sentIdx]||"").trim();

              // Calculate real total for this job
              let bRealTotal = 0;
              let bRev = rev;
              for (let rj2 = 1; rj2 < activeData.length; rj2++) {
                const r2 = activeData[rj2] || [];
                const rc2 = String(r2[0]||"").trim();
                const rj2n = String(r2[1]||"").trim();
                if (rc2 !== rc || rj2n !== rj) continue;
                if (String(r2[32]||"").trim()) bRev = String(r2[32]||"").trim();
                for (const sd2 of INV_SLOT_DEFS2) {
                  const ref2 = String(r2[sd2.refIdx]||"").trim();
                  const amt2 = parseFloat(String(r2[sd2.amtIdx]||"").replace(/[£$€,]/g,"")) || 0;
                  if (ref2 && !ref2.toUpperCase().startsWith("MANUAL-INV")) bRealTotal += amt2;
                }
              }
              const bNewTotal = bRealTotal + invoiceAmtForMatch;
              const bRevNum   = parseFloat(String(bRev||"0").replace(/[£$€,]/g,"")) || 0;
              const bBudgetFits = bRevNum === 0 || bNewTotal <= bRevNum;
              const bIsExactClient = String(rc||"").trim().toLowerCase() === String(invClient||"").trim().toLowerCase();
              const bStartDate = String(r[37]||"").trim(); // AL
              const amtDiff   = slotAmt > 0 ? (invoiceAmtForMatch - slotAmt) : null;
              const amtNote   = slotAmt > 0
                ? (Math.abs(invoiceAmtForMatch - slotAmt) < 0.01
                  ? "exact amount match"
                  : `slot is £${slotAmt.toFixed(2)}, invoice is £${invoiceAmtForMatch.toFixed(2)} — diff £${Math.abs(amtDiff||0).toFixed(2)}`)
                : "slot amount unknown";
              const overUnder = bRevNum > 0 ? (bNewTotal > bRevNum ? ` (over budget by £${(bNewTotal-bRevNum).toFixed(2)})` : ` (£${(bRevNum-bNewTotal).toFixed(2)} remaining)`) : "";
              const slotLabel = isManual ? "MANUAL-INV placeholder" : "blank placeholder";
              // This path had slotDate available but never actually checked
              // it against the invoice's sent date — dateRangeMatch was
              // hardcoded to "UNKNOWN"/"N/A" regardless of actual
              // proximity. Fixed 20 Aug 2026 alongside the ranking fix below.
              const bDateMatch = dateWithinTolerance(slotDate);

              tier2Options.push({
                optionId: tier2Options.length + 1,
                title: `Place in ${rc} — ${rj||rc} slot ${sd.slotNum} (Row ${ri+1}) — name match, ${slotLabel}, ${amtNote}`,
                matchType: "existing_job",
                jobRow: ri + 1,
                jobName: rj || rc,
                jobRevenue: bRev,
                targetRowNum: ri + 1,
                targetSlotType: "invoice",
                targetSlotNum: sd.slotNum,
                matchingDetails: {
                  // Same fix as the amount-match Tier 2 path above (20 Aug
                  // 2026) — unmatchedJobSummary must hold the job's own true
                  // revenue/start date for row-verification to work, not the
                  // invoice's. bStartDate is available here (read from the
                  // sheet just above), so it's populated correctly rather
                  // than left empty.
                  unmatchedJobSummary: {
                    clientName: invClient, jobName: rj || rc, projectCode: "",
                    revenue: String(bRev || ""), startDate: bStartDate, endDate: "",
                  },
                  matchedJobDetails: {
                    clientName: rc, jobName: rj, projectCode: String(r[2]||""), revenue: bRev, startDate: "", endDate: "",
                  },
                },
                matchAnalysis: {
                  matchConfidence: bDateMatch ? "Medium" : "Low",
                  amountMatch: slotAmt > 0 ? (Math.abs(invoiceAmtForMatch-slotAmt)<0.01 ? "YES" : `PARTIAL — ${amtNote}`) : "UNKNOWN",
                  dateRangeMatch: bDateMatch === null ? (slotDate ? "UNKNOWN" : "N/A") : (bDateMatch ? "YES" : "PARTIAL — outside date tolerance"),
                  projectCodeMatch: "N/A",
                  reasonForChoice: `Job/client name has word overlap with invoice. ${amtNote}. Current real invoiced: £${bRealTotal.toFixed(2)}, new total would be £${bNewTotal.toFixed(2)}${overUnder}.`,
                  discrepancies: amtDiff && Math.abs(amtDiff) > 0.01 ? `Amount mismatch: slot £${slotAmt.toFixed(2)} vs invoice £${invoiceAmtForMatch.toFixed(2)}` : "None",
                  whyItDidntAutoMatch: "Amount does not match within tolerance — presented as lower-confidence option",
                },
                recommendedActions: [
                  `Place invoice ${invoiceRef} (£${invoiceAmtForMatch.toFixed(2)}) in ${rc} — ${rj} slot ${sd.slotNum} (Row ${ri+1}), ${slotLabel}`,
                  [`write ${invoiceAmtForMatch.toFixed(2)} to ${sd.amtCol}${ri+1}`,
                   `write ${invoiceRef} to ${sd.refCol}${ri+1}`,
                   `write ${sentDate||""} to ${sd.sentCol}${ri+1}`,
                   `write ${daysToPayValue||30} to ${sd.daysCol}${ri+1}`,
                   `write ${invoiceStatus||"Sent"} to ${sd.statusCol}${ri+1}`].join(", "),
                ],
                slotBreakdown: {
                  lines: [`Row ${ri+1} Slot ${sd.slotNum}: ${invoiceRef} £${invoiceAmtForMatch.toFixed(2)} ← this invoice (${amtNote})`],
                  correctedTotal: `£${bNewTotal.toFixed(2)}`,
                  currentRevenue: `£${bRevNum.toFixed(2)}`,
                },
                _rankStartDate: bStartDate,
                _rankBudgetFits: bBudgetFits,
                _rankExactClient: bIsExactClient,
                _rankDateMatch: bDateMatch === true,
                _rankPartialClient: fuzzyClientMatch_(invClient, rc),
              });
              if (tier2Options.length >= 5) break; // cap at 5 options total
            }
            if (tier2Options.length >= 5) break;
          }
        }

        // ── Rank options: budget fit → exact client match → most recent job first ──
        const parseRankDate = (d) => {
          if (!d) return null;
          const MONTHS_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
          const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
          if (!m) return null;
          const mIdx = MONTHS_MAP[m[2].toLowerCase()];
          if (mIdx === undefined) return null;
          const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
          return new Date(yr, mIdx, parseInt(m[1])).getTime();
        };
        tier2Options.sort((a, b) => {
          // 1. Budget fit — options that don't exceed job revenue come first
          if (a._rankBudgetFits !== b._rankBudgetFits) return a._rankBudgetFits ? -1 : 1;
          // 2. Exact client name match comes first
          if (a._rankExactClient !== b._rankExactClient) return a._rankExactClient ? -1 : 1;
          // 3. Partial client name match (word overlap, e.g. "Oxford" in
          // both) comes next — added 20 Aug 2026, prompted by Paul asking
          // whether this was considered at all (it wasn't). Uses the shared
          // module-level fuzzyClientMatch_ (also used to decide
          // clientFound above) rather than a second, separate definition —
          // originally a local reuse here, but that turned out to be
          // unreachable from this scope; see fuzzyClientMatch_'s own
          // comment. A completely unrelated client is a stronger
          // disqualifier than a date mismatch, so this ranks above
          // date-match below — mirrors the equivalent fix just made to the
          // expense-matching side's clientOverlap, which was being computed
          // but never actually used in its own ranking either.
          if (a._rankPartialClient !== b._rankPartialClient) return a._rankPartialClient ? -1 : 1;
          // 4. Invoice sent date within tolerance of the slot's expected
          // date comes first — added 20 Aug 2026, confirmed via a live
          // example (Orinoco Communications) where an option with the
          // invoice date 4 months from the slot's expected date outranked
          // one only 5 days off, because date proximity was never
          // considered here at all — only the unrelated signal of which
          // JOB itself started more recently (step 5 below). This is a
          // direct, strong signal of whether the invoice actually belongs
          // to this slot; job recency is a much weaker, indirect one and
          // now only decides remaining ties.
          if (a._rankDateMatch !== b._rankDateMatch) return a._rankDateMatch ? -1 : 1;
          // 5. More recent job (later start date) comes first
          const da = parseRankDate(a._rankStartDate);
          const db = parseRankDate(b._rankStartDate);
          if (da === null && db === null) return 0;
          if (da === null) return 1;
          if (db === null) return -1;
          return db - da;
        });

        // ── Fallback: Manual investigation ────────────────────────────────────
        tier2Options.push({
          optionId: tier2Options.length + 1,
          title: "MANUAL INVESTIGATION REQUIRED — no confident automatic match found",
          matchType: "info",
          matchAnalysis: {
            matchConfidence: "N/A",
            amountMatch: "N/A",
            dateRangeMatch: "N/A",
            projectCodeMatch: "N/A",
            reasonForChoice: "The system could not identify a high-confidence slot match for this invoice. Review manually.",
            discrepancies: `Invoice #${invoiceNo} £${invoiceAmtForMatch.toFixed(2)} sent ${sentDate} for client "${invClient}" job "${invJob}"`,
          },
          recommendedActions: [
            `Review invoice #${invoiceNo} (£${invoiceAmtForMatch.toFixed(2)}, sent ${sentDate}) manually`,
            `Find the matching job in the Confirmed tab and place into the appropriate invoice slot`,
          ],
        });

        // Renumber and cache
        let options = tier2Options.map((o, i) => {
          const { _rankStartDate, _rankBudgetFits, _rankExactClient, _rankDateMatch, _rankPartialClient, ...clean } = o;
          return { ...clean, optionId: i + 1 };
        });
        console.log(`  ✅ System-generated ${options.length} invoice options`);

        // Attach jobRowsData for spreadsheet-style display — cache by row+slot since
        // different options can target the same row with different slots highlighted
        const invJobRowCache = new Map();
        for (const opt of options) {
          if (!opt.jobRow) continue;
          const highlightSlot = (opt.targetSlotType && opt.targetSlotNum)
            ? { type: opt.targetSlotType, rowNum: opt.targetRowNum || opt.jobRow, slotNum: opt.targetSlotNum }
            : null;
          const cacheKey = `${opt.jobRow}-${highlightSlot?.slotNum ?? "none"}`;
          if (!invJobRowCache.has(cacheKey)) {
            invJobRowCache.set(cacheKey, await fetchJobRowsForDisplay(sheets, alert.clientId, "Confirmed", opt.jobRow, highlightSlot, sharedData));
          }
          opt.jobRowsData = invJobRowCache.get(cacheKey);
        }

        const invSummary = `Invoice ${invoiceRef} ${invClient} — ${invJob}`;
        if (memoryRow) {
          await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, { ...memoryRow, cachedOptionsJSON: JSON.stringify(options) });
        } else {
          await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
            fingerprintHash, alertType: "invoice", clientName: alert.clientName || "",
            alertSummary: invSummary, cachedOptionsJSON: JSON.stringify(options), status: "cached",
          });
        }
        console.log(`  💾 Options cached in AlertMemory`);
        
        res.status(200).json({
          success: true,
          options,
          alertId: alert.rowNumber,
          previousIgnoreReason
        });
      } catch (err) {
        console.error("❌ Error generating options:", err);
        res.status(500).json({ success: false, error: err.message });
      }
}

export async function handleAcceptOption(req, res, sheets) {
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

        // ── IGNORE — mark alert as ignored in AlertMemory ────────────────────
        if (option.matchType === "ignore") {
          console.log(`  → Ignoring alert (CRM not_found — job is legitimate)`);
          await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
          const memRows = await readAlertMemory(sheets, automationCommanderSheetId);
          const fp = alert.fingerprintHash || buildAlertFingerprint(alert);
          const mr = findMemoryRow(memRows, fp);
          const alertSummary = `CRM ${alert.alertType} ${alert.clientName} — ${option.jobName || ""}`.trim();
          const dataSnapshot = JSON.stringify({ alertType: alert.type || alert.flagType || "", flagType: alert.flagType || "", masterSheetId: alert.masterSheetId || "" });
          if (mr) {
            await updateAlertMemoryRow(sheets, automationCommanderSheetId, mr.rowIndex, { ...mr, status: "ignored", ignoreReason: "Accepted IGNORE option — job is legitimate", dataSnapshot });
          } else {
            await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
              fingerprintHash: fp, alertType: alert.type || alert.flagType || "crm",
              clientName: alert.clientName || "", alertSummary,
              cachedOptionsJSON: "", status: "ignored",
              ignoreReason: "Accepted IGNORE option — job is legitimate", dataSnapshot,
            });
          }
          await sheets.spreadsheets.values.append({
            spreadsheetId: automationCommanderSheetId, range: "TriageLog!A:H",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[new Date().toISOString(), alert.type || alert.flagType, `${alert.sheetName}-${alert.rowNumber}`, alert.clientName || "", "", JSON.stringify({ jobName: option.jobName }), "IGNORED", option.title]] },
          });
          return res.status(200).json({ success: true, message: "Alert marked as ignored", cellsWritten: 0 });
        }

        // ── DELETE — blank all cells for the job in Pipeline/Confirmed tab ──
        if (option.matchType === "delete") {
          const tabName = (alert.mode === "Pipeline" || alert.alertType === "crmPipeAppDiscr") ? "Pipeline" : "Confirmed";
          const jobRowNum = option.jobRow;
          if (!jobRowNum) return res.status(400).json({ success: false, error: "Cannot delete: job row number not found" });

          console.log(`  → Deleting job row(s) from ${tabName} tab, starting at row ${jobRowNum}`);
          const tabResp = await sheets.spreadsheets.values.get({
            spreadsheetId: alert.clientId,
            range: `${tabName}!A${jobRowNum}:CR${jobRowNum + 50}`,
          });
          const tabRows = tabResp.data.values || [];

          // Collect parent row + contiguous child rows (blank client/job)
          const rowsToClear = [jobRowNum];
          for (let ri = 1; ri < tabRows.length; ri++) {
            const r = tabRows[ri] || [];
            const hasContent = r.some(c => String(c || "").trim() !== "");
            const isChild = !r[0] && !r[1] && hasContent;
            if (!isChild) break;
            rowsToClear.push(jobRowNum + ri);
          }
          console.log(`  Clearing ${rowsToClear.length} rows: ${rowsToClear.join(", ")}`);

          // Column ranges to clear per the option description: A:G, AG:AM, AP:BH, BX:CR
          const CLEAR_RANGES = ["A", "B", "C", "D", "E", "F", "G"];
          const buildRangeList = (rows) => {
            const ranges = [];
            for (const row of rows) {
              ranges.push(`${tabName}!A${row}:G${row}`);
              ranges.push(`${tabName}!AG${row}:AM${row}`);
              ranges.push(`${tabName}!AN${row}`);
              ranges.push(`${tabName}!AP${row}:BH${row}`);
              ranges.push(`${tabName}!BX${row}:CR${row}`);
              ranges.push(`${tabName}!DD${row}`);
            }
            return ranges;
          };

          const clearRanges = buildRangeList(rowsToClear);
          await sheets.spreadsheets.values.batchClear({
            spreadsheetId: alert.clientId,
            requestBody: { ranges: clearRanges },
          });

          // Mark alert as accepted in AlertMemory
          await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
          const memRows2 = await readAlertMemory(sheets, automationCommanderSheetId);
          const fp2 = alert.fingerprintHash || buildAlertFingerprint(alert);
          const mr2 = findMemoryRow(memRows2, fp2);
          const summary2 = `CRM ${alert.alertType} ${alert.clientName} — ${option.jobName || ""}`.trim();
          if (mr2) {
            await updateAlertMemoryRow(sheets, automationCommanderSheetId, mr2.rowIndex, { ...mr2, status: "accepted" });
          } else {
            await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
              fingerprintHash: fp2, alertType: alert.type || alert.flagType || "crm",
              clientName: alert.clientName || "", alertSummary: summary2,
              cachedOptionsJSON: "", status: "accepted", ignoreReason: "", dataSnapshot: "",
            });
          }
          await sheets.spreadsheets.values.append({
            spreadsheetId: automationCommanderSheetId, range: "TriageLog!A:H",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[new Date().toISOString(), alert.type || alert.flagType, `${alert.sheetName}-${alert.rowNumber}`, alert.clientName || "", "", JSON.stringify({ jobName: option.jobName, rowsCleared: rowsToClear }), "ACCEPTED", option.title]] },
          });

          return res.status(200).json({ success: true, message: `Cleared ${rowsToClear.length} row(s) from ${tabName} tab`, cellsWritten: clearRanges.length });
        }

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
        // Detect create_new either from matchType field OR from recommendedActions content
        // (Claude sometimes puts matchType inside the action string rather than as a JSON field)
        const isCreateNew = option.matchType === "create_new" ||
          (option.recommendedActions || []).some(a =>
            /create.new|new.row|new.job|add.new.row/i.test(a) || /matchType:\s*create_new/i.test(a)
          );

        if (isCreateNew) {
          console.log(`  → Create new job in Confirmed tab`);
          console.log(`  newJobData present: ${!!option.newJobData}`);
          console.log(`  option keys: ${Object.keys(option).join(", ")}`);
          if (option.newJobData) console.log(`  newJobData: ${JSON.stringify(option.newJobData)}`);

          // If Claude didn't return newJobData, reconstruct it from facts + alert summary
          if (!option.newJobData && option.facts) {
            const f = option.facts;
            const parseAmt = (v) => String(v ?? "").replace(/[£,]/g, "").trim();
            option.newJobData = {
              clientName:    String(f.clientName || alert.summary?.client || "").trim(),
              jobName:       String(f.jobName || f.jobDescription || option.jobName || "").trim(),
              projectCode:   String(f.projectCode || "").trim(),
              revenue:       parseAmt(f.totalRevenue || f.revenue || alert.summary?.amount || ""),
              directCosts:   "0",
              vatYesNo:      String(f.vatYesNo || f.vat || f.vatStatus || "No").trim(),
              projectType:   String(f.jobType || f.projectType || "Project").trim(),
              startDate:     String(f.startDate || alert.summary?.sentDate || "").trim(),
              endDate:       String(f.endDate || "").trim(),
              inv1Ref:       String(alert.summary?.invoiceNo || "").trim(),
              inv1Amount:    parseAmt(alert.summary?.amount || ""),
              inv1SentDate:  String(alert.summary?.sentDate || "").trim(),
              inv1DaysToPay: String(f.daysToPayValue || "30").trim(),
              inv1Status:    String(alert.summary?.status || "").trim(),
            };
            console.log(`  Reconstructed newJobData from facts: ${JSON.stringify(option.newJobData)}`);
          }

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

          // Parse cell updates from newJobData (structured) or fall back to text parsing
          const createCellUpdates = [];

          if (option.newJobData && typeof option.newJobData === "object") {
            // Primary path: Claude returned structured newJobData — map fields to columns
            const d = option.newJobData;
            const strVal = (v) => String(v ?? "").trim();
            const numVal = (v) => String(v ?? "").replace(/[£,]/g, "").trim();

            const fieldMap = [
              ["A",  strVal(d.clientName)],
              ["B",  strVal(d.jobName)],
              ["C",  strVal(d.projectCode)],
              ["AG", numVal(d.revenue)],
              ["AH", numVal(d.directCosts || "0")],
              ["AI", strVal(d.vatYesNo)],
              ["AJ", strVal(d.projectType)],
              ["AL", strVal(d.startDate)],
              ["AM", strVal(d.endDate)],
              // Inv1
              ["AP", numVal(d.inv1Amount)],
              ["AQ", strVal(d.inv1Ref)],
              ["AR", strVal(d.inv1SentDate)],
              ["AS", strVal(d.inv1DaysToPay)],
              ["AT", strVal(d.inv1Status)],
              // Inv2 (if present)
              ["AW", numVal(d.inv2Amount || "")],
              ["AX", strVal(d.inv2Ref || "")],
              ["AY", strVal(d.inv2SentDate || "")],
              ["AZ", strVal(d.inv2DaysToPay || "")],
              ["BA", strVal(d.inv2Status || "")],
            ];

            for (const [col, val] of fieldMap) {
              if (val !== "") createCellUpdates.push({ cell: `${col}${newRow}`, value: val });
            }
            console.log(`  newJobData parsed: ${createCellUpdates.length} fields`);

          } else {
            // Fallback: try to parse from recommendedActions text
            for (const actionString of (option.recommendedActions || [])) {
              // Format 1: "write VALUE to Col X"
              const regex1 = /write\s+(.+?)\s+to\s+Col(?:umn)?\s+([A-Z]{1,3})(?:\s*[,.()\n]|$)/gi;
              let match1;
              while ((match1 = regex1.exec(actionString)) !== null) {
                const val1 = match1[1].trim().replace(/^["']|["']$/g, '').trim();
                if (val1 && !/[A-Z]{1,3}\d+/.test(val1)) createCellUpdates.push({ cell: `${match1[2]}${newRow}`, value: val1 });
              }
            }
            if (createCellUpdates.length === 0) {
              // Format 2: "write VALUE to A251"
              for (const actionString of (option.recommendedActions || [])) {
                const regex2 = /write\s+(.+?)\s+to\s+([A-Z]{1,3}\d+)(?:\s*[,(]|$)/gi;
                let match2;
                while ((match2 = regex2.exec(actionString)) !== null) {
                  const val2 = match2[1].trim().replace(/^["']|["']$/g, '').trim();
                  if (val2 && !/[A-Z]{1,3}\d+/.test(val2)) createCellUpdates.push({ cell: match2[2], value: val2 });
                }
              }
            }
            console.log(`  Text fallback parsed: ${createCellUpdates.length} fields`);
          }

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
          // Log to TriageLog and update AlertMemory — failures here don't affect the user
          try {
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
          } catch (postWriteErr) {
            console.log(`  ⚠️ Post-write logging failed (job was still created): ${postWriteErr.message}`);
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
                let value = match[1].trim();
                const cell = match[2];
                // Reject malformed captures where the value itself contains a cell reference
                // e.g. "to CI51, write Received" — this means the regex caught too much
                if (/[A-Z]{1,3}\d+/.test(value)) {
                  console.log(`  ⚠ Skipping malformed write action — value "${value}" contains cell reference`);
                  continue;
                }
                // Strip surrounding quotes if Claude wrapped the value in them
                value = value.replace(/^["']|["']$/g, '').trim();
                // Allow empty string writes — these are intentional slot clears (e.g. clearing a MANUAL-INV placeholder)
                if (cell && value !== undefined) cellUpdates.push({ cell, value });
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
            // Strip leading currency symbols so numbers are stored as numeric values
            v = v.replace(/^[£$€]/, "");
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

          // Columns that must always be stored as text, never as numbers.
          // Invoice references (AQ/AX/BE), App IDs (BX/CF/CN), project codes (AC),
          // client name (A), job name (B), VAT setting (AI).
          const TEXT_ONLY_COLS = new Set(["A","B","AC","AI","AQ","AX","BE","BX","CF","CN"]);
          const forceText = (cell, val) => {
            // Extract column letters from cell reference e.g. "AQ65" → "AQ"
            const colMatch = cell.match(/^([A-Z]+)/);
            const col = colMatch ? colMatch[1] : "";
            if (TEXT_ONLY_COLS.has(col) && /^\d+$/.test(String(val).trim())) {
              // Prefix with apostrophe to force Sheets to treat as text
              return `'${val}`;
            }
            return val;
          };

          const batchRequest = {
            data: cellUpdates.map(({ cell, value }) => ({
              range: `${writeTab}!${cell}`,
              values: [[forceText(cell, sanitiseValue(value))]],
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

        // Update AlertMemory to "accepted" so runFullSweep doesn't re-raise this flag
        try {
          await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
          const memoryRowsFinal = await readAlertMemory(sheets, automationCommanderSheetId);
          const fpHash = alert.fingerprintHash || buildAlertFingerprint(alert);
          const memRowFinal = findMemoryRow(memoryRowsFinal, fpHash);
          const alertSummaryFinal = alert.summary?.summary || `${alert.type || alert.flagType} ${fpHash}`;
          if (memRowFinal) {
            await updateAlertMemoryRow(sheets, automationCommanderSheetId, memRowFinal.rowIndex, {
              ...memRowFinal, status: "accepted",
            });
          } else {
            await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
              fingerprintHash: fpHash,
              alertType: alert.type || alert.flagType || "unknown",
              clientName: alert.clientName || "",
              alertSummary: alertSummaryFinal,
              cachedOptionsJSON: "", status: "accepted", ignoreReason: "",
            });
          }
          console.log(`  ✅ AlertMemory updated to accepted`);
        } catch (memErr) {
          console.log(`  ⚠ AlertMemory update failed (non-fatal): ${memErr.message}`);
        }
        
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
}

export async function handleDeleteJob(req, res, sheets) {
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
  
          if (!clientSheetId) {
            console.error("  ❌ clientSheetId missing from alert");
            return res.status(400).json({ success: false, error: "Cannot delete: clientSheetId missing from alert — please re-analyse this alert and try again." });
          }
  
          // Only read cols A:B (client, job) and AG (revenue — to identify parent vs child)
          // This is much faster than reading A1:CR2000
          const tabResp = await sheets.spreadsheets.values.get({
            spreadsheetId: clientSheetId,
            range: `${tabName}!A1:AG2000`,
            valueRenderOption: "UNFORMATTED_VALUE",
          });
          const tabRows = tabResp.data.values || [];
          console.log(`  Tab read complete, ${tabRows.length} rows`);
  
          const targetClient = (option.matchingDetails?.unmatchedJobSummary?.clientName || "").trim().toLowerCase();
          const targetJob = (option.jobName || "").trim().toLowerCase();
          const targetCode = (option.matchingDetails?.unmatchedJobSummary?.projectCode || "").trim().toLowerCase();
  
          // Pipeline tab: client name only appears on parent rows — propagate to child rows
          let parentRowIdx = -1;
          let lastSeenClient = "";
          for (let i = 1; i < tabRows.length; i++) {
            const r = tabRows[i] || [];
            const rClientRaw = String(r[0] || "").trim();
            const rJob = String(r[1] || "").trim().toLowerCase();
            const rCode = String(r[2] || "").trim().toLowerCase();
            if (rClientRaw) lastSeenClient = rClientRaw.toLowerCase();
            const effectiveClient = rClientRaw ? rClientRaw.toLowerCase() : lastSeenClient;
            const clientMatch = effectiveClient === targetClient;
            const jobMatch = rJob === targetJob;
            const codeMatch = targetCode && rCode === targetCode;
            if ((codeMatch || (clientMatch && jobMatch))) {
              parentRowIdx = i;
              break;
            }
          }
  
          if (parentRowIdx === -1) {
            const sample = tabRows.slice(1,4).map(r => `"${r[0]||""}/${r[1]||""}"`).join(", ");
            return res.status(404).json({
              success: false,
              error: `Job "${option.jobName}" not found in ${tabName} tab — client name or job name may not match exactly. Nearby rows: ${sample}`,
            });
          }
  
          const parentSheetRow = parentRowIdx + 1;
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
  
          // Build column ranges to blank: A:G (1-7), AE (31), AG:AM (33-39), AN (40), AP:BH (42-60), BX:CR (76-96), DD (108)
          // AN = likelihood (40), DD = "Copied to Confirmed?" (108) — Pipeline-specific fields
          // In A1 notation: colNum is 1-indexed
          const colRanges = [
            [1, 7],    // A:G
            [31, 31],  // AE (Uneven revenue splits)
            [33, 39],  // AG:AM
            [40, 40],  // AN (likelihood)
            [42, 60],  // AP:BH
            [76, 96],  // BX:CR
            [108, 108], // DD (Copied to Confirmed?)
          ];
  
          const clearRanges = [];
          for (const rowIdx of rowsToBlank) {
            const sheetRow = rowIdx + 1;
            for (const [startCol, endCol] of colRanges) {
              const startColLetter = colIndexToLetter(startCol);
              const endColLetter = colIndexToLetter(endCol);
              clearRanges.push(`${tabName}!${startColLetter}${sheetRow}:${endColLetter}${sheetRow}`);
            }
          }
  
          // Use batchClear (not batchUpdate with "") — batchClear truly empties cells,
          // preserving formatting and not leaving empty-string values that would
          // trigger conditional formatting rules checking <>0 or <>"".
          await sheets.spreadsheets.values.batchClear({
            spreadsheetId: clientSheetId,
            requestBody: { ranges: clearRanges },
          });
          console.log(`  ✅ Cleared ${rowsToBlank.length} rows (${clearRanges.length} ranges)`);
  
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
  
          // Update AlertMemory so runFullSweep doesn't re-raise this flag
          try {
            await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
            const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
            const fingerprintHash = alert.fingerprintHash || buildAlertFingerprint(alert);
            const memoryRow = findMemoryRow(memoryRows, fingerprintHash);
            if (memoryRow) {
              await updateAlertMemoryRow(sheets, automationCommanderSheetId, memoryRow.rowIndex, {
                ...memoryRow, status: "accepted",
              });
            } else {
              await appendAlertMemoryRow(sheets, automationCommanderSheetId, {
                fingerprintHash,
                alertType: alert.alertType || alert.type || "crm",
                clientName: alert.clientName || "",
                alertSummary: `Deleted: ${option.jobName}`,
                cachedOptionsJSON: "", status: "accepted", ignoreReason: "",
              });
            }
          } catch (memErr) {
            console.log(`  ⚠ AlertMemory update failed (non-fatal): ${memErr.message}`);
          }
  
          return res.status(200).json({
            success: true,
            message: `Job "${option.jobName}" blanked across ${rowsToBlank.length} row(s) in ${tabName} tab`,
            rowsBlank: rowsToBlank.map(r => r + 1),
          });
        } catch (err) {
          console.error(`❌ Error in delete_job:`, err);
          return res.status(500).json({ success: false, error: `Failed to delete job: ${err.message}` });
        }
}

export async function handleAnalyzeNoActionFlag(req, res, sheets) {
// Analyze a non-actionable flag by reading the client's AutoLog tab (master sheet)
      // to identify exactly which jobs were affected, then verify them.
      // Supported flagTypes: crmCopiedConfChecked, crmCopiedConfUnchecked, retainerInvoicesCreated
      //
      // targetLine (26 Aug 2026, Paul's direction — proposal 2): when provided
      // (the exact AutoLog line text, already stored as the AlertMemory row's
      // alertSummary since that's how detection fingerprinted it), restricts
      // analysis to that one specific instance instead of scanning the whole
      // window for every possibly-relevant entry. Every one of the 6 rich
      // types' parsing/verification logic below is completely unchanged —
      // each already naturally produces a single-job result when only one
      // line is present to match, so narrowing the input alone is sufficient
      // and carries none of the risk a rewrite of that logic would.
      const { clientSheetId, masterSheetId, automationCommanderSheetId: acId, flagType, clientName, targetLine } = req.body;

      if (!clientSheetId || !masterSheetId || !acId || !flagType) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }

      try {
        console.log(`\n🔍 Analyzing non-actionable flag: ${flagType} for ${clientName}${targetLine ? " (targeted instance)" : ""}`);
        const sheets = await getSheetsClient();
        const masterSheetIdClean = extractSheetIdFromUrl(masterSheetId) || masterSheetId;
        const clientSheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
        const acIdClean = extractSheetIdFromUrl(acId) || acId;

        // ── Step 1: Find when this flag type was last resolved for this client ────
        // Skipped entirely when targetLine is provided — a lookback window is
        // meaningless once we're targeting one already-known, specific line;
        // it either exists in AutoLog or it doesn't. Saves the extra
        // AlertMemory read too.
        let windowStart = new Date(0); // epoch — no-op filter, overridden below when not targeted

        if (!targetLine) {
          windowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // default: 90 days ago
          let foundClear = false;

          try {
            const memoryRows = await readAlertMemory(sheets, acIdClean);
            const resolvedRows = memoryRows
              .filter(r => r.clientName === clientName && r.alertType === flagType && r.status !== "cached")
              .sort((a, b) => new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime());
            if (resolvedRows.length > 0) {
              const resolvedAt = new Date(resolvedRows[0].lastSeen || resolvedRows[0].firstSeen);
              if (!isNaN(resolvedAt.getTime())) {
                windowStart = resolvedAt;
                foundClear = true;
                console.log(`  ✓ ${flagType} last resolved for ${clientName} at ${resolvedAt.toISOString()} (AlertMemory)`);
              }
            }
          } catch (e) {
            console.log(`  ⚠ Could not read AlertMemory for last-resolved timestamp: ${e.message}`);
          }

          if (!foundClear) {
            console.log(`  ℹ No prior resolution found in AlertMemory — using 90-day window from ${windowStart.toISOString()}`);
          }
        }

        // ── Step 2: Read AutoLog and filter to entries after windowStart ──────────
        // AutoLog col A=Timestamp, B=Category, C=Summary, D=Details
        console.log(`  📖 Reading AutoLog from master sheet...`);
        const autoLogResp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: masterSheetIdClean,
          range: "AutoLog!A2:D5000",
          valueRenderOption: "UNFORMATTED_VALUE",
        }));
        const allAutoLogRows = autoLogResp.data.values || [];
        // Convert serial numbers to JS Dates (same approach as log tab reading)
        const autoLogSerialToDate = (val) => {
          if (!val) return null;
          if (typeof val === "number") return new Date((val - 25569) * 86400 * 1000);
          // Fallback: try direct parse for string timestamps
          const d = new Date(val);
          return isNaN(d.getTime()) ? null : d;
        };
        // Filter to entries after windowStart
        let autoLogRows = allAutoLogRows.filter(row => {
          const ts = autoLogSerialToDate(row[0]);
          return ts && ts > windowStart;
        });
        console.log(`  ✓ ${autoLogRows.length} AutoLog entries after window start (${allAutoLogRows.length} total)`);

        // Narrow to the one specific instance (26 Aug 2026, proposal 2) — every
        // branch below still scans/matches within autoLogRows exactly as
        // before, but now only one row (at most) is ever present to match,
        // since only rows whose Details genuinely contain this exact line
        // survive this filter. This is the entire mechanism that turns a
        // whole-window scan into a single-instance check, without touching
        // any of that per-type logic itself.
        if (targetLine) {
          autoLogRows = allAutoLogRows
            .filter(row => String(row[3] || "").includes(targetLine));
          console.log(`  ✓ Narrowed to ${autoLogRows.length} AutoLog row(s) containing the target line`);
        }

        const results = [];

        if (flagType === "crmCopiedConfChecked" || flagType === "crmCopiedConfUnchecked") {
          const expectCopied = flagType === "crmCopiedConfChecked";

          // Read all CRM AutoLog entries — the Details field contains the full structured log
          // The flag is raised when Pipeline col DD changes to 'Yes'.
          // The GAS code writes this at line 293: "Copied Status: 'X' -> 'Yes'"
          // as part of an "Updated Pipeline: Row N, Client | Job - ... Copied Status: ..." entry.
          // "Copied Pipeline Project to Confirmed:" is only written if B82="yes" (auto-copy enabled).
          // "Created New Confirmed Job:" is a direct Confirmed creation, unrelated to this flag.
          const allCRMEntries = autoLogRows.filter(row => {
            const cat = String(row[1] || "").toLowerCase();
            return cat.includes("crm") || cat.includes("pipeline") || cat.includes("confirmed");
          });
          console.log(`  ✓ ${allCRMEntries.length} CRM AutoLog entries total`);

          const relevantEntries = allCRMEntries.filter(row => {
            const details = String(row[3] || "");
            if (expectCopied) {
              // Pipeline DD changed to Yes, OR the job was skipped as a duplicate
              return (details.includes("Copied Status:") && (
                details.includes("-> 'Yes'") || details.includes("-> \"Yes\"")
              )) || details.includes("Skipped Copy: Job with Project Code");
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
                if (line.includes("Skipped Copy: Job with Project Code")) {
                  const codeMatch = line.match(/Project Code\s+"([^"]+)"/i);
                  if (codeMatch) {
                    affectedJobs.push({ jobName: "-", clientParsed: "", projectCodeFromLog: codeMatch[1].trim(), logTimestamp: String(entry[0] || "") });
                  }
                  continue;
                }
                if (!line.includes("Copied Status:")) continue;
                if (!line.includes("-> 'Yes'") && !line.includes("-> \"Yes\"")) continue;
                // Extract client | job from: "Updated Pipeline: Row N, ClientName | JobName - FieldName: ..."
                // Job names can contain " - " (e.g. "Grace & Co (Delta) - Prototype"), so we can't
                // simply stop at the first " - ". Instead, find the first known change-field keyword
                // (Start date:, End date:, Copied Status:, etc.) then take the last " - " before it.
                const pipeIdx = line.indexOf("|");
                if (pipeIdx !== -1) {
                  const rowMatch = line.match(/Row\s*(\d+),\s*([^|]*)/);
                  const pipelineRowFromLog = rowMatch ? parseInt(rowMatch[1], 10) : null;
                  const clientParsed = rowMatch ? rowMatch[2].trim() : "";
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
                  if (jobName) affectedJobs.push({ jobName, clientParsed, pipelineRowFromLog, logTimestamp: String(entry[0] || "") });
                }
              }
            }
            // Deduplicate by clientParsed + jobName or projectCodeFromLog
            const seen = new Set();
            const deduped = affectedJobs.filter(j => {
              const key = `${j.clientParsed}|||${j.jobName}|||${j.projectCodeFromLog || ""}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            affectedJobs.length = 0;
            affectedJobs.push(...deduped);
            console.log(`  ✓ Parsed ${affectedJobs.length} affected jobs: ${JSON.stringify(affectedJobs)}`);
          } else {
            // UNchecked: parse all relevant entries, same line-by-line approach as checked branch.
            // Only match lines that are genuine Pipeline field update entries:
            // Format: "Updated Pipeline: Row N, ClientName | JobName - ... Copied Status: 'Yes' -> 'No'"
            for (const entry of relevantEntries) {
              const details = String(entry[3] || "");
              const lines = details.split('\n');
              for (const line of lines) {
                // Must be a Pipeline update line
                if (!line.includes("Updated Pipeline:")) continue;
                if (!line.includes("Copied Status:")) continue;
                if (!line.includes("-> 'No'") && !line.includes("-> \"No\"")) continue;
                const pipeIdx = line.indexOf("|");
                if (pipeIdx !== -1) {
                  const rowMatch = line.match(/Row\s*(\d+),\s*([^|]*)/);
                  const pipelineRowFromLog = rowMatch ? parseInt(rowMatch[1], 10) : null;
                  const clientParsed = rowMatch ? rowMatch[2].trim() : "";
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
                  affectedJobs.push({ jobName: jobName || "-", clientParsed, pipelineRowFromLog, logTimestamp: String(entry[0] || "") });
                }
              }
            }
            // Deduplicate by clientParsed + jobName
            const seenU = new Set();
            const dedupedU = affectedJobs.filter(j => {
              const k = `${j.clientParsed}|||${j.jobName}`;
              if (seenU.has(k)) return false;
              seenU.add(k); return true;
            });
            affectedJobs.length = 0;
            affectedJobs.push(...dedupedU);
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
            const pipelineResp = await withRetry(() => sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Pipeline!A6:DE5000",
            }));
            const pipelineRows = pipelineResp.data.values || [];

            const confirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Confirmed!A1:C5000",
            }));
            const confirmedRows = confirmedResp.data.values || [];

            for (const job of affectedJobs) {
              const checks = [];
              let allOk = true;
              let pipelineJob = null;    // hoisted so accessible at results.push
              let confirmedMatch = null; // hoisted so accessible at results.push

              if (expectCopied) {
                // CRITICAL CHECK: Pipeline col DD must be "Yes"
                // Pipeline data: col A(0)=Client, B(1)=JobName, C(2)=ProjectCode, DD(107)=CopiedToConf?
                // Pipeline rows start at row 6 in the sheet; our slice starts at A6 so index 0 = row 6
                const jobNameLower   = job.jobName.toLowerCase();
                const clientParsedLower = job.clientParsed ? job.clientParsed.toLowerCase() : "";

                // Primary: use the row number from the AutoLog (most reliable)
                if (job.pipelineRowFromLog) {
                  const prIdx = job.pipelineRowFromLog - 6; // Pipeline data starts at row 6, index 0 = row 6
                  const pr = prIdx >= 0 ? pipelineRows[prIdx] : null;
                  if (pr) {
                    const prJobName    = String(pr[1] || "").trim();
                    const prClientName = String(pr[0] || "").trim();
                    // When job name is blank or a placeholder "-", skip name validation and trust the row number
                    const jobNameIsBlank = !jobNameLower || jobNameLower === "-";
                    const jobNameMatches = jobNameIsBlank || prJobName.toLowerCase() === jobNameLower;
                    const clientNameMatches = !clientParsedLower || !prClientName ||
                      prClientName.toLowerCase().includes(clientParsedLower) ||
                      clientParsedLower.includes(prClientName.toLowerCase());
                    if (jobNameMatches && clientNameMatches) {
                      pipelineJob = {
                        clientName: prClientName,
                        jobName: prJobName,
                        projectCode: String(pr[2] || "").trim(),
                        copiedToConf: String(pr[107] || "").trim(),
                        rowNumber: job.pipelineRowFromLog,
                      };
                    } else {
                      console.log(`  ⚠️ Pipeline row ${job.pipelineRowFromLog} has "${prJobName}" / "${prClientName}" — expected "${job.jobName}" / "${job.clientParsed}". Row may have shifted — falling back to name search.`);
                    }
                  }
                }

                // Fallback: search by job name + client name (skipped when job name is blank/placeholder)
                if (!pipelineJob) {
                  const jobNameIsBlank = !jobNameLower || jobNameLower === "-";
                  for (let pri = 0; pri < pipelineRows.length; pri++) {
                    const pr = pipelineRows[pri];
                    const pJobName    = String(pr[1] || "").trim();
                    const pClientName = String(pr[0] || "").trim();
                    const pProjectCode = String(pr[2] || "").trim();
                    
                    if (job.projectCodeFromLog && pProjectCode.toLowerCase() === job.projectCodeFromLog.toLowerCase()) {
                      pipelineJob = {
                        clientName: pClientName,
                        jobName: pJobName,
                        projectCode: pProjectCode,
                        copiedToConf: String(pr[107] || "").trim(),
                        rowNumber: pri + 6,
                      };
                      break;
                    }
                    if (job.projectCodeFromLog) continue; // If looking strictly by code, don't fallback to name check for this iteration

                    // If job name is blank/placeholder, match on client name only (less reliable — only use as last resort)
                    if (!jobNameIsBlank && (!pJobName || pJobName.toLowerCase() !== jobNameLower)) continue;
                    if (jobNameIsBlank && clientParsedLower && pClientName && !pClientName.toLowerCase().includes(clientParsedLower) && !clientParsedLower.includes(pClientName.toLowerCase())) continue;
                    if (!jobNameIsBlank && clientParsedLower && pClientName && !pClientName.toLowerCase().includes(clientParsedLower) && !clientParsedLower.includes(pClientName.toLowerCase())) continue;
                    pipelineJob = {
                      clientName: pClientName,
                      jobName: pJobName,
                      projectCode: String(pr[2] || "").trim(),
                      copiedToConf: String(pr[107] || "").trim(),
                      rowNumber: pri + 6,
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
                  const pRowStr = pipelineJob.rowNumber ? ` (Pipeline row ${pipelineJob.rowNumber})` : "";
                  const cliStr = pipelineJob.clientName ? ` — ${pipelineJob.clientName}` : "";
                  checks.push({
                    ok: ddOk,
                    message: ddOk
                      ? `✓ Pipeline col DD ("Copied to confirmed?"): Yes${pRowStr}${cliStr}`
                      : `✗ CRITICAL: Pipeline col DD is "${pipelineJob.copiedToConf}" — expected Yes${pRowStr}${cliStr}. The copy may not have registered correctly.`,
                  });
                  if (!ddOk) allOk = false;
                }

                // Secondary check: job exists in Confirmed — search by project code first, then job+client name
                // Row numbers are unreliable (rows can shift), so we match on col C (project code) or cols A+B
                const pipelineProjectCode = pipelineJob?.projectCode || job.projectCodeFromLog || "";
                // Use the resolved client name from pipelineJob (more reliable than AutoLog-parsed clientParsed)
                const resolvedClientLower = (pipelineJob?.clientName || "").toLowerCase() || clientParsedLower;
                for (let cri = 0; cri < confirmedRows.length; cri++) {
                  const cr = confirmedRows[cri];
                  const crJobName     = String(cr[1] || "").trim();
                  const crClientName  = String(cr[0] || "").trim();
                  const crProjectCode = String(cr[2] || "").trim();
                  // Primary match: project code (most reliable, unique per job)
                  if (pipelineProjectCode && crProjectCode && crProjectCode.toLowerCase() === pipelineProjectCode.toLowerCase()) {
                    confirmedMatch = { jobName: crJobName, projectCode: crProjectCode, clientName: crClientName, rowNumber: cri + 1 };
                    break;
                  }
                  // Fallback: job name + client name (skip if job name is blank/placeholder)
                  const jobNameIsBlankConf = !jobNameLower || jobNameLower === "-";
                  if (jobNameIsBlankConf) continue; // can't match on blank name — project code is the only key
                  if (crJobName.toLowerCase() !== jobNameLower) continue;
                  // Use resolvedClientLower (from pipelineJob) for a more accurate client match
                  if (resolvedClientLower && crClientName && !crClientName.toLowerCase().includes(resolvedClientLower) && !resolvedClientLower.includes(crClientName.toLowerCase())) continue;
                  confirmedMatch = { jobName: crJobName, projectCode: crProjectCode, clientName: crClientName, rowNumber: cri + 1 };
                  break;
                }
                const confExists = confirmedMatch !== null;

                // Include client name and row numbers in check messages
                const pipelineRowStr = pipelineJob?.rowNumber ? ` (Pipeline row ${pipelineJob.rowNumber})` : "";
                const confirmedRowStr = confirmedMatch?.rowNumber ? ` (Confirmed row ${confirmedMatch.rowNumber})` : "";
                const clientStr = pipelineJob?.clientName ? ` — ${pipelineJob.clientName}` : "";

                checks.push({
                  ok: confExists,
                  message: confExists
                    ? `✓ Confirmed tab: "${confirmedMatch.jobName}"${confirmedMatch.projectCode ? ` (${confirmedMatch.projectCode})` : ""}${confirmedRowStr}${pipelineRowStr}${clientStr} found`
                    : pipelineProjectCode
                      ? `✗ Confirmed tab: job "${job.jobName}" not found by project code (${pipelineProjectCode}) or name — Confirmed col C may be blank for this job, or copy may have failed`
                      : `✗ Confirmed tab: job "${job.jobName}" not found — copy may have failed`,
                });
                if (!confExists) allOk = false;

              } else {
                // UNchecked: Pipeline DD should be No/blank, job should NOT be in Confirmed
                const jobNameLower = job.jobName ? job.jobName.toLowerCase() : "";
                const clientParsedLower = job.clientParsed ? job.clientParsed.toLowerCase() : "";
                const jobNameIsBlank = !jobNameLower || jobNameLower === "-";

                // Look up Pipeline row — use log row number first, then name search
                if (job.pipelineRowFromLog) {
                  const prIdx = job.pipelineRowFromLog - 6;
                  const pr = prIdx >= 0 ? pipelineRows[prIdx] : null;
                  if (pr) {
                    const prJobName = String(pr[1] || "").trim();
                    const prClientName = String(pr[0] || "").trim();
                    const nameOk = jobNameIsBlank || prJobName.toLowerCase() === jobNameLower;
                    const clientOk = !clientParsedLower || !prClientName ||
                      prClientName.toLowerCase().includes(clientParsedLower) ||
                      clientParsedLower.includes(prClientName.toLowerCase());
                    if (nameOk && clientOk) {
                      pipelineJob = {
                        copiedToConf: String(pr[107] || "").trim(),
                        rowNumber: job.pipelineRowFromLog,
                        clientName: prClientName,
                        jobName: prJobName,
                        projectCode: String(pr[2] || "").trim(),
                      };
                    }
                  }
                }
                if (!pipelineJob) {
                  for (let pri = 0; pri < pipelineRows.length; pri++) {
                    const pr = pipelineRows[pri];
                    const pJobName = String(pr[1] || "").trim();
                    const pClientName = String(pr[0] || "").trim();
                    if (!jobNameIsBlank && (!pJobName || pJobName.toLowerCase() !== jobNameLower)) continue;
                    if (clientParsedLower && pClientName &&
                      !pClientName.toLowerCase().includes(clientParsedLower) &&
                      !clientParsedLower.includes(pClientName.toLowerCase())) continue;
                    pipelineJob = {
                      copiedToConf: String(pr[107] || "").trim(),
                      rowNumber: pri + 6,
                      clientName: pClientName,
                      jobName: pJobName,
                      projectCode: String(pr[2] || "").trim(),
                    };
                    break;
                  }
                }

                if (pipelineJob) {
                  const ddVal = pipelineJob.copiedToConf.toLowerCase();
                  const ddOk = ddVal === "no" || ddVal === "" || ddVal === "false";
                  const pRowStr = pipelineJob.rowNumber ? ` (Pipeline row ${pipelineJob.rowNumber})` : "";
                  const cliStr = pipelineJob.clientName ? ` — ${pipelineJob.clientName}` : "";
                  checks.push({
                    ok: ddOk,
                    message: ddOk
                      ? `✓ Pipeline col DD: "${pipelineJob.copiedToConf || "blank"}" — No/blank (correct)${pRowStr}${cliStr}`
                      : `✗ CRITICAL: Pipeline col DD is "${pipelineJob.copiedToConf}" — expected No or blank${pRowStr}${cliStr}`,
                  });
                  if (!ddOk) allOk = false;
                } else {
                  checks.push({ ok: false, message: `✗ Job "${job.jobName}" not found in Pipeline tab` });
                  allOk = false;
                }

                // Check Confirmed — search by project code first, then job+client name
                const uncheckedProjectCode = pipelineJob?.projectCode || "";
                for (let cri = 0; cri < confirmedRows.length; cri++) {
                  const cr = confirmedRows[cri];
                  const crJobName    = String(cr[1] || "").trim();
                  const crClientName = String(cr[0] || "").trim();
                  const crProjectCode = String(cr[2] || "").trim();
                  if (uncheckedProjectCode && crProjectCode &&
                    crProjectCode.toLowerCase() === uncheckedProjectCode.toLowerCase()) {
                    confirmedMatch = { jobName: crJobName, projectCode: crProjectCode, clientName: crClientName, rowNumber: cri + 1 };
                    break;
                  }
                  if (!jobNameIsBlank && crJobName.toLowerCase() === jobNameLower) {
                    const clientOk = !clientParsedLower || !crClientName ||
                      crClientName.toLowerCase().includes(clientParsedLower) ||
                      clientParsedLower.includes(crClientName.toLowerCase());
                    if (clientOk) {
                      confirmedMatch = { jobName: crJobName, projectCode: crProjectCode, clientName: crClientName, rowNumber: cri + 1 };
                      break;
                    }
                  }
                }
                const inConfirmed = confirmedMatch !== null;
                const confRowStr = confirmedMatch?.rowNumber ? ` (Confirmed row ${confirmedMatch.rowNumber})` : "";
                const confCliStr = confirmedMatch?.clientName ? ` — ${confirmedMatch.clientName}` : "";
                checks.push({
                  ok: !inConfirmed,
                  message: !inConfirmed
                    ? `✓ Confirmed tab: job not present (correct)`
                    : `✗ "${confirmedMatch.jobName || job.jobName}"${confirmedMatch.projectCode ? ` (${confirmedMatch.projectCode})` : ""}${confRowStr}${confCliStr} still exists in Confirmed — should have been removed`,
                });
                if (inConfirmed) allOk = false;
              }

              results.push({
                jobName: (job.jobName && job.jobName !== "-") ? job.jobName
                  : pipelineJob?.jobName || confirmedMatch?.jobName || "-",
                projectCode: pipelineJob?.projectCode || confirmedMatch?.projectCode || "",
                clientName: job.clientParsed || pipelineJob?.clientName || confirmedMatch?.clientName || "",
                pipelineRow: pipelineJob?.rowNumber || null,
                confirmedRow: confirmedMatch?.rowNumber || null,
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
            return details.includes("Retainer") && details.includes("Added") &&
              (details.includes("child row") || details.includes("invoice rows"));
          });
          console.log(`  ✓ Found ${retainerLogEntries.length} retainer creation entries in window`);

          // If nothing found in window, fall back to full AutoLog (last 90 days)
          // This handles timing edge cases where the automation ran just before the window start
          const retainerLogEntriesToUse = retainerLogEntries.length > 0 ? retainerLogEntries :
            allAutoLogRows.filter(row => {
              const details = String(row[3] || "");
              return details.includes("Retainer") && details.includes("Added") &&
                (details.includes("child row") || details.includes("invoice rows"));
            });
          if (retainerLogEntries.length === 0 && retainerLogEntriesToUse.length > 0) {
            console.log(`  ↩ Fell back to full AutoLog — found ${retainerLogEntriesToUse.length} entries`);
          }
          for (const entry of retainerLogEntriesToUse) {
            console.log(`    [${entry[0]}] Details="${String(entry[3]||"").slice(0, 400)}"`);
          }

          if (retainerLogEntriesToUse.length === 0) {
            results.push({
              status: "info",
              message: `No retainer invoice creation entries found in AutoLog since flag was last cleared. If invoices were recently created, click Re-run to refresh.`,
            });
          } else {
            // Parse all entries in the window
            const affectedRetainerJobs = [];
            for (const entry of retainerLogEntriesToUse) {
              const details = String(entry[3] || "");

              // Format A (new): "[Retainers - Confirmed] Added N child row(s) (Parent Row: N) for CLIENT | JOB"
              //                 "[Retainers - Pipeline] Added N child row(s) (Parent Row: N) for CLIENT | JOB"
              const newPattern = /\[Retainers\s*-\s*(Confirmed|Pipeline)\]\s*Added\s+(\d+)\s+child\s+rows?\(s?\)\s*\(Parent\s+Row:\s*(\d+)\)\s+for\s+([^|]+)\s*\|\s*([^\[\n]+)/gi;
              let m;
              while ((m = newPattern.exec(details)) !== null) {
                affectedRetainerJobs.push({
                  tab:               m[1].trim(),   // "Confirmed" or "Pipeline"
                  childRowsCreated:  parseInt(m[2], 10),
                  logSheetRow:       parseInt(m[3], 10),
                  clientNameFromLog: m[4].trim(),
                  jobName:           m[5].trim(),
                  logTimestamp:      String(entry[0] || "")
                });
              }

              // Format B (old): "Row N, ClientName, JobName: Added N invoice rows"
              if (affectedRetainerJobs.length === 0) {
                const oldPattern = /Row\s+(\d+),\s+([^,]+),\s+([^:]+):\s+Added\s+\d+\s+invoice rows/gi;
                while ((m = oldPattern.exec(details)) !== null) {
                  affectedRetainerJobs.push({
                    logSheetRow: parseInt(m[1], 10),
                    clientNameFromLog: m[2].trim(),
                    jobName: m[3].trim(),
                    logTimestamp: String(entry[0] || "")
                  });
                }
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
            const retConfirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Confirmed!A1:BH5000",
            }));
            const retConfirmedRows = retConfirmedResp.data.values || [];

            const retPipelineResp = await withRetry(() => sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Pipeline!A6:BH5000",
            }));
            const retPipelineRows = retPipelineResp.data.values || [];

            const retainerChecks = [];

            for (const job of dedupedJobs) {
              const targetTab   = job.tab || "Confirmed"; // default to Confirmed for old-format entries
              const tabRows     = targetTab === "Pipeline" ? retPipelineRows : retConfirmedRows;
              const tabStartRow = targetTab === "Pipeline" ? 6 : 1; // Pipeline data starts at row 6

              // Find the parent row by matching client name AND job name.
              // If the AutoLog has a row number, try that first (most reliable).
              // If multiple rows match the same client+job name, warn rather than
              // silently picking the wrong one.
              const jobNameLower = job.jobName.toLowerCase();
              const clientLower  = job.clientNameFromLog.toLowerCase();
              let parentRowIdx   = -1;
              const allMatchingIdxs = [];

              // First try: use row number from AutoLog if available
              if (job.logSheetRow) {
                const logIdx = job.logSheetRow - tabStartRow;
                if (logIdx >= 0 && logIdx < tabRows.length) {
                  const r = tabRows[logIdx];
                  const rClient = String(r[0] || "").trim().toLowerCase();
                  const rJob    = String(r[1] || "").trim().toLowerCase();
                  if (rClient === clientLower && rJob === jobNameLower) {
                    parentRowIdx = logIdx;
                    console.log(`  ✓ Matched by row number: ${job.logSheetRow}`);
                  } else {
                    console.log(`  ⚠ Row ${job.logSheetRow} has "${r[1]}"/"${r[0]}" — expected "${job.jobName}"/"${job.clientNameFromLog}" — row may have shifted, falling back to name search`);
                  }
                }
              }

              // Second: name search — collect ALL matches to detect duplicates
              if (parentRowIdx === -1) {
                for (let ri = 0; ri < tabRows.length; ri++) {
                  const r       = tabRows[ri];
                  const rClient = String(r[0] || "").trim().toLowerCase();
                  const rJob    = String(r[1] || "").trim().toLowerCase();
                  const hasRevenue = !!(r[32]);
                  if (rClient === clientLower && rJob === jobNameLower && hasRevenue) {
                    allMatchingIdxs.push(ri);
                  }
                }
                if (allMatchingIdxs.length === 1) {
                  parentRowIdx = allMatchingIdxs[0];
                } else if (allMatchingIdxs.length > 1) {
                  retainerChecks.push({
                    jobName:    job.jobName,
                    clientName: job.clientNameFromLog,
                    status:     "issue",
                    checks:     [{
                      ok: false,
                      message: `✗ Found ${allMatchingIdxs.length} rows matching "${job.clientNameFromLog} | ${job.jobName}" in ${targetTab} (rows ${allMatchingIdxs.map(i => i + tabStartRow).join(", ")}) — cannot reliably identify which row the automation acted on. Ensure jobs have unique names within the same client.`,
                    }],
                  });
                  continue;
                }
              }

              if (parentRowIdx === -1) {
                // Not found in target tab — check the other tab as fallback
                const fallbackTab  = targetTab === "Pipeline" ? "Confirmed" : "Pipeline";
                const fallbackRows = targetTab === "Pipeline" ? retConfirmedRows : retPipelineRows;
                let fallbackIdx    = -1;
                for (let ri = 0; ri < fallbackRows.length; ri++) {
                  const r       = fallbackRows[ri];
                  const rClient = String(r[0] || "").trim().toLowerCase();
                  const rJob    = String(r[1] || "").trim().toLowerCase();
                  if (rClient === clientLower && rJob === jobNameLower) {
                    fallbackIdx = ri;
                    break;
                  }
                }
                if (fallbackIdx !== -1) {
                  const fallbackStartRow = fallbackTab === "Pipeline" ? 6 : 1;
                  retainerChecks.push({
                    jobName:    job.jobName,
                    clientName: job.clientNameFromLog,
                    status:     "info",
                    checks:     [{ ok: true, message: `✓ Job "${job.jobName}" (${job.clientNameFromLog}) moved to ${fallbackTab} tab (row ${fallbackIdx + fallbackStartRow}) — originally created in ${targetTab}` }],
                  });
                } else {
                  retainerChecks.push({
                    jobName:    job.jobName,
                    clientName: job.clientNameFromLog,
                    status:     "issue",
                    checks:     [{ ok: false, message: `✗ Job "${job.jobName}" (${job.clientNameFromLog}) not found in ${targetTab} or ${targetTab === "Pipeline" ? "Confirmed" : "Pipeline"} tabs` }],
                  });
                }
                continue;
              }

              const parentRow    = tabRows[parentRowIdx];
              const clientN      = String(parentRow[0] || "").trim();
              const jobName      = String(parentRow[1] || "").trim();
              const projectCode  = String(parentRow[2] || "").trim();
              const revenue      = parentRow[32];
              const startRaw     = parentRow[37];
              const endRaw       = parentRow[38];
              const confirmedSheetRow = parentRowIdx + tabStartRow;
              console.log(`  Found "${jobName}" (${clientN}) at ${targetTab} row ${confirmedSheetRow}: start="${startRaw}", end="${endRaw}"`);

              // Collect child rows — same tab, immediately after parent
              // Child row: same client+job, no revenue, no start date
              const childRows = [];
              let ci = parentRowIdx + 1;
              while (ci < tabRows.length) {
                const next    = tabRows[ci] || [];
                const nClient = String(next[0] || "").trim().toLowerCase();
                const nJob    = String(next[1] || "").trim().toLowerCase();
                if (nClient !== clientLower || nJob !== jobNameLower) break;
                if (next[32] || next[37] || next[38]) break; // has revenue/start/end = another parent
                childRows.push({ row: next, sheetRow: ci + tabStartRow });
                ci++;
              }

              const monthlyRevenue = parseFloat(String(revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
              const parseDate = (v) => {
                if (!v) return null;
                if (v instanceof Date) {
                  if (isNaN(v.getTime())) return null;
                  // JS Date treats 2-digit years as 1900s — correct to 2000s for years < 100
                  if (v.getFullYear() < 100) v.setFullYear(v.getFullYear() + 2000);
                  return v;
                }
                // Handle DD-Mon-YY or DD-Mon-YYYY strings e.g. "31-Jul-50", "1-May-2026"
                const monMap = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
                const monMatch = String(v).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
                if (monMatch) {
                  const yr = monMatch[3].length === 2 ? 2000 + parseInt(monMatch[3], 10) : parseInt(monMatch[3], 10);
                  return new Date(yr, monMap[monMatch[2]], parseInt(monMatch[1], 10));
                }
                const d = new Date(v);
                if (!isNaN(d.getTime())) {
                  if (d.getFullYear() < 100) d.setFullYear(d.getFullYear() + 2000);
                  return d;
                }
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

              // ── Single-row retainer check ────────────────────────────────────
              let isSingleMonth = false;
              if (startDate && endDate) {
                const diffTime = endDate.getTime() - startDate.getTime();
                const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
                const monthsDiff = Math.max(1, Math.round(diffDays / 30.4375));
                isSingleMonth = (monthsDiff === 1);
              }

              const parentInvAmt = parseFloat(String(parentRow[41] || "").replace(/[£$€,\s]/g, "")) || 0;
              const parentInvRef = String(parentRow[42] || "").trim();
              
              if (childRows.length === 0 && (parentInvAmt > 0 || parentInvRef)) {
                if (isSingleMonth) {
                  const hasInvoice = parentInvAmt > 0;
                  const fmt = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
                  checks.push({ ok: true, message: `Duration: ${fmt(startDate)} → ${fmt(endDate)} (1 month total, single invoice)` });
                  checks.push({ ok: true, message: `Single-row retainer (1-month exception) — invoice sits on parent row, no child rows expected` });
                  if (hasInvoice) {
                    checks.push({ ok: true, message: `✓ Parent row slot 1 has invoice amount £${parentInvAmt.toFixed(2)}${parentInvRef ? ` (ref: ${parentInvRef})` : ""}` });
                  } else {
                    checks.push({ ok: false, message: `✗ Parent row slot 1 has no invoice amount — invoice not yet created` });
                  }
                  retainerChecks.push({
                    jobName, clientName: clientN, projectCode,
                    parentSheetRow: confirmedSheetRow,
                    tab: targetTab,
                    status: hasInvoice ? "ok" : "issue",
                    periodLabel: "single invoice", checks,
                  });
                  continue;
                } else {
                  checks.push({ ok: false, message: `✗ Parent row has an invoice (amount/ref) but no child rows exist — single-row retainers are not allowed for multi-month jobs` });
                }
              }

              // Count child rows whose scheduled invoice date (Inv1 sent-date slot) falls
              // in or before the current calendar month — these are "past + current" rows.
              // Expected = that count + 18 future rows (adjusted for period frequency).
              const parseConfirmedDate = (val) => {
                if (!val) return null;
                if (val instanceof Date) return val;
                const s = String(val).trim();
                // Handle DD-Mon-YY format e.g. "1-Apr-26"
                const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
                if (m) {
                  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
                  const yr = 2000 + parseInt(m[3], 10);
                  return new Date(yr, months[m[2]], parseInt(m[1], 10));
                }
                const d = new Date(val);
                return isNaN(d.getTime()) ? null : d;
              };

              const today = new Date();
              const endOfCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
              endOfCurrentMonth.setHours(23, 59, 59, 999);

              const pastAndCurrentRows = childRows.filter(({ row: cr }) => {
                const sentDate = parseConfirmedDate(cr[43]); // AR = Inv1 sent date
                return sentDate && sentDate <= endOfCurrentMonth;
              }).length;

              const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
              const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
              const monthsDiff = Math.max(1, Math.round(diffDays / 30.4375));

              const totalPeriods = Math.ceil(monthsDiff / periodMonths);
              const futurePeriodsInContract = Math.max(0, totalPeriods - pastAndCurrentRows);
              const futureRows = Math.min(18 / periodMonths, futurePeriodsInContract);
              const expectedChildRows = pastAndCurrentRows + futureRows;

              const actualChildRows = childRows.length;
              const fmt = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
              const durationOk = actualChildRows >= expectedChildRows;
              checks.push({ ok: true, message: `Duration: ${fmt(startDate)} → ${fmt(endDate)} (${monthsDiff} months total, ${periodLabel})` });
              checks.push({
                ok: durationOk,
                message: `Child rows: ${actualChildRows} found, ${expectedChildRows} expected (${pastAndCurrentRows} past/current + ${futureRows} forward) — ` + (durationOk ? "✓ full coverage" : `✗ ${expectedChildRows - actualChildRows} row(s) missing`),
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
                tab: targetTab,
                status: durationOk && allHaveInvoice ? "ok" : "issue",
                periodLabel, checks,
              });
            }

            results.push(...retainerChecks);
          }

        } else if (flagType === "retainerInvoicesDeleted") {

          // Find AutoLog entries where retainer child rows were trimmed
          const deletedLogEntries = autoLogRows.filter(row => {
            const details = String(row[3] || "");
            return details.includes("Retainer") && details.includes("Trimmed") &&
              (details.includes("child row") || details.includes("excess"));
          });
          console.log(`  ✓ Found ${deletedLogEntries.length} retainer deletion entries in window`);

          // Fall back to full AutoLog if nothing found in window
          const deletedLogEntriesToUse = deletedLogEntries.length > 0 ? deletedLogEntries :
            allAutoLogRows.filter(row => {
              const details = String(row[3] || "");
              return details.includes("Retainer") && details.includes("Trimmed") &&
                (details.includes("child row") || details.includes("excess"));
            });
          if (deletedLogEntries.length === 0 && deletedLogEntriesToUse.length > 0) {
            console.log(`  ↩ Fell back to full AutoLog — found ${deletedLogEntriesToUse.length} entries`);
          }
          for (const entry of deletedLogEntriesToUse) {
            console.log(`    [${entry[0]}] Details="${String(entry[3]||"").slice(0, 400)}"`);
          }

          if (deletedLogEntriesToUse.length === 0) {
            results.push({
              status: "info",
              message: `No retainer invoice deletion entries found in AutoLog since flag was last cleared. If invoices were recently deleted, click Re-run to refresh.`,
            });
          } else {
            const affectedRetainerJobs = [];
            for (const entry of deletedLogEntriesToUse) {
              const details = String(entry[3] || "");
              // Format: "[Retainers] Trimmed N excess child row(s) (Parent Row: N) for CLIENT | JOB"
              const pattern = /Trimmed\s+\d+\s+excess\s+child\s+rows?\(s?\)(?:\s*\(Parent\s+Row:\s*\d+\))?\s*for\s+([^|]+)\s*\|\s*([^\[\n]+)/gi;
              let m;
              while ((m = pattern.exec(details)) !== null) {
                affectedRetainerJobs.push({
                  clientNameFromLog: m[1].trim(),
                  jobName: m[2].trim(),
                  logTimestamp: String(entry[0] || "")
                });
              }
            }

            // Deduplicate by client + job
            const seenJobs = new Set();
            const dedupedJobs = affectedRetainerJobs.filter(j => {
              const key = `${j.clientNameFromLog}|||${j.jobName}`;
              if (seenJobs.has(key)) return false;
              seenJobs.add(key);
              return true;
            });
            console.log(`  ✓ Parsed ${dedupedJobs.length} affected retainer jobs: ${JSON.stringify(dedupedJobs)}`);

            // Read Confirmed tab
            const delConfirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Confirmed!A1:BH5000",
            }));
            const delConfirmedRows = delConfirmedResp.data.values || [];
            const retainerChecks = [];

            for (const job of dedupedJobs) {
              const jobNameLower = job.jobName.toLowerCase();
              const clientLower  = job.clientNameFromLog.toLowerCase();

              // Find parent row by client + job name
              let parentRowIdx = -1;
              for (let ri = 0; ri < delConfirmedRows.length; ri++) {
                const r = delConfirmedRows[ri];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob    = String(r[1] || "").trim().toLowerCase();
                if (rClient === clientLower && rJob === jobNameLower) {
                  parentRowIdx = ri;
                  break;
                }
              }

              if (parentRowIdx === -1) {
                retainerChecks.push({
                  jobName: job.jobName,
                  clientName: job.clientNameFromLog,
                  status: "issue",
                  message: `✗ Job "${job.jobName}" (${job.clientNameFromLog}) not found in Confirmed tab`,
                  checks: [],
                });
                continue;
              }

              const parentRow    = delConfirmedRows[parentRowIdx];
              const parentSheetRow = parentRowIdx + 1;
              const jobClient    = String(parentRow[0] || "").trim();
              const jobName2     = String(parentRow[1] || "").trim();
              const projectCode  = String(parentRow[2] || "").trim();
              const monthlyRevenue = parseFloat(String(parentRow[32] || "0").replace(/[£$€,\s]/g, "")) || 0;
              const jobStart     = String(parentRow[37] || "").trim();
              const jobEnd       = String(parentRow[38] || "").trim();

              console.log(`  Found "${job.jobName}" (${job.clientNameFromLog}) at Confirmed row ${parentSheetRow}: start="${jobStart}", end="${jobEnd}"`);

              // Collect child rows (same client + job, no revenue/start/end)
              const childRows = [];
              for (let ri = parentRowIdx + 1; ri < delConfirmedRows.length; ri++) {
                const r = delConfirmedRows[ri];
                const rClient = String(r[0] || "").trim().toLowerCase();
                const rJob    = String(r[1] || "").trim().toLowerCase();
                if (rClient !== clientLower || rJob !== jobNameLower) break;
                if (r[32] || r[37] || r[38]) break; // has revenue/start/end = another parent
                childRows.push({ row: r, sheetRow: ri + 1 });
              }

              const checks = [];

              // Parse dates
              const parseDate = (s) => {
                if (!s) return null;
                const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
                const m2 = String(s).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
                if (m2) {
                  const yr = m2[3].length === 2 ? 2000 + parseInt(m2[3], 10) : parseInt(m2[3], 10);
                  return new Date(yr, months[m2[2]], parseInt(m2[1], 10));
                }
                if (s instanceof Date) {
                  if (isNaN(s.getTime())) return null;
                  if (s.getFullYear() < 100) s.setFullYear(s.getFullYear() + 2000);
                  return s;
                }
                const d = new Date(s);
                if (!isNaN(d.getTime())) {
                  if (d.getFullYear() < 100) d.setFullYear(d.getFullYear() + 2000);
                  return d;
                }
                return null;
              };

              const startDate = parseDate(jobStart);
              const endDate   = parseDate(jobEnd);

              if (!startDate || !endDate) {
                retainerChecks.push({
                  jobName: jobName2, clientName: jobClient, projectCode,
                  parentSheetRow, status: "info",
                  message: `No start/end dates set on this retainer — cannot verify row coverage`,
                  checks: [],
                });
                continue;
              }

              // Determine period (monthly by default, infer from child row amounts)
              let periodMonths = 1;
              let periodLabel  = "monthly";
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

              const parentInvAmt2 = parseFloat(String(parentRow[41] || "").replace(/[£$€,\s]/g, "")) || 0;

              // Rolling 18-month runway: count rows with scheduled date ≤ end of current month
              const parseConfDate = (val) => {
                if (!val) return null;
                if (val instanceof Date) return val;
                const s2 = String(val).trim();
                const months2 = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
                const m3 = s2.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
                if (m3) return new Date(2000 + parseInt(m3[3],10), months2[m3[2]], parseInt(m3[1],10));
                const d = new Date(val); return isNaN(d.getTime()) ? null : d;
              };
              const today2 = new Date();
              const endOfCurrentMonth = new Date(today2.getFullYear(), today2.getMonth() + 1, 0);
              endOfCurrentMonth.setHours(23, 59, 59, 999);
              const pastAndCurrentRows = childRows.filter(({ row: cr }) => {
                const sentDate = parseConfDate(cr[43]);
                return sentDate && sentDate <= endOfCurrentMonth;
              }).length;
              const diffTime2 = Math.abs(endDate.getTime() - startDate.getTime());
              const diffDays2 = Math.round(diffTime2 / (1000 * 60 * 60 * 24));
              const monthsDiff = Math.max(1, Math.round(diffDays2 / 30.4375));
              
              const totalPeriods = Math.ceil(monthsDiff / periodMonths);
              const futurePeriodsInContract = Math.max(0, totalPeriods - pastAndCurrentRows);
              const futureRows = Math.min(18 / periodMonths, futurePeriodsInContract);
              const expectedChildRows = pastAndCurrentRows + futureRows;
              
              const actualChildRows   = childRows.length;
              const fmt = (d) => d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });

              const durationOk = actualChildRows === expectedChildRows;
              checks.push({ ok: true, message: `Duration: ${fmt(startDate)} → ${fmt(endDate)} (${monthsDiff} months total, ${periodLabel})` });
              checks.push({
                ok: durationOk,
                message: durationOk
                  ? `✓ Child rows: ${actualChildRows} found, ${expectedChildRows} expected (${pastAndCurrentRows} past/current + ${futureRows} forward) — correct count`
                  : `${actualChildRows > expectedChildRows ? "✗ Too many" : "✗ Too few"} child rows: ${actualChildRows} found, ${expectedChildRows} expected (${pastAndCurrentRows} past/current + ${futureRows} forward)`,
              });

              retainerChecks.push({
                jobName: jobName2, clientName: jobClient, projectCode,
                parentSheetRow, status: durationOk ? "ok" : "issue",
                periodLabel, checks,
              });
            }

            results.push(...retainerChecks);
          }

        } // end retainerInvoicesDeleted

        // ── invoiceStaleUnsentChanges ──────────────────────────────────────
        // Parse AutoLog entries where GAS moved stale unsent invoice dates.
        // Format: "[Confirmed] Stale Invoice - Row N, CLIENT | JOB, Slot N: Date moved X -> Y"
        // Returns one result per stale invoice entry found in the window.
        if (flagType === "invoiceStaleUnsentChanges") {

          const staleLogEntries = autoLogRows.filter(row => {
            const details = String(row[3] || "");
            return details.includes("Stale Invoice");
          });
          console.log(`  ✓ Found ${staleLogEntries.length} stale invoice entries in window`);

          // Fall back to full AutoLog if nothing found in window
          const staleEntriesToUse = staleLogEntries.length > 0 ? staleLogEntries :
            allAutoLogRows.filter(row => String(row[3] || "").includes("Stale Invoice"));
          if (staleLogEntries.length === 0 && staleEntriesToUse.length > 0) {
            console.log(`  ↩ Fell back to full AutoLog — found ${staleEntriesToUse.length} stale entries`);
          }

          if (staleEntriesToUse.length === 0) {
            results.push({
              status: "info",
              message: "No stale invoice entries found in AutoLog since flag was last cleared.",
            });
          } else {
            // Read Confirmed tab for live sheet verification
            const confirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Confirmed!A1:CR5000",
            }));
            const confirmedRows = confirmedResp.data.values || [];

            // Each AutoLog row may contain multiple stale invoice lines in col D (details)
            // Parse each line of the form:
            // "[Confirmed] Stale Invoice - Row N, CLIENT | JOB, Slot N: Date moved DD-Mon-YY -> DD-Mon-YY"
            const stalePattern = /\[([^\]]+)\]\s*Stale Invoice\s*[-–]\s*Row\s*(\d+),\s*([^|]+)\|\s*([^,\n]+),\s*Slot\s*(\d+):\s*Date moved\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+)/gi;

            for (const entry of staleEntriesToUse) {
              const details = String(entry[3] || "");
              const timestamp = String(entry[0] || "");
              let match;
              while ((match = stalePattern.exec(details)) !== null) {
                if (targetLine) {
                  const normMatch = match[0].replace(/\s+/g, " ").trim();
                  const normTarget = targetLine.replace(/\s+/g, " ").trim();
                  if (!normMatch.includes(normTarget) && !normTarget.includes(normMatch)) continue;
                }
                
                const tab       = match[1].trim();   // "Confirmed"
                const rowNum    = parseInt(match[2].trim(), 10);
                const jobClient = match[3].trim();
                const jobName   = match[4].trim();
                const slotNum   = parseInt(match[5].trim(), 10);
                const oldDate   = match[6].trim();
                const newDate   = match[7].trim();
                
                let isResolved = false;
                let resolutionMsg = "Slot is empty or contains a placeholder.";
                const checks = [];
                let targetSheetRow = null;
                let actualRowNum = rowNum;

                // 1. Try original row
                if (tab === "Confirmed" && rowNum > 0 && rowNum <= confirmedRows.length) {
                  const r = confirmedRows[rowNum - 1] || [];
                  if (String(r[0]||"").trim().toLowerCase() === jobClient.toLowerCase() && 
                      String(r[1]||"").trim().toLowerCase() === jobName.toLowerCase()) {
                    targetSheetRow = r;
                  }
                }

                // 2. Fallback search (job moved)
                if (!targetSheetRow && tab === "Confirmed") {
                  const matchingRows = [];
                  for (let i = 0; i < confirmedRows.length; i++) {
                    const r = confirmedRows[i] || [];
                    if (String(r[0]||"").trim().toLowerCase() === jobClient.toLowerCase() && 
                        String(r[1]||"").trim().toLowerCase() === jobName.toLowerCase()) {
                      matchingRows.push({ row: r, index: i + 1 });
                    }
                  }
                  
                  if (matchingRows.length === 1) {
                    targetSheetRow = matchingRows[0].row;
                    actualRowNum = matchingRows[0].index;
                  } else if (matchingRows.length > 1) {
                    // For multi-row retainers, find the specific child row by checking the date
                    const slotCols = { 1: { sent: 43 }, 2: { sent: 50 }, 3: { sent: 57 } }[slotNum];
                    let found = false;
                    if (slotCols) {
                      const dateMatch = matchingRows.find(m => {
                        const d = String(m.row[slotCols.sent] || "").trim();
                        return d === oldDate || d === newDate;
                      });
                      if (dateMatch) {
                        targetSheetRow = dateMatch.row;
                        actualRowNum = dateMatch.index;
                        found = true;
                      }
                    }
                    if (!found) {
                      targetSheetRow = matchingRows[0].row;
                      actualRowNum = matchingRows[0].index;
                    }
                  }
                }

                if (targetSheetRow) {
                  const slotCols = {
                    1: { ref: 42, sent: 43, status: 45, amt: 41 },
                    2: { ref: 49, sent: 50, status: 52, amt: 48 },
                    3: { ref: 56, sent: 57, status: 59, amt: 55 },
                  }[slotNum];

                  if (slotCols) {
                    const currentRef = String(targetSheetRow[slotCols.ref] || "").trim();
                    const currentSent = String(targetSheetRow[slotCols.sent] || "").trim();
                    const currentStatus = String(targetSheetRow[slotCols.status] || "").trim();
                    const currentAmt = String(targetSheetRow[slotCols.amt] || "").trim();

                    if (currentRef && !currentRef.toUpperCase().startsWith("MANUAL-INV")) {
                      isResolved = true;
                      resolutionMsg = `Slot ${slotNum} now contains a real invoice: #${currentRef} (Sent: ${currentSent || "unknown"}, Status: ${currentStatus || "unknown"}).`;
                      checks.push({ ok: true, message: `✓ Resolved: ${resolutionMsg}` });
                    } else if (!currentRef && !currentAmt) {
                      isResolved = true;
                      resolutionMsg = `Slot ${slotNum} is now completely empty (stale placeholder was removed).`;
                      checks.push({ ok: true, message: `✓ Resolved: ${resolutionMsg}` });
                      
                      const otherInvoices = [];
                      [ { s: 1, ref: 42 }, { s: 2, ref: 49 }, { s: 3, ref: 56 } ].forEach(idx => {
                        if (idx.s !== slotNum) {
                          const r = String(targetSheetRow[idx.ref] || "").trim();
                          if (r && !r.toUpperCase().startsWith("MANUAL-INV")) {
                            otherInvoices.push(`Slot ${idx.s} (#${r})`);
                          }
                        }
                      });
                      if (otherInvoices.length > 0) {
                        checks.push({ ok: true, message: `ℹ️ Note: Real invoice(s) found in ${otherInvoices.join(" and ")}.` });
                      }
                    } else {
                      checks.push({ ok: false, message: `✗ Slot ${slotNum} still contains a placeholder (Ref: ${currentRef || "(blank)"}, Amount: ${currentAmt || "(blank)"}).` });
                    }
                  } else {
                    checks.push({ ok: false, message: `✗ Invalid slot number parsed from log: ${slotNum}` });
                  }

                  if (actualRowNum !== rowNum) {
                    checks.push({ ok: true, message: `ℹ️ Job safely located at row ${actualRowNum} (moved from original row ${rowNum})` });
                  }
                } else {
                   checks.push({ ok: false, message: `✗ Could not locate job "${jobClient} | ${jobName}" anywhere in the Confirmed tab.` });
                }

                results.push({
                  status: isResolved ? "ok" : "issue",
                  stale: true,
                  tab,
                  rowNum: actualRowNum,
                  jobClient,
                  jobName,
                  slotNum: slotNum,
                  oldDate,
                  newDate,
                  logTimestamp: timestamp,
                  checks,
                  message: isResolved 
                    ? `[${tab}] Row ${actualRowNum} — ${jobClient} | ${jobName}, Slot ${slotNum}: Alert resolved.`
                    : `[${tab}] Row ${actualRowNum} — ${jobClient} | ${jobName}, Slot ${slotNum}: date moved ${oldDate} → ${newDate}.`,
                });
              }
            }

            if (results.length === 0) {
              results.push({
                status: "info",
                message: "Stale invoice entries found in AutoLog but could not be parsed. Check the AutoLog tab manually.",
              });
            } else {
              console.log(`  ✓ Parsed ${results.length} stale invoice entries`);
            }
          }

        } // end invoiceStaleUnsentChanges

        // ── expenseAdded ───────────────────────────────────────────────────
        else if (flagType === "expenseAdded") {
          const addedLogEntries = autoLogRows.filter(row => String(row[3] || "").includes("Created New Row:"));
          const entriesToUse = addedLogEntries.length > 0 ? addedLogEntries : allAutoLogRows.filter(row => String(row[3] || "").includes("Created New Row:"));

          if (entriesToUse.length === 0) {
            results.push({ status: "info", message: "No expense added entries found in AutoLog." });
          } else {
            const outgoingsResp = await withRetry(() => sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Outgoings!A13:A110",
            }));
            const outgoingsVendors = (outgoingsResp.data.values || []).map(r => String(r[0] || "").trim().toLowerCase());

            // Regex matches: [Outgoings] Created New Row: {Vendor Name} (£{Amount})
            const pattern = /\[Outgoings\] Created New Row:\s+(.+?)\s+\(£([0-9.,]+)\)/gi;

            for (const entry of entriesToUse) {
              const details = String(entry[3] || "");
              const timestamp = String(entry[0] || "");
              let match;
              while ((match = pattern.exec(details)) !== null) {
                if (targetLine) {
                  const normMatch = match[0].replace(/\s+/g, " ").trim();
                  const normTarget = targetLine.replace(/\s+/g, " ").trim();
                  if (!normMatch.includes(normTarget) && !normTarget.includes(normMatch)) continue;
                }

                const desc = match[1].trim();
                const amt = match[2].trim();
                const descLower = desc.toLowerCase();

                const isStillPresent = outgoingsVendors.includes(descLower);
                const isResolved = !isStillPresent;

                results.push({
                  status: isResolved ? "ok" : "issue",
                  logTimestamp: timestamp,
                  checks: [
                    {
                      ok: isResolved,
                      message: isResolved
                        ? `✓ Resolved: The vendor "${desc}" is no longer present in the Outgoings tab (Rows 13-110).`
                        : `✗ Issue: The vendor "${desc}" is still present in the Outgoings tab.`
                    }
                  ],
                  message: isResolved 
                    ? `Vendor "${desc}" no longer exists in Outgoings.` 
                    : `Vendor "${desc}" remains in Outgoings.`
                });
              }
            }
          }

        } // end expenseAdded

        // ── expenseUnreconGaps ─────────────────────────────────────────────
        else if (flagType === "expenseUnreconGaps") {
          const gapEntries = autoLogRows.filter(row => {
            const d = String(row[3] || "");
            return d.includes("Created Manual Gap:") || d.includes("Changed Manual Gap:") || d.includes("Removed Manual Gap:");
          });
          const entriesToUse = gapEntries.length > 0 ? gapEntries : allAutoLogRows.filter(row => {
            const d = String(row[3] || "");
            return d.includes("Created Manual Gap:") || d.includes("Changed Manual Gap:") || d.includes("Removed Manual Gap:");
          });

          if (entriesToUse.length === 0) {
            results.push({ status: "info", message: "No expense gap entries found in AutoLog." });
          } else {
            const confirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetIdClean,
              range: "Confirmed!A1:CR5000",
            }));
            const confirmedRows = confirmedResp.data.values || [];

            // Matches: [Confirmed] Created Manual Gap: Row {N}, {Client} | {Job} (Slot {N}) - ...
            const pattern = /\[(Confirmed|Pipeline)\] (?:Created|Changed|Removed) Manual Gap:\s*Row\s*(\d+),\s*([^|]+)\|\s*([^(]+)\(Slot\s*(\d+)\)/gi;

            for (const entry of entriesToUse) {
              const details = String(entry[3] || "");
              const timestamp = String(entry[0] || "");
              let match;
              while ((match = pattern.exec(details)) !== null) {
                if (targetLine) {
                  const normMatch = match[0].replace(/\s+/g, " ").trim();
                  const normTarget = targetLine.replace(/\s+/g, " ").trim();
                  if (!normMatch.includes(normTarget) && !normTarget.includes(normMatch)) continue;
                }

                const tab = match[1].trim();
                const rowNum = parseInt(match[2].trim(), 10);
                const jobClient = match[3].trim();
                const jobName = match[4].trim();
                const slotNum = parseInt(match[5].trim(), 10);

                let isResolved = false;
                let resolutionMsg = "Slot is empty or contains a placeholder.";
                const checks = [];
                let targetSheetRow = null;
                let actualRowNum = rowNum;

                // 1. Try original row
                if (tab === "Confirmed" && rowNum > 0 && rowNum <= confirmedRows.length) {
                  const r = confirmedRows[rowNum - 1] || [];
                  if (String(r[0]||"").trim().toLowerCase() === jobClient.toLowerCase() && 
                      String(r[1]||"").trim().toLowerCase() === jobName.toLowerCase()) {
                    targetSheetRow = r;
                  }
                }

                // 2. Fallback search (job moved)
                if (!targetSheetRow && tab === "Confirmed") {
                  const matchingRows = [];
                  for (let i = 0; i < confirmedRows.length; i++) {
                    const r = confirmedRows[i] || [];
                    if (String(r[0]||"").trim().toLowerCase() === jobClient.toLowerCase() && 
                        String(r[1]||"").trim().toLowerCase() === jobName.toLowerCase()) {
                      matchingRows.push({ row: r, index: i + 1 });
                    }
                  }
                  if (matchingRows.length > 0) {
                    targetSheetRow = matchingRows[0].row;
                    actualRowNum = matchingRows[0].index;
                  }
                }

                if (targetSheetRow) {
                  const slotCols = {
                    1: { id: 81, amt: 76 }, // CD (81), BY (76)
                    2: { id: 88, amt: 83 }, // CK (88), CF (83)
                    3: { id: 95, amt: 90 }, // CR (95), CM (90)
                  }[slotNum];

                  if (slotCols) {
                    const currentId = String(targetSheetRow[slotCols.id] || "").trim();
                    const currentAmt = String(targetSheetRow[slotCols.amt] || "").trim();

                    if (currentId && !currentId.toUpperCase().startsWith("MANUAL-ENTRY") && !currentId.toUpperCase().startsWith("UNRECON-GAP")) {
                      isResolved = true;
                      resolutionMsg = `Slot ${slotNum} now contains a real expense reference (App ID: ${currentId}).`;
                      checks.push({ ok: true, message: `✓ Resolved: ${resolutionMsg}` });
                    } else if (!currentId && !currentAmt) {
                      isResolved = true;
                      resolutionMsg = `Slot ${slotNum} is now completely empty (placeholder was removed).`;
                      checks.push({ ok: true, message: `✓ Resolved: ${resolutionMsg}` });
                    } else {
                      checks.push({ ok: false, message: `✗ Slot ${slotNum} still contains a placeholder (App ID: ${currentId || "(blank)"}, Amount: ${currentAmt || "(blank)"}).` });
                    }
                  } else {
                    checks.push({ ok: false, message: `✗ Invalid slot number parsed from log: ${slotNum}` });
                  }

                  if (actualRowNum !== rowNum) {
                    checks.push({ ok: true, message: `ℹ️ Job safely located at row ${actualRowNum} (moved from original row ${rowNum})` });
                  }
                } else if (tab !== "Confirmed") {
                   checks.push({ ok: false, message: `✗ Alert specifies ${tab} tab, but only Confirmed is verified.` });
                } else {
                  checks.push({ ok: false, message: `✗ Could not locate job "${jobClient} | ${jobName}" anywhere in the Confirmed tab.` });
                }

                results.push({
                  status: isResolved ? "ok" : "issue",
                  logTimestamp: timestamp,
                  checks,
                  message: isResolved
                    ? `[${tab}] Row ${actualRowNum} — ${jobClient} | ${jobName}, Slot ${slotNum}: Alert resolved.`
                    : `[${tab}] Row ${actualRowNum} — ${jobClient} | ${jobName}, Slot ${slotNum}: Still requires reconciliation.`
                });
              }
            }
          }

        } // end expenseUnreconGaps

        // ── crmCopiedConfDelete ────────────────────────────────────────────────
        // Parse AutoLog entries where jobs were deleted from Confirmed via the
        // "copied to conf box DELETE" action. Then verify:
        //   1. Job is no longer present in Confirmed tab (by project code)
        //   2. Job status in Pipeline tab (% likelihood, copied-to-conf column)
        if (flagType === "crmCopiedConfDelete") {

          // Find AutoLog entries containing deletion records
          const deleteLogEntries = autoLogRows.filter(row => {
            const details = String(row[3] || "");
            return details.includes("Deleted Job:") && details.includes("[Confirmed]");
          });
          console.log(`  ✓ Found ${deleteLogEntries.length} delete log entries in window`);

          // Fall back to full AutoLog if nothing in window
          const deleteEntriesToUse = deleteLogEntries.length > 0 ? deleteLogEntries :
            allAutoLogRows.filter(row => {
              const details = String(row[3] || "");
              return details.includes("Deleted Job:") && details.includes("[Confirmed]");
            });
          if (deleteLogEntries.length === 0 && deleteEntriesToUse.length > 0) {
            console.log(`  ↩ Fell back to full AutoLog — found ${deleteEntriesToUse.length} entries`);
          }

          if (deleteEntriesToUse.length === 0) {
            results.push({
              status: "info",
              message: "No deletion entries found in AutoLog since flag was last cleared.",
            });
          } else {
            // Parse each deletion entry
            // Format: "[Confirmed] Deleted Job: Row N, CLIENT | JOB (ID: CRM-XXXX)"
            const deletedJobs = [];
            const deletePattern = /\[Confirmed\]\s*Deleted Job:\s*Row\s*(\d+),\s*([^|]+)\|\s*([^(\n]+)\(ID:\s*([^)]+)\)/gi;

            for (const entry of deleteEntriesToUse) {
              const details = String(entry[3] || "");
              const timestamp = String(entry[0] || "");
              let match;
              while ((match = deletePattern.exec(details)) !== null) {
                const rowNum     = match[1].trim();
                const clientName = match[2].trim();
                const jobName    = match[3].trim();
                const projectCode = match[4].trim(); // e.g. "CRM-1576"
                // Deduplicate by project code
                if (!deletedJobs.find(j => j.projectCode === projectCode)) {
                  deletedJobs.push({ rowNum, clientName, jobName, projectCode, logTimestamp: timestamp });
                }
              }
            }

            if (deletedJobs.length === 0) {
              results.push({
                status: "info",
                message: "Deletion entries found in AutoLog but could not be parsed. Check the AutoLog tab manually.",
              });
            } else {
              console.log(`  ✓ Parsed ${deletedJobs.length} deleted job(s): ${JSON.stringify(deletedJobs.map(j => j.projectCode))}`);

              // Read Confirmed tab (cols A:C = client, job, project code)
              const confirmedResp = await withRetry(() => sheets.spreadsheets.values.get({
                spreadsheetId: clientSheetIdClean,
                range: "Confirmed!A1:C5000",
              }));
              const confirmedRows = confirmedResp.data.values || [];

              // Read Pipeline tab (cols A:C for lookup, AN for % likelihood, DD for copied status)
              // DD = col 110 (0-indexed), AN = col 39 (0-indexed)
              const pipelineResp = await withRetry(() => sheets.spreadsheets.values.get({
                spreadsheetId: clientSheetIdClean,
                range: "Pipeline!A1:DD5000",
              }));
              const pipelineRows = pipelineResp.data.values || [];

              for (const job of deletedJobs) {
                const checks = [];
                const jobClientLower = job.clientName.toLowerCase();
                const jobNameLower   = job.jobName.toLowerCase();
                const projectCodeLower = job.projectCode.toLowerCase();

                // ── Check 1: Confirmed tab ──────────────────────────────────
                // Search by project code (col C = index 2), fallback client+job (cols A+B)
                let confirmedRowIdx = -1;
                for (let ri = 1; ri < confirmedRows.length; ri++) {
                  const r = confirmedRows[ri] || [];
                  const pc = String(r[2] || "").trim().toLowerCase();
                  if (pc === projectCodeLower) { confirmedRowIdx = ri; break; }
                }
                // Fallback: client + job name
                if (confirmedRowIdx === -1) {
                  for (let ri = 1; ri < confirmedRows.length; ri++) {
                    const r = confirmedRows[ri] || [];
                    const rc = String(r[0] || "").trim().toLowerCase();
                    const rj = String(r[1] || "").trim().toLowerCase();
                    if (rc === jobClientLower && rj === jobNameLower) { confirmedRowIdx = ri; break; }
                  }
                }

                if (confirmedRowIdx === -1) {
                  checks.push({ ok: true,  message: `✓ Not found in Confirmed tab — job successfully removed` });
                } else {
                  checks.push({ ok: false, message: `✗ Job still exists in Confirmed tab at row ${confirmedRowIdx + 1} — deletion may have failed` });
                }

                // ── Check 2: Pipeline tab ───────────────────────────────────
                // Search by project code (col C = index 2), fallback client+job
                let pipelineRowIdx = -1;
                for (let ri = 1; ri < pipelineRows.length; ri++) {
                  const r = pipelineRows[ri] || [];
                  const pc = String(r[2] || "").trim().toLowerCase();
                  if (pc === projectCodeLower) { pipelineRowIdx = ri; break; }
                }
                if (pipelineRowIdx === -1) {
                  for (let ri = 1; ri < pipelineRows.length; ri++) {
                    const r = pipelineRows[ri] || [];
                    const rc = String(r[0] || "").trim().toLowerCase();
                    const rj = String(r[1] || "").trim().toLowerCase();
                    if (rc === jobClientLower && rj === jobNameLower) { pipelineRowIdx = ri; break; }
                  }
                }

                if (pipelineRowIdx === -1) {
                  checks.push({ ok: false, message: `⚠ Job not found in Pipeline tab — notable, as deleted Confirmed jobs are usually still in Pipeline` });
                } else {
                  const pipeRow = pipelineRows[pipelineRowIdx];
                  // AN = col 39 (0-indexed), DD = col 109 (0-indexed)
                  // DD is col 110 in 1-indexed: D=4, D=4 → 4*26+4=108? Let me recalculate:
                  // A=1...Z=26, AA=27...AZ=52, BA=53...DD=?
                  // D=4, D=4: (4-1)*26 + 4 = 82? No: col letter to number:
                  // DD: first D=4, second D=4 → (4)*26 + 4 = 108 (1-indexed) → index 107
                  // AN: A=1, N=14 → 1*26+14 = 40 (1-indexed) → index 39
                  const likelihood  = String(pipeRow[39] || "").trim();   // AN
                  const copiedStatus = String(pipeRow[107] || "").trim(); // DD
                  checks.push({
                    ok: true,
                    message: `Job found in Pipeline tab at row ${pipelineRowIdx + 1}` +
                      ` — likelihood: ${likelihood || "(blank)"}` +
                      `, "Copied to conf?" = ${copiedStatus || "(blank)"}`,
                  });
                }

                results.push({
                  status: checks.every(c => c.ok) ? "ok" : "issue",
                  jobName:      job.jobName,
                  clientName:   job.clientName,
                  projectCode:  job.projectCode,
                  confirmedRow: parseInt(job.rowNum, 10),
                  logTimestamp: job.logTimestamp,
                  checks,
                  message: `${job.clientName} | ${job.jobName} (${job.projectCode}) — deleted from Confirmed row ${job.rowNum}`,
                });
              }
            }
          }

        } // end crmCopiedConfDelete

        const overallOk = results.every(r => r.status === "ok" || r.status === "info");
        console.log(`  ✅ Analysis complete: ${results.length} items, overall ${overallOk ? "OK" : "ISSUES FOUND"}`);
        return res.status(200).json({ success: true, flagType, results, overallOk });

      } catch (err) {
        console.error(`❌ Error analyzing non-actionable flag:`, err);
        return res.status(500).json({ success: false, error: `Analysis failed: ${err.message}` });
      }
}

// ============================================================================
// LOCAL HELPER FUNCTIONS
// ============================================================================

export function fuzzyClientMatch_(nameA, nameB) {
  if (!nameA || !nameB) return false;
  const clean = s => String(s).toLowerCase().replace(/['"\-.,()/#]/g, " ").replace(/\s+/g, " ").trim();
  const a = clean(nameA);
  const b = clean(nameB);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  
  const NOISE = new Set(["ltd", "limited", "plc", "inc", "llc", "llp", "the", "and", "&", "group", "co", "corp", "corporation"]);
  const wordsA = a.split(" ").filter(w => w.length > 1 && !NOISE.has(w));
  const wordsB = b.split(" ").filter(w => w.length > 1 && !NOISE.has(w));
  
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  return wordsA.some(w => wordsB.includes(w)) || wordsB.some(w => wordsA.includes(w));
}

export function parseSheetOrJsDate_(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const s = String(val).trim();
  
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    const mIdx = months[m[2].toLowerCase()];
    if (mIdx === undefined) return null;
    const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    return new Date(yr, mIdx, parseInt(m[1], 10));
  }
  
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function monthsWithinTolerance_(date1, date2, toleranceMonths) {
  if (!date1 || !date2) return false;
  const m1 = date1.getFullYear() * 12 + date1.getMonth();
  const m2 = date2.getFullYear() * 12 + date2.getMonth();
  return Math.abs(m1 - m2) <= Math.max(0, toleranceMonths);
}

// ============================================================================
// SWEEP & LOGGING HELPER FUNCTIONS
// ============================================================================

const SWEEP_SCHEDULE_TAB = "SweepSchedule";
const SWEEP_SCHEDULE_DEFAULTS = { actionable: 30, info: 60, proactive: 1440 };

async function ensureSweepScheduleTab(sheets, automationCommanderSheetId) {
  return;
}

// Returns { actionable: { rowIndex, frequencyMinutes, lastCheckedAt }, info: {...}, proactive: {...} }
// Missing categories (e.g. a row deleted by hand) fall back to defaults with
// no rowIndex — isCategoryDue_ below treats that as "always due" rather than
// throwing, and the caller can decide whether to also re-create the row.
async function readSweepSchedule_(sheets, automationCommanderSheetId) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: automationCommanderSheetId,
    range: `${SWEEP_SCHEDULE_TAB}!A2:C10`,
  });
  const rows = resp.data.values || [];
  const schedule = {};
  rows.forEach((row, i) => {
    const category = String(row[0] || "").trim().toLowerCase();
    if (!category) return;
    schedule[category] = {
      rowIndex: i + 2,
      frequencyMinutes: parseInt(row[1], 10) || SWEEP_SCHEDULE_DEFAULTS[category] || 30,
      lastCheckedAt: row[2] || "",
    };
  });
  for (const category of Object.keys(SWEEP_SCHEDULE_DEFAULTS)) {
    if (!schedule[category]) {
      schedule[category] = { rowIndex: null, frequencyMinutes: SWEEP_SCHEDULE_DEFAULTS[category], lastCheckedAt: "" };
    }
  }
  return schedule;
}

// True if this category's configured interval has elapsed since it was last
// checked (or has never been checked at all). A missing/unparseable
// lastCheckedAt is treated as "always due" — safer than silently never
// running a category because of a malformed timestamp.
function isCategoryDue_(categoryEntry) {
  if (!categoryEntry.lastCheckedAt) return true;
  const last = new Date(categoryEntry.lastCheckedAt);
  if (isNaN(last.getTime())) return true;
  const elapsedMinutes = (Date.now() - last.getTime()) / 60000;
  return elapsedMinutes >= categoryEntry.frequencyMinutes;
}

// Updates lastCheckedAt for one category — creates the row if it doesn't
// exist yet (e.g. schedule tab was just created, or a row was deleted by
// hand), rather than silently failing to persist the timestamp.
async function markCategoryChecked_(sheets, automationCommanderSheetId, category, schedule) {
  const nowISO = new Date().toISOString();
  const entry = schedule[category];
  if (entry && entry.rowIndex) {
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: automationCommanderSheetId,
      range: `${SWEEP_SCHEDULE_TAB}!C${entry.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[nowISO]] },
    }));
  } else {
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${SWEEP_SCHEDULE_TAB}!A:C`,
      valueInputOption: "RAW",
      requestBody: { values: [[category, (entry && entry.frequencyMinutes) || SWEEP_SCHEDULE_DEFAULTS[category] || 30, nowISO]] },
    }));
  }
}

async function ensureClaudeUsageTab_(sheets, automationCommanderSheetId) {
  return; // Safe stub to prevent crashes if this was also orphaned
}

// Log a Claude API call directly to ClaudeUsage tab
export async function logClaudeUsage_(sheets, automationCommanderSheetId, clientName, alertType, inputTokens, outputTokens, source) {
  if (!automationCommanderSheetId) return;
  const acIdClean = extractSheetIdFromUrl(automationCommanderSheetId) || automationCommanderSheetId;
  await ensureClaudeUsageTab_(sheets, acIdClean);
  const costUsd = ((inputTokens || 0) / 1000000 * 3) + ((outputTokens || 0) / 1000000 * 15);
  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: acIdClean,
    range: "ClaudeUsage!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        new Date().toISOString(),
        source || "precompute",
        clientName || "",
        alertType || "",
        (inputTokens || 0) + (outputTokens || 0),
        costUsd.toFixed(6),
      ]],
    },
  }));
  console.log(`  📊 Logged Claude usage: ${clientName} ${alertType} — ${inputTokens}+${outputTokens} tokens, $${costUsd.toFixed(4)}`);
}