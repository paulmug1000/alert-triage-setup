import jwt from "jsonwebtoken";
import { getJwtSecret, safeCompareSecret } from "../../services/authService";
import { sanitizeRedirectUrl } from "../../utils/helpers";

/**
 * Dev-only login endpoint to test authenticated portal and PMA flows in local development.
 * Restricted strictly to non-production local environments.
 */
export default async function handler(req, res) {
  const remoteIp = String(req.socket?.remoteAddress || "").trim();
  const isLoopback = remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
  const configuredDevSecret = (process.env.DEV_LOGIN_SECRET || "").trim();
  const providedDevSecret = String(req.headers["x-dev-login-secret"] || req.query?.secret || "").trim();

  if (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production" ||
    process.env.ENABLE_DEV_LOGIN !== "true" ||
    (req.method !== "POST" && !isLoopback) ||
    (configuredDevSecret && !safeCompareSecret(providedDevSecret, configuredDevSecret))
  ) {
    return res.status(403).json({ error: "Dev login is disabled" });
  }

  const role = String(req.query.role || "Admin");
  const email = String(req.query.email || "admin@pulsedashboard.co.uk");
  const name = String(req.query.name || "Pulse Admin");
  const assigned = req.query.assigned
    ? String(req.query.assigned).split(",")
    : (role === "Admin" ? "*" : ["ALL"]);

  const payload = {
    tokenType: "session",
    email,
    name,
    role,
    assignedClients: assigned,
  };

  const secret = getJwtSecret();
  const token = jwt.sign(payload, secret, { expiresIn: "7d" });

  const isSecure = process.env.NODE_ENV === "production" || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `pma_session=${token}; Path=/; HttpOnly; SameSite=Lax${isSecure ? "; Secure" : ""}`);
  const redirectTarget = sanitizeRedirectUrl(req.query.redirect, "/pulse");
  return res.redirect(redirectTarget);
}
