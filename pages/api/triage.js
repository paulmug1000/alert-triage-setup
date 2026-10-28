/**
 * PHASE 2: ALERT TRIAGE SYSTEM
 * Backend API for analyzing financial automation alerts
 * 
 * Correctly implements:
 * - Flag columns in row 2 of AutoUpdates (CW, DD, DK, etc.)
 * - Client URLs in columns L & M (row 3 onwards)
 * - Comparison sheet data starts at row 6
 * - CRMComp mode toggle based on which flags are raised
 * - Proper column ranges for each alert type
 */

import { waitUntil } from "@vercel/functions";
import { redisClient } from "../../services/redisClient";
import { invalidatePmaClientCache } from "../../services/cacheService";
import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "../../services/sheetsClient";
import { 
  readFlagSweepLog, 
  readPrecomputeLog, 
  readBuildOptionsLog 
} from "../../services/systemLogs";
import { fetchSecurityAuditLogs } from "../../services/pulseLogger";
import {
  handleBulkCreateTasks, handleCreateTask, handleGetTasks, handleAddTaskNote,
  handleSnoozeTask, handleRevertTaskToAlert, handleResolveTask, handleUpdateTask,
  handleCheckExistingTask
} from "../../services/tasksController";
import { sendDailyAlertsSummary } from "../../services/dailyAlertsNotifier";
import {
  handleGetClaudeSettings, handleSaveClaudeSettings, handleCheckClaudeBudget,
  handleLogClaudeUsage, handleGetAppLog, handleTriggerProactiveChecks,
  handleGetSweepSchedule, handleSaveSweepFrequency, handleTriggerAgentRun,
  handleAgentProgress, handleGetAgentRunProgress, handleGetActiveAgentRun,
  handleSyncAllMasterScriptSecrets
} from "../../services/systemConfig";
import {
  handleGetAllClients, handleGetAssignedExpenses, handleMarkExpenseAssigned,
  handlePruneAssignedExpenses, handleGetOutgoingsInbox, handleGetInvoicesInbox,
  handleCreateOutgoingsVendor, handleGetOutgoings, handleGetDirectCostsJobs,
  handleGetInvoiceJobs, handleGetAllClientJobs, handleUpdateJobField, handleUpdateJobFields,
  handleAssignExpenseToJob, handleUpdateExpenseSlot, handleAssignInvoiceToJob,
  handleUpdateInvoiceSlot, handleMoveInvoiceToJob, handleVerifyInvoiceSlot, handleCreateJobFromInvoice, handleAddNewJob, handleUpdateOutgoingNote,
  handleFireOutgoingsPull, handleMarkPipelineCopied, handleDeleteDirectJob, handleMarkPipelineAlreadyConfirmed, handleGetDefaultDaysToPay, getClientWebAppUrl
} from "../../services/workspaces";
import {
  handleGetRetainerJobs, handleRenameRetainerJob, handleChangeRetainerStartDate, handleChangeRetainerEndDate,
  handleChangeRetainerMonthlyAmount, handleCreateRetainerJob, handleTidyUpRetainers,
  handleComputeRetainerAlertResolution, handleComputeRetainerSplitInvoicePreview,
  handleApplyRetainerSplitInvoice, handleDeleteRetainer
} from "../../services/retainers";
import {
  handleEomGetTemplates, handleEomGetExcludedClients, handleEomToggleClientExcluded,
  handleEomReorderClients, handleEomSaveTemplate, handleEomGetClientTasks,
  handleEomGetClientDetail, handleEomSaveClientTask, handleEomGetMonthStatus,
  handleEomUpdateTaskStatus, handleEomUpdateTaskStatusBatch, handleEomUpdateTaskNotelet,
  handleEomReorderTasks, handleEomReorderTemplates, handleEomLoadBankAccounts,
  handleEomGetBankAccounts, handleEomGetCashBalanceProgress, handleEomSaveCashBalance,
  handleEomCreateDashboardBackup, handleEomMarkMonthActual, handleEomMarkNbExclude, handleEomSeedFromChecklist,
  handleEomGetPlCompData, handleEomPullFreshPl, handleEomPushOutgoings,
  handleEomGetDefaultTasks, handleEomSaveDefaultTask, handleEomDeleteDefaultTask,
  handleEomReorderDefaultTasks, handleEomSeedDefaultTasksFromTemplates, handleEomApplyDefaultTasks,
  handleEomGetReportingData, handleEomSaveReportingConfig, handleEomRunReportingAction,
  handleEomTestReportingWebApp, handleEomSaveChartRef, handleEomDeleteChartRef,
  handleEomGetOverheadExpenses, handleEomPreviewOverheadExpenses,
  handleEomAddZeroBudgetCategory, handleEomConfirmOverheadExpenses
} from "../../services/eomTools";
import {
  handleUploadPayrollChunk, handleIdentifyPayrollClient, handleIdentifyTimeClient,
  handleProcessPayrollDocument, handleProcessTimeDocument
} from "../../services/importTools";
import { handleGetActivity } from "../../services/activityService";
import {
  handleBustCache, handleGetAlerts, handleRemoveAlert, handleIgnoreAlert, 
  handleUnignoreAlert, handleGetIgnoredAlerts, handleUpdateSessionFlags,
  handleResolveNoActionFlag, handleBulkResolveNoActionFlags, handleRecordDecision, handleBulkIgnoreAlerts,
  handleAcknowledgeProactiveAlert, handleResolveProactiveAlert, handleBulkAcknowledgeProactiveAlerts,
  handleGetProactiveAlerts
} from "../../services/alertState";
import {
  handleDebugCompareTriage, handleDebugTriageState, handleCleanupAlertMemory,
  handleRehashAlertMemory, handleGetPrecomputed, handleStorePrecomputed,
  handleRunFlagSweep, handleBuildCachedAlertOptions, handleAnalyzeAlert,
  handleAcceptOption, handleDeleteJob, handleAnalyzeNoActionFlag,
  handleCheckOutgoingsCell,
  handleRehashIgnoredAlerts, PRECOMPUTED_KEY,
  getTriageRefreshStatus, setTriageRefreshStatus, runBackgroundTriageRefresh
} from "../../services/triageEngine";
import { getClientViewData, handleUpdateViewCell, handleSpreadViewRow, handleUpdateCellNote } from "../../services/viewsService";
import {
  getCashflowReconData,
  updateCashAdjustment,
  toggleCashCellResolved,
  updateCashCellNote,
  updateReconTransactionCategory,
  syncReconBankTransactions,
  syncReconUnreconciledItems,
  batchMatchCashflowActuals,
  setReconDa1Platform,
  setReconMonthReadyStatus,
  dismissNewBankTransactions
} from "../../services/cashflowReconService";
import {
  ensureReconTabExists,
  autoProvisionAllReconTabs
} from "../../services/reconTabService";
import {
  fetchClientReconciledBankTransactions,
  parseUnreconciledItems,
  recategoriseTransactions,
  autoReconcileClientBankTransactions
} from "../../services/bankTransactionsService";
import { handleClassifyPLCategory, handleUpdatePartPaidDate } from "../../services/proactiveChecks";
import { getSessionUser, safeCompareSecret } from "../../services/authService";
import {
  isUserAuthorizedForClient,
  updateUserDailyAlertsEmail,
  getUserByEmail,
  resolveClientNameBySheetId,
  verifyUserAuthorizedForSheet,
  getCanonicalAcSheetId,
  isReadOnlySession,
  canAccessPma,
  unwrapRequestSheetIds,
  installSheetIdBoundary
} from "../../services/userPermissions";
import { matchesClientName, sanitizeSpreadsheetTerms } from "../../utils/helpers";

