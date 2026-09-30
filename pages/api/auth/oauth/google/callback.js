import { createSessionForVerifiedEmail } from "../../../../../services/authService";

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    console.warn("⚠️ Google OAuth error:", error);
    res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
    return;
  }

  if (!code) {
    res.redirect("/?auth_error=missing_code");
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment");
    res.redirect("/?auth_error=server_configuration_error");
    return;
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
  const redirectUri = `${proto}://${host}/api/auth/oauth/google/callback`;

  try {
    // 1. Exchange authorization code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("❌ Google token exchange failed:", tokenData);
      res.redirect(`/?auth_error=${encodeURIComponent(tokenData.error_description || "Token exchange failed")}`);
      return;
    }

    // 2. Fetch user profile from Google UserInfo endpoint
    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const userData = await userRes.json();
    if (!userRes.ok || !userData.email) {
      console.error("❌ Failed to fetch Google userinfo:", userData);
      res.redirect("/?auth_error=failed_to_fetch_user_profile");
      return;
    }

    const email = userData.email.toLowerCase().trim();
    console.log(`🔑 Verified Google OAuth login attempt for: ${email}`);

    // 3. Verify user authorization in Users sheet and mint session cookie
    const result = await createSessionForVerifiedEmail(email, res, "Google");

    if (!result.success) {
      console.warn(`⛔ Access denied for Google user ${email}:`, result.message);
      res.redirect(`/?auth_error=unauthorized&email=${encodeURIComponent(email)}&provider=Google`);
      return;
    }

    console.log(`✅ Google OAuth login successful for: ${email}`);
    res.redirect("/");
    return;
  } catch (err) {
    console.error("❌ Google OAuth callback exception:", err);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message || "An unexpected error occurred during Google sign in")}`);
    return;
  }
}
