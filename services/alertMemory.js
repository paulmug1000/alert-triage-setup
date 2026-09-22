import { createHash } from "crypto";
import { withRetry } from "./sheetsClient";

export const ALERT_MEMORY_TAB = "AlertMemory";
export const ALERT_MEMORY_RANGE = `${ALERT_MEMORY_TAB}!A:L`;
export const ALERT_MEMORY_MAX_AGE_MONTHS = 12;

export function normaliseForFingerprint(val) {
  if (typeof val !== "string") return String(val ?? "");
  const m = val.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (m) {
    const day  = m[1].padStart(2, "0");
    const mon  = m[2];
    const year = m[3].length === 4 ? m[3].slice(-2) : m[3];
    return `${day}-${mon}-${year}`;
  }
  if (/^\d+(\.\d+)?%$/.test(val)) {
    return String(Number(val.slice(0, -1)) / 100);
  }
  const stripped = val.replace(/^[£$€]/, "").replace(/,/g, "").trim();
  if (stripped !== "" && !isNaN(Number(stripped))) {
    return String(Number(stripped));
  }
  return val;
}

export function normaliseArrayForFingerprint(arr) {
  return (arr || []).map(v => normaliseForFingerprint(String(v ?? "")));
}

export function buildAlertFingerprint(alert) {
  const parts = [];
  parts.push(alert.clientName || "");
  parts.push(alert.type || "");
  parts.push(alert.flagType || alert.alertType || "");

  if (alert.data) {
    if (alert.data.accounting) parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.accounting)));
    if (alert.data.confirmed)  parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.confirmed)));
    if (alert.data.crmData)    parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.crmData)));
    if (alert.data.sheetData)  parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.sheetData)));
    if (alert.data.flags)      parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.flags)));
  }

  const raw = parts.join("|");
  return createHash("sha256").update(raw).digest("hex").substring(0, 16);
}

export function buildAlertFingerprintLegacy(alert) {
  const parts = [];
  parts.push(alert.type || "");
  parts.push(alert.flagType || alert.alertType || "");

  if (alert.data) {
    if (alert.data.accounting) parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.accounting)));
    if (alert.data.confirmed)  parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.confirmed)));
    if (alert.data.crmData)    parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.crmData)));
    if (alert.data.sheetData)  parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.sheetData)));
    if (alert.data.flags)      parts.push(JSON.stringify(normaliseArrayForFingerprint(alert.data.flags)));
  }

  const raw = parts.join("|");
  return createHash("sha256").update(raw).digest("hex").substring(0, 16);
}

export async function readAlertMemory(sheets, automationCommanderSheetId) {
  const response = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: automationCommanderSheetId,
    range: ALERT_MEMORY_RANGE,
  }));
  const rows = response.data.values || [];
  if (rows.length < 2) return [];

  return rows.slice(1).map((row, i) => ({
    rowIndex: i + 2,
    fingerprintHash:  row[0] || "",
    alertType:        row[1] || "",
    clientName:       row[2] || "",
    alertSummary:     row[3] || "",
    cachedOptionsJSON:row[4] || "",
    status:           row[5] || "cached",
    ignoreReason:     row[6] || "",
    firstSeen:        row[7] || "",
    lastSeen:         row[8] || "",
    lastRechecked:    row[9] || "",
    dataSnapshot:     row[10] || "",
    category:         row[11] || "discrepancy",
  }));
}

export function getHandledFingerprintHashes_(memoryRows) {
  return new Set(
    memoryRows
      .filter(r => r.status === "ignored" || r.status === "task" || r.status === "superseded" || r.status === "accepted" || r.status === "pending_automation")
      .map(r => r.fingerprintHash)
      .filter(Boolean)
  );
}

export async function ensureAlertMemoryTab(sheets, automationCommanderSheetId) {
  return;
}

export function findMemoryRow(memoryRows, fingerprintHash) {
  const matches = memoryRows.filter(r => r.fingerprintHash === fingerprintHash);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const priority = (status) => {
    if (status === "ignored" || status === "accepted" || status === "task") return 3;
    if (status === "cached") return 2;
    return 1;
  };
  return matches.sort((a, b) => {
    const pd = priority(b.status) - priority(a.status);
    if (pd !== 0) return pd;
    return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
  })[0];
}

export function extractCrmComparisonSnapshot(alert) {
  if (!alert || alert.type !== "crm" || !alert.data) return null;
  const { crmData, sheetData } = alert.data;
  if (!crmData || !sheetData) return null;

  const variant = alert.alertType || alert.flagType || "";
  const isDash = variant === "crmPipeDashDiscr" || variant === "crmConfDashDiscr";
  const isApp  = variant === "crmPipeAppDiscr"  || variant === "crmConfAppDiscr";
  if (!isDash && !isApp) return null;

  const clean = v => (v === null || v === undefined ? "" : String(v)).trim();

  let primaryClient, primaryJob, fallbackClient, fallbackJob;
  if (isDash) {
    primaryClient  = clean(crmData[0]);   primaryJob  = clean(crmData[1]);
    fallbackClient = clean(sheetData[1]); fallbackJob = clean(sheetData[2]);
  } else {
    primaryClient  = clean(sheetData[0]); primaryJob  = clean(sheetData[1]);
    fallbackClient = clean(crmData[1]);   fallbackJob = clean(crmData[2]);
  }

  const jobName    = primaryJob || fallbackJob;
  const clientName = primaryClient || fallbackClient;
  if (!jobName) return null;

  const FIELD_INDEX = [
    { key: "revenue",     idx: 3 },
    { key: "directCosts", idx: 4 },
    { key: "startDate",   idx: 5 },
    { key: "endDate",     idx: 6 },
    { key: "likelihood",  idx: 7 },
  ];
  const fields = {};
  for (const f of FIELD_INDEX) {
    fields[f.key] = { crm: clean(crmData[f.idx]), dashboard: clean(sheetData[f.idx]) };
  }

  return { clientName, jobName, fields };
}

