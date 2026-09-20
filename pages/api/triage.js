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

import { redisClient } from "../../services/redisClient";
import { getSheetsClient } from "../../services/sheetsClient";
import { 
  readFlagSweepLog, 
  readPrecomputeLog, 
  readBuildOptionsLog 
} from "../../services/systemLogs";
import {
  handleBulkCreateTasks, handleCreateTask, handleGetTasks, handleAddTaskNote,
  handleSnoozeTask, handleRevertTaskToAlert, handleResolveTask, handleUpdateTask,
  handleCheckExistingTask
} from "../../services/tasksController";
import {
  handleGetClaudeSettings, handleSaveClaudeSettings, handleCheckClaudeBudget,
  handleLogClaudeUsage, handleGetAppLog, handleTriggerProactiveChecks,
  handleGetSweepSchedule, handleSaveSweepFrequency, handleTriggerAgentRun,
  handleAgentProgress, handleGetAgentRunProgress
} from "../../services/systemConfig";
import {
  handleGetAllClients, handleGetAssignedExpenses, handleMarkExpenseAssigned,
  handlePruneAssignedExpenses, handleGetOutgoingsInbox, handleGetInvoicesInbox,
  handleCreateOutgoingsVendor, handleGetOutgoings, handleGetDirectCostsJobs,
  handleGetInvoiceJobs, handleGetAllClientJobs, handleUpdateJobField,
  handleAssignExpenseToJob, handleUpdateExpenseSlot, handleAssignInvoiceToJob,
  handleUpdateInvoiceSlot, handleCreateJobFromInvoice, handleUpdateOutgoingNote,
  handleFireOutgoingsPull, handleMarkPipelineCopied
} from "../../services/workspaces";
import {
  handleGetRetainerJobs, handleRenameRetainerJob, handleChangeRetainerEndDate,
  handleChangeRetainerMonthlyAmount, handleCreateRetainerJob, handleTidyUpRetainers,
  handleComputeRetainerAlertResolution, handleComputeRetainerSplitInvoicePreview,
  handleApplyRetainerSplitInvoice
} from "../../services/retainers";
import {
  handleEomGetTemplates, handleEomGetExcludedClients, handleEomToggleClientExcluded,
  handleEomReorderClients, handleEomSaveTemplate, handleEomGetClientTasks,
  handleEomGetClientDetail, handleEomSaveClientTask, handleEomGetMonthStatus,
  handleEomUpdateTaskStatus, handleEomUpdateTaskStatusBatch, handleEomUpdateTaskNotelet,
  handleEomReorderTasks, handleEomReorderTemplates, handleEomLoadBankAccounts,
  handleEomGetBankAccounts, handleEomGetCashBalanceProgress, handleEomSaveCashBalance,
  handleEomCreateDashboardBackup, handleEomMarkMonthActual, handleEomSeedFromChecklist
} from "../../services/eomTools";
import {
  handleUploadPayrollChunk, handleIdentifyPayrollClient, handleIdentifyTimeClient,
  handleProcessPayrollDocument, handleProcessTimeDocument
} from "../../services/importTools";
import {
  handleBustCache, handleGetAlerts, handleRemoveAlert, handleUpdateSessionFlags,
  handleResolveNoActionFlag, handleRecordDecision, handleBulkIgnoreAlerts,
  handleAcknowledgeProactiveAlert, handleResolveProactiveAlert, handleBulkAcknowledgeProactiveAlerts
} from "../../services/alertState";
import {
  handleDebugCompareTriage, handleDebugTriageState, handleCleanupAlertMemory,
  handleRehashAlertMemory, handleGetPrecomputed, handleStorePrecomputed,
  handleRunFlagSweep, handleBuildCachedAlertOptions, handleAnalyzeAlert,
  handleAcceptOption, handleDeleteJob, handleAnalyzeNoActionFlag
} from "../../services/triageEngine";

// eomTabsVerified moved to eomTools.js

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================
// FLAG_COLUMNS/NO_ACTION_FLAGS retired 24 Aug 2026 — both were only used by
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

