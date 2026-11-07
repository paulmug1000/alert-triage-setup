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
import { redisClient } from "./redisClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";

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
 * Set item in both L1 memory cache and L2 Redis cache.
 */
export async function set2TierCache(key, value, ttlSeconds = 60) {
  if (!key || value === undefined) return;
  const ttl = Math.max(1, ttlSeconds);
  memoryCache.set(key, value, ttl);
  try {
    if (redisClient?.isOpen) {
      await redisClient.set(key, JSON.stringify(value), { EX: ttl });
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
        const keys = await redisClient.keys(keyOrPattern);
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
  redisTtlSecs = 900,
  isValidPayload = null,
  fetchFreshFn,
}) {
  const checkValid = (val) => {
    if (!val || typeof val !== "object") return false;
    return typeof isValidPayload === "function" ? isValidPayload(val) : true;
  };

  const saveToCaches = (data) => {
    if (!data || data._skipCache) return;
    memoryCache.set(cacheKey, data, l1TtlSecs);
    try {
      if (redisClient?.isOpen) {
        redisClient
          .set(cacheKey, JSON.stringify(data), { EX: redisTtlSecs })
          .catch((err) => console.warn(`[resolvePortalCache] Redis write warning for ${cacheKey}:`, err?.message));
      }
    } catch (_) {}
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
                } catch (_) {}
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
          const minBypassAgeMs = isAutoRefresh ? 45000 : isReadOnly ? 15000 : 0;
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
 * Granular PMA client cache invalidation across all matching L1/L2 keys.
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

  const patterns = [];
  const allScopes = !scopes || scopes.length === 0;

  if (cleanClientId) {
    if (allScopes || scopes.includes("jobs")) {
      patterns.push(`pulse:pma:jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:invoice_jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:direct_costs_jobs:${cleanClientId}*`);
      patterns.push(`pulse:portal:*:${cleanClientId}*`);
      patterns.push(`pulse:view_data:${cleanClientId}:*`);
      patterns.push(`pma_nbtofind_${cleanClientId}*`);
    }
    if (allScopes || scopes.includes("invoices")) {
      patterns.push(`pulse:pma:invoice_jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:jobs:${cleanClientId}*`);
      patterns.push(`pulse:portal:keydata:${cleanClientId}*`);
      patterns.push(`pulse:portal:key-data:${cleanClientId}*`);
      patterns.push(`pulse:portal:payload:${cleanClientId}*`);
      patterns.push(`pulse:portal:performance:${cleanClientId}*`);
    }
    if (allScopes || scopes.includes("outgoings")) {
      patterns.push(`pulse:pma:outgoings:${cleanClientId}*`);
      patterns.push(`pulse:pma:direct_costs_jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:jobs:${cleanClientId}*`);
      patterns.push(`pulse:portal:keydata:${cleanClientId}*`);
      patterns.push(`pulse:portal:key-data:${cleanClientId}*`);
      patterns.push(`pulse:portal:payload:${cleanClientId}*`);
      patterns.push(`pulse:portal:performance:${cleanClientId}*`);
      patterns.push(`pma_expenses_${cleanClientId}*`);
      patterns.push(`salaries_data:${cleanClientId}*`);
    }
    if (allScopes || scopes.includes("retainers")) {
      patterns.push(`pulse:pma:retainer_jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:invoice_jobs:${cleanClientId}*`);
      patterns.push(`pulse:portal:keydata:${cleanClientId}*`);
      patterns.push(`pulse:portal:key-data:${cleanClientId}*`);
      patterns.push(`pulse:portal:payload:${cleanClientId}*`);
      patterns.push(`pulse:portal:performance:${cleanClientId}*`);
    }
    if (allScopes || scopes.includes("views")) {
      patterns.push(`pulse:view_data:${cleanClientId}:*`);
      patterns.push(`pulse:portal:*:${cleanClientId}*`);
      patterns.push(`pma_expenses_${cleanClientId}*`);
      patterns.push(`pma_nbtofind_${cleanClientId}*`);
      patterns.push(`salaries_data:${cleanClientId}*`);
    }
    if (allScopes || scopes.includes("cash")) {
      patterns.push(`pma_cash_${cleanClientId}*`);
      patterns.push(`portal_cash_${cleanClientId}*`);
      patterns.push(`pulse:portal:cash:${cleanClientId}*`);
      patterns.push(`pulse:portal:payload:${cleanClientId}*`);
    }
  }

  if (cleanMasterId) {
    if (allScopes || scopes.includes("invoices")) {
      patterns.push(`pulse:pma:invoices_inbox:${cleanMasterId}*`);
    }
    if (allScopes || scopes.includes("outgoings")) {
      patterns.push(`pulse:pma:outgoings_inbox:${cleanMasterId}*`);
    }
  }

  const uniquePatterns = [...new Set(patterns)];
  for (const p of uniquePatterns) {
    memoryCache.del(p);
  }

  if (redisClient?.isOpen && uniquePatterns.length > 0) {
    const redisCleanup = (async () => {
      try {
        const keyLists = await Promise.all(
          uniquePatterns.map((p) =>
            p.includes("*")
              ? redisClient.keys(p).catch(() => [])
              : Promise.resolve([p])
          )
        );
        const allKeysToDel = [...new Set(keyLists.flat().filter(Boolean))];
        if (allKeysToDel.length > 0) {
          await redisClient.del(allKeysToDel);
        }
      } catch (err) {
        console.warn("[invalidatePmaClientCache] Redis delete error:", err?.message);
      }
    })();
    if (typeof waitUntil === "function") {
      try {
        waitUntil(redisCleanup);
      } catch (_) {}
    }
    await Promise.race([
      redisCleanup,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
}
