import { sendOtp, getTrustedClientIp } from "../../../services/authService";
import { assertTrustedOrigin } from "../../../utils/helpers";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!assertTrustedOrigin(req, res)) return;

  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const clientIp = getTrustedClientIp(req);
    const result = await sendOtp(email, null, clientIp);
    return res.status(200).json(result);
  } catch (error) {
    console.error("❌ /api/auth/send-code error:", error);
    return res.status(500).json({ success: false, message: "Failed to send verification code. Please try again." });
  }
}
