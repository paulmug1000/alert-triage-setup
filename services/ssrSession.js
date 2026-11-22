import crypto from "crypto";
import { redisClient, ensureRedisConnected } from "./redisClient.js";
import { memoryCache } from "./cacheService.js";
import { maskResponseSheetIdsForUser, unwrapSheetId } from "./sheetTokenService.js";
import { redactPortalPayloadForUser, redactPortalPerformanceForUser } from "../utils/helpers.js";

const DEFAULT_AC_SHEET_ID = process.env.AUTOMATION_COMMANDER_SHEET_ID || "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
const ALL_CLIENTS_CACHE_KEY = `pulse:all_clients:${DEFAULT_AC_SHEET_ID}`;
const INTEGRATIONS_STATUS_CACHE_KEY = "pulse:integrations:status_all";

let _l1Clients = null;
let _l1Integrations = null;
let _l1CachedAt = 0;
const L1_TTL_MS = 60 * 1000; // 60 seconds in-memory cache

export function clearSsrClientsMemoryCache() {
  _l1Clients = null;
  _l1Integrations = null;
  _l1CachedAt = 0;
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

function verifyHs256Jwt(token, secret) {
  if (!token || !secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header = null;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!header || header.alg !== "HS256") return null;

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  const sigBuf = Buffer.from(signatureB64);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
  const decoded = JSON.parse(payloadJson);
  if (typeof decoded.exp !== "number" || Math.floor(Date.now() / 1000) >= decoded.exp) {
    return null;
  }
  return decoded;
}

const SESSION_MAX_AGE_SECS = 7 * 24 * 60 * 60;
const REDIS_USERS_KEY = "pma:users:list";

function getSsrJwtSecret() {
  return (
    process.env.PMA_JWT_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    (process.env.NODE_ENV !== "production" ? globalThis.__PULSE_DEV_JWT_SECRET__ : null)
  );
}

function signHs256Jwt(payload, secret, expiresInSecs = SESSION_MAX_AGE_SECS) {
  const nowSec = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: nowSec, exp: nowSec + expiresInSecs };
  const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  return `${headerB64}.${payloadB64}.${sig}`;
}

function setSsrSessionCookie(res, token, maxAge = SESSION_MAX_AGE_SECS) {
  if (!res || typeof res.setHeader !== "function") return;
  const isProd = process.env.NODE_ENV === "production";
  const cookieStr = `pma_session=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly${isProd ? "; Secure" : ""}; SameSite=Lax`;
  const existing = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : null;
  const existingArr = Array.isArray(existing) ? existing : (existing ? [String(existing)] : []);
  const filtered = existingArr.filter((c) => !String(c).startsWith("pma_session="));
  filtered.push(cookieStr);
  res.setHeader("Set-Cookie", filtered.length === 1 ? filtered[0] : filtered);
}

