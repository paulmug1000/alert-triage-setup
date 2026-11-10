/**
 * ============================================================================
 * PULSE SUPABASE BACKUP & SNAPSHOT ENGINE (services/supabaseBackupService.js)
 * Version: 1.00 — Cloud GZIP snapshots in Supabase Storage, local export/import,
 *                 granular per-client / per-workbook / per-tab restore, and
 *                 automated daily rolling backup sweeps with retention pruning
 * ============================================================================
 * Why Supabase Storage + GZIP:
 *   - Each client's full Master + Recon + Client workbook (~64–82 tabs, ~10.8 MB raw JSON)
 *     compresses by ~93% down to ~700 KB using GZIP.
 *   - Storing compressed snapshots in the private `pulse-backups` Supabase Storage bucket
 *     consumes 0 MB of the 500 MB Free-tier PostgreSQL database limit while using < 1%
 *     of the separate 1 GB Supabase Storage quota per client snapshot.
 */

import zlib from "zlib";
import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "./supabaseClient.js";
import { invalidateMasterEngineCache } from "./masterEngineService.js";

const BACKUP_BUCKET = "pulse-backups";
const BACKUP_INDEX_CONFIG_KEY = "supabase_client_backups_index";
const BACKUP_POLICY_CONFIG_KEY = "supabase_backup_policy";

const DEFAULT_BACKUP_POLICY = {
  autoDailyEnabled: true,
  retentionDays: 14,
  lastDailyBackupDate: null,
  lastDailyBackupAt: null,
  lastDailyBackupCount: 0,
};

let _bucketEnsured = false;

function sanitizeClientSlug_(clientName) {
  return (
    String(clientName || "client")
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "client"
  );
}

function getTodayUkDateStr_() {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

async function ensureBackupBucket_(sb) {
  if (_bucketEnsured) return;
  try {
    const { data: buckets } = await sb.storage.listBuckets();
    const exists = Array.isArray(buckets) && buckets.some((b) => b.name === BACKUP_BUCKET);
    if (!exists) {
      await sb.storage.createBucket(BACKUP_BUCKET, { public: false });
    }
    _bucketEnsured = true;
  } catch (err) {
    console.warn("[supabaseBackupService] ensureBackupBucket_ warning:", err.message);
  }
}

async function readBackupIndex_(sb) {
  const { data } = await sb
    .from("system_config")
    .select("value")
    .eq("key", BACKUP_INDEX_CONFIG_KEY)
    .maybeSingle();
  const list = data?.value?.snapshots;
  return Array.isArray(list) ? list : [];
}

async function writeBackupIndex_(sb, snapshots, updatedBy = "System") {
  await sb.from("system_config").upsert({
    key: BACKUP_INDEX_CONFIG_KEY,
    value: {
      snapshots,
      updatedAt: new Date().toISOString(),
    },
    description: "Catalogue of compressed client workbook snapshots stored in the pulse-backups bucket",
    updated_by: updatedBy,
  });
}

export async function getBackupPolicy(sbOverride = null) {
  const sb = sbOverride || getSupabaseAdmin();
  if (!sb) return { ...DEFAULT_BACKUP_POLICY };
  const { data } = await sb
    .from("system_config")
    .select("value")
    .eq("key", BACKUP_POLICY_CONFIG_KEY)
    .maybeSingle();
  return {
    ...DEFAULT_BACKUP_POLICY,
    ...(data?.value || {}),
  };
}

export async function updateBackupPolicy(patch = {}, updatedBy = "Admin") {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase admin client is not configured.");
  const current = await getBackupPolicy(sb);
  const next = {
    ...current,
    ...(patch.autoDailyEnabled !== undefined ? { autoDailyEnabled: Boolean(patch.autoDailyEnabled) } : {}),
    ...(patch.retentionDays !== undefined
      ? { retentionDays: Math.max(1, Math.min(90, Number(patch.retentionDays) || 14)) }
      : {}),
    ...(patch.lastDailyBackupDate !== undefined ? { lastDailyBackupDate: patch.lastDailyBackupDate } : {}),
    ...(patch.lastDailyBackupAt !== undefined ? { lastDailyBackupAt: patch.lastDailyBackupAt } : {}),
    ...(patch.lastDailyBackupCount !== undefined ? { lastDailyBackupCount: patch.lastDailyBackupCount } : {}),
  };
  await sb.from("system_config").upsert({
    key: BACKUP_POLICY_CONFIG_KEY,
    value: next,
    description: "Automated daily Supabase client workbook snapshot policy and retention settings",
    updated_by: updatedBy,
  });
  return next;
}

/**
 * Lists snapshots (optionally filtered to a single client) plus global storage usage and policy.
 */
export async function listClientSnapshots({ clientName = null } = {}) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase admin client is not configured.");

  const [allSnapshots, policy] = await Promise.all([readBackupIndex_(sb), getBackupPolicy(sb)]);

  const sorted = [...allSnapshots].sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );

  const cleanTarget = clientName ? String(clientName).trim().toUpperCase() : null;
  const filtered = cleanTarget
    ? sorted.filter((s) => String(s.clientName || "").trim().toUpperCase() === cleanTarget)
    : sorted;

  const totalCompressedBytes = sorted.reduce((acc, s) => acc + (Number(s.compressedBytes) || 0), 0);
  const totalRawBytes = sorted.reduce((acc, s) => acc + (Number(s.rawBytes) || 0), 0);

  return {
    snapshots: filtered,
    allSnapshotsCount: sorted.length,
    clientSnapshotsCount: filtered.length,
    totalCompressedBytes,
    totalRawBytes,
    policy,
  };
}

