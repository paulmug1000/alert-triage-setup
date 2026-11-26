/**
 * ============================================================================
 * PULSE MASTER SYNC ENGINE (services/masterSyncEngine.js)
 * ============================================================================
 * Executes the 100% verbatim compiled Google Apps Script Master bundle
 * (`services/gasRuntime/compiledMasterGas.js`) inside the Supabase-backed
 * virtual spreadsheet runtime (`services/gasRuntime/gasEnvironment.js`) and
 * 1:1 Master formula evaluator (`services/gasRuntime/masterFormulaEngine.js`).
 *
 * Zero simplifications or approximations: every sync, comparison, audit, and
 * write-back runs the exact source GAS code from `master-GAS-scripts/`.
 */

import { getSupabaseAdmin } from "./supabaseClient.js";
import { redisClient, ensureRedisConnected } from "./redisClient.js";
import {
  resolveSupabaseSheetContext,
  invalidateMasterEngineCache,
  getLastClientEditTimestamp,
  isVirtualSupabaseSheetId,
} from "./masterEngineService.js";
import { getIntegrationTokens } from "./vaultService.js";
import { logPmaActivity } from "./pmaLogger.js";
import { invalidateClientActivityCache } from "./activityService.js";
import { autoReconcileClientBankTransactions } from "./bankTransactionsService.js";
import { createGasEnvironment, formatGasDate } from "./gasRuntime/gasEnvironment.js";
import { createMasterGasInstance } from "./gasRuntime/compiledMasterGas.js";
import { toNumber } from "./gasRuntime/sheetValueUtils.js";
import { computeNativeMgmtRepForClient } from "./mgmtRepEngine.js";
import {
  evaluateScheduledCrmPreflight,
  captureCrmPreflightBaseline,
} from "./crmPreflightService.js";
import {
  evaluateScheduledAccountingPreflight,
  captureAccountingPreflightBaseline,
} from "./accountingPreflightService.js";
import {
  pullNativeAccountingInvoices,
  pullNativeAccountingDirectCosts,
  pullNativeProfitAndLoss,
  pullNativeYear0ProfitAndLoss,
  fetchNativeSingleMonthPLReport,
  updateNativeSingleMonthPL,
  refreshNativeChartOfAccountsDirect,
  runNativeRevenueComparisonDirect,
} from "./nativeAccountingPullService.js";
import { pullNativeCrmDeals } from "./nativeCrmPullService.js";
import { dateToSerial } from "./gasRuntime/sheetValueUtils.js";

function syncNativePullGridToVirtualSheet_(env, tabName, nextGrid, markDirty = false) {
  if (!env?.masterSS || !tabName || !Array.isArray(nextGrid)) return;
  let sheetObj = env.masterSS.getSheetByName(tabName);
  if (!sheetObj) sheetObj = env.masterSS.insertSheet(tabName);
  sheetObj.valuesGrid = nextGrid.map((r) => (Array.isArray(r) ? [...r] : []));
  sheetObj.formulasGrid = nextGrid.map((r) => (Array.isArray(r) ? [...r] : []));
  if (markDirty) {
    sheetObj.dirty = true;
  } else {
    sheetObj._loadedValuesJson = JSON.stringify(sheetObj.valuesGrid);
    sheetObj.dirty = false;
  }
}

function attachNativeConnectorHooksToEnv_(env, ctx, dryRun = false) {
  if (!env || !ctx || (ctx.connectorPullMode !== "native" && ctx.syncOrchestratorMode !== "native")) return;
  const persistToDb = !dryRun;
  const getKiOverride = () => env.masterSS?.getSheetByName("KeyInfo")?.valuesGrid || null;
  const getPropsObj = () => Object.fromEntries((env.scriptProperties || new Map()).entries());

  const hooks = {};
  if (ctx.connectorPullMode === "native") {
    Object.assign(hooks, {
      PullInvoicesBasedOn: async (_args, rt) => {
        try {
          const res = await pullNativeAccountingInvoices(ctx, {
            persistToDb,
            keyInfoOverride: getKiOverride(),
            existingGridOverride: env.masterSS?.getSheetByName("InvFromApp")?.valuesGrid || null,
            scriptPropsOverride: getPropsObj(),
          });
          if (!res.success) {
            rt?.setLastConnectorError?.(res.lastError || "Native invoice pull failed");
            return { newInvoices: [], updatedInvoices: [] };
          }
          if (res.nextGrid) syncNativePullGridToVirtualSheet_(env, "InvFromApp", res.nextGrid, dryRun);
          if (res.importMode) {
            env.scriptProperties?.set("INV_LAST_IMPORT_MODE", res.importMode);
          }
          if (res.dataChanged) {
            const dca = env.masterSS?.getSheetByName("DataChgAlert");
            if (dca) {
              while (dca.valuesGrid.length < 2) dca.valuesGrid.push([]);
              while (dca.valuesGrid[1].length < 3) dca.valuesGrid[1].push("");
              dca.valuesGrid[1][1] = "Yes";
              dca.valuesGrid[1][2] = dateToSerial(new Date());
            }
          }
          env.recomputeMasterFormulasSync?.();
          return { newInvoices: res.newInvoices || [], updatedInvoices: res.updatedInvoices || [] };
        } catch (err) {
          rt?.setLastConnectorError?.(err.message);
          return { newInvoices: [], updatedInvoices: [] };
        }
      },

      PullCRMBasedOn: async (_args, rt) => {
        try {
          const res = await pullNativeCrmDeals(ctx, {
            persistToDb,
            keyInfoOverride: getKiOverride(),
            existingGridOverride: env.masterSS?.getSheetByName("DataFromCRM")?.valuesGrid || null,
            scriptPropsOverride: getPropsObj(),
          });
          if (res.overrideInfo) {
            rt?.setLastCrmSyncOverrideUsed?.(res.overrideInfo);
            env.scriptProperties?.delete("CRM_SYNC_SWING_OVERRIDE_ONCE");
            env.scriptProperties?.delete("CRM_SYNC_SWING_BLOCK_JSON");
          }
          if (res.blocked && res.blockInfo) {
            rt?.setLastCrmSyncBlocked_?.(res.blockInfo);
            env.scriptProperties?.set("CRM_SYNC_SWING_BLOCK_JSON", JSON.stringify(res.blockInfo));
            return res;
          }
          if (!res.success) {
            rt?.setLastConnectorError?.(res.lastError || "Native CRM pull failed");
            return res;
          }
          if (res.nextGrid) syncNativePullGridToVirtualSheet_(env, "DataFromCRM", res.nextGrid, dryRun);
          if (res.nextBridgeGrid && res.tool === "googlesheet") {
            syncNativePullGridToVirtualSheet_(env, "CRMGoogleBridge", res.nextBridgeGrid, dryRun);
          }
          if (res.nextBridgeGrid && res.tool === "excel") {
            syncNativePullGridToVirtualSheet_(env, "CRMExcelBridge", res.nextBridgeGrid, dryRun);
          }
          if (res.nextExcelCopyGrid && res.tool === "excel") {
            syncNativePullGridToVirtualSheet_(env, "CRMExcelCopy", res.nextExcelCopyGrid, dryRun);
          }
          if (res.tool !== "close" && res.tool !== "googlesheet" && res.tool !== "excel" && res.dataChanged) {
            const dca = env.masterSS?.getSheetByName("DataChgAlert");
            if (dca) {
              while (dca.valuesGrid.length < 2) dca.valuesGrid.push([]);
              while (dca.valuesGrid[1].length < 9) dca.valuesGrid[1].push("");
              dca.valuesGrid[1][7] = "Yes";
              dca.valuesGrid[1][8] = dateToSerial(new Date());
            }
          }
          env.recomputeMasterFormulasSync?.();
          return res;
        } catch (err) {
          rt?.setLastConnectorError?.(err.message);
          return null;
        }
      },

      syncAccountingDataToSheet: async (args, rt) => {
        const isHeadless = Boolean(args?.[0]);
        try {
          const res = await pullNativeAccountingDirectCosts(ctx, {
            persistToDb,
            keyInfoOverride: getKiOverride(),
            existingGridOverride: env.masterSS?.getSheetByName("JnlsFromApp")?.valuesGrid || null,
          });
          if (!res.success) {
            rt?.setLastConnectorError?.(res.lastError || "Native direct cost pull failed");
            return { newExpenses: [], updatedExpenses: [] };
          }
          if (res.nextGrid) syncNativePullGridToVirtualSheet_(env, "JnlsFromApp", res.nextGrid, dryRun);
          env.recomputeMasterFormulasSync?.();
          if (typeof rt?.syncExpenseTransactionBreakdownToClientSheet_ === "function" && Array.isArray(res.allExpenseData)) {
            try {
              await rt.syncExpenseTransactionBreakdownToClientSheet_(isHeadless, res.allExpenseData);
            } catch (_) { }
          }
          return { newExpenses: res.newExpenses || [], updatedExpenses: res.updatedExpenses || [] };
        } catch (err) {
          rt?.setLastConnectorError?.(err.message);
          return { newExpenses: [], updatedExpenses: [] };
        }
      },

      PullPLBasedOn: async (_args, rt) => {
        try {
          const res = await pullNativeProfitAndLoss(ctx, { persistToDb, keyInfoOverride: getKiOverride() });
          if (res.nextGrid) syncNativePullGridToVirtualSheet_(env, "PLFromApp", res.nextGrid, dryRun);
          env.recomputeMasterFormulasSync?.();
          return res;
        } catch (err) {
          rt?.setLastConnectorError?.(err.message);
          throw err;
        }
      },

      PullYear0PLBasedOn: async (_args, rt) => {
        try {
          const res = await pullNativeYear0ProfitAndLoss(ctx, { persistToDb, keyInfoOverride: getKiOverride() });
          if (res.nextGrid) syncNativePullGridToVirtualSheet_(env, "Year0PLFromApp", res.nextGrid, dryRun);
          env.recomputeMasterFormulasSync?.();
          return res;
        } catch (err) {
          rt?.setLastConnectorError?.(err.message);
          throw err;
        }
      },

      refreshAccountingToolChartOfAccounts: async (_args, rt) => {
        try {
          const res = await refreshNativeChartOfAccountsDirect(ctx, { persistToDb, keyInfoOverride: getKiOverride() });
          if (res.keyInfoGrid) syncNativePullGridToVirtualSheet_(env, "KeyInfo", res.keyInfoGrid, dryRun);
          return res;
        } catch (err) {
          rt?.setLastConnectorError?.(err.message);
          throw err;
        }
      },

      fetchSingleMonthPLReport_: async (args) => {
        return await fetchNativeSingleMonthPLReport(ctx, args?.[0], args?.[1], { keyInfoOverride: getKiOverride() });
      },

      updateSingleMonthPLInSheet_: async (args) => {
        const res = await updateNativeSingleMonthPL(ctx, args?.[2], args?.[3], args?.[4], { persistToDb });
        if (res?.nextGrid) syncNativePullGridToVirtualSheet_(env, "PLFromApp", res.nextGrid, dryRun);
        env.recomputeMasterFormulasSync?.();
        return res;
      },
    });
  }

  if (ctx.syncOrchestratorMode === "native") {
    hooks.runRevenueComparison = async (args, rt) => {
      try {
        const res = await runNativeRevenueComparisonDirect(ctx, {
          sheets: env.sheets || null,
          customTargetMonth: args?.[1] || null,
          persistToDb,
          keyInfoOverride: getKiOverride(),
        });
        if (!res?.success) {
          rt?.setLastConnectorError?.(res?.error || "Native revenue comparison failed");
          return res;
        }
        if (res.revFromAppGrid) {
          syncNativePullGridToVirtualSheet_(env, "RevFromApp", res.revFromAppGrid, dryRun);
        }
        if (res.revCompGrid) {
          syncNativePullGridToVirtualSheet_(env, "RevComp", res.revCompGrid, dryRun);
        }
        env.recomputeMasterFormulasSync?.();
        return {
          success: true,
          targetMonth: res.targetMonth,
          targetMonthLabel: res.targetMonthLabel,
          dashboardTotal: res.dashboardTotal,
          accountingTotal: res.accountingTotal,
          variance: res.variance,
        };
      } catch (err) {
        rt?.setLastConnectorError?.(err.message);
        throw err;
      }
    };

    hooks.writeToAutoLog = (args) => {
      try {
        if (!env.masterSS) return;
        let logSheet = env.masterSS.getSheetByName("AutoLog");
        if (!logSheet) {
          logSheet = env.masterSS.insertSheet("AutoLog");
          logSheet.getRange("A1:D1").setValues([["Timestamp", "Category", "Summary", "Details"]]);
        }
        const tz = env.masterSS.getSpreadsheetTimeZone?.() || "Europe/London";
        const tsStr = formatGasDate(new Date(), tz, "dd-MMM-yy HH:mm");
        const cleanCat = String(args?.[0] || "GENERAL").toUpperCase();
        const cleanSummary = String(args?.[1] || "");
        let cleanDetails = args?.[2]
          ? (typeof args[2] === "object" ? JSON.stringify(args[2], null, 2) : String(args[2]))
          : "";
        if (cleanDetails.length > 45000) {
          cleanDetails = cleanDetails.slice(0, 45000) + "\n... [TRUNCATED]";
        }
        logSheet.insertRowAfter(1);
        logSheet.getRange(2, 1, 1, 4).setValues([[tsStr, cleanCat, cleanSummary, cleanDetails]]);
        if (logSheet.getLastRow() > 2500) {
          logSheet.deleteRows(2501, logSheet.getLastRow() - 2500);
        }
        if (persistToDb && Array.isArray(env.pendingAutoLogEntries)) {
          const rawTsCell = logSheet?.valuesGrid?.[1]?.[0] ?? tsStr;
          env.pendingAutoLogEntries.push([rawTsCell, cleanCat, cleanSummary, cleanDetails]);
        }
        return true;
      } catch (err) {
        globalThis.console.warn?.(`[AutoLog hook warning] ${err?.message || err}`);
        return true;
      }
    };
  }

  env.nativeConnectorHooks = hooks;
}

