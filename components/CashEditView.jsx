import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Spinner from "./Spinner";
import { CashflowSkeleton } from "./Skeleton";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useFocusRevalidate } from "../hooks/useFocusRevalidate";
import CellNoteIndicator from "./CellNoteIndicator";
import CellNoteModal from "./CellNoteModal";
import CashBankBreakdownModal from "./CashBankBreakdownModal";
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
  onSelectClient,
}) {
  const { user } = useAuth();
  const isAdmin = Boolean(!user?.isReadOnly && (user?.isAdmin || user?.role === "Admin" || user?.role === "ClientManager"));
  const isSysAdmin = Boolean(!user?.isReadOnly && (user?.isAdmin || user?.role === "Admin"));
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

  // Bank Breakdown Hover & Edit Modal State (Row 36: Actual closing balance)
  const [hoveredBreakdownCell, setHoveredBreakdownCell] = useState(null); // { colIdx, monthLabel, breakdown, rect, hasValue }
  const hoveringNoteRef = useRef(false);
  const [bankModal, setBankModal] = useState({
    isOpen: false,
    colIdx: null,
    monthKey: "",
    monthLabel: "",
    colLetter: "",
  });
  const [bankModalSaving, setBankModalSaving] = useState(false);
  const [bankModalError, setBankModalError] = useState(null);

  // Collapsible Sections
  const [table1Open, setTable1Open] = useState(true);
  const [table2Open, setTable2Open] = useState(true);

  // Currency
  const currencySymbol = cashData?.currencySymbol || "£";
  const formatMoney = useCallback((val) => universalFormatMoney(val, 0, currencySymbol, ","), [currencySymbol]);
  const formatMoney2 = useCallback((val) => universalFormatMoney(val, 2, currencySymbol, ","), [currencySymbol]);

  // Horizontal Scroll Reference for Timeline
  const scrollContainerRef = useRef(null);
  const hasAutoScrolledRef = useRef(false);

  // Synchronize client selection from managedClient or initialClient
  useEffect(() => {
    if (managedClient) {
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
      setSelectedClient(match);
      return;
    }
    if (initialClient) {
      const targetStr = typeof initialClient === "string" ? initialClient.toLowerCase() : initialClient?.clientName?.toLowerCase();
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === targetStr
      ) || (typeof initialClient === "object" ? initialClient : null);
      if (match) {
        setSelectedClient(match);
      }
    }
  }, [managedClient, initialClient, allOutgoingsClients]);

  // Back to client selector navigation handler (matches other Edit screens)
  const handleBackToClients = () => {
    if (managedClient && onClearManagedClient) {
      onClearManagedClient();
    } else {
      setSelectedClient(null);
      setCashData(null);
      onSelectClient?.(null);
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("pma_cash_client");
        const url = new URL(window.location.href);
        url.searchParams.delete("client");
        window.history.replaceState(null, "", url.toString());
      }
    }
  };

  // Fetch Cash Data (with Global Preload Cache Integration)
  const loadCashData = useCallback(async (client, bypassCache = false, silent = false) => {
    if (!client?.clientSheetId) return;
    const cleanId = cleanSheetId(client.clientSheetId);

    // 1. Check L1 Memory / Global Prefetch Cache
    if (!bypassCache && !silent) {
      const cached = getCachedClientData(cleanId, "cash");
      if (cached?.data && !cached.isStale) {
        initDataState(cached.data, false);
        return;
      }

      if (typeof getInFlightPrefetch === "function") {
        const inFlight = getInFlightPrefetch(`cash_${cleanId}`);
        if (inFlight) {
          try {
            setLoading(true);
            const d = await inFlight;
            if (d?.success) {
              initDataState(d, false);
              setLoading(false);
              return;
            }
          } catch (e) {
            console.warn("In-flight cash prefetch failed:", e);
          }
        }
      }
    }

    if (!silent) {
      setLoading(true);
      setError(null);
    }

    try {
      const url = `/api/pma/cash?clientSheetId=${encodeURIComponent(cleanId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const json = await res.json();

      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to load cash data");
      }

      if (silent && (pendingUpdatesRef.current.size > 0 || pendingNotesRef.current.size > 0)) {
        return;
      }

      setCachedClientData(cleanId, "cash", json);
      initDataState(json, silent);
    } catch (err) {
      console.error("loadCashData error:", err);
      if (!silent) setError(err.message || "Failed to load cash data");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [cleanSheetId, getCachedClientData, setCachedClientData, getInFlightPrefetch]);

  // Initialize Matrix and Rows from API payload
  const initDataState = (payload, preserveViewState = false) => {
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
            numericValue: c.numericValue ?? null,
            formula: c.formula || "",
            note: c.note || "",
            isEditable: c.isEditable,
            bgColor: c.bgColor || null,
            isBold: Boolean(c.isBold),
            bankBreakdown: c.bankBreakdown || null,
          };
        });
      });
    };

    populate(payload.table1Rows);
    populate(payload.table2Rows);

    setMatrix(newMatrix);
    if (!preserveViewState) {
      setUndoStack([]);
      setRedoStack([]);
      hasAutoScrolledRef.current = false;
    }
  };

  useEffect(() => {
    if (selectedClient?.clientSheetId) {
      loadCashData(selectedClient, false);
    }
  }, [selectedClient, loadCashData]);

  useFocusRevalidate({
    enabled: Boolean(selectedClient?.clientSheetId),
    resetKey: selectedClient?.clientSheetId || "",
    canRevalidate: () =>
      !loading &&
      saveStatus !== "saving" &&
      pendingUpdatesRef.current.size === 0 &&
      pendingNotesRef.current.size === 0 &&
      !editingCell &&
      !noteModal.isOpen &&
      !bankModal.isOpen &&
      !isDraggingRef.current,
    onRevalidate: () => {
      if (selectedClient?.clientSheetId) {
        loadCashData(selectedClient, true, true);
      }
    },
  });

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
          ...(sheetRow === 36 && value !== undefined
            ? { numericValue: parseNum(value), bankBreakdown: null }
            : {}),
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

  const openNoteModalForCell = useCallback((sheetRow, colIdx) => {
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
      subtitle: isSysAdmin ? `Cell Cash!${colLetter}${sheetRow} • ${cellData?.formattedValue || "£0"}` : (cellData?.formattedValue || "£0"),
      initialNote: cellData?.note || "",
    });
  }, [matrix, cashData, isSysAdmin]);

  const openBankBreakdownModalForCell = useCallback((colIdx) => {
    if (user?.isReadOnly) return;
    const monthCol = cashData?.monthCols?.find((m) => m.colIdx === colIdx);
    if (!monthCol?.monthKey) return;
    const cellData = matrix[`36_${colIdx}`];
    setHoveredBreakdownCell(null);
    setBankModalError(null);
    setBankModal({
      isOpen: true,
      colIdx,
      monthKey: monthCol.monthKey,
      monthLabel: monthCol.label || monthCol.monthKey,
      colLetter: cellData?.colLetter || monthCol.colLetter || colIdxToLetter(colIdx),
    });
  }, [user?.isReadOnly, cashData, matrix]);

  const handleSaveBankBreakdown = async (accounts) => {
    if (!selectedClient?.clientSheetId || !bankModal.monthKey) return;
    setBankModalSaving(true);
    setBankModalError(null);
    try {
      const res = await fetch("/api/pma/cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_bank_breakdown",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          monthKey: bankModal.monthKey,
          accounts,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to save bank balances");
      }

      const colIdx = bankModal.colIdx;
      const newFormatted = json.formattedValue || formatMoney(json.total ?? 0);
      setMatrix((prev) => {
        const key = `36_${colIdx}`;
        const existing = prev[key] || { sheetRow: 36, colIdx, colLetter: bankModal.colLetter, isEditable: true };
        const next = {
          ...prev,
          [key]: {
            ...existing,
            formattedValue: newFormatted,
            numericValue: json.numericValue ?? json.total ?? 0,
            bankBreakdown: json.bankBreakdown || null,
          },
        };
        return simulateCashFlow(next, cashData?.monthCols || []);
      });

      if (cashData) {
        const cleanId = cleanSheetId(selectedClient.clientSheetId);
        const updatedCashData = {
          ...cashData,
          table1Rows: (cashData.table1Rows || []).map((r) =>
            r.sheetRow === 36
              ? {
                  ...r,
                  cells: (r.cells || []).map((c) =>
                    c.colIdx === colIdx
                      ? {
                          ...c,
                          formattedValue: newFormatted,
                          numericValue: json.numericValue ?? json.total ?? 0,
                          bankBreakdown: json.bankBreakdown || null,
                        }
                      : c
                  ),
                }
              : r
          ),
        };
        setCashData(updatedCashData);
        setCachedClientData(cleanId, "cash", updatedCashData);
      }

      setBankModal((prev) => ({ ...prev, isOpen: false }));
      setSaveStatus("saved");
      setTimeout(() => {
        setSaveStatus((prev) => (prev === "saved" ? "idle" : prev));
      }, 2500);
    } catch (err) {
      setBankModalError(err.message || "Failed to save bank balances");
    } finally {
      setBankModalSaving(false);
    }
  };

  const handleClearBankBreakdown = async () => {
    if (!selectedClient?.clientSheetId || !bankModal.monthKey) return;
    setBankModalSaving(true);
    setBankModalError(null);
    try {
      const res = await fetch("/api/pma/cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_bank_breakdown",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          monthKey: bankModal.monthKey,
          clear: true,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to clear actual closing balance");
      }

      const colIdx = bankModal.colIdx;
      setMatrix((prev) => {
        const key = `36_${colIdx}`;
        const existing = prev[key] || { sheetRow: 36, colIdx, colLetter: bankModal.colLetter, isEditable: true };
        const next = {
          ...prev,
          [key]: {
            ...existing,
            formattedValue: "",
            numericValue: null,
            bankBreakdown: null,
          },
        };
        return simulateCashFlow(next, cashData?.monthCols || []);
      });

      if (cashData) {
        const cleanId = cleanSheetId(selectedClient.clientSheetId);
        const updatedCashData = {
          ...cashData,
          table1Rows: (cashData.table1Rows || []).map((r) =>
            r.sheetRow === 36
              ? {
                  ...r,
                  cells: (r.cells || []).map((c) =>
                    c.colIdx === colIdx
                      ? { ...c, formattedValue: "", numericValue: null, bankBreakdown: null }
                      : c
                  ),
                }
              : r
          ),
        };
        setCashData(updatedCashData);
        setCachedClientData(cleanId, "cash", updatedCashData);
      }

      setBankModal((prev) => ({ ...prev, isOpen: false }));
      setSaveStatus("saved");
      setTimeout(() => {
        setSaveStatus((prev) => (prev === "saved" ? "idle" : prev));
      }, 2500);
    } catch (err) {
      setBankModalError(err.message || "Failed to clear actual closing balance");
    } finally {
      setBankModalSaving(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // KEYBOARD NAVIGATION & SHORTCUTS (CTRL+C, CTRL+V, CTRL+Z, SHIFT+F2)
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't intercept if user is typing in a modal or non-grid input
      if (noteModal.isOpen || bankModal.isOpen) return;
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
            if (sheetRow === 36) {
              openBankBreakdownModalForCell(colIdx);
            } else {
              const curVal = matrix[`${sheetRow}_${colIdx}`]?.formattedValue || "";
              setEditingCell({ sheetRow, colIdx, editValue: curVal });
            }
          }
        } else if ((e.key === "Delete" || e.key === "Backspace") && isCashCellEditable(sheetRow, colIdx)) {
          e.preventDefault();
          applyCellChanges([{ sheetRow, colIdx, value: "0" }]);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeCell, editingCell, matrix, noteModal.isOpen, bankModal.isOpen, cashData, handleUndo, handleRedo, applyCellChanges, openNoteModalForCell, openBankBreakdownModalForCell]);

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
      <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "20px 32px 60px", boxSizing: "border-box" }}>
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
            borderRadius: "10px",
            boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)",
            border: "1px solid #e2e8f0",
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>Cash</h1>
          </div>
        </div>
        <EditClientSelector
          clients={allOutgoingsClients}
          loading={(allOutgoingsClients || []).length === 0}
          onSelectClient={(c) => {
            setCashData(null);
            setError("");
            setLoading(true);
            setSelectedClient(c);
            onSelectClient?.(c);
          }}
          title="Select a client to view and edit cashflow forecast and actuals:"
        />
      </div>
    );
  }

  const monthCols = cashData?.monthCols || [];

  return (
    <div
      className="pma-page-container"
      style={{
        width: "100%",
        maxWidth: "100%",
        margin: "0 auto",
        padding: "20px 32px 60px",
        boxSizing: "border-box",
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
            {selectedClient && (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {selectedClient.clientName}
              </div>
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
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
            title={isSysAdmin ? "Refresh from Google Sheet" : "Refresh cashflow data"}
          >
            {loading ? <><Spinner size={12} color="#334155" /> Refreshing...</> : "↻ Refresh"}
          </button>

          {/* External Google Sheets Link (Admins only) */}
          {isSysAdmin && selectedClient?.clientSheetId && (
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
          )}
        </div>
      </div>

      {/* ── LOADING / ERROR STATES ─────────────────────────────────────────────── */}
      {(loading || (!cashData && !error)) && !cashData && (
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
          onScroll={() => {
            if (hoveredBreakdownCell) setHoveredBreakdownCell(null);
          }}
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
                        if (sheetRow === 36) {
                          openBankBreakdownModalForCell(colIdx);
                        } else {
                          setEditingCell({
                            sheetRow,
                            colIdx,
                            editValue: matrix[`${sheetRow}_${colIdx}`]?.formattedValue || "",
                          });
                        }
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
                    onActualClosingHover={(e, monthObj, cellData) => {
                      if (editingCell || bankModal.isOpen || hoveringNoteRef.current) return;
                      const hasValue = Boolean(
                        (cellData?.formattedValue && String(cellData.formattedValue).trim() !== "") ||
                          (cellData?.numericValue !== null && cellData?.numericValue !== undefined)
                      );
                      if (!cellData?.bankBreakdown && !hasValue) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      setHoveredBreakdownCell({
                        colIdx: monthObj.colIdx,
                        monthLabel: monthObj.label,
                        breakdown: cellData?.bankBreakdown || null,
                        hasValue,
                        rect: {
                          top: rect.top,
                          bottom: rect.bottom,
                          left: rect.left,
                          right: rect.right,
                          width: rect.width,
                        },
                      });
                    }}
                    onActualClosingLeave={() => {
                      setHoveredBreakdownCell(null);
                    }}
                    onNoteHoverChange={(isOverNote) => {
                      hoveringNoteRef.current = isOverNote;
                      if (isOverNote) setHoveredBreakdownCell(null);
                    }}
                    readOnly={Boolean(user?.isReadOnly)}
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
                    {isSysAdmin ? "(Linked dynamically to Table 1; B61, B63 and J61 overrides editable)" : "(Linked dynamically to Table 1; balance and debtor/creditor overrides editable)"}
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
                        if (sheetRow === 36) {
                          openBankBreakdownModalForCell(colIdx);
                        } else {
                          setEditingCell({
                            sheetRow,
                            colIdx,
                            editValue: matrix[`${sheetRow}_${colIdx}`]?.formattedValue || "",
                          });
                        }
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
                    onActualClosingHover={(e, monthObj, cellData) => {
                      if (editingCell || bankModal.isOpen || hoveringNoteRef.current) return;
                      const hasValue = Boolean(
                        (cellData?.formattedValue && String(cellData.formattedValue).trim() !== "") ||
                          (cellData?.numericValue !== null && cellData?.numericValue !== undefined)
                      );
                      if (!cellData?.bankBreakdown && !hasValue) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      setHoveredBreakdownCell({
                        colIdx: monthObj.colIdx,
                        monthLabel: monthObj.label,
                        breakdown: cellData?.bankBreakdown || null,
                        hasValue,
                        rect: {
                          top: rect.top,
                          bottom: rect.bottom,
                          left: rect.left,
                          right: rect.right,
                          width: rect.width,
                        },
                      });
                    }}
                    onActualClosingLeave={() => {
                      setHoveredBreakdownCell(null);
                    }}
                    onNoteHoverChange={(isOverNote) => {
                      hoveringNoteRef.current = isOverNote;
                      if (isOverNote) setHoveredBreakdownCell(null);
                    }}
                    readOnly={Boolean(user?.isReadOnly)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── HOVER BANK BREAKDOWN TOOLTIP (ROW 36) ──────────────────────────────── */}
      {hoveredBreakdownCell && !bankModal.isOpen && typeof window !== "undefined" && (() => {
        const { rect, monthLabel, breakdown, hasValue } = hoveredBreakdownCell;
        const tooltipWidth = 290;
        const showBelow = rect.top < 220;
        const centerX = rect.left + rect.width / 2;
        const clampedLeft = Math.max(12, Math.min(window.innerWidth - tooltipWidth - 12, centerX - tooltipWidth / 2));
        const stylePos = showBelow
          ? { top: `${rect.bottom + 6}px`, left: `${clampedLeft}px` }
          : { bottom: `${window.innerHeight - rect.top + 6}px`, left: `${clampedLeft}px` };

        return (
          <div
            style={{
              position: "fixed",
              ...stylePos,
              width: `${tooltipWidth}px`,
              background: "#1e293b",
              color: "#f8fafc",
              padding: "10px 12px",
              borderRadius: "8px",
              fontSize: "12px",
              lineHeight: "1.45",
              boxShadow: "0 12px 28px -4px rgba(0, 0, 0, 0.35), 0 8px 12px -6px rgba(0, 0, 0, 0.25)",
              border: "1px solid #334155",
              zIndex: 9999,
              pointerEvents: "none",
              textAlign: "left",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
              <span style={{ fontSize: "11px", fontWeight: 700, color: "#94a3b8" }}>
                Bank balance breakdown
              </span>
              <span style={{ fontSize: "11px", fontWeight: 600, color: "#cbd5e1" }}>
                {monthLabel}
              </span>
            </div>

            {breakdown && Array.isArray(breakdown.accounts) && breakdown.accounts.length > 0 ? (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  {breakdown.accounts.map((acct, idx) => (
                    <div
                      key={`${acct.name}_${idx}`}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        gap: "10px",
                      }}
                    >
                      <span
                        style={{
                          color: "#f8fafc",
                          fontWeight: 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {acct.name}
                      </span>
                      <span
                        style={{
                          color: Number(acct.amount) < 0 ? "#fca5a5" : "#ffffff",
                          fontWeight: 600,
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatMoney2(acct.amount)}
                      </span>
                    </div>
                  ))}
                </div>

                <div
                  style={{
                    marginTop: "7px",
                    paddingTop: "6px",
                    borderTop: "1px solid #334155",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontWeight: 700,
                  }}
                >
                  <span style={{ color: "#cbd5e1" }}>Total</span>
                  <span style={{ color: Number(breakdown.total) < 0 ? "#fca5a5" : "#93c5fd", fontVariantNumeric: "tabular-nums" }}>
                    {formatMoney2(breakdown.total)}
                  </span>
                </div>

                {breakdown.matchesCell === false && (
                  <div style={{ marginTop: "6px", fontSize: "11px", color: "#fbbf24" }}>
                    Breakdown total differs from displayed balance
                  </div>
                )}

                {breakdown.labelsInferred && (
                  <div style={{ marginTop: "5px", fontSize: "11px", color: "#93c5fd" }}>
                    Account names were not recorded — double-click to confirm
                  </div>
                )}
              </>
            ) : hasValue ? (
              <div style={{ color: "#cbd5e1", fontSize: "11.5px" }}>
                No bank breakdown recorded
              </div>
            ) : null}

            {!user?.isReadOnly && (
              <div
                style={{
                  marginTop: "6px",
                  paddingTop: "5px",
                  borderTop: "1px solid #334155",
                  fontSize: "10.5px",
                  color: "#60a5fa",
                  fontWeight: 600,
                }}
              >
                {breakdown ? "Double-click to edit bank balances" : "Double-click to add bank balances"}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── BANK BALANCE BREAKDOWN MODAL ───────────────────────────────────────── */}
      <CashBankBreakdownModal
        isOpen={bankModal.isOpen}
        monthLabel={bankModal.monthLabel}
        monthKey={bankModal.monthKey}
        colLetter={bankModal.colLetter}
        isSysAdmin={isSysAdmin}
        currencySymbol={currencySymbol}
        configuredBankAccounts={cashData?.bankAccounts || []}
        initialBreakdown={bankModal.colIdx != null ? matrix[`36_${bankModal.colIdx}`]?.bankBreakdown || null : null}
        currentCellNumericValue={bankModal.colIdx != null ? matrix[`36_${bankModal.colIdx}`]?.numericValue ?? null : null}
        currentFormattedValue={bankModal.colIdx != null ? matrix[`36_${bankModal.colIdx}`]?.formattedValue || "" : ""}
        saving={bankModalSaving}
        error={bankModalError}
        onSave={handleSaveBankBreakdown}
        onClear={handleClearBankBreakdown}
        onClose={() => {
          if (!bankModalSaving) setBankModal((prev) => ({ ...prev, isOpen: false }));
        }}
      />

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
  onActualClosingHover,
  onActualClosingLeave,
  onNoteHoverChange,
  readOnly = false,
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
        const hasBreakdown = Boolean(isActualClosingRow && cellData.bankBreakdown?.accounts?.length > 0);

        return (
          <td
            key={m.colIdx}
            data-cash-col-idx={m.colIdx}
            onClick={() => onCellClick(sheetRow, m.colIdx)}
            onDoubleClick={() => onCellDoubleClick(sheetRow, m.colIdx)}
            onMouseEnter={isActualClosingRow && onActualClosingHover ? (e) => onActualClosingHover(e, m, cellData) : undefined}
            onMouseLeave={isActualClosingRow && onActualClosingLeave ? onActualClosingLeave : undefined}
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
              cursor: isActualClosingRow && !readOnly ? "pointer" : (isEditable ? "cell" : "default"),
              fontWeight: isBoldCell ? 700 : 400,
              color: isActualClosingRow ? "#0047AB" : (val.startsWith("-") || val.startsWith("(") ? "#dc2626" : "#0f172a"),
              background,
              boxShadow: isActive
                ? "inset 0 0 0 2px #0066cc"
                : (isDragTarget ? "inset 0 0 0 1px #3b82f6" : "none"),
            }}
          >
            {/* Note Indicator Triangle */}
            <div
              onMouseEnter={isActualClosingRow && onNoteHoverChange ? () => onNoteHoverChange(true) : undefined}
              onMouseLeave={isActualClosingRow && onNoteHoverChange ? () => onNoteHoverChange(false) : undefined}
              style={{ position: "absolute", top: 0, right: 0, width: "12px", height: "12px", zIndex: 3 }}
            >
              <CellNoteIndicator
                note={cellData.note}
                onClick={() => onOpenNoteModal(sheetRow, m.colIdx)}
                showAddOnHover={true}
              />
            </div>

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
              <span
                style={{
                  display: "block",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textDecoration: hasBreakdown ? "underline dotted rgba(0, 71, 171, 0.45)" : "none",
                  textUnderlineOffset: hasBreakdown ? "3px" : undefined,
                }}
              >
                {val === "£0" && !isEditable && !isClosingBalRow && !isNetCashRow ? "—" : val}
              </span>
            )}

            {/* Bottom-right Drag Fill Handle on Active Editable Cell */}
            {isActive && !isEditing && isEditable && !isActualClosingRow && (
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
