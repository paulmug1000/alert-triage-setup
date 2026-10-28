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
import { DEFAULT_AC_SHEET_ID, resolveClientNameBySheetId, matchesClientName } from "./userPermissions.js";

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

  let bestRowIdx = -1;
  let bestScore = -100;

  const keywords = /^(?:client|lead|org|company|customer|account|job|deal|opportunity|project|task|nature|type|value|amount|revenue|total|fee|price|cost|costs|start|date|month|months|target|end|close|status|stage|prob|likelihood|owner|rep|manager)/i;

  rows.forEach((row, idx) => {
    if (!Array.isArray(row)) return;
    const nonEmptyCells = row.filter((c) => String(c || "").trim() !== "");
    if (nonEmptyCells.length === 0) return;

    let score = 0;

    // A single cell row is usually a title banner (not a column header row)
    if (nonEmptyCells.length === 1) {
      score -= 10;
    } else {
      score += nonEmptyCells.length * 2;
    }

    nonEmptyCells.forEach((cell) => {
      const valStr = String(cell).trim();
      const clean = valStr.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (keywords.test(clean)) {
        score += 8;
      }
      // Check if cell is purely numeric or currency (data rows contain numbers, headers do not)
      const isNum = !isNaN(Number(valStr.replace(/[£$,€%]/g, "")));
      if (isNum) {
        score -= 10;
      }
    });

    if (score > bestScore) {
      bestScore = score;
      bestRowIdx = idx;
    }
  });

  return bestRowIdx >= 0 ? bestRowIdx + 1 : 1;
}

/**
 * Heuristically suggests column mappings across the 6 core CRM dimensions.
 * Uses intelligent multi-dimensional scoring supporting prefixes, modifiers (Est., Target, Projected, etc.), and common business variants.
 */
