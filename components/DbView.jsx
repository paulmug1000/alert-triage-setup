import React, { useState, useEffect, useCallback, useRef } from "react";
import Spinner from "./Spinner";
import AdminWorkbookInspectorModal from "./AdminWorkbookInspectorModal";
import MasterComparisonSheetModal, {
  prefetchComparisonTab,
  invalidateComparisonModalCache,
} from "./MasterComparisonSheetModal";
import SupabaseBackupManagerPanel from "./SupabaseBackupManagerPanel";

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
  const [showAllClients, setShowAllClients] = useState(false);
  const [stage2Data, setStage2Data] = useState(null);
  const [stage2Loading, setStage2Loading] = useState(true);

  // Live operation progress & feedback state
  const [activeOp, setActiveOp] = useState(null); // { key, label, startedAt }
  const [elapsedMs, setElapsedMs] = useState(0);
  const [feedbackMsg, setFeedbackMsg] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const toastTimerRef = useRef(null);

  // Alert memory panel state
  const [showAlertMemoryTool, setShowAlertMemoryTool] = useState(false);
  const [amQuery, setAmQuery] = useState("");
  const [amStatusFilter, setAmStatusFilter] = useState("handled_only");
  const [amEntries, setAmEntries] = useState([]);
  const [amLoading, setAmLoading] = useState(false);
  const [amDeletingHash, setAmDeletingHash] = useState("");
  const [amManualHash, setAmManualHash] = useState("");
  const [amFlushing, setAmFlushing] = useState(false);

  // Inspector & Formatted Comparison Sheet modals
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorInitialRole, setInspectorInitialRole] = useState("master");
  const [comparisonModalOpen, setComparisonModalOpen] = useState(false);
  const [comparisonModalTab, setComparisonModalTab] = useState("InvComp");

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

  const handleSeedClientSheet = (clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedClient;
    runTrackedOperation("seed_client", `Seeding ${targetClient} Client Sheet into Supabase...`, async () => {
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
      if (!data.success) throw new Error(data.error || "Client Sheet seeding failed.");
      if (data.status) setStage2Data(data.status);
      const s = data.summary || {};
      return {
        type: "success",
        text: `Seeded ${targetClient} Client Sheet into Supabase (${s.clientTabsSynced || 0} client tabs, ${s.outgoingsNotesCount || 0} outgoings cell notes).`,
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

  const handleSetClockEnabled = (enabled) => {
    runTrackedOperation(
      enabled ? "clock_enable" : "clock_pause",
      enabled ? "Enabling Supabase 30-minute cron scheduler..." : "Pausing Supabase 30-minute cron scheduler...",
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
        return {
          type: "success",
          text: enabled
            ? "Supabase 30-minute cron scheduler enabled."
            : "Supabase 30-minute cron scheduler paused.",
        };
      }
    );
  };

  const handleTriggerClockNow = () => {
    runTrackedOperation("clock_trigger", "Triggering Supabase 30-minute cron scheduler now...", async () => {
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
      return {
        type: "success",
        text: `Triggered Supabase 30-minute cron scheduler (request #${tr.requestId ?? "ok"} -> ${tr.targetUrl || "/api/cron"}).`,
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

  const supabaseEngineClientsCount = allClients.filter((c) => c.master_mode === "supabase").length;
  const supabasePortalClientsCount = allClients.filter((c) => c.client_mode === "supabase").length;
  const migratedClientsCount = allClients.filter(
    (c) => (c.masterTabCount || 0) + (c.reconTabCount || 0) + (c.clientTabCount || 0) > 0
  ).length;

  const visibleOverviewClients = showAllClients
    ? allClients
    : allClients.filter(
        (c) =>
          c.master_mode === "supabase" ||
          c.client_mode === "supabase" ||
          (c.masterTabCount || 0) + (c.reconTabCount || 0) + (c.clientTabCount || 0) > 0 ||
          String(c.client_name || "").trim().toUpperCase() ===
            String(activeClientName || "").trim().toUpperCase()
      );

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
                  {supabaseEngineClientsCount} master live · {supabasePortalClientsCount} portal live · {migratedClientsCount} synced
                </span>
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
                const next = !showAlertMemoryTool;
                setShowAlertMemoryTool(next);
                if (next && amEntries.length === 0) {
                  handleSearchAlertMemory();
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
              <input
                type="text"
                value={amQuery}
                onChange={(e) => setAmQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearchAlertMemory();
                }}
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
      </div>

      {/* Initial Full-Screen Loading Skeleton (never flashes "No data available") */}
      {isInitialLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {["Manage client", "Client engine overview", "Migration", "Supabase 30-minute cron scheduler", "Client workbook backups & granular restore"].map((secTitle) => (
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
              </div>
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
                Client engine overview ({visibleOverviewClients.length} of {allClients.length} clients shown)
              </h2>
              <button
                type="button"
                onClick={() => setShowAllClients((prev) => !prev)}
                style={{
                  padding: "5px 11px",
                  fontSize: "11.5px",
                  fontWeight: 600,
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#334155",
                  cursor: "pointer",
                }}
              >
                {showAllClients
                  ? "Show migrated & selected clients only"
                  : `Show all ${allClients.length} clients`}
              </button>
            </div>

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
                    {visibleOverviewClients.map((c) => {
                      const isSelected =
                        String(c.client_name || "").trim().toUpperCase() ===
                        String(activeClientName || "").trim().toUpperCase();
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
                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
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
                                {isClientSupabase ? "Portal: Supabase" : "Portal: Sheets"}
                              </span>
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
                  Copies all Master & Recon tabs, values, formulas, invoices, and direct costs from Google Sheets into Supabase.
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleMigrateClient(activeClientName)}
                disabled={!s2Ready || isBusy}
                style={{
                  padding: "7px 14px",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#ffffff",
                  background: !s2Ready || isBusy ? "#94a3b8" : "#1a56db",
                  border: "none",
                  borderRadius: "6px",
                  cursor: !s2Ready ? "not-allowed" : isBusy ? "wait" : "pointer",
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
                    {isMaterialized
                      ? `IMPORTRANGEs removed: ${activeClientName} Client Sheet uses direct values (original formulas backed up).`
                      : `Replaces Master Sheet IMPORTRANGE formulas on ${activeClientName} Client Sheet (with 1-click rollback).`}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    disabled={!s2Ready || isBusy}
                    onClick={() => handleMaterialize(false, activeClientName)}
                    style={{
                      padding: "6px 11px",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: isMaterialized ? "#dcfce7" : "#ffffff",
                      color: isMaterialized ? "#166534" : "#1e293b",
                      cursor: !s2Ready ? "not-allowed" : isBusy ? "wait" : "pointer",
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
                  {isMaterialized && (
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
                      ? `Active: all ${activeClientName} Master & Recon reads, writes, comparisons, and syncs run on Supabase.`
                      : `Legacy: ${activeClientName} is currently reading from its Google Master & Recon sheets.`}
                  </div>
                </div>

                <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleSetMasterMode("sheet", activeClientName)}
                    style={{
                      padding: "5px 10px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "5px",
                      border: "none",
                      cursor: isBusy ? "wait" : "pointer",
                      background: activeClientMode === "sheet" ? "#ffffff" : "transparent",
                      color: activeClientMode === "sheet" ? "#0f172a" : "#475569",
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
                    4. {activeClientName} Client Sheet virtual workbook ({activeClientObj?.clientTabCount || 0} tabs)
                  </div>
                  <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "2px" }}>
                    {hasClientVirtualTabs
                      ? `Seeded: ${activeClientObj?.clientTabCount || 31} Client Sheet tabs & Outgoings cell notes stored in Supabase.`
                      : `Seeds all 31 Client Sheet tabs (values, formulas & cell notes) for ${activeClientName} into Supabase.`}
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
                    disabled={!s2Ready || isBusy}
                    onClick={() => handleSeedClientSheet(activeClientName)}
                    style={{
                      padding: "6px 11px",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: hasClientVirtualTabs ? "#dcfce7" : "#ffffff",
                      color: hasClientVirtualTabs ? "#166534" : "#1e293b",
                      cursor: !s2Ready ? "not-allowed" : isBusy ? "wait" : "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    {activeOp?.key === "seed_client" && <Spinner size={11} color="#166534" style={{ marginRight: 0 }} />}
                    <span>
                      {activeOp?.key === "seed_client"
                        ? "Seeding..."
                        : hasClientVirtualTabs
                          ? "Re-seed Client Sheet"
                          : "4. Seed Client Sheet to Supabase"}
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
                      ? `Active: all ${activeClientName} Pulse Portal views, edits, and formula calculations run 100% on Supabase.`
                      : `Legacy: ${activeClientName} Pulse Portal is currently reading and writing to its Google Client Sheet.`}
                  </div>
                </div>

                <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleSetClientMode("sheet", activeClientName)}
                    style={{
                      padding: "5px 10px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "5px",
                      border: "none",
                      cursor: isBusy ? "wait" : "pointer",
                      background: activeClientPortalMode === "sheet" ? "#ffffff" : "transparent",
                      color: activeClientPortalMode === "sheet" ? "#0f172a" : "#475569",
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
                  Supabase 30-minute cron scheduler
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
                  {activeAndRunning ? "Active (every 30 mins)" : "Paused"}
                </span>
                {cs?.lastWebhookReceivedAt && (
                  <span style={{ fontSize: "11.5px", color: "#64748b" }}>
                    Last run: <b>{new Date(cs.lastWebhookReceivedAt).toLocaleString("en-GB")}</b>
                  </span>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
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
    </div>
  );
}
