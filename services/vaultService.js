/**
 * ============================================================================
 * VAULT SERVICE - CENTRAL OAUTH ENCRYPTION & TOKEN REPOSITORY
 * ============================================================================
 * 
 * Provides industry-grade AES-256-GCM encryption at rest for third-party OAuth
 * tokens (Xero, QuickBooks, ClickUp, etc.) stored in persistent Redis.
 * 
 * Features:
 * - AES-256-GCM with 96-bit random IVs and 128-bit authentication tags.
 * - Additional Authenticated Data (AAD) binding to prevent cross-tenant token substitution.
 * - Dual-indexing (by clientName/workspaceId and by masterSheetId) for rapid GAS broker queries.
 * - Complete audit logging for token lifecycle events (creation, refresh, revocation).
 * - Sensitive credentials (client secrets & refresh tokens) never exposed outside Pulse backend.
 */

import crypto from "crypto";
import { redisClient } from "./redisClient.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits recommended for GCM

/**
 * Derives a 32-byte Buffer key from the environment variable.
 * Throws in production if INTEGRATION_ENCRYPTION_KEY is missing.
 */
function getEncryptionKey() {
  const envKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!envKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CRITICAL: INTEGRATION_ENCRYPTION_KEY environment variable is not configured.");
    }
    // Fallback key for local development only
    return crypto.createHash("sha256").update("pulse_dev_local_vault_key_2026").digest();
  }

  // If hex string (64 characters = 32 bytes)
  if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
    return Buffer.from(envKey, "hex");
  }

  // Otherwise SHA-256 hash arbitrary secret string into 32 bytes
  return crypto.createHash("sha256").update(envKey).digest();
}

/**
 * Encrypts arbitrary plaintext (string or object) with AES-256-GCM.
 * @param {string|Object} payload 
 * @param {string} aad Optional Additional Authenticated Data (e.g. tenant binding)
 * @returns {string} Serialized string: enc:v1:<ivHex>:<tagHex>:<cipherHex>
 */
