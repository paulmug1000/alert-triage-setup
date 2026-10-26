import { createHash } from "crypto";
import { withRetry } from "./sheetsClient.js";
import { redisClient } from "./redisClient.js";

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
  if (alert.alertKey) {
    return createHash("sha256").update(alert.alertKey).digest("hex").substring(0, 16);
  }
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
  if (alert.legacyAlertKey) {
    return createHash("sha256").update(alert.legacyAlertKey).digest("hex").substring(0, 16);
  }
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

let _handledHashesMemoryCache = null;
let _handledHashesCachedAt = 0;
let _alertMemoryMemoryCache = null;
let _alertMemoryCachedAt = 0;

export async function updateHandledAlertHash(automationCommanderSheetId, fingerprintHash, status) {
  if (!fingerprintHash) return;
  return updateHandledAlertHashesBatch(automationCommanderSheetId, { [fingerprintHash]: status });
}

export async function updateHandledAlertHashesBatch(automationCommanderSheetId, statusByHash) {
  if (!statusByHash || Object.keys(statusByHash).length === 0) return;
  const now = Date.now();
  if (_handledHashesMemoryCache) {
    for (const [hash, status] of Object.entries(statusByHash)) {
      if (status === "cached" || status === "pending_automation") {
        delete _handledHashesMemoryCache[hash];
      } else {
        _handledHashesMemoryCache[hash] = status;
      }
    }
    _handledHashesCachedAt = now;
  }
  const cacheKey = `pulse:alert_memory_handled:${automationCommanderSheetId}`;
  try {
    if (redisClient?.isOpen && automationCommanderSheetId) {
      const cached = await redisClient.get(cacheKey);
      let map = {};
      if (cached) {
        try { map = JSON.parse(cached); } catch (e) {}
      }
      for (const [hash, status] of Object.entries(statusByHash)) {
        if (status === "cached" || status === "pending_automation") {
          delete map[hash];
        } else {
          map[hash] = status;
        }
      }
      await redisClient.set(cacheKey, JSON.stringify(map), { EX: 86400 * 7 });
      _handledHashesMemoryCache = map;
      _handledHashesCachedAt = now;
    }
  } catch (err) {
    console.warn("⚠️ Redis updateHandledAlertHashesBatch error:", err.message);
  }
}

export async function invalidateAlertMemoryCache(automationCommanderSheetId) {
  _alertMemoryMemoryCache = null;
  _alertMemoryCachedAt = 0;
  try {
    if (redisClient?.isOpen && automationCommanderSheetId) {
      await redisClient.del(`pulse:alert_memory:${automationCommanderSheetId}`);
      // NOTE: We deliberately do NOT delete pulse:alert_memory_handled, as that key
      // is updated directly by updateHandledAlertHash and prevents 9MB Google Sheet pulls!
    }
  } catch (err) {
    console.warn("⚠️ Redis cache invalidate error:", err.message);
  }
}

/**
 * Returns a compact map { [fingerprintHash]: status } for handled (non-cached) alerts.
 * Uses 60s in-memory cache and 7d Redis cache to avoid transferring the massive 8.5MB AlertMemory table.
 * If allowFallback is false (e.g. interactive app loads), never blocks on 9MB sheet downloads.
 */
export async function readHandledAlertHashes(sheets, automationCommanderSheetId, allowFallback = true) {
  const now = Date.now();
  if (_handledHashesMemoryCache && (now - _handledHashesCachedAt < 60000)) {
    return _handledHashesMemoryCache;
  }

  const cacheKey = `pulse:alert_memory_handled:${automationCommanderSheetId}`;
  try {
    if (redisClient?.isOpen && automationCommanderSheetId) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        _handledHashesMemoryCache = parsed;
        _handledHashesCachedAt = now;
        return parsed;
      }
    }
  } catch (err) {
    console.warn("⚠️ Redis read error in readHandledAlertHashes:", err.message);
  }

  // During interactive loads, if Redis has not yet populated, return empty map rather than blocking 45s for 9MB
  if (!allowFallback) {
    console.log(`[readHandledAlertHashes] Cache miss on ${cacheKey}, returning empty map to avoid blocking interactive load.`);
    return _handledHashesMemoryCache || {};
  }

  const fullRows = await readAlertMemory(sheets, automationCommanderSheetId);
  const handledMap = {};
  for (const r of fullRows) {
    if (r.status && r.status !== "cached" && r.status !== "pending_automation") {
      handledMap[r.fingerprintHash] = r.status;
    }
  }

  try {
    if (redisClient?.isOpen && automationCommanderSheetId) {
      await redisClient.set(cacheKey, JSON.stringify(handledMap), { EX: 86400 * 7 });
    }
  } catch (err) {
    console.warn("⚠️ Redis write error in readHandledAlertHashes:", err.message);
  }

  _handledHashesMemoryCache = handledMap;
  _handledHashesCachedAt = now;
  return handledMap;
}

