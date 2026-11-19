import { clearSessionCookie, revokeRequestSessionJti } from "../../../services/authService";
import { assertTrustedOrigin } from "../../../utils/helpers";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!assertTrustedOrigin(req, res)) return;
  try {
    await revokeRequestSessionJti(req);
    clearSessionCookie(res);
    return res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("❌ /api/auth/logout error:", error);
    return res.status(500).json({ success: false, error: "Failed to log out" });
  }
}
