import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, isUserAuthorizedForClient } from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";
import { installSheetIdBoundary, unwrapSheetId } from "../../../services/sheetTokenService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  installSheetIdBoundary(req, res, sessionUser);

  const rl = await checkRateLimit("portal-log-access", sessionUser.email || getTrustedClientIp(req), 60, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down." });
  }

  const { clientName, clientSheetId, action = "PORTAL_ENTERED" } = req.body || {};

  if (!clientName && !clientSheetId) {
    return res.status(400).json({ success: false, error: "clientName or clientSheetId is required" });
  }

  try {
    const sheets = await getSheetsClient();
    const cleanSheetId = clientSheetId ? unwrapSheetId(clientSheetId) : "";

    let targetClient = (clientName || "").trim();
    if (cleanSheetId) {
      const auth = await verifyUserAuthorizedForSheet(sessionUser, cleanSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error });
      }
      targetClient = auth.clientName || targetClient;
    } else if (!isUserAuthorizedForClient(sessionUser, targetClient)) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client" });
    }
    const liveGate = await assertClientPortalLive(sessionUser, targetClient, res);
    if (!liveGate.allowed) return;
    const clientIp = getTrustedClientIp(req);

    await logPulseActivity(sheets, {
      clientName: targetClient,
      category: "PORTAL",
      action: action === "PORTAL_ENTERED" ? "PORTAL_ENTERED" : "PORTAL_ENTERED",
      summary: `${sessionUser.name || sessionUser.email} accessed ${targetClient} workspace`,
      details: {
        role: sessionUser.role,
        ...(sessionUser.isAdmin && cleanSheetId ? { clientSheetId: cleanSheetId } : {}),
        ip: clientIp,
      },
      user: sessionUser.name || sessionUser.email
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ /api/portal/log-access error:", err);
    return res.status(500).json({ success: false, error: sessionUser?.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
  }
}