/**
 * Captures a full snapshot of a client's Supabase workbooks (`master`, `recon`, `client`)
 * and `client_master_config`, compresses it with GZIP, and stores it in `pulse-backups`.
 */
export async function createClientSnapshot({
  clientName,
  triggerType = "manual",
  label = "",
  createdBy = "Admin",
} = {}) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase admin client is not configured.");

  const cleanClient = String(clientName || "").trim();
  if (!cleanClient) throw new Error("clientName is required to create a snapshot.");

  await ensureBackupBucket_(sb);

  const { data: cfgRow } = await sb
    .from("client_master_config")
    .select("*")
    .ilike("client_name", cleanClient)
    .maybeSingle();

  const canonicalName = cfgRow?.client_name || cleanClient;

  // Fetch tab metadata first so we can load grids without hitting a statement timeout
  const { data: tabMetaRows, error: metaErr } = await sb
    .from("master_sheet_grids")
    .select("sheet_role, tab_name, row_count, col_count, updated_at")
    .eq("client_name", canonicalName)
    .order("sheet_role", { ascending: true })
    .order("tab_name", { ascending: true });

  if (metaErr) {
    throw new Error(`Could not list tabs for ${canonicalName}: ${metaErr.message}`);
  }
  if (!tabMetaRows || tabMetaRows.length === 0) {
    throw new Error(`No Supabase workbook tabs found for ${canonicalName}. Sync or seed the client first.`);
  }

  const tabs = [];
  const tabsByRole = { master: [], recon: [], client: [] };

  // Fetch tabs in parallel batches of 6 to stay fast while avoiding huge single-query payloads
  for (let i = 0; i < tabMetaRows.length; i += 6) {
    const batch = tabMetaRows.slice(i, i + 6);
    const loadedBatch = await Promise.all(
      batch.map(async (meta) => {
        const { data: row, error: rErr } = await sb
          .from("master_sheet_grids")
          .select("sheet_role, tab_name, values_grid, formulas_grid, notes_grid, row_count, col_count, updated_at")
          .eq("client_name", canonicalName)
          .eq("sheet_role", meta.sheet_role)
          .eq("tab_name", meta.tab_name)
          .maybeSingle();
        if (rErr) {
          throw new Error(`Error reading ${meta.sheet_role}:${meta.tab_name}: ${rErr.message}`);
        }
        return row;
      })
    );
    for (const row of loadedBatch) {
      if (!row) continue;
      tabs.push(row);
      if (tabsByRole[row.sheet_role]) {
        tabsByRole[row.sheet_role].push(row.tab_name);
      }
    }
  }

  const nowIso = new Date().toISOString();
  const snapshotId = `snap_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const slug = sanitizeClientSlug_(canonicalName);
  const safeTs = nowIso.replace(/[:.]/g, "-");
  const storagePath = `snapshots/${slug}/${safeTs}_${snapshotId}.json.gz`;

  const snapshotPayload = {
    formatVersion: 1,
    snapshotId,
    clientName: canonicalName,
    clientId: cfgRow?.id || null,
    createdAt: nowIso,
    createdBy,
    triggerType,
    label: String(label || "").trim(),
    config: cfgRow || null,
    tabs,
  };

  const rawBuffer = Buffer.from(JSON.stringify(snapshotPayload), "utf8");
  const compressedBuffer = zlib.gzipSync(rawBuffer, { level: zlib.constants.Z_BEST_SPEED });

  const { error: uploadErr } = await sb.storage
    .from(BACKUP_BUCKET)
    .upload(storagePath, compressedBuffer, {
      contentType: "application/gzip",
      upsert: true,
    });

  if (uploadErr) {
    throw new Error(`Could not upload snapshot to Supabase Storage: ${uploadErr.message}`);
  }

  const entry = {
    id: snapshotId,
    clientName: canonicalName,
    storagePath,
    createdAt: nowIso,
    createdBy,
    triggerType,
    label: String(label || "").trim(),
    masterTabCount: tabsByRole.master.length,
    reconTabCount: tabsByRole.recon.length,
    clientTabCount: tabsByRole.client.length,
    tabsByRole,
    rawBytes: rawBuffer.length,
    compressedBytes: compressedBuffer.length,
  };

  const currentIndex = await readBackupIndex_(sb);
  const nextIndex = [entry, ...currentIndex.filter((s) => s.id !== snapshotId)];
  await writeBackupIndex_(sb, nextIndex, createdBy);

  return entry;
}

/**
 * Downloads the raw GZIP buffer (as base64) for a stored snapshot so it can be
 * transferred over Vercel serverless functions (<1 MB) without hitting the 4.5 MB limit.
 */
export async function getSnapshotCompressedBase64ById(snapshotId) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase admin client is not configured.");

  const index = await readBackupIndex_(sb);
  const entry = index.find((s) => s.id === snapshotId);
  if (!entry) {
    throw new Error(`Snapshot "${snapshotId}" not found in backup catalogue.`);
  }

  const { data: blob, error: dlErr } = await sb.storage.from(BACKUP_BUCKET).download(entry.storagePath);
  if (dlErr || !blob) {
    throw new Error(`Could not download snapshot file (${entry.storagePath}): ${dlErr?.message || "Missing file"}`);
  }

  const compressedBuf = Buffer.from(await blob.arrayBuffer());
  return {
    entry,
    compressedBase64: compressedBuf.toString("base64"),
  };
}

/**
 * Downloads and decompresses a stored snapshot payload from `pulse-backups`.
 */
export async function getSnapshotPayloadById(snapshotId) {
  const { entry, compressedBase64 } = await getSnapshotCompressedBase64ById(snapshotId);
  const compressedBuf = Buffer.from(compressedBase64, "base64");
  const rawJson = zlib.gunzipSync(compressedBuf).toString("utf8");
  const payload = JSON.parse(rawJson);

  return { entry, payload };
}

/**
 * Imports a locally exported snapshot (sent as GZIP base64 or JSON object) into the
 * `pulse-backups` cloud bucket so it appears in the client's snapshot list.
 */
export async function importLocalSnapshotToCloud({
  uploadedCompressedBase64 = null,
  uploadedPayload = null,
  clientNameOverride = null,
  labelOverride = "",
  importedBy = "Admin",
} = {}) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase admin client is not configured.");
  await ensureBackupBucket_(sb);

  let payload = uploadedPayload;
  if (!payload && uploadedCompressedBase64) {
    const buf = Buffer.from(uploadedCompressedBase64, "base64");
    const rawStr = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    payload = JSON.parse(rawStr);
  }

  if (!payload || !Array.isArray(payload.tabs)) {
    throw new Error("Invalid snapshot file: missing tabs array.");
  }

  const canonicalName = String(clientNameOverride || payload.clientName || "").trim();
  if (!canonicalName) {
    throw new Error("Snapshot file does not contain a clientName.");
  }

  const nowIso = new Date().toISOString();
  const snapshotId = `snap_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const slug = sanitizeClientSlug_(canonicalName);
  const safeTs = nowIso.replace(/[:.]/g, "-");
  const storagePath = `snapshots/${slug}/${safeTs}_${snapshotId}.json.gz`;

  const tabsByRole = { master: [], recon: [], client: [] };
  for (const t of payload.tabs) {
    if (t && tabsByRole[t.sheet_role]) {
      tabsByRole[t.sheet_role].push(t.tab_name);
    }
  }

  const normalizedPayload = {
    ...payload,
    formatVersion: 1,
    snapshotId,
    clientName: canonicalName,
    importedAt: nowIso,
    importedBy,
  };

  const rawBuffer = Buffer.from(JSON.stringify(normalizedPayload), "utf8");
  const compressedBuffer = zlib.gzipSync(rawBuffer, { level: zlib.constants.Z_BEST_SPEED });

  const { error: uploadErr } = await sb.storage
    .from(BACKUP_BUCKET)
    .upload(storagePath, compressedBuffer, {
      contentType: "application/gzip",
      upsert: true,
    });

  if (uploadErr) {
    throw new Error(`Could not upload imported snapshot to Supabase Storage: ${uploadErr.message}`);
  }

  const origDate = payload.createdAt ? new Date(payload.createdAt).toLocaleString("en-GB") : "local file";
  const entry = {
    id: snapshotId,
    clientName: canonicalName,
    storagePath,
    createdAt: nowIso,
    createdBy: importedBy,
    triggerType: "uploaded",
    label: String(labelOverride || payload.label || `Imported from ${origDate}`).trim(),
    masterTabCount: tabsByRole.master.length,
    reconTabCount: tabsByRole.recon.length,
    clientTabCount: tabsByRole.client.length,
    tabsByRole,
    rawBytes: rawBuffer.length,
    compressedBytes: compressedBuffer.length,
  };

  const currentIndex = await readBackupIndex_(sb);
  const nextIndex = [entry, ...currentIndex.filter((s) => s.id !== snapshotId)];
  await writeBackupIndex_(sb, nextIndex, importedBy);

  return entry;
}

