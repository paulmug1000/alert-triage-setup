/**
 * nativeCrmPullService.js (Phase 6C)
 *
 * 100% verbatim Node.js replacement for GAS CRM Pull Engines:
 *   - 6_Routing_Logic.gs (PullCRMBasedOn, guardCrmRowCountSwing_, PullFromGoogleSheet_, PullFromExcelSheet_)
 *   - HubSpotConnector.gs, PipedriveConnector.gs, MondayConnector.gs, ClickUpConnector.gs, CloseConnector.gs, CapsuleConnector.gs
 *   - 5_Agent_Receiver.gs (getCrmColumnIndices_)
 *
 * Persists directly into Phase 4 Postgres tables (`crm_deals_raw` + bridge/header JSONB
 * columns in `pulse_master_sync_configs`) and maintains DataChgAlert + ScriptProperties
 * without touching master_sheet_grids when `connector_pull_mode = 'native'`.
 */

import crypto from "crypto";
import { getSupabaseAdmin } from "./supabaseClient.js";
import { resolveBrokerTokenInProcess } from "./gasRuntime/gasEnvironment.js";
import {
  parseCrmDealsFromGrids,
  projectCrmDealsToDataFromCrmGrid,
  preloadClientRelationalMasterBundle,
  reconstructRelationalMasterTabFromBundle,
  invalidateClientRelationalMasterCache,
} from "./relationalMasterService.js";
import {
  saveVirtualTabGrid_,
  getOrLoadVirtualTabGrid_,
} from "./masterEngineService.js";
import { computeAndPersistNativeMasterComparisons } from "./nativeMasterComparisonService.js";
import {
  sanitizeSheetCell_,
  sanitizeSheetMatrix_,
  assertValidMondayBoardId,
  assertValidMondayCursor,
  assertValidGraphSegment,
  connectorFetch,
  applySlotReuseDeltaGrid,
  readKeyInfoCellRaw,
  loadConnectorContextState,
  saveConnectorConfigPatch,
  persistConnectorScriptProperties,
  stampMasterCompTimestamp,
  patchGrid2DCell,
  normalizeVirtualMasterGrid,
  defaultSleepMs,
} from "./nativeConnectorUtils.js";
import { dateToSerial } from "./gasRuntime/sheetValueUtils.js";

// ============================================================================
// CONSTANTS & GUARD THRESHOLDS (100% VERBATIM 6_Routing_Logic.gs:72-208)
// ============================================================================

export const CRM_SYNC_SWING_THRESHOLD_PCT_ = 25;
export const CRM_SYNC_SWING_MIN_BASELINE_ = 4;
export const CRM_SYNC_SWING_MIN_DELTA_ = 3;
export const CRM_SYNC_SWING_WIPE_MIN_BASELINE_ = 3;

const FORBIDDEN_INTERNAL_CRM_TABS = new Set([
  "KeyInfo",
  "InvComp",
  "DirComp",
  "CRMComp",
  "PLComp",
  "Confirmed",
  "Pipeline",
  "Outgoings",
  "Salaries",
  "AppData",
  "OutgNotes",
  "ConfCalcs",
  "PipeCalcs",
  "AutoUpdates",
  "RepControl",
  "EomReportingConfig",
  "Clients",
  "DeployLog",
]);

function normalizeCrmToolName_(raw, keyInfoGrid = []) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s || s === "none" || s === "manual") return "none";

  // Respect KeyInfo!R19:S36 routing table when present (`6_Routing_Logic.gs:210-214`)
  for (let r = 18; r <= 35; r++) {
    const label = String(keyInfoGrid?.[r]?.[17] || "").trim().toLowerCase();
    const fnName = String(keyInfoGrid?.[r]?.[18] || "").trim();
    if (label && label === s && fnName) {
      if (fnName === "exportHubSpotDealsToSheet") return "hubspot";
      if (fnName === "exportPipeDriveDealsToSheet") return "pipedrive";
      if (fnName === "exportMondayBoardToSheet") return "monday";
      if (fnName === "exportClickUpListToSheet") return "clickup";
      if (fnName === "exportCloseOpportunitiesToSheet") return "close";
      if (fnName === "exportCapsuleOpportunitiesToSheet") return "capsule";
      if (fnName === "PullFromGoogleSheet_") return "googlesheet";
      if (fnName === "PullFromExcelSheet_") return "excel";
    }
  }

  if (s.includes("hubspot")) return "hubspot";
  if (s.includes("pipedrive")) return "pipedrive";
  if (s.includes("monday")) return "monday";
  if (s.includes("clickup")) return "clickup";
  if (s === "close" || s.includes("close.com") || s.includes("close crm")) return "close";
  if (s.includes("capsule")) return "capsule";
  if (s.includes("google")) return "googlesheet";
  if (s.includes("excel") || s.includes("microsoft")) return "excel";
  return s;
}

function formatEnGbDateTime_(d, tz = "Europe/London") {
  if (!d) return "";
  try {
    return new Date(d).toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz,
    });
  } catch {
    return "";
  }
}

function formatEnGbDateOnly_(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleDateString("en-GB");
  } catch {
    return "";
  }
}

function formatDayMonYy_(d, tz = "Europe/London") {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      day: "numeric",
      month: "short",
      year: "2-digit",
    }).formatToParts(dt);
    const day = parts.find((p) => p.type === "day")?.value || "";
    const month = parts.find((p) => p.type === "month")?.value || "";
    const year = parts.find((p) => p.type === "year")?.value || "";
    return `${day}-${month}-${year}`;
  } catch {
    return "";
  }
}

// ============================================================================
// CRM SWING GUARD (100% VERBATIM PORT OF guardCrmRowCountSwing_ `6_Routing_Logic.gs:135-208`)
// ============================================================================

export function guardNativeCrmRowCountSwing({
  existingCount = 0,
  incomingCount = 0,
  crmTool = "",
  scriptProps = {},
  nowIso = new Date().toISOString(),
}) {
  const base = Number(existingCount) || 0;
  const inc = typeof incomingCount === "number" && !isNaN(incomingCount) ? incomingCount : 0;
  const toolLabel = String(crmTool || "CRM").trim() || "CRM";

  const overrideRaw = scriptProps?.CRM_SYNC_SWING_OVERRIDE_ONCE;
  if (overrideRaw) {
    const rawStr = String(overrideRaw).trim();
    if (rawStr.toLowerCase() === "true") {
      return {
        allowed: true,
        overrideUsed: true,
        existingCount: base,
        incomingCount: inc,
        overrideInfo: {
          approvedBy: "User",
          approvedAt: nowIso,
          crmTool: toolLabel,
          existingCount: base,
          incomingCount: inc,
        },
        blockInfo: null,
        clearProps: ["CRM_SYNC_SWING_OVERRIDE_ONCE", "CRM_SYNC_SWING_BLOCK_JSON"],
      };
    }
    let parsed = {};
    try {
      parsed = JSON.parse(rawStr) || {};
    } catch {
      parsed = {};
    }
    const expiresAt = parsed.expiresAt ? Number(parsed.expiresAt) : 0;
    const nowMs = Date.parse(nowIso) || Date.now();
    if (!expiresAt || nowMs <= expiresAt) {
      return {
        allowed: true,
        overrideUsed: true,
        existingCount: base,
        incomingCount: inc,
        overrideInfo: {
          approvedBy: String(parsed.approvedBy || "User").trim() || "User",
          approvedAt: String(parsed.approvedAt || nowIso),
          crmTool: toolLabel,
          existingCount: base,
          incomingCount: inc,
        },
        blockInfo: null,
        clearProps: ["CRM_SYNC_SWING_OVERRIDE_ONCE", "CRM_SYNC_SWING_BLOCK_JSON"],
      };
    }
  }

  if (base === 0) {
    return {
      allowed: true,
      overrideUsed: false,
      existingCount: base,
      incomingCount: inc,
      blockInfo: null,
      clearProps: scriptProps?.CRM_SYNC_SWING_BLOCK_JSON ? ["CRM_SYNC_SWING_BLOCK_JSON"] : [],
    };
  }

  const delta = inc - base;
  const absDelta = Math.abs(delta);
  const pctAbs = (absDelta / base) * 100;
  const isCompleteWipe = base >= CRM_SYNC_SWING_WIPE_MIN_BASELINE_ && inc === 0;
  const isLargeSwing =
    base >= CRM_SYNC_SWING_MIN_BASELINE_ &&
    absDelta >= CRM_SYNC_SWING_MIN_DELTA_ &&
    pctAbs >= CRM_SYNC_SWING_THRESHOLD_PCT_;

  if (!isCompleteWipe && !isLargeSwing) {
    return {
      allowed: true,
      overrideUsed: false,
      existingCount: base,
      incomingCount: inc,
      blockInfo: null,
      clearProps: scriptProps?.CRM_SYNC_SWING_BLOCK_JSON ? ["CRM_SYNC_SWING_BLOCK_JSON"] : [],
    };
  }

  const blockInfo = {
    blockedAt: nowIso,
    crmTool: toolLabel,
    existingCount: base,
    incomingCount: inc,
    delta,
    pctChange: Math.round((delta / base) * 1000) / 10,
    thresholdPct: CRM_SYNC_SWING_THRESHOLD_PCT_,
    direction: delta < 0 ? "decrease" : "increase",
  };

  return {
    allowed: false,
    overrideUsed: false,
    existingCount: base,
    incomingCount: inc,
    blockInfo,
    clearProps: [],
  };
}

function countExistingCrmDataRows_(grid = []) {
  let count = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (Array.isArray(r) && r.some((c) => c !== null && c !== undefined && String(c).trim() !== "")) {
      count++;
    }
  }
  return count;
}

// ============================================================================
// CRM SUPABASE AUTH + PERSISTENCE HELPERS
// ============================================================================

async function resolveCrmAccessToken_(ctx, tool, tokenOverride = null) {
  if (tokenOverride && typeof tokenOverride === "object" && tokenOverride.accessToken) {
    return {
      accessToken: tokenOverride.accessToken,
      metadata: tokenOverride.metadata || {},
    };
  }
  const brokerRes = await resolveBrokerTokenInProcess(ctx, tool);
  if (!brokerRes || brokerRes.status !== 200 || !brokerRes.body?.accessToken) {
    const err = new Error(brokerRes?.body?.error || `No active ${tool} CRM connection found.`);
    err.reconnectRequired = Boolean(brokerRes?.body?.reconnectRequired);
    throw err;
  }
  return {
    accessToken: brokerRes.body.accessToken,
    metadata: brokerRes.body.metadata || {},
  };
}

