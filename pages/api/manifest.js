import { APP_MANIFEST } from "../../config/appManifest";
import { SYSTEM_VERSION, getSystemCopyright } from "../../config/version";
import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../services/authService";
import { isSysAdminUser } from "../../services/sheetTokenService";

/**
 * Authenticated Web App & Routes Manifest API Endpoint
 * GET /api/manifest
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  const rl = await checkRateLimit("api-manifest", sessionUser.email || getTrustedClientIp(req), 120, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please retry shortly." });
  }

  res.setHeader("Cache-Control", "private, no-store");

  if (isSysAdminUser(sessionUser)) {
    return res.status(200).json({
      success: true,
      version: SYSTEM_VERSION,
      copyright: getSystemCopyright(),
      manifest: APP_MANIFEST,
    });
  }

  const sanitizedPulseRoutes = (APP_MANIFEST?.areas?.pulse?.routes || []).map((r) => {
    const { chartToggleCell: _omitted, ...rest } = r;
    return rest;
  });

  return res.status(200).json({
    success: true,
    version: SYSTEM_VERSION,
    copyright: getSystemCopyright(),
    manifest: {
      name: APP_MANIFEST.name,
      shortName: APP_MANIFEST.shortName,
      version: APP_MANIFEST.version,
      areas: {
        pulse: {
          ...APP_MANIFEST.areas.pulse,
          routes: sanitizedPulseRoutes,
        },
      },
    },
  });
}
