import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { getCanonicalAcSheetId, matchesClientName, isPulseOnlyUser, installSheetIdBoundary } from "../../../services/userPermissions.js";
import { getClientSetupStatusForPortal } from "../../../services/setupService.js";
import { getSupabaseAdmin, isSupabaseControlPlaneActive } from "../../../services/supabaseClient.js";
import { memoryCache } from "../../../services/cacheService.js";
import { redisClient } from "../../../services/redisClient.js";

function extractSheetIdFromUrl(url) {
  if (!url) return "";
  const match = String(url).match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(String(url).trim())) return String(url).trim();
  return "";
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const sessionUser = getSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }
  installSheetIdBoundary(req, res, sessionUser);

  try {
    const acId = getCanonicalAcSheetId();
    const bypassCache = req.query.bypassCache === "true" || req.body?.bypassCache === true;
    const cacheKey = `pulse:portal:allClients:${acId}`;

    let allClients = !bypassCache ? memoryCache.get(cacheKey) : null;
    if (!allClients && !bypassCache && redisClient?.isOpen) {
      try {
        const rawCached = await redisClient.get(cacheKey);
        if (rawCached) {
          allClients = JSON.parse(rawCached);
          memoryCache.set(cacheKey, allClients, 300);
        }
      } catch (_) {}
    }

    if (!allClients && (await isSupabaseControlPlaneActive())) {
      try {
        const sb = getSupabaseAdmin();
        if (sb) {
          const { data: dbClients, error: sbErr } = await sb
            .from("clients")
            .select("client_name, status, metadata, client_sheet_id, master_sheet_id, client_sheet_url, master_sheet_url, client_mode, master_mode")
            .order("client_name", { ascending: true });
          if (!sbErr && Array.isArray(dbClients) && dbClients.length > 0) {
            allClients = [];
            for (const c of dbClients) {
              const effectiveStatus = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
              if (["inactive", "archived", "suspended"].includes(effectiveStatus)) continue;
              const clientName = String(c.client_name || "").trim();
              const clientSheetId = extractSheetIdFromUrl(c.client_sheet_url || c.client_sheet_id) || String(c.client_sheet_id || "").trim();
              const masterSheetId = extractSheetIdFromUrl(c.master_sheet_url || c.master_sheet_id) || String(c.master_sheet_id || "").trim();
              if (!clientName) continue;
              if (!clientSheetId && !masterSheetId && c.client_mode !== "supabase" && c.master_mode !== "supabase") continue;
              allClients.push({
                clientName,
                clientSheetId,
                masterSheetId,
              });
            }
            memoryCache.set(cacheKey, allClients, 300);
            if (redisClient?.isOpen) {
              redisClient.set(cacheKey, JSON.stringify(allClients), { EX: 300 }).catch(() => {});
            }
          }
        }
      } catch (sbLoadErr) {
        console.warn("⚠️ Portal clients Supabase load fallback to sheet:", sbLoadErr.message);
      }
    }

    if (!allClients) {
      const sheets = await getSheetsClient();
      const resp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: acId,
          range: "AutoUpdates!A2:N500",
        })
      );

      const rows = resp.data.values || [];
      allClients = [];

      for (const row of rows) {
        const clientName = String(row[0] || "").trim();
        const clientSheetUrl = row[11];
        const masterSheetUrl = row[12];

        if (!clientName || !clientSheetUrl) continue;
        if (clientName.toLowerCase() === "client" || clientName.toLowerCase() === "client name") continue;

        const clientSheetId = extractSheetIdFromUrl(clientSheetUrl);
        const masterSheetId = extractSheetIdFromUrl(masterSheetUrl);

        if (!clientSheetId && !masterSheetId) continue;

        allClients.push({
          clientName,
          clientSheetId,
          masterSheetId,
        });
      }

      memoryCache.set(cacheKey, allClients, 300); // Cache in memory for 5 minutes
      if (redisClient?.isOpen) {
        redisClient.set(cacheKey, JSON.stringify(allClients), { EX: 300 }).catch(() => {});
      }
    }

    // Role-based scoping:
    // Only Admin can see ALL clients.
    // ClientManager and ClientUser only see their assigned clients.
    let authorizedClients = allClients;
    if (!sessionUser.isAdmin) {
      const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      authorizedClients = allClients.filter((c) =>
        assignedList.some((assigned) => matchesClientName(assigned, c.clientName))
      );
    }

    authorizedClients.sort((a, b) => a.clientName.localeCompare(b.clientName));

    // Attach lightweight setupMode boolean (and full setupStatus for setupMode clients) so the Portal never flashes a skeleton before SetupHoldingGate
    let setupModes = [];
    let setupStatuses = [];
    if (redisClient?.isOpen && authorizedClients.length > 0) {
      try {
        const keys = authorizedClients.map(
          (c) => `pulse:setup:${String(c.clientName || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`
        );
        const rawList = await redisClient.mGet(keys);
        setupModes = rawList.map((raw) => {
          if (!raw) return false;
          try {
            return Boolean(JSON.parse(raw)?.setupMode);
          } catch {
            return false;
          }
        });
        setupStatuses = await Promise.all(
          authorizedClients.map(async (c, idx) => {
            if (!setupModes[idx]) return null;
            try {
              return await getClientSetupStatusForPortal({
                clientName: c.clientName,
                masterSheetId: c.masterSheetId
              });
            } catch {
              return null;
            }
          })
        );
      } catch (_) {}
    }

    const hideMasterId = isPulseOnlyUser(sessionUser);
    const safeClients = authorizedClients.map((c, idx) => {
      const setupMode = Boolean(setupModes[idx]);
      const setupStatus = setupStatuses[idx] || null;
      return hideMasterId
        ? { clientName: c.clientName, clientSheetId: c.clientSheetId, setupMode, ...(setupStatus ? { setupStatus } : {}) }
        : { ...c, setupMode, ...(setupStatus ? { setupStatus } : {}) };
    });

    return res.status(200).json({
      success: true,
      user: {
        email: sessionUser.email,
        name: sessionUser.name,
        role: sessionUser.role,
        isAdmin: sessionUser.isAdmin,
      },
      clients: safeClients,
    });
  } catch (err) {
    console.error("❌ /api/portal/clients error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
