import crypto from "crypto";
import { redisClient } from "./redisClient.js";
import { maskResponseSheetIdsForUser } from "./sheetTokenService.js";

const DEFAULT_AC_SHEET_ID = process.env.AUTOMATION_COMMANDER_SHEET_ID || "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
const ALL_CLIENTS_CACHE_KEY = `pulse:all_clients:${DEFAULT_AC_SHEET_ID}`;
const INTEGRATIONS_STATUS_CACHE_KEY = "pulse:integrations:status_all";

let _l1Clients = null;
let _l1Integrations = null;
let _l1CachedAt = 0;
const L1_TTL_MS = 60 * 1000; // 60 seconds in-memory cache

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
  if (decoded.exp && Math.floor(Date.now() / 1000) >= decoded.exp) {
    return null;
  }
  return decoded;
}

/**
 * Lightweight SSR session reader for getServerSideProps.
 * Avoids importing googleapis / nodemailer / sheetsClient during Next.js page compilation.
 */
export function getSsrSessionUser(req) {
  if (req?.url && String(req.url).includes("auth_error=")) return null;
  if (!req?.headers?.cookie) return null;
  const secret =
    process.env.PMA_JWT_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    (process.env.NODE_ENV !== "production" ? globalThis.__PULSE_DEV_JWT_SECRET__ : null);
  if (!secret) return null;

  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.pma_session;
    if (!token) return null;

    const decoded = verifyHs256Jwt(token, secret);
    if (!decoded || !decoded.email) return null;
    if (decoded.tokenType && decoded.tokenType !== "session") return null;

    const role = decoded.role || "ClientUser";
    const isReadOnly = Boolean(decoded.isReadOnly || decoded.authProvider === "EmailOTP");

    const normRole = String(role).trim().toLowerCase();
    const isBlockedOtp = normRole === "admin" || normRole === "clientmanager" || normRole === "client manager";
    if ((decoded.authProvider === "EmailOTP" || isReadOnly) && isBlockedOtp) {
      return null;
    }

    const isAdmin = role === "Admin" && !isReadOnly;
    const isSenior = role === "Senior (Restricted)" || normRole.includes("senior");
    const isClientUser = role === "ClientUser";

    const assignedClients = (isAdmin && decoded.assignedClients === "*")
      ? "*"
      : (Array.isArray(decoded.assignedClients) ? decoded.assignedClients : []);

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

/**
 * Fast SSR preloader for PMA client list + integration statuses from L1 memory or Redis (<350ms cap).
 */
export async function getSsrInitialPmaData(sessionUser) {
  if (!sessionUser) return { initialClients: [], initialIntegrations: null };

  const now = Date.now();
  let rawClients = _l1Clients;
  let rawIntegrations = _l1Integrations;

  if (!rawClients || (now - _l1CachedAt > L1_TTL_MS)) {
    if (redisClient?.isOpen) {
      try {
        const res = await Promise.race([
          redisClient.mGet([ALL_CLIENTS_CACHE_KEY, INTEGRATIONS_STATUS_CACHE_KEY]),
          new Promise((resolve) => setTimeout(() => resolve(null), 800))
        ]);
        if (Array.isArray(res)) {
          if (res[0]) {
            try { rawClients = JSON.parse(res[0]); _l1Clients = rawClients; } catch {}
          }
          if (res[1]) {
            try { rawIntegrations = JSON.parse(res[1]); _l1Integrations = rawIntegrations; } catch {}
          }
          if (rawClients || rawIntegrations) _l1CachedAt = now;
        }
      } catch {}
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
        return {
          ...c,
          accountingTool: accTool,
          crmTool,
          crmDrives,
          hasAccountingIntegration,
          setupMode: Boolean(ic?.setupMode || ic?.isSetupMode)
        };
      })
      .sort((a, b) => String(a.clientName || "").localeCompare(String(b.clientName || "")));
  }

  const initialIntegrations = rawIntegrations
    ? {
        allClients: scopedIntClients,
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
