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

import { exchangeQBCodeForTokens, getQBCompanyInfo } from "../../../../services/quickbooksService.js";
import { saveIntegrationTokens } from "../../../../services/vaultService.js";
import { getSheetsClient, withRetry } from "../../../../services/sheetsClient.js";

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, pair) => {
    const [k, v] = pair.trim().split("=");
    if (k && v) acc[k] = decodeURIComponent(v);
    return acc;
  }, {});
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { code, state, realmId, error, error_description } = req.query;

  // Handle user cancellation or denial
  if (error) {
    console.warn("⚠️ QuickBooks OAuth denied by user:", error, error_description);
    return res.redirect(`/portal?integration=quickbooks&status=denied&error=${encodeURIComponent(error_description || error)}`);
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

  let statePayload = null;
  try {
    const stateJson = Buffer.from(state, "base64url").toString("utf8");
    statePayload = JSON.parse(stateJson);
  } catch (err) {
    return res.status(400).json({ error: "Invalid state token structure." });
  }

  if (!savedNonce || statePayload.nonce !== savedNonce) {
    return res.status(403).json({ error: "State nonce verification failed (potential CSRF attempt)." });
  }

  try {
    // Dynamic Host Resolution
    const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
    const isPulseHost = reqHost && (reqHost === "pulsedashboard.co.uk" || reqHost.endsWith(".pulsedashboard.co.uk"));
    const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const host = isPulseHost ? reqHost : (prodHost || reqHost || "localhost:3000");
    const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
    const redirectUri = `${proto}://${host}/api/integrations/quickbooks/callback`;

    // 1. Exchange authorization code for tokens
    const tokens = await exchangeQBCodeForTokens({
      code,
      redirectUri,
      codeVerifier
    });

    const clientKey = statePayload.clientKey || statePayload.clientName;
    const clientName = statePayload.clientName || clientKey;
    const masterSheetId = statePayload.masterSheetId;
    const activeRealmId = String(realmId || "").trim();

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
            valueInputOption: "USER_ENTERED",
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

    const returnUrl = statePayload.redirectBack || "/portal";
    const separator = returnUrl.includes("?") ? "&" : "?";
    return res.redirect(`${returnUrl}${separator}integration=quickbooks&status=success&company=${encodeURIComponent(effectiveCompanyName)}`);

  } catch (err) {
    console.error("QuickBooks OAuth callback processing error:", err);
    const returnUrl = statePayload?.redirectBack || "/portal";
    const separator = returnUrl.includes("?") ? "&" : "?";
    return res.redirect(`${returnUrl}${separator}integration=quickbooks&status=error&message=${encodeURIComponent(err.message)}`);
  }
}
