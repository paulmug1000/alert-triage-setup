import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";
import AdminWorkbookInspectorModal from "./AdminWorkbookInspectorModal";

export default function SupabaseControlPlaneCard({ automationCommanderSheetId }) {
  const [loading, setLoading] = useState(true);
  const [statusData, setStatusData] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [switchingSource, setSwitchingSource] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState(null);
  const [showSql, setShowSql] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);

  // Alert memory inspector & synchronized delete
  const [showAlertMemoryTool, setShowAlertMemoryTool] = useState(false);
  const [amQuery, setAmQuery] = useState("");
  const [amStatusFilter, setAmStatusFilter] = useState("handled_only");
  const [amEntries, setAmEntries] = useState([]);
  const [amLoading, setAmLoading] = useState(false);
  const [amDeletingHash, setAmDeletingHash] = useState("");
  const [amManualHash, setAmManualHash] = useState("");
  const [amFlushing, setAmFlushing] = useState(false);

  // Stage 2: Master & Recon engine state (APPTEST)
  const [stage2Data, setStage2Data] = useState(null);
  const [stage2Loading, setStage2Loading] = useState(false);
  const [stage2Migrating, setStage2Migrating] = useState(false);
  const [stage2Materializing, setStage2Materializing] = useState(false);
  const [stage2SwitchingMode, setStage2SwitchingMode] = useState(false);
  const [stage2SyncingType, setStage2SyncingType] = useState("");
  const [showStage2Sql, setShowStage2Sql] = useState(false);
  const [copiedStage2Sql, setCopiedStage2Sql] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const loadStage2Status = useCallback(async (targetClient = "APPTEST") => {
    setStage2Loading(true);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", clientName: targetClient, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) {
        setStage2Data(data);
      }
    } catch (_) {
    } finally {
      setStage2Loading(false);
    }
  }, [automationCommanderSheetId]);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) {
        setStatusData(data);
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Could not load Supabase status." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, [automationCommanderSheetId]);

  useEffect(() => {
    loadStatus();
    loadStage2Status("APPTEST");
  }, [loadStatus, loadStage2Status]);

  const handleStage2MigrateClient = async () => {
    setStage2Migrating(true);
    setFeedbackMsg(null);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "migrate_client",
          clientName: "APPTEST",
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        const s = data.summary || {};
        setFeedbackMsg({
          type: "success",
          text: `Migrated APPTEST Master (${s.masterTabsSynced || 0} tabs, ${s.invoicesCount || 0} invoices, ${s.directCostsCount || 0} direct costs) & Recon (${s.reconTabsSynced || 0} tabs, ${s.reconItemsCount || 0} items) to Supabase.`,
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Stage 2 migration failed." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setStage2Migrating(false);
    }
  };

  const handleStage2SetMasterMode = async (targetMode) => {
    setStage2SwitchingMode(true);
    setFeedbackMsg(null);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_master_mode",
          clientName: "APPTEST",
          masterMode: targetMode,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        setFeedbackMsg({
          type: "success",
          text: `Switched APPTEST master & recon engine to ${targetMode === "supabase" ? "Supabase PostgreSQL" : "Google Sheets (legacy)"}.`,
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

  const handleStage2Materialize = async (restore = false) => {
    setStage2Materializing(true);
    setFeedbackMsg(null);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: restore ? "restore_client_importranges" : "materialize_client_sheet",
          clientName: "APPTEST",
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.status) setStage2Data(data.status);
        setFeedbackMsg({
          type: "success",
          text: restore
            ? `Restored ${data.restoredRangesCount || 0} original IMPORTRANGE formulas on APPTEST Client Sheet.`
            : `Materialized ${data.materializedRangesCount || 0} IMPORTRANGE ranges on APPTEST Client Sheet (original formulas backed up in Supabase).`,
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

  const handleStage2NativeSync = async (syncType) => {
    setStage2SyncingType(syncType);
    setFeedbackMsg(null);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run_native_sync",
          clientName: "APPTEST",
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
          text: `Completed native Supabase sync (${syncType}) on APPTEST: ${comp.invDiscrepancyCount ?? 0} invoice flags, ${comp.dirDiscrepancyCount ?? 0} direct cost flags.`,
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

  const handleCopyStage2Sql = async () => {
    if (!stage2Data?.migrationSql) return;
    try {
      await navigator.clipboard.writeText(stage2Data.migrationSql);
      setCopiedStage2Sql(true);
      setTimeout(() => setCopiedStage2Sql(false), 2500);
    } catch (_) { }
  };

  const handleSyncToSupabase = async () => {
    setSyncing(true);
    setFeedbackMsg(null);
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync_to_supabase",
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.status) setStatusData(data.status);
        const s = data.summary || {};
        setFeedbackMsg({
          type: "success",
          text: `Synced ${s.clients || 0} clients, ${s.users || 0} users, ${s.tenant_integrations || 0} vault tokens, and ${s.alert_memory || 0} alert memory rows to Supabase.`,
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Sync failed." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setSyncing(false);
    }
  };

  const handleSwitchSource = async (targetMode) => {
    if (switchingSource || statusData?.activeSource === targetMode) return;
    setSwitchingSource(true);
    setFeedbackMsg(null);
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_source",
          mode: targetMode,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.status) setStatusData(data.status);
        setFeedbackMsg({
          type: "success",
          text: `Active control plane source switched to ${targetMode === "supabase" ? "Supabase PostgreSQL (with background sheet mirroring)" : "Google Sheets (legacy)"}.`,
        });
      } else {
        setFeedbackMsg({ type: "error", text: data.error || "Could not switch control plane source." });
      }
    } catch (err) {
      setFeedbackMsg({ type: "error", text: err.message });
    } finally {
      setSwitchingSource(false);
    }
  };

  const handleCopySql = async () => {
    if (!statusData?.migrationSql) return;
    try {
      await navigator.clipboard.writeText(statusData.migrationSql);
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 2500);
    } catch (_) { }
  };

  const handleSearchAlertMemory = useCallback(async (overrideQuery, overrideStatus) => {
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
  }, [automationCommanderSheetId, amQuery, amStatusFilter]);

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
        if (data.status) setStatusData(data.status);
        setAmEntries(prev => prev.filter(r => r.fingerprintHash !== cleanHash));
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

  const configured = Boolean(statusData?.configured);
  const schemaReady = Boolean(statusData?.schemaReady);
  const activeSource = statusData?.activeSource || "sheets";

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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap", marginBottom: "14px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "#111827" }}>
              Supabase control plane & database migration (stage 1)
            </h3>
            <span
              style={{
                fontSize: "11px",
                fontWeight: "600",
                padding: "2px 8px",
                borderRadius: "999px",
                background: !configured ? "#fef3c7" : schemaReady ? "#dcfce7" : "#dbeafe",
                color: !configured ? "#92400e" : schemaReady ? "#166534" : "#1e40af",
              }}
            >
              {!configured ? "Awaiting credentials" : schemaReady ? "Connected & schema ready" : "Connected (run SQL migration)"}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "12px", color: "#6b7280", lineHeight: "1.5" }}>
            Migrates the central control plane (clients registry, users, alert memory, activity logs, setup tasks, and AES-256 encrypted OAuth tokens) into Supabase PostgreSQL while keeping Automation Commander and Clients Version Tracker mirrored in the background.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={loadStatus}
            disabled={loading || syncing}
            style={{
              padding: "7px 12px",
              fontSize: "12px",
              fontWeight: "600",
              color: "#374151",
              background: "#f9fafb",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
              cursor: loading || syncing ? "default" : "pointer",
            }}
          >
            {loading ? "Checking..." : "Refresh status"}
          </button>

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
            onClick={handleSyncToSupabase}
            disabled={!configured || !schemaReady || syncing}
            style={{
              padding: "7px 14px",
              fontSize: "12px",
              fontWeight: "600",
              color: "#fff",
              background: !configured || !schemaReady || syncing ? "#9ca3af" : "#1a56db",
              border: "none",
              borderRadius: "6px",
              cursor: !configured || !schemaReady || syncing ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {syncing ? (
              <>
                <Spinner size={12} color="#fff" /> Syncing control plane...
              </>
            ) : (
              "Sync control plane to Supabase"
            )}
          </button>
        </div>
      </div>

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

      {!configured && !loading && (
        <div
          style={{
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: "8px",
            padding: "12px 14px",
            marginBottom: "14px",
            fontSize: "12px",
            color: "#92400e",
            lineHeight: "1.6",
          }}
        >
          <div style={{ fontWeight: "700", marginBottom: "4px" }}>Setup step 1: add server-only environment variables</div>
          <div>
            Add <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> to your <code>.env.local</code> and Vercel environment variables (never prefix with <code>NEXT_PUBLIC_</code> so database access remains strictly server-side). Then run the stage 1 SQL migration in your Supabase SQL editor.
          </div>
        </div>
      )}

      {/* Active Control Plane Source Switcher */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          padding: "12px 14px",
          marginBottom: "14px",
        }}
      >
        <div>
          <div style={{ fontSize: "12px", fontWeight: "700", color: "#1e293b" }}>Active control plane read source</div>
          <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
            {activeSource === "supabase"
              ? "Reading from Supabase PostgreSQL (~10ms) and mirroring writes to Automation Commander & Clients Version Tracker in the background."
              : "Reading from Google Sheets + Redis cache (legacy default). Switch to Supabase once you have run your initial sync."}
          </div>
        </div>

        <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
          <button
            type="button"
            disabled={switchingSource}
            onClick={() => handleSwitchSource("sheets")}
            style={{
              padding: "5px 12px",
              fontSize: "12px",
              fontWeight: "600",
              borderRadius: "5px",
              border: "none",
              cursor: switchingSource ? "default" : "pointer",
              background: activeSource === "sheets" ? "#fff" : "transparent",
              color: activeSource === "sheets" ? "#0f172a" : "#475569",
              boxShadow: activeSource === "sheets" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
            }}
          >
            Google Sheets (legacy)
          </button>
          <button
            type="button"
            disabled={!configured || !schemaReady || switchingSource}
            onClick={() => handleSwitchSource("supabase")}
            style={{
              padding: "5px 12px",
              fontSize: "12px",
              fontWeight: "600",
              borderRadius: "5px",
              border: "none",
              cursor: !configured || !schemaReady || switchingSource ? "not-allowed" : "pointer",
              background: activeSource === "supabase" ? "#166534" : "transparent",
              color: activeSource === "supabase" ? "#fff" : "#475569",
              boxShadow: activeSource === "supabase" ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
            }}
          >
            Supabase PostgreSQL (dual-write)
          </button>
        </div>
      </div>

      {/* Table status grid */}
      {statusData?.tables && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: "8px", marginBottom: "12px" }}>
          {statusData.tables.map((t) => (
            <div
              key={t.name}
              style={{
                background: "#f9fafb",
                border: `1px solid ${t.exists ? "#d1fae5" : "#e5e7eb"}`,
                borderRadius: "7px",
                padding: "9px 11px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
                <span style={{ fontSize: "12px", fontWeight: "700", color: "#111827", fontFamily: "monospace" }}>{t.name}</span>
                <span
                  style={{
                    fontSize: "10px",
                    fontWeight: "600",
                    padding: "1px 6px",
                    borderRadius: "4px",
                    background: t.exists ? "#dcfce7" : "#f3f4f6",
                    color: t.exists ? "#166534" : "#6b7280",
                  }}
                >
                  {t.exists ? `${t.rowCount.toLocaleString()} rows` : "Not created"}
                </span>
              </div>
              <div style={{ fontSize: "11px", color: "#6b7280" }}>{t.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Alert memory inspector & synchronized delete */}
      <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
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
              background: "none",
              border: "none",
              padding: 0,
              fontSize: "12px",
              fontWeight: "600",
              color: "#1a56db",
              cursor: "pointer",
            }}
          >
            {showAlertMemoryTool
              ? "Hide alert memory manager (search & delete across Supabase + sheet + cache)"
              : "Manage alert memory entries (search & delete across Supabase + sheet + cache)"}
          </button>

          <button
            type="button"
            onClick={handleFlushAlertMemoryCache}
            disabled={amFlushing}
            style={{
              padding: "4px 10px",
              fontSize: "11px",
              fontWeight: "600",
              color: "#334155",
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              cursor: amFlushing ? "not-allowed" : "pointer",
            }}
          >
            {amFlushing ? "Flushing cache..." : "Flush alert memory cache"}
          </button>
        </div>

        {showAlertMemoryTool && (
          <div
            style={{
              marginTop: "10px",
              padding: "14px",
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              borderRadius: "8px",
            }}
          >
            <div style={{ fontSize: "12px", color: "#475569", marginBottom: "10px", lineHeight: 1.5 }}>
              Deleting an entry here removes it simultaneously from <strong>Supabase</strong> (<code>alert_memory</code> & <code>pma_tasks</code>), the legacy <strong>Automation Commander</strong> sheet tab (<code>AlertMemory</code>), and the <strong>Upstash Redis</strong> cache so it will not reappear on re-sync.
            </div>

            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
              <input
                type="text"
                value={amQuery}
                onChange={e => setAmQuery(e.target.value)}
                onKeyDown={e => {
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
                onChange={e => {
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

            {/* Direct delete by hash (useful if row was already deleted in Supabase UI but still on sheet) */}
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "12px" }}>
              <input
                type="text"
                value={amManualHash}
                onChange={e => setAmManualHash(e.target.value)}
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

            <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: "6px", background: "#fff" }}>
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
                  {amEntries.map(entry => (
                    <tr key={entry.fingerprintHash} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "7px 10px", fontFamily: "monospace", color: "#334155" }}>
                        {entry.fingerprintHash}
                      </td>
                      <td style={{ padding: "7px 10px", fontWeight: 600, color: "#0f172a" }}>
                        {entry.clientName}
                      </td>
                      <td style={{ padding: "7px 10px", color: "#475569" }}>
                        {entry.alertType}
                      </td>
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
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.alertSummary}>
                          {entry.alertSummary || "—"}
                        </div>
                        {entry.ignoreReason && (
                          <div style={{ color: "#64748b", fontSize: "10px" }}>
                            Note: {entry.ignoreReason}
                          </div>
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
      </div>

      {/* Migration SQL viewer helper if schema is not yet initialized */}
      {statusData?.migrationSql && (
        <div style={{ marginTop: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              type="button"
              onClick={() => setShowSql(!showSql)}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                fontSize: "12px",
                fontWeight: "600",
                color: "#1a56db",
                cursor: "pointer",
              }}
            >
              {showSql ? "Hide stage 1 SQL migration script" : "View stage 1 SQL migration script (0001_stage1_control_plane.sql)"}
            </button>
            <button
              type="button"
              onClick={handleCopySql}
              style={{
                padding: "3px 8px",
                fontSize: "11px",
                fontWeight: "600",
                color: "#374151",
                background: "#f3f4f6",
                border: "1px solid #d1d5db",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              {copiedSql ? "Copied to clipboard" : "Copy SQL"}
            </button>
          </div>
          {showSql && (
            <pre
              style={{
                marginTop: "8px",
                padding: "12px",
                background: "#0f172a",
                color: "#e2e8f0",
                borderRadius: "6px",
                fontSize: "11px",
                maxHeight: "260px",
                overflowY: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {statusData.migrationSql}
            </pre>
          )}
        </div>
      )}

      {/* ====================================================================
          STAGE 2: MASTER & RECON ENGINE REPLACEMENT (APPTEST)
          ==================================================================== */}
      <div style={{ marginTop: "20px", paddingTop: "18px", borderTop: "2px solid #e2e8f0" }}>
        {(() => {
          const s2Ready = Boolean(stage2Data?.schemaReady);
          const apptestClient = (stage2Data?.clients || []).find(
            (c) => String(c.client_name || "").toUpperCase() === "APPTEST"
          );
          const apptestMode = apptestClient?.master_mode || "sheet";
          const isMaterialized = Boolean(stage2Data?.keyInfoMeta?.client_materialized_at);
          const hasVirtualTabs =
            (stage2Data?.availableTabs?.master?.length || 0) + (stage2Data?.availableTabs?.recon?.length || 0) > 0;

          return (
            <>
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
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                    <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "#111827" }}>
                      Master & recon engine replacement on APPTEST (stage 2)
                    </h3>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: "600",
                        padding: "2px 8px",
                        borderRadius: "999px",
                        background: s2Ready ? "#dcfce7" : "#dbeafe",
                        color: s2Ready ? "#166534" : "#1e40af",
                      }}
                    >
                      {s2Ready ? "Stage 2 schema ready" : "Run stage 2 SQL migration"}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: "12px", color: "#6b7280", lineHeight: "1.5" }}>
                    Replaces APPTEST&apos;s Master Sheet and Recon Sheet with Supabase PostgreSQL and native Next.js comparison engines (<code>InvComp</code>, <code>DirComp</code>, <code>PLComp</code>, <code>BankRecon</code>), while keeping APPTEST&apos;s Client Sheet active with zero <code>IMPORTRANGE</code> links.
                  </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => loadStage2Status("APPTEST")}
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
                    {stage2Loading ? "Refreshing..." : "Refresh stage 2"}
                  </button>

                  <button
                    type="button"
                    onClick={() => setInspectorOpen(true)}
                    disabled={!s2Ready || !hasVirtualTabs}
                    style={{
                      padding: "7px 12px",
                      fontSize: "12px",
                      fontWeight: "600",
                      color: !s2Ready || !hasVirtualTabs ? "#9ca3af" : "#1e40af",
                      background: !s2Ready || !hasVirtualTabs ? "#f3f4f6" : "#eff6ff",
                      border: `1px solid ${!s2Ready || !hasVirtualTabs ? "#e5e7eb" : "#93c5fd"}`,
                      borderRadius: "6px",
                      cursor: !s2Ready || !hasVirtualTabs ? "not-allowed" : "pointer",
                    }}
                  >
                    Open admin workbook inspector
                  </button>

                  <button
                    type="button"
                    onClick={handleStage2MigrateClient}
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
                        <Spinner size={12} color="#fff" /> Migrating APPTEST...
                      </>
                    ) : (
                      "Sync APPTEST master & recon to Supabase"
                    )}
                  </button>
                </div>
              </div>

              {/* APPTEST Master Engine Switcher & IMPORTRANGE Materializer */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                  gap: "12px",
                  marginBottom: "14px",
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
                      APPTEST master & recon engine mode
                    </div>
                    <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                      {apptestMode === "supabase"
                        ? "Active: all APPTEST Master & Recon reads, writes, comparisons, and bank recon run on Supabase."
                        : "Legacy: APPTEST is currently reading from its Google Master & Recon sheets."}
                    </div>
                  </div>

                  <div style={{ display: "inline-flex", background: "#e2e8f0", borderRadius: "6px", padding: "3px", gap: "3px" }}>
                    <button
                      type="button"
                      disabled={stage2SwitchingMode}
                      onClick={() => handleStage2SetMasterMode("sheet")}
                      style={{
                        padding: "5px 10px",
                        fontSize: "12px",
                        fontWeight: "600",
                        borderRadius: "5px",
                        border: "none",
                        cursor: stage2SwitchingMode ? "default" : "pointer",
                        background: apptestMode === "sheet" ? "#fff" : "transparent",
                        color: apptestMode === "sheet" ? "#0f172a" : "#475569",
                      }}
                    >
                      Google Sheets
                    </button>
                    <button
                      type="button"
                      disabled={!s2Ready || !hasVirtualTabs || stage2SwitchingMode}
                      onClick={() => handleStage2SetMasterMode("supabase")}
                      style={{
                        padding: "5px 10px",
                        fontSize: "12px",
                        fontWeight: "600",
                        borderRadius: "5px",
                        border: "none",
                        cursor: !s2Ready || !hasVirtualTabs || stage2SwitchingMode ? "not-allowed" : "pointer",
                        background: apptestMode === "supabase" ? "#166534" : "transparent",
                        color: apptestMode === "supabase" ? "#fff" : "#475569",
                      }}
                    >
                      Supabase engine
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
                      APPTEST Client Sheet IMPORTRANGE links
                    </div>
                    <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                      {isMaterialized
                        ? "Materialized: all Master Sheet IMPORTRANGE formulas replaced with direct local values & formulas."
                        : "Replaces Master Sheet IMPORTRANGE wrappers on APPTEST Client Sheet (with 1-click rollback backup)."}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      type="button"
                      disabled={!s2Ready || stage2Materializing}
                      onClick={() => handleStage2Materialize(false)}
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
                      {stage2Materializing ? "Working..." : isMaterialized ? "Re-materialize Client Sheet" : "Remove IMPORTRANGEs on APPTEST"}
                    </button>
                    {isMaterialized && (
                      <button
                        type="button"
                        disabled={stage2Materializing}
                        onClick={() => handleStage2Materialize(true)}
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
              </div>

              {/* Native Next.js comparison & sync triggers for APPTEST */}
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
                    Run native Next.js sync & comparison engine on APPTEST:
                  </div>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {[
                      { type: "recompute", label: "Recompute InvComp & DirComp" },
                      { type: "invoice", label: "Sync invoices (Xero/QBO)" },
                      { type: "expense", label: "Sync direct costs (Xero/QBO)" },
                      { type: "all", label: "Run full native sync" },
                    ].map((btn) => (
                      <button
                        key={btn.type}
                        type="button"
                        disabled={Boolean(stage2SyncingType)}
                        onClick={() => handleStage2NativeSync(btn.type)}
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

              {/* Stage 2 tables grid */}
              {stage2Data?.tables && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
                    gap: "8px",
                    marginBottom: "10px",
                  }}
                >
                  {stage2Data.tables.map((t) => (
                    <div
                      key={t.name}
                      style={{
                        background: "#f9fafb",
                        border: `1px solid ${t.exists ? "#d1fae5" : "#e5e7eb"}`,
                        borderRadius: "7px",
                        padding: "9px 11px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
                        <span style={{ fontSize: "12px", fontWeight: "700", color: "#111827", fontFamily: "monospace" }}>
                          {t.name}
                        </span>
                        <span
                          style={{
                            fontSize: "10px",
                            fontWeight: "600",
                            padding: "1px 6px",
                            borderRadius: "4px",
                            background: t.exists ? "#dcfce7" : "#f3f4f6",
                            color: t.exists ? "#166534" : "#6b7280",
                          }}
                        >
                          {t.exists ? `${(t.count ?? 0).toLocaleString()} rows` : "Not created"}
                        </span>
                      </div>
                      <div style={{ fontSize: "11px", color: "#6b7280" }}>{t.label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Stage 2 SQL script viewer */}
              {stage2Data?.migrationSql && (
                <div style={{ marginTop: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <button
                      type="button"
                      onClick={() => setShowStage2Sql(!showStage2Sql)}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        fontSize: "12px",
                        fontWeight: "600",
                        color: "#1a56db",
                        cursor: "pointer",
                      }}
                    >
                      {showStage2Sql
                        ? "Hide stage 2 SQL migration script"
                        : "View stage 2 SQL migration script (0002_stage2_master_and_recon.sql)"}
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyStage2Sql}
                      style={{
                        padding: "3px 8px",
                        fontSize: "11px",
                        fontWeight: "600",
                        color: "#374151",
                        background: "#f3f4f6",
                        border: "1px solid #d1d5db",
                        borderRadius: "4px",
                        cursor: "pointer",
                      }}
                    >
                      {copiedStage2Sql ? "Copied to clipboard" : "Copy stage 2 SQL"}
                    </button>
                  </div>
                  {showStage2Sql && (
                    <pre
                      style={{
                        marginTop: "8px",
                        padding: "12px",
                        background: "#0f172a",
                        color: "#e2e8f0",
                        borderRadius: "6px",
                        fontSize: "11px",
                        maxHeight: "260px",
                        overflowY: "auto",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {stage2Data.migrationSql}
                    </pre>
                  )}
                </div>
              )}

              <AdminWorkbookInspectorModal
                isOpen={inspectorOpen}
                onClose={() => setInspectorOpen(false)}
                clientName="APPTEST"
                availableTabs={stage2Data?.availableTabs || { master: [], recon: [] }}
              />
            </>
          );
        })()}
      </div>
    </div>
  );
}
