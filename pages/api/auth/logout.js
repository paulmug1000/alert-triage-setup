import { clearSessionCookie } from "../../../services/authService";

export default async function handler(req, res) {
  try {
    clearSessionCookie(res);
    return res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("❌ /api/auth/logout error:", error);
    return res.status(500).json({ success: false, error: "Failed to log out" });
  }
}
