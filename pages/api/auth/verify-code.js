import { verifyOtp } from "../../../services/authService";
import { getClientSetupStatusForPortal } from "../../../services/setupService";
import { redisClient } from "../../../services/redisClient";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { email, code } = req.body || {};
    if (!email || !code) {
      return res.status(400).json({ success: false, message: "Email and code are required" });
    }

    const vercelFwd = req.headers["x-vercel-forwarded-for"];
    const forwarded = req.headers["x-forwarded-for"];
    const clientIp =
      (typeof vercelFwd === "string" && vercelFwd.trim() ? vercelFwd.split(",")[0].trim() : "") ||
      (typeof forwarded === "string" && forwarded.trim() ? forwarded.split(",")[0].trim() : forwarded?.[0]?.trim()) ||
      req.socket?.remoteAddress ||
      "127.0.0.1";

    const result = await verifyOtp(email, code, null, res, clientIp);
    if (result.success && result.user) {
      try {
        const assigned = Array.isArray(result.user.assignedClients) ? result.user.assignedClients : [];
        if (assigned.length === 1 && assigned[0] && assigned[0] !== "*") {
          const singleClient = String(assigned[0]).trim();
          const normKey = `pulse:setup:${singleClient.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
          const rawSetup = redisClient?.isOpen ? await redisClient.get(normKey) : null;
          const parsedSetup = rawSetup ? JSON.parse(rawSetup) : null;
          if (parsedSetup?.setupMode === true) {
            const initialSetupStatus = await getClientSetupStatusForPortal({
              clientName: singleClient,
              masterSheetId: parsedSetup.masterSheetId || ""
            });
            result.user = {
              ...result.user,
              initialSetupClient: {
                clientName: singleClient,
                setupMode: true,
                setupStatus: initialSetupStatus
              },
              initialSetupStatus
            };
          }
        }
      } catch (_) {}
    }
    return res.status(result.success ? 200 : 401).json(result);
  } catch (error) {
    console.error("❌ /api/auth/verify-code error:", error);
    return res.status(500).json({ success: false, message: "An error occurred verifying code. Please try again." });
  }
}