export function suggestCrmColumnMapping(headers = []) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  function scoreHeader(h, dim) {
    const n = norm(h);
    if (!n) return -999;

    if (dim === "startCol") {
      if (/(end|close|closing|finish|completion|due|expiry|expiration|deliver)/.test(n)) return -500;
      if (/(id|url|link|email|status|stage|type|created|updated|modified)/.test(n)) return -100;
      if (/^(startdate|startdt|commencedate|livedate|golivedate|commencementdate|launchdate|kickoffdate)$/.test(n)) return 100;
      if (/^start$/.test(n)) return 90;
      if (/(est|estimated|expected|target|projected|planned|forecast|anticipate|contract|work|actual).*start.*(date|dt)?/.test(n)) return 95;
      if (/start.*(est|estimated|expected|target|projected|planned|forecast|date|dt|month|day)/.test(n)) return 90;
      if (n.includes("start")) return 80;
      if (n.includes("commence")) return 75;
      if (n.includes("golive") || n.includes("launch") || n.includes("kickoff")) return 70;
      return -50;
    }

    if (dim === "endCol") {
      if (/(start|commence|live|launch|kickoff|inception)/.test(n)) return -500;
      if (/(reason|id|url|link|status|stage|type)/.test(n)) return -100;
      if (/^(enddate|enddt|closedate|closingdate|closedt|completiondate|finishdate|duedate|deliverydate|expirydate)$/.test(n)) return 100;
      if (/^(end|close)$/.test(n)) return 90;
      if (/(est|estimated|expected|target|projected|planned|forecast|anticipate|contract|work|actual).*(end|close|closing|finish|completion|due|delivery|expiry).*(date|dt)?/.test(n)) return 95;
      if (/(end|close|closing).*(est|estimated|expected|target|projected|planned|forecast|date|dt|month)/.test(n)) return 90;
      if (/(completion|finish|due|delivery).*(date|dt)/.test(n)) return 85;
      if (n.includes("end")) return 80;
      if (n.includes("close") || n.includes("closing")) return 75;
      if (/(completion|finish|due|delivery|expiry)/.test(n)) return 70;
      return -50;
    }

    if (dim === "revCol") {
      if (/(id|code|count|qty|quantity|rate|hours|status|stage|date|month|year|vat|tax)/.test(n)) return -60;
      if (/^(value|amount|revenue|total|fee|fees|price|budget|arr|mrr|acv|tcv|dealvalue|jobvalue|contractvalue)$/.test(n)) return 100;
      if (/(est|estimated|expected|forecast|projected|target|total|net|gross|fixed|deal|job|project|contract).*(value|revenue|amount|fee|fees|budget|price)/.test(n)) return 95;
      if (/(value|revenue|amount|fee|fees|budget|price).*(est|estimated|expected|forecast|total|deal|job)/.test(n)) return 90;
      if (/(value|revenue|amount|fee|fees|budget|price)/.test(n)) return 70;
      return -50;
    }

    if (dim === "likeCol") {
      if (/(id|code|date|value|amount|rev)/.test(n) && !/(stage|status|state|prob)/.test(n)) return -60;
      if (/^(status|stage|dealstage|pipelinestage|salesstage|jobstatus|state|probability|prob|likelihood|confidence|phase|milestone)$/.test(n)) return 100;
      if (/(deal|job|opportunity|sales|pipeline|lead).*(stage|status|state|phase)/.test(n)) return 95;
      if (/(stage|status|probability|prob|likelihood|confidence|milestone|phase|weighting)/.test(n)) return 80;
      if (/(%|pct|percent)/.test(n)) return 50;
      return -50;
    }

    if (dim === "clientCol") {
      if (/(id|code|manager|owner|tier|type|status|date|address|phone|email)/.test(n)) return -50;
      if (/^(client|clientname|customer|customername|company|companyname|organisation|organization|account|accountname|lead|leadname|prospect|prospectname)$/.test(n)) return 100;
      if (/^(client|customer|company|org|account|lead|prospect)/.test(n)) return 80;
      if (/(client|customer|company|account|lead|prospect)/.test(n)) return 60;
      return -50;
    }

    if (dim === "jobCol") {
      if (/(client|customer|company|account|id|code|owner|type|status|stage|date|value|amount)/.test(n)) return -50;
      if (/^(job|jobname|jobtitle|deal|dealname|dealtitle|opportunity|opportunityname|project|projectname|task|taskname|natureofwork|scope|deliverable|engagement)$/.test(n)) return 100;
      if (/^(job|deal|opp|project|task|nature)/.test(n)) return 80;
      if (/(job|deal|opportunity|project|deliverable|scope)/.test(n)) return 60;
      if (/^(description|title|name)$/.test(n)) return 40;
      return -50;
    }

    return 0;
  }

  const dimensions = ["clientCol", "jobCol", "revCol", "startCol", "endCol", "likeCol"];
  const result = {};
  const usedHeaders = new Set();

  for (const dim of dimensions) {
    let bestHeader = "";
    let bestScore = 0;
    for (const h of headers) {
      if (usedHeaders.has(h)) continue;
      const score = scoreHeader(h, dim);
      if (score > bestScore) {
        bestScore = score;
        bestHeader = h;
      }
    }
    if (bestHeader) {
      result[dim] = bestHeader;
      usedHeaders.add(bestHeader);
    } else {
      result[dim] = "";
    }
  }

  if (!result.clientCol) result.clientCol = headers[0] || "";
  if (!result.jobCol) result.jobCol = (headers[1] && headers[1] !== result.clientCol) ? headers[1] : (headers[0] || "");

  return result;
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
  headerRowNum = null,
  clientKey = null,
  isAdmin = false
}) {
  const targetId = sheetId || (url ? extractSheetIdFromUrl(url) : null);
  if (!targetId) {
    throw new Error("Invalid or missing Google Sheet URL / ID");
  }
  if (targetId === DEFAULT_AC_SHEET_ID) {
    throw new Error("Cannot inspect internal Automation Commander spreadsheet.");
  }
  if (!accessToken) {
    const sheets = await getSheetsClient();
    const ownerClient = await resolveClientNameBySheetId(sheets, targetId);
    if (ownerClient && !isAdmin && (!clientKey || !matchesClientName(ownerClient, clientKey))) {
      throw new Error("Access denied: target spreadsheet belongs to another tenant.");
    }
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
      const errMsg = metaJson.error?.message || metaRes.statusText || "";
      if (metaRes.status === 403 || errMsg.toLowerCase().includes("permission") || errMsg.toLowerCase().includes("caller does not have permission")) {
        throw new Error("Your Google account does not have permission to access this Google Sheet. Please share the Google Sheet with your account (Viewer permissions) or sign in with an account that has access.");
      }
      if (metaRes.status === 404 || errMsg.toLowerCase().includes("not found")) {
        throw new Error("Google Sheet not found. Please verify the spreadsheet URL.");
      }
      throw new Error(`Google Sheets API error: ${errMsg}`);
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

  // Fetch sample rows (top 10 rows)
  try {
    if (accessToken) {
      const escapedTab = targetTab.replace(/'/g, "''");
      const rangeParam = encodeURIComponent(`'${escapedTab}'!1:10`);
      const sampleUrl = `https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values/${rangeParam}`;
      const sRes = await fetch(sampleUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      const sJson = await sRes.json();
      sampleData = sJson.values || [];
    } else {
      const sheets = await getSheetsClient();
      const sRes = await sheets.spreadsheets.values.get({
        spreadsheetId: targetId,
        range: `'${targetTab}'!1:10`
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