function buildSsrSessionUser({ email, name, role, assignedClients, authProvider, isReadOnly }) {
  const effectiveRole = role || "ClientUser";
  const effectiveReadOnly = Boolean(isReadOnly || authProvider === "EmailOTP");
  const normRole = String(effectiveRole).trim().toLowerCase();
  const isBlockedOtp = normRole === "admin" || normRole === "clientmanager" || normRole === "client manager";
  if ((authProvider === "EmailOTP" || effectiveReadOnly) && isBlockedOtp) {
    return null;
  }

  const isAdmin = effectiveRole === "Admin" && !effectiveReadOnly;
  const isSenior = effectiveRole === "Senior (Restricted)" || normRole.includes("senior");
  const isClientUser = effectiveRole === "ClientUser";

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

function areSsrAssignedClientsEqual(a, b) {
  if (a === "*" || b === "*") return a === b;
  const arrA = Array.isArray(a) ? [...a].map((x) => String(x || "").trim()).filter(Boolean).sort() : [];
  const arrB = Array.isArray(b) ? [...b].map((x) => String(x || "").trim()).filter(Boolean).sort() : [];
  if (arrA.length !== arrB.length) return false;
  return arrA.every((val, i) => val === arrB[i]);
}

async function loadLiveUserForSsr(email) {
  const normEmail = String(email || "").toLowerCase().trim();
  if (!normEmail) return { found: false, user: null };

  // 1. Fast Redis check (pma:users:list is invalidated whenever users are created/updated/deleted)
  try {
    await ensureRedisConnected(400);
    if (redisClient?.isOpen) {
      const rawUsers = await Promise.race([
        redisClient.get(REDIS_USERS_KEY),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500))
      ]);
      if (rawUsers) {
        const parsed = JSON.parse(rawUsers);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return { found: true, user: parsed.find((u) => u.email === normEmail) || null };
        }
      }
    }
  } catch { }

  // 2. Supabase fallback when Redis cache was busted or cold
  try {
    const { getSupabaseAdmin, isSupabaseControlPlaneActive } = await import("./supabaseClient.js");
    if (await isSupabaseControlPlaneActive()) {
      const sb = getSupabaseAdmin();
      if (sb) {
        const { data: rows, error } = await Promise.race([
          sb.from("users").select("email, full_name, role, assigned_clients, status").eq("email", normEmail).limit(1),
          new Promise((resolve) => setTimeout(() => resolve({ data: null, error: new Error("timeout") }), 2500))
        ]);
        if (!error && Array.isArray(rows)) {
          if (rows.length > 0) {
            const r = rows[0];
            const role = r.role || "ClientUser";
            const assignedArr = Array.isArray(r.assigned_clients) ? r.assigned_clients : [];
            const assignedClients = (role === "Admin" && assignedArr.includes("*"))
              ? "*"
              : assignedArr.filter((c) => c && c !== "*");
            return {
              found: true,
              user: {
                email: String(r.email || "").toLowerCase().trim(),
                name: r.full_name || normEmail.split("@")[0],
                role,
                assignedClients,
                status: r.status === "Suspended" ? "Suspended" : "Active"
              }
            };
          }
          // Confirm table isn't empty before treating as missing user
          const { count } = await sb.from("users").select("email", { count: "exact", head: true });
          if (typeof count === "number" && count > 0) {
            return { found: true, user: null };
          }
        }
      }
    }
  } catch { }

  return { found: false, user: null };
}

/**
 * Lightweight SSR session reader for getServerSideProps.
 * Avoids importing googleapis / nodemailer / sheetsClient during Next.js page compilation.
 */
