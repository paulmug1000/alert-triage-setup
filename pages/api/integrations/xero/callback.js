/**
 * ============================================================================
 * XERO OAUTH CALLBACK ROUTE: /api/integrations/xero/callback
 * ============================================================================
 * 
 * Receives the redirect from Xero with the authorization code and state token.
 * Validates PKCE and state nonces, exchanges the code for OAuth tokens,
 * resolves authorized tenant organisations, encrypts credentials into the Vault,
 * and updates the Master Sheet's KeyInfo!X2 cell.
 */

import { exchangeCodeForTokens, getXeroConnections } from "../../../../services/xeroService.js";
import {
  saveIntegrationTokens,
  saveSharedXeroGrant,
  linkClientToSharedXero,
  matchTenantToClient
} from "../../../../services/vaultService.js";
import { getSheetsClient, withRetry } from "../../../../services/sheetsClient.js";
import { DEFAULT_AC_SHEET_ID } from "../../../../services/pmaLogger.js";

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

  const { code, state, error, error_description } = req.query;

  // Handle user cancellation or denial
  if (error) {
    console.warn("⚠️ Xero OAuth denied by user:", error, error_description);
    return res.redirect(`/portal?integration=xero&status=denied&error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: "Missing authorization code or state parameter." });
  }

  // Parse cookies
  const cookies = parseCookies(req.headers.cookie);
  const savedNonce = cookies.pulse_xero_nonce;
  const codeVerifier = cookies.pulse_xero_verifier;

  // Clear state cookies immediately
  const isProd = process.env.NODE_ENV === "production";
  const clearCookieOptions = `Path=/api/integrations/xero; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", [
    `pulse_xero_nonce=; ${clearCookieOptions}`,
    `pulse_xero_verifier=; ${clearCookieOptions}`
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
    const redirectUri = `${proto}://${host}/api/integrations/xero/callback`;

    // 1. Exchange authorization code for tokens
    const tokens = await exchangeCodeForTokens({
      code,
      redirectUri,
      codeVerifier
    });

    // 2. Fetch authorized Xero organisations (tenants)
    const tenants = await getXeroConnections(tokens.accessToken);
    if (!tenants || tenants.length === 0) {
      throw new Error("No Xero organisations found for this account.");
    }

    const clientKey = statePayload.clientKey || statePayload.clientName;
    const clientName = statePayload.clientName || clientKey;
    const masterSheetId = statePayload.masterSheetId;

    // 3. Store tokens in the Central Shared Advisor Xero Grant
    // Because the advisor user connects with access to multiple client organisations,
    // this single grant powers all authorized organisations without token rotation conflicts.
    await saveSharedXeroGrant({
      tokens,
      availableTenants: tenants,
      connectedBy: clientName
    });

    // Smart Tenant Selection for the initiating client:
    let matchedTenant = matchTenantToClient(clientName, tenants);
    if (!matchedTenant) {
      const sortedByDate = [...tenants].sort((a, b) => {
        const timeA = a.createdDateUtc ? new Date(a.createdDateUtc).getTime() : 0;
        const timeB = b.createdDateUtc ? new Date(b.createdDateUtc).getTime() : 0;
        return timeB - timeA;
      });
      matchedTenant = sortedByDate[0] || tenants[0];
    }

    const primaryTenant = matchedTenant;
    const tenantId = primaryTenant.tenantId;
    const tenantName = primaryTenant.tenantName;

    // Link the initiating client
    await linkClientToSharedXero({
      clientKey,
      clientName,
      masterSheetId,
      tenantId,
      tenantName,
      availableTenants: tenants
    });

    // 4. Auto-link ALL other ecosystem clients matching the authorized Xero organisations
    try {
      const sheets = await getSheetsClient();
      const acRes = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: DEFAULT_AC_SHEET_ID,
          range: "AutoUpdates!A2:N100"
        })
      );
      const rows = acRes.data.values || [];
      for (const r of rows) {
        const cName = String(r[0] || "").trim();
        const mUrl = String(r[12] || "").trim();
        if (!cName || cName.toLowerCase() === "client" || cName.toLowerCase() === "client name" || !mUrl) continue;
        const match = mUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
        const mSheetId = match ? match[1] : "";

        // Check if this ecosystem client matches one of the authorized tenants
        const clientTenant = matchTenantToClient(cName, tenants);
        if (clientTenant) {
          console.log(`🔗 Auto-linking client "${cName}" to Xero Org "${clientTenant.tenantName}" (${clientTenant.tenantId})...`);
          await linkClientToSharedXero({
            clientKey: cName,
            clientName: cName,
            masterSheetId: mSheetId,
            tenantId: clientTenant.tenantId,
            tenantName: clientTenant.tenantName,
            availableTenants: tenants
          });

          // Ensure KeyInfo!X2 is set to this tenant ID in the Master Sheet
          if (mSheetId) {
            try {
              await withRetry(() =>
                sheets.spreadsheets.values.update({
                  spreadsheetId: mSheetId,
                  range: "KeyInfo!X2",
                  valueInputOption: "USER_ENTERED",
                  requestBody: { values: [[clientTenant.tenantId]] }
                })
              );
              console.log(`✅ Updated KeyInfo!X2 for "${cName}" to ${clientTenant.tenantId}.`);
            } catch (errX2) {
              console.warn(`Note updating KeyInfo!X2 for ${cName}:`, errX2.message);
            }
          }
        }
      }
    } catch (autoLinkErr) {
      console.warn("⚠️ Auto-linking ecosystem clients notice:", autoLinkErr.message);
    }

    // 5. Update KeyInfo!X2 and AutoLog for initiating client if needed
    if (masterSheetId) {
      try {
        const sheets = await getSheetsClient();
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: masterSheetId,
            range: "KeyInfo!X2",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[tenantId]] }
          })
        );

        try {
          const nowStr = new Date().toISOString().replace("T", " ").substring(0, 19);
          await withRetry(() =>
            sheets.spreadsheets.values.append({
              spreadsheetId: masterSheetId,
              range: "AutoLog!A:D",
              valueInputOption: "USER_ENTERED",
              insertDataOption: "INSERT_ROWS",
              requestBody: {
                values: [[nowStr, "CLIENT_AUTH", "Xero Connected", `Xero authorized via Pulse App (Central Shared Grant). Org: ${tenantName}`]]
              }
            })
          );
        } catch (_) {}
      } catch (sheetErr) {
        console.warn("⚠️ Failed to update initiating Master Sheet:", sheetErr.message);
      }
    }

    const returnUrl = statePayload.redirectBack || "/portal";
    const separator = returnUrl.includes("?") ? "&" : "?";
    return res.redirect(`${returnUrl}${separator}integration=xero&status=success&tenant=${encodeURIComponent(tenantName)}&shared=true&linkedCount=${tenants.length}`);

  } catch (err) {
    console.error("Xero OAuth callback processing error:", err);
    const returnUrl = statePayload?.redirectBack || "/portal";
    const separator = returnUrl.includes("?") ? "&" : "?";
    return res.redirect(`${returnUrl}${separator}integration=xero&status=error&message=${encodeURIComponent(err.message)}`);
  }
}
