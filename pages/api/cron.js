/**
 * /api/cron.js
 * Background pre-computation endpoint for the Alert Triage System.
 *
 * Called by a Vercel cron trigger.
 * Re-written to use the unified 3-step alert pipeline.
 */

import { waitUntil } from "@vercel/functions";
import { runBackgroundTriageRefresh, getTriageRefreshStatus } from "../../services/triageEngine";
import { safeCompareSecret } from "../../services/authService";
import { getSupabaseAdmin } from "../../services/supabaseClient";
import { redisClient } from "../../services/redisClient";
import { getCanonicalAcSheetId } from "../../services/userPermissions";
import { runDailyAutoBackupSweep } from "../../services/supabaseBackupService";
import { dispatchDueNativeMasterSyncs } from "../../services/masterSyncEngine";

export const config = {
  maxDuration: 300,
};

const ACTIVITY_CRON_LAST_KEY = "pulse:activity_feed:last_cron_refresh";

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify cron secret
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    console.error("❌ Cron: CRON_SECRET is not configured on server");
    return res.status(500).json({ error: "Cron secret not configured on server" });
  }

  const authHeader = String(req.headers.authorization || "").trim();
  const headerSecret = String(req.headers["x-cron-secret"] || "").trim();
  const expectedBearer = `Bearer ${cronSecret}`;
  const providedSecret = String(req.body?.secret || req.query?.secret || headerSecret || authHeader || "").trim();

  if (
    !providedSecret ||
    (!safeCompareSecret(providedSecret, cronSecret) &&
      !safeCompareSecret(providedSecret, expectedBearer) &&
      (!headerSecret || !safeCompareSecret(headerSecret, cronSecret)))
  ) {
    console.error("❌ Cron: invalid or missing secret");
    return res.status(401).json({ error: "Unauthorised" });
  }

  const currentStatus = await getTriageRefreshStatus().catch(() => null);
  if (currentStatus && currentStatus.status === "running") {
    console.log("⏭️ CRON: Triage refresh is already running; skipping overlapping tick.");
    return res.status(200).json({
      success: true,
      alreadyRunning: true,
      message: "Triage pipeline is already running.",
      status: currentStatus,
    });
  }

  const forceProactive = Boolean(req.body?.forceProactive === true || req.query?.forceProactive === "true");
  const forceAll = Boolean(req.body?.forceAll === true || req.query?.forceAll === "true");
  const triggerSource = String(req.body?.source || req.query?.source || "cron").trim();
  const bypassToken = String(
    req.headers["x-vercel-protection-bypass"] ||
    process.env.VERCEL_BYPASS_TOKEN ||
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET ||
    ""
  ).trim();

  // Respond immediately so pg_net / cron never times out
  res.status(200).json({
    success: true,
    message: "Cron job started",
    source: triggerSource,
    forceProactive,
    forceAll,
  });

  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${process.env.PORT || 3000}`;
  const protocol = req.headers["x-forwarded-proto"] || (host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https");
  const cleanUrl = (url) => (url ? (url.startsWith("http") ? url : `https://${url}`) : null);
  const prodUrl = cleanUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) || cleanUrl(process.env.VERCEL_URL);
  const baseUrl = prodUrl || `${protocol}://${host}`;
  const acId = getCanonicalAcSheetId() || "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";

  // Run the pipeline in the background using Vercel Pro waitUntil
  const backgroundTask = (async () => {
    console.log(`\n🕐 CRON (${triggerSource}): Starting background triage pipeline via runBackgroundTriageRefresh...`);
    try {
      // Record webhook reception in Supabase system_config if configured
      try {
        const sb = getSupabaseAdmin();
        if (sb) {
          const { data: cfgRow } = await sb
            .from("system_config")
            .select("*")
            .eq("key", "supabase_cron_clock")
            .maybeSingle();
          if (cfgRow) {
            await sb.from("system_config").upsert({
              key: "supabase_cron_clock",
              value: {
                ...(cfgRow.value || {}),
                lastWebhookReceivedAt: new Date().toISOString(),
                lastWebhookSource: triggerSource,
              },
              description: cfgRow.description || "Supabase pg_cron 30-minute wake-up clock configuration and telemetry",
              updated_by: "System (Cron)",
            });
          }
        }
      } catch (_) { }

      try {
        console.log("CRON: Checking and dispatching due native master syncs across all tenants...");
        const syncDispatchRes = await dispatchDueNativeMasterSyncs({
          baseUrl,
          cronSecret,
          bypassToken,
          maxConcurrency: 4,
        });
        console.log(`CRON: Completed dispatch of ${syncDispatchRes.dispatched} native sync sequence(s).`);
      } catch (syncErr) {
        console.warn("⚠️ CRON: Error in dispatchDueNativeMasterSyncs:", syncErr.message);
      }

      await runBackgroundTriageRefresh({
        baseUrl,
        cronSecret,
        automationCommanderSheetId: acId,
        forceProactive,
        forceAll,
        bypassToken,
        chain: true,
      });

      const cronHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cronSecret}`,
        "x-cron-secret": cronSecret,
        ...(bypassToken ? { "x-vercel-protection-bypass": bypassToken } : {}),
      };

      // Refresh 30-day Activity Feed cache approximately once per hour
      try {
        if (!redisClient?.isOpen) await redisClient.connect().catch(() => { });
        const lastActRefresh = redisClient?.isOpen ? await redisClient.get(ACTIVITY_CRON_LAST_KEY).catch(() => null) : null;
        if (!lastActRefresh) {
          if (redisClient?.isOpen) {
            await redisClient.set(ACTIVITY_CRON_LAST_KEY, new Date().toISOString(), { EX: 3000 }).catch(() => { });
          }
          console.log("CRON: Refreshing hourly 30-day activity feed cache...");
          await fetch(`${baseUrl}/api/triage`, {
            method: "POST",
            headers: cronHeaders,
            body: JSON.stringify({
              action: "get_activity",
              forceRefresh: true,
              includeRoutine: false,
              automationCommanderSheetId: acId,
              secret: cronSecret,
            }),
          });
        }
      } catch (actErr) {
        console.warn("⚠️ CRON: Non-fatal error refreshing activity feed:", actErr.message);
      }

      // Auto-provision monthly Recon tabs if today is on or after 20th of the month
      const currentDay = new Date().getDate();
      if (currentDay >= 20) {
        console.log(`CRON: Today is ${currentDay}th (>= 20th) - Checking monthly Recon tabs auto-provisioning...`);
        try {
          await fetch(`${baseUrl}/api/triage`, {
            method: "POST",
            headers: cronHeaders,
            body: JSON.stringify({ action: "auto_provision_recon_tabs", secret: cronSecret, automationCommanderSheetId: acId }),
          });
        } catch (tabErr) {
          console.warn("⚠️ CRON: Non-fatal error in auto_provision_recon_tabs:", tabErr.message);
        }
      }

      // Run automated daily Supabase workbook snapshot sweep (once per UK calendar day)
      try {
        const backupRes = await runDailyAutoBackupSweep({
          force: false,
          triggeredBy: `System (${triggerSource})`,
        });
        if (!backupRes?.skipped) {
          console.log(
            `📦 CRON: Completed daily Supabase backup sweep (${backupRes.snapshotsCreated} created, ${backupRes.expiredSnapshotsPruned} expired pruned)`
          );
        }
      } catch (bkErr) {
        console.warn("⚠️ CRON: Non-fatal error in daily Supabase backup sweep:", bkErr.message);
      }

      console.log(`✅ CRON: Pipeline complete`);
    } catch (err) {
      console.error(`❌ CRON failed: ${err.message}`, err);
    }
  })();

  waitUntil(backgroundTask);
}