/**
 * ============================================================================
 * UNIFIED CRM PRE-PULL CHANGE DETECTION SERVICE (services/crmPreflightService.js)
 * ============================================================================
 * Performs lightweight, fail-open metadata & latest-timestamp fingerprinting
 * across all 8 CRM sources (Google Sheets, Microsoft Excel, HubSpot, Pipedrive,
 * Close, Capsule, ClickUp, and Monday.com) before spinning up full CRM syncs.
 */

import crypto from "crypto";
import { resolveBrokerTokenInProcess } from "./gasRuntime/gasEnvironment.js";
import { extractSheetIdFromUrl } from "./sheetsClient.js";
import { assertSafeGraphId } from "./excelIntegrationService.js";

const PREFLIGHT_TIMEOUT_MS = 8000;
const SPREADSHEET_QUIET_WINDOW_MS = 60 * 1000;
const MAX_SKIP_WINDOW_MS = 6 * 3600 * 1000;
const CONSECUTIVE_FAILURES_ALERT_THRESHOLD = 3;
const ALERT_DEDUP_WINDOW_MS = 24 * 3600 * 1000;

export function describePreflightFailureReason(reason, rawTool = "CRM") {
  const r = String(reason || "").trim();
  const tool = String(rawTool || "CRM").trim() || "CRM";

  if (r.startsWith("gsheet_drive_http_")) {
    const code = r.replace("gsheet_drive_http_", "");
    return `Google Drive metadata check returned HTTP ${code} (verify Google Drive API is enabled and sheet was linked via Picker)`;
  }
  if (r === "invalid_gsheet_id") {
    return "Configured Google Sheet URL/ID in KeyInfo!X11 could not be parsed";
  }
  if (r === "internal_gsheet_id") {
    return "Configured Google Sheet ID matches an internal Pulse workbook";
  }
  if (r === "missing_excel_config") {
    return "Missing Excel Drive ID, File ID, or worksheet name in KeyInfo!X36:X38";
  }
  if (r.startsWith("excel_graph_http_")) {
    const code = r.replace("excel_graph_http_", "");
    return `Microsoft Graph DriveItem metadata check returned HTTP ${code}`;
  }
  if (r.startsWith("hubspot_http_")) {
    return `HubSpot deals search preflight returned HTTP ${r.replace("hubspot_http_", "")}`;
  }
  if (r.startsWith("pipedrive_http_")) {
    return `Pipedrive deals preflight returned HTTP ${r.replace("pipedrive_http_", "")}`;
  }
  if (r.startsWith("close_http_")) {
    return `Close opportunities preflight returned HTTP ${r.replace("close_http_", "")}`;
  }
  if (r.startsWith("capsule_http_")) {
    return `Capsule opportunities preflight returned HTTP ${r.replace("capsule_http_", "")}`;
  }
  if (r === "clickup_multipage_view") {
    return "ClickUp view spans multiple pages (>100 tasks) without a List ID configured in KeyInfo!X16";
  }
  if (r.startsWith("clickup_list_http_") || r.startsWith("clickup_view_http_")) {
    const code = r.replace(/^clickup_(?:list|view)_http_/, "");
    return `ClickUp task preflight returned HTTP ${code}`;
  }
  if (r === "missing_clickup_ids") {
    return "Missing ClickUp List ID / View ID in KeyInfo!X16:X17";
  }
  if (r === "invalid_monday_board_id") {
    return "Missing or non-numeric Monday Board ID in KeyInfo!X24";
  }
  if (r === "monday_board_missing" || r.startsWith("monday_http_")) {
    return `Monday board metadata preflight failed (${r})`;
  }
  if (r.startsWith("token_unavailable_")) {
    const status = r.replace("token_unavailable_", "");
    return `OAuth token unavailable from Vault for ${tool} (status ${status})`;
  }
  if (r === "unsupported_crm_tool") {
    return `Unrecognized CRM tool "${tool}" in KeyInfo!Q8`;
  }
  return `${tool} preflight check failed (${r || "unknown"})`;
}

