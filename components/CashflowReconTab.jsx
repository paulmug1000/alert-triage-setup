import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Spinner from "./Spinner";
import { useAuth } from "../hooks/useAuth";
import CashflowWorkbenchView from "./CashflowWorkbenchView";
import EditClientSelector from "./EditClientSelector";

const DARK_GREEN = "#14532d";
const RESOLVED_GREEN = "#d9ead3";

function parseAmount(val) {
  if (val == null || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const str = String(val).trim();
  const isParen = /^\(.*\)$/.test(str);
  const clean = str.replace(/[£,\s()]/g, "");
  const num = parseFloat(clean);
  if (isNaN(num)) return 0;
  return isParen ? -num : num;
}

function formatGBP(num) {
  if (num == null || isNaN(num)) return "£0.00";
  const sign = num < 0 ? "-" : "";
  return `${sign}£${Math.abs(num).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function CashflowReconTab({
  allOutgoingsClients = [],
  eomMonthKey = "",
  automationCommanderSheetId = "",
  initialClient = "",
  onClearInitialClient,
  onTaskMarkedDone,
  eomAllTasks = [],
  eomStatusOverrides = [],
  styles = {},
  managedClient,
  onClearManagedClient
}) {
  const { user } = useAuth();
  const isAdmin = !user?.isReadOnly && !!(user?.isAdmin || user?.role === "Admin");

  const [selectedClient, setSelectedClient] = useState(initialClient || managedClient?.clientName || "");
  const [reconData, setReconData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // View Mode: 'workbench' (Split screen two-pane) or 'matrix' (Full Cash spreadsheet grid)
  const [viewMode, setViewMode] = useState("workbench");

  // Month navigation (allows shifting target month delta from default)
  const [monthDelta, setMonthDelta] = useState(0);

  // In-place editing state for adjustment cells
  const [editingCell, setEditingCell] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Overwrite confirmation modal for "Use recon figures"
  const [overwriteModal, setOverwriteModal] = useState(null);
  const [applyingRecon, setApplyingRecon] = useState(false);

  // Match Actuals state and modal
  const [matchingActuals, setMatchingActuals] = useState(false);
  const [showMatchConfirm, setShowMatchConfirm] = useState(false);

  // Track rows where recon has been applied during this session
  const [reconAppliedRows, setReconAppliedRows] = useState(new Set());

  // Note editor modal
  const [noteModal, setNoteModal] = useState(null);
  const [generalNoteDraft, setGeneralNoteDraft] = useState("");
  const [pulseNoteDraft, setPulseNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  // Status for Reconciled & ready for automated P&L updates
  const [updatingReconStatus, setUpdatingReconStatus] = useState(false);

  const handleToggleReconciledComplete = async () => {
    const tabName = reconData?.reconTabName || reconData?.tabName;
    if (!currentClientInfo?.reconSheetId || !tabName || updatingReconStatus) return;
    const nextVal = !reconData?.isReconciledComplete;
    setUpdatingReconStatus(true);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_recon_month_ready",
          reconSheetId: currentClientInfo.reconSheetId,
          tabName,
          isComplete: nextVal,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to update status");

      setReconData(prev => prev ? ({ ...prev, isReconciledComplete: nextVal }) : prev);
      setSuccessMsg(nextVal ? "Month marked as reconciled & ready for automated P&L updates" : "Month marked as in-progress");
      setTimeout(() => setSuccessMsg(""), 3500);

      fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync_client_expense_breakdown",
          clientName: selectedClient,
          automationCommanderSheetId
        })
      }).catch(e => console.warn("Failed to trigger P&L breakdown sync:", e));
    } catch (err) {
      setError(`Failed to update reconciliation status: ${err.message}`);
      setTimeout(() => setError(""), 4000);
    } finally {
      setUpdatingReconStatus(false);
    }
  };

  // Auto-restore or sync client
  useEffect(() => {
    if (managedClient?.clientName && managedClient.clientName !== selectedClient) {
      setSelectedClient(managedClient.clientName);
    } else if (initialClient && initialClient !== selectedClient) {
      setSelectedClient(initialClient);
      if (onClearInitialClient) onClearInitialClient();
    }
  }, [initialClient, onClearInitialClient, managedClient, selectedClient]);

  const handleBackToClients = () => {
    if (managedClient && onClearManagedClient) {
      onClearManagedClient();
    } else {
      setSelectedClient("");
      setReconData(null);
      if (onClearInitialClient) onClearInitialClient();
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("pma_cashflow_recon_client");
      }
    }
  };

  const currentClientInfo = useMemo(() => {
    return (allOutgoingsClients || []).find(c => c.clientName === selectedClient) || null;
  }, [allOutgoingsClients, selectedClient]);

  // Compute effective eomMonthKey considering monthDelta
  const effectiveMonthKey = useMemo(() => {
    if (!eomMonthKey || !/^\d{4}-\d{2}$/.test(eomMonthKey)) {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }
    if (monthDelta === 0) return eomMonthKey;
    const [y, m] = eomMonthKey.split("-").map(Number);
    const shifted = new Date(y, m - 1 + monthDelta, 1);
    return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
  }, [eomMonthKey, monthDelta]);

  // Load Cashflow Recon Data
  const loadData = useCallback(async (clientNameToLoad) => {
    const targetName = clientNameToLoad || selectedClient;
    const clientObj = (allOutgoingsClients || []).find(c => c.clientName === targetName);
    if (!clientObj || !clientObj.clientSheetId) {
      setReconData(null);
      return;
    }

    setLoading(true);
    setError("");
    setSuccessMsg("");

    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_cashflow_recon_data",
          clientSheetId: clientObj.clientSheetId,
          reconSheetUrl: clientObj.reconSheetUrl,
          reconSheetId: clientObj.reconSheetId,
          eomMonthKey: effectiveMonthKey,
          automationCommanderSheetId
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to load cashflow recon data");
      }
      setReconData(data);
    } catch (err) {
      console.error("Error loading cashflow recon data:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedClient, allOutgoingsClients, effectiveMonthKey, automationCommanderSheetId]);

  useEffect(() => {
    if (selectedClient) {
      sessionStorage.setItem("pma_cashflow_recon_client", selectedClient);
      loadData(selectedClient);
    } else {
      setReconData(null);
    }
  }, [selectedClient, loadData]);

  // Target month column info
  const targetCol = useMemo(() => {
    if (!reconData?.selectedCols) return null;
    return reconData.selectedCols.find(c => c.type === "target") || reconData.selectedCols[1] || null;
  }, [reconData]);

  // Helper: check if recon figure is actively in use for a row
  const isReconUsedForRow = useCallback((row) => {
    if (!row.mappedItemType || !row.targetAdjustmentRow || !reconData?.reconActuals) return false;
    if (reconAppliedRows.has(row.targetAdjustmentRow)) return true;

    // Check destination adjustment cell formula in target month column
    const adjRowObj = reconData.rows.find(r => r.sheetRow === row.targetAdjustmentRow);
    const adjCell = adjRowObj?.cells.find(c => c.colIdx === targetCol?.colIdx);
    const raw = adjCell?.rawVal;
    if (typeof raw === "string" && (raw.startsWith("=") || /^['’]=/.test(raw))) {
      let reconVal = 0;
      if (row.mappedItemType === "confirmed_cash") reconVal = reconData.reconActuals.revenue;
      else if (row.mappedItemType === "salaries") reconVal = reconData.reconActuals.salaries;
      else if (row.mappedItemType === "dividends") reconVal = reconData.reconActuals.dividends;
      else if (row.mappedItemType === "contractors") reconVal = reconData.reconActuals.contractors;
      else if (row.mappedItemType === "direct_costs") reconVal = reconData.reconActuals.directCosts;
      else if (row.mappedItemType === "other_expenses") reconVal = reconData.reconActuals.outgoings;
      else if (row.mappedItemType === "corporation_tax") reconVal = reconData.reconActuals.corpTax;
      else if (row.mappedItemType === "vat") reconVal = reconData.reconActuals.vat;
      else if (row.mappedItemType === "non_operating_income") reconVal = reconData.reconActuals.nonOperatingIncome;
      else if (row.mappedItemType === "non_operating_expenses") reconVal = reconData.reconActuals.nonOperatingExpenses;

      const reconFixed = reconVal !== undefined ? reconVal.toFixed(2) : "";
      if (reconFixed && (raw.includes(reconFixed) || raw.replace(/^['’]/, "").includes(reconFixed))) {
        return true;
      }
    }
    return false;
  }, [reconAppliedRows, reconData, targetCol]);

  // Handle Mark Resolved Toggle
  const handleToggleResolved = async (cell) => {
    if (!reconData || !currentClientInfo) return;
    const targetState = !cell.isResolved;
    setError("");
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toggle_cash_cell_resolved",
          clientSheetId: currentClientInfo.clientSheetId,
          cashTabSheetId: reconData.cashTabSheetId,
          sheetRow: cell.sheetRow,
          colIdx: cell.colIdx,
          resolved: targetState,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to update resolved status");

      // Update local state optimistically
      setReconData(prev => {
        if (!prev) return prev;
        const newRows = prev.rows.map(r => {
          if (r.sheetRow !== cell.sheetRow) return r;
          const newCells = r.cells.map(c => {
            if (c.colIdx !== cell.colIdx) return c;
            return {
              ...c,
              isResolved: targetState,
              bg: targetState ? RESOLVED_GREEN : null
            };
          });
          return { ...r, cells: newCells };
        });
        return { ...prev, rows: newRows };
      });
      setSuccessMsg(targetState ? `Cell ${cell.colLetter}${cell.sheetRow} marked resolved.` : `Cell ${cell.colLetter}${cell.sheetRow} un-marked.`);
    } catch (err) {
      console.error("Error toggling resolved:", err);
      setError(err.message);
    }
  };

  // Open Edit Cell Modal / Input
  const handleStartEdit = (row, cell) => {
    setEditingCell({
      sheetRow: row.sheetRow,
      colIdx: cell.colIdx,
      colLetter: cell.colLetter,
      label: row.label,
      currentValue: cell.v,
      rawValue: cell.rawVal ?? cell.v
    });
    const rawStr = cell.rawVal !== null && cell.rawVal !== undefined ? String(cell.rawVal) : (cell.v || "");
    const initialVal = rawStr.replace(/^['’]=/, "=");
    setEditValue(initialVal);
  };

  // Save Adjustment Edit
  const handleSaveEdit = async () => {
    if (!editingCell || !currentClientInfo) return;
    setSavingEdit(true);
    setError("");
    try {
      const cleanVal = typeof editValue === "string" ? editValue.trim().replace(/^['’]=/, "=") : editValue;
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cash_adjustment",
          clientSheetId: currentClientInfo.clientSheetId,
          colLetter: editingCell.colLetter,
          sheetRow: editingCell.sheetRow,
          value: cleanVal,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to save adjustment");
      setEditingCell(null);
      setSuccessMsg(`Adjustment saved to Cash!${editingCell.colLetter}${editingCell.sheetRow}`);
      // Reload table to recalculate all formula cells
      await loadData(selectedClient);
    } catch (err) {
      console.error("Error saving adjustment:", err);
      setError(err.message);
    } finally {
      setSavingEdit(false);
    }
  };

  // Use Recon Figures: Calculate formula and check for overwrite
  const handleUseReconFigures = (row, targetMonthCell) => {
    if (!reconData?.reconActuals) {
      setError(reconData?.reconError ? `Cannot apply recon figures: ${reconData.reconError}` : "No recon actuals available for this month.");
      return;
    }

    const itemType = row.mappedItemType;
    const recon = reconData.reconActuals;
    const colLetter = targetMonthCell.colLetter;
    const cellRef = `${colLetter}${row.sheetRow}`;

    let reconVal = 0;
    let targetAdjustmentRow = row.targetAdjustmentRow;
    let formula = "";

    if (itemType === "confirmed_cash") {
      reconVal = recon.revenue || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 7; // Incoming cash adjustment row
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "salaries") {
      reconVal = recon.salaries || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 9; // Salaries adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "dividends") {
      reconVal = recon.dividends || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 11; // Dividends as salary adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "contractors") {
      reconVal = recon.contractors || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 13; // Contractors adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "direct_costs") {
      reconVal = recon.directCosts || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 15; // Direct costs adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "other_expenses") {
      reconVal = recon.outgoings || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 17; // Other expenses adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "corporation_tax") {
      reconVal = recon.corpTax || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 20; // Corporation tax adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "vat") {
      reconVal = recon.vat || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 22; // VAT adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "non_operating_income") {
      reconVal = recon.nonOperatingIncome || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 25; // Non-operating income adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "non_operating_expenses") {
      reconVal = recon.nonOperatingExpenses || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 27; // Non-operating expenses adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else {
      return;
    }

    // Find destination adjustment row in table data
    const adjRowObj = reconData.rows.find(r => r.sheetRow === targetAdjustmentRow);
    const adjCell = adjRowObj?.cells.find(c => c.colIdx === targetMonthCell.colIdx);
    const currentVal = adjCell?.v ?? "";
    const rawVal = adjCell?.rawVal ?? "";
    const currentFormula = (typeof rawVal === "string" && (rawVal.startsWith("=") || /^['’]=/.test(rawVal))) ? rawVal.replace(/^['’]/, "") : "";

    // Check if cell has a non-zero value or formula
    const cleanStr = String(rawVal || currentVal).replace(/[£,\s]/g, "").trim();
    const num = parseFloat(cleanStr);
    const isNonZero = cleanStr !== "" && cleanStr !== "0" && cleanStr !== "0.00" && !isNaN(num) && num !== 0;

    if (isNonZero || currentFormula) {
      // Show warning modal
      setOverwriteModal({
        mappedItem: row.label,
        formula,
        targetRow: targetAdjustmentRow,
        colLetter,
        currentValue: currentVal,
        currentFormula,
        adjRowLabel: adjRowObj?.label || `Row ${targetAdjustmentRow}`
      });
    } else {
      // Overwrite safe: apply immediately
      executeApplyReconFormula(targetAdjustmentRow, colLetter, formula);
    }
  };

  // Match Actuals: Applies recon figures and marks resolved across all mapped elements in target month
  const executeMatchAllActuals = async () => {
    if (!reconData?.reconActuals || !targetCol || !currentClientInfo) {
      setError("Cannot match actuals: target month reconciliation actuals are not available.");
      return;
    }

    setMatchingActuals(true);
    setError("");
    setShowMatchConfirm(false);

    try {
      const recon = reconData.reconActuals;
      const colLetter = targetCol.colLetter;
      const adjustments = [];
      const resolvedRows = [];

      // Mapped items
      const mappedRows = (reconData.rows || []).filter(r => r.mappedItemType && !r.isAdjustmentRow);

      mappedRows.forEach(row => {
        const itemType = row.mappedItemType;
        const cellRef = `${colLetter}${row.sheetRow}`;
        let reconVal = null;
        let targetRow = row.targetAdjustmentRow;

        if (itemType === "confirmed_cash") {
          reconVal = recon.revenue || 0;
        } else if (itemType === "salaries") {
          reconVal = recon.salaries || 0;
        } else if (itemType === "dividends") {
          reconVal = recon.dividends || 0;
        } else if (itemType === "contractors") {
          reconVal = recon.contractors || 0;
        } else if (itemType === "direct_costs") {
          reconVal = recon.directCosts || 0;
        } else if (itemType === "other_expenses") {
          reconVal = recon.outgoings || 0;
        } else if (itemType === "corporation_tax") {
          reconVal = recon.corpTax || 0;
        } else if (itemType === "vat") {
          reconVal = recon.vat || 0;
        } else if (itemType === "non_operating_income") {
          reconVal = recon.nonOperatingIncome || 0;
        } else if (itemType === "non_operating_expenses") {
          reconVal = recon.nonOperatingExpenses || 0;
        }

        if (reconVal !== null && targetRow) {
          adjustments.push({
            sheetRow: targetRow,
            formula: `=${reconVal.toFixed(2)}-${cellRef}`
          });
          resolvedRows.push(row.sheetRow);
        }
      });

      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "batch_match_cashflow_actuals",
          clientSheetId: currentClientInfo.clientSheetId,
          cashTabSheetId: reconData.cashTabSheetId,
          colIdx: targetCol.colIdx,
          colLetter,
          adjustments,
          resolvedRows,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });

      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to match actuals");

      adjustments.forEach(a => setReconAppliedRows(prev => new Set([...prev, a.sheetRow])));
      setSuccessMsg(`Matched actuals applied and resolved for ${adjustments.length} cashflow items in ${reconData.targetMonthLabel || "target month"}.`);
      await loadData(selectedClient);
    } catch (err) {
      console.error("Error matching actuals:", err);
      setError(err.message);
    } finally {
      setMatchingActuals(false);
    }
  };

  const executeApplyReconFormula = async (targetRow, colLetter, formula) => {
    if (!currentClientInfo) return;
    setApplyingRecon(true);
    setError("");
    try {
      const cleanFormula = typeof formula === "string" ? formula.trim().replace(/^['’]=/, "=") : formula;
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cash_adjustment",
          clientSheetId: currentClientInfo.clientSheetId,
          colLetter,
          sheetRow: targetRow,
          value: cleanFormula,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to apply recon formula");
      setReconAppliedRows(prev => new Set([...prev, targetRow]));
      setOverwriteModal(null);
      setSuccessMsg(`Applied formula ${cleanFormula} to Cash!${colLetter}${targetRow}`);
      // Reload table to recalculate all rows
      await loadData(selectedClient);
    } catch (err) {
      console.error("Error applying recon formula:", err);
      setError(err.message);
    } finally {
      setApplyingRecon(false);
    }
  };

  // Cell Note Editor
  const handleOpenNote = (row, cell) => {
    const rawNote = cell.note || "";
    const match = rawNote.match(/\[Note:\s*([^\]]+)\]/i);
    let pulseDraft = "";
    let generalDraft = rawNote;
    if (match) {
      pulseDraft = match[1].trim();
      generalDraft = rawNote.replace(match[0], "").replace(/\n\s*\n/g, "\n").trim();
    }

    setGeneralNoteDraft(generalDraft);
    setPulseNoteDraft(pulseDraft);
    setNoteModal({
      sheetRow: row.sheetRow,
      colIdx: cell.colIdx,
      colLetter: cell.colLetter,
      label: row.label,
      currentNote: rawNote,
      isAdjustmentRow: Boolean(row.isAdjustmentRow || (row.label && row.label.toLowerCase().includes("adjustment")))
    });
  };

  const handleSaveNote = async () => {
    if (!noteModal || !currentClientInfo || !reconData) return;
    setSavingNote(true);
    setError("");

    const g = generalNoteDraft.trim();
    const p = pulseNoteDraft.trim();
    let finalNote = "";
    if (g && p) {
      finalNote = `${g}\n[Note: ${p}]`;
    } else if (p) {
      finalNote = `[Note: ${p}]`;
    } else if (g) {
      finalNote = g;
    } else {
      finalNote = "";
    }

    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cash_cell_note",
          clientSheetId: currentClientInfo.clientSheetId,
          cashTabSheetId: reconData.cashTabSheetId,
          sheetRow: noteModal.sheetRow,
          colIdx: noteModal.colIdx,
          note: finalNote,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to save note");

      // Update local state optimistically
      setReconData(prev => {
        if (!prev) return prev;
        const newRows = prev.rows.map(r => {
          if (r.sheetRow !== noteModal.sheetRow) return r;
          const newCells = r.cells.map(c => {
            if (c.colIdx !== noteModal.colIdx) return c;
            return { ...c, note: finalNote };
          });
          return { ...r, cells: newCells };
        });
        return { ...prev, rows: newRows };
      });

      setNoteModal(null);
      setSuccessMsg(`Note updated on Cash!${noteModal.colLetter}${noteModal.sheetRow}`);
    } catch (err) {
      console.error("Error saving note:", err);
      setError(err.message);
    } finally {
      setSavingNote(false);
    }
  };

  // Find linked shared task if any
  const linkedTask = useMemo(() => {
    return (eomAllTasks || []).find(t =>
      t.clientName === selectedClient &&
      (t.linkedFunction === "cashflow_recon" ||
        (t.name && t.name.toLowerCase().includes("reconcile cashflow forecast against actual")))
    );
  }, [eomAllTasks, selectedClient]);

  // Check if linked task is already marked done
  const isLinkedTaskDone = useMemo(() => {
    if (!linkedTask) return false;
    return (eomStatusOverrides || []).find(s => s.clientName === selectedClient && s.taskId === linkedTask.taskId)?.status === "done";
  }, [eomStatusOverrides, selectedClient, linkedTask]);

  const handleShiftMonth = (delta) => {
    setReconData(null);
    setLoading(true);
    setMonthDelta(d => d + delta);
  };

  const handleResetMonth = () => {
    setReconData(null);
    setLoading(true);
    setMonthDelta(0);
  };

  // Grouped Elements for Cashflow finalisation (Cash table)
  const groupedElements = useMemo(() => {
    if (!reconData?.rows) return [];
    const rows = reconData.rows.filter(r => !r.isHeaderRow && !r.label.toLowerCase().includes("excluding pipeline"));

    const elements = [];
    const visitedRowNums = new Set();

    rows.forEach(row => {
      if (visitedRowNums.has(row.sheetRow)) return;

      const lower = row.label.toLowerCase().trim();
      if (!lower) return; // skip empty spacing rows

      // Check if mapped base row with adjustment row
      if (row.mappedItemType && row.targetAdjustmentRow && row.targetAdjustmentRow !== row.sheetRow) {
        const adjRow = rows.find(r => r.sheetRow === row.targetAdjustmentRow);
        if (adjRow) {
          visitedRowNums.add(row.sheetRow);
          visitedRowNums.add(adjRow.sheetRow);
          elements.push({
            id: `elem_${row.sheetRow}`,
            type: "compound",
            title: row.label.replace(/\s*(outgoing|incoming)\s*/i, "").trim(),
            baseRow: row,
            adjRow: adjRow,
            mappedItemType: row.mappedItemType
          });
          return;
        }
      }

      // Check if adjustment row
      if (row.isAdjustmentRow) {
        visitedRowNums.add(row.sheetRow);
        elements.push({
          id: `elem_${row.sheetRow}`,
          type: "single",
          title: row.label,
          row: row,
          isAdjustment: true
        });
        return;
      }

      // Standalone row (Opening balance, Difference, Net cash movement, etc.)
      visitedRowNums.add(row.sheetRow);
      elements.push({
        id: `elem_${row.sheetRow}`,
        type: "single",
        title: row.label,
        row: row,
        mappedItemType: row.mappedItemType,
        isSummary: row.isDifferenceRow || lower.includes("closing") || lower.includes("net cash movement") || lower.includes("opening balance"),
        isDifference: row.isDifferenceRow
      });
    });

    return elements;
  }, [reconData]);

  // Helper: retrieves transaction amount for a given category from recon actuals
  const getCategoryTxAmount = useCallback((itemType, rowLabel = "") => {
    if (!reconData?.reconActuals) return null;
    const recon = reconData.reconActuals;
    if (itemType === "confirmed_cash") return recon.revenue ?? 0;
    if (itemType === "salaries") return recon.salaries ?? 0;
    if (itemType === "dividends") return recon.dividends ?? 0;
    if (itemType === "contractors") return recon.contractors ?? 0;
    if (itemType === "direct_costs") return recon.directCosts ?? 0;
    if (itemType === "other_expenses") return recon.outgoings ?? 0;
    if (itemType === "corporation_tax") return recon.corpTax ?? 0;
    if (itemType === "vat") return recon.vat ?? 0;
    if (itemType === "non_operating_income") return recon.nonOperatingIncome ?? 0;
    if (itemType === "non_operating_expenses") return recon.nonOperatingExpenses ?? 0;

    // Fallback based on label text if mappedItemType was not set
    const l = (rowLabel || "").toLowerCase();
    if (l.includes("revenue") || l.includes("confirmed cash") || l.includes("incoming cash")) return recon.revenue ?? 0;
    if (l.includes("salar") || l.includes("payroll") || l.includes("paye") || l.includes("pension")) return recon.salaries ?? 0;
    if (l.includes("dividend")) return recon.dividends ?? 0;
    if (l.includes("contractor")) return recon.contractors ?? 0;
    if (l.includes("direct cost")) return recon.directCosts ?? 0;
    if (l.includes("other expense") || l.includes("outgoing") || l.includes("overhead")) return recon.outgoings ?? 0;
    if (l.includes("corp")) return recon.corpTax ?? 0;
    if (l.includes("vat")) return recon.vat ?? 0;
    if (l.includes("non-operating income")) return recon.nonOperatingIncome ?? 0;
    if (l.includes("non-operating expense")) return recon.nonOperatingExpenses ?? 0;

    return null;
  }, [reconData]);

  // Dynamic grid column coordinates for modern card view
  const { gridTemplateColumns, colPositions, totalColPosition, txColPosition, spacerBeforeTarget, spacerAfterTarget } = useMemo(() => {
    if (!reconData?.selectedCols || reconData.selectedCols.length === 0) {
      return {
        gridTemplateColumns: "175px 150px 16px 215px 120px 130px 16px 150px",
        colPositions: [2, 4, 8],
        totalColPosition: 5,
        txColPosition: 6,
        spacerBeforeTarget: 3,
        spacerAfterTarget: 7
      };
    }

    const parts = ["175px"];
    const positions = [];
    let currentGridCol = 2;
    let totalPos = null;
    let txPos = null;
    let spacerBefore = null;
    let spacerAfter = null;

    reconData.selectedCols.forEach((col, idx) => {
      if (col.type === "target") {
        if (idx > 0) {
          parts.push("16px"); // blank space between previous month and target month
          spacerBefore = currentGridCol;
          currentGridCol++;
        }
        positions.push(currentGridCol); // Target month column
        parts.push("215px"); // Target month column (~26% wider than original for button room)
        currentGridCol++;
        totalPos = currentGridCol;
        parts.push("120px"); // Total (Net)
        currentGridCol++;
        txPos = currentGridCol;
        parts.push("130px"); // Transaction amount
        currentGridCol++;
        if (idx < reconData.selectedCols.length - 1) {
          parts.push("16px"); // blank space between transaction amount and next month
          spacerAfter = currentGridCol;
          currentGridCol++;
        }
      } else {
        positions.push(currentGridCol);
        parts.push("150px"); // 150px provides ample room so note buttons never spill out
        currentGridCol++;
      }
    });

    return {
      gridTemplateColumns: parts.join(" "),
      colPositions: positions,
      totalColPosition: totalPos,
      txColPosition: txPos,
      spacerBeforeTarget: spacerBefore,
      spacerAfterTarget: spacerAfter
    };
  }, [reconData?.selectedCols]);

  // Reusable note trigger: amber 📝 if cell has note, subtle 💬 on hover if empty
  const renderNoteButton = (row, cell) => {
    if (!row || !cell) return null;
    const hasNote = !!cell.note;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleOpenNote(row, cell);
        }}
        title={hasNote ? `Note: ${cell.note}` : "Add cell note"}
        style={{
          background: hasNote ? "#fef3c7" : "transparent",
          border: hasNote ? "1px solid #fde68a" : "none",
          borderRadius: "4px",
          cursor: "pointer",
          padding: hasNote ? "1px 4px" : "1px 2px",
          fontSize: "11px",
          color: hasNote ? "#b45309" : "#cbd5e1",
          display: "inline-flex",
          alignItems: "center",
          gap: "2px",
          lineHeight: 1,
          flexShrink: 0,
          opacity: hasNote ? 1 : 0.4,
          transition: "color 0.15s, background 0.15s, opacity 0.15s"
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = "1";
          if (!hasNote) e.currentTarget.style.color = "#d97706";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = hasNote ? "1" : "0.4";
          if (!hasNote) e.currentTarget.style.color = "#cbd5e1";
        }}
      >
        {hasNote ? "📝" : "💬"}
      </button>
    );
  };

  return (
    <div style={{ width: "100%", maxWidth: "100%" }}>
      {/* Top Header Card */}
      {/* Header card with title & client switcher */}
      <div style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "8px",
        padding: "16px 20px",
        marginBottom: "16px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
      }}>
        {/* Title row */}
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
            <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#1e293b", display: "flex", alignItems: "center", gap: "8px" }}>
              <span>Cashflow recon</span>
            </h1>
            {selectedClient ? (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {selectedClient}
              </div>
            ) : (
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                Select a client to reconcile cashflow
              </p>
            )}
          </div>
        </div>

        {/* Selected Client Toolbar & Month Controls */}
        {selectedClient && (
          <div style={{
            marginTop: "14px",
            paddingTop: "14px",
            borderTop: "1px solid #f1f5f9",
            display: "flex",
            flexDirection: "column",
            gap: "12px"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
              {/* Left: Month pill + Month arrows */}
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                {/* Target Month pill */}
                {reconData?.targetMonthLabel && (
                  <span style={{
                    fontSize: "15px",
                    fontWeight: "700",
                    background: "#f1f5f9",
                    color: "#1e293b",
                    border: "1px solid #e2e8f0",
                    padding: "4px 12px",
                    borderRadius: "8px"
                  }}>
                    {reconData.targetMonthLabel}
                  </span>
                )}

                {/* Month selector arrows (without Reset button) */}
                <div style={{ display: "flex", alignItems: "center", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "2px 4px", gap: "2px" }}>
                  <button
                    onClick={() => handleShiftMonth(-1)}
                    title="Previous month"
                    style={{ padding: "4px 8px", background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "#475569" }}
                  >
                    ◀
                  </button>
                  <button
                    onClick={() => handleShiftMonth(1)}
                    title="Next month"
                    style={{ padding: "4px 8px", background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "#475569" }}
                  >
                    ▶
                  </button>
                </div>
              </div>

              {/* Right: Reconciled & ready toggle, EoM task complete button and Sheet links */}
              <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                {reconData && (
                  <label style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    cursor: updatingReconStatus ? "wait" : "pointer",
                    userSelect: "none",
                    padding: "5px 10px",
                    borderRadius: "6px",
                    background: reconData?.isReconciledComplete ? "#f0fdf4" : "#f8fafc",
                    border: `1px solid ${reconData?.isReconciledComplete ? "#86efac" : "#cbd5e1"}`
                  }}>
                    <input
                      type="checkbox"
                      checked={Boolean(reconData?.isReconciledComplete)}
                      disabled={updatingReconStatus}
                      onChange={handleToggleReconciledComplete}
                      style={{ width: "14px", height: "14px", cursor: "pointer", accentColor: "#15803d" }}
                    />
                    <span style={{
                      fontSize: "12px",
                      fontWeight: "600",
                      color: reconData?.isReconciledComplete ? "#15803d" : "#475569"
                    }}>
                      Reconciled & ready for automated P&L updates
                    </span>
                    {updatingReconStatus && <Spinner size={11} />}
                  </label>
                )}

                {linkedTask && onTaskMarkedDone && (
                  <button
                    onClick={() => onTaskMarkedDone(selectedClient, linkedTask.taskId)}
                    style={{
                      padding: "6px 12px",
                      background: isLinkedTaskDone ? "#f0fdf4" : "#f1f5f9",
                      border: isLinkedTaskDone ? "1px solid #86efac" : "1px solid #cbd5e1",
                      color: isLinkedTaskDone ? "#166534" : "#475569",
                      borderRadius: "6px",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {isLinkedTaskDone ? "✓ EoM task marked complete" : "Mark EoM task complete"}
                  </button>
                )}

                {isAdmin && currentClientInfo?.clientSheetId && (
                  <a
                    href={`https://docs.google.com/spreadsheets/d/${currentClientInfo.clientSheetId}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: "12px", color: "#0284c7", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: "600" }}
                  >
                    Client sheet ↗
                  </a>
                )}

                {isAdmin && currentClientInfo?.reconSheetId && (
                  <a
                    href={`https://docs.google.com/spreadsheets/d/${currentClientInfo.reconSheetId}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: "12px", color: "#0284c7", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: "600" }}
                  >
                    Recon sheet ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Dedicated Tabs: Transaction Recon / Cashflow Finalisation (styled like By month / By job tabs on Contractors screen) */}
      {selectedClient && reconData && (
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px", borderBottom: "1px solid #e0e0e0" }}>
          <button
            onClick={() => setViewMode("workbench")}
            title="Transaction recon: Bank transactions alongside breakdowns and P&L additions"
            style={{
              padding: "8px 16px",
              background: "none",
              border: "none",
              borderBottom: viewMode === "workbench" ? "2px solid #0066cc" : "2px solid transparent",
              color: viewMode === "workbench" ? "#0066cc" : "#666666",
              fontWeight: viewMode === "workbench" ? "700" : "500",
              fontSize: "14px",
              cursor: "pointer"
            }}
          >
            Transaction recon
          </button>
          <button
            onClick={() => setViewMode("matrix")}
            title="Cashflow finalisation: Client cashflow forecast and variance resolution"
            style={{
              padding: "8px 16px",
              background: "none",
              border: "none",
              borderBottom: viewMode === "matrix" ? "2px solid #0066cc" : "2px solid transparent",
              color: viewMode === "matrix" ? "#0066cc" : "#666666",
              fontWeight: viewMode === "matrix" ? "700" : "500",
              fontSize: "14px",
              cursor: "pointer"
            }}
          >
            Cashflow finalisation
          </button>
        </div>
      )}

      {/* Messages / Alerts */}
      {error && (
        <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", color: "#b91c1c", fontSize: "13px", marginBottom: "14px" }}>
          ⚠️ {error}
        </div>
      )}
      {successMsg && (
        <div style={{ padding: "10px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", color: "#15803d", fontSize: "13px", marginBottom: "14px" }}>
          ✓ {successMsg}
        </div>
      )}

      {/* Main Content Area */}
      {!selectedClient ? (
        <EditClientSelector
          clients={allOutgoingsClients || []}
          onSelectClient={(c) => {
            const name = c.clientName || c.name || c;
            setSelectedClient(name);
          }}
          loading={loading}
          title="Select a client to reconcile cashflow:"
        />
      ) : (loading || !reconData) ? (
        <div style={{ textAlign: "center", padding: "80px 20px", background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0" }}>
          <Spinner size={32} />
          <p style={{ fontSize: "14px", fontWeight: "600", color: "#1e293b", marginTop: "14px", marginBottom: "4px" }}>
            Loading cashflow recon data...
          </p>
          <p style={{ fontSize: "12px", color: "#64748b", margin: 0 }}>
            Retrieving figures for the selected month.
          </p>
        </div>
      ) : viewMode === "workbench" ? (
        <CashflowWorkbenchView
          reconData={reconData}
          selectedClient={selectedClient}
          clientInfo={currentClientInfo}
          eomMonthKey={eomMonthKey}
          effectiveMonthKey={effectiveMonthKey}
          automationCommanderSheetId={automationCommanderSheetId}
          onRefresh={() => loadData(selectedClient)}
          onTabCreated={(tab) => {
            setReconData(prev => prev ? ({ ...prev, hasTargetTab: true, reconError: null }) : prev);
            loadData(selectedClient);
          }}
          isAdmin={isAdmin}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", width: "fit-content", maxWidth: "100%" }}>
          {/* Cashflow Finalisation Toolbar: Match Actuals + Legend */}
          <div style={{
            padding: "10px 16px",
            background: "#ffffff",
            borderRadius: "10px",
            border: "1px solid #cbd5e1",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "10px",
            boxShadow: "0 1px 2px rgba(0,0,0,0.03)"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <button
                onClick={() => setShowMatchConfirm(true)}
                disabled={matchingActuals || !reconData?.reconActuals}
                title="Applies reconciliation figures to adjustments and marks all target month items resolved"
                style={{
                  padding: "7px 16px",
                  background: "#15803d",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: "700",
                  cursor: matchingActuals || !reconData?.reconActuals ? "default" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.06)"
                }}
              >
                {matchingActuals ? <Spinner size={12} /> : "⚡"} Match actuals
              </button>
              <span style={{ fontSize: "12px", color: "#64748b" }}>
                Applies bank recon figures and resolves all target month cash items
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "11px", color: "#64748b", flexWrap: "wrap" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "10px", height: "10px", background: "#dcfce7", border: "1px solid #86efac", borderRadius: "2px", display: "inline-block" }}></span>
                Matched transaction
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "10px", height: "10px", background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: "2px", display: "inline-block" }}></span>
                Variance
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "10px", height: "10px", background: RESOLVED_GREEN, border: "1px solid #86efac", borderRadius: "2px", display: "inline-block" }}></span>
                Resolved actual
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "10px", height: "10px", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "2px", display: "inline-block" }}></span>
                Editable adjustment
              </span>
            </div>
          </div>

          {/* Overhauled Modern Cashflow Finalisation: Grouped Category Cards with Dedicated Total Column */}
          <div style={{ width: "fit-content", maxWidth: "100%" }}>
            <div style={{ overflowX: "auto", paddingBottom: "12px" }}>
              <div style={{ minWidth: "972px", width: "fit-content" }}>
                {/* 1. Header Bar: Segmented with clear blank space around Target Month */}
                <div style={{
                  display: "grid",
                  gridTemplateColumns: gridTemplateColumns,
                  alignItems: "stretch",
                  background: "transparent",
                  color: "#ffffff",
                  fontSize: "12px",
                  fontWeight: "700",
                  marginBottom: "10px"
                }}>
                  <div style={{
                    padding: "10px 14px",
                    gridColumn: "1",
                    background: DARK_GREEN,
                    borderTopLeftRadius: "10px",
                    borderBottomLeftRadius: "10px",
                    display: "flex",
                    alignItems: "center"
                  }}>
                    Cash movement
                  </div>

                  {reconData.selectedCols.map((col, cIndex) => {
                    const isTarget = col.type === "target";
                    const gridCol = colPositions[cIndex];
                    const isPrev = cIndex === 0 || col.type === "prev";
                    const isLast = cIndex === reconData.selectedCols.length - 1;

                    return (
                      <React.Fragment key={col.colIdx}>
                        <div
                          style={{
                            gridColumn: `${gridCol}`,
                            padding: "10px 10px",
                            textAlign: "right",
                            background: isTarget ? "#15803d" : DARK_GREEN,
                            borderTopLeftRadius: isTarget ? "10px" : (!isPrev && !isTarget ? "10px" : "0"),
                            borderBottomLeftRadius: isTarget ? "10px" : (!isPrev && !isTarget ? "10px" : "0"),
                            borderTopRightRadius: isPrev && !isTarget ? "10px" : (isLast ? "10px" : "0"),
                            borderBottomRightRadius: isPrev && !isTarget ? "10px" : (isLast ? "10px" : "0"),
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "flex-end",
                            gap: "6px"
                          }}
                        >
                          <span>{col.label}</span>
                          {isTarget && (
                            <span style={{
                              fontSize: "9px",
                              padding: "1px 5px",
                              background: "#ffffff",
                              color: "#15803d",
                              borderRadius: "4px",
                              fontWeight: "800",
                              textTransform: "uppercase"
                            }}>
                              Target
                            </span>
                          )}
                        </div>

                        {isTarget && (
                          <>
                            <div
                              style={{
                                gridColumn: `${totalColPosition}`,
                                padding: "10px 10px",
                                textAlign: "center",
                                background: "#15803d",
                                borderLeft: "1px solid rgba(255, 255, 255, 0.2)",
                                fontWeight: "700",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center"
                              }}
                            >
                              Total (Net)
                            </div>
                            <div
                              style={{
                                gridColumn: `${txColPosition}`,
                                padding: "10px 10px",
                                textAlign: "center",
                                background: "#15803d",
                                borderLeft: "1px solid rgba(255, 255, 255, 0.2)",
                                borderTopRightRadius: "10px",
                                borderBottomRightRadius: "10px",
                                fontWeight: "700",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center"
                              }}
                            >
                              Transaction amount
                            </div>
                          </>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>

                {/* 2. Operational Movement Cards (with 8px gap between categories) */}
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {groupedElements.filter(e => !e.isSummary).map((elem) => {
                    if (elem.type === "compound") {
                      return (
                        <div
                          key={elem.id}
                          style={{
                            display: "grid",
                            gridTemplateColumns: gridTemplateColumns,
                            gridTemplateRows: "auto auto",
                            background: "#ffffff",
                            border: "1px solid #e2e8f0",
                            borderRadius: "10px",
                            boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
                            overflow: "hidden",
                            transition: "box-shadow 0.15s, border-color 0.15s"
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = "#cbd5e1";
                            e.currentTarget.style.boxShadow = "0 3px 6px -1px rgba(15, 23, 42, 0.07)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = "#e2e8f0";
                            e.currentTarget.style.boxShadow = "0 1px 2px rgba(15, 23, 42, 0.04)";
                          }}
                        >
                          {/* Row 1: Forecast Category Title */}
                          <div
                            style={{
                              gridColumn: "1",
                              gridRow: "1",
                              padding: "8px 14px",
                              fontWeight: "700",
                              fontSize: "13px",
                              color: "#0f172a",
                              borderBottom: "1px dashed #f1f5f9",
                              display: "flex",
                              alignItems: "center"
                            }}
                          >
                            <span>{elem.title}</span>
                          </div>

                          {/* Spacers before/after Target Month */}
                          {spacerBeforeTarget && (
                            <div
                              style={{
                                gridColumn: `${spacerBeforeTarget}`,
                                gridRow: "1 / span 2",
                                background: "#f8fafc",
                                borderLeft: "1px solid #e2e8f0",
                                borderRight: "1px solid #e2e8f0"
                              }}
                            />
                          )}
                          {spacerAfterTarget && (
                            <div
                              style={{
                                gridColumn: `${spacerAfterTarget}`,
                                gridRow: "1 / span 2",
                                background: "#f8fafc",
                                borderLeft: "1px solid #e2e8f0",
                                borderRight: "1px solid #e2e8f0"
                              }}
                            />
                          )}

                          {/* Row 1: Forecast Month Columns */}
                          {reconData.selectedCols.map((col, cIndex) => {
                            const isTargetCol = col.type === "target";
                            const gridCol = colPositions[cIndex];
                            const baseCell = elem.baseRow.cells[cIndex];
                            const adjCell = elem.adjRow?.cells[cIndex];
                            const baseVal = (baseCell?.numVal !== undefined && baseCell?.numVal !== null) ? baseCell.numVal : parseAmount(baseCell?.v);
                            const adjVal = (adjCell?.numVal !== undefined && adjCell?.numVal !== null) ? adjCell.numVal : parseAmount(adjCell?.v);
                            const totalVal = baseVal + adjVal;
                            const totalFmt = formatGBP(totalVal);
                            let cellBg = baseCell?.isResolved ? RESOLVED_GREEN : (isTargetCol ? "#f8fafc" : "#ffffff");

                            return (
                              <React.Fragment key={col.colIdx}>
                                <div
                                  style={{
                                    gridColumn: `${gridCol}`,
                                    gridRow: "1",
                                    padding: "8px 10px",
                                    background: cellBg,
                                    borderBottom: "1px dashed #f1f5f9",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: isTargetCol ? "space-between" : "flex-end",
                                    gap: "6px"
                                  }}
                                >
                                  {isTargetCol ? (
                                    <>
                                      <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                                        {renderNoteButton(elem.baseRow, baseCell)}
                                        <button
                                          onClick={() => handleToggleResolved(baseCell)}
                                          title={baseCell?.isResolved ? "Un-mark resolved" : "Mark resolved"}
                                          style={{
                                            padding: "2px 7px",
                                            borderRadius: "4px",
                                            border: baseCell?.isResolved ? "1px solid #86efac" : "1px solid #cbd5e1",
                                            background: baseCell?.isResolved ? "#dcfce7" : "#ffffff",
                                            color: baseCell?.isResolved ? "#166534" : "#475569",
                                            fontSize: "9px",
                                            fontWeight: "700",
                                            textTransform: "uppercase",
                                            cursor: "pointer",
                                            flexShrink: 0
                                          }}
                                        >
                                          {baseCell?.isResolved ? "Resolved" : "Resolve"}
                                        </button>
                                      </div>
                                      <span
                                        style={{
                                          display: "inline-block",
                                          minWidth: "80px",
                                          textAlign: "right",
                                          padding: "3px 8px",
                                          border: "1px solid transparent",
                                          boxSizing: "border-box",
                                          fontWeight: "700",
                                          fontVariantNumeric: "tabular-nums",
                                          color: "#0f172a",
                                          fontSize: "12px",
                                          whiteSpace: "nowrap"
                                        }}
                                      >
                                        {baseCell?.v || "£0.00"}
                                      </span>
                                    </>
                                  ) : (
                                    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                                      {renderNoteButton(elem.baseRow, baseCell)}
                                      <span
                                        style={{
                                          display: "inline-block",
                                          minWidth: "80px",
                                          textAlign: "right",
                                          padding: "3px 8px",
                                          border: "1px solid transparent",
                                          boxSizing: "border-box",
                                          fontVariantNumeric: "tabular-nums",
                                          color: "#334155",
                                          fontSize: "12px",
                                          whiteSpace: "nowrap"
                                        }}
                                      >
                                        {baseCell?.v || "£0.00"}
                                      </span>
                                    </div>
                                  )}
                                </div>

                                {/* Spanning Net Total Column (Unshaded) */}
                                {isTargetCol && (
                                  <div
                                    style={{
                                      gridColumn: `${totalColPosition}`,
                                      gridRow: "1 / span 2",
                                      padding: "6px 10px",
                                      background: "#f8fafc",
                                      borderLeft: "1px solid #e2e8f0",
                                      borderRight: "1px solid #e2e8f0",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center"
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: "12px",
                                        fontWeight: "700",
                                        fontVariantNumeric: "tabular-nums",
                                        color: "#0f172a",
                                        display: "inline-block"
                                      }}
                                      title={`Forecast: ${baseCell?.v || "£0.00"} + Adjustment: ${adjCell?.v || "£0.00"} = Net: ${totalFmt}`}
                                    >
                                      {totalFmt}
                                    </span>
                                  </div>
                                )}

                                {/* Spanning Transaction Amount Column */}
                                {isTargetCol && (() => {
                                  const txVal = getCategoryTxAmount(elem.mappedItemType, elem.title);
                                  const isAvailable = txVal !== null && txVal !== undefined;
                                  const isMatch = isAvailable && (
                                    Math.abs(totalVal - txVal) < 0.05 ||
                                    (Math.sign(totalVal) !== Math.sign(txVal) && Math.abs(Math.abs(totalVal) - Math.abs(txVal)) < 0.05)
                                  );
                                  return (
                                    <div
                                      style={{
                                        gridColumn: `${txColPosition}`,
                                        gridRow: "1 / span 2",
                                        padding: "6px 10px",
                                        background: "#f8fafc",
                                        borderRight: "1px solid #e2e8f0",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center"
                                      }}
                                    >
                                      {isAvailable ? (
                                        <span
                                          style={{
                                            padding: "4px 10px",
                                            borderRadius: "14px",
                                            fontSize: "11px",
                                            fontWeight: "700",
                                            fontVariantNumeric: "tabular-nums",
                                            background: isMatch ? "#dcfce7" : "#fee2e2",
                                            color: isMatch ? "#166534" : "#991b1b",
                                            border: isMatch ? "1px solid #86efac" : "1px solid #fca5a5",
                                            display: "inline-block",
                                            boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                                          }}
                                          title={isMatch
                                            ? `Matches Total (Net): ${formatGBP(txVal)}`
                                            : `Mismatch: Transaction amount ${formatGBP(txVal)} vs Total (Net) ${formatGBP(totalVal)} (Diff: ${formatGBP(txVal - totalVal)})`
                                          }
                                        >
                                          {formatGBP(txVal)}
                                        </span>
                                      ) : (
                                        <span style={{ color: "#94a3b8", fontSize: "12px" }}>—</span>
                                      )}
                                    </div>
                                  );
                                })()}
                              </React.Fragment>
                            );
                          })}

                          {/* Row 2: Adjustment Label */}
                          <div
                            style={{
                              gridColumn: "1",
                              gridRow: "2",
                              padding: "6px 14px 7px 24px",
                              color: "#64748b",
                              fontStyle: "italic",
                              fontSize: "11px",
                              display: "flex",
                              alignItems: "center",
                              background: "#fafbfc"
                            }}
                          >
                            <span>↳ Adjustment</span>
                          </div>

                          {/* Row 2: Adjustment Month Columns */}
                          {reconData.selectedCols.map((col, cIndex) => {
                            const isTargetCol = col.type === "target";
                            const gridCol = colPositions[cIndex];
                            const adjCell = elem.adjRow?.cells[cIndex];

                            return (
                              <div
                                key={`adj_${col.colIdx}`}
                                style={{
                                  gridColumn: `${gridCol}`,
                                  gridRow: "2",
                                  padding: "5px 10px 6px",
                                  background: isTargetCol ? "#f8fafc" : "#fafbfc",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: isTargetCol ? "space-between" : "flex-end",
                                  gap: "6px"
                                }}
                              >
                                {isTargetCol ? (
                                  <>
                                    <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                                      {renderNoteButton(elem.adjRow, adjCell)}
                                      {isAdmin && (() => {
                                        const isReconUsed = isReconUsedForRow(elem.baseRow);
                                        return (
                                          <button
                                            onClick={() => handleUseReconFigures(elem.baseRow, elem.baseRow.cells[cIndex])}
                                            title={isReconUsed ? "Recon actual figure is currently applied" : `Apply recon actual for ${elem.title}`}
                                            style={{
                                              padding: "2px 7px",
                                              borderRadius: "4px",
                                              border: isReconUsed ? "1px solid #86efac" : "1px solid #bfdbfe",
                                              background: isReconUsed ? "#dcfce7" : "#eff6ff",
                                              color: isReconUsed ? "#166534" : "#1d4ed8",
                                              fontSize: "9px",
                                              fontWeight: "700",
                                              textTransform: "uppercase",
                                              cursor: "pointer",
                                              flexShrink: 0
                                            }}
                                          >
                                            Recon
                                          </button>
                                        );
                                      })()}
                                    </div>

                                    {/* Thin Grey Input Box for Adjustment */}
                                    <span
                                      onClick={() => handleStartEdit(elem.adjRow, adjCell)}
                                      title="Click to edit adjustment"
                                      style={{
                                        display: "inline-block",
                                        minWidth: "80px",
                                        textAlign: "right",
                                        padding: "3px 8px",
                                        background: "#ffffff",
                                        border: "1px solid #cbd5e1",
                                        borderRadius: "4px",
                                        cursor: "pointer",
                                        fontVariantNumeric: "tabular-nums",
                                        fontSize: "11px",
                                        color: "#334155",
                                        fontWeight: "600",
                                        boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                                        whiteSpace: "nowrap",
                                        boxSizing: "border-box"
                                      }}
                                    >
                                      {adjCell?.v || "£0.00"}
                                    </span>
                                  </>
                                ) : (
                                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                                    {renderNoteButton(elem.adjRow, adjCell)}
                                    <span
                                      onClick={() => handleStartEdit(elem.adjRow, adjCell)}
                                      title="Click to edit adjustment"
                                      style={{
                                        display: "inline-block",
                                        minWidth: "80px",
                                        textAlign: "right",
                                        padding: "3px 8px",
                                        background: "#ffffff",
                                        border: "1px solid #cbd5e1",
                                        borderRadius: "4px",
                                        cursor: "pointer",
                                        fontVariantNumeric: "tabular-nums",
                                        fontSize: "11px",
                                        color: "#334155",
                                        fontWeight: "600",
                                        whiteSpace: "nowrap",
                                        boxSizing: "border-box"
                                      }}
                                    >
                                      {adjCell?.v || "£0.00"}
                                    </span>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    }

                    // Single operational card
                    const row = elem.row;
                    return (
                      <div
                        key={elem.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: gridTemplateColumns,
                          alignItems: "center",
                          background: "#ffffff",
                          border: "1px solid #e2e8f0",
                          borderRadius: "10px",
                          boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
                          overflow: "hidden"
                        }}
                      >
                        {/* Spacers before/after Target Month */}
                        {spacerBeforeTarget && (
                          <div
                            style={{
                              gridColumn: `${spacerBeforeTarget}`,
                              background: "#f8fafc",
                              borderLeft: "1px solid #e2e8f0",
                              borderRight: "1px solid #e2e8f0",
                              alignSelf: "stretch"
                            }}
                          />
                        )}
                        {spacerAfterTarget && (
                          <div
                            style={{
                              gridColumn: `${spacerAfterTarget}`,
                              background: "#f8fafc",
                              borderLeft: "1px solid #e2e8f0",
                              borderRight: "1px solid #e2e8f0",
                              alignSelf: "stretch"
                            }}
                          />
                        )}
                        <div style={{ gridColumn: "1", padding: "8px 14px", fontWeight: "600", fontSize: "12px", color: "#1e293b" }}>
                          {elem.title}
                        </div>
                        {row.cells.map((cell, cIndex) => {
                          const isTargetCol = reconData.selectedCols[cIndex]?.type === "target";
                          const gridCol = colPositions[cIndex];
                          if (isTargetCol) {
                            return (
                              <div
                                key={cell.colIdx}
                                style={{
                                  gridColumn: `${gridCol} / ${gridCol + 3}`,
                                  padding: "8px 10px",
                                  textAlign: "right",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "flex-end",
                                  gap: "6px"
                                }}
                              >
                                {renderNoteButton(row, cell)}
                                <span
                                  style={{
                                    display: "inline-block",
                                    minWidth: "80px",
                                    textAlign: "right",
                                    padding: "3px 8px",
                                    border: "1px solid transparent",
                                    boxSizing: "border-box",
                                    fontVariantNumeric: "tabular-nums",
                                    fontSize: "12px",
                                    color: "#334155",
                                    whiteSpace: "nowrap"
                                  }}
                                >
                                  {cell.v || ""}
                                </span>
                              </div>
                            );
                          }
                          return (
                            <div
                              key={cell.colIdx}
                              style={{
                                gridColumn: `${gridCol}`,
                                padding: "8px 10px",
                                textAlign: "right",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "flex-end",
                                gap: "6px"
                              }}
                            >
                              {renderNoteButton(row, cell)}
                              <span
                                style={{
                                  display: "inline-block",
                                  minWidth: "80px",
                                  textAlign: "right",
                                  padding: "3px 8px",
                                  border: "1px solid transparent",
                                  boxSizing: "border-box",
                                  fontVariantNumeric: "tabular-nums",
                                  fontSize: "12px",
                                  color: "#334155",
                                  whiteSpace: "nowrap"
                                }}
                              >
                                {cell.v || ""}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>

                {/* 3. Section Separator for Reconciliation & Cash Balance */}
                {groupedElements.some(e => e.isSummary) && (
                  <>
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      marginTop: "16px",
                      marginBottom: "10px",
                      padding: "0 4px"
                    }}>
                      <div style={{ height: "1px", flex: 1, background: "#e2e8f0" }} />
                      <span style={{ fontSize: "11px", fontWeight: "700", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Reconciliation & Cash Balance
                      </span>
                      <div style={{ height: "1px", flex: 1, background: "#e2e8f0" }} />
                    </div>

                    {/* 4. Summary & Balance Cards */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {groupedElements.filter(e => e.isSummary).map((elem) => {
                        const row = elem.row;
                        const isDiff = elem.isDifference;
                        const isClosing = elem.title.toLowerCase().includes("closing balance");
                        const isOpening = elem.title.toLowerCase().includes("opening balance");
                        const isNet = elem.title.toLowerCase().includes("net cash movement");

                        let cardBg = "#ffffff";
                        let cardBorder = "1px solid #e2e8f0";
                        const targetCell = row.cells.find((_, cIdx) => reconData.selectedCols[cIdx]?.type === "target");
                        const valNum = parseAmount(targetCell?.v);

                        if (isDiff) {
                          if (valNum === 0) {
                            cardBg = "#f0fdf4";
                            cardBorder = "1px solid #86efac";
                          } else {
                            cardBg = "#fef2f2";
                            cardBorder = "1px solid #fca5a5";
                          }
                        } else if (isClosing) {
                          cardBg = "#eff6ff";
                          cardBorder = "1px solid #93c5fd";
                        } else if (isNet) {
                          cardBg = "#f8fafc";
                          cardBorder = "1px solid #cbd5e1";
                        } else if (isOpening) {
                          cardBg = "#fafbfc";
                          cardBorder = "1px solid #e2e8f0";
                        }

                        return (
                          <div
                            key={elem.id}
                            style={{
                              display: "grid",
                              gridTemplateColumns: gridTemplateColumns,
                              alignItems: "center",
                              background: cardBg,
                              border: cardBorder,
                              borderRadius: "10px",
                              boxShadow: "0 1px 2px rgba(15, 23, 42, 0.03)",
                              overflow: "hidden"
                            }}
                          >
                            {/* Spacers before/after Target Month */}
                            {spacerBeforeTarget && (
                              <div
                                style={{
                                  gridColumn: `${spacerBeforeTarget}`,
                                  background: "#f8fafc",
                                  borderLeft: "1px solid #e2e8f0",
                                  borderRight: "1px solid #e2e8f0",
                                  alignSelf: "stretch"
                                }}
                              />
                            )}
                            {spacerAfterTarget && (
                              <div
                                style={{
                                  gridColumn: `${spacerAfterTarget}`,
                                  background: "#f8fafc",
                                  borderLeft: "1px solid #e2e8f0",
                                  borderRight: "1px solid #e2e8f0",
                                  alignSelf: "stretch"
                                }}
                              />
                            )}
                            {/* Title */}
                            <div
                              style={{
                                gridColumn: "1",
                                padding: "9px 14px",
                                fontWeight: elem.isSummary ? "700" : "500",
                                fontSize: "12px",
                                color: isDiff ? (valNum === 0 ? "#166534" : "#991b1b") : (isClosing || isNet ? "#1e40af" : "#1e293b"),
                                display: "flex",
                                alignItems: "center",
                                gap: "8px"
                              }}
                            >
                              <span>{elem.title}</span>
                              {isDiff && valNum === 0 && (
                                <span style={{
                                  fontSize: "9px",
                                  padding: "1px 6px",
                                  background: "#dcfce7",
                                  color: "#166534",
                                  borderRadius: "4px",
                                  fontWeight: "800",
                                  textTransform: "uppercase"
                                }}>
                                  In Balance ✓
                                </span>
                              )}
                            </div>

                            {/* Month Columns */}
                            {row.cells.map((cell, cIndex) => {
                              const isTargetCol = reconData.selectedCols[cIndex]?.type === "target";
                              const gridCol = colPositions[cIndex];
                              const cellValNum = parseAmount(cell.v);

                              if (isTargetCol) {
                                return (
                                  <div
                                    key={cell.colIdx}
                                    style={{
                                      gridColumn: `${gridCol} / ${gridCol + 3}`,
                                      padding: "9px 10px",
                                      textAlign: "right",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "flex-end",
                                      gap: "8px",
                                      fontWeight: elem.isSummary ? "700" : "500",
                                      fontSize: "12px",
                                      color: isDiff ? (cellValNum === 0 ? "#166534" : "#991b1b") : (isClosing || isNet ? "#1e40af" : "#1e293b")
                                    }}
                                  >
                                    {renderNoteButton(row, cell)}
                                    <span
                                      style={{
                                        display: "inline-block",
                                        minWidth: "80px",
                                        textAlign: "right",
                                        padding: "3px 8px",
                                        border: "1px solid transparent",
                                        boxSizing: "border-box",
                                        fontVariantNumeric: "tabular-nums",
                                        whiteSpace: "nowrap"
                                      }}
                                    >
                                      {isDiff && cellValNum === 0 ? "✓ £0.00" : (cell.v || "")}
                                    </span>
                                  </div>
                                );
                              }

                              return (
                                <div
                                  key={cell.colIdx}
                                  style={{
                                    gridColumn: `${gridCol}`,
                                    padding: "9px 10px",
                                    textAlign: "right",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "flex-end",
                                    gap: "6px",
                                    fontWeight: elem.isSummary ? "700" : "500",
                                    fontSize: "12px",
                                    color: isDiff ? (cellValNum === 0 ? "#166534" : "#991b1b") : (isClosing || isNet ? "#1e40af" : "#1e293b")
                                  }}
                                >
                                  {renderNoteButton(row, cell)}
                                  <span
                                    style={{
                                      display: "inline-block",
                                      minWidth: "80px",
                                      textAlign: "right",
                                      padding: "3px 8px",
                                      border: "1px solid transparent",
                                      boxSizing: "border-box",
                                      fontVariantNumeric: "tabular-nums",
                                      whiteSpace: "nowrap"
                                    }}
                                  >
                                    {isDiff && cellValNum === 0 ? "✓ £0.00" : (cell.v || "")}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Adjustment Modal */}
      {editingCell && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          padding: "16px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "20px 24px",
            width: "100%",
            maxWidth: "420px",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)"
          }}>
            <h4 style={{ margin: "0 0 6px", fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
              Edit Adjustment: {editingCell.label}
            </h4>
            <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#64748b" }}>
              Cell: <strong>Cash!{editingCell.colLetter}{editingCell.sheetRow}</strong> • Current: {editingCell.currentValue || "0"}
            </p>

            <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "6px" }}>
              New Value or Formula (e.g. 500, -250, or =26850-C6)
            </label>
            <input
              type="text"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              placeholder="Enter number or formula..."
              autoFocus
              onKeyDown={e => {
                if (e.key === "Enter") handleSaveEdit();
                if (e.key === "Escape") setEditingCell(null);
              }}
              style={{
                width: "100%",
                padding: "8px 12px",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "14px",
                boxSizing: "border-box",
                marginBottom: "16px"
              }}
            />

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setEditingCell(null)}
                disabled={savingEdit}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={savingEdit}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#0284c7",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: savingEdit ? "default" : "pointer"
                }}
              >
                {savingEdit ? "Saving..." : "Save adjustment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overwrite Confirmation Modal for Recon Formula */}
      {overwriteModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          padding: "16px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "20px 24px",
            width: "100%",
            maxWidth: "480px",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.15)"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <span style={{ fontSize: "22px" }}>⚠️</span>
              <h4 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#991b1b" }}>
                Confirm overwrite of existing adjustment
              </h4>
            </div>

            <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#334155", lineHeight: "1.4" }}>
              The target adjustment cell <strong>Cash!{overwriteModal.colLetter}{overwriteModal.targetRow}</strong> ({overwriteModal.adjRowLabel}) currently contains a pre-existing value:
            </p>

            {overwriteModal.currentFormula ? (
              <div style={{ padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", marginBottom: "14px" }}>
                <div style={{ fontSize: "12px", color: "#7f1d1d", marginBottom: "4px" }}>
                  Current formula: <code style={{ background: "#ffffff", padding: "2px 6px", borderRadius: "4px", border: "1px solid #fca5a5", fontSize: "12px", fontWeight: "700", color: "#991b1b" }}>{overwriteModal.currentFormula}</code>
                </div>
                <div style={{ fontSize: "12px", color: "#7f1d1d" }}>
                  Evaluates to: <strong>{overwriteModal.currentValue || "£0.00"}</strong>
                </div>
              </div>
            ) : (
              <div style={{ padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", fontSize: "13px", color: "#991b1b", fontWeight: "600", marginBottom: "14px" }}>
                Current value: {overwriteModal.currentValue || "£0.00"}
              </div>
            )}

            <p style={{ margin: "0 0 14px", fontSize: "13px", color: "#334155" }}>
              Applying this recon figure will overwrite it with formula:
              <br />
              <code style={{ display: "block", marginTop: "4px", padding: "6px 8px", background: "#f1f5f9", borderRadius: "4px", fontSize: "13px", color: "#0f172a" }}>
                {overwriteModal.formula}
              </code>
            </p>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setOverwriteModal(null)}
                disabled={applyingRecon}
                style={{
                  padding: "7px 14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => executeApplyReconFormula(overwriteModal.targetRow, overwriteModal.colLetter, overwriteModal.formula)}
                disabled={applyingRecon}
                style={{
                  padding: "7px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#dc2626",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: applyingRecon ? "default" : "pointer"
                }}
              >
                {applyingRecon ? "Applying..." : "Overwrite & apply formula"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Match Actuals Confirmation Modal */}
      {showMatchConfirm && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          padding: "16px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "24px",
            width: "100%",
            maxWidth: "500px",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.15)"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
              <span style={{ fontSize: "24px" }}>⚡</span>
              <h4 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#0f172a" }}>
                Match all actuals for {reconData?.targetMonthLabel || "target month"}
              </h4>
            </div>

            <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#334155", lineHeight: "1.5" }}>
              This action will automatically apply the reconciliation actual formulas to all adjustment rows and mark all cashflow lines as <strong>resolved</strong> for <strong>{reconData?.targetMonthLabel || "target month"}</strong> ({targetCol?.colLetter}):
            </p>

            <div style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "12px 14px",
              marginBottom: "16px",
              fontSize: "12px",
              color: "#334155"
            }}>
              <ul style={{ margin: 0, paddingLeft: "18px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px" }}>
                <li>Confirmed cash incoming (to Incoming cash adj)</li>
                <li>Salaries outgoing</li>
                <li>Dividends as salary</li>
                <li>Contractors</li>
                <li>Direct costs</li>
                <li>Other expenses</li>
                <li>Corporation tax</li>
                <li>VAT</li>
                <li>Non-operating income</li>
                <li>Non-operating expenses</li>
              </ul>
            </div>

            <p style={{ margin: "0 0 18px", fontSize: "12px", color: "#64748b", fontStyle: "italic" }}>
              Any pre-existing adjustment formulas or manual overrides for this month will be updated with the calculated variance formulas.
            </p>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setShowMatchConfirm(false)}
                disabled={matchingActuals}
                style={{
                  padding: "7px 14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                onClick={executeMatchAllActuals}
                disabled={matchingActuals}
                style={{
                  padding: "7px 18px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#15803d",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: matchingActuals ? "default" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                {matchingActuals ? <Spinner size={14} /> : "⚡"}
                {matchingActuals ? "Applying actuals..." : "Match all actuals"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Note Edit Modal */}
      {noteModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          padding: "16px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "20px 24px",
            width: "100%",
            maxWidth: "420px",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)"
          }}>
            <h4 style={{ margin: "0 0 6px", fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
              Edit cell note: {noteModal.label}
            </h4>
            <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#64748b" }}>
              Cell: <strong>Cash!{noteModal.colLetter}{noteModal.sheetRow}</strong>
            </p>

            <div style={{ marginBottom: "14px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                General notes <span style={{ fontWeight: "400", color: "#64748b", fontSize: "11px" }}>(internal only, not shown in Pulse)</span>
              </label>
              <textarea
                value={generalNoteDraft}
                onChange={e => setGeneralNoteDraft(e.target.value)}
                placeholder="Enter internal notes, audit memos, or reconciliation comments..."
                rows={3}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "13px",
                  boxSizing: "border-box",
                  fontFamily: "inherit"
                }}
              />
            </div>

            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#0047AB", marginBottom: "4px" }}>
                Note that will describe adjustment in Pulse cashflow table <span style={{ fontWeight: "400", color: "#64748b", fontSize: "11px" }}>(client-facing)</span>
              </label>
              <textarea
                value={pulseNoteDraft}
                onChange={e => setPulseNoteDraft(e.target.value)}
                placeholder="e.g. Partial payment of invoice 1045 made in September, remainder to be paid in October"
                rows={3}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #93c5fd",
                  borderRadius: "6px",
                  fontSize: "13px",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                  background: "#f0f7ff"
                }}
              />
              <p style={{ margin: "4px 0 0", fontSize: "11px", color: "#64748b" }}>
                💡 Saved with <code>[Note: ...]</code> wrapper for display in Pulse popovers and monthly breakdown pages.
              </p>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setNoteModal(null)}
                disabled={savingNote}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveNote}
                disabled={savingNote}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#0284c7",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: savingNote ? "default" : "pointer"
                }}
              >
                {savingNote ? "Saving..." : "Save note"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
