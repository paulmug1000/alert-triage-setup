import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../services/authService";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ authenticated: false, error: "Method not allowed" });
  }
  const rl = await checkRateLimit("auth-session", getTrustedClientIp(req), 120, 60);
  if (!rl.allowed) {
    return res.status(429).json({ authenticated: false, error: "Too many session checks. Please retry shortly." });
  }
  try {
    const user = await resolveLiveSessionUser(req, res);
    if (!user) {
      return res.status(200).json({ authenticated: false, user: null });
    }
    return res.status(200).json({ authenticated: true, user });
  } catch (error) {
    console.error("❌ /api/auth/session error:", error);
    return res.status(500).json({ authenticated: false, error: "Failed to read session" });
  }
}
