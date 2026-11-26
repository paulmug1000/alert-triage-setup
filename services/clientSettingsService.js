/**
 * ============================================================================
 * CLIENT SETTINGS SERVICE
 * ============================================================================
 * 
 * Manages full multi-section client settings across:
 * - Master Sheet: KeyInfo (Main, Customisation, Accounting, CRM, Jobs, Pulse portal features)
 * - Master Sheet: DataChgAlert (Automation frequencies & discrepancy rules)
 * 
 * Features:
 * - Redis-backed caching with automatic stale-while-revalidate TTL
 * - Instant reads (~10ms) and optimistic write-through updates
 * - Parallel batchGet & batchUpdate across Master and Client Google Sheets
 * - Formula preservation & safe 2D array expansion for KPI Colouring rules
 */

import { waitUntil } from "@vercel/functions";
import { getSheetsClient, withRetry } from "./sheetsClient.js";
import { redisClient, ensureRedisConnected } from "./redisClient.js";
import { sanitizeFormulaInput, unwrapSheetId } from "./userPermissions.js";
import { postGasWebAppLocked } from "../utils/helpers.js";
import { assertExternalCrmSpreadsheet } from "./googleSheetService.js";
import { clearAllClientsMemoryCache, getClientWebAppUrl } from "./workspaces.js";
import { clearSsrClientsMemoryCache } from "./ssrSession.js";
import { resolveSupabaseSheetContext, getOrLoadVirtualTabGrid_ } from "./masterEngineService.js";
import { memoryCache, del2TierCache, invalidatePmaClientCache, invalidateAllClientsRedisKeys } from "./cacheService.js";
import { getSupabaseAdmin } from "./supabaseClient.js";
import { clearPortalFeatureFlagsMemoryCache } from "./portalDataService.js";
import { formatCellForDisplay } from "./gasRuntime/sheetValueUtils.js";
import {
  refreshNativeChartOfAccounts,
  pullLivePLToSupabaseNative,
  runNativeMasterAmdAction,
  mirrorAutomationFrequenciesToSyncSchedules,
} from "./masterSyncEngine.js";

const REDIS_SETTINGS_PREFIX = "pulse:client_settings:";
const REDIS_CRM_PREVIEW_PREFIX = "pulse:client_settings_crm:";
const REDIS_SETTINGS_TTL = 1800; // 30 minutes cache
const L1_SETTINGS_TTL = 60; // 60 seconds in-memory L1 cache

/**
 * Pulse required CRM fields mapping configuration
 */
export const CRM_PULSE_FIELDS = [
  { key: "client", label: "Client", colLetter: "A", crmColLetter: "AB", defaultFormat: "Other", formatOptions: ["Other", "String"] },
  { key: "job", label: "Job", colLetter: "B", crmColLetter: "AC", defaultFormat: "", formatOptions: [] },
  { key: "projectCode", label: "Project code", colLetter: "C", crmColLetter: "AD", defaultFormat: "", formatOptions: [] },
  { key: "revenue", label: "Revenue", colLetter: "D", crmColLetter: "AE", defaultFormat: "Actual", formatOptions: ["Actual", "Strip value"] },
  { key: "directCosts", label: "Direct costs", colLetter: "E", crmColLetter: "AF", defaultFormat: "", formatOptions: [] },
  { key: "startDate", label: "Start date", colLetter: "F", crmColLetter: "AG", defaultFormat: "Actual", formatOptions: ["Actual", "Convert US", "Actual OR by Status"] },
  {
    key: "endDate",
    label: "End date",
    colLetter: "G",
    crmColLetter: "AH",
    defaultFormat: "Actual",
    formatOptions: [
      "Actual",
      "Months",
      "AddRetEnd",
      "2MonthsForAll",
      "3MonthsForAll",
      "4MonthsForAll",
      "ActualOr2MonthsForAll",
      "ActualOr3MonthsForAll",
      "ActualOr4MonthsForAll",
      "MonthsOr2MonthsForAll",
      "MonthsOr3MonthsForAll",
      "MonthsOr4MonthsForAll",
      "2MonthsProj6MonthsRet",
      "ActualOrAddRetEndOr2MonthsProj",
      "ActualOrAddRetEndOr3MonthsProj",
      "ActualOrAddRetEndOr4MonthsProj"
    ]
  },
  { key: "likelihood", label: "Likelihood", colLetter: "H", crmColLetter: "AI", defaultFormat: "Actual", formatOptions: ["Actual", "Divide by 100", "Mapped", "ActualOrMappedByStatus"] },
  { key: "status", label: "Status", colLetter: "I", crmColLetter: "AJ", defaultFormat: "", formatOptions: [] },
  {
    key: "projectRetainer",
    label: "Project / retainer",
    colLetter: "J",
    crmColLetter: "AK",
    defaultFormat: "From CRM",
    formatOptions: [
      "From CRM",
      "All project",
      "All retainer",
      "FromCRMOrAllProject",
      "FromCRMOrAllRetainer",
      "FromCRMConvertOrAllProject",
      "FromCRMConvertOrAllRetainer"
    ]
  },
  { key: "leadSource", label: "Lead source", colLetter: "K", crmColLetter: "AL", defaultFormat: "Mapped", formatOptions: ["Mapped", "Actual"] },
  { key: "dateAddedToPipeline", label: "Date added to pipeline", colLetter: "L", crmColLetter: "AM", defaultFormat: "", formatOptions: [] },
  { key: "productLine", label: "Product line", colLetter: "M", crmColLetter: "AN", defaultFormat: "Mapped", formatOptions: ["Mapped", "Actual"] }
];

/**
 * Normalizes a client key for Redis storage.
 */
