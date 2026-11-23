import { waitUntil } from "@vercel/functions";
import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import {
  verifyUserAuthorizedForSheet,
  unwrapSheetId,
  isReadOnlySession,
  getCanonicalAcSheetId,
} from "../../../services/userPermissions.js";
import { redisClient, ensureRedisConnected } from "../../../services/redisClient.js";
import { invalidatePmaClientCache } from "../../../services/cacheService.js";
import { resolveSupabaseSheetContext } from "../../../services/masterEngineService.js";
import { runNativeMasterSync } from "../../../services/masterSyncEngine.js";
import { getSupabaseAdmin } from "../../../services/supabaseClient.js";
import { getClientWebAppUrl } from "../../../services/workspaces.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";
import { assertClientPortalLive, getClientSetupConfig } from "../../../services/setupService.js";
import {
  assertTrustedOrigin,
  getCrmDisplayName,
  sanitizeSpreadsheetTerms,
  postGasWebAppLocked,
  isValidGoogleScriptUrl,
} from "../../../utils/helpers.js";

export const config = {
  maxDuration: 300,
};

const RUNNING_MAX_AGE_MS = 8 * 60 * 1000;
const COOLDOWN_SECONDS = 30;

function formatPortalSyncMessage_(rawMsg, displayCrm, isSysAdmin) {
  const msg = String(rawMsg || "").trim();
  if (!msg) return "";

  if (/starting automation run|starting crm sequence|contacting client/i.test(msg)) {
    return `Connecting to ${displayCrm}…`;
  }
  if (/downloading fresh opportunities/i.test(msg)) {
    return `Fetching latest deals from ${displayCrm}…`;
  }
  if (/reconciling pipeline/i.test(msg)) {
    return "Updating pipeline jobs…";
  }
  if (/reconciling confirmed/i.test(msg)) {
    return "Updating confirmed jobs…";
  }
  if (/instant 100%/i.test(msg)) {
    return "Promoting newly confirmed deals…";
  }
  if (/auditing invoice and expense gaps/i.test(msg)) {
    return "Updating billing and cost schedules…";
  }
  if (/crm updates applied/i.test(msg)) {
    return `Synced with ${displayCrm} — updates applied`;
  }
  if (/no changes required/i.test(msg)) {
    return `Up to date with ${displayCrm} — no new changes found`;
  }
  if (/all requested sequences complete/i.test(msg)) {
    return `Synced with ${displayCrm}`;
  }
  if (/in progress/i.test(msg)) {
    return `Syncing with ${displayCrm}…`;
  }

  if (isSysAdmin) return msg;

  return sanitizeSpreadsheetTerms(msg)
    .replace(/\b(?:Google Apps Script|GAS|Master|Client)\s+Web\s*App\b/gi, "sync service")
    .replace(/\bWeb\s*App\b/gi, "sync service")
    .replace(/\bGAS\b/g, "sync service");
}

async function invalidatePortalClientCaches_(cleanClientSheetId, rawClientSheetId, masterSheetId) {
  await invalidatePmaClientCache(
    cleanClientSheetId,
    masterSheetId || null,
    ["jobs", "invoices", "outgoings", "retainers", "cash", "views"]
  ).catch(() => {});

  if (redisClient?.isOpen) {
    const keys = [
      `pulse:portal:payload:${cleanClientSheetId}`,
      `pulse:portal:performance:${cleanClientSheetId}`,
      `pulse:portal:cash:${cleanClientSheetId}`,
    ];
    if (rawClientSheetId && rawClientSheetId !== cleanClientSheetId) {
      keys.push(
        `pulse:portal:payload:${rawClientSheetId}`,
        `pulse:portal:performance:${rawClientSheetId}`,
        `pulse:portal:cash:${rawClientSheetId}`
      );
    }
    await redisClient.del(keys).catch(() => {});
  }
}

