import React, { useState, useEffect, useMemo, useCallback } from "react";
import Spinner from "./Spinner";

const TEXT_COLOR_SWATCHES = [
  { hex: "#ffffff", label: "White" },
  { hex: "#000000", label: "Black" },
  { hex: "#0047ab", label: "Pulse blue" },
  { hex: "#0563c1", label: "Link blue" },
  { hex: "#f3f3f3", label: "Hidden grey" },
  { hex: "#6aa84f", label: "Positive green" },
  { hex: "#ff0000", label: "Negative red" },
];

const FILL_COLOR_SWATCHES = [
  { hex: "#ffffff", label: "White" },
  { hex: "#f3f3f3", label: "Light grey" },
  { hex: "#0000ff", label: "Header blue" },
  { hex: "#9900ff", label: "Revenue purple" },
  { hex: "#ff9900", label: "Gross profit orange" },
  { hex: "#45818e", label: "Overheads teal" },
  { hex: "#0047ab", label: "Operating profit blue" },
  { hex: "#351c75", label: "Targets purple" },
  { hex: "#274e13", label: "Utilisation green" },
  { hex: "#d9ead3", label: "Variance green" },
  { hex: "#f4c7c3", label: "Variance red" },
  { hex: "#fce5cd", label: "Amber" },
];

