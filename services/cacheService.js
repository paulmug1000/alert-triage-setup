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

import { redisClient } from "./redisClient.js";

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

/**
 * Granular PMA client cache invalidation across all matching L1/L2 keys.
 */
export async function invalidatePmaClientCache(clientSheetId, masterSheetId, scopes = []) {
  const cleanClientId = clientSheetId
    ? String(clientSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1")
    : null;
  const cleanMasterId = masterSheetId
    ? String(masterSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1")
    : null;

  const patterns = [];
  const allScopes = !scopes || scopes.length === 0;

  if (cleanClientId) {
    if (allScopes || scopes.includes("jobs")) {
      patterns.push(`pulse:pma:jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:invoice_jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:direct_costs_jobs:${cleanClientId}*`);
      patterns.push(`pulse:portal:*:${cleanClientId}*`);
      patterns.push(`pulse:view_data:${cleanClientId}:*`);
    }
    if (allScopes || scopes.includes("invoices")) {
      patterns.push(`pulse:pma:invoice_jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:jobs:${cleanClientId}*`);
      patterns.push(`pulse:portal:key-data:${cleanClientId}*`);
    }
    if (allScopes || scopes.includes("outgoings")) {
      patterns.push(`pulse:pma:outgoings:${cleanClientId}*`);
      patterns.push(`pulse:pma:direct_costs_jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:jobs:${cleanClientId}*`);
    }
    if (allScopes || scopes.includes("retainers")) {
      patterns.push(`pulse:pma:retainer_jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:jobs:${cleanClientId}*`);
      patterns.push(`pulse:pma:invoice_jobs:${cleanClientId}*`);
    }
    if (allScopes || scopes.includes("views")) {
      patterns.push(`pulse:view_data:${cleanClientId}:*`);
      patterns.push(`pulse:portal:*:${cleanClientId}*`);
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

  await Promise.allSettled(patterns.map((p) => del2TierCache(p)));
}