async function upsertCrmRowsInChunks_(supabase, clientId, parsedRows) {
  for (let i = 0; i < parsedRows.length; i += 250) {
    const chunk = parsedRows.slice(i, i + 250);
    const { error } = await supabase
      .from("crm_deals_raw")
      .upsert(chunk, { onConflict: "client_id,sheet_row_num" });
    if (error) throw new Error(`crm_deals_raw upsert failed: ${error.message}`);
  }

  const keepNums = new Set(parsedRows.map((r) => Number(r.sheet_row_num)));
  const existing = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("crm_deals_raw")
      .select("id, sheet_row_num")
      .eq("client_id", clientId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`crm_deals_raw select failed: ${error.message}`);
    const batch = Array.isArray(data) ? data : [];
    existing.push(...batch);
    if (batch.length < 1000) break;
    from += 1000;
  }
  const staleIds = existing.filter((r) => !keepNums.has(Number(r.sheet_row_num))).map((r) => r.id);
  for (let i = 0; i < staleIds.length; i += 200) {
    const { error: delErr } = await supabase.from("crm_deals_raw").delete().in("id", staleIds.slice(i, i + 200));
    if (delErr) throw new Error(`crm_deals_raw delete failed: ${delErr.message}`);
  }
}

async function stampCrmChangeAlert_(ctx, nowDate = new Date()) {
  const state = await loadConnectorContextState(ctx);
  let alertGrid = state.dataChgAlertGrid.length > 0 ? state.dataChgAlertGrid : [[]];
  alertGrid = patchGrid2DCell(alertGrid, 2, 8, "Yes"); // H2
  alertGrid = patchGrid2DCell(alertGrid, 2, 9, dateToSerial(nowDate)); // I2
  await saveConnectorConfigPatch(ctx, { data_chg_alert_grid: alertGrid });
  if (ctx?.connectorPullMode !== "native") {
    await saveVirtualTabGrid_(ctx, "master", "DataChgAlert", alertGrid, alertGrid, {}).catch(() => { });
  }
}

// ============================================================================
// CONNECTOR #1: HUBSPOT (`HubSpotConnector.gs:46-260`)
// ============================================================================

async function fetchHubSpotCrm_({ accessToken, fetchImpl, sleepImpl, timeZone }) {
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  const propRes = await connectorFetch("https://api.hubapi.com/crm/v3/properties/deals", {
    headers,
    fetchImpl,
  });
  if (!propRes.ok) {
    throw new Error(`Error fetching Deal Properties: ${propRes.text || propRes.status}`);
  }

  const allPropertyNames = [];
  const propertyLabelMap = Object.create(null);
  for (const prop of propRes.json?.results || []) {
    if (!prop.hidden) {
      allPropertyNames.push(prop.name);
      propertyLabelMap[prop.name] = prop.label;
    }
  }

  const rawDeals = [];
  let after = 0;
  let hasMore = true;
  while (hasMore) {
    const searchRes = await connectorFetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers,
      body: JSON.stringify({
        filterGroups: [],
        properties: allPropertyNames,
        limit: 100,
        after,
      }),
      fetchImpl,
    });
    if (!searchRes.ok) {
      throw new Error(`HubSpot API Error: ${searchRes.json?.message || searchRes.text || searchRes.status}`);
    }
    const results = searchRes.json?.results || [];
    if (results.length > 0) {
      rawDeals.push(...results);
      if (searchRes.json?.paging?.next?.after) {
        after = searchRes.json.paging.next.after;
      } else {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }
    if (hasMore) await sleeper(200);
  }

  const deals = rawDeals.map((deal) => {
    const props = deal.properties || {};
    const customFields = [];
    for (const key of Object.keys(props)) {
      customFields.push({ name: propertyLabelMap[key] || key, value: props[key] });
    }
    return {
      id: deal.id,
      createdAt: deal.createdAt,
      updatedAt: deal.updatedAt,
      archived: deal.archived,
      dealname: props.dealname || "",
      amount: props.amount || "",
      dealstage: props.dealstage || "",
      pipeline: props.pipeline || "",
      custom_fields: customFields,
    };
  });

  const baseHeaders = ["Deal ID", "Deal Name", "Stage", "Amount", "Pipeline", "Created Date", "Updated Date"];
  const cfHeadersSet = new Set();
  for (const deal of deals) {
    for (const cf of deal.custom_fields || []) {
      if (!["Deal Name", "Amount", "Deal Stage", "Pipeline"].includes(cf.name)) {
        cfHeadersSet.add(cf.name);
      }
    }
  }
  const cfHeaders = Array.from(cfHeadersSet).sort();
  const allHeaders = [...baseHeaders, ...cfHeaders];
  const cfHeaderMap = new Map(cfHeaders.map((h, i) => [h, i]));

  const data = deals.map((deal) => {
    const baseRow = [
      deal.id,
      deal.dealname,
      deal.dealstage,
      deal.amount,
      deal.pipeline,
      formatEnGbDateTime_(deal.createdAt, timeZone),
      formatEnGbDateTime_(deal.updatedAt, timeZone),
    ];
    const cfValues = new Array(cfHeaders.length).fill("");
    for (const cf of deal.custom_fields || []) {
      const idx = cfHeaderMap.get(cf.name);
      if (idx !== undefined) {
        const v = cf.value;
        cfValues[idx] = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : v;
      }
    }
    return [...baseRow, ...cfValues];
  });

  return {
    toolLabel: "HubSpot",
    incomingCount: deals.length,
    emptyMessage: deals.length === 0,
    headers: sanitizeSheetMatrix_([allHeaders])[0],
    rows: sanitizeSheetMatrix_(data),
    textColsSet: new Set([0]),
    stampDataChgAlertOnWrite: true,
    stampAlertWhenEmptyOverwrite: false,
  };
}

// ============================================================================
// CONNECTOR #2: PIPEDRIVE (`PipedriveConnector.gs:46-260`)
// ============================================================================

async function fetchPipedriveCrm_({ accessToken, fetchImpl, sleepImpl, timeZone }) {
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const headers = { Authorization: `Bearer ${accessToken}` };

  const fieldsRes = await connectorFetch("https://api.pipedrive.com/v1/dealFields", {
    headers,
    fetchImpl,
  });
  if (!fieldsRes.ok) {
    throw new Error(`Error fetching Deal Fields: ${fieldsRes.text || fieldsRes.status}`);
  }
  const fieldMap = Object.create(null);
  for (const field of fieldsRes.json?.data || []) {
    fieldMap[field.key] = field.name;
  }

  const rawDeals = [];
  let start = 0;
  const limit = 100;
  let hasMore = true;
  while (hasMore) {
    const res = await connectorFetch(
      `https://api.pipedrive.com/v1/deals?start=${start}&limit=${limit}`,
      { headers, fetchImpl }
    );
    if (!res.ok) {
      throw new Error(`Pipedrive API Error: ${res.json?.error || res.text || res.status}`);
    }
    const items = res.json?.data || [];
    if (items.length > 0) {
      rawDeals.push(...items);
      if (res.json?.additional_data?.pagination?.more_items_in_collection) {
        start = res.json.additional_data.pagination.next_start;
      } else {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }
    if (hasMore) await sleeper(200);
  }

  const deals = rawDeals.map((deal) => {
    const customFields = [];
    for (const key of Object.keys(deal)) {
      if (fieldMap[key] && key.length > 20) {
        let val = deal[key];
        if (typeof val === "object" && val !== null) val = JSON.stringify(val);
        customFields.push({ name: fieldMap[key], value: val });
      }
    }
    return {
      id: deal.id,
      title: deal.title,
      person_name: deal.person_name,
      org_name: deal.org_name,
      status: deal.status,
      value: deal.value,
      currency: deal.currency,
      stage_id: deal.stage_id,
      won_time: deal.won_time,
      add_time: deal.add_time,
      close_time: deal.close_time,
      expected_close_date: deal.expected_close_date,
      probability: deal.probability,
      owner_name: deal.owner_name,
      custom_fields: customFields,
    };
  });

  const baseHeaders = [
    "Deal ID",
    "Title",
    "Person",
    "Organization",
    "Status",
    "Value",
    "Currency",
    "Probability %",
    "Won Time",
    "Add Time",
    "Update Time",
    "Owner",
  ];
  const cfHeadersSet = new Set();
  for (const deal of deals) {
    for (const cf of deal.custom_fields || []) {
      if (cf.name) cfHeadersSet.add(cf.name);
    }
  }
  const cfHeaders = Array.from(cfHeadersSet).sort();
  const allHeaders = [...baseHeaders, ...cfHeaders];
  const cfHeaderMap = new Map(cfHeaders.map((h, i) => [h, i]));

  const data = deals.map((deal) => {
    const baseRow = [
      deal.id,
      deal.title,
      deal.person_name,
      deal.org_name,
      deal.status,
      deal.value,
      deal.currency,
      deal.probability ? `${deal.probability}%` : "0%",
      formatEnGbDateTime_(deal.won_time, timeZone),
      formatEnGbDateTime_(deal.add_time, timeZone),
      formatEnGbDateTime_(deal.update_time, timeZone),
      deal.owner_name,
    ];
    const cfValues = new Array(cfHeaders.length).fill("");
    for (const cf of deal.custom_fields || []) {
      const idx = cfHeaderMap.get(cf.name);
      if (idx !== undefined) {
        const v = cf.value;
        cfValues[idx] = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : v;
      }
    }
    return [...baseRow, ...cfValues];
  });

  return {
    toolLabel: "Pipedrive",
    incomingCount: deals.length,
    emptyMessage: deals.length === 0,
    headers: sanitizeSheetMatrix_([allHeaders])[0],
    rows: sanitizeSheetMatrix_(data),
    textColsSet: new Set([0]),
    stampDataChgAlertOnWrite: true,
    stampAlertWhenEmptyOverwrite: false,
  };
}

// ============================================================================
// CONNECTOR #3: MONDAY.COM (`MondayConnector.gs:43-240`)
// ============================================================================

async function makeMondayGraphQLRequest_({ accessToken, query, fetchImpl }) {
  const res = await connectorFetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
    fetchImpl,
  });
  if (res.json?.errors) {
    throw new Error(`Monday GraphQL Error: ${JSON.stringify(res.json.errors)}`);
  }
  if (!res.ok) {
    throw new Error(`Monday API Error: ${res.text || res.status}`);
  }
  return res.json?.data;
}

