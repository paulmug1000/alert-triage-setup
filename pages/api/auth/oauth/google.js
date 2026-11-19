import crypto from "crypto";
import { createSignedOAuthState } from "../../../../services/authService";

const CANONICAL_PULSE_HOSTS = new Set([
  "pulsedashboard.co.uk",
  "app.pulsedashboard.co.uk",
  "pma.pulsedashboard.co.uk",
]);

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: "Missing GOOGLE_CLIENT_ID environment variable" });
  }

  // Host resolution: allow only exact canonical Pulse hosts, else configured app host
  const reqHostRaw = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  const isPulseHost = CANONICAL_PULSE_HOSTS.has(reqHostRaw);
  const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const host = isPulseHost ? reqHostRaw : (prodHost || (process.env.NODE_ENV !== "production" ? reqHostRaw : "app.pulsedashboard.co.uk") || "localhost:3000");
  const isLocal = process.env.NODE_ENV !== "production" && (host.startsWith("localhost") || host.startsWith("127.0.0.1"));
  const proto = isLocal ? (req.headers["x-forwarded-proto"] || "http") : "https";
  const redirectUri = `${proto}://${host}/api/auth/oauth/google/callback`;

  // Standard OpenID Connect scopes for identity
  const scopes = ["openid", "email", "profile"].join(" ");

  // Generate cryptographic anti-CSRF nonce and PKCE verifier (RFC 7636)
  const nonce = crypto.randomBytes(16).toString("hex");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const signedState = createSignedOAuthState({ nonce });

  const isProd = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", [
    `pma_oauth_nonce=${nonce}; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=600${isProd ? "; Secure" : ""}`,
    `pma_oauth_verifier=${codeVerifier}; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=600${isProd ? "; Secure" : ""}`
  ]);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("access_type", "online");
  authUrl.searchParams.set("prompt", "select_account");
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", signedState);

  res.redirect(authUrl.toString());
  return;
}
