import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Spinner from "./Spinner";
import { useAuth } from "../hooks/useAuth";

const DARK_GREEN = "#14532d";
const RESOLVED_GREEN = "#d9ead3";

export default function CashflowReconTab({
  allOutgoingsClients = [],
  eomMonthKey = "",
  automationCommanderSheetId = "",
  initialClient = "",
  onClearInitialClient,
  onTaskMarkedDone,
  eomAllTasks = [],
  eomStatusOverrides = [],
  styles = {}
}) {
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;

  const [selectedClient, setSelectedClient] = useState(initialClient || "");
  const [reconData, setReconData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // Month navigation (allows shifting target month delta from default)
  const [monthDelta, setMonthDelta] = useState(0);

  // In-place editing state for adjustment cells
  const [editingCell, setEditingCell] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Overwrite confirmation modal for "Use recon figures"
  const [overwriteModal, setOverwriteModal] = useState(null);
  const [applyingRecon, setApplyingRecon] = useState(false);

  // Track rows where recon has been applied during this session
  const [reconAppliedRows, setReconAppliedRows] = useState(new Set());

  // Note editor modal
  const [noteModal, setNoteModal] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  // Auto-restore or sync client
  useEffect(() => {
    if (initialClient && initialClient !== selectedClient) {
      setSelectedClient(initialClient);
      if (onClearInitialClient) onClearInitialClient();
    } else if (!selectedClient && allOutgoingsClients && allOutgoingsClients.length > 0) {
      const saved = sessionStorage.getItem("pma_cashflow_recon_client");
      const found = saved ? allOutgoingsClients.find(c => c.clientName === saved) : null;
      if (found) {
        setSelectedClient(found.clientName);
      }
    }
  }, [initialClient, onClearInitialClient, selectedClient, allOutgoingsClients]);

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
    if (typeof raw === "string" && raw.startsWith("=")) {
      let reconVal = 0;
      if (row.mappedItemType === "confirmed_cash") reconVal = reconData.reconActuals.revenue;
      else if (row.mappedItemType === "salaries") reconVal = reconData.reconActuals.salaries;
      else if (row.mappedItemType === "dividends") reconVal = reconData.reconActuals.dividends;
      else if (row.mappedItemType === "contractors") reconVal = reconData.reconActuals.contractors;
      else if (row.mappedItemType === "direct_costs") reconVal = reconData.reconActuals.directCosts;
      else if (row.mappedItemType === "other_expenses") reconVal = reconData.reconActuals.outgoings;

      const reconFixed = reconVal !== undefined ? reconVal.toFixed(2) : "";
      if (reconFixed && raw.includes(reconFixed)) {
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
    setEditValue(cell.rawVal !== null && cell.rawVal !== undefined ? String(cell.rawVal) : (cell.v || ""));
  };

  // Save Adjustment Edit
  const handleSaveEdit = async () => {
    if (!editingCell || !currentClientInfo) return;
    setSavingEdit(true);
    setError("");
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cash_adjustment",
          clientSheetId: currentClientInfo.clientSheetId,
          colLetter: editingCell.colLetter,
          sheetRow: editingCell.sheetRow,
          value: editValue,
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
      if (reconData?.reconError) {
        alert(`Cannot apply recon figures:\n${reconData.reconError}`);
      } else {
        alert("No recon actuals available for this month.");
      }
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
      targetAdjustmentRow = 29; // Other cash movements
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "salaries") {
      reconVal = recon.salaries || 0;
      targetAdjustmentRow = 9; // Salaries adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "dividends") {
      reconVal = recon.dividends || 0;
      targetAdjustmentRow = 11; // Dividends as salary adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "contractors") {
      reconVal = recon.contractors || 0;
      targetAdjustmentRow = 13; // Contractors adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "direct_costs") {
      reconVal = recon.directCosts || 0;
      targetAdjustmentRow = 15; // Direct costs adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "other_expenses") {
      reconVal = recon.outgoings || 0;
      targetAdjustmentRow = 17; // Other expenses adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else {
      return;
    }

    // Find destination adjustment row in table data
    const adjRowObj = reconData.rows.find(r => r.sheetRow === targetAdjustmentRow);
    const adjCell = adjRowObj?.cells.find(c => c.colIdx === targetMonthCell.colIdx);
    const currentVal = adjCell?.v ?? "";
    const rawVal = adjCell?.rawVal ?? "";
    const currentFormula = (typeof rawVal === "string" && rawVal.startsWith("=")) ? rawVal : "";

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

  const executeApplyReconFormula = async (targetRow, colLetter, formula) => {
    if (!currentClientInfo) return;
    setApplyingRecon(true);
    setError("");
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cash_adjustment",
          clientSheetId: currentClientInfo.clientSheetId,
          colLetter,
          sheetRow: targetRow,
          value: formula,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to apply recon formula");
      setReconAppliedRows(prev => new Set([...prev, targetRow]));
      setOverwriteModal(null);
      setSuccessMsg(`Applied formula ${formula} to Cash!${colLetter}${targetRow}`);
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
    setNoteModal({
      sheetRow: row.sheetRow,
      colIdx: cell.colIdx,
      colLetter: cell.colLetter,
      label: row.label,
      currentNote: cell.note || ""
    });
    setNoteDraft(cell.note || "");
  };

  const handleSaveNote = async () => {
    if (!noteModal || !currentClientInfo || !reconData) return;
    setSavingNote(true);
    setError("");
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
          note: noteDraft,
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
            return { ...c, note: noteDraft };
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

  return (
    <div style={{ maxWidth: "1150px" }}>
      {/* Top Header Card */}
      <div style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        padding: "18px 22px",
        marginBottom: "18px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px" }}>
          <div style={{ flex: "1 1 340px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0f172a" }}>
                Cashflow Recon
              </h3>
              {reconData?.targetMonthLabel && (
                <span style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "2px 8px",
                  borderRadius: "12px",
                  background: "#dcfce7",
                  color: "#166534",
                  border: "1px solid #bbf7d0"
                }}>
                  Target: {reconData.targetMonthLabel}
                </span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: "13px", color: "#64748b", lineHeight: "1.4" }}>
              Reconcile rolling cashflow forecast against actuals from bank reconciliation. Review 3 rolling months, adjust variance rows, and mark items resolved.
            </p>
          </div>

          {/* Client Selector Dropdown */}
          <div style={{ minWidth: "260px", flex: "0 1 320px" }}>
            <label style={{ display: "block", fontSize: "11px", fontWeight: "700", textTransform: "uppercase", color: "#64748b", marginBottom: "6px", letterSpacing: "0.5px" }}>
              Select Client
            </label>
            <select
              value={selectedClient}
              onChange={e => setSelectedClient(e.target.value)}
              style={{
                width: "100%",
                padding: "9px 12px",
                border: "1px solid #cbd5e1",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: "600",
                color: "#1e293b",
                background: "#f8fafc",
                outline: "none",
                cursor: "pointer"
              }}
            >
              <option value="">Choose a client...</option>
              {allOutgoingsClients.map(c => (
                <option key={c.clientName} value={c.clientName}>
                  {c.clientName}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Selected Client Toolbar & Month Controls */}
        {selectedClient && (
          <div style={{
            marginTop: "16px",
            paddingTop: "14px",
            borderTop: "1px solid #f1f5f9",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <div style={{
                fontSize: "12px",
                background: "#f1f5f9",
                color: "#334155",
                padding: "4px 10px",
                borderRadius: "6px",
                fontWeight: "600"
              }}>
                Client: {selectedClient}
              </div>

              {/* Only show spreadsheet links to Admins */}
              {isAdmin && currentClientInfo?.clientSheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${currentClientInfo.clientSheetId}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "12px", color: "#0284c7", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px" }}
                >
                  📊 Client Sheet ↗
                </a>
              )}

              {isAdmin && currentClientInfo?.reconSheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${currentClientInfo.reconSheetId}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "12px", color: "#0284c7", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px" }}
                >
                  📑 Recon Sheet ↗
                </a>
              )}

              {linkedTask && onTaskMarkedDone && (
                <button
                  onClick={() => onTaskMarkedDone(selectedClient, linkedTask.taskId)}
                  style={{
                    padding: "4px 10px",
                    background: isLinkedTaskDone ? "#f0fdf4" : "#ecfdf5",
                    border: isLinkedTaskDone ? "1px solid #86efac" : "1px solid #a7f3d0",
                    color: isLinkedTaskDone ? "#166534" : "#059669",
                    borderRadius: "6px",
                    fontSize: "11px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  {isLinkedTaskDone ? "✓ Month marked as complete" : "Mark month as complete"}
                </button>
              )}
            </div>

            {/* Month Switcher and Refresh */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "2px" }}>
                <button
                  onClick={() => setMonthDelta(d => d - 1)}
                  title="Previous month"
                  style={{ padding: "4px 8px", background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "#64748b" }}
                >
                  ◀
                </button>
                <span style={{ fontSize: "12px", fontWeight: "600", padding: "0 6px", color: "#334155" }}>
                  {reconData?.targetMonthLabel || "Target Month"}
                </span>
                <button
                  onClick={() => setMonthDelta(d => d + 1)}
                  title="Next month"
                  style={{ padding: "4px 8px", background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "#64748b" }}
                >
                  ▶
                </button>
              </div>

              {monthDelta !== 0 && (
                <button
                  onClick={() => setMonthDelta(0)}
                  style={{ fontSize: "11px", color: "#0284c7", background: "none", border: "none", cursor: "pointer" }}
                >
                  Reset
                </button>
              )}

              <button
                onClick={() => loadData(selectedClient)}
                disabled={loading}
                style={{
                  padding: "5px 12px",
                  fontSize: "12px",
                  fontWeight: "600",
                  background: "#0284c7",
                  border: "none",
                  borderRadius: "6px",
                  color: "#ffffff",
                  cursor: loading ? "default" : "pointer"
                }}
              >
                {loading ? "Refreshing..." : "↻ Refresh Live Data"}
              </button>
            </div>
          </div>
        )}
      </div>

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

      {/* Recon Sheet Status Notice (Non-blocking warning) */}
      {reconData?.reconError && (
        <div style={{ padding: "10px 14px", background: "#fffbeb", border: "1px solid #fef3c7", borderRadius: "8px", color: "#92400e", fontSize: "12px", marginBottom: "14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>ℹ️ <strong>Recon Actuals Notice:</strong> {reconData.reconError}</span>
          <span style={{ fontSize: "11px", color: "#b45309" }}>Manual adjustments and cell marking still enabled</span>
        </div>
      )}

      {/* Main Table Content */}
      {!selectedClient ? (
        <div style={{ textAlign: "center", padding: "60px 20px", background: "#f8fafc", borderRadius: "12px", border: "1px dashed #cbd5e1" }}>
          <p style={{ fontSize: "15px", color: "#64748b", margin: "0 0 6px", fontWeight: "600" }}>No Client Selected</p>
          <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>Please select a client from the dropdown above to load their Cashflow Reconciliation table.</p>
        </div>
      ) : loading && !reconData ? (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <Spinner />
          <p style={{ fontSize: "13px", color: "#64748b", marginTop: "12px" }}>Loading Cashflow sheet data and recon actuals...</p>
        </div>
      ) : !reconData ? null : (
        <div style={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "10px", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          {/* Subheader info bar (Clean legend without verbose text) */}
          <div style={{ padding: "8px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
            <div style={{ display: "flex", gap: "12px", fontSize: "11px", color: "#64748b" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "12px", height: "12px", background: RESOLVED_GREEN, border: "1px solid #86efac", borderRadius: "2px", display: "inline-block" }}></span>
                Resolved Actual
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "12px", height: "12px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "2px", display: "inline-block" }}></span>
                Editable Adjustment
              </span>
            </div>
          </div>

          {/* Spreadsheet Table */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px" }}>
              <thead>
                <tr style={{ background: DARK_GREEN, color: "#ffffff" }}>
                  <th style={{
                    padding: "8px 12px",
                    textAlign: "left",
                    fontWeight: "700",
                    width: "260px",
                    minWidth: "240px",
                    borderRight: "1px solid rgba(255,255,255,0.15)",
                    borderBottom: "2px solid #0b381e"
                  }}>
                    Cash Movements
                  </th>
                  {reconData.selectedCols.map(col => {
                    const isTarget = col.type === "target";
                    return (
                      <th
                        key={col.colIdx}
                        style={{
                          padding: "8px 12px",
                          textAlign: "right",
                          fontWeight: "700",
                          minWidth: isTarget ? "280px" : "140px",
                          width: isTarget ? "320px" : "160px",
                          background: isTarget ? "#15803d" : DARK_GREEN,
                          borderRight: "1px solid rgba(255,255,255,0.15)",
                          borderBottom: "2px solid #0b381e",
                          position: "relative"
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px" }}>
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
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {reconData.rows.filter(row => !row.isHeaderRow).map((row, rIndex) => {
                  const isSectionHeader = row.label && row.cells.every(c => !c.v);
                  const isDifference = row.isDifferenceRow;
                  const isClosing = row.label.toLowerCase().includes("closing balance");

                  let trBg = undefined;
                  if (isSectionHeader) trBg = "#f8fafc";
                  else if (isDifference) trBg = "#fef2f2";
                  else if (isClosing) trBg = "#eff6ff";

                  return (
                    <tr
                      key={row.sheetRow}
                      style={{
                        background: trBg,
                        borderBottom: isDifference ? "2px solid #ef4444" : "1px solid #f1f5f9"
                      }}
                    >
                      {/* Row Label */}
                      <td style={{
                        padding: "6px 12px",
                        fontWeight: row.isHeaderRow || isSectionHeader || isDifference || isClosing ? "700" : (row.isAdjustmentRow ? "400" : "500"),
                        fontSize: row.isAdjustmentRow ? "11px" : "12px",
                        fontStyle: row.isAdjustmentRow ? "italic" : "normal",
                        color: isDifference ? "#991b1b" : isClosing ? "#1e40af" : (row.isAdjustmentRow ? "#475569" : "#1e293b"),
                        borderRight: "1px solid #e2e8f0",
                        whiteSpace: "nowrap"
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>{row.label || " "}</span>
                          {row.isAdjustmentRow && (
                            <span style={{ fontSize: "9px", padding: "1px 4px", background: "#f1f5f9", borderRadius: "3px", color: "#64748b", fontStyle: "normal" }}>
                              adj
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Month Columns */}
                      {row.cells.map((cell, cIndex) => {
                        const isTargetCol = reconData.selectedCols[cIndex]?.type === "target";
                        const isAdjustment = row.isAdjustmentRow;
                        const hasNote = !!cell.note;
                        const isMappedNonAdj = !isAdjustment && row.mappedItemType && isTargetCol;

                        // Shading: resolved cell background or standard background
                        let cellBg = cell.bg;
                        if (cell.isResolved) cellBg = RESOLVED_GREEN;
                        else if (isAdjustment) cellBg = "#fafbfc";

                        return (
                          <td
                            key={cell.colIdx}
                            style={{
                              padding: "5px 10px",
                              textAlign: "right",
                              background: cellBg,
                              borderRight: "1px solid #e2e8f0",
                              minWidth: isTargetCol ? "280px" : "140px",
                              width: isTargetCol ? "320px" : "160px",
                              fontWeight: cell.b || isDifference || isClosing ? "700" : "400",
                              fontSize: isAdjustment ? "11px" : "12px",
                              fontStyle: isAdjustment ? "italic" : "normal",
                              color: isDifference ? "#991b1b" : cell.c || "#1e293b",
                              position: "relative",
                              verticalAlign: "middle"
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
                              {/* Left slot: Cell actions (Mark resolved, Use recon, Note) */}
                              <div style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
                                {/* Note icon / trigger */}
                                <button
                                  onClick={() => handleOpenNote(row, cell)}
                                  title={hasNote ? `Note: ${cell.note}` : "Add cell note"}
                                  style={{
                                    background: "none",
                                    border: "none",
                                    cursor: "pointer",
                                    padding: "1px 2px",
                                    fontSize: "11px",
                                    color: hasNote ? "#d97706" : "#cbd5e1",
                                    lineHeight: 1
                                  }}
                                >
                                  {hasNote ? "📝" : "▫️"}
                                </button>

                                {/* Target Month Non-Adjustment Actions */}
                                {isMappedNonAdj && (
                                  <div style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
                                    {/* Mark resolved toggle (smaller, no emoji) */}
                                    <button
                                      onClick={() => handleToggleResolved(cell)}
                                      title={cell.isResolved ? "Un-mark resolved" : "Mark resolved (shades green)"}
                                      style={{
                                        padding: "1px 5px",
                                        borderRadius: "3px",
                                        border: cell.isResolved ? "1px solid #86efac" : "1px solid #cbd5e1",
                                        background: cell.isResolved ? "#dcfce7" : "#ffffff",
                                        color: cell.isResolved ? "#166534" : "#475569",
                                        fontSize: "9px",
                                        fontWeight: "700",
                                        textTransform: "uppercase",
                                        letterSpacing: "0.3px",
                                        cursor: "pointer"
                                      }}
                                    >
                                      {cell.isResolved ? "Resolved" : "Resolve"}
                                    </button>

                                    {/* Use recon figures (Admin Only, smaller, changes to green when used) */}
                                    {isAdmin && (() => {
                                      const isReconUsed = isReconUsedForRow(row);
                                      return (
                                        <button
                                          onClick={() => handleUseReconFigures(row, cell)}
                                          title={isReconUsed ? "Recon actual figure is currently applied" : `Apply recon actual to adjustment row for ${row.label}`}
                                          style={{
                                            padding: "1px 5px",
                                            borderRadius: "3px",
                                            border: isReconUsed ? "1px solid #86efac" : "1px solid #bfdbfe",
                                            background: isReconUsed ? "#dcfce7" : "#eff6ff",
                                            color: isReconUsed ? "#166534" : "#1d4ed8",
                                            fontSize: "9px",
                                            fontWeight: "700",
                                            textTransform: "uppercase",
                                            letterSpacing: "0.3px",
                                            cursor: "pointer"
                                          }}
                                        >
                                          Recon
                                        </button>
                                      );
                                    })()}
                                  </div>
                                )}
                              </div>

                              {/* Right slot: Value & Edit trigger */}
                              <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                {isAdjustment && (
                                  <button
                                    onClick={() => handleStartEdit(row, cell)}
                                    title="Edit adjustment value/formula"
                                    style={{
                                      background: "none",
                                      border: "none",
                                      color: "#94a3b8",
                                      cursor: "pointer",
                                      padding: "1px 3px",
                                      fontSize: "11px",
                                      borderRadius: "3px"
                                    }}
                                  >
                                    ✏️
                                  </button>
                                )}

                                <span style={{
                                  fontSize: isAdjustment ? "11px" : "12px",
                                  fontStyle: isAdjustment ? "italic" : "normal",
                                  fontVariantNumeric: "tabular-nums"
                                }}>
                                  {cell.v || ""}
                                </span>
                              </div>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
                {savingEdit ? "Saving..." : "Save Adjustment"}
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
                Confirm Overwrite Existing Adjustment
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
                {applyingRecon ? "Applying..." : "Overwrite & Apply Formula"}
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
              Edit Cell Note: {noteModal.label}
            </h4>
            <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#64748b" }}>
              Cell: <strong>Cash!{noteModal.colLetter}{noteModal.sheetRow}</strong>
            </p>

            <textarea
              value={noteDraft}
              onChange={e => setNoteDraft(e.target.value)}
              placeholder="Enter note text (leave blank to remove)..."
              rows={4}
              style={{
                width: "100%",
                padding: "8px 12px",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                boxSizing: "border-box",
                marginBottom: "16px",
                fontFamily: "inherit"
              }}
            />

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
                {savingNote ? "Saving..." : "Save Note"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
