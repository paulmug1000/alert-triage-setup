import { getSessionUser } from "../../../services/authService";

export default async function handler(req, res) {
  try {
    const user = getSessionUser(req);
    if (!user) {
      return res.status(200).json({ authenticated: false, user: null });
    }
    return res.status(200).json({ authenticated: true, user });
  } catch (error) {
    console.error("❌ /api/auth/session error:", error);
    return res.status(500).json({ authenticated: false, error: "Failed to read session" });
  }
}