export function getSettingsRedisKey(clientName) {
  const clean = String(clientName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  return `${REDIS_SETTINGS_PREFIX}${clean}`;
}

export function getCrmPreviewRedisKey(clientName) {
  const clean = String(clientName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  return `${REDIS_CRM_PREVIEW_PREFIX}${clean}`;
}

function runBackgroundTask_(promise) {
  if (!promise || typeof promise.catch !== "function") return;
  const safePromise = promise.catch((err) => {
    console.warn("⚠️ Background clientSettings task error:", err?.message || err);
  });
  try {
    waitUntil(safePromise);
  } catch {
    // Outside Vercel runtime, allow promise to settle in background
  }
}

function clearClientSettingsMemoryCache_(clientName, { includeCrmPreview = true } = {}) {
  if (!clientName) return;
  memoryCache.del(getSettingsRedisKey(clientName));
  if (includeCrmPreview) {
    memoryCache.del(getCrmPreviewRedisKey(clientName));
  }
}

function sanitizeCachedSettings_(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  const clone = { ...parsed };
  if (clone.crm && typeof clone.crm === "object") {
    clone.crm = {
      ...clone.crm,
      googleSheetUrl: sanitizeCrmGoogleSheetUrl_(clone.crm.googleSheetUrl),
      ...(clone.crm.excel && typeof clone.crm.excel === "object"
        ? {
          excel: {
            ...clone.crm.excel,
            ...(clone.crm.excel.azureClientSecret ? { azureClientSecret: "••••••••" } : {}),
          },
        }
        : {}),
    };
  }
  if (clone.customisation && typeof clone.customisation === "object") {
    const rf = String(clone.customisation.revenueFocus || "Revenue").trim();
    const dcm = String(clone.customisation.directCostsMode || "Contractors").trim();
    clone.customisation = {
      ...clone.customisation,
      directCostsMode: rf === "Income" ? "Pass-through" : (dcm === "Pass-through" ? "Pass-through" : "Contractors"),
    };
  }
  return clone;
}

/**
 * Reads sparse scalar/single-row cells from large Supabase virtual tabs
 * (InvAppList, JnlAppList, CRMList row 2, DataFromCRM row 1, Outgoings!A112)
 * using PostgREST JSONB path selection so megabyte grids are not transferred.
 */
async function readSparseTabsFromSupabase_({ clientName, masterSheetId, clientSheetId }) {
  const result = {
    invAppList: null,
    jnlAppList: null,
    crmListRow2: null,
    dataFromCrmRow1: null,
    outgoingsA112: null,
  };

  const sb = getSupabaseAdmin();
  if (!sb) return result;

  const [supaCtx, clientSupaCtx] = await Promise.all([
    resolveSupabaseSheetContext({ clientName, spreadsheetId: masterSheetId }).catch(() => null),
    clientSheetId
      ? resolveSupabaseSheetContext({ clientName, spreadsheetId: clientSheetId }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const tasks = [];

  if (supaCtx?.masterMode === "supabase") {
    const dbClientName = supaCtx.clientName || clientName;
    const useNativeOrRelMaster =
      supaCtx.masterComputeMode === "native" || supaCtx.masterReadMode === "relational";

    if (useNativeOrRelMaster) {
      tasks.push(
        Promise.all([
          getOrLoadVirtualTabGrid_(supaCtx, "master", "InvAppList", null, { valuesOnly: true }).catch(() => null),
          getOrLoadVirtualTabGrid_(supaCtx, "master", "JnlAppList", null, { valuesOnly: true }).catch(() => null),
          getOrLoadVirtualTabGrid_(supaCtx, "master", "CRMList", null, { valuesOnly: true }).catch(() => null),
          getOrLoadVirtualTabGrid_(supaCtx, "master", "DataFromCRM", null, { valuesOnly: true }).catch(() => null),
        ]).then(([invRec, jnlRec, crmListRec, dfcRec]) => {
          const invG = invRec?.values_grid;
          if (Array.isArray(invG) && invG.length > 0) {
            const invF1 = String(formatCellForDisplay("master", "InvAppList", 0, 5, invG?.[0]?.[5]) || "StripPre").trim();
            const rawInvRows = [];
            for (let r = 3; r <= 19; r++) {
              rawInvRows.push([formatCellForDisplay("master", "InvAppList", r, 13, invG?.[r]?.[13])]);
            }
            result.invAppList = { invF1, rawInvRows };
          }
          const jnlG = jnlRec?.values_grid;
          if (Array.isArray(jnlG) && jnlG.length > 0) {
            result.jnlAppList = String(formatCellForDisplay("master", "JnlAppList", 1, 5, jnlG?.[1]?.[5]) || "Actual").trim() || "Actual";
          }
          const crmRow2 = crmListRec?.values_grid?.[1];
          if (Array.isArray(crmRow2)) {
            const crmFormatRules = [];
            for (let c = 0; c <= 12; c++) {
              crmFormatRules.push(String(formatCellForDisplay("master", "CRMList", 1, c, crmRow2[c]) || "").trim());
            }
            const crmMappedCols = [];
            for (let c = 27; c <= 39; c++) {
              crmMappedCols.push(String(formatCellForDisplay("master", "CRMList", 1, c, crmRow2[c]) || "").trim());
            }
            result.crmListRow2 = {
              crmFormatRules,
              crmMappedCols,
              confirmedLikelihood: String(formatCellForDisplay("master", "CRMList", 1, 107, crmRow2[107]) || "").trim(),
              confirmedStatus: String(formatCellForDisplay("master", "CRMList", 1, 109, crmRow2[109]) || "").trim(),
              confirmedOperator: String(formatCellForDisplay("master", "CRMList", 1, 111, crmRow2[111]) || "Or").trim(),
              pipelineExcludedStatuses: String(formatCellForDisplay("master", "CRMList", 1, 134, crmRow2[134]) || "").trim(),
            };
          }
          const dfcRow1 = dfcRec?.values_grid?.[0];
          if (Array.isArray(dfcRow1)) {
            result.dataFromCrmRow1 = dfcRow1.map((h) => String(h ?? "").trim()).filter(Boolean);
          }
        })
      );
    } else {
      // InvAppList: F1 (row 0, col 5) and N4:N20 (rows 3..19, col 13)
      const invCols = ["tab_name", "f1:values_grid->0->5"];
      for (let r = 3; r <= 19; r++) {
        invCols.push(`r${r}:values_grid->${r}->13`);
      }
      tasks.push(
        sb
          .from("master_sheet_grids")
          .select(invCols.join(", "))
          .eq("client_name", dbClientName)
          .eq("sheet_role", "master")
          .eq("tab_name", "InvAppList")
          .maybeSingle()
          .then(({ data, error }) => {
            if (!error && data?.tab_name) {
              const invF1 = String(formatCellForDisplay("master", "InvAppList", 0, 5, data.f1) || "StripPre").trim();
              const rawInvRows = [];
              for (let r = 3; r <= 19; r++) {
                const v = formatCellForDisplay("master", "InvAppList", r, 13, data[`r${r}`]);
                rawInvRows.push([v]);
              }
              result.invAppList = { invF1, rawInvRows };
            }
          })
          .catch(() => { })
      );

      // JnlAppList: F2 (row 1, col 5)
      tasks.push(
        sb
          .from("master_sheet_grids")
          .select("tab_name, f2:values_grid->1->5")
          .eq("client_name", dbClientName)
          .eq("sheet_role", "master")
          .eq("tab_name", "JnlAppList")
          .maybeSingle()
          .then(({ data, error }) => {
            if (!error && data?.tab_name) {
              result.jnlAppList = String(formatCellForDisplay("master", "JnlAppList", 1, 5, data.f2) || "Actual").trim() || "Actual";
            }
          })
          .catch(() => { })
      );

      // CRMList: row 2 (index 1) -> A2:M2 (0..12), AB2:AN2 (27..39), DD2 (107), DF2 (109), DH2 (111), EE2 (134)
      tasks.push(
        sb
          .from("master_sheet_grids")
          .select("tab_name, row2:values_grid->1")
          .eq("client_name", dbClientName)
          .eq("sheet_role", "master")
          .eq("tab_name", "CRMList")
          .maybeSingle()
          .then(({ data, error }) => {
            if (!error && data?.tab_name && Array.isArray(data.row2)) {
              const row2 = data.row2;
              const crmFormatRules = [];
              for (let c = 0; c <= 12; c++) {
                crmFormatRules.push(String(formatCellForDisplay("master", "CRMList", 1, c, row2[c]) || "").trim());
              }
              const crmMappedCols = [];
              for (let c = 27; c <= 39; c++) {
                crmMappedCols.push(String(formatCellForDisplay("master", "CRMList", 1, c, row2[c]) || "").trim());
              }
              result.crmListRow2 = {
                crmFormatRules,
                crmMappedCols,
                confirmedLikelihood: String(formatCellForDisplay("master", "CRMList", 1, 107, row2[107]) || "").trim(),
                confirmedStatus: String(formatCellForDisplay("master", "CRMList", 1, 109, row2[109]) || "").trim(),
                confirmedOperator: String(formatCellForDisplay("master", "CRMList", 1, 111, row2[111]) || "Or").trim(),
                pipelineExcludedStatuses: String(formatCellForDisplay("master", "CRMList", 1, 134, row2[134]) || "").trim(),
              };
            }
          })
          .catch(() => { })
      );

      // DataFromCRM: row 1 headers only (index 0)
      tasks.push(
        sb
          .from("master_sheet_grids")
          .select("tab_name, row1:values_grid->0")
          .eq("client_name", dbClientName)
          .eq("sheet_role", "master")
          .eq("tab_name", "DataFromCRM")
          .maybeSingle()
          .then(({ data, error }) => {
            if (!error && data?.tab_name && Array.isArray(data.row1)) {
              result.dataFromCrmRow1 = data.row1.map((h) => String(h ?? "").trim()).filter(Boolean);
            }
          })
          .catch(() => { })
      );
    }
  }

  if (clientSheetId && clientSupaCtx?.clientMode === "supabase") {
    const dbClientName = clientSupaCtx.clientName || clientName;
    tasks.push(
      (async () => {
        try {
          if (clientSupaCtx.clientComputeMode === "native" || clientSupaCtx.inputsReadMode === "relational") {
            const outRec = await getOrLoadVirtualTabGrid_(clientSupaCtx, "client", "Outgoings", null, { valuesOnly: true }).catch(() => null);
            const rawA112 = outRec?.values_grid?.[111]?.[0];
            if (outRec?.values_grid?.length > 111 && rawA112 !== undefined) {
              const formatted = formatCellForDisplay("client", "Outgoings", 111, 0, rawA112);
              result.outgoingsA112 = String(formatted ?? "0%").trim() || "0%";
              return;
            }
          }

          let { data, error } = await sb
            .from("master_sheet_grids")
            .select("tab_name, a112:values_grid->111->0")
            .eq("client_name", dbClientName)
            .eq("sheet_role", "client")
            .eq("tab_name", "Outgoings")
            .maybeSingle();

          if (!error && !data) {
            const legacyRes = await sb
              .from("master_sheet_grids")
              .select("tab_name, a112:values_grid->111->0")
              .eq("client_name", dbClientName)
              .eq("sheet_role", "master")
              .eq("tab_name", "Client::Outgoings")
              .maybeSingle();
            data = legacyRes.data;
            error = legacyRes.error;
          }

          if (!error && data?.tab_name) {
            const formatted = formatCellForDisplay("client", "Outgoings", 111, 0, data.a112);
            result.outgoingsA112 = String(formatted ?? "0%").trim() || "0%";
          }
        } catch { }
      })()
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }

  return result;
}

function sanitizeCrmGoogleSheetUrl_(val) {
  const trimmed = String(val || "").trim();
  if (!trimmed || /^\d{1,4}$/.test(trimmed)) return "";
  return trimmed;
}

/**
 * Reads all client settings for a given client from Redis or Google Sheets.
 */
function mergeCrmSpreadsheetIntoSetup(existingSetup, settings, clientName, masterSheetId, syncedAt) {
  const revFocus = String(settings.customisation?.revenueFocus || existingSetup.revenueFocus || "Revenue").trim();
  const dcMode = revFocus === "Income"
    ? "Pass-through"
    : (settings.customisation?.directCostsMode === "Pass-through"
      ? "Pass-through"
      : (settings.customisation?.directCostsMode === "Contractors"
        ? "Contractors"
        : (existingSetup.directCostsMode || "Contractors")));

  const nextSetup = {
    ...existingSetup,
    clientName,
    masterSheetId,
    revenueFocus: revFocus,
    directCostsMode: dcMode,
    sheetSyncedAt: syncedAt
  };

  if (settings.accounting?.toolInUse) {
    nextSetup.accountingTool = String(settings.accounting.toolInUse).trim();
  }
  if (settings.crm?.toolInUse) {
    nextSetup.crmTool = String(settings.crm.toolInUse).trim();
  }
  if (settings.crm?.googleSheetUrl !== undefined) {
    nextSetup.googleSheetUrl = sanitizeCrmGoogleSheetUrl_(settings.crm.googleSheetUrl);
  }
  if (settings.crm?.googleSheetTab !== undefined) {
    nextSetup.googleSheetTab = String(settings.crm.googleSheetTab || "").trim();
  }
  if (settings.crm?.excel) {
    const ex = settings.crm.excel;
    nextSetup.excel = {
      ...(existingSetup.excel || {}),
      driveId: String(ex.driveId || "").trim(),
      fileId: String(ex.fileId || "").trim(),
      sheetName: String(ex.worksheetName || ex.sheetName || "").trim(),
      range: String(ex.range || "").trim(),
      columnRow: String(ex.columnRow || "").trim(),
      keyHeaders: String(ex.keyHeaders || "").trim()
    };
  }

  return { nextSetup, revFocus, dcMode };
}

export async function getClientSettings({
  clientName,
  masterSheetId,
  clientSheetId,
  bypassCache = false,
  includeCrmPreview = false
}) {
  if (!clientName || !masterSheetId) {
    throw new Error("Missing required clientName or masterSheetId parameter.");
  }

  const redisKey = getSettingsRedisKey(clientName);

  // 1. Try 2-tier cache (L1 Memory -> L2 Redis) if not bypassing and not requesting full inline CRM preview
  if (!bypassCache && !includeCrmPreview) {
    const memCached = memoryCache.get(redisKey);
    if (memCached && typeof memCached === "object") {
      return { ...sanitizeCachedSettings_(memCached), fromCache: true };
    }

    try {
      if (!redisClient?.isOpen) {
        await ensureRedisConnected(500);
      }
      if (redisClient?.isOpen) {
        const cached = await redisClient.get(redisKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          memoryCache.set(redisKey, parsed, L1_SETTINGS_TTL);
          return { ...sanitizeCachedSettings_(parsed), fromCache: true };
        }
      }
    } catch (err) {
      console.warn("⚠️ Redis read error in getClientSettings:", err.message);
    }
  }

  // 2. Fetch core config tabs in parallel with sparse Supabase reads for large tabs
  const sheets = await getSheetsClient();

  // Indices 0..23 correspond to KeyInfo and DataChgAlert ranges only (fast & lightweight)
  const coreMasterRanges = [
    "KeyInfo!A1:F21",         // [0] Main, Customisation, Date Adjust, Recharged expenses delivery % (C21:D21)
    "KeyInfo!Q1:Q10",         // [1] Q4 tool, Q8 CRM, Q9 drives
    "KeyInfo!X11:X41",        // [2] CRM connection parameters
    "KeyInfo!A120:B148",      // [3] KPI Colouring rules (120..140) & Pulse portal settings (142..148)
    "KeyInfo!AT4:AT22",       // [4] Contractors manual track
    "KeyInfo!AT24:AT40",      // [5] Other pass-through manual track
    "KeyInfo!BA2:BA180",      // [6] Accounting category mappings
    "KeyInfo!L32:N75",        // [7] CRM status mappings (Status, %, Date rule)
    "KeyInfo!B23:B37",        // [8] Product lines 1-15
    "KeyInfo!E23:F62",        // [9] Product line mappings (CRM -> PL)
    "KeyInfo!G63:G72",        // [10] Client-specific lead sources
    "KeyInfo!I32:J75",        // [11] Lead sources mappings (CRM -> Mapped)
    "KeyInfo!E1",             // [12] Template Sheet Reference URL
    "DataChgAlert!Y1:Y5",     // [13] Frequencies (Y2: Invoices, Y3: CRM, Y4: Expenses)
    "DataChgAlert!A31:J53",   // [14] Invoice settings & tolerances
    "DataChgAlert!A58:F80",   // [15] CRM discrepancy rules (Pipeline & Confirmed)
    "DataChgAlert!A100:J120", // [16] Expense settings & tolerances
    "DataChgAlert!B82",       // [17] Pipeline mode - add jobs to Conf?
    "KeyInfo!H12:I21",        // [18] Bank accounts (H: Names, I: Tool IDs, max 10, rows 12-21)
    "KeyInfo!H23:I28",        // [19] Non-cash bank accounts (H: Names, I: Tool IDs, max 6, rows 23-28)
    "KeyInfo!AW2:AW",         // [20] Chart of Accounts from accounting tool
    "KeyInfo!BE2:BE",         // [21] Full list of P&L categories
    "KeyInfo!G32:G60",        // [22] Standard lead sources
    "KeyInfo!BG2:BG"          // [23] Remaining unmapped P&L categories
  ];

  const [masterResp, masterFormulaResp, sparse] = await Promise.all([
    withRetry(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: masterSheetId,
      ranges: coreMasterRanges,
      valueRenderOption: "FORMATTED_VALUE"
    })),
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "KeyInfo!A120",
      valueRenderOption: "FORMULA"
    })).catch(() => ({ data: { values: [[""]] } })),
    readSparseTabsFromSupabase_({ clientName, masterSheetId, clientSheetId })
  ]);

  // Build fallback batchGet only for any sparse tabs not satisfied by Supabase JSONB path reads
  const fallbackMasterRanges = [];
  const fallbackIndexMap = {};
  const addFallbackMaster = (key, range) => {
    fallbackIndexMap[key] = fallbackMasterRanges.length;
    fallbackMasterRanges.push(range);
  };

  if (!sparse.invAppList) {
    addFallbackMaster("invF1", "InvAppList!F1");
    addFallbackMaster("invSample", "InvAppList!N4:N20");
  }
  if (sparse.jnlAppList === null) {
    addFallbackMaster("expStatus", "JnlAppList!F2");
  }
  if (!sparse.crmListRow2) {
    addFallbackMaster("crmFields", "CRMList!AB2:AN2");
    addFallbackMaster("crmFormats", "CRMList!A2:M2");
    addFallbackMaster("crmConfDef", "CRMList!DD2:DH2");
    addFallbackMaster("crmPipeExcl", "CRMList!EE2");
  }
  if (includeCrmPreview) {
    addFallbackMaster("crmDataAll", "DataFromCRM!A1:ZZ");
    addFallbackMaster("crmPreviewMapped", "CRMList!A4:M");
    addFallbackMaster("crmPreviewConf", "CRMList!CZ4:DL");
    addFallbackMaster("crmPreviewPipe", "CRMList!DU4:EG");
  } else if (!sparse.dataFromCrmRow1) {
    addFallbackMaster("crmHeadersOnly", "DataFromCRM!A1:ZZ1");
  }

  const needClientFallback = Boolean(clientSheetId && sparse.outgoingsA112 === null);
  const [fallbackMasterResp, fallbackClientResp] = await Promise.all([
    fallbackMasterRanges.length > 0
      ? withRetry(() => sheets.spreadsheets.values.batchGet({
        spreadsheetId: masterSheetId,
        ranges: fallbackMasterRanges,
        valueRenderOption: "FORMATTED_VALUE"
      }))
      : Promise.resolve({ data: { valueRanges: [] } }),
    needClientFallback
      ? withRetry(() => sheets.spreadsheets.values.batchGet({
        spreadsheetId: clientSheetId,
        ranges: ["Outgoings!A112"],
        valueRenderOption: "FORMATTED_VALUE"
      })).catch(() => ({ data: { valueRanges: [] } }))
      : Promise.resolve({ data: { valueRanges: [] } })
  ]);

  const mVals = masterResp.data.valueRanges || [];
  const fmVals = fallbackMasterResp.data?.valueRanges || [];
  const cVals = fallbackClientResp.data?.valueRanges || [];
  const getFb = (key) => (fallbackIndexMap[key] !== undefined ? fmVals[fallbackIndexMap[key]]?.values : undefined);

  const keyA1F20 = mVals[0]?.values || [];
  const keyQ1Q10 = mVals[1]?.values || [];
  const keyX11X41 = mVals[2]?.values || [];
  const keyA120B141 = mVals[3]?.values || [];
  const keyATContr = mVals[4]?.values || [];
  const keyATPass = mVals[5]?.values || [];
  const keyBA = mVals[6]?.values || [];
  const keyL32N75 = mVals[7]?.values || [];
  const keyB23B37 = mVals[8]?.values || [];
  const keyE23F62 = mVals[9]?.values || [];
  const keyG63G72 = mVals[10]?.values || [];
  const keyI32J75 = mVals[11]?.values || [];
  const keyE1 = mVals[12]?.values?.[0]?.[0] || "";

  const dcaY1Y5 = mVals[13]?.values || [];
  const dcaInv = mVals[14]?.values || [];
  const dcaCrmRules = mVals[15]?.values || [];
  const dcaExp = mVals[16]?.values || [];
  const dcaB82 = mVals[17]?.values?.[0]?.[0] || "";
  const keyH12I21 = mVals[18]?.values || [];
  const keyH23I28 = mVals[19]?.values || [];

  const invF1 = sparse.invAppList
    ? sparse.invAppList.invF1
    : String(getFb("invF1")?.[0]?.[0] || "StripPre").trim();
  const rawInvRows = sparse.invAppList
    ? sparse.invAppList.rawInvRows
    : (getFb("invSample") || []);
  const sampleInvoiceNumbers = Array.from(new Set(
    rawInvRows.map(r => String(r[0] || "").trim()).filter(v => v && !v.startsWith("#"))
  )).slice(0, 5);

  const expStatusMapping = sparse.jnlAppList !== null
    ? sparse.jnlAppList
    : (String(getFb("expStatus")?.[0]?.[0] || "Actual").trim() || "Actual");

  const crmMappedCols = sparse.crmListRow2
    ? sparse.crmListRow2.crmMappedCols
    : (getFb("crmFields")?.[0] || []).map(c => String(c || "").trim());
  const crmFormatRules = sparse.crmListRow2
    ? sparse.crmListRow2.crmFormatRules
    : (getFb("crmFormats")?.[0] || []).map(c => String(c || "").trim());

  const fieldMappings = CRM_PULSE_FIELDS.map((f, idx) => ({
    key: f.key,
    label: f.label,
    crmField: crmMappedCols[idx] || "",
    formatRule: crmFormatRules[idx] !== undefined && crmFormatRules[idx] !== "" ? crmFormatRules[idx] : f.defaultFormat
  }));

  const dd2dh2 = getFb("crmConfDef")?.[0] || [];
  const confirmedLikelihood = sparse.crmListRow2
    ? sparse.crmListRow2.confirmedLikelihood
    : String(dd2dh2[0] || "").trim(); // DD2
  const confirmedStatus = sparse.crmListRow2
    ? sparse.crmListRow2.confirmedStatus
    : String(dd2dh2[2] || "").trim(); // DF2
  const confirmedOperator = sparse.crmListRow2
    ? sparse.crmListRow2.confirmedOperator
    : String(dd2dh2[4] || "Or").trim(); // DH2
  const pipelineExcludedStatuses = sparse.crmListRow2
    ? sparse.crmListRow2.pipelineExcludedStatuses
    : String(getFb("crmPipeExcl")?.[0]?.[0] || "").trim(); // EE2

  let availableCrmHeaders = [];
  let rawCrmRows = [];
  let previewMappedJobs = [];
  let previewConfirmedJobs = [];
  let previewPipelineJobs = [];
  let crmPreviewLoaded = false;

  if (includeCrmPreview) {
    const rawCrmData = getFb("crmDataAll") || [];
    availableCrmHeaders = (rawCrmData[0] || []).map(h => String(h || "").trim()).filter(Boolean);
    rawCrmRows = rawCrmData.slice(1);
    previewMappedJobs = (getFb("crmPreviewMapped") || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));
    previewConfirmedJobs = (getFb("crmPreviewConf") || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));
    previewPipelineJobs = (getFb("crmPreviewPipe") || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));
    crmPreviewLoaded = true;
  } else {
    availableCrmHeaders = sparse.dataFromCrmRow1
      ? sparse.dataFromCrmRow1
      : ((getFb("crmHeadersOnly")?.[0] || []).map(h => String(h || "").trim()).filter(Boolean));
  }

  // Check if A120 is an IMPORTRANGE formula
  const formulaA120 = String(masterFormulaResp.data?.values?.[0]?.[0] || "");
  const isKpiParentFormula = formulaA120.toLowerCase().includes("importrange");

  // Client Outgoings range
  const outgoingsA112 = sparse.outgoingsA112 !== null
    ? sparse.outgoingsA112
    : (String(cVals[0]?.values?.[0]?.[0] ?? "0%").trim() || "0%");

  // Pulse portal settings from KeyInfo!B143:B148 (rows 23..28 of KeyInfo!A120:B148) with Supabase fallback
  let pulseDbFlags = null;
  const sheetPulseVals = [23, 24, 25, 26, 27, 28].map((idx) => String(keyA120B141[idx]?.[1] || "").trim());
  if (sheetPulseVals.some((v) => !v)) {
    try {
      const sb = getSupabaseAdmin();
      if (sb && clientName) {
        const { data: tkiRows } = await sb
          .from("tenant_key_info")
          .select("portal_feature_flags")
          .eq("client_name", clientName)
          .limit(1);
        pulseDbFlags = tkiRows?.[0]?.portal_feature_flags || null;
      }
    } catch (_) { }
  }

  // --------------------------------------------------------------------------
  // Parse Accounting Categories Mapping (BA2:BA180)
  // --------------------------------------------------------------------------
  const getSliceValues = (startRow, endRow) => {
    const out = [];
    for (let r = startRow; r <= endRow; r++) {
      const idx = r - 2; // BA2 is index 0
      const val = String(keyBA[idx]?.[0] || "").trim();
      if (val) out.push(val);
    }
    return out;
  };

  const accountingMappings = {
    revenue: getSliceValues(2, 17),
    cosStaffCosts: getSliceValues(19, 28),
    nonCosStaffCosts: getSliceValues(35, 43),
    corporationTax: getSliceValues(50, 52),
    depreciation: getSliceValues(54, 56),
    otherCostOfSale: getSliceValues(59, 78),
    nonOperatingIncome: getSliceValues(81, 93),
    nonOperatingExpenses: getSliceValues(101, 110),
    ignore: getSliceValues(128, 180)
  };

  const chartOfAccounts = (mVals[20]?.values || [])
    .map(r => String(r[0] || "").trim())
    .filter(Boolean);

  const plCategories = (mVals[21]?.values || [])
    .map(r => String(r[0] || "").trim())
    .filter(Boolean);

  const standardLeadSources = (mVals[22]?.values || [])
    .map(r => String(r[0] || "").trim())
    .filter(Boolean);

  const sheetRemainingCategories = (mVals[23]?.values || [])
    .map(r => String(r[0] || "").trim())
    .filter(Boolean);

  // --------------------------------------------------------------------------
  // Parse CRM Status Mappings (KeyInfo!L32:N75)
  // --------------------------------------------------------------------------
  const crmStatusMappings = [];
  (keyL32N75 || []).forEach(row => {
    const status = String(row[0] || "").trim();
    if (status) {
      crmStatusMappings.push({
        status,
        likelihood: String(row[1] || "").trim(),
        startDateRule: String(row[2] || "").trim()
      });
    }
  });

  // --------------------------------------------------------------------------
  // Parse Product Lines & Mappings (B23:B37, E23:F62)
  // --------------------------------------------------------------------------
  const productLines = (keyB23B37 || []).map(r => String(r[0] || "").trim()).filter(Boolean);
  const productLineMappings = [];
  (keyE23F62 || []).forEach(row => {
    const crmProductLine = String(row[0] || "").trim();
    const mappedTo = String(row[1] || "").trim();
    if (crmProductLine || mappedTo) {
      productLineMappings.push({ crmProductLine, mappedTo });
    }
  });

  // --------------------------------------------------------------------------
  // Parse Lead Sources & Mappings (G63:G72, I32:J75)
  // --------------------------------------------------------------------------
  const leadSources = (keyG63G72 || []).map(r => String(r[0] || "").trim()).filter(Boolean);
  const leadSourceMappings = [];
  (keyI32J75 || []).forEach(row => {
    const crmSource = String(row[0] || "").trim();
    const mappedTo = String(row[1] || "").trim();
    if (crmSource || mappedTo) {
      leadSourceMappings.push({ crmSource, mappedTo });
    }
  });

  // --------------------------------------------------------------------------
  // Parse CRM Discrepancy Rules (DataChgAlert!A58:F80)
  // --------------------------------------------------------------------------
  // dcaCrmRules row indices:
  // row 0: headers
  // row 1..8: Dashboard compare (A59:C66 for Pipeline, D59:F66 for Confirmed)
  // row 14: CRM compare headers
  // row 15..22: CRM compare (A72:C79 for Pipeline, D72:F79 for Confirmed)
  const parseRuleRows = (startIdx, count, colOffset) => {
    const list = [];
    for (let i = startIdx; i < startIdx + count; i++) {
      const row = dcaCrmRules[i] || [];
      const label = String(row[colOffset] || "").trim();
      const gasAction = String(row[colOffset + 1] || "Include").trim();
      const pmaAction = String(row[colOffset + 2] || "Include").trim();
      if (label) {
        list.push({ label, gasAction, pmaAction });
      }
    }
    return list;
  };

  const crmDiscrepancyRules = {
    dashPipe: parseRuleRows(1, 8, 0),
    dashConf: parseRuleRows(1, 8, 3),
    crmPipe: parseRuleRows(14, 8, 0),
    crmConf: parseRuleRows(14, 8, 3)
  };

  // --------------------------------------------------------------------------
  // Build Normalized Settings Payload
  // --------------------------------------------------------------------------
  const settings = {
    clientName,
    masterSheetId,
    clientSheetId: clientSheetId || "",
    lastSyncedAt: new Date().toISOString(),

    // 1. MAIN (Admin Only)
    main: {
      pulseStartDate: String(keyA1F20[1]?.[1] || "").trim(), // B2
      vatQuarters: String(keyA1F20[5]?.[1] || "").trim(),    // B6
      vatPaymentScheme: String(keyA1F20[7]?.[1] || "").trim(), // B8
      vatRate: String(keyA1F20[8]?.[1] || "").trim(),        // B9
      payeCycle: String(keyA1F20[11]?.[1] || "").trim(),     // B12
      employmentAllowanceEligible: String(keyA1F20[17]?.[1] || "").trim(), // B18
      employmentAllowanceAmount: String(keyA1F20[18]?.[1] || "").trim(),   // B19
      primaryCurrency: String(keyA1F20[16]?.[1] || "").trim() // B17
    },

    // 2. CUSTOMISATION
    customisation: {
      revenueFocus: String(keyA1F20[14]?.[1] || "Revenue").trim(), // B15
      directCostsMode: String(keyA1F20[14]?.[1] || "Revenue").trim() === "Income"
        ? "Pass-through"
        : (String(keyA1F20[7]?.[3] || "Contractors").trim() === "Pass-through" ? "Pass-through" : "Contractors"), // D8
      taxPaymentMethod: String(keyA1F20[9]?.[1] || "Standard").trim(), // B10
      currencySymbol: String(keyA1F20[3]?.[3] || "£").trim(),      // D4
      thousandsSeparator: String(keyA1F20[4]?.[3] || ",").trim(),  // D5
      invoiceMethod: String(keyA1F20[7]?.[5] || "Lines").trim(),   // F8
      profitSharePercent: String(keyA1F20[10]?.[5] || "0%").trim(), // F11
      profitShareAccrual: String(keyA1F20[11]?.[5] || "Monthly").trim(), // F12
      profitSharePayment: String(keyA1F20[12]?.[5] || "YearlyM13").trim(), // F13
      makingUpCostOfSalePercent: outgoingsA112, // Client Outgoings!A112
      kpiColouring: {
        isParentFormula: isKpiParentFormula,
        parentTemplateUrl: keyE1,
        grossProfit: {
          greenAbove: String(keyA120B141[3]?.[1] || "").trim(),   // B123
          orangeAbove: String(keyA120B141[4]?.[1] || "").trim()   // B124
        },
        overheads: {
          redAbove: String(keyA120B141[8]?.[1] || "").trim(),     // B128
          greenAbove: String(keyA120B141[9]?.[1] || "").trim()    // B129
        },
        operatingProfit: {
          greenAbove: String(keyA120B141[13]?.[1] || "").trim(),  // B133
          orangeAbove: String(keyA120B141[14]?.[1] || "").trim()  // B134
        },
        staffCostsRatio: {
          redAbove: String(keyA120B141[18]?.[1] || "").trim(),    // B138
          orangeAbove: String(keyA120B141[19]?.[1] || "").trim(), // B139
          greenAbove: String(keyA120B141[20]?.[1] || "").trim()   // B140
        }
      }
    },

    // 3. ACCOUNTING
    accounting: {
      toolInUse: String(keyQ1Q10[3]?.[0] || "None").trim(), // Q4
      invoiceNumberFormatting: invF1 || "StripPre",
      sampleInvoiceNumbers: sampleInvoiceNumbers,
      expenseStatusMapping: expStatusMapping,
      bankAccounts: (keyH12I21 || [])
        .map(r => String(r[0] || "").trim())
        .filter(n => n && !n.toLowerCase().includes("non-cash") && !n.endsWith(":")),
      bankAccountIds: (keyH12I21 || []).map(r => String(r[1] || "").trim()),
      bankAccountDetails: (keyH12I21 || [])
        .map(r => ({
          name: String(r[0] || "").trim(),
          id: String(r[1] || "").trim()
        }))
        .filter(d => d.name && !d.name.toLowerCase().includes("non-cash") && !d.name.endsWith(":")),
      nonCashBankAccounts: (keyH23I28 || [])
        .map(r => String(r[0] || "").trim())
        .filter(n => n && !n.toLowerCase().includes("non-cash bank accounts") && !n.endsWith(":")),
      nonCashBankAccountIds: (keyH23I28 || []).map(r => String(r[1] || "").trim()),
      nonCashBankAccountDetails: (keyH23I28 || [])
        .map(r => ({
          name: String(r[0] || "").trim(),
          id: String(r[1] || "").trim()
        }))
        .filter(d => d.name && !d.name.toLowerCase().includes("non-cash bank accounts") && !d.name.endsWith(":")),
      contractorsManual: (keyATContr || []).map(r => String(r[0] || "").trim()).filter(Boolean),
      passThroughManual: (keyATPass || []).map(r => String(r[0] || "").trim()).filter(Boolean),
      rechargedExpensesDeliveryPct: (() => {
        const raw = String(keyA1F20[20]?.[3] ?? "").trim();
        return raw === "0" || raw === "0%" || raw === "0.0%" ? "0%" : "100%";
      })(),
      chartOfAccounts,
      plCategories,
      sheetRemainingCategories,
      mappings: accountingMappings
    },

    // 4. CRM
    crm: (() => {
      const rawX11 = sanitizeCrmGoogleSheetUrl_(keyX11X41[0]?.[0]);
      const rawX14 = String(keyX11X41[3]?.[0] || "").trim();
      const isX14LegacyUrl =
        Boolean(rawX14) &&
        !/^\d{1,4}$/.test(rawX14) &&
        (rawX14.includes("docs.google.com") || /^[A-Za-z0-9_-]{15,120}$/.test(rawX14));
      return {
        toolInUse: String(keyQ1Q10[7]?.[0] || "None").trim(), // Q8
        crmDrives: String(keyQ1Q10[8]?.[0] || "Pipeline").trim(), // Q9
        googleSheetUrl: rawX11 || (isX14LegacyUrl ? rawX14 : ""), // X11 (safe fallback only when legacy X14 holds a Sheet URL/ID)
        googleSheetTab: String(keyX11X41[1]?.[0] || keyX11X41[4]?.[0] || "").trim(),   // X12 (fallback to legacy X15)
        googleSheetKeyHeaders: String(keyX11X41[2]?.[0] || "").trim(),                 // X13
        googleSheetHeaderRow: /^\d{1,4}$/.test(rawX14) ? rawX14 : "1",                 // X14
        clickUpListId: String(keyX11X41[5]?.[0] || "").trim(),    // X16
        clickUpViewId: String(keyX11X41[6]?.[0] || "").trim(),    // X17
        mondayBoardId: String(keyX11X41[13]?.[0] || "").trim(),   // X24
        excel: {
          azureTenantId: String(keyX11X41[22]?.[0] || "").trim(), // X33
          azureClientId: String(keyX11X41[23]?.[0] || "").trim(), // X34
          azureClientSecret: String(keyX11X41[24]?.[0] || "").trim() ? "••••••••" : "", // X35 (masked)
          driveId: String(keyX11X41[25]?.[0] || "").trim(),       // X36
          fileId: String(keyX11X41[26]?.[0] || "").trim(),        // X37
          worksheetName: String(keyX11X41[27]?.[0] || "").trim(), // X38
          range: String(keyX11X41[28]?.[0] || "").trim(),         // X39
          columnRow: String(keyX11X41[29]?.[0] || "").trim(),     // X40
          keyHeaders: String(keyX11X41[30]?.[0] || "").trim()     // X41
        },
        fieldMappings,
        availableCrmHeaders,
        rawCrmRows,
        jobDefinitions: {
          confirmedLikelihood,
          confirmedStatus,
          confirmedOperator: confirmedOperator || "Or",
          pipelineExcludedStatuses
        },
        previewMappedJobs,
        previewConfirmedJobs,
        previewPipelineJobs,
        crmPreviewLoaded
      };
    })(),

    // 5. CRM STATUS MAPPING
    crmStatusMapping: crmStatusMappings,

    // 6. JOBS (Date Adjustment, Product Lines, Lead Sources, Job Costing Style)
    jobs: {
      jobCostingStyle: String(keyA1F20[10]?.[3] || "Standard").trim() || "Standard", // D11
      standardChargeOutRate: String(keyA1F20[11]?.[3] || "2750").trim(),            // D12
      contractorDayRate: String(keyA1F20[12]?.[3] || "2000").trim(),                // D13
      dateAdjustment: {
        projectStartDate: String(keyA1F20[14]?.[5] || "").trim(), // F15
        projectEndDate: String(keyA1F20[15]?.[5] || "").trim(),   // F16
        retainerDates: String(keyA1F20[16]?.[5] || "").trim(),    // F17
        retainerDur: String(keyA1F20[17]?.[5] || "").trim(),      // F18
        moveCrmDatesIfPast: String(keyA1F20[18]?.[5] || "").trim(), // F19
        noEndDateRetainerMonths: String(keyA1F20[17]?.[3] || "18").trim() // D18
      },
      productLines: productLines,
      productLineMappings: productLineMappings,
      leadSources: leadSources,
      standardLeadSources: standardLeadSources,
      leadSourceMappings: leadSourceMappings
    },

    // 7. AUTOMATION (Admin Only)
    automation: {
      frequencies: {
        invoices: String(dcaY1Y5[1]?.[0] || "").trim(), // Y2
        crm: String(dcaY1Y5[2]?.[0] || "").trim(),      // Y3
        expenses: String(dcaY1Y5[3]?.[0] || "").trim()  // Y4
      },
      invoices: {
        monthsToCompare: String(dcaInv[1]?.[1] || "6").trim(),     // B32
        monthsForOthers: String(dcaInv[2]?.[1] || "6").trim(),     // B33
        handlingMethod: String(dcaInv[8]?.[3] || "Look for slot").trim(), // D39
        monthTolerance: String(dcaInv[8]?.[5] || "0").trim(),      // F39
        includeHalfThird: String(dcaInv[8]?.[7] || "Yes").trim(),  // H39
        defaultProjectInvoiceDetails: String(dcaInv[19]?.[1] || "50-50").trim(), // B50
        defaultRetainerInvoiceDate: String(dcaInv[20]?.[1] || "28").trim(),      // B51
        defaultDaysToPay: String(dcaInv[21]?.[1] || "30").trim(),                // B52
        updateDaysToPayNewMonth: String(dcaInv[16]?.[1] || "Yes").trim(),        // B47
        createInvoiceRowsRetainers: String(dcaInv[17]?.[1] || "Yes").trim(),     // B48
        discrepancies: {
          missingInvoice: String(dcaInv[8]?.[1] || "Include").trim(),  // B39
          clientMismatch: String(dcaInv[9]?.[1] || "Include").trim(),  // B40
          invAmtMismatch: String(dcaInv[10]?.[1] || "Include").trim(), // B41
          sentDateMismatch: String(dcaInv[11]?.[1] || "Include").trim(), // B42
          duplicateInvNo: String(dcaInv[12]?.[1] || "Ignore").trim(),  // B43
          fullyPaidMismatch: String(dcaInv[13]?.[1] || "Include").trim(), // B44
          statusMismatch: String(dcaInv[14]?.[1] || "Include").trim(), // B45
          selectDuplicateOverride: String(dcaInv[15]?.[1] || "Yes").trim() // B46
        }
      },
      expenses: {
        monthsToCompare: String(dcaExp[1]?.[1] || "6").trim(),      // B101
        monthsForOthers: String(dcaExp[2]?.[1] || "6").trim(),      // B102
        defaultDirectCostDetails: String(dcaExp[5]?.[1] || "50-50").trim(), // B105
        defaultRetainerExpenseDate: String(dcaExp[6]?.[1] || "28").trim(),   // B106
        handlingMethod: String(dcaExp[11]?.[7] || "Look for slot").trim(),   // H111
        monthTolerance: String(dcaExp[11]?.[9] || "0").trim(),      // J111
        discrepancies: {
          missingCost: String(dcaExp[11]?.[1] || "Include").trim(),     // B111
          duplicateAppId: String(dcaExp[12]?.[1] || "Ignore").trim(),   // B112
          descrMismatch: String(dcaExp[13]?.[1] || "Include").trim(),   // B113
          amountMismatch: String(dcaExp[14]?.[1] || "Include").trim(),  // B114
          vatMismatch: String(dcaExp[15]?.[1] || "Include").trim(),     // B115
          recDateMismatch: String(dcaExp[16]?.[1] || "Include").trim(), // B116
          payDateMismatch: String(dcaExp[17]?.[1] || "Include").trim(), // B117
          statusMismatch: String(dcaExp[18]?.[1] || "Include").trim()   // B118
        }
      },
      crm: {
        monthsToCompare: String(dcaInv[24]?.[1] || "6").trim(), // B55
        monthsForOthers: String(dcaInv[25]?.[1] || "6").trim(), // B56 (approx)
        pipelineAddJobsToConf: String(dcaB82 || "Yes").trim(),  // B82
        rules: crmDiscrepancyRules
      }
    },

    // 8. PULSE (KeyInfo!B143:B148 & tenant_key_info.portal_feature_flags)
    pulse: {
      showStaffCostsRatio: String(sheetPulseVals[0] || pulseDbFlags?.showStaffCostsRatio || "Yes").trim(), // B143
      showCashMenu: String(sheetPulseVals[1] || pulseDbFlags?.showCashMenu || "Yes").trim(),               // B144
      showBudget: String(sheetPulseVals[2] || pulseDbFlags?.showBudget || "Yes").trim(),                   // B145
      showCashflowChart: String(sheetPulseVals[3] || pulseDbFlags?.showCashflowChart || "Yes").trim(),     // B146
      showLast12MonthsChart: String(sheetPulseVals[4] || pulseDbFlags?.showLast12MonthsChart || "Yes").trim(), // B147
      showTrendlines: String(sheetPulseVals[5] || pulseDbFlags?.showTrendlines || "Yes").trim()            // B148
    }
  };

  // 3. Save to L1 Memory immediately & defer L2 Redis + setup reconciliation in background
  if (!includeCrmPreview) {
    memoryCache.set(redisKey, settings, L1_SETTINGS_TTL);

    runBackgroundTask_((async () => {
      try {
        if (!redisClient?.isOpen) {
          await ensureRedisConnected(500);
        }
        if (!redisClient?.isOpen) return;

        await redisClient.set(redisKey, JSON.stringify(settings), { EX: REDIS_SETTINGS_TTL });
        if (settings.customisation) {
          const cleanKey = String(clientName || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
          const setupKey = `pulse:setup:${cleanKey}`;
          let existingSetup = {};
          try {
            const rawSetup = await redisClient.get(setupKey);
            if (rawSetup) existingSetup = JSON.parse(rawSetup);
          } catch { }
          const { nextSetup, revFocus, dcMode } = mergeCrmSpreadsheetIntoSetup(
            existingSetup,
            settings,
            clientName,
            masterSheetId,
            new Date().toISOString()
          );
          const excelChanged =
            String(existingSetup.excel?.driveId || "") !== String(nextSetup.excel?.driveId || "") ||
            String(existingSetup.excel?.fileId || "") !== String(nextSetup.excel?.fileId || "");
          const gsheetChanged =
            String(existingSetup.googleSheetUrl || "") !== String(nextSetup.googleSheetUrl || "");
          if (existingSetup.revenueFocus !== revFocus || existingSetup.directCostsMode !== dcMode || excelChanged || gsheetChanged) {
            await redisClient.set(setupKey, JSON.stringify(nextSetup));
            await invalidateAllClientsRedisKeys();
            clearAllClientsMemoryCache();
            clearSsrClientsMemoryCache();
          }
        }
      } catch (err) {
        console.warn("⚠️ Failed to store client settings in Redis:", err.message);
      }
    })());
  }

  return { ...settings, fromCache: false };
}

