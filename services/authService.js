import crypto from "crypto";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";
import { redisClient } from "./redisClient.js";
import { getSheetsClient } from "./sheetsClient.js";
import { getUserByEmail, updateUserLastLogin } from "./userPermissions.js";
import { logPmaActivity } from "./pmaLogger.js";
import { logPulseActivity } from "./pulseLogger.js";

const OTP_EXPIRY_SECS = 600; // 10 minutes
const COOLDOWN_SECS = 60; // 60 seconds
export const SESSION_MAX_AGE_SECS = 7 * 24 * 60 * 60; // 7 days

function serializeCookie(name, val, options = {}) {
  let str = `${encodeURIComponent(name)}=${encodeURIComponent(val)}`;
  if (options.maxAge != null) str += `; Max-Age=${Math.floor(options.maxAge)}`;
  if (options.domain) str += `; Domain=${options.domain}`;
  if (options.path) str += `; Path=${options.path}`;
  if (options.expires) str += `; Expires=${options.expires.toUTCString()}`;
  if (options.httpOnly) str += `; HttpOnly`;
  if (options.secure) str += `; Secure`;
  if (options.sameSite) {
    const s = typeof options.sameSite === 'string' ? options.sameSite.toLowerCase() : options.sameSite;
    if (s === true || s === 'strict') str += `; SameSite=Strict`;
    else if (s === 'lax') str += `; SameSite=Lax`;
    else if (s === 'none') str += `; SameSite=None`;
  }
  return str;
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    acc[decodeURIComponent(key)] = decodeURIComponent(val);
    return acc;
  }, {});
}

const _devEphemeralSecret = crypto.randomBytes(32).toString("hex");

/**
 * Get JWT Secret from environment with fail-closed production enforcement
 */
export function getJwtSecret() {
  if (process.env.PMA_JWT_SECRET && process.env.PMA_JWT_SECRET.trim().length > 0) {
    return process.env.PMA_JWT_SECRET.trim();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("FATAL: PMA_JWT_SECRET environment variable is missing or empty in production.");
  }
  console.warn("⚠️ WARNING: PMA_JWT_SECRET is unset. Using ephemeral development secret.");
  return _devEphemeralSecret;
}


export function isBlockedOtpRole(role) {
  const r = String(role || "").toLowerCase().trim();
  return r === "admin" || r === "clientmanager" || r === "client manager";
}

/**
 * Send an OTP verification code to the given email address
 */
