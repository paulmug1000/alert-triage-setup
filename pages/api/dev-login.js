import jwt from "jsonwebtoken";
import { getJwtSecret } from "../../services/authService";
import { sanitizeRedirectUrl } from "../../utils/helpers";

/**
 * Dev-only login endpoint to test authenticated portal and PMA flows in local development.
 * Restricted strictly to non-production environments.
 */
export default async function handler(req, res) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production" ||
    process.env.ENABLE_DEV_LOGIN !== "true"
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
