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
import { getSheetsClient } from "./sheetsClient.js";
import { resolveClientNameBySheetId } from "./userPermissions.js";

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

export const SHARED_XERO_KEY = "pulse:vault:shared:xero";

/**
 * Fuzzy matches a Pulse client identifier (name, slug, or sheet ID)
 * to an organisation in a list of Xero available tenants.
 */
export function matchTenantToClient(clientIdentifier, availableTenants = []) {
  if (!clientIdentifier || !Array.isArray(availableTenants) || availableTenants.length === 0) {
    return null;
  }
  const cleanId = String(clientIdentifier).toLowerCase().trim();
  const cleanAlpha = cleanId.replace(/[^a-z0-9]/g, "");
  if (!cleanAlpha || cleanAlpha === "client" || cleanAlpha === "apptest") {
    return null;
  }

  // 1. Exact match by tenantId if clientIdentifier is a UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId)) {
    const byId = availableTenants.find(t => String(t.tenantId).toLowerCase() === cleanId);
    if (byId) return byId;
  }

  // 2. Exact match on cleaned tenant name
  const exact = availableTenants.find(t => {
    const tClean = String(t.tenantName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return tClean === cleanAlpha;
  });
  if (exact) return exact;

  // 3. Substring inclusion
  const sub = availableTenants.find(t => {
    const tClean = String(t.tenantName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return tClean.includes(cleanAlpha) || cleanAlpha.includes(tClean);
  });
  if (sub) return sub;

  // 4. Word-based intersection (e.g. "Beyond The Blueprint Limited" vs "beyond_the_blueprint")
  const stopWords = new Set(["ltd", "limited", "the", "and", "co", "uk", "group", "holdings"]);
  const targetWords = cleanId.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  if (targetWords.length > 0) {
    const wordMatch = availableTenants.find(t => {
      const tWords = String(t.tenantName || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
      return targetWords.every(w => tWords.includes(w)) || tWords.every(w => targetWords.includes(w));
    });
    if (wordMatch) return wordMatch;
  }

  return null;
}

/**
 * Stores the Central/Shared Advisor Xero Grant in Redis.
 * Encrypts sensitive tokens under AAD "shared:xero".
 */
export async function saveSharedXeroGrant({ tokens, availableTenants = [], connectedBy = "advisor" }) {
  if (!tokens || !tokens.accessToken) {
    throw new Error("Missing valid tokens for saveSharedXeroGrant");
  }

  // Only store organisations verified directly from getXeroConnections on this token grant.
  // Historical unverified tenants must not be merged in, as this token lacks access to them.
  const verifiedTenants = (availableTenants || []).filter(t => t && t.tenantId);

  const aad = "shared:xero";
  const now = Date.now();
  const expiresInMs = (tokens.expiresIn || 1800) * 1000;
  const expiresAt = tokens.expiresAt || (now + expiresInMs);

  const sensitiveBundle = {
    accessToken: tokens.accessToken || "",
    refreshToken: tokens.refreshToken || "",
    idToken: tokens.idToken || "",
    scope: tokens.scope || ""
  };

  const encryptedTokens = encryptPayload(sensitiveBundle, aad);

  const record = {
    tool: "xero",
    isSharedGrant: true,
    connectedBy: connectedBy || "advisor",
    status: "connected",
    scope: tokens.scope || "",
    expiresAt,
    encryptedTokens,
    availableTenants: verifiedTenants.map(t => ({
      tenantId: t.tenantId,
      tenantName: t.tenantName,
      createdDateUtc: t.createdDateUtc || ""
    })),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    lastRefreshedAt: new Date(now).toISOString()
  };

  await redisClient.set(SHARED_XERO_KEY, JSON.stringify(record));
  console.log(`🔒 Vault: Successfully stored central shared Xero grant with ${verifiedTenants.length} organisations.`);
  return record;
}

/**
 * Retrieves the Central/Shared Advisor Xero Grant and decrypts its tokens.
 */
export async function getSharedXeroGrant() {
  const rawJson = await redisClient.get(SHARED_XERO_KEY);
  if (!rawJson) return null;
  try {
    const record = JSON.parse(rawJson);
    const aad = "shared:xero";
    const decryptedBundle = decryptPayload(record.encryptedTokens, aad);
    return {
      ...record,
      tokens: decryptedBundle
    };
  } catch (err) {
    console.error("🚨 Vault: Failed to decrypt shared Xero grant:", err.message);
    return null;
  }
}

/**
 * Updates the Central/Shared Advisor Xero Grant tokens after a refresh.
 */
export async function updateSharedXeroGrantTokens(tokens) {
  const rawJson = await redisClient.get(SHARED_XERO_KEY);
  if (!rawJson) {
    throw new Error("No shared Xero grant found in Vault to update.");
  }
  const record = JSON.parse(rawJson);
  const aad = "shared:xero";

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
  record.reconnectRequired = false;

  await redisClient.set(SHARED_XERO_KEY, JSON.stringify(record));
  console.log(`🔄 Vault: Central Shared Xero grant refreshed. Fresh for ${Math.round(expiresInMs / 60000)}m.`);
  return record;
}

/**
 * Links a specific client to the Central Shared Xero Grant.
 */
export async function linkClientToSharedXero({
  clientKey,
  clientName,
  masterSheetId,
  tenantId,
  tenantName,
  availableTenants = []
}) {
  const cleanClient = normalizeKey(clientKey);
  const redisKey = getVaultRedisKey(cleanClient, "xero");

  const now = Date.now();
  const record = {
    tool: "xero",
    clientKey: cleanClient,
    clientName: clientName || cleanClient,
    masterSheetId: masterSheetId || "",
    tenantId: tenantId || "",
    tenantName: tenantName || "",
    status: "connected",
    isSharedGrant: true,
    metadata: {
      isSharedGrant: true,
      tenantId: tenantId || "",
      tenantName: tenantName || "",
      availableTenants: availableTenants.map(t => ({
        tenantId: t.tenantId,
        tenantName: t.tenantName
      }))
    },
    updatedAt: new Date(now).toISOString(),
    lastRefreshedAt: new Date(now).toISOString()
  };

  await redisClient.set(redisKey, JSON.stringify(record));

  if (masterSheetId) {
    const sheetKey = getSheetIndexRedisKey(masterSheetId, "xero");
    await redisClient.set(sheetKey, redisKey);
  }

  console.log(`🔗 Vault: Linked ${cleanClient} to shared Xero tenant: "${tenantName}" (${tenantId})`);
  return record;
}

/**
 * Saves or updates integration credentials in the Vault.
 * 
 * @param {Object} params
 * @param {string} params.clientKey Unique client identifier (name or workspace slug)
 * @param {string} params.clientName Human-readable client name
 * @param {string} params.masterSheetId Client's master spreadsheet ID
 * @param {string} params.tool Integration name (e.g., 'xero', 'quickbooks', 'clickup')
 * @param {Object} [params.tokens] Token bundle { accessToken, refreshToken, idToken, expiresIn }
 * @param {Object} params.metadata Metadata { tenantId, tenantName, scopes, ... }
 * @returns {Promise<Object>} Summary of stored connection
 */
export async function saveIntegrationTokens({
  clientKey,
  clientName,
  masterSheetId,
  tool,
  tokens = null,
  metadata = {}
}) {
  if (!clientKey || !tool) {
    throw new Error("Missing required parameters for saveIntegrationTokens");
  }

  const cleanClient = normalizeKey(clientKey);
  const cleanTool = normalizeKey(tool);
  const aad = `${cleanClient}:${cleanTool}`;

  // If this is a client link to a shared grant, tokens can be null
  const isSharedGrant = Boolean(metadata.isSharedGrant);
  if (!tokens && !isSharedGrant) {
    throw new Error("Missing tokens parameter for saveIntegrationTokens (non-shared grant)");
  }

  // Calculate expiry timestamp
  const now = Date.now();
  const expiresInMs = ((tokens && tokens.expiresIn) || 1800) * 1000;
  const expiresAt = (tokens && tokens.expiresAt) || (now + expiresInMs);

  let encryptedTokens = "";
  if (tokens) {
    const sensitiveBundle = {
      accessToken: tokens.accessToken || "",
      refreshToken: tokens.refreshToken || "",
      idToken: tokens.idToken || "",
      scope: tokens.scope || metadata.scope || ""
    };
    encryptedTokens = encryptPayload(sensitiveBundle, aad);
  }

  const tenantId = metadata.tenantId || metadata.realmId || "";
  const tenantName = metadata.tenantName || metadata.companyName || "";
  const realmId = metadata.realmId || metadata.tenantId || "";
  const companyName = metadata.companyName || metadata.tenantName || "";

  // Store non-sensitive metadata alongside ciphertext
  const record = {
    tool: cleanTool,
    clientKey: cleanClient,
    clientName: clientName || cleanClient,
    masterSheetId: masterSheetId || "",
    tenantId,
    tenantName,
    realmId,
    companyName,
    status: "connected",
    scope: (tokens && tokens.scope) || metadata.scope || "",
    isSharedGrant,
    expiresAt,
    encryptedTokens,
    metadata,
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

  console.log(`🔒 Vault: Successfully stored credentials for ${cleanClient} [${cleanTool}]. Shared: ${isSharedGrant}, Tenant: ${companyName || tenantName || realmId || tenantId || "N/A"}`);

  return {
    success: true,
    tool: cleanTool,
    clientKey: cleanClient,
    clientName: record.clientName,
    tenantId: record.tenantId,
    tenantName: record.tenantName,
    realmId: record.realmId,
    companyName: record.companyName,
    status: record.status,
    isSharedGrant,
    expiresAt: record.expiresAt
  };
}

/**
 * Retrieves integration credentials, resolving via clientKey or masterSheetId.
 * Automatically decrypts tokens and seamlessly falls back to the Central Shared Xero Grant.
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

    // Fallback: If sheet index is missing in Redis, resolve clientName from AutoUpdates
    if (!redisKey) {
      try {
        const sheets = await getSheetsClient();
        const resolvedName = await resolveClientNameBySheetId(sheets, masterSheetId);
        if (resolvedName) {
          const fallbackKey = getVaultRedisKey(resolvedName, cleanTool);
          const rawCheck = await redisClient.get(fallbackKey);
          if (rawCheck) {
            redisKey = fallbackKey;
            await redisClient.set(sheetIndexKey, fallbackKey);
            console.log(`🔗 Vault: Auto-healed sheet index for "${resolvedName}" [${cleanTool}] -> ${masterSheetId}`);
          }
        }
      } catch (fallbackErr) {
        console.warn("⚠️ Vault sheet fallback resolution note:", fallbackErr.message);
      }
    }
  }

  let record = null;
  if (redisKey) {
    const rawJson = await redisClient.get(redisKey);
    if (rawJson) {
      try {
        record = JSON.parse(rawJson);
      } catch {}
    }
  }

  // 1. If tool is Xero: Check if client uses or should use the Central Shared Xero Grant
  if (cleanTool === "xero") {
    // If the record exists and is dedicated (has encryptedTokens and is NOT marked isSharedGrant) and is connected
    const isDedicated = record && !record.isSharedGrant && record.encryptedTokens && record.status === "connected";
    if (isDedicated) {
      try {
        const aad = `${record.clientKey}:${cleanTool}`;
        const decryptedBundle = decryptPayload(record.encryptedTokens, aad);
        return {
          tool: record.tool,
          clientKey: record.clientKey,
          clientName: record.clientName,
          masterSheetId: record.masterSheetId,
          tenantId: record.tenantId || "",
          tenantName: record.tenantName || "",
          status: record.status,
          expiresAt: record.expiresAt,
          tokens: decryptedBundle,
          metadata: record.metadata || {},
          updatedAt: record.updatedAt,
          lastRefreshedAt: record.lastRefreshedAt
        };
      } catch (err) {
        console.warn(`Dedicated Xero token decrypt failed for ${record.clientKey}, checking shared grant:`, err.message);
      }
    }

    // Otherwise, check Central Shared Xero Grant
    const sharedGrant = await getSharedXeroGrant();
    if (sharedGrant && sharedGrant.status === "connected" && sharedGrant.tokens) {
      // Find which tenant belongs to this client
      let matchedTenant = null;
      if (record && record.tenantId) {
        matchedTenant = matchTenantToClient(record.tenantId, sharedGrant.availableTenants);
      }
      if (!matchedTenant && (clientKey || record?.clientKey || record?.clientName)) {
        matchedTenant = matchTenantToClient(record?.clientName || clientKey || record?.clientKey, sharedGrant.availableTenants);
      }

      if (matchedTenant) {
        const tenantId = matchedTenant.tenantId;
        const tenantName = matchedTenant.tenantName;
        const cleanClient = normalizeKey(clientKey || record?.clientKey || tenantName);
        const displayName = record?.clientName || clientKey || tenantName;

        return {
          tool: "xero",
          clientKey: cleanClient,
          clientName: displayName,
          masterSheetId: masterSheetId || record?.masterSheetId || "",
          tenantId,
          tenantName,
          status: "connected",
          expiresAt: sharedGrant.expiresAt,
          tokens: sharedGrant.tokens,
          isSharedGrant: true,
          metadata: {
            isSharedGrant: true,
            tenantId,
            tenantName,
            availableTenants: sharedGrant.availableTenants
          },
          updatedAt: sharedGrant.updatedAt,
          lastRefreshedAt: sharedGrant.lastRefreshedAt
        };
      }
    }

    // Client is neither in shared grant nor has a valid connected dedicated grant
    return null;
  }

  if (!record) return null;

  try {
    const aad = `${record.clientKey}:${cleanTool}`;
    const decryptedBundle = record.encryptedTokens ? decryptPayload(record.encryptedTokens, aad) : null;

    return {
      tool: record.tool,
      clientKey: record.clientKey,
      clientName: record.clientName,
      masterSheetId: record.masterSheetId,
      tenantId: record.tenantId || record.realmId || "",
      tenantName: record.tenantName || record.companyName || "",
      realmId: record.realmId || record.tenantId || "",
      companyName: record.companyName || record.tenantName || "",
      status: record.status,
      expiresAt: record.expiresAt,
      tokens: decryptedBundle,
      isSharedGrant: Boolean(record.isSharedGrant),
      metadata: record.metadata || {},
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
 * Automatically synchronizes with Central Shared Xero Grant when applicable.
 */
export async function updateRefreshedTokens({ clientKey, tool, tokens, newTenantId = null }) {
  const cleanClient = normalizeKey(clientKey);
  const cleanTool = normalizeKey(tool);

  // If tool is Xero and shared grant exists:
  const sharedGrant = await getSharedXeroGrant();
  if (cleanTool === "xero" && sharedGrant) {
    await updateSharedXeroGrantTokens(tokens);
  }

  const redisKey = getVaultRedisKey(cleanClient, cleanTool);
  const rawJson = await redisClient.get(redisKey);
  if (!rawJson) {
    if (cleanTool === "xero" && sharedGrant) {
      return sharedGrant;
    }
    throw new Error(`Cannot update tokens: No existing integration record found for ${cleanClient}:${cleanTool}`);
  }

  const record = JSON.parse(rawJson);
  const now = Date.now();
  const expiresInMs = (tokens.expiresIn || 1800) * 1000;
  record.expiresAt = tokens.expiresAt || (now + expiresInMs);
  record.lastRefreshedAt = new Date(now).toISOString();
  record.updatedAt = new Date(now).toISOString();
  record.status = "connected";
  record.reconnectRequired = false;

  if (newTenantId) {
    record.tenantId = newTenantId;
  }

  if (!record.isSharedGrant && record.encryptedTokens) {
    const aad = `${cleanClient}:${cleanTool}`;
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
    record.encryptedTokens = encryptPayload(mergedBundle, aad);
  }

  await redisClient.set(redisKey, JSON.stringify(record));
  console.log(`🔄 Vault: Refreshed tokens persisted for ${cleanClient} [${cleanTool}]. Expires in ${Math.round(expiresInMs / 60000)}m.`);
  return record;
}

/**
 * Returns non-sensitive connection status (for UI display or status checks).
 * Does not decrypt tokens. Seamlessly resolves Shared Xero Grant status.
 */
export async function getIntegrationStatus({ clientKey, masterSheetId, tool }) {
  const cleanTool = normalizeKey(tool);
  let redisKey = null;

  if (clientKey) {
    redisKey = getVaultRedisKey(clientKey, cleanTool);
  } else if (masterSheetId) {
    const sheetIndexKey = getSheetIndexRedisKey(masterSheetId, cleanTool);
    redisKey = await redisClient.get(sheetIndexKey);

    // Fallback: If sheet index is missing in Redis, resolve clientName from AutoUpdates
    if (!redisKey) {
      try {
        const sheets = await getSheetsClient();
        const resolvedName = await resolveClientNameBySheetId(sheets, masterSheetId);
        if (resolvedName) {
          const fallbackKey = getVaultRedisKey(resolvedName, cleanTool);
          const rawCheck = await redisClient.get(fallbackKey);
          if (rawCheck) {
            redisKey = fallbackKey;
            await redisClient.set(sheetIndexKey, fallbackKey);
            console.log(`🔗 Vault: Auto-healed status index for "${resolvedName}" [${cleanTool}] -> ${masterSheetId}`);
          }
        }
      } catch (fallbackErr) {
        console.warn("⚠️ Vault status sheet fallback resolution note:", fallbackErr.message);
      }
    }
  }

  let record = null;
  if (redisKey) {
    const rawJson = await redisClient.get(redisKey);
    if (rawJson) {
      try {
        record = JSON.parse(rawJson);
      } catch {}
    }
  }

  // 1. For Xero: Check if shared grant is active
  if (cleanTool === "xero") {
    // If dedicated non-shared record exists and is connected
    if (record && !record.isSharedGrant && record.status === "connected" && !record.reconnectRequired) {
      const isExpired = record.expiresAt && Date.now() > record.expiresAt;
      return {
        connected: true,
        tool: "xero",
        clientKey: record.clientKey,
        clientName: record.clientName,
        tenantId: record.tenantId || "",
        tenantName: record.tenantName || "",
        status: record.status,
        reconnectRequired: false,
        isExpired,
        expiresAt: record.expiresAt,
        isSharedGrant: false,
        lastRefreshedAt: record.lastRefreshedAt,
        updatedAt: record.updatedAt,
        availableTenants: record.metadata?.availableTenants || [],
        metadata: record.metadata || {}
      };
    }

    const sharedGrant = await getSharedXeroGrant();
    const isSharedClient = Boolean(record?.isSharedGrant);

    if (isSharedClient || (!record && sharedGrant)) {
      if (!sharedGrant || sharedGrant.status !== "connected" || sharedGrant.reconnectRequired) {
        return {
          connected: false,
          tool: "xero",
          clientKey: record?.clientKey || clientKey || "",
          clientName: record?.clientName || clientKey || "",
          tenantId: record?.tenantId || "",
          tenantName: record?.tenantName || "",
          status: "reconnect_required",
          reconnectRequired: true,
          isSharedGrant: true,
          error: "Central Advisor Xero Account requires re-authorisation."
        };
      }

      // Shared grant is active: check if THIS client's organisation is in availableTenants
      let matchedTenant = null;
      if (record && record.tenantId) {
        matchedTenant = matchTenantToClient(record.tenantId, sharedGrant.availableTenants);
      }
      if (!matchedTenant && (clientKey || record?.clientKey || record?.clientName)) {
        matchedTenant = matchTenantToClient(record?.clientName || clientKey || record?.clientKey, sharedGrant.availableTenants);
      }

      if (matchedTenant) {
        const tenantId = matchedTenant.tenantId;
        const tenantName = matchedTenant.tenantName;
        const isExpired = sharedGrant.expiresAt && Date.now() > sharedGrant.expiresAt;

        return {
          connected: true,
          tool: "xero",
          clientKey: record?.clientKey || normalizeKey(clientKey || tenantName),
          clientName: record?.clientName || clientKey || tenantName,
          tenantId,
          tenantName,
          status: "connected",
          reconnectRequired: false,
          isExpired,
          expiresAt: sharedGrant.expiresAt,
          isSharedGrant: true,
          availableTenants: sharedGrant.availableTenants || [],
          lastRefreshedAt: sharedGrant.lastRefreshedAt,
          updatedAt: sharedGrant.updatedAt,
          metadata: {
            isSharedGrant: true,
            tenantId,
            tenantName,
            availableTenants: sharedGrant.availableTenants || []
          }
        };
      } else {
        // Shared grant is active, but THIS client's organisation is NOT authorized in Xero!
        return {
          connected: false,
          tool: "xero",
          clientKey: clientKey || record?.clientKey || "",
          clientName: record?.clientName || clientKey || "",
          tenantId: record?.tenantId || "",
          tenantName: record?.tenantName || "",
          status: "not_connected",
          reconnectRequired: true,
          isSharedGrant: true,
          notInAdvisorGrant: true,
          error: `Organisation "${record?.tenantName || record?.tenantId || clientKey}" is not authorized under the Central Advisor Account.`,
          availableTenants: sharedGrant.availableTenants || []
        };
      }
    }
  }

  if (!record) {
    return { connected: false, tool: cleanTool };
  }

  try {
    const isExpired = record.expiresAt && Date.now() > record.expiresAt;
    const isReconnectRequired = record.status === "reconnect_required" || Boolean(record.reconnectRequired);
    const isConnected = record.status === "connected" && !isReconnectRequired;

    return {
      connected: isConnected,
      tool: record.tool,
      clientKey: record.clientKey,
      clientName: record.clientName,
      tenantId: record.tenantId || record.realmId || "",
      tenantName: record.tenantName || record.companyName || "",
      realmId: record.realmId || record.tenantId || "",
      companyName: record.companyName || record.tenantName || "",
      status: record.status,
      reconnectRequired: isReconnectRequired,
      isExpired,
      expiresAt: record.expiresAt,
      isSharedGrant: Boolean(record.isSharedGrant),
      lastRefreshedAt: record.lastRefreshedAt,
      updatedAt: record.updatedAt,
      lastError: record.lastError || null,
      availableTenants: record.metadata?.availableTenants || [],
      metadata: record.metadata || {}
    };
  } catch (err) {
    return { connected: false, tool: cleanTool, error: err.message };
  }
}

/**
 * Marks an integration as reconnect_required when token refresh fails with invalid_grant.
 */
export async function markIntegrationReconnectRequired({ clientKey, masterSheetId, tool, error = "", isSharedGrant = false }) {
  const cleanTool = normalizeKey(tool);

  let redisKey = null;
  if (clientKey) {
    redisKey = getVaultRedisKey(clientKey, cleanTool);
  } else if (masterSheetId) {
    const sheetIndexKey = getSheetIndexRedisKey(masterSheetId, cleanTool);
    redisKey = await redisClient.get(sheetIndexKey);
  }

  let record = null;
  if (redisKey) {
    const rawJson = await redisClient.get(redisKey);
    if (rawJson) {
      try {
        record = JSON.parse(rawJson);
        record.status = "reconnect_required";
        record.reconnectRequired = true;
        record.lastError = String(error || "");
        record.updatedAt = new Date().toISOString();
        await redisClient.set(redisKey, JSON.stringify(record));
        console.log(`⚠️ Vault: Marked ${record.clientKey} [${cleanTool}] as reconnect_required.`);
      } catch (err) {
        console.error(`Failed to mark reconnect_required for ${redisKey}:`, err);
      }
    }
  }

  // ONLY mark shared grant as reconnect_required if the failing connection was explicitly using the shared grant!
  if (cleanTool === "xero" && (isSharedGrant || record?.isSharedGrant)) {
    const rawShared = await redisClient.get(SHARED_XERO_KEY);
    if (rawShared) {
      try {
        const sharedRec = JSON.parse(rawShared);
        sharedRec.status = "reconnect_required";
        sharedRec.reconnectRequired = true;
        sharedRec.lastError = String(error || "");
        sharedRec.updatedAt = new Date().toISOString();
        await redisClient.set(SHARED_XERO_KEY, JSON.stringify(sharedRec));
        console.log("⚠️ Vault: Marked central shared Xero grant as reconnect_required.");
      } catch {}
    }
  }

  return record;
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
