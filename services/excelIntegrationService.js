/**
 * ============================================================================
 * MICROSOFT EXCEL CRM SERVICE
 * ============================================================================
 * 
 * Provides OAuth 2.0 flow, token management, workbook inspection, and KeyInfo
 * linking for Microsoft Excel CRM workbooks via Microsoft Graph API.
 * 
 * Authentication Support:
 * 1. User-delegated OAuth 2.0 (Microsoft 365 / OneDrive / SharePoint work accounts).
 * 2. Enterprise Client Credentials (Azure AD App Registration: Tenant ID, Client ID, Client Secret).
 */

import { getSheetsClient, withRetry } from "./sheetsClient.js";
import { redisClient } from "./redisClient.js";
import { detectCandidateHeaderRow, suggestCrmColumnMapping } from "./googleSheetService.js";

const MS_AUTH_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export const EXCEL_SCOPES = [
  "offline_access",
  "Files.Read.All",
  "Sites.Read.All",
  "User.Read"
];

/**
 * Builds the Microsoft OAuth initiation URL for connecting Excel CRM.
 */
export function buildExcelAuthUrl({ redirectUri, state }) {
  const clientId = process.env.EXCEL_AZURE_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  if (!clientId) {
    throw new Error("Missing EXCEL_AZURE_CLIENT_ID or AZURE_CLIENT_ID environment variable");
  }

  const url = new URL(MS_AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", EXCEL_SCOPES.join(" "));
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", state);

  return url.toString();
}

/**
 * Exchanges authorization code for Microsoft OAuth access and refresh tokens.
 */
export async function exchangeExcelCodeForTokens({ code, redirectUri }) {
  const clientId = process.env.EXCEL_AZURE_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.EXCEL_AZURE_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing EXCEL_AZURE_CLIENT_ID or AZURE_CLIENT_SECRET in environment");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const res = await fetch(MS_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Microsoft token exchange failed: ${data.error_description || data.error || res.statusText}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: data.expires_in || 3600,
    scope: data.scope || ""
  };
}

/**
 * Refreshes an expired Microsoft OAuth access token using a stored refresh token.
 */
export async function refreshExcelTokens(refreshToken) {
  const clientId = process.env.EXCEL_AZURE_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.EXCEL_AZURE_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing EXCEL_AZURE_CLIENT_ID or AZURE_CLIENT_SECRET in environment");
  }

  if (!refreshToken) {
    throw new Error("No refresh token provided to refreshExcelTokens");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const res = await fetch(MS_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Microsoft token refresh failed: ${data.error_description || data.error || res.statusText}`);
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || 3600
  };
}

/**
 * Acquires a Microsoft Graph access token using enterprise Azure Client Credentials.
 */
export async function getAzureClientCredentialsToken(tenantId, clientId, clientSecret) {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    scope: "https://graph.microsoft.com/.default",
    client_secret: clientSecret,
    grant_type: "client_credentials"
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Azure authentication failed: ${data.error_description || data.error || res.statusText}`);
  }

  return data.access_token;
}

/**
 * Inspects an Excel workbook via Microsoft Graph API.
 * Lists available worksheets, gets used range, and samples header columns.
 */
