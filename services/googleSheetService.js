/**
 * ============================================================================
 * GOOGLE SHEET CRM SERVICE
 * ============================================================================
 * 
 * Provides OAuth 2.0 flow, token management, sheet inspection, and KeyInfo linking
 * for Google Sheet CRM data sources.
 * 
 * Ingestion Architecture:
 * - Read-only access: Client sheets are never modified.
 * - Multi-factor bridge: Master Sheet reconciles row identities via internal CRMGoogleBridge.
 * - Auth options: User-delegated OAuth (offline access) or direct URL via Service Account.
 */

import { getSheetsClient, extractSheetIdFromUrl, withRetry } from "./sheetsClient.js";
import { redisClient } from "./redisClient.js";
import { saveIntegrationTokens, getIntegrationTokens, deleteIntegrationTokens } from "./vaultService.js";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export const GOOGLE_SHEET_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/spreadsheets.readonly"
];

/**
 * Builds the Google OAuth initiation URL for connecting Google Sheets CRM.
 */
export function buildGoogleSheetAuthUrl({ redirectUri, state }) {
  const clientId = process.env.GOOGLE_SHEET_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("Missing GOOGLE_SHEET_CLIENT_ID or GOOGLE_CLIENT_ID environment variable");
  }

  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SHEET_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("state", state);

  return url.toString();
}

/**
 * Exchanges authorization code for access and refresh tokens.
 */
export async function exchangeGoogleSheetCodeForTokens({ code, redirectUri }) {
  const clientId = process.env.GOOGLE_SHEET_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_SHEET_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GOOGLE_SHEET_CLIENT_ID or GOOGLE_SHEET_CLIENT_SECRET in environment");
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.statusText}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: data.expires_in || 3600,
    scope: data.scope || ""
  };
}

/**
 * Refreshes an expired Google OAuth access token using a stored refresh token.
 */