/**
 * Restores a snapshot payload (either from a cloud `snapshotId` or an uploaded `payload` object)
 * back into `master_sheet_grids` for the client.
 *
 * Supports granular scope:
 *   - `scope = "all"`         -> Restores all tabs (`master`, `recon`, and `client`)
 *   - `scope = "client"`      -> Restores only Client Portal (`sheet_role === "client"`) tabs
 *   - `scope = "master_recon"`-> Restores only Master & Recon (`sheet_role === "master" | "recon"`) tabs
 *   - `scope = "single_tab"`  -> Restores only `targetRole` + `targetTabName` (e.g. `client` + `Confirmed`)
 */
export async function restoreClientSnapshot({
  snapshotId = null,
  uploadedPayload = null,
  clientNameOverride = null,
  scope = "all",
  targetRole = null,
  targetTabName = null,
  createPreRestoreBackup = true,
  restoredBy = "Admin",
} = {}) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase admin client is not configured.");

  let payload = uploadedPayload;
  let sourceEntry = null;

  if (!payload) {
    if (!snapshotId) throw new Error("Either snapshotId or uploadedPayload is required to restore.");
    const loaded = await getSnapshotPayloadById(snapshotId);
    sourceEntry = loaded.entry;
    payload = loaded.payload;
  }

  if (!payload || !Array.isArray(payload.tabs)) {
    throw new Error("Invalid snapshot format: missing tabs array.");
  }

  const targetClientName = String(clientNameOverride || payload.clientName || "").trim();
  if (!targetClientName) {
    throw new Error("Snapshot does not specify a target clientName.");
  }

  const { data: cfgRow } = await sb
    .from("client_master_config")
    .select("*")
    .ilike("client_name", targetClientName)
    .maybeSingle();

  const canonicalClient = cfgRow?.client_name || targetClientName;
  const clientId = cfgRow?.id || payload.clientId || null;

  // Filter tabs according to requested restore scope
  const tabsToRestore = payload.tabs.filter((t) => {
    if (!t || !t.sheet_role || !t.tab_name) return false;
    if (scope === "client") return t.sheet_role === "client";
    if (scope === "master_recon") return t.sheet_role === "master" || t.sheet_role === "recon";
    if (scope === "single_tab") {
      return (
        String(t.sheet_role).trim() === String(targetRole || "").trim() &&
        String(t.tab_name).trim() === String(targetTabName || "").trim()
      );
    }
    return true;
  });

  if (tabsToRestore.length === 0) {
    throw new Error(
      scope === "single_tab"
        ? `Tab "${targetRole}:${targetTabName}" was not found in this snapshot.`
        : `No matching tabs found in snapshot for scope "${scope}".`
    );
  }

  // Optional safety snapshot of current state before overwriting
  let preRestoreSnapshot = null;
  if (createPreRestoreBackup) {
    try {
      const scopeDesc =
        scope === "single_tab"
          ? `${targetRole}:${targetTabName}`
          : scope === "client"
            ? "Client Portal"
            : scope === "master_recon"
              ? "Master & Recon"
              : "full workbook";
      preRestoreSnapshot = await createClientSnapshot({
        clientName: canonicalClient,
        triggerType: "pre_restore",
        label: `Auto-saved before restoring ${scopeDesc} from ${(payload.createdAt || "").slice(0, 16).replace("T", " ")}`,
        createdBy: restoredBy,
      });
    } catch (preErr) {
      console.warn("[supabaseBackupService] Could not create pre-restore safety snapshot:", preErr.message);
    }
  }

  const nowIso = new Date().toISOString();
  let restoredMasterCount = 0;
  let restoredReconCount = 0;
  let restoredClientCount = 0;

  // Upsert one tab at a time (in parallel batches of 3) to prevent Postgres statement timeouts on large tabs
  for (let i = 0; i < tabsToRestore.length; i += 3) {
    const batch = tabsToRestore.slice(i, i + 3);
    await Promise.all(
      batch.map(async (tab) => {
        const record = {
          client_id: clientId,
          client_name: canonicalClient,
          sheet_role: tab.sheet_role,
          tab_name: tab.tab_name,
          values_grid: Array.isArray(tab.values_grid) ? tab.values_grid : [],
          formulas_grid: Array.isArray(tab.formulas_grid) ? tab.formulas_grid : null,
          notes_grid: tab.notes_grid && typeof tab.notes_grid === "object" ? tab.notes_grid : {},
          row_count: Number(tab.row_count) || (Array.isArray(tab.values_grid) ? tab.values_grid.length : 0),
          col_count: Number(tab.col_count) || 0,
          updated_at: nowIso,
        };
        const { error: uErr } = await sb
          .from("master_sheet_grids")
          .upsert([record], { onConflict: "client_name,sheet_role,tab_name" });
        if (uErr) {
          throw new Error(`Failed restoring ${tab.sheet_role}:${tab.tab_name}: ${uErr.message}`);
        }
        if (tab.sheet_role === "master") restoredMasterCount++;
        else if (tab.sheet_role === "recon") restoredReconCount++;
        else if (tab.sheet_role === "client") restoredClientCount++;
      })
    );
  }

  // Immediately clear all in-memory workbook caches for this client
  invalidateMasterEngineCache(canonicalClient);

  return {
    clientName: canonicalClient,
    sourceSnapshotId: sourceEntry?.id || payload.snapshotId || "uploaded",
    sourceCreatedAt: payload.createdAt || null,
    scope,
    targetRole: scope === "single_tab" ? targetRole : null,
    targetTabName: scope === "single_tab" ? targetTabName : null,
    restoredTabsCount: tabsToRestore.length,
    restoredMasterCount,
    restoredReconCount,
    restoredClientCount,
    preRestoreSnapshotId: preRestoreSnapshot?.id || null,
  };
}

