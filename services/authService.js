import crypto from "crypto";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";
import { redisClient, ensureRedisConnected } from "./redisClient.js";
import { getSheetsClient } from "./sheetsClient.js";
import { getAllUsers, getUserByEmail, updateUserLastLogin, getCanonicalAcSheetId, isUserAuthorizedForClient, isReadOnlySession, USER_REVOKED_AT_PREFIX } from "./userPermissions.js";
import { unwrapRequestSheetIds, installSheetIdBoundary } from "./sheetTokenService.js";
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
    try {
      acc[decodeURIComponent(key)] = decodeURIComponent(val);
    } catch {
      acc[key] = val;
    }
    return acc;
  }, {});
}

if (!globalThis.__PULSE_DEV_JWT_SECRET__) {
  globalThis.__PULSE_DEV_JWT_SECRET__ = crypto.randomBytes(32).toString("hex");
}
const _devEphemeralSecret = globalThis.__PULSE_DEV_JWT_SECRET__;

/**
 * Get JWT Secret from environment with fail-closed production enforcement
 */
export function getJwtSecret() {
  if (process.env.PMA_JWT_SECRET && process.env.PMA_JWT_SECRET.trim().length > 0) {
    return process.env.PMA_JWT_SECRET.trim();
  }
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.trim().length > 0) {
    return process.env.AUTH_SECRET.trim();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("FATAL: PMA_JWT_SECRET environment variable is missing or empty in production.");
  }
  console.warn("⚠️ WARNING: PMA_JWT_SECRET is unset. Using ephemeral development secret.");
  return _devEphemeralSecret;
}

function getOAuthStateEncryptionKey() {
  return crypto.createHash("sha256").update(`oauth_state_enc:${getJwtSecret()}`).digest();
}

/**
 * Create an AES-256-GCM authenticated & encrypted OAuth state token (V4-HIGH-05 remediation)
 */