/**
 * Lazily loads heavy CRM raw rows and preview job tables (DataFromCRM + CRMList)
 * on demand when the user navigates to the CRM or Jobs settings sections.
 */
export async function getClientCrmPreview({ clientName, masterSheetId, bypassCache = false }) {
  if (!clientName || !masterSheetId) {
    throw new Error("Missing required clientName or masterSheetId parameter.");
  }

  const crmPreviewKey = getCrmPreviewRedisKey(clientName);

  if (!bypassCache) {
    const memCached = memoryCache.get(crmPreviewKey);
    if (memCached && typeof memCached === "object") {
      return { ...memCached, fromCache: true };
    }

    try {
      if (!redisClient?.isOpen) {
        await ensureRedisConnected(500);
      }
      if (redisClient?.isOpen) {
        const cached = await redisClient.get(crmPreviewKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          memoryCache.set(crmPreviewKey, parsed, L1_SETTINGS_TTL);
          return { ...parsed, fromCache: true };
        }
      }
    } catch (err) {
      console.warn("⚠️ Redis read error in getClientCrmPreview:", err.message);
    }
  }

  const sheets = await getSheetsClient();
  const crmResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: masterSheetId,
    ranges: [
      "DataFromCRM!A1:ZZ",
      "CRMList!A4:M",
      "CRMList!CZ4:DL",
      "CRMList!DU4:EG"
    ],
    valueRenderOption: "FORMATTED_VALUE"
  }));

  const cVals = crmResp.data.valueRanges || [];
  const rawCrmData = cVals[0]?.values || [];
  const availableCrmHeaders = (rawCrmData[0] || []).map(h => String(h || "").trim()).filter(Boolean);
  const rawCrmRows = rawCrmData.slice(1);
  const previewMappedJobs = (cVals[1]?.values || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));
  const previewConfirmedJobs = (cVals[2]?.values || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));
  const previewPipelineJobs = (cVals[3]?.values || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));

  const payload = {
    availableCrmHeaders,
    rawCrmRows,
    previewMappedJobs,
    previewConfirmedJobs,
    previewPipelineJobs,
    loadedAt: new Date().toISOString()
  };

  memoryCache.set(crmPreviewKey, payload, L1_SETTINGS_TTL);

  runBackgroundTask_((async () => {
    try {
      if (!redisClient?.isOpen) {
        await ensureRedisConnected(500);
      }
      if (redisClient?.isOpen) {
        await redisClient.set(crmPreviewKey, JSON.stringify(payload), { EX: REDIS_SETTINGS_TTL });
      }
    } catch (err) {
      console.warn("⚠️ Failed to store CRM preview in Redis:", err.message);
    }
  })());

  return { ...payload, fromCache: false };
}

