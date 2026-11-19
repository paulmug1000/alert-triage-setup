import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
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

function rgbObjToHex(c) {
  if (!c || (c.red === undefined && c.green === undefined && c.blue === undefined)) return null;
  const r = Math.round((c.red ?? 0) * 255);
  const g = Math.round((c.green ?? 0) * 255);
  const b = Math.round((c.blue ?? 0) * 255);
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const DEFAULT_CELL_STYLE = {
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

function normalizeBlockRows(blocks = []) {
  return (blocks || []).map((blk) => {
    const rawRows = Array.isArray(blk?.rows) ? blk.rows : [];
    const maxCols = rawRows.reduce((m, row) => Math.max(m, Array.isArray(row) ? row.length : 0), 0);
    if (maxCols === 0) return blk;
    const hasRagged = rawRows.some((row) => (Array.isArray(row) ? row.length : 0) < maxCols);
    if (!hasRagged) return blk;
    const normalizedRows = rawRows.map((row) => {
      const arr = Array.isArray(row) ? row : [];
      if (arr.length >= maxCols) return arr;
      const padded = [...arr];
      while (padded.length < maxCols) {
        padded.push({ ...DEFAULT_CELL_STYLE });
      }
      return padded;
    });
    return { ...blk, rows: normalizedRows };
  });
}

function describeCfRule(cf) {
  const br = cf?.booleanRule;
  if (!br?.condition) return { conditionText: "Unknown rule", bg: null, fg: null, bold: null };
  const type = br.condition.type || "";
  const vals = (br.condition.values || []).map((v) => v.userEnteredValue ?? "");
  let conditionText = type;
  if (type === "NOT_BLANK") conditionText = "Cell is not empty";
  else if (type === "BLANK") conditionText = "Cell is empty";
  else if (type === "TEXT_CONTAINS") conditionText = `Text contains "${vals[0] || ""}"`;
  else if (type === "NUMBER_LESS") conditionText = `Value < ${vals[0]}`;
  else if (type === "NUMBER_LESS_THAN_EQ") conditionText = `Value <= ${vals[0]}`;
  else if (type === "NUMBER_GREATER") conditionText = `Value > ${vals[0]}`;
  else if (type === "NUMBER_GREATER_THAN_EQ") conditionText = `Value >= ${vals[0]}`;
  else if (type === "NUMBER_BETWEEN") conditionText = `Value between ${vals[0]} and ${vals[1]}`;
  else if (type === "CUSTOM_FORMULA") conditionText = `Formula: ${vals[0] || ""}`;

  const fmt = br.format || {};
  const bg = rgbObjToHex(fmt.backgroundColorStyle?.rgbColor || fmt.backgroundColor);
  const fg = rgbObjToHex(fmt.textFormat?.foregroundColorStyle?.rgbColor || fmt.textFormat?.foregroundColor);
  const bold = typeof fmt.textFormat?.bold === "boolean" ? fmt.textFormat.bold : null;
  return { conditionText, bg, fg, bold };
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
  const selectedCellsRef = useRef(selectedCells);
  const [anchorCell, setAnchorCell] = useState({ r: 0, c: 0 });
  const anchorCellRef = useRef({ r: 0, c: 0 });
  const focusCellRef = useRef({ r: 0, c: 0 });
  const gridContainerRef = useRef(null);
  const [copiedStyle, setCopiedStyle] = useState(null);
  const [showCoordinates, setShowCoordinates] = useState(false);

  const backdropMouseDownRef = useRef(false);
  const dragStateRef = useRef({
    active: false,
    mode: "cell", // 'cell' | 'row' | 'col'
    anchorR: 0,
    anchorC: 0,
    baseSelection: new Set(),
  });

  const applySelectedCells = useCallback((nextSet) => {
    selectedCellsRef.current = nextSet;
    setSelectedCells(nextSet);
  }, []);

  const updateAnchor = useCallback((nextAnchor) => {
    anchorCellRef.current = nextAnchor;
    setAnchorCell(nextAnchor);
  }, []);

  useEffect(() => {
    selectedCellsRef.current = selectedCells;
  }, [selectedCells]);

  useEffect(() => {
    const stopDrag = () => {
      dragStateRef.current.active = false;
    };
    window.addEventListener("mouseup", stopDrag);
    return () => window.removeEventListener("mouseup", stopDrag);
  }, []);

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

      const loadedBlocks = normalizeBlockRows(data.styles?.blocks || []);
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
      applySelectedCells(new Set(["0:0"]));
      updateAnchor({ r: 0, c: 0 });
      focusCellRef.current = { r: 0, c: 0 };
    } catch (err) {
      setError(err.message || "Failed to load snapshot formatting");
    } finally {
      setLoading(false);
    }
  }, [automationCommanderSheetId, applySelectedCells, updateAnchor]);

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
  const activeBlockIndexRef = useRef(activeBlockIndex);
  activeBlockIndexRef.current = activeBlockIndex;

  const activeBlock = activeBlockIndex >= 0 ? blocks[activeBlockIndex] : null;
  const activeSampleRows = activeBlock ? sampleValuesByRange[activeBlock.range] || [] : [];
  const activeMaxCols = useMemo(
    () => (activeBlock?.rows || []).reduce((m, row) => Math.max(m, row?.length || 0), 0),
    [activeBlock]
  );

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

  const selectedCellCfRules = useMemo(() => {
    if (!activeBlock || selectedCells.size === 0) return [];
    const selectedSheetCoords = [...selectedCells].map((k) => {
      const [r, c] = k.split(":").map(Number);
      return { r0: activeBlock.startRow + r, c0: activeBlock.startCol + c };
    });
    const matched = [];
    conditionalFormats.forEach((cf, idx) => {
      const applies = (cf.ranges || []).some((rg) =>
        selectedSheetCoords.some(
          ({ r0, c0 }) =>
            r0 >= (rg.startRowIndex ?? 0) &&
            r0 < (rg.endRowIndex ?? 0) &&
            c0 >= (rg.startColumnIndex ?? 0) &&
            c0 < (rg.endColumnIndex ?? 0)
        )
      );
      if (applies) {
        matched.push({ index: idx + 1, ...describeCfRule(cf) });
      }
    });
    return matched;
  }, [activeBlock, selectedCells, conditionalFormats]);

  const primaryCellStyle = activeBlock?.rows?.[primaryCoords.r]?.[primaryCoords.c] || {
    ...DEFAULT_CELL_STYLE,
  };

  const selectionSummary = useMemo(() => {
    if (!activeBlock || selectedCells.size <= 1) {
      return {
        isMixedBold: false,
        isMixedItalic: false,
        isMixedUnderline: false,
        isMixedAlign: false,
        isMixedFontSize: false,
        isMixedFg: false,
        isMixedBg: false,
      };
    }
    const styles = [];
    for (const key of selectedCells) {
      const [r, c] = key.split(":").map(Number);
      const st = activeBlock.rows?.[r]?.[c];
      if (st) styles.push(st);
    }
    if (styles.length <= 1) {
      return {
        isMixedBold: false,
        isMixedItalic: false,
        isMixedUnderline: false,
        isMixedAlign: false,
        isMixedFontSize: false,
        isMixedFg: false,
        isMixedBg: false,
      };
    }
    const first = styles[0];
    return {
      isMixedBold: styles.some((s) => Boolean(s.bold) !== Boolean(first.bold)),
      isMixedItalic: styles.some((s) => Boolean(s.italic) !== Boolean(first.italic)),
      isMixedUnderline: styles.some((s) => Boolean(s.underline) !== Boolean(first.underline)),
      isMixedAlign: styles.some(
        (s) => String(s.align || "").toUpperCase() !== String(first.align || "").toUpperCase()
      ),
      isMixedFontSize: styles.some((s) => (s.fontSize || 10) !== (first.fontSize || 10)),
      isMixedFg: styles.some((s) => (s.fg || "#000000").toLowerCase() !== (first.fg || "#000000").toLowerCase()),
      isMixedBg: styles.some((s) => (s.bg || "#ffffff").toLowerCase() !== (first.bg || "#ffffff").toLowerCase()),
    };
  }, [activeBlock, selectedCells]);

  const handleSelectBlock = (range) => {
    dragStateRef.current.active = false;
    setActiveRange(range);
    applySelectedCells(new Set(["0:0"]));
    updateAnchor({ r: 0, c: 0 });
    focusCellRef.current = { r: 0, c: 0 };
  };

  const buildRectSelection = useCallback((r1, c1, r2, c2, base = null) => {
    const next = new Set(base || []);
    const rMin = Math.min(r1, r2);
    const rMax = Math.max(r1, r2);
    const cMin = Math.min(c1, c2);
    const cMax = Math.max(c1, c2);
    for (let rr = rMin; rr <= rMax; rr++) {
      for (let cc = cMin; cc <= cMax; cc++) {
        next.add(`${rr}:${cc}`);
      }
    }
    return next;
  }, []);

  useEffect(() => {
    if (!isOpen || loading || !activeBlock) return undefined;
    const rowsCount = activeBlock.rows?.length || 0;
    const colsCount = activeMaxCols || 0;
    if (rowsCount === 0 || colsCount === 0) return undefined;

    const handleKeyDown = (e) => {
      const deltaMap = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      };
      const delta = deltaMap[e.key];
      if (!delta) return;

      const activeEl = document.activeElement;
      const tag = activeEl?.tagName;
      if (
        tag === "SELECT" ||
        tag === "TEXTAREA" ||
        (tag === "INPUT" && activeEl?.type !== "checkbox") ||
        activeEl?.isContentEditable
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      e.preventDefault();

      // Clear focus from toolbar button/checkbox if one was active so visual focus stays on the grid
      if (activeEl && activeEl !== document.body && typeof activeEl.blur === "function") {
        activeEl.blur();
      }

      const [dr, dc] = delta;
      const curFocus = focusCellRef.current || anchorCellRef.current || { r: 0, c: 0 };
      const nr = Math.max(0, Math.min(rowsCount - 1, curFocus.r + dr));
      const nc = Math.max(0, Math.min(colsCount - 1, curFocus.c + dc));

      focusCellRef.current = { r: nr, c: nc };
      if (e.shiftKey) {
        const anc = anchorCellRef.current || { r: 0, c: 0 };
        applySelectedCells(buildRectSelection(anc.r, anc.c, nr, nc));
      } else {
        updateAnchor({ r: nr, c: nc });
        applySelectedCells(new Set([`${nr}:${nc}`]));
      }

      const cellEl = gridContainerRef.current?.querySelector(`[data-cell-key="${nr}:${nc}"]`);
      if (cellEl && typeof cellEl.scrollIntoView === "function") {
        cellEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, loading, activeBlock, activeMaxCols, applySelectedCells, updateAnchor, buildRectSelection]);

  const handleCellMouseDown = (r, c, e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }
    const isAdditive = e.ctrlKey || e.metaKey;
    if (e.shiftKey) {
      const base = isAdditive ? new Set(selectedCellsRef.current) : new Set();
      applySelectedCells(buildRectSelection(anchorCell.r, anchorCell.c, r, c, base));
      focusCellRef.current = { r, c };
      dragStateRef.current = {
        active: true,
        mode: "cell",
        anchorR: anchorCell.r,
        anchorC: anchorCell.c,
        baseSelection: base,
      };
      return;
    }
    if (isAdditive) {
      const next = new Set(selectedCellsRef.current);
      const key = `${r}:${c}`;
      const wasSelected = next.has(key);
      if (wasSelected && next.size > 1) {
        next.delete(key);
        applySelectedCells(next);
        dragStateRef.current = {
          active: false,
          mode: "cell",
          anchorR: r,
          anchorC: c,
          baseSelection: next,
        };
      } else {
        next.add(key);
        applySelectedCells(next);
        updateAnchor({ r, c });
        focusCellRef.current = { r, c };
        dragStateRef.current = {
          active: true,
          mode: "cell",
          anchorR: r,
          anchorC: c,
          baseSelection: new Set(next),
        };
      }
      return;
    }
    applySelectedCells(new Set([`${r}:${c}`]));
    updateAnchor({ r, c });
    focusCellRef.current = { r, c };
    dragStateRef.current = {
      active: true,
      mode: "cell",
      anchorR: r,
      anchorC: c,
      baseSelection: new Set(),
    };
  };

  const handleCellMouseEnter = (r, c, e) => {
    const drag = dragStateRef.current;
    if (!drag.active || !activeBlock) return;
    if (e && typeof e.buttons === "number" && (e.buttons & 1) === 0) {
      drag.active = false;
      return;
    }
    focusCellRef.current = { r, c };
    if (drag.mode === "row") {
      applySelectedCells(
        buildRectSelection(drag.anchorR, 0, r, Math.max(0, activeMaxCols - 1), drag.baseSelection)
      );
      return;
    }
    if (drag.mode === "col") {
      const rowsCount = activeBlock.rows?.length || 0;
      applySelectedCells(
        buildRectSelection(0, drag.anchorC, Math.max(0, rowsCount - 1), c, drag.baseSelection)
      );
      return;
    }
    applySelectedCells(buildRectSelection(drag.anchorR, drag.anchorC, r, c, drag.baseSelection));
  };

  const handleRowMouseDown = (r, e) => {
    if (e.button !== 0 || !activeBlock) return;
    e.preventDefault();
    const colsCount = activeMaxCols || activeBlock.rows?.[r]?.length || 0;
    const isAdditive = e.ctrlKey || e.metaKey;
    const base = isAdditive ? new Set(selectedCellsRef.current) : new Set();
    const startR = e.shiftKey ? anchorCell.r : r;
    applySelectedCells(buildRectSelection(startR, 0, r, Math.max(0, colsCount - 1), base));
    if (!e.shiftKey) updateAnchor({ r, c: 0 });
    focusCellRef.current = { r, c: Math.max(0, colsCount - 1) };
    dragStateRef.current = {
      active: true,
      mode: "row",
      anchorR: startR,
      anchorC: 0,
      baseSelection: base,
    };
  };

  const handleRowMouseEnter = (r, e) => {
    const drag = dragStateRef.current;
    if (!drag.active || drag.mode !== "row" || !activeBlock) return;
    if (e && typeof e.buttons === "number" && (e.buttons & 1) === 0) {
      drag.active = false;
      return;
    }
    const colsCount = activeMaxCols || activeBlock.rows?.[r]?.length || 0;
    focusCellRef.current = { r, c: Math.max(0, colsCount - 1) };
    applySelectedCells(
      buildRectSelection(drag.anchorR, 0, r, Math.max(0, colsCount - 1), drag.baseSelection)
    );
  };

  const handleColMouseDown = (c, e) => {
    if (e.button !== 0 || !activeBlock) return;
    e.preventDefault();
    const rowsCount = activeBlock.rows?.length || 0;
    const isAdditive = e.ctrlKey || e.metaKey;
    const base = isAdditive ? new Set(selectedCellsRef.current) : new Set();
    const startC = e.shiftKey ? anchorCell.c : c;
    applySelectedCells(buildRectSelection(0, startC, Math.max(0, rowsCount - 1), c, base));
    if (!e.shiftKey) updateAnchor({ r: 0, c });
    focusCellRef.current = { r: Math.max(0, rowsCount - 1), c };
    dragStateRef.current = {
      active: true,
      mode: "col",
      anchorR: 0,
      anchorC: startC,
      baseSelection: base,
    };
  };

  const handleColMouseEnter = (c, e) => {
    const drag = dragStateRef.current;
    if (!drag.active || drag.mode !== "col" || !activeBlock) return;
    if (e && typeof e.buttons === "number" && (e.buttons & 1) === 0) {
      drag.active = false;
      return;
    }
    const rowsCount = activeBlock.rows?.length || 0;
    focusCellRef.current = { r: Math.max(0, rowsCount - 1), c };
    applySelectedCells(
      buildRectSelection(0, drag.anchorC, Math.max(0, rowsCount - 1), c, drag.baseSelection)
    );
  };

  const handleSelectAll = () => {
    if (!activeBlock) return;
    const next = new Set();
    (activeBlock.rows || []).forEach((rowArr, r) => {
      (rowArr || []).forEach((_, c) => next.add(`${r}:${c}`));
    });
    applySelectedCells(next);
    updateAnchor({ r: 0, c: 0 });
    focusCellRef.current = { r: 0, c: 0 };
  };

  const updateSelectedStyle = (patchOrFn) => {
    const activeSet = selectedCellsRef.current;
    const blkIdx = activeBlockIndexRef.current;
    if (blkIdx < 0 || !activeSet || activeSet.size === 0) return;
    setNotice(null);
    setBlocks((prev) =>
      prev.map((blk, idx) => {
        if (idx !== blkIdx) return blk;
        const nextRows = (blk.rows || []).map((rowArr, r) =>
          (rowArr || []).map((cellStyle, c) => {
            if (!activeSet.has(`${r}:${c}`)) return cellStyle;
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
      const nextBlocks = normalizeBlockRows(data.styles?.blocks || []);
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
      onMouseDown={(e) => {
        backdropMouseDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget || !backdropMouseDownRef.current) return;
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
              Click and drag (or Shift+click) cells, row headers, or column headers to select a range and adjust colours, bold, italic, and alignment.
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
                    onClick={() =>
                      updateSelectedStyle({
                        bold: selectionSummary.isMixedBold ? true : !primaryCellStyle.bold,
                      })
                    }
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background:
                        !selectionSummary.isMixedBold && primaryCellStyle.bold ? "#1d4ed8" : "#ffffff",
                      color:
                        !selectionSummary.isMixedBold && primaryCellStyle.bold ? "#ffffff" : "#0f172a",
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
                    onClick={() =>
                      updateSelectedStyle({
                        italic: selectionSummary.isMixedItalic ? true : !primaryCellStyle.italic,
                      })
                    }
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background:
                        !selectionSummary.isMixedItalic && primaryCellStyle.italic
                          ? "#1d4ed8"
                          : "#ffffff",
                      color:
                        !selectionSummary.isMixedItalic && primaryCellStyle.italic
                          ? "#ffffff"
                          : "#0f172a",
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
                    onClick={() =>
                      updateSelectedStyle({
                        underline: selectionSummary.isMixedUnderline
                          ? true
                          : !primaryCellStyle.underline,
                      })
                    }
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background:
                        !selectionSummary.isMixedUnderline && primaryCellStyle.underline
                          ? "#1d4ed8"
                          : "#ffffff",
                      color:
                        !selectionSummary.isMixedUnderline && primaryCellStyle.underline
                          ? "#ffffff"
                          : "#0f172a",
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
                    const active =
                      !selectionSummary.isMixedAlign &&
                      String(primaryCellStyle.align || "").toUpperCase() === opt.val;
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
                    value={selectionSummary.isMixedFontSize ? "" : primaryCellStyle.fontSize || 10}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val) && val > 0) {
                        updateSelectedStyle({ fontSize: val });
                      }
                    }}
                    style={{
                      height: "28px",
                      padding: "0 6px",
                      fontSize: "12px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                    }}
                  >
                    {selectionSummary.isMixedFontSize && (
                      <option value="" disabled>
                        Mixed
                      </option>
                    )}
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
                  {selectionSummary.isMixedFg && (
                    <button
                      type="button"
                      onClick={() => updateSelectedStyle({ fg: primaryCellStyle.fg || "#000000" })}
                      title="Apply displayed text colour to all selected cells"
                      style={{
                        padding: "2px 6px",
                        fontSize: "10px",
                        fontWeight: 600,
                        borderRadius: "4px",
                        border: "1px solid #cbd5e1",
                        background: "#ffffff",
                        color: "#334155",
                        cursor: "pointer",
                      }}
                    >
                      Apply
                    </button>
                  )}
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
                        border: !selectionSummary.isMixedFg && primaryCellStyle.fg === sw.hex ? "2px solid #2563eb" : "1px solid #94a3b8",
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
                  {selectionSummary.isMixedBg && (
                    <button
                      type="button"
                      onClick={() => updateSelectedStyle({ bg: primaryCellStyle.bg || "#ffffff" })}
                      title="Apply displayed fill colour to all selected cells"
                      style={{
                        padding: "2px 6px",
                        fontSize: "10px",
                        fontWeight: 600,
                        borderRadius: "4px",
                        border: "1px solid #cbd5e1",
                        background: "#ffffff",
                        color: "#334155",
                        cursor: "pointer",
                      }}
                    >
                      Apply
                    </button>
                  )}
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
                        border: !selectionSummary.isMixedBg && primaryCellStyle.bg === sw.hex ? "2px solid #2563eb" : "1px solid #94a3b8",
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
              <div
                ref={gridContainerRef}
                style={{ flex: 1, overflow: "auto", padding: "16px", background: "#ffffff" }}
              >
                {activeBlock && (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", gap: "12px", flexWrap: "wrap" }}>
                      <div style={{ fontSize: "12px", color: "#475569" }}>
                        Click and drag across cells, row numbers, or column letters to multi-select. Cells marked <span style={{ color: "#2563eb", fontWeight: 600 }}>CF</span> also have conditional formatting rules that may override colours based on live numbers.
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
                            {Array.from({ length: activeMaxCols }, (_, c) => (
                              <th
                                key={c}
                                onMouseDown={(e) => handleColMouseDown(c, e)}
                                onMouseEnter={(e) => handleColMouseEnter(c, e)}
                                title={`Click or drag to select column ${idxToColLetters(activeBlock.startCol + c)}`}
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
                                  onMouseDown={(e) => handleRowMouseDown(r, e)}
                                  onMouseEnter={(e) => handleRowMouseEnter(r, e)}
                                  title={`Click or drag to select row ${sheetRow1}`}
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
                                  const alignUpper = String(cellStyle.align || "").toUpperCase();
                                  const align =
                                    alignUpper === "RIGHT"
                                      ? "right"
                                      : alignUpper === "CENTER"
                                      ? "center"
                                      : alignUpper === "LEFT"
                                      ? "left"
                                      : /^[£$-\d(▲▼+]/.test(String(sampleVal).trim()) && c > 0
                                      ? "right"
                                      : "left";

                                  return (
                                    <td
                                      key={c}
                                      data-cell-key={key}
                                      onMouseDown={(e) => handleCellMouseDown(r, c, e)}
                                      onMouseEnter={(e) => handleCellMouseEnter(r, c, e)}
                                      title={`${coordLabel} | Text: ${cellStyle.fg} | Fill: ${cellStyle.bg} | ${cellStyle.fontSize || 10}pt${hasCf ? " | Conditional formatting active" : ""}`}
                                      style={{
                                        position: "relative",
                                        background: cellStyle.bg || "#ffffff",
                                        color: cellStyle.fg || "#000000",
                                        fontWeight: cellStyle.bold ? 700 : 400,
                                        fontStyle: cellStyle.italic ? "italic" : "normal",
                                        textDecoration: cellStyle.underline ? "underline" : "none",
                                        fontSize: `${Math.max(8, Math.min(20, cellStyle.fontSize || 10))}px`,
                                        textAlign: align,
                                        padding: "5px 10px",
                                        border: "1px solid #e2e8f0",
                                        boxShadow: isSel ? "inset 0 0 0 2px #2563eb" : "none",
                                        cursor: "cell",
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

                    {selectedCellCfRules.length > 0 && (
                      <div
                        style={{
                          marginTop: "14px",
                          padding: "12px 14px",
                          background: "#f8fafc",
                          border: "1px solid #cbd5e1",
                          borderRadius: "8px",
                        }}
                      >
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
                          Conditional formatting rules for selected cell(s) ({selectedCellCfRules.length})
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                          {selectedCellCfRules.map((rule) => (
                            <div
                              key={rule.index}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "12px",
                                padding: "6px 10px",
                                background: "#ffffff",
                                border: "1px solid #e2e8f0",
                                borderRadius: "6px",
                                fontSize: "12px",
                                flexWrap: "wrap",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                <span style={{ fontSize: "10px", fontWeight: 700, color: "#64748b", minWidth: "24px" }}>
                                  #{rule.index}
                                </span>
                                <span style={{ fontFamily: "monospace", color: "#0f172a" }}>
                                  {rule.conditionText}
                                </span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                {rule.bg && (
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "#475569" }}>
                                    Fill:
                                    <span style={{ width: "14px", height: "14px", borderRadius: "3px", background: rule.bg, border: "1px solid #94a3b8", display: "inline-block" }} />
                                    <span style={{ fontFamily: "monospace" }}>{rule.bg}</span>
                                  </span>
                                )}
                                {rule.fg && (
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "#475569" }}>
                                    Text:
                                    <span style={{ width: "14px", height: "14px", borderRadius: "3px", background: rule.fg, border: "1px solid #94a3b8", display: "inline-block" }} />
                                    <span style={{ fontFamily: "monospace" }}>{rule.fg}</span>
                                  </span>
                                )}
                                {rule.bold !== null && (
                                  <span style={{ fontSize: "11px", fontWeight: 600, color: "#334155" }}>
                                    {rule.bold ? "Bold" : "Not bold"}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div style={{ marginTop: "6px", fontSize: "11px", color: "#64748b" }}>
                          Rules are evaluated top-to-bottom; the first matching rule wins for each property (fill, text colour, bold).
                        </div>
                      </div>
                    )}
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
