import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";
import DeferredSearchInput from "./DeferredSearchInput";

const STATUS_OPTIONS = [
  { value: "live", label: "Live" },
  { value: "setup", label: "Setup" },
  { value: "paused", label: "Paused" },
  { value: "suspended", label: "Suspended" },
  { value: "archived", label: "Archived" },
];

const STATUS_DEFINITIONS = [
  {
    value: "live",
    label: "Live",
    bg: "#dcfce7",
    color: "#166534",
    border: "#bbf7d0",
    summary: "Fully active client across all systems.",
    details: "Visible in client switchers, included in scheduled background syncs, triage and alert emails, EoM workflows, and mass GAS script rollouts.",
    capabilities: ["Yes", "Yes", "Yes", "Yes", "Yes"],
  },
  {
    value: "setup",
    label: "Setup",
    bg: "#e0f2fe",
    color: "#0369a1",
    border: "#bae6fd",
    summary: "Client onboarding in progress.",
    details: "Visible in switchers (holding gate shown in Portal if setup mode is enabled), excluded from automated background syncs until moved to Live, while included in triage/EoM setup checks and mass GAS script rollouts.",
    capabilities: ["Yes", "No", "Yes", "Yes", "Yes"],
  },
  {
    value: "paused",
    label: "Paused",
    bg: "#fef3c7",
    color: "#92400e",
    border: "#fde68a",
    summary: "Temporary pause on automated background syncs only.",
    details: "Stops scheduled background accounting, CRM, and time syncs. Client remains visible in client switchers and included in triage checks, tab-error notifications, EoM tools, and mass GAS script rollouts.",
    capabilities: ["Yes", "No", "Yes", "Yes", "Yes"],
  },
  {
    value: "suspended",
    label: "Suspended",
    bg: "#f3e8ff",
    color: "#6b21a8",
    border: "#e9d5ff",
    summary: "Dormant client whose spreadsheets are still kept up to date.",
    details: "Hidden from Pulse and PMA client switchers and excluded from background syncs, triage, tab-error/daily emails, and EoM tools, while still receiving mass GAS script rollouts so spreadsheets remain ready if moved back to Live.",
    capabilities: ["No", "No", "No", "No", "Yes"],
  },
  {
    value: "archived",
    label: "Archived",
    bg: "#f1f5f9",
    color: "#475569",
    border: "#cbd5e1",
    summary: "Inactive historical client preserved for records.",
    details: "Hidden from Pulse and PMA client switchers and excluded from background syncs, triage, alert/tab-error emails, EoM tools, and mass GAS script rollouts. All Supabase and Google Drive data remains intact.",
    capabilities: ["No", "No", "No", "No", "No"],
  },
];

const STATUS_TOOLTIP_TEXT =
  "Live: active everywhere | Setup: onboarding (no auto-sync) | Paused: stops auto-sync only | Suspended: hidden/excluded except GAS script rollouts | Archived: hidden/excluded everywhere (click for full details)";

const MODE_LABELS = {
  supabase: { label: "Supabase", bg: "#dcfce7", color: "#166534", border: "#bbf7d0" },
  sheet: { label: "Sheet", bg: "#f1f5f9", color: "#334155", border: "#cbd5e1" },
  shadow: { label: "Shadow", bg: "#fef3c7", color: "#92400e", border: "#fde68a" },
};

const TEMPLATE_FIELDS = [
  { key: "clientTemplateId", label: "Client template sheet ID" },
  { key: "masterTemplateId", label: "Master template sheet ID" },
  { key: "reconTemplateId", label: "Recon template sheet ID" },
  { key: "clientTemplateScriptId", label: "Client template script ID" },
  { key: "masterTemplateScriptId", label: "Master template script ID" },
  { key: "reconTemplateScriptId", label: "Recon template script ID" },
];

const EMPTY_TEMPLATES = {
  clientTemplateId: "",
  masterTemplateId: "",
  reconTemplateId: "",
  clientTemplateScriptId: "",
  masterTemplateScriptId: "",
  reconTemplateScriptId: "",
};

