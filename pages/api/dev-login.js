import jwt from "jsonwebtoken";
import { getJwtSecret } from "../../services/authService";

/**
 * Dev-only login endpoint to test authenticated portal and PMA flows in local development.
 * Restricted strictly to non-production environments.
 */
export default async function handler(req, res) {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Dev login only allowed in local development" });
  }

  const role = String(req.query.role || "Admin");
  const email = String(req.query.email || "admin@pulsedashboard.co.uk");
  const name = String(req.query.name || "Pulse Admin");
  const assigned = req.query.assigned ? String(req.query.assigned).split(",") : ["ALL"];

  const payload = {
    tokenType: "session",
    email,
    name,
    role,
    assignedClients: assigned,
  };

  const secret = getJwtSecret();
  const token = jwt.sign(payload, secret, { expiresIn: "7d" });

  res.setHeader("Set-Cookie", `pma_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
  const redirectTarget = req.query.redirect || "/pulse";
  return res.redirect(redirectTarget);
}
