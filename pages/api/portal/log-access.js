import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, isUserAuthorizedForClient } from "../../../services/userPermissions.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const { clientName, clientSheetId, action = "PORTAL_ENTERED" } = req.body || {};

  if (!clientName && !clientSheetId) {
    return res.status(400).json({ success: false, error: "clientName or clientSheetId is required" });
  }

  try {
    const sheets = await getSheetsClient();

    let targetClient = (clientName || "").trim();
    if (clientSheetId) {
      const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
      if (!auth.authorized) {
        return res.status(auth.status || 403).json({ success: false, error: auth.error });
      }
      targetClient = auth.clientName;
    } else if (!isUserAuthorizedForClient(sessionUser, targetClient)) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client" });
    }
    const forwarded = req.headers["x-forwarded-for"];
    const clientIp = (typeof forwarded === "string" ? forwarded.split(",")[0] : forwarded?.[0])?.trim() || req.socket?.remoteAddress || "-";

    await logPulseActivity(sheets, {
      clientName: clientName.trim(),
      category: "PORTAL",
      action: "PORTAL_ENTERED",
      summary: `${sessionUser.name || sessionUser.email} accessed ${clientName.trim()} workspace`,
      details: { role: sessionUser.role, clientSheetId: clientSheetId || "-", ip: clientIp },
      user: sessionUser.name || sessionUser.email
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ /api/portal/log-access error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
