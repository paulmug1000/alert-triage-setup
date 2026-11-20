/**
 * ============================================================================
 * QUICKBOOKS OAUTH CALLBACK ROUTE: /api/integrations/quickbooks/callback
 * ============================================================================
 * 
 * Receives the redirect from Intuit with the authorization code, realmId, and state token.
 * Validates PKCE and state nonces, exchanges the code for OAuth tokens,
 * resolves company metadata via QuickBooks API, encrypts credentials into the Vault,
 * and updates the Master Sheet's KeyInfo!X3 cell with the realmId.
 */

import { exchangeQBCodeForTokens, getQBCompanyInfo, assertValidQBRealmId } from "../../../../services/quickbooksService.js";
import { saveIntegrationTokens } from "../../../../services/vaultService.js";
import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "../../../../services/sheetsClient.js";
import { DEFAULT_AC_SHEET_ID, matchesClientName } from "../../../../services/userPermissions.js";
import { verifySignedOAuthState, safeCompareSecret, verifyCallbackSessionInitiator, getTrustedClientIp, checkRateLimit } from "../../../../services/authService.js";
import { notifyStaffOnClientConnection } from "../../../../services/connectionNotifier.js";
import { sanitizeRedirectUrl, resolveCanonicalOAuthHost, sanitizeSpreadsheetTerms } from "../../../../utils/helpers.js";

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return acc;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) {
      try { acc[k] = decodeURIComponent(v); } catch { acc[k] = v; }
    }
    return acc;
  }, {});
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rl = await checkRateLimit("oauth-int-callback", getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ error: "Too many OAuth callback requests. Please retry shortly." });
  }

  const { code, state, realmId, error, error_description } = req.query;

  // 1. Verify HMAC-signed state early to extract redirectBack and client context (CRIT-02 & HIGH-06)
  const statePayload = state ? verifySignedOAuthState(String(state)) : null;

  let returnUrl = sanitizeRedirectUrl(statePayload?.redirectBack, "/pulse");
  if (returnUrl.startsWith("/pma") && !returnUrl.includes("nav=")) {
    const sep = returnUrl.includes("?") ? "&" : "?";
    returnUrl = `${returnUrl}${sep}nav=integrations`;
  }
  const clientKey = statePayload?.clientKey || statePayload?.clientName || "";
  const clientName = statePayload?.clientName || clientKey;
  const masterSheetId = statePayload?.masterSheetId;

  // 2. Handle user cancellation or denial gracefully
  if (error) {
    console.warn("⚠️ QuickBooks OAuth cancelled or denied by user:", error, error_description);
    const sep = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${sep}integration=quickbooks&status=denied&error=${encodeURIComponent(error_description || error)}${clientParam}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: "Missing authorization code or state parameter." });
  }

  // Parse cookies
  const cookies = parseCookies(req.headers.cookie);
  const savedNonce = cookies.pulse_qb_nonce;
  const codeVerifier = cookies.pulse_qb_verifier;

  // Clear state cookies immediately
  const isProd = process.env.NODE_ENV === "production";
  const clearCookieOptions = `Path=/api/integrations/quickbooks; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", [
    `pulse_qb_nonce=; ${clearCookieOptions}`,
    `pulse_qb_verifier=; ${clearCookieOptions}`
  ]);

  if (!savedNonce || !statePayload?.nonce || !safeCompareSecret(String(statePayload.nonce), String(savedNonce))) {
    return res.status(403).json({ error: "State nonce verification failed (potential CSRF attempt)." });
  }

  const initiatorCheck = await verifyCallbackSessionInitiator(req, res, statePayload);
  if (!initiatorCheck.ok) {
    return res.status(403).json({ error: initiatorCheck.error });
  }

  try {
    const { host, proto } = resolveCanonicalOAuthHost(req);
    const redirectUri = `${proto}://${host}/api/integrations/quickbooks/callback`;

    const activeRealmId = realmId ? assertValidQBRealmId(realmId) : "";

    // 1. Exchange authorization code for tokens
    const tokens = await exchangeQBCodeForTokens({
      code,
      redirectUri,
      codeVerifier
    });

    const clientKey = statePayload.clientKey || statePayload.clientName;
    const clientName = statePayload.clientName || clientKey;
    let masterSheetId = statePayload.masterSheetId;

    // Fallback: If masterSheetId wasn't passed in statePayload, resolve it from AutoUpdates
    if (!masterSheetId && clientName) {
      try {
        const sheets = await getSheetsClient();
        const resp = await sheets.spreadsheets.values.get({
          spreadsheetId: DEFAULT_AC_SHEET_ID,
          range: "AutoUpdates!A2:N500"
        });
        const rows = resp.data.values || [];
        const match = rows.find(r => matchesClientName(r[0], clientName));
        if (match && match[12]) {
          masterSheetId = extractSheetIdFromUrl(match[12]) || String(match[12]).trim();
          console.log(`🔗 QB Callback: Auto-resolved masterSheetId for "${clientName}" -> ${masterSheetId}`);
        }
      } catch (lookupErr) {
        console.warn("⚠️ QB Callback: Note resolving masterSheetId:", lookupErr.message);
      }
    }

    // 2. Fetch company metadata from QuickBooks API
    let companyName = "";
    if (activeRealmId) {
      try {
        const companyInfo = await getQBCompanyInfo(tokens.accessToken, activeRealmId);
        if (companyInfo?.companyName) {
          companyName = companyInfo.companyName;
        }
      } catch (infoErr) {
        console.warn("⚠️ Error fetching QB company info:", infoErr.message);
      }
    }

    const effectiveCompanyName = companyName || clientName;

    // 3. Encrypt and store tokens in Central Vault (Redis)
    await saveIntegrationTokens({
      clientKey,
      clientName,
      masterSheetId,
      tool: "quickbooks",
      tokens,
      metadata: {
        realmId: activeRealmId,
        companyName: effectiveCompanyName,
        scope: tokens.scope
      }
    });

    // 4. Update KeyInfo!X3 in Master Sheet if masterSheetId is known and activeRealmId is present
    if (masterSheetId && activeRealmId) {
      try {
        const sheets = await getSheetsClient();
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: masterSheetId,
            range: "KeyInfo!X3",
            valueInputOption: "RAW",
            requestBody: { values: [[activeRealmId]] }
          })
        );
        console.log(`✅ Updated KeyInfo!X3 with Realm ID (${activeRealmId}) in Master Sheet (${masterSheetId}).`);

        // Log to AutoLog if present
        try {
          const nowStr = new Date().toISOString().replace("T", " ").substring(0, 19);
          await withRetry(() =>
            sheets.spreadsheets.values.append({
              spreadsheetId: masterSheetId,
              range: "AutoLog!A:D",
              valueInputOption: "USER_ENTERED",
              insertDataOption: "INSERT_ROWS",
              requestBody: {
                values: [[nowStr, "CLIENT_AUTH", "QuickBooks Connected", `QuickBooks authorized via Pulse App. Company: ${effectiveCompanyName} (${activeRealmId})`]]
              }
            })
          );
        } catch (logErr) {
          console.log("AutoLog append note:", logErr.message);
        }
      } catch (sheetErr) {
        console.warn("⚠️ Failed to update KeyInfo!X3 via Sheets API:", sheetErr.message);
      }
    }

    // Notify all Admins and assigned Client Manager
    notifyStaffOnClientConnection({
      clientName,
      tool: "quickbooks",
      tenantName: effectiveCompanyName || activeRealmId || "",
      masterSheetId
    }).catch(err => console.error("Notification email error:", err.message));

    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${separator}integration=quickbooks&status=success&company=${encodeURIComponent(effectiveCompanyName)}${clientParam}`);

  } catch (err) {
    console.error("QuickBooks OAuth callback processing error:", err);
    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    const safeErr = sanitizeSpreadsheetTerms(err.message || "QuickBooks authorization failed");
    return res.redirect(`${returnUrl}${separator}integration=quickbooks&status=error&message=${encodeURIComponent(safeErr)}${clientParam}`);
  }
}