/**
 * Returns true if a client is currently in setup/onboarding mode and NOT yet marked live for Pulse/automations.
 */
export function isClientRecordInSetupMode(clientRow, setupStateRow) {
  if (clientRow?.metadata?.pulseLive === true) return false;
  if (clientRow?.metadata?.setupMode === true) return true;
  const setupStatus = String(setupStateRow?.setup_status || "").trim().toUpperCase();
  return setupStatus === "IN_PROGRESS";
}

/**
 * Mirrors updated automation frequencies (Invoices/CRM/Expenses) to Supabase `sync_schedules`.
 * Only updates fields explicitly defined in the payload.
 */
export async function mirrorAutomationFrequenciesToSyncSchedules(clientName, { invoices, crm, expenses } = {}) {
  if (!clientName) return;
  try {
    const sb = getSupabaseAdmin();
    if (!sb) return;
    const patch = { updated_at: new Date().toISOString() };
    if (invoices !== undefined) patch.inv_freq = String(invoices ?? "").trim();
    if (crm !== undefined) patch.crm_freq = String(crm ?? "").trim();
    if (expenses !== undefined) patch.exp_freq = String(expenses ?? "").trim();
    if (Object.keys(patch).length <= 1) return;
    await sb.from("sync_schedules").update(patch).eq("client_name", clientName);
  } catch (err) {
    console.warn("⚠️ Failed to mirror automation frequencies to Supabase sync_schedules:", err.message);
  }
}

async function resolveActiveAccountingSession_(ctx) {
  for (const tool of ["xero", "quickbooks"]) {
    const rec = await getIntegrationTokens({
      clientKey: ctx.clientName,
      masterSheetId: ctx.masterSheetId,
      tool,
    });
    if (rec && rec.tokens?.accessToken) {
      return { tool, record: rec };
    }
  }
  return null;
}

function parseCellDate_(val) {
  if (val === null || val === undefined || val === "") return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === "number") {
    if (val > 25000 && val < 90000) {
      return new Date(Math.round((val - 25569) * 86400000));
    }
    return null;
  }
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (n > 25000 && n < 90000) {
      return new Date(Math.round((n - 25569) * 86400000));
    }
  }
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split("-").map(Number);
    return new Date(y, m - 1, 1);
  }
  const mYMatch = s.match(/^([A-Za-z]{3,9})[\s-]+(\d{2,4})$/);
  if (mYMatch) {
    const mNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mIdx = mNames.indexOf(mYMatch[1].slice(0, 3).toLowerCase());
    if (mIdx !== -1) {
      let yr = parseInt(mYMatch[2], 10);
      if (yr < 100) yr += 2000;
      return new Date(yr, mIdx, 1);
    }
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function summarizeComparisonsFromMasterSS_(masterSS, clientName) {
  const invDash = masterSS.getSheetByName("InvDashList")?.valuesGrid || [];
  const dirDash = masterSS.getSheetByName("DirDashList")?.valuesGrid || [];
  const invComp = masterSS.getSheetByName("InvComp")?.valuesGrid || [];
  const dirComp = masterSS.getSheetByName("DirComp")?.valuesGrid || [];
  const crmComp = masterSS.getSheetByName("CRMComp")?.valuesGrid || [];

  const confirmedInvoicesScanned = Math.max(0, invDash.length - 2);
  const confirmedDirectCostsScanned = Math.max(0, dirDash.length - 2);

  // Match processInvoices (compiledMasterGas.js): only count left-side App-vs-Dashboard discrepancies (AD..AF / S..Y),
  // not right-side (BW..BY) which lists all future planned Dashboard invoice slots >= D2.
  let invDiscrepancyCount = 0;
  for (let r = 5; r < invComp.length; r++) {
    const row = invComp[r] || [];
    if (row[29] || row[30] || row[31]) invDiscrepancyCount++;
  }

  // Match calculateFinalExpenseDiscrepancies (compiledMasterGas.js): only count left-side "Dashboard compare" flags (AO..AV),
  // not right-side (FI..FP) future planned Dashboard direct cost slots.
  let dirDiscrepancyCount = 0;
  for (let r = 5; r < dirComp.length; r++) {
    const row = dirComp[r] || [];
    if (row.slice(40, 48).some((v) => v === 1 || v === "1")) dirDiscrepancyCount++;
  }

  // Match processCRMWorkflow (compiledMasterGas.js): count left-side "Dashboard compare" flags (cols 50..53, 55..57)
  // and right-side "CRM compare" mismatch flags (cols 161..163, 165..167).
  let crmDashDiscrepancyCount = 0;
  let crmAppDiscrepancyCount = 0;
  for (let r = 5; r < crmComp.length; r++) {
    const row = crmComp[r] || [];
    if ([50, 51, 52, 53, 55, 56, 57].some((c) => row[c] === 1 || row[c] === "1")) {
      crmDashDiscrepancyCount++;
    }
    if ([161, 162, 163, 165, 166, 167].some((c) => row[c] === 1 || row[c] === "1")) {
      crmAppDiscrepancyCount++;
    }
  }
  const crmDiscrepancyCount = crmDashDiscrepancyCount + crmAppDiscrepancyCount;

  return {
    success: true,
    clientName,
    confirmedInvoicesScanned,
    confirmedDirectCostsScanned,
    invDiscrepancyCount,
    dirDiscrepancyCount,
    crmDiscrepancyCount,
    crmDashDiscrepancyCount,
    crmAppDiscrepancyCount,
  };
}

const _lastComparisonRecomputeMap = new Map();
const _inFlightComparisonMap = new Map();

export function markMasterComparisonsFresh(clientName) {
  if (!clientName) return;
  _lastComparisonRecomputeMap.set(String(clientName).trim().toLowerCase(), Date.now());
}

/**
 * Ensures `ConfCalcs`, `PipeCalcs`, `InvComp`, `DirComp`, `CRMComp`, and `PLComp` in Supabase
 * are freshly recomputed against the live Client Sheet (`Confirmed`, `Pipeline`, `Outgoings`)
 * if the client is on `master_mode === 'supabase'` and hasn't been recomputed within `maxAgeMs`.
 */
export async function ensureFreshMasterComparisons(
  sheets,
  { clientName = "", spreadsheetId = "", maxAgeMs = 15000 } = {}
) {
  if (!sheets) return null;
  const ctx = await resolveSupabaseSheetContext({ clientName, spreadsheetId });
  if (!ctx || ctx.masterMode !== "supabase") return null;

  const key = String(ctx.clientName || "").trim().toLowerCase();
  const lastAt = _lastComparisonRecomputeMap.get(key) || 0;
  const lastClientEditAt = getLastClientEditTimestamp(key);
  if (maxAgeMs > 0 && lastAt > lastClientEditAt && Date.now() - lastAt < maxAgeMs) {
    return null;
  }

  if (_inFlightComparisonMap.has(key)) {
    return _inFlightComparisonMap.get(key);
  }

  const p = (async () => {
    try {
      const res = await recomputeClientComparisonsInSupabase(sheets, ctx.clientName);
      _lastComparisonRecomputeMap.set(key, Date.now());
      return res;
    } catch (err) {
      console.warn(`[ensureFreshMasterComparisons] Warning for ${ctx.clientName}:`, err.message);
      return null;
    } finally {
      _inFlightComparisonMap.delete(key);
    }
  })();

  _inFlightComparisonMap.set(key, p);
  return p;
}

/**
 * Recomputes all Master comparison tabs (`InvAppList`, `InvDashList`, `InvComp`,
 * `JnlAppList`, `DirDashList`, `DirComp`, `CRMList`, `CRMComp`, `KeyInfo`, `PLComp`, `DataChgAlert`)
 * in Supabase using the 1:1 `masterFormulaEngine.js` against the latest live Client Sheet data.
 */
export async function recomputeClientComparisonsInSupabase(sheets, clientName = "APPTEST") {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  if (ctx.masterComputeMode === "native") {
    const { computeAndPersistNativeMasterComparisons } = await import("./nativeMasterComparisonService.js");
    const natRes = await computeAndPersistNativeMasterComparisons(ctx, { source: "db" });
    markMasterComparisonsFresh(ctx.clientName);
    return natRes.summary;
  }

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    loadTabsMode: "comparisons_only",
  });
  await env.finalizeExecution({ recordExecution: false });
  markMasterComparisonsFresh(ctx.clientName);

  if (ctx.masterComputeMode === "shadow") {
    import("./nativeMasterComparisonService.js")
      .then(({ computeAndPersistNativeMasterComparisons }) =>
        computeAndPersistNativeMasterComparisons(ctx, { source: "db" })
      )
      .catch(() => { });
  }

  return summarizeComparisonsFromMasterSS_(env.masterSS, ctx.clientName);
}