async function getScheduledInFlightStartMs_(clientName) {
  try {
    const sb = getSupabaseAdmin();
    if (!sb || !clientName) return null;
    const { data } = await sb
      .from("sync_schedules")
      .select("flags")
      .eq("client_name", clientName)
      .maybeSingle();
    const inFlightSince = data?.flags?.in_flight_since;
    if (!inFlightSince) return null;
    const ms = new Date(inFlightSince).getTime();
    if (Number.isNaN(ms)) return null;
    if (Date.now() - ms < 310_000) return ms;
    return null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const {
    action = "status",
    clientSheetId: rawClientSheetId,
    clientName,
    runId: requestedRunId,
    crmTool,
  } = req.body || {};

  const unwrapped = unwrapSheetId(
    extractSheetIdFromUrl(rawClientSheetId) || String(rawClientSheetId || "").trim()
  );
  if (!unwrapped || unwrapped === "__INVALID_WS_TOKEN__") {
    return res.status(400).json({ success: false, error: "Valid clientSheetId is required" });
  }

  const sheets = await getSheetsClient();
  const auth = await verifyUserAuthorizedForSheet(sessionUser, unwrapped, clientName, sheets);
  if (!auth.authorized) {
    return res.status(auth.status || 403).json({ success: false, error: auth.error });
  }

  const verifiedClientName = auth.clientName;
  const liveGate = await assertClientPortalLive(sessionUser, verifiedClientName, res);
  if (!liveGate.allowed) return;
  const isSysAdmin = Boolean(!sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin"));
  const setupCfg = await getClientSetupConfig({ clientName: verifiedClientName }).catch(() => null);
  let displayCrm = getCrmDisplayName(setupCfg?.crmTool);

  await ensureRedisConnected(500).catch(() => {});

  const activeKey = `active_agent_run:${verifiedClientName}`;

  if (action === "status") {
    const rlStatus = await checkRateLimit("portal-sync-crm-status", sessionUser.email || getTrustedClientIp(req), 120, 60);
    if (!rlStatus.allowed) {
      return res.status(429).json({
        success: false,
        error: "Too many status requests. Please wait a moment and try again.",
      });
    }
    try {
      const cleanReqRunId = String(requestedRunId || "").trim();

      if (cleanReqRunId === "scheduled") {
        const inFlightMs = await getScheduledInFlightStartMs_(verifiedClientName);
        if (inFlightMs) {
          return res.status(200).json({
            success: true,
            running: true,
            done: false,
            status: "running",
            runId: "scheduled",
            startedAt: inFlightMs,
            stageMessage: `Syncing with ${displayCrm}…`,
            summaryMessage: "",
            error: null,
          });
        }
        return res.status(200).json({
          success: true,
          running: false,
          done: true,
          status: "completed",
          runId: "scheduled",
          startedAt: null,
          stageMessage: `Synced with ${displayCrm}`,
          summaryMessage: `Synced with ${displayCrm}`,
          error: null,
        });
      }

      let activeRun = null;
      if (redisClient?.isOpen) {
        const rawActive = await redisClient.get(activeKey).catch(() => null);
        if (rawActive) {
          try {
            activeRun = JSON.parse(rawActive);
          } catch {
            activeRun = null;
          }
        }
      }

      const activeIsFreshRunning = Boolean(
        activeRun &&
          activeRun.status === "running" &&
          activeRun.startedAt &&
          Date.now() - Number(activeRun.startedAt) < RUNNING_MAX_AGE_MS
      );

      // If polling a specific runId or an active running run exists, inspect progress entries
      const targetRunId = cleanReqRunId || (activeIsFreshRunning ? activeRun.runId : "");
      if (targetRunId && redisClient?.isOpen) {
        const progressRaw = await redisClient.get(`agent_run:${verifiedClientName}:${targetRunId}`).catch(() => null);
        const progressData = progressRaw ? JSON.parse(progressRaw) : null;
        const entries = Array.isArray(progressData?.entries) ? progressData.entries : [];
        const latestEntry = entries.length > 0 ? entries[entries.length - 1] : null;
        const latestMsg = formatPortalSyncMessage_(latestEntry?.message || "", displayCrm, isSysAdmin);

        const matchesActive = activeRun && activeRun.runId === targetRunId;
        const isError =
          latestEntry?.stage === "error" ||
          (matchesActive && activeRun.status === "error");
        const isDone = Boolean(
          progressData?.done ||
            (matchesActive && (activeRun.status === "completed" || activeRun.status === "error"))
        );

        if (isDone) {
          const errorText = isError
            ? formatPortalSyncMessage_(
                (matchesActive && activeRun.error) || latestEntry?.message || `Could not complete ${displayCrm} sync.`,
                displayCrm,
                isSysAdmin
              )
            : null;
          return res.status(200).json({
            success: true,
            running: false,
            done: true,
            status: isError ? "error" : "completed",
            runId: targetRunId,
            startedAt: activeRun?.startedAt || null,
            stageMessage: latestMsg || `Synced with ${displayCrm}`,
            summaryMessage: isError ? "" : latestMsg || `Synced with ${displayCrm}`,
            error: errorText,
          });
        }

        if (activeIsFreshRunning || (progressData && !progressData.done)) {
          return res.status(200).json({
            success: true,
            running: true,
            done: false,
            status: "running",
            runId: targetRunId,
            startedAt: activeRun?.startedAt || Date.now(),
            stageMessage: latestMsg || `Syncing with ${displayCrm}…`,
            summaryMessage: "",
            error: null,
          });
        }
      }

      // Fallback: detect an active scheduled CRM sync from Supabase
      const inFlightMs = await getScheduledInFlightStartMs_(verifiedClientName);
      if (inFlightMs) {
        return res.status(200).json({
          success: true,
          running: true,
          done: false,
          status: "running",
          runId: "scheduled",
          startedAt: inFlightMs,
          stageMessage: `Syncing with ${displayCrm}…`,
          summaryMessage: "",
          error: null,
        });
      }

      return res.status(200).json({
        success: true,
        running: false,
        done: false,
        status: "idle",
        runId: null,
        startedAt: null,
        stageMessage: "",
        summaryMessage: "",
        error: null,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: isSysAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Could not check sync status."),
      });
    }
  }

  if (action === "start") {
    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({
        success: false,
        error: "Pulse is read-only when logged in with a one-time password.",
      });
    }

    const rl = await checkRateLimit("portal-sync-crm", getTrustedClientIp(req), 20, 60);
    if (!rl.allowed) {
      return res.status(429).json({
        success: false,
        error: "Too many sync requests. Please wait a moment and try again.",
      });
    }

    try {
      // Attach if a run is already active in Redis
      if (redisClient?.isOpen) {
        const rawActive = await redisClient.get(activeKey).catch(() => null);
        if (rawActive) {
          try {
            const activeRun = JSON.parse(rawActive);
            if (
              activeRun?.status === "running" &&
              activeRun?.startedAt &&
              Date.now() - Number(activeRun.startedAt) < RUNNING_MAX_AGE_MS
            ) {
              return res.status(200).json({
                success: true,
                running: true,
                attached: true,
                runId: activeRun.runId,
                startedAt: activeRun.startedAt,
                stageMessage: `Syncing with ${displayCrm}…`,
              });
            }
          } catch { }
        }
      }

      // Attach if a scheduled sync is currently in-flight
      const inFlightMs = await getScheduledInFlightStartMs_(verifiedClientName);
      if (inFlightMs) {
        return res.status(200).json({
          success: true,
          running: true,
          attached: true,
          runId: "scheduled",
          startedAt: inFlightMs,
          stageMessage: `Syncing with ${displayCrm}…`,
        });
      }

      // Enforce 30-second cooldown between manual portal triggers
      const cooldownKey = `pulse:portal:crm_sync_cooldown:${verifiedClientName}`;
      if (redisClient?.isOpen && !isSysAdmin) {
        const onCooldown = await redisClient.get(cooldownKey).catch(() => null);
        if (onCooldown) {
          return res.status(200).json({
            success: true,
            running: false,
            onCooldown: true,
            message: `Synced with ${displayCrm} moments ago — everything is up to date.`,
          });
        }
      }

      const supaCtx = await resolveSupabaseSheetContext({
        clientName: verifiedClientName,
        spreadsheetId: unwrapped,
      });

      const effectiveCrm = String(setupCfg?.crmTool || supaCtx?.crmTool || "None").trim();
      const effectiveDrives = String(setupCfg?.crmDrives || supaCtx?.crmDrives || "NA").trim();
      if (!effectiveCrm || effectiveCrm.toLowerCase() === "none" || effectiveDrives.toUpperCase() === "NA") {
        return res.status(400).json({
          success: false,
          error: "No active CRM integration is configured for this workspace.",
        });
      }
      displayCrm = getCrmDisplayName(effectiveCrm);

      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = Date.now();
      const progressKey = `agent_run:${verifiedClientName}:${runId}`;
      const liveEntries = [
        {
          stage: "init",
          message: "Starting CRM sequence...",
          at: new Date().toISOString(),
        },
      ];

      if (redisClient?.isOpen) {
        await Promise.all([
          redisClient.set(
            activeKey,
            JSON.stringify({
              runId,
              clientName: verifiedClientName,
              types: ["crm"],
              startedAt,
              status: "running",
            }),
            { EX: 1800 }
          ),
          redisClient.set(progressKey, JSON.stringify({ entries: liveEntries, done: false }), { EX: 1800 }),
          redisClient.set(cooldownKey, "1", { EX: COOLDOWN_SECONDS }),
        ]).catch(() => {});
      }

      const userLabel = sessionUser.email || sessionUser.name || "Portal User";

      if (supaCtx && supaCtx.masterMode === "supabase") {
        const nativeTask = (async () => {
          try {
            await runNativeMasterSync({
              sheets,
              clientName: verifiedClientName,
              syncType: "crm",
              types: ["crm"],
              runId,
              onProgress: async (prog) => {
                if (!prog || !prog.message) return;
                liveEntries.push({
                  stage: prog.stage || "info",
                  message: prog.message,
                  at: new Date().toISOString(),
                });
                if (redisClient?.isOpen) {
                  await redisClient
                    .set(
                      progressKey,
                      JSON.stringify({ entries: liveEntries, done: Boolean(prog.done) }),
                      { EX: 1800 }
                    )
                    .catch(() => {});
                }
              },
              userEmail: userLabel,
            });

            await invalidatePortalClientCaches_(unwrapped, rawClientSheetId, supaCtx.masterSheetId);

            const lastMsg = liveEntries[liveEntries.length - 1]?.message || "";
            if (!lastMsg || /starting crm sequence/i.test(lastMsg)) {
              liveEntries.push({
                stage: "done",
                message: `Synced with ${displayCrm}`,
                at: new Date().toISOString(),
              });
            }

            if (redisClient?.isOpen) {
              await Promise.all([
                redisClient.set(progressKey, JSON.stringify({ entries: liveEntries, done: true }), { EX: 1800 }),
                redisClient.set(
                  activeKey,
                  JSON.stringify({
                    runId,
                    clientName: verifiedClientName,
                    status: "completed",
                    done: true,
                    completedAt: Date.now(),
                  }),
                  { EX: 600 }
                ),
              ]).catch(() => {});
            }
          } catch (err) {
            if (redisClient?.isOpen) {
              await Promise.all([
                redisClient.set(
                  progressKey,
                  JSON.stringify({
                    entries: [{ stage: "error", message: err.message, at: new Date().toISOString() }],
                    done: true,
                  }),
                  { EX: 1800 }
                ),
                redisClient.set(
                  activeKey,
                  JSON.stringify({
                    runId,
                    clientName: verifiedClientName,
                    status: "error",
                    error: err.message,
                    completedAt: Date.now(),
                  }),
                  { EX: 600 }
                ),
              ]).catch(() => {});
            }
          }
        })();

        waitUntil(nativeTask);
      } else {
        const acSheetId = getCanonicalAcSheetId();
        const webAppUrl = await getClientWebAppUrl(sheets, verifiedClientName, acSheetId);
        const rawSecret = process.env.CRON_SECRET || process.env.AGENT_TRIGGER_SECRET || "";
        const agentSecret = String(rawSecret).replace(/^["']|["']$/g, "").trim();

        if (!webAppUrl || !isValidGoogleScriptUrl(webAppUrl) || !agentSecret) {
          if (redisClient?.isOpen) {
            await redisClient.del(activeKey).catch(() => {});
          }
          return res.status(400).json({
            success: false,
            error: `CRM sync is not configured for ${verifiedClientName}.`,
          });
        }

        const gasTask = (async () => {
          const startTime = Date.now();
          try {
            const gasResp = await postGasWebAppLocked(webAppUrl, {
              secret: agentSecret,
              types: ["crm"],
              clientName: verifiedClientName,
              runId,
            });
            const gasData = await gasResp.json().catch(() => null);
            await invalidatePortalClientCaches_(unwrapped, rawClientSheetId, supaCtx?.masterSheetId);

            if (gasData && gasData.success === false) {
              const errMsg = gasData?.error || `Could not complete ${displayCrm} sync.`;
              if (redisClient?.isOpen) {
                const raw = await redisClient.get(progressKey).catch(() => null);
                const existing = raw ? JSON.parse(raw) : { entries: [], done: false };
                existing.entries.push({ stage: "error", message: errMsg, at: new Date().toISOString() });
                existing.done = true;
                await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 }).catch(() => {});
                await redisClient
                  .set(
                    activeKey,
                    JSON.stringify({
                      runId,
                      clientName: verifiedClientName,
                      status: "error",
                      error: errMsg,
                      completedAt: Date.now(),
                    }),
                    { EX: 600 }
                  )
                  .catch(() => {});
              }
            } else if (gasData && gasData.success && redisClient?.isOpen) {
              const raw = await redisClient.get(progressKey).catch(() => null);
              const existing = raw ? JSON.parse(raw) : { entries: [], done: false };
              if (!existing.done) {
                existing.done = true;
                await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 }).catch(() => {});
                await redisClient
                  .set(
                    activeKey,
                    JSON.stringify({
                      runId,
                      clientName: verifiedClientName,
                      status: "completed",
                      done: true,
                      completedAt: Date.now(),
                    }),
                    { EX: 600 }
                  )
                  .catch(() => {});
              }
            }
          } catch (fetchErr) {
            const elapsedMs = Date.now() - startTime;
            if (redisClient?.isOpen) {
              const raw = await redisClient.get(progressKey).catch(() => null);
              const existing = raw ? JSON.parse(raw) : { entries: [], done: false };
              if (elapsedMs >= 5000 && !existing.done) {
                existing.entries.push({
                  stage: "info",
                  message: `Syncing with ${displayCrm}…`,
                  at: new Date().toISOString(),
                });
                await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 }).catch(() => {});
              } else if (!existing.done) {
                existing.entries.push({ stage: "error", message: fetchErr.message, at: new Date().toISOString() });
                existing.done = true;
                await redisClient.set(progressKey, JSON.stringify(existing), { EX: 1800 }).catch(() => {});
                await redisClient
                  .set(
                    activeKey,
                    JSON.stringify({
                      runId,
                      clientName: verifiedClientName,
                      status: "error",
                      error: fetchErr.message,
                      completedAt: Date.now(),
                    }),
                    { EX: 600 }
                  )
                  .catch(() => {});
              }
            }
          }
        })();

        waitUntil(gasTask);
      }

      logPulseActivity(sheets, {
        clientName: verifiedClientName,
        category: "SYNC",
        action: "PORTAL_CRM_SYNC",
        summary: `Triggered manual ${displayCrm} sync from Pulse Portal`,
        user: sessionUser.name || sessionUser.email,
      }).catch(() => {});

      return res.status(200).json({
        success: true,
        running: true,
        runId,
        startedAt,
        stageMessage: `Connecting to ${displayCrm}…`,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: isSysAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Could not start CRM sync."),
      });
    }
  }

  return res.status(400).json({ success: false, error: `Unsupported action: ${action}` });
}
