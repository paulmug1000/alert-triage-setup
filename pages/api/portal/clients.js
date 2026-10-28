import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { getCanonicalAcSheetId, matchesClientName, isPulseOnlyUser } from "../../../services/userPermissions.js";
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

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

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
    if (!sessionUser.isAdmin && sessionUser.assignedClients !== "*") {
      const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      authorizedClients = allClients.filter((c) =>
        assignedList.some((assigned) => matchesClientName(assigned, c.clientName))
      );
    }

    authorizedClients.sort((a, b) => a.clientName.localeCompare(b.clientName));

    // Attach lightweight setupMode boolean from Redis so the Portal never blocks on a separate /api/setup/status spinner
    let setupModes = [];
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
      } catch (_) {}
    }

    const hideMasterId = isPulseOnlyUser(sessionUser);
    const safeClients = authorizedClients.map((c, idx) => {
      const setupMode = Boolean(setupModes[idx]);
      return hideMasterId
        ? { clientName: c.clientName, clientSheetId: c.clientSheetId, setupMode }
        : { ...c, setupMode };
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