async function fetchMondayCrm_({ accessToken, keyInfoGrid, fetchImpl, sleepImpl }) {
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const boardId = assertValidMondayBoardId(readKeyInfoCellRaw(keyInfoGrid, "X24", ""));

  const colsData = await makeMondayGraphQLRequest_({
    accessToken,
    query: `query { boards (ids: ${boardId}) { columns { id title type } } }`,
    fetchImpl,
  });
  if (!colsData?.boards || colsData.boards.length === 0) {
    throw new Error(`Board with ID ${boardId} not found or access denied.`);
  }
  const columnMap = Object.create(null);
  for (const col of colsData.boards[0].columns || []) {
    columnMap[col.id] = col.title;
  }

  const allItems = [];
  let cursor = null;
  let hasMore = true;
  while (hasMore) {
    let query = "";
    if (cursor) {
      const safeCursor = assertValidMondayCursor(cursor);
      query = `query { boards (ids: ${boardId}) { items_page (limit: 100, cursor: "${safeCursor}") { cursor items { id name created_at updated_at column_values { id text value } } } } }`;
    } else {
      query = `query { boards (ids: ${boardId}) { items_page (limit: 100) { cursor items { id name created_at updated_at column_values { id text value } } } } }`;
    }
    const data = await makeMondayGraphQLRequest_({ accessToken, query, fetchImpl });
    const page = data?.boards?.[0]?.items_page;
    if (Array.isArray(page?.items) && page.items.length > 0) {
      allItems.push(...page.items);
    }
    cursor = page?.cursor || null;
    if (!cursor) hasMore = false;
    else await sleeper(100);
  }

  const items = allItems.map((item) => {
    const columns = Object.create(null);
    for (const cv of item.column_values || []) {
      const title = columnMap[cv.id] || cv.id;
      columns[title] = cv.text || "";
    }
    return {
      id: item.id,
      name: item.name,
      created_at: item.created_at,
      updated_at: item.updated_at,
      columns,
    };
  });

  const dynamicHeaders = new Set();
  for (const item of items) {
    for (const key of Object.keys(item.columns)) dynamicHeaders.add(key);
  }
  const sortedDynamicHeaders = Array.from(dynamicHeaders).sort();
  const staticHeaders = ["ID", "Name", "Created At", "Updated At"];
  const allHeaders = [...staticHeaders, ...sortedDynamicHeaders];
  const headerMap = new Map(allHeaders.map((h, i) => [h, i]));

  const rawData = items.map((item) => {
    const row = new Array(allHeaders.length).fill("");
    row[0] = item.id;
    row[1] = item.name;
    row[2] = item.created_at;
    row[3] = item.updated_at;
    for (const colName of Object.keys(item.columns)) {
      const idx = headerMap.get(colName);
      if (idx !== undefined) row[idx] = item.columns[colName];
    }
    return row;
  });

  return {
    toolLabel: "Monday.com",
    incomingCount: items.length,
    emptyMessage: items.length === 0,
    headers: sanitizeSheetMatrix_([allHeaders])[0],
    rows: sanitizeSheetMatrix_(rawData),
    textColsSet: new Set([0]),
    stampDataChgAlertOnWrite: true,
    stampAlertWhenEmptyOverwrite: false,
  };
}

// ============================================================================
// CONNECTOR #4: CLICKUP (`ClickUpConnector.gs:11-245`)
// ============================================================================

function parseClickUpCustomFieldValue_(field, timeZone = "Europe/London") {
  if (!field || typeof field.value === "undefined") return "";
  const value = field.value;
  switch (field.type) {
    case "drop_down": {
      const options = field.type_config?.options || [];
      // eslint-disable-next-line eqeqeq
      const selectedOption = options.find((opt) => opt.orderindex == value);
      return selectedOption ? selectedOption.name : "";
    }
    case "labels": {
      const labelOptions = field.type_config?.options || [];
      return (Array.isArray(value) ? value : [])
        .map((labelId) => {
          const foundLabel = labelOptions.find((opt) => opt.id === labelId);
          return foundLabel ? foundLabel.label : "";
        })
        .join(", ");
    }
    case "date": {
      if (!value) return "";
      const d = new Date(parseInt(value, 10));
      return formatEnGbDateOnly_(d);
    }
    case "users":
      return (Array.isArray(value) ? value : []).map((u) => u.username).join(", ");
    case "checkbox":
      return value ? "true" : "false";
    default:
      return Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : value;
  }
}

function formatClickUpDateTime_(msVal, timeZone = "Europe/London") {
  if (!msVal) return "";
  const d = new Date(parseInt(msVal, 10));
  if (isNaN(d.getTime())) return "";
  // dd/MM/yyyy HH:mm
  const s = formatEnGbDateTime_(d, timeZone);
  return s.replace(",", "");
}

async function fetchClickUpCrm_({ accessToken, keyInfoGrid, fetchImpl, sleepImpl, timeZone }) {
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const viewId = String(readKeyInfoCellRaw(keyInfoGrid, "X17", "")).trim();
  if (!viewId) {
    throw new Error("CLICKUP_VIEW_ID is missing in KeyInfo sheet (Cell X17).");
  }

  const allTasks = [];
  let page = 0;
  let hasMore = true;
  while (hasMore) {
    const viewUrl = `https://api.clickup.com/api/v2/view/${encodeURIComponent(viewId)}/task?page=${page}&include_custom_fields=true`;
    const res = await connectorFetch(viewUrl, {
      headers: { Authorization: accessToken },
      fetchImpl,
    });
    if (!res.ok) {
      throw new Error(`ClickUp API Error: ${res.json?.err || res.text} (Code: ${res.json?.ECODE || res.status})`);
    }
    const batch = res.json?.tasks || [];
    if (batch.length > 0) {
      allTasks.push(...batch);
      page++;
      await sleeper(100);
    } else {
      hasMore = false;
    }
  }

  const baseHeaders = [
    "Task ID",
    "Custom ID",
    "Task Name",
    "Status",
    "Start Date",
    "Due Date",
    "Date Created",
    "Assignees",
    "Priority",
    "URL",
  ];
  const cfHeadersSet = new Set();
  for (const task of allTasks) {
    for (const field of task.custom_fields || []) cfHeadersSet.add(field.name);
  }
  const customFieldHeaders = Array.from(cfHeadersSet).sort();
  const allHeaders = [...baseHeaders, ...customFieldHeaders];
  const customFieldHeaderMap = new Map(customFieldHeaders.map((h, i) => [h, i]));

  const data = allTasks.map((task) => {
    const assignees = (task.assignees || []).map((a) => a.username || a.email).join(", ");
    const priority = task.priority ? task.priority.priority : "N/A";
    const customId = task.custom_id || "";
    const createdDate = formatClickUpDateTime_(task.date_created, timeZone);
    const startDate = formatClickUpDateTime_(task.start_date, timeZone);
    const dueDate = formatClickUpDateTime_(task.due_date, timeZone);

    const baseRow = [
      task.id,
      customId,
      task.name,
      task.status?.status || "",
      startDate,
      dueDate,
      createdDate,
      assignees,
      priority,
      task.url,
    ];
    const cfValues = new Array(customFieldHeaders.length).fill("");
    for (const field of task.custom_fields || []) {
      const idx = customFieldHeaderMap.get(field.name);
      if (idx !== undefined) cfValues[idx] = parseClickUpCustomFieldValue_(field, timeZone);
    }
    return [...baseRow, ...cfValues];
  });

  return {
    toolLabel: "ClickUp",
    incomingCount: allTasks.length,
    emptyMessage: allTasks.length === 0,
    headers: sanitizeSheetMatrix_([allHeaders])[0],
    rows: sanitizeSheetMatrix_(data),
    textColsSet: new Set([0, 1]),
    stampDataChgAlertOnWrite: true,
    stampAlertWhenEmptyOverwrite: false,
  };
}

// ============================================================================
// CONNECTOR #5: CLOSE (`CloseConnector.gs:45-215`)
// ============================================================================

function parseCloseCustomFieldValue_(field, timeZone = "Europe/London") {
  if (!field || typeof field.value === "undefined" || field.value === null) return "";
  const value = field.value;
  switch (field.type) {
    case "choices":
      return Array.isArray(value) ? value.join(", ") : value;
    case "date":
      return value ? formatEnGbDateOnly_(value) : "";
    case "datetime":
      return value ? formatEnGbDateTime_(value, timeZone) : "";
    case "user":
    case "contact":
      return Array.isArray(value) ? value.join(", ") : value;
    default:
      return typeof value === "object" ? JSON.stringify(value) : value.toString();
  }
}

async function fetchCloseCrm_({ accessToken, fetchImpl, sleepImpl, timeZone }) {
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const headers = { Authorization: `Bearer ${accessToken}` };

  const cfRes = await connectorFetch("https://api.close.com/api/v1/custom_field/opportunity/", {
    headers,
    fetchImpl,
  });
  if (!cfRes.ok) {
    throw new Error(`Close API Error: ${cfRes.json?.error || cfRes.text || cfRes.status}`);
  }
  const cfData = cfRes.json?.data || [];
  const customFieldMap = Object.create(null);
  for (const field of cfData) customFieldMap[field.id] = field.name;

  const allOpps = [];
  let hasMore = true;
  let skip = 0;
  const limit = 100;
  while (hasMore) {
    const oppRes = await connectorFetch(
      `https://api.close.com/api/v1/opportunity/?_skip=${skip}&_limit=${limit}`,
      { headers, fetchImpl }
    );
    if (!oppRes.ok) {
      throw new Error(`Close API Error: ${oppRes.json?.error || oppRes.text || oppRes.status}`);
    }
    const batch = oppRes.json?.data || [];
    if (batch.length > 0) {
      allOpps.push(...batch);
      skip += batch.length;
      hasMore = Boolean(oppRes.json?.has_more);
    } else {
      hasMore = false;
    }
    if (hasMore) await sleeper(250);
  }

  const opportunities = allOpps.map((opp) => {
    const cleanCustomFields = [];
    for (const key of Object.keys(opp)) {
      if (key.startsWith("custom.") && customFieldMap[key.substring(7)]) {
        const fieldId = key.substring(7);
        const def = cfData.find((f) => f.id === fieldId) || null;
        cleanCustomFields.push({
          name: customFieldMap[fieldId],
          value: opp[key],
          type: def ? def.type : "text",
          type_config: { options: def?.choices ? def.choices : [] },
        });
      }
    }
    return { ...opp, custom_fields: cleanCustomFields };
  });

  const baseHeaders = [
    "Opportunity ID",
    "Lead ID",
    "Lead Name",
    "Status",
    "Value",
    "Confidence",
    "Expected Value",
    "Created Date",
    "Updated Date",
    "Won Date",
    "User Name",
  ];
  const cfHeadersSet = new Set();
  for (const opp of opportunities) {
    for (const field of opp.custom_fields || []) cfHeadersSet.add(field.name);
  }
  const customFieldHeaders = Array.from(cfHeadersSet).sort();
  const allHeaders = [...baseHeaders, ...customFieldHeaders];
  const cfHeaderMap = new Map(customFieldHeaders.map((h, i) => [h, i]));

  const data = opportunities.map((opp) => {
    const value = opp.value_period === "one_time" ? opp.value / 100 : `${opp.value / 100} per ${opp.value_period}`;
    const expectedValue =
      opp.value_period === "one_time"
        ? (opp.value * (opp.confidence / 100)) / 100
        : `${(opp.value * (opp.confidence / 100)) / 100} per ${opp.value_period}`;
    const baseRow = [
      opp.id,
      opp.lead_id,
      opp.lead_name,
      opp.status_label,
      value,
      opp.confidence ? `${opp.confidence}%` : "0%",
      expectedValue,
      formatEnGbDateTime_(opp.date_created, timeZone),
      formatEnGbDateTime_(opp.date_updated, timeZone),
      formatEnGbDateTime_(opp.date_won, timeZone),
      opp.user_name,
    ];
    const cfValues = new Array(customFieldHeaders.length).fill("");
    for (const field of opp.custom_fields || []) {
      const idx = cfHeaderMap.get(field.name);
      if (idx !== undefined) cfValues[idx] = parseCloseCustomFieldValue_(field, timeZone);
    }
    return [...baseRow, ...cfValues];
  });

  return {
    toolLabel: "Close",
    incomingCount: opportunities.length,
    emptyMessage: opportunities.length === 0,
    headers: sanitizeSheetMatrix_([allHeaders])[0],
    rows: sanitizeSheetMatrix_(data),
    textColsSet: new Set([0, 1]),
    stampDataChgAlertOnWrite: false, // CloseConnector.gs does NOT set DataChgAlert!H2
    stampAlertWhenEmptyOverwrite: false,
  };
}

