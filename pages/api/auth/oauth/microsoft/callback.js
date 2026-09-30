import { createSessionForVerifiedEmail } from "../../../../../services/authService";

export default async function handler(req, res) {
  const { code, error, error_description } = req.query;

  if (error) {
    console.warn("⚠️ Microsoft OAuth error:", error, error_description);
    res.redirect(`/?auth_error=${encodeURIComponent(error_description || error)}`);
    return;
  }

  if (!code) {
    res.redirect("/?auth_error=missing_code");
    return;
  }

  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("❌ Missing AZURE_CLIENT_ID or AZURE_CLIENT_SECRET in environment");
    res.redirect("/?auth_error=server_configuration_error");
    return;
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
  const redirectUri = `${proto}://${host}/api/auth/oauth/microsoft/callback`;

  try {
    // 1. Exchange authorization code for tokens
    const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: "openid email profile User.Read"
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("❌ Microsoft token exchange failed:", tokenData);
      res.redirect(`/?auth_error=${encodeURIComponent(tokenData.error_description || "Microsoft token exchange failed")}`);
      return;
    }

    // 2. Fetch user profile from Microsoft Graph
    const graphRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const graphUser = await graphRes.json();
    if (!graphRes.ok) {
      console.error("❌ Failed to fetch Microsoft Graph user:", graphUser);
      res.redirect("/?auth_error=failed_to_fetch_user_profile");
      return;
    }

    // Work accounts usually have 'mail', fallback to 'userPrincipalName'
    const email = (graphUser.mail || graphUser.userPrincipalName || "").toLowerCase().trim();
    if (!email) {
      console.error("❌ No email found in Microsoft profile:", graphUser);
      res.redirect("/?auth_error=no_email_returned_from_microsoft");
      return;
    }

    console.log(`🔑 Verified Microsoft OAuth login attempt for: ${email}`);

    // 3. Verify user authorization in Users sheet and mint session cookie
    const result = await createSessionForVerifiedEmail(email, res, "Microsoft");

    if (!result.success) {
      console.warn(`⛔ Access denied for Microsoft user ${email}:`, result.message);
      res.redirect(`/?auth_error=unauthorized&email=${encodeURIComponent(email)}&provider=Microsoft`);
      return;
    }

    console.log(`✅ Microsoft OAuth login successful for: ${email}`);
    res.redirect("/");
    return;
  } catch (err) {
    console.error("❌ Microsoft OAuth callback exception:", err);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message || "An unexpected error occurred during Microsoft sign in")}`);
    return;
  }
}
