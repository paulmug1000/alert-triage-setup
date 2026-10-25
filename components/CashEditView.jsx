import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Spinner from "./Spinner";
import { CashflowSkeleton } from "./Skeleton";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
import CellNoteIndicator from "./CellNoteIndicator";
import CellNoteModal from "./CellNoteModal";
import EditClientSelector from "./EditClientSelector";
import { formatMoney as universalFormatMoney, parseMoney } from "../services/deepDiveHelper";

export function colIdxToLetter(colIdx) {
  let temp = colIdx + 1;
  let letter = "";
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter;
}

export function isCashCellEditable(rowNum, colIdx) {
  if (colIdx < 1) return false;

  // 1. Whitelisted Single Override Cells
  if (rowNum === 4 && colIdx === 1) return true;  // B4
  if (rowNum === 8 && colIdx === 1) return true;  // B8
  if (rowNum === 12 && colIdx === 1) return true; // B12
  if (rowNum === 16 && colIdx === 1) return true; // B16
  if (rowNum === 19 && colIdx === 1) return true; // B19
  if (rowNum === 21 && colIdx === 1) return true; // B21
  if (rowNum === 19 && colIdx === 9) return true; // J19
  if (rowNum === 61 && colIdx === 1) return true; // B61
  if (rowNum === 63 && colIdx === 1) return true; // B63
  if (rowNum === 61 && colIdx === 9) return true; // J61

  // 2. Table 1 Adjustment Rows (All months, Col B onwards)
  const adjustmentRows = [7, 9, 11, 13, 15, 17, 20, 22, 25, 27, 29, 30];
  if (adjustmentRows.includes(rowNum)) return true;

  // 3. Actual Closing Balance Row (Row 36, all months)
  if (rowNum === 36) return true;

  return false;
}

