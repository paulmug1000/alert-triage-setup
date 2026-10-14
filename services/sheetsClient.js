import { google } from "googleapis";

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
  return google.sheets({ version: "v4", auth });
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
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A1` });
  } catch (e) {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}

export function extractSheetIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
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
  const cacheKey = `${spreadsheetId}::${sheetName}`;
  const cached = _sheetGidCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < SHEET_GID_CACHE_TTL)) {
    return cached.gid;
  }

  const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" }));
  const sheet = meta.data.sheets?.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  // Cache all sheet tabs returned in this call for future lookups
  for (const s of meta.data.sheets || []) {
    if (s.properties?.title && s.properties?.sheetId !== undefined) {
      _sheetGidCache.set(`${spreadsheetId}::${s.properties.title}`, {
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