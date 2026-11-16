import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";

const STATUS_OPTIONS = [
  { value: "live", label: "Live" },
  { value: "setup", label: "Setup" },
  { value: "paused", label: "Paused" },
  { value: "archived", label: "Archived" },
];

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
  { key: "status", label: "Status", type: "select", options: STATUS_OPTIONS, width: 96 },
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
  const [showTemplates, setShowTemplates] = useState(false);
  const [savingTemplates, setSavingTemplates] = useState(false);

  const [loading, setLoading] = useState(true);
  const [savingBatch, setSavingBatch] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
                Template spreadsheet and Apps Script IDs used when onboarding new clients in Supabase mode.
              </div>
            </div>
            <button
              type="submit"
              disabled={savingTemplates}
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
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter by client name or script ID..."
          style={{ ...inputBaseStyle, maxWidth: "320px", padding: "6px 10px", fontSize: "12.5px" }}
        />
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
                    {col.label}
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
    </div>
  );
}
