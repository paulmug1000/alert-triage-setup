import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { matchesClientName } from "../../../services/userPermissions.js";
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

  if (!clientName) {
    return res.status(400).json({ success: false, error: "clientName is required" });
  }

  // Authorization check for non-admin users
  if (!sessionUser.isAdmin) {
    const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
    const isAuthorized = assignedList.some(assigned => matchesClientName(assigned, clientName));
    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client" });
    }
  }

  try {
    const sheets = await getSheetsClient();
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
