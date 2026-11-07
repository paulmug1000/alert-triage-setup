import { google } from "googleapis";
import { unwrapSheetId } from "./sheetTokenService.js";
export { sanitizeFormulaInput } from "../utils/helpers.js";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/presentations",
];

const COOLDOWN_DURATION_MS = 15 * 1000; // 15s cooldown per credential on 429
const _inFlightReads = new Map();
let _roundRobinCounter = 0;

function isQuotaError_(error) {
  if (!error) return false;
  return (
    error.code === 429 ||
    error.code === "429" ||
    error.status === 429 ||
    error.response?.status === 429 ||
    (typeof error.message === "string" &&
      (error.message.includes("429") ||
        error.message.includes("Quota exceeded") ||
        error.message.includes("RESOURCE_EXHAUSTED") ||
        error.message.includes("rateLimitExceeded")))
  );
}

function hashSpreadsheetId_(str) {
  const s = String(str || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function cloneApiData_(res) {
  if (!res || typeof res !== "object") return res;
  try {
    return {
      ...res,
      data: typeof structuredClone === "function" ? structuredClone(res.data) : JSON.parse(JSON.stringify(res.data)),
    };
  } catch {
    return res;
  }
}

function normalizeCredentialObject_(raw, defaultPool = "all") {
  if (!raw || typeof raw !== "object") return null;
  const privateKeyRaw = String(raw.private_key || raw.privateKey || "").trim();
  const clientEmail = String(raw.client_email || raw.clientEmail || "").trim();
  if (!privateKeyRaw || !clientEmail) return null;

  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const projectId = String(raw.project_id || raw.projectId || "default-project").trim();
  const pool = String(raw.pool || defaultPool || "all").trim().toLowerCase();

  const credentials = {
    type: "service_account",
    project_id: projectId,
    private_key_id: raw.private_key_id || raw.privateKeyId || undefined,
    private_key: privateKey,
    client_email: clientEmail,
    client_id: raw.client_id || raw.clientId || undefined,
    auth_uri: raw.auth_uri || "https://accounts.google.com/o/oauth2/auth",
    token_uri: raw.token_uri || "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url:
      raw.auth_provider_x509_cert_url || "https://www.googleapis.com/oauth2/v1/certs",
  };

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });

  return {
    id: `${projectId}:${clientEmail}`,
    projectId,
    email: clientEmail,
    pool: ["interactive", "background", "all"].includes(pool) ? pool : "all",
    auth,
    rawSheets: google.sheets({ version: "v4", auth }),
    rawDrive: google.drive({ version: "v3", auth }),
    rawSlides: google.slides({ version: "v1", auth }),
    cooldownUntil: 0,
  };
}

function parsePoolEnvVar_(rawEnv) {
  if (!rawEnv || typeof rawEnv !== "string") return [];
  const trimmed = rawEnv.trim();
  if (!trimmed) return [];

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8");
      parsed = JSON.parse(decoded);
    } catch (err) {
      console.error("⚠️ Failed to parse GOOGLE_SERVICE_ACCOUNT_POOL:", err.message);
      return [];
    }
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return [parsed];
  return [];
}