// ============================================================================
// CONNECTOR #6: CAPSULE (`CapsuleConnector.gs:59-235`)
// ============================================================================

async function fetchCapsuleCrm_({ accessToken, fetchImpl, sleepImpl, timeZone }) {
  const sleeper = typeof sleepImpl === "function" ? sleepImpl : defaultSleepMs;
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

  const rawOpps = [];
  let page = 1;
  const perPage = 100;
  let hasMore = true;
  while (hasMore) {
    const url = `https://api.capsulecrm.com/api/v2/opportunities?embed=party,milestone,fields&page=${page}&perPage=${perPage}`;
    const res = await connectorFetch(url, { headers, fetchImpl });
    if (!res.ok) {
      throw new Error(`Capsule API Error: ${res.json?.message || res.text || res.status}`);
    }
    const batch = res.json?.opportunities || [];
    if (batch.length > 0) {
      rawOpps.push(...batch);
      if (batch.length < perPage) hasMore = false;
      else page++;
    } else {
      hasMore = false;
    }
    if (hasMore) await sleeper(250);
  }

  const opportunities = rawOpps.map((opp) => ({
    id: opp.id,
    name: opp.name,
    description: opp.description,
    partyName: opp.party ? opp.party.name : "",
    partyId: opp.party ? opp.party.id : "",
    value: opp.value ? opp.value.amount : 0,
    currency: opp.value ? opp.value.currency : "",
    status: opp.milestone ? opp.milestone.name : "",
    probability: opp.milestone ? opp.milestone.probability : 0,
    expectedCloseDate: opp.expectedCloseOn,
    ownerName: opp.owner ? opp.owner.name || opp.owner.username : "",
    createdAt: opp.createdAt,
    updatedAt: opp.updatedAt,
    customFields: opp.fields || [],
  }));

  const baseHeaders = [
    "ID",
    "Name",
    "Description",
    "Client (Party)",
    "Status (Milestone)",
    "Value",
    "Currency",
    "Probability %",
    "Expected Close",
    "Owner",
    "Created At",
    "Updated At",
  ];
  const cfHeadersSet = new Set();
  for (const opp of opportunities) {
    for (const cf of opp.customFields || []) {
      if (cf.definition?.name) cfHeadersSet.add(cf.definition.name);
    }
  }
  const cfHeaders = Array.from(cfHeadersSet).sort();
  const allHeaders = [...baseHeaders, ...cfHeaders];
  const cfHeaderMap = new Map(cfHeaders.map((h, i) => [h, i]));

  const data = opportunities.map((opp) => {
    const baseRow = [
      opp.id,
      opp.name,
      opp.description,
      opp.partyName,
      opp.status,
      opp.value,
      opp.currency,
      `${opp.probability}%`,
      formatEnGbDateOnly_(opp.expectedCloseDate),
      opp.ownerName,
      formatEnGbDateTime_(opp.createdAt, timeZone),
      formatEnGbDateTime_(opp.updatedAt, timeZone),
    ];
    const cfValues = new Array(cfHeaders.length).fill("");
    for (const cf of opp.customFields || []) {
      if (cf.definition?.name) {
        const idx = cfHeaderMap.get(cf.definition.name);
        if (idx !== undefined) {
          const v = cf.value;
          cfValues[idx] = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : v;
        }
      }
    }
    return [...baseRow, ...cfValues];
  });

  return {
    toolLabel: "Capsule",
    incomingCount: opportunities.length,
    emptyMessage: opportunities.length === 0,
    headers: sanitizeSheetMatrix_([allHeaders])[0],
    rows: sanitizeSheetMatrix_(data),
    textColsSet: new Set([0]),
    stampDataChgAlertOnWrite: true,
    stampAlertWhenEmptyOverwrite: false,
  };
}

// ============================================================================
// SHARED SPREADSHEET-BRIDGE MATCHING ENGINE (100% VERBATIM 6_Routing_Logic.gs)
// ============================================================================

export function isBridgeEmptyOrPlaceholder_(val) {
  if (val === null || val === undefined) return true;
  const s = String(val).trim();
  if (!s) return true;
  return /^(?:[-–—\s]*|n\/a|na|none|tbc|tbd|null|undefined)$/i.test(s);
}

function formatNodeYmdInTz_(d, timeZone = "Europe/London") {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function parseBridgeDateYmd_(val, timeZone = "Europe/London") {
  if (isBridgeEmptyOrPlaceholder_(val)) return null;
  const tz = timeZone || "Europe/London";
  const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12,
  };

  if (Object.prototype.toString.call(val) === "[object Date]") {
    return isNaN(val.getTime()) ? null : formatNodeYmdInTz_(val, tz);
  }
  if (typeof val === "number" || (typeof val === "string" && /^\d{5}(?:\.\d+)?$/.test(val.trim()))) {
    const n = Number(val);
    if (isFinite(n) && n > 20000 && n < 70000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
    }
  }
  if (typeof val === "string") {
    const s = val.trim();
    const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/);
    if (iso) {
      const mon = parseInt(iso[2], 10);
      const day = parseInt(iso[3], 10);
      if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
        return `${iso[1]}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
    const dMonY = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]{3,9})[\s\-/](\d{2,4})(?:\s.*)?$/);
    if (dMonY && MONTHS[dMonY[2].toLowerCase()] !== undefined) {
      let yr = parseInt(dMonY[3], 10);
      if (dMonY[3].length === 2) yr += yr > 50 ? 1900 : 2000;
      const mon = MONTHS[dMonY[2].toLowerCase()];
      const day = parseInt(dMonY[1], 10);
      if (day >= 1 && day <= 31) {
        return `${yr}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
    const monDY = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/);
    if (monDY && MONTHS[monDY[1].toLowerCase()] !== undefined) {
      let yr = parseInt(monDY[3], 10);
      if (monDY[3].length === 2) yr += yr > 50 ? 1900 : 2000;
      const mon = MONTHS[monDY[1].toLowerCase()];
      const day = parseInt(monDY[2], 10);
      if (day >= 1 && day <= 31) {
        return `${yr}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
    const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:\s.*)?$/);
    if (dmy) {
      let yr = parseInt(dmy[3], 10);
      if (dmy[3].length === 2) yr += yr > 50 ? 1900 : 2000;
      const p1 = parseInt(dmy[1], 10);
      const p2 = parseInt(dmy[2], 10);
      const day = p2 > 12 ? p2 : p1;
      const mon = p2 > 12 ? p1 : p2;
      if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
        return `${yr}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
    if (s.indexOf("GMT") !== -1 || /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}/.test(s)) {
      const parsed = new Date(s.replace(/GMT.*$/, "").trim());
      if (!isNaN(parsed.getTime())) {
        return formatNodeYmdInTz_(parsed, tz);
      }
    }
  }
  return null;
}

export function parseBridgeCurrency_(val) {
  if (isBridgeEmptyOrPlaceholder_(val)) return null;
  if (typeof val === "number") return isFinite(val) ? val : null;
  if (typeof val !== "string") return null;
  let s = val.trim();
  let isNeg = false;
  if (/^\(.*\)$/.test(s)) {
    isNeg = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\b(?:gbp|usd|eur)\b/gi, "").replace(/[£$€,\s]/g, "");
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!isFinite(n)) return null;
  return isNeg ? -Math.abs(n) : n;
}

export function parseBridgePercent_(val) {
  if (isBridgeEmptyOrPlaceholder_(val)) return null;
  if (typeof val === "number") {
    if (!isFinite(val)) return null;
    return val > 1 && val <= 100 ? val / 100 : val;
  }
  if (typeof val !== "string") return null;
  const s = val.trim();
  const hasPct = s.indexOf("%") !== -1;
  const cleaned = s.replace(/[%,\s]/g, "");
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!isFinite(n)) return null;
  return hasPct || (n > 1 && n <= 100) ? n / 100 : n;
}

export function areBridgeFieldValuesEqual_(val1, val2, fieldKind, timeZone = "Europe/London") {
  if (isBridgeEmptyOrPlaceholder_(val1) || isBridgeEmptyOrPlaceholder_(val2)) return false;
  const stripAlnum = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  if (fieldKind === "date") {
    const d1 = parseBridgeDateYmd_(val1, timeZone);
    const d2 = parseBridgeDateYmd_(val2, timeZone);
    if (d1 !== null && d2 !== null) return d1 === d2;
    if (d1 !== null || d2 !== null) return false;
  } else if (fieldKind === "currency") {
    const n1 = parseBridgeCurrency_(val1);
    const n2 = parseBridgeCurrency_(val2);
    if (n1 !== null && n2 !== null) {
      if (Math.abs(n1) < 0.005 && Math.abs(n2) < 0.005) return false;
      return Math.abs(n1 - n2) <= 0.01;
    }
    if (n1 !== null || n2 !== null) return false;
  } else if (fieldKind === "likelihood") {
    const p1 = parseBridgePercent_(val1);
    const p2 = parseBridgePercent_(val2);
    if (p1 !== null && p2 !== null) return Math.abs(p1 - p2) <= 0.001;
    if (p1 !== null || p2 !== null) return false;
  }

  const s1 = stripAlnum(val1);
  const s2 = stripAlnum(val2);
  return s1 !== "" && s1 === s2;
}

