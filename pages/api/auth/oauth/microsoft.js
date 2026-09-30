export default async function handler(req, res) {
  const clientId = process.env.AZURE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: "Missing AZURE_CLIENT_ID environment variable" });
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
  const redirectUri = `${proto}://${host}/api/auth/oauth/microsoft/callback`;

  // Standard Microsoft Entra ID OpenID Connect & Graph user identity scopes
  const scopes = ["openid", "email", "profile", "User.Read"].join(" ");

  const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("prompt", "select_account");

  if (req.query.mode) {
    authUrl.searchParams.set("state", JSON.stringify({ mode: req.query.mode }));
  }

  res.redirect(authUrl.toString());
  return;
}