export async function sendOtp(email, automationCommanderSheetId, clientIp) {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(normalizedEmail)) {
    return { success: false, message: "Invalid email address format" };
  }

  // IP-based rate limiting (max 10 requests per 15 minutes per IP)
  if (clientIp) {
    const ipRateLimitKey = `pma_ip_ratelimit:${clientIp}`;
    try {
      const currentIpCount = await redisClient.incr(ipRateLimitKey);
      if (currentIpCount === 1) {
        await redisClient.expire(ipRateLimitKey, 900); // 15 minutes
      }
      if (currentIpCount > 10) {
        return {
          success: false,
          message: "Too many authentication requests from this IP. Please try again in 15 minutes."
        };
      }
    } catch (e) {
      console.warn("⚠️ IP rate limit check warning:", e.message);
    }
  }

  // Check if user is in Users sheet
  let user = null;
  try {
    const sheets = await getSheetsClient();
    user = await getUserByEmail(normalizedEmail, sheets, automationCommanderSheetId);
  } catch (err) {
    console.error("⚠️ Error checking user in Users sheet:", err.message);
  }

  if (!user || user.status === "Suspended") {
    console.log(`❌ Auth check failed for email: ${normalizedEmail} (not in Users tab or Suspended)`);
    try {
      const sheets = await getSheetsClient();
      const targetClient = user ? (Array.isArray(user.assignedClients) && user.assignedClients.length === 1 ? user.assignedClients[0] : "Multi-Client") : "Unregistered";
      logPulseActivity(sheets, {
        automationCommanderSheetId,
        clientName: targetClient,
        category: "AUTH",
        action: "LOGIN_BLOCKED",
        summary: `Blocked verification request for ${normalizedEmail}: ${!user ? "Email not registered" : "Account suspended"}`,
        details: { email: normalizedEmail, provider: "EmailOTP", reason: !user ? "Unregistered email" : "Account suspended", ip: clientIp || "-" },
        user: normalizedEmail
      }).catch(() => {});
    } catch {}

    // Generic message to avoid email enumeration
    return {
      success: true,
      message: "If this email address is registered, a verification code has been sent. Please check your inbox."
    };
  }

  // Block Admin and Client Manager from logging in via OTP
  const isBlockedRole = user && (user.isAdmin || user.role === "Admin" || user.role === "ClientManager" || String(user.role || "").toLowerCase() === "clientmanager");
  if (isBlockedRole) {
    console.log(`❌ Auth check blocked: ${normalizedEmail} has role ${user.role} and cannot log in via Email OTP.`);
    try {
      const sheets = await getSheetsClient();
      logPulseActivity(sheets, {
        automationCommanderSheetId,
        clientName: "System",
        category: "AUTH",
        action: "LOGIN_BLOCKED",
        summary: `Blocked OTP login for ${user.role} (${normalizedEmail}): Admin and Client Manager must use SSO`,
        details: { email: normalizedEmail, role: user.role, provider: "EmailOTP", reason: "OTP not permitted for Admin/ClientManager", ip: clientIp || "-" },
        user: normalizedEmail
      }).catch(() => {});
    } catch {}

    return {
      success: false,
      adminOtpBlocked: true,
      message: "You cannot access Pulse or the Pulse Management Area using a one-time password. Please log in using Google or Microsoft."
    };
  }

  // Rate limiting cooldown check
  const cooldownKey = `pma_otp_cooldown:${normalizedEmail}`;
  try {
    const inCooldown = await redisClient.get(cooldownKey);
    if (inCooldown) {
      const ttl = await redisClient.ttl(cooldownKey);
      return {
        success: false,
        message: `Please wait ${ttl > 0 ? ttl : 60} seconds before requesting another code.`
      };
    }
  } catch (e) {
    console.warn("⚠️ Redis cooldown check warning:", e.message);
  }

  // Generate 6-digit numeric OTP code using cryptographically secure PRNG (CWE-330)
  const code = crypto.randomInt(100000, 1000000).toString();
  if (process.env.NODE_ENV !== "production") {
    console.log(`📧 Generated OTP code for ${normalizedEmail}: ${code}`);
  } else {
    console.log(`📧 Generated OTP code for ${normalizedEmail}`);
  }

  // Store OTP in Redis
  const otpKey = `pma_otp:${normalizedEmail}`;
  try {
    await redisClient.set(otpKey, JSON.stringify({ code, attempts: 0 }), { EX: OTP_EXPIRY_SECS });
    await redisClient.set(cooldownKey, "1", { EX: COOLDOWN_SECS });
  } catch (e) {
    console.error("❌ Redis OTP storage error:", e.message);
    return { success: false, message: "Internal server error storing verification code." };
  }

  // Log successful OTP generation
  try {
    const sheets = await getSheetsClient();
    const targetClient = user.isAdmin ? "System" : (Array.isArray(user.assignedClients) && user.assignedClients.length === 1 ? user.assignedClients[0] : "Multi-Client");
    logPulseActivity(sheets, {
      automationCommanderSheetId,
      clientName: targetClient,
      category: "AUTH",
      action: "AUTH_CODE_REQUESTED",
      summary: `Verification code generated and sent to ${normalizedEmail}`,
      details: { email: normalizedEmail, provider: "EmailOTP", role: user.role, assignedClients: user.assignedClients, ip: clientIp || "-" },
      user: user.name || normalizedEmail
    }).catch(() => {});
  } catch {}

  // Dispatch Email
  const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
  const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;

  const subject = `Pulse Secure Access: Your Verification Code (${code})`;
  const textBody = `Hello,\n\nYour secure verification code for Pulse is: ${code}\n\nThis code will expire in 10 minutes. If you did not request this code, please ignore this email.\n\nBest regards,\nThe Pulse Team\n\n---\nThrive Organisational Consulting Ltd\nThis is an automated security message. Please do not reply.`;

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333333;">
      <h2 style="color: #0047AB; border-bottom: 2px solid #f3f4f6; padding-bottom: 10px; margin-top: 0;">Pulse Secure Access</h2>
      <p style="font-size: 16px; line-height: 1.5;">Hello,</p>
      <p style="font-size: 16px; line-height: 1.5;">Your secure verification code to access Pulse is:</p>
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin: 25px 0; text-align: center;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #0047AB;">${code}</span>
      </div>
      <p style="font-size: 14px; line-height: 1.5; color: #666666;">This code is valid for the next 10 minutes. For security reasons, please do not share this code with anyone. If you did not request access to the dashboard, you can safely ignore this email.</p>
      <p style="font-size: 16px; line-height: 1.5; margin-top: 30px;">Thanks,<br><strong>The Pulse Team</strong></p>
      
      <!-- Corporate Trust & Compliance Markers -->
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; line-height: 1.6;">
        <p style="margin: 0 0 5px 0;">&copy; ${new Date().getFullYear()} Thrive Organisational Consulting Ltd. All rights reserved.</p>
        <p style="margin: 0 0 5px 0;">This is an automated transactional security message. Replies to this mailbox are unmonitored.</p>
        <p style="margin: 0;"><em>Confidentiality Notice: This email and any attachments are confidential and intended solely for the use of the individual or entity to whom they are addressed.</em></p>
      </div>
    </div>
  `;

  if (emailPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {
          user: emailUser,
          pass: emailPass
        }
      });

      await transporter.sendMail({
        from: `"Pulse" <${emailUser}>`,
        to: normalizedEmail,
        subject: subject,
        text: textBody,
        html: htmlBody
      });
      console.log(`✅ Verification email sent to ${normalizedEmail} via Gmail SMTP.`);
      return { success: true, message: `Verification code sent to ${normalizedEmail}.` };
    } catch (sendErr) {
      console.error(`❌ Gmail SMTP sending failed:`, sendErr.message);
      // In dev mode or until App Password is saved, print to console so login is possible
      console.log(`🔑 [PMA OTP CODE FOR DEV]: ${code}`);
      return {
        success: true,
        message: `Verification code generated. (SMTP Notice: ${sendErr.message})`,
        devCode: process.env.NODE_ENV !== "production" ? code : undefined
      };
    }
  } else {
    // No app password configured yet
    console.warn(`⚠️ PMA_EMAIL_APP_PASSWORD is not configured in .env.local.`);
    if (process.env.NODE_ENV !== "production") {
      console.log(`🔑 ==========================================`);
      console.log(`🔑 [PMA OTP CODE]: ${code} (for ${normalizedEmail})`);
      console.log(`🔑 ==========================================`);
    }
    return {
      success: true,
      message: `Verification code generated. (Configure PMA_EMAIL_APP_PASSWORD in .env.local to send live emails).`,
      devCode: process.env.NODE_ENV !== "production" ? code : undefined
    };
  }
}

/**
 * Verify OTP code and issue session token & cookie
 */
export async function verifyOtp(email, code, automationCommanderSheetId, res, clientIp = "-") {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  const enteredCode = String(code || "").trim();

  if (!normalizedEmail || !enteredCode) {
    return { success: false, message: "Email and verification code are required" };
  }

  const otpKey = `pma_otp:${normalizedEmail}`;
  let cachedData = null;
  try {
    const raw = await redisClient.get(otpKey);
    if (raw) cachedData = JSON.parse(raw);
  } catch (e) {
    console.error("❌ Redis get OTP error:", e.message);
  }

  if (!cachedData) {
    getSheetsClient().then(sheets => {
      logPulseActivity(sheets, {
        automationCommanderSheetId,
        clientName: "System",
        category: "AUTH",
        action: "LOGIN_FAILED",
        summary: `Failed verification for ${normalizedEmail} (Code expired or invalid)`,
        details: { email: normalizedEmail, reason: "Verification code expired or invalid", ip: clientIp },
        user: normalizedEmail
      });
    }).catch(() => {});

    return {
      success: false,
      message: "Verification code has expired or is invalid. Please request a new code."
    };
  }

  const currentAttempts = parseInt(cachedData.attempts || 0, 10);
  if (currentAttempts >= 4) {
    // 5th failed attempt purges code
    try { await redisClient.del(otpKey); } catch { }
    getSheetsClient().then(sheets => {
      logPulseActivity(sheets, {
        automationCommanderSheetId,
        clientName: "System",
        category: "AUTH",
        action: "AUTH_LOCKED",
        summary: `Account locked for ${normalizedEmail} (Exceeded 5 failed attempts)`,
        details: { email: normalizedEmail, reason: "Max attempts exceeded", ip: clientIp },
        user: normalizedEmail
      });
    }).catch(() => {});

    return {
      success: false,
      message: "Too many failed attempts. Please request a new verification code."
    };
  }

  if (String(cachedData.code) !== enteredCode) {
    const newAttempts = currentAttempts + 1;
    cachedData.attempts = newAttempts;
    const ttl = await redisClient.ttl(otpKey);
    try {
      await redisClient.set(otpKey, JSON.stringify(cachedData), { EX: ttl > 0 ? ttl : 300 });
    } catch { }

    const remaining = 5 - newAttempts;
    getSheetsClient().then(sheets => {
      logPulseActivity(sheets, {
        automationCommanderSheetId,
        clientName: "System",
        category: "AUTH",
        action: "LOGIN_FAILED",
        summary: `Failed verification for ${normalizedEmail} (Incorrect code, attempt ${newAttempts}/5)`,
        details: { email: normalizedEmail, reason: "Incorrect code", attempt: newAttempts, maxAttempts: 5, ip: clientIp },
        user: normalizedEmail
      });
    }).catch(() => {});

    return {
      success: false,
      message: `Invalid verification code. You have ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
    };
  }

  // Code matches! Destroy OTP from Redis
  try { await redisClient.del(otpKey); } catch { }

  return await createSessionForVerifiedEmail(normalizedEmail, res, "EmailOTP", automationCommanderSheetId, clientIp);
}