export function computeBridgeJobSimilarity_(job1, job2) {
  const STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "of", "to", "in", "for", "on",
    "with", "at", "by", "from", "as", "is", "be", "esp", "inc", "plus", "re",
  ]);
  const tokenize = (str) => {
    const clean = String(str || "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
    const allTokens = clean ? clean.split(" ").filter((t) => t.length >= 2) : [];
    const filtered = allTokens.filter((t) => !STOPWORDS.has(t));
    return filtered.length > 0 ? filtered : allTokens;
  };
  const set1 = new Set(tokenize(job1));
  const set2 = new Set(tokenize(job2));
  if (set1.size === 0 || set2.size === 0) {
    return { points: 0, jaccard: 0, overlapCoeff: 0, inter: 0, maxSharedTokenLen: 0, sharedLongTokenCount: 0 };
  }
  let inter = 0;
  let maxSharedTokenLen = 0;
  let sharedLongTokenCount = 0;
  set1.forEach((t) => {
    if (set2.has(t)) {
      inter++;
      if (t.length > maxSharedTokenLen) maxSharedTokenLen = t.length;
      if (t.length >= 4) sharedLongTokenCount++;
    }
  });
  const union = set1.size + set2.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  const minSize = Math.min(set1.size, set2.size);
  const overlapCoeff = minSize > 0 ? inter / minSize : 0;

  let points = 0;
  if (jaccard >= 0.5 || (inter >= 2 && overlapCoeff >= 0.75)) {
    points = 2;
  } else if ((overlapCoeff >= 0.65 && maxSharedTokenLen >= 4) || (jaccard >= 0.3 && maxSharedTokenLen >= 4)) {
    points = 1;
  }
  return { points, jaccard, overlapCoeff, inter, maxSharedTokenLen, sharedLongTokenCount };
}

