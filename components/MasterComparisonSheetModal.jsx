import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Spinner from "./Spinner";
import {
  COMPARISON_SHEET_SPECS,
  colIndexToLetter,
  precomputeInvCompBhCounts,
  getCellPresentation,
  formatCellForComparisonSheet,
  isRowDiscrepancy,
} from "../utils/masterComparisonSheetSpec";

const COMPARISON_TABS = ["InvComp", "DirComp", "CRMComp"];

const COMPARISON_TAB_CACHE = new Map();
const COMPARISON_INFLIGHT = new Map();
const COMPARISON_CACHE_TTL_MS = 60000;
const COMPARISON_STALE_REFRESH_MS = 15000;

function normalizeGridPayload(data) {
  return {
    rowCount: data.rowCount || 0,
    colCount: data.colCount || 0,
    valuesGrid: Array.isArray(data.valuesGrid) ? data.valuesGrid : [],
    rawValuesGrid: Array.isArray(data.rawValuesGrid) ? data.rawValuesGrid : [],
    notesGrid:
      data.notesGrid && typeof data.notesGrid === "object" && !Array.isArray(data.notesGrid)
        ? data.notesGrid
        : {},
    staleAgainstClientEdits: Boolean(data.staleAgainstClientEdits),
    updatedAt: data.updatedAt || null,
  };
}

export function invalidateComparisonModalCache(clientName = "") {
  const clean = String(clientName || "").trim().toLowerCase();
  if (!clean) {
    COMPARISON_TAB_CACHE.clear();
    return;
  }
  const prefix = `${clean}::`;
  for (const key of COMPARISON_TAB_CACHE.keys()) {
    if (key.startsWith(prefix)) {
      COMPARISON_TAB_CACHE.delete(key);
    }
  }
}

