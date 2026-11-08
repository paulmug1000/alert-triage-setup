import React, { useState, useEffect, useMemo } from "react";

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
  availableTabs = { master: [], recon: [] },
}) {
  const [sheetRole, setSheetRole] = useState("master");
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

  const [selectedCell, setSelectedCell] = useState({ r: 0, c: 0 });
  const [editValue, setEditValue] = useState("");
  const [savingCell, setSavingCell] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  const tabsForRole = useMemo(() => {
    const list = sheetRole === "recon" ? availableTabs?.recon || [] : availableTabs?.master || [];
    return list;
  }, [sheetRole, availableTabs]);

  useEffect(() => {
    if (!isOpen) return;
    if (tabsForRole.length > 0 && !tabsForRole.some((t) => t.tab_name === selectedTab)) {
      const preferred =
        sheetRole === "master"
          ? tabsForRole.find((t) => t.tab_name === "KeyInfo") || tabsForRole[0]
          : tabsForRole[0];
      if (preferred) setSelectedTab(preferred.tab_name);
    }
  }, [isOpen, sheetRole, tabsForRole, selectedTab]);

  const loadTabGrid = async (role = sheetRole, tab = selectedTab) => {
    if (!tab) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_tab_grid",
          clientName,
          sheetRole: role,
          tabName: tab,
          maxRows: 350,
          maxCols: 60,
        }),
      });
      const data = await res.json();
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

  useEffect(() => {
    if (isOpen && selectedTab) {
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
    return Math.min(60, Math.max(12, maxC));
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
    const rows = activeGrid || [];
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
    a.download = `${clientName}_${sheetRole}_${selectedTab}.csv`;
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
            </div>

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
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter rows in tab..."
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

        {/* Formula / cell edit bar */}
        <form
          onSubmit={handleSaveCell}
          style={{
            padding: "8px 20px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
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
                      const isSel = isSelectedRow && selectedCell.c === cIdx;
                      return (
                        <td
                          key={cIdx}
                          onClick={() => handleSelectCell(rIdx, cIdx)}
                          style={{
                            border: isSel ? "2px solid #2563eb" : "1px solid #e2e8f0",
                            padding: "4px 8px",
                            maxWidth: "240px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            cursor: "cell",
                            background: isSel ? "#eff6ff" : "#ffffff",
                            color: String(val).startsWith("=") ? "#1d4ed8" : "#0f172a",
                          }}
                          title={String(val)}
                        >
                          {String(val)}
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
      </div>
    </div>
  );
}

