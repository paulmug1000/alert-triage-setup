/**
 * ============================================================================
 * TENANT RENAME SERVICE
 * ============================================================================
 * Safely renames a tenant across all Supabase tables, virtual/real KeyInfo
 * tabs, AES-256-GCM AAD-bound vault credentials, user assignments,
 * system_config blobs, and in-memory / Redis caches.
 * ============================================================================
 */

import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import { redisClient, ensureRedisConnected } from "./redisClient.js";
import { encryptPayload, decryptPayload, invalidateIntegrationsCache } from "./vaultService.js";
import { invalidateUsersCache, getCanonicalAcSheetId } from "./userPermissions.js";
import { clearAllClientsMemoryCache } from "./workspaces.js";
import { clearSsrClientsMemoryCache } from "./ssrSession.js";
import { invalidateMasterEngineCache } from "./masterEngineService.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import { flushAllAlertMemoryCaches } from "./alertMemory.js";
import { invalidatePrecomputedMemoryCache } from "./triageEngine.js";
import { RELATIONAL_BACKUP_TABLES } from "./supabaseBackupService.js";

const CLIENT_NAME_ONLY_TABLES = [
  "activity_logs",
  "pulse_notes",
  "accounting_invoices",
  "accounting_direct_costs",
  "accounting_pl_lines",
  "crm_deals_raw",
  "time_entries_raw",
  "bank_recon_periods",
  "bank_recon_items",
  "bank_recon_learning_map",
  "client_jobs",
  "client_outgoings",
  "client_salaries",
  "client_budgets_and_targets",
  "client_cash_balances",
];

const SYSTEM_CONFIG_KEYS = [
  "eom_reporting_control_state",
  "eom_revenue_checks_state",
  "amd_tab_error_notifications",
  "supabase_client_backups_index",
  "client_parity_monitor_state",
  "assigned_expenses_state",
];

export function normalizeTenantClientKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

function getVaultRedisKey_(clientKey, tool) {
  return `pulse:vault:client:${normalizeTenantClientKey(clientKey)}:${normalizeTenantClientKey(tool)}`;
}

function getSheetIndexRedisKey_(masterSheetId, tool) {
  return `pulse:vault:sheet:${String(masterSheetId).trim()}:${normalizeTenantClientKey(tool)}`;
}

function replaceSnapshotClientName_(rawValue, oldClientName, newClientName) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return { changed: false, value: rawValue };
  }
  const isString = typeof rawValue === "string";
  let parsed = rawValue;
  if (isString) {
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      return { changed: false, value: rawValue };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { changed: false, value: rawValue };
  }
  let changed = false;
  const next = { ...parsed };
  if (next.clientName === oldClientName) {
    next.clientName = newClientName;
    changed = true;
  }
  if (next.client_name === oldClientName) {
    next.client_name = newClientName;
    changed = true;
  }
  if (!changed) return { changed: false, value: rawValue };
  return { changed: true, value: isString ? JSON.stringify(next) : next };
}

const FORBIDDEN_PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function renameClientReferencesRecursive_(node, oldClientName, newClientName) {
  if (Array.isArray(node)) {
    let anyChanged = false;
    const mapped = node.map((item) => {
      const res = renameClientReferencesRecursive_(item, oldClientName, newClientName);
      if (res.changed) anyChanged = true;
      return res.value;
    });
    return { changed: anyChanged, value: anyChanged ? mapped : node };
  }
  if (!node || typeof node !== "object") {
    return { changed: false, value: node };
  }
  let anyChanged = false;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    const nextKey = k === oldClientName ? newClientName : k;
    if (FORBIDDEN_PROTO_KEYS.has(k) || FORBIDDEN_PROTO_KEYS.has(nextKey)) {
      anyChanged = true;
      continue;
    }
    if (nextKey !== k) anyChanged = true;
    if (v === oldClientName && (k === "clientName" || k === "client_name" || k === "client")) {
      out[nextKey] = newClientName;
      anyChanged = true;
    } else {
      const child = renameClientReferencesRecursive_(v, oldClientName, newClientName);
      if (child.changed) anyChanged = true;
      out[nextKey] = child.value;
    }
  }
  return { changed: anyChanged, value: anyChanged ? out : node };
}

