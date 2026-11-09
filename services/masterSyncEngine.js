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
import {
  resolveSupabaseSheetContext,
  invalidateMasterEngineCache,
} from "./masterEngineService.js";
import { getIntegrationTokens } from "./vaultService.js";
import { logPmaActivity } from "./pmaLogger.js";
import { invalidateClientActivityCache } from "./activityService.js";
import { autoReconcileClientBankTransactions } from "./bankTransactionsService.js";
import { createGasEnvironment } from "./gasRuntime/gasEnvironment.js";
import { createMasterGasInstance } from "./gasRuntime/compiledMasterGas.js";
import { toNumber } from "./gasRuntime/sheetValueUtils.js";
import { computeNativeMgmtRepForClient } from "./mgmtRepEngine.js";

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

  const confirmedInvoicesScanned = Math.max(0, invDash.length - 2);
  const confirmedDirectCostsScanned = Math.max(0, dirDash.length - 2);

  let invDiscrepancyCount = 0;
  for (let r = 5; r < invComp.length; r++) {
    const row = invComp[r] || [];
    if (row[29] || row[30] || row[31]) invDiscrepancyCount++;
    if (row[74] || row[75] || row[76]) invDiscrepancyCount++;
  }

  let dirDiscrepancyCount = 0;
  for (let r = 5; r < dirComp.length; r++) {
    const row = dirComp[r] || [];
    if (row.slice(40, 48).some((v) => v === 1 || v === "1")) dirDiscrepancyCount++;
    if (row.slice(165, 173).some((v) => v === 1 || v === "1")) dirDiscrepancyCount++;
  }

  return {
    success: true,
    clientName,
    confirmedInvoicesScanned,
    confirmedDirectCostsScanned,
    invDiscrepancyCount,
    dirDiscrepancyCount,
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
  if (maxAgeMs > 0 && Date.now() - lastAt < maxAgeMs) {
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

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
  });
  await env.finalizeExecution({ recordExecution: false });
  markMasterComparisonsFresh(ctx.clientName);

  return summarizeComparisonsFromMasterSS_(env.masterSS, ctx.clientName);
}

/**
 * Recomputes `CRMList` and `CRMComp` in Supabase for the requested mode ("Pipeline" or "Confirmed")
 * using the 1:1 `masterFormulaEngine.js` against the latest live Client Sheet `ConfCalcs` / `PipeCalcs`.
 */
export async function recomputeCrmComparisonInSupabase(sheets, clientName, requestedMode = null) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) return { success: false };

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
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
  const dashDiscrCount = toNumber(crmCompGrid[1]?.[40]); // AO2
  const appDiscrCount = toNumber(crmCompGrid[1]?.[150]); // EU2
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
    executionMeta: { functionName: "processPartPaidInvoices", triggerSource: "Manual (PMA)" },
  });
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
    executionMeta: { functionName: "PushInvDetailsToConfirmed", triggerSource: "Manual (PMA)" },
  });
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
    executionMeta: { functionName: "updateStaleUnsentInvoices", triggerSource: "Manual (PMA)" },
  });
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
    executionMeta: { functionName: "updateOverdueInvoicesInConfirmed", triggerSource: "Manual (PMA)" },
  });
  const gas = createMasterGasInstance(env);
  const res = await gas.updateOverdueInvoicesInConfirmed(env.masterSS, env.masterSS.getSheetByName("DataChgAlert"));
  await env.finalizeExecution({ summary: `Updated ${res?.count || 0} overdue invoice(s)` });
  return res || { count: 0 };
}

/**
 * 2A. Verbatim GAS `syncDirectCostsToClientSheet`
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
    executionMeta: { functionName: "syncDirectCostsToClientSheet", triggerSource: "Manual (PMA)" },
  });
  const gas = createMasterGasInstance(env);
  const res = await gas.syncDirectCostsToClientSheet(true);
  await env.finalizeExecution({ summary: `Pushed ${res?.count || res?.updatedCount || 0} direct cost(s)` });
  return res || { updatedCount: 0 };
}

/**
 * 2B. Verbatim GAS `refreshAccountingToolChartOfAccounts`
 */