function getPoolEntries_() {
  if (global._pulseSheetsCredPool && global._pulseSheetsCredPool.length > 0) {
    return global._pulseSheetsCredPool;
  }

  const entries = [];
  const seenEmails = new Set();

  const addEntry = (rawObj, defaultPool = "all") => {
    const entry = normalizeCredentialObject_(rawObj, defaultPool);
    if (!entry) return;
    const emailKey = entry.email.toLowerCase();
    if (seenEmails.has(emailKey)) return;
    seenEmails.add(emailKey);
    entries.push(entry);
  };

  // 1. Primary Service Account from standard SERVICE_ACCOUNT_* env vars
  if (process.env.SERVICE_ACCOUNT_PRIVATE_KEY && process.env.SERVICE_ACCOUNT_EMAIL) {
    addEntry(
      {
        project_id: process.env.SERVICE_ACCOUNT_PROJECT_ID,
        private_key_id: process.env.SERVICE_ACCOUNT_PRIVATE_KEY_ID,
        private_key: process.env.SERVICE_ACCOUNT_PRIVATE_KEY,
        client_email: process.env.SERVICE_ACCOUNT_EMAIL,
        client_id: process.env.SERVICE_ACCOUNT_CLIENT_ID,
        pool: process.env.SERVICE_ACCOUNT_PRIMARY_POOL || "all",
      },
      "all"
    );
  }

  // 2. Additional Service Accounts from GOOGLE_SERVICE_ACCOUNT_POOL (JSON array or Base64 JSON)
  if (process.env.GOOGLE_SERVICE_ACCOUNT_POOL) {
    const poolList = parsePoolEnvVar_(process.env.GOOGLE_SERVICE_ACCOUNT_POOL);
    for (const item of poolList) {
      addEntry(item, item?.pool || "all");
    }
  }

  if (entries.length === 0) {
    console.error("SERVICE_ACCOUNT_PRIVATE_KEY is not set and GOOGLE_SERVICE_ACCOUNT_POOL is empty");
    throw new Error("SERVICE_ACCOUNT_PRIVATE_KEY environment variable not set");
  }

  global._pulseSheetsCredPool = entries;
  return entries;
}

function selectPoolEntry_(spreadsheetId = "", requestedPool = "interactive") {
  const allEntries = getPoolEntries_();
  if (allEntries.length === 1) return allEntries[0];

  const now = Date.now();
  const normPool = String(requestedPool || "interactive").toLowerCase();

  // Prefer entries matching the requested workload pool (or "all")
  let poolCandidates = allEntries.filter(
    (e) => e.pool === normPool || e.pool === "all"
  );
  if (poolCandidates.length === 0) {
    poolCandidates = allEntries;
  }

  // Filter to credentials not currently cooling down from a 429
  const healthy = poolCandidates.filter((e) => e.cooldownUntil <= now);

  if (healthy.length === 0) {
    // Fallback: check if ANY credential in the entire pool is healthy across other workload pools
    const anyHealthy = allEntries.filter((e) => e.cooldownUntil <= now);
    if (anyHealthy.length > 0) {
      const idx = _roundRobinCounter++ % anyHealthy.length;
      return anyHealthy[idx];
    }
    // All credentials are cooling down: pick the one whose cooldown expires soonest
    return [...poolCandidates].sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
  }

  if (healthy.length === 1) return healthy[0];

  // If a spreadsheetId is present and all preferred candidates are healthy, shard deterministically by spreadsheetId
  if (spreadsheetId && healthy.length === poolCandidates.length) {
    const idx = hashSpreadsheetId_(spreadsheetId) % healthy.length;
    return healthy[idx];
  }

  // Otherwise round-robin across healthy credentials
  const idx = _roundRobinCounter++ % healthy.length;
  return healthy[idx];
}

function hasHealthyAlternative_(throttledId) {
  const entries = getPoolEntries_();
  if (entries.length <= 1) return false;
  const now = Date.now();
  return entries.some((e) => e.id !== throttledId && e.cooldownUntil <= now);
}

/**
 * Returns all unique Service Account emails configured across the pool (plus optional group email).
 */
export function getServiceAccountPoolEmails() {
  const emails = new Set();
  try {
    for (const entry of getPoolEntries_()) {
      if (entry.email) emails.add(entry.email);
    }
  } catch {
    if (process.env.SERVICE_ACCOUNT_EMAIL) {
      emails.add(process.env.SERVICE_ACCOUNT_EMAIL.trim());
    }
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_GROUP_EMAIL) {
    const groupEmail = process.env.GOOGLE_SERVICE_ACCOUNT_GROUP_EMAIL.trim();
    if (groupEmail) emails.add(groupEmail);
  }
  return [...emails];
}

function buildSingleflightKey_(namespace, method, params) {
  if (!params || typeof params !== "object") return null;
  try {
    return `${namespace}.${method}::${JSON.stringify(params)}`;
  } catch {
    return null;
  }
}

