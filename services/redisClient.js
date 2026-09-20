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
    rejectUnauthorized: false,
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
  redisClient.connect().catch((err) => console.log('🔴 REDIS FATAL CONNECT ERROR:', err.message));
}