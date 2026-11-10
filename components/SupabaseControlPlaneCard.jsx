import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";
import AdminWorkbookInspectorModal from "./AdminWorkbookInspectorModal";
import SupabaseBackupManagerPanel from "./SupabaseBackupManagerPanel";

export default function SupabaseControlPlaneCard({ automationCommanderSheetId }) {
  const [feedbackMsg, setFeedbackMsg] = useState(null);
  const [showBackupPanel, setShowBackupPanel] = useState(true);

  // Alert memory inspector & synchronized delete
  const [showAlertMemoryTool, setShowAlertMemoryTool] = useState(false);
  const [amQuery, setAmQuery] = useState("");
  const [amStatusFilter, setAmStatusFilter] = useState("handled_only");
  const [amEntries, setAmEntries] = useState([]);
  const [amLoading, setAmLoading] = useState(false);
  const [amDeletingHash, setAmDeletingHash] = useState("");
  const [amManualHash, setAmManualHash] = useState("");
  const [amFlushing, setAmFlushing] = useState(false);

  // Multi-client Master & Recon engine state
  const [selectedStage2Client, setSelectedStage2Client] = useState("APPTEST");
  const [showAllStage2Clients, setShowAllStage2Clients] = useState(false);
  const [stage2Data, setStage2Data] = useState(null);
  const [stage2Loading, setStage2Loading] = useState(true);
  const [stage2Migrating, setStage2Migrating] = useState(false);
  const [stage2Materializing, setStage2Materializing] = useState(false);
  const [stage2SwitchingMode, setStage2SwitchingMode] = useState(false);
  const [stage4Seeding, setStage4Seeding] = useState(false);
  const [stage4SwitchingMode, setStage4SwitchingMode] = useState(false);
  const [showStage4Sql, setShowStage4Sql] = useState(false);
  const [copiedStage4Sql, setCopiedStage4Sql] = useState(false);
  const [stage2SyncingType, setStage2SyncingType] = useState("");
  const [clockWorking, setClockWorking] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorInitialRole, setInspectorInitialRole] = useState("master");

  const loadStage2Status = useCallback(
    async (targetClient) => {
      const clientToLoad = targetClient || selectedStage2Client || "APPTEST";
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
        } else {
          setFeedbackMsg({ type: "error", text: data.error || "Could not load Supabase engine status." });
        }
      } catch (err) {
        setFeedbackMsg({ type: "error", text: err.message });
      } finally {
        setStage2Loading(false);
      }
    },
    [automationCommanderSheetId, selectedStage2Client]
  );

  const handleSelectStage2Client = useCallback(
    (clientName) => {
      const clean = String(clientName || "APPTEST").trim();
      setSelectedStage2Client(clean);
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem("pma_stage2_selected_client", clean);
        }
      } catch (_) { }
      loadStage2Status(clean);
    },
    [loadStage2Status]
  );

  useEffect(() => {
    let initialClient = "APPTEST";
    try {
      if (typeof window !== "undefined") {
        const saved = window.localStorage.getItem("pma_stage2_selected_client");
        if (saved && saved.trim()) {
          initialClient = saved.trim();
          setSelectedStage2Client(initialClient);
        }
      }
    } catch (_) { }
    loadStage2Status(initialClient);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStage2MigrateClient = async (clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedStage2Client;
    setStage2Migrating(true);
    setFeedbackMsg(null);
    try {
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
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        const s = data.summary || {};
        setFeedbackMsg({
          type: "success",
          text: `Synced ${targetClient} Master (${s.masterTabsSynced || 0} tabs, ${s.invoicesCount || 0} invoices, ${s.directCostsCount || 0} direct costs) & Recon (${s.reconTabsSynced || 0} tabs, ${s.reconItemsCount || 0} items) to Supabase.`,
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Client migration failed." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setStage2Migrating(false);
    }
  };

  const handleStage2SetMasterMode = async (targetMode, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedStage2Client;
    setStage2SwitchingMode(true);
    setFeedbackMsg(null);
    try {
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
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        setFeedbackMsg({
          type: "success",
          text: `Switched ${targetClient} Master & Recon engine to ${targetMode === "supabase" ? "Supabase engine" : "Google Sheets (legacy)"}.`,
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Could not switch master mode." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setStage2SwitchingMode(false);
    }
  };

  const handleSeedClientSheet = async (clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedStage2Client;
    setStage4Seeding(true);
    setFeedbackMsg(null);
    try {
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
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        const s = data.summary || {};
        setFeedbackMsg({
          type: "success",
          text: `Seeded ${targetClient} Client Sheet into Supabase (${s.clientTabsSynced || 0} client tabs, ${s.outgoingsNotesCount || 0} outgoings cell notes).`,
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Client Sheet seeding failed." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setStage4Seeding(false);
    }
  };

  const handleSetClientMode = async (targetMode, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedStage2Client;
    setStage4SwitchingMode(true);
    setFeedbackMsg(null);
    try {
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
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        setFeedbackMsg({
          type: "success",
          text: `Switched ${targetClient} Client Portal engine to ${targetMode === "supabase" ? "Supabase engine" : "Google Sheets (legacy)"}.`,
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Could not switch client portal mode." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setStage4SwitchingMode(false);
    }
  };

  const handleStage2Materialize = async (restore = false, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedStage2Client;
    setStage2Materializing(true);
    setFeedbackMsg(null);
    try {
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
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        setFeedbackMsg({
          type: "success",
          text: restore
            ? `Restored ${data.restoredRangesCount || 0} original IMPORTRANGE formulas on ${targetClient} Client Sheet.`
            : `Removed ${data.materializedRangesCount || 0} Master IMPORTRANGE links on ${targetClient} Client Sheet (original formulas backed up in Supabase).`,
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Operation failed." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setStage2Materializing(false);
    }
  };

  const handleStage2NativeSync = async (syncType, clientOverride) => {
    const targetClient = typeof clientOverride === "string" && clientOverride ? clientOverride : selectedStage2Client;
    setStage2SyncingType(syncType);
    setFeedbackMsg(null);
    try {
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
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        const comp = data.syncResult?.comparisons || {};
        setFeedbackMsg({
          type: "success",
          text: `Completed native Supabase sync (${syncType}) on ${targetClient}: ${comp.invDiscrepancyCount ?? 0} invoice flags, ${comp.dirDiscrepancyCount ?? 0} direct cost flags, ${comp.crmDiscrepancyCount ?? 0} CRM flags.`,
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Native sync failed." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setStage2SyncingType("");
    }
  };

  const handleSetClockEnabled = async (enabled) => {
    setClockWorking(true);
    setFeedbackMsg(null);
    try {
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
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        setFeedbackMsg({
          type: "success",
          text: enabled
            ? "Supabase 30-minute wake-up clock enabled."
            : "Supabase 30-minute wake-up clock paused.",
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Could not update clock status." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setClockWorking(false);
    }
  };

  const handleTriggerClockNow = async () => {
    setClockWorking(true);
    setFeedbackMsg(null);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "trigger_clock_now",
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        const tr = data.triggerResult || {};
        if (tr.success === false) {
          setFeedbackMsg({ type: "error", text: tr.error || "Clock trigger returned an error." });
        } else {
          setFeedbackMsg({
            type: "success",
            text: `Triggered Supabase 30-minute wake-up clock (request #${tr.requestId ?? "ok"} -> ${tr.targetUrl || "/api/cron"}).`,
          });
        }
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Could not trigger clock." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setClockWorking(false);
    }
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

  const s2Ready = Boolean(stage2Data?.schemaReady);
  const allClients = stage2Data?.clients || [];
  const activeClientObj =
    allClients.find(
      (c) =>
        String(c.client_name || "").trim().toUpperCase() ===
        String(selectedStage2Client || "").trim().toUpperCase()
    ) || null;
  const activeClientName = activeClientObj?.client_name || selectedStage2Client || "APPTEST";
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
  const hasClientVirtualTabs = (stage2Data?.availableTabs?.client?.length || 0) > 0;

  const supabaseEngineClientsCount = allClients.filter((c) => c.master_mode === "supabase").length;
  const supabasePortalClientsCount = allClients.filter((c) => c.client_mode === "supabase").length;
  const migratedClientsCount = allClients.filter(
    (c) => (c.masterTabCount || 0) + (c.reconTabCount || 0) + (c.clientTabCount || 0) > 0
  ).length;

  const visibleOverviewClients = showAllStage2Clients
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

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: "10px",
        padding: "20px",
        marginBottom: "20px",
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        border: "1px solid #e5e7eb",
      }}
    >
      {/* Header */}
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
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "#111827" }}>
              Supabase engine & client migration
            </h3>
            {s2Ready && (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "600",
                  padding: "2px 8px",
                  borderRadius: "999px",
                  background: "#dcfce7",
                  color: "#166534",
                }}
              >
                {supabaseEngineClientsCount} master live · {supabasePortalClientsCount} portal live · {migratedClientsCount} synced
              </span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: "12px", color: "#6b7280", lineHeight: "1.5" }}>
            Manage client Master, Bank Recon, and Client Portal workbooks in Supabase PostgreSQL, remove Client Sheet{" "}
            <code>IMPORTRANGE</code> links, run native syncs, and inspect virtual workbooks and GAS execution logs.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {stage2Data?.stage4MigrationSql && (
            <button
              type="button"
              onClick={() => setShowStage4Sql((prev) => !prev)}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: "600",
                color: showStage4Sql ? "#1e40af" : "#374151",
                background: showStage4Sql ? "#eff6ff" : "#f9fafb",
                border: `1px solid ${showStage4Sql ? "#93c5fd" : "#d1d5db"}`,
                borderRadius: "6px",
                cursor: "pointer",
              }}
            >
              {showStage4Sql ? "Hide Stage 4 SQL" : "Stage 4 schema SQL"}
            </button>
          )}
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
              fontWeight: "600",
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
            onClick={() => setShowBackupPanel((prev) => !prev)}
            style={{
              padding: "7px 12px",
              fontSize: "12px",
              fontWeight: "600",
              color: showBackupPanel ? "#1e40af" : "#374151",
              background: showBackupPanel ? "#eff6ff" : "#f9fafb",
              border: `1px solid ${showBackupPanel ? "#93c5fd" : "#d1d5db"}`,
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            {showBackupPanel ? "Hide backups & restore" : "Backups & restore"}
          </button>

          <button
            type="button"
            onClick={() => loadStage2Status(activeClientName)}
            disabled={stage2Loading}
            style={{
              padding: "7px 12px",
              fontSize: "12px",
              fontWeight: "600",
              color: "#374151",
              background: "#f9fafb",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
              cursor: stage2Loading ? "default" : "pointer",
            }}
          >
            {stage2Loading ? "Refreshing..." : "Refresh status"}
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedbackMsg && (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: "6px",
            marginBottom: "14px",
            fontSize: "12px",
            fontWeight: "500",
            background: feedbackMsg.type === "error" ? "#fef2f2" : "#f0fdf4",
            border: `1px solid ${feedbackMsg.type === "error" ? "#fecaca" : "#bbf7d0"}`,
            color: feedbackMsg.type === "error" ? "#991b1b" : "#166534",
          }}
        >
          {feedbackMsg.text}
        </div>
      )}

      {/* Collapsible Stage 4 SQL script */}
      {showStage4Sql && stage2Data?.stage4MigrationSql && (
        <div
          style={{
            marginBottom: "16px",
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
              marginBottom: "8px",
            }}
          >
            <div style={{ fontSize: "12px", color: "#334155", fontWeight: 600 }}>
              Stage 4 Client Sheet Engine SQL migration (<code>0004_stage4_client_sheet_engine.sql</code>)
            </div>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(stage2Data.stage4MigrationSql);
                setCopiedStage4Sql(true);
                setTimeout(() => setCopiedStage4Sql(false), 2000);
              }}
              style={{
                padding: "5px 10px",
                fontSize: "11px",
                fontWeight: "600",
                color: "#fff",
                background: copiedStage4Sql ? "#166534" : "#1a56db",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
              }}
            >
              {copiedStage4Sql ? "Copied SQL" : "Copy SQL script"}
            </button>
          </div>
          <pre
            style={{
              maxHeight: "220px",
              overflowY: "auto",
              background: "#0f172a",
              color: "#e2e8f0",
              padding: "10px 12px",
              borderRadius: "6px",
              fontSize: "11px",
              fontFamily: "monospace",
              margin: 0,
            }}
          >
            {stage2Data.stage4MigrationSql}
          </pre>
        </div>
      )}

      {/* Collapsible Alert Memory Manager */}
      {showAlertMemoryTool && (
        <div
          style={{
            marginBottom: "16px",
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
                fontWeight: "600",
                color: "#334155",
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: amFlushing ? "not-allowed" : "pointer",
              }}
            >
              {amFlushing ? "Flushing cache..." : "Flush alert memory cache"}
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
                fontWeight: "600",
                borderRadius: "6px",
                border: "none",
                background: "#1a56db",
                color: "#fff",
                cursor: amLoading ? "not-allowed" : "pointer",
              }}
            >
              {amLoading ? "Searching..." : "Search"}
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
                fontWeight: "600",
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
                          fontWeight: "600",
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

      {/* Multi-client overview table */}
      {s2Ready && allClients.length > 0 && (
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            background: "#ffffff",
            marginBottom: "14px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "9px 12px",
              background: "#f8fafc",
              borderBottom: "1px solid #e2e8f0",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            <div style={{ fontSize: "12px", fontWeight: "700", color: "#1e293b" }}>
              Client engine overview ({visibleOverviewClients.length} of {allClients.length} clients shown)
            </div>
            <button
              type="button"
              onClick={() => setShowAllStage2Clients((prev) => !prev)}
              style={{
                padding: "4px 10px",
                fontSize: "11px",
                fontWeight: "600",
                borderRadius: "5px",
                border: "1px solid #cbd5e1",
                background: "#ffffff",
                color: "#334155",
                cursor: "pointer",
              }}
            >
              {showAllStage2Clients
                ? "Show migrated & selected clients only"
                : `Show all ${allClients.length} clients`}
            </button>
          </div>

          <div style={{ maxHeight: "260px", overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
              <thead>
                <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                  <th style={{ padding: "7px 10px", color: "#475569" }}>Client</th>
                  <th style={{ padding: "7px 10px", color: "#475569" }}>Engine mode</th>
                  <th style={{ padding: "7px 10px", color: "#475569" }}>Virtual workbook</th>
                  <th style={{ padding: "7px 10px", color: "#475569" }}>Client sheet links</th>
                  <th style={{ padding: "7px 10px", color: "#475569" }}>Integrations</th>
                  <th style={{ padding: "7px 10px", color: "#475569" }}>Auto sync (Inv / CRM / Exp)</th>
                  <th style={{ padding: "7px 10px", color: "#475569", textAlign: "right" }}>Actions</th>
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
                      <td style={{ padding: "7px 10px", fontWeight: "700", color: "#0f172a" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>{c.client_name}</span>
                          {isSelected && (
                            <span
                              style={{
                                fontSize: "10px",
                                fontWeight: "600",
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
                      <td style={{ padding: "7px 10px" }}>
                        <div style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>
                          <span
                            style={{
                              padding: "2px 7px",
                              borderRadius: "999px",
                              fontWeight: "600",
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
                              fontWeight: "600",
                              fontSize: "10px",
                              background: isClientSupabase ? "#dbeafe" : "#f1f5f9",
                              color: isClientSupabase ? "#1e40af" : "#475569",
                            }}
                          >
                            {isClientSupabase ? "Portal: Supabase" : "Portal: Sheets"}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: "7px 10px", color: hasTabs ? "#1e293b" : "#94a3b8" }}>
                        {hasTabs ? `${mTabs} master / ${rTabs} recon / ${cTabs} client` : "Not synced"}
                      </td>
                      <td style={{ padding: "7px 10px" }}>
                        <span
                          style={{
                            padding: "2px 6px",
                            borderRadius: "4px",
                            fontWeight: "600",
                            fontSize: "10px",
                            background: mat ? "#dcfce7" : "#f8fafc",
                            color: mat ? "#166534" : "#64748b",
                            border: mat ? "none" : "1px solid #e2e8f0",
                          }}
                        >
                          {mat ? "IMPORTRANGEs removed" : "Legacy IMPORTRANGE"}
                        </span>
                      </td>
                      <td style={{ padding: "7px 10px", color: "#334155" }}>{tools}</td>
                      <td style={{ padding: "7px 10px", color: "#334155", fontFamily: "monospace", fontSize: "10px" }}>
                        {`${formatFreqLabel(c.invFreq)} / ${formatFreqLabel(c.crmFreq)} / ${formatFreqLabel(c.expFreq)}`}
                      </td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: "5px", alignItems: "center" }}>
                          <button
                            type="button"
                            onClick={() => handleSelectStage2Client(c.client_name)}
                            style={{
                              padding: "3px 8px",
                              fontSize: "10px",
                              fontWeight: "600",
                              borderRadius: "4px",
                              border: `1px solid ${isSelected ? "#93c5fd" : "#cbd5e1"}`,
                              background: isSelected ? "#dbeafe" : "#ffffff",
                              color: isSelected ? "#1e40af" : "#334155",
                              cursor: "pointer",
                            }}
                          >
                            {isSelected ? "Active below" : "Select"}
                          </button>
                          {hasTabs && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  if (!isSelected) handleSelectStage2Client(c.client_name);
                                  setInspectorInitialRole("master");
                                  setInspectorOpen(true);
                                }}
                                style={{
                                  padding: "3px 7px",
                                  fontSize: "10px",
                                  fontWeight: "600",
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
                                  if (!isSelected) handleSelectStage2Client(c.client_name);
                                  setInspectorInitialRole("executions");
                                  setInspectorOpen(true);
                                }}
                                style={{
                                  padding: "3px 7px",
                                  fontSize: "10px",
                                  fontWeight: "600",
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
        </div>
      )}

      {/* Selected client workbench bar */}
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
          padding: "11px 14px",
          marginBottom: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <label htmlFor="stage2-client-select" style={{ fontSize: "12px", fontWeight: "700", color: "#1e3a8a" }}>
            Selected client workbench:
          </label>
          <select
            id="stage2-client-select"
            value={activeClientName}
            onChange={(e) => handleSelectStage2Client(e.target.value)}
            disabled={stage2Loading || stage2Migrating}
            style={{
              padding: "6px 10px",
              fontSize: "12px",
              fontWeight: "700",
              borderRadius: "6px",
              border: "1px solid #93c5fd",
              background: "#ffffff",
              color: "#0f172a",
              minWidth: "240px",
              cursor: "pointer",
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
            {allClients.length === 0 && <option value="APPTEST">APPTEST</option>}
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => {
              setInspectorInitialRole("master");
              setInspectorOpen(true);
            }}
            disabled={!s2Ready || !hasVirtualTabs}
            style={{
              padding: "7px 12px",
              fontSize: "12px",
              fontWeight: "600",
              color: !s2Ready || !hasVirtualTabs ? "#9ca3af" : "#1e40af",
              background: !s2Ready || !hasVirtualTabs ? "#f3f4f6" : "#ffffff",
              border: `1px solid ${!s2Ready || !hasVirtualTabs ? "#e5e7eb" : "#93c5fd"}`,
              borderRadius: "6px",
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
              padding: "7px 12px",
              fontSize: "12px",
              fontWeight: "600",
              color: !s2Ready || !hasVirtualTabs ? "#9ca3af" : "#0f172a",
              background: !s2Ready || !hasVirtualTabs ? "#f3f4f6" : "#ffffff",
              border: `1px solid ${!s2Ready || !hasVirtualTabs ? "#e5e7eb" : "#cbd5e1"}`,
              borderRadius: "6px",
              cursor: !s2Ready || !hasVirtualTabs ? "not-allowed" : "pointer",
            }}
          >
            View GAS execution logs
          </button>

          <button
            type="button"
            onClick={() => handleStage2MigrateClient(activeClientName)}
            disabled={!s2Ready || stage2Migrating}
            style={{
              padding: "7px 14px",
              fontSize: "12px",
              fontWeight: "600",
              color: "#fff",
              background: !s2Ready || stage2Migrating ? "#9ca3af" : "#1a56db",
              border: "none",
              borderRadius: "6px",
              cursor: !s2Ready || stage2Migrating ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {stage2Migrating ? (
              <>
                <Spinner size={12} color="#fff" /> Syncing {activeClientName}...
              </>
            ) : (
              `1. Sync ${activeClientName} Master & Recon`
            )}
          </button>
        </div>
      </div>

      {/* Step 2 & Step 3 cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "12px",
          marginBottom: "12px",
        }}
      >
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
          <div>
            <div style={{ fontSize: "12px", fontWeight: "700", color: "#1e293b" }}>
              2. {activeClientName} Client Sheet IMPORTRANGE links
            </div>
            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
              {isMaterialized
                ? `IMPORTRANGEs removed: ${activeClientName} Client Sheet uses direct values (original formulas backed up).`
                : `Replaces Master Sheet IMPORTRANGE formulas on ${activeClientName} Client Sheet (with 1-click rollback).`}
            </div>
          </div>

          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              disabled={!s2Ready || stage2Materializing}
              onClick={() => handleStage2Materialize(false, activeClientName)}
              style={{
                padding: "6px 11px",
                fontSize: "11px",
                fontWeight: "600",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: isMaterialized ? "#dcfce7" : "#ffffff",
                color: isMaterialized ? "#166534" : "#1e293b",
                cursor: !s2Ready || stage2Materializing ? "not-allowed" : "pointer",
              }}
            >
              {stage2Materializing
                ? "Working..."
                : isMaterialized
                  ? "Re-sync Client Sheet values"
                  : "2. Remove Master IMPORTRANGEs"}
            </button>
            {isMaterialized && (
              <button
                type="button"
                disabled={stage2Materializing}
                onClick={() => handleStage2Materialize(true, activeClientName)}
                style={{
                  padding: "6px 10px",
                  fontSize: "11px",
                  fontWeight: "600",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  cursor: stage2Materializing ? "not-allowed" : "pointer",
                }}
              >
                Restore IMPORTRANGEs
              </button>
            )}
          </div>
        </div>

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
          <div>
            <div style={{ fontSize: "12px", fontWeight: "700", color: "#1e293b" }}>
              3. {activeClientName} Master & Recon engine mode
            </div>
            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
              {activeClientMode === "supabase"
                ? `Active: all ${activeClientName} Master & Recon reads, writes, comparisons, and syncs run on Supabase.`
                : `Legacy: ${activeClientName} is currently reading from its Google Master & Recon sheets.`}
            </div>
          </div>

          <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
            <button
              type="button"
              disabled={stage2SwitchingMode}
              onClick={() => handleStage2SetMasterMode("sheet", activeClientName)}
              style={{
                padding: "5px 10px",
                fontSize: "12px",
                fontWeight: "600",
                borderRadius: "5px",
                border: "none",
                cursor: stage2SwitchingMode ? "default" : "pointer",
                background: activeClientMode === "sheet" ? "#fff" : "transparent",
                color: activeClientMode === "sheet" ? "#0f172a" : "#475569",
              }}
            >
              Google Sheets
            </button>
            <button
              type="button"
              disabled={!s2Ready || !hasVirtualTabs || stage2SwitchingMode}
              onClick={() => handleStage2SetMasterMode("supabase", activeClientName)}
              style={{
                padding: "5px 10px",
                fontSize: "12px",
                fontWeight: "600",
                borderRadius: "5px",
                border: "none",
                cursor: !s2Ready || !hasVirtualTabs || stage2SwitchingMode ? "not-allowed" : "pointer",
                background: activeClientMode === "supabase" ? "#166534" : "transparent",
                color: activeClientMode === "supabase" ? "#fff" : "#475569",
              }}
            >
              Supabase engine
            </button>
          </div>
        </div>
      </div>

      {/* Step 4 & Step 5: Stage 4 Client Sheet Seeding & Client Portal Engine Mode */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "12px",
          marginBottom: "12px",
        }}
      >
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
          <div>
            <div style={{ fontSize: "12px", fontWeight: "700", color: "#1e293b" }}>
              4. {activeClientName} Client Sheet virtual workbook ({activeClientObj?.clientTabCount || 0} tabs)
            </div>
            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
              {hasClientVirtualTabs
                ? `Seeded: ${activeClientObj?.clientTabCount || 31} Client Sheet tabs & Outgoings cell notes stored in Supabase.`
                : `Seeds all 31 Client Sheet tabs (values, formulas & cell notes) for ${activeClientName} into Supabase.`}
            </div>
          </div>

          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            {hasClientVirtualTabs && (
              <button
                type="button"
                onClick={() => {
                  setInspectorInitialRole("client");
                  setInspectorOpen(true);
                }}
                style={{
                  padding: "6px 10px",
                  fontSize: "11px",
                  fontWeight: "600",
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
              disabled={!s2Ready || stage4Seeding}
              onClick={() => handleSeedClientSheet(activeClientName)}
              style={{
                padding: "6px 11px",
                fontSize: "11px",
                fontWeight: "600",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: hasClientVirtualTabs ? "#dcfce7" : "#ffffff",
                color: hasClientVirtualTabs ? "#166534" : "#1e293b",
                cursor: !s2Ready || stage4Seeding ? "not-allowed" : "pointer",
              }}
            >
              {stage4Seeding
                ? "Seeding..."
                : hasClientVirtualTabs
                  ? "Re-seed Client Sheet"
                  : "4. Seed Client Sheet to Supabase"}
            </button>
          </div>
        </div>

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
          <div>
            <div style={{ fontSize: "12px", fontWeight: "700", color: "#1e293b" }}>
              5. {activeClientName} Client Portal engine mode
            </div>
            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
              {activeClientPortalMode === "supabase"
                ? `Active: all ${activeClientName} Pulse Portal views, edits, and formula calculations run 100% on Supabase.`
                : `Legacy: ${activeClientName} Pulse Portal is currently reading and writing to its Google Client Sheet.`}
            </div>
          </div>

          <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
            <button
              type="button"
              disabled={stage4SwitchingMode}
              onClick={() => handleSetClientMode("sheet", activeClientName)}
              style={{
                padding: "5px 10px",
                fontSize: "12px",
                fontWeight: "600",
                borderRadius: "5px",
                border: "none",
                cursor: stage4SwitchingMode ? "default" : "pointer",
                background: activeClientPortalMode === "sheet" ? "#fff" : "transparent",
                color: activeClientPortalMode === "sheet" ? "#0f172a" : "#475569",
              }}
            >
              Google Sheets
            </button>
            <button
              type="button"
              disabled={!s2Ready || !hasClientVirtualTabs || stage4SwitchingMode}
              onClick={() => handleSetClientMode("supabase", activeClientName)}
              style={{
                padding: "5px 10px",
                fontSize: "12px",
                fontWeight: "600",
                borderRadius: "5px",
                border: "none",
                cursor: !s2Ready || !hasClientVirtualTabs || stage4SwitchingMode ? "not-allowed" : "pointer",
                background: activeClientPortalMode === "supabase" ? "#1e40af" : "transparent",
                color: activeClientPortalMode === "supabase" ? "#fff" : "#475569",
              }}
            >
              Supabase engine
            </button>
          </div>
        </div>
      </div>

      {/* Step 6: Native Next.js comparison & sync triggers for selected client */}
      {s2Ready && hasVirtualTabs && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "10px",
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            padding: "10px 14px",
            marginBottom: "12px",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: "600", color: "#334155" }}>
            6. Test & run native syncs on {activeClientName}:
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {[
              { type: "recompute", label: "Recompute comparisons" },
              { type: "invoice", label: "Test invoice sync" },
              { type: "expense", label: "Test expense sync" },
              { type: "crm", label: "Test CRM sync" },
              { type: "all", label: "Run full sync" },
            ].map((btn) => (
              <button
                key={btn.type}
                type="button"
                disabled={Boolean(stage2SyncingType)}
                onClick={() => handleStage2NativeSync(btn.type, activeClientName)}
                style={{
                  padding: "5px 11px",
                  fontSize: "11px",
                  fontWeight: "600",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: stage2SyncingType === btn.type ? "#eff6ff" : "#ffffff",
                  color: "#1e293b",
                  cursor: stage2SyncingType ? "wait" : "pointer",
                }}
              >
                {stage2SyncingType === btn.type ? "Running..." : btn.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Compact Supabase 30-minute cron scheduler status bar */}
      <div
        style={{
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          padding: "10px 14px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "12px", fontWeight: "700", color: "#1e293b" }}>
            Supabase 30-minute cron scheduler
          </span>
          <span
            style={{
              fontSize: "10px",
              fontWeight: "600",
              padding: "2px 7px",
              borderRadius: "999px",
              background: activeAndRunning ? "#dcfce7" : "#fef3c7",
              color: activeAndRunning ? "#166534" : "#92400e",
            }}
          >
            {activeAndRunning ? "Active (every 30 mins)" : "Paused"}
          </span>
          {cs?.lastWebhookReceivedAt && (
            <span style={{ fontSize: "11px", color: "#64748b" }}>
              Last run: <b>{new Date(cs.lastWebhookReceivedAt).toLocaleString("en-GB")}</b>
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            disabled={!rpcReady || clockWorking}
            onClick={handleTriggerClockNow}
            style={{
              padding: "5px 11px",
              fontSize: "11px",
              fontWeight: "600",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              color: !rpcReady ? "#9ca3af" : "#1e293b",
              cursor: !rpcReady || clockWorking ? "not-allowed" : "pointer",
            }}
          >
            {clockWorking ? "Working..." : "Run scheduler now"}
          </button>

          <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
            <button
              type="button"
              disabled={clockWorking}
              onClick={() => handleSetClockEnabled(false)}
              style={{
                padding: "4px 9px",
                fontSize: "11px",
                fontWeight: "600",
                borderRadius: "5px",
                border: "none",
                cursor: clockWorking ? "default" : "pointer",
                background: !clockEnabled ? "#fff" : "transparent",
                color: !clockEnabled ? "#0f172a" : "#475569",
              }}
            >
              Paused
            </button>
            <button
              type="button"
              disabled={clockWorking}
              onClick={() => handleSetClockEnabled(true)}
              style={{
                padding: "4px 9px",
                fontSize: "11px",
                fontWeight: "600",
                borderRadius: "5px",
                border: "none",
                cursor: clockWorking ? "default" : "pointer",
                background: clockEnabled ? "#166534" : "transparent",
                color: clockEnabled ? "#fff" : "#475569",
              }}
            >
              Enabled
            </button>
          </div>
        </div>
      </div>

      {showBackupPanel && s2Ready && (
        <SupabaseBackupManagerPanel
          activeClientName={activeClientName}
          automationCommanderSheetId={automationCommanderSheetId}
          availableTabs={stage2Data?.availableTabs || { master: [], recon: [], client: [] }}
          onFeedback={setFeedbackMsg}
          onAfterRestore={(newStatus) => {
            if (newStatus) setStage2Data(newStatus);
          }}
        />
      )}

      {inspectorOpen && (
        <AdminWorkbookInspectorModal
          isOpen={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
          clientName={activeClientName}
          availableTabs={stage2Data?.availableTabs || { master: [], recon: [], client: [] }}
          initialSheetRole={inspectorInitialRole}
        />
      )}
    </div>
  );
}
