import { APP_MANIFEST } from "../../config/appManifest";
import { SYSTEM_VERSION, getSystemCopyright } from "../../config/version";

/**
 * Public Web App & Routes Manifest API Endpoint
 * GET /api/manifest
 * Returns the comprehensive registry of all routes, query parameters, views,
 * and capabilities across both Pulse and PMA.
 */
export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).json({
    success: true,
    version: SYSTEM_VERSION,
    copyright: getSystemCopyright(),
    manifest: APP_MANIFEST,
  });
}