export async function readAlertMemory(sheets, automationCommanderSheetId) {
  const now = Date.now();
  if (_alertMemoryMemoryCache && (now - _alertMemoryCachedAt < 60000)) {
    return _alertMemoryMemoryCache;
  }

  const cacheKey = `pulse:alert_memory:${automationCommanderSheetId}`;
  try {
    if (redisClient?.isOpen && automationCommanderSheetId) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log(`[AlertMemory Cache HIT] read ${cached.length} chars from Redis key ${cacheKey}`);
        const parsed = JSON.parse(cached);
        _alertMemoryMemoryCache = parsed;
        _alertMemoryCachedAt = now;
        return parsed;
      } else {
        console.log(`[AlertMemory Cache MISS] Redis key ${cacheKey} is null/empty`);
      }
    } else {
      console.log(`[AlertMemory Cache SKIP] redisClient.isOpen=${redisClient?.isOpen}, acId=${automationCommanderSheetId}`);
    }
  } catch (err) {
    console.warn("⚠️ Redis read error in readAlertMemory:", err.message);
  }

  const response = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: automationCommanderSheetId,
    range: ALERT_MEMORY_RANGE,
  }));
  const rows = response.data.values || [];
  if (rows.length < 2) return [];

  const parsed = rows.slice(1).map((row, i) => ({
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

  try {
    if (redisClient?.isOpen && automationCommanderSheetId && parsed.length > 0) {
      const serialized = JSON.stringify(parsed);
      await redisClient.set(cacheKey, serialized, { EX: 86400 * 7 });
      console.log(`[AlertMemory Cache SET] Saved ${parsed.length} rows (${serialized.length} chars) to Redis key ${cacheKey}`);
    } else {
      console.log(`[AlertMemory Cache SET SKIP] redisClient.isOpen=${redisClient?.isOpen}, acId=${automationCommanderSheetId}, rows=${parsed.length}`);
    }
  } catch (err) {
    console.warn("⚠️ Redis write error in readAlertMemory:", err.message);
  }

  _alertMemoryMemoryCache = parsed;
  _alertMemoryCachedAt = now;
  return parsed;
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
    if (status === "ignored" || status === "accepted" || status === "task" || status === "pending_automation") return 3;
    if (status === "cached") return 2;
    return 1;
  };
  return matches.sort((a, b) => {
    const pd = priority(b.status) - priority(a.status);
    if (pd !== 0) return pd;
    const dateDiff = new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
    if (dateDiff !== 0) return dateDiff;
    return (b.rowIndex || 0) - (a.rowIndex || 0);
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

export async function updateAlertMemoryCacheInPlace(automationCommanderSheetId, updateFn) {
  const now = Date.now();
  let cache = _alertMemoryMemoryCache;
  if (!cache && redisClient?.isOpen && automationCommanderSheetId) {
    try {
      const cached = await redisClient.get(`pulse:alert_memory:${automationCommanderSheetId}`);
      if (cached) cache = JSON.parse(cached);
    } catch (e) {}
  }
  if (cache) {
    updateFn(cache);
    _alertMemoryMemoryCache = cache;
    _alertMemoryCachedAt = now;
    if (redisClient?.isOpen && automationCommanderSheetId) {
      redisClient.set(`pulse:alert_memory:${automationCommanderSheetId}`, JSON.stringify(cache), { EX: 86400 * 7 }).catch(() => {});
    }
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

  const now = new Date().toISOString();
  const response = await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: automationCommanderSheetId,
    range: `${ALERT_MEMORY_TAB}!A:L`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        fingerprintHash, alertType, clientName, alertSummary,
        cachedOptionsJSON, status, ignoreReason || "", payload.firstSeen || now, now,
        now, 
        dataSnapshot || "",
        category || "discrepancy",
      ]],
    },
  }));
  console.log(`  📝 DEBUG: Appended alert ${fingerprintHash} to ${response.data.updates.updatedRange} with status "${status}"`);
  await updateHandledAlertHash(automationCommanderSheetId, fingerprintHash, status);
  await updateAlertMemoryCacheInPlace(automationCommanderSheetId, (cache) => {
    const nextRowIndex = cache.length + 2;
    cache.push({ ...payload, rowIndex: nextRowIndex });
  });
}