export async function findPreviousIgnoreReason(memoryRows, alert) {
  try {
    const supersededRows = memoryRows
      .filter(r => r.status === "superseded" && r.ignoreReason)
      .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
    if (supersededRows.length === 0) return null;

    const alertClient = (alert.clientName || "").toLowerCase().trim();
    const alertType   = (alert.type || alert.flagType || "").toLowerCase();
    const alertInvNo  = (alert.summary?.invoiceNo || "").trim();
    const alertRef    = (alert.summary?.reference || "").trim();

    const alertFlagType = (alert.flagType || alert.alertType || "").trim();
    const crmIdentity    = alertType === "crm" ? extractCrmComparisonSnapshot(alert) : null;

    for (const row of supersededRows) {
      if ((row.clientName || "").toLowerCase().trim() !== alertClient) continue;
      
      const rowType = (row.alertType || "").toLowerCase().trim();
      if (rowType !== alertType && rowType !== alertFlagType.toLowerCase()) continue;

      let matched = false;
      let snap = null;

      if (row.dataSnapshot) {
        try {
          snap = JSON.parse(row.dataSnapshot);
          const snapInvNo = (snap.invoiceNo || "").trim();
          const snapRef   = (snap.reference || "").trim();
          if (alertInvNo && snapInvNo && snapInvNo === alertInvNo) matched = true;
          if (alertRef   && snapRef   && snapRef   === alertRef)   matched = true;

          if (!matched && alertType === "crm" && crmIdentity && crmIdentity.jobName) {
            const snapFlagType  = (snap.flagType || "").trim();
            const snapJobName   = (snap.crmJobName || "").toLowerCase().trim();
            const snapEndClient = (snap.crmEndClient || "").toLowerCase().trim();
            const jobMatches    = snapJobName && snapJobName === crmIdentity.jobName.toLowerCase().trim();
            const clientMatches = !crmIdentity.clientName || !snapEndClient
              || snapEndClient === crmIdentity.clientName.toLowerCase().trim();
            if (alertFlagType && snapFlagType && alertFlagType === snapFlagType && jobMatches && clientMatches) {
              matched = true;
            }
          }
        } catch (e) { }
      }

      if (!matched) {
        if (alertInvNo && (row.alertSummary || "").includes(alertInvNo)) matched = true;
        if (alertRef   && (row.alertSummary || "").includes(alertRef))   matched = true;
      }

      if (!matched) continue;

      let changeReason = null;
      try {
        if (snap && Object.keys(snap).length > 0) {
          const changes = [];
          const snapAmt    = parseFloat(String(snap.amount || "").replace(/[£$€,]/g, "")) || null;
          const currentAmt = parseFloat(String(alert.summary?.amount || "").replace(/[£$€,]/g, "")) || null;
          if (snapAmt !== null && currentAmt !== null && Math.abs(snapAmt - currentAmt) > 0.005) {
            changes.push(`amount changed from £${snapAmt.toFixed(2)} to £${currentAmt.toFixed(2)}`);
          }

          const snapVAT    = parseFloat(String(snap.vatIncluded || "").replace(/[£$€,]/g, "")) || null;
          const currentVAT = parseFloat(String(alert.summary?.vatIncluded || "").replace(/[£$€,]/g, "")) || null;
          if (snapVAT !== null && currentVAT !== null && Math.abs(snapVAT - currentVAT) > 0.005) {
            changes.push(`VAT changed from £${snapVAT.toFixed(2)} to £${currentVAT.toFixed(2)}`);
          }

          const snapStatus    = (snap.status || "").trim();
          const currentStatus = (alert.summary?.status || "").trim();
          if (snapStatus && currentStatus && snapStatus !== currentStatus) {
            changes.push(`status changed from "${snapStatus}" to "${currentStatus}"`);
          }

          const snapSent    = (snap.sentDate || "").trim();
          const currentSent = (alert.summary?.sentDate || "").trim();
          if (snapSent && currentSent && snapSent !== currentSent) {
            changes.push(`sent date changed from "${snapSent}" to "${currentSent}"`);
          }

          const snapPaid    = (snap.datePaid || "").trim();
          const currentPaid = (alert.summary?.datePaid || "").trim();
          if (snapPaid && currentPaid && snapPaid !== currentPaid) {
            changes.push(`date paid changed from "${snapPaid}" to "${currentPaid}"`);
          }

          const snapClient    = (snap.client || "").trim();
          const currentClient = (alert.summary?.client || "").trim();
          if (snapClient && currentClient && snapClient !== currentClient) {
            changes.push(`client changed from "${snapClient}" to "${currentClient}"`);
          }

          const snapJob    = (snap.job || "").trim();
          const currentJob = (alert.summary?.job || "").trim();
          if (snapJob && currentJob && snapJob !== currentJob) {
            changes.push(`job changed from "${snapJob}" to "${currentJob}"`);
          }

          if (alertType === "crm" && snap.crmFields && crmIdentity && crmIdentity.fields) {
            const FIELD_LABELS = {
              revenue: "Revenue", directCosts: "Direct costs", startDate: "Start date",
              endDate: "End date", likelihood: "% Likelihood",
            };
            for (const key of Object.keys(FIELD_LABELS)) {
              const before = snap.crmFields[key];
              const after  = crmIdentity.fields[key];
              if (!before || !after) continue;
              if (before.crm && after.crm && before.crm !== after.crm) {
                changes.push(`${FIELD_LABELS[key]} (CRM) changed from "${before.crm}" to "${after.crm}"`);
              }
              if (before.dashboard && after.dashboard && before.dashboard !== after.dashboard) {
                changes.push(`${FIELD_LABELS[key]} (dashboard) changed from "${before.dashboard}" to "${after.dashboard}"`);
              }
            }
          }

          if (changes.length > 0) {
            changeReason = changes.join("; ");
          } else {
            changeReason = "underlying data may have been updated (no specific field change detected)";
          }
        } else {
          changeReason = "alert was re-raised (no previous snapshot to compare against)";
        }
      } catch (e) { }

      return { ignoreReason: row.ignoreReason, changeReason };
    }
    return null;
  } catch (e) {
    return null;
  }
}