export function reconcileSpreadsheetBridgeRows_(opts) {
  const incomingRows = opts.incomingRows || [];
  const rawHeaders = opts.rawHeaders || [];
  const bridgeData = Array.isArray(opts.bridgeData) ? opts.bridgeData : [];
  const uuidColIdx = opts.uuidColIdx;
  const inKeyIdx = opts.inKeyIdx;
  const brKeyIdx = opts.brKeyIdx;
  const startWeight = typeof opts.startWeight === "number" ? opts.startWeight : 1;
  const timeZone = opts.timeZone || "Europe/London";
  const generateUuid = opts.generateUuid;
  const preserveExistingRowUuid = Boolean(opts.preserveExistingRowUuid);

  const bridgeHeaders = bridgeData.length > 0 ? bridgeData[0] : [];
  const bridgeUuidIdx = bridgeHeaders.findIndex((h) => String(h).trim() === "System ID (Do Not Edit)");
  const bridgeHasAllKeys = bridgeUuidIdx !== -1 && brKeyIdx.client !== -1 && brKeyIdx.job !== -1;

  if (bridgeData.length <= 1 || !bridgeHasAllKeys) {
    let newCount = 0;
    incomingRows.forEach((r) => {
      if (!preserveExistingRowUuid || !r[uuidColIdx] || String(r[uuidColIdx]).trim() === "") {
        r[uuidColIdx] = generateUuid();
        newCount++;
      }
    });
    return { bridgeRows: incomingRows, updatedCount: 0, newCount, fullReset: true };
  }

  const normHead = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const inUsed = new Set([uuidColIdx, inKeyIdx.client, inKeyIdx.job, inKeyIdx.rev, inKeyIdx.start, inKeyIdx.end, inKeyIdx.like].filter((i) => i >= 0));
  const brUsed = new Set([bridgeUuidIdx, brKeyIdx.client, brKeyIdx.job, brKeyIdx.rev, brKeyIdx.start, brKeyIdx.end, brKeyIdx.like].filter((i) => i >= 0));
  const brByNorm = new Map();
  bridgeHeaders.forEach((h, idx) => {
    if (brUsed.has(idx) || String(h || "").trim() === "System ID (Do Not Edit)") return;
    const nh = normHead(h);
    if (!nh || brByNorm.has(nh)) return;
    brByNorm.set(nh, idx);
  });
  const secondaryColPairs = [];
  rawHeaders.forEach((h, inIdx) => {
    if (inUsed.has(inIdx) || String(h || "").trim() === "System ID (Do Not Edit)") return;
    const nh = normHead(h);
    if (!nh) return;
    const brIdx = brByNorm.get(nh);
    if (brIdx !== undefined) {
      secondaryColPairs.push({ inIdx, brIdx });
      brByNorm.delete(nh);
    }
  });

  const oldBridgeRows = bridgeData.slice(1);
  const fuzzyName = (str) =>
    String(str || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .replace(/(ltd|limited|inc|llc|corp|company)$/g, "");
  const matchedIn = new Set();
  const matchedBr = new Set();
  let updatedCount = 0;

  if (preserveExistingRowUuid) {
    const brIdxByUuid = new Map();
    oldBridgeRows.forEach((bRow, bIdx) => {
      const uid = String(bRow[bridgeUuidIdx] || "").trim();
      if (uid && !brIdxByUuid.has(uid)) brIdxByUuid.set(uid, bIdx);
    });
    incomingRows.forEach((inRow, inIdx) => {
      const uid = String(inRow[uuidColIdx] || "").trim();
      if (uid) {
        matchedIn.add(inIdx);
        const bIdx = brIdxByUuid.get(uid);
        if (bIdx !== undefined && !matchedBr.has(bIdx)) {
          matchedBr.add(bIdx);
          updatedCount++;
        }
      }
    });
  }

  const scoredPairs = [];
  incomingRows.forEach((inRow, inIdx) => {
    if (matchedIn.has(inIdx)) return;
    const inClient = String(inRow[inKeyIdx.client] || "").trim();
    const inJob = String((inKeyIdx.job >= 0 ? inRow[inKeyIdx.job] : "") || "").trim();
    const inFuzzClient = fuzzyName(inClient);
    const inFuzzJob = fuzzyName(inJob);

    oldBridgeRows.forEach((brRow, brIdx) => {
      if (matchedBr.has(brIdx)) return;
      const brClient = String(brRow[brKeyIdx.client] || "").trim();
      const brJob = String((brKeyIdx.job >= 0 ? brRow[brKeyIdx.job] : "") || "").trim();
      const brFuzzClient = fuzzyName(brClient);
      const brFuzzJob = fuzzyName(brJob);

      let score = 0;
      let clientMatched = false;

      if (inClient && brClient && inClient.toLowerCase() === brClient.toLowerCase() && inJob.toLowerCase() === brJob.toLowerCase()) {
        score += 5;
        clientMatched = true;
      } else if (inFuzzClient && brFuzzClient && inFuzzClient === brFuzzClient && inFuzzJob && brFuzzJob && inFuzzJob === brFuzzJob) {
        score += 3;
        clientMatched = true;
      } else if (inFuzzClient && brFuzzClient && inFuzzClient === brFuzzClient) {
        score += 1;
        clientMatched = true;
        score += computeBridgeJobSimilarity_(inJob, brJob).points;
      }

      if (inKeyIdx.rev !== -1 && brKeyIdx.rev !== -1 && areBridgeFieldValuesEqual_(inRow[inKeyIdx.rev], brRow[brKeyIdx.rev], "currency", timeZone)) score += 3;
      if (inKeyIdx.start !== -1 && brKeyIdx.start !== -1 && areBridgeFieldValuesEqual_(inRow[inKeyIdx.start], brRow[brKeyIdx.start], "date", timeZone)) score += startWeight;
      if (inKeyIdx.end !== -1 && brKeyIdx.end !== -1 && areBridgeFieldValuesEqual_(inRow[inKeyIdx.end], brRow[brKeyIdx.end], "date", timeZone)) score += 1;
      if (inKeyIdx.like !== -1 && brKeyIdx.like !== -1 && areBridgeFieldValuesEqual_(inRow[inKeyIdx.like], brRow[brKeyIdx.like], "likelihood", timeZone)) score += 1;

      if (score >= 2) {
        let secondaryMatches = 0;
        for (let s = 0; s < secondaryColPairs.length; s++) {
          const p = secondaryColPairs[s];
          if (areBridgeFieldValuesEqual_(inRow[p.inIdx], brRow[p.brIdx], "text", timeZone)) secondaryMatches++;
        }
        scoredPairs.push({ inIdx, brIdx, score, clientMatched, secondaryMatches, rowDistance: Math.abs(inIdx - brIdx) });
      }
    });
  });

  scoredPairs.sort((a, b) => (b.score - a.score) || (b.secondaryMatches - a.secondaryMatches) || (a.rowDistance - b.rowDistance));

  for (let i = 0; i < scoredPairs.length; i++) {
    const pair = scoredPairs[i];
    if (pair.score >= 4 && !matchedIn.has(pair.inIdx) && !matchedBr.has(pair.brIdx)) {
      matchedIn.add(pair.inIdx);
      matchedBr.add(pair.brIdx);
      incomingRows[pair.inIdx][uuidColIdx] = oldBridgeRows[pair.brIdx][bridgeUuidIdx];
      updatedCount++;
    }
  }

  for (let i = 0; i < scoredPairs.length; i++) {
    const pair = scoredPairs[i];
    if (pair.clientMatched && pair.score >= 2 && !matchedIn.has(pair.inIdx) && !matchedBr.has(pair.brIdx)) {
      matchedIn.add(pair.inIdx);
      matchedBr.add(pair.brIdx);
      incomingRows[pair.inIdx][uuidColIdx] = oldBridgeRows[pair.brIdx][bridgeUuidIdx];
      updatedCount++;
    }
  }

  const unmatchedInByClient = new Map();
  incomingRows.forEach((inRow, inIdx) => {
    if (matchedIn.has(inIdx)) return;
    const ck = fuzzyName(inRow[inKeyIdx.client]);
    if (!ck) return;
    if (!unmatchedInByClient.has(ck)) unmatchedInByClient.set(ck, []);
    unmatchedInByClient.get(ck).push(inIdx);
  });
  const unmatchedBrByClient = new Map();
  oldBridgeRows.forEach((brRow, brIdx) => {
    if (matchedBr.has(brIdx)) return;
    const ck = fuzzyName(brRow[brKeyIdx.client]);
    if (!ck) return;
    if (!unmatchedBrByClient.has(ck)) unmatchedBrByClient.set(ck, []);
    unmatchedBrByClient.get(ck).push(brIdx);
  });

  unmatchedInByClient.forEach((inList, ck) => {
    const brList = unmatchedBrByClient.get(ck);
    if (inList.length !== 1 || !brList || brList.length !== 1) return;
    const inIdx = inList[0];
    const brIdx = brList[0];
    const inRow = incomingRows[inIdx];
    const brRow = oldBridgeRows[brIdx];
    const inJob = String((inKeyIdx.job >= 0 ? inRow[inKeyIdx.job] : "") || "").trim();
    const brJob = String((brKeyIdx.job >= 0 ? brRow[brKeyIdx.job] : "") || "").trim();
    const jobSim = computeBridgeJobSimilarity_(inJob, brJob);
    let secondaryMatches = 0;
    for (let s = 0; s < secondaryColPairs.length; s++) {
      const p = secondaryColPairs[s];
      if (areBridgeFieldValuesEqual_(inRow[p.inIdx], brRow[p.brIdx], "text", timeZone)) secondaryMatches++;
    }
    const rowDistance = Math.abs(inIdx - brIdx);
    if (jobSim.sharedLongTokenCount >= 1 || (secondaryMatches >= 2 && rowDistance <= 5) || (rowDistance === 0 && secondaryMatches >= 1)) {
      matchedIn.add(inIdx);
      matchedBr.add(brIdx);
      inRow[uuidColIdx] = brRow[bridgeUuidIdx];
      updatedCount++;
    }
  });

  let newCount = 0;
  incomingRows.forEach((inRow, inIdx) => {
    if (!matchedIn.has(inIdx)) {
      if (!inRow[uuidColIdx] || String(inRow[uuidColIdx]).trim() === "") {
        inRow[uuidColIdx] = generateUuid();
      }
      newCount++;
    }
  });

  return { bridgeRows: incomingRows, updatedCount, newCount, fullReset: false };
}

// ============================================================================
// CONNECTOR #7: EXTERNAL GOOGLE SHEETS (`PullFromGoogleSheet_`, `6_Routing_Logic.gs:309-686`)
// ============================================================================

function extractSheetIdLocal_(val) {
  const str = String(val || "").trim();
  const m = str.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(str) ? str : "";
}

async function fetchExternalGoogleSheetCrm_({
  ctx,
  accessToken,
  keyInfoGrid,
  existingBridgeGrid,
  fetchImpl,
  timeZone,
}) {
  let url = String(readKeyInfoCellRaw(keyInfoGrid, "X11", "")).trim();
  let tabName = String(readKeyInfoCellRaw(keyInfoGrid, "X12", "")).trim();
  const matchColsStr = String(readKeyInfoCellRaw(keyInfoGrid, "X13", "")).trim();
  let headerRowNum = parseInt(readKeyInfoCellRaw(keyInfoGrid, "X14", "1"), 10) || 1;

  if (!url && String(readKeyInfoCellRaw(keyInfoGrid, "X14", "")).includes("http")) {
    url = String(readKeyInfoCellRaw(keyInfoGrid, "X14", "")).trim();
    tabName = String(readKeyInfoCellRaw(keyInfoGrid, "X15", "")).trim();
    headerRowNum = 1;
  }

  if (!url || !tabName) {
    throw new Error("Missing URL (X11) or Tab Name (X12) in KeyInfo for Google Sheet sync.");
  }
  if (!accessToken) {
    throw new Error("Missing Google Sheets OAuth authorization. Connect Google Sheet via PMA Integrations.");
  }

  const targetSheetId = extractSheetIdLocal_(url);
  if (!targetSheetId) {
    throw new Error("Invalid Google Sheet URL configured for CRM sync.");
  }

  const forbiddenIds = new Set();
  if (ctx?.masterSheetId) forbiddenIds.add(String(ctx.masterSheetId));
  for (const coord of ["C1", "D1", "G1", "X28"]) {
    const refId = extractSheetIdLocal_(readKeyInfoCellRaw(keyInfoGrid, coord, ""));
    if (refId) forbiddenIds.add(refId);
  }
  if (forbiddenIds.has(targetSheetId)) {
    throw new Error("Access denied: Target spreadsheet matches an internal Pulse workbook rather than an external CRM sheet.");
  }
  if (!fetchImpl) {
    const { assertExternalCrmSpreadsheet } = await import("./googleSheetService.js");
    await assertExternalCrmSpreadsheet(null, targetSheetId);
  }

  // Metadata preflight (matches 6_Routing_Logic.gs:359-380)
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(targetSheetId)}?fields=sheets.properties.title`;
  const metaRes = await connectorFetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    fetchImpl,
  });
  if (!metaRes.ok) {
    throw new Error(`Access denied (HTTP ${metaRes.status}) while verifying target Google Sheet metadata via OAuth.`);
  }
  const remoteTabNames = Array.isArray(metaRes.json?.sheets)
    ? metaRes.json.sheets.map((s) => (s?.properties ? s.properties.title : ""))
    : [];
  if (remoteTabNames.some((t) => FORBIDDEN_INTERNAL_CRM_TABS.has(String(t || "").trim()))) {
    throw new Error("Access denied: Target spreadsheet appears to be an internal Pulse workbook rather than an external CRM sheet.");
  }

  const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(targetSheetId)}/values/${encodeURIComponent(tabName)}?valueRenderOption=FORMATTED_VALUE`;
  const res = await connectorFetch(apiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    fetchImpl,
  });
  if (!res.ok) {
    throw new Error(`Google Sheets REST API fetch failed (HTTP ${res.status}) for the configured external sheet.`);
  }
  const rawData = res.json?.values || [];
  if (!rawData || rawData.length === 0) {
    return {
      toolLabel: "Google Sheets",
      incomingCount: 0,
      emptyMessage: true,
      headers: [],
      rows: [],
      nextBridgeGrid: existingBridgeGrid,
      textColsSet: new Set(),
      stampDataChgAlertOnWrite: false,
    };
  }

  const maxCols = Math.max(...rawData.map((r) => r.length));
  const normalizedData = rawData.map((r) => {
    const row = [...r];
    while (row.length < maxCols) row.push("");
    return row.map((cell) => {
      if (Object.prototype.toString.call(cell) === "[object Date]") {
        return formatDayMonYy_(cell, timeZone);
      }
      if (typeof cell === "string" && cell.includes("GMT") && /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2}/.test(cell)) {
        const parsed = new Date(cell);
        if (!isNaN(parsed.getTime())) return formatDayMonYy_(parsed, timeZone);
      }
      return cell;
    });
  });

  const headerIdx = Math.max(0, headerRowNum - 1);
  if (headerIdx >= normalizedData.length) {
    throw new Error("Header Row Number (X14) is out of bounds.");
  }

  const rawHeaders = [...normalizedData[headerIdx]];
  const googleRows = normalizedData
    .slice(headerIdx + 1)
    .filter((r) => r.join("").trim() !== "")
    .map((r) => [...r]);

  let uuidColIdx = rawHeaders.findIndex((h) => String(h).trim() === "System ID (Do Not Edit)");
  if (uuidColIdx === -1) {
    uuidColIdx = rawHeaders.length;
    rawHeaders.push("System ID (Do Not Edit)");
    googleRows.forEach((r) => r.push(""));
  } else {
    googleRows.forEach((r) => {
      while (r.length <= uuidColIdx) r.push("");
    });
  }

  const normHead = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const resolveGoogleKeyIndices_ = (hdrs) => {
    let c = -1;
    let j = -1;
    let r = -1;
    let s = -1;
    let e = -1;
    let l = -1;
    if (!Array.isArray(hdrs) || hdrs.length === 0) {
      return { client: -1, job: -1, rev: -1, start: -1, end: -1, like: -1 };
    }
    if (matchColsStr) {
      const keyIndices = matchColsStr.split(",").map((name) => {
        const n = name.trim();
        if (!n || n.toLowerCase() === "none" || n.toLowerCase() === "n/a") return -1;
        const cleanName = normHead(n);
        return hdrs.findIndex((h) => normHead(h) === cleanName);
      });
      [c, j, r, s, e, l] = keyIndices;
    }
    if (c === -1) c = hdrs.findIndex((h) => /^(?:client|lead|org|company|customer)/i.test(normHead(h)));
    if (j === -1) j = hdrs.findIndex((h, i) => i !== c && /^(?:job|deal|opportunity|task|title|name|nature)/i.test(normHead(h)));
    if (r === -1) r = hdrs.findIndex((h) => /^(?:value|amount|revenue|total|deal|fee)/i.test(normHead(h)));
    if (s === -1) s = hdrs.findIndex((h) => /^(?:start|month|target|live|date)/i.test(normHead(h)));
    if (e === -1) e = hdrs.findIndex((h, i) => i !== s && /^(?:end|close|completion)/i.test(normHead(h)));
    if (l === -1) l = hdrs.findIndex((h) => /^(?:status|stage|milestone|prob|likelihood)/i.test(normHead(h)));
    if (c === -1) c = 0;
    if (j === -1) j = Math.min(1, hdrs.length - 1);
    return { client: c, job: j, rev: r, start: s, end: e, like: l };
  };

  const inKeyIdx = resolveGoogleKeyIndices_(rawHeaders);
  const bridgeData = Array.isArray(existingBridgeGrid) ? existingBridgeGrid : [];
  const bridgeHeaders = bridgeData.length > 0 ? bridgeData[0] : [];
  const brKeyIdx = resolveGoogleKeyIndices_(bridgeHeaders);

  const reconciled = reconcileSpreadsheetBridgeRows_({
    incomingRows: googleRows,
    rawHeaders,
    bridgeData,
    uuidColIdx,
    inKeyIdx,
    brKeyIdx,
    startWeight: 2,
    timeZone,
    generateUuid: () => crypto.randomUUID(),
    preserveExistingRowUuid: true,
  });
  const bridgeRows = reconciled.bridgeRows;

  const safeRawHeaders = sanitizeSheetMatrix_([rawHeaders])[0];
  const safeBridgeRows = sanitizeSheetMatrix_(bridgeRows);
  const incomingCount = safeBridgeRows.filter(
    (r) => Array.isArray(r) && r.some((c) => c !== null && c !== undefined && String(c).trim() !== "")
  ).length;

  return {
    toolLabel: "Google Sheets",
    incomingCount,
    emptyMessage: false,
    headers: safeRawHeaders,
    rows: safeBridgeRows,
    idColIdx: uuidColIdx,
    nextBridgeGrid: normalizeVirtualMasterGrid("CRMGoogleBridge", [safeRawHeaders, ...safeBridgeRows], new Set([uuidColIdx])),
    textColsSet: new Set([uuidColIdx]),
    stampDataChgAlertOnWrite: false,
  };
}

