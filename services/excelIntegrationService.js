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

const MS_OAUTH_BASE = "https://login.microsoftonline.com";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXCEL_EXT_RE = /\.(xlsx|xlsm|xlsb|xls)$/i;

export const EXCEL_SCOPES = [
  "offline_access",
  "Files.Read.All",
  "Sites.Read.All",
  "User.Read"
];

function resolveOAuthTenant(tenantId) {
  const clean = String(tenantId || "").trim();
  if (!clean) return "common";
  if (clean === "common" || clean === "organizations" || clean === "consumers" || UUID_RE.test(clean)) {
    return clean;
  }
  throw new Error("Invalid Microsoft Entra tenantId format.");
}

/**
 * Discovers the Microsoft Entra tenant ID (GUID) for a *.sharepoint.com URL
 * via SharePoint's unauthenticated Bearer realm challenge so B2B guests
 * authenticate against the resource SharePoint tenant rather than their home tenant.
 * Returns "" if not a SharePoint Online URL or discovery fails.
 */
export async function discoverSharePointTenantId(sharingUrl) {
  if (!sharingUrl) return "";
  try {
    const u = new URL(String(sharingUrl).trim());
    if (u.protocol !== "https:" || !/^[A-Za-z0-9-]+\.sharepoint\.com$/i.test(u.hostname)) {
      return "";
    }
    const res = await fetch(`https://${u.hostname}/_vti_bin/client.svc`, {
      method: "GET",
      headers: { Authorization: "Bearer" },
      signal: AbortSignal.timeout(2500)
    });
    const authHeader = res.headers.get("www-authenticate") || "";
    const match = authHeader.match(/realm="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
    return match ? match[1] : "";
  } catch (err) {
    console.warn("SharePoint tenant discovery note:", err.message);
    return "";
  }
}

/**
 * Builds the Microsoft OAuth initiation URL for connecting Excel CRM.
 */
export function buildExcelAuthUrl({ redirectUri, state, tenantId = "common" }) {
  const clientId = process.env.EXCEL_AZURE_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  if (!clientId) {
    throw new Error("Missing EXCEL_AZURE_CLIENT_ID or AZURE_CLIENT_ID environment variable");
  }

  const tenant = resolveOAuthTenant(tenantId);
  const url = new URL(`${MS_OAUTH_BASE}/${tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", EXCEL_SCOPES.join(" "));
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", state);

  return url.toString();
}

function formatMicrosoftOAuthError(data, statusText) {
  const errCode = String(data?.error || "").trim();
  const errDesc = String(data?.error_description || "").trim();
  if (errCode && errDesc) {
    return errDesc.toLowerCase().includes(errCode.toLowerCase())
      ? errDesc
      : `${errCode}: ${errDesc}`;
  }
  return errDesc || errCode || statusText || "Unknown Microsoft OAuth error";
}

/**
 * Exchanges authorization code for Microsoft OAuth access and refresh tokens.
 */
export async function exchangeExcelCodeForTokens({ code, redirectUri, tenantId = "common" }) {
  const clientId = process.env.EXCEL_AZURE_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.EXCEL_AZURE_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing EXCEL_AZURE_CLIENT_ID or AZURE_CLIENT_SECRET in environment");
  }

  const tenant = resolveOAuthTenant(tenantId);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const res = await fetch(`${MS_OAUTH_BASE}/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Microsoft token exchange failed: ${formatMicrosoftOAuthError(data, res.statusText)}`);
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
export async function refreshExcelTokens(refreshToken, tenantId = "common") {
  const clientId = process.env.EXCEL_AZURE_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.EXCEL_AZURE_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing EXCEL_AZURE_CLIENT_ID or AZURE_CLIENT_SECRET in environment");
  }

  if (!refreshToken) {
    throw new Error("No refresh token provided to refreshExcelTokens");
  }

  const tenant = resolveOAuthTenant(tenantId);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const res = await fetch(`${MS_OAUTH_BASE}/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Microsoft token refresh failed: ${formatMicrosoftOAuthError(data, res.statusText)}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: data.expires_in || 3600
  };
}

const SAFE_GRAPH_ID_RE = /^[A-Za-z0-9!._,-]+$/;

/**
 * Validates Microsoft Graph identifiers (driveId, fileId, siteId, tenantId) to prevent
 * path traversal / authenticated SSRF against arbitrary Graph endpoints (HIGH-04 remediation).
 */
export function assertSafeGraphId(value, fieldName = "identifier") {
  const str = String(value || "").trim();
  if (!str || str.includes("..") || str.includes("/") || str.includes("\\") || !SAFE_GRAPH_ID_RE.test(str)) {
    throw new Error(`Invalid Microsoft Graph ${fieldName} format.`);
  }
  return encodeURIComponent(str);
}

/**
 * Acquires a Microsoft Graph access token using enterprise Azure Client Credentials.
 */
export async function getAzureClientCredentialsToken(tenantId, clientId, clientSecret) {
  const safeTenant = assertSafeGraphId(tenantId, "tenantId");
  const tokenUrl = `https://login.microsoftonline.com/${safeTenant}/oauth2/v2.0/token`;
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

function parseExcelUrlHints(cleanUrl) {
  try {
    const u = new URL(cleanUrl);
    const pathname = u.pathname || "";
    const isDocViewerUrl = /_layouts\/\d+\/Doc\.aspx/i.test(pathname) || /^\/:[a-z]:\/r\//i.test(pathname);
    const isSharingLink = /^\/:[a-z]:\/[sg]\//i.test(pathname) || u.hostname.toLowerCase() === "1drv.ms";
    const rawSourceDoc = (u.searchParams.get("sourcedoc") || "").replace(/[{}]/g, "").trim();
    const sourcedocGuid = UUID_RE.test(rawSourceDoc) ? rawSourceDoc : "";
    const queryFileName = (u.searchParams.get("file") || "").trim();
    const lastSegment = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
    const pathFileName = EXCEL_EXT_RE.test(lastSegment) ? lastSegment : "";
    const fileName = queryFileName || pathFileName;
    const siteMatch = pathname.match(/\/(sites|teams)\/([^/]+)/i);
    return {
      url: u,
      hostname: u.hostname,
      pathname,
      isDocViewerUrl,
      isSharingLink,
      sourcedocGuid,
      fileName,
      siteMatch: siteMatch ? { prefix: siteMatch[1].toLowerCase(), name: siteMatch[2] } : null
    };
  } catch {
    return null;
  }
}

function isAccessDeniedGraphResponse(res, data) {
  const errMsg = (data?.error?.message || "").toLowerCase();
  return (
    res.status === 403 ||
    res.status === 401 ||
    data?.error?.code === "accessDenied" ||
    errMsg.includes("access denied") ||
    errMsg.includes("permission") ||
    errMsg.includes("unauthorized")
  );
}

async function fetchGraphJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function resolveViaSharesEndpoint(urlStr, token) {
  const base64Val = Buffer.from(urlStr).toString("base64");
  const encodedShare = "u!" + base64Val.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  const { res, data } = await fetchGraphJson(
    `https://graph.microsoft.com/v1.0/shares/${encodedShare}/driveItem?$select=id,name,parentReference`,
    token
  );
  if (res.ok && data.id && data.parentReference?.driveId) {
    return {
      item: {
        fileId: data.id,
        driveId: data.parentReference.driveId,
        name: data.name
      },
      accessDenied: false
    };
  }
  return {
    item: null,
    accessDenied: isAccessDeniedGraphResponse(res, data)
  };
}

async function findDriveItemInDrive({ driveId, fileName, sourcedocGuid, token }) {
  const safeDriveId = assertSafeGraphId(driveId, "driveId");
  let accessDenied = false;

  if (sourcedocGuid) {
    const { res, data } = await fetchGraphJson(
      `https://graph.microsoft.com/v1.0/drives/${safeDriveId}/items/${encodeURIComponent(sourcedocGuid)}?$select=id,name,parentReference`,
      token
    );
    if (res.ok && data.id) {
      return {
        item: {
          fileId: data.id,
          driveId: data.parentReference?.driveId || driveId,
          name: data.name
        },
        accessDenied: false
      };
    }
    if (isAccessDeniedGraphResponse(res, data)) {
      accessDenied = true;
    }
  }

  if (fileName) {
    const escapedQuery = fileName.replace(/'/g, "''");
    const { res, data } = await fetchGraphJson(
      `https://graph.microsoft.com/v1.0/drives/${safeDriveId}/root/search(q='${encodeURIComponent(escapedQuery)}')?$select=id,name,parentReference,sharepointIds`,
      token
    );
    if (res.ok && Array.isArray(data.value)) {
      const normalizedGuid = sourcedocGuid ? sourcedocGuid.toLowerCase() : "";
      const guidMatch = normalizedGuid
        ? data.value.find(
            (it) => (it.sharepointIds?.listItemUniqueId || "").replace(/[{}]/g, "").toLowerCase() === normalizedGuid
          )
        : null;
      const nameMatch = data.value.find((it) => (it.name || "").toLowerCase() === fileName.toLowerCase());
      const matchItem = guidMatch || nameMatch;
      if (matchItem) {
        return {
          item: {
            fileId: matchItem.id,
            driveId: matchItem.parentReference?.driveId || driveId,
            name: matchItem.name
          },
          accessDenied: false
        };
      }
    } else if (isAccessDeniedGraphResponse(res, data)) {
      accessDenied = true;
    }
  }

  return { item: null, accessDenied };
}

/**
 * Resolves a SharePoint or OneDrive web sharing URL into a Drive ID and File (DriveItem) ID
 * via Microsoft Graph API shares endpoint with intelligent fallbacks (including Doc.aspx viewer URLs).
 */
export async function resolveSharePointDriveItem({ sharingUrl, token }) {
  if (!sharingUrl) throw new Error("Missing sharingUrl to resolve");
  if (!token) throw new Error("Missing access token to resolve sharing URL");

  const cleanUrl = sharingUrl.trim();
  const hints = parseExcelUrlHints(cleanUrl);
  let isAccessDenied = false;

  // Strategy 1: Microsoft Graph /shares endpoint with original URL
  // Note: /shares often rejects _layouts/15/Doc.aspx viewer URLs with 403 even when the user has access,
  // so only treat /shares accessDenied as authoritative when the URL is not a Doc.aspx viewer URL.
  try {
    const attempt1 = await resolveViaSharesEndpoint(cleanUrl, token);
    if (attempt1.item) return attempt1.item;
    if (attempt1.accessDenied && !hints?.isDocViewerUrl) {
      isAccessDenied = true;
    }
  } catch (err) {
    console.warn("Shares endpoint attempt 1 note:", err.message);
  }

  // Strategy 2: If URL had query string (and is not a Doc.aspx viewer URL relying on ?sourcedoc=), try /shares without query string
  if (cleanUrl.includes("?") && !hints?.isDocViewerUrl) {
    try {
      const attempt2 = await resolveViaSharesEndpoint(cleanUrl.split("?")[0], token);
      if (attempt2.item) return attempt2.item;
      if (attempt2.accessDenied) {
        isAccessDenied = true;
      }
    } catch (err) {
      console.warn("Shares endpoint attempt 2 note:", err.message);
    }
  }

  // Strategy 3: Personal OneDrive (-my.sharepoint.com/personal/)
  if (cleanUrl.includes("-my.sharepoint.com/personal/")) {
    try {
      const { res: driveRes, data: driveData } = await fetchGraphJson(
        "https://graph.microsoft.com/v1.0/me/drive?$select=id,name",
        token
      );
      if (driveRes.ok && driveData.id) {
        const myDriveId = assertSafeGraphId(driveData.id, "driveId");
        const urlWithoutQuery = cleanUrl.split("?")[0];
        const match = urlWithoutQuery.match(/\/Documents\/(.+)$/i);
        if (match && match[1]) {
          const relativePath = decodeURIComponent(match[1]);
          const { res: itemRes, data: itemData } = await fetchGraphJson(
            `https://graph.microsoft.com/v1.0/drives/${myDriveId}/root:/${encodeURIComponent(relativePath)}?$select=id,name,parentReference`,
            token
          );
          if (itemRes.ok && itemData.id) {
            return {
              fileId: itemData.id,
              driveId: itemData.parentReference?.driveId || driveData.id,
              name: itemData.name
            };
          }
          if (isAccessDeniedGraphResponse(itemRes, itemData)) {
            isAccessDenied = true;
          }
        }

        const found = await findDriveItemInDrive({
          driveId: driveData.id,
          fileName: hints?.fileName || "",
          sourcedocGuid: hints?.sourcedocGuid || "",
          token
        });
        if (found.item) return found.item;
        if (found.accessDenied) isAccessDenied = true;
      } else if (isAccessDeniedGraphResponse(driveRes, driveData)) {
        isAccessDenied = true;
      }
    } catch (meDriveErr) {
      console.warn("me/drive fallback note:", meDriveErr.message);
    }
  }

  // Strategy 4: SharePoint team or root site (handles /sites/{name}, /teams/{name}, and Doc.aspx?sourcedoc=...&file=...)
  if (hints && /^[A-Za-z0-9.-]+\.sharepoint\.com$/i.test(hints.hostname) && !hints.hostname.toLowerCase().includes("-my.sharepoint.com")) {
    try {
      const siteLookupUrl = hints.siteMatch
        ? `https://graph.microsoft.com/v1.0/sites/${hints.hostname}:/${hints.siteMatch.prefix}/${encodeURIComponent(hints.siteMatch.name)}?$select=id,name`
        : `https://graph.microsoft.com/v1.0/sites/${hints.hostname}?$select=id,name`;

      const { res: siteRes, data: siteData } = await fetchGraphJson(siteLookupUrl, token);
      if (siteRes.ok && siteData.id) {
        const safeSiteId = assertSafeGraphId(siteData.id, "siteId");

        // Enumerate all document libraries on the site so non-default libraries are searched too
        const { res: drivesRes, data: drivesData } = await fetchGraphJson(
          `https://graph.microsoft.com/v1.0/sites/${safeSiteId}/drives?$select=id,name,webUrl`,
          token
        );
        let drives = drivesRes.ok && Array.isArray(drivesData.value) ? drivesData.value : [];
        if (drives.length === 0) {
          if (isAccessDeniedGraphResponse(drivesRes, drivesData)) {
            isAccessDenied = true;
          }
          const { res: defaultDriveRes, data: defaultDriveData } = await fetchGraphJson(
            `https://graph.microsoft.com/v1.0/sites/${safeSiteId}/drive?$select=id,name`,
            token
          );
          if (defaultDriveRes.ok && defaultDriveData.id) {
            drives = [defaultDriveData];
          } else if (isAccessDeniedGraphResponse(defaultDriveRes, defaultDriveData)) {
            isAccessDenied = true;
          }
        }

        for (const drive of drives) {
          if (!drive?.id) continue;
          const found = await findDriveItemInDrive({
            driveId: drive.id,
            fileName: hints.fileName,
            sourcedocGuid: hints.sourcedocGuid,
            token
          });
          if (found.item) return found.item;
          if (found.accessDenied) isAccessDenied = true;
        }
      } else if (isAccessDeniedGraphResponse(siteRes, siteData)) {
        isAccessDenied = true;
      }
    } catch (siteErr) {
      console.warn("SharePoint site search fallback note:", siteErr.message);
    }
  }

  if (isAccessDenied) {
    throw new Error("Your Microsoft 365 account does not have permission to access this Excel workbook. Please ensure the file is shared with your account on OneDrive or SharePoint.");
  }

  throw new Error("Could not resolve Excel link. Please ensure the link is a valid OneDrive or SharePoint link and that your signed-in account has access to it.");
}

/**
 * Inspects an Excel workbook via Microsoft Graph API.
 * Lists available worksheets, gets used range, and samples header columns.
 */
export async function inspectExcelWorkbook({
  url = null,
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

  let resolvedDriveId = driveId;
  let resolvedFileId = fileId;
  if ((!resolvedDriveId || !resolvedFileId) && url) {
    const resolved = await resolveSharePointDriveItem({ sharingUrl: url, token: accessToken });
    resolvedDriveId = resolved.driveId;
    resolvedFileId = resolved.fileId;
  }

  if (!resolvedDriveId || !resolvedFileId) {
    throw new Error("Could not access Excel workbook. Please ensure your Microsoft 365 account has permission to access this SharePoint or OneDrive file, and that the link is correct.");
  }

  const safeDriveId = assertSafeGraphId(resolvedDriveId, "driveId");
  const safeFileId = assertSafeGraphId(resolvedFileId, "fileId");

  // 1. List worksheets in the workbook
  const sheetsUrl = `https://graph.microsoft.com/v1.0/drives/${safeDriveId}/items/${safeFileId}/workbook/worksheets`;
  const sheetsRes = await fetch(sheetsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const sheetsData = await sheetsRes.json();

  if (!sheetsRes.ok) {
    const errMsg = sheetsData.error?.message || sheetsRes.statusText || "";
    if (sheetsRes.status === 403 || errMsg.toLowerCase().includes("access denied") || errMsg.toLowerCase().includes("permission")) {
      throw new Error("Your Microsoft 365 account does not have permission to access this Excel workbook. Please ensure the file is shared with your account on OneDrive or SharePoint.");
    }
    throw new Error(`Graph API worksheets error: ${errMsg}`);
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
    const rangeUrl = `https://graph.microsoft.com/v1.0/drives/${safeDriveId}/items/${safeFileId}/workbook/worksheets/${encodeURIComponent(targetWorksheet)}/usedRange?$select=address,values`;
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
    driveId: resolvedDriveId,
    fileId: resolvedFileId,
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
  url = "",
  driveId,
  fileId,
  sheetName,
  rangeAddress = "",
  headerRowNum = "1",
  keyHeaders = ""
}) {
  if (!masterSheetId) throw new Error("Missing masterSheetId parameter");

  let resolvedDriveId = driveId;
  let resolvedFileId = fileId;
  if ((!resolvedDriveId || !resolvedFileId) && url) {
    const { getIntegrationTokens } = await import("./vaultService.js");
    const grant = await getIntegrationTokens({ clientKey, tool: "excel" });
    if (grant?.tokens?.accessToken) {
      const resolved = await resolveSharePointDriveItem({ sharingUrl: url, token: grant.tokens.accessToken });
      resolvedDriveId = resolved.driveId;
      resolvedFileId = resolved.fileId;
    }
  }

  if (!resolvedDriveId || !resolvedFileId || !sheetName) {
    throw new Error("Missing required Excel parameters (driveId, fileId, sheetName)");
  }

  assertSafeGraphId(resolvedDriveId, "driveId");
  assertSafeGraphId(resolvedFileId, "fileId");
  if (tenantId) assertSafeGraphId(tenantId, "tenantId");

  const sheets = await getSheetsClient();
  const rowNumStr = String(headerRowNum || "1").trim();
  const cleanRange = String(rangeAddress || "").trim();
  const cleanKeyHeaders = String(keyHeaders || "").trim();
  const safeCell = (v) => {
    const s = String(v || "").trim();
    return /^[=+\-@|\t\r]/.test(s) ? `'${s}` : s;
  };

  const updates = [
    { range: "KeyInfo!X36", values: [[safeCell(resolvedDriveId)]] },
    { range: "KeyInfo!X37", values: [[safeCell(resolvedFileId)]] },
    { range: "KeyInfo!X38", values: [[safeCell(sheetName)]] },
    { range: "KeyInfo!X39", values: [[safeCell(cleanRange)]] },
    { range: "KeyInfo!X40", values: [[safeCell(rowNumStr)]] },
    { range: "KeyInfo!X41", values: [[safeCell(cleanKeyHeaders)]] },
    { range: "KeyInfo!Q8", values: [["Excel"]] }
  ];

  if (tenantId || clientId || clientSecret) {
    updates.push(
      { range: "KeyInfo!X33", values: [[safeCell(tenantId)]] },
      { range: "KeyInfo!X34", values: [[safeCell(clientId)]] },
      { range: "KeyInfo!X35", values: [[safeCell(clientSecret)]] }
    );
  }

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: masterSheetId,
      requestBody: {
        valueInputOption: "RAW",
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
          driveId: String(resolvedDriveId || "").trim(),
          fileId: String(resolvedFileId || "").trim(),
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
    driveId: resolvedDriveId,
    fileId: resolvedFileId,
    sheetName,
    rangeAddress: cleanRange,
    headerRowNum: rowNumStr,
    keyHeaders: cleanKeyHeaders
  };
}