export async function refreshGoogleSheetTokens(refreshToken) {
  const clientId = process.env.GOOGLE_SHEET_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_SHEET_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GOOGLE_SHEET_CLIENT_ID or GOOGLE_SHEET_CLIENT_SECRET in environment");
  }

  if (!refreshToken) {
    throw new Error("No refresh token provided to refreshGoogleSheetTokens");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.statusText}`);
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || 3600
  };
}

/**
 * Detects the most probable header row (1-indexed) from sample spreadsheet rows.
 */
export function detectCandidateHeaderRow(rows = []) {
  if (!rows || rows.length === 0) return 1;

  let bestRowIdx = 0;
  let bestScore = -1;

  const keywords = /^(?:client|lead|org|company|customer|account|job|deal|opportunity|project|task|value|amount|revenue|total|fee|start|date|target|end|close|status|stage|prob|likelihood)/i;

  rows.forEach((row, idx) => {
    if (!Array.isArray(row)) return;
    const nonEmptyCells = row.filter((c) => String(c || "").trim() !== "");
    if (nonEmptyCells.length === 0) return;

    let score = 0;
    nonEmptyCells.forEach((cell) => {
      const clean = String(cell).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (keywords.test(clean)) score += 3;
      else if (typeof cell === "string" && isNaN(Number(cell))) score += 1;
    });

    if (score > bestScore) {
      bestScore = score;
      bestRowIdx = idx;
    }
  });

  return bestRowIdx + 1;
}

/**
 * Heuristically suggests column mappings across the 6 core CRM dimensions.
 */
export function suggestCrmColumnMapping(headers = []) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const findCol = (regex, exclude = []) => {
    return (
      headers.find((h) => {
        const clean = norm(h);
        return !exclude.includes(h) && regex.test(clean);
      }) || ""
    );
  };

  const clientCol = findCol(/^(?:client|lead|org|company|customer|account)/i);
  const jobCol = findCol(/^(?:job|deal|opportunity|task|title|name|project|nature)/i, [clientCol]);
  const revCol = findCol(/^(?:value|amount|revenue|total|deal|fee|price|budget)/i, [clientCol, jobCol]);
  const startCol = findCol(/^(?:start|month|target|live|commence|date)/i, [clientCol, jobCol, revCol]);
  const endCol = findCol(/^(?:end|close|completion|finish|due)/i, [clientCol, jobCol, revCol, startCol]);
  const likeCol = findCol(/^(?:status|stage|milestone|prob|likelihood|confidence)/i, [clientCol, jobCol, revCol, startCol, endCol]);

  return {
    clientCol: clientCol || headers[0] || "",
    jobCol: jobCol || headers[1] || "",
    revCol: revCol || "",
    startCol: startCol || "",
    endCol: endCol || "",
    likeCol: likeCol || ""
  };
}

/**
 * Inspects a Google Sheet by URL or Sheet ID.
 * Uses OAuth Bearer token if provided, otherwise falls back to the backend service account.
 */
export async function inspectGoogleSpreadsheet({
  url,
  sheetId = null,
  accessToken = null,
  tabName = null,
  headerRowNum = null
}) {
  const targetId = sheetId || (url ? extractSheetIdFromUrl(url) : null);
  if (!targetId) {
    throw new Error("Invalid or missing Google Sheet URL / ID");
  }

  let metadata = null;
  let sampleData = [];

  if (accessToken) {
    // 1. Fetch metadata via user's OAuth access token
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${targetId}?fields=properties.title,sheets.properties`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const metaJson = await metaRes.json();
    if (!metaRes.ok || metaJson.error) {
      throw new Error(`Google Sheets API error: ${metaJson.error?.message || metaRes.statusText}`);
    }
    metadata = metaJson;
  } else {
    // 2. Fallback to service account
    const sheets = await getSheetsClient();
    try {
      const res = await sheets.spreadsheets.get({ spreadsheetId: targetId });
      metadata = res.data;
    } catch (err) {
      if (err.code === 403 || err.message?.includes("403")) {
        throw new Error("Access denied: ensure the sheet is accessible or grant access via Google Sign-In.");
      }
      throw err;
    }
  }

  const title = metadata?.properties?.title || "Connected Google Sheet";
  const tabs = (metadata?.sheets || []).map((s) => ({
    title: s.properties?.title || "Sheet1",
    sheetId: s.properties?.sheetId,
    rowCount: s.properties?.gridProperties?.rowCount || 0,
    columnCount: s.properties?.gridProperties?.columnCount || 0
  }));

  const targetTab = tabName || tabs[0]?.title || "Sheet1";

  // Fetch sample rows (top 5 rows)
  try {
    if (accessToken) {
      const escapedTab = targetTab.replace(/'/g, "''");
      const rangeParam = encodeURIComponent(`'${escapedTab}'!1:5`);
      const sampleUrl = `https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values/${rangeParam}`;
      const sRes = await fetch(sampleUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      const sJson = await sRes.json();
      sampleData = sJson.values || [];
    } else {
      const sheets = await getSheetsClient();
      const sRes = await sheets.spreadsheets.values.get({
        spreadsheetId: targetId,
        range: `'${targetTab}'!1:5`
      });
      sampleData = sRes.data.values || [];
    }
  } catch (sampleErr) {
    console.warn("Note reading sample rows for Google Sheet inspect:", sampleErr.message);
  }

  const detectedRow = detectCandidateHeaderRow(sampleData);
  const activeHeaderRow = headerRowNum ? Math.max(1, parseInt(headerRowNum, 10)) : detectedRow;
  const headerIdx = Math.max(0, activeHeaderRow - 1);
  const rawHeaderRow = sampleData[headerIdx] || [];
  const headers = rawHeaderRow.map((h) => String(h || "").trim()).filter(Boolean);
  const suggestedMapping = suggestCrmColumnMapping(headers);
  const hasSystemId = headers.some((h) => /^(?:system\s*id|id)$/i.test(h));

  return {
    success: true,
    spreadsheetId: targetId,
    title,
    tabs,
    defaultTab: tabs[0]?.title || "Sheet1",
    selectedTab: targetTab,
    headers,
    candidateHeaderRow: activeHeaderRow,
    suggestedMapping,
    hasSystemId,
    sampleRowsCount: Math.max(0, sampleData.length - activeHeaderRow)
  };
}

/**
 * Links a Google Sheet to a client's Master Sheet KeyInfo (X11:X14)
 * and updates Redis setup state.
 */
export async function linkGoogleSheetToClient({
  clientKey,
  masterSheetId,
  url,
  tabName,
  headerRowNum = 1,
  keyHeaders = ""
}) {
  if (!masterSheetId) throw new Error("Missing masterSheetId parameter");
  if (!url) throw new Error("Missing Google Sheet URL");

  const targetId = extractSheetIdFromUrl(url);
  if (!targetId) throw new Error("Could not parse spreadsheet ID from URL");

  const sheets = await getSheetsClient();
  const cleanTab = String(tabName || "").trim() || "Sheet1";
  const rowNumStr = String(headerRowNum || 1);
  const cleanKeyHeaders = String(keyHeaders || "").trim();

  // Write to KeyInfo!X11:X14, clear legacy X15, and set Q8 to Google Sheet
  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: masterSheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range: "KeyInfo!X11", values: [[url.trim()]] },
          { range: "KeyInfo!X12", values: [[cleanTab]] },
          { range: "KeyInfo!X13", values: [[cleanKeyHeaders]] },
          { range: "KeyInfo!X14", values: [[rowNumStr]] },
          { range: "KeyInfo!X15", values: [[""]] },
          { range: "KeyInfo!Q8", values: [["Google Sheet"]] }
        ]
      }
    })
  );

  // Invalidate and update Redis setup cache
  const cleanClient = String(clientKey || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const redisKey = `pulse:setup:${cleanClient}`;
  if (redisClient?.isOpen) {
    try {
      const raw = await redisClient.get(redisKey);
      const prev = raw ? JSON.parse(raw) : {};
      const updated = {
        ...prev,
        clientName: clientKey,
        masterSheetId,
        crmTool: "Google Sheet",
        googleSheetUrl: url.trim(),
        googleSheetTab: cleanTab,
        googleSheetHeaderRow: rowNumStr,
        googleSheetKeyHeaders: cleanKeyHeaders,
        updatedAt: new Date().toISOString()
      };
      await redisClient.set(redisKey, JSON.stringify(updated));
    } catch (e) {
      console.warn("Failed updating Redis setup cache for Google Sheet link:", e);
    }
  }

  return {
    success: true,
    spreadsheetId: targetId,
    url: url.trim(),
    tabName: cleanTab,
    headerRowNum: rowNumStr,
    keyHeaders: cleanKeyHeaders
  };
}
