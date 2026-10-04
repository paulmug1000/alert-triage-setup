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