const COLUMNS = [
  { key: "client_name", label: "Client name", type: "text", width: 170, stickyLeft: 0, placeholder: "Required client name" },
  { key: "status", label: "Status", type: "select", options: STATUS_OPTIONS, width: 108 },
  { key: "master_mode", label: "Master mode", type: "readonly_mode", width: 92 },
  { key: "client_mode", label: "Portal mode", type: "readonly_mode", width: 92 },
  { key: "client_sheet_url", label: "Client sheet URL", type: "url", width: 125, placeholder: "https://docs.google.com/..." },
  { key: "master_sheet_url", label: "Master sheet URL", type: "url", width: 125, placeholder: "https://docs.google.com/..." },
  { key: "recon_sheet_url", label: "Recon sheet URL", type: "url", width: 125, placeholder: "https://docs.google.com/..." },
  { key: "backup_sheet_url", label: "Backup sheet URL", type: "url", width: 125, placeholder: "https://docs.google.com/..." },
  { key: "drive_folder_id", label: "Drive folder ID", type: "folder", width: 120, placeholder: "Folder ID or URL" },
  { key: "reports_folder_id", label: "Reports folder ID", type: "folder", width: 120, placeholder: "Folder ID or URL" },
  { key: "client_script_id", label: "Client script ID", type: "mono", width: 115, placeholder: "Apps Script ID" },
  { key: "master_script_id", label: "Master script ID", type: "mono", width: 115, placeholder: "Apps Script ID" },
  { key: "recon_script_id", label: "Recon script ID", type: "mono", width: 115, placeholder: "Apps Script ID" },
  { key: "master_deployment_url", label: "Master deployment URL", type: "url", width: 125, placeholder: "https://script.google.com/..." },
];

function getRowKey(row) {
  return row.id || row.normalized_key || row.client_name;
}

function normalizeEditableRow(raw = {}) {
  return {
    id: raw.id || null,
    normalized_key: raw.normalized_key || "",
    client_name: raw.client_name || "",
    status: raw.status || "live",
    master_mode: raw.master_mode || "sheet",
    client_mode: raw.client_mode || "sheet",
    version_in_use: raw.version_in_use || "",
    client_sheet_url: raw.client_sheet_url || "",
    master_sheet_url: raw.master_sheet_url || "",
    recon_sheet_url: raw.recon_sheet_url || "",
    backup_sheet_url: raw.backup_sheet_url || "",
    drive_folder_id: raw.drive_folder_id || "",
    reports_folder_id: raw.reports_folder_id || "",
    client_script_id: raw.client_script_id || "",
    master_script_id: raw.master_script_id || "",
    recon_script_id: raw.recon_script_id || "",
    master_deployment_url: raw.master_deployment_url || "",
    web_app_url: raw.web_app_url || "",
    webapp_version: raw.webapp_version || "",
  };
}

function rowsEqual(a, b) {
  if (!a || !b) return false;
  for (const col of COLUMNS) {
    if (col.type === "readonly_mode") continue;
    if (String(a[col.key] ?? "") !== String(b[col.key] ?? "")) {
      return false;
    }
  }
  return true;
}