function idxToColLetters(idx0) {
  let n = idx0 + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export default function ReportStyleEditorModal({
  isOpen,
  onClose,
  automationCommanderSheetId = "",
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null); // { type: 'success' | 'info' | 'error', text }

  const [blocks, setBlocks] = useState([]);
  const [originalBlocksJson, setOriginalBlocksJson] = useState("");
  const [conditionalFormats, setConditionalFormats] = useState([]);
  const [chartRefs, setChartRefs] = useState([]);
  const [sampleValuesByRange, setSampleValuesByRange] = useState({});
  const [isCustomised, setIsCustomised] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  const [activeRange, setActiveRange] = useState("");
  const [selectedCells, setSelectedCells] = useState(() => new Set(["0:0"]));
  const [anchorCell, setAnchorCell] = useState({ r: 0, c: 0 });
  const [copiedStyle, setCopiedStyle] = useState(null);
  const [showCoordinates, setShowCoordinates] = useState(false);

  const loadStyles = useCallback(async () => {
    setLoading(true);
    setError("");
    setNotice(null);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_get_template_styles",
          automationCommanderSheetId,
        }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to load template formatting");

      const loadedBlocks = data.styles?.blocks || [];
      setBlocks(loadedBlocks);
      setOriginalBlocksJson(JSON.stringify(loadedBlocks));
      setConditionalFormats(data.styles?.conditionalFormats || []);
      setChartRefs(data.chartRefs || []);
      setSampleValuesByRange(data.sampleValuesByRange || {});
      setIsCustomised(Boolean(data.isCustomised));
      setUpdatedAt(data.updatedAt || null);
      if (loadedBlocks.length > 0) {
        setActiveRange((prev) =>
          loadedBlocks.some((b) => b.range === prev) ? prev : loadedBlocks[0].range
        );
      }
      setSelectedCells(new Set(["0:0"]));
      setAnchorCell({ r: 0, c: 0 });
    } catch (err) {
      setError(err.message || "Failed to load snapshot formatting");
    } finally {
      setLoading(false);
    }
  }, [automationCommanderSheetId]);

  useEffect(() => {
    if (isOpen) {
      loadStyles();
    }
  }, [isOpen, loadStyles]);

  const refByRange = useMemo(() => {
    const map = new Map();
    for (const ref of chartRefs) {
      const clean = String(ref.range || "").replace(/^.*!/, "").trim();
      if (!clean) continue;
      if (!map.has(clean)) map.set(clean, []);
      map.get(clean).push(ref);
    }
    return map;
  }, [chartRefs]);

  const activeBlockIndex = useMemo(
    () => blocks.findIndex((b) => b.range === activeRange),
    [blocks, activeRange]
  );
  const activeBlock = activeBlockIndex >= 0 ? blocks[activeBlockIndex] : null;
  const activeSampleRows = activeBlock ? sampleValuesByRange[activeBlock.range] || [] : [];

  const originalBlocksParsed = useMemo(() => {
    try {
      return originalBlocksJson ? JSON.parse(originalBlocksJson) : [];
    } catch (_) {
      return [];
    }
  }, [originalBlocksJson]);

  const dirtyRanges = useMemo(() => {
    const set = new Set();
    blocks.forEach((b, idx) => {
      if (JSON.stringify(b) !== JSON.stringify(originalBlocksParsed[idx])) {
        set.add(b.range);
      }
    });
    return set;
  }, [blocks, originalBlocksParsed]);

  const hasUnsavedChanges = dirtyRanges.size > 0;

  // Determine which cells in the active block are covered by conditional formatting
  const cfCoordsSet = useMemo(() => {
    const s = new Set();
    if (!activeBlock) return s;
    const rCount = activeBlock.rows?.length || 0;
    const cCount = activeBlock.rows?.[0]?.length || 0;
    for (const cf of conditionalFormats) {
      for (const rg of cf.ranges || []) {
        const rLo = Math.max(0, (rg.startRowIndex ?? 0) - activeBlock.startRow);
        const rHi = Math.min(rCount, (rg.endRowIndex ?? 0) - activeBlock.startRow);
        const cLo = Math.max(0, (rg.startColumnIndex ?? 0) - activeBlock.startCol);
        const cHi = Math.min(cCount, (rg.endColumnIndex ?? 0) - activeBlock.startCol);
        for (let r = rLo; r < rHi; r++) {
          for (let c = cLo; c < cHi; c++) {
            s.add(`${r}:${c}`);
          }
        }
      }
    }
    return s;
  }, [activeBlock, conditionalFormats]);

  const primaryCoords = useMemo(() => {
    const first = [...selectedCells][0];
    if (!first) return { r: 0, c: 0 };
    const [r, c] = first.split(":").map(Number);
    return { r: r || 0, c: c || 0 };
  }, [selectedCells]);

  const primaryCellStyle = activeBlock?.rows?.[primaryCoords.r]?.[primaryCoords.c] || {
    bg: "#ffffff",
    fg: "#000000",
    bold: false,
    italic: false,
    underline: false,
    fontSize: 10,
    fontFamily: "Arial",
    align: "",
    valign: "MIDDLE",
  };

  const handleSelectBlock = (range) => {
    setActiveRange(range);
    setSelectedCells(new Set(["0:0"]));
    setAnchorCell({ r: 0, c: 0 });
  };

  const handleCellClick = (r, c, e) => {
    if (e.shiftKey) {
      const rMin = Math.min(anchorCell.r, r);
      const rMax = Math.max(anchorCell.r, r);
      const cMin = Math.min(anchorCell.c, c);
      const cMax = Math.max(anchorCell.c, c);
      const next = new Set(e.ctrlKey || e.metaKey ? selectedCells : []);
      for (let rr = rMin; rr <= rMax; rr++) {
        for (let cc = cMin; cc <= cMax; cc++) {
          next.add(`${rr}:${cc}`);
        }
      }
      setSelectedCells(next);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedCells);
      const key = `${r}:${c}`;
      if (next.has(key) && next.size > 1) next.delete(key);
      else next.add(key);
      setSelectedCells(next);
      setAnchorCell({ r, c });
    } else {
      setSelectedCells(new Set([`${r}:${c}`]));
      setAnchorCell({ r, c });
    }
  };

  const handleSelectRow = (r, e) => {
    if (!activeBlock) return;
    const colsCount = activeBlock.rows?.[r]?.length || 0;
    const next = new Set(e.shiftKey || e.ctrlKey || e.metaKey ? selectedCells : []);
    const rStart = e.shiftKey ? Math.min(anchorCell.r, r) : r;
    const rEnd = e.shiftKey ? Math.max(anchorCell.r, r) : r;
    for (let rr = rStart; rr <= rEnd; rr++) {
      for (let cc = 0; cc < colsCount; cc++) {
        next.add(`${rr}:${cc}`);
      }
    }
    setSelectedCells(next);
    if (!e.shiftKey) setAnchorCell({ r, c: 0 });
  };

  const handleSelectCol = (c, e) => {
    if (!activeBlock) return;
    const rowsCount = activeBlock.rows?.length || 0;
    const next = new Set(e.shiftKey || e.ctrlKey || e.metaKey ? selectedCells : []);
    const cStart = e.shiftKey ? Math.min(anchorCell.c, c) : c;
    const cEnd = e.shiftKey ? Math.max(anchorCell.c, c) : c;
    for (let rr = 0; rr < rowsCount; rr++) {
      for (let cc = cStart; cc <= cEnd; cc++) {
        next.add(`${rr}:${cc}`);
      }
    }
    setSelectedCells(next);
    if (!e.shiftKey) setAnchorCell({ r: 0, c });
  };

  const handleSelectAll = () => {
    if (!activeBlock) return;
    const next = new Set();
    (activeBlock.rows || []).forEach((rowArr, r) => {
      (rowArr || []).forEach((_, c) => next.add(`${r}:${c}`));
    });
    setSelectedCells(next);
    setAnchorCell({ r: 0, c: 0 });
  };

  const updateSelectedStyle = (patchOrFn) => {
    if (activeBlockIndex < 0 || selectedCells.size === 0) return;
    setNotice(null);
    setBlocks((prev) =>
      prev.map((blk, idx) => {
        if (idx !== activeBlockIndex) return blk;
        const nextRows = (blk.rows || []).map((rowArr, r) =>
          (rowArr || []).map((cellStyle, c) => {
            if (!selectedCells.has(`${r}:${c}`)) return cellStyle;
            const patch = typeof patchOrFn === "function" ? patchOrFn(cellStyle) : patchOrFn;
            return { ...cellStyle, ...patch };
          })
        );
        return { ...blk, rows: nextRows };
      })
    );
  };

  const handleDiscardCurrentBlock = () => {
    if (activeBlockIndex < 0) return;
    const orig = originalBlocksParsed[activeBlockIndex];
    if (!orig) return;
    setBlocks((prev) => prev.map((b, idx) => (idx === activeBlockIndex ? orig : b)));
    setNotice({ type: "info", text: `Discarded unsaved edits in ${activeBlock.range}.` });
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setNotice(null);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_save_template_styles",
          automationCommanderSheetId,
          blocks,
        }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to save snapshot formatting");
      setOriginalBlocksJson(JSON.stringify(data.styles?.blocks || blocks));
      setIsCustomised(true);
      setUpdatedAt(data.updatedAt || new Date().toISOString());
      setNotice({
        type: "success",
        text: "Snapshot formatting saved to Supabase. Re-run Update report(s) or Preview report to apply changes.",
      });
    } catch (err) {
      setError(err.message || "Failed to save formatting");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!window.confirm("Reset all report table formatting back to the bundled default template?")) {
      return;
    }
    setResetting(true);
    setError("");
    setNotice(null);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_reset_template_styles",
          automationCommanderSheetId,
        }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to reset formatting");
      const nextBlocks = data.styles?.blocks || [];
      setBlocks(nextBlocks);
      setOriginalBlocksJson(JSON.stringify(nextBlocks));
      setConditionalFormats(data.styles?.conditionalFormats || []);
      setIsCustomised(false);
      setUpdatedAt(null);
      setNotice({ type: "info", text: "Formatting reset to bundled defaults." });
    } catch (err) {
      setError(err.message || "Failed to reset formatting");
    } finally {
      setResetting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      onClick={() => {
        if (!hasUnsavedChanges || window.confirm("Discard unsaved formatting changes?")) {
          onClose();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.65)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#ffffff",
          borderRadius: "10px",
          width: "100%",
          maxWidth: "1440px",
          height: "92vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 25px 50px -12px rgba(0,0,0,0.35)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 20px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            background: "#ffffff",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#0f172a" }}>
                Snapshot table formatting editor
              </h2>
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "999px",
                  fontSize: "11px",
                  fontWeight: 600,
                  background: isCustomised ? "#eff6ff" : "#f1f5f9",
                  color: isCustomised ? "#1d4ed8" : "#475569",
                  border: `1px solid ${isCustomised ? "#bfdbfe" : "#cbd5e1"}`,
                }}
              >
                {isCustomised ? "Customised in Supabase" : "Using bundled defaults"}
              </span>
            </div>
            <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748b" }}>
              Select a cell, row header, column header, or Shift+click a range to adjust colours, bold, italic, and alignment.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!hasUnsavedChanges || window.confirm("Discard unsaved formatting changes?")) {
                onClose();
              }
            }}
            style={{
              background: "none",
              border: "none",
              fontSize: "18px",
              color: "#64748b",
              cursor: "pointer",
              padding: "4px 8px",
            }}
            aria-label="Close formatting editor"
          >
            ✕
          </button>
        </div>

        {/* Body: Sidebar + Editor */}
        {loading ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#475569" }}>
            <Spinner size="24px" />
            <div style={{ marginTop: "10px", fontSize: "13px", fontWeight: 600 }}>
              Loading snapshot formatting tables...
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
            {/* Left Sidebar: Table blocks */}
            <div
              style={{
                width: "260px",
                flexShrink: 0,
                borderRight: "1px solid #e2e8f0",
                background: "#f8fafc",
                overflowY: "auto",
                padding: "10px",
              }}
            >
              <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", padding: "4px 6px 8px" }}>
                Report table blocks ({blocks.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {blocks.map((blk) => {
                  const refs = refByRange.get(blk.range) || [];
                  const primaryLabel = refs[0]?.label || blk.range;
                  const codesText = refs.map((r) => r.code).join(", ");
                  const isActive = blk.range === activeRange;
                  const isDirty = dirtyRanges.has(blk.range);
                  return (
                    <button
                      key={blk.range}
                      type="button"
                      onClick={() => handleSelectBlock(blk.range)}
                      style={{
                        textAlign: "left",
                        padding: "8px 10px",
                        borderRadius: "6px",
                        border: isActive ? "1px solid #2563eb" : "1px solid transparent",
                        background: isActive ? "#eff6ff" : "transparent",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        gap: "2px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontSize: "12px", fontWeight: 700, color: isActive ? "#1d4ed8" : "#0f172a" }}>
                          {primaryLabel}
                        </span>
                        {isDirty && (
                          <span
                            title="Unsaved changes"
                            style={{ width: "7px", height: "7px", borderRadius: "999px", background: "#f59e0b", flexShrink: 0 }}
                          />
                        )}
                      </div>
                      <div style={{ fontSize: "11px", fontFamily: "monospace", color: "#64748b" }}>
                        {blk.range}
                      </div>
                      {codesText && (
                        <div style={{ fontSize: "10px", color: "#475569", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {codesText}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right Pane: Toolbar + Grid */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
              {/* Formatting Toolbar */}
              <div
                style={{
                  padding: "10px 16px",
                  borderBottom: "1px solid #e2e8f0",
                  background: "#f8fafc",
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                {/* Selection Info */}
                <div style={{ fontSize: "12px", fontWeight: 600, color: "#334155", minWidth: "125px" }}>
                  {selectedCells.size === 1 && activeBlock
                    ? `Cell ${idxToColLetters(activeBlock.startCol + primaryCoords.c)}${activeBlock.startRow + primaryCoords.r + 1}`
                    : `${selectedCells.size} cells selected`}
                </div>

                <div style={{ width: "1px", height: "22px", background: "#cbd5e1" }} />

                {/* Bold / Italic / Underline */}
                <div style={{ display: "inline-flex", gap: "4px" }}>
                  <button
                    type="button"
                    title="Bold"
                    onClick={() => updateSelectedStyle({ bold: !primaryCellStyle.bold })}
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background: primaryCellStyle.bold ? "#1d4ed8" : "#ffffff",
                      color: primaryCellStyle.bold ? "#ffffff" : "#0f172a",
                      fontWeight: 700,
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                  >
                    B
                  </button>
                  <button
                    type="button"
                    title="Italic"
                    onClick={() => updateSelectedStyle({ italic: !primaryCellStyle.italic })}
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background: primaryCellStyle.italic ? "#1d4ed8" : "#ffffff",
                      color: primaryCellStyle.italic ? "#ffffff" : "#0f172a",
                      fontStyle: "italic",
                      fontFamily: "serif",
                      fontWeight: 700,
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                  >
                    I
                  </button>
                  <button
                    type="button"
                    title="Underline"
                    onClick={() => updateSelectedStyle({ underline: !primaryCellStyle.underline })}
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background: primaryCellStyle.underline ? "#1d4ed8" : "#ffffff",
                      color: primaryCellStyle.underline ? "#ffffff" : "#0f172a",
                      textDecoration: "underline",
                      fontWeight: 700,
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                  >
                    U
                  </button>
                </div>

                {/* Alignment */}
                <div style={{ display: "inline-flex", gap: "3px" }}>
                  {[
                    { val: "LEFT", label: "Left" },
                    { val: "CENTER", label: "Center" },
                    { val: "RIGHT", label: "Right" },
                    { val: "", label: "Auto" },
                  ].map((opt) => {
                    const active = String(primaryCellStyle.align || "").toUpperCase() === opt.val;
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => updateSelectedStyle({ align: opt.val })}
                        style={{
                          padding: "4px 8px",
                          height: "28px",
                          borderRadius: "4px",
                          border: "1px solid #cbd5e1",
                          background: active ? "#1d4ed8" : "#ffffff",
                          color: active ? "#ffffff" : "#334155",
                          fontSize: "11px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                {/* Font size */}
                <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                  <span style={{ fontSize: "11px", color: "#475569", fontWeight: 600 }}>Size:</span>
                  <select
                    value={primaryCellStyle.fontSize || 10}
                    onChange={(e) => updateSelectedStyle({ fontSize: Number(e.target.value) })}
                    style={{
                      height: "28px",
                      padding: "0 6px",
                      fontSize: "12px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                    }}
                  >
                    {[6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18].map((sz) => (
                      <option key={sz} value={sz}>
                        {sz}pt
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ width: "1px", height: "22px", background: "#cbd5e1" }} />

                {/* Text colour */}
                <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                  <span style={{ fontSize: "11px", color: "#475569", fontWeight: 600 }}>Text:</span>
                  <input
                    type="color"
                    value={primaryCellStyle.fg || "#000000"}
                    onChange={(e) => updateSelectedStyle({ fg: e.target.value })}
                    title="Pick text colour"
                    style={{ width: "26px", height: "26px", border: "1px solid #cbd5e1", borderRadius: "4px", padding: 0, cursor: "pointer" }}
                  />
                  {TEXT_COLOR_SWATCHES.map((sw) => (
                    <button
                      key={sw.hex}
                      type="button"
                      title={`Text: ${sw.label} (${sw.hex})`}
                      onClick={() => updateSelectedStyle({ fg: sw.hex })}
                      style={{
                        width: "16px",
                        height: "16px",
                        borderRadius: "3px",
                        border: primaryCellStyle.fg === sw.hex ? "2px solid #2563eb" : "1px solid #94a3b8",
                        background: sw.hex,
                        cursor: "pointer",
                        padding: 0,
                      }}
                    />
                  ))}
                </div>

                {/* Fill colour */}
                <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                  <span style={{ fontSize: "11px", color: "#475569", fontWeight: 600 }}>Fill:</span>
                  <input
                    type="color"
                    value={primaryCellStyle.bg || "#ffffff"}
                    onChange={(e) => updateSelectedStyle({ bg: e.target.value })}
                    title="Pick fill colour"
                    style={{ width: "26px", height: "26px", border: "1px solid #cbd5e1", borderRadius: "4px", padding: 0, cursor: "pointer" }}
                  />
                  {FILL_COLOR_SWATCHES.map((sw) => (
                    <button
                      key={sw.hex}
                      type="button"
                      title={`Fill: ${sw.label} (${sw.hex})`}
                      onClick={() => updateSelectedStyle({ bg: sw.hex })}
                      style={{
                        width: "16px",
                        height: "16px",
                        borderRadius: "3px",
                        border: primaryCellStyle.bg === sw.hex ? "2px solid #2563eb" : "1px solid #94a3b8",
                        background: sw.hex,
                        cursor: "pointer",
                        padding: 0,
                      }}
                    />
                  ))}
                </div>

                <div style={{ width: "1px", height: "22px", background: "#cbd5e1" }} />

                {/* Copy / Paste style & Coordinates toggle */}
                <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <button
                    type="button"
                    onClick={() => setCopiedStyle({ ...primaryCellStyle })}
                    style={{
                      padding: "4px 9px",
                      height: "28px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                      color: "#334155",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Copy style
                  </button>
                  <button
                    type="button"
                    disabled={!copiedStyle}
                    onClick={() => copiedStyle && updateSelectedStyle({ ...copiedStyle })}
                    style={{
                      padding: "4px 9px",
                      height: "28px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background: copiedStyle ? "#eff6ff" : "#f1f5f9",
                      color: copiedStyle ? "#1d4ed8" : "#94a3b8",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: copiedStyle ? "pointer" : "not-allowed",
                    }}
                  >
                    Paste style
                  </button>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "#475569", cursor: "pointer", marginLeft: "4px" }}>
                    <input
                      type="checkbox"
                      checked={showCoordinates}
                      onChange={(e) => setShowCoordinates(e.target.checked)}
                    />
                    <span>Show cell refs</span>
                  </label>
                </div>
              </div>

              {/* Alerts */}
              {error && (
                <div style={{ margin: "10px 16px 0", padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", color: "#b91c1c", fontSize: "12px" }}>
                  {error}
                </div>
              )}
              {notice && (
                <div
                  style={{
                    margin: "10px 16px 0",
                    padding: "10px 14px",
                    background: notice.type === "success" ? "#f0fdf4" : "#eff6ff",
                    border: `1px solid ${notice.type === "success" ? "#bbf7d0" : "#bfdbfe"}`,
                    borderRadius: "6px",
                    color: notice.type === "success" ? "#15803d" : "#1d4ed8",
                    fontSize: "12px",
                  }}
                >
                  {notice.text}
                </div>
              )}

              {/* WYSIWYG Grid Canvas */}
              <div style={{ flex: 1, overflow: "auto", padding: "16px", background: "#ffffff" }}>
                {activeBlock && (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", gap: "12px", flexWrap: "wrap" }}>
                      <div style={{ fontSize: "12px", color: "#475569" }}>
                        Click row/column headers to select whole rows or columns. Cells marked <span style={{ color: "#2563eb", fontWeight: 600 }}>CF</span> also have conditional formatting rules that may override colours based on live numbers.
                      </div>
                      {dirtyRanges.has(activeBlock.range) && (
                        <button
                          type="button"
                          onClick={handleDiscardCurrentBlock}
                          style={{
                            padding: "4px 10px",
                            fontSize: "11px",
                            fontWeight: 600,
                            background: "#ffffff",
                            border: "1px solid #cbd5e1",
                            borderRadius: "4px",
                            color: "#475569",
                            cursor: "pointer",
                          }}
                        >
                          Revert this table
                        </button>
                      )}
                    </div>

                    <div style={{ display: "inline-block", border: "1px solid #cbd5e1", borderRadius: "6px", overflow: "hidden" }}>
                      <table style={{ borderCollapse: "collapse", userSelect: "none" }}>
                        <thead>
                          <tr>
                            <th
                              onClick={handleSelectAll}
                              title="Select entire table"
                              style={{
                                background: "#f1f5f9",
                                border: "1px solid #cbd5e1",
                                padding: "4px 8px",
                                fontSize: "10px",
                                color: "#475569",
                                cursor: "pointer",
                              }}
                            >
                              All
                            </th>
                            {(activeBlock.rows?.[0] || []).map((_, c) => (
                              <th
                                key={c}
                                onClick={(e) => handleSelectCol(c, e)}
                                title={`Click to select column ${idxToColLetters(activeBlock.startCol + c)} (Shift+click for range)`}
                                style={{
                                  background: "#f1f5f9",
                                  border: "1px solid #cbd5e1",
                                  padding: "4px 8px",
                                  fontSize: "11px",
                                  fontFamily: "monospace",
                                  fontWeight: 700,
                                  color: "#334155",
                                  cursor: "pointer",
                                  minWidth: "56px",
                                }}
                              >
                                {idxToColLetters(activeBlock.startCol + c)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(activeBlock.rows || []).map((rowArr, r) => {
                            const sheetRow1 = activeBlock.startRow + r + 1;
                            return (
                              <tr key={r}>
                                <th
                                  onClick={(e) => handleSelectRow(r, e)}
                                  title={`Click to select row ${sheetRow1} (Shift+click for range)`}
                                  style={{
                                    background: "#f1f5f9",
                                    border: "1px solid #cbd5e1",
                                    padding: "4px 8px",
                                    fontSize: "11px",
                                    fontFamily: "monospace",
                                    fontWeight: 600,
                                    color: "#475569",
                                    cursor: "pointer",
                                    textAlign: "right",
                                  }}
                                >
                                  {sheetRow1}
                                </th>
                                {(rowArr || []).map((cellStyle, c) => {
                                  const key = `${r}:${c}`;
                                  const isSel = selectedCells.has(key);
                                  const sampleVal = activeSampleRows?.[r]?.[c] ?? "";
                                  const coordLabel = `${idxToColLetters(activeBlock.startCol + c)}${sheetRow1}`;
                                  const displayVal = showCoordinates
                                    ? coordLabel
                                    : sampleVal || "\u00A0";
                                  const hasCf = cfCoordsSet.has(key);
                                  const align =
                                    cellStyle.align === "RIGHT"
                                      ? "right"
                                      : cellStyle.align === "CENTER"
                                      ? "center"
                                      : "left";

                                  return (
                                    <td
                                      key={c}
                                      onClick={(e) => handleCellClick(r, c, e)}
                                      title={`${coordLabel} | Text: ${cellStyle.fg} | Fill: ${cellStyle.bg} | ${cellStyle.fontSize || 10}pt${hasCf ? " | Conditional formatting active" : ""}`}
                                      style={{
                                        position: "relative",
                                        background: cellStyle.bg || "#ffffff",
                                        color: cellStyle.fg || "#000000",
                                        fontWeight: cellStyle.bold ? 700 : 400,
                                        fontStyle: cellStyle.italic ? "italic" : "normal",
                                        textDecoration: cellStyle.underline ? "underline" : "none",
                                        fontSize: `${Math.max(10, Math.min(14, cellStyle.fontSize || 11))}px`,
                                        textAlign: align,
                                        padding: "5px 10px",
                                        border: isSel ? "2px solid #2563eb" : "1px solid #e2e8f0",
                                        boxShadow: isSel ? "inset 0 0 0 1px #ffffff" : "none",
                                        cursor: "pointer",
                                        whiteSpace: "nowrap",
                                        minWidth: "56px",
                                      }}
                                    >
                                      {displayVal}
                                      {hasCf && (
                                        <span
                                          style={{
                                            position: "absolute",
                                            top: "1px",
                                            right: "2px",
                                            fontSize: "8px",
                                            fontWeight: 700,
                                            color: "#2563eb",
                                            opacity: 0.75,
                                            pointerEvents: "none",
                                          }}
                                        >
                                          CF
                                        </span>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "12px", color: "#64748b" }}>
            {hasUnsavedChanges ? (
              <span style={{ color: "#b45309", fontWeight: 600 }}>
                Unsaved changes in {dirtyRanges.size} table block(s).
              </span>
            ) : updatedAt ? (
              <span>Last saved: {new Date(updatedAt).toLocaleString("en-GB")}</span>
            ) : (
              <span>Changes apply to Preview report and Update / Create report(s).</span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              type="button"
              disabled={loading || saving || resetting || !isCustomised}
              onClick={handleReset}
              style={{
                padding: "7px 14px",
                background: "#ffffff",
                color: !isCustomised ? "#94a3b8" : "#b91c1c",
                border: `1px solid ${!isCustomised ? "#e2e8f0" : "#fecaca"}`,
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: loading || saving || resetting || !isCustomised ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {resetting && <Spinner size="12px" color="#b91c1c" />}
              <span>Reset to defaults</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (!hasUnsavedChanges || window.confirm("Discard unsaved formatting changes?")) {
                  onClose();
                }
              }}
              style={{
                padding: "7px 14px",
                background: "#ffffff",
                color: "#334155",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Close
            </button>

            <button
              type="button"
              disabled={loading || saving || resetting || !hasUnsavedChanges}
              onClick={handleSave}
              style={{
                padding: "7px 18px",
                background: hasUnsavedChanges ? "#0066cc" : "#94a3b8",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: loading || saving || resetting || !hasUnsavedChanges ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {saving && <Spinner size="12px" color="#ffffff" />}
              <span>Save formatting</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