export async function appendAlertMemoryRowsBatch(sheets, automationCommanderSheetId, items) {
  if (!items || items.length === 0) return;
  const now = new Date().toISOString();
  const rows = items.map(payload => {
    let {
      fingerprintHash, alertType, clientName, alertSummary,
      cachedOptionsJSON, status, ignoreReason, dataSnapshot, category,
    } = payload;

    cachedOptionsJSON = compressOptionsJSON_(cachedOptionsJSON);

    if (alertType === "expense") alertType = "expenseDashboardDiscr";
    if (alertType === "crm") alertType = "crmPipeAppDiscr";

    return [
      fingerprintHash, alertType, clientName, alertSummary,
      cachedOptionsJSON, status, ignoreReason || "", payload.firstSeen || now, now,
      now, 
      dataSnapshot || "",
      category || "discrepancy",
    ];
  });

  const response = await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: automationCommanderSheetId,
    range: `${ALERT_MEMORY_TAB}!A:L`,
    valueInputOption: "RAW",
    requestBody: {
      values: rows,
    },
  }));
  console.log(`  📝 DEBUG: Batch appended ${items.length} alerts to ${response.data?.updates?.updatedRange || ALERT_MEMORY_TAB}`);

  const statusByHash = {};
  for (const item of items) {
    if (item.fingerprintHash) {
      statusByHash[item.fingerprintHash] = item.status;
    }
  }
  await updateHandledAlertHashesBatch(automationCommanderSheetId, statusByHash);
  await updateAlertMemoryCacheInPlace(automationCommanderSheetId, (cache) => {
    let nextRowIndex = cache.length + 2;
    for (const item of items) {
      cache.push({ ...item, rowIndex: nextRowIndex++ });
    }
  });
}

export async function updateAlertMemoryRow(sheets, automationCommanderSheetId, rowIndex, updates) {
  const compressedOptions = compressOptionsJSON_(updates.cachedOptionsJSON);
  const now = new Date().toISOString();
  const values = [
    updates.fingerprintHash,
    updates.alertType,
    updates.clientName,
    updates.alertSummary,
    compressedOptions,
    updates.status,    
    updates.ignoreReason || "",
    updates.firstSeen || now,
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
  if (updates.fingerprintHash) {
    await updateHandledAlertHash(automationCommanderSheetId, updates.fingerprintHash, updates.status);
  }
  await updateAlertMemoryCacheInPlace(automationCommanderSheetId, (cache) => {
    const idx = cache.findIndex(r => r.rowIndex === rowIndex || (updates.fingerprintHash && r.fingerprintHash === updates.fingerprintHash));
    if (idx !== -1) {
      cache[idx] = { ...cache[idx], ...updates, rowIndex };
    }
  });
}

export async function updateAlertMemoryRowsBatch(sheets, automationCommanderSheetId, updateItems) {
  if (!updateItems || updateItems.length === 0) return;
  const now = new Date().toISOString();
  const data = updateItems.map(({ rowIndex, updates }) => {
    const compressedOptions = compressOptionsJSON_(updates.cachedOptionsJSON);
    const values = [
      updates.fingerprintHash,
      updates.alertType,
      updates.clientName,
      updates.alertSummary,
      compressedOptions,
      updates.status,
      updates.ignoreReason || "",
      updates.firstSeen || now,
      now, 
      updates.lastRechecked || now,
      updates.dataSnapshot || "",
    ];
    return {
      range: `${ALERT_MEMORY_TAB}!A${rowIndex}:K${rowIndex}`,
      values: [values],
    };
  });

  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: automationCommanderSheetId,
    requestBody: {
      valueInputOption: "RAW",
      data,
    },
  }));
  const statusByHash = {};
  for (const item of updateItems) {
    if (item.updates?.fingerprintHash) {
      statusByHash[item.updates.fingerprintHash] = item.updates.status;
    }
  }
  await updateHandledAlertHashesBatch(automationCommanderSheetId, statusByHash);
  await updateAlertMemoryCacheInPlace(automationCommanderSheetId, (cache) => {
    for (const item of updateItems) {
      const idx = cache.findIndex(r => r.rowIndex === item.rowIndex || (item.updates?.fingerprintHash && r.fingerprintHash === item.updates.fingerprintHash));
      if (idx !== -1) {
        cache[idx] = { ...cache[idx], ...item.updates, rowIndex: item.rowIndex };
      }
    }
  });
}