/**
 * Saves modified client settings to Master and Client Google Sheets,
 * and updates the Redis cache immediately.
 */
export async function saveClientSettings({
  clientName,
  masterSheetId,
  clientSheetId,
  settings,
  resetKpiToParent = false
}) {
  if (!clientName || !masterSheetId || !settings) {
    throw new Error("Missing clientName, masterSheetId, or settings payload.");
  }

  const sheets = await getSheetsClient();
  const masterUpdates = [];
  const clientUpdates = [];

  // Helper for single cell update
  const addMasterCell = (range, val) => {
    if (val !== undefined && val !== null) {
      masterUpdates.push({ range, values: [[String(sanitizeFormulaInput(String(val)))]] });
    }
  };
  const addClientCell = (range, val) => {
    if (val !== undefined && val !== null && clientSheetId) {
      clientUpdates.push({ range, values: [[String(sanitizeFormulaInput(String(val)))]] });
    }
  };

  // Helper for 1D column arrays (e.g. BA2:BA17, AT4:AT22)
  const addMasterColumnSlice = (startColLetter, startRow, endRow, items) => {
    const totalRows = endRow - startRow + 1;
    const values = [];
    for (let i = 0; i < totalRows; i++) {
      values.push([items[i] !== undefined ? String(sanitizeFormulaInput(String(items[i]))) : ""]);
    }
    masterUpdates.push({
      range: `KeyInfo!${startColLetter}${startRow}:${startColLetter}${endRow}`,
      values
    });
  };

  // 1. MAIN (KeyInfo)
  if (settings.main) {
    addMasterCell("KeyInfo!B2", settings.main.pulseStartDate);
    addMasterCell("KeyInfo!B6", settings.main.vatQuarters);
    addMasterCell("KeyInfo!B8", settings.main.vatPaymentScheme);
    addMasterCell("KeyInfo!B9", settings.main.vatRate);
    addMasterCell("KeyInfo!B12", settings.main.payeCycle);
    addMasterCell("KeyInfo!B17", settings.main.primaryCurrency);
    addMasterCell("KeyInfo!B18", settings.main.employmentAllowanceEligible);
    if (settings.main.employmentAllowanceAmount) {
      addMasterCell("KeyInfo!B19", settings.main.employmentAllowanceAmount);
    }
  }

  // 2. CUSTOMISATION (KeyInfo)
  if (settings.customisation) {
    const revFocus = String(settings.customisation.revenueFocus || "Revenue").trim();
    const dcMode = revFocus === "Income"
      ? "Pass-through"
      : (settings.customisation.directCostsMode === "Pass-through" ? "Pass-through" : "Contractors");
    addMasterCell("KeyInfo!B15", revFocus);
    addMasterCell("KeyInfo!D8", dcMode);
    addMasterCell("KeyInfo!B10", settings.customisation.taxPaymentMethod);
    addMasterCell("KeyInfo!D4", settings.customisation.currencySymbol);
    addMasterCell("KeyInfo!D5", settings.customisation.thousandsSeparator);
    addMasterCell("KeyInfo!F8", settings.customisation.invoiceMethod);
    addMasterCell("KeyInfo!F11", settings.customisation.profitSharePercent);
    addMasterCell("KeyInfo!F12", settings.customisation.profitShareAccrual);
    addMasterCell("KeyInfo!F13", settings.customisation.profitSharePayment);
    if (settings.customisation.makingUpCostOfSalePercent !== undefined && settings.customisation.makingUpCostOfSalePercent !== null) {
      let rawCosPct = String(settings.customisation.makingUpCostOfSalePercent).trim();
      if (rawCosPct !== "" && !rawCosPct.includes("%") && /^-?\d+(\.\d+)?$/.test(rawCosPct)) {
        const numVal = parseFloat(rawCosPct);
        if (numVal >= 1 || numVal === 0) {
          rawCosPct = `${rawCosPct}%`;
        }
      }
      addClientCell("Outgoings!A112", rawCosPct);
    }

    // KPI Colouring Rules
    if (resetKpiToParent) {
      // Restore the template IMPORTRANGE formula and clear downstream cells
      const clearBlankRows = Array.from({ length: 21 }, () => ["", ""]);
      clearBlankRows[0] = ['=importrange(KeyInfo!$E$1,"KeyInfo!A120:B140")', ""];
      masterUpdates.push({
        range: "KeyInfo!A120:B140",
        values: clearBlankRows
      });
    } else if (settings.customisation.kpiColouring) {
      const k = settings.customisation.kpiColouring;
      const s = (v) => String(sanitizeFormulaInput(String(v || "")));
      // Write full static 2D block to cleanly replace importrange without #REF! spill
      const kpiBlock = [
        ["KPI colouring rules", ""],
        ["", ""],
        ["Gross profit", ""],
        ["Green is above:", s(k.grossProfit?.greenAbove)],
        ["Orange is above / red is below", s(k.grossProfit?.orangeAbove)],
        ["", ""],
        ["", ""],
        ["Overheads", ""],
        ["Red is above", s(k.overheads?.redAbove)],
        ["Orange is below, green is above", s(k.overheads?.greenAbove)],
        ["", ""],
        ["", ""],
        ["Operating profit", ""],
        ["Green is above", s(k.operatingProfit?.greenAbove)],
        ["Orange is above, red is below", s(k.operatingProfit?.orangeAbove)],
        ["", ""],
        ["", ""],
        ["Staff costs to income / revenue ratio", ""],
        ["Red is above", s(k.staffCostsRatio?.redAbove)],
        ["Orange is above", s(k.staffCostsRatio?.orangeAbove)],
        ["Green is above, orange below", s(k.staffCostsRatio?.greenAbove)]
      ];
      masterUpdates.push({
        range: "KeyInfo!A120:B140",
        values: kpiBlock
      });
    }
  }

  // 3. ACCOUNTING (KeyInfo)
  if (settings.accounting) {
    if (settings.accounting.toolInUse) {
      addMasterCell("KeyInfo!Q4", settings.accounting.toolInUse);
    }
    if (Array.isArray(settings.accounting.bankAccounts)) {
      const rows = [];
      const details = Array.isArray(settings.accounting.bankAccountDetails)
        ? settings.accounting.bankAccountDetails
        : [];
      for (let i = 0; i < 10; i++) {
        const name = settings.accounting.bankAccounts[i] !== undefined ? String(settings.accounting.bankAccounts[i]).trim() : "";
        let id = "";
        if (name) {
          const match = details.find(d => d.name === name);
          id = match?.id || (Array.isArray(settings.accounting.bankAccountIds) ? settings.accounting.bankAccountIds[i] || "" : "");
        }
        rows.push([String(sanitizeFormulaInput(name)), String(sanitizeFormulaInput(String(id)))]);
      }
      masterUpdates.push({
        range: "KeyInfo!H12:I21",
        values: rows
      });
    }
    if (Array.isArray(settings.accounting.nonCashBankAccounts)) {
      const rows = [];
      const details = Array.isArray(settings.accounting.nonCashBankAccountDetails)
        ? settings.accounting.nonCashBankAccountDetails
        : [];
      for (let i = 0; i < 6; i++) {
        const name = settings.accounting.nonCashBankAccounts[i] !== undefined ? String(settings.accounting.nonCashBankAccounts[i]).trim() : "";
        let id = "";
        if (name) {
          const match = details.find(d => d.name === name);
          id = match?.id || (Array.isArray(settings.accounting.nonCashBankAccountIds) ? settings.accounting.nonCashBankAccountIds[i] || "" : "");
        }
        rows.push([String(sanitizeFormulaInput(name)), String(sanitizeFormulaInput(String(id)))]);
      }
      masterUpdates.push({
        range: "KeyInfo!H23:I28",
        values: rows
      });
    }
    if (Array.isArray(settings.accounting.contractorsManual)) {
      addMasterColumnSlice("AT", 4, 22, settings.accounting.contractorsManual);
    }
    if (Array.isArray(settings.accounting.passThroughManual)) {
      addMasterColumnSlice("AT", 24, 40, settings.accounting.passThroughManual);
    }
    if (settings.accounting.mappings) {
      const m = settings.accounting.mappings;
      if (Array.isArray(m.revenue)) addMasterColumnSlice("BA", 2, 17, m.revenue);
      if (Array.isArray(m.cosStaffCosts)) addMasterColumnSlice("BA", 19, 28, m.cosStaffCosts);
      if (Array.isArray(m.nonCosStaffCosts)) addMasterColumnSlice("BA", 35, 43, m.nonCosStaffCosts);
      if (Array.isArray(m.corporationTax)) addMasterColumnSlice("BA", 50, 52, m.corporationTax);
      if (Array.isArray(m.depreciation)) addMasterColumnSlice("BA", 54, 56, m.depreciation);
      if (Array.isArray(m.otherCostOfSale)) addMasterColumnSlice("BA", 59, 78, m.otherCostOfSale);
      if (Array.isArray(m.nonOperatingIncome)) addMasterColumnSlice("BA", 81, 93, m.nonOperatingIncome);
      if (Array.isArray(m.nonOperatingExpenses)) addMasterColumnSlice("BA", 101, 110, m.nonOperatingExpenses);
      if (Array.isArray(m.ignore)) addMasterColumnSlice("BA", 128, 180, m.ignore);
    }
    if (settings.accounting.invoiceNumberFormatting !== undefined) {
      addMasterCell("InvAppList!F1", settings.accounting.invoiceNumberFormatting);
    }
    if (settings.accounting.expenseStatusMapping !== undefined) {
      addMasterCell("JnlAppList!F2", settings.accounting.expenseStatusMapping);
    }
    if (settings.accounting.rechargedExpensesDeliveryPct !== undefined) {
      const rawPct = String(settings.accounting.rechargedExpensesDeliveryPct ?? "").trim();
      const numVal = rawPct === "0" || rawPct === "0%" || rawPct === "0.0%" ? 0 : 1;
      const c21Note =
        "Recharged expenses delivery % (100% = recharged expenses captured as CoS, 0% = captured within overhead categories)";
      masterUpdates.push({
        range: "KeyInfo!C21:D21",
        values: [[c21Note, numVal]],
      });
      if (clientSheetId) {
        clientUpdates.push({
          range: "KeyInfo!C21:D21",
          values: [[c21Note, numVal]],
        });
      }
    }
  }

  // 4. CRM (KeyInfo & CRMList)
  if (settings.crm) {
    if (settings.crm.toolInUse) addMasterCell("KeyInfo!Q8", settings.crm.toolInUse);
    if (settings.crm.crmDrives) addMasterCell("KeyInfo!Q9", settings.crm.crmDrives);

    // CRM Field Mappings (CRMList!AB2:AN2 and CRMList!A2:M2)
    if (Array.isArray(settings.crm.fieldMappings) && settings.crm.fieldMappings.length === 13) {
      const crmFieldsRow = settings.crm.fieldMappings.map(f => String(sanitizeFormulaInput(String(f.crmField || "").trim())));
      const formatRulesRow = settings.crm.fieldMappings.map(f => String(sanitizeFormulaInput(String(f.formatRule !== undefined ? f.formatRule : "").trim())));
      masterUpdates.push({
        range: "CRMList!AB2:AN2",
        values: [crmFieldsRow]
      });
      masterUpdates.push({
        range: "CRMList!A2:M2",
        values: [formatRulesRow]
      });
    }

    // Confirmed & Pipeline Definitions (CRMList!DD2, DF2, DH2, EE2)
    if (settings.crm.jobDefinitions) {
      const jd = settings.crm.jobDefinitions;
      addMasterCell("CRMList!DD2", jd.confirmedLikelihood !== undefined ? jd.confirmedLikelihood : "");
      addMasterCell("CRMList!DF2", jd.confirmedStatus !== undefined ? jd.confirmedStatus : "");
      addMasterCell("CRMList!DH2", jd.confirmedOperator !== undefined ? jd.confirmedOperator : "Or");
      addMasterCell("CRMList!EE2", jd.pipelineExcludedStatuses !== undefined ? jd.pipelineExcludedStatuses : "");
    }

    // Conditional Tool fields
    const candidateSheetUrl = sanitizeCrmGoogleSheetUrl_(settings.crm.googleSheetUrl);
    if (candidateSheetUrl) {
      await assertExternalCrmSpreadsheet(sheets, candidateSheetUrl);
    }
    addMasterCell("KeyInfo!X11", candidateSheetUrl);
    addMasterCell("KeyInfo!X12", settings.crm.googleSheetTab || "");
    addMasterCell("KeyInfo!X13", settings.crm.googleSheetKeyHeaders || "");
    addMasterCell("KeyInfo!X14", settings.crm.googleSheetHeaderRow || "");
    addMasterCell("KeyInfo!X15", "");
    addMasterCell("KeyInfo!X16", settings.crm.clickUpListId || "");
    addMasterCell("KeyInfo!X17", settings.crm.clickUpViewId || "");
    addMasterCell("KeyInfo!X24", settings.crm.mondayBoardId || "");

    if (settings.crm.excel) {
      const ex = settings.crm.excel;
      if (ex.azureTenantId !== undefined) addMasterCell("KeyInfo!X33", ex.azureTenantId || "");
      if (ex.azureClientId !== undefined) addMasterCell("KeyInfo!X34", ex.azureClientId || "");
      if (ex.azureClientSecret !== undefined && ex.azureClientSecret !== "••••••••") {
        addMasterCell("KeyInfo!X35", ex.azureClientSecret || "");
      }
      addMasterCell("KeyInfo!X36", ex.driveId || "");
      addMasterCell("KeyInfo!X37", ex.fileId || "");
      addMasterCell("KeyInfo!X38", ex.worksheetName || "");
      addMasterCell("KeyInfo!X39", ex.range || "");
      addMasterCell("KeyInfo!X40", ex.columnRow || "");
      addMasterCell("KeyInfo!X41", ex.keyHeaders || "");
    }
  }

  // 5. CRM STATUS MAPPING (KeyInfo!L32:N75)
  if (Array.isArray(settings.crmStatusMapping)) {
    const rows = [];
    for (let r = 0; r < 44; r++) {
      const item = settings.crmStatusMapping[r];
      if (item && item.status) {
        rows.push([
          String(sanitizeFormulaInput(String(item.status))),
          String(sanitizeFormulaInput(String(item.likelihood || ""))),
          String(sanitizeFormulaInput(String(item.startDateRule || "")))
        ]);
      } else {
        rows.push(["", "", ""]);
      }
    }
    masterUpdates.push({
      range: "KeyInfo!L32:N75",
      values: rows
    });
  }

  // 6. JOBS (Date Adjustment, Product Lines, Lead Sources, Job Costing Style)
  if (settings.jobs) {
    if (
      settings.jobs.jobCostingStyle !== undefined ||
      settings.jobs.standardChargeOutRate !== undefined ||
      settings.jobs.contractorDayRate !== undefined
    ) {
      const jcStyle = String(settings.jobs.jobCostingStyle || "Standard").trim() === "JobCosting" ? "JobCosting" : "Standard";
      const stdRate = String(sanitizeFormulaInput(String(settings.jobs.standardChargeOutRate ?? "2750"))).trim() || "2750";
      const conRate = String(sanitizeFormulaInput(String(settings.jobs.contractorDayRate ?? "2000"))).trim() || "2000";
      masterUpdates.push({
        range: "KeyInfo!C11:D13",
        values: [
          ["Job table style", jcStyle],
          ["Standard charge out rate", stdRate],
          ["Contractor day rate", conRate],
        ],
      });

      if (jcStyle === "JobCosting") {
        // Ensure CRMComp JobCosting headers & ignore flags are provisioned on Master
        masterUpdates.push(
          { range: "CRMComp!BO5:BP5", values: [["Date job will start", "Date job will end"]] },
          { range: "CRMComp!BR5", values: [["Job revenue"]] },
          { range: "CRMComp!CP4", values: [["Ignore"]] },
          { range: "CRMComp!CU4:CV4", values: [["Ignore", "Ignore"]] },
          { range: "CRMComp!FT5:FU5", values: [["Date job will start", "Date job will end"]] },
          { range: "CRMComp!FW5", values: [["Job revenue"]] },
          { range: "CRMComp!HB5:HC5", values: [["% likel.", "Copied to confirmed tab?"]] }
        );

        // If Client Sheet has not yet been provisioned with JobCosting headers in F1:AB1, provision headers & Row 2 formulas
        if (clientSheetId) {
          try {
            const hdrCheck = await withRetry(() => sheets.spreadsheets.values.batchGet({
              spreadsheetId: clientSheetId,
              ranges: ["Confirmed!F1", "Pipeline!F1"],
              valueRenderOption: "FORMATTED_VALUE",
            }));
            const confF1 = String(hdrCheck.data?.valueRanges?.[0]?.values?.[0]?.[0] || "").trim().toLowerCase();
            const pipeF1 = String(hdrCheck.data?.valueRanges?.[1]?.values?.[0]?.[0] || "").trim().toLowerCase();
            const confHeadersFtoV = [[
              "Date job will start",
              "Date job will end",
              "Fixed / variable",
              "Job revenue",
              "",
              "Contractor costs",
              "",
              "Equiv no of days in project",
              "Equiv contr costs",
              "Cont. costs check",
              "",
              "External costs",
              "Rechgd exp",
              "",
              "% prop succ fee",
              "£ prop succ fee",
              "Prop succ. fee rec",
            ]];
            const pipeHeadersFtoI = [[
              "Date job will start",
              "Date job will end",
              "",
              "Job revenue",
            ]];
            if (confF1 !== "date job will start") {
              clientUpdates.push(
                { range: "Confirmed!F1:V1", values: confHeadersFtoV },
                { range: "Confirmed!K2", values: [["=M2*KeyInfo!$D$13"]] },
                { range: "Confirmed!M2:O2", values: [["=I2/KeyInfo!$D$12", "=M2*KeyInfo!$D$13", "=N2-K2"]] },
                { range: "Confirmed!U2", values: [["=(I2-Q2)*T2"]] },
                { range: "Confirmed!AG2:AH2", values: [['=if(I2=0,"",I2)', '=if(K2+Q2+U2=0,"",K2+Q2+U2)']] },
                { range: "Confirmed!AL2:AM2", values: [["=F2", "=G2"]] },
                { range: "Confirmed!AO2", values: [['=if(AL2>AM2,"Err","")']] }
              );
            }
            if (pipeF1 !== "date job will start") {
              clientUpdates.push(
                { range: "Pipeline!F1:I1", values: pipeHeadersFtoI },
                { range: "Pipeline!AG2:AH2", values: [["=I2", '=if(AG2="","",((AG2/KeyInfo!$D$12)*KeyInfo!$D$13)+(AG2*0.1))']] },
                { range: "Pipeline!AL2:AM2", values: [["=F2", "=G2"]] },
                { range: "Pipeline!AO2", values: [['=if(AL2>AM2,"Err","")']] }
              );
            }
          } catch (provErr) {
            console.warn("Could not check/provision JobCosting headers on Client Sheet:", provErr.message);
          }
        }
      }
    }

    if (settings.jobs.dateAdjustment) {
      const da = settings.jobs.dateAdjustment;
      addMasterCell("KeyInfo!F15", da.projectStartDate);
      addMasterCell("KeyInfo!F16", da.projectEndDate);
      addMasterCell("KeyInfo!F17", da.retainerDates);
      addMasterCell("KeyInfo!F18", da.retainerDur);
      addMasterCell("KeyInfo!F19", da.moveCrmDatesIfPast);
      if (da.noEndDateRetainerMonths !== undefined) {
        addMasterCell("KeyInfo!D18", da.noEndDateRetainerMonths);
      }
    }
    if (Array.isArray(settings.jobs.productLines)) {
      addMasterColumnSlice("B", 23, 37, settings.jobs.productLines);
    }
    if (Array.isArray(settings.jobs.productLineMappings)) {
      const rows = [];
      for (let r = 0; r < 40; r++) {
        const item = settings.jobs.productLineMappings[r];
        if (item && (item.crmProductLine || item.mappedTo)) {
          rows.push([
            String(sanitizeFormulaInput(String(item.crmProductLine || ""))),
            String(sanitizeFormulaInput(String(item.mappedTo || "")))
          ]);
        } else {
          rows.push(["", ""]);
        }
      }
      masterUpdates.push({ range: "KeyInfo!E23:F62", values: rows });
    }
    if (Array.isArray(settings.jobs.leadSources)) {
      addMasterColumnSlice("G", 63, 72, settings.jobs.leadSources);
    }
    if (Array.isArray(settings.jobs.leadSourceMappings)) {
      const rows = [];
      for (let r = 0; r < 44; r++) {
        const item = settings.jobs.leadSourceMappings[r];
        if (item && (item.crmSource || item.mappedTo)) {
          rows.push([
            String(sanitizeFormulaInput(String(item.crmSource || ""))),
            String(sanitizeFormulaInput(String(item.mappedTo || "")))
          ]);
        } else {
          rows.push(["", ""]);
        }
      }
      masterUpdates.push({ range: "KeyInfo!I32:J75", values: rows });
    }
  }

  // 7. AUTOMATION (DataChgAlert)
  if (settings.automation) {
    const a = settings.automation;
    if (a.frequencies) {
      addMasterCell("DataChgAlert!Y2", a.frequencies.invoices);
      addMasterCell("DataChgAlert!Y3", a.frequencies.crm);
      addMasterCell("DataChgAlert!Y4", a.frequencies.expenses);
    }
    if (a.invoices) {
      addMasterCell("DataChgAlert!B32", a.invoices.monthsToCompare);
      addMasterCell("DataChgAlert!B33", a.invoices.monthsForOthers);
      addMasterCell("DataChgAlert!D39", a.invoices.handlingMethod);
      addMasterCell("DataChgAlert!F39", a.invoices.monthTolerance);
      addMasterCell("DataChgAlert!H39", a.invoices.includeHalfThird);
      addMasterCell("DataChgAlert!B50", a.invoices.defaultProjectInvoiceDetails);
      addMasterCell("DataChgAlert!B51", a.invoices.defaultRetainerInvoiceDate);
      addMasterCell("DataChgAlert!B52", a.invoices.defaultDaysToPay);
      addMasterCell("DataChgAlert!B47", a.invoices.updateDaysToPayNewMonth);
      addMasterCell("DataChgAlert!B48", a.invoices.createInvoiceRowsRetainers);
      if (a.invoices.discrepancies) {
        const d = a.invoices.discrepancies;
        addMasterCell("DataChgAlert!B39", d.missingInvoice);
        addMasterCell("DataChgAlert!B40", d.clientMismatch);
        addMasterCell("DataChgAlert!B41", d.invAmtMismatch);
        addMasterCell("DataChgAlert!B42", d.sentDateMismatch);
        addMasterCell("DataChgAlert!B43", d.duplicateInvNo);
        addMasterCell("DataChgAlert!B44", d.fullyPaidMismatch);
        addMasterCell("DataChgAlert!B45", d.statusMismatch);
        addMasterCell("DataChgAlert!B46", d.selectDuplicateOverride);
      }
    }
    if (a.expenses) {
      addMasterCell("DataChgAlert!B101", a.expenses.monthsToCompare);
      addMasterCell("DataChgAlert!B102", a.expenses.monthsForOthers);
      addMasterCell("DataChgAlert!B105", a.expenses.defaultDirectCostDetails);
      addMasterCell("DataChgAlert!B106", a.expenses.defaultRetainerExpenseDate);
      addMasterCell("DataChgAlert!H111", a.expenses.handlingMethod);
      addMasterCell("DataChgAlert!J111", a.expenses.monthTolerance);
      if (a.expenses.discrepancies) {
        const d = a.expenses.discrepancies;
        addMasterCell("DataChgAlert!B111", d.missingCost);
        addMasterCell("DataChgAlert!B112", d.duplicateAppId);
        addMasterCell("DataChgAlert!B113", d.descrMismatch);
        addMasterCell("DataChgAlert!B114", d.amountMismatch);
        addMasterCell("DataChgAlert!B115", d.vatMismatch);
        addMasterCell("DataChgAlert!B116", d.recDateMismatch);
        addMasterCell("DataChgAlert!B117", d.payDateMismatch);
        addMasterCell("DataChgAlert!B118", d.statusMismatch);
      }
    }
    if (a.crm) {
      addMasterCell("DataChgAlert!B55", a.crm.monthsToCompare);
      addMasterCell("DataChgAlert!B56", a.crm.monthsForOthers);
      addMasterCell("DataChgAlert!B82", a.crm.pipelineAddJobsToConf);
      if (a.crm.rules) {
        // Save dual-action CRM rules
        const writeRules = (startRow, colOffset, ruleList) => {
          if (!Array.isArray(ruleList)) return;
          ruleList.forEach((rule, idx) => {
            const rNum = startRow + idx;
            const gasCol = colOffset === 0 ? "B" : "E";
            const pmaCol = colOffset === 0 ? "C" : "F";
            if (rule.gasAction) addMasterCell(`DataChgAlert!${gasCol}${rNum}`, rule.gasAction);
            if (rule.pmaAction) addMasterCell(`DataChgAlert!${pmaCol}${rNum}`, rule.pmaAction);
          });
        };
        writeRules(59, 0, a.crm.rules.dashPipe);
        writeRules(59, 3, a.crm.rules.dashConf);
        writeRules(72, 0, a.crm.rules.crmPipe);
        writeRules(72, 3, a.crm.rules.crmConf);
      }
    }
  }

  // 8. PULSE (KeyInfo!A142:B148 & tenant_key_info.portal_feature_flags)
  let updatedPulseFlags = null;
  if (settings.pulse) {
    const normToggle = (v) => (String(v ?? "").trim().toLowerCase() === "no" ? "No" : "Yes");
    updatedPulseFlags = {
      showStaffCostsRatio: normToggle(settings.pulse.showStaffCostsRatio),
      showCashMenu: normToggle(settings.pulse.showCashMenu),
      showBudget: normToggle(settings.pulse.showBudget),
      showCashflowChart: normToggle(settings.pulse.showCashflowChart),
      showLast12MonthsChart: normToggle(settings.pulse.showLast12MonthsChart),
      showTrendlines: normToggle(settings.pulse.showTrendlines),
    };
    masterUpdates.push({
      range: "KeyInfo!A142:B148",
      values: [
        ["Pulse portal settings", ""],
        ["Show staff costs to revenue / income ratio?", updatedPulseFlags.showStaffCostsRatio],
        ["Show cash menu?", updatedPulseFlags.showCashMenu],
        ["Show budget functionality?", updatedPulseFlags.showBudget],
        ["Show cashflow chart?", updatedPulseFlags.showCashflowChart],
        ["Show last 12 months chart?", updatedPulseFlags.showLast12MonthsChart],
        ["Show trendlines?", updatedPulseFlags.showTrendlines],
      ],
    });
  }

  // Execute Master batchUpdate
  if (masterUpdates.length > 0) {
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: masterSheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: masterUpdates
      }
    }));
  }

  // Persist portal_feature_flags to Supabase tenant_key_info
  if (updatedPulseFlags) {
    try {
      const sb = getSupabaseAdmin();
      if (sb && clientName) {
        const { data: existingTki, error: existingTkiErr } = await sb
          .from("tenant_key_info")
          .select("portal_feature_flags")
          .eq("client_name", clientName)
          .maybeSingle();
        if (existingTkiErr) {
          throw new Error(`Failed to load tenant_key_info portal_feature_flags for ${clientName}: ${existingTkiErr.message}`);
        }
        const existingFlags = existingTki?.portal_feature_flags && typeof existingTki.portal_feature_flags === "object"
          ? existingTki.portal_feature_flags
          : {};
        await sb
          .from("tenant_key_info")
          .update({
            portal_feature_flags: {
              ...existingFlags,
              ...updatedPulseFlags,
            },
          })
          .eq("client_name", clientName);
      }
    } catch (err) {
      console.warn("⚠️ Failed to persist portal_feature_flags to tenant_key_info:", err.message);
    }
  }

  // Mirror Automation frequencies (DataChgAlert!Y2:Y4) to Supabase sync_schedules
  if (settings.automation?.frequencies) {
    await mirrorAutomationFrequenciesToSyncSchedules(clientName, settings.automation.frequencies);
  }

  // Execute Client batchUpdate
  if (clientUpdates.length > 0 && clientSheetId) {
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: clientSheetId,
      _deferBackgroundRecompute: true,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: clientUpdates
      }
    }));
  }

  // Invalidate L1 & L2 caches so next GET loads fresh settings
  const savedAt = new Date().toISOString();
  const redisKey = getSettingsRedisKey(clientName);
  const crmPreviewKey = getCrmPreviewRedisKey(clientName);
  const shouldInvalidateCrmPreview = Boolean(settings.crm || settings.crmStatusMapping || settings.jobs);
  clearClientSettingsMemoryCache_(clientName, { includeCrmPreview: shouldInvalidateCrmPreview });

  const cleanClientId = clientSheetId ? unwrapSheetId(clientSheetId) : "";
  const invalidationOps = [];
  if (redisClient?.isOpen) {
    const keysToDelete = [redisKey];
    if (shouldInvalidateCrmPreview) {
      keysToDelete.push(crmPreviewKey);
    }
    if (clientSheetId) {
      keysToDelete.push(
        `pulse:portal:payload:${clientSheetId}`,
        `pulse:portal:performance:${clientSheetId}`,
        `pulse:portal:cash:${clientSheetId}`
      );
      if (cleanClientId && cleanClientId !== clientSheetId) {
        keysToDelete.push(
          `pulse:portal:payload:${cleanClientId}`,
          `pulse:portal:performance:${cleanClientId}`,
          `pulse:portal:cash:${cleanClientId}`
        );
      }
    }
    invalidationOps.push(redisClient.del(keysToDelete).catch(() => { }));
  }
  if (cleanClientId || clientSheetId) {
    clearPortalFeatureFlagsMemoryCache(cleanClientId || clientSheetId);
  }
  if (clientSheetId) {
    invalidationOps.push(del2TierCache(`pma_expenses_${cleanClientId}`).catch(() => { }));
    invalidationOps.push(
      invalidatePmaClientCache(cleanClientId || clientSheetId, masterSheetId, ["outgoings", "views", "cash", "jobs"]).catch(() => { })
    );
  }
  if (invalidationOps.length > 0) {
    await Promise.all(invalidationOps);
  }
  if (redisClient?.isOpen) {
    try {
      if (settings.customisation || settings.crm || settings.accounting) {
        const cleanKey = String(clientName || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const setupKey = `pulse:setup:${cleanKey}`;
        let existingSetup = {};
        try {
          const rawSetup = await redisClient.get(setupKey);
          if (rawSetup) existingSetup = JSON.parse(rawSetup);
        } catch { }
        const { nextSetup } = mergeCrmSpreadsheetIntoSetup(
          existingSetup,
          settings,
          clientName,
          masterSheetId,
          savedAt
        );
        await Promise.all([
          redisClient.set(setupKey, JSON.stringify(nextSetup)),
          invalidateAllClientsRedisKeys(),
        ]);
        clearAllClientsMemoryCache();
        clearSsrClientsMemoryCache();
      }
    } catch (err) {
      console.warn("⚠️ Failed to invalidate Redis settings cache after save:", err.message);
    }
  }

  return { success: true, savedAt };
}