export function encryptPayload(payload, aad = "") {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  if (aad) {
    cipher.setAAD(Buffer.from(String(aad), "utf8"));
  }

  const rawText = typeof payload === "string" ? payload : JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(rawText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `enc:v1:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts an encrypted payload string with AES-256-GCM.
 * @param {string} encryptedString 
 * @param {string} aad Optional Additional Authenticated Data (must match encryption AAD)
 * @returns {any} Decrypted string or parsed JSON object
 */
export function decryptPayload(encryptedString, aad = "") {
  if (!encryptedString || !encryptedString.startsWith("enc:v1:")) {
    throw new Error("Invalid or unsupported ciphertext format.");
  }

  const parts = encryptedString.split(":");
  if (parts.length !== 5) {
    throw new Error("Malformed ciphertext structure.");
  }

  const iv = Buffer.from(parts[2], "hex");
  const authTag = Buffer.from(parts[3], "hex");
  const ciphertext = Buffer.from(parts[4], "hex");

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  if (aad) {
    decipher.setAAD(Buffer.from(String(aad), "utf8"));
  }

  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

  try {
    return JSON.parse(decrypted);
  } catch {
    return decrypted;
  }
}

/**
 * Normalizes a client/workspace key for Redis.
 */
function normalizeKey(str) {
  return String(str || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

/**
 * Builds standard Redis storage keys.
 */
function getVaultRedisKey(clientKey, tool) {
  return `pulse:vault:client:${normalizeKey(clientKey)}:${normalizeKey(tool)}`;
}

function getSheetIndexRedisKey(masterSheetId, tool) {
  return `pulse:vault:sheet:${String(masterSheetId).trim()}:${normalizeKey(tool)}`;
}

/**
 * Saves or updates integration credentials in the Vault.
 * 
 * @param {Object} params
 * @param {string} params.clientKey Unique client identifier (name or workspace slug)
 * @param {string} params.clientName Human-readable client name
 * @param {string} params.masterSheetId Client's master spreadsheet ID
 * @param {string} params.tool Integration name (e.g., 'xero', 'quickbooks', 'clickup')
 * @param {Object} params.tokens Token bundle { accessToken, refreshToken, idToken, expiresIn }
 * @param {Object} params.metadata Metadata { tenantId, tenantName, scopes, ... }
 * @returns {Promise<Object>} Summary of stored connection
 */
export async function saveIntegrationTokens({
  clientKey,
  clientName,
  masterSheetId,
  tool,
  tokens,
  metadata = {}
}) {
  if (!clientKey || !tool || !tokens) {
    throw new Error("Missing required parameters for saveIntegrationTokens");
  }

  const cleanClient = normalizeKey(clientKey);
  const cleanTool = normalizeKey(tool);
  const aad = `${cleanClient}:${cleanTool}`;

  // Calculate expiry timestamp
  const now = Date.now();
  const expiresInMs = (tokens.expiresIn || 1800) * 1000;
  const expiresAt = tokens.expiresAt || (now + expiresInMs);

  // Bundle sensitive credentials for AES-256-GCM encryption
  const sensitiveBundle = {
    accessToken: tokens.accessToken || "",
    refreshToken: tokens.refreshToken || "",
    idToken: tokens.idToken || "",
    scope: tokens.scope || metadata.scope || ""
  };

  const encryptedTokens = encryptPayload(sensitiveBundle, aad);

  // Store non-sensitive metadata alongside ciphertext
  const record = {
    tool: cleanTool,
    clientKey: cleanClient,
    clientName: clientName || cleanClient,
    masterSheetId: masterSheetId || "",
    tenantId: metadata.tenantId || "",
    tenantName: metadata.tenantName || "",
    status: "connected",
    scope: tokens.scope || metadata.scope || "",
    expiresAt,
    encryptedTokens,
    createdAt: metadata.createdAt || new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    lastRefreshedAt: new Date(now).toISOString(),
    lastUsedAt: null
  };

  const redisKey = getVaultRedisKey(cleanClient, cleanTool);
  await redisClient.set(redisKey, JSON.stringify(record));

  // If masterSheetId is provided, maintain secondary lookup index for GAS Token Broker
  if (masterSheetId) {
    const sheetKey = getSheetIndexRedisKey(masterSheetId, cleanTool);
    await redisClient.set(sheetKey, redisKey);
  }

  console.log(`🔒 Vault: Successfully stored encrypted tokens for ${cleanClient} [${cleanTool}]. Tenant: ${metadata.tenantName || metadata.tenantId || "N/A"}`);

  return {
    success: true,
    tool: cleanTool,
    clientKey: cleanClient,
    clientName: record.clientName,
    tenantId: record.tenantId,
    tenantName: record.tenantName,
    status: record.status,
    expiresAt: record.expiresAt
  };
}

/**
 * Retrieves integration credentials, resolving via clientKey or masterSheetId.
 * Automatically decrypts tokens.
 * 
 * @param {Object} params
 * @param {string} [params.clientKey]
 * @param {string} [params.masterSheetId]
 * @param {string} params.tool
 * @returns {Promise<Object|null>}
 */
export async function getIntegrationTokens({ clientKey, masterSheetId, tool }) {
  const cleanTool = normalizeKey(tool);
  let redisKey = null;

  if (clientKey) {
    redisKey = getVaultRedisKey(clientKey, cleanTool);
  } else if (masterSheetId) {
    const sheetIndexKey = getSheetIndexRedisKey(masterSheetId, cleanTool);
    redisKey = await redisClient.get(sheetIndexKey);
  }

  if (!redisKey) return null;

  const rawJson = await redisClient.get(redisKey);
  if (!rawJson) return null;

  try {
    const record = JSON.parse(rawJson);
    const aad = `${record.clientKey}:${cleanTool}`;
    const decryptedBundle = decryptPayload(record.encryptedTokens, aad);

    return {
      tool: record.tool,
      clientKey: record.clientKey,
      clientName: record.clientName,
      masterSheetId: record.masterSheetId,
      tenantId: record.tenantId,
      tenantName: record.tenantName,
      status: record.status,
      expiresAt: record.expiresAt,
      tokens: decryptedBundle,
      updatedAt: record.updatedAt,
      lastRefreshedAt: record.lastRefreshedAt
    };
  } catch (err) {
    console.error(`🚨 Vault decryption failure for key ${redisKey}:`, err.message);
    throw new Error(`Vault decryption failed: ${err.message}`);
  }
}

/**
 * Updates tokens in-place (e.g. after automated refresh) without wiping metadata.
 */
export async function updateRefreshedTokens({ clientKey, tool, tokens, newTenantId = null }) {
  const cleanClient = normalizeKey(clientKey);
  const cleanTool = normalizeKey(tool);
  const redisKey = getVaultRedisKey(cleanClient, cleanTool);

  const rawJson = await redisClient.get(redisKey);
  if (!rawJson) {
    throw new Error(`Cannot update tokens: No existing integration record found for ${cleanClient}:${cleanTool}`);
  }

  const record = JSON.parse(rawJson);
  const aad = `${cleanClient}:${cleanTool}`;

  // Decrypt existing to preserve fields if new tokens only contains partial updates
  let existingBundle = {};
  try {
    existingBundle = decryptPayload(record.encryptedTokens, aad);
  } catch {}

  const mergedBundle = {
    ...existingBundle,
    accessToken: tokens.accessToken || existingBundle.accessToken,
    refreshToken: tokens.refreshToken || existingBundle.refreshToken,
    idToken: tokens.idToken || existingBundle.idToken
  };

  const now = Date.now();
  const expiresInMs = (tokens.expiresIn || 1800) * 1000;
  record.expiresAt = tokens.expiresAt || (now + expiresInMs);
  record.encryptedTokens = encryptPayload(mergedBundle, aad);
  record.lastRefreshedAt = new Date(now).toISOString();
  record.updatedAt = new Date(now).toISOString();
  record.status = "connected";

  if (newTenantId) {
    record.tenantId = newTenantId;
  }

  await redisClient.set(redisKey, JSON.stringify(record));
  console.log(`🔄 Vault: Refreshed tokens persisted for ${cleanClient} [${cleanTool}]. Expires in ${Math.round(expiresInMs / 60000)}m.`);
  return record;
}

/**
 * Returns non-sensitive connection status (for UI display or status checks).
 * Does not decrypt tokens.
 */
export async function getIntegrationStatus({ clientKey, masterSheetId, tool }) {
  const cleanTool = normalizeKey(tool);
  let redisKey = null;

  if (clientKey) {
    redisKey = getVaultRedisKey(clientKey, cleanTool);
  } else if (masterSheetId) {
    const sheetIndexKey = getSheetIndexRedisKey(masterSheetId, cleanTool);
    redisKey = await redisClient.get(sheetIndexKey);
  }

  if (!redisKey) {
    return { connected: false, tool: cleanTool };
  }

  const rawJson = await redisClient.get(redisKey);
  if (!rawJson) {
    return { connected: false, tool: cleanTool };
  }

  try {
    const record = JSON.parse(rawJson);
    const isExpired = record.expiresAt && Date.now() > record.expiresAt;

    return {
      connected: record.status === "connected",
      tool: record.tool,
      clientKey: record.clientKey,
      clientName: record.clientName,
      tenantId: record.tenantId,
      tenantName: record.tenantName,
      status: record.status,
      isExpired,
      expiresAt: record.expiresAt,
      lastRefreshedAt: record.lastRefreshedAt,
      updatedAt: record.updatedAt
    };
  } catch (err) {
    return { connected: false, tool: cleanTool, error: err.message };
  }
}

/**
 * Deletes integration credentials (Disconnect / Revoke).
 */
export async function deleteIntegrationTokens({ clientKey, masterSheetId, tool }) {
  const cleanTool = normalizeKey(tool);
  let redisKey = null;
  let sheetKey = null;

  if (clientKey) {
    redisKey = getVaultRedisKey(clientKey, cleanTool);
  }

  if (masterSheetId) {
    sheetKey = getSheetIndexRedisKey(masterSheetId, cleanTool);
    if (!redisKey) {
      redisKey = await redisClient.get(sheetKey);
    }
  }

  if (redisKey) {
    const raw = await redisClient.get(redisKey);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.masterSheetId && !sheetKey) {
          sheetKey = getSheetIndexRedisKey(parsed.masterSheetId, cleanTool);
        }
      } catch {}
    }
    await redisClient.del(redisKey);
  }

  if (sheetKey) {
    await redisClient.del(sheetKey);
  }

  console.log(`🗑️ Vault: Deleted integration tokens for ${clientKey || masterSheetId} [${cleanTool}].`);
  return { success: true };
}