// Increase body size limit — store_precomputed sends the full alert list
export const config = {
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
  // Set CORS headers
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://project-shj9n.vercel.app"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    // Handle both POST (req.body) and GET (req.query) requests
    const action = req.method === "GET" ? req.query.action : req.body.action;
    const automationCommanderSheetId = req.body.automationCommanderSheetId;
    const sheets = await getSheetsClient();

    console.log(`\n📍 API Request: method=${req.method}, action=${action}, bodyKeys=${Object.keys(req.body || {}).join(",")}, bodySize=${JSON.stringify(req.body || {}).length}`);

    if (action === "emergency_flush_redis") {
          // Temporary endpoint to clear OOM errors
          await redisClient.flushDb();
          return res.status(200).json({ success: true, message: "Redis database flushed successfully. You can now use the app normally." });
          
        } else if (action === "verify_pin") {
          const { pin } = req.body;
          const expectedPin = process.env.APP_ACCESS_PIN;
          
          // Failsafe: If no PIN is configured in Vercel, allow access so you don't get locked out
          if (!expectedPin) {
            return res.status(200).json({ success: true, token: "pulse_auth_unlocked" });
          }
          
          if (pin === expectedPin) {
            // High-entropy token stored locally
            const token = `pulse_auth_${Date.now()}_${Math.random().toString(36).substring(2)}`;
            return res.status(200).json({ success: true, token });
          } else {
            return res.status(401).json({ success: false, error: "Incorrect PIN" });
          }

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
    } else if (action === "get_direct_costs_jobs") {
      return await handleGetDirectCostsJobs(req, res, sheets);
    } else if (action === "get_invoice_jobs") {
      return await handleGetInvoiceJobs(req, res, sheets);
    } else if (action === "get_all_client_jobs") {
      return await handleGetAllClientJobs(req, res, sheets);
    } else if (action === "update_job_field") {
      return await handleUpdateJobField(req, res, sheets);
    } else if (action === "mark_pipeline_copied") {
      return await handleMarkPipelineCopied(req, res, sheets);
    } else if (action === "get_retainer_jobs") {
      return await handleGetRetainerJobs(req, res, sheets);
    } else if (action === "rename_retainer_job") {
      return await handleRenameRetainerJob(req, res, sheets);
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

    } else if (action === "update_outgoing_note") {
      return await handleUpdateOutgoingNote(req, res, sheets);
    } else if (action === "get_claude_settings") {
      return await handleGetClaudeSettings(req, res, sheets);
    } else if (action === "save_claude_settings") {
      return await handleSaveClaudeSettings(req, res, sheets);
    } else if (action === "check_claude_budget") {
      return await handleCheckClaudeBudget(req, res, sheets);
    } else if (action === "log_claude_usage") {
      return await handleLogClaudeUsage(req, res, sheets);
    } else if (action === "get_app_log") {
      return await handleGetAppLog(req, res, sheets);

    } else if (action === "start_triage") {
      // Proxy orchestrator for frontend chunking. Protects CRON_SECRET.
      try {
        const { step } = req.body;
        const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
          ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
          : process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : "http://localhost:3000";
        const cronSecret = process.env.CRON_SECRET;

        // Step 1: Sweep
        if (step === "sweep") {
          console.log(`🔄 start_triage (sweep): running fresh detection pass from index ${req.body.startIdx || 0}...`);
          const sweepResp = await fetch(`${baseUrl}/api/triage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "run_flag_sweep", secret: cronSecret, automationCommanderSheetId, startIdx: req.body.startIdx || 0, forceProactive: req.body.forceProactive, forceAll: true }),
          });
          const sweepData = await sweepResp.json();
          return res.status(200).json({ success: true, hasMore: sweepData.hasMore, nextIdx: sweepData.nextIdx });
        }

        // Step 2: Build Options (Can be looped by frontend)
        if (step === "build") {
          console.log(`🔄 start_triage (build): building options...`);
          const buildResp = await fetch(`${baseUrl}/api/triage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "build_cached_alert_options", secret: cronSecret, automationCommanderSheetId, isContinuation: req.body.isContinuation }),
          });
          const buildData = await buildResp.json();
          return res.status(200).json({ success: true, hasMore: buildData.hasMore });
        }

        // Step 3: Store and Generate Session
        if (step === "store") {
          console.log(`🔄 start_triage (store): rebuilding precomputed cache...`);
          let existingNoActionAnalysis = {};
          try {
            const existingRaw = await redisClient.get(PRECOMPUTED_KEY);
            if (existingRaw) existingNoActionAnalysis = JSON.parse(existingRaw).noActionAnalysisResults || {};
          } catch (e) { /* fine to proceed with {} */ }

          const storeResp = await fetch(`${baseUrl}/api/triage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "store_precomputed", secret: cronSecret, automationCommanderSheetId,
              noActionAnalysisResults: existingNoActionAnalysis,
            }),
          });
          if (!storeResp.ok) throw new Error(`store_precomputed failed (${storeResp.status})`);

          const freshRaw = await redisClient.get(PRECOMPUTED_KEY);
          if (!freshRaw) return res.status(500).json({ success: false, error: "No precomputed data was found afterwards" });
          const fresh = JSON.parse(freshRaw);

          const alertCountsByClientAndFlag = {};
          const activeExpenseIdsByClient = {};
          const activeInvoiceIdsByClient = {};
          for (const alert of (fresh.alerts || [])) {
            const key = alert.clientName;
            let flagKey = alert.flagType || alert.alertType || alert.type;
            
            // Upgrade legacy database labels
            if (flagKey === "invoice") flagKey = "invoiceDashboardDiscr";
            if (flagKey === "expense") flagKey = "expenseDashboardDiscr";
            if (flagKey === "crm") flagKey = alert.flagType || alert.alertType || "crmPipeAppDiscr";

            // CRITICAL FIX: Actually apply the upgraded label to the alert object!
            alert.flagType = flagKey;
            alert.alertType = flagKey;

            if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
            alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;
            
            if (flagKey === "expenseDashboardDiscr") {
             const txId = alert.summary?.transactionId || alert.summary?.appId;
             if (txId) {
                if (!activeExpenseIdsByClient[key]) activeExpenseIdsByClient[key] = [];
                activeExpenseIdsByClient[key].push(txId);
             }
          }
            if (flagKey === "invoiceDashboardDiscr") {
             const invNo = alert.summary?.invoiceNo;
             if (invNo) {
                if (!activeInvoiceIdsByClient[key]) activeInvoiceIdsByClient[key] = [];
                activeInvoiceIdsByClient[key].push(invNo);
             }
          }
        }

        // Tally counts for informational (noAction) alerts
        for (const alert of (fresh.noActionAlerts || [])) {
          const key = alert.clientName;
          const flagKey = alert.flagType;
          if (key && flagKey) {
            if (!alertCountsByClientAndFlag[key]) alertCountsByClientAndFlag[key] = {};
            alertCountsByClientAndFlag[key][flagKey] = (alertCountsByClientAndFlag[key][flagKey] || 0) + 1;
          }
        }

        const clientsWithUpdatedCounts = (fresh.clientsWithFlags || []).map(c => ({
            ...c, alertCounts: alertCountsByClientAndFlag[c.clientName] || {},
            activeExpenseIds: activeExpenseIdsByClient[c.clientName] || [],
            activeInvoiceIds: activeInvoiceIdsByClient[c.clientName] || [],
          }));

          const sessionId = Math.random().toString(36).substring(2, 15);
          await redisClient.set(
            `triage_alerts:${sessionId}`,
            JSON.stringify({ alerts: fresh.alerts || [], noActionAlerts: fresh.noActionAlerts || [], proactiveAlerts: fresh.proactiveAlerts || [], clientsWithFlags: clientsWithUpdatedCounts }),
            { EX: 3600 } // Reduced from 24h to 1h to prevent Redis OOM
          );

          console.log(`✅ start_triage: refresh complete`);
          return res.status(200).json({
            success: true, sessionId, totalAlerts: (fresh.alerts || []).length,
            noActionCount: (fresh.noActionAlerts || []).length, proactiveAlerts: fresh.proactiveAlerts || [], clientsWithFlags: clientsWithUpdatedCounts,
          });
        }

        return res.status(400).json({ success: false, error: "Invalid step parameter" });
      } catch (err) {
        console.error("❌ start_triage error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }

    } else if (action === "fire_outgoings_pull") {
      return await handleFireOutgoingsPull(req, res, sheets);
    } else if (action === "trigger_proactive_checks") {
      return await handleTriggerProactiveChecks(req, res);
    } else if (action === "get_sweep_schedule") {
      return await handleGetSweepSchedule(req, res, sheets);
    } else if (action === "save_sweep_frequency") {
      return await handleSaveSweepFrequency(req, res, sheets);
    } else if (action === "trigger_agent_run") {
      return await handleTriggerAgentRun(req, res, sheets);
    } else if (action === "agent_progress") {
      return await handleAgentProgress(req, res);
    } else if (action === "get_agent_run_progress") {
      return await handleGetAgentRunProgress(req, res);

    } else if (action === "debug_compare_triage") {
      return await handleDebugCompareTriage(req, res, sheets);
    } else if (action === "debug_triage_state") {
      return await handleDebugTriageState(req, res, sheets);
    } else if (action === "cleanup_alert_memory") {
      return await handleCleanupAlertMemory(req, res, sheets);
    } else if (action === "rehash_alert_memory") {
      return await handleRehashAlertMemory(req, res, sheets);
    } else if (action === "get_precomputed") {
      return await handleGetPrecomputed(req, res, sheets);
    } else if (action === "store_precomputed") {
      return await handleStorePrecomputed(req, res, sheets);
    } else if (action === "run_flag_sweep") {
      return await handleRunFlagSweep(req, res, sheets);
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
    } else if (action === "update_session_flags") {
      return await handleUpdateSessionFlags(req, res);
    } else if (action === "resolve_noaction_flag") {
      return await handleResolveNoActionFlag(req, res, sheets);
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
    } else if (action === "eom_seed_from_checklist") {
      return await handleEomSeedFromChecklist(req, res, sheets);

    } else if (action === "get_flag_sweep_log") {
      const runs = await readFlagSweepLog(sheets, req.body.automationCommanderSheetId);
      return res.status(200).json({ success: true, runs });
    } else if (action === "get_precompute_log") {
      const runs = await readPrecomputeLog(sheets, req.body.automationCommanderSheetId);
      return res.status(200).json({ success: true, runs });
    } else if (action === "get_build_options_log") {
      const runs = await readBuildOptionsLog(sheets, req.body.automationCommanderSheetId);
      return res.status(200).json({ success: true, runs });

    } else {
      res.status(400).json({ error: "Invalid action" });
    }
  } catch (error) {
    console.error("Triage API error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