/**
 * Tests CRM field mappings and job definitions by saving them to Google Sheets,
 * waiting briefly for sheet recalculation, and returning freshly calculated preview rows.
 */
export async function testCrmMappingsAndGetPreview({
  clientName,
  masterSheetId,
  clientSheetId,
  settings
}) {
  await saveClientSettings({
    clientName,
    masterSheetId,
    clientSheetId,
    settings
  });

  // Short pause only for live Google Sheets formula engine to recalculate array formulas in CRMList
  const supaCtx = await resolveSupabaseSheetContext({ clientName, spreadsheetId: masterSheetId }).catch(() => null);
  if (supaCtx?.masterMode !== "supabase") {
    await new Promise(resolve => setTimeout(resolve, 1400));
  }

  const sheets = await getSheetsClient();
  const previewResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: masterSheetId,
    ranges: [
      "CRMList!A4:M",
      "CRMList!CZ4:DL",
      "CRMList!DU4:EG"
    ],
    valueRenderOption: "FORMATTED_VALUE"
  }));

  const pVals = previewResp.data.valueRanges || [];
  const previewMappedJobs = (pVals[0]?.values || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));
  const previewConfirmedJobs = (pVals[1]?.values || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));
  const previewPipelineJobs = (pVals[2]?.values || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));

  return {
    success: true,
    previewMappedJobs,
    previewConfirmedJobs,
    previewPipelineJobs
  };
}

