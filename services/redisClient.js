import { createClient } from "redis";

// Safely parse and log the Redis URL to verify the host, port, and protocol (masks password)
try {
  const parsedUrl = new URL(process.env.REDIS_URL || "");
  console.log(`🔍 DEBUG: Redis Config - Protocol: ${parsedUrl.protocol}, Host: ${parsedUrl.hostname}, Port: ${parsedUrl.port}`);
} catch (e) {
  console.log(`🔍 DEBUG: Failed to parse REDIS_URL. Value might be undefined or malformed.`);
}

// Create Redis client using a global singleton to prevent 
// connection leaks during Next.js Fast Refresh hot reloads.
export const redisClient = global._redisClient || createClient({
  url: process.env.REDIS_URL,
  socket: {
    family: 4,
    rejectUnauthorized: process.env.REDIS_REJECT_UNAUTHORIZED === "false" ? false : true,
    connectTimeout: 15000 // Extended to 15s to see if it's just a slow cold start
  }
});

if (!global._redisClient) {
  global._redisClient = redisClient;
  
  // Add granular event listeners to trace the exact connection lifecycle
  redisClient.on('error', (err) => console.log('🔴 REDIS ERROR:', err.message));
  redisClient.on('connect', () => console.log('🟡 REDIS: TCP Connection established (handshake next).'));
  redisClient.on('ready', () => console.log('🟢 REDIS: Ready and authenticated.'));
  redisClient.on('end', () => console.log('⚪ REDIS: Connection closed.'));
  redisClient.on('reconnecting', () => console.log('🟠 REDIS: Attempting to reconnect...'));

  console.log('🔄 REDIS: Initiating connection attempt...');
  global._redisConnectPromise = redisClient
    .connect()
    .catch((err) => {
      console.log('🔴 REDIS FATAL CONNECT ERROR:', err.message);
      return null;
    })
    .finally(() => {
      global._redisConnectPromise = null;
    });
}

/**
 * Waits briefly for the shared Redis client to finish its initial TLS/AUTH handshake
 * on cold serverless invocations so SSR and API cache reads do not miss unnecessarily.
 */
export async function ensureRedisConnected(timeoutMs = 500) {
  if (!process.env.REDIS_URL) return false;
  if (redisClient?.isReady) return true;
  try {
    if (!global._redisConnectPromise && !redisClient.isOpen) {
      global._redisConnectPromise = redisClient
        .connect()
        .catch((err) => {
          console.log('🔴 REDIS FATAL CONNECT ERROR:', err.message);
          return null;
        })
        .finally(() => {
          global._redisConnectPromise = null;
        });
    }
    if (global._redisConnectPromise) {
      await Promise.race([
        global._redisConnectPromise,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
  } catch { }
  return Boolean(redisClient?.isOpen);
}

/**
 * Non-blocking Redis key lookup using cursor SCAN (falling back to KEYS only if scan is unavailable).
 */
export async function scanRedisKeys(pattern, count = 250) {
  if (!redisClient?.isOpen || !pattern) return [];
  if (typeof redisClient.scan !== "function") {
    return typeof redisClient.keys === "function" ? redisClient.keys(pattern).catch(() => []) : [];
  }
  const matched = [];
  let cursor = 0;
  try {
    do {
      const reply = await redisClient.scan(cursor, { MATCH: pattern, COUNT: count });
      const nextCursor = Array.isArray(reply) ? reply[0] : reply?.cursor;
      const keys = Array.isArray(reply) ? reply[1] : reply?.keys;
      if (Array.isArray(keys) && keys.length > 0) {
        matched.push(...keys);
      }
      cursor = Number(nextCursor) || 0;
    } while (cursor !== 0);
  } catch {
    return [];
  }
  return [...new Set(matched)];
}