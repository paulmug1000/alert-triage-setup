/**
 * ============================================================================
 * XERO SERVICE - OAUTH 2.0 PROTOCOL & API WRAPPER
 * ============================================================================
 * 
 * Handles Xero's official OAuth 2.0 Authorization Code flow with PKCE,
 * token exchange, tenant resolution (/connections), automated token refresh,
 * and token revocation.
 */

import crypto from "crypto";

const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
const XERO_REVOCATION_URL = "https://identity.xero.com/connect/revocation";

// Full required scopes for Pulse invoice, tracking, and P&L sync
export const XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.transactions",
  "accounting.settings",
  "accounting.reports.read",
  "offline_access"
].join(" ");

/**
 * Returns configured Xero credentials from environment.
 */
export function getXeroCredentials() {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing XERO_CLIENT_ID or XERO_CLIENT_SECRET environment variable.");
  }

  return { clientId, clientSecret };
}

/**
 * Generates the Xero authorization consent URL with PKCE (RFC 7636).
 * 
 * @param {Object} params
 * @param {string} params.redirectUri
 * @param {string} params.state
 * @param {string} [params.codeChallenge]
 * @returns {string} Fully qualified authorization URL
 */
export function buildXeroAuthUrl({ redirectUri, state, codeChallenge }) {
  const { clientId } = getXeroCredentials();

  const url = new URL(XERO_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", XERO_SCOPES);
  url.searchParams.set("state", state);

  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  return url.toString();
}

/**
 * Exchanges the authorization code for tokens.
 * 
 * @param {Object} params
 * @param {string} params.code
 * @param {string} params.redirectUri
 * @param {string} [params.codeVerifier]
 * @returns {Promise<Object>} { accessToken, refreshToken, idToken, expiresIn, tokenType, scope }
 */
export async function exchangeCodeForTokens({ code, redirectUri, codeVerifier }) {
  const { clientId, clientSecret } = getXeroCredentials();

  const bodyParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });

  if (codeVerifier) {
    bodyParams.set("code_verifier", codeVerifier);
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: bodyParams.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.error_description || data.error || JSON.stringify(data);
    throw new Error(`Xero token exchange failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token || "",
    expiresIn: data.expires_in || 1800,
    tokenType: data.token_type || "Bearer",
    scope: data.scope || ""
  };
}

/**
 * Fetches authorized Xero organisations (tenants) for this token.
 * 
 * @param {string} accessToken
 * @returns {Promise<Array<{ id: string, tenantId: string, tenantType: string, tenantName: string, createdDateUtc: string }>>}
 */
export async function getXeroConnections(accessToken) {
  const res = await fetch(XERO_CONNECTIONS_URL, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch Xero connections (${res.status}): ${errorText}`);
  }

  const connections = await res.json();
  return connections.map(conn => ({
    id: conn.id,
    tenantId: conn.tenantId,
    tenantType: conn.tenantType,
    tenantName: conn.tenantName,
    createdDateUtc: conn.createdDateUtc
  }));
}

/**
 * Refreshes an expired or expiring access token using the rolling refresh token.
 * Xero returns a new access token AND a new rolling refresh token.
 * 
 * @param {string} refreshToken
 * @returns {Promise<Object>} { accessToken, refreshToken, expiresIn }
 */