function cleanCell_(v) {
  return String(v ?? "").trim().replace(/^'+/, "");
}

function sliceGridRect_(grid, rStart, rEnd, cStart, cEnd) {
  if (!Array.isArray(grid)) return [];
  const out = [];
  for (let r = rStart; r <= rEnd; r++) {
    const row = Array.isArray(grid[r]) ? grid[r] : [];
    const slice = [];
    for (let c = cStart; c <= cEnd; c++) {
      slice.push(row[c] ?? "");
    }
    out.push(slice);
  }
  return out;
}

/**
 * Deterministic hash of CRM-specific configuration slices across KeyInfo, CRMList,
 * and DataChgAlert so any mapping/rule edit invalidates the skip baseline immediately.
 */
export function computeCrmSettingsHash({ keyInfoGrid = [], crmListGrid = [], dcaGrid = [] } = {}) {
  const payload = {
    keyInfoQ: sliceGridRect_(keyInfoGrid, 7, 8, 16, 16),     // Q8:Q9
    keyInfoD: sliceGridRect_(keyInfoGrid, 10, 17, 3, 3),     // D11:D18
    keyInfoF: sliceGridRect_(keyInfoGrid, 14, 18, 5, 5),     // F15:F19
    keyInfoX: sliceGridRect_(keyInfoGrid, 10, 40, 23, 23),   // X11:X41
    keyInfoPL: sliceGridRect_(keyInfoGrid, 22, 61, 4, 5),    // E23:F62
    keyInfoLS: sliceGridRect_(keyInfoGrid, 31, 74, 8, 9),    // I32:J75
    keyInfoSt: sliceGridRect_(keyInfoGrid, 31, 74, 11, 13),  // L32:N75
    crmListRow2: Array.isArray(crmListGrid?.[1]) ? crmListGrid[1].slice(0, 140) : [],
    dcaMonths: sliceGridRect_(dcaGrid, 54, 55, 1, 1),        // B55:B56
    dcaRules: sliceGridRect_(dcaGrid, 58, 78, 0, 5),         // A59:F79
    dcaB82: dcaGrid?.[81]?.[1] ?? "",                        // B82
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

async function fetchJsonWithTimeout_(url, options = {}, timeoutMs = PREFLIGHT_TIMEOUT_MS) {
  const res = await fetch(url, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function normalizeCrmToolKey_(crmTool) {
  const s = String(crmTool || "").trim().toLowerCase();
  if (!s || s === "none" || s === "na") return "";
  if (s.includes("google") || s.includes("sheet")) return "googlesheet";
  if (s.includes("excel")) return "excel";
  if (s.includes("hubspot")) return "hubspot";
  if (s.includes("pipedrive")) return "pipedrive";
  if (s.includes("close")) return "close";
  if (s.includes("capsule")) return "capsule";
  if (s.includes("clickup")) return "clickup";
  if (s.includes("monday")) return "monday";
  return s;
}

/**
 * Probes the external CRM source with a single lightweight metadata/delta call.
 * Always fails open ({ ok: false, reason }) so any error or ambiguity triggers a normal sync.
 */
export async function probeExternalCrmFingerprint({ ctx, keyInfoGrid, referenceSinceIso = null }) {
  try {
    const rawTool = cleanCell_(keyInfoGrid?.[7]?.[16]); // KeyInfo!Q8
    const crmDrives = cleanCell_(keyInfoGrid?.[8]?.[16]); // KeyInfo!Q9
    if (!rawTool || rawTool.toLowerCase() === "none") {
      return { ok: false, reason: "no_crm_tool" };
    }
    if (!crmDrives || crmDrives.toLowerCase() === "na" || crmDrives.toLowerCase() === "none") {
      return { ok: false, reason: "crm_drives_na" };
    }

    const toolKey = normalizeCrmToolKey_(rawTool);
    if (!toolKey) return { ok: false, reason: "unsupported_crm_tool" };

    const tokenRes = await resolveBrokerTokenInProcess(ctx, toolKey);
    const accessToken = tokenRes?.status === 200 ? tokenRes?.body?.accessToken : null;
    if (!accessToken) {
      return { ok: false, reason: `token_unavailable_${tokenRes?.status || "err"}` };
    }

    if (toolKey === "googlesheet") {
      let rawUrl = cleanCell_(keyInfoGrid?.[10]?.[23]); // X11
      if (!rawUrl) {
        const legacyX14 = cleanCell_(keyInfoGrid?.[13]?.[23]); // X14
        if (legacyX14.includes("http")) rawUrl = legacyX14;
      }
      const extracted = extractSheetIdFromUrl(rawUrl) || (/^[A-Za-z0-9_-]{20,}$/.test(rawUrl) ? rawUrl : "");
      if (!extracted || /^sb-/i.test(extracted)) {
        return { ok: false, reason: "invalid_gsheet_id" };
      }
      const forbidden = new Set(
        [ctx.masterSheetId, ctx.clientSheetId, ctx.reconSheetId].filter(Boolean).map((v) => String(v).trim())
      );
      if (forbidden.has(extracted)) {
        return { ok: false, reason: "internal_gsheet_id" };
      }

      const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(extracted)}?fields=id,version,modifiedTime&supportsAllDrives=true`;
      const res = await fetchJsonWithTimeout_(driveUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok || !res.data?.id) {
        return { ok: false, reason: `gsheet_drive_http_${res.status}` };
      }
      const modMs = Date.parse(res.data.modifiedTime || "");
      return {
        ok: true,
        tool: "Google Sheet",
        isSpreadsheetSource: true,
        modifiedMs: Number.isFinite(modMs) ? modMs : null,
        modifiedIso: res.data.modifiedTime || null,
        fingerprint: `gsheet:${extracted}:v=${res.data.version ?? ""}:m=${res.data.modifiedTime ?? ""}`,
      };
    }

    if (toolKey === "excel") {
      const driveId = cleanCell_(keyInfoGrid?.[35]?.[23]); // X36
      const fileId = cleanCell_(keyInfoGrid?.[36]?.[23]);  // X37
      const sheetName = cleanCell_(keyInfoGrid?.[37]?.[23]); // X38
      if (!driveId || !fileId || !sheetName) {
        return { ok: false, reason: "missing_excel_config" };
      }
      const safeDriveId = assertSafeGraphId(driveId, "driveId");
      const safeFileId = assertSafeGraphId(fileId, "fileId");
      const graphUrl = `https://graph.microsoft.com/v1.0/drives/${safeDriveId}/items/${safeFileId}?$select=id,eTag,cTag,lastModifiedDateTime,size`;
      const res = await fetchJsonWithTimeout_(graphUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Cache-Control": "no-cache",
        },
      });
      if (!res.ok || !res.data?.id) {
        return { ok: false, reason: `excel_graph_http_${res.status}` };
      }
      const modMs = Date.parse(res.data.lastModifiedDateTime || "");
      return {
        ok: true,
        tool: "Excel",
        isSpreadsheetSource: true,
        modifiedMs: Number.isFinite(modMs) ? modMs : null,
        modifiedIso: res.data.lastModifiedDateTime || null,
        fingerprint: `excel:${driveId}:${fileId}:${sheetName}:c=${res.data.cTag || res.data.eTag || ""}:m=${res.data.lastModifiedDateTime || ""}:s=${res.data.size ?? ""}`,
      };
    }

    if (toolKey === "hubspot") {
      const res = await fetchJsonWithTimeout_("https://api.hubapi.com/crm/v3/objects/deals/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filterGroups: [],
          sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
          properties: ["hs_lastmodifieddate"],
          limit: 1,
        }),
      });
      if (!res.ok || !res.data) {
        return { ok: false, reason: `hubspot_http_${res.status}` };
      }
      const top = Array.isArray(res.data.results) ? res.data.results[0] : null;
      const topMod = top?.updatedAt || top?.properties?.hs_lastmodifieddate || "";
      return {
        ok: true,
        tool: "HubSpot",
        isSpreadsheetSource: false,
        fingerprint: `hubspot:total=${res.data.total ?? 0}:top=${top?.id || "none"}:${topMod}`,
      };
    }

    if (toolKey === "pipedrive") {
      const headers = { Authorization: `Bearer ${accessToken}` };
      const [dealsRes, summaryRes] = await Promise.all([
        fetchJsonWithTimeout_("https://api.pipedrive.com/v1/deals?start=0&limit=1&sort=update_time%20DESC", {
          method: "GET",
          headers,
        }),
        fetchJsonWithTimeout_("https://api.pipedrive.com/v1/deals/summary", {
          method: "GET",
          headers,
        }).catch(() => ({ ok: false, data: null })),
      ]);
      if (!dealsRes.ok || dealsRes.data?.success === false) {
        return { ok: false, reason: `pipedrive_http_${dealsRes.status}` };
      }
      const top = Array.isArray(dealsRes.data?.data) ? dealsRes.data.data[0] : null;
      const totalCount = summaryRes.ok ? (summaryRes.data?.data?.total_count ?? "na") : "na";
      return {
        ok: true,
        tool: "Pipedrive",
        isSpreadsheetSource: false,
        fingerprint: `pipedrive:count=${totalCount}:top=${top?.id || "none"}:${top?.update_time || ""}`,
      };
    }

    if (toolKey === "close") {
      const res = await fetchJsonWithTimeout_(
        "https://api.close.com/api/v1/opportunity/?_limit=1&_order_by=-date_updated&_fields=id,date_updated",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        }
      );
      if (!res.ok || !res.data) {
        return { ok: false, reason: `close_http_${res.status}` };
      }
      const top = Array.isArray(res.data.data) ? res.data.data[0] : null;
      return {
        ok: true,
        tool: "Close",
        isSpreadsheetSource: false,
        fingerprint: `close:total=${res.data.total_results ?? "na"}:top=${top?.id || "none"}:${top?.date_updated || ""}`,
      };
    }

    if (toolKey === "capsule") {
      const sinceMs = referenceSinceIso ? Date.parse(referenceSinceIso) : NaN;
      if (!Number.isFinite(sinceMs)) {
        return { ok: false, reason: "no_capsule_since_baseline" };
      }
      const sinceIso = new Date(sinceMs).toISOString();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      };
      const [oppRes, delRes] = await Promise.all([
        fetchJsonWithTimeout_(
          `https://api.capsulecrm.com/api/v2/opportunities?since=${encodeURIComponent(sinceIso)}&perPage=5`,
          { method: "GET", headers }
        ),
        fetchJsonWithTimeout_(
          `https://api.capsulecrm.com/api/v2/opportunities/deleted?since=${encodeURIComponent(sinceIso)}&perPage=5`,
          { method: "GET", headers }
        ).catch(() => ({ ok: false, data: null })),
      ]);
      if (!oppRes.ok || !oppRes.data) {
        return { ok: false, reason: `capsule_http_${oppRes.status}` };
      }
      const chg = (oppRes.data.opportunities || [])
        .map((o) => `${o.id}@${o.updatedAt || ""}`)
        .join(",");
      const delArr = delRes.ok
        ? (delRes.data?.opportunities || delRes.data?.deletedOpportunities || [])
        : [];
      const del = delArr.map((o) => `${o.id}`).join(",");
      return {
        ok: true,
        tool: "Capsule",
        isSpreadsheetSource: false,
        fingerprint: `capsule:since=${sinceIso}:chg=${chg}:del=${del}`,
      };
    }

    if (toolKey === "clickup") {
      let listId = cleanCell_(keyInfoGrid?.[15]?.[23]); // X16
      const viewId = cleanCell_(keyInfoGrid?.[16]?.[23]); // X17
      const headers = { Authorization: accessToken };

      if ((!listId || !/^[A-Za-z0-9_-]+$/.test(listId)) && viewId && /^[A-Za-z0-9_-]+$/.test(viewId)) {
        const viewRes = await fetchJsonWithTimeout_(
          `https://api.clickup.com/api/v2/view/${encodeURIComponent(viewId)}`,
          { method: "GET", headers }
        ).catch(() => ({ ok: false, data: null }));
        if (viewRes.ok && Number(viewRes.data?.view?.parent?.type) === 6 && viewRes.data?.view?.parent?.id) {
          listId = String(viewRes.data.view.parent.id);
        }
      }

      if (listId && /^[A-Za-z0-9_-]+$/.test(listId)) {
        const [listRes, tasksRes] = await Promise.all([
          fetchJsonWithTimeout_(
            `https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}`,
            { method: "GET", headers }
          ).catch(() => ({ ok: false, data: null })),
          fetchJsonWithTimeout_(
            `https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}/task?order_by=updated&reverse=true&include_closed=true&subtasks=true&page=0`,
            { method: "GET", headers }
          ),
        ]);
        if (!tasksRes.ok || !tasksRes.data) {
          return { ok: false, reason: `clickup_list_http_${tasksRes.status}` };
        }
        const top = Array.isArray(tasksRes.data.tasks) ? tasksRes.data.tasks[0] : null;
        const taskCount = listRes.ok ? (listRes.data?.task_count ?? "na") : "na";
        return {
          ok: true,
          tool: "ClickUp",
          isSpreadsheetSource: false,
          fingerprint: `clickup:list=${listId}:view=${viewId}:count=${taskCount}:top=${top?.id || "none"}:${top?.date_updated || ""}`,
        };
      }

      if (viewId && /^[A-Za-z0-9_-]+$/.test(viewId)) {
        const tasksRes = await fetchJsonWithTimeout_(
          `https://api.clickup.com/api/v2/view/${encodeURIComponent(viewId)}/task?page=0`,
          { method: "GET", headers }
        );
        if (!tasksRes.ok || !tasksRes.data || tasksRes.data.last_page === false) {
          return { ok: false, reason: tasksRes.ok ? "clickup_multipage_view" : `clickup_view_http_${tasksRes.status}` };
        }
        const tasks = Array.isArray(tasksRes.data.tasks) ? tasksRes.data.tasks : [];
        let maxUpd = 0;
        let maxId = "none";
        for (const t of tasks) {
          const u = Number(t?.date_updated || 0);
          if (u > maxUpd) {
            maxUpd = u;
            maxId = String(t?.id || "none");
          }
        }
        return {
          ok: true,
          tool: "ClickUp",
          isSpreadsheetSource: false,
          fingerprint: `clickup:view=${viewId}:len=${tasks.length}:top=${maxId}:${maxUpd}`,
        };
      }

      return { ok: false, reason: "missing_clickup_ids" };
    }

    if (toolKey === "monday") {
      const boardId = cleanCell_(keyInfoGrid?.[23]?.[23]); // X24
      if (!boardId || !/^\d+$/.test(boardId)) {
        return { ok: false, reason: "invalid_monday_board_id" };
      }
      const headers = {
        Authorization: accessToken,
        "Content-Type": "application/json",
      };
      let res = await fetchJsonWithTimeout_("https://api.monday.com/v2", {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: `query { boards(ids: [${boardId}]) { items_count updated_at activity_logs(limit: 1) { id created_at } } }`,
        }),
      });
      if (!res.ok || res.data?.errors) {
        res = await fetchJsonWithTimeout_("https://api.monday.com/v2", {
          method: "POST",
          headers,
          body: JSON.stringify({
            query: `query { boards(ids: [${boardId}]) { items_count updated_at } }`,
          }),
        });
      }
      if (!res.ok || res.data?.errors) {
        return { ok: false, reason: `monday_http_${res.status}` };
      }
      const b = Array.isArray(res.data?.data?.boards) ? res.data.data.boards[0] : null;
      if (!b) {
        return { ok: false, reason: "monday_board_missing" };
      }
      const topLog = Array.isArray(b.activity_logs) ? b.activity_logs[0] : null;
      return {
        ok: true,
        tool: "Monday",
        isSpreadsheetSource: false,
        fingerprint: `monday:board=${boardId}:count=${b.items_count ?? ""}:upd=${b.updated_at || ""}:log=${topLog?.id || ""}@${topLog?.created_at || ""}`,
      };
    }

    return { ok: false, reason: `unhandled_tool_${toolKey}` };
  } catch (err) {
    return { ok: false, reason: `exception:${err?.message || "unknown"}` };
  }
}

