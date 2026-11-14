import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Spinner from "./Spinner";

function base64ToUint8Array(base64) {
  const binary = window.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, sub);
  }
  return window.btoa(binary);
}

async function gunzipBytesInBrowser(compressedBytes) {
  if (typeof window !== "undefined" && typeof window.DecompressionStream === "function") {
    const ds = new window.DecompressionStream("gzip");
    const blob = new Blob([compressedBytes]);
    const decompressedStream = blob.stream().pipeThrough(ds);
    const ab = await new Response(decompressedStream).arrayBuffer();
    return new Uint8Array(ab);
  }
  return null;
}

async function gzipBytesInBrowser(rawBytes) {
  if (typeof window !== "undefined" && typeof window.CompressionStream === "function") {
    const cs = new window.CompressionStream("gzip");
    const blob = new Blob([rawBytes]);
    const compressedStream = blob.stream().pipeThrough(cs);
    const ab = await new Response(compressedStream).arrayBuffer();
    return new Uint8Array(ab);
  }
  return rawBytes;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 KB";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function SupabaseBackupManagerPanel({
  activeClientName,
  automationCommanderSheetId,
  availableTabs,
  onFeedback,
  onAfterRestore,
}) {
  const [snapshots, setSnapshots] = useState([]);
  const [allSnapshotsCount, setAllSnapshotsCount] = useState(0);
  const [totalCompressedBytes, setTotalCompressedBytes] = useState(0);
  const [totalRawBytes, setTotalRawBytes] = useState(0);
  const [policy, setPolicy] = useState({
    autoDailyEnabled: true,
    retentionDays: 14,
    lastDailyBackupDate: null,
    lastDailyBackupAt: null,
    lastDailyBackupCount: 0,
  });

  const [showAllClients, setShowAllClients] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [updatingPolicy, setUpdatingPolicy] = useState(false);
  const [restoringId, setRestoringId] = useState("");
  const [downloadingId, setDownloadingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [importingFile, setImportingFile] = useState(false);

  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [restoreScope, setRestoreScope] = useState("all");
  const [targetRole, setTargetRole] = useState("client");
  const [targetTabName, setTargetTabName] = useState("Confirmed");
  const [createPreRestoreBackup, setCreatePreRestoreBackup] = useState(true);
  const [confirmRestoreSnap, setConfirmRestoreSnap] = useState(null);

  const fileInputRef = useRef(null);

  const applyBackupResponse = useCallback((data) => {
    if (Array.isArray(data?.snapshots)) setSnapshots(data.snapshots);
    if (typeof data?.allSnapshotsCount === "number") setAllSnapshotsCount(data.allSnapshotsCount);
    if (typeof data?.totalCompressedBytes === "number") setTotalCompressedBytes(data.totalCompressedBytes);
    if (typeof data?.totalRawBytes === "number") setTotalRawBytes(data.totalRawBytes);
    if (data?.policy) setPolicy(data.policy);
  }, []);

  const loadBackups = useCallback(
    async (overrideClient, overrideAllClients) => {
      const targetClient = overrideClient !== undefined ? overrideClient : activeClientName;
      const allFlag = overrideAllClients !== undefined ? overrideAllClients : showAllClients;
      setLoading(true);
      try {
        const res = await fetch("/api/pma/master-engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "list_backups",
            clientName: targetClient,
            allClients: allFlag,
            automationCommanderSheetId,
          }),
        });
        const data = await res.json();
        if (data.success) {
          applyBackupResponse(data);
        }
      } catch (_) {
        // Ignore background load error
      } finally {
        setLoading(false);
      }
    },
    [activeClientName, automationCommanderSheetId, showAllClients, applyBackupResponse]
  );

  useEffect(() => {
    loadBackups(activeClientName, showAllClients);
  }, [activeClientName, showAllClients, loadBackups]);

  // Keep single-tab dropdown aligned with available tabs for the selected role
  const roleTabsList = useMemo(() => {
    if (availableTabs && Array.isArray(availableTabs[targetRole]) && availableTabs[targetRole].length > 0) {
      return availableTabs[targetRole];
    }
    if (targetRole === "client") {
      return ["Confirmed", "Pipeline", "Outgoings", "Salaries", "Overhead", "AppData", "Performance", "Dashboard"];
    }
    if (targetRole === "master") {
      return ["KeyInfo", "InvComp", "DirComp", "CRMComp", "PLComp", "InvAppList", "JnlAppList", "DataFromCRM"];
    }
    return ["BankRec"];
  }, [availableTabs, targetRole]);

  useEffect(() => {
    if (roleTabsList.length > 0 && !roleTabsList.includes(targetTabName)) {
      setTargetTabName(roleTabsList[0]);
    }
  }, [targetRole, roleTabsList, targetTabName]);

  const handleCreateSnapshot = async () => {
    setCreating(true);
    if (onFeedback) onFeedback(null);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_backup",
          clientName: activeClientName,
          label: snapshotLabel,
          allClients: showAllClients,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        applyBackupResponse(data);
        setSnapshotLabel("");
        const s = data.snapshot || {};
        if (onFeedback) {
          onFeedback({
            type: "success",
            text: `Created cloud snapshot for ${activeClientName} (${s.masterTabCount || 0} master, ${s.reconTabCount || 0} recon, ${s.clientTabCount || 0} client tabs · ${formatBytes(s.compressedBytes)} compressed).`,
          });
        }
      } else if (onFeedback) {
        onFeedback({ type: "error", text: data.error || "Could not create snapshot." });
      }
    } catch (err) {
      if (onFeedback) onFeedback({ type: "error", text: err.message });
    } finally {
      setCreating(false);
    }
  };

  const handleDownloadSnapshot = async (snap) => {
    if (!snap?.id) return;
    setDownloadingId(snap.id);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "download_backup",
          clientName: snap.clientName || activeClientName,
          snapshotId: snap.id,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!data.success || !data.compressedBase64) {
        throw new Error(data.error || "Could not download snapshot.");
      }

      const compressedBytes = base64ToUint8Array(data.compressedBase64);
      const decompressedBytes = await gunzipBytesInBrowser(compressedBytes);
      const safeClient = String(snap.clientName || activeClientName || "client")
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, "_");
      const dateTag = String(snap.createdAt || new Date().toISOString())
        .slice(0, 19)
        .replace(/[:T]/g, "-");

      const blob = decompressedBytes
        ? new Blob([decompressedBytes], { type: "application/json" })
        : new Blob([compressedBytes], { type: "application/gzip" });
      const filename = decompressedBytes
        ? `${safeClient}_${dateTag}.pulse-snapshot.json`
        : `${safeClient}_${dateTag}.pulse-snapshot.json.gz`;

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      if (onFeedback) onFeedback({ type: "error", text: err.message });
    } finally {
      setDownloadingId("");
    }
  };

  const handleExecuteRestore = async (snap) => {
    if (!snap?.id) return;
    setConfirmRestoreSnap(null);
    setRestoringId(snap.id);
    if (onFeedback) onFeedback(null);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "restore_backup",
          clientName: snap.clientName || activeClientName,
          snapshotId: snap.id,
          scope: restoreScope,
          targetRole: restoreScope === "single_tab" ? targetRole : null,
          targetTabName: restoreScope === "single_tab" ? targetTabName : null,
          createPreRestoreBackup,
          allClients: showAllClients,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        applyBackupResponse(data);
        if (onAfterRestore && data.status) {
          onAfterRestore(data.status);
        }
        const r = data.restoreResult || {};
        const scopeLabel =
          r.scope === "single_tab"
            ? `tab ${r.targetRole}:${r.targetTabName}`
            : r.scope === "client"
              ? `Client Portal workbook (${r.restoredClientCount} tabs)`
              : r.scope === "master_recon"
                ? `Master & Recon workbooks (${r.restoredMasterCount + r.restoredReconCount} tabs)`
                : `all workbooks (${r.restoredTabsCount} tabs)`;
        if (onFeedback) {
          onFeedback({
            type: "success",
            text: `Restored ${scopeLabel} for ${r.clientName || activeClientName}${r.preRestoreSnapshotId ? " (pre-restore safety snapshot saved)" : ""}.`,
          });
        }
      } else if (onFeedback) {
        onFeedback({ type: "error", text: data.error || "Restore failed." });
      }
    } catch (err) {
      if (onFeedback) onFeedback({ type: "error", text: err.message });
    } finally {
      setRestoringId("");
    }
  };

  const handleDeleteSnapshot = async (snap) => {
    if (!snap?.id) return;
    setDeletingId(snap.id);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_backup",
          clientName: activeClientName,
          snapshotId: snap.id,
          allClients: showAllClients,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        applyBackupResponse(data);
      } else if (onFeedback) {
        onFeedback({ type: "error", text: data.error || "Could not delete snapshot." });
      }
    } catch (err) {
      if (onFeedback) onFeedback({ type: "error", text: err.message });
    } finally {
      setDeletingId("");
    }
  };

  const handleImportFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!file) return;

    setImportingFile(true);
    if (onFeedback) onFeedback(null);
    try {
      const ab = await file.arrayBuffer();
      const rawBytes = new Uint8Array(ab);
      const isAlreadyGzip = rawBytes.length >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b;
      const compressedBytes = isAlreadyGzip ? rawBytes : await gzipBytesInBrowser(rawBytes);
      const uploadedCompressedBase64 = uint8ArrayToBase64(compressedBytes);

      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import_backup",
          clientName: activeClientName,
          uploadedCompressedBase64,
          label: snapshotLabel || `Imported file (${file.name})`,
          restoreImmediately: false,
          allClients: showAllClients,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        applyBackupResponse(data);
        setSnapshotLabel("");
        const imp = data.importedEntry || {};
        if (onFeedback) {
          onFeedback({
            type: "success",
            text: `Imported snapshot file "${file.name}" for ${imp.clientName || activeClientName} into cloud backups. Click Restore on the row below whenever you are ready to apply it.`,
          });
        }
      } else if (onFeedback) {
        onFeedback({ type: "error", text: data.error || "Could not import snapshot file." });
      }
    } catch (err) {
      if (onFeedback) onFeedback({ type: "error", text: err.message });
    } finally {
      setImportingFile(false);
    }
  };

  const handleUpdatePolicy = async (patch) => {
    setUpdatingPolicy(true);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_backup_policy",
          clientName: activeClientName,
          allClients: showAllClients,
          ...patch,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        applyBackupResponse(data);
      }
    } catch (err) {
      if (onFeedback) onFeedback({ type: "error", text: err.message });
    } finally {
      setUpdatingPolicy(false);
    }
  };

  const handleRunDailySweepNow = async () => {
    setSweeping(true);
    if (onFeedback) onFeedback(null);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run_daily_backup_sweep",
          clientName: activeClientName,
          allClients: showAllClients,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        applyBackupResponse(data);
        const sw = data.sweepResult || {};
        if (onFeedback) {
          onFeedback({
            type: "success",
            text: `Completed daily backup sweep across ${sw.clientsScanned || 0} Supabase client(s): ${sw.snapshotsCreated || 0} snapshot(s) created, ${sw.expiredSnapshotsPruned || 0} expired snapshot(s) pruned.`,
          });
        }
      } else if (onFeedback) {
        onFeedback({ type: "error", text: data.error || "Daily backup sweep failed." });
      }
    } catch (err) {
      if (onFeedback) onFeedback({ type: "error", text: err.message });
    } finally {
      setSweeping(false);
    }
  };

  const compressionSavingsPct =
    totalRawBytes > 0 ? Math.max(0, Math.round((1 - totalCompressedBytes / totalRawBytes) * 100)) : 0;

  const formatTriggerBadge = (type) => {
    if (type === "daily_auto") {
      return { label: "Daily auto", bg: "#dbeafe", color: "#1e40af" };
    }
    if (type === "pre_restore") {
      return { label: "Pre-restore safety", bg: "#fef3c7", color: "#92400e" };
    }
    if (type === "uploaded") {
      return { label: "Imported file", bg: "#f3e8ff", color: "#6b21a8" };
    }
    return { label: "Manual", bg: "#dcfce7", color: "#166534" };
  };

  return (
    <div
      style={{
        marginTop: "12px",
        background: "#f8fafc",
        border: "1px solid #cbd5e1",
        borderRadius: "8px",
        padding: "14px",
      }}
    >
      {/* Top header & automated daily backup policy bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "12px",
          flexWrap: "wrap",
          marginBottom: "12px",
          paddingBottom: "10px",
          borderBottom: "1px solid #e2e8f0",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
              Client workbook backups & granular restore
            </span>
            <span
              style={{
                fontSize: "10px",
                fontWeight: "600",
                padding: "2px 7px",
                borderRadius: "999px",
                background: policy.autoDailyEnabled !== false ? "#dcfce7" : "#fef3c7",
                color: policy.autoDailyEnabled !== false ? "#166534" : "#92400e",
              }}
            >
              {policy.autoDailyEnabled !== false
                ? `Daily auto-backup active (${policy.retentionDays || 14}d retention)`
                : "Daily auto-backup paused"}
            </span>
            <span
              style={{
                fontSize: "10px",
                fontWeight: "600",
                padding: "2px 7px",
                borderRadius: "999px",
                background: "#eff6ff",
                color: "#1e40af",
              }}
            >
              {allSnapshotsCount} snapshot{allSnapshotsCount === 1 ? "" : "s"} · {formatBytes(totalCompressedBytes)} in Supabase Storage
              {compressionSavingsPct > 0 ? ` (${compressionSavingsPct}% GZIP reduction · 0 MB DB impact)` : ""}
            </span>
          </div>
          <div style={{ fontSize: "11px", color: "#64748b", marginTop: "3px" }}>
            Snapshots are GZIP-compressed and stored in the private <code>pulse-backups</code> Supabase Storage bucket
            (separate from your 500 MB database limit). Restore an entire client, a single workbook, or an individual tab.
            {policy.lastDailyBackupAt && (
              <span>
                {" "}
                Last daily sweep: <b>{new Date(policy.lastDailyBackupAt).toLocaleString("en-GB")}</b>.
              </span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <label style={{ fontSize: "11px", color: "#475569", display: "inline-flex", alignItems: "center", gap: "5px" }}>
            Retention:
            <select
              value={policy.retentionDays || 14}
              disabled={updatingPolicy}
              onChange={(e) => handleUpdatePolicy({ retentionDays: Number(e.target.value) })}
              style={{
                padding: "4px 7px",
                fontSize: "11px",
                fontWeight: "600",
                borderRadius: "5px",
                border: "1px solid #cbd5e1",
                background: "#fff",
                color: "#0f172a",
              }}
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
            </select>
          </label>

          <button
            type="button"
            disabled={updatingPolicy}
            onClick={() => handleUpdatePolicy({ autoDailyEnabled: policy.autoDailyEnabled === false })}
            style={{
              padding: "5px 10px",
              fontSize: "11px",
              fontWeight: "600",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: "#fff",
              color: "#334155",
              cursor: updatingPolicy ? "wait" : "pointer",
            }}
          >
            {policy.autoDailyEnabled !== false ? "Pause daily auto-backup" : "Enable daily auto-backup"}
          </button>

          <button
            type="button"
            disabled={sweeping}
            onClick={handleRunDailySweepNow}
            style={{
              padding: "5px 11px",
              fontSize: "11px",
              fontWeight: "600",
              borderRadius: "6px",
              border: "1px solid #93c5fd",
              background: "#eff6ff",
              color: "#1e40af",
              cursor: sweeping ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
            }}
          >
            {sweeping ? (
              <>
                <Spinner size={11} color="#1e40af" /> Backing up all clients...
              </>
            ) : (
              "Backup all Supabase clients now"
            )}
          </button>
        </div>
      </div>

      {/* Create / Import snapshot bar for selected client */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "10px",
          flexWrap: "wrap",
          marginBottom: "10px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", flex: "1 1 320px" }}>
          <input
            type="text"
            value={snapshotLabel}
            onChange={(e) => setSnapshotLabel(e.target.value)}
            placeholder={`Optional note for ${activeClientName} snapshot (e.g. Before month-end changes)...`}
            style={{
              flex: "1 1 240px",
              padding: "6px 10px",
              fontSize: "12px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: "#fff",
            }}
          />
          <button
            type="button"
            disabled={creating}
            onClick={handleCreateSnapshot}
            style={{
              padding: "6px 13px",
              fontSize: "12px",
              fontWeight: "600",
              borderRadius: "6px",
              border: "none",
              background: creating ? "#94a3b8" : "#166534",
              color: "#fff",
              cursor: creating ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {creating ? (
              <>
                <Spinner size={11} color="#fff" /> Saving snapshot...
              </>
            ) : (
              `Take snapshot of ${activeClientName}`
            )}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.gz"
            onChange={handleImportFileChange}
            style={{ display: "none" }}
          />
          <button
            type="button"
            disabled={importingFile}
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: "6px 11px",
              fontSize: "11px",
              fontWeight: "600",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: "#fff",
              color: "#334155",
              cursor: importingFile ? "wait" : "pointer",
            }}
          >
            {importingFile ? "Importing file..." : "Import snapshot file (.json / .gz)"}
          </button>
        </div>

        {/* Restore scope selector */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
            background: "#fff",
            padding: "6px 10px",
            borderRadius: "6px",
            border: "1px solid #e2e8f0",
          }}
        >
          <span style={{ fontSize: "11px", fontWeight: "700", color: "#334155" }}>Restore scope:</span>
          <select
            value={restoreScope}
            onChange={(e) => setRestoreScope(e.target.value)}
            style={{
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: "600",
              borderRadius: "5px",
              border: "1px solid #cbd5e1",
              background: "#f8fafc",
              color: "#0f172a",
            }}
          >
            <option value="all">All workbooks (Master + Recon + Client Portal)</option>
            <option value="client">Client Portal workbook only (31 tabs)</option>
            <option value="master_recon">Master & Recon workbooks only</option>
            <option value="single_tab">Single specific tab only...</option>
          </select>

          {restoreScope === "single_tab" && (
            <>
              <select
                value={targetRole}
                onChange={(e) => setTargetRole(e.target.value)}
                style={{
                  padding: "4px 7px",
                  fontSize: "11px",
                  fontWeight: "600",
                  borderRadius: "5px",
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                  color: "#0f172a",
                }}
              >
                <option value="client">Client tab</option>
                <option value="master">Master tab</option>
                <option value="recon">Recon tab</option>
              </select>
              <select
                value={targetTabName}
                onChange={(e) => setTargetTabName(e.target.value)}
                style={{
                  padding: "4px 8px",
                  fontSize: "11px",
                  fontWeight: "600",
                  borderRadius: "5px",
                  border: "1px solid #93c5fd",
                  background: "#eff6ff",
                  color: "#1e3a8a",
                }}
              >
                {roleTabsList.map((tName) => (
                  <option key={tName} value={tName}>
                    {tName}
                  </option>
                ))}
              </select>
            </>
          )}

          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "11px",
              color: "#475569",
              cursor: "pointer",
            }}
            title="Automatically saves a snapshot of the client's current state right before restoring so you can undo any restore."
          >
            <input
              type="checkbox"
              checked={createPreRestoreBackup}
              onChange={(e) => setCreatePreRestoreBackup(e.target.checked)}
            />
            Safety snapshot before restore
          </label>
        </div>
      </div>

      {/* Inline confirmation banner when Restore is clicked */}
      {confirmRestoreSnap && (
        <div
          style={{
            marginBottom: "10px",
            padding: "10px 12px",
            borderRadius: "6px",
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: "12px", color: "#92400e" }}>
            Confirm restore for <b>{confirmRestoreSnap.clientName}</b> from snapshot taken{" "}
            <b>{new Date(confirmRestoreSnap.createdAt).toLocaleString("en-GB")}</b>:{" "}
            <b>
              {restoreScope === "single_tab"
                ? `Single tab (${targetRole}:${targetTabName})`
                : restoreScope === "client"
                  ? "Client Portal workbook only"
                  : restoreScope === "master_recon"
                    ? "Master & Recon workbooks only"
                    : "All workbooks (Master + Recon + Client Portal)"}
            </b>
            ?
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              onClick={() => handleExecuteRestore(confirmRestoreSnap)}
              style={{
                padding: "5px 12px",
                fontSize: "11px",
                fontWeight: "700",
                borderRadius: "5px",
                border: "none",
                background: "#b45309",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Confirm restore now
            </button>
            <button
              type="button"
              onClick={() => setConfirmRestoreSnap(null)}
              style={{
                padding: "5px 10px",
                fontSize: "11px",
                fontWeight: "600",
                borderRadius: "5px",
                border: "1px solid #cbd5e1",
                background: "#fff",
                color: "#475569",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Snapshots table */}
      <div
        style={{
          border: "1px solid #e2e8f0",
          borderRadius: "6px",
          background: "#fff",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "7px 10px",
            background: "#f1f5f9",
            borderBottom: "1px solid #e2e8f0",
          }}
        >
          <span style={{ fontSize: "11px", fontWeight: "700", color: "#334155" }}>
            {showAllClients
              ? `All client snapshots (${snapshots.length})`
              : `${activeClientName} snapshots (${snapshots.length})`}
          </span>
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              onClick={() => setShowAllClients((prev) => !prev)}
              style={{
                padding: "3px 8px",
                fontSize: "10px",
                fontWeight: "600",
                borderRadius: "4px",
                border: "1px solid #cbd5e1",
                background: "#fff",
                color: "#334155",
                cursor: "pointer",
              }}
            >
              {showAllClients ? `Show ${activeClientName} only` : `Show all clients (${allSnapshotsCount})`}
            </button>
          </div>
        </div>

        <div style={{ maxHeight: "230px", overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
            <thead>
              <tr style={{ background: "#f8fafc", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                <th style={{ padding: "6px 10px", color: "#475569" }}>Created (UK)</th>
                <th style={{ padding: "6px 10px", color: "#475569" }}>Client</th>
                <th style={{ padding: "6px 10px", color: "#475569" }}>Type</th>
                <th style={{ padding: "6px 10px", color: "#475569" }}>Note / label</th>
                <th style={{ padding: "6px 10px", color: "#475569" }}>Workbooks</th>
                <th style={{ padding: "6px 10px", color: "#475569" }}>Storage size</th>
                <th style={{ padding: "6px 10px", color: "#475569", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snap) => {
                const badge = formatTriggerBadge(snap.triggerType);
                const isRestoring = restoringId === snap.id;
                const isDownloading = downloadingId === snap.id;
                const isDeleting = deletingId === snap.id;

                return (
                  <tr key={snap.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "6px 10px", color: "#1e293b", whiteSpace: "nowrap" }}>
                      {snap.createdAt ? new Date(snap.createdAt).toLocaleString("en-GB") : "—"}
                    </td>
                    <td style={{ padding: "6px 10px", fontWeight: "700", color: "#0f172a" }}>
                      {snap.clientName}
                    </td>
                    <td style={{ padding: "6px 10px" }}>
                      <span
                        style={{
                          padding: "2px 6px",
                          borderRadius: "4px",
                          fontSize: "10px",
                          fontWeight: "600",
                          background: badge.bg,
                          color: badge.color,
                        }}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td style={{ padding: "6px 10px", color: "#334155", maxWidth: "240px" }}>
                      <div
                        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={snap.label || ""}
                      >
                        {snap.label || <span style={{ color: "#94a3b8" }}>—</span>}
                      </div>
                    </td>
                    <td style={{ padding: "6px 10px", color: "#475569", whiteSpace: "nowrap" }}>
                      {`${snap.masterTabCount || 0}M / ${snap.reconTabCount || 0}R / ${snap.clientTabCount || 0}C`}
                    </td>
                    <td style={{ padding: "6px 10px", color: "#475569", whiteSpace: "nowrap" }}>
                      {formatBytes(snap.compressedBytes)}
                      {snap.rawBytes ? (
                        <span style={{ color: "#94a3b8", fontSize: "10px" }}>
                          {" "}
                          ({formatBytes(snap.rawBytes)} raw)
                        </span>
                      ) : null}
                    </td>
                    <td style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <div style={{ display: "inline-flex", gap: "5px", alignItems: "center" }}>
                        <button
                          type="button"
                          disabled={Boolean(restoringId)}
                          onClick={() => setConfirmRestoreSnap(snap)}
                          style={{
                            padding: "3px 8px",
                            fontSize: "10px",
                            fontWeight: "600",
                            borderRadius: "4px",
                            border: "1px solid #93c5fd",
                            background: isRestoring ? "#dbeafe" : "#eff6ff",
                            color: "#1e40af",
                            cursor: restoringId ? "wait" : "pointer",
                          }}
                        >
                          {isRestoring ? "Restoring..." : "Restore"}
                        </button>
                        <button
                          type="button"
                          disabled={isDownloading}
                          onClick={() => handleDownloadSnapshot(snap)}
                          style={{
                            padding: "3px 8px",
                            fontSize: "10px",
                            fontWeight: "600",
                            borderRadius: "4px",
                            border: "1px solid #cbd5e1",
                            background: "#fff",
                            color: "#334155",
                            cursor: isDownloading ? "wait" : "pointer",
                          }}
                        >
                          {isDownloading ? "Exporting..." : "Export .json"}
                        </button>
                        <button
                          type="button"
                          disabled={isDeleting}
                          onClick={() => handleDeleteSnapshot(snap)}
                          style={{
                            padding: "3px 7px",
                            fontSize: "10px",
                            fontWeight: "600",
                            borderRadius: "4px",
                            border: "1px solid #fecaca",
                            background: "#fef2f2",
                            color: "#dc2626",
                            cursor: isDeleting ? "wait" : "pointer",
                          }}
                        >
                          {isDeleting ? "..." : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {loading && snapshots.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: "16px", textAlign: "center", color: "#475569" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
                      <Spinner size={14} color="#1e40af" style={{ marginRight: 0 }} />
                      Loading backup snapshots...
                    </span>
                  </td>
                </tr>
              )}
              {!loading && snapshots.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: "14px", textAlign: "center", color: "#94a3b8" }}>
                    No snapshots stored yet for {showAllClients ? "any client" : activeClientName}. Click{" "}
                    <b>Take snapshot of {activeClientName}</b> or <b>Backup all Supabase clients now</b> above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