/**
 * Recomputes `CRMList` and `CRMComp` in Supabase for the requested mode ("Pipeline" or "Confirmed")
 * using the 1:1 `masterFormulaEngine.js` against the latest live Client Sheet `ConfCalcs` / `PipeCalcs`.
 */
export async function recomputeCrmComparisonInSupabase(sheets, clientName, requestedMode = null) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) return { success: false };

  if (ctx.masterComputeMode === "native") {
    const { computeAndPersistNativeMasterComparisons } = await import("./nativeMasterComparisonService.js");
    const natRes = await computeAndPersistNativeMasterComparisons(ctx, {
      requestedCrmMode: requestedMode || null,
      source: "db",
    });
    markMasterComparisonsFresh(ctx.clientName);
    return {
      success: true,
      mode: natRes.crmMode,
      crmDealsCount: natRes.crmDealsCount,
      sheetJobsCount: natRes.sheetJobsCount,
      dashDiscrCount: natRes.summary.crmDashDiscrepancyCount,
      appDiscrCount: natRes.summary.crmAppDiscrepancyCount,
    };
  }

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    loadTabsMode: "comparisons_only",
  });

  const crmCompSheet = env.masterSS.getSheetByName("CRMComp");
  if (crmCompSheet && requestedMode) {
    crmCompSheet.getRange("B2").setValue(requestedMode);
  }
  env.recomputeMasterFormulasSync();
  await env.finalizeExecution({ recordExecution: false });
  markMasterComparisonsFresh(ctx.clientName);

  const crmCompGrid = crmCompSheet?.valuesGrid || [];
  const mode = String(crmCompGrid[1]?.[1] || requestedMode || "Pipeline").trim();
  const summary = summarizeComparisonsFromMasterSS_(env.masterSS, ctx.clientName);
  const dashDiscrCount = summary.crmDashDiscrepancyCount;
  const appDiscrCount = summary.crmAppDiscrepancyCount;
  const dfcGrid = env.masterSS.getSheetByName("DataFromCRM")?.valuesGrid || [];

  return {
    success: true,
    mode,
    crmDealsCount: Math.max(0, dfcGrid.length - 1),
    sheetJobsCount: Math.max(0, crmCompGrid.length - 6),
    dashDiscrCount,
    appDiscrCount,
  };
}

/**
 * 1A. Verbatim GAS `processPartPaidInvoices`
 */
export async function processPartPaidInvoicesNative(sheets, ctxOrName) {
  const ctx =
    typeof ctxOrName === "string"
      ? await resolveSupabaseSheetContext({ clientName: ctxOrName })
      : ctxOrName;
  if (!ctx) return { count: 0 };

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    includeReconMonthly: false,
    executionMeta: { functionName: "processPartPaidInvoices", triggerSource: "Manual (PMA)" },
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);
  const res = await gas.processPartPaidInvoices(env.masterSS, env.masterSS.getSheetByName("DataChgAlert"));
  await env.finalizeExecution({ summary: `Part-paid invoices: ${res?.count || 0} update(s)` });
  return res || { count: 0 };
}

/**
 * 1B. Verbatim GAS `PushInvDetailsToConfirmed`
 */
export async function pushMatchedInvoicesToConfirmedNative(sheets, ctxOrName) {
  const ctx =
    typeof ctxOrName === "string"
      ? await resolveSupabaseSheetContext({ clientName: ctxOrName })
      : ctxOrName;
  if (!ctx) return { updatedCount: 0 };

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    includeReconMonthly: false,
    executionMeta: { functionName: "PushInvDetailsToConfirmed", triggerSource: "Manual (PMA)" },
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);
  const res = await gas.PushInvDetailsToConfirmed(true);
  await env.finalizeExecution({ summary: `Pushed ${res?.count || res?.updatedCount || 0} invoice(s)` });
  return res || { updatedCount: 0 };
}

/**
 * 1C. Verbatim GAS `updateStaleUnsentInvoices`
 */
export async function updateStaleUnsentInvoicesNative(sheets, ctxOrName) {
  const ctx =
    typeof ctxOrName === "string"
      ? await resolveSupabaseSheetContext({ clientName: ctxOrName })
      : ctxOrName;
  if (!ctx) return { count: 0 };

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    includeReconMonthly: false,
    executionMeta: { functionName: "updateStaleUnsentInvoices", triggerSource: "Manual (PMA)" },
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);
  const res = await gas.updateStaleUnsentInvoices(env.masterSS);
  await env.finalizeExecution({ summary: `Updated ${res?.count || 0} stale invoice(s)` });
  return res || { count: 0 };
}

/**
 * 1D. Verbatim GAS `updateOverdueInvoicesInConfirmed`
 */
export async function updateOverdueInvoicesInConfirmedNative(sheets, ctxOrName) {
  const ctx =
    typeof ctxOrName === "string"
      ? await resolveSupabaseSheetContext({ clientName: ctxOrName })
      : ctxOrName;
  if (!ctx) return { count: 0 };

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    includeReconMonthly: false,
    executionMeta: { functionName: "updateOverdueInvoicesInConfirmed", triggerSource: "Manual (PMA)" },
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);
  const res = await gas.updateOverdueInvoicesInConfirmed(env.masterSS, env.masterSS.getSheetByName("DataChgAlert"));
  await env.finalizeExecution({ summary: `Updated ${res?.count || 0} overdue invoice(s)` });
  return res || { count: 0 };
}

/**
 * 2A. Verbatim GAS `PushExpDetails`
 */
export async function pushMatchedDirectCostsNative(sheets, ctxOrName) {
  const ctx =
    typeof ctxOrName === "string"
      ? await resolveSupabaseSheetContext({ clientName: ctxOrName })
      : ctxOrName;
  if (!ctx) return { updatedCount: 0 };

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    includeReconMonthly: false,
    executionMeta: { functionName: "PushExpDetails", triggerSource: "Manual (PMA)" },
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);
  const res = await gas.PushExpDetails(true);
  await env.finalizeExecution({ summary: `Pushed ${res?.count || res?.updatedCount || 0} direct cost(s)` });
  return res || { updatedCount: 0 };
}

/**
 * 2B. Verbatim GAS `refreshAccountingToolChartOfAccounts`
 */
