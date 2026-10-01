import crypto from "crypto";

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: "Missing GOOGLE_CLIENT_ID environment variable" });
  }

  // Host resolution: prioritize verified pulsedashboard.co.uk host, then configured prod host
  const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
  const isPulseHost = reqHost && (reqHost === "pulsedashboard.co.uk" || reqHost.endsWith(".pulsedashboard.co.uk"));
  const prodHost = (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : null) || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const host = isPulseHost ? reqHost : (prodHost || reqHost || "localhost:3000");
  const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
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

  const stateObj = {
    mode: req.query.mode || "redirect",
    nonce
  };

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
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", JSON.stringify(stateObj));

  res.redirect(authUrl.toString());
  return;
}