function patchGridB1Cell_(grid, newClientName) {
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0])) {
    return { changed: false, grid };
  }
  if (grid[0][1] === newClientName) {
    return { changed: false, grid };
  }
  const cloned = grid.map((row, idx) => (idx === 0 && Array.isArray(row) ? [...row] : row));
  cloned[0][1] = newClientName;
  return { changed: true, grid: cloned };
}

function clearGridB1FormulaCell_(grid) {
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0])) {
    return { changed: false, grid };
  }
  const current = grid[0][1];
  if (current === undefined || current === null || current === "") {
    return { changed: false, grid };
  }
  const cloned = grid.map((row, idx) => (idx === 0 && Array.isArray(row) ? [...row] : row));
  cloned[0][1] = "";
  return { changed: true, grid: cloned };
}

function decryptWithCandidates_(ciphertext, cleanTool, aadCandidates) {
  let lastErr = null;
  for (const keyCandidate of aadCandidates) {
    const cleanCandidate = normalizeTenantClientKey(keyCandidate);
    if (!cleanCandidate) continue;
    try {
      return decryptPayload(ciphertext, `${cleanCandidate}:${cleanTool}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Unable to decrypt tenant integration payload with candidate AAD keys");
}

async function resolveTargetClientRow_(sb, { clientId, oldClientName }) {
  if (clientId) {
    const { data, error } = await sb
      .from("clients")
      .select("*")
      .eq("id", clientId)
      .maybeSingle();
    if (error) throw new Error(`Failed to look up client by id: ${error.message}`);
    if (data) return data;
  }

  const trimmedOld = String(oldClientName || "").trim();
  if (trimmedOld) {
    const { data: exactData, error: exactErr } = await sb
      .from("clients")
      .select("*")
      .eq("client_name", trimmedOld)
      .maybeSingle();
    if (exactErr) throw new Error(`Failed to look up client "${trimmedOld}": ${exactErr.message}`);
    if (exactData) return exactData;

    const oldNorm = normalizeTenantClientKey(trimmedOld);
    if (oldNorm) {
      const { data: normData, error: normErr } = await sb
        .from("clients")
        .select("*")
        .eq("normalized_key", oldNorm)
        .maybeSingle();
      if (normErr) throw new Error(`Failed to look up client key "${oldNorm}": ${normErr.message}`);
      if (normData) return normData;
    }
  }

  throw new Error("Target client record could not be found.");
}

async function assertNoNameCollision_(sb, { existingId, newClientName, newNormKey }) {
  const { data: allClients, error } = await sb
    .from("clients")
    .select("id, client_name, normalized_key");
  if (error) throw new Error(`Failed to check existing client names: ${error.message}`);

  const lowerNew = newClientName.toLowerCase();
  const conflict = (allClients || []).find((row) => {
    if (row.id === existingId) return false;
    const rowName = String(row.client_name || "").trim().toLowerCase();
    const rowNorm = String(row.normalized_key || normalizeTenantClientKey(row.client_name)).trim();
    return rowName === lowerNew || (newNormKey && rowNorm === newNormKey);
  });

  if (conflict) {
    throw new Error(
      `Another client ("${conflict.client_name}") already uses that name or normalized key ("${conflict.normalized_key}").`
    );
  }
}

async function rekeyTenantIntegrations_({
  sb,
  clientRow,
  oldClientName,
  newClientName,
  oldNormKey,
  newNormKey,
  summary,
}) {
  const candidateKeys = [...new Set([oldNormKey, normalizeTenantClientKey(oldClientName), oldClientName.toLowerCase()].filter(Boolean))];

  const { data: byClientId } = await sb
    .from("tenant_integrations")
    .select("*")
    .eq("client_id", clientRow.id);

  const { data: byClientKey } = await sb
    .from("tenant_integrations")
    .select("*")
    .in("client_key", candidateKeys);

  const uniqueRowsMap = new Map();
  for (const r of [...(byClientId || []), ...(byClientKey || [])]) {
    if (r?.id) uniqueRowsMap.set(r.id, r);
  }
  const rows = [...uniqueRowsMap.values()];
  summary.vaultIntegrationsTotal = rows.length;

  const redisReady = await ensureRedisConnected().catch(() => false);
  const nowIso = new Date().toISOString();

  for (const row of rows) {
    const cleanTool = normalizeTenantClientKey(row.tool);
    if (!cleanTool) continue;

    let parsedPayload = {};
    try {
      parsedPayload = row.encrypted_payload ? JSON.parse(row.encrypted_payload) : {};
    } catch {
      parsedPayload = {};
    }

    const nextPayload = {
      ...parsedPayload,
      tool: parsedPayload.tool || cleanTool,
      clientKey: newNormKey,
      clientName: newClientName,
      masterSheetId: parsedPayload.masterSheetId || row.master_sheet_id || clientRow.master_sheet_id || "",
      updatedAt: nowIso,
    };

    if (nextPayload.encryptedTokens && !nextPayload.isSharedGrant) {
      const oldAadKey = normalizeTenantClientKey(parsedPayload.clientKey || row.client_key || oldNormKey);
      if (oldAadKey !== newNormKey) {
        const decrypted = decryptWithCandidates_(nextPayload.encryptedTokens, cleanTool, [
          parsedPayload.clientKey,
          row.client_key,
          oldNormKey,
          oldClientName,
        ]);
        nextPayload.encryptedTokens = encryptPayload(decrypted, `${newNormKey}:${cleanTool}`);
      }
    }

    const serializedPayload = JSON.stringify(nextPayload);
    const { error: updErr } = await sb
      .from("tenant_integrations")
      .update({
        client_id: clientRow.id,
        client_key: newNormKey,
        encrypted_payload: serializedPayload,
      })
      .eq("id", row.id);
    if (updErr) {
      throw new Error(`Failed to update tenant_integrations (${cleanTool}): ${updErr.message}`);
    }

    if (redisReady && redisClient?.isOpen) {
      const oldRedisKey = getVaultRedisKey_(row.client_key || oldNormKey, cleanTool);
      const newRedisKey = getVaultRedisKey_(newNormKey, cleanTool);
      if (oldRedisKey !== newRedisKey) {
        await redisClient.del(oldRedisKey).catch(() => {});
      }
      await redisClient.set(newRedisKey, serializedPayload).catch(() => {});

      const mId = String(nextPayload.masterSheetId || row.master_sheet_id || clientRow.master_sheet_id || "").trim();
      if (mId) {
        const sheetIdxKey = getSheetIndexRedisKey_(mId, cleanTool);
        await redisClient.set(sheetIdxKey, newRedisKey).catch(() => {});
      }
    }

    summary.vaultIntegrationsUpdated += 1;
  }
}

async function renameKeyedTenantTables_({
  sb,
  clientRow,
  oldClientName,
  newClientName,
  oldNormKey,
  newNormKey,
  summary,
}) {
  const clientUpdateErr = (
    await sb
      .from("clients")
      .update({ client_name: newClientName, normalized_key: newNormKey })
      .eq("id", clientRow.id)
  ).error;
  if (clientUpdateErr) {
    throw new Error(`Failed to update clients table: ${clientUpdateErr.message}`);
  }
  summary.tablesUpdated.push("clients");

  const normKeyTables = ["client_setup_state", "tenant_key_info"];
  for (const table of normKeyTables) {
    const { error: byIdErr } = await sb
      .from(table)
      .update({ client_name: newClientName, normalized_key: newNormKey })
      .eq("client_id", clientRow.id);
    if (byIdErr) throw new Error(`Failed to update ${table} by client_id: ${byIdErr.message}`);

    const { error: byNameErr } = await sb
      .from(table)
      .update({ client_name: newClientName, normalized_key: newNormKey })
      .eq("client_name", oldClientName);
    if (byNameErr) throw new Error(`Failed to update ${table} by client_name: ${byNameErr.message}`);

    if (oldNormKey) {
      await sb
        .from(table)
        .update({ client_name: newClientName, normalized_key: newNormKey })
        .eq("normalized_key", oldNormKey);
    }
    summary.tablesUpdated.push(table);
  }

  for (const table of ["sync_schedules", "master_sheet_grids"]) {
    const { error: byIdErr } = await sb
      .from(table)
      .update({ client_name: newClientName })
      .eq("client_id", clientRow.id);
    if (byIdErr) throw new Error(`Failed to update ${table} by client_id: ${byIdErr.message}`);

    const { error: byNameErr } = await sb
      .from(table)
      .update({ client_name: newClientName })
      .eq("client_name", oldClientName);
    if (byNameErr) throw new Error(`Failed to update ${table} by client_name: ${byNameErr.message}`);
    summary.tablesUpdated.push(table);
  }

  // alert_memory: paginated rename client_name and patch clientName inside data_snapshot JSON
  let alertUpdated = 0;
  let prevAlertFirstId = null;
  for (;;) {
    const { data: alertRows, error: alertReadErr } = await sb
      .from("alert_memory")
      .select("id, data_snapshot")
      .eq("client_name", oldClientName)
      .order("id", { ascending: true })
      .range(0, 999);
    if (alertReadErr) throw new Error(`Failed reading alert_memory for rename: ${alertReadErr.message}`);
    if (!Array.isArray(alertRows) || alertRows.length === 0) break;
    const firstId = alertRows[0]?.id ?? null;
    if (firstId !== null && firstId === prevAlertFirstId) {
      throw new Error(`Pagination stalled while renaming alert_memory for ${oldClientName} (id=${firstId})`);
    }
    prevAlertFirstId = firstId;
    for (const aRow of alertRows) {
      const snapRes = replaceSnapshotClientName_(aRow.data_snapshot, oldClientName, newClientName);
      const patch = { client_name: newClientName };
      if (snapRes.changed) patch.data_snapshot = snapRes.value;
      const { error } = await sb.from("alert_memory").update(patch).eq("id", aRow.id);
      if (error) throw new Error(`Failed to update alert_memory (${aRow.id}): ${error.message}`);
    }
    alertUpdated += alertRows.length;
    if (alertRows.length < 1000) break;
  }
  summary.alertMemoryRowsUpdated = alertUpdated;
  summary.tablesUpdated.push("alert_memory");

  // pma_tasks: paginated rename client_name and patch clientName inside data_snapshot JSONB
  let tasksUpdated = 0;
  let prevTaskFirstId = null;
  for (;;) {
    const { data: taskRows, error: taskReadErr } = await sb
      .from("pma_tasks")
      .select("id, data_snapshot")
      .eq("client_name", oldClientName)
      .order("id", { ascending: true })
      .range(0, 999);
    if (taskReadErr) throw new Error(`Failed reading pma_tasks for rename: ${taskReadErr.message}`);
    if (!Array.isArray(taskRows) || taskRows.length === 0) break;
    const firstId = taskRows[0]?.id ?? null;
    if (firstId !== null && firstId === prevTaskFirstId) {
      throw new Error(`Pagination stalled while renaming pma_tasks for ${oldClientName} (id=${firstId})`);
    }
    prevTaskFirstId = firstId;
    for (const tRow of taskRows) {
      const snapRes = replaceSnapshotClientName_(tRow.data_snapshot, oldClientName, newClientName);
      const patch = { client_name: newClientName };
      if (snapRes.changed) patch.data_snapshot = snapRes.value;
      const { error } = await sb.from("pma_tasks").update(patch).eq("id", tRow.id);
      if (error) throw new Error(`Failed to update pma_tasks (${tRow.id}): ${error.message}`);
    }
    tasksUpdated += taskRows.length;
    if (taskRows.length < 1000) break;
  }
  summary.pmaTasksRowsUpdated = tasksUpdated;
  summary.tablesUpdated.push("pma_tasks");

  // eom_cycles_and_tasks: rename client_name and patch JSONB payloads
  let prevEomFirstId = null;
  for (;;) {
    const { data: eomRows, error: eomReadErr } = await sb
      .from("eom_cycles_and_tasks")
      .select("id, tasks_payload, narrative_payload")
      .eq("client_name", oldClientName)
      .order("id", { ascending: true })
      .range(0, 999);
    if (eomReadErr) {
      summary.warnings.push(`eom_cycles_and_tasks lookup warning: ${eomReadErr.message}`);
      break;
    }
    if (!Array.isArray(eomRows) || eomRows.length === 0) break;
    const firstId = eomRows[0]?.id ?? null;
    if (firstId !== null && firstId === prevEomFirstId) {
      summary.warnings.push(`eom_cycles_and_tasks rename pagination stopped early at id=${firstId}`);
      break;
    }
    prevEomFirstId = firstId;
    for (const eRow of eomRows) {
      const patch = { client_name: newClientName };
      const tRes = renameClientReferencesRecursive_(eRow.tasks_payload, oldClientName, newClientName);
      if (tRes.changed) patch.tasks_payload = tRes.value;
      const nRes = renameClientReferencesRecursive_(eRow.narrative_payload, oldClientName, newClientName);
      if (nRes.changed) patch.narrative_payload = nRes.value;
      const { error: eUpdErr } = await sb.from("eom_cycles_and_tasks").update(patch).eq("id", eRow.id);
      if (eUpdErr) summary.warnings.push(`eom_cycles_and_tasks (${eRow.id}) update warning: ${eUpdErr.message}`);
    }
    if (eomRows.length < 1000) break;
  }
  summary.tablesUpdated.push("eom_cycles_and_tasks");

  for (const table of CLIENT_NAME_ONLY_TABLES) {
    const { error } = await sb
      .from(table)
      .update({ client_name: newClientName })
      .eq("client_name", oldClientName);
    if (error) {
      summary.warnings.push(`Table ${table} update warning: ${error.message}`);
    } else {
      summary.tablesUpdated.push(table);
    }
  }

  // Phase 2-6D relational tables keyed by client_id / client_name
  const seenRelTables = new Set(CLIENT_NAME_ONLY_TABLES);
  for (const { table, keyedBy } of RELATIONAL_BACKUP_TABLES) {
    if (keyedBy && keyedBy !== "client_id") continue;
    if (seenRelTables.has(table)) continue;
    seenRelTables.add(table);
    try {
      const { error: relErr } = await sb
        .from(table)
        .update({ client_name: newClientName })
        .eq("client_id", clientRow.id);
      if (
        relErr &&
        !/42703|42P01|PGRST205|does not exist|schema cache|could not find the table/i.test(
          String(relErr.message || "")
        )
      ) {
        summary.warnings.push(`Relational table ${table} update warning: ${relErr.message}`);
      } else if (!relErr) {
        summary.tablesUpdated.push(table);
      }
    } catch (rErr) {
      summary.warnings.push(`Relational table ${table} update warning: ${rErr.message}`);
    }
  }
}

async function renameUserAssignments_({ sb, oldClientName, newClientName, summary }) {
  const { data: users, error } = await sb
    .from("users")
    .select("id, email, assigned_clients");
  if (error) {
    summary.warnings.push(`Users table lookup warning: ${error.message}`);
    return;
  }

  for (const user of users || []) {
    if (!Array.isArray(user.assigned_clients) || user.assigned_clients.length === 0) continue;
    const hasOld = user.assigned_clients.some((c) => String(c || "").trim() === oldClientName);
    if (!hasOld) continue;

    const updatedList = [];
    const seen = new Set();
    for (const rawEntry of user.assigned_clients) {
      const trimmed = String(rawEntry || "").trim();
      const mapped = trimmed === oldClientName ? newClientName : rawEntry;
      const dedupeKey = String(mapped || "").trim().toLowerCase();
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      updatedList.push(mapped);
    }

    const { error: updErr } = await sb
      .from("users")
      .update({ assigned_clients: updatedList })
      .eq("id", user.id);
    if (updErr) {
      summary.warnings.push(`Failed updating assigned_clients for ${user.email}: ${updErr.message}`);
    } else {
      summary.usersUpdated += 1;
    }
  }
}

async function renameSystemConfigReferences_({ sb, oldClientName, newClientName, oldNormKey, newNormKey, summary }) {
  const { data: rows, error } = await sb
    .from("system_config")
    .select("key, value")
    .in("key", SYSTEM_CONFIG_KEYS);
  if (error) {
    summary.warnings.push(`system_config lookup warning: ${error.message}`);
  } else {
    for (const row of rows || []) {
      const res = renameClientReferencesRecursive_(row.value, oldClientName, newClientName);
      if (!res.changed) continue;
      const { error: updErr } = await sb
        .from("system_config")
        .update({ value: res.value, updated_by: "TenantRename" })
        .eq("key", row.key);
      if (updErr) {
        summary.warnings.push(`system_config[${row.key}] update warning: ${updErr.message}`);
      } else {
        summary.systemConfigKeysUpdated.push(row.key);
      }
    }
  }

  if (oldNormKey && newNormKey && oldNormKey !== newNormKey) {
    const oldBdKey = `cash_bank_breakdowns:${oldNormKey}`;
    const newBdKey = `cash_bank_breakdowns:${newNormKey}`;
    try {
      const { data: bdRow } = await sb
        .from("system_config")
        .select("key, value, description")
        .eq("key", oldBdKey)
        .maybeSingle();
      if (bdRow?.value) {
        const nextVal = {
          ...(typeof bdRow.value === "object" && !Array.isArray(bdRow.value) ? bdRow.value : {}),
          clientName: newClientName,
        };
        const { error: upErr } = await sb.from("system_config").upsert({
          key: newBdKey,
          value: nextVal,
          description: bdRow.description || "Per-month bank balance breakdowns for Cash Row 36",
          updated_by: "TenantRename",
        });
        if (upErr) {
          summary.warnings.push(`system_config[${newBdKey}] upsert warning: ${upErr.message}`);
        } else {
          await sb.from("system_config").delete().eq("key", oldBdKey);
          summary.systemConfigKeysUpdated.push(newBdKey);
        }
      }
    } catch (bdErr) {
      summary.warnings.push(`system_config[${oldBdKey}] rename warning: ${bdErr.message}`);
    }
  }
}

async function updateKeyInfoGridsAndSheets_({
  sb,
  sheets,
  clientRow,
  newClientName,
  summary,
}) {
  const { data: keyInfoRows, error } = await sb
    .from("master_sheet_grids")
    .select("id, sheet_role, values_grid, formulas_grid")
    .eq("client_id", clientRow.id)
    .eq("tab_name", "KeyInfo");

  if (error) {
    summary.warnings.push(`KeyInfo grid lookup warning: ${error.message}`);
  } else {
    for (const row of keyInfoRows || []) {
      const nextVals = patchGridB1Cell_(row.values_grid, newClientName);
      const nextFormulas = clearGridB1FormulaCell_(row.formulas_grid);
      if (!nextVals.changed && !nextFormulas.changed) continue;
      const patch = {};
      if (nextVals.changed) patch.values_grid = nextVals.grid;
      if (nextFormulas.changed) patch.formulas_grid = nextFormulas.grid;
      const { error: updErr } = await sb
        .from("master_sheet_grids")
        .update(patch)
        .eq("id", row.id);
      if (updErr) {
        summary.warnings.push(`KeyInfo (${row.sheet_role}) grid update warning: ${updErr.message}`);
      } else {
        summary.keyInfoTabsUpdated.push(row.sheet_role);
      }
    }
  }

  // Also update embedded KeyInfo grids inside native Phase 4/5/6 relational configs
  try {
    const [{ data: masterSyncCfg }, { data: finCfg }, { data: reconCfg }] = await Promise.all([
      sb
        .from("pulse_master_sync_configs")
        .select("client_id, master_key_info_grid")
        .eq("client_id", clientRow.id)
        .maybeSingle(),
      sb
        .from("pulse_financial_configs")
        .select("client_id, client_key_info_grid")
        .eq("client_id", clientRow.id)
        .maybeSingle(),
      sb
        .from("pulse_recon_configs")
        .select("client_id, key_info_grid")
        .eq("client_id", clientRow.id)
        .maybeSingle(),
    ]);
    if (Array.isArray(masterSyncCfg?.master_key_info_grid) && masterSyncCfg.master_key_info_grid.length > 0) {
      const res = patchGridB1Cell_(masterSyncCfg.master_key_info_grid, newClientName);
      if (res.changed) {
        await sb
          .from("pulse_master_sync_configs")
          .update({ master_key_info_grid: res.grid })
          .eq("client_id", clientRow.id);
        summary.keyInfoTabsUpdated.push("pulse_master_sync_configs");
      }
    }
    if (Array.isArray(finCfg?.client_key_info_grid) && finCfg.client_key_info_grid.length > 0) {
      const res = patchGridB1Cell_(finCfg.client_key_info_grid, newClientName);
      if (res.changed) {
        await sb
          .from("pulse_financial_configs")
          .update({ client_key_info_grid: res.grid })
          .eq("client_id", clientRow.id);
        summary.keyInfoTabsUpdated.push("pulse_financial_configs");
      }
    }
    if (Array.isArray(reconCfg?.key_info_grid) && reconCfg.key_info_grid.length > 0) {
      const res = patchGridB1Cell_(reconCfg.key_info_grid, newClientName);
      if (res.changed) {
        await sb
          .from("pulse_recon_configs")
          .update({ key_info_grid: res.grid })
          .eq("client_id", clientRow.id);
        summary.keyInfoTabsUpdated.push("pulse_recon_configs");
      }
    }
  } catch (cfgErr) {
    summary.warnings.push(`Native config KeyInfo update warning: ${cfgErr.message}`);
  }

  if (!sheets?.spreadsheets?.values?.update) return;

  const googleSheetsTargets = [
    { role: "master", id: clientRow.master_sheet_id },
    { role: "client", id: clientRow.client_sheet_id },
    { role: "recon", id: clientRow.recon_sheet_id },
  ];
  for (const target of googleSheetsTargets) {
    const cleanId = String(target.id || "").trim();
    if (!cleanId || cleanId.startsWith("sb-")) continue;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: cleanId,
        range: "KeyInfo!B1",
        valueInputOption: "RAW",
        requestBody: { values: [[newClientName]] },
        _bypassSupabaseVirtualSheet: true,
      });
      summary.googleSheetsUpdated.push(target.role);
    } catch (sheetErr) {
      summary.warnings.push(`Google Sheet KeyInfo!B1 (${target.role}) skipped: ${sheetErr.message}`);
    }
  }
}

async function rewriteTriageRedisAndBustCaches_({
  oldClientName,
  newClientName,
  oldNormKey,
  newNormKey,
  clientRow,
  acId,
}) {
  clearAllClientsMemoryCache();
  clearSsrClientsMemoryCache();
  invalidateMasterEngineCache(oldClientName, null, null, { invalidateSheetContext: true });
  invalidateMasterEngineCache(newClientName, null, null, { invalidateSheetContext: true });
  invalidatePrecomputedMemoryCache();
  await invalidateUsersCache();
  await invalidateIntegrationsCache();
  await invalidatePmaClientCache(clientRow.client_sheet_id, clientRow.master_sheet_id, ["all"]);
  await Promise.all([
    import("./relationalMasterService.js").then((m) => {
      m.invalidateClientRelationalMasterCache(oldClientName);
      m.invalidateClientRelationalMasterCache(newClientName);
    }).catch(() => {}),
    import("./relationalReconService.js").then((m) => {
      m.invalidateClientRelationalReconCache(oldClientName);
      m.invalidateClientRelationalReconCache(newClientName);
    }).catch(() => {}),
    import("./relationalJobsService.js").then((m) => {
      m.invalidateClientRelationalJobsCache?.(oldClientName);
      m.invalidateClientRelationalJobsCache?.(newClientName);
    }).catch(() => {}),
    import("./relationalInputsService.js").then((m) => {
      m.invalidateClientRelationalInputsCache?.(oldClientName);
      m.invalidateClientRelationalInputsCache?.(newClientName);
    }).catch(() => {}),
    import("./relationalFinancialsService.js").then((m) => {
      m.invalidateClientRelationalFinancialsCache?.(oldClientName);
      m.invalidateClientRelationalFinancialsCache?.(newClientName);
    }).catch(() => {}),
    import("./nativeClientCalcService.js").then((m) => {
      m.invalidateClientNativeCalcCache?.(oldClientName);
      m.invalidateClientNativeCalcCache?.(newClientName);
    }).catch(() => {}),
    import("./nativeMasterComparisonService.js").then((m) => {
      m.invalidateClientMasterCompCache?.(oldClientName);
      m.invalidateClientMasterCompCache?.(newClientName);
    }).catch(() => {}),
  ]);

  const canonicalAcId = acId || getCanonicalAcSheetId();
  const redisReady = await ensureRedisConnected().catch(() => false);
  if (redisReady && redisClient?.isOpen) {
    const keysToDelete = [
      `pulse:setup:${oldNormKey}`,
      `pulse:setup:${newNormKey}`,
      `pulse:all_clients:${canonicalAcId}`,
      `pulse:portal:allClients:${canonicalAcId}`,
      "pulse:integrations:status_all",
    ];
    if (clientRow.master_sheet_id) {
      keysToDelete.push(`pulse:client_settings:${clientRow.master_sheet_id}`);
    }
    if (clientRow.client_sheet_id) {
      keysToDelete.push(`pulse:client_settings:${clientRow.client_sheet_id}`);
    }
    if (process.env.AUTOMATION_COMMANDER_SHEET_ID) {
      keysToDelete.push(
        `pulse:all_clients:${process.env.AUTOMATION_COMMANDER_SHEET_ID}`,
        `pulse:portal:allClients:${process.env.AUTOMATION_COMMANDER_SHEET_ID}`
      );
    }
    await Promise.all(keysToDelete.map((k) => redisClient.del(k).catch(() => {})));

    try {
      const rawPre = await redisClient.get("triage_precomputed");
      if (rawPre) {
        const pre = JSON.parse(rawPre);
        const res = renameClientReferencesRecursive_(pre, oldClientName, newClientName);
        if (res.changed) {
          await redisClient.set("triage_precomputed", JSON.stringify(res.value), { EX: 86400 * 7 });
        }
      }
    } catch (_) {}
  }

  await flushAllAlertMemoryCaches(canonicalAcId).catch(() => {});
}

/**
 * End-to-end client rename across Supabase tables, KeyInfo, encrypted OAuth vault,
 * user permissions, system_config blobs, and caches.
 */
export async function renameTenantClient({
  clientId,
  oldClientName,
  newClientName,
  sheets = null,
  acId = null,
}) {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured. Tenant rename requires Supabase.");
  }
  const sb = getSupabaseAdmin();
  if (!sb) {
    throw new Error("Supabase admin client is unavailable.");
  }

  const cleanNewName = String(newClientName || "").trim();
  if (!cleanNewName) {
    throw new Error("New client name cannot be empty.");
  }
  if (cleanNewName.length > 160) {
    throw new Error("New client name cannot exceed 160 characters.");
  }
  if (/^[=+\-@]/.test(cleanNewName)) {
    throw new Error("New client name cannot start with a formula prefix (=, +, -, @).");
  }
  if (FORBIDDEN_PROTO_KEYS.has(cleanNewName) || FORBIDDEN_PROTO_KEYS.has(cleanNewName.toLowerCase())) {
    throw new Error("New client name is reserved.");
  }

  const newNormKey = normalizeTenantClientKey(cleanNewName);
  if (
    !newNormKey ||
    newNormKey === "__shared_xero__" ||
    newNormKey === "system" ||
    FORBIDDEN_PROTO_KEYS.has(newNormKey)
  ) {
    throw new Error("New client name produces an invalid internal identifier.");
  }

  const clientRow = await resolveTargetClientRow_(sb, { clientId, oldClientName });
  const currentName = String(clientRow.client_name || "").trim();
  const oldNormKey = String(clientRow.normalized_key || normalizeTenantClientKey(currentName)).trim();

  if (currentName === cleanNewName) {
    throw new Error("New client name is identical to the current client name.");
  }

  await assertNoNameCollision_(sb, {
    existingId: clientRow.id,
    newClientName: cleanNewName,
    newNormKey,
  });

  const summary = {
    clientId: clientRow.id,
    oldClientName: currentName,
    newClientName: cleanNewName,
    oldNormalizedKey: oldNormKey,
    newNormalizedKey: newNormKey,
    vaultIntegrationsTotal: 0,
    vaultIntegrationsUpdated: 0,
    alertMemoryRowsUpdated: 0,
    pmaTasksRowsUpdated: 0,
    usersUpdated: 0,
    tablesUpdated: [],
    systemConfigKeysUpdated: [],
    keyInfoTabsUpdated: [],
    googleSheetsUpdated: [],
    warnings: [],
  };

  await rekeyTenantIntegrations_({
    sb,
    clientRow,
    oldClientName: currentName,
    newClientName: cleanNewName,
    oldNormKey,
    newNormKey,
    summary,
  });

  await renameKeyedTenantTables_({
    sb,
    clientRow,
    oldClientName: currentName,
    newClientName: cleanNewName,
    oldNormKey,
    newNormKey,
    summary,
  });

  await renameUserAssignments_({
    sb,
    oldClientName: currentName,
    newClientName: cleanNewName,
    summary,
  });

  await renameSystemConfigReferences_({
    sb,
    oldClientName: currentName,
    newClientName: cleanNewName,
    oldNormKey,
    newNormKey,
    summary,
  });

  invalidateMasterEngineCache(currentName, null, null, { invalidateSheetContext: true });

  await updateKeyInfoGridsAndSheets_({
    sb,
    sheets,
    clientRow,
    newClientName: cleanNewName,
    summary,
  });

  await rewriteTriageRedisAndBustCaches_({
    oldClientName: currentName,
    newClientName: cleanNewName,
    oldNormKey,
    newNormKey,
    clientRow,
    acId,
  });

  return summary;
}