// ============================================================================
// CONNECTOR #8: EXTERNAL MICROSOFT EXCEL (`PullFromExcelSheet_`, `6_Routing_Logic.gs:770-1228`)
// ============================================================================

async function fetchExternalExcelCrm_({ accessToken, keyInfoGrid, existingBridgeGrid, fetchImpl, timeZone }) {
  const driveId = assertValidGraphSegment(readKeyInfoCellRaw(keyInfoGrid, "X36", ""), "Excel Drive ID");
  const fileId = assertValidGraphSegment(readKeyInfoCellRaw(keyInfoGrid, "X37", ""), "Excel File ID");
  const sheetName = String(readKeyInfoCellRaw(keyInfoGrid, "X38", "")).trim();
  const headerRowNum = parseInt(readKeyInfoCellRaw(keyInfoGrid, "X40", "1"), 10) || 1;
  const matchColsStr = String(readKeyInfoCellRaw(keyInfoGrid, "X41", "")).trim();

  if (!sheetName || !matchColsStr) {
    throw new Error("Missing Excel file configuration in KeyInfo (X36-X38, X41).");
  }
  if (!accessToken) {
    throw new Error("Missing Excel authorization. Please connect Microsoft Excel via PMA Integrations.");
  }

  const cacheBuster = Date.now();
  const url =
    `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}` +
    `/items/${encodeURIComponent(fileId)}/workbook/worksheets/${encodeURIComponent(sheetName)}/usedRange?t=${cacheBuster}`;
  const res = await connectorFetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
    },
    fetchImpl,
  });
  if (res.json?.error) {
    throw new Error(`Graph API Error: ${res.json.error.message || JSON.stringify(res.json.error)}`);
  }
  if (!res.ok) {
    throw new Error(`Microsoft Graph API Error (HTTP ${res.status}): ${res.text?.slice(0, 200) || ""}`);
  }

  const excelData = res.json?.text || res.json?.values || [];
  if (!excelData || excelData.length === 0) {
    return {
      toolLabel: "Excel",
      incomingCount: 0,
      emptyMessage: true,
      headers: [],
      rows: [],
      nextBridgeGrid: existingBridgeGrid,
      nextExcelCopyGrid: [],
      textColsSet: new Set(),
      stampDataChgAlertOnWrite: false,
    };
  }

  const safeExcelData = sanitizeSheetMatrix_(excelData);
  const nextExcelCopyGrid = normalizeVirtualMasterGrid("CRMExcelCopy", safeExcelData);

  const headerIdx = Math.max(0, headerRowNum - 1);
  if (headerIdx >= excelData.length) {
    throw new Error("Header Row Number (X40) is out of bounds.");
  }

  const rawHeaders = [...excelData[headerIdx]];
  const excelRows = excelData
    .slice(headerIdx + 1)
    .filter((r) => r.join("").trim() !== "")
    .map((r) => [...r]);

  let uuidColIdx = rawHeaders.findIndex((h) => String(h).trim() === "System ID (Do Not Edit)");
  if (uuidColIdx === -1) {
    uuidColIdx = rawHeaders.length;
    rawHeaders.push("System ID (Do Not Edit)");
    excelRows.forEach((r) => r.push(""));
  } else {
    excelRows.forEach((r) => {
      while (r.length <= uuidColIdx) r.push("");
    });
  }

  const matchColNames = matchColsStr.split(",").map((s) => s.trim());
  const [mClient, mJob, mRev, mStart, mEnd, mLike] = [
    matchColNames[0] || "None",
    matchColNames[1] || "None",
    matchColNames[2] || "None",
    matchColNames[3] || "None",
    matchColNames[4] || "None",
    matchColNames[5] || "None",
  ];

  const normHead = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const resolveIdx = (colName, hdrs) => {
    if (!colName || colName.toLowerCase() === "none" || colName.toLowerCase() === "-- none / not in sheet --") return -1;
    const clean = normHead(colName);
    return hdrs.findIndex((h) => normHead(h) === clean);
  };

  const idxClient = resolveIdx(mClient, rawHeaders);
  const idxJob = resolveIdx(mJob, rawHeaders);
  const idxRev = resolveIdx(mRev, rawHeaders);
  const idxStart = resolveIdx(mStart, rawHeaders);
  const idxEnd = resolveIdx(mEnd, rawHeaders);
  const idxLike = resolveIdx(mLike, rawHeaders);

  if (idxClient === -1 || idxJob === -1) {
    throw new Error(`Could not find required Client ('${mClient}') and Job ('${mJob}') columns in Excel headers.`);
  }

  const bridgeData = Array.isArray(existingBridgeGrid) ? existingBridgeGrid : [];
  const bridgeHeaders = bridgeData.length > 0 ? bridgeData[0] : [];
  const bIdxClient = resolveIdx(mClient, bridgeHeaders);
  const bIdxJob = resolveIdx(mJob, bridgeHeaders);
  const bIdxRev = resolveIdx(mRev, bridgeHeaders);
  const bIdxStart = resolveIdx(mStart, bridgeHeaders);
  const bIdxEnd = resolveIdx(mEnd, bridgeHeaders);
  const bIdxLike = resolveIdx(mLike, bridgeHeaders);

  const reconciled = reconcileSpreadsheetBridgeRows_({
    incomingRows: excelRows,
    rawHeaders,
    bridgeData,
    uuidColIdx,
    inKeyIdx: { client: idxClient, job: idxJob, rev: idxRev, start: idxStart, end: idxEnd, like: idxLike },
    brKeyIdx: { client: bIdxClient, job: bIdxJob, rev: bIdxRev, start: bIdxStart, end: bIdxEnd, like: bIdxLike },
    startWeight: 1,
    timeZone,
    generateUuid: () => crypto.randomUUID(),
    preserveExistingRowUuid: false,
  });
  const bridgeRows = reconciled.bridgeRows;

  const safeExcelHeaders = sanitizeSheetMatrix_([rawHeaders])[0];
  const safeExcelBridgeRows = sanitizeSheetMatrix_(bridgeRows);
  const incomingCount = safeExcelBridgeRows.filter(
    (r) => Array.isArray(r) && r.some((c) => c !== null && c !== undefined && String(c).trim() !== "")
  ).length;

  // Rectangularize & normalize date formats for DataFromCRM (`6_Routing_Logic.gs:1037-1055`)
  const finalBridgeData = [safeExcelHeaders, ...safeExcelBridgeRows];
  const maxColsArr = Math.max(...finalBridgeData.map((r) => r.length));
  const rectangularData = finalBridgeData.map((row) => {
    const r = [...row];
    while (r.length < maxColsArr) r.push("");
    return r.map((cell) => {
      if (Object.prototype.toString.call(cell) === "[object Date]") {
        return formatDayMonYy_(cell, timeZone);
      }
      if (typeof cell === "string" && cell.includes("GMT") && /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2}/.test(cell)) {
        const parsedDate = new Date(cell);
        if (!isNaN(parsedDate.getTime())) return formatDayMonYy_(parsedDate, timeZone);
      }
      return cell;
    });
  });

  // Verbatim areExcelRowsEquivalent_ (`6_Routing_Logic.gs:1086-1142`)
  const toExcelDateYmd = (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (Object.prototype.toString.call(v) === "[object Date]") {
      return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    }
    if (typeof v === "number" && v > 20000 && v < 70000 && Math.abs(v - Math.round(v)) < 1e-6) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return d.toISOString().slice(0, 10);
    }
    if (typeof v === "string") {
      const s = v.trim();
      if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s)) {
        const parsed = new Date(s.replace(/-/g, " "));
        if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
      }
    }
    return null;
  };
  const toExcelNum = (v) => {
    if (typeof v === "number") return isFinite(v) ? Math.round(v * 1000000) / 1000000 : null;
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (!s) return null;
    if (/^[-+]?[\d,]+(\.\d+)?%$/.test(s)) {
      const p = parseFloat(s.replace(/[,%\s]/g, "")) / 100;
      return isNaN(p) ? null : Math.round(p * 1000000) / 1000000;
    }
    if (/^[£$€\s]*[-+]?[\d,]+(\.\d+)?\s*$/.test(s)) {
      const n = parseFloat(s.replace(/[£$€,\s]/g, ""));
      return isNaN(n) ? null : Math.round(n * 1000000) / 1000000;
    }
    return null;
  };
  const areExcelRowsEquivalent = (rowA, rowB) => {
    const len = Math.max((rowA || []).length, (rowB || []).length);
    for (let c = 0; c < len; c++) {
      const a = rowA && rowA[c] !== undefined && rowA[c] !== null ? rowA[c] : "";
      const b = rowB && rowB[c] !== undefined && rowB[c] !== null ? rowB[c] : "";
      if (a === b) continue;
      const nA = toExcelNum(a);
      const nB = toExcelNum(b);
      if (nA !== null && nB !== null) {
        if (Math.abs(nA - nB) <= 1e-6) continue;
        return false;
      }
      const dA = toExcelDateYmd(a);
      const dB = toExcelDateYmd(b);
      if (dA && dB) {
        if (dA === dB) continue;
        return false;
      }
      if (String(a).trim() !== String(b).trim()) return false;
    }
    return true;
  };

  return {
    toolLabel: "Excel",
    incomingCount,
    emptyMessage: false,
    headers: rectangularData[0],
    rows: rectangularData.slice(1),
    idColIdx: uuidColIdx,
    nextBridgeGrid: normalizeVirtualMasterGrid("CRMExcelBridge", [safeExcelHeaders, ...safeExcelBridgeRows], new Set([uuidColIdx])),
    nextExcelCopyGrid,
    textColsSet: new Set([uuidColIdx]),
    compareRowsEqualFn: areExcelRowsEquivalent,
    stampDataChgAlertOnWrite: false,
  };
}

// ============================================================================
// PUBLIC ENGINE: PULL NATIVE CRM DEALS (`PullCRMBasedOn` 100% VERBATIM)
// ============================================================================