export function getSsrSessionUser(req) {
  if (req?.url && String(req.url).includes("auth_error=")) return null;
  if (!req?.headers?.cookie) return null;
  const secret = getSsrJwtSecret();
  if (!secret) return null;

  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.pma_session;
    if (!token) return null;

    const decoded = verifyHs256Jwt(token, secret);
    if (!decoded || !decoded.email) return null;
    if (decoded.tokenType && decoded.tokenType !== "session") return null;

    const userObj = buildSsrSessionUser({
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
    return userObj;
  } catch {
    return null;
  }
}

/**
 * SSR session reader that overlays live user permissions (assignedClients, role, status)
 * from Redis / Supabase and refreshes the pma_session cookie if stale.
 */
export async function getSsrLiveSessionUser(req, res = null) {
  const sessionUser = getSsrSessionUser(req);
  if (!sessionUser) return null;

  try {
    await ensureRedisConnected(400);
    if (redisClient?.isOpen) {
      if (sessionUser._jti) {
        const revoked = await redisClient.get(`pma:revoked_jti:${String(sessionUser._jti)}`);
        if (revoked) {
          if (res) setSsrSessionCookie(res, "", 0);
          return null;
        }
      } else if (sessionUser._rawTokenHash) {
        const revTok = await redisClient.get(`pma:revoked_tok_hash:${sessionUser._rawTokenHash}`);
        if (revTok) {
          if (res) setSsrSessionCookie(res, "", 0);
          return null;
        }
      }
      const normEmailForRev = String(sessionUser.email || "").toLowerCase().trim();
      const revokedAtRaw = await redisClient.get(`pma:user_revoked_at:${normEmailForRev}`).catch(() => null);
      if (revokedAtRaw && Number(revokedAtRaw) >= Number(sessionUser._iat || 0) && !sessionUser._jti) {
        if (res) setSsrSessionCookie(res, "", 0);
        return null;
      }
    }
  } catch { }

  try {
    const lookup = await loadLiveUserForSsr(sessionUser.email);
    if (!lookup.found) return null;

    const liveUser = lookup.user;
    if (!liveUser || liveUser.status === "Suspended") {
      if (sessionUser._jti && redisClient?.isOpen) {
        const nowSec = Math.floor(Date.now() / 1000);
        const ttl = sessionUser._exp ? Math.max(60, Math.min(SESSION_MAX_AGE_SECS, Number(sessionUser._exp) - nowSec)) : SESSION_MAX_AGE_SECS;
        await redisClient.set(`pma:revoked_jti:${String(sessionUser._jti)}`, "1", { EX: ttl }).catch(() => { });
      }
      if (res) setSsrSessionCookie(res, "", 0);
      return null;
    }

    const refreshed = buildSsrSessionUser({
      email: liveUser.email,
      name: liveUser.name || sessionUser.name,
      role: liveUser.role,
      assignedClients: liveUser.assignedClients,
      authProvider: sessionUser.authProvider,
      isReadOnly: sessionUser.isReadOnly
    });
    if (!refreshed) {
      if (sessionUser._jti && redisClient?.isOpen) {
        const nowSec = Math.floor(Date.now() / 1000);
        const ttl = sessionUser._exp ? Math.max(60, Math.min(SESSION_MAX_AGE_SECS, Number(sessionUser._exp) - nowSec)) : SESSION_MAX_AGE_SECS;
        await redisClient.set(`pma:revoked_jti:${String(sessionUser._jti)}`, "1", { EX: ttl }).catch(() => { });
      }
      if (res) setSsrSessionCookie(res, "", 0);
      return null;
    }

    const changed =
      refreshed.name !== sessionUser.name ||
      refreshed.role !== sessionUser.role ||
      !areSsrAssignedClientsEqual(refreshed.assignedClients, sessionUser.assignedClients);

    const privilegesDowngraded =
      (sessionUser.isAdmin && !refreshed.isAdmin) ||
      sessionUser.role !== refreshed.role ||
      (Array.isArray(refreshed.assignedClients) &&
        (sessionUser.assignedClients === "*" ||
          (Array.isArray(sessionUser.assignedClients) &&
            sessionUser.assignedClients.some((c) => !refreshed.assignedClients.includes(c)))));

    if (changed && privilegesDowngraded && sessionUser._jti) {
      try {
        await ensureRedisConnected(400);
        if (redisClient?.isOpen) {
          const nowSec = Math.floor(Date.now() / 1000);
          const ttl = sessionUser._exp ? Math.max(60, Math.min(SESSION_MAX_AGE_SECS, Number(sessionUser._exp) - nowSec)) : SESSION_MAX_AGE_SECS;
          await redisClient.set(`pma:revoked_jti:${String(sessionUser._jti)}`, "1", { EX: ttl }).catch(() => { });
        }
      } catch { }
    }

    if ((changed || !sessionUser._jti) && res && typeof res.setHeader === "function") {
      const secret = getSsrJwtSecret();
      if (secret) {
        const refreshedToken = signHs256Jwt({
          jti: crypto.randomUUID(),
          tokenType: "session",
          email: refreshed.email,
          name: refreshed.name,
          role: refreshed.role,
          assignedClients: refreshed.assignedClients,
          authProvider: refreshed.authProvider,
          isReadOnly: refreshed.isReadOnly
        }, secret);
        setSsrSessionCookie(res, refreshedToken, SESSION_MAX_AGE_SECS);
      }
    }

    if (req) req._liveSessionUser = refreshed;
    return refreshed;
  } catch {
    return null;
  }
}

export function canSsrUserAccessPma(user) {
  if (!user) return false;
  if (user.isReadOnly || user.authProvider === "EmailOTP") return false;
  if (user.isAdmin || user.role === "Admin") return true;
  if (user.role === "ClientManager") return true;
  return false;
}

function isClientAllowedForUser(user, clientName) {
  if (!user || !clientName) return false;
  if (user.isAdmin || user.role === "Admin") return true;
  if (!Array.isArray(user.assignedClients)) return false;
  const target = String(clientName).trim().toLowerCase();
  return user.assignedClients.some(c => String(c || "").trim().toLowerCase() === target);
}

async function loadClientsArrayFromSupabaseFallback_() {
  try {
    const { getSupabaseAdmin, isSupabaseControlPlaneActive } = await import("./supabaseClient.js");
    if (!(await isSupabaseControlPlaneActive())) return null;
    const sb = getSupabaseAdmin();
    if (!sb) return null;
    const [{ data: sbClients }, { data: kiRows }] = await Promise.all([
      sb.from("clients").select("*").order("client_name", { ascending: true }),
      sb.from("tenant_key_info").select("client_name, normalized_key, revenue_or_income_mode, direct_costs_mode, accounting_tool, crm_tool, crm_drives, invoice_method"),
    ]);
    if (!Array.isArray(sbClients) || sbClients.length === 0) return null;
    const kiByNorm = new Map();
    const kiByName = new Map();
    for (const k of kiRows || []) {
      if (k.normalized_key) kiByNorm.set(String(k.normalized_key).trim().toLowerCase(), k);
      if (k.client_name) kiByName.set(String(k.client_name).trim().toLowerCase(), k);
    }
    const clientsArray = [];
    for (const c of sbClients) {
      const eff = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
      if (["inactive", "archived", "suspended"].includes(eff)) continue;
      const clientName = String(c.client_name || "").trim();
      const normKey = String(c.normalized_key || clientName.toLowerCase().replace(/[^a-z0-9_-]/g, "_")).trim();
      const ki = kiByNorm.get(normKey.toLowerCase()) || kiByName.get(clientName.toLowerCase()) || null;
      const clientSheetId =
        String(c.client_sheet_id || "").trim() ||
        (c.client_mode === "supabase" && normKey ? `sb-client-${normKey}` : "");
      const masterSheetId =
        String(c.master_sheet_id || "").trim() ||
        (c.master_mode === "supabase" && normKey ? `sb-master-${normKey}` : "");
      if (!clientName || (!clientSheetId && c.client_mode !== "supabase")) continue;
      const reconSheetUrl = String(c.recon_sheet_url || "").trim();
      const reconSheetId =
        String(c.recon_sheet_id || "").trim() ||
        ((c.metadata?.reconMode === "supabase" || c.master_mode === "supabase") && normKey ? `sb-recon-${normKey}` : "");
      const accountingTool = c.metadata?.accountingTool || ki?.accounting_tool || "None";
      const crmTool = c.metadata?.crmTool || ki?.crm_tool || "None";
      const crmDrives = c.metadata?.crmDrives || ki?.crm_drives || "NA";
      const revFocus = String(ki?.revenue_or_income_mode || c.metadata?.revenueFocus || "Revenue").trim();
      const rawDcMode = String(ki?.direct_costs_mode || c.metadata?.directCostsMode || "Contractors").trim();
      const directCostsMode = revFocus.toLowerCase() === "income" ? "Pass-through" : (rawDcMode === "Pass-through" ? "Pass-through" : "Contractors");
      clientsArray.push({
        clientName,
        clientSheetId,
        masterSheetId,
        scriptId: String(c.client_script_id || "").trim(),
        webAppUrl: String(c.master_deployment_url || c.web_app_url || c.metadata?.webAppUrl || "").trim(),
        hasWebAppUrl: Boolean(c.master_deployment_url || c.web_app_url || c.metadata?.webAppUrl) || c.master_mode === "supabase",
        splitEnabled: Boolean(c.metadata?.splitEnabled || String(ki?.invoice_method || "").toLowerCase().includes("split")),
        reconSheetUrl,
        reconSheetId,
        accountingTool,
        crmTool,
        crmDrives,
        directCostsMode,
        hasAccountingIntegration: ["xero", "quickbooks", "qb"].some((t) => String(accountingTool).toLowerCase().includes(t)),
        clientMode: c.client_mode || "sheet",
        masterMode: c.master_mode || "sheet",
      });
    }
    return { clientsArray };
  } catch {
    return null;
  }
}

/**
 * Fast SSR preloader for PMA client list + integration statuses from L1 memory or Redis (<350ms cap).
 */
export async function getSsrInitialPmaData(sessionUser) {
  if (!sessionUser) return { initialClients: [], initialIntegrations: null };

  const now = Date.now();
  let rawClients = _l1Clients;
  let rawIntegrations = _l1Integrations;

  if (!rawClients || (now - _l1CachedAt > L1_TTL_MS)) {
    await ensureRedisConnected(500);
    if (redisClient?.isOpen) {
      try {
        const res = await Promise.race([
          redisClient.mGet([ALL_CLIENTS_CACHE_KEY, INTEGRATIONS_STATUS_CACHE_KEY]),
          new Promise((resolve) => setTimeout(() => resolve(null), 800))
        ]);
        if (Array.isArray(res)) {
          if (res[0]) {
            try { rawClients = JSON.parse(res[0]); } catch { }
          }
          if (res[1]) {
            try { rawIntegrations = JSON.parse(res[1]); _l1Integrations = rawIntegrations; } catch { }
          }
          if (rawClients && Array.isArray(rawClients.clientsArray) && rawClients.clientsArray.length > 0) {
            try {
              const normalizeClientKey = (str) => String(str || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
              const setupKeys = rawClients.clientsArray.map(c => `pulse:setup:${normalizeClientKey(c.clientName)}`);
              const setupRawList = await Promise.race([
                redisClient.mGet(setupKeys),
                new Promise((resolve) => setTimeout(() => resolve(null), 400))
              ]);
              if (Array.isArray(setupRawList)) {
                rawClients.clientsArray.forEach((c, idx) => {
                  const sRaw = setupRawList[idx];
                  if (sRaw) {
                    try {
                      const cfg = JSON.parse(sRaw);
                      const revFocus = String(cfg.revenueFocus || "Revenue").trim();
                      const rawDcMode = String(cfg.directCostsMode || "Contractors").trim();
                      c.directCostsMode = revFocus.toLowerCase() === "income" ? "Pass-through" : (rawDcMode === "Pass-through" ? "Pass-through" : "Contractors");
                      if (cfg.accountingTool) c.accountingTool = cfg.accountingTool;
                      if (cfg.crmTool) c.crmTool = cfg.crmTool;
                      if (cfg.crmDrives) c.crmDrives = cfg.crmDrives;
                      c.setupMode = Boolean(cfg.setupMode);
                      c.pulseLive = Boolean(cfg.pulseLive) || !c.setupMode;
                    } catch { }
                  }
                });
              }
            } catch { }
            _l1Clients = rawClients;
          }
          if (rawClients || rawIntegrations) _l1CachedAt = now;
        }
      } catch { }
    }
    if (!rawClients || !Array.isArray(rawClients.clientsArray) || rawClients.clientsArray.length === 0) {
      const sbFallback = await Promise.race([
        loadClientsArrayFromSupabaseFallback_(),
        new Promise((resolve) => setTimeout(() => resolve(null), 900)),
      ]);
      if (sbFallback && Array.isArray(sbFallback.clientsArray) && sbFallback.clientsArray.length > 0) {
        rawClients = sbFallback;
        _l1Clients = sbFallback;
        _l1CachedAt = now;
      }
    }
  }

  const intMap = {};
  let scopedIntClients = [];
  if (rawIntegrations && Array.isArray(rawIntegrations.allClients)) {
    scopedIntClients = rawIntegrations.allClients.filter(c => isClientAllowedForUser(sessionUser, c.clientName));
    for (const ic of scopedIntClients) {
      if (ic.clientName) intMap[ic.clientName.toLowerCase()] = ic;
    }
  }

  let scopedClients = [];
  if (rawClients && Array.isArray(rawClients.clientsArray)) {
    scopedClients = rawClients.clientsArray
      .filter(c => isClientAllowedForUser(sessionUser, c.clientName))
      .map(c => {
        const ic = intMap[String(c.clientName || "").toLowerCase()];
        const accTool = c.accountingTool || ic?.accountingTool || "None";
        const crmTool = c.crmTool || ic?.crmTool || "None";
        const crmDrives = c.crmDrives || ic?.crmDrives || "NA";
        const hasAccountingIntegration = c.hasAccountingIntegration ?? ["xero", "quickbooks", "qb"].some(t => String(accTool).toLowerCase().includes(t));
        const nextSetupMode = Boolean(c.setupMode ?? (ic?.setupMode || ic?.isSetupMode));
        const nextPulseLive = !nextSetupMode || Boolean(c.pulseLive ?? ic?.pulseLive);
        return {
          ...c,
          accountingTool: accTool,
          crmTool,
          crmDrives,
          hasAccountingIntegration,
          setupMode: nextSetupMode,
          pulseLive: nextPulseLive
        };
      })
      .sort((a, b) => String(a.clientName || "").localeCompare(String(b.clientName || "")));
  }

  const scopedIntegrationsClients = sessionUser.isAdmin
    ? scopedIntClients
    : scopedIntClients.map((c) => {
      const copy = { ...c };
      delete copy.autoUpdatesRow;
      delete copy.rowNumber;
      if (copy.integrations?.xero) {
        copy.integrations = {
          ...copy.integrations,
          xero: {
            ...copy.integrations.xero,
            availableTenants: [],
            metadata: copy.integrations.xero.metadata
              ? { ...copy.integrations.xero.metadata, availableTenants: [] }
              : copy.integrations.xero.metadata,
          },
        };
      }
      if (copy.accountingStatus) {
        copy.accountingStatus = {
          ...copy.accountingStatus,
          availableTenants: [],
          metadata: copy.accountingStatus.metadata
            ? { ...copy.accountingStatus.metadata, availableTenants: [] }
            : copy.accountingStatus.metadata,
        };
      }
      return copy;
    });

  const initialIntegrations = rawIntegrations
    ? {
      allClients: scopedIntegrationsClients,
      sharedXero: rawIntegrations.sharedXero
        ? {
          ...rawIntegrations.sharedXero,
          availableTenants: sessionUser.isAdmin ? (rawIntegrations.sharedXero.availableTenants || []) : []
        }
        : null
    }
    : null;

  return maskResponseSheetIdsForUser(
    {
      initialClients: scopedClients,
      initialIntegrations
    },
    sessionUser
  );
}

/**
 * Fast SSR preloader for the Pulse Portal (/pulse) home page.
 * Resolves authorized clients, active selectedClient (from ?client= or pulse_portal_client cookie),
 * and warm L1/Redis payload + performanceData in a single sub-50ms pass so the Pulse Home Page
 * renders on the very first paint without a client-side waterfall.
 */
export async function getSsrInitialPortalData(req, sessionUser, query = {}) {
  if (!sessionUser) {
    return {
      initialClients: null,
      initialSelectedClient: null,
      initialPayload: null,
      initialPerformanceData: null,
      selectedSetupConfig: null,
    };
  }

  try {
    const cookies = parseCookies(req?.headers?.cookie || "");
    const savedClientCookie = cookies.pulse_portal_client ? String(cookies.pulse_portal_client).trim() : "";
    const queryClient = typeof query?.client === "string" ? query.client.trim() : "";
    const isChooseRequested = query?.choose === "true";

    const portalCacheKey = `pulse:portal:allClients:${DEFAULT_AC_SHEET_ID}`;
    let rawPortalClients = memoryCache.get(portalCacheKey);

    if (!rawPortalClients && _l1Clients && Array.isArray(_l1Clients.clientsArray)) {
      rawPortalClients = _l1Clients.clientsArray;
    }

    if (!rawPortalClients) {
      await ensureRedisConnected(500);
    }

    if (!rawPortalClients && redisClient?.isOpen) {
      const rawRes = await Promise.race([
        redisClient.mGet([portalCacheKey, ALL_CLIENTS_CACHE_KEY]),
        new Promise((resolve) => setTimeout(() => resolve(null), 600)),
      ]);
      if (Array.isArray(rawRes)) {
        if (rawRes[0]) {
          try {
            rawPortalClients = JSON.parse(rawRes[0]);
            memoryCache.set(portalCacheKey, rawPortalClients, 300);
          } catch { }
        } else if (rawRes[1]) {
          try {
            const parsedAll = JSON.parse(rawRes[1]);
            if (Array.isArray(parsedAll?.clientsArray)) {
              rawPortalClients = parsedAll.clientsArray;
              memoryCache.set(portalCacheKey, rawPortalClients, 300);
            }
          } catch { }
        }
      }
    }

    if (!Array.isArray(rawPortalClients) || rawPortalClients.length === 0) {
      const sbFallback = await Promise.race([
        loadClientsArrayFromSupabaseFallback_(),
        new Promise((resolve) => setTimeout(() => resolve(null), 900)),
      ]);
      if (sbFallback && Array.isArray(sbFallback.clientsArray) && sbFallback.clientsArray.length > 0) {
        rawPortalClients = sbFallback.clientsArray;
        memoryCache.set(portalCacheKey, rawPortalClients, 300);
        _l1Clients = sbFallback;
        _l1CachedAt = Date.now();
      }
    }

    if (!Array.isArray(rawPortalClients) || rawPortalClients.length === 0) {
      return {
        initialClients: null,
        initialSelectedClient: null,
        initialPayload: null,
        initialPerformanceData: null,
        selectedSetupConfig: null,
      };
    }

    const authorizedClients = rawPortalClients
      .filter((c) => isClientAllowedForUser(sessionUser, c.clientName))
      .sort((a, b) => String(a.clientName || "").localeCompare(String(b.clientName || "")));

    const isPulseOnly = Boolean(
      (sessionUser.role === "ClientUser" ||
        sessionUser.role === "Senior (Restricted)" ||
        sessionUser.isSenior ||
        sessionUser.isReadOnly) &&
      !sessionUser.isAdmin
    );

    const cleanClients = authorizedClients.map((c) => {
      const setupMode = Boolean(c.setupMode);
      const pulseLive = !setupMode || Boolean(c.pulseLive);
      return isPulseOnly
        ? { clientName: c.clientName, clientSheetId: c.clientSheetId, setupMode, pulseLive }
        : {
          clientName: c.clientName,
          clientSheetId: c.clientSheetId,
          masterSheetId: c.masterSheetId,
          setupMode,
          pulseLive,
        };
    });

    let selectedRaw = null;
    if (cleanClients.length === 1) {
      selectedRaw = cleanClients[0];
    } else if (cleanClients.length > 1 && !isChooseRequested) {
      if (queryClient) {
        selectedRaw = cleanClients.find((c) => c.clientName.toLowerCase() === queryClient.toLowerCase()) || null;
      }
      if (!selectedRaw && savedClientCookie) {
        selectedRaw = cleanClients.find((c) => c.clientName.toLowerCase() === savedClientCookie.toLowerCase()) || null;
      }
      if (!selectedRaw && !isPulseOnly) {
        selectedRaw =
          cleanClients.find((c) => c.clientName.toUpperCase() === "APPTEST") || cleanClients[0] || null;
      }
    }

    let initialPayload = null;
    let initialPerformanceData = null;
    let selectedSetupConfig = null;

    if (selectedRaw?.clientSheetId) {
      const rawSheetId = unwrapSheetId(selectedRaw.clientSheetId);
      const payloadKey = `pulse:portal:payload:${rawSheetId}`;
      const perfKey = `pulse:portal:performance:${rawSheetId}`;
      const setupKey = `pulse:setup:${String(selectedRaw.clientName || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;

      initialPayload = memoryCache.get(payloadKey) || null;
      initialPerformanceData = memoryCache.get(perfKey) || null;

      if (!initialPayload || !initialPerformanceData) {
        await ensureRedisConnected(400);
      }
      if ((!initialPayload || !initialPerformanceData) && redisClient?.isOpen) {
        try {
          const cachedTriple = await Promise.race([
            redisClient.mGet([payloadKey, perfKey, setupKey]),
            new Promise((resolve) => setTimeout(() => resolve(null), 600)),
          ]);
          if (Array.isArray(cachedTriple)) {
            if (!initialPayload && cachedTriple[0]) {
              initialPayload = JSON.parse(cachedTriple[0]);
              memoryCache.set(payloadKey, initialPayload, 60);
            }
            if (!initialPerformanceData && cachedTriple[1]) {
              initialPerformanceData = JSON.parse(cachedTriple[1]);
              memoryCache.set(perfKey, initialPerformanceData, 60);
            }
            if (cachedTriple[2]) {
              selectedSetupConfig = JSON.parse(cachedTriple[2]);
              if (selectedSetupConfig?.setupMode === true) {
                selectedRaw.setupMode = true;
                selectedRaw.pulseLive = Boolean(selectedSetupConfig?.pulseLive);
              } else if (selectedSetupConfig) {
                selectedRaw.pulseLive = true;
              }
            }
          }
        } catch { }
      }
    }

    const masked = maskResponseSheetIdsForUser(
      {
        initialClients: cleanClients,
        initialSelectedClient: selectedRaw,
      },
      sessionUser
    );

    const isSelectedHoldingGated = Boolean(selectedRaw?.setupMode && !selectedRaw?.pulseLive);
    const safePayload =
      isSelectedHoldingGated || query?.preview === "setup" || !initialPayload
        ? null
        : redactPortalPayloadForUser(initialPayload, sessionUser);
    const safePerfData =
      isSelectedHoldingGated || query?.preview === "setup" || !initialPerformanceData
        ? null
        : redactPortalPerformanceForUser(initialPerformanceData, sessionUser);

    return {
      initialClients: masked.initialClients || null,
      initialSelectedClient: masked.initialSelectedClient || null,
      initialPayload: safePayload,
      initialPerformanceData: safePerfData,
      selectedSetupConfig: maskResponseSheetIdsForUser(selectedSetupConfig, sessionUser),
    };
  } catch {
    return {
      initialClients: null,
      initialSelectedClient: null,
      initialPayload: null,
      initialPerformanceData: null,
      selectedSetupConfig: null,
    };
  }
}