/**
 * Evaluates whether a scheduled CRM run can be safely skipped (no external/internal changes),
 * deferred briefly (Google Sheet/Excel edited within the 60s quiet window), or must run.
 */
export async function evaluateScheduledCrmPreflight({
  ctx,
  schedRow,
  keyInfoGrid,
  crmListGrid,
  dcaGrid,
  maxClientJobsUpdatedMs = 0,
}) {
  const prevPreflight = schedRow?.flags?.crm_preflight || null;
  if (!prevPreflight?.fingerprint || !prevPreflight?.fullSyncedAt) {
    return { decision: "sync", reason: "no_baseline" };
  }

  if (String(schedRow?.crm_status || "").trim().toLowerCase().startsWith("error")) {
    return { decision: "sync", reason: "retry_error_status" };
  }

  const fullSyncedMs = new Date(prevPreflight.fullSyncedAt).getTime();
  if (!Number.isFinite(fullSyncedMs) || Date.now() - fullSyncedMs >= MAX_SKIP_WINDOW_MS) {
    return { decision: "sync", reason: "periodic_6h_reconcile" };
  }

  const currentSettingsHash = computeCrmSettingsHash({ keyInfoGrid, crmListGrid, dcaGrid });
  if (prevPreflight.settingsHash && currentSettingsHash !== prevPreflight.settingsHash) {
    return { decision: "sync", reason: "crm_settings_changed" };
  }

  const completedMs = new Date(prevPreflight.completedAt || prevPreflight.fullSyncedAt).getTime();
  if (maxClientJobsUpdatedMs > 0 && Number.isFinite(completedMs) && maxClientJobsUpdatedMs > completedMs + 5000) {
    return { decision: "sync", reason: "client_jobs_edited" };
  }

  const probe = await probeExternalCrmFingerprint({
    ctx,
    keyInfoGrid,
    referenceSinceIso: prevPreflight.fullSyncedAt,
  });

  if (!probe.ok) {
    return { decision: "sync", reason: `probe_inconclusive:${probe.reason}` };
  }

  // Note: Capsule's `?since=<fullSyncedAt>` returns empty chg/del only when nothing changed since fullSyncedAt.
  // Reconstruct the empty baseline signature dynamically for Capsule comparison so it matches cleanly.
  const isCapsuleEmptyMatch =
    probe.tool === "Capsule" &&
    prevPreflight.fingerprint.startsWith("capsule:") &&
    probe.fingerprint === `capsule:since=${new Date(prevPreflight.fullSyncedAt).toISOString()}:chg=:del=`;

  if (probe.fingerprint !== prevPreflight.fingerprint && !isCapsuleEmptyMatch) {
    if (probe.isSpreadsheetSource && Number.isFinite(probe.modifiedMs)) {
      const ageMs = Date.now() - probe.modifiedMs;
      if (ageMs >= 0 && ageMs < SPREADSHEET_QUIET_WINDOW_MS) {
        return {
          decision: "defer_quiet_window",
          reason: `spreadsheet_edited_${Math.round(ageMs / 1000)}s_ago`,
          probe,
        };
      }
    }
    return { decision: "sync", reason: "crm_changed", probe };
  }

  return {
    decision: "skip_unchanged",
    reason: "unchanged",
    probe,
    currentSettingsHash,
  };
}