/**
 * Deletes a snapshot from Supabase Storage (`pulse-backups`) and removes it from the index.
 */
export async function deleteClientSnapshot({ snapshotId, deletedBy = "Admin" } = {}) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase admin client is not configured.");
  if (!snapshotId) throw new Error("snapshotId is required.");

  const index = await readBackupIndex_(sb);
  const target = index.find((s) => s.id === snapshotId);
  if (!target) {
    throw new Error(`Snapshot "${snapshotId}" not found.`);
  }

  if (target.storagePath) {
    await sb.storage.from(BACKUP_BUCKET).remove([target.storagePath]).catch((err) => {
      console.warn("[supabaseBackupService] Storage remove warning:", err.message);
    });
  }

  const nextIndex = index.filter((s) => s.id !== snapshotId);
  await writeBackupIndex_(sb, nextIndex, deletedBy);

  return { deletedSnapshot: target, remainingCount: nextIndex.length };
}

/**
 * Runs the automated daily snapshot sweep across all clients that have Supabase workbooks,
 * and prunes automated snapshots older than `policy.retentionDays`.
 */
export async function runDailyAutoBackupSweep({
  force = false,
  triggeredBy = "System (Cron)",
} = {}) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase admin client is not configured.");

  const policy = await getBackupPolicy(sb);
  const todayStr = getTodayUkDateStr_();

  if (!force) {
    if (policy.autoDailyEnabled === false) {
      return { skipped: true, reason: "Automated daily backups are disabled." };
    }
    if (policy.lastDailyBackupDate === todayStr) {
      return { skipped: true, reason: `Daily backup already completed for ${todayStr}.` };
    }
  }

  await ensureBackupBucket_(sb);

  // Discover all clients that currently have tabs in master_sheet_grids
  const { data: gridClients } = await sb
    .from("master_sheet_grids")
    .select("client_name");

  const uniqueClients = Array.from(
    new Set(
      (gridClients || [])
        .map((r) => String(r.client_name || "").trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

  const currentIndex = await readBackupIndex_(sb);
  const createdSnapshots = [];
  const errors = [];

  for (const clientName of uniqueClients) {
    // Unless force=true, skip if this client already has a daily_auto snapshot today
    if (!force) {
      const alreadyToday = currentIndex.some(
        (s) =>
          s.triggerType === "daily_auto" &&
          String(s.clientName || "").trim().toUpperCase() === clientName.toUpperCase() &&
          String(s.createdAt || "").slice(0, 10) === todayStr
      );
      if (alreadyToday) continue;
    }

    try {
      const snap = await createClientSnapshot({
        clientName,
        triggerType: "daily_auto",
        label: `Automated daily snapshot (${todayStr})`,
        createdBy: triggeredBy,
      });
      createdSnapshots.push(snap);
    } catch (err) {
      console.warn(`[supabaseBackupService] Daily backup error for ${clientName}:`, err.message);
      errors.push({ clientName, error: err.message });
    }
  }

  // Prune automated daily snapshots older than retentionDays (never auto-delete manual snapshots)
  const retentionDays = Math.max(1, Number(policy.retentionDays) || 14);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const updatedIndex = await readBackupIndex_(sb);
  const expiredAutoSnapshots = updatedIndex.filter(
    (s) =>
      (s.triggerType === "daily_auto" || s.triggerType === "pre_restore") &&
      new Date(s.createdAt || 0).getTime() < cutoffMs
  );

  if (expiredAutoSnapshots.length > 0) {
    const pathsToRemove = expiredAutoSnapshots.map((s) => s.storagePath).filter(Boolean);
    if (pathsToRemove.length > 0) {
      await sb.storage.from(BACKUP_BUCKET).remove(pathsToRemove).catch(() => { });
    }
    const expiredIds = new Set(expiredAutoSnapshots.map((s) => s.id));
    const surviving = updatedIndex.filter((s) => !expiredIds.has(s.id));
    await writeBackupIndex_(sb, surviving, triggeredBy);
  }

  const nextPolicy = await updateBackupPolicy(
    {
      lastDailyBackupDate: todayStr,
      lastDailyBackupAt: new Date().toISOString(),
      lastDailyBackupCount: createdSnapshots.length,
    },
    triggeredBy
  );

  return {
    skipped: false,
    date: todayStr,
    clientsScanned: uniqueClients.length,
    snapshotsCreated: createdSnapshots.length,
    expiredSnapshotsPruned: expiredAutoSnapshots.length,
    errors,
    policy: nextPolicy,
  };
}