async function checkTriageClientAuth(sheets, sessionUser, clientNameClaim, sheetIds = []) {
  if (sessionUser?.isAdmin && !isReadOnlySession(sessionUser)) return true;
  if (!sessionUser) return false;

  const validSheetIds = (Array.isArray(sheetIds) ? sheetIds : [sheetIds])
    .map(s => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);

  if (validSheetIds.length > 0) {
    for (const sid of validSheetIds) {
      try {
        const auth = await verifyUserAuthorizedForSheet(sessionUser, sid, clientNameClaim, sheets);
        if (!auth.authorized) return false;
      } catch (_) {
        return false;
      }
    }
    return true;
  }

  return Boolean(clientNameClaim && isUserAuthorizedForClient(sessionUser, clientNameClaim));
}

// eomTabsVerified moved to eomTools.js

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================
// FLAG_COLUMNS/NO_ACTION_FLAGS retired 24 Aug 2026 - both were only used by
// the old start_triage implementation (AutoUpdates sticky-column-based),
// which has been fully replaced by a thin orchestrator that reuses
// run_flag_sweep/build_cached_alert_options/store_precomputed instead.

// ============================================================================
// OUTGOINGS TAB WRITE HELPER
// Mirrors the logic of the GAS updateOutgoingsExpense_ function.
// Finds the correct category row and month column, then:
//   - Adds the expense amount to the existing cell value
//   - Appends a structured {App ID:...} block to the cell note
// ============================================================================

