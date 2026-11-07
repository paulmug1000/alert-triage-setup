import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";

export default function SupabaseControlPlaneCard({ automationCommanderSheetId }) {
  const [loading, setLoading] = useState(true);
  const [statusData, setStatusData] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [switchingSource, setSwitchingSource] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState(null);
  const [showSql, setShowSql] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);

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
  }, [loadStatus]);

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
    } catch (_) {}
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

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
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
    </div>
  );
}