export async function inspectExcelWorkbook({
  driveId,
  fileId,
  sheetName = "",
  token = null,
  azureCredentials = null,
  headerRowNum = null
}) {
  let accessToken = token;
  if (!accessToken && azureCredentials) {
    accessToken = await getAzureClientCredentialsToken(
      azureCredentials.tenantId,
      azureCredentials.clientId,
      azureCredentials.clientSecret
    );
  }

  if (!accessToken) {
    throw new Error("No Microsoft Graph access token or Azure credentials available.");
  }

  if (!driveId || !fileId) {
    throw new Error("Missing driveId or fileId to inspect Excel workbook.");
  }

  // 1. List worksheets in the workbook
  const sheetsUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${fileId}/workbook/worksheets`;
  const sheetsRes = await fetch(sheetsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const sheetsData = await sheetsRes.json();

  if (!sheetsRes.ok) {
    throw new Error(`Graph API worksheets error: ${sheetsData.error?.message || sheetsRes.statusText}`);
  }

  const worksheets = (sheetsData.value || []).map((w) => ({
    id: w.id,
    name: w.name,
    position: w.position,
    visibility: w.visibility
  }));

  const targetWorksheet = sheetName || worksheets[0]?.name || "Sheet1";

  // 2. Fetch used range of target worksheet
  let headers = [];
  let sampleRows = [];
  let rangeAddress = "usedRange";
  let candidateHeaderRow = 1;
  let suggestedMapping = {};

  try {
    const rangeUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${fileId}/workbook/worksheets/${encodeURIComponent(targetWorksheet)}/usedRange?$select=address,values`;
    const rangeRes = await fetch(rangeUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const rangeData = await rangeRes.json();

    if (rangeRes.ok && Array.isArray(rangeData.values) && rangeData.values.length > 0) {
      rangeAddress = rangeData.address || "usedRange";
      // Clean sheet prefix from address (e.g. 'Sheet1'!A1:Z50 -> A1:Z50)
      if (rangeAddress.includes("!")) {
        rangeAddress = rangeAddress.split("!").pop();
      }
      const rawRows = rangeData.values.slice(0, 10);
      const detectedRow = detectCandidateHeaderRow(rawRows);
      candidateHeaderRow = headerRowNum ? Math.max(1, parseInt(headerRowNum, 10)) : detectedRow;
      const headerIdx = Math.max(0, candidateHeaderRow - 1);
      const rawHeaderRow = rangeData.values[headerIdx] || [];
      headers = rawHeaderRow.map((h) => String(h || "").trim()).filter(Boolean);
      suggestedMapping = suggestCrmColumnMapping(headers);
      sampleRows = rangeData.values.slice(headerIdx + 1, headerIdx + 4);
    }
  } catch (rangeErr) {
    console.warn("Note reading used range for Excel inspect:", rangeErr.message);
  }

  return {
    success: true,
    driveId,
    fileId,
    worksheets,
    defaultWorksheet: targetWorksheet,
    rangeAddress,
    headers,
    candidateHeaderRow,
    suggestedMapping,
    sampleRowsCount: sampleRows.length
  };
}

/**
 * Links Microsoft Excel parameters to Master Sheet KeyInfo (X33:X41)
 * and updates Redis setup state.
 */
export async function linkExcelToClient({
  clientKey,
  masterSheetId,
  tenantId = "",
  clientId = "",
  clientSecret = "",
  driveId,
  fileId,
  sheetName,
  rangeAddress = "",
  headerRowNum = "1",
  keyHeaders = ""
}) {
  if (!masterSheetId) throw new Error("Missing masterSheetId parameter");
  if (!driveId || !fileId || !sheetName) {
    throw new Error("Missing required Excel parameters (driveId, fileId, sheetName)");
  }

  const sheets = await getSheetsClient();
  const rowNumStr = String(headerRowNum || "1").trim();
  const cleanRange = String(rangeAddress || "").trim();
  const cleanKeyHeaders = String(keyHeaders || "").trim();

  const updates = [
    { range: "KeyInfo!X36", values: [[String(driveId || "").trim()]] },
    { range: "KeyInfo!X37", values: [[String(fileId || "").trim()]] },
    { range: "KeyInfo!X38", values: [[String(sheetName || "").trim()]] },
    { range: "KeyInfo!X39", values: [[cleanRange]] },
    { range: "KeyInfo!X40", values: [[rowNumStr]] },
    { range: "KeyInfo!X41", values: [[cleanKeyHeaders]] },
    { range: "KeyInfo!Q8", values: [["Excel"]] }
  ];

  if (tenantId || clientId || clientSecret) {
    updates.push(
      { range: "KeyInfo!X33", values: [[String(tenantId || "").trim()]] },
      { range: "KeyInfo!X34", values: [[String(clientId || "").trim()]] },
      { range: "KeyInfo!X35", values: [[String(clientSecret || "").trim()]] }
    );
  }

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: masterSheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates
      }
    })
  );

  // Update Redis cache
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
        crmTool: "Excel",
        excel: {
          ...(prev.excel || {}),
          driveId: String(driveId || "").trim(),
          fileId: String(fileId || "").trim(),
          sheetName: String(sheetName || "").trim(),
          range: cleanRange,
          columnRow: rowNumStr,
          keyHeaders: cleanKeyHeaders
        },
        updatedAt: new Date().toISOString()
      };
      await redisClient.set(redisKey, JSON.stringify(updated));
    } catch (e) {
      console.warn("Failed updating Redis setup cache for Excel link:", e);
    }
  }

  return {
    success: true,
    driveId,
    fileId,
    sheetName,
    rangeAddress: cleanRange,
    headerRowNum: rowNumStr,
    keyHeaders: cleanKeyHeaders
  };
}
