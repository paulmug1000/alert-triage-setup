import { verifyOtp } from "../../../services/authService";

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
    return res.status(result.success ? 200 : 401).json(result);
  } catch (error) {
    console.error("❌ /api/auth/verify-code error:", error);
    return res.status(500).json({ success: false, message: "An error occurred verifying code. Please try again." });
  }
}
