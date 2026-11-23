import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, unwrapSheetId } from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { resolvePortalCache } from "../../../services/cacheService.js";
import {
  assertTrustedOrigin,
  sanitizeSpreadsheetTerms,
  redactPortalPayloadForUser,
  redactPortalPerformanceForUser,
} from "../../../utils/helpers.js";
import {
  fetchAndBuildPortalHomeAndPerformance,
  getCachedPortalHomeAndPerformance,
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

  const rl = await checkRateLimit("portal-payload", sessionUser.email || getTrustedClientIp(req), 120, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
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
  const liveGate = await assertClientPortalLive(sessionUser, auth.clientName || clientName, res);
  if (!liveGate.allowed) return;

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  const cacheKey = `pulse:portal:payload:${cleanClientId}`;
  let bundledPerformanceData = null;

  try {
    const result = await resolvePortalCache({
      cacheKey,
      bypassCache,
      isAutoRefresh,
      isReadOnly: Boolean(sessionUser.isReadOnly),
      l1TtlSecs: PORTAL_L1_TTL_SECS,
      redisTtlSecs: PORTAL_REDIS_TTL_SECS,
      isValidPayload: (p) => p && (p.hasBudget !== undefined || p.clientInfo?.hasBudget !== undefined),
      fetchFreshFn: async () => {
        const built = await fetchAndBuildPortalHomeAndPerformance(
          sheets,
          cleanClientId,
          auth.clientName || clientName,
          { saveToCache: true }
        );
        bundledPerformanceData = built.performanceData;
        return built.payload;
      },
    });

    // If payload came from cache, also attach cached performanceData so the Home Page renders in 1 round-trip
    if (!bundledPerformanceData) {
      const cachedPerf = await getCachedPortalHomeAndPerformance(cleanClientId, { perfOnly: true });
      if (cachedPerf?.performanceData) {
        bundledPerformanceData = cachedPerf.performanceData;
      }
    }

    const safePayload = redactPortalPayloadForUser(result.data, sessionUser);
    const safePerformanceData = bundledPerformanceData
      ? redactPortalPerformanceForUser(bundledPerformanceData, sessionUser)
      : null;

    return res.status(200).json({
      success: true,
      fromCache: result.fromCache,
      fromMemory: result.fromMemory,
      fromRedis: result.fromRedis,
      staleRevalidating: result.staleRevalidating,
      payload: safePayload,
      ...(safePerformanceData ? { performanceData: safePerformanceData } : {}),
      cachedAt: result.cachedAt,
    });
  } catch (err) {
    console.error("❌ /api/portal/payload error:", err);
    return res.status(500).json({ success: false, error: sessionUser?.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
  }
}