export async function refreshNativeChartOfAccounts(sheets, clientName) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  let categories = [];
  let res = null;
  if (ctx.connectorPullMode === "native") {
    res = await refreshNativeChartOfAccountsDirect(ctx, { persistToDb: true });
    categories = res?.categories || [];
  } else {
    const env = await createGasEnvironment({
      ctx,
      sheets,
      autoReconcileFn: autoReconcileClientBankTransactions,
      includeReconMonthly: false,
      executionMeta: { functionName: "refreshAccountingToolChartOfAccounts", triggerSource: "Manual (PMA)" },
    });
    attachNativeConnectorHooksToEnv_(env, ctx, false);
    const gas = createMasterGasInstance(env);
    res = await gas.refreshAccountingToolChartOfAccounts(true);
    await env.finalizeExecution({ summary: "Refreshed Chart of Accounts" });

    // Mirror KeyInfo!AW2:AW500 to Client Sheet if sheets is available
    const kiGrid = env.masterSS.getSheetByName("KeyInfo")?.valuesGrid || [];
    for (let r = 1; r < kiGrid.length; r++) {
      const cName = String(kiGrid[r]?.[48] || "").trim();
      if (cName) categories.push(cName);
    }
  }

  if (sheets && ctx.clientSheetId && categories.length > 0) {
    try {
      const colValues = Array.from({ length: Math.max(categories.length, 200) }, (_, idx) => [
        categories[idx] || "",
      ]);
      await sheets.spreadsheets.values.update({
        spreadsheetId: ctx.clientSheetId,
        range: `KeyInfo!AW2:AW${colValues.length + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: colValues },
        _bypassSupabaseVirtualSheet: ctx.clientMode !== "supabase",
      });
    } catch (_) { }
  }

  return res || { success: true, categories };
}

/**
 * 2C. Verbatim GAS `PullPLBasedOn`
 */
export async function pullLivePLToSupabaseNative(sheets, clientName) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  let plGrid = [];
  if (ctx.connectorPullMode === "native") {
    const res = await pullNativeProfitAndLoss(ctx, { persistToDb: true });
    plGrid = res?.nextGrid || [];
  } else {
    const env = await createGasEnvironment({
      ctx,
      sheets,
      autoReconcileFn: autoReconcileClientBankTransactions,
      includeReconMonthly: false,
      executionMeta: { functionName: "PullPLBasedOn", triggerSource: "Manual (PMA)" },
    });
    attachNativeConnectorHooksToEnv_(env, ctx, false);
    const gas = createMasterGasInstance(env);
    await gas.PullPLBasedOn(true);
    await env.finalizeExecution({ summary: "Pulled Profit & Loss report" });
    plGrid = env.masterSS.getSheetByName("PLFromApp")?.valuesGrid || [];
  }

  const categories = plGrid
    .slice(1)
    .map((r) => String(r?.[0] || "").trim())
    .filter(Boolean);
  const months = (plGrid[0] || [])
    .slice(1)
    .map((m) => String(m || "").trim())
    .filter(Boolean);

  return {
    success: true,
    categories,
    months,
  };
}

/**
 * 2D. Verbatim GAS `pushOutgoingsToClientSheet` / `pushOutgoingsWithPLAddsToClientSheet`
 */
export async function pushOutgoingsToClientSheetNative(
  sheets,
  clientName,
  { includeUnreconciled = false } = {}
) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const fnName = includeUnreconciled ? "pushOutgoingsWithPLAddsToClientSheet" : "pushOutgoingsToClientSheet";
  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    executionMeta: { functionName: fnName, triggerSource: "Manual (PMA)" },
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);

  const res = includeUnreconciled
    ? await gas.pushOutgoingsWithPLAddsToClientSheet(true)
    : await gas.pushOutgoingsToClientSheet(true);

  await env.finalizeExecution({ summary: res?.message || "Pushed Outgoings to Client Sheet" });
  await invalidateClientActivityCache(ctx.clientName);
  return res || { success: true };
}

/**
 * 2E. Verbatim GAS `syncExpenseTransactionBreakdownToClientSheet_`
 */
export async function syncExpenseBreakdownToClientSheetNative(sheets, clientName) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    executionMeta: { functionName: "syncExpenseTransactionBreakdownToClientSheet_", triggerSource: "Manual (PMA)" },
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);
  const res = await gas.syncExpenseTransactionBreakdownToClientSheet_(true);
  await env.finalizeExecution({ summary: "Synced expense breakdown to Client Sheet" });
  return res || { success: true };
}

/**
 * Runs pushOutgoingsToClientSheet and syncExpenseTransactionBreakdownToClientSheet_
 * in a single shared gasEnvironment execution so Master/Recon/Client grids are loaded
 * and flushed once rather than twice.
 */
export async function pushOutgoingsAndExpenseBreakdownNative(
  sheets,
  clientName,
  { includeUnreconciled = false } = {}
) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const fnName = includeUnreconciled ? "pushOutgoingsWithPLAddsToClientSheet" : "pushOutgoingsToClientSheet";
  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    executionMeta: { functionName: `${fnName} + syncExpenseBreakdown`, triggerSource: "Manual (PMA)" },
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);

  let pushRes = null;
  try {
    pushRes = includeUnreconciled
      ? await gas.pushOutgoingsWithPLAddsToClientSheet(true)
      : await gas.pushOutgoingsToClientSheet(true);
  } catch (pushErr) {
    console.warn("⚠️ Combined pushOutgoings warning:", pushErr.message);
  }

  let breakdownRes = null;
  try {
    breakdownRes = await gas.syncExpenseTransactionBreakdownToClientSheet_(true);
  } catch (bdErr) {
    console.warn("⚠️ Combined syncExpenseBreakdown warning:", bdErr.message);
  }

  await env.finalizeExecution({
    summary: pushRes?.message || "Pushed Outgoings & synced expense breakdown to Client Sheet",
  });
  await invalidateClientActivityCache(ctx.clientName);
  return { success: true, pushRes, breakdownRes };
}

/**
 * Calculates Beyond the Blueprint's active conversation count from CRMExcelCopy
 * and updates cell Delivered!D81 in the client Google Sheet.
 * Target sections:
 *  - Proposal sent / Requested Proposal / Subject to final agreement
 *  - Active Dialogue / In Active Dialogue
 *  - Interest Expressed
 */
export async function syncBeyondTheBlueprintConversations_({ masterSS = null, ctx = null, sheets = null } = {}) {
  const targetClient = "Beyond the Blueprint";
  if (ctx && ctx.clientName !== targetClient) return;

  try {
    let grid = null;
    if (masterSS) {
      const copySheet = masterSS.getSheetByName("CRMExcelCopy");
      grid = copySheet?.valuesGrid;
    }

    const supabase = getSupabaseAdmin();

    if (!Array.isArray(grid) || grid.length === 0) {
      if (supabase && ctx?.connectorPullMode === "native") {
        const { data: cfg } = await supabase
          .from("pulse_master_sync_configs")
          .select("crm_excel_copy_grid")
          .eq("client_name", targetClient)
          .maybeSingle();
        if (Array.isArray(cfg?.crm_excel_copy_grid) && cfg.crm_excel_copy_grid.length > 0) {
          grid = cfg.crm_excel_copy_grid;
        }
      }
      if ((!Array.isArray(grid) || grid.length === 0) && supabase) {
        const { data: tab } = await supabase
          .from("master_sheet_grids")
          .select("values_grid")
          .eq("client_name", targetClient)
          .eq("tab_name", "CRMExcelCopy")
          .maybeSingle();
        grid = tab?.values_grid;
      }
    }

    if (!Array.isArray(grid) || grid.length === 0) return;

    const targetSections = [
      "proposal sent",
      "requested proposal",
      "active dialogue",
      "interest expressed",
    ];

    const allSections = [
      "delivered",
      "in delivery",
      "won",
      "proposal sent",
      "requested proposal",
      "active dialogue",
      "interest expressed",
      "lost",
      "on hold",
      "backlog",
      "current pipeline",
    ];

    let inTarget = false;
    let count = 0;

    // Header row is row 3 (idx 2)
    for (let r = 3; r < grid.length; r++) {
      const row = grid[r] || [];
      const clientVal = String(row[1] ?? "").trim(); // Col B (index 1)
      if (!clientVal) continue;

      const norm = clientVal.toLowerCase().replace(/[^a-z0-9]/g, "");

      const matchedAnySection = allSections.find((s) => norm.includes(s.replace(/[^a-z0-9]/g, "")));
      if (matchedAnySection) {
        const matchedTarget = targetSections.find((s) => norm.includes(s.replace(/[^a-z0-9]/g, "")));
        inTarget = Boolean(matchedTarget);
        continue;
      }

      if (inTarget) {
        count++;
      }
    }

    const clientSheetId = ctx?.clientSheetId;
    if (!clientSheetId) {
      return { skipped: true, reason: "missing_client_sheet_id", count };
    }
    const sheetsClient = sheets || (await (await import("./sheetsClient.js")).getSheetsClient());

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: clientSheetId,
      range: "Delivered!D81",
      valueInputOption: "RAW",
      requestBody: {
        values: [[count]],
      },
    });

    if (supabase) {
      const { data: curClient, error: curErr } = await supabase
        .from("clients")
        .select("metadata")
        .eq("client_name", targetClient)
        .maybeSingle();

      if (!curErr && curClient) {
        const prevMeta = curClient.metadata && typeof curClient.metadata === "object" ? curClient.metadata : {};
        await supabase
          .from("clients")
          .update({
            metadata: {
              ...prevMeta,
              btb_conversations_count: count,
              btb_conversations_updated_at: new Date().toISOString(),
            },
          })
          .eq("client_name", targetClient);
      }
    }

    console.log(`[BtB Hook] Updated Delivered!D81 to ${count} active conversations.`);
    return count;
  } catch (err) {
    console.warn("[BtB Hook] Note updating Beyond the Blueprint conversation count:", err.message);
  }
}

/**
 * 3A. Verbatim GAS `PullCRMBasedOn`
 */
export async function pullLiveCrmDealsToSupabaseNative(sheets, ctxOrName) {
  const ctx =
    typeof ctxOrName === "string"
      ? await resolveSupabaseSheetContext({ clientName: ctxOrName })
      : ctxOrName;
  if (!ctx) throw new Error("Client context not found.");

  if (ctx.connectorPullMode === "native") {
    const res = await pullNativeCrmDeals(ctx, { persistToDb: true });
    if (ctx.clientName === "Beyond the Blueprint") {
      await syncBeyondTheBlueprintConversations_({ ctx, sheets });
    }
    return {
      dealsPulled: res?.rowsCount ?? 0,
      crmTool: res?.toolLabel || res?.tool || "",
    };
  }

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    includeReconMonthly: false,
    executionMeta: { functionName: "PullCRMBasedOn", triggerSource: "Manual (PMA)" },
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);
  await gas.PullCRMBasedOn(true);
  await env.finalizeExecution({ summary: "Pulled CRM deals" });

  if (ctx.clientName === "Beyond the Blueprint") {
    await syncBeyondTheBlueprintConversations_({ masterSS: env.masterSS, ctx, sheets });
  }

  const dfcGrid = env.masterSS.getSheetByName("DataFromCRM")?.valuesGrid || [];
  const kiGrid = env.masterSS.getSheetByName("KeyInfo")?.valuesGrid || [];
  const crmTool = String(kiGrid[7]?.[16] || "").trim();

  return {
    dealsPulled: Math.max(0, dfcGrid.length - 1),
    crmTool,
  };
}

/**
 * 4A. Verbatim GAS `runRevenueComparison`
 */
export async function runNativeRevenueComparison(sheets, clientName, customTargetMonth = null) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  if (ctx.syncOrchestratorMode === "native") {
    const startedAtMs = Date.now();
    const res = await runNativeRevenueComparisonDirect(ctx, {
      sheets,
      customTargetMonth,
      persistToDb: true,
    });
    try {
      const { insertExecutionLogEntry } = await import("./nativeSyncOrchestratorService.js");
      await insertExecutionLogEntry(ctx, {
        executedAt: new Date().toISOString(),
        functionName: "runRevenueComparison",
        triggerSource: "Manual (PMA)",
        durationText: ((Date.now() - startedAtMs) / 1000).toFixed(2) + "s",
        status: res?.success === false ? "Completed with warnings" : "Completed",
        summary: `Revenue comparison (${res?.targetMonthLabel || customTargetMonth || "latest"})`,
        transcript: `[INFO] Native revenue comparison finished (variance=${res?.variance ?? 0})`,
      });
    } catch (_) { }
    return {
      success: Boolean(res?.success !== false),
      targetMonth: res?.targetMonth ?? customTargetMonth,
      targetMonthLabel: res?.targetMonthLabel,
      dashboardTotal: res?.dashboardTotal ?? 0,
      accountingTotal: res?.accountingTotal ?? 0,
      variance: res?.variance ?? 0,
      ...(res?.error ? { error: res.error } : {}),
    };
  }

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    executionMeta: { functionName: "runRevenueComparison", triggerSource: "Manual (PMA)" },
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);
  const res = await gas.runRevenueComparison(true, customTargetMonth);
  await env.finalizeExecution({ summary: `Revenue comparison (${res?.targetMonthLabel || customTargetMonth || "latest"})` });

  return (
    res || {
      success: true,
      targetMonth: customTargetMonth,
      dashboardTotal: 0,
      accountingTotal: 0,
      variance: 0,
    }
  );
}

/**
 * 4B. Dynamically populate the full MgmtRep virtual grid in Supabase master_sheet_grids
 * from Client Sheet + Supabase Master tables via the Native MgmtRep Engine.
 */
export async function syncVirtualMgmtRepGridNative(sheets, clientName, reportMonthKey = null, isoDateToWrite = null) {
  const result = await computeNativeMgmtRepForClient({
    sheets,
    clientName,
    reportMonthKey: isoDateToWrite || reportMonthKey,
    persistToSupabase: true,
  });
  return Boolean(result?.mgmtGrid);
}

/**
 * Inspects DataChgAlert status/rolling-log cells and recent AutoLog rows for a sequence error.
 */
function didSequenceHaveError_(seqCategory, rollingJsonCellVal, statusCellVal, autoLogGrid) {
  if (String(statusCellVal || "").trim().toLowerCase().startsWith("error")) {
    return true;
  }
  if (rollingJsonCellVal && typeof rollingJsonCellVal === "string") {
    try {
      const arr = JSON.parse(rollingJsonCellVal);
      if (Array.isArray(arr) && arr.length > 0 && arr[arr.length - 1]?.s === false) {
        return true;
      }
    } catch { }
  }
  const limit = Math.min(6, (autoLogGrid?.length || 0) - 1);
  for (let r = 1; r <= limit; r++) {
    const rowCat = String(autoLogGrid[r]?.[1] || "").trim().toUpperCase();
    if (rowCat === seqCategory) {
      return /error/i.test(String(autoLogGrid[r]?.[2] || "")) || /error:/i.test(String(autoLogGrid[r]?.[3] || ""));
    }
  }
  return false;
}

/**
 * Inserts a 4-column preflight error entry at Row 2 of Master AutoLog.
 */
function appendAutoLogPreflightError_(env, autoLogError) {
  if (!autoLogError) return;
  let logSheet = env.masterSS.getSheetByName("AutoLog");
  if (!logSheet) {
    logSheet = env.masterSS.insertSheet("AutoLog");
    logSheet.getRange("A1:D1").setValues([["Timestamp", "Category", "Summary", "Details"]]);
  }
  const tz = env.masterSS.getSpreadsheetTimeZone?.() || "Europe/London";
  const tsStr = formatGasDate(new Date(), tz, "dd-MMM-yy HH:mm");
  logSheet.insertRowAfter(1);
  logSheet.getRange(2, 1, 1, 4).setValues([[
    tsStr,
    autoLogError.category,
    autoLogError.summary,
    autoLogError.details,
  ]]);
  if (Array.isArray(env.pendingAutoLogEntries)) {
    const rawTsCell = logSheet?.valuesGrid?.[1]?.[0] ?? tsStr;
    env.pendingAutoLogEntries.push([
      rawTsCell,
      autoLogError.category,
      autoLogError.summary,
      autoLogError.details,
    ]);
  }
}

/**
 * Clears in_flight_since/in_flight_seqs while preserving any concurrent flags written by an earlier phase.
 */
async function clearInFlightFlagsSafe_(supabase, clientName, fallbackFlags) {
  let latestFlags = fallbackFlags && typeof fallbackFlags === "object" ? fallbackFlags : {};
  try {
    const { data } = await supabase
      .from("sync_schedules")
      .select("flags")
      .eq("client_name", clientName)
      .maybeSingle();
    if (data?.flags && typeof data.flags === "object") {
      latestFlags = data.flags;
    }
  } catch (_) { }
  try {
    await supabase
      .from("sync_schedules")
      .update({ flags: { ...latestFlags, in_flight_since: null, in_flight_seqs: null } })
      .eq("client_name", clientName);
  } catch (_) { }
}

/**
 * Runs the 100% verbatim GAS `runAgencyAutomator(runInv, runCrm, runExp)` sequence
 * for a client in `master_mode = 'supabase'`.
 */
export async function runNativeMasterSync({
  sheets,
  clientName = "APPTEST",
  syncType = "all",
  types = null,
  runId = null,
  onProgress = null,
  userEmail = "System",
  allowCrmSwingOverride = false,
  overrideApprovedBy = "",
}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const session = await resolveActiveAccountingSession_(ctx);

  const typeSet = new Set(
    Array.isArray(types) && types.length > 0
      ? types.map((t) => String(t).toLowerCase())
      : syncType === "all"
        ? ["invoice", "crm", "expense"]
        : [String(syncType).toLowerCase()]
  );

  const runInv = typeSet.has("invoice") || typeSet.has("all");
  const runCrm = typeSet.has("crm") || typeSet.has("all");
  const runExp = typeSet.has("expense") || typeSet.has("all");

  const runStartedIso = new Date().toISOString();
  const activeSeqs = [
    runInv ? "Invoice" : null,
    runCrm ? "CRM" : null,
    runExp ? "Expense" : null,
  ].filter(Boolean);
  const fnLabel = `runAgencyAutomator (${activeSeqs.join(", ") || syncType})`;
  const isAutomated =
    !userEmail ||
    userEmail === "System" ||
    userEmail === "system@cron" ||
    String(userEmail).startsWith("System (");
  const triggerLabel = isAutomated ? "Scheduled (cron)" : `Manual (${userEmail})`;

  const env = await createGasEnvironment({
    ctx,
    sheets,
    onProgress,
    autoReconcileFn: autoReconcileClientBankTransactions,
    includeReconMonthly: runExp,
    executionMeta: {
      functionName: fnLabel,
      triggerSource: triggerLabel,
    },
  });

  if (runId) {
    env.PropertiesService.getScriptProperties().setProperty("CURRENT_RUN_ID", String(runId));
    env.PropertiesService.getScriptProperties().setProperty("CURRENT_RUN_CLIENT", ctx.clientName);
  }
  if (runCrm && allowCrmSwingOverride) {
    env.PropertiesService.getScriptProperties().setProperty(
      "CRM_SYNC_SWING_OVERRIDE_ONCE",
      JSON.stringify({
        approvedBy: String(overrideApprovedBy || userEmail || "PMA User").slice(0, 120),
        approvedAt: new Date().toISOString(),
        expiresAt: Date.now() + 15 * 60 * 1000,
      })
    );
  }

  attachNativeConnectorHooksToEnv_(env, ctx, false);
  const gas = createMasterGasInstance(env);

  const { data: curSched, error: schedErr } = await supabase
    .from("sync_schedules")
    .select("flags")
    .eq("client_name", ctx.clientName)
    .maybeSingle();
  const hasSchedRow = !schedErr && Boolean(curSched);
  const baseFlags = curSched?.flags && typeof curSched.flags === "object" ? curSched.flags : {};

  if (hasSchedRow) {
    await supabase
      .from("sync_schedules")
      .update({
        flags: {
          ...baseFlags,
          in_flight_since: runStartedIso,
          in_flight_seqs: activeSeqs,
        },
      })
      .eq("client_name", ctx.clientName);
  }

  // Execute the verbatim GAS `runAgencyAutomator`
  let capturedInvPreflightState = null;
  let capturedCrmPreflightState = null;
  let capturedExpPreflightState = null;
  let crmSyncBlocked = null;
  try {
    await gas.runAgencyAutomator(runInv, runCrm, runExp);

    const kiGrid = (runInv || runCrm || runExp) ? (env.masterSS.getSheetByName("KeyInfo")?.valuesGrid || []) : [];
    const dcaGridPreFlush = (runInv || runCrm || runExp) ? (env.masterSS.getSheetByName("DataChgAlert")?.valuesGrid || []) : [];
    const autoLogGridPre = (runInv || runCrm || runExp) ? (env.masterSS.getSheetByName("AutoLog")?.valuesGrid || []) : [];

    for (const acctSeq of [
      { enabled: runInv, sequence: "invoice", cat: "INVOICES", dcaRow: 1, flagKey: "inv_preflight" },
      { enabled: runExp, sequence: "expense", cat: "EXPENSES", dcaRow: 3, flagKey: "exp_preflight" },
    ]) {
      if (!acctSeq.enabled) continue;
      const prevState = baseFlags?.[acctSeq.flagKey] || null;
      const hadError = didSequenceHaveError_(
        acctSeq.cat,
        dcaGridPreFlush[acctSeq.dcaRow]?.[64],
        dcaGridPreFlush[acctSeq.dcaRow]?.[28],
        autoLogGridPre
      );
      if (hadError) {
        if (prevState) {
          const clearedState = {
            ...prevState,
            fingerprint: null,
            lastOutcome: "sync_had_error",
            lastCheckedAt: new Date().toISOString(),
          };
          if (acctSeq.sequence === "invoice") capturedInvPreflightState = clearedState;
          else capturedExpPreflightState = clearedState;
        }
        continue;
      }
      try {
        const pfCapture = await captureAccountingPreflightBaseline({
          ctx,
          sequence: acctSeq.sequence,
          keyInfoGrid: kiGrid,
          dcaGrid: dcaGridPreFlush,
          runStartedIso,
          completedAtIso: new Date().toISOString(),
          prevPreflight: prevState,
        });
        if (pfCapture?.state) {
          if (acctSeq.sequence === "invoice") capturedInvPreflightState = pfCapture.state;
          else capturedExpPreflightState = pfCapture.state;
        }
        appendAutoLogPreflightError_(env, pfCapture?.autoLogError);
      } catch (pfErr) {
        console.warn(`[${acctSeq.sequence} Preflight] Baseline capture note for ${ctx.clientName}:`, pfErr.message);
      }
    }

    if (runCrm) {
      const crmSwingBlockRaw = env.PropertiesService.getScriptProperties().getProperty("CRM_SYNC_SWING_BLOCK_JSON");
      if (crmSwingBlockRaw) {
        try {
          crmSyncBlocked = JSON.parse(crmSwingBlockRaw);
        } catch (_) {
          crmSyncBlocked = null;
        }
      }
      const crmRunHadError = didSequenceHaveError_(
        "CRM",
        dcaGridPreFlush[2]?.[64],
        dcaGridPreFlush[2]?.[28],
        autoLogGridPre
      );
      if (crmSyncBlocked) {
        capturedCrmPreflightState = {
          ...(baseFlags?.crm_preflight || {}),
          fingerprint: null,
          lastOutcome: "crm_sync_blocked",
          lastCheckedAt: new Date().toISOString(),
        };
      } else if (!crmRunHadError) {
        try {
          const crmListGrid = env.masterSS.getSheetByName("CRMList")?.valuesGrid || [];
          const pfCapture = await captureCrmPreflightBaseline({
            ctx,
            keyInfoGrid: kiGrid,
            crmListGrid,
            dcaGrid: dcaGridPreFlush,
            runStartedIso,
            completedAtIso: new Date().toISOString(),
            prevPreflight: baseFlags?.crm_preflight || null,
          });
          if (pfCapture?.state) {
            capturedCrmPreflightState = pfCapture.state;
          }
          appendAutoLogPreflightError_(env, pfCapture?.autoLogError);
        } catch (pfErr) {
          console.warn(`[CRM Preflight] Baseline capture note for ${ctx.clientName}:`, pfErr.message);
        }
      } else if (baseFlags?.crm_preflight) {
        capturedCrmPreflightState = {
          ...baseFlags.crm_preflight,
          fingerprint: null,
          lastOutcome: "sync_had_error",
          lastCheckedAt: new Date().toISOString(),
        };
      }
    }

    // Extract latest AutoLog summary written by runAgencyAutomator for the execution header
    const autoLogGrid = env.masterSS.getSheetByName("AutoLog")?.valuesGrid || [];
    const latestAutoSummary = autoLogGrid[1]
      ? `${autoLogGrid[1][1] || ""}: ${autoLogGrid[1][2] || ""}`
      : `Completed ${activeSeqs.join(", ")} sequence`;

    await env.finalizeExecution({
      functionName: fnLabel,
      triggerSource: triggerLabel,
      summary: latestAutoSummary,
    });

    if (runCrm && ctx.clientName === "Beyond the Blueprint") {
      await syncBeyondTheBlueprintConversations_({ masterSS: env.masterSS, ctx, sheets });
    }
  } catch (runErr) {
    env.console.error(`Uncaught sequence failure: ${runErr.message}`);
    await env
      .finalizeExecution({
        functionName: fnLabel,
        triggerSource: triggerLabel,
        status: "Failed",
        summary: `Error: ${runErr.message}`,
      })
      .catch(() => { });
    try {
      await supabase
        .from("sync_schedules")
        .update({
          flags: {
            ...baseFlags,
            in_flight_since: null,
            in_flight_seqs: null,
          },
        })
        .eq("client_name", ctx.clientName);
    } catch (_) { }
    await invalidateClientActivityCache(ctx.clientName).catch(() => { });
    throw runErr;
  }

  markMasterComparisonsFresh(ctx.clientName);

  // Invalidate Redis activity cache so AutoLog entries appear immediately in PMA > Activity
  await invalidateClientActivityCache(ctx.clientName);

  const invGrid = env.masterSS.getSheetByName("InvFromApp")?.valuesGrid || [];
  const jnlGrid = env.masterSS.getSheetByName("JnlsFromApp")?.valuesGrid || [];
  const dfcGrid = env.masterSS.getSheetByName("DataFromCRM")?.valuesGrid || [];
  const dcaGrid = env.masterSS.getSheetByName("DataChgAlert")?.valuesGrid || [];

  const invoicesPulled = Math.max(0, invGrid.length - 1);
  const directCostsPulled = Math.max(0, jnlGrid.length - 1);
  const crmDealsPulled = Math.max(0, dfcGrid.length - 1);

  const schedulePatch = {
    flags: {
      ...baseFlags,
      in_flight_since: null,
      in_flight_seqs: null,
    },
  };
  if (runInv) {
    schedulePatch.last_inv_run = runStartedIso;
    schedulePatch.inv_status = String(dcaGrid[1]?.[28] || `Synced (${invoicesPulled} invoices)`); // AC2
    if (capturedInvPreflightState) {
      schedulePatch.flags.inv_preflight = capturedInvPreflightState;
    }
  }
  if (runCrm) {
    schedulePatch.last_crm_run = runStartedIso;
    schedulePatch.crm_status = String(dcaGrid[2]?.[28] || `Synced (${crmDealsPulled} deals)`); // AC3
    if (capturedCrmPreflightState) {
      schedulePatch.flags.crm_preflight = capturedCrmPreflightState;
    }
  }
  if (runExp) {
    schedulePatch.last_exp_run = runStartedIso;
    schedulePatch.exp_status = String(dcaGrid[3]?.[28] || `Synced (${directCostsPulled} bills)`); // AC4
    if (capturedExpPreflightState) {
      schedulePatch.flags.exp_preflight = capturedExpPreflightState;
    }
  }

  await supabase
    .from("sync_schedules")
    .update(schedulePatch)
    .eq("client_name", ctx.clientName);

  const comparisons = summarizeComparisonsFromMasterSS_(env.masterSS, ctx.clientName);

  const results = {
    clientName: ctx.clientName,
    syncType,
    accountingConnected: Boolean(session),
    accountingTool: session?.tool || "none",
    invoicesPulled,
    directCostsPulled,
    crmDealsPulled,
    crmSyncBlocked,
    comparisons,
    executionLogsCount: env.executionLogs?.length || 0,
  };

  if (!isAutomated) {
    await logPmaActivity(sheets, {
      clientName: ctx.clientName,
      category: "SYNC",
      action: `Supabase GAS runtime sync (${syncType})`,
      summary: `Completed verbatim GAS runtime ${syncType} sequence for ${ctx.clientName} (${invoicesPulled} invoices, ${directCostsPulled} direct costs, ${crmDealsPulled} CRM deals)`,
      details: results,
      user: userEmail,
    }).catch(() => { });
  }

  return results;
}

/**
 * Dispatches all due native master syncs across every tenant concurrently in isolated executions.
 * Completely decouples long-running sync execution from the 30-minute flag sweep.
 */
export async function dispatchDueNativeMasterSyncs({
  baseUrl,
  cronSecret,
  bypassToken = "",
  maxConcurrency = 4,
  userEmail = "System (Scheduled Sweep)",
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { dispatched: 0, syncs: [] };

  await ensureRedisConnected(800).catch(() => { });
  const lockKey = "pulse:lock:cron_master_dispatch";
  let lockAcquired = false;
  if (redisClient?.isOpen) {
    try {
      const lockRes = await redisClient.set(lockKey, `${Date.now()}`, { NX: true, EX: 540 });
      lockAcquired = lockRes === "OK";
      if (!lockAcquired) {
        console.log("dispatchDueNativeMasterSyncs: Another cron dispatch wave is currently active; skipping.");
        return { dispatched: 0, syncs: [], skipped: true };
      }
    } catch (_) { }
  }

  try {
    let clientsResp = await supabase
      .from("clients")
      .select("id, client_name, status, metadata, client_mode, master_mode, client_compute_mode, master_compute_mode, sync_orchestrator_mode, master_sheet_id, client_sheet_id, recon_sheet_id");
    if (clientsResp.error && /sync_orchestrator_mode|42703/i.test(String(clientsResp.error.message || ""))) {
      clientsResp = await supabase
        .from("clients")
        .select("id, client_name, status, metadata, client_mode, master_mode, client_compute_mode, master_compute_mode, master_sheet_id, client_sheet_id, recon_sheet_id");
    }
    const clientRows = clientsResp?.data || [];
    const hasNonNativeMasterCompute = clientRows.some(
      (c) => c.master_mode === "supabase" && c.master_compute_mode !== "native"
    );

    const [{ data: schedRows }, { data: dcaRows }, { data: nativeSyncCfgRows }, { data: setupStateRows }] = await Promise.all([
      supabase.from("sync_schedules").select("*"),
      hasNonNativeMasterCompute
        ? supabase
          .from("master_sheet_grids")
          .select("client_name, values_grid")
          .eq("sheet_role", "master")
          .eq("tab_name", "DataChgAlert")
        : Promise.resolve({ data: [] }),
      supabase
        .from("pulse_master_sync_configs")
        .select("client_name, data_chg_alert_grid"),
      supabase.from("client_setup_state").select("client_name, setup_status"),
    ]);
    if (!Array.isArray(schedRows) || schedRows.length === 0) return { dispatched: 0, syncs: [] };

    const setupStateByClient = new Map();
    for (const s of setupStateRows || []) {
      if (s.client_name) setupStateByClient.set(String(s.client_name).trim().toLowerCase(), s);
    }

    const supabaseClients = new Set();
    const supabaseClientRowByName = new Map();
    const sheetClientByName = new Map();
    for (const c of clientRows || []) {
      const st = String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
      if (st !== "live") continue;
      const cNameLower = String(c.client_name || "").trim().toLowerCase();
      if (isClientRecordInSetupMode(c, setupStateByClient.get(cNameLower))) continue;
      if (c.master_mode === "supabase") {
        supabaseClients.add(c.client_name);
        supabaseClientRowByName.set(c.client_name, c);
      } else if (c.master_sheet_id && !isVirtualSupabaseSheetId(c.master_sheet_id)) {
        sheetClientByName.set(c.client_name, c);
      }
    }

    const dcaMap = new Map();
    if (Array.isArray(dcaRows)) {
      for (const r of dcaRows) {
        if (r.client_name) dcaMap.set(r.client_name, r.values_grid);
      }
    }
    if (Array.isArray(nativeSyncCfgRows)) {
      for (const cfg of nativeSyncCfgRows) {
        if (
          cfg.client_name &&
          supabaseClientRowByName.get(cfg.client_name)?.master_compute_mode === "native" &&
          Array.isArray(cfg.data_chg_alert_grid) &&
          cfg.data_chg_alert_grid.length > 0
        ) {
          dcaMap.set(cfg.client_name, cfg.data_chg_alert_grid);
        }
      }
    }

    const fmtUkParts = (dt) => {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hour12: false,
      }).formatToParts(dt);
      const get = (t) => parts.find((p) => p.type === t)?.value || "";
      const hRaw = parseInt(get("hour"), 10);
      return {
        ymd: `${get("year")}${get("month")}${get("day")}`,
        day: parseInt(get("day"), 10),
        hour: hRaw === 24 ? 0 : hRaw,
      };
    };

    const nowDate = new Date();
    const shouldRunUpdate = (freqStr, lastIso) => {
      if (!freqStr) return false;
      const freq = String(freqStr).toLowerCase().trim();
      const validKeywords = ["24", "week", "month", "hr", "min"];
      if (!validKeywords.some((key) => freq.includes(key))) return false;
      if (!lastIso) return true;
      const lastRunDate = new Date(lastIso);
      if (Number.isNaN(lastRunDate.getTime())) return true;
      const isScheduled = freq.includes("24") || freq.includes("week") || freq.includes("month");
      if (isScheduled) {
        const nowUk = fmtUkParts(nowDate);
        if (nowUk.hour < 2) return false;
        const lastUk = fmtUkParts(lastRunDate);
        if (lastUk.ymd === nowUk.ymd) return false;
        if (freq.includes("month")) {
          const dayMatch = freq.match(/\d+/);
          const targetDay = dayMatch ? parseInt(dayMatch[0], 10) : 1;
          return nowUk.day === targetDay;
        }
        if (freq.includes("week")) {
          return nowDate.getTime() - lastRunDate.getTime() >= 7 * 24 * 3600 * 1000;
        }
        return true;
      }
      const diff = nowDate.getTime() - lastRunDate.getTime();
      let reqMs = 0;
      if (freq.includes("hr")) reqMs = (parseFloat(freq) || 0) * 3600 * 1000;
      else if (freq.includes("min")) reqMs = (parseFloat(freq) || 0) * 60 * 1000;
      if (reqMs <= 0) return false;
      const jitterToleranceMs = reqMs <= 60_000 ? 10_000 : 15_000;
      return diff >= Math.max(0, reqMs - jitterToleranceMs);
    };

    const dueCandidates = [];
    const sheetSignals = [];
    for (const sched of schedRows) {
      const clientName = sched.client_name;
      if (sched.automation_enabled === false) continue;

      const isSupa = supabaseClients.has(clientName);
      const sheetClient = sheetClientByName.get(clientName) || null;
      if (!isSupa && !sheetClient) continue;

      const flags = sched.flags && typeof sched.flags === "object" ? sched.flags : {};
      if (flags.in_flight_since) {
        const inFlightMs = new Date(flags.in_flight_since).getTime();
        const ageMs = Date.now() - inFlightMs;
        if (!Number.isNaN(inFlightMs) && ageMs < 310_000) {
          console.log(
            `dispatchDueNativeMasterSyncs: Skipping ${clientName} (already in-flight for ${Math.round(ageMs / 1000)}s).`
          );
          continue;
        }
        console.warn(
          `dispatchDueNativeMasterSyncs: Clearing stale in_flight_since lease for ${clientName} (${flags.in_flight_since}).`
        );
        await supabase
          .from("sync_schedules")
          .update({ flags: { ...flags, in_flight_since: null, in_flight_seqs: null } })
          .eq("client_name", clientName);
      }

      const dcaGrid = dcaMap.get(clientName) || null;
      const effectiveInvFreq = dcaGrid ? String(dcaGrid[1]?.[24] ?? "").trim() : String(sched.inv_freq ?? "").trim();
      const effectiveCrmFreq = dcaGrid ? String(dcaGrid[2]?.[24] ?? "").trim() : String(sched.crm_freq ?? "").trim();
      const effectiveExpFreq = dcaGrid ? String(dcaGrid[3]?.[24] ?? "").trim() : String(sched.exp_freq ?? "").trim();

      const dueTypes = [];
      if (shouldRunUpdate(effectiveInvFreq, sched.last_inv_run)) dueTypes.push("invoice");
      if (shouldRunUpdate(effectiveCrmFreq, sched.last_crm_run)) dueTypes.push("crm");
      if (shouldRunUpdate(effectiveExpFreq, sched.last_exp_run)) dueTypes.push("expense");

      if (dueTypes.length > 0) {
        if (isSupa) {
          dueCandidates.push({
            clientName,
            sched,
            types: dueTypes,
            flags,
          });
        } else if (sheetClient) {
          sheetSignals.push({
            clientName,
            masterSheetId: sheetClient.master_sheet_id,
            types: dueTypes,
          });
        }
      }
    }

    const preflightSkips = [];
    const candidateNames = dueCandidates.map((item) => item.clientName);

    if (candidateNames.length > 0) {
      const nonNativeMasterCandidates = candidateNames.filter(
        (n) => supabaseClientRowByName.get(n)?.master_compute_mode !== "native"
      );
      const nonNativeSyncCandidates = candidateNames.filter((n) => {
        const c = supabaseClientRowByName.get(n);
        const sMode = String(c?.sync_orchestrator_mode || c?.metadata?.sync_orchestrator_mode || "grid_gas").toLowerCase();
        return c?.client_compute_mode !== "native" || sMode !== "native";
      });
      const fetchEstatePaged_ = async (buildQ, orderCol) => {
        const out = [];
        for (let from = 0; ; from += 1000) {
          const { data: page, error: qErr } = await buildQ()
            .order(orderCol, { ascending: true })
            .range(from, from + 999);
          if (qErr || !Array.isArray(page) || page.length === 0) break;
          out.push(...page);
          if (page.length < 1000) break;
        }
        return { data: out };
      };

      const [{ data: masterMetaRows }, { data: localGridRows }, { data: nativeSyncCfgMeta }, { data: bpUpdatedRows }, { data: reconCfgRows }, { data: reconPeriodRows }] = await Promise.all([
        nonNativeMasterCandidates.length > 0
          ? fetchEstatePaged_(
              () =>
                supabase
                  .from("master_sheet_grids")
                  .select("client_name, tab_name, values_grid")
                  .eq("sheet_role", "master")
                  .in("tab_name", ["KeyInfo", "CRMList"])
                  .in("client_name", nonNativeMasterCandidates),
              "id"
            )
          : Promise.resolve({ data: [] }),
        nonNativeSyncCandidates.length > 0
          ? fetchEstatePaged_(
              () =>
                supabase
                  .from("master_sheet_grids")
                  .select("client_name, sheet_role, tab_name, updated_at")
                  .in("sheet_role", ["client", "recon"])
                  .in("client_name", nonNativeSyncCandidates),
              "id"
            )
          : Promise.resolve({ data: [] }),
        fetchEstatePaged_(
          () =>
            supabase
              .from("pulse_master_sync_configs")
              .select("client_name, master_key_info_grid, crm_list_config")
              .in("client_name", candidateNames),
          "client_id"
        ),
        fetchEstatePaged_(
          () =>
            supabase
              .from("pulse_client_tab_blueprints")
              .select("client_name, tab_name, updated_at")
              .in("tab_name", ["Pipeline", "Confirmed", "Outgoings", "OutgNotes"])
              .in("client_name", candidateNames),
          "id"
        ),
        fetchEstatePaged_(
          () =>
            supabase
              .from("pulse_recon_configs")
              .select("client_name, updated_at")
              .in("client_name", candidateNames),
          "client_id"
        ),
        fetchEstatePaged_(
          () =>
            supabase
              .from("bank_recon_periods")
              .select("client_name, updated_at")
              .in("client_name", candidateNames),
          "id"
        ),
      ]);

      const kiByClient = new Map();
      const crmListByClient = new Map();
      for (const r of masterMetaRows || []) {
        if (r.tab_name === "KeyInfo") kiByClient.set(r.client_name, r.values_grid || []);
        else if (r.tab_name === "CRMList") crmListByClient.set(r.client_name, r.values_grid || []);
      }
      for (const cfg of nativeSyncCfgMeta || []) {
        if (!cfg.client_name) continue;
        if (supabaseClientRowByName.get(cfg.client_name)?.master_compute_mode === "native") {
          if (Array.isArray(cfg.master_key_info_grid) && cfg.master_key_info_grid.length > 0) {
            kiByClient.set(cfg.client_name, cfg.master_key_info_grid);
          }
          if (Array.isArray(cfg.crm_list_config?.headerRows) && cfg.crm_list_config.headerRows.length > 0) {
            crmListByClient.set(cfg.client_name, cfg.crm_list_config.headerRows);
          }
        }
      }

      const maxClientJobsUpdatedByClient = new Map();
      const maxExpenseSheetsUpdatedByClient = new Map();
      const JOB_TABS = new Set(["Pipeline", "Confirmed"]);
      const EXPENSE_TABS = new Set(["Pipeline", "Confirmed", "Outgoings", "OutgNotes"]);
      for (const r of localGridRows || []) {
        const ms = r.updated_at ? new Date(r.updated_at).getTime() : 0;
        if (Number.isNaN(ms) || ms <= 0) continue;
        if (r.sheet_role === "client" && JOB_TABS.has(r.tab_name)) {
          if (ms > (maxClientJobsUpdatedByClient.get(r.client_name) || 0)) {
            maxClientJobsUpdatedByClient.set(r.client_name, ms);
          }
        }
        if (r.sheet_role === "recon" || (r.sheet_role === "client" && EXPENSE_TABS.has(r.tab_name))) {
          if (ms > (maxExpenseSheetsUpdatedByClient.get(r.client_name) || 0)) {
            maxExpenseSheetsUpdatedByClient.set(r.client_name, ms);
          }
        }
      }
      for (const r of bpUpdatedRows || []) {
        if (!r.client_name || supabaseClientRowByName.get(r.client_name)?.client_compute_mode !== "native") continue;
        const ms = r.updated_at ? new Date(r.updated_at).getTime() : 0;
        if (Number.isNaN(ms) || ms <= 0) continue;
        if (JOB_TABS.has(r.tab_name) && ms > (maxClientJobsUpdatedByClient.get(r.client_name) || 0)) {
          maxClientJobsUpdatedByClient.set(r.client_name, ms);
        }
        if (EXPENSE_TABS.has(r.tab_name) && ms > (maxExpenseSheetsUpdatedByClient.get(r.client_name) || 0)) {
          maxExpenseSheetsUpdatedByClient.set(r.client_name, ms);
        }
      }
      for (const r of [...(reconCfgRows || []), ...(reconPeriodRows || [])]) {
        if (!r.client_name) continue;
        const ms = r.updated_at ? new Date(r.updated_at).getTime() : 0;
        if (Number.isNaN(ms) || ms <= 0) continue;
        if (ms > (maxExpenseSheetsUpdatedByClient.get(r.client_name) || 0)) {
          maxExpenseSheetsUpdatedByClient.set(r.client_name, ms);
        }
      }

      for (let i = 0; i < dueCandidates.length; i += 4) {
        const batch = dueCandidates.slice(i, i + 4);
        await Promise.allSettled(
          batch.map(async (item) => {
            const cRow = supabaseClientRowByName.get(item.clientName);
            if (!cRow) return;
            const ctx = {
              clientName: item.clientName,
              masterSheetId: cRow.master_sheet_id || "",
              clientSheetId: cRow.client_sheet_id || "",
              reconSheetId: cRow.recon_sheet_id || "",
            };
            const keyInfoGrid = kiByClient.get(item.clientName) || [];
            const crmListGrid = crmListByClient.get(item.clientName) || [];
            const dcaGrid = dcaMap.get(item.clientName) || [];
            const nextFlags = { ...(item.flags && typeof item.flags === "object" ? item.flags : {}) };
            const schedPatch = {};
            let hasScheduleUpdate = false;

            for (const acctCfg of [
              {
                type: "invoice",
                label: "Invoice",
                flagKey: "inv_preflight",
                runCol: "last_inv_run",
                maxLocalUpdatedMs: maxClientJobsUpdatedByClient.get(item.clientName) || 0,
              },
              {
                type: "expense",
                label: "Expense",
                flagKey: "exp_preflight",
                runCol: "last_exp_run",
                maxLocalUpdatedMs: maxExpenseSheetsUpdatedByClient.get(item.clientName) || 0,
              },
            ]) {
              if (!item.types.includes(acctCfg.type)) continue;
              const pfRes = await evaluateScheduledAccountingPreflight({
                ctx,
                sequence: acctCfg.type,
                schedRow: item.sched,
                keyInfoGrid,
                dcaGrid,
                maxLocalUpdatedMs: acctCfg.maxLocalUpdatedMs,
              });
              if (pfRes.decision === "skip_unchanged") {
                const nowIso = new Date().toISOString();
                item.types = item.types.filter((t) => t !== acctCfg.type);
                schedPatch[acctCfg.runCol] = nowIso;
                nextFlags[acctCfg.flagKey] = {
                  ...(nextFlags[acctCfg.flagKey] || {}),
                  lastCheckedAt: nowIso,
                  lastSkippedAt: nowIso,
                  lastOutcome: "unchanged_skipped",
                };
                hasScheduleUpdate = true;
                console.log(
                  `[${acctCfg.label} Preflight] ${item.clientName} (${pfRes.probe?.tool || "Accounting"}): No changes detected — skipped full ${acctCfg.type} sync.`
                );
                preflightSkips.push({
                  clientName: item.clientName,
                  mode: "supabase_preflight_skip",
                  types: [acctCfg.type],
                  success: true,
                  skippedUnchanged: true,
                });
              }
            }

            if (item.types.includes("crm")) {
              const pfRes = await evaluateScheduledCrmPreflight({
                ctx,
                schedRow: item.sched,
                keyInfoGrid,
                crmListGrid,
                dcaGrid,
                maxClientJobsUpdatedMs: maxClientJobsUpdatedByClient.get(item.clientName) || 0,
              });

              if (pfRes.decision === "skip_unchanged") {
                const nowIso = new Date().toISOString();
                item.types = item.types.filter((t) => t !== "crm");
                schedPatch.last_crm_run = nowIso;
                nextFlags.crm_preflight = {
                  ...(nextFlags.crm_preflight || {}),
                  lastCheckedAt: nowIso,
                  lastSkippedAt: nowIso,
                  lastOutcome: "unchanged_skipped",
                };
                hasScheduleUpdate = true;
                console.log(
                  `[CRM Preflight] ${item.clientName} (${pfRes.probe?.tool || "CRM"}): No changes detected — skipped full CRM sync.`
                );
                preflightSkips.push({
                  clientName: item.clientName,
                  mode: "supabase_preflight_skip",
                  types: ["crm"],
                  success: true,
                  skippedUnchanged: true,
                });
              } else if (pfRes.decision === "defer_quiet_window") {
                const nowIso = new Date().toISOString();
                item.types = item.types.filter((t) => t !== "crm");
                nextFlags.crm_preflight = {
                  ...(nextFlags.crm_preflight || {}),
                  lastCheckedAt: nowIso,
                  lastOutcome: "deferred_quiet_window",
                  observedModifiedAt: pfRes.probe?.modifiedIso || null,
                };
                hasScheduleUpdate = true;
                console.log(
                  `[CRM Preflight] ${item.clientName} (${pfRes.probe?.tool || "Spreadsheet"}): Edited recently (${pfRes.reason}) — deferring until 60s quiet window settles.`
                );
                preflightSkips.push({
                  clientName: item.clientName,
                  mode: "supabase_preflight_defer",
                  types: ["crm"],
                  success: true,
                  deferredQuietWindow: true,
                });
              }
            }

            if (hasScheduleUpdate) {
              item.flags = nextFlags;
              try {
                await supabase
                  .from("sync_schedules")
                  .update({ ...schedPatch, flags: nextFlags })
                  .eq("client_name", item.clientName);
              } catch (_) { }
            }
          })
        );
      }
    }

    const queue = [];
    for (const item of dueCandidates) {
      if (!item.types || item.types.length === 0) continue;
      queue.push({
        clientName: item.clientName,
        types: item.types,
        flags: item.flags,
        syncType: item.types.length === 3 ? "all" : item.types.length === 1 ? item.types[0] : "all",
      });
    }

    const results = [];

    if (sheetSignals.length > 0) {
      const { getSheetsClient } = await import("./sheetsClient.js");
      const rawSheets = await getSheetsClient("background");
      for (const sig of sheetSignals) {
        const tsIso = new Date().toISOString();
        const batchData = [];
        const schedPatch = {};
        if (sig.types.includes("invoice")) {
          batchData.push({ range: "DataChgAlert!Z2", values: [[tsIso]] });
          schedPatch.last_inv_run = tsIso;
          schedPatch.inv_status = "OK: Signal Sent";
        }
        if (sig.types.includes("crm")) {
          batchData.push({ range: "DataChgAlert!Z3", values: [[tsIso]] });
          schedPatch.last_crm_run = tsIso;
          schedPatch.crm_status = "OK: Signal Sent";
        }
        if (sig.types.includes("expense")) {
          batchData.push({ range: "DataChgAlert!Z4", values: [[tsIso]] });
          schedPatch.last_exp_run = tsIso;
          schedPatch.exp_status = "OK: Signal Sent";
        }
        try {
          await rawSheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sig.masterSheetId,
            _bypassSupabaseVirtualSheet: true,
            requestBody: {
              valueInputOption: "USER_ENTERED",
              data: batchData,
            },
          });
          await supabase.from("sync_schedules").update(schedPatch).eq("client_name", sig.clientName);
          results.push({ clientName: sig.clientName, mode: "sheet", types: sig.types, success: true });
        } catch (sigErr) {
          console.warn(`dispatchDueNativeMasterSyncs: Sheet signal error for ${sig.clientName}:`, sigErr.message);
          results.push({ clientName: sig.clientName, mode: "sheet", types: sig.types, success: false, error: sigErr.message });
        }
      }
    }

    if (queue.length === 0) {
      if (results.length === 0 && preflightSkips.length === 0) {
        console.log("dispatchDueNativeMasterSyncs: No syncs currently due.");
      }
      return {
        dispatched: results.length,
        skippedUnchanged: preflightSkips.length,
        syncs: [...results, ...preflightSkips],
      };
    }

    console.log(
      `dispatchDueNativeMasterSyncs: Found ${queue.length} Supabase client job(s) due. Dispatching with concurrency ${maxConcurrency}...`
    );

    const headers = {
      "Content-Type": "application/json",
      ...(cronSecret ? { "x-cron-secret": cronSecret } : {}),
      ...(bypassToken ? { "x-vercel-protection-bypass": bypassToken } : {}),
    };

    const runChunk = async (clientName, chunkTypes, chunkSyncType) => {
      try {
        if (baseUrl) {
          const res = await fetch(`${baseUrl}/api/pma/master-engine`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              action: "run_native_sync",
              clientName,
              syncType: chunkSyncType,
              types: chunkTypes,
              skipAlertsRefresh: true,
              secret: cronSecret,
            }),
          });
          const json = await res.json().catch(() => ({}));
          return {
            types: chunkTypes,
            success: Boolean(res.ok && json.success),
            error: json.error || (!res.ok ? `HTTP ${res.status}` : null),
          };
        }
        const { getSheetsClient } = await import("./sheetsClient.js");
        const sheets = await getSheetsClient("background");
        await runNativeMasterSync({
          sheets,
          clientName,
          syncType: chunkSyncType,
          types: chunkTypes,
          userEmail,
        });
        return { types: chunkTypes, success: true, error: null };
      } catch (err) {
        return { types: chunkTypes, success: false, error: err.message };
      }
    };

    const executeItem = async (item) => {
      const itemStart = Date.now();
      const baseFlags = item.flags && typeof item.flags === "object" ? item.flags : {};
      await supabase
        .from("sync_schedules")
        .update({
          flags: {
            ...baseFlags,
            in_flight_since: new Date().toISOString(),
            in_flight_seqs: item.types,
          },
        })
        .eq("client_name", item.clientName);

      const shouldSplitExpense = item.types.includes("expense") && item.types.length > 1;
      if (shouldSplitExpense) {
        const nonExpTypes = item.types.filter((t) => t !== "expense");
        const firstSyncType = nonExpTypes.length === 1 ? nonExpTypes[0] : "all";
        const firstRes = await runChunk(item.clientName, nonExpTypes, firstSyncType);
        const secondRes = await runChunk(item.clientName, ["expense"], "expense");
        const ok = firstRes.success && secondRes.success;
        if (!ok) {
          await clearInFlightFlagsSafe_(supabase, item.clientName, baseFlags);
        }
        results.push({
          ...item,
          success: ok,
          durationMs: Date.now() - itemStart,
          error: [firstRes.error, secondRes.error].filter(Boolean).join("; ") || null,
          phases: [firstRes, secondRes],
        });
        return;
      }

      const singleRes = await runChunk(item.clientName, item.types, item.syncType);
      if (!singleRes.success) {
        await clearInFlightFlagsSafe_(supabase, item.clientName, baseFlags);
      }
      results.push({
        ...item,
        success: singleRes.success,
        durationMs: Date.now() - itemStart,
        error: singleRes.error,
      });
    };

    for (let i = 0; i < queue.length; i += maxConcurrency) {
      const chunk = queue.slice(i, i + maxConcurrency);
      await Promise.allSettled(chunk.map(executeItem));
    }

    return {
      dispatched: queue.length + sheetSignals.length,
      skippedUnchanged: preflightSkips.length,
      syncs: [...results, ...preflightSkips],
    };
  } finally {
    if (lockAcquired && redisClient?.isOpen) {
      await redisClient.del(lockKey).catch(() => { });
    }
  }
}

const AMD_ACTION_CONFIG = {
  pull_invoices: {
    fnName: "PullInvoicesBasedOn",
    label: "Pull invoices",
  },
  pull_expenses: {
    fnName: "syncAccountingDataToSheet",
    label: "Pull expenses",
  },
  pull_crm: {
    fnName: "PullCRMBasedOn",
    label: "Pull CRM",
  },
  pull_pl: {
    fnName: "PullPLBasedOn",
    label: "Pull P&L",
  },
  expenses_gap_check: {
    fnName: "runManualEntryAndGapScan",
    label: "Run expenses gap check",
  },
  invoices_gap_check: {
    fnName: "runManualInvoiceGapScan",
    label: "Run invoices gap check",
  },
  retainer_fix: {
    fnName: "RetainerInvoiceFix",
    label: "Run retainer fix",
  },
  pull_outgoings_notes: {
    fnName: "refreshOutgoingsAndUI",
    label: "Pull outgoings notes metadata",
  },
};

/**
 * Executes an individual AMD Master Sheet menu command 100% verbatim inside the Supabase GAS runtime.
 */
export async function runNativeMasterAmdAction({
  sheets,
  clientName = "APPTEST",
  amdAction = "",
  userEmail = "Admin",
  dryRun = false,
}) {
  const cfg = AMD_ACTION_CONFIG[amdAction];
  if (!cfg) {
    throw new Error(`Unsupported AMD action: ${amdAction}`);
  }
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const startMs = Date.now();
  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    executionMeta: {
      functionName: cfg.fnName,
      triggerSource: `Manual (${userEmail})`,
    },
    dryRun,
  });
  attachNativeConnectorHooksToEnv_(env, ctx, false);
  attachNativeConnectorHooksToEnv_(env, ctx, dryRun);
  const gas = createMasterGasInstance(env);

  let rawResult = null;
  let metrics = {};

  try {
    switch (amdAction) {
      case "pull_invoices": {
        if (ctx.connectorPullMode === "native" && !dryRun) {
          rawResult = await pullNativeAccountingInvoices(ctx, { persistToDb: true });
          metrics.rowsCount = rawResult?.rowsCount ?? 0;
        } else {
          rawResult = await gas.PullInvoicesBasedOn(true);
          const rows = env.masterSS.getSheetByName("InvFromApp")?.valuesGrid || [];
          metrics.rowsCount = Math.max(0, rows.length - 1);
        }
        break;
      }
      case "pull_expenses": {
        if (ctx.connectorPullMode === "native" && !dryRun) {
          rawResult = await pullNativeAccountingDirectCosts(ctx, { persistToDb: true });
          metrics.rowsCount = rawResult?.rowsCount ?? 0;
        } else {
          rawResult = await gas.syncAccountingDataToSheet(true);
          const rows = env.masterSS.getSheetByName("JnlsFromApp")?.valuesGrid || [];
          metrics.rowsCount = Math.max(0, rows.length - 1);
        }
        break;
      }
      case "pull_crm": {
        if (ctx.connectorPullMode === "native" && !dryRun) {
          rawResult = await pullNativeCrmDeals(ctx, { persistToDb: true });
          metrics.rowsCount = rawResult?.rowsCount ?? 0;
        } else {
          rawResult = await gas.PullCRMBasedOn(true);
          const rows = env.masterSS.getSheetByName("DataFromCRM")?.valuesGrid || [];
          metrics.rowsCount = Math.max(0, rows.length - 1);
        }
        break;
      }
      case "pull_pl": {
        if (ctx.connectorPullMode === "native" && !dryRun) {
          rawResult = await pullNativeProfitAndLoss(ctx, { persistToDb: true });
          metrics.categoriesCount = rawResult?.rowsCount ?? 0;
        } else {
          rawResult = await gas.PullPLBasedOn(true);
          const rows = env.masterSS.getSheetByName("PLFromApp")?.valuesGrid || [];
          metrics.categoriesCount = Math.max(0, rows.length - 1);
        }
        break;
      }
      case "expenses_gap_check": {
        rawResult = await gas.runManualEntryAndGapScan(false);
        const dirComp = env.masterSS.getSheetByName("DirComp")?.valuesGrid || [];
        metrics.unreconciledGaps = dirComp[1]?.[1] ?? 0;
        metrics.placeholderEntries = dirComp[1]?.[2] ?? 0;
        break;
      }
      case "invoices_gap_check": {
        rawResult = await gas.runManualInvoiceGapScan();
        const invComp = env.masterSS.getSheetByName("InvComp")?.valuesGrid || [];
        metrics.staleUnsentCount = invComp[1]?.[2] ?? 0;
        break;
      }
      case "retainer_fix": {
        rawResult = await gas.RetainerInvoiceFix();
        break;
      }
      case "pull_outgoings_notes": {
        rawResult = await gas.refreshOutgoingsAndUI();
        const notesGrid = env.masterSS.getSheetByName("OutgNotes")?.valuesGrid || [];
        let nonEmptyNotes = 0;
        for (const r of notesGrid) {
          if (!Array.isArray(r)) continue;
          for (const c of r) {
            if (c !== "" && c !== null && c !== undefined) nonEmptyNotes++;
          }
        }
        metrics.notesCount = nonEmptyNotes;
        break;
      }
    }
  } catch (amdErr) {
    env.console.error(`Uncaught AMD action failure (${cfg.fnName}): ${amdErr.message}`);
    await env
      .finalizeExecution({
        summary: `Error: ${amdErr.message}`,
        status: "Failed",
      })
      .catch(() => { });
    await invalidateClientActivityCache(ctx.clientName).catch(() => { });
    throw amdErr;
  }

  const uiAlerts = Array.isArray(env.uiAlerts) ? [...env.uiAlerts] : [];
  const durationMs = Date.now() - startMs;
  const summaryText =
    uiAlerts.length > 0
      ? `${cfg.label}: ${uiAlerts.join(" | ")}`
      : `${cfg.label} completed in ${(durationMs / 1000).toFixed(1)}s`;

  await env.finalizeExecution({ summary: summaryText });

  if (!dryRun) {
    if (amdAction === "pull_crm" && ctx.clientName === "Beyond the Blueprint") {
      await syncBeyondTheBlueprintConversations_({ masterSS: env.masterSS, ctx, sheets });
    }
    markMasterComparisonsFresh(ctx.clientName);
    await invalidateClientActivityCache(ctx.clientName).catch(() => { });
  }

  const comparisons = summarizeComparisonsFromMasterSS_(env.masterSS, ctx.clientName);

  return {
    success: true,
    clientName: ctx.clientName,
    amdAction,
    fnName: cfg.fnName,
    actionLabel: cfg.label,
    durationMs,
    uiAlerts,
    metrics,
    comparisons,
    rawResult: rawResult && typeof rawResult === "object" ? rawResult : null,
  };
}
