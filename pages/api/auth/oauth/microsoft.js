import crypto from "crypto";
import { createSignedOAuthState, getTrustedClientIp, checkRateLimit } from "../../../../services/authService";
import { resolveCanonicalOAuthHost } from "../../../../utils/helpers";

export default async function handler(req, res) {
  const rl = await checkRateLimit("oauth-init", getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ error: "Too many sign-in attempts. Please retry shortly." });
  }

  const clientId = process.env.AZURE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: "Missing AZURE_CLIENT_ID environment variable" });
  }

  const { host, proto } = resolveCanonicalOAuthHost(req);
  const redirectUri = `${proto}://${host}/api/auth/oauth/microsoft/callback`;

  // Standard Microsoft Entra ID OpenID Connect & Graph user identity scopes
  const scopes = ["openid", "email", "profile", "User.Read"].join(" ");

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

  const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("prompt", "select_account");
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", signedState);

  res.redirect(authUrl.toString());
  return;
}
