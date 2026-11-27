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
import { createHash, randomUUID } from "crypto";
import { getSupabaseAdmin } from "./supabaseClient.js";
import { redisClient, ensureRedisConnected } from "./redisClient.js";
import { invalidateMasterEngineCache } from "./masterEngineService.js";
import { escapeIlikeExact } from "../utils/helpers.js";

const MAX_ZLIB_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_RESTORE_GRID_ROWS = 50000;
const MAX_RESTORE_GRID_COLS = 600;
const BACKUP_INDEX_LOCK_KEY = "pulse:lock:backup_index";
const RELEASE_BACKUP_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
let _backupIndexLocalQueue = Promise.resolve();

const ALLOWED_TENANT_KEY_INFO_FIELDS = [
  "fy_start_date",
  "revenue_or_income_mode",
  "direct_costs_mode",
  "accounting_tool",
  "crm_tool",
  "crm_drives",
  "primary_currency",
  "currency_symbol",
  "invoice_method",
  "contractor_categories",
  "passthrough_categories",
  "tracked_bank_accounts",
  "tracked_non_cash_accounts",
  "overhead_mappings",
  "product_lines",
  "lead_sources",
  "crm_field_mappings",
  "kpi_colour_rules",
  "tolerance_rules",
  "portal_feature_flags",
  "client_importrange_backup",
  "client_materialized_at",
];

// Strict parent-before-child topological order so FK constraints always succeed
// on forward insert and reverse delete during Format v2 snapshot restore.
export const RELATIONAL_BACKUP_TABLES = Object.freeze([
  // Master domain (non-cross-domain-FK tables)
  { table: "sync_schedules", domain: "master" },
  { table: "client_setup_state", domain: "master" },
  { table: "accounting_invoices", domain: "master" },
  { table: "accounting_direct_costs", domain: "master" },
  { table: "accounting_pl_lines", domain: "master" },
  { table: "pulse_master_sync_configs", domain: "master" },
  { table: "pulse_master_comparisons", domain: "master" },
  { table: "pulse_automation_logs", domain: "master" },
  { table: "pulse_execution_logs", domain: "master" },
  // Recon domain
  { table: "bank_recon_periods", domain: "recon" },
  { table: "bank_recon_items", domain: "recon" },
  { table: "bank_recon_learning_map", domain: "recon" },
  { table: "pulse_recon_configs", domain: "recon" },
  // Client domain (parent entities before child & cross-domain FK tables)
  { table: "pulse_retainer_series", domain: "client" },
  { table: "pulse_jobs", domain: "client" },
  { table: "pulse_job_invoices", domain: "client" },
  { table: "pulse_job_expenses", domain: "client" },
  { table: "pulse_employees", domain: "client" },
  { table: "pulse_outgoing_items", domain: "client" },
  { table: "pulse_contractor_entries", domain: "client" },
  // Master tables with nullable FKs into pulse_jobs / pulse_employees (must insert AFTER parents & delete BEFORE parents)
  { table: "crm_deals_raw", domain: "master" },
  { table: "time_entries_raw", domain: "master" },
  { table: "pulse_nb_to_find", domain: "client" },
  { table: "pulse_budget_items", domain: "client" },
  { table: "pulse_cash_adjustments", domain: "client" },
  { table: "pulse_cash_bank_balances", domain: "client" },
  { table: "pulse_job_monthly_rollups", domain: "client" },
  { table: "pulse_year0_lines", domain: "client" },
  { table: "pulse_financial_statements", domain: "client" },
  { table: "pulse_vat_schedules", domain: "client" },
  { table: "pulse_cashflow_lines", domain: "client" },
  { table: "pulse_financial_configs", domain: "client" },
  { table: "pulse_client_tab_blueprints", domain: "client" },
  { table: "pulse_notes", domain: "client" },
  { table: "pulse_note_replies", domain: "client", keyedBy: "note_id" },
  { table: "eom_cycles_and_tasks", domain: "client", keyedBy: "client_name" },
  { table: "alert_memory", domain: "client", keyedBy: "client_name" },
  { table: "pma_tasks", domain: "client", keyedBy: "client_name" },
]);

const CONFIG_CLIENT_PK_TABLES = new Set([
  "pulse_master_sync_configs",
  "pulse_recon_configs",
  "pulse_financial_configs",
]);

const CLIENT_NAME_BACKUP_TABLES = ["eom_cycles_and_tasks", "alert_memory", "pma_tasks"];

