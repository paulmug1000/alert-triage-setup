import { resolveLiveSessionUser } from "../../../services/authService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, unwrapSheetId } from "../../../services/userPermissions.js";
import { resolvePortalCache } from "../../../services/cacheService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms, redactPortalPerformanceForUser } from "../../../utils/helpers.js";
import {
  fetchAndBuildPortalHomeAndPerformance,
  PORTAL_L1_TTL_SECS,
  PORTAL_REDIS_TTL_SECS,
} from "../../../services/portalDataService.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (req.method === "POST" && !assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const rawClientSheetId = String(req.query.clientSheetId || req.body?.clientSheetId || "").trim();
  const clientName = String(req.query.clientName || req.body?.clientName || "").trim();
  const bypassCache = req.query.bypassCache === "true" || req.body?.bypassCache === true;
  const isAutoRefresh = req.query.autoRefresh === "true" || req.body?.autoRefresh === true;

  if (!rawClientSheetId) {
    return res.status(400).json({ success: false, error: "clientSheetId is required" });
  }

  const cleanClientId = unwrapSheetId(extractSheetIdFromUrl(rawClientSheetId) || rawClientSheetId);
  if (!cleanClientId || cleanClientId === "__INVALID_WS_TOKEN__") {
    return res.status(400).json({ success: false, error: "Invalid clientSheetId" });
  }

  const sheets = await getSheetsClient();

  // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
  const auth = await verifyUserAuthorizedForSheet(sessionUser, cleanClientId, clientName, sheets);
  if (!auth.authorized) {
    return res.status(auth.status || 403).json({ success: false, error: auth.error });
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  const cacheKey = `pulse:portal:performance:${cleanClientId}`;

  try {
    const result = await resolvePortalCache({
      cacheKey,
      bypassCache,
      isAutoRefresh,
      isReadOnly: Boolean(sessionUser.isReadOnly),
      l1TtlSecs: PORTAL_L1_TTL_SECS,
      redisTtlSecs: PORTAL_REDIS_TTL_SECS,
      isValidPayload: (p) => p && Array.isArray(p.years),
      fetchFreshFn: async () => {
        const built = await fetchAndBuildPortalHomeAndPerformance(
          sheets,
          cleanClientId,
          auth.clientName || clientName,
          { saveToCache: true }
        );
        return built.performanceData;
      },
    });

    const safePerfData = redactPortalPerformanceForUser(result.data, sessionUser);

    return res.status(200).json({
      success: true,
      fromCache: result.fromCache,
      fromMemory: result.fromMemory,
      fromRedis: result.fromRedis,
      staleRevalidating: result.staleRevalidating,
      data: safePerfData,
      cachedAt: result.cachedAt,
    });
  } catch (err) {
    console.error("❌ /api/portal/performance error:", err);
    return res.status(500).json({ success: false, error: sessionUser?.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
  }
}
