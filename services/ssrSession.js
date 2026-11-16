import crypto from "crypto";
import { redisClient } from "./redisClient.js";
import { memoryCache } from "./cacheService.js";
import { maskResponseSheetIdsForUser, unwrapSheetId } from "./sheetTokenService.js";

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
            try { rawClients = JSON.parse(res[0]); } catch {}
          }
          if (res[1]) {
            try { rawIntegrations = JSON.parse(res[1]); _l1Integrations = rawIntegrations; } catch {}
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
                    } catch {}
                  }
                });
              }
            } catch {}
            _l1Clients = rawClients;
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

    if (!rawPortalClients && redisClient?.isOpen) {
      const rawRes = await Promise.race([
        redisClient.mGet([portalCacheKey, ALL_CLIENTS_CACHE_KEY]),
        new Promise((resolve) => setTimeout(() => resolve(null), 150)),
      ]);
      if (Array.isArray(rawRes)) {
        if (rawRes[0]) {
          try {
            rawPortalClients = JSON.parse(rawRes[0]);
            memoryCache.set(portalCacheKey, rawPortalClients, 300);
          } catch {}
        } else if (rawRes[1]) {
          try {
            const parsedAll = JSON.parse(rawRes[1]);
            if (Array.isArray(parsedAll?.clientsArray)) {
              rawPortalClients = parsedAll.clientsArray;
              memoryCache.set(portalCacheKey, rawPortalClients, 300);
            }
          } catch {}
        }
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
      return isPulseOnly
        ? { clientName: c.clientName, clientSheetId: c.clientSheetId, setupMode }
        : {
            clientName: c.clientName,
            clientSheetId: c.clientSheetId,
            masterSheetId: c.masterSheetId,
            setupMode,
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

      if ((!initialPayload || !initialPerformanceData) && redisClient?.isOpen) {
        try {
          const cachedTriple = await Promise.race([
            redisClient.mGet([payloadKey, perfKey, setupKey]),
            new Promise((resolve) => setTimeout(() => resolve(null), 150)),
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
              }
            }
          }
        } catch {}
      }
    }

    const masked = maskResponseSheetIdsForUser(
      {
        initialClients: cleanClients,
        initialSelectedClient: selectedRaw,
      },
      sessionUser
    );

    return {
      initialClients: masked.initialClients || null,
      initialSelectedClient: masked.initialSelectedClient || null,
      initialPayload: selectedRaw?.setupMode || query?.preview === "setup" ? null : initialPayload || null,
      initialPerformanceData:
        selectedRaw?.setupMode || query?.preview === "setup" ? null : initialPerformanceData || null,
      selectedSetupConfig,
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