export function compressOptionsJSON_(jsonStr) {
  if (!jsonStr) return jsonStr;
  try {
    const options = JSON.parse(jsonStr);
    if (!Array.isArray(options)) return jsonStr;
    
    const seenJobs = new Set();
    const compressed = options.map(opt => {
      if (!opt.jobRow || !opt.jobRowsData) return opt;
      if (seenJobs.has(opt.jobRow)) {
        const { jobRowsData, ...rest } = opt;
        return rest;
      }
      seenJobs.add(opt.jobRow);
      return opt;
    });
    
    return JSON.stringify(compressed, (k, v) => (v === "" || v === null) ? undefined : v);
  } catch (e) {
    return jsonStr;
  }
}

export async function appendAlertMemoryRow(sheets, automationCommanderSheetId, payload) {
  let {
    fingerprintHash, alertType, clientName, alertSummary,
    cachedOptionsJSON, status, ignoreReason, dataSnapshot, category,
  } = payload;

  cachedOptionsJSON = compressOptionsJSON_(cachedOptionsJSON);

  if (alertType === "expense") alertType = "expenseDashboardDiscr";
  if (alertType === "crm") alertType = "crmPipeAppDiscr";

  const now = new Date().toISOString().split("T")[0];
  const response = await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: automationCommanderSheetId,
    range: `${ALERT_MEMORY_TAB}!A:L`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        fingerprintHash, alertType, clientName, alertSummary,
        cachedOptionsJSON, status, ignoreReason || "", now, now,
        now, 
        dataSnapshot || "",
        category || "discrepancy",
      ]],
    },
  }));
  console.log(`  📝 DEBUG: Appended alert ${fingerprintHash} to ${response.data.updates.updatedRange} with status "${status}"`);
}

export async function updateAlertMemoryRow(sheets, automationCommanderSheetId, rowIndex, updates) {
  const compressedOptions = compressOptionsJSON_(updates.cachedOptionsJSON);
  const now = new Date().toISOString().split("T")[0];
  const values = [
    updates.fingerprintHash,
    updates.alertType,
    updates.clientName,
    updates.alertSummary,
    compressedOptions,
    updates.status,    
    updates.ignoreReason || "",
    updates.firstSeen,
    now, 
    updates.lastRechecked || now,
    updates.dataSnapshot || "",
  ];
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: automationCommanderSheetId,
    range: `${ALERT_MEMORY_TAB}!A${rowIndex}:K${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  }));
}

export async function deleteAlertMemoryRows(sheets, automationCommanderSheetId, rowIndices) {
  if (rowIndices.length === 0) return;

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: automationCommanderSheetId,
  });
  const sheet = spreadsheet.data.sheets.find(
    s => s.properties.title === ALERT_MEMORY_TAB
  );
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  const sorted = [...rowIndices].sort((a, b) => b - a);

  const requests = sorted.map(rowIndex => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: rowIndex - 1, 
        endIndex: rowIndex,       
      },
    },
  }));

  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: automationCommanderSheetId,
    requestBody: { requests },
  }));
  console.log(`  🗑️ Deleted ${rowIndices.length} stale AlertMemory row(s)`);
}

export async function purgeOldAlertMemoryRows(sheets, automationCommanderSheetId, memoryRows) {
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