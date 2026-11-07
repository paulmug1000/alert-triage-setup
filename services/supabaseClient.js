/**
 * ============================================================================
 * SUPABASE SERVER-ONLY CLIENT & MULTI-TENANT SECURITY BOUNDARY
 * ============================================================================
 *
 * Security invariants:
 * 1. Strictly server-only: throws immediately if imported in a browser bundle.
 * 2. Never uses NEXT_PUBLIC_SUPABASE_* environment variables.
 * 3. Provides `withTenantScope` to enforce user-to-client authorization before
 *    running any tenant-scoped query.
 * 4. Manages the runtime Control Plane source toggle ('sheets' | 'supabase')
 *    with sub-millisecond in-memory caching + Redis/Supabase persistence.
 */

import { createClient } from "@supabase/supabase-js";
import { redisClient } from "./redisClient.js";

if (typeof window !== "undefined") {
  throw new Error("SECURITY VIOLATION: services/supabaseClient.js must never be imported in client-side browser code.");
}

export const CONTROL_PLANE_SOURCE_REDIS_KEY = "pulse:config:control_plane_source";

let _supabaseAdminInstance = null;
let _cachedControlPlaneSource = null;
let _cachedControlPlaneSourceAt = 0;
const SOURCE_CACHE_TTL_MS = 15000; // 15 seconds in-memory cache

function normalizeClientKey(str) {
  return String(str || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

/**
 * Checks whether server-side Supabase credentials are configured.
 */
export function isSupabaseConfigured() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return Boolean(url && key && url.startsWith("https://"));
}

/**
 * Returns the singleton server-side Supabase client using the Service Role key.
 * Returns null if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are not yet configured.
 */
export function getSupabaseAdmin() {
  if (!isSupabaseConfigured()) return null;
  if (_supabaseAdminInstance) return _supabaseAdminInstance;

  if (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_URL) {
    console.warn("⚠️ SECURITY WARNING: NEXT_PUBLIC_SUPABASE_* environment variables detected. Remove them so Supabase is never exposed to the browser.");
  }

  const url = String(process.env.SUPABASE_URL).trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim();

  _supabaseAdminInstance = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return _supabaseAdminInstance;
}

/**
 * Returns the active Control Plane source ('sheets' | 'supabase').
 * Defaults to process.env.CONTROL_PLANE_SOURCE || 'sheets' if not overridden in Redis/Supabase.
 */
export async function getControlPlaneSource(bypassCache = false) {
  if (!isSupabaseConfigured()) {
    return "sheets";
  }

  const now = Date.now();
  if (!bypassCache && _cachedControlPlaneSource && (now - _cachedControlPlaneSourceAt < SOURCE_CACHE_TTL_MS)) {
    return _cachedControlPlaneSource;
  }

  // 1. Check Redis runtime toggle
  try {
    if (redisClient?.isOpen) {
      const val = await redisClient.get(CONTROL_PLANE_SOURCE_REDIS_KEY);
      if (val === "supabase" || val === "sheets") {
        _cachedControlPlaneSource = val;
        _cachedControlPlaneSourceAt = now;
        return val;
      }
    }
  } catch (e) {
    // Fall through to env or Supabase system_config
  }

  // 2. Check environment variable default
  const envDefault = String(process.env.CONTROL_PLANE_SOURCE || "").trim().toLowerCase();
  if (envDefault === "supabase" || envDefault === "sheets") {
    _cachedControlPlaneSource = envDefault;
    _cachedControlPlaneSourceAt = now;
    return envDefault;
  }

  // 3. Check Supabase system_config table
  try {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data } = await sb
        .from("system_config")
        .select("value")
        .eq("key", "control_plane_source")
        .maybeSingle();
      const mode = data?.value?.mode;
      if (mode === "supabase" || mode === "sheets") {
        _cachedControlPlaneSource = mode;
        _cachedControlPlaneSourceAt = now;
        if (redisClient?.isOpen) {
          await redisClient.set(CONTROL_PLANE_SOURCE_REDIS_KEY, mode).catch(() => {});
        }
        return mode;
      }
    }
  } catch (e) {
    // Table may not be migrated yet
  }

  _cachedControlPlaneSource = "sheets";
  _cachedControlPlaneSourceAt = now;
  return "sheets";
}

/**
 * Returns true when Supabase is configured AND the active Control Plane source is set to 'supabase'.
 */
export async function isSupabaseControlPlaneActive() {
  if (!isSupabaseConfigured()) return false;
  const source = await getControlPlaneSource();
  return source === "supabase";
}

/**
 * Sets the active Control Plane source ('sheets' | 'supabase') across memory, Redis, and Supabase.
 */
export async function setControlPlaneSource(mode, updatedBy = "Admin") {
  const cleanMode = mode === "supabase" ? "supabase" : "sheets";
  if (cleanMode === "supabase" && !isSupabaseConfigured()) {
    throw new Error("Cannot switch Control Plane source to Supabase until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are configured.");
  }

  _cachedControlPlaneSource = cleanMode;
  _cachedControlPlaneSourceAt = Date.now();

  if (redisClient?.isOpen) {
    await redisClient.set(CONTROL_PLANE_SOURCE_REDIS_KEY, cleanMode);
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    await sb.from("system_config").upsert({
      key: "control_plane_source",
      value: { mode: cleanMode, dualWriteSheets: true, updatedAt: new Date().toISOString() },
      description: "Active primary data source for Control Plane reads (sheets vs supabase)",
      updated_by: updatedBy,
    });
  }

  return cleanMode;
}

/**
 * Mandatory multi-tenant authorization wrapper for any tenant-scoped Supabase operation.
 * Verifies user session permissions before resolving the client record and executing the callback.
 */
export async function withTenantScope(sessionUser, clientName, callback) {
  if (!sessionUser) {
    const err = new Error("Unauthorized: Active session required.");
    err.status = 401;
    throw err;
  }
  const cleanClientName = String(clientName || "").trim();
  if (!cleanClientName) {
    const err = new Error("Missing client name for tenant-scoped database operation.");
    err.status = 400;
    throw err;
  }

  const { isUserAuthorizedForClient } = await import("./userPermissions.js");
  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, cleanClientName)) {
    const err = new Error("Forbidden: You do not have permission to access this client.");
    err.status = 403;
    throw err;
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    throw new Error("Supabase is not configured on this server.");
  }

  const normKey = normalizeClientKey(cleanClientName);
  const { data: clientRecord } = await sb
    .from("clients")
    .select("*")
    .eq("normalized_key", normKey)
    .maybeSingle();

  if (clientRecord?.id) {
    try {
      await sb.rpc("set_pulse_tenant_context", {
        p_client_id: clientRecord.id,
        p_user_email: String(sessionUser.email || ""),
        p_user_role: String(sessionUser.role || ""),
      });
    } catch (_) {
      // RPC optional if migration function hasn't been applied yet
    }
  }

  return callback(sb, clientRecord, normKey);
}