export async function pullNativeCrmDeals(ctx, options = {}) {
  const {
    tokenOverride = null,
    fetchImpl = null,
    sleepImpl = null,
    persistToDb = true,
    keyInfoOverride = null,
    existingGridOverride = null,
    bridgeGridOverride = null,
    scriptPropsOverride = null,
    nowDate = new Date(),
  } = options;

  const state = await loadConnectorContextState(ctx, keyInfoOverride);
  const keyInfoGrid = state.keyInfoGrid;
  const scriptProps = scriptPropsOverride ? { ...scriptPropsOverride } : { ...state.scriptProps };

  const crmToolRaw = String(readKeyInfoCellRaw(keyInfoGrid, "Q8", "None")).trim();
  const tool = normalizeCrmToolName_(crmToolRaw, keyInfoGrid);
  if (tool === "none") {
    return {
      success: true,
      tool: "none",
      skipped: true,
      dataChanged: false,
      lastError: "",
    };
  }

  let accessToken = "";
  try {
    const tokRes = await resolveCrmAccessToken_(ctx, tool, tokenOverride);
    accessToken = tokRes.accessToken;
  } catch (err) {
    return {
      success: false,
      tool,
      dataChanged: false,
      lastError: err.message || String(err),
      reconnectRequired: Boolean(err.reconnectRequired),
    };
  }

  // Load existing Google/Excel bridges BEFORE calling connector
  let existingGoogleBridge = Array.isArray(bridgeGridOverride)
    ? bridgeGridOverride
    : Array.isArray(state.cfgRow?.crm_google_bridge_grid)
      ? state.cfgRow.crm_google_bridge_grid
      : [];
  if (existingGoogleBridge.length === 0 && tool === "googlesheet") {
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", "CRMGoogleBridge", null).catch(() => null);
    if (Array.isArray(rec?.values_grid)) existingGoogleBridge = rec.values_grid;
  }

  let existingExcelBridge = Array.isArray(bridgeGridOverride)
    ? bridgeGridOverride
    : Array.isArray(state.cfgRow?.crm_excel_bridge_grid)
      ? state.cfgRow.crm_excel_bridge_grid
      : [];
  if (existingExcelBridge.length === 0 && tool === "excel") {
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", "CRMExcelBridge", null).catch(() => null);
    if (Array.isArray(rec?.values_grid)) existingExcelBridge = rec.values_grid;
  }

  let connectorOut;
  switch (tool) {
    case "hubspot":
      connectorOut = await fetchHubSpotCrm_({ accessToken, fetchImpl, sleepImpl, timeZone: state.timeZone });
      break;
    case "pipedrive":
      connectorOut = await fetchPipedriveCrm_({ accessToken, fetchImpl, sleepImpl, timeZone: state.timeZone });
      break;
    case "monday":
      connectorOut = await fetchMondayCrm_({ accessToken, keyInfoGrid, fetchImpl, sleepImpl });
      break;
    case "clickup":
      connectorOut = await fetchClickUpCrm_({ accessToken, keyInfoGrid, fetchImpl, sleepImpl, timeZone: state.timeZone });
      break;
    case "close":
      connectorOut = await fetchCloseCrm_({ accessToken, fetchImpl, sleepImpl, timeZone: state.timeZone });
      break;
    case "capsule":
      connectorOut = await fetchCapsuleCrm_({ accessToken, fetchImpl, sleepImpl, timeZone: state.timeZone });
      break;
    case "googlesheet":
      connectorOut = await fetchExternalGoogleSheetCrm_({
        ctx,
        accessToken,
        keyInfoGrid,
        existingBridgeGrid: existingGoogleBridge,
        fetchImpl,
        timeZone: state.timeZone,
      });
      break;
    case "excel":
      connectorOut = await fetchExternalExcelCrm_({
        accessToken,
        keyInfoGrid,
        existingBridgeGrid: existingExcelBridge,
        fetchImpl,
        timeZone: state.timeZone,
      });
      break;
    default:
      return {
        success: false,
        tool,
        dataChanged: false,
        lastError: `Unsupported CRM tool in KeyInfo!Q8: "${crmToolRaw}"`,
      };
  }

  // Load existing DataFromCRM virtual grid & CRMList
  let existingGrid = Array.isArray(existingGridOverride) ? existingGridOverride : null;
  let crmListGrid = [];
  if (!existingGrid || ctx?.connectorPullMode === "native") {
    const bundle = await preloadClientRelationalMasterBundle(ctx, {
      source: "db",
      tables: ["crmDeals"],
    }).catch(() => null);
    if (bundle) {
      const reconCrmList = await reconstructRelationalMasterTabFromBundle(bundle, "CRMList", ctx).catch(() => null);
      if (Array.isArray(reconCrmList)) {
        crmListGrid = reconCrmList;
      }
      if (!existingGrid) {
        const hdrs =
          Array.isArray(bundle.config?.crm_raw_headers) &&
            bundle.config.crm_raw_headers.length > 0
            ? bundle.config.crm_raw_headers
            : connectorOut.headers;
        existingGrid = projectCrmDealsToDataFromCrmGrid({
          headers: hdrs,
          records: bundle.crmDeals || [],
        });
      }
    }
  }
  if (!existingGrid) {
    const rec = await getOrLoadVirtualTabGrid_(ctx, "master", "DataFromCRM", null).catch(() => null);
    existingGrid = Array.isArray(rec?.values_grid) ? rec.values_grid : [];
  }

  // Evaluate ±25% swing guard BEFORE persisting any changes (`6_Routing_Logic.gs:135-208`)
  const existingCount = countExistingCrmDataRows_(existingGrid);
  const guardResult = guardNativeCrmRowCountSwing({
    existingCount,
    incomingCount: connectorOut.incomingCount,
    crmTool: connectorOut.toolLabel || crmToolRaw,
    scriptProps,
    nowIso: nowDate.toISOString(),
  });

  if (!guardResult.allowed) {
    if (persistToDb && guardResult.blockInfo) {
      await persistConnectorScriptProperties(ctx, {
        CRM_SYNC_SWING_BLOCK_JSON: JSON.stringify(guardResult.blockInfo),
      });
    }
    return {
      success: false,
      blocked: true,
      syncBlocked: true,
      overrideUsed: false,
      tool,
      blockInfo: guardResult.blockInfo,
      dataChanged: false,
      lastError: `CRM sync paused (${guardResult.blockInfo.crmTool}: ${guardResult.blockInfo.incomingCount} vs ${guardResult.blockInfo.existingCount})`,
    };
  }

  // Matches GAS connector behavior: if 0 deals returned (and not blocked), return cleanly without overwriting
  if (connectorOut.emptyMessage) {
    if (persistToDb && guardResult.clearProps.length > 0) {
      await persistConnectorScriptProperties(ctx, {}, guardResult.clearProps);
    }
    return {
      success: true,
      blocked: false,
      syncBlocked: false,
      overrideUsed: guardResult.overrideUsed,
      overrideInfo: guardResult.overrideInfo || null,
      tool,
      dataChanged: false,
      rowsCount: existingCount,
      headers: existingGrid[0] || [],
      nextGrid: existingGrid,
      lastError: "",
    };
  }

  const { nextGrid, dataChanged } = applySlotReuseDeltaGrid({
    existingGrid,
    headers: connectorOut.headers,
    incomingRows: connectorOut.rows,
    textColsSet: connectorOut.textColsSet,
    tabName: "DataFromCRM",
    idColIdx: connectorOut.idColIdx ?? 0,
    forceFullOverwrite: false,
    preserveExistingHeadersIfPresent: false,
    compareRowsEqualFn: connectorOut.compareRowsEqualFn || null,
  });

  if (persistToDb && ctx?.clientId) {
    const supabase = getSupabaseAdmin();
    if (supabase) {
      const parsedCrm = parseCrmDealsFromGrids({
        clientId: ctx.clientId,
        clientName: ctx.clientName,
        dataFromCrmGrid: nextGrid,
        crmListGrid,
      });
      await upsertCrmRowsInChunks_(supabase, ctx.clientId, parsedCrm.rows);

      const cfgPatch = {
        crm_raw_headers: nextGrid[0] || connectorOut.headers,
      };
      if (connectorOut.nextBridgeGrid) {
        if (tool === "googlesheet") cfgPatch.crm_google_bridge_grid = connectorOut.nextBridgeGrid;
        if (tool === "excel") cfgPatch.crm_excel_bridge_grid = connectorOut.nextBridgeGrid;
      }
      if (connectorOut.nextExcelCopyGrid) {
        cfgPatch.crm_excel_copy_grid = connectorOut.nextExcelCopyGrid;
      }
      await saveConnectorConfigPatch(ctx, cfgPatch);
    }

    if (guardResult.clearProps.length > 0) {
      await persistConnectorScriptProperties(ctx, {}, guardResult.clearProps);
    }

    if (connectorOut.stampDataChgAlertOnWrite && dataChanged) {
      await stampCrmChangeAlert_(ctx, nowDate);
    }
    await stampMasterCompTimestamp(ctx, "CRMComp", "J2", nowDate);

    if (ctx.connectorPullMode !== "native") {
      await saveVirtualTabGrid_(ctx, "master", "DataFromCRM", nextGrid, nextGrid, {}).catch(() => { });
      if (connectorOut.nextBridgeGrid && tool === "googlesheet") {
        await saveVirtualTabGrid_(ctx, "master", "CRMGoogleBridge", connectorOut.nextBridgeGrid, connectorOut.nextBridgeGrid, {}).catch(() => { });
      }
      if (connectorOut.nextBridgeGrid && tool === "excel") {
        await saveVirtualTabGrid_(ctx, "master", "CRMExcelBridge", connectorOut.nextBridgeGrid, connectorOut.nextBridgeGrid, {}).catch(() => { });
      }
      if (connectorOut.nextExcelCopyGrid && tool === "excel") {
        await saveVirtualTabGrid_(ctx, "master", "CRMExcelCopy", connectorOut.nextExcelCopyGrid, connectorOut.nextExcelCopyGrid, {}).catch(() => { });
      }
    }

    invalidateClientRelationalMasterCache(ctx.clientName);
    if (ctx.masterComputeMode === "native" || ctx.masterComputeMode === "shadow") {
      await computeAndPersistNativeMasterComparisons(ctx, { domains: ["crm"] }).catch(() => { });
    }
  }

  return {
    success: true,
    blocked: false,
    syncBlocked: false,
    overrideUsed: guardResult.overrideUsed,
    overrideInfo: guardResult.overrideUsed
      ? { existingCount: guardResult.existingCount, incomingCount: guardResult.incomingCount }
      : null,
    tool,
    toolLabel: connectorOut.toolLabel,
    dataChanged,
    rowsCount: Math.max(0, nextGrid.length - 1),
    headers: nextGrid[0] || connectorOut.headers,
    nextGrid,
    nextBridgeGrid: connectorOut.nextBridgeGrid || null,
    nextExcelCopyGrid: connectorOut.nextExcelCopyGrid || null,
    lastError: "",
  };
}
