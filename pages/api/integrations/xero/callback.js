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
  matchTenantToClient,
  getIntegrationTokens
} from "../../../../services/vaultService.js";
import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "../../../../services/sheetsClient.js";
import { DEFAULT_AC_SHEET_ID, matchesClientName } from "../../../../services/userPermissions.js";
import { verifySignedOAuthState, safeCompareSecret, verifyCallbackSessionInitiator, getTrustedClientIp, checkRateLimit } from "../../../../services/authService.js";
import { notifyStaffOnClientConnection } from "../../../../services/connectionNotifier.js";
import { sanitizeRedirectUrl, resolveCanonicalOAuthHost, sanitizeSpreadsheetTerms } from "../../../../utils/helpers.js";
import { resolveSupabaseSheetContext } from "../../../../services/masterEngineService.js";
import { getSupabaseAdmin, isSupabaseConfigured, isSupabaseControlPlaneActive } from "../../../../services/supabaseClient.js";

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

  const { code, state, error, error_description } = req.query;

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
    console.warn("⚠️ Xero OAuth cancelled or denied by user:", error, error_description);
    const sep = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${sep}integration=xero&status=denied&error=${encodeURIComponent(error_description || error)}${clientParam}`);
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

  if (!savedNonce || !statePayload?.nonce || !safeCompareSecret(String(statePayload.nonce), String(savedNonce))) {
    return res.status(403).json({ error: "State nonce verification failed (potential CSRF attempt)." });
  }

  const initiatorCheck = await verifyCallbackSessionInitiator(req, res, statePayload);
  if (!initiatorCheck.ok) {
    return res.status(403).json({ error: initiatorCheck.error });
  }

  try {
    // Canonical Host Resolution
    const { host, proto } = resolveCanonicalOAuthHost(req);
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
    let masterSheetId = statePayload.masterSheetId;

    // CRITICAL: The Central Advisor Shared Grant should ONLY ever be updated when the connection
    // was initiated explicitly for the central advisor account (clientKey === "advisor" or mode === "advisor" with no specific client).
    // Any per-client connection MUST ALWAYS be stored as an isolated dedicated connection to prevent corrupting practice tokens.
    const isAdvisorKey = ["advisor", "advisor account", "central advisor", "central advisor account"].includes(String(statePayload?.clientKey || "").trim().toLowerCase());
    const isAdvisorName = ["advisor", "advisor account", "central advisor", "central advisor account"].includes(String(statePayload?.clientName || "").trim().toLowerCase());
    const isAdvisorConnection = (isAdvisorKey || isAdvisorName) && statePayload?.mode === "advisor";
    const isDedicated = !isAdvisorConnection;

    // Fallback: If masterSheetId wasn't passed in statePayload, resolve it from Supabase or legacy AutoUpdates
    if (!masterSheetId && clientName && !isAdvisorConnection) {
      try {
        const supaCtx = await resolveSupabaseSheetContext({ clientName }).catch(() => null);
        if (supaCtx?.masterSheetId) {
          masterSheetId = supaCtx.masterSheetId;
          console.log(`🔗 Xero Callback: Auto-resolved masterSheetId for "${clientName}" -> ${masterSheetId}`);
        }
        if (!masterSheetId && !(await isSupabaseControlPlaneActive())) {
          const sheets = await getSheetsClient();
          const resp = await sheets.spreadsheets.values.get({
            spreadsheetId: DEFAULT_AC_SHEET_ID,
            range: "AutoUpdates!A2:N500"
          });
          const rows = resp.data.values || [];
          const match = rows.find(r => matchesClientName(r[0], clientName));
          if (match && match[12]) {
            masterSheetId = extractSheetIdFromUrl(match[12]) || String(match[12]).trim();
            console.log(`🔗 Xero Callback: Auto-resolved masterSheetId for "${clientName}" -> ${masterSheetId}`);
          }
        }
      } catch (lookupErr) {
        console.warn("⚠️ Xero Callback: Note resolving masterSheetId:", lookupErr.message);
      }
    }

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

    if (isDedicated) {
      // =========================================================================
      // DEDICATED CLIENT CONNECTION FLOW
      // =========================================================================
      // The client user connected directly via the client setup gate, or an admin
      // explicitly configured a dedicated account. Store credentials strictly in
      // this client's isolated Vault record without touching the shared grant.
      await saveIntegrationTokens({
        clientKey,
        clientName,
        masterSheetId,
        tool: "xero",
        tokens,
        metadata: {
          isSharedGrant: false,
          tenantId,
          tenantName,
          availableTenants: tenants
        }
      });
      console.log(`🔒 Vault: Successfully stored DEDICATED Xero connection for client "${clientName}" (Org: ${tenantName}).`);

    } else {
      // =========================================================================
      // CENTRAL ADVISOR SHARED CONNECTION FLOW
      // =========================================================================
      // The advisor connected via PMA. Store tokens in the Central Shared Grant
      // and link only the initiating client; other clients must be explicitly confirmed
      // via PMA > Integrations (never auto-linked on fuzzy name match).
      await saveSharedXeroGrant({
        tokens,
        availableTenants: tenants,
        connectedBy: clientName
      });

      // Link the initiating client if this connection was initiated for a specific client
      if (!isAdvisorKey && !isAdvisorName) {
        await linkClientToSharedXero({
          clientKey,
          clientName,
          masterSheetId,
          tenantId,
          tenantName,
          availableTenants: tenants
        });
      }
    }

    // 5. Update KeyInfo!X2 and AutoLog for initiating client if needed
    if (masterSheetId) {
      try {
        const sheets = await getSheetsClient();
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: masterSheetId,
            range: "KeyInfo!X2",
            valueInputOption: "RAW",
            requestBody: { values: [[tenantId]] }
          })
        );

        try {
          const nowStr = new Date().toISOString().replace("T", " ").substring(0, 19);
          await withRetry(() =>
            sheets.spreadsheets.values.append({
              spreadsheetId: masterSheetId,
              range: "AutoLog!A:D",
              valueInputOption: "RAW",
              insertDataOption: "INSERT_ROWS",
              requestBody: {
                values: [[nowStr, "CLIENT_AUTH", "Xero Connected", `Xero authorized via Pulse App (Central Shared Grant). Org: ${tenantName}`]]
              }
            })
          );
        } catch (_) { }
      } catch (sheetErr) {
        console.warn("⚠️ Failed to update initiating Master Sheet:", sheetErr.message);
      }
    }

    // Notify all Admins and assigned Client Manager
    notifyStaffOnClientConnection({
      clientName,
      tool: "xero",
      tenantName: tenantName || "",
      masterSheetId,
      mode: isDedicated ? "dedicated" : "shared"
    }).catch(err => console.error("Notification email error:", err.message));

    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    const redirectParams = new URLSearchParams({
      integration: "xero",
      status: "success",
      tenant: tenantName || ""
    });
    if (isDedicated) {
      redirectParams.set("mode", "dedicated");
    } else {
      redirectParams.set("shared", "true");
      redirectParams.set("linkedCount", String(tenants.length));
    }
    return res.redirect(`${returnUrl}${separator}${redirectParams.toString()}${clientParam}`);

  } catch (err) {
    console.error("Xero OAuth callback processing error:", err);
    const separator = returnUrl.includes("?") ? "&" : "?";
    const clientParam = clientName && !returnUrl.includes("client=") ? `&client=${encodeURIComponent(clientName)}` : "";
    return res.redirect(`${returnUrl}${separator}integration=xero&status=error&message=${encodeURIComponent(sanitizeSpreadsheetTerms(err.message || "Connection failed"))}${clientParam}`);
  }
}