export async function compactAlertMemory(sheets, automationCommanderSheetId, options = {}) {
  const { dryRun = false, force = false } = options;
  console.log(`[compactAlertMemory] Starting compaction for Automation Commander ${automationCommanderSheetId} (dryRun=${dryRun})...`);

  // Read all existing rows from sheet directly to be 100% authoritative
  const response = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: automationCommanderSheetId,
    range: ALERT_MEMORY_RANGE,
  }));
  const rawRows = response.data.values || [];
  if (rawRows.length < 2) {
    console.log(`[compactAlertMemory] AlertMemory is empty or header only. Nothing to compact.`);
    return { originalRows: 0, keptRows: 0, prunedRows: 0 };
  }

  const existingRows = rawRows.slice(1).map((row, i) => ({
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

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const kept = [];
  let prunedCount = 0;
  let optionsClearedCount = 0;

  for (const r of existingRows) {
    const status = r.status || "cached";
    const lastDate = new Date(r.lastRechecked || r.lastSeen || r.firstSeen || 0).getTime();
    const ageDays = (now - lastDate) / DAY_MS;

    let shouldKeep = false;

    if (status === "task" || status === "pending_automation" || status === "cached") {
      shouldKeep = true;
    } else if (status === "accepted" || status === "ignored") {
      // 100% protection against resurrection for accepted or ignored items
      shouldKeep = true;
    } else if (status === "superseded") {
      if (r.ignoreReason) {
        // Preserves historical ignore reason if alert recurs
        shouldKeep = true;
      } else {
        // Transient duplicate fingerprint from sweeps; keep recent 7 days only
        shouldKeep = ageDays <= 7;
      }
    } else if (status === "task_resolved") {
      shouldKeep = ageDays <= 60;
    } else if (status === "auto_resolved") {
      shouldKeep = ageDays <= 30;
    } else {
      shouldKeep = ageDays <= 30;
    }

    if (shouldKeep) {
      const compactRow = { ...r };
      // Strip bulky options dropdown data on inactive rows
      if (status !== "cached") {
        if (compactRow.cachedOptionsJSON) {
          optionsClearedCount++;
          compactRow.cachedOptionsJSON = "";
        }
      }
      kept.push(compactRow);
    } else {
      prunedCount++;
    }
  }

  console.log(`[compactAlertMemory] Evaluated ${existingRows.length} rows: keeping ${kept.length}, pruning ${prunedCount}, cleared options from ${optionsClearedCount} inactive rows.`);

  if (prunedCount === 0 && optionsClearedCount === 0 && !force) {
    console.log(`[compactAlertMemory] No rows pruned or options cleared. Tab is already compact.`);
    return { originalRows: existingRows.length, keptRows: kept.length, prunedRows: 0 };
  }

  if (dryRun) {
    return { originalRows: existingRows.length, keptRows: kept.length, prunedRows: prunedCount, optionsClearedCount };
  }

  // Re-assign sequential rowIndex for all kept rows (starting at row 2)
  for (let idx = 0; idx < kept.length; idx++) {
    kept[idx].rowIndex = idx + 2;
  }

  const rows2D = kept.map(r => [
    r.fingerprintHash || "",
    r.alertType || "",
    r.clientName || "",
    r.alertSummary || "",
    r.cachedOptionsJSON || "",
    r.status || "cached",
    r.ignoreReason || "",
    r.firstSeen || "",
    r.lastSeen || "",
    r.lastRechecked || "",
    r.dataSnapshot || "",
    r.category || "discrepancy",
  ]);

  const targetRange = `${ALERT_MEMORY_TAB}!A2:L${kept.length + 1}`;
  console.log(`[compactAlertMemory] Overwriting ${targetRange} with ${rows2D.length} compacted rows...`);

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: automationCommanderSheetId,
    range: targetRange,
    valueInputOption: "RAW",
    requestBody: { values: rows2D },
  }));

  // Clear any leftover rows from the old table
  const oldRowCount = existingRows.length + 1;
  const newRowCount = kept.length + 1;
  if (oldRowCount > newRowCount) {
    const clearRange = `${ALERT_MEMORY_TAB}!A${newRowCount + 1}:L${oldRowCount}`;
    console.log(`[compactAlertMemory] Clearing leftover rows: ${clearRange}...`);
    try {
      await withRetry(() => sheets.spreadsheets.values.clear({
        spreadsheetId: automationCommanderSheetId,
        range: clearRange,
      }));
    } catch (clearErr) {
      console.warn(`[compactAlertMemory] Warning clearing tail rows:`, clearErr.message);
    }
  }

  // Truncate sheet grid height to keep the Google Sheet compact and fast
  try {
    const meta = await withRetry(() => sheets.spreadsheets.get({
      spreadsheetId: automationCommanderSheetId,
      fields: "sheets.properties",
    }));
    const sheetTab = meta.data.sheets?.find(s => s.properties.title === ALERT_MEMORY_TAB);
    if (sheetTab) {
      const sheetId = sheetTab.properties.sheetId;
      const currentGridRows = sheetTab.properties.gridProperties?.rowCount || 0;
      const desiredGridRows = newRowCount + 25; // Keep small 25-row buffer for appends
      if (currentGridRows > desiredGridRows) {
        console.log(`[compactAlertMemory] Truncating grid height from ${currentGridRows} to ${desiredGridRows}...`);
        await withRetry(() => sheets.spreadsheets.batchUpdate({
          spreadsheetId: automationCommanderSheetId,
          requestBody: {
            requests: [
              {
                deleteDimension: {
                  range: {
                    sheetId,
                    dimension: "ROWS",
                    startIndex: desiredGridRows,
                    endIndex: currentGridRows,
                  },
                },
              },
            ],
          },
        }));
      }
    }
  } catch (truncateErr) {
    console.warn(`[compactAlertMemory] Warning truncating grid height:`, truncateErr.message);
  }

  // Synchronize in-memory and Redis caches immediately
  _alertMemoryMemoryCache = kept;
  _alertMemoryCachedAt = Date.now();

  try {
    if (redisClient?.isOpen && automationCommanderSheetId) {
      await redisClient.set(
        `pulse:alert_memory:${automationCommanderSheetId}`,
        JSON.stringify(kept),
        { EX: 86400 * 7 }
      );
      console.log(`[compactAlertMemory] Updated Redis pulse:alert_memory:${automationCommanderSheetId} with ${kept.length} rows.`);
    }
  } catch (rErr) {
    console.warn(`[compactAlertMemory] Redis alert_memory update error:`, rErr.message);
  }

  // Synchronize handled hashes map
  const handledMap = {};
  for (const r of kept) {
    if (r.status && r.status !== "cached" && r.status !== "pending_automation") {
      handledMap[r.fingerprintHash] = r.status;
    }
  }
  _handledHashesMemoryCache = handledMap;
  _handledHashesCachedAt = Date.now();

  try {
    if (redisClient?.isOpen && automationCommanderSheetId) {
      await redisClient.set(
        `pulse:alert_memory_handled:${automationCommanderSheetId}`,
        JSON.stringify(handledMap),
        { EX: 86400 * 7 }
      );
      console.log(`[compactAlertMemory] Updated Redis handled hashes map with ${Object.keys(handledMap).length} entries.`);
    }
  } catch (rErr) {
    console.warn(`[compactAlertMemory] Redis handled map update error:`, rErr.message);
  }

  console.log(`[compactAlertMemory] ✅ Successfully compacted AlertMemory! Kept: ${kept.length}, Pruned: ${prunedCount}.`);
  return { originalRows: existingRows.length, keptRows: kept.length, prunedRows: prunedCount, optionsClearedCount };
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
  await invalidateAlertMemoryCache(automationCommanderSheetId);
}

export async function purgeOldAlertMemoryRows(sheets, automationCommanderSheetId, memoryRows) {
  // Delegates to the safe, high-speed atomic compactAlertMemory
  return compactAlertMemory(sheets, automationCommanderSheetId);
}