/**
 * Fetches distinct opportunity status values directly from CRMList!I4:I5004 in the Master Sheet.
 */
export async function fetchCrmStatusesFromSheet({ masterSheetId }) {
  if (!masterSheetId) return [];
  const sheets = await getSheetsClient();
  const resp = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: masterSheetId,
    range: "CRMList!I4:I5004",
    valueRenderOption: "FORMATTED_VALUE"
  }));

  const rawVals = (resp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
  const seen = new Set();
  const uniqueStatuses = [];
  rawVals.forEach(s => {
    const lower = s.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      uniqueStatuses.push(s);
    }
  });

  return uniqueStatuses;
}

function colToA1Letter(colIndex) {
  let temp, letter = '';
  while (colIndex >= 0) {
    temp = colIndex % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    colIndex = Math.floor(colIndex / 26) - 1;
  }
  return letter;
}

/**
 * Fetches distinct raw CRM product line values from DataFromCRM / CRMList in the Master Sheet.
 */
export async function fetchCrmProductLinesFromSheet({ masterSheetId }) {
  if (!masterSheetId) return [];
  const sheets = await getSheetsClient();
  const resp = await withRetry(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: masterSheetId,
    ranges: ["CRMList!AN2", "DataFromCRM!A1:ZZ1", "CRMList!AN4:AN5004"],
    valueRenderOption: "FORMATTED_VALUE"
  }));

  const prodLineHeader = String(resp.data.valueRanges?.[0]?.values?.[0]?.[0] || "").trim();
  const allHeaders = (resp.data.valueRanges?.[1]?.values?.[0] || []).map(h => String(h || "").trim());
  const fallbackM = (resp.data.valueRanges?.[2]?.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);

  let rawValues = [];
  if (prodLineHeader) {
    const colIdx = allHeaders.indexOf(prodLineHeader);
    if (colIdx >= 0) {
      const colLetter = colToA1Letter(colIdx);
      const colResp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: `DataFromCRM!${colLetter}2:${colLetter}`,
        valueRenderOption: "FORMATTED_VALUE"
      }));
      rawValues = (colResp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
    }
  }

  const seen = new Set();
  const uniqueItems = [];
  [...rawValues, ...fallbackM].forEach(item => {
    const lower = item.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      uniqueItems.push(item);
    }
  });

  return uniqueItems;
}