// Helper to parse numbers from sheet currency strings
function parseNum(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const s = String(val).trim();
  if (!s || s === "-" || s === "£-" || s === "$-") return 0;
  const isNeg = (s.startsWith("(") && s.endsWith(")")) || s.startsWith("-");
  const cleaned = s.replace(/[£$€,\s()]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return isNeg ? -Math.abs(num) : num;
}

export default function CashEditView({
  allOutgoingsClients = [],
  styles = {},
  managedClient,
  onClearManagedClient,
  initialClient,
}) {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin || user?.role === "Admin" || user?.role === "ClientManager");
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  // Selected Client State
  const [selectedClient, setSelectedClient] = useState(() => {
    if (managedClient) {
      return (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
    }
    if (initialClient) {
      return (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === (typeof initialClient === "string" ? initialClient.toLowerCase() : initialClient?.clientName?.toLowerCase())
      ) || (typeof initialClient === "object" ? initialClient : null);
    }
    return null;
  });

  // Data & Matrix State
  const [cashData, setCashData] = useState(null);
  const [matrix, setMatrix] = useState({}); // `${sheetRow}_${colIdx}` -> { formattedValue, formula, note, isEditable }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Auto-Save Status: "idle" | "saving" | "saved" | "error"
  const [saveStatus, setSaveStatus] = useState("idle");
  const saveTimeoutRef = useRef(null);
  const pendingUpdatesRef = useRef(new Map()); // key: `${sheetRow}_${colIdx}` -> { sheetRow, colIdx, colLetter, value }
  const pendingNotesRef = useRef(new Map()); // key: `${sheetRow}_${colIdx}` -> { sheetRow, colIdx, colLetter, note }

  // Undo / Redo History
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);

  // Active Selected Cell & In-Place Editing
  const [activeCell, setActiveCell] = useState(null); // { sheetRow, colIdx }
  const [editingCell, setEditingCell] = useState(null); // { sheetRow, colIdx, editValue }
  const [dragRange, setDragRange] = useState(null); // { startRow, startCol, endCol }
  const isDraggingRef = useRef(false);
  const internalClipboardRef = useRef(null); // { val, note }

  // Cell Note Modal State
  const [noteModal, setNoteModal] = useState({
    isOpen: false,
    sheetRow: null,
    colIdx: null,
    colLetter: "",
    title: "",
    subtitle: "",
    initialNote: "",
  });

  // Collapsible Sections
  const [table1Open, setTable1Open] = useState(true);
  const [table2Open, setTable2Open] = useState(true);

  // Currency
  const currencySymbol = "£";
  const formatMoney = (val) => universalFormatMoney(val, 0, currencySymbol, ",");

  // Horizontal Scroll Reference for Timeline
  const scrollContainerRef = useRef(null);
  const hasAutoScrolledRef = useRef(false);

  // Synchronize client selection from managedClient
  useEffect(() => {
    if (managedClient) {
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
      setSelectedClient(match);
    }
  }, [managedClient, allOutgoingsClients]);

  // Back to client selector navigation handler (matches other Edit screens)
  const handleBackToClients = () => {
    if (managedClient && onClearManagedClient) {
      onClearManagedClient();
    } else {
      setSelectedClient(null);
      setCashData(null);
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("pma_cash_client");
        const url = new URL(window.location.href);
        url.searchParams.delete("client");
        window.history.replaceState(null, "", url.toString());
      }
    }
  };

  // Fetch Cash Data (with Global Preload Cache Integration)
  const loadCashData = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cleanId = cleanSheetId(client.clientSheetId);

    // 1. Check L1 Memory / Global Prefetch Cache
    if (!bypassCache) {
      const cached = getCachedClientData(cleanId, "cash");
      if (cached?.data && !cached.isStale) {
        initDataState(cached.data);
        return;
      }

      if (typeof getInFlightPrefetch === "function") {
        const inFlight = getInFlightPrefetch(`cash_${cleanId}`);
        if (inFlight) {
          try {
            setLoading(true);
            const d = await inFlight;
            if (d?.success) {
              initDataState(d);
              setLoading(false);
              return;
            }
          } catch (e) {
            console.warn("In-flight cash prefetch failed:", e);
          }
        }
      }
    }

    setLoading(true);
    setError(null);

    try {
      const url = `/api/pma/cash?clientSheetId=${encodeURIComponent(cleanId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const json = await res.json();

      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to load cash data");
      }

      setCachedClientData(cleanId, "cash", json);
      initDataState(json);
    } catch (err) {
      console.error("loadCashData error:", err);
      setError(err.message || "Failed to load cash data");
    } finally {
      setLoading(false);
    }
  }, [cleanSheetId, getCachedClientData, setCachedClientData, getInFlightPrefetch]);

  // Initialize Matrix and Rows from API payload
  const initDataState = (payload) => {
    setCashData(payload);
    const newMatrix = {};

    const populate = (rows) => {
      (rows || []).forEach((r) => {
        (r.cells || []).forEach((c) => {
          newMatrix[`${c.sheetRow}_${c.colIdx}`] = {
            sheetRow: c.sheetRow,
            colIdx: c.colIdx,
            colLetter: c.colLetter,
            formattedValue: c.formattedValue || "",
            formula: c.formula || "",
            note: c.note || "",
            isEditable: c.isEditable,
            bgColor: c.bgColor || null,
            isBold: Boolean(c.isBold),
          };
        });
      });
    };

    populate(payload.table1Rows);
    populate(payload.table2Rows);

    setMatrix(newMatrix);
    setUndoStack([]);
    setRedoStack([]);
    hasAutoScrolledRef.current = false;
  };

  useEffect(() => {
    if (selectedClient?.clientSheetId) {
      loadCashData(selectedClient, false);
    }
  }, [selectedClient, loadCashData]);

  // Auto-scroll timeline to Previous Month (M-1) on load
  useEffect(() => {
    if (!cashData || hasAutoScrolledRef.current || !scrollContainerRef.current) return;
    const prevColIdx = cashData.previousMonthColIdx || 1;
    const colHeaderElem = document.getElementById(`cash-header-col-${prevColIdx}`);

    if (colHeaderElem && scrollContainerRef.current) {
      // Find offset of previous month relative to scroll container
      const containerLeft = scrollContainerRef.current.getBoundingClientRect().left;
      const elemLeft = colHeaderElem.getBoundingClientRect().left;
      const stickyColWidth = 230; // Width of pinned Category Column A
      const targetScroll = scrollContainerRef.current.scrollLeft + (elemLeft - containerLeft) - stickyColWidth;

      scrollContainerRef.current.scrollTo({
        left: Math.max(0, targetScroll),
        behavior: "smooth",
      });
      hasAutoScrolledRef.current = true;
    }
  }, [cashData]);

  // ─────────────────────────────────────────────────────────────────────────────
  // INSTANT LOCAL SIMULATION ENGINE
  // ─────────────────────────────────────────────────────────────────────────────
  const simulateCashFlow = useCallback((currentMatrix, monthCols) => {
    const updated = { ...currentMatrix };
    const numCols = monthCols.length;

    // Simulation for Table 1 (Excluding pipeline)
    for (let c = 1; c <= numCols; c++) {
      // Row 4: Opening balance
      let openingBal = 0;
      if (c === 1) {
        // Month 1 uses manual entry cell B4
        openingBal = parseNum(updated[`4_${c}`]?.formattedValue);
      } else {
        // Subsequent months use previous month's actual closing balance (Row 36) if present, else calculated closing balance (Row 34)
        const prevActual = updated[`36_${c - 1}`]?.formattedValue;
        if (prevActual && String(prevActual).trim() !== "" && Math.abs(parseNum(prevActual)) > 0.001) {
          openingBal = parseNum(prevActual);
        } else {
          openingBal = parseNum(updated[`34_${c - 1}`]?.formattedValue);
        }
        // Update Row 4 display
        if (updated[`4_${c}`]) {
          updated[`4_${c}`] = {
            ...updated[`4_${c}`],
            formattedValue: formatMoney(openingBal),
          };
        }
      }

      // Sum all cash incoming & outgoing lines between Row 5 and Row 31
      let netMovement = 0;
      for (let r = 5; r <= 31; r++) {
        const cell = updated[`${r}_${c}`];
        if (cell?.formattedValue) {
          netMovement += parseNum(cell.formattedValue);
        }
      }

      // Row 32: Net cash movement
      if (updated[`32_${c}`]) {
        updated[`32_${c}`] = {
          ...updated[`32_${c}`],
          formattedValue: formatMoney(netMovement),
        };
      }

      // Row 34: Closing balance = Opening (Row 4) + Net movement (Row 32)
      const closingBal = openingBal + netMovement;
      if (updated[`34_${c}`]) {
        updated[`34_${c}`] = {
          ...updated[`34_${c}`],
          formattedValue: formatMoney(closingBal),
        };
      }

      // Row 37: Difference = If Actual closing (Row 36) is present, Actual - Closing
      const actualVal = updated[`36_${c}`]?.formattedValue;
      if (updated[`37_${c}`]) {
        if (actualVal && String(actualVal).trim() !== "") {
          const diff = parseNum(actualVal) - closingBal;
          updated[`37_${c}`] = {
            ...updated[`37_${c}`],
            formattedValue: formatMoney(diff),
          };
        } else {
          updated[`37_${c}`] = {
            ...updated[`37_${c}`],
            formattedValue: "",
          };
        }
      }

      // Table 2 Linkage: Update linked rows in Table 2
      // Row 45: Opening balance for Table 2
      if (updated[`45_${c}`]) {
        if (c === 1) {
          updated[`45_${c}`] = { ...updated[`45_${c}`], formattedValue: formatMoney(openingBal) };
        } else {
          const prevActualTable2 = updated[`36_${c - 1}`]?.formattedValue;
          const prevClosingTable2 = parseNum(updated[`76_${c - 1}`]?.formattedValue);
          const t2Opening = (prevActualTable2 && String(prevActualTable2).trim() !== "")
            ? parseNum(prevActualTable2)
            : prevClosingTable2;
          updated[`45_${c}`] = { ...updated[`45_${c}`], formattedValue: formatMoney(t2Opening) };
        }
      }

      // Mirror Table 1 adjustment rows to Table 2
      const mirroredRows = [
        [7, 49], [9, 51], [11, 53], [13, 55], [15, 57], [17, 59],
        [20, 62], [22, 64], [25, 67], [27, 69], [29, 71], [30, 72]
      ];
      mirroredRows.forEach(([srcRow, destRow]) => {
        if (updated[`${srcRow}_${c}`] && updated[`${destRow}_${c}`]) {
          updated[`${destRow}_${c}`] = {
            ...updated[`${destRow}_${c}`],
            formattedValue: updated[`${srcRow}_${c}`].formattedValue,
          };
        }
      });

      // Table 2 Net Cash Movement (Row 74) & Closing Balance (Row 76)
      let t2Net = 0;
      for (let r = 46; r <= 73; r++) {
        const cell = updated[`${r}_${c}`];
        if (cell?.formattedValue) {
          t2Net += parseNum(cell.formattedValue);
        }
      }
      if (updated[`74_${c}`]) {
        updated[`74_${c}`] = { ...updated[`74_${c}`], formattedValue: formatMoney(t2Net) };
      }
      if (updated[`76_${c}`]) {
        const t2Open = parseNum(updated[`45_${c}`]?.formattedValue);
        updated[`76_${c}`] = { ...updated[`76_${c}`], formattedValue: formatMoney(t2Open + t2Net) };
      }
    }

    return updated;
  }, [formatMoney]);

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTO-SAVE DISPATCHER (DEBOUNCED BATCHING)
  // ─────────────────────────────────────────────────────────────────────────────
  const triggerBatchSave = useCallback(async () => {
    if (!selectedClient?.clientSheetId) return;
    const updates = Array.from(pendingUpdatesRef.current.values());
    const cellNotes = Array.from(pendingNotesRef.current.values());

    if (updates.length === 0 && cellNotes.length === 0) return;

    setSaveStatus("saving");

    try {
      const res = await fetch("/api/pma/cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_batch",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          updates,
          cellNotes,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save cash changes");
      }

      // Clear pending
      pendingUpdatesRef.current.clear();
      pendingNotesRef.current.clear();
      setSaveStatus("saved");

      // Auto-revert status to idle after 2.5 seconds
      setTimeout(() => {
        setSaveStatus((prev) => (prev === "saved" ? "idle" : prev));
      }, 2500);
    } catch (err) {
      console.error("Batch save error:", err);
      setSaveStatus("error");
    }
  }, [selectedClient]);

  const queueSave = useCallback((cellUpdates = [], noteUpdates = []) => {
    cellUpdates.forEach((up) => {
      pendingUpdatesRef.current.set(`${up.sheetRow}_${up.colIdx}`, up);
    });
    noteUpdates.forEach((nu) => {
      pendingNotesRef.current.set(`${nu.sheetRow}_${nu.colIdx}`, nu);
    });

    setSaveStatus("saving");
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      triggerBatchSave();
    }, 600);
  }, [triggerBatchSave]);

  // ─────────────────────────────────────────────────────────────────────────────
  // APPLY CELL VALUE CHANGES (WITH UNDO HISTORY & SIMULATION)
  // ─────────────────────────────────────────────────────────────────────────────
  const applyCellChanges = useCallback((changes = [], isUndoRedo = false) => {
    if (!changes.length || !cashData?.monthCols) return;

    const undoRecord = [];
    const queuedValues = [];
    const queuedNotes = [];

    setMatrix((prev) => {
      const next = { ...prev };

      changes.forEach(({ sheetRow, colIdx, value, note }) => {
        const key = `${sheetRow}_${colIdx}`;
        const existing = next[key] || {};
        const oldVal = existing.formattedValue ?? "";
        const oldNote = existing.note ?? "";

        const isEditable = isCashCellEditable(sheetRow, colIdx);
        let updatedVal = oldVal;
        let updatedNote = oldNote;

        // Apply numeric value if cell is editable
        if (value !== undefined && isEditable) {
          const rawNum = parseNum(value);
          updatedVal = formatMoney(rawNum);
          queuedValues.push({
            sheetRow,
            colIdx,
            colLetter: existing.colLetter || colIdxToLetter(colIdx),
            value: updatedVal,
          });
        }

        // Apply note if provided (allowed for all cells Col B onwards)
        if (note !== undefined && colIdx >= 1) {
          updatedNote = String(note).trim();
          queuedNotes.push({
            sheetRow,
            colIdx,
            colLetter: existing.colLetter || colIdxToLetter(colIdx),
            note: updatedNote,
          });
        }

        next[key] = {
          ...existing,
          formattedValue: updatedVal,
          note: updatedNote,
        };

        undoRecord.push({
          sheetRow,
          colIdx,
          oldValue: oldVal,
          newValue: updatedVal,
          oldNote,
          newNote: updatedNote,
        });
      });

      // Instant local simulation
      const simulated = simulateCashFlow(next, cashData.monthCols);
      return simulated;
    });

    if (!isUndoRedo && undoRecord.length > 0) {
      setUndoStack((prev) => [...prev, undoRecord]);
      setRedoStack([]);
    }

    queueSave(queuedValues, queuedNotes);
  }, [cashData, formatMoney, queueSave, simulateCashFlow]);

  // ─────────────────────────────────────────────────────────────────────────────
  // UNDO & REDO DISPATCHERS
  // ─────────────────────────────────────────────────────────────────────────────
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const lastAction = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));

    // Reverse changes
    const reverseChanges = lastAction.map((item) => ({
      sheetRow: item.sheetRow,
      colIdx: item.colIdx,
      value: item.oldValue,
      note: item.oldNote,
    }));

    applyCellChanges(reverseChanges, true);
    setRedoStack((prev) => [...prev, lastAction]);
  }, [undoStack, applyCellChanges]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const actionToRedo = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));

    const applyAgain = actionToRedo.map((item) => ({
      sheetRow: item.sheetRow,
      colIdx: item.colIdx,
      value: item.newValue,
      note: item.newNote,
    }));

    applyCellChanges(applyAgain, true);
    setUndoStack((prev) => [...prev, actionToRedo]);
  }, [redoStack, applyCellChanges]);

  // ─────────────────────────────────────────────────────────────────────────────
  // KEYBOARD NAVIGATION & SHORTCUTS (CTRL+C, CTRL+V, CTRL+Z, SHIFT+F2)
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't intercept if user is typing in a modal or non-grid input
      if (noteModal.isOpen) return;
      if (document.activeElement?.tagName === "TEXTAREA" || (document.activeElement?.tagName === "INPUT" && !document.activeElement?.classList.contains("cash-grid-input"))) {
        return;
      }

      // Undo: Ctrl+Z / Cmd+Z
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Redo: Ctrl+Y / Cmd+Y or Ctrl+Shift+Z / Cmd+Shift+Z
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")) {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Edit Note: Shift + F2
      if (e.shiftKey && e.key === "F2" && activeCell) {
        e.preventDefault();
        openNoteModalForCell(activeCell.sheetRow, activeCell.colIdx);
        return;
      }

      // Copy: Ctrl+C
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && activeCell && !editingCell) {
        const key = `${activeCell.sheetRow}_${activeCell.colIdx}`;
        const cellData = matrix[key];
        if (cellData) {
          internalClipboardRef.current = {
            val: cellData.formattedValue || "",
            note: cellData.note || "",
          };
          if (navigator.clipboard) {
            navigator.clipboard.writeText(cellData.formattedValue || "").catch(() => { });
          }
        }
        return;
      }

      // Paste: Ctrl+V
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && activeCell && !editingCell) {
        e.preventDefault();
        const key = `${activeCell.sheetRow}_${activeCell.colIdx}`;
        const target = matrix[key];
        if (!target) return;

        // Use internal clipboard if available (contains both value + note)
        if (internalClipboardRef.current) {
          applyCellChanges([{
            sheetRow: activeCell.sheetRow,
            colIdx: activeCell.colIdx,
            value: internalClipboardRef.current.val,
            note: internalClipboardRef.current.note,
          }]);
        } else if (navigator.clipboard) {
          navigator.clipboard.readText().then((text) => {
            if (text) {
              applyCellChanges([{
                sheetRow: activeCell.sheetRow,
                colIdx: activeCell.colIdx,
                value: text.trim(),
              }]);
            }
          }).catch(() => { });
        }
        return;
      }

      // Arrow Key Navigation
      if (activeCell && !editingCell) {
        const { sheetRow, colIdx } = activeCell;
        const totalCols = cashData?.monthCols?.length || 36;

        if (e.key === "ArrowRight" && colIdx < totalCols) {
          e.preventDefault();
          setActiveCell({ sheetRow, colIdx: colIdx + 1 });
        } else if (e.key === "ArrowLeft" && colIdx > 1) {
          e.preventDefault();
          setActiveCell({ sheetRow, colIdx: colIdx - 1 });
        } else if (e.key === "ArrowDown" && sheetRow < 76) {
          e.preventDefault();
          setActiveCell({ sheetRow: sheetRow + 1, colIdx });
        } else if (e.key === "ArrowUp" && sheetRow > 2) {
          e.preventDefault();
          setActiveCell({ sheetRow: sheetRow - 1, colIdx });
        } else if (e.key === "Enter" || e.key === "F2") {
          const isEditable = isCashCellEditable(sheetRow, colIdx);
          if (isEditable) {
            e.preventDefault();
            const curVal = matrix[`${sheetRow}_${colIdx}`]?.formattedValue || "";
            setEditingCell({ sheetRow, colIdx, editValue: curVal });
          }
        } else if ((e.key === "Delete" || e.key === "Backspace") && isCashCellEditable(sheetRow, colIdx)) {
          e.preventDefault();
          applyCellChanges([{ sheetRow, colIdx, value: "0" }]);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeCell, editingCell, matrix, noteModal.isOpen, cashData, handleUndo, handleRedo, applyCellChanges]);

  // ─────────────────────────────────────────────────────────────────────────────
  // DRAG-TO-FILL MOUSE HANDLERS
  // ─────────────────────────────────────────────────────────────────────────────
  const handleDragHandleMouseDown = (e, sheetRow, colIdx) => {
    e.stopPropagation();
    e.preventDefault();
    isDraggingRef.current = true;
    setDragRange({ startRow: sheetRow, startCol: colIdx, endCol: colIdx });

    const handleWindowMouseMove = (moveEvent) => {
      if (!isDraggingRef.current) return;
      // Identify cell underneath mouse pointer
      const targetElem = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const cellElem = targetElem?.closest("[data-cash-col-idx]");
      if (cellElem) {
        const targetCol = parseInt(cellElem.getAttribute("data-cash-col-idx"), 10);
        if (!isNaN(targetCol)) {
          setDragRange((prev) => (prev ? { ...prev, endCol: targetCol } : null));
        }
      }
    };

    const handleWindowMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);

      setDragRange((currentRange) => {
        if (!currentRange || currentRange.startCol === currentRange.endCol) return null;
        const row = currentRange.startRow;
        const srcCol = currentRange.startCol;
        const minCol = Math.min(srcCol, currentRange.endCol);
        const maxCol = Math.max(srcCol, currentRange.endCol);

        const srcData = matrix[`${row}_${srcCol}`];
        if (!srcData) return null;

        const changes = [];
        for (let c = minCol; c <= maxCol; c++) {
          if (c === srcCol) continue;
          changes.push({
            sheetRow: row,
            colIdx: c,
            value: srcData.formattedValue,
            note: srcData.note,
          });
        }

        if (changes.length > 0) {
          applyCellChanges(changes);
        }
        return null;
      });
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // NOTE MODAL HANDLERS
  // ─────────────────────────────────────────────────────────────────────────────
  const openNoteModalForCell = (sheetRow, colIdx) => {
    const key = `${sheetRow}_${colIdx}`;
    const cellData = matrix[key];
    const colLetter = cellData?.colLetter || colIdxToLetter(colIdx);
    const monthLabel = cashData?.monthCols?.find((m) => m.colIdx === colIdx)?.label || `Col ${colLetter}`;

    // Find row label from Table 1 or Table 2
    let rowLabel = `Row ${sheetRow}`;
    const t1 = cashData?.table1Rows?.find((r) => r.sheetRow === sheetRow);
    const t2 = cashData?.table2Rows?.find((r) => r.sheetRow === sheetRow);
    if (t1?.label) rowLabel = t1.label;
    else if (t2?.label) rowLabel = t2.label;

    setNoteModal({
      isOpen: true,
      sheetRow,
      colIdx,
      colLetter,
      title: `${rowLabel} • ${monthLabel}`,
      subtitle: `Cell Cash!${colLetter}${sheetRow} • ${cellData?.formattedValue || "£0"}`,
      initialNote: cellData?.note || "",
    });
  };

  const handleSaveNote = async (newNoteText) => {
    if (!noteModal.sheetRow || !noteModal.colIdx) return;
    applyCellChanges([{
      sheetRow: noteModal.sheetRow,
      colIdx: noteModal.colIdx,
      note: newNoteText,
    }]);
  };



  // ─────────────────────────────────────────────────────────────────────────────
  // CELL EDIT COMMIT / CANCEL
  // ─────────────────────────────────────────────────────────────────────────────
  const commitCellEdit = () => {
    if (!editingCell) return;
    const { sheetRow, colIdx, editValue } = editingCell;
    setEditingCell(null);
    applyCellChanges([{ sheetRow, colIdx, value: editValue }]);
  };

  // If no client selected, show standardized EditClientSelector
  if (!selectedClient) {
    return (
      <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
        <EditClientSelector
          clients={allOutgoingsClients}
          onSelectClient={(c) => setSelectedClient(c)}
        />
      </div>
    );
  }

  const monthCols = cashData?.monthCols || [];

  return (
    <div
      style={{
        padding: "16px 24px 40px 24px",
        minHeight: "100vh",
        background: "#f8fafc",
        fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {/* ── HEADER / TOOLBAR (MATCHES OTHER EDIT SCREENS) ──────────────────────── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
          marginBottom: "20px",
          background: "#ffffff",
          padding: "16px 20px",
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          border: "1px solid #e2e8f0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {selectedClient && !managedClient && (allOutgoingsClients || []).length > 1 && (
            <button
              type="button"
              onClick={handleBackToClients}
              style={{
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: "pointer",
                padding: "6px 12px",
                fontSize: "16px",
                color: "#475569",
                lineHeight: 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s ease",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "#f1f5f9";
                e.currentTarget.style.borderColor = "#94a3b8";
                e.currentTarget.style.color = "#0f172a";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "#ffffff";
                e.currentTarget.style.borderColor = "#cbd5e1";
                e.currentTarget.style.color = "#475569";
              }}
              title="Back to client list"
            >
              ←
            </button>
          )}
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: "20px",
                fontWeight: 700,
                color: "#1e293b",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span>Cash</span>
            </h1>
            {selectedClient ? (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {selectedClient.clientName}
              </div>
            ) : (
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                Select a client to view and edit cash
              </p>
            )}
          </div>
        </div>

        {/* Right Tools: Undo/Redo, Auto-Save Status, Refresh, Google Sheets link */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {/* Undo / Redo Buttons */}
          <div style={{ display: "inline-flex", border: "1px solid #cbd5e1", borderRadius: "6px", overflow: "hidden" }}>
            <button
              type="button"
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              style={{
                background: undoStack.length > 0 ? "#ffffff" : "#f1f5f9",
                border: "none",
                padding: "6px 11px",
                fontSize: "12px",
                fontWeight: 600,
                color: undoStack.length > 0 ? "#1e293b" : "#94a3b8",
                cursor: undoStack.length > 0 ? "pointer" : "not-allowed",
                borderRight: "1px solid #cbd5e1",
              }}
              title="Undo (Ctrl+Z)"
            >
              ↶ Undo
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={redoStack.length === 0}
              style={{
                background: redoStack.length > 0 ? "#ffffff" : "#f1f5f9",
                border: "none",
                padding: "6px 11px",
                fontSize: "12px",
                fontWeight: 600,
                color: redoStack.length > 0 ? "#1e293b" : "#94a3b8",
                cursor: redoStack.length > 0 ? "pointer" : "not-allowed",
              }}
              title="Redo (Ctrl+Y)"
            >
              ↷ Redo
            </button>
          </div>

          {/* Save Status Badge */}
          {saveStatus === "saving" && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#64748b" }}>
              <Spinner size={12} color="#0047AB" />
              <span>Saving changes...</span>
            </div>
          )}
          {saveStatus === "saved" && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#16a34a", fontWeight: 600 }}>
              <span>✓ All changes saved</span>
            </div>
          )}
          {saveStatus === "error" && (
            <button
              type="button"
              onClick={triggerBatchSave}
              style={{
                background: "#fee2e2",
                border: "1px solid #fca5a5",
                color: "#dc2626",
                borderRadius: "6px",
                padding: "4px 8px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Retry save
            </button>
          )}

          {/* Refresh Button */}
          <button
            type="button"
            onClick={() => loadCashData(selectedClient, true)}
            disabled={loading}
            style={{
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              padding: "5px 10px",
              fontSize: "12px",
              fontWeight: 600,
              color: "#334155",
              cursor: loading ? "not-allowed" : "pointer",
            }}
            title="Refresh from Google Sheet"
          >
            {loading ? "Refreshing..." : "↻ Refresh"}
          </button>

          {/* External Google Sheets Link */}
          <a
            href={`https://docs.google.com/spreadsheets/d/${selectedClient.clientSheetId}/edit#gid=0`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: "12px",
              color: "#0047AB",
              textDecoration: "none",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <span>Open in Google Sheets</span>
            <span style={{ fontSize: "10px" }}>↗</span>
          </a>
        </div>
      </div>

      {/* ── LOADING / ERROR STATES ─────────────────────────────────────────────── */}
      {(loading || (!cashData && !error)) && (
        <CashflowSkeleton />
      )}

      {error && !cashData && (
        <div style={{ padding: "24px", background: "#fef2f2", borderRadius: "10px", border: "1px solid #fecaca", color: "#991b1b" }}>
          <div style={{ fontWeight: 700, fontSize: "14px", marginBottom: "4px" }}>Unable to load Cash data</div>
          <div style={{ fontSize: "13px" }}>{error}</div>
          <button
            type="button"
            onClick={() => loadCashData(selectedClient, true)}
            style={{
              marginTop: "12px",
              background: "#991b1b",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              padding: "6px 12px",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      )}

      {/* ── SPREADSHEET GRID ───────────────────────────────────────────────────── */}
      {cashData && (
        <div
          ref={scrollContainerRef}
          style={{
            background: "#ffffff",
            borderRadius: "10px",
            border: "1px solid #cbd5e1",
            boxShadow: "0 4px 6px -1px rgba(0,0,0,0.05)",
            overflowX: "auto",
            position: "relative",
          }}
        >
          <table
            style={{
              borderCollapse: "separate",
              borderSpacing: 0,
              width: "max-content",
              minWidth: "100%",
              fontSize: "12px",
            }}
          >
            {/* ── HEADER ROW (MONTHS) ────────────────────────────────────────────── */}
            <thead>
              <tr style={{ position: "sticky", top: 0, zIndex: 30, background: "#0047AB", color: "#ffffff" }}>
                {/* Top-Left Pinned Cell (No text) */}
                <th
                  style={{
                    position: "sticky",
                    left: 0,
                    top: 0,
                    zIndex: 40,
                    background: "#0047AB",
                    color: "#ffffff",
                    padding: "10px 14px",
                    textAlign: "left",
                    fontWeight: 700,
                    fontSize: "12px",
                    width: "230px",
                    minWidth: "230px",
                    maxWidth: "230px",
                    borderRight: "2px solid rgba(255,255,255,0.25)",
                    borderBottom: "1px solid rgba(255,255,255,0.2)",
                  }}
                />

                {/* 36 Month Columns */}
                {monthCols.map((m) => {
                  return (
                    <th
                      key={m.colIdx}
                      id={`cash-header-col-${m.colIdx}`}
                      data-cash-col-idx={m.colIdx}
                      style={{
                        padding: "9px 12px",
                        textAlign: "right",
                        fontWeight: 600,
                        fontSize: "12px",
                        minWidth: "110px",
                        width: "110px",
                        background: "#0047AB",
                        borderRight: "1px solid rgba(255,255,255,0.15)",
                        borderBottom: "1px solid rgba(255,255,255,0.2)",
                        letterSpacing: "0.2px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span>{m.label}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>

            {/* ── TABLE BODY ─────────────────────────────────────────────────────── */}
            <tbody>
              {/* SECTION 1: Excluding Pipeline Header Banner */}
              <tr>
                <td
                  colSpan={monthCols.length + 1}
                  onClick={() => setTable1Open((v) => !v)}
                  style={{
                    background: "#f1f5f9",
                    padding: "8px 14px",
                    fontWeight: 800,
                    fontSize: "13px",
                    color: "#0f172a",
                    borderTop: "1px solid #cbd5e1",
                    borderBottom: "1px solid #cbd5e1",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <span style={{ marginRight: "8px", color: "#0047AB" }}>{table1Open ? "▼" : "▶"}</span>
                  <span>Excluding pipeline</span>
                  <span style={{ marginLeft: "10px", fontSize: "11px", fontWeight: 500, color: "#64748b" }}>
                    (Adjustments and actual closing balance are editable)
                  </span>
                </td>
              </tr>

              {/* Render Table 1 Rows */}
              {table1Open && (cashData.table1Rows || []).map((rowDef) => {
                if (rowDef.isSpacer) return null;
                return (
                  <CashRow
                    key={`t1_${rowDef.sheetRow}`}
                    rowDef={rowDef}
                    monthCols={monthCols}
                    matrix={matrix}
                    activeCell={activeCell}
                    editingCell={editingCell}
                    dragRange={dragRange}
                    onCellClick={(sheetRow, colIdx) => {
                      setActiveCell({ sheetRow, colIdx });
                      setEditingCell(null);
                    }}
                    onCellDoubleClick={(sheetRow, colIdx) => {
                      if (isCashCellEditable(sheetRow, colIdx)) {
                        setActiveCell({ sheetRow, colIdx });
                        setEditingCell({
                          sheetRow,
                          colIdx,
                          editValue: matrix[`${sheetRow}_${colIdx}`]?.formattedValue || "",
                        });
                      }
                    }}
                    onEditChange={(editValue) => setEditingCell((prev) => prev ? { ...prev, editValue } : null)}
                    onEditBlur={commitCellEdit}
                    onEditKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitCellEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingCell(null);
                      }
                    }}
                    onDragStart={handleDragHandleMouseDown}
                    onOpenNoteModal={openNoteModalForCell}
                  />
                );
              })}

              {/* SECTION 2: Including Pipeline Header Banner */}
              <tr>
                <td
                  colSpan={monthCols.length + 1}
                  onClick={() => setTable2Open((v) => !v)}
                  style={{
                    background: "#f1f5f9",
                    padding: "8px 14px",
                    fontWeight: 800,
                    fontSize: "13px",
                    color: "#0f172a",
                    borderTop: "2px solid #cbd5e1",
                    borderBottom: "1px solid #cbd5e1",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <span style={{ marginRight: "8px", color: "#0047AB" }}>{table2Open ? "▼" : "▶"}</span>
                  <span>Including pipeline</span>
                  <span style={{ marginLeft: "10px", fontSize: "11px", fontWeight: 500, color: "#64748b" }}>
                    (Linked dynamically to Table 1; B61, B63 and J61 overrides editable)
                  </span>
                </td>
              </tr>

              {/* Render Table 2 Rows */}
              {table2Open && (cashData.table2Rows || []).map((rowDef) => {
                if (rowDef.isSpacer) return null;
                return (
                  <CashRow
                    key={`t2_${rowDef.sheetRow}`}
                    rowDef={rowDef}
                    monthCols={monthCols}
                    matrix={matrix}
                    activeCell={activeCell}
                    editingCell={editingCell}
                    dragRange={dragRange}
                    onCellClick={(sheetRow, colIdx) => {
                      setActiveCell({ sheetRow, colIdx });
                      setEditingCell(null);
                    }}
                    onCellDoubleClick={(sheetRow, colIdx) => {
                      if (isCashCellEditable(sheetRow, colIdx)) {
                        setActiveCell({ sheetRow, colIdx });
                        setEditingCell({
                          sheetRow,
                          colIdx,
                          editValue: matrix[`${sheetRow}_${colIdx}`]?.formattedValue || "",
                        });
                      }
                    }}
                    onEditChange={(editValue) => setEditingCell((prev) => prev ? { ...prev, editValue } : null)}
                    onEditBlur={commitCellEdit}
                    onEditKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitCellEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingCell(null);
                      }
                    }}
                    onDragStart={handleDragHandleMouseDown}
                    onOpenNoteModal={openNoteModalForCell}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── CELL NOTE MODAL ────────────────────────────────────────────────────── */}
      <CellNoteModal
        isOpen={noteModal.isOpen}
        title={noteModal.title}
        subtitle={noteModal.subtitle}
        initialNote={noteModal.initialNote}
        onSave={handleSaveNote}
        onDelete={() => handleSaveNote("")}
        onClose={() => setNoteModal((prev) => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT: CashRow
// ─────────────────────────────────────────────────────────────────────────────
function CashRow({
  rowDef,
  monthCols,
  matrix,
  activeCell,
  editingCell,
  dragRange,
  onCellClick,
  onCellDoubleClick,
  onEditChange,
  onEditBlur,
  onEditKeyDown,
  onDragStart,
  onOpenNoteModal,
}) {
  const { sheetRow, label, labelBg, isBold: isRowBold } = rowDef;

  // Row Styling Variants based on accounting function
  const isNetCashRow = sheetRow === 32 || sheetRow === 74;
  const isClosingBalRow = sheetRow === 34 || sheetRow === 76;
  const isOpeningBalRow = sheetRow === 4 || sheetRow === 45;
  const isActualClosingRow = sheetRow === 36;
  const isDiffRow = sheetRow === 37;
  const isAdjustmentRow = label?.toLowerCase().includes("adjustment") || sheetRow === 29 || sheetRow === 30;

  // Background tint for special rows
  let rowBg = "#ffffff";
  if (isClosingBalRow) rowBg = "#f8fafc";
  else if (isActualClosingRow) rowBg = "#eff6ff";
  else if (isNetCashRow) rowBg = "#f8fafc";
  else if (isAdjustmentRow) rowBg = "#fcfeff";

  return (
    <tr style={{ background: rowBg }}>
      {/* Pinned Category Column A (with source sheet background shading if present) */}
      <td
        style={{
          position: "sticky",
          left: 0,
          zIndex: 10,
          background: labelBg || rowBg,
          padding: "6px 14px",
          fontWeight: isRowBold || isClosingBalRow || isNetCashRow || isOpeningBalRow || isActualClosingRow ? 700 : 500,
          fontSize: "12px",
          color: isActualClosingRow ? "#0047AB" : (isClosingBalRow ? "#0f172a" : "#334155"),
          borderRight: "2px solid #cbd5e1",
          borderBottom: isClosingBalRow ? "2px solid #94a3b8" : "1px solid #e2e8f0",
          width: "230px",
          minWidth: "230px",
          maxWidth: "230px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={label}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{label}</span>
          {isAdjustmentRow && (
            <span style={{ fontSize: "10px", color: "#64748b", background: "#f1f5f9", padding: "1px 4px", borderRadius: "3px" }}>
              adj
            </span>
          )}
        </div>
      </td>

      {/* 36 Monthly Value Cells (with source sheet background shading if present) */}
      {monthCols.map((m) => {
        const key = `${sheetRow}_${m.colIdx}`;
        const cellData = matrix[key] || {};
        const isEditable = isCashCellEditable(sheetRow, m.colIdx);
        const isActive = activeCell?.sheetRow === sheetRow && activeCell?.colIdx === m.colIdx;
        const isEditing = editingCell?.sheetRow === sheetRow && editingCell?.colIdx === m.colIdx;

        // Is this cell part of an active drag-to-fill selection?
        const isDragTarget =
          dragRange &&
          dragRange.startRow === sheetRow &&
          m.colIdx >= Math.min(dragRange.startCol, dragRange.endCol) &&
          m.colIdx <= Math.max(dragRange.startCol, dragRange.endCol);

        const val = cellData.formattedValue || "£0";
        const hasNote = Boolean(cellData.note && String(cellData.note).trim());
        const cellBg = cellData.bgColor;

        let background = rowBg;
        if (cellBg) {
          background = cellBg;
        } else if (isEditable) {
          background = "#ffffff";
        }
        if (isActive) {
          background = "#eff6ff";
        } else if (isDragTarget) {
          background = "#dbeafe";
        }

        const isBoldCell = Boolean(cellData.isBold || isRowBold || isClosingBalRow || isNetCashRow || isOpeningBalRow || isActualClosingRow);

        return (
          <td
            key={m.colIdx}
            data-cash-col-idx={m.colIdx}
            onClick={() => onCellClick(sheetRow, m.colIdx)}
            onDoubleClick={() => onCellDoubleClick(sheetRow, m.colIdx)}
            onContextMenu={(e) => {
              e.preventDefault();
              onOpenNoteModal(sheetRow, m.colIdx);
            }}
            style={{
              padding: isEditing ? "0" : "6px 10px",
              textAlign: "right",
              minWidth: "110px",
              width: "110px",
              borderRight: "1px solid #e2e8f0",
              borderBottom: isClosingBalRow ? "2px solid #94a3b8" : "1px solid #e2e8f0",
              position: "relative",
              userSelect: "none",
              cursor: isEditable ? "cell" : "default",
              fontWeight: isBoldCell ? 700 : 400,
              color: isActualClosingRow ? "#0047AB" : (val.startsWith("-") || val.startsWith("(") ? "#dc2626" : "#0f172a"),
              background,
              boxShadow: isActive
                ? "inset 0 0 0 2px #0066cc"
                : (isDragTarget ? "inset 0 0 0 1px #3b82f6" : "none"),
            }}
          >
            {/* Note Indicator Triangle */}
            <CellNoteIndicator
              note={cellData.note}
              onClick={() => onOpenNoteModal(sheetRow, m.colIdx)}
              showAddOnHover={true}
            />

            {/* In-Cell Edit Mode Input */}
            {isEditing ? (
              <input
                autoFocus
                className="cash-grid-input"
                type="text"
                value={editingCell.editValue}
                onChange={(e) => onEditChange(e.target.value)}
                onBlur={onEditBlur}
                onKeyDown={onEditKeyDown}
                style={{
                  width: "100%",
                  height: "100%",
                  padding: "5px 8px",
                  fontSize: "12px",
                  fontWeight: 600,
                  textAlign: "right",
                  border: "2px solid #0066cc",
                  borderRadius: "2px",
                  outline: "none",
                  boxSizing: "border-box",
                  background: "#ffffff",
                  fontFamily: "inherit",
                }}
              />
            ) : (
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {val === "£0" && !isEditable && !isClosingBalRow && !isNetCashRow ? "—" : val}
              </span>
            )}

            {/* Bottom-right Drag Fill Handle on Active Editable Cell */}
            {isActive && !isEditing && isEditable && (
              <div
                onMouseDown={(e) => onDragStart(e, sheetRow, m.colIdx)}
                style={{
                  position: "absolute",
                  bottom: "-3px",
                  right: "-3px",
                  width: "7px",
                  height: "7px",
                  background: "#0066cc",
                  border: "1px solid #ffffff",
                  cursor: "crosshair",
                  zIndex: 25,
                }}
                title="Drag horizontally to autofill months"
              />
            )}
          </td>
        );
      })}
    </tr>
  );
}
