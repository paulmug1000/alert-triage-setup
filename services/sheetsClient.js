import { google } from "googleapis";
import { unwrapSheetId } from "./sheetTokenService.js";

const _wrappedSheetsClients = new WeakSet();

function wrapGoogleSheetsClient_(sheets) {
  if (!sheets || !sheets.spreadsheets || _wrappedSheetsClients.has(sheets)) return sheets;
  _wrappedSheetsClients.add(sheets);

  const sp = sheets.spreadsheets;
  for (const method of ["get", "batchUpdate"]) {
    if (typeof sp[method] === "function") {
      const orig = sp[method].bind(sp);
      sp[method] = (params, ...rest) => {
        if (params && typeof params.spreadsheetId === "string") {
          params = { ...params, spreadsheetId: unwrapSheetId(params.spreadsheetId) };
        }
        return orig(params, ...rest);
      };
    }
  }

  if (sp.values) {
    for (const method of ["get", "update", "append", "batchGet", "batchUpdate", "clear", "batchClear"]) {
      if (typeof sp.values[method] === "function") {
        const orig = sp.values[method].bind(sp.values);
        sp.values[method] = (params, ...rest) => {
          if (params && typeof params.spreadsheetId === "string") {
            params = { ...params, spreadsheetId: unwrapSheetId(params.spreadsheetId) };
          }
          return orig(params, ...rest);
        };
      }
    }
  }
  return sheets;
}

export function getGoogleAuth() {
  let privateKey = process.env.SERVICE_ACCOUNT_PRIVATE_KEY || "";
  if (!privateKey) {
    console.error("SERVICE_ACCOUNT_PRIVATE_KEY is not set");
    throw new Error("SERVICE_ACCOUNT_PRIVATE_KEY environment variable not set");
  }
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
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  };
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive"
    ],
  });
}

export async function getSheetsClient() {
  const auth = getGoogleAuth();
  return wrapGoogleSheetsClient_(google.sheets({ version: "v4", auth }));
}

export async function getDriveClient() {
  const auth = getGoogleAuth();
  return google.drive({ version: "v3", auth });
}

export async function withRetry(operation, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      const isQuotaError =
        error.code === 429 ||
        error.code === "429" ||
        error.status === 429 ||
        error.response?.status === 429 ||
        (typeof error.message === "string" && (
          error.message.includes("429") ||
          error.message.includes("Quota exceeded") ||
          error.message.includes("RESOURCE_EXHAUSTED") ||
          error.message.includes("rateLimitExceeded")
        ));

      if (isQuotaError && i < maxRetries - 1) {
        const delay = Math.min(Math.pow(2, i) * 2000 + Math.random() * 1000, 15000);
        console.log(`  ⏳ 429 Quota Exceeded. Retrying in ${Math.round(delay/1000)}s... (attempt ${i + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
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
const SHEET_GID_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

export async function getSheetGid(sheets, spreadsheetId, sheetName) {
  const resolvedId = unwrapSheetId(spreadsheetId);
  const cacheKey = `${resolvedId}::${sheetName}`;
  const cached = _sheetGidCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < SHEET_GID_CACHE_TTL)) {
    return cached.gid;
  }

  const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: resolvedId, fields: "sheets.properties" }));
  const sheet = meta.data.sheets?.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  // Cache all sheet tabs returned in this call for future lookups
  for (const s of meta.data.sheets || []) {
    if (s.properties?.title && s.properties?.sheetId !== undefined) {
      _sheetGidCache.set(`${resolvedId}::${s.properties.title}`, {
        gid: s.properties.sheetId,
        timestamp: Date.now()
      });
    }
  }

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