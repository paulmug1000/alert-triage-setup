import React, { useState, useEffect, useMemo, useRef } from "react";

function colIdxToLetter(idx0) {
  let n = Number(idx0) + 1;
  let str = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    str = String.fromCharCode(65 + rem) + str;
    n = Math.floor((n - 1) / 26);
  }
  return str || "A";
}

export default function AdminWorkbookInspectorModal({
  isOpen,
  onClose,
  clientName = "APPTEST",
  availableTabs = { master: [], recon: [], client: [] },
  initialSheetRole = "master",
}) {
  const [sheetRole, setSheetRole] = useState(initialSheetRole || "master");
  const [selectedTab, setSelectedTab] = useState("KeyInfo");
  const [viewMode, setViewMode] = useState("values"); // 'values' | 'formulas'
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [gridData, setGridData] = useState({
    rowCount: 0,
    colCount: 0,
    valuesGrid: [],
    formulasGrid: [],
    updatedAt: null,
  });
  const [execLogsGrid, setExecLogsGrid] = useState([]);

  const gridReqIdRef = useRef(0);
  const execReqIdRef = useRef(0);

  const [expandedExecRow, setExpandedExecRow] = useState(1);
  const [copiedExecRow, setCopiedExecRow] = useState(null);
  const [runningSyncType, setRunningSyncType] = useState("");

  const [selectedCell, setSelectedCell] = useState({ r: 0, c: 0 });
  const [editValue, setEditValue] = useState("");
  const [savingCell, setSavingCell] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [wrapText, setWrapText] = useState(false);
  const [expandCellBar, setExpandCellBar] = useState(false);

  useEffect(() => {
    if (isOpen && initialSheetRole) {
      setSheetRole(initialSheetRole);
    }
  }, [isOpen, initialSheetRole]);

  const tabsForRole = useMemo(() => {
    const list =
      sheetRole === "recon"
        ? availableTabs?.recon || []
        : sheetRole === "client"
          ? availableTabs?.client || []
          : availableTabs?.master || [];
    return list.filter((t) => t.tab_name !== "GasExecLogs" && t.tab_name !== "GasScriptProps");
  }, [sheetRole, availableTabs]);

  useEffect(() => {
    if (!isOpen || sheetRole === "executions") return;
    if (tabsForRole.length > 0 && !tabsForRole.some((t) => t.tab_name === selectedTab)) {
      const preferred =
        sheetRole === "master"
          ? tabsForRole.find((t) => t.tab_name === "KeyInfo") || tabsForRole[0]
          : sheetRole === "client"
            ? tabsForRole.find((t) => t.tab_name === "Dashboard") || tabsForRole[0]
            : tabsForRole[0];
      if (preferred) setSelectedTab(preferred.tab_name);
    }
  }, [isOpen, sheetRole, tabsForRole, selectedTab]);

  const loadTabGrid = async (role = sheetRole, tab = selectedTab) => {
    const isExecRole = role === "executions" || tab === "GasExecLogs";
    const effectiveRole = isExecRole ? "master" : role;
    const effectiveTab = isExecRole ? "GasExecLogs" : tab;
    if (!effectiveTab) return;

    const reqId = isExecRole ? ++execReqIdRef.current : ++gridReqIdRef.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_tab_grid",
          clientName,
          sheetRole: effectiveRole,
          tabName: effectiveTab,
          maxRows: isExecRole ? 60 : 350,
          maxCols: isExecRole ? 10 : effectiveRole === "client" ? 110 : 60,
        }),
      });
      const data = await res.json();
      if (isExecRole) {
        if (reqId !== execReqIdRef.current) return;
        if (!res.ok || !data.success) {
          setExecLogsGrid([]);
          return;
        }
        setExecLogsGrid(Array.isArray(data.valuesGrid) ? data.valuesGrid : []);
        return;
      }

      if (reqId !== gridReqIdRef.current) return;
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load workbook tab");
      }
      setGridData({
        rowCount: data.rowCount || 0,
        colCount: data.colCount || 0,
        valuesGrid: data.valuesGrid || [],
        formulasGrid: data.formulasGrid || [],
        updatedAt: data.updatedAt || null,
      });
      const initialVal = data.valuesGrid?.[0]?.[0] ?? "";
      setSelectedCell({ r: 0, c: 0 });
      setEditValue(String(initialVal));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRunSequenceFromConsole = async (syncType) => {
    setRunningSyncType(syncType);
    setError("");
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run_native_sync",
          clientName,
          syncType,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Sequence run failed");
      }
      await loadTabGrid("executions", "GasExecLogs");
      setExpandedExecRow(1);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunningSyncType("");
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    if (sheetRole === "executions") {
      loadTabGrid("executions", "GasExecLogs");
    } else if (selectedTab) {
      loadTabGrid(sheetRole, selectedTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, clientName, sheetRole, selectedTab]);

  const activeGrid = viewMode === "formulas" ? gridData.formulasGrid : gridData.valuesGrid;

  const filteredRowIndices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const total = Math.max(activeGrid.length, 30);
    const indices = [];
    for (let r = 0; r < total; r++) {
      if (!q) {
        indices.push(r);
        continue;
      }
      const rowArr = activeGrid[r] || [];
      if (rowArr.some((cell) => String(cell ?? "").toLowerCase().includes(q))) {
        indices.push(r);
      }
    }
    return indices;
  }, [activeGrid, searchQuery]);

  const visibleColCount = useMemo(() => {
    let maxC = 12;
    for (const r of activeGrid) {
      if (Array.isArray(r) && r.length > maxC) maxC = r.length;
    }
    return Math.min(110, Math.max(12, maxC));
  }, [activeGrid]);

  const handleSelectCell = (r, c) => {
    setSelectedCell({ r, c });
    const raw =
      viewMode === "formulas"
        ? gridData.formulasGrid?.[r]?.[c] ?? gridData.valuesGrid?.[r]?.[c] ?? ""
        : gridData.valuesGrid?.[r]?.[c] ?? "";
    setEditValue(String(raw));
    setSaveMessage("");
  };

  const handleSaveCell = async (e) => {
    if (e) e.preventDefault();
    setSavingCell(true);
    setSaveMessage("");
    setError("");
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cell",
          clientName,
          sheetRole,
          tabName: selectedTab,
          rowIndex0: selectedCell.r,
          colIndex0: selectedCell.c,
          value: editValue,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to update cell");
      }
      setGridData((prev) => {
        const nextV = prev.valuesGrid.map((row) => (Array.isArray(row) ? [...row] : []));
        const nextF = prev.formulasGrid.map((row) => (Array.isArray(row) ? [...row] : []));
        while (nextV.length <= selectedCell.r) nextV.push([]);
        while (nextF.length <= selectedCell.r) nextF.push([]);
        nextV[selectedCell.r][selectedCell.c] = editValue;
        nextF[selectedCell.r][selectedCell.c] = editValue;
        return { ...prev, valuesGrid: nextV, formulasGrid: nextF };
      });
      setSaveMessage(`Saved ${data.cellCoord}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingCell(false);
    }
  };

  const handleExportCsv = () => {
    const rows = sheetRole === "executions" ? execLogsGrid || [] : activeGrid || [];
    const csvLines = rows.map((r) =>
      (Array.isArray(r) ? r : [])
        .map((c) => {
          const s = String(c ?? "");
          if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        })
        .join(",")
    );
    const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${clientName}_${sheetRole}_${sheetRole === "executions" ? "GasExecLogs" : selectedTab}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  const coordLabel = `${colIdxToLetter(selectedCell.c)}${selectedCell.r + 1}`;
  const selectedFormula = gridData.formulasGrid?.[selectedCell.r]?.[selectedCell.c] ?? "";
  const selectedDisplayed = gridData.valuesGrid?.[selectedCell.r]?.[selectedCell.c] ?? "";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(15, 23, 42, 0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        style={{
          width: "96vw",
          height: "90vh",
          background: "#ffffff",
          borderRadius: "12px",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        }}
      >
        {/* Top bar */}
        <div
          style={{
            padding: "14px 20px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            background: "#f8fafc",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "#0f172a" }}>
              Admin workbook inspector — {clientName}
            </h3>
            <div
              style={{
                display: "inline-flex",
                background: "#e2e8f0",
                borderRadius: "8px",
                padding: "3px",
              }}
            >
              <button
                type="button"
                onClick={() => setSheetRole("master")}
                style={{
                  padding: "5px 12px",
                  fontSize: "12px",
                  fontWeight: 600,
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  background: sheetRole === "master" ? "#ffffff" : "transparent",
                  color: sheetRole === "master" ? "#0f172a" : "#475569",
                }}
              >
                Master engine ({availableTabs?.master?.length || 0} tabs)
              </button>
              <button
                type="button"
                onClick={() => setSheetRole("recon")}
                style={{
                  padding: "5px 12px",
                  fontSize: "12px",
                  fontWeight: 600,
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  background: sheetRole === "recon" ? "#ffffff" : "transparent",
                  color: sheetRole === "recon" ? "#0f172a" : "#475569",
                }}
              >
                Bank recon ({availableTabs?.recon?.length || 0} tabs)
              </button>
              <button
                type="button"
                onClick={() => setSheetRole("client")}
                style={{
                  padding: "5px 12px",
                  fontSize: "12px",
                  fontWeight: 600,
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  background: sheetRole === "client" ? "#ffffff" : "transparent",
                  color: sheetRole === "client" ? "#0f172a" : "#475569",
                }}
              >
                Client portal ({availableTabs?.client?.length || 0} tabs)
              </button>
              <button
                type="button"
                onClick={() => setSheetRole("executions")}
                style={{
                  padding: "5px 12px",
                  fontSize: "12px",
                  fontWeight: 600,
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  background: sheetRole === "executions" ? "#ffffff" : "transparent",
                  color: sheetRole === "executions" ? "#0f172a" : "#475569",
                }}
              >
                GAS execution logs
              </button>
            </div>

            {sheetRole !== "executions" && (
              <>
                <div
                  style={{
                    display: "inline-flex",
                    background: "#e2e8f0",
                    borderRadius: "8px",
                    padding: "3px",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setViewMode("values")}
                    style={{
                      padding: "5px 10px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "6px",
                      border: "none",
                      cursor: "pointer",
                      background: viewMode === "values" ? "#ffffff" : "transparent",
                      color: viewMode === "values" ? "#0f172a" : "#475569",
                    }}
                  >
                    Displayed values
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("formulas")}
                    style={{
                      padding: "5px 10px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "6px",
                      border: "none",
                      cursor: "pointer",
                      background: viewMode === "formulas" ? "#ffffff" : "transparent",
                      color: viewMode === "formulas" ? "#0f172a" : "#475569",
                    }}
                  >
                    Formulas
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setWrapText((prev) => !prev)}
                  style={{
                    padding: "5px 10px",
                    fontSize: "12px",
                    fontWeight: 600,
                    borderRadius: "6px",
                    border: wrapText ? "1px solid #2563eb" : "1px solid #cbd5e1",
                    cursor: "pointer",
                    background: wrapText ? "#eff6ff" : "#ffffff",
                    color: wrapText ? "#1d4ed8" : "#475569",
                  }}
                  title="Toggle multi-line text wrapping across all cells in the grid"
                >
                  {wrapText ? "Wrap text: on" : "Wrap text"}
                </button>
              </>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={sheetRole === "executions" ? "Filter execution logs..." : "Filter rows in tab..."}
              style={{
                padding: "6px 10px",
                fontSize: "12px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                width: "180px",
              }}
            />
            <button
              type="button"
              onClick={() => loadTabGrid(sheetRole, selectedTab)}
              disabled={loading}
              style={{
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 500,
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: "#ffffff",
                color: "#334155",
                cursor: "pointer",
              }}
            >
              {loading ? "Loading..." : "Refresh"}
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              style={{
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 500,
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: "#ffffff",
                color: "#334155",
                cursor: "pointer",
              }}
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 600,
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: "#0f172a",
                color: "#ffffff",
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </div>

        {sheetRole === "executions" ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "#f8fafc" }}>
            <div
              style={{
                padding: "10px 20px",
                borderBottom: "1px solid #e2e8f0",
                background: "#ffffff",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a" }}>
                  Verbatim GAS execution console
                </span>
                <span style={{ fontSize: "12px", color: "#64748b" }}>
                  Captures every console.log, console.warn, console.error, and Logger.log line emitted by the native GAS runtime (most recent 40 runs).
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                {[
                  { key: "crm", label: "Run CRM sequence" },
                  { key: "invoice", label: "Run invoice sequence" },
                  { key: "expense", label: "Run expense sequence" },
                ].map((btn) => (
                  <button
                    key={btn.key}
                    type="button"
                    disabled={Boolean(runningSyncType)}
                    onClick={() => handleRunSequenceFromConsole(btn.key)}
                    style={{
                      padding: "6px 12px",
                      fontSize: "12px",
                      fontWeight: 600,
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: runningSyncType === btn.key ? "#eff6ff" : "#ffffff",
                      color: runningSyncType === btn.key ? "#1d4ed8" : "#0f172a",
                      cursor: runningSyncType ? "wait" : "pointer",
                    }}
                  >
                    {runningSyncType === btn.key ? `Running ${btn.key.toUpperCase()}...` : btn.label}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div style={{ padding: "8px 20px", background: "#fef2f2", color: "#b91c1c", fontSize: "12px", borderBottom: "1px solid #fecaca" }}>
                {error}
              </div>
            )}

            <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
              {(() => {
                const rawRows = Array.isArray(execLogsGrid) ? execLogsGrid.slice(1) : [];
                const q = searchQuery.trim().toLowerCase();
                const execRows = rawRows
                  .map((r, idx) => ({ row: Array.isArray(r) ? r : [], rowNumber: idx + 1 }))
                  .filter(({ row }) => {
                    if (!row.length || (!row[0] && !row[1])) return false;
                    if (!q) return true;
                    return row.some((c) => String(c ?? "").toLowerCase().includes(q));
                  });

                if (execRows.length === 0) {
                  return (
                    <div
                      style={{
                        padding: "32px",
                        textAlign: "center",
                        background: "#ffffff",
                        border: "1px solid #e2e8f0",
                        borderRadius: "8px",
                        color: "#64748b",
                        fontSize: "13px",
                      }}
                    >
                      {loading
                        ? "Loading execution logs..."
                        : "No GAS executions recorded yet. Click one of the sequence buttons above or wait for the next scheduled automation run."}
                    </div>
                  );
                }

                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div
                      style={{
                        padding: "6px 14px",
                        display: "grid",
                        gridTemplateColumns: "180px minmax(240px, 1.4fr) 150px 90px 105px 1fr 28px",
                        alignItems: "center",
                        gap: "12px",
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "#64748b",
                        borderBottom: "1px solid #e2e8f0",
                        marginBottom: "2px",
                      }}
                    >
                      <span>Timestamp</span>
                      <span>Function / sequence</span>
                      <span>Trigger source</span>
                      <span>Duration</span>
                      <span>Status</span>
                      <span>Summary</span>
                      <span style={{ textAlign: "right" }}>Log</span>
                    </div>
                    {execRows.map(({ row, rowNumber }) => {
                      const [ts, fnName, triggerSource, duration, status, summary, transcript] = row;
                      const isExpanded = expandedExecRow === rowNumber;
                      const isCompleted = String(status || "").toLowerCase() === "completed";
                      const lines = String(transcript || "")
                        .split("\n")
                        .filter(Boolean);

                      return (
                        <div
                          key={rowNumber}
                          style={{
                            background: "#ffffff",
                            border: isExpanded ? "1px solid #93c5fd" : "1px solid #e2e8f0",
                            borderRadius: "8px",
                            overflow: "hidden",
                            boxShadow: isExpanded ? "0 4px 12px rgba(15, 23, 42, 0.06)" : "none",
                          }}
                        >
                          <div
                            onClick={() => setExpandedExecRow(isExpanded ? null : rowNumber)}
                            style={{
                              padding: "10px 14px",
                              display: "grid",
                              gridTemplateColumns: "180px minmax(240px, 1.4fr) 150px 90px 105px 1fr 28px",
                              alignItems: "center",
                              gap: "12px",
                              cursor: "pointer",
                              background: isExpanded ? "#f8fafc" : "#ffffff",
                              fontSize: "12px",
                            }}
                          >
                            <span style={{ fontFamily: "monospace", color: "#334155", fontWeight: 500 }}>
                              {ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "medium" }) : "—"}
                            </span>
                            <span style={{ fontFamily: "monospace", fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={String(fnName || "")}>
                              {fnName || "GAS execution"}
                            </span>
                            <span style={{ color: "#475569" }}>{triggerSource || "Scheduled"}</span>
                            <span style={{ fontFamily: "monospace", color: "#475569" }}>{duration || "—"}</span>
                            <span>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 8px",
                                  borderRadius: "999px",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  background: isCompleted ? "#dcfce7" : "#fee2e2",
                                  color: isCompleted ? "#15803d" : "#b91c1c",
                                }}
                              >
                                {status || "Completed"}
                              </span>
                            </span>
                            <span style={{ color: "#475569", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={String(summary || "")}>
                              {summary || `${lines.length} log lines`}
                            </span>
                            <span style={{ color: "#64748b", textAlign: "right", fontWeight: 700 }}>
                              {isExpanded ? "▾" : "▸"}
                            </span>
                          </div>

                          {isExpanded && (
                            <div
                              style={{
                                borderTop: "1px solid #e2e8f0",
                                background: "#0f172a",
                                color: "#e2e8f0",
                                padding: "12px 16px",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  marginBottom: "8px",
                                  paddingBottom: "6px",
                                  borderBottom: "1px solid #1e293b",
                                }}
                              >
                                <span style={{ fontSize: "11px", color: "#94a3b8", fontFamily: "monospace" }}>
                                  Cloud logs transcript ({lines.length} lines) — {fnName}
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard?.writeText(String(transcript || ""));
                                    setCopiedExecRow(rowNumber);
                                    setTimeout(() => setCopiedExecRow(null), 1800);
                                  }}
                                  style={{
                                    padding: "3px 8px",
                                    fontSize: "11px",
                                    borderRadius: "4px",
                                    border: "1px solid #334155",
                                    background: "#1e293b",
                                    color: "#e2e8f0",
                                    cursor: "pointer",
                                  }}
                                >
                                  {copiedExecRow === rowNumber ? "Copied" : "Copy log"}
                                </button>
                              </div>
                              <div
                                style={{
                                  maxHeight: "340px",
                                  overflowY: "auto",
                                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                  fontSize: "11.5px",
                                  lineHeight: 1.55,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                }}
                              >
                                {lines.length === 0 ? (
                                  <div style={{ color: "#64748b" }}>No console output emitted during this execution.</div>
                                ) : (
                                  lines.map((line, lIdx) => {
                                    let lineColor = "#e2e8f0";
                                    if (line.includes("[ERROR]") || line.includes("❌")) lineColor = "#fca5a5";
                                    else if (line.includes("[WARN]") || line.includes("⚠️")) lineColor = "#fde047";
                                    else if (line.includes("✅") || line.includes("=== COMPLETE")) lineColor = "#86efac";
                                    else if (line.includes("--- Step")) lineColor = "#93c5fd";
                                    return (
                                      <div key={lIdx} style={{ color: lineColor }}>
                                        {line}
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        ) : (
          <>
            {/* Formula / cell edit bar */}
            <form
              onSubmit={handleSaveCell}
              style={{
                padding: "8px 20px",
                borderBottom: "1px solid #e2e8f0",
                display: "flex",
                alignItems: expandCellBar || editValue.includes("\n") || editValue.length > 120 ? "flex-start" : "center",
                gap: "10px",
                background: "#ffffff",
              }}
            >
              <span
                style={{
                  minWidth: "110px",
                  padding: "4px 8px",
                  borderRadius: "4px",
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  fontFamily: "monospace",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#0f172a",
                  textAlign: "center",
                }}
              >
                {selectedTab}!{coordLabel}
              </span>
              {expandCellBar || editValue.includes("\n") || editValue.length > 120 ? (
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder="Cell value..."
                  rows={expandCellBar ? 10 : Math.min(8, Math.max(3, editValue.split("\n").length))}
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    fontSize: "12px",
                    fontFamily: "monospace",
                    lineHeight: 1.5,
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    resize: "vertical",
                    whiteSpace: "pre-wrap",
                  }}
                />
              ) : (
                <input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder="Cell value..."
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    fontSize: "12px",
                    fontFamily: "monospace",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                  }}
                />
              )}
              <button
                type="button"
                onClick={() => setExpandCellBar((prev) => !prev)}
                style={{
                  padding: "6px 10px",
                  fontSize: "12px",
                  fontWeight: 500,
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: expandCellBar ? "#eff6ff" : "#f8fafc",
                  color: expandCellBar ? "#1d4ed8" : "#334155",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                title="Expand or collapse the cell value box"
              >
                {expandCellBar ? "Collapse cell" : "Expand cell"}
              </button>
              <button
                type="submit"
                disabled={savingCell}
                style={{
                  padding: "6px 14px",
                  fontSize: "12px",
                  fontWeight: 600,
                  borderRadius: "6px",
                  border: "none",
                  background: "#2563eb",
                  color: "#ffffff",
                  cursor: savingCell ? "wait" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {savingCell ? "Saving..." : "Save cell"}
              </button>
              {selectedFormula && String(selectedFormula).startsWith("=") && (
                <span style={{ fontSize: "11px", color: "#64748b", fontFamily: "monospace" }}>
                  Formula: {String(selectedFormula).slice(0, 60)} | Displayed: {String(selectedDisplayed)}
                </span>
              )}
              {saveMessage && (
                <span style={{ fontSize: "12px", fontWeight: 600, color: "#15803d" }}>{saveMessage}</span>
              )}
              {error && <span style={{ fontSize: "12px", color: "#b91c1c" }}>{error}</span>}
            </form>

            {/* Grid viewport */}
            <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
              <table
                style={{
                  borderCollapse: "collapse",
                  fontSize: "12px",
                  fontFamily: "Inter, system-ui, sans-serif",
                  minWidth: "100%",
                }}
              >
                <thead style={{ position: "sticky", top: 0, zIndex: 2, background: "#f1f5f9" }}>
                  <tr>
                    <th
                      style={{
                        position: "sticky",
                        left: 0,
                        zIndex: 3,
                        background: "#e2e8f0",
                        border: "1px solid #cbd5e1",
                        padding: "4px 8px",
                        minWidth: "44px",
                        color: "#475569",
                        fontWeight: 600,
                      }}
                    >
                      Row
                    </th>
                    {Array.from({ length: visibleColCount }).map((_, cIdx) => (
                      <th
                        key={cIdx}
                        style={{
                          border: "1px solid #cbd5e1",
                          padding: "4px 8px",
                          minWidth: "95px",
                          color: "#334155",
                          fontWeight: 600,
                          textAlign: "center",
                          background: selectedCell.c === cIdx ? "#dbeafe" : "#f1f5f9",
                        }}
                      >
                        {colIdxToLetter(cIdx)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRowIndices.map((rIdx) => {
                    const rowArr = activeGrid[rIdx] || [];
                    const isSelectedRow = selectedCell.r === rIdx;
                    return (
                      <tr key={rIdx}>
                        <td
                          style={{
                            position: "sticky",
                            left: 0,
                            zIndex: 1,
                            background: isSelectedRow ? "#dbeafe" : "#f8fafc",
                            border: "1px solid #cbd5e1",
                            padding: "3px 8px",
                            textAlign: "right",
                            fontWeight: 600,
                            color: "#64748b",
                            fontFamily: "monospace",
                          }}
                        >
                          {rIdx + 1}
                        </td>
                        {Array.from({ length: visibleColCount }).map((_, cIdx) => {
                          const val = rowArr[cIdx] ?? "";
                          const valStr = String(val);
                          const isSel = isSelectedRow && selectedCell.c === cIdx;
                          const shouldWrapCell =
                            wrapText || (isSel && (expandCellBar || valStr.includes("\n") || valStr.length > 120));
                          return (
                            <td
                              key={cIdx}
                              onClick={() => handleSelectCell(rIdx, cIdx)}
                              onDoubleClick={() => setExpandCellBar((prev) => !prev)}
                              style={{
                                border: isSel ? "2px solid #2563eb" : "1px solid #e2e8f0",
                                padding: "4px 8px",
                                maxWidth: shouldWrapCell ? "560px" : "240px",
                                overflow: "hidden",
                                textOverflow: shouldWrapCell ? "clip" : "ellipsis",
                                whiteSpace: shouldWrapCell ? "pre-wrap" : "nowrap",
                                wordBreak: shouldWrapCell ? "break-word" : "normal",
                                verticalAlign: shouldWrapCell ? "top" : "middle",
                                cursor: "cell",
                                background: isSel ? "#eff6ff" : "#ffffff",
                                color: valStr.startsWith("=") ? "#1d4ed8" : "#0f172a",
                              }}
                              title={valStr}
                            >
                              {valStr}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Bottom sheet tab strip */}
            <div
              style={{
                padding: "8px 16px",
                borderTop: "1px solid #e2e8f0",
                background: "#f8fafc",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                overflowX: "auto",
              }}
            >
              {tabsForRole.map((t) => {
                const active = t.tab_name === selectedTab;
                return (
                  <button
                    key={t.tab_name}
                    type="button"
                    onClick={() => setSelectedTab(t.tab_name)}
                    style={{
                      padding: "6px 12px",
                      fontSize: "12px",
                      fontWeight: active ? 600 : 500,
                      borderRadius: "6px",
                      border: active ? "1px solid #2563eb" : "1px solid #cbd5e1",
                      background: active ? "#eff6ff" : "#ffffff",
                      color: active ? "#1d4ed8" : "#334155",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.tab_name}
                    <span style={{ marginLeft: "6px", fontSize: "10px", color: "#64748b" }}>
                      ({t.row_count || 0})
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

