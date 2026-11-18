import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Spinner from "./Spinner";
import DeferredSearchInput from "./DeferredSearchInput";
import { useResizableSheetColumns } from "../hooks/useResizableSheetColumns";
import { colIndexToLetter } from "../utils/masterComparisonSheetSpec";
import {
  VIRTUAL_TAB_CACHE,
  VIRTUAL_CACHE_TTL_MS as CACHE_TTL_MS,
  makeVirtualCacheKey as makeCacheKey,
  invalidateVirtualModalCache,
  fetchVirtualTabPayload,
  prefetchVirtualTab,
} from "../utils/sheetModalCache";
export { invalidateVirtualModalCache, fetchVirtualTabPayload, prefetchVirtualTab };

function normalizeGridPayload(data) {
  return {
    rowCount: data.rowCount || 0,
    colCount: data.colCount || 0,
    valuesGrid: Array.isArray(data.valuesGrid) ? data.valuesGrid : [],
    formulasGrid: Array.isArray(data.formulasGrid) ? data.formulasGrid : [],
    rawValuesGrid: Array.isArray(data.rawValuesGrid) ? data.rawValuesGrid : [],
    notesGrid:
      data.notesGrid && typeof data.notesGrid === "object" && !Array.isArray(data.notesGrid)
        ? data.notesGrid
        : {},
    updatedAt: data.updatedAt || null,
  };
}