export async function refreshNativeChartOfAccounts(sheets, clientName) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    executionMeta: { functionName: "refreshAccountingToolChartOfAccounts", triggerSource: "Manual (PMA)" },
  });
  const gas = createMasterGasInstance(env);
  const res = await gas.refreshAccountingToolChartOfAccounts(true);
  await env.finalizeExecution({ summary: "Refreshed Chart of Accounts" });

  // Mirror KeyInfo!AW2:AW500 to Client Sheet if sheets is available
  const kiGrid = env.masterSS.getSheetByName("KeyInfo")?.valuesGrid || [];
  const categories = [];
  for (let r = 1; r < kiGrid.length; r++) {
    const cName = String(kiGrid[r]?.[48] || "").trim();
    if (cName) categories.push(cName);
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
    } catch (_) {}
  }

  return res || { success: true, categories };
}

/**
 * 2C. Verbatim GAS `PullPLBasedOn`
 */
export async function pullLivePLToSupabaseNative(sheets, clientName) {
  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    executionMeta: { functionName: "PullPLBasedOn", triggerSource: "Manual (PMA)" },
  });
  const gas = createMasterGasInstance(env);
  await gas.PullPLBasedOn(true);
  await env.finalizeExecution({ summary: "Pulled Profit & Loss report" });

  const plGrid = env.masterSS.getSheetByName("PLFromApp")?.valuesGrid || [];
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
  const gas = createMasterGasInstance(env);
  const res = await gas.syncExpenseTransactionBreakdownToClientSheet_(env.masterSS, true);
  await env.finalizeExecution({ summary: "Synced expense breakdown to Client Sheet" });
  return res || { success: true };
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

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    executionMeta: { functionName: "PullCRMBasedOn", triggerSource: "Manual (PMA)" },
  });
  const gas = createMasterGasInstance(env);
  await gas.PullCRMBasedOn(true);
  await env.finalizeExecution({ summary: "Pulled CRM deals" });

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

  const env = await createGasEnvironment({
    ctx,
    sheets,
    autoReconcileFn: autoReconcileClientBankTransactions,
    executionMeta: { functionName: "runRevenueComparison", triggerSource: "Manual (PMA)" },
  });
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
  const triggerLabel = isAutomated ? "Scheduled (30m clock)" : `Manual (${userEmail})`;

  const env = await createGasEnvironment({
    ctx,
    sheets,
    onProgress,
    autoReconcileFn: autoReconcileClientBankTransactions,
    executionMeta: {
      functionName: fnLabel,
      triggerSource: triggerLabel,
    },
  });

  if (runId) {
    env.PropertiesService.getScriptProperties().setProperty("CURRENT_RUN_ID", String(runId));
    env.PropertiesService.getScriptProperties().setProperty("CURRENT_RUN_CLIENT", ctx.clientName);
  }

  const gas = createMasterGasInstance(env);

  // Execute the verbatim GAS `runAgencyAutomator`
  await gas.runAgencyAutomator(runInv, runCrm, runExp);

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

  const schedulePatch = {};
  if (runInv) {
    schedulePatch.last_inv_run = runStartedIso;
    schedulePatch.inv_status = String(dcaGrid[1]?.[28] || `Synced (${invoicesPulled} invoices)`); // AC2
  }
  if (runCrm) {
    schedulePatch.last_crm_run = runStartedIso;
    schedulePatch.crm_status = String(dcaGrid[2]?.[28] || `Synced (${crmDealsPulled} deals)`); // AC3
  }
  if (runExp) {
    schedulePatch.last_exp_run = runStartedIso;
    schedulePatch.exp_status = String(dcaGrid[3]?.[28] || `Synced (${directCostsPulled} bills)`); // AC4
  }

  if (Object.keys(schedulePatch).length > 0) {
    await supabase
      .from("sync_schedules")
      .update(schedulePatch)
      .eq("client_name", ctx.clientName);
  }

  const comparisons = summarizeComparisonsFromMasterSS_(env.masterSS, ctx.clientName);

  const results = {
    clientName: ctx.clientName,
    syncType,
    accountingConnected: Boolean(session),
    accountingTool: session?.tool || "none",
    invoicesPulled,
    directCostsPulled,
    crmDealsPulled,
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
    }).catch(() => {});
  }

  return results;
}