/**
 * Captures a fresh preflight baseline fingerprint immediately after a completed full CRM sync.
 * Tracks consecutive preflight-only failures (where the full CRM sync succeeded) and returns
 * a deduplicated AutoLog error payload after 3 consecutive failures.
 */
export async function captureCrmPreflightBaseline({
  ctx,
  keyInfoGrid,
  crmListGrid,
  dcaGrid,
  runStartedIso,
  completedAtIso,
  prevPreflight = null,
}) {
  const settingsHash = computeCrmSettingsHash({ keyInfoGrid, crmListGrid, dcaGrid });
  const probe = await probeExternalCrmFingerprint({
    ctx,
    keyInfoGrid,
    referenceSinceIso: runStartedIso,
  });

  if (probe.ok) {
    return {
      state: {
        tool: probe.tool,
        fingerprint: probe.fingerprint,
        settingsHash,
        fullSyncedAt: runStartedIso,
        completedAt: completedAtIso || new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        lastOutcome: "full_sync",
        consecutiveFailures: 0,
        lastFailureReason: null,
        lastAlertedReason: null,
        lastAlertedAt: null,
      },
      autoLogError: null,
    };
  }

  if (probe.reason === "no_crm_tool" || probe.reason === "crm_drives_na") {
    return { state: null, autoLogError: null };
  }

  const rawTool = cleanCell_(keyInfoGrid?.[7]?.[16]) || "CRM";
  const prevFailures = Number(prevPreflight?.consecutiveFailures || 0);
  const consecutiveFailures = Number.isFinite(prevFailures) ? prevFailures + 1 : 1;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const prevAlertedAtMs = prevPreflight?.lastAlertedAt ? Date.parse(prevPreflight.lastAlertedAt) : NaN;
  const alreadyAlertedRecently =
    prevPreflight?.lastAlertedReason === probe.reason &&
    Number.isFinite(prevAlertedAtMs) &&
    nowMs - prevAlertedAtMs < ALERT_DEDUP_WINDOW_MS;
  const shouldWriteAutoLog =
    consecutiveFailures >= CONSECUTIVE_FAILURES_ALERT_THRESHOLD && !alreadyAlertedRecently;
  const humanReason = describePreflightFailureReason(probe.reason, rawTool);

  return {
    state: {
      ...(prevPreflight && typeof prevPreflight === "object" ? prevPreflight : {}),
      tool: rawTool,
      fingerprint: null, // keep failing open until preflight recovers
      settingsHash,
      fullSyncedAt: runStartedIso,
      completedAt: completedAtIso || nowIso,
      lastCheckedAt: nowIso,
      lastOutcome: "preflight_failed",
      consecutiveFailures,
      lastFailureReason: probe.reason,
      lastAlertedReason: shouldWriteAutoLog ? probe.reason : (prevPreflight?.lastAlertedReason || null),
      lastAlertedAt: shouldWriteAutoLog ? nowIso : (prevPreflight?.lastAlertedAt || null),
    },
    autoLogError: shouldWriteAutoLog
      ? {
          category: "CRM",
          summary: "Error: CRM Preflight Check",
          details: `Error: CRM Preflight Check - Pre-pull change detection failed ${consecutiveFailures} consecutive times: ${humanReason}. Full CRM sync still succeeded, so pipeline data is up to date, but fast-skip optimization is inactive until resolved.`,
        }
      : null,
  };
}