export default function FormattedVirtualSheetModal({
  isOpen,
  onClose,
  clientName = "APPTEST",
  sheetRole = "client",
  tabs = [],
  initialTab = "",
  badgeLabel = "Supabase sheet",
  subtitle = "Formatted sheet view with template styling, conditional formatting, formulas, and interactive editing",
  getSpec,
  getCellPresentation,
  formatCell,
  getMaxRows,
  getLastActiveRowIdx,
  getDynamicLists,
  getTabWidthKey,
  formatTabSublabel,
  defaultRowRenderLimit = 370,
  onAfterMutate,
}) {
  const safeInitialTab = useMemo(() => {
    if (initialTab && tabs.includes(initialTab)) return initialTab;
    return tabs[0] || initialTab || "";
  }, [initialTab, tabs]);

  const [activeTab, setActiveTab] = useState(safeInitialTab);
  const [loading, setLoading] = useState(false);
  const [updatingCellKey, setUpdatingCellKey] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [dynamicLists, setDynamicLists] = useState({});

  const [gridData, setGridData] = useState({
    rowCount: 0,
    colCount: 0,
    valuesGrid: [],
    formulasGrid: [],
    rawValuesGrid: [],
    notesGrid: {},
    updatedAt: null,
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [showHiddenCols, setShowHiddenCols] = useState(false);
  const [showHiddenRows, setShowHiddenRows] = useState(false);
  const [showTrailingCols, setShowTrailingCols] = useState(false);
  const [rowRenderLimit, setRowRenderLimit] = useState(defaultRowRenderLimit);
  const [selectedCell, setSelectedCell] = useState({ r: 0, c: 0 });
  const [editingTextCell, setEditingTextCell] = useState(false);
  const [formulaBarDraft, setFormulaBarDraft] = useState("");

  const scrollViewportRef = useRef(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(safeInitialTab);
      setError("");
      setFeedback(null);
      setSelectedCell({ r: 0, c: 0 });
      setEditingTextCell(false);
      setRowRenderLimit(defaultRowRenderLimit);
    }
  }, [isOpen, safeInitialTab, clientName, defaultRowRenderLimit]);

  const spec = useMemo(() => getSpec(activeTab), [getSpec, activeTab]);
  const widthKey = useMemo(
    () => (typeof getTabWidthKey === "function" ? getTabWidthKey(activeTab) : activeTab),
    [getTabWidthKey, activeTab]
  );

  const {
    getColWidth,
    resizingCol,
    startColumnResize,
    autoFitColumn,
    resetTabWidths,
    hasCustomWidths,
  } = useResizableSheetColumns({
    activeTab: widthKey,
    defaultWidths: spec?.widths || [],
  });

  const loadTab = useCallback(
    async (tabToLoad = activeTab, { forceNetwork = false } = {}) => {
      if (!clientName || !tabToLoad) return;
      const reqId = ++reqIdRef.current;
      const targetSpec = getSpec(tabToLoad);
      const cacheKey = makeCacheKey(sheetRole, clientName, tabToLoad);
      const cached = !forceNetwork ? VIRTUAL_TAB_CACHE.get(cacheKey) : null;
      const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;

      const resolveListsForGrid = (valsGrid) => {
        if (typeof getDynamicLists !== "function") return;
        Promise.resolve(getDynamicLists(clientName, tabToLoad, valsGrid)).then((lists) => {
          if (reqId === reqIdRef.current && lists && Object.keys(lists).length > 0) {
            setDynamicLists(lists);
          }
        });
      };

      if (cached && cacheAge < CACHE_TTL_MS) {
        setGridData(cached.payload);
        setLoading(false);
        setError("");
        resolveListsForGrid(cached.payload.valuesGrid);
        return;
      }

      if (!cached) {
        setLoading(true);
      }
      setError("");
      try {
        const payload = await fetchVirtualTabPayload({
          sheetRole,
          clientName,
          tabName: tabToLoad,
          maxRows: getMaxRows ? getMaxRows(tabToLoad) : 1200,
          maxCols: targetSpec?.totalCols || 200,
        });
        if (reqId !== reqIdRef.current) return;
        setGridData(payload);
        resolveListsForGrid(payload.valuesGrid);
      } catch (err) {
        if (reqId !== reqIdRef.current) return;
        setError(err.message || `Error loading ${tabToLoad}.`);
      } finally {
        if (reqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    },
    [clientName, activeTab, sheetRole, getSpec, getMaxRows, getDynamicLists]
  );

  useEffect(() => {
    if (isOpen && activeTab) {
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
          sheetRole,
          tabName: activeTab,
          rowIndex0: r,
          colIndex0: c,
          value: newValue,
          maxRows: getMaxRows ? getMaxRows(activeTab) : 1200,
          maxCols: spec?.totalCols || 200,
          includeFormulas: true,
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
      invalidateVirtualModalCache(sheetRole, clientName);
      if (data.gridData) {
        const normalized = normalizeGridPayload(data.gridData);
        const cacheKey = makeCacheKey(sheetRole, clientName, activeTab);
        VIRTUAL_TAB_CACHE.set(cacheKey, { payload: normalized, cachedAt: Date.now() });
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

  const visibleCols = useMemo(() => {
    if (!spec) return [];
    const maxColIndex = showTrailingCols ? spec.totalCols - 1 : spec.primaryEndCol;
    const list = [];
    for (let c = 0; c <= maxColIndex; c++) {
      if (!showHiddenCols && spec.hiddenCols?.has(c)) continue;
      list.push(c);
    }
    return list;
  }, [spec, showHiddenCols, showTrailingCols]);

  const { colLeftOffsets, lastVisibleFrozenCol, frozenColsWidth } = useMemo(() => {
    const map = new Map();
    let left = 44;
    let lastFrozen = -1;
    let frozenW = 0;
    const frozenCols = spec?.frozenCols || 0;
    for (const c of visibleCols) {
      map.set(c, left);
      const w = getColWidth(c);
      if (c < frozenCols) {
        lastFrozen = c;
        frozenW += w;
      }
      left += w;
    }
    return { colLeftOffsets: map, lastVisibleFrozenCol: lastFrozen, frozenColsWidth: frozenW };
  }, [visibleCols, getColWidth, spec?.frozenCols]);

  const jumpToColumn = (targetCol) => {
    if (!scrollViewportRef.current) return;
    let offset = colLeftOffsets.get(targetCol);
    if (offset === undefined) {
      const nearest = visibleCols.find((c) => c >= targetCol);
      offset = nearest !== undefined ? colLeftOffsets.get(nearest) : 0;
    }
    scrollViewportRef.current.scrollTo({
      left: Math.max(0, (offset || 0) - 44 - frozenColsWidth - 12),
      behavior: "smooth",
    });
  };

  const frozenRowIndices = useMemo(() => {
    const count = spec?.frozenRows || 0;
    const arr = [];
    for (let r = 0; r < count; r++) {
      arr.push(r);
    }
    return arr;
  }, [spec?.frozenRows]);

  const { filteredDataRows, totalActiveDataRows } = useMemo(() => {
    const values = gridData.valuesGrid || [];
    const startR = spec?.frozenRows || 0;
    const lastRow = Math.min(
      values.length - 1,
      getLastActiveRowIdx ? getLastActiveRowIdx(activeTab, values, spec) : values.length - 1
    );
    const q = searchQuery.trim().toLowerCase();
    const rows = [];
    const totalData = Math.max(0, lastRow - startR + 1);

    for (let r = startR; r <= lastRow; r++) {
      if (!showHiddenRows && spec?.hiddenRows?.has(r)) continue;
      if (q) {
        const rowVals = values[r] || [];
        const match = visibleCols.some((c) =>
          String(rowVals[c] ?? "").toLowerCase().includes(q)
        );
        if (!match) continue;
      }
      rows.push(r);
    }
    return {
      filteredDataRows: rows,
      totalActiveDataRows: totalData,
    };
  }, [gridData.valuesGrid, activeTab, spec, getLastActiveRowIdx, searchQuery, visibleCols, showHiddenRows]);

  const displayedDataRows = useMemo(
    () => filteredDataRows.slice(0, rowRenderLimit),
    [filteredDataRows, rowRenderLimit]
  );

  useEffect(() => {
    const { r, c } = selectedCell;
    const form = gridData.formulasGrid?.[r]?.[c];
    const raw = gridData.rawValuesGrid?.[r]?.[c];
    const disp = gridData.valuesGrid?.[r]?.[c] ?? "";
    const pres = getCellPresentation({
      tabName: activeTab,
      r,
      c,
      rawValue: raw !== undefined ? raw : disp,
      displayValue: disp,
      grid: gridData.valuesGrid,
      dynamicLists,
    });
    if (typeof form === "string" && form.startsWith("=")) {
      setFormulaBarDraft(form);
    } else if (pres.nf?.startsWith("DATE:") || pres.nf?.startsWith("PERCENT:")) {
      setFormulaBarDraft(String(disp ?? ""));
    } else {
      setFormulaBarDraft(String(raw !== undefined && raw !== "" ? raw : disp));
    }
    setEditingTextCell(false);
  }, [selectedCell, gridData, activeTab, dynamicLists, getCellPresentation]);

  const handleExportCsv = () => {
    const values = gridData.valuesGrid || [];
    const lastRow = Math.min(
      values.length - 1,
      getLastActiveRowIdx ? getLastActiveRowIdx(activeTab, values, spec) : values.length - 1
    );
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

  if (!isOpen || !spec) return null;

  const selR = selectedCell.r;
  const selC = selectedCell.c;
  const selCoord = `${colIndexToLetter(selC)}${selR + 1}`;
  const selNote = gridData.notesGrid?.[`${selR}:${selC}`] || "";
  const selFormula = gridData.formulasGrid?.[selR]?.[selC];
  const selRaw = gridData.rawValuesGrid?.[selR]?.[selC];
  const selDisp = gridData.valuesGrid?.[selR]?.[selC] ?? "";

  const renderRow = (r, isHeaderRow) => {
    const rowVals = gridData.valuesGrid?.[r] || [];
    const rowRaws = gridData.rawValuesGrid?.[r] || [];
    const rowForms = gridData.formulasGrid?.[r] || [];
    const baseHeight = spec.rowHeights?.[r] ?? 20;
    const isHiddenRow = spec.hiddenRows?.has(r);

    const cells = visibleCols.map((c) => {
      const widthPx = getColWidth(c);
      const dispVal = rowVals[c] ?? "";
      const rawVal = rowRaws[c] !== undefined ? rowRaws[c] : dispVal;
      const formVal = rowForms[c];
      const pres = getCellPresentation({
        tabName: activeTab,
        r,
        c,
        rawValue: rawVal,
        displayValue: dispVal,
        grid: gridData.valuesGrid,
        dynamicLists,
      });

      const isSelected = selR === r && selC === c;
      const isCellUpdating = updatingCellKey === `${r}:${c}`;
      const isHiddenCol = spec.hiddenCols?.has(c);
      const isFrozenCol = c < (spec.frozenCols || 0);
      const isLastFrozen = c === lastVisibleFrozenCol;

      const formatted = formatCell(rawVal, dispVal, pres.nf);
      const cellNote = gridData.notesGrid?.[`${r}:${c}`] || "";
      const formulaPreview =
        typeof formVal === "string" && formVal.startsWith("=") ? `\nFormula: ${formVal}` : "";
      const cellTooltip = `${colIndexToLetter(c)}${r + 1}: ${formatted}${formulaPreview}${
        cellNote ? `\nNote: ${cellNote}` : ""
      }`;

      const TdTag = isHeaderRow ? "th" : "td";
      const borderRight = isLastFrozen
        ? "2px solid #94a3b8"
        : pres.borders?.right
          ? "1px solid #000000"
          : isHiddenCol
            ? "1px dashed #94a3b8"
            : "1px solid #e2e3e3";
      const borderBottom = pres.borders?.bottom
        ? "1px solid #000000"
        : isHiddenRow
          ? "1px dashed #94a3b8"
          : "1px solid #e2e3e3";
      const borderTop = pres.borders?.top ? "1px solid #000000" : "none";
      const borderLeft = pres.borders?.left ? "1px solid #000000" : "none";

      const cellStyle = {
        position: isFrozenCol ? "sticky" : "relative",
        left: isFrozenCol ? `${colLeftOffsets.get(c) || 44}px` : undefined,
        zIndex: isHeaderRow ? (isFrozenCol ? 26 : undefined) : isFrozenCol ? 11 : undefined,
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
        height: isHeaderRow && pres.wrap ? "auto" : `${baseHeight}px`,
        lineHeight: isHeaderRow ? "1.18" : "1.2",
        padding: "1px 4px",
        borderTop,
        borderLeft,
        borderRight,
        borderBottom,
        verticalAlign:
          pres.valign === "middle"
            ? "middle"
            : pres.valign === "top"
              ? "top"
              : isHeaderRow
                ? "middle"
                : "bottom",
        whiteSpace: pres.wrap ? "normal" : "nowrap",
        overflow: pres.wrapStrategy === "OVERFLOW_CELL" ? "visible" : "hidden",
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
          const checked = rawVal === true || String(dispVal).trim().toUpperCase() === "TRUE";
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

      return (
        <TdTag
          key={c}
          title={cellTooltip}
          style={cellStyle}
          onClick={() => setSelectedCell({ r, c })}
          onDoubleClick={() => {
            setSelectedCell({ r, c });
            setEditingTextCell(true);
          }}
        >
          {cellNote && (
            <span
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                width: 0,
                height: 0,
                borderTop: "6px solid #f59e0b",
                borderLeft: "6px solid transparent",
                pointerEvents: "none",
              }}
            />
          )}
          {renderInner()}
        </TdTag>
      );
    });

    return (
      <tr key={r}>
        <th
          style={{
            position: "sticky",
            left: 0,
            zIndex: isHeaderRow ? 28 : 12,
            userSelect: "none",
            textAlign: "center",
            width: "44px",
            minWidth: "44px",
            maxWidth: "44px",
            backgroundColor: selR === r ? "#e8f0fe" : isHiddenRow ? "#e2e8f0" : "#f8f9fa",
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
          {isHiddenRow ? "*" : ""}
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
                backgroundColor: spec.tabColor || "#2563eb",
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
                  {badgeLabel}
                </span>
              </div>
              <p style={{ margin: "2px 0 0", fontSize: "11px", color: "#cbd5e1" }}>
                {subtitle}
                {gridData.updatedAt ? ` · Last updated ${new Date(gridData.updatedAt).toLocaleString("en-GB")}` : ""}
              </p>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => loadTab(activeTab, { forceNetwork: true })}
              disabled={loading}
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
                cursor: loading ? "wait" : "pointer",
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
            {(spec.bookmarks || []).map((bm) => (
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
            <DeferredSearchInput
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search rows..."
              showClearButton
              spinnerSize={11}
              spinnerRight="6px"
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
            {spec.hiddenCols?.size > 0 && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#334155", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showHiddenCols}
                  onChange={(e) => setShowHiddenCols(e.target.checked)}
                  style={{ accentColor: "#2563eb", cursor: "pointer" }}
                />
                <span>Show hidden columns ({spec.hiddenCols.size})</span>
              </label>
            )}
            {spec.hiddenRows?.size > 0 && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#334155", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showHiddenRows}
                  onChange={(e) => setShowHiddenRows(e.target.checked)}
                  style={{ accentColor: "#2563eb", cursor: "pointer" }}
                />
                <span>Show hidden rows ({spec.hiddenRows.size})</span>
              </label>
            )}
            {spec.primaryEndCol < spec.totalCols - 1 && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#334155", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showTrailingCols}
                  onChange={(e) => setShowTrailingCols(e.target.checked)}
                  style={{ accentColor: "#2563eb", cursor: "pointer" }}
                />
                <span>Show trailing columns</span>
              </label>
            )}
            {hasCustomWidths && (
              <button
                type="button"
                onClick={resetTabWidths}
                style={{
                  padding: "3px 8px",
                  borderRadius: "5px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#334155",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
                title="Reset column widths back to template defaults"
              >
                Reset column widths
              </button>
            )}
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
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditingTextCell(false);
                }}
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
              {typeof selFormula === "string" && selFormula.startsWith("=")
                ? `${selFormula}  ->  ${selDisp}`
                : String(selDisp ?? "")}
              {selRaw !== undefined && String(selRaw) !== String(selDisp)
                ? `  (raw: ${selRaw})`
                : ""}
              {selNote ? `  [Note: ${selNote}]` : ""}
            </div>
          )}

          {feedback && (
            <span
              style={{
                padding: "3px 8px",
                borderRadius: "4px",
                fontSize: "11px",
                fontWeight: 600,
                background: feedback.type === "success" ? "#ecfdf5" : "#eff6ff",
                color: feedback.type === "success" ? "#047857" : "#1d4ed8",
                border: `1px solid ${feedback.type === "success" ? "#a7f3d0" : "#bfdbfe"}`,
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
                <span>Loading formatted {activeTab} view for {clientName}...</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ height: "30px", background: "#dbeafe", borderRadius: "5px", border: "1px solid #bfdbfe" }} />
                {Array.from({ length: 12 }).map((_, idx) => (
                  <div key={idx} style={{ height: "22px", background: "#e2e8f0", borderRadius: "4px" }} />
                ))}
              </div>
            </div>
          ) : (
            <div style={{ display: "inline-block", minWidth: "100%", verticalAlign: "top" }}>
              <table
                style={{
                  borderCollapse: "separate",
                  borderSpacing: 0,
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
                      const widthPx = getColWidth(c);
                      const isSelCol = selC === c;
                      const isHiddenCol = spec.hiddenCols?.has(c);
                      const isFrozenCol = c < (spec.frozenCols || 0);
                      const isLastFrozen = c === lastVisibleFrozenCol;
                      const isResizingThis = resizingCol === c;
                      return (
                        <th
                          key={c}
                          onClick={() => setSelectedCell((prev) => ({ ...prev, c }))}
                          style={{
                            position: isFrozenCol ? "sticky" : "relative",
                            left: isFrozenCol ? `${colLeftOffsets.get(c) || 44}px` : undefined,
                            zIndex: isFrozenCol ? 28 : undefined,
                            userSelect: "none",
                            textAlign: "center",
                            cursor: "pointer",
                            width: `${widthPx}px`,
                            minWidth: `${widthPx}px`,
                            maxWidth: `${widthPx}px`,
                            height: "22px",
                            backgroundColor: isResizingThis
                              ? "#dbeafe"
                              : isSelCol
                                ? "#e8f0fe"
                                : isHiddenCol
                                  ? "#e2e8f0"
                                  : "#f8f9fa",
                            color: isSelCol ? "#1967d2" : "#5f6368",
                            fontWeight: isSelCol ? 700 : 500,
                            fontSize: "11px",
                            borderRight: isResizingThis
                              ? "2px solid #2563eb"
                              : isLastFrozen
                                ? "2px solid #94a3b8"
                                : isHiddenCol
                                  ? "1px dashed #94a3b8"
                                  : "1px solid #d0d7de",
                            borderBottom: "1px solid #c7ccd1",
                            boxShadow: "0 1px 0 #c7ccd1",
                            boxSizing: "border-box",
                          }}
                          title={
                            isHiddenCol
                              ? `Column ${colIndexToLetter(c)} (hidden by default in template; drag edge to resize)`
                              : `Column ${colIndexToLetter(c)} (${widthPx}px; drag edge to resize, double-click to auto-fit)`
                          }
                        >
                          {colIndexToLetter(c)}
                          {isHiddenCol ? "*" : ""}
                          <div
                            onMouseDown={(e) => startColumnResize(e, c)}
                            onDoubleClick={(e) =>
                              autoFitColumn(
                                e,
                                c,
                                [...frozenRowIndices, ...displayedDataRows],
                                (rowIdx) => gridData.valuesGrid?.[rowIdx]?.[c] ?? ""
                              )
                            }
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              position: "absolute",
                              top: 0,
                              right: "-3px",
                              bottom: 0,
                              width: "7px",
                              cursor: "col-resize",
                              zIndex: 40,
                            }}
                          />
                        </th>
                      );
                    })}
                  </tr>
                  {/* Frozen Rows */}
                  {frozenRowIndices.map((r) => renderRow(r, true))}
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
                        {searchQuery.trim()
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
            overflowX: "auto",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "nowrap" }}>
            {tabs.map((tab) => {
              const isActive = tab === activeTab;
              const tabSpec = getSpec(tab);
              const sublabel = typeof formatTabSublabel === "function" ? formatTabSublabel(tab) : "";
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setSelectedCell({ r: 0, c: 0 });
                    setRowRenderLimit(defaultRowRenderLimit);
                    setActiveTab(tab);
                  }}
                  title={sublabel ? `${tab} (${sublabel})` : tab}
                  style={{
                    padding: "6px 12px",
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
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  <span>{tab}</span>
                  {sublabel && (
                    <span style={{ fontSize: "10.5px", fontWeight: 500, opacity: 0.72 }}>
                      {sublabel}
                    </span>
                  )}
                  <span
                    style={{
                      display: "inline-block",
                      width: "8px",
                      height: "4px",
                      borderRadius: "999px",
                      backgroundColor: tabSpec?.tabColor || "#2563eb",
                    }}
                  />
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: "11px", color: "#475569", display: "inline-flex", alignItems: "center", gap: "8px", whiteSpace: "nowrap", flexShrink: 0 }}>
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