/**
 * Fetches distinct raw CRM lead sources from DataFromCRM / CRMList in the Master Sheet.
 */
export async function fetchCrmLeadSourcesFromSheet({ masterSheetId }) {
  if (!masterSheetId) return [];
  const sheets = await getSheetsClient();
  const resp = await withRetry(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: masterSheetId,
    ranges: ["CRMList!AL2", "DataFromCRM!A1:ZZ1", "CRMList!AL4:AL5004"],
    valueRenderOption: "FORMATTED_VALUE"
  }));

  const leadSourceHeader = String(resp.data.valueRanges?.[0]?.values?.[0]?.[0] || "").trim();
  const allHeaders = (resp.data.valueRanges?.[1]?.values?.[0] || []).map(h => String(h || "").trim());
  const fallbackK = (resp.data.valueRanges?.[2]?.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);

  let rawValues = [];
  if (leadSourceHeader) {
    const colIdx = allHeaders.indexOf(leadSourceHeader);
    if (colIdx >= 0) {
      const colLetter = colToA1Letter(colIdx);
      const colResp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: `DataFromCRM!${colLetter}2:${colLetter}`,
        valueRenderOption: "FORMATTED_VALUE"
      }));
      rawValues = (colResp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
    }
  }

  const seen = new Set();
  const uniqueItems = [];
  [...rawValues, ...fallbackK].forEach(item => {
    const lower = item.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      uniqueItems.push(item);
    }
  });

  return uniqueItems;
}

