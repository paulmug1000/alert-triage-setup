import { sendOtp } from "../../../services/authService";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { email, automationCommanderSheetId } = req.body || {};
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const forwarded = req.headers["x-forwarded-for"];
    const clientIp = (typeof forwarded === "string" ? forwarded.split(",")[0] : forwarded?.[0])?.trim() || req.socket?.remoteAddress || "127.0.0.1";
    const result = await sendOtp(email, automationCommanderSheetId, clientIp);
    return res.status(200).json(result);
  } catch (error) {
    console.error("❌ /api/auth/send-code error:", error);
    return res.status(500).json({ success: false, message: "Failed to send verification code. Please try again." });
  }
}
