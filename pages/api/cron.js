/**
 * /api/cron.js
 * Background pre-computation endpoint for the Alert Triage System.
 *
 * Called by a Vercel cron trigger.
 * Re-written to use the unified 3-step alert pipeline.
 */

import { waitUntil } from "@vercel/functions";
import { runBackgroundTriageRefresh } from "../../services/triageEngine";
import { safeCompareSecret } from "../../services/authService";

export const config = {
  maxDuration: 300,
};

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify Vercel cron secret
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    console.error("❌ Cron: CRON_SECRET is not configured on server");
    return res.status(500).json({ error: "Cron secret not configured on server" });
  }

  const authHeader = req.headers.authorization;
  const expectedBearer = `Bearer ${cronSecret}`;
  const providedSecret = String(req.body?.secret || req.query?.secret || authHeader || "").trim();

  if (!providedSecret || (!safeCompareSecret(providedSecret, cronSecret) && !safeCompareSecret(providedSecret, expectedBearer))) {
    console.error("❌ Cron: invalid or missing secret");
    return res.status(401).json({ error: "Unauthorised" });
  }

  // Respond immediately so Vercel doesn't time out the cron trigger
  res.status(200).json({ success: true, message: "Cron job started" });

  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${process.env.PORT || 3000}`;
  const protocol = req.headers["x-forwarded-proto"] || (host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https");
  const cleanUrl = (url) => url ? (url.startsWith("http") ? url : `https://${url}`) : null;
  const prodUrl = cleanUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) || cleanUrl(process.env.VERCEL_URL);
  const baseUrl = prodUrl || `${protocol}://${host}`;
  const acId = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";

  // Run the pipeline in the background using Vercel Pro waitUntil
  const backgroundTask = (async () => {
    console.log(`\n🕐 CRON: Starting background triage pipeline via runBackgroundTriageRefresh...`);
    try {
      await runBackgroundTriageRefresh({
        baseUrl,
        cronSecret,
        automationCommanderSheetId: acId,
        forceProactive: true,
      });

      // Auto-provision monthly Recon tabs if today is on or after 20th of the month
      const currentDay = new Date().getDate();
      if (currentDay >= 20) {
        console.log(`CRON: Today is ${currentDay}th (>= 20th) - Checking monthly Recon tabs auto-provisioning...`);
        try {
          const cronHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${cronSecret}`,
            "x-cron-secret": cronSecret,
          };
          await fetch(`${baseUrl}/api/triage`, {
            method: "POST", headers: cronHeaders,
            body: JSON.stringify({ action: "auto_provision_recon_tabs", secret: cronSecret, automationCommanderSheetId: acId }),
          });
        } catch (tabErr) {
          console.warn("⚠️ CRON: Non-fatal error in auto_provision_recon_tabs:", tabErr.message);
        }
      }

      console.log(`✅ CRON: Pipeline complete`);
    } catch (err) {
      console.error(`❌ CRON failed: ${err.message}`, err);
    }
  })();

  waitUntil(backgroundTask);
}