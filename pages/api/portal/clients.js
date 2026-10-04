import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { DEFAULT_AC_SHEET_ID, matchesClientName } from "../../../services/userPermissions.js";
import { memoryCache } from "../../../services/cacheService.js";

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
    const acId = req.query.automationCommanderSheetId || req.body?.automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
    const bypassCache = req.query.bypassCache === "true" || req.body?.bypassCache === true;
    const cacheKey = `pulse:portal:allClients:${acId}`;

    let allClients = !bypassCache ? memoryCache.get(cacheKey) : null;

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

    return res.status(200).json({
      success: true,
      user: {
        email: sessionUser.email,
        name: sessionUser.name,
        role: sessionUser.role,
        isAdmin: sessionUser.isAdmin,
      },
      clients: authorizedClients,
    });
  } catch (err) {
    console.error("❌ /api/portal/clients error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
