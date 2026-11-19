/**
 * ============================================================================
 * PULSE IN-MEMORY L1 CACHE SERVICE
 * ============================================================================
 * Ultra-fast in-memory cache for API responses and sheet metadata.
 * Reduces latency on repeated queries and client switching from ~2-5s to <1ms.
 * Designed to work seamlessly in standalone dev and as an L1 layer in production.
 * ============================================================================
 */

class MemoryCache {
  constructor(defaultTtlSeconds = 60) {
    this.defaultTtlSeconds = defaultTtlSeconds;
    this.cache = new Map();
  }

  get(key) {
    if (!key) return null;
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlSeconds = this.defaultTtlSeconds) {
    if (!key) return;
    this.cache.set(key, {
      value,
      expiry: Date.now() + Math.max(1, ttlSeconds) * 1000,
    });
  }

  del(keyOrPattern) {
    if (!keyOrPattern) return;
    if (keyOrPattern.includes("*")) {
      const regexStr =
        "^" +
        keyOrPattern
          .replace(/[-[\]{}()+?.,\\^$|#\s]/g, "\\$&")
          .replace(/\*/g, ".*") +
        "$";
      const regex = new RegExp(regexStr);
      for (const k of this.cache.keys()) {
        if (regex.test(k)) {
          this.cache.delete(k);
        }
      }
    } else {
      this.cache.delete(keyOrPattern);
    }
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

// Global singleton to persist across Next.js API route re-invocations in local dev
export const memoryCache = global._pulseMemoryCache || new MemoryCache(60);

if (!global._pulseMemoryCache) {
  global._pulseMemoryCache = memoryCache;
}

import { waitUntil } from "@vercel/functions";
import { redisClient, scanRedisKeys } from "./redisClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";

const CACHE_IDX_PREFIX = "pulse:cache_idx:";

function extractSheetIdFromCacheKey_(key) {
  const s = String(key || "");
  if (s.startsWith("pulse:view_data:")) {
    const rest = s.slice("pulse:view_data:".length);
    const sep = rest.indexOf(":");
    return sep >= 0 ? rest.slice(0, sep) : rest;
  }
  if (s.startsWith("pulse:portal:keydata:")) {
    const rest = s.slice("pulse:portal:keydata:".length);
    const sep = rest.indexOf(":");
    return sep >= 0 ? rest.slice(0, sep) : rest;
  }
  if (s.startsWith("pulse:portal:")) {
    const parts = s.split(":");
    return parts[3] || null;
  }
  if (s.startsWith("pulse:pma:")) {
    const parts = s.split(":");
    return parts[3] || null;
  }
  if (s.startsWith("pma_expenses_")) return s.slice("pma_expenses_".length);
  if (s.startsWith("pma_nbtofind_")) return s.slice("pma_nbtofind_".length);
  if (s.startsWith("pma_vat_")) return s.slice("pma_vat_".length);
  if (s.startsWith("pma_cash_")) return s.slice("pma_cash_".length);
  if (s.startsWith("portal_cash_")) return s.slice("portal_cash_".length);
  if (s.startsWith("salaries_data:")) return s.slice("salaries_data:".length);
  return null;
}

function trackRedisKeyForClient_(cacheKey) {
  try {
    if (!redisClient?.isOpen) return;
    const rawId = extractSheetIdFromCacheKey_(cacheKey);
    const id = rawId ? unwrapSheetId(rawId) || rawId : null;
    if (!id) return;
    const idxKey = `${CACHE_IDX_PREFIX}${id}`;
    redisClient.sAdd(idxKey, cacheKey).catch(() => { });
    redisClient.expire(idxKey, 90000).catch(() => { });
  } catch { }
}

/**
 * Registers a dynamic Redis cache key in the client's per-client index set (`pulse:cache_idx:<sheetId>`)
 * so targeted invalidation clears it without scanning Redis keys.
 */
export async function trackRedisKeyForClient(cacheKey) {
  trackRedisKeyForClient_(cacheKey);
}

/**
 * Deletes known all-clients & portal all-clients Redis keys without running SCAN.
 */
export async function invalidateAllClientsRedisKeys(extraAcIds = []) {
  try {
    if (!redisClient?.isOpen) return;
    const defaultAc = process.env.AUTOMATION_COMMANDER_SHEET_ID || "1k9a5r9M9X-bP5G2pL6kY7X3g-r2Q1dC4fW8tV9oP0xE";
    const acIds = new Set([defaultAc, process.env.AUTOMATION_COMMANDER_SHEET_ID, ...extraAcIds].filter(Boolean));
    const keys = [];
    for (const id of acIds) {
      keys.push(`pulse:all_clients:${id}`, `pulse:portal:allClients:${id}`);
    }
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (err) {
    console.warn("[invalidateAllClientsRedisKeys] Redis delete error:", err?.message);
  }
}

/**
 * Get item from 2-tier cache: checks L1 in-memory first (<1ms), then L2 Redis (~3-5ms).
 */
export async function get2TierCache(key) {
  if (!key) return null;
  // 1. Try L1 Memory Cache
  const mem = memoryCache.get(key);
  if (mem !== null && mem !== undefined) {
    return mem;
  }
  // 2. Try L2 Redis Cache
  try {
    if (redisClient?.isOpen) {
      const redisVal = await redisClient.get(key);
      if (redisVal) {
        const parsed = JSON.parse(redisVal);
        memoryCache.set(key, parsed, 60);
        return parsed;
      }
    }
  } catch (err) {
    console.warn(`[get2TierCache] Redis error for key ${key}:`, err?.message);
  }
  return null;
}

/**
 * Set item in both L1 memory cache and L2 Redis cache (non-blocking Redis write).
 */
export async function set2TierCache(key, value, ttlSeconds = 60) {
  if (!key || value === undefined) return;
  const ttl = Math.max(1, ttlSeconds);
  memoryCache.set(key, value, ttl);
  try {
    if (redisClient?.isOpen) {
      redisClient
        .set(key, JSON.stringify(value), { EX: ttl })
        .then(() => trackRedisKeyForClient_(key))
        .catch((err) => console.warn(`[set2TierCache] Redis error for key ${key}:`, err?.message));
    }
  } catch (err) {
    console.warn(`[set2TierCache] Redis error for key ${key}:`, err?.message);
  }
}

/**
 * Delete key or wildcard pattern from both L1 memory cache and L2 Redis cache.
 */
export async function del2TierCache(keyOrPattern) {
  if (!keyOrPattern) return;
  memoryCache.del(keyOrPattern);
  try {
    if (redisClient?.isOpen) {
      if (keyOrPattern.includes("*")) {
        const keys = await scanRedisKeys(keyOrPattern);
        if (keys && keys.length > 0) {
          await redisClient.del(keys);
        }
      } else {
        await redisClient.del(keyOrPattern);
      }
    }
  } catch (err) {
    console.warn(`[del2TierCache] Redis delete error for ${keyOrPattern}:`, err?.message);
  }
}

const _inFlightSwrKeys = new Set();

/**
 * Two-stage cache resolver for Portal & Dashboard endpoints:
 * - L1 Memory Cache: 60s fresh window (<1ms)
 * - L2 Redis Cache: 15m retention (<15ms) with background Stale-While-Revalidate after 60s
 * - Auto-Refresh Coalescing: deduplicates multi-user/multi-tab 60s background polls within a 45s window
 */
export async function resolvePortalCache({
  cacheKey,
  bypassCache = false,
  isAutoRefresh = false,
  isReadOnly = false,
  l1TtlSecs = 60,
  redisTtlSecs = 1800,
  isValidPayload = null,
  fetchFreshFn,
}) {
  const checkValid = (val) => {
    if (!val || typeof val !== "object") return false;
    return typeof isValidPayload === "function" ? isValidPayload(val) : true;
  };

  const saveToCaches = (data) => {
    if (!data || data._skipCache) return;
    if (typeof data === "object" && !data._cachedAt) {
      data._cachedAt = new Date().toISOString();
    }
    memoryCache.set(cacheKey, data, l1TtlSecs);
    try {
      if (redisClient?.isOpen) {
        redisClient
          .set(cacheKey, JSON.stringify(data), { EX: redisTtlSecs })
          .then(() => trackRedisKeyForClient_(cacheKey))
          .catch((err) => console.warn(`[resolvePortalCache] Redis write warning for ${cacheKey}:`, err?.message));
      }
    } catch (_) { }
  };

  // 1. Check L1 Memory Cache (when not bypassing)
  if (!bypassCache) {
    const memCached = memoryCache.get(cacheKey);
    if (checkValid(memCached)) {
      return {
        data: memCached,
        fromCache: true,
        fromMemory: true,
        cachedAt: memCached._cachedAt || null,
      };
    }
  }

  // 2. Check L2 Redis Cache
  try {
    if (redisClient?.isOpen) {
      const cachedRaw = await redisClient.get(cacheKey);
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw);
        if (checkValid(parsed)) {
          const cachedAtMs = parsed._cachedAt ? new Date(parsed._cachedAt).getTime() : 0;
          const ageMs = cachedAtMs ? Date.now() - cachedAtMs : Infinity;

          if (!bypassCache) {
            if (ageMs <= l1TtlSecs * 1000) {
              const remSecs = Math.max(5, Math.ceil((l1TtlSecs * 1000 - ageMs) / 1000));
              memoryCache.set(cacheKey, parsed, remSecs);
            } else if (!_inFlightSwrKeys.has(cacheKey)) {
              // Stale-while-revalidate: serve immediately (<15ms) and refresh in background
              _inFlightSwrKeys.add(cacheKey);
              const bgPromise = Promise.resolve()
                .then(() => fetchFreshFn())
                .then((freshData) => {
                  saveToCaches(freshData);
                })
                .catch((err) => {
                  console.warn(`[resolvePortalCache] Background SWR warning for ${cacheKey}:`, err?.message);
                })
                .finally(() => {
                  _inFlightSwrKeys.delete(cacheKey);
                });

              if (typeof waitUntil === "function") {
                try {
                  waitUntil(bgPromise);
                } catch (_) { }
              }
            }
            return {
              data: parsed,
              fromCache: true,
              fromRedis: true,
              staleRevalidating: ageMs > l1TtlSecs * 1000,
              cachedAt: parsed._cachedAt || null,
            };
          }

          // When bypassCache=true: coalesce if another tab/user already refreshed within the window
          const minBypassAgeMs = isAutoRefresh ? 120000 : isReadOnly ? 15000 : 0;
          if (minBypassAgeMs > 0 && ageMs < minBypassAgeMs) {
            memoryCache.set(cacheKey, parsed, l1TtlSecs);
            return {
              data: parsed,
              fromCache: true,
              fromRedis: true,
              coalescedRefresh: true,
              cachedAt: parsed._cachedAt || null,
            };
          }
        }
      }
    }
  } catch (cacheErr) {
    console.warn(`[resolvePortalCache] Redis read warning for ${cacheKey}:`, cacheErr?.message);
  }

  // 3. Explicit bypass or cache miss: fetch fresh from Google Sheets
  if (bypassCache) {
    memoryCache.del(cacheKey);
  }

  const freshData = await fetchFreshFn();
  saveToCaches(freshData);
  return {
    data: freshData,
    fromCache: false,
    cachedAt: freshData?._cachedAt || null,
  };
}

/**
 * Granular PMA & Portal client cache invalidation across L1 memory & L2 Redis
 * using deterministic exact keys + per-client Redis Set index (0 SCAN roundtrips).
 */
export async function invalidatePmaClientCache(clientSheetId, masterSheetId, scopes = []) {
  const rawClient = clientSheetId
    ? String(clientSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1")
    : null;
  const rawMaster = masterSheetId
    ? String(masterSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1")
    : null;
  const cleanClientId = rawClient ? unwrapSheetId(rawClient) || rawClient : null;
  const cleanMasterId = rawMaster ? unwrapSheetId(rawMaster) || rawMaster : null;

  const l1Patterns = [];
  const exactKeys = new Set();
  const allScopes = !scopes || scopes.length === 0;

  const addPortalKeys = (id) => {
    exactKeys.add(`pulse:portal:payload:${id}`);
    exactKeys.add(`pulse:portal:performance:${id}`);
    exactKeys.add(`pulse:portal:budget:${id}`);
    exactKeys.add(`pulse:portal:cash:${id}`);
    exactKeys.add(`portal_cash_${id}`);
    exactKeys.add(`pulse:portal:keydata:${id}`);
    exactKeys.add(`pulse:portal:key-data:${id}`);
    for (const kt of ["all", "confirmed", "pipeline", "outgoings", "salaries", "nbtofind", "overview"]) {
      exactKeys.add(`pulse:portal:keydata:${id}:${kt}`);
      exactKeys.add(`pulse:portal:key-data:${id}:${kt}`);
    }
  };

  const addViewKeys = (id) => {
    for (const tab of ["dashboard", "cash", "contractors", "outgoings", "budget", "fy", "salaries", "nbtofind"]) {
      exactKeys.add(`pulse:view_data:${id}:${tab}`);
    }
  };

  if (cleanClientId) {
    l1Patterns.push(`pulse:pma:shared_jobs_raw:${cleanClientId}*`);
    exactKeys.add(`pulse:pma:shared_jobs_raw:${cleanClientId}`);

    if (allScopes || scopes.includes("jobs")) {
      l1Patterns.push(
        `pulse:pma:jobs:${cleanClientId}*`,
        `pulse:pma:invoice_jobs:${cleanClientId}*`,
        `pulse:pma:direct_costs_jobs:${cleanClientId}*`,
        `pulse:portal:*:${cleanClientId}*`,
        `pulse:view_data:${cleanClientId}:*`,
        `pma_nbtofind_${cleanClientId}*`,
        `pma_vat_${cleanClientId}*`
      );
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:All`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:Confirmed`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:Pipeline`);
      exactKeys.add(`pulse:pma:invoice_jobs:${cleanClientId}:all`);
      exactKeys.add(`pulse:pma:invoice_jobs:${cleanClientId}:active`);
      exactKeys.add(`pulse:pma:direct_costs_jobs:${cleanClientId}:all`);
      exactKeys.add(`pulse:pma:direct_costs_jobs:${cleanClientId}:active`);
      exactKeys.add(`pma_nbtofind_${cleanClientId}`);
      exactKeys.add(`pma_vat_${cleanClientId}`);
      addPortalKeys(cleanClientId);
      addViewKeys(cleanClientId);
    }
    if (allScopes || scopes.includes("invoices")) {
      l1Patterns.push(
        `pulse:pma:invoice_jobs:${cleanClientId}*`,
        `pulse:pma:jobs:${cleanClientId}*`,
        `pulse:portal:keydata:${cleanClientId}*`,
        `pulse:portal:key-data:${cleanClientId}*`,
        `pulse:portal:payload:${cleanClientId}*`,
        `pulse:portal:performance:${cleanClientId}*`,
        `pma_vat_${cleanClientId}*`
      );
      exactKeys.add(`pulse:pma:invoice_jobs:${cleanClientId}:all`);
      exactKeys.add(`pulse:pma:invoice_jobs:${cleanClientId}:active`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:All`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:Confirmed`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:Pipeline`);
      exactKeys.add(`pma_vat_${cleanClientId}`);
      addPortalKeys(cleanClientId);
    }
    if (allScopes || scopes.includes("outgoings") || scopes.includes("expenses")) {
      l1Patterns.push(
        `pulse:pma:outgoings:${cleanClientId}*`,
        `pulse:pma:direct_costs_jobs:${cleanClientId}*`,
        `pulse:pma:jobs:${cleanClientId}*`,
        `pulse:portal:keydata:${cleanClientId}*`,
        `pulse:portal:key-data:${cleanClientId}*`,
        `pulse:portal:payload:${cleanClientId}*`,
        `pulse:portal:performance:${cleanClientId}*`,
        `pma_expenses_${cleanClientId}*`,
        `pma_vat_${cleanClientId}*`,
        `salaries_data:${cleanClientId}*`
      );
      exactKeys.add(`pulse:pma:outgoings:${cleanClientId}`);
      exactKeys.add(`pulse:pma:direct_costs_jobs:${cleanClientId}:all`);
      exactKeys.add(`pulse:pma:direct_costs_jobs:${cleanClientId}:active`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:All`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:Confirmed`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:Pipeline`);
      exactKeys.add(`pma_expenses_${cleanClientId}`);
      exactKeys.add(`pma_vat_${cleanClientId}`);
      exactKeys.add(`salaries_data:${cleanClientId}`);
      addPortalKeys(cleanClientId);
    }
    if (allScopes || scopes.includes("retainers")) {
      l1Patterns.push(
        `pulse:pma:retainer_jobs:${cleanClientId}*`,
        `pulse:pma:jobs:${cleanClientId}*`,
        `pulse:pma:invoice_jobs:${cleanClientId}*`,
        `pulse:portal:keydata:${cleanClientId}*`,
        `pulse:portal:key-data:${cleanClientId}*`,
        `pulse:portal:payload:${cleanClientId}*`,
        `pulse:portal:performance:${cleanClientId}*`,
        `pma_vat_${cleanClientId}*`
      );
      exactKeys.add(`pulse:pma:retainer_jobs:${cleanClientId}`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:All`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:Confirmed`);
      exactKeys.add(`pulse:pma:jobs:${cleanClientId}:Pipeline`);
      exactKeys.add(`pulse:pma:invoice_jobs:${cleanClientId}:all`);
      exactKeys.add(`pulse:pma:invoice_jobs:${cleanClientId}:active`);
      exactKeys.add(`pma_vat_${cleanClientId}`);
      addPortalKeys(cleanClientId);
    }
    if (allScopes || scopes.includes("views")) {
      l1Patterns.push(
        `pulse:view_data:${cleanClientId}:*`,
        `pulse:portal:*:${cleanClientId}*`,
        `pma_expenses_${cleanClientId}*`,
        `pma_nbtofind_${cleanClientId}*`,
        `pma_vat_${cleanClientId}*`,
        `salaries_data:${cleanClientId}*`
      );
      exactKeys.add(`pma_expenses_${cleanClientId}`);
      exactKeys.add(`pma_nbtofind_${cleanClientId}`);
      exactKeys.add(`pma_vat_${cleanClientId}`);
      exactKeys.add(`salaries_data:${cleanClientId}`);
      addViewKeys(cleanClientId);
      addPortalKeys(cleanClientId);
    }
    if (allScopes || scopes.includes("cash")) {
      l1Patterns.push(
        `pma_cash_${cleanClientId}*`,
        `portal_cash_${cleanClientId}*`,
        `pulse:portal:cash:${cleanClientId}*`,
        `pulse:portal:payload:${cleanClientId}*`
      );
      exactKeys.add(`pma_cash_${cleanClientId}`);
      exactKeys.add(`portal_cash_${cleanClientId}`);
      exactKeys.add(`pulse:portal:cash:${cleanClientId}`);
      exactKeys.add(`pulse:portal:payload:${cleanClientId}`);
    }
  }

  if (cleanMasterId) {
    if (allScopes || scopes.includes("invoices")) {
      l1Patterns.push(`pulse:pma:invoices_inbox:${cleanMasterId}*`);
      exactKeys.add(`pulse:pma:invoices_inbox:${cleanMasterId}`);
    }
    if (allScopes || scopes.includes("outgoings") || scopes.includes("expenses")) {
      l1Patterns.push(`pulse:pma:outgoings_inbox:${cleanMasterId}*`);
      exactKeys.add(`pulse:pma:outgoings_inbox:${cleanMasterId}`);
    }
  }

  for (const p of new Set(l1Patterns)) {
    memoryCache.del(p);
  }
  for (const k of exactKeys) {
    memoryCache.del(k);
  }

  if (redisClient?.isOpen && (exactKeys.size > 0 || cleanClientId || cleanMasterId)) {
    try {
      const idxKeys = [];
      if (cleanClientId) idxKeys.push(`${CACHE_IDX_PREFIX}${cleanClientId}`);
      if (cleanMasterId) idxKeys.push(`${CACHE_IDX_PREFIX}${cleanMasterId}`);

      if (allScopes && idxKeys.length > 0) {
        const dynamicMembers = await Promise.all(
          idxKeys.map((ik) => redisClient.sMembers(ik).catch(() => []))
        );
        for (const m of dynamicMembers.flat()) {
          if (m) exactKeys.add(m);
        }
        for (const ik of idxKeys) exactKeys.add(ik);
      } else if (idxKeys.length > 0 && exactKeys.size > 0) {
        const dynamicMembers = await Promise.all(
          idxKeys.map((ik) => redisClient.sMembers(ik).catch(() => []))
        );
        const flatDynamic = dynamicMembers.flat().filter(Boolean);
        for (const k of flatDynamic) {
          if (k.startsWith(`pulse:view_data:`) && (allScopes || scopes.includes("views") || scopes.includes("jobs"))) {
            exactKeys.add(k);
          } else if (k.startsWith(`pulse:portal:keydata:`) && (allScopes || scopes.includes("jobs") || scopes.includes("invoices") || scopes.includes("outgoings") || scopes.includes("retainers"))) {
            exactKeys.add(k);
          }
        }
      }

      const allKeysToDel = [...exactKeys].filter(Boolean);
      if (allKeysToDel.length > 0) {
        await redisClient.del(allKeysToDel);
      }
    } catch (err) {
      console.warn("[invalidatePmaClientCache] Redis delete error:", err?.message);
    }
  }
}