function buildExternalUrl(val, colType) {
  const clean = String(val || "").trim();
  if (!clean) return "";
  if (/^https?:\/\//i.test(clean)) return clean;
  if (colType === "folder") return `https://drive.google.com/drive/folders/${clean}`;
  return "";
}

const inputBaseStyle = {
  width: "100%",
  padding: "5px 7px",
  borderRadius: "5px",
  border: "1px solid #cbd5e1",
  fontSize: "12px",
  color: "#0f172a",
  background: "#ffffff",
  boxSizing: "border-box",
};

const btnSecondaryStyle = {
  padding: "6px 11px",
  borderRadius: "6px",
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#334155",
  fontSize: "12px",
  fontWeight: "600",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
};

export default function ClientRegistryCard({ automationCommanderSheetId, onClientsChanged }) {
  const [rows, setRows] = useState([]);
  const [originalMap, setOriginalMap] = useState({});
  const [templates, setTemplates] = useState(EMPTY_TEMPLATES);
  const [snapshotMeta, setSnapshotMeta] = useState(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [savingTemplates, setSavingTemplates] = useState(false);
  const [syncingSnapshots, setSyncingSnapshots] = useState(false);

  const [loading, setLoading] = useState(true);
  const [savingBatch, setSavingBatch] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!showStatusModal) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") setShowStatusModal(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showStatusModal]);

  const renderStatusHelpButton = () => (
    <button
      type="button"
      onClick={() => setShowStatusModal(true)}
      title={STATUS_TOOLTIP_TEXT}
      aria-label="View status definitions"
      style={{
        width: "16px",
        height: "16px",
        padding: 0,
        borderRadius: "999px",
        border: "1px solid #94a3b8",
        background: "#ffffff",
        color: "#475569",
        fontSize: "10.5px",
        fontWeight: "700",
        lineHeight: "14px",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      ?
    </button>
  );

  const loadRegistry = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list_clients_registry",
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load clients registry.");
      }
      const normalized = (data.clients || []).map(c => normalizeEditableRow(c));
      const orig = {};
      normalized.forEach(r => {
        orig[getRowKey(r)] = { ...r };
      });
      setRows(normalized);
      setOriginalMap(orig);
      if (data.templates) {
        setTemplates({ ...EMPTY_TEMPLATES, ...data.templates });
      }
      if (data.snapshotMeta !== undefined) {
        setSnapshotMeta(data.snapshotMeta || null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [automationCommanderSheetId]);

  useEffect(() => {
    loadRegistry();
  }, [loadRegistry]);

  const dirtyRows = useMemo(() => {
    return rows.filter(r => !rowsEqual(r, originalMap[getRowKey(r)]));
  }, [rows, originalMap]);

  const dirtyKeySet = useMemo(() => new Set(dirtyRows.map(getRowKey)), [dirtyRows]);

  const liveCount = useMemo(
    () => rows.filter(r => r.status === "live").length,
    [rows]
  );

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter !== "all" && r.status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      const haystack = [
        r.client_name,
        r.client_script_id,
        r.master_script_id,
        r.recon_script_id,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, searchQuery, statusFilter]);

  const handleFieldChange = (rowKey, field, value) => {
    setRows(prev =>
      prev.map(r => (getRowKey(r) === rowKey ? { ...r, [field]: value } : r))
    );
  };

  const handleSaveAll = async () => {
    if (dirtyRows.length === 0) return;
    const missingName = dirtyRows.find(r => !String(r.client_name || "").trim());
    if (missingName) {
      setError("Every modified row must have a client name before saving.");
      return;
    }
    setSavingBatch(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_client_registry_batch",
          automationCommanderSheetId,
          rows: dirtyRows,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save batch changes.");
      }
      await loadRegistry();
      setNotice(`Saved ${dirtyRows.length} client record${dirtyRows.length === 1 ? "" : "s"}.`);
      onClientsChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingBatch(false);
    }
  };

  const handleSaveTemplates = async (e) => {
    e.preventDefault();
    setSavingTemplates(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_provisioning_templates",
          automationCommanderSheetId,
          templates,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save provisioning templates.");
      }
      if (data.templates) {
        setTemplates({ ...EMPTY_TEMPLATES, ...data.templates });
      }
      setNotice("Provisioning template IDs saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingTemplates(false);
    }
  };

  const handleSyncTemplateSnapshots = async () => {
    setSyncingSnapshots(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync_provisioning_template_snapshots",
          automationCommanderSheetId,
          templates,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to sync template snapshots to Supabase.");
      }
      if (data.snapshotMeta) {
        setSnapshotMeta(data.snapshotMeta);
      }
      setNotice("Provisioning template snapshots synced to Supabase.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncingSnapshots(false);
    }
  };

  const renderCellInput = (row, col) => {
    const rowKey = getRowKey(row);
    const val = row[col.key] ?? "";

    if (col.type === "readonly_mode") {
      const styleMeta = MODE_LABELS[String(val).toLowerCase()] || {
        label: val || "Sheet",
        bg: "#f1f5f9",
        color: "#334155",
        border: "#cbd5e1",
      };
      return (
        <span
          title="Managed via the DB screen"
          style={{
            display: "inline-block",
            fontSize: "11px",
            fontWeight: "600",
            padding: "3px 8px",
            borderRadius: "999px",
            background: styleMeta.bg,
            color: styleMeta.color,
            border: `1px solid ${styleMeta.border}`,
            cursor: "default",
          }}
        >
          {styleMeta.label}
        </span>
      );
    }

    if (col.type === "select") {
      return (
        <select
          value={val}
          onChange={(e) => handleFieldChange(rowKey, col.key, e.target.value)}
          style={{ ...inputBaseStyle, padding: "5px 6px" }}
        >
          {col.options.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }

    const externalUrl = (col.type === "url" || col.type === "folder") ? buildExternalUrl(val, col.type) : "";

    return (
      <div style={{ display: "flex", alignItems: "center", gap: "4px", maxWidth: col.width }}>
        <input
          type="text"
          value={val}
          title={val || undefined}
          placeholder={col.placeholder || ""}
          onChange={(e) => handleFieldChange(rowKey, col.key, e.target.value)}
          style={{
            ...inputBaseStyle,
            minWidth: 0,
            flex: 1,
            fontFamily: col.type === "mono" ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "inherit",
            fontWeight: col.key === "client_name" ? "600" : "400",
          }}
        />
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: "10.5px",
              fontWeight: "600",
              color: "#0047AB",
              textDecoration: "none",
              padding: "3px 4px",
              borderRadius: "4px",
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              flexShrink: 0,
            }}
            title={`Open ${col.label.toLowerCase()}`}
          >
            Open
          </a>
        )}
      </div>
    );
  };

  return (
    <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
      {/* Header Row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap", marginBottom: "12px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>Clients</h3>
            <span style={{ fontSize: "11px", fontWeight: "600", padding: "2px 8px", borderRadius: "999px", background: "#f1f5f9", color: "#334155", border: "1px solid #e2e8f0" }}>
              {rows.length} total
            </span>
            <span style={{ fontSize: "11px", fontWeight: "600", padding: "2px 8px", borderRadius: "999px", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}>
              {liveCount} live
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
            Manage client status, spreadsheet links, and Apps Script IDs stored in Supabase. Engine modes are managed via the DB screen, and new clients are onboarded via Setup.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setShowTemplates(v => !v)}
            style={{
              ...btnSecondaryStyle,
              background: showTemplates ? "#eff6ff" : "#ffffff",
              borderColor: showTemplates ? "#93c5fd" : "#cbd5e1",
              color: showTemplates ? "#1d4ed8" : "#334155",
            }}
          >
            Provisioning templates
          </button>
          {dirtyRows.length > 0 && (
            <button
              type="button"
              onClick={handleSaveAll}
              disabled={savingBatch}
              style={{
                ...btnSecondaryStyle,
                background: "#16a34a",
                borderColor: "#16a34a",
                color: "#ffffff",
                cursor: savingBatch ? "wait" : "pointer",
              }}
            >
              {savingBatch ? <Spinner size={12} color="#ffffff" /> : null}
              Save all changes ({dirtyRows.length})
            </button>
          )}
          <button
            type="button"
            onClick={loadRegistry}
            disabled={loading}
            style={{ ...btnSecondaryStyle, cursor: loading ? "wait" : "pointer" }}
          >
            {loading ? <Spinner size={12} color="#334155" /> : null}
            Refresh
          </button>
        </div>
      </div>

      {/* Provisioning Templates Panel */}
      {showTemplates && (
        <form
          onSubmit={handleSaveTemplates}
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            padding: "12px 14px",
            marginBottom: "14px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
            <div>
              <div style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>Provisioning template IDs</div>
              <div style={{ fontSize: "11.5px", color: "#64748b" }}>
                Template spreadsheet and Apps Script IDs used when onboarding new clients.
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                onClick={handleSyncTemplateSnapshots}
                disabled={syncingSnapshots || savingTemplates}
                style={{
                  ...btnSecondaryStyle,
                  background: "#166534",
                  borderColor: "#166534",
                  color: "#ffffff",
                  cursor: syncingSnapshots ? "wait" : "pointer",
                }}
              >
                {syncingSnapshots ? <Spinner size={12} color="#ffffff" /> : null}
                {syncingSnapshots ? "Syncing snapshots..." : "Sync templates to Supabase"}
              </button>
              <button
                type="submit"
                disabled={savingTemplates || syncingSnapshots}
                style={{
                  ...btnSecondaryStyle,
                  background: "#0047AB",
                  borderColor: "#0047AB",
                  color: "#ffffff",
                  cursor: savingTemplates ? "wait" : "pointer",
                }}
              >
                {savingTemplates ? <Spinner size={12} color="#ffffff" /> : null}
                Save templates
              </button>
            </div>
          </div>
          <div
            style={{
              marginBottom: "10px",
              padding: "8px 10px",
              borderRadius: "6px",
              fontSize: "11.5px",
              background: snapshotMeta?.syncedAt ? "#ecfdf5" : "#fffbeb",
              border: `1px solid ${snapshotMeta?.syncedAt ? "#a7f3d0" : "#fde68a"}`,
              color: snapshotMeta?.syncedAt ? "#065f46" : "#92400e",
            }}
          >
            {snapshotMeta?.syncedAt ? (
              snapshotMeta.clientTemplateId === templates.clientTemplateId &&
                snapshotMeta.masterTemplateId === templates.masterTemplateId &&
                snapshotMeta.reconTemplateId === templates.reconTemplateId ? (
                <span>
                  Supabase snapshot synced ({snapshotMeta.masterTabCount || 0} Master, {snapshotMeta.reconTabCount || 0} Recon, {snapshotMeta.clientTabCount || 0} Client tabs) on{" "}
                  {new Date(snapshotMeta.syncedAt).toLocaleString()}. Supabase-only onboarding makes zero Google Sheets API calls.
                </span>
              ) : (
                <span>
                  Template IDs have changed since the last snapshot. Click <b>Sync templates to Supabase</b> to refresh.
                </span>
              )
            ) : (
              <span>
                No Supabase template snapshot synced yet. Click <b>Sync templates to Supabase</b> so Supabase-only client onboarding runs without reading Google Sheets.
              </span>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "10px" }}>
            {TEMPLATE_FIELDS.map(tf => (
              <div key={tf.key}>
                <label style={{ display: "block", fontSize: "11.5px", fontWeight: "600", color: "#334155", marginBottom: "4px" }}>
                  {tf.label}
                </label>
                <input
                  type="text"
                  value={templates[tf.key] || ""}
                  onChange={(e) => setTemplates(prev => ({ ...prev, [tf.key]: e.target.value }))}
                  style={{ ...inputBaseStyle, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                />
              </div>
            ))}
          </div>
        </form>
      )}

      {/* Search & Filter Bar */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "12px" }}>
        <DeferredSearchInput
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter by client name or script ID..."
          showClearButton
          style={{ ...inputBaseStyle, maxWidth: "320px", padding: "6px 10px", fontSize: "12.5px" }}
        />
        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ ...inputBaseStyle, width: "auto", padding: "6px 10px", fontSize: "12.5px" }}
          >
            <option value="all">All statuses</option>
            {STATUS_OPTIONS.map(s => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {renderStatusHelpButton()}
        </div>
        {notice && (
          <span style={{ fontSize: "12px", fontWeight: "600", color: "#166534" }}>{notice}</span>
        )}
        {error && (
          <span style={{ fontSize: "12px", fontWeight: "600", color: "#dc2626" }}>{error}</span>
        )}
      </div>

      {/* Inline Editable Table */}
      {loading && rows.length === 0 ? (
        <div style={{ padding: "20px", textAlign: "center", fontSize: "12.5px", color: "#64748b", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
          <Spinner size={14} color="#0047AB" /> Loading clients...
        </div>
      ) : (
        <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", overflowX: "auto", overflowY: "auto", maxHeight: "540px", position: "relative" }}>
          <table style={{ width: "max-content", minWidth: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: "12px" }}>
            <thead>
              <tr>
                {COLUMNS.map(col => (
                  <th
                    key={col.key}
                    style={{
                      position: "sticky",
                      top: 0,
                      left: col.stickyLeft !== undefined ? col.stickyLeft : undefined,
                      zIndex: col.stickyLeft !== undefined ? 4 : 2,
                      background: "#f8fafc",
                      color: "#334155",
                      fontWeight: "700",
                      fontSize: "11.5px",
                      textAlign: "left",
                      padding: "8px 8px",
                      borderBottom: "1px solid #cbd5e1",
                      borderRight: col.key === "client_name" ? "2px solid #cbd5e1" : "1px solid #e2e8f0",
                      minWidth: col.width,
                      width: col.width,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {col.key === "status" ? (
                      <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                        <span>{col.label}</span>
                        {renderStatusHelpButton()}
                      </div>
                    ) : (
                      col.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} style={{ padding: "20px", textAlign: "center", color: "#64748b" }}>
                    No matching clients found.
                  </td>
                </tr>
              ) : (
                filteredRows.map(row => {
                  const rowKey = getRowKey(row);
                  const isDirty = dirtyKeySet.has(rowKey);
                  const rowBg = isDirty ? "#fffbeb" : "#ffffff";

                  return (
                    <tr key={rowKey} style={{ background: rowBg }}>
                      {COLUMNS.map(col => (
                        <td
                          key={col.key}
                          style={{
                            position: col.stickyLeft !== undefined ? "sticky" : undefined,
                            left: col.stickyLeft !== undefined ? col.stickyLeft : undefined,
                            zIndex: col.stickyLeft !== undefined ? 1 : undefined,
                            background: rowBg,
                            padding: "6px 6px",
                            borderBottom: "1px solid #e2e8f0",
                            borderRight: col.key === "client_name" ? "2px solid #cbd5e1" : "1px solid #f1f5f9",
                            minWidth: col.width,
                            width: col.width,
                            verticalAlign: "middle",
                            textAlign: col.type === "readonly_mode" ? "center" : "left",
                          }}
                        >
                          {renderCellInput(row, col)}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {showStatusModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="status-definitions-title"
          onClick={() => setShowStatusModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#ffffff",
              borderRadius: "10px",
              border: "1px solid #e2e8f0",
              boxShadow: "0 12px 30px rgba(15, 23, 42, 0.18)",
              width: "100%",
              maxWidth: "740px",
              maxHeight: "88vh",
              overflowY: "auto",
              padding: "18px 20px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "10px" }}>
              <div>
                <h4 id="status-definitions-title" style={{ margin: 0, fontSize: "15.5px", fontWeight: "700", color: "#0f172a" }}>
                  Status definitions
                </h4>
                <p style={{ margin: "3px 0 0", fontSize: "12px", color: "#64748b" }}>
                  How each client status affects switchers, automated jobs, reporting tools, and GAS rollouts.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowStatusModal(false)}
                style={btnSecondaryStyle}
              >
                Close
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "14px" }}>
              {STATUS_DEFINITIONS.map(def => (
                <div
                  key={def.value}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    padding: "10px 12px",
                    background: "#f8fafc",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
                    <span
                      style={{
                        display: "inline-block",
                        fontSize: "11px",
                        fontWeight: "700",
                        padding: "2px 9px",
                        borderRadius: "999px",
                        background: def.bg,
                        color: def.color,
                        border: `1px solid ${def.border}`,
                      }}
                    >
                      {def.label}
                    </span>
                    <span style={{ fontSize: "12.5px", fontWeight: "600", color: "#0f172a" }}>
                      {def.summary}
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#475569", lineHeight: "1.45" }}>
                    {def.details}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11.5px" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", color: "#334155" }}>
                    <th style={{ textAlign: "left", padding: "7px 8px", borderBottom: "1px solid #cbd5e1" }}>Status</th>
                    <th style={{ textAlign: "center", padding: "7px 8px", borderBottom: "1px solid #cbd5e1" }}>Client switchers</th>
                    <th style={{ textAlign: "center", padding: "7px 8px", borderBottom: "1px solid #cbd5e1" }}>Background syncs</th>
                    <th style={{ textAlign: "center", padding: "7px 8px", borderBottom: "1px solid #cbd5e1" }}>Triage and alerts</th>
                    <th style={{ textAlign: "center", padding: "7px 8px", borderBottom: "1px solid #cbd5e1" }}>End-of-month tools</th>
                    <th style={{ textAlign: "center", padding: "7px 8px", borderBottom: "1px solid #cbd5e1" }}>Mass GAS rollouts</th>
                  </tr>
                </thead>
                <tbody>
                  {STATUS_DEFINITIONS.map((def, idx) => (
                    <tr key={def.value} style={{ background: idx % 2 === 0 ? "#ffffff" : "#f8fafc" }}>
                      <td style={{ padding: "6px 8px", fontWeight: "600", color: "#0f172a", borderBottom: "1px solid #e2e8f0" }}>
                        {def.label}
                      </td>
                      {def.capabilities.map((cell, cIdx) => (
                        <td
                          key={cIdx}
                          style={{
                            padding: "6px 8px",
                            textAlign: "center",
                            fontWeight: "600",
                            color: cell === "Yes" ? "#166534" : "#64748b",
                            borderBottom: "1px solid #e2e8f0",
                          }}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
