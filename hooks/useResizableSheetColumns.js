import { useState, useEffect, useCallback, useMemo, useRef } from "react";

const STORAGE_KEY_DEFAULT = "pma_sheet_col_widths_v1";
const MIN_COL_WIDTH = 24;
const MAX_COL_WIDTH = 900;

function loadStoredWidths(storageKey) {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveStoredWidths(storageKey, map) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(map));
  } catch (_) {
    // Ignore quota errors
  }
}

function measureTextPx(text, bold = false) {
  const s = String(text ?? "");
  if (!s) return 0;
  if (typeof document !== "undefined") {
    try {
      const canvas = measureTextPx._canvas || (measureTextPx._canvas = document.createElement("canvas"));
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.font = `${bold ? "700" : "400"} 13px Arial, sans-serif`;
        return ctx.measureText(s).width;
      }
    } catch (_) {
      // Fallback below
    }
  }
  return s.length * (bold ? 8 : 7.2);
}

/**
 * Shared hook providing Google Sheets-style draggable column resizing,
 * double-click auto-fit, and per-tab localStorage width persistence.
 */
export function useResizableSheetColumns({
  activeTab,
  defaultWidths = [],
  storageKey = STORAGE_KEY_DEFAULT,
}) {
  const [customWidthsByTab, setCustomWidthsByTab] = useState(() => loadStoredWidths(storageKey));
  const [resizingCol, setResizingCol] = useState(null);
  const latestMapRef = useRef(customWidthsByTab);

  useEffect(() => {
    latestMapRef.current = customWidthsByTab;
  }, [customWidthsByTab]);

  const tabCustomWidths = useMemo(
    () => customWidthsByTab[activeTab] || {},
    [customWidthsByTab, activeTab]
  );
  const hasCustomWidths = Object.keys(tabCustomWidths).length > 0;

  const getColWidth = useCallback(
    (colIdx) => {
      const custom = tabCustomWidths[colIdx];
      if (typeof custom === "number" && Number.isFinite(custom)) return custom;
      const def = defaultWidths?.[colIdx];
      return typeof def === "number" && Number.isFinite(def) ? def : 100;
    },
    [tabCustomWidths, defaultWidths]
  );

  const setColumnWidth = useCallback(
    (colIdx, widthPx, persist = true) => {
      const clamped = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(widthPx)));
      setCustomWidthsByTab((prev) => {
        const nextTab = { ...(prev[activeTab] || {}), [colIdx]: clamped };
        const next = { ...prev, [activeTab]: nextTab };
        latestMapRef.current = next;
        if (persist) saveStoredWidths(storageKey, next);
        return next;
      });
    },
    [activeTab, storageKey]
  );

  const startColumnResize = useCallback(
    (e, colIdx) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = getColWidth(colIdx);
      setResizingCol(colIdx);

      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handleMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        const nextWidth = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(startWidth + delta)));
        setCustomWidthsByTab((prev) => {
          const nextTab = { ...(prev[activeTab] || {}), [colIdx]: nextWidth };
          const next = { ...prev, [activeTab]: nextTab };
          latestMapRef.current = next;
          return next;
        });
      };

      const handleUp = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        setResizingCol(null);
        saveStoredWidths(storageKey, latestMapRef.current);
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [activeTab, getColWidth, storageKey]
  );

  const autoFitColumn = useCallback(
    (e, colIdx, rowsToScan = [], getDisplayTextFn = null) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      let maxW = 36;
      const limit = Math.min(rowsToScan.length, 300);
      for (let i = 0; i < limit; i++) {
        const item = rowsToScan[i];
        const raw = getDisplayTextFn ? getDisplayTextFn(item, colIdx) : item?.[colIdx];
        const s = String(raw ?? "");
        if (!s) continue;
        // For multi-line text, measure longest line
        const lines = s.split(/\r?\n/);
        for (const line of lines) {
          const w = measureTextPx(line, i === 0);
          if (w > maxW) maxW = w;
        }
      }
      setColumnWidth(colIdx, Math.max(40, Math.min(540, Math.ceil(maxW + 22))), true);
    },
    [setColumnWidth]
  );

  const resetTabWidths = useCallback(() => {
    setCustomWidthsByTab((prev) => {
      if (!prev[activeTab]) return prev;
      const next = { ...prev };
      delete next[activeTab];
      latestMapRef.current = next;
      saveStoredWidths(storageKey, next);
      return next;
    });
  }, [activeTab, storageKey]);

  return {
    getColWidth,
    resizingCol,
    startColumnResize,
    autoFitColumn,
    resetTabWidths,
    hasCustomWidths,
  };
}
