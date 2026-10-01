import jwt from "jsonwebtoken";
import { getJwtSecret } from "../../../services/authService";


export default async function handler(req, res) {
  const origin = req.headers.origin;
  const isAllowedOrigin = origin && (
    origin === "https://app.pulsedashboard.co.uk" ||
    origin === "https://pma.pulsedashboard.co.uk" ||
    origin === "https://project-shj9n.vercel.app" ||
    origin === "http://localhost:3000" ||
    origin === "https://script.google.com" ||
    origin.endsWith(".googleusercontent.com") ||
    origin.endsWith(".pulsedashboard.co.uk")
  );

  if (isAllowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://app.pulsedashboard.co.uk");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let ssoToken = null;
  let email = null;

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    }
    ssoToken = body?.ssoToken;
    email = body?.email;
  } else {
    ssoToken = req.query?.ssoToken;
    email = req.query?.email;
  }

  if (!ssoToken || !email) {
    return res.status(400).json({ valid: false, message: "Missing ssoToken or email parameter" });
  }

  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(ssoToken, secret);

    if (decoded.email.toLowerCase().trim() !== String(email).toLowerCase().trim()) {
      return res.status(403).json({ valid: false, message: "Email address mismatch" });
    }

    return res.status(200).json({
      valid: true,
      email: decoded.email,
      provider: decoded.provider || "SSO"
    });
  } catch (err) {
    return res.status(401).json({
      valid: false,
      message: err.message || "SSO token is invalid or has expired"
    });
  }
}
