import { clearSessionCookie, revokeRequestSessionJti, getTrustedClientIp, checkRateLimit } from "../../../services/authService";
import { assertTrustedOrigin } from "../../../utils/helpers";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!assertTrustedOrigin(req, res)) return;
  const rl = await checkRateLimit("auth-logout", getTrustedClientIp(req), 60, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many logout requests. Please retry shortly." });
  }
  try {
    await revokeRequestSessionJti(req);
    clearSessionCookie(res);
    return res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("❌ /api/auth/logout error:", error);
    return res.status(500).json({ success: false, error: "Failed to log out" });
  }
}
