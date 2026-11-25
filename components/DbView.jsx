import React, { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Spinner from "./Spinner";
import DeferredSearchInput from "./DeferredSearchInput";
import {
  prefetchComparisonTab,
  invalidateComparisonModalCache,
  prefetchClientSheetTab,
  invalidateClientSheetModalCache,
  prefetchReconSheetTab,
  invalidateReconSheetModalCache,
  prefetchTimeCompTab,
  invalidateTimeCompModalCache,
} from "../utils/sheetModalCache";
import { CLIENT_SHEET_TABS, CLIENT_SHEET_SPECS } from "../utils/clientSheetSpecs";
import { sortReconMonthTabsDescending } from "../utils/reconSheetSpecs";
import SupabaseBackupManagerPanel from "./SupabaseBackupManagerPanel";

const AdminWorkbookInspectorModal = dynamic(() => import("./AdminWorkbookInspectorModal"), { ssr: false });
const MasterComparisonSheetModal = dynamic(() => import("./MasterComparisonSheetModal"), { ssr: false });
const ClientSheetModal = dynamic(() => import("./ClientSheetModal"), { ssr: false });
const ReconSheetModal = dynamic(() => import("./ReconSheetModal"), { ssr: false });
const TimeCompSheetModal = dynamic(() => import("./TimeCompSheetModal"), { ssr: false });

const SYNC_BUTTONS = [
  { type: "recompute", label: "Recompute comparisons" },
  { type: "invoice", label: "Run invoice sync" },
  { type: "expense", label: "Run expense sync" },
  { type: "crm", label: "Run CRM sync" },
  { type: "all", label: "Run full sync" },
];

const AMD_BUTTONS = [
  { amdAction: "pull_invoices", label: "Pull invoices" },
  { amdAction: "pull_expenses", label: "Pull expenses" },
  { amdAction: "pull_crm", label: "Pull CRM" },
  { amdAction: "pull_pl", label: "Pull P&L" },
  { amdAction: "expenses_gap_check", label: "Run expenses gap check" },
  { amdAction: "invoices_gap_check", label: "Run invoices gap check" },
  { amdAction: "retainer_fix", label: "Run retainer fix" },
  { amdAction: "pull_outgoings_notes", label: "Pull outgoings notes" },
];

const CLOCK_SCHEDULE_OPTIONS = [
  { value: "* * * * *", label: "Every 1 min" },
  { value: "*/2 * * * *", label: "Every 2 mins" },
  { value: "*/5 * * * *", label: "Every 5 mins" },
  { value: "*/10 * * * *", label: "Every 10 mins" },
  { value: "*/15 * * * *", label: "Every 15 mins" },
  { value: "*/30 * * * *", label: "Every 30 mins" },
];

function formatCronScheduleLabel(schedule) {
  const s = String(schedule || "").trim();
  if (s === "* * * * *" || s === "*/1 * * * *") {
    return { adjective: "1-minute", interval: "every 1 min" };
  }
  const everyMins = s.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyMins) {
    const n = Number(everyMins[1]);
    return { adjective: `${n}-minute`, interval: `every ${n} min${n === 1 ? "" : "s"}` };
  }
  const everyHours = s.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (everyHours) {
    const n = Number(everyHours[1]);
    return { adjective: `${n}-hour`, interval: `every ${n} hour${n === 1 ? "" : "s"}` };
  }
  if (s) {
    return { adjective: "scheduled", interval: s };
  }
  return { adjective: "10-minute", interval: "every 10 mins" };
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatParityValue(val) {
  if (val === "" || val === null || val === undefined) return "blank";
  if (typeof val === "number" && Number.isFinite(val)) {
    const sign = val < 0 ? "-" : "";
    const abs = Math.abs(val);
    return `${sign}£${abs.toLocaleString("en-GB", {
      minimumFractionDigits: Number.isInteger(abs) ? 0 : 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return String(val);
}

const cardStyle = {
  background: "#ffffff",
  borderRadius: "10px",
  padding: "18px 20px",
  marginBottom: "16px",
  boxShadow: "0 1px 4px rgba(15, 23, 42, 0.05)",
  border: "1px solid #e2e8f0",
};

const actionBtnBase = {
  padding: "7px 12px",
  fontSize: "12px",
  fontWeight: 600,
  borderRadius: "6px",
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#1e293b",
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  transition: "all 0.12s ease",
};

export default function DbView({
  automationCommanderSheetId,
  isAdmin = false,
  user,
  managedClient = null,
  initialClientName = "",
  onSelectClient,
}) {
  const effectiveIsAdmin = !user?.isReadOnly && Boolean(isAdmin || user?.isAdmin || user?.role === "Admin");

  const [selectedClient, setSelectedClient] = useState(() => {
    if (managedClient?.clientName) return String(managedClient.clientName).trim();
    if (initialClientName) return String(initialClientName).trim();
    return "APPTEST";
  });
  const [overviewClientFilter, setOverviewClientFilter] = useState("active_migrated");
  const [stage2Data, setStage2Data] = useState(null);
  const [stage2Loading, setStage2Loading] = useState(true);
  const [parityReport, setParityReport] = useState(null);
  const [relationalParityReport, setRelationalParityReport] = useState(null);
  const [copied0012Sql, setCopied0012Sql] = useState(false);

  // Live operation progress & feedback state
  const [activeOp, setActiveOp] = useState(null); // { key, label, startedAt }
  const [elapsedMs, setElapsedMs] = useState(0);
  const [feedbackMsg, setFeedbackMsg] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const toastTimerRef = useRef(null);

  // Alert memory & tools panel state
  const [showAlertMemoryTool, setShowAlertMemoryTool] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [amQuery, setAmQuery] = useState("");
  const [amStatusFilter, setAmStatusFilter] = useState("handled_only");
  const [amEntries, setAmEntries] = useState([]);
  const [amLoading, setAmLoading] = useState(false);
  const [amDeletingHash, setAmDeletingHash] = useState("");
  const [amManualHash, setAmManualHash] = useState("");
  const [amFlushing, setAmFlushing] = useState(false);

  // Inspector & Formatted Comparison / Client Sheet modals
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorInitialRole, setInspectorInitialRole] = useState("master");
  const [comparisonModalOpen, setComparisonModalOpen] = useState(false);
  const [comparisonModalTab, setComparisonModalTab] = useState("InvComp");
  const [clientSheetModalOpen, setClientSheetModalOpen] = useState(false);
  const [clientSheetModalTab, setClientSheetModalTab] = useState("Confirmed");
  const [reconModalOpen, setReconModalOpen] = useState(false);
  const [timeCompModalOpen, setTimeCompModalOpen] = useState(false);

  // Elapsed timer tick while an async operation is running
  useEffect(() => {
    if (!activeOp?.startedAt) {
      setElapsedMs(0);
      return;
    }
    setElapsedMs(Date.now() - activeOp.startedAt);
    const id = setInterval(() => {
      setElapsedMs(Date.now() - activeOp.startedAt);
    }, 200);
    return () => clearInterval(id);
  }, [activeOp]);

  const showToast = useCallback((toast) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMsg(toast);
    toastTimerRef.current = setTimeout(() => {
      setToastMsg(null);
    }, 6500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const loadStage2Status = useCallback(
    async (targetClient, { silent = false } = {}) => {
      const clientToLoad = targetClient || selectedClient || "APPTEST";
      setStage2Loading(true);
      try {
        const res = await fetch("/api/pma/master-engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "status", clientName: clientToLoad, automationCommanderSheetId }),
        });
        const data = await res.json();
        if (data.success) {
          setStage2Data(data);
        } else if (!silent) {
          setFeedbackMsg({ type: "error", text: data.error || "Could not load Supabase engine status." });
        }
      } catch (err) {
        if (!silent) {
          setFeedbackMsg({ type: "error", text: err.message });
        }
      } finally {
        setStage2Loading(false);
      }
    },
    [automationCommanderSheetId, selectedClient]
  );

  const handleSelectClient = useCallback(
    (clientName) => {
      const clean = String(clientName || "APPTEST").trim();
      setSelectedClient(clean);
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem("pma_stage2_selected_client", clean);
        }
      } catch (_) { }
      onSelectClient?.(clean);
      loadStage2Status(clean);
    },
    [loadStage2Status, onSelectClient]
  );

  // Initial load on mount
  useEffect(() => {
    if (!effectiveIsAdmin) return;
    let initial = managedClient?.clientName || initialClientName || "";
    if (!initial) {
      try {
        if (typeof window !== "undefined") {
          initial = window.localStorage.getItem("pma_stage2_selected_client") || "";
        }
      } catch (_) { }
    }
    const clean = (initial || "APPTEST").trim();
    setSelectedClient(clean);
    loadStage2Status(clean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveIsAdmin]);

  // Keep synced when managedClient or deep-linked client changes
  useEffect(() => {
    if (!effectiveIsAdmin) return;
    const ext = String(managedClient?.clientName || "").trim();
    if (ext && ext.toUpperCase() !== String(selectedClient || "").trim().toUpperCase()) {
      setSelectedClient(ext);
      loadStage2Status(ext);
    }
  }, [effectiveIsAdmin, managedClient?.clientName, selectedClient, loadStage2Status]);

  const runTrackedOperation = async (key, label, fn) => {
    const startedAt = Date.now();
    setActiveOp({ key, label, startedAt });
    setFeedbackMsg(null);
    try {
      const result = await fn();
      if (key !== "refresh") {
        invalidateComparisonModalCache(selectedClient);
        invalidateClientSheetModalCache(selectedClient);
        invalidateReconSheetModalCache(selectedClient);
        invalidateTimeCompModalCache(selectedClient);
      }
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (result && result.text) {
        const msg = {
          type: result.type || "success",
          text: result.text,
          uiAlerts: Array.isArray(result.uiAlerts) ? result.uiAlerts : [],
          durationSec: secs,
        };
        setFeedbackMsg(msg);
        showToast({ type: msg.type, text: `${msg.text} (${secs}s)` });
      }
      return result;
    } catch (err) {
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      const errMsg = {
        type: "error",
        text: err.message || "Operation failed.",
        durationSec: secs,
      };
      setFeedbackMsg(errMsg);
      showToast({ type: "error", text: errMsg.text });
      return null;
    } finally {
      setActiveOp(null);
    }
  };

  const handleRefresh = () => {
    runTrackedOperation("refresh", `Refreshing Supabase engine status for ${selectedClient}...`, async () => {
      await loadStage2Status(selectedClient, { silent: false });
      return {
        type: "success",
        text: `Refreshed engine status for ${selectedClient}.`,
      };
    });
  };

  const handleMigrateClient = (clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    runTrackedOperation("migrate", `Syncing ${targetClient} Master & Recon to Supabase...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "migrate_client",
          clientName: targetClient,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Client migration failed.");
      if (data.status) setStage2Data(data.status);
      const s = data.summary || {};
      return {
        type: "success",
        text: `Synced ${targetClient} Master (${s.masterTabsSynced || 0} master tabs, ${s.invoicesCount || 0} invoices, ${s.directCostsCount || 0} direct costs) & Recon (${s.reconTabsSynced || 0} recon tabs, ${s.reconItemsCount || 0} items) to Supabase.`,
      };
    });
  };

  const handleMaterialize = (restore = false, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    const opLabel = restore
      ? `Restoring IMPORTRANGE formulas on ${targetClient} Client Sheet...`
      : `Removing Master IMPORTRANGE links on ${targetClient} Client Sheet...`;
    runTrackedOperation(restore ? "restore_ir" : "materialize", opLabel, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: restore ? "restore_client_importranges" : "materialize_client_sheet",
          clientName: targetClient,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Operation failed.");
      if (data.status) setStage2Data(data.status);
      return {
        type: "success",
        text: restore
          ? `Restored ${data.restoredRangesCount || 0} original IMPORTRANGE formulas on ${targetClient} Client Sheet.`
          : `Removed ${data.materializedRangesCount || 0} Master IMPORTRANGE links on ${targetClient} Client Sheet (original formulas backed up in Supabase).`,
      };
    });
  };

  const handleSetMasterMode = (targetMode, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    const modeLabel = targetMode === "supabase" ? "Supabase engine" : "Google Sheets";
    runTrackedOperation(`master_mode_${targetMode}`, `Switching ${targetClient} Master & Recon engine to ${modeLabel}...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_master_mode",
          clientName: targetClient,
          masterMode: targetMode,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not switch master mode.");
      if (data.status) setStage2Data(data.status);
      return {
        type: "success",
        text: `Switched ${targetClient} Master & Recon engine to ${targetMode === "supabase" ? "Supabase engine" : "Google Sheets (legacy)"}.`,
      };
    });
  };

  const handleSeedClientSheet = (clientOverride, confirmOverwrite = false) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    if (
      confirmOverwrite &&
      typeof window !== "undefined" &&
      !window.confirm(
        `Push Google Sheet data to Supabase for ${targetClient}?\n\nThis will overwrite ${targetClient}'s Client data in Supabase with what is currently in the Google Sheet.`
      )
    ) {
      return;
    }
    runTrackedOperation("seed_client", `Pushing ${targetClient} Google Sheet data to Supabase...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "seed_client_sheet",
          clientName: targetClient,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Push from Google Sheet to Supabase failed.");
      if (data.status) setStage2Data(data.status);
      const s = data.summary || {};
      return {
        type: "success",
        text: `Pushed ${targetClient} Google Sheet data to Supabase (${s.clientTabsSynced || 0} client tabs, ${s.outgoingsNotesCount || 0} outgoings cell notes).`,
      };
    });
  };

  const handlePushSupabaseToSheet = (clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Push Supabase data to Google Sheet for ${targetClient}?\n\nThis will overwrite editable cells and notes on ${targetClient}'s Google Client Sheet to match Supabase (all Google Sheet formulas remain protected).`
      )
    ) {
      return;
    }
    runTrackedOperation("push_supabase_to_sheet", `Pushing ${targetClient} Supabase data to Google Sheet...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push_supabase_to_client_sheet",
          clientName: targetClient,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Push from Supabase to Google Sheet failed.");
      if (data.status) setStage2Data(data.status);
      const s = data.summary || {};
      return {
        type: "success",
        text: s.summary || `Pushed ${targetClient} Supabase data to Google Sheet (${s.updatedCellsCount || 0} cell(s)).`,
      };
    });
  };

  const handleSetClientMode = (targetMode, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    const modeLabel = targetMode === "supabase" ? "Supabase engine" : "Google Sheets";
    runTrackedOperation(`client_mode_${targetMode}`, `Switching ${targetClient} Client Portal engine to ${modeLabel}...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_client_mode",
          clientName: targetClient,
          clientMode: targetMode,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not switch client portal mode.");
      if (data.status) setStage2Data(data.status);
      return {
        type: "success",
        text: `Switched ${targetClient} Client Portal engine to ${targetMode === "supabase" ? "Supabase engine" : "Google Sheets (legacy)"}.`,
      };
    });
  };

  const handleSetSheetBridgeMode = (targetMode, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    const modeLabel = targetMode === "live" ? "Live sync" : targetMode === "dry_run" ? "Dry run" : "Off";
    runTrackedOperation(`bridge_mode_${targetMode}`, `Switching ${targetClient} Google Sheet bridge to ${modeLabel}...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_sheet_bridge_mode",
          clientName: targetClient,
          bridgeMode: targetMode,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not update Google Sheet bridge mode.");
      if (data.status) setStage2Data(data.status);
      return {
        type: "success",
        text: `Switched ${targetClient} Google Sheet bridge mode to ${modeLabel}.`,
      };
    });
  };

  const handleSheetBridgeSync = (direction, applyInDryRun = false, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    const action = direction === "inbound" ? "sync_sheet_bridge_inbound" : "sync_sheet_bridge_outbound";
    const opLabel =
      direction === "inbound"
        ? `Checking Google Sheet edits for ${targetClient}...`
        : `Checking outbound diff to Google Sheet for ${targetClient}...`;
    runTrackedOperation(`bridge_${direction}`, opLabel, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          clientName: targetClient,
          applyInDryRun,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Sheet bridge sync failed.");
      if (data.status) setStage2Data(data.status);
      const s = data.syncSummary || {};
      return {
        type: "success",
        text: s.summary || s.reason || `Completed ${direction} bridge check for ${targetClient}.`,
      };
    });
  };

  const handleVerifySheetParity = (allBridged = true) => {
    runTrackedOperation(
      "verify_bridge_parity",
      "Checking Dashboard & Cash parity across bridged clients...",
      async () => {
        const res = await fetch("/api/pma/master-engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "verify_sheet_bridge_parity",
            allBridged,
            clientName: activeClientName,
            automationCommanderSheetId,
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Parity verification failed.");
        const r = data.parityReport || {};
        setParityReport(r);
        return {
          type: (r.errorClientsCount || 0) > 0 || (r.mismatchClientsCount || 0) > 0 ? "info" : "success",
          text: `Checked ${r.clientsChecked || 0} bridged client(s): ${r.matchedClientsCount || 0} matched 100%, ${r.mismatchClientsCount || 0} with variance(s)${r.errorClientsCount ? `, ${r.errorClientsCount} error(s)` : ""}.`,
        };
      }
    );
  };

  const handleBackfillRelationalJobs = (allClients = false, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    runTrackedOperation(
      allClients ? "rel_jobs_backfill_all" : "rel_jobs_backfill_one",
      allClients
        ? "Backfilling relational jobs, invoices & retainers across all clients..."
        : `Backfilling relational jobs for ${targetClient}...`,
      async () => {
        const res = await fetch("/api/pma/master-engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "backfill_relational_jobs",
            allClients,
            clientName: targetClient,
            automationCommanderSheetId,
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Relational backfill failed.");
        if (data.status) setStage2Data(data.status);
        const s = data.summary || {};
        if (allClients) {
          return {
            type: s.errorCount > 0 ? "info" : "success",
            text: `Backfilled ${s.succeededCount || 0} of ${s.totalClients || 0} client(s) into relational jobs tables${s.errorCount ? ` (${s.errorCount} error(s))` : ""}.`,
          };
        }
        return {
          type: "success",
          text: `Backfilled ${targetClient}: ${s.confirmedJobsCount || 0} confirmed, ${s.pipelineJobsCount || 0} pipeline jobs (${s.invoicesCount || 0} invoices, ${s.expensesCount || 0} expenses).`,
        };
      }
    );
  };

  const handleVerifyRelationalParity = (allClients = true) => {
    runTrackedOperation(
      "rel_jobs_parity",
      "Verifying relational jobs round-trip & DB parity across clients...",
      async () => {
        const res = await fetch("/api/pma/master-engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "verify_relational_jobs_parity",
            allClients,
            clientName: activeClientName,
            automationCommanderSheetId,
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Relational parity check failed.");
        const r = data.parityReport || {};
        setRelationalParityReport(r);
        return {
          type: (r.errorClientsCount || 0) > 0 || (r.mismatchClientsCount || 0) > 0 ? "info" : "success",
          text: `Checked ${r.clientsChecked || 0} client(s): ${r.matchedClientsCount || 0} matched 100%, ${r.mismatchClientsCount || 0} mismatch(es).`,
        };
      }
    );
  };

  const handleSetClientJobsMode = (nextMode, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    runTrackedOperation(
      `set_jobs_mode_${nextMode}`,
      `Switching ${targetClient} jobs engine to ${nextMode === "relational" ? "relational SQL" : "virtual grid"}...`,
      async () => {
        const res = await fetch("/api/pma/master-engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "set_client_jobs_mode",
            clientName: targetClient,
            jobsMode: nextMode,
            automationCommanderSheetId,
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Could not update client jobs mode.");
        if (data.status) setStage2Data(data.status);
        return {
          type: "success",
          text: `Switched ${targetClient} jobs engine mode to ${nextMode}.`,
        };
      }
    );
  };

  const handleSetClientJobsReadMode = (nextMode, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    runTrackedOperation(
      `set_jobs_read_mode_${nextMode}`,
      `Switching ${targetClient} jobs reads to ${nextMode === "relational" ? "direct relational SQL" : "grid parser"}...`,
      async () => {
        const res = await fetch("/api/pma/master-engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "set_client_jobs_read_mode",
            clientName: targetClient,
            jobsReadMode: nextMode,
            automationCommanderSheetId,
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Could not update client jobs read mode.");
        if (data.status) setStage2Data(data.status);
        return {
          type: "success",
          text: `Switched ${targetClient} jobs read source to ${nextMode}.`,
        };
      }
    );
  };

  const handleVerifyRelationalReadParity = (allClients = true) => {
    runTrackedOperation(
      "rel_jobs_read_parity",
      "Verifying direct relational read payload parity across PMA & Portal...",
      async () => {
        const res = await fetch("/api/pma/master-engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "verify_relational_jobs_read_parity",
            allClients,
            clientName: activeClientName,
            automationCommanderSheetId,
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Read payload parity check failed.");
        const r = data.parityReport || {};
        return {
          type: (r.errorClientsCount || 0) > 0 || (r.mismatchClientsCount || 0) > 0 ? "info" : "success",
          text: `Read parity verified across ${r.clientsChecked || 0} client(s): ${r.matchedClientsCount || 0} matched 100%, ${r.mismatchClientsCount || 0} mismatch(es).`,
        };
      }
    );
  };

  const handleNativeSync = (syncType, label, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    runTrackedOperation(`sync_${syncType}`, `Running "${label}" on ${targetClient}...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run_native_sync",
          clientName: targetClient,
          syncType,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || `${label} failed.`);
      if (data.status) setStage2Data(data.status);
      const comp = data.syncResult?.comparisons || {};
      const alerts = data.syncResult?.uiAlerts || [];
      return {
        type: "success",
        text: `Completed "${label}" on ${targetClient}: ${comp.invDiscrepancyCount ?? 0} invoice flags, ${comp.dirDiscrepancyCount ?? 0} direct cost flags, ${comp.crmDiscrepancyCount ?? 0} CRM flags.`,
        uiAlerts: alerts,
      };
    });
  };

  const handleAmdAction = (amdAction, label, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    runTrackedOperation(`amd_${amdAction}`, `Running "${label}" on ${targetClient}...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run_amd_action",
          clientName: targetClient,
          amdAction,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || `${label} failed.`);
      if (data.status) setStage2Data(data.status);
      const r = data.amdResult || {};
      const comp = r.comparisons || {};
      const compNote =
        comp && (comp.invDiscrepancyCount !== undefined || comp.dirDiscrepancyCount !== undefined)
          ? ` — Flags: ${comp.invDiscrepancyCount ?? 0} inv, ${comp.dirDiscrepancyCount ?? 0} dir, ${comp.crmDiscrepancyCount ?? 0} CRM`
          : "";
      return {
        type: "success",
        text: `Completed "${label}" on ${targetClient}${compNote}.`,
        uiAlerts: Array.isArray(r.uiAlerts) ? r.uiAlerts : [],
      };
    });
  };

  const handleBackfillMirrors = (clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    runTrackedOperation("backfill_mirrors", `Backfilling SQL mirror tables for ${targetClient}...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "backfill_normalized_mirrors",
          clientName: targetClient,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Mirror backfill failed.");
      if (data.status) setStage2Data(data.status);
      const s = data.summary || {};
      return {
        type: "success",
        text: `Backfilled SQL mirror tables for ${targetClient} (${s.invoicesCount || 0} invoices, ${s.directCostsCount || 0} direct costs, ${s.reconPeriodsCount || 0} recon periods, ${s.clientTabsBackfilled || 0} client tab models).`,
      };
    });
  };

  const handleClearPausedMirrors = () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Clear stale historical rows from the 14 paused write-only SQL mirror tables across Supabase? Live workbook grids, client data, and alert memory are unaffected."
      )
    ) {
      return;
    }
    runTrackedOperation("clear_paused_mirrors", "Clearing paused SQL mirror tables...", async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clear_paused_mirrors",
          clientName: activeClientName,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not clear paused SQL mirror tables.");
      if (data.status) setStage2Data(data.status);
      const s = data.summary || {};
      return {
        type: "success",
        text: `Cleared ${Number(s.totalDeleted || 0).toLocaleString()} historical row(s) across the 14 paused SQL mirror tables.`,
      };
    });
  };

  const handleSetClockEnabled = (enabled) => {
    const schedLabel = formatCronScheduleLabel(stage2Data?.clockStatus?.schedule).adjective;
    runTrackedOperation(
      enabled ? "clock_enable" : "clock_pause",
      enabled ? `Enabling Supabase ${schedLabel} cron scheduler...` : `Pausing Supabase ${schedLabel} cron scheduler...`,
      async () => {
        const res = await fetch("/api/pma/master-engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "set_clock_enabled",
            enabled,
            automationCommanderSheetId,
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Could not update clock status.");
        if (data.status) setStage2Data(data.status);
        const updatedLabel = formatCronScheduleLabel(data?.status?.clockStatus?.schedule || stage2Data?.clockStatus?.schedule).adjective;
        return {
          type: "success",
          text: enabled
            ? `Supabase ${updatedLabel} cron scheduler enabled.`
            : `Supabase ${updatedLabel} cron scheduler paused.`,
        };
      }
    );
  };

  const handleSetClockSchedule = (newSchedule) => {
    const cleanSched = String(newSchedule || "").trim();
    if (!cleanSched) return;
    const schedLabel = formatCronScheduleLabel(cleanSched).adjective;
    runTrackedOperation("clock_schedule", `Updating Supabase cron scheduler to ${schedLabel}...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_clock_schedule",
          schedule: cleanSched,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not update cron schedule.");
      if (data.status) setStage2Data(data.status);
      const updatedLabel = formatCronScheduleLabel(data?.status?.clockStatus?.schedule || cleanSched).interval;
      return {
        type: "success",
        text: `Supabase cron scheduler updated to ${updatedLabel}.`,
      };
    });
  };

  const handleTriggerClockNow = () => {
    const schedLabel = formatCronScheduleLabel(stage2Data?.clockStatus?.schedule).adjective;
    runTrackedOperation("clock_trigger", `Triggering Supabase ${schedLabel} cron scheduler now...`, async () => {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "trigger_clock_now",
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not trigger scheduler.");
      if (data.status) setStage2Data(data.status);
      const tr = data.triggerResult || {};
      if (tr.success === false) {
        throw new Error(tr.error || "Scheduler trigger returned an error.");
      }
      const updatedLabel = formatCronScheduleLabel(data?.status?.clockStatus?.schedule || stage2Data?.clockStatus?.schedule).adjective;
      return {
        type: "success",
        text: `Triggered Supabase ${updatedLabel} cron scheduler (request #${tr.requestId ?? "ok"} -> ${tr.targetUrl || "/api/cron"}).`,
      };
    });
  };

  const handleSearchAlertMemory = useCallback(
    async (overrideQuery, overrideStatus) => {
      setAmLoading(true);
      try {
        const res = await fetch("/api/pma/control-plane", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "search_alert_memory",
            automationCommanderSheetId,
            query: overrideQuery !== undefined ? overrideQuery : amQuery,
            status: overrideStatus !== undefined ? overrideStatus : amStatusFilter,
            limit: 60,
          }),
        });
        const data = await res.json();
        if (data.success) {
          setAmEntries(data.entries || []);
        } else {
          setFeedbackMsg({ type: "error", text: data.error || "Could not search alert memory." });
        }
      } catch (err) {
        setFeedbackMsg({ type: "error", text: err.message });
      } finally {
        setAmLoading(false);
      }
    },
    [automationCommanderSheetId, amQuery, amStatusFilter]
  );

  const handleDeleteAlertMemory = async (fingerprintHash) => {
    const cleanHash = String(fingerprintHash || "").trim();
    if (!cleanHash) return;
    setAmDeletingHash(cleanHash);
    setFeedbackMsg(null);
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_alert_memory",
          automationCommanderSheetId,
          fingerprintHash: cleanHash,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setAmEntries((prev) => prev.filter((r) => r.fingerprintHash !== cleanHash));
        setAmManualHash("");
        setFeedbackMsg({
          type: "success",
          text: `Deleted alert memory entry "${cleanHash}" from Supabase, Google Sheet (${data.deletedSheetRows || 0} row${data.deletedSheetRows === 1 ? "" : "s"}), and Redis cache.`,
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Could not delete alert memory entry." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setAmDeletingHash("");
    }
  };

  const handleFlushAlertMemoryCache = async () => {
    setAmFlushing(true);
    setFeedbackMsg(null);
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "flush_alert_memory_cache",
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setFeedbackMsg({
          type: "success",
          text: "Cleared all Redis and in-memory alert caches. Fresh alert memory will now be read directly from Supabase.",
        });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setAmFlushing(false);
    }
  };

  if (!effectiveIsAdmin) return null;

  const isInitialLoading = stage2Loading && !stage2Data;
  const s2Ready = Boolean(stage2Data?.schemaReady);
  const allClients = stage2Data?.clients || [];
  const activeClientObj =
    allClients.find(
      (c) =>
        String(c.client_name || "").trim().toUpperCase() ===
        String(selectedClient || "").trim().toUpperCase()
    ) || null;
  const activeClientName = activeClientObj?.client_name || selectedClient || "APPTEST";
  const activeClientMode = activeClientObj?.master_mode || "sheet";
  const activeClientPortalMode = activeClientObj?.client_mode || "sheet";
  const activeSheetBridgeMode = activeClientObj?.sheetBridgeMode || "off";
  const activeSheetBridgeState = activeClientObj?.sheetBridgeState || null;
  const hasRealMasterSheet = activeClientObj ? activeClientObj.hasRealMasterSheet !== false : true;
  const hasRealClientSheet = activeClientObj ? activeClientObj.hasRealClientSheet !== false : true;
  const isMaterialized = Boolean(
    stage2Data?.keyInfoMeta?.client_materialized_at || activeClientObj?.materializedAt
  );
  const hasVirtualTabs =
    (stage2Data?.availableTabs?.master?.length || 0) +
    (stage2Data?.availableTabs?.recon?.length || 0) +
    (stage2Data?.availableTabs?.client?.length || 0) >
    0;
  const hasMasterVirtualTabs = (stage2Data?.availableTabs?.master?.length || 0) > 0;
  const hasClientVirtualTabs = (stage2Data?.availableTabs?.client?.length || 0) > 0;
  const reconMonthTabs = sortReconMonthTabsDescending(stage2Data?.availableTabs?.recon || []);
  const hasReconVirtualTabs = reconMonthTabs.length > 0;

  const supabaseEngineClientsCount = allClients.filter((c) => c.master_mode === "supabase").length;
  const supabasePortalClientsCount = allClients.filter((c) => c.client_mode === "supabase").length;
  const migratedClientsCount = allClients.filter(
    (c) => (c.masterTabCount || 0) + (c.reconTabCount || 0) + (c.clientTabCount || 0) > 0
  ).length;
  const bridgedLiveClientsCount = allClients.filter(
    (c) => c.client_mode === "supabase" && (c.sheetBridgeMode === "live" || c.sheetBridgeMode === "dry_run")
  ).length;
  const bridgeErrorClientsCount = allClients.filter(
    (c) => c.client_mode === "supabase" && c.sheetBridgeMode && c.sheetBridgeMode !== "off" && c.sheetBridgeState?.lastError
  ).length;

  const getEffectiveClientStatus = (c) =>
    String(c?.metadata?.statusOverride || c?.status || "live").trim().toLowerCase();
  const isArchivedOrSuspendedClient = (c) =>
    ["archived", "suspended", "inactive"].includes(getEffectiveClientStatus(c));

  const activeOverviewClients = allClients.filter((c) => !isArchivedOrSuspendedClient(c));
  const hiddenArchivedSuspendedCount = allClients.length - activeOverviewClients.length;
  const activeMigratedOverviewClients = activeOverviewClients.filter(
    (c) =>
      c.master_mode === "supabase" ||
      c.client_mode === "supabase" ||
      (c.masterTabCount || 0) + (c.reconTabCount || 0) + (c.clientTabCount || 0) > 0 ||
      String(c.client_name || "").trim().toUpperCase() ===
        String(activeClientName || "").trim().toUpperCase()
  );

  const visibleOverviewClients =
    overviewClientFilter === "all"
      ? allClients
      : overviewClientFilter === "active_all"
        ? activeOverviewClients
        : activeMigratedOverviewClients;

  const formatFreqLabel = (val) => {
    const s = String(val || "").trim();
    if (!s || /^not used$/i.test(s)) return "—";
    return s;
  };

  const cs = stage2Data?.clockStatus || null;
  const rpcReady = Boolean(cs?.rpcReady && cs?.jobScheduled);
  const clockEnabled = cs?.enabled !== false;
  const activeAndRunning = Boolean(cs?.activeAndRunning);
  const isBusy = Boolean(activeOp);

  return (
    <div
      className="pma-page-container"
      style={{ padding: "20px 32px 72px", width: "100%", maxWidth: "100%", margin: "0 auto", boxSizing: "border-box" }}
    >
      {/* Top Engine Overview Header + Buttons + Client Selector */}
      <div style={cardStyle}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "16px",
            flexWrap: "wrap",
            marginBottom: "14px",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
              <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>DB</h1>
              {isInitialLoading ? (
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    padding: "2px 9px",
                    borderRadius: "999px",
                    background: "#eff6ff",
                    color: "#1e40af",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                  }}
                >
                  <Spinner size={11} color="#1e40af" style={{ marginRight: 0 }} />
                  Loading engine overview...
                </span>
              ) : s2Ready ? (
                <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      padding: "2px 9px",
                      borderRadius: "999px",
                      background: "#dcfce7",
                      color: "#166534",
                    }}
                  >
                    {`${supabaseEngineClientsCount} master live · ${supabasePortalClientsCount} portal live · ${migratedClientsCount} synced${bridgedLiveClientsCount > 0 ? ` · ${bridgedLiveClientsCount} sheet-bridged` : ""}`}
                  </span>
                  {bridgeErrorClientsCount > 0 && (
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 600,
                        padding: "2px 9px",
                        borderRadius: "999px",
                        background: "#fee2e2",
                        color: "#991b1b",
                        border: "1px solid #fecaca",
                      }}
                    >
                      {`${bridgeErrorClientsCount} bridge error${bridgeErrorClientsCount === 1 ? "" : "s"}`}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
            <p style={{ margin: 0, fontSize: "12.5px", color: "#64748b", lineHeight: 1.5 }}>
              Manage Supabase virtual workbooks, formatted comparison sheets, Master engine actions, migrations, scheduler controls, and client backups.
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                const next = !showToolsMenu;
                setShowToolsMenu(next);
                if (next) setShowAlertMemoryTool(false);
              }}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 600,
                color: showToolsMenu ? "#1e40af" : "#374151",
                background: showToolsMenu ? "#eff6ff" : "#f9fafb",
                border: `1px solid ${showToolsMenu ? "#93c5fd" : "#d1d5db"}`,
                borderRadius: "6px",
                cursor: "pointer",
              }}
            >
              {showToolsMenu ? "Hide tools" : "Tools"}
            </button>

            <button
              type="button"
              onClick={() => {
                const next = !showAlertMemoryTool;
                setShowAlertMemoryTool(next);
                if (next) {
                  setShowToolsMenu(false);
                  if (amEntries.length === 0) {
                    handleSearchAlertMemory();
                  }
                }
              }}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 600,
                color: showAlertMemoryTool ? "#1e40af" : "#374151",
                background: showAlertMemoryTool ? "#eff6ff" : "#f9fafb",
                border: `1px solid ${showAlertMemoryTool ? "#93c5fd" : "#d1d5db"}`,
                borderRadius: "6px",
                cursor: "pointer",
              }}
            >
              {showAlertMemoryTool ? "Hide alert memory manager" : "Manage alert memory"}
            </button>

            <button
              type="button"
              onClick={handleRefresh}
              disabled={stage2Loading || isBusy}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 600,
                color: "#374151",
                background: "#f9fafb",
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                cursor: stage2Loading || isBusy ? "wait" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {(stage2Loading || activeOp?.key === "refresh") && (
                <Spinner size={12} color="#374151" style={{ marginRight: 0 }} />
              )}
              <span>{stage2Loading || activeOp?.key === "refresh" ? "Refreshing..." : "Refresh"}</span>
            </button>
          </div>
        </div>

        {/* Client Selector Bar (directly beneath Engine Overview buttons) */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: "8px",
            padding: "10px 14px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <label htmlFor="db-client-select" style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e3a8a" }}>
              Selected client:
            </label>
            <select
              id="db-client-select"
              value={activeClientName}
              onChange={(e) => handleSelectClient(e.target.value)}
              disabled={isInitialLoading || isBusy}
              style={{
                padding: "6px 10px",
                fontSize: "12.5px",
                fontWeight: 700,
                borderRadius: "6px",
                border: "1px solid #93c5fd",
                background: "#ffffff",
                color: "#0f172a",
                minWidth: "250px",
                cursor: isInitialLoading || isBusy ? "wait" : "pointer",
              }}
            >
              {allClients.map((c) => {
                const modeTag = c.master_mode === "supabase" ? "Supabase engine" : "Google Sheets";
                const tabsCount = (c.masterTabCount || 0) + (c.reconTabCount || 0);
                const migTag = tabsCount > 0 ? ` · ${tabsCount} tabs` : "";
                return (
                  <option key={c.id || c.client_name} value={c.client_name}>
                    {`${c.client_name} (${modeTag}${migTag})`}
                  </option>
                );
              })}
              {allClients.length === 0 && (
                <option value={activeClientName}>
                  {isInitialLoading ? `Loading ${activeClientName}...` : activeClientName}
                </option>
              )}
            </select>
            {stage2Loading && !isInitialLoading && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#1d4ed8", fontWeight: 600 }}>
                <Spinner size={12} color="#1d4ed8" style={{ marginRight: 0 }} />
                Loading client state...
              </span>
            )}
          </div>

          {!isInitialLoading && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
              <span
                style={{
                  padding: "3px 9px",
                  borderRadius: "999px",
                  fontSize: "11px",
                  fontWeight: 600,
                  background: activeClientMode === "supabase" ? "#dcfce7" : "#f1f5f9",
                  color: activeClientMode === "supabase" ? "#166534" : "#475569",
                  border: `1px solid ${activeClientMode === "supabase" ? "#86efac" : "#cbd5e1"}`,
                }}
              >
                {activeClientMode === "supabase" ? "Master: Supabase engine" : "Master: Google Sheets"}
              </span>
              <span
                style={{
                  padding: "3px 9px",
                  borderRadius: "999px",
                  fontSize: "11px",
                  fontWeight: 600,
                  background: activeClientPortalMode === "supabase" ? "#dbeafe" : "#f1f5f9",
                  color: activeClientPortalMode === "supabase" ? "#1e40af" : "#475569",
                  border: `1px solid ${activeClientPortalMode === "supabase" ? "#93c5fd" : "#cbd5e1"}`,
                }}
              >
                {activeClientPortalMode === "supabase" ? "Portal: Supabase engine" : "Portal: Google Sheets"}
              </span>
              {activeClientObj && (
                <span
                  style={{
                    padding: "3px 9px",
                    borderRadius: "999px",
                    fontSize: "11px",
                    fontWeight: 600,
                    background: "#ffffff",
                    color: "#334155",
                    border: "1px solid #cbd5e1",
                  }}
                >
                  {`${activeClientObj.masterTabCount || 0}M / ${activeClientObj.reconTabCount || 0}R / ${activeClientObj.clientTabCount || 0}C tabs`}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Live Operation Progress Banner */}
        {activeOp && (
          <div
            style={{
              marginTop: "12px",
              padding: "10px 14px",
              borderRadius: "7px",
              background: "#eff6ff",
              border: "1px solid #93c5fd",
              color: "#1e3a8a",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              fontSize: "12.5px",
              fontWeight: 600,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Spinner size={14} color="#1d4ed8" style={{ marginRight: 0 }} />
              <span>{activeOp.label}</span>
            </div>
            <span style={{ fontFamily: "monospace", fontSize: "12px", color: "#1d4ed8" }}>
              {(elapsedMs / 1000).toFixed(1)}s elapsed
            </span>
          </div>
        )}

        {/* Completion / Error Feedback Banner */}
        {feedbackMsg && !activeOp && (
          <div
            style={{
              marginTop: "12px",
              padding: "10px 14px",
              borderRadius: "7px",
              fontSize: "12.5px",
              fontWeight: 500,
              background: feedbackMsg.type === "error" ? "#fef2f2" : "#f0fdf4",
              border: `1px solid ${feedbackMsg.type === "error" ? "#fecaca" : "#bbf7d0"}`,
              color: feedbackMsg.type === "error" ? "#991b1b" : "#166534",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px" }}>
              <div>
                <span>{feedbackMsg.text}</span>
                {feedbackMsg.durationSec && (
                  <span style={{ marginLeft: "8px", fontSize: "11px", opacity: 0.8, fontFamily: "monospace" }}>
                    ({feedbackMsg.durationSec}s)
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setFeedbackMsg(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: "inherit",
                  fontWeight: 700,
                  fontSize: "14px",
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: "0 2px",
                }}
                title="Dismiss message"
              >
                ×
              </button>
            </div>
            {Array.isArray(feedbackMsg.uiAlerts) && feedbackMsg.uiAlerts.length > 0 && (
              <div
                style={{
                  marginTop: "8px",
                  padding: "8px 10px",
                  borderRadius: "6px",
                  background: "rgba(255, 255, 255, 0.75)",
                  border: "1px solid rgba(22, 101, 52, 0.2)",
                  fontSize: "12px",
                  color: "#1e293b",
                  whiteSpace: "pre-wrap",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: "3px", fontSize: "11px", color: "#475569" }}>
                  GAS script message:
                </div>
                {feedbackMsg.uiAlerts.join("\n\n")}
              </div>
            )}
          </div>
        )}

        {/* Collapsible Alert Memory Manager */}
        {showAlertMemoryTool && (
          <div
            style={{
              marginTop: "14px",
              padding: "14px",
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              borderRadius: "8px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
                marginBottom: "10px",
              }}
            >
              <div style={{ fontSize: "12px", color: "#475569", lineHeight: 1.5 }}>
                Deleting an entry here removes it simultaneously from <strong>Supabase</strong> (<code>alert_memory</code> &{" "}
                <code>pma_tasks</code>), the legacy <strong>Automation Commander</strong> sheet (<code>AlertMemory</code>),
                and the <strong>Upstash Redis</strong> cache.
              </div>
              <button
                type="button"
                onClick={handleFlushAlertMemoryCache}
                disabled={amFlushing}
                style={{
                  padding: "5px 10px",
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "#334155",
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  cursor: amFlushing ? "wait" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                }}
              >
                {amFlushing && <Spinner size={11} color="#334155" style={{ marginRight: 0 }} />}
                <span>{amFlushing ? "Flushing cache..." : "Flush alert memory cache"}</span>
              </button>
            </div>

            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
              <DeferredSearchInput
                type="text"
                value={amQuery}
                onChange={(e) => setAmQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearchAlertMemory(e.target.value);
                }}
                debounceMs={0}
                showClearButton
                placeholder="Search by client, invoice/job ref, summary, or fingerprint hash..."
                style={{
                  flex: "1 1 240px",
                  padding: "7px 10px",
                  fontSize: "12px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                }}
              />
              <select
                value={amStatusFilter}
                onChange={(e) => {
                  setAmStatusFilter(e.target.value);
                  handleSearchAlertMemory(amQuery, e.target.value);
                }}
                style={{
                  padding: "7px 10px",
                  fontSize: "12px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                }}
              >
                <option value="handled_only">Handled only (ignored / accepted / task)</option>
                <option value="all">All statuses (including cached)</option>
                <option value="ignored">Ignored</option>
                <option value="accepted">Accepted</option>
                <option value="task">Task</option>
                <option value="cached">Cached</option>
              </select>
              <button
                type="button"
                onClick={() => handleSearchAlertMemory()}
                disabled={amLoading}
                style={{
                  padding: "7px 14px",
                  fontSize: "12px",
                  fontWeight: 600,
                  borderRadius: "6px",
                  border: "none",
                  background: "#1a56db",
                  color: "#fff",
                  cursor: amLoading ? "wait" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                }}
              >
                {amLoading && <Spinner size={11} color="#fff" style={{ marginRight: 0 }} />}
                <span>{amLoading ? "Searching..." : "Search"}</span>
              </button>
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "12px" }}>
              <input
                type="text"
                value={amManualHash}
                onChange={(e) => setAmManualHash(e.target.value)}
                placeholder="Or paste a fingerprint_hash to delete from sheet & cache..."
                style={{
                  flex: "1 1 220px",
                  padding: "6px 10px",
                  fontSize: "12px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                  fontFamily: "monospace",
                }}
              />
              <button
                type="button"
                disabled={!amManualHash.trim() || Boolean(amDeletingHash)}
                onClick={() => handleDeleteAlertMemory(amManualHash)}
                style={{
                  padding: "6px 12px",
                  fontSize: "11px",
                  fontWeight: 600,
                  borderRadius: "6px",
                  border: "1px solid #fecaca",
                  background: !amManualHash.trim() ? "#f1f5f9" : "#fef2f2",
                  color: !amManualHash.trim() ? "#94a3b8" : "#dc2626",
                  cursor: !amManualHash.trim() ? "not-allowed" : "pointer",
                }}
              >
                Delete hash everywhere
              </button>
            </div>

            <div
              style={{
                maxHeight: "260px",
                overflowY: "auto",
                border: "1px solid #e2e8f0",
                borderRadius: "6px",
                background: "#fff",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "8px 10px", color: "#475569" }}>Hash</th>
                    <th style={{ padding: "8px 10px", color: "#475569" }}>Client</th>
                    <th style={{ padding: "8px 10px", color: "#475569" }}>Type</th>
                    <th style={{ padding: "8px 10px", color: "#475569" }}>Status</th>
                    <th style={{ padding: "8px 10px", color: "#475569" }}>Summary / reason</th>
                    <th style={{ padding: "8px 10px", color: "#475569", textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {amLoading && amEntries.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: "16px", textAlign: "center", color: "#475569" }}>
                        <Spinner size={13} color="#1a56db" /> Loading alert memory entries...
                      </td>
                    </tr>
                  )}
                  {amEntries.map((entry) => (
                    <tr key={entry.fingerprintHash} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "7px 10px", fontFamily: "monospace", color: "#334155" }}>
                        {entry.fingerprintHash}
                      </td>
                      <td style={{ padding: "7px 10px", fontWeight: 600, color: "#0f172a" }}>{entry.clientName}</td>
                      <td style={{ padding: "7px 10px", color: "#475569" }}>{entry.alertType}</td>
                      <td style={{ padding: "7px 10px" }}>
                        <span
                          style={{
                            padding: "2px 6px",
                            borderRadius: "4px",
                            fontWeight: 600,
                            background: entry.status === "cached" ? "#f1f5f9" : "#dbeafe",
                            color: entry.status === "cached" ? "#475569" : "#1e40af",
                          }}
                        >
                          {entry.status}
                        </span>
                      </td>
                      <td style={{ padding: "7px 10px", color: "#334155", maxWidth: "280px" }}>
                        <div
                          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={entry.alertSummary}
                        >
                          {entry.alertSummary || "—"}
                        </div>
                        {entry.ignoreReason && (
                          <div style={{ color: "#64748b", fontSize: "10px" }}>Note: {entry.ignoreReason}</div>
                        )}
                      </td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>
                        <button
                          type="button"
                          disabled={amDeletingHash === entry.fingerprintHash}
                          onClick={() => handleDeleteAlertMemory(entry.fingerprintHash)}
                          style={{
                            padding: "4px 8px",
                            fontSize: "11px",
                            fontWeight: 600,
                            borderRadius: "4px",
                            border: "1px solid #fecaca",
                            background: "#fef2f2",
                            color: "#dc2626",
                            cursor: amDeletingHash === entry.fingerprintHash ? "wait" : "pointer",
                          }}
                        >
                          {amDeletingHash === entry.fingerprintHash ? "Deleting..." : "Delete"}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!amLoading && amEntries.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: "14px", textAlign: "center", color: "#94a3b8" }}>
                        No matching alert memory entries found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Collapsible Database Maintenance Tools */}
        {showToolsMenu && (
          <div
            style={{
              marginTop: "14px",
              padding: "14px",
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              borderRadius: "8px",
            }}
          >
            <div style={{ marginBottom: "10px" }}>
              <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#0f172a", marginBottom: "3px" }}>
                SQL mirror table maintenance
              </div>
              <div style={{ fontSize: "12px", color: "#475569", lineHeight: 1.5 }}>
                Automatic per-edit writes to the 14 relational SQL mirror tables are paused by default because Pulse and PMA read directly from{" "}
                <code>master_sheet_grids</code>. Use these tools only when populating those tables for external SQL reporting or clearing them afterwards.
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                disabled={!s2Ready || !hasVirtualTabs || isBusy}
                onClick={() => handleBackfillMirrors(activeClientName)}
                style={{
                  ...actionBtnBase,
                  background:
                    activeOp?.key === "backfill_mirrors"
                      ? "#eff6ff"
                      : !s2Ready || !hasVirtualTabs
                        ? "#f3f4f6"
                        : "#ffffff",
                  borderColor: activeOp?.key === "backfill_mirrors" ? "#60a5fa" : "#cbd5e1",
                  color: !s2Ready || !hasVirtualTabs ? "#9ca3af" : activeOp?.key === "backfill_mirrors" ? "#1e40af" : "#334155",
                  cursor: !s2Ready || !hasVirtualTabs ? "not-allowed" : isBusy ? "wait" : "pointer",
                }}
              >
                {activeOp?.key === "backfill_mirrors" && <Spinner size={11} color="#1e40af" style={{ marginRight: 0 }} />}
                <span>
                  {activeOp?.key === "backfill_mirrors"
                    ? `Backfilling (${activeClientName})...`
                    : `Backfill SQL mirror tables (${activeClientName})`}
                </span>
              </button>
              <button
                type="button"
                disabled={!s2Ready || isBusy}
                onClick={handleClearPausedMirrors}
                style={{
                  ...actionBtnBase,
                  background:
                    activeOp?.key === "clear_paused_mirrors"
                      ? "#fef2f2"
                      : !s2Ready
                        ? "#f3f4f6"
                        : "#fff5f5",
                  borderColor: activeOp?.key === "clear_paused_mirrors" ? "#f87171" : "#fecaca",
                  color: !s2Ready ? "#9ca3af" : "#b91c1c",
                  cursor: !s2Ready ? "not-allowed" : isBusy ? "wait" : "pointer",
                }}
              >
                {activeOp?.key === "clear_paused_mirrors" && <Spinner size={11} color="#b91c1c" style={{ marginRight: 0 }} />}
                <span>{activeOp?.key === "clear_paused_mirrors" ? "Clearing..." : "Clear paused SQL mirror tables"}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Initial Full-Screen Loading Skeleton (never flashes "No data available") */}
      {isInitialLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {["Manage client", "Client engine overview", "Migration", `Supabase ${formatCronScheduleLabel(cs?.schedule).adjective} cron scheduler`, "Client workbook backups & granular restore"].map((secTitle) => (
            <div key={secTitle} style={cardStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                <Spinner size={14} color="#0047AB" style={{ marginRight: 0 }} />
                <span style={{ fontSize: "14px", fontWeight: 700, color: "#334155" }}>
                  Loading {secTitle.toLowerCase()}...
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" }}>
                <div style={{ height: "34px", background: "#f1f5f9", borderRadius: "6px", border: "1px solid #e2e8f0" }} />
                <div style={{ height: "34px", background: "#f1f5f9", borderRadius: "6px", border: "1px solid #e2e8f0" }} />
                <div style={{ height: "34px", background: "#f1f5f9", borderRadius: "6px", border: "1px solid #e2e8f0" }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* SECTION 1: Manage client (First main section) */}
          <div style={cardStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
                marginBottom: "12px",
                paddingBottom: "10px",
                borderBottom: "1px solid #e2e8f0",
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                  Manage client — {activeClientName}
                </h2>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748b" }}>
                  Inspect virtual tabs, open formatted Google Sheets-style comparison views, run native Supabase syncs, and execute AMD menu actions.
                </p>
              </div>
            </div>

            {(!s2Ready || !hasVirtualTabs) && (
              <div
                style={{
                  marginBottom: "12px",
                  padding: "9px 12px",
                  borderRadius: "6px",
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  fontSize: "12px",
                  color: "#92400e",
                }}
              >
                {activeClientName} does not have virtual workbook tabs synced in Supabase yet. Run step{" "}
                <strong>1. Sync {activeClientName} Master & Recon</strong> in the Migration section below to enable inspection, comparison views, syncs, and AMD actions.
              </div>
            )}

            {/* Sub-group A: Inspectors & Formatted Comparison Sheets */}
            <div style={{ marginBottom: "14px" }}>
              <div style={{ fontSize: "11.5px", fontWeight: 700, color: "#475569", marginBottom: "7px" }}>
                Workbook inspection & formatted comparison tabs
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => {
                    setInspectorInitialRole("master");
                    setInspectorOpen(true);
                  }}
                  disabled={!s2Ready || !hasVirtualTabs}
                  style={{
                    ...actionBtnBase,
                    color: !s2Ready || !hasVirtualTabs ? "#9ca3af" : "#1e40af",
                    background: !s2Ready || !hasVirtualTabs ? "#f3f4f6" : "#eff6ff",
                    borderColor: !s2Ready || !hasVirtualTabs ? "#e5e7eb" : "#93c5fd",
                    cursor: !s2Ready || !hasVirtualTabs ? "not-allowed" : "pointer",
                  }}
                >
                  Open workbook inspector
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setInspectorInitialRole("executions");
                    setInspectorOpen(true);
                  }}
                  disabled={!s2Ready || !hasVirtualTabs}
                  style={{
                    ...actionBtnBase,
                    color: !s2Ready || !hasVirtualTabs ? "#9ca3af" : "#0f172a",
                    background: !s2Ready || !hasVirtualTabs ? "#f3f4f6" : "#ffffff",
                    cursor: !s2Ready || !hasVirtualTabs ? "not-allowed" : "pointer",
                  }}
                >
                  View GAS execution logs
                </button>

                {[
                  { tab: "InvComp", label: "View InvComp" },
                  { tab: "DirComp", label: "View DirComp" },
                  { tab: "CRMComp", label: "View CRMComp" },
                ].map((item) => {
                  const disabled = !s2Ready || !hasMasterVirtualTabs;
                  return (
                    <button
                      key={item.tab}
                      type="button"
                      disabled={disabled}
                      onMouseEnter={() => {
                        if (!disabled) prefetchComparisonTab(activeClientName, item.tab);
                      }}
                      onClick={() => {
                        setComparisonModalTab(item.tab);
                        setComparisonModalOpen(true);
                      }}
                      style={{
                        ...actionBtnBase,
                        color: disabled ? "#9ca3af" : "#1e3a8a",
                        background: disabled ? "#f3f4f6" : "#ffffff",
                        borderColor: disabled ? "#e5e7eb" : "#93c5fd",
                        cursor: disabled ? "not-allowed" : "pointer",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: "7px",
                          height: "7px",
                          borderRadius: "2px",
                          background: disabled ? "#cbd5e1" : "#0000ff",
                        }}
                      />
                      <span>{item.label}</span>
                    </button>
                  );
                })}

                {(() => {
                  const timeCompDisabled = !s2Ready || !hasMasterVirtualTabs;
                  return (
                    <button
                      type="button"
                      disabled={timeCompDisabled}
                      onMouseEnter={() => {
                        if (!timeCompDisabled) prefetchTimeCompTab(activeClientName);
                      }}
                      onClick={() => setTimeCompModalOpen(true)}
                      style={{
                        ...actionBtnBase,
                        color: timeCompDisabled ? "#9ca3af" : "#1e3a8a",
                        background: timeCompDisabled ? "#f3f4f6" : "#ffffff",
                        borderColor: timeCompDisabled ? "#e5e7eb" : "#93c5fd",
                        cursor: timeCompDisabled ? "not-allowed" : "pointer",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: "7px",
                          height: "7px",
                          borderRadius: "2px",
                          background: timeCompDisabled ? "#cbd5e1" : "#0000ff",
                        }}
                      />
                      <span>View TimeComp</span>
                    </button>
                  );
                })()}

                {(() => {
                  const reconDisabled = !s2Ready || !hasReconVirtualTabs;
                  return (
                    <button
                      type="button"
                      disabled={reconDisabled}
                      onMouseEnter={() => {
                        if (!reconDisabled) prefetchReconSheetTab(activeClientName, reconMonthTabs[0]);
                      }}
                      onClick={() => setReconModalOpen(true)}
                      style={{
                        ...actionBtnBase,
                        color: reconDisabled ? "#9ca3af" : "#115e59",
                        background: reconDisabled ? "#f3f4f6" : "#ffffff",
                        borderColor: reconDisabled ? "#e5e7eb" : "#5eead4",
                        cursor: reconDisabled ? "not-allowed" : "pointer",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: "7px",
                          height: "7px",
                          borderRadius: "2px",
                          background: reconDisabled ? "#cbd5e1" : "#0f766e",
                        }}
                      />
                      <span>View recon</span>
                    </button>
                  );
                })()}
              </div>

              {(hasClientVirtualTabs || activeClientPortalMode === "supabase") && (
                <div style={{ marginTop: "10px" }}>
                  <div style={{ fontSize: "11.5px", fontWeight: 700, color: "#475569", marginBottom: "7px" }}>
                    Formatted client sheet tabs (Supabase)
                  </div>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {CLIENT_SHEET_TABS.map((tab) => {
                      const disabled = !s2Ready || !hasClientVirtualTabs;
                      const accent = CLIENT_SHEET_SPECS[tab]?.tabColor || "#2563eb";
                      return (
                        <button
                          key={tab}
                          type="button"
                          disabled={disabled}
                          onMouseEnter={() => {
                            if (!disabled) prefetchClientSheetTab(activeClientName, tab);
                          }}
                          onClick={() => {
                            setClientSheetModalTab(tab);
                            setClientSheetModalOpen(true);
                          }}
                          style={{
                            ...actionBtnBase,
                            color: disabled ? "#9ca3af" : "#0f172a",
                            background: disabled ? "#f3f4f6" : "#ffffff",
                            borderColor: disabled ? "#e5e7eb" : "#cbd5e1",
                            cursor: disabled ? "not-allowed" : "pointer",
                          }}
                        >
                          <span
                            style={{
                              display: "inline-block",
                              width: "7px",
                              height: "7px",
                              borderRadius: "2px",
                              background: disabled ? "#cbd5e1" : accent,
                            }}
                          />
                          <span>{`View ${tab}`}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Sub-group B: Comparisons & Sync Sequences */}
            <div style={{ marginBottom: "14px" }}>
              <div style={{ fontSize: "11.5px", fontWeight: 700, color: "#475569", marginBottom: "7px" }}>
                Comparisons & native syncs
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {SYNC_BUTTONS.map((btn) => {
                  const isRunningThis = activeOp?.key === `sync_${btn.type}`;
                  const disabled = !s2Ready || !hasVirtualTabs || isBusy;
                  return (
                    <button
                      key={btn.type}
                      type="button"
                      disabled={disabled}
                      onClick={() => handleNativeSync(btn.type, btn.label, activeClientName)}
                      style={{
                        ...actionBtnBase,
                        background: isRunningThis
                          ? "#eff6ff"
                          : btn.type === "recompute" && !disabled
                            ? "#fffbeb"
                            : !s2Ready || !hasVirtualTabs
                              ? "#f3f4f6"
                              : "#ffffff",
                        borderColor: isRunningThis
                          ? "#60a5fa"
                          : btn.type === "recompute" && !disabled
                            ? "#fcd34d"
                            : "#cbd5e1",
                        color: !s2Ready || !hasVirtualTabs ? "#9ca3af" : isRunningThis ? "#1e40af" : "#1e293b",
                        cursor: !s2Ready || !hasVirtualTabs ? "not-allowed" : isBusy ? "wait" : "pointer",
                      }}
                    >
                      {isRunningThis && <Spinner size={11} color="#1e40af" style={{ marginRight: 0 }} />}
                      <span>{isRunningThis ? "Running..." : btn.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Sub-group C: AMD Menu Actions */}
            <div>
              <div style={{ fontSize: "11.5px", fontWeight: 700, color: "#475569", marginBottom: "7px" }}>
                AMD master sheet menu actions
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {AMD_BUTTONS.map((btn) => {
                  const isRunningThis = activeOp?.key === `amd_${btn.amdAction}`;
                  const disabled = !s2Ready || !hasVirtualTabs || isBusy;
                  return (
                    <button
                      key={btn.amdAction}
                      type="button"
                      disabled={disabled}
                      onClick={() => handleAmdAction(btn.amdAction, btn.label, activeClientName)}
                      style={{
                        ...actionBtnBase,
                        background: isRunningThis
                          ? "#eff6ff"
                          : !s2Ready || !hasVirtualTabs
                            ? "#f3f4f6"
                            : "#f8fafc",
                        borderColor: isRunningThis ? "#60a5fa" : "#cbd5e1",
                        color: !s2Ready || !hasVirtualTabs ? "#9ca3af" : isRunningThis ? "#1e40af" : "#1e293b",
                        cursor: !s2Ready || !hasVirtualTabs ? "not-allowed" : isBusy ? "wait" : "pointer",
                      }}
                    >
                      {isRunningThis && <Spinner size={11} color="#1e40af" style={{ marginRight: 0 }} />}
                      <span>{isRunningThis ? "Running..." : btn.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* SECTION 2: Client engine overview */}
          <div style={cardStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
                marginBottom: "10px",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                {overviewClientFilter === "all"
                  ? `Client engine overview (${visibleOverviewClients.length} of ${allClients.length} clients shown)`
                  : `Client engine overview (${visibleOverviewClients.length} of ${activeOverviewClients.length} active clients shown${hiddenArchivedSuspendedCount > 0 ? ` · ${hiddenArchivedSuspendedCount} archived/suspended hidden` : ""})`}
              </h2>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  disabled={!s2Ready || bridgedLiveClientsCount === 0 || isBusy}
                  onClick={() => handleVerifySheetParity(true)}
                  title={
                    bridgedLiveClientsCount === 0
                      ? "No clients currently have Google Sheet live or dry-run bridge enabled."
                      : "Compare live Google Sheet Dashboard & Cash figures against Supabase for all bridged clients."
                  }
                  style={{
                    padding: "5px 10px",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    borderRadius: "6px",
                    border: "1px solid #93c5fd",
                    background: !s2Ready || bridgedLiveClientsCount === 0 ? "#f3f4f6" : "#eff6ff",
                    color: !s2Ready || bridgedLiveClientsCount === 0 ? "#9ca3af" : "#1e40af",
                    cursor: !s2Ready || bridgedLiveClientsCount === 0 ? "not-allowed" : isBusy ? "wait" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                  }}
                >
                  {activeOp?.key === "verify_bridge_parity" && <Spinner size={11} color="#1e40af" style={{ marginRight: 0 }} />}
                  <span>
                    {activeOp?.key === "verify_bridge_parity"
                      ? "Checking parity..."
                      : `Verify sheet parity (${bridgedLiveClientsCount})`}
                  </span>
                </button>

                <select
                  aria-label="Filter clients in overview"
                  value={overviewClientFilter}
                  onChange={(e) => setOverviewClientFilter(e.target.value)}
                  style={{
                    padding: "5px 10px",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: "#334155",
                    cursor: "pointer",
                  }}
                >
                  <option value="active_migrated">
                    {`Active migrated & selected (${activeMigratedOverviewClients.length})`}
                  </option>
                  <option value="active_all">
                    {`All active clients (${activeOverviewClients.length})`}
                  </option>
                  <option value="all">
                    {`Show all clients (${allClients.length})`}
                  </option>
                </select>
              </div>
            </div>

            {parityReport && (
              <div
                style={{
                  marginBottom: "12px",
                  padding: "12px 14px",
                  borderRadius: "8px",
                  background: "#f8fafc",
                  border: `1px solid ${parityReport.errorClientsCount > 0 ? "#fecaca" : parityReport.mismatchClientsCount > 0 ? "#fde68a" : "#bbf7d0"}`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "10px",
                    flexWrap: "wrap",
                    marginBottom: "8px",
                  }}
                >
                  <div style={{ fontSize: "12px", fontWeight: 700, color: "#0f172a" }}>
                    {`Sheet parity check (${formatTimestamp(parityReport.checkedAt)}) — ${parityReport.matchedClientsCount || 0} of ${parityReport.clientsChecked || 0} bridged clients match 100% on Dashboard & Cash`}
                  </div>
                  <button
                    type="button"
                    onClick={() => setParityReport(null)}
                    style={{
                      padding: "3px 8px",
                      fontSize: "11px",
                      fontWeight: 600,
                      borderRadius: "5px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                      color: "#475569",
                      cursor: "pointer",
                    }}
                  >
                    Hide report
                  </button>
                </div>

                {Array.isArray(parityReport.results) && parityReport.results.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {parityReport.results.map((r) => {
                      const hasErr = Boolean(r.error || r.lastError);
                      const hasDiff = r.totalMismatchCount > 0;
                      const badgeBg = hasErr ? "#fee2e2" : hasDiff ? "#fef3c7" : "#dcfce7";
                      const badgeFg = hasErr ? "#991b1b" : hasDiff ? "#92400e" : "#166534";
                      const badgeText = hasErr
                        ? "Error"
                        : hasDiff
                          ? `Dashboard ${r.dashboardMismatchCount} · Cash ${r.cashMismatchCount} diff(s)`
                          : "Dashboard & Cash match";
                      return (
                        <div
                          key={r.clientName}
                          style={{
                            background: "#ffffff",
                            border: "1px solid #e2e8f0",
                            borderRadius: "6px",
                            padding: "8px 10px",
                            fontSize: "11.5px",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
                              <strong style={{ color: "#0f172a" }}>{r.clientName}</strong>
                              <span
                                style={{
                                  padding: "1px 7px",
                                  borderRadius: "999px",
                                  fontSize: "10.5px",
                                  fontWeight: 600,
                                  background: badgeBg,
                                  color: badgeFg,
                                }}
                              >
                                {badgeText}
                              </span>
                              <span style={{ fontSize: "10.5px", color: r.driveInSync ? "#64748b" : "#b45309", fontWeight: r.driveInSync ? 500 : 600 }}>
                                {r.driveInSync
                                  ? `Drive v${r.driveVersion || "?"}`
                                  : `Pending sheet edit (live v${r.driveVersion || "?"} vs synced v${r.lastSyncedDriveVersion || "?"})`}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleSelectClient(r.clientName)}
                              style={{
                                padding: "2px 8px",
                                fontSize: "10.5px",
                                fontWeight: 600,
                                borderRadius: "4px",
                                border: "1px solid #cbd5e1",
                                background: "#f8fafc",
                                color: "#334155",
                                cursor: "pointer",
                              }}
                            >
                              Select
                            </button>
                          </div>
                          {(r.error || r.lastError) && (
                            <div style={{ marginTop: "4px", color: "#b91c1c", fontSize: "11px" }}>
                              {r.error || r.lastError}
                            </div>
                          )}
                          {Array.isArray(r.sampleMismatches) && r.sampleMismatches.length > 0 && (
                            <div style={{ marginTop: "5px", display: "flex", flexDirection: "column", gap: "2px", fontSize: "11px", color: "#475569" }}>
                              {r.sampleMismatches.slice(0, 5).map((m, mIdx) => (
                                <div key={mIdx}>
                                  <strong>{`${m.tab}!${m.cell}`}</strong>
                                  {` (${m.rowLabel} · ${m.colLabel}): Sheet ${formatParityValue(m.sheetValue)} vs Supabase ${formatParityValue(m.supabaseValue)}`}
                                </div>
                              ))}
                              {r.totalMismatchCount > 5 && (
                                <div style={{ color: "#64748b", fontSize: "10.5px" }}>
                                  {`+${r.totalMismatchCount - 5} more difference(s)`}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: "11.5px", color: "#64748b" }}>
                    No bridged clients found to check.
                  </div>
                )}
              </div>
            )}

            {allClients.length === 0 ? (
              <div
                style={{
                  padding: "16px",
                  borderRadius: "6px",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  fontSize: "12px",
                  color: "#64748b",
                  textAlign: "center",
                }}
              >
                No Supabase client records returned yet. Click Refresh above or check Supabase connectivity.
              </div>
            ) : (
              <div
                style={{
                  maxHeight: "280px",
                  overflowY: "auto",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11.5px" }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                      <th style={{ padding: "8px 10px", color: "#475569" }}>Client</th>
                      <th style={{ padding: "8px 10px", color: "#475569" }}>Engine mode</th>
                      <th style={{ padding: "8px 10px", color: "#475569" }}>Virtual workbook</th>
                      <th style={{ padding: "8px 10px", color: "#475569" }}>Client sheet links</th>
                      <th style={{ padding: "8px 10px", color: "#475569" }}>Integrations</th>
                      <th style={{ padding: "8px 10px", color: "#475569" }}>Auto sync (Inv / CRM / Exp)</th>
                      <th style={{ padding: "8px 10px", color: "#475569", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleOverviewClients.length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ padding: "16px", textAlign: "center", color: "#64748b", fontSize: "12px" }}>
                          No matching clients for this filter. Choose &quot;Show all clients&quot; above to view archived or suspended clients.
                        </td>
                      </tr>
                    )}
                    {visibleOverviewClients.map((c) => {
                      const isSelected =
                        String(c.client_name || "").trim().toUpperCase() ===
                        String(activeClientName || "").trim().toUpperCase();
                      const effectiveStatus = getEffectiveClientStatus(c);
                      const isArchivedOrSuspended = isArchivedOrSuspendedClient(c);
                      const isSupabase = c.master_mode === "supabase";
                      const isClientSupabase = c.client_mode === "supabase";
                      const mTabs = c.masterTabCount || 0;
                      const rTabs = c.reconTabCount || 0;
                      const cTabs = c.clientTabCount || 0;
                      const hasTabs = mTabs + rTabs + cTabs > 0;
                      const mat = Boolean(c.materializedAt);
                      const tools = [c.accountingTool, c.crmTool].filter(Boolean).join(" · ") || "—";

                      return (
                        <tr
                          key={c.id || c.client_name}
                          style={{
                            borderBottom: "1px solid #f1f5f9",
                            background: isSelected ? "#eff6ff" : "#ffffff",
                          }}
                        >
                          <td style={{ padding: "8px 10px", fontWeight: 700, color: "#0f172a" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                              <span>{c.client_name}</span>
                              {isSelected && (
                                <span
                                  style={{
                                    fontSize: "10px",
                                    fontWeight: 600,
                                    padding: "1px 6px",
                                    borderRadius: "4px",
                                    background: "#dbeafe",
                                    color: "#1e40af",
                                  }}
                                >
                                  Selected
                                </span>
                              )}
                              {isArchivedOrSuspended && (
                                <span
                                  style={{
                                    fontSize: "10px",
                                    fontWeight: 600,
                                    padding: "1px 6px",
                                    borderRadius: "4px",
                                    background: effectiveStatus === "suspended" ? "#f3e8ff" : "#f1f5f9",
                                    color: effectiveStatus === "suspended" ? "#6b21a8" : "#475569",
                                  }}
                                >
                                  {effectiveStatus === "suspended"
                                    ? "Suspended"
                                    : effectiveStatus === "archived"
                                      ? "Archived"
                                      : "Inactive"}
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <div style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>
                              <span
                                style={{
                                  padding: "2px 7px",
                                  borderRadius: "999px",
                                  fontWeight: 600,
                                  fontSize: "10px",
                                  background: isSupabase ? "#dcfce7" : "#f1f5f9",
                                  color: isSupabase ? "#166534" : "#475569",
                                }}
                              >
                                {isSupabase ? "Master: Supabase" : "Master: Sheets"}
                              </span>
                                <span
                                  style={{
                                    padding: "2px 7px",
                                    borderRadius: "999px",
                                    fontWeight: 600,
                                    fontSize: "10px",
                                    background: isClientSupabase ? "#dbeafe" : "#f1f5f9",
                                    color: isClientSupabase ? "#1e40af" : "#475569",
                                  }}
                                >
                                  {isClientSupabase
                                    ? c.sheetBridgeMode === "live"
                                      ? "Portal: Supabase + Sheet"
                                      : c.sheetBridgeMode === "dry_run"
                                        ? "Portal: Supabase (dry run)"
                                        : "Portal: Supabase"
                                    : "Portal: Sheets"}
                                </span>
                              {isClientSupabase && (c.sheetBridgeMode === "live" || c.sheetBridgeMode === "dry_run") && (() => {
                                const bState = c.sheetBridgeState || {};
                                const hasErr = Boolean(bState.lastError);
                                const hasConflict = Number(bState.recentLogs?.[0]?.conflictCount || 0) > 0;
                                if (hasErr) {
                                  return (
                                    <span
                                      title={bState.lastError}
                                      style={{
                                        padding: "2px 7px",
                                        borderRadius: "999px",
                                        fontWeight: 600,
                                        fontSize: "10px",
                                        background: "#fee2e2",
                                        color: "#991b1b",
                                        border: "1px solid #fecaca",
                                      }}
                                    >
                                      Bridge error
                                    </span>
                                  );
                                }
                                if (hasConflict) {
                                  return (
                                    <span
                                      title={bState.lastSummary || "Same-cell conflict recorded"}
                                      style={{
                                        padding: "2px 7px",
                                        borderRadius: "999px",
                                        fontWeight: 600,
                                        fontSize: "10px",
                                        background: "#fef3c7",
                                        color: "#92400e",
                                        border: "1px solid #fde68a",
                                      }}
                                    >
                                      Conflict
                                    </span>
                                  );
                                }
                                if (c.sheetBridgeMode === "live") {
                                  return (
                                    <span
                                      title={bState.lastSummary || "Sheet bridge active"}
                                      style={{
                                        padding: "2px 7px",
                                        borderRadius: "999px",
                                        fontWeight: 600,
                                        fontSize: "10px",
                                        background: "#dcfce7",
                                        color: "#166534",
                                      }}
                                    >
                                      In sync
                                    </span>
                                  );
                                }
                                return null;
                              })()}
                              {c.jobsMode === "relational" && (
                                <span
                                  title={
                                    c.relationalJobsState?.lastBackfilledAt
                                      ? `Backfilled ${c.relationalJobsState.confirmedJobsCount || 0} confirmed / ${c.relationalJobsState.pipelineJobsCount || 0} pipeline jobs`
                                      : "Phase 2 relational jobs enabled"
                                  }
                                  style={{
                                    padding: "2px 7px",
                                    borderRadius: "999px",
                                    fontWeight: 600,
                                    fontSize: "10px",
                                    background: "#e0e7ff",
                                    color: "#3730a3",
                                  }}
                                >
                                  Jobs: relational
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: "8px 10px", color: hasTabs ? "#1e293b" : "#94a3b8" }}>
                            {hasTabs ? `${mTabs} master / ${rTabs} recon / ${cTabs} client` : "Not synced"}
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <span
                              style={{
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontWeight: 600,
                                fontSize: "10px",
                                background: mat ? "#dcfce7" : "#f8fafc",
                                color: mat ? "#166534" : "#64748b",
                                border: mat ? "none" : "1px solid #e2e8f0",
                              }}
                            >
                              {mat ? "IMPORTRANGEs removed" : "Legacy IMPORTRANGE"}
                            </span>
                          </td>
                          <td style={{ padding: "8px 10px", color: "#334155" }}>{tools}</td>
                          <td style={{ padding: "8px 10px", color: "#334155", fontFamily: "monospace", fontSize: "10.5px" }}>
                            {`${formatFreqLabel(c.invFreq)} / ${formatFreqLabel(c.crmFreq)} / ${formatFreqLabel(c.expFreq)}`}
                          </td>
                          <td style={{ padding: "8px 10px", textAlign: "right" }}>
                            <div style={{ display: "inline-flex", gap: "5px", alignItems: "center" }}>
                              <button
                                type="button"
                                onClick={() => handleSelectClient(c.client_name)}
                                style={{
                                  padding: "3px 8px",
                                  fontSize: "10.5px",
                                  fontWeight: 600,
                                  borderRadius: "4px",
                                  border: `1px solid ${isSelected ? "#93c5fd" : "#cbd5e1"}`,
                                  background: isSelected ? "#dbeafe" : "#ffffff",
                                  color: isSelected ? "#1e40af" : "#334155",
                                  cursor: "pointer",
                                }}
                              >
                                {isSelected ? "Active" : "Select"}
                              </button>
                              {hasTabs && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (!isSelected) handleSelectClient(c.client_name);
                                      setInspectorInitialRole("master");
                                      setInspectorOpen(true);
                                    }}
                                    style={{
                                      padding: "3px 7px",
                                      fontSize: "10.5px",
                                      fontWeight: 600,
                                      borderRadius: "4px",
                                      border: "1px solid #cbd5e1",
                                      background: "#f8fafc",
                                      color: "#1e40af",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Tabs
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (!isSelected) handleSelectClient(c.client_name);
                                      setInspectorInitialRole("executions");
                                      setInspectorOpen(true);
                                    }}
                                    style={{
                                      padding: "3px 7px",
                                      fontSize: "10.5px",
                                      fontWeight: 600,
                                      borderRadius: "4px",
                                      border: "1px solid #cbd5e1",
                                      background: "#f8fafc",
                                      color: "#0f172a",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Logs
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* SECTION 3: Migration (Steps/Buttons 1-5) */}
          <div style={cardStyle}>
            <div style={{ marginBottom: "12px" }}>
              <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                Migration — {activeClientName}
              </h2>
              <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748b" }}>
                Step-by-step migration controls for moving {activeClientName} Master, Recon, and Client Portal workbooks from Google Sheets to Supabase.
              </p>
            </div>

            {/* Step 1 Banner */}
            <div
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                padding: "12px 14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
                marginBottom: "12px",
              }}
            >
              <div>
                <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b" }}>
                  1. {activeClientName} Master & Recon workbook sync ({activeClientObj?.masterTabCount || 0} master / {activeClientObj?.reconTabCount || 0} recon tabs)
                </div>
                <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px" }}>
                  {hasRealMasterSheet
                    ? "Copies all Master & Recon tabs, values, formulas, invoices, and direct costs from Google Sheets into Supabase."
                    : "Provisioned directly in Supabase — no Google Master or Recon sheet exists to sync from."}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleMigrateClient(activeClientName)}
                disabled={!s2Ready || !hasRealMasterSheet || isBusy}
                style={{
                  padding: "7px 14px",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#ffffff",
                  background: !s2Ready || !hasRealMasterSheet || isBusy ? "#94a3b8" : "#1a56db",
                  border: "none",
                  borderRadius: "6px",
                  cursor: !s2Ready || !hasRealMasterSheet ? "not-allowed" : isBusy ? "wait" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {activeOp?.key === "migrate" && <Spinner size={12} color="#ffffff" style={{ marginRight: 0 }} />}
                <span>
                  {activeOp?.key === "migrate"
                    ? `Syncing ${activeClientName}...`
                    : `1. Sync ${activeClientName} Master & Recon`}
                </span>
              </button>
            </div>

            {/* Step 2 & Step 3 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                gap: "12px",
                marginBottom: "12px",
              }}
            >
              {/* Step 2 */}
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "12px 14px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: "1 1 200px" }}>
                  <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b" }}>
                    2. {activeClientName} Client Sheet IMPORTRANGE links
                  </div>
                  <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px" }}>
                    {!hasRealClientSheet
                      ? `Provisioned directly in Supabase — no Google Client Sheet exists.`
                      : !hasRealMasterSheet
                        ? `Client Sheet is already materialized (Master runs natively in Supabase).`
                        : isMaterialized
                          ? `IMPORTRANGEs removed: ${activeClientName} Client Sheet uses direct values (original formulas backed up).`
                          : `Replaces Master Sheet IMPORTRANGE formulas on ${activeClientName} Client Sheet (with 1-click rollback).`}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    disabled={!s2Ready || !hasRealClientSheet || !hasRealMasterSheet || isBusy}
                    onClick={() => handleMaterialize(false, activeClientName)}
                    style={{
                      padding: "6px 11px",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: isMaterialized ? "#dcfce7" : "#ffffff",
                      color: !hasRealClientSheet || !hasRealMasterSheet ? "#94a3b8" : isMaterialized ? "#166534" : "#1e293b",
                      cursor: !s2Ready || !hasRealClientSheet || !hasRealMasterSheet ? "not-allowed" : isBusy ? "wait" : "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    {activeOp?.key === "materialize" && <Spinner size={11} color="#1e293b" style={{ marginRight: 0 }} />}
                    <span>
                      {activeOp?.key === "materialize"
                        ? "Working..."
                        : isMaterialized
                          ? "Re-sync Client Sheet values"
                          : "2. Remove Master IMPORTRANGEs"}
                    </span>
                  </button>
                  {isMaterialized && hasRealClientSheet && hasRealMasterSheet && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleMaterialize(true, activeClientName)}
                      style={{
                        padding: "6px 10px",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        background: "#ffffff",
                        color: "#475569",
                        cursor: isBusy ? "wait" : "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                      }}
                    >
                      {activeOp?.key === "restore_ir" && <Spinner size={11} color="#475569" style={{ marginRight: 0 }} />}
                      <span>{activeOp?.key === "restore_ir" ? "Restoring..." : "Restore IMPORTRANGEs"}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Step 3 */}
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "12px 14px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: "1 1 200px" }}>
                  <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b" }}>
                    3. {activeClientName} Master & Recon engine mode
                  </div>
                  <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px" }}>
                    {activeClientMode === "supabase"
                      ? hasRealMasterSheet
                        ? `Active: all ${activeClientName} Master & Recon reads, writes, comparisons, and syncs run on Supabase.`
                        : `Active (Supabase-native): ${activeClientName} Master & Recon run on Supabase (no Google Master Sheet).`
                      : `Legacy: ${activeClientName} is currently reading from its Google Master & Recon sheets.`}
                  </div>
                </div>

                <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
                  <button
                    type="button"
                    disabled={!hasRealMasterSheet || isBusy}
                    title={!hasRealMasterSheet ? "No Google Master Sheet was provisioned for this client." : undefined}
                    onClick={() => handleSetMasterMode("sheet", activeClientName)}
                    style={{
                      padding: "5px 10px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "5px",
                      border: "none",
                      cursor: !hasRealMasterSheet ? "not-allowed" : isBusy ? "wait" : "pointer",
                      background: activeClientMode === "sheet" ? "#ffffff" : "transparent",
                      color: !hasRealMasterSheet ? "#94a3b8" : activeClientMode === "sheet" ? "#0f172a" : "#475569",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    {activeOp?.key === "master_mode_sheet" && <Spinner size={11} color="#0f172a" style={{ marginRight: 0 }} />}
                    <span>{activeOp?.key === "master_mode_sheet" ? "Switching..." : "Google Sheets"}</span>
                  </button>
                  <button
                    type="button"
                    disabled={!s2Ready || !hasVirtualTabs || isBusy}
                    onClick={() => handleSetMasterMode("supabase", activeClientName)}
                    style={{
                      padding: "5px 10px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "5px",
                      border: "none",
                      cursor: !s2Ready || !hasVirtualTabs ? "not-allowed" : isBusy ? "wait" : "pointer",
                      background: activeClientMode === "supabase" ? "#166534" : "transparent",
                      color: activeClientMode === "supabase" ? "#ffffff" : "#475569",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    {activeOp?.key === "master_mode_supabase" && (
                      <Spinner size={11} color={activeClientMode === "supabase" ? "#ffffff" : "#166534"} style={{ marginRight: 0 }} />
                    )}
                    <span>{activeOp?.key === "master_mode_supabase" ? "Switching..." : "Supabase engine"}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Step 4 & Step 5 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                gap: "12px",
              }}
            >
              {/* Step 4 */}
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "12px 14px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: "1 1 200px" }}>
                  <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b" }}>
                    4. {activeClientName} Client Sheet & Supabase data sync ({activeClientObj?.clientTabCount || 0} tabs)
                  </div>
                  <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px" }}>
                    {!hasRealClientSheet
                      ? `Provisioned directly in Supabase (${activeClientObj?.clientTabCount || 31} virtual Client tabs seeded — no Google Client Sheet exists).`
                      : hasClientVirtualTabs
                        ? `Seeded: ${activeClientObj?.clientTabCount || 31} Client Sheet tabs & cell notes stored in Supabase.`
                        : `Copy ${activeClientName} Client Sheet tabs (values, formulas & cell notes) between Google Sheets and Supabase.`}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                  {hasClientVirtualTabs && (
                    <button
                      type="button"
                      onClick={() => {
                        setInspectorInitialRole("client");
                        setInspectorOpen(true);
                      }}
                      style={{
                        padding: "6px 10px",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        borderRadius: "6px",
                        border: "1px solid #93c5fd",
                        background: "#eff6ff",
                        color: "#1e40af",
                        cursor: "pointer",
                      }}
                    >
                      Inspect client tabs
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!s2Ready || !hasRealClientSheet || isBusy}
                    onClick={() => handleSeedClientSheet(activeClientName, hasClientVirtualTabs)}
                    style={{
                      padding: "6px 11px",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: hasClientVirtualTabs ? "#dcfce7" : "#ffffff",
                      color: !hasRealClientSheet ? "#94a3b8" : hasClientVirtualTabs ? "#166534" : "#1e293b",
                      cursor: !s2Ready || !hasRealClientSheet ? "not-allowed" : isBusy ? "wait" : "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    {activeOp?.key === "seed_client" && <Spinner size={11} color="#166534" style={{ marginRight: 0 }} />}
                    <span>
                      {activeOp?.key === "seed_client"
                        ? "Pushing to Supabase..."
                        : "Push sheet data to Supabase"}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={!s2Ready || !hasRealClientSheet || !hasClientVirtualTabs || isBusy}
                    title={
                      !hasRealClientSheet
                        ? "No Google Client Sheet is linked for this client."
                        : !hasClientVirtualTabs
                          ? "Run Push sheet data to Supabase first so Supabase has Client data to push."
                          : "Overwrite editable cells and notes on the Google Client Sheet to match Supabase (formulas stay intact)."
                    }
                    onClick={() => handlePushSupabaseToSheet(activeClientName)}
                    style={{
                      padding: "6px 11px",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      borderRadius: "6px",
                      border: "1px solid #93c5fd",
                      background: !s2Ready || !hasRealClientSheet || !hasClientVirtualTabs ? "#f1f5f9" : "#ffffff",
                      color: !s2Ready || !hasRealClientSheet || !hasClientVirtualTabs ? "#94a3b8" : "#1e40af",
                      cursor:
                        !s2Ready || !hasRealClientSheet || !hasClientVirtualTabs
                          ? "not-allowed"
                          : isBusy
                            ? "wait"
                            : "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    {activeOp?.key === "push_supabase_to_sheet" && (
                      <Spinner size={11} color="#1e40af" style={{ marginRight: 0 }} />
                    )}
                    <span>
                      {activeOp?.key === "push_supabase_to_sheet"
                        ? "Pushing to sheet..."
                        : "Push Supabase data to sheet"}
                    </span>
                  </button>
                </div>
              </div>

              {/* Step 5 */}
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "12px 14px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: "1 1 200px" }}>
                  <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b" }}>
                    5. {activeClientName} Client Portal engine mode
                  </div>
                  <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px" }}>
                    {activeClientPortalMode === "supabase"
                      ? hasRealClientSheet
                        ? `Active: all ${activeClientName} Pulse Portal views, edits, and formula calculations run 100% on Supabase.`
                        : `Active (Supabase-native): ${activeClientName} Pulse Portal runs on Supabase (no Google Client Sheet).`
                      : `Legacy: ${activeClientName} Pulse Portal is currently reading and writing to its Google Client Sheet.`}
                  </div>
                </div>

                <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
                  <button
                    type="button"
                    disabled={!hasRealClientSheet || isBusy}
                    title={!hasRealClientSheet ? "No Google Client Sheet was provisioned for this client." : undefined}
                    onClick={() => handleSetClientMode("sheet", activeClientName)}
                    style={{
                      padding: "5px 10px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "5px",
                      border: "none",
                      cursor: !hasRealClientSheet ? "not-allowed" : isBusy ? "wait" : "pointer",
                      background: activeClientPortalMode === "sheet" ? "#ffffff" : "transparent",
                      color: !hasRealClientSheet ? "#94a3b8" : activeClientPortalMode === "sheet" ? "#0f172a" : "#475569",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    {activeOp?.key === "client_mode_sheet" && <Spinner size={11} color="#0f172a" style={{ marginRight: 0 }} />}
                    <span>{activeOp?.key === "client_mode_sheet" ? "Switching..." : "Google Sheets"}</span>
                  </button>
                  <button
                    type="button"
                    disabled={!s2Ready || !hasClientVirtualTabs || isBusy}
                    onClick={() => handleSetClientMode("supabase", activeClientName)}
                    style={{
                      padding: "5px 10px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "5px",
                      border: "none",
                      cursor: !s2Ready || !hasClientVirtualTabs ? "not-allowed" : isBusy ? "wait" : "pointer",
                      background: activeClientPortalMode === "supabase" ? "#1e40af" : "transparent",
                      color: activeClientPortalMode === "supabase" ? "#ffffff" : "#475569",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    {activeOp?.key === "client_mode_supabase" && (
                      <Spinner size={11} color={activeClientPortalMode === "supabase" ? "#ffffff" : "#1e40af"} style={{ marginRight: 0 }} />
                    )}
                    <span>{activeOp?.key === "client_mode_supabase" ? "Switching..." : "Supabase engine"}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Step 6: Bidirectional Google Sheet bridge */}
            <div
              style={{
                marginTop: "12px",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                padding: "12px 14px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: "1 1 260px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b" }}>
                      6. {activeClientName} Google Sheet bidirectional bridge
                    </span>
                    <span
                      style={{
                        padding: "2px 7px",
                        borderRadius: "999px",
                        fontSize: "10.5px",
                        fontWeight: 600,
                        background:
                          activeSheetBridgeMode === "live"
                            ? "#dcfce7"
                            : activeSheetBridgeMode === "dry_run"
                              ? "#fef3c7"
                              : "#e2e8f0",
                        color:
                          activeSheetBridgeMode === "live"
                            ? "#166534"
                            : activeSheetBridgeMode === "dry_run"
                              ? "#92400e"
                              : "#475569",
                      }}
                    >
                      {activeSheetBridgeMode === "live"
                        ? "Live sync"
                        : activeSheetBridgeMode === "dry_run"
                          ? "Dry run"
                          : "Off"}
                    </span>
                  </div>
                  <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px", lineHeight: 1.45 }}>
                    {!hasRealClientSheet
                      ? "No Google Client Sheet is linked for this tenant."
                      : activeClientPortalMode !== "supabase" || !hasClientVirtualTabs
                        ? "Requires Step 4 (Push sheet data to Supabase) and Step 5 (Supabase engine) to be active before enabling."
                        : activeSheetBridgeMode === "live"
                          ? `Supabase-primary with automatic 3-way cell sync to and from ${activeClientName}'s editable Google Client Sheet (Drive v${activeSheetBridgeState?.lastSyncedDriveVersion || "?"}).`
                          : activeSheetBridgeMode === "dry_run"
                            ? `Logs exact outbound cell diffs without writing to ${activeClientName}'s Google Sheet (Drive v${activeSheetBridgeState?.lastSyncedDriveVersion || "?"}).`
                            : "Turn on Dry run first to preview diffs safely, then Live sync when verified."}
                  </div>
                  {activeSheetBridgeState?.lastSummary && (
                    <div style={{ fontSize: "11px", color: "#334155", marginTop: "4px" }}>
                      <strong>Latest status:</strong> {activeSheetBridgeState.lastSummary}
                      {activeSheetBridgeState.lastInboundAt && (
                        <span> · Inbound {formatTimestamp(activeSheetBridgeState.lastInboundAt)}</span>
                      )}
                      {activeSheetBridgeState.lastOutboundAt && (
                        <span> · Outbound {formatTimestamp(activeSheetBridgeState.lastOutboundAt)}</span>
                      )}
                    </div>
                  )}
                  {activeSheetBridgeState?.lastError && (
                    <div style={{ fontSize: "11px", color: "#dc2626", marginTop: "3px" }}>
                      <strong>Last error:</strong> {activeSheetBridgeState.lastError}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
                    {[
                      { id: "off", label: "Off" },
                      { id: "dry_run", label: "Dry run" },
                      { id: "live", label: "Live sync" },
                    ].map((opt) => {
                      const canEnable = s2Ready && hasRealClientSheet && hasClientVirtualTabs && activeClientPortalMode === "supabase";
                      const disabledOpt = (opt.id !== "off" && !canEnable) || isBusy;
                      const isActive = activeSheetBridgeMode === opt.id;
                      const activeBg =
                        opt.id === "live" ? "#166534" : opt.id === "dry_run" ? "#b45309" : "#ffffff";
                      const activeFg = opt.id === "off" ? "#0f172a" : "#ffffff";
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={disabledOpt}
                          title={
                            opt.id !== "off" && !canEnable
                              ? "Requires Step 4 (Push sheet data to Supabase), Step 5 (Supabase engine), and a linked Google Client Sheet."
                              : undefined
                          }
                          onClick={() => handleSetSheetBridgeMode(opt.id, activeClientName)}
                          style={{
                            padding: "5px 10px",
                            fontSize: "12px",
                            fontWeight: 600,
                            borderRadius: "5px",
                            border: "none",
                            cursor: disabledOpt && !isBusy ? "not-allowed" : isBusy ? "wait" : "pointer",
                            background: isActive ? activeBg : "transparent",
                            color: disabledOpt && opt.id !== "off" && !isActive ? "#94a3b8" : isActive ? activeFg : "#475569",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                          }}
                        >
                          {activeOp?.key === `bridge_mode_${opt.id}` && (
                            <Spinner size={11} color={isActive ? activeFg : "#475569"} style={{ marginRight: 0 }} />
                          )}
                          <span>{opt.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  {activeSheetBridgeMode !== "off" && (
                    <>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleSheetBridgeSync("inbound", false, activeClientName)}
                        style={{
                          padding: "6px 10px",
                          fontSize: "11.5px",
                          fontWeight: 600,
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                          background: "#ffffff",
                          color: "#1e293b",
                          cursor: isBusy ? "wait" : "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                        }}
                      >
                        {activeOp?.key === "bridge_inbound" && <Spinner size={11} color="#1e293b" style={{ marginRight: 0 }} />}
                        <span>
                          {activeSheetBridgeMode === "dry_run" ? "Preview inbound diff" : "Pull from sheet now"}
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleSheetBridgeSync("outbound", false, activeClientName)}
                        style={{
                          padding: "6px 10px",
                          fontSize: "11.5px",
                          fontWeight: 600,
                          borderRadius: "6px",
                          border: "1px solid #93c5fd",
                          background: "#eff6ff",
                          color: "#1e40af",
                          cursor: isBusy ? "wait" : "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                        }}
                      >
                        {activeOp?.key === "bridge_outbound" && <Spinner size={11} color="#1e40af" style={{ marginRight: 0 }} />}
                        <span>
                          {activeSheetBridgeMode === "dry_run" ? "Preview outbound diff" : "Push diff to sheet now"}
                        </span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              {Array.isArray(activeSheetBridgeState?.recentLogs) && activeSheetBridgeState.recentLogs.length > 0 && (
                <div
                  style={{
                    marginTop: "10px",
                    borderTop: "1px solid #e2e8f0",
                    paddingTop: "8px",
                    maxHeight: "190px",
                    overflowY: "auto",
                  }}
                >
                  <div style={{ fontSize: "11px", fontWeight: 700, color: "#475569", marginBottom: "5px" }}>
                    Recent bridge activity
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    {activeSheetBridgeState.recentLogs.slice(0, 8).map((log, idx) => (
                      <div
                        key={`${log.timestamp || idx}-${idx}`}
                        style={{
                          fontSize: "11px",
                          background: "#ffffff",
                          border: `1px solid ${log.error ? "#fecaca" : "#e2e8f0"}`,
                          borderRadius: "5px",
                          padding: "5px 8px",
                          color: log.error ? "#b91c1c" : "#334155",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                          <span>
                            <strong style={{ textTransform: "uppercase", fontSize: "10px", marginRight: "6px" }}>
                              [{log.mode === "dry_run" ? "Dry run" : log.mode || "Bridge"}]
                            </strong>
                            {log.summary}
                          </span>
                          <span style={{ color: "#64748b", fontSize: "10px" }}>
                            {formatTimestamp(log.timestamp)}
                          </span>
                        </div>
                        {Array.isArray(log.readableRows) && log.readableRows.length > 0 ? (
                          <div style={{ marginTop: "4px", display: "flex", flexDirection: "column", gap: "3px", fontSize: "11px", color: "#334155" }}>
                            {log.readableRows.slice(0, 8).map((rowItem, rIdx) => (
                              <div key={rIdx} style={{ lineHeight: 1.4 }}>
                                <strong style={{ color: "#0f172a" }}>
                                  {rowItem.directionLabel} · {rowItem.tab} · {rowItem.rowLabel}:
                                </strong>{" "}
                                <span>{rowItem.changesText}</span>
                                {rowItem.moreCount > 0 && (
                                  <span style={{ color: "#64748b" }}> (+{rowItem.moreCount} more)</span>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : Array.isArray(log.sampleDiffs) && log.sampleDiffs.length > 0 ? (
                          <div style={{ marginTop: "3px", fontFamily: "monospace", fontSize: "10px", color: "#475569" }}>
                            {log.sampleDiffs.slice(0, 5).map((d, dIdx) => (
                              <span key={dIdx} style={{ marginRight: "10px" }}>
                                {d.direction === "in" ? "Sheet→SB" : "SB→Sheet"} {d.tab}!{d.cell}: {JSON.stringify(d.from ?? "")} → {JSON.stringify(d.to ?? "")}
                              </span>
                            ))}
                            {log.sampleDiffs.length > 5 && <span>+{log.sampleDiffs.length - 5} more</span>}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* SECTION 4: Supabase 30-minute cron scheduler */}
          <div style={cardStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                  Supabase {formatCronScheduleLabel(cs?.schedule).adjective} cron scheduler
                </h2>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    padding: "2px 8px",
                    borderRadius: "999px",
                    background: activeAndRunning ? "#dcfce7" : "#fef3c7",
                    color: activeAndRunning ? "#166534" : "#92400e",
                  }}
                >
                  {activeAndRunning ? `Active (${formatCronScheduleLabel(cs?.schedule).interval})` : "Paused"}
                </span>
                {cs?.lastWebhookReceivedAt && (
                  <span style={{ fontSize: "11.5px", color: "#64748b" }}>
                    Last run: <b>{new Date(cs.lastWebhookReceivedAt).toLocaleString("en-GB")}</b>
                  </span>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                {(() => {
                  const rawSched = String(cs?.schedule || "*/10 * * * *").trim();
                  const normSched = rawSched === "*/1 * * * *" ? "* * * * *" : rawSched;
                  const hasKnownOption = CLOCK_SCHEDULE_OPTIONS.some((o) => o.value === normSched);
                  return (
                    <select
                      aria-label="Wake-clock interval"
                      disabled={!rpcReady || isBusy}
                      value={normSched}
                      onChange={(e) => handleSetClockSchedule(e.target.value)}
                      style={{
                        padding: "6px 10px",
                        fontSize: "12px",
                        fontWeight: 600,
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        background: "#ffffff",
                        color: !rpcReady ? "#9ca3af" : "#1e293b",
                        cursor: !rpcReady ? "not-allowed" : isBusy ? "wait" : "pointer",
                      }}
                    >
                      {!hasKnownOption && normSched && (
                        <option value={normSched}>{normSched}</option>
                      )}
                      {CLOCK_SCHEDULE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  );
                })()}

                <button
                  type="button"
                  disabled={!rpcReady || isBusy}
                  onClick={handleTriggerClockNow}
                  style={{
                    padding: "6px 12px",
                    fontSize: "12px",
                    fontWeight: 600,
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: !rpcReady ? "#9ca3af" : "#1e293b",
                    cursor: !rpcReady ? "not-allowed" : isBusy ? "wait" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                  }}
                >
                  {activeOp?.key === "clock_trigger" && <Spinner size={11} color="#1e293b" style={{ marginRight: 0 }} />}
                  <span>{activeOp?.key === "clock_trigger" ? "Triggering..." : "Run scheduler now"}</span>
                </button>

                <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleSetClockEnabled(false)}
                    style={{
                      padding: "5px 10px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "5px",
                      border: "none",
                      cursor: isBusy ? "wait" : "pointer",
                      background: !clockEnabled ? "#ffffff" : "transparent",
                      color: !clockEnabled ? "#0f172a" : "#475569",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    {activeOp?.key === "clock_pause" && <Spinner size={11} color="#0f172a" style={{ marginRight: 0 }} />}
                    <span>Paused</span>
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleSetClockEnabled(true)}
                    style={{
                      padding: "5px 10px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "5px",
                      border: "none",
                      cursor: isBusy ? "wait" : "pointer",
                      background: clockEnabled ? "#166534" : "transparent",
                      color: clockEnabled ? "#ffffff" : "#475569",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    {activeOp?.key === "clock_enable" && (
                      <Spinner size={11} color={clockEnabled ? "#ffffff" : "#166534"} style={{ marginRight: 0 }} />
                    )}
                    <span>Enabled</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* SECTION 4.5: Phase 2 Relational Jobs Engine */}
          <div style={cardStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: "12px",
                flexWrap: "wrap",
                marginBottom: "10px",
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                  Relational jobs engine (Phase 2)
                </h2>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748b" }}>
                  UUID-backed storage for jobs, retainer series, unlimited invoices, and direct expenses with lossless projection back into virtual grids.
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <span
                  style={{
                    padding: "3px 9px",
                    borderRadius: "999px",
                    fontSize: "11px",
                    fontWeight: 600,
                    background: stage2Data?.phase2Jobs?.schemaReady ? "#dcfce7" : "#fef3c7",
                    color: stage2Data?.phase2Jobs?.schemaReady ? "#166534" : "#92400e",
                  }}
                >
                  {stage2Data?.phase2Jobs?.schemaReady ? "Schema ready (0012)" : "Migration 0012 required"}
                </span>
                {stage2Data?.phase2Jobs?.schemaReady && (
                  <span
                    style={{
                      padding: "3px 9px",
                      borderRadius: "999px",
                      fontSize: "11px",
                      fontWeight: 600,
                      background: "#eff6ff",
                      color: "#1e40af",
                    }}
                  >
                    {`${stage2Data.phase2Jobs.relationalModeClientsCount || 0} relational · ${stage2Data.phase2Jobs.backfilledClientsCount || 0}/${allClients.length} backfilled`}
                  </span>
                )}
              </div>
            </div>

            {!stage2Data?.phase2Jobs?.schemaReady && stage2Data?.phase2Jobs?.migrationSql && (
              <div
                style={{
                  marginBottom: "12px",
                  padding: "10px 12px",
                  borderRadius: "7px",
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                  flexWrap: "wrap",
                  fontSize: "12px",
                  color: "#92400e",
                }}
              >
                <span>
                  Run migration 0012 in the Supabase SQL editor to create pulse_retainer_series, pulse_jobs, pulse_job_invoices, and pulse_job_expenses.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (typeof navigator !== "undefined" && navigator.clipboard) {
                      navigator.clipboard.writeText(stage2Data.phase2Jobs.migrationSql);
                      setCopied0012Sql(true);
                      setTimeout(() => setCopied0012Sql(false), 2500);
                    }
                  }}
                  style={{
                    padding: "5px 10px",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    borderRadius: "6px",
                    border: "1px solid #f59e0b",
                    background: "#ffffff",
                    color: "#92400e",
                    cursor: "pointer",
                  }}
                >
                  {copied0012Sql ? "Copied migration 0012 SQL" : "Copy migration 0012 SQL"}
                </button>
              </div>
            )}

            {stage2Data?.phase2Jobs?.schemaReady && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "8px",
                  marginBottom: "12px",
                }}
              >
                {[
                  { label: "Relational jobs", value: stage2Data.phase2Jobs.totalJobs || 0 },
                  { label: "Retainer series", value: stage2Data.phase2Jobs.totalSeries || 0 },
                  { label: "Job invoices", value: stage2Data.phase2Jobs.totalInvoices || 0 },
                  { label: "Direct expenses", value: stage2Data.phase2Jobs.totalExpenses || 0 },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    style={{
                      padding: "8px 10px",
                      borderRadius: "6px",
                      background: "#f8fafc",
                      border: "1px solid #e2e8f0",
                    }}
                  >
                    <div style={{ fontSize: "11px", color: "#64748b" }}>{stat.label}</div>
                    <div style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                      {Number(stat.value).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                disabled={!stage2Data?.phase2Jobs?.schemaReady || isBusy}
                onClick={() => handleBackfillRelationalJobs(false, activeClientName)}
                style={{
                  ...actionBtnBase,
                  background: !stage2Data?.phase2Jobs?.schemaReady ? "#f3f4f6" : "#ffffff",
                  color: !stage2Data?.phase2Jobs?.schemaReady ? "#9ca3af" : "#1e293b",
                  cursor: !stage2Data?.phase2Jobs?.schemaReady ? "not-allowed" : isBusy ? "wait" : "pointer",
                }}
              >
                {activeOp?.key === "rel_jobs_backfill_one" && <Spinner size={11} color="#1e293b" style={{ marginRight: 0 }} />}
                <span>{`Backfill ${activeClientName}`}</span>
              </button>

              <button
                type="button"
                disabled={!stage2Data?.phase2Jobs?.schemaReady || isBusy}
                onClick={() => handleBackfillRelationalJobs(true)}
                style={{
                  ...actionBtnBase,
                  background: !stage2Data?.phase2Jobs?.schemaReady ? "#f3f4f6" : "#eff6ff",
                  borderColor: !stage2Data?.phase2Jobs?.schemaReady ? "#cbd5e1" : "#93c5fd",
                  color: !stage2Data?.phase2Jobs?.schemaReady ? "#9ca3af" : "#1e40af",
                  cursor: !stage2Data?.phase2Jobs?.schemaReady ? "not-allowed" : isBusy ? "wait" : "pointer",
                }}
              >
                {activeOp?.key === "rel_jobs_backfill_all" && <Spinner size={11} color="#1e40af" style={{ marginRight: 0 }} />}
                <span>{`Backfill all clients (${allClients.length})`}</span>
              </button>

              <button
                type="button"
                disabled={!s2Ready || isBusy}
                onClick={() => handleVerifyRelationalParity(true)}
                style={{
                  ...actionBtnBase,
                  background: "#ffffff",
                  borderColor: "#cbd5e1",
                  color: "#1e293b",
                  cursor: !s2Ready ? "not-allowed" : isBusy ? "wait" : "pointer",
                }}
              >
                {activeOp?.key === "rel_jobs_parity" && <Spinner size={11} color="#1e293b" style={{ marginRight: 0 }} />}
                <span>{`Verify relational parity (${allClients.length})`}</span>
              </button>

              <button
                type="button"
                disabled={!stage2Data?.phase2Jobs?.schemaReady || isBusy}
                onClick={() =>
                  handleSetClientJobsMode(
                    activeClientObj?.jobsMode === "relational" ? "grid" : "relational",
                    activeClientName
                  )
                }
                style={{
                  ...actionBtnBase,
                  background: !stage2Data?.phase2Jobs?.schemaReady
                    ? "#f3f4f6"
                    : activeClientObj?.jobsMode === "relational"
                      ? "#fef2f2"
                      : "#f0fdf4",
                  borderColor: !stage2Data?.phase2Jobs?.schemaReady
                    ? "#cbd5e1"
                    : activeClientObj?.jobsMode === "relational"
                      ? "#fecaca"
                      : "#86efac",
                  color: !stage2Data?.phase2Jobs?.schemaReady
                    ? "#9ca3af"
                    : activeClientObj?.jobsMode === "relational"
                      ? "#b91c1c"
                      : "#166534",
                  cursor: !stage2Data?.phase2Jobs?.schemaReady ? "not-allowed" : isBusy ? "wait" : "pointer",
                }}
              >
                <span>
                  {activeClientObj?.jobsMode === "relational"
                    ? `Revert ${activeClientName} to grid jobs`
                    : `Switch ${activeClientName} to relational jobs`}
                </span>
              </button>

              {activeClientObj?.jobsMode === "relational" && (
                <button
                  type="button"
                  disabled={!stage2Data?.phase2Jobs?.schemaReady || isBusy}
                  onClick={() =>
                    handleSetClientJobsReadMode(
                      activeClientObj?.jobsReadMode === "relational" ? "grid" : "relational",
                      activeClientName
                    )
                  }
                  style={{
                    ...actionBtnBase,
                    background: activeClientObj?.jobsReadMode === "relational" ? "#fff7ed" : "#ecfeff",
                    borderColor: activeClientObj?.jobsReadMode === "relational" ? "#fed7aa" : "#67e8f9",
                    color: activeClientObj?.jobsReadMode === "relational" ? "#9a3412" : "#155e75",
                    cursor: isBusy ? "wait" : "pointer",
                  }}
                >
                  <span>
                    {activeClientObj?.jobsReadMode === "relational"
                      ? `Revert ${activeClientName} to grid reads`
                      : `Switch ${activeClientName} to direct relational reads`}
                  </span>
                </button>
              )}

              <button
                type="button"
                disabled={!s2Ready || isBusy}
                onClick={() => handleVerifyRelationalReadParity(true)}
                style={{
                  ...actionBtnBase,
                  background: "#ffffff",
                  borderColor: "#cbd5e1",
                  color: "#1e293b",
                  cursor: !s2Ready ? "not-allowed" : isBusy ? "wait" : "pointer",
                }}
              >
                {activeOp?.key === "rel_jobs_read_parity" && <Spinner size={11} color="#1e293b" style={{ marginRight: 0 }} />}
                <span>{`Verify read payload parity (${allClients.length})`}</span>
              </button>
            </div>

            {relationalParityReport && (
              <div
                style={{
                  marginTop: "12px",
                  padding: "10px 12px",
                  borderRadius: "7px",
                  background: "#f8fafc",
                  border: `1px solid ${relationalParityReport.mismatchClientsCount > 0 || relationalParityReport.errorClientsCount > 0 ? "#fde68a" : "#bbf7d0"}`,
                  fontSize: "11.5px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <strong style={{ color: "#0f172a" }}>
                    {`Relational jobs parity (${formatTimestamp(relationalParityReport.checkedAt)}) — ${relationalParityReport.matchedClientsCount || 0} of ${relationalParityReport.clientsChecked || 0} clients match 100%`}
                  </strong>
                  <button
                    type="button"
                    onClick={() => setRelationalParityReport(null)}
                    style={{ padding: "2px 7px", fontSize: "11px", borderRadius: "4px", border: "1px solid #cbd5e1", background: "#ffffff", cursor: "pointer" }}
                  >
                    Hide
                  </button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {(relationalParityReport.results || []).map((r) => (
                    <span
                      key={r.clientName}
                      title={r.error || `Confirmed: ${r.confirmedJobsCount}, Pipeline: ${r.pipelineJobsCount} (${r.source})`}
                      style={{
                        padding: "2px 8px",
                        borderRadius: "999px",
                        fontSize: "10.5px",
                        fontWeight: 600,
                        background: r.error || !r.matched ? "#fee2e2" : "#dcfce7",
                        color: r.error || !r.matched ? "#991b1b" : "#166534",
                      }}
                    >
                      {`${r.clientName}: ${r.matched ? `${r.confirmedJobsCount || 0}c/${r.pipelineJobsCount || 0}p (${r.source})` : r.error || `${r.totalMismatchCount} diffs`}`}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* SECTION 5: Client workbook backups & granular restore (permanently visible) */}
          {s2Ready && (
            <div style={cardStyle}>
              <SupabaseBackupManagerPanel
                activeClientName={activeClientName}
                automationCommanderSheetId={automationCommanderSheetId}
                availableTabs={stage2Data?.availableTabs || { master: [], recon: [], client: [] }}
                onFeedback={(msg) => {
                  setFeedbackMsg(msg);
                  if (msg?.text) showToast({ type: msg.type, text: msg.text });
                }}
                onAfterRestore={(newStatus) => {
                  if (newStatus) setStage2Data(newStatus);
                }}
              />
            </div>
          )}
        </>
      )}

      {/* Floating Bottom-Right Live Feedback Toast */}
      {(activeOp || toastMsg) && (
        <div
          style={{
            position: "fixed",
            bottom: "20px",
            right: "24px",
            zIndex: 9000,
            maxWidth: "420px",
            padding: "11px 14px",
            borderRadius: "9px",
            boxShadow: "0 12px 28px rgba(15, 23, 42, 0.22)",
            background: activeOp
              ? "#0f172a"
              : toastMsg?.type === "error"
                ? "#7f1d1d"
                : "#065f46",
            color: "#ffffff",
            fontSize: "12.5px",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {activeOp && <Spinner size={13} color="#93c5fd" style={{ marginRight: 0 }} />}
            <span>
              {activeOp
                ? `${activeOp.label} (${(elapsedMs / 1000).toFixed(1)}s)`
                : toastMsg?.text}
            </span>
          </div>
          {!activeOp && toastMsg && (
            <button
              type="button"
              onClick={() => setToastMsg(null)}
              style={{
                background: "none",
                border: "none",
                color: "#ffffff",
                opacity: 0.85,
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: 700,
                padding: 0,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* Workbook & Logs Inspector Modal */}
      {inspectorOpen && (
        <AdminWorkbookInspectorModal
          isOpen={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
          clientName={activeClientName}
          availableTabs={stage2Data?.availableTabs || { master: [], recon: [], client: [] }}
          initialSheetRole={inspectorInitialRole}
        />
      )}

      {/* Formatted Comparison Sheet Modal (InvComp / DirComp / CRMComp) */}
      {comparisonModalOpen && (
        <MasterComparisonSheetModal
          isOpen={comparisonModalOpen}
          onClose={() => setComparisonModalOpen(false)}
          clientName={activeClientName}
          initialTab={comparisonModalTab}
          onAfterMutate={(resData) => {
            if (resData?.status) setStage2Data(resData.status);
          }}
        />
      )}

      {/* Formatted Client Sheet Modal (Confirmed / Pipeline / Cash / NBtoFind / Outgoings / Salaries / Budget) */}
      {clientSheetModalOpen && (
        <ClientSheetModal
          isOpen={clientSheetModalOpen}
          onClose={() => setClientSheetModalOpen(false)}
          clientName={activeClientName}
          initialTab={clientSheetModalTab}
          onAfterMutate={(resData) => {
            invalidateComparisonModalCache(activeClientName);
            if (resData?.status) setStage2Data(resData.status);
          }}
        />
      )}

      {/* Formatted Recon Sheet Modal (Monthly YYMM tabs, newest on the left) */}
      {reconModalOpen && (
        <ReconSheetModal
          isOpen={reconModalOpen}
          onClose={() => setReconModalOpen(false)}
          clientName={activeClientName}
          reconTabs={reconMonthTabs}
          initialTab={reconMonthTabs[0] || ""}
          onAfterMutate={(resData) => {
            if (resData?.status) setStage2Data(resData.status);
          }}
        />
      )}

      {/* Formatted TimeComp Sheet Modal */}
      {timeCompModalOpen && (
        <TimeCompSheetModal
          isOpen={timeCompModalOpen}
          onClose={() => setTimeCompModalOpen(false)}
          clientName={activeClientName}
          onAfterMutate={(resData) => {
            if (resData?.status) setStage2Data(resData.status);
          }}
        />
      )}
    </div>
  );
}