/**
 * Create a session for an already verified email (via OAuth or OTP)
 */
export async function createSessionForVerifiedEmail(email, res, provider = "OAuth", automationCommanderSheetId, clientIp = "-") {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  if (!normalizedEmail) {
    return { success: false, message: "Email is required" };
  }

  // Invalidate Redis user cache so fresh spreadsheet permissions are always loaded
  try { await redisClient.del("pma:users:list"); } catch { }

  // Fetch full user record directly from spreadsheet
  const sheets = await getSheetsClient();
  const user = await getUserByEmail(normalizedEmail, sheets, automationCommanderSheetId, true);

  if (!user || user.status === "Suspended") {
    const targetClient = user ? (Array.isArray(user.assignedClients) && user.assignedClients.length === 1 ? user.assignedClients[0] : "Multi-Client") : "Unregistered";
    logPulseActivity(sheets, {
      automationCommanderSheetId,
      clientName: targetClient,
      category: "AUTH",
      action: "LOGIN_BLOCKED",
      summary: `Blocked sign-in for ${normalizedEmail} via ${provider}: ${!user ? "Account not authorized" : "Account suspended"}`,
      details: { email: normalizedEmail, provider, reason: !user ? "Not authorized" : "Suspended", ip: clientIp },
      user: normalizedEmail
    }).catch(() => {});

    return {
      success: false,
      unauthorized: true,
      message: "This account is not authorized to access Pulse or has been suspended."
    };
  }

  // Block Admin or ClientManager if logging in via EmailOTP
  const isBlockedRole = provider === "EmailOTP" && user && (user.isAdmin || user.role === "Admin" || user.role === "ClientManager" || String(user.role || "").toLowerCase() === "clientmanager");
  if (isBlockedRole) {
    return {
      success: false,
      adminOtpBlocked: true,
      message: "You cannot access Pulse or the Pulse Management Area using a one-time password. Please log in using Google or Microsoft."
    };
  }

  // Update last login
  updateUserLastLogin(normalizedEmail, sheets, automationCommanderSheetId).catch(err => {
    console.warn("⚠️ Failed to update user last login:", err.message);
  });

  const targetClient = user.isAdmin
    ? "System"
    : (Array.isArray(user.assignedClients) && user.assignedClients.length === 1 ? user.assignedClients[0] : "Multi-Client");

  // Log activity to PulseActivityLog
  logPulseActivity(sheets, {
    automationCommanderSheetId,
    clientName: targetClient,
    category: "AUTH",
    action: "LOGIN_SUCCESS",
    summary: `User signed in: ${user.name} (${user.email}) via ${provider}`,
    details: { role: user.role, assignedClients: user.assignedClients, provider, ip: clientIp },
    user: user.name || user.email
  }).catch(() => { });

  // Log activity to PmaActivityLog
  logPmaActivity(sheets, {
    automationCommanderSheetId,
    clientName: targetClient,
    category: "Auth",
    action: "USER_LOGIN",
    summary: `User signed in: ${user.name} (${user.email}) via ${provider}`,
    details: `Role: ${user.role}, Assigned Clients: ${Array.isArray(user.assignedClients) ? user.assignedClients.join(", ") : user.assignedClients}`,
    user: user.name || user.email
  }).catch(() => { });

  const isReadOnly = provider === "EmailOTP";

  // Sign JWT session
  const payload = {
    tokenType: "session",
    email: user.email,
    name: user.name,
    role: user.role,
    assignedClients: user.assignedClients,
    authProvider: provider,
    isReadOnly
  };

  const secret = getJwtSecret();
  const token = jwt.sign(payload, secret, { expiresIn: `${SESSION_MAX_AGE_SECS}s` });
  // Set HTTP-only Cookie if response object is provided
  if (res && typeof res.setHeader === "function") {
    const isProd = process.env.NODE_ENV === "production";
    const sessionCookie = serializeCookie("pma_session", token, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECS
    });
    res.setHeader("Set-Cookie", sessionCookie);
  }

  return {
    success: true,
    message: "Login successful",
    token,
    user: {
      ...payload,
      isAdmin: user.role === "Admin",
      isSenior: user.role === "Senior (Restricted)" || String(user.role || "").toLowerCase().includes("senior"),
      isClientUser: user.role === "ClientUser",
      isReadOnly,
      authProvider: provider
    }
  };
}