export function createSignedOAuthState(payload) {
  const cleanPayload = payload && typeof payload === "object" ? { ...payload } : {};
  unwrapRequestSheetIds(cleanPayload);
  const enriched = {
    ...cleanPayload,
    ts: cleanPayload?.ts || Date.now(),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getOAuthStateEncryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(enriched), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `st2.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

/**
 * Verify and decrypt an AES-256-GCM OAuth state token (V4-HIGH-05 remediation)
 */
export function verifySignedOAuthState(stateToken, maxAgeMs = 15 * 60 * 1000) {
  if (!stateToken || typeof stateToken !== "string" || !stateToken.startsWith("st2.")) {
    return null;
  }
  const parts = stateToken.split(".");
  if (parts.length !== 4) return null;
  const [, ivB64, tagB64, encB64] = parts;
  if (!ivB64 || !tagB64 || !encB64) return null;

  try {
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const enc = Buffer.from(encB64, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", getOAuthStateEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (maxAgeMs > 0 && (!parsed.ts || Date.now() - Number(parsed.ts) > maxAgeMs)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}


export function isBlockedOtpRole(role) {
  const r = String(role || "").toLowerCase().trim();
  return r === "admin" || r === "clientmanager" || r === "client manager";
}

function safeCompareCode(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
  const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Extracts the trusted client IP address from the request.
 */
export function getTrustedClientIp(req) {
  if (!req || !req.headers) return "127.0.0.1";
  const vercelFwd = req.headers["x-vercel-forwarded-for"];
  if (typeof vercelFwd === "string" && vercelFwd.trim()) {
    return vercelFwd.split(",")[0].trim();
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.split(",")[0].trim();
  }
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",").pop().trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[forwarded.length - 1]).trim();
  }
  return req.socket?.remoteAddress || "127.0.0.1";
}

/**
 * Shared Redis sliding-window rate limiter.
 */
export async function checkRateLimit(bucket, identifier, maxRequests = 60, windowSecs = 60) {
  const cleanBucket = String(bucket || "default").replace(/[^a-z0-9_-]/gi, "_");
  const cleanId = String(identifier || "anon").trim().toLowerCase().slice(0, 128);
  const key = `pma_rl:${cleanBucket}:${cleanId}`;
  try {
    if (!redisClient?.isOpen) return { allowed: true, count: 0 };
    const count = await redisClient.incr(key);
    if (count === 1) {
      await redisClient.expire(key, Math.max(1, Math.trunc(windowSecs)));
    }
    return { allowed: count <= maxRequests, count };
  } catch (err) {
    console.warn("⚠️ Rate limit check warning:", err.message);
    return { allowed: true, count: 0 };
  }
}

const VERIFY_OTP_LUA = `
  local otpKey = KEYS[1]
  local attemptsKey = KEYS[2]
  local entered = ARGV[1]

  local attempts = tonumber(redis.call('GET', attemptsKey) or '0')
  if attempts >= 5 then
    redis.call('DEL', otpKey)
    return {-2, attempts}
  end

  local raw = redis.call('GET', otpKey)
  if not raw then
    return {-1, attempts}
  end

  local ok, data = pcall(cjson.decode, raw)
  if not ok or type(data) ~= 'table' then
    return {-1, attempts}
  end

  if tostring(data.code or '') == entered then
    redis.call('DEL', otpKey)
    redis.call('DEL', attemptsKey)
    return {1, 0}
  end

  local nextAttempts = redis.call('INCR', attemptsKey)
  if nextAttempts == 1 then
    redis.call('EXPIRE', attemptsKey, 900)
  end
  if nextAttempts >= 5 then
    redis.call('DEL', otpKey)
    redis.call('EXPIRE', attemptsKey, 900)
    return {-2, nextAttempts}
  end
  return {0, nextAttempts}
`;

/**
 * Send an OTP verification code to the given email address
 */
export async function sendOtp(email, _ignoredAcId, clientIp) {
  const automationCommanderSheetId = getCanonicalAcSheetId();
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

  // Rate limiting cooldown & lockout check (performed before user lookup to prevent enumeration/DoS)
  const cooldownKey = `pma_otp_cooldown:${normalizedEmail}`;
  const attemptsKey = `pma_otp_attempts:${normalizedEmail}`;
  try {
    const priorFailedAttempts = parseInt((await redisClient.get(attemptsKey)) || "0", 10) || 0;
    if (priorFailedAttempts >= 5) {
      return {
        success: false,
        message: "Too many failed verification attempts. Please try again in 15 minutes."
      };
    }
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
      await redisClient.set(cooldownKey, "1", { EX: COOLDOWN_SECS });
    } catch { }
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
      }).catch(() => { });
    } catch { }

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
      await redisClient.set(cooldownKey, "1", { EX: COOLDOWN_SECS });
    } catch { }
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
      }).catch(() => { });
    } catch { }

    return {
      success: true,
      message: "If this email address is registered, a verification code has been sent. Please check your inbox."
    };
  }

  // Generate 6-digit numeric OTP code using cryptographically secure PRNG (CWE-330)
  const code = crypto.randomInt(100000, 1000000).toString();
  if (process.env.NODE_ENV !== "production") {
    console.log(`📧 Generated OTP code for ${normalizedEmail}: ${code}`);
  } else {
    console.log(`📧 Generated OTP code for ${normalizedEmail}`);
  }

  // Store OTP in Redis (preserve attemptsKey across cooldowns to prevent brute-force reset)
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
    }).catch(() => { });
  } catch { }

  // Dispatch Email
  const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
  const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;

  const subject = "Pulse Secure Access: Your verification code";
  const textBody = `Hello,\n\nYour secure verification code for Pulse is: ${code}\n\nThis code will expire in 10 minutes. If you did not request this code, please ignore this email.\n\nBest regards,\nThe Pulse Team\n\n---\nThrive Organisational Consulting Ltd\nThis is an automated security message. Please do not reply.`;

  const htmlBody = `
    <div style="font-family: 'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333333;">
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
      return {
        success: true,
        message: "If this email address is registered, a verification code has been sent. Please check your inbox."
      };
    } catch (sendErr) {
      console.error(`❌ Gmail SMTP sending failed:`, sendErr.message);
      if (process.env.NODE_ENV !== "production") {
        console.log(`🔑 [PMA OTP CODE FOR DEV]: ${code}`);
        return {
          success: true,
          message: `Verification code generated. (SMTP Notice: ${sendErr.message})`,
          devCode: code
        };
      }
      return {
        success: false,
        message: "Unable to send verification email right now. Please try again shortly."
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
export async function verifyOtp(email, code, _ignoredAcId, res, clientIp = "-") {
  const automationCommanderSheetId = getCanonicalAcSheetId();
  const normalizedEmail = String(email || "").toLowerCase().trim();
  const enteredCode = String(code || "").trim();

  if (!normalizedEmail || !enteredCode) {
    return { success: false, message: "Email and verification code are required" };
  }

  // Per-IP verification rate limit (max 15 guesses per 15 minutes per IP)
  if (clientIp && clientIp !== "-") {
    const ipRl = await checkRateLimit("otp_verify_ip", clientIp, 15, 900);
    if (!ipRl.allowed) {
      return {
        success: false,
        message: "Too many verification attempts from this IP. Please try again in 15 minutes."
      };
    }
  }

  const otpKey = `pma_otp:${normalizedEmail}`;
  const attemptsKey = `pma_otp_attempts:${normalizedEmail}`;

  // Status codes: 1 = matched & deleted, -1 = missing/expired, -2 = locked out (>= 5), 0 = wrong code
  let status = -1;
  let newAttempts = 0;

  try {
    if (redisClient?.isOpen && typeof redisClient.eval === "function") {
      const luaRes = await redisClient.eval(VERIFY_OTP_LUA, {
        keys: [otpKey, attemptsKey],
        arguments: [enteredCode]
      });
      if (Array.isArray(luaRes)) {
        status = Number(luaRes[0]);
        newAttempts = Number(luaRes[1]) || 0;
      }
    } else if (redisClient?.isOpen) {
      const priorAttempts = parseInt((await redisClient.get(attemptsKey)) || "0", 10) || 0;
      if (priorAttempts >= 5) {
        await redisClient.del(otpKey).catch(() => { });
        status = -2;
        newAttempts = priorAttempts;
      } else {
        const raw = await redisClient.get(otpKey);
        const cachedData = raw ? JSON.parse(raw) : null;
        if (!cachedData) {
          status = -1;
        } else if (safeCompareCode(String(cachedData.code || ""), enteredCode)) {
          await redisClient.del(otpKey).catch(() => { });
          await redisClient.del(attemptsKey).catch(() => { });
          status = 1;
        } else {
          newAttempts = await redisClient.incr(attemptsKey);
          if (newAttempts === 1) await redisClient.expire(attemptsKey, 900);
          if (newAttempts >= 5) {
            await redisClient.del(otpKey).catch(() => { });
            await redisClient.expire(attemptsKey, 900);
            status = -2;
          } else {
            status = 0;
          }
        }
      }
    }
  } catch (e) {
    console.error("❌ Redis verify OTP error:", e.message);
  }

  if (status === 1) {
    return await createSessionForVerifiedEmail(normalizedEmail, res, "EmailOTP", automationCommanderSheetId, clientIp);
  }

  if (status === -2) {
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
    }).catch(() => { });

    return {
      success: false,
      message: "Too many failed attempts. Please request a new verification code."
    };
  }

  if (status === 0) {
    const remaining = Math.max(0, 5 - newAttempts);
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
    }).catch(() => { });

    return {
      success: false,
      message: `Invalid verification code. You have ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
    };
  }

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
  }).catch(() => { });

  return {
    success: false,
    message: "Verification code has expired or is invalid. Please request a new code."
  };
}

/**
 * Create a session for an already verified email (via OAuth or OTP)
 */
export async function createSessionForVerifiedEmail(email, res, provider = "OAuth", _ignoredAcId, clientIp = "-") {
  const automationCommanderSheetId = getCanonicalAcSheetId();
  const normalizedEmail = String(email || "").toLowerCase().trim();
  if (!normalizedEmail) {
    return { success: false, message: "Email is required" };
  }

  // Invalidate Redis user cache so fresh spreadsheet permissions are always loaded
  try { await redisClient.del("pma:users:list"); } catch { }

  // Fetch full user record directly from canonical spreadsheet
  const sheets = await getSheetsClient();
  const user = await getUserByEmail(normalizedEmail, sheets, automationCommanderSheetId, true);

  if (!user || user.status === "Suspended") {
    clearSessionCookie(res);
    const targetClient = user ? (Array.isArray(user.assignedClients) && user.assignedClients.length === 1 ? user.assignedClients[0] : "Multi-Client") : "Unregistered";
    logPulseActivity(sheets, {
      automationCommanderSheetId,
      clientName: targetClient,
      category: "AUTH",
      action: "LOGIN_BLOCKED",
      summary: `Blocked sign-in for ${normalizedEmail} via ${provider}: ${!user ? "Account not authorized" : "Account suspended"}`,
      details: { email: normalizedEmail, provider, reason: !user ? "Not authorized" : "Suspended", ip: clientIp },
      user: normalizedEmail
    }).catch(() => { });

    return {
      success: false,
      unauthorized: true,
      message: "This account is not authorized to access Pulse or has been suspended."
    };
  }

  // Block Admin or ClientManager if logging in via EmailOTP or Microsoft (internal staff use Google SSO)
  const isStaffRole = user && (user.isAdmin || user.role === "Admin" || user.role === "ClientManager" || String(user.role || "").toLowerCase() === "clientmanager");
  if (provider === "EmailOTP" && isStaffRole) {
    return {
      success: false,
      adminOtpBlocked: true,
      message: "You cannot access Pulse or the Pulse Management Area using a one-time password. Please log in using Google."
    };
  }
  if (provider === "Microsoft" && isStaffRole) {
    clearSessionCookie(res);
    return {
      success: false,
      unauthorized: true,
      message: "Staff and administrator accounts must sign in using Google."
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
  const resolvedUser = buildSessionUser({
    email: user.email,
    name: user.name,
    role: user.role,
    assignedClients: user.assignedClients,
    authProvider: provider,
    isReadOnly
  });

  // Sign JWT session and set HTTP-only cookie
  const payload = mintSessionCookie(res, {
    email: user.email,
    name: user.name,
    role: user.role,
    assignedClients: resolvedUser ? resolvedUser.assignedClients : user.assignedClients,
    authProvider: provider,
    isReadOnly
  });

  return {
    success: true,
    message: "Login successful",
    user: {
      ...payload,
      ...(resolvedUser || {
        isAdmin: user.role === "Admin" && !isReadOnly,
        isSenior: user.role === "Senior (Restricted)" || String(user.role || "").toLowerCase().includes("senior"),
        isClientUser: user.role === "ClientUser",
        isReadOnly,
        authProvider: provider
      })
    }
  };
}

function appendSetCookie(res, cookieStr) {
  if (!res || typeof res.setHeader !== "function") return;
  const existing = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : null;
  const existingArr = Array.isArray(existing) ? existing : (existing ? [String(existing)] : []);
  const filtered = existingArr.filter((c) => !String(c).startsWith("pma_session="));
  filtered.push(cookieStr);
  res.setHeader("Set-Cookie", filtered.length === 1 ? filtered[0] : filtered);
}

function buildSessionUser({ email, name, role, assignedClients, authProvider, isReadOnly }) {
  const effectiveRole = role || "ClientUser";
  const effectiveReadOnly = Boolean(isReadOnly || authProvider === "EmailOTP");

  // Admins and Client Managers are strictly forbidden from having OTP / read-only sessions
  if ((authProvider === "EmailOTP" || effectiveReadOnly) && (effectiveRole === "Admin" || isBlockedOtpRole(effectiveRole))) {
    return null;
  }

  // Only non-read-only Admin is an internal staff role able to see all clients
  const isAdmin = effectiveRole === "Admin" && !effectiveReadOnly;
  const isSenior = effectiveRole === "Senior (Restricted)" || String(effectiveRole).toLowerCase().includes("senior");
  const isClientUser = effectiveRole === "ClientUser";

  // Secure default: only Admin may hold wildcard "*" assignedClients
  const normalizedAssigned = (isAdmin && assignedClients === "*")
    ? "*"
    : (Array.isArray(assignedClients) ? assignedClients : []);

  return {
    email,
    name: name || String(email).split("@")[0],
    role: effectiveRole,
    assignedClients: normalizedAssigned,
    isAdmin,
    isSenior,
    isClientUser,
    isReadOnly: effectiveReadOnly,
    authProvider: authProvider || "OAuth"
  };
}

function mintSessionCookie(res, { email, name, role, assignedClients, authProvider, isReadOnly }) {
  const payload = {
    jti: crypto.randomUUID(),
    tokenType: "session",
    email,
    name,
    role,
    assignedClients,
    authProvider,
    isReadOnly
  };

  const secret = getJwtSecret();
  const token = jwt.sign(payload, secret, { expiresIn: `${SESSION_MAX_AGE_SECS}s` });
  if (res && typeof res.setHeader === "function") {
    const isProd = process.env.NODE_ENV === "production";
    const sessionCookie = serializeCookie("pma_session", token, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECS
    });
    appendSetCookie(res, sessionCookie);
  }
  return payload;
}

function areAssignedClientsEqual(a, b) {
  if (a === "*" || b === "*") return a === b;
  const arrA = Array.isArray(a) ? [...a].map((x) => String(x || "").trim()).filter(Boolean).sort() : [];
  const arrB = Array.isArray(b) ? [...b].map((x) => String(x || "").trim()).filter(Boolean).sort() : [];
  if (arrA.length !== arrB.length) return false;
  return arrA.every((val, i) => val === arrB[i]);
}

/**
 * Constant-time string comparison for secrets and nonces (R2-LOW-01).
 */
export function safeCompareSecret(a, b) {
  if (!a || !b || typeof a !== "string" || typeof b !== "string") return false;
  const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
  const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function extractRawSessionToken(req) {
  if (!req || !req.headers) return null;
  if (req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.pma_session) return cookies.pma_session;
  }
  if (req.headers.authorization) {
    const parts = req.headers.authorization.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  }
  if (req.headers["x-pma-token"]) {
    return req.headers["x-pma-token"];
  }
  return null;
}

export async function revokeSessionJti(jti, exp = null) {
  if (!jti) return false;
  try {
    await ensureRedisConnected(400);
    if (!redisClient?.isOpen) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    const ttl = exp ? Math.max(60, Math.min(SESSION_MAX_AGE_SECS, Number(exp) - nowSec)) : SESSION_MAX_AGE_SECS;
    await redisClient.set(`pma:revoked_jti:${String(jti)}`, "1", { EX: ttl });
    return true;
  } catch {
    return false;
  }
}

export async function isSessionJtiRevoked(jti) {
  if (!jti) return false;
  try {
    await ensureRedisConnected(400);
    if (!redisClient?.isOpen) return false;
    const val = await redisClient.get(`pma:revoked_jti:${String(jti)}`);
    return Boolean(val);
  } catch {
    return false;
  }
}

export async function revokeRequestSessionJti(req) {
  const token = extractRawSessionToken(req);
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] });
    if (decoded?.jti) {
      return await revokeSessionJti(decoded.jti, decoded.exp);
    }
    const tokHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    await ensureRedisConnected(400);
    if (redisClient?.isOpen) {
      const nowSec = Math.floor(Date.now() / 1000);
      const ttl = decoded?.exp ? Math.max(60, Math.min(SESSION_MAX_AGE_SECS, Number(decoded.exp) - nowSec)) : SESSION_MAX_AGE_SECS;
      await redisClient.set(`pma:revoked_tok_hash:${tokHash}`, "1", { EX: ttl });
      return true;
    }
  } catch { }
  return false;
}

/**
 * Extract and verify session user from Next.js req object
 */
export function getSessionUser(req, res = null) {
  if (!req) return null;

  const activeRes = res || req.res || req.socket?._httpMessage || null;
  if (Object.prototype.hasOwnProperty.call(req, "_liveSessionUser")) {
    const cached = req._liveSessionUser;
    if (cached) {
      installSheetIdBoundary(req, activeRes, cached);
      return cached;
    }
    return null;
  }

  installSheetIdBoundary(req, activeRes);

  const token = extractRawSessionToken(req);
  if (!token) return null;

  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (!decoded || !decoded.email) return null;

    // Explicitly reject transient or single-purpose tokens (e.g. sso_token) from being used as session tokens
    if (decoded.tokenType && decoded.tokenType !== "session") return null;

    const userObj = buildSessionUser({
      email: decoded.email,
      name: decoded.name,
      role: decoded.role,
      assignedClients: decoded.assignedClients,
      authProvider: decoded.authProvider,
      isReadOnly: decoded.isReadOnly
    });
    if (!userObj) return null;

    const rawTokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    Object.defineProperties(userObj, {
      _jti: { value: decoded.jti || null, enumerable: false },
      _exp: { value: decoded.exp || null, enumerable: false },
      _iat: { value: decoded.iat || 0, enumerable: false },
      _rawTokenHash: { value: rawTokenHash, enumerable: false },
    });

    installSheetIdBoundary(req, activeRes, userObj);
    return userObj;
  } catch (err) {
    return null;
  }
}

/**
 * Resolve the active session user against the live user directory (Supabase / Redis / Users sheet),
 * so changes to assignedClients, role, or status apply immediately without requiring re-login.
 * When cookie claims are stale, automatically refreshes the pma_session cookie on res.
 */
export async function resolveLiveSessionUser(req, res = null, { sheets = null, bypassCache = false } = {}) {
  if (req && Object.prototype.hasOwnProperty.call(req, "_liveSessionUser")) {
    return req._liveSessionUser;
  }
  const sessionUser = getSessionUser(req, res);
  if (!sessionUser) {
    if (req) req._liveSessionUser = null;
    return null;
  }

  if (sessionUser._jti && (await isSessionJtiRevoked(sessionUser._jti))) {
    if (res) clearSessionCookie(res);
    if (req) req._liveSessionUser = null;
    return null;
  }

  let forceDirBypass = Boolean(bypassCache);
  try {
    await ensureRedisConnected(400);
    if (redisClient?.isOpen) {
      if (!sessionUser._jti && sessionUser._rawTokenHash) {
        const revHash = await redisClient.get(`pma:revoked_tok_hash:${sessionUser._rawTokenHash}`).catch(() => null);
        if (revHash) {
          if (res) clearSessionCookie(res);
          if (req) req._liveSessionUser = null;
          return null;
        }
      }
      const normEmailForRev = String(sessionUser.email || "").toLowerCase().trim();
      const revokedAtRaw = await redisClient.get(`${USER_REVOKED_AT_PREFIX}${normEmailForRev}`).catch(() => null);
      if (revokedAtRaw && Number(revokedAtRaw) >= Number(sessionUser._iat || 0)) {
        if (!sessionUser._jti) {
          if (res) clearSessionCookie(res);
          if (req) req._liveSessionUser = null;
          return null;
        }
        forceDirBypass = true;
      }
    }
  } catch { }

  const activeRes = res || req?.res || req?.socket?._httpMessage || null;

  try {
    const users = await getAllUsers(sheets, getCanonicalAcSheetId(), forceDirBypass);
    if (!Array.isArray(users) || users.length === 0) {
      // Fail closed when the live user directory cannot be verified
      if (req) req._liveSessionUser = null;
      return null;
    }

    const normEmail = String(sessionUser.email || "").toLowerCase().trim();
    const liveUser = users.find((u) => u.email === normEmail);
    if (!liveUser || liveUser.status === "Suspended") {
      if (sessionUser._jti) await revokeSessionJti(sessionUser._jti, sessionUser._exp);
      if (res) clearSessionCookie(res);
      if (req) req._liveSessionUser = null;
      return null;
    }

    const refreshed = buildSessionUser({
      email: liveUser.email,
      name: liveUser.name || sessionUser.name,
      role: liveUser.role,
      assignedClients: liveUser.assignedClients,
      authProvider: sessionUser.authProvider,
      isReadOnly: sessionUser.isReadOnly
    });
    if (!refreshed) {
      if (sessionUser._jti) await revokeSessionJti(sessionUser._jti, sessionUser._exp);
      if (res) clearSessionCookie(res);
      if (req) req._liveSessionUser = null;
      return null;
    }

    Object.defineProperties(refreshed, {
      _jti: { value: sessionUser._jti || null, enumerable: false, configurable: true },
      _exp: { value: sessionUser._exp || null, enumerable: false },
      _iat: { value: sessionUser._iat || 0, enumerable: false },
    });

    const changed =
      refreshed.name !== sessionUser.name ||
      refreshed.role !== sessionUser.role ||
      !areAssignedClientsEqual(refreshed.assignedClients, sessionUser.assignedClients);

    const privilegesDowngraded =
      (sessionUser.isAdmin && !refreshed.isAdmin) ||
      sessionUser.role !== refreshed.role ||
      (Array.isArray(refreshed.assignedClients) &&
        (sessionUser.assignedClients === "*" ||
          (Array.isArray(sessionUser.assignedClients) &&
            sessionUser.assignedClients.some((c) => !refreshed.assignedClients.includes(c)))));

    if (changed && privilegesDowngraded && sessionUser._jti) {
      await revokeSessionJti(sessionUser._jti, sessionUser._exp);
    }

    if ((changed || !sessionUser._jti) && res && typeof res.setHeader === "function") {
      const cookies = req?.headers?.cookie ? parseCookies(req.headers.cookie) : {};
      if (cookies.pma_session) {
        const nextPayload = mintSessionCookie(res, refreshed);
        if (nextPayload?.jti) {
          Object.defineProperties(refreshed, {
            _jti: { value: nextPayload.jti, enumerable: false, configurable: true },
          });
        }
      }
    }

    if (req) req._liveSessionUser = refreshed;
    if (activeRes && typeof activeRes.setHeader === "function" && !activeRes.headersSent) {
      activeRes.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    }
    installSheetIdBoundary(req, activeRes, refreshed);
    return refreshed;
  } catch (err) {
    console.warn("⚠️ resolveLiveSessionUser fail-closed on directory error:", err.message);
    if (req) req._liveSessionUser = null;
    return null;
  }
}

/**
 * Verifies that if an OAuth callback originates in a browser holding an active Pulse session,
 * that user has not been suspended, matches the state's initiatedBy user, and still holds required privileges.
 */
export async function verifyCallbackSessionInitiator(req, res, statePayload) {
  const rawToken = extractRawSessionToken(req);
  if (!rawToken) {
    return statePayload?.initiatedBy
      ? { ok: false, error: "Active session required to complete integration OAuth callback." }
      : { ok: true };
  }
  const liveUser = await resolveLiveSessionUser(req, res);
  if (!liveUser) {
    return { ok: false, error: "Session is no longer active or has been suspended." };
  }
  const expectedEmail = String(statePayload?.initiatedBy || "").toLowerCase().trim();
  if (expectedEmail && String(liveUser.email || "").toLowerCase().trim() !== expectedEmail) {
    return { ok: false, error: "OAuth callback session does not match initiating user." };
  }
  if (isReadOnlySession(liveUser) || liveUser.isSenior || liveUser.role === "Senior (Restricted)") {
    return { ok: false, error: "Insufficient permissions to complete integration OAuth callback." };
  }
  if (statePayload?.mode === "advisor" && !liveUser.isAdmin) {
    return { ok: false, error: "Admin privileges required to update central advisor integration." };
  }
  const targetClient = statePayload?.clientName || statePayload?.clientKey;
  if (!liveUser.isAdmin && statePayload?.mode !== "advisor" && targetClient && !isUserAuthorizedForClient(liveUser, targetClient)) {
    return { ok: false, error: "No longer authorized for target client." };
  }
  return { ok: true, user: liveUser };
}

/**
 * Invalidate session cookie on logout
 */
export function clearSessionCookie(res) {
  if (res && typeof res.setHeader === "function") {
    appendSetCookie(res, serializeCookie("pma_session", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0
    }));
  }
}