/**
 * Triggers GAS refreshAccountingToolChartOfAccounts and re-fetches KeyInfo!AW2:AW.
 */
export async function refreshChartOfAccountsService({ clientName, masterSheetId }) {
  if (!masterSheetId) throw new Error("Missing masterSheetId");
  const sheets = await getSheetsClient();

  let gasResult = null;
  let refreshError = null;
  try {
    const supaCtx = await resolveSupabaseSheetContext({ clientName, spreadsheetId: masterSheetId });
    if (supaCtx && supaCtx.masterMode === "supabase") {
      gasResult = await refreshNativeChartOfAccounts(sheets, supaCtx.clientName || clientName);
    } else {
      const webAppUrl = await getClientWebAppUrl(sheets, clientName, "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M");

      if (webAppUrl) {
        const secret = (process.env.AGENT_TRIGGER_SECRET || "").trim();
        if (secret) {
          const resp = await postGasWebAppLocked(webAppUrl, { secret, action: "refresh_chart_of_accounts", clientName });
          gasResult = await resp.json().catch(() => null);
        }
      }
    }
  } catch (err) {
    refreshError = err;
    console.warn("Could not refresh chart of accounts:", err.message);
  }

  if (gasResult && gasResult.success === false) {
    throw new Error(gasResult.error || "Failed to refresh chart of accounts.");
  }

  const coaResp = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: masterSheetId,
    range: "KeyInfo!AW2:AW",
    valueRenderOption: "FORMATTED_VALUE"
  }));

  const chartOfAccounts = (coaResp.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);

  if (refreshError && chartOfAccounts.length === 0) {
    throw refreshError;
  }

  clearClientSettingsMemoryCache_(clientName, { includeCrmPreview: false });
  if (redisClient?.isOpen && clientName) {
    try {
      await redisClient.del(getSettingsRedisKey(clientName));
    } catch (e) { }
  }

  return {
    success: true,
    message: gasResult?.message || "Successfully fetched chart of accounts.",
    chartOfAccounts
  };
}

/**
 * Triggers GAS PullPLBasedOn and re-fetches KeyInfo!BE2:BE & BG2:BG.
 */
export async function pullFreshPlCategoriesService({ clientName, masterSheetId }) {
  if (!masterSheetId) throw new Error("Missing masterSheetId");
  const sheets = await getSheetsClient();

  let gasResult = null;
  try {
    const supaCtx = await resolveSupabaseSheetContext({ clientName, spreadsheetId: masterSheetId });
    if (supaCtx && supaCtx.masterMode === "supabase") {
      gasResult = await pullLivePLToSupabaseNative(sheets, supaCtx.clientName || clientName);
    } else {
      const webAppUrl = await getClientWebAppUrl(sheets, clientName, "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M");

      if (webAppUrl) {
        const secret = (process.env.AGENT_TRIGGER_SECRET || "").trim();
        if (secret) {
          const resp = await postGasWebAppLocked(webAppUrl, { secret, action: "pull_pl", clientName });
          gasResult = await resp.json().catch(() => null);
        }
      }
    }
  } catch (err) {
    console.warn("Could not pull fresh P&L categories:", err.message);
  }

  const plResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: masterSheetId,
    ranges: ["KeyInfo!BE2:BE", "KeyInfo!BG2:BG"],
    valueRenderOption: "FORMATTED_VALUE"
  }));

  const plCategories = (plResp.data.valueRanges?.[0]?.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
  const sheetRemainingCategories = (plResp.data.valueRanges?.[1]?.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);

  clearClientSettingsMemoryCache_(clientName, { includeCrmPreview: false });
  if (redisClient?.isOpen && clientName) {
    try {
      await redisClient.del(getSettingsRedisKey(clientName));
    } catch (e) { }
  }

  return {
    success: true,
    message: gasResult?.message || "Successfully pulled fresh P&L data.",
    plCategories,
    sheetRemainingCategories
  };
}

/**
 * Pulls fresh CRM data into DataFromCRM and refreshes CRMList previews + available headers.
 */
export async function pullCrmDataService({ clientName, masterSheetId, userEmail = "Admin" }) {
  if (!masterSheetId) throw new Error("Missing masterSheetId");
  const sheets = await getSheetsClient();

  const crmToolResp = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: masterSheetId,
    range: "KeyInfo!Q8",
    valueRenderOption: "FORMATTED_VALUE"
  })).catch(() => ({ data: { values: [[""]] } }));
  const crmTool = String(crmToolResp.data?.values?.[0]?.[0] || "").trim();
  if (!crmTool || crmTool.toLowerCase() === "none") {
    throw new Error("No CRM tool is configured for this client. Connect a CRM integration first.");
  }

  let pullResult = null;
  const supaCtx = await resolveSupabaseSheetContext({ clientName, spreadsheetId: masterSheetId });
  if (supaCtx && supaCtx.masterMode === "supabase") {
    pullResult = await runNativeMasterAmdAction({
      sheets,
      clientName: supaCtx.clientName || clientName,
      amdAction: "pull_crm",
      userEmail: userEmail || "Admin",
    });
  } else {
    const webAppUrl = await getClientWebAppUrl(sheets, clientName, "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M");
    if (!webAppUrl) {
      throw new Error("Master sheet automation URL not found for this client.");
    }
    const secret = (process.env.AGENT_TRIGGER_SECRET || "").trim();
    if (!secret) {
      throw new Error("AGENT_TRIGGER_SECRET is not configured on server.");
    }
    const resp = await postGasWebAppLocked(webAppUrl, { secret, action: "pull_crm", clientName });
    pullResult = await resp.json().catch(() => null);
    if (!resp.ok || (pullResult && pullResult.success === false)) {
      throw new Error(pullResult?.error || "Failed to pull CRM data from Master sheet.");
    }
  }

  const crmResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: masterSheetId,
    ranges: [
      "DataFromCRM!A1:ZZ",
      "CRMList!A4:M",
      "CRMList!CZ4:DL",
      "CRMList!DU4:EG"
    ],
    valueRenderOption: "FORMATTED_VALUE"
  }));

  const cVals = crmResp.data.valueRanges || [];
  const rawCrmData = cVals[0]?.values || [];
  const availableCrmHeaders = (rawCrmData[0] || []).map(h => String(h || "").trim()).filter(Boolean);
  const rawCrmRows = rawCrmData.slice(1);
  const previewMappedJobs = (cVals[1]?.values || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));
  const previewConfirmedJobs = (cVals[2]?.values || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));
  const previewPipelineJobs = (cVals[3]?.values || []).filter(r => r && r.some(cell => String(cell).trim() !== ""));

  clearClientSettingsMemoryCache_(clientName, { includeCrmPreview: true });
  if (redisClient?.isOpen && clientName) {
    try {
      await redisClient.del([getSettingsRedisKey(clientName), getCrmPreviewRedisKey(clientName)]);
    } catch (e) { }
  }

  const dealsPulled = rawCrmRows.filter(r => r && r.some(cell => String(cell).trim() !== "")).length;

  return {
    success: true,
    crmTool,
    dealsPulled,
    message: pullResult?.uiAlerts?.length
      ? pullResult.uiAlerts.join(" | ")
      : `Pulled ${dealsPulled} ${dealsPulled === 1 ? "row" : "rows"} from ${crmTool}.`,
    availableCrmHeaders,
    rawCrmRows,
    previewMappedJobs,
    previewConfirmedJobs,
    previewPipelineJobs
  };
}