/**
 * Extract and verify session user from Next.js req object
 */
export function getSessionUser(req) {
  if (!req) return null;

  let token = null;

  // 1. Check HTTP-only cookie
  if (req.headers && req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.pma_session) {
      token = cookies.pma_session;
    }
  }

  // 2. Check Authorization header
  if (!token && req.headers && req.headers.authorization) {
    const parts = req.headers.authorization.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      token = parts[1];
    }
  }

  // 3. Check custom header x-pma-token
  if (!token && req.headers && req.headers["x-pma-token"]) {
    token = req.headers["x-pma-token"];
  }

  if (!token) return null;

  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(token, secret);
    if (!decoded || !decoded.email) return null;

    // Explicitly reject transient or single-purpose tokens (e.g. sso_token) from being used as session tokens
    if (decoded.tokenType && decoded.tokenType !== "session") return null;

    // Secure default: if assignedClients is undefined or missing, default to empty array (never "*")
    const assignedClients = decoded.assignedClients === "*"
      ? "*"
      : (Array.isArray(decoded.assignedClients) ? decoded.assignedClients : []);

    const role = decoded.role || "ClientUser";
    // Only Admin is an internal staff role able to see all clients
    const isAdmin = role === "Admin";
    const isSenior = role === "Senior (Restricted)" || String(role).toLowerCase().includes("senior");
    const isClientUser = role === "ClientUser";
    const isReadOnly = Boolean(decoded.isReadOnly || decoded.authProvider === "EmailOTP");

    // Admins and Client Managers are strictly forbidden from having OTP sessions
    if (decoded.authProvider === "EmailOTP" && (isAdmin || isBlockedOtpRole(role))) {
      return null;
    }

    return {
      email: decoded.email,
      name: decoded.name || decoded.email.split("@")[0],
      role,
      assignedClients,
      isAdmin,
      isSenior,
      isClientUser,
      isReadOnly,
      authProvider: decoded.authProvider || "OAuth"
    };
  } catch (err) {
    return null;
  }
}

/**
 * Invalidate session cookie on logout
 */
export function clearSessionCookie(res) {
  if (res && typeof res.setHeader === "function") {
    res.setHeader("Set-Cookie", serializeCookie("pma_session", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0
    }));
  }
}

