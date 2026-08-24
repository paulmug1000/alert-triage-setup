/**
 * /api/cron.js
 * Background pre-computation endpoint for the Alert Triage System.
 *
 * Called by a Vercel cron trigger.
 * Re-written to use the unified 3-step alert pipeline.
 */

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify Vercel cron secret
  const authHeader = req.headers.authorization;
  const expectedSecret = `Bearer ${process.env.CRON_SECRET}`;
  const providedSecret = req.body?.secret || req.query?.secret || authHeader;

  if (providedSecret !== process.env.CRON_SECRET && providedSecret !== expectedSecret) {
    console.error("❌ Cron: invalid or missing secret");
    return res.status(401).json({ error: "Unauthorised" });
  }

  // Respond immediately so Vercel doesn't time out the cron trigger
  res.status(200).json({ success: true, message: "Cron job started" });

  // Run the pipeline in the background
  setImmediate(async () => {
    console.log(`\n🕐 CRON: Starting background triage pipeline`);
    
    try {
      const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL 
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` 
        : `https://${process.env.VERCEL_URL}`;
        
      const acId = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";

      // Step 1: Sweep
      console.log("CRON: Triggering Sweep...");
      await fetch(`${baseUrl}/api/triage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start_triage", step: "sweep", automationCommanderSheetId: acId }),
      });

      // Step 2: Build Options
      console.log("CRON: Triggering Build Options...");
      let hasMore = true;
      while (hasMore) {
        const buildResp = await fetch(`${baseUrl}/api/triage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start_triage", step: "build", automationCommanderSheetId: acId }),
        });
        const buildData = await buildResp.json();
        if (!buildResp.ok || !buildData.success) throw new Error(buildData.error || "Build options failed");
        hasMore = buildData.hasMore;
      }

      // Step 3: Store Precomputed
      console.log("CRON: Triggering Store...");
      const storeResp = await fetch(`${baseUrl}/api/triage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start_triage", step: "store", automationCommanderSheetId: acId }),
      });
      const storeData = await storeResp.json();
      if (!storeResp.ok || !storeData.success) throw new Error(storeData.error || "Store failed");

      console.log(`✅ CRON: Pipeline complete`);
    } catch (err) {
      console.error(`❌ CRON failed: ${err.message}`, err);
    }
  });
}