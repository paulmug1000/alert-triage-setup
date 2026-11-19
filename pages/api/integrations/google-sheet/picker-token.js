/**
 * ============================================================================
 * GOOGLE PICKER TOKEN ROUTE: /api/integrations/google-sheet/picker-token
 * ============================================================================
 * 
 * Returns a fresh OAuth 2.0 access token (scoped to drive.file), Google Cloud
 * Project Number (appId), and Google Picker API key (developerKey) so the
 * browser can open the official Google Picker dialog for the current client.
 */

import { resolveLiveSessionUser } from "../../../../services/authService.js";
import { isUserAuthorizedForClient, verifyUserAuthorizedForSheet, isReadOnlySession, canAccessPma } from "../../../../services/userPermissions.js";
import { getSheetsClient } from "../../../../services/sheetsClient.js";
import { getIntegrationTokens, refreshStoredIntegrationToken } from "../../../../services/vaultService.js";
import { refreshGoogleSheetTokens } from "../../../../services/googleSheetService.js";
import { assertTrustedOrigin } from "../../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }
  if (!assertTrustedOrigin(req, res)) return;
  res.setHeader("Cache-Control", "no-store");

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({ success: false, error: "Read-only session cannot open file picker." });
  }
  if (sessionUser.isSenior || sessionUser.role === "Senior (Restricted)") {
    return res.status(403).json({ success: false, error: "Restricted users cannot modify integrations." });
  }

  const { clientKey, clientName, masterSheetId } = req.body || {};
  const targetClient = clientKey || clientName;

  if (!targetClient && !masterSheetId) {
    return res.status(400).json({ success: false, error: "Missing clientKey or masterSheetId parameter" });
  }

  if (!sessionUser.isAdmin && (!targetClient || !isUserAuthorizedForClient(sessionUser, targetClient))) {
    return res.status(403).json({ success: false, error: "Access denied to this client." });
  }

  if (!sessionUser.isAdmin && masterSheetId) {
    try {
      const sheets = await getSheetsClient();
      const auth = await verifyUserAuthorizedForSheet(sessionUser, masterSheetId, targetClient, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error });
      }
    } catch {
      return res.status(403).json({ success: false, error: "Failed to verify client authorization." });
    }
  }

  try {
    const grant = await getIntegrationTokens({
      clientKey: targetClient,
      masterSheetId,
      tool: "googlesheet"
    });

    if (!grant || !grant.tokens || !grant.tokens.accessToken || grant.tokens.accessToken.startsWith("manual_")) {
      return res.status(200).json({
        success: false,
        needsAuth: true,
        error: "Please authorise with Google first before selecting a spreadsheet."
      });
    }

    // Never expose another user's live Google OAuth accessToken to a non-staff session
    const grantOwner = String(grant.metadata?.userEmail || "").toLowerCase().trim();
    const callerEmail = String(sessionUser.email || "").toLowerCase().trim();
    if (!canAccessPma(sessionUser) && grantOwner && callerEmail !== grantOwner) {
      return res.status(200).json({
        success: false,
        needsAuth: true,
        error: "Please authorise with your own Google account before selecting a spreadsheet."
      });
    }

    if (grant.reconnectRequired) {
      return res.status(200).json({
        success: false,
        needsAuth: true,
        reconnectRequired: true,
        error: "Your Google session has expired. Please click 'Switch account' or 'Authorise with Google' to sign in again."
      });
    }

    let accessToken = grant.tokens.accessToken;
    const isExpiring = !grant.expiresAt || Date.now() > (grant.expiresAt - 300000);

    if (isExpiring && grant.tokens.refreshToken) {
      try {
        const refreshed = await refreshStoredIntegrationToken({
          clientKey: grant.clientKey || targetClient,
          masterSheetId: masterSheetId || grant.masterSheetId || "",
          tool: "googlesheet",
          refreshFn: (latest) => refreshGoogleSheetTokens(latest.tokens.refreshToken)
        });
        accessToken = refreshed.accessToken;
      } catch (refreshErr) {
        console.warn("Could not refresh Google Sheet token for Picker:", refreshErr.message);
        return res.status(200).json({
          success: false,
          needsAuth: true,
          reconnectRequired: true,
          error: "Your Google session has expired. Please click 'Switch account' or 'Authorise with Google' to sign in again."
        });
      }
    }

    const clientId = process.env.GOOGLE_SHEET_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
    const derivedAppId = clientId.includes("-") ? clientId.split("-")[0].trim() : "";
    const appId = (
      process.env.GOOGLE_PICKER_APP_ID ||
      process.env.NEXT_PUBLIC_GOOGLE_PICKER_APP_ID ||
      derivedAppId
    ).trim();

    const developerKey = (
      process.env.GOOGLE_PICKER_API_KEY ||
      process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.NEXT_PUBLIC_GOOGLE_API_KEY ||
      ""
    ).trim();

    if (!developerKey) {
      return res.status(200).json({
        success: false,
        missingApiKey: true,
        error: sessionUser.isAdmin
          ? "Google Picker API key is not configured. Please enable the Google Picker API in Google Cloud Console and set GOOGLE_PICKER_API_KEY in your environment variables."
          : "Google Drive file picker is not yet configured. Please contact support."
      });
    }

    return res.status(200).json({
      success: true,
      accessToken,
      appId,
      developerKey,
      userEmail: grant.metadata?.userEmail || ""
    });
  } catch (err) {
    console.error("Error fetching Google Picker token:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to initialize Google Picker token"
    });
  }
}