// Increase body size limit - store_precomputed sends the full alert list
// Set maxDuration to 300s (5 minutes) on Vercel Pro for background sweeps
export const config = {
  maxDuration: 300,
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

// ============================================================================
// MAIN HANDLER
// ============================================================================

export default async function handler(req, res) {
  // Set CORS headers (MED-03: strict origin allowlist)
  const allowedOrigins = [
    "https://app.pulsedashboard.co.uk",
    "https://pulsedashboard.co.uk",
    "https://pma.pulsedashboard.co.uk",
    ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : [])
  ];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://app.pulsedashboard.co.uk");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-pma-token"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    unwrapRequestSheetIds(req.body);
    unwrapRequestSheetIds(req.query);
    // Handle both POST (req.body) and GET (req.query) requests
    const action = req.method === "GET" ? req.query.action : req.body.action;
    const automationCommanderSheetId = getCanonicalAcSheetId();
    if (req.body && typeof req.body === "object") {
      req.body.automationCommanderSheetId = automationCommanderSheetId;
    }
    if (req.query && typeof req.query === "object") {
      req.query.automationCommanderSheetId = automationCommanderSheetId;
    }

    // Intercept successful mutation responses to automatically bust corresponding PMA L1/L2 caches
    const PMA_MUTATION_SCOPES = {
      update_job_field: ["jobs", "invoices", "cash"],
      update_job_fields: ["jobs", "invoices", "cash"],
      assign_expense_to_job: ["outgoings", "jobs", "cash"],
      update_expense_slot: ["outgoings", "jobs", "cash"],
      assign_invoice_to_job: ["invoices", "jobs", "cash"],
      update_invoice_slot: ["invoices", "jobs", "cash"],
      move_invoice_to_job: ["invoices", "jobs", "cash"],
      verify_invoice_slot: ["invoices", "jobs"],
      create_job_from_invoice: ["invoices", "jobs", "cash"],
      add_new_job: ["jobs", "invoices", "outgoings", "cash"],
      mark_pipeline_copied: ["jobs", "cash"],
      mark_pipeline_already_confirmed: ["jobs", "cash"],
      delete_direct_job: ["jobs", "invoices", "outgoings", "cash"],
      rename_retainer_job: ["retainers", "jobs", "invoices", "cash"],
      change_retainer_start_date: ["retainers", "jobs", "invoices", "cash"],
      change_retainer_end_date: ["retainers", "jobs", "invoices", "cash"],
      change_retainer_monthly_amount: ["retainers", "jobs", "invoices", "cash"],
      create_retainer_job: ["retainers", "jobs", "invoices", "cash"],
      tidy_up_retainers: ["retainers", "jobs", "invoices", "cash"],
      apply_retainer_split_invoice: ["retainers", "jobs", "invoices", "cash"],
      delete_retainer: ["retainers", "jobs", "invoices", "cash"],
      create_outgoings_vendor: ["outgoings"],
      update_outgoing_note: ["outgoings", "cash"],
      mark_expense_assigned: ["outgoings", "cash"],
      prune_assigned_expenses: ["outgoings", "cash"],
      delete_invoice_from_pulse: ["invoices", "jobs", "cash"],
      eom_add_zero_budget_category: ["budget"]
    };

    const originalJson = res.json.bind(res);
    res.json = function(data) {
      if (data && data.success && PMA_MUTATION_SCOPES[action]) {
        const cId = req.body?.clientSheetId;
        const mId = req.body?.masterSheetId;
        invalidatePmaClientCache(cId, mId, PMA_MUTATION_SCOPES[action]).catch(err => {
          console.warn(`[PMA Invalidation] Error for ${action}:`, err?.message);
        });
      }
      return originalJson(data);
    };

    // Enforce POST for all state-mutating actions
    const READ_ONLY_ACTIONS = new Set([
      "get_session",
      "get_alerts",
      "get_precomputed",
      "get_ignored_alerts",
      "get_proactive_alerts",
      "get_activity",
      "get_client_view_data",
      "get_cashflow_recon_data",
      "get_users",
      "get_user_preferences",
      "get_tasks",
      "check_existing_task",
      "get_app_log",
      "get_flag_sweep_log",
      "get_precompute_log",
      "get_build_options_log",
      "get_security_audit_log",
      "get_security_audit_logs",
      "get_claude_settings",
      "check_claude_budget",
      "get_sweep_schedule",
      "get_agent_run_progress",
      "get_all_clients",
      "get_assigned_expenses",
      "get_outgoings_inbox",
      "get_invoices_inbox",
      "get_outgoings",
      "get_direct_costs_jobs",
      "get_invoice_jobs",
      "get_all_client_jobs",
      "get_retainer_jobs",
      "eom_get_templates",
      "eom_get_excluded_clients",
      "eom_get_client_tasks",
      "eom_get_client_detail",
      "eom_get_month_status",
      "eom_get_bank_accounts",
      "eom_get_cash_balance_progress",
      "eom_get_pl_comp_data",
      "eom_get_plcomp_data",
      "get_cash_cells",
      "get_cash_inbox",
      "get_cash_adjustments",
      "verify_invoice_slot",
      "eom_get_reporting_data"
    ]);

    if (req.method === "GET" && !READ_ONLY_ACTIONS.has(action)) {
      return res.status(405).json({
        success: false,
        error: `Method Not Allowed: Action '${action}' modifies state and requires POST.`
      });
    }

    const sheets = await getSheetsClient();

    console.log(`\n📍 API Request: method=${req.method}, action=${action}, bodyKeys=${Object.keys(req.body || {}).join(",")}, bodySize=${JSON.stringify(req.body || {}).length}`);

    const sessionUser = getSessionUser(req, res);
    installSheetIdBoundary(req, res, sessionUser);

    // Public endpoints that do not require an active user session
    const PUBLIC_ACTIONS = new Set(["send_otp", "verify_otp", "get_session", "logout"]);

    // Background jobs allowed with verified CRON_SECRET, AGENT_TRIGGER_SECRET, or PULSE_INTERNAL_SECRET
    const cronSecret = (process.env.CRON_SECRET || "").trim();
    const isCronAuthorized = Boolean(
      cronSecret && (
        safeCompareSecret(String(req.body?.secret || "").trim(), cronSecret) ||
        safeCompareSecret(String(req.query?.secret || "").trim(), cronSecret) ||
        safeCompareSecret(String(req.headers["x-cron-secret"] || "").trim(), cronSecret) ||
        safeCompareSecret(String(req.headers.authorization || "").trim(), `Bearer ${cronSecret}`)
      )
    );
    const validAgentSecrets = [
      process.env.AGENT_TRIGGER_SECRET,
      process.env.CRON_SECRET,
    ].filter(Boolean).map(s => String(s).replace(/^["']|["']$/g, '').trim());
    const incomingSecret = String(req.body?.secret || req.headers["x-cron-secret"] || "").replace(/^["']|["']$/g, '').trim();
    const isAgentAuthorized = Boolean(
      validAgentSecrets.length > 0 &&
      incomingSecret &&
      validAgentSecrets.some(s =>
        safeCompareSecret(incomingSecret, s) ||
        safeCompareSecret(String(req.headers.authorization || "").trim(), `Bearer ${s}`)
      )
    );
    const internalSecret = (process.env.PULSE_INTERNAL_SECRET || "").trim();
    const isInternalAuthorized = Boolean(
      internalSecret && (
        safeCompareSecret(String(req.body?.secret || "").trim(), internalSecret) ||
        safeCompareSecret(String(req.query?.secret || "").trim(), internalSecret) ||
        safeCompareSecret(String(req.headers["x-internal-secret"] || "").trim(), internalSecret) ||
        safeCompareSecret(String(req.headers.authorization || "").trim(), `Bearer ${internalSecret}`)
      )
    );

    const isSystemAuthorized =
      (isCronAuthorized && (
        action === "trigger_refresh" ||
        action === "get_refresh_status" ||
        action === "run_flag_sweep" ||
        action === "build_cached_alert_options" ||
        action === "analyze_alert" ||
        action === "analyze_noaction_flag" ||
        action === "store_precomputed" ||
        action === "send_daily_alerts_summary" ||
        action === "get_activity" ||
        action === "auto_provision_recon_tabs" ||
        action === "auto_reconcile_bank_feeds"
      )) ||
      (isAgentAuthorized && action === "agent_progress") ||
      (isInternalAuthorized && (action === "auto_reconcile_bank_feeds" || action === "fetch_api_bank_transactions"));

    req.isSystemAuthorized = Boolean(isSystemAuthorized);

    // Enforce authentication gateway across all protected actions
    if (!PUBLIC_ACTIONS.has(action) && !isSystemAuthorized) {
      if (!sessionUser) {
        return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
      }

      // Enforce strict read-only lock across all state-mutating actions for EmailOTP / read-only sessions
      if (isReadOnlySession(sessionUser) && !READ_ONLY_ACTIONS.has(action)) {
        return res.status(403).json({
          success: false,
          error: "Forbidden: Read-only sessions cannot perform modifications."
        });
      }

      // Block ClientUser, Senior (Restricted), and any EmailOTP / read-only session from accessing internal PMA actions
      const isPulseOnly = !canAccessPma(sessionUser) ||
                          isReadOnlySession(sessionUser) ||
                          sessionUser.role === "ClientUser" ||
                          sessionUser.role === "Senior (Restricted)" ||
                          Boolean(sessionUser.isSenior);

      const ALLOWED_CLIENT_ACTIONS = new Set(["get_session", "logout", "get_user_preferences", "update_user_preference"]);
      if (isPulseOnly && !ALLOWED_CLIENT_ACTIONS.has(action)) {
        return res.status(403).json({ success: false, error: "Forbidden: Access restricted to Pulse Portal" });
      }

      // Restrict system/admin-only actions (HIGH-02 & R2-CRIT-01 & R2-HIGH-01)
      const ADMIN_ONLY_TRIAGE_ACTIONS = new Set([
        "agent_progress",
        "trigger_agent_run",
        "store_precomputed",
        "rehash_ignored_alerts",
        "send_daily_alerts_summary",
        "eom_save_template",
        "eom_reorder_templates",
        "eom_toggle_client_excluded",
        "eom_reorder_clients",
        "eom_load_bank_accounts",
        "eom_seed_from_checklist",
        "eom_get_default_tasks",
        "eom_save_default_task",
        "eom_delete_default_task",
        "eom_reorder_default_tasks",
        "eom_seed_default_tasks",
        "eom_apply_default_tasks",
        "eom_save_reporting_config",
        "eom_test_reporting_webapp",
        "eom_run_reporting_action",
        "eom_save_chart_ref",
        "eom_delete_chart_ref",
        "save_claude_settings",
        "get_claude_settings",
        "check_claude_budget",
        "get_sweep_schedule",
        "log_claude_usage",
        "get_app_log",
        "get_flag_sweep_log",
        "get_precompute_log",
        "get_build_options_log",
        "run_flag_sweep",
        "build_cached_alert_options",
        "trigger_refresh",
        "sync_all_master_script_secrets",
        "bust_cache"
      ]);
      if (ADMIN_ONLY_TRIAGE_ACTIONS.has(action) && !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required for this action." });
      }

      // Universal Multi-Tenant Pre-Dispatch Guard for non-admin sessions
      if (!sessionUser.isAdmin) {
        const b = req.body || {};
        const q = req.query || {};
        const targetClientClaim = b.clientName || q.clientName || b.alert?.clientName || "";
        const targetSheetIds = [
          b.clientSheetId, q.clientSheetId,
          b.masterSheetId, q.masterSheetId,
          b.reconSheetId, q.reconSheetId,
          b.reconSheetUrl ? extractSheetIdFromUrl(b.reconSheetUrl) : null,
          b.cashTabSheetId, q.cashTabSheetId,
          b.payrollClientSheetId, q.payrollClientSheetId,
          b.timeMasterSheetId, q.timeMasterSheetId,
          b.sheetId, q.sheetId,
          b.clientId, q.clientId,
          b.alert?.masterSheetId, b.alert?.clientSheetId, b.alert?.clientId
        ].filter(Boolean);

        if (targetSheetIds.length > 0 || targetClientClaim) {
          const isTenantAllowed = await checkTriageClientAuth(sheets, sessionUser, targetClientClaim, targetSheetIds);
          if (!isTenantAllowed) {
            return res.status(403).json({ success: false, error: "Forbidden: Access denied to this client or spreadsheet." });
          }
        }

        if (Array.isArray(b.alerts) && b.alerts.length > 0) {
          for (const item of b.alerts) {
            if (!item) continue;
            const itemAllowed = await checkTriageClientAuth(
              sheets,
              sessionUser,
              item.clientName || targetClientClaim,
              [item.clientSheetId, item.masterSheetId, item.clientId].filter(Boolean)
            );
            if (!itemAllowed) {
              return res.status(403).json({ success: false, error: "Forbidden: Access denied to one or more client alerts in batch." });
            }
          }
        }

        if (Array.isArray(b.updates) && b.updates.length > 0) {
          for (const item of b.updates) {
            if (!item || !item.clientName) continue;
            if (!isUserAuthorizedForClient(sessionUser, item.clientName)) {
              return res.status(403).json({ success: false, error: "Forbidden: Access denied to one or more clients in batch update." });
            }
          }
        }
      }
    }

    const extractSafeClientIp = () => {
      const vercelFwd = req.headers["x-vercel-forwarded-for"];
      if (typeof vercelFwd === "string" && vercelFwd.trim()) return vercelFwd.split(",")[0].trim();
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
      if (Array.isArray(forwarded) && forwarded[0]) return String(forwarded[0]).trim();
      return req.socket?.remoteAddress || "127.0.0.1";
    };

    if (action === "send_otp") {
      const { email } = req.body || {};
      const clientIp = extractSafeClientIp();
      const result = await sendOtp(email, automationCommanderSheetId, clientIp);
      return res.status(200).json(result);

    } else if (action === "verify_otp") {
      const { email, code } = req.body || {};
      const clientIp = extractSafeClientIp();
      const result = await verifyOtp(email, code, automationCommanderSheetId, res, clientIp);
      return res.status(result.success ? 200 : 401).json(result);

    } else if (action === "get_session") {
      return res.status(200).json({ authenticated: !!sessionUser, user: sessionUser });

    } else if (action === "logout") {
      clearSessionCookie(res);
      return res.status(200).json({ success: true, message: "Logged out" });

    } else if (action === "get_users") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }
      const users = await getAllUsers(sheets, automationCommanderSheetId);
      return res.status(200).json({ success: true, users });

    } else if (action === "sync_all_master_script_secrets") {
      if (!isInternalAuthorized && (!sessionUser || !sessionUser.isAdmin)) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin access required." });
      }
      return await handleSyncAllMasterScriptSecrets(req, res, sheets);

    } else if (action === "get_user_preferences") {
      if (!sessionUser || !sessionUser.email) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
      try {
        const userRecord = await getUserByEmail(sessionUser.email, sheets, automationCommanderSheetId);
        return res.status(200).json({
          success: true,
          dailyAlertsEmail: userRecord?.dailyAlertsEmail || "Yes"
        });
      } catch (err) {
        console.error("❌ get_user_preferences error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "update_user_preference") {
      if (!sessionUser || !sessionUser.email) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
      try {
        const { dailyAlertsEmail } = req.body;
        const result = await updateUserDailyAlertsEmail(sessionUser.email, dailyAlertsEmail, sheets, automationCommanderSheetId);
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ update_user_preference error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "emergency_flush_redis") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required" });
      }
      await redisClient.flushDb();
      return res.status(200).json({ success: true, message: "Redis database flushed successfully." });

} else if (action === "get_all_clients") {
      return await handleGetAllClients(req, res, sheets);
    } else if (action === "get_assigned_expenses") {
      return await handleGetAssignedExpenses(req, res, sheets);
    } else if (action === "mark_expense_assigned") {
      return await handleMarkExpenseAssigned(req, res, sheets);
    } else if (action === "prune_assigned_expenses") {
      return await handlePruneAssignedExpenses(req, res, sheets);
    } else if (action === "get_outgoings_inbox") {
      return await handleGetOutgoingsInbox(req, res, sheets);
    } else if (action === "get_invoices_inbox") {
      return await handleGetInvoicesInbox(req, res, sheets);
    } else if (action === "create_outgoings_vendor") {
      return await handleCreateOutgoingsVendor(req, res, sheets);
    } else if (action === "get_outgoings") {
      return await handleGetOutgoings(req, res, sheets);
    } else if (action === "check_outgoings_cell") {
      return await handleCheckOutgoingsCell(req, res, sheets);
    } else if (action === "get_direct_costs_jobs") {
      return await handleGetDirectCostsJobs(req, res, sheets);
    } else if (action === "get_invoice_jobs") {
      return await handleGetInvoiceJobs(req, res, sheets);
    } else if (action === "get_all_client_jobs") {
      return await handleGetAllClientJobs(req, res, sheets);
    } else if (action === "update_job_field") {
      return await handleUpdateJobField(req, res, sheets);
    } else if (action === "update_job_fields") {
      return await handleUpdateJobFields(req, res, sheets);
    } else if (action === "assign_expense_to_job") {
      return await handleAssignExpenseToJob(req, res, sheets);
    } else if (action === "update_expense_slot") {
      return await handleUpdateExpenseSlot(req, res, sheets);
    } else if (action === "assign_invoice_to_job") {
      return await handleAssignInvoiceToJob(req, res, sheets);
    } else if (action === "update_invoice_slot") {
      return await handleUpdateInvoiceSlot(req, res, sheets);
    } else if (action === "move_invoice_to_job") {
      return await handleMoveInvoiceToJob(req, res, sheets);
    } else if (action === "verify_invoice_slot") {
      return await handleVerifyInvoiceSlot(req, res, sheets);
    } else if (action === "create_job_from_invoice") {
      return await handleCreateJobFromInvoice(req, res, sheets);
    } else if (action === "get_default_days_to_pay") {
      return await handleGetDefaultDaysToPay(req, res, sheets);
    } else if (action === "add_new_job") {
      return await handleAddNewJob(req, res, sheets);
    } else if (action === "mark_pipeline_copied") {
      return await handleMarkPipelineCopied(req, res, sheets);
    } else if (action === "mark_pipeline_already_confirmed") {
      return await handleMarkPipelineAlreadyConfirmed(req, res, sheets);
    } else if (action === "delete_direct_job") {
      return await handleDeleteDirectJob(req, res, sheets);
    } else if (action === "get_retainer_jobs") {
      return await handleGetRetainerJobs(req, res, sheets);
    } else if (action === "rename_retainer_job") {
      return await handleRenameRetainerJob(req, res, sheets);
    } else if (action === "change_retainer_start_date") {
      return await handleChangeRetainerStartDate(req, res, sheets);
    } else if (action === "change_retainer_end_date") {
      return await handleChangeRetainerEndDate(req, res, sheets);
    } else if (action === "change_retainer_monthly_amount") {
      return await handleChangeRetainerMonthlyAmount(req, res, sheets);
    } else if (action === "create_retainer_job") {
      return await handleCreateRetainerJob(req, res, sheets);
    } else if (action === "tidy_up_retainers") {
      return await handleTidyUpRetainers(req, res, sheets);
    } else if (action === "compute_retainer_alert_resolution") {
      return await handleComputeRetainerAlertResolution(req, res, sheets);
    } else if (action === "compute_retainer_split_invoice_preview") {
      return await handleComputeRetainerSplitInvoicePreview(req, res, sheets);
    } else if (action === "apply_retainer_split_invoice") {
      return await handleApplyRetainerSplitInvoice(req, res, sheets);
    } else if (action === "delete_retainer") {
      return await handleDeleteRetainer(req, res, sheets);

    } else if (action === "update_outgoing_note") {
      return await handleUpdateOutgoingNote(req, res, sheets);
    } else if (action === "get_claude_settings") {
      return await handleGetClaudeSettings(req, res, sheets);
    } else if (action === "save_claude_settings") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required" });
      }
      return await handleSaveClaudeSettings(req, res, sheets);
    } else if (action === "check_claude_budget") {
      return await handleCheckClaudeBudget(req, res, sheets);
    } else if (action === "log_claude_usage") {
      return await handleLogClaudeUsage(req, res, sheets);
    } else if (action === "get_app_log") {
      return await handleGetAppLog(req, res, sheets);
    } else if (action === "get_activity") {
      return await handleGetActivity(req, res, sheets);
    } else if (action === "get_client_view_data") {
      try {
        const { clientSheetId, masterSheetId, tab, clientName, bypassCache } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [clientSheetId, masterSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const data = await getClientViewData({ clientSheetId, masterSheetId, tab, bypassCache });
        return res.status(200).json(data);
      } catch (err) {
        console.error("❌ get_client_view_data error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "update_view_cell") {
      return await handleUpdateViewCell(req, res, sheets);
    } else if (action === "update_cell_note") {
      return await handleUpdateCellNote(req, res, sheets);
    } else if (action === "spread_view_row") {
      return await handleSpreadViewRow(req, res, sheets);
    } else if (action === "get_cashflow_recon_data") {
      try {
        const { clientSheetId, reconSheetUrl, reconSheetId, eomMonthKey, targetMonthKey, clientName } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [clientSheetId, reconSheetId, reconSheetUrl]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const data = await getCashflowReconData({ clientSheetId, reconSheetUrl, reconSheetId, eomMonthKey, targetMonthKey });
        return res.status(200).json(data);
      } catch (err) {
        console.error("❌ get_cashflow_recon_data error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "update_cash_adjustment") {
      try {
        const { clientSheetId, colLetter, sheetRow, value, clientName, automationCommanderSheetId } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [clientSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await updateCashAdjustment({
          clientSheetId,
          colLetter,
          sheetRow,
          value,
          clientName,
          automationCommanderSheetId
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ update_cash_adjustment error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "toggle_cash_cell_resolved") {
      try {
        const { clientSheetId, cashTabSheetId, sheetRow, colIdx, resolved, clientName, automationCommanderSheetId } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [clientSheetId, cashTabSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await toggleCashCellResolved({
          clientSheetId,
          cashTabSheetId,
          sheetRow,
          colIdx,
          resolved,
          clientName,
          automationCommanderSheetId
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ toggle_cash_cell_resolved error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
    } else if (action === "update_cash_cell_note") {
      try {
        const { clientSheetId, cashTabSheetId, sheetRow, colIdx, note, clientName, automationCommanderSheetId } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [clientSheetId, cashTabSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await updateCashCellNote({
          clientSheetId,
          cashTabSheetId,
          sheetRow,
          colIdx,
          note,
          clientName,
          automationCommanderSheetId
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ update_cash_cell_note error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "batch_match_cashflow_actuals") {
      try {
        const { clientSheetId, cashTabSheetId, colIdx, colLetter, adjustments, resolvedRows, clientName, automationCommanderSheetId } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [clientSheetId, cashTabSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await batchMatchCashflowActuals({
          clientSheetId,
          cashTabSheetId,
          colIdx,
          colLetter,
          adjustments,
          resolvedRows,
          clientName,
          automationCommanderSheetId
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ batch_match_cashflow_actuals error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "set_recon_da1_platform") {
      try {
        const { reconSheetId, tabName, platform, clientName } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [reconSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await setReconDa1Platform({
          reconSheetId,
          tabName,
          platform
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ set_recon_da1_platform error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "ensure_recon_tab") {
      try {
        const { reconSheetId, reconSheetUrl, targetDateInput, tabName, targetTabName, clientName } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [reconSheetId, reconSheetUrl]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await ensureReconTabExists({
          reconSheetId,
          reconSheetUrl,
          targetDateInput,
          tabName: tabName || targetTabName,
          clientName
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ ensure_recon_tab error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "auto_provision_recon_tabs") {
      try {
        const { targetDateInput, automationCommanderSheetId } = req.body;
        if (!req.isSystemAuthorized && !sessionUser?.isAdmin) {
          return res.status(403).json({ success: false, error: "Admin or Cron authorization required" });
        }
        const result = await autoProvisionAllReconTabs({
          targetDateInput,
          automationCommanderSheetId
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ auto_provision_recon_tabs error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "fetch_api_bank_transactions") {
      try {
        const { clientName, masterSheetId, reconSheetId, monthKey } = req.body;
        if (!req.isSystemAuthorized && !(await checkTriageClientAuth(sheets, sessionUser, clientName, [masterSheetId, reconSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await fetchClientReconciledBankTransactions({
          clientName,
          masterSheetId,
          reconSheetId,
          monthKey
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ fetch_api_bank_transactions error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "auto_reconcile_bank_feeds") {
      try {
        const { clientName, masterSheetId, reconSheetId, monthKey, automationCommanderSheetId } = req.body;
        if (!req.isSystemAuthorized && !(await checkTriageClientAuth(sheets, sessionUser, clientName, [masterSheetId, reconSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await autoReconcileClientBankTransactions({
          clientName,
          masterSheetId,
          reconSheetId,
          monthKey,
          automationCommanderSheetId
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ auto_reconcile_bank_feeds error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "recategorise_all_transactions") {
      try {
        const { clientName, reconSheetId, transactions } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [reconSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await recategoriseTransactions({
          reconSheetId,
          transactions
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ recategorise_all_transactions error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "parse_unreconciled_items") {
      try {
        const { rawText, rows, monthKey } = req.body;
        const result = parseUnreconciledItems({ rawText, rows, monthKey });
        return res.status(200).json({ success: true, ...result });
      } catch (err) {
        console.error("❌ parse_unreconciled_items error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "update_recon_transaction_category") {
      try {
        const { reconSheetId, tabName, rowNum, category, clientName, automationCommanderSheetId } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [reconSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await updateReconTransactionCategory({
          reconSheetId,
          tabName,
          rowNum,
          category,
          clientName,
          automationCommanderSheetId
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ update_recon_transaction_category error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "sync_recon_bank_transactions") {
      try {
        const { reconSheetId, tabName, transactions, clientName } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [reconSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await syncReconBankTransactions({
          reconSheetId,
          tabName,
          transactions
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ sync_recon_bank_transactions error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "sync_recon_unreconciled_items") {
      try {
        const { reconSheetId, tabName, unreconciledItems, clientName } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [reconSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await syncReconUnreconciledItems({
          reconSheetId,
          tabName,
          unreconciledItems
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ sync_recon_unreconciled_items error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "set_recon_month_ready") {
      try {
        const { reconSheetId, tabName, isComplete, clientName, automationCommanderSheetId } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [reconSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await setReconMonthReadyStatus({
          reconSheetId,
          tabName,
          isComplete,
          clientName,
          automationCommanderSheetId
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ set_recon_month_ready error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "dismiss_new_bank_transactions") {
      try {
        const { reconSheetId, tabName, clientName, automationCommanderSheetId } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [reconSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await dismissNewBankTransactions({
          reconSheetId,
          tabName,
          clientName,
          automationCommanderSheetId
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ dismiss_new_bank_transactions error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "sync_client_expense_breakdown") {
      try {
        const { clientName, automationCommanderSheetId } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, []))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const webAppUrl = await getClientWebAppUrl(sheets, clientName, automationCommanderSheetId);

        if (webAppUrl) {
          const secret = (process.env.AGENT_TRIGGER_SECRET || process.env.CRON_SECRET || "").trim();
          if (!secret) {
            return res.status(500).json({ success: false, error: "AGENT_TRIGGER_SECRET is not configured on server" });
          }
          const gasResp = await fetch(webAppUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ secret, action: "sync_expense_breakdown", clientName })
          });
          const gasText = await gasResp.text();
          let gasData = null;
          try { gasData = JSON.parse(gasText); } catch (e) {}
          return res.status(200).json({ success: true, gasResult: gasData || gasText });
        }
        return res.status(200).json({ success: true, message: "No Master Web App URL configured" });
      } catch (err) {
        console.error("❌ sync_client_expense_breakdown error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "classify_pl_category") {
      try {
        const { clientName, categoryName, classification, automationCommanderSheetId, masterSheetId, clientSheetId } = req.body;
        if (!(await checkTriageClientAuth(sheets, sessionUser, clientName, [masterSheetId, clientSheetId]))) {
          return res.status(403).json({ success: false, error: "Access denied to this client" });
        }
        const result = await handleClassifyPLCategory(sheets, {
          clientName,
          categoryName,
          classification,
          automationCommanderSheetId,
          masterSheetId,
          clientSheetId,
          userEmail: sessionUser?.email
        });
        return res.status(200).json(result);
      } catch (err) {
        console.error("❌ classify_pl_category error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "trigger_refresh") {
      try {
        const current = await getTriageRefreshStatus();
        if (current && current.status === "running") {
          return res.status(200).json({ success: true, alreadyRunning: true, status: current });
        }

        const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${process.env.PORT || 3000}`;
        const protocol = req.headers["x-forwarded-proto"] || (host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https");
        const cleanUrl = (url) => url ? (url.startsWith("http") ? url : `https://${url}`) : null;
        const prodUrl = cleanUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) || cleanUrl(process.env.VERCEL_URL);
        const baseUrl = prodUrl || `${protocol}://${host}`;
        const cronSecret = process.env.CRON_SECRET;

        await setTriageRefreshStatus({
          status: "running",
          step: "init",
          progress: "Initializing background refresh...",
          startedAt: Date.now(),
          updatedAt: Date.now(),
        });

        const task = runBackgroundTriageRefresh({
          baseUrl,
          cronSecret,
          automationCommanderSheetId,
          forceProactive: req.body.forceProactive !== false,
        }).catch(err => {
          console.error("❌ Background triage refresh task error:", err);
        });

        waitUntil(task);

        return res.status(200).json({ success: true, started: true });
      } catch (err) {
        console.error("❌ Error triggering background refresh:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "get_refresh_status") {
      try {
        const status = await getTriageRefreshStatus();
        return res.status(200).json({ success: true, status });
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }


    } else if (action === "fire_outgoings_pull") {
      return await handleFireOutgoingsPull(req, res, sheets);
    } else if (action === "trigger_proactive_checks") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required" });
      }
      return await handleTriggerProactiveChecks(req, res);
    } else if (action === "get_sweep_schedule") {
      return await handleGetSweepSchedule(req, res, sheets);
    } else if (action === "save_sweep_frequency") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required" });
      }
      return await handleSaveSweepFrequency(req, res, sheets);
    } else if (action === "trigger_agent_run") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required" });
      }
      return await handleTriggerAgentRun(req, res, sheets);
    } else if (action === "agent_progress") {
      return await handleAgentProgress(req, res);
    } else if (action === "get_agent_run_progress") {
      return await handleGetAgentRunProgress(req, res);
    } else if (action === "get_active_agent_run") {
      return await handleGetActiveAgentRun(req, res);

    } else if (action === "debug_compare_triage") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required" });
      }
      return await handleDebugCompareTriage(req, res, sheets);
    } else if (action === "debug_triage_state") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required" });
      }
      return await handleDebugTriageState(req, res, sheets);
    } else if (action === "cleanup_alert_memory") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required" });
      }
      return await handleCleanupAlertMemory(req, res, sheets);
    } else if (action === "rehash_alert_memory") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required" });
      }
      return await handleRehashAlertMemory(req, res, sheets);
    } else if (action === "get_precomputed") {
      return await handleGetPrecomputed(req, res, sheets);
    } else if (action === "store_precomputed") {
      return await handleStorePrecomputed(req, res, sheets);
    } else if (action === "run_flag_sweep") {
      return await handleRunFlagSweep(req, res, sheets);
    } else if (action === "send_daily_alerts_summary") {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret && req.body.secret !== cronSecret && (!sessionUser || !sessionUser.isAdmin)) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }
      const result = await sendDailyAlertsSummary(sheets, automationCommanderSheetId);
      return res.status(200).json(result);
    } else if (action === "build_cached_alert_options") {
      return await handleBuildCachedAlertOptions(req, res, sheets);
    } else if (action === "get_alerts") {
      return await handleGetAlerts(req, res);
    } else if (action === "bust_cache") {
      return await handleBustCache(req, res, sheets);
    } else if (action === "analyze_alert_ai") {
      req.body.action = "analyze_alert";
      req.body.forceAI = true;
      return await handleAnalyzeAlert(req, res, sheets);
    } else if (action === "analyze_alert") {
      return await handleAnalyzeAlert(req, res, sheets);
    } else if (action === "accept_option") {
      return await handleAcceptOption(req, res, sheets);
    } else if (action === "delete_job") {
      return await handleDeleteJob(req, res, sheets);
    } else if (action === "analyze_noaction_flag") {
      return await handleAnalyzeNoActionFlag(req, res, sheets);
    } else if (action === "remove_alert") {
      return await handleRemoveAlert(req, res);
    } else if (action === "ignore_alert") {
      return await handleIgnoreAlert(req, res, sheets);
    } else if (action === "unignore_alert") {
      return await handleUnignoreAlert(req, res, sheets);
    } else if (action === "get_ignored_alerts") {
      return await handleGetIgnoredAlerts(req, res, sheets);
    } else if (action === "get_proactive_alerts") {
      return await handleGetProactiveAlerts(req, res, sheets);
    } else if (action === "rehash_ignored_alerts") {
      return await handleRehashIgnoredAlerts(req, res, sheets);
    } else if (action === "update_session_flags") {
      return await handleUpdateSessionFlags(req, res);
    } else if (action === "resolve_noaction_flag") {
      return await handleResolveNoActionFlag(req, res, sheets);
    } else if (action === "bulk_resolve_noaction_flags") {
      return await handleBulkResolveNoActionFlags(req, res, sheets);
    } else if (action === "record_decision") {
      return await handleRecordDecision(req, res, sheets);
    } else if (action === "bulk_ignore_alerts") {
      return await handleBulkIgnoreAlerts(req, res, sheets);
    } else if (action === "acknowledge_proactive_alert") {
      return await handleAcknowledgeProactiveAlert(req, res, sheets);
    } else if (action === "bulk_acknowledge_proactive_alerts") {
      return await handleBulkAcknowledgeProactiveAlerts(req, res, sheets);
    } else if (action === "resolve_proactive_alert") {
      return await handleResolveProactiveAlert(req, res, sheets);
    } else if (action === "update_part_paid_date") {
      const {
        clientName, clientSheetId, masterSheetId, itemType,
        rowNumber, slot, sendDate, cellCoord, appId, newDate
      } = req.body;
      const userEmail = sessionUser?.email || "user";
      const result = await handleUpdatePartPaidDate(sheets, {
        clientName, clientSheetId, masterSheetId, itemType,
        rowNumber, slot, sendDate, cellCoord, appId, newDate, userEmail
      });
      return res.status(200).json(result);
    } else if (action === "bulk_create_tasks") {
      return await handleBulkCreateTasks(req, res, sheets);
    } else if (action === "create_task") {
      return await handleCreateTask(req, res, sheets);
    } else if (action === "get_tasks") {
      return await handleGetTasks(req, res, sheets);
    } else if (action === "add_task_note") {
      return await handleAddTaskNote(req, res, sheets);
    } else if (action === "snooze_task") {
      return await handleSnoozeTask(req, res, sheets);
    } else if (action === "revert_task_to_alert") {
      return await handleRevertTaskToAlert(req, res, sheets);
    } else if (action === "resolve_task") {
      return await handleResolveTask(req, res, sheets);
    } else if (action === "update_task") {
      return await handleUpdateTask(req, res, sheets);
    } else if (action === "check_existing_task") {
      return await handleCheckExistingTask(req, res, sheets);
    } else if (action === "upload_payroll_chunk") {
      return await handleUploadPayrollChunk(req, res);
    } else if (action === "identify_payroll_client") {
      return await handleIdentifyPayrollClient(req, res, sheets);
    } else if (action === "identify_time_client") {
      return await handleIdentifyTimeClient(req, res, sheets);
    } else if (action === "process_payroll_document") {
      return await handleProcessPayrollDocument(req, res, sheets);
    } else if (action === "process_time_document") {
      return await handleProcessTimeDocument(req, res, sheets);
    } else if (action === "eom_get_templates") {
      return await handleEomGetTemplates(req, res, sheets);
    } else if (action === "eom_get_excluded_clients") {
      return await handleEomGetExcludedClients(req, res, sheets);
    } else if (action === "eom_toggle_client_excluded") {
      return await handleEomToggleClientExcluded(req, res, sheets);
    } else if (action === "eom_reorder_clients") {
      return await handleEomReorderClients(req, res, sheets);
    } else if (action === "eom_save_template") {
      return await handleEomSaveTemplate(req, res, sheets);
    } else if (action === "eom_get_client_tasks") {
      return await handleEomGetClientTasks(req, res, sheets);
    } else if (action === "eom_get_client_detail") {
      return await handleEomGetClientDetail(req, res, sheets);
    } else if (action === "eom_save_client_task") {
      return await handleEomSaveClientTask(req, res, sheets);
    } else if (action === "eom_get_month_status") {
      return await handleEomGetMonthStatus(req, res, sheets);
    } else if (action === "eom_update_task_status") {
      return await handleEomUpdateTaskStatus(req, res, sheets);
    } else if (action === "eom_update_task_status_batch") {
      return await handleEomUpdateTaskStatusBatch(req, res, sheets);
    } else if (action === "eom_update_task_notelet") {
      return await handleEomUpdateTaskNotelet(req, res, sheets);
    } else if (action === "eom_reorder_tasks") {
      return await handleEomReorderTasks(req, res, sheets);
    } else if (action === "eom_reorder_templates") {
      return await handleEomReorderTemplates(req, res, sheets);
    } else if (action === "eom_load_bank_accounts") {
      return await handleEomLoadBankAccounts(req, res, sheets);
    } else if (action === "eom_get_bank_accounts") {
      return await handleEomGetBankAccounts(req, res, sheets);
    } else if (action === "eom_get_cash_balance_progress") {
      return await handleEomGetCashBalanceProgress(req, res, sheets);
    } else if (action === "eom_save_cash_balance") {
      return await handleEomSaveCashBalance(req, res, sheets);
    } else if (action === "eom_create_dashboard_backup") {
      return await handleEomCreateDashboardBackup(req, res, sheets);
    } else if (action === "eom_mark_month_actual") {
      return await handleEomMarkMonthActual(req, res, sheets);
    } else if (action === "eom_mark_nb_exclude") {
      return await handleEomMarkNbExclude(req, res, sheets);
    } else if (action === "eom_seed_from_checklist") {
      return await handleEomSeedFromChecklist(req, res, sheets);
    } else if (action === "eom_get_plcomp_data") {
      return await handleEomGetPlCompData(req, res, sheets);
    } else if (action === "eom_pull_fresh_pl") {
      return await handleEomPullFreshPl(req, res, sheets);
    } else if (action === "eom_push_outgoings") {
      return await handleEomPushOutgoings(req, res, sheets);
    } else if (action === "eom_get_default_tasks") {
      return await handleEomGetDefaultTasks(req, res, sheets);
    } else if (action === "eom_save_default_task") {
      return await handleEomSaveDefaultTask(req, res, sheets);
    } else if (action === "eom_delete_default_task") {
      return await handleEomDeleteDefaultTask(req, res, sheets);
    } else if (action === "eom_reorder_default_tasks") {
      return await handleEomReorderDefaultTasks(req, res, sheets);
    } else if (action === "eom_seed_default_tasks") {
      return await handleEomSeedDefaultTasksFromTemplates(req, res, sheets);
    } else if (action === "eom_apply_default_tasks") {
      return await handleEomApplyDefaultTasks(req, res, sheets);
    } else if (action === "eom_get_reporting_data") {
      return await handleEomGetReportingData(req, res, sheets);
    } else if (action === "eom_save_reporting_config") {
      return await handleEomSaveReportingConfig(req, res, sheets);
    } else if (action === "eom_run_reporting_action") {
      return await handleEomRunReportingAction(req, res, sheets);
    } else if (action === "eom_test_reporting_webapp") {
      return await handleEomTestReportingWebApp(req, res);
    } else if (action === "eom_save_chart_ref") {
      return await handleEomSaveChartRef(req, res, sheets);
    } else if (action === "eom_delete_chart_ref") {
      return await handleEomDeleteChartRef(req, res, sheets);
    } else if (action === "eom_get_overhead_expenses") {
      return await handleEomGetOverheadExpenses(req, res, sheets);
    } else if (action === "eom_preview_overhead_expenses") {
      return await handleEomPreviewOverheadExpenses(req, res, sheets);
    } else if (action === "eom_add_zero_budget_category") {
      return await handleEomAddZeroBudgetCategory(req, res, sheets);
    } else if (action === "eom_confirm_overhead_expenses") {
      return await handleEomConfirmOverheadExpenses(req, res, sheets);

    } else if (action === "get_flag_sweep_log") {
      const runs = await readFlagSweepLog(sheets, req.body.automationCommanderSheetId);
      return res.status(200).json({ success: true, runs });
    } else if (action === "get_precompute_log") {
      const runs = await readPrecomputeLog(sheets, req.body.automationCommanderSheetId);
      return res.status(200).json({ success: true, runs });
    } else if (action === "get_build_options_log") {
      const runs = await readBuildOptionsLog(sheets, req.body.automationCommanderSheetId);
      return res.status(200).json({ success: true, runs });
    } else if (action === "get_security_audit_log") {
      if (!sessionUser || !sessionUser.isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin privileges required" });
      }
      const logs = await fetchSecurityAuditLogs(sheets, req.body.automationCommanderSheetId);
      return res.status(200).json({ success: true, logs });

    } else {
      res.status(400).json({ error: "Invalid action" });
    }
  } catch (error) {
    console.error("Triage API error:", error);
    const sessionUser = getSessionUser(req, res);
    installSheetIdBoundary(req, res, sessionUser);
    const safeMsg = sessionUser?.isAdmin ? error.message : sanitizeSpreadsheetTerms(error.message || "Internal server error");
    res.status(500).json({
      success: false,
      error: safeMsg,
    });
  }
}