function createPooledSheetsClient_(poolType = "interactive") {
  const executeCall = async (namespace, method, isReadOnly, params, rest) => {
    let resolvedParams = params;
    let resolvedSheetId = "";
    if (params && typeof params.spreadsheetId === "string") {
      resolvedSheetId = unwrapSheetId(params.spreadsheetId);
      resolvedParams = { ...params, spreadsheetId: resolvedSheetId };
    }

    const runAgainstPool = async () => {
      const entry = selectPoolEntry_(resolvedSheetId, poolType);
      const targetObj =
        namespace === "values"
          ? entry.rawSheets.spreadsheets.values
          : entry.rawSheets.spreadsheets;
      const fn = targetObj[method].bind(targetObj);
      try {
        return await fn(resolvedParams, ...rest);
      } catch (err) {
        if (isQuotaError_(err)) {
          entry.cooldownUntil = Date.now() + COOLDOWN_DURATION_MS;
          err._throttledPoolEntryId = entry.id;
        }
        throw err;
      }
    };

    // Singleflight deduplication for concurrent identical read calls
    if (isReadOnly && rest.length === 0) {
      const sfKey = buildSingleflightKey_(namespace, method, resolvedParams);
      if (sfKey) {
        const existingPromise = _inFlightReads.get(sfKey);
        if (existingPromise) {
          const sharedRes = await existingPromise;
          return cloneApiData_(sharedRes);
        }
        const promise = runAgainstPool().finally(() => {
          _inFlightReads.delete(sfKey);
        });
        _inFlightReads.set(sfKey, promise);
        const res = await promise;
        return cloneApiData_(res);
      }
    }

    return runAgainstPool();
  };

  // Build lightweight proxy preserving full google.sheets("v4") interface
  const primarySheets = getPoolEntries_()[0].rawSheets;
  const spProxy = Object.create(primarySheets.spreadsheets);

  Object.defineProperty(spProxy, "get", {
    value: (params, ...rest) => executeCall("spreadsheets", "get", true, params, rest),
    writable: true,
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(spProxy, "batchUpdate", {
    value: (params, ...rest) => executeCall("spreadsheets", "batchUpdate", false, params, rest),
    writable: true,
    configurable: true,
    enumerable: true,
  });

  const valuesProxy = Object.create(primarySheets.spreadsheets.values);
  for (const method of ["get", "batchGet"]) {
    Object.defineProperty(valuesProxy, method, {
      value: (params, ...rest) => executeCall("values", method, true, params, rest),
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  for (const method of ["update", "append", "batchUpdate", "clear", "batchClear"]) {
    Object.defineProperty(valuesProxy, method, {
      value: (params, ...rest) => executeCall("values", method, false, params, rest),
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  Object.defineProperty(spProxy, "values", {
    value: valuesProxy,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  const clientProxy = Object.create(primarySheets);
  Object.defineProperty(clientProxy, "spreadsheets", {
    value: spProxy,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return clientProxy;
}

const _pooledClientsByType = new Map();

export function getGoogleAuth(options = {}) {
  const entry = selectPoolEntry_(options?.spreadsheetId || "", options?.pool || "interactive");
  return entry.auth;
}

export async function getSheetsClient(options = {}) {
  const poolType = String(options?.pool || "interactive").toLowerCase();
  if (!_pooledClientsByType.has(poolType)) {
    _pooledClientsByType.set(poolType, createPooledSheetsClient_(poolType));
  }
  return _pooledClientsByType.get(poolType);
}

export async function getDriveClient(options = {}) {
  const entry = selectPoolEntry_(options?.fileId || "", options?.pool || "interactive");
  return entry.rawDrive;
}

export async function getSlidesClient(options = {}) {
  const entry = selectPoolEntry_(options?.presentationId || "", options?.pool || "interactive");
  return entry.rawSlides;
}

export async function withRetry(operation, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (isQuotaError_(error) && i < maxRetries - 1) {
        const throttledId = error._throttledPoolEntryId;
        if (throttledId && hasHealthyAlternative_(throttledId)) {
          console.log(
            `  ⚡ 429 on credentialshard (${throttledId.split(":")[0]}) — failing over immediately to healthy pool credential (attempt ${i + 1}/${maxRetries})`
          );
          continue;
        }
        const delay = Math.min(Math.pow(2, i) * 2000 + Math.random() * 1000, 15000);
        console.log(
          `  ⏳ 429 Quota Exceeded. Retrying in ${Math.round(delay / 1000)}s... (attempt ${i + 1}/${maxRetries})`
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
}

export async function ensureFreshData(sheets, spreadsheetId, sheetName) {
  const resolvedId = unwrapSheetId(spreadsheetId);
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    await sheets.spreadsheets.values.get({ spreadsheetId: resolvedId, range: `${sheetName}!A1` });
  } catch (e) {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}

export function extractSheetIdFromUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (s.startsWith("ws_") || s === "default") {
    return unwrapSheetId(s) || null;
  }
  const match = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || s.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

export function colLetterToNum(col) {
  return String(col).toUpperCase().split("").reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0);
}

export function colIndexToLetter(colNum) {
  let letter = "";
  let n = colNum;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

const _sheetGidCache = new Map();
const _sheetTitlesCache = new Map();
const SHEET_GID_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

function cacheSheetProperties_(resolvedId, sheetsList) {
  const now = Date.now();
  const titles = new Set();
  for (const s of sheetsList || []) {
    if (s.properties?.title) {
      titles.add(s.properties.title);
      if (s.properties.sheetId !== undefined) {
        _sheetGidCache.set(`${resolvedId}::${s.properties.title}`, {
          gid: s.properties.sheetId,
          timestamp: now,
        });
      }
    }
  }
  if (titles.size > 0) {
    _sheetTitlesCache.set(resolvedId, {
      titles,
      timestamp: now,
    });
  }
  return titles;
}

export async function getSheetTitles(sheets, spreadsheetId) {
  const resolvedId = unwrapSheetId(spreadsheetId);
  const cached = _sheetTitlesCache.get(resolvedId);
  if (cached && Date.now() - cached.timestamp < SHEET_GID_CACHE_TTL) {
    return new Set(cached.titles);
  }

  const meta = await withRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId: resolvedId, fields: "sheets.properties" })
  );
  const titles = cacheSheetProperties_(resolvedId, meta.data?.sheets || []);
  return new Set(titles);
}

export async function getSheetGid(sheets, spreadsheetId, sheetName) {
  const resolvedId = unwrapSheetId(spreadsheetId);
  const cacheKey = `${resolvedId}::${sheetName}`;
  const cached = _sheetGidCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SHEET_GID_CACHE_TTL) {
    return cached.gid;
  }

  const meta = await withRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId: resolvedId, fields: "sheets.properties" })
  );
  const sheet = meta.data.sheets?.find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  // Cache all sheet tabs and titles returned in this call for future lookups
  cacheSheetProperties_(resolvedId, meta.data.sheets || []);

  return sheet.properties.sheetId;
}

export async function getSheetId(sheets, spreadsheetId, tabName) {
  return getSheetGid(sheets, spreadsheetId, tabName);
}

export async function applySheetFontFormat(sheets, spreadsheetId, tabName, startRowIndex, endRowIndex, startColIndex = 0, endColIndex = 50, fontFamily = "Arial", fontSize = 9) {
  try {
    const gid = await getSheetGid(sheets, spreadsheetId, tabName);
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: gid,
                startRowIndex,
                endRowIndex,
                startColumnIndex: startColIndex,
                endColumnIndex: endColIndex
              },
              cell: {
                userEnteredFormat: {
                  textFormat: {
                    fontFamily,
                    fontSize
                  }
                }
              },
              fields: "userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize"
            }
          }
        ]
      }
    }));
    return { fontFamily, fontSize };
  } catch (err) {
    console.warn(`[applySheetFontFormat] Failed to apply font format on ${tabName}:`, err.message);
    return { fontFamily: "Arial", fontSize: 9 };
  }
}