export async function refreshXeroTokens(refreshToken) {
  const { clientId, clientSecret } = getXeroCredentials();

  const bodyParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: bodyParams.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.error_description || data.error || JSON.stringify(data);
    throw new Error(`Xero token refresh failed: ${errorMsg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 1800,
    tokenType: data.token_type || "Bearer"
  };
}

/**
 * Revokes a Xero token when a user clicks "Disconnect" (required for security audit).
 * 
 * @param {string} token Can be either access_token or refresh_token
 * @returns {Promise<boolean>}
 */
export async function revokeXeroToken(token) {
  const { clientId, clientSecret } = getXeroCredentials();

  const bodyParams = new URLSearchParams({
    token
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const res = await fetch(XERO_REVOCATION_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyParams.toString()
    });

    return res.ok || res.status === 200;
  } catch (err) {
    console.warn("⚠️ Xero revocation call failed:", err.message);
    return false;
  }
}

/**
 * Fetches bank accounts from Xero Accounting API for a specific tenant.
 * 
 * @param {string} accessToken Active access token
 * @param {string} tenantId Authorized Xero tenant/organisation ID
 * @returns {Promise<Array<{ id: string, name: string, code: string, accountNumber: string, currency: string, status: string, type: string }>>}
 */
export async function fetchXeroBankAccounts(accessToken, tenantId) {
  if (!accessToken || !tenantId) {
    throw new Error("Missing accessToken or tenantId for fetchXeroBankAccounts");
  }

  const url = "https://api.xero.com/api.xro/2.0/Accounts?where=Type%3D%3D%22BANK%22";
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Xero-tenant-id": tenantId,
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Xero API error (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const rawAccounts = data?.Accounts || [];

  return rawAccounts.map(acc => ({
    id: acc.AccountID || "",
    name: acc.Name || "",
    code: acc.Code || "",
    accountNumber: acc.BankAccountNumber || "",
    currency: acc.CurrencyCode || "",
    status: acc.Status || "ACTIVE",
    type: acc.Type || "BANK"
  }));
}

export function parseXeroDate(val, dateString) {
  // If dateString is already ISO-like "YYYY-MM-DD...", slice first 10 characters directly to avoid UTC shift
  if (dateString && typeof dateString === "string") {
    const m = dateString.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  if (!val) return "";
  if (typeof val === "string") {
    const isoMatch = val.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];

    if (val.includes("/Date(")) {
      const match = val.match(/\/Date\((\d+)([+-]\d{4})?\)\//);
      if (match) {
        const ms = parseInt(match[1], 10);
        let offsetMs = 0;
        if (match[2]) {
          const sign = match[2][0] === "+" ? 1 : -1;
          const hours = parseInt(match[2].slice(1, 3), 10);
          const mins = parseInt(match[2].slice(3, 5), 10);
          offsetMs = sign * (hours * 60 + mins) * 60 * 1000;
        }
        const localD = new Date(ms + offsetMs);
        return localD.toISOString().split("T")[0];
      }
    }
  }
  const d = new Date(val);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return String(val);
}


/**
 * Fetches reconciled bank transactions, invoice/bill payments, and transfers for a specific bank account.
 * 
 * @param {Object} params
 * @param {string} params.accessToken
 * @param {string} params.tenantId
 * @param {string} params.accountId Xero Bank Account ID (GUID)
 * @param {string} params.startDate YYYY-MM-DD
 * @param {string} params.endDate YYYY-MM-DD
 * @returns {Promise<Array<Object>>} Normalized bank transaction objects
 */
export async function fetchXeroAccountTransactions({ accessToken, tenantId, accountId, startDate, endDate }) {
  if (!accessToken || !tenantId || !accountId) {
    throw new Error("Missing accessToken, tenantId, or accountId for fetchXeroAccountTransactions");
  }

  const [startY, startM, startD] = startDate.split("-").map(Number);
  const [endY, endM, endD] = endDate.split("-").map(Number);
  const dateClause = `Date>=DateTime(${startY},${startM},${startD}) AND Date<=DateTime(${endY},${endM},${endD})`;

  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Xero-tenant-id": tenantId,
    "Accept": "application/json"
  };

  const results = [];

  // 1. Fetch direct Spend/Receive Bank Transactions
  try {
    const btUrl = `https://api.xero.com/api.xro/2.0/BankTransactions?where=BankAccount.AccountID%3D%3Dguid(%22${accountId}%22)%20AND%20${encodeURIComponent(dateClause)}`;
    const btRes = await fetch(btUrl, { method: "GET", headers });
    if (btRes.ok) {
      const btData = await btRes.json();
      (btData?.BankTransactions || []).forEach(tx => {
        if (tx.Status === "DELETED") return;
        // Skip transfer transactions: they are retrieved with full from/to account context by BankTransfers below
        if (String(tx.Type || "").toUpperCase().includes("TRANSFER")) return;

        const rawDate = parseXeroDate(tx.Date, tx.DateString);
        const isSpend = String(tx.Type || "").toUpperCase().startsWith("SPEND");
        const total = Math.abs(parseFloat(tx.Total) || 0);
        const contactName = tx.Contact?.Name || "";
        const lineDesc = (tx.LineItems || []).map(li => li.Description).filter(Boolean).join("; ") || tx.Reference || "";
        const accountCode = tx.LineItems?.[0]?.AccountCode || "";

        results.push({
          sourceId: tx.BankTransactionID,
          sourceType: "xero_bank_transaction",
          date: rawDate,
          payee: contactName,
          particulars: lineDesc || contactName,
          reference: tx.Reference || "",
          outAmount: isSpend ? total : 0,
          inAmount: !isSpend ? total : 0,
          rawType: tx.Type,
          accountCode,
          isReconciled: true
        });
      });
    }
  } catch (err) {
    console.warn("⚠️ Error fetching Xero BankTransactions:", err.message);
  }

  // 2. Fetch Invoice & Bill Payments tied to this Bank Account
  try {
    const payUrl = `https://api.xero.com/api.xro/2.0/Payments?where=Account.AccountID%3D%3Dguid(%22${accountId}%22)%20AND%20${encodeURIComponent(dateClause)}`;
    const payRes = await fetch(payUrl, { method: "GET", headers });
    if (payRes.ok) {
      const payData = await payRes.json();
      (payData?.Payments || []).forEach(p => {
        if (p.Status === "DELETED") return;
        const rawDate = parseXeroDate(p.Date, p.DateString);
        const total = Math.abs(parseFloat(p.Amount) || 0);
        const isReceive = p.PaymentType === "ACCRECPAYMENT"; // Customer paid invoice
        const contactName = p.Invoice?.Contact?.Name || "";
        const invoiceNum = p.Invoice?.InvoiceNumber || p.Reference || "";
        const particulars = p.Invoice ? `${p.Invoice.Type === "ACCREC" ? "Invoice" : "Bill"} ${invoiceNum} payment` : (p.Reference || "Payment");

        results.push({
          sourceId: p.PaymentID,
          sourceType: isReceive ? "xero_customer_payment" : "xero_supplier_payment",
          date: rawDate,
          payee: contactName,
          particulars,
          reference: invoiceNum,
          outAmount: isReceive ? 0 : total,
          inAmount: isReceive ? total : 0,
          rawType: p.PaymentType,
          invoiceNumber: invoiceNum,
          isReconciled: true,
          // If customer paid sales invoice, category is definitively Revenue
          suggestedCategory: isReceive ? "Revenue" : null
        });
      });
    }
  } catch (err) {
    console.warn("⚠️ Error fetching Xero Payments:", err.message);
  }

  // 3. Fetch Bank Transfers
  try {
    const xferUrl = `https://api.xero.com/api.xro/2.0/BankTransfers?where=${encodeURIComponent(dateClause)}`;
    const xferRes = await fetch(xferUrl, { method: "GET", headers });
    if (xferRes.ok) {
      const xferData = await xferRes.json();
      (xferData?.BankTransfers || []).forEach(xf => {
        const fromId = xf.FromBankAccount?.AccountID;
        const toId = xf.ToBankAccount?.AccountID;
        const isFrom = fromId === accountId;
        const isTo = toId === accountId;
        if (!isFrom && !isTo) return;

        const rawDate = parseXeroDate(xf.Date, xf.DateString);
        const total = Math.abs(parseFloat(xf.Amount) || 0);
        const otherAccountName = isFrom ? (xf.ToBankAccount?.Name || "Other Account") : (xf.FromBankAccount?.Name || "Other Account");

        results.push({
          sourceId: xf.BankTransferID,
          sourceType: "xero_bank_transfer",
          date: rawDate,
          payee: `Transfer ${isFrom ? "to" : "from"} ${otherAccountName}`,
          particulars: `Bank Transfer: ${xf.FromBankAccount?.Name || ""} -> ${xf.ToBankAccount?.Name || ""}`,
          reference: xf.Reference || "Transfer",
          outAmount: isFrom ? total : 0,
          inAmount: isTo ? total : 0,
          rawType: "TRANSFER",
          isReconciled: true,
          suggestedCategory: "Transfer"
        });
      });
    }
  } catch (err) {
    console.warn("⚠️ Error fetching Xero BankTransfers:", err.message);
  }

  return results;
}