function sortChronologicalLogs_(table, rows) {
  if (!Array.isArray(rows) || rows.length <= 1) return rows;
  const tsField = table === "pulse_automation_logs" ? "logged_at" : "executed_at";
  return [...rows].sort((a, b) => {
    const ta = a?.[tsField] ? Date.parse(a[tsField]) : 0;
    const tb = b?.[tsField] ? Date.parse(b[tsField]) : 0;
    if (ta !== tb) return ta - tb;
    const sa = Number(a?.sort_seq ?? 0);
    const sb = Number(b?.sort_seq ?? 0);
    if (sa !== sb) return sa - sb;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

async function fetchPaginatedEq_(sb, table, col, val, orderCol = "id") {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from(table)
      .select("*")
      .eq(col, val)
      .order(orderCol, { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`Snapshot read failed on ${table}: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

export async function collectClientRelationalSnapshotData(sb, clientRow) {
  const clientId = clientRow?.id;
  const clientName = String(clientRow?.client_name || "").trim();
  if (!sb || !clientId) {
    throw new Error("Client ID is required to collect relational snapshot data.");
  }

  const tables = Object.create(null);
  const tableCounts = Object.create(null);
  let totalRelationalRows = 0;

  const clientIdTables = RELATIONAL_BACKUP_TABLES.filter((t) => !t.keyedBy || t.keyedBy === "client_id");
  // Fetch 5 tables at a time with deterministic pagination (handles >1000 rows cleanly without timeouts)
  for (let i = 0; i < clientIdTables.length; i += 5) {
    const batch = clientIdTables.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async ({ table }) => {
        const orderCol = CONFIG_CLIENT_PK_TABLES.has(table) ? "client_id" : "id";
        let rows = await fetchPaginatedEq_(sb, table, "client_id", clientId, orderCol);
        if (table === "pulse_automation_logs" || table === "pulse_execution_logs") {
          rows = sortChronologicalLogs_(table, rows);
        }
        return { table, rows };
      })
    );
    for (const { table, rows } of results) {
      tables[table] = rows;
      tableCounts[table] = rows.length;
      totalRelationalRows += rows.length;
    }
  }

  // Child table: pulse_note_replies (keyed by note_id)
  const noteIds = (tables.pulse_notes || []).map((n) => n?.id).filter(Boolean);
  const replyRows = [];
  for (let i = 0; i < noteIds.length; i += 200) {
    const chunk = noteIds.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("pulse_note_replies")
        .select("*")
        .in("note_id", chunk)
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`Snapshot read failed on pulse_note_replies: ${error.message}`);
      if (!Array.isArray(data) || data.length === 0) break;
      replyRows.push(...data);
      if (data.length < 1000) break;
    }
  }
  tables.pulse_note_replies = replyRows;
  tableCounts.pulse_note_replies = replyRows.length;
  totalRelationalRows += replyRows.length;

  // Client-name keyed workflow tables (eom_cycles_and_tasks, alert_memory, pma_tasks)
  for (const tbl of CLIENT_NAME_BACKUP_TABLES) {
    tables[tbl] = [];
    tableCounts[tbl] = 0;
  }
  if (clientName) {
    const extraResults = await Promise.all(
      CLIENT_NAME_BACKUP_TABLES.map(async (tbl) => ({
        table: tbl,
        rows: await fetchPaginatedEq_(sb, tbl, "client_name", clientName, "id"),
      }))
    );
    for (const { table, rows } of extraResults) {
      tables[table] = rows;
      tableCounts[table] = rows.length;
      totalRelationalRows += rows.length;
    }
  }

  return { tables, tableCounts, totalRelationalRows };
}

function normalizeClientKey_(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

async function withBackupIndexLock_(fn) {
  const runLocked = async () => {
    await ensureRedisConnected(1000).catch(() => { });
    const lockToken = randomUUID();
    let lockAcquired = false;
    if (redisClient?.isOpen) {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const res = await redisClient.set(BACKUP_INDEX_LOCK_KEY, lockToken, { NX: true, EX: 30 });
          if (res === "OK") {
            lockAcquired = true;
            break;
          }
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 75 + Math.floor(Math.random() * 50)));
      }
      if (!lockAcquired) {
        throw new Error("Backup index lock contention; please retry.");
      }
    }
    try {
      return await fn();
    } finally {
      if (lockAcquired && redisClient?.isOpen) {
        try {
          await redisClient.eval(RELEASE_BACKUP_LOCK_LUA, {
            keys: [BACKUP_INDEX_LOCK_KEY],
            arguments: [lockToken],
          });
        } catch {
          // TTL expiry covers cleanup if eval fails
        }
      }
    }
  };

  const next = _backupIndexLocalQueue.then(runLocked, runLocked);
  _backupIndexLocalQueue = next.catch(() => { });
  return next;
}

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
  const { data, error } = await sb
    .from("system_config")
    .select("value")
    .eq("key", BACKUP_INDEX_CONFIG_KEY)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed reading backup index: ${error.message}`);
  }
  const list = data?.value?.snapshots;
  return Array.isArray(list) ? list : [];
}

async function writeBackupIndex_(sb, snapshots, updatedBy = "System") {
  const { error } = await sb.from("system_config").upsert({
    key: BACKUP_INDEX_CONFIG_KEY,
    value: {
      snapshots,
      updatedAt: new Date().toISOString(),
    },
    description: "Catalogue of compressed client workbook snapshots stored in the pulse-backups bucket",
    updated_by: updatedBy,
  });
  if (error) {
    throw new Error(`Failed updating backup index: ${error.message}`);
  }
}

export async function getBackupPolicy(sbOverride = null) {
  const sb = sbOverride || getSupabaseAdmin();
  if (!sb) return { ...DEFAULT_BACKUP_POLICY };
  const { data, error } = await sb
    .from("system_config")
    .select("value")
    .eq("key", BACKUP_POLICY_CONFIG_KEY)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed reading backup policy: ${error.message}`);
  }
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
  const { error } = await sb.from("system_config").upsert({
    key: BACKUP_POLICY_CONFIG_KEY,
    value: next,
    description: "Automated daily Supabase client workbook snapshot policy and retention settings",
    updated_by: updatedBy,
  });
  if (error) {
    throw new Error(`Failed updating backup policy: ${error.message}`);
  }
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

  let clientResp = await sb
    .from("clients")
    .select("id, client_name, normalized_key, status, master_mode, client_mode, client_compute_mode, master_compute_mode, connector_pull_mode, sync_orchestrator_mode, grid_storage_retired, metadata")
    .ilike("client_name", escapeIlikeExact(cleanClient))
    .maybeSingle();
  if (clientResp.error && /grid_storage_retired|sync_orchestrator_mode|42703/i.test(String(clientResp.error.message || ""))) {
    clientResp = await sb
      .from("clients")
      .select("id, client_name, normalized_key, status, master_mode, client_mode, client_compute_mode, master_compute_mode, connector_pull_mode, metadata")
      .ilike("client_name", escapeIlikeExact(cleanClient))
      .maybeSingle();
  }
  const [{ data: clientRow }, { data: keyInfoRow }] = [
    clientResp,
    await sb
      .from("tenant_key_info")
      .select("*")
      .ilike("client_name", escapeIlikeExact(cleanClient))
      .maybeSingle(),
  ];

  const canonicalName = clientRow?.client_name || keyInfoRow?.client_name || cleanClient;
  const isNativeClient =
    Boolean(clientRow?.id) &&
    (Boolean(clientRow?.grid_storage_retired) ||
      (String(clientRow?.client_compute_mode || clientRow?.metadata?.client_compute_mode || "").toLowerCase() === "native" &&
        String(clientRow?.master_compute_mode || clientRow?.metadata?.master_compute_mode || "").toLowerCase() === "native" &&
        String(clientRow?.sync_orchestrator_mode || clientRow?.metadata?.sync_orchestrator_mode || "").toLowerCase() === "native"));

  const nowIso = new Date().toISOString();
  const snapshotId = `snap_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const slug = sanitizeClientSlug_(canonicalName);
  const safeTs = nowIso.replace(/[:.]/g, "-");
  const storagePath = `snapshots/${slug}/${safeTs}_${snapshotId}.json.gz`;

  let snapshotPayload = null;
  let metaExtras = {};

  if (isNativeClient) {
    const relData = await collectClientRelationalSnapshotData(sb, clientRow);
    snapshotPayload = {
      formatVersion: 2,
      snapshotId,
      clientName: canonicalName,
      clientId: clientRow.id,
      createdAt: nowIso,
      createdBy,
      triggerType,
      label: String(label || "").trim(),
      config: keyInfoRow || null,
      tables: relData.tables,
      tableCounts: relData.tableCounts,
      totalRelationalRows: relData.totalRelationalRows,
      tabs: [],
    };
    metaExtras = {
      formatVersion: 2,
      totalRelationalRows: relData.totalRelationalRows,
      tableCounts: relData.tableCounts,
      masterTabCount: 0,
      reconTabCount: relData.tableCounts.bank_recon_periods || 0,
      clientTabCount: relData.tableCounts.pulse_client_tab_blueprints || 0,
      tabsByRole: { master: [], recon: [], client: [] },
    };
  } else {
    // Legacy Format v1: Fetch tab metadata from master_sheet_grids in parallel batches of 6
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

    snapshotPayload = {
      formatVersion: 1,
      snapshotId,
      clientName: canonicalName,
      clientId: clientRow?.id || null,
      createdAt: nowIso,
      createdBy,
      triggerType,
      label: String(label || "").trim(),
      config: keyInfoRow || null,
      tabs,
    };
    metaExtras = {
      formatVersion: 1,
      masterTabCount: tabsByRole.master.length,
      reconTabCount: tabsByRole.recon.length,
      clientTabCount: tabsByRole.client.length,
      tabsByRole,
    };
  }

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
    ...metaExtras,
    rawBytes: rawBuffer.length,
    compressedBytes: compressedBuffer.length,
  };

  await withBackupIndexLock_(async () => {
    const currentIndex = await readBackupIndex_(sb);
    const nextIndex = [entry, ...currentIndex.filter((s) => s.id !== snapshotId)];
    await writeBackupIndex_(sb, nextIndex, createdBy);
  });

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
  const rawJson = zlib.gunzipSync(compressedBuf, { maxOutputLength: MAX_ZLIB_OUTPUT_BYTES }).toString("utf8");
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
    const rawStr = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf, { maxOutputLength: MAX_ZLIB_OUTPUT_BYTES }).toString("utf8") : buf.toString("utf8");
    payload = JSON.parse(rawStr);
  }

  if (!payload || (payload.formatVersion !== 2 && !Array.isArray(payload.tabs))) {
    throw new Error("Invalid snapshot file: missing tabs array or formatVersion 2 tables.");
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

  const DISALLOWED_TAB_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  const tabsByRole = { master: [], recon: [], client: [] };
  let normalizedPayload = null;
  let extraMeta = {};

  if (payload.formatVersion === 2 && payload.tables && typeof payload.tables === "object") {
    const safeTables = Object.create(null);
    const safeCounts = Object.create(null);
    let totalRows = 0;
    for (const { table } of RELATIONAL_BACKUP_TABLES) {
      if (DISALLOWED_TAB_KEYS.has(table)) continue;
      const arr = Array.isArray(payload.tables[table]) ? payload.tables[table] : [];
      safeTables[table] = arr;
      safeCounts[table] = arr.length;
      totalRows += arr.length;
    }
    normalizedPayload = {
      ...payload,
      formatVersion: 2,
      snapshotId,
      clientName: canonicalName,
      tables: safeTables,
      tableCounts: safeCounts,
      totalRelationalRows: totalRows,
      tabs: [],
      importedAt: nowIso,
      importedBy,
    };
    extraMeta = {
      formatVersion: 2,
      totalRelationalRows: totalRows,
      tableCounts: safeCounts,
      masterTabCount: 0,
      reconTabCount: safeCounts.bank_recon_periods || 0,
      clientTabCount: safeCounts.pulse_client_tab_blueprints || 0,
    };
  } else {
    const MAX_SNAPSHOT_ROWS = 50000;
    const MAX_SNAPSHOT_COLS = 600;
    for (const t of payload.tabs) {
      if (!t || typeof t !== "object") {
        throw new Error("Invalid snapshot file: each tab entry must be an object.");
      }
      const tabName = t.tab_name;
      if (
        typeof tabName !== "string" ||
        tabName.length < 1 ||
        tabName.length > 100 ||
        DISALLOWED_TAB_KEYS.has(tabName) ||
        /[\x00-\x1f\x7f]/.test(tabName)
      ) {
        throw new Error("Invalid snapshot file: invalid tab_name.");
      }
      const valuesGrid = Array.isArray(t.values_grid) ? t.values_grid : [];
      if (valuesGrid.length > MAX_SNAPSHOT_ROWS) {
        throw new Error(`Invalid snapshot file: tab "${tabName}" exceeds ${MAX_SNAPSHOT_ROWS} rows.`);
      }
      for (const row of valuesGrid) {
        if (Array.isArray(row) && row.length > MAX_SNAPSHOT_COLS) {
          throw new Error(`Invalid snapshot file: tab "${tabName}" exceeds ${MAX_SNAPSHOT_COLS} columns.`);
        }
      }
      if (tabsByRole[t.sheet_role]) {
        tabsByRole[t.sheet_role].push(tabName);
      }
    }

    normalizedPayload = {
      ...payload,
      formatVersion: 1,
      snapshotId,
      clientName: canonicalName,
      importedAt: nowIso,
      importedBy,
    };
    extraMeta = {
      formatVersion: 1,
      masterTabCount: tabsByRole.master.length,
      reconTabCount: tabsByRole.recon.length,
      clientTabCount: tabsByRole.client.length,
    };
  }

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
    ...extraMeta,
    tabsByRole,
    rawBytes: rawBuffer.length,
    compressedBytes: compressedBuffer.length,
  };

  await withBackupIndexLock_(async () => {
    const currentIndex = await readBackupIndex_(sb);
    const nextIndex = [entry, ...currentIndex.filter((s) => s.id !== snapshotId)];
    await writeBackupIndex_(sb, nextIndex, importedBy);
  });

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
  skipSheetBridgeSync = false,
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

  if (!payload || (payload.formatVersion !== 2 && !Array.isArray(payload.tabs))) {
    throw new Error("Invalid snapshot format: missing tabs array or formatVersion 2 tables.");
  }

  const targetClientName = String(clientNameOverride || payload.clientName || "").trim();
  if (!targetClientName) {
    throw new Error("Snapshot does not specify a target clientName.");
  }

  const { data: cfgRow } = await sb
    .from("clients")
    .select("id, client_name, grid_storage_retired, client_sheet_id, master_sheet_id, metadata")
    .ilike("client_name", escapeIlikeExact(targetClientName))
    .maybeSingle();

  const canonicalClient = cfgRow?.client_name || targetClientName;
  const clientId = cfgRow?.id || payload.clientId || null;

  if (payload.formatVersion !== 2 && cfgRow?.grid_storage_retired) {
    throw new Error(
      `Cannot restore legacy Format v1 grid snapshot onto "${canonicalClient}" because grid storage is retired. Restore a Format v2 relational snapshot instead.`
    );
  }

  if (payload.formatVersion === 2 && payload.tables && typeof payload.tables === "object") {
    if (!clientId) {
      throw new Error(`Cannot restore Format v2 snapshot for "${canonicalClient}" without a valid client_id.`);
    }
    if (scope === "single_tab") {
      throw new Error("Single-tab restore is only supported for legacy grid snapshots; use 'all', 'client', or 'master_recon' for Format v2 relational snapshots.");
    }

    const allowedDomains =
      scope === "client"
        ? new Set(["client"])
        : scope === "master_recon"
          ? new Set(["master", "recon"])
          : new Set(["master", "recon", "client"]);

    const isSameClientTarget = Boolean(
      payload.clientName && normalizeClientKey_(payload.clientName) === normalizeClientKey_(canonicalClient)
    );
    const shouldRemapUuids = !isSameClientTarget || Boolean(payload.clientId && payload.clientId !== clientId);
    const hasNotesInSnapshot = Array.isArray(payload.tables.pulse_notes);
    const targetTables = RELATIONAL_BACKUP_TABLES.filter(
      (t) => (!t.keyedBy || t.keyedBy === "client_id") && allowedDomains.has(t.domain)
    );

    let preRestoreSnapshot = null;
    if (createPreRestoreBackup) {
      try {
        preRestoreSnapshot = await createClientSnapshot({
          clientName: canonicalClient,
          triggerType: "pre_restore",
          label: `Auto-saved before restoring ${scope} (v2) from ${(payload.createdAt || "").slice(0, 16).replace("T", " ")}`,
          createdBy: restoredBy,
        });
      } catch (preErr) {
        console.warn("[supabaseBackupService] Could not create pre-restore safety snapshot:", preErr.message);
      }
    }

    // Pre-v2.350 compatibility: snapshot live pulse_notes FKs before parent deletes if snapshot lacks pulse_notes
    let preservedNotesFks = [];
    if (allowedDomains.has("client") && !hasNotesInSnapshot) {
      preservedNotesFks = await fetchPaginatedEq_(sb, "pulse_notes", "client_id", clientId, "id").catch(() => []);
    }

    // Partial-scope restores (`scope = "client"` or `"master_recon"`): snapshot cross-domain FKs held on the surviving side before parent DELETE sets them NULL via ON DELETE SET NULL
    let preservedCrmDealsJobFks = [];
    let preservedTimeEntriesEmpFks = [];
    let preservedJobInvAccFks = [];
    let preservedJobExpDcFks = [];
    let preservedContractorDcFks = [];
    if (allowedDomains.has("client") && !allowedDomains.has("master")) {
      const [crmSnap, timeSnap] = await Promise.all([
        fetchPaginatedEq_(sb, "crm_deals_raw", "client_id", clientId, "id, matched_job_id").catch(() => []),
        fetchPaginatedEq_(sb, "time_entries_raw", "client_id", clientId, "id, employee_id").catch(() => []),
      ]);
      preservedCrmDealsJobFks = crmSnap.filter((r) => Boolean(r.matched_job_id));
      preservedTimeEntriesEmpFks = timeSnap.filter((r) => Boolean(r.employee_id));
    }
    if (allowedDomains.has("master") && !allowedDomains.has("client")) {
      const [jiSnap, jeSnap, ceSnap] = await Promise.all([
        fetchPaginatedEq_(sb, "pulse_job_invoices", "client_id", clientId, "id, accounting_invoice_id").catch(() => []),
        fetchPaginatedEq_(sb, "pulse_job_expenses", "client_id", clientId, "id, accounting_direct_cost_id").catch(() => []),
        fetchPaginatedEq_(sb, "pulse_contractor_entries", "client_id", clientId, "id, accounting_direct_cost_id").catch(() => []),
      ]);
      preservedJobInvAccFks = jiSnap.filter((r) => Boolean(r.accounting_invoice_id));
      preservedJobExpDcFks = jeSnap.filter((r) => Boolean(r.accounting_direct_cost_id));
      preservedContractorDcFks = ceSnap.filter((r) => Boolean(r.accounting_direct_cost_id));
    }

    // 1. Delete existing rows in reverse topological order (child tables before parents)
    if (allowedDomains.has("client")) {
      if (hasNotesInSnapshot) {
        const existingNotes = await fetchPaginatedEq_(sb, "pulse_notes", "client_id", clientId, "id").catch(() => []);
        const oldNoteIds = existingNotes.map((n) => n?.id).filter(Boolean);
        for (let i = 0; i < oldNoteIds.length; i += 200) {
          const { error: repDelErr } = await sb
            .from("pulse_note_replies")
            .delete()
            .in("note_id", oldNoteIds.slice(i, i + 200));
          if (repDelErr) throw new Error(`Format v2 restore delete failed on pulse_note_replies: ${repDelErr.message}`);
        }
      }
      for (const tbl of CLIENT_NAME_BACKUP_TABLES) {
        if (!Array.isArray(payload.tables[tbl])) continue;
        const { error: cnDelErr } = await sb.from(tbl).delete().eq("client_name", canonicalClient);
        if (cnDelErr) throw new Error(`Format v2 restore delete failed on ${tbl}: ${cnDelErr.message}`);
      }
    }

    for (const { table } of [...targetTables].reverse()) {
      if (table === "pulse_notes" && !hasNotesInSnapshot) continue;
      const { error: delErr } = await sb.from(table).delete().eq("client_id", clientId);
      if (delErr) {
        throw new Error(`Format v2 restore delete failed on ${table}: ${delErr.message}`);
      }
    }

    // Cross-client UUID remap table so importing Client A onto Client B never collides on PKs
    const uuidRemap = new Map();
    const fkCols = [
      "retainer_series_id",
      "job_id",
      "matched_job_id",
      "employee_id",
      "outgoing_item_id",
      "contractor_entry_id",
      "note_id",
      "period_id",
      "accounting_invoice_id",
      "accounting_direct_cost_id",
    ];
    if (shouldRemapUuids) {
      for (const { table } of targetTables) {
        for (const row of Array.isArray(payload.tables[table]) ? payload.tables[table] : []) {
          if (row?.id) uuidRemap.set(row.id, randomUUID());
        }
      }
      for (const tbl of ["pulse_note_replies", ...CLIENT_NAME_BACKUP_TABLES]) {
        for (const row of Array.isArray(payload.tables[tbl]) ? payload.tables[tbl] : []) {
          if (row?.id) uuidRemap.set(row.id, randomUUID());
        }
      }
    }

    // For partial-scope restores (e.g. scope = "client" or "master_recon"), validate cross-domain nullable FKs against live surviving parent IDs
    const liveCrossDomainIds = {
      pulse_jobs: null,
      pulse_employees: null,
      accounting_invoices: null,
      accounting_direct_costs: null,
    };
    if (!allowedDomains.has("client")) {
      const [jobsLive, empLive] = await Promise.all([
        fetchPaginatedEq_(sb, "pulse_jobs", "client_id", clientId, "id").catch(() => []),
        fetchPaginatedEq_(sb, "pulse_employees", "client_id", clientId, "id").catch(() => []),
      ]);
      liveCrossDomainIds.pulse_jobs = new Set(jobsLive.map((r) => r.id).filter(Boolean));
      liveCrossDomainIds.pulse_employees = new Set(empLive.map((r) => r.id).filter(Boolean));
    }
    if (!allowedDomains.has("master")) {
      const [invLive, dcLive] = await Promise.all([
        fetchPaginatedEq_(sb, "accounting_invoices", "client_id", clientId, "id").catch(() => []),
        fetchPaginatedEq_(sb, "accounting_direct_costs", "client_id", clientId, "id").catch(() => []),
      ]);
      liveCrossDomainIds.accounting_invoices = new Set(invLive.map((r) => r.id).filter(Boolean));
      liveCrossDomainIds.accounting_direct_costs = new Set(dcLive.map((r) => r.id).filter(Boolean));
    }

    const canonicalNormKey = normalizeClientKey_(canonicalClient);
    const sanitizeAndStampRow_ = (row, tableName, rowIdx = 0) => {
      const clean = Object.create(null);
      for (const [k, v] of Object.entries(row || {})) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
        clean[k] = v;
      }
      if (shouldRemapUuids && clean.id) {
        clean.id = uuidRemap.get(clean.id) || randomUUID();
      }
      if (shouldRemapUuids) {
        for (const fkCol of fkCols) {
          if (clean[fkCol]) {
            clean[fkCol] = uuidRemap.has(clean[fkCol]) ? uuidRemap.get(clean[fkCol]) : null;
          }
        }
        if ("normalized_key" in clean) {
          clean.normalized_key = canonicalNormKey;
        }
      }
      if (!isSameClientTarget && (tableName === "alert_memory" || tableName === "pma_tasks") && clean.fingerprint_hash) {
        clean.fingerprint_hash = createHash("sha256")
          .update(`${canonicalClient}::${clean.fingerprint_hash}`)
          .digest("hex")
          .slice(0, 16);
        if (tableName === "pma_tasks" && clean.task_key) {
          clean.task_key = `${canonicalNormKey}::${clean.fingerprint_hash}`;
        }
      }
      if (
        (tableName === "accounting_invoices" ||
          tableName === "accounting_direct_costs" ||
          tableName === "crm_deals_raw") &&
        (clean.sheet_row_num === null || clean.sheet_row_num === undefined)
      ) {
        clean.sheet_row_num = rowIdx + 2;
      }
      if (!allowedDomains.has("client")) {
        if (clean.matched_job_id && !liveCrossDomainIds.pulse_jobs?.has(clean.matched_job_id)) {
          clean.matched_job_id = null;
        }
        if (clean.employee_id && !liveCrossDomainIds.pulse_employees?.has(clean.employee_id)) {
          clean.employee_id = null;
        }
      }
      if (!allowedDomains.has("master")) {
        if (clean.accounting_invoice_id && !liveCrossDomainIds.accounting_invoices?.has(clean.accounting_invoice_id)) {
          clean.accounting_invoice_id = null;
        }
        if (clean.accounting_direct_cost_id && !liveCrossDomainIds.accounting_direct_costs?.has(clean.accounting_direct_cost_id)) {
          clean.accounting_direct_cost_id = null;
        }
      }
      if ("client_id" in clean || tableName !== "pulse_note_replies") {
        clean.client_id = clientId;
      }
      if (tableName === "pulse_note_replies") {
        delete clean.client_id;
      }
      if ("client_name" in clean) clean.client_name = canonicalClient;
      if (tableName === "pulse_automation_logs" || tableName === "pulse_execution_logs") {
        delete clean.sort_seq;
      }
      return clean;
    };

    // 2. Insert restored rows in forward topological order (parents before children)
    const nowIsoV2 = new Date().toISOString();
    let restoredRowsCount = 0;
    const restoredParentIds = {
      pulse_jobs: new Set(),
      pulse_employees: new Set(),
      pulse_outgoing_items: new Set(),
      pulse_contractor_entries: new Set(),
      accounting_invoices: new Set(),
      accounting_direct_costs: new Set(),
    };

    for (const { table } of targetTables) {
      if (table === "pulse_notes" && !hasNotesInSnapshot) continue;
      let srcRows = Array.isArray(payload.tables[table]) ? payload.tables[table] : [];
      if (srcRows.length === 0) continue;
      if (table === "pulse_automation_logs" || table === "pulse_execution_logs") {
        srcRows = sortChronologicalLogs_(table, srcRows);
      }
      const stamped = srcRows.map((row, idx) => {
        const clean = sanitizeAndStampRow_(row, table, idx);
        if (restoredParentIds[table] && clean.id) restoredParentIds[table].add(clean.id);
        return clean;
      });
      for (let i = 0; i < stamped.length; i += 200) {
        const chunk = stamped.slice(i, i + 200);
        const { error: insErr } = await sb.from(table).insert(chunk);
        if (insErr) {
          throw new Error(`Format v2 restore insert failed on ${table}: ${insErr.message}`);
        }
      }
      restoredRowsCount += stamped.length;
    }

    if (allowedDomains.has("client")) {
      if (hasNotesInSnapshot && Array.isArray(payload.tables.pulse_note_replies) && payload.tables.pulse_note_replies.length > 0) {
        const stampedReplies = payload.tables.pulse_note_replies.map((r) => sanitizeAndStampRow_(r, "pulse_note_replies"));
        for (let i = 0; i < stampedReplies.length; i += 200) {
          const { error: repInsErr } = await sb.from("pulse_note_replies").insert(stampedReplies.slice(i, i + 200));
          if (repInsErr) throw new Error(`Format v2 restore insert failed on pulse_note_replies: ${repInsErr.message}`);
        }
        restoredRowsCount += stampedReplies.length;
      }

      for (const tbl of CLIENT_NAME_BACKUP_TABLES) {
        const extraRows = Array.isArray(payload.tables[tbl]) ? payload.tables[tbl] : [];
        if (extraRows.length === 0) continue;
        const stampedExtra = extraRows.map((row) => {
          const clean = sanitizeAndStampRow_(row, tbl);
          delete clean.client_id;
          clean.client_name = canonicalClient;
          return clean;
        });
        for (let i = 0; i < stampedExtra.length; i += 200) {
          const { error: exInsErr } = await sb.from(tbl).insert(stampedExtra.slice(i, i + 200));
          if (exInsErr) throw new Error(`Format v2 restore insert failed on ${tbl}: ${exInsErr.message}`);
        }
        restoredRowsCount += stampedExtra.length;
      }

      // Restore surviving FK links on pre-v2.350 live notes after parent deletes/inserts
      if (!hasNotesInSnapshot && preservedNotesFks.length > 0) {
        for (const note of preservedNotesFks) {
          const nextJobId = note.job_id && restoredParentIds.pulse_jobs.has(note.job_id) ? note.job_id : null;
          const nextEmpId = note.employee_id && restoredParentIds.pulse_employees.has(note.employee_id) ? note.employee_id : null;
          const nextOutId = note.outgoing_item_id && restoredParentIds.pulse_outgoing_items.has(note.outgoing_item_id) ? note.outgoing_item_id : null;
          const nextConId = note.contractor_entry_id && restoredParentIds.pulse_contractor_entries.has(note.contractor_entry_id) ? note.contractor_entry_id : null;
          if (
            nextJobId !== note.job_id ||
            nextEmpId !== note.employee_id ||
            nextOutId !== note.outgoing_item_id ||
            nextConId !== note.contractor_entry_id ||
            nextJobId || nextEmpId || nextOutId || nextConId
          ) {
            await sb
              .from("pulse_notes")
              .update({
                job_id: nextJobId,
                employee_id: nextEmpId,
                outgoing_item_id: nextOutId,
                contractor_entry_id: nextConId,
              })
              .eq("id", note.id);
          }
        }
      }
    }

    // Re-link surviving cross-domain child FKs after partial-scope restore when restored parent IDs match
    if (allowedDomains.has("client") && !allowedDomains.has("master")) {
      for (const row of preservedCrmDealsJobFks) {
        if (restoredParentIds.pulse_jobs.has(row.matched_job_id)) {
          await sb.from("crm_deals_raw").update({ matched_job_id: row.matched_job_id }).eq("id", row.id);
        }
      }
      for (const row of preservedTimeEntriesEmpFks) {
        if (restoredParentIds.pulse_employees.has(row.employee_id)) {
          await sb.from("time_entries_raw").update({ employee_id: row.employee_id }).eq("id", row.id);
        }
      }
    }
    if (allowedDomains.has("master") && !allowedDomains.has("client")) {
      for (const row of preservedJobInvAccFks) {
        if (restoredParentIds.accounting_invoices.has(row.accounting_invoice_id)) {
          await sb.from("pulse_job_invoices").update({ accounting_invoice_id: row.accounting_invoice_id }).eq("id", row.id);
        }
      }
      for (const row of preservedJobExpDcFks) {
        if (restoredParentIds.accounting_direct_costs.has(row.accounting_direct_cost_id)) {
          await sb.from("pulse_job_expenses").update({ accounting_direct_cost_id: row.accounting_direct_cost_id }).eq("id", row.id);
        }
      }
      for (const row of preservedContractorDcFks) {
        if (restoredParentIds.accounting_direct_costs.has(row.accounting_direct_cost_id)) {
          await sb.from("pulse_contractor_entries").update({ accounting_direct_cost_id: row.accounting_direct_cost_id }).eq("id", row.id);
        }
      }
    }

    const keyInfoPayloadV2 = payload.config?.keyInfo || (payload.config && !payload.config.master_mode ? payload.config : null);
    if (keyInfoPayloadV2 && typeof keyInfoPayloadV2 === "object" && (scope === "all" || scope === "master_recon")) {
      const cleanKi = {
        client_id: clientId,
        client_name: canonicalClient,
        normalized_key: normalizeClientKey_(canonicalClient),
        updated_at: nowIsoV2,
      };
      for (const field of ALLOWED_TENANT_KEY_INFO_FIELDS) {
        if (keyInfoPayloadV2[field] !== undefined) {
          cleanKi[field] = keyInfoPayloadV2[field];
        }
      }
      const { error: kiErr } = await sb.from("tenant_key_info").upsert([cleanKi], { onConflict: "client_id" });
      if (kiErr) {
        console.warn(`[supabaseBackupService] Could not restore tenant_key_info for ${canonicalClient}:`, kiErr.message);
      }
    }

    invalidateMasterEngineCache(canonicalClient, null, null, { invalidateSheetContext: true });
    await Promise.all([
      import("./relationalMasterService.js").then((m) => m.invalidateClientRelationalMasterCache(canonicalClient)).catch(() => { }),
      import("./relationalReconService.js").then((m) => m.invalidateClientRelationalReconCache(canonicalClient)).catch(() => { }),
      import("./relationalJobsService.js").then((m) => m.invalidateClientRelationalJobsCache?.(canonicalClient)).catch(() => { }),
      import("./relationalInputsService.js").then((m) => m.invalidateClientRelationalInputsCache?.(canonicalClient)).catch(() => { }),
      import("./relationalFinancialsService.js").then((m) => m.invalidateClientRelationalFinancialsCache?.(canonicalClient)).catch(() => { }),
      import("./nativeClientCalcService.js").then((m) => m.invalidateClientNativeCalcCache?.(canonicalClient)).catch(() => { }),
      import("./nativeMasterComparisonService.js").then((m) => m.invalidateClientMasterCompCache?.(canonicalClient)).catch(() => { }),
      cfgRow?.client_sheet_id
        ? import("./cacheService.js").then((m) => m.invalidatePmaClientCache(cfgRow.client_sheet_id, cfgRow.master_sheet_id || null, ["all"])).catch(() => { })
        : Promise.resolve(),
    ]);

    const isLiveBridgedTarget =
      !skipSheetBridgeSync &&
      String(cfgRow?.metadata?.sheet_bridge_mode || "").trim().toLowerCase() === "live" &&
      Boolean(cfgRow?.client_sheet_id) &&
      !String(cfgRow.client_sheet_id).startsWith("sb-");
    let sheetBridgeSyncWarning = null;
    if (isLiveBridgedTarget && allowedDomains.has("client")) {
      await import("./clientSheetBridgeService.js")
        .then((m) => m.pushSupabaseClientToSheet(canonicalClient))
        .catch((bridgeErr) => {
          sheetBridgeSyncWarning = bridgeErr.message || "Sheet bridge sync failed";
          console.warn(`[supabaseBackupService] Post-restore Google Sheet bridge sync warning (${canonicalClient}):`, bridgeErr.message);
        });
    }

    return {
      formatVersion: 2,
      clientName: canonicalClient,
      sourceSnapshotId: sourceEntry?.id || payload.snapshotId || "uploaded",
      sourceCreatedAt: payload.createdAt || null,
      scope,
      restoredTablesCount: targetTables.length,
      restoredTabsCount: restoredRowsCount,
      restoredRowsCount,
      restoredMasterCount: 0,
      restoredReconCount: Array.isArray(payload.tables.bank_recon_periods) ? payload.tables.bank_recon_periods.length : 0,
      restoredClientCount: Array.isArray(payload.tables.pulse_client_tab_blueprints) ? payload.tables.pulse_client_tab_blueprints.length : 0,
      preRestoreSnapshotId: preRestoreSnapshot?.id || null,
      ...(sheetBridgeSyncWarning ? { sheetBridgeSyncWarning } : {}),
    };
  }

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
        const rawVals = Array.isArray(tab.values_grid) ? tab.values_grid : [];
        if (rawVals.length > MAX_RESTORE_GRID_ROWS || rawVals.some((r) => Array.isArray(r) && r.length > MAX_RESTORE_GRID_COLS)) {
          throw new Error(`Restored tab ${tab.sheet_role}:${tab.tab_name} exceeds maximum permitted grid dimensions.`);
        }
        const rawNotes = tab.notes_grid && typeof tab.notes_grid === "object" ? { ...tab.notes_grid } : {};
        if (rawNotes.__compact_meta && typeof rawNotes.__compact_meta === "object") {
          const clampedTotal = Math.min(Math.max(0, Math.trunc(Number(rawNotes.__compact_meta.totalRows) || 0)), MAX_RESTORE_GRID_ROWS);
          const clampedTpl = Math.max(0, Math.min(Math.max(0, rawVals.length - 1), Math.trunc(Number(rawNotes.__compact_meta.templateRowIdx) || 0)));
          rawNotes.__compact_meta = {
            ...rawNotes.__compact_meta,
            totalRows: clampedTotal,
            templateRowIdx: clampedTpl,
          };
        }
        const legacyEmbeddedForms = Array.isArray(rawNotes.__formulas_grid) ? rawNotes.__formulas_grid : null;
        if (tab.sheet_role === "client") {
          delete rawNotes.__formulas_grid;
        }
        const resolvedFormulas =
          Array.isArray(tab.formulas_grid) && tab.formulas_grid.length > 0
            ? tab.formulas_grid
            : tab.sheet_role === "client" && legacyEmbeddedForms
              ? legacyEmbeddedForms
              : Array.isArray(tab.formulas_grid)
                ? tab.formulas_grid
                : null;
        if (resolvedFormulas && (resolvedFormulas.length > MAX_RESTORE_GRID_ROWS || resolvedFormulas.some((r) => Array.isArray(r) && r.length > MAX_RESTORE_GRID_COLS))) {
          throw new Error(`Restored formulas for ${tab.sheet_role}:${tab.tab_name} exceed maximum permitted grid dimensions.`);
        }
        const record = {
          client_id: clientId,
          client_name: canonicalClient,
          sheet_role: tab.sheet_role,
          tab_name: tab.tab_name,
          values_grid: rawVals,
          formulas_grid: resolvedFormulas,
          notes_grid: rawNotes,
          row_count: Math.min(Math.max(0, Number(tab.row_count) || rawVals.length), MAX_RESTORE_GRID_ROWS),
          col_count: Math.min(Math.max(0, Number(tab.col_count) || 0), MAX_RESTORE_GRID_COLS),
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

  // Restore tenant_key_info config when restoring full workbook or master+recon
  const keyInfoPayload = payload.config?.keyInfo || (payload.config && !payload.config.master_mode ? payload.config : null);
  if (keyInfoPayload && typeof keyInfoPayload === "object" && (scope === "all" || scope === "master_recon") && clientId) {
    const cleanKi = {
      client_id: clientId,
      client_name: canonicalClient,
      normalized_key: normalizeClientKey_(canonicalClient),
      updated_at: nowIso,
    };
    for (const field of ALLOWED_TENANT_KEY_INFO_FIELDS) {
      if (keyInfoPayload[field] !== undefined) {
        cleanKi[field] = keyInfoPayload[field];
      }
    }
    const { error: kiErr } = await sb
      .from("tenant_key_info")
      .upsert([cleanKi], { onConflict: "client_id" });
    if (kiErr) {
      console.warn(`[supabaseBackupService] Could not restore tenant_key_info for ${canonicalClient}:`, kiErr.message);
    }
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

  const { target, remainingCount } = await withBackupIndexLock_(async () => {
    const index = await readBackupIndex_(sb);
    const found = index.find((s) => s.id === snapshotId);
    if (!found) {
      throw new Error(`Snapshot "${snapshotId}" not found.`);
    }
    const nextIndex = index.filter((s) => s.id !== snapshotId);
    await writeBackupIndex_(sb, nextIndex, deletedBy);
    return { target: found, remainingCount: nextIndex.length };
  });

  if (target.storagePath) {
    await sb.storage.from(BACKUP_BUCKET).remove([target.storagePath]).catch((err) => {
      console.warn("[supabaseBackupService] Storage remove warning:", err.message);
    });
  }

  return { deletedSnapshot: target, remainingCount };
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

  await ensureRedisConnected(1000).catch(() => { });
  const lockKey = "pulse:lock:daily_backup_sweep";
  const sweepLockToken = randomUUID();
  let lockAcquired = false;
  if (redisClient?.isOpen) {
    try {
      const lockRes = await redisClient.set(lockKey, sweepLockToken, { NX: true, EX: 900 });
      lockAcquired = lockRes === "OK";
      if (!lockAcquired) {
        return { skipped: true, reason: "Daily backup sweep already in progress on another instance." };
      }
    } catch (_) { }
  }

  try {
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

    // Discover active Supabase-mode clients directly from `clients` (no master_sheet_grids scan)
    const activeSupaNames = [];
    for (let from = 0; ; from += 1000) {
      const { data: cPage, error: cErr } = await sb
        .from("clients")
        .select("id, client_name, status, client_mode, master_mode, metadata")
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (cErr || !Array.isArray(cPage) || cPage.length === 0) break;
      for (const c of cPage) {
        const st = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
        if (st === "archived" || !c.client_name) continue;
        if (c.client_mode === "supabase" || c.master_mode === "supabase") {
          activeSupaNames.push(String(c.client_name).trim());
        }
      }
      if (cPage.length < 1000) break;
    }

    const uniqueClients = Array.from(new Set(activeSupaNames.filter(Boolean))).sort((a, b) => a.localeCompare(b));

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
    const expiredAutoSnapshots = await withBackupIndexLock_(async () => {
      const updatedIndex = await readBackupIndex_(sb);
      const expired = updatedIndex.filter(
        (s) =>
          (s.triggerType === "daily_auto" || s.triggerType === "pre_restore") &&
          new Date(s.createdAt || 0).getTime() < cutoffMs
      );
      if (expired.length > 0) {
        const expiredIds = new Set(expired.map((s) => s.id));
        const surviving = updatedIndex.filter((s) => !expiredIds.has(s.id));
        await writeBackupIndex_(sb, surviving, triggeredBy);
      }
      return expired;
    });

    if (expiredAutoSnapshots.length > 0) {
      const pathsToRemove = expiredAutoSnapshots.map((s) => s.storagePath).filter(Boolean);
      if (pathsToRemove.length > 0) {
        await sb.storage.from(BACKUP_BUCKET).remove(pathsToRemove).catch(() => { });
      }
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
  } finally {
    if (lockAcquired && redisClient?.isOpen) {
      await redisClient.eval(RELEASE_BACKUP_LOCK_LUA, {
        keys: [lockKey],
        arguments: [sweepLockToken],
      }).catch(() => { });
    }
  }
}