async function fetchComparisonTabPayload(clientName, tabName) {
  const targetSpec = COMPARISON_SHEET_SPECS[tabName] || COMPARISON_SHEET_SPECS.InvComp;
  const key = `${String(clientName || "").trim().toLowerCase()}::${tabName}`;
  if (COMPARISON_INFLIGHT.has(key)) {
    return COMPARISON_INFLIGHT.get(key);
  }
  const promise = (async () => {
    const res = await fetch("/api/pma/master-engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "get_tab_grid",
        clientName,
        sheetRole: "master",
        tabName,
        maxRows: 1000,
        maxCols: targetSpec.totalCols,
        includeFormulas: false,
        includeRawValues: true,
        includeNotes: true,
        trimTrailingEmptyRows: true,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Failed to load ${tabName}.`);
    }
    const payload = normalizeGridPayload(data);
    COMPARISON_TAB_CACHE.set(key, { payload, cachedAt: Date.now() });
    return payload;
  })().finally(() => {
    COMPARISON_INFLIGHT.delete(key);
  });
  COMPARISON_INFLIGHT.set(key, promise);
  return promise;
}

export async function prefetchComparisonTab(clientName, tabName) {
  if (!clientName || !tabName) return null;
  const key = `${String(clientName).trim().toLowerCase()}::${tabName}`;
  const cached = COMPARISON_TAB_CACHE.get(key);
  if (cached && Date.now() - cached.cachedAt < COMPARISON_CACHE_TTL_MS) {
    return cached.payload;
  }
  try {
    return await fetchComparisonTabPayload(clientName, tabName);
  } catch (_) {
    return null;
  }
}

function getLastNonEmptyRowIdx(valuesGrid) {
  if (!Array.isArray(valuesGrid)) return 25;
  for (let r = valuesGrid.length - 1; r >= 5; r--) {
    const row = valuesGrid[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v !== null && v !== undefined && v !== false) {
        const s = String(v).trim();
        if (s !== "" && s.toUpperCase() !== "FALSE") {
          return Math.max(25, r + 5);
        }
      }
    }
  }
  return 25;
}

export default function MasterComparisonSheetModal({
  isOpen,
  onClose,
  clientName = "APPTEST",
  initialTab = "InvComp",
  onAfterMutate,
}) {
  const [activeTab, setActiveTab] = useState(
    COMPARISON_TABS.includes(initialTab) ? initialTab : "InvComp"
  );
  const [loading, setLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [updatingCellKey, setUpdatingCellKey] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState(null);

  const [gridData, setGridData] = useState({
    rowCount: 0,
    colCount: 0,
    valuesGrid: [],
    rawValuesGrid: [],
    notesGrid: {},
    staleAgainstClientEdits: false,
    updatedAt: null,
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [discrepanciesOnly, setDiscrepanciesOnly] = useState(false);
  const [showHiddenCols, setShowHiddenCols] = useState(false);
  const [showTrailingCols, setShowTrailingCols] = useState(false);
  const [rowRenderLimit, setRowRenderLimit] = useState(120);
  const [selectedCell, setSelectedCell] = useState({ r: 0, c: 0 });
  const [editingTextCell, setEditingTextCell] = useState(false);
  const [formulaBarDraft, setFormulaBarDraft] = useState("");

  const scrollViewportRef = useRef(null);
  const reqIdRef = useRef(0);
  const recomputingRef = useRef(false);
  const autoRecomputedKeyRef = useRef("");

  useEffect(() => {
    if (isOpen) {
      setActiveTab(COMPARISON_TABS.includes(initialTab) ? initialTab : "InvComp");
      setError("");
      setFeedback(null);
      setSelectedCell({ r: 0, c: 0 });
      setEditingTextCell(false);
      setRowRenderLimit(120);
      autoRecomputedKeyRef.current = "";
    }
  }, [isOpen, initialTab, clientName]);

  const spec = COMPARISON_SHEET_SPECS[activeTab] || COMPARISON_SHEET_SPECS.InvComp;

  const triggerRecomputeInternal = useCallback(
    async ({ autoFromClientEdits = false, tabForReload = activeTab } = {}) => {
      if (recomputingRef.current) return;
      recomputingRef.current = true;
      setRecomputing(true);
      if (!autoFromClientEdits) {
        setError("");
        setFeedback(null);
      } else {
        setFeedback({
          type: "info",
          message: "Updating comparisons for recent client edits...",
        });
      }
      const startMs = Date.now();
      try {
        const res = await fetch("/api/pma/master-engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "run_native_sync",
            clientName,
            syncType: "recompute",
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Recompute comparisons failed.");
        }
        invalidateComparisonModalCache(clientName);
        const freshPayload = await fetchComparisonTabPayload(clientName, tabForReload);
        setGridData(freshPayload);
        for (const otherTab of COMPARISON_TABS) {
          if (otherTab !== tabForReload) {
            prefetchComparisonTab(clientName, otherTab);
          }
        }
        const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
        setFeedback({
          type: "success",
          message: autoFromClientEdits
            ? `Comparisons refreshed for recent client edits (${elapsedSec}s)`
            : `Comparisons recomputed for ${clientName} in ${elapsedSec}s`,
        });
        if (typeof onAfterMutate === "function") {
          onAfterMutate(data);
        }
      } catch (err) {
        setError(err.message || "Failed to recompute comparisons.");
      } finally {
        recomputingRef.current = false;
        setRecomputing(false);
      }
    },
    [clientName, activeTab, onAfterMutate]
  );

  const loadTab = useCallback(
    async (tabToLoad = activeTab, { forceNetwork = false } = {}) => {
      if (!clientName || !tabToLoad) return;
      const reqId = ++reqIdRef.current;
      const cacheKey = `${String(clientName).trim().toLowerCase()}::${tabToLoad}`;
      const cached = !forceNetwork ? COMPARISON_TAB_CACHE.get(cacheKey) : null;
      const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;

      if (cached && cacheAge < COMPARISON_CACHE_TTL_MS) {
        setGridData(cached.payload);
        setLoading(false);
        setError("");
        for (const otherTab of COMPARISON_TABS) {
          if (otherTab !== tabToLoad) {
            prefetchComparisonTab(clientName, otherTab);
          }
        }
        if (cacheAge < COMPARISON_STALE_REFRESH_MS) {
          const staleToken = `${clientName}:${cached.payload.updatedAt || ""}`;
          if (cached.payload.staleAgainstClientEdits && autoRecomputedKeyRef.current !== staleToken) {
            autoRecomputedKeyRef.current = staleToken;
            triggerRecomputeInternal({ autoFromClientEdits: true, tabForReload: tabToLoad });
          }
          return;
        }
      }

      if (!cached) {
        setLoading(true);
      }
      setError("");
      try {
        const payload = await fetchComparisonTabPayload(clientName, tabToLoad);
        if (reqId !== reqIdRef.current) return;
        setGridData(payload);

        for (const otherTab of COMPARISON_TABS) {
          if (otherTab !== tabToLoad) {
            prefetchComparisonTab(clientName, otherTab);
          }
        }

        const staleToken = `${clientName}:${payload.updatedAt || ""}`;
        if (payload.staleAgainstClientEdits && autoRecomputedKeyRef.current !== staleToken) {
          autoRecomputedKeyRef.current = staleToken;
          triggerRecomputeInternal({ autoFromClientEdits: true, tabForReload: tabToLoad });
        }
      } catch (err) {
        if (reqId !== reqIdRef.current) return;
        setError(err.message || `Error loading ${tabToLoad}.`);
      } finally {
        if (reqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    },
    [clientName, activeTab, triggerRecomputeInternal]
  );

  useEffect(() => {
    if (isOpen) {
      loadTab(activeTab);
    }
  }, [isOpen, activeTab, loadTab]);

  const handleUpdateCell = async (r, c, newValue) => {
    const key = `${r}:${c}`;
    setUpdatingCellKey(key);
    setFeedback(null);
    setError("");
    const startMs = Date.now();
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cell",
          clientName,
          sheetRole: "master",
          tabName: activeTab,
          rowIndex0: r,
          colIndex0: c,
          value: newValue,
          maxRows: 1000,
          maxCols: spec.totalCols,
          includeFormulas: false,
          includeRawValues: true,
          includeNotes: true,
          trimTrailingEmptyRows: true,
          returnUpdatedGrid: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to update cell.");
      }
      invalidateComparisonModalCache(clientName);
      if (data.gridData) {
        const normalized = normalizeGridPayload(data.gridData);
        const cacheKey = `${String(clientName).trim().toLowerCase()}::${activeTab}`;
        COMPARISON_TAB_CACHE.set(cacheKey, { payload: normalized, cachedAt: Date.now() });
        setGridData(normalized);
      } else {
        await loadTab(activeTab, { forceNetwork: true });
      }
      const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
      setFeedback({
        type: "success",
        message: `Updated ${activeTab}!${colIndexToLetter(c)}${r + 1} (${elapsedSec}s)`,
      });
      setEditingTextCell(false);
      if (typeof onAfterMutate === "function") {
        onAfterMutate(data);
      }
    } catch (err) {
      setError(err.message || "Failed to save cell change.");
    } finally {
      setUpdatingCellKey("");
    }
  };

  const handleRecompute = () => triggerRecomputeInternal({ autoFromClientEdits: false, tabForReload: activeTab });

  const visibleCols = useMemo(() => {
    const maxColIndex = showTrailingCols ? spec.totalCols - 1 : spec.primaryEndCol;
    const list = [];
    for (let c = 0; c <= maxColIndex; c++) {
      if (!showHiddenCols && spec.hiddenCols.has(c)) continue;
      list.push(c);
    }
    return list;
  }, [spec, showHiddenCols, showTrailingCols]);

  const colLeftOffsets = useMemo(() => {
    const map = new Map();
    let left = 44;
    for (const c of visibleCols) {
      map.set(c, left);
      left += spec.widths[c] || 100;
    }
    return map;
  }, [visibleCols, spec]);

  const jumpToColumn = (targetCol) => {
    if (!scrollViewportRef.current) return;
    let offset = colLeftOffsets.get(targetCol);
    if (offset === undefined) {
      const nearest = visibleCols.find((c) => c >= targetCol);
      offset = nearest !== undefined ? colLeftOffsets.get(nearest) : 0;
    }
    scrollViewportRef.current.scrollTo({
      left: Math.max(0, (offset || 0) - 48),
      behavior: "smooth",
    });
  };

  const bhCounts = useMemo(() => {
    if (activeTab !== "InvComp") return null;
    return precomputeInvCompBhCounts(gridData.valuesGrid);
  }, [activeTab, gridData.valuesGrid]);

  const { discrepancyRowCount, filteredDataRows, totalActiveDataRows } = useMemo(() => {
    const values = gridData.valuesGrid || [];
    const lastRow = Math.min(values.length - 1, getLastNonEmptyRowIdx(values));
    const q = searchQuery.trim().toLowerCase();
    let discCount = 0;
    const rows = [];
    const totalData = Math.max(0, lastRow - 4);

    for (let r = 5; r <= lastRow; r++) {
      const rowVals = values[r] || [];
      const hasDisc = isRowDiscrepancy(activeTab, rowVals, r);
      if (hasDisc) discCount++;
      if (discrepanciesOnly && !hasDisc) continue;
      if (q) {
        const match = visibleCols.some((c) =>
          String(rowVals[c] ?? "").toLowerCase().includes(q)
        );
        if (!match) continue;
      }
      rows.push(r);
    }
    return {
      discrepancyRowCount: discCount,
      filteredDataRows: rows,
      totalActiveDataRows: totalData,
    };
  }, [gridData.valuesGrid, activeTab, discrepanciesOnly, searchQuery, visibleCols]);

  const displayedDataRows = useMemo(
    () => filteredDataRows.slice(0, rowRenderLimit),
    [filteredDataRows, rowRenderLimit]
  );

  useEffect(() => {
    const { r, c } = selectedCell;
    const note = gridData.notesGrid?.[`${r}:${c}`];
    const disp = gridData.valuesGrid?.[r]?.[c] ?? "";
    setFormulaBarDraft(note ? String(note) : String(disp));
    setEditingTextCell(false);
  }, [selectedCell, gridData]);

  const handleExportCsv = () => {
    const values = gridData.valuesGrid || [];
    const lastRow = Math.min(values.length - 1, getLastNonEmptyRowIdx(values));
    const lines = [];
    for (let r = 0; r <= lastRow; r++) {
      const row = values[r] || [];
      const cols = visibleCols.map((c) => {
        const disp = row[c] ?? "";
        const s = String(disp).replace(/"/g, '""');
        return `"${s}"`;
      });
      lines.push(cols.join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${clientName}_${activeTab}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  const selR = selectedCell.r;
  const selC = selectedCell.c;
  const selCoord = `${colIndexToLetter(selC)}${selR + 1}`;
  const selNote = gridData.notesGrid?.[`${selR}:${selC}`] || "";
  const selRaw = gridData.rawValuesGrid?.[selR]?.[selC];
  const selDisp = gridData.valuesGrid?.[selR]?.[selC] ?? "";

  const renderRow = (r, isHeaderRow) => {
    const rowVals = gridData.valuesGrid?.[r] || [];
    const rowRaws = gridData.rawValuesGrid?.[r] || [];
    const baseHeight = spec.rowHeights[r] ?? spec.rowHeights.default ?? 20;
    const canMergeG1H1 = r === 0 && visibleCols.includes(6) && visibleCols.includes(7);

    const cells = [];
    for (let i = 0; i < visibleCols.length; i++) {
      const c = visibleCols[i];
      if (canMergeG1H1 && c === 7) continue;

      const colSpan = canMergeG1H1 && c === 6 ? 2 : 1;
      const widthPx =
        colSpan === 2
          ? (spec.widths[6] || 92) + (spec.widths[7] || 92)
          : spec.widths[c] || 100;

      const dispVal = rowVals[c] ?? "";
      const rawVal = rowRaws[c] !== undefined ? rowRaws[c] : dispVal;
      const pres = getCellPresentation({
        tabName: activeTab,
        r,
        c,
        rawValue: rawVal,
        displayValue: dispVal,
        grid: gridData.valuesGrid,
        bhCounts,
      });

      const isSelected = selR === r && selC === c;
      const isCellUpdating = updatingCellKey === `${r}:${c}`;
      const isHiddenCol = spec.hiddenCols.has(c);

      const formatted = formatCellForComparisonSheet(rawVal, dispVal, pres.nf);
      const cellNote = gridData.notesGrid?.[`${r}:${c}`] || "";
      const cellTooltip = `${colIndexToLetter(c)}${r + 1}: ${formatted}${cellNote ? `\nNote: ${cellNote}` : ""
        }`;

      const TdTag = isHeaderRow ? "th" : "td";
      const cellStyle = {
        backgroundColor: pres.bg || "#ffffff",
        color: pres.fg || "#000000",
        fontFamily: "Arial, sans-serif",
        fontSize: `${pres.fontSize || 10}pt`,
        fontWeight: pres.bold ? 700 : 400,
        fontStyle: pres.italic ? "italic" : "normal",
        textAlign: pres.align || "left",
        width: `${widthPx}px`,
        minWidth: `${widthPx}px`,
        maxWidth: `${widthPx}px`,
        minHeight: `${baseHeight}px`,
        height: r === 4 ? "auto" : `${baseHeight}px`,
        lineHeight: r === 1 ? "1.15" : "1.2",
        padding: "1px 4px",
        borderRight: isHiddenCol ? "1px dashed #94a3b8" : "1px solid #e2e3e3",
        borderBottom: "1px solid #e2e3e3",
        verticalAlign: r <= 4 ? "middle" : "bottom",
        whiteSpace: pres.wrap ? "normal" : "nowrap",
        overflow: pres.wrap ? "visible" : "hidden",
        textOverflow: pres.wrap ? "clip" : "ellipsis",
        outline: isSelected ? "2px solid #1a73e8" : "none",
        outlineOffset: isSelected ? "-2px" : "0px",
        cursor: "cell",
        boxSizing: "border-box",
      };

      const renderInner = () => {
        if (isCellUpdating) {
          return (
            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              <Spinner size={12} color={pres.fg === "#ffffff" ? "#ffffff" : "#2563eb"} style={{ marginRight: 0 }} />
            </span>
          );
        }

        if (pres.checkbox) {
          const checked =
            rawVal === true || String(dispVal).trim().toUpperCase() === "TRUE";
          return (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
                height: "100%",
                cursor: "pointer",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={Boolean(updatingCellKey)}
                onChange={(e) => handleUpdateCell(r, c, e.target.checked ? "TRUE" : "FALSE")}
                style={{ width: "14px", height: "14px", accentColor: "#2563eb", cursor: "pointer" }}
              />
            </label>
          );
        }

        if (Array.isArray(pres.dv) && pres.dv.length > 0) {
          const currentStr = String(dispVal ?? "").trim();
          const options =
            pres.dv.includes(currentStr) || currentStr === ""
              ? pres.dv
              : [currentStr, ...pres.dv];
          return (
            <select
              value={currentStr}
              disabled={Boolean(updatingCellKey)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => handleUpdateCell(r, c, e.target.value)}
              style={{
                width: "100%",
                height: "100%",
                background: "transparent",
                color: "inherit",
                fontFamily: "inherit",
                fontSize: "inherit",
                fontWeight: "inherit",
                fontStyle: "inherit",
                textAlign: pres.align || "left",
                border: "none",
                outline: "none",
                cursor: "pointer",
              }}
            >
              {currentStr === "" && <option value=""></option>}
              {options.map((opt) => (
                <option key={opt} value={opt} style={{ color: "#000000", backgroundColor: "#ffffff" }}>
                  {opt}
                </option>
              ))}
            </select>
          );
        }

        return formatted;
      };

      cells.push(
        <TdTag
          key={c}
          colSpan={colSpan}
          title={cellTooltip}
          style={cellStyle}
          onClick={() => setSelectedCell({ r, c })}
          onDoubleClick={() => {
            setSelectedCell({ r, c });
            setEditingTextCell(true);
          }}
        >
          {renderInner()}
        </TdTag>
      );
    }

    return (
      <tr key={r}>
        <th
          style={{
            position: "sticky",
            left: 0,
            zIndex: isHeaderRow ? 25 : 10,
            userSelect: "none",
            textAlign: "center",
            width: "44px",
            minWidth: "44px",
            maxWidth: "44px",
            backgroundColor: selR === r ? "#e8f0fe" : "#f8f9fa",
            color: selR === r ? "#1967d2" : "#5f6368",
            fontWeight: selR === r ? 700 : 400,
            fontSize: "10px",
            borderRight: "1px solid #c7ccd1",
            borderBottom: "1px solid #d0d7de",
            padding: "1px 4px",
            boxSizing: "border-box",
          }}
        >
          {r + 1}
        </th>
        {cells}
      </tr>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(15, 23, 42, 0.68)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "12px",
        boxSizing: "border-box",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "98vw",
          height: "94vh",
          background: "#ffffff",
          borderRadius: "12px",
          border: "1px solid #cbd5e1",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.35)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        {/* Top Header */}
        <div
          style={{
            padding: "10px 16px",
            background: "#0f172a",
            color: "#ffffff",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            borderBottom: "1px solid #334155",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
            <span
              style={{
                display: "inline-block",
                width: "8px",
                height: "24px",
                borderRadius: "3px",
                backgroundColor: spec.tabColor || "#0000ff",
                flexShrink: 0,
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, letterSpacing: "-0.01em" }}>
                  {spec.title}
                </h2>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "4px",
                    background: "rgba(37, 99, 235, 0.3)",
                    border: "1px solid rgba(96, 165, 250, 0.45)",
                    color: "#dbeafe",
                    fontSize: "11px",
                    fontWeight: 600,
                  }}
                >
                  {clientName}
                </span>
                {discrepancyRowCount > 0 ? (
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: "4px",
                      background: "rgba(245, 158, 11, 0.2)",
                      border: "1px solid rgba(251, 191, 36, 0.45)",
                      color: "#fde68a",
                      fontSize: "11px",
                      fontWeight: 600,
                    }}
                  >
                    {discrepancyRowCount} discrepancy {discrepancyRowCount === 1 ? "row" : "rows"}
                  </span>
                ) : !loading ? (
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: "4px",
                      background: "rgba(16, 185, 129, 0.2)",
                      border: "1px solid rgba(52, 211, 153, 0.45)",
                      color: "#a7f3d0",
                      fontSize: "11px",
                      fontWeight: 600,
                    }}
                  >
                    0 discrepancies
                  </span>
                ) : null}
              </div>
              <p style={{ margin: "2px 0 0", fontSize: "11px", color: "#cbd5e1" }}>
                Formatted master comparison view with template conditional highlighting and interactive controls
                {gridData.updatedAt ? ` · Last updated ${new Date(gridData.updatedAt).toLocaleString("en-GB")}` : ""}
              </p>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", flexShrink: 0 }}>
            <button
              type="button"
              onClick={handleRecompute}
              disabled={recomputing || loading}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "6px 12px",
                borderRadius: "6px",
                border: "none",
                background: recomputing || loading ? "#b45309" : "#d97706",
                opacity: recomputing || loading ? 0.75 : 1,
                color: "#ffffff",
                fontSize: "12px",
                fontWeight: 600,
                cursor: recomputing || loading ? "wait" : "pointer",
              }}
            >
              {recomputing && <Spinner size={12} color="#ffffff" />}
              <span>{recomputing ? "Recomputing..." : "Recompute comparisons"}</span>
            </button>
            <button
              type="button"
              onClick={() => loadTab(activeTab, { forceNetwork: true })}
              disabled={loading || recomputing}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "6px 10px",
                borderRadius: "6px",
                border: "1px solid #475569",
                background: "#1e293b",
                color: "#ffffff",
                fontSize: "12px",
                fontWeight: 500,
                cursor: loading || recomputing ? "wait" : "pointer",
              }}
            >
              {loading && <Spinner size={12} color="#ffffff" />}
              <span>{loading ? "Refreshing..." : "Refresh"}</span>
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={loading || gridData.valuesGrid.length === 0}
              style={{
                padding: "6px 10px",
                borderRadius: "6px",
                border: "1px solid #475569",
                background: "#1e293b",
                color: loading || gridData.valuesGrid.length === 0 ? "#64748b" : "#ffffff",
                fontSize: "12px",
                fontWeight: 500,
                cursor: loading || gridData.valuesGrid.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "6px 12px",
                borderRadius: "6px",
                border: "none",
                background: "#334155",
                color: "#ffffff",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </div>

        {/* Section Jump Bookmarks & Filters */}
        <div
          style={{
            padding: "8px 14px",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "11px", fontWeight: 600, color: "#64748b", marginRight: "4px" }}>
              Jump to section:
            </span>
            {spec.bookmarks.map((bm) => (
              <button
                key={bm.label}
                type="button"
                onClick={() => jumpToColumn(bm.col)}
                style={{
                  padding: "3px 8px",
                  borderRadius: "5px",
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  fontSize: "11px",
                  fontWeight: 500,
                  color: "#334155",
                  cursor: "pointer",
                }}
              >
                {bm.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search rows..."
              style={{
                width: "180px",
                padding: "4px 9px",
                borderRadius: "5px",
                border: "1px solid #cbd5e1",
                background: "#ffffff",
                fontSize: "12px",
                color: "#1e293b",
                outline: "none",
              }}
            />
            <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#334155", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={discrepanciesOnly}
                onChange={(e) => setDiscrepanciesOnly(e.target.checked)}
                style={{ accentColor: "#d97706", cursor: "pointer" }}
              />
              <span>Discrepancies only</span>
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#334155", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={showHiddenCols}
                onChange={(e) => setShowHiddenCols(e.target.checked)}
                style={{ accentColor: "#2563eb", cursor: "pointer" }}
              />
              <span>Show hidden columns ({spec.hiddenCols.size})</span>
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#334155", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={showTrailingCols}
                onChange={(e) => setShowTrailingCols(e.target.checked)}
                style={{ accentColor: "#2563eb", cursor: "pointer" }}
              />
              <span>Show trailing columns</span>
            </label>
          </div>
        </div>

        {/* Formula Bar */}
        <div
          style={{
            padding: "6px 14px",
            background: "#ffffff",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexShrink: 0,
            fontSize: "12px",
          }}
        >
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "4px",
              background: "#f1f5f9",
              border: "1px solid #cbd5e1",
              fontFamily: "monospace",
              fontWeight: 700,
              color: "#1e293b",
              minWidth: "54px",
              textAlign: "center",
            }}
          >
            {selCoord}
          </span>
          <span style={{ color: "#94a3b8", fontFamily: "serif", fontStyle: "italic", fontWeight: 700, padding: "0 4px" }}>
            fx
          </span>
          {editingTextCell ? (
            <form
              style={{ flex: 1, display: "flex", alignItems: "center", gap: "8px" }}
              onSubmit={(e) => {
                e.preventDefault();
                handleUpdateCell(selR, selC, formulaBarDraft);
              }}
            >
              <input
                type="text"
                autoFocus
                value={formulaBarDraft}
                onChange={(e) => setFormulaBarDraft(e.target.value)}
                style={{
                  flex: 1,
                  padding: "3px 8px",
                  borderRadius: "4px",
                  border: "1px solid #60a5fa",
                  fontFamily: "monospace",
                  fontSize: "12px",
                  color: "#0f172a",
                  outline: "none",
                }}
              />
              <button
                type="submit"
                disabled={Boolean(updatingCellKey)}
                style={{
                  padding: "3px 10px",
                  borderRadius: "4px",
                  border: "none",
                  background: "#2563eb",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Save cell
              </button>
              <button
                type="button"
                onClick={() => setEditingTextCell(false)}
                style={{
                  padding: "3px 8px",
                  borderRadius: "4px",
                  border: "1px solid #cbd5e1",
                  background: "#f1f5f9",
                  color: "#334155",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <div
              onClick={() => setEditingTextCell(true)}
              style={{
                flex: 1,
                padding: "3px 8px",
                borderRadius: "4px",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                fontFamily: "monospace",
                fontSize: "12px",
                color: "#334155",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                cursor: "text",
              }}
              title="Click or double-click any cell to inspect or edit"
            >
              {selNote ? `${selNote}  ->  ${selDisp}` : String(selDisp ?? "")}
              {selRaw !== undefined && String(selRaw) !== String(selDisp)
                ? `  (raw: ${selRaw})`
                : ""}
            </div>
          )}

          {feedback && (
            <span
              style={{
                padding: "3px 8px",
                borderRadius: "4px",
                fontSize: "11px",
                fontWeight: 600,
                background:
                  feedback.type === "success"
                    ? "#ecfdf5"
                    : feedback.type === "info"
                      ? "#eff6ff"
                      : "#fef2f2",
                color:
                  feedback.type === "success"
                    ? "#047857"
                    : feedback.type === "info"
                      ? "#1d4ed8"
                      : "#b91c1c",
                border: `1px solid ${feedback.type === "success"
                    ? "#a7f3d0"
                    : feedback.type === "info"
                      ? "#bfdbfe"
                      : "#fecaca"
                  }`,
                flexShrink: 0,
              }}
            >
              {feedback.message}
            </span>
          )}
          {error && (
            <span
              style={{
                padding: "3px 8px",
                borderRadius: "4px",
                fontSize: "11px",
                fontWeight: 600,
                background: "#fef2f2",
                color: "#b91c1c",
                border: "1px solid #fecaca",
                flexShrink: 0,
              }}
            >
              {error}
            </span>
          )}
        </div>

        {/* Sheet Grid Viewport */}
        <div
          ref={scrollViewportRef}
          style={{
            flex: 1,
            overflow: "auto",
            position: "relative",
            background: "#f8f9fa",
          }}
        >
          {loading && gridData.valuesGrid.length === 0 ? (
            <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 600, color: "#334155" }}>
                <Spinner size={16} color="#2563eb" />
                <span>Loading formatted {activeTab} workbook view for {clientName}...</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ height: "30px", background: "#dbeafe", borderRadius: "5px", border: "1px solid #bfdbfe" }} />
                <div style={{ height: "40px", background: "#ede9fe", borderRadius: "5px", border: "1px solid #ddd6fe" }} />
                <div style={{ height: "34px", background: "#d1fae5", borderRadius: "5px", border: "1px solid #a7f3d0" }} />
                {Array.from({ length: 10 }).map((_, idx) => (
                  <div key={idx} style={{ height: "22px", background: "#e2e8f0", borderRadius: "4px" }} />
                ))}
              </div>
            </div>
          ) : (
            <div style={{ display: "inline-block", minWidth: "100%", verticalAlign: "top" }}>
              <table
                style={{
                  borderCollapse: "collapse",
                  tableLayout: "fixed",
                  background: "#ffffff",
                  fontFamily: "Arial, sans-serif",
                }}
              >
                <thead style={{ position: "sticky", top: 0, zIndex: 20 }}>
                  {/* Column Letters Header Row */}
                  <tr>
                    <th
                      style={{
                        position: "sticky",
                        left: 0,
                        zIndex: 30,
                        userSelect: "none",
                        width: "44px",
                        minWidth: "44px",
                        maxWidth: "44px",
                        height: "22px",
                        backgroundColor: "#f1f3f4",
                        borderRight: "1px solid #c7ccd1",
                        borderBottom: "1px solid #c7ccd1",
                      }}
                    />
                    {visibleCols.map((c) => {
                      const widthPx = spec.widths[c] || 100;
                      const isSelCol = selC === c;
                      const isHiddenCol = spec.hiddenCols.has(c);
                      return (
                        <th
                          key={c}
                          onClick={() => setSelectedCell((prev) => ({ ...prev, c }))}
                          style={{
                            userSelect: "none",
                            textAlign: "center",
                            cursor: "pointer",
                            width: `${widthPx}px`,
                            minWidth: `${widthPx}px`,
                            maxWidth: `${widthPx}px`,
                            height: "22px",
                            backgroundColor: isSelCol ? "#e8f0fe" : isHiddenCol ? "#e2e8f0" : "#f8f9fa",
                            color: isSelCol ? "#1967d2" : "#5f6368",
                            fontWeight: isSelCol ? 700 : 500,
                            fontSize: "11px",
                            borderRight: isHiddenCol ? "1px dashed #94a3b8" : "1px solid #d0d7de",
                            borderBottom: "1px solid #c7ccd1",
                            boxShadow: "0 1px 0 #c7ccd1",
                            boxSizing: "border-box",
                          }}
                          title={
                            isHiddenCol
                              ? `Column ${colIndexToLetter(c)} (hidden by default in template)`
                              : `Column ${colIndexToLetter(c)} (${widthPx}px)`
                          }
                        >
                          {colIndexToLetter(c)}
                          {isHiddenCol ? "*" : ""}
                        </th>
                      );
                    })}
                  </tr>
                  {/* Frozen Template Rows 1-5 */}
                  {[0, 1, 2, 3, 4].map((r) => renderRow(r, true))}
                </thead>
                <tbody>
                  {displayedDataRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={visibleCols.length + 1}
                        style={{
                          padding: "28px 24px",
                          textAlign: "center",
                          fontSize: "13px",
                          color: "#64748b",
                          background: "#ffffff",
                        }}
                      >
                        {discrepanciesOnly
                          ? `No discrepancy rows found in ${activeTab}.`
                          : searchQuery.trim()
                            ? `No rows matching "${searchQuery}".`
                            : `No data rows available in ${activeTab}.`}
                      </td>
                    </tr>
                  ) : (
                    displayedDataRows.map((r) => renderRow(r, false))
                  )}
                </tbody>
              </table>

              {filteredDataRows.length > displayedDataRows.length && (
                <div
                  style={{
                    padding: "10px 16px",
                    background: "#f1f5f9",
                    borderTop: "1px solid #cbd5e1",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    fontSize: "12px",
                    color: "#334155",
                  }}
                >
                  <span>
                    Showing {displayedDataRows.length} of {filteredDataRows.length} matching rows
                    {filteredDataRows.length !== totalActiveDataRows
                      ? ` (${totalActiveDataRows} total data rows loaded)`
                      : ""}.
                  </span>
                  <button
                    type="button"
                    onClick={() => setRowRenderLimit((n) => n + 250)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: "5px",
                      background: "#ffffff",
                      border: "1px solid #cbd5e1",
                      fontSize: "12px",
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                  >
                    Show next 250 rows
                  </button>
                  <button
                    type="button"
                    onClick={() => setRowRenderLimit(filteredDataRows.length)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: "5px",
                      background: "#2563eb",
                      border: "none",
                      color: "#ffffff",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Show all rows
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Google Sheets Style Bottom Tab Bar */}
        <div
          style={{
            padding: "6px 16px",
            background: "#f1f3f4",
            borderTop: "1px solid #cbd5e1",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {COMPARISON_TABS.map((tab) => {
              const isActive = tab === activeTab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setSelectedCell({ r: 0, c: 0 });
                    setRowRenderLimit(120);
                    setActiveTab(tab);
                  }}
                  style={{
                    padding: "6px 14px",
                    fontSize: "12px",
                    fontWeight: 600,
                    borderRadius: "6px 6px 0 0",
                    border: isActive ? "1px solid #cbd5e1" : "1px solid transparent",
                    borderBottom: isActive ? "2px solid #ffffff" : "1px solid transparent",
                    background: isActive ? "#ffffff" : "#e2e8f0",
                    color: isActive ? "#1d4ed8" : "#334155",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <span>{tab}</span>
                  <span
                    style={{
                      display: "inline-block",
                      width: "10px",
                      height: "4px",
                      borderRadius: "999px",
                      backgroundColor: COMPARISON_SHEET_SPECS[tab].tabColor || "#0000ff",
                    }}
                  />
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: "11px", color: "#475569", display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <span>
              Showing {visibleCols.length} visible columns ({filteredDataRows.length} data rows)
            </span>
            {loading && gridData.valuesGrid.length > 0 && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "#1d4ed8", fontWeight: 600 }}>
                <Spinner size={11} color="#1d4ed8" /> Updating view...
